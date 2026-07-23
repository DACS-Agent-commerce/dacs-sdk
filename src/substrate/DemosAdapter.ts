import { Demos } from "@kynesyslabs/demosdk/websdk";
import { StorageProgram } from "@kynesyslabs/demosdk/storage";
import { Identities } from "@kynesyslabs/demosdk/abstraction";
import { createHash } from "node:crypto";

import { SubstrateError } from "../errors.js";
import { canonicalize } from "../canonical/index.js";
import { parseClaimRef } from "../identity/index.js";
import type {
  AnchorRef,
  AnchorOptions,
  ProxyFetchRequest,
  ProxyFetchResult,
  ResolvedIdentity,
  SubstrateAdapter,
} from "./SubstrateAdapter.js";

// Fixed address-derivation inputs so a logical name always resolves to the same
// storage address (any reader can re-derive it from the writer address + name).
const ANCHOR_NONCE = 0;
const ANCHOR_SALT = "dacs:v1";

interface SignedDemosTransaction {
  content: Record<string, unknown>;
  hash?: string;
  signature?: { type: string; data: string } | null;
  ed25519_signature?: string;
}

interface DemosTransactionSigner {
  algorithm: string;
  crypto: {
    sign(
      algorithm: string,
      bytes: Uint8Array,
    ): Promise<{ signature: Uint8Array }>;
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface ConfirmationRetryOptions {
  attempts?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
}

/**
 * Bound the node's pre-broadcast confirmTx RPC. A timed-out confirmation has
 * not mutated chain state, so callers can freshly sign the same payload with
 * the same reserved nonce and safely retry another validator response.
 */
export async function confirmWithRetry<T>(
  confirm: (attempt: number) => Promise<T>,
  options: ConfirmationRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 12_000;
  const retryDelayMs = options.retryDelayMs ?? 300;
  if (!Number.isInteger(attempts) || attempts < 1 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("invalid confirmation retry options");
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        confirm(attempt),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`confirmTx timed out after ${timeoutMs}ms (attempt ${attempt}/${attempts})`)),
            timeoutMs,
          );
        }),
      ]);
    } catch (error) {
      lastError = error;
      if (attempt < attempts && retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("confirmTx failed without an error");
}

/**
 * Repair demosdk <=4.0.16's single-byte string hash at the final wire boundary.
 * ASCII transactions are unaffected. Non-ASCII transaction content is hashed
 * again as UTF-8 and signed over the exact public wire shape the node validates.
 */
export async function ensureUtf8TransactionHash<T extends SignedDemosTransaction>(
  transaction: T,
  signer: DemosTransactionSigner,
): Promise<T> {
  const hash = createHash("sha256")
    .update(JSON.stringify(transaction.content), "utf8")
    .digest("hex");
  if (hash === transaction.hash) return transaction;

  transaction.hash = hash;
  const bytes = new TextEncoder().encode(hash);
  const signature = await signer.crypto.sign(signer.algorithm, bytes);
  transaction.signature = {
    type: signer.algorithm,
    data: bytesToHex(signature.signature),
  };
  if (transaction.ed25519_signature !== undefined) {
    const ed25519 = await signer.crypto.sign("ed25519", bytes);
    transaction.ed25519_signature = bytesToHex(ed25519.signature);
  }
  return transaction;
}

export interface DemosAdapterConfig {
  /** Demos node RPC URL (e.g. https://node2.demos.sh). */
  rpc: string;
  /** Wallet secret — mnemonic or private key. Optional for read-only use. */
  secret?: string;
}

/**
 * The one concrete SubstrateAdapter, wrapping `@kynesyslabs/demosdk`.
 *
 * T1 scaffold status: `connect` / `getAddress` are wired to the real SDK so the
 * package provably reaches a Demos RPC. The substrate operations (`anchor`,
 * `readAnchor`, `proxyFetch`, `resolveIdentity`, `sign`) are defined by the seam
 * but land in later tasks — see the per-method task refs.
 */
export class DemosAdapter implements SubstrateAdapter {
  private readonly demos: Demos;
  private readonly config: DemosAdapterConfig;
  private connected = false;

  constructor(config: DemosAdapterConfig) {
    if (!config?.rpc) {
      throw new Error("DemosAdapter requires an rpc URL");
    }
    this.config = config;
    this.demos = new Demos();
  }

  /** Underlying demosdk instance — escape hatch while the seam fills out. */
  get raw(): Demos {
    return this.demos;
  }

  async connect(): Promise<void> {
    await this.demos.connect(this.config.rpc);
    if (this.config.secret) {
      await this.demos.connectWallet(this.config.secret);
      // Seed demosdk's wallet-local sequential nonce allocator. Concurrent
      // same-wallet transactions then reserve N+1, N+2, ... without waiting
      // for the confirmed nonce projection to catch up.
      this.demos.enableAutoNonce();
    }
    this.connected = true;
  }

  getAddress(): string {
    if (!this.connected) {
      throw new Error("DemosAdapter not connected — call connect() first");
    }
    return this.demos.getAddress();
  }

  async sign(bytes: Uint8Array): Promise<Uint8Array> {
    if (!this.connected) {
      throw new Error("DemosAdapter not connected — call connect() first");
    }
    const result = await (this.demos as any).crypto.sign(
      (this.demos as any).algorithm,
      bytes,
    );
    return result.signature as Uint8Array;
  }

  async getPublicKey(): Promise<Uint8Array> {
    const { publicKey } = await (this.demos as any).crypto.getIdentity("ed25519");
    return publicKey as Uint8Array;
  }

  /**
   * SR-2 anchoring via Demos Storage Programs. A logical name maps to one
   * storage program at a deterministic address (`deriveStorageAddress` of the
   * writer + name + fixed nonce/salt), so the same name re-resolves to the same
   * address and re-anchoring updates it in place. First write creates the
   * program (public-read ACL); later writes update it. (Mirrors the
   * agent-commerce-demo's proven create-or-write + sign→confirm→broadcast flow.)
   */
  /** The deterministic storage address a name anchors to (no write) — for resume. */
  anchorAddress(name: string): string {
    if (!this.connected) {
      throw new Error("DemosAdapter not connected — call connect() first");
    }
    return StorageProgram.deriveStorageAddress(
      this.demos.getAddress(),
      name,
      ANCHOR_NONCE,
      ANCHOR_SALT,
    );
  }

  async anchor(name: string, value: object, options: AnchorOptions = {}): Promise<AnchorRef> {
    const data = value as Record<string, unknown>;
    if (!this.connected) {
      throw new Error("DemosAdapter not connected — call connect() first");
    }
    const address = this.anchorAddress(name);

    // Per-job deterministic slots are known-new by construction. Avoid making
    // their first write wait for the eventually-consistent storage projection.
    let exists = false;
    if (options.writeMode !== "known-new") {
      try {
        const probe = (await this.demos.storagePrograms.read(address)) as {
          success?: boolean;
          data?: unknown;
        };
        exists = probe?.success === true && probe.data != null;
      } catch {
        exists = false;
      }
    }

    let payload = exists
      ? StorageProgram.writeStorage(address, data, "json")
      : StorageProgram.createStorageProgram(
          this.demos.getAddress(),
          name,
          data,
          "json",
          StorageProgram.publicACL(),
          { nonce: ANCHOR_NONCE, salt: ANCHOR_SALT },
        );

    let signed: SignedDemosTransaction | undefined;
    let reservedNonce: number | undefined = options.nonce;
    type BroadcastResult = {
      result?: number;
      response?: { hash?: string; message?: string };
      extra?: { confirmationBlock?: number } | unknown;
    };
    const signAndBroadcast = async (): Promise<BroadcastResult> => {
      const validity = await confirmWithRetry(async () => {
        const candidate = await ensureUtf8TransactionHash(
          await this.demos.storagePrograms.sign(
            payload,
            reservedNonce === undefined ? undefined : { nonce: reservedNonce },
          ) as SignedDemosTransaction,
          this.demos as unknown as DemosTransactionSigner,
        );
        const candidateNonce = candidate.content.nonce;
        if (!Number.isSafeInteger(candidateNonce)) {
          throw new Error("storage transaction omitted its sequential nonce");
        }
        if (reservedNonce !== undefined && Number(candidateNonce) !== reservedNonce) {
          throw new Error("confirmation retry changed the reserved transaction nonce");
        }
        reservedNonce = Number(candidateNonce);
        signed = candidate;
        return this.demos.tx.confirm(candidate, this.demos);
      });
      if (!signed) throw new Error("anchor confirmation returned without a signed transaction");
      return this.demos.tx.broadcast(validity, this.demos) as Promise<BroadcastResult>;
    };

    let broadcast = await signAndBroadcast();
    if (broadcast?.result !== 200 && options.writeMode === "known-new" && !exists) {
      // On recovery, only turn a rejected create into an idempotent write when
      // the existing public value is provably the same canonical value.
      const probe = await this.demos.storagePrograms.read(address).catch(() => null) as {
        success?: boolean;
        data?: unknown;
      } | null;
      if (probe?.success === true && probe.data != null && canonicalize(probe.data) === canonicalize(data)) {
        payload = StorageProgram.writeStorage(address, data, "json");
        signed = undefined;
        broadcast = await signAndBroadcast();
      }
    }
    if (broadcast?.result !== 200) {
      // The node rejected the anchor tx — a substrate-side fault, blameless to
      // the counterparty (T9: substrate fault ≠ party fault).
      throw new SubstrateError(
        `anchor failed for ${address}: ${
          typeof broadcast?.extra === "string"
            ? broadcast.extra
            : JSON.stringify(broadcast?.extra ?? broadcast?.response)
        }`,
      );
    }
    if (!signed) throw new Error("anchor broadcast returned without a signed transaction");

    const expectedConfirmationBlock = typeof broadcast.extra === "object"
      && broadcast.extra !== null
      && Number.isSafeInteger((broadcast.extra as { confirmationBlock?: number }).confirmationBlock)
      ? Number((broadcast.extra as { confirmationBlock?: number }).confirmationBlock)
      : undefined;
    const broadcastAt = Date.now();
    const nonce = Number.isSafeInteger(signed.content.nonce)
      ? Number(signed.content.nonce)
      : undefined;
    return {
      address,
      txRef: broadcast.response?.hash ?? signed.hash,
      broadcastAt,
      transactionContent: JSON.parse(JSON.stringify(signed.content)) as Record<string, unknown>,
      ...(nonce === undefined ? {} : { nonce }),
      ...(expectedConfirmationBlock === undefined ? {} : { expectedConfirmationBlock }),
    };
  }

  async readAnchor(address: string): Promise<Record<string, unknown> | null> {
    try {
      const res = (await this.demos.storagePrograms.read(address)) as {
        success?: boolean;
        data?: Record<string, unknown> | null;
      };
      return res?.success && res.data != null ? res.data : null;
    } catch {
      // Storage Programs read throws on 404 (not yet anchored).
      return null;
    }
  }

  /**
   * SR-3 — consensus-backed proxy fetch via DAHR. Validators perform the HTTPS
   * fetch and co-sign an anchoring tx over (url, time, body hash); the body is
   * returned inline and `anchorTxRef` is the on-chain commitment.
   */
  async proxyFetch(req: ProxyFetchRequest): Promise<ProxyFetchResult> {
    if (!this.connected) {
      throw new Error("DemosAdapter not connected — call connect() first");
    }
    const dahr = await (this.demos as any).web2.createDahr();
    try {
      const result = await dahr.startProxy({
        url: req.url,
        method: req.method ?? "GET",
        options: { headers: req.headers ?? {} },
      });
      return {
        body: String(result?.body ?? result?.data ?? ""),
        status: Number(result?.status ?? 0),
        responseHash: String(result?.responseHash ?? ""),
        anchorTxRef: result?.txHash,
        fetchedAt: Number(result?.timestamp ?? Date.now()),
      };
    } finally {
      if (typeof dahr?.stopProxy === "function") {
        await dahr.stopProxy().catch(() => {});
      }
    }
  }

  /**
   * SR-1 — resolve a claim reference through CCI (the GCR identity routine).
   * Resolves by address: a ref that is (or contains) an address returns its
   * identity graph (keyed `xm` / `web2` / `ud` / `pqc`; parseCciRecord reads it).
   * Requires demosdk ≥ 4.0.12 — 4.0.6's auth-header path 401s against the public
   * nodes on gcr_routine (issue #20). Reverse claim-ref resolution is
   * findSubjectsByClaim below.
   */
  async resolveIdentity(ref: string): Promise<ResolvedIdentity> {
    if (!this.connected) {
      throw new Error("DemosAdapter not connected — call connect() first");
    }
    const raw = await new Identities().getIdentities(
      this.demos,
      "getIdentities",
      ref,
    );
    return { ref, boundTo: ref, raw };
  }

  /**
   * SR-1 (reverse) — resolve a linked claim ref back to the subject pubkeys that
   * hold it, via demosdk's GCR reverse lookups (`getDemosIdsBy{Web2,Web3}Identity`).
   */
  async findSubjectsByClaim(claimRef: string): Promise<string[]> {
    if (!this.connected) {
      throw new Error("DemosAdapter not connected — call connect() first");
    }
    const parsed = parseClaimRef(claimRef);
    if (!parsed) {
      throw new Error(
        `findSubjectsByClaim: "${claimRef}" is not a reverse-resolvable linked-claim ref`,
      );
    }
    const identities = new Identities();
    const accounts =
      parsed.kind === "web2"
        ? await identities.getDemosIdsByWeb2Identity(
            this.demos,
            parsed.platform as "twitter" | "github" | "discord" | "telegram",
            parsed.handle,
          )
        : await identities.getDemosIdsByWeb3Identity(
            this.demos,
            parsed.chainType as `${string}.${string}`,
            parsed.address,
          );
    return (accounts ?? [])
      .map((a: { pubkey?: unknown }) => a.pubkey)
      .filter((p: unknown): p is string => typeof p === "string");
  }
}

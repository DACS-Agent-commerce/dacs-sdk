import { Demos } from "@kynesyslabs/demosdk/websdk";
import { StorageProgram } from "@kynesyslabs/demosdk/storage";
import { Identities } from "@kynesyslabs/demosdk/abstraction";

import { SubstrateError } from "../errors.js";
import { parseClaimRef } from "../identity/index.js";
import type {
  AnchorRef,
  ProxyFetchRequest,
  ProxyFetchResult,
  ResolvedIdentity,
  SubstrateAdapter,
} from "./SubstrateAdapter.js";

// Fixed address-derivation inputs so a logical name always resolves to the same
// storage address (any reader can re-derive it from the writer address + name).
const ANCHOR_NONCE = 0;
const ANCHOR_SALT = "dacs:v1";

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

  async anchor(name: string, value: object): Promise<AnchorRef> {
    const data = value as Record<string, unknown>;
    if (!this.connected) {
      throw new Error("DemosAdapter not connected — call connect() first");
    }
    const address = this.anchorAddress(name);

    // Create on first write, update thereafter (idempotent).
    let exists = false;
    try {
      const probe = (await this.demos.storagePrograms.read(address)) as {
        success?: boolean;
        data?: unknown;
      };
      exists = probe?.success === true && probe.data != null;
    } catch {
      exists = false;
    }

    const payload = exists
      ? StorageProgram.writeStorage(address, data, "json")
      : StorageProgram.createStorageProgram(
          this.demos.getAddress(),
          name,
          data,
          "json",
          StorageProgram.publicACL(),
          { nonce: ANCHOR_NONCE, salt: ANCHOR_SALT },
        );

    const signed = await this.demos.storagePrograms.sign(payload);
    const validity = await this.demos.tx.confirm(signed, this.demos);
    const broadcast = (await this.demos.tx.broadcast(validity, this.demos)) as {
      result?: number;
      response?: { hash?: string; message?: string };
      extra?: unknown;
    };
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

    return {
      address,
      txRef: broadcast.response?.hash ?? (signed as { hash?: string }).hash,
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
   * The 4.0.5 surface resolves identities by address, so a ref that is (or
   * contains) an address returns its identity graph. Full claim-ref reverse
   * resolution (e.g. "web2:domain:*") is a substrate gap tracked upstream.
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

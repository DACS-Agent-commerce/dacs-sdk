import { Demos } from "@kynesyslabs/demosdk/websdk";
import { StorageProgram } from "@kynesyslabs/demosdk/storage";
import { Identities } from "@kynesyslabs/demosdk/abstraction";

import { logicalToStorageProgramName } from "../canonical/index.js";
import { SubstrateError } from "../errors.js";
import { parseClaimRef } from "../identity/index.js";
import {
  classifyAnchorResolution,
  type AnchorResolution,
  type CandidateOutcome,
} from "./anchorResolution.js";
import type {
  AnchorRef,
  ProxyFetchRequest,
  ProxyFetchResult,
  ResolvedIdentity,
  SubstrateAdapter,
} from "./SubstrateAdapter.js";

/**
 * Address-derivation salt. EMPTY per the observed on-chain convention
 * (DACS-Standard #242) — `deriveStorageAddress` hashes
 * `{deployer}:{programName}:{nonce}:{salt}`, and live deals derive with an empty
 * salt. (Was `"dacs:v1"`, which produced addresses no live reader could match.)
 */
const ANCHOR_SALT = "";

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
   * storage program, created at `deriveStorageAddress(writer, name, nonce, "")`
   * where `nonce` is the writer's NEXT account nonce (#58 / DACS-Standard #242) —
   * the node enforces sequential nonces and rejects the skeleton default 0. First
   * write creates the program (public-read ACL); later writes update it in place
   * at that address.
   *
   * Because the address folds in the create-time nonce, it is NOT re-derivable by
   * a third party: readers must resolve by program name via the node's name index.
   */
  /**
   * The account nonce a NEW storage program will be created under: the writer's
   * next nonce (`getAddressNonce` + 1) per DACS-Standard #242. The node enforces
   * sequential nonces and REJECTS the skeleton default of 0, so a fixed nonce
   * made every live create fail (#58).
   */
  private async nextAnchorNonce(): Promise<number> {
    return (await this.demos.getAddressNonce(this.demos.getAddress())) + 1;
  }

  /**
   * The storage address a name would anchor to, for THIS writer, right now.
   *
   * IMPORTANT (#58 / DACS-Standard #242): this is NOT third-party derivable. The
   * physical address folds in the writer's account nonce at create time, so only
   * the writer can compute it, and only BEFORE the create lands. A reader that
   * doesn't know the write nonce MUST resolve by program name through the node's
   * name index — precomputing the address is not a discovery mechanism.
   */
  async anchorAddress(name: string): Promise<string> {
    if (!this.connected) {
      throw new Error("DemosAdapter not connected — call connect() first");
    }
    return StorageProgram.deriveStorageAddress(
      this.demos.getAddress(),
      logicalToStorageProgramName(name), // Demos requires colon-free names (§6.3.4)
      await this.nextAnchorNonce(),
      ANCHOR_SALT,
    );
  }

  async anchor(name: string, value: object): Promise<AnchorRef> {
    const data = value as Record<string, unknown>;
    if (!this.connected) {
      throw new Error("DemosAdapter not connected — call connect() first");
    }
    // Create-or-update keyed on the NAME, not on a re-derived address (#70). The
    // physical address folds in the create-time nonce, so a fresh derivation
    // NEVER matches an existing program — the previous "derive, probe, else
    // create" flow created a DUPLICATE on every re-anchor. Resolve the writer's
    // own program by name first; update it in place if present.
    const self = this.demos.getAddress();
    const resolution = await this.resolveAnchorByName(name, self);
    if (resolution.status === "indeterminate") {
      // Never create on an unresolved lookup — that risks a duplicate program for
      // a name that may already exist. Surface it as a substrate fault instead.
      throw new SubstrateError(
        `anchor ${name}: could not determine whether the program already exists (${resolution.reason})`,
      );
    }

    // Demos requires colon-free program names (§6.3.4); the logical `name` is the
    // metadata-of-record, this is the string fed into the native derivation.
    const programName = logicalToStorageProgramName(name);
    let address: string;
    let payload: ReturnType<typeof StorageProgram.writeStorage>;
    if (resolution.status === "present") {
      address = resolution.address;
      payload = StorageProgram.writeStorage(address, data, "json");
    } else {
      // Absent → create under the writer's NEXT account nonce; the address the
      // program lands at is derived from that same nonce.
      const nonce = await this.nextAnchorNonce();
      address = StorageProgram.deriveStorageAddress(self, programName, nonce, ANCHOR_SALT);
      payload = StorageProgram.createStorageProgram(
        self,
        programName,
        data,
        "json",
        StorageProgram.publicACL(),
        { nonce, salt: ANCHOR_SALT },
      );
    }

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

  /**
   * SR-2 discovery — resolve a logical program NAME to its storage address,
   * bound to the expected writer (#58 / DACS-Standard #242).
   *
   * This is the reader-side counterpart to {@link anchorAddress}: because the
   * physical address folds in the writer's create-time nonce, a third party
   * cannot precompute it and MUST look the name up through the node's name index.
   *
   * OWNER BINDING IS LOAD-BEARING: a program name is not exclusive — anyone can
   * create a program with the same name — so resolving by name ALONE would let an
   * attacker squat a well-known name (e.g. a listing address) and serve forged
   * content. We therefore confirm each candidate's `owner` equals `expectedOwner`
   * before returning it. (The node's name-index rows don't carry the owner, so the
   * check costs one read per candidate.) Returns null when nothing matches.
   */
  async resolveAnchorByName(
    name: string,
    expectedOwner: string,
  ): Promise<AnchorResolution> {
    // Resolve by the colon-free program name the record was actually stored under
    // (§6.3.4) — the logical `name` never reaches the node index.
    const programName = logicalToStorageProgramName(name);
    let candidates: Awaited<ReturnType<typeof StorageProgram.searchByName>>;
    try {
      candidates = await StorageProgram.searchByName(this.config.rpc, programName, {
        exactMatch: true, // the default is SUBSTRING matching — never rely on it here
      });
    } catch (e) {
      // A failed name lookup is NOT an absence — treat it as indeterminate so a
      // caller never mistakes a substrate hiccup for "never created" (#70).
      return {
        status: "indeterminate",
        reason: `name lookup failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    // Confirm ownership of each exact-name candidate (the index rows carry no
    // owner, so this is one read per candidate). Read failures become
    // `error: true` so classification can fail closed to `indeterminate`.
    const outcomes: CandidateOutcome[] = [];
    for (const c of candidates) {
      if (c.programName !== programName) continue; // exactMatch is the node's contract, not ours to assume
      try {
        const res = (await this.demos.storagePrograms.read(c.storageAddress)) as {
          success?: boolean;
          owner?: string;
        };
        outcomes.push({
          address: c.storageAddress,
          owner: res?.success && typeof res.owner === "string" ? res.owner : null,
          error: false,
        });
      } catch {
        outcomes.push({ address: c.storageAddress, owner: null, error: true });
      }
    }
    return classifyAnchorResolution(outcomes, expectedOwner);
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

import { Demos } from "@kynesyslabs/demosdk/websdk";
import {
  StorageProgram,
  type StorageProgramListItem,
} from "@kynesyslabs/demosdk/storage";
import { Identities } from "@kynesyslabs/demosdk/abstraction";

import {
  canonicalize,
  contentHash,
  logicalToStorageProgramName,
  sha256Hex,
} from "../canonical/index.js";
import { DacsError, SubstrateError } from "../errors.js";
import { parseClaimRef } from "../identity/index.js";
import {
  classifyAnchorResolution,
  type AnchorResolution,
  type CandidateOutcome,
  type OwnedAnchor,
  type OwnedAnchorScan,
} from "./anchorResolution.js";
import type {
  AnchorRef,
  AnchorWriteOnceOptions,
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
const WRITE_ONCE_VISIBILITY_TIMEOUT_MS = 120_000;
const WRITE_ONCE_VISIBILITY_POLL_MS = 1_000;
const STORAGE_SEARCH_PAGE_SIZE = 100;
const STORAGE_SEARCH_MAX_PAGES = 100;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  /**
   * Serializes immutable creates from this wallet. Without this, two concurrent
   * publishers can both observe `absent` and race on the same next account nonce.
   */
  private immutableWriteChain: Promise<unknown> = Promise.resolve();

  private serializeImmutableWrite<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.immutableWriteChain.then(fn, fn);
    this.immutableWriteChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Call the node search RPC directly and paginate it.
   *
   * demosdk 4.0.x's `StorageProgram.searchByName()` catches every transport/RPC
   * error and returns `[]`, which makes a lookup failure indistinguishable from
   * genuine absence. Immutable publication must fail closed, so this adapter
   * uses the same public nodeCall request while preserving failures.
   */
  private async searchStorageProgramsByName(
    query: string,
    exactMatch: boolean,
  ): Promise<StorageProgramListItem[]> {
    const found = new Map<string, StorageProgramListItem>();
    for (let page = 0; page < STORAGE_SEARCH_MAX_PAGES; page += 1) {
      const offset = page * STORAGE_SEARCH_PAGE_SIZE;
      const response = await fetch(this.config.rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "nodeCall",
          params: [
            {
              message: "searchStoragePrograms",
              data: {
                query,
                options: {
                  exactMatch,
                  limit: STORAGE_SEARCH_PAGE_SIZE,
                  offset,
                },
              },
              muid: `dacs-storage-search-${Date.now()}-${offset}`,
            },
          ],
        }),
      });
      if (!response.ok) {
        throw new SubstrateError(
          `storage-program search failed with HTTP ${response.status}`,
        );
      }
      const payload = (await response.json()) as {
        result?: number;
        response?: unknown;
      };
      if (payload.result !== 200 || !Array.isArray(payload.response)) {
        throw new SubstrateError(
          `storage-program search returned an invalid RPC response (result=${String(payload.result)})`,
        );
      }

      const pageItems = payload.response as StorageProgramListItem[];
      for (const item of pageItems) {
        if (
          !item ||
          typeof item.storageAddress !== "string" ||
          typeof item.programName !== "string"
        ) {
          throw new SubstrateError(
            "storage-program search returned a malformed candidate",
          );
        }
        found.set(item.storageAddress, item);
      }
      if (pageItems.length < STORAGE_SEARCH_PAGE_SIZE) {
        return [...found.values()];
      }
    }
    throw new SubstrateError(
      `storage-program search exceeded ${STORAGE_SEARCH_MAX_PAGES} pages`,
    );
  }

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

  private async resolveExistingImmutable(
    name: string,
    data: Record<string, unknown>,
    owner: string,
  ): Promise<AnchorRef | null> {
    const resolution = await this.resolveAnchorByName(name, owner);
    if (resolution.status === "indeterminate") {
      throw new SubstrateError(
        `immutable anchor ${name}: lookup was indeterminate (${resolution.reason})`,
      );
    }
    if (resolution.status === "absent") return null;

    const existing = await this.readAnchor(resolution.address);
    if (!existing) {
      throw new SubstrateError(
        `immutable anchor ${name}: resolved address ${resolution.address} was not readable`,
      );
    }
    if (contentHash(existing) !== contentHash(data)) {
      throw new DacsError(
        `immutable anchor ${name} already exists with different signed-scope content`,
      );
    }
    return { address: resolution.address };
  }

  private async waitForConcurrentImmutableWinner(
    name: string,
    data: Record<string, unknown>,
    owner: string,
    deadline: number,
    pollMs: number,
    cause: unknown,
  ): Promise<AnchorRef> {
    let lastState = "absent";
    for (;;) {
      try {
        const winner = await this.resolveExistingImmutable(name, data, owner);
        if (winner) return winner;
        lastState = "absent";
      } catch (error) {
        // A different-content winner is a definitive immutable-slot conflict.
        if (error instanceof DacsError) throw error;
        lastState = error instanceof Error ? error.message : String(error);
      }
      if (Date.now() >= deadline) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new SubstrateError(
          `immutable anchor ${name} create failed (${reason}); no owner-bound ` +
            `winner became visible before timeout (last state: ${lastState})`,
        );
      }
      await sleep(pollMs);
    }
  }

  private async waitForCreatedImmutable(
    name: string,
    data: Record<string, unknown>,
    owner: string,
    address: string,
    txRef: string | undefined,
    deadline: number,
    pollMs: number,
  ): Promise<AnchorRef> {
    const expected = sha256Hex(canonicalize(data));
    let lastState = "not read-visible";
    for (;;) {
      const readBack = await this.readAnchor(address);
      if (readBack && sha256Hex(canonicalize(readBack)) === expected) {
        const resolution = await this.resolveAnchorByName(name, owner);
        if (
          resolution.status === "present" &&
          resolution.address === address
        ) {
          return { address, ...(txRef ? { txRef } : {}) };
        }
        if (
          resolution.status === "present" &&
          resolution.address !== address
        ) {
          throw new SubstrateError(
            `immutable anchor ${name} resolved to ${resolution.address} after ` +
              `this create included at ${address}; concurrent duplicate detected`,
          );
        }
        lastState =
          resolution.status === "indeterminate"
            ? `name lookup indeterminate (${resolution.reason})`
            : "name index not visible";
      }
      if (Date.now() >= deadline) {
        throw new SubstrateError(
          `immutable anchor ${name} was included but did not become exact-byte ` +
            `and uniquely name-index visible before timeout (last state: ${lastState})`,
        );
      }
      await sleep(pollMs);
    }
  }

  /**
   * Create-or-return an immutable StorageProgram for `name`.
   *
   * This is deliberately separate from update-capable {@link anchor}: listing
   * version slots and other immutable artifacts must never flow through an
   * update path. Existing programs are resolved by NAME and OWNER (#70), not by
   * predicting the writer's next nonce-derived address. New programs use only
   * `createStorageProgram`, wait for terminal inclusion, exact-byte readback,
   * and unique name-index visibility. A failed create is reconciled against a
   * concurrent winner so same-wallet publishers deterministically return
   * identical content or reject different content instead of overwriting it.
   */
  async anchorWriteOnce(
    name: string,
    value: object,
    opts?: AnchorWriteOnceOptions,
  ): Promise<AnchorRef> {
    if (!this.connected) {
      throw new Error("DemosAdapter not connected — call connect() first");
    }
    const timeoutMs = opts?.timeoutMs ?? WRITE_ONCE_VISIBILITY_TIMEOUT_MS;
    const pollMs = opts?.pollMs ?? WRITE_ONCE_VISIBILITY_POLL_MS;
    if (
      !Number.isFinite(timeoutMs) ||
      timeoutMs < 0 ||
      !Number.isFinite(pollMs) ||
      pollMs < 0
    ) {
      throw new DacsError("anchorWriteOnce timeoutMs/pollMs must be non-negative");
    }

    const data = value as Record<string, unknown>;
    return this.serializeImmutableWrite(async () => {
      const owner = this.demos.getAddress();
      const existing = await this.resolveExistingImmutable(name, data, owner);
      if (existing) return existing;

      // Absent → CREATE ONLY. Never call the update-capable anchor() path here.
      const programName = logicalToStorageProgramName(name);
      const nonce = await this.nextAnchorNonce();
      const address = StorageProgram.deriveStorageAddress(
        owner,
        programName,
        nonce,
        ANCHOR_SALT,
      );
      const payload = StorageProgram.createStorageProgram(
        owner,
        programName,
        data,
        "json",
        StorageProgram.publicACL(),
        { nonce, salt: ANCHOR_SALT },
      );
      const deadline = Date.now() + timeoutMs;
      const signed = await this.demos.storagePrograms.sign(payload);
      const validity = await this.demos.tx.confirm(signed, this.demos);
      let result: {
        broadcast: { response?: { hash?: string } };
        status: { state: "included" | "failed"; blockNumber?: number };
      };
      try {
        result = (await this.demos.broadcastAndWait(validity)) as typeof result;
      } catch (error) {
        // A thrown submission/transport/nonce error does not prove absence.
        return this.waitForConcurrentImmutableWinner(
          name,
          data,
          owner,
          deadline,
          pollMs,
          error,
        );
      }
      if (result.status.state !== "included") {
        return this.waitForConcurrentImmutableWinner(
          name,
          data,
          owner,
          deadline,
          pollMs,
          new Error(`terminal state=${result.status.state}`),
        );
      }
      return this.waitForCreatedImmutable(
        name,
        data,
        owner,
        address,
        result.broadcast?.response?.hash ?? (signed as { hash?: string }).hash,
        deadline,
        pollMs,
      );
    });
  }

  async scanOwnAnchorsByNamePrefix(prefix: string): Promise<OwnedAnchorScan> {
    if (!this.connected) {
      throw new Error("DemosAdapter not connected — call connect() first");
    }
    const programPrefix = logicalToStorageProgramName(prefix);
    let candidates: StorageProgramListItem[];
    try {
      candidates = await this.searchStorageProgramsByName(programPrefix, false);
    } catch (error) {
      return {
        status: "indeterminate",
        reason: `name-prefix lookup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    const owner = this.demos.getAddress().trim().toLowerCase();
    const anchors: OwnedAnchor[] = [];
    for (const candidate of candidates) {
      if (!candidate.programName.startsWith(programPrefix)) continue;
      try {
        const result = (await this.demos.storagePrograms.read(
          candidate.storageAddress,
        )) as {
          success?: boolean;
          owner?: string;
          programName?: string;
          data?: unknown;
        };
        if (!result?.success || typeof result.owner !== "string") {
          return {
            status: "indeterminate",
            reason: `candidate ${candidate.storageAddress} was not readable with an owner`,
          };
        }
        if (result.owner.trim().toLowerCase() !== owner) continue;
        if (
          (result.programName !== undefined &&
            result.programName !== candidate.programName) ||
          result.data === null ||
          typeof result.data !== "object" ||
          Array.isArray(result.data)
        ) {
          return {
            status: "indeterminate",
            reason: `owned candidate ${candidate.storageAddress} returned malformed metadata/data`,
          };
        }
        anchors.push({
          address: candidate.storageAddress,
          programName: candidate.programName,
          value: result.data as Record<string, unknown>,
        });
      } catch (error) {
        return {
          status: "indeterminate",
          reason: `candidate ${candidate.storageAddress} read failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    }
    return { status: "ok", anchors };
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
   * check costs one read per candidate.)
   */
  async resolveAnchorByName(
    name: string,
    expectedOwner: string,
  ): Promise<AnchorResolution> {
    // Resolve by the colon-free program name the record was actually stored under
    // (§6.3.4) — the logical `name` never reaches the node index.
    const programName = logicalToStorageProgramName(name);
    let candidates: StorageProgramListItem[];
    try {
      candidates = await this.searchStorageProgramsByName(programName, true);
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
          error: res?.success !== true,
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

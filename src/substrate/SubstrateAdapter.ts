import type { AnchorResolution, OwnedAnchorScan } from "./anchorResolution.js";
import type { DemosWriteJournal } from "./demosWriteJournal.js";

/** Configuration for the optional Demos-backed adapter. */
export interface DemosAdapterConfig {
  /** Demos node RPC URL (e.g. https://node2.demos.sh). */
  rpc: string;
  /** Wallet secret — mnemonic or private key. Optional for read-only use. */
  secret?: string;
  /**
   * Optional per-transaction fee ceiling in Demos OS base units. When set,
   * every Storage Program confirmation must expose an authoritative fee at or
   * below this value before the adapter invokes broadcast.
   */
  maximumFeeOs?: bigint;
  /**
   * Durable, cross-process wallet/write authority. Required by every write
   * method; read-only adapters may omit it.
   */
  writeJournal?: DemosWriteJournal;
  /**
   * Optional pinned genesis-block hash. When omitted, the adapter reads block
   * zero from the connected node before its first write.
   */
  chainIdentity?: string;
}

/**
 * SubstrateAdapter — the single seam between dacs-sdk and the underlying
 * substrate. DACS is substrate-agnostic by design; the SDK speaks only to this
 * interface, and one concrete implementation (DemosAdapter) wraps
 * `@kynesyslabs/demosdk`. Do not add speculative multi-substrate machinery —
 * the interface is the abstraction; the second adapter is YAGNI
 * (IMPLEMENTATION.md §1.3).
 *
 * Capability groups map to the spec's substrate requirements (SR-*):
 *   - anchor / readAnchor → SR-2  Anchored storage (Storage Programs)
 *   - proxyFetch          → SR-3  Consensus-backed proxy (DAHR)
 *   - resolveIdentity     → SR-1  Cross-substrate identity (CCI)
 *   - channel (deferred)  → SR-4  Private channels (L2PS)
 *   - settle  (deferred)  → SR-5  Atomic cross-chain settlement (Liquidity Tanks)
 *
 * The MVP path (fixed-price + x402 + domain verification + storage delivery)
 * exercises connect / getAddress / sign / anchor / readAnchor / proxyFetch /
 * resolveIdentity. channel + settle are out of MVP scope (IMPLEMENTATION.md §2).
 */

export interface AnchorRef {
  /** Content-addressed storage address the value was written to. */
  address: string;
  /** Substrate transaction reference for the write, if available. */
  txRef?: string;
  /** The completion level actually reached (#57). */
  completion?: AnchorCompletion;
  /** Block/ledger height the write was included at, when observed. */
  blockNumber?: number;
  /** Authenticated Demos write/finality evidence when produced by DemosAdapter. */
  demosEvidence?: DemosWriteEvidence;
}

export interface DemosWriteEvidence {
  evidenceVersion: "1";
  chainIdentity: string;
  writer: string;
  logicalName: string;
  nativeAddress: string;
  operation: "create" | "update";
  nonce: number;
  transactionRef: string;
  /** Canonical JSON encoding of the exact wallet-signed transaction. */
  signedTransaction: string;
  signedTransactionHash: string;
  blockNumber: number;
  blockHash: string;
  /** Timestamp committed in the authenticated Demos block content. */
  blockTimestamp: number;
  /** Canonical JSON encoding of the block's observed BFT validation data. */
  finalityProof: string;
  finalityProofHash: string;
  nativeRead: {
    owner: string;
    programName: string;
    valueHash: string;
    metadataHash?: string;
    observedAt: number;
  };
}

/**
 * How far an anchor write was confirmed before returning (#57). Node acceptance
 * is not the same as inclusion, and inclusion is not the same as read visibility.
 */
export type AnchorCompletion = "accepted" | "included" | "read-visible";

/** The last state the SDK could establish without guessing. */
export type AnchorState =
  | "not-broadcast"
  | "broadcast-unknown"
  | "accepted"
  | "included"
  | "read-visible"
  | "failed";

export interface AnchorAttempts {
  inclusionPolls: number;
  visibilityReads: number;
}

export interface AnchorTimings {
  startedAt: number;
  acceptedAt?: number;
  includedAt?: number;
  readVisibleAt?: number;
  finishedAt: number;
  elapsedMs: number;
}

/**
 * Structured progress/failure evidence. `address` is optional because an
 * owner-bound lookup can fail before a physical address can be established.
 */
export interface AnchorAttemptReceipt {
  name: string;
  address?: string;
  txRef?: string;
  completion?: AnchorCompletion;
  blockNumber?: number;
  state: AnchorState;
  lastObservedState?: string;
  attempts: AnchorAttempts;
  timings: AnchorTimings;
}

/** A successful anchor attempt always has a physical address. */
export interface AnchorReceipt extends AnchorAttemptReceipt, AnchorRef {
  address: string;
}

export type AnchorWaitFailureCode =
  | "cancelled"
  | "timeout"
  | "read-failed"
  | "prepare-failed"
  | "broadcast-failed"
  | "inclusion-failed";

export interface AnchorWaitOptions {
  /** Confirmation level to reach before returning (default `read-visible`). */
  completion?: AnchorCompletion;
  /** Total operation budget, including queueing and preparation. */
  timeoutMs?: number;
  /** Delay between transaction/read polls. */
  pollMs?: number;
  /** Cancel the caller's wait. An ambiguous submitted write is still reconciled. */
  signal?: AbortSignal;
  /** Immutable progress snapshots; observer exceptions never alter execution. */
  onProgress?: (receipt: AnchorAttemptReceipt) => void;
}

export interface AnchorWriteOnceOptions {
  /** Maximum time to reconcile inclusion, read visibility, and name-index visibility. */
  timeoutMs?: number;
  /** Poll interval while waiting for visibility or a concurrent winner. */
  pollMs?: number;
  /** Immutable progress snapshots; observer exceptions never alter execution. */
  onProgress?: (receipt: AnchorAttemptReceipt) => void;
  /**
   * Immutable descriptive metadata stored alongside, but outside, artifact
   * data. Implementations must compare requested metadata on idempotent retry;
   * a legacy record with no metadata is a conflict, because immutable metadata
   * cannot be backfilled without creating a different anchor.
   */
  metadata?: Record<string, unknown>;
  /**
   * Optional durable per-write and aggregate fee budget. The adapter reserves
   * the confirmed fee before broadcast and counts the reservation even if the
   * transaction is later reported failed, preventing restart/retry from
   * exceeding either retained ceiling.
   */
  feeBudget?: Readonly<{
    budgetId: string;
    maximumPerWriteFeeOs: bigint;
    maximumTotalFeeOs: bigint;
  }>;
}

export interface ProxyFetchRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
}

export interface ProxyFetchResult {
  /** Raw response body, returned inline to the caller. */
  body: string;
  status: number;
  /** sha256 of the body, asserted by the validator set. */
  responseHash: string;
  /** Anchoring tx the validators co-signed over (url, time, bodyHash). */
  anchorTxRef?: string;
  /** Epoch-millis the fetch was performed. */
  fetchedAt: number;
}

export interface ResolvedIdentity {
  /** The claim reference that was resolved (echoed back). */
  ref: string;
  /** The primary/root claim this identity is bound to, if any. */
  boundTo?: string;
  /** Raw resolution payload from the substrate. */
  raw: unknown;
}

export interface SubstrateAdapter {
  /** Connect to the substrate RPC (and wallet, if a secret was configured). */
  connect(): Promise<void>;
  /** Address of the connected wallet. Throws if not connected. */
  getAddress(): string;
  /** Sign raw bytes with the connected wallet key; returns the raw signature. */
  sign(bytes: Uint8Array): Promise<Uint8Array>;
  /** The connected wallet's ed25519 public key (the agent's signing identity). */
  getPublicKey(): Promise<Uint8Array>;

  /**
   * SR-2 — anchor a JSON value under a logical name. Returns the content
   * address it was written to (deterministic from the writer + name) and the
   * tx ref. Consumers re-canonicalise the value to verify its content hash.
   */
  anchor(name: string, value: object): Promise<AnchorReceipt>;
  /**
   * SR-2 — anchor and wait for an explicit completion level (#57). Same-wallet
   * writes are serialized through the configured durable chain+wallet journal
   * across adapter instances and processes. The lane remains fenced through
   * authenticated canonical inclusion and exact native readback.
   */
  anchorAndWait(
    name: string,
    value: object,
    opts?: AnchorWaitOptions,
  ): Promise<AnchorReceipt>;
  /**
   * SR-2 — create an immutable, write-once anchor or return an existing
   * signed-scope-identical value. Resolution MUST be owner-bound and fail closed
   * when lookup/read state is indeterminate. Unlike {@link anchor}, this method
   * MUST NEVER update an existing program with different content.
   *
   * A create returns only after authenticated canonical inclusion and exact
   * owner/provenance-bound native readback. Logical-name index visibility is an
   * asynchronous diagnostic, not a protocol gate: restart recovery consults the
   * durable native-slot journal before treating an index miss as absence.
   */
  anchorWriteOnce(
    name: string,
    value: object,
    opts?: AnchorWriteOnceOptions,
  ): Promise<AnchorRef>;
  /**
   * SR-2 — scan anchors owned by this connected writer whose native program
   * names begin with `prefix`. Implementations MUST fail closed: transport,
   * pagination, or candidate-read failures return `indeterminate`, never an
   * empty successful history.
   */
  scanOwnAnchorsByNamePrefix(prefix: string): Promise<OwnedAnchorScan>;
  /**
   * SR-2 — the storage address a name would anchor to for THIS writer, without
   * writing. NOT third-party derivable (#58 / DACS-Standard #242): the physical
   * address folds in the writer's account nonce at create time, so a reader that
   * doesn't know that nonce must resolve by program name through the node's name
   * index instead of precomputing an address.
   */
  anchorAddress(name: string): Promise<string>;
  /**
   * SR-2 discovery — resolve a logical program name to its storage address, bound
   * to the expected writer. The reader-side counterpart to `anchorAddress`: the
   * physical address folds in the writer's create-time nonce, so a third party
   * must resolve by name rather than precompute. Owner binding is required — a
   * program name is not exclusive, so name-only resolution is squattable.
   *
   * Returns a TYPED {@link AnchorResolution}: `present` (owned by the writer),
   * `absent` (readable candidates, none the writer's), or `indeterminate` (the
   * lookup itself failed) — so a transient substrate failure is never mistaken
   * for "never created" (#70).
   */
  resolveAnchorByName(
    name: string,
    expectedOwner: string,
  ): Promise<AnchorResolution>;

  /** SR-2 — read a previously anchored value by its storage address, or null if absent. */
  readAnchor(address: string): Promise<Record<string, unknown> | null>;

  /** SR-3 — consensus-backed proxy fetch of a public HTTPS endpoint (DAHR). */
  proxyFetch(req: ProxyFetchRequest): Promise<ProxyFetchResult>;

  /** SR-1 — resolve a claim reference through cross-substrate identity (CCI). */
  resolveIdentity(ref: string): Promise<ResolvedIdentity>;
  /**
   * SR-1 (reverse) — find the subject primary claims (Demos pubkeys) that have a
   * given linked claim bound to them. `claimRef` is a canonical linked-claim ref
   * (`domain:<host>`, `cci-web2:<platform>:<handle>`, or
   * `cci-xm:<chain>:<subchain>:<address>`).
   * A current `domain:` ref must already use exact DCR-1 spelling. Historical
   * `web2:domain:` aliases require enclosing-artifact authentication and are not
   * accepted by this bare reverse-lookup boundary. Returns the matching subjects
   * (usually one), or [] if none.
   */
  findSubjectsByClaim(claimRef: string): Promise<string[]>;
}

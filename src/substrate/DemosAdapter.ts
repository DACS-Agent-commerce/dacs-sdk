import { types as nodeTypes } from "node:util";
import { Demos } from "@kynesyslabs/demosdk/websdk";
import {
  StorageProgram,
  type StorageProgramListItem,
} from "@kynesyslabs/demosdk/storage";
import { Identities } from "@kynesyslabs/demosdk/abstraction";

import {
  canonicalize,
  logicalToStorageProgramName,
  sha256Hex,
} from "../canonical/index.js";
import {
  ed25519Sign,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
} from "../crypto/index.js";
import { DacsError, SubstrateError } from "../errors.js";
import {
  assertDemosCciResponseBounds,
  parseClaimRef,
  parseDemosAgentClaimReference,
} from "../identity/index.js";
import type { AnchorReceipt as ProtocolAnchorReceipt } from "../artifacts/types.js";
import { AnchorWaitError } from "./AnchorWaitError.js";
import { createDemosHistoryPageFetcher } from "./demosHistory.js";
import {
  assertDemosWriteEvidence,
  decodeDemosAnchorReceiptProof,
  demosSignedTransactionProofHash,
  demosTransactionContentDifferencePaths,
  demosWriteEvidenceBindsReceiptContent,
  demosWriteEvidenceToAnchorReceipt,
} from "./demosWriteEvidence.js";
import {
  classifyAnchorResolution,
  type AnchorResolution,
  type CandidateOutcome,
  type OwnedAnchor,
  type OwnedAnchorScan,
} from "./anchorResolution.js";
import type {
  AnchorAttemptReceipt,
  AnchorCompletion,
  AnchorRef,
  AnchorReceipt,
  AnchorWaitOptions,
  AnchorWriteOnceOptions,
  DemosAdapterConfig,
  DemosWriteEvidence,
  ProxyFetchRequest,
  ProxyFetchResult,
  ResolvedIdentity,
  SubstrateAdapter,
} from "./SubstrateAdapter.js";
import type { AnchorHistoryPageFetcher } from "../discovery/scanner.js";
import type {
  DemosWriteJournal,
  DemosWriteJournalLease,
  DemosWriteJournalRecord,
  DemosWriteStage,
} from "./demosWriteJournal.js";

/**
 * Address-derivation salt. EMPTY per the observed on-chain convention
 * (DACS-Standard #242) — `deriveStorageAddress` hashes
 * `{deployer}:{programName}:{nonce}:{salt}`, and live deals derive with an empty
 * salt. (Was `"dacs:v1"`, which produced addresses no live reader could match.)
 */
const ANCHOR_SALT = "";
const DEFAULT_ANCHOR_TIMEOUT_MS = 120_000;
// 500ms matches demosdk's own broadcastAndWait default and halves the whole-
// second rounding waste on every inclusion/nonce/read-back poll without
// hammering the node any harder than the underlying SDK already does.
const DEFAULT_ANCHOR_POLL_MS = 500;
const AMBIGUOUS_WRITE_RECOVERY_MS = 120_000;
const WRITE_ONCE_VISIBILITY_TIMEOUT_MS = 120_000;
const WRITE_ONCE_VISIBILITY_POLL_MS = 500;
const STORAGE_SEARCH_PAGE_SIZE = 100;
const STORAGE_SEARCH_MAX_PAGES = 100;
const RECEIPT_HISTORY_PAGE_SIZE = 100;
const RECEIPT_HISTORY_MAX_PAGES = 100;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const exactJsonHash = (value: Record<string, unknown>): string =>
  sha256Hex(canonicalize(value));

export interface DemosAnchorReceiptLookup {
  logicalAddress: string;
  nativeAddress: string;
  contentHash: string;
  /** Protocol ClaimRef or native Ed25519 address expected to own the write. */
  writer: string;
}

function demosNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function stableAdapterConfigValue(
  config: object,
  key: keyof DemosAdapterConfig,
): unknown {
  let owner: object | null = config;
  try {
    while (owner !== null) {
      if (nodeTypes.isProxy(owner)) throw new TypeError("proxy prototype");
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor) {
        if (!("value" in descriptor)) throw new TypeError("accessor property");
        return descriptor.value;
      }
      owner = Object.getPrototypeOf(owner);
    }
  } catch (cause) {
    throw new DacsError(`DemosAdapterConfig.${key} must be stable data`, {
      cause,
    });
  }
  return undefined;
}

/** Demos block headers currently expose Unix seconds; CORE timestamps are ms. */
function demosBlockTimestampMs(value: unknown): number | undefined {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return undefined;
  const timestamp = value as number;
  // Also accept future Demos nodes that already expose Unix milliseconds.
  const normalized = timestamp < 100_000_000_000
    ? timestamp * 1_000
    : timestamp;
  return Number.isSafeInteger(normalized) ? normalized : undefined;
}

function normalizeRpcQueueKey(rpc: string): string {
  try {
    const url = new URL(rpc);
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    // connect() owns URL validation. Keep queueing fail-safe for custom
    // transports while still collapsing the common trailing-slash spelling.
    return rpc.trim().replace(/\/+$/, "");
  }
}

function normalizedDemosAddress(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^(?:0x)?[0-9a-f]{64}$/i.test(value)) {
    return undefined;
  }
  return value.toLowerCase().replace(/^0x/, "");
}

function sameDemosWallet(left: unknown, right: unknown): boolean {
  const canonicalLeft = normalizedDemosAddress(left);
  const canonicalRight = normalizedDemosAddress(right);
  return canonicalLeft !== undefined && canonicalRight !== undefined
    ? canonicalLeft === canonicalRight
    : typeof left === "string" && typeof right === "string" &&
      left.toLowerCase() === right.toLowerCase();
}

const DEMOS_OS_PER_DEM = 1_000_000_000n;

function demosConfirmedFeeComponentOs(
  value: unknown,
  postFork: boolean,
): bigint | undefined {
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)) {
    return BigInt(value);
  }
  if (!postFork && typeof value === "number" && Number.isSafeInteger(value) &&
      value >= 0 && !Object.is(value, -0)) {
    return BigInt(value) * DEMOS_OS_PER_DEM;
  }
  return undefined;
}

function demosConfirmedTransactionFeeOs(
  value: unknown,
  postFork: boolean,
): bigint | undefined {
  if (!isJsonObject(value)) return undefined;
  const network = demosConfirmedFeeComponentOs(value.network_fee, postFork);
  const rpc = demosConfirmedFeeComponentOs(value.rpc_fee, postFork);
  const additional = demosConfirmedFeeComponentOs(value.additional_fee, postFork);
  return network === undefined || rpc === undefined || additional === undefined
    ? undefined : network + rpc + additional;
}

function demosConfirmedValidityFeeOs(
  value: unknown,
  postFork: boolean,
): bigint | undefined {
  const data = isRecord(value) && isRecord(value.response) &&
      isRecord(value.response.data)
    ? value.response.data : undefined;
  if (data === undefined) return undefined;
  if (data.gas_operation !== null && data.gas_operation !== undefined) {
    if (!isJsonObject(data.gas_operation) ||
        data.gas_operation.fees === null || data.gas_operation.fees === undefined) {
      return undefined;
    }
    return demosConfirmedTransactionFeeOs(data.gas_operation.fees, postFork);
  }
  return isRecord(data.transaction) && isRecord(data.transaction.content)
    ? demosConfirmedTransactionFeeOs(data.transaction.content.transaction_fee, postFork)
    : undefined;
}

function demosOsDenominationActivated(value: unknown): boolean | undefined {
  return isRecord(value) && isRecord(value.forks) &&
      isRecord(value.forks.osDenomination) &&
      typeof value.forks.osDenomination.activated === "boolean"
    ? value.forks.osDenomination.activated : undefined;
}

function demosTransferAmountOs(
  value: unknown,
  denomination: "os" | "dem",
  allowProjectedOsNumber = false,
): bigint | undefined {
  if (denomination === "os") {
    if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
      return BigInt(value);
    }
    if (allowProjectedOsNumber && typeof value === "number" &&
        Number.isSafeInteger(value) && value >= 0 &&
        !Object.is(value, -0)) {
      return BigInt(value);
    }
    return undefined;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 &&
      !Object.is(value, -0)
    ? BigInt(value) * DEMOS_OS_PER_DEM
    : undefined;
}

function sameOptionalJsonObject(left: unknown, right: unknown): boolean {
  if (left === undefined && right === undefined) return true;
  return isJsonObject(left) && isJsonObject(right) &&
    canonicalize(left) === canonicalize(right);
}

type MutableReceipt = Omit<AnchorAttemptReceipt, "attempts" | "timings"> & {
  attempts: { inclusionPolls: number; visibilityReads: number };
  timings: {
    startedAt: number;
    acceptedAt?: number;
    includedAt?: number;
    readVisibleAt?: number;
  };
};

interface AnchorContext {
  deadline: number;
  pollMs: number;
  signal?: AbortSignal;
  onProgress?: (receipt: AnchorAttemptReceipt) => void;
  receipt: MutableReceipt;
  canonicalTransaction?: Record<string, unknown>;
}

interface QueuedWrite<T> {
  /** Caller-facing outcome; may settle before the nonce-safe point. */
  result: Promise<T>;
  /** Resolves only when the next same-wallet write can safely start. */
  safe: Promise<void>;
}

/**
 * Peer-independent public view of the underlying demosdk client.
 *
 * `raw` is an integration escape hatch, not a second stable SDK surface. Keep
 * the commonly used account/network calls typed here while leaving provider-
 * specific namespaces open. Consumers that need demosdk-specific result types
 * can narrow the returned values after importing those types explicitly.
 */
export interface DemosRawClient {
  connect(rpc: string): Promise<boolean>;
  connectWallet(
    masterSeed: string | Uint8Array,
    options?: { dual_sign?: boolean },
  ): Promise<string>;
  getAddress(): string;
  getAddressNonce(address: string): Promise<number>;
  getNetworkInfo(): Promise<
    | {
        forks?: {
          osDenomination?: { activated?: boolean };
          [name: string]: unknown;
        };
        [name: string]: unknown;
      }
    | null
    | undefined
  >;
  getAddressInfo(address: string): Promise<
    | {
        balance?: bigint;
        [name: string]: unknown;
      }
    | null
    | undefined
  >;
  getBlockByNumber(blockNumber: number): Promise<unknown>;
  getTxByHash(txHash?: string): Promise<unknown>;
  nodeCall(message: unknown, args?: Record<string, unknown>): Promise<unknown>;
  broadcastAndWait(...args: unknown[]): Promise<unknown>;
  // demosdk namespaces are intentionally open-ended. `any` is confined to
  // this explicitly unstable escape hatch so the stable DACS API remains
  // peer-independent without pretending to own demosdk's method signatures.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  storagePrograms: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sign(...args: any[]): any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    read(...args: any[]): any;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    confirm(...args: any[]): any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    broadcast(...args: any[]): any;
  };
}

type BroadcastObservation =
  | { state: "accepted" }
  | { state: "ambiguous" }
  | { state: "rejected"; cause: unknown };

// Coordinates every adapter instance in this JS process. RPC is part of the
// key so the same wallet used on different networks does not block itself.
const walletWriteTails = new Map<string, Promise<void>>();

const JOURNAL_STAGE_RANK: Record<DemosWriteStage, number> = {
  prepared: 0,
  signed: 1,
  "broadcast-intent": 2,
  "canonical-confirmed": 3,
  "canonical-failed": 3,
  "native-visible": 4,
  "index-visible": 5,
};

function queueWalletWrite<T>(
  key: string,
  waitForTurn: (turn: Promise<void>) => Promise<void>,
  start: () => Promise<QueuedWrite<T>>,
): Promise<T> {
  const previous = walletWriteTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const slot = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => slot);
  walletWriteTails.set(key, tail);

  const job = waitForTurn(previous.catch(() => undefined)).then(start);
  void job
    .then(
      ({ safe }) => safe,
      () => undefined,
    )
    .finally(release);
  void tail.finally(() => {
    if (walletWriteTails.get(key) === tail) walletWriteTails.delete(key);
  });

  return job.then(({ result }) => result);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}

function httpStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  if (typeof error.status === "number") return error.status;
  if (typeof error.statusCode === "number") return error.statusCode;
  const response = error.response;
  return isRecord(response) && typeof response.status === "number"
    ? response.status
    : undefined;
}

function isDefinitiveBroadcastRejection(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const result = value.result;
  return (
    typeof result === "number" &&
    Number.isFinite(result) &&
    result >= 400 &&
    result < 500
  );
}

function journalPortableValue(
  value: unknown,
  seen = new Set<object>(),
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new DacsError("signed Demos transaction contains a non-finite number");
    }
    return value;
  }
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value instanceof Uint8Array) {
    return {
      $bytes: Buffer.from(value).toString("base64url"),
    };
  }
  if (typeof value !== "object" || value === null) {
    throw new DacsError(
      `signed Demos transaction contains unsupported ${typeof value}`,
    );
  }
  if (seen.has(value)) {
    throw new DacsError("signed Demos transaction contains a cycle");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => journalPortableValue(item, seen));
    }
    if (value instanceof Map) {
      return {
        $map: [...value.entries()].map(([key, item]) => [
          journalPortableValue(key, seen),
          journalPortableValue(item, seen),
        ]),
      };
    }
    const record: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) record[key] = journalPortableValue(item, seen);
    }
    return record;
  } finally {
    seen.delete(value);
  }
}

function serializeSignedTransaction(value: unknown): string {
  return canonicalize(journalPortableValue(value));
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
  readonly #demos: Demos;
  private readonly config: Readonly<Omit<DemosAdapterConfig, "secret">>;
  #pendingWalletSecret?: string;
  #connectionFailed = false;
  private connected = false;
  private chainIdentity?: string;
  private activeWriteLease?: DemosWriteJournalLease;
  private activeWriteRecord?: DemosWriteJournalRecord;

  private walletQueueKey(): string {
    return `${normalizeRpcQueueKey(this.config.rpc)}\0${this.getAddress().toLowerCase()}`;
  }

  private snapshot(
    receipt: MutableReceipt,
    finishedAt = Date.now(),
  ): AnchorAttemptReceipt {
    return {
      ...receipt,
      attempts: { ...receipt.attempts },
      timings: {
        ...receipt.timings,
        finishedAt,
        elapsedMs: Math.max(0, finishedAt - receipt.timings.startedAt),
      },
    };
  }

  private successReceipt(
    ctx: AnchorContext,
    finishedAt = Date.now(),
  ): AnchorReceipt {
    const receipt = this.snapshot(ctx.receipt, finishedAt);
    if (!receipt.address) {
      throw this.fail(
        ctx,
        "prepare-failed",
        `anchor ${receipt.name} completed without a storage address`,
      );
    }
    const record = this.activeWriteRecord;
    const demosEvidence = record && record.blockHash &&
        record.finalityProofHash && record.nativeRead
      ? this.writeEvidence(record)
      : undefined;
    return {
      ...receipt,
      address: receipt.address,
      ...(demosEvidence === undefined ? {} : { demosEvidence }),
    };
  }

  private emit(ctx: AnchorContext): void {
    if (!ctx.onProgress) return;
    try {
      ctx.onProgress(this.snapshot(ctx.receipt));
    } catch {
      // Observability must never alter transaction execution.
    }
  }

  private fail(
    ctx: AnchorContext,
    code: AnchorWaitError["code"],
    message: string,
    cause?: unknown,
  ): AnchorWaitError {
    return new AnchorWaitError(code, message, this.snapshot(ctx.receipt), {
      cause,
    });
  }

  private remaining(ctx: AnchorContext): number {
    return Math.max(0, ctx.deadline - Date.now());
  }

  /**
   * Race a non-cancellable demosdk call against the caller's total budget.
   * Composite stages can retain a more specific failure observed before the
   * shared deadline instead of replacing it with the outer stage name.
   */
  private waitFor<T>(
    ctx: AnchorContext,
    promise: Promise<T>,
    stage: string,
    timeoutFailure?: () => AnchorWaitError | undefined,
  ): Promise<T> {
    if (ctx.signal?.aborted) {
      return Promise.reject(
        this.fail(ctx, "cancelled", `anchor cancelled during ${stage}`),
      );
    }
    const remaining = this.remaining(ctx);
    if (remaining <= 0) {
      return Promise.reject(
        timeoutFailure?.() ??
          this.fail(ctx, "timeout", `anchor timed out during ${stage}`),
      );
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () =>
        finish(() =>
          reject(
            this.fail(ctx, "cancelled", `anchor cancelled during ${stage}`),
          ),
        );
      const timer = setTimeout(
        () =>
          finish(() =>
            reject(
              timeoutFailure?.() ??
                this.fail(ctx, "timeout", `anchor timed out during ${stage}`),
            ),
          ),
        remaining,
      );
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
    });
  }

  private delay(ctx: AnchorContext): Promise<void> {
    const delayMs = Math.min(ctx.pollMs, this.remaining(ctx));
    return this.waitFor(
      ctx,
      new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
      "poll delay",
    );
  }

  private newContext(
    name: string,
    timeoutMs: number,
    pollMs: number,
    opts?: AnchorWaitOptions,
  ): AnchorContext {
    const startedAt = Date.now();
    return {
      deadline: startedAt + timeoutMs,
      pollMs,
      signal: opts?.signal,
      onProgress: opts?.onProgress,
      receipt: {
        name,
        state: "not-broadcast",
        attempts: { inclusionPolls: 0, visibilityReads: 0 },
        timings: { startedAt },
      },
    };
  }

  private recoveryContext(
    receipt: AnchorAttemptReceipt,
    pollMs: number,
  ): AnchorContext {
    return {
      deadline: Date.now() + AMBIGUOUS_WRITE_RECOVERY_MS,
      pollMs,
      receipt: {
        name: receipt.name,
        ...(receipt.address ? { address: receipt.address } : {}),
        ...(receipt.txRef ? { txRef: receipt.txRef } : {}),
        ...(receipt.completion ? { completion: receipt.completion } : {}),
        ...(receipt.blockNumber === undefined
          ? {}
          : { blockNumber: receipt.blockNumber }),
        state: receipt.state,
        ...(receipt.lastObservedState
          ? { lastObservedState: receipt.lastObservedState }
          : {}),
        attempts: { ...receipt.attempts },
        timings: {
          startedAt: receipt.timings.startedAt,
          ...(receipt.timings.acceptedAt === undefined
            ? {}
            : { acceptedAt: receipt.timings.acceptedAt }),
          ...(receipt.timings.includedAt === undefined
            ? {}
            : { includedAt: receipt.timings.includedAt }),
          ...(receipt.timings.readVisibleAt === undefined
            ? {}
            : { readVisibleAt: receipt.timings.readVisibleAt }),
        },
      },
    };
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

  private async resolveChainIdentity(): Promise<string> {
    if (this.chainIdentity) return this.chainIdentity;
    if (this.config.chainIdentity) {
      const pinned = this.config.chainIdentity.trim().toLowerCase();
      if (!pinned) throw new DacsError("Demos chainIdentity must not be empty");
      this.chainIdentity = pinned;
      return pinned;
    }
    const genesisResult = await this.#demos.getBlockByNumber(0) as unknown;
    const genesis = isRecord(genesisResult) && isRecord(genesisResult.response)
      ? genesisResult.response
      : genesisResult;
    if (isRecord(genesis)) {
      const hash = typeof genesis.hash === "string"
        ? genesis.hash.trim().toLowerCase()
        : "";
      const number = genesis.number ?? genesis.id;
      if (hash && (number === undefined || number === 0)) {
        this.chainIdentity = hash;
        return hash;
      }
    }

    // Some deployed Demos nodes number their first queryable block as one and
    // return the literal `"error"` for block zero. In that layout, block one's
    // authenticated predecessor is the stable genesis/chain identifier.
    const firstResult = await this.#demos.getBlockByNumber(1) as unknown;
    const first = isRecord(firstResult) && isRecord(firstResult.response)
      ? firstResult.response
      : firstResult;
    const content = isRecord(first) && isRecord(first.content)
      ? first.content
      : undefined;
    const previousHash = typeof content?.previousHash === "string"
      ? content.previousHash.trim().toLowerCase()
      : "";
    if (
      !isRecord(first) ||
      first.number !== 1 ||
      first.status !== "confirmed" ||
      typeof first.hash !== "string" ||
      !first.hash.trim() ||
      !previousHash
    ) {
      throw new DacsError("Demos genesis block has no valid chain identity");
    }
    this.chainIdentity = previousHash;
    return previousHash;
  }

  /** Stable authenticated Demos chain identity used to bind guarded plans. */
  async getChainIdentity(): Promise<string> {
    return this.resolveChainIdentity();
  }

  private async acquireWriteLease(): Promise<DemosWriteJournalLease> {
    if (!this.config.writeJournal) {
      throw new DacsError(
        "Demos writes require a durable writeJournal; read-only adapters may omit it",
      );
    }
    return this.config.writeJournal.acquire({
      chainIdentity: await this.resolveChainIdentity(),
      wallet: this.#demos.getAddress().toLowerCase(),
    });
  }

  private async putActiveWrite(
    stage: DemosWriteStage,
    patch: Partial<DemosWriteJournalRecord> = {},
  ): Promise<void> {
    const lease = this.activeWriteLease;
    const current = this.activeWriteRecord;
    if (!lease || !current) {
      throw new DacsError("Demos write journal has no active fenced record");
    }
    const currentRank = JOURNAL_STAGE_RANK[current.stage];
    const requestedRank = JOURNAL_STAGE_RANK[stage];
    const nextStage = requestedRank >= currentRank ? stage : current.stage;
    const next: DemosWriteJournalRecord = {
      ...current,
      ...patch,
      generation: lease.generation,
      stage: nextStage,
      updatedAt: Date.now(),
    };
    this.activeWriteRecord = next;
    await lease.put(next);
  }

  private async withWriteLease<T>(
    start: () => Promise<QueuedWrite<T>>,
  ): Promise<QueuedWrite<T>> {
    const lease = await this.acquireWriteLease();
    this.activeWriteLease = lease;
    this.activeWriteRecord = undefined;
    try {
      const queued = await start();
      const safe = queued.safe.finally(async () => {
        this.activeWriteRecord = undefined;
        this.activeWriteLease = undefined;
        await lease.release();
      });
      return { result: queued.result, safe };
    } catch (error) {
      this.activeWriteRecord = undefined;
      this.activeWriteLease = undefined;
      await lease.release();
      throw error;
    }
  }

  private observeIndexEventually(
    record: DemosWriteJournalRecord,
    pollMs: number,
  ): void {
    const journal = this.config.writeJournal;
    const key = this.activeWriteLease?.key;
    if (!journal || !key) return;
    void (async () => {
      await sleep(Math.max(1, pollMs));
      const resolution = await this.resolveAnchorByIndex(
        record.logicalName,
        record.owner,
      );
      if (
        resolution.status !== "present" ||
        resolution.address !== record.nativeAddress
      ) return;
      const lease = await journal.acquire({ ...key });
      try {
        const current = lease.snapshot.records.find(
          (candidate) => candidate.writeId === record.writeId,
        );
        if (!current) return;
        await lease.put({
          ...current,
          generation: lease.generation,
          stage: "index-visible",
          indexRead: {
            address: record.nativeAddress,
            observedAt: Date.now(),
          },
          updatedAt: Date.now(),
        });
      } finally {
        await lease.release();
      }
    })().catch(() => {
      // Index visibility is diagnostic after authenticated native readback.
      // The durable native-visible record remains authoritative on failure.
    });
  }

  private async assertConfirmedFeeWithinCap(
    validity: unknown,
    requireConfirmedFee = false,
  ): Promise<bigint | undefined> {
    const maximumFeeOs = this.config.maximumFeeOs;
    if (maximumFeeOs === undefined && !requireConfirmedFee) return undefined;
    const postFork = demosOsDenominationActivated(
      await this.#demos.getNetworkInfo(),
    );
    if (postFork === undefined) {
      throw new SubstrateError(
        "Demos fee ceiling cannot authenticate the network denomination",
      );
    }
    const confirmedFeeOs = demosConfirmedValidityFeeOs(validity, postFork);
    if (confirmedFeeOs === undefined) {
      throw new SubstrateError(
        "Demos fee ceiling requires authoritative confirmed transaction fees",
      );
    }
    if (maximumFeeOs !== undefined && confirmedFeeOs > maximumFeeOs) {
      throw new SubstrateError(
        "Demos confirmed transaction fee exceeds maximumFeeOs",
      );
    }
    return confirmedFeeOs;
  }

  private reserveAggregateFeeBudget(
    input: Readonly<{
      budgetId: string;
      maximumPerWriteFeeOs: bigint;
      maximumTotalFeeOs: bigint;
    }>,
    confirmedFeeOs: bigint,
  ) {
    const lease = this.activeWriteLease;
    if (!lease) throw new DacsError("Demos write journal lease is missing");
    let reserved = 0n;
    for (const record of lease.snapshot.records) {
      const budget = record.feeBudget;
      if (budget?.budgetId !== input.budgetId) continue;
      if (BigInt(budget.maximumTotalFeeOs) !== input.maximumTotalFeeOs) {
        throw new DacsError("Demos aggregate fee budget ceiling conflicts with its journal");
      }
      if (BigInt(budget.maximumPerWriteFeeOs) !== input.maximumPerWriteFeeOs) {
        throw new DacsError("Demos per-write fee budget ceiling conflicts with its journal");
      }
      reserved += BigInt(budget.reservedFeeOs);
    }
    if (confirmedFeeOs > input.maximumPerWriteFeeOs) {
      throw new SubstrateError("Demos confirmed fee exceeds per-write purchase budget");
    }
    if (reserved + confirmedFeeOs > input.maximumTotalFeeOs) {
      throw new SubstrateError("Demos aggregate confirmed fee exceeds purchase budget");
    }
    return {
      budgetId: input.budgetId,
      maximumPerWriteFeeOs: input.maximumPerWriteFeeOs.toString(),
      maximumTotalFeeOs: input.maximumTotalFeeOs.toString(),
      reservedFeeOs: confirmedFeeOs.toString(),
    };
  }

  constructor(config: DemosAdapterConfig) {
    if (config === null || typeof config !== "object" || nodeTypes.isProxy(config)) {
      throw new DacsError("DemosAdapterConfig must be stable data");
    }
    const rpc = stableAdapterConfigValue(config, "rpc");
    const secret = stableAdapterConfigValue(config, "secret");
    const maximumFeeOs = stableAdapterConfigValue(config, "maximumFeeOs");
    const writeJournal = stableAdapterConfigValue(config, "writeJournal");
    const chainIdentity = stableAdapterConfigValue(config, "chainIdentity");
    if (typeof rpc !== "string" || rpc.length === 0) {
      throw new Error("DemosAdapter requires an rpc URL");
    }
    if (maximumFeeOs !== undefined &&
        (typeof maximumFeeOs !== "bigint" || maximumFeeOs < 0n)) {
      throw new Error("DemosAdapter maximumFeeOs must be a non-negative bigint");
    }
    if (secret !== undefined && (typeof secret !== "string" || secret.length === 0)) {
      throw new DacsError(
        "DemosAdapterConfig.secret must be a non-empty string when supplied",
      );
    }
    if (chainIdentity !== undefined && typeof chainIdentity !== "string") {
      throw new DacsError("DemosAdapterConfig.chainIdentity must be a string");
    }
    this.config = Object.freeze({
      rpc,
      ...(maximumFeeOs === undefined ? {} : { maximumFeeOs }),
      ...(writeJournal === undefined
        ? {}
        : { writeJournal: writeJournal as DemosWriteJournal }),
      ...(chainIdentity === undefined ? {} : { chainIdentity }),
    });
    this.#pendingWalletSecret = secret;
    this.#demos = new Demos();
  }

  /** Underlying demosdk instance through a peer-independent escape-hatch type. */
  get raw(): DemosRawClient {
    return this.#demos;
  }

  /**
   * Concrete Demos transaction-history seam for the public discovery scanner.
   * The owner is explicit so a read-only Directory can enumerate another
   * producer without possessing that producer's wallet.
   */
  createAnchorHistoryPageFetcher(
    expectedOwner: string,
  ): AnchorHistoryPageFetcher {
    if (!this.connected) {
      throw new Error("DemosAdapter not connected — call connect() first");
    }
    return createDemosHistoryPageFetcher(this.#demos, expectedOwner);
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.#connectionFailed) {
      throw new DacsError(
        "DemosAdapter initialization previously failed; construct a new adapter",
      );
    }
    const walletSecret = this.#pendingWalletSecret;
    this.#pendingWalletSecret = undefined;
    try {
      await this.#demos.connect(this.config.rpc);
      if (walletSecret !== undefined) {
        await this.#demos.connectWallet(walletSecret);
      }
      this.connected = true;
    } catch (error) {
      this.#connectionFailed = true;
      throw error;
    } finally {
      // A failed initialization requires a new adapter. Never retain a wallet
      // secret indefinitely merely to make a later retry convenient.
      this.#pendingWalletSecret = undefined;
    }
  }

  getAddress(): string {
    if (!this.connected) {
      throw new Error("DemosAdapter not connected — call connect() first");
    }
    return this.#demos.getAddress();
  }

  private demosEvidenceMatchesObservations(
    evidence: Readonly<DemosWriteEvidence>,
    transactionResult: unknown,
    blockResult: unknown,
    nativeResult: unknown,
  ): boolean {
    const transaction = isRecord(transactionResult) &&
        isRecord(transactionResult.response)
      ? transactionResult.response
      : transactionResult;
    const block = isRecord(blockResult) && isRecord(blockResult.response)
      ? blockResult.response
      : blockResult;
    if (!isRecord(transaction) || !isRecord(block) || !isRecord(nativeResult)) {
      return false;
    }
    const signed = JSON.parse(evidence.signedTransaction) as unknown;
    const signedContent = isRecord(signed) && isRecord(signed.content)
      ? signed.content
      : undefined;
    const blockContent = isRecord(block.content) ? block.content : undefined;
    const orderedTransactions = Array.isArray(blockContent?.ordered_transactions)
      ? blockContent.ordered_transactions
      : [];
    const contentDifferences = isRecord(transaction.content) && signedContent
      ? demosTransactionContentDifferencePaths(
          signedContent,
          transaction.content,
          evidence.transactionRef,
        )
      : ["content"];
    if (
      transaction.status !== "confirmed" ||
      transaction.hash !== evidence.transactionRef ||
      transaction.blockNumber !== evidence.blockNumber ||
      !isRecord(transaction.content) ||
      !signedContent ||
      contentDifferences.length > 0 ||
      block.status !== "confirmed" ||
      block.number !== evidence.blockNumber ||
      block.hash !== evidence.blockHash ||
      demosBlockTimestampMs(blockContent?.timestamp) !== evidence.blockTimestamp ||
      !orderedTransactions.includes(evidence.transactionRef) ||
      block.validation_data === undefined ||
      serializeSignedTransaction(block.validation_data) !== evidence.finalityProof ||
      nativeResult.success !== true ||
      nativeResult.storageAddress !== evidence.nativeAddress ||
      typeof nativeResult.owner !== "string" ||
      nativeResult.owner.toLowerCase() !== evidence.writer.toLowerCase() ||
      nativeResult.programName !== evidence.nativeRead.programName ||
      !isJsonObject(nativeResult.data) ||
      exactJsonHash(nativeResult.data) !== evidence.nativeRead.valueHash
    ) {
      return false;
    }
    const metadataHash = nativeResult.metadata === undefined ||
        nativeResult.metadata === null
      ? undefined
      : isJsonObject(nativeResult.metadata)
        ? exactJsonHash(nativeResult.metadata)
        : null;
    if (metadataHash === null || metadataHash !== evidence.nativeRead.metadataHash) {
      return false;
    }
    const provenance = evidence.operation === "create"
      ? nativeResult.createdByTx
      : nativeResult.lastModifiedByTx;
    const interactions = Array.isArray(nativeResult.interactionTxs)
      ? nativeResult.interactionTxs
      : [];
    return provenance === evidence.transactionRef ||
      interactions.includes(evidence.transactionRef) ||
      (provenance === undefined && interactions.length === 0);
  }

  /** Re-authenticate full adapter-produced Demos evidence against this node. */
  async verifyDemosWriteEvidence(
    evidence: Readonly<DemosWriteEvidence>,
  ): Promise<boolean> {
    if (!this.connected) {
      throw new Error("DemosAdapter not connected — call connect() first");
    }
    assertDemosWriteEvidence(evidence);
    if (await this.resolveChainIdentity() !== evidence.chainIdentity) return false;

    const observations = await Promise.all([
      this.#demos.getTxByHash(evidence.transactionRef),
      this.#demos.getBlockByNumber(evidence.blockNumber),
      this.#demos.storagePrograms.read(evidence.nativeAddress),
    ]) as unknown[];
    return this.demosEvidenceMatchesObservations(
      evidence,
      observations[0],
      observations[1],
      observations[2],
    );
  }

  /** Re-authenticate a compact portable CORE AnchorReceipt without name-index IO. */
  async verifyDemosAnchorReceipt(
    receipt: Readonly<ProtocolAnchorReceipt>,
  ): Promise<boolean> {
    if (!this.connected) {
      throw new Error("DemosAdapter not connected — call connect() first");
    }
    const proof = decodeDemosAnchorReceiptProof(receipt);
    if (await this.resolveChainIdentity() !== proof.chainIdentity) return false;
    const nonce = Number(receipt.nonce);
    const blockNumber = Number(receipt.blockRef!.height);
    const observations = await Promise.all([
      this.#demos.getTxByHash(receipt.transactionRef.value),
      this.#demos.getBlockByNumber(blockNumber),
      this.#demos.storagePrograms.read(receipt.nativeAddress),
    ]) as unknown[];
    const transactionResult = observations[0];
    const blockResult = observations[1];
    const transaction = isRecord(transactionResult) &&
        isRecord(transactionResult.response)
      ? transactionResult.response
      : transactionResult;
    const block = isRecord(blockResult) && isRecord(blockResult.response)
      ? blockResult.response
      : blockResult;
    if (!isRecord(transaction) || !isRecord(block) ||
        block.validation_data === undefined) {
      return false;
    }
    const evidence: DemosWriteEvidence = {
      evidenceVersion: "1",
      chainIdentity: proof.chainIdentity,
      writer: proof.writer,
      logicalName: receipt.logicalAddress,
      nativeAddress: receipt.nativeAddress,
      operation: proof.operation,
      nonce,
      transactionRef: receipt.transactionRef.value,
      signedTransaction: serializeSignedTransaction(transaction),
      signedTransactionHash: proof.signedTransactionHash,
      blockNumber,
      blockHash: receipt.blockRef!.id,
      blockTimestamp: receipt.blockRef!.timestamp!,
      finalityProof: serializeSignedTransaction(block.validation_data),
      finalityProofHash: proof.finalityProofHash,
      nativeRead: {
        owner: proof.writer,
        programName: proof.nativeRead.programName,
        valueHash: proof.nativeRead.valueHash,
        ...(proof.nativeRead.metadataHash === undefined
          ? {}
          : { metadataHash: proof.nativeRead.metadataHash }),
        observedAt: proof.nativeRead.observedAt,
      },
    };
    assertDemosWriteEvidence(evidence);
    if (!demosWriteEvidenceBindsReceiptContent(
      evidence,
      receipt.logicalAddress,
      receipt.contentHash,
    )) return false;
    return this.demosEvidenceMatchesObservations(
      evidence,
      observations[0],
      observations[1],
      observations[2],
    );
  }

  /**
   * Recover a portable CORE receipt for an already-finalized native Demos
   * Storage Program write. This is the read-side counterpart to
   * `demosWriteEvidenceToAnchorReceipt`: it follows the native provenance tx,
   * authenticates its canonical block and exact current readback, and never
   * treats an RPC/provenance failure as absence.
   */
  async resolveDemosAnchorReceipt(
    input: Readonly<DemosAnchorReceiptLookup>,
  ): Promise<ProtocolAnchorReceipt | null> {
    if (!this.connected) {
      throw new Error("DemosAdapter not connected — call connect() first");
    }
    if (!isRecord(input) ||
        typeof input.logicalAddress !== "string" || input.logicalAddress.length === 0 ||
        input.logicalAddress.trim() !== input.logicalAddress ||
        typeof input.nativeAddress !== "string" || input.nativeAddress.length === 0 ||
        input.nativeAddress.trim() !== input.nativeAddress ||
        typeof input.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(input.contentHash) ||
        typeof input.writer !== "string" || input.writer.length === 0 ||
        input.writer.trim() !== input.writer) {
      throw new TypeError("Demos anchor receipt lookup is invalid");
    }

    let nativeObservation: unknown;
    try {
      nativeObservation = await this.#demos.storagePrograms.read(input.nativeAddress);
    } catch (error) {
      if (httpStatus(error) === 404) return null;
      throw new SubstrateError("Demos receipt native read failed", { cause: error });
    }
    if (!isRecord(nativeObservation)) {
      throw new SubstrateError("Demos receipt native read is malformed");
    }
    const nativeMarker =
      `${nativeObservation.errorCode ?? ""} ${nativeObservation.error ?? ""}`.toLowerCase();
    if (nativeObservation.success !== true) {
      if (nativeMarker.includes("not_found") || nativeMarker.includes("not found")) {
        return null;
      }
      throw new SubstrateError("Demos receipt native read is indeterminate");
    }
    if (nativeObservation.storageAddress !== input.nativeAddress ||
        typeof nativeObservation.owner !== "string" ||
        typeof nativeObservation.programName !== "string" ||
        !isJsonObject(nativeObservation.data)) {
      throw new SubstrateError("Demos receipt native read lacks exact provenance");
    }

    // The latest mutation is authoritative when present. Falling back from a
    // malformed latest update to the create transaction could authenticate a
    // stale value that was later changed and then restored byte-for-byte.
    const latestProvenance = typeof nativeObservation.lastModifiedByTx === "string" &&
        nativeObservation.lastModifiedByTx.length > 0
      ? nativeObservation.lastModifiedByTx
      : nativeObservation.createdByTx;
    let provenanceCandidates = typeof latestProvenance === "string" &&
        latestProvenance.length > 0
      ? [latestProvenance]
      : [];
    if (provenanceCandidates.length === 0) {
      provenanceCandidates = await this.resolveDemosProvenanceFromHistory(
        input.nativeAddress,
        nativeObservation,
      );
    }

    let lastFailure: unknown;
    for (const transactionRef of provenanceCandidates) {
      try {
        const transactionObservation = await this.#demos.getTxByHash(transactionRef);
        const transaction = isRecord(transactionObservation) &&
            isRecord(transactionObservation.response)
          ? transactionObservation.response
          : transactionObservation;
        if (!isRecord(transaction) || transaction.status !== "confirmed" ||
            transaction.hash !== transactionRef || !isRecord(transaction.content)) {
          throw new SubstrateError("Demos receipt transaction is not canonical");
        }
        const blockNumber = demosNonNegativeInteger(transaction.blockNumber);
        const nonce = demosNonNegativeInteger(transaction.content.nonce);
        const tuple = Array.isArray(transaction.content.data)
          ? transaction.content.data : [];
        const payload = isRecord(tuple[1]) ? tuple[1] : undefined;
        const operation = payload?.operation === "CREATE_STORAGE_PROGRAM"
          ? "create" as const
          : payload?.operation === "WRITE_STORAGE"
            ? "update" as const
            : undefined;
        if (blockNumber === undefined || nonce === undefined || operation === undefined) {
          throw new SubstrateError("Demos receipt transaction lacks write provenance");
        }

        const blockObservation = await this.#demos.getBlockByNumber(blockNumber);
        const block = isRecord(blockObservation) && isRecord(blockObservation.response)
          ? blockObservation.response : blockObservation;
        const blockContent = isRecord(block) && isRecord(block.content)
          ? block.content : undefined;
        const blockTimestamp = demosBlockTimestampMs(blockContent?.timestamp);
        if (!isRecord(block) || typeof block.hash !== "string" ||
            blockTimestamp === undefined || block.validation_data === undefined) {
          throw new SubstrateError("Demos receipt block is malformed");
        }
        const finalityProof = serializeSignedTransaction(block.validation_data);
        const signedTransaction = serializeSignedTransaction(transaction);
        const metadataHash = nativeObservation.metadata === undefined ||
            nativeObservation.metadata === null
          ? undefined
          : isJsonObject(nativeObservation.metadata)
            ? exactJsonHash(nativeObservation.metadata)
            : null;
        if (metadataHash === null) {
          throw new SubstrateError("Demos receipt metadata is malformed");
        }
        const evidence: DemosWriteEvidence = {
          evidenceVersion: "1",
          chainIdentity: await this.resolveChainIdentity(),
          writer: nativeObservation.owner,
          logicalName: input.logicalAddress,
          nativeAddress: input.nativeAddress,
          operation,
          nonce,
          transactionRef,
          signedTransaction,
          signedTransactionHash: demosSignedTransactionProofHash(transaction),
          blockNumber,
          blockHash: block.hash,
          blockTimestamp,
          finalityProof,
          finalityProofHash: sha256Hex(finalityProof),
          nativeRead: {
            owner: nativeObservation.owner,
            programName: nativeObservation.programName,
            valueHash: exactJsonHash(nativeObservation.data),
            ...(metadataHash === undefined ? {} : { metadataHash }),
            observedAt: Date.now(),
          },
        };
        assertDemosWriteEvidence(evidence);
        if (!this.demosEvidenceMatchesObservations(
          evidence,
          transaction,
          block,
          nativeObservation,
        )) {
          throw new SubstrateError("Demos receipt observations are inconsistent");
        }
        return demosWriteEvidenceToAnchorReceipt({
          logicalAddress: input.logicalAddress,
          contentHash: input.contentHash,
          writer: input.writer,
          evidence,
        });
      } catch (error) {
        lastFailure = error;
      }
    }
    throw new SubstrateError("Demos receipt provenance could not be authenticated", {
      cause: lastFailure,
    });
  }

  /**
   * Older public nodes omit `createdByTx`/`lastModifiedByTx` from otherwise
   * complete Storage Program reads. Recover the latest owner mutation from a
   * stable, exhaustively paged owner history; any malformed row, moving head,
   * unsupported latest operation or post-scan native change fails closed.
   */
  private async resolveDemosProvenanceFromHistory(
    nativeAddress: string,
    nativeObservation: Readonly<Record<string, unknown>>,
  ): Promise<string[]> {
    const owner = normalizedDemosAddress(nativeObservation.owner);
    if (owner === undefined) {
      throw new SubstrateError("Demos receipt native owner is invalid");
    }
    const ownerAddress = `0x${owner}`;
    const rows: unknown[] = [];
    let firstHash: string | undefined;
    for (let page = 0; page < RECEIPT_HISTORY_MAX_PAGES; page += 1) {
      const start = page * RECEIPT_HISTORY_PAGE_SIZE;
      const raw = await this.#demos.getTransactionHistory(
        ownerAddress,
        "storageProgram",
        { start, limit: RECEIPT_HISTORY_PAGE_SIZE },
      ) as unknown;
      if (!Array.isArray(raw) || raw.length > RECEIPT_HISTORY_PAGE_SIZE) {
        throw new SubstrateError("Demos receipt history page is malformed");
      }
      if (page === 0 && raw.length > 0) {
        const head = raw[0];
        if (!isRecord(head) || typeof head.hash !== "string" || head.hash.length === 0) {
          throw new SubstrateError("Demos receipt history head is malformed");
        }
        firstHash = head.hash;
      }
      rows.push(...raw);
      if (raw.length < RECEIPT_HISTORY_PAGE_SIZE) {
        const lookahead = await this.#demos.getTransactionHistory(
          ownerAddress,
          "storageProgram",
          { start: start + raw.length, limit: 1 },
        ) as unknown;
        if (!Array.isArray(lookahead) || lookahead.length !== 0) {
          throw new SubstrateError("Demos receipt history page is incomplete");
        }
        break;
      }
      if (page === RECEIPT_HISTORY_MAX_PAGES - 1) {
        throw new SubstrateError("Demos receipt history exceeds the verification cap");
      }
    }
    if (firstHash === undefined) {
      throw new SubstrateError("Demos receipt native provenance is unavailable");
    }
    const headCheck = await this.#demos.getTransactionHistory(
      ownerAddress,
      "storageProgram",
      { start: 0, limit: 1 },
    ) as unknown;
    if (!Array.isArray(headCheck) || headCheck.length !== 1 ||
        !isRecord(headCheck[0]) || headCheck[0].hash !== firstHash) {
      throw new SubstrateError("Demos receipt history changed during verification");
    }

    const mutations: Array<Readonly<{
      hash: string;
      blockNumber: number;
      nonce: number;
      operation: string;
      data: unknown;
      metadata: unknown;
    }>> = [];
    for (const [index, raw] of rows.entries()) {
      if (!isRecord(raw) || typeof raw.hash !== "string" || raw.hash.length === 0 ||
          typeof raw.status !== "string") {
        throw new SubstrateError(`Demos receipt history row ${index} is malformed`);
      }
      if (raw.status === "failed") continue;
      if (raw.status !== "confirmed" || !isRecord(raw.content) ||
          raw.content.type !== "storageProgram") {
        throw new SubstrateError(`Demos receipt history row ${index} is not canonical`);
      }
      if (normalizedDemosAddress(raw.content.from) !== owner) continue;
      const tuple = Array.isArray(raw.content.data) ? raw.content.data : [];
      const payload = isRecord(tuple[1]) ? tuple[1] : undefined;
      const touchesNative = raw.content.to === nativeAddress ||
        payload?.storageAddress === nativeAddress;
      if (!touchesNative) continue;
      if (tuple[0] !== "storageProgram" || payload === undefined ||
          raw.content.to !== nativeAddress || payload.storageAddress !== nativeAddress ||
          typeof payload.operation !== "string") {
        throw new SubstrateError("Demos receipt history has inconsistent native provenance");
      }
      const blockNumber = demosNonNegativeInteger(raw.blockNumber);
      const nonce = demosNonNegativeInteger(raw.content.nonce);
      if (blockNumber === undefined || nonce === undefined) {
        throw new SubstrateError("Demos receipt history mutation lacks ordering evidence");
      }
      mutations.push({
        hash: raw.hash,
        blockNumber,
        nonce,
        operation: payload.operation,
        data: payload.data,
        metadata: payload.metadata,
      });
    }
    mutations.sort((left, right) =>
      right.blockNumber - left.blockNumber || right.nonce - left.nonce);
    const latest = mutations[0];
    if (latest === undefined ||
        (latest.operation !== "CREATE_STORAGE_PROGRAM" &&
          latest.operation !== "WRITE_STORAGE")) {
      throw new SubstrateError("Demos receipt latest native mutation is unsupported");
    }
    const observedMetadata = nativeObservation.metadata ?? undefined;
    if (!isJsonObject(latest.data) ||
        canonicalize(latest.data) !== canonicalize(nativeObservation.data) ||
        !sameOptionalJsonObject(latest.metadata ?? undefined, observedMetadata)) {
      throw new SubstrateError("Demos receipt history does not bind the native value");
    }
    const fresh = await this.#demos.storagePrograms.read(nativeAddress) as unknown;
    if (!isRecord(fresh) || fresh.success !== true ||
        fresh.storageAddress !== nativeAddress ||
        normalizedDemosAddress(fresh.owner) !== owner ||
        fresh.programName !== nativeObservation.programName ||
        !isJsonObject(fresh.data) ||
        canonicalize(fresh.data) !== canonicalize(nativeObservation.data) ||
        !sameOptionalJsonObject(fresh.metadata ?? undefined, observedMetadata)) {
      throw new SubstrateError("Demos receipt native value changed during verification");
    }
    return [latest.hash];
  }

  async sign(bytes: Uint8Array): Promise<Uint8Array> {
    if (!this.connected) {
      throw new Error("DemosAdapter not connected — call connect() first");
    }
    if (!(bytes instanceof Uint8Array)) {
      throw new SubstrateError("Demos Ed25519 signer input is invalid");
    }
    const identity = await (this.#demos as any).crypto.getIdentity("ed25519") as {
      privateKey?: unknown;
      publicKey?: unknown;
    };
    if (!(identity.privateKey instanceof Uint8Array) ||
        identity.privateKey.byteLength !== 64 ||
        !(identity.publicKey instanceof Uint8Array) ||
        identity.publicKey.byteLength !== 32) {
      throw new SubstrateError("Demos Ed25519 signing identity is invalid");
    }
    // demosdk's generic signer decodes input as UTF-8 before signing. DACS
    // signs domain-separated binary hash bytes, so that path corrupts any
    // non-UTF-8 octets. Forge exposes its Ed25519 private key as the RFC 8032
    // 32-byte seed followed by the 32-byte public key; derive a Node KeyObject
    // from a private copy and prove it matches the connected wallet before use.
    const seed = Uint8Array.from(identity.privateKey.subarray(0, 32));
    try {
      const key = privateKeyFromSeed(seed);
      if (!Buffer.from(rawPublicKey(publicKeyFromSeed(seed)))
        .equals(Buffer.from(identity.publicKey))) {
        throw new SubstrateError(
          "Demos Ed25519 signing identity does not match its public key",
        );
      }
      return ed25519Sign(bytes, key);
    } finally {
      seed.fill(0);
    }
  }

  async getPublicKey(): Promise<Uint8Array> {
    const { publicKey } = await (this.#demos as any).crypto.getIdentity(
      "ed25519",
    );
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
  private async nextAnchorNonce(key = this.walletQueueKey()): Promise<number> {
    const chainNext =
      (await this.#demos.getAddressNonce(this.#demos.getAddress())) + 1;
    void key;
    const confirmed = this.activeWriteLease?.snapshot.records.reduce<number | undefined>(
      (highest, record) =>
        record.stage === "canonical-confirmed" ||
        record.stage === "native-visible" ||
        record.stage === "index-visible"
          ? Math.max(highest ?? -1, record.nonce)
          : highest,
      undefined,
    );
    return confirmed === undefined ? chainNext : Math.max(chainNext, confirmed + 1);
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
      this.#demos.getAddress(),
      logicalToStorageProgramName(name), // Demos requires colon-free names (§6.3.4)
      await this.nextAnchorNonce(),
      ANCHOR_SALT,
    );
  }

  /** Prepare against current owner-bound state while holding the wallet queue. */
  private async prepareAnchorPayload(
    key: string,
    name: string,
    data: Record<string, unknown>,
  ) {
    const owner = this.#demos.getAddress();
    const journalBindings = (this.activeWriteLease?.snapshot.records ?? [])
      .filter((record) =>
        record.kind !== "native-transfer" &&
        record.logicalName === name &&
        record.owner.toLowerCase() === owner.toLowerCase() &&
        (record.stage === "native-visible" || record.stage === "index-visible")
      );
    const journalAddresses = new Set(
      journalBindings.map((record) => record.nativeAddress),
    );
    if (journalAddresses.size > 1) {
      throw new SubstrateError(
        `anchor ${name}: durable journal contains conflicting native bindings`,
      );
    }
    const journalAddress = journalBindings.at(-1)?.nativeAddress;
    const resolution = await this.resolveAnchorByName(name, owner);
    if (resolution.status === "present") {
      if (journalAddress !== undefined && journalAddress !== resolution.address) {
        throw new SubstrateError(
          `anchor ${name}: logical-name index conflicts with its durable native binding`,
        );
      }
      return {
        operation: "update" as const,
        programName: logicalToStorageProgramName(name),
        address: resolution.address,
        nonce: await this.nextAnchorNonce(key),
        payload: StorageProgram.writeStorage(resolution.address, data, "json"),
      };
    }

    // Exact native content/provenance was authenticated before this binding
    // entered the journal. A lagging secondary name index must not turn that
    // known slot into a second create after restart.
    if (journalAddress !== undefined) {
      return {
        operation: "update" as const,
        programName: logicalToStorageProgramName(name),
        address: journalAddress,
        nonce: await this.nextAnchorNonce(key),
        payload: StorageProgram.writeStorage(journalAddress, data, "json"),
      };
    }

    if (resolution.status === "indeterminate") {
      throw new SubstrateError(
        `anchor ${name}: owner-bound lookup was indeterminate (${resolution.reason})`,
      );
    }

    // A new program uses the live next account nonce and the same empty salt as
    // current Demos writes (#58 / DACS-Standard #242). This must happen inside
    // the same-wallet queue so another SDK write cannot consume the nonce first.
    const programName = logicalToStorageProgramName(name);
    const nonce = await this.nextAnchorNonce(key);
    const address = StorageProgram.deriveStorageAddress(
      owner,
      programName,
      nonce,
      ANCHOR_SALT,
    );
    return {
      operation: "create" as const,
      programName,
      address,
      nonce,
      payload: StorageProgram.createStorageProgram(
        owner,
        programName,
        data,
        "json",
        StorageProgram.publicACL(),
        { nonce, salt: ANCHOR_SALT },
      ),
    };
  }

  private async waitForTerminal(
    txRef: string,
    ctx: AnchorContext,
    broadcastPromise?: Promise<unknown>,
  ): Promise<"included" | "failed"> {
    let broadcast: BroadcastObservation | undefined;
    if (broadcastPromise) {
      void broadcastPromise.then(
        (value) => {
          const response = isRecord(value) ? value : undefined;
          broadcast =
            response?.result === 200
              ? { state: "accepted" }
              : isDefinitiveBroadcastRejection(value)
                ? { state: "rejected", cause: value }
                : { state: "ambiguous" };
        },
        () => {
          // A transport error can happen after the node accepted the bytes.
          // The precomputed hash remains safe to poll and must not be retried.
          broadcast = { state: "ambiguous" };
        },
      );
    }

    for (;;) {
      ctx.receipt.attempts.inclusionPolls += 1;
      let status: unknown;
      let transaction: unknown;
      try {
        const observations = await this.waitFor(
          ctx,
          Promise.allSettled([
            this.#demos.nodeCall("getTransactionStatus", { hash: txRef }),
            this.#demos.getTxByHash(txRef),
          ]),
          "inclusion",
        );
        if (observations[0]?.status === "fulfilled") {
          status = observations[0].value;
        }
        if (observations[1]?.status === "fulfilled") {
          transaction = observations[1].value;
        }
      } catch (error) {
        if (error instanceof AnchorWaitError) throw error;
        // Observation transport errors are retryable within the original
        // budget and never trigger a rebroadcast of the submitted transaction.
        ctx.receipt.lastObservedState = "status-read-error";
        this.emit(ctx);
        await this.delay(ctx);
        continue;
      }

      const record =
        isRecord(status) && isRecord(status.response)
          ? status.response
          : status;
      const state =
        isRecord(record) && typeof record.state === "string"
          ? record.state
          : undefined;
      if (state) ctx.receipt.lastObservedState = state;
      const transactionRecord = isRecord(transaction) && isRecord(transaction.response)
        ? transaction.response
        : transaction;
      const executionStatus = isRecord(transactionRecord) &&
          typeof transactionRecord.status === "string"
        ? transactionRecord.status
        : undefined;
      const observedBlockNumber = isRecord(transactionRecord) &&
          typeof transactionRecord.blockNumber === "number"
        ? transactionRecord.blockNumber
        : isRecord(record) && typeof record.blockNumber === "number"
          ? record.blockNumber
          : undefined;

      if (executionStatus === "failed" || state === "failed") {
        ctx.receipt.state = "failed";
        ctx.receipt.lastObservedState = "failed";
        if (observedBlockNumber !== undefined) {
          ctx.receipt.blockNumber = observedBlockNumber;
        }
        this.emit(ctx);
        return "failed";
      }

      if (state === "included" || executionStatus === "confirmed") {
        const now = Date.now();
        // The status index and canonical transaction row can advance in either
        // order. `included` alone never proves execution success: live Demos
        // can keep reporting it after getTxByHash finalized the transaction as
        // failed. A canonical `confirmed` row is sufficient even when the
        // secondary status index is still behind.
        if (ctx.receipt.timings.acceptedAt == null) {
          ctx.receipt.state = "accepted";
          ctx.receipt.completion = "accepted";
          ctx.receipt.timings.acceptedAt = now;
          this.emit(ctx);
        }
        ctx.receipt.state = "included";
        ctx.receipt.completion = "included";
        ctx.receipt.timings.includedAt ??= now;
        if (observedBlockNumber !== undefined) {
          ctx.receipt.blockNumber = observedBlockNumber;
        }
        this.emit(ctx);
        if (executionStatus === "confirmed") {
          ctx.canonicalTransaction = transactionRecord as Record<string, unknown>;
          return "included";
        }
        ctx.receipt.lastObservedState = transaction === undefined
          ? "included-execution-read-error"
          : "included-execution-pending";
        this.emit(ctx);
        await this.delay(ctx);
        continue;
      }

      // A chain observation is authoritative. Only after checking it do we use
      // a definitive 4xx broadcast response to fail promptly. Ambiguous 5xx,
      // timeout, and connection errors keep polling the already-known hash.
      if (broadcast?.state === "rejected") {
        ctx.receipt.state = "failed";
        this.emit(ctx);
        throw this.fail(
          ctx,
          "broadcast-failed",
          `anchor ${ctx.receipt.address ?? txRef} was rejected by the node`,
          broadcast.cause,
        );
      }
      if (
        broadcast?.state === "accepted" &&
        ctx.receipt.state === "broadcast-unknown"
      ) {
        const now = Date.now();
        ctx.receipt.state = "accepted";
        ctx.receipt.completion = "accepted";
        ctx.receipt.timings.acceptedAt = now;
        this.emit(ctx);
      }
      this.emit(ctx);
      await this.delay(ctx);
    }
  }

  private async waitForNativeJournalVisibility(
    record: DemosWriteJournalRecord,
    ctx: AnchorContext,
  ): Promise<DemosWriteJournalRecord["nativeRead"]> {
    const timeoutFailure = () =>
      this.fail(
        ctx,
        "timeout",
        `anchor ${ctx.receipt.name} was included but authenticated native ` +
          "readback did not complete before timeout",
      );
    for (;;) {
      ctx.receipt.attempts.visibilityReads += 1;
      try {
        const result = await this.waitFor(
          ctx,
          this.#demos.storagePrograms.read(record.nativeAddress),
          "authenticated native readback",
          () => timeoutFailure(),
        ) as unknown;
        if (isRecord(result) && result.success === true) {
          const data = result.data;
          const metadata = result.metadata;
          const owner = typeof result.owner === "string" ? result.owner : "";
          const programName = typeof result.programName === "string"
            ? result.programName
            : "";
          const storageAddress = typeof result.storageAddress === "string"
            ? result.storageAddress
            : "";
          const valueMatches = isJsonObject(data) &&
            exactJsonHash(data) === record.valueHash;
          const metadataMatches = record.metadataHash === undefined
            ? true
            : isJsonObject(metadata) &&
              exactJsonHash(metadata) === record.metadataHash;
          const provenanceTx = record.operation === "create"
            ? result.createdByTx
            : result.lastModifiedByTx;
          const interactions = Array.isArray(result.interactionTxs)
            ? result.interactionTxs
            : [];
          const provenanceMatches = provenanceTx === record.txRef ||
            interactions.includes(record.txRef) ||
            (provenanceTx === undefined && interactions.length === 0);
          const ownerMatches = owner.toLowerCase() === record.owner.toLowerCase();
          const programNameMatches = programName === record.programName;
          const addressMatches = storageAddress === record.nativeAddress;
          if (
            valueMatches &&
            metadataMatches &&
            ownerMatches &&
            programNameMatches &&
            addressMatches &&
            provenanceMatches
          ) {
            return {
              owner,
              programName,
              valueHash: record.valueHash,
              ...(record.metadataHash === undefined
                ? {}
                : { metadataHash: record.metadataHash }),
              observedAt: Date.now(),
            };
          }
          ctx.receipt.lastObservedState = "native-readback-mismatch";
        } else {
          ctx.receipt.lastObservedState = "native-not-visible";
        }
      } catch (error) {
        if (error instanceof AnchorWaitError) {
          throw error.code === "timeout" ? timeoutFailure() : error;
        }
        ctx.receipt.lastObservedState = "native-read-error";
      }
      this.emit(ctx);
      try {
        await this.delay(ctx);
      } catch (error) {
        if (error instanceof AnchorWaitError && error.code === "timeout") {
          throw timeoutFailure();
        }
        throw error;
      }
    }
  }

  private async authenticateCanonicalWrite(
    record: DemosWriteJournalRecord,
    ctx: AnchorContext,
  ): Promise<Pick<
    DemosWriteJournalRecord,
    | "blockNumber"
    | "blockHash"
    | "blockTimestamp"
    | "finalityProof"
    | "finalityProofHash"
  >> {
    const transaction = ctx.canonicalTransaction;
    const blockNumber = ctx.receipt.blockNumber;
    if (!transaction || !Number.isSafeInteger(blockNumber) || blockNumber! < 0) {
      throw this.fail(
        ctx,
        "inclusion-failed",
        `canonical Demos transaction ${record.txRef} has no block height`,
      );
    }
    if (
      transaction.hash !== undefined &&
      transaction.hash !== record.txRef
    ) {
      throw this.fail(
        ctx,
        "inclusion-failed",
        `canonical Demos transaction hash ${String(transaction.hash)} does not match ${record.txRef}`,
      );
    }
    if (
      !record.signedTransaction ||
      !record.signedTransactionHash
    ) {
      throw this.fail(
        ctx,
        "inclusion-failed",
        `journaled Demos transaction ${record.txRef} has an invalid signed envelope hash`,
      );
    }
    let signed: unknown;
    try {
      signed = JSON.parse(record.signedTransaction) as unknown;
      if (canonicalize(signed) !== record.signedTransaction) throw new Error();
    } catch {
      throw this.fail(
        ctx,
        "inclusion-failed",
        `journaled Demos transaction ${record.txRef} is not canonical JSON`,
      );
    }
    if (demosSignedTransactionProofHash(signed) !== record.signedTransactionHash) {
      throw this.fail(
        ctx,
        "inclusion-failed",
        `journaled Demos transaction ${record.txRef} has an invalid signed envelope hash`,
      );
    }
    if (!isRecord(signed) || signed.hash !== record.txRef) {
      throw this.fail(
        ctx,
        "inclusion-failed",
        `journaled Demos transaction does not bind hash ${record.txRef}`,
      );
    }
    const content = isRecord(signed.content) ? signed.content : undefined;
    const canonicalContent = isRecord(transaction.content)
      ? transaction.content
      : undefined;
    const contentDifferences = content && canonicalContent
      ? demosTransactionContentDifferencePaths(
          content,
          canonicalContent,
          record.txRef ?? "",
        )
      : ["content"];
    if (
      transaction.content !== undefined &&
      contentDifferences.length > 0
    ) {
      throw this.fail(
        ctx,
        "inclusion-failed",
        `canonical Demos transaction ${record.txRef} changed its signed content at ` +
          contentDifferences.join(", "),
      );
    }
    const payloadTuple = Array.isArray(content?.data) ? content.data : [];
    const payload = isRecord(payloadTuple[1]) ? payloadTuple[1] : undefined;
    const expectedOperation = record.operation === "create"
      ? "CREATE_STORAGE_PROGRAM"
      : "WRITE_STORAGE";
    const payloadDataMatches = isJsonObject(payload?.data) &&
      exactJsonHash(payload.data) === record.valueHash;
    const payloadMetadataMatches = record.metadataHash === undefined
      ? payload?.metadata === undefined
      : isJsonObject(payload?.metadata) &&
        exactJsonHash(payload.metadata) === record.metadataHash;
    if (
      content?.type !== "storageProgram" ||
      typeof content.from !== "string" ||
      content.from.toLowerCase() !== record.owner.toLowerCase() ||
      content.to !== record.nativeAddress ||
      content.nonce !== record.nonce ||
      payloadTuple[0] !== "storageProgram" ||
      payload?.operation !== expectedOperation ||
      payload.storageAddress !== record.nativeAddress ||
      payload.encoding !== "json" ||
      (record.operation === "create" && payload.programName !== record.programName) ||
      !payloadDataMatches ||
      !payloadMetadataMatches
    ) {
      throw this.fail(
        ctx,
        "inclusion-failed",
        `canonical Demos transaction ${record.txRef} does not match its journaled write`,
      );
    }

    const observed = await this.waitFor(
      ctx,
      this.#demos.getBlockByNumber(blockNumber!),
      "canonical block authentication",
    ) as unknown;
    const block = isRecord(observed) && isRecord(observed.response)
      ? observed.response
      : observed;
    if (!isRecord(block)) {
      throw this.fail(
        ctx,
        "inclusion-failed",
        `Demos block ${blockNumber} is malformed`,
      );
    }
    const blockHash = typeof block.hash === "string" ? block.hash : "";
    const blockContent = isRecord(block.content) ? block.content : undefined;
    const blockTimestamp = demosBlockTimestampMs(blockContent?.timestamp);
    const orderedTransactions = Array.isArray(blockContent?.ordered_transactions)
      ? blockContent.ordered_transactions
      : [];
    if (
      !blockHash ||
      block.status !== "confirmed" ||
      block.number !== blockNumber ||
      blockTimestamp === undefined ||
      !orderedTransactions.includes(record.txRef)
    ) {
      throw this.fail(
        ctx,
        "inclusion-failed",
        `Demos block ${blockNumber} does not authenticate transaction ${record.txRef}`,
      );
    }
    if (block.validation_data === undefined) {
      throw this.fail(
        ctx,
        "inclusion-failed",
        `Demos block ${blockNumber} has no BFT validation data`,
      );
    }
    const finalityProof = serializeSignedTransaction(block.validation_data);
    return {
      blockNumber: blockNumber!,
      blockHash,
      blockTimestamp,
      finalityProof,
      finalityProofHash: sha256Hex(finalityProof),
    };
  }

  private writeEvidence(
    record: DemosWriteJournalRecord,
    chainIdentity = this.activeWriteLease?.key.chainIdentity,
  ) {
    if (
      record.kind === "native-transfer" ||
      (record.operation !== "create" && record.operation !== "update")
    ) {
      throw new DacsError("native DEM wallet journal records are not anchor evidence");
    }
    const operation = record.operation;
    if (
      !chainIdentity ||
      !record.txRef ||
      !record.signedTransaction ||
      !record.signedTransactionHash ||
      record.blockNumber === undefined ||
      !record.blockHash ||
      record.blockTimestamp === undefined ||
      !record.finalityProof ||
      !record.finalityProofHash ||
      !record.nativeRead
    ) {
      throw new DacsError(
        `Demos write ${record.writeId} has incomplete authenticated evidence`,
      );
    }
    return {
      evidenceVersion: "1" as const,
      chainIdentity,
      writer: record.owner,
      logicalName: record.logicalName,
      nativeAddress: record.nativeAddress,
      operation,
      nonce: record.nonce,
      transactionRef: record.txRef,
      signedTransaction: record.signedTransaction!,
      signedTransactionHash: record.signedTransactionHash,
      blockNumber: record.blockNumber,
      blockHash: record.blockHash,
      blockTimestamp: record.blockTimestamp,
      finalityProof: record.finalityProof!,
      finalityProofHash: record.finalityProofHash,
      nativeRead: structuredClone(record.nativeRead),
    };
  }

  private async authenticateCanonicalNativeTransfer(
    record: DemosWriteJournalRecord,
    ctx: AnchorContext,
  ): Promise<Pick<
    DemosWriteJournalRecord,
    | "blockNumber"
    | "blockHash"
    | "blockTimestamp"
    | "finalityProof"
    | "finalityProofHash"
  >> {
    const transaction = ctx.canonicalTransaction;
    const blockNumber = ctx.receipt.blockNumber;
    const transfer = record.transfer;
    const content = isRecord(transaction?.content) ? transaction.content : undefined;
    const payerFields = [content?.from, content?.from_ed25519_address]
      .filter((value) => value !== undefined);
    const tuple = Array.isArray(content?.data) ? content.data : [];
    const native = isRecord(tuple[1]) ? tuple[1] : undefined;
    const args = Array.isArray(native?.args) ? native.args : [];
    const expectedAmountOs = transfer !== undefined &&
        /^[1-9][0-9]*$/.test(transfer.amountOs)
      ? BigInt(transfer.amountOs)
      : undefined;
    if (record.kind !== "native-transfer" || transfer === undefined ||
        !transaction || !Number.isSafeInteger(blockNumber) || blockNumber! < 0 ||
        normalizedDemosAddress(transaction.hash) !== record.txRef ||
        normalizedDemosAddress(transfer.payer) !== normalizedDemosAddress(record.owner) ||
        normalizedDemosAddress(transfer.payee) !== normalizedDemosAddress(record.nativeAddress) ||
        content?.type !== "native" || content.custom_charges != null ||
        demosNonNegativeInteger(content.nonce) !== record.nonce ||
        payerFields.length === 0 || payerFields.some((value) =>
          normalizedDemosAddress(value) !== normalizedDemosAddress(record.owner)) ||
        normalizedDemosAddress(content.to) !== normalizedDemosAddress(transfer.payee) ||
        demosTransferAmountOs(content.amount, transfer.denomination, true) !==
          expectedAmountOs ||
        tuple.length !== 2 || tuple[0] !== "native" ||
        native?.nativeOperation !== "send" || args.length !== 2 ||
        normalizedDemosAddress(args[0]) !== normalizedDemosAddress(transfer.payee) ||
        demosTransferAmountOs(args[1], transfer.denomination) !== expectedAmountOs) {
      throw this.fail(
        ctx,
        "inclusion-failed",
        `canonical Demos transfer ${record.txRef} does not match its wallet journal`,
      );
    }
    const observed = await this.waitFor(
      ctx,
      this.#demos.getBlockByNumber(blockNumber!),
      "canonical transfer block authentication",
    ) as unknown;
    const block = isRecord(observed) && isRecord(observed.response)
      ? observed.response : observed;
    const blockContent = isRecord(block) && isRecord(block.content)
      ? block.content : undefined;
    const blockHash = isRecord(block) && typeof block.hash === "string" ? block.hash : "";
    const blockTimestamp = demosBlockTimestampMs(blockContent?.timestamp);
    const orderedTransactions = Array.isArray(blockContent?.ordered_transactions)
      ? blockContent.ordered_transactions : [];
    if (!isRecord(block) || !blockHash || block.status !== "confirmed" ||
        block.number !== blockNumber || blockTimestamp === undefined ||
        !orderedTransactions.includes(record.txRef) || block.validation_data === undefined) {
      throw this.fail(
        ctx,
        "inclusion-failed",
        `Demos block ${String(blockNumber)} does not authenticate transfer ${record.txRef}`,
      );
    }
    const finalityProof = serializeSignedTransaction(block.validation_data);
    return {
      blockNumber: blockNumber!,
      blockHash,
      blockTimestamp,
      finalityProof,
      finalityProofHash: sha256Hex(finalityProof),
    };
  }

  private async waitForWalletNonceVisibility(
    lease: DemosWriteJournalLease,
    deadline: number,
    pollMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const highestCanonicalNonce = lease.snapshot.records.reduce<number | undefined>(
      (highest, record) =>
        record.stage === "canonical-confirmed" ||
        record.stage === "native-visible" ||
        record.stage === "index-visible"
          ? Math.max(highest ?? -1, record.nonce)
          : highest,
      undefined,
    );
    if (highestCanonicalNonce === undefined) return;
    const ctx = this.newContext(
      `wallet-nonce:${lease.key.wallet}`,
      Math.max(1, deadline - Date.now()),
      pollMs,
      signal === undefined ? undefined : { signal },
    );
    for (;;) {
      await lease.assertCurrent();
      ctx.receipt.attempts.visibilityReads += 1;
      try {
        const observed = await this.waitFor(
          ctx,
          this.#demos.getAddressNonce(this.#demos.getAddress()),
          "wallet nonce visibility",
        ) as unknown;
        if (typeof observed === "number" && Number.isSafeInteger(observed) &&
            observed >= highestCanonicalNonce) return;
        ctx.receipt.lastObservedState = "wallet-nonce-lagging";
      } catch (error) {
        if (error instanceof AnchorWaitError && error.code === "timeout") {
          throw this.fail(
            ctx,
            "timeout",
            `Demos wallet nonce did not reach ${highestCanonicalNonce} after canonical finality`,
            error,
          );
        }
        ctx.receipt.lastObservedState = "wallet-nonce-unavailable";
      }
      try {
        await this.delay(ctx);
      } catch (error) {
        if (error instanceof AnchorWaitError && error.code === "timeout") {
          throw this.fail(
            ctx,
            "timeout",
            `Demos wallet nonce did not reach ${highestCanonicalNonce} after canonical finality`,
            error,
          );
        }
        throw error;
      }
    }
  }

  /**
   * Reconcile every broadcast-intent for this wallet before another nonce is
   * signed. Anchors and native transfers share one Demos account nonce, so a
   * caller may never recover only its own write kind.
   */
  async reconcileWalletJournal(
    lease: DemosWriteJournalLease,
    timeoutMs = AMBIGUOUS_WRITE_RECOVERY_MS,
    options: Readonly<{
      pollMs?: number;
      signal?: AbortSignal;
      requireNonceVisibility?: boolean;
    }> = {},
  ): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new DacsError("Demos wallet journal reconciliation input is invalid");
    }
    await lease.assertCurrent();
    // There is no chain state to authenticate until a prior write exists. This
    // also preserves the adapter's read-before-create seam for empty journals;
    // the subsequently prepared write is still retained under this exact
    // chain/wallet lease before any broadcast is attempted.
    if (lease.snapshot.records.length === 0) return;
    const wallet = normalizedDemosAddress(this.#demos.getAddress());
    if (!this.connected) throw new DacsError("Demos adapter is not connected");
    if (wallet === undefined) throw new DacsError("Demos wallet address is invalid");
    if (!sameDemosWallet(lease.key.wallet, wallet)) {
      throw new DacsError("Demos wallet journal belongs to another wallet");
    }
    if (lease.key.chainIdentity !== await this.resolveChainIdentity()) {
      throw new DacsError("Demos wallet journal belongs to another chain");
    }
    const deadline = Date.now() + timeoutMs;
    const pollMs = options.pollMs ?? DEFAULT_ANCHOR_POLL_MS;
    const contextOptions = options.signal === undefined
      ? undefined
      : { signal: options.signal };
    for (const retained of lease.snapshot.records) {
      if (retained.stage === "prepared" ||
          retained.stage === "canonical-failed") continue;
      if (retained.kind === "native-transfer") {
        if (retained.stage === "canonical-confirmed") continue;
        if (retained.stage !== "broadcast-intent" || !retained.txRef) {
          throw new DacsError("native DEM wallet journal has an invalid pending record");
        }
        const ctx = this.newContext(
          retained.logicalName,
          Math.max(1, deadline - Date.now()),
          pollMs,
          contextOptions,
        );
        ctx.receipt.address = retained.nativeAddress;
        ctx.receipt.txRef = retained.txRef;
        const terminal = await this.waitForTerminal(retained.txRef, ctx);
        const current = { ...retained, generation: lease.generation };
        if (terminal === "failed") {
          await lease.put({ ...current, stage: "canonical-failed", updatedAt: Date.now() });
          continue;
        }
        const finality = await this.authenticateCanonicalNativeTransfer(current, ctx);
        await lease.put({
          ...current,
          ...finality,
          stage: "canonical-confirmed",
          updatedAt: Date.now(),
        });
        continue;
      }

      if (retained.stage !== "broadcast-intent" &&
          retained.stage !== "canonical-confirmed") continue;
      if (!retained.txRef) {
        throw new DacsError("Demos wallet journal has an anchor without a transaction hash");
      }
      const ctx = this.newContext(
        retained.logicalName,
        Math.max(1, deadline - Date.now()),
        pollMs,
        contextOptions,
      );
      ctx.receipt.address = retained.nativeAddress;
      ctx.receipt.txRef = retained.txRef;
      let current = { ...retained, generation: lease.generation };
      if (retained.stage === "broadcast-intent") {
        const terminal = await this.waitForTerminal(retained.txRef, ctx);
        if (terminal === "failed") {
          await lease.put({
            ...current,
            stage: "canonical-failed",
            updatedAt: Date.now(),
          });
          continue;
        }
        const finality = await this.authenticateCanonicalWrite(current, ctx);
        current = {
          ...current,
          ...finality,
          stage: "canonical-confirmed" as const,
          updatedAt: Date.now(),
        };
        await lease.put(current);
      } else {
        ctx.receipt.state = "included";
        ctx.receipt.completion = "included";
        if (retained.blockNumber !== undefined) {
          ctx.receipt.blockNumber = retained.blockNumber;
        }
      }
      const nativeRead = await this.waitForNativeJournalVisibility(current, ctx);
      await lease.put({
        ...current,
        generation: lease.generation,
        nativeRead,
        stage: "native-visible",
        updatedAt: Date.now(),
      });
    }
    if (options.requireNonceVisibility !== false) {
      await this.waitForWalletNonceVisibility(
        lease,
        deadline,
        pollMs,
        options.signal,
      );
    }
  }

  /** @deprecated Use reconcileWalletJournal; this alias is wallet-wide too. */
  async reconcileNativeTransferJournal(
    lease: DemosWriteJournalLease,
    timeoutMs = AMBIGUOUS_WRITE_RECOVERY_MS,
  ): Promise<void> {
    await this.reconcileWalletJournal(lease, timeoutMs);
  }

  private writeEvidenceFromLease(
    lease: DemosWriteJournalLease,
    writeId: string,
  ) {
    const record = lease.snapshot.records.find(
      (candidate) => candidate.writeId === writeId,
    );
    if (!record) {
      throw new DacsError(`Demos write ${writeId} is missing from its journal`);
    }
    return this.writeEvidence(record, lease.key.chainIdentity);
  }

  private async persistCanonicalWrite(ctx: AnchorContext): Promise<void> {
    const record = this.activeWriteRecord;
    if (!record) throw new DacsError("Demos write journal record is missing");
    if (JOURNAL_STAGE_RANK[record.stage] >= JOURNAL_STAGE_RANK["canonical-confirmed"] &&
        record.stage !== "canonical-failed") {
      return;
    }
    const finality = await this.authenticateCanonicalWrite(record, ctx);
    await this.putActiveWrite("canonical-confirmed", finality);
  }

  private async persistNativeReadback(ctx: AnchorContext): Promise<void> {
    const record = this.activeWriteRecord;
    if (!record) throw new DacsError("Demos write journal record is missing");
    if (JOURNAL_STAGE_RANK[record.stage] >= JOURNAL_STAGE_RANK["native-visible"]) {
      return;
    }
    const nativeRead = await this.waitForNativeJournalVisibility(record, ctx);
    await this.putActiveWrite("native-visible", { nativeRead });
    const now = Date.now();
    ctx.receipt.state = "read-visible";
    ctx.receipt.completion = "read-visible";
    ctx.receipt.timings.readVisibleAt ??= now;
    this.emit(ctx);
  }

  private async reconcileUntilNonceSafe(
    key: string,
    txRef: string,
    signedNonce: number,
    ctx: AnchorContext,
    canonicalConfirmed = false,
  ): Promise<void> {
    // A copied receipt may say `included` based only on the secondary status
    // endpoint. That is progress evidence, not proof that execution succeeded:
    // getTxByHash can still be pending or can later report failure. Always
    // re-establish canonical terminal state before releasing the wallet lane.
    const terminal = canonicalConfirmed
      ? "included"
      : await this.waitForTerminal(txRef, ctx);
    if (terminal === "included") {
      void key;
      if (this.activeWriteRecord?.nonce !== signedNonce) {
        throw new DacsError(
          `active Demos write nonce does not match confirmed nonce ${signedNonce}`,
        );
      }
      await this.persistCanonicalWrite(ctx);
      await this.persistNativeReadback(ctx);
    } else {
      await this.putActiveWrite("canonical-failed");
    }
  }

  private async resolveInBackground(
    key: string,
    txRef: string,
    signedNonce: number,
    receipt: AnchorAttemptReceipt,
    pollMs: number,
    canonicalConfirmed = false,
    deadline?: number,
    throwOnFailure = false,
  ): Promise<void> {
    const ctx = this.recoveryContext(receipt, pollMs);
    if (deadline !== undefined) ctx.deadline = Math.min(ctx.deadline, deadline);
    try {
      await this.reconcileUntilNonceSafe(
        key,
        txRef,
        signedNonce,
        ctx,
        canonicalConfirmed,
      );
    } catch (error) {
      // The durable broadcast-intent record remains authoritative. A later
      // process must reconcile this exact hash before reserving another nonce.
      if (throwOnFailure) throw error;
    }
  }

  private async reconcilePrevious(current: AnchorContext): Promise<void> {
    const lease = this.activeWriteLease;
    if (!lease) throw new DacsError("Demos write journal lease is missing");
    try {
      await this.reconcileWalletJournal(
        lease,
        Math.max(1, current.deadline - Date.now()),
        {
          pollMs: current.pollMs,
          signal: current.signal,
          // Anchor nonce selection additionally consults the canonical journal,
          // so it need not wait for the node's address-nonce index to catch up.
          requireNonceVisibility: false,
        },
      );
    } catch (error) {
      if (error instanceof AnchorWaitError) {
        throw new AnchorWaitError(
          error.code,
          "previous wallet write is unresolved; refusing a potentially conflicting nonce",
          error.receipt,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private safeAfterUnknownBroadcast(
    key: string,
    txRef: string,
    signedNonce: number,
    broadcastPromise: Promise<unknown>,
    ctx: AnchorContext,
  ): Promise<void> {
    const controller = new AbortController();
    const recovery = this.recoveryContext(
      this.snapshot(ctx.receipt),
      ctx.pollMs,
    );
    recovery.signal = controller.signal;

    // Start status reconciliation immediately from the hash computed before
    // broadcast. It must not wait for the HTTP request to settle: the node may
    // have accepted the transaction even when the transport hangs forever.
    const reconciliation = (async () => {
      try {
        await this.reconcileUntilNonceSafe(key, txRef, signedNonce, recovery);
      } catch {
        if (controller.signal.aborted) return;
        // Keep the durable broadcast intent unresolved for takeover recovery.
      }
    })();

    const broadcastDecision = broadcastPromise
      .then((value): "reconcile" | "definitive" => {
        return isDefinitiveBroadcastRejection(value)
          ? "definitive"
          : "reconcile";
      })
      // A thrown transport error is never evidence that the request was not
      // accepted: timeouts and connection resets can happen after submission.
      // With a precomputed tx hash, fail closed and reconcile every such case.
      .catch((): "reconcile" => "reconcile");

    return Promise.race([
      reconciliation.then(() => "reconciled" as const),
      broadcastDecision,
    ]).then(async (outcome) => {
      if (outcome === "definitive") {
        controller.abort();
        await reconciliation;
        if (this.activeWriteRecord?.stage === "broadcast-intent") {
          await this.putActiveWrite("canonical-failed");
        }
        return;
      }
      if (outcome === "reconcile") await reconciliation;
    });
  }

  private async waitForVisibility(
    expected: string,
    ctx: AnchorContext,
  ): Promise<AnchorReceipt> {
    const address = ctx.receipt.address;
    if (!address) {
      throw this.fail(
        ctx,
        "prepare-failed",
        `anchor ${ctx.receipt.name} has no storage address to read`,
      );
    }
    for (;;) {
      ctx.receipt.attempts.visibilityReads += 1;
      try {
        const readBack = await this.waitFor(
          ctx,
          this.readAnchor(address),
          "read visibility",
        );
        if (readBack && sha256Hex(canonicalize(readBack)) === expected) {
          const now = Date.now();
          ctx.receipt.state = "read-visible";
          ctx.receipt.completion = "read-visible";
          ctx.receipt.timings.readVisibleAt = now;
          this.emit(ctx);
          return this.successReceipt(ctx, now);
        }
        ctx.receipt.lastObservedState =
          readBack === null ? "not-visible" : "stale-visible";
      } catch (error) {
        if (error instanceof AnchorWaitError) throw error;
        ctx.receipt.lastObservedState = "visibility-read-error";
      }
      this.emit(ctx);
      await this.delay(ctx);
    }
  }

  private async startAnchorWrite(
    key: string,
    name: string,
    data: Record<string, unknown>,
    completion: AnchorCompletion,
    expected: string | undefined,
    ctx: AnchorContext,
  ): Promise<QueuedWrite<AnchorReceipt>> {
    await this.reconcilePrevious(ctx);

    let prepared: Awaited<ReturnType<DemosAdapter["prepareAnchorPayload"]>>;
    try {
      prepared = await this.waitFor(
        ctx,
        this.prepareAnchorPayload(key, name, data),
        "owner-bound storage lookup",
      );
      ctx.receipt.address = prepared.address;
      const lease = this.activeWriteLease;
      if (!lease) throw new DacsError("Demos write journal lease is missing");
      const preparedRecord: DemosWriteJournalRecord = {
        writeId: `write-${lease.generation}`,
        generation: lease.generation,
        kind: "mutable",
        operation: prepared.operation,
        stage: "prepared",
        logicalName: name,
        programName: prepared.programName,
        owner: this.#demos.getAddress(),
        nativeAddress: prepared.address,
        valueHash: exactJsonHash(data),
        nonce: prepared.nonce,
        updatedAt: Date.now(),
      };
      this.activeWriteRecord = preparedRecord;
      await lease.put(preparedRecord);
    } catch (error) {
      if (error instanceof AnchorWaitError) throw error;
      throw this.fail(
        ctx,
        "read-failed",
        `anchor lookup failed for ${name}`,
        error,
      );
    }

    let signed: Awaited<ReturnType<Demos["storagePrograms"]["sign"]>>;
    let validity: Awaited<ReturnType<Demos["tx"]["confirm"]>>;
    try {
      signed = await this.waitFor(
        ctx,
        this.#demos.storagePrograms.sign(
          prepared.payload,
          { nonce: prepared.nonce },
        ),
        "signing",
      );
      validity = await this.waitFor(
        ctx,
        this.#demos.tx.confirm(signed, this.#demos),
        "confirmation",
      );
      await this.waitFor(
        ctx,
        this.assertConfirmedFeeWithinCap(validity),
        "confirmed fee ceiling",
      );
    } catch (error) {
      if (error instanceof AnchorWaitError) throw error;
      throw this.fail(
        ctx,
        "prepare-failed",
        `anchor preparation failed for ${prepared.address}`,
        error,
      );
    }

    const validityRecord = validity as unknown as {
      response?: { data?: { transaction?: { hash?: string } } };
    };
    const signedRecord = signed as unknown as {
      hash?: string;
      content?: { nonce?: unknown };
    };
    const signedNonceValue = signedRecord.content?.nonce;
    if (
      !Number.isSafeInteger(signedNonceValue) ||
      (signedNonceValue as number) < 0
    ) {
      throw this.fail(
        ctx,
        "prepare-failed",
        `signed anchor ${prepared.address} has no valid transaction nonce`,
      );
    }
    const signedNonce = signedNonceValue as number;
    if (signedNonce !== prepared.nonce) {
      throw this.fail(
        ctx,
        "prepare-failed",
        `signed anchor ${prepared.address} used nonce ${signedNonce}; expected ${prepared.nonce}`,
      );
    }
    const signedTxRef = signedRecord.hash;
    const confirmedTxRef = validityRecord.response?.data?.transaction?.hash;
    if (!signedTxRef) {
      throw this.fail(
        ctx,
        "prepare-failed",
        `signed anchor ${prepared.address} has no transaction hash`,
      );
    }
    if (confirmedTxRef !== undefined && confirmedTxRef !== signedTxRef) {
      throw this.fail(
        ctx,
        "prepare-failed",
        `confirmed anchor ${prepared.address} returned transaction hash ${confirmedTxRef}; expected ${signedTxRef}`,
      );
    }
    const preBroadcastTxRef = signedTxRef;
    ctx.receipt.txRef = preBroadcastTxRef;
    const signedTransaction = serializeSignedTransaction(signed);
    await this.putActiveWrite("signed", {
      txRef: preBroadcastTxRef,
      signedTransaction,
      signedTransactionHash: demosSignedTransactionProofHash(signed),
    });
    ctx.receipt.state = "broadcast-unknown";
    this.emit(ctx);

    await this.putActiveWrite("broadcast-intent");
    await this.activeWriteLease!.assertCurrent();
    const broadcastPromise = this.#demos.tx.broadcast(
      validity,
      this.#demos,
    ) as Promise<unknown>;

    // For inclusion/read visibility, the signed hash is the authoritative
    // progress handle. Poll it immediately: the transaction may be included
    // even when the broadcast HTTP response is delayed or lost.
    if (completion !== "accepted") {
      try {
        const terminal = await this.waitForTerminal(
          preBroadcastTxRef,
          ctx,
          broadcastPromise,
        );
        if (terminal === "failed") {
          await this.putActiveWrite("canonical-failed");
          return {
            result: Promise.reject(
              this.fail(
                ctx,
                "inclusion-failed",
                `anchor ${prepared.address} failed on chain`,
              ),
            ),
            safe: Promise.resolve(),
          };
        }
      } catch (error) {
        const wrapped =
          error instanceof AnchorWaitError
            ? error
            : this.fail(
                ctx,
                "inclusion-failed",
                `anchor inclusion failed for ${prepared.address}`,
                error,
              );
        if (wrapped.code === "broadcast-failed") {
          await this.putActiveWrite("canonical-failed");
        }
        return {
          result: Promise.reject(wrapped),
          safe:
            wrapped.code === "broadcast-failed"
              ? Promise.resolve()
              : this.resolveInBackground(
                  key,
                  preBroadcastTxRef,
                  signedNonce,
                  this.snapshot(ctx.receipt),
                  ctx.pollMs,
                ),
        };
      }

      await this.persistCanonicalWrite(ctx);

      if (completion === "included") {
        return {
          result: Promise.resolve(this.successReceipt(ctx)),
          safe: this.resolveInBackground(
            key,
            preBroadcastTxRef,
            signedNonce,
            this.snapshot(ctx.receipt),
            ctx.pollMs,
            true,
          ),
        };
      }

      const visibility = this.waitForVisibility(expected!, ctx);
      const evidenceLease = this.activeWriteLease!;
      const evidenceWriteId = this.activeWriteRecord!.writeId;
      const result = visibility.then(async (receipt) => {
        await this.persistNativeReadback(ctx);
        return {
          ...receipt,
          demosEvidence: this.writeEvidenceFromLease(
            evidenceLease,
            evidenceWriteId,
          ),
        };
      });
      return {
        result,
        safe: result.then(
          () => undefined,
          () => undefined,
        ),
      };
    }

    let broadcast: unknown;
    try {
      broadcast = await this.waitFor(ctx, broadcastPromise, "broadcast");
    } catch (error) {
      const wrapped =
        error instanceof AnchorWaitError
          ? error
          : this.fail(
              ctx,
              "broadcast-failed",
              `anchor broadcast failed for ${prepared.address}`,
              error,
            );
      const txRef = ctx.receipt.txRef;
      return {
        result: Promise.reject(wrapped),
        safe: txRef
          ? this.safeAfterUnknownBroadcast(
              key,
              txRef,
              signedNonce,
              broadcastPromise,
              ctx,
            )
          : broadcastPromise.then(
              () => undefined,
              () => undefined,
            ),
      };
    }

    const response = isRecord(broadcast) ? broadcast : undefined;
    const responseData = isRecord(response?.response)
      ? response.response
      : undefined;
    const responseTxRef =
      typeof responseData?.hash === "string" ? responseData.hash : undefined;
    if (responseTxRef && responseTxRef !== preBroadcastTxRef) {
      ctx.receipt.state = "broadcast-unknown";
      this.emit(ctx);
      return {
        result: Promise.reject(
          this.fail(
            ctx,
            "broadcast-failed",
            `anchor ${prepared.address} returned transaction hash ${responseTxRef}; expected ${preBroadcastTxRef}`,
            response,
          ),
        ),
        safe: this.resolveInBackground(
          key,
          preBroadcastTxRef,
          signedNonce,
          this.snapshot(ctx.receipt),
          ctx.pollMs,
        ),
      };
    }
    const txRef = preBroadcastTxRef;

    if (response?.result !== 200 || !txRef) {
      const ambiguous = Boolean(txRef) && !isDefinitiveBroadcastRejection(response);
      ctx.receipt.state = ambiguous ? "broadcast-unknown" : "failed";
      this.emit(ctx);
      const error = this.fail(
        ctx,
        "broadcast-failed",
        `anchor ${prepared.address} was not accepted by the node`,
        response,
      );
      if (!ambiguous) await this.putActiveWrite("canonical-failed");
      return {
        result: Promise.reject(error),
        safe:
          ambiguous && txRef
            ? this.resolveInBackground(
                key,
                txRef,
                signedNonce,
                this.snapshot(ctx.receipt),
                ctx.pollMs,
              )
            : Promise.resolve(),
      };
    }

    const acceptedAt = Date.now();
    ctx.receipt.state = "accepted";
    ctx.receipt.completion = "accepted";
    ctx.receipt.timings.acceptedAt = acceptedAt;
    this.emit(ctx);

    if (completion === "accepted") {
      return {
        result: Promise.resolve(this.successReceipt(ctx, acceptedAt)),
        // The caller returns now; the wallet queue remains held through
        // inclusion and authoritative account-nonce advancement.
        safe: this.resolveInBackground(
          key,
          txRef,
          signedNonce,
          this.snapshot(ctx.receipt),
          ctx.pollMs,
        ),
      };
    }

    try {
      const terminal = await this.waitForTerminal(txRef, ctx);
      if (terminal === "failed") {
        await this.putActiveWrite("canonical-failed");
        return {
          result: Promise.reject(
            this.fail(
              ctx,
              "inclusion-failed",
              `anchor ${prepared.address} failed on chain`,
            ),
          ),
          safe: Promise.resolve(),
        };
      }
    } catch (error) {
      const wrapped =
        error instanceof AnchorWaitError
          ? error
          : this.fail(
              ctx,
              "inclusion-failed",
              `anchor inclusion failed for ${prepared.address}`,
              error,
            );
      return {
        result: Promise.reject(wrapped),
        safe: this.resolveInBackground(
          key,
          txRef,
          signedNonce,
          this.snapshot(ctx.receipt),
          ctx.pollMs,
        ),
      };
    }

    await this.persistCanonicalWrite(ctx);

    if (completion === "included") {
      return {
        result: Promise.resolve(this.successReceipt(ctx)),
        safe: this.resolveInBackground(
          key,
          txRef,
          signedNonce,
          this.snapshot(ctx.receipt),
          ctx.pollMs,
          true,
        ),
      };
    }

    const visibility = this.waitForVisibility(expected!, ctx);
    const evidenceLease = this.activeWriteLease!;
    const evidenceWriteId = this.activeWriteRecord!.writeId;
    const result = visibility.then(async (receipt) => {
      await this.persistNativeReadback(ctx);
      return {
        ...receipt,
        demosEvidence: this.writeEvidenceFromLease(
          evidenceLease,
          evidenceWriteId,
        ),
      };
    });
    return {
      result,
      safe: result.then(
        () => undefined,
        () => undefined,
      ),
    };
  }

  async anchor(name: string, value: object): Promise<AnchorReceipt> {
    return this.anchorAndWait(name, value, { completion: "accepted" });
  }

  /**
   * Anchor to an explicit completion level (#57). The total timeout covers the
   * wallet queue, owner-bound lookup, nonce acquisition, signing, broadcast,
   * inclusion, and exact canonical readback. The process queue protects adapter
   * instance state while the durable chain+wallet journal serializes and fences
   * every participating process.
   */
  async anchorAndWait(
    name: string,
    value: object,
    opts?: AnchorWaitOptions,
  ): Promise<AnchorReceipt> {
    if (!this.connected) {
      throw new Error("DemosAdapter not connected — call connect() first");
    }
    const completion = opts?.completion ?? "read-visible";
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_ANCHOR_TIMEOUT_MS;
    const pollMs = opts?.pollMs ?? DEFAULT_ANCHOR_POLL_MS;
    if (
      !(["accepted", "included", "read-visible"] as unknown[]).includes(
        completion,
      )
    ) {
      throw new RangeError(`invalid anchor completion: ${String(completion)}`);
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("anchor timeoutMs must be a positive finite number");
    }
    if (!Number.isFinite(pollMs) || pollMs <= 0) {
      throw new RangeError("anchor pollMs must be a positive finite number");
    }

    const data = value as Record<string, unknown>;
    const ctx = this.newContext(name, timeoutMs, pollMs, opts);
    let expected: string | undefined;
    if (completion === "read-visible") {
      try {
        expected = sha256Hex(canonicalize(data));
      } catch (error) {
        throw this.fail(
          ctx,
          "prepare-failed",
          "anchor value is not canonicalizable JSON",
          error,
        );
      }
    }

    const key = this.walletQueueKey();
    return queueWalletWrite(
      key,
      (turn) => this.waitFor(ctx, turn, "wallet queue"),
      () => this.withWriteLease(
        () => this.startAnchorWrite(key, name, data, completion, expected, ctx),
      ),
    );
  }

  private async resolveExistingImmutable(
    name: string,
    data: Record<string, unknown>,
    owner: string,
    expectedMetadata?: Record<string, unknown>,
  ): Promise<AnchorRef | null> {
    const resolution = await this.resolveAnchorByName(name, owner);
    if (resolution.status === "indeterminate") {
      throw new SubstrateError(
        `immutable anchor ${name}: lookup was indeterminate (${resolution.reason})`,
      );
    }
    if (resolution.status === "absent") return null;

    const record =
      expectedMetadata === undefined
        ? null
        : await this.readImmutableAnchor(resolution.address);
    const existing =
      expectedMetadata === undefined
        ? await this.readAnchor(resolution.address)
        : record?.data;
    if (!existing) {
      throw new SubstrateError(
        `immutable anchor ${name}: resolved address ${resolution.address} was not readable`,
      );
    }
    if (exactJsonHash(existing) !== exactJsonHash(data)) {
      throw new DacsError(
        `immutable anchor ${name} already exists with different exact content`,
      );
    }
    if (expectedMetadata !== undefined) {
      if (!this.metadataMatches(record?.metadata ?? null, expectedMetadata)) {
        throw new DacsError(
          `immutable anchor ${name} already exists with different descriptive metadata`,
        );
      }
    }
    return { address: resolution.address };
  }

  private async readImmutableAnchor(
    address: string,
  ): Promise<{
    data: Record<string, unknown>;
    metadata: Record<string, unknown> | null;
  } | null> {
    try {
      const result = (await this.#demos.storagePrograms.read(address)) as {
        success?: boolean;
        data?: unknown;
        metadata?: unknown;
        error?: string;
        errorCode?: string;
      };
      if (result?.success === true) {
        if (!isJsonObject(result.data)) {
          throw new SubstrateError(
            `read immutable anchor ${address} returned malformed data`,
          );
        }
        if (
          result.metadata !== undefined &&
          result.metadata !== null &&
          !isJsonObject(result.metadata)
        ) {
          throw new SubstrateError(
            `read immutable anchor ${address} returned malformed metadata`,
          );
        }
        return {
          data: result.data,
          metadata: result.metadata ?? null,
        };
      }
      const marker =
        `${result?.errorCode ?? ""} ${result?.error ?? ""}`.toLowerCase();
      if (marker.includes("not_found") || marker.includes("not found")) {
        return null;
      }
      throw new SubstrateError(
        `read immutable anchor ${address} returned an indeterminate response`,
      );
    } catch (error) {
      if (httpStatus(error) === 404) return null;
      if (error instanceof SubstrateError) throw error;
      throw new SubstrateError(`read immutable anchor ${address} failed`, {
        cause: error,
      });
    }
  }

  private metadataMatches(
    actual: Record<string, unknown> | null,
    expected: Record<string, unknown>,
  ): boolean {
    try {
      return actual !== null && canonicalize(actual) === canonicalize(expected);
    } catch (error) {
      throw new SubstrateError(
        "read immutable anchor returned non-canonicalizable metadata",
        { cause: error },
      );
    }
  }

  private async waitForConcurrentImmutableWinner(
    name: string,
    data: Record<string, unknown>,
    owner: string,
    expectedMetadata: Record<string, unknown> | undefined,
    ctx: AnchorContext,
    cause: AnchorWaitError,
  ): Promise<AnchorRef> {
    let lastState = "absent";
    for (;;) {
      try {
        const winner = await this.resolveExistingImmutable(
          name,
          data,
          owner,
          expectedMetadata,
        );
        if (winner) return winner;
        lastState = "absent";
      } catch (error) {
        // A different-content winner is a definitive immutable-slot conflict.
        if (error instanceof DacsError) throw error;
        lastState = error instanceof Error ? error.message : String(error);
      }
      if (Date.now() >= ctx.deadline) {
        throw this.fail(
          ctx,
          cause.code,
          `${cause.message}; no owner-bound winner became visible before ` +
            `timeout (last state: ${lastState})`,
          cause,
        );
      }
      await sleep(ctx.pollMs);
    }
  }

  /**
   * Create-or-return an immutable StorageProgram for `name`.
   *
   * This is deliberately separate from update-capable {@link anchor}: listing
   * version slots and other immutable artifacts must never flow through an
   * update path. Existing programs are resolved by NAME and OWNER (#70), not by
   * predicting the writer's next nonce-derived address. New programs use only
   * `createStorageProgram`, wait for authenticated canonical inclusion and an
   * exact owner/provenance-bound native readback, then let the secondary name
   * index catch up asynchronously. The durable journal prevents a lagging index
   * from causing a duplicate create after restart.
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
      throw new DacsError(
        "anchorWriteOnce timeoutMs/pollMs must be non-negative",
      );
    }
    let feeBudget: Readonly<{
      budgetId: string;
      maximumPerWriteFeeOs: bigint;
      maximumTotalFeeOs: bigint;
    }> | undefined;
    if (opts?.feeBudget !== undefined) {
      const raw = opts.feeBudget;
      if (raw === null || typeof raw !== "object") {
        throw new DacsError("anchorWriteOnce aggregate fee budget is invalid");
      }
      const keys = Reflect.ownKeys(raw);
      const budgetId = Object.getOwnPropertyDescriptor(raw, "budgetId");
      const perWrite = Object.getOwnPropertyDescriptor(raw, "maximumPerWriteFeeOs");
      const maximum = Object.getOwnPropertyDescriptor(raw, "maximumTotalFeeOs");
      if (keys.length !== 3 || !keys.every((key) =>
        key === "budgetId" || key === "maximumPerWriteFeeOs" ||
          key === "maximumTotalFeeOs") ||
          budgetId === undefined || !("value" in budgetId) || !budgetId.enumerable ||
          perWrite === undefined || !("value" in perWrite) || !perWrite.enumerable ||
          maximum === undefined || !("value" in maximum) || !maximum.enumerable ||
          typeof budgetId.value !== "string" || budgetId.value.length === 0 ||
          budgetId.value.length > 256 || budgetId.value.trim() !== budgetId.value ||
          budgetId.value.includes("\0") || typeof perWrite.value !== "bigint" ||
          perWrite.value < 0n || typeof maximum.value !== "bigint" || maximum.value < 0n) {
        throw new DacsError("anchorWriteOnce aggregate fee budget is invalid");
      }
      if (perWrite.value > maximum.value) {
        throw new DacsError("anchorWriteOnce aggregate fee budget is invalid");
      }
      feeBudget = Object.freeze({
        budgetId: budgetId.value,
        maximumPerWriteFeeOs: perWrite.value,
        maximumTotalFeeOs: maximum.value,
      });
    }

    const data = value as Record<string, unknown>;
    let metadata: Record<string, unknown> | undefined;
    if (opts?.metadata !== undefined) {
      if (!isJsonObject(opts.metadata)) {
        throw new DacsError("anchorWriteOnce metadata must be a JSON object");
      }
      try {
        const pinned = JSON.parse(canonicalize(opts.metadata)) as unknown;
        if (!isJsonObject(pinned)) throw new Error("metadata is not an object");
        metadata = pinned;
      } catch (error) {
        throw new DacsError("anchorWriteOnce metadata must be canonicalizable JSON", {
          cause: error,
        });
      }
    }
    const key = this.walletQueueKey();

    // Share the same process queue as anchor()/anchorAndWait() to protect this
    // adapter's active lease/record fields. The durable chain+wallet lease is the
    // cross-process authority. Once signed, the safe point retains that lease
    // through canonical confirmation and exact native readback; the secondary
    // logical-name index is observed asynchronously.
    return queueWalletWrite(
      key,
      (turn) => turn,
      () => this.withWriteLease<AnchorRef>(async () => {
      const ctx = this.newContext(name, timeoutMs, pollMs, opts);
      await this.reconcilePrevious(ctx);
      const owner = this.#demos.getAddress();
      const programName = logicalToStorageProgramName(name);
      const metadataLogicalAddress = typeof metadata?.logicalAddress === "string" &&
          metadata.logicalAddress.length > 0 &&
          metadata.logicalAddress.trim() === metadata.logicalAddress &&
          logicalToStorageProgramName(metadata.logicalAddress) === programName
        ? metadata.logicalAddress
        : name;
      const valueHash = exactJsonHash(data);
      const metadataHash = metadata === undefined
        ? undefined
        : exactJsonHash(metadata);
      const lease = this.activeWriteLease!;
      const retained = [...lease.snapshot.records]
        .reverse()
        .find((record) =>
          record.kind === "immutable" &&
          record.programName === programName &&
          record.owner.toLowerCase() === owner.toLowerCase() &&
          (record.stage === "canonical-confirmed" ||
            record.stage === "native-visible" ||
            record.stage === "index-visible")
        );
      if (retained) {
        if (retained.owner.toLowerCase() !== owner.toLowerCase() ||
            retained.valueHash !== valueHash ||
            retained.metadataHash !== metadataHash) {
          throw new DacsError(
            `immutable anchor ${name} has a canonically confirmed create with ` +
              "different exact content or metadata",
          );
        }
        this.activeWriteRecord = {
          ...retained,
          generation: lease.generation,
        };
        const now = Date.now();
        ctx.receipt.address = retained.nativeAddress;
        ctx.receipt.txRef = retained.txRef;
        ctx.receipt.state = "included";
        ctx.receipt.completion = "included";
        ctx.receipt.timings.acceptedAt = now;
        ctx.receipt.timings.includedAt = now;
        if (retained.blockNumber !== undefined) {
          ctx.receipt.blockNumber = retained.blockNumber;
        }
        this.emit(ctx);
        this.observeIndexEventually(this.activeWriteRecord, pollMs);
        const result = Promise.resolve({
          address: retained.nativeAddress,
          ...(retained.txRef === undefined ? {} : { txRef: retained.txRef }),
          demosEvidence: this.writeEvidence(this.activeWriteRecord),
        });
        return {
          result,
          safe: result.then(
            () => undefined,
            () => undefined,
          ),
        };
      }
      const existing = await this.waitFor(
        ctx,
        this.resolveExistingImmutable(name, data, owner, metadata),
        "immutable owner-bound lookup",
      );
      if (existing) {
        return {
          result: Promise.resolve(existing),
          safe: Promise.resolve(),
        };
      }

      // Absent → CREATE ONLY. Never call the update-capable anchor() path here.
      const nonce = await this.waitFor(
        ctx,
        this.nextAnchorNonce(key),
        "immutable nonce acquisition",
      );
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
        {
          nonce,
          salt: ANCHOR_SALT,
          ...(metadata === undefined ? {} : { metadata }),
        },
      );
      ctx.receipt.address = address;
      const preparedRecord: DemosWriteJournalRecord = {
        writeId: `write-${lease.generation}`,
        generation: lease.generation,
        kind: "immutable",
        operation: "create",
        stage: "prepared",
        logicalName: metadataLogicalAddress,
        programName,
        owner,
        nativeAddress: address,
        valueHash,
        ...(metadataHash === undefined ? {} : { metadataHash }),
        nonce,
        updatedAt: Date.now(),
      };
      this.activeWriteRecord = preparedRecord;
      await lease.put(preparedRecord);
      const signed = await this.waitFor(
        ctx,
        this.#demos.storagePrograms.sign(payload, { nonce }),
        "immutable signing",
      );
      const validity = await this.waitFor(
        ctx,
        this.#demos.tx.confirm(signed, this.#demos),
        "immutable confirmation",
      );
      const confirmedFeeOs = await this.waitFor(
        ctx,
        this.assertConfirmedFeeWithinCap(validity, feeBudget !== undefined),
        "immutable confirmed fee ceiling",
      );
      const signedRecord = signed as unknown as {
        hash?: string;
        content?: { nonce?: unknown };
      };
      const signedNonceValue = signedRecord.content?.nonce;
      if (
        !Number.isSafeInteger(signedNonceValue) ||
        (signedNonceValue as number) < 0
      ) {
        throw new SubstrateError(
          `immutable anchor ${name} signed without a valid transaction nonce`,
        );
      }
      const signedNonce = signedNonceValue as number;
      if (signedNonce !== nonce) {
        throw new SubstrateError(
          `immutable anchor ${name} signed with nonce ${signedNonce}; expected ${nonce}`,
        );
      }
      const validityRecord = validity as unknown as {
        response?: { data?: { transaction?: { hash?: string } } };
      };
      const signedTxRef = signedRecord.hash;
      const confirmedTxRef = validityRecord.response?.data?.transaction?.hash;
      if (!signedTxRef) {
        throw new SubstrateError(
          `immutable anchor ${name} signed without a transaction hash`,
        );
      }
      if (confirmedTxRef !== undefined && confirmedTxRef !== signedTxRef) {
        throw new SubstrateError(
          `immutable anchor ${name} confirmation returned transaction hash ` +
            `${confirmedTxRef}; expected ${signedTxRef}`,
        );
      }
      const txRef = signedTxRef;

      ctx.receipt.txRef = txRef;
      const signedTransaction = serializeSignedTransaction(signed);
      await this.putActiveWrite("signed", {
        txRef,
        signedTransaction,
        signedTransactionHash: demosSignedTransactionProofHash(signed),
        ...(feeBudget === undefined || confirmedFeeOs === undefined
          ? {}
          : { feeBudget: this.reserveAggregateFeeBudget(feeBudget, confirmedFeeOs) }),
      });
      if (this.remaining(ctx) <= 0) {
        throw this.fail(
          ctx,
          "timeout",
          `immutable anchor ${name} timed out before broadcast`,
        );
      }
      ctx.receipt.state = "broadcast-unknown";
      await this.putActiveWrite("broadcast-intent");
      await lease.assertCurrent();
      const broadcastPromise = this.#demos.tx.broadcast(
        validity,
        this.#demos,
      ) as Promise<unknown>;

      let completionFailure: AnchorWaitError | undefined;
      const result = this.waitFor(
        ctx,
        (async (): Promise<AnchorRef> => {
          let terminal: "included" | "failed";
          try {
            terminal = await this.waitForTerminal(
              txRef,
              ctx,
              broadcastPromise,
            );
          } catch (error) {
            // A thrown submission/transport/timeout error does not prove absence.
            completionFailure =
              error instanceof AnchorWaitError
                ? error
                : this.fail(
                    ctx,
                    "inclusion-failed",
                    `immutable anchor ${name} status reconciliation failed`,
                    error,
                  );
            return this.waitForConcurrentImmutableWinner(
              name,
              data,
              owner,
              metadata,
              ctx,
              completionFailure,
            );
          }
          if (terminal !== "included") {
            completionFailure = this.fail(
              ctx,
              "inclusion-failed",
              `immutable anchor ${name} reached terminal state failed`,
              new Error(`terminal state=${terminal}`),
            );
            return this.waitForConcurrentImmutableWinner(
              name,
              data,
              owner,
              metadata,
              ctx,
              completionFailure,
            );
          }
          await this.persistCanonicalWrite(ctx);
          await this.persistNativeReadback(ctx);
          this.observeIndexEventually(this.activeWriteRecord!, pollMs);
          return {
            address,
            txRef,
            demosEvidence: this.writeEvidence(this.activeWriteRecord!),
          };
        })(),
        "immutable completion",
        () => {
          // The outer and inner waits share one deadline. On some runtimes the
          // outer timer can fire before the inner rejection assigns
          // completionFailure, so derive a specific failure from live receipt
          // state instead of falling back to the generic composite-stage name.
          if (completionFailure) {
            return this.fail(
              ctx,
              completionFailure.code,
              `${completionFailure.message}; no owner-bound winner became ` +
                "visible before timeout",
              completionFailure,
            );
          }
          return ctx.receipt.state === "included"
            ? this.fail(
                ctx,
                "timeout",
                `immutable anchor ${name} was included but authenticated ` +
                  "native readback did not complete before timeout",
              )
            : this.fail(
                ctx,
                "timeout",
                `immutable anchor ${name} timed out during inclusion`,
              );
        },
      );

      const nonceSafe = this.resolveInBackground(
        key,
        txRef,
        signedNonce,
        this.snapshot(ctx.receipt),
        pollMs,
        false,
        ctx.deadline,
      );
      const safe = Promise.all([
        nonceSafe,
        result.then(
          () => undefined,
          () => undefined,
        ),
      ]).then(() => undefined);
      return {
        result: Promise.all([result, nonceSafe]).then(([ref]) => ({
          ...ref,
          demosEvidence: this.writeEvidenceFromLease(
            lease,
            preparedRecord.writeId,
          ),
        })),
        safe,
      };
      }),
    );
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

    const owner = this.#demos.getAddress().trim().toLowerCase();
    const anchors: OwnedAnchor[] = [];
    for (const candidate of candidates) {
      if (!candidate.programName.startsWith(programPrefix)) continue;
      try {
        const result = (await this.#demos.storagePrograms.read(
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
  private async resolveAnchorFromJournal(
    name: string,
    expectedOwner: string,
  ): Promise<AnchorResolution | null> {
    const journal = this.config.writeJournal;
    const wallet = this.#demos.getAddress().toLowerCase();
    const expectedWallet = expectedOwner.toLowerCase();
    if (
      !journal ||
      !sameDemosWallet(wallet, expectedWallet)
    ) return null;

    let lease = this.activeWriteLease;
    let release = false;
    try {
      if (!lease) {
        lease = await journal.acquire({
          chainIdentity: await this.resolveChainIdentity(),
          wallet,
        });
        release = true;
      }
      const bindings = lease.snapshot.records.filter((record) =>
        record.kind !== "native-transfer" &&
        record.logicalName === name &&
        sameDemosWallet(record.owner, expectedWallet) &&
        JOURNAL_STAGE_RANK[record.stage] >= JOURNAL_STAGE_RANK["native-visible"]
      );
      if (bindings.length === 0) return null;
      const addresses = [...new Set(bindings.map((record) => record.nativeAddress))];
      if (addresses.length !== 1) {
        return {
          status: "indeterminate",
          reason: "durable journal contains conflicting native bindings",
        };
      }
      const address = addresses[0]!;
      const native = await this.#demos.storagePrograms.read(address) as unknown;
      const programName = logicalToStorageProgramName(name);
      if (
        !isRecord(native) ||
        native.success !== true ||
        native.storageAddress !== address ||
        typeof native.owner !== "string" ||
        !sameDemosWallet(native.owner, expectedWallet) ||
        native.programName !== programName
      ) {
        return {
          status: "indeterminate",
          reason: "durable native binding failed owner-bound readback",
        };
      }
      return { status: "present", address };
    } catch (error) {
      return {
        status: "indeterminate",
        reason: `durable native binding lookup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    } finally {
      if (release) await lease?.release();
    }
  }

  private async resolveAnchorByIndex(
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
        const res = (await this.#demos.storagePrograms.read(
          c.storageAddress,
        )) as {
          success?: boolean;
          owner?: string;
        };
        outcomes.push({
          address: c.storageAddress,
          owner:
            res?.success && typeof res.owner === "string" ? res.owner : null,
          error: res?.success !== true,
        });
      } catch {
        outcomes.push({ address: c.storageAddress, owner: null, error: true });
      }
    }
    return classifyAnchorResolution(outcomes, expectedOwner);
  }

  async resolveAnchorByName(
    name: string,
    expectedOwner: string,
  ): Promise<AnchorResolution> {
    // An authenticated native-visible journal binding is authoritative for the
    // owning wallet. The logical-name index remains discovery-only and may lag
    // finality by several blocks.
    const journalResolution = await this.resolveAnchorFromJournal(
      name,
      expectedOwner,
    );
    return journalResolution ?? this.resolveAnchorByIndex(name, expectedOwner);
  }

  async readAnchor(address: string): Promise<Record<string, unknown> | null> {
    try {
      const res = (await this.#demos.storagePrograms.read(address)) as {
        success?: boolean;
        data?: Record<string, unknown> | null;
        error?: string;
        errorCode?: string;
      };
      if (res?.success && res.data != null) return res.data;
      const marker =
        `${res?.errorCode ?? ""} ${res?.error ?? ""}`.toLowerCase();
      if (marker.includes("not_found") || marker.includes("not found")) {
        return null;
      }
      throw new SubstrateError(
        `read anchor ${address} returned an indeterminate response`,
      );
    } catch (error) {
      // demosdk/Axios throws on a genuine 404. Every other failure remains
      // indeterminate so callers never turn a transient RPC fault into absence.
      if (httpStatus(error) === 404) return null;
      if (error instanceof SubstrateError) throw error;
      throw new SubstrateError(`read anchor ${address} failed`, {
        cause: error,
      });
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
    const dahr = await (this.#demos as any).web2.createDahr();
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
   * identity graph (all eight production GCR contexts; parseCciRecord reads it).
   * Requires demosdk ≥ 4.0.12 — 4.0.6's auth-header path 401s against the public
   * nodes on gcr_routine (issue #20). Reverse claim-ref resolution is
   * findSubjectsByClaim below.
   */
  async resolveIdentity(ref: string): Promise<ResolvedIdentity> {
    if (!this.connected) {
      throw new Error("DemosAdapter not connected — call connect() first");
    }
    const intrinsic = parseDemosAgentClaimReference(ref);
    if (intrinsic !== null) {
      return {
        ref: intrinsic.canonicalReference,
        boundTo: intrinsic.canonicalIdentity,
        raw: {
          profile: "demos-primary-self-certifying:v1",
          publicKey: Buffer.from(intrinsic.publicKey).toString("hex"),
        },
      };
    }
    const raw = await new Identities().getIdentities(
      this.#demos,
      "getIdentities",
      ref,
    );
    // The demosdk has already decoded the RPC response at this boundary. Bound
    // it before returning it to any higher-level caller; Agent parsing applies
    // the same check again before retaining a snapshot.
    assertDemosCciResponseBounds(raw);
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
    if (parsed.kind === "web2" && parsed.platform === "domain") {
      throw new Error(
        "findSubjectsByClaim: domain reverse lookup is not exposed by the current Demos SDK",
      );
    }
    const accounts = parsed.kind === "web2"
      ? await identities.getDemosIdsByWeb2Identity(
          this.#demos,
          parsed.platform,
          parsed.handle,
        )
      : await identities.getDemosIdsByWeb3Identity(
          this.#demos,
          `${parsed.chainType}.${parsed.subchain}`,
          parsed.address,
        );
    return (accounts ?? [])
      .map((a: { pubkey?: unknown }) => a.pubkey)
      .filter((p: unknown): p is string => typeof p === "string");
  }
}

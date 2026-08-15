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
import { DacsError, SubstrateError } from "../errors.js";
import { parseClaimRef } from "../identity/index.js";
import type { AnchorReceipt as ProtocolAnchorReceipt } from "../artifacts/types.js";
import { AnchorWaitError } from "./AnchorWaitError.js";
import { createDemosHistoryPageFetcher } from "./demosHistory.js";
import {
  assertDemosWriteEvidence,
  decodeDemosAnchorReceiptProof,
  demosSignedTransactionProofHash,
  demosTransactionContentDifferencePaths,
  demosWriteEvidenceBindsReceiptContent,
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
const DEFAULT_ANCHOR_POLL_MS = 1_000;
const AMBIGUOUS_WRITE_RECOVERY_MS = 120_000;
const WRITE_ONCE_VISIBILITY_TIMEOUT_MS = 120_000;
const WRITE_ONCE_VISIBILITY_POLL_MS = 1_000;
const STORAGE_SEARCH_PAGE_SIZE = 100;
const STORAGE_SEARCH_MAX_PAGES = 100;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const exactJsonHash = (value: Record<string, unknown>): string =>
  sha256Hex(canonicalize(value));

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
  private readonly demos: Demos;
  private readonly config: DemosAdapterConfig;
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
    const genesisResult = await this.demos.getBlockByNumber(0) as unknown;
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
    const firstResult = await this.demos.getBlockByNumber(1) as unknown;
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

  private async acquireWriteLease(): Promise<DemosWriteJournalLease> {
    if (!this.config.writeJournal) {
      throw new DacsError(
        "Demos writes require a durable writeJournal; read-only adapters may omit it",
      );
    }
    return this.config.writeJournal.acquire({
      chainIdentity: await this.resolveChainIdentity(),
      wallet: this.demos.getAddress().toLowerCase(),
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

  constructor(config: DemosAdapterConfig) {
    if (!config?.rpc) {
      throw new Error("DemosAdapter requires an rpc URL");
    }
    this.config = config;
    this.demos = new Demos();
  }

  /**
   * Underlying demosdk instance — an explicitly live integration escape hatch.
   * Importing this type through `@kynesyslabs/dacs/substrate` therefore requires
   * the optional demosdk peer; pure root and verifier declarations do not.
   */
  get raw(): Demos {
    return this.demos;
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
    return createDemosHistoryPageFetcher(this.demos, expectedOwner);
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
      this.demos.getTxByHash(evidence.transactionRef),
      this.demos.getBlockByNumber(evidence.blockNumber),
      this.demos.storagePrograms.read(evidence.nativeAddress),
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
      this.demos.getTxByHash(receipt.transactionRef.value),
      this.demos.getBlockByNumber(blockNumber),
      this.demos.storagePrograms.read(receipt.nativeAddress),
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
    const { publicKey } = await (this.demos as any).crypto.getIdentity(
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
    const chainNext = (await this.demos.getAddressNonce(this.demos.getAddress())) + 1;
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
      this.demos.getAddress(),
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
    const owner = this.demos.getAddress();
    const journalBindings = (this.activeWriteLease?.snapshot.records ?? [])
      .filter((record) =>
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
            this.demos.nodeCall("getTransactionStatus", { hash: txRef }),
            this.demos.getTxByHash(txRef),
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
          this.demos.storagePrograms.read(record.nativeAddress),
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
      this.demos.getBlockByNumber(blockNumber!),
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
      operation: record.operation,
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

  private async reconcilePrevious(
    key: string,
    current: AnchorContext,
  ): Promise<void> {
    const lease = this.activeWriteLease;
    if (!lease) throw new DacsError("Demos write journal lease is missing");
    for (const prior of lease.snapshot.records) {
      if (
        prior.stage !== "broadcast-intent" &&
        prior.stage !== "canonical-confirmed"
      ) {
        continue;
      }
      if (!prior.txRef) {
        throw new DacsError(
          `Demos write journal ${prior.writeId} lacks its transaction hash`,
        );
      }
      const ctx = this.newContext(
        prior.logicalName,
        Math.max(1, current.deadline - Date.now()),
        current.pollMs,
        { signal: current.signal },
      );
      ctx.receipt.address = prior.nativeAddress;
      ctx.receipt.txRef = prior.txRef;
      if (prior.stage === "canonical-confirmed") {
        ctx.receipt.state = "included";
        ctx.receipt.completion = "included";
        if (prior.blockNumber !== undefined) {
          ctx.receipt.blockNumber = prior.blockNumber;
        }
      }
      this.activeWriteRecord = {
        ...prior,
        generation: lease.generation,
      };
      try {
        await this.reconcileUntilNonceSafe(
          key,
          prior.txRef,
          prior.nonce,
          ctx,
          prior.stage === "canonical-confirmed",
        );
      } catch (error) {
        if (error instanceof AnchorWaitError) {
          throw new AnchorWaitError(
            error.code,
            `previous anchor ${prior.txRef} is unresolved; refusing a potentially conflicting nonce`,
            error.receipt,
            { cause: error },
          );
        }
        throw error;
      } finally {
        this.activeWriteRecord = undefined;
      }
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
    await this.reconcilePrevious(key, ctx);

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
        owner: this.demos.getAddress(),
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

    let signed: Awaited<ReturnType<typeof this.demos.storagePrograms.sign>>;
    let validity: Awaited<ReturnType<typeof this.demos.tx.confirm>>;
    try {
      signed = await this.waitFor(
        ctx,
        this.demos.storagePrograms.sign(
          prepared.payload,
          { nonce: prepared.nonce },
        ),
        "signing",
      );
      validity = await this.waitFor(
        ctx,
        this.demos.tx.confirm(signed, this.demos),
        "confirmation",
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
    const broadcastPromise = this.demos.tx.broadcast(
      validity,
      this.demos,
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
      const result = (await this.demos.storagePrograms.read(address)) as {
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
      await this.reconcilePrevious(key, ctx);
      const owner = this.demos.getAddress();
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
        this.demos.storagePrograms.sign(payload, { nonce }),
        "immutable signing",
      );
      const validity = await this.waitFor(
        ctx,
        this.demos.tx.confirm(signed, this.demos),
        "immutable confirmation",
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
      const broadcastPromise = this.demos.tx.broadcast(
        validity,
        this.demos,
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
  private async resolveAnchorFromJournal(
    name: string,
    expectedOwner: string,
  ): Promise<AnchorResolution | null> {
    const journal = this.config.writeJournal;
    if (
      !journal ||
      this.demos.getAddress().toLowerCase() !== expectedOwner.toLowerCase()
    ) return null;

    let lease = this.activeWriteLease;
    let release = false;
    try {
      if (!lease) {
        lease = await journal.acquire({
          chainIdentity: await this.resolveChainIdentity(),
          wallet: this.demos.getAddress().toLowerCase(),
        });
        release = true;
      }
      const bindings = lease.snapshot.records.filter((record) =>
        record.logicalName === name &&
        record.owner.toLowerCase() === expectedOwner.toLowerCase() &&
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
      const native = await this.demos.storagePrograms.read(address) as unknown;
      const programName = logicalToStorageProgramName(name);
      if (
        !isRecord(native) ||
        native.success !== true ||
        native.storageAddress !== address ||
        typeof native.owner !== "string" ||
        native.owner.toLowerCase() !== expectedOwner.toLowerCase() ||
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
        const res = (await this.demos.storagePrograms.read(
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
      const res = (await this.demos.storagePrograms.read(address)) as {
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

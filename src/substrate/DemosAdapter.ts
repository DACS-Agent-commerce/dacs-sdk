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
import { AnchorWaitError } from "./AnchorWaitError.js";
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
const DEFAULT_ANCHOR_TIMEOUT_MS = 120_000;
const DEFAULT_ANCHOR_POLL_MS = 1_000;
const AMBIGUOUS_WRITE_RECOVERY_MS = 120_000;
const WRITE_ONCE_VISIBILITY_TIMEOUT_MS = 120_000;
const WRITE_ONCE_VISIBILITY_POLL_MS = 1_000;
const STORAGE_SEARCH_PAGE_SIZE = 100;
const STORAGE_SEARCH_MAX_PAGES = 100;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
}

interface QueuedWrite<T> {
  /** Caller-facing outcome; may settle before the nonce-safe point. */
  result: Promise<T>;
  /** Resolves only when the next same-wallet write can safely start. */
  safe: Promise<void>;
}

interface UnresolvedWrite {
  txRef: string;
  signedNonce: number;
  receipt: AnchorAttemptReceipt;
  pollMs: number;
}

// Coordinates every adapter instance in this JS process. RPC is part of the
// key so the same wallet used on different networks does not block itself.
const walletWriteTails = new Map<string, Promise<void>>();
const unresolvedWrites = new Map<string, UnresolvedWrite>();

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
    return { ...receipt, address: receipt.address };
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

  /** Race a non-cancellable demosdk call against the caller's total budget. */
  private waitFor<T>(
    ctx: AnchorContext,
    promise: Promise<T>,
    stage: string,
  ): Promise<T> {
    if (ctx.signal?.aborted) {
      return Promise.reject(
        this.fail(ctx, "cancelled", `anchor cancelled during ${stage}`),
      );
    }
    const remaining = this.remaining(ctx);
    if (remaining <= 0) {
      return Promise.reject(
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

  /** Prepare against current owner-bound state while holding the wallet queue. */
  private async prepareAnchorPayload(
    name: string,
    data: Record<string, unknown>,
  ) {
    const owner = this.demos.getAddress();
    const resolution = await this.resolveAnchorByName(name, owner);
    if (resolution.status === "indeterminate") {
      throw new SubstrateError(
        `anchor ${name}: owner-bound lookup was indeterminate (${resolution.reason})`,
      );
    }

    if (resolution.status === "present") {
      return {
        address: resolution.address,
        payload: StorageProgram.writeStorage(resolution.address, data, "json"),
      };
    }

    // A new program uses the live next account nonce and the same empty salt as
    // current Demos writes (#58 / DACS-Standard #242). This must happen inside
    // the same-wallet queue so another SDK write cannot consume the nonce first.
    const programName = logicalToStorageProgramName(name);
    const nonce = await this.nextAnchorNonce();
    const address = StorageProgram.deriveStorageAddress(
      owner,
      programName,
      nonce,
      ANCHOR_SALT,
    );
    return {
      address,
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
  ): Promise<"included" | "failed"> {
    for (;;) {
      ctx.receipt.attempts.inclusionPolls += 1;
      let status: unknown;
      try {
        status = await this.waitFor(
          ctx,
          this.demos.nodeCall("getTransactionStatus", { hash: txRef }),
          "inclusion",
        );
      } catch (error) {
        if (error instanceof AnchorWaitError) throw error;
        // Status transport errors are retryable within the original budget and
        // never trigger a rebroadcast of the already-submitted transaction.
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

      if (state === "included") {
        const now = Date.now();
        ctx.receipt.state = "included";
        ctx.receipt.completion = "included";
        ctx.receipt.timings.includedAt = now;
        if (isRecord(record) && typeof record.blockNumber === "number") {
          ctx.receipt.blockNumber = record.blockNumber;
        }
        this.emit(ctx);
        return "included";
      }
      if (state === "failed") {
        ctx.receipt.state = "failed";
        this.emit(ctx);
        return "failed";
      }

      this.emit(ctx);
      await this.delay(ctx);
    }
  }

  /**
   * Inclusion can become visible before the account read reflects the consumed
   * nonce. demosdk 4.0.13 reads that account value again when it signs the next
   * storage transaction, so releasing the wallet queue at inclusion alone can
   * sign two writes with the same nonce. Keep the queue held until the
   * authoritative account nonce has caught up with the transaction we signed.
   */
  private async waitForNonceAdvancement(
    signedNonce: number,
    ctx: AnchorContext,
  ): Promise<void> {
    for (;;) {
      let accountNonce: number;
      try {
        accountNonce = await this.waitFor(
          ctx,
          this.demos.getAddressNonce(this.demos.getAddress()),
          "account nonce advancement",
        );
      } catch (error) {
        if (error instanceof AnchorWaitError) throw error;
        ctx.receipt.lastObservedState = "account-nonce-read-error";
        this.emit(ctx);
        await this.delay(ctx);
        continue;
      }

      if (Number.isSafeInteger(accountNonce) && accountNonce >= signedNonce) {
        return;
      }
      ctx.receipt.lastObservedState =
        `account-nonce-${String(accountNonce)}-before-${signedNonce}`;
      this.emit(ctx);
      await this.delay(ctx);
    }
  }

  private async reconcileUntilNonceSafe(
    txRef: string,
    signedNonce: number,
    ctx: AnchorContext,
  ): Promise<void> {
    const terminal =
      ctx.receipt.state === "included"
        ? "included"
        : await this.waitForTerminal(txRef, ctx);
    if (terminal === "included") {
      await this.waitForNonceAdvancement(signedNonce, ctx);
    }
  }

  private async resolveInBackground(
    key: string,
    txRef: string,
    signedNonce: number,
    receipt: AnchorAttemptReceipt,
    pollMs: number,
  ): Promise<void> {
    const ctx = this.recoveryContext(receipt, pollMs);
    try {
      await this.reconcileUntilNonceSafe(txRef, signedNonce, ctx);
      unresolvedWrites.delete(key);
    } catch {
      // A later queued call must reconcile this tx hash before preparing another
      // transaction; silently reusing an ambiguous nonce is unsafe.
      unresolvedWrites.set(key, {
        txRef,
        signedNonce,
        receipt: this.snapshot(ctx.receipt),
        pollMs,
      });
    }
  }

  private async reconcilePrevious(
    key: string,
    current: AnchorContext,
  ): Promise<void> {
    const unresolved = unresolvedWrites.get(key);
    if (!unresolved) return;

    const ctx = this.recoveryContext(unresolved.receipt, unresolved.pollMs);
    ctx.deadline = current.deadline;
    ctx.signal = current.signal;
    try {
      await this.reconcileUntilNonceSafe(
        unresolved.txRef,
        unresolved.signedNonce,
        ctx,
      );
      unresolvedWrites.delete(key);
    } catch (error) {
      if (error instanceof AnchorWaitError) {
        throw new AnchorWaitError(
          error.code,
          `previous anchor ${unresolved.txRef} is unresolved; refusing a potentially conflicting nonce`,
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
        await this.reconcileUntilNonceSafe(txRef, signedNonce, recovery);
        unresolvedWrites.delete(key);
      } catch {
        if (controller.signal.aborted) return;
        unresolvedWrites.set(key, {
          txRef,
          signedNonce,
          receipt: this.snapshot(recovery.receipt),
          pollMs: recovery.pollMs,
        });
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
        this.prepareAnchorPayload(name, data),
        "owner-bound storage lookup",
      );
      ctx.receipt.address = prepared.address;
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
        this.demos.storagePrograms.sign(prepared.payload),
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
    const preBroadcastTxRef =
      validityRecord.response?.data?.transaction?.hash ?? signedRecord.hash;
    if (!preBroadcastTxRef) {
      throw this.fail(
        ctx,
        "prepare-failed",
        `confirmed anchor ${prepared.address} has no transaction hash`,
      );
    }
    ctx.receipt.txRef = preBroadcastTxRef;
    ctx.receipt.state = "broadcast-unknown";
    this.emit(ctx);

    const broadcastPromise = this.demos.tx.broadcast(
      validity,
      this.demos,
    ) as Promise<unknown>;
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
    const txRef =
      (typeof responseData?.hash === "string"
        ? responseData.hash
        : undefined) ?? ctx.receipt.txRef;
    if (txRef) ctx.receipt.txRef = txRef;

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

    if (completion === "included") {
      return {
        result: Promise.resolve(this.successReceipt(ctx)),
        safe: this.resolveInBackground(
          key,
          txRef,
          signedNonce,
          this.snapshot(ctx.receipt),
          ctx.pollMs,
        ),
      };
    }

    return {
      // Read visibility can continue independently, but same-wallet writes stay
      // queued until the account read reflects this transaction's signed nonce.
      result: this.waitForVisibility(expected!, ctx),
      safe: this.resolveInBackground(
        key,
        txRef,
        signedNonce,
        this.snapshot(ctx.receipt),
        ctx.pollMs,
      ),
    };
  }

  async anchor(name: string, value: object): Promise<AnchorReceipt> {
    return this.anchorAndWait(name, value, { completion: "accepted" });
  }

  /**
   * Anchor to an explicit completion level (#57). The total timeout covers the
   * wallet queue, owner-bound lookup, nonce acquisition, signing, broadcast,
   * inclusion, and exact canonical readback. This process coordinates all
   * adapters sharing RPC+wallet; external writers need an external wallet lease.
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
      () => this.startAnchorWrite(key, name, data, completion, expected, ctx),
    );
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
        if (resolution.status === "present" && resolution.address === address) {
          return { address, ...(txRef ? { txRef } : {}) };
        }
        if (resolution.status === "present" && resolution.address !== address) {
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
      throw new DacsError(
        "anchorWriteOnce timeoutMs/pollMs must be non-negative",
      );
    }

    const data = value as Record<string, unknown>;
    const key = this.walletQueueKey();

    // Share the same process-wide RPC+wallet queue as anchor()/anchorAndWait().
    // The immutable result remains part of the safe point so a second publisher
    // cannot race a first create whose name index is not visible yet. Once a
    // transaction is signed, nonce reconciliation runs independently so a hung
    // broadcast transport cannot hold every same-wallet write forever.
    return queueWalletWrite(key, (turn) => turn, async () => {
      const ctx = this.newContext(name, timeoutMs, pollMs);
      await this.reconcilePrevious(key, ctx);
      const owner = this.demos.getAddress();
      const existing = await this.waitFor(
        ctx,
        this.resolveExistingImmutable(name, data, owner),
        "immutable owner-bound lookup",
      );
      if (existing) {
        return {
          result: Promise.resolve(existing),
          safe: Promise.resolve(),
        };
      }

      // Absent → CREATE ONLY. Never call the update-capable anchor() path here.
      const programName = logicalToStorageProgramName(name);
      const nonce = await this.waitFor(
        ctx,
        this.nextAnchorNonce(),
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
        { nonce, salt: ANCHOR_SALT },
      );
      const deadline = ctx.deadline;
      ctx.receipt.address = address;
      const signed = await this.waitFor(
        ctx,
        this.demos.storagePrograms.sign(payload),
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
      const validityRecord = validity as unknown as {
        response?: { data?: { transaction?: { hash?: string } } };
      };
      const txRef =
        validityRecord.response?.data?.transaction?.hash ?? signedRecord.hash;
      if (!txRef) {
        throw new SubstrateError(
          `immutable anchor ${name} signed without a transaction hash`,
        );
      }

      ctx.receipt.txRef = txRef;
      if (this.remaining(ctx) <= 0) {
        throw this.fail(
          ctx,
          "timeout",
          `immutable anchor ${name} timed out before broadcast`,
        );
      }
      ctx.receipt.state = "broadcast-unknown";
      const broadcastPromise = this.demos.broadcastAndWait(validity, {
        timeoutMs: Math.max(1, this.remaining(ctx)),
        pollIntervalMs: pollMs,
      }) as Promise<{
        broadcast: { response?: { hash?: string } };
        status: { state: "included" | "failed"; blockNumber?: number };
      }>;

      const result = this.waitFor(
        ctx,
        (async (): Promise<AnchorRef> => {
          let observed: Awaited<typeof broadcastPromise>;
          try {
            observed = await this.waitFor(
              ctx,
              broadcastPromise,
              "immutable inclusion",
            );
          } catch (error) {
            // A thrown submission/transport/timeout error does not prove absence.
            return this.waitForConcurrentImmutableWinner(
              name,
              data,
              owner,
              deadline,
              pollMs,
              error,
            );
          }
          if (observed.status.state !== "included") {
            return this.waitForConcurrentImmutableWinner(
              name,
              data,
              owner,
              deadline,
              pollMs,
              new Error(`terminal state=${observed.status.state}`),
            );
          }
          return this.waitForCreatedImmutable(
            name,
            data,
            owner,
            address,
            observed.broadcast?.response?.hash ?? txRef,
            deadline,
            pollMs,
          );
        })(),
        "immutable completion",
      );

      const nonceSafe = this.resolveInBackground(
        key,
        txRef,
        signedNonce,
        this.snapshot(ctx.receipt),
        pollMs,
      );
      return {
        result,
        safe: Promise.all([
          nonceSafe,
          result.then(
            () => undefined,
            () => undefined,
          ),
        ]).then(() => undefined),
      };
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

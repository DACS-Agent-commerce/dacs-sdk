import { types as nodeTypes } from "node:util";

import { snapshotCanonicalJsonRead } from "../canonical/snapshot.js";
import { normalizeDemosNativeAddress } from "../rails/payDem.js";
import type { DemosTransferObservation } from "./paymentIntake.js";

const TX_HASH_RE = /^(?:0[xX])?([0-9a-fA-F]{64})$/;
const INTEGER_RE = /^(0|[1-9][0-9]*)$/;
const OS_PER_DEM = 1_000_000_000n;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const INCLUDED_STATE = "included";
// `getTransactionStatus` exposes the normative Demos inclusion state. The
// transaction projection returned by `getTxByHash` can label that same
// included transaction `confirmed` (and future clients may use `finalized`).
// These labels are accepted only while the independent status and confirmed
// block checks below establish inclusion; the body label is never sufficient.
const INCLUDED_TRANSACTION_BODY_STATES = new Set([
  "included",
  "confirmed",
  "finalized",
]);
const FAILED_STATES = new Set(["failed", "rejected"]);
const PENDING_STATES = new Set([
  "accepted",
  "broadcast",
  "pending",
  "processing",
  "queued",
]);
const NOT_FOUND_STATES = new Set(["not-found", "not_found", "unknown"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

type AnyMethod = (...args: never[]) => unknown;

/**
 * Capture one method without invoking caller-owned getters or proxy traps.
 * Class instances are supported: the first data property on the prototype
 * chain is bound to the original receiver. The capture happens before any
 * asynchronous observation so one transfer can never mix RPC authorities.
 */
function stableMethod<T extends AnyMethod>(
  source: unknown,
  key: string,
  label: string,
): T {
  if (
    (typeof source !== "object" && typeof source !== "function") ||
    source === null ||
    nodeTypes.isProxy(source)
  ) {
    throw new TypeError(`${label} must be a stable method`);
  }
  let cursor: object | null = source;
  while (cursor !== null) {
    if (nodeTypes.isProxy(cursor)) {
      throw new TypeError(`${label} must be a stable method`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
    if (descriptor) {
      if (
        !("value" in descriptor) ||
        typeof descriptor.value !== "function" ||
        nodeTypes.isProxy(descriptor.value)
      ) {
        throw new TypeError(`${label} must be a stable method`);
      }
      return descriptor.value.bind(source) as T;
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  throw new TypeError(`${label} must be a stable method`);
}

function stableDataProperty(
  source: unknown,
  key: string,
  label: string,
): { found: boolean; value?: unknown } {
  if (
    (typeof source !== "object" && typeof source !== "function") ||
    source === null ||
    nodeTypes.isProxy(source)
  ) {
    throw new TypeError(`${label} must be stable data`);
  }
  let cursor: object | null = source;
  while (cursor !== null) {
    if (nodeTypes.isProxy(cursor)) {
      throw new TypeError(`${label} must be stable data`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
    if (descriptor) {
      if (!("value" in descriptor)) {
        throw new TypeError(`${label} must be stable data`);
      }
      return { found: true, value: descriptor.value };
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  return { found: false };
}

function unwrapNodeResponse(value: unknown):
  | { status: "ok"; value: unknown }
  | { status: "unavailable" } {
  if (!isRecord(value) ||
      !Object.prototype.hasOwnProperty.call(value, "response")) {
    return { status: "ok", value };
  }
  if (Object.prototype.hasOwnProperty.call(value, "result") &&
      value.result !== 200) {
    return { status: "unavailable" };
  }
  return { status: "ok", value: value.response };
}

function canonicalTxHash(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(TX_HASH_RE);
  return match ? match[1]!.toLowerCase() : null;
}

function safeUint(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 &&
      !Object.is(value, -0)
    ? value
    : null;
}

function positiveIntegerString(value: string): string | null {
  if (!INTEGER_RE.test(value)) return null;
  try {
    const amount = BigInt(value);
    return amount > 0n ? amount.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Reconcile the transaction projection with the native-send payload without
 * guessing across the Demos denomination fork.
 *
 * The native payload is the operation the chain executed. Its historical
 * encoding disambiguates the unit: a legacy numeric payload is DEM, while the
 * post-fork canonical string payload is already integer OS. Current nodes can
 * nevertheless project post-fork `content.amount` as a JSON number. In that
 * mixed shape the number is OS and must exactly equal the string payload; it
 * must never be multiplied by OS_PER_DEM.
 */
function transactionAmountToOs(
  projectedAmount: unknown,
  payloadAmount: unknown,
): string | null {
  if (typeof payloadAmount === "string") {
    const payloadOs = positiveIntegerString(payloadAmount);
    if (!payloadOs) return null;

    const projectedOs = typeof projectedAmount === "string"
      ? positiveIntegerString(projectedAmount)
      : typeof projectedAmount === "number" &&
          Number.isSafeInteger(projectedAmount) && projectedAmount > 0
      ? BigInt(projectedAmount).toString()
      : null;
    return projectedOs === payloadOs ? payloadOs : null;
  }

  if (typeof payloadAmount !== "number" ||
      !Number.isSafeInteger(payloadAmount) || payloadAmount <= 0 ||
      typeof projectedAmount !== "number" ||
      !Number.isSafeInteger(projectedAmount) || projectedAmount <= 0 ||
      projectedAmount !== payloadAmount) {
    return null;
  }
  return (BigInt(payloadAmount) * OS_PER_DEM).toString();
}

function blockTimestampToMilliseconds(value: unknown): number | null {
  const timestamp = safeUint(value);
  if (timestamp === null) return null;
  // Current Demos blocks use Unix seconds. Accept an already-millisecond
  // timestamp for forward compatibility, while keeping all DACS time values in
  // Unix milliseconds, matching DACS-4 §9.7 observedAt/finalityObservedAt.
  const milliseconds = timestamp < 1_000_000_000_000
    ? timestamp * 1_000
    : timestamp;
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

/**
 * Read-only Demos facts required by the DACS-4 §9.5.9 seller payment gate.
 * Implementations MUST return authenticated node responses or fail closed.
 */
export interface PayDemObservationClient {
  getTransactionStatus(txHash: string): Promise<unknown>;
  getTxByHash(txHash: string): Promise<unknown>;
  getBlockByNumber(blockNumber: number): Promise<unknown>;
}

export interface PayDemSellerObserver {
  observeDemosTransfer(txHash: string): Promise<DemosTransferObservation>;
}

export interface PayDemSellerObserverConfig {
  /** Demos node RPC URL used for read-only settlement observation. */
  rpc: string;
  /** Request timeout in milliseconds (default 15 seconds). */
  timeoutMs?: number;
  /** Maximum decoded JSON response bytes (default 64 MiB). */
  maxResponseBytes?: number;
  /** Override fetch for tests or a caller-owned authenticated transport. */
  fetchImpl?: typeof fetch;
}

function invalid(reason: string): DemosTransferObservation {
  return { status: "invalid", reason };
}

/**
 * Resolve a native DEM transfer into the exact operational facts consumed by
 * the DACS-4 §9.5.9 seller intake gate.
 *
 * The transaction status, transaction body, and confirmed block must agree on
 * one hash and block height. The consensus block timestamp is authoritative;
 * the transaction's caller-selected timestamp is never used for deadlines.
 */
export async function observePayDemTransferCore(
  txHash: string,
  client: PayDemObservationClient,
): Promise<DemosTransferObservation> {
  const requestedHash = canonicalTxHash(txHash);
  if (!requestedHash) return invalid("transaction hash is not 32-byte hex");

  let getTransactionStatus: PayDemObservationClient["getTransactionStatus"];
  let getTxByHash: PayDemObservationClient["getTxByHash"];
  let getBlockByNumber: PayDemObservationClient["getBlockByNumber"];
  try {
    // Capture every authority method together, before the first await. Reading
    // methods after the status response would allow a mutable client to splice
    // a fabricated transaction/body view into an otherwise trusted status read.
    getTransactionStatus = stableMethod(
      client,
      "getTransactionStatus",
      "pay-DEM observation getTransactionStatus",
    );
    getTxByHash = stableMethod(
      client,
      "getTxByHash",
      "pay-DEM observation getTxByHash",
    );
    getBlockByNumber = stableMethod(
      client,
      "getBlockByNumber",
      "pay-DEM observation getBlockByNumber",
    );
  } catch {
    return { status: "unavailable", reason: "transaction observation client is unstable" };
  }

  let statusValue: unknown;
  try {
    statusValue = snapshotCanonicalJsonRead(
      await getTransactionStatus(requestedHash),
      "pay-DEM transaction status",
    );
  } catch {
    return { status: "unavailable", reason: "transaction status read failed" };
  }
  const statusResponse = unwrapNodeResponse(statusValue);
  if (statusResponse.status === "unavailable") {
    return { status: "unavailable", reason: "transaction status read failed" };
  }
  const status = statusResponse.value;
  if (!isRecord(status) || typeof status.state !== "string") {
    return { status: "unavailable", reason: "transaction status response is malformed" };
  }
  const state = status.state.toLowerCase();
  if (FAILED_STATES.has(state)) {
    return { status: "failed", reason: `transaction state is ${state}` };
  }
  if (NOT_FOUND_STATES.has(state)) {
    return { status: "not-found", reason: `transaction state is ${state}` };
  }
  if (PENDING_STATES.has(state)) {
    return { status: "pending", reason: `transaction state is ${state}` };
  }
  if (state !== INCLUDED_STATE) {
    return { status: "unavailable", reason: `unsupported transaction state ${state}` };
  }
  const statusBlockNumber = safeUint(status.blockNumber);
  if (statusBlockNumber === null) {
    return {
      status: "unavailable",
      reason: "included transaction status has no valid block number",
    };
  }

  let transactionValue: unknown;
  let blockValue: unknown;
  try {
    const [rawTransaction, rawBlock] = await Promise.all([
      getTxByHash(requestedHash),
      getBlockByNumber(statusBlockNumber),
    ]);
    transactionValue = snapshotCanonicalJsonRead(
      rawTransaction,
      "pay-DEM transaction body",
    );
    blockValue = snapshotCanonicalJsonRead(
      rawBlock,
      "pay-DEM inclusion block",
    );
  } catch {
    return { status: "unavailable", reason: "included transaction facts are unavailable" };
  }
  const transactionResponse = unwrapNodeResponse(transactionValue);
  const blockResponse = unwrapNodeResponse(blockValue);
  if (transactionResponse.status === "unavailable" ||
      blockResponse.status === "unavailable") {
    return { status: "unavailable", reason: "included transaction facts are unavailable" };
  }
  const transaction = transactionResponse.value;
  const block = blockResponse.value;
  if (transaction === null || transaction === undefined ||
      block === null || block === undefined) {
    return { status: "unavailable", reason: "included transaction facts are unavailable" };
  }
  if (!isRecord(transaction) || !isRecord(transaction.content)) {
    return invalid("included transaction body is malformed");
  }
  if (!isRecord(block) || !isRecord(block.content)) {
    return invalid("inclusion block is malformed");
  }

  if (canonicalTxHash(transaction.hash) !== requestedHash) {
    return invalid("transaction hash does not match the requested hash");
  }
  if (typeof transaction.status !== "string" ||
      !INCLUDED_TRANSACTION_BODY_STATES.has(transaction.status.toLowerCase())) {
    return invalid("transaction body does not represent included finality");
  }
  const transactionBlockNumber = safeUint(transaction.blockNumber);
  if (transactionBlockNumber !== statusBlockNumber) {
    return invalid("transaction and status block numbers do not match");
  }
  const blockNumber = safeUint(block.number);
  if (blockNumber !== statusBlockNumber || block.status !== "confirmed") {
    return invalid("transaction is not present in the expected confirmed block");
  }
  if (!Array.isArray(block.content.ordered_transactions) ||
      !block.content.ordered_transactions.some(
        (value) => canonicalTxHash(value) === requestedHash,
      )) {
    return invalid("confirmed block does not contain the transaction hash");
  }

  const content = transaction.content;
  if (content.type !== "native" || !Array.isArray(content.data) ||
      content.data.length !== 2 || content.data[0] !== "native" ||
      !isRecord(content.data[1])) {
    return invalid("transaction is not a native DEM transfer");
  }
  const native = content.data[1];
  if (native.nativeOperation !== "send" || !Array.isArray(native.args) ||
      native.args.length !== 2) {
    return invalid("native transaction is not a send operation");
  }

  // Demos applies the account nonce, native debit and gas edits to the
  // ed25519 owner address. `content.from` is the active signing key and can
  // legitimately differ under alternate/dual-signing modes. Prefer the owner
  // field whenever it is present; a malformed present owner fails closed
  // instead of silently falling back to a different signer identity.
  const payerSource = content.from_ed25519_address === undefined
    ? content.from
    : content.from_ed25519_address;
  const payer = typeof payerSource === "string"
    ? normalizeDemosNativeAddress(payerSource)
    : null;
  const payee = typeof content.to === "string"
    ? normalizeDemosNativeAddress(content.to)
    : null;
  const payloadPayee = typeof native.args[0] === "string"
    ? normalizeDemosNativeAddress(native.args[0])
    : null;
  if (!payer || !payee || !payloadPayee || payloadPayee !== payee) {
    return invalid("native transfer parties are malformed or inconsistent");
  }

  const amountOs = transactionAmountToOs(content.amount, native.args[1]);
  if (!amountOs) {
    return invalid("native transfer amounts are malformed or inconsistent");
  }
  const includedAt = blockTimestampToMilliseconds(block.content.timestamp);
  if (includedAt === null) {
    return invalid("confirmed block timestamp is malformed");
  }

  return {
    status: "included",
    txHash: requestedHash,
    payer,
    payee,
    amountOs,
    blockNumber: statusBlockNumber,
    includedAt,
  };
}

function validTimeout(value: number | undefined): number {
  if (value === undefined) return 15_000;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("pay-DEM observer timeoutMs must be a positive integer");
  }
  return value;
}

function validMaxResponseBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(
      "pay-DEM observer maxResponseBytes must be a positive integer",
    );
  }
  return value;
}

/** Decode JSON with a hard post-decompression byte limit. */
async function readBoundedJson(
  response: Response,
  maxResponseBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!INTEGER_RE.test(contentLength) ||
        BigInt(contentLength) > BigInt(maxResponseBytes)) {
      const error = new Error("Demos RPC response exceeds maxResponseBytes");
      // A response can already be available even when an injected fetch does
      // not associate its body with the request AbortSignal. Cancel it here,
      // before a reader is acquired, so a rejected declaration cannot leave
      // an unbounded producer running in the background.
      if (response.body !== null) {
        void response.body.cancel(error).catch(() => undefined);
      }
      throw error;
    }
  }
  if (response.body === null) {
    throw new Error("Demos RPC returned an empty response body");
  }

  const reader = response.body.getReader();
  const cancelReader = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", cancelReader, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let decoded = "";
  let bytesRead = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytesRead += item.value.byteLength;
      if (bytesRead > maxResponseBytes) {
        throw new Error("Demos RPC response exceeds maxResponseBytes");
      }
      decoded += decoder.decode(item.value, { stream: true });
    }
    decoded += decoder.decode();
    return JSON.parse(decoded) as unknown;
  } catch (cause) {
    // Do not rely on nodeCall's later controller.abort(): this reader removes
    // its abort listener and releases its lock in finally. Cancel while the
    // reader still owns the stream so size, UTF-8, and JSON failures cannot
    // leak a late body producer.
    void reader.cancel(cause).catch(() => undefined);
    throw cause;
  } finally {
    signal.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
}

/**
 * Create the standard read-only Demos RPC observer used by seller payment
 * intake. This validates one node's mutually-consistent confirmed-block view;
 * it is not an independent validator-quorum proof verifier.
 */
export function createPayDemSellerObserver(
  config: PayDemSellerObserverConfig,
): PayDemSellerObserver {
  const rpcProperty = stableDataProperty(
    config,
    "rpc",
    "pay-DEM seller observer rpc",
  );
  const timeoutProperty = stableDataProperty(
    config,
    "timeoutMs",
    "pay-DEM seller observer timeoutMs",
  );
  const maxResponseBytesProperty = stableDataProperty(
    config,
    "maxResponseBytes",
    "pay-DEM seller observer maxResponseBytes",
  );
  const fetchProperty = stableDataProperty(
    config,
    "fetchImpl",
    "pay-DEM seller observer fetchImpl",
  );
  const rpc = rpcProperty.value;
  if (!rpcProperty.found || !rpc || typeof rpc !== "string") {
    throw new TypeError("pay-DEM seller observer requires an RPC URL");
  }
  const timeoutMs = validTimeout(
    timeoutProperty.found ? timeoutProperty.value as number | undefined : undefined,
  );
  const maxResponseBytes = validMaxResponseBytes(
    maxResponseBytesProperty.found
      ? maxResponseBytesProperty.value as number | undefined
      : undefined,
  );
  const fetchImpl = fetchProperty.found && fetchProperty.value !== undefined
    ? fetchProperty.value
    : fetch;
  if (typeof fetchImpl !== "function" || nodeTypes.isProxy(fetchImpl)) {
    throw new TypeError("pay-DEM seller observer fetchImpl must be a stable function");
  }

  const nodeCall = async (message: string, data: Record<string, unknown>) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`Demos RPC ${message} timed out`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(rpc, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              method: "nodeCall",
              params: [{ message, data }],
            }),
            signal: controller.signal,
          });
          if (!response.ok) {
            throw new Error(`Demos RPC returned HTTP ${response.status}`);
          }
          const payload = await readBoundedJson(
            response,
            maxResponseBytes,
            controller.signal,
          );
          if (!isRecord(payload) || payload.result !== 200 ||
              !Object.prototype.hasOwnProperty.call(payload, "response")) {
            throw new Error("Demos RPC returned a malformed response");
          }
          return payload.response;
        })(),
        timedOut,
      ]);
    } finally {
      clearTimeout(timer!);
      // Also cancel an oversized, malformed, or otherwise abandoned body.
      controller.abort();
    }
  };

  const client: PayDemObservationClient = {
    getTransactionStatus: (hash) =>
      nodeCall("getTransactionStatus", { hash }),
    getTxByHash: (hash) => nodeCall("getTxByHash", { hash }),
    getBlockByNumber: (blockNumber) =>
      nodeCall("getBlockByNumber", { blockNumber }),
  };

  return {
    observeDemosTransfer: (hash) => observePayDemTransferCore(hash, client),
  };
}

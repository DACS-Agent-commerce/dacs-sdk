import { DacsError, SubstrateError, TransientError } from "../errors.js";
import { DEMOS_CCI_RESPONSE_LIMITS } from "../identity/cci.js";

/** Default and hard maximum for one raw GCR identity response (2 MiB). */
export const DEMOS_CCI_MAX_RESPONSE_BYTES = DEMOS_CCI_RESPONSE_LIMITS.maxEncodedBytes;
export const DEMOS_CCI_DEFAULT_TIMEOUT_MS = 5_000;
// Below dacs-node's 15 s peer request timeout, which covers inbound identity reads.
export const DEMOS_CCI_DEFAULT_TOTAL_TIMEOUT_MS = 12_000;
// Match demosdk 4.0.16's connection/status lists, with a smaller retry budget.
const RETRYABLE_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND"]);
// Fetch reports a clean close before any response as UND_ERR_SOCKET, where
// demosdk's Axios saw ECONNRESET. The same code mid-body is not retried.
const FETCH_CONNECT_CODES = new Set(["UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const MAX_RETRY_WAIT_MS = 2_000;
const OVERALL_SLACK_MS = 2_750;
const TIMED_OUT = "Demos GCR identity read timed out";
const TRANSPORT_FAILED = "Demos GCR identity read failed after transient transport errors";

// Only sanitized failures cross attempt boundaries: never retain a Response,
// response text or a transport cause while waiting to retry.
class RetryableFailure {
  constructor(readonly error: TransientError, readonly waitMs: number) {}
}

// Accept only delay-seconds or an exact IMF-fixdate. toUTCString() emits
// IMF-fixdate, so the round trip rejects everything Date.parse merely tolerates.
function retryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const date = Date.parse(value);
  if (Number.isNaN(date) || new Date(date).toUTCString() !== value) return undefined;
  return date - Date.now();
}

function retryWait(retryAfter: string | null, backoffMs: number): number {
  const requested = retryAfterMs(retryAfter);
  return requested === undefined ? backoffMs
    : Math.max(backoffMs, Math.min(requested, MAX_RETRY_WAIT_MS));
}

function connectionFailure(
  error: unknown,
  responseStarted: boolean,
): "retry" | "final" | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && RETRYABLE_CODES.has(code)) return "retry";
  if (!(error instanceof TypeError)) return undefined;
  const causeCode = (error as { cause?: { code?: unknown } }).cause?.code;
  if (typeof causeCode !== "string") return undefined;
  if (RETRYABLE_CODES.has(causeCode)) return "retry";
  if (FETCH_CONNECT_CODES.has(causeCode)) return responseStarted ? "final" : "retry";
  return undefined;
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function responseTooLarge(): DacsError {
  return new DacsError("Demos GCR identity response exceeds maxResponseBytes");
}

// Follow x402Outbound's bounded-read pattern: check declared length, then
// count and own each streamed chunk before retaining it. Never call json().
async function consumeBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^[0-9]+$/.test(contentLength) &&
      BigInt(contentLength) > BigInt(maxBytes)) {
    void response.body?.cancel().catch(() => undefined);
    throw responseTooLarge();
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      const prospectiveTotal = total + next.value.byteLength;
      if (prospectiveTotal > maxBytes) throw responseTooLarge();
      chunks.push(Uint8Array.from(next.value));
      total = prospectiveTotal;
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return combined;
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    chunks.length = 0;
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

/** One fresh, bounded attempt, including time-bound header construction. */
async function readAttempt(
  rpc: string,
  address: string,
  buildHeaders: () => Promise<Record<string, string>>,
  transport: typeof fetch,
  maxBytes: number,
  timeoutMs: number,
  overallSignal: AbortSignal,
  backoffMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timeoutError = new TransientError(TIMED_OUT);
  let rejectDeadline: ((reason: unknown) => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const abort = (reason: unknown) => {
    controller.abort(reason);
    rejectDeadline?.(reason);
  };
  const overallAbort = () => abort(overallSignal.reason);
  const timer = setTimeout(() => abort(timeoutError), timeoutMs);
  if (overallSignal.aborted) overallAbort();
  else overallSignal.addEventListener("abort", overallAbort, { once: true });
  let responseStarted = false;
  try {
    const operation = async (): Promise<unknown> => {
      const headers = await buildHeaders();
      controller.signal.throwIfAborted();
      const response = await transport(rpc, {
        method: "POST",
        headers,
        redirect: "error",
        signal: controller.signal,
        body: JSON.stringify({
          method: "gcr_routine",
          params: [{ method: "getIdentities", params: [address] }],
        }),
      });
      responseStarted = true;
      if (controller.signal.aborted) {
        // An injected transport may resolve after ignoring abort. Dispose of
        // that late body without reading or decoding it.
        void response.body?.cancel().catch(() => undefined);
        throw controller.signal.reason;
      }
      if (response.redirected || response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => undefined);
        throw new DacsError("Demos GCR identity response redirect refused");
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        if (RETRYABLE_STATUSES.has(response.status)) {
          throw new RetryableFailure(
            new TransientError(TRANSPORT_FAILED),
            retryWait(response.headers.get("retry-after"), backoffMs),
          );
        }
        throw new SubstrateError(`Demos GCR identity read failed with HTTP ${response.status}`);
      }
      const bytes = await consumeBoundedBody(response, maxBytes, controller.signal);
      controller.signal.throwIfAborted();
      try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
      } catch {
        throw new DacsError("Demos GCR identity response is not valid UTF-8 JSON");
      }
    };
    return await Promise.race([operation(), deadline]);
  } catch (error) {
    if (overallSignal.aborted) throw overallSignal.reason;
    if (controller.signal.aborted) throw new RetryableFailure(timeoutError, backoffMs);
    const connection = connectionFailure(error, responseStarted);
    if (connection !== undefined) {
      // Never surface the raw TypeError or its cause: they hold socket addresses.
      controller.abort();
      const sanitized = new TransientError(TRANSPORT_FAILED);
      if (connection === "final") throw sanitized;
      throw new RetryableFailure(sanitized, backoffMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    overallSignal.removeEventListener("abort", overallAbort);
    rejectDeadline = undefined;
  }
}

/**
 * Equivalent to demosdk's Identities.getIdentities request, with raw admission.
 * The lookup ends within min(3 × timeoutMs + 2,750 ms, totalTimeoutMs): the
 * overall deadline aborts an active attempt or wait.
 */
export async function readDemosCciResponse(
  rpc: string,
  address: string,
  buildHeaders: () => Promise<Record<string, string>>,
  transport: typeof fetch,
  maxBytes: number,
  timeoutMs: number,
  totalTimeoutMs: number,
): Promise<unknown> {
  const budgetMs = Math.min(3 * timeoutMs + OVERALL_SLACK_MS, totalTimeoutMs);
  const deadline = Date.now() + budgetMs;
  const overall = new AbortController();
  const timer = setTimeout(() => {
    overall.abort(new TransientError(TIMED_OUT));
  }, budgetMs);
  try {
    for (let attempt = 0; ; attempt++) {
      overall.signal.throwIfAborted();
      try {
        return await readAttempt(
          rpc, address, buildHeaders, transport, maxBytes, timeoutMs,
          overall.signal, 250 * 2 ** attempt,
        );
      } catch (error) {
        if (!(error instanceof RetryableFailure)) throw error;
        if (attempt === 2) throw error.error;
        // A wait that leaves the next attempt no time would only delay failure.
        if (Date.now() + error.waitMs >= deadline) throw error.error;
        await waitForRetry(error.waitMs, overall.signal);
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

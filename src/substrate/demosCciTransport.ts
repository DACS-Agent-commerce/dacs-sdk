import { DacsError, SubstrateError, TransientError } from "../errors.js";
import { DEMOS_CCI_RESPONSE_LIMITS } from "../identity/cci.js";

/** Default and hard maximum for one raw GCR identity response (2 MiB). */
export const DEMOS_CCI_MAX_RESPONSE_BYTES = DEMOS_CCI_RESPONSE_LIMITS.maxEncodedBytes;
export const DEMOS_CCI_DEFAULT_TIMEOUT_MS = 5_000;
// Below dacs-node's 15 s peer request timeout, for custom inbound resolvers that
// call resolveIdentity(); the built-in resolvers answer agent DIDs locally.
export const DEMOS_CCI_DEFAULT_TOTAL_TIMEOUT_MS = 12_000;
// Match demosdk 4.0.16's connection/status lists, with a smaller retry budget.
const RETRYABLE_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND"]);
// Fetch reports a clean close before any response as UND_ERR_SOCKET, where
// demosdk's Axios saw ECONNRESET. No connection failure mid-body is retried.
const FETCH_CONNECT_CODES = new Set(["UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const MAX_RETRY_WAIT_MS = 2_000;
const OVERALL_SLACK_MS = 2_750;
const TIMED_OUT = "Demos GCR identity read timed out";
const TRANSPORT_FAILED = "Demos GCR identity read failed after transient transport errors";
const READ_FAILED = "Demos GCR identity read failed";

// Only sanitized failures cross attempt boundaries: never retain a Response,
// response text or a transport cause while waiting to retry.
class RetryableFailure {
  constructor(readonly error: TransientError, readonly waitMs: number) {}
}

const MONTH = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
const TIME_OF_DAY = "(\\d{2}:\\d{2}:\\d{2})";
const RFC850_DATE = new RegExp(
  `^(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day, (\\d{2})-${MONTH}-(\\d{2}) ${TIME_OF_DAY} GMT$`,
);
const ASCTIME_DATE = new RegExp(
  `^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) ${MONTH} (\\d{2}| \\d) ${TIME_OF_DAY} (\\d{4})$`,
);

// RFC 9110 §5.6.7: recipients accept IMF-fixdate and both obsolete HTTP-date
// forms. Rewrite an obsolete form as IMF-fixdate; anything else is unchanged.
function asImfFixdate(value: string, nowMs: number): string {
  const rfc850 = RFC850_DATE.exec(value);
  if (rfc850 !== null) {
    const [, weekday, day, month, yy, time] = rfc850;
    // A two-digit year more than 50 years ahead is in the previous century.
    const latest = new Date(nowMs).getUTCFullYear() + 50;
    const year = latest - (latest - Number(yy)) % 100;
    return `${weekday!.slice(0, 3)}, ${day} ${month} ${year} ${time} GMT`;
  }
  const asctime = ASCTIME_DATE.exec(value);
  if (asctime !== null) {
    const [, weekday, month, day, time, year] = asctime;
    return `${weekday}, ${day!.trim().padStart(2, "0")} ${month} ${year} ${time} GMT`;
  }
  return value;
}

// Accept only delay-seconds or an HTTP-date. toUTCString() emits IMF-fixdate,
// so the round trip rejects impossible dates, wrong weekdays and everything
// Date.parse merely tolerates.
function retryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const nowMs = Date.now();
  const fixdate = asImfFixdate(value, nowMs);
  const date = Date.parse(fixdate);
  if (Number.isNaN(date) || new Date(date).toUTCString() !== fixdate) return undefined;
  return date - nowMs;
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
  const causeCode = error instanceof TypeError
    ? (error as { cause?: { code?: unknown } }).cause?.code
    : undefined;
  // Once a response has started, retrying would download another body.
  if (responseStarted) {
    return isConnectionCode(code) || isConnectionCode(causeCode) ? "final" : undefined;
  }
  if (typeof code === "string" && RETRYABLE_CODES.has(code)) return "retry";
  return isConnectionCode(causeCode) ? "retry" : undefined;
}

function isConnectionCode(code: unknown): boolean {
  return typeof code === "string" && (RETRYABLE_CODES.has(code) || FETCH_CONNECT_CODES.has(code));
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

interface RpcEndpoint {
  url: string;
  authorization?: string;
}

function decodeCredential(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Fetch rejects a URL that carries credentials; demosdk's Axios transport sends
// them as Basic authentication. Do the same: strip them from the URL and send
// the percent-decoded user:password, as Axios 1.x does. An unparseable URL is
// left for the transport to reject.
function rpcEndpoint(rpc: string): RpcEndpoint {
  let url: URL;
  try {
    url = new URL(rpc);
  } catch {
    return { url: rpc };
  }
  if (url.username === "" && url.password === "") return { url: rpc };
  const credentials = `${decodeCredential(url.username)}:${decodeCredential(url.password)}`;
  url.username = "";
  url.password = "";
  return { url: url.href, authorization: `Basic ${Buffer.from(credentials).toString("base64")}` };
}

const DEFAULT_PORTS: Readonly<Record<string, number>> = { "http:": 80, "https:": 443 };

/**
 * True when demosdk's Axios transport would reach `rpc` through a proxy named
 * in the environment (proxy-from-env 2.x rules: `<scheme>_proxy`, `all_proxy`,
 * `no_proxy`) but Node's global fetch would connect directly, because neither
 * NODE_USE_ENV_PROXY=1 nor --use-env-proxy is set.
 */
export function fetchIgnoresEnvironmentProxy(
  rpc: string,
  env: NodeJS.ProcessEnv = process.env,
  execArgv: readonly string[] = process.execArgv,
): boolean {
  const flag = "--use-env-proxy";
  if (env.NODE_USE_ENV_PROXY === "1" || execArgv.includes(flag) ||
      (env.NODE_OPTIONS ?? "").split(/\s+/).includes(flag)) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(rpc);
  } catch {
    return false;
  }
  const read = (name: string) => env[name] || env[name.toUpperCase()] || "";
  if (!read(`${url.protocol.slice(0, -1)}_proxy`) && !read("all_proxy")) return false;
  const noProxy = read("no_proxy").toLowerCase();
  if (noProxy === "*") return false;
  const port = Number(url.port) || DEFAULT_PORTS[url.protocol] || 0;
  return noProxy.split(/[,\s]/).every((entry) => {
    if (entry === "") return true;
    const withPort = /^(.+):(\d+)$/.exec(entry);
    const host = withPort?.[1] ?? entry;
    if (withPort !== null && Number(withPort[2]) !== port) return true;
    if (!/^[.*]/.test(host)) return url.hostname !== host;
    return !url.hostname.endsWith(host.startsWith("*") ? host.slice(1) : host);
  });
}

/** One fresh, bounded attempt, including time-bound header construction. */
async function readAttempt(
  endpoint: RpcEndpoint,
  address: string,
  buildHeaders: () => Promise<Record<string, string>>,
  transport: typeof fetch,
  maxBytes: number,
  timeoutMs: number,
  overallSignal: AbortSignal,
  expired: () => boolean,
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
  // Signing failures are local and pass through; "send" and "read" failures
  // come from the node's connection and are never surfaced raw.
  let phase: "sign" | "send" | "read" = "sign";
  try {
    const operation = async (): Promise<unknown> => {
      const headers = await buildHeaders();
      if (expired()) throw overallSignal.reason;
      controller.signal.throwIfAborted();
      phase = "send";
      const response = await transport(endpoint.url, {
        method: "POST",
        headers: endpoint.authorization === undefined
          ? headers : { ...headers, Authorization: endpoint.authorization },
        // "error" would turn a redirect into an anonymous network error; with
        // "manual" the 3xx check below refuses it with a stable DacsError.
        redirect: "manual",
        signal: controller.signal,
        body: JSON.stringify({
          method: "gcr_routine",
          params: [{ method: "getIdentities", params: [address] }],
        }),
      });
      phase = "read";
      if (controller.signal.aborted) {
        // An injected transport may resolve after ignoring abort. Dispose of
        // that late body without reading or decoding it.
        void response.body?.cancel().catch(() => undefined);
        throw controller.signal.reason;
      }
      if (response.redirected || response.type === "opaqueredirect" ||
          response.status >= 300 && response.status < 400) {
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
    const result = await Promise.race([operation(), deadline]);
    if (expired()) throw overallSignal.reason;
    return result;
  } catch (error) {
    if (expired()) throw overallSignal.reason;
    if (controller.signal.aborted) throw new RetryableFailure(timeoutError, backoffMs);
    // The SDK's own status and validation errors are already sanitized.
    if (phase === "sign" || error instanceof RetryableFailure || error instanceof DacsError) {
      throw error;
    }
    // Never surface a raw transport or body error: Fetch errors and their
    // causes hold socket addresses and, for parser errors, the node's bytes.
    controller.abort();
    const connection = connectionFailure(error, phase === "read");
    if (connection === undefined) throw new SubstrateError(READ_FAILED);
    const sanitized = new TransientError(TRANSPORT_FAILED);
    if (connection === "final") throw sanitized;
    throw new RetryableFailure(sanitized, backoffMs);
  } finally {
    clearTimeout(timer);
    overallSignal.removeEventListener("abort", overallAbort);
    rejectDeadline = undefined;
  }
}

/**
 * Equivalent to demosdk's Identities.getIdentities request, with raw admission.
 * The lookup ends within min(3 × timeoutMs + 2,750 ms, totalTimeoutMs): the
 * overall deadline aborts an active attempt or wait. A monotonic expiry is also
 * checked before each attempt, before sending and before accepting a result, so
 * a timer delivered late never lets a request or result pass the deadline.
 */
export async function readDemosCciResponse(
  rpc: string,
  address: string,
  buildHeaders: () => Promise<Record<string, string>>,
  transport: typeof fetch,
  maxBytes: number,
  timeoutMs: number,
  totalTimeoutMs: number,
  now: () => number = () => performance.now(),
): Promise<unknown> {
  const endpoint = rpcEndpoint(rpc);
  const budgetMs = Math.min(3 * timeoutMs + OVERALL_SLACK_MS, totalTimeoutMs);
  const expiresAt = now() + budgetMs;
  const overall = new AbortController();
  // A busy event loop can run an older backoff or signing callback before the
  // timer below, so expiry is also read from the clock.
  const expired = () => {
    if (!overall.signal.aborted && now() >= expiresAt) {
      overall.abort(new TransientError(TIMED_OUT));
    }
    return overall.signal.aborted;
  };
  const timer = setTimeout(() => {
    overall.abort(new TransientError(TIMED_OUT));
  }, budgetMs);
  try {
    for (let attempt = 0; ; attempt++) {
      if (expired()) throw overall.signal.reason;
      try {
        return await readAttempt(
          endpoint, address, buildHeaders, transport, maxBytes, timeoutMs,
          overall.signal, expired, 250 * 2 ** attempt,
        );
      } catch (error) {
        if (!(error instanceof RetryableFailure)) throw error;
        if (attempt === 2) throw error.error;
        // A wait that leaves the next attempt no time would only delay failure.
        if (now() + error.waitMs >= expiresAt) throw error.error;
        await waitForRetry(error.waitMs, overall.signal);
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

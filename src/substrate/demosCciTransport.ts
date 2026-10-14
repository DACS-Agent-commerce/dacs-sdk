import http from "node:http";
import https from "node:https";

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

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH = `(${MONTHS.join("|")})`;
const TIME_OF_DAY = "(\\d{2}):(\\d{2}):(\\d{2})";
const IMF_FIXDATE = new RegExp(
  `^(${WEEKDAYS.join("|")}), (\\d{2}) ${MONTH} (\\d{4}) ${TIME_OF_DAY} GMT$`,
);
const RFC850_DATE = new RegExp(
  `^(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day, (\\d{2})-${MONTH}-(\\d{2}) ${TIME_OF_DAY} GMT$`,
);
const ASCTIME_DATE = new RegExp(
  `^(${WEEKDAYS.join("|")}) ${MONTH} (\\d{2}| \\d) ${TIME_OF_DAY} (\\d{4})$`,
);

type HttpDateFields = [string, string, string, string, string, string, string];

// Midnight UTC of an exact calendar date with the given weekday, or undefined.
function calendarDay(year: number, month: number, day: number, weekday: string): number | undefined {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  return date.getUTCMonth() === month && date.getUTCDate() === day &&
    WEEKDAYS[date.getUTCDay()] === weekday ? date.getTime() : undefined;
}

// RFC 9110 §5.6.7: recipients accept IMF-fixdate and both obsolete forms, and
// second 60 is a leap second, taken here as the instant that follows :59.
function httpDateMs(value: string, nowMs: number): number | undefined {
  // [weekday, day, month, year, hour, minute, second]
  let fields: string[] | undefined = IMF_FIXDATE.exec(value)?.slice(1);
  const rfc850 = RFC850_DATE.exec(value);
  const asctime = ASCTIME_DATE.exec(value);
  if (rfc850 !== null) fields = [rfc850[1]!.slice(0, 3), ...rfc850.slice(2)];
  if (asctime !== null) {
    const [, weekday, month, day, hour, minute, second, year] = asctime;
    fields = [weekday!, day!.trim(), month!, year!, hour!, minute!, second!];
  }
  if (fields === undefined) return undefined;
  const [weekday, day, month, year, hour, minute, second] = fields as HttpDateFields;
  const [h, m, s] = [Number(hour), Number(minute), Number(second)];
  if (h > 23 || m > 59 || s > 60) return undefined;
  const timeMs = ((h * 60 + m) * 60 + s) * 1_000;
  const monthIndex = MONTHS.indexOf(month);
  let fullYear = Number(year);
  if (rfc850 !== null) {
    // A timestamp more than 50 years ahead names the most recent past year
    // with the same last two digits (RFC 9110 §5.6.7), judged per timestamp.
    const limit = new Date(nowMs);
    limit.setUTCFullYear(limit.getUTCFullYear() + 50);
    fullYear = limit.getUTCFullYear() - (limit.getUTCFullYear() - fullYear) % 100;
    const candidate = new Date(0);
    candidate.setUTCFullYear(fullYear, monthIndex, Number(day));
    if (candidate.getTime() + timeMs > limit.getTime()) fullYear -= 100;
  }
  const midnight = calendarDay(fullYear, monthIndex, Number(day), weekday);
  return midnight === undefined ? undefined : midnight + timeMs;
}

// Accept only delay-seconds or an exact HTTP-date, including its weekday;
// anything Date.parse would merely tolerate is ignored.
function retryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const nowMs = Date.now();
  const date = httpDateMs(value, nowMs);
  return date === undefined ? undefined : date - nowMs;
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
// Node 26's fetch (undici 8) reads ".2" and stores a Dispatcher1Wrapper of the
// same dispatcher under ".1"; Node 20-24 read ".1".
const GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.2");
const LEGACY_GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");
export const DEMOS_CCI_PROXY_BYPASS =
  "Demos GCR identity read would bypass the environment proxy; inject identityFetch";
export const DEMOS_CCI_ROUTE_UNVERIFIED =
  "Demos GCR identity read cannot verify its route with Node's proxy switch " +
  "or a custom global dispatcher or agent; inject identityFetch";

// proxy-from-env 2.1.0's NO_PROXY match: true when `host` should be proxied.
function proxyFromEnvShouldProxy(host: string, port: number, noProxy: string): boolean {
  if (noProxy === "") return true;
  if (noProxy === "*") return false;
  return noProxy.split(/[,\s]/).every((entry) => {
    if (entry === "") return true;
    const withPort = /^(.+):(\d+)$/.exec(entry);
    const entryHost = withPort?.[1] ?? entry;
    const entryPort = Number(withPort?.[2] ?? 0);
    if (entryPort !== 0 && entryPort !== port) return true;
    if (!/^[.*]/.test(entryHost)) return host !== entryHost;
    return !host.endsWith(entryHost.startsWith("*") ? entryHost.slice(1) : entryHost);
  });
}

function isLoopback(host: string): boolean {
  if (host === "localhost" || host === "::1") return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(host)) return host.split(".").every(part => Number(part) <= 255);
  const groups = host.split(":");
  const hex = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/i.exec(host);
  if (hex !== null) return parseInt(hex[1]!, 16) >= 0x7f00 && parseInt(hex[1]!, 16) <= 0x7fff;
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host);
  if (dotted !== null) return isLoopback(dotted[1]!);
  return groups.length === 8 && groups.slice(0, 7).every(group => /^0+$/.test(group)) &&
    /^0*1$/.test(groups[7]!);
}

// Strip IPv6 brackets and trailing dots, and write IPv4-mapped IPv6 as IPv4.
function bypassHost(host: string): string {
  const bare = (host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host)
    .replace(/\.+$/, "");
  const prefix = "(?:::|(?:0{1,4}:){1,4}:|(?:0{1,4}:){5})ffff:";
  const dotted = new RegExp(`^${prefix}(\\d+\\.\\d+\\.\\d+\\.\\d+)$`, "i").exec(bare);
  if (dotted !== null) return dotted[1]!;
  const hex = new RegExp(`^${prefix}([0-9a-f]{1,4}):([0-9a-f]{1,4})$`, "i").exec(bare);
  if (hex === null) return bare;
  const [high, low] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

// axios 1.17's shouldBypassProxy, applied after proxy-from-env chose a proxy.
function axiosBypassesProxy(url: URL, port: number, noProxy: string): boolean {
  if (noProxy === "") return false;
  if (noProxy === "*") return true;
  const host = bypassHost(url.hostname);
  return noProxy.split(/[\s,]+/).some((entry) => {
    let entryHost = entry;
    let entryPort = 0;
    const bracketed = /^\[([^\]]*)\](.*)$/.exec(entry);
    if (bracketed !== null) {
      entryHost = bracketed[1]!;
      if (/^:\d+$/.test(bracketed[2]!)) entryPort = Number(bracketed[2]!.slice(1));
    } else if (entry.indexOf(":") === entry.lastIndexOf(":") && /:\d+$/.test(entry)) {
      entryHost = entry.slice(0, entry.lastIndexOf(":"));
      entryPort = Number(entry.slice(entry.lastIndexOf(":") + 1));
    }
    entryHost = bypassHost(entryHost);
    if (entryHost === "" || entryPort !== 0 && entryPort !== port) return false;
    if (entryHost.startsWith("*")) entryHost = entryHost.slice(1);
    if (entryHost.startsWith(".")) return host.endsWith(entryHost);
    return host === entryHost || isLoopback(host) && isLoopback(entryHost);
  });
}

// Whether demosdk's Axios 1.17 transport sends `url` through an environment proxy.
function axiosUsesProxy(url: URL, env: NodeJS.ProcessEnv): boolean {
  const read = (name: string) => env[name] || env[name.toUpperCase()] || "";
  const port = Number(url.port) || DEFAULT_PORTS[url.protocol] || 0;
  const noProxy = read("no_proxy").toLowerCase();
  if (!proxyFromEnvShouldProxy(url.host.replace(/:\d*$/, ""), port, noProxy)) return false;
  const proxy = read(`${url.protocol.slice(0, -1)}_proxy`) || read("all_proxy");
  return proxy !== "" && !axiosBypassesProxy(url, port, noProxy);
}

/** What decides the routes of Node's global fetch and of demosdk's Axios. */
export interface NodeRouteState {
  /** The global dispatchers under undici.globalDispatcher.2 and .1, undefined until fetch loads. */
  dispatchers: readonly [unknown, unknown];
  /** http.globalAgent and https.globalAgent, which Axios uses when it connects directly. */
  agents: readonly unknown[];
  execArgv: readonly string[];
}

function nodeRouteState(): NodeRouteState {
  const globals = globalThis as Record<symbol, unknown>;
  return {
    dispatchers: [globals[GLOBAL_DISPATCHER], globals[LEGACY_GLOBAL_DISPATCHER]],
    agents: [http.globalAgent, https.globalAgent],
    execArgv: process.execArgv,
  };
}

const className = (value: unknown) =>
  (value as { constructor?: { name?: unknown } } | null | undefined)?.constructor?.name;

// Node's default dispatcher, which connects directly: not loaded yet, or an
// Agent, which Node 26 also wraps in a Dispatcher1Wrapper under ".1".
function defaultDispatcher([current, legacy]: readonly [unknown, unknown]): boolean {
  if (current !== undefined && className(current) !== "Agent") return false;
  return legacy === undefined || className(legacy) === "Agent" ||
    current !== undefined && className(legacy) === "Dispatcher1Wrapper";
}

// With NODE_USE_ENV_PROXY=1 or --use-env-proxy, Node 22.21+ also proxies the
// global agents Axios connects through "directly", from a snapshot of the
// environment taken at startup and by Node's own NO_PROXY rules.
function nodeMayProxyAxios(env: NodeJS.ProcessEnv, state: NodeRouteState): boolean {
  const flags = [...state.execArgv, ...(env.NODE_OPTIONS ?? "").split(/\s+/)];
  if (env.NODE_USE_ENV_PROXY === "1" || flags.includes("--use-env-proxy")) return true;
  return state.agents.some(agent => className(agent) !== "Agent" ||
    (agent as { options?: { proxyEnv?: unknown } }).options?.proxyEnv != null);
}

/**
 * Why Node's global fetch might not take the route demosdk's Axios transport
 * takes to `rpc`, or undefined when both connect directly. Axios follows the
 * environment (proxy-from-env 2.1.0, then axios 1.17's NO_PROXY bypass) and,
 * with Node's proxy switch on, Node's proxy-aware global agents; fetch follows
 * the global dispatcher. Node's proxy rules differ by release and its startup
 * snapshot can't be read, so none is emulated: global fetch is used only while
 * the dispatcher is Node's default Agent, the switch is off and Axios would
 * connect directly.
 */
export function fetchProxyMismatch(
  rpc: string,
  env: NodeJS.ProcessEnv = process.env,
  state: NodeRouteState = nodeRouteState(),
): string | undefined {
  let url: URL;
  try {
    url = new URL(rpc);
  } catch {
    return undefined;
  }
  if (!defaultDispatcher(state.dispatchers) || nodeMayProxyAxios(env, state)) {
    return DEMOS_CCI_ROUTE_UNVERIFIED;
  }
  return axiosUsesProxy(url, env) ? DEMOS_CCI_PROXY_BYPASS : undefined;
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

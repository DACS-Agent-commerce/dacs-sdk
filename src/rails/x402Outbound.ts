import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { types as nodeTypes } from "node:util";

import { isDacsPublicAddressV1 } from "../agent/publicAddress.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_MAX_HEADER_BYTES = 32 * 1_024;
const MAX_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 64 * 1_048_576;
const MAX_HEADER_BYTES = 64 * 1_024;
const MAX_URL_CHARACTERS = 2_048;
const MAX_HEADER_COUNT = 64;
const PAYMENT_HEADERS = new Set(["payment-signature", "x-payment"]);
const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "host",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type X402OutboundTransportMode = "production" | "insecure-test";

export interface X402OutboundTransportPolicy {
  /** Absolute DNS + connect + headers + body deadline. */
  timeoutMs?: number;
  /** Maximum decoded/retained response bytes. */
  maxResponseBytes?: number;
  /** Maximum aggregate request or response header bytes. */
  maxHeaderBytes?: number;
  /**
   * Allows HTTP and non-public literals only with an explicitly injected fetch.
   * This mode is for local tests/development and must never be selected by a
   * production registry-driven buyer.
   */
  mode?: X402OutboundTransportMode;
}

interface CapturedX402OutboundTransportPolicy {
  timeoutMs: number;
  maxResponseBytes: number;
  maxHeaderBytes: number;
  mode: X402OutboundTransportMode;
}

function exactPlainData(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} must be stable plain data`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.entries(descriptors).some(([name, descriptor]) =>
    !allowedKeys.has(name) || !descriptor.enumerable || !("value" in descriptor))) {
    throw new TypeError(`${label} must be stable plain data`);
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(descriptors).map(([name, descriptor]) => [
      name,
      (descriptor as PropertyDescriptor & { value: unknown }).value,
    ]),
  ));
}

function stableBoundMethod<T extends (...args: never[]) => unknown>(
  source: unknown,
  key: string,
  label: string,
): T {
  if ((typeof source !== "object" && typeof source !== "function") ||
      source === null || nodeTypes.isProxy(source)) {
    throw new TypeError(`${label} must be a stable method`);
  }
  let cursor: object | null = source;
  while (cursor !== null) {
    if (nodeTypes.isProxy(cursor)) {
      throw new TypeError(`${label} must be a stable method`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function" ||
          nodeTypes.isProxy(descriptor.value)) {
        throw new TypeError(`${label} must be a stable method`);
      }
      return Function.prototype.bind.call(descriptor.value, source) as T;
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  throw new TypeError(`${label} must be a stable method`);
}

export interface DacsPublicHttpsRequestV1 {
  url: string;
  approvedAddresses: readonly string[];
  headers: Headers;
  timeoutMs: number;
  maxBytes: number;
  maxHeaderBytes: number;
  signal: AbortSignal;
  /** Must run immediately before the implementation opens its connection. */
  beforeConnect?: () => Promise<void>;
}

export interface DacsPublicHttpsDependenciesV1 {
  resolveHost(hostname: string): Promise<readonly string[]>;
  /**
   * Trusted platform/test seam. Implementations must connect only to an
   * approved address, preserve TLS hostname verification, refuse redirects,
   * enforce every supplied bound, and invoke beforeConnect immediately before
   * opening the connection.
   */
  request(input: Readonly<DacsPublicHttpsRequestV1>): Promise<Response>;
}

export interface DacsPublicHttpsFetchOptionsV1
  extends Omit<X402OutboundTransportPolicy, "mode" | "maxResponseBytes"> {
  /** Compatibility name used by the dacs-node public-fetch API. */
  maxBytes?: number;
  /** @deprecated Use maxBytes. */
  maxResponseBytes?: number;
  dependencies?: Readonly<DacsPublicHttpsDependenciesV1>;
}

/** The deliberately narrow, credential-free request accepted by the public GET. */
export interface DacsPublicHttpsGetInitV1 {
  headers?: X402OutboundHeaderInit;
}

/**
 * A bounded credential-free GET capability, not a drop-in implementation of
 * the much broader WHATWG `fetch` contract.
 */
export type DacsPublicHttpsGetV1 = (
  url: string | URL,
  init?: Readonly<DacsPublicHttpsGetInitV1>,
) => Promise<Response>;

export type X402OutboundHeaderInit =
  | Headers
  | Record<string, string>
  | Array<[string, string]>;

export type X402PaymentHeaderMode = "forbid" | "allow-one" | "require-one";

export class X402OutboundTransportError extends Error {
  override readonly name = "X402OutboundTransportError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

class X402BeforeConnectError extends Error {
  override readonly name = "X402BeforeConnectError";

  constructor(readonly original: unknown) {
    super("x402 paid-effect fence rejected the connection");
  }
}

export interface X402OutboundRequestInput {
  url: string;
  headers?: X402OutboundHeaderInit;
  /**
   * Explicit trusted custom/test capability. Production callers should omit it
   * and use the built-in DNS-pinned HTTPS transport.
   */
  fetchImpl?: typeof fetch;
  policy?: Readonly<X402OutboundTransportPolicy>;
  dependencies?: Readonly<DacsPublicHttpsDependenciesV1>;
  paymentHeaderMode: X402PaymentHeaderMode;
  /** Paid effects use this to fence the socket-open boundary after DNS. */
  beforeConnect?: () => Promise<void>;
}

export interface X402OutboundResponse {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}

function capturePolicy(
  value: Readonly<X402OutboundTransportPolicy> | undefined,
): CapturedX402OutboundTransportPolicy {
  const data: Readonly<Record<string, unknown>> = value === undefined
    ? Object.freeze({})
    : exactPlainData(
        value,
        new Set(["timeoutMs", "maxResponseBytes", "maxHeaderBytes", "mode"]),
        "x402 outbound transport policy",
      );
  const timeoutMs = data.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = data.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxHeaderBytes = data.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES;
  const mode = data.mode ?? "production";
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS ||
      typeof maxResponseBytes !== "number" ||
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0 ||
      maxResponseBytes > MAX_RESPONSE_BYTES || typeof maxHeaderBytes !== "number" ||
      !Number.isSafeInteger(maxHeaderBytes) || maxHeaderBytes <= 0 ||
      maxHeaderBytes > MAX_HEADER_BYTES ||
      (mode !== "production" && mode !== "insecure-test")) {
    throw new TypeError("x402 outbound transport policy is invalid");
  }
  return Object.freeze({ timeoutMs, maxResponseBytes, maxHeaderBytes, mode });
}

/** Snapshot and validate caller-owned transport policy before any await. */
export function snapshotX402OutboundTransportPolicyV1(
  value: Readonly<X402OutboundTransportPolicy> | undefined,
): Readonly<X402OutboundTransportPolicy> | undefined {
  return value === undefined ? undefined : capturePolicy(value);
}

/** Bind trusted dependency methods so they cannot be swapped after an await. */
export function snapshotDacsPublicHttpsDependenciesV1(
  value: Readonly<DacsPublicHttpsDependenciesV1> | undefined,
): Readonly<DacsPublicHttpsDependenciesV1> | undefined {
  if (value === undefined) return undefined;
  return Object.freeze({
    resolveHost: stableBoundMethod<DacsPublicHttpsDependenciesV1["resolveHost"]>(
      value,
      "resolveHost",
      "x402 hostname resolver",
    ),
    request: stableBoundMethod<DacsPublicHttpsDependenciesV1["request"]>(
      value,
      "request",
      "x402 public HTTPS request",
    ),
  });
}

function literalHostname(url: URL): string {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

function admittedUrl(value: string, mode: X402OutboundTransportMode): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new X402OutboundTransportError("x402-outbound-url-invalid");
  }
  if (value.length > MAX_URL_CHARACTERS || url.username !== "" || url.password !== "" ||
      url.hash !== "" || (url.protocol !== "https:" &&
        !(mode === "insecure-test" && url.protocol === "http:"))) {
    throw new X402OutboundTransportError("x402-outbound-url-unsafe");
  }
  const hostname = literalHostname(url);
  if (hostname.toLowerCase() === "localhost") {
    if (mode !== "insecure-test") {
      throw new X402OutboundTransportError("x402-outbound-url-unsafe");
    }
  } else if (isIP(hostname) !== 0 && !isDacsPublicAddressV1(hostname) &&
      mode !== "insecure-test") {
    throw new X402OutboundTransportError("x402-outbound-address-unsafe");
  }
  return url;
}

/** Validate a registry/session target without opening a network connection. */
export function assertDacsPublicHttpsUrlV1(value: string): void {
  admittedUrl(value, "production");
}

/** Apply the same URL admission rules as the selected outbound transport mode. */
export function assertDacsX402OutboundUrlV1(
  value: string,
  mode: X402OutboundTransportMode,
): void {
  admittedUrl(value, mode);
}

function headerByteLength(headers: Headers): number {
  let total = 0;
  let count = 0;
  headers.forEach((value, name) => {
    count += 1;
    total += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8") + 4;
  });
  return count > MAX_HEADER_COUNT ? Number.POSITIVE_INFINITY : total;
}

function exactHeaderPairs(
  value: X402OutboundHeaderInit | undefined,
): Array<[string, string]> {
  if (value === undefined) return [];
  try {
    if (nodeTypes.isProxy(value)) {
      throw new X402OutboundTransportError("x402-outbound-headers-unstable");
    }
    if (value instanceof Headers) {
      if (Object.getPrototypeOf(value) !== Headers.prototype ||
          Reflect.ownKeys(value).length !== 0) {
        throw new X402OutboundTransportError("x402-outbound-headers-unstable");
      }
      const pairs: Array<[string, string]> = [];
      Headers.prototype.forEach.call(value, (headerValue, name) => {
        pairs.push([name, headerValue]);
      });
      return pairs;
    }
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype ||
          Object.getOwnPropertySymbols(value).length !== 0) {
        throw new X402OutboundTransportError("x402-outbound-headers-unstable");
      }
      const outerDescriptors = Object.getOwnPropertyDescriptors(value) as unknown as
        Record<PropertyKey, PropertyDescriptor>;
      const outerLength = outerDescriptors.length;
      if (!outerLength || !("value" in outerLength) ||
          typeof outerLength.value !== "number" ||
          !Number.isSafeInteger(outerLength.value) || outerLength.value < 0) {
        throw new X402OutboundTransportError("x402-outbound-headers-unstable");
      }
      if (outerLength.value > MAX_HEADER_COUNT) {
        throw new X402OutboundTransportError("x402-outbound-headers-too-large");
      }
      const allowedOuterKeys = new Set<string>([
        "length",
        ...Array.from({ length: outerLength.value }, (_unused, index) => String(index)),
      ]);
      if (Reflect.ownKeys(outerDescriptors).some((key) =>
        typeof key !== "string" || !allowedOuterKeys.has(key)) ||
          Array.from({ length: outerLength.value }, (_unused, index) =>
            outerDescriptors[String(index)]).some((descriptor) =>
              !descriptor || !descriptor.enumerable || !("value" in descriptor))) {
        throw new X402OutboundTransportError("x402-outbound-headers-unstable");
      }
      const pairs: Array<[string, string]> = [];
      for (let index = 0; index < outerLength.value; index += 1) {
        const entry = outerDescriptors[String(index)]!.value;
        if (!Array.isArray(entry) || nodeTypes.isProxy(entry) ||
            Object.getPrototypeOf(entry) !== Array.prototype ||
            Object.getOwnPropertySymbols(entry).length !== 0) {
          throw new X402OutboundTransportError("x402-outbound-headers-unstable");
        }
        const descriptors = Object.getOwnPropertyDescriptors(entry) as unknown as
          Record<PropertyKey, PropertyDescriptor>;
        const lengthDescriptor = descriptors.length;
        if (!lengthDescriptor || !("value" in lengthDescriptor) ||
            lengthDescriptor.value !== 2 ||
            Reflect.ownKeys(descriptors).some((key) =>
              key !== "0" && key !== "1" && key !== "length") ||
            !descriptors["0"] || !("value" in descriptors["0"]) ||
            !descriptors["0"].enumerable ||
            !descriptors["1"] || !("value" in descriptors["1"]) ||
            !descriptors["1"].enumerable ||
            typeof descriptors["0"].value !== "string" ||
            typeof descriptors["1"].value !== "string") {
          throw new X402OutboundTransportError("x402-outbound-headers-unstable");
        }
        pairs.push([descriptors["0"].value, descriptors["1"].value]);
      }
      return pairs;
    }
    if ((Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null) ||
        Object.getOwnPropertySymbols(value).length !== 0) {
      throw new X402OutboundTransportError("x402-outbound-headers-unstable");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(descriptors).length > MAX_HEADER_COUNT) {
      throw new X402OutboundTransportError("x402-outbound-headers-too-large");
    }
    return Object.entries(descriptors).map(([name, descriptor]) => {
      if (!descriptor.enumerable || !("value" in descriptor) ||
          typeof descriptor.value !== "string") {
        throw new X402OutboundTransportError("x402-outbound-headers-unstable");
      }
      return [name, descriptor.value];
    });
  } catch (error) {
    if (error instanceof X402OutboundTransportError) throw error;
    throw new X402OutboundTransportError("x402-outbound-headers-invalid");
  }
}

export function captureX402OutboundHeadersV1(
  value: X402OutboundHeaderInit | undefined,
  paymentHeaderMode: X402PaymentHeaderMode,
  maxHeaderBytes = DEFAULT_MAX_HEADER_BYTES,
): Headers {
  const pairs = exactHeaderPairs(value);
  const presentedPaymentHeaders = pairs.filter(([name]) =>
    PAYMENT_HEADERS.has(name.toLowerCase()));
  if (presentedPaymentHeaders.length > 1 ||
      presentedPaymentHeaders.some(([, headerValue]) => headerValue.length === 0)) {
    throw new X402OutboundTransportError("x402-outbound-payment-header-invalid");
  }
  let headers: Headers;
  try {
    headers = new Headers(pairs);
  } catch {
    throw new X402OutboundTransportError("x402-outbound-headers-invalid");
  }
  let paymentHeaderCount = 0;
  headers.forEach((_value, name) => {
    if (FORBIDDEN_HEADERS.has(name)) {
      throw new X402OutboundTransportError("x402-outbound-header-refused");
    }
    if (PAYMENT_HEADERS.has(name)) {
      paymentHeaderCount += 1;
      if (paymentHeaderMode === "forbid") {
        throw new X402OutboundTransportError("x402-outbound-header-refused");
      }
      return;
    }
    if (name !== "accept") {
      throw new X402OutboundTransportError("x402-outbound-header-refused");
    }
  });
  if (paymentHeaderCount > 1 ||
      (paymentHeaderMode === "require-one" && paymentHeaderCount !== 1)) {
    throw new X402OutboundTransportError("x402-outbound-payment-header-invalid");
  }
  if (headerByteLength(headers) > maxHeaderBytes) {
    throw new X402OutboundTransportError("x402-outbound-headers-too-large");
  }
  return headers;
}

function captureResponseHeaders(response: Response, maxHeaderBytes: number): Headers {
  const headers = new Headers(response.headers);
  if (headerByteLength(headers) > maxHeaderBytes) {
    throw new X402OutboundTransportError("x402-response-headers-too-large");
  }
  return headers;
}

async function consumeBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^[0-9]+$/.test(contentLength) &&
      BigInt(contentLength) > BigInt(maxBytes)) {
    await response.body?.cancel().catch(() => undefined);
    throw new X402OutboundTransportError("x402-response-too-large");
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
      if (signal.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new X402OutboundTransportError("x402-outbound-timeout");
      }
      const next = await reader.read();
      if (signal.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new X402OutboundTransportError("x402-outbound-timeout");
      }
      if (next.done) break;
      const prospectiveTotal = total + next.value.byteLength;
      if (prospectiveTotal > maxBytes) {
        throw new X402OutboundTransportError("x402-response-too-large");
      }
      const bytes = Uint8Array.from(next.value);
      total = prospectiveTotal;
      chunks.push(bytes);
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return combined;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export async function resolveDacsPublicHostV1(
  hostname: string,
): Promise<readonly string[]> {
  const literal = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (isIP(literal) !== 0) return [literal];
  const records = await lookup(literal, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

async function pinnedHttpsRequest(
  input: Readonly<DacsPublicHttpsRequestV1>,
): Promise<Response> {
  // Prepare every reversible request option before the effect fence. Once the
  // captured fence resolves, the signal check and httpsRequest call are in the
  // same synchronous turn, leaving no await-time method or destination swap at
  // the socket-open boundary.
  const url = new URL(input.url);
  const address = input.approvedAddresses[0];
  if (address === undefined) {
    throw new X402OutboundTransportError("x402-outbound-dns-empty");
  }
  const family = isIP(address);
  const hostname = literalHostname(url);
  const headers: Record<string, string> = {};
  input.headers.forEach((value, name) => {
    headers[name] = value;
  });
  headers["accept-encoding"] = "identity";
  headers["user-agent"] = "dacs-x402-public-https/v1";
  if (headerByteLength(new Headers(headers)) > input.maxHeaderBytes) {
    throw new X402OutboundTransportError("x402-outbound-headers-too-large");
  }
  const requestOptions = Object.freeze({
    protocol: "https:" as const,
    hostname,
    port: url.port === "" ? 443 : Number(url.port),
    path: `${url.pathname}${url.search}`,
    method: "GET",
    agent: false,
    servername: isIP(hostname) === 0 ? hostname : undefined,
    rejectUnauthorized: true,
    headers,
    maxHeaderSize: input.maxHeaderBytes,
    lookup: (_hostname: string, options: unknown, callback: unknown) => {
      if (typeof options === "object" && options !== null &&
          "all" in options && options.all === true) {
        (callback as (
          error: null,
          addresses: readonly Readonly<{ address: string; family: number }>[],
        ) => void)(null, [Object.freeze({ address, family })]);
        return;
      }
      (callback as (
        error: null,
        resolvedAddress: string,
        resolvedFamily: number,
      ) => void)(null, address, family);
    },
  });
  const beforeConnect = input.beforeConnect;
  if (input.signal.aborted) {
    throw input.signal.reason instanceof Error
      ? input.signal.reason
      : new X402OutboundTransportError("x402-outbound-timeout");
  }
  await beforeConnect?.();
  if (input.signal.aborted) {
    throw input.signal.reason instanceof Error
      ? input.signal.reason
      : new X402OutboundTransportError("x402-outbound-timeout");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let abort: (() => void) | undefined;
    const detachAbort = () => {
      if (abort !== undefined) input.signal.removeEventListener("abort", abort);
    };
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      detachAbort();
      reject(error);
    };
    const request = httpsRequest(requestOptions, (response) => {
      const chunks: Uint8Array[] = [];
      let total = 0;
      response.once("aborted", () => finishReject(
        new X402OutboundTransportError("x402-response-aborted"),
      ));
      response.once("error", finishReject);
      const responseHeaders = new Headers();
      for (const [name, raw] of Object.entries(response.headers)) {
        if (typeof raw === "string") responseHeaders.set(name, raw);
        else if (Array.isArray(raw)) {
          raw.forEach((value) => responseHeaders.append(name, value));
        }
      }
      if (headerByteLength(responseHeaders) > input.maxHeaderBytes) {
        response.destroy(new X402OutboundTransportError(
          "x402-response-headers-too-large",
        ));
        return;
      }
      if (!/^\s*(?:identity)?\s*$/iu.test(
        responseHeaders.get("content-encoding") ?? "",
      )) {
        response.destroy(new X402OutboundTransportError(
          "x402-response-encoding-refused",
        ));
        return;
      }
      const contentLength = responseHeaders.get("content-length");
      if (contentLength !== null && /^[0-9]+$/.test(contentLength) &&
          BigInt(contentLength) > BigInt(input.maxBytes)) {
        response.destroy(new X402OutboundTransportError("x402-response-too-large"));
        return;
      }
      const status = response.statusCode ?? 0;
      // WHATWG Response construction rejects informational statuses. Treat a
      // raw 1xx terminal response as invalid here instead of throwing later in
      // an event callback and risking an uncaught process-level exception.
      if (status < 200 || status > 599) {
        response.destroy(new X402OutboundTransportError(
          "x402-response-status-invalid",
        ));
        return;
      }
      if (status >= 300 && status < 400) {
        response.destroy(new X402OutboundTransportError("x402-redirect-refused"));
        return;
      }
      response.on("data", (chunk: Buffer | string) => {
        const chunkLength = typeof chunk === "string"
          ? Buffer.byteLength(chunk)
          : chunk.byteLength;
        const prospectiveTotal = total + chunkLength;
        if (prospectiveTotal > input.maxBytes) {
          request.destroy(new X402OutboundTransportError("x402-response-too-large"));
          return;
        }
        const bytes = Buffer.from(chunk);
        total = prospectiveTotal;
        chunks.push(Uint8Array.from(bytes));
      });
      response.once("end", () => {
        if (settled) return;
        settled = true;
        detachAbort();
        const body = status === 204 || status === 205 || status === 304
          ? null
          : Uint8Array.from(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total));
        resolve(new Response(body, { status, headers: responseHeaders }));
      });
    });
    request.setTimeout(input.timeoutMs, () => {
      request.destroy(new X402OutboundTransportError("x402-outbound-timeout"));
    });
    abort = () => request.destroy(
      input.signal.reason instanceof Error
        ? input.signal.reason
        : new X402OutboundTransportError("x402-outbound-timeout"),
    );
    if (input.signal.aborted) abort();
    else input.signal.addEventListener("abort", abort, { once: true });
    request.once("close", detachAbort);
    request.once("error", finishReject);
    request.end();
  });
}

const DEFAULT_DEPENDENCIES: Readonly<DacsPublicHttpsDependenciesV1> = Object.freeze({
  resolveHost: resolveDacsPublicHostV1,
  request: pinnedHttpsRequest,
});

/**
 * Execute one bounded x402 GET. With no fetch override, DNS is resolved and
 * every answer is validated before a fresh TLS connection is pinned to one
 * approved address. The optional paid-effect fence runs after DNS and directly
 * before that connection is opened.
 */
export async function requestX402OutboundV1(
  input: Readonly<X402OutboundRequestInput>,
): Promise<Readonly<X402OutboundResponse>> {
  const capturedInput = exactPlainData(
    input,
    new Set([
      "url",
      "headers",
      "fetchImpl",
      "policy",
      "dependencies",
      "paymentHeaderMode",
      "beforeConnect",
    ]),
    "x402 outbound request",
  );
  const policy = capturePolicy(
    capturedInput.policy as Readonly<X402OutboundTransportPolicy> | undefined,
  );
  const rawUrl = capturedInput.url;
  const fetchImpl = capturedInput.fetchImpl;
  const beforeConnect = capturedInput.beforeConnect;
  const suppliedDependencies = capturedInput.dependencies;
  const paymentHeaderMode = capturedInput.paymentHeaderMode;
  if (typeof rawUrl !== "string" ||
      (paymentHeaderMode !== "forbid" && paymentHeaderMode !== "allow-one" &&
        paymentHeaderMode !== "require-one") ||
      (fetchImpl !== undefined && typeof fetchImpl !== "function") ||
      (fetchImpl !== undefined && nodeTypes.isProxy(fetchImpl)) ||
      (beforeConnect !== undefined &&
        (typeof beforeConnect !== "function" || nodeTypes.isProxy(beforeConnect)))) {
    throw new TypeError("x402 outbound request is invalid");
  }
  const capturedBeforeConnect = beforeConnect as
    | (() => Promise<void>)
    | undefined;
  const guardedBeforeConnect = capturedBeforeConnect === undefined
    ? undefined
    : async (): Promise<void> => {
        try {
          await capturedBeforeConnect();
        } catch (error) {
          // Keep fence rejection distinguishable from transport ambiguity. The
          // caller must be able to report a stale generation without treating
          // it as a possibly-opened paid request.
          throw new X402BeforeConnectError(error);
        }
      };
  const url = admittedUrl(rawUrl, policy.mode);
  if (fetchImpl !== undefined && policy.mode !== "insecure-test") {
    throw new X402OutboundTransportError(
      "x402-fetch-override-requires-insecure-mode",
    );
  }
  if (policy.mode === "insecure-test" && fetchImpl === undefined) {
    throw new X402OutboundTransportError("x402-insecure-mode-requires-fetch-override");
  }
  const headers = captureX402OutboundHeadersV1(
    capturedInput.headers as X402OutboundHeaderInit | undefined,
    paymentHeaderMode,
    policy.maxHeaderBytes,
  );
  let dependencies: DacsPublicHttpsDependenciesV1 | undefined;
  if (fetchImpl === undefined) {
    const source = suppliedDependencies ?? DEFAULT_DEPENDENCIES;
    dependencies = snapshotDacsPublicHttpsDependenciesV1(
      source as Readonly<DacsPublicHttpsDependenciesV1>,
    );
  }
  const controller = new AbortController();
  const timeoutError = new X402OutboundTransportError("x402-outbound-timeout");
  let rejectDeadline: ((reason: X402OutboundTransportError) => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    controller.abort(timeoutError);
    rejectDeadline?.(timeoutError);
  }, policy.timeoutMs);
  let response: Response | undefined;
  try {
    const operation = async (): Promise<Readonly<X402OutboundResponse>> => {
      if (fetchImpl !== undefined) {
        await guardedBeforeConnect?.();
        if (controller.signal.aborted) throw timeoutError;
        response = await (fetchImpl as typeof fetch)(url.toString(), {
          method: "GET",
          headers,
          redirect: "error",
          credentials: "omit",
          signal: controller.signal,
        });
      } else {
        let addresses: readonly string[];
        try {
          const resolved = await dependencies!.resolveHost(literalHostname(url));
          addresses = [...new Set(resolved)];
        } catch {
          if (controller.signal.aborted) throw timeoutError;
          throw new X402OutboundTransportError("x402-outbound-dns-unavailable");
        }
        if (controller.signal.aborted) throw timeoutError;
        if (addresses.length === 0) {
          throw new X402OutboundTransportError("x402-outbound-dns-empty");
        }
        if (!addresses.every((address): address is string =>
          typeof address === "string" && isDacsPublicAddressV1(address))) {
          throw new X402OutboundTransportError("x402-outbound-address-unsafe");
        }
        response = await dependencies!.request({
          url: url.toString(),
          approvedAddresses: addresses,
          headers,
          timeoutMs: policy.timeoutMs,
          maxBytes: policy.maxResponseBytes,
          maxHeaderBytes: policy.maxHeaderBytes,
          signal: controller.signal,
          ...(guardedBeforeConnect === undefined
            ? {}
            : { beforeConnect: guardedBeforeConnect }),
        });
      }
      if (!(response instanceof Response)) {
        throw new X402OutboundTransportError("x402-response-invalid");
      }
      if (response.redirected || response.status >= 300 && response.status < 400) {
        throw new X402OutboundTransportError("x402-redirect-refused");
      }
      const responseHeaders = captureResponseHeaders(response, policy.maxHeaderBytes);
      if (!/^\s*(?:identity)?\s*$/iu.test(
        responseHeaders.get("content-encoding") ?? "",
      )) {
        throw new X402OutboundTransportError("x402-response-encoding-refused");
      }
      const bytes = await consumeBoundedBody(
        response,
        policy.maxResponseBytes,
        controller.signal,
      );
      return Object.freeze({ status: response.status, headers: responseHeaders, bytes });
    };
    return await Promise.race([operation(), deadline]);
  } catch (error) {
    if (error instanceof X402BeforeConnectError) throw error.original;
    if (error instanceof X402OutboundTransportError) throw error;
    if (controller.signal.aborted) throw timeoutError;
    throw new X402OutboundTransportError("x402-outbound-request-unavailable");
  } finally {
    clearTimeout(timer);
    rejectDeadline = undefined;
    controller.abort();
    await response?.body?.cancel().catch(() => undefined);
  }
}

/** Create one narrow, bounded, credential-free public HTTPS GET capability. */
export function createDacsPublicHttpsFetchV1(
  options: Readonly<DacsPublicHttpsFetchOptionsV1> = {},
): DacsPublicHttpsGetV1 {
  const capturedOptions = exactPlainData(
    options,
    new Set([
      "timeoutMs",
      "maxBytes",
      "maxResponseBytes",
      "maxHeaderBytes",
      "dependencies",
    ]),
    "x402 public HTTPS fetch options",
  );
  const rawMaxBytes = capturedOptions.maxBytes;
  const rawMaxResponseBytes = capturedOptions.maxResponseBytes;
  if (rawMaxBytes !== undefined && rawMaxResponseBytes !== undefined &&
      rawMaxBytes !== rawMaxResponseBytes) {
    throw new TypeError("x402 public HTTPS byte limits disagree");
  }
  const maxBytes = rawMaxBytes ?? rawMaxResponseBytes;
  const policy = capturePolicy(Object.freeze({
    ...(capturedOptions.timeoutMs === undefined
      ? {}
      : { timeoutMs: capturedOptions.timeoutMs }),
    ...(maxBytes === undefined ? {} : { maxResponseBytes: maxBytes }),
    ...(capturedOptions.maxHeaderBytes === undefined
      ? {}
      : { maxHeaderBytes: capturedOptions.maxHeaderBytes }),
  }) as Readonly<X402OutboundTransportPolicy>);
  const dependencies = snapshotDacsPublicHttpsDependenciesV1(
    capturedOptions.dependencies as
      | Readonly<DacsPublicHttpsDependenciesV1>
      | undefined,
  );
  return async (
    rawInput: string | URL,
    init?: Readonly<DacsPublicHttpsGetInitV1>,
  ) => {
    const inputUrl = typeof rawInput === "string"
      ? rawInput
      : !nodeTypes.isProxy(rawInput) && rawInput instanceof URL &&
          Object.getPrototypeOf(rawInput) === URL.prototype &&
          Reflect.ownKeys(rawInput).length === 0
        ? URL.prototype.toString.call(rawInput)
        : null;
    let initData: Readonly<Record<string, unknown>>;
    try {
      initData = init === undefined
        ? Object.freeze({})
        : exactPlainData(
            init,
            new Set(["headers"]),
            "x402 public HTTPS GET init",
          );
    } catch {
      throw new X402OutboundTransportError("x402-outbound-request-shape-refused");
    }
    if (inputUrl === null ||
        Reflect.ownKeys(initData).some((key) => key !== "headers")) {
      throw new X402OutboundTransportError("x402-outbound-request-shape-refused");
    }
    const result = await requestX402OutboundV1({
      url: inputUrl,
      headers: initData.headers as X402OutboundHeaderInit | undefined,
      paymentHeaderMode: "forbid",
      policy,
      ...(dependencies === undefined ? {} : { dependencies }),
    });
    let body: ArrayBuffer | null = null;
    if (result.status !== 204 && result.status !== 205 && result.status !== 304) {
      const copy = new Uint8Array(result.bytes.byteLength);
      copy.set(result.bytes);
      body = copy.buffer;
    }
    return new Response(body, { status: result.status, headers: result.headers });
  };
}

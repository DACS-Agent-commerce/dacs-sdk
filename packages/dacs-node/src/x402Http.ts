import type { IncomingMessage, ServerResponse } from "node:http";

import { canonicalize } from "@kynesyslabs/dacs/canonical";
import type {
  X402Paywall,
  X402PaywallHttpAdapter,
  X402PaywallResult,
} from "@kynesyslabs/dacs/rails";

import type {
  DacsLiveRoleApplicationRequestHandlerV1,
  DacsLiveRoleInboundContextV1,
} from "./service.js";

const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE_RE = /^[\u0009\u0020-\u007e\u0080-\u00ff]*$/;
const JOB_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1_024 * 1_024;
const BLOCKED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type DacsX402HttpRequestResolutionV1 = Readonly<
  | { status: "not-matched" }
  | { status: "rejected"; reasonCode: string }
  | { status: "matched"; jobId: string; phaseIndex: number }
>;

export interface DacsX402HttpRequestFactsV1 {
  method: string;
  pathname: string;
  url: string;
}

/** Sanitized result metadata; it never includes authorization or response bodies. */
export interface DacsX402HttpResultObservationV1 {
  jobId: string;
  phaseIndex: number;
  paymentPresented: boolean;
  disposition: X402PaywallResult<unknown>["disposition"];
  settled: X402PaywallResult<unknown>["settled"];
  reason: string;
  responseStatus: number;
}

export interface DacsX402HttpHandlerOptionsV1<T = unknown> {
  paywall: Readonly<X402Paywall<T>>;
  /** Exact externally advertised origin used in the payer-signed resource URL. */
  publicBaseUrl: string;
  resolveRequest(
    request: Readonly<DacsX402HttpRequestFactsV1>,
    context: Readonly<DacsLiveRoleInboundContextV1>,
  ): Promise<DacsX402HttpRequestResolutionV1> | DacsX402HttpRequestResolutionV1;
  observeResult?(result: Readonly<DacsX402HttpResultObservationV1>): void;
  maxResponseBytes?: number;
}

export class DacsX402HttpError extends Error {
  override readonly name = "DacsX402HttpError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return (prototype === Object.prototype || prototype === null) &&
      Reflect.ownKeys(value).every((key) => {
        if (typeof key !== "string") return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
      });
  } catch {
    return false;
  }
}

function reasonCode(value: unknown): value is string {
  return typeof value === "string" &&
    /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(value);
}

function captureBaseUrl(value: unknown): URL {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError("x402 HTTP public base URL is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("x402 HTTP public base URL is invalid");
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username !== "" || parsed.password !== "" || parsed.search !== "" ||
      parsed.hash !== "") {
    throw new TypeError("x402 HTTP public base URL is invalid");
  }
  if (parsed.protocol === "http:" &&
      parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost" &&
      parsed.hostname !== "::1") {
    throw new TypeError("non-loopback x402 HTTP public base URL requires HTTPS");
  }
  return parsed;
}

function capturedRequestUrl(request: IncomingMessage, baseUrl: URL): URL {
  if (typeof request.url !== "string" || request.url.length === 0 ||
      request.url.length > 8_192 || !request.url.startsWith("/")) {
    throw new DacsX402HttpError("x402-request-target-invalid");
  }
  const resolved = new URL(request.url, baseUrl);
  if (resolved.origin !== baseUrl.origin || resolved.username !== "" ||
      resolved.password !== "" || resolved.hash !== "") {
    throw new DacsX402HttpError("x402-request-target-invalid");
  }
  return resolved;
}

function headerOccurrences(request: IncomingMessage, wanted: string): string[] {
  const found: string[] = [];
  const lower = wanted.toLowerCase();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === lower) {
      found.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  return found;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const occurrences = headerOccurrences(request, name);
  if (occurrences.length > 1) return undefined;
  const value = occurrences[0];
  return value === undefined || !HEADER_VALUE_RE.test(value) ? undefined : value;
}

function queryParameters(url: URL): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of url.searchParams) {
    const current = result[key];
    if (current === undefined) result[key] = value;
    else if (Array.isArray(current)) current.push(value);
    else result[key] = [current, value];
  }
  return result;
}

function httpAdapter(request: IncomingMessage, url: URL): X402PaywallHttpAdapter {
  const query = queryParameters(url);
  return Object.freeze({
    getHeader: (name: string) => header(request, name),
    getMethod: () => request.method ?? "",
    getPath: () => url.pathname,
    getUrl: () => url.href,
    getAcceptHeader: () => header(request, "accept") ?? "",
    getUserAgent: () => header(request, "user-agent") ?? "",
    getQueryParams: () => structuredClone(query),
    getQueryParam: (name: string) => {
      const value = query[name];
      return Array.isArray(value) ? [...value] : value;
    },
  });
}

function responseBody(value: unknown): Buffer {
  if (value === undefined || value === null) return Buffer.alloc(0);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (!plainObject(value) && !Array.isArray(value)) {
    throw new DacsX402HttpError("x402-response-body-invalid");
  }
  try {
    return Buffer.from(canonicalize(value), "utf8");
  } catch {
    throw new DacsX402HttpError("x402-response-body-invalid");
  }
}

function writePaywallResult<T>(
  response: ServerResponse,
  result: Readonly<X402PaywallResult<T>>,
  maximumBytes: number,
): void {
  const projected = result.response;
  if (!Number.isInteger(projected.status) || projected.status < 200 ||
      projected.status > 599 || !plainObject(projected.headers)) {
    throw new DacsX402HttpError("x402-response-invalid");
  }
  const body = responseBody(projected.body);
  if (body.byteLength > maximumBytes) {
    throw new DacsX402HttpError("x402-response-body-too-large");
  }
  for (const [name, value] of Object.entries(projected.headers)) {
    const lower = name.toLowerCase();
    if (!HEADER_NAME_RE.test(name) || typeof value !== "string" ||
        !HEADER_VALUE_RE.test(value) || BLOCKED_RESPONSE_HEADERS.has(lower)) {
      throw new DacsX402HttpError("x402-response-header-invalid");
    }
    response.setHeader(name, value);
  }
  if (!response.hasHeader("content-type") && body.byteLength > 0 &&
      projected.body !== undefined && typeof projected.body === "object" &&
      !(projected.body instanceof Uint8Array)) {
    response.setHeader("content-type", "application/json");
  }
  response.statusCode = projected.status;
  response.setHeader("content-length", String(body.byteLength));
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(body);
}

function writeError(response: ServerResponse, status: number, code: string): void {
  const body = Buffer.from(canonicalize({ error: code }), "utf8");
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.setHeader("content-length", String(body.byteLength));
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(body);
}

/** Bind the framework-neutral SDK x402 paywall to the live Node role service. */
export function createDacsX402ApplicationRequestHandlerV1<T = unknown>(
  options: Readonly<DacsX402HttpHandlerOptionsV1<T>>,
): DacsLiveRoleApplicationRequestHandlerV1 {
  if (!plainObject(options) || options.paywall === null ||
      typeof options.paywall !== "object" || typeof options.paywall.handle !== "function" ||
      typeof options.resolveRequest !== "function" ||
      (options.observeResult !== undefined && typeof options.observeResult !== "function")) {
    throw new TypeError("x402 HTTP handler options are invalid");
  }
  const baseUrl = captureBaseUrl(options.publicBaseUrl);
  const maximumBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 ||
      maximumBytes > 64 * 1_024 * 1_024) {
    throw new TypeError("x402 HTTP response limit is invalid");
  }
  const handle = options.paywall.handle.bind(options.paywall);
  const resolveRequest = options.resolveRequest.bind(options);
  const observeResult = options.observeResult?.bind(options);

  return async (request, response, context) => {
    let url: URL;
    try {
      url = capturedRequestUrl(request, baseUrl);
    } catch {
      writeError(response, 400, "x402-request-target-invalid");
      return true;
    }
    let resolution: DacsX402HttpRequestResolutionV1;
    try {
      resolution = await resolveRequest(Object.freeze({
        method: request.method ?? "",
        pathname: url.pathname,
        url: url.href,
      }), context);
    } catch {
      writeError(response, 503, "x402-request-resolution-unavailable");
      return true;
    }
    if (!plainObject(resolution) || typeof resolution.status !== "string") {
      writeError(response, 503, "x402-request-resolution-invalid");
      return true;
    }
    if (resolution.status === "not-matched") return false;
    if (resolution.status === "rejected") {
      writeError(response, reasonCode(resolution.reasonCode) ? 400 : 503,
        reasonCode(resolution.reasonCode)
          ? resolution.reasonCode : "x402-request-resolution-invalid");
      return true;
    }
    if (resolution.status !== "matched" || !JOB_ID_RE.test(resolution.jobId) ||
        !Number.isSafeInteger(resolution.phaseIndex) || resolution.phaseIndex < 0) {
      writeError(response, 503, "x402-request-resolution-invalid");
      return true;
    }
    // A smuggled duplicate authorization header is not equivalent to absence.
    if (headerOccurrences(request, "PAYMENT-SIGNATURE").length > 1 ||
        headerOccurrences(request, "X-PAYMENT").length > 1) {
      writeError(response, 400, "x402-payment-header-ambiguous");
      return true;
    }
    try {
      const result = await handle({
        jobId: resolution.jobId,
        phaseIndex: resolution.phaseIndex,
        request: httpAdapter(request, url),
      });
      if (observeResult !== undefined) {
        try {
          observeResult(Object.freeze({
            jobId: resolution.jobId,
            phaseIndex: resolution.phaseIndex,
            paymentPresented: header(request, "PAYMENT-SIGNATURE") !== undefined,
            disposition: result.disposition,
            settled: result.settled,
            reason: result.reason,
            responseStatus: result.response.status,
          }));
        } catch {
          // Diagnostics are intentionally non-authoritative and off-path.
        }
      }
      writePaywallResult(response, result, maximumBytes);
    } catch {
      if (!response.headersSent) {
        writeError(response, 503, "x402-request-handler-unavailable");
      } else if (!response.writableEnded) {
        response.end();
      }
    }
    return true;
  };
}

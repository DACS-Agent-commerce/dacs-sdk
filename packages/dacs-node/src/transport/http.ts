import {
  createServer as createHttpServer,
  type IncomingMessage,
  type RequestListener,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
} from "node:https";
import type { AddressInfo } from "node:net";

import { canonicalize } from "@kynesyslabs/dacs/canonical";
import {
  parseCanonicalClaimReference,
  sameCanonicalClaimIdentity,
} from "@kynesyslabs/dacs/identity";

import type { DacsNodeMessageTransport } from "../contracts.js";
import {
  DACS_HTTP_MAXIMUM_RETRY_DELAY_MS,
  DACS_HTTP_MINIMUM_RETENTION_MS,
  type DacsHttpInboxItemV1,
  type DacsHttpInboxStoreV1,
  type DacsHttpOutboxItemV1,
  type DacsHttpOutboxStoreV1,
} from "./contracts.js";
import {
  DACS_HTTP_MAX_BODY_BYTES,
  DACS_HTTP_MAX_ENVELOPE_LIFETIME_MS,
  DACS_HTTP_TRANSPORT_PATH,
  authenticateDacsHttpEnvelopeV1,
  createDacsHttpAcknowledgementEnvelopeV1,
  generateDacsHttpNonceV1,
  verifyDacsHttpAcknowledgementBindingV1,
  verifyDacsHttpEnvelopeSelfSignatureV1,
  type DacsHttpAuthenticatedEnvelopeV1,
  type DacsHttpEnvelopeSigner,
  type DacsHttpEnvelopeV1,
  type DacsHttpIdentityResolverV1,
  type DacsHttpPayloadValidatorV1,
} from "./envelope.js";

const REASON_CODE_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_OUTBOX_LEASE_MS = 30_000;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_REQUESTS = 120;
const DEFAULT_RATE_LIMIT_PEERS = 4_096;
const RETENTION_ADMISSION_MARGIN_MS = 60_000;

export type DacsHttpInboundDispositionV1 = Readonly<
  | { disposition: "accepted" }
  | { disposition: "rejected"; reasonCode: string }
>;

/**
 * The handler durably admits one authenticated operation. It MUST use the
 * envelope or typed payload identity as its idempotency key; a thrown result
 * leaves the inbox pending for explicit recovery after restart.
 */
export type DacsHttpInboundHandlerV1 = (
  authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
) => Promise<DacsHttpInboundDispositionV1> | DacsHttpInboundDispositionV1;

export interface DacsHttpMessageEndpointOptionsV1 {
  authority: string;
  inbox: DacsHttpInboxStoreV1;
  resolveIdentity: DacsHttpIdentityResolverV1;
  validatePayload: DacsHttpPayloadValidatorV1;
  handleMessage: DacsHttpInboundHandlerV1;
  signAcknowledgement: DacsHttpEnvelopeSigner;
  retentionMs?: number;
  acknowledgementLifetimeMs?: number;
  maxBodyBytes?: number;
  acknowledgementNonce?: () => string;
  rateLimit?: Readonly<{
    requests: number;
    windowMs: number;
    maxPeers?: number;
  }>;
}

export interface DacsHttpMessageServerOptionsV1
  extends DacsHttpMessageEndpointOptionsV1 {
  hostname?: string;
  port?: number;
  tls?: Readonly<{
    key: string | Buffer;
    cert: string | Buffer;
  }>;
  requestTimeoutMs?: number;
}

export interface DacsHttpMessageServerV1 {
  readonly endpoint: string;
  readonly hostname: string;
  readonly port: number;
  readonly server: HttpServer | HttpsServer;
  close(): Promise<void>;
}

export type DacsHttpFetchV1 = (
  input: string | URL,
  init: RequestInit,
) => Promise<Response>;

export interface DacsHttpMessageClientOptionsV1 {
  endpoint: string;
  authority: string;
  outbox: DacsHttpOutboxStoreV1;
  resolveIdentity: DacsHttpIdentityResolverV1;
  workerId: string;
  fetch?: DacsHttpFetchV1;
  retentionMs?: number;
  requestTimeoutMs?: number;
  leaseDurationMs?: number;
  maxResponseBytes?: number;
}

export type DacsHttpOutboxDispatchResultV1 = Readonly<
  | {
      status: "acknowledged";
      acknowledgement: Readonly<DacsHttpAuthenticatedEnvelopeV1>;
    }
  | {
      status: "retry-scheduled" | "operator-action" | "waiting" | "not-runnable";
      reasonCode: string;
    }
>;

export interface DacsHttpMessageClientV1 extends DacsNodeMessageTransport {
  dispatch(
    envelopeId: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<DacsHttpOutboxDispatchResultV1>;
  runRunnable(input?: Readonly<{
    limit?: number;
    signal?: AbortSignal;
  }>): Promise<Readonly<{
    attempted: number;
    acknowledged: number;
    retryScheduled: number;
    operatorAction: number;
  }>>;
}

export class DacsHttpTransportError extends Error {
  override readonly name = "DacsHttpTransportError";

  constructor(
    readonly reasonCode: string,
    readonly retryable: boolean,
  ) {
    super(reasonCode);
  }
}

class HttpRequestFailure extends Error {
  constructor(
    readonly status: number,
    readonly reasonCode: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(reasonCode);
  }
}

interface CapturedEndpointOptions {
  authority: string;
  inbox: DacsHttpInboxStoreV1;
  resolveIdentity: DacsHttpIdentityResolverV1;
  validatePayload: DacsHttpPayloadValidatorV1;
  handleMessage: DacsHttpInboundHandlerV1;
  signAcknowledgement: DacsHttpEnvelopeSigner;
  retentionMs: number;
  acknowledgementLifetimeMs: number;
  maxBodyBytes: number;
  acknowledgementNonce: () => string;
  rateLimit: Readonly<{ requests: number; windowMs: number; maxPeers: number }>;
}

interface RateBucket {
  startedAt: number;
  count: number;
}

function safePositiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 &&
    value <= maximum;
}

function reasonCode(value: unknown): value is string {
  return typeof value === "string" && REASON_CODE_RE.test(value);
}

function safeDeadline(now: number, duration: number): number {
  const deadline = now + duration;
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(deadline) ||
      deadline <= now) {
    throw new DacsHttpTransportError("transport-time-overflow", false);
  }
  return deadline;
}

function safeRetentionDeadline(now: number, retentionMs: number): number {
  return safeDeadline(
    safeDeadline(now, retentionMs),
    RETENTION_ADMISSION_MARGIN_MS,
  );
}

function bindMethod<T extends (...args: never[]) => unknown>(
  value: T,
  owner: unknown,
): T {
  return Function.prototype.bind.call(value, owner) as T;
}

function captureInbox(source: DacsHttpInboxStoreV1): DacsHttpInboxStoreV1 {
  if (source === null || typeof source !== "object") {
    throw new TypeError("HTTP inbox store is required");
  }
  return Object.freeze({
    readTime: bindMethod(source.readTime, source),
    reserve: bindMethod(source.reserve, source),
    load: bindMethod(source.load, source),
    list: bindMethod(source.list, source),
    recordDisposition: bindMethod(source.recordDisposition, source),
    extendRetention: bindMethod(source.extendRetention, source),
  });
}

function captureOutbox(source: DacsHttpOutboxStoreV1): DacsHttpOutboxStoreV1 {
  if (source === null || typeof source !== "object") {
    throw new TypeError("HTTP outbox store is required");
  }
  return Object.freeze({
    readTime: bindMethod(source.readTime, source),
    put: bindMethod(source.put, source),
    load: bindMethod(source.load, source),
    list: bindMethod(source.list, source),
    listRunnable: bindMethod(source.listRunnable, source),
    claim: bindMethod(source.claim, source),
    isCurrent: bindMethod(source.isCurrent, source),
    recordSendFailure: bindMethod(source.recordSendFailure, source),
    requireOperatorAction: bindMethod(source.requireOperatorAction, source),
    acknowledge: bindMethod(source.acknowledge, source),
    extendRetention: bindMethod(source.extendRetention, source),
  });
}

function captureEndpointOptions(
  options: Readonly<DacsHttpMessageEndpointOptionsV1>,
): CapturedEndpointOptions {
  if (options === null || typeof options !== "object") {
    throw new TypeError("HTTP endpoint options are required");
  }
  const retentionMs = options.retentionMs ?? DACS_HTTP_MINIMUM_RETENTION_MS;
  const acknowledgementLifetimeMs = options.acknowledgementLifetimeMs ??
    DACS_HTTP_MAX_ENVELOPE_LIFETIME_MS;
  const maxBodyBytes = options.maxBodyBytes ?? DACS_HTTP_MAX_BODY_BYTES;
  const rawRate = options.rateLimit ?? {
    requests: DEFAULT_RATE_LIMIT_REQUESTS,
    windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
    maxPeers: DEFAULT_RATE_LIMIT_PEERS,
  };
  const maxPeers = rawRate.maxPeers ?? DEFAULT_RATE_LIMIT_PEERS;
  if (typeof options.authority !== "string" || options.authority.length === 0 ||
      !safePositiveInteger(retentionMs) || retentionMs < DACS_HTTP_MINIMUM_RETENTION_MS ||
      !safePositiveInteger(
        acknowledgementLifetimeMs,
        DACS_HTTP_MAX_ENVELOPE_LIFETIME_MS,
      ) || !safePositiveInteger(maxBodyBytes, DACS_HTTP_MAX_BODY_BYTES) ||
      !safePositiveInteger(rawRate.requests) || !safePositiveInteger(rawRate.windowMs) ||
      !safePositiveInteger(maxPeers) || typeof options.resolveIdentity !== "function" ||
      typeof options.validatePayload !== "function" ||
      typeof options.handleMessage !== "function" ||
      typeof options.signAcknowledgement !== "function" ||
      (options.acknowledgementNonce !== undefined &&
        typeof options.acknowledgementNonce !== "function")) {
    throw new TypeError("HTTP endpoint options are invalid");
  }
  return Object.freeze({
    authority: options.authority,
    inbox: captureInbox(options.inbox),
    resolveIdentity: bindMethod(options.resolveIdentity, options),
    validatePayload: bindMethod(options.validatePayload, options),
    handleMessage: bindMethod(options.handleMessage, options),
    signAcknowledgement: bindMethod(options.signAcknowledgement, options),
    retentionMs,
    acknowledgementLifetimeMs,
    maxBodyBytes,
    acknowledgementNonce: options.acknowledgementNonce === undefined
      ? generateDacsHttpNonceV1
      : bindMethod(options.acknowledgementNonce, options),
    rateLimit: Object.freeze({
      requests: rawRate.requests,
      windowMs: rawRate.windowMs,
      maxPeers,
    }),
  });
}

function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.$/, "");
  const unbracketed = lower.startsWith("[") && lower.endsWith("]")
    ? lower.slice(1, -1)
    : lower;
  return unbracketed === "localhost" || unbracketed.endsWith(".localhost") ||
    unbracketed === "::1" || unbracketed === "0:0:0:0:0:0:0:1" ||
    /^127(?:\.\d{1,3}){3}$/.test(unbracketed);
}

function endpointUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("HTTP transport endpoint is invalid");
  }
  if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "" ||
      parsed.search !== "" || parsed.pathname !== DACS_HTTP_TRANSPORT_PATH ||
      (parsed.protocol !== "https:" &&
        (parsed.protocol !== "http:" || !isLoopbackHostname(parsed.hostname)))) {
    throw new TypeError("HTTP transport endpoint must use HTTPS or loopback HTTP");
  }
  return parsed;
}

function sameCanonicalAuthority(left: unknown, right: unknown): boolean {
  return parseCanonicalClaimReference(left) !== null &&
    parseCanonicalClaimReference(right) !== null &&
    sameCanonicalClaimIdentity(left, right);
}

function canonicalBody(value: unknown): Buffer {
  return Buffer.from(canonicalize(value), "utf8");
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  retryAfterSeconds?: number,
): void {
  let body: Buffer;
  try {
    body = canonicalBody(value);
  } catch {
    body = Buffer.from('{"error":"response-serialization-failed"}', "utf8");
    status = 503;
  }
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.setHeader("content-length", String(body.byteLength));
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (retryAfterSeconds !== undefined) {
    response.setHeader("retry-after", String(retryAfterSeconds));
  }
  response.end(body);
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? undefined : value;
}

async function readRequestJson(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<unknown> {
  const contentType = headerValue(request, "content-type");
  if (contentType === undefined ||
      contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpRequestFailure(400, "content-type-invalid");
  }
  const contentLength = headerValue(request, "content-length");
  if (contentLength !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(contentLength)) {
      throw new HttpRequestFailure(400, "content-length-invalid");
    }
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length > maximumBytes) {
      throw new HttpRequestFailure(413, "request-body-too-large");
    }
  }
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const raw of request) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      length += chunk.byteLength;
      if (length > maximumBytes) {
        throw new HttpRequestFailure(413, "request-body-too-large");
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof HttpRequestFailure) throw error;
    throw new HttpRequestFailure(400, "request-body-unreadable");
  }
  if (length === 0) throw new HttpRequestFailure(400, "request-body-empty");
  if (contentLength !== undefined && Number(contentLength) !== length) {
    throw new HttpRequestFailure(400, "content-length-mismatch");
  }
  try {
    return JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
  } catch {
    throw new HttpRequestFailure(400, "request-json-invalid");
  }
}

function validateDisposition(value: unknown): DacsHttpInboundDispositionV1 | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (candidate.disposition === "accepted" && keys.length === 1) {
    return Object.freeze({ disposition: "accepted" });
  }
  if (candidate.disposition === "rejected" && keys.length === 2 &&
      Object.hasOwn(candidate, "reasonCode") && reasonCode(candidate.reasonCode)) {
    return Object.freeze({
      disposition: "rejected",
      reasonCode: candidate.reasonCode,
    });
  }
  return undefined;
}

async function acknowledgement(
  options: CapturedEndpointOptions,
  original: Readonly<DacsHttpEnvelopeV1>,
  disposition: "accepted" | "existing" | "rejected",
  rejectionReasonCode?: string,
): Promise<Readonly<DacsHttpEnvelopeV1>> {
  const issuedAt = await options.inbox.readTime();
  const expiresAt = safeDeadline(issuedAt, options.acknowledgementLifetimeMs);
  return createDacsHttpAcknowledgementEnvelopeV1(original, {
    disposition,
    ...(rejectionReasonCode === undefined ? {} : { reasonCode: rejectionReasonCode }),
    issuedAt,
    expiresAt,
    nonce: options.acknowledgementNonce(),
  }, options.signAcknowledgement);
}

async function processAuthenticatedInbox(
  options: CapturedEndpointOptions,
  authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
): Promise<Readonly<{
  status: "disposed" | "pending";
  disposition?: "accepted" | "rejected";
  reasonCode?: string;
}>> {
  let rawDisposition: unknown;
  try {
    rawDisposition = await options.handleMessage(authenticated);
  } catch {
    return Object.freeze({ status: "pending" });
  }
  const disposition = validateDisposition(rawDisposition);
  if (disposition === undefined) return Object.freeze({ status: "pending" });
  const envelope = authenticated.envelope;
  const recorded = await options.inbox.recordDisposition({
    sender: envelope.sender,
    audience: envelope.audience,
    envelopeId: envelope.envelopeId,
    authenticationHash: authenticated.authenticationHash,
    disposition: disposition.disposition,
    ...(disposition.disposition === "rejected"
      ? { reasonCode: disposition.reasonCode }
      : {}),
  });
  if (recorded.status !== "recorded" && recorded.status !== "existing") {
    return Object.freeze({ status: "pending" });
  }
  return Object.freeze({
    status: "disposed",
    disposition: disposition.disposition,
    ...(disposition.disposition === "rejected"
      ? { reasonCode: disposition.reasonCode }
      : {}),
  });
}

/**
 * Construct a bounded Node request listener. The returned listener never emits
 * callback exception text and never acknowledges a message before its inbox
 * reservation and handler disposition are durable.
 */
export function createDacsHttpMessageRequestHandlerV1(
  rawOptions: Readonly<DacsHttpMessageEndpointOptionsV1>,
): RequestListener {
  const options = captureEndpointOptions(rawOptions);
  const buckets = new Map<string, RateBucket>();

  function rateLimited(peer: string, now: number): boolean {
    for (const [key, bucket] of buckets) {
      if (bucket.startedAt + options.rateLimit.windowMs <= now) buckets.delete(key);
    }
    let bucket = buckets.get(peer);
    if (bucket === undefined) {
      if (buckets.size >= options.rateLimit.maxPeers) return true;
      bucket = { startedAt: now, count: 0 };
      buckets.set(peer, bucket);
    }
    bucket.count += 1;
    return bucket.count > options.rateLimit.requests;
  }

  return (request, response) => {
    void (async () => {
      try {
        const rawUrl = request.url ?? "";
        if (rawUrl !== DACS_HTTP_TRANSPORT_PATH) {
          throw new HttpRequestFailure(404, "transport-path-not-found");
        }
        if (request.method !== "POST") {
          response.setHeader("allow", "POST");
          throw new HttpRequestFailure(405, "transport-method-not-allowed");
        }
        const rateNow = Date.now();
        if (rateLimited(request.socket.remoteAddress ?? "unknown", rateNow)) {
          throw new HttpRequestFailure(
            429,
            "transport-rate-limited",
            Math.max(1, Math.ceil(options.rateLimit.windowMs / 1_000)),
          );
        }
        const value = await readRequestJson(request, options.maxBodyBytes);
        const storeTime = await options.inbox.readTime();
        const authenticated = await authenticateDacsHttpEnvelopeV1(value, {
          storeTime,
          expectedAudience: options.authority,
          resolveIdentity: options.resolveIdentity,
          validatePayload: options.validatePayload,
        });
        if (authenticated.status !== "authenticated") {
          throw new HttpRequestFailure(
            authenticated.category === "authentication" ? 401 : 400,
            authenticated.reasonCode,
          );
        }
        if (authenticated.envelope.type === "acknowledgement") {
          throw new HttpRequestFailure(400, "acknowledgement-request-forbidden");
        }
        const retained = await options.inbox.reserve({
          authenticated,
          retainUntil: safeRetentionDeadline(storeTime, options.retentionMs),
        });
        if (retained.status === "conflict") {
          throw new HttpRequestFailure(409, "transport-message-conflict");
        }
        if (retained.status === "pending") {
          throw new HttpRequestFailure(503, "transport-message-pending", 1);
        }
        if (retained.status === "existing") {
          const rejected = retained.disposition === "rejected";
          const signed = await acknowledgement(
            options,
            authenticated.envelope,
            rejected ? "rejected" : "existing",
            rejected ? retained.reasonCode : undefined,
          );
          writeJson(response, 200, signed);
          return;
        }
        const processed = await processAuthenticatedInbox(options, authenticated);
        if (processed.status !== "disposed" || processed.disposition === undefined) {
          throw new HttpRequestFailure(503, "transport-handler-pending", 1);
        }
        const signed = await acknowledgement(
          options,
          authenticated.envelope,
          processed.disposition,
          processed.reasonCode,
        );
        writeJson(response, 202, signed);
      } catch (error) {
        const failure = error instanceof HttpRequestFailure
          ? error
          : new HttpRequestFailure(503, "transport-request-unavailable", 1);
        if (!response.headersSent) {
          writeJson(
            response,
            failure.status,
            { error: failure.reasonCode },
            failure.retryAfterSeconds,
          );
        } else if (!response.writableEnded) {
          response.end();
        }
      }
    })();
  };
}

/** Resume inbox reservations left pending by a process exit. */
export async function resumeDacsHttpInboxV1(
  rawOptions: Readonly<DacsHttpMessageEndpointOptionsV1>,
  input: Readonly<{ limit?: number }> = {},
): Promise<Readonly<{ inspected: number; disposed: number; pending: number }>> {
  const options = captureEndpointOptions(rawOptions);
  const limit = input.limit ?? 100;
  if (!safePositiveInteger(limit, 1_000)) {
    throw new TypeError("HTTP inbox resume limit is invalid");
  }
  const page = await options.inbox.list({ limit, state: "pending" });
  let disposed = 0;
  let pending = 0;
  for (const item of page.items) {
    const result = await processAuthenticatedInbox(options, item.authenticated);
    if (result.status === "disposed") disposed += 1;
    else pending += 1;
  }
  return Object.freeze({ inspected: page.items.length, disposed, pending });
}

export async function startDacsHttpMessageServerV1(
  options: Readonly<DacsHttpMessageServerOptionsV1>,
): Promise<Readonly<DacsHttpMessageServerV1>> {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 0;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (typeof hostname !== "string" || hostname.length === 0 ||
      typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65_535 ||
      !safePositiveInteger(requestTimeoutMs) ||
      (!isLoopbackHostname(hostname) && options.tls === undefined)) {
    throw new TypeError("HTTP message server binding is invalid or requires TLS");
  }
  const listener = createDacsHttpMessageRequestHandlerV1(options);
  const server = options.tls === undefined
    ? createHttpServer(listener)
    : createHttpsServer({ key: options.tls.key, cert: options.tls.cert }, listener);
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = Math.min(requestTimeoutMs, 10_000);
  server.keepAliveTimeout = Math.min(requestTimeoutMs, 5_000);
  server.maxHeadersCount = 64;
  server.on("clientError", (_error, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, hostname);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("HTTP message server address is unavailable");
  }
  const actualPort = (address as AddressInfo).port;
  const renderedHost = hostname.includes(":") && !hostname.startsWith("[")
    ? `[${hostname}]`
    : hostname;
  const endpoint = `${options.tls === undefined ? "http" : "https"}://${renderedHost}:${actualPort}${DACS_HTTP_TRANSPORT_PATH}`;
  let closed = false;
  return Object.freeze({
    endpoint,
    hostname,
    port: actualPort,
    server,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  });
}

async function responseBytes(response: Response, maximumBytes: number): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maximumBytes) {
      throw new DacsHttpTransportError("transport-response-too-large", true);
    }
  }
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      length += chunk.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new DacsHttpTransportError("transport-response-too-large", true);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

function abortableSignal(
  timeoutMs: number,
  external: AbortSignal | undefined,
): Readonly<{ signal: AbortSignal; dispose: () => void }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const abort = () => controller.abort();
  if (external?.aborted) controller.abort();
  else external?.addEventListener("abort", abort, { once: true });
  return Object.freeze({
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", abort);
    },
  });
}

/**
 * Create the durable request client. `send` first retains the exact signed
 * envelope, and a 2xx response clears it only after a signed, identity-resolved
 * acknowledgement is authenticated and transactionally recorded.
 */
export function createDacsHttpMessageClientV1(
  options: Readonly<DacsHttpMessageClientOptionsV1>,
): Readonly<DacsHttpMessageClientV1> {
  if (options === null || typeof options !== "object") {
    throw new TypeError("HTTP message client options are required");
  }
  const endpoint = endpointUrl(options.endpoint).toString();
  const retentionMs = options.retentionMs ?? DACS_HTTP_MINIMUM_RETENTION_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_OUTBOX_LEASE_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DACS_HTTP_MAX_BODY_BYTES;
  if (typeof options.authority !== "string" || options.authority.length === 0 ||
      typeof options.workerId !== "string" || options.workerId.length === 0 ||
      typeof options.resolveIdentity !== "function" ||
      (options.fetch !== undefined && typeof options.fetch !== "function") ||
      !safePositiveInteger(retentionMs) || retentionMs < DACS_HTTP_MINIMUM_RETENTION_MS ||
      !safePositiveInteger(requestTimeoutMs) || !safePositiveInteger(leaseDurationMs) ||
      leaseDurationMs <= requestTimeoutMs ||
      !safePositiveInteger(maxResponseBytes, DACS_HTTP_MAX_BODY_BYTES)) {
    throw new TypeError("HTTP message client options are invalid");
  }
  const authority = options.authority;
  const workerId = options.workerId;
  const outbox = captureOutbox(options.outbox);
  const resolveIdentity = bindMethod(options.resolveIdentity, options);
  const fetchTransport = options.fetch === undefined
    ? globalThis.fetch.bind(globalThis) as DacsHttpFetchV1
    : bindMethod(options.fetch, options);

  async function markRetry(
    record: Readonly<DacsHttpOutboxItemV1>,
    lease: NonNullable<DacsHttpOutboxItemV1["lease"]>,
    failureReason: string,
    retryAfterMs?: number,
  ): Promise<DacsHttpOutboxDispatchResultV1> {
    const result = await outbox.recordSendFailure({
      envelopeId: record.envelope.envelopeId,
      envelopeHash: record.envelopeHash,
      lease,
      reasonCode: failureReason,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
    return Object.freeze({
      status: result.status === "recorded" || result.status === "existing"
        ? "retry-scheduled"
        : "waiting",
      reasonCode: failureReason,
    });
  }

  async function markOperator(
    record: Readonly<DacsHttpOutboxItemV1>,
    lease: NonNullable<DacsHttpOutboxItemV1["lease"]>,
    failureReason: string,
  ): Promise<DacsHttpOutboxDispatchResultV1> {
    const result = await outbox.requireOperatorAction({
      envelopeId: record.envelope.envelopeId,
      envelopeHash: record.envelopeHash,
      lease,
      reasonCode: failureReason,
    });
    return Object.freeze({
      status: result.status === "recorded" || result.status === "existing"
        ? "operator-action"
        : "waiting",
      reasonCode: failureReason,
    });
  }

  async function dispatch(
    envelopeId: string,
    dispatchOptions: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<DacsHttpOutboxDispatchResultV1> {
    const loaded = await outbox.load(envelopeId);
    if (loaded === undefined) {
      return Object.freeze({ status: "not-runnable", reasonCode: "outbox-message-missing" });
    }
    if (loaded.state === "acknowledged" && loaded.acknowledgement !== undefined) {
      return Object.freeze({
        status: "acknowledged",
        acknowledgement: loaded.acknowledgement,
      });
    }
    if (loaded.state === "operator-action") {
      return Object.freeze({
        status: "operator-action",
        reasonCode: loaded.reasonCode ?? "operator-action-required",
      });
    }
    const claimed = await outbox.claim({
      envelopeId,
      envelopeHash: loaded.envelopeHash,
      owner: workerId,
      leaseDurationMs,
    });
    if (claimed.status !== "acquired") {
      return Object.freeze({
        status: claimed.status === "waiting" ? "waiting" : "not-runnable",
        reasonCode: claimed.status === "waiting"
          ? "outbox-message-in-flight"
          : "outbox-message-not-runnable",
      });
    }
    if (!await outbox.isCurrent({
      envelopeId,
      envelopeHash: loaded.envelopeHash,
      lease: claimed.lease,
    })) {
      return Object.freeze({ status: "waiting", reasonCode: "outbox-lease-stale" });
    }
    const abort = abortableSignal(requestTimeoutMs, dispatchOptions.signal);
    let response: Response;
    try {
      response = await fetchTransport(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
        },
        body: canonicalize(claimed.record.envelope),
        redirect: "manual",
        credentials: "omit",
        signal: abort.signal,
      });
    } catch {
      abort.dispose();
      return markRetry(claimed.record, claimed.lease, "response-ambiguous");
    }
    try {
      if (response.status !== 200 && response.status !== 202) {
        // Drain only a bounded amount; error text is never used as durable state.
        try {
          await responseBytes(response, maxResponseBytes);
        } catch {
          // The authenticated acknowledgement remains absent either way.
        }
        if (response.status === 429 || response.status === 503 || response.status >= 500) {
          const retryAfter = response.headers.get("retry-after");
          const retryAfterMs = retryAfter !== null && /^(0|[1-9][0-9]*)$/.test(retryAfter)
            ? Math.min(DACS_HTTP_MAXIMUM_RETRY_DELAY_MS, Number(retryAfter) * 1_000)
            : undefined;
          return markRetry(
            claimed.record,
            claimed.lease,
            "response-ambiguous",
            Number.isSafeInteger(retryAfterMs) ? retryAfterMs : undefined,
          );
        }
        return markOperator(
          claimed.record,
          claimed.lease,
          `http-status-${response.status}`,
        );
      }

      let body: unknown;
      try {
        const contentType = response.headers.get("content-type");
        if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
          throw new DacsHttpTransportError("acknowledgement-content-type-invalid", true);
        }
        const bytes = await responseBytes(response, maxResponseBytes);
        body = JSON.parse(bytes.toString("utf8"));
      } catch {
        return markRetry(claimed.record, claimed.lease, "response-ambiguous");
      }
      const storeTime = await outbox.readTime();
      const authenticated = await authenticateDacsHttpEnvelopeV1(body, {
        storeTime,
        expectedAudience: authority,
        expectedJobId: claimed.record.envelope.jobId,
        resolveIdentity,
      });
      if (authenticated.status !== "authenticated" ||
          verifyDacsHttpAcknowledgementBindingV1(
            authenticated,
            claimed.record.envelope,
          ).status !== "valid") {
        return markRetry(claimed.record, claimed.lease, "response-ambiguous");
      }
      const recorded = await outbox.acknowledge({
        envelopeId,
        envelopeHash: claimed.record.envelopeHash,
        acknowledgement: authenticated,
      });
      if (recorded.status !== "recorded" && recorded.status !== "existing") {
        return Object.freeze({ status: "waiting", reasonCode: "acknowledgement-not-recorded" });
      }
      return Object.freeze({ status: "acknowledged", acknowledgement: authenticated });
    } finally {
      abort.dispose();
    }
  }

  const client: DacsHttpMessageClientV1 = {
    send: async (envelope, sendOptions = {}) => {
      const verified = verifyDacsHttpEnvelopeSelfSignatureV1(envelope);
      if (verified.status !== "valid" || verified.envelope.type === "acknowledgement" ||
          !sameCanonicalAuthority(verified.envelope.sender, authority)) {
        throw new DacsHttpTransportError("outbox-envelope-invalid", false);
      }
      const now = await outbox.readTime();
      const retained = await outbox.put({
        envelope: verified.envelope,
        retainUntil: safeRetentionDeadline(now, retentionMs),
      });
      if (retained.status === "conflict") {
        throw new DacsHttpTransportError("outbox-envelope-conflict", false);
      }
      const result = await dispatch(verified.envelope.envelopeId, sendOptions);
      if (result.status === "acknowledged") return result.acknowledgement;
      throw new DacsHttpTransportError(
        result.reasonCode,
        result.status === "retry-scheduled" || result.status === "waiting" ||
          result.status === "not-runnable",
      );
    },
    dispatch,
    runRunnable: async (input = {}) => {
      const limit = input.limit ?? 100;
      if (!safePositiveInteger(limit, 1_000)) {
        throw new TypeError("HTTP outbox runnable limit is invalid");
      }
      const page = await outbox.listRunnable({ limit });
      let acknowledged = 0;
      let retryScheduled = 0;
      let operatorAction = 0;
      let attempted = 0;
      for (const record of page.items) {
        if (input.signal?.aborted) break;
        attempted += 1;
        const result = await dispatch(record.envelope.envelopeId, {
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        if (result.status === "acknowledged") acknowledged += 1;
        else if (result.status === "retry-scheduled") retryScheduled += 1;
        else if (result.status === "operator-action") operatorAction += 1;
      }
      return Object.freeze({
        attempted,
        acknowledged,
        retryScheduled,
        operatorAction,
      });
    },
  };
  return Object.freeze(client);
}

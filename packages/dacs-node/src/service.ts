import type { IncomingMessage, ServerResponse } from "node:http";

import { canonicalize } from "@kynesyslabs/dacs/canonical";
import {
  createFixedPriceX402BuyerCoordinator,
  createFixedPriceX402SellerCoordinator,
  type FixedPriceX402CommerceCoordinator,
  type FixedPriceX402Operations,
  type FixedPriceX402OrderInput,
  type FixedPriceX402OrderStatus,
} from "@kynesyslabs/dacs/commerce";
import {
  parseCanonicalClaimReference,
  sameCanonicalClaimIdentity,
} from "@kynesyslabs/dacs/identity";

import {
  DACS_NODE_LIVE_PROFILE,
  validateDacsAgentConfig,
  type DacsLiveAgentConfig,
} from "./config.js";
import type {
  DacsNodeEvent,
  DacsNodeEventKind,
  DacsNodeEventLevel,
  DacsNodeEventSink,
  DacsNodeHealthStatus,
  DacsNodeReadinessStatus,
} from "./events.js";
import type { DacsNodeSqliteDatabase } from "./sqlite.js";
import {
  DACS_HTTP_MAX_ENVELOPE_LIFETIME_MS,
  createDacsHttpEnvelopeV1,
  generateDacsHttpNonceV1,
  type DacsHttpAuthenticatedEnvelopeV1,
  type DacsHttpEnvelopeV1,
  type DacsHttpEnvelopeSigner,
  type DacsHttpIdentityResolverV1,
  type DacsHttpMessageType,
  type DacsHttpPayloadByType,
  type DacsHttpPayloadValidatorV1,
  validateDacsHttpDiagnosticProbePayloadV1,
} from "./transport/envelope.js";
import {
  createDacsHttpMessageClientV1,
  resumeDacsHttpInboxV1,
  startDacsHttpMessageServerV1,
  type DacsHttpInboundDispositionV1,
  type DacsHttpMessageClientV1,
  type DacsHttpMessageEndpointOptionsV1,
  type DacsHttpMessageServerV1,
} from "./transport/http.js";

const REASON_CODE_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const DEFAULT_WORKER_INTERVAL_MS = 1_000;
const DEFAULT_WORKER_BATCH_SIZE = 100;
const DEFAULT_READINESS_MAX_AGE_MS = 30_000;
const READINESS_CLOCK_SKEW_MS = 1_000;

export type DacsLiveRole = "buyer" | "seller";
export type DacsLiveRoleServiceLifecycle =
  | "stopped"
  | "starting"
  | "running"
  | "stopping";
export type DacsLiveOutboundMessageType = Exclude<
  DacsHttpMessageType,
  "acknowledgement"
>;

export interface DacsLiveRoleSendInputV1<
  Type extends DacsLiveOutboundMessageType = DacsLiveOutboundMessageType,
> {
  type: Type;
  jobId: string;
  payload: Readonly<DacsHttpPayloadByType[Type]>;
  lifetimeMs?: number;
}

export interface DacsLiveRoleCycleReportV1 {
  startedAt: number;
  completedAt: number;
  inbox: Readonly<{ inspected: number; disposed: number; pending: number }>;
  coordinator: Readonly<{ processed: number; nextCursor?: string }>;
  outbox: Readonly<{
    attempted: number;
    acknowledged: number;
    retryScheduled: number;
    operatorAction: number;
  }>;
}

export interface DacsLiveRoleServiceStatusV1 {
  version: 1;
  sdkVersion: string;
  standardRevision: string;
  profile: typeof DACS_NODE_LIVE_PROFILE;
  role: DacsLiveRole;
  lifecycle: DacsLiveRoleServiceLifecycle;
  checkedAt: number;
  endpoint?: string;
  queues: Readonly<{
    inboxPending: boolean;
    outboxPending: boolean;
    outboxOperatorAction: boolean;
  }>;
  sessions: Readonly<{
    runnable: number;
    truncated: boolean;
  }>;
  worker: Readonly<{
    running: boolean;
    lastCycleAt?: number;
    lastSuccessAt?: number;
    reasonCode?: string;
  }>;
}

export interface DacsLiveRoleRuntimeContextV1 {
  readonly role: DacsLiveRole;
  readonly authority: string;
  readonly peerAuthority: string;
  sendMessage<Type extends DacsLiveOutboundMessageType>(
    input: Readonly<DacsLiveRoleSendInputV1<Type>>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<Readonly<DacsHttpAuthenticatedEnvelopeV1>>;
}

export interface DacsLiveRoleInboundContextV1
  extends DacsLiveRoleRuntimeContextV1 {
  readonly coordinator: FixedPriceX402CommerceCoordinator;
}

export type DacsLiveRoleApplicationRequestHandlerV1 = (
  request: IncomingMessage,
  response: ServerResponse,
  context: Readonly<DacsLiveRoleInboundContextV1>,
) => Promise<boolean> | boolean;

/**
 * Read-only unauthenticated public metadata surface (for example DACS
 * well-known discovery). It runs independently of the commerce readiness
 * latch, must not perform protocol effects, and is limited to GET by the host.
 */
export type DacsLiveRolePublicRequestHandlerV1 = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<boolean> | boolean;

export interface DacsLiveRoleServiceOptionsV1 {
  config: unknown;
  database: DacsNodeSqliteDatabase;
  workerId: string;
  peerAuthority: string;
  peerEndpoint: string;
  resolveIdentity: DacsHttpIdentityResolverV1;
  validatePayload: DacsHttpPayloadValidatorV1;
  signTransportEnvelope: DacsHttpEnvelopeSigner;
  createOperations(
    context: Readonly<DacsLiveRoleRuntimeContextV1>,
  ): Readonly<FixedPriceX402Operations>;
  handleMessage(
    authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
    context: Readonly<DacsLiveRoleInboundContextV1>,
  ): Promise<DacsHttpInboundDispositionV1> | DacsHttpInboundDispositionV1;
  /**
   * Optional role-owned application HTTP surface, such as the seller's x402
   * resource. It is invoked only for non-reserved paths while the service's
   * freshness-bounded readiness result is true. Return true after handling.
   */
  handleApplicationRequest?: DacsLiveRoleApplicationRequestHandlerV1;
  handlePublicRequest?: DacsLiveRolePublicRequestHandlerV1;
  events?: DacsNodeEventSink;
  readiness?: () => Promise<Readonly<DacsNodeReadinessStatus>> |
    Readonly<DacsNodeReadinessStatus>;
  readinessMaxAgeMs?: number;
  coordinatorLeaseDurationMs?: number;
  workerIntervalMs?: number;
  workerBatchSize?: number;
  server?: Readonly<{
    hostname?: string;
    port?: number;
    tls?: Readonly<{ key: string | Buffer; cert: string | Buffer }>;
    requestTimeoutMs?: number;
  }>;
  transport?: Readonly<{
    retentionMs?: number;
    acknowledgementLifetimeMs?: number;
    maxBodyBytes?: number;
    rateLimit?: Readonly<{ requests: number; windowMs: number; maxPeers?: number }>;
    requestTimeoutMs?: number;
    leaseDurationMs?: number;
    maxResponseBytes?: number;
  }>;
}

export interface DacsLiveRoleServiceV1 {
  readonly role: DacsLiveRole;
  readonly authority: string;
  readonly peerAuthority: string;
  readonly endpoint: string | undefined;
  readonly coordinator: FixedPriceX402CommerceCoordinator;
  start(): Promise<void>;
  stop(): Promise<void>;
  startOrder(order: Readonly<FixedPriceX402OrderInput>): Promise<FixedPriceX402OrderStatus>;
  getOrderStatus(jobId: string): Promise<FixedPriceX402OrderStatus | null>;
  sendMessage<Type extends DacsLiveOutboundMessageType>(
    input: Readonly<DacsLiveRoleSendInputV1<Type>>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<Readonly<DacsHttpAuthenticatedEnvelopeV1>>;
  runOnce(options?: Readonly<{ signal?: AbortSignal }>): Promise<
    Readonly<DacsLiveRoleCycleReportV1>
  >;
  health(): Promise<Readonly<DacsNodeHealthStatus>>;
  readiness(): Promise<Readonly<DacsNodeReadinessStatus>>;
  status(): Promise<Readonly<DacsLiveRoleServiceStatusV1>>;
}

export class DacsLiveRoleServiceError extends Error {
  override readonly name = "DacsLiveRoleServiceError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

const OUTBOUND_BY_ROLE: Readonly<
  Record<DacsLiveRole, ReadonlySet<DacsLiveOutboundMessageType>>
> = Object.freeze({
  buyer: new Set<DacsLiveOutboundMessageType>([
    "agreement-proposal",
    "payment-evidence-completion",
    "bundle-signature-response",
    "diagnostic-probe-buyer",
  ]),
  seller: new Set<DacsLiveOutboundMessageType>([
    "agreement-response",
    "payment-evidence-request",
    "bundle-signature-request",
    "diagnostic-probe-seller",
  ]),
});

const COORDINATOR_TRACKS_BY_ROLE = Object.freeze({
  buyer: Object.freeze([
    "agreement",
    "payment",
    "payment-evidence",
    "buyer-received",
    "audit",
  ] as const),
  seller: Object.freeze([
    "agreement",
    "payment",
    "payment-evidence",
    "delivery",
    "delivery-evidence",
    "audit",
  ] as const),
});

function safePositiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 &&
    value <= maximum;
}

function validReasonCode(value: unknown): value is string {
  return typeof value === "string" && REASON_CODE_RE.test(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value &&
    !value.includes("\0");
}

function captureClosedDataObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError();
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const allowed = new Set([...required, ...optional]);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
        required.some((key) => !ownKeys.includes(key))) {
      throw new TypeError();
    }
    const captured: Record<string, unknown> = {};
    for (const key of ownKeys) {
      if (typeof key !== "string") throw new TypeError();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError();
      }
      captured[key] = descriptor.value;
    }
    return Object.freeze(captured);
  } catch {
    throw new TypeError("live role service options must be closed data objects");
  }
}

function captureServiceOptions(
  rawOptions: unknown,
): Readonly<DacsLiveRoleServiceOptionsV1> {
  const source = captureClosedDataObject(rawOptions, [
    "config",
    "database",
    "workerId",
    "peerAuthority",
    "peerEndpoint",
    "resolveIdentity",
    "validatePayload",
    "signTransportEnvelope",
    "createOperations",
    "handleMessage",
  ], [
    "handleApplicationRequest",
    "handlePublicRequest",
    "events",
    "readiness",
    "readinessMaxAgeMs",
    "coordinatorLeaseDurationMs",
    "workerIntervalMs",
    "workerBatchSize",
    "server",
    "transport",
  ]);
  const capturedServer = source.server === undefined
    ? undefined
    : captureClosedDataObject(source.server, [], [
        "hostname",
        "port",
        "tls",
        "requestTimeoutMs",
      ]);
  const capturedTls = capturedServer?.tls === undefined
    ? undefined
    : captureClosedDataObject(capturedServer.tls, ["key", "cert"]);
  const capturedTransport = source.transport === undefined
    ? undefined
    : captureClosedDataObject(source.transport, [], [
        "retentionMs",
        "acknowledgementLifetimeMs",
        "maxBodyBytes",
        "rateLimit",
        "requestTimeoutMs",
        "leaseDurationMs",
        "maxResponseBytes",
      ]);
  const capturedRateLimit = capturedTransport?.rateLimit === undefined
    ? undefined
    : captureClosedDataObject(capturedTransport.rateLimit, ["requests", "windowMs"], [
        "maxPeers",
      ]);
  return Object.freeze({
    ...source,
    ...(capturedServer === undefined
      ? {}
      : {
          server: Object.freeze({
            ...capturedServer,
            ...(capturedTls === undefined ? {} : { tls: capturedTls }),
          }),
        }),
    ...(capturedTransport === undefined
      ? {}
      : {
          transport: Object.freeze({
            ...capturedTransport,
            ...(capturedRateLimit === undefined ? {} : { rateLimit: capturedRateLimit }),
          }),
        }),
  }) as unknown as Readonly<DacsLiveRoleServiceOptionsV1>;
}

function sameAuthority(left: unknown, right: unknown): boolean {
  return parseCanonicalClaimReference(left) !== null &&
    parseCanonicalClaimReference(right) !== null &&
    sameCanonicalClaimIdentity(left, right);
}

function demosAuthority(value: unknown): value is string {
  const parsed = parseCanonicalClaimReference(value);
  return parsed !== null && parsed.identity.scheme === "did" &&
    /^demos:agent:[0-9a-f]{64}$/.test(parsed.identity.identifier);
}

function safeDeadline(now: number, lifetimeMs: number): number {
  const deadline = now + lifetimeMs;
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(deadline) ||
      deadline <= now) {
    throw new DacsLiveRoleServiceError("service-message-time-overflow");
  }
  return deadline;
}

function snapshotReadiness(value: unknown): Readonly<DacsNodeReadinessStatus> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) =>
    key !== "ready" && key !== "checkedAt" && key !== "reasonCodes") ||
      typeof candidate.ready !== "boolean" ||
      typeof candidate.checkedAt !== "number" ||
      !Number.isSafeInteger(candidate.checkedAt) || candidate.checkedAt < 0 ||
      !Array.isArray(candidate.reasonCodes) ||
      candidate.reasonCodes.some((reason) => !validReasonCode(reason)) ||
      (candidate.ready && candidate.reasonCodes.length !== 0) ||
      (!candidate.ready && candidate.reasonCodes.length === 0)) {
    return undefined;
  }
  return Object.freeze({
    ready: candidate.ready,
    checkedAt: candidate.checkedAt,
    reasonCodes: Object.freeze([...candidate.reasonCodes] as string[]),
  });
}

function bindCallback<T extends (...args: never[]) => unknown>(value: T, owner: unknown): T {
  return Function.prototype.bind.call(value, owner) as T;
}

function writePublicJson(response: ServerResponse, status: number, value: unknown): void {
  let body: Buffer;
  try {
    body = Buffer.from(canonicalize(value), "utf8");
  } catch {
    status = 503;
    body = Buffer.from('{"error":"service-response-unavailable"}', "utf8");
  }
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.setHeader("content-length", String(body.byteLength));
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(body);
}

/**
 * Build one live actor process. The injected callbacks remain responsible for
 * SDK validation and irreversible adapter semantics; this host owns recovery,
 * transport, lifecycle scheduling, and sanitized operational projection.
 */
export function createDacsLiveRoleServiceV1(
  rawOptions: Readonly<DacsLiveRoleServiceOptionsV1>,
): Readonly<DacsLiveRoleServiceV1> {
  const options = captureServiceOptions(rawOptions);
  const config = validateDacsAgentConfig(options.config);
  if (config.mode !== "live-demos" || config.profile !== DACS_NODE_LIVE_PROFILE ||
      (config.role !== "buyer" && config.role !== "seller")) {
    throw new TypeError("live role service requires a buyer or seller live configuration");
  }
  const role = config.role;
  const database = options.database;
  if (database === null || typeof database !== "object" ||
      database.metadata.mode !== "live-demos" ||
      database.metadata.profile !== DACS_NODE_LIVE_PROFILE ||
      database.metadata.role !== role || !demosAuthority(database.metadata.authority)) {
    throw new TypeError("live role service database binding is incompatible");
  }
  const authority = database.metadata.authority;
  const peerAuthority = options.peerAuthority;
  const workerId = options.workerId;
  const workerIntervalMs = options.workerIntervalMs ?? DEFAULT_WORKER_INTERVAL_MS;
  const workerBatchSize = options.workerBatchSize ?? DEFAULT_WORKER_BATCH_SIZE;
  const readinessMaxAgeMs = options.readinessMaxAgeMs ?? DEFAULT_READINESS_MAX_AGE_MS;
  const coordinatorLeaseDurationMs = options.coordinatorLeaseDurationMs ?? 300_000;
  if (!nonEmpty(peerAuthority) || !demosAuthority(peerAuthority) ||
      sameAuthority(authority, peerAuthority) || !nonEmpty(workerId) ||
      !nonEmpty(options.peerEndpoint) ||
      typeof options.resolveIdentity !== "function" ||
      typeof options.validatePayload !== "function" ||
      typeof options.signTransportEnvelope !== "function" ||
      typeof options.createOperations !== "function" ||
      typeof options.handleMessage !== "function" ||
      (options.handleApplicationRequest !== undefined &&
        typeof options.handleApplicationRequest !== "function") ||
      (options.handlePublicRequest !== undefined &&
        typeof options.handlePublicRequest !== "function") ||
      (options.events !== undefined &&
        (options.events === null || typeof options.events !== "object" ||
          typeof options.events.emit !== "function")) ||
      (options.readiness !== undefined && typeof options.readiness !== "function") ||
      !safePositiveInteger(workerIntervalMs, 60_000) ||
      !safePositiveInteger(workerBatchSize, 1_000) ||
      !safePositiveInteger(readinessMaxAgeMs, 300_000) ||
      !safePositiveInteger(coordinatorLeaseDurationMs, 600_000)) {
    throw new TypeError("live role service options are invalid");
  }

  const resolveIdentity = bindCallback(options.resolveIdentity, options);
  const resolveConfiguredPeer: DacsHttpIdentityResolverV1 = async (input) => {
    if (!sameAuthority(input.sender, peerAuthority)) {
      return Object.freeze({ status: "rejected", reasonCode: "identity-unresolved" });
    }
    return resolveIdentity(input);
  };
  const validatePayload = bindCallback(options.validatePayload, options);
  const validateServicePayload: DacsHttpPayloadValidatorV1 = async (input) => {
    if (input.type === "diagnostic-probe-buyer" ||
        input.type === "diagnostic-probe-seller") {
      return validateDacsHttpDiagnosticProbePayloadV1(input.payload)
        ? Object.freeze({ status: "valid" as const })
        : Object.freeze({
            status: "invalid" as const,
            reasonCode: "diagnostic-probe-payload-invalid",
          });
    }
    return validatePayload(input);
  };
  const signTransportEnvelope = bindCallback(options.signTransportEnvelope, options);
  const createOperations = bindCallback(options.createOperations, options);
  const handleMessage = bindCallback(options.handleMessage, options);
  const handleApplicationRequest = options.handleApplicationRequest === undefined
    ? undefined
    : bindCallback(options.handleApplicationRequest, options);
  const handlePublicRequest = options.handlePublicRequest === undefined
    ? undefined
    : bindCallback(options.handlePublicRequest, options);
  const eventSink = options.events === undefined
    ? undefined
    : bindCallback(options.events.emit, options.events);
  const readinessProvider = options.readiness === undefined
    ? undefined
    : bindCallback(options.readiness, options);

  const inbox = database.createHttpInboxStore(
    options.transport?.retentionMs === undefined
      ? undefined
      : { retentionMs: options.transport.retentionMs },
  );
  const outbox = database.createHttpOutboxStore(
    options.transport?.retentionMs === undefined
      ? undefined
      : { retentionMs: options.transport.retentionMs },
  );
  const client: DacsHttpMessageClientV1 = createDacsHttpMessageClientV1({
    endpoint: options.peerEndpoint,
    authority,
    outbox,
    resolveIdentity: resolveConfiguredPeer,
    workerId,
    ...(options.transport?.retentionMs === undefined
      ? {} : { retentionMs: options.transport.retentionMs }),
    ...(options.transport?.requestTimeoutMs === undefined
      ? {} : { requestTimeoutMs: options.transport.requestTimeoutMs }),
    ...(options.transport?.leaseDurationMs === undefined
      ? {} : { leaseDurationMs: options.transport.leaseDurationMs }),
    ...(options.transport?.maxResponseBytes === undefined
      ? {} : { maxResponseBytes: options.transport.maxResponseBytes }),
  });

  let lifecycle: DacsLiveRoleServiceLifecycle = "stopped";
  let server: DacsHttpMessageServerV1 | undefined;
  let eventSequence = 0;
  let eventSinkFailed = false;
  let lastCycleAt: number | undefined;
  let lastSuccessAt: number | undefined;
  let lastWorkerReasonCode: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let workerAbort = new AbortController();
  let cycleTask: Promise<Readonly<DacsLiveRoleCycleReportV1>> | undefined;
  let startTask: Promise<void> | undefined;
  let stopTask: Promise<void> | undefined;

  const readTime = (): number => {
    try {
      const value = database.readTime();
      return Number.isSafeInteger(value) && value >= 0 ? value : Date.now();
    } catch {
      return Date.now();
    }
  };

  const emit = async (
    level: DacsNodeEventLevel,
    kind: DacsNodeEventKind,
    code: string,
    context?: Readonly<{
      jobId?: string;
      details?: Readonly<Record<string, string | number | boolean | null>>;
    }>,
  ): Promise<void> => {
    if (eventSink === undefined) return;
    eventSequence += 1;
    const event: DacsNodeEvent = Object.freeze({
      version: 1,
      sequence: eventSequence,
      occurredAt: readTime(),
      level,
      kind,
      code,
      role,
      ...(context?.jobId === undefined ? {} : { jobId: context.jobId }),
      ...(context?.details === undefined
        ? {} : { details: Object.freeze({ ...context.details }) }),
    });
    try {
      await eventSink(event);
    } catch {
      eventSinkFailed = true;
    }
  };

  const sendMessage: DacsLiveRoleRuntimeContextV1["sendMessage"] = async (
    input,
    options = {},
  ) => {
    if (lifecycle !== "starting" && lifecycle !== "running") {
      throw new DacsLiveRoleServiceError("service-not-running");
    }
    if (input === null || typeof input !== "object" ||
        !OUTBOUND_BY_ROLE[role].has(input.type)) {
      throw new DacsLiveRoleServiceError("service-message-role-incompatible");
    }
    const lifetimeMs = input.lifetimeMs ?? DACS_HTTP_MAX_ENVELOPE_LIFETIME_MS;
    if (!safePositiveInteger(lifetimeMs, DACS_HTTP_MAX_ENVELOPE_LIFETIME_MS)) {
      throw new DacsLiveRoleServiceError("service-message-lifetime-invalid");
    }
    const issuedAt = await outbox.readTime();
    const signed = await createDacsHttpEnvelopeV1({
      type: input.type,
      jobId: input.jobId,
      sender: authority,
      audience: peerAuthority,
      issuedAt,
      expiresAt: safeDeadline(issuedAt, lifetimeMs),
      nonce: generateDacsHttpNonceV1(),
      payload: input.payload,
    }, signTransportEnvelope);
    const acknowledgement = await client.send(
      signed as Readonly<DacsHttpEnvelopeV1>,
      options,
    );
    await emit("info", "transport", "transport-message-acknowledged", {
      jobId: input.jobId,
      details: {
        messageType: input.type,
        disposition: acknowledgement.envelope.type === "acknowledgement"
          ? acknowledgement.envelope.payload.disposition
          : "invalid",
      },
    });
    return acknowledgement;
  };

  const runtimeContext: Readonly<DacsLiveRoleRuntimeContextV1> = Object.freeze({
    role,
    authority,
    peerAuthority,
    sendMessage,
  });
  const coordinatorOperations = createOperations(runtimeContext);
  const coordinatorStore = database.createLiveCoordinatorStore(role);
  const coordinator = role === "buyer"
    ? createFixedPriceX402BuyerCoordinator({
        store: coordinatorStore,
        workerId,
        operations: coordinatorOperations,
        leaseDurationMs: coordinatorLeaseDurationMs,
      })
    : createFixedPriceX402SellerCoordinator({
        store: coordinatorStore,
        workerId,
        operations: coordinatorOperations,
        leaseDurationMs: coordinatorLeaseDurationMs,
      });
  const inboundContext: Readonly<DacsLiveRoleInboundContextV1> = Object.freeze({
    ...runtimeContext,
    coordinator,
  });

  const endpointOptions: DacsHttpMessageEndpointOptionsV1 = {
    authority,
    inbox,
    resolveIdentity: resolveConfiguredPeer,
    validatePayload: validateServicePayload,
    handleMessage: (authenticated) => {
      if (authenticated.envelope.type === "diagnostic-probe-buyer" ||
          authenticated.envelope.type === "diagnostic-probe-seller") {
        return Object.freeze({ disposition: "accepted" as const });
      }
      return handleMessage(authenticated, inboundContext);
    },
    signAcknowledgement: signTransportEnvelope,
    ...(options.transport?.retentionMs === undefined
      ? {} : { retentionMs: options.transport.retentionMs }),
    ...(options.transport?.acknowledgementLifetimeMs === undefined
      ? {} : { acknowledgementLifetimeMs: options.transport.acknowledgementLifetimeMs }),
    ...(options.transport?.maxBodyBytes === undefined
      ? {} : { maxBodyBytes: options.transport.maxBodyBytes }),
    ...(options.transport?.rateLimit === undefined
      ? {} : { rateLimit: options.transport.rateLimit }),
  };

  const performCycle = async (
    signal: AbortSignal | undefined,
  ): Promise<Readonly<DacsLiveRoleCycleReportV1>> => {
    const startedAt = readTime();
    const inboxReport = await resumeDacsHttpInboxV1(endpointOptions, {
      limit: workerBatchSize,
    });
    const coordinatorPage = await coordinator.resumePendingOrders({
      limit: workerBatchSize,
      ...(signal === undefined ? {} : { signal }),
    });
    const outboxReport = await client.runRunnable({
      limit: workerBatchSize,
      ...(signal === undefined ? {} : { signal }),
    });
    const completedAt = readTime();
    const report: DacsLiveRoleCycleReportV1 = Object.freeze({
      startedAt,
      completedAt,
      inbox: inboxReport,
      coordinator: Object.freeze({
        processed: coordinatorPage.items.length,
        ...(coordinatorPage.nextCursor === undefined
          ? {} : { nextCursor: coordinatorPage.nextCursor }),
      }),
      outbox: outboxReport,
    });
    lastCycleAt = completedAt;
    lastSuccessAt = completedAt;
    lastWorkerReasonCode = undefined;
    for (const item of coordinatorPage.items) {
      await emit("info", "order-progress", "order-track-processed", {
        jobId: item.jobId,
        details: {
          track: item.track,
          state: item.status,
          ...(item.outcome === undefined ? {} : { outcome: item.outcome }),
          ...(item.reasonCode === undefined ? {} : { reasonCode: item.reasonCode }),
        },
      });
    }
    await emit("debug", "service-lifecycle", "service-worker-cycle-complete", {
      details: {
        inboxInspected: inboxReport.inspected,
        coordinatorProcessed: coordinatorPage.items.length,
        outboxAttempted: outboxReport.attempted,
      },
    });
    return report;
  };

  const runOnce = async (
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<Readonly<DacsLiveRoleCycleReportV1>> => {
    if (lifecycle !== "starting" && lifecycle !== "running") {
      throw new DacsLiveRoleServiceError("service-not-running");
    }
    if (cycleTask !== undefined) return cycleTask;
    cycleTask = performCycle(options.signal).catch(async () => {
      lastCycleAt = readTime();
      lastWorkerReasonCode = "service-worker-cycle-failed";
      await emit("error", "operator-action", "service-worker-cycle-failed");
      throw new DacsLiveRoleServiceError("service-worker-cycle-failed");
    }).finally(() => {
      cycleTask = undefined;
    });
    return cycleTask;
  };

  const schedule = (delay = workerIntervalMs): void => {
    if (lifecycle !== "running") return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void runOnce({ signal: workerAbort.signal }).catch(() => undefined).finally(() => {
        schedule();
      });
    }, delay);
    timer.unref?.();
  };

  const readiness = async (): Promise<Readonly<DacsNodeReadinessStatus>> => {
    const now = readTime();
    if (lifecycle !== "running") {
      return Object.freeze({
        ready: false,
        checkedAt: now,
        reasonCodes: Object.freeze(["service-not-running"]),
      });
    }
    if (readinessProvider === undefined) {
      return Object.freeze({
        ready: false,
        checkedAt: now,
        reasonCodes: Object.freeze(["service-readiness-not-latched"]),
      });
    }
    try {
      const captured = snapshotReadiness(await readinessProvider());
      if (captured !== undefined) {
        const observedAt = readTime();
        if (captured.ready &&
            (captured.checkedAt > observedAt + READINESS_CLOCK_SKEW_MS ||
              observedAt - captured.checkedAt > readinessMaxAgeMs)) {
          return Object.freeze({
            ready: false,
            checkedAt: observedAt,
            reasonCodes: Object.freeze(["service-readiness-stale"]),
          });
        }
        return captured;
      }
    } catch {
      // Project only the bounded failure below.
    }
    return Object.freeze({
      ready: false,
      checkedAt: now,
      reasonCodes: Object.freeze(["service-readiness-check-failed"]),
    });
  };

  const health = async (): Promise<Readonly<DacsNodeHealthStatus>> => {
    const checkedAt = readTime();
    let databaseStatus: "healthy" | "unhealthy" = "healthy";
    try {
      if (database.diagnostics().quickCheck !== "ok") databaseStatus = "unhealthy";
    } catch {
      databaseStatus = "unhealthy";
    }
    const serviceStatus = lifecycle === "running" ? "healthy" : "unhealthy";
    const workerStatus = lastWorkerReasonCode === undefined ? "healthy" : "degraded";
    const eventStatus = eventSinkFailed ? "degraded" : "healthy";
    const overall = databaseStatus === "unhealthy" || serviceStatus === "unhealthy"
      ? "unhealthy"
      : workerStatus === "degraded" || eventStatus === "degraded"
      ? "degraded"
      : "healthy";
    return Object.freeze({
      status: overall,
      checkedAt,
      components: Object.freeze({
        service: Object.freeze({
          status: serviceStatus,
          ...(serviceStatus === "healthy" ? {} : { reasonCode: "service-not-running" }),
        }),
        database: Object.freeze({
          status: databaseStatus,
          ...(databaseStatus === "healthy" ? {} : { reasonCode: "service-database-unavailable" }),
        }),
        worker: Object.freeze({
          status: workerStatus,
          ...(lastWorkerReasonCode === undefined ? {} : { reasonCode: lastWorkerReasonCode }),
        }),
        events: Object.freeze({
          status: eventStatus,
          ...(eventSinkFailed ? { reasonCode: "service-event-sink-unavailable" } : {}),
        }),
      }),
    });
  };

  const status = async (): Promise<Readonly<DacsLiveRoleServiceStatusV1>> => {
    let inboxPending = false;
    let outboxPending = false;
    let outboxOperatorAction = false;
    let runnableSessions = 0;
    let sessionsTruncated = false;
    try {
      const [pendingInbox, pendingOutbox, operatorOutbox, runnable] = await Promise.all([
        inbox.list({ limit: 1, state: "pending" }).then((page) => page.items.length > 0),
        outbox.list({ limit: 1, state: "pending" }).then((page) => page.items.length > 0),
        outbox.list({ limit: 1, state: "operator-action" })
          .then((page) => page.items.length > 0),
        coordinatorStore.listRunnable({
          role,
          tracks: COORDINATOR_TRACKS_BY_ROLE[role],
          limit: workerBatchSize,
        }),
      ]);
      inboxPending = pendingInbox;
      outboxPending = pendingOutbox;
      outboxOperatorAction = operatorOutbox;
      runnableSessions = runnable.items.length;
      sessionsTruncated = runnable.nextCursor !== undefined;
    } catch {
      lastWorkerReasonCode = "service-status-store-unavailable";
    }
    return Object.freeze({
      version: 1,
      sdkVersion: database.metadata.sdkVersion,
      standardRevision: database.metadata.standardRevision,
      profile: DACS_NODE_LIVE_PROFILE,
      role,
      lifecycle,
      checkedAt: readTime(),
      ...(server === undefined ? {} : { endpoint: server.endpoint }),
      queues: Object.freeze({ inboxPending, outboxPending, outboxOperatorAction }),
      sessions: Object.freeze({
        runnable: runnableSessions,
        truncated: sessionsTruncated,
      }),
      worker: Object.freeze({
        running: cycleTask !== undefined,
        ...(lastCycleAt === undefined ? {} : { lastCycleAt }),
        ...(lastSuccessAt === undefined ? {} : { lastSuccessAt }),
        ...(lastWorkerReasonCode === undefined ? {} : { reasonCode: lastWorkerReasonCode }),
      }),
    });
  };

  const auxiliaryRequest = (request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      if (request.method !== "GET") {
        response.setHeader("allow", "GET");
        writePublicJson(response, 405, { error: "service-method-not-allowed" });
        return;
      }
      if (request.url === "/health") {
        writePublicJson(response, 200, await health());
        return;
      }
      if (request.url === "/ready") {
        const result = await readiness();
        writePublicJson(response, result.ready ? 200 : 503, result);
        return;
      }
      if (request.url === "/status") {
        writePublicJson(response, 200, await status());
        return;
      }
      if (handlePublicRequest !== undefined) {
        if (await handlePublicRequest(request, response)) return;
        if (response.headersSent || response.writableEnded) return;
      }
      if (handleApplicationRequest !== undefined) {
        const ready = await readiness();
        if (!ready.ready) {
          writePublicJson(response, 503, { error: "service-not-ready" });
          return;
        }
        if (await handleApplicationRequest(request, response, inboundContext)) return;
        if (response.headersSent || response.writableEnded) return;
      }
      writePublicJson(response, 404, { error: "service-route-not-found" });
    })().catch(() => {
      if (!response.headersSent) {
        writePublicJson(response, 503, { error: "service-route-unavailable" });
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  };

  const start = async (): Promise<void> => {
    if (lifecycle === "running") return;
    if (startTask !== undefined) return startTask;
    if (lifecycle !== "stopped") {
      throw new DacsLiveRoleServiceError("service-transition-in-progress");
    }
    startTask = (async () => {
      lifecycle = "starting";
      workerAbort = new AbortController();
      await emit("info", "service-lifecycle", "service-starting");
      try {
        await resumeDacsHttpInboxV1(endpointOptions, { limit: workerBatchSize });
        server = await startDacsHttpMessageServerV1({
          ...endpointOptions,
          hostname: options.server?.hostname ?? "127.0.0.1",
          port: options.server?.port ?? 0,
          ...(options.server?.tls === undefined ? {} : { tls: options.server.tls }),
          ...(options.server?.requestTimeoutMs === undefined
            ? {} : { requestTimeoutMs: options.server.requestTimeoutMs }),
          handleNonTransportRequest: auxiliaryRequest,
        });
        await runOnce({ signal: workerAbort.signal });
        lifecycle = "running";
        schedule();
        await emit("info", "service-lifecycle", "service-started");
      } catch {
        if (server !== undefined) {
          await server.close().catch(() => undefined);
          server = undefined;
        }
        lifecycle = "stopped";
        lastWorkerReasonCode = "service-start-failed";
        await emit("error", "service-lifecycle", "service-start-failed");
        throw new DacsLiveRoleServiceError("service-start-failed");
      }
    })().finally(() => {
      startTask = undefined;
    });
    return startTask;
  };

  const stop = async (): Promise<void> => {
    if ((lifecycle as DacsLiveRoleServiceLifecycle) === "stopped") return;
    if (stopTask !== undefined) return stopTask;
    if (lifecycle === "starting") await startTask?.catch(() => undefined);
    if (lifecycle === "stopped") return;
    stopTask = (async () => {
      lifecycle = "stopping";
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      workerAbort.abort();
      await cycleTask?.catch(() => undefined);
      if (server !== undefined) {
        await server.close();
        server = undefined;
      }
      lifecycle = "stopped";
      await emit("info", "service-lifecycle", "service-stopped");
    })().finally(() => {
      stopTask = undefined;
    });
    return stopTask;
  };

  const service: DacsLiveRoleServiceV1 = {
    role,
    authority,
    peerAuthority,
    get endpoint() {
      return server?.endpoint;
    },
    coordinator,
    start,
    stop,
    async startOrder(order) {
      const created = await coordinator.startOrder(order);
      if (lifecycle === "running") schedule(0);
      await emit("info", "order-progress", "order-started", {
        jobId: created.jobId,
        details: { milestone: created.milestone },
      });
      return created;
    },
    getOrderStatus: (jobId) => coordinator.getOrderStatus(jobId),
    sendMessage,
    runOnce,
    health,
    readiness,
    status,
  };
  return Object.freeze(service);
}

export function createDacsBuyerServiceV1(
  options: Readonly<DacsLiveRoleServiceOptionsV1>,
): Readonly<DacsLiveRoleServiceV1> {
  const service = createDacsLiveRoleServiceV1(options);
  if (service.role !== "buyer") throw new TypeError("buyer service requires buyer configuration");
  return service;
}

export function createDacsSellerServiceV1(
  options: Readonly<DacsLiveRoleServiceOptionsV1>,
): Readonly<DacsLiveRoleServiceV1> {
  const service = createDacsLiveRoleServiceV1(options);
  if (service.role !== "seller") throw new TypeError("seller service requires seller configuration");
  return service;
}

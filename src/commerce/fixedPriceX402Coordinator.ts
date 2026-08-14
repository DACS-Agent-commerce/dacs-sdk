import { types as nodeTypes } from "node:util";

import { canonicalize, sha256Hex } from "../canonical/index.js";
import { DacsError } from "../errors.js";
import { requireCanonicalJobId } from "../negotiate/jobId.js";
import {
  captureFixedPriceX402ProtocolBinding,
  type FixedPriceX402ProtocolBinding,
} from "./fixedPriceX402Protocol.js";

export const FIXED_PRICE_X402_COORDINATOR_STORE_VERSION = 2 as const;

export type FixedPriceX402CoordinatorRole = "buyer" | "seller";

export type FixedPriceX402Track =
  | "agreement"
  | "payment"
  | "payment-evidence"
  | "delivery"
  | "buyer-received"
  | "delivery-evidence"
  | "audit";

export type FixedPriceX402TrackState =
  | "not-started"
  | "running"
  | "pending-retry"
  | "indeterminate"
  | "final"
  | "operator-action";

export type FixedPriceX402NormativeOutcome = "success" | "failure" | "aborted";

export type FixedPriceX402ErrorClass =
  | "permanent"
  | "transient"
  | "counterparty"
  | "substrate"
  | "settlement-atomicity";

export type FixedPriceX402Milestone =
  | "created"
  | "agreement-final"
  | "payment-final"
  | "delivery-ready"
  | "buyer-received"
  | "commercial-performance-complete"
  | "actor-audit-final"
  | "audit-complete"
  | "terminal-failure"
  | "terminal-aborted";

export interface FixedPriceX402BuyerSdkJobPointers {
  role: "buyer";
  agreement: string;
  payment: string;
  paymentEvidence: string;
  buyerReceived: string;
  audit: string;
}

export interface FixedPriceX402SellerSdkJobPointers {
  role: "seller";
  agreement: string;
  payment: string;
  paymentEvidence: string;
  fulfilment: string;
  deliveryEvidence: string;
  audit: string;
}

export type FixedPriceX402SdkJobPointers =
  | FixedPriceX402BuyerSdkJobPointers
  | FixedPriceX402SellerSdkJobPointers;

export interface FixedPriceX402OrderIdentity {
  jobId: string;
  buyer: string;
  seller: string;
  protocol: Readonly<FixedPriceX402ProtocolBinding>;
}

export interface FixedPriceX402OrderInput extends FixedPriceX402OrderIdentity {
  /** Role-local pointers; these are deliberately excluded from the shared binding hash. */
  sdkJobs: Readonly<FixedPriceX402SdkJobPointers>;
}

export interface FixedPriceX402TrackLease {
  owner: string;
  generation: number;
  expiresAt: number;
}

export interface FixedPriceX402TrackRecord {
  state: FixedPriceX402TrackState;
  generation: number;
  attempts: number;
  updatedAt: number;
  nextAttemptAt?: number;
  reference?: string;
  authenticationHash?: string;
  outcome?: FixedPriceX402NormativeOutcome;
  errorClass?: FixedPriceX402ErrorClass;
  reasonCode?: string;
  lease?: Readonly<FixedPriceX402TrackLease>;
}

export type FixedPriceX402TrackMap = Readonly<
  Partial<Record<FixedPriceX402Track, Readonly<FixedPriceX402TrackRecord>>>
>;

export interface FixedPriceX402OrderRecord {
  storeVersion: typeof FIXED_PRICE_X402_COORDINATOR_STORE_VERSION;
  revision: number;
  role: FixedPriceX402CoordinatorRole;
  jobId: string;
  buyer: string;
  seller: string;
  protocol: Readonly<FixedPriceX402ProtocolBinding>;
  bindingHash: string;
  sdkJobs: Readonly<FixedPriceX402SdkJobPointers>;
  tracks: FixedPriceX402TrackMap;
  createdAt: number;
  updatedAt: number;
}

export type FixedPriceX402OrderLoad =
  | { status: "missing" }
  | { status: "ok"; record: Readonly<FixedPriceX402OrderRecord> }
  | { status: "unsupported"; version: number }
  | { status: "corrupt"; reason: string };

export type FixedPriceX402OrderCreate =
  | { status: "created" | "existing"; record: Readonly<FixedPriceX402OrderRecord> }
  | { status: "conflict" }
  | { status: "unsupported"; version: number }
  | { status: "corrupt"; reason: string };

export type FixedPriceX402TrackClaim =
  | {
      status: "acquired";
      record: Readonly<FixedPriceX402OrderRecord>;
      lease: Readonly<FixedPriceX402TrackLease>;
    }
  | {
      status: "waiting";
      record: Readonly<FixedPriceX402OrderRecord>;
      lease: Readonly<FixedPriceX402TrackLease>;
    }
  | { status: "not-runnable"; record: Readonly<FixedPriceX402OrderRecord> }
  | { status: "missing" | "stale" }
  | { status: "unsupported"; version: number }
  | { status: "corrupt"; reason: string };

export type FixedPriceX402TrackOperationResult =
  | {
      status: "final";
      outcome: "success" | "aborted";
      reference: string;
      authenticationHash?: string;
    }
  | {
      status: "final";
      outcome: "failure";
      errorClass: FixedPriceX402ErrorClass;
      reference: string;
      authenticationHash?: string;
    }
  | {
      status: "pending-retry" | "indeterminate" | "operator-action";
      reasonCode: string;
      retryAt?: number;
    };

export type FixedPriceX402TrackWrite =
  | { status: "recorded" | "existing"; record: Readonly<FixedPriceX402OrderRecord> }
  | { status: "missing" | "stale" | "conflict" }
  | { status: "unsupported"; version: number }
  | { status: "corrupt"; reason: string };

export interface FixedPriceX402Page<T> {
  items: readonly T[];
  nextCursor?: string;
}

export interface FixedPriceX402CoordinatorStore {
  /** Store-authoritative time, normally provided by the durable database. */
  readTime(): Promise<number>;
  create(input: Readonly<{
    role: FixedPriceX402CoordinatorRole;
    order: Readonly<FixedPriceX402OrderInput>;
    bindingHash: string;
  }>): Promise<FixedPriceX402OrderCreate>;
  load(
    role: FixedPriceX402CoordinatorRole,
    jobId: string,
  ): Promise<FixedPriceX402OrderLoad>;
  /** Cursor-based query over only orders with runnable role-owned tracks. */
  listRunnable(input: Readonly<{
    role: FixedPriceX402CoordinatorRole;
    tracks: readonly FixedPriceX402Track[];
    cursor?: string;
    limit: number;
  }>): Promise<FixedPriceX402Page<Readonly<FixedPriceX402OrderRecord>>>;
  claim(input: Readonly<{
    role: FixedPriceX402CoordinatorRole;
    jobId: string;
    bindingHash: string;
    track: FixedPriceX402Track;
    owner: string;
    leaseDurationMs: number;
  }>): Promise<FixedPriceX402TrackClaim>;
  isCurrent(input: Readonly<{
    role: FixedPriceX402CoordinatorRole;
    jobId: string;
    bindingHash: string;
    track: FixedPriceX402Track;
    lease: Readonly<FixedPriceX402TrackLease>;
  }>): Promise<boolean>;
  record(input: Readonly<{
    role: FixedPriceX402CoordinatorRole;
    jobId: string;
    bindingHash: string;
    track: FixedPriceX402Track;
    lease: Readonly<FixedPriceX402TrackLease>;
    result: Readonly<FixedPriceX402TrackOperationResult>;
  }>): Promise<FixedPriceX402TrackWrite>;
  requeue(input: Readonly<{
    role: FixedPriceX402CoordinatorRole;
    jobId: string;
    bindingHash: string;
    track: FixedPriceX402Track;
    operatorReasonCode: string;
    retryAt?: number;
  }>): Promise<FixedPriceX402TrackWrite>;
}

export interface FixedPriceX402EffectFence {
  role: FixedPriceX402CoordinatorRole;
  jobId: string;
  bindingHash: string;
  track: FixedPriceX402Track;
  owner: string;
  generation: number;
  idempotencyKey: string;
  assertCurrent(): Promise<void>;
}

export interface FixedPriceX402TrackOperationInput {
  order: Readonly<FixedPriceX402OrderRecord>;
  fence: Readonly<FixedPriceX402EffectFence>;
}

export type FixedPriceX402TrackOperation = (
  input: Readonly<FixedPriceX402TrackOperationInput>,
) => Promise<FixedPriceX402TrackOperationResult> | FixedPriceX402TrackOperationResult;

export type FixedPriceX402Operations = Readonly<
  Partial<Record<FixedPriceX402Track, FixedPriceX402TrackOperation>>
>;

export interface FixedPriceX402CoordinatorOptions {
  role: FixedPriceX402CoordinatorRole;
  store: FixedPriceX402CoordinatorStore;
  workerId: string;
  operations: FixedPriceX402Operations;
  leaseDurationMs?: number;
}

export interface FixedPriceX402OrderStatus {
  role: FixedPriceX402CoordinatorRole;
  jobId: string;
  buyer: string;
  seller: string;
  protocol: Readonly<FixedPriceX402ProtocolBinding>;
  bindingHash: string;
  sdkJobs: Readonly<FixedPriceX402SdkJobPointers>;
  tracks: FixedPriceX402TrackMap;
  milestone: Exclude<FixedPriceX402Milestone, "audit-complete">;
  attention: Readonly<{
    required: boolean;
    tracks: readonly FixedPriceX402Track[];
  }>;
  revision: number;
  updatedAt: number;
}

export interface FixedPriceX402CombinedOrderStatus {
  jobId: string;
  buyer: string;
  seller: string;
  protocol: Readonly<FixedPriceX402ProtocolBinding>;
  bindingHash: string;
  actors: Readonly<{
    buyer: Readonly<FixedPriceX402OrderStatus>;
    seller: Readonly<FixedPriceX402OrderStatus>;
  }>;
  milestone: FixedPriceX402Milestone;
  attention: Readonly<{
    required: boolean;
    tracks: readonly Readonly<{
      role: FixedPriceX402CoordinatorRole;
      track: FixedPriceX402Track;
    }>[];
  }>;
  updatedAt: number;
}

export interface FixedPriceX402WorkReport {
  jobId: string;
  track: FixedPriceX402Track;
  status:
    | FixedPriceX402TrackOperationResult["status"]
    | "waiting"
    | "stale"
    | "skipped";
  outcome?: FixedPriceX402NormativeOutcome;
  reasonCode?: string;
}

export interface FixedPriceX402CommerceCoordinator {
  readonly role: FixedPriceX402CoordinatorRole;
  startOrder(order: Readonly<FixedPriceX402OrderInput>): Promise<FixedPriceX402OrderStatus>;
  getOrderStatus(jobId: string): Promise<FixedPriceX402OrderStatus | null>;
  runPending(options?: Readonly<{
    cursor?: string;
    limit?: number;
    signal?: AbortSignal;
  }>): Promise<FixedPriceX402Page<FixedPriceX402WorkReport>>;
  resumePendingOrders(options?: Readonly<{
    cursor?: string;
    limit?: number;
    signal?: AbortSignal;
  }>): Promise<FixedPriceX402Page<FixedPriceX402WorkReport>>;
  repairTrack(input: Readonly<{
    jobId: string;
    track: FixedPriceX402Track;
    operatorReasonCode: string;
    retryAt?: number;
  }>): Promise<FixedPriceX402OrderStatus>;
}

const TRACKS = Object.freeze([
  "agreement",
  "payment",
  "payment-evidence",
  "delivery",
  "buyer-received",
  "delivery-evidence",
  "audit",
] as const satisfies readonly FixedPriceX402Track[]);

const TRACKS_BY_ROLE = Object.freeze({
  buyer: Object.freeze([
    "agreement",
    "payment",
    "payment-evidence",
    "buyer-received",
    "audit",
  ] as const satisfies readonly FixedPriceX402Track[]),
  seller: Object.freeze([
    "agreement",
    "payment",
    "payment-evidence",
    "delivery",
    "delivery-evidence",
    "audit",
  ] as const satisfies readonly FixedPriceX402Track[]),
});

const HASH_RE = /^[0-9a-f]{64}$/;
const REASON_CODE_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const ERROR_CLASSES = new Set<FixedPriceX402ErrorClass>([
  "permanent",
  "transient",
  "counterparty",
  "substrate",
  "settlement-atomicity",
]);
const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_RUN_LIMIT = 10;
const INERT_RECEIVER = Object.freeze(Object.create(null)) as object;

const clone = <T>(value: T): T => structuredClone(value);
const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);
const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;
const safeUint = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 &&
  !Object.is(value, -0);

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      nodeTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key)) &&
    optional.every((key) => !hasOwn(value, key) || value[key] !== undefined);
}

function captureOwnData<T>(value: T, label: string): T {
  if (!plainRecord(value)) throw new DacsError(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new DacsError(`${label} must contain enumerable defined data properties only`);
    }
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) ||
        descriptor.value === undefined) {
      throw new DacsError(`${label} must contain enumerable defined data properties only`);
    }
  }
  try {
    return clone(value);
  } catch {
    throw new DacsError(`${label} must be structured-cloneable data`);
  }
}

function validReasonCode(value: unknown): value is string {
  return typeof value === "string" && REASON_CODE_RE.test(value);
}

function roleTracks(role: FixedPriceX402CoordinatorRole): readonly FixedPriceX402Track[] {
  return TRACKS_BY_ROLE[role];
}

function capturePointers(
  value: unknown,
  role: FixedPriceX402CoordinatorRole,
): FixedPriceX402SdkJobPointers {
  const pointers = captureOwnData(value, "coordinator SDK job pointers") as unknown as
    Record<string, unknown>;
  const keys = role === "buyer"
    ? ["role", "agreement", "payment", "paymentEvidence", "buyerReceived", "audit"]
    : [
        "role",
        "agreement",
        "payment",
        "paymentEvidence",
        "fulfilment",
        "deliveryEvidence",
        "audit",
      ];
  if (!exactKeys(pointers, keys) || pointers.role !== role ||
      keys.slice(1).some((key) => !nonEmpty(pointers[key]))) {
    throw new DacsError(`coordinator ${role} SDK job pointers are malformed`);
  }
  return pointers as unknown as FixedPriceX402SdkJobPointers;
}

function captureIdentity(value: unknown): FixedPriceX402OrderIdentity {
  const order = captureOwnData(value, "fixed-price x402 order identity") as unknown as
    Record<string, unknown>;
  if (!exactKeys(order, ["jobId", "buyer", "seller", "protocol"], ["sdkJobs"]) ||
      !nonEmpty(order.jobId) || !nonEmpty(order.buyer) || !nonEmpty(order.seller) ||
      order.buyer === order.seller) {
    throw new DacsError("fixed-price x402 order identity is malformed");
  }
  requireCanonicalJobId(order.jobId);
  const protocol = captureFixedPriceX402ProtocolBinding(order.protocol);
  if (protocol.orchestrator !== order.seller) {
    throw new DacsError("fixed-price x402 order does not pin the seller-orchestrator topology");
  }
  return {
    jobId: order.jobId,
    buyer: order.buyer,
    seller: order.seller,
    protocol,
  };
}

function captureOrder(
  value: unknown,
  role: FixedPriceX402CoordinatorRole,
): FixedPriceX402OrderInput {
  const identity = captureIdentity(value);
  const raw = value as Record<string, unknown>;
  if (!hasOwn(raw, "sdkJobs")) throw new DacsError("coordinator SDK job pointers are required");
  return { ...identity, sdkJobs: capturePointers(raw.sdkJobs, role) };
}

export function fixedPriceX402OrderBindingHash(
  order: Readonly<FixedPriceX402OrderIdentity>,
): string {
  const captured = captureIdentity(order);
  return sha256Hex(canonicalize({
    coordinatorVersion: FIXED_PRICE_X402_COORDINATOR_STORE_VERSION,
    ...captured,
  }));
}

function emptyTracks(
  role: FixedPriceX402CoordinatorRole,
  now: number,
): Partial<Record<FixedPriceX402Track, FixedPriceX402TrackRecord>> {
  return Object.fromEntries(roleTracks(role).map((track) => [
    track,
    { state: "not-started", generation: 0, attempts: 0, updatedAt: now },
  ])) as Partial<Record<FixedPriceX402Track, FixedPriceX402TrackRecord>>;
}

function validLease(value: unknown): value is FixedPriceX402TrackLease {
  return plainRecord(value) && exactKeys(value, ["owner", "generation", "expiresAt"]) &&
    nonEmpty(value.owner) && safeUint(value.generation) && value.generation > 0 &&
    safeUint(value.expiresAt);
}

function validTrackRecord(value: unknown): value is FixedPriceX402TrackRecord {
  if (!plainRecord(value) || !exactKeys(
    value,
    ["state", "generation", "attempts", "updatedAt"],
    [
      "nextAttemptAt",
      "reference",
      "authenticationHash",
      "outcome",
      "errorClass",
      "reasonCode",
      "lease",
    ],
  ) || ![
    "not-started",
    "running",
    "pending-retry",
    "indeterminate",
    "final",
    "operator-action",
  ].includes(value.state as string) || !safeUint(value.generation) ||
      value.generation !== value.attempts || !safeUint(value.updatedAt) ||
      (value.nextAttemptAt !== undefined && !safeUint(value.nextAttemptAt)) ||
      (value.reference !== undefined && !nonEmpty(value.reference)) ||
      (value.authenticationHash !== undefined &&
        (typeof value.authenticationHash !== "string" || !HASH_RE.test(value.authenticationHash))) ||
      (value.outcome !== undefined &&
        !["success", "failure", "aborted"].includes(value.outcome as string)) ||
      (value.errorClass !== undefined &&
        !ERROR_CLASSES.has(value.errorClass as FixedPriceX402ErrorClass)) ||
      (value.reasonCode !== undefined && !validReasonCode(value.reasonCode)) ||
      (value.lease !== undefined && !validLease(value.lease))) return false;
  if (value.state === "not-started") {
    return value.generation === 0 && value.lease === undefined &&
      value.nextAttemptAt === undefined && value.reference === undefined &&
      value.authenticationHash === undefined && value.outcome === undefined &&
      value.errorClass === undefined && value.reasonCode === undefined;
  }
  if (value.state === "running") {
    return value.lease !== undefined && value.lease.generation === value.generation &&
      value.nextAttemptAt === undefined && value.reference === undefined &&
      value.authenticationHash === undefined && value.outcome === undefined &&
      value.errorClass === undefined && value.reasonCode === undefined;
  }
  if (value.state === "final") {
    return value.lease === undefined && value.nextAttemptAt === undefined &&
      value.reasonCode === undefined && value.reference !== undefined &&
      value.outcome !== undefined &&
      ((value.outcome === "failure" && value.errorClass !== undefined) ||
        (value.outcome !== "failure" && value.errorClass === undefined));
  }
  return value.lease === undefined && value.reference === undefined &&
    value.authenticationHash === undefined && value.outcome === undefined &&
    value.errorClass === undefined && value.reasonCode !== undefined &&
    (value.state !== "operator-action" || value.nextAttemptAt === undefined);
}

function trackRecord(
  record: Readonly<FixedPriceX402OrderRecord>,
  track: FixedPriceX402Track,
): Readonly<FixedPriceX402TrackRecord> | undefined {
  return record.tracks[track];
}

function final(
  record: Readonly<FixedPriceX402OrderRecord>,
  track: FixedPriceX402Track,
): boolean {
  return trackRecord(record, track)?.state === "final";
}

function successful(
  record: Readonly<FixedPriceX402OrderRecord>,
  track: FixedPriceX402Track,
): boolean {
  const retained = trackRecord(record, track);
  return retained?.state === "final" && retained.outcome === "success";
}

function terminalPhaseOutcome(
  record: Readonly<FixedPriceX402OrderRecord>,
): FixedPriceX402NormativeOutcome | null {
  const tracks: readonly FixedPriceX402Track[] = record.role === "buyer"
    ? ["agreement", "payment", "buyer-received"]
    : ["agreement", "payment", "delivery"];
  for (const track of tracks) {
    const retained = trackRecord(record, track);
    if (retained?.state === "final" && retained.outcome !== "success") {
      return retained.outcome ?? null;
    }
  }
  return null;
}

function eligible(
  record: Readonly<FixedPriceX402OrderRecord>,
  track: FixedPriceX402Track,
): boolean {
  if (!roleTracks(record.role).includes(track)) return false;
  switch (track) {
    case "agreement":
      return true;
    case "payment":
      return successful(record, "agreement");
    case "payment-evidence":
      return final(record, "payment");
    case "delivery":
      return record.role === "seller" && successful(record, "payment");
    case "buyer-received":
      return record.role === "buyer" && successful(record, "payment");
    case "delivery-evidence":
      return record.role === "seller" && final(record, "delivery");
    case "audit": {
      const agreement = trackRecord(record, "agreement");
      if (agreement?.state === "final" && agreement.outcome !== "success") return true;
      const payment = trackRecord(record, "payment");
      if (payment?.state === "final" && payment.outcome !== "success") {
        return successful(record, "payment-evidence");
      }
      if (record.role === "buyer") {
        return successful(record, "payment-evidence") && final(record, "buyer-received");
      }
      return successful(record, "payment-evidence") &&
        successful(record, "delivery-evidence");
    }
  }
}

function trackOutcomeAllowed(
  record: Readonly<FixedPriceX402OrderRecord>,
  track: FixedPriceX402Track,
  outcome: FixedPriceX402NormativeOutcome,
): boolean {
  if (track === "payment-evidence" || track === "delivery-evidence") {
    return outcome === "success";
  }
  if (track === "audit") {
    return outcome === (terminalPhaseOutcome(record) ?? "success");
  }
  return true;
}

function dependencyViolation(record: Readonly<FixedPriceX402OrderRecord>): string | null {
  for (const track of roleTracks(record.role)) {
    const retained = record.tracks[track];
    if (!retained || retained.state === "not-started") continue;
    if (!eligible(record, track)) {
      return `coordinator ${track} track violates the role dependency DAG`;
    }
    if (retained.state === "final" && retained.outcome &&
        !trackOutcomeAllowed(record, track, retained.outcome)) {
      return `coordinator ${track} outcome contradicts the normative terminal path`;
    }
  }
  return null;
}

export function fixedPriceX402OrderViolation(value: unknown): string | null {
  if (!plainRecord(value) || !exactKeys(value, [
    "storeVersion",
    "revision",
    "role",
    "jobId",
    "buyer",
    "seller",
    "protocol",
    "bindingHash",
    "sdkJobs",
    "tracks",
    "createdAt",
    "updatedAt",
  ])) return "coordinator order fields are malformed";
  if (value.storeVersion !== FIXED_PRICE_X402_COORDINATOR_STORE_VERSION) {
    return "coordinator order version is unsupported";
  }
  if ((value.role !== "buyer" && value.role !== "seller") ||
      !safeUint(value.revision) || value.revision === 0 || !nonEmpty(value.jobId) ||
      !nonEmpty(value.buyer) || !nonEmpty(value.seller) || value.buyer === value.seller ||
      typeof value.bindingHash !== "string" || !HASH_RE.test(value.bindingHash) ||
      !safeUint(value.createdAt) || !safeUint(value.updatedAt) ||
      value.updatedAt < value.createdAt) {
    return "coordinator order identity is malformed";
  }
  let protocol: FixedPriceX402ProtocolBinding;
  let sdkJobs: FixedPriceX402SdkJobPointers;
  try {
    requireCanonicalJobId(value.jobId);
    protocol = captureFixedPriceX402ProtocolBinding(value.protocol);
    sdkJobs = capturePointers(value.sdkJobs, value.role);
    if (protocol.orchestrator !== value.seller) {
      return "coordinator order has an unsupported orchestrator topology";
    }
    const expected = fixedPriceX402OrderBindingHash({
      jobId: value.jobId,
      buyer: value.buyer,
      seller: value.seller,
      protocol,
    });
    if (expected !== value.bindingHash) return "coordinator order binding hash differs";
  } catch (error) {
    return error instanceof DacsError ? error.message : "coordinator order identity is malformed";
  }
  if (!plainRecord(value.tracks) || !exactKeys(value.tracks, roleTracks(value.role))) {
    return "coordinator role-local track map is malformed";
  }
  for (const track of roleTracks(value.role)) {
    const retained = value.tracks[track];
    if (!validTrackRecord(retained) || retained.updatedAt < value.createdAt ||
        retained.updatedAt > value.updatedAt) {
      return `coordinator ${track} track is malformed`;
    }
  }
  return dependencyViolation(value as unknown as FixedPriceX402OrderRecord);
}

function copyRecord(record: Readonly<FixedPriceX402OrderRecord>): FixedPriceX402OrderRecord {
  return clone(record);
}

function requireCoordinatorRecord(
  value: unknown,
  role: FixedPriceX402CoordinatorRole,
  expectedBindingHash?: string,
): FixedPriceX402OrderRecord {
  const violation = fixedPriceX402OrderViolation(value);
  if (violation) throw new DacsError(violation);
  const record = clone(value as FixedPriceX402OrderRecord);
  if (record.role !== role ||
      (expectedBindingHash !== undefined && record.bindingHash !== expectedBindingHash)) {
    throw new DacsError("coordinator store returned a different actor/order binding");
  }
  return record;
}

function key(role: FixedPriceX402CoordinatorRole, jobId: string): string {
  return `${role}:${jobId}`;
}

function isRunnableTrack(
  record: Readonly<FixedPriceX402OrderRecord>,
  track: FixedPriceX402Track,
  now: number,
): boolean {
  const retained = trackRecord(record, track);
  if (!retained || !eligible(record, track) || retained.state === "final" ||
      retained.state === "operator-action") return false;
  if (retained.nextAttemptAt !== undefined && retained.nextAttemptAt > now) return false;
  return retained.lease === undefined || retained.lease.expiresAt <= now;
}

export function createInMemoryFixedPriceX402CoordinatorStore(
  options: Readonly<{ now?: () => number }> = {},
): FixedPriceX402CoordinatorStore {
  if (!plainRecord(options) || !exactKeys(options, [], ["now"]) ||
      (options.now !== undefined && typeof options.now !== "function")) {
    throw new DacsError("in-memory coordinator store options are malformed");
  }
  const clock = options.now ?? Date.now;
  const records = new Map<string, FixedPriceX402OrderRecord>();
  const readTime = (): number => {
    const value = Reflect.apply(clock, INERT_RECEIVER, []);
    if (!safeUint(value)) throw new DacsError("coordinator store clock is invalid");
    return value;
  };
  const stamp = (record: Readonly<FixedPriceX402OrderRecord>, value = readTime()): number =>
    Math.max(record.updatedAt, value);
  const loadRecord = (
    role: FixedPriceX402CoordinatorRole,
    jobId: string,
  ): FixedPriceX402OrderLoad => {
    const found = records.get(key(role, jobId));
    if (!found) return { status: "missing" };
    const violation = fixedPriceX402OrderViolation(found);
    return violation
      ? { status: "corrupt", reason: violation }
      : { status: "ok", record: copyRecord(found) };
  };
  const save = (
    current: Readonly<FixedPriceX402OrderRecord>,
    next: FixedPriceX402OrderRecord,
  ): FixedPriceX402OrderRecord => {
    next.revision = current.revision + 1;
    const violation = fixedPriceX402OrderViolation(next);
    if (violation) throw new DacsError(violation);
    records.set(key(next.role, next.jobId), copyRecord(next));
    return copyRecord(next);
  };

  return {
    async readTime() {
      return readTime();
    },

    async create(input) {
      if (input.role !== "buyer" && input.role !== "seller") {
        return { status: "corrupt", reason: "coordinator role is malformed" };
      }
      let order: FixedPriceX402OrderInput;
      try {
        order = captureOrder(input.order, input.role);
      } catch (error) {
        return {
          status: "corrupt",
          reason: error instanceof DacsError ? error.message : "coordinator order is malformed",
        };
      }
      const expected = fixedPriceX402OrderBindingHash(order);
      if (input.bindingHash !== expected) return { status: "conflict" };
      const storageKey = key(input.role, order.jobId);
      const existing = records.get(storageKey);
      if (existing) {
        const violation = fixedPriceX402OrderViolation(existing);
        if (violation) return { status: "corrupt", reason: violation };
        return existing.bindingHash === expected &&
            canonicalize(existing.sdkJobs) === canonicalize(order.sdkJobs)
          ? { status: "existing", record: copyRecord(existing) }
          : { status: "conflict" };
      }
      const now = readTime();
      const record: FixedPriceX402OrderRecord = {
        storeVersion: FIXED_PRICE_X402_COORDINATOR_STORE_VERSION,
        revision: 1,
        role: input.role,
        jobId: order.jobId,
        buyer: order.buyer,
        seller: order.seller,
        protocol: clone(order.protocol),
        bindingHash: expected,
        sdkJobs: clone(order.sdkJobs),
        tracks: emptyTracks(input.role, now),
        createdAt: now,
        updatedAt: now,
      };
      const violation = fixedPriceX402OrderViolation(record);
      if (violation) return { status: "corrupt", reason: violation };
      records.set(storageKey, copyRecord(record));
      return { status: "created", record: copyRecord(record) };
    },

    async load(role, jobId) {
      return loadRecord(role, jobId);
    },

    async listRunnable(input) {
      if ((input.role !== "buyer" && input.role !== "seller") ||
          !Array.isArray(input.tracks) || input.tracks.some((track) =>
            !roleTracks(input.role).includes(track)
          ) || (input.cursor !== undefined && !nonEmpty(input.cursor)) ||
          !safeUint(input.limit) || input.limit === 0) {
        throw new DacsError("coordinator runnable query is malformed");
      }
      const now = readTime();
      const eligible = [...records.values()]
        .filter((record) => record.role === input.role &&
          (input.cursor === undefined || record.jobId > input.cursor) &&
          input.tracks.some((track) => isRunnableTrack(record, track, now)))
        .sort((left, right) => left.jobId.localeCompare(right.jobId));
      const selected = eligible.slice(0, input.limit);
      return {
        items: selected.map(copyRecord),
        ...(eligible.length > selected.length && selected.length > 0
          ? { nextCursor: selected.at(-1)!.jobId }
          : {}),
      };
    },

    async claim(input) {
      const loaded = loadRecord(input.role, input.jobId);
      if (loaded.status !== "ok") return loaded;
      const current = records.get(key(input.role, input.jobId))!;
      if (current.bindingHash !== input.bindingHash) return { status: "stale" };
      if (!roleTracks(input.role).includes(input.track) || !nonEmpty(input.owner) ||
          !safeUint(input.leaseDurationMs) || input.leaseDurationMs === 0) {
        return { status: "corrupt", reason: "coordinator track claim is malformed" };
      }
      const now = readTime();
      const retained = current.tracks[input.track]!;
      if (!eligible(current, input.track) || retained.state === "final" ||
          retained.state === "operator-action" ||
          (retained.nextAttemptAt !== undefined && retained.nextAttemptAt > now)) {
        return { status: "not-runnable", record: copyRecord(current) };
      }
      if (retained.lease && retained.lease.expiresAt > now) {
        return { status: "waiting", record: copyRecord(current), lease: clone(retained.lease) };
      }
      const expiresAt = now + input.leaseDurationMs;
      if (!Number.isSafeInteger(expiresAt)) {
        return { status: "corrupt", reason: "coordinator lease expiry overflows" };
      }
      const lease: FixedPriceX402TrackLease = {
        owner: input.owner,
        generation: retained.generation + 1,
        expiresAt,
      };
      const tracks = clone(current.tracks) as Partial<
        Record<FixedPriceX402Track, FixedPriceX402TrackRecord>
      >;
      tracks[input.track] = {
        state: "running",
        generation: lease.generation,
        attempts: retained.attempts + 1,
        updatedAt: stamp(current, now),
        lease,
      };
      const next: FixedPriceX402OrderRecord = {
        ...copyRecord(current),
        tracks,
        updatedAt: stamp(current, now),
      };
      return { status: "acquired", record: save(current, next), lease: clone(lease) };
    },

    async isCurrent(input) {
      const loaded = loadRecord(input.role, input.jobId);
      if (loaded.status !== "ok" || loaded.record.bindingHash !== input.bindingHash) return false;
      const retained = loaded.record.tracks[input.track];
      const now = readTime();
      return retained?.state === "running" && retained.lease !== undefined &&
        retained.lease.owner === input.lease.owner &&
        retained.lease.generation === input.lease.generation &&
        retained.lease.expiresAt === input.lease.expiresAt &&
        retained.lease.expiresAt > now;
    },

    async record(input) {
      const loaded = loadRecord(input.role, input.jobId);
      if (loaded.status !== "ok") return loaded;
      const current = records.get(key(input.role, input.jobId))!;
      if (current.bindingHash !== input.bindingHash ||
          !roleTracks(input.role).includes(input.track)) return { status: "stale" };
      const retained = current.tracks[input.track]!;
      const now = readTime();
      if (retained.state !== "running" || !retained.lease ||
          retained.lease.owner !== input.lease.owner ||
          retained.lease.generation !== input.lease.generation ||
          retained.lease.expiresAt !== input.lease.expiresAt ||
          retained.lease.expiresAt <= now) return { status: "stale" };
      let result: FixedPriceX402TrackOperationResult;
      try {
        result = captureOperationResult(input.result);
      } catch {
        return { status: "conflict" };
      }
      if (result.status === "final" &&
          !trackOutcomeAllowed(current, input.track, result.outcome)) {
        return { status: "conflict" };
      }
      const updatedAt = stamp(current, now);
      const nextTrack: FixedPriceX402TrackRecord = result.status === "final"
        ? {
            state: "final",
            generation: retained.generation,
            attempts: retained.attempts,
            updatedAt,
            reference: result.reference,
            outcome: result.outcome,
            ...(result.authenticationHash
              ? { authenticationHash: result.authenticationHash }
              : {}),
            ...(result.outcome === "failure" ? { errorClass: result.errorClass } : {}),
          }
        : {
            state: result.status,
            generation: retained.generation,
            attempts: retained.attempts,
            updatedAt,
            reasonCode: result.reasonCode,
            ...(result.retryAt === undefined ? {} : { nextAttemptAt: result.retryAt }),
          };
      const tracks = clone(current.tracks) as Partial<
        Record<FixedPriceX402Track, FixedPriceX402TrackRecord>
      >;
      tracks[input.track] = nextTrack;
      const next: FixedPriceX402OrderRecord = {
        ...copyRecord(current),
        tracks,
        updatedAt,
      };
      const violation = fixedPriceX402OrderViolation(next);
      if (violation) return { status: "conflict" };
      return { status: "recorded", record: save(current, next) };
    },

    async requeue(input) {
      const loaded = loadRecord(input.role, input.jobId);
      if (loaded.status !== "ok") return loaded;
      const current = records.get(key(input.role, input.jobId))!;
      if (current.bindingHash !== input.bindingHash ||
          !roleTracks(input.role).includes(input.track) ||
          !validReasonCode(input.operatorReasonCode) ||
          (input.retryAt !== undefined && !safeUint(input.retryAt))) {
        return { status: "conflict" };
      }
      const retained = current.tracks[input.track]!;
      const now = readTime();
      if (retained.state === "final" ||
          (retained.lease !== undefined && retained.lease.expiresAt > now)) {
        return { status: "stale" };
      }
      const updatedAt = stamp(current, now);
      const tracks = clone(current.tracks) as Partial<
        Record<FixedPriceX402Track, FixedPriceX402TrackRecord>
      >;
      tracks[input.track] = {
        state: "pending-retry",
        generation: retained.generation,
        attempts: retained.attempts,
        updatedAt,
        reasonCode: input.operatorReasonCode,
        ...(input.retryAt === undefined ? {} : { nextAttemptAt: input.retryAt }),
      };
      const next: FixedPriceX402OrderRecord = {
        ...copyRecord(current),
        tracks,
        updatedAt,
      };
      return { status: "recorded", record: save(current, next) };
    },
  };
}

function captureOperationResult(value: unknown): FixedPriceX402TrackOperationResult {
  const result = captureOwnData(value, "coordinator operation result") as unknown as
    Record<string, unknown>;
  if (result.status === "final" && (result.outcome === "success" ||
      result.outcome === "aborted") && exactKeys(
        result,
        ["status", "outcome", "reference"],
        ["authenticationHash"],
      ) && nonEmpty(result.reference) &&
      (result.authenticationHash === undefined ||
        (typeof result.authenticationHash === "string" && HASH_RE.test(result.authenticationHash)))) {
    return result as unknown as FixedPriceX402TrackOperationResult;
  }
  if (result.status === "final" && result.outcome === "failure" && exactKeys(
    result,
    ["status", "outcome", "errorClass", "reference"],
    ["authenticationHash"],
  ) && ERROR_CLASSES.has(result.errorClass as FixedPriceX402ErrorClass) &&
      nonEmpty(result.reference) &&
      (result.authenticationHash === undefined ||
        (typeof result.authenticationHash === "string" && HASH_RE.test(result.authenticationHash)))) {
    return result as unknown as FixedPriceX402TrackOperationResult;
  }
  if ((result.status === "pending-retry" || result.status === "indeterminate") &&
      exactKeys(result, ["status", "reasonCode", "retryAt"]) &&
      validReasonCode(result.reasonCode) && safeUint(result.retryAt)) {
    return result as unknown as FixedPriceX402TrackOperationResult;
  }
  if (result.status === "operator-action" &&
      exactKeys(result, ["status", "reasonCode"]) && validReasonCode(result.reasonCode)) {
    return result as unknown as FixedPriceX402TrackOperationResult;
  }
  throw new DacsError("coordinator operation result is malformed");
}

function projectLocalMilestone(
  record: Readonly<FixedPriceX402OrderRecord>,
): Exclude<FixedPriceX402Milestone, "audit-complete"> {
  const audit = trackRecord(record, "audit");
  if (audit?.state === "final") {
    if (audit.outcome === "failure") return "terminal-failure";
    if (audit.outcome === "aborted") return "terminal-aborted";
    return "actor-audit-final";
  }
  if (record.role === "seller" && successful(record, "delivery-evidence")) {
    return "commercial-performance-complete";
  }
  if (record.role === "buyer" && successful(record, "buyer-received")) {
    return "buyer-received";
  }
  if (record.role === "seller" && successful(record, "delivery")) return "delivery-ready";
  if (successful(record, "payment")) return "payment-final";
  if (successful(record, "agreement")) return "agreement-final";
  return "created";
}

/** Local projections never claim global `audit-complete`. */
export function projectFixedPriceX402Milestone(
  record: Readonly<FixedPriceX402OrderRecord>,
): Exclude<FixedPriceX402Milestone, "audit-complete"> {
  const retained = requireCoordinatorRecord(record, record.role);
  return projectLocalMilestone(retained);
}

function statusAsRecord(value: Readonly<Record<string, unknown>>): unknown {
  return {
    storeVersion: FIXED_PRICE_X402_COORDINATOR_STORE_VERSION,
    revision: value.revision,
    role: value.role,
    jobId: value.jobId,
    buyer: value.buyer,
    seller: value.seller,
    protocol: value.protocol,
    bindingHash: value.bindingHash,
    sdkJobs: value.sdkJobs,
    tracks: value.tracks,
    createdAt: 0,
    updatedAt: value.updatedAt,
  };
}

export function fixedPriceX402OrderStatusViolation(value: unknown): string | null {
  if (!plainRecord(value) || !exactKeys(value, [
    "role",
    "jobId",
    "buyer",
    "seller",
    "protocol",
    "bindingHash",
    "sdkJobs",
    "tracks",
    "milestone",
    "attention",
    "revision",
    "updatedAt",
  ])) return "coordinator status fields are malformed";
  const recordViolation = fixedPriceX402OrderViolation(statusAsRecord(value));
  if (recordViolation) return recordViolation;
  const record = statusAsRecord(value) as FixedPriceX402OrderRecord;
  const projected = projectLocalMilestone(record);
  if (value.milestone !== projected || value.milestone === "audit-complete") {
    return "coordinator status milestone is inconsistent with its role-local tracks";
  }
  if (!plainRecord(value.attention) || !exactKeys(value.attention, ["required", "tracks"]) ||
      typeof value.attention.required !== "boolean" || !Array.isArray(value.attention.tracks) ||
      !value.attention.tracks.every((track) => roleTracks(record.role).includes(
        track as FixedPriceX402Track,
      ))) {
    return "coordinator status attention projection is malformed";
  }
  const expected = roleTracks(record.role).filter(
    (track) => record.tracks[track]?.state === "operator-action",
  );
  if (value.attention.required !== (expected.length > 0) ||
      canonicalize(value.attention.tracks) !== canonicalize(expected)) {
    return "coordinator status attention projection is inconsistent";
  }
  return null;
}

function projectStatus(
  record: Readonly<FixedPriceX402OrderRecord>,
): FixedPriceX402OrderStatus {
  const retained = requireCoordinatorRecord(record, record.role);
  const attentionTracks = roleTracks(retained.role).filter(
    (track) => retained.tracks[track]?.state === "operator-action",
  );
  return clone({
    role: retained.role,
    jobId: retained.jobId,
    buyer: retained.buyer,
    seller: retained.seller,
    protocol: retained.protocol,
    bindingHash: retained.bindingHash,
    sdkJobs: retained.sdkJobs,
    tracks: retained.tracks,
    milestone: projectLocalMilestone(retained),
    attention: {
      required: attentionTracks.length > 0,
      tracks: attentionTracks,
    },
    revision: retained.revision,
    updatedAt: retained.updatedAt,
  });
}

function captureOptions(value: unknown): {
  role: FixedPriceX402CoordinatorRole;
  store: FixedPriceX402CoordinatorStore;
  workerId: string;
  operations: Map<FixedPriceX402Track, FixedPriceX402TrackOperation>;
  leaseDurationMs: number;
} {
  if (!plainRecord(value) || !exactKeys(
    value,
    ["role", "store", "workerId", "operations"],
    ["leaseDurationMs"],
  ) || (value.role !== "buyer" && value.role !== "seller") ||
      !nonEmpty(value.workerId) || !plainRecord(value.store) ||
      !plainRecord(value.operations)) {
    throw new DacsError("fixed-price x402 coordinator options are malformed");
  }
  const store = value.store as unknown as FixedPriceX402CoordinatorStore;
  for (const method of [
    "readTime",
    "create",
    "load",
    "listRunnable",
    "claim",
    "isCurrent",
    "record",
    "requeue",
  ] as const) {
    if (typeof store[method] !== "function") {
      throw new DacsError(`fixed-price x402 coordinator store.${method} is required`);
    }
  }
  const operations = new Map<FixedPriceX402Track, FixedPriceX402TrackOperation>();
  for (const operationKey of Reflect.ownKeys(value.operations)) {
    if (typeof operationKey !== "string" ||
        !roleTracks(value.role).includes(operationKey as FixedPriceX402Track) ||
        typeof value.operations[operationKey] !== "function") {
      throw new DacsError(
        `fixed-price x402 ${value.role} coordinator operation is not role-owned`,
      );
    }
    operations.set(
      operationKey as FixedPriceX402Track,
      value.operations[operationKey] as FixedPriceX402TrackOperation,
    );
  }
  const leaseDurationMs = value.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  if (!safeUint(leaseDurationMs) || leaseDurationMs === 0) {
    throw new DacsError("fixed-price x402 coordinator leaseDurationMs must be positive");
  }
  return {
    role: value.role,
    store,
    workerId: value.workerId,
    operations,
    leaseDurationMs,
  };
}

/**
 * Combine independently retained actor projections without joining wallet or
 * signing authority. Role-local SDK pointers are intentionally allowed to
 * differ; only the shared protocol binding must match.
 */
export function combineFixedPriceX402OrderStatus(input: Readonly<{
  buyer: Readonly<FixedPriceX402OrderStatus>;
  seller: Readonly<FixedPriceX402OrderStatus>;
}>): FixedPriceX402CombinedOrderStatus {
  const captured = captureOwnData(input, "combined coordinator status input");
  const buyer = captureOwnData(captured.buyer, "buyer coordinator status");
  const seller = captureOwnData(captured.seller, "seller coordinator status");
  const buyerViolation = fixedPriceX402OrderStatusViolation(buyer);
  const sellerViolation = fixedPriceX402OrderStatusViolation(seller);
  if (buyerViolation || sellerViolation) {
    throw new DacsError(buyerViolation ?? sellerViolation!);
  }
  if (buyer.role !== "buyer" || seller.role !== "seller" ||
      buyer.jobId !== seller.jobId || buyer.buyer !== seller.buyer ||
      buyer.seller !== seller.seller || buyer.bindingHash !== seller.bindingHash ||
      canonicalize(buyer.protocol) !== canonicalize(seller.protocol)) {
    throw new DacsError("buyer and seller coordinator statuses do not bind the same order");
  }
  const expectedBinding = fixedPriceX402OrderBindingHash({
    jobId: buyer.jobId,
    buyer: buyer.buyer,
    seller: buyer.seller,
    protocol: buyer.protocol,
  });
  if (buyer.bindingHash !== expectedBinding) {
    throw new DacsError("combined coordinator status has an invalid order binding");
  }
  const buyerAudit = buyer.tracks.audit;
  const sellerAudit = seller.tracks.audit;
  let milestone: FixedPriceX402Milestone;
  if (buyerAudit?.state === "final" && sellerAudit?.state === "final") {
    if (buyerAudit.outcome !== sellerAudit.outcome) {
      throw new DacsError("actor audit outcomes contradict the shared terminal session");
    }
    milestone = buyerAudit.outcome === "failure"
      ? "terminal-failure"
      : buyerAudit.outcome === "aborted"
        ? "terminal-aborted"
        : "audit-complete";
  } else if (seller.tracks["delivery-evidence"]?.state === "final" &&
      seller.tracks["delivery-evidence"]?.outcome === "success") {
    milestone = "commercial-performance-complete";
  } else if (buyer.tracks["buyer-received"]?.state === "final" &&
      buyer.tracks["buyer-received"]?.outcome === "success") {
    milestone = "buyer-received";
  } else if (seller.tracks.delivery?.state === "final" &&
      seller.tracks.delivery?.outcome === "success") {
    milestone = "delivery-ready";
  } else if (buyer.tracks.payment?.state === "final" &&
      buyer.tracks.payment?.outcome === "success" &&
      seller.tracks.payment?.state === "final" &&
      seller.tracks.payment?.outcome === "success") {
    milestone = "payment-final";
  } else if (buyer.tracks.agreement?.state === "final" &&
      buyer.tracks.agreement?.outcome === "success" &&
      seller.tracks.agreement?.state === "final" &&
      seller.tracks.agreement?.outcome === "success") {
    milestone = "agreement-final";
  } else {
    milestone = "created";
  }
  const attentionTracks = ([buyer, seller] as const).flatMap((status) =>
    roleTracks(status.role)
      .filter((track) => status.tracks[track]?.state === "operator-action")
      .map((track) => ({ role: status.role, track }))
  );
  return clone({
    jobId: buyer.jobId,
    buyer: buyer.buyer,
    seller: buyer.seller,
    protocol: buyer.protocol,
    bindingHash: buyer.bindingHash,
    actors: { buyer, seller },
    milestone,
    attention: {
      required: attentionTracks.length > 0,
      tracks: attentionTracks,
    },
    updatedAt: Math.max(buyer.updatedAt, seller.updatedAt),
  });
}

function runLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_RUN_LIMIT;
  if (!safeUint(value) || value === 0) {
    throw new DacsError("coordinator run limit must be a positive safe integer");
  }
  return value;
}

function runCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!nonEmpty(value)) throw new DacsError("coordinator run cursor is malformed");
  return value;
}

function pointerForTrack(
  pointers: Readonly<FixedPriceX402SdkJobPointers>,
  track: FixedPriceX402Track,
): string {
  if (pointers.role === "buyer") {
    switch (track) {
      case "agreement": return pointers.agreement;
      case "payment": return pointers.payment;
      case "payment-evidence": return pointers.paymentEvidence;
      case "buyer-received": return pointers.buyerReceived;
      case "audit": return pointers.audit;
      default: throw new DacsError("buyer coordinator cannot resolve a seller-local track");
    }
  }
  switch (track) {
    case "agreement": return pointers.agreement;
    case "payment": return pointers.payment;
    case "payment-evidence": return pointers.paymentEvidence;
    case "delivery": return pointers.fulfilment;
    case "delivery-evidence": return pointers.deliveryEvidence;
    case "audit": return pointers.audit;
    default: throw new DacsError("seller coordinator cannot resolve a buyer-local track");
  }
}

function requireTrackWrite(
  value: FixedPriceX402TrackWrite,
  label: string,
): FixedPriceX402OrderRecord {
  if (value.status === "corrupt") throw new DacsError(value.reason);
  if (value.status === "unsupported") {
    throw new DacsError(`coordinator store version ${value.version} is unsupported`);
  }
  if (value.status !== "recorded" && value.status !== "existing") {
    throw new DacsError(`${label} is stale or conflicts with retained state`);
  }
  return clone(value.record);
}

export function createFixedPriceX402CommerceCoordinator(
  options: FixedPriceX402CoordinatorOptions,
): FixedPriceX402CommerceCoordinator {
  const captured = captureOptions(options);

  const get = async (jobId: string): Promise<FixedPriceX402OrderRecord | null> => {
    requireCanonicalJobId(jobId);
    const loaded = clone(await captured.store.load(captured.role, jobId));
    if (loaded.status === "missing") return null;
    if (loaded.status !== "ok") {
      throw new DacsError(
        loaded.status === "corrupt"
          ? loaded.reason
          : `coordinator store version ${loaded.version} is unsupported`,
      );
    }
    return requireCoordinatorRecord(loaded.record, captured.role);
  };

  const run = async (
    input: Readonly<{ cursor?: string; limit?: number; signal?: AbortSignal }> = {},
  ): Promise<FixedPriceX402Page<FixedPriceX402WorkReport>> => {
    if (!plainRecord(input) || !exactKeys(input, [], ["cursor", "limit", "signal"]) ||
        (input.signal !== undefined && !(input.signal instanceof AbortSignal))) {
      throw new DacsError("coordinator run options are malformed");
    }
    const cursor = runCursor(input.cursor);
    const limit = runLimit(input.limit);
    const page = clone(await captured.store.listRunnable({
      role: captured.role,
      tracks: [...captured.operations.keys()],
      cursor,
      limit,
    }));
    if (!plainRecord(page) || !exactKeys(page, ["items"], ["nextCursor"]) ||
        !Array.isArray(page.items) || page.items.length > limit ||
        (page.nextCursor !== undefined && !nonEmpty(page.nextCursor))) {
      throw new DacsError("coordinator store returned a malformed runnable page");
    }
    const runnableRecords = page.items.map((rawRecord) =>
      requireCoordinatorRecord(rawRecord, captured.role)
    );
    let previousJobId = cursor;
    for (const record of runnableRecords) {
      if (previousJobId !== undefined && record.jobId <= previousJobId) {
        throw new DacsError("coordinator runnable page is not cursor ordered");
      }
      previousJobId = record.jobId;
    }
    if (page.nextCursor !== undefined &&
        (runnableRecords.length === 0 || page.nextCursor !== runnableRecords.at(-1)!.jobId)) {
      throw new DacsError("coordinator runnable page has an invalid next cursor");
    }
    const reports: FixedPriceX402WorkReport[] = [];
    let fullyVisitedRecords = 0;
    let lastFullyVisitedJobId: string | undefined;
    for (const runnableRecord of runnableRecords) {
      if (reports.length >= limit || input.signal?.aborted) break;
      let record = runnableRecord;
      const processed = new Set<FixedPriceX402Track>();
      let retainedStateStale = false;
      while (reports.length < limit && !input.signal?.aborted) {
        const now = await captured.store.readTime();
        if (!safeUint(now)) throw new DacsError("coordinator store returned invalid time");
        const track = roleTracks(captured.role).find((candidate) =>
          !processed.has(candidate) && captured.operations.has(candidate) &&
          isRunnableTrack(record, candidate, now)
        );
        if (!track) break;
        processed.add(track);
        const claim = clone(await captured.store.claim({
          role: captured.role,
          jobId: record.jobId,
          bindingHash: record.bindingHash,
          track,
          owner: captured.workerId,
          leaseDurationMs: captured.leaseDurationMs,
        }));
        if (claim.status !== "acquired") {
          if (claim.status === "corrupt") throw new DacsError(claim.reason);
          if (claim.status === "unsupported") {
            throw new DacsError(`coordinator store version ${claim.version} is unsupported`);
          }
          if (claim.status === "waiting" || claim.status === "not-runnable") {
            record = requireCoordinatorRecord(claim.record, captured.role, record.bindingHash);
          }
          if (!["waiting", "not-runnable", "missing", "stale"].includes(claim.status)) {
            throw new DacsError("coordinator store returned an unknown track-claim result");
          }
          reports.push({
            jobId: record.jobId,
            track,
            status: claim.status === "waiting" ? "waiting" :
              claim.status === "stale" ? "stale" : "skipped",
          });
          if (claim.status === "missing" || claim.status === "stale") {
            retainedStateStale = true;
            break;
          }
          continue;
        }
        record = requireCoordinatorRecord(claim.record, captured.role, record.bindingHash);
        const lease = clone(claim.lease);
        const retainedLease = record.tracks[track]?.lease;
        if (!validLease(lease) || !retainedLease ||
            canonicalize(lease) !== canonicalize(retainedLease)) {
          throw new DacsError("coordinator store returned an invalid track lease");
        }
        const roleLocalJob = pointerForTrack(record.sdkJobs, track);
        const fence: FixedPriceX402EffectFence = Object.freeze({
          role: captured.role,
          jobId: record.jobId,
          bindingHash: record.bindingHash,
          track,
          owner: lease.owner,
          generation: lease.generation,
          idempotencyKey: sha256Hex(canonicalize({
            bindingHash: record.bindingHash,
            role: captured.role,
            track,
            roleLocalJob,
          })),
          assertCurrent: async () => {
            const current = await captured.store.isCurrent({
              role: captured.role,
              jobId: record.jobId,
              bindingHash: record.bindingHash,
              track,
              lease,
            });
            if (!current) throw new DacsError("coordinator effect fence is stale");
          },
        });
        let result: FixedPriceX402TrackOperationResult;
        try {
          const raw = await Reflect.apply(captured.operations.get(track)!, INERT_RECEIVER, [{
            order: copyRecord(record),
            fence,
          }]);
          result = captureOperationResult(raw);
          if (result.status === "final" &&
              !trackOutcomeAllowed(record, track, result.outcome)) {
            result = { status: "operator-action", reasonCode: "invalid-normative-outcome" };
          }
        } catch {
          const observed = await captured.store.readTime();
          const retryAt = observed + 1_000;
          if (!safeUint(observed) || !Number.isSafeInteger(retryAt)) {
            throw new DacsError("coordinator retry time is invalid");
          }
          result = {
            status: "indeterminate",
            reasonCode: "operation-threw",
            retryAt,
          };
        }
        const written = clone(await captured.store.record({
          role: captured.role,
          jobId: record.jobId,
          bindingHash: record.bindingHash,
          track,
          lease,
          result,
        }));
        if (written.status === "recorded" || written.status === "existing") {
          record = requireCoordinatorRecord(
            written.record,
            captured.role,
            record.bindingHash,
          );
          reports.push({
            jobId: record.jobId,
            track,
            status: result.status,
            ...(result.status === "final"
              ? { outcome: result.outcome }
              : { reasonCode: result.reasonCode }),
          });
        } else if (written.status === "corrupt") {
          throw new DacsError(written.reason);
        } else if (written.status === "unsupported") {
          throw new DacsError(`coordinator store version ${written.version} is unsupported`);
        } else {
          if (!["missing", "stale", "conflict"].includes(written.status)) {
            throw new DacsError("coordinator store returned an unknown track-write result");
          }
          reports.push({ jobId: record.jobId, track, status: "stale" });
          retainedStateStale = true;
          break;
        }
      }
      if (!retainedStateStale && !input.signal?.aborted) {
        const observed = await captured.store.readTime();
        if (!safeUint(observed)) throw new DacsError("coordinator store returned invalid time");
        const hasUnprocessedRunnable = roleTracks(captured.role).some((candidate) =>
          !processed.has(candidate) && captured.operations.has(candidate) &&
          isRunnableTrack(record, candidate, observed)
        );
        if (!hasUnprocessedRunnable) {
          fullyVisitedRecords += 1;
          lastFullyVisitedJobId = record.jobId;
        }
      }
    }
    const nextCursor = fullyVisitedRecords === runnableRecords.length
      ? page.nextCursor
      : lastFullyVisitedJobId;
    return {
      items: clone(reports),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  };

  const coordinator: FixedPriceX402CommerceCoordinator = {
    role: captured.role,
    async startOrder(input) {
      const order = captureOrder(input, captured.role);
      const bindingHash = fixedPriceX402OrderBindingHash(order);
      const created = clone(await captured.store.create({
        role: captured.role,
        order,
        bindingHash,
      }));
      if (created.status === "conflict") {
        throw new DacsError("coordinator order conflicts with an existing binding or local pointer set");
      }
      if (created.status === "corrupt") throw new DacsError(created.reason);
      if (created.status === "unsupported") {
        throw new DacsError(`coordinator store version ${created.version} is unsupported`);
      }
      if (created.status !== "created" && created.status !== "existing") {
        throw new DacsError("coordinator store returned an unknown order-create result");
      }
      return projectStatus(requireCoordinatorRecord(
        created.record,
        captured.role,
        bindingHash,
      ));
    },
    async getOrderStatus(jobId) {
      const record = await get(jobId);
      return record ? projectStatus(record) : null;
    },
    runPending: run,
    resumePendingOrders: run,
    async repairTrack(input) {
      if (!plainRecord(input) || !exactKeys(
        input,
        ["jobId", "track", "operatorReasonCode"],
        ["retryAt"],
      ) || !nonEmpty(input.jobId) || !roleTracks(captured.role).includes(input.track) ||
          !validReasonCode(input.operatorReasonCode) ||
          (input.retryAt !== undefined && !safeUint(input.retryAt))) {
        throw new DacsError("coordinator repair request is malformed");
      }
      const record = await get(input.jobId);
      if (!record) throw new DacsError("coordinator repair target is missing");
      const repaired = requireTrackWrite(clone(await captured.store.requeue({
        role: captured.role,
        jobId: record.jobId,
        bindingHash: record.bindingHash,
        track: input.track,
        operatorReasonCode: input.operatorReasonCode,
        ...(input.retryAt === undefined ? {} : { retryAt: input.retryAt }),
      })), "coordinator repair request");
      return projectStatus(requireCoordinatorRecord(
        repaired,
        captured.role,
        record.bindingHash,
      ));
    },
  };
  return Object.freeze(coordinator);
}

export function createFixedPriceX402BuyerCoordinator(
  options: Omit<FixedPriceX402CoordinatorOptions, "role">,
): FixedPriceX402CommerceCoordinator {
  return createFixedPriceX402CommerceCoordinator({ ...options, role: "buyer" });
}

export function createFixedPriceX402SellerCoordinator(
  options: Omit<FixedPriceX402CoordinatorOptions, "role">,
): FixedPriceX402CommerceCoordinator {
  return createFixedPriceX402CommerceCoordinator({ ...options, role: "seller" });
}

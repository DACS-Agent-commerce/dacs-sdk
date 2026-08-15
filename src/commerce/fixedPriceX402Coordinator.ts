import { types as nodeTypes } from "node:util";

import { canonicalize, sha256Hex } from "../canonical/index.js";
import { DacsError } from "../errors.js";
import {
  isCanonicalClaimReference,
  parseCanonicalClaimReference,
  sameCanonicalClaimIdentity,
} from "../identity/claimReference.js";
import { requireCanonicalJobId } from "../negotiate/jobId.js";
import {
  captureFixedPriceOfflineProtocolBinding,
  FIXED_PRICE_OFFLINE_COORDINATOR_DOMAIN,
  fixedPriceOfflineProtocolBindingHash,
  type FixedPriceOfflineProtocolBinding,
} from "./fixedPriceOfflineProtocol.js";
import {
  captureFixedPriceX402ProtocolBinding,
  fixedPriceX402ProtocolBindingHash,
  type FixedPriceX402ProtocolBinding,
} from "./fixedPriceX402Protocol.js";

export const FIXED_PRICE_X402_COORDINATOR_STORE_VERSION = 3 as const;

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

/** Absolute role attribution retained for later DACS-5 v0.3 bundle review. */
export type FixedPriceX402FaultedParty = "buyer" | "seller" | "orchestrator" | "none";

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

type FixedPriceCoordinatorProtocolBinding = Readonly<{ orchestrator: string }>;

interface FixedPriceCoordinatorOrderIdentity<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
> {
  jobId: string;
  buyer: string;
  seller: string;
  protocol: Readonly<Protocol>;
}

interface FixedPriceCoordinatorOrderInput<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
> extends FixedPriceCoordinatorOrderIdentity<Protocol> {
  /** Role-local pointers; these are deliberately excluded from the shared binding hash. */
  sdkJobs: Readonly<FixedPriceX402SdkJobPointers>;
}

export interface FixedPriceX402OrderIdentity
  extends FixedPriceCoordinatorOrderIdentity<FixedPriceX402ProtocolBinding> {}
export interface FixedPriceX402OrderInput
  extends FixedPriceCoordinatorOrderInput<FixedPriceX402ProtocolBinding> {}
export interface FixedPriceOfflineOrderIdentity
  extends FixedPriceCoordinatorOrderIdentity<FixedPriceOfflineProtocolBinding> {}
export interface FixedPriceOfflineOrderInput
  extends FixedPriceCoordinatorOrderInput<FixedPriceOfflineProtocolBinding> {}

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
  faultedParty?: FixedPriceX402FaultedParty;
  withdrawnBy?: FixedPriceX402CoordinatorRole;
  reasonCode?: string;
  lease?: Readonly<FixedPriceX402TrackLease>;
}

export type FixedPriceX402TrackMap = Readonly<
  Partial<Record<FixedPriceX402Track, Readonly<FixedPriceX402TrackRecord>>>
>;

interface FixedPriceCoordinatorOrderRecord<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
> {
  storeVersion: typeof FIXED_PRICE_X402_COORDINATOR_STORE_VERSION;
  revision: number;
  role: FixedPriceX402CoordinatorRole;
  jobId: string;
  buyer: string;
  seller: string;
  /** Shared cross-actor protocol binding. */
  protocol: Readonly<Protocol>;
  /** Shared cross-actor order hash; never contains role-local SDK pointers. */
  bindingHash: string;
  /** Role-local integrity hash over role + bindingHash + the exact sdkJobs set. */
  localBindingHash: string;
  sdkJobs: Readonly<FixedPriceX402SdkJobPointers>;
  tracks: FixedPriceX402TrackMap;
  createdAt: number;
  updatedAt: number;
}

export interface FixedPriceX402OrderRecord
  extends FixedPriceCoordinatorOrderRecord<FixedPriceX402ProtocolBinding> {}
export interface FixedPriceOfflineOrderRecord
  extends FixedPriceCoordinatorOrderRecord<FixedPriceOfflineProtocolBinding> {}

type FixedPriceCoordinatorOrderLoad<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
> =
  | { status: "missing" }
  | { status: "ok"; record: Readonly<FixedPriceCoordinatorOrderRecord<Protocol>> }
  | { status: "unsupported"; version: number }
  | { status: "corrupt"; reason: string };

type FixedPriceCoordinatorOrderCreate<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
> =
  | {
      status: "created" | "existing";
      record: Readonly<FixedPriceCoordinatorOrderRecord<Protocol>>;
    }
  | { status: "conflict" }
  | { status: "unsupported"; version: number }
  | { status: "corrupt"; reason: string };

type FixedPriceCoordinatorTrackClaim<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
> =
  | {
      status: "acquired";
      record: Readonly<FixedPriceCoordinatorOrderRecord<Protocol>>;
      lease: Readonly<FixedPriceX402TrackLease>;
    }
  | {
      status: "waiting";
      record: Readonly<FixedPriceCoordinatorOrderRecord<Protocol>>;
      lease: Readonly<FixedPriceX402TrackLease>;
    }
  | {
      status: "not-runnable";
      record: Readonly<FixedPriceCoordinatorOrderRecord<Protocol>>;
    }
  | { status: "missing" | "stale" }
  | { status: "unsupported"; version: number }
  | { status: "corrupt"; reason: string };

export type FixedPriceX402TrackOperationResult =
  | {
      status: "final";
      outcome: "success";
      reference: string;
      authenticationHash?: string;
    }
  | {
      status: "final";
      outcome: "aborted";
      withdrawnBy: FixedPriceX402CoordinatorRole;
      reference: string;
      authenticationHash?: string;
    }
  | {
      status: "final";
      outcome: "failure";
      errorClass: FixedPriceX402ErrorClass;
      faultedParty: FixedPriceX402FaultedParty;
      reference: string;
      authenticationHash?: string;
    }
  | {
      status: "pending-retry" | "indeterminate" | "operator-action";
      reasonCode: string;
      retryAt?: number;
    };

type FixedPriceCoordinatorTrackWrite<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
> =
  | {
      status: "recorded" | "existing";
      record: Readonly<FixedPriceCoordinatorOrderRecord<Protocol>>;
    }
  | { status: "missing" | "stale" | "conflict" }
  | { status: "unsupported"; version: number }
  | { status: "corrupt"; reason: string };

export type FixedPriceX402OrderLoad =
  FixedPriceCoordinatorOrderLoad<FixedPriceX402ProtocolBinding>;
export type FixedPriceX402OrderCreate =
  FixedPriceCoordinatorOrderCreate<FixedPriceX402ProtocolBinding>;
export type FixedPriceX402TrackClaim =
  FixedPriceCoordinatorTrackClaim<FixedPriceX402ProtocolBinding>;
export type FixedPriceX402TrackWrite =
  FixedPriceCoordinatorTrackWrite<FixedPriceX402ProtocolBinding>;
export type FixedPriceOfflineOrderLoad =
  FixedPriceCoordinatorOrderLoad<FixedPriceOfflineProtocolBinding>;
export type FixedPriceOfflineOrderCreate =
  FixedPriceCoordinatorOrderCreate<FixedPriceOfflineProtocolBinding>;
export type FixedPriceOfflineTrackClaim =
  FixedPriceCoordinatorTrackClaim<FixedPriceOfflineProtocolBinding>;
export type FixedPriceOfflineTrackWrite =
  FixedPriceCoordinatorTrackWrite<FixedPriceOfflineProtocolBinding>;

export interface FixedPriceX402Page<T> {
  items: readonly T[];
  nextCursor?: string;
}

interface FixedPriceCoordinatorStore<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
> {
  /** Store-authoritative time, normally provided by the durable database. */
  readTime(): Promise<number>;
  create(input: Readonly<{
    role: FixedPriceX402CoordinatorRole;
    order: Readonly<FixedPriceCoordinatorOrderInput<Protocol>>;
    bindingHash: string;
    localBindingHash: string;
  }>): Promise<FixedPriceCoordinatorOrderCreate<Protocol>>;
  load(
    role: FixedPriceX402CoordinatorRole,
    jobId: string,
  ): Promise<FixedPriceCoordinatorOrderLoad<Protocol>>;
  /** Cursor-based query over only orders with runnable role-owned tracks. */
  listRunnable(input: Readonly<{
    role: FixedPriceX402CoordinatorRole;
    tracks: readonly FixedPriceX402Track[];
    cursor?: string;
    limit: number;
  }>): Promise<FixedPriceX402Page<Readonly<FixedPriceCoordinatorOrderRecord<Protocol>>>>;
  claim(input: Readonly<{
    role: FixedPriceX402CoordinatorRole;
    jobId: string;
    bindingHash: string;
    localBindingHash: string;
    track: FixedPriceX402Track;
    owner: string;
    leaseDurationMs: number;
  }>): Promise<FixedPriceCoordinatorTrackClaim<Protocol>>;
  isCurrent(input: Readonly<{
    role: FixedPriceX402CoordinatorRole;
    jobId: string;
    bindingHash: string;
    localBindingHash: string;
    track: FixedPriceX402Track;
    lease: Readonly<FixedPriceX402TrackLease>;
  }>): Promise<boolean>;
  record(input: Readonly<{
    role: FixedPriceX402CoordinatorRole;
    jobId: string;
    bindingHash: string;
    localBindingHash: string;
    track: FixedPriceX402Track;
    lease: Readonly<FixedPriceX402TrackLease>;
    result: Readonly<FixedPriceX402TrackOperationResult>;
  }>): Promise<FixedPriceCoordinatorTrackWrite<Protocol>>;
  requeue(input: Readonly<{
    role: FixedPriceX402CoordinatorRole;
    jobId: string;
    bindingHash: string;
    localBindingHash: string;
    track: FixedPriceX402Track;
    operatorReasonCode: string;
    retryAt?: number;
  }>): Promise<FixedPriceCoordinatorTrackWrite<Protocol>>;
}

export interface FixedPriceX402CoordinatorStore
  extends FixedPriceCoordinatorStore<FixedPriceX402ProtocolBinding> {}

export interface FixedPriceOfflineCoordinatorStore
  extends FixedPriceCoordinatorStore<FixedPriceOfflineProtocolBinding> {}

export interface FixedPriceX402EffectFence {
  role: FixedPriceX402CoordinatorRole;
  jobId: string;
  bindingHash: string;
  localBindingHash: string;
  track: FixedPriceX402Track;
  owner: string;
  generation: number;
  idempotencyKey: string;
  assertCurrent(): Promise<void>;
}

interface FixedPriceCoordinatorTrackOperationInput<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
> {
  order: Readonly<FixedPriceCoordinatorOrderRecord<Protocol>>;
  fence: Readonly<FixedPriceX402EffectFence>;
  /**
   * Cooperative cancellation owned by the scheduler. Adapters must still
   * reconcile an irreversible effect once submission may have occurred.
   */
  signal?: AbortSignal;
}

type FixedPriceCoordinatorTrackOperation<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
> = (
  input: Readonly<FixedPriceCoordinatorTrackOperationInput<Protocol>>,
) => Promise<FixedPriceX402TrackOperationResult> | FixedPriceX402TrackOperationResult;

type FixedPriceCoordinatorOperations<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
> = Readonly<
  Partial<Record<FixedPriceX402Track, FixedPriceCoordinatorTrackOperation<Protocol>>>
>;

interface FixedPriceCoordinatorOptions<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
> {
  role: FixedPriceX402CoordinatorRole;
  store: FixedPriceCoordinatorStore<Protocol>;
  workerId: string;
  operations: FixedPriceCoordinatorOperations<Protocol>;
  leaseDurationMs?: number;
}

interface FixedPriceCoordinatorOrderStatus<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
> {
  role: FixedPriceX402CoordinatorRole;
  jobId: string;
  buyer: string;
  seller: string;
  protocol: Readonly<Protocol>;
  bindingHash: string;
  localBindingHash: string;
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

interface FixedPriceCoordinatorCombinedOrderStatus<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
> {
  jobId: string;
  buyer: string;
  seller: string;
  protocol: Readonly<Protocol>;
  bindingHash: string;
  actors: Readonly<{
    buyer: Readonly<FixedPriceCoordinatorOrderStatus<Protocol>>;
    seller: Readonly<FixedPriceCoordinatorOrderStatus<Protocol>>;
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

export interface FixedPriceX402TrackOperationInput
  extends FixedPriceCoordinatorTrackOperationInput<FixedPriceX402ProtocolBinding> {}
export type FixedPriceX402TrackOperation =
  FixedPriceCoordinatorTrackOperation<FixedPriceX402ProtocolBinding>;
export type FixedPriceX402Operations =
  FixedPriceCoordinatorOperations<FixedPriceX402ProtocolBinding>;
export interface FixedPriceX402CoordinatorOptions
  extends FixedPriceCoordinatorOptions<FixedPriceX402ProtocolBinding> {}
export interface FixedPriceX402OrderStatus
  extends FixedPriceCoordinatorOrderStatus<FixedPriceX402ProtocolBinding> {}
export interface FixedPriceX402CombinedOrderStatus
  extends FixedPriceCoordinatorCombinedOrderStatus<FixedPriceX402ProtocolBinding> {}

export interface FixedPriceOfflineTrackOperationInput
  extends FixedPriceCoordinatorTrackOperationInput<FixedPriceOfflineProtocolBinding> {}
export type FixedPriceOfflineTrackOperation =
  FixedPriceCoordinatorTrackOperation<FixedPriceOfflineProtocolBinding>;
export type FixedPriceOfflineOperations =
  FixedPriceCoordinatorOperations<FixedPriceOfflineProtocolBinding>;
export interface FixedPriceOfflineCoordinatorOptions
  extends FixedPriceCoordinatorOptions<FixedPriceOfflineProtocolBinding> {}
export interface FixedPriceOfflineOrderStatus
  extends FixedPriceCoordinatorOrderStatus<FixedPriceOfflineProtocolBinding> {}
export interface FixedPriceOfflineCombinedOrderStatus
  extends FixedPriceCoordinatorCombinedOrderStatus<FixedPriceOfflineProtocolBinding> {}

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

interface FixedPriceCommerceCoordinator<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
> {
  readonly role: FixedPriceX402CoordinatorRole;
  startOrder(
    order: Readonly<FixedPriceCoordinatorOrderInput<Protocol>>,
  ): Promise<FixedPriceCoordinatorOrderStatus<Protocol>>;
  getOrderStatus(
    jobId: string,
  ): Promise<FixedPriceCoordinatorOrderStatus<Protocol> | null>;
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
  }>): Promise<FixedPriceCoordinatorOrderStatus<Protocol>>;
}

export interface FixedPriceX402CommerceCoordinator
  extends FixedPriceCommerceCoordinator<FixedPriceX402ProtocolBinding> {}

export interface FixedPriceOfflineCommerceCoordinator
  extends FixedPriceCommerceCoordinator<FixedPriceOfflineProtocolBinding> {}

export type FixedPriceOfflineCoordinatorRole = FixedPriceX402CoordinatorRole;
export type FixedPriceOfflineTrack = FixedPriceX402Track;
export type FixedPriceOfflineTrackState = FixedPriceX402TrackState;
export type FixedPriceOfflineNormativeOutcome = FixedPriceX402NormativeOutcome;
export type FixedPriceOfflineErrorClass = FixedPriceX402ErrorClass;
export type FixedPriceOfflineMilestone = FixedPriceX402Milestone;
export type FixedPriceOfflineEffectFence = FixedPriceX402EffectFence;

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
const FAULTED_PARTIES = new Set<FixedPriceX402FaultedParty>([
  "buyer",
  "seller",
  "orchestrator",
  "none",
]);
const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_RUN_LIMIT = 10;
const INERT_RECEIVER = Object.freeze(Object.create(null)) as object;

interface FixedPriceCoordinatorProfilePolicy<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
> {
  readonly label: "fixed-price x402" | "fixed-price offline";
  captureProtocol(value: unknown): Protocol;
  protocolHash(protocol: Readonly<Protocol>): string;
  bindingHash(
    identity: Readonly<FixedPriceCoordinatorOrderIdentity<Protocol>>,
  ): string;
  idempotencyPayload(input: Readonly<{
    localBindingHash: string;
    role: FixedPriceX402CoordinatorRole;
    track: FixedPriceX402Track;
    roleLocalJob: string;
  }>): Readonly<Record<string, unknown>>;
}

const X402_PROFILE_POLICY: FixedPriceCoordinatorProfilePolicy<
  FixedPriceX402ProtocolBinding
> = Object.freeze({
  label: "fixed-price x402",
  captureProtocol: captureFixedPriceX402ProtocolBinding,
  protocolHash: fixedPriceX402ProtocolBindingHash,
  bindingHash: (identity: Readonly<FixedPriceX402OrderIdentity>) =>
    sha256Hex(canonicalize({
      coordinatorVersion: FIXED_PRICE_X402_COORDINATOR_STORE_VERSION,
      jobId: identity.jobId,
      buyer: parseCanonicalClaimReference(identity.buyer)!.identity,
      seller: parseCanonicalClaimReference(identity.seller)!.identity,
      protocolHash: fixedPriceX402ProtocolBindingHash(identity.protocol),
    })),
  idempotencyPayload: (input: Readonly<{
    localBindingHash: string;
    role: FixedPriceX402CoordinatorRole;
    track: FixedPriceX402Track;
    roleLocalJob: string;
  }>) => input,
});

const OFFLINE_PROFILE_POLICY: FixedPriceCoordinatorProfilePolicy<
  FixedPriceOfflineProtocolBinding
> = Object.freeze({
  label: "fixed-price offline",
  captureProtocol: captureFixedPriceOfflineProtocolBinding,
  protocolHash: fixedPriceOfflineProtocolBindingHash,
  bindingHash: (identity: Readonly<FixedPriceOfflineOrderIdentity>) =>
    sha256Hex(canonicalize({
      coordinatorDomain: FIXED_PRICE_OFFLINE_COORDINATOR_DOMAIN,
      coordinatorVersion: FIXED_PRICE_X402_COORDINATOR_STORE_VERSION,
      jobId: identity.jobId,
      buyer: parseCanonicalClaimReference(identity.buyer)!.identity,
      seller: parseCanonicalClaimReference(identity.seller)!.identity,
      protocolHash: fixedPriceOfflineProtocolBindingHash(identity.protocol),
    })),
  idempotencyPayload: (input: Readonly<{
    localBindingHash: string;
    role: FixedPriceX402CoordinatorRole;
    track: FixedPriceX402Track;
    roleLocalJob: string;
  }>) => ({
    coordinatorDomain: FIXED_PRICE_OFFLINE_COORDINATOR_DOMAIN,
    ...input,
  }),
});

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

function storeObject(value: unknown): value is object {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    !nodeTypes.isProxy(value);
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

function captureIdentity<Protocol extends FixedPriceCoordinatorProtocolBinding>(
  value: unknown,
  policy: FixedPriceCoordinatorProfilePolicy<Protocol>,
): FixedPriceCoordinatorOrderIdentity<Protocol> {
  const order = captureOwnData(value, `${policy.label} order identity`) as unknown as
    Record<string, unknown>;
  if (!exactKeys(order, ["jobId", "buyer", "seller", "protocol"], ["sdkJobs"]) ||
      !nonEmpty(order.jobId) || !isCanonicalClaimReference(order.buyer) ||
      !isCanonicalClaimReference(order.seller) ||
      sameCanonicalClaimIdentity(order.buyer, order.seller)) {
    throw new DacsError(`${policy.label} order identity is malformed`);
  }
  requireCanonicalJobId(order.jobId);
  const protocol = policy.captureProtocol(order.protocol);
  if (!sameCanonicalClaimIdentity(protocol.orchestrator, order.seller)) {
    throw new DacsError(
      `${policy.label} order does not pin the seller-orchestrator topology`,
    );
  }
  return {
    jobId: order.jobId,
    buyer: order.buyer,
    seller: order.seller,
    protocol,
  };
}

function captureOrder<Protocol extends FixedPriceCoordinatorProtocolBinding>(
  value: unknown,
  role: FixedPriceX402CoordinatorRole,
  policy: FixedPriceCoordinatorProfilePolicy<Protocol>,
): FixedPriceCoordinatorOrderInput<Protocol> {
  const raw = captureOwnData(value, `${policy.label} order`) as unknown as
    Record<string, unknown>;
  const identity = captureIdentity(raw, policy);
  if (!hasOwn(raw, "sdkJobs")) throw new DacsError("coordinator SDK job pointers are required");
  return { ...identity, sdkJobs: capturePointers(raw.sdkJobs, role) };
}

export function fixedPriceX402OrderBindingHash(
  order: Readonly<FixedPriceX402OrderIdentity>,
): string {
  const captured = captureIdentity(order, X402_PROFILE_POLICY);
  return X402_PROFILE_POLICY.bindingHash(captured);
}

export function fixedPriceOfflineOrderBindingHash(
  order: Readonly<FixedPriceOfflineOrderIdentity>,
): string {
  const captured = captureIdentity(order, OFFLINE_PROFILE_POLICY);
  return OFFLINE_PROFILE_POLICY.bindingHash(captured);
}

/**
 * Integrity hash for one actor's private SDK pointers. It is deliberately not
 * compared across actors and never enters the shared order binding.
 */
function fixedPriceCoordinatorOrderLocalBindingHash<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
>(
  order: Readonly<FixedPriceCoordinatorOrderInput<Protocol>>,
  policy: FixedPriceCoordinatorProfilePolicy<Protocol>,
): string {
  const raw = captureOwnData(order, `${policy.label} role-local order`) as unknown as
    Record<string, unknown>;
  if (!plainRecord(raw.sdkJobs) ||
      (raw.sdkJobs.role !== "buyer" && raw.sdkJobs.role !== "seller")) {
    throw new DacsError("coordinator SDK job pointers are malformed");
  }
  const captured = captureOrder(raw, raw.sdkJobs.role, policy);
  const bindingHash = policy.bindingHash(captureIdentity(captured, policy));
  return sha256Hex(canonicalize({
    coordinatorVersion: FIXED_PRICE_X402_COORDINATOR_STORE_VERSION,
    role: captured.sdkJobs.role,
    bindingHash,
    sdkJobs: captured.sdkJobs,
  }));
}

export function fixedPriceX402OrderLocalBindingHash(
  order: Readonly<FixedPriceX402OrderInput>,
): string {
  return fixedPriceCoordinatorOrderLocalBindingHash(order, X402_PROFILE_POLICY);
}

export function fixedPriceOfflineOrderLocalBindingHash(
  order: Readonly<FixedPriceOfflineOrderInput>,
): string {
  return fixedPriceCoordinatorOrderLocalBindingHash(order, OFFLINE_PROFILE_POLICY);
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
      "faultedParty",
      "withdrawnBy",
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
      (value.faultedParty !== undefined &&
        !FAULTED_PARTIES.has(value.faultedParty as FixedPriceX402FaultedParty)) ||
      (value.withdrawnBy !== undefined && value.withdrawnBy !== "buyer" &&
        value.withdrawnBy !== "seller") ||
      (value.reasonCode !== undefined && !validReasonCode(value.reasonCode)) ||
      (value.lease !== undefined && !validLease(value.lease))) return false;
  if (value.state === "not-started") {
    return value.generation === 0 && value.lease === undefined &&
      value.nextAttemptAt === undefined && value.reference === undefined &&
      value.authenticationHash === undefined && value.outcome === undefined &&
      value.errorClass === undefined && value.faultedParty === undefined &&
      value.withdrawnBy === undefined && value.reasonCode === undefined;
  }
  if (value.state === "running") {
    return value.lease !== undefined && value.lease.generation === value.generation &&
      value.nextAttemptAt === undefined && value.reference === undefined &&
      value.authenticationHash === undefined && value.outcome === undefined &&
      value.errorClass === undefined && value.faultedParty === undefined &&
      value.withdrawnBy === undefined && value.reasonCode === undefined;
  }
  if (value.state === "final") {
    return value.lease === undefined && value.nextAttemptAt === undefined &&
      value.reasonCode === undefined && value.reference !== undefined &&
      value.outcome !== undefined &&
      ((value.outcome === "failure" && value.errorClass !== undefined &&
          value.faultedParty !== undefined && value.withdrawnBy === undefined) ||
        (value.outcome === "aborted" && value.errorClass === undefined &&
          value.faultedParty === undefined && value.withdrawnBy !== undefined) ||
        (value.outcome === "success" && value.errorClass === undefined &&
          value.faultedParty === undefined && value.withdrawnBy === undefined));
  }
  return value.lease === undefined && value.reference === undefined &&
    value.authenticationHash === undefined && value.outcome === undefined &&
    value.errorClass === undefined && value.faultedParty === undefined &&
    value.withdrawnBy === undefined && value.reasonCode !== undefined &&
    (value.state !== "operator-action" || value.nextAttemptAt === undefined);
}

function trackRecord<Protocol extends FixedPriceCoordinatorProtocolBinding>(
  record: Readonly<FixedPriceCoordinatorOrderRecord<Protocol>>,
  track: FixedPriceX402Track,
): Readonly<FixedPriceX402TrackRecord> | undefined {
  return record.tracks[track];
}

function final<Protocol extends FixedPriceCoordinatorProtocolBinding>(
  record: Readonly<FixedPriceCoordinatorOrderRecord<Protocol>>,
  track: FixedPriceX402Track,
): boolean {
  return trackRecord(record, track)?.state === "final";
}

function successful<Protocol extends FixedPriceCoordinatorProtocolBinding>(
  record: Readonly<FixedPriceCoordinatorOrderRecord<Protocol>>,
  track: FixedPriceX402Track,
): boolean {
  const retained = trackRecord(record, track);
  return retained?.state === "final" && retained.outcome === "success";
}

type FixedPriceX402TerminalPhaseResult = Readonly<
  | {
      outcome: "failure";
      errorClass: FixedPriceX402ErrorClass;
      faultedParty: FixedPriceX402FaultedParty;
    }
  | { outcome: "aborted"; withdrawnBy: FixedPriceX402CoordinatorRole }
>;

function terminalPhaseResult<Protocol extends FixedPriceCoordinatorProtocolBinding>(
  record: Readonly<FixedPriceCoordinatorOrderRecord<Protocol>>,
): FixedPriceX402TerminalPhaseResult | null {
  const tracks: readonly FixedPriceX402Track[] = record.role === "buyer"
    ? ["agreement", "payment", "buyer-received"]
    : ["agreement", "payment", "delivery"];
  for (const track of tracks) {
    const retained = trackRecord(record, track);
    if (retained?.state === "final" && retained.outcome !== "success") {
      return retained.outcome === "failure"
        ? {
            outcome: "failure",
            errorClass: retained.errorClass!,
            faultedParty: retained.faultedParty!,
          }
        : { outcome: "aborted", withdrawnBy: retained.withdrawnBy! };
    }
  }
  return null;
}

function eligible<Protocol extends FixedPriceCoordinatorProtocolBinding>(
  record: Readonly<FixedPriceCoordinatorOrderRecord<Protocol>>,
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

function trackResultAllowed<Protocol extends FixedPriceCoordinatorProtocolBinding>(
  record: Readonly<FixedPriceCoordinatorOrderRecord<Protocol>>,
  track: FixedPriceX402Track,
  result: Readonly<{
    outcome: FixedPriceX402NormativeOutcome;
    errorClass?: FixedPriceX402ErrorClass;
    faultedParty?: FixedPriceX402FaultedParty;
    withdrawnBy?: FixedPriceX402CoordinatorRole;
  }>,
): boolean {
  if (result.outcome === "failure" &&
      (result.faultedParty === "orchestrator" ||
        (result.errorClass === "substrate") !== (result.faultedParty === "none"))) {
    // This profile has no distinct orchestrator party. DACS-5 §10.4.1 makes
    // failed-substrate neutral and every other failure party-attributed.
    return false;
  }
  if (track === "payment-evidence" || track === "delivery-evidence") {
    return result.outcome === "success";
  }
  if (track === "audit") {
    const expected = terminalPhaseResult(record) ?? { outcome: "success" as const };
    return result.outcome === expected.outcome &&
      (expected.outcome !== "failure" ||
        (result.errorClass === expected.errorClass &&
          result.faultedParty === expected.faultedParty)) &&
      (expected.outcome !== "aborted" || result.withdrawnBy === expected.withdrawnBy);
  }
  // DACS-5 §10.3.1 ST-3: a rail-final payment or irreversible delivery can
  // never be relabelled as an abort by a later operational callback.
  if (result.outcome === "aborted" &&
      (successful(record, "payment") || successful(record, "delivery"))) return false;
  return true;
}

function dependencyViolation<Protocol extends FixedPriceCoordinatorProtocolBinding>(
  record: Readonly<FixedPriceCoordinatorOrderRecord<Protocol>>,
): string | null {
  for (const track of roleTracks(record.role)) {
    const retained = record.tracks[track];
    if (!retained || retained.state === "not-started") continue;
    if (!eligible(record, track)) {
      return `coordinator ${track} track violates the role dependency DAG`;
    }
    if (retained.state === "final" && retained.outcome &&
        !trackResultAllowed(record, track, {
          outcome: retained.outcome,
          ...(retained.errorClass === undefined ? {} : { errorClass: retained.errorClass }),
          ...(retained.faultedParty === undefined
            ? {}
            : { faultedParty: retained.faultedParty }),
          ...(retained.withdrawnBy === undefined ? {} : { withdrawnBy: retained.withdrawnBy }),
        })) {
      return `coordinator ${track} outcome contradicts the normative terminal path`;
    }
  }
  return null;
}

function fixedPriceCoordinatorOrderViolation<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
>(
  value: unknown,
  policy: FixedPriceCoordinatorProfilePolicy<Protocol>,
): string | null {
  if (!plainRecord(value) || !exactKeys(value, [
    "storeVersion",
    "revision",
    "role",
    "jobId",
    "buyer",
    "seller",
    "protocol",
    "bindingHash",
    "localBindingHash",
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
      !isCanonicalClaimReference(value.buyer) ||
      !isCanonicalClaimReference(value.seller) ||
      sameCanonicalClaimIdentity(value.buyer, value.seller) ||
      typeof value.bindingHash !== "string" || !HASH_RE.test(value.bindingHash) ||
      typeof value.localBindingHash !== "string" || !HASH_RE.test(value.localBindingHash) ||
      !safeUint(value.createdAt) || !safeUint(value.updatedAt) ||
      value.updatedAt < value.createdAt) {
    return "coordinator order identity is malformed";
  }
  let protocol: Protocol;
  let sdkJobs: FixedPriceX402SdkJobPointers;
  try {
    requireCanonicalJobId(value.jobId);
    protocol = policy.captureProtocol(value.protocol);
    sdkJobs = capturePointers(value.sdkJobs, value.role);
    if (!sameCanonicalClaimIdentity(protocol.orchestrator, value.seller)) {
      return "coordinator order has an unsupported orchestrator topology";
    }
    const expected = policy.bindingHash({
      jobId: value.jobId,
      buyer: value.buyer,
      seller: value.seller,
      protocol,
    });
    if (expected !== value.bindingHash) return "coordinator order binding hash differs";
    const expectedLocal = fixedPriceCoordinatorOrderLocalBindingHash({
      jobId: value.jobId,
      buyer: value.buyer,
      seller: value.seller,
      protocol,
      sdkJobs,
    }, policy);
    if (expectedLocal !== value.localBindingHash) {
      return "coordinator role-local binding hash differs";
    }
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
  return dependencyViolation(
    value as unknown as FixedPriceCoordinatorOrderRecord<Protocol>,
  );
}

export function fixedPriceX402OrderViolation(value: unknown): string | null {
  return fixedPriceCoordinatorOrderViolation(value, X402_PROFILE_POLICY);
}

export function fixedPriceOfflineOrderViolation(value: unknown): string | null {
  return fixedPriceCoordinatorOrderViolation(value, OFFLINE_PROFILE_POLICY);
}

function copyRecord<Protocol extends FixedPriceCoordinatorProtocolBinding>(
  record: Readonly<FixedPriceCoordinatorOrderRecord<Protocol>>,
): FixedPriceCoordinatorOrderRecord<Protocol> {
  return clone(record);
}

function requireCoordinatorRecord<Protocol extends FixedPriceCoordinatorProtocolBinding>(
  value: unknown,
  role: FixedPriceX402CoordinatorRole,
  policy: FixedPriceCoordinatorProfilePolicy<Protocol>,
  expectedBindingHash?: string,
  expectedLocalBindingHash?: string,
): FixedPriceCoordinatorOrderRecord<Protocol> {
  const violation = fixedPriceCoordinatorOrderViolation(value, policy);
  if (violation) throw new DacsError(violation);
  const record = clone(value as FixedPriceCoordinatorOrderRecord<Protocol>);
  if (record.role !== role ||
      (expectedBindingHash !== undefined && record.bindingHash !== expectedBindingHash) ||
      (expectedLocalBindingHash !== undefined &&
        record.localBindingHash !== expectedLocalBindingHash)) {
    throw new DacsError("coordinator store returned a different actor/order binding");
  }
  return record;
}

function key(role: FixedPriceX402CoordinatorRole, jobId: string): string {
  return `${role}:${jobId}`;
}

function isRunnableTrack<Protocol extends FixedPriceCoordinatorProtocolBinding>(
  record: Readonly<FixedPriceCoordinatorOrderRecord<Protocol>>,
  track: FixedPriceX402Track,
  now: number,
): boolean {
  const retained = trackRecord(record, track);
  if (!retained || !eligible(record, track) || retained.state === "final" ||
      retained.state === "operator-action") return false;
  if (retained.nextAttemptAt !== undefined && retained.nextAttemptAt > now) return false;
  return retained.lease === undefined || retained.lease.expiresAt <= now;
}

function createInMemoryFixedPriceCoordinatorStore<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
>(
  policy: FixedPriceCoordinatorProfilePolicy<Protocol>,
  options: Readonly<{ now?: () => number }> = {},
): FixedPriceCoordinatorStore<Protocol> {
  if (!plainRecord(options) || !exactKeys(options, [], ["now"]) ||
      (options.now !== undefined && typeof options.now !== "function")) {
    throw new DacsError("in-memory coordinator store options are malformed");
  }
  const clock = options.now ?? Date.now;
  const records = new Map<string, FixedPriceCoordinatorOrderRecord<Protocol>>();
  const readTime = (): number => {
    const value = Reflect.apply(clock, INERT_RECEIVER, []);
    if (!safeUint(value)) throw new DacsError("coordinator store clock is invalid");
    return value;
  };
  const stamp = (
    record: Readonly<FixedPriceCoordinatorOrderRecord<Protocol>>,
    value = readTime(),
  ): number =>
    Math.max(record.updatedAt, value);
  const loadRecord = (
    role: FixedPriceX402CoordinatorRole,
    jobId: string,
  ): FixedPriceCoordinatorOrderLoad<Protocol> => {
    const found = records.get(key(role, jobId));
    if (!found) return { status: "missing" };
    const violation = fixedPriceCoordinatorOrderViolation(found, policy);
    return violation
      ? { status: "corrupt", reason: violation }
      : { status: "ok", record: copyRecord(found) };
  };
  const save = (
    current: Readonly<FixedPriceCoordinatorOrderRecord<Protocol>>,
    next: FixedPriceCoordinatorOrderRecord<Protocol>,
  ): FixedPriceCoordinatorOrderRecord<Protocol> => {
    next.revision = current.revision + 1;
    const violation = fixedPriceCoordinatorOrderViolation(next, policy);
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
      let order: FixedPriceCoordinatorOrderInput<Protocol>;
      try {
        order = captureOrder(input.order, input.role, policy);
      } catch (error) {
        return {
          status: "corrupt",
          reason: error instanceof DacsError ? error.message : "coordinator order is malformed",
        };
      }
      const expected = policy.bindingHash(captureIdentity(order, policy));
      const expectedLocal = fixedPriceCoordinatorOrderLocalBindingHash(order, policy);
      if (input.bindingHash !== expected) return { status: "conflict" };
      if (input.localBindingHash !== expectedLocal) return { status: "conflict" };
      const storageKey = key(input.role, order.jobId);
      const existing = records.get(storageKey);
      if (existing) {
        const violation = fixedPriceCoordinatorOrderViolation(existing, policy);
        if (violation) return { status: "corrupt", reason: violation };
        return existing.bindingHash === expected &&
            existing.localBindingHash === expectedLocal &&
            canonicalize(existing.sdkJobs) === canonicalize(order.sdkJobs)
          ? { status: "existing", record: copyRecord(existing) }
          : { status: "conflict" };
      }
      const now = readTime();
      const record: FixedPriceCoordinatorOrderRecord<Protocol> = {
        storeVersion: FIXED_PRICE_X402_COORDINATOR_STORE_VERSION,
        revision: 1,
        role: input.role,
        jobId: order.jobId,
        buyer: order.buyer,
        seller: order.seller,
        protocol: clone(order.protocol),
        bindingHash: expected,
        localBindingHash: expectedLocal,
        sdkJobs: clone(order.sdkJobs),
        tracks: emptyTracks(input.role, now),
        createdAt: now,
        updatedAt: now,
      };
      const violation = fixedPriceCoordinatorOrderViolation(record, policy);
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
      if (current.bindingHash !== input.bindingHash ||
          current.localBindingHash !== input.localBindingHash) return { status: "stale" };
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
      const next: FixedPriceCoordinatorOrderRecord<Protocol> = {
        ...copyRecord(current),
        tracks,
        updatedAt: stamp(current, now),
      };
      return { status: "acquired", record: save(current, next), lease: clone(lease) };
    },

    async isCurrent(input) {
      const loaded = loadRecord(input.role, input.jobId);
      if (loaded.status !== "ok" || loaded.record.bindingHash !== input.bindingHash ||
          loaded.record.localBindingHash !== input.localBindingHash) return false;
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
          current.localBindingHash !== input.localBindingHash ||
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
          !trackResultAllowed(current, input.track, result)) {
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
            ...(result.outcome === "failure" ? { faultedParty: result.faultedParty } : {}),
            ...(result.outcome === "aborted" ? { withdrawnBy: result.withdrawnBy } : {}),
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
      const next: FixedPriceCoordinatorOrderRecord<Protocol> = {
        ...copyRecord(current),
        tracks,
        updatedAt,
      };
      const violation = fixedPriceCoordinatorOrderViolation(next, policy);
      if (violation) return { status: "conflict" };
      return { status: "recorded", record: save(current, next) };
    },

    async requeue(input) {
      const loaded = loadRecord(input.role, input.jobId);
      if (loaded.status !== "ok") return loaded;
      const current = records.get(key(input.role, input.jobId))!;
      if (current.bindingHash !== input.bindingHash ||
          current.localBindingHash !== input.localBindingHash ||
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
      const next: FixedPriceCoordinatorOrderRecord<Protocol> = {
        ...copyRecord(current),
        tracks,
        updatedAt,
      };
      return { status: "recorded", record: save(current, next) };
    },
  };
}

export function createInMemoryFixedPriceX402CoordinatorStore(
  options: Readonly<{ now?: () => number }> = {},
): FixedPriceX402CoordinatorStore {
  return createInMemoryFixedPriceCoordinatorStore(X402_PROFILE_POLICY, options);
}

export function createInMemoryFixedPriceOfflineCoordinatorStore(
  options: Readonly<{ now?: () => number }> = {},
): FixedPriceOfflineCoordinatorStore {
  return createInMemoryFixedPriceCoordinatorStore(OFFLINE_PROFILE_POLICY, options);
}

function captureOperationResult(value: unknown): FixedPriceX402TrackOperationResult {
  const result = captureOwnData(value, "coordinator operation result") as unknown as
    Record<string, unknown>;
  if (result.status === "final" && result.outcome === "success" && exactKeys(
        result,
        ["status", "outcome", "reference"],
        ["authenticationHash"],
      ) && nonEmpty(result.reference) &&
      (result.authenticationHash === undefined ||
        (typeof result.authenticationHash === "string" && HASH_RE.test(result.authenticationHash)))) {
    return result as unknown as FixedPriceX402TrackOperationResult;
  }
  if (result.status === "final" && result.outcome === "aborted" && exactKeys(
    result,
    ["status", "outcome", "withdrawnBy", "reference"],
    ["authenticationHash"],
  ) && (result.withdrawnBy === "buyer" || result.withdrawnBy === "seller") &&
      nonEmpty(result.reference) &&
      (result.authenticationHash === undefined ||
        (typeof result.authenticationHash === "string" && HASH_RE.test(result.authenticationHash)))) {
    return result as unknown as FixedPriceX402TrackOperationResult;
  }
  if (result.status === "final" && result.outcome === "failure" && exactKeys(
    result,
    ["status", "outcome", "errorClass", "faultedParty", "reference"],
    ["authenticationHash"],
  ) && ERROR_CLASSES.has(result.errorClass as FixedPriceX402ErrorClass) &&
      FAULTED_PARTIES.has(result.faultedParty as FixedPriceX402FaultedParty) &&
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

function projectLocalMilestone<Protocol extends FixedPriceCoordinatorProtocolBinding>(
  record: Readonly<FixedPriceCoordinatorOrderRecord<Protocol>>,
): Exclude<FixedPriceX402Milestone, "audit-complete"> {
  const terminal = terminalPhaseResult(record);
  if (terminal) {
    return terminal.outcome === "failure" ? "terminal-failure" : "terminal-aborted";
  }
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
  const retained = requireCoordinatorRecord(record, record.role, X402_PROFILE_POLICY);
  return projectLocalMilestone(retained);
}

/** Local offline projections never claim global `audit-complete`. */
export function projectFixedPriceOfflineMilestone(
  record: Readonly<FixedPriceOfflineOrderRecord>,
): Exclude<FixedPriceOfflineMilestone, "audit-complete"> {
  const retained = requireCoordinatorRecord(record, record.role, OFFLINE_PROFILE_POLICY);
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
    localBindingHash: value.localBindingHash,
    sdkJobs: value.sdkJobs,
    tracks: value.tracks,
    createdAt: 0,
    updatedAt: value.updatedAt,
  };
}

function fixedPriceCoordinatorOrderStatusViolation<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
>(
  value: unknown,
  policy: FixedPriceCoordinatorProfilePolicy<Protocol>,
): string | null {
  if (!plainRecord(value) || !exactKeys(value, [
    "role",
    "jobId",
    "buyer",
    "seller",
    "protocol",
    "bindingHash",
    "localBindingHash",
    "sdkJobs",
    "tracks",
    "milestone",
    "attention",
    "revision",
    "updatedAt",
  ])) return "coordinator status fields are malformed";
  const recordViolation = fixedPriceCoordinatorOrderViolation(statusAsRecord(value), policy);
  if (recordViolation) return recordViolation;
  const record = statusAsRecord(value) as FixedPriceCoordinatorOrderRecord<Protocol>;
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

export function fixedPriceX402OrderStatusViolation(value: unknown): string | null {
  return fixedPriceCoordinatorOrderStatusViolation(value, X402_PROFILE_POLICY);
}

export function fixedPriceOfflineOrderStatusViolation(value: unknown): string | null {
  return fixedPriceCoordinatorOrderStatusViolation(value, OFFLINE_PROFILE_POLICY);
}

function projectStatus<Protocol extends FixedPriceCoordinatorProtocolBinding>(
  record: Readonly<FixedPriceCoordinatorOrderRecord<Protocol>>,
  policy: FixedPriceCoordinatorProfilePolicy<Protocol>,
): FixedPriceCoordinatorOrderStatus<Protocol> {
  const retained = requireCoordinatorRecord(record, record.role, policy);
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
    localBindingHash: retained.localBindingHash,
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

function captureOptions<Protocol extends FixedPriceCoordinatorProtocolBinding>(
  value: unknown,
  policy: FixedPriceCoordinatorProfilePolicy<Protocol>,
): {
  role: FixedPriceX402CoordinatorRole;
  store: FixedPriceCoordinatorStore<Protocol>;
  workerId: string;
  operations: Map<FixedPriceX402Track, FixedPriceCoordinatorTrackOperation<Protocol>>;
  leaseDurationMs: number;
} {
  if (!plainRecord(value) || !exactKeys(
    value,
    ["role", "store", "workerId", "operations"],
    ["leaseDurationMs"],
  ) || (value.role !== "buyer" && value.role !== "seller") ||
      !nonEmpty(value.workerId) || !storeObject(value.store) ||
      !plainRecord(value.operations)) {
    throw new DacsError(`${policy.label} coordinator options are malformed`);
  }
  const store = value.store as unknown as FixedPriceCoordinatorStore<Protocol>;
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
      throw new DacsError(`${policy.label} coordinator store.${method} is required`);
    }
  }
  const operations = new Map<
    FixedPriceX402Track,
    FixedPriceCoordinatorTrackOperation<Protocol>
  >();
  for (const operationKey of Reflect.ownKeys(value.operations)) {
    if (typeof operationKey !== "string" ||
        !roleTracks(value.role).includes(operationKey as FixedPriceX402Track) ||
        typeof value.operations[operationKey] !== "function") {
      throw new DacsError(
        `${policy.label} ${value.role} coordinator operation is not role-owned`,
      );
    }
    operations.set(
      operationKey as FixedPriceX402Track,
      value.operations[operationKey] as FixedPriceCoordinatorTrackOperation<Protocol>,
    );
  }
  const leaseDurationMs = value.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  if (!safeUint(leaseDurationMs) || leaseDurationMs === 0) {
    throw new DacsError(`${policy.label} coordinator leaseDurationMs must be positive`);
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
function combineFixedPriceCoordinatorOrderStatus<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
>(input: Readonly<{
  buyer: Readonly<FixedPriceCoordinatorOrderStatus<Protocol>>;
  seller: Readonly<FixedPriceCoordinatorOrderStatus<Protocol>>;
}>, policy: FixedPriceCoordinatorProfilePolicy<Protocol>):
  FixedPriceCoordinatorCombinedOrderStatus<Protocol> {
  const captured = captureOwnData(input, "combined coordinator status input");
  const buyer = captureOwnData(captured.buyer, "buyer coordinator status");
  const seller = captureOwnData(captured.seller, "seller coordinator status");
  const buyerViolation = fixedPriceCoordinatorOrderStatusViolation(buyer, policy);
  const sellerViolation = fixedPriceCoordinatorOrderStatusViolation(seller, policy);
  if (buyerViolation || sellerViolation) {
    throw new DacsError(buyerViolation ?? sellerViolation!);
  }
  if (buyer.role !== "buyer" || seller.role !== "seller" ||
      buyer.jobId !== seller.jobId ||
      !sameCanonicalClaimIdentity(buyer.buyer, seller.buyer) ||
      !sameCanonicalClaimIdentity(buyer.seller, seller.seller) ||
      buyer.bindingHash !== seller.bindingHash ||
      policy.protocolHash(buyer.protocol) !== policy.protocolHash(seller.protocol)) {
    throw new DacsError("buyer and seller coordinator statuses do not bind the same order");
  }
  const expectedBinding = policy.bindingHash({
    jobId: buyer.jobId,
    buyer: buyer.buyer,
    seller: buyer.seller,
    protocol: buyer.protocol,
  });
  if (buyer.bindingHash !== expectedBinding) {
    throw new DacsError("combined coordinator status has an invalid order binding");
  }
  const buyerRecord = statusAsRecord(buyer) as FixedPriceCoordinatorOrderRecord<Protocol>;
  const sellerRecord = statusAsRecord(seller) as FixedPriceCoordinatorOrderRecord<Protocol>;
  const buyerTerminal = terminalPhaseResult(buyerRecord);
  const sellerTerminal = terminalPhaseResult(sellerRecord);
  const buyerAudit = buyer.tracks.audit;
  const sellerAudit = seller.tracks.audit;
  let milestone: FixedPriceX402Milestone;
  if (buyerTerminal && sellerTerminal && buyerTerminal.outcome !== sellerTerminal.outcome) {
    throw new DacsError("actor terminal outcomes contradict the shared terminal session");
  }
  if (buyerTerminal?.outcome === "failure" && sellerTerminal?.outcome === "failure" &&
      (buyerTerminal.errorClass !== sellerTerminal.errorClass ||
        buyerTerminal.faultedParty !== sellerTerminal.faultedParty)) {
    throw new DacsError(
      "actor terminal failure attribution contradicts the shared operational session",
    );
  }
  if (buyerTerminal?.outcome === "aborted" && sellerTerminal?.outcome === "aborted" &&
      buyerTerminal.withdrawnBy !== sellerTerminal.withdrawnBy) {
    throw new DacsError(
      "actor terminal withdrawal attribution contradicts the shared operational session",
    );
  }
  if ((buyerTerminal && sellerAudit?.state === "final" && sellerAudit.outcome === "success") ||
      (sellerTerminal && buyerAudit?.state === "final" && buyerAudit.outcome === "success")) {
    throw new DacsError("actor terminal outcomes contradict the shared terminal session");
  }
  const terminal = buyerTerminal ?? sellerTerminal;
  if (terminal) {
    milestone = terminal.outcome === "failure" ? "terminal-failure" : "terminal-aborted";
  } else if (buyerAudit?.state === "final" && sellerAudit?.state === "final") {
    if (buyerAudit.outcome !== sellerAudit.outcome) {
      throw new DacsError("actor audit outcomes contradict the shared terminal session");
    }
    if (buyerAudit.outcome === "failure" &&
        (buyerAudit.errorClass !== sellerAudit.errorClass ||
          buyerAudit.faultedParty !== sellerAudit.faultedParty)) {
      throw new DacsError(
        "actor audit failure attribution contradicts the shared operational session",
      );
    }
    if (buyerAudit.outcome === "aborted" &&
        buyerAudit.withdrawnBy !== sellerAudit.withdrawnBy) {
      throw new DacsError(
        "actor audit withdrawal attribution contradicts the shared operational session",
      );
    }
    milestone = buyerAudit.outcome === "failure"
      ? "terminal-failure"
      : buyerAudit.outcome === "aborted"
        ? "terminal-aborted"
        : "actor-audit-final";
  } else if (buyerAudit?.state === "final" && buyerAudit.outcome !== "success") {
    milestone = buyerAudit.outcome === "failure" ? "terminal-failure" : "terminal-aborted";
  } else if (sellerAudit?.state === "final" && sellerAudit.outcome !== "success") {
    milestone = sellerAudit.outcome === "failure" ? "terminal-failure" : "terminal-aborted";
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

export function combineFixedPriceX402OrderStatus(input: Readonly<{
  buyer: Readonly<FixedPriceX402OrderStatus>;
  seller: Readonly<FixedPriceX402OrderStatus>;
}>): FixedPriceX402CombinedOrderStatus {
  return combineFixedPriceCoordinatorOrderStatus(input, X402_PROFILE_POLICY);
}

export function combineFixedPriceOfflineOrderStatus(input: Readonly<{
  buyer: Readonly<FixedPriceOfflineOrderStatus>;
  seller: Readonly<FixedPriceOfflineOrderStatus>;
}>): FixedPriceOfflineCombinedOrderStatus {
  return combineFixedPriceCoordinatorOrderStatus(input, OFFLINE_PROFILE_POLICY);
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

function requireTrackWrite<Protocol extends FixedPriceCoordinatorProtocolBinding>(
  value: FixedPriceCoordinatorTrackWrite<Protocol>,
  label: string,
): FixedPriceCoordinatorOrderRecord<Protocol> {
  if (value.status === "corrupt") throw new DacsError(value.reason);
  if (value.status === "unsupported") {
    throw new DacsError(`coordinator store version ${value.version} is unsupported`);
  }
  if (value.status !== "recorded" && value.status !== "existing") {
    throw new DacsError(`${label} is stale or conflicts with retained state`);
  }
  return clone(value.record);
}

function createFixedPriceCommerceCoordinator<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
>(
  options: FixedPriceCoordinatorOptions<Protocol>,
  policy: FixedPriceCoordinatorProfilePolicy<Protocol>,
): FixedPriceCommerceCoordinator<Protocol> {
  const captured = captureOptions(options, policy);

  const get = async (
    jobId: string,
  ): Promise<FixedPriceCoordinatorOrderRecord<Protocol> | null> => {
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
    return requireCoordinatorRecord(loaded.record, captured.role, policy);
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
      requireCoordinatorRecord(rawRecord, captured.role, policy)
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
          localBindingHash: record.localBindingHash,
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
            record = requireCoordinatorRecord(
              claim.record,
              captured.role,
              policy,
              record.bindingHash,
              record.localBindingHash,
            );
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
        record = requireCoordinatorRecord(
          claim.record,
          captured.role,
          policy,
          record.bindingHash,
          record.localBindingHash,
        );
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
          localBindingHash: record.localBindingHash,
          track,
          owner: lease.owner,
          generation: lease.generation,
          idempotencyKey: sha256Hex(canonicalize(policy.idempotencyPayload({
            localBindingHash: record.localBindingHash,
            role: captured.role,
            track,
            roleLocalJob,
          }))),
          assertCurrent: async () => {
            const current = await captured.store.isCurrent({
              role: captured.role,
              jobId: record.jobId,
              bindingHash: record.bindingHash,
              localBindingHash: record.localBindingHash,
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
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          }]);
          result = captureOperationResult(raw);
          if (result.status === "final" &&
              !trackResultAllowed(record, track, result)) {
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
          localBindingHash: record.localBindingHash,
          track,
          lease,
          result,
        }));
        if (written.status === "recorded" || written.status === "existing") {
          record = requireCoordinatorRecord(
            written.record,
            captured.role,
            policy,
            record.bindingHash,
            record.localBindingHash,
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

  const coordinator: FixedPriceCommerceCoordinator<Protocol> = {
    role: captured.role,
    async startOrder(input) {
      const order = captureOrder(input, captured.role, policy);
      const bindingHash = policy.bindingHash(captureIdentity(order, policy));
      const localBindingHash = fixedPriceCoordinatorOrderLocalBindingHash(order, policy);
      const created = clone(await captured.store.create({
        role: captured.role,
        order,
        bindingHash,
        localBindingHash,
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
        policy,
        bindingHash,
        localBindingHash,
      ), policy);
    },
    async getOrderStatus(jobId) {
      const record = await get(jobId);
      return record ? projectStatus(record, policy) : null;
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
        localBindingHash: record.localBindingHash,
        track: input.track,
        operatorReasonCode: input.operatorReasonCode,
        ...(input.retryAt === undefined ? {} : { retryAt: input.retryAt }),
      })), "coordinator repair request");
      return projectStatus(requireCoordinatorRecord(
        repaired,
        captured.role,
        policy,
        record.bindingHash,
        record.localBindingHash,
      ), policy);
    },
  };
  return Object.freeze(coordinator);
}

export function createFixedPriceX402CommerceCoordinator(
  options: FixedPriceX402CoordinatorOptions,
): FixedPriceX402CommerceCoordinator {
  return createFixedPriceCommerceCoordinator(options, X402_PROFILE_POLICY);
}

export function createFixedPriceOfflineCommerceCoordinator(
  options: FixedPriceOfflineCoordinatorOptions,
): FixedPriceOfflineCommerceCoordinator {
  return createFixedPriceCommerceCoordinator(options, OFFLINE_PROFILE_POLICY);
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

export function createFixedPriceOfflineBuyerCoordinator(
  options: Omit<FixedPriceOfflineCoordinatorOptions, "role">,
): FixedPriceOfflineCommerceCoordinator {
  return createFixedPriceOfflineCommerceCoordinator({ ...options, role: "buyer" });
}

export function createFixedPriceOfflineSellerCoordinator(
  options: Omit<FixedPriceOfflineCoordinatorOptions, "role">,
): FixedPriceOfflineCommerceCoordinator {
  return createFixedPriceOfflineCommerceCoordinator({ ...options, role: "seller" });
}

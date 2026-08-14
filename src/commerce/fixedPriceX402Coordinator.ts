import { types as nodeTypes } from "node:util";

import { canonicalize, sha256Hex } from "../canonical/index.js";
import { DacsError } from "../errors.js";
import { requireCanonicalJobId } from "../negotiate/jobId.js";

export const FIXED_PRICE_X402_COORDINATOR_STORE_VERSION = 1 as const;

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
  | "failed"
  | "operator-action";

export type FixedPriceX402Milestone =
  | "created"
  | "agreement-final"
  | "payment-final"
  | "delivery-ready"
  | "buyer-received"
  | "commercial-performance-complete"
  | "audit-complete";

export interface FixedPriceX402SdkJobPointers {
  agreement: string;
  payment: string;
  fulfilment: string;
  buyerAudit?: string;
  sellerAudit?: string;
}

export interface FixedPriceX402OrderInput {
  jobId: string;
  buyer: string;
  seller: string;
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
  reason?: string;
  lease?: Readonly<FixedPriceX402TrackLease>;
}

export type FixedPriceX402TrackMap = Readonly<
  Record<FixedPriceX402Track, Readonly<FixedPriceX402TrackRecord>>
>;

export interface FixedPriceX402OrderRecord {
  storeVersion: typeof FIXED_PRICE_X402_COORDINATOR_STORE_VERSION;
  role: FixedPriceX402CoordinatorRole;
  jobId: string;
  buyer: string;
  seller: string;
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
      reference: string;
      authenticationHash?: string;
    }
  | {
      status: "pending-retry" | "indeterminate" | "failed" | "operator-action";
      reason: string;
      retryAt?: number;
    };

export type FixedPriceX402TrackWrite =
  | { status: "recorded"; record: Readonly<FixedPriceX402OrderRecord> }
  | { status: "missing" | "stale" }
  | { status: "unsupported"; version: number }
  | { status: "corrupt"; reason: string };

export interface FixedPriceX402CoordinatorStore {
  create(input: Readonly<{
    role: FixedPriceX402CoordinatorRole;
    order: Readonly<FixedPriceX402OrderInput>;
    bindingHash: string;
    now: number;
  }>): Promise<FixedPriceX402OrderCreate>;
  load(
    role: FixedPriceX402CoordinatorRole,
    jobId: string,
  ): Promise<FixedPriceX402OrderLoad>;
  list(role: FixedPriceX402CoordinatorRole): Promise<readonly FixedPriceX402OrderLoad[]>;
  claim(input: Readonly<{
    role: FixedPriceX402CoordinatorRole;
    jobId: string;
    bindingHash: string;
    track: FixedPriceX402Track;
    owner: string;
    now: number;
    leaseDurationMs: number;
  }>): Promise<FixedPriceX402TrackClaim>;
  isCurrent(input: Readonly<{
    role: FixedPriceX402CoordinatorRole;
    jobId: string;
    bindingHash: string;
    track: FixedPriceX402Track;
    lease: Readonly<FixedPriceX402TrackLease>;
    now: number;
  }>): Promise<boolean>;
  record(input: Readonly<{
    role: FixedPriceX402CoordinatorRole;
    jobId: string;
    bindingHash: string;
    track: FixedPriceX402Track;
    lease: Readonly<FixedPriceX402TrackLease>;
    result: Readonly<FixedPriceX402TrackOperationResult>;
    now: number;
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
  now?: () => number;
}

export interface FixedPriceX402OrderStatus {
  role: FixedPriceX402CoordinatorRole;
  jobId: string;
  buyer: string;
  seller: string;
  bindingHash: string;
  sdkJobs: Readonly<FixedPriceX402SdkJobPointers>;
  tracks: FixedPriceX402TrackMap;
  milestone: FixedPriceX402Milestone;
  attention: Readonly<{
    required: boolean;
    tracks: readonly FixedPriceX402Track[];
  }>;
  updatedAt: number;
}

export interface FixedPriceX402CombinedOrderStatus {
  jobId: string;
  buyer: string;
  seller: string;
  bindingHash: string;
  sdkJobs: Readonly<FixedPriceX402SdkJobPointers>;
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
  reason?: string;
}

export interface FixedPriceX402CommerceCoordinator {
  readonly role: FixedPriceX402CoordinatorRole;
  startOrder(order: Readonly<FixedPriceX402OrderInput>): Promise<FixedPriceX402OrderStatus>;
  getOrderStatus(jobId: string): Promise<FixedPriceX402OrderStatus | null>;
  runPending(options?: Readonly<{
    limit?: number;
    signal?: AbortSignal;
  }>): Promise<readonly FixedPriceX402WorkReport[]>;
  resumePendingOrders(options?: Readonly<{
    limit?: number;
    signal?: AbortSignal;
  }>): Promise<readonly FixedPriceX402WorkReport[]>;
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

const TERMINAL_TRACK_STATES = new Set<FixedPriceX402TrackState>([
  "final",
  "failed",
  "operator-action",
]);

const HASH_RE = /^[0-9a-f]{64}$/;
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
    if (!descriptor || !descriptor.enumerable ||
        !("value" in descriptor) || descriptor.value === undefined) {
      throw new DacsError(`${label} must contain enumerable defined data properties only`);
    }
  }
  try {
    return clone(value);
  } catch {
    throw new DacsError(`${label} must be structured-cloneable data`);
  }
}

function capturePointers(value: unknown): FixedPriceX402SdkJobPointers {
  const pointers = captureOwnData(value, "coordinator SDK job pointers") as unknown as
    Record<string, unknown>;
  if (!exactKeys(
    pointers,
    ["agreement", "payment", "fulfilment"],
    ["buyerAudit", "sellerAudit"],
  ) || !nonEmpty(pointers.agreement) || !nonEmpty(pointers.payment) ||
      !nonEmpty(pointers.fulfilment) ||
      (pointers.buyerAudit !== undefined && !nonEmpty(pointers.buyerAudit)) ||
      (pointers.sellerAudit !== undefined && !nonEmpty(pointers.sellerAudit))) {
    throw new DacsError("coordinator SDK job pointers are malformed");
  }
  return pointers as unknown as FixedPriceX402SdkJobPointers;
}

function captureOrder(value: unknown): FixedPriceX402OrderInput {
  const order = captureOwnData(value, "fixed-price x402 order") as unknown as
    Record<string, unknown>;
  if (!exactKeys(order, ["jobId", "buyer", "seller", "sdkJobs"]) ||
      !nonEmpty(order.jobId) || !nonEmpty(order.buyer) || !nonEmpty(order.seller) ||
      order.buyer === order.seller) {
    throw new DacsError("fixed-price x402 order is malformed");
  }
  requireCanonicalJobId(order.jobId);
  return {
    jobId: order.jobId,
    buyer: order.buyer,
    seller: order.seller,
    sdkJobs: capturePointers(order.sdkJobs),
  };
}

export function fixedPriceX402OrderBindingHash(
  order: Readonly<FixedPriceX402OrderInput>,
): string {
  const captured = captureOrder(order);
  return sha256Hex(canonicalize({
    coordinatorVersion: FIXED_PRICE_X402_COORDINATOR_STORE_VERSION,
    ...captured,
  }));
}

function emptyTracks(now: number): Record<FixedPriceX402Track, FixedPriceX402TrackRecord> {
  return Object.fromEntries(TRACKS.map((track) => [
    track,
    {
      state: "not-started",
      generation: 0,
      attempts: 0,
      updatedAt: now,
    },
  ])) as Record<FixedPriceX402Track, FixedPriceX402TrackRecord>;
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
    ["nextAttemptAt", "reference", "authenticationHash", "reason", "lease"],
  ) || ![
    "not-started",
    "running",
    "pending-retry",
    "indeterminate",
    "final",
    "failed",
    "operator-action",
  ].includes(value.state as string) || !safeUint(value.generation) ||
      !safeUint(value.attempts) || !safeUint(value.updatedAt) ||
      (value.nextAttemptAt !== undefined && !safeUint(value.nextAttemptAt)) ||
      (value.reference !== undefined && !nonEmpty(value.reference)) ||
      (value.authenticationHash !== undefined &&
        (typeof value.authenticationHash !== "string" || !HASH_RE.test(value.authenticationHash))) ||
      (value.reason !== undefined && !nonEmpty(value.reason)) ||
      (value.lease !== undefined && !validLease(value.lease))) return false;
  if (value.generation !== value.attempts) return false;
  if (value.state === "not-started") {
    return value.generation === 0 && value.attempts === 0 && value.lease === undefined &&
      value.nextAttemptAt === undefined && value.reference === undefined &&
      value.authenticationHash === undefined && value.reason === undefined;
  }
  if (value.state === "running") {
    return value.lease !== undefined && value.lease.generation === value.generation &&
      value.nextAttemptAt === undefined && value.reference === undefined &&
      value.authenticationHash === undefined && value.reason === undefined;
  }
  if (value.state === "final") {
    return value.lease === undefined && value.nextAttemptAt === undefined &&
      value.reason === undefined && value.reference !== undefined;
  }
  return value.lease === undefined && value.reference === undefined &&
    value.authenticationHash === undefined && value.reason !== undefined;
}

export function fixedPriceX402OrderViolation(value: unknown): string | null {
  if (!plainRecord(value)) return "coordinator order must be a plain object";
  if (!exactKeys(value, [
    "storeVersion",
    "role",
    "jobId",
    "buyer",
    "seller",
    "bindingHash",
    "sdkJobs",
    "tracks",
    "createdAt",
    "updatedAt",
  ])) return "coordinator order fields are malformed";
  if (value.storeVersion !== FIXED_PRICE_X402_COORDINATOR_STORE_VERSION) {
    return "coordinator order version is unsupported";
  }
  if (value.role !== "buyer" && value.role !== "seller") {
    return "coordinator role is malformed";
  }
  if (!nonEmpty(value.jobId) || !nonEmpty(value.buyer) || !nonEmpty(value.seller) ||
      value.buyer === value.seller || typeof value.bindingHash !== "string" ||
      !HASH_RE.test(value.bindingHash) || !safeUint(value.createdAt) ||
      !safeUint(value.updatedAt) || value.updatedAt < value.createdAt) {
    return "coordinator order identity is malformed";
  }
  try {
    requireCanonicalJobId(value.jobId);
    const sdkJobs = capturePointers(value.sdkJobs);
    const expected = fixedPriceX402OrderBindingHash({
      jobId: value.jobId,
      buyer: value.buyer,
      seller: value.seller,
      sdkJobs,
    });
    if (expected !== value.bindingHash) return "coordinator order binding hash differs";
  } catch (error) {
    return String(error);
  }
  if (!plainRecord(value.tracks) || !exactKeys(value.tracks, TRACKS)) {
    return "coordinator track map is malformed";
  }
  for (const track of TRACKS) {
    const trackRecord = value.tracks[track];
    if (!validTrackRecord(trackRecord) || trackRecord.updatedAt < value.createdAt ||
        trackRecord.updatedAt > value.updatedAt) {
      return `coordinator ${track} track is malformed`;
    }
  }
  return null;
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

/**
 * Process-local reference store. Production hosts inject a durable implementation
 * of the same atomic contract; this implementation is intentionally explicit so
 * tests and single-process applications do not need an application job database.
 */
export function createInMemoryFixedPriceX402CoordinatorStore():
  FixedPriceX402CoordinatorStore {
  const records = new Map<string, FixedPriceX402OrderRecord>();

  const loadRecord = (
    role: FixedPriceX402CoordinatorRole,
    jobId: string,
  ): FixedPriceX402OrderLoad => {
    const found = records.get(key(role, jobId));
    if (!found) return { status: "missing" };
    const violation = fixedPriceX402OrderViolation(found);
    if (violation) return { status: "corrupt", reason: violation };
    return { status: "ok", record: copyRecord(found) };
  };

  return {
    async create(input) {
      const order = captureOrder(input.order);
      if (input.role !== "buyer" && input.role !== "seller") {
        return { status: "corrupt", reason: "coordinator role is malformed" };
      }
      if (!safeUint(input.now) || typeof input.bindingHash !== "string" ||
          !HASH_RE.test(input.bindingHash)) {
        return { status: "corrupt", reason: "coordinator creation input is malformed" };
      }
      const expected = fixedPriceX402OrderBindingHash(order);
      if (expected !== input.bindingHash) {
        return { status: "conflict" };
      }
      const storageKey = key(input.role, order.jobId);
      const existing = records.get(storageKey);
      if (existing) {
        const violation = fixedPriceX402OrderViolation(existing);
        if (violation) return { status: "corrupt", reason: violation };
        return existing.bindingHash === expected
          ? { status: "existing", record: copyRecord(existing) }
          : { status: "conflict" };
      }
      const record: FixedPriceX402OrderRecord = {
        storeVersion: FIXED_PRICE_X402_COORDINATOR_STORE_VERSION,
        role: input.role,
        jobId: order.jobId,
        buyer: order.buyer,
        seller: order.seller,
        bindingHash: expected,
        sdkJobs: clone(order.sdkJobs),
        tracks: emptyTracks(input.now),
        createdAt: input.now,
        updatedAt: input.now,
      };
      records.set(storageKey, copyRecord(record));
      return { status: "created", record: copyRecord(record) };
    },

    async load(role, jobId) {
      return loadRecord(role, jobId);
    },

    async list(role) {
      return [...records.values()]
        .filter((record) => record.role === role)
        .sort((left, right) => left.jobId.localeCompare(right.jobId))
        .map((record) => {
          const violation = fixedPriceX402OrderViolation(record);
          return violation
            ? { status: "corrupt" as const, reason: violation }
            : { status: "ok" as const, record: copyRecord(record) };
        });
    },

    async claim(input) {
      const loaded = loadRecord(input.role, input.jobId);
      if (loaded.status !== "ok") return loaded;
      const current = records.get(key(input.role, input.jobId))!;
      if (current.bindingHash !== input.bindingHash) return { status: "stale" };
      if (!TRACKS.includes(input.track) || !nonEmpty(input.owner) ||
          !safeUint(input.now) || !safeUint(input.leaseDurationMs) ||
          input.leaseDurationMs === 0) {
        return { status: "corrupt", reason: "coordinator track claim is malformed" };
      }
      const track = current.tracks[input.track] as FixedPriceX402TrackRecord;
      if (TERMINAL_TRACK_STATES.has(track.state)) {
        return { status: "not-runnable", record: copyRecord(current) };
      }
      if (track.nextAttemptAt !== undefined && track.nextAttemptAt > input.now) {
        return { status: "not-runnable", record: copyRecord(current) };
      }
      if (track.lease && track.lease.expiresAt > input.now) {
        return {
          status: "waiting",
          record: copyRecord(current),
          lease: clone(track.lease),
        };
      }
      const expiresAt = input.now + input.leaseDurationMs;
      if (!Number.isSafeInteger(expiresAt)) {
        return { status: "corrupt", reason: "coordinator lease expiry overflows" };
      }
      const lease: FixedPriceX402TrackLease = {
        owner: input.owner,
        generation: track.generation + 1,
        expiresAt,
      };
      const tracks = clone(current.tracks) as Record<
        FixedPriceX402Track,
        FixedPriceX402TrackRecord
      >;
      tracks[input.track] = {
        state: "running",
        generation: lease.generation,
        attempts: track.attempts + 1,
        updatedAt: input.now,
        lease,
      };
      const next: FixedPriceX402OrderRecord = {
        ...copyRecord(current),
        tracks,
        updatedAt: input.now,
      };
      records.set(key(input.role, input.jobId), copyRecord(next));
      return { status: "acquired", record: copyRecord(next), lease: clone(lease) };
    },

    async isCurrent(input) {
      const loaded = loadRecord(input.role, input.jobId);
      if (loaded.status !== "ok" || loaded.record.bindingHash !== input.bindingHash) {
        return false;
      }
      const track = loaded.record.tracks[input.track];
      return track.state === "running" && track.lease !== undefined &&
        track.lease.owner === input.lease.owner &&
        track.lease.generation === input.lease.generation &&
        track.lease.expiresAt === input.lease.expiresAt &&
        track.lease.expiresAt > input.now;
    },

    async record(input) {
      const loaded = loadRecord(input.role, input.jobId);
      if (loaded.status !== "ok") return loaded;
      const current = records.get(key(input.role, input.jobId))!;
      if (current.bindingHash !== input.bindingHash || !safeUint(input.now)) {
        return { status: "stale" };
      }
      const track = current.tracks[input.track];
      if (track.state !== "running" || !track.lease ||
          track.lease.owner !== input.lease.owner ||
          track.lease.generation !== input.lease.generation ||
          track.lease.expiresAt !== input.lease.expiresAt ||
          track.lease.expiresAt <= input.now) {
        return { status: "stale" };
      }
      const result = captureOperationResult(input.result);
      const nextTrack: FixedPriceX402TrackRecord = {
        state: result.status,
        generation: track.generation,
        attempts: track.attempts,
        updatedAt: input.now,
        ...(result.status === "final"
          ? {
              reference: result.reference,
              ...(result.authenticationHash
                ? { authenticationHash: result.authenticationHash }
                : {}),
            }
          : {
              reason: result.reason,
              ...(result.retryAt === undefined ? {} : { nextAttemptAt: result.retryAt }),
            }),
      };
      const tracks = clone(current.tracks) as Record<
        FixedPriceX402Track,
        FixedPriceX402TrackRecord
      >;
      tracks[input.track] = nextTrack;
      const next: FixedPriceX402OrderRecord = {
        ...copyRecord(current),
        tracks,
        updatedAt: input.now,
      };
      records.set(key(input.role, input.jobId), copyRecord(next));
      return { status: "recorded", record: copyRecord(next) };
    },
  };
}

function captureOperationResult(value: unknown): FixedPriceX402TrackOperationResult {
  const result = captureOwnData(value, "coordinator operation result") as unknown as
    Record<string, unknown>;
  if (result.status === "final" && exactKeys(
    result,
    ["status", "reference"],
    ["authenticationHash"],
  ) && nonEmpty(result.reference) &&
      (result.authenticationHash === undefined ||
        (typeof result.authenticationHash === "string" && HASH_RE.test(result.authenticationHash)))) {
    return result as unknown as FixedPriceX402TrackOperationResult;
  }
  if (["pending-retry", "indeterminate", "failed", "operator-action"].includes(
    result.status as string,
  ) && exactKeys(result, ["status", "reason"], ["retryAt"]) &&
      nonEmpty(result.reason) &&
      (result.retryAt === undefined || safeUint(result.retryAt))) {
    return result as unknown as FixedPriceX402TrackOperationResult;
  }
  throw new DacsError("coordinator operation result is malformed");
}

function final(record: Readonly<FixedPriceX402OrderRecord>, track: FixedPriceX402Track): boolean {
  return record.tracks[track].state === "final";
}

function eligible(record: Readonly<FixedPriceX402OrderRecord>, track: FixedPriceX402Track): boolean {
  switch (track) {
    case "agreement":
      return true;
    case "payment":
      return final(record, "agreement");
    case "payment-evidence":
    case "delivery":
      return final(record, "payment");
    case "buyer-received":
    case "delivery-evidence":
      return final(record, "delivery");
    case "audit":
      return final(record, "payment-evidence") && final(record, "delivery-evidence");
  }
}

export function projectFixedPriceX402Milestone(
  record: Readonly<FixedPriceX402OrderRecord>,
): FixedPriceX402Milestone {
  if (final(record, "audit")) return "audit-complete";
  if (final(record, "delivery-evidence")) return "commercial-performance-complete";
  if (final(record, "buyer-received")) return "buyer-received";
  if (final(record, "delivery")) return "delivery-ready";
  if (final(record, "payment")) return "payment-final";
  if (final(record, "agreement")) return "agreement-final";
  return "created";
}

export function fixedPriceX402OrderStatusViolation(value: unknown): string | null {
  if (!plainRecord(value) || !exactKeys(value, [
    "role",
    "jobId",
    "buyer",
    "seller",
    "bindingHash",
    "sdkJobs",
    "tracks",
    "milestone",
    "attention",
    "updatedAt",
  ])) return "coordinator status fields are malformed";
  if ((value.role !== "buyer" && value.role !== "seller") ||
      !nonEmpty(value.jobId) || !nonEmpty(value.buyer) || !nonEmpty(value.seller) ||
      value.buyer === value.seller || typeof value.bindingHash !== "string" ||
      !HASH_RE.test(value.bindingHash) || !safeUint(value.updatedAt)) {
    return "coordinator status identity is malformed";
  }
  let sdkJobs: FixedPriceX402SdkJobPointers;
  try {
    requireCanonicalJobId(value.jobId);
    sdkJobs = capturePointers(value.sdkJobs);
    if (fixedPriceX402OrderBindingHash({
      jobId: value.jobId,
      buyer: value.buyer,
      seller: value.seller,
      sdkJobs,
    }) !== value.bindingHash) return "coordinator status binding hash differs";
  } catch (error) {
    return String(error);
  }
  if (!plainRecord(value.tracks) || !exactKeys(value.tracks, TRACKS)) {
    return "coordinator status track map is malformed";
  }
  const tracks = value.tracks;
  for (const track of TRACKS) {
    const trackRecord = tracks[track];
    if (!validTrackRecord(trackRecord) || trackRecord.updatedAt > value.updatedAt) {
      return `coordinator status ${track} track is malformed`;
    }
  }
  const validatedTracks = tracks as Record<FixedPriceX402Track, FixedPriceX402TrackRecord>;
  const projectedMilestone = projectFixedPriceX402Milestone({
    tracks: validatedTracks,
  } as unknown as FixedPriceX402OrderRecord);
  if (value.milestone !== projectedMilestone) {
    return "coordinator status milestone is inconsistent with its tracks";
  }
  if (!plainRecord(value.attention) || !exactKeys(value.attention, ["required", "tracks"]) ||
      typeof value.attention.required !== "boolean" || !Array.isArray(value.attention.tracks) ||
      !value.attention.tracks.every((track) => TRACKS.includes(track as FixedPriceX402Track))) {
    return "coordinator status attention projection is malformed";
  }
  const expectedAttention = TRACKS.filter((track) => {
    const state = validatedTracks[track].state;
    return state === "failed" || state === "operator-action";
  });
  if (value.attention.required !== (expectedAttention.length > 0) ||
      canonicalize(value.attention.tracks) !== canonicalize(expectedAttention)) {
    return "coordinator status attention projection is inconsistent";
  }
  return null;
}

function projectStatus(
  record: Readonly<FixedPriceX402OrderRecord>,
): FixedPriceX402OrderStatus {
  const attentionTracks = TRACKS.filter((track) => {
    const state = record.tracks[track].state;
    return state === "failed" || state === "operator-action";
  });
  return clone({
    role: record.role,
    jobId: record.jobId,
    buyer: record.buyer,
    seller: record.seller,
    bindingHash: record.bindingHash,
    sdkJobs: record.sdkJobs,
    tracks: record.tracks,
    milestone: projectFixedPriceX402Milestone(record),
    attention: {
      required: attentionTracks.length > 0,
      tracks: attentionTracks,
    },
    updatedAt: record.updatedAt,
  });
}

function captureOptions(value: unknown): {
  role: FixedPriceX402CoordinatorRole;
  store: FixedPriceX402CoordinatorStore;
  workerId: string;
  operations: Map<FixedPriceX402Track, FixedPriceX402TrackOperation>;
  leaseDurationMs: number;
  now: () => number;
} {
  if (!plainRecord(value) || !exactKeys(
    value,
    ["role", "store", "workerId", "operations"],
    ["leaseDurationMs", "now"],
  ) || (value.role !== "buyer" && value.role !== "seller") ||
      !nonEmpty(value.workerId) || !plainRecord(value.store) ||
      !plainRecord(value.operations)) {
    throw new DacsError("fixed-price x402 coordinator options are malformed");
  }
  const store = value.store as unknown as FixedPriceX402CoordinatorStore;
  for (const method of ["create", "load", "list", "claim", "isCurrent", "record"] as const) {
    if (typeof store[method] !== "function") {
      throw new DacsError(`fixed-price x402 coordinator store.${method} is required`);
    }
  }
  const operations = new Map<FixedPriceX402Track, FixedPriceX402TrackOperation>();
  for (const key of Reflect.ownKeys(value.operations)) {
    if (typeof key !== "string" || !TRACKS.includes(key as FixedPriceX402Track) ||
        typeof value.operations[key] !== "function") {
      throw new DacsError("fixed-price x402 coordinator operation is unsupported");
    }
    operations.set(key as FixedPriceX402Track, value.operations[key] as FixedPriceX402TrackOperation);
  }
  const leaseDurationMs = value.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  if (!safeUint(leaseDurationMs) || leaseDurationMs === 0) {
    throw new DacsError("fixed-price x402 coordinator leaseDurationMs must be positive");
  }
  const now = value.now ?? Date.now;
  if (typeof now !== "function") {
    throw new DacsError("fixed-price x402 coordinator now must be a function");
  }
  return {
    role: value.role,
    store,
    workerId: value.workerId,
    operations,
    leaseDurationMs,
    now: () => {
      const result = Reflect.apply(now, INERT_RECEIVER, []);
      if (!safeUint(result)) throw new DacsError("coordinator clock returned an invalid time");
      return result;
    },
  };
}

/**
 * Combine independently retained actor projections without joining their
 * capabilities. A global audit claim requires both role-owned audit tracks.
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
      canonicalize(buyer.sdkJobs) !== canonicalize(seller.sdkJobs)) {
    throw new DacsError("buyer and seller coordinator statuses do not bind the same order");
  }
  const expectedBinding = fixedPriceX402OrderBindingHash({
    jobId: buyer.jobId,
    buyer: buyer.buyer,
    seller: buyer.seller,
    sdkJobs: buyer.sdkJobs,
  });
  if (buyer.bindingHash !== expectedBinding) {
    throw new DacsError("combined coordinator status has an invalid order binding");
  }
  const actorFinal = (
    status: Readonly<FixedPriceX402OrderStatus>,
    track: FixedPriceX402Track,
  ): boolean => status.tracks[track]?.state === "final";
  const milestone: FixedPriceX402Milestone =
    actorFinal(buyer, "audit") && actorFinal(seller, "audit")
      ? "audit-complete"
      : actorFinal(seller, "delivery-evidence")
        ? "commercial-performance-complete"
        : actorFinal(buyer, "buyer-received")
          ? "buyer-received"
          : actorFinal(seller, "delivery")
            ? "delivery-ready"
            : actorFinal(buyer, "payment") && actorFinal(seller, "payment")
              ? "payment-final"
              : actorFinal(buyer, "agreement") && actorFinal(seller, "agreement")
                ? "agreement-final"
                : "created";
  const attentionTracks = ([buyer, seller] as const).flatMap((status) =>
    TRACKS.filter((track) => {
      const state = status.tracks[track]?.state;
      return state === "failed" || state === "operator-action";
    }).map((track) => ({ role: status.role, track }))
  );
  return clone({
    jobId: buyer.jobId,
    buyer: buyer.buyer,
    seller: buyer.seller,
    bindingHash: buyer.bindingHash,
    sdkJobs: buyer.sdkJobs,
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
    const violation = fixedPriceX402OrderViolation(loaded.record);
    if (violation) throw new DacsError(violation);
    if (loaded.record.role !== captured.role) {
      throw new DacsError("coordinator store returned the wrong actor role");
    }
    return copyRecord(loaded.record);
  };

  const run = async (
    input: Readonly<{ limit?: number; signal?: AbortSignal }> = {},
  ): Promise<readonly FixedPriceX402WorkReport[]> => {
    if (!plainRecord(input) || !exactKeys(input, [], ["limit", "signal"]) ||
        (input.signal !== undefined && !(input.signal instanceof AbortSignal))) {
      throw new DacsError("coordinator run options are malformed");
    }
    const limit = runLimit(input.limit);
    const reports: FixedPriceX402WorkReport[] = [];
    const listed = clone(await captured.store.list(captured.role));
    for (const load of listed) {
      if (reports.length >= limit || input.signal?.aborted) break;
      if (load.status !== "ok") {
        if (load.status === "corrupt" || load.status === "unsupported") {
          throw new DacsError(
            load.status === "corrupt"
              ? load.reason
              : `coordinator store version ${load.version} is unsupported`,
          );
        }
        continue;
      }
      let record = requireCoordinatorRecord(load.record, captured.role);
      const processed = new Set<FixedPriceX402Track>();
      while (reports.length < limit && !input.signal?.aborted) {
        const track = TRACKS.find((candidate) => {
          if (processed.has(candidate) || !captured.operations.has(candidate) ||
              !eligible(record, candidate)) return false;
          const state = record.tracks[candidate].state;
          return !TERMINAL_TRACK_STATES.has(state) &&
            (record.tracks[candidate].nextAttemptAt === undefined ||
              record.tracks[candidate].nextAttemptAt! <= captured.now());
        });
        if (!track) break;
        processed.add(track);
        const now = captured.now();
        const claim = clone(await captured.store.claim({
          role: captured.role,
          jobId: record.jobId,
          bindingHash: record.bindingHash,
          track,
          owner: captured.workerId,
          now,
          leaseDurationMs: captured.leaseDurationMs,
        }));
        if (claim.status !== "acquired") {
          if (claim.status === "corrupt") throw new DacsError(claim.reason);
          if (claim.status === "unsupported") {
            throw new DacsError(`coordinator store version ${claim.version} is unsupported`);
          }
          reports.push({
            jobId: record.jobId,
            track,
            status: claim.status === "waiting" ? "waiting" :
              claim.status === "stale" ? "stale" : "skipped",
          });
          if (claim.status === "waiting" || claim.status === "not-runnable") {
            record = requireCoordinatorRecord(
              claim.record,
              captured.role,
              record.bindingHash,
            );
          }
          continue;
        }
        record = requireCoordinatorRecord(
          claim.record,
          captured.role,
          record.bindingHash,
        );
        const lease = clone(claim.lease);
        const retainedLease = record.tracks[track].lease;
        if (!validLease(lease) || !retainedLease ||
            canonicalize(lease) !== canonicalize(retainedLease)) {
          throw new DacsError("coordinator store returned an invalid track lease");
        }
        const fence: FixedPriceX402EffectFence = Object.freeze({
          role: captured.role,
          jobId: record.jobId,
          bindingHash: record.bindingHash,
          track,
          owner: lease.owner,
          generation: lease.generation,
          idempotencyKey: sha256Hex(canonicalize({
            bindingHash: record.bindingHash,
            track,
          })),
          assertCurrent: async () => {
            const current = await captured.store.isCurrent({
              role: captured.role,
              jobId: record.jobId,
              bindingHash: record.bindingHash,
              track,
              lease,
              now: captured.now(),
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
        } catch (error) {
          result = {
            status: "indeterminate",
            reason: `coordinator operation threw: ${String(error)}`,
          };
        }
        const written = clone(await captured.store.record({
          role: captured.role,
          jobId: record.jobId,
          bindingHash: record.bindingHash,
          track,
          lease,
          result,
          now: captured.now(),
        }));
        if (written.status === "recorded") {
          record = requireCoordinatorRecord(
            written.record,
            captured.role,
            record.bindingHash,
          );
          reports.push({
            jobId: record.jobId,
            track,
            status: result.status,
            ...(result.status === "final" ? {} : { reason: result.reason }),
          });
        } else if (written.status === "corrupt") {
          throw new DacsError(written.reason);
        } else if (written.status === "unsupported") {
          throw new DacsError(`coordinator store version ${written.version} is unsupported`);
        } else {
          reports.push({ jobId: record.jobId, track, status: "stale" });
        }
      }
    }
    return clone(reports);
  };

  const coordinator: FixedPriceX402CommerceCoordinator = {
    role: captured.role,
    async startOrder(input) {
      const order = captureOrder(input);
      const bindingHash = fixedPriceX402OrderBindingHash(order);
      const created = clone(await captured.store.create({
        role: captured.role,
        order,
        bindingHash,
        now: captured.now(),
      }));
      if (created.status === "conflict") {
        throw new DacsError("coordinator order conflicts with an existing binding");
      }
      if (created.status === "corrupt") throw new DacsError(created.reason);
      if (created.status === "unsupported") {
        throw new DacsError(`coordinator store version ${created.version} is unsupported`);
      }
      const record = requireCoordinatorRecord(created.record, captured.role, bindingHash);
      return projectStatus(record);
    },
    async getOrderStatus(jobId) {
      const record = await get(jobId);
      return record ? projectStatus(record) : null;
    },
    runPending: run,
    resumePendingOrders: run,
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

import { DacsError } from "../errors.js";
import { isCanonicalSettlementIdentity } from "./settlementIdentity.js";

/**
 * Explicit generation-fenced session state schema. Version 2 adds fencing generations, immutable
 * payment-authorization bindings, and phase-indexed receipts. Version-1 files
 * remain recognisable by persistent readers, but are deliberately unsupported:
 * silently upgrading them would manufacture the fencing data that proves which
 * worker was authorised to commit an irreversible outcome.
 */
export const FENCED_SESSION_STORE_VERSION = 2 as const;

export type SessionPhase = string;

/** Role-local, unscoped operational lifecycle for terminal FAB publication. */
export type TerminalBundleStoreRole = "buyer" | "seller" | "orchestrator";
export type TerminalBundleStoreStage =
  | "authority"
  | "proposal-publication-pending"
  | "contribution-signing"
  | "contribution-publication-pending"
  | "matrix-review"
  | "bundle-anchor-pending"
  | "bundle-binding-signing"
  | "bundle-binding-publication-pending"
  | "finalised";

const TERMINAL_BUNDLE_STAGE_RANK: ReadonlyMap<TerminalBundleStoreStage, number> =
  new Map<TerminalBundleStoreStage, number>([
    ["authority", 0],
    ["proposal-publication-pending", 1],
    ["contribution-signing", 2],
    ["contribution-publication-pending", 3],
    ["matrix-review", 4],
    ["bundle-anchor-pending", 5],
    ["bundle-binding-signing", 6],
    ["bundle-binding-publication-pending", 7],
    ["finalised", 8],
  ]);

export function terminalBundleStorePhase(
  role: TerminalBundleStoreRole,
  stage: TerminalBundleStoreStage,
): SessionPhase {
  return `terminal:${role}:${stage}`;
}

interface TerminalBundlePhaseProgress {
  role: TerminalBundleStoreRole;
  stage: TerminalBundleStoreStage;
  rank: number;
  final: boolean;
}

function terminalBundlePhaseProgress(phase: string): TerminalBundlePhaseProgress | null {
  const match = /^terminal:(buyer|seller|orchestrator):([a-z-]+)$/.exec(phase);
  if (!match) return null;
  const role = match[1] as TerminalBundleStoreRole;
  const stage = match[2] as TerminalBundleStoreStage;
  const rank = TERMINAL_BUNDLE_STAGE_RANK.get(stage);
  return rank === undefined
    ? null
    : { role, stage, rank, final: stage === "finalised" };
}

/** Globally sealed phases reject every later lease or mutation. */
export function sessionPhaseIsTerminal(phase: string): boolean {
  return (
    phase === "seller:completed" ||
    // `seller:failed` is a semantic terminal outcome but remains operationally
    // open until its terminal FAB publication is durably sealed.
    phase === "seller:rejected" ||
    phase === "seller:finalised" ||
    phase === "buyer:finalised" ||
    terminalBundlePhaseProgress(phase)?.final === true
  );
}

/** An immutable reference to one session side effect. */
export interface SessionReceipt {
  kind: "agreement" | "settlement" | "delivery" | "fulfilment" | "bundle";
  ref: string;
  /** DACS-4 PIPE-5/SB-1 invocation index. Omit only for session-wide receipts. */
  phaseIndex?: number;
  recordedAt?: number;
}

/** Stable receipt identity; repeated pipeline phases cannot overwrite each other. */
export function sessionReceiptKey(
  receipt: Pick<SessionReceipt, "kind" | "phaseIndex">,
): string {
  return receipt.phaseIndex === undefined
    ? receipt.kind
    : `${receipt.kind}:${receipt.phaseIndex}`;
}

export type CheckpointValue = string | number | boolean;

/** Write-ahead intent or definitive outcome for one stable side-effect key. */
export interface SessionCheckpoint {
  key: string;
  stage: "intent" | "outcome";
  data?: Record<string, CheckpointValue>;
}

/** Monotonic token identifying exactly one lease acquisition. */
export interface SessionLeaseToken {
  owner: string;
  generation: number;
}

export interface SessionLease extends SessionLeaseToken {
  expiresAt: number;
  /** Seller delivery invocation this acquisition may advance/recover. */
  sellerPhaseIndex?: number;
}

/**
 * Immutable seller payment authority retained across restarts. `settlementId`
 * is the canonical DACS-4 SB-1 event/instruction identity, not an evidence hash.
 */
export interface SessionPaymentAuthorizationBinding {
  /** Hash of the exact receipt-store-retained SellerPaymentAuthorization. */
  authorizationHash: string;
  /** Canonical v2 seller fulfilment id retained by the consumed handoff. */
  fulfilmentId: string;
  /** Hash of the exact losslessly encoded consumed handoff. */
  handoffBindingHash: string;
  agreementHash: string;
  paymentEvidenceHash: string;
  settlementId: string;
  paymentPhaseIndex: number;
  deliveryPhaseIndex: number;
}

export interface SessionRecord {
  storeVersion: typeof FENCED_SESSION_STORE_VERSION;
  jobId: string;
  agreementHash?: string;
  paymentAuthorizations: SessionPaymentAuthorizationBinding[];
  phase: SessionPhase;
  revision: number;
  /** Never decreases, including after a lease is released. */
  leaseGeneration: number;
  lease?: SessionLease;
  checkpoints: SessionCheckpoint[];
  receipts: SessionReceipt[];
  createdAt: number;
  updatedAt: number;
}

const RECEIPT_KINDS = new Set<SessionReceipt["kind"]>([
  "agreement",
  "settlement",
  "delivery",
  "fulfilment",
  "bundle",
]);

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0);
const isNonNegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && !Object.is(value, -0);
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function accessorKey(value: Record<string, unknown>): string | undefined {
  return Object.entries(Object.getOwnPropertyDescriptors(value))
    .find(([, descriptor]) => descriptor.get !== undefined || descriptor.set !== undefined)?.[0];
}

function explicitUndefinedKey(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  return keys.find((key) => hasOwn(value, key) && value[key] === undefined);
}

function unexpectedKey(
  value: Record<string, unknown>,
  allowed: readonly string[],
): string | undefined {
  const allowedSet = new Set(allowed);
  return Object.keys(value).find((key) => !allowedSet.has(key));
}

function checkpointShapeViolation(value: unknown): string | null {
  if (!isPlainRecord(value)) return "checkpoint must be an object";
  const accessor = accessorKey(value);
  if (accessor) return `checkpoint.${accessor} must be a data property`;
  const extra = unexpectedKey(value, ["key", "stage", "data"]);
  if (extra) return `checkpoint.${extra} is not a v2 field`;
  const undefinedKey = explicitUndefinedKey(value, ["data"]);
  if (undefinedKey) return `checkpoint.${undefinedKey} must be omitted, not undefined`;
  if (!isNonEmptyString(value.key)) {
    return "checkpoint.key must be a non-empty string";
  }
  if (value.stage !== "intent" && value.stage !== "outcome") {
    return "checkpoint.stage must be intent or outcome";
  }
  if (value.data !== undefined) {
    if (!isPlainRecord(value.data)) return "checkpoint.data must be an object";
    const dataAccessor = accessorKey(value.data);
    if (dataAccessor) {
      return `checkpoint.data.${dataAccessor} must be a data property`;
    }
    for (const [key, item] of Object.entries(value.data)) {
      const type = typeof item;
      if (type !== "string" && type !== "boolean" &&
          (!isFiniteNumber(item) || Object.is(item, -0))) {
        return `checkpoint.data.${key} must be a string, boolean, or finite number`;
      }
    }
  }
  return null;
}

function receiptShapeViolation(value: unknown): string | null {
  if (!isPlainRecord(value)) return "receipt must be an object";
  const accessor = accessorKey(value);
  if (accessor) return `receipt.${accessor} must be a data property`;
  const extra = unexpectedKey(value, ["kind", "ref", "phaseIndex", "recordedAt"]);
  if (extra) return `receipt.${extra} is not a v2 field`;
  const undefinedKey = explicitUndefinedKey(value, ["phaseIndex", "recordedAt"]);
  if (undefinedKey) return `receipt.${undefinedKey} must be omitted, not undefined`;
  if (!RECEIPT_KINDS.has(value.kind as SessionReceipt["kind"])) {
    return "receipt.kind is invalid";
  }
  if (!isNonEmptyString(value.ref)) {
    return "receipt.ref must be a non-empty string";
  }
  if (value.phaseIndex !== undefined && !isNonNegativeInteger(value.phaseIndex)) {
    return "receipt.phaseIndex must be a non-negative safe integer";
  }
  if (value.recordedAt !== undefined && !isFiniteNumber(value.recordedAt)) {
    return "receipt.recordedAt must be a finite number";
  }
  return null;
}

function paymentBindingShapeViolation(value: unknown): string | null {
  if (!isPlainRecord(value)) return "payment authorization must be an object";
  const accessor = accessorKey(value);
  if (accessor) return `paymentAuthorization.${accessor} must be a data property`;
  const extra = unexpectedKey(value, [
    "authorizationHash",
    "fulfilmentId",
    "handoffBindingHash",
    "agreementHash",
    "paymentEvidenceHash",
    "settlementId",
    "paymentPhaseIndex",
    "deliveryPhaseIndex",
  ]);
  if (extra) return `paymentAuthorization.${extra} is not a v2 field`;
  const hashFields = [
    "authorizationHash",
    "fulfilmentId",
    "handoffBindingHash",
    "agreementHash",
    "paymentEvidenceHash",
  ] as const;
  for (const field of hashFields) {
    if (typeof value[field] !== "string" || !/^[0-9a-f]{64}$/.test(value[field])) {
      return `paymentAuthorization.${field} must be an exact lower-case sha256 hash`;
    }
  }
  if (!isCanonicalSettlementIdentity(value.settlementId)) {
    return "paymentAuthorization.settlementId must be a canonical SB-1 settlement identity";
  }
  if (!isNonNegativeInteger(value.paymentPhaseIndex)) {
    return "paymentAuthorization.paymentPhaseIndex must be a non-negative safe integer";
  }
  if (!isNonNegativeInteger(value.deliveryPhaseIndex)) {
    return "paymentAuthorization.deliveryPhaseIndex must be a non-negative safe integer";
  }
  return null;
}

export function assertCheckpointPayloadShape(cp: SessionCheckpoint): void {
  const violation = checkpointShapeViolation(cp);
  if (violation) throw new DacsError(violation);
}

export function assertSessionReceiptShape(receipt: SessionReceipt): void {
  const violation = receiptShapeViolation(receipt);
  if (violation) throw new DacsError(violation);
}

export function assertSessionPaymentAuthorizationShape(
  binding: SessionPaymentAuthorizationBinding,
): void {
  const violation = paymentBindingShapeViolation(binding);
  if (violation) throw new DacsError(violation);
}

/** Validate a complete persisted v2 record. */
export function sessionRecordShapeViolation(value: unknown): string | null {
  if (!isPlainRecord(value)) return "session record must be an object";
  const accessor = accessorKey(value);
  if (accessor) return `${accessor} must be a data property`;
  const extra = unexpectedKey(value, [
    "storeVersion",
    "jobId",
    "agreementHash",
    "paymentAuthorizations",
    "phase",
    "revision",
    "leaseGeneration",
    "lease",
    "checkpoints",
    "receipts",
    "createdAt",
    "updatedAt",
  ]);
  if (extra) return `${extra} is not a v2 session-record field`;
  const undefinedKey = explicitUndefinedKey(value, ["agreementHash", "lease"]);
  if (undefinedKey) return `${undefinedKey} must be omitted, not undefined`;
  if (value.storeVersion !== FENCED_SESSION_STORE_VERSION) {
    return "storeVersion does not match this reader";
  }
  if (!isNonEmptyString(value.jobId)) return "jobId missing or invalid";
  if (value.agreementHash !== undefined && !isNonEmptyString(value.agreementHash)) {
    return "agreementHash must be a non-empty string when present";
  }
  if (!Array.isArray(value.paymentAuthorizations)) {
    return "paymentAuthorizations missing or not an array";
  }
  const authorizationPhases = new Set<number>();
  const deliveryPhases = new Set<number>();
  const authorizationSettlements = new Set<string>();
  for (let index = 0; index < value.paymentAuthorizations.length; index++) {
    const authorization = value.paymentAuthorizations[index];
    const violation = paymentBindingShapeViolation(authorization);
    if (violation) return `paymentAuthorizations[${index}]: ${violation}`;
    const typed = authorization as SessionPaymentAuthorizationBinding;
    if (value.agreementHash !== typed.agreementHash) {
      return `paymentAuthorizations[${index}] agreementHash must equal record agreementHash`;
    }
    if (authorizationPhases.has(typed.paymentPhaseIndex)) {
      return `paymentAuthorizations[${index}] duplicates payment phase ${typed.paymentPhaseIndex}`;
    }
    if (deliveryPhases.has(typed.deliveryPhaseIndex)) {
      return `paymentAuthorizations[${index}] duplicates delivery phase ${typed.deliveryPhaseIndex}`;
    }
    if (authorizationSettlements.has(typed.settlementId)) {
      return `paymentAuthorizations[${index}] reuses settlement ${typed.settlementId}`;
    }
    authorizationPhases.add(typed.paymentPhaseIndex);
    deliveryPhases.add(typed.deliveryPhaseIndex);
    authorizationSettlements.add(typed.settlementId);
  }
  if (!isNonEmptyString(value.phase)) return "phase missing or invalid";
  if (value.phase.startsWith("seller:") &&
      value.phase !== "seller:failed" &&
      !sessionPhaseIsTerminal(value.phase) &&
      sellerDeliveryPhaseProgress(value.phase) === null &&
      sellerBundlePhaseRank(value.phase) === null) {
    return "phase uses a malformed or unrecognized reserved seller lifecycle value";
  }
  if (value.phase.startsWith("buyer:") &&
      !sessionPhaseIsTerminal(value.phase) &&
      buyerBundlePhaseRank(value.phase) === null) {
    return "phase uses a malformed or unrecognized reserved buyer lifecycle value";
  }
  if (value.phase.startsWith("terminal:") && terminalBundlePhaseProgress(value.phase) === null) {
    return "phase uses a malformed or unrecognized reserved terminal bundle lifecycle value";
  }
  if (!isNonNegativeInteger(value.revision)) {
    return "revision must be a non-negative safe integer";
  }
  if (!isNonNegativeInteger(value.leaseGeneration)) {
    return "leaseGeneration must be a non-negative safe integer";
  }
  if (!isFiniteNumber(value.createdAt)) return "createdAt must be finite";
  if (!isFiniteNumber(value.updatedAt)) return "updatedAt must be finite";
  if (value.lease !== undefined) {
    if (!isPlainRecord(value.lease)) return "lease must be an object";
    const leaseAccessor = accessorKey(value.lease);
    if (leaseAccessor) return `lease.${leaseAccessor} must be a data property`;
    const leaseExtra = unexpectedKey(value.lease, [
      "owner",
      "generation",
      "expiresAt",
      "sellerPhaseIndex",
    ]);
    if (leaseExtra) return `lease.${leaseExtra} is not a v2 field`;
    if (hasOwn(value.lease, "sellerPhaseIndex") &&
        value.lease.sellerPhaseIndex === undefined) {
      return "lease.sellerPhaseIndex must be omitted, not undefined";
    }
    if (!isNonEmptyString(value.lease.owner)) {
      return "lease.owner must be a non-empty string";
    }
    if (!isNonNegativeInteger(value.lease.generation) || value.lease.generation === 0) {
      return "lease.generation must be a positive safe integer";
    }
    if (value.lease.generation !== value.leaseGeneration) {
      return "lease.generation must equal leaseGeneration";
    }
    if (!isFiniteNumber(value.lease.expiresAt)) {
      return "lease.expiresAt must be finite";
    }
    if (
      value.lease.sellerPhaseIndex !== undefined &&
      !isNonNegativeInteger(value.lease.sellerPhaseIndex)
    ) {
      return "lease.sellerPhaseIndex must be a non-negative safe integer";
    }
    if (sessionPhaseIsTerminal(value.phase)) {
      return "a globally terminal session cannot retain a lease";
    }
    const progress = sellerDeliveryPhaseProgress(value.phase);
    if (
      sellerBundlePhaseRank(value.phase) !== null &&
      value.lease.sellerPhaseIndex !== undefined
    ) {
      return "a seller bundle phase requires an unscoped lease";
    }
    if (
      buyerBundlePhaseRank(value.phase) !== null &&
      value.lease.sellerPhaseIndex !== undefined
    ) {
      return "a buyer bundle phase requires an unscoped lease";
    }
    if (
      terminalBundlePhaseProgress(value.phase) !== null &&
      value.lease.sellerPhaseIndex !== undefined
    ) {
      return "a terminal bundle phase requires an unscoped lease";
    }
    if (
      progress &&
      !progress.terminal &&
      value.lease.sellerPhaseIndex === undefined
    ) {
      return "an active seller delivery phase requires a scoped lease";
    }
    if (progress && value.lease.sellerPhaseIndex !== undefined) {
      const scopedIndex = value.lease.sellerPhaseIndex as number;
      if (
        (progress.terminal &&
          (progress.outcome !== "completed" || scopedIndex <= progress.index)) ||
        (!progress.terminal && scopedIndex !== progress.index)
      ) {
        return "lease.sellerPhaseIndex contradicts the persisted seller phase";
      }
    }
  }
  if (!Array.isArray(value.checkpoints)) return "checkpoints missing or invalid";
  const stages = new Map<string, "intent" | "outcome">();
  for (let index = 0; index < value.checkpoints.length; index++) {
    const checkpoint = value.checkpoints[index];
    const violation = checkpointShapeViolation(checkpoint);
    if (violation) return `checkpoints[${index}]: ${violation}`;
    const cp = checkpoint as SessionCheckpoint;
    const previous = stages.get(cp.key);
    if (cp.stage === "intent" && previous !== undefined) {
      return `checkpoints[${index}]: duplicate intent for ${cp.key}`;
    }
    if (cp.stage === "outcome" && previous !== "intent") {
      return `checkpoints[${index}]: outcome for ${cp.key} lacks one intent`;
    }
    stages.set(cp.key, cp.stage);
  }
  if (!Array.isArray(value.receipts)) return "receipts missing or invalid";
  const receiptRefs = new Map<string, string>();
  for (let index = 0; index < value.receipts.length; index++) {
    const receipt = value.receipts[index];
    const violation = receiptShapeViolation(receipt);
    if (violation) return `receipts[${index}]: ${violation}`;
    const typed = receipt as SessionReceipt;
    const key = sessionReceiptKey(typed);
    const previous = receiptRefs.get(key);
    if (previous !== undefined) {
      return previous === typed.ref
        ? `receipts[${index}]: duplicate immutable receipt ${key}`
        : `receipts[${index}]: immutable receipt ${key} conflicts`;
    }
    receiptRefs.set(key, typed.ref);
  }
  const terminalProgress = terminalBundlePhaseProgress(value.phase);
  if (terminalProgress) {
    const resultKey = `terminal:${terminalProgress.role}:result`;
    const resultStage = stages.get(resultKey);
    if (terminalProgress.final) {
      if (resultStage !== "outcome") {
        return "a final terminal bundle phase requires its durable result outcome";
      }
      if (!receiptRefs.has("bundle")) {
        return "a final terminal bundle phase requires its immutable bundle receipt";
      }
    } else if (resultStage === "outcome") {
      return "a terminal bundle result outcome cannot precede the atomic final seal";
    }
  }
  return null;
}

export type SessionLoad =
  | { status: "missing" }
  | { status: "corrupt"; reason: string }
  | { status: "unsupported"; version: number }
  | { status: "ok"; record: SessionRecord };

export type MutationFailureReason =
  | "not-found"
  | "revision-mismatch"
  | "immutable-receipt"
  | "checkpoint-state"
  | "lease-held"
  | "lease-fenced"
  | "lease-expired"
  | "phase-regression"
  | "terminal-state"
  | "corrupt"
  | "unsupported";

export type TransitionResult =
  | { ok: true; record: SessionRecord }
  | { ok: false; reason: MutationFailureReason; record?: SessionRecord };

export type CheckpointClaimResult =
  | { ok: true; record: SessionRecord }
  | {
      ok: false;
      reason:
        | Exclude<MutationFailureReason, "revision-mismatch" | "immutable-receipt" | "checkpoint-state">
        | "held"
        | "completed";
      record?: SessionRecord;
    };

export interface CheckpointClaimInput {
  jobId: string;
  key: string;
  data?: Record<string, CheckpointValue>;
  phase?: SessionPhase;
  leaseToken?: SessionLeaseToken;
  now?: number;
}

export interface TransitionInput {
  jobId: string;
  expectedRevision: number;
  /** Required, exact, and unexpired whenever the record carries a lease. */
  leaseToken?: SessionLeaseToken;
  phase?: SessionPhase;
  checkpoint?: SessionCheckpoint;
  receipt?: SessionReceipt;
  /** Release the current lease as part of this same CAS. */
  lease?: null;
  now?: number;
}

export type LeaseResult =
  | { ok: true; record: SessionRecord; lease: SessionLease }
  | {
      ok: false;
      reason:
        | "not-found"
        | "lease-held"
        | "lease-fenced"
        | "lease-expired"
        | "phase-regression"
        | "terminal-state"
        | "corrupt"
        | "unsupported";
      record?: SessionRecord;
    };

export type SessionAuthorizationBindingResult =
  | { ok: true; record: SessionRecord }
  | {
      ok: false;
      reason:
        | "not-found"
        | "agreement-conflict"
        | "payment-conflict"
        | "settlement-replay"
        | "lease-fenced"
        | "lease-expired"
        | "phase-regression"
        | "terminal-state"
        | "corrupt"
        | "unsupported";
      boundTo?: string;
      record?: SessionRecord;
    };

export interface FencedSessionStoreV2 {
  /** Explicit runtime/API boundary; v1 stores cannot be upgraded implicitly. */
  readonly apiVersion: typeof FENCED_SESSION_STORE_VERSION;
  create(input: {
    jobId: string;
    agreementHash?: string;
    phase?: SessionPhase;
    now?: number;
  }): Promise<SessionRecord>;
  load(jobId: string): Promise<SessionLoad>;
  transition(input: TransitionInput): Promise<TransitionResult>;
  claimCheckpoint(input: CheckpointClaimInput): Promise<CheckpointClaimResult>;
  /** A fresh acquisition always mints a larger generation; live leases cannot be reacquired. */
  acquireLease(input: {
    jobId: string;
    owner: string;
    ttlMs: number;
    /** Scope a seller worker to one repeated delivery phase. */
    sellerPhaseIndex?: number;
    now?: number;
  }): Promise<LeaseResult>;
  /** Renew only the exact live owner+generation token. */
  renewLease(input: {
    jobId: string;
    leaseToken: SessionLeaseToken;
    ttlMs: number;
    now?: number;
  }): Promise<LeaseResult>;
  /**
   * Atomically set-once the agreement/payment authority on one session and bind
   * the canonical settlement event to exactly one (jobId, paymentPhaseIndex).
   * DACS-4 §9.5.8 SB-1/SB-2.
   */
  bindSessionAuthorization(input: {
    jobId: string;
    binding: SessionPaymentAuthorizationBinding;
    leaseToken?: SessionLeaseToken;
    now?: number;
  }): Promise<SessionAuthorizationBindingResult>;
  bindHash(input: {
    hash: string;
    jobId: string;
    kind: "agreement" | "transaction";
  }): Promise<{ ok: boolean; boundTo?: string }>;
  list(filter?: { phase?: SessionPhase; limit?: number }): Promise<SessionRecord[]>;
}

type CreateInput = Parameters<FencedSessionStoreV2["create"]>[0];
type AcquireLeaseInput = Parameters<FencedSessionStoreV2["acquireLease"]>[0];
type RenewLeaseInput = Parameters<FencedSessionStoreV2["renewLease"]>[0];
type AuthorizationInput = Parameters<FencedSessionStoreV2["bindSessionAuthorization"]>[0];
type BindHashInput = Parameters<FencedSessionStoreV2["bindHash"]>[0];
type ListFilter = NonNullable<Parameters<FencedSessionStoreV2["list"]>[0]>;

function snapshotExactRecord(
  value: unknown,
  label: string,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new DacsError(`${label} must be a plain object`);
  const allowedSet = new Set(allowed);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedSet.has(key)) {
      throw new DacsError(`${label}.${String(key)} is not a v2 field`);
    }
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
      throw new DacsError(`${label}.${key} must be an enumerable data property`);
    }
  }
  for (const key of required) {
    if (!hasOwn(value, key) || value[key] === undefined) {
      throw new DacsError(`${label}.${key} is required`);
    }
  }
  for (const key of allowed) {
    if (!required.includes(key) && hasOwn(value, key) && value[key] === undefined) {
      throw new DacsError(`${label}.${key} must be omitted, not undefined`);
    }
  }
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
  );
}

function assertJobId(value: unknown, label = "jobId"): asserts value is string {
  if (!isNonEmptyString(value)) {
    throw new DacsError(`${label} must be a non-empty trimmed string`);
  }
}

function assertOptionalNow(
  value: unknown,
  label: string,
): asserts value is number | undefined {
  if (value !== undefined && !isNonNegativeInteger(value)) {
    throw new DacsError(`${label} must be a non-negative safe integer`);
  }
}

function snapshotLeaseToken(value: unknown, label: string): SessionLeaseToken {
  // LeaseResult intentionally returns the complete lease and callers may pass
  // that value straight back as the token. Accept its two immutable metadata
  // fields, validate them, then project only owner+generation as authority.
  const input = snapshotExactRecord(
    value,
    label,
    ["owner", "generation", "expiresAt", "sellerPhaseIndex"],
    ["owner", "generation"],
  );
  if (!isNonEmptyString(input.owner)) {
    throw new DacsError(`${label}.owner must be a non-empty trimmed string`);
  }
  if (!isNonNegativeInteger(input.generation) || input.generation === 0) {
    throw new DacsError(`${label}.generation must be a positive safe integer`);
  }
  if (input.expiresAt !== undefined && !isNonNegativeInteger(input.expiresAt)) {
    throw new DacsError(`${label}.expiresAt must be a non-negative safe integer`);
  }
  if (input.sellerPhaseIndex !== undefined &&
      !isNonNegativeInteger(input.sellerPhaseIndex)) {
    throw new DacsError(
      `${label}.sellerPhaseIndex must be a non-negative safe integer`,
    );
  }
  return { owner: input.owner, generation: input.generation };
}

function snapshotCheckpoint(value: unknown, label: string): SessionCheckpoint {
  const input = snapshotExactRecord(value, label, ["key", "stage", "data"], [
    "key",
    "stage",
  ]);
  assertCheckpointPayloadShape(input as unknown as SessionCheckpoint);
  return structuredClone(input) as unknown as SessionCheckpoint;
}

function snapshotReceipt(value: unknown, label: string): SessionReceipt {
  const input = snapshotExactRecord(
    value,
    label,
    ["kind", "ref", "phaseIndex", "recordedAt"],
    ["kind", "ref"],
  );
  assertSessionReceiptShape(input as unknown as SessionReceipt);
  return structuredClone(input) as unknown as SessionReceipt;
}

function snapshotBinding(
  value: unknown,
  label: string,
): SessionPaymentAuthorizationBinding {
  const keys = [
    "authorizationHash",
    "fulfilmentId",
    "handoffBindingHash",
    "agreementHash",
    "paymentEvidenceHash",
    "settlementId",
    "paymentPhaseIndex",
    "deliveryPhaseIndex",
  ] as const;
  const input = snapshotExactRecord(value, label, keys, keys);
  assertSessionPaymentAuthorizationShape(
    input as unknown as SessionPaymentAuthorizationBinding,
  );
  return structuredClone(input) as unknown as SessionPaymentAuthorizationBinding;
}

/** @internal Exact runtime boundary shared by both v2 implementations. */
export function snapshotFencedCreateInput(value: unknown): CreateInput {
  const input = snapshotExactRecord(
    value,
    "create",
    ["jobId", "agreementHash", "phase", "now"],
    ["jobId"],
  );
  assertJobId(input.jobId, "create.jobId");
  if (input.agreementHash !== undefined && !isNonEmptyString(input.agreementHash)) {
    throw new DacsError("create.agreementHash must be a non-empty trimmed string");
  }
  if (input.phase !== undefined && !isNonEmptyString(input.phase)) {
    throw new DacsError("create.phase must be a non-empty trimmed string");
  }
  if (
    input.phase !== undefined &&
    sellerBundlePhaseRank(input.phase) !== null
  ) {
    throw new DacsError(
      "create.phase cannot enter seller bundle finalization without a completed delivery",
    );
  }
  if (
    input.phase !== undefined &&
    (buyerBundlePhaseRank(input.phase) !== null ||
      input.phase === "buyer:finalised")
  ) {
    throw new DacsError(
      "create.phase cannot enter buyer bundle finalization without a fenced session",
    );
  }
  if (
    input.phase !== undefined &&
    terminalBundlePhaseProgress(input.phase) !== null
  ) {
    throw new DacsError(
      "create.phase cannot enter terminal bundle finalization without a fenced session",
    );
  }
  assertOptionalNow(input.now, "create.now");
  return structuredClone(input) as unknown as CreateInput;
}

/** @internal */
export function snapshotFencedJobId(value: unknown, label = "load.jobId"): string {
  assertJobId(value, label);
  return value;
}

/** @internal */
export function snapshotFencedTransitionInput(value: unknown): TransitionInput {
  const input = snapshotExactRecord(
    value,
    "transition",
    [
      "jobId",
      "expectedRevision",
      "leaseToken",
      "phase",
      "checkpoint",
      "receipt",
      "lease",
      "now",
    ],
    ["jobId", "expectedRevision"],
  );
  assertJobId(input.jobId, "transition.jobId");
  if (!isNonNegativeInteger(input.expectedRevision)) {
    throw new DacsError("transition.expectedRevision must be a non-negative safe integer");
  }
  if (input.leaseToken !== undefined) {
    input.leaseToken = snapshotLeaseToken(input.leaseToken, "transition.leaseToken");
  }
  if (input.phase !== undefined && !isNonEmptyString(input.phase)) {
    throw new DacsError("transition.phase must be a non-empty trimmed string");
  }
  if (input.checkpoint !== undefined) {
    input.checkpoint = snapshotCheckpoint(input.checkpoint, "transition.checkpoint");
  }
  if (input.receipt !== undefined) {
    input.receipt = snapshotReceipt(input.receipt, "transition.receipt");
  }
  if (input.lease !== undefined && input.lease !== null) {
    throw new DacsError(
      "transition.lease accepts only null; v1 lease objects cannot cross the v2 boundary",
    );
  }
  assertOptionalNow(input.now, "transition.now");
  return structuredClone(input) as unknown as TransitionInput;
}

/** @internal */
export function snapshotFencedCheckpointClaimInput(
  value: unknown,
): CheckpointClaimInput {
  const input = snapshotExactRecord(
    value,
    "claimCheckpoint",
    ["jobId", "key", "data", "phase", "leaseToken", "now"],
    ["jobId", "key"],
  );
  assertJobId(input.jobId, "claimCheckpoint.jobId");
  if (!isNonEmptyString(input.key)) {
    throw new DacsError("claimCheckpoint.key must be a non-empty trimmed string");
  }
  if (input.phase !== undefined && !isNonEmptyString(input.phase)) {
    throw new DacsError("claimCheckpoint.phase must be a non-empty trimmed string");
  }
  if (input.leaseToken !== undefined) {
    input.leaseToken = snapshotLeaseToken(
      input.leaseToken,
      "claimCheckpoint.leaseToken",
    );
  }
  const checkpoint = snapshotCheckpoint(
    {
      key: input.key,
      stage: "intent",
      ...(input.data === undefined ? {} : { data: input.data }),
    },
    "claimCheckpoint.intent",
  );
  if (input.data !== undefined) input.data = checkpoint.data;
  assertOptionalNow(input.now, "claimCheckpoint.now");
  return structuredClone(input) as unknown as CheckpointClaimInput;
}

/** @internal */
export function snapshotFencedAcquireLeaseInput(value: unknown): AcquireLeaseInput {
  const input = snapshotExactRecord(
    value,
    "acquireLease",
    ["jobId", "owner", "ttlMs", "sellerPhaseIndex", "now"],
    ["jobId", "owner", "ttlMs"],
  );
  assertJobId(input.jobId, "acquireLease.jobId");
  if (!isNonEmptyString(input.owner)) {
    throw new DacsError("acquireLease.owner must be a non-empty trimmed string");
  }
  if (typeof input.ttlMs !== "number" || !Number.isFinite(input.ttlMs) ||
      input.ttlMs <= 0) {
    throw new DacsError("acquireLease.ttlMs must be a positive finite number");
  }
  if (input.sellerPhaseIndex !== undefined &&
      !isNonNegativeInteger(input.sellerPhaseIndex)) {
    throw new DacsError(
      "acquireLease.sellerPhaseIndex must be a non-negative safe integer",
    );
  }
  assertOptionalNow(input.now, "acquireLease.now");
  const leaseEnd = (input.now ?? Date.now()) + input.ttlMs;
  if (!Number.isFinite(leaseEnd) || !Number.isSafeInteger(leaseEnd)) {
    throw new DacsError("acquireLease expiry must be a safe integer timestamp");
  }
  return structuredClone(input) as unknown as AcquireLeaseInput;
}

/** @internal */
export function snapshotFencedRenewLeaseInput(value: unknown): RenewLeaseInput {
  const input = snapshotExactRecord(
    value,
    "renewLease",
    ["jobId", "leaseToken", "ttlMs", "now"],
    ["jobId", "leaseToken", "ttlMs"],
  );
  assertJobId(input.jobId, "renewLease.jobId");
  input.leaseToken = snapshotLeaseToken(input.leaseToken, "renewLease.leaseToken");
  if (typeof input.ttlMs !== "number" || !Number.isFinite(input.ttlMs) ||
      input.ttlMs <= 0) {
    throw new DacsError("renewLease.ttlMs must be a positive finite number");
  }
  assertOptionalNow(input.now, "renewLease.now");
  const leaseEnd = (input.now ?? Date.now()) + input.ttlMs;
  if (!Number.isFinite(leaseEnd) || !Number.isSafeInteger(leaseEnd)) {
    throw new DacsError("renewLease expiry must be a safe integer timestamp");
  }
  return structuredClone(input) as unknown as RenewLeaseInput;
}

/** @internal */
export function snapshotFencedAuthorizationInput(value: unknown): AuthorizationInput {
  const input = snapshotExactRecord(
    value,
    "bindSessionAuthorization",
    ["jobId", "binding", "leaseToken", "now"],
    ["jobId", "binding"],
  );
  assertJobId(input.jobId, "bindSessionAuthorization.jobId");
  input.binding = snapshotBinding(input.binding, "bindSessionAuthorization.binding");
  if (input.leaseToken !== undefined) {
    input.leaseToken = snapshotLeaseToken(
      input.leaseToken,
      "bindSessionAuthorization.leaseToken",
    );
  }
  assertOptionalNow(input.now, "bindSessionAuthorization.now");
  return structuredClone(input) as unknown as AuthorizationInput;
}

/** @internal */
export function snapshotFencedBindHashInput(value: unknown): BindHashInput {
  const input = snapshotExactRecord(
    value,
    "bindHash",
    ["hash", "jobId", "kind"],
    ["hash", "jobId", "kind"],
  );
  if (!isNonEmptyString(input.hash)) {
    throw new DacsError("bindHash.hash must be a non-empty trimmed string");
  }
  assertJobId(input.jobId, "bindHash.jobId");
  if (input.kind !== "agreement" && input.kind !== "transaction") {
    throw new DacsError("bindHash.kind must be agreement or transaction");
  }
  return structuredClone(input) as unknown as BindHashInput;
}

/** @internal */
export function snapshotFencedListFilter(value: unknown): ListFilter | undefined {
  if (value === undefined) return undefined;
  const input = snapshotExactRecord(value, "list", ["phase", "limit"], []);
  if (input.phase !== undefined && !isNonEmptyString(input.phase)) {
    throw new DacsError("list.phase must be a non-empty trimmed string");
  }
  if (input.limit !== undefined && !isNonNegativeInteger(input.limit)) {
    throw new DacsError("list.limit must be a non-negative safe integer");
  }
  return structuredClone(input) as unknown as ListFilter;
}

/** @internal Deterministic across Map insertion and filesystem enumeration order. */
export function compareFencedSessionRecords(
  left: Pick<SessionRecord, "updatedAt" | "createdAt" | "jobId">,
  right: Pick<SessionRecord, "updatedAt" | "createdAt" | "jobId">,
): number {
  return right.updatedAt - left.updatedAt ||
    left.createdAt - right.createdAt ||
    left.jobId.localeCompare(right.jobId);
}

const clone = <T>(value: T): T => structuredClone(value);

/** Monotonic, unscoped recovery lifecycle for seller bundle finalization. */
function sellerBundlePhaseRank(phase: string): number | null {
  switch (phase) {
    case "seller:bundle-signing":
      return 0;
    case "seller:bundle-anchor-pending":
      return 1;
    case "seller:bundle-binding-signing":
      return 2;
    case "seller:bundle-binding-publication-pending":
      return 3;
    default:
      return null;
  }
}

/** Monotonic, unscoped recovery lifecycle for buyer bundle finalization. */
function buyerBundlePhaseRank(phase: string): number | null {
  switch (phase) {
    case "buyer:bundle-review":
      return 0;
    case "buyer:counter-signing":
      return 1;
    case "buyer:counter-signature-publication-pending":
      return 2;
    case "buyer:awaiting-seller-finalisation":
      return 3;
    case "buyer:bundle-anchor-pending":
      return 4;
    case "buyer:bundle-binding-signing":
      return 5;
    case "buyer:bundle-binding-publication-pending":
      return 6;
    default:
      return null;
  }
}

interface SellerDeliveryPhaseProgress {
  index: number;
  rank: number;
  terminal: boolean;
  outcome?: "completed" | "failed" | "rejected";
}

const SELLER_DELIVERY_PHASE_RE =
  /^seller:(delivery-(pending|recovery|completed|failed|rejected)|evidence-(pending|recovery)|validation-pending):(0|[1-9][0-9]*)$/;

function sellerDeliveryPhaseProgress(
  phase: string,
): SellerDeliveryPhaseProgress | null {
  const match = SELLER_DELIVERY_PHASE_RE.exec(phase);
  if (!match) return null;
  const index = Number(match[4]);
  if (!Number.isSafeInteger(index)) return null;
  const rank = match[1] === "validation-pending"
    ? 0
    : match[1] === "delivery-pending"
      ? 1
      : match[1] === "delivery-recovery"
        ? 2
        : match[1] === "evidence-pending"
          ? 3
          : match[1] === "evidence-recovery"
            ? 4
            : 5;
  return {
    index,
    rank,
    terminal:
      match[1] === "delivery-completed" ||
      match[1] === "delivery-failed" ||
      match[1] === "delivery-rejected",
    ...(match[1] === "delivery-completed"
      ? { outcome: "completed" as const }
      : match[1] === "delivery-failed"
        ? { outcome: "failed" as const }
        : match[1] === "delivery-rejected"
          ? { outcome: "rejected" as const }
          : {}),
  };
}

/** Seller terminal outcomes that remain open only for exact terminal FAB publication. */
export function sessionPhaseIsSellerFailureOrigin(phase: string): boolean {
  const progress = sellerDeliveryPhaseProgress(phase);
  return phase === "seller:failed" ||
    (progress?.terminal === true && progress.outcome !== "completed");
}

export function sessionPhaseMutationFailure(
  record: SessionRecord,
  nextPhase: string | undefined,
): "phase-regression" | null {
  if (nextPhase?.startsWith("seller:") &&
      nextPhase !== "seller:failed" &&
      !sessionPhaseIsTerminal(nextPhase) &&
      sellerDeliveryPhaseProgress(nextPhase) === null &&
      sellerBundlePhaseRank(nextPhase) === null) {
    return "phase-regression";
  }
  if (nextPhase?.startsWith("buyer:") &&
      !sessionPhaseIsTerminal(nextPhase) &&
      buyerBundlePhaseRank(nextPhase) === null) {
    return "phase-regression";
  }
  if (nextPhase?.startsWith("terminal:") && terminalBundlePhaseProgress(nextPhase) === null) {
    return "phase-regression";
  }
  const currentBundleRank = sellerBundlePhaseRank(record.phase);
  const nextBundleRank = nextPhase === undefined
    ? null
    : sellerBundlePhaseRank(nextPhase);
  const currentBuyerRank = buyerBundlePhaseRank(record.phase);
  const nextBuyerRank = nextPhase === undefined
    ? null
    : buyerBundlePhaseRank(nextPhase);
  const current = sellerDeliveryPhaseProgress(record.phase);
  const scope = record.lease?.sellerPhaseIndex;
  const currentTerminalBundle = terminalBundlePhaseProgress(record.phase);
  const nextTerminalBundle = nextPhase === undefined
    ? null
    : terminalBundlePhaseProgress(nextPhase);

  if (record.phase === "buyer:finalised") return "phase-regression";

  // Failure/abort FAB publication is role-local, unscoped, and forward-only.
  // The globally sealed state is reachable only from the last publication
  // phase, so a semantic `seller:failed` state can never strand an unanchored
  // failure bundle.
  if (currentTerminalBundle !== null) {
    if (scope !== undefined || currentTerminalBundle.final) return "phase-regression";
    if (nextPhase === undefined) return null;
    if (!nextTerminalBundle || nextTerminalBundle.role !== currentTerminalBundle.role) {
      return "phase-regression";
    }
    if (nextTerminalBundle.final) {
      return currentTerminalBundle.stage === "bundle-binding-publication-pending"
        ? null
        : "phase-regression";
    }
    return nextTerminalBundle.rank >= currentTerminalBundle.rank
      ? null
      : "phase-regression";
  }

  if (nextTerminalBundle?.final) return "phase-regression";
  if (nextTerminalBundle !== null) {
    const ordinaryOrigin =
      currentBundleRank === null &&
      currentBuyerRank === null &&
      current === null &&
      !record.phase.startsWith("seller:") &&
      !record.phase.startsWith("buyer:");
    const failedSellerOrigin = sessionPhaseIsSellerFailureOrigin(record.phase);
    const validOrigin = ordinaryOrigin ||
      (failedSellerOrigin && nextTerminalBundle.role === "seller");
    return nextTerminalBundle.rank === 0 &&
      record.lease !== undefined &&
      scope === undefined &&
      validOrigin
      ? null
      : "phase-regression";
  }

  if (sessionPhaseIsSellerFailureOrigin(record.phase)) {
    return "phase-regression";
  }

  // Buyer bundle work is an independent-agent lifecycle. Every irreversible
  // step is unscoped, forward-only, and sealed by buyer:finalised.
  if (currentBuyerRank !== null) {
    if (scope !== undefined) return "phase-regression";
    if (nextPhase === undefined) return null;
    if (nextPhase === "buyer:finalised") return null;
    return nextBuyerRank !== null && nextBuyerRank >= currentBuyerRank
      ? null
      : "phase-regression";
  }

  if (nextPhase === "buyer:finalised") return "phase-regression";

  if (nextBuyerRank !== null) {
    return currentBundleRank === null && current === null &&
      scope === undefined && nextBuyerRank === 0 && record.lease !== undefined
      ? null
      : "phase-regression";
  }

  if (nextPhase === "seller:finalised") {
    // Preserve the v2 store's pre-existing global-finalisation transition for
    // non-bundle consumers. The durable bundle coordinator independently
    // requires and atomically writes its exact result checkpoint + receipt.
    return scope === undefined ? null : "phase-regression";
  }

  // Once bundle finalization starts it seals seller delivery progression. WAL
  // outcomes may preserve the current phase, while explicit phase changes are
  // forward-only within the bundle lifecycle.
  if (currentBundleRank !== null) {
    if (scope !== undefined) return "phase-regression";
    if (nextPhase === undefined) return null;
    return nextBundleRank !== null && nextBundleRank >= currentBundleRank
      ? null
      : "phase-regression";
  }

  // The first bundle state is reachable only from a successful completed
  // delivery while holding a live general (unscoped) lease.
  if (nextBundleRank !== null) {
    return current?.terminal === true &&
      current.outcome === "completed" &&
      nextBundleRank === 0 &&
      record.lease !== undefined &&
      scope === undefined
      ? null
      : "phase-regression";
  }

  const next = nextPhase === undefined
    ? null
    : sellerDeliveryPhaseProgress(nextPhase);

  if (scope !== undefined && nextPhase !== undefined && next?.index !== scope) {
    return "phase-regression";
  }
  if (!current) return null;
  if (!current.terminal) {
    if (nextPhase === undefined) return null;
    return next?.index === current.index && next.rank >= current.rank
      ? null
      : "phase-regression";
  }
  // A completed invocation remains immutable. The only delivery transition is
  // a lease explicitly scoped to a strictly later pipeline index.
  if (
    current.outcome !== "completed" ||
    scope === undefined ||
    scope <= current.index ||
    next === null ||
    next.index !== scope
  ) {
    return "phase-regression";
  }
  return null;
}

/** @internal Exact atomic seal required by the generic terminal FAB lifecycle. */
export function terminalBundleSealMutationFailure(
  record: SessionRecord,
  input: Pick<TransitionInput, "phase" | "checkpoint" | "receipt" | "lease">,
): "phase-regression" | null {
  const next = input.phase === undefined ? null : terminalBundlePhaseProgress(input.phase);
  if (next?.final !== true) return null;
  const current = terminalBundlePhaseProgress(record.phase);
  const resultKey = `terminal:${next.role}:result`;
  const prior = [...record.checkpoints]
    .reverse()
    .find((checkpoint) => checkpoint.key === resultKey);
  return current?.role === next.role &&
      current.stage === "bundle-binding-publication-pending" &&
      input.checkpoint?.key === resultKey &&
      input.checkpoint.stage === "outcome" &&
      prior?.stage === "intent" &&
      input.receipt?.kind === "bundle" &&
      input.receipt.phaseIndex === undefined &&
      input.lease === null
    ? null
    : "phase-regression";
}

export function sessionLeaseScopeFailure(
  record: SessionRecord,
  sellerPhaseIndex: number | undefined,
): "phase-regression" | null {
  if (sessionPhaseIsSellerFailureOrigin(record.phase)) {
    return sellerPhaseIndex === undefined ? null : "phase-regression";
  }
  if (terminalBundlePhaseProgress(record.phase) !== null) {
    return sellerPhaseIndex === undefined ? null : "phase-regression";
  }
  if (buyerBundlePhaseRank(record.phase) !== null) {
    return sellerPhaseIndex === undefined ? null : "phase-regression";
  }
  if (sellerBundlePhaseRank(record.phase) !== null) {
    return sellerPhaseIndex === undefined ? null : "phase-regression";
  }
  const current = sellerDeliveryPhaseProgress(record.phase);
  if (!current) return null;
  if (current.terminal) {
    if (sellerPhaseIndex === undefined) return null;
    return current.outcome === "completed" && sellerPhaseIndex > current.index
      ? null
      : "phase-regression";
  }
  if (sellerPhaseIndex === undefined) return "phase-regression";
  return sellerPhaseIndex === current.index ? null : "phase-regression";
}

export function sessionAuthorizationPhaseFailure(
  record: SessionRecord,
): "phase-regression" | null {
  if (sessionPhaseIsSellerFailureOrigin(record.phase)) {
    return "phase-regression";
  }
  if (terminalBundlePhaseProgress(record.phase) !== null) {
    return "phase-regression";
  }
  if (buyerBundlePhaseRank(record.phase) !== null) {
    return "phase-regression";
  }
  if (sellerBundlePhaseRank(record.phase) !== null) {
    return "phase-regression";
  }
  if (!sellerDeliveryPhaseProgress(record.phase)) return null;
  const scope = record.lease?.sellerPhaseIndex;
  return scope === undefined
    ? "phase-regression"
    : sessionLeaseScopeFailure(record, scope);
}

function leaseFailure(
  record: SessionRecord,
  token: SessionLeaseToken | undefined,
  now: number,
): "lease-fenced" | "lease-expired" | null {
  if (!record.lease) {
    // Once a record has ever entered fenced processing, releasing the lease must
    // not reopen an unguarded legacy mutation path. A new acquisition is the only
    // way to obtain authority for the next recovery attempt.
    return record.leaseGeneration > 0 || token ? "lease-fenced" : null;
  }
  if (
    !token ||
    token.owner !== record.lease.owner ||
    token.generation !== record.lease.generation
  ) {
    return "lease-fenced";
  }
  return record.lease.expiresAt > now ? null : "lease-expired";
}

function samePaymentBinding(
  left: SessionPaymentAuthorizationBinding,
  right: SessionPaymentAuthorizationBinding,
): boolean {
  return (
    left.authorizationHash === right.authorizationHash &&
    left.fulfilmentId === right.fulfilmentId &&
    left.handoffBindingHash === right.handoffBindingHash &&
    left.agreementHash === right.agreementHash &&
    left.paymentEvidenceHash === right.paymentEvidenceHash &&
    left.settlementId === right.settlementId &&
    left.paymentPhaseIndex === right.paymentPhaseIndex &&
    left.deliveryPhaseIndex === right.deliveryPhaseIndex
  );
}

function validateCheckpointAppend(
  record: SessionRecord,
  checkpoint: SessionCheckpoint,
): boolean {
  const prior = [...record.checkpoints]
    .reverse()
    .find((item) => item.key === checkpoint.key);
  return checkpoint.stage === "intent"
    ? prior === undefined
    : prior?.stage === "intent";
}

/** In-memory conformance/reference implementation of the v2 store. */
export function createInMemoryFencedSessionStore(): FencedSessionStoreV2 {
  const sessions = new Map<string, SessionRecord>();
  const hashBindings = new Map<string, { jobId: string; kind: string }>();
  const settlementBindings = new Map<
    string,
    { jobId: string; binding: SessionPaymentAuthorizationBinding }
  >();

  const validTtl = (ttlMs: number): void => {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new DacsError(`lease ttlMs must be a positive number, got ${ttlMs}`);
    }
  };

  return {
    apiVersion: FENCED_SESSION_STORE_VERSION,
    async create(rawInput) {
      const input = snapshotFencedCreateInput(rawInput);
      const jobId = input.jobId;
      const agreementHash = input.agreementHash;
      const phase = input.phase ?? "created";
      const now = input.now ?? Date.now();
      if (sessions.has(jobId)) throw new DacsError(`session ${jobId} already exists`);
      if (agreementHash) {
        const existing = hashBindings.get(agreementHash);
        if (existing && (existing.jobId !== jobId || existing.kind !== "agreement")) {
          throw new DacsError(
            `agreement hash is already bound to session ${existing.jobId} (anti-replay); cannot create ${jobId}`,
          );
        }
      }
      const record: SessionRecord = {
        storeVersion: FENCED_SESSION_STORE_VERSION,
        jobId,
        ...(agreementHash === undefined ? {} : { agreementHash }),
        phase,
        revision: 0,
        leaseGeneration: 0,
        paymentAuthorizations: [],
        checkpoints: [],
        receipts: [],
        createdAt: now,
        updatedAt: now,
      };
      const violation = sessionRecordShapeViolation(record);
      if (violation) throw new DacsError(`invalid session record: ${violation}`);
      sessions.set(jobId, record);
      if (agreementHash) hashBindings.set(agreementHash, { jobId, kind: "agreement" });
      return clone(record);
    },

    async load(rawJobId) {
      const jobId = snapshotFencedJobId(rawJobId);
      const record = sessions.get(jobId);
      return record
        ? { status: "ok", record: clone(record) }
        : { status: "missing" };
    },

    async transition(rawInput) {
      const input = snapshotFencedTransitionInput(rawInput);
      const current = sessions.get(input.jobId);
      if (!current) return { ok: false, reason: "not-found" };
      if (current.revision !== input.expectedRevision) {
        return { ok: false, reason: "revision-mismatch", record: clone(current) };
      }
      if (sessionPhaseIsTerminal(current.phase)) {
        return { ok: false, reason: "terminal-state", record: clone(current) };
      }
      const now = input.now ?? Date.now();
      const leaseProblem = leaseFailure(current, input.leaseToken, now);
      if (leaseProblem) {
        return { ok: false, reason: leaseProblem, record: clone(current) };
      }
      const releasesOnly =
        input.lease === null &&
        input.phase === undefined &&
        input.checkpoint === undefined &&
        input.receipt === undefined;
      const phaseProblem = releasesOnly
        ? null
        : sessionPhaseMutationFailure(current, input.phase);
      if (phaseProblem) {
        return { ok: false, reason: phaseProblem, record: clone(current) };
      }
      if (
        sessionPhaseIsSellerFailureOrigin(current.phase) &&
        !releasesOnly &&
        (input.phase !== terminalBundleStorePhase("seller", "authority") ||
          input.receipt !== undefined ||
          input.checkpoint?.key !== "terminal:seller:authority" ||
          input.checkpoint.stage !== "intent" ||
          input.lease === null)
      ) {
        return { ok: false, reason: "phase-regression", record: clone(current) };
      }
      const sealProblem = terminalBundleSealMutationFailure(current, input);
      if (sealProblem) {
        return { ok: false, reason: sealProblem, record: clone(current) };
      }
      if (input.checkpoint) {
        assertCheckpointPayloadShape(input.checkpoint);
        if (!validateCheckpointAppend(current, input.checkpoint)) {
          return { ok: false, reason: "checkpoint-state", record: clone(current) };
        }
      }
      if (input.receipt) {
        assertSessionReceiptShape(input.receipt);
        const key = sessionReceiptKey(input.receipt);
        const prior = current.receipts.find((item) => sessionReceiptKey(item) === key);
        if (prior && prior.ref !== input.receipt.ref) {
          return { ok: false, reason: "immutable-receipt", record: clone(current) };
        }
      }
      const next = clone(current);
      next.revision += 1;
      next.updatedAt = now;
      if (input.phase !== undefined) next.phase = input.phase;
      if (input.checkpoint) next.checkpoints.push(clone(input.checkpoint));
      if (input.receipt) {
        const key = sessionReceiptKey(input.receipt);
        if (!next.receipts.some((item) => sessionReceiptKey(item) === key)) {
          next.receipts.push({ recordedAt: now, ...clone(input.receipt) });
        }
      }
      if (input.lease === null) delete next.lease;
      const violation = sessionRecordShapeViolation(next);
      if (violation) throw new DacsError(`invalid session transition: ${violation}`);
      sessions.set(input.jobId, next);
      return { ok: true, record: clone(next) };
    },

    async claimCheckpoint(rawInput) {
      const input = snapshotFencedCheckpointClaimInput(rawInput);
      const current = sessions.get(input.jobId);
      if (!current) return { ok: false, reason: "not-found" };
      if (sessionPhaseIsTerminal(current.phase)) {
        return { ok: false, reason: "terminal-state", record: clone(current) };
      }
      const now = input.now ?? Date.now();
      const leaseProblem = leaseFailure(current, input.leaseToken, now);
      if (leaseProblem) {
        return { ok: false, reason: leaseProblem, record: clone(current) };
      }
      const prior = [...current.checkpoints]
        .reverse()
        .find((item) => item.key === input.key);
      if (prior) {
        return {
          ok: false,
          reason: prior.stage === "outcome" ? "completed" : "held",
          record: clone(current),
        };
      }
      const phaseProblem = sessionPhaseMutationFailure(current, input.phase);
      if (phaseProblem) {
        return { ok: false, reason: phaseProblem, record: clone(current) };
      }
      if (
        sessionPhaseIsSellerFailureOrigin(current.phase) &&
        (input.phase !== terminalBundleStorePhase("seller", "authority") ||
          input.key !== "terminal:seller:authority")
      ) {
        return { ok: false, reason: "phase-regression", record: clone(current) };
      }
      if (terminalBundlePhaseProgress(input.phase ?? "")?.final === true) {
        return { ok: false, reason: "phase-regression", record: clone(current) };
      }
      const checkpoint: SessionCheckpoint = {
        key: input.key,
        stage: "intent",
        ...(input.data ? { data: clone(input.data) } : {}),
      };
      assertCheckpointPayloadShape(checkpoint);
      const next = clone(current);
      next.revision += 1;
      next.updatedAt = now;
      if (input.phase !== undefined) next.phase = input.phase;
      next.checkpoints.push(checkpoint);
      const violation = sessionRecordShapeViolation(next);
      if (violation) throw new DacsError(`invalid checkpoint claim: ${violation}`);
      sessions.set(input.jobId, next);
      return { ok: true, record: clone(next) };
    },

    async acquireLease(rawInput) {
      const input = snapshotFencedAcquireLeaseInput(rawInput);
      const jobId = input.jobId;
      const owner = input.owner;
      const ttlMs = input.ttlMs;
      const sellerPhaseIndex = input.sellerPhaseIndex;
      const now = input.now ?? Date.now();
      validTtl(ttlMs);
      if (!isNonEmptyString(owner)) throw new DacsError("lease owner must be non-empty");
      if (sellerPhaseIndex !== undefined && !isNonNegativeInteger(sellerPhaseIndex)) {
        throw new DacsError("sellerPhaseIndex must be a non-negative safe integer");
      }
      const current = sessions.get(jobId);
      if (!current) return { ok: false, reason: "not-found" };
      if (sessionPhaseIsTerminal(current.phase)) {
        return { ok: false, reason: "terminal-state", record: clone(current) };
      }
      if (current.lease && current.lease.expiresAt > now) {
        return { ok: false, reason: "lease-held", record: clone(current) };
      }
      const scopeProblem = sessionLeaseScopeFailure(current, sellerPhaseIndex);
      if (scopeProblem) {
        return { ok: false, reason: scopeProblem, record: clone(current) };
      }
      const next = clone(current);
      next.revision += 1;
      next.updatedAt = now;
      next.leaseGeneration += 1;
      next.lease = {
        owner,
        generation: next.leaseGeneration,
        expiresAt: now + ttlMs,
        ...(sellerPhaseIndex === undefined ? {} : { sellerPhaseIndex }),
      };
      const violation = sessionRecordShapeViolation(next);
      if (violation) throw new DacsError(`invalid lease: ${violation}`);
      sessions.set(jobId, next);
      return { ok: true, record: clone(next), lease: clone(next.lease) };
    },

    async renewLease(rawInput) {
      const input = snapshotFencedRenewLeaseInput(rawInput);
      const jobId = input.jobId;
      const leaseToken = input.leaseToken;
      const ttlMs = input.ttlMs;
      const now = input.now ?? Date.now();
      validTtl(ttlMs);
      const current = sessions.get(jobId);
      if (!current) return { ok: false, reason: "not-found" };
      if (sessionPhaseIsTerminal(current.phase)) {
        return { ok: false, reason: "terminal-state", record: clone(current) };
      }
      const problem = leaseFailure(current, leaseToken, now);
      if (problem) return { ok: false, reason: problem, record: clone(current) };
      const next = clone(current);
      next.revision += 1;
      next.updatedAt = now;
      next.lease!.expiresAt = now + ttlMs;
      const violation = sessionRecordShapeViolation(next);
      if (violation) throw new DacsError(`invalid renewed lease: ${violation}`);
      sessions.set(jobId, next);
      return { ok: true, record: clone(next), lease: clone(next.lease!) };
    },

    async bindSessionAuthorization(rawInput) {
      const input = snapshotFencedAuthorizationInput(rawInput);
      const jobId = input.jobId;
      const binding = input.binding;
      const leaseToken = input.leaseToken;
      const now = input.now ?? Date.now();
      assertSessionPaymentAuthorizationShape(binding);
      const current = sessions.get(jobId);
      if (!current) return { ok: false, reason: "not-found" };
      if (current.agreementHash !== undefined && current.agreementHash !== binding.agreementHash) {
        return { ok: false, reason: "agreement-conflict", record: clone(current) };
      }
      const phaseBinding = current.paymentAuthorizations.find(
        (item) => item.paymentPhaseIndex === binding.paymentPhaseIndex ||
          item.deliveryPhaseIndex === binding.deliveryPhaseIndex,
      );
      if (phaseBinding && samePaymentBinding(phaseBinding, binding)) {
        const agreementOwner = hashBindings.get(binding.agreementHash);
        if (
          agreementOwner &&
          (agreementOwner.jobId !== jobId || agreementOwner.kind !== "agreement")
        ) {
          return {
            ok: false,
            reason: "agreement-conflict",
            boundTo: agreementOwner.jobId,
            record: clone(current),
          };
        }
        const settlementOwner = settlementBindings.get(binding.settlementId);
        if (
          settlementOwner &&
          (settlementOwner.jobId !== jobId ||
            !samePaymentBinding(settlementOwner.binding, binding))
        ) {
          return {
            ok: false,
            reason: "settlement-replay",
            boundTo: settlementOwner.jobId,
            record: clone(current),
          };
        }
        hashBindings.set(binding.agreementHash, { jobId, kind: "agreement" });
        settlementBindings.set(binding.settlementId, {
          jobId,
          binding: clone(binding),
        });
        return { ok: true, record: clone(current) };
      }
      if (sessionPhaseIsTerminal(current.phase)) {
        return { ok: false, reason: "terminal-state", record: clone(current) };
      }
      if (!current.lease) {
        return { ok: false, reason: "lease-fenced", record: clone(current) };
      }
      const leaseProblem = leaseFailure(current, leaseToken, now);
      if (leaseProblem) {
        return { ok: false, reason: leaseProblem, record: clone(current) };
      }
      const phaseProblem = sessionAuthorizationPhaseFailure(current);
      if (phaseProblem) {
        return { ok: false, reason: phaseProblem, record: clone(current) };
      }
      if (phaseBinding !== undefined && !samePaymentBinding(phaseBinding, binding)) {
        return { ok: false, reason: "payment-conflict", record: clone(current) };
      }
      const agreementOwner = hashBindings.get(binding.agreementHash);
      if (
        agreementOwner &&
        (agreementOwner.jobId !== jobId || agreementOwner.kind !== "agreement")
      ) {
        return {
          ok: false,
          reason: "agreement-conflict",
          boundTo: agreementOwner.jobId,
          record: clone(current),
        };
      }
      // Agreement identity is the session's first irreversible authority. Commit
      // it before the global settlement marker so a payment conflict or restart
      // cannot let the same job be relabelled under another agreement.
      let agreementBound = current;
      if (current.agreementHash === undefined) {
        const next = clone(current);
        next.agreementHash = binding.agreementHash;
        next.revision += 1;
        next.updatedAt = now;
        const violation = sessionRecordShapeViolation(next);
        if (violation) {
          throw new DacsError(`invalid set-once agreement binding: ${violation}`);
        }
        hashBindings.set(binding.agreementHash, {
          jobId,
          kind: "agreement",
        });
        sessions.set(jobId, next);
        agreementBound = next;
      } else if (!agreementOwner) {
        // Repair an impossible-in-memory marker gap in the same fail-closed way
        // as the persistent implementation repairs a crash residue.
        hashBindings.set(binding.agreementHash, {
          jobId,
          kind: "agreement",
        });
      }
      const settlementOwner = settlementBindings.get(binding.settlementId);
      if (
        settlementOwner &&
        (settlementOwner.jobId !== jobId ||
          !samePaymentBinding(settlementOwner.binding, binding))
      ) {
        return {
          ok: false,
          reason: "settlement-replay",
          boundTo: settlementOwner.jobId,
          record: clone(agreementBound),
        };
      }
      const next = clone(agreementBound);
      next.paymentAuthorizations.push(clone(binding));
      next.revision += 1;
      next.updatedAt = now;
      const violation = sessionRecordShapeViolation(next);
      if (violation) throw new DacsError(`invalid session authorization: ${violation}`);
      settlementBindings.set(binding.settlementId, {
        jobId,
        binding: clone(binding),
      });
      sessions.set(jobId, next);
      return { ok: true, record: clone(next) };
    },

    async bindHash(rawInput) {
      const { hash, jobId, kind } = snapshotFencedBindHashInput(rawInput);
      const current = sessions.get(jobId);
      if (
        kind === "agreement" &&
        current &&
        (sessionPhaseIsSellerFailureOrigin(current.phase) ||
          sessionPhaseIsTerminal(current.phase))
      ) {
        return current.agreementHash === hash
          ? { ok: true, boundTo: jobId }
          : { ok: false, boundTo: jobId };
      }
      if (kind === "agreement" && current?.agreementHash && current.agreementHash !== hash) {
        return { ok: false, boundTo: jobId };
      }
      if (
        kind === "agreement" &&
        current &&
        current.agreementHash === undefined &&
        current.leaseGeneration > 0
      ) {
        return { ok: false, boundTo: jobId };
      }
      const existing = hashBindings.get(hash);
      if (existing) {
        if (existing.jobId !== jobId || existing.kind !== kind) {
          return { ok: false, boundTo: existing.jobId };
        }
      } else {
        if (current && current.leaseGeneration > 0) {
          return { ok: false, boundTo: jobId };
        }
        hashBindings.set(hash, { jobId, kind });
      }
      if (kind === "agreement" && current && current.agreementHash === undefined) {
        const next = clone(current);
        next.agreementHash = hash;
        next.revision += 1;
        next.updatedAt = Date.now();
        sessions.set(jobId, next);
      }
      return { ok: true, boundTo: jobId };
    },

    async list(rawFilter) {
      const filter = snapshotFencedListFilter(rawFilter);
      let records = [...sessions.values()];
      if (filter?.phase !== undefined) {
        records = records.filter((record) => record.phase === filter.phase);
      }
      records.sort(compareFencedSessionRecords);
      if (filter?.limit !== undefined) records = records.slice(0, filter.limit);
      return records.map(clone);
    },
  };
}

import { hash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { canonicalize, sha256Hex } from "../canonical/index.js";
import {
  snapshotCanonicalJson,
  snapshotCanonicalJsonRead,
} from "../canonical/snapshot.js";
import { DacsError } from "../errors.js";

// Captured once at module load, so reading the authority, deriving its
// settlement key and intent, binding methods and reading store and adapter
// results do not dispatch through a prototype or static polluted or replaced
// later. This makes accidental interference unlikely; code that replaces
// built-ins in the process is outside the rail's threat model (see the docs).
// `RegExp.prototype.test` looks `exec` up on every call, so `exec` is captured.
const reflectApply = Reflect.apply;
const getOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
const getPrototypeOf = Reflect.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const hasOwn = Object.hasOwn;
const freeze = Object.freeze;
const isArray = Array.isArray;
const isSafeInteger = Number.isSafeInteger;
const isProxy = nodeTypes.isProxy;
const regExpExec = RegExp.prototype.exec;
const stringNormalize = String.prototype.normalize;
const stringCharCodeAt = String.prototype.charCodeAt;
const stringSlice = String.prototype.slice;
// One-shot: no `Hash` object whose symbol-keyed handle slot a prototype
// accessor could intercept.
const oneShotHash = hash;

const HASH_RE = /^[0-9a-f]{64}$/;
const BRIDGE_ID_RE = /^[A-Za-z0-9_-]{16}$/;
/** CORE §B.1 canonical job ID, as in `negotiate/jobId.ts`. */
const CANONICAL_JOB_ID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
/** CD-1 plain decimal (§14.4): integer and fraction digits, at most one dot. */
const DECIMAL_PARTS_RE = /^([0-9]*)(?:\.([0-9]*))?$/;
const LEADING_ZEROS_RE = /^0*([0-9]*)$/;
const TRAILING_ZEROS_RE = /^([0-9]*?)0*$/;
const USDC_DECIMALS = 6;
const ZERO_PADDING = Object.freeze(["", "0", "00", "000", "0000", "00000", "000000"]);
const SETTLEMENT_KEY_FIELDS = Object.freeze(["jobId", "railId", "phaseIndex"]);
const AUTHORITY_FIELDS = Object.freeze(Object.keys({
  jobId: true,
  phaseIndex: true,
  railId: true,
  railDescriptorHash: true,
  agreementHash: true,
  sr5BindingHash: true,
  assetKind: true,
  networkKind: true,
  mechanism: true,
  sourceChainId: true,
  destinationChainId: true,
  sourceChainType: true,
  destinationChainType: true,
  sourceAsset: true,
  destinationAsset: true,
  sourceTokenDecimals: true,
  destinationTokenDecimals: true,
  amount: true,
  currency: true,
  originAddress: true,
  destinationAddress: true,
  sourceLiquidityTankId: true,
  destinationLiquidityTankId: true,
  supportedScope: true,
} satisfies Record<keyof LiquidityTankAuthority, true>));
const DEFAULT_LEASE_MS = 30_000;
/**
 * How far a submission's `preparedAt` may sit from this host's clock readings
 * around preparation and from the receipt stored with it: room for the
 * adapter's clock skew, while a seconds-scale value is decades outside it.
 */
const PREPARATION_CLOCK_SKEW_MS = 60_000;
const ETH_SEPOLIA_CHAIN_ID = 11_155_111;
const POLYGON_AMOY_CHAIN_ID = 80_002;

export interface LiquidityTankAuthority {
  jobId: string;
  phaseIndex: number;
  railId: string;
  railDescriptorHash: string;
  agreementHash: string;
  sr5BindingHash: string;
  assetKind: "stablecoin-cross-chain";
  networkKind: "cross-chain";
  mechanism: "liquidity-tank";
  sourceChainId: number;
  destinationChainId: number;
  sourceChainType: "EVM";
  destinationChainType: "EVM";
  sourceAsset: "USDC";
  destinationAsset: "USDC";
  sourceTokenDecimals: number;
  destinationTokenDecimals: number;
  amount: string;
  currency: "USDC";
  originAddress: string;
  destinationAddress: string;
  sourceLiquidityTankId: string;
  destinationLiquidityTankId: string;
  supportedScope: "dacs-v0.1-eth-sepolia-polygon-amoy-usdc";
}

export interface LiquidityTankIntent {
  intentVersion: "1";
  settlementKey: string;
  bindingHash: string;
  operationHash: string;
  jobId: string;
  phaseIndex: number;
  railId: string;
  railDescriptorHash: string;
  agreementHash: string;
  sr5BindingHash: string;
  assetKind: "stablecoin-cross-chain";
  networkKind: "cross-chain";
  mechanism: "liquidity-tank";
  sourceChainId: number;
  destinationChainId: number;
  sourceChainType: "EVM";
  destinationChainType: "EVM";
  sourceAsset: "USDC";
  destinationAsset: "USDC";
  sourceTokenDecimals: number;
  destinationTokenDecimals: number;
  sourceAmountBaseUnits: string;
  destinationAmountBaseUnits: string;
  amount: string;
  currency: "USDC";
  originAddress: string;
  destinationAddress: string;
  sourceLiquidityTankId: string;
  destinationLiquidityTankId: string;
  supportedScope: "dacs-v0.1-eth-sepolia-polygon-amoy-usdc";
}

export interface LiquidityTankPreparedSubmission {
  submissionVersion: "1";
  authorityHash: string;
  operationHash: string;
  bridgeId: string;
  substrateTxHash: string;
  signedSubmissionBase64: string;
  preparedAt: number;
  submissionHash: string;
}

interface LiquidityTankObservationBase {
  bridgeId: string;
  operationHash: string;
  observedAt: number;
  authenticationHash: string;
}

export type LiquidityTankObservation =
  | (LiquidityTankObservationBase & {
      status: "empty";
      history: readonly ["empty"];
    })
  | (LiquidityTankObservationBase & {
      status: "pending";
      history: readonly ["empty", "pending"];
      lockTxHash?: string;
      /** Unix milliseconds; required exactly when a source lock is committed. */
      recoveryDeadline?: number;
    })
  | (LiquidityTankObservationBase & {
      status: "completed";
      history: readonly ["empty", "pending", "completed"];
      lockTxHash: string;
      releaseTxHash: string;
      /** Authenticated Unix-millisecond deadline carried from the source lock. */
      recoveryDeadline: number;
      finalityObservedAt: number;
    })
  | (LiquidityTankObservationBase & {
      status: "failed";
      history: readonly ["empty", "failed"] | readonly ["empty", "pending", "failed"];
      reason: string;
      /** Exact authenticated source checkpoint, required for recovery after a durable lock. */
      lockTxHash?: string;
      recoveryDeadline?: number;
    })
  | (LiquidityTankObservationBase & {
      status: "capacity-unavailable";
      history: readonly ["empty"];
      reason: string;
    })
  | {
      status: "indeterminate";
      reason: string;
    };

export interface LiquidityTankEffectFence {
  settlementKey: string;
  bindingHash: string;
  owner: string;
  generation: number;
  assertCurrent(): Promise<void>;
}

/**
 * Native-bridge boundary. `prepareSubmission` must produce the complete signed
 * Demos transaction without broadcasting it; exact bytes are durable first.
 * It must not broadcast, log or otherwise reveal the signed bytes before
 * `recordSubmission` commits them: if the worker stops in between, the next
 * owner signs a fresh submission and the first bytes must never reach the
 * bridge. The core cannot enforce or detect this, so it is part of reviewing
 * any adapter. `preparedAt` is Unix milliseconds from a clock within one
 * minute of the host's; the core refuses a fresh submission stamped outside
 * that window. The core sets no timeout: every method must settle within its
 * own bounded deadline.
 */
export interface LiquidityTankAdapter {
  prepareSubmission(
    intent: Readonly<LiquidityTankIntent>,
    fence: Readonly<LiquidityTankEffectFence>,
  ): Promise<Readonly<Omit<LiquidityTankPreparedSubmission, "submissionHash">>>;
  broadcastRetained(
    submission: Readonly<LiquidityTankPreparedSubmission>,
    fence: Readonly<LiquidityTankEffectFence>,
  ): Promise<void>;
  observe(
    intent: Readonly<LiquidityTankIntent>,
    submission: Readonly<LiquidityTankPreparedSubmission>,
    fence: Readonly<LiquidityTankEffectFence>,
  ): Promise<Readonly<LiquidityTankObservation>>;
}

/**
 * Host checks the core cannot make itself. Both are required: when one is
 * missing the core refuses before any claim, and when one answers anything
 * but literal `true` (or throws) the core does not use the value it checked.
 * The core sets no timeout, so each must settle within its own bounded
 * deadline; a hook that never settles hangs the call. A retained `settled`
 * row is returned as the store wrote it, without either check.
 */
export interface LiquidityTankVerifier {
  /**
   * Authenticates one bridge observation, whether the adapter just returned it
   * or the store retained it: status, history, bridge ID, operation hash, lock
   * and release hashes, timestamps and `recoveryDeadline`, against the bridge's
   * own authenticated record (for example a pinned bridge key or attestation).
   */
  authenticateObservation(input: Readonly<{
    intent: Readonly<LiquidityTankIntent>;
    submission: Readonly<LiquidityTankPreparedSubmission>;
    observation: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>>;
  }>): Promise<boolean> | boolean;
  /**
   * Decodes `signedSubmissionBase64` and confirms it signs exactly this
   * intent: source amount in base units, origin and destination addresses,
   * asset, tank pair and the submission's `bridgeId`, and that
   * `substrateTxHash` is recomputed from those bytes. Called before a prepared
   * submission is stored and before a retained one is used.
   */
  verifySignedSubmission(input: Readonly<{
    intent: Readonly<LiquidityTankIntent>;
    submission: Readonly<LiquidityTankPreparedSubmission>;
  }>): Promise<boolean> | boolean;
}

export interface LiquidityTankLease {
  owner: string;
  generation: number;
  expiresAt: number;
}

export interface LiquidityTankSettlement {
  txRef: Readonly<{
    kind: "liquidity-tank";
    bridgeId: string;
    sourceChainId: number;
    destChainId: number;
    lockTxHash: string;
    releaseTxHash: string;
    recoveryDeadline: number;
  }>;
  paymentAmount: Readonly<{ amount: string; currency: "USDC" }>;
  settlementFinality: Readonly<{
    model: "liquidity-tank";
    finalityObservedAt: number;
  }>;
  authenticationHash: string;
}

export type LiquidityTankRecoveryCheckpoint = Readonly<
  Extract<LiquidityTankObservation, { status: "pending" }> & {
    lockTxHash: string;
    recoveryDeadline: number;
  }
>;

/**
 * Authenticated evidence that the release missed `recoveryDeadline`: the
 * locked pending checkpoint observed at or after it, a completion finalized at
 * or after it, or a terminal bridge failure bound to the exact lock.
 * A terminal failure need not refresh its transition timestamp.
 * `observedAt` is the bridge's authenticated time of the status snapshot.
 */
export type LiquidityTankRecoveryEvidence =
  | LiquidityTankRecoveryCheckpoint
  | Readonly<Extract<LiquidityTankObservation, { status: "completed" }>>
  | Readonly<{
      status: "failed-after-lock";
      checkpoint: LiquidityTankRecoveryCheckpoint;
      failure: Readonly<Extract<LiquidityTankObservation, { status: "failed" }>> & {
        lockTxHash: string;
        recoveryDeadline: number;
      };
    }>;

export type LiquidityTankStoreClaim =
  | {
      status: "acquired";
      intent: Readonly<LiquidityTankIntent>;
      lease: Readonly<LiquidityTankLease>;
      submission?: Readonly<LiquidityTankPreparedSubmission>;
      /** The `now` of the write that first recorded `submission`; present exactly with it. */
      submissionRecordedAt?: number;
      observation?: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>>;
      recoveryFailure?: Extract<LiquidityTankRecoveryEvidence, { status: "failed-after-lock" }>;
    }
  | {
      status: "waiting";
      intent: Readonly<LiquidityTankIntent>;
      lease: Readonly<LiquidityTankLease>;
      submission?: Readonly<LiquidityTankPreparedSubmission>;
      /** The `now` of the write that first recorded `submission`; present exactly with it. */
      submissionRecordedAt?: number;
      observation?: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>>;
      recoveryFailure?: Extract<LiquidityTankRecoveryEvidence, { status: "failed-after-lock" }>;
    }
  | {
      status: "settled";
      intent: Readonly<LiquidityTankIntent>;
      settlement: Readonly<LiquidityTankSettlement>;
    }
  | {
      status: "recovery-expired";
      intent: Readonly<LiquidityTankIntent>;
      submission: Readonly<LiquidityTankPreparedSubmission>;
      /** The `now` of the write that first recorded `submission`. */
      submissionRecordedAt: number;
      observation: LiquidityTankRecoveryEvidence;
    }
  | { status: "conflict" | "corrupt"; reason: string };

export type LiquidityTankStoreWrite =
  | { status: "recorded" | "existing" }
  | { status: "stale" | "conflict" | "corrupt"; reason: string };

/**
 * Durable settlement state. Restart safety holds only for a store that keeps
 * every row across process restarts and commits each write atomically. Run
 * `runLiquidityTankStoreConformance` against it before production use:
 * passing is required, but it checks the contract in its own sequences and
 * races, not that every interleaving commits atomically.
 * Every write must refuse a lease that is not current at its `now`
 * (`expiresAt <= now`), as well as a stale owner or generation.
 */
export interface LiquidityTankStore {
  /**
   * An acquired lease must carry the caller's `owner`, a generation above any
   * earlier one for the key, and `expiresAt` exactly `now + leaseDurationMs`
   * from this input, not from the store's own clock; the core refuses any
   * other lease as `liquidity-tank-settlement-store-lease-invalid`.
   */
  claim(input: {
    intent: Readonly<LiquidityTankIntent>;
    owner: string;
    now: number;
    leaseDurationMs: number;
  }): Promise<LiquidityTankStoreClaim>;
  isCurrent(input: {
    settlementKey: string;
    bindingHash: string;
    owner: string;
    generation: number;
    now: number;
  }): Promise<boolean>;
  /**
   * The first recorded submission keeps this write's `now` as its
   * `submissionRecordedAt`, in the same atomic write. Every later acquired,
   * waiting or recovery-expired claim returns that value unchanged beside the
   * submission; an `existing` replay never replaces it. The core uses a
   * retained submission only when its `preparedAt` is within one minute of it.
   */
  recordSubmission(input: {
    settlementKey: string;
    bindingHash: string;
    owner: string;
    generation: number;
    now: number;
    submission: Readonly<LiquidityTankPreparedSubmission>;
  }): Promise<LiquidityTankStoreWrite>;
  recordObservation(input: {
    settlementKey: string;
    bindingHash: string;
    owner: string;
    generation: number;
    now: number;
    observation: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>>;
  }): Promise<LiquidityTankStoreWrite>;
  /**
   * Retains terminal failure evidence without replacing the locked pending
   * observation. CAS against `recoveryFailure.checkpoint` as the exact durable
   * observation and the current lease at `now`; no completion or expiry may
   * have won. Keep the first evidence and reject a conflicting replacement.
   * Return it in acquired/waiting claims until completion. A success must echo
   * the evidence now retained; the core treats any other echo as not retained.
   */
  recordRecoveryFailure(input: {
    settlementKey: string;
    bindingHash: string;
    owner: string;
    generation: number;
    now: number;
    recoveryFailure: Extract<LiquidityTankRecoveryEvidence, { status: "failed-after-lock" }>;
  }): Promise<
    | {
        status: "recorded" | "existing";
        recoveryFailure: Extract<LiquidityTankRecoveryEvidence, { status: "failed-after-lock" }>;
      }
    | { status: "stale" | "conflict" | "corrupt"; reason: string }
  >;
  /**
   * Atomically records terminal recovery expiry only if `observation` is still
   * consistent with `expectedObservation`, the identified lease is current at
   * `now`, and no completion or settlement won. `expectedObservation` is the
   * exact durable observation established by the claim or a confirmed write,
   * if one existed. `now` must reach `recoveryDeadline`. Pending snapshots also
   * need `observedAt >= recoveryDeadline`; completions need late finality.
   * Terminal failure evidence must equal the one retained by
   * `recordRecoveryFailure` and bind its authenticated lock hash/deadline to
   * the exact durable checkpoint.
   */
  recordRecoveryExpired(input: {
    settlementKey: string;
    bindingHash: string;
    owner: string;
    generation: number;
    now: number;
    expectedObservation?: Readonly<
      Exclude<LiquidityTankObservation, { status: "indeterminate" }>
    >;
    observation: LiquidityTankRecoveryEvidence;
  }): Promise<LiquidityTankStoreWrite>;
  recordSettlement(input: {
    settlementKey: string;
    bindingHash: string;
    owner: string;
    generation: number;
    now: number;
    settlement: Readonly<LiquidityTankSettlement>;
  }): Promise<LiquidityTankStoreWrite>;
}

export type LiquidityTankProgress =
  | { status: "waiting" | "indeterminate"; reason: string }
  | {
      status: "failed";
      errorClass: "permanent" | "failed-substrate";
      reason: string;
      reputationNeutral?: true;
    }
  | {
      status: "settle-asymmetric";
      reason: "tank-locked-unreleased" | "lock-contradicted";
      /** Exact Unix-millisecond timestamp from the authenticated checkpoint. */
      recoveryDeadline: number;
      /**
       * The host clock read during this call was at or after `recoveryDeadline`
       * but no expiry evidence was accepted. The lock is overdue: alert if this
       * persists rather than polling silently.
       */
      pastDeadline: boolean;
      /**
       * Set when this call's authenticated bridge status could not move the
       * lock: `failed` is retained terminal evidence, expiring when the host
       * clock reaches `recoveryDeadline`; `conflicting` contradicts the checkpoint
       * and needs an operator. Past the deadline its reason is `lock-contradicted`
       * and the lock does not expire while its bridge reads contradict it. That
       * does not conform to DACS-4 §9.5.5, which resolves an expired window to
       * `failed-substrate`: expiring cannot tell whether the release landed, so
       * it could let the buyer pay twice.
       */
      bridgeStatus?: "failed" | "conflicting";
      txRef: Readonly<{
        kind: "liquidity-tank";
        bridgeId: string;
        sourceChainId: number;
        destChainId: number;
        lockTxHash: string;
        /** Exact Unix-millisecond timestamp from the authenticated checkpoint. */
        recoveryDeadline: number;
      }>;
    }
  | { status: "settled"; settlement: Readonly<LiquidityTankSettlement> };

export interface AdvanceLiquidityTankInput {
  authority: Readonly<LiquidityTankAuthority>;
  owner: string;
  store: LiquidityTankStore;
  adapter: LiquidityTankAdapter;
  verifier: LiquidityTankVerifier;
  now?: () => number;
  leaseDurationMs?: number;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DacsError(`pay-cross-chain-liquidity-tank: ${label} must be a non-empty string`);
  }
  return value;
}

/** Matches a primitive string only: a boxed string or an array is never coerced. */
function matchesPattern(pattern: RegExp, value: unknown): value is string {
  return typeof value === "string" && reflectApply(regExpExec, pattern, [value]) !== null;
}

/** The capture groups of a match, or null; `pattern` must not be global or sticky. */
function patternGroups(pattern: RegExp, value: string): RegExpExecArray | null {
  return reflectApply(regExpExec, pattern, [value]) as RegExpExecArray | null;
}

function normalizeNfc(value: string): string {
  return reflectApply(stringNormalize, value, ["NFC"]) as string;
}

/** True when `value` has no unpaired UTF-16 surrogate, as JSON text requires. */
function isWellFormedString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = reflectApply(stringCharCodeAt, value, [index]) as number;
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = reflectApply(stringCharCodeAt, value, [index + 1]) as number;
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * `value` without its trailing `=` padding. No live regex: a replaced
 * `RegExp.prototype.exec` cannot make a valid retained row read as corrupt.
 */
function withoutBase64Padding(value: string): string {
  let end = value.length;
  while (end > 0 && reflectApply(stringCharCodeAt, value, [end - 1]) === 0x3d) end -= 1;
  return reflectApply(stringSlice, value, [0, end]) as string;
}

/** SHA-256 of the UTF-8 bytes of `value`, through the hash captured at load. */
function ownedSha256Hex(value: string): string {
  return reflectApply(oneShotHash, undefined, ["sha256", value, "hex"]) as string;
}

/**
 * The named own data fields of `source`, read through the intrinsics captured
 * at load, so no prototype, getter or proxy trap supplies or changes one.
 * Strings are NFC-normalized by the captured normalizer and numbers kept;
 * any other value reads as absent, so its field check refuses it.
 */
function ownFields(
  source: object,
  keys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  if (isProxy(source)) {
    throw new DacsError(`pay-cross-chain-liquidity-tank: ${label} must be stable data`);
  }
  const fields = { __proto__: null } as unknown as Record<string, unknown>;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index] as string;
    const descriptor = getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined) continue;
    if (!hasOwn(descriptor, "value")) {
      throw new DacsError(`pay-cross-chain-liquidity-tank: ${label} must be stable data`);
    }
    const value: unknown = descriptor.value;
    if (typeof value === "string") {
      if (!isWellFormedString(value)) {
        throw new DacsError(`pay-cross-chain-liquidity-tank: ${label} must be stable data`);
      }
      fields[key] = normalizeNfc(value);
    } else if (typeof value === "number") {
      // Canonical JSON has no negative zero.
      if (value === 0 && 1 / value < 0) {
        throw new DacsError(`pay-cross-chain-liquidity-tank: ${label} must be stable data`);
      }
      fields[key] = value;
    }
  }
  return freeze(fields);
}

/**
 * Reads the own fields before the shared gate runs, so a built-in the gate
 * reaches cannot rewrite them first; a read refusal is raised after the gate,
 * which keeps the gate's refusal messages.
 */
function ownFieldsBeforeGate(
  source: unknown,
  keys: readonly string[],
  label: string,
): () => Readonly<Record<string, unknown>> {
  if (source === null || typeof source !== "object") {
    return () => {
      throw new DacsError(`pay-cross-chain-liquidity-tank: ${label} must be stable data`);
    };
  }
  try {
    const fields = ownFields(source, keys, label);
    return () => fields;
  } catch (error) {
    return () => {
      throw error;
    };
  }
}

function requireJobId(value: unknown): string {
  if (!matchesPattern(CANONICAL_JOB_ID_RE, value)) {
    throw new DacsError("jobId must be a canonical uppercase ULID");
  }
  return value;
}

/**
 * The CD-1 canonical form of a positive amount and its base units at the fixed
 * route's 6 decimals: the results of `assertPositiveAmount` and `baseUnits`,
 * computed through the captured intrinsics only.
 */
function positiveUsdcAmount(value: unknown): { amount: string; baseUnits: string } {
  const parts = typeof value === "string" ? patternGroups(DECIMAL_PARTS_RE, value) : null;
  const integerDigits = parts?.[1] ?? "";
  const fractionDigits = parts?.[2] ?? "";
  if (parts === null || integerDigits.length + fractionDigits.length === 0) {
    throw new DacsError("pay-cross-chain-liquidity-tank: amount must be a plain decimal string");
  }
  const integer = patternGroups(LEADING_ZEROS_RE, integerDigits)?.[1] || "0";
  const fraction = patternGroups(TRAILING_ZEROS_RE, fractionDigits)?.[1] ?? "";
  const amount = fraction === "" ? integer : `${integer}.${fraction}`;
  if (amount === "0") {
    throw new DacsError("pay-cross-chain-liquidity-tank: amount must be greater than zero");
  }
  // Refused before indexing: a negative index is not an own element, so the
  // read would fall through to a polluted `Array.prototype`/`Object.prototype`.
  if (fraction.length > USDC_DECIMALS) {
    throw new DacsError(
      `pay-cross-chain-liquidity-tank: amount has more precision than ${USDC_DECIMALS} decimals`,
    );
  }
  const padding = ZERO_PADDING[USDC_DECIMALS - fraction.length] as string;
  // A positive amount has a non-zero digit, so the stripped units are never empty.
  const baseUnits = patternGroups(LEADING_ZEROS_RE, `${integer}${fraction}${padding}`)?.[1] ?? "";
  return { amount, baseUnits };
}

function requireUInt(value: unknown, label: string, positive = false): number {
  // A safe integer is a primitive number, so no global `Number` is called.
  if (!isSafeInteger(value) || (positive ? (value as number) <= 0 : (value as number) < 0)) {
    throw new DacsError(
      `pay-cross-chain-liquidity-tank: ${label} must be a ${positive ? "positive" : "non-negative"} safe integer`,
    );
  }
  return value as number;
}

function leaseExpiry(now: number, leaseDurationMs: number): number {
  if (now > Number.MAX_SAFE_INTEGER - leaseDurationMs) {
    throw new DacsError(
      "pay-cross-chain-liquidity-tank: lease expiry must be a safe integer",
    );
  }
  return now + leaseDurationMs;
}

function recoveryDeadlineUnixMs(value: unknown): number {
  return requireUInt(value, "recoveryDeadline", true);
}

/**
 * A bridge time earlier than the submission it describes, such as one sent in
 * seconds; `reason` names the field.
 */
class BeforePreparationError extends DacsError {
  readonly reason: string;

  constructor(reason: string, label: string) {
    super(`pay-cross-chain-liquidity-tank: ${label} is before the submission was prepared`);
    this.reason = reason;
  }
}

/**
 * A bridge time on `submission`'s operation, which cannot fall before the
 * submission was prepared. No unit heuristic: a seconds-scale value is
 * refused, not converted.
 */
function afterPreparation(
  time: number,
  submission: Readonly<LiquidityTankPreparedSubmission>,
  reason: string,
  label: string,
): number {
  if (time < submission.preparedAt) throw new BeforePreparationError(reason, label);
  return time;
}

/** The deadline of a lock on `submission`, which is set when the lock commits. */
function recoveryDeadlineAfterPreparation(
  value: unknown,
  submission: Readonly<LiquidityTankPreparedSubmission>,
): number {
  return afterPreparation(
    recoveryDeadlineUnixMs(value),
    submission,
    "liquidity-tank-recovery-deadline-before-preparation",
    "recoveryDeadline",
  );
}

/** Whether `preparedAt` lies within the skew window of the host-clock reading `at`. */
function preparedNear(preparedAt: number, at: number): boolean {
  return preparedAt - at <= PREPARATION_CLOCK_SKEW_MS && at - preparedAt <= PREPARATION_CLOCK_SKEW_MS;
}

/**
 * Why a retained submission may not be used, or null. Its `preparedAt` is
 * bound to this host's clock only through the receipt the store kept when it
 * was first recorded, so a row without one, or stamped outside the window of
 * it (such as in seconds), never reaches an observation or deadline decision.
 */
function retainedReceiptRefusal(
  receipt: unknown,
  submission: Readonly<LiquidityTankPreparedSubmission>,
): string | null {
  if (receipt === undefined) return "liquidity-tank-submission-receipt-missing";
  if (!isSafeInteger(receipt) || (receipt as number) < 0) return "liquidity-tank-retained-state-corrupt";
  return preparedNear(submission.preparedAt, receipt as number)
    ? null
    : "liquidity-tank-preparation-time-off-receipt";
}

function stableDataProperty(
  source: unknown,
  key: PropertyKey,
  label: string,
): unknown {
  if ((typeof source !== "object" && typeof source !== "function") ||
      source === null || isProxy(source)) {
    throw new DacsError(`pay-cross-chain-liquidity-tank: ${label} must be stable data`);
  }
  try {
    let cursor: object | null = source;
    while (cursor !== null) {
      if (isProxy(cursor)) throw new TypeError("proxy prototype");
      const descriptor = getOwnPropertyDescriptor(cursor, key);
      if (descriptor !== undefined) {
        if (!hasOwn(descriptor, "value")) throw new TypeError("accessor property");
        return descriptor.value;
      }
      cursor = getPrototypeOf(cursor);
    }
  } catch (cause) {
    throw new DacsError(
      `pay-cross-chain-liquidity-tank: ${label} must be stable data`,
      { cause },
    );
  }
  return undefined;
}

type LiquidityTankMethod = (...args: never[]) => unknown;

function stableBoundMethod<T extends LiquidityTankMethod>(
  source: unknown,
  key: PropertyKey,
  label: string,
): T {
  const method = stableDataProperty(source, key, label);
  if (typeof method !== "function" || isProxy(method)) {
    throw new DacsError(
      `pay-cross-chain-liquidity-tank: ${label} must be a stable method`,
    );
  }
  // Unlike `bind`, reads no `name` or `length` getter on the method.
  return ((...args: unknown[]) => reflectApply(method, source, args)) as unknown as T;
}

/** Read through the intrinsics captured at load, so a refusal reads as one. */
function successfulStoreWrite(value: unknown): boolean {
  if (value === null || typeof value !== "object" || isProxy(value)) return false;
  const status = getOwnPropertyDescriptor(value, "status");
  return status !== undefined && hasOwn(status, "value") &&
    (status.value === "recorded" || status.value === "existing");
}

/**
 * A retention write counts only if it succeeded and echoes exactly the
 * evidence sent; a store that dropped or replaced it cannot echo it.
 */
function retainedRecoveryFailure(value: unknown, sent: LiquidityTankRecoveryEvidence): boolean {
  if (!successfulStoreWrite(value)) return false;
  const echo = getOwnPropertyDescriptor(value as object, "recoveryFailure");
  if (echo === undefined || !hasOwn(echo, "value")) return false;
  try {
    return canonicalize(snapshotCanonicalJsonRead(
      echo.value,
      "liquidity-tank retained recovery failure",
    )) === canonicalize(sent);
  } catch {
    return false;
  }
}

/**
 * The top level of a store or adapter result, read through the intrinsics
 * captured at load; `present` is an owned record, so which fields the result
 * holds is not decided by a live `Set`.
 */
function snapshotOptionalCanonicalReadWithPresence<T>(
  value: T,
  label: string,
  optionalUndefined: ReadonlySet<string>,
): Readonly<{ value: T; present: Readonly<Record<string, true>> }> {
  try {
    if (value === null || typeof value !== "object" || isArray(value) || isProxy(value)) {
      throw new TypeError("value is not an ordinary object");
    }
    const prototype = getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) {
      throw new TypeError("value has an exotic prototype");
    }
    const normalized: Record<string, unknown> = {};
    const present = { __proto__: null } as unknown as Record<string, true>;
    const keys = ownKeys(value);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== "string") throw new TypeError("value has a symbol property");
      const descriptor = getOwnPropertyDescriptor(value, key);
      if (!descriptor || !hasOwn(descriptor, "value") || !descriptor.enumerable) {
        throw new TypeError("properties must be enumerable data");
      }
      present[key] = true;
      if (descriptor.value === undefined) {
        if (optionalUndefined.has(key)) continue;
        throw new TypeError("value has an undefined required property");
      }
      Object.defineProperty(normalized, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return Object.freeze({
      value: snapshotCanonicalJsonRead(normalized, label) as T,
      present: freeze(present),
    });
  } catch (cause) {
    throw new DacsError(`${label} must be stable data`, { cause });
  }
}

function snapshotOptionalCanonicalRead<T>(
  value: T,
  label: string,
  optionalUndefined: ReadonlySet<string>,
): T {
  return snapshotOptionalCanonicalReadWithPresence(value, label, optionalUndefined).value;
}

/**
 * A frozen copy of a snapshot's own fields with no prototype, so a field the
 * store or adapter result does not hold reads as `undefined` rather than
 * falling through to a polluted `Object.prototype`.
 */
function withoutPrototype<T>(value: T): T {
  return freeze({ __proto__: null, ...(value as object) }) as unknown as T;
}

function snapshotStoreClaim(value: unknown): Readonly<{
  value: LiquidityTankStoreClaim;
  submissionPresent: boolean;
  submissionValue: unknown;
  /** `undefined` when the claim holds no receipt. */
  submissionRecordedAt: unknown;
  observationPresent: boolean;
  observationValue: unknown;
  recoveryFailurePresent: boolean;
  recoveryFailureValue: unknown;
}> {
  const snapshot = snapshotOptionalCanonicalReadWithPresence(
    value,
    "liquidity-tank store claim",
    new Set(["submission", "submissionRecordedAt", "observation", "recoveryFailure"]),
  );
  const submission = getOwnPropertyDescriptor(snapshot.value as object, "submission");
  const receipt = getOwnPropertyDescriptor(snapshot.value as object, "submissionRecordedAt");
  const observation = getOwnPropertyDescriptor(snapshot.value as object, "observation");
  const failure = getOwnPropertyDescriptor(snapshot.value as object, "recoveryFailure");
  return Object.freeze({
    value: withoutPrototype(snapshot.value as LiquidityTankStoreClaim),
    submissionPresent: snapshot.present["submission"] === true,
    submissionValue: submission && hasOwn(submission, "value") ? submission.value : undefined,
    submissionRecordedAt: receipt && hasOwn(receipt, "value") ? receipt.value : undefined,
    observationPresent: snapshot.present["observation"] === true,
    observationValue: observation && hasOwn(observation, "value") ? observation.value : undefined,
    recoveryFailurePresent: snapshot.present["recoveryFailure"] === true,
    recoveryFailureValue: failure && hasOwn(failure, "value") ? failure.value : undefined,
  });
}

function captureSettlement(
  value: unknown,
  intent: Readonly<LiquidityTankIntent>,
): Readonly<LiquidityTankSettlement> {
  const settlement = withoutPrototype(snapshotCanonicalJsonRead(
    value,
    "liquidity-tank stored settlement",
  ) as LiquidityTankSettlement);
  const txRef = withoutPrototype(settlement.txRef);
  const paymentAmount = withoutPrototype(settlement.paymentAmount);
  const settlementFinality = withoutPrototype(settlement.settlementFinality);
  if (txRef.kind !== "liquidity-tank" ||
      !matchesPattern(BRIDGE_ID_RE, txRef.bridgeId) ||
      txRef.sourceChainId !== intent.sourceChainId ||
      txRef.destChainId !== intent.destinationChainId ||
      paymentAmount.amount !== intent.amount ||
      paymentAmount.currency !== intent.currency ||
      settlementFinality.model !== "liquidity-tank" ||
      !matchesPattern(HASH_RE, settlement.authenticationHash)) {
    throw new DacsError("pay-cross-chain-liquidity-tank: stored settlement authority mismatch");
  }
  const recoveryDeadline = recoveryDeadlineUnixMs(txRef.recoveryDeadline);
  const finalityObservedAt = requireUInt(
    settlementFinality.finalityObservedAt,
    "stored finalityObservedAt",
  );
  if (finalityObservedAt >= recoveryDeadline) {
    throw new DacsError("pay-cross-chain-liquidity-tank: stored settlement missed recovery deadline");
  }
  return Object.freeze({
    txRef: Object.freeze({
      kind: "liquidity-tank" as const,
      bridgeId: txRef.bridgeId,
      sourceChainId: txRef.sourceChainId,
      destChainId: txRef.destChainId,
      lockTxHash: requireString(txRef.lockTxHash, "stored lockTxHash"),
      releaseTxHash: requireString(txRef.releaseTxHash, "stored releaseTxHash"),
      recoveryDeadline,
    }),
    paymentAmount: Object.freeze({ amount: intent.amount, currency: intent.currency }),
    settlementFinality: Object.freeze({
      model: "liquidity-tank" as const,
      finalityObservedAt,
    }),
    authenticationHash: settlement.authenticationHash,
  });
}

export function liquidityTankSettlementKey(input: {
  jobId: string;
  railId: string;
  phaseIndex: number;
}): string {
  // The shared snapshot only decides whether the representation is stable
  // canonical JSON; the key is derived from the input's own fields, read
  // before it runs.
  const fields = ownFieldsBeforeGate(input, SETTLEMENT_KEY_FIELDS, "settlement key authority");
  snapshotCanonicalJson(input, "liquidity-tank settlement key authority");
  if (input === null || typeof input !== "object") {
    throw new DacsError("pay-cross-chain-liquidity-tank: settlement key authority must be an object");
  }
  return settlementKeyFromOwnFields(fields());
}

/**
 * The key of an owned, NFC-normalized record, hashed through the captured
 * one-shot hash.
 */
function settlementKeyFromOwnFields(fields: Readonly<Record<string, unknown>>): string {
  const phaseIndex = requireUInt(fields["phaseIndex"], "phaseIndex");
  return ownedSha256Hex(
    `dacs-liquidity-tank:v1:${requireJobId(fields["jobId"])}:` +
      `${requireString(fields["railId"], "railId")}:${phaseIndex}`,
  );
}

export function createLiquidityTankIntent(
  authority: Readonly<LiquidityTankAuthority>,
): Readonly<LiquidityTankIntent> {
  return intentFromCapturedAuthority(captureLiquidityTankAuthority(authority));
}

/**
 * The authority's own fields. The shared snapshot only decides whether the
 * representation is stable canonical JSON, and its result is discarded: it
 * dispatches through live prototypes (`String.prototype.normalize`). The
 * settlement key and every intent field are derived from the authority's own
 * data properties, read and NFC-normalized through the intrinsics captured at
 * load before the shared snapshot runs. A polluted `Object.prototype` cannot
 * supply a missing field: it reads as `undefined` and is refused by its check.
 */
function captureLiquidityTankAuthority(authority: unknown): Readonly<LiquidityTankAuthority> {
  const fields = ownFieldsBeforeGate(authority, AUTHORITY_FIELDS, "authority");
  snapshotCanonicalJson(authority, "liquidity-tank authority");
  if (authority === null || typeof authority !== "object" || isArray(authority)) {
    throw new DacsError("pay-cross-chain-liquidity-tank: authority must be a JSON object");
  }
  return fields() as unknown as Readonly<LiquidityTankAuthority>;
}

/**
 * Deterministic over the owned authority: reads no clock, store or caller
 * code, and only the captured intrinsics decide what it accepts and derive
 * the key and every field the adapter receives.
 */
function intentFromCapturedAuthority(
  authority: Readonly<LiquidityTankAuthority>,
): Readonly<LiquidityTankIntent> {
  if (authority.assetKind !== "stablecoin-cross-chain" ||
      authority.networkKind !== "cross-chain" || authority.mechanism !== "liquidity-tank") {
    throw new DacsError("pay-cross-chain-liquidity-tank: selected rail mechanism mismatch");
  }
  if (authority.supportedScope !== "dacs-v0.1-eth-sepolia-polygon-amoy-usdc" ||
      authority.sourceChainId !== ETH_SEPOLIA_CHAIN_ID ||
      authority.destinationChainId !== POLYGON_AMOY_CHAIN_ID ||
      authority.sourceChainType !== "EVM" || authority.destinationChainType !== "EVM" ||
      authority.sourceAsset !== "USDC" || authority.destinationAsset !== "USDC" ||
      authority.currency !== "USDC") {
    throw new DacsError("pay-cross-chain-liquidity-tank: route is outside DACS v0.1 supported scope");
  }
  if (!matchesPattern(HASH_RE, authority.railDescriptorHash) ||
      !matchesPattern(HASH_RE, authority.agreementHash) ||
      !matchesPattern(HASH_RE, authority.sr5BindingHash)) {
    throw new DacsError("pay-cross-chain-liquidity-tank: authority hashes must be 32-byte lower-case hex");
  }
  const sourceTokenDecimals = requireUInt(authority.sourceTokenDecimals, "sourceTokenDecimals");
  const destinationTokenDecimals = requireUInt(
    authority.destinationTokenDecimals,
    "destinationTokenDecimals",
  );
  if (sourceTokenDecimals !== 6 || destinationTokenDecimals !== 6) {
    throw new DacsError(
      "pay-cross-chain-liquidity-tank: fixed USDC route token decimals must both be exactly 6",
    );
  }
  const { amount, baseUnits } = positiveUsdcAmount(authority.amount);
  const originAddress = requireString(authority.originAddress, "originAddress");
  const destinationAddress = requireString(authority.destinationAddress, "destinationAddress");
  const sourceLiquidityTankId = requireString(
    authority.sourceLiquidityTankId,
    "sourceLiquidityTankId",
  );
  const destinationLiquidityTankId = requireString(
    authority.destinationLiquidityTankId,
    "destinationLiquidityTankId",
  );
  if (sourceLiquidityTankId === destinationLiquidityTankId) {
    throw new DacsError("pay-cross-chain-liquidity-tank: source and destination tank IDs must differ");
  }
  // The operation and binding hashes go through the shared JCS, which
  // dispatches through live prototypes. Both inputs are frozen first, and the
  // intent takes its fields from the locals above, never from an object the
  // shared code was given.
  const operation = freeze({
    originChainType: authority.sourceChainType,
    destinationChainType: authority.destinationChainType,
    originAddress,
    destinationAddress,
    originAmount: baseUnits,
    destinationAmount: baseUnits,
    originAsset: authority.sourceAsset,
    destinationAsset: authority.destinationAsset,
    sourceLiquidityTankId,
    destinationLiquidityTankId,
  });
  const operationHash = sha256Hex(canonicalize(operation));
  const unsigned = freeze({
    intentVersion: "1" as const,
    settlementKey: settlementKeyFromOwnFields(authority as unknown as Readonly<Record<string, unknown>>),
    operationHash,
    jobId: requireJobId(authority.jobId),
    phaseIndex: authority.phaseIndex,
    railId: requireString(authority.railId, "railId"),
    railDescriptorHash: authority.railDescriptorHash,
    agreementHash: authority.agreementHash,
    sr5BindingHash: authority.sr5BindingHash,
    assetKind: authority.assetKind,
    networkKind: authority.networkKind,
    mechanism: authority.mechanism,
    sourceChainId: authority.sourceChainId,
    destinationChainId: authority.destinationChainId,
    sourceChainType: authority.sourceChainType,
    destinationChainType: authority.destinationChainType,
    sourceAsset: authority.sourceAsset,
    destinationAsset: authority.destinationAsset,
    sourceTokenDecimals,
    destinationTokenDecimals,
    sourceAmountBaseUnits: baseUnits,
    destinationAmountBaseUnits: baseUnits,
    amount,
    currency: authority.currency,
    originAddress,
    destinationAddress,
    sourceLiquidityTankId,
    destinationLiquidityTankId,
    supportedScope: authority.supportedScope,
  });
  return freeze({ ...unsigned, bindingHash: sha256Hex(canonicalize(unsigned)) });
}

function validateSubmission(
  value: Readonly<Omit<LiquidityTankPreparedSubmission, "submissionHash">>,
  intent: Readonly<LiquidityTankIntent>,
): Readonly<LiquidityTankPreparedSubmission> {
  const captured = snapshotCanonicalJsonRead(
    value,
    "liquidity-tank prepared submission",
  );
  return validateCapturedSubmission(captured, intent);
}

function validateCapturedSubmission(
  value: Readonly<Omit<LiquidityTankPreparedSubmission, "submissionHash">>,
  intent: Readonly<LiquidityTankIntent>,
): Readonly<LiquidityTankPreparedSubmission> {
  value = withoutPrototype(value);
  if (value.submissionVersion !== "1" || value.authorityHash !== intent.bindingHash ||
      value.operationHash !== intent.operationHash || !matchesPattern(BRIDGE_ID_RE, value.bridgeId)) {
    throw new DacsError("pay-cross-chain-liquidity-tank: prepared submission authority mismatch");
  }
  requireString(value.substrateTxHash, "substrateTxHash");
  requireUInt(value.preparedAt, "preparedAt");
  const encoded = requireString(value.signedSubmissionBase64, "signedSubmissionBase64");
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length === 0 ||
      withoutBase64Padding(decoded.toString("base64")) !== withoutBase64Padding(encoded)) {
    throw new DacsError("pay-cross-chain-liquidity-tank: signed submission must be canonical base64");
  }
  const unsigned = { ...value };
  return Object.freeze({ ...unsigned, submissionHash: sha256Hex(canonicalize(unsigned)) });
}

function validateRetainedSubmission(
  value: Readonly<LiquidityTankPreparedSubmission>,
  intent: Readonly<LiquidityTankIntent>,
): Readonly<LiquidityTankPreparedSubmission> {
  const captured = snapshotCanonicalJsonRead(
    value,
    "liquidity-tank retained submission",
  );
  const { submissionHash, ...unsigned } = withoutPrototype(captured);
  const validated = validateCapturedSubmission(unsigned, intent);
  if (validated.submissionHash !== submissionHash) {
    throw new DacsError("pay-cross-chain-liquidity-tank: retained submission integrity mismatch");
  }
  return validated;
}

function validateObservation(
  value: Readonly<LiquidityTankObservation>,
  intent: Readonly<LiquidityTankIntent>,
  submission: Readonly<LiquidityTankPreparedSubmission>,
): Exclude<LiquidityTankObservation, { status: "indeterminate" }> | LiquidityTankObservation {
  const captured = snapshotOptionalCanonicalRead(
    value,
    "liquidity-tank observation",
    new Set(["lockTxHash", "recoveryDeadline"]),
  );
  return validateCapturedObservation(captured, intent, submission);
}

function validateRetainedObservation(
  value: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>>,
  intent: Readonly<LiquidityTankIntent>,
  submission: Readonly<LiquidityTankPreparedSubmission>,
): Exclude<LiquidityTankObservation, { status: "indeterminate" }> {
  const captured = snapshotCanonicalJsonRead(
    value,
    "liquidity-tank retained observation",
  );
  const validated = validateCapturedObservation(captured, intent, submission);
  if (validated.status === "indeterminate") {
    throw new DacsError("pay-cross-chain-liquidity-tank: indeterminate durable observation");
  }
  return validated;
}

function validateCapturedObservation(
  value: Readonly<LiquidityTankObservation>,
  intent: Readonly<LiquidityTankIntent>,
  submission: Readonly<LiquidityTankPreparedSubmission>,
): Exclude<LiquidityTankObservation, { status: "indeterminate" }> | LiquidityTankObservation {
  // Validated on, and returned as, a copy with no prototype: an unlocked
  // pending's missing `lockTxHash` and `recoveryDeadline` stay missing in
  // every later read.
  value = withoutPrototype(value);
  if (value.status === "indeterminate") {
    return Object.freeze({
      status: "indeterminate" as const,
      reason: requireString(value.reason, "indeterminate reason"),
    });
  }
  if (value.status !== "empty" && value.status !== "pending" &&
      value.status !== "completed" && value.status !== "failed" &&
      value.status !== "capacity-unavailable") {
    throw new DacsError("pay-cross-chain-liquidity-tank: bridge status is invalid");
  }
  if (value.bridgeId !== submission.bridgeId || value.operationHash !== intent.operationHash ||
      !matchesPattern(HASH_RE, value.authenticationHash)) {
    throw new DacsError("pay-cross-chain-liquidity-tank: unauthenticated bridge observation");
  }
  requireUInt(value.observedAt, "observedAt");
  const expectedHistory = value.status === "empty" || value.status === "capacity-unavailable"
    ? ["empty"]
    : value.status === "pending"
      ? ["empty", "pending"]
      : value.status === "completed"
        ? ["empty", "pending", "completed"]
        : value.history.length === 2
          ? ["empty", "failed"]
          : ["empty", "pending", "failed"];
  if (canonicalize(value.history) !== canonicalize(expectedHistory)) {
    throw new DacsError("pay-cross-chain-liquidity-tank: bridge status history is invalid");
  }
  if (value.status === "pending" || value.status === "failed") {
    if ((value.lockTxHash === undefined) !== (value.recoveryDeadline === undefined)) {
      throw new DacsError("pay-cross-chain-liquidity-tank: recovery checkpoint is incomplete");
    }
    if (value.lockTxHash !== undefined) {
      requireString(value.lockTxHash, "lockTxHash");
      recoveryDeadlineAfterPreparation(value.recoveryDeadline, submission);
      // A locked snapshot proves expiry by its `observedAt`, and the lock it
      // describes committed after the submission was signed.
      if (value.status === "pending") {
        afterPreparation(
          value.observedAt,
          submission,
          "liquidity-tank-lock-observed-before-preparation",
          "locked pending observedAt",
        );
      }
    }
  }
  if (value.status === "completed") {
    requireString(value.lockTxHash, "lockTxHash");
    requireString(value.releaseTxHash, "releaseTxHash");
    recoveryDeadlineAfterPreparation(value.recoveryDeadline, submission);
    // Timeliness compares finality with the deadline: a release cannot
    // finalize before its submission was signed.
    afterPreparation(
      requireUInt(value.finalityObservedAt, "finalityObservedAt"),
      submission,
      "liquidity-tank-finality-before-preparation",
      "finalityObservedAt",
    );
  }
  if (value.status === "failed" || value.status === "capacity-unavailable") {
    requireString(value.reason, "reason");
  }
  return freeze({
    __proto__: null,
    ...value,
    history: Object.freeze([...value.history]),
  }) as unknown as Exclude<LiquidityTankObservation, { status: "indeterminate" }>;
}

function progressFromDurableObservation(
  intent: Readonly<LiquidityTankIntent>,
  observation: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>> | undefined,
  now: number,
  bridgeStatus?: "failed" | "conflicting",
): LiquidityTankProgress | null {
  if (!observation) return null;
  if (observation.status === "pending" && observation.lockTxHash && observation.recoveryDeadline) {
    return {
      status: "settle-asymmetric",
      reason: bridgeStatus === "conflicting" && now >= observation.recoveryDeadline
        ? "lock-contradicted" : "tank-locked-unreleased",
      recoveryDeadline: observation.recoveryDeadline,
      pastDeadline: now >= observation.recoveryDeadline,
      ...(bridgeStatus === undefined ? {} : { bridgeStatus }),
      txRef: Object.freeze({
        kind: "liquidity-tank",
        bridgeId: observation.bridgeId,
        sourceChainId: intent.sourceChainId,
        destChainId: intent.destinationChainId,
        lockTxHash: observation.lockTxHash,
        recoveryDeadline: observation.recoveryDeadline,
      }),
    };
  }
  return null;
}

function recoveryCheckpoint(
  observation: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>> | undefined,
): LiquidityTankRecoveryCheckpoint | undefined {
  return observation?.status === "pending" && observation.lockTxHash !== undefined &&
      observation.recoveryDeadline !== undefined
    ? observation as LiquidityTankRecoveryCheckpoint
    : undefined;
}

function failedAfterLock(
  observation: Readonly<LiquidityTankObservation>,
  checkpoint: LiquidityTankRecoveryCheckpoint,
): observation is Extract<LiquidityTankRecoveryEvidence, { status: "failed-after-lock" }>["failure"] {
  return observation.status === "failed" && observation.lockTxHash === checkpoint.lockTxHash &&
    observation.recoveryDeadline === checkpoint.recoveryDeadline;
}

function recoveryEvidenceDeadline(evidence: LiquidityTankRecoveryEvidence): number {
  return evidence.status === "failed-after-lock"
    ? evidence.checkpoint.recoveryDeadline
    : evidence.recoveryDeadline;
}

/**
 * Pending snapshots must describe the bridge at/after the deadline; a
 * terminal non-completion bound to the exact lock remains valid evidence.
 * The host-clock deadline is checked separately by the core and store CAS.
 */
function provesRecoveryExpiry(evidence: LiquidityTankRecoveryEvidence): boolean {
  if (evidence.status === "completed") {
    return evidence.finalityObservedAt >= evidence.recoveryDeadline;
  }
  return evidence.status === "pending"
    ? evidence.observedAt >= evidence.recoveryDeadline
    : failedAfterLock(evidence.failure, evidence.checkpoint);
}

/** Structural validation only; callers decide timeliness with `provesRecoveryExpiry`. */
function validateRecoveryEvidence(
  value: LiquidityTankRecoveryEvidence,
  intent: Readonly<LiquidityTankIntent>,
  submission: Readonly<LiquidityTankPreparedSubmission>,
): LiquidityTankRecoveryEvidence {
  const captured = withoutPrototype(snapshotCanonicalJsonRead(
    value,
    "liquidity-tank recovery evidence",
  ) as LiquidityTankRecoveryEvidence);
  if (captured.status === "failed-after-lock") {
    const checkpoint = validateCapturedObservation(captured.checkpoint, intent, submission);
    const failure = validateCapturedObservation(captured.failure, intent, submission);
    if (checkpoint.status === "indeterminate" || !recoveryCheckpoint(checkpoint) ||
        !failedAfterLock(failure, checkpoint as LiquidityTankRecoveryCheckpoint)) {
      throw new DacsError("pay-cross-chain-liquidity-tank: recovery evidence is invalid");
    }
    return Object.freeze({
      status: "failed-after-lock" as const,
      checkpoint: checkpoint as LiquidityTankRecoveryCheckpoint,
      failure,
    });
  }
  const observation = validateCapturedObservation(captured, intent, submission);
  if (observation.status === "completed") return observation;
  const checkpoint = observation.status === "indeterminate"
    ? undefined
    : recoveryCheckpoint(observation);
  if (!checkpoint) {
    throw new DacsError("pay-cross-chain-liquidity-tank: recovery evidence is invalid");
  }
  return checkpoint;
}

/** A retained row the core refuses to act on; every such reason needs an operator. */
function retainedStateRefusal(error: unknown): LiquidityTankProgress {
  return {
    status: "indeterminate",
    reason: error instanceof BeforePreparationError
      ? error.reason
      : "liquidity-tank-retained-state-corrupt",
  };
}

function recoveryExpiredProgress(): LiquidityTankProgress {
  return {
    status: "failed",
    errorClass: "failed-substrate",
    reason: "tank-locked-unreleased-recovery-expired",
    reputationNeutral: true,
  };
}

function settlementFromCompletedObservation(
  intent: Readonly<LiquidityTankIntent>,
  observation: Readonly<Extract<LiquidityTankObservation, { status: "completed" }>>,
): Readonly<LiquidityTankSettlement> {
  return Object.freeze({
    txRef: Object.freeze({
      kind: "liquidity-tank" as const,
      bridgeId: observation.bridgeId,
      sourceChainId: intent.sourceChainId,
      destChainId: intent.destinationChainId,
      lockTxHash: observation.lockTxHash,
      releaseTxHash: observation.releaseTxHash,
      recoveryDeadline: observation.recoveryDeadline,
    }),
    paymentAmount: Object.freeze({ amount: intent.amount, currency: intent.currency }),
    settlementFinality: Object.freeze({
      model: "liquidity-tank" as const,
      finalityObservedAt: observation.finalityObservedAt,
    }),
    authenticationHash: observation.authenticationHash,
  });
}

function preservesRecoveryCheckpoint(
  prior: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>>,
  next: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>>,
): boolean {
  if (prior.status !== "pending" || prior.lockTxHash === undefined ||
      prior.recoveryDeadline === undefined) {
    return true;
  }
  if (next.status === "pending") {
    return next.lockTxHash === prior.lockTxHash &&
      next.recoveryDeadline === prior.recoveryDeadline;
  }
  return next.status === "completed" && next.lockTxHash === prior.lockTxHash &&
    next.recoveryDeadline === prior.recoveryDeadline;
}

export async function advanceLiquidityTankSettlement(
  input: Readonly<AdvanceLiquidityTankInput>,
): Promise<LiquidityTankProgress> {
  let authority: Readonly<LiquidityTankAuthority>;
  try {
    authority = captureLiquidityTankAuthority(
      stableDataProperty(input, "authority", "authority"),
    );
  } catch (error) {
    // The same authority data presented as a proxy, accessor or frozen object
    // derives the same settlement key, so a lock may already be durable under
    // it: refusing its representation is never a settlement failure.
    return {
      status: "indeterminate",
      reason: error instanceof Error ? error.message : "liquidity-tank-authority-unreadable",
    };
  }
  let intent: Readonly<LiquidityTankIntent>;
  try {
    intent = intentFromCapturedAuthority(authority);
  } catch (error) {
    // The settlement key binds only jobId, railId and phaseIndex, so refused
    // content (a field shifted in type or case) may share the key of a phase
    // that already holds a lock or settled: never report a settlement failure.
    return {
      status: "indeterminate",
      reason: error instanceof Error ? error.message : "liquidity-tank-authority-invalid",
    };
  }
  let owner: string;
  let leaseDurationMs: number;
  let now: () => number;
  let claimSettlement: LiquidityTankStore["claim"];
  let isCurrentSettlement: LiquidityTankStore["isCurrent"];
  let recordSubmission: LiquidityTankStore["recordSubmission"];
  let recordObservation: LiquidityTankStore["recordObservation"];
  let recordRecoveryFailure: LiquidityTankStore["recordRecoveryFailure"];
  let recordRecoveryExpired: LiquidityTankStore["recordRecoveryExpired"];
  let recordSettlement: LiquidityTankStore["recordSettlement"];
  let prepareSubmission: LiquidityTankAdapter["prepareSubmission"];
  let broadcastRetained: LiquidityTankAdapter["broadcastRetained"];
  let observeSettlement: LiquidityTankAdapter["observe"];
  let store: unknown;
  try {
    const ownerValue = stableDataProperty(input, "owner", "owner");
    const leaseDurationValue = stableDataProperty(
      input,
      "leaseDurationMs",
      "leaseDurationMs",
    );
    const nowValue = stableDataProperty(input, "now", "now");
    store = stableDataProperty(input, "store", "store");
    const adapter = stableDataProperty(input, "adapter", "adapter");
    owner = requireString(ownerValue, "owner");
    leaseDurationMs = requireUInt(
      leaseDurationValue ?? DEFAULT_LEASE_MS,
      "leaseDurationMs",
      true,
    );
    const nowCandidate = nowValue ?? Date.now;
    if (typeof nowCandidate !== "function" || isProxy(nowCandidate)) {
      throw new DacsError("pay-cross-chain-liquidity-tank: now must be a stable function");
    }
    now = nowCandidate as () => number;
    claimSettlement = stableBoundMethod<LiquidityTankStore["claim"]>(
      store,
      "claim",
      "store.claim",
    );
    isCurrentSettlement = stableBoundMethod<LiquidityTankStore["isCurrent"]>(
      store,
      "isCurrent",
      "store.isCurrent",
    );
    recordSubmission = stableBoundMethod<LiquidityTankStore["recordSubmission"]>(
      store,
      "recordSubmission",
      "store.recordSubmission",
    );
    recordObservation = stableBoundMethod<LiquidityTankStore["recordObservation"]>(
      store,
      "recordObservation",
      "store.recordObservation",
    );
    recordRecoveryExpired = stableBoundMethod<LiquidityTankStore["recordRecoveryExpired"]>(
      store,
      "recordRecoveryExpired",
      "store.recordRecoveryExpired",
    );
    recordSettlement = stableBoundMethod<LiquidityTankStore["recordSettlement"]>(
      store,
      "recordSettlement",
      "store.recordSettlement",
    );
    prepareSubmission = stableBoundMethod<LiquidityTankAdapter["prepareSubmission"]>(
      adapter,
      "prepareSubmission",
      "adapter.prepareSubmission",
    );
    broadcastRetained = stableBoundMethod<LiquidityTankAdapter["broadcastRetained"]>(
      adapter,
      "broadcastRetained",
      "adapter.broadcastRetained",
    );
    observeSettlement = stableBoundMethod<LiquidityTankAdapter["observe"]>(
      adapter,
      "observe",
      "adapter.observe",
    );
  } catch (error) {
    // A misconfigured host says nothing about the bridge, and a lock may
    // already be durable or settled: never report a settlement failure.
    return {
      status: "indeterminate",
      reason: error instanceof Error ? error.message : "liquidity-tank-runtime-policy-invalid",
    };
  }
  try {
    recordRecoveryFailure = stableBoundMethod<LiquidityTankStore["recordRecoveryFailure"]>(
      store,
      "recordRecoveryFailure",
      "store.recordRecoveryFailure",
    );
  } catch {
    // A store not upgraded with the SDK, or wrapped so its method cannot be
    // bound, may still hold a durable lock or a settlement the core cannot read.
    return {
      status: "indeterminate",
      reason: "liquidity-tank-store-recovery-capability-unavailable",
    };
  }
  // Without the host's checks the core cannot tell a forged observation or a
  // submission signing another amount from a genuine one, so it refuses
  // before any claim rather than trusting the adapter.
  let verifier: unknown;
  try {
    verifier = stableDataProperty(input, "verifier", "verifier");
  } catch {
    verifier = undefined;
  }
  let authenticateObservation: LiquidityTankVerifier["authenticateObservation"];
  try {
    authenticateObservation = stableBoundMethod<LiquidityTankVerifier["authenticateObservation"]>(
      verifier,
      "authenticateObservation",
      "verifier.authenticateObservation",
    );
  } catch {
    return { status: "indeterminate", reason: "liquidity-tank-observation-authenticator-unavailable" };
  }
  let verifySignedSubmission: LiquidityTankVerifier["verifySignedSubmission"];
  try {
    verifySignedSubmission = stableBoundMethod<LiquidityTankVerifier["verifySignedSubmission"]>(
      verifier,
      "verifySignedSubmission",
      "verifier.verifySignedSubmission",
    );
  } catch {
    return { status: "indeterminate", reason: "liquidity-tank-submission-verifier-unavailable" };
  }
  /** Only a literal `true` counts; a throw or any other answer does not. */
  const authenticated = async (
    submissionValue: Readonly<LiquidityTankPreparedSubmission>,
    observationValue: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>>,
  ): Promise<boolean> => {
    try {
      return (await authenticateObservation(freeze({
        intent,
        submission: submissionValue,
        observation: observationValue,
      }))) === true;
    } catch {
      return false;
    }
  };
  const verified = async (
    submissionValue: Readonly<LiquidityTankPreparedSubmission>,
  ): Promise<boolean> => {
    try {
      return (await verifySignedSubmission(freeze({ intent, submission: submissionValue }))) === true;
    } catch {
      return false;
    }
  };
  // The latest valid host clock reading; locked progress reports `pastDeadline`
  // against it.
  let latestNow = 0;
  const readNow = (): number => {
    latestNow = requireUInt(now(), "clock");
    return latestNow;
  };
  let claimNow: number;
  let expectedLeaseExpiry: number;
  try {
    claimNow = readNow();
    expectedLeaseExpiry = leaseExpiry(claimNow, leaseDurationMs);
  } catch {
    return { status: "indeterminate", reason: "liquidity-tank-clock-invalid" };
  }
  let rawClaim: unknown;
  try {
    rawClaim = await claimSettlement({ intent, owner, now: claimNow, leaseDurationMs });
  } catch {
    return { status: "indeterminate", reason: "liquidity-tank-settlement-store-unavailable" };
  }
  let claimSnapshot: ReturnType<typeof snapshotStoreClaim>;
  try {
    claimSnapshot = snapshotStoreClaim(rawClaim);
  } catch {
    return { status: "indeterminate", reason: "liquidity-tank-settlement-store-claim-invalid" };
  }
  const claimed = claimSnapshot.value;
  const claimStatus: unknown = hasOwn(claimed, "status") ? claimed.status : undefined;
  if (typeof claimStatus !== "string") {
    return { status: "indeterminate", reason: "liquidity-tank-settlement-store-claim-invalid" };
  }
  const requiresIntent = claimStatus === "acquired" || claimStatus === "waiting" ||
    claimStatus === "settled" || claimStatus === "recovery-expired";
  const hasIntent = hasOwn(claimed, "intent");
  if (requiresIntent && !hasIntent) {
    return { status: "indeterminate", reason: "liquidity-tank-settlement-store-claim-invalid" };
  }
  if (hasIntent) {
    try {
      const claimedIntent = (claimed as { intent: unknown }).intent;
      if (canonicalize(claimedIntent) !== canonicalize(intent)) {
        return { status: "indeterminate", reason: "liquidity-tank-settlement-store-intent-mismatch" };
      }
    } catch {
      return { status: "indeterminate", reason: "liquidity-tank-settlement-store-intent-invalid" };
    }
  }
  if (claimStatus === "settled") {
    const settledClaim = claimed as Extract<LiquidityTankStoreClaim, { status: "settled" }>;
    try {
      return { status: "settled", settlement: captureSettlement(settledClaim.settlement, intent) };
    } catch {
      return { status: "indeterminate", reason: "liquidity-tank-stored-settlement-mismatch" };
    }
  }
  if (claimStatus === "recovery-expired") {
    const expiredClaim = claimed as Extract<
      LiquidityTankStoreClaim,
      { status: "recovery-expired" }
    >;
    let evidence: LiquidityTankRecoveryEvidence;
    let expiredSubmission: Readonly<LiquidityTankPreparedSubmission>;
    try {
      expiredSubmission = validateRetainedSubmission(expiredClaim.submission, intent);
    } catch (error) {
      return retainedStateRefusal(error);
    }
    const expiredReceiptRefusal = retainedReceiptRefusal(
      claimSnapshot.submissionRecordedAt,
      expiredSubmission,
    );
    if (expiredReceiptRefusal !== null) {
      return { status: "indeterminate", reason: expiredReceiptRefusal };
    }
    try {
      evidence = validateRecoveryEvidence(
        expiredClaim.observation,
        intent,
        expiredSubmission,
      );
      if (!provesRecoveryExpiry(evidence)) {
        throw new DacsError("pay-cross-chain-liquidity-tank: recovery expiry evidence missing");
      }
    } catch (error) {
      return retainedStateRefusal(error);
    }
    const evidenceObservations: readonly Readonly<
      Exclude<LiquidityTankObservation, { status: "indeterminate" }>
    >[] = evidence.status === "failed-after-lock"
      ? [evidence.checkpoint, evidence.failure]
      : [evidence];
    for (let index = 0; index < evidenceObservations.length; index += 1) {
      if (!await authenticated(
        expiredSubmission,
        evidenceObservations[index] as Exclude<LiquidityTankObservation, { status: "indeterminate" }>,
      )) {
        return { status: "indeterminate", reason: "liquidity-tank-retained-observation-unauthenticated" };
      }
    }
    // A terminal failure carries no time of its own: this host's clock must
    // also have reached the deadline before the expiry is reported.
    if (evidence.status === "failed-after-lock" &&
        claimNow < recoveryEvidenceDeadline(evidence)) {
      return { status: "indeterminate", reason: "liquidity-tank-recovery-expiry-not-due" };
    }
    return recoveryExpiredProgress();
  }
  if (claimStatus === "waiting") {
    const waitingClaim = claimed as Extract<LiquidityTankStoreClaim, { status: "waiting" }>;
    try {
      const waitingLease = withoutPrototype(waitingClaim.lease);
      if (!isSafeInteger(waitingLease.generation) || waitingLease.generation <= 0 ||
          !isSafeInteger(waitingLease.expiresAt) || waitingLease.expiresAt <= claimNow ||
          typeof waitingLease.owner !== "string" || waitingLease.owner.length === 0) {
        throw new DacsError("invalid waiting lease");
      }
    } catch {
      return { status: "indeterminate", reason: "liquidity-tank-settlement-store-lease-invalid" };
    }
    return { status: "waiting", reason: "liquidity-tank-settlement-held" };
  }
  if (claimStatus === "corrupt") {
    return { status: "indeterminate", reason: "liquidity-tank-retained-state-corrupt" };
  }
  if (claimStatus === "conflict") {
    // A conflict means the phase already holds another binding, which may be
    // a durable lock or a settlement this intent cannot read.
    const conflictClaim = claimed as Extract<
      LiquidityTankStoreClaim,
      { status: "conflict" | "corrupt" }
    >;
    try {
      return {
        status: "indeterminate",
        reason: requireString(conflictClaim.reason, "claim reason"),
      };
    } catch {
      return { status: "indeterminate", reason: "liquidity-tank-settlement-store-claim-invalid" };
    }
  }
  if (claimStatus !== "acquired") {
    return { status: "indeterminate", reason: "liquidity-tank-settlement-store-claim-invalid" };
  }
  const acquiredClaim = claimed as Extract<LiquidityTankStoreClaim, { status: "acquired" }>;
  let lease: Readonly<LiquidityTankLease>;
  try {
    const acquiredLease = withoutPrototype(acquiredClaim.lease);
    if (acquiredLease.owner !== owner ||
        !isSafeInteger(acquiredLease.generation) || acquiredLease.generation <= 0 ||
        acquiredLease.expiresAt !== expectedLeaseExpiry) {
      throw new DacsError("invalid acquired lease");
    }
    lease = Object.freeze({
      owner: acquiredLease.owner,
      generation: acquiredLease.generation,
      expiresAt: acquiredLease.expiresAt,
    });
  } catch {
    return { status: "indeterminate", reason: "liquidity-tank-settlement-store-lease-invalid" };
  }
  const fence: Readonly<LiquidityTankEffectFence> = Object.freeze({
    settlementKey: intent.settlementKey,
    bindingHash: intent.bindingHash,
    owner: lease.owner,
    generation: lease.generation,
    assertCurrent: async () => {
      const current = await isCurrentSettlement({
        settlementKey: intent.settlementKey,
        bindingHash: intent.bindingHash,
        owner: lease.owner,
        generation: lease.generation,
        now: readNow(),
      });
      if (current !== true) {
        throw new DacsError("pay-cross-chain-liquidity-tank: stale effect fence");
      }
    },
  });
  let submission: Readonly<LiquidityTankPreparedSubmission> | undefined;
  if ((claimSnapshot.observationPresent || claimSnapshot.recoveryFailurePresent ||
      claimSnapshot.submissionRecordedAt !== undefined) && !claimSnapshot.submissionPresent) {
    return { status: "indeterminate", reason: "liquidity-tank-retained-state-corrupt" };
  }
  if (claimSnapshot.submissionPresent) {
    try {
      submission = validateRetainedSubmission(
        claimSnapshot.submissionValue as Readonly<LiquidityTankPreparedSubmission>,
        intent,
      );
    } catch {
      return { status: "indeterminate", reason: "liquidity-tank-retained-state-corrupt" };
    }
    const receiptRefusal = retainedReceiptRefusal(claimSnapshot.submissionRecordedAt, submission);
    if (receiptRefusal !== null) return { status: "indeterminate", reason: receiptRefusal };
    // Retained bytes are re-verified before they are observed against,
    // settled from or rebroadcast.
    if (!await verified(submission)) {
      return { status: "indeterminate", reason: "liquidity-tank-signed-submission-unverified" };
    }
  } else {
    try {
      await fence.assertCurrent();
      submission = validateSubmission(await prepareSubmission(intent, fence), intent);
      await fence.assertCurrent();
    } catch {
      return { status: "indeterminate", reason: "liquidity-tank-submission-preparation-unavailable" };
    }
    // Every bridge time on this submission is checked against `preparedAt`,
    // so it must come from a clock within the skew window of this host's
    // readings before and after preparation.
    if (claimNow - submission.preparedAt > PREPARATION_CLOCK_SKEW_MS ||
        submission.preparedAt - latestNow > PREPARATION_CLOCK_SKEW_MS) {
      return { status: "indeterminate", reason: "liquidity-tank-preparation-time-off-host-clock" };
    }
    // Bytes that do not sign exactly this intent are neither stored nor broadcast.
    if (!await verified(submission)) {
      return { status: "indeterminate", reason: "liquidity-tank-signed-submission-unverified" };
    }
    // The store keeps this reading as the submission's receipt, and a retained
    // submission is used only within the window of it: a submission that has
    // already left the window (a slow verifier) is not stored.
    let recordedAt: number;
    try {
      recordedAt = readNow();
    } catch {
      return { status: "indeterminate", reason: "liquidity-tank-submission-persistence-uncertain" };
    }
    if (!preparedNear(submission.preparedAt, recordedAt)) {
      return { status: "indeterminate", reason: "liquidity-tank-preparation-time-off-host-clock" };
    }
    let stored: boolean;
    try {
      stored = successfulStoreWrite(await recordSubmission({
        settlementKey: intent.settlementKey,
        bindingHash: intent.bindingHash,
        owner: fence.owner,
        generation: fence.generation,
        now: recordedAt,
        submission,
      }));
      await fence.assertCurrent();
    } catch {
      return { status: "indeterminate", reason: "liquidity-tank-submission-persistence-uncertain" };
    }
    if (!stored) {
      return { status: "indeterminate", reason: "liquidity-tank-submission-persistence-uncertain" };
    }
  }

  let durableObservation: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>> | undefined;
  if (claimSnapshot.observationPresent) {
    try {
      durableObservation = validateRetainedObservation(
        claimSnapshot.observationValue as Readonly<
          Exclude<LiquidityTankObservation, { status: "indeterminate" }>
        >,
        intent,
        submission,
      );
    } catch (error) {
      return retainedStateRefusal(error);
    }
    if (!await authenticated(submission, durableObservation)) {
      return { status: "indeterminate", reason: "liquidity-tank-retained-observation-unauthenticated" };
    }
  }

  let durableFailure: Extract<LiquidityTankRecoveryEvidence, { status: "failed-after-lock" }> | undefined;
  if (claimSnapshot.recoveryFailurePresent) {
    try {
      const evidence = validateRecoveryEvidence(
        claimSnapshot.recoveryFailureValue as LiquidityTankRecoveryEvidence, intent, submission,
      );
      if (evidence.status !== "failed-after-lock" ||
          canonicalize(evidence.checkpoint) !== canonicalize(recoveryCheckpoint(durableObservation))) {
        throw new DacsError("pay-cross-chain-liquidity-tank: retained failure checkpoint mismatch");
      }
      durableFailure = evidence;
    } catch (error) {
      return retainedStateRefusal(error);
    }
    if (!await authenticated(submission, durableFailure.checkpoint) ||
        !await authenticated(submission, durableFailure.failure)) {
      return { status: "indeterminate", reason: "liquidity-tank-retained-observation-unauthenticated" };
    }
  }

  const persistSettlement = async (
    observation: Readonly<Extract<LiquidityTankObservation, { status: "completed" }>>,
  ): Promise<LiquidityTankProgress> => {
    const settlement = settlementFromCompletedObservation(intent, observation);
    let stored: boolean;
    try {
      await fence.assertCurrent();
      stored = successfulStoreWrite(await recordSettlement({
        settlementKey: intent.settlementKey,
        bindingHash: intent.bindingHash,
        owner: fence.owner,
        generation: fence.generation,
        now: readNow(),
        settlement,
      }));
    } catch {
      return { status: "indeterminate", reason: "liquidity-tank-settlement-persistence-uncertain" };
    }
    return stored
      ? { status: "settled", settlement }
      : { status: "indeterminate", reason: "liquidity-tank-settlement-persistence-uncertain" };
  };

  const persistRecoveryExpired = async (
    observation: LiquidityTankRecoveryEvidence,
    expectedObservation: Readonly<
      Exclude<LiquidityTankObservation, { status: "indeterminate" }>
    > | undefined,
  ): Promise<LiquidityTankProgress | null> => {
    let recoveryNow: number;
    try {
      recoveryNow = readNow();
    } catch {
      return { status: "indeterminate", reason: "liquidity-tank-clock-invalid" };
    }
    // Snapshot freshness is required for pending, but a terminal failure
    // remains evidence without a refreshed timestamp. The host must reach D.
    if (recoveryNow < recoveryEvidenceDeadline(observation) ||
        !provesRecoveryExpiry(observation)) {
      if (observation.status === "completed") {
        return {
          status: "indeterminate",
          reason: "liquidity-tank-completion-finality-invalid",
        };
      }
      return observation.status === "pending"
        ? progressFromDurableObservation(intent, observation, recoveryNow)
        : progressFromDurableObservation(intent, observation.checkpoint, recoveryNow, "failed");
    }
    let stored: boolean;
    try {
      stored = successfulStoreWrite(await recordRecoveryExpired({
        settlementKey: intent.settlementKey,
        bindingHash: intent.bindingHash,
        owner: fence.owner,
        generation: fence.generation,
        now: recoveryNow,
        expectedObservation,
        observation,
      }));
    } catch {
      return {
        status: "indeterminate",
        reason: "liquidity-tank-recovery-expiry-persistence-uncertain",
      };
    }
    return stored
      ? recoveryExpiredProgress()
      : {
          status: "indeterminate",
          reason: "liquidity-tank-recovery-expiry-persistence-uncertain",
        };
  };

  const resolveRecoveryProgress = async (
    observation: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>> | undefined,
  ): Promise<LiquidityTankProgress | null> => {
    const checkpoint = recoveryCheckpoint(observation);
    return checkpoint
      ? persistRecoveryExpired(checkpoint, observation)
      : null;
  };

  if (durableObservation?.status === "completed") {
    return durableObservation.finalityObservedAt < durableObservation.recoveryDeadline
      ? await persistSettlement(durableObservation)
      : await persistRecoveryExpired(durableObservation, durableObservation) ?? {
          status: "indeterminate",
          reason: "liquidity-tank-recovery-expiry-persistence-uncertain",
        };
  }

  // Retained terminal evidence survives an unavailable/contradictory read.
  // Timely completion is considered first in finalize and can still win.
  const resolveDurableProgress = async (
    bridgeStatus?: "conflicting",
  ): Promise<LiquidityTankProgress | null> => durableFailure
    ? persistRecoveryExpired(durableFailure, durableObservation)
    : progressFromDurableObservation(intent, durableObservation, latestNow, bridgeStatus);

  // Set when this call's observation must not be used at all, not even to
  // fall back on durable progress: the host's authenticator refused it, or
  // one of its times falls before this submission was prepared.
  let observationRefusal: LiquidityTankProgress | undefined;
  const observe = async (): Promise<Readonly<LiquidityTankObservation>> => {
    const unavailable = {
      status: "indeterminate" as const,
      reason: "liquidity-tank-status-unavailable",
    };
    let observed: Readonly<LiquidityTankObservation>;
    try {
      await fence.assertCurrent();
      observed = validateObservation(
        await observeSettlement(intent, submission, fence),
        intent,
        submission,
      );
    } catch (error) {
      if (error instanceof BeforePreparationError) {
        observationRefusal = { status: "indeterminate", reason: error.reason };
      }
      return unavailable;
    }
    if (observed.status !== "indeterminate" && !await authenticated(submission, observed)) {
      observationRefusal = {
        status: "indeterminate",
        reason: "liquidity-tank-observation-unauthenticated",
      };
      return unavailable;
    }
    try {
      await fence.assertCurrent();
    } catch {
      return unavailable;
    }
    return observed;
  };
  const persistObservation = async (
    observation: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>>,
  ): Promise<boolean> => {
    try {
      const stored = successfulStoreWrite(await recordObservation({
        settlementKey: intent.settlementKey,
        bindingHash: intent.bindingHash,
        owner: fence.owner,
        generation: fence.generation,
        now: readNow(),
        observation,
      }));
      await fence.assertCurrent();
      if (stored) durableObservation = observation;
      return stored;
    } catch {
      return false;
    }
  };
  const finalize = async (
    observation: Readonly<LiquidityTankObservation>,
  ): Promise<LiquidityTankProgress | null> => {
    if (observation.status === "indeterminate") {
      return await resolveDurableProgress() ?? {
        status: "indeterminate",
        reason: observation.reason,
      };
    }
    if (durableObservation &&
        !preservesRecoveryCheckpoint(durableObservation, observation)) {
      const checkpoint = recoveryCheckpoint(durableObservation);
      if (checkpoint && failedAfterLock(observation, checkpoint)) {
        if (!durableFailure) {
          const evidence = validateRecoveryEvidence(
            { status: "failed-after-lock", checkpoint, failure: observation }, intent, submission,
          ) as Extract<LiquidityTankRecoveryEvidence, { status: "failed-after-lock" }>;
          try {
            await fence.assertCurrent();
            const stored = retainedRecoveryFailure(await recordRecoveryFailure({
              settlementKey: intent.settlementKey, bindingHash: intent.bindingHash,
              owner: fence.owner, generation: fence.generation, now: readNow(),
              recoveryFailure: evidence,
            }), evidence);
            await fence.assertCurrent();
            if (!stored) throw new DacsError("terminal failure persistence uncertain");
            durableFailure = evidence;
          } catch {
            return { status: "indeterminate", reason: "liquidity-tank-failure-persistence-uncertain" };
          }
        }
        return await persistRecoveryExpired(durableFailure, durableObservation);
      }
      return await resolveDurableProgress("conflicting") ?? {
        status: "indeterminate",
        reason: "liquidity-tank-recovery-checkpoint-conflict",
      };
    }
    if (observation.status === "completed" &&
        observation.finalityObservedAt >= observation.recoveryDeadline) {
      return await persistRecoveryExpired(observation, durableObservation) ?? {
        status: "indeterminate",
        reason: "liquidity-tank-recovery-expiry-persistence-uncertain",
      };
    }
    if (durableFailure && observation.status !== "completed") {
      return await resolveDurableProgress();
    }
    if (!await persistObservation(observation)) {
      // A timely completion has been seen; never expire it on a failed write.
      return progressFromDurableObservation(intent, durableObservation, latestNow) ?? {
        status: "indeterminate",
        reason: "liquidity-tank-observation-persistence-uncertain",
      };
    }
    // The core keeps no tank balance: the bridge enforces its capacity across
    // concurrent phases, and its authenticated refusal is trusted here.
    if (observation.status === "capacity-unavailable") {
      return { status: "waiting", reason: "liquidity-tank-capacity-unavailable" };
    }
    if (observation.status === "failed") {
      return { status: "failed", errorClass: "permanent", reason: observation.reason };
    }
    if (observation.status === "pending") {
      const durablePending = await resolveRecoveryProgress(observation);
      return durablePending ?? {
        status: "waiting",
        reason: "liquidity-tank-pending",
      };
    }
    if (observation.status === "completed") {
      return await persistSettlement(observation);
    }
    return null;
  };

  let observation = await observe();
  if (observationRefusal) return observationRefusal;
  const terminal = await finalize(observation);
  if (terminal) return terminal;
  try {
    await fence.assertCurrent();
    await broadcastRetained(submission, fence);
    await fence.assertCurrent();
  } catch {
    return await resolveDurableProgress() ?? {
      status: "indeterminate",
      reason: "liquidity-tank-broadcast-outcome-uncertain",
    };
  }
  observation = await observe();
  if (observationRefusal) return observationRefusal;
  return await finalize(observation) ?? {
    status: "indeterminate",
    reason: "liquidity-tank-status-transition-unresolved",
  };
}

interface MemoryTankRecord {
  intent: Readonly<LiquidityTankIntent>;
  lease: LiquidityTankLease;
  submission?: Readonly<LiquidityTankPreparedSubmission>;
  submissionRecordedAt?: number;
  observation?: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>>;
  recoveryFailure?: Extract<LiquidityTankRecoveryEvidence, { status: "failed-after-lock" }>;
  recoveryExpired?: LiquidityTankRecoveryEvidence;
  settlement?: Readonly<LiquidityTankSettlement>;
}

function observationRank(status: Exclude<LiquidityTankObservation, { status: "indeterminate" }>["status"]): number {
  if (status === "empty" || status === "capacity-unavailable") return 0;
  if (status === "pending") return 1;
  return 2;
}

export interface InMemoryLiquidityTankStoreOptions {
  /**
   * Confirms the caller knows this store keeps every row in process memory
   * and loses it on restart. Required, and only `true` is accepted.
   */
  readonly acknowledgeVolatile: true;
}

function acknowledgesVolatile(options: unknown): boolean {
  if (options === null || typeof options !== "object" || isProxy(options)) return false;
  const acknowledged = getOwnPropertyDescriptor(options, "acknowledgeVolatile");
  return acknowledged !== undefined && hasOwn(acknowledged, "value") && acknowledged.value === true;
}

/**
 * Reference store for tests and development. It is not restart-safe: every
 * row lives in process memory, so after a restart a worker finds no retained
 * submission, signs and broadcasts a second bridge operation, and locks the
 * buyer's funds twice. Restart safety needs a durable, atomic host store that
 * passes `runLiquidityTankStoreConformance`. Refuses to construct unless the
 * caller passes `{ acknowledgeVolatile: true }`.
 */
export function createInMemoryLiquidityTankStore(
  options: InMemoryLiquidityTankStoreOptions,
): LiquidityTankStore {
  if (!acknowledgesVolatile(options)) {
    throw new TypeError(
      "createInMemoryLiquidityTankStore keeps all state in process memory and loses it on " +
        "restart: a restarted worker would prepare and broadcast a second bridge operation " +
        "and double-lock the buyer's funds. Pass { acknowledgeVolatile: true } only in tests " +
        "or development; production needs a durable, atomic store that passes " +
        "runLiquidityTankStoreConformance.",
    );
  }
  const records = new Map<string, MemoryTankRecord>();
  const bridgeOwners = new Map<string, string>();
  const current = (
    record: MemoryTankRecord | undefined,
    input: { bindingHash: string; owner: string; generation: number },
  ): record is MemoryTankRecord => record !== undefined &&
    record.intent.bindingHash === input.bindingHash && record.lease.owner === input.owner &&
    record.lease.generation === input.generation;
  /** Ordinary writes re-check lease expiry at the caller's `now`, as claims and the fence do. */
  const leaseExpired = (record: MemoryTankRecord, now: unknown): boolean =>
    record.lease.expiresAt <= requireUInt(now, "write now");
  return {
    async claim(input) {
      const expiresAt = leaseExpiry(
        requireUInt(input.now, "claim now"),
        requireUInt(input.leaseDurationMs, "claim leaseDurationMs", true),
      );
      const existing = records.get(input.intent.settlementKey);
      if (existing) {
        if (existing.intent.bindingHash !== input.intent.bindingHash) {
          return { status: "conflict", reason: "liquidity-tank-settlement-binding-conflict" };
        }
        if (existing.settlement) {
          return { status: "settled", intent: existing.intent, settlement: existing.settlement };
        }
        if (existing.recoveryExpired) {
          if (!existing.submission || existing.submissionRecordedAt === undefined) {
            return { status: "corrupt", reason: "liquidity-tank-recovery-expiry-missing-submission" };
          }
          return {
            status: "recovery-expired",
            intent: existing.intent,
            submission: existing.submission,
            submissionRecordedAt: existing.submissionRecordedAt,
            observation: existing.recoveryExpired,
          };
        }
        if (existing.lease.expiresAt > input.now) {
          return {
            status: "waiting",
            intent: existing.intent,
            lease: { ...existing.lease },
            ...(existing.submission === undefined
              ? {}
              : { submission: existing.submission, submissionRecordedAt: existing.submissionRecordedAt }),
            ...(existing.observation === undefined
              ? {}
              : { observation: existing.observation }),
            ...(existing.recoveryFailure === undefined ? {} : { recoveryFailure: existing.recoveryFailure }),
          };
        }
        const generation = existing.lease.generation + 1;
        if (!isSafeInteger(generation)) {
          return { status: "corrupt", reason: "liquidity-tank-lease-generation-exhausted" };
        }
        const lease = {
          owner: input.owner,
          generation,
          expiresAt,
        };
        existing.lease = lease;
        return {
          status: "acquired",
          intent: existing.intent,
          lease: { ...lease },
          ...(existing.submission === undefined
            ? {}
            : { submission: existing.submission, submissionRecordedAt: existing.submissionRecordedAt }),
          ...(existing.observation === undefined
            ? {}
            : { observation: existing.observation }),
          ...(existing.recoveryFailure === undefined ? {} : { recoveryFailure: existing.recoveryFailure }),
        };
      }
      const record: MemoryTankRecord = {
        intent: input.intent,
        lease: { owner: input.owner, generation: 1, expiresAt },
      };
      records.set(input.intent.settlementKey, record);
      return { status: "acquired", intent: record.intent, lease: { ...record.lease } };
    },
    async isCurrent(input) {
      const record = records.get(input.settlementKey);
      return current(record, input) && record.lease.expiresAt > input.now &&
        !record.settlement && !record.recoveryExpired;
    },
    async recordSubmission(input) {
      const record = records.get(input.settlementKey);
      if (!current(record, input)) return { status: "stale", reason: "stale-lease" };
      if (leaseExpired(record, input.now)) return { status: "stale", reason: "expired-lease" };
      if (record.settlement || record.recoveryExpired) {
        return { status: "conflict", reason: "liquidity-tank-submission-after-terminal" };
      }
      const bridgeOwner = bridgeOwners.get(input.submission.bridgeId);
      if (bridgeOwner && bridgeOwner !== input.settlementKey) {
        return { status: "conflict", reason: "liquidity-tank-bridge-cross-settlement-reuse" };
      }
      if (record.submission) {
        return record.submission.submissionHash === input.submission.submissionHash
          ? { status: "existing" }
          : { status: "conflict", reason: "liquidity-tank-submission-replacement-forbidden" };
      }
      record.submission = Object.freeze({ ...input.submission });
      // Validated by the lease check above; kept with the submission it receipts.
      record.submissionRecordedAt = input.now;
      bridgeOwners.set(input.submission.bridgeId, input.settlementKey);
      return { status: "recorded" };
    },
    async recordObservation(input) {
      const record = records.get(input.settlementKey);
      if (!current(record, input)) return { status: "stale", reason: "stale-lease" };
      if (leaseExpired(record, input.now)) return { status: "stale", reason: "expired-lease" };
      if (record.settlement || record.recoveryExpired) {
        return { status: "conflict", reason: "liquidity-tank-observation-after-terminal" };
      }
      if (!record.submission || input.observation.bridgeId !== record.submission.bridgeId) {
        return { status: "conflict", reason: "liquidity-tank-observation-bridge-conflict" };
      }
      let observation: Exclude<LiquidityTankObservation, { status: "indeterminate" }>;
      try {
        observation = validateRetainedObservation(
          input.observation,
          record.intent,
          record.submission,
        );
      } catch {
        return { status: "conflict", reason: "liquidity-tank-observation-invalid" };
      }
      if (observation.status === "completed" &&
          observation.finalityObservedAt >= observation.recoveryDeadline) {
        return { status: "conflict", reason: "liquidity-tank-completion-after-recovery-deadline" };
      }
      const prior = record.observation;
      if (record.recoveryFailure && observation.status !== "completed") {
        return { status: "conflict", reason: "liquidity-tank-terminal-failure-retained" };
      }
      if (prior) {
        if (canonicalize(prior) === canonicalize(observation)) return { status: "existing" };
        if (!preservesRecoveryCheckpoint(prior, observation) ||
            observationRank(observation.status) < observationRank(prior.status)) {
          return { status: "conflict", reason: "liquidity-tank-status-regression" };
        }
        if (observationRank(observation.status) === observationRank(prior.status) &&
            observation.status !== "pending" &&
            !(["empty", "capacity-unavailable"].includes(prior.status) &&
              ["empty", "capacity-unavailable"].includes(observation.status))) {
          return { status: "conflict", reason: "liquidity-tank-terminal-status-conflict" };
        }
      }
      record.observation = observation;
      if (observation.status === "completed") delete record.recoveryFailure;
      return { status: "recorded" };
    },
    async recordRecoveryFailure(input) {
      const record = records.get(input.settlementKey);
      if (!current(record, input)) return { status: "stale", reason: "stale-lease" };
      if (record.settlement || record.recoveryExpired) {
        return { status: "conflict", reason: "liquidity-tank-observation-after-terminal" };
      }
      if (!record.submission) {
        return { status: "conflict", reason: "liquidity-tank-observation-bridge-conflict" };
      }
      let evidence: LiquidityTankRecoveryEvidence;
      try {
        evidence = validateRecoveryEvidence(input.recoveryFailure, record.intent, record.submission);
        const failureNow = requireUInt(input.now, "failure retention now");
        if (record.lease.expiresAt <= failureNow) return { status: "stale", reason: "expired-lease" };
      } catch {
        return { status: "conflict", reason: "liquidity-tank-recovery-evidence-invalid" };
      }
      if (evidence.status !== "failed-after-lock" || !recoveryCheckpoint(record.observation) ||
          canonicalize(record.observation) !== canonicalize(evidence.checkpoint)) {
        return { status: "conflict", reason: "liquidity-tank-recovery-checkpoint-cas-failed" };
      }
      if (record.recoveryFailure) {
        return canonicalize(record.recoveryFailure) === canonicalize(evidence)
          ? { status: "existing", recoveryFailure: record.recoveryFailure }
          : { status: "conflict", reason: "liquidity-tank-recovery-failure-conflict" };
      }
      record.recoveryFailure = evidence;
      return { status: "recorded", recoveryFailure: evidence };
    },
    async recordRecoveryExpired(input) {
      const record = records.get(input.settlementKey);
      if (!current(record, input)) return { status: "stale", reason: "stale-lease" };
      const expiryNow = requireUInt(input.now, "recovery expiry now");
      if (record.lease.expiresAt <= expiryNow) {
        return { status: "stale", reason: "expired-lease" };
      }
      if (record.settlement) {
        return { status: "conflict", reason: "liquidity-tank-recovery-lost-to-settlement" };
      }
      // A durable timely completion has won even before its settlement is
      // written: no later evidence may expire it.
      if (record.observation?.status === "completed") {
        return { status: "conflict", reason: "liquidity-tank-recovery-lost-to-completion" };
      }
      if (record.recoveryExpired) {
        return canonicalize(record.recoveryExpired) === canonicalize(input.observation)
          ? { status: "existing" }
          : { status: "conflict", reason: "liquidity-tank-recovery-expiry-conflict" };
      }
      if (!record.submission) {
        return { status: "conflict", reason: "liquidity-tank-recovery-checkpoint-cas-failed" };
      }
      let evidence: LiquidityTankRecoveryEvidence;
      try {
        evidence = validateRecoveryEvidence(input.observation, record.intent, record.submission);
      } catch {
        return { status: "conflict", reason: "liquidity-tank-recovery-evidence-invalid" };
      }
      // The evidence carries its own authenticated time, so the CAS re-checks
      // it as well as the store clock.
      if (expiryNow < recoveryEvidenceDeadline(evidence) || !provesRecoveryExpiry(evidence)) {
        return { status: "conflict", reason: "liquidity-tank-recovery-expiry-not-due" };
      }
      const expectedObservationMatches = record.observation === undefined
        ? input.expectedObservation === undefined
        : input.expectedObservation !== undefined &&
          canonicalize(record.observation) === canonicalize(input.expectedObservation);
      if (!expectedObservationMatches) {
        return { status: "conflict", reason: "liquidity-tank-recovery-checkpoint-cas-failed" };
      }
      const priorCheckpoint = recoveryCheckpoint(record.observation);
      if (evidence.status === "pending") {
        if (canonicalize(record.observation) !== canonicalize(evidence)) {
          return { status: "conflict", reason: "liquidity-tank-recovery-checkpoint-cas-failed" };
        }
      } else if (evidence.status === "completed") {
        if (priorCheckpoint &&
            (evidence.lockTxHash !== priorCheckpoint.lockTxHash ||
              evidence.recoveryDeadline !== priorCheckpoint.recoveryDeadline)) {
          return { status: "conflict", reason: "liquidity-tank-recovery-checkpoint-cas-failed" };
        }
      } else if (!priorCheckpoint ||
          canonicalize(priorCheckpoint) !== canonicalize(evidence.checkpoint) ||
          !record.recoveryFailure || canonicalize(record.recoveryFailure) !== canonicalize(evidence)) {
        return { status: "conflict", reason: "liquidity-tank-recovery-checkpoint-cas-failed" };
      }
      record.recoveryExpired = evidence;
      return { status: "recorded" };
    },
    async recordSettlement(input) {
      const record = records.get(input.settlementKey);
      if (!current(record, input)) return { status: "stale", reason: "stale-lease" };
      if (leaseExpired(record, input.now)) return { status: "stale", reason: "expired-lease" };
      if (record.recoveryExpired) {
        return { status: "conflict", reason: "liquidity-tank-settlement-lost-to-recovery-expiry" };
      }
      if (record.observation?.status !== "completed") {
        return { status: "conflict", reason: "liquidity-tank-settlement-before-completion" };
      }
      const expectedSettlement = settlementFromCompletedObservation(
        record.intent,
        record.observation,
      );
      if (canonicalize(input.settlement) !== canonicalize(expectedSettlement)) {
        return { status: "conflict", reason: "liquidity-tank-settlement-evidence-conflict" };
      }
      if (record.settlement) {
        return canonicalize(record.settlement) === canonicalize(input.settlement)
          ? { status: "existing" }
          : { status: "conflict", reason: "liquidity-tank-settlement-conflict" };
      }
      record.settlement = Object.freeze({ ...input.settlement });
      return { status: "recorded" };
    },
  };
}

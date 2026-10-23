import { hash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { canonicalize, sha256Hex } from "../canonical/index.js";
import {
  snapshotCanonicalJson,
  snapshotCanonicalJsonRead,
} from "../canonical/snapshot.js";
import type { RailDefinition } from "../registry/types.js";
import { DacsError } from "../errors.js";
import { isProductionTankStore, isSourceFinalityVerifier } from "./liquidityTankCapabilities.js";

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
const stringToLowerCase = String.prototype.toLowerCase;
// One-shot: no `Hash` object whose symbol-keyed handle slot a prototype
// accessor could intercept.
const oneShotHash = hash;

const HASH_RE = /^[0-9a-f]{64}$/;
/**
 * The bridge's operation ID. §9.5.5's prose calls it a 16-character hash, but
 * the pinned Standard's `txref-liquidity-tank` vector uses `"tank-308"`, and
 * the Demos native-bridge branches derive `bridge_` plus 16 or 64 hex
 * characters. So any 1-128 characters from this URL-safe set are accepted;
 * the core only ever compares the ID exactly.
 */
const BRIDGE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** Prefix on an adapter's own `indeterminate` reason. */
const ADAPTER_REASON_PREFIX = "liquidity-tank-adapter-indeterminate: ";
/** CORE §B.1 canonical job ID, as in `negotiate/jobId.ts`. */
const CANONICAL_JOB_ID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
/** CD-1 plain decimal (CORE §B.2): integer and fraction digits, at most one dot. */
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
const DEFAULT_PENDING_LOCK_DEADLINE_MS = 600_000;
/**
 * How far a submission's `preparedAt` may sit from this host's clock readings
 * around preparation and from the receipt stored with it, and how far a bridge
 * time may fall before it: room for clock skew between the adapter, the bridge
 * and the host, while a seconds-scale value is decades outside it.
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
 * A verifier hook's answer: `true` accepts, `"unavailable"` says the hook
 * could not decide now (its key, attestation service or decoder is down or
 * timed out); `"pending-finality"` is a normal finality wait. Anything else,
 * `false` included, refuses. A throw counts as `"unavailable"`.
 */
export type LiquidityTankVerifierAnswer = boolean | "unavailable" | "pending-finality";

/**
 * Host checks the core cannot make itself. Both are required: when one is
 * missing the core refuses before any claim. The core uses a checked value
 * only when the hook answers literal `true`. `"unavailable"` (or a throw) is
 * an outage: the core acts on nothing it could not check, returns the
 * retryable `liquidity-tank-verifier-unavailable` or a durable lock's progress,
 * and keeps fresh signed bytes it could not check without broadcasting them,
 * so a retry re-checks those bytes instead of signing new ones. Any other
 * answer is a refusal. The core sets no timeout, so each hook must settle
 * within its own bounded deadline, well under a minute; a hook that never
 * settles hangs the call. Bundled filesystem settled rows recheck the retained
 * submission and a fresh authenticated completion before returning success.
 * Production execution is disabled until a reviewed integration is shipped.
 */
export interface LiquidityTankVerifier {
  /**
   * Authenticates one bridge observation, whether the adapter just returned it
   * or the store retained it: status, history, bridge ID, operation hash, lock
   * and release hashes, timestamps and `recoveryDeadline`, against the bridge's
   * own authenticated record (for example a pinned bridge key or attestation).
   * It must not accept an observation that carries `lockTxHash` before that
   * source lock has reached finality under the rail's finality model (ST-8):
   * answer `"pending-finality"` while it is waiting. Production requires
   * createLiquidityTankEvmFinalityVerifier, which enforces this rule.
   */
  authenticateObservation(input: Readonly<{
    intent: Readonly<LiquidityTankIntent>;
    submission: Readonly<LiquidityTankPreparedSubmission>;
    observation: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>>;
  }>): Promise<LiquidityTankVerifierAnswer> | LiquidityTankVerifierAnswer;
  /**
   * Decodes `signedSubmissionBase64` and confirms it signs exactly this
   * intent: source amount in base units, origin and destination addresses,
   * asset, tank pair and the submission's `bridgeId`, and that
   * `substrateTxHash` is recomputed from those bytes. Called before a prepared
   * submission is stored and before a retained one is used. Bytes it refuses
   * are not stored; bytes it could not check are stored but not broadcast.
   */
  verifySignedSubmission(input: Readonly<{
    intent: Readonly<LiquidityTankIntent>;
    submission: Readonly<LiquidityTankPreparedSubmission>;
  }>): Promise<LiquidityTankVerifierAnswer> | LiquidityTankVerifierAnswer;
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
 * locked pending checkpoint observed after it, a completion finalized after
 * it, a terminal bridge failure bound to the exact lock (retained beside the
 * checkpoint, or, without one, the durable observation itself), or a read
 * that contradicts the durable checkpoint, observed strictly after it and
 * after `recoveryDeadline`, unless it is a `pending` that leaves the
 * operation live: one without a lock, or with another lock observed at or
 * before that lock's own deadline. A release final exactly at
 * `recoveryDeadline` is timely.
 * A failure snapshot must be authenticated strictly after the deadline too.
 * `observedAt` is the bridge's authenticated time of the status snapshot.
 */
export type LiquidityTankRecoveryEvidence = (
  | LiquidityTankRecoveryCheckpoint
  | Readonly<Extract<LiquidityTankObservation, { status: "completed" }>>
  | (Readonly<Extract<LiquidityTankObservation, { status: "failed" }>> & {
      lockTxHash: string;
      recoveryDeadline: number;
    })
  | Readonly<{
      status: "failed-after-lock";
      checkpoint: LiquidityTankRecoveryCheckpoint;
      failure: Readonly<Extract<LiquidityTankObservation, { status: "failed" }>> & {
        lockTxHash: string;
        recoveryDeadline: number;
      };
    }>
  | Readonly<{
      status: "contradicted-after-lock";
      checkpoint: LiquidityTankRecoveryCheckpoint;
      contradiction: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>>;
    }>
) & Readonly<{
  /** Authenticated contradictory release; preserves the original expiry and lock. */
  completion?: Readonly<Extract<LiquidityTankObservation, { status: "completed" }>>;
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
      submission?: Readonly<LiquidityTankPreparedSubmission>;
      submissionRecordedAt?: number;
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
 * Store contract declaration. Outside explicit NODE_ENV=development/test,
 * the core also requires the exact immutable store returned by
 * createFsLiquidityTankStore; a declaration or copied handle cannot grant
 * production execution. Custom stores remain available for conformance tests.
 * A volatile store requires acknowledgeVolatile and explicit development/test
 * mode; an absent or unknown environment refuses it before any claim.
 */
export type LiquidityTankStoreRestartSafety = "conformance-tested" | "volatile-acknowledged";

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
   * Required by the core at run time, as a data property: without one of the
   * two values it returns `indeterminate`
   * `liquidity-tank-store-restart-safety-undeclared` before any claim.
   * Production also requires the SDK-created filesystem store capability.
   */
  readonly restartSafety?: LiquidityTankStoreRestartSafety;
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
   * if one existed. `now` must be after `recoveryDeadline`. Pending snapshots
   * also need `observedAt > recoveryDeadline`; completions need
   * `finalityObservedAt > recoveryDeadline` (one final at the deadline is
   * timely). Terminal failure evidence must describe a post-deadline bridge
   * snapshot and bind its authenticated lock hash/deadline to the exact durable
   * checkpoint. Beside a retained failure, a refreshed authenticated snapshot
   * may postdate that failure without replacing the retained original. A contradiction needs the exact durable
   * checkpoint and no retained failure, must be observed after the
   * checkpoint and after `recoveryDeadline`, and must not be a `pending`
   * that leaves the operation live.
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
  /**
   * Atomically reconciles this exact expiry with an authenticated completion.
   * For the same lock/deadline, timely completion settles and late completion
   * retains recovery-expired. A different lock/deadline enriches the original
   * expiry with `completion`, preserving its lock and classification. Existing
   * completion facts cannot be replaced. Never submits bytes.
   */
  reconcileRecoveryExpired?(input: {
    settlementKey: string;
    bindingHash: string;
    expectedEvidence: LiquidityTankRecoveryEvidence;
    completion: Readonly<Extract<LiquidityTankObservation, { status: "completed" }>>;
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
  | {
      status: "waiting" | "indeterminate";
      reason: string;
      /**
       * Set with waiting `liquidity-tank-pending`, its bridge/verifier outages, or
       * `liquidity-tank-source-finality-pending`: Unix milliseconds by which
       * the bridge should have locked, the submission's receipt (`submissionRecordedAt`)
       * plus `pendingLockDeadlineMs`.
       */
      pendingDeadline?: number;
      /**
       * Set exactly with `pendingDeadline`: the host clock read during this
       * call was at or after it. Alert if this persists rather than polling
       * silently.
       */
      pastDeadline?: boolean;
    }
  | {
      status: "failed";
      errorClass: "permanent" | "failed-substrate";
      reason: string;
      reputationNeutral?: true;
      /**
       * Set exactly when `errorClass` is `failed-substrate`: the lock this
       * expiry ends, in a `settle-asymmetric` result's `txRef` shape. The
       * interim record (DACS-5 SEB-3) names this lock. An expiry can be the
       * first result a host sees, so a phase that has not anchored the interim
       * record anchors it from this.
       */
      lockTxRef?: Readonly<{
        kind: "liquidity-tank";
        bridgeId: string;
        sourceChainId: number;
        destChainId: number;
        lockTxHash: string;
        recoveryDeadline: number;
      }>;
      /**
       * Set exactly when `reason` is `tank-released-after-recovery-deadline`:
       * the authenticated completion that finalized after
       * `recoveryDeadline`. The phase is `failed-substrate`, but the release
       * reached the payee, so the buyer has paid: do not authorize another
       * payment for the phase, and reconcile from this evidence. Also set
       * when `reason` is `tank-lock-contradicted-recovery-expired` and the
       * contradicting read was a completion of another lock: the bridge
       * reports that release reached the payee, so treat it the same way.
       */
      txRef?: Readonly<{
        kind: "liquidity-tank";
        bridgeId: string;
        sourceChainId: number;
        destChainId: number;
        lockTxHash: string;
        releaseTxHash: string;
        recoveryDeadline: number;
      }>;
      /** Unix milliseconds; set exactly with `txRef`. */
      finalityObservedAt?: number;
    }
  | {
      status: "settle-asymmetric";
      reason: "tank-locked-unreleased" | "lock-contradicted";
      /** Exact Unix-millisecond timestamp from the authenticated checkpoint. */
      recoveryDeadline: number;
      /**
       * The host clock read during this call was after `recoveryDeadline` but
       * no expiry evidence was accepted. The lock is overdue: alert if this
       * persists rather than polling silently. At the deadline itself a
       * release is still timely, so this is `false` there.
       */
      pastDeadline: boolean;
      /**
       * Set when this call's authenticated bridge status could not move the
       * lock: `failed` is retained evidence, expiring only with a bridge
       * snapshot and host clock strictly past `recoveryDeadline`; `conflicting` contradicts the
       * checkpoint. Once the host clock passes the deadline, a contradiction
       * observed after the checkpoint and after the deadline expires the
       * lock as `tank-lock-contradicted-recovery-expired`, unless it is a
       * `pending` that leaves the operation live (without a lock, or with
       * another lock observed at or before that lock's own deadline). Past
       * the deadline such a read, or one observed at or before the deadline
       * or at or before the checkpoint, reports `lock-contradicted`: the lock
       * is still open, so do not pay for the phase again, and it needs an
       * operator.
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

type LiquidityTankLockTxRef = NonNullable<Extract<LiquidityTankProgress, { status: "failed" }>["lockTxRef"]>;

/**
 * What a host phase handler records for one progress result, in DACS terms
 * (DACS-4 PC-3, PC-4 and §9.5.5; DACS-5 ST-8 and SEB-3). The core's
 * `errorClass: "failed-substrate"` and its three expiry reasons are not DACS
 * values: an expiry is `errorClass: "substrate"`, its evidence is the interim
 * record (reason `tank-locked-unreleased`, `interimTxRef`), and the bundle
 * records the cause `failed-substrate`; the core's reason is kept only as
 * `progressReason`. The interim record is write-once at the PC-2 address:
 * anchor it from `interimTxRef` if the phase has not, then fail the phase.
 * `release` is set when the bridge reports a release reached the payee after
 * the deadline: the buyer has paid, so never authorize another payment for
 * the phase, and reconcile from it. `none` means there is no phase result
 * yet: retry or escalate by `reason`.
 */
export type LiquidityTankPhaseOutcome =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "interim";
      evidenceOutcome: "failure";
      evidenceReason: "tank-locked-unreleased";
      interimTxRef: LiquidityTankLockTxRef;
    }>
  | Readonly<{ kind: "result"; ok: true; evidenceOutcome: "success" }>
  | Readonly<{
      kind: "result";
      ok: false;
      errorClass: "substrate";
      evidenceOutcome: "failure";
      evidenceReason: "tank-locked-unreleased";
      interimTxRef: LiquidityTankLockTxRef;
      bundleCause: "failed-substrate";
      progressReason: string;
      release?: Readonly<{
        txRef: NonNullable<Extract<LiquidityTankProgress, { status: "failed" }>["txRef"]>;
        finalityObservedAt: number;
      }>;
    }>
  | Readonly<{ kind: "result"; ok: false; errorClass: "permanent"; progressReason: string }>;

/**
 * Throws a `DacsError` for a `failed-substrate` progress without `lockTxRef`,
 * or with `txRef` but no `finalityObservedAt`: the core never returns one, and
 * no admissible interim record can be built from it.
 */
export function liquidityTankPhaseOutcome(progress: LiquidityTankProgress): LiquidityTankPhaseOutcome {
  if (progress.status === "settled") return { kind: "result", ok: true, evidenceOutcome: "success" };
  // A contradicted lock is still open: the interim record stands.
  if (progress.status === "settle-asymmetric") {
    return {
      kind: "interim", evidenceOutcome: "failure", evidenceReason: "tank-locked-unreleased",
      interimTxRef: progress.txRef,
    };
  }
  if (progress.status === "failed") {
    if (progress.errorClass !== "failed-substrate") {
      return { kind: "result", ok: false, errorClass: "permanent", progressReason: progress.reason };
    }
    if (progress.lockTxRef === undefined ||
        (progress.txRef !== undefined && progress.finalityObservedAt === undefined)) {
      throw new DacsError("pay-cross-chain-liquidity-tank: failed-substrate progress lacks its lock evidence");
    }
    return {
      kind: "result", ok: false, errorClass: "substrate", evidenceOutcome: "failure",
      evidenceReason: "tank-locked-unreleased", interimTxRef: progress.lockTxRef,
      bundleCause: "failed-substrate", progressReason: progress.reason,
      ...(progress.txRef === undefined
        ? {}
        : { release: { txRef: progress.txRef, finalityObservedAt: progress.finalityObservedAt as number } }),
    };
  }
  return { kind: "none" };
}

export interface AdvanceLiquidityTankInput {
  authority: Readonly<LiquidityTankAuthority>;
  owner: string;
  store: LiquidityTankStore;
  adapter: LiquidityTankAdapter;
  verifier: LiquidityTankVerifier;
  /**
   * Trusted, independent resolution of the pinned descriptor, agreement and
   * SR-5 binding. Return the complete authorized authority, after verifying
   * those artifacts, the route's exact tank pair, amount/currency and the
   * agreement's destination semantics (including PB-1/PB-2 when applicable).
   * Required outside explicit development/test mode; never echo unverified input.
   */
  resolveAuthority?: (intent: Readonly<LiquidityTankIntent>) => Promise<Readonly<{
    authority: Readonly<LiquidityTankAuthority>;
    rail: Pick<RailDefinition, "railId" | "railType" | "phaseHandler" | "asset" | "network">;
  }> | "unavailable">;
  now?: () => number;
  leaseDurationMs?: number;
  /**
   * How long after a submission was first recorded the bridge may keep it
   * pending without a source lock before progress reports `pastDeadline`.
   * A positive safe integer of milliseconds; 10 minutes by default.
   */
  pendingLockDeadlineMs?: number;
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
      fields[key] = key === "jobId" ? value : normalizeNfc(value);
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
 * The recovery window includes `recoveryDeadline` itself: a release final at
 * that millisecond is "within" it (DACS-4 §9.5.5), and the window "passes"
 * (DACS-5 ST-8) only after it. So a finality, a bridge snapshot or a host
 * clock reading shows the deadline missed only when it is strictly later.
 */
function pastRecoveryDeadline(time: number, recoveryDeadline: number): boolean {
  return time > recoveryDeadline;
}

/**
 * A bridge time too far before the submission it describes, such as one sent
 * in seconds; `reason` names the field.
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
 * submission was prepared by more than the clock skew allowed between the
 * adapter that stamped `preparedAt` and the bridge. No unit heuristic: a
 * seconds-scale value is refused, not converted.
 */
function afterPreparation(
  time: number,
  submission: Readonly<LiquidityTankPreparedSubmission>,
  reason: string,
  label: string,
): number {
  if (time < submission.preparedAt - PREPARATION_CLOCK_SKEW_MS) {
    throw new BeforePreparationError(reason, label);
  }
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
  if (pastRecoveryDeadline(finalityObservedAt, recoveryDeadline)) {
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
 * load before the shared snapshot runs, except jobId, whose raw ASCII bytes
 * must pass JID-1 without normalization. A polluted `Object.prototype` cannot
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
  requireJobId(authority.jobId);
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

/** The interim record's txRef for a lock: its hash and deadline, no release. */
function lockTxRef(
  intent: Readonly<LiquidityTankIntent>,
  lock: Readonly<{ bridgeId: string; lockTxHash: string; recoveryDeadline: number }>,
): LiquidityTankLockTxRef {
  return Object.freeze({
    kind: "liquidity-tank" as const,
    bridgeId: lock.bridgeId,
    sourceChainId: intent.sourceChainId,
    destChainId: intent.destinationChainId,
    lockTxHash: lock.lockTxHash,
    recoveryDeadline: lock.recoveryDeadline,
  });
}

/**
 * The progress of a durable lock: a locked pending checkpoint, or a failure
 * that carries the lock it failed after, which is that lock's terminal
 * evidence (`bridgeStatus: "failed"`).
 */
function progressFromDurableObservation(
  intent: Readonly<LiquidityTankIntent>,
  observation: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>> | undefined,
  now: number,
  bridgeStatus?: "failed" | "conflicting",
): LiquidityTankProgress | null {
  const lock = recoveryCheckpoint(observation) ?? lockBearingFailure(observation);
  if (!lock) return null;
  const status = lock.status === "failed" ? "failed" : bridgeStatus;
  return {
    status: "settle-asymmetric",
    reason: status === "conflicting" && pastRecoveryDeadline(now, lock.recoveryDeadline)
      ? "lock-contradicted" : "tank-locked-unreleased",
    recoveryDeadline: lock.recoveryDeadline,
    pastDeadline: pastRecoveryDeadline(now, lock.recoveryDeadline),
    ...(status === undefined ? {} : { bridgeStatus: status }),
    txRef: lockTxRef(intent, lock),
  };
}

function recoveryCheckpoint(
  observation: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>> | undefined,
): LiquidityTankRecoveryCheckpoint | undefined {
  return observation?.status === "pending" && observation.lockTxHash !== undefined &&
      observation.recoveryDeadline !== undefined
    ? observation as LiquidityTankRecoveryCheckpoint
    : undefined;
}

type LiquidityTankLockBearingFailure = Extract<LiquidityTankRecoveryEvidence, { status: "failed-after-lock" }>["failure"];

/** A terminal failure that carries the authenticated lock it failed after. */
function lockBearingFailure(
  observation: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>> | undefined,
): LiquidityTankLockBearingFailure | undefined {
  return observation?.status === "failed" && observation.lockTxHash !== undefined &&
      observation.recoveryDeadline !== undefined
    ? observation as LiquidityTankLockBearingFailure
    : undefined;
}

/**
 * A read that contradicts the checkpoint: anything but its own lock and
 * deadline pending, completed or failed. A completion of another lock is one.
 */
function contradictsCheckpoint(
  observation: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>>,
  checkpoint: LiquidityTankRecoveryCheckpoint,
): boolean {
  return !preservesRecoveryCheckpoint(checkpoint, observation) && !failedAfterLock(observation, checkpoint);
}

/**
 * A `pending` the bridge reports as still live: without a lock the bridge may
 * still lock it, and another lock may still be released until its own
 * deadline, that millisecond included. Such a contradiction never expires the
 * checkpoint's lock.
 */
function leavesOperationLive(
  contradiction: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>>,
): boolean {
  return contradiction.status === "pending" &&
    (contradiction.recoveryDeadline === undefined ||
      !pastRecoveryDeadline(contradiction.observedAt, contradiction.recoveryDeadline));
}

/**
 * A contradiction observed strictly after the checkpoint. An older or equal
 * read, a cached one included, may describe the bridge before the lock and
 * says nothing about whether the lock was released, so it never expires it.
 */
function postdatesCheckpoint(
  contradiction: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>>,
  checkpoint: LiquidityTankRecoveryCheckpoint,
): boolean {
  return contradiction.observedAt > checkpoint.observedAt;
}

/**
 * A contradiction the bridge stamped after the lock's deadline. One stamped
 * at or before it says nothing about the deadline, since the lock may still
 * be released between that read and it, so it never expires the lock: this
 * host's clock, however late, never stands in for the bridge's.
 */
function passesRecoveryDeadline(
  contradiction: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>>,
  checkpoint: LiquidityTankRecoveryCheckpoint,
): boolean {
  return pastRecoveryDeadline(contradiction.observedAt, checkpoint.recoveryDeadline);
}

function failedAfterLock(
  observation: Readonly<LiquidityTankObservation>,
  checkpoint: LiquidityTankRecoveryCheckpoint,
): observation is Extract<LiquidityTankRecoveryEvidence, { status: "failed-after-lock" }>["failure"] {
  return observation.status === "failed" && transactionHashIdentity(observation.lockTxHash ?? "") === transactionHashIdentity(checkpoint.lockTxHash) &&
    observation.recoveryDeadline === checkpoint.recoveryDeadline;
}

function recoveryEvidenceDeadline(evidence: LiquidityTankRecoveryEvidence): number {
  return evidence.status === "failed-after-lock" || evidence.status === "contradicted-after-lock"
    ? evidence.checkpoint.recoveryDeadline
    : evidence.recoveryDeadline;
}

/**
 * Pending snapshots must describe the bridge after the deadline, and a
 * completion must have finalized after it; a terminal non-completion bound to
 * the exact lock must also describe a post-deadline bridge snapshot. So does a contradiction of the lock
 * observed strictly after the checkpoint and, like a pending snapshot, after
 * the deadline, except a `pending` that leaves the operation live. The core's
 * finalize, the store CAS and the claim replay all decide here; the host-clock
 * deadline is checked separately by each.
 */
function provesRecoveryExpiry(evidence: LiquidityTankRecoveryEvidence): boolean {
  if (evidence.status === "completed") {
    return pastRecoveryDeadline(evidence.finalityObservedAt, evidence.recoveryDeadline);
  }
  if (evidence.status === "failed") return lockBearingFailure(evidence) !== undefined &&
    pastRecoveryDeadline(evidence.observedAt, evidence.recoveryDeadline!);
  if (evidence.status === "contradicted-after-lock") {
    return contradictsCheckpoint(evidence.contradiction, evidence.checkpoint) &&
      postdatesCheckpoint(evidence.contradiction, evidence.checkpoint) &&
      passesRecoveryDeadline(evidence.contradiction, evidence.checkpoint) &&
      !leavesOperationLive(evidence.contradiction);
  }
  return evidence.status === "pending"
    ? pastRecoveryDeadline(evidence.observedAt, evidence.recoveryDeadline)
    : failedAfterLock(evidence.failure, evidence.checkpoint) &&
      pastRecoveryDeadline(evidence.failure.observedAt, evidence.checkpoint.recoveryDeadline);
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
  if (hasOwn(captured, "completion")) {
    const { completion: rawCompletion, ...original } = captured;
    const evidence = validateRecoveryEvidence(original as LiquidityTankRecoveryEvidence, intent, submission);
    const completion = validateCapturedObservation(rawCompletion!, intent, submission);
    if (completion.status !== "completed" || evidence.status === "completed") {
      throw new DacsError("pay-cross-chain-liquidity-tank: recovery completion is invalid");
    }
    return Object.freeze({ ...evidence, completion });
  }
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
  if (captured.status === "contradicted-after-lock") {
    const checkpoint = validateCapturedObservation(captured.checkpoint, intent, submission);
    const contradiction = validateCapturedObservation(captured.contradiction, intent, submission);
    if (checkpoint.status === "indeterminate" || !recoveryCheckpoint(checkpoint) ||
        contradiction.status === "indeterminate" ||
        !contradictsCheckpoint(contradiction, checkpoint as LiquidityTankRecoveryCheckpoint)) {
      throw new DacsError("pay-cross-chain-liquidity-tank: recovery evidence is invalid");
    }
    return Object.freeze({
      status: "contradicted-after-lock" as const,
      checkpoint: checkpoint as LiquidityTankRecoveryCheckpoint,
      contradiction: contradiction as Extract<
        LiquidityTankRecoveryEvidence,
        { status: "contradicted-after-lock" }
      >["contradiction"],
    });
  }
  const observation = validateCapturedObservation(captured, intent, submission);
  if (observation.status === "completed") return observation;
  const failure = observation.status === "indeterminate" ? undefined : lockBearingFailure(observation);
  if (failure) return failure;
  const checkpoint = observation.status === "indeterminate"
    ? undefined
    : recoveryCheckpoint(observation);
  if (!checkpoint) {
    throw new DacsError("pay-cross-chain-liquidity-tank: recovery evidence is invalid");
  }
  return checkpoint;
}

/** A verifier hook's answer as the core reads it. */
type Verdict = "accepted" | "refused" | "unavailable";

/** The verifier could not decide; nothing it was asked about was used. Retry. */
function verifierUnavailable(): LiquidityTankProgress {
  return { status: "indeterminate", reason: "liquidity-tank-verifier-unavailable" };
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

/**
 * The committed expiry, from the authenticated evidence it committed. A
 * completion finalized after the deadline is still `failed-substrate`,
 * as DACS-4 §9.5.5 requires, but the release did reach the payee: it is
 * reported apart, with the transaction evidence to reconcile from. Every
 * expiry carries the lock it ends (the checkpoint's when there is one), so a
 * host that never saw `settle-asymmetric` can still anchor the interim record.
 */
function recoveryExpiredProgress(
  intent: Readonly<LiquidityTankIntent>,
  evidence: LiquidityTankRecoveryEvidence,
): LiquidityTankProgress {
  const expired = {
    status: "failed" as const,
    errorClass: "failed-substrate" as const,
    reputationNeutral: true as const,
    lockTxRef: lockTxRef(
      intent,
      evidence.status === "failed-after-lock" || evidence.status === "contradicted-after-lock"
        ? evidence.checkpoint
        : evidence,
    ),
  };
  const releaseEvidence = (
    completion: Readonly<Extract<LiquidityTankObservation, { status: "completed" }>>,
  ) => ({
    txRef: Object.freeze({
      kind: "liquidity-tank" as const,
      bridgeId: completion.bridgeId,
      sourceChainId: intent.sourceChainId,
      destChainId: intent.destinationChainId,
      lockTxHash: completion.lockTxHash,
      releaseTxHash: completion.releaseTxHash,
      recoveryDeadline: completion.recoveryDeadline,
    }),
    finalityObservedAt: completion.finalityObservedAt,
  });
  if (evidence.completion) {
    const { completion, ...original } = evidence;
    return { ...recoveryExpiredProgress(intent, original as LiquidityTankRecoveryEvidence), ...releaseEvidence(completion) };
  }
  if (evidence.status === "completed") {
    return { ...expired, reason: "tank-released-after-recovery-deadline", ...releaseEvidence(evidence) };
  }
  if (evidence.status === "contradicted-after-lock") {
    // A lock expired on a read that contradicted it is reported apart: the
    // bridge disagreed with itself, so read its record before paying again.
    // A completion of another lock says a release reached the payee: it is
    // returned with the expiry.
    return {
      ...expired,
      reason: "tank-lock-contradicted-recovery-expired",
      ...(evidence.contradiction.status === "completed" ? releaseEvidence(evidence.contradiction) : {}),
    };
  }
  return { ...expired, reason: "tank-locked-unreleased-recovery-expired" };
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

/** Compare EVM hash bytes without changing the exact authenticated snapshot. */
function transactionHashIdentity(value: string): string {
  return value.length === 66 && matchesPattern(/^0x[0-9a-fA-F]{64}$/, value)
    ? reflectApply(stringToLowerCase, value, []) as string : value;
}

/** Authentication identifies a snapshot, rather than the immutable payment. */
function sameSettlementFacts(
  left: Readonly<LiquidityTankSettlement>,
  right: Readonly<LiquidityTankSettlement>,
): boolean {
  const { authenticationHash: _leftProof, ...leftFacts } = left;
  const { authenticationHash: _rightProof, ...rightFacts } = right;
  const facts = (value: typeof leftFacts) => ({ ...value, txRef: { ...value.txRef,
    lockTxHash: transactionHashIdentity(value.txRef.lockTxHash),
    releaseTxHash: transactionHashIdentity(value.txRef.releaseTxHash),
  } });
  return canonicalize(facts(leftFacts)) === canonicalize(facts(rightFacts));
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
    return transactionHashIdentity(next.lockTxHash ?? "") === transactionHashIdentity(prior.lockTxHash) &&
      next.recoveryDeadline === prior.recoveryDeadline;
  }
  return next.status === "completed" && transactionHashIdentity(next.lockTxHash ?? "") === transactionHashIdentity(prior.lockTxHash) &&
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
  let pendingLockDeadlineMs: number;
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
    pendingLockDeadlineMs = requireUInt(
      stableDataProperty(input, "pendingLockDeadlineMs", "pendingLockDeadlineMs") ??
        DEFAULT_PENDING_LOCK_DEADLINE_MS,
      "pendingLockDeadlineMs",
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
  // A store that loses a row after a broadcast makes the next owner sign and
  // broadcast a second operation, and the core cannot tell a lost row from a
  // fresh phase. Production therefore requires the SDK-created durable
  // store capability in addition to the contract declaration. Explicit
  // development/test mode permits injected and acknowledged volatile stores.
  let restartSafety: unknown;
  try {
    restartSafety = stableDataProperty(store, "restartSafety", "store.restartSafety");
  } catch {
    restartSafety = undefined;
  }
  if (restartSafety !== "conformance-tested" && restartSafety !== "volatile-acknowledged") {
    return { status: "indeterminate", reason: "liquidity-tank-store-restart-safety-undeclared" };
  }
  // Volatile storage requires an explicitly declared development/test mode;
  // an absent, unknown or unreadable environment cannot authorize its use.
  if (restartSafety === "volatile-acknowledged" && !allowsVolatileStore()) {
    return { status: "indeterminate", reason: "liquidity-tank-store-volatile-in-production" };
  }
  if (!allowsVolatileStore() && !isProductionTankStore(store)) {
    return { status: "indeterminate", reason: "liquidity-tank-store-untrusted" };
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
  if (!allowsVolatileStore() && !isSourceFinalityVerifier(verifier)) {
    return { status: "indeterminate", reason: "liquidity-tank-source-finality-required" };
  }
  let resolveAuthority: AdvanceLiquidityTankInput["resolveAuthority"];
  try {
    const resolver = stableDataProperty(input, "resolveAuthority", "resolveAuthority");
    if (resolver !== undefined) {
      resolveAuthority = stableBoundMethod<NonNullable<AdvanceLiquidityTankInput["resolveAuthority"]>>(
        input, "resolveAuthority", "resolveAuthority",
      );
    }
  } catch {
    return { status: "indeterminate", reason: "liquidity-tank-authority-resolver-unavailable" };
  }
  if (!resolveAuthority && !allowsVolatileStore()) {
    return { status: "indeterminate", reason: "liquidity-tank-authority-resolver-unavailable" };
  }
  if (resolveAuthority) {
    try {
      const resolved = await resolveAuthority(intent);
      if (resolved === "unavailable") return { status: "indeterminate", reason: "liquidity-tank-authority-resolver-unavailable" };
      // Capture raw jobId before the JSON snapshot can NFC-normalize strings.
      const resolvedIntent = intentFromCapturedAuthority(captureLiquidityTankAuthority(
        stableDataProperty(resolved, "authority", "resolved authority"),
      ));
      const snapshot = snapshotCanonicalJsonRead(resolved, "resolved liquidity-tank authority");
      const rail = snapshot.rail;
      const authorizedRoute = rail.asset.kind === "stablecoin-cross-chain" && rail.asset.routes.some((candidate) =>
        (candidate.sourceChainId === intent.sourceChainId || candidate.sourceChainId === String(intent.sourceChainId)) &&
        (candidate.destChainId === intent.destinationChainId || candidate.destChainId === String(intent.destinationChainId)) &&
        candidate.liquidityTankIds?.includes(intent.sourceLiquidityTankId) &&
        candidate.liquidityTankIds.includes(intent.destinationLiquidityTankId));
      if (canonicalize(resolvedIntent) !== canonicalize(intent) ||
          rail.railId !== intent.railId || rail.railType !== "cross-chain-liquidity-tank" ||
          rail.phaseHandler !== "pay-cross-chain-liquidity-tank" ||
          rail.asset.kind !== "stablecoin-cross-chain" || rail.asset.canonicalSymbol !== intent.currency ||
          rail.network.kind !== "cross-chain" || rail.network.mechanism !== "liquidity-tank" ||
          !authorizedRoute) {
        return { status: "indeterminate", reason: "liquidity-tank-resolved-authority-mismatch" };
      }
    } catch {
      return { status: "indeterminate", reason: "liquidity-tank-authority-resolver-unavailable" };
    }
  }
  // No reviewed Demos adapter/decoder/bridge-release verifier is shipped.
  // Host callbacks and a finalized source receipt cannot establish those
  // guarantees or prevent an effect during preparation before durable storage.
  if (!allowsVolatileStore()) {
    return { status: "indeterminate", reason: "liquidity-tank-production-integration-unavailable" };
  }
  // Only a literal `true` accepts. `"unavailable"` or a throw is an outage: a
  // hook that timed out or lost its key cannot be told from one whose own
  // dependency threw, and an outage acts on nothing the core could not check,
  // so it is never a reason to escalate a forged value. Anything else refuses.
  let pendingSourceFinality = false;
  const verdict = (answer: unknown): Verdict => {
    if (answer === "pending-finality") { pendingSourceFinality = true; return "unavailable"; }
    return answer === true ? "accepted" : answer === "unavailable" ? "unavailable" : "refused";
  };
  let knownReceipt = 0;
  const verifierUnavailable = (): LiquidityTankProgress => pendingSourceFinality ? {
    status: "waiting", reason: "liquidity-tank-source-finality-pending",
    pendingDeadline: Math.min(knownReceipt + pendingLockDeadlineMs, Number.MAX_SAFE_INTEGER),
    pastDeadline: latestNow >= Math.min(knownReceipt + pendingLockDeadlineMs, Number.MAX_SAFE_INTEGER),
  } : { status: "indeterminate", reason: "liquidity-tank-verifier-unavailable" };
  const authenticationResults = new Map<string, Verdict>();
  const authenticated = async (
    submissionValue: Readonly<LiquidityTankPreparedSubmission>,
    observationValue: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>>,
  ): Promise<Verdict> => {
    try {
      const key = canonicalize({ submission: submissionValue, observation: observationValue });
      const prior = authenticationResults.get(key);
      if (prior !== undefined) return prior;
      const answer = verdict(await authenticateObservation(freeze({
        intent, submission: submissionValue, observation: observationValue,
      })));
      authenticationResults.set(key, answer);
      return answer;
    } catch {
      return "unavailable";
    }
  };
  const verified = async (
    submissionValue: Readonly<LiquidityTankPreparedSubmission>,
  ): Promise<Verdict> => {
    try {
      return verdict(await verifySignedSubmission(freeze({ intent, submission: submissionValue })));
    } catch {
      return "unavailable";
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
  knownReceipt = typeof claimSnapshot.submissionRecordedAt === "number" ? claimSnapshot.submissionRecordedAt : claimNow;
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
      const settlement = captureSettlement(settledClaim.settlement, intent);
      if (isProductionTankStore(store)) {
        const savedSubmission = validateRetainedSubmission(settledClaim.submission!, intent);
        const receiptRefusal = retainedReceiptRefusal(settledClaim.submissionRecordedAt, savedSubmission);
        if (receiptRefusal) return { status: "indeterminate", reason: receiptRefusal };
        const signedAnswer = await verified(savedSubmission);
        if (signedAnswer !== "accepted") return signedAnswer === "unavailable" ? verifierUnavailable()
          : { status: "indeterminate", reason: "liquidity-tank-signed-submission-unverified" };
        const observed = validateObservation(await observeSettlement(intent, savedSubmission, freeze({
          owner, settlementKey: intent.settlementKey, bindingHash: intent.bindingHash,
          generation: 0, assertCurrent: async () => {},
        })), intent, savedSubmission);
        if (observed.status !== "completed") return { status: "indeterminate", reason: "liquidity-tank-settlement-reconciliation-unavailable" };
        const answer = await authenticated(savedSubmission, observed);
        if (answer !== "accepted") return answer === "unavailable" ? verifierUnavailable()
          : { status: "indeterminate", reason: "liquidity-tank-observation-unauthenticated" };
        if (!sameSettlementFacts(settlementFromCompletedObservation(intent, observed), settlement)) {
          return { status: "indeterminate", reason: "liquidity-tank-stored-settlement-mismatch" };
        }
      }
      return { status: "settled", settlement };
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
    const expiredSignedAnswer = await verified(expiredSubmission);
    if (expiredSignedAnswer !== "accepted") return expiredSignedAnswer === "unavailable" ? verifierUnavailable()
      : { status: "indeterminate", reason: "liquidity-tank-signed-submission-unverified" };
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
    const { completion: releasedCompletion, ...originalEvidence } = evidence;
    const evidenceObservations: Readonly<
      Exclude<LiquidityTankObservation, { status: "indeterminate" }>
    >[] = evidence.status === "failed-after-lock"
      ? [evidence.checkpoint, evidence.failure]
      : evidence.status === "contradicted-after-lock"
        ? [evidence.checkpoint, evidence.contradiction]
        : [originalEvidence as Exclude<LiquidityTankObservation, { status: "indeterminate" }>];
    if (releasedCompletion) evidenceObservations.push(releasedCompletion);
    // A refusal of any leg outranks an outage on another.
    let expiryUnchecked = false;
    for (let index = 0; index < evidenceObservations.length; index += 1) {
      const answer = await authenticated(
        expiredSubmission,
        evidenceObservations[index] as Exclude<LiquidityTankObservation, { status: "indeterminate" }>,
      );
      if (answer === "refused") {
        return { status: "indeterminate", reason: "liquidity-tank-retained-observation-unauthenticated" };
      }
      if (answer === "unavailable") expiryUnchecked = true;
    }
    if (expiryUnchecked) return verifierUnavailable();
    // Bridge evidence was checked above; the host clock must also have
    // passed the deadline before replaying an expiry.
    if ((evidence.status === "failed-after-lock" || evidence.status === "failed" ||
        evidence.status === "contradicted-after-lock") &&
        !pastRecoveryDeadline(claimNow, recoveryEvidenceDeadline(evidence))) {
      return { status: "indeterminate", reason: "liquidity-tank-recovery-expiry-not-due" };
    }
    if (evidence.status === "completed" || evidence.completion) return recoveryExpiredProgress(intent, evidence);
    // Expiry never authorizes another submission. Reconcile read-only on
    // every replay so a delayed authenticated release can reconcile it.
    let latest: Readonly<LiquidityTankObservation>;
    try {
      latest = validateObservation(await observeSettlement(intent, expiredSubmission, freeze({
        owner, settlementKey: intent.settlementKey, bindingHash: intent.bindingHash,
        generation: 0, assertCurrent: async () => {},
      })), intent, expiredSubmission);
    } catch {
      return recoveryExpiredProgress(intent, evidence);
    }
    if (latest.status === "indeterminate") return recoveryExpiredProgress(intent, evidence);
    const latestAnswer = await authenticated(expiredSubmission, latest);
    if (latestAnswer !== "accepted") return latestAnswer === "unavailable" ? verifierUnavailable()
      : { status: "indeterminate", reason: "liquidity-tank-observation-unauthenticated" };
    const expiredLock = evidence.status === "failed-after-lock" || evidence.status === "contradicted-after-lock"
      ? evidence.checkpoint : evidence;
    if (latest.status === "completed") {
      const sameLock = transactionHashIdentity(latest.lockTxHash) === transactionHashIdentity(expiredLock.lockTxHash) &&
        latest.recoveryDeadline === expiredLock.recoveryDeadline;
      try {
        const reconcile = stableBoundMethod<NonNullable<LiquidityTankStore["reconcileRecoveryExpired"]>>(
          store, "reconcileRecoveryExpired", "store.reconcileRecoveryExpired",
        );
        if (successfulStoreWrite(await reconcile({ settlementKey: intent.settlementKey,
          bindingHash: intent.bindingHash, expectedEvidence: evidence, completion: latest }))) {
          if (!sameLock) return recoveryExpiredProgress(intent, { ...evidence, completion: latest });
          return pastRecoveryDeadline(latest.finalityObservedAt, latest.recoveryDeadline)
            ? recoveryExpiredProgress(intent, latest)
            : { status: "settled", settlement: settlementFromCompletedObservation(intent, latest) };
        }
      } catch { /* uncertain correction must not report failure */ }
      return { status: "indeterminate", reason: "liquidity-tank-expiry-correction-persistence-uncertain" };
    }
    return recoveryExpiredProgress(intent, evidence);
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
  // Set when a hook could not check a retained row: nothing past the retained
  // checks below runs, and only a durable lock's progress is reported.
  let verifierOutage = false;
  // The host-clock reading the store keeps as the submission's receipt.
  let submissionReceipt = 0;
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
    submissionReceipt = claimSnapshot.submissionRecordedAt as number;
    // Retained bytes are re-verified before they are observed against,
    // settled from or rebroadcast. An outage still lets the retained rows
    // below be checked for a refusal and a durable lock be reported.
    const retainedAnswer = await verified(submission);
    if (retainedAnswer === "refused") {
      return { status: "indeterminate", reason: "liquidity-tank-signed-submission-unverified" };
    }
    if (retainedAnswer === "unavailable") verifierOutage = true;
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
    // Bytes that do not sign exactly this intent are neither stored nor
    // broadcast. Bytes the verifier could not check are stored but not
    // broadcast, so a retry re-verifies these bytes instead of signing new
    // ones; the store keeps one submission per phase and refuses another.
    const freshAnswer = await verified(submission);
    if (freshAnswer === "refused") {
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
    submissionReceipt = recordedAt;
    knownReceipt = recordedAt;
    if (freshAnswer === "unavailable") return verifierUnavailable();
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
    const durableAnswer = await authenticated(submission, durableObservation);
    if (durableAnswer === "refused") {
      return { status: "indeterminate", reason: "liquidity-tank-retained-observation-unauthenticated" };
    }
    if (durableAnswer === "unavailable") verifierOutage = true;
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
    const checkpointAnswer = await authenticated(submission, durableFailure.checkpoint);
    const failureAnswer = checkpointAnswer === "refused"
      ? "refused"
      : await authenticated(submission, durableFailure.failure);
    if (checkpointAnswer === "refused" || failureAnswer === "refused") {
      return { status: "indeterminate", reason: "liquidity-tank-retained-observation-unauthenticated" };
    }
    if (checkpointAnswer === "unavailable" || failureAnswer === "unavailable") verifierOutage = true;
  }

  // During an outage the core neither observes, broadcasts, settles nor
  // expires. A durable lock is still reported from its stored checkpoint, so
  // an overdue lock keeps `pastDeadline`; the report moves nothing.
  const pendingTiming = () => {
    const pendingDeadline = Math.min(submissionReceipt + pendingLockDeadlineMs, Number.MAX_SAFE_INTEGER);
    return { pendingDeadline, pastDeadline: latestNow >= pendingDeadline };
  };
  const unlockedPendingTiming = () => durableObservation?.status === "pending" &&
    durableObservation.lockTxHash === undefined ? pendingTiming() : {};
  if (verifierOutage) {
    return progressFromDurableObservation(intent, durableObservation, latestNow) ??
      { ...verifierUnavailable(), ...unlockedPendingTiming() };
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
    // Every non-completion must describe a post-deadline bridge snapshot;
    // a host clock alone never proves the resolving leg missed its window.
    if (!pastRecoveryDeadline(recoveryNow, recoveryEvidenceDeadline(observation)) ||
        !provesRecoveryExpiry(observation)) {
      if (observation.status === "completed") {
        return {
          status: "indeterminate",
          reason: "liquidity-tank-completion-finality-invalid",
        };
      }
      return observation.status === "failed-after-lock"
        ? progressFromDurableObservation(intent, observation.checkpoint, recoveryNow, "failed")
        : observation.status === "contradicted-after-lock"
          ? progressFromDurableObservation(intent, observation.checkpoint, recoveryNow, "conflicting")
          : progressFromDurableObservation(intent, observation, recoveryNow);
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
      ? recoveryExpiredProgress(intent, observation)
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
    return !pastRecoveryDeadline(durableObservation.finalityObservedAt, durableObservation.recoveryDeadline)
      ? await persistSettlement(durableObservation)
      : await persistRecoveryExpired(durableObservation, durableObservation) ?? {
          status: "indeterminate",
          reason: "liquidity-tank-recovery-expiry-persistence-uncertain",
        };
  }

  // Retained terminal evidence survives an unavailable/contradictory read:
  // a failure retained beside the checkpoint, or one that carries its lock
  // and is itself the durable observation. Timely completion is considered
  // first in finalize and can still win.
  const resolveDurableProgress = async (
    bridgeStatus?: "conflicting",
  ): Promise<LiquidityTankProgress | null> => {
    const retainedFailure = durableFailure ?? lockBearingFailure(durableObservation);
    return retainedFailure
      ? persistRecoveryExpired(retainedFailure, durableObservation)
      : progressFromDurableObservation(intent, durableObservation, latestNow, bridgeStatus);
  };

  // An operation the bridge accepted without a lock: bounded from the durable
  // receipt, so a bridge that accepts an operation and never locks it is
  // overdue, not parked.
  const unlockedPendingProgress = (): LiquidityTankProgress => {
    return {
      status: "waiting",
      reason: "liquidity-tank-pending",
      ...pendingTiming(),
    };
  };

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
    if (observed.status !== "indeterminate") {
      const answer = await authenticated(submission, observed);
      if (answer === "refused") {
        observationRefusal = {
          status: "indeterminate",
          reason: "liquidity-tank-observation-unauthenticated",
        };
        return unavailable;
      }
      // Read like an unavailable bridge: durable progress, or a retry.
      if (answer === "unavailable") {
        if (pendingSourceFinality) observationRefusal = verifierUnavailable();
        return { status: "indeterminate", reason: "liquidity-tank-verifier-unavailable" };
      }
    }
    try {
      await fence.assertCurrent();
    } catch {
      return unavailable;
    }
    // The adapter's own reason goes out under a prefix, so it can never read
    // as one of the core's documented reasons.
    return observed.status === "indeterminate"
      ? { status: "indeterminate", reason: `${ADAPTER_REASON_PREFIX}${observed.reason}` }
      : observed;
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
        ...unlockedPendingTiming(),
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
        if (provesRecoveryExpiry({ status: "failed-after-lock", checkpoint, failure: observation })) {
          // The expiry CAS compares the durable failure separately; an old
          // failure is never refreshed without an authenticated bridge read.
          return await persistRecoveryExpired({ status: "failed-after-lock", checkpoint, failure: observation }, durableObservation);
        }
        return await persistRecoveryExpired(durableFailure, durableObservation);
      }
      // Once this host's clock passes the deadline, a contradiction the
      // bridge stamped after the checkpoint and after the deadline expires
      // the lock, reported apart. One stamped at or before the checkpoint (it
      // may be cached) or at or before the deadline (the lock may still be
      // released in time), or a `pending` that leaves the operation live (no
      // lock, or another lock at or before its own deadline), never does: it
      // stays `lock-contradicted`.
      if (checkpoint && !durableFailure && contradictsCheckpoint(observation, checkpoint)) {
        type Contradicted = Extract<LiquidityTankRecoveryEvidence, { status: "contradicted-after-lock" }>;
        const contradicted = validateRecoveryEvidence({
          status: "contradicted-after-lock",
          checkpoint,
          contradiction: observation as Contradicted["contradiction"],
        }, intent, submission) as Contradicted;
        if (provesRecoveryExpiry(contradicted)) {
          return await persistRecoveryExpired(contradicted, durableObservation) ?? {
            status: "indeterminate",
            reason: "liquidity-tank-recovery-expiry-persistence-uncertain",
          };
        }
      }
      return await resolveDurableProgress("conflicting") ?? {
        status: "indeterminate",
        reason: "liquidity-tank-recovery-checkpoint-conflict",
      };
    }
    // A durable failure still needs a fresh post-deadline snapshot, or a
    // completion of that same lock, before it can resolve the lock.
    const durableLockFailure = lockBearingFailure(durableObservation);
    if (durableLockFailure && observation.status === "failed" &&
        transactionHashIdentity(observation.lockTxHash ?? "") === transactionHashIdentity(durableLockFailure.lockTxHash) &&
        observation.recoveryDeadline === durableLockFailure.recoveryDeadline &&
        observation.observedAt > durableLockFailure.observedAt && provesRecoveryExpiry(observation as LiquidityTankRecoveryEvidence)) {
      if (!await persistObservation(observation)) return { status: "indeterminate", reason: "liquidity-tank-observation-persistence-uncertain" };
      return await persistRecoveryExpired(observation as LiquidityTankRecoveryEvidence, observation);
    }
    if (durableLockFailure && !(observation.status === "completed" &&
        transactionHashIdentity(observation.lockTxHash ?? "") === transactionHashIdentity(durableLockFailure.lockTxHash) &&
        observation.recoveryDeadline === durableLockFailure.recoveryDeadline)) {
      return await resolveDurableProgress();
    }
    if (observation.status === "completed" &&
        pastRecoveryDeadline(observation.finalityObservedAt, observation.recoveryDeadline)) {
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
      // The durable progress stands, with its deadline: a lock's, or an
      // unlocked pending's, including when the store refused a regression.
      return progressFromDurableObservation(intent, durableObservation, latestNow) ??
        (durableObservation?.status === "pending" ? unlockedPendingProgress() : {
          status: "indeterminate",
          reason: "liquidity-tank-observation-persistence-uncertain",
        });
    }
    // The core keeps no tank balance: the bridge enforces its capacity across
    // concurrent phases, and its authenticated refusal is trusted here.
    if (observation.status === "capacity-unavailable") {
      return { status: "waiting", reason: "liquidity-tank-capacity-unavailable" };
    }
    if (observation.status === "failed") {
      // A failure after a committed lock resolves through that lock's
      // deadline, as one beside a durable checkpoint does: never `permanent`.
      if (lockBearingFailure(observation)) return await resolveDurableProgress();
      return { status: "failed", errorClass: "permanent", reason: observation.reason };
    }
    if (observation.status === "pending") {
      const durablePending = await resolveRecoveryProgress(observation);
      if (durablePending) return durablePending;
      return unlockedPendingProgress();
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

/**
 * One phase's row as the SDK's stores keep it. The in-memory and filesystem
 * stores apply the same transitions to it, so they compare the same fields.
 */
export interface LiquidityTankRecord {
  intent: Readonly<LiquidityTankIntent>;
  lease: Readonly<LiquidityTankLease>;
  submission?: Readonly<LiquidityTankPreparedSubmission>;
  submissionRecordedAt?: number;
  observation?: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>>;
  recoveryFailure?: Extract<LiquidityTankRecoveryEvidence, { status: "failed-after-lock" }>;
  recoveryExpired?: LiquidityTankRecoveryEvidence;
  settlement?: Readonly<LiquidityTankSettlement>;
}

/** A store method's answer, and the row to commit with it when it changed one. */
export interface LiquidityTankRecordTransition<T> {
  result: T;
  next?: LiquidityTankRecord;
}

type StoreInput<K extends keyof LiquidityTankStore> =
  LiquidityTankStore[K] extends (input: infer I) => unknown ? I : never;

function observationRank(status: Exclude<LiquidityTankObservation, { status: "indeterminate" }>["status"]): number {
  if (status === "empty" || status === "capacity-unavailable") return 0;
  if (status === "pending") return 1;
  return 2;
}

function currentLease(
  record: LiquidityTankRecord | undefined,
  input: { bindingHash: string; owner: string; generation: number },
): record is LiquidityTankRecord {
  return record !== undefined &&
    record.intent.bindingHash === input.bindingHash && record.lease.owner === input.owner &&
    record.lease.generation === input.generation;
}

/** Ordinary writes re-check lease expiry at the caller's `now`, as claims and the fence do. */
function leaseExpired(record: LiquidityTankRecord, now: unknown): boolean {
  return record.lease.expiresAt <= requireUInt(now, "write now");
}

function claimTransition(
  existing: LiquidityTankRecord | undefined,
  input: StoreInput<"claim">,
): LiquidityTankRecordTransition<LiquidityTankStoreClaim> {
  const expiresAt = leaseExpiry(
    requireUInt(input.now, "claim now"),
    requireUInt(input.leaseDurationMs, "claim leaseDurationMs", true),
  );
  if (existing) {
    if (existing.intent.bindingHash !== input.intent.bindingHash) {
      return { result: { status: "conflict", reason: "liquidity-tank-settlement-binding-conflict" } };
    }
    if (existing.settlement) {
      return { result: { status: "settled", intent: existing.intent, settlement: existing.settlement,
        ...(existing.submission === undefined ? {} : { submission: existing.submission, submissionRecordedAt: existing.submissionRecordedAt }),
      } };
    }
    if (existing.recoveryExpired) {
      if (!existing.submission || existing.submissionRecordedAt === undefined) {
        return { result: { status: "corrupt", reason: "liquidity-tank-recovery-expiry-missing-submission" } };
      }
      return {
        result: {
          status: "recovery-expired",
          intent: existing.intent,
          submission: existing.submission,
          submissionRecordedAt: existing.submissionRecordedAt,
          observation: existing.recoveryExpired,
        },
      };
    }
    if (existing.lease.expiresAt > input.now) {
      return {
        result: {
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
        },
      };
    }
    const generation = existing.lease.generation + 1;
    if (!isSafeInteger(generation)) {
      return { result: { status: "corrupt", reason: "liquidity-tank-lease-generation-exhausted" } };
    }
    const lease = {
      owner: input.owner,
      generation,
      expiresAt,
    };
    return {
      result: {
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
      },
      next: { ...existing, lease },
    };
  }
  const record: LiquidityTankRecord = {
    intent: input.intent,
    lease: { owner: input.owner, generation: 1, expiresAt },
  };
  return { result: { status: "acquired", intent: record.intent, lease: { ...record.lease } }, next: record };
}

function isCurrentTransition(
  record: LiquidityTankRecord | undefined,
  input: StoreInput<"isCurrent">,
): boolean {
  return currentLease(record, input) && record.lease.expiresAt > input.now &&
    !record.settlement && !record.recoveryExpired;
}

/** `bridgeOwner` is the settlement key that already holds the submission's bridge ID, if any. */
function recordSubmissionTransition(
  record: LiquidityTankRecord | undefined,
  input: StoreInput<"recordSubmission">,
  bridgeOwner: string | undefined,
): LiquidityTankRecordTransition<LiquidityTankStoreWrite> {
  if (!currentLease(record, input)) return { result: { status: "stale", reason: "stale-lease" } };
  if (leaseExpired(record, input.now)) return { result: { status: "stale", reason: "expired-lease" } };
  if (record.settlement || record.recoveryExpired) {
    return { result: { status: "conflict", reason: "liquidity-tank-submission-after-terminal" } };
  }
  if (bridgeOwner && bridgeOwner !== input.settlementKey) {
    return { result: { status: "conflict", reason: "liquidity-tank-bridge-cross-settlement-reuse" } };
  }
  if (record.submission) {
    return record.submission.submissionHash === input.submission.submissionHash
      ? { result: { status: "existing" } }
      : { result: { status: "conflict", reason: "liquidity-tank-submission-replacement-forbidden" } };
  }
  return {
    result: { status: "recorded" },
    // Validated by the lease check above; kept with the submission it receipts.
    next: { ...record, submission: Object.freeze({ ...input.submission }), submissionRecordedAt: input.now },
  };
}

function recordObservationTransition(
  record: LiquidityTankRecord | undefined,
  input: StoreInput<"recordObservation">,
): LiquidityTankRecordTransition<LiquidityTankStoreWrite> {
  if (!currentLease(record, input)) return { result: { status: "stale", reason: "stale-lease" } };
  if (leaseExpired(record, input.now)) return { result: { status: "stale", reason: "expired-lease" } };
  if (record.settlement || record.recoveryExpired) {
    return { result: { status: "conflict", reason: "liquidity-tank-observation-after-terminal" } };
  }
  if (!record.submission || input.observation.bridgeId !== record.submission.bridgeId) {
    return { result: { status: "conflict", reason: "liquidity-tank-observation-bridge-conflict" } };
  }
  let observation: Exclude<LiquidityTankObservation, { status: "indeterminate" }>;
  try {
    observation = validateRetainedObservation(
      input.observation,
      record.intent,
      record.submission,
    );
  } catch {
    return { result: { status: "conflict", reason: "liquidity-tank-observation-invalid" } };
  }
  if (observation.status === "completed" &&
      pastRecoveryDeadline(observation.finalityObservedAt, observation.recoveryDeadline)) {
    return { result: { status: "conflict", reason: "liquidity-tank-completion-after-recovery-deadline" } };
  }
  const prior = record.observation;
  if (record.recoveryFailure && observation.status !== "completed") {
    return { result: { status: "conflict", reason: "liquidity-tank-terminal-failure-retained" } };
  }
  // A timely completion of the lock a durable failure carried still wins, as
  // it does over failure evidence retained beside a checkpoint.
  const priorLockFailure = lockBearingFailure(prior);
  const completesFailedLock = priorLockFailure !== undefined && observation.status === "completed" &&
    transactionHashIdentity(observation.lockTxHash ?? "") === transactionHashIdentity(priorLockFailure.lockTxHash) &&
    observation.recoveryDeadline === priorLockFailure.recoveryDeadline;
  const refreshesFailedLock = priorLockFailure !== undefined && observation.status === "failed" &&
    transactionHashIdentity(observation.lockTxHash ?? "") === transactionHashIdentity(priorLockFailure.lockTxHash) &&
    observation.recoveryDeadline === priorLockFailure.recoveryDeadline && observation.observedAt > priorLockFailure.observedAt;
  if (prior?.status === "completed" && observation.status === "completed" &&
      sameSettlementFacts(settlementFromCompletedObservation(record.intent, prior),
        settlementFromCompletedObservation(record.intent, observation))) {
    return { result: { status: "existing" } };
  }
  if (prior && !completesFailedLock && !refreshesFailedLock) {
    if (canonicalize(prior) === canonicalize(observation)) return { result: { status: "existing" } };
    if (!preservesRecoveryCheckpoint(prior, observation) ||
        observationRank(observation.status) < observationRank(prior.status)) {
      return { result: { status: "conflict", reason: "liquidity-tank-status-regression" } };
    }
    if (observationRank(observation.status) === observationRank(prior.status) &&
        observation.status !== "pending" &&
        !(["empty", "capacity-unavailable"].includes(prior.status) &&
          ["empty", "capacity-unavailable"].includes(observation.status))) {
      return { result: { status: "conflict", reason: "liquidity-tank-terminal-status-conflict" } };
    }
  }
  const next: LiquidityTankRecord = { ...record, observation };
  if (observation.status === "completed") delete next.recoveryFailure;
  return { result: { status: "recorded" }, next };
}

type RecoveryFailureWrite = Awaited<ReturnType<LiquidityTankStore["recordRecoveryFailure"]>>;

function recordRecoveryFailureTransition(
  record: LiquidityTankRecord | undefined,
  input: StoreInput<"recordRecoveryFailure">,
): LiquidityTankRecordTransition<RecoveryFailureWrite> {
  if (!currentLease(record, input)) return { result: { status: "stale", reason: "stale-lease" } };
  if (record.settlement || record.recoveryExpired) {
    return { result: { status: "conflict", reason: "liquidity-tank-observation-after-terminal" } };
  }
  if (!record.submission) {
    return { result: { status: "conflict", reason: "liquidity-tank-observation-bridge-conflict" } };
  }
  let evidence: LiquidityTankRecoveryEvidence;
  try {
    evidence = validateRecoveryEvidence(input.recoveryFailure, record.intent, record.submission);
    const failureNow = requireUInt(input.now, "failure retention now");
    if (record.lease.expiresAt <= failureNow) return { result: { status: "stale", reason: "expired-lease" } };
  } catch {
    return { result: { status: "conflict", reason: "liquidity-tank-recovery-evidence-invalid" } };
  }
  if (evidence.status !== "failed-after-lock" || !recoveryCheckpoint(record.observation) ||
      canonicalize(record.observation) !== canonicalize(evidence.checkpoint)) {
    return { result: { status: "conflict", reason: "liquidity-tank-recovery-checkpoint-cas-failed" } };
  }
  if (record.recoveryFailure) {
    return canonicalize(record.recoveryFailure) === canonicalize(evidence)
      ? { result: { status: "existing", recoveryFailure: record.recoveryFailure } }
      : { result: { status: "conflict", reason: "liquidity-tank-recovery-failure-conflict" } };
  }
  return {
    result: { status: "recorded", recoveryFailure: evidence },
    next: { ...record, recoveryFailure: evidence },
  };
}

function recordRecoveryExpiredTransition(
  record: LiquidityTankRecord | undefined,
  input: StoreInput<"recordRecoveryExpired">,
): LiquidityTankRecordTransition<LiquidityTankStoreWrite> {
  if (!currentLease(record, input)) return { result: { status: "stale", reason: "stale-lease" } };
  const expiryNow = requireUInt(input.now, "recovery expiry now");
  if (record.lease.expiresAt <= expiryNow) {
    return { result: { status: "stale", reason: "expired-lease" } };
  }
  if (record.settlement) {
    return { result: { status: "conflict", reason: "liquidity-tank-recovery-lost-to-settlement" } };
  }
  // A durable timely completion has won even before its settlement is
  // written: no later evidence may expire it.
  if (record.observation?.status === "completed") {
    return { result: { status: "conflict", reason: "liquidity-tank-recovery-lost-to-completion" } };
  }
  if (record.recoveryExpired) {
    return canonicalize(record.recoveryExpired) === canonicalize(input.observation)
      ? { result: { status: "existing" } }
      : { result: { status: "conflict", reason: "liquidity-tank-recovery-expiry-conflict" } };
  }
  if (!record.submission) {
    return { result: { status: "conflict", reason: "liquidity-tank-recovery-checkpoint-cas-failed" } };
  }
  let evidence: LiquidityTankRecoveryEvidence;
  try {
    evidence = validateRecoveryEvidence(input.observation, record.intent, record.submission);
  } catch {
    return { result: { status: "conflict", reason: "liquidity-tank-recovery-evidence-invalid" } };
  }
  // The evidence carries its own authenticated time, so the CAS re-checks
  // it as well as the store clock.
  if (!pastRecoveryDeadline(expiryNow, recoveryEvidenceDeadline(evidence)) || !provesRecoveryExpiry(evidence)) {
    return { result: { status: "conflict", reason: "liquidity-tank-recovery-expiry-not-due" } };
  }
  const expectedObservationMatches = record.observation === undefined
    ? input.expectedObservation === undefined
    : input.expectedObservation !== undefined &&
      canonicalize(record.observation) === canonicalize(input.expectedObservation);
  if (!expectedObservationMatches) {
    return { result: { status: "conflict", reason: "liquidity-tank-recovery-checkpoint-cas-failed" } };
  }
  const priorCheckpoint = recoveryCheckpoint(record.observation);
  // The durable lock: a checkpoint, or a failure that carries its lock.
  const priorLock = priorCheckpoint ?? lockBearingFailure(record.observation);
  if (evidence.status === "pending") {
    if (canonicalize(record.observation) !== canonicalize(evidence)) {
      return { result: { status: "conflict", reason: "liquidity-tank-recovery-checkpoint-cas-failed" } };
    }
  } else if (evidence.status === "completed") {
    if (priorLock &&
        (transactionHashIdentity(evidence.lockTxHash) !== transactionHashIdentity(priorLock.lockTxHash) ||
          evidence.recoveryDeadline !== priorLock.recoveryDeadline)) {
      return { result: { status: "conflict", reason: "liquidity-tank-recovery-checkpoint-cas-failed" } };
    }
  } else if (evidence.status === "failed") {
    // A failure that carries its lock is evidence only as the durable
    // observation itself; beside a checkpoint it is retained as failed-after-lock.
    if (canonicalize(record.observation) !== canonicalize(evidence) || record.recoveryFailure) {
      return { result: { status: "conflict", reason: "liquidity-tank-recovery-checkpoint-cas-failed" } };
    }
  } else if (evidence.status === "contradicted-after-lock") {
    // Retained failure evidence, when there is any, is the lock's evidence.
    if (!priorCheckpoint || canonicalize(priorCheckpoint) !== canonicalize(evidence.checkpoint) ||
        record.recoveryFailure) {
      return { result: { status: "conflict", reason: "liquidity-tank-recovery-checkpoint-cas-failed" } };
    }
  } else if (!priorCheckpoint ||
      canonicalize(priorCheckpoint) !== canonicalize(evidence.checkpoint) ||
      !record.recoveryFailure ||
      evidence.failure.observedAt < record.recoveryFailure.failure.observedAt) {
    return { result: { status: "conflict", reason: "liquidity-tank-recovery-checkpoint-cas-failed" } };
  }
  return { result: { status: "recorded" }, next: { ...record, recoveryExpired: evidence } };
}

function reconcileRecoveryExpiredTransition(
  record: LiquidityTankRecord | undefined,
  input: Parameters<NonNullable<LiquidityTankStore["reconcileRecoveryExpired"]>>[0],
): LiquidityTankRecordTransition<LiquidityTankStoreWrite> {
  if (!record || record.intent.bindingHash !== input.bindingHash || !record.submission) {
    return { result: { status: "conflict", reason: "liquidity-tank-expiry-correction-conflict" } };
  }
  let completed: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>>;
  try { completed = validateRetainedObservation(input.completion, record.intent, record.submission); }
  catch { return { result: { status: "conflict", reason: "liquidity-tank-expiry-correction-invalid" } }; }
  if (completed.status !== "completed") {
    return { result: { status: "conflict", reason: "liquidity-tank-expiry-correction-invalid" } };
  }
  const settlement = settlementFromCompletedObservation(record.intent, completed);
  if (record.settlement) return { result: sameSettlementFacts(record.settlement, settlement)
    ? { status: "existing" } : { status: "conflict", reason: "liquidity-tank-settlement-conflict" } };
  const retainedCompletion = record.recoveryExpired?.completion ??
    (record.recoveryExpired?.status === "completed" ? record.recoveryExpired : undefined);
  if (retainedCompletion) {
    return { result: sameSettlementFacts(settlementFromCompletedObservation(record.intent, retainedCompletion), settlement)
      ? { status: "existing" } : { status: "conflict", reason: "liquidity-tank-recovery-expiry-conflict" } };
  }
  if (!record.recoveryExpired || canonicalize(record.recoveryExpired) !== canonicalize(input.expectedEvidence)) {
    return { result: { status: "conflict", reason: "liquidity-tank-expiry-correction-conflict" } };
  }
  const evidence = record.recoveryExpired;
  const lock = evidence.status === "failed-after-lock" || evidence.status === "contradicted-after-lock" ? evidence.checkpoint : evidence;
  if (transactionHashIdentity(completed.lockTxHash) !== transactionHashIdentity(lock.lockTxHash) ||
      completed.recoveryDeadline !== lock.recoveryDeadline) {
    return { result: { status: "recorded" }, next: { ...record, recoveryExpired: { ...evidence, completion: completed } } };
  }
  if (pastRecoveryDeadline(completed.finalityObservedAt, completed.recoveryDeadline)) {
    // Keep the phase expired and the original checkpoint/failure, enriching
    // its terminal evidence with the authenticated payment disposition.
    return { result: { status: "recorded" }, next: { ...record, recoveryExpired: completed } };
  }
  const { recoveryExpired: _expired, recoveryFailure: _failure, ...rest } = record;
  return { result: { status: "recorded" }, next: { ...rest, observation: completed, settlement } };
}

function recordSettlementTransition(
  record: LiquidityTankRecord | undefined,
  input: StoreInput<"recordSettlement">,
): LiquidityTankRecordTransition<LiquidityTankStoreWrite> {
  if (!currentLease(record, input)) return { result: { status: "stale", reason: "stale-lease" } };
  if (leaseExpired(record, input.now)) return { result: { status: "stale", reason: "expired-lease" } };
  if (record.recoveryExpired) {
    return { result: { status: "conflict", reason: "liquidity-tank-settlement-lost-to-recovery-expiry" } };
  }
  if (record.observation?.status !== "completed") {
    return { result: { status: "conflict", reason: "liquidity-tank-settlement-before-completion" } };
  }
  const expectedSettlement = settlementFromCompletedObservation(
    record.intent,
    record.observation,
  );
  if (canonicalize(input.settlement) !== canonicalize(expectedSettlement)) {
    return { result: { status: "conflict", reason: "liquidity-tank-settlement-evidence-conflict" } };
  }
  if (record.settlement) {
    return canonicalize(record.settlement) === canonicalize(input.settlement)
      ? { result: { status: "existing" } }
      : { result: { status: "conflict", reason: "liquidity-tank-settlement-conflict" } };
  }
  return {
    result: { status: "recorded" },
    next: { ...record, settlement: Object.freeze({ ...input.settlement }) },
  };
}

/**
 * The store contract as pure transitions over one row. Each returns the
 * answer and, when a write changes the row, the row to commit with it. A store
 * applies each one atomically per settlement key, and for `recordSubmission`
 * also reserves the bridge ID across keys. Internal to the SDK's own stores:
 * the package does not export it.
 */
export const liquidityTankRecordTransitions = Object.freeze({
  claim: claimTransition,
  isCurrent: isCurrentTransition,
  recordSubmission: recordSubmissionTransition,
  recordObservation: recordObservationTransition,
  recordRecoveryFailure: recordRecoveryFailureTransition,
  recordRecoveryExpired: recordRecoveryExpiredTransition,
  recordSettlement: recordSettlementTransition,
  reconcileRecoveryExpired: reconcileRecoveryExpiredTransition,
});

/**
 * Checks a row read back from durable storage with the validators the core
 * applies to a claim, and throws unless it is a row these transitions could
 * have written for `settlementKey`. Internal to the SDK's own stores: the
 * package does not export it.
 */
export function assertLiquidityTankRecord(record: LiquidityTankRecord, settlementKey: string): void {
  const intent = withoutPrototype(record.intent);
  const { bindingHash, ...unsigned } = intent;
  if (intent.intentVersion !== "1" || intent.settlementKey !== settlementKey ||
      !matchesPattern(HASH_RE, bindingHash) || sha256Hex(canonicalize(unsigned)) !== bindingHash) {
    throw new DacsError("pay-cross-chain-liquidity-tank: stored intent does not recompute");
  }
  const lease = withoutPrototype(record.lease);
  requireString(lease.owner, "stored lease owner");
  requireUInt(lease.generation, "stored lease generation", true);
  requireUInt(lease.expiresAt, "stored lease expiresAt");
  if ((record.submission === undefined) !== (record.submissionRecordedAt === undefined)) {
    throw new DacsError("pay-cross-chain-liquidity-tank: stored submission receipt mismatch");
  }
  if (record.submission === undefined) {
    if (record.observation !== undefined || record.recoveryFailure !== undefined ||
        record.recoveryExpired !== undefined) {
      throw new DacsError("pay-cross-chain-liquidity-tank: stored evidence without a submission");
    }
  } else {
    const submission = validateRetainedSubmission(record.submission, intent);
    requireUInt(record.submissionRecordedAt, "stored submissionRecordedAt");
    if (record.observation !== undefined) {
      validateRetainedObservation(record.observation, intent, submission);
    }
    if (record.recoveryFailure !== undefined &&
        validateRecoveryEvidence(record.recoveryFailure, intent, submission).status !== "failed-after-lock") {
      throw new DacsError("pay-cross-chain-liquidity-tank: stored recovery failure is invalid");
    }
    if (record.recoveryExpired !== undefined) {
      validateRecoveryEvidence(record.recoveryExpired, intent, submission);
    }
  }
  if (record.settlement !== undefined) captureSettlement(record.settlement, intent);
}

export interface InMemoryLiquidityTankStoreOptions {
  /**
   * Confirms the caller knows this store keeps every row in process memory
   * and loses it on restart. Required, and only `true` is accepted.
   */
  readonly acknowledgeVolatile: true;
}

/** Only explicit development/test modes permit a volatile store. */
function allowsVolatileStore(): boolean {
  try {
    const mode = process.env["NODE_ENV"];
    return mode === "development" || mode === "test";
  } catch {
    return false;
  }
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
 * caller passes `{ acknowledgeVolatile: true }`, and declares
 * `restartSafety: "volatile-acknowledged"`.
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
  const records = new Map<string, LiquidityTankRecord>();
  const bridgeOwners = new Map<string, string>();
  // Each method reads, decides and commits with no await in between, so every
  // transition is atomic within this process.
  const commit = <T>(settlementKey: string, transition: LiquidityTankRecordTransition<T>): T => {
    if (transition.next) records.set(settlementKey, transition.next);
    return transition.result;
  };
  return {
    restartSafety: "volatile-acknowledged",
    async claim(input) {
      return commit(
        input.intent.settlementKey,
        claimTransition(records.get(input.intent.settlementKey), input),
      );
    },
    async isCurrent(input) {
      return isCurrentTransition(records.get(input.settlementKey), input);
    },
    async recordSubmission(input) {
      const transition = recordSubmissionTransition(
        records.get(input.settlementKey),
        input,
        bridgeOwners.get(input.submission.bridgeId),
      );
      if (transition.next) bridgeOwners.set(input.submission.bridgeId, input.settlementKey);
      return commit(input.settlementKey, transition);
    },
    async recordObservation(input) {
      return commit(input.settlementKey, recordObservationTransition(records.get(input.settlementKey), input));
    },
    async recordRecoveryFailure(input) {
      return commit(
        input.settlementKey,
        recordRecoveryFailureTransition(records.get(input.settlementKey), input),
      );
    },
    async recordRecoveryExpired(input) {
      return commit(
        input.settlementKey,
        recordRecoveryExpiredTransition(records.get(input.settlementKey), input),
      );
    },
    async reconcileRecoveryExpired(input) {
      return commit(input.settlementKey, reconcileRecoveryExpiredTransition(records.get(input.settlementKey), input));
    },
    async recordSettlement(input) {
      return commit(input.settlementKey, recordSettlementTransition(records.get(input.settlementKey), input));
    },
  };
}

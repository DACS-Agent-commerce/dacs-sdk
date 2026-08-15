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

/**
 * Simulation-only result vocabulary. These values deliberately cannot be
 * confused with the normative outcome enum carried by live DACS artifacts.
 */
export type FixedPriceOfflineSimulationOutcome =
  | "simulated-success"
  | "simulated-failure"
  | "simulated-aborted";

export type FixedPriceOfflineSimulationErrorClass =
  | "simulated-permanent"
  | "simulated-transient"
  | "simulated-counterparty"
  | "simulated-substrate"
  | "simulated-settlement-atomicity";

export type FixedPriceOfflineSimulationMilestone =
  | "simulation-created"
  | "simulation-agreement-exercised"
  | "simulation-payment-exercised"
  | "simulation-delivery-ready"
  | "simulation-buyer-received"
  | "simulation-performance-exercised"
  | "simulation-actor-audit-exercised"
  | "simulation-audit-exercised"
  | "simulation-terminal-failure"
  | "simulation-terminal-aborted";

export interface FixedPriceOfflineSimulationAuthority {
  simulationOnly: true;
  normativeConformance: false;
  commercialSuccess: false;
  authority: "none";
}

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

interface FixedPriceCoordinatorTrackRecord<
  Outcome extends string,
  ErrorClass extends string,
> {
  state: FixedPriceX402TrackState;
  generation: number;
  attempts: number;
  updatedAt: number;
  nextAttemptAt?: number;
  reference?: string;
  authenticationHash?: string;
  outcome?: Outcome;
  errorClass?: ErrorClass;
  faultedParty?: FixedPriceX402FaultedParty;
  withdrawnBy?: FixedPriceX402CoordinatorRole;
  reasonCode?: string;
  lease?: Readonly<FixedPriceX402TrackLease>;
}

export interface FixedPriceX402TrackRecord
  extends FixedPriceCoordinatorTrackRecord<
    FixedPriceX402NormativeOutcome,
    FixedPriceX402ErrorClass
  > {}

export interface FixedPriceOfflineTrackRecord
  extends FixedPriceCoordinatorTrackRecord<
    FixedPriceOfflineSimulationOutcome,
    FixedPriceOfflineSimulationErrorClass
  > {}

type FixedPriceCoordinatorTrackMap<
  Outcome extends string,
  ErrorClass extends string,
> = Readonly<
  Partial<
    Record<
      FixedPriceX402Track,
      Readonly<FixedPriceCoordinatorTrackRecord<Outcome, ErrorClass>>
    >
  >
>;

export type FixedPriceX402TrackMap = FixedPriceCoordinatorTrackMap<
  FixedPriceX402NormativeOutcome,
  FixedPriceX402ErrorClass
>;

export type FixedPriceOfflineTrackMap = FixedPriceCoordinatorTrackMap<
  FixedPriceOfflineSimulationOutcome,
  FixedPriceOfflineSimulationErrorClass
>;

interface FixedPriceCoordinatorOrderRecord<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
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
  tracks: FixedPriceCoordinatorTrackMap<Outcome, ErrorClass>;
  createdAt: number;
  updatedAt: number;
}

export interface FixedPriceX402OrderRecord
  extends FixedPriceCoordinatorOrderRecord<
    FixedPriceX402ProtocolBinding,
    FixedPriceX402NormativeOutcome,
    FixedPriceX402ErrorClass
  > {}
export interface FixedPriceOfflineOrderRecord
  extends FixedPriceCoordinatorOrderRecord<
    FixedPriceOfflineProtocolBinding,
    FixedPriceOfflineSimulationOutcome,
    FixedPriceOfflineSimulationErrorClass
  > {}

type FixedPriceCoordinatorOrderLoad<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
> =
  | { status: "missing" }
  | {
      status: "ok";
      record: Readonly<
        FixedPriceCoordinatorOrderRecord<Protocol, Outcome, ErrorClass>
      >;
    }
  | { status: "unsupported"; version: number }
  | { status: "corrupt"; reason: string };

type FixedPriceCoordinatorOrderCreate<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
> =
  | {
      status: "created" | "existing";
      record: Readonly<
        FixedPriceCoordinatorOrderRecord<Protocol, Outcome, ErrorClass>
      >;
    }
  | { status: "conflict" }
  | { status: "unsupported"; version: number }
  | { status: "corrupt"; reason: string };

type FixedPriceCoordinatorTrackClaim<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
> =
  | {
      status: "acquired";
      record: Readonly<
        FixedPriceCoordinatorOrderRecord<Protocol, Outcome, ErrorClass>
      >;
      lease: Readonly<FixedPriceX402TrackLease>;
    }
  | {
      status: "waiting";
      record: Readonly<
        FixedPriceCoordinatorOrderRecord<Protocol, Outcome, ErrorClass>
      >;
      lease: Readonly<FixedPriceX402TrackLease>;
    }
  | {
      status: "not-runnable";
      record: Readonly<
        FixedPriceCoordinatorOrderRecord<Protocol, Outcome, ErrorClass>
      >;
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

export type FixedPriceOfflineTrackOperationResult =
  | {
      status: "final";
      outcome: "simulated-success" | "simulated-aborted";
      reference: string;
      authenticationHash?: string;
    }
  | {
      status: "final";
      outcome: "simulated-failure";
      errorClass: FixedPriceOfflineSimulationErrorClass;
      reference: string;
      authenticationHash?: string;
    }
  | {
      status: "pending-retry" | "indeterminate" | "operator-action";
      reasonCode: string;
      retryAt?: number;
    };

type FixedPriceCoordinatorOperationResult =
  | FixedPriceX402TrackOperationResult
  | FixedPriceOfflineTrackOperationResult;

type FixedPriceCoordinatorTrackWrite<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
> =
  | {
      status: "recorded" | "existing";
      record: Readonly<
        FixedPriceCoordinatorOrderRecord<Protocol, Outcome, ErrorClass>
      >;
    }
  | { status: "missing" | "stale" | "conflict" }
  | { status: "unsupported"; version: number }
  | { status: "corrupt"; reason: string };

export type FixedPriceX402OrderLoad =
  FixedPriceCoordinatorOrderLoad<
    FixedPriceX402ProtocolBinding,
    FixedPriceX402NormativeOutcome,
    FixedPriceX402ErrorClass
  >;
export type FixedPriceX402OrderCreate =
  FixedPriceCoordinatorOrderCreate<
    FixedPriceX402ProtocolBinding,
    FixedPriceX402NormativeOutcome,
    FixedPriceX402ErrorClass
  >;
export type FixedPriceX402TrackClaim =
  FixedPriceCoordinatorTrackClaim<
    FixedPriceX402ProtocolBinding,
    FixedPriceX402NormativeOutcome,
    FixedPriceX402ErrorClass
  >;
export type FixedPriceX402TrackWrite =
  FixedPriceCoordinatorTrackWrite<
    FixedPriceX402ProtocolBinding,
    FixedPriceX402NormativeOutcome,
    FixedPriceX402ErrorClass
  >;
export type FixedPriceOfflineOrderLoad =
  FixedPriceCoordinatorOrderLoad<
    FixedPriceOfflineProtocolBinding,
    FixedPriceOfflineSimulationOutcome,
    FixedPriceOfflineSimulationErrorClass
  >;
export type FixedPriceOfflineOrderCreate =
  FixedPriceCoordinatorOrderCreate<
    FixedPriceOfflineProtocolBinding,
    FixedPriceOfflineSimulationOutcome,
    FixedPriceOfflineSimulationErrorClass
  >;
export type FixedPriceOfflineTrackClaim =
  FixedPriceCoordinatorTrackClaim<
    FixedPriceOfflineProtocolBinding,
    FixedPriceOfflineSimulationOutcome,
    FixedPriceOfflineSimulationErrorClass
  >;
export type FixedPriceOfflineTrackWrite =
  FixedPriceCoordinatorTrackWrite<
    FixedPriceOfflineProtocolBinding,
    FixedPriceOfflineSimulationOutcome,
    FixedPriceOfflineSimulationErrorClass
  >;

export interface FixedPriceX402Page<T> {
  items: readonly T[];
  nextCursor?: string;
}

interface FixedPriceCoordinatorStore<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
  OperationResult,
> {
  /** Store-authoritative time, normally provided by the durable database. */
  readTime(): Promise<number>;
  create(input: Readonly<{
    role: FixedPriceX402CoordinatorRole;
    order: Readonly<FixedPriceCoordinatorOrderInput<Protocol>>;
    bindingHash: string;
    localBindingHash: string;
  }>): Promise<FixedPriceCoordinatorOrderCreate<Protocol, Outcome, ErrorClass>>;
  load(
    role: FixedPriceX402CoordinatorRole,
    jobId: string,
  ): Promise<FixedPriceCoordinatorOrderLoad<Protocol, Outcome, ErrorClass>>;
  /** Cursor-based query over only orders with runnable role-owned tracks. */
  listRunnable(input: Readonly<{
    role: FixedPriceX402CoordinatorRole;
    tracks: readonly FixedPriceX402Track[];
    cursor?: string;
    limit: number;
  }>): Promise<
    FixedPriceX402Page<
      Readonly<FixedPriceCoordinatorOrderRecord<Protocol, Outcome, ErrorClass>>
    >
  >;
  claim(input: Readonly<{
    role: FixedPriceX402CoordinatorRole;
    jobId: string;
    bindingHash: string;
    localBindingHash: string;
    track: FixedPriceX402Track;
    owner: string;
    leaseDurationMs: number;
  }>): Promise<FixedPriceCoordinatorTrackClaim<Protocol, Outcome, ErrorClass>>;
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
    result: Readonly<OperationResult>;
  }>): Promise<FixedPriceCoordinatorTrackWrite<Protocol, Outcome, ErrorClass>>;
  requeue(input: Readonly<{
    role: FixedPriceX402CoordinatorRole;
    jobId: string;
    bindingHash: string;
    localBindingHash: string;
    track: FixedPriceX402Track;
    operatorReasonCode: string;
    retryAt?: number;
  }>): Promise<FixedPriceCoordinatorTrackWrite<Protocol, Outcome, ErrorClass>>;
}

export interface FixedPriceX402CoordinatorStore
  extends FixedPriceCoordinatorStore<
    FixedPriceX402ProtocolBinding,
    FixedPriceX402NormativeOutcome,
    FixedPriceX402ErrorClass,
    FixedPriceX402TrackOperationResult
  > {}

export interface FixedPriceOfflineCoordinatorStore
  extends FixedPriceCoordinatorStore<
    FixedPriceOfflineProtocolBinding,
    FixedPriceOfflineSimulationOutcome,
    FixedPriceOfflineSimulationErrorClass,
    FixedPriceOfflineTrackOperationResult
  > {}

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
  Outcome extends string,
  ErrorClass extends string,
> {
  order: Readonly<
    FixedPriceCoordinatorOrderRecord<Protocol, Outcome, ErrorClass>
  >;
  fence: Readonly<FixedPriceX402EffectFence>;
  /**
   * Cooperative cancellation owned by the scheduler. Adapters must still
   * reconcile an irreversible effect once submission may have occurred.
   */
  signal?: AbortSignal;
}

type FixedPriceCoordinatorTrackOperation<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
  OperationResult,
> = (
  input: Readonly<
    FixedPriceCoordinatorTrackOperationInput<Protocol, Outcome, ErrorClass>
  >,
) => Promise<OperationResult> | OperationResult;

type FixedPriceCoordinatorOperations<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
  OperationResult,
> = Readonly<
  Partial<
    Record<
      FixedPriceX402Track,
      FixedPriceCoordinatorTrackOperation<
        Protocol,
        Outcome,
        ErrorClass,
        OperationResult
      >
    >
  >
>;

interface FixedPriceCoordinatorOptions<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
  OperationResult,
> {
  role: FixedPriceX402CoordinatorRole;
  store: FixedPriceCoordinatorStore<
    Protocol,
    Outcome,
    ErrorClass,
    OperationResult
  >;
  workerId: string;
  operations: FixedPriceCoordinatorOperations<
    Protocol,
    Outcome,
    ErrorClass,
    OperationResult
  >;
  leaseDurationMs?: number;
}

interface FixedPriceCoordinatorOrderStatusBase<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
  Milestone extends string,
> {
  role: FixedPriceX402CoordinatorRole;
  jobId: string;
  buyer: string;
  seller: string;
  protocol: Readonly<Protocol>;
  bindingHash: string;
  localBindingHash: string;
  sdkJobs: Readonly<FixedPriceX402SdkJobPointers>;
  tracks: FixedPriceCoordinatorTrackMap<Outcome, ErrorClass>;
  milestone: Milestone;
  attention: Readonly<{
    required: boolean;
    tracks: readonly FixedPriceX402Track[];
  }>;
  revision: number;
  updatedAt: number;
}

type FixedPriceCoordinatorOrderStatus<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
  Milestone extends string,
  Authority extends object,
> = FixedPriceCoordinatorOrderStatusBase<
  Protocol,
  Outcome,
  ErrorClass,
  Milestone
> & Authority;

interface FixedPriceCoordinatorCombinedOrderStatusBase<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
  LocalMilestone extends string,
  CombinedMilestone extends string,
  Authority extends object,
> {
  jobId: string;
  buyer: string;
  seller: string;
  protocol: Readonly<Protocol>;
  bindingHash: string;
  actors: Readonly<{
    buyer: Readonly<
      FixedPriceCoordinatorOrderStatus<
        Protocol,
        Outcome,
        ErrorClass,
        LocalMilestone,
        Authority
      >
    >;
    seller: Readonly<
      FixedPriceCoordinatorOrderStatus<
        Protocol,
        Outcome,
        ErrorClass,
        LocalMilestone,
        Authority
      >
    >;
  }>;
  milestone: CombinedMilestone;
  attention: Readonly<{
    required: boolean;
    tracks: readonly Readonly<{
      role: FixedPriceX402CoordinatorRole;
      track: FixedPriceX402Track;
    }>[];
  }>;
  updatedAt: number;
}

type FixedPriceCoordinatorCombinedOrderStatus<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
  LocalMilestone extends string,
  CombinedMilestone extends string,
  Authority extends object,
> = FixedPriceCoordinatorCombinedOrderStatusBase<
  Protocol,
  Outcome,
  ErrorClass,
  LocalMilestone,
  CombinedMilestone,
  Authority
> & Authority;

export interface FixedPriceX402TrackOperationInput
  extends FixedPriceCoordinatorTrackOperationInput<
    FixedPriceX402ProtocolBinding,
    FixedPriceX402NormativeOutcome,
    FixedPriceX402ErrorClass
  > {}
export type FixedPriceX402TrackOperation =
  FixedPriceCoordinatorTrackOperation<
    FixedPriceX402ProtocolBinding,
    FixedPriceX402NormativeOutcome,
    FixedPriceX402ErrorClass,
    FixedPriceX402TrackOperationResult
  >;
export type FixedPriceX402Operations =
  FixedPriceCoordinatorOperations<
    FixedPriceX402ProtocolBinding,
    FixedPriceX402NormativeOutcome,
    FixedPriceX402ErrorClass,
    FixedPriceX402TrackOperationResult
  >;
export interface FixedPriceX402CoordinatorOptions
  extends FixedPriceCoordinatorOptions<
    FixedPriceX402ProtocolBinding,
    FixedPriceX402NormativeOutcome,
    FixedPriceX402ErrorClass,
    FixedPriceX402TrackOperationResult
  > {}
export interface FixedPriceX402OrderStatus
  extends FixedPriceCoordinatorOrderStatusBase<
    FixedPriceX402ProtocolBinding,
    FixedPriceX402NormativeOutcome,
    FixedPriceX402ErrorClass,
    Exclude<FixedPriceX402Milestone, "audit-complete">
  > {}
export interface FixedPriceX402CombinedOrderStatus
  extends FixedPriceCoordinatorCombinedOrderStatusBase<
    FixedPriceX402ProtocolBinding,
    FixedPriceX402NormativeOutcome,
    FixedPriceX402ErrorClass,
    Exclude<FixedPriceX402Milestone, "audit-complete">,
    FixedPriceX402Milestone,
    Record<never, never>
  > {}

export interface FixedPriceOfflineTrackOperationInput
  extends FixedPriceCoordinatorTrackOperationInput<
    FixedPriceOfflineProtocolBinding,
    FixedPriceOfflineSimulationOutcome,
    FixedPriceOfflineSimulationErrorClass
  > {}
export type FixedPriceOfflineTrackOperation =
  FixedPriceCoordinatorTrackOperation<
    FixedPriceOfflineProtocolBinding,
    FixedPriceOfflineSimulationOutcome,
    FixedPriceOfflineSimulationErrorClass,
    FixedPriceOfflineTrackOperationResult
  >;
export type FixedPriceOfflineOperations =
  FixedPriceCoordinatorOperations<
    FixedPriceOfflineProtocolBinding,
    FixedPriceOfflineSimulationOutcome,
    FixedPriceOfflineSimulationErrorClass,
    FixedPriceOfflineTrackOperationResult
  >;
export interface FixedPriceOfflineCoordinatorOptions
  extends FixedPriceCoordinatorOptions<
    FixedPriceOfflineProtocolBinding,
    FixedPriceOfflineSimulationOutcome,
    FixedPriceOfflineSimulationErrorClass,
    FixedPriceOfflineTrackOperationResult
  > {}
export type FixedPriceOfflineOrderStatus = FixedPriceCoordinatorOrderStatus<
  FixedPriceOfflineProtocolBinding,
  FixedPriceOfflineSimulationOutcome,
  FixedPriceOfflineSimulationErrorClass,
  Exclude<
    FixedPriceOfflineSimulationMilestone,
    "simulation-audit-exercised"
  >,
  FixedPriceOfflineSimulationAuthority
>;
export type FixedPriceOfflineCombinedOrderStatus =
  FixedPriceCoordinatorCombinedOrderStatus<
    FixedPriceOfflineProtocolBinding,
    FixedPriceOfflineSimulationOutcome,
    FixedPriceOfflineSimulationErrorClass,
    Exclude<
      FixedPriceOfflineSimulationMilestone,
      "simulation-audit-exercised"
    >,
    FixedPriceOfflineSimulationMilestone,
    FixedPriceOfflineSimulationAuthority
  >;

interface FixedPriceCoordinatorWorkReportBase<
  Outcome extends string,
  OperationStatus extends string,
> {
  jobId: string;
  track: FixedPriceX402Track;
  status:
    | OperationStatus
    | "waiting"
    | "stale"
    | "skipped";
  outcome?: Outcome;
  reasonCode?: string;
}

type FixedPriceCoordinatorWorkReport<
  Outcome extends string,
  OperationStatus extends string,
  Authority extends object,
> = FixedPriceCoordinatorWorkReportBase<Outcome, OperationStatus> & Authority;

export interface FixedPriceX402WorkReport
  extends FixedPriceCoordinatorWorkReportBase<
    FixedPriceX402NormativeOutcome,
    FixedPriceX402TrackOperationResult["status"]
  > {}

export type FixedPriceOfflineWorkReport = FixedPriceCoordinatorWorkReport<
  FixedPriceOfflineSimulationOutcome,
  FixedPriceOfflineTrackOperationResult["status"],
  FixedPriceOfflineSimulationAuthority
>;

interface FixedPriceCommerceCoordinator<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  OrderStatus,
  WorkReport,
> {
  readonly role: FixedPriceX402CoordinatorRole;
  startOrder(
    order: Readonly<FixedPriceCoordinatorOrderInput<Protocol>>,
  ): Promise<OrderStatus>;
  getOrderStatus(
    jobId: string,
  ): Promise<OrderStatus | null>;
  runPending(options?: Readonly<{
    cursor?: string;
    limit?: number;
    signal?: AbortSignal;
  }>): Promise<FixedPriceX402Page<WorkReport>>;
  resumePendingOrders(options?: Readonly<{
    cursor?: string;
    limit?: number;
    signal?: AbortSignal;
  }>): Promise<FixedPriceX402Page<WorkReport>>;
  repairTrack(input: Readonly<{
    jobId: string;
    track: FixedPriceX402Track;
    operatorReasonCode: string;
    retryAt?: number;
  }>): Promise<OrderStatus>;
}

export interface FixedPriceX402CommerceCoordinator
  extends FixedPriceCommerceCoordinator<
    FixedPriceX402ProtocolBinding,
    FixedPriceX402OrderStatus,
    FixedPriceX402WorkReport
  > {}

export interface FixedPriceOfflineCommerceCoordinator
  extends FixedPriceCommerceCoordinator<
    FixedPriceOfflineProtocolBinding,
    FixedPriceOfflineOrderStatus,
    FixedPriceOfflineWorkReport
  > {}

export type FixedPriceOfflineCoordinatorRole = FixedPriceX402CoordinatorRole;
export type FixedPriceOfflineTrack = FixedPriceX402Track;
export type FixedPriceOfflineTrackState = FixedPriceX402TrackState;
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
const X402_ERROR_CLASSES = new Set<FixedPriceX402ErrorClass>([
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
const OFFLINE_SIMULATION_ERROR_CLASSES =
  new Set<FixedPriceOfflineSimulationErrorClass>([
    "simulated-permanent",
    "simulated-transient",
    "simulated-counterparty",
    "simulated-substrate",
    "simulated-settlement-atomicity",
  ]);
const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_RUN_LIMIT = 10;
const INERT_RECEIVER = Object.freeze(Object.create(null)) as object;

interface FixedPriceCoordinatorMilestoneVocabulary<
  LocalMilestone extends string,
  CombinedMilestone extends string,
> {
  created: LocalMilestone & CombinedMilestone;
  agreementFinal: LocalMilestone & CombinedMilestone;
  paymentFinal: LocalMilestone & CombinedMilestone;
  deliveryReady: LocalMilestone & CombinedMilestone;
  buyerReceived: LocalMilestone & CombinedMilestone;
  performanceComplete: LocalMilestone & CombinedMilestone;
  actorAuditFinal: LocalMilestone & CombinedMilestone;
  auditComplete: CombinedMilestone;
  terminalFailure: LocalMilestone & CombinedMilestone;
  terminalAborted: LocalMilestone & CombinedMilestone;
}

interface FixedPriceCoordinatorIdentityPolicy<
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

interface FixedPriceCoordinatorProfilePolicy<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
  LocalMilestone extends string,
  CombinedMilestone extends string,
  Authority extends object,
> extends FixedPriceCoordinatorIdentityPolicy<Protocol> {
  readonly outcomes: Readonly<{
    success: Outcome;
    failure: Outcome;
    aborted: Outcome;
  }>;
  readonly errorClasses: ReadonlySet<ErrorClass>;
  readonly milestones: Readonly<
    FixedPriceCoordinatorMilestoneVocabulary<LocalMilestone, CombinedMilestone>
  >;
  readonly statusAuthority: Readonly<Authority>;
  readonly requiresDacs5Attribution: boolean;
  readonly invalidOutcomeReasonCode:
    | "invalid-normative-outcome"
    | "invalid-simulation-outcome";
}

const X402_PROFILE_POLICY: FixedPriceCoordinatorProfilePolicy<
  FixedPriceX402ProtocolBinding,
  FixedPriceX402NormativeOutcome,
  FixedPriceX402ErrorClass,
  Exclude<FixedPriceX402Milestone, "audit-complete">,
  FixedPriceX402Milestone,
  Record<never, never>
> = Object.freeze({
  label: "fixed-price x402",
  outcomes: Object.freeze({
    success: "success",
    failure: "failure",
    aborted: "aborted",
  }),
  errorClasses: X402_ERROR_CLASSES,
  milestones: Object.freeze({
    created: "created",
    agreementFinal: "agreement-final",
    paymentFinal: "payment-final",
    deliveryReady: "delivery-ready",
    buyerReceived: "buyer-received",
    performanceComplete: "commercial-performance-complete",
    actorAuditFinal: "actor-audit-final",
    auditComplete: "audit-complete",
    terminalFailure: "terminal-failure",
    terminalAborted: "terminal-aborted",
  }),
  statusAuthority: Object.freeze({}),
  requiresDacs5Attribution: true,
  invalidOutcomeReasonCode: "invalid-normative-outcome",
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
  FixedPriceOfflineProtocolBinding,
  FixedPriceOfflineSimulationOutcome,
  FixedPriceOfflineSimulationErrorClass,
  Exclude<
    FixedPriceOfflineSimulationMilestone,
    "simulation-audit-exercised"
  >,
  FixedPriceOfflineSimulationMilestone,
  FixedPriceOfflineSimulationAuthority
> = Object.freeze({
  label: "fixed-price offline",
  outcomes: Object.freeze({
    success: "simulated-success",
    failure: "simulated-failure",
    aborted: "simulated-aborted",
  }),
  errorClasses: OFFLINE_SIMULATION_ERROR_CLASSES,
  milestones: Object.freeze({
    created: "simulation-created",
    agreementFinal: "simulation-agreement-exercised",
    paymentFinal: "simulation-payment-exercised",
    deliveryReady: "simulation-delivery-ready",
    buyerReceived: "simulation-buyer-received",
    performanceComplete: "simulation-performance-exercised",
    actorAuditFinal: "simulation-actor-audit-exercised",
    auditComplete: "simulation-audit-exercised",
    terminalFailure: "simulation-terminal-failure",
    terminalAborted: "simulation-terminal-aborted",
  }),
  statusAuthority: Object.freeze({
    simulationOnly: true,
    normativeConformance: false,
    commercialSuccess: false,
    authority: "none",
  }),
  requiresDacs5Attribution: false,
  invalidOutcomeReasonCode: "invalid-simulation-outcome",
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
  policy: FixedPriceCoordinatorIdentityPolicy<Protocol>,
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
  policy: FixedPriceCoordinatorIdentityPolicy<Protocol>,
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
  policy: FixedPriceCoordinatorIdentityPolicy<Protocol>,
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

function emptyTracks<Outcome extends string, ErrorClass extends string>(
  role: FixedPriceX402CoordinatorRole,
  now: number,
): Partial<
  Record<
    FixedPriceX402Track,
    FixedPriceCoordinatorTrackRecord<Outcome, ErrorClass>
  >
> {
  return Object.fromEntries(roleTracks(role).map((track) => [
    track,
    { state: "not-started", generation: 0, attempts: 0, updatedAt: now },
  ])) as Partial<
    Record<
      FixedPriceX402Track,
      FixedPriceCoordinatorTrackRecord<Outcome, ErrorClass>
    >
  >;
}

function validLease(value: unknown): value is FixedPriceX402TrackLease {
  return plainRecord(value) && exactKeys(value, ["owner", "generation", "expiresAt"]) &&
    nonEmpty(value.owner) && safeUint(value.generation) && value.generation > 0 &&
    safeUint(value.expiresAt);
}

function validTrackRecord<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
  LocalMilestone extends string,
  CombinedMilestone extends string,
  Authority extends object,
>(
  value: unknown,
  policy: FixedPriceCoordinatorProfilePolicy<
    Protocol,
    Outcome,
    ErrorClass,
    LocalMilestone,
    CombinedMilestone,
    Authority
  >,
): value is FixedPriceCoordinatorTrackRecord<Outcome, ErrorClass> {
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
      (value.outcome !== undefined && ![
        policy.outcomes.success,
        policy.outcomes.failure,
        policy.outcomes.aborted,
      ].includes(value.outcome as Outcome)) ||
      (value.errorClass !== undefined &&
        !policy.errorClasses.has(value.errorClass as ErrorClass)) ||
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
      (policy.requiresDacs5Attribution
        ? ((value.outcome === policy.outcomes.failure &&
              value.errorClass !== undefined &&
              value.faultedParty !== undefined &&
              value.withdrawnBy === undefined) ||
            (value.outcome === policy.outcomes.aborted &&
              value.errorClass === undefined &&
              value.faultedParty === undefined &&
              value.withdrawnBy !== undefined) ||
            (value.outcome === policy.outcomes.success &&
              value.errorClass === undefined &&
              value.faultedParty === undefined &&
              value.withdrawnBy === undefined))
        : (value.faultedParty === undefined &&
            value.withdrawnBy === undefined &&
            ((value.outcome === policy.outcomes.failure &&
                value.errorClass !== undefined) ||
              (value.outcome !== policy.outcomes.failure &&
                value.errorClass === undefined))));
  }
  return value.lease === undefined && value.reference === undefined &&
    value.authenticationHash === undefined && value.outcome === undefined &&
    value.errorClass === undefined && value.faultedParty === undefined &&
    value.withdrawnBy === undefined && value.reasonCode !== undefined &&
    (value.state !== "operator-action" || value.nextAttemptAt === undefined);
}

function trackRecord<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
>(
  record: Readonly<
    FixedPriceCoordinatorOrderRecord<Protocol, Outcome, ErrorClass>
  >,
  track: FixedPriceX402Track,
): Readonly<FixedPriceCoordinatorTrackRecord<Outcome, ErrorClass>> | undefined {
  return record.tracks[track];
}

function final<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
>(
  record: Readonly<
    FixedPriceCoordinatorOrderRecord<Protocol, Outcome, ErrorClass>
  >,
  track: FixedPriceX402Track,
): boolean {
  return trackRecord(record, track)?.state === "final";
}

function successful<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
  LocalMilestone extends string,
  CombinedMilestone extends string,
  Authority extends object,
>(
  record: Readonly<
    FixedPriceCoordinatorOrderRecord<Protocol, Outcome, ErrorClass>
  >,
  track: FixedPriceX402Track,
  policy: FixedPriceCoordinatorProfilePolicy<
    Protocol,
    Outcome,
    ErrorClass,
    LocalMilestone,
    CombinedMilestone,
    Authority
  >,
): boolean {
  const retained = trackRecord(record, track);
  return retained?.state === "final" &&
    retained.outcome === policy.outcomes.success;
}

type FixedPriceCoordinatorTerminalPhaseResult<
  Outcome extends string,
  ErrorClass extends string,
> = Readonly<{
  outcome: Outcome;
  errorClass?: ErrorClass;
  faultedParty?: FixedPriceX402FaultedParty;
  withdrawnBy?: FixedPriceX402CoordinatorRole;
}>;

function terminalPhaseResult<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
  LocalMilestone extends string,
  CombinedMilestone extends string,
  Authority extends object,
>(
  record: Readonly<
    FixedPriceCoordinatorOrderRecord<Protocol, Outcome, ErrorClass>
  >,
  policy: FixedPriceCoordinatorProfilePolicy<
    Protocol,
    Outcome,
    ErrorClass,
    LocalMilestone,
    CombinedMilestone,
    Authority
  >,
): FixedPriceCoordinatorTerminalPhaseResult<Outcome, ErrorClass> | null {
  const tracks: readonly FixedPriceX402Track[] = record.role === "buyer"
    ? ["agreement", "payment", "buyer-received"]
    : ["agreement", "payment", "delivery"];
  for (const track of tracks) {
    const retained = trackRecord(record, track);
    if (retained?.state === "final" &&
        retained.outcome !== policy.outcomes.success) {
      return retained.outcome === policy.outcomes.failure
        ? {
            outcome: policy.outcomes.failure,
            errorClass: retained.errorClass!,
            ...(retained.faultedParty === undefined
              ? {}
              : { faultedParty: retained.faultedParty }),
          }
        : {
            outcome: policy.outcomes.aborted,
            ...(retained.withdrawnBy === undefined
              ? {}
              : { withdrawnBy: retained.withdrawnBy }),
          };
    }
  }
  return null;
}

function eligible<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
  LocalMilestone extends string,
  CombinedMilestone extends string,
  Authority extends object,
>(
  record: Readonly<
    FixedPriceCoordinatorOrderRecord<Protocol, Outcome, ErrorClass>
  >,
  track: FixedPriceX402Track,
  policy: FixedPriceCoordinatorProfilePolicy<
    Protocol,
    Outcome,
    ErrorClass,
    LocalMilestone,
    CombinedMilestone,
    Authority
  >,
): boolean {
  if (!roleTracks(record.role).includes(track)) return false;
  switch (track) {
    case "agreement":
      return true;
    case "payment":
      return successful(record, "agreement", policy);
    case "payment-evidence":
      return final(record, "payment");
    case "delivery":
      return record.role === "seller" && successful(record, "payment", policy);
    case "buyer-received":
      return record.role === "buyer" && successful(record, "payment", policy);
    case "delivery-evidence":
      return record.role === "seller" && final(record, "delivery");
    case "audit": {
      const agreement = trackRecord(record, "agreement");
      if (agreement?.state === "final" &&
          agreement.outcome !== policy.outcomes.success) return true;
      const payment = trackRecord(record, "payment");
      if (payment?.state === "final" &&
          payment.outcome !== policy.outcomes.success) {
        return successful(record, "payment-evidence", policy);
      }
      if (record.role === "buyer") {
        return successful(record, "payment-evidence", policy) &&
          final(record, "buyer-received");
      }
      return successful(record, "payment-evidence", policy) &&
        successful(record, "delivery-evidence", policy);
    }
  }
}

function trackResultAllowed<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
  LocalMilestone extends string,
  CombinedMilestone extends string,
  Authority extends object,
>(
  record: Readonly<
    FixedPriceCoordinatorOrderRecord<Protocol, Outcome, ErrorClass>
  >,
  track: FixedPriceX402Track,
  result: Readonly<{
    outcome: Outcome;
    errorClass?: ErrorClass;
    faultedParty?: FixedPriceX402FaultedParty;
    withdrawnBy?: FixedPriceX402CoordinatorRole;
  }>,
  policy: FixedPriceCoordinatorProfilePolicy<
    Protocol,
    Outcome,
    ErrorClass,
    LocalMilestone,
    CombinedMilestone,
    Authority
  >,
): boolean {
  if (policy.requiresDacs5Attribution &&
      result.outcome === policy.outcomes.failure &&
      (result.faultedParty === "orchestrator" ||
        (result.errorClass === "substrate") !== (result.faultedParty === "none"))) {
    // This profile has no distinct orchestrator party. DACS-5 §10.4.1 makes
    // failed-substrate neutral and every other failure party-attributed.
    return false;
  }
  if (track === "payment-evidence" || track === "delivery-evidence") {
    return result.outcome === policy.outcomes.success;
  }
  if (track === "audit") {
    const expected = terminalPhaseResult(record, policy) ?? {
      outcome: policy.outcomes.success,
    };
    return result.outcome === expected.outcome &&
      (expected.outcome !== policy.outcomes.failure ||
        (result.errorClass === expected.errorClass &&
          (!policy.requiresDacs5Attribution ||
            result.faultedParty === expected.faultedParty))) &&
      (expected.outcome !== policy.outcomes.aborted ||
        !policy.requiresDacs5Attribution ||
        result.withdrawnBy === expected.withdrawnBy);
  }
  // DACS-5 §10.3.1 ST-3: a rail-final payment or irreversible delivery can
  // never be relabelled as an abort by a later operational callback.
  if (result.outcome === policy.outcomes.aborted &&
      (successful(record, "payment", policy) ||
        successful(record, "delivery", policy))) return false;
  return true;
}

function dependencyViolation<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
  LocalMilestone extends string,
  CombinedMilestone extends string,
  Authority extends object,
>(
  record: Readonly<
    FixedPriceCoordinatorOrderRecord<Protocol, Outcome, ErrorClass>
  >,
  policy: FixedPriceCoordinatorProfilePolicy<
    Protocol,
    Outcome,
    ErrorClass,
    LocalMilestone,
    CombinedMilestone,
    Authority
  >,
): string | null {
  for (const track of roleTracks(record.role)) {
    const retained = record.tracks[track];
    if (!retained || retained.state === "not-started") continue;
    if (!eligible(record, track, policy)) {
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
        }, policy)) {
      return `${policy.label} ${track} outcome contradicts its terminal path`;
    }
  }
  return null;
}

function fixedPriceCoordinatorOrderViolation<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
  LocalMilestone extends string,
  CombinedMilestone extends string,
  Authority extends object,
>(
  value: unknown,
  policy: FixedPriceCoordinatorProfilePolicy<
    Protocol,
    Outcome,
    ErrorClass,
    LocalMilestone,
    CombinedMilestone,
    Authority
  >,
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
    if (!validTrackRecord(retained, policy) ||
        retained.updatedAt < value.createdAt ||
        retained.updatedAt > value.updatedAt) {
      return `coordinator ${track} track is malformed`;
    }
  }
  return dependencyViolation(
    value as unknown as FixedPriceCoordinatorOrderRecord<
      Protocol,
      Outcome,
      ErrorClass
    >,
    policy,
  );
}

export function fixedPriceX402OrderViolation(value: unknown): string | null {
  return fixedPriceCoordinatorOrderViolation(value, X402_PROFILE_POLICY);
}

export function fixedPriceOfflineOrderViolation(value: unknown): string | null {
  return fixedPriceCoordinatorOrderViolation(value, OFFLINE_PROFILE_POLICY);
}

function copyRecord<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
>(
  record: Readonly<
    FixedPriceCoordinatorOrderRecord<Protocol, Outcome, ErrorClass>
  >,
): FixedPriceCoordinatorOrderRecord<Protocol, Outcome, ErrorClass> {
  return clone(record);
}

function requireCoordinatorRecord<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
  LocalMilestone extends string,
  CombinedMilestone extends string,
  Authority extends object,
>(
  value: unknown,
  role: FixedPriceX402CoordinatorRole,
  policy: FixedPriceCoordinatorProfilePolicy<
    Protocol,
    Outcome,
    ErrorClass,
    LocalMilestone,
    CombinedMilestone,
    Authority
  >,
  expectedBindingHash?: string,
  expectedLocalBindingHash?: string,
): FixedPriceCoordinatorOrderRecord<Protocol, Outcome, ErrorClass> {
  const violation = fixedPriceCoordinatorOrderViolation(value, policy);
  if (violation) throw new DacsError(violation);
  const record = clone(value as FixedPriceCoordinatorOrderRecord<
    Protocol,
    Outcome,
    ErrorClass
  >);
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

function isRunnableTrack<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
  LocalMilestone extends string,
  CombinedMilestone extends string,
  Authority extends object,
>(
  record: Readonly<
    FixedPriceCoordinatorOrderRecord<Protocol, Outcome, ErrorClass>
  >,
  track: FixedPriceX402Track,
  now: number,
  policy: FixedPriceCoordinatorProfilePolicy<
    Protocol,
    Outcome,
    ErrorClass,
    LocalMilestone,
    CombinedMilestone,
    Authority
  >,
): boolean {
  const retained = trackRecord(record, track);
  if (!retained || !eligible(record, track, policy) ||
      retained.state === "final" ||
      retained.state === "operator-action") return false;
  if (retained.nextAttemptAt !== undefined && retained.nextAttemptAt > now) return false;
  return retained.lease === undefined || retained.lease.expiresAt <= now;
}

function createInMemoryFixedPriceCoordinatorStore<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
  OperationResult extends FixedPriceCoordinatorOperationResult,
  LocalMilestone extends string,
  CombinedMilestone extends string,
  Authority extends object,
>(
  policy: FixedPriceCoordinatorProfilePolicy<
    Protocol,
    Outcome,
    ErrorClass,
    LocalMilestone,
    CombinedMilestone,
    Authority
  >,
  options: Readonly<{ now?: () => number }> = {},
): FixedPriceCoordinatorStore<
  Protocol,
  Outcome,
  ErrorClass,
  OperationResult
> {
  if (!plainRecord(options) || !exactKeys(options, [], ["now"]) ||
      (options.now !== undefined && typeof options.now !== "function")) {
    throw new DacsError("in-memory coordinator store options are malformed");
  }
  const clock = options.now ?? Date.now;
  const records = new Map<
    string,
    FixedPriceCoordinatorOrderRecord<Protocol, Outcome, ErrorClass>
  >();
  const readTime = (): number => {
    const value = Reflect.apply(clock, INERT_RECEIVER, []);
    if (!safeUint(value)) throw new DacsError("coordinator store clock is invalid");
    return value;
  };
  const stamp = (
    record: Readonly<
      FixedPriceCoordinatorOrderRecord<Protocol, Outcome, ErrorClass>
    >,
    value = readTime(),
  ): number =>
    Math.max(record.updatedAt, value);
  const loadRecord = (
    role: FixedPriceX402CoordinatorRole,
    jobId: string,
  ): FixedPriceCoordinatorOrderLoad<Protocol, Outcome, ErrorClass> => {
    const found = records.get(key(role, jobId));
    if (!found) return { status: "missing" };
    const violation = fixedPriceCoordinatorOrderViolation(found, policy);
    return violation
      ? { status: "corrupt", reason: violation }
      : { status: "ok", record: copyRecord(found) };
  };
  const save = (
    current: Readonly<
      FixedPriceCoordinatorOrderRecord<Protocol, Outcome, ErrorClass>
    >,
    next: FixedPriceCoordinatorOrderRecord<Protocol, Outcome, ErrorClass>,
  ): FixedPriceCoordinatorOrderRecord<Protocol, Outcome, ErrorClass> => {
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
      const record: FixedPriceCoordinatorOrderRecord<
        Protocol,
        Outcome,
        ErrorClass
      > = {
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
          input.tracks.some((track) =>
            isRunnableTrack(record, track, now, policy)
          ))
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
      if (!eligible(current, input.track, policy) ||
          retained.state === "final" ||
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
        Record<
          FixedPriceX402Track,
          FixedPriceCoordinatorTrackRecord<Outcome, ErrorClass>
        >
      >;
      tracks[input.track] = {
        state: "running",
        generation: lease.generation,
        attempts: retained.attempts + 1,
        updatedAt: stamp(current, now),
        lease,
      };
      const next: FixedPriceCoordinatorOrderRecord<
        Protocol,
        Outcome,
        ErrorClass
      > = {
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
      let result: OperationResult;
      try {
        result = captureOperationResult<
          Protocol,
          Outcome,
          ErrorClass,
          LocalMilestone,
          CombinedMilestone,
          Authority,
          OperationResult
        >(input.result, policy);
      } catch {
        return { status: "conflict" };
      }
      if (result.status === "final" &&
          !trackResultAllowed(
            current,
            input.track,
            result as unknown as Readonly<{
              outcome: Outcome;
              errorClass?: ErrorClass;
            }>,
            policy,
          )) {
        return { status: "conflict" };
      }
      const updatedAt = stamp(current, now);
      const nextTrack: FixedPriceCoordinatorTrackRecord<Outcome, ErrorClass> =
        result.status === "final"
        ? {
            state: "final",
            generation: retained.generation,
            attempts: retained.attempts,
            updatedAt,
            reference: result.reference,
            outcome: result.outcome as Outcome,
            ...(result.authenticationHash
              ? { authenticationHash: result.authenticationHash }
              : {}),
            ...(result.outcome === policy.outcomes.failure
              ? {
                  errorClass: (
                    result as unknown as Readonly<{ errorClass: ErrorClass }>
                  ).errorClass,
                }
              : {}),
            ...(policy.requiresDacs5Attribution &&
                result.outcome === policy.outcomes.failure
              ? {
                  faultedParty: (
                    result as unknown as Readonly<{
                      faultedParty: FixedPriceX402FaultedParty;
                    }>
                  ).faultedParty,
                }
              : {}),
            ...(policy.requiresDacs5Attribution &&
                result.outcome === policy.outcomes.aborted
              ? {
                  withdrawnBy: (
                    result as unknown as Readonly<{
                      withdrawnBy: FixedPriceX402CoordinatorRole;
                    }>
                  ).withdrawnBy,
                }
              : {}),
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
        Record<
          FixedPriceX402Track,
          FixedPriceCoordinatorTrackRecord<Outcome, ErrorClass>
        >
      >;
      tracks[input.track] = nextTrack;
      const next: FixedPriceCoordinatorOrderRecord<
        Protocol,
        Outcome,
        ErrorClass
      > = {
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
        Record<
          FixedPriceX402Track,
          FixedPriceCoordinatorTrackRecord<Outcome, ErrorClass>
        >
      >;
      tracks[input.track] = {
        state: "pending-retry",
        generation: retained.generation,
        attempts: retained.attempts,
        updatedAt,
        reasonCode: input.operatorReasonCode,
        ...(input.retryAt === undefined ? {} : { nextAttemptAt: input.retryAt }),
      };
      const next: FixedPriceCoordinatorOrderRecord<
        Protocol,
        Outcome,
        ErrorClass
      > = {
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
  return createInMemoryFixedPriceCoordinatorStore<
    FixedPriceX402ProtocolBinding,
    FixedPriceX402NormativeOutcome,
    FixedPriceX402ErrorClass,
    FixedPriceX402TrackOperationResult,
    Exclude<FixedPriceX402Milestone, "audit-complete">,
    FixedPriceX402Milestone,
    Record<never, never>
  >(X402_PROFILE_POLICY, options);
}

export function createInMemoryFixedPriceOfflineCoordinatorStore(
  options: Readonly<{ now?: () => number }> = {},
): FixedPriceOfflineCoordinatorStore {
  return createInMemoryFixedPriceCoordinatorStore<
    FixedPriceOfflineProtocolBinding,
    FixedPriceOfflineSimulationOutcome,
    FixedPriceOfflineSimulationErrorClass,
    FixedPriceOfflineTrackOperationResult,
    Exclude<
      FixedPriceOfflineSimulationMilestone,
      "simulation-audit-exercised"
    >,
    FixedPriceOfflineSimulationMilestone,
    FixedPriceOfflineSimulationAuthority
  >(OFFLINE_PROFILE_POLICY, options);
}

function captureOperationResult<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
  LocalMilestone extends string,
  CombinedMilestone extends string,
  Authority extends object,
  OperationResult extends FixedPriceCoordinatorOperationResult =
    FixedPriceCoordinatorOperationResult,
>(
  value: unknown,
  policy: FixedPriceCoordinatorProfilePolicy<
    Protocol,
    Outcome,
    ErrorClass,
    LocalMilestone,
    CombinedMilestone,
    Authority
  >,
): OperationResult {
  const result = captureOwnData(value, "coordinator operation result") as unknown as
    Record<string, unknown>;
  if (result.status === "final" &&
      result.outcome === policy.outcomes.success && exactKeys(
        result,
        ["status", "outcome", "reference"],
        ["authenticationHash"],
      ) && nonEmpty(result.reference) &&
      (result.authenticationHash === undefined ||
        (typeof result.authenticationHash === "string" && HASH_RE.test(result.authenticationHash)))) {
    return result as unknown as OperationResult;
  }
  if (result.status === "final" &&
      result.outcome === policy.outcomes.aborted && exactKeys(
    result,
    policy.requiresDacs5Attribution
      ? ["status", "outcome", "withdrawnBy", "reference"]
      : ["status", "outcome", "reference"],
    ["authenticationHash"],
  ) && (!policy.requiresDacs5Attribution ||
        result.withdrawnBy === "buyer" || result.withdrawnBy === "seller") &&
      nonEmpty(result.reference) &&
      (result.authenticationHash === undefined ||
        (typeof result.authenticationHash === "string" && HASH_RE.test(result.authenticationHash)))) {
    return result as unknown as OperationResult;
  }
  if (result.status === "final" &&
      result.outcome === policy.outcomes.failure && exactKeys(
    result,
    policy.requiresDacs5Attribution
      ? ["status", "outcome", "errorClass", "faultedParty", "reference"]
      : ["status", "outcome", "errorClass", "reference"],
    ["authenticationHash"],
  ) && policy.errorClasses.has(result.errorClass as ErrorClass) &&
      (!policy.requiresDacs5Attribution ||
        FAULTED_PARTIES.has(result.faultedParty as FixedPriceX402FaultedParty)) &&
      nonEmpty(result.reference) &&
      (result.authenticationHash === undefined ||
        (typeof result.authenticationHash === "string" && HASH_RE.test(result.authenticationHash)))) {
    return result as unknown as OperationResult;
  }
  if ((result.status === "pending-retry" || result.status === "indeterminate") &&
      exactKeys(result, ["status", "reasonCode", "retryAt"]) &&
      validReasonCode(result.reasonCode) && safeUint(result.retryAt)) {
    return result as unknown as OperationResult;
  }
  if (result.status === "operator-action" &&
      exactKeys(result, ["status", "reasonCode"]) && validReasonCode(result.reasonCode)) {
    return result as unknown as OperationResult;
  }
  throw new DacsError(`${policy.label} coordinator operation result is malformed`);
}

function projectLocalMilestone<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
  LocalMilestone extends string,
  CombinedMilestone extends string,
  Authority extends object,
>(
  record: Readonly<
    FixedPriceCoordinatorOrderRecord<Protocol, Outcome, ErrorClass>
  >,
  policy: FixedPriceCoordinatorProfilePolicy<
    Protocol,
    Outcome,
    ErrorClass,
    LocalMilestone,
    CombinedMilestone,
    Authority
  >,
): LocalMilestone {
  const terminal = terminalPhaseResult(record, policy);
  if (terminal) {
    return terminal.outcome === policy.outcomes.failure
      ? policy.milestones.terminalFailure
      : policy.milestones.terminalAborted;
  }
  const audit = trackRecord(record, "audit");
  if (audit?.state === "final") {
    if (audit.outcome === policy.outcomes.failure) {
      return policy.milestones.terminalFailure;
    }
    if (audit.outcome === policy.outcomes.aborted) {
      return policy.milestones.terminalAborted;
    }
    return policy.milestones.actorAuditFinal;
  }
  if (record.role === "seller" &&
      successful(record, "delivery-evidence", policy)) {
    return policy.milestones.performanceComplete;
  }
  if (record.role === "buyer" &&
      successful(record, "buyer-received", policy)) {
    return policy.milestones.buyerReceived;
  }
  if (record.role === "seller" && successful(record, "delivery", policy)) {
    return policy.milestones.deliveryReady;
  }
  if (successful(record, "payment", policy)) return policy.milestones.paymentFinal;
  if (successful(record, "agreement", policy)) {
    return policy.milestones.agreementFinal;
  }
  return policy.milestones.created;
}

/** Local projections never claim global `audit-complete`. */
export function projectFixedPriceX402Milestone(
  record: Readonly<FixedPriceX402OrderRecord>,
): Exclude<FixedPriceX402Milestone, "audit-complete"> {
  const retained = requireCoordinatorRecord(record, record.role, X402_PROFILE_POLICY);
  return projectLocalMilestone(retained, X402_PROFILE_POLICY);
}

/** Simulation projections never claim live commercial or global audit completion. */
export function projectFixedPriceOfflineMilestone(
  record: Readonly<FixedPriceOfflineOrderRecord>,
): Exclude<
  FixedPriceOfflineSimulationMilestone,
  "simulation-audit-exercised"
> {
  const retained = requireCoordinatorRecord(record, record.role, OFFLINE_PROFILE_POLICY);
  return projectLocalMilestone(retained, OFFLINE_PROFILE_POLICY);
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
  Outcome extends string,
  ErrorClass extends string,
  LocalMilestone extends string,
  CombinedMilestone extends string,
  Authority extends object,
>(
  value: unknown,
  policy: FixedPriceCoordinatorProfilePolicy<
    Protocol,
    Outcome,
    ErrorClass,
    LocalMilestone,
    CombinedMilestone,
    Authority
  >,
): string | null {
  const authorityKeys = Object.keys(policy.statusAuthority);
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
    ...authorityKeys,
  ])) return "coordinator status fields are malformed";
  for (const authorityKey of authorityKeys) {
    if (value[authorityKey] !==
        (policy.statusAuthority as Readonly<Record<string, unknown>>)[authorityKey]) {
      return `${policy.label} coordinator authority markers are malformed`;
    }
  }
  const recordViolation = fixedPriceCoordinatorOrderViolation(statusAsRecord(value), policy);
  if (recordViolation) return recordViolation;
  const record = statusAsRecord(value) as FixedPriceCoordinatorOrderRecord<
    Protocol,
    Outcome,
    ErrorClass
  >;
  const projected = projectLocalMilestone(record, policy);
  if (value.milestone !== projected ||
      value.milestone === policy.milestones.auditComplete) {
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

function projectStatus<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
  LocalMilestone extends string,
  CombinedMilestone extends string,
  Authority extends object,
>(
  record: Readonly<
    FixedPriceCoordinatorOrderRecord<Protocol, Outcome, ErrorClass>
  >,
  policy: FixedPriceCoordinatorProfilePolicy<
    Protocol,
    Outcome,
    ErrorClass,
    LocalMilestone,
    CombinedMilestone,
    Authority
  >,
): FixedPriceCoordinatorOrderStatus<
  Protocol,
  Outcome,
  ErrorClass,
  LocalMilestone,
  Authority
> {
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
    milestone: projectLocalMilestone(retained, policy),
    attention: {
      required: attentionTracks.length > 0,
      tracks: attentionTracks,
    },
    revision: retained.revision,
    updatedAt: retained.updatedAt,
    ...policy.statusAuthority,
  });
}

function captureOptions<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
  OperationResult,
  LocalMilestone extends string,
  CombinedMilestone extends string,
  Authority extends object,
>(
  value: unknown,
  policy: FixedPriceCoordinatorProfilePolicy<
    Protocol,
    Outcome,
    ErrorClass,
    LocalMilestone,
    CombinedMilestone,
    Authority
  >,
): {
  role: FixedPriceX402CoordinatorRole;
  store: FixedPriceCoordinatorStore<Protocol, Outcome, ErrorClass, OperationResult>;
  workerId: string;
  operations: Map<
    FixedPriceX402Track,
    FixedPriceCoordinatorTrackOperation<
      Protocol,
      Outcome,
      ErrorClass,
      OperationResult
    >
  >;
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
  const store = value.store as unknown as FixedPriceCoordinatorStore<
    Protocol,
    Outcome,
    ErrorClass,
    OperationResult
  >;
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
    FixedPriceCoordinatorTrackOperation<
      Protocol,
      Outcome,
      ErrorClass,
      OperationResult
    >
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
      value.operations[operationKey] as FixedPriceCoordinatorTrackOperation<
        Protocol,
        Outcome,
        ErrorClass,
        OperationResult
      >,
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
  Outcome extends string,
  ErrorClass extends string,
  LocalMilestone extends string,
  CombinedMilestone extends string,
  Authority extends object,
>(input: Readonly<{
  buyer: Readonly<FixedPriceCoordinatorOrderStatus<
    Protocol,
    Outcome,
    ErrorClass,
    LocalMilestone,
    Authority
  >>;
  seller: Readonly<FixedPriceCoordinatorOrderStatus<
    Protocol,
    Outcome,
    ErrorClass,
    LocalMilestone,
    Authority
  >>;
}>, policy: FixedPriceCoordinatorProfilePolicy<
  Protocol,
  Outcome,
  ErrorClass,
  LocalMilestone,
  CombinedMilestone,
  Authority
>): FixedPriceCoordinatorCombinedOrderStatus<
  Protocol,
  Outcome,
  ErrorClass,
  LocalMilestone,
  CombinedMilestone,
  Authority
> {
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
  const buyerRecord = statusAsRecord(buyer) as FixedPriceCoordinatorOrderRecord<
    Protocol,
    Outcome,
    ErrorClass
  >;
  const sellerRecord = statusAsRecord(seller) as FixedPriceCoordinatorOrderRecord<
    Protocol,
    Outcome,
    ErrorClass
  >;
  const buyerTerminal = terminalPhaseResult(buyerRecord, policy);
  const sellerTerminal = terminalPhaseResult(sellerRecord, policy);
  const buyerAudit = buyer.tracks.audit;
  const sellerAudit = seller.tracks.audit;
  let milestone: CombinedMilestone;
  if (buyerTerminal && sellerTerminal && buyerTerminal.outcome !== sellerTerminal.outcome) {
    throw new DacsError("actor terminal outcomes contradict the shared terminal session");
  }
  if (buyerTerminal?.outcome === policy.outcomes.failure &&
      sellerTerminal?.outcome === policy.outcomes.failure &&
      (buyerTerminal.errorClass !== sellerTerminal.errorClass ||
        (policy.requiresDacs5Attribution &&
          buyerTerminal.faultedParty !== sellerTerminal.faultedParty))) {
    throw new DacsError(
      "actor terminal failure attribution contradicts the shared operational session",
    );
  }
  if (policy.requiresDacs5Attribution &&
      buyerTerminal?.outcome === policy.outcomes.aborted &&
      sellerTerminal?.outcome === policy.outcomes.aborted &&
      buyerTerminal.withdrawnBy !== sellerTerminal.withdrawnBy) {
    throw new DacsError(
      "actor terminal withdrawal attribution contradicts the shared operational session",
    );
  }
  const terminalAuditContradicts = (
    terminal: FixedPriceCoordinatorTerminalPhaseResult<Outcome, ErrorClass> | null,
    audit: Readonly<FixedPriceCoordinatorTrackRecord<Outcome, ErrorClass>> | undefined,
  ): boolean => terminal !== null && audit?.state === "final" &&
    (audit.outcome !== terminal.outcome ||
      (terminal.outcome === policy.outcomes.failure &&
        (audit.errorClass !== terminal.errorClass ||
          (policy.requiresDacs5Attribution &&
            audit.faultedParty !== terminal.faultedParty))) ||
      (policy.requiresDacs5Attribution &&
        terminal.outcome === policy.outcomes.aborted &&
        audit.withdrawnBy !== terminal.withdrawnBy));
  if (terminalAuditContradicts(buyerTerminal, sellerAudit) ||
      terminalAuditContradicts(sellerTerminal, buyerAudit)) {
    throw new DacsError("actor terminal outcomes contradict the shared terminal session");
  }
  const terminal = buyerTerminal ?? sellerTerminal;
  if (terminal) {
    milestone = terminal.outcome === policy.outcomes.failure
      ? policy.milestones.terminalFailure
      : policy.milestones.terminalAborted;
  } else if (buyerAudit?.state === "final" && sellerAudit?.state === "final") {
    if (buyerAudit.outcome !== sellerAudit.outcome) {
      throw new DacsError("actor audit outcomes contradict the shared terminal session");
    }
    if (buyerAudit.outcome === policy.outcomes.failure &&
        (buyerAudit.errorClass !== sellerAudit.errorClass ||
          (policy.requiresDacs5Attribution &&
            buyerAudit.faultedParty !== sellerAudit.faultedParty))) {
      throw new DacsError(
        "actor audit failure attribution contradicts the shared operational session",
      );
    }
    if (policy.requiresDacs5Attribution &&
        buyerAudit.outcome === policy.outcomes.aborted &&
        buyerAudit.withdrawnBy !== sellerAudit.withdrawnBy) {
      throw new DacsError(
        "actor audit withdrawal attribution contradicts the shared operational session",
      );
    }
    milestone = buyerAudit.outcome === policy.outcomes.failure
      ? policy.milestones.terminalFailure
      : buyerAudit.outcome === policy.outcomes.aborted
        ? policy.milestones.terminalAborted
        : policy.milestones.actorAuditFinal;
  } else if (buyerAudit?.state === "final" &&
      buyerAudit.outcome !== policy.outcomes.success) {
    milestone = buyerAudit.outcome === policy.outcomes.failure
      ? policy.milestones.terminalFailure
      : policy.milestones.terminalAborted;
  } else if (sellerAudit?.state === "final" &&
      sellerAudit.outcome !== policy.outcomes.success) {
    milestone = sellerAudit.outcome === policy.outcomes.failure
      ? policy.milestones.terminalFailure
      : policy.milestones.terminalAborted;
  } else if (seller.tracks["delivery-evidence"]?.state === "final" &&
      seller.tracks["delivery-evidence"]?.outcome === policy.outcomes.success) {
    milestone = policy.milestones.performanceComplete;
  } else if (buyer.tracks["buyer-received"]?.state === "final" &&
      buyer.tracks["buyer-received"]?.outcome === policy.outcomes.success) {
    milestone = policy.milestones.buyerReceived;
  } else if (seller.tracks.delivery?.state === "final" &&
      seller.tracks.delivery?.outcome === policy.outcomes.success) {
    milestone = policy.milestones.deliveryReady;
  } else if (buyer.tracks.payment?.state === "final" &&
      buyer.tracks.payment?.outcome === policy.outcomes.success &&
      seller.tracks.payment?.state === "final" &&
      seller.tracks.payment?.outcome === policy.outcomes.success) {
    milestone = policy.milestones.paymentFinal;
  } else if (buyer.tracks.agreement?.state === "final" &&
      buyer.tracks.agreement?.outcome === policy.outcomes.success &&
      seller.tracks.agreement?.state === "final" &&
      seller.tracks.agreement?.outcome === policy.outcomes.success) {
    milestone = policy.milestones.agreementFinal;
  } else {
    milestone = policy.milestones.created;
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
    ...policy.statusAuthority,
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

function requireTrackWrite<
  Protocol extends FixedPriceCoordinatorProtocolBinding,
  Outcome extends string,
  ErrorClass extends string,
>(
  value: FixedPriceCoordinatorTrackWrite<Protocol, Outcome, ErrorClass>,
  label: string,
): FixedPriceCoordinatorOrderRecord<Protocol, Outcome, ErrorClass> {
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
  Outcome extends string,
  ErrorClass extends string,
  OperationResult extends FixedPriceCoordinatorOperationResult,
  LocalMilestone extends string,
  CombinedMilestone extends string,
  Authority extends object,
>(
  options: FixedPriceCoordinatorOptions<
    Protocol,
    Outcome,
    ErrorClass,
    OperationResult
  >,
  policy: FixedPriceCoordinatorProfilePolicy<
    Protocol,
    Outcome,
    ErrorClass,
    LocalMilestone,
    CombinedMilestone,
    Authority
  >,
): FixedPriceCommerceCoordinator<
  Protocol,
  FixedPriceCoordinatorOrderStatus<
    Protocol,
    Outcome,
    ErrorClass,
    LocalMilestone,
    Authority
  >,
  FixedPriceCoordinatorWorkReport<
    Outcome,
    OperationResult["status"],
    Authority
  >
> {
  const captured = captureOptions(options, policy);
  type WorkReport = FixedPriceCoordinatorWorkReport<
    Outcome,
    OperationResult["status"],
    Authority
  >;
  const withStatusAuthority = (report: Readonly<{
    jobId: string;
    track: FixedPriceX402Track;
    status: OperationResult["status"] | "waiting" | "stale" | "skipped";
    outcome?: Outcome;
    reasonCode?: string;
  }>): WorkReport => clone({
    ...report,
    ...policy.statusAuthority,
  }) as WorkReport;

  const get = async (
    jobId: string,
  ): Promise<
    FixedPriceCoordinatorOrderRecord<Protocol, Outcome, ErrorClass> | null
  > => {
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
  ): Promise<FixedPriceX402Page<WorkReport>> => {
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
    const reports: WorkReport[] = [];
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
          isRunnableTrack(record, candidate, now, policy)
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
          reports.push(withStatusAuthority({
            jobId: record.jobId,
            track,
            status: claim.status === "waiting" ? "waiting" :
              claim.status === "stale" ? "stale" : "skipped",
          }));
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
        let result: OperationResult;
        try {
          const raw = await Reflect.apply(captured.operations.get(track)!, INERT_RECEIVER, [{
            order: copyRecord(record),
            fence,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          }]);
          result = captureOperationResult<
            Protocol,
            Outcome,
            ErrorClass,
            LocalMilestone,
            CombinedMilestone,
            Authority,
            OperationResult
          >(raw, policy);
          if (result.status === "final" &&
              !trackResultAllowed(
                record,
                track,
                result as unknown as Readonly<{
                  outcome: Outcome;
                  errorClass?: ErrorClass;
                }>,
                policy,
              )) {
            result = {
              status: "operator-action",
              reasonCode: policy.invalidOutcomeReasonCode,
            } as OperationResult;
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
          } as OperationResult;
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
          reports.push(withStatusAuthority({
            jobId: record.jobId,
            track,
            status: result.status,
            ...(result.status === "final"
              ? { outcome: result.outcome as Outcome }
              : { reasonCode: result.reasonCode }),
          }));
        } else if (written.status === "corrupt") {
          throw new DacsError(written.reason);
        } else if (written.status === "unsupported") {
          throw new DacsError(`coordinator store version ${written.version} is unsupported`);
        } else {
          if (!["missing", "stale", "conflict"].includes(written.status)) {
            throw new DacsError("coordinator store returned an unknown track-write result");
          }
          reports.push(withStatusAuthority({
            jobId: record.jobId,
            track,
            status: "stale",
          }));
          retainedStateStale = true;
          break;
        }
      }
      if (!retainedStateStale && !input.signal?.aborted) {
        const observed = await captured.store.readTime();
        if (!safeUint(observed)) throw new DacsError("coordinator store returned invalid time");
        const hasUnprocessedRunnable = roleTracks(captured.role).some((candidate) =>
          !processed.has(candidate) && captured.operations.has(candidate) &&
          isRunnableTrack(record, candidate, observed, policy)
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

  const coordinator: FixedPriceCommerceCoordinator<
    Protocol,
    FixedPriceCoordinatorOrderStatus<
      Protocol,
      Outcome,
      ErrorClass,
      LocalMilestone,
      Authority
    >,
    WorkReport
  > = {
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

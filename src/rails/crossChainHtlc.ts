import { hkdfSync, randomBytes } from "node:crypto";

import {
  assertPositiveAmount,
  baseUnits,
  canonicalize,
  sha256Hex,
} from "../canonical/index.js";
import type { AttestationRef } from "../artifacts/types.js";
import { DacsError } from "../errors.js";
import { requireCanonicalJobId } from "../negotiate/jobId.js";

const HASH_RE = /^[0-9a-f]{64}$/;
const DEFAULT_LEASE_MS = 30_000;
/** Longest delay a timer accepts; a longer lease is abandoned only this late. */
const MAX_TIMER_MS = 2_147_483_647;
const SOURCE_LEG_ACTIONS: ReadonlySet<HtlcAction> = new Set(["source-lock", "source-claim", "source-refund"]);
/** Replacements of a failed destination claim allowed per session. */
const MAX_DESTINATION_CLAIM_REPLACEMENTS = 3;
/** Replacements of a failed source claim allowed per session. */
const MAX_SOURCE_CLAIM_REPLACEMENTS = 3;

export type HtlcAction =
  | "source-lock"
  | "destination-lock"
  | "destination-claim"
  | "source-claim"
  | "source-refund"
  | "destination-refund";

export type HtlcActor = "payer" | "payee";

export interface CrossChainHtlcAuthority {
  jobId: string;
  phaseIndex: number;
  railId: string;
  railDescriptorHash: string;
  agreementHash: string;
  assetKind: "stablecoin-cross-chain";
  networkKind: "cross-chain";
  mechanism: "htlc";
  sourceChainId: number;
  destinationChainId: number;
  sourceAsset: string;
  destinationAsset: string;
  /**
   * Chain-native identifier of the token the source HTLC locks: its token
   * contract address or the chain's asset id, in the form the source adapter
   * reports as `HtlcLockTerms.token`. `sourceAsset` is only the symbol.
   */
  sourceTokenId: string;
  /** Destination-chain counterpart of `sourceTokenId`. */
  destinationTokenId: string;
  sourceTokenDecimals: number;
  destinationTokenDecimals: number;
  amount: string;
  currency: string;
  payerSourceAddress: string;
  payerDestinationAddress: string;
  payeeSourceAddress: string;
  payeeDestinationAddress: string;
  sourceContractAddress: string;
  destinationContractAddress: string;
  sourceFinalitySec: number;
  destinationFinalitySec: number;
  /**
   * The pinned rail's `safetyWindowSec` (HTLC-7). Required: the Standard's
   * 600 s default belongs to the rail definition, so an authority that omits
   * it is refused instead of being given that default.
   */
  safetyWindowSec: number;
  sourceTimelockSec: number;
  destinationTimelockSec: number;
}

export interface CrossChainHtlcSecrets {
  buyerSalt: Uint8Array;
  buyerSaltHash: string;
  preimage: Uint8Array;
  preimageHash: string;
  sourceHashlock: string;
  destinationHashlock: string;
}

export interface CrossChainHtlcIntent {
  intentVersion: "1";
  settlementKey: string;
  bindingHash: string;
  jobId: string;
  phaseIndex: number;
  railId: string;
  railDescriptorHash: string;
  agreementHash: string;
  assetKind: "stablecoin-cross-chain";
  networkKind: "cross-chain";
  mechanism: "htlc";
  sourceChainId: number;
  destinationChainId: number;
  sourceAsset: string;
  destinationAsset: string;
  sourceTokenId: string;
  destinationTokenId: string;
  sourceTokenDecimals: number;
  destinationTokenDecimals: number;
  sourceAmountBaseUnits: string;
  destinationAmountBaseUnits: string;
  amount: string;
  currency: string;
  payerSourceAddress: string;
  payerDestinationAddress: string;
  payeeSourceAddress: string;
  payeeDestinationAddress: string;
  sourceContractAddress: string;
  destinationContractAddress: string;
  sourceFinalitySec: number;
  destinationFinalitySec: number;
  safetyWindowSec: number;
  sourceTimelockSec: number;
  destinationTimelockSec: number;
  buyerSaltHash: string;
  preimageHash: string;
  sourceHashlock: string;
  destinationHashlock: string;
}

export interface HtlcHashlockDeriver {
  deriveHashlock(input: {
    chainId: number;
    preimage: Uint8Array;
  }): string;
}

export type HtlcTxRef =
  | {
      kind: "htlc-lock";
      chainId: number;
      contractAddress: string;
      lockTxHash: string;
    }
  | {
      kind: "htlc-reveal";
      chainId: number;
      contractAddress: string;
      revealTxHash: string;
    }
  | {
      kind: "htlc-claim";
      chainId: number;
      contractAddress: string;
      claimTxHash: string;
    }
  | {
      kind: "htlc-refund";
      chainId: number;
      contractAddress: string;
      refundTxHash: string;
    };

export interface HtlcPreparedAction {
  actionVersion: "1";
  action: HtlcAction;
  actor: HtlcActor;
  authorityHash: string;
  txRef: Readonly<HtlcTxRef>;
  signedPayloadBase64: string;
  preparedAt: number;
  sourceFinalityCheckpointHash?: string;
  effectHash: string;
}

/**
 * Authenticated on-chain terms of a lock, reported exactly as recorded by the
 * HTLC contract. The core compares a final source lock's terms with the intent
 * before the destination lock is prepared or rebroadcast, and a final
 * destination lock's terms before the payer reveals the preimage. Missing or
 * different terms forbid that step; they never block observation or refunds.
 *
 * "Authenticated" is the adapter's promise, not a check by the core: the core
 * checks only the terms' format and never reads them from a chain or verifies
 * them, so the pre-reveal check is only as good as the adapter.
 */
export interface HtlcLockTerms {
  /**
   * Identifier of the token actually locked, read from the lock record (or,
   * for a single-token contract, the contract's configured token), in the
   * form of the intent's `sourceTokenId` / `destinationTokenId`.
   */
  token: string;
  /** Locked amount in the chain token's base units, canonical decimal. */
  amountBaseUnits: string;
  /** Chain-native hashlock, in the form produced by the hashlock deriver. */
  hashlock: string;
  /** Depositor and refund beneficiary. */
  sender: string;
  /** Claim beneficiary. */
  recipient: string;
}

export interface HtlcSourceClaimReplacementContext {
  attempt: number;
  priorEffectHash: string;
  priorTxRef: Readonly<Extract<HtlcTxRef, { kind: "htlc-claim" }>>;
  failureAuthenticationHash: string;
}

/**
 * Replacement of a destination claim (reveal) the adapter authenticated as
 * `failed` or `absent`. The earlier reveal already broadcast the preimage, so
 * the adapter signs a new reveal of the same preimage into the same
 * destination lock.
 */
export interface HtlcDestinationClaimReplacementContext {
  attempt: number;
  priorEffectHash: string;
  priorTxRef: Readonly<Extract<HtlcTxRef, { kind: "htlc-reveal" }>>;
  failureAuthenticationHash: string;
}

/**
 * One action's state as the adapter reports it. Every state is the adapter's
 * authenticated assertion: authentication is the adapter's responsibility,
 * and the core checks only formats, for example that `authenticationHash` is
 * 64 lowercase hexadecimal characters. It never verifies a state against a
 * chain or a verifier (see the adapter audit checklist in
 * `docs/pay-cross-chain-htlc.md`).
 */
export type HtlcObservedAction =
  | {
      state: "absent";
      /**
       * The retained attempt this `absent` is about. A retained reveal or
       * source claim is replaced only when this names its active attempt; an
       * `absent` that names an earlier attempt, or none, is refused. A retained
       * lock (source or destination) or refund counts as unable to land only
       * when this names it: its dead bytes are never rebroadcast, and a dead
       * destination lock is no longer an owed leg. An `absent` without it
       * means nothing is on chain yet: the retained bytes are rebroadcast byte
       * for byte, and a retained destination lock stays owed, as when it is
       * `pending`, so the session is never `refunded` while it may land.
       */
      txRef?: Readonly<HtlcTxRef>;
      authenticationHash: string;
    }
  | {
      state: "pending" | "failed";
      txRef: Readonly<HtlcTxRef>;
      reason?: string;
      authenticationHash: string;
    }
  | ({
      /**
       * Authenticated and irreversible under the intent's selected chain
       * finality policy. The adapter owns authentication and the
       * confirmation-depth and reorg checks, none of which the core repeats;
       * it must return `pending` while a reversal remains possible.
       */
      state: "final";
      /** Unix milliseconds at which the named finality condition was observed. */
      finalityObservedAt: number;
      /** Unix milliseconds at which the transaction was included, when applicable. */
      includedAt?: number;
      /** Chain-contract expiry as Unix seconds for lock actions. */
      expiresAt?: number;
      /**
       * On-chain lock terms of a final lock. Needed before the forward step
       * that depends on that lock; shape-checked whenever present.
       */
      lockTerms?: Readonly<HtlcLockTerms>;
      /**
       * Source lock only, optional: the lock's on-chain disposition when it
       * was observed. `open` still holds the funds, `claimed` was spent by the
       * claim in `claimTxRef`, which may be one the core never sent, and
       * `refunded` returned them to the payer. Past the source expiry after a
       * final reveal, a lock authenticated `open` or `refunded`, or `claimed`
       * by a claim final only after the expiry, ends the session with the
       * terminal ST-8 expiry.
       */
      lockState?: "open" | "claimed" | "refunded";
      /** Present exactly when `lockState` is `claimed`: the claim that spent the lock. */
      claimTxRef?: Readonly<Extract<HtlcTxRef, { kind: "htlc-claim" }>>;
      /**
       * Present exactly when `lockState` is `claimed`: authenticated
       * chain-native Unix milliseconds at which `claimTxRef` reached finality.
       */
      claimFinalityReachedAt?: number;
      revealedPreimageHex?: string;
      authenticationHash: string;
    } & (
      | {
          txRef: Readonly<Extract<HtlcTxRef, { kind: "htlc-claim" }>>;
          /**
           * Authenticated chain-native Unix milliseconds at which source-claim
           * finality was reached, distinct from the later observer timestamp.
           */
          finalityReachedAt: number;
        }
      | {
          txRef: Readonly<Exclude<HtlcTxRef, { kind: "htlc-claim" }>>;
          finalityReachedAt?: number;
        }
    ));

/**
 * Why a claim attempt was replaced: the adapter authenticated it `failed` on
 * chain, or `absent`, never on chain and unable to land. An `absent` entry
 * carries the reference of the active attempt that the observation named.
 */
export type HtlcFailedObservation = Omit<
  Extract<HtlcObservedAction, { state: "pending" | "failed" }>,
  "state"
> & { state: "failed" | "absent" };

export interface HtlcSourceClaimAttemptHistoryEntry {
  attempt: number;
  prepared: Readonly<HtlcPreparedAction>;
  failedObservation: Readonly<HtlcFailedObservation>;
  replacementEffectHash: string;
}

/** A replaced failed destination claim; same shape as a source-claim entry. */
export type HtlcDestinationClaimAttemptHistoryEntry = HtlcSourceClaimAttemptHistoryEntry;

export interface HtlcLedgerSnapshot {
  observedAt: number;
  authenticationHash: string;
  actions: Partial<Record<HtlcAction, Readonly<HtlcObservedAction>>>;
}

export interface HtlcEffectFence {
  settlementKey: string;
  bindingHash: string;
  owner: string;
  generation: number;
  assertCurrent(): Promise<void>;
}

/**
 * Chain boundary. The adapter may dispatch payer and payee effects to separate
 * role services; this coordinator never needs either role's private key. The
 * adapter also owns authentication: the core takes every observation as
 * authenticated once its fields are well formed. Every call must return or
 * throw well within the host's lease; the core abandons one still running
 * when the lease lapses, and `observeSourceLeg` once half the lease time left
 * at its start has passed.
 */
export interface CrossChainHtlcAdapter {
  observe(
    intent: Readonly<CrossChainHtlcIntent>,
    fence: Readonly<HtlcEffectFence>,
  ): Promise<Readonly<HtlcLedgerSnapshot>>;
  /**
   * The source chain's actions only (`source-lock`, `source-claim` and
   * `source-refund`), reported exactly as `observe` reports them. It must
   * not depend on the destination chain or on the payee's role service: the
   * source-finality checkpoint may be recorded from it, and the payer's
   * source refund is decided on it, before `observe` is called, so that
   * nothing on the payee's side can hold that refund up. The core abandons
   * it once half the lease time left at its start has passed, so that a
   * first refund decided without it can still be sent in the same call.
   */
  observeSourceLeg(
    intent: Readonly<CrossChainHtlcIntent>,
    fence: Readonly<HtlcEffectFence>,
  ): Promise<Readonly<HtlcLedgerSnapshot>>;
  /**
   * Only constructs and signs the action and returns its bytes. It must never
   * broadcast, submit, enqueue, publish or otherwise disclose the signed
   * payload or the preimage, also when the core abandons the call or
   * discards its result. The core records every action durably before it
   * releases it, and only `broadcastRetained` releases retained bytes; its
   * refund decisions rely on an action that was never recorded never having
   * left the adapter.
   */
  prepareAction(
    input: Readonly<{
      intent: Readonly<CrossChainHtlcIntent>;
      action: HtlcAction;
      actor: HtlcActor;
      preimage?: Uint8Array;
      sourceExpiry?: number;
      destinationExpiry?: number;
      sourceFinalityCheckpoint?: Readonly<HtlcSourceFinalityCheckpoint>;
      /** Set only when replacing a failed or absent `source-claim` or `destination-claim`. */
      replacement?: Readonly<HtlcSourceClaimReplacementContext | HtlcDestinationClaimReplacementContext>;
    }>,
    fence: Readonly<HtlcEffectFence>,
  ): Promise<Readonly<Omit<HtlcPreparedAction, "effectHash">>>;
  broadcastRetained(
    action: Readonly<HtlcPreparedAction>,
    fence: Readonly<HtlcEffectFence>,
  ): Promise<void>;
}

export interface HtlcLease {
  owner: string;
  generation: number;
  expiresAt: number;
}

export interface HtlcSourceFinalityCheckpoint {
  sourceLockEffectHash: string;
  sourceLockTxRef: Readonly<Extract<HtlcTxRef, { kind: "htlc-lock" }>>;
  includedAt: number;
  sourceExpiry: number;
  finalityObservedAt: number;
  authenticationHash: string;
}

export interface HtlcRevealCheckpoint {
  revealTxRef: Readonly<Extract<HtlcTxRef, { kind: "htlc-reveal" }>>;
  sourceExpiry: number;
  finalityObservedAt: number;
  authenticationHash: string;
}

export interface CrossChainHtlcSettlement {
  txRefs: readonly Readonly<HtlcTxRef>[];
  paymentAmount: Readonly<{ amount: string; currency: string }>;
  settlementFinality: Readonly<{
    model: "htlc-reveal";
    /** Exact source-lock expiry authority as Unix seconds. */
    sourceExpiry: number;
    finalityReachedAt: number;
    finalityObservedAt: number;
  }>;
  authenticationHash: string;
}

/** Standard-shaped SettlementEvidence fields; see `crossChainHtlcEvidenceFields`. */
export type CrossChainHtlcEvidenceFields =
  | Readonly<{
      outcome: "success";
      paymentTxRefs: readonly [
        Readonly<Extract<HtlcTxRef, { kind: "htlc-lock" }>>,
        Readonly<Extract<HtlcTxRef, { kind: "htlc-reveal" }>>,
        Readonly<Extract<HtlcTxRef, { kind: "htlc-claim" }>>,
      ];
      paymentAmount: Readonly<{ amount: string; currency: string }>;
      settlementFinality: Readonly<{ model: "htlc-reveal"; finalityObservedAt: number }>;
      supersedesEvidenceRef?: Readonly<AttestationRef>;
    }>
  | Readonly<{
      outcome: "failure";
      reason: "dest-revealed-source-unclaimed";
      paymentTxRefs: readonly [
        Readonly<Extract<HtlcTxRef, { kind: "htlc-lock" }>>,
        Readonly<Extract<HtlcTxRef, { kind: "htlc-reveal" }>>,
      ];
    }>;

export type HtlcStoreClaim =
  | {
      status: "acquired";
      intent: Readonly<CrossChainHtlcIntent>;
      lease: Readonly<HtlcLease>;
      prepared: readonly Readonly<HtlcPreparedAction>[];
      sourceClaimAttemptHistory: readonly Readonly<HtlcSourceClaimAttemptHistoryEntry>[];
      destinationClaimAttemptHistory: readonly Readonly<HtlcDestinationClaimAttemptHistoryEntry>[];
      sourceFinalityCheckpoint?: Readonly<HtlcSourceFinalityCheckpoint>;
      revealCheckpoint?: Readonly<HtlcRevealCheckpoint>;
    }
  | {
      status: "waiting";
      intent: Readonly<CrossChainHtlcIntent>;
      lease: Readonly<HtlcLease>;
      prepared: readonly Readonly<HtlcPreparedAction>[];
      sourceClaimAttemptHistory: readonly Readonly<HtlcSourceClaimAttemptHistoryEntry>[];
      destinationClaimAttemptHistory: readonly Readonly<HtlcDestinationClaimAttemptHistoryEntry>[];
      sourceFinalityCheckpoint?: Readonly<HtlcSourceFinalityCheckpoint>;
      revealCheckpoint?: Readonly<HtlcRevealCheckpoint>;
    }
  | {
      status: "settled";
      intent: Readonly<CrossChainHtlcIntent>;
      settlement: Readonly<CrossChainHtlcSettlement>;
      /**
       * The retained rows, claim histories and both checkpoints, unchanged
       * from the last `acquired` claim. The core replays the settlement only
       * when its references and source expiry are exactly the retained ones,
       * so a settled claim without both checkpoints is never replayed.
       */
      prepared: readonly Readonly<HtlcPreparedAction>[];
      sourceClaimAttemptHistory: readonly Readonly<HtlcSourceClaimAttemptHistoryEntry>[];
      destinationClaimAttemptHistory: readonly Readonly<HtlcDestinationClaimAttemptHistoryEntry>[];
      sourceFinalityCheckpoint?: Readonly<HtlcSourceFinalityCheckpoint>;
      revealCheckpoint?: Readonly<HtlcRevealCheckpoint>;
    }
  | { status: "conflict" | "corrupt"; reason: string };

/**
 * A store write's result. `existing` means the store already holds exactly
 * this write and changed nothing: for `recordPrepared` and either replacement
 * CAS, a row with the same `effectHash`, and so the same signed bytes; for a
 * checkpoint or settlement, a canonically equal one. Any other row already in
 * place is `conflict`. The core treats `existing` as `recorded` and then
 * broadcasts the bytes it just passed, so a store that answered `existing`
 * for a different row could send a second lock, reveal or refund.
 */
export type HtlcStoreWrite =
  | { status: "recorded" | "existing" }
  | { status: "stale" | "conflict" | "corrupt"; reason: string };

/** Durable secret/action/checkpoint store; implementations must be atomic. */
export interface CrossChainHtlcStore {
  claim(input: {
    intent: Readonly<CrossChainHtlcIntent>;
    secrets: Readonly<CrossChainHtlcSecrets>;
    owner: string;
    now: number;
    leaseDurationMs: number;
  }): Promise<HtlcStoreClaim>;
  isCurrent(input: {
    settlementKey: string;
    bindingHash: string;
    owner: string;
    generation: number;
    now: number;
  }): Promise<boolean>;
  recordPrepared(input: {
    settlementKey: string;
    bindingHash: string;
    owner: string;
    generation: number;
    prepared: Readonly<HtlcPreparedAction>;
  }): Promise<HtlcStoreWrite>;
  recordSourceFinality(input: {
    settlementKey: string;
    bindingHash: string;
    owner: string;
    generation: number;
    checkpoint: Readonly<HtlcSourceFinalityCheckpoint>;
  }): Promise<HtlcStoreWrite>;
  replacePreparedSourceClaim(input: {
    settlementKey: string;
    bindingHash: string;
    owner: string;
    generation: number;
    now: number;
    priorEffectHash: string;
    priorTxRef: Readonly<Extract<HtlcTxRef, { kind: "htlc-claim" }>>;
    failedObservation: Readonly<HtlcFailedObservation>;
    replacement: Readonly<HtlcPreparedAction>;
  }): Promise<HtlcStoreWrite>;
  /**
   * Compare-and-swap of the active `destination-claim` for a fresh reveal,
   * only while it is still the failed one named by `priorEffectHash`.
   */
  replacePreparedDestinationClaim(input: {
    settlementKey: string;
    bindingHash: string;
    owner: string;
    generation: number;
    now: number;
    priorEffectHash: string;
    priorTxRef: Readonly<Extract<HtlcTxRef, { kind: "htlc-reveal" }>>;
    failedObservation: Readonly<HtlcFailedObservation>;
    replacement: Readonly<HtlcPreparedAction>;
  }): Promise<HtlcStoreWrite>;
  recordRevealFinal(input: {
    settlementKey: string;
    bindingHash: string;
    owner: string;
    generation: number;
    checkpoint: Readonly<HtlcRevealCheckpoint>;
  }): Promise<HtlcStoreWrite>;
  recordSettlement(input: {
    settlementKey: string;
    bindingHash: string;
    owner: string;
    generation: number;
    settlement: Readonly<CrossChainHtlcSettlement>;
  }): Promise<HtlcStoreWrite>;
}

/**
 * State of one refund leg in a refund result:
 * - `waiting`: not yet allowed, because its lock has not expired, a retained
 *   reveal still blocks it, or its retained lock is not final yet and may
 *   still land;
 * - `uncertain`: due, but this call could not prepare, persist, broadcast or
 *   observe it; the next call retries with the retained bytes;
 * - `pending` / `final` / `failed`: the adapter's authenticated state of the
 *   retained refund. The core never re-sends a `failed` refund;
 * - `absent`: the adapter reported the retained refund `absent` naming it in
 *   `txRef`: it never reached the chain and can no longer. The core neither
 *   re-sends nor replaces it and returns `operator-alert` `htlc-refund-absent`.
 *   An `absent` naming no transaction is not this state: the retained refund
 *   is rebroadcast, and its leg reads `pending` or `uncertain`.
 */
export type HtlcRefundLegState = "waiting" | "uncertain" | "pending" | "final" | "failed" | "absent";

type HtlcRefundLegs = Readonly<Partial<Record<"source-refund" | "destination-refund", HtlcRefundLegState>>>;

export type CrossChainHtlcProgress =
  | { status: "waiting" | "indeterminate"; reason: string }
  | {
      status: "failed";
      errorClass: "permanent" | "counterparty" | "settlement-atomicity";
      reason: string;
      /**
       * Only on `dest-revealed-source-unclaimed-expired` for a source lock
       * spent by a claim final after `recoveryDeadline`, whether the core sent
       * it or not. ST-8 still ends in the expiry, but the payee holds the
       * source funds: the host reconciles on this claim and never pays the
       * payee again or blames them for an unpaid source.
       */
      sourceClaimTxRef?: Readonly<Extract<HtlcTxRef, { kind: "htlc-claim" }>>;
      /** Unix milliseconds at which that claim reached finality, after `recoveryDeadline`. */
      sourceClaimFinalityReachedAt?: number;
      /** The window bound, `expiry_source`, in Unix milliseconds. */
      recoveryDeadline?: number;
    }
  | {
      status: "settle-asymmetric";
      reason: "dest-revealed-source-unclaimed";
      /**
       * Unix milliseconds: the source lock's expiry (`expiry_source`), which
       * bounds the ST-8 recovery window. The source checkpoints keep the same
       * instant as the contract's Unix seconds.
       */
      recoveryDeadline: number;
      /**
       * Every reference a host follows, including the retained destination
       * lock and any source claim. The interim SettlementEvidence carries only
       * the Standard's subset; see `crossChainHtlcEvidenceFields`.
       */
      txRefs: readonly Readonly<HtlcTxRef>[];
      finalityObservedAt: number;
    }
  | {
      /**
       * `refund-stalled`: a retained refund failed on chain and the core will
       * not re-send it; an operator must act. The other leg is still driven.
       */
      status: "refund-pending" | "refunded" | "refund-stalled";
      reason:
        | "destination-timeout"
        | "destination-lock-missing"
        | "destination-lock-unresolved"
        | "destination-lock-failed"
        | "destination-lock-window-closed"
        | "destination-expiry-margin-insufficient"
        | "destination-lock-expiry-invalid"
        | "source-lock-terms-missing"
        | "source-lock-terms-mismatch"
        | "destination-lock-terms-missing"
        | "destination-lock-terms-mismatch"
        | "destination-claim-unlanded";
      txRefs: readonly Readonly<HtlcTxRef>[];
      /**
       * Each locked leg's refund; `destination-refund` once a destination lock
       * is final, or retained and not authenticated `failed` or `absent`
       * naming it.
       */
      refunds: HtlcRefundLegs;
    }
  | {
      /**
       * The core cannot safely drive the session further on its own and a
       * person must act. Resumable: a later call re-observes the chain and
       * returns to normal progress if it has changed.
       *
       * `htlc-salt-missing` (no usable `buyerSalt`) and `htlc-salt-mismatch`
       * (the store refused the salt for this session) are host errors found
       * before anything is read, so their `txRefs` is empty. The session may
       * still need driving: supply its original salt and never discard it.
       */
      status: "operator-alert";
      reason:
        | "htlc-source-claim-replacement-limit-reached"
        | "htlc-destination-claim-failed-preimage-public"
        | "htlc-destination-claim-absent-preimage-broadcast"
        | "htlc-salt-missing"
        | "htlc-salt-mismatch";
      txRefs: readonly Readonly<HtlcTxRef>[];
    }
  | {
      /**
       * The reveal is final and the source expiry has passed without a final
       * source claim, but a claim may still prove final within the window or
       * the core cannot rule one out. The result is the terminal ST-8 expiry
       * instead (`failed`, `settlement-atomicity`,
       * `dest-revealed-source-unclaimed-expired`) only once no claim the core
       * sent can land (none is retained, or the active one is authenticated
       * `failed`, or `absent` naming it) and the adapter authenticates the
       * source lock `open` or `refunded`.
       */
      status: "operator-alert";
      reason: "htlc-source-claim-missed-after-reveal";
      txRefs: readonly Readonly<HtlcTxRef>[];
      /**
       * `true`: a retained source claim is pending, unreported, or `absent`
       * naming nothing, and may still prove final within the window; a later
       * call settles it or finds it unlanded. `false`: no claim the core sent
       * can settle, because none is retained or the active one is unlanded,
       * and the source lock's disposition is not reported. A claim made
       * outside the core may have spent the lock, so the host checks that the
       * lock still holds the funds before it records `failed-counterparty`.
       */
      sourceClaimPending: boolean;
    }
  | {
      /**
       * The reveal is final, the source expiry has passed, and the adapter
       * authenticates the source lock spent by `sourceClaimTxRef`, a claim the
       * core did not send (the payee's own agent or another claimer), final
       * within the window. The lock is spent, so no claim the core sent can
       * land, even one still pending. The payee was paid: the host anchors the
       * ST-8 `:resolved` record on that claim, and never pays the payee again.
       * A claim final only after the window is the terminal ST-8 expiry
       * instead, as for a claim the core sent, and carries the claim too.
       */
      status: "operator-alert";
      reason: "htlc-source-claimed-outside-core";
      txRefs: readonly Readonly<HtlcTxRef>[];
      sourceClaimTxRef: Readonly<Extract<HtlcTxRef, { kind: "htlc-claim" }>>;
      /** Unix milliseconds at which that claim reached finality, at or before `recoveryDeadline`. */
      sourceClaimFinalityReachedAt: number;
      /** The window bound, `expiry_source`, in Unix milliseconds. */
      recoveryDeadline: number;
    }
  | {
      /** A retained refund is reported `absent` naming it; the core will not re-send it. */
      status: "operator-alert";
      reason: "htlc-refund-absent";
      txRefs: readonly Readonly<HtlcTxRef>[];
      /** Each locked leg's refund, as in a refund result; the stuck leg is `absent`. */
      refunds: HtlcRefundLegs;
    }
  | { status: "settled"; settlement: Readonly<CrossChainHtlcSettlement> };

type HtlcRefundReason = Extract<
  CrossChainHtlcProgress,
  { status: "refund-pending" | "refunded" | "refund-stalled" }
>["reason"];
type HtlcOperatorAlertReason = Extract<
  CrossChainHtlcProgress,
  {
    status: "operator-alert";
    reason: string;
    refunds?: never;
    sourceClaimPending?: never;
    sourceClaimTxRef?: never;
  }
>["reason"];

/**
 * Whether a host must page an operator for this progress. Each case is listed
 * in the host recovery checklist of `docs/pay-cross-chain-htlc.md`. A host
 * keeps advancing the session either way, except after `failed`.
 */
export function htlcNeedsOperator(progress: Readonly<CrossChainHtlcProgress>): boolean {
  switch (progress.status) {
    case "operator-alert":
    case "refund-stalled":
    case "failed":
      return true;
    case "waiting":
      return progress.reason === "htlc-destination-claim-unresolved-after-cutoff" ||
        progress.reason === "htlc-destination-claim-unresolved-after-expiry";
    case "indeterminate":
      return progress.reason === "htlc-source-observers-disagree" ||
        progress.reason === "htlc-call-input-invalid" ||
        progress.reason === "htlc-source-lock-disposition-contradicted" ||
        progress.reason === "htlc-stored-settlement-mismatch" ||
        progress.reason === "htlc-settlement-store-intent-mismatch" ||
        progress.reason === "htlc-settlement-store-intent-invalid";
    default:
      return false;
  }
}

export interface AdvanceCrossChainHtlcInput {
  authority: Readonly<CrossChainHtlcAuthority>;
  buyerSalt: Uint8Array;
  hashlocks: HtlcHashlockDeriver;
  authorizeDestinationClaim: boolean;
  owner: string;
  store: CrossChainHtlcStore;
  adapter: CrossChainHtlcAdapter;
  now?: () => number;
  /**
   * Milliseconds this call holds the session's lease; default 30 000 (30 s).
   * The lease is taken when the call starts and fences every effect in it: an
   * adapter preparation that returns after it lapses is discarded unrecorded,
   * and a broadcast that does is reported uncertain; the next owner retries
   * either. Other callers wait (`htlc-settlement-held`) until it lapses. An
   * adapter call still running when it lapses is abandoned with that same
   * outcome (a source-leg observation sooner, once half the lease time left
   * at its start has passed), so a call returns soon after its lease ends
   * even if an adapter call never does. Set it above the slowest adapter
   * call, and at least twice the slowest source-leg observation.
   */
  leaseDurationMs?: number;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DacsError(`pay-cross-chain-htlc: ${label} must be a non-empty string`);
  }
  return value;
}

function requireUInt(value: unknown, label: string, positive = false): number {
  if (!Number.isSafeInteger(value) || (positive ? Number(value) <= 0 : Number(value) < 0)) {
    throw new DacsError(`pay-cross-chain-htlc: ${label} must be a ${positive ? "positive" : "non-negative"} safe integer`);
  }
  return Number(value);
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new DacsError(`pay-cross-chain-htlc: ${label} exceeds the safe-integer range`);
  }
  return result;
}

function secondsToMilliseconds(seconds: number, label: string): number {
  const result = seconds * 1_000;
  if (!Number.isSafeInteger(result)) {
    throw new DacsError(`pay-cross-chain-htlc: ${label} exceeds the safe-integer range`);
  }
  return result;
}

/** ST-8's expiry for a source lock spent by a claim final only after the window; the claim paid the payee. */
function lateSourceClaimExpired(
  sourceClaimTxRef: Readonly<Extract<HtlcTxRef, { kind: "htlc-claim" }>>,
  sourceClaimFinalityReachedAt: number,
  recoveryDeadline: number,
): CrossChainHtlcProgress {
  return {
    status: "failed",
    errorClass: "settlement-atomicity",
    reason: "dest-revealed-source-unclaimed-expired",
    sourceClaimTxRef,
    sourceClaimFinalityReachedAt,
    recoveryDeadline,
  };
}

function finalityCutoffMillis(expiry: number, budgetSec: number, label: string): number {
  const expiryMillis = secondsToMilliseconds(expiry, `${label} expiry`);
  const budgetMillis = secondsToMilliseconds(budgetSec, `${label} finality budget`);
  const result = expiryMillis - budgetMillis;
  if (!Number.isSafeInteger(result)) {
    throw new DacsError(`pay-cross-chain-htlc: ${label} cutoff exceeds the safe-integer range`);
  }
  return result;
}

function secretCopy(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value);
}

export function generateHtlcBuyerSalt(bytes = 32): Uint8Array {
  if (!Number.isSafeInteger(bytes) || bytes < 16) {
    throw new DacsError("pay-cross-chain-htlc: buyerSalt requires at least 128 bits");
  }
  return Uint8Array.from(randomBytes(bytes));
}

export function deriveHtlcPreimage(input: {
  buyerSalt: Uint8Array;
  jobId: string;
  agreementHash: string;
}): Uint8Array {
  const jobId = requireCanonicalJobId(input.jobId);
  if (!(input.buyerSalt instanceof Uint8Array) || input.buyerSalt.byteLength < 16) {
    throw new DacsError("pay-cross-chain-htlc: buyerSalt requires at least 128 bits");
  }
  if (!HASH_RE.test(input.agreementHash)) {
    throw new DacsError("pay-cross-chain-htlc: agreementHash must be 32-byte lower-case hex");
  }
  const buyerSalt = secretCopy(input.buyerSalt);
  return new Uint8Array(hkdfSync(
    "sha256",
    buyerSalt,
    Buffer.from(jobId, "utf8"),
    Buffer.from(input.agreementHash, "utf8"),
    32,
  ));
}

export function crossChainHtlcSettlementKey(input: {
  jobId: string;
  railId: string;
  phaseIndex: number;
}): string {
  const jobId = requireCanonicalJobId(input.jobId);
  const phaseIndex = requireUInt(input.phaseIndex, "phaseIndex");
  return sha256Hex(`dacs-cross-chain-htlc:v1:${canonicalize({
    jobId,
    phaseIndex,
    railId: requireString(input.railId, "railId").normalize("NFC"),
  })}`);
}

export function crossChainHtlcSourceFinalityCheckpointHash(
  checkpoint: Readonly<HtlcSourceFinalityCheckpoint>,
): string {
  return sha256Hex(`dacs-cross-chain-htlc:source-finality:v1:${canonicalize(checkpoint)}`);
}

/**
 * The DACS-4 §9.5.4 / §9.7 fields of the SettlementEvidence a host signs and
 * anchors for a session, projected from the core's operational result:
 * - `settled`: `outcome: "success"` with exactly the source `htlc-lock`, the
 *   destination `htlc-reveal` and the source `htlc-claim`, and a closed
 *   `htlc-reveal` finality record whose `finalityObservedAt` is the source
 *   claim's chain-derived `finalityReachedAt`, the decisive event. A host that
 *   anchored an interim record for this session (ST-8 `:resolved`) passes its
 *   reference as `supersedesEvidenceRef`; the core cannot tell the two apart.
 * - `settle-asymmetric`: the HTLC-9 interim `outcome: "failure"` with reason
 *   `dest-revealed-source-unclaimed`, the source lock and the final reveal.
 *
 * The destination lock, any pending source claim, `sourceExpiry` and the
 * observer's timestamp stay in the core's result for operations only.
 */
export function crossChainHtlcEvidenceFields(
  progress: Readonly<Extract<CrossChainHtlcProgress, { status: "settled" | "settle-asymmetric" }>>,
  options: Readonly<{ supersedesEvidenceRef?: Readonly<AttestationRef> }> = {},
): CrossChainHtlcEvidenceFields {
  const ofKind = <K extends HtlcTxRef["kind"]>(
    refs: readonly Readonly<HtlcTxRef>[],
    kind: K,
  ): Readonly<Extract<HtlcTxRef, { kind: K }>>[] =>
    refs.filter((ref): ref is Readonly<Extract<HtlcTxRef, { kind: K }>> => ref.kind === kind);
  const copy = <T extends Readonly<HtlcTxRef>>(ref: T): T => Object.freeze({ ...ref });
  if (progress.status === "settled") {
    const { settlement } = progress;
    const [sourceLock, destinationLock, reveal, claim] = settlement.txRefs;
    if (settlement.txRefs.length !== 4 || sourceLock?.kind !== "htlc-lock" ||
        destinationLock?.kind !== "htlc-lock" || reveal?.kind !== "htlc-reveal" ||
        claim?.kind !== "htlc-claim" || sourceLock.chainId !== claim.chainId ||
        reveal.chainId === claim.chainId) {
      throw new DacsError("pay-cross-chain-htlc: settlement references are not a settled HTLC chain");
    }
    return Object.freeze({
      outcome: "success",
      paymentTxRefs: Object.freeze([copy(sourceLock), copy(reveal), copy(claim)] as const),
      paymentAmount: Object.freeze({ ...settlement.paymentAmount }),
      settlementFinality: Object.freeze({
        model: "htlc-reveal",
        finalityObservedAt: settlement.settlementFinality.finalityReachedAt,
      }),
      ...(options.supersedesEvidenceRef === undefined
        ? {}
        : { supersedesEvidenceRef: options.supersedesEvidenceRef }),
    });
  }
  if (options.supersedesEvidenceRef !== undefined) {
    throw new DacsError("pay-cross-chain-htlc: only a settled session supersedes an interim record");
  }
  const reveals = ofKind(progress.txRefs, "htlc-reveal");
  // `txRefs` lists the source lock before the destination lock.
  const sourceLock = ofKind(progress.txRefs, "htlc-lock")[0];
  if (!sourceLock || reveals.length !== 1 || sourceLock.chainId === reveals[0]!.chainId) {
    throw new DacsError("pay-cross-chain-htlc: asymmetric references omit the source lock or reveal");
  }
  return Object.freeze({
    outcome: "failure",
    reason: progress.reason,
    paymentTxRefs: Object.freeze([copy(sourceLock), copy(reveals[0]!)] as const),
  });
}

export function createCrossChainHtlcIntent(
  inputAuthority: Readonly<CrossChainHtlcAuthority>,
  buyerSalt: Uint8Array,
  deriver: HtlcHashlockDeriver,
): Readonly<{ intent: Readonly<CrossChainHtlcIntent>; secrets: Readonly<CrossChainHtlcSecrets> }> {
  const authority = Object.freeze({ ...inputAuthority });
  const jobId = requireCanonicalJobId(authority.jobId);
  if (!(buyerSalt instanceof Uint8Array)) {
    throw new DacsError("pay-cross-chain-htlc: buyerSalt must be bytes");
  }
  const capturedBuyerSalt = secretCopy(buyerSalt);
  const deriveHashlock = deriver.deriveHashlock.bind(deriver);
  if (authority.assetKind !== "stablecoin-cross-chain" ||
      authority.networkKind !== "cross-chain" || authority.mechanism !== "htlc") {
    throw new DacsError("pay-cross-chain-htlc: selected rail is not a cross-chain HTLC");
  }
  if (!HASH_RE.test(authority.railDescriptorHash) || !HASH_RE.test(authority.agreementHash)) {
    throw new DacsError("pay-cross-chain-htlc: authority hashes must be 32-byte lower-case hex");
  }
  const sourceChainId = requireUInt(authority.sourceChainId, "sourceChainId", true);
  const destinationChainId = requireUInt(authority.destinationChainId, "destinationChainId", true);
  if (sourceChainId === destinationChainId) {
    throw new DacsError("pay-cross-chain-htlc: source and destination chains must differ");
  }
  const sourceFinalitySec = requireUInt(authority.sourceFinalitySec, "sourceFinalitySec", true);
  const destinationFinalitySec = requireUInt(
    authority.destinationFinalitySec,
    "destinationFinalitySec",
    true,
  );
  const safetyWindowSec = requireUInt(authority.safetyWindowSec, "safetyWindowSec", true);
  const sourceTimelockSec = requireUInt(authority.sourceTimelockSec, "sourceTimelockSec", true);
  const destinationTimelockSec = requireUInt(
    authority.destinationTimelockSec,
    "destinationTimelockSec",
    true,
  );
  const sourceRecoveryBudgetSec = safeAdd(
    sourceFinalitySec,
    safetyWindowSec,
    "source finality and safety budget",
  );
  secondsToMilliseconds(destinationFinalitySec, "destinationFinalitySec");
  secondsToMilliseconds(sourceRecoveryBudgetSec, "source finality and safety budget");
  secondsToMilliseconds(sourceTimelockSec, "sourceTimelockSec");
  secondsToMilliseconds(destinationTimelockSec, "destinationTimelockSec");
  const minimumSourceTimelockSec = safeAdd(
    destinationTimelockSec,
    sourceRecoveryBudgetSec,
    "HTLC-7 timelock margin",
  );
  if (sourceTimelockSec <= minimumSourceTimelockSec) {
    throw new DacsError("pay-cross-chain-htlc: HTLC-7 timelock margin is insufficient");
  }
  const amount = assertPositiveAmount(authority.amount);
  if (authority.sourceAsset !== authority.currency || authority.destinationAsset !== authority.currency) {
    throw new DacsError("pay-cross-chain-htlc: route assets must match payment currency");
  }
  const sourceTokenDecimals = requireUInt(authority.sourceTokenDecimals, "sourceTokenDecimals");
  const destinationTokenDecimals = requireUInt(
    authority.destinationTokenDecimals,
    "destinationTokenDecimals",
  );
  if (sourceTokenDecimals > 255 || destinationTokenDecimals > 255) {
    throw new DacsError("pay-cross-chain-htlc: token decimals must be unsigned bytes");
  }
  const sourceAmountBaseUnits = baseUnits(amount, sourceTokenDecimals);
  const destinationAmountBaseUnits = baseUnits(amount, destinationTokenDecimals);
  const preimage = deriveHtlcPreimage({
    buyerSalt: capturedBuyerSalt,
    jobId,
    agreementHash: authority.agreementHash,
  });
  const sourceHashlock = requireString(
    deriveHashlock({ chainId: sourceChainId, preimage: secretCopy(preimage) }),
    "sourceHashlock",
  );
  const destinationHashlock = requireString(
    deriveHashlock({ chainId: destinationChainId, preimage: secretCopy(preimage) }),
    "destinationHashlock",
  );
  const buyerSaltHash = sha256Hex(capturedBuyerSalt);
  const preimageHash = sha256Hex(preimage);
  const unsigned = {
    intentVersion: "1" as const,
    settlementKey: crossChainHtlcSettlementKey(authority),
    jobId,
    phaseIndex: authority.phaseIndex,
    railId: requireString(authority.railId, "railId").normalize("NFC"),
    railDescriptorHash: authority.railDescriptorHash,
    agreementHash: authority.agreementHash,
    assetKind: authority.assetKind,
    networkKind: authority.networkKind,
    mechanism: authority.mechanism,
    sourceChainId,
    destinationChainId,
    sourceAsset: requireString(authority.sourceAsset, "sourceAsset"),
    destinationAsset: requireString(authority.destinationAsset, "destinationAsset"),
    sourceTokenId: requireString(authority.sourceTokenId, "sourceTokenId"),
    destinationTokenId: requireString(authority.destinationTokenId, "destinationTokenId"),
    sourceTokenDecimals,
    destinationTokenDecimals,
    sourceAmountBaseUnits,
    destinationAmountBaseUnits,
    amount,
    currency: requireString(authority.currency, "currency"),
    payerSourceAddress: requireString(authority.payerSourceAddress, "payerSourceAddress"),
    payerDestinationAddress: requireString(authority.payerDestinationAddress, "payerDestinationAddress"),
    payeeSourceAddress: requireString(authority.payeeSourceAddress, "payeeSourceAddress"),
    payeeDestinationAddress: requireString(authority.payeeDestinationAddress, "payeeDestinationAddress"),
    sourceContractAddress: requireString(authority.sourceContractAddress, "sourceContractAddress"),
    destinationContractAddress: requireString(authority.destinationContractAddress, "destinationContractAddress"),
    sourceFinalitySec,
    destinationFinalitySec,
    safetyWindowSec,
    sourceTimelockSec,
    destinationTimelockSec,
    buyerSaltHash,
    preimageHash,
    sourceHashlock,
    destinationHashlock,
  };
  const intent = Object.freeze({
    ...unsigned,
    bindingHash: sha256Hex(canonicalize(unsigned)),
  });
  return Object.freeze({
    intent,
    secrets: Object.freeze({
      buyerSalt: secretCopy(capturedBuyerSalt),
      buyerSaltHash,
      preimage: secretCopy(preimage),
      preimageHash,
      sourceHashlock,
      destinationHashlock,
    }),
  });
}

function actorFor(action: HtlcAction): HtlcActor {
  return action === "destination-lock" || action === "source-claim" ||
    action === "destination-refund" ? "payee" : "payer";
}

function expectedRef(input: {
  intent: Readonly<CrossChainHtlcIntent>;
  action: HtlcAction;
  txHash: string;
}): HtlcTxRef {
  const { intent, action, txHash } = input;
  if (action === "source-lock") return {
    kind: "htlc-lock",
    chainId: intent.sourceChainId,
    contractAddress: intent.sourceContractAddress,
    lockTxHash: txHash,
  };
  if (action === "destination-lock") return {
    kind: "htlc-lock",
    chainId: intent.destinationChainId,
    contractAddress: intent.destinationContractAddress,
    lockTxHash: txHash,
  };
  if (action === "destination-claim") return {
    kind: "htlc-reveal",
    chainId: intent.destinationChainId,
    contractAddress: intent.destinationContractAddress,
    revealTxHash: txHash,
  };
  if (action === "source-claim") return {
    kind: "htlc-claim",
    chainId: intent.sourceChainId,
    contractAddress: intent.sourceContractAddress,
    claimTxHash: txHash,
  };
  return {
    kind: "htlc-refund",
    chainId: action === "source-refund" ? intent.sourceChainId : intent.destinationChainId,
    contractAddress: action === "source-refund"
      ? intent.sourceContractAddress
      : intent.destinationContractAddress,
    refundTxHash: txHash,
  };
}

function txHashOf(ref: Readonly<HtlcTxRef>): string {
  if (ref.kind === "htlc-lock") return ref.lockTxHash;
  if (ref.kind === "htlc-reveal") return ref.revealTxHash;
  if (ref.kind === "htlc-claim") return ref.claimTxHash;
  return ref.refundTxHash;
}

function sameRef(a: Readonly<HtlcTxRef>, b: Readonly<HtlcTxRef>): boolean {
  return canonicalize(a) === canonicalize(b);
}

function decodeRevealedPreimage(value: unknown): Uint8Array {
  if (typeof value !== "string" || !/^(?:0[xX])?[0-9a-fA-F]{64}$/.test(value)) {
    throw new DacsError(
      "pay-cross-chain-htlc: revealed preimage must be exactly 32 bytes of hexadecimal",
    );
  }
  const canonicalHex = value.slice(0, 2).toLowerCase() === "0x"
    ? value.slice(2).toLowerCase()
    : value.toLowerCase();
  return Uint8Array.from(Buffer.from(canonicalHex, "hex"));
}

function revealedPreimageMatches(value: unknown, expected: Uint8Array): boolean {
  const decoded = decodeRevealedPreimage(value);
  return Buffer.from(decoded).equals(Buffer.from(expected));
}

function validatePrepared(
  value: Readonly<Omit<HtlcPreparedAction, "effectHash"> & { effectHash?: unknown }>,
  intent: Readonly<CrossChainHtlcIntent>,
  action: HtlcAction,
  sourceFinalityCheckpoint?: Readonly<HtlcSourceFinalityCheckpoint>,
): Readonly<HtlcPreparedAction> {
  if (value.actionVersion !== "1" || value.action !== action ||
      value.actor !== actorFor(action) || value.authorityHash !== intent.bindingHash) {
    throw new DacsError("pay-cross-chain-htlc: prepared action authority mismatch");
  }
  if (action === "destination-lock") {
    if (!sourceFinalityCheckpoint || value.sourceFinalityCheckpointHash !==
        crossChainHtlcSourceFinalityCheckpointHash(sourceFinalityCheckpoint)) {
      throw new DacsError("pay-cross-chain-htlc: destination lock causal checkpoint mismatch");
    }
  } else if (value.sourceFinalityCheckpointHash !== undefined) {
    throw new DacsError("pay-cross-chain-htlc: unexpected source-finality checkpoint binding");
  }
  const txHash = requireString(txHashOf(value.txRef), "txHash");
  if (!sameRef(value.txRef, expectedRef({ intent, action, txHash }))) {
    throw new DacsError("pay-cross-chain-htlc: prepared action transaction reference mismatch");
  }
  const encoded = requireString(value.signedPayloadBase64, "signedPayloadBase64");
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length === 0 ||
      decoded.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
    throw new DacsError("pay-cross-chain-htlc: signed payload must be canonical base64");
  }
  requireUInt(value.preparedAt, "preparedAt");
  // Structurally typed adapters may supply a hash, but the core owns it.
  const { effectHash: _suppliedHash, ...body } = value;
  const unsigned = { ...body, txRef: Object.freeze({ ...value.txRef }) };
  return Object.freeze({ ...unsigned, effectHash: sha256Hex(canonicalize(unsigned)) });
}

function captureFailedObservation(
  value: Readonly<HtlcFailedObservation>,
  prepared: Readonly<HtlcPreparedAction>,
): Readonly<HtlcFailedObservation> {
  if ((value.state !== "failed" && value.state !== "absent") || !sameRef(value.txRef, prepared.txRef) ||
      !HASH_RE.test(value.authenticationHash) ||
      (value.reason !== undefined && typeof value.reason !== "string")) {
    throw new DacsError(`pay-cross-chain-htlc: ${prepared.action} failure observation is invalid`);
  }
  return Object.freeze({
    state: value.state,
    txRef: Object.freeze({ ...value.txRef }),
    ...(value.reason === undefined ? {} : { reason: value.reason }),
    authenticationHash: value.authenticationHash,
  });
}

/** Validates the immutable replacement history of one claim action. */
function captureClaimAttemptHistory(
  value: readonly Readonly<HtlcSourceClaimAttemptHistoryEntry>[],
  prepared: ReadonlyMap<HtlcAction, Readonly<HtlcPreparedAction>>,
  intent: Readonly<CrossChainHtlcIntent>,
  action: "source-claim" | "destination-claim",
): readonly Readonly<HtlcSourceClaimAttemptHistoryEntry>[] {
  if (!Array.isArray(value)) {
    throw new DacsError(`pay-cross-chain-htlc: retained ${action} history is invalid`);
  }
  const active = prepared.get(action);
  if (value.length > 0 && !active) {
    throw new DacsError(`pay-cross-chain-htlc: retained ${action} history omits the active attempt`);
  }
  const effectHashes = new Set<string>();
  const transactionRefs = new Set<string>();
  const captured = value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || entry.attempt !== index + 1) {
      throw new DacsError(`pay-cross-chain-htlc: retained ${action} history sequence is invalid`);
    }
    const { effectHash, ...unsigned } = entry.prepared;
    const prior = validatePrepared(unsigned, intent, action);
    if (prior.effectHash !== effectHash || !HASH_RE.test(entry.replacementEffectHash) ||
        entry.replacementEffectHash === prior.effectHash) {
      throw new DacsError(`pay-cross-chain-htlc: retained ${action} history integrity mismatch`);
    }
    const transactionKey = canonicalize(prior.txRef);
    if (effectHashes.has(prior.effectHash) || transactionRefs.has(transactionKey)) {
      throw new DacsError(`pay-cross-chain-htlc: retained ${action} history reuses an attempt`);
    }
    effectHashes.add(prior.effectHash);
    transactionRefs.add(transactionKey);
    const failedObservation = captureFailedObservation(entry.failedObservation, prior);
    return Object.freeze({
      attempt: entry.attempt,
      prepared: prior,
      failedObservation,
      replacementEffectHash: entry.replacementEffectHash,
    });
  });
  for (let index = 0; index < captured.length; index += 1) {
    const successor = captured[index + 1]?.prepared ?? active;
    if (!successor || captured[index]!.replacementEffectHash !== successor.effectHash) {
      throw new DacsError(`pay-cross-chain-htlc: retained ${action} history chain is invalid`);
    }
  }
  if (active) {
    const activeTransactionKey = canonicalize(active.txRef);
    if (effectHashes.has(active.effectHash) || transactionRefs.has(activeTransactionKey)) {
      throw new DacsError(`pay-cross-chain-htlc: active ${action} reuses a retained attempt`);
    }
  }
  return Object.freeze(captured);
}

type FinalHtlcObservation = Extract<HtlcObservedAction, { state: "final" }>;
type FinalSourceClaimObservation = FinalHtlcObservation & { finalityReachedAt: number };

/** A malformed final lock observation: an adapter fault, not a chain state. */
class InvalidLockObservation extends DacsError {}

/**
 * A lock expiry in Unix milliseconds. Beyond the safe-integer range it is
 * `Infinity`, which never arrives, or `-Infinity`, which has long passed.
 */
function lockExpiryMillis(expiresAt: number): number {
  const millis = expiresAt * 1_000;
  if (Number.isSafeInteger(millis)) return millis;
  return millis < 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
}

/**
 * A final destination lock whose integer expiry lies beyond the safe-integer
 * range in milliseconds, or at or before the lock's own inclusion. The payee's
 * role signs that lock, so this is a chain fact, not an adapter fault: the
 * payer never reveals against it, and it never holds back the source refund.
 */
function destinationLockExpiryUnusable(observed: Readonly<FinalHtlcObservation>): boolean {
  const { expiresAt, includedAt } = observed;
  if (!Number.isInteger(expiresAt) || !Number.isSafeInteger(includedAt) || includedAt! < 0) {
    return false;
  }
  const expiryMillis = lockExpiryMillis(expiresAt!);
  return expiryMillis === Number.POSITIVE_INFINITY || expiryMillis <= includedAt!;
}

function validateFinalityTiming(
  observed: Readonly<FinalHtlcObservation>,
  action: HtlcAction,
  checkLockExpiry = true,
): void {
  const finalityObservedAt = requireUInt(
    observed.finalityObservedAt,
    `${action} finalityObservedAt`,
  );
  const includedAt = observed.includedAt === undefined
    ? undefined
    : requireUInt(observed.includedAt, `${action} includedAt`);
  const finalityReachedAt = observed.finalityReachedAt === undefined
    ? undefined
    : requireUInt(observed.finalityReachedAt, `${action} finalityReachedAt`);
  if (action === "source-claim" && finalityReachedAt === undefined) {
    throw new DacsError("pay-cross-chain-htlc: source-claim finalityReachedAt is required");
  }
  if (finalityReachedAt !== undefined &&
      (finalityReachedAt > finalityObservedAt ||
        (includedAt !== undefined && finalityReachedAt < includedAt))) {
    throw new DacsError(`pay-cross-chain-htlc: ${action} finality timing is invalid`);
  }
  if (action === "source-lock" || action === "destination-lock") {
    const lockIncludedAt = requireUInt(observed.includedAt, `${action} includedAt`);
    if (checkLockExpiry) {
      const expiresAt = requireUInt(observed.expiresAt, `${action} expiresAt`, true);
      if (secondsToMilliseconds(expiresAt, `${action} expiresAt`) <= lockIncludedAt) {
        throw new DacsError(`pay-cross-chain-htlc: ${action} expiry is not after inclusion`);
      }
    }
    if (finalityObservedAt < lockIncludedAt) {
      throw new DacsError(`pay-cross-chain-htlc: ${action} finality precedes inclusion`);
    }
  }
}

function validateLockTerms(value: unknown, action: HtlcAction): void {
  if (value === null || typeof value !== "object") {
    throw new DacsError(`pay-cross-chain-htlc: ${action} terms are invalid`);
  }
  const terms = value as Readonly<HtlcLockTerms>;
  requireString(terms.token, `${action} token`);
  if (typeof terms.amountBaseUnits !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(terms.amountBaseUnits)) {
    throw new DacsError(`pay-cross-chain-htlc: ${action} amount is invalid`);
  }
  requireString(terms.hashlock, `${action} hashlock`);
  requireString(terms.sender, `${action} sender`);
  requireString(terms.recipient, `${action} recipient`);
}

/** Compares a final lock's authenticated terms with the terms the intent requires. */
function lockTermsVerdict(
  observed: Readonly<FinalHtlcObservation>,
  expected: Readonly<HtlcLockTerms>,
): "missing" | "mismatch" | undefined {
  const terms = observed.lockTerms;
  if (terms === undefined) return "missing";
  return terms.token === expected.token &&
    terms.amountBaseUnits === expected.amountBaseUnits &&
    terms.hashlock === expected.hashlock &&
    terms.sender === expected.sender &&
    terms.recipient === expected.recipient
    ? undefined
    : "mismatch";
}

/** The source lock must pay the intent's token amount to the payee under its hashlock. */
function expectedSourceLockTerms(intent: Readonly<CrossChainHtlcIntent>): Readonly<HtlcLockTerms> {
  return {
    token: intent.sourceTokenId,
    amountBaseUnits: intent.sourceAmountBaseUnits,
    hashlock: intent.sourceHashlock,
    sender: intent.payerSourceAddress,
    recipient: intent.payeeSourceAddress,
  };
}

/** The destination lock must pay the intent's token amount to the payer under its hashlock. */
function expectedDestinationLockTerms(
  intent: Readonly<CrossChainHtlcIntent>,
): Readonly<HtlcLockTerms> {
  return {
    token: intent.destinationTokenId,
    amountBaseUnits: intent.destinationAmountBaseUnits,
    hashlock: intent.destinationHashlock,
    sender: intent.payeeDestinationAddress,
    recipient: intent.payerDestinationAddress,
  };
}

/** Whether `ref` names the active attempt of an action or a replaced one. */
function namesRetainedAttempt(
  ref: Readonly<HtlcTxRef>,
  prepared: Readonly<HtlcPreparedAction> | undefined,
  history: readonly Readonly<HtlcSourceClaimAttemptHistoryEntry>[] = [],
): boolean {
  return (prepared !== undefined && sameRef(ref, prepared.txRef)) ||
    history.some((entry) => sameRef(ref, entry.prepared.txRef));
}

/**
 * A final observation of the action. For a claim it may name any retained
 * attempt: every attempt of a claim carries the same preimage, so an earlier
 * attempt that landed completes that claim.
 */
function final(
  snapshot: Readonly<HtlcLedgerSnapshot>,
  action: HtlcAction,
  prepared: Readonly<HtlcPreparedAction> | undefined,
  history: readonly Readonly<HtlcSourceClaimAttemptHistoryEntry>[] = [],
): Extract<HtlcObservedAction, { state: "final" }> | undefined {
  const observed = snapshot.actions[action];
  if (!observed || observed.state !== "final") return undefined;
  if (!namesRetainedAttempt(observed.txRef, prepared, history) ||
      !HASH_RE.test(observed.authenticationHash) ||
      !Number.isSafeInteger(observed.finalityObservedAt) || observed.finalityObservedAt < 0) {
    throw new DacsError(`pay-cross-chain-htlc: invalid authenticated ${action} finality`);
  }
  return observed;
}

function finalSourceClaim(
  snapshot: Readonly<HtlcLedgerSnapshot>,
  prepared: Readonly<HtlcPreparedAction> | undefined,
  history: readonly Readonly<HtlcSourceClaimAttemptHistoryEntry>[] = [],
): Readonly<FinalSourceClaimObservation> | undefined {
  const observed = final(snapshot, "source-claim", prepared, history);
  if (!observed) return undefined;
  validateFinalityTiming(observed, "source-claim");
  return observed as Readonly<FinalSourceClaimObservation>;
}

/**
 * References of retained actions the adapter reports. `unreported` names
 * retained actions whose reference is included even while the adapter does
 * not report them, because they may still land. `known` gives the reference
 * of an action that durable evidence fixes, such as the checkpointed reveal,
 * which is named whatever the adapter reports.
 */
function collectRefs(
  snapshot: Readonly<HtlcLedgerSnapshot>,
  prepared: ReadonlyMap<HtlcAction, Readonly<HtlcPreparedAction>>,
  unreported: readonly HtlcAction[] = [],
  includeRetained: readonly HtlcAction[] = [],
  known: Readonly<Partial<Record<HtlcAction, Readonly<HtlcTxRef>>>> = {},
): readonly Readonly<HtlcTxRef>[] {
  const refs: HtlcTxRef[] = [];
  for (const action of [
    "source-lock",
    "destination-lock",
    "destination-claim",
    "source-claim",
    "source-refund",
    "destination-refund",
  ] as const) {
    const item = snapshot.actions[action];
    const retained = prepared.get(action);
    const knownRef = known[action];
    if (knownRef) {
      refs.push(Object.freeze({ ...knownRef }));
    } else if (item && item.state !== "absent" && retained && sameRef(item.txRef, retained.txRef)) {
      refs.push(Object.freeze({ ...item.txRef }));
    } else if (retained && ((!item && unreported.includes(action)) || includeRetained.includes(action))) {
      refs.push(Object.freeze({ ...retained.txRef }));
    }
  }
  return Object.freeze(refs);
}

function captureSourceFinalityCheckpoint(
  value: Readonly<HtlcSourceFinalityCheckpoint>,
  sourceLock: Readonly<HtlcPreparedAction> | undefined,
): Readonly<HtlcSourceFinalityCheckpoint> {
  if (!sourceLock || sourceLock.action !== "source-lock" ||
      value.sourceLockEffectHash !== sourceLock.effectHash ||
      !sameRef(value.sourceLockTxRef, sourceLock.txRef) ||
      !HASH_RE.test(value.authenticationHash)) {
    throw new DacsError("pay-cross-chain-htlc: retained source-finality checkpoint is invalid");
  }
  const includedAt = requireUInt(value.includedAt, "retained source finality includedAt");
  const sourceExpiry = requireUInt(value.sourceExpiry, "retained source finality sourceExpiry", true);
  const finalityObservedAt = requireUInt(
    value.finalityObservedAt,
    "retained source finality finalityObservedAt",
  );
  if (finalityObservedAt < includedAt ||
      secondsToMilliseconds(sourceExpiry, "retained source finality sourceExpiry") <= includedAt) {
    throw new DacsError("pay-cross-chain-htlc: retained source-finality timestamps are invalid");
  }
  return Object.freeze({
    sourceLockEffectHash: value.sourceLockEffectHash,
    sourceLockTxRef: Object.freeze({
      ...value.sourceLockTxRef,
    } as Extract<HtlcTxRef, { kind: "htlc-lock" }>),
    includedAt,
    sourceExpiry,
    finalityObservedAt,
    authenticationHash: value.authenticationHash,
  });
}

function captureRevealCheckpoint(
  value: Readonly<HtlcRevealCheckpoint>,
  prepared: ReadonlyMap<HtlcAction, Readonly<HtlcPreparedAction>>,
  history: readonly Readonly<HtlcDestinationClaimAttemptHistoryEntry>[],
): Readonly<HtlcRevealCheckpoint> {
  if (!namesRetainedAttempt(value.revealTxRef, prepared.get("destination-claim"), history) ||
      !HASH_RE.test(value.authenticationHash)) {
    throw new DacsError("pay-cross-chain-htlc: retained reveal checkpoint is invalid");
  }
  const sourceExpiry = requireUInt(value.sourceExpiry, "retained reveal sourceExpiry", true);
  // The core compares it in milliseconds, so it must convert, as the
  // source-finality checkpoint's expiry must.
  secondsToMilliseconds(sourceExpiry, "retained reveal sourceExpiry");
  const finalityObservedAt = requireUInt(value.finalityObservedAt, "retained reveal finalityObservedAt");
  return Object.freeze({
    revealTxRef: Object.freeze({ ...value.revealTxRef }),
    sourceExpiry,
    finalityObservedAt,
    authenticationHash: value.authenticationHash,
  });
}

function validateSnapshot(
  snapshot: Readonly<HtlcLedgerSnapshot>,
  prepared: ReadonlyMap<HtlcAction, Readonly<HtlcPreparedAction>>,
  sourceClaimAttemptHistory: readonly Readonly<HtlcSourceClaimAttemptHistoryEntry>[],
  destinationClaimAttemptHistory: readonly Readonly<HtlcDestinationClaimAttemptHistoryEntry>[],
): void {
  requireUInt(snapshot.observedAt, "snapshot observedAt");
  if (!HASH_RE.test(snapshot.authenticationHash)) {
    throw new DacsError("pay-cross-chain-htlc: ledger snapshot is unauthenticated");
  }
  if (snapshot.actions === null || typeof snapshot.actions !== "object" ||
      Array.isArray(snapshot.actions)) {
    throw new DacsError("pay-cross-chain-htlc: ledger actions are invalid");
  }
  const knownActions = new Set<HtlcAction>([
    "source-lock",
    "destination-lock",
    "destination-claim",
    "source-claim",
    "source-refund",
    "destination-refund",
  ]);
  for (const [key, observed] of Object.entries(snapshot.actions)) {
    if (!knownActions.has(key as HtlcAction) || observed === null ||
        typeof observed !== "object" || !HASH_RE.test(observed.authenticationHash)) {
      throw new DacsError("pay-cross-chain-htlc: action observation is unauthenticated");
    }
    const action = key as HtlcAction;
    // A lock's disposition is read from its final observation only.
    if (observed.state !== "final" && ["lockState", "claimTxRef", "claimFinalityReachedAt"]
      .some((field) => (observed as Readonly<Record<string, unknown>>)[field] !== undefined)) {
      throw new DacsError(`pay-cross-chain-htlc: ${action} disposition is invalid`);
    }
    const retained = prepared.get(action);
    const history = action === "source-claim"
      ? sourceClaimAttemptHistory
      : action === "destination-claim" ? destinationClaimAttemptHistory : [];
    if (observed.state === "absent") {
      // An `absent` may name the attempt it is about, which must be retained;
      // whether it can replace a claim is decided where it is used.
      if (observed.txRef !== undefined && !namesRetainedAttempt(observed.txRef, retained, history)) {
        throw new DacsError(`pay-cross-chain-htlc: ${action} observation is not retained`);
      }
      continue;
    }
    // A replaced claim attempt may still be reported `failed`, or `final` once
    // it has landed after all; only the active attempt can be `pending`.
    const replacedAttempt = (observed.state === "failed" || observed.state === "final") &&
      history.some((entry) => sameRef(observed.txRef, entry.prepared.txRef));
    if ((!retained || !sameRef(observed.txRef, retained.txRef)) && !replacedAttempt) {
      throw new DacsError(`pay-cross-chain-htlc: ${action} observation is not retained`);
    }
    if (observed.state === "pending" || observed.state === "failed") {
      if (observed.reason !== undefined && typeof observed.reason !== "string") {
        throw new DacsError(`pay-cross-chain-htlc: ${action} reason is invalid`);
      }
      continue;
    }
    if (observed.state !== "final") {
      throw new DacsError(`pay-cross-chain-htlc: ${action} state is invalid`);
    }
    if (observed.lockState !== undefined || observed.claimTxRef !== undefined ||
        observed.claimFinalityReachedAt !== undefined) {
      const claimRef: unknown = observed.claimTxRef;
      const claimRefValid = claimRef !== null && typeof claimRef === "object" &&
        (claimRef as HtlcTxRef).kind === "htlc-claim" &&
        typeof (claimRef as { claimTxHash?: unknown }).claimTxHash === "string" &&
        (claimRef as { claimTxHash: string }).claimTxHash.length > 0;
      // A claim of the lock is final no earlier than the lock's inclusion and
      // no later than the snapshot that reports it, as for the core's own claim.
      const claimFinality: unknown = observed.claimFinalityReachedAt;
      const claimFinalityValid = Number.isSafeInteger(claimFinality) && (claimFinality as number) >= 0 &&
        (claimFinality as number) <= snapshot.observedAt &&
        !(Number.isSafeInteger(observed.includedAt) && (claimFinality as number) < observed.includedAt!);
      if (action !== "source-lock" ||
          !["open", "claimed", "refunded"].includes(observed.lockState as string) ||
          (observed.lockState === "claimed"
            ? !claimRefValid || !claimFinalityValid
            : claimRef !== undefined || claimFinality !== undefined)) {
        throw new DacsError(`pay-cross-chain-htlc: ${action} disposition is invalid`);
      }
    }
    if (action === "source-lock" || action === "destination-lock") {
      try {
        // An unusable destination-lock expiry is the payee's chain fact; the
        // core refunds around it instead of discarding the whole snapshot.
        validateFinalityTiming(
          observed,
          action,
          !(action === "destination-lock" && destinationLockExpiryUnusable(observed)),
        );
        // Terms are only needed by the forward step that depends on them, so
        // their absence never makes an observation, and with it a refund,
        // unavailable.
        if (observed.lockTerms !== undefined) validateLockTerms(observed.lockTerms, action);
      } catch (error) {
        throw new InvalidLockObservation(
          error instanceof Error ? error.message : `pay-cross-chain-htlc: ${action} observation is invalid`,
        );
      }
    } else {
      validateFinalityTiming(observed, action);
    }
    if (action === "destination-claim" &&
        typeof observed.revealedPreimageHex !== "string") {
      throw new DacsError("pay-cross-chain-htlc: final destination claim omits the preimage");
    }
  }
}

function storedSettlementMatchesIntent(
  settlement: Readonly<CrossChainHtlcSettlement>,
  intent: Readonly<CrossChainHtlcIntent>,
): boolean {
  try {
    if (!Array.isArray(settlement.txRefs) || settlement.txRefs.length !== 4) return false;
    const expected = [
      { kind: "htlc-lock", chainId: intent.sourceChainId, contract: intent.sourceContractAddress },
      { kind: "htlc-lock", chainId: intent.destinationChainId, contract: intent.destinationContractAddress },
      { kind: "htlc-reveal", chainId: intent.destinationChainId, contract: intent.destinationContractAddress },
      { kind: "htlc-claim", chainId: intent.sourceChainId, contract: intent.sourceContractAddress },
    ] as const;
    const refsMatch = settlement.txRefs.every((ref, index) =>
      ref.kind === expected[index]!.kind &&
      ref.chainId === expected[index]!.chainId &&
      ref.contractAddress === expected[index]!.contract &&
      requireString(txHashOf(ref), "stored settlement txHash").length > 0);
    return refsMatch && settlement.paymentAmount.amount === intent.amount &&
      settlement.paymentAmount.currency === intent.currency &&
      settlement.settlementFinality.model === "htlc-reveal" &&
      Number.isSafeInteger(settlement.settlementFinality.sourceExpiry) &&
      settlement.settlementFinality.sourceExpiry > 0 &&
      Number.isSafeInteger(settlement.settlementFinality.finalityReachedAt) &&
      settlement.settlementFinality.finalityReachedAt >= 0 &&
      Number.isSafeInteger(settlement.settlementFinality.finalityObservedAt) &&
      settlement.settlementFinality.finalityObservedAt >= 0 &&
      settlement.settlementFinality.finalityReachedAt <=
        settlement.settlementFinality.finalityObservedAt &&
      settlement.settlementFinality.finalityReachedAt <= secondsToMilliseconds(
        settlement.settlementFinality.sourceExpiry,
        "stored settlement source expiry",
      ) &&
      HASH_RE.test(settlement.authenticationHash);
  } catch {
    return false;
  }
}

/**
 * Validates the retained rows against the intent: the source lock first, then
 * its source-finality checkpoint, then every row with that checkpoint (which
 * binds a destination lock). Throws on any mismatch.
 */
function captureRetainedActions(
  claimed: Readonly<Pick<Extract<HtlcStoreClaim, { status: "acquired" }>, "prepared" | "sourceFinalityCheckpoint">>,
  intent: Readonly<CrossChainHtlcIntent>,
): {
  retainedActions: readonly Readonly<HtlcPreparedAction>[];
  sourceFinalityCheckpoint: Readonly<HtlcSourceFinalityCheckpoint> | undefined;
} {
  const retainedSourceLocks = claimed.prepared.filter((item) => item.action === "source-lock");
  if (retainedSourceLocks.length > 1) {
    throw new DacsError("pay-cross-chain-htlc: retained action duplicate");
  }
  const rawSourceLock = retainedSourceLocks[0];
  let validatedSourceLock: Readonly<HtlcPreparedAction> | undefined;
  if (rawSourceLock) {
    const { effectHash, ...unsigned } = rawSourceLock;
    validatedSourceLock = validatePrepared(unsigned, intent, "source-lock");
    if (validatedSourceLock.effectHash !== effectHash) {
      throw new DacsError("pay-cross-chain-htlc: retained action integrity mismatch");
    }
  }
  const sourceFinalityCheckpoint = claimed.sourceFinalityCheckpoint === undefined
    ? undefined
    : captureSourceFinalityCheckpoint(claimed.sourceFinalityCheckpoint, validatedSourceLock);
  const retainedActions = claimed.prepared.map((item) => {
    const { effectHash, ...unsigned } = item;
    const validated = validatePrepared(
      unsigned,
      intent,
      item.action,
      sourceFinalityCheckpoint,
    );
    if (validated.effectHash !== effectHash) {
      throw new DacsError("pay-cross-chain-htlc: retained action integrity mismatch");
    }
    return validated;
  });
  return { retainedActions, sourceFinalityCheckpoint };
}

/**
 * A stored settlement is replayed only if it names exactly the retained
 * transactions: the checkpointed source lock, the destination lock bound to
 * that checkpoint, the checkpointed reveal and a retained source-claim
 * attempt, with the checkpointed source expiry. A settled row that names
 * another valid-looking claim or a later expiry would otherwise turn an
 * unrelated or late claim into a success.
 */
function storedSettlementMatchesRetained(
  claimed: Readonly<Extract<HtlcStoreClaim, { status: "settled" }>>,
  intent: Readonly<CrossChainHtlcIntent>,
): boolean {
  try {
    if (!storedSettlementMatchesIntent(claimed.settlement, intent) ||
        claimed.sourceFinalityCheckpoint === undefined || claimed.revealCheckpoint === undefined) {
      return false;
    }
    const { retainedActions, sourceFinalityCheckpoint } = captureRetainedActions(claimed, intent);
    const prepared = new Map(retainedActions.map((item) => [item.action, item] as const));
    if (!sourceFinalityCheckpoint || prepared.size !== retainedActions.length) return false;
    const sourceClaimHistory = captureClaimAttemptHistory(
      claimed.sourceClaimAttemptHistory,
      prepared,
      intent,
      "source-claim",
    );
    const destinationClaimHistory = captureClaimAttemptHistory(
      claimed.destinationClaimAttemptHistory,
      prepared,
      intent,
      "destination-claim",
    );
    const revealCheckpoint = captureRevealCheckpoint(claimed.revealCheckpoint, prepared, destinationClaimHistory);
    const destinationLock = prepared.get("destination-lock");
    const [sourceLockRef, destinationLockRef, revealRef, sourceClaimRef] = claimed.settlement.txRefs;
    return destinationLock !== undefined &&
      sameRef(sourceLockRef!, sourceFinalityCheckpoint.sourceLockTxRef) &&
      sameRef(destinationLockRef!, destinationLock.txRef) &&
      sameRef(revealRef!, revealCheckpoint.revealTxRef) &&
      namesRetainedAttempt(sourceClaimRef!, prepared.get("source-claim"), sourceClaimHistory) &&
      claimed.settlement.settlementFinality.sourceExpiry === sourceFinalityCheckpoint.sourceExpiry &&
      revealCheckpoint.sourceExpiry === sourceFinalityCheckpoint.sourceExpiry;
  } catch {
    return false;
  }
}

export async function advanceCrossChainHtlc(
  input: Readonly<AdvanceCrossChainHtlcInput>,
): Promise<CrossChainHtlcProgress> {
  const inputInvalid: CrossChainHtlcProgress = { status: "indeterminate", reason: "htlc-call-input-invalid" };
  if (input == null) return inputInvalid;
  const authorizeDestinationClaim = input.authorizeDestinationClaim === true;
  const store = input.store;
  const adapter = input.adapter;
  // Capture callbacks once: a getter can change or throw on a later read.
  // Malformed dependencies remain correctable before any session is claimed.
  const callbacks = (() => {
    try {
      if (!store || !adapter) return undefined;
      const { claim, isCurrent, recordPrepared, recordSourceFinality,
        replacePreparedSourceClaim, replacePreparedDestinationClaim,
        recordRevealFinal, recordSettlement } = store;
      const { observe, observeSourceLeg, prepareAction, broadcastRetained } = adapter;
      if ([claim, isCurrent, recordPrepared, replacePreparedSourceClaim,
        recordRevealFinal, recordSettlement, observe, prepareAction, broadcastRetained]
        .some((callback) => typeof callback !== "function")) return undefined;
      return {
        claimSettlement: claim.bind(store),
        isCurrentSettlement: isCurrent.bind(store),
        recordPrepared: recordPrepared.bind(store),
        recordSourceFinality: typeof recordSourceFinality === "function"
          ? recordSourceFinality.bind(store) : undefined,
        replacePreparedSourceClaim: replacePreparedSourceClaim.bind(store),
        replacePreparedDestinationClaim: typeof replacePreparedDestinationClaim === "function"
          ? replacePreparedDestinationClaim.bind(store) : undefined,
        recordRevealFinal: recordRevealFinal.bind(store),
        recordSettlement: recordSettlement.bind(store),
        observeLedger: observe.bind(adapter),
        observeSourceLedger: typeof observeSourceLeg === "function"
          ? observeSourceLeg.bind(adapter) : undefined,
        prepareAdapterAction: prepareAction.bind(adapter),
        broadcastAdapterAction: broadcastRetained.bind(adapter),
      };
    } catch {
      return undefined;
    }
  })();
  if (!callbacks) return inputInvalid;
  const { claimSettlement, isCurrentSettlement, recordPrepared, recordSourceFinality,
    replacePreparedSourceClaim, replacePreparedDestinationClaim, recordRevealFinal,
    recordSettlement, observeLedger, observeSourceLedger, prepareAdapterAction,
    broadcastAdapterAction } = callbacks;
  const now = input.now ?? Date.now;
  // Input that cannot even name a session (an unusable owner, lease,
  // authority or hashlock deriver) says nothing about whether one exists:
  // a live session may still need driving with corrected input, so this is
  // never `failed`, which would tell the host the session and its salt can
  // go. The host pages and retries with corrected input; nothing is read or
  // moved until then.
  let owner: string;
  let leaseDurationMs: number;
  try {
    owner = requireString(input.owner, "owner");
    leaseDurationMs = requireUInt(
      input.leaseDurationMs ?? DEFAULT_LEASE_MS,
      "leaseDurationMs",
      true,
    );
  } catch {
    return inputInvalid;
  }
  const readNow = (): number => requireUInt(now(), "clock");
  // A missing or different salt is a host error the host can correct, not the
  // end of a session: one may still need driving, and only its original salt
  // can drive it. So neither is ever `failed`, which would tell the host the
  // salt can go.
  if (!(input.buyerSalt instanceof Uint8Array) || input.buyerSalt.byteLength < 16) {
    return { status: "operator-alert", reason: "htlc-salt-missing", txRefs: [] };
  }
  let created: Readonly<{
    intent: Readonly<CrossChainHtlcIntent>;
    secrets: Readonly<CrossChainHtlcSecrets>;
  }>;
  try {
    created = createCrossChainHtlcIntent(input.authority, input.buyerSalt, input.hashlocks);
  } catch {
    return inputInvalid;
  }
  const { intent, secrets } = created;
  let claimed: HtlcStoreClaim;
  let claimNow: number;
  try {
    // A host clock that is not a non-negative safe integer is call input.
    claimNow = readNow();
  } catch {
    return inputInvalid;
  }
  try {
    claimed = await claimSettlement({
      intent,
      secrets: Object.freeze({
        ...secrets,
        buyerSalt: secretCopy(secrets.buyerSalt),
        preimage: secretCopy(secrets.preimage),
      }),
      owner,
      now: claimNow,
      leaseDurationMs,
    });
  } catch {
    return { status: "indeterminate", reason: "htlc-settlement-store-unavailable" };
  }
  if (!claimed || typeof claimed !== "object" ||
      !["acquired", "waiting", "settled", "conflict", "corrupt"].includes(claimed.status) ||
      ((claimed.status === "conflict" || claimed.status === "corrupt") &&
        typeof claimed.reason !== "string")) {
    return { status: "indeterminate", reason: "htlc-settlement-store-claim-invalid" };
  }
  if ("intent" in claimed) {
    try {
      if (canonicalize(claimed.intent) !== canonicalize(intent)) {
        return { status: "indeterminate", reason: "htlc-settlement-store-intent-mismatch" };
      }
    } catch {
      return { status: "indeterminate", reason: "htlc-settlement-store-intent-invalid" };
    }
  }
  if (claimed.status === "waiting") return { status: "waiting", reason: "htlc-settlement-held" };
  if (claimed.status === "settled") {
    const mismatch: CrossChainHtlcProgress = { status: "indeterminate", reason: "htlc-stored-settlement-mismatch" };
    // Check and return one data copy: a getter-backed claim could otherwise
    // pass one settlement through the check and return another.
    let settled: Extract<HtlcStoreClaim, { status: "settled" }>;
    try {
      settled = structuredClone(claimed);
    } catch {
      return mismatch;
    }
    return storedSettlementMatchesRetained(settled, intent)
      ? { status: "settled", settlement: settled.settlement }
      : mismatch;
  }
  if (claimed.status === "conflict") {
    // The store holds this session under another salt or binding, or the salt
    // belongs to another session: the wrong salt, not a finished session.
    return { status: "operator-alert", reason: "htlc-salt-mismatch", txRefs: [] };
  }
  if (claimed.status !== "acquired") {
    return { status: "failed", errorClass: "permanent", reason: claimed.reason };
  }
  if (!recordSourceFinality) {
    return {
      status: "failed",
      errorClass: "permanent",
      reason: "htlc-source-finality-store-unsupported",
    };
  }
  if (!replacePreparedDestinationClaim) {
    return {
      status: "failed",
      errorClass: "permanent",
      reason: "htlc-destination-claim-replacement-store-unsupported",
    };
  }
  if (!claimed.lease || typeof claimed.lease !== "object" || claimed.lease.owner !== owner ||
      !Number.isSafeInteger(claimed.lease.generation) || claimed.lease.generation <= 0 ||
      !Number.isSafeInteger(claimed.lease.expiresAt) || claimed.lease.expiresAt <= claimNow) {
    return { status: "indeterminate", reason: "htlc-settlement-store-lease-invalid" };
  }
  const fence: Readonly<HtlcEffectFence> = Object.freeze({
    settlementKey: intent.settlementKey,
    bindingHash: intent.bindingHash,
    owner: claimed.lease.owner,
    generation: claimed.lease.generation,
    assertCurrent: async () => {
      if (!await isCurrentSettlement({
        settlementKey: intent.settlementKey,
        bindingHash: intent.bindingHash,
        owner: claimed.lease.owner,
        generation: claimed.lease.generation,
        now: readNow(),
      })) throw new DacsError("pay-cross-chain-htlc: stale effect fence");
    },
  });
  // An adapter call still running when this call's lease lapses is abandoned:
  // its outcome is fenced off by then anyway (a preparation is discarded
  // unrecorded, a broadcast is uncertain, an observation unavailable), so
  // waiting for it could only keep this call, and a host that awaits it, from
  // reaching the next one. A call given only a share of the lease time left
  // is abandoned once that share has passed, so that what follows it in this
  // call still runs under a live lease.
  const leaseExpiresAt = claimed.lease.expiresAt;
  const withinLease = async <T>(call: () => Promise<T>, leaseShare = 1): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lapsed = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new DacsError("pay-cross-chain-htlc: adapter call outlasted its deadline")),
        Math.min(Math.floor(Math.max(0, leaseExpiresAt - readNow()) * leaseShare), MAX_TIMER_MS),
      );
    });
    try {
      return await Promise.race([call(), lapsed]);
    } finally {
      clearTimeout(timer);
    }
  };
  const prepareAction: typeof prepareAdapterAction = (request, effectFence) =>
    withinLease(() => prepareAdapterAction(request, effectFence));
  const broadcastRetained: typeof broadcastAdapterAction = (action, effectFence) =>
    withinLease(() => broadcastAdapterAction(action, effectFence));
  let retainedActions: readonly Readonly<HtlcPreparedAction>[];
  let sourceFinalityCheckpoint: Readonly<HtlcSourceFinalityCheckpoint> | undefined;
  try {
    ({ retainedActions, sourceFinalityCheckpoint } = captureRetainedActions(claimed, intent));
  } catch (error) {
    return {
      status: "failed",
      errorClass: "permanent",
      reason: error instanceof Error ? error.message : "htlc-retained-action-corrupt",
    };
  }
  const prepared = new Map(retainedActions.map((item) => [item.action, item] as const));
  if (prepared.size !== retainedActions.length) {
    return { status: "failed", errorClass: "permanent", reason: "htlc-retained-action-duplicate" };
  }
  let sourceClaimAttemptHistory: readonly Readonly<HtlcSourceClaimAttemptHistoryEntry>[];
  let destinationClaimAttemptHistory: readonly Readonly<HtlcDestinationClaimAttemptHistoryEntry>[];
  try {
    sourceClaimAttemptHistory = captureClaimAttemptHistory(
      claimed.sourceClaimAttemptHistory,
      prepared,
      intent,
      "source-claim",
    );
    destinationClaimAttemptHistory = captureClaimAttemptHistory(
      claimed.destinationClaimAttemptHistory,
      prepared,
      intent,
      "destination-claim",
    );
  } catch (error) {
    return {
      status: "failed",
      errorClass: "permanent",
      reason: error instanceof Error ? error.message : "htlc-claim-history-corrupt",
    };
  }
  let retainedCheckpoint: Readonly<HtlcRevealCheckpoint> | undefined;
  try {
    retainedCheckpoint = claimed.revealCheckpoint === undefined
      ? undefined
      : captureRevealCheckpoint(claimed.revealCheckpoint, prepared, destinationClaimAttemptHistory);
  } catch (error) {
    return {
      status: "failed",
      errorClass: "permanent",
      reason: error instanceof Error ? error.message : "htlc-reveal-checkpoint-corrupt",
    };
  }
  if (retainedCheckpoint && sourceFinalityCheckpoint &&
      retainedCheckpoint.sourceExpiry !== sourceFinalityCheckpoint.sourceExpiry) {
    return { status: "failed", errorClass: "permanent", reason: "htlc-reveal-checkpoint-conflict" };
  }
  let lockObservationInvalid = false;
  const observe = async (): Promise<Readonly<HtlcLedgerSnapshot> | null> => {
    try {
      await fence.assertCurrent();
      const snapshot = await withinLease(() => observeLedger(intent, fence));
      await fence.assertCurrent();
      validateSnapshot(snapshot, prepared, sourceClaimAttemptHistory, destinationClaimAttemptHistory);
      return snapshot;
    } catch (error) {
      lockObservationInvalid = error instanceof InvalidLockObservation;
      return null;
    }
  };
  // The source chain alone, through the adapter's source-leg observation: null
  // when the adapter has none, or it fails or outlasts half the lease time
  // left, and also when it is invalid or reports another leg's action, which
  // sets `sourceObservationInvalid`. Half, so that a first refund sent from
  // the checkpoint without it still has a live lease to be prepared and
  // broadcast under.
  let sourceObservationInvalid = false;
  const observeSource = async (): Promise<Readonly<HtlcLedgerSnapshot> | null> => {
    if (!observeSourceLedger) return null;
    let snapshot: Readonly<HtlcLedgerSnapshot>;
    try {
      await fence.assertCurrent();
      snapshot = await withinLease(() => observeSourceLedger(intent, fence), 1 / 2);
      await fence.assertCurrent();
    } catch {
      return null;
    }
    try {
      validateSnapshot(snapshot, prepared, sourceClaimAttemptHistory, destinationClaimAttemptHistory);
      if (Object.keys(snapshot.actions).some((action) => !SOURCE_LEG_ACTIONS.has(action as HtlcAction))) {
        throw new DacsError("pay-cross-chain-htlc: source-leg observation reports another leg");
      }
      return snapshot;
    } catch {
      sourceObservationInvalid = true;
      return null;
    }
  };
  // A retained refund can never land once the adapter reports it `absent`
  // naming it, so its bytes are not re-sent; only replacing it could help, and
  // that needs a person until refund replacement exists. An `absent` that
  // names no transaction says only that nothing is on chain for the leg: it
  // makes the core prepare a first refund, and a retained one may still land,
  // so its exact bytes are rebroadcast as when it is unreported.
  const refundAbsent = (
    leg: "source-refund" | "destination-refund",
    latest: Readonly<HtlcLedgerSnapshot>,
  ): boolean => {
    const retained = prepared.get(leg);
    const observed = latest.actions[leg];
    return retained !== undefined && observed?.state === "absent" &&
      observed.txRef !== undefined && sameRef(observed.txRef, retained.txRef);
  };
  // The same rule for the payee's retained destination lock: only an `absent`
  // naming it proves it can never land, so its leg is no longer owed and its
  // dead bytes are not rebroadcast. An `absent` that names no transaction
  // says only that nothing is on chain yet; the retained lock may still land,
  // so it stays an owed leg, as when it is `pending` or unreported.
  const destinationLockAbsent = (latest: Readonly<HtlcLedgerSnapshot>): boolean => {
    const retained = prepared.get("destination-lock");
    const observed = latest.actions["destination-lock"];
    return retained !== undefined && observed?.state === "absent" &&
      observed.txRef !== undefined && sameRef(observed.txRef, retained.txRef);
  };
  // Reports each locked leg's refund from the latest observation. `sent` is a
  // refund broadcast in this call, reported as refunded only on a later call;
  // until the adapter reports it, or while it still reads `absent` in this
  // same call, it is `pending`, so only a later call can find it `absent`.
  // A tracked destination leg keeps its retained lock's reference even while
  // the adapter does not report that lock, or reports it `absent` naming
  // nothing, and a refund sent in this call keeps its own, so that a host can
  // follow it; the retained actions in `unreported` keep theirs while the
  // adapter does not report them.
  const refundProgress = (
    reason: HtlcRefundReason,
    latest: Readonly<HtlcLedgerSnapshot>,
    attempts: Partial<Record<"source-refund" | "destination-refund", "none" | "sent" | "uncertain">>,
    unreported: readonly HtlcAction[] = [],
  ): CrossChainHtlcProgress => {
    const refunds: Partial<Record<"source-refund" | "destination-refund", HtlcRefundLegState>> = {};
    for (const leg of ["destination-refund", "source-refund"] as const) {
      const attempt = attempts[leg];
      if (attempt === undefined) continue;
      const observed = latest.actions[leg];
      refunds[leg] = attempt === "uncertain"
        ? "uncertain"
        : observed && observed.state !== "absent"
          ? observed.state
          : attempt === "sent"
            ? "pending"
            : refundAbsent(leg, latest) ? "absent" : "waiting";
    }
    const states = Object.values(refunds);
    const named: HtlcAction[] = [
      ...attempts["destination-refund"] === undefined ? [] : ["destination-lock" as const],
      ...(["destination-refund", "source-refund"] as const).filter((leg) => attempts[leg] === "sent"),
    ];
    if (states.includes("absent")) {
      return {
        status: "operator-alert",
        reason: "htlc-refund-absent",
        txRefs: collectRefs(
          latest,
          prepared,
          unreported,
          [
            ...named,
            ...(["destination-refund", "source-refund"] as const).filter((leg) => refunds[leg] === "absent"),
          ],
        ),
        refunds: Object.freeze(refunds),
      };
    }
    return {
      status: states.includes("failed")
        ? "refund-stalled"
        : !Object.values(attempts).includes("sent") && states.every((state) => state === "final")
          ? "refunded"
          : "refund-pending",
      reason,
      txRefs: collectRefs(latest, prepared, unreported, named),
      refunds: Object.freeze(refunds),
    };
  };
  const operatorAlert = (
    reason: HtlcOperatorAlertReason,
    latest: Readonly<HtlcLedgerSnapshot>,
    includeRetained: readonly HtlcAction[] = [],
    known: Readonly<Partial<Record<HtlcAction, Readonly<HtlcTxRef>>>> = {},
  ): CrossChainHtlcProgress => ({
    status: "operator-alert",
    reason,
    txRefs: collectRefs(latest, prepared, [], includeRetained, known),
  });
  // A reveal that failed on chain published the preimage in its calldata; one
  // that is only authenticated `absent` broadcast it, so the mempool may have
  // seen it. Either way the payee may claim the source.
  const revealExposedReason = (activeFailed: boolean): HtlcOperatorAlertReason =>
    activeFailed || destinationClaimAttemptHistory.some((entry) => entry.failedObservation.state === "failed")
      ? "htlc-destination-claim-failed-preimage-public"
      : "htlc-destination-claim-absent-preimage-broadcast";
  // The active claim attempt as authenticated unlanded: `failed` on chain, or
  // `absent` naming that attempt. An `absent` that names an earlier attempt,
  // or none, says nothing about the active one.
  const unlandedActiveClaim = (
    action: "source-claim" | "destination-claim",
    latest: Readonly<HtlcLedgerSnapshot>,
  ): Readonly<HtlcFailedObservation> | undefined => {
    const active = prepared.get(action);
    const observed = latest.actions[action];
    if (!active || !observed) return undefined;
    if (observed.state === "absent") {
      return observed.txRef !== undefined && sameRef(observed.txRef, active.txRef)
        ? Object.freeze({
          state: "absent",
          txRef: active.txRef,
          authenticationHash: observed.authenticationHash,
        })
        : undefined;
    }
    return observed.state === "failed" && sameRef(observed.txRef, active.txRef)
      ? observed as Readonly<HtlcFailedObservation>
      : undefined;
  };
  // A retained claim reported `absent` without naming its active attempt: it
  // is never replaced on that report.
  const unboundAbsentClaim = (
    action: "source-claim" | "destination-claim",
    latest: Readonly<HtlcLedgerSnapshot>,
  ): boolean => prepared.has(action) && latest.actions[action]?.state === "absent" &&
    !unlandedActiveClaim(action, latest);
  // ST-8 past the source expiry after a final reveal. Every replaced attempt
  // was authenticated unlanded before it was replaced, and none is prepared
  // after the expiry, so once the active claim is unlanded too no claim the
  // core sent can complete. That alone does not expire the session: the most
  // common reason a claim reverts is that the payee, or anyone holding the
  // public preimage, already claimed the lock outside the core. Only a lock
  // authenticated unclaimed past the expiry makes the interim record stand
  // and the session terminal. A lock spent by another claim final within the
  // window is that claim's resolution (ST-8(a)), even while a claim the core
  // sent is pending: that claim can no longer spend the lock. A refunded lock
  // likewise rules out any pending claim and establishes expiry. One final only
  // after the window is the expiry, as for a claim the core sent, and keeps
  // the claim. An unreported disposition stays resumable.
  const sourceClaimMissed = (
    latest: Readonly<HtlcLedgerSnapshot>,
    known: Readonly<Partial<Record<HtlcAction, Readonly<HtlcTxRef>>>>,
    sourceExpiry: number,
  ): CrossChainHtlcProgress => {
    const ownClaimDead = !prepared.has("source-claim") ||
      unlandedActiveClaim("source-claim", latest) !== undefined;
    const lock = latest.actions["source-lock"];
    const lockState = lock?.state === "final" ? lock.lockState : undefined;
    if (lockState === "refunded" || (ownClaimDead && lockState === "open")) {
      return { status: "failed", errorClass: "settlement-atomicity", reason: "dest-revealed-source-unclaimed-expired" };
    }
    const txRefs = collectRefs(latest, prepared, [], ["destination-lock"], known);
    if (lock?.state === "final" && lockState === "claimed" && lock.claimTxRef &&
        lock.claimFinalityReachedAt !== undefined) {
      const active = prepared.get("source-claim");
      const claimHash = lock.claimTxRef.claimTxHash;
      // A lock spent by a claim the core sent that this same snapshot reports
      // unlanded, a replaced attempt included (each was authenticated unlanded
      // before it was replaced), contradicts itself: neither resolved nor
      // expired. While the active claim is pending its own report decides.
      if (active?.txRef.kind === "htlc-claim" && active.txRef.claimTxHash === claimHash) {
        if (ownClaimDead) return { status: "indeterminate", reason: "htlc-source-lock-disposition-contradicted" };
      } else if (sourceClaimAttemptHistory.some((entry) =>
        entry.prepared.txRef.kind === "htlc-claim" && entry.prepared.txRef.claimTxHash === claimHash)) {
        return { status: "indeterminate", reason: "htlc-source-lock-disposition-contradicted" };
      } else {
        // The intent fixes the claim's chain and contract; only the hash is
        // the adapter's.
        const sourceClaimTxRef = expectedRef({
          intent,
          action: "source-claim",
          txHash: claimHash,
        }) as Extract<HtlcTxRef, { kind: "htlc-claim" }>;
        const recoveryDeadline = secondsToMilliseconds(sourceExpiry, "source recovery expiry");
        if (lock.claimFinalityReachedAt > recoveryDeadline) {
          return lateSourceClaimExpired(sourceClaimTxRef, lock.claimFinalityReachedAt, recoveryDeadline);
        }
        return {
          status: "operator-alert",
          reason: "htlc-source-claimed-outside-core",
          txRefs,
          sourceClaimTxRef,
          sourceClaimFinalityReachedAt: lock.claimFinalityReachedAt,
          recoveryDeadline,
        };
      }
    }
    return {
      status: "operator-alert",
      reason: "htlc-source-claim-missed-after-reveal",
      txRefs,
      sourceClaimPending: !ownClaimDead,
    };
  };
  // A final destination lock's expiry and terms are immutable. If either rules
  // out a safe reveal, the payer never reveals and each leg is refunded at its
  // own expiry instead of the session stopping with both legs locked. No reveal
  // checkpoint exists where this is asked, so the terms still decide a first
  // reveal. Once the destination has expired no reveal is possible and terms
  // the adapter can no longer read (for example after the destination refund)
  // change nothing. A retained reveal was prepared against matching terms and
  // may already have exposed the preimage, so terms read later never hold back
  // its rebroadcast.
  const revealForbiddenBy = (
    lock: Readonly<FinalHtlcObservation>,
    lockExpiresAt: number,
    sourceExpiry: number,
    destinationExpired: boolean,
  ): HtlcRefundReason | undefined => {
    // An unusable expiry is checked first: the margin cannot be computed for it.
    if (destinationLockExpiryUnusable(lock)) return "destination-lock-expiry-invalid";
    const sourceRecoveryBudgetSec = safeAdd(
      intent.sourceFinalitySec,
      intent.safetyWindowSec,
      "source finality and safety budget",
    );
    if (sourceExpiry <= safeAdd(lockExpiresAt, sourceRecoveryBudgetSec, "absolute expiry margin")) {
      return "destination-expiry-margin-insufficient";
    }
    const termsVerdict = prepared.has("destination-claim")
      ? undefined
      : lockTermsVerdict(lock, expectedDestinationLockTerms(intent));
    return termsVerdict === "mismatch"
      ? "destination-lock-terms-mismatch"
      : termsVerdict === "missing" && !destinationExpired
        ? "destination-lock-terms-missing"
        : undefined;
  };
  let destinationClaimCutoffReached = false;
  let destinationClaimReplacementBlocked = false;
  let sourceClaimExpiryReached = false;
  let sourceClaimReplacementLimitReached = false;
  const destinationClaimWindowIsOpen = (expiries: {
    sourceExpiry?: number;
    destinationExpiry?: number;
  }): boolean => {
    if (expiries.sourceExpiry === undefined || expiries.destinationExpiry === undefined) {
      return false;
    }
    const sourceRecoveryBudgetSec = safeAdd(
      intent.sourceFinalitySec,
      intent.safetyWindowSec,
      "source finality and safety budget",
    );
    const destinationCutoff = finalityCutoffMillis(
      expiries.destinationExpiry,
      intent.destinationFinalitySec,
      "destination claim",
    );
    const sourceCutoff = finalityCutoffMillis(
      expiries.sourceExpiry,
      sourceRecoveryBudgetSec,
      "source recovery",
    );
    const currentTime = readNow();
    return currentTime < destinationCutoff && currentTime < sourceCutoff;
  };
  const sourceClaimWindowIsOpen = (sourceExpiry: number | undefined): boolean =>
    sourceExpiry !== undefined &&
    readNow() < secondsToMilliseconds(sourceExpiry, "source claim expiry");
  const actionWindowIsOpen = (
    action: HtlcAction,
    expiries: { sourceExpiry?: number; destinationExpiry?: number },
  ): boolean => {
    if (action === "destination-claim" && !destinationClaimWindowIsOpen(expiries)) {
      destinationClaimCutoffReached = true;
      return false;
    }
    if (action === "source-claim" && !sourceClaimWindowIsOpen(expiries.sourceExpiry)) {
      sourceClaimExpiryReached = true;
      return false;
    }
    return true;
  };
  const execute = async (
    action: HtlcAction,
    context: {
      sourceExpiry?: number;
      destinationExpiry?: number;
      sourceFinalityCheckpoint?: Readonly<HtlcSourceFinalityCheckpoint>;
    } = {},
    observeAfter: () => Promise<Readonly<HtlcLedgerSnapshot> | null> = observe,
    // Set when the broadcast went through, whether or not `observeAfter` can
    // then observe it.
    outcome?: { broadcast: boolean },
  ): Promise<Readonly<HtlcLedgerSnapshot> | null> => {
    let retained = prepared.get(action);
    if (!retained) {
      try {
        if (!actionWindowIsOpen(action, context)) return null;
        await fence.assertCurrent();
        if (!actionWindowIsOpen(action, context)) return null;
        retained = validatePrepared(await prepareAction({
          intent,
          action,
          actor: actorFor(action),
          preimage: action === "destination-claim" || action === "source-claim"
            ? secretCopy(secrets.preimage)
            : undefined,
          ...context,
        }, fence), intent, action, context.sourceFinalityCheckpoint);
        if (!actionWindowIsOpen(action, context)) return null;
        await fence.assertCurrent();
        if (!actionWindowIsOpen(action, context)) return null;
      } catch {
        return null;
      }
      let recorded: HtlcStoreWrite;
      try {
        recorded = await recordPrepared({
          settlementKey: intent.settlementKey,
          bindingHash: intent.bindingHash,
          owner: fence.owner,
          generation: fence.generation,
          prepared: retained,
        });
      } catch {
        return null;
      }
      if (recorded.status !== "recorded" && recorded.status !== "existing") return null;
      prepared.set(action, retained);
    }
    try {
      if (!actionWindowIsOpen(action, context)) return null;
      await fence.assertCurrent();
      if (!actionWindowIsOpen(action, context)) return null;
      await broadcastRetained(retained, fence);
      await fence.assertCurrent();
    } catch {
      return null;
    }
    if (outcome) outcome.broadcast = true;
    return observeAfter();
  };
  const replaceFailedSourceClaim = async (
    failedObservation: Readonly<HtlcFailedObservation>,
    sourceExpiry: number,
  ): Promise<Readonly<HtlcLedgerSnapshot> | null> => {
    const prior = prepared.get("source-claim");
    if (!prior) {
      return null;
    }
    if (!sourceClaimWindowIsOpen(sourceExpiry)) {
      sourceClaimExpiryReached = true;
      return null;
    }
    // Each replacement is a fresh fee-paying claim; past the cap, a claim
    // that keeps failing (a paused contract, a lock claimed outside the core)
    // needs a person.
    if (sourceClaimAttemptHistory.length >= MAX_SOURCE_CLAIM_REPLACEMENTS) {
      sourceClaimReplacementLimitReached = true;
      return null;
    }
    let replacement: Readonly<HtlcPreparedAction>;
    try {
      await fence.assertCurrent();
      if (!sourceClaimWindowIsOpen(sourceExpiry)) {
        sourceClaimExpiryReached = true;
        return null;
      }
      const replacementContext: Readonly<HtlcSourceClaimReplacementContext> = Object.freeze({
        attempt: sourceClaimAttemptHistory.length + 2,
        priorEffectHash: prior.effectHash,
        priorTxRef: prior.txRef as Extract<HtlcTxRef, { kind: "htlc-claim" }>,
        failureAuthenticationHash: failedObservation.authenticationHash,
      });
      replacement = validatePrepared(await prepareAction({
        intent,
        action: "source-claim",
        actor: actorFor("source-claim"),
        preimage: secretCopy(secrets.preimage),
        sourceExpiry,
        replacement: replacementContext,
      }, fence), intent, "source-claim");
      if (!sourceClaimWindowIsOpen(sourceExpiry)) {
        sourceClaimExpiryReached = true;
        return null;
      }
      await fence.assertCurrent();
      if (!sourceClaimWindowIsOpen(sourceExpiry)) {
        sourceClaimExpiryReached = true;
        return null;
      }
      if (replacement.effectHash === prior.effectHash || sameRef(replacement.txRef, prior.txRef)) {
        throw new DacsError("pay-cross-chain-htlc: source-claim replacement is not fresh");
      }
    } catch {
      return null;
    }
    let recorded: HtlcStoreWrite;
    try {
      recorded = await replacePreparedSourceClaim({
        settlementKey: intent.settlementKey,
        bindingHash: intent.bindingHash,
        owner: fence.owner,
        generation: fence.generation,
        now: readNow(),
        priorEffectHash: prior.effectHash,
        priorTxRef: prior.txRef as Extract<HtlcTxRef, { kind: "htlc-claim" }>,
        failedObservation,
        replacement,
      });
    } catch {
      return null;
    }
    if (recorded.status !== "recorded" && recorded.status !== "existing") return null;
    sourceClaimAttemptHistory = Object.freeze([
      ...sourceClaimAttemptHistory,
      Object.freeze({
        attempt: sourceClaimAttemptHistory.length + 1,
        prepared: prior,
        failedObservation: captureFailedObservation(failedObservation, prior),
        replacementEffectHash: replacement.effectHash,
      }),
    ]);
    prepared.set("source-claim", replacement);
    try {
      if (!sourceClaimWindowIsOpen(sourceExpiry)) {
        sourceClaimExpiryReached = true;
        return null;
      }
      await fence.assertCurrent();
      if (!sourceClaimWindowIsOpen(sourceExpiry)) {
        sourceClaimExpiryReached = true;
        return null;
      }
      await broadcastRetained(replacement, fence);
      await fence.assertCurrent();
    } catch {
      return null;
    }
    return observe();
  };
  // Replaces a reveal the adapter authenticated as `failed` or `absent`. It
  // has already broadcast the preimage, so a fresh reveal costs the payer
  // nothing and is the payer's only way to the destination funds. It is
  // bounded like the first reveal, by the destination-claim cutoff, and capped
  // per session. When no replacement is allowed it sets
  // `destinationClaimReplacementBlocked` so that the caller raises an operator
  // alert; other failures, including a failed preparation, are uncertain.
  const replaceFailedDestinationClaim = async (
    failedObservation: Readonly<HtlcFailedObservation>,
    expiries: { sourceExpiry: number; destinationExpiry: number },
  ): Promise<Readonly<HtlcLedgerSnapshot> | null> => {
    const prior = prepared.get("destination-claim");
    if (!prior) {
      return null;
    }
    const blocked = (): null => {
      destinationClaimReplacementBlocked = true;
      return null;
    };
    if (!replacePreparedDestinationClaim ||
        destinationClaimAttemptHistory.length >= MAX_DESTINATION_CLAIM_REPLACEMENTS) {
      return blocked();
    }
    let replacement: Readonly<HtlcPreparedAction>;
    try {
      if (!destinationClaimWindowIsOpen(expiries)) return blocked();
      await fence.assertCurrent();
      if (!destinationClaimWindowIsOpen(expiries)) return blocked();
    } catch {
      return null;
    }
    try {
      const replacementContext: Readonly<HtlcDestinationClaimReplacementContext> = Object.freeze({
        attempt: destinationClaimAttemptHistory.length + 2,
        priorEffectHash: prior.effectHash,
        priorTxRef: prior.txRef as Extract<HtlcTxRef, { kind: "htlc-reveal" }>,
        failureAuthenticationHash: failedObservation.authenticationHash,
      });
      replacement = validatePrepared(await prepareAction({
        intent,
        action: "destination-claim",
        actor: actorFor("destination-claim"),
        preimage: secretCopy(secrets.preimage),
        ...expiries,
        replacement: replacementContext,
      }, fence), intent, "destination-claim");
      if (replacement.effectHash === prior.effectHash || sameRef(replacement.txRef, prior.txRef)) {
        throw new DacsError("pay-cross-chain-htlc: destination-claim replacement is not fresh");
      }
    } catch {
      // A preparation that failed (a timeout, a 5xx or a refusal look alike)
      // or returned no usable replacement is uncertain, as for a source claim:
      // the next call retries while the claim window is open, and only a
      // closed window blocks the replacement.
      return null;
    }
    let recorded: HtlcStoreWrite;
    try {
      if (!destinationClaimWindowIsOpen(expiries)) return blocked();
      await fence.assertCurrent();
      if (!destinationClaimWindowIsOpen(expiries)) return blocked();
      recorded = await replacePreparedDestinationClaim({
        settlementKey: intent.settlementKey,
        bindingHash: intent.bindingHash,
        owner: fence.owner,
        generation: fence.generation,
        now: readNow(),
        priorEffectHash: prior.effectHash,
        priorTxRef: prior.txRef as Extract<HtlcTxRef, { kind: "htlc-reveal" }>,
        failedObservation,
        replacement,
      });
    } catch {
      return null;
    }
    if (recorded.status !== "recorded" && recorded.status !== "existing") return null;
    destinationClaimAttemptHistory = Object.freeze([
      ...destinationClaimAttemptHistory,
      Object.freeze({
        attempt: destinationClaimAttemptHistory.length + 1,
        prepared: prior,
        failedObservation: captureFailedObservation(failedObservation, prior),
        replacementEffectHash: replacement.effectHash,
      }),
    ]);
    prepared.set("destination-claim", replacement);
    try {
      if (!destinationClaimWindowIsOpen(expiries)) return blocked();
      await fence.assertCurrent();
      if (!destinationClaimWindowIsOpen(expiries)) return blocked();
      await broadcastRetained(replacement, fence);
      await fence.assertCurrent();
    } catch {
      return null;
    }
    return observe();
  };
  // The source-finality checkpoint of a final source-lock observation, whether
  // the whole session or the source leg alone reported it.
  const sourceFinalityCheckpointOf = (
    lock: Readonly<FinalHtlcObservation>,
    includedAt: number,
    sourceExpiry: number,
  ): Readonly<HtlcSourceFinalityCheckpoint> => Object.freeze({
    sourceLockEffectHash: prepared.get("source-lock")!.effectHash,
    sourceLockTxRef: lock.txRef as Extract<HtlcTxRef, { kind: "htlc-lock" }>,
    includedAt,
    sourceExpiry,
    finalityObservedAt: lock.finalityObservedAt,
    authenticationHash: lock.authenticationHash,
  });
  const persistSourceFinality = async (
    checkpoint: Readonly<HtlcSourceFinalityCheckpoint>,
  ): Promise<boolean> => {
    let checkpointed: HtlcStoreWrite;
    try {
      checkpointed = await recordSourceFinality({
        settlementKey: intent.settlementKey,
        bindingHash: intent.bindingHash,
        owner: fence.owner,
        generation: fence.generation,
        checkpoint,
      });
    } catch {
      return false;
    }
    return checkpointed.status === "recorded" || checkpointed.status === "existing";
  };

  // The payer's source refund is decided on the source leg alone and sent
  // before the whole session is observed, so that nothing on the payee's side
  // (its role service, the destination chain, or an `observe` that depends on
  // either and fails or never returns) can delay, skip or reorder it. It is
  // due only on durable evidence: the source lock was final (the checkpoint),
  // its expiry has passed, and no reveal or source claim is retained, so the
  // preimage never left the core. The adapter's source-leg observation then
  // applies the refund path's rule: a refund is sent when none is reported or
  // an `absent` names none, and one reported `pending`, `final`, `failed` or
  // `absent` naming it is never re-sent. When that observation is unavailable
  // only a first refund is prepared, from the checkpoint; a retained one is
  // left to the whole-session path, because only an observation can show it
  // is not dead. An invalid one, like a source lock it does not report final
  // as checkpointed, leaves the whole refund to that path.
  //
  // Until the checkpoint exists, the source-leg observation records it from
  // the retained source lock reported final, as the whole-session path does,
  // so that a payee side down from the source-lock broadcast onward cannot
  // keep the refund from ever becoming due.
  const preimageNeverLeft = !retainedCheckpoint && !prepared.has("destination-claim") &&
    !prepared.has("source-claim");
  let checkpointView: Readonly<HtlcLedgerSnapshot> | undefined;
  if (!sourceFinalityCheckpoint && prepared.has("source-lock") && preimageNeverLeft) {
    const view = await observeSource();
    let viewedLock: Readonly<FinalHtlcObservation> | undefined;
    try {
      viewedLock = view ? final(view, "source-lock", prepared.get("source-lock")) : undefined;
    } catch {
      viewedLock = undefined;
    }
    // A validated final lock always carries its inclusion and expiry.
    if (view && viewedLock?.includedAt !== undefined && viewedLock.expiresAt !== undefined) {
      const viewedCheckpoint = sourceFinalityCheckpointOf(
        viewedLock,
        viewedLock.includedAt,
        viewedLock.expiresAt,
      );
      if (!await persistSourceFinality(viewedCheckpoint)) {
        return { status: "indeterminate", reason: "htlc-source-finality-persistence-uncertain" };
      }
      sourceFinalityCheckpoint = viewedCheckpoint;
      checkpointView = view;
    }
  }
  let sourceRefundFirst: Readonly<{
    attempt: "none" | "sent" | "uncertain";
    latest: Readonly<HtlcLedgerSnapshot>;
    reason: HtlcRefundReason;
  }> | undefined;
  if (sourceFinalityCheckpoint && preimageNeverLeft &&
      readNow() >= secondsToMilliseconds(sourceFinalityCheckpoint.sourceExpiry, "source refund expiry")) {
    const checkpointed = sourceFinalityCheckpoint;
    // The view the checkpoint was just recorded from, when it was.
    const sourceView = checkpointView ?? await observeSource();
    let viewedLock: Readonly<FinalHtlcObservation> | undefined;
    try {
      viewedLock = sourceView ? final(sourceView, "source-lock", prepared.get("source-lock")) : undefined;
    } catch {
      viewedLock = undefined;
    }
    // A source lock the view does not report final as checkpointed is left to
    // the whole-session path, which treats it as regressed or conflicting.
    const viewAgrees = viewedLock !== undefined &&
      sameRef(viewedLock.txRef, checkpointed.sourceLockTxRef) &&
      viewedLock.includedAt === checkpointed.includedAt &&
      viewedLock.expiresAt === checkpointed.sourceExpiry;
    const termsVerdict = viewedLock && viewAgrees
      ? lockTermsVerdict(viewedLock, expectedSourceLockTerms(intent))
      : undefined;
    const reason: HtlcRefundReason = termsVerdict === "missing"
      ? "source-lock-terms-missing"
      : termsVerdict === "mismatch" ? "source-lock-terms-mismatch" : "destination-lock-missing";
    // A refund broadcast here that the source leg cannot then show is still
    // sent: it reads `pending` until observed, as in the whole-session path.
    const sendRefund = async (from: Readonly<HtlcLedgerSnapshot>) => {
      const outcome = { broadcast: false };
      const advanced = await execute(
        "source-refund",
        { sourceExpiry: checkpointed.sourceExpiry },
        observeSource,
        outcome,
      );
      return Object.freeze({
        attempt: advanced || outcome.broadcast ? "sent" as const : "uncertain" as const,
        latest: advanced ?? from,
        reason,
      });
    };
    if (sourceView && viewAgrees) {
      const refund = sourceView.actions["source-refund"];
      sourceRefundFirst = !refund || (refund.state === "absent" && !refundAbsent("source-refund", sourceView))
        ? await sendRefund(sourceView)
        : Object.freeze({ attempt: "none" as const, latest: sourceView, reason });
    } else if (!sourceView && !sourceObservationInvalid && !prepared.has("source-refund")) {
      sourceRefundFirst = await sendRefund(Object.freeze({ observedAt: 0, authenticationHash: "", actions: {} }));
    }
  }

  let snapshot = await observe();
  if (!snapshot && sourceRefundFirst) {
    // The whole session could not be observed, so the destination leg is
    // unknown in this call; the payer's source leg is reported as it stands.
    const destinationTracked = prepared.has("destination-lock");
    return refundProgress(
      destinationTracked ? "destination-lock-unresolved" : sourceRefundFirst.reason,
      sourceRefundFirst.latest,
      destinationTracked
        ? { "destination-refund": "uncertain", "source-refund": sourceRefundFirst.attempt }
        : { "source-refund": sourceRefundFirst.attempt },
      ["source-lock"],
    );
  }
  if (!snapshot) {
    return {
      status: "indeterminate",
      reason: lockObservationInvalid
        ? "htlc-adapter-lock-observation-invalid"
        : "htlc-ledger-observation-unavailable",
    };
  }
  let sourceLock: Extract<HtlcObservedAction, { state: "final" }> | undefined;
  let destinationLock: Extract<HtlcObservedAction, { state: "final" }> | undefined;
  let destinationClaim: Extract<HtlcObservedAction, { state: "final" }> | undefined;
  let sourceClaim: Readonly<FinalSourceClaimObservation> | undefined;
  try {
    sourceLock = final(snapshot, "source-lock", prepared.get("source-lock"));
    destinationLock = final(snapshot, "destination-lock", prepared.get("destination-lock"));
    destinationClaim = final(
      snapshot,
      "destination-claim",
      prepared.get("destination-claim"),
      destinationClaimAttemptHistory,
    );
    sourceClaim = finalSourceClaim(snapshot, prepared.get("source-claim"), sourceClaimAttemptHistory);
  } catch (error) {
    return { status: "failed", errorClass: "permanent", reason: String(error) };
  }

  if (!sourceLock && sourceFinalityCheckpoint) {
    // The source lock was final and checkpointed, so this observation regressed
    // (an adapter fault, or a contract that deleted its record). Nothing moves
    // the source leg on it, but the session stays resumable. Without a retained
    // reveal the preimage is private, so the payee cannot claim the source and
    // the payee's own destination refund after its expiry is still safe. It is
    // sent as on the refund path: prepared only when none is retained, and a
    // retained refund reported `failed`, or `absent` naming it, is never
    // re-sent. Such a refund needs a person here too, so the result is the
    // refund path's `htlc-refund-absent` or `refund-stalled`.
    const destinationLockState = snapshot.actions["destination-lock"];
    const destinationLockMayLand = prepared.has("destination-lock") &&
      destinationLockState?.state !== "failed" && !destinationLockAbsent(snapshot);
    const attempts: Partial<Record<"source-refund" | "destination-refund", "none" | "sent" | "uncertain">> = {
      "source-refund": sourceRefundFirst?.attempt ?? "none",
      ...(destinationLock || destinationLockMayLand || prepared.has("destination-refund")
        ? { "destination-refund": "none" as const }
        : {}),
    };
    let latest = snapshot;
    const destinationExpired = destinationLock?.expiresAt !== undefined &&
      readNow() >= lockExpiryMillis(destinationLock.expiresAt);
    if (destinationLock?.expiresAt !== undefined && destinationExpired && !prepared.has("destination-claim")) {
      const refund = snapshot.actions["destination-refund"];
      if (!refund || (refund.state === "absent" && !refundAbsent("destination-refund", snapshot))) {
        const advanced = await execute("destination-refund", { destinationExpiry: destinationLock.expiresAt });
        if (advanced) latest = advanced;
        attempts["destination-refund"] = advanced ? "sent" : "uncertain";
      }
    }
    // The source lock's own terms cannot be read here, so the reason is the
    // one the destination leg gives on the refund path.
    const refunds = refundProgress(
      prepared.has("destination-claim")
        ? "destination-claim-unlanded"
        : destinationLock?.expiresAt !== undefined
          ? revealForbiddenBy(
            destinationLock,
            destinationLock.expiresAt,
            sourceFinalityCheckpoint.sourceExpiry,
            destinationExpired,
          ) ?? "destination-timeout"
          : destinationLockState?.state === "failed"
            ? "destination-lock-failed"
            : destinationLockMayLand ? "destination-lock-unresolved" : "destination-lock-missing",
      latest,
      attempts,
    );
    return refunds.status === "operator-alert" || refunds.status === "refund-stalled"
      ? refunds
      : { status: "indeterminate", reason: "htlc-source-finality-checkpoint-without-final-lock" };
  }
  if (sourceLock) {
    // Unreachable for a validated snapshot; kept resumable for type safety.
    if (sourceLock.includedAt === undefined || sourceLock.expiresAt === undefined) {
      return { status: "indeterminate", reason: "htlc-adapter-lock-observation-invalid" };
    }
    const observedCheckpoint = sourceFinalityCheckpointOf(sourceLock, sourceLock.includedAt, sourceLock.expiresAt);
    if (sourceFinalityCheckpoint &&
        (sourceFinalityCheckpoint.sourceLockEffectHash !== observedCheckpoint.sourceLockEffectHash ||
          !sameRef(sourceFinalityCheckpoint.sourceLockTxRef, observedCheckpoint.sourceLockTxRef) ||
          sourceFinalityCheckpoint.includedAt !== observedCheckpoint.includedAt ||
          sourceFinalityCheckpoint.sourceExpiry !== observedCheckpoint.sourceExpiry)) {
      // Until a destination lock is prepared nothing has been bound to the
      // checkpoint, which is normally recorded from `observeSourceLeg`, so a
      // whole-session view that disagrees with it is an adapter fault the
      // operator can correct: the session pages but stays resumable, and
      // moves forward only once `observe` reports the checkpointed facts.
      // After that the destination lock is bound to it, so this is final.
      if (!prepared.has("destination-lock")) {
        return { status: "indeterminate", reason: "htlc-source-observers-disagree" };
      }
      return {
        status: "failed",
        errorClass: "permanent",
        reason: "htlc-source-finality-checkpoint-conflict",
      };
    }
    if (!sourceFinalityCheckpoint) {
      if (!await persistSourceFinality(observedCheckpoint)) {
        return { status: "indeterminate", reason: "htlc-source-finality-persistence-uncertain" };
      }
      sourceFinalityCheckpoint = observedCheckpoint;
    }
  }

  // Once the reveal has claimed the destination lock, a contract may delete
  // the lock's record, so a settlement names the retained destination lock.
  const destinationLockRef = destinationLock?.txRef ?? prepared.get("destination-lock")?.txRef;
  if (sourceClaim) {
    // A reveal checkpoint is durable proof of a final reveal of this preimage,
    // so a reveal the adapter has stopped reporting does not undo settlement.
    // Any other report of the reveal contradicts that proof: another attempt
    // final, or a reveal that is `pending`, `failed` or `absent`.
    const revealReported = snapshot.actions["destination-claim"] !== undefined;
    if (retainedCheckpoint && revealReported &&
        !(destinationClaim && sameRef(destinationClaim.txRef, retainedCheckpoint.revealTxRef))) {
      return {
        status: "failed",
        errorClass: "permanent",
        reason: destinationClaim ? "htlc-reveal-checkpoint-conflict" : "htlc-reveal-checkpoint-contradicted",
      };
    }
    const revealTxRef = destinationClaim?.txRef ?? retainedCheckpoint?.revealTxRef;
    if (!sourceLock || !destinationLockRef || !revealTxRef) {
      return { status: "failed", errorClass: "permanent", reason: "htlc-final-claim-chain-incomplete" };
    }
    if (sourceLock.expiresAt === undefined) {
      return { status: "failed", errorClass: "permanent", reason: "htlc-final-claim-chain-invalid" };
    }
    try {
      if (destinationClaim &&
          !revealedPreimageMatches(destinationClaim.revealedPreimageHex, secrets.preimage)) {
        return { status: "failed", errorClass: "permanent", reason: "htlc-revealed-preimage-mismatch" };
      }
    } catch {
      return { status: "failed", errorClass: "permanent", reason: "htlc-revealed-preimage-invalid" };
    }
    const claimDeadline = secondsToMilliseconds(sourceLock.expiresAt, "source claim expiry");
    if (sourceClaim.finalityReachedAt > claimDeadline) {
      return lateSourceClaimExpired(
        sourceClaim.txRef as Extract<HtlcTxRef, { kind: "htlc-claim" }>,
        sourceClaim.finalityReachedAt,
        claimDeadline,
      );
    }
    // Without a retained checkpoint the reveal reference came from a final
    // reveal observation, which is checkpointed first.
    if (destinationClaim && !retainedCheckpoint) {
      const checkpoint: Readonly<HtlcRevealCheckpoint> = Object.freeze({
        revealTxRef: destinationClaim.txRef as Extract<HtlcTxRef, { kind: "htlc-reveal" }>,
        sourceExpiry: sourceLock.expiresAt,
        finalityObservedAt: destinationClaim.finalityObservedAt,
        authenticationHash: destinationClaim.authenticationHash,
      });
      let checkpointed: HtlcStoreWrite;
      try {
        checkpointed = await recordRevealFinal({
          settlementKey: intent.settlementKey,
          bindingHash: intent.bindingHash,
          owner: fence.owner,
          generation: fence.generation,
          checkpoint,
        });
      } catch {
        return { status: "indeterminate", reason: "htlc-reveal-checkpoint-persistence-uncertain" };
      }
      if (checkpointed.status !== "recorded" && checkpointed.status !== "existing") {
        return { status: "indeterminate", reason: "htlc-reveal-checkpoint-persistence-uncertain" };
      }
    }
    const settlement = Object.freeze({
      txRefs: Object.freeze([
        sourceLock.txRef,
        destinationLockRef,
        revealTxRef,
        sourceClaim.txRef,
      ]),
      paymentAmount: Object.freeze({ amount: intent.amount, currency: intent.currency }),
      settlementFinality: Object.freeze({
        model: "htlc-reveal" as const,
        sourceExpiry: sourceLock.expiresAt,
        finalityReachedAt: sourceClaim.finalityReachedAt,
        finalityObservedAt: sourceClaim.finalityObservedAt,
      }),
      authenticationHash: snapshot.authenticationHash,
    });
    let stored: HtlcStoreWrite;
    try {
      stored = await recordSettlement({
        settlementKey: intent.settlementKey,
        bindingHash: intent.bindingHash,
        owner: fence.owner,
        generation: fence.generation,
        settlement,
      });
    } catch {
      return { status: "indeterminate", reason: "htlc-settlement-persistence-uncertain" };
    }
    return stored.status === "recorded" || stored.status === "existing"
      ? { status: "settled", settlement }
      : { status: "indeterminate", reason: "htlc-settlement-persistence-uncertain" };
  }

  let checkpoint = retainedCheckpoint;
  if (destinationClaim) {
    // The reveal is final, so the payer holds the destination funds and the
    // preimage is public: driving the payee's source claim can no longer cost
    // the payer anything, and it is the payee's only way to the source. It
    // needs no final destination-lock observation, because a contract may
    // delete the lock's record once the reveal claims it. The source expiry
    // comes from the retained source-finality checkpoint, which a final source
    // lock observation was compared with above.
    if (!sourceLock || !sourceFinalityCheckpoint || !destinationLockRef) {
      return { status: "indeterminate", reason: "htlc-destination-lock-finality-regressed" };
    }
    const sourceExpiry = sourceFinalityCheckpoint.sourceExpiry;
    try {
      if (!revealedPreimageMatches(destinationClaim.revealedPreimageHex, secrets.preimage)) {
        return { status: "failed", errorClass: "permanent", reason: "htlc-revealed-preimage-mismatch" };
      }
    } catch {
      return { status: "failed", errorClass: "permanent", reason: "htlc-revealed-preimage-invalid" };
    }
    if (checkpoint && (checkpoint.sourceExpiry !== sourceExpiry ||
        !sameRef(checkpoint.revealTxRef, destinationClaim.txRef))) {
      return { status: "failed", errorClass: "permanent", reason: "htlc-reveal-checkpoint-conflict" };
    }
    if (!checkpoint) {
      checkpoint = Object.freeze({
        revealTxRef: destinationClaim.txRef as Extract<HtlcTxRef, { kind: "htlc-reveal" }>,
        sourceExpiry,
        finalityObservedAt: destinationClaim.finalityObservedAt,
        authenticationHash: destinationClaim.authenticationHash,
      });
      let stored: HtlcStoreWrite;
      try {
        stored = await recordRevealFinal({
          settlementKey: intent.settlementKey,
          bindingHash: intent.bindingHash,
          owner: fence.owner,
          generation: fence.generation,
          checkpoint,
        });
      } catch {
        return { status: "indeterminate", reason: "htlc-reveal-checkpoint-persistence-uncertain" };
      }
      if (stored.status !== "recorded" && stored.status !== "existing") {
        return { status: "indeterminate", reason: "htlc-reveal-checkpoint-persistence-uncertain" };
      }
    }
  }

  if (checkpoint) {
    // Recovery progress and alerts name the retained destination lock even
    // when its claimed record is omitted or authenticated absent, and the
    // checkpointed reveal, which is the attempt that landed even when it is an
    // earlier one than the active attempt or the adapter no longer reports it.
    const landedReveal = { "destination-claim": checkpoint.revealTxRef } as const;
    // The reveal is final, so the payer holds the destination funds. Past the
    // source expiry the payee can no longer claim the source, and refunding it
    // would give the payer both legs: the source is never refunded. A source
    // claim that is pending here and later reaches finality in time still
    // settles on a later call; one that can no longer land ends the session.
    if (readNow() >= secondsToMilliseconds(checkpoint.sourceExpiry, "source recovery expiry")) {
      return sourceClaimMissed(snapshot, landedReveal, checkpoint.sourceExpiry);
    }
    const sourceClaimState = snapshot.actions["source-claim"];
    if (!sourceClaimState || sourceClaimState.state === "absent" ||
        sourceClaimState.state === "failed") {
      // A retained claim authenticated `failed`, or `absent` naming it, can
      // never land, so it is replaced; an unreported one is rebroadcast byte
      // for byte. An `absent` that does not name the active claim says
      // nothing about it, so it moves nothing.
      if (unboundAbsentClaim("source-claim", snapshot)) {
        return { status: "indeterminate", reason: "htlc-source-claim-absent-unbound" };
      }
      const unlanded = unlandedActiveClaim("source-claim", snapshot);
      const advanced = unlanded
        ? await replaceFailedSourceClaim(unlanded, checkpoint.sourceExpiry)
        : await execute("source-claim", { sourceExpiry: checkpoint.sourceExpiry });
      if (!advanced) {
        return sourceClaimExpiryReached
          ? sourceClaimMissed(snapshot, landedReveal, checkpoint.sourceExpiry)
          : sourceClaimReplacementLimitReached
            ? operatorAlert(
              "htlc-source-claim-replacement-limit-reached",
              snapshot,
              ["destination-lock"],
              landedReveal,
            )
            : { status: "indeterminate", reason: "htlc-source-claim-effect-uncertain" };
      }
      snapshot = advanced;
      try {
        sourceClaim = finalSourceClaim(snapshot, prepared.get("source-claim"), sourceClaimAttemptHistory);
      } catch (error) {
        return { status: "failed", errorClass: "permanent", reason: String(error) };
      }
      if (sourceClaim && sourceLock && destinationLockRef) {
        const claimDeadline = secondsToMilliseconds(checkpoint.sourceExpiry, "source recovery expiry");
        if (sourceClaim.finalityReachedAt > claimDeadline) {
          return lateSourceClaimExpired(
            sourceClaim.txRef as Extract<HtlcTxRef, { kind: "htlc-claim" }>,
            sourceClaim.finalityReachedAt,
            claimDeadline,
          );
        }
        const settlement = Object.freeze({
          txRefs: Object.freeze([sourceLock.txRef, destinationLockRef, checkpoint.revealTxRef, sourceClaim.txRef]),
          paymentAmount: Object.freeze({ amount: intent.amount, currency: intent.currency }),
          settlementFinality: Object.freeze({
            model: "htlc-reveal" as const,
            sourceExpiry: checkpoint.sourceExpiry,
            finalityReachedAt: sourceClaim.finalityReachedAt,
            finalityObservedAt: sourceClaim.finalityObservedAt,
          }),
          authenticationHash: snapshot.authenticationHash,
        });
        let stored: HtlcStoreWrite;
        try {
          stored = await recordSettlement({
            settlementKey: intent.settlementKey,
            bindingHash: intent.bindingHash,
            owner: fence.owner,
            generation: fence.generation,
            settlement,
          });
        } catch {
          return { status: "indeterminate", reason: "htlc-settlement-persistence-uncertain" };
        }
        return stored.status === "recorded" || stored.status === "existing"
          ? { status: "settled", settlement }
          : { status: "indeterminate", reason: "htlc-settlement-persistence-uncertain" };
      }
    }
    return {
      status: "settle-asymmetric",
      reason: "dest-revealed-source-unclaimed",
      recoveryDeadline: secondsToMilliseconds(checkpoint.sourceExpiry, "source recovery expiry"),
      txRefs: collectRefs(snapshot, prepared, [], ["destination-lock"], landedReveal),
      finalityObservedAt: checkpoint.finalityObservedAt,
    };
  }

  if (!sourceLock) {
    const state = snapshot.actions["source-lock"];
    if (state?.state === "failed") {
      return { status: "failed", errorClass: "permanent", reason: state.reason ?? "htlc-source-lock-failed" };
    }
    // A retained source lock reported `absent` naming it can never land and
    // locked nothing, so as for a failed one nothing is left to drive and its
    // dead bytes are not re-sent. An `absent` naming nothing is only nothing on
    // chain yet: the retained bytes are rebroadcast below.
    const retainedSourceLock = prepared.get("source-lock");
    if (state?.state === "absent" && retainedSourceLock && state.txRef !== undefined &&
        sameRef(state.txRef, retainedSourceLock.txRef)) {
      return { status: "failed", errorClass: "permanent", reason: "htlc-source-lock-absent" };
    }
    if (!state || state.state === "absent") {
      const advanced = await execute("source-lock");
      return advanced
        ? { status: "waiting", reason: "htlc-source-lock-finality-pending" }
        : { status: "indeterminate", reason: "htlc-source-lock-effect-uncertain" };
    }
    return { status: "waiting", reason: "htlc-source-lock-finality-pending" };
  }
  if (sourceLock.expiresAt === undefined) {
    return { status: "indeterminate", reason: "htlc-adapter-lock-observation-invalid" };
  }
  if (!sourceFinalityCheckpoint) {
    return { status: "indeterminate", reason: "htlc-source-finality-persistence-uncertain" };
  }

  if (!destinationLock) {
    // A reveal is only ever prepared against a final destination lock, so a
    // retained reveal means this observation regressed. The reveal may still
    // land, so nothing is refunded, prepared or broadcast until it recovers.
    if (prepared.has("destination-claim")) {
      return { status: "indeterminate", reason: "htlc-destination-lock-finality-regressed" };
    }
    const state = snapshot.actions["destination-lock"];
    // The payee locks the destination only against the source lock's
    // authenticated terms. Missing or different terms forbid the lock; the
    // payer's source leg is then refunded at its expiry, and the terms stay
    // the reason that the session refunds.
    const sourceTermsVerdict = lockTermsVerdict(sourceLock, expectedSourceLockTerms(intent));
    // A retained destination lock that is not authenticated `failed`, or
    // `absent` naming it, may still land, so it stays an owed leg: its
    // reference and its refund are reported and the session is never
    // `refunded` before it resolves. Once final it takes the final-lock path
    // and is refunded there.
    const destinationLockMayLand = prepared.has("destination-lock") &&
      state?.state !== "failed" && !destinationLockAbsent(snapshot);
    // The payer's source leg stays locked until its own refund is final, so
    // nothing on this path is terminal: a failed or impossible destination
    // lock is refund-pending until the source refund lands.
    const refundReason: HtlcRefundReason = sourceTermsVerdict === "missing"
      ? "source-lock-terms-missing"
      : sourceTermsVerdict === "mismatch"
        ? "source-lock-terms-mismatch"
        : state?.state === "failed"
          ? "destination-lock-failed"
          : destinationLockMayLand ? "destination-lock-unresolved" : "destination-lock-missing";
    const refundLegs = (
      sourceRefund: "none" | "sent" | "uncertain",
    ): Partial<Record<"source-refund" | "destination-refund", "none" | "sent" | "uncertain">> =>
      destinationLockMayLand
        ? { "destination-refund": "none", "source-refund": sourceRefund }
        : { "source-refund": sourceRefund };
    // A source refund already driven in this call is never driven again in it.
    if (sourceRefundFirst) return refundProgress(refundReason, snapshot, refundLegs(sourceRefundFirst.attempt));
    if (readNow() >= secondsToMilliseconds(sourceLock.expiresAt, "source refund expiry")) {
      const refund = snapshot.actions["source-refund"];
      if (!refund || (refund.state === "absent" && !refundAbsent("source-refund", snapshot))) {
        const advanced = await execute("source-refund", { sourceExpiry: sourceLock.expiresAt });
        return refundProgress(refundReason, advanced ?? snapshot, refundLegs(advanced ? "sent" : "uncertain"));
      }
      return refundProgress(refundReason, snapshot, refundLegs("none"));
    }
    // A dead destination lock leaves only the source refund at its expiry, and
    // its bytes are never rebroadcast.
    if (state?.state === "failed" || destinationLockAbsent(snapshot)) {
      return refundProgress(refundReason, snapshot, refundLegs("none"));
    }
    const sourceTermsForbidden = sourceTermsVerdict === undefined
      ? undefined
      : refundProgress(refundReason, snapshot, refundLegs("none"));
    if (prepared.has("destination-lock")) {
      // Unreported, or `absent` naming nothing: the retained lock may still
      // land, so its exact bytes are rebroadcast.
      if (!state || state.state === "absent") {
        if (sourceTermsForbidden) return sourceTermsForbidden;
        const advanced = await execute("destination-lock", {
          sourceExpiry: sourceLock.expiresAt,
          sourceFinalityCheckpoint,
        });
        return advanced
          ? { status: "waiting", reason: "htlc-destination-lock-finality-pending" }
          : { status: "indeterminate", reason: "htlc-destination-lock-effect-uncertain" };
      }
      return { status: "waiting", reason: "htlc-destination-lock-finality-pending" };
    }
    const destinationExpiry = safeAdd(
      Math.floor(snapshot.observedAt / 1_000),
      intent.destinationTimelockSec,
      "destination lock expiry",
    );
    const sourceRecoveryBudgetSec = safeAdd(
      intent.sourceFinalitySec,
      intent.safetyWindowSec,
      "source finality and safety budget",
    );
    if (sourceTermsForbidden) return sourceTermsForbidden;
    if (sourceLock.expiresAt <= safeAdd(
      destinationExpiry,
      sourceRecoveryBudgetSec,
      "absolute expiry margin",
    )) {
      return refundProgress("destination-lock-window-closed", snapshot, { "source-refund": "none" });
    }
    if (!state || state.state === "absent") {
      const advanced = await execute("destination-lock", {
        sourceExpiry: sourceLock.expiresAt,
        destinationExpiry,
        sourceFinalityCheckpoint,
      });
      return advanced
        ? { status: "waiting", reason: "htlc-destination-lock-finality-pending" }
        : { status: "indeterminate", reason: "htlc-destination-lock-effect-uncertain" };
    }
    return { status: "waiting", reason: "htlc-destination-lock-finality-pending" };
  }
  // Unreachable for a validated snapshot; kept resumable for type safety.
  if (destinationLock.expiresAt === undefined || destinationLock.includedAt === undefined) {
    return { status: "indeterminate", reason: "htlc-adapter-lock-observation-invalid" };
  }
  const sourceExpired = sourceRefundFirst !== undefined ||
    readNow() >= secondsToMilliseconds(sourceLock.expiresAt, "source refund expiry");
  // An expiry beyond the safe-integer range never arrives for the core.
  const destinationExpired = readNow() >= lockExpiryMillis(destinationLock.expiresAt);
  const revealForbidden = revealForbiddenBy(
    destinationLock,
    destinationLock.expiresAt,
    sourceLock.expiresAt,
    destinationExpired,
  );

  if (revealForbidden !== undefined || destinationExpired) {
    let refundReason: HtlcRefundReason = revealForbidden ?? "destination-timeout";
    if (prepared.has("destination-claim")) {
      // A retained reveal may have exposed the preimage, so it blocks refunds
      // until the payee's source-claim window has closed and the adapter
      // authenticates that the claim did not land. A pending claim may still,
      // and a claim the adapter does not report at all is not authenticated.
      // A failed observation of a replaced reveal, or an `absent` that does not
      // name the active one, says nothing about the active reveal, so only the
      // active reveal can be authenticated unlanded.
      const pendingClaim = snapshot.actions["destination-claim"];
      const unlanded = unlandedActiveClaim("destination-claim", snapshot);
      if (!unlanded || !sourceExpired || !destinationExpired) {
        // A reveal that failed on chain or is authenticated absent has
        // broadcast the preimage. Here the claim window has closed or the
        // margin is gone, so no replacement is allowed: the payee may still
        // claim the source while the payer cannot claim the destination, and
        // a person must act.
        if (pendingClaim?.state !== "pending" &&
            (unlanded || destinationClaimAttemptHistory.length > 0)) {
          return operatorAlert(
            revealExposedReason(unlanded?.state === "failed"),
            snapshot,
            pendingClaim?.state === "absent" ? ["destination-claim"] : [],
          );
        }
        // Past the claim cutoff nothing more is sent for this reveal, but it
        // may still land, so it waits with a reason a host pages on: before
        // the destination expiry a person can still help it land.
        return {
          status: "waiting",
          reason: sourceExpired && destinationExpired
            ? "htlc-destination-claim-unresolved-after-expiry"
            : "htlc-destination-claim-unresolved-after-cutoff",
        };
      }
      refundReason = "destination-claim-unlanded";
    }
    const destinationRefund = snapshot.actions["destination-refund"];
    const sourceRefund = snapshot.actions["source-refund"];
    let latest = snapshot;
    const attempts: Record<"source-refund" | "destination-refund", "none" | "sent" | "uncertain"> = {
      "destination-refund": "none",
      "source-refund": "none",
    };
    // The payer's source refund never waits on the payee's destination refund:
    // it was normally driven before the session was observed, and otherwise
    // is driven here first, so a payee role service that fails, answers after
    // the lease or never answers cannot delay or skip it. Only the destination
    // leg then reads `uncertain`.
    if (sourceRefundFirst) {
      attempts["source-refund"] = sourceRefundFirst.attempt;
    } else if (sourceExpired && (!sourceRefund ||
        (sourceRefund.state === "absent" && !refundAbsent("source-refund", snapshot)))) {
      const advanced = await execute("source-refund", { sourceExpiry: sourceLock.expiresAt });
      if (advanced) latest = advanced;
      attempts["source-refund"] = advanced ? "sent" : "uncertain";
    }
    if (destinationExpired && (!destinationRefund ||
        (destinationRefund.state === "absent" && !refundAbsent("destination-refund", snapshot)))) {
      const advanced = await execute("destination-refund", { destinationExpiry: destinationLock.expiresAt });
      if (advanced) latest = advanced;
      attempts["destination-refund"] = advanced ? "sent" : "uncertain";
    }
    return refundProgress(refundReason, latest, attempts);
  }

  const claimState = snapshot.actions["destination-claim"];
  const activeClaim = prepared.get("destination-claim");
  const expiries = {
    sourceExpiry: sourceLock.expiresAt,
    destinationExpiry: destinationLock.expiresAt,
  };
  // The payer's decision gates only the first reveal. Once a reveal is
  // retained the preimage may be public, and holding back its rebroadcast or
  // replacement could only cost the payer the destination leg. A retained
  // reveal authenticated `failed` or `absent` can never land, so rebroadcasting
  // its bytes cannot help: it is replaced. A replacement this call could not
  // make has its own reason, so that a host can tell a preimage that is out
  // while no reveal can land from a first reveal's broadcast hiccup.
  const unlandedReveal = unlandedActiveClaim("destination-claim", snapshot);
  if (unlandedReveal) {
    const advanced = await replaceFailedDestinationClaim(unlandedReveal, expiries);
    return advanced
      ? { status: "waiting", reason: "htlc-destination-claim-finality-pending" }
      : destinationClaimReplacementBlocked
        ? operatorAlert(
          revealExposedReason(unlandedReveal.state === "failed"),
          snapshot,
          unlandedReveal.state === "absent" ? ["destination-claim"] : [],
        )
        : { status: "indeterminate", reason: "htlc-destination-claim-replacement-uncertain" };
  }
  if (!activeClaim && !authorizeDestinationClaim) {
    return { status: "waiting", reason: "htlc-destination-claim-not-authorized" };
  }
  // A retained reveal that is neither final nor authenticated unlanded may
  // still land, and its preimage may be in a mempool. Past the claim cutoff
  // nothing more is sent for it, so a host pages while a person can still
  // help it land before the destination expiry.
  const unresolvedAfterCutoff = (): CrossChainHtlcProgress =>
    claimState?.state !== "pending" && destinationClaimAttemptHistory.length > 0
      ? operatorAlert(
        revealExposedReason(false),
        snapshot,
        claimState?.state === "absent" ? ["destination-claim"] : [],
      )
      : { status: "waiting", reason: "htlc-destination-claim-unresolved-after-cutoff" };
  // An `absent` that does not name the active reveal says nothing about it.
  if (unboundAbsentClaim("destination-claim", snapshot)) {
    return destinationClaimWindowIsOpen(expiries)
      ? { status: "indeterminate", reason: "htlc-destination-claim-absent-unbound" }
      : unresolvedAfterCutoff();
  }
  // Unreported, absent before any reveal, or only a replaced reveal is
  // reported failed: send the active reveal, rebroadcasting its exact retained
  // bytes when it exists.
  if (!claimState || claimState.state === "absent" || claimState.state === "failed") {
    const advanced = await execute("destination-claim", expiries);
    return advanced
      ? { status: "waiting", reason: "htlc-destination-claim-finality-pending" }
      : destinationClaimCutoffReached
        ? activeClaim
          ? unresolvedAfterCutoff()
          : { status: "waiting", reason: "htlc-destination-claim-cutoff-reached" }
        : { status: "indeterminate", reason: "htlc-destination-claim-effect-uncertain" };
  }
  // The active reveal is pending.
  return destinationClaimWindowIsOpen(expiries)
    ? { status: "waiting", reason: "htlc-destination-claim-finality-pending" }
    : unresolvedAfterCutoff();
}

interface MemoryHtlcRecord {
  intent: Readonly<CrossChainHtlcIntent>;
  secrets: Readonly<CrossChainHtlcSecrets>;
  lease: HtlcLease;
  prepared: Map<HtlcAction, Readonly<HtlcPreparedAction>>;
  sourceClaimAttemptHistory: readonly Readonly<HtlcSourceClaimAttemptHistoryEntry>[];
  destinationClaimAttemptHistory: readonly Readonly<HtlcDestinationClaimAttemptHistoryEntry>[];
  sourceFinalityCheckpoint?: Readonly<HtlcSourceFinalityCheckpoint>;
  revealCheckpoint?: Readonly<HtlcRevealCheckpoint>;
  settlement?: Readonly<CrossChainHtlcSettlement>;
}

/**
 * Test/development store. It loses every secret, signed action and checkpoint
 * on restart, after which the core would prepare a second source lock and
 * double-send, so callers must acknowledge that explicitly. The core is
 * restart-safe only over an encrypted, durable and atomic host store.
 */
export function createInMemoryCrossChainHtlcStore(
  options: Readonly<{ acknowledgeVolatile: true }>,
): CrossChainHtlcStore {
  if (options?.acknowledgeVolatile !== true) {
    throw new TypeError(
      "pay-cross-chain-htlc: the in-memory HTLC store loses all state on restart, which would " +
        "double-send; pass { acknowledgeVolatile: true } only in tests and development",
    );
  }
  const records = new Map<string, MemoryHtlcRecord>();
  const saltOwners = new Map<string, string>();
  const effects = new Map<string, string>();
  const transactionOwners = new Map<string, string>();
  const current = (
    record: MemoryHtlcRecord | undefined,
    input: { bindingHash: string; owner: string; generation: number },
  ): record is MemoryHtlcRecord => record !== undefined &&
    record.intent.bindingHash === input.bindingHash && record.lease.owner === input.owner &&
    record.lease.generation === input.generation;
  return {
    async claim(input) {
      const existing = records.get(input.intent.settlementKey);
      if (existing) {
        if (existing.intent.bindingHash !== input.intent.bindingHash ||
            existing.secrets.buyerSaltHash !== input.secrets.buyerSaltHash ||
            existing.secrets.preimageHash !== input.secrets.preimageHash) {
          return { status: "conflict", reason: "htlc-settlement-binding-or-secret-conflict" };
        }
        if (existing.settlement) {
          return {
            status: "settled",
            intent: existing.intent,
            settlement: existing.settlement,
            prepared: [...existing.prepared.values()],
            sourceClaimAttemptHistory: existing.sourceClaimAttemptHistory,
            destinationClaimAttemptHistory: existing.destinationClaimAttemptHistory,
            sourceFinalityCheckpoint: existing.sourceFinalityCheckpoint,
            revealCheckpoint: existing.revealCheckpoint,
          };
        }
        if (existing.lease.expiresAt > input.now) {
          return {
            status: "waiting",
            intent: existing.intent,
            lease: { ...existing.lease },
            prepared: [...existing.prepared.values()],
            sourceClaimAttemptHistory: existing.sourceClaimAttemptHistory,
            destinationClaimAttemptHistory: existing.destinationClaimAttemptHistory,
            sourceFinalityCheckpoint: existing.sourceFinalityCheckpoint,
            revealCheckpoint: existing.revealCheckpoint,
          };
        }
        existing.lease = {
          owner: input.owner,
          generation: existing.lease.generation + 1,
          expiresAt: input.now + input.leaseDurationMs,
        };
        return {
          status: "acquired",
          intent: existing.intent,
          lease: { ...existing.lease },
          prepared: [...existing.prepared.values()],
          sourceClaimAttemptHistory: existing.sourceClaimAttemptHistory,
          destinationClaimAttemptHistory: existing.destinationClaimAttemptHistory,
          sourceFinalityCheckpoint: existing.sourceFinalityCheckpoint,
          revealCheckpoint: existing.revealCheckpoint,
        };
      }
      const saltOwner = saltOwners.get(input.secrets.buyerSaltHash);
      if (saltOwner && saltOwner !== input.intent.settlementKey) {
        return { status: "conflict", reason: "htlc-buyer-salt-cross-session-reuse" };
      }
      const record: MemoryHtlcRecord = {
        intent: input.intent,
        secrets: Object.freeze({
          ...input.secrets,
          buyerSalt: secretCopy(input.secrets.buyerSalt),
          preimage: secretCopy(input.secrets.preimage),
        }),
        lease: { owner: input.owner, generation: 1, expiresAt: input.now + input.leaseDurationMs },
        prepared: new Map(),
        sourceClaimAttemptHistory: Object.freeze([]),
        destinationClaimAttemptHistory: Object.freeze([]),
      };
      records.set(input.intent.settlementKey, record);
      saltOwners.set(input.secrets.buyerSaltHash, input.intent.settlementKey);
      return {
        status: "acquired",
        intent: record.intent,
        lease: { ...record.lease },
        prepared: [],
        sourceClaimAttemptHistory: Object.freeze([]),
        destinationClaimAttemptHistory: Object.freeze([]),
      };
    },
    async isCurrent(input) {
      const record = records.get(input.settlementKey);
      return current(record, input) && record.lease.expiresAt > input.now && !record.settlement;
    },
    async recordPrepared(input) {
      const record = records.get(input.settlementKey);
      if (!current(record, input)) return { status: "stale", reason: "stale-lease" };
      if (record.revealCheckpoint && input.prepared.action === "source-refund") {
        return { status: "conflict", reason: "htlc-source-refund-blocked-after-reveal" };
      }
      if (input.prepared.action === "destination-lock" &&
          (!record.sourceFinalityCheckpoint || input.prepared.sourceFinalityCheckpointHash !==
            crossChainHtlcSourceFinalityCheckpointHash(record.sourceFinalityCheckpoint))) {
        return { status: "conflict", reason: "htlc-destination-lock-without-source-finality" };
      }
      if (input.prepared.action !== "destination-lock" &&
          input.prepared.sourceFinalityCheckpointHash !== undefined) {
        return { status: "corrupt", reason: "htlc-source-finality-binding-on-wrong-action" };
      }
      const owner = effects.get(input.prepared.effectHash);
      if (owner && owner !== input.settlementKey) {
        return { status: "conflict", reason: "htlc-effect-cross-settlement-reuse" };
      }
      const transactionKey = canonicalize(input.prepared.txRef);
      const transactionOwner = transactionOwners.get(transactionKey);
      if (transactionOwner && transactionOwner !== input.settlementKey) {
        return { status: "conflict", reason: "htlc-transaction-cross-settlement-reuse" };
      }
      const prior = record.prepared.get(input.prepared.action);
      if (prior) {
        return prior.effectHash === input.prepared.effectHash
          ? { status: "existing" }
          : { status: "conflict", reason: "htlc-action-replacement-forbidden" };
      }
      record.prepared.set(input.prepared.action, Object.freeze({
        ...input.prepared,
        txRef: Object.freeze({ ...input.prepared.txRef }),
      }));
      effects.set(input.prepared.effectHash, input.settlementKey);
      transactionOwners.set(transactionKey, input.settlementKey);
      return { status: "recorded" };
    },
    async recordSourceFinality(input) {
      const record = records.get(input.settlementKey);
      if (!current(record, input)) return { status: "stale", reason: "stale-lease" };
      const sourceLock = record.prepared.get("source-lock");
      let checkpoint: Readonly<HtlcSourceFinalityCheckpoint>;
      try {
        checkpoint = captureSourceFinalityCheckpoint(input.checkpoint, sourceLock);
      } catch {
        return { status: "corrupt", reason: "htlc-source-finality-checkpoint-invalid" };
      }
      if (record.sourceFinalityCheckpoint) {
        return canonicalize(record.sourceFinalityCheckpoint) === canonicalize(checkpoint)
          ? { status: "existing" }
          : { status: "conflict", reason: "htlc-source-finality-checkpoint-conflict" };
      }
      record.sourceFinalityCheckpoint = checkpoint;
      return { status: "recorded" };
    },
    async replacePreparedSourceClaim(input) {
      const record = records.get(input.settlementKey);
      if (!current(record, input) || !Number.isSafeInteger(input.now) ||
          input.now < 0 || record.lease.expiresAt <= input.now) {
        return { status: "stale", reason: "stale-lease" };
      }
      if (!record.revealCheckpoint) {
        return { status: "conflict", reason: "htlc-source-claim-replacement-without-reveal" };
      }
      let sourceExpiryMillis: number;
      try {
        sourceExpiryMillis = secondsToMilliseconds(
          record.revealCheckpoint.sourceExpiry,
          "source claim replacement expiry",
        );
      } catch {
        return { status: "corrupt", reason: "htlc-source-claim-replacement-expiry-corrupt" };
      }
      if (input.now >= sourceExpiryMillis) {
        return { status: "conflict", reason: "htlc-source-claim-replacement-expired" };
      }
      const prior = record.prepared.get("source-claim");
      if (!prior || prior.effectHash !== input.priorEffectHash ||
          !sameRef(prior.txRef, input.priorTxRef)) {
        return { status: "conflict", reason: "htlc-source-claim-replacement-prior-mismatch" };
      }
      if (record.sourceClaimAttemptHistory.length >= MAX_SOURCE_CLAIM_REPLACEMENTS) {
        return { status: "conflict", reason: "htlc-source-claim-replacement-limit" };
      }
      let failedObservation: Readonly<HtlcFailedObservation>;
      let replacement: Readonly<HtlcPreparedAction>;
      try {
        captureClaimAttemptHistory(
          record.sourceClaimAttemptHistory,
          record.prepared,
          record.intent,
          "source-claim",
        );
        failedObservation = captureFailedObservation(input.failedObservation, prior);
        const { effectHash, ...unsigned } = input.replacement;
        replacement = validatePrepared(unsigned, record.intent, "source-claim");
        if (replacement.effectHash !== effectHash) {
          return { status: "corrupt", reason: "htlc-source-claim-replacement-integrity-mismatch" };
        }
      } catch {
        return { status: "corrupt", reason: "htlc-source-claim-replacement-invalid" };
      }
      if (replacement.effectHash === prior.effectHash || sameRef(replacement.txRef, prior.txRef)) {
        return { status: "conflict", reason: "htlc-source-claim-replacement-not-fresh" };
      }
      const allPriorAttempts = record.sourceClaimAttemptHistory.map((entry) => entry.prepared);
      if (allPriorAttempts.some((attempt) => attempt.effectHash === replacement.effectHash ||
          sameRef(attempt.txRef, replacement.txRef))) {
        return { status: "conflict", reason: "htlc-source-claim-replacement-reuses-history" };
      }
      const effectOwner = effects.get(replacement.effectHash);
      if (effectOwner) {
        return { status: "conflict", reason: effectOwner === input.settlementKey
          ? "htlc-source-claim-replacement-reuses-effect"
          : "htlc-effect-cross-settlement-reuse" };
      }
      const transactionKey = canonicalize(replacement.txRef);
      const transactionOwner = transactionOwners.get(transactionKey);
      if (transactionOwner) {
        return { status: "conflict", reason: transactionOwner === input.settlementKey
          ? "htlc-source-claim-replacement-reuses-transaction"
          : "htlc-transaction-cross-settlement-reuse" };
      }
      const historyEntry = Object.freeze({
        attempt: record.sourceClaimAttemptHistory.length + 1,
        prepared: prior,
        failedObservation,
        replacementEffectHash: replacement.effectHash,
      });
      record.sourceClaimAttemptHistory = Object.freeze([
        ...record.sourceClaimAttemptHistory,
        historyEntry,
      ]);
      record.prepared.set("source-claim", replacement);
      effects.set(replacement.effectHash, input.settlementKey);
      transactionOwners.set(transactionKey, input.settlementKey);
      return { status: "recorded" };
    },
    async replacePreparedDestinationClaim(input) {
      const record = records.get(input.settlementKey);
      if (!current(record, input) || !Number.isSafeInteger(input.now) ||
          input.now < 0 || record.lease.expiresAt <= input.now) {
        return { status: "stale", reason: "stale-lease" };
      }
      if (record.revealCheckpoint) {
        return { status: "conflict", reason: "htlc-destination-claim-replacement-after-reveal" };
      }
      if (record.prepared.has("source-refund") || record.prepared.has("destination-refund")) {
        return { status: "conflict", reason: "htlc-destination-claim-replacement-after-refund" };
      }
      if (!record.sourceFinalityCheckpoint) {
        return { status: "conflict", reason: "htlc-destination-claim-replacement-without-source-finality" };
      }
      // The core also enforces the destination-claim cutoff; the store bounds
      // a replacement by the source-recovery cutoff it can compute itself.
      let sourceCutoffMillis: number;
      try {
        sourceCutoffMillis = finalityCutoffMillis(
          record.sourceFinalityCheckpoint.sourceExpiry,
          safeAdd(
            record.intent.sourceFinalitySec,
            record.intent.safetyWindowSec,
            "source finality and safety budget",
          ),
          "destination claim replacement",
        );
      } catch {
        return { status: "corrupt", reason: "htlc-destination-claim-replacement-expiry-corrupt" };
      }
      if (input.now >= sourceCutoffMillis) {
        return { status: "conflict", reason: "htlc-destination-claim-replacement-expired" };
      }
      const prior = record.prepared.get("destination-claim");
      if (!prior || prior.effectHash !== input.priorEffectHash ||
          !sameRef(prior.txRef, input.priorTxRef)) {
        return { status: "conflict", reason: "htlc-destination-claim-replacement-prior-mismatch" };
      }
      if (record.destinationClaimAttemptHistory.length >= MAX_DESTINATION_CLAIM_REPLACEMENTS) {
        return { status: "conflict", reason: "htlc-destination-claim-replacement-limit" };
      }
      let failedObservation: Readonly<HtlcFailedObservation>;
      let replacement: Readonly<HtlcPreparedAction>;
      try {
        captureClaimAttemptHistory(
          record.destinationClaimAttemptHistory,
          record.prepared,
          record.intent,
          "destination-claim",
        );
        failedObservation = captureFailedObservation(input.failedObservation, prior);
        const { effectHash, ...unsigned } = input.replacement;
        replacement = validatePrepared(unsigned, record.intent, "destination-claim");
        if (replacement.effectHash !== effectHash) {
          return { status: "corrupt", reason: "htlc-destination-claim-replacement-integrity-mismatch" };
        }
      } catch {
        return { status: "corrupt", reason: "htlc-destination-claim-replacement-invalid" };
      }
      if (replacement.effectHash === prior.effectHash || sameRef(replacement.txRef, prior.txRef)) {
        return { status: "conflict", reason: "htlc-destination-claim-replacement-not-fresh" };
      }
      const allPriorAttempts = record.destinationClaimAttemptHistory.map((entry) => entry.prepared);
      if (allPriorAttempts.some((attempt) => attempt.effectHash === replacement.effectHash ||
          sameRef(attempt.txRef, replacement.txRef))) {
        return { status: "conflict", reason: "htlc-destination-claim-replacement-reuses-history" };
      }
      const effectOwner = effects.get(replacement.effectHash);
      if (effectOwner) {
        return { status: "conflict", reason: effectOwner === input.settlementKey
          ? "htlc-destination-claim-replacement-reuses-effect"
          : "htlc-effect-cross-settlement-reuse" };
      }
      const transactionKey = canonicalize(replacement.txRef);
      const transactionOwner = transactionOwners.get(transactionKey);
      if (transactionOwner) {
        return { status: "conflict", reason: transactionOwner === input.settlementKey
          ? "htlc-destination-claim-replacement-reuses-transaction"
          : "htlc-transaction-cross-settlement-reuse" };
      }
      record.destinationClaimAttemptHistory = Object.freeze([
        ...record.destinationClaimAttemptHistory,
        Object.freeze({
          attempt: record.destinationClaimAttemptHistory.length + 1,
          prepared: prior,
          failedObservation,
          replacementEffectHash: replacement.effectHash,
        }),
      ]);
      record.prepared.set("destination-claim", replacement);
      effects.set(replacement.effectHash, input.settlementKey);
      transactionOwners.set(transactionKey, input.settlementKey);
      return { status: "recorded" };
    },
    async recordRevealFinal(input) {
      const record = records.get(input.settlementKey);
      if (!current(record, input)) return { status: "stale", reason: "stale-lease" };
      if (!HASH_RE.test(input.checkpoint.authenticationHash)) {
        return { status: "corrupt", reason: "htlc-reveal-checkpoint-unauthenticated" };
      }
      if (record.revealCheckpoint) {
        return canonicalize(record.revealCheckpoint) === canonicalize(input.checkpoint)
          ? { status: "existing" }
          : { status: "conflict", reason: "htlc-reveal-checkpoint-conflict" };
      }
      record.revealCheckpoint = Object.freeze({
        ...input.checkpoint,
        revealTxRef: Object.freeze({ ...input.checkpoint.revealTxRef }),
      });
      return { status: "recorded" };
    },
    async recordSettlement(input) {
      const record = records.get(input.settlementKey);
      if (!current(record, input)) return { status: "stale", reason: "stale-lease" };
      if (!record.revealCheckpoint) {
        return { status: "conflict", reason: "htlc-settlement-without-reveal-checkpoint" };
      }
      if (input.settlement.settlementFinality.sourceExpiry !==
          record.revealCheckpoint.sourceExpiry) {
        return { status: "conflict", reason: "htlc-settlement-source-expiry-mismatch" };
      }
      if (!storedSettlementMatchesIntent(input.settlement, record.intent)) {
        return { status: "corrupt", reason: "htlc-settlement-invalid" };
      }
      if (record.settlement) {
        return canonicalize(record.settlement) === canonicalize(input.settlement)
          ? { status: "existing" }
          : { status: "conflict", reason: "htlc-settlement-conflict" };
      }
      record.settlement = Object.freeze({ ...input.settlement });
      return { status: "recorded" };
    },
  };
}

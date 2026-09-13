import { randomUUID } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { canonicalize, sha256Hex } from "../canonical/index.js";
import { snapshotCanonicalJsonRead } from "../canonical/snapshot.js";
import { DacsError } from "../errors.js";
import type { SettlementEffectFence } from "./idempotency.js";

/** Durable schema written by wallet-spend stores. */
export const WALLET_SPEND_STATE_VERSION = 1 as const;

export type WalletSpendDebitPurpose = "service" | "network-fee";

export interface WalletSpendAssetPolicyV1 {
  asset: string;
  maximumPerOrderDebit: string;
  maximumNetworkFeeDebit: string;
  minimumReserve: string;
  rollingWindowMs: number;
  maximumRollingEffects: number;
  maximumRollingDebit: string;
  maximumCumulativeDebit: string;
  maximumCounterpartyDebit: string;
  /** A reservation at or above this amount needs authenticated operator approval. */
  operatorApprovalThreshold?: string;
}

/**
 * One immutable operator policy for one wallet on one authenticated chain.
 * Amounts are canonical non-negative integer base-unit strings.
 */
export interface WalletSpendPolicyV1 {
  policyVersion: "1";
  policyId: string;
  wallet: string;
  chainId: string;
  maximumConcurrentEffects: number;
  maximumRetainedReservations: number;
  assets: readonly WalletSpendAssetPolicyV1[];
}

export interface WalletSpendDebitReservationV1 {
  asset: string;
  purpose: WalletSpendDebitPurpose;
  /** Expected debit used for operator visibility and fee-change detection. */
  expectedAmount: string;
  /** Hard ceiling; service debits require expectedAmount === maximumAmount. */
  maximumAmount: string;
}

/** Complete immutable authority for one possible funded effect. */
export interface WalletSpendReservationV1 {
  reservationVersion: "1";
  reservationId: string;
  jobId: string;
  phaseIndex: number;
  phase: string;
  agreementHash: string;
  /** Hash of the exact generation-fenced SettlementBinding. */
  settlementBindingHash: string;
  railId: string;
  railDefinitionHash: string;
  wallet: string;
  chainId: string;
  payee: string;
  finality: Readonly<{ model: string; finalityBlocks?: number }>;
  debits: readonly WalletSpendDebitReservationV1[];
}

export interface WalletSpendActualDebitV1 {
  asset: string;
  purpose: WalletSpendDebitPurpose;
  amount: string;
}

export interface WalletSpendSettlementObservationV1 {
  disposition: "settled";
  evidenceHash: string;
  debits: readonly WalletSpendActualDebitV1[];
}

export interface WalletSpendAbsenceObservationV1 {
  disposition: "not-invoked" | "terminal-absent";
  evidenceHash: string;
}

export type WalletSpendRecoveryObservationV1 =
  | WalletSpendSettlementObservationV1
  | WalletSpendAbsenceObservationV1;

export interface WalletSpendLeaseTokenV1 {
  owner: string;
  generation: number;
}

export interface WalletSpendStoredReservationV1 {
  reservationId: string;
  bindingHash: string;
  reservation: Readonly<WalletSpendReservationV1>;
  stage: "reserved" | "effect-pending" | "settled" | "released";
  generation: number;
  owner?: string;
  leaseExpiresAt?: number;
  approvalHash?: string;
  evidenceHash?: string;
  actualDebits?: readonly WalletSpendActualDebitV1[];
  createdAt: number;
  updatedAt: number;
}

export interface WalletSpendAssetTotalsV1 {
  asset: string;
  cumulativeDebit: string;
  counterpartyDebits: Readonly<Record<string, string>>;
}

export interface WalletSpendEventV1 {
  reservationId: string;
  asset: string;
  payee: string;
  amount: string;
  settledAt: number;
}

export interface WalletSpendStateV1 {
  stateVersion: typeof WALLET_SPEND_STATE_VERSION;
  policyHash: string;
  generation: number;
  reservations: readonly WalletSpendStoredReservationV1[];
  totals: readonly WalletSpendAssetTotalsV1[];
  rollingEvents: readonly WalletSpendEventV1[];
}

export interface WalletSpendStateStore {
  /** Optional authenticated read path used by status/doctor without a write. */
  read?(scope: string): Promise<Readonly<WalletSpendStateV1> | null>;
  /**
   * Serialize one wallet/chain policy transaction. Implementations used across
   * processes MUST hold an exclusive, crash-recoverable lock until `operation`
   * returns and durably publish the returned state before resolving.
   */
  transact<T>(
    scope: string,
    operation: (
      current: Readonly<WalletSpendStateV1> | null,
    ) => Readonly<{ state: Readonly<WalletSpendStateV1>; value: T }>,
  ): Promise<T>;
}

export interface WalletSpendAuthorityDependenciesV1 {
  store: WalletSpendStateStore;
  /** Authenticated balance for this exact wallet, chain and asset. */
  readBalance(input: Readonly<{
    wallet: string;
    chainId: string;
    asset: string;
  }>): Promise<string>;
  /** Required when any configured approval threshold is reached. */
  verifyOperatorApproval?: (
    approval: string,
    context: Readonly<{
      policyHash: string;
      bindingHash: string;
      reservation: Readonly<WalletSpendReservationV1>;
    }>,
  ) => Promise<boolean>;
  /**
   * Rail-specific authentication of final debit or authoritative absence.
   * A store entry is never released merely because a caller says an effect is
   * absent.
   */
  authenticateRecovery(
    reservation: Readonly<WalletSpendReservationV1>,
    observation: Readonly<WalletSpendRecoveryObservationV1>,
  ): Promise<boolean>;
  now?: () => number;
  leaseDurationMs?: number;
  owner?: string;
}

export interface WalletSpendEffectFenceV1 extends WalletSpendLeaseTokenV1 {
  reservationId: string;
  bindingHash: string;
  settlementBindingHash: string;
  assertCurrent(): Promise<void>;
}

export interface WalletSpendPermitV1 extends WalletSpendEffectFenceV1 {
  reservation: Readonly<WalletSpendReservationV1>;
  /** Persist ambiguity immediately before the first irreversible operation. */
  beginEffect(): Promise<void>;
  /** Record an authenticated finalized debit. */
  settle(observation: Readonly<WalletSpendSettlementObservationV1>): Promise<void>;
}

export type WalletSpendReservationClaimV1 =
  | { status: "reserved"; permit: WalletSpendPermitV1 }
  | { status: "held"; bindingHash: string; stage: "reserved" | "effect-pending" }
  | { status: "settled"; bindingHash: string; evidenceHash: string }
  | { status: "released"; bindingHash: string; evidenceHash: string }
  | { status: "conflict"; bindingHash: string }
  | {
      status: "denied";
      reason:
        | "balance-unavailable"
        | "insufficient-reserve"
        | "per-order-limit"
        | "network-fee-limit"
        | "rolling-limit"
        | "cumulative-limit"
        | "counterparty-limit"
        | "concurrency-limit"
        | "retention-limit"
        | "operator-approval-required"
        | "operator-approval-invalid";
    };

export interface WalletSpendAssetStatusV1 {
  asset: string;
  maximumPerOrderDebit: string;
  maximumNetworkFeeDebit: string;
  minimumReserve: string;
  rollingWindowMs: number;
  maximumRollingEffects: number;
  maximumRollingDebit: string;
  maximumCumulativeDebit: string;
  maximumCounterpartyDebit: string;
  operatorApprovalThreshold?: string;
  balance: string | null;
  reservedWorstCaseDebit: string;
  rollingSettledDebit: string;
  cumulativeSettledDebit: string;
  availableHeadroom: string | null;
}

export interface WalletSpendStatusV1 {
  policyId: string;
  policyHash: string;
  wallet: string;
  chainId: string;
  maximumConcurrentEffects: number;
  activeEffects: number;
  retainedReservations: number;
  maximumRetainedReservations: number;
  operatorActionReservations: readonly string[];
  assets: readonly WalletSpendAssetStatusV1[];
}

export interface WalletSpendAuthorityV1 {
  readonly policy: Readonly<WalletSpendPolicyV1>;
  readonly policyHash: string;
  reserve(
    reservation: Readonly<WalletSpendReservationV1>,
    options?: Readonly<{ operatorApproval?: string }>,
  ): Promise<WalletSpendReservationClaimV1>;
  /** Authenticate and account a retained ambiguous or finalized effect. */
  reconcile(
    reservation: Readonly<WalletSpendReservationV1>,
    observation: Readonly<WalletSpendRecoveryObservationV1>,
  ): Promise<"settled" | "released" | "existing">;
  inspect(): Promise<Readonly<WalletSpendStatusV1>>;
}

export type WalletSpendExecutionResultV1<T> =
  | Readonly<{ status: "completed"; result: T }>
  | Exclude<WalletSpendReservationClaimV1, { status: "reserved" }>;

export interface WalletSpendExecutionInputV1<T> {
  authority: WalletSpendAuthorityV1;
  reservation: Readonly<WalletSpendReservationV1>;
  operatorApproval?: string;
  /**
   * The rail must assert the supplied fence immediately beside its first
   * irreversible operation. Merely asserting it before transaction building is
   * not sufficient for a wallet shared by multiple workers.
   */
  effect(fence: Readonly<WalletSpendEffectFenceV1>): Promise<T>;
  /** Project only independently authenticated finality/debit observations. */
  settlement(
    result: T,
  ): Promise<Readonly<WalletSpendSettlementObservationV1>>;
}

/**
 * Combine the per-settlement generation fence with the wallet-wide permit for
 * direct use at an existing rail's irreversible-effect boundary.
 */
export function combineWalletSpendEffectFenceV1(
  settlement: Readonly<SettlementEffectFence>,
  wallet: Readonly<WalletSpendEffectFenceV1>,
): Readonly<SettlementEffectFence> {
  const settlementAssert = stableMethod<SettlementEffectFence["assertCurrent"]>(
    settlement,
    "assertCurrent",
    "settlement effect fence assertion",
  );
  const walletAssert = stableMethod<WalletSpendEffectFenceV1["assertCurrent"]>(
    wallet,
    "assertCurrent",
    "wallet spend effect fence assertion",
  );
  const settlementKey = nonEmpty(stableProperty(
    settlement,
    "settlementKey",
    "settlement effect fence key",
  ).value, "settlement effect fence key");
  const bindingHash = hash(stableProperty(
    settlement,
    "bindingHash",
    "settlement effect fence bindingHash",
  ).value, "settlement effect fence bindingHash");
  const owner = nonEmpty(stableProperty(
    settlement,
    "owner",
    "settlement effect fence owner",
  ).value, "settlement effect fence owner");
  const generation = safeInteger(stableProperty(
    settlement,
    "generation",
    "settlement effect fence generation",
  ).value, "settlement effect fence generation", true);
  const effectIdentityValue = stableProperty(
    settlement,
    "effectIdentity",
    "settlement effect fence identity",
  ).value;
  const effectIdentity = effectIdentityValue === undefined
    ? undefined
    : nonEmpty(effectIdentityValue, "settlement effect fence identity");
  const walletSettlementBindingHash = hash(stableProperty(
    wallet,
    "settlementBindingHash",
    "wallet spend settlement bindingHash",
  ).value, "wallet spend settlement bindingHash");
  if (bindingHash !== walletSettlementBindingHash) {
    throw new DacsError(
      "wallet spend permit does not bind the active settlement generation",
    );
  }
  return Object.freeze({
    settlementKey,
    bindingHash,
    owner,
    generation,
    ...(effectIdentity === undefined
      ? {}
      : { effectIdentity }),
    async assertCurrent(): Promise<void> {
      await settlementAssert();
      await walletAssert();
    },
  });
}

const INTEGER_RE = /^(?:0|[1-9][0-9]*)$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const DEFAULT_LEASE_DURATION_MS = 300_000;

type WalletAuthorityMethod = (...args: never[]) => unknown;

function stableProperty(
  source: unknown,
  key: string,
  label: string,
): Readonly<{ found: boolean; value?: unknown }> {
  if ((typeof source !== "object" && typeof source !== "function") ||
      source === null || nodeTypes.isProxy(source)) {
    throw new DacsError(`${label} must be stable data`);
  }
  let cursor: object | null = source;
  while (cursor !== null) {
    if (nodeTypes.isProxy(cursor)) throw new DacsError(`${label} must be stable data`);
    const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
    if (descriptor) {
      if (!("value" in descriptor)) throw new DacsError(`${label} must be stable data`);
      return Object.freeze({ found: true, value: descriptor.value });
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  return Object.freeze({ found: false });
}

function stableMethod<T extends WalletAuthorityMethod>(
  source: unknown,
  key: string,
  label: string,
): T {
  const property = stableProperty(source, key, label);
  if (!property.found || typeof property.value !== "function" ||
      nodeTypes.isProxy(property.value)) {
    throw new DacsError(`${label} must be a stable method`);
  }
  return Function.prototype.bind.call(property.value, source) as T;
}

const amount = (value: unknown, label: string): bigint => {
  if (typeof value !== "string" || !INTEGER_RE.test(value)) {
    throw new DacsError(`${label} must be a canonical non-negative integer`);
  }
  return BigInt(value);
};

const positiveAmount = (value: unknown, label: string): bigint => {
  const parsed = amount(value, label);
  if (parsed <= 0n) throw new DacsError(`${label} must be positive`);
  return parsed;
};

const nonEmpty = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value ||
      value.normalize("NFC") !== value) {
    throw new DacsError(`${label} must be a non-empty exact NFC string`);
  }
  return value;
};

const hash = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !HASH_RE.test(value)) {
    throw new DacsError(`${label} must be a lower-case SHA-256 hash`);
  }
  return value;
};

const safeInteger = (value: unknown, label: string, positive = false): number => {
  if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0) ||
      Object.is(value, -0)) {
    throw new DacsError(`${label} must be a ${positive ? "positive" : "non-negative"} safe integer`);
  }
  return value as number;
};

function frozenSnapshot<T>(value: T, label: string): Readonly<T> {
  const snapshot = snapshotCanonicalJsonRead(value, label) as T;
  const freeze = (item: unknown): void => {
    if (item !== null && typeof item === "object" && !Object.isFrozen(item)) {
      for (const child of Object.values(item as Record<string, unknown>)) freeze(child);
      Object.freeze(item);
    }
  };
  freeze(snapshot);
  return snapshot;
}

function capturePolicy(value: Readonly<WalletSpendPolicyV1>): Readonly<WalletSpendPolicyV1> {
  const policy = frozenSnapshot(value, "wallet spend policy");
  const allowed = new Set([
    "policyVersion", "policyId", "wallet", "chainId",
    "maximumConcurrentEffects", "maximumRetainedReservations", "assets",
  ]);
  if (Object.keys(policy).some((key) => !allowed.has(key)) ||
      policy.policyVersion !== "1" || !Array.isArray(policy.assets) ||
      policy.assets.length === 0) {
    throw new DacsError("wallet spend policy has an invalid shape");
  }
  nonEmpty(policy.policyId, "wallet spend policy id");
  nonEmpty(policy.wallet, "wallet spend policy wallet");
  nonEmpty(policy.chainId, "wallet spend policy chainId");
  safeInteger(policy.maximumConcurrentEffects, "wallet maximumConcurrentEffects", true);
  safeInteger(policy.maximumRetainedReservations, "wallet maximumRetainedReservations", true);
  const assets = new Set<string>();
  for (const entry of policy.assets) {
    const keys = new Set([
      "asset", "maximumPerOrderDebit", "maximumNetworkFeeDebit",
      "minimumReserve", "rollingWindowMs", "maximumRollingDebit",
      "maximumRollingEffects",
      "maximumCumulativeDebit", "maximumCounterpartyDebit",
      "operatorApprovalThreshold",
    ]);
    if (Object.keys(entry).some((key) => !keys.has(key))) {
      throw new DacsError("wallet spend asset policy has an invalid shape");
    }
    const asset = nonEmpty(entry.asset, "wallet spend asset");
    if (assets.has(asset)) throw new DacsError("wallet spend policy has duplicate assets");
    assets.add(asset);
    positiveAmount(entry.maximumPerOrderDebit, "maximumPerOrderDebit");
    amount(entry.maximumNetworkFeeDebit, "maximumNetworkFeeDebit");
    amount(entry.minimumReserve, "minimumReserve");
    safeInteger(entry.rollingWindowMs, "rollingWindowMs", true);
    safeInteger(entry.maximumRollingEffects, "maximumRollingEffects", true);
    positiveAmount(entry.maximumRollingDebit, "maximumRollingDebit");
    positiveAmount(entry.maximumCumulativeDebit, "maximumCumulativeDebit");
    positiveAmount(entry.maximumCounterpartyDebit, "maximumCounterpartyDebit");
    if (entry.operatorApprovalThreshold !== undefined) {
      positiveAmount(entry.operatorApprovalThreshold, "operatorApprovalThreshold");
    }
  }
  return policy;
}

function captureReservation(
  value: Readonly<WalletSpendReservationV1>,
  policy: Readonly<WalletSpendPolicyV1>,
): Readonly<WalletSpendReservationV1> {
  const reservation = frozenSnapshot(value, "wallet spend reservation");
  const allowed = new Set([
    "reservationVersion", "reservationId", "jobId", "phaseIndex", "phase",
    "agreementHash", "settlementBindingHash", "railId", "railDefinitionHash",
    "wallet", "chainId",
    "payee", "finality", "debits",
  ]);
  if (Object.keys(reservation).some((key) => !allowed.has(key)) ||
      reservation.reservationVersion !== "1" ||
      reservation.wallet !== policy.wallet || reservation.chainId !== policy.chainId ||
      !Array.isArray(reservation.debits) || reservation.debits.length === 0) {
    throw new DacsError("wallet spend reservation has an invalid shape or scope");
  }
  for (const [label, item] of Object.entries({
    reservationId: reservation.reservationId,
    jobId: reservation.jobId,
    phase: reservation.phase,
    railId: reservation.railId,
    wallet: reservation.wallet,
    chainId: reservation.chainId,
    payee: reservation.payee,
  })) nonEmpty(item, `wallet spend reservation ${label}`);
  safeInteger(reservation.phaseIndex, "wallet spend phaseIndex");
  hash(reservation.agreementHash, "wallet spend agreementHash");
  hash(reservation.settlementBindingHash, "wallet spend settlementBindingHash");
  hash(reservation.railDefinitionHash, "wallet spend railDefinitionHash");
  if (reservation.finality === null || typeof reservation.finality !== "object" ||
      Array.isArray(reservation.finality) ||
      Object.keys(reservation.finality).some((key) =>
        key !== "model" && key !== "finalityBlocks")) {
    throw new DacsError("wallet spend finality has an invalid shape");
  }
  nonEmpty(reservation.finality.model, "wallet spend finality model");
  if (reservation.finality.finalityBlocks !== undefined) {
    safeInteger(reservation.finality.finalityBlocks, "wallet spend finalityBlocks", true);
  }
  const debitKeys = new Set<string>();
  const policyAssets = new Set(policy.assets.map(({ asset }) => asset));
  for (const debit of reservation.debits) {
    if (Object.keys(debit).some((key) =>
      key !== "asset" && key !== "purpose" && key !== "expectedAmount" &&
        key !== "maximumAmount") ||
      (debit.purpose !== "service" && debit.purpose !== "network-fee")) {
      throw new DacsError("wallet spend debit reservation has an invalid shape");
    }
    nonEmpty(debit.asset, "wallet spend debit asset");
    if (!policyAssets.has(debit.asset)) {
      throw new DacsError("wallet spend debit asset is outside policy");
    }
    const expected = amount(debit.expectedAmount, "wallet spend expected debit");
    const maximum = positiveAmount(debit.maximumAmount, "wallet spend maximum debit");
    if (expected > maximum ||
        (debit.purpose === "service" && (expected <= 0n || expected !== maximum))) {
      throw new DacsError("wallet spend expected debit conflicts with its hard maximum");
    }
    const key = `${debit.asset}\0${debit.purpose}`;
    if (debitKeys.has(key)) {
      throw new DacsError("wallet spend reservation has duplicate debit purposes");
    }
    debitKeys.add(key);
  }
  if (!reservation.debits.some(({ purpose }) => purpose === "service")) {
    throw new DacsError("wallet spend reservation must bind the exact service debit");
  }
  return reservation;
}

function bindingHash(reservation: Readonly<WalletSpendReservationV1>): string {
  return sha256Hex(`dacs-wallet-spend-reservation:v1:${canonicalize(reservation)}`);
}

const emptyState = (policyHash: string): WalletSpendStateV1 => ({
  stateVersion: WALLET_SPEND_STATE_VERSION,
  policyHash,
  generation: 0,
  reservations: [],
  totals: [],
  rollingEvents: [],
});

function captureState(
  value: Readonly<WalletSpendStateV1> | null,
  policy: Readonly<WalletSpendPolicyV1>,
  expectedPolicyHash: string,
): WalletSpendStateV1 {
  if (value === null) return emptyState(expectedPolicyHash);
  const state = frozenSnapshot(value, "wallet spend state");
  if (Object.keys(state).some((key) => !new Set([
        "stateVersion", "policyHash", "generation", "reservations", "totals",
        "rollingEvents",
      ]).has(key)) ||
      state.stateVersion !== WALLET_SPEND_STATE_VERSION ||
      state.policyHash !== expectedPolicyHash ||
      !Array.isArray(state.reservations) || !Array.isArray(state.totals) ||
      !Array.isArray(state.rollingEvents)) {
    throw new DacsError("wallet spend state is corrupt or belongs to another policy");
  }
  safeInteger(state.generation, "wallet spend state generation");
  if (state.reservations.length > policy.maximumRetainedReservations) {
    throw new DacsError("wallet spend state exceeds its retention policy");
  }
  const reservationIds = new Set<string>();
  const settledRows = new Map<string, Readonly<WalletSpendStoredReservationV1>>();
  for (const row of state.reservations) {
    if (Object.keys(row).some((key) => !new Set([
      "reservationId", "bindingHash", "reservation", "stage", "generation",
      "owner", "leaseExpiresAt", "approvalHash", "evidenceHash", "actualDebits",
      "createdAt", "updatedAt",
    ]).has(key))) {
      throw new DacsError("wallet spend state has an invalid reservation shape");
    }
    const capturedReservation = captureReservation(row.reservation, policy);
    nonEmpty(row.reservationId, "stored wallet reservation id");
    if (reservationIds.has(row.reservationId)) {
      throw new DacsError("wallet spend state has duplicate reservations");
    }
    reservationIds.add(row.reservationId);
    hash(row.bindingHash, "stored wallet reservation bindingHash");
    if (bindingHash(capturedReservation) !== row.bindingHash ||
        row.reservationId !== capturedReservation.reservationId ||
        !["reserved", "effect-pending", "settled", "released"].includes(row.stage)) {
      throw new DacsError("wallet spend state has an unbound reservation");
    }
    safeInteger(row.generation, "stored wallet reservation generation", true);
    if (row.generation > state.generation) {
      throw new DacsError("wallet spend reservation generation is from the future");
    }
    safeInteger(row.createdAt, "stored wallet reservation createdAt");
    safeInteger(row.updatedAt, "stored wallet reservation updatedAt");
    if (row.stage === "reserved" || row.stage === "effect-pending") {
      nonEmpty(row.owner, "active wallet reservation owner");
      safeInteger(row.leaseExpiresAt, "active wallet reservation leaseExpiresAt", true);
      if (row.evidenceHash !== undefined || row.actualDebits !== undefined) {
        throw new DacsError("active wallet reservation carries terminal accounting");
      }
    } else if (row.owner !== undefined || row.leaseExpiresAt !== undefined) {
      throw new DacsError("terminal wallet reservation carries an active lease");
    }
    if (row.approvalHash !== undefined) hash(row.approvalHash, "wallet approvalHash");
    const approvalRequired = policy.assets.some((assetPolicy) =>
      assetPolicy.operatorApprovalThreshold !== undefined &&
      (aggregateDebits(capturedReservation.debits).get(assetPolicy.asset) ?? 0n) >=
        amount(assetPolicy.operatorApprovalThreshold, "operator approval threshold"));
    if (approvalRequired !== (row.approvalHash !== undefined)) {
      throw new DacsError("wallet spend reservation approval evidence is inconsistent");
    }
    if ((row.stage === "settled" || row.stage === "released") &&
        !HASH_RE.test(row.evidenceHash ?? "")) {
      throw new DacsError("terminal wallet reservation lacks evidence");
    }
    if (row.stage === "settled") {
      if (!Array.isArray(row.actualDebits)) {
        throw new DacsError("settled wallet reservation lacks debit accounting");
      }
      const maxima = new Map(capturedReservation.debits.map((debit) => [
        `${debit.asset}\0${debit.purpose}`,
        positiveAmount(debit.maximumAmount, "stored wallet maximum debit"),
      ]));
      const seen = new Set<string>();
      for (const debit of row.actualDebits) {
        if (Object.keys(debit).some((key) =>
          key !== "asset" && key !== "purpose" && key !== "amount") ||
            (debit.purpose !== "service" && debit.purpose !== "network-fee")) {
          throw new DacsError("stored wallet actual debit has an invalid shape");
        }
        const key = `${debit.asset}\0${debit.purpose}`;
        const maximum = maxima.get(key);
        const actual = amount(debit.amount, "stored wallet actual debit");
        if (maximum === undefined || seen.has(key) || actual > maximum ||
            (debit.purpose === "service" && actual !== maximum)) {
          throw new DacsError("stored wallet actual debit exceeds or conflicts with its reservation");
        }
        seen.add(key);
      }
      if (seen.size !== maxima.size) {
        throw new DacsError("stored wallet debit accounting is incomplete");
      }
      settledRows.set(row.reservationId, row);
    } else if (row.actualDebits !== undefined) {
      throw new DacsError("non-settled wallet reservation carries debit accounting");
    }
  }
  const policyAssets = new Set(policy.assets.map(({ asset }) => asset));
  const totalAssets = new Set<string>();
  for (const total of state.totals) {
    if (Object.keys(total).some((key) =>
      key !== "asset" && key !== "cumulativeDebit" && key !== "counterpartyDebits")) {
      throw new DacsError("wallet spend total has an invalid shape");
    }
    nonEmpty(total.asset, "wallet spend total asset");
    if (!policyAssets.has(total.asset) || totalAssets.has(total.asset)) {
      throw new DacsError("wallet spend state has duplicate or unknown totals");
    }
    totalAssets.add(total.asset);
    amount(total.cumulativeDebit, "wallet cumulative debit");
    if (total.counterpartyDebits === null ||
        typeof total.counterpartyDebits !== "object" ||
        Array.isArray(total.counterpartyDebits)) {
      throw new DacsError("wallet counterparty totals are invalid");
    }
    for (const [payee, debit] of Object.entries(total.counterpartyDebits)) {
      nonEmpty(payee, "wallet counterparty");
      amount(debit, "wallet counterparty debit");
    }
  }
  const recomputed = new Map<string, { cumulative: bigint; counterparties: Map<string, bigint> }>();
  for (const row of settledRows.values()) {
    for (const [asset, debit] of aggregateDebits(row.actualDebits!)) {
      const total = recomputed.get(asset) ?? { cumulative: 0n, counterparties: new Map() };
      total.cumulative += debit;
      total.counterparties.set(
        row.reservation.payee,
        (total.counterparties.get(row.reservation.payee) ?? 0n) + debit,
      );
      recomputed.set(asset, total);
    }
  }
  for (const assetPolicy of policy.assets) {
    const retained = totalFor(state, assetPolicy.asset);
    const expected = recomputed.get(assetPolicy.asset) ?? {
      cumulative: 0n,
      counterparties: new Map<string, bigint>(),
    };
    if (amount(retained.cumulativeDebit, "wallet cumulative debit") !== expected.cumulative ||
        Object.keys(retained.counterpartyDebits).length !== expected.counterparties.size ||
        [...expected.counterparties].some(([payee, debit]) =>
          amount(retained.counterpartyDebits[payee], "wallet counterparty debit") !== debit)) {
      throw new DacsError("wallet spend totals do not match retained settlements");
    }
  }
  for (const event of state.rollingEvents) {
    if (Object.keys(event).some((key) => !new Set([
      "reservationId", "asset", "payee", "amount", "settledAt",
    ]).has(key))) {
      throw new DacsError("wallet spend event has an invalid shape");
    }
    nonEmpty(event.reservationId, "wallet spend event reservationId");
    nonEmpty(event.asset, "wallet spend event asset");
    nonEmpty(event.payee, "wallet spend event payee");
    positiveAmount(event.amount, "wallet spend event amount");
    safeInteger(event.settledAt, "wallet spend event settledAt");
    const row = settledRows.get(event.reservationId);
    if (!row || row.reservation.payee !== event.payee ||
        aggregateDebits(row.actualDebits!).get(event.asset)?.toString() !== event.amount) {
      throw new DacsError("wallet spend rolling event is not bound to its settlement");
    }
  }
  return structuredClone(state);
}

function aggregateDebits(
  debits: readonly { asset: string; amount?: string; maximumAmount?: string }[],
): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const debit of debits) {
    const value = amount(debit.amount ?? debit.maximumAmount, "wallet spend debit");
    totals.set(debit.asset, (totals.get(debit.asset) ?? 0n) + value);
  }
  return totals;
}

const sumFor = (values: Iterable<bigint>): bigint => {
  let result = 0n;
  for (const value of values) result += value;
  return result;
};

function active(row: Readonly<WalletSpendStoredReservationV1>): boolean {
  return row.stage === "reserved" || row.stage === "effect-pending";
}

function totalFor(
  state: Readonly<WalletSpendStateV1>,
  asset: string,
): Readonly<WalletSpendAssetTotalsV1> {
  return state.totals.find((candidate) => candidate.asset === asset) ?? {
    asset,
    cumulativeDebit: "0",
    counterpartyDebits: {},
  };
}

function recentEvents(
  state: WalletSpendStateV1,
  policy: Readonly<WalletSpendPolicyV1>,
  now: number,
): readonly WalletSpendEventV1[] {
  const windows = new Map(policy.assets.map((entry) => [entry.asset, entry.rollingWindowMs]));
  return state.rollingEvents.filter((event) => {
    if (event.settledAt > now) {
      throw new DacsError("wallet spend state contains a future settlement");
    }
    return now - event.settledAt <= (windows.get(event.asset) ?? 0);
  });
}

/** Deterministic in-memory state store for tests and single-process tooling. */
export function createInMemoryWalletSpendStateStore(): WalletSpendStateStore {
  const states = new Map<string, WalletSpendStateV1>();
  const tails = new Map<string, Promise<void>>();
  const store: WalletSpendStateStore = {
    async read(scope: string): Promise<Readonly<WalletSpendStateV1> | null> {
      const prior = tails.get(scope);
      if (prior !== undefined) await prior.catch(() => undefined);
      const current = states.get(scope);
      return current === undefined ? null : structuredClone(current);
    },
    async transact<T>(
      scope: string,
      operation: (
        current: Readonly<WalletSpendStateV1> | null,
      ) => Readonly<{ state: Readonly<WalletSpendStateV1>; value: T }>,
    ): Promise<T> {
      const prior = tails.get(scope) ?? Promise.resolve();
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const tail = prior.catch(() => undefined).then(() => held);
      tails.set(scope, tail);
      await prior.catch(() => undefined);
      try {
        const current = states.get(scope);
        const result = operation(current === undefined ? null : structuredClone(current));
        states.set(scope, structuredClone(result.state));
        return result.value;
      } finally {
        release();
        if (tails.get(scope) === tail) {
          void tail.finally(() => {
            if (tails.get(scope) === tail) tails.delete(scope);
          });
        }
      }
    },
  };
  return store;
}

/**
 * Create a fail-closed wallet authority. Raw signing clients remain available
 * for explicit/manual use; unattended coordinators should receive only this
 * bounded capability plus a rail adapter that consumes its permit.
 */
export function createWalletSpendAuthorityV1(
  inputPolicy: Readonly<WalletSpendPolicyV1>,
  dependencies: Readonly<WalletSpendAuthorityDependenciesV1>,
): WalletSpendAuthorityV1 {
  const policy = capturePolicy(inputPolicy);
  const policyHash = sha256Hex(
    `dacs-wallet-spend-policy:v1:${canonicalize(policy)}`,
  );
  const scope = sha256Hex(`dacs-wallet-spend-scope:v1:${canonicalize({
    wallet: policy.wallet,
    chainId: policy.chainId,
    policyId: policy.policyId,
  })}`);
  const ownerProperty = stableProperty(
    dependencies,
    "owner",
    "wallet spend authority owner",
  );
  const owner = nonEmpty(
    (ownerProperty.found ? ownerProperty.value : undefined) ?? randomUUID(),
    "wallet spend authority owner",
  );
  const leaseProperty = stableProperty(
    dependencies,
    "leaseDurationMs",
    "wallet spend leaseDurationMs",
  );
  const leaseDurationMs = safeInteger(
    (leaseProperty.found ? leaseProperty.value : undefined) ?? DEFAULT_LEASE_DURATION_MS,
    "wallet spend leaseDurationMs",
    true,
  );
  const nowProperty = stableProperty(dependencies, "now", "wallet spend clock");
  const now = !nowProperty.found || nowProperty.value === undefined
    ? Date.now
    : stableMethod<() => number>(dependencies, "now", "wallet spend clock");
  const readBalance = stableMethod<WalletSpendAuthorityDependenciesV1["readBalance"]>(
    dependencies,
    "readBalance",
    "wallet balance reader",
  );
  const authenticateRecovery = stableMethod<
    WalletSpendAuthorityDependenciesV1["authenticateRecovery"]
  >(dependencies, "authenticateRecovery", "wallet recovery authenticator");
  const approvalProperty = stableProperty(
    dependencies,
    "verifyOperatorApproval",
    "wallet operator approval verifier",
  );
  const verifyOperatorApproval = !approvalProperty.found ||
      approvalProperty.value === undefined
    ? undefined
    : stableMethod<NonNullable<
        WalletSpendAuthorityDependenciesV1["verifyOperatorApproval"]
      >>(dependencies, "verifyOperatorApproval", "wallet operator approval verifier");
  const store = stableProperty(
    dependencies,
    "store",
    "wallet spend state store",
  ).value;
  const transact = stableMethod<WalletSpendStateStore["transact"]>(
    store,
    "transact",
    "wallet spend state transaction",
  );
  const readProperty = stableProperty(
    store,
    "read",
    "wallet spend state read",
  );
  const read = !readProperty.found || readProperty.value === undefined
    ? undefined
    : stableMethod<NonNullable<WalletSpendStateStore["read"]>>(
        store,
        "read",
        "wallet spend state read",
      );

  const update = <T>(
    operation: (state: WalletSpendStateV1, timestamp: number) => Readonly<{
      state: WalletSpendStateV1;
      value: T;
    }>,
  ): Promise<T> => {
    const timestamp = safeInteger(now(), "wallet spend clock");
    return transact(scope, (stored) => {
      const state = captureState(stored, policy, policyHash);
      state.rollingEvents = recentEvents(state, policy, timestamp);
      return operation(state, timestamp);
    });
  };

  const permitFor = (
    reservation: Readonly<WalletSpendReservationV1>,
    binding: string,
    token: Readonly<WalletSpendLeaseTokenV1>,
  ): WalletSpendPermitV1 => {
    const assertCurrent = async (): Promise<void> => update((state, timestamp) => {
      const row = state.reservations.find(({ reservationId }) =>
        reservationId === reservation.reservationId);
      if (!row || row.bindingHash !== binding || row.owner !== token.owner ||
          row.generation !== token.generation || !active(row) ||
          (row.leaseExpiresAt ?? 0) < timestamp) {
        throw new DacsError("wallet spend effect fence is no longer current");
      }
      return { state, value: undefined };
    });

    const permit: WalletSpendPermitV1 = {
      reservationId: reservation.reservationId,
      bindingHash: binding,
      settlementBindingHash: reservation.settlementBindingHash,
      owner: token.owner,
      generation: token.generation,
      reservation,
      assertCurrent,
      async beginEffect(): Promise<void> {
        await update((state, timestamp) => {
          const rows = state.reservations.map((row) => {
            if (row.reservationId !== reservation.reservationId) return row;
            if (row.bindingHash !== binding || row.owner !== token.owner ||
                row.generation !== token.generation || row.stage !== "reserved" ||
                (row.leaseExpiresAt ?? 0) < timestamp) {
              throw new DacsError("wallet spend reservation cannot begin an effect");
            }
            return { ...row, stage: "effect-pending" as const, updatedAt: timestamp };
          });
          return { state: { ...state, reservations: rows }, value: undefined };
        });
      },
      async settle(
        observation: Readonly<WalletSpendSettlementObservationV1>,
      ): Promise<void> {
        const captured = captureObservation(observation, reservation);
        if (captured.disposition !== "settled") {
          throw new DacsError("wallet spend permit requires a settlement observation");
        }
        if (!await authenticateRecovery(reservation, captured)) {
          throw new DacsError("wallet spend settlement authentication failed");
        }
        await settleStored(reservation, binding, captured, token);
      },
    };
    return Object.freeze(permit);
  };

  const captureObservation = (
    value: Readonly<WalletSpendRecoveryObservationV1>,
    reservation: Readonly<WalletSpendReservationV1>,
  ): Readonly<WalletSpendRecoveryObservationV1> => {
    const observation = frozenSnapshot(value, "wallet spend recovery observation");
    const allowed = observation.disposition === "settled"
      ? new Set(["disposition", "evidenceHash", "debits"])
      : new Set(["disposition", "evidenceHash"]);
    if (Object.keys(observation).some((key) => !allowed.has(key))) {
      throw new DacsError("wallet spend recovery observation has an invalid shape");
    }
    hash(observation.evidenceHash, "wallet spend recovery evidenceHash");
    if (observation.disposition === "settled") {
      if (!Array.isArray(observation.debits) || observation.debits.length === 0) {
        throw new DacsError("wallet spend settlement has no debit accounting");
      }
      const maxima = new Map(reservation.debits.map((debit) => [
        `${debit.asset}\0${debit.purpose}`,
        positiveAmount(debit.maximumAmount, "wallet spend maximum debit"),
      ]));
      const seen = new Set<string>();
      for (const debit of observation.debits) {
        if (Object.keys(debit).some((key) =>
          key !== "asset" && key !== "purpose" && key !== "amount") ||
            (debit.purpose !== "service" && debit.purpose !== "network-fee")) {
          throw new DacsError("wallet spend settlement debit purpose is invalid");
        }
        const key = `${debit.asset}\0${debit.purpose}`;
        if (seen.has(key) || !maxima.has(key)) {
          throw new DacsError("wallet spend settlement debit is unbound");
        }
        seen.add(key);
        const actual = amount(debit.amount, "wallet spend actual debit");
        if (actual > maxima.get(key)!) {
          throw new DacsError("wallet spend actual debit exceeds its reservation");
        }
        if (debit.purpose === "service" && actual !== maxima.get(key)) {
          throw new DacsError("wallet spend service debit differs from the agreement");
        }
      }
      if (seen.size !== maxima.size) {
        throw new DacsError("wallet spend settlement omits reserved debit accounting");
      }
      return observation;
    }
    if (observation.disposition !== "not-invoked" &&
        observation.disposition !== "terminal-absent") {
      throw new DacsError("wallet spend recovery disposition is invalid");
    }
    return observation;
  };

  const settleStored = async (
    reservation: Readonly<WalletSpendReservationV1>,
    binding: string,
    observation: Readonly<WalletSpendSettlementObservationV1>,
    token?: Readonly<WalletSpendLeaseTokenV1>,
  ): Promise<"settled" | "existing"> => update((state, timestamp) => {
    const existing = state.reservations.find(({ reservationId }) =>
      reservationId === reservation.reservationId);
    if (!existing || existing.bindingHash !== binding) {
      throw new DacsError("wallet spend settlement does not match a reservation");
    }
    if (existing.stage === "settled") {
      if (existing.evidenceHash !== observation.evidenceHash ||
          canonicalize(existing.actualDebits) !== canonicalize(observation.debits)) {
        throw new DacsError("wallet spend settlement conflicts with durable accounting");
      }
      return { state, value: "existing" as const };
    }
    if (existing.stage === "released") {
      throw new DacsError("released wallet spend reservation cannot settle");
    }
    if (token !== undefined && (existing.owner !== token.owner ||
        existing.generation !== token.generation || existing.stage !== "effect-pending")) {
      throw new DacsError("wallet spend settlement permit is stale");
    }
    const actualByAsset = aggregateDebits(observation.debits);
    const totals = policy.assets.map(({ asset }) => {
      const prior = totalFor(state, asset);
      const actual = actualByAsset.get(asset) ?? 0n;
      const counterparty = { ...prior.counterpartyDebits };
      counterparty[reservation.payee] = (
        amount(counterparty[reservation.payee] ?? "0", "wallet counterparty debit") + actual
      ).toString();
      return {
        asset,
        cumulativeDebit: (
          amount(prior.cumulativeDebit, "wallet cumulative debit") + actual
        ).toString(),
        counterpartyDebits: counterparty,
      };
    });
    const events = [...state.rollingEvents];
    for (const [asset, actual] of actualByAsset) {
      if (actual > 0n) events.push({
        reservationId: reservation.reservationId,
        asset,
        payee: reservation.payee,
        amount: actual.toString(),
        settledAt: timestamp,
      });
    }
    const rows = state.reservations.map((row) => {
      if (row.reservationId !== reservation.reservationId) return row;
      const { owner: _owner, leaseExpiresAt: _lease, ...retained } = row;
      return {
        ...retained,
        stage: "settled" as const,
        evidenceHash: observation.evidenceHash,
        actualDebits: observation.debits,
        updatedAt: timestamp,
      };
    });
    return {
      state: { ...state, reservations: rows, totals, rollingEvents: events },
      value: "settled" as const,
    };
  });

  const authority: WalletSpendAuthorityV1 = {
    policy,
    policyHash,
    async reserve(inputReservation, options = {}) {
      const reservation = captureReservation(inputReservation, policy);
      const binding = bindingHash(reservation);
      const capturedOptions = frozenSnapshot(options, "wallet spend reservation options");
      if (Object.keys(capturedOptions).some((key) => key !== "operatorApproval")) {
        throw new DacsError("wallet spend reservation option is unsupported");
      }
      const approval = capturedOptions.operatorApproval;
      if (approval !== undefined) nonEmpty(approval, "wallet spend operator approval");

      type ExistingClaim = Exclude<
        WalletSpendReservationClaimV1,
        { status: "reserved" } | { status: "denied" }
      >;
      const prior = await update<ExistingClaim | null>((state) => {
        const existing = state.reservations.find(({ reservationId }) =>
          reservationId === reservation.reservationId);
        if (!existing) return { state, value: null };
        if (existing.bindingHash !== binding) {
          return { state, value: { status: "conflict", bindingHash: existing.bindingHash } };
        }
        if (existing.stage === "settled") {
          return { state, value: {
            status: "settled", bindingHash: binding, evidenceHash: existing.evidenceHash!,
          } };
        }
        if (existing.stage === "released") {
          // An authenticated absence proves the prior effect did not debit the
          // wallet. The same immutable authorization may therefore obtain a
          // fresh generation; a settled row remains permanently terminal.
          return { state, value: null };
        }
        return { state, value: {
          status: "held", bindingHash: binding, stage: existing.stage,
        } };
      });
      if (prior !== null) return prior;

      const maximumByAsset = aggregateDebits(reservation.debits);
      const balances = new Map<string, bigint>();
      try {
        await Promise.all([...maximumByAsset.keys()].map(async (asset) => {
          const observed = await readBalance({
            wallet: policy.wallet,
            chainId: policy.chainId,
            asset,
          });
          balances.set(asset, amount(observed, "authenticated wallet balance"));
        }));
      } catch {
        return { status: "denied", reason: "balance-unavailable" } as const;
      }

      let approvalRequired = false;
      for (const assetPolicy of policy.assets) {
        const threshold = assetPolicy.operatorApprovalThreshold;
        if (threshold !== undefined &&
            (maximumByAsset.get(assetPolicy.asset) ?? 0n) >= amount(threshold, "approval threshold")) {
          approvalRequired = true;
        }
      }
      let approvalHash: string | undefined;
      if (approvalRequired) {
        if (approval === undefined || verifyOperatorApproval === undefined) {
          return { status: "denied", reason: "operator-approval-required" };
        }
        const accepted = await verifyOperatorApproval(approval, {
          policyHash,
          bindingHash: binding,
          reservation,
        });
        if (!accepted) return { status: "denied", reason: "operator-approval-invalid" };
        approvalHash = sha256Hex(approval);
      }

      type InternalClaim = Exclude<
        WalletSpendReservationClaimV1,
        { status: "reserved" }
      > |
        Readonly<{ status: "reserved"; generation: number }>;
      const claim = await update<InternalClaim>((state, timestamp) => {
        const existing = state.reservations.find(({ reservationId }) =>
          reservationId === reservation.reservationId);
        if (existing) {
          if (existing.bindingHash !== binding) {
            return { state, value: { status: "conflict", bindingHash: existing.bindingHash } as const };
          }
          if (existing.stage === "settled") {
            return { state, value: {
              status: "settled", bindingHash: binding, evidenceHash: existing.evidenceHash!,
            } as const };
          }
          if (existing.stage !== "released") {
            return { state, value: {
              status: "held", bindingHash: binding, stage: existing.stage,
            } as const };
          }
        }
        if (!existing && state.reservations.length >= policy.maximumRetainedReservations) {
          return { state, value: { status: "denied", reason: "retention-limit" } as const };
        }
        const activeRows = state.reservations.filter(active);
        if (activeRows.length >= policy.maximumConcurrentEffects) {
          return { state, value: { status: "denied", reason: "concurrency-limit" } as const };
        }
        for (const assetPolicy of policy.assets) {
          const requested = maximumByAsset.get(assetPolicy.asset) ?? 0n;
          if (requested === 0n) continue;
          const networkFee = sumFor(reservation.debits
            .filter((debit) => debit.asset === assetPolicy.asset && debit.purpose === "network-fee")
            .map((debit) => amount(debit.maximumAmount, "maximum network fee")));
          if (requested > amount(assetPolicy.maximumPerOrderDebit, "maximum per order")) {
            return { state, value: { status: "denied", reason: "per-order-limit" } as const };
          }
          if (networkFee > amount(assetPolicy.maximumNetworkFeeDebit, "maximum network fee")) {
            return { state, value: { status: "denied", reason: "network-fee-limit" } as const };
          }
          const activeDebit = sumFor(activeRows.map((row) =>
            aggregateDebits(row.reservation.debits).get(assetPolicy.asset) ?? 0n));
          const balance = balances.get(assetPolicy.asset)!;
          if (balance < activeDebit + requested +
              amount(assetPolicy.minimumReserve, "minimum reserve")) {
            return { state, value: { status: "denied", reason: "insufficient-reserve" } as const };
          }
          const rolling = sumFor(state.rollingEvents
            .filter((event) => event.asset === assetPolicy.asset)
            .map((event) => amount(event.amount, "rolling debit")));
          if (rolling + activeDebit + requested >
              amount(assetPolicy.maximumRollingDebit, "maximum rolling debit")) {
            return { state, value: { status: "denied", reason: "rolling-limit" } as const };
          }
          const rollingEffects = new Set(state.rollingEvents
            .filter((event) => event.asset === assetPolicy.asset)
            .map(({ reservationId }) => reservationId)).size;
          const activeEffects = activeRows.filter((row) =>
            row.reservation.debits.some((debit) => debit.asset === assetPolicy.asset)).length;
          if (rollingEffects + activeEffects + 1 > assetPolicy.maximumRollingEffects) {
            return { state, value: { status: "denied", reason: "rolling-limit" } as const };
          }
          const totals = totalFor(state, assetPolicy.asset);
          if (amount(totals.cumulativeDebit, "cumulative debit") + activeDebit + requested >
              amount(assetPolicy.maximumCumulativeDebit, "maximum cumulative debit")) {
            return { state, value: { status: "denied", reason: "cumulative-limit" } as const };
          }
          const counterparty = amount(
            totals.counterpartyDebits[reservation.payee] ?? "0",
            "counterparty debit",
          );
          const activeCounterparty = sumFor(activeRows
            .filter((row) => row.reservation.payee === reservation.payee)
            .map((row) => aggregateDebits(row.reservation.debits).get(assetPolicy.asset) ?? 0n));
          if (counterparty + activeCounterparty + requested >
              amount(assetPolicy.maximumCounterpartyDebit, "maximum counterparty debit")) {
            return { state, value: { status: "denied", reason: "counterparty-limit" } as const };
          }
        }
        const generation = state.generation + 1;
        if (!Number.isSafeInteger(generation)) {
          throw new DacsError("wallet spend generation is exhausted");
        }
        const leaseExpiresAt = timestamp + leaseDurationMs;
        if (!Number.isSafeInteger(leaseExpiresAt)) {
          throw new DacsError("wallet spend lease timestamp is invalid");
        }
        const row: WalletSpendStoredReservationV1 = {
          reservationId: reservation.reservationId,
          bindingHash: binding,
          reservation,
          stage: "reserved",
          generation,
          owner,
          leaseExpiresAt,
          ...(approvalHash === undefined ? {} : { approvalHash }),
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        return {
          state: {
            ...state,
            generation,
            reservations: existing
              ? state.reservations.map((candidate) =>
                  candidate.reservationId === reservation.reservationId ? row : candidate)
              : [...state.reservations, row],
          },
          value: { status: "reserved", generation } as const,
        };
      });
      if (claim.status !== "reserved") return claim;
      return {
        status: "reserved",
        permit: permitFor(reservation, binding, { owner, generation: claim.generation }),
      };
    },
    async reconcile(inputReservation, inputObservation) {
      const reservation = captureReservation(inputReservation, policy);
      const binding = bindingHash(reservation);
      const observation = captureObservation(inputObservation, reservation);
      if (!await authenticateRecovery(reservation, observation)) {
        throw new DacsError("wallet spend recovery authentication failed");
      }
      if (observation.disposition === "settled") {
        return settleStored(reservation, binding, observation);
      }
      return update((state, timestamp) => {
        const existing = state.reservations.find(({ reservationId }) =>
          reservationId === reservation.reservationId);
        if (!existing || existing.bindingHash !== binding) {
          throw new DacsError("wallet spend absence does not match a reservation");
        }
        if (existing.stage === "settled") {
          throw new DacsError("settled wallet spend reservation cannot be released");
        }
        if (existing.stage === "released") {
          if (existing.evidenceHash !== observation.evidenceHash) {
            throw new DacsError("wallet spend absence conflicts with durable accounting");
          }
          return { state, value: "existing" as const };
        }
        if ((existing.leaseExpiresAt ?? Number.MAX_SAFE_INTEGER) >= timestamp) {
          throw new DacsError("wallet spend recovery cannot supersede a live worker");
        }
        if (observation.disposition === "not-invoked" &&
            existing.stage !== "reserved") {
          throw new DacsError(
            "wallet spend effect-pending ambiguity requires terminal absence proof",
          );
        }
        const rows = state.reservations.map((row) => {
          if (row.reservationId !== reservation.reservationId) return row;
          const { owner: _owner, leaseExpiresAt: _lease, ...retained } = row;
          return {
            ...retained,
            stage: "released" as const,
            evidenceHash: observation.evidenceHash,
            updatedAt: timestamp,
          };
        });
        return { state: { ...state, reservations: rows }, value: "released" as const };
      });
    },
    async inspect() {
      const balances = new Map<string, bigint | null>();
      await Promise.all(policy.assets.map(async ({ asset }) => {
        try {
          balances.set(asset, amount(await readBalance({
            wallet: policy.wallet,
            chainId: policy.chainId,
            asset,
          }), "authenticated wallet balance"));
        } catch {
          balances.set(asset, null);
        }
      }));
      const project = (state: WalletSpendStateV1, timestamp: number) => {
        const activeRows = state.reservations.filter(active);
        const assets = policy.assets.map((assetPolicy) => {
          const reserved = sumFor(activeRows.map((row) =>
            aggregateDebits(row.reservation.debits).get(assetPolicy.asset) ?? 0n));
          const rolling = sumFor(state.rollingEvents
            .filter((event) => event.asset === assetPolicy.asset)
            .map((event) => amount(event.amount, "rolling debit")));
          const cumulative = amount(
            totalFor(state, assetPolicy.asset).cumulativeDebit,
            "cumulative debit",
          );
          const balance = balances.get(assetPolicy.asset) ?? null;
          const reserve = amount(assetPolicy.minimumReserve, "minimum reserve");
          const balanceHeadroom = balance === null
            ? null
            : balance > reserved + reserve ? balance - reserved - reserve : 0n;
          const rollingHeadroom = amount(
            assetPolicy.maximumRollingDebit,
            "maximum rolling debit",
          ) > rolling + reserved
            ? amount(assetPolicy.maximumRollingDebit, "maximum rolling debit") - rolling - reserved
            : 0n;
          const cumulativeHeadroom = amount(
            assetPolicy.maximumCumulativeDebit,
            "maximum cumulative debit",
          ) > cumulative + reserved
            ? amount(assetPolicy.maximumCumulativeDebit, "maximum cumulative debit") -
              cumulative - reserved
            : 0n;
          const headroom = balanceHeadroom === null
            ? null
            : [balanceHeadroom, rollingHeadroom, cumulativeHeadroom]
                .reduce((least, candidate) => candidate < least ? candidate : least);
          return Object.freeze({
            asset: assetPolicy.asset,
            maximumPerOrderDebit: assetPolicy.maximumPerOrderDebit,
            maximumNetworkFeeDebit: assetPolicy.maximumNetworkFeeDebit,
            minimumReserve: assetPolicy.minimumReserve,
            rollingWindowMs: assetPolicy.rollingWindowMs,
            maximumRollingEffects: assetPolicy.maximumRollingEffects,
            maximumRollingDebit: assetPolicy.maximumRollingDebit,
            maximumCumulativeDebit: assetPolicy.maximumCumulativeDebit,
            maximumCounterpartyDebit: assetPolicy.maximumCounterpartyDebit,
            ...(assetPolicy.operatorApprovalThreshold === undefined
              ? {}
              : { operatorApprovalThreshold: assetPolicy.operatorApprovalThreshold }),
            balance: balance?.toString() ?? null,
            reservedWorstCaseDebit: reserved.toString(),
            rollingSettledDebit: rolling.toString(),
            cumulativeSettledDebit: cumulative.toString(),
            availableHeadroom: headroom?.toString() ?? null,
          });
        });
        return Object.freeze({
            policyId: policy.policyId,
            policyHash,
            wallet: policy.wallet,
            chainId: policy.chainId,
            maximumConcurrentEffects: policy.maximumConcurrentEffects,
            activeEffects: activeRows.length,
            retainedReservations: state.reservations.length,
            maximumRetainedReservations: policy.maximumRetainedReservations,
            operatorActionReservations: Object.freeze(activeRows
              .filter((row) => (row.leaseExpiresAt ?? 0) < timestamp)
              .map(({ reservationId }) => reservationId)),
            assets: Object.freeze(assets),
          });
      };
      if (read !== undefined) {
        const timestamp = safeInteger(now(), "wallet spend clock");
        const state = captureState(await read(scope), policy, policyHash);
        state.rollingEvents = recentEvents(state, policy, timestamp);
        return project(state, timestamp);
      }
      return update((state, timestamp) => ({
        state,
        value: project(state, timestamp),
      }));
    },
  };
  return Object.freeze(authority);
}

/**
 * Reserve, fence, execute, authenticate and account one funded effect. Any
 * exception after `beginEffect` deliberately leaves durable ambiguity for
 * read-only reconciliation; this helper never guesses that payment was absent.
 */
export async function executeWalletSpendEffectV1<T>(
  input: Readonly<WalletSpendExecutionInputV1<T>>,
): Promise<WalletSpendExecutionResultV1<T>> {
  const authority = stableProperty(
    input,
    "authority",
    "wallet spend execution authority",
  ).value;
  const reserve = stableMethod<WalletSpendAuthorityV1["reserve"]>(
    authority,
    "reserve",
    "wallet spend reservation",
  );
  const reservation = stableProperty(
    input,
    "reservation",
    "wallet spend execution reservation",
  ).value as Readonly<WalletSpendReservationV1>;
  const approvalProperty = stableProperty(
    input,
    "operatorApproval",
    "wallet spend execution approval",
  );
  const approval = approvalProperty.found ? approvalProperty.value : undefined;
  if (approval !== undefined) nonEmpty(approval, "wallet spend execution approval");
  const effect = stableMethod<WalletSpendExecutionInputV1<T>["effect"]>(
    input,
    "effect",
    "wallet spend effect",
  );
  const settlement = stableMethod<WalletSpendExecutionInputV1<T>["settlement"]>(
    input,
    "settlement",
    "wallet spend settlement projection",
  );
  const claim = await reserve(
    reservation,
    approval === undefined
      ? undefined
      : { operatorApproval: approval as string },
  );
  if (claim.status !== "reserved") return claim;
  await claim.permit.beginEffect();
  await claim.permit.assertCurrent();
  const result = await effect(claim.permit);
  const observation = await settlement(result);
  await claim.permit.settle(observation);
  return Object.freeze({ status: "completed", result });
}

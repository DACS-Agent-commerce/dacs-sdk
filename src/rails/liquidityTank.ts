import { types as nodeTypes } from "node:util";

import {
  assertPositiveAmount,
  baseUnits,
  canonicalize,
  sha256Hex,
} from "../canonical/index.js";
import {
  snapshotCanonicalJson,
  snapshotCanonicalJsonRead,
} from "../canonical/snapshot.js";
import { DacsError } from "../errors.js";
import { requireCanonicalJobId } from "../negotiate/jobId.js";

const HASH_RE = /^[0-9a-f]{64}$/;
const BRIDGE_ID_RE = /^[A-Za-z0-9_-]{16}$/;
const DEFAULT_LEASE_MS = 30_000;
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
      /** Unix seconds; required exactly when a source lock is committed. */
      recoveryDeadline?: number;
    })
  | (LiquidityTankObservationBase & {
      status: "completed";
      history: readonly ["empty", "pending", "completed"];
      lockTxHash: string;
      releaseTxHash: string;
      finalityObservedAt: number;
    })
  | (LiquidityTankObservationBase & {
      status: "failed";
      history: readonly ["empty", "failed"] | readonly ["empty", "pending", "failed"];
      reason: string;
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
  }>;
  paymentAmount: Readonly<{ amount: string; currency: "USDC" }>;
  settlementFinality: Readonly<{
    model: "liquidity-tank";
    finalityObservedAt: number;
  }>;
  authenticationHash: string;
}

export type LiquidityTankStoreClaim =
  | {
      status: "acquired";
      intent: Readonly<LiquidityTankIntent>;
      lease: Readonly<LiquidityTankLease>;
      submission?: Readonly<LiquidityTankPreparedSubmission>;
      observation?: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>>;
    }
  | {
      status: "waiting";
      intent: Readonly<LiquidityTankIntent>;
      lease: Readonly<LiquidityTankLease>;
      submission?: Readonly<LiquidityTankPreparedSubmission>;
      observation?: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>>;
    }
  | {
      status: "settled";
      intent: Readonly<LiquidityTankIntent>;
      settlement: Readonly<LiquidityTankSettlement>;
    }
  | { status: "conflict" | "corrupt"; reason: string };

export type LiquidityTankStoreWrite =
  | { status: "recorded" | "existing" }
  | { status: "stale" | "conflict" | "corrupt"; reason: string };

export interface LiquidityTankStore {
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
  recordSubmission(input: {
    settlementKey: string;
    bindingHash: string;
    owner: string;
    generation: number;
    submission: Readonly<LiquidityTankPreparedSubmission>;
  }): Promise<LiquidityTankStoreWrite>;
  recordObservation(input: {
    settlementKey: string;
    bindingHash: string;
    owner: string;
    generation: number;
    observation: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>>;
  }): Promise<LiquidityTankStoreWrite>;
  recordSettlement(input: {
    settlementKey: string;
    bindingHash: string;
    owner: string;
    generation: number;
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
      reason: "tank-locked-unreleased";
      recoveryDeadline: number;
      txRef: Readonly<{
        kind: "liquidity-tank";
        bridgeId: string;
        sourceChainId: number;
        destChainId: number;
        lockTxHash: string;
        recoveryDeadline: number;
      }>;
    }
  | { status: "settled"; settlement: Readonly<LiquidityTankSettlement> };

export interface AdvanceLiquidityTankInput {
  authority: Readonly<LiquidityTankAuthority>;
  owner: string;
  store: LiquidityTankStore;
  adapter: LiquidityTankAdapter;
  now?: () => number;
  leaseDurationMs?: number;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DacsError(`pay-cross-chain-liquidity-tank: ${label} must be a non-empty string`);
  }
  return value;
}

function requireUInt(value: unknown, label: string, positive = false): number {
  if (!Number.isSafeInteger(value) || (positive ? Number(value) <= 0 : Number(value) < 0)) {
    throw new DacsError(
      `pay-cross-chain-liquidity-tank: ${label} must be a ${positive ? "positive" : "non-negative"} safe integer`,
    );
  }
  return Number(value);
}

function leaseExpiry(now: number, leaseDurationMs: number): number {
  if (now > Number.MAX_SAFE_INTEGER - leaseDurationMs) {
    throw new DacsError(
      "pay-cross-chain-liquidity-tank: lease expiry must be a safe integer",
    );
  }
  return now + leaseDurationMs;
}

function recoveryDeadlineMs(value: unknown): number {
  const seconds = requireUInt(value, "recoveryDeadline", true);
  if (seconds > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)) {
    throw new DacsError(
      "pay-cross-chain-liquidity-tank: recoveryDeadline cannot be represented in milliseconds",
    );
  }
  return seconds * 1_000;
}

function stableDataProperty(
  source: unknown,
  key: PropertyKey,
  label: string,
): unknown {
  if ((typeof source !== "object" && typeof source !== "function") ||
      source === null || nodeTypes.isProxy(source)) {
    throw new DacsError(`pay-cross-chain-liquidity-tank: ${label} must be stable data`);
  }
  try {
    let cursor: object | null = source;
    while (cursor !== null) {
      if (nodeTypes.isProxy(cursor)) throw new TypeError("proxy prototype");
      const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
      if (descriptor !== undefined) {
        if (!("value" in descriptor)) throw new TypeError("accessor property");
        return descriptor.value;
      }
      cursor = Object.getPrototypeOf(cursor) as object | null;
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
  if (typeof method !== "function" || nodeTypes.isProxy(method)) {
    throw new DacsError(
      `pay-cross-chain-liquidity-tank: ${label} must be a stable method`,
    );
  }
  return Function.prototype.bind.call(method, source) as T;
}

function successfulStoreWrite(value: unknown): boolean {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) return false;
  const status = Object.getOwnPropertyDescriptor(value, "status");
  return status !== undefined && "value" in status &&
    (status.value === "recorded" || status.value === "existing");
}

function snapshotOptionalCanonicalRead<T>(
  value: T,
  label: string,
  optionalUndefined: ReadonlySet<string>,
): T {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value) ||
        nodeTypes.isProxy(value)) {
      throw new TypeError("value is not an ordinary object");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) {
      throw new TypeError("value has an exotic prototype");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const normalized: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") throw new TypeError("value has a symbol property");
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError("properties must be enumerable data");
      }
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
    return snapshotCanonicalJsonRead(normalized, label) as T;
  } catch (cause) {
    throw new DacsError(`${label} must be stable data`, { cause });
  }
}

function snapshotStoreClaim(value: unknown): LiquidityTankStoreClaim {
  return snapshotOptionalCanonicalRead(
    value,
    "liquidity-tank store claim",
    new Set(["submission", "observation"]),
  ) as LiquidityTankStoreClaim;
}

function captureSettlement(
  value: unknown,
  intent: Readonly<LiquidityTankIntent>,
): Readonly<LiquidityTankSettlement> {
  const settlement = snapshotCanonicalJsonRead(
    value,
    "liquidity-tank stored settlement",
  ) as LiquidityTankSettlement;
  if (settlement.txRef?.kind !== "liquidity-tank" ||
      !BRIDGE_ID_RE.test(settlement.txRef.bridgeId) ||
      settlement.txRef.sourceChainId !== intent.sourceChainId ||
      settlement.txRef.destChainId !== intent.destinationChainId ||
      settlement.paymentAmount?.amount !== intent.amount ||
      settlement.paymentAmount.currency !== intent.currency ||
      settlement.settlementFinality?.model !== "liquidity-tank" ||
      !HASH_RE.test(settlement.authenticationHash)) {
    throw new DacsError("pay-cross-chain-liquidity-tank: stored settlement authority mismatch");
  }
  return Object.freeze({
    txRef: Object.freeze({
      kind: "liquidity-tank" as const,
      bridgeId: settlement.txRef.bridgeId,
      sourceChainId: settlement.txRef.sourceChainId,
      destChainId: settlement.txRef.destChainId,
      lockTxHash: requireString(settlement.txRef.lockTxHash, "stored lockTxHash"),
      releaseTxHash: requireString(settlement.txRef.releaseTxHash, "stored releaseTxHash"),
    }),
    paymentAmount: Object.freeze({ amount: intent.amount, currency: intent.currency }),
    settlementFinality: Object.freeze({
      model: "liquidity-tank" as const,
      finalityObservedAt: requireUInt(
        settlement.settlementFinality.finalityObservedAt,
        "stored finalityObservedAt",
      ),
    }),
    authenticationHash: settlement.authenticationHash,
  });
}

export function liquidityTankSettlementKey(input: {
  jobId: string;
  railId: string;
  phaseIndex: number;
}): string {
  const captured = snapshotCanonicalJson(input, "liquidity-tank settlement key authority");
  return liquidityTankSettlementKeyFromCaptured(captured);
}

function liquidityTankSettlementKeyFromCaptured(input: {
  jobId: string;
  railId: string;
  phaseIndex: number;
}): string {
  const phaseIndex = requireUInt(input.phaseIndex, "phaseIndex");
  return sha256Hex(
    `dacs-liquidity-tank:v1:${requireCanonicalJobId(input.jobId)}:` +
      `${requireString(input.railId, "railId").normalize("NFC")}:${phaseIndex}`,
  );
}

export function createLiquidityTankIntent(
  authority: Readonly<LiquidityTankAuthority>,
): Readonly<LiquidityTankIntent> {
  const captured = snapshotCanonicalJson(authority, "liquidity-tank authority");
  authority = captured;
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
  if (!HASH_RE.test(authority.railDescriptorHash) || !HASH_RE.test(authority.agreementHash) ||
      !HASH_RE.test(authority.sr5BindingHash)) {
    throw new DacsError("pay-cross-chain-liquidity-tank: authority hashes must be 32-byte lower-case hex");
  }
  const sourceTokenDecimals = requireUInt(authority.sourceTokenDecimals, "sourceTokenDecimals");
  const destinationTokenDecimals = requireUInt(
    authority.destinationTokenDecimals,
    "destinationTokenDecimals",
  );
  if (sourceTokenDecimals > 255 || destinationTokenDecimals > 255) {
    throw new DacsError("pay-cross-chain-liquidity-tank: token decimals must be unsigned bytes");
  }
  const amount = assertPositiveAmount(authority.amount);
  const operation = {
    originChainType: authority.sourceChainType,
    destinationChainType: authority.destinationChainType,
    originAddress: requireString(authority.originAddress, "originAddress"),
    destinationAddress: requireString(authority.destinationAddress, "destinationAddress"),
    originAmount: baseUnits(amount, sourceTokenDecimals),
    destinationAmount: baseUnits(amount, destinationTokenDecimals),
    originAsset: authority.sourceAsset,
    destinationAsset: authority.destinationAsset,
    sourceLiquidityTankId: requireString(authority.sourceLiquidityTankId, "sourceLiquidityTankId"),
    destinationLiquidityTankId: requireString(
      authority.destinationLiquidityTankId,
      "destinationLiquidityTankId",
    ),
  };
  if (operation.sourceLiquidityTankId === operation.destinationLiquidityTankId) {
    throw new DacsError("pay-cross-chain-liquidity-tank: source and destination tank IDs must differ");
  }
  const operationHash = sha256Hex(canonicalize(operation));
  const unsigned = {
    intentVersion: "1" as const,
    settlementKey: liquidityTankSettlementKeyFromCaptured(authority),
    operationHash,
    jobId: requireCanonicalJobId(authority.jobId),
    phaseIndex: authority.phaseIndex,
    railId: requireString(authority.railId, "railId").normalize("NFC"),
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
    sourceAmountBaseUnits: operation.originAmount,
    destinationAmountBaseUnits: operation.destinationAmount,
    amount,
    currency: authority.currency,
    originAddress: operation.originAddress,
    destinationAddress: operation.destinationAddress,
    sourceLiquidityTankId: operation.sourceLiquidityTankId,
    destinationLiquidityTankId: operation.destinationLiquidityTankId,
    supportedScope: authority.supportedScope,
  };
  return Object.freeze({ ...unsigned, bindingHash: sha256Hex(canonicalize(unsigned)) });
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
  if (value.submissionVersion !== "1" || value.authorityHash !== intent.bindingHash ||
      value.operationHash !== intent.operationHash || !BRIDGE_ID_RE.test(value.bridgeId)) {
    throw new DacsError("pay-cross-chain-liquidity-tank: prepared submission authority mismatch");
  }
  requireString(value.substrateTxHash, "substrateTxHash");
  requireUInt(value.preparedAt, "preparedAt");
  const encoded = requireString(value.signedSubmissionBase64, "signedSubmissionBase64");
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length === 0 ||
      decoded.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
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
  const { submissionHash, ...unsigned } = captured;
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
      !HASH_RE.test(value.authenticationHash)) {
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
  if (value.status === "pending") {
    if ((value.lockTxHash === undefined) !== (value.recoveryDeadline === undefined)) {
      throw new DacsError("pay-cross-chain-liquidity-tank: recovery checkpoint is incomplete");
    }
    if (value.lockTxHash !== undefined) {
      requireString(value.lockTxHash, "lockTxHash");
      recoveryDeadlineMs(value.recoveryDeadline);
    }
  }
  if (value.status === "completed") {
    requireString(value.lockTxHash, "lockTxHash");
    requireString(value.releaseTxHash, "releaseTxHash");
    requireUInt(value.finalityObservedAt, "finalityObservedAt");
  }
  if (value.status === "failed" || value.status === "capacity-unavailable") {
    requireString(value.reason, "reason");
  }
  return Object.freeze({
    ...value,
    history: Object.freeze([...value.history]),
  }) as Exclude<LiquidityTankObservation, { status: "indeterminate" }>;
}

function progressFromDurableObservation(
  intent: Readonly<LiquidityTankIntent>,
  observation: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>> | undefined,
  now: number,
): LiquidityTankProgress | null {
  if (!observation) return null;
  if (observation.status === "pending" && observation.lockTxHash && observation.recoveryDeadline) {
    if (now >= recoveryDeadlineMs(observation.recoveryDeadline)) {
      return {
        status: "failed",
        errorClass: "failed-substrate",
        reason: "tank-locked-unreleased-recovery-expired",
        reputationNeutral: true,
      };
    }
    return {
      status: "settle-asymmetric",
      reason: "tank-locked-unreleased",
      recoveryDeadline: observation.recoveryDeadline,
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
  return next.status === "completed" && next.lockTxHash === prior.lockTxHash;
}

export async function advanceLiquidityTankSettlement(
  input: Readonly<AdvanceLiquidityTankInput>,
): Promise<LiquidityTankProgress> {
  let authority: unknown;
  try {
    authority = stableDataProperty(input, "authority", "authority");
  } catch (error) {
    return {
      status: "failed",
      errorClass: "permanent",
      reason: error instanceof Error ? error.message : "liquidity-tank-authority-invalid",
    };
  }
  let intent: Readonly<LiquidityTankIntent>;
  try {
    intent = createLiquidityTankIntent(authority as LiquidityTankAuthority);
  } catch (error) {
    return {
      status: "failed",
      errorClass: "permanent",
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
  let recordSettlement: LiquidityTankStore["recordSettlement"];
  let prepareSubmission: LiquidityTankAdapter["prepareSubmission"];
  let broadcastRetained: LiquidityTankAdapter["broadcastRetained"];
  let observeSettlement: LiquidityTankAdapter["observe"];
  try {
    const ownerValue = stableDataProperty(input, "owner", "owner");
    const leaseDurationValue = stableDataProperty(
      input,
      "leaseDurationMs",
      "leaseDurationMs",
    );
    const nowValue = stableDataProperty(input, "now", "now");
    const store = stableDataProperty(input, "store", "store");
    const adapter = stableDataProperty(input, "adapter", "adapter");
    owner = requireString(ownerValue, "owner");
    leaseDurationMs = requireUInt(
      leaseDurationValue ?? DEFAULT_LEASE_MS,
      "leaseDurationMs",
      true,
    );
    const nowCandidate = nowValue ?? Date.now;
    if (typeof nowCandidate !== "function" || nodeTypes.isProxy(nowCandidate)) {
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
    return {
      status: "failed",
      errorClass: "permanent",
      reason: error instanceof Error ? error.message : "liquidity-tank-runtime-policy-invalid",
    };
  }
  const readNow = (): number => requireUInt(now(), "clock");
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
  let claimed: LiquidityTankStoreClaim;
  try {
    claimed = snapshotStoreClaim(rawClaim);
  } catch {
    return { status: "indeterminate", reason: "liquidity-tank-settlement-store-claim-invalid" };
  }
  const claimStatus: unknown = Object.hasOwn(claimed, "status") ? claimed.status : undefined;
  if (typeof claimStatus !== "string") {
    return { status: "indeterminate", reason: "liquidity-tank-settlement-store-claim-invalid" };
  }
  const requiresIntent = claimStatus === "acquired" || claimStatus === "waiting" || claimStatus === "settled";
  const hasIntent = Object.hasOwn(claimed, "intent");
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
  if (claimStatus === "waiting") {
    const waitingClaim = claimed as Extract<LiquidityTankStoreClaim, { status: "waiting" }>;
    try {
      if (!Number.isSafeInteger(waitingClaim.lease.generation) || waitingClaim.lease.generation <= 0 ||
          !Number.isSafeInteger(waitingClaim.lease.expiresAt) || waitingClaim.lease.expiresAt <= claimNow ||
          typeof waitingClaim.lease.owner !== "string" || waitingClaim.lease.owner.length === 0) {
        throw new DacsError("invalid waiting lease");
      }
    } catch {
      return { status: "indeterminate", reason: "liquidity-tank-settlement-store-lease-invalid" };
    }
    return { status: "waiting", reason: "liquidity-tank-settlement-held" };
  }
  if (claimStatus === "conflict" || claimStatus === "corrupt") {
    const failedClaim = claimed as Extract<
      LiquidityTankStoreClaim,
      { status: "conflict" | "corrupt" }
    >;
    try {
      return {
        status: "failed",
        errorClass: "permanent",
        reason: requireString(failedClaim.reason, "claim reason"),
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
    if (acquiredClaim.lease.owner !== owner ||
        !Number.isSafeInteger(acquiredClaim.lease.generation) || acquiredClaim.lease.generation <= 0 ||
        acquiredClaim.lease.expiresAt !== expectedLeaseExpiry) {
      throw new DacsError("invalid acquired lease");
    }
    lease = Object.freeze({
      owner: acquiredClaim.lease.owner,
      generation: acquiredClaim.lease.generation,
      expiresAt: acquiredClaim.lease.expiresAt,
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
  let retainedObservation:
    | Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>>
    | undefined;
  try {
    submission = acquiredClaim.submission;
    retainedObservation = acquiredClaim.observation;
  } catch {
    return { status: "indeterminate", reason: "liquidity-tank-retained-state-corrupt" };
  }
  if (retainedObservation && !submission) {
    return { status: "indeterminate", reason: "liquidity-tank-retained-state-corrupt" };
  }
  if (submission) {
    try {
      submission = validateRetainedSubmission(submission, intent);
    } catch (error) {
      return { status: "failed", errorClass: "permanent", reason: String(error) };
    }
  } else {
    try {
      await fence.assertCurrent();
      submission = validateSubmission(await prepareSubmission(intent, fence), intent);
      await fence.assertCurrent();
    } catch {
      return { status: "indeterminate", reason: "liquidity-tank-submission-preparation-unavailable" };
    }
    let stored: boolean;
    try {
      stored = successfulStoreWrite(await recordSubmission({
        settlementKey: intent.settlementKey,
        bindingHash: intent.bindingHash,
        owner: fence.owner,
        generation: fence.generation,
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
  if (retainedObservation) {
    try {
      durableObservation = validateRetainedObservation(retainedObservation, intent, submission);
    } catch {
      return { status: "indeterminate", reason: "liquidity-tank-retained-state-corrupt" };
    }
  }

  const observe = async (): Promise<Readonly<LiquidityTankObservation>> => {
    try {
      await fence.assertCurrent();
      const observed = validateObservation(
        await observeSettlement(intent, submission, fence),
        intent,
        submission,
      );
      await fence.assertCurrent();
      return observed;
    } catch {
      return { status: "indeterminate", reason: "liquidity-tank-status-unavailable" };
    }
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
        observation,
      }));
      await fence.assertCurrent();
      return stored;
    } catch {
      return false;
    }
  };
  const durableProgress = (): LiquidityTankProgress | null => {
    try {
      return progressFromDurableObservation(intent, durableObservation, readNow());
    } catch {
      return null;
    }
  };
  const finalize = async (
    observation: Readonly<LiquidityTankObservation>,
  ): Promise<LiquidityTankProgress | null> => {
    if (observation.status === "indeterminate") {
      return durableProgress() ?? {
        status: "indeterminate",
        reason: observation.reason,
      };
    }
    if (durableObservation &&
        !preservesRecoveryCheckpoint(durableObservation, observation)) {
      return durableProgress() ?? {
        status: "indeterminate",
        reason: "liquidity-tank-recovery-checkpoint-conflict",
      };
    }
    if (!await persistObservation(observation)) {
      return durableProgress() ?? {
        status: "indeterminate",
        reason: "liquidity-tank-observation-persistence-uncertain",
      };
    }
    if (observation.status === "capacity-unavailable") {
      return { status: "waiting", reason: "liquidity-tank-capacity-unavailable" };
    }
    if (observation.status === "failed") {
      return { status: "failed", errorClass: "permanent", reason: observation.reason };
    }
    if (observation.status === "pending") {
      let durablePending: LiquidityTankProgress | null = null;
      try {
        durablePending = progressFromDurableObservation(intent, observation, readNow());
      } catch {
        return { status: "indeterminate", reason: "liquidity-tank-clock-invalid" };
      }
      return durablePending ?? {
        status: "waiting",
        reason: "liquidity-tank-pending",
      };
    }
    if (observation.status === "completed") {
      const settlement = Object.freeze({
        txRef: Object.freeze({
          kind: "liquidity-tank" as const,
          bridgeId: observation.bridgeId,
          sourceChainId: intent.sourceChainId,
          destChainId: intent.destinationChainId,
          lockTxHash: observation.lockTxHash,
          releaseTxHash: observation.releaseTxHash,
        }),
        paymentAmount: Object.freeze({ amount: intent.amount, currency: intent.currency }),
        settlementFinality: Object.freeze({
          model: "liquidity-tank" as const,
          finalityObservedAt: observation.finalityObservedAt,
        }),
        authenticationHash: observation.authenticationHash,
      });
      let stored: boolean;
      try {
        stored = successfulStoreWrite(await recordSettlement({
          settlementKey: intent.settlementKey,
          bindingHash: intent.bindingHash,
          owner: fence.owner,
          generation: fence.generation,
          settlement,
        }));
      } catch {
        return { status: "indeterminate", reason: "liquidity-tank-settlement-persistence-uncertain" };
      }
      return stored
        ? { status: "settled", settlement }
        : { status: "indeterminate", reason: "liquidity-tank-settlement-persistence-uncertain" };
    }
    return null;
  };

  let observation = await observe();
  const terminal = await finalize(observation);
  if (terminal) return terminal;
  try {
    await fence.assertCurrent();
    await broadcastRetained(submission, fence);
    await fence.assertCurrent();
  } catch {
    return durableProgress() ?? {
      status: "indeterminate",
      reason: "liquidity-tank-broadcast-outcome-uncertain",
    };
  }
  observation = await observe();
  return await finalize(observation) ?? {
    status: "indeterminate",
    reason: "liquidity-tank-status-transition-unresolved",
  };
}

interface MemoryTankRecord {
  intent: Readonly<LiquidityTankIntent>;
  lease: LiquidityTankLease;
  submission?: Readonly<LiquidityTankPreparedSubmission>;
  observation?: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>>;
  settlement?: Readonly<LiquidityTankSettlement>;
}

function observationRank(status: Exclude<LiquidityTankObservation, { status: "indeterminate" }>["status"]): number {
  if (status === "empty" || status === "capacity-unavailable") return 0;
  if (status === "pending") return 1;
  return 2;
}

/** Test/development store. Production callers must use authenticated durable state. */
export function createInMemoryLiquidityTankStore(): LiquidityTankStore {
  const records = new Map<string, MemoryTankRecord>();
  const bridgeOwners = new Map<string, string>();
  const current = (
    record: MemoryTankRecord | undefined,
    input: { bindingHash: string; owner: string; generation: number },
  ): record is MemoryTankRecord => record !== undefined &&
    record.intent.bindingHash === input.bindingHash && record.lease.owner === input.owner &&
    record.lease.generation === input.generation;
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
        if (existing.lease.expiresAt > input.now) {
          return {
            status: "waiting",
            intent: existing.intent,
            lease: { ...existing.lease },
            submission: existing.submission,
            observation: existing.observation,
          };
        }
        const generation = existing.lease.generation + 1;
        if (!Number.isSafeInteger(generation)) {
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
          submission: existing.submission,
          observation: existing.observation,
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
      return current(record, input) && record.lease.expiresAt > input.now && !record.settlement;
    },
    async recordSubmission(input) {
      const record = records.get(input.settlementKey);
      if (!current(record, input)) return { status: "stale", reason: "stale-lease" };
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
      bridgeOwners.set(input.submission.bridgeId, input.settlementKey);
      return { status: "recorded" };
    },
    async recordObservation(input) {
      const record = records.get(input.settlementKey);
      if (!current(record, input)) return { status: "stale", reason: "stale-lease" };
      if (!record.submission || input.observation.bridgeId !== record.submission.bridgeId) {
        return { status: "conflict", reason: "liquidity-tank-observation-bridge-conflict" };
      }
      const prior = record.observation;
      if (prior) {
        if (canonicalize(prior) === canonicalize(input.observation)) return { status: "existing" };
        if (!preservesRecoveryCheckpoint(prior, input.observation) ||
            observationRank(input.observation.status) < observationRank(prior.status)) {
          return { status: "conflict", reason: "liquidity-tank-status-regression" };
        }
        if (observationRank(input.observation.status) === observationRank(prior.status) &&
            input.observation.status !== "pending" &&
            !(["empty", "capacity-unavailable"].includes(prior.status) &&
              ["empty", "capacity-unavailable"].includes(input.observation.status))) {
          return { status: "conflict", reason: "liquidity-tank-terminal-status-conflict" };
        }
      }
      record.observation = Object.freeze({ ...input.observation });
      return { status: "recorded" };
    },
    async recordSettlement(input) {
      const record = records.get(input.settlementKey);
      if (!current(record, input)) return { status: "stale", reason: "stale-lease" };
      if (record.observation?.status !== "completed") {
        return { status: "conflict", reason: "liquidity-tank-settlement-before-completion" };
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

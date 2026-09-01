import {
  assertPositiveAmount,
  baseUnits,
  canonicalize,
  sha256Hex,
} from "../canonical/index.js";
import { DacsError } from "../errors.js";

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

export function liquidityTankSettlementKey(input: {
  jobId: string;
  railId: string;
  phaseIndex: number;
}): string {
  const phaseIndex = requireUInt(input.phaseIndex, "phaseIndex");
  return sha256Hex(
    `dacs-liquidity-tank:v1:${requireString(input.jobId, "jobId").normalize("NFC")}:` +
      `${requireString(input.railId, "railId").normalize("NFC")}:${phaseIndex}`,
  );
}

export function createLiquidityTankIntent(
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
    settlementKey: liquidityTankSettlementKey(authority),
    operationHash,
    jobId: requireString(authority.jobId, "jobId").normalize("NFC"),
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

function validateObservation(
  value: Readonly<LiquidityTankObservation>,
  intent: Readonly<LiquidityTankIntent>,
  submission: Readonly<LiquidityTankPreparedSubmission>,
): Exclude<LiquidityTankObservation, { status: "indeterminate" }> | LiquidityTankObservation {
  if (value.status === "indeterminate") return value;
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
      requireUInt(value.recoveryDeadline, "recoveryDeadline", true);
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
  return value;
}

function progressFromDurableObservation(
  intent: Readonly<LiquidityTankIntent>,
  observation: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>> | undefined,
  now: number,
): LiquidityTankProgress | null {
  if (!observation) return null;
  if (observation.status === "pending" && observation.lockTxHash && observation.recoveryDeadline) {
    if (now >= observation.recoveryDeadline * 1_000) {
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

export async function advanceLiquidityTankSettlement(
  input: Readonly<AdvanceLiquidityTankInput>,
): Promise<LiquidityTankProgress> {
  let intent: Readonly<LiquidityTankIntent>;
  try {
    intent = createLiquidityTankIntent(input.authority);
  } catch (error) {
    return {
      status: "failed",
      errorClass: "permanent",
      reason: error instanceof Error ? error.message : "liquidity-tank-authority-invalid",
    };
  }
  const now = input.now ?? Date.now;
  let owner: string;
  try {
    owner = requireString(input.owner, "owner");
  } catch (error) {
    return { status: "failed", errorClass: "permanent", reason: String(error) };
  }
  const claimed = await input.store.claim({
    intent,
    owner,
    now: now(),
    leaseDurationMs: input.leaseDurationMs ?? DEFAULT_LEASE_MS,
  });
  if (claimed.status === "waiting") return { status: "waiting", reason: "liquidity-tank-settlement-held" };
  if (claimed.status === "settled") return { status: "settled", settlement: claimed.settlement };
  if (claimed.status !== "acquired") {
    return { status: "failed", errorClass: "permanent", reason: claimed.reason };
  }
  const fence: Readonly<LiquidityTankEffectFence> = Object.freeze({
    settlementKey: intent.settlementKey,
    bindingHash: intent.bindingHash,
    owner: claimed.lease.owner,
    generation: claimed.lease.generation,
    assertCurrent: async () => {
      if (!await input.store.isCurrent({
        settlementKey: intent.settlementKey,
        bindingHash: intent.bindingHash,
        owner: claimed.lease.owner,
        generation: claimed.lease.generation,
        now: now(),
      })) throw new DacsError("pay-cross-chain-liquidity-tank: stale effect fence");
    },
  });
  let submission = claimed.submission;
  if (submission) {
    try {
      const { submissionHash, ...unsigned } = submission;
      const validated = validateSubmission(unsigned, intent);
      if (validated.submissionHash !== submissionHash) {
        throw new DacsError("pay-cross-chain-liquidity-tank: retained submission integrity mismatch");
      }
      submission = validated;
    } catch (error) {
      return { status: "failed", errorClass: "permanent", reason: String(error) };
    }
  } else {
    try {
      await fence.assertCurrent();
      submission = validateSubmission(await input.adapter.prepareSubmission(intent, fence), intent);
    } catch {
      return { status: "indeterminate", reason: "liquidity-tank-submission-preparation-unavailable" };
    }
    const stored = await input.store.recordSubmission({
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      owner: fence.owner,
      generation: fence.generation,
      submission,
    });
    if (stored.status !== "recorded" && stored.status !== "existing") {
      return { status: "indeterminate", reason: "liquidity-tank-submission-persistence-uncertain" };
    }
  }

  const observe = async (): Promise<Readonly<LiquidityTankObservation>> => {
    try {
      await fence.assertCurrent();
      return validateObservation(await input.adapter.observe(intent, submission, fence), intent, submission);
    } catch {
      return { status: "indeterminate", reason: "liquidity-tank-status-unavailable" };
    }
  };
  const persistObservation = async (
    observation: Readonly<Exclude<LiquidityTankObservation, { status: "indeterminate" }>>,
  ): Promise<boolean> => {
    const stored = await input.store.recordObservation({
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      owner: fence.owner,
      generation: fence.generation,
      observation,
    });
    return stored.status === "recorded" || stored.status === "existing";
  };
  const finalize = async (
    observation: Readonly<LiquidityTankObservation>,
  ): Promise<LiquidityTankProgress | null> => {
    if (observation.status === "indeterminate") {
      return progressFromDurableObservation(intent, claimed.observation, now()) ?? {
        status: "indeterminate",
        reason: observation.reason,
      };
    }
    if (!await persistObservation(observation)) {
      return progressFromDurableObservation(intent, claimed.observation, now()) ?? {
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
      return progressFromDurableObservation(intent, observation, now()) ?? {
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
      const stored = await input.store.recordSettlement({
        settlementKey: intent.settlementKey,
        bindingHash: intent.bindingHash,
        owner: fence.owner,
        generation: fence.generation,
        settlement,
      });
      return stored.status === "recorded" || stored.status === "existing"
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
    await input.adapter.broadcastRetained(submission, fence);
  } catch {
    return progressFromDurableObservation(intent, claimed.observation, now()) ?? {
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
        existing.lease = {
          owner: input.owner,
          generation: existing.lease.generation + 1,
          expiresAt: input.now + input.leaseDurationMs,
        };
        return {
          status: "acquired",
          intent: existing.intent,
          lease: { ...existing.lease },
          submission: existing.submission,
          observation: existing.observation,
        };
      }
      const record: MemoryTankRecord = {
        intent: input.intent,
        lease: { owner: input.owner, generation: 1, expiresAt: input.now + input.leaseDurationMs },
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
        if (observationRank(input.observation.status) < observationRank(prior.status) ||
            (prior.status === "pending" && prior.lockTxHash &&
             ((input.observation.status === "pending" && !input.observation.lockTxHash) ||
              input.observation.status === "failed"))) {
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

import {
  settlementKey,
  type PayDemPreparedTransfer,
  type PayDemRail,
  type PayDemReconciledSettlement,
  type PayDemSettlementRecoveryContext,
  type SettleResult,
} from "@kynesyslabs/dacs";
import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import type {
  FixedPricePayDemOrderInput,
  FixedPricePayDemOrderRecord,
  FixedPricePayDemTrackOperation,
  FixedPricePayDemTrackOperationInput,
} from "@kynesyslabs/dacs/commerce";

import {
  createDacsLiveEffectTrackV1,
  type DacsLiveEffectExecutionControlV1,
  type DacsLiveEffectFenceV1,
  type DacsLiveEffectReconciliationV1,
} from "./liveEffects.js";
import {
  loadDacsLiveOrderInputForTrackV1,
  type DacsLiveOrderInputV1,
} from "./orderInput.js";
import type { DacsNodeSqliteDatabase } from "./sqlite.js";

const HASH_RE = /^[0-9a-f]{64}$/;
const ADDRESS_RE = /^(?:0[xX])?([0-9a-fA-F]{64})$/;
const INTEGER_RE = /^[1-9][0-9]*$/;
const PREPARED_CHECKPOINT = "pay-dem-prepared-transfer";

export interface DacsPayDemBuyerPaymentAuthorityV1 {
  authorityVersion: "1";
  jobId: string;
  phaseIndex: number;
  railId: string;
  railVersion: number;
  railDescriptorHash: string;
  network: "demos";
  payer: string;
  payee: string;
  amountOs: string;
  maxTotalDebitOs: string;
  agreementHash: string;
  termsHash: string;
  payoutBindingHash: string;
}

export interface DacsPayDemBuyerPaymentInputV1
  extends DacsPayDemBuyerPaymentAuthorityV1 {
  paymentInputVersion: "1";
  orderBindingHash: string;
  orderLocalBindingHash: string;
  settlementKey: string;
}

export interface DacsPayDemBuyerPaymentResultV1 {
  paymentResultVersion: "1";
  settlement: Readonly<SettleResult>;
}

/**
 * Authenticated operational handoff from the native DEM buyer to the seller.
 * The seller treats every field except the transaction hash as an asserted
 * binding and independently reconstructs the finalized transfer from Demos.
 */
export interface DacsPayDemPaymentNoticeV1 {
  paymentNoticeVersion: "1";
  payment: Readonly<DacsPayDemBuyerPaymentInputV1>;
  settlement: Readonly<SettleResult>;
}

export type DacsPayDemBuyerChainReconciliationV1 = Readonly<
  | {
      status: "completed";
      settlement: Readonly<PayDemReconciledSettlement>;
    }
  | { status: "absent"; absenceProofHash: string }
  | { status: "indeterminate"; reasonCode: string; retryAt?: number }
  | { status: "operator-action"; reasonCode: string }
>;

export interface DacsPayDemBuyerPaymentTrackOptionsV1 {
  database: DacsNodeSqliteDatabase;
  workerId: string;
  rail: Readonly<PayDemRail>;
  resolveAuthority(input: Readonly<{
    operation: Readonly<FixedPricePayDemTrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1<FixedPricePayDemOrderInput>>;
  }>): Promise<Readonly<DacsPayDemBuyerPaymentAuthorityV1>> |
    Readonly<DacsPayDemBuyerPaymentAuthorityV1>;
  reconcile(input: Readonly<{
    payment: Readonly<DacsPayDemBuyerPaymentInputV1>;
    prepared?: Readonly<PayDemPreparedTransfer>;
    fence: Readonly<DacsLiveEffectFenceV1>;
  }>): Promise<DacsPayDemBuyerChainReconciliationV1> |
    DacsPayDemBuyerChainReconciliationV1;
  /**
   * Durably queue the authenticated seller notice. Returning means the notice
   * can survive process loss; a peer acknowledgement is not required here.
   */
  publishNotice(input: Readonly<{
    notice: Readonly<DacsPayDemPaymentNoticeV1>;
    fence: Readonly<DacsLiveEffectFenceV1>;
  }>): Promise<void> | void;
  effectLeaseDurationMs?: number;
  retryDelayMs?: number;
}

export class DacsPayDemBuyerPaymentError extends Error {
  override readonly name = "DacsPayDemBuyerPaymentError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return (prototype === Object.prototype || prototype === null) &&
      Reflect.ownKeys(value).every((key) => {
        if (typeof key !== "string") return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
      });
  } catch {
    return false;
  }
}

function canonicalAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.match(ADDRESS_RE)?.[1]?.toLowerCase() ?? null;
}

function text(value: unknown, maximum = 4_096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value.trim() === value && !value.includes("\0");
}

function safeReason(value: unknown): value is string {
  return typeof value === "string" &&
    /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(value);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function captureAuthority(
  value: unknown,
  operation: Readonly<FixedPricePayDemTrackOperationInput>,
  rail: Readonly<PayDemRail>,
): Readonly<DacsPayDemBuyerPaymentAuthorityV1> {
  if (!plainObject(value) || !exactKeys(value, [
    "authorityVersion", "jobId", "phaseIndex", "railId", "railVersion",
    "railDescriptorHash", "network", "payer", "payee", "amountOs",
    "maxTotalDebitOs", "agreementHash", "termsHash", "payoutBindingHash",
  ]) || value.authorityVersion !== "1" || value.jobId !== operation.order.jobId ||
      !Number.isSafeInteger(value.phaseIndex) || (value.phaseIndex as number) < 0 ||
      value.railId !== operation.order.protocol.rail.railId ||
      value.railVersion !== operation.order.protocol.rail.railVersion ||
      value.railDescriptorHash !== operation.order.protocol.rail.railDefinitionHash ||
      value.network !== "demos" ||
      typeof value.amountOs !== "string" || !INTEGER_RE.test(value.amountOs) ||
      typeof value.maxTotalDebitOs !== "string" ||
      !INTEGER_RE.test(value.maxTotalDebitOs) ||
      BigInt(value.maxTotalDebitOs) < BigInt(value.amountOs) ||
      typeof value.agreementHash !== "string" || !HASH_RE.test(value.agreementHash) ||
      typeof value.termsHash !== "string" || !HASH_RE.test(value.termsHash) ||
      typeof value.payoutBindingHash !== "string" ||
      !HASH_RE.test(value.payoutBindingHash)) {
    throw new DacsPayDemBuyerPaymentError("pay-dem-payment-authority-invalid");
  }
  const payer = canonicalAddress(value.payer);
  const railPayer = canonicalAddress(rail.address);
  const payee = canonicalAddress(value.payee);
  if (payer === null || payee === null || payer !== railPayer) {
    throw new DacsPayDemBuyerPaymentError("pay-dem-payment-authority-invalid");
  }
  return Object.freeze({
    authorityVersion: "1",
    jobId: value.jobId as string,
    phaseIndex: value.phaseIndex as number,
    railId: value.railId as string,
    railVersion: value.railVersion as number,
    railDescriptorHash: value.railDescriptorHash as string,
    network: "demos",
    payer,
    payee,
    amountOs: value.amountOs,
    maxTotalDebitOs: value.maxTotalDebitOs,
    agreementHash: value.agreementHash,
    termsHash: value.termsHash,
    payoutBindingHash: value.payoutBindingHash,
  });
}

function capturePaymentInput(value: unknown): Readonly<DacsPayDemBuyerPaymentInputV1> {
  if (!plainObject(value) || !exactKeys(value, [
    "authorityVersion", "jobId", "phaseIndex", "railId", "railVersion",
    "railDescriptorHash", "network", "payer", "payee", "amountOs",
    "maxTotalDebitOs", "agreementHash", "termsHash", "payoutBindingHash",
    "paymentInputVersion", "orderBindingHash", "orderLocalBindingHash",
    "settlementKey",
  ]) || value.authorityVersion !== "1" || value.paymentInputVersion !== "1" ||
      typeof value.jobId !== "string" || !Number.isSafeInteger(value.phaseIndex) ||
      (value.phaseIndex as number) < 0 || !text(value.railId) ||
      !Number.isSafeInteger(value.railVersion) || (value.railVersion as number) <= 0 ||
      typeof value.railDescriptorHash !== "string" ||
      !HASH_RE.test(value.railDescriptorHash) || value.network !== "demos" ||
      canonicalAddress(value.payer) !== value.payer ||
      canonicalAddress(value.payee) !== value.payee ||
      typeof value.amountOs !== "string" || !INTEGER_RE.test(value.amountOs) ||
      typeof value.maxTotalDebitOs !== "string" ||
      !INTEGER_RE.test(value.maxTotalDebitOs) ||
      BigInt(value.maxTotalDebitOs) < BigInt(value.amountOs) ||
      [value.agreementHash, value.termsHash, value.payoutBindingHash,
        value.orderBindingHash, value.orderLocalBindingHash]
        .some((hash) => typeof hash !== "string" || !HASH_RE.test(hash)) ||
      value.settlementKey !== settlementKey(
        value.railId,
        value.jobId,
        value.phaseIndex as number,
      )) {
    throw new DacsPayDemBuyerPaymentError("pay-dem-payment-input-invalid");
  }
  return Object.freeze(JSON.parse(canonicalize(value)) as DacsPayDemBuyerPaymentInputV1);
}

function recoveryContext(
  input: Readonly<DacsPayDemBuyerPaymentInputV1>,
): Readonly<PayDemSettlementRecoveryContext> {
  return Object.freeze({
    railId: input.railId,
    jobId: input.jobId,
    phaseIndex: input.phaseIndex,
    settlementKey: input.settlementKey,
    network: input.network,
    payer: input.payer,
    payee: input.payee,
    amountOs: input.amountOs,
  });
}

function capturePrepared(
  value: unknown,
  payment: Readonly<DacsPayDemBuyerPaymentInputV1>,
): Readonly<PayDemPreparedTransfer> {
  if (!plainObject(value) || !exactKeys(value, [
    "txHash", "nonce", "payer", "payee", "amountOs", "network",
    "maxTotalDebitOs", "recovery",
  ], ["denomination"]) || typeof value.txHash !== "string" ||
      !HASH_RE.test(value.txHash) ||
      !Number.isSafeInteger(value.nonce) || (value.nonce as number) < 0 ||
      value.payer !== payment.payer || value.payee !== payment.payee ||
      value.amountOs !== payment.amountOs ||
      (value.denomination !== undefined && value.denomination !== "os" &&
        value.denomination !== "dem") ||
      value.network !== payment.network ||
      value.maxTotalDebitOs !== payment.maxTotalDebitOs ||
      canonicalize(value.recovery) !== canonicalize(recoveryContext(payment))) {
    throw new DacsPayDemBuyerPaymentError("pay-dem-prepared-transfer-invalid");
  }
  return Object.freeze(JSON.parse(canonicalize(value)) as PayDemPreparedTransfer);
}

function captureSettlement(
  value: unknown,
  payment: Readonly<DacsPayDemBuyerPaymentInputV1>,
): Readonly<SettleResult> {
  if (!plainObject(value) || !exactKeys(value, [
    "ok", "txHash", "chainId", "payer", "payee", "finality",
    "blockNumber", "txRefKind",
  ]) || value.ok !== true || typeof value.txHash !== "string" ||
      !HASH_RE.test(value.txHash) || value.chainId !== payment.network ||
      canonicalAddress(value.payer) !== payment.payer ||
      canonicalAddress(value.payee) !== payment.payee ||
      !plainObject(value.finality) || !exactKeys(value.finality, ["model"]) ||
      value.finality.model !== "bft-final" ||
      !Number.isSafeInteger(value.blockNumber) || (value.blockNumber as number) < 0 ||
      value.txRefKind !== "demos") {
    throw new DacsPayDemBuyerPaymentError("pay-dem-settlement-invalid");
  }
  return Object.freeze(JSON.parse(canonicalize({
    ...value,
    payer: payment.payer,
    payee: payment.payee,
  })) as SettleResult);
}

function result(settlement: Readonly<SettleResult>): DacsPayDemBuyerPaymentResultV1 {
  return Object.freeze({ paymentResultVersion: "1", settlement });
}

export function createDacsPayDemPaymentNoticeV1(
  payment: Readonly<DacsPayDemBuyerPaymentInputV1>,
  settlement: Readonly<SettleResult>,
): Readonly<DacsPayDemPaymentNoticeV1> {
  const capturedPayment = capturePaymentInput(payment);
  const capturedSettlement = captureSettlement(settlement, capturedPayment);
  return Object.freeze({
    paymentNoticeVersion: "1",
    payment: capturedPayment,
    settlement: capturedSettlement,
  });
}

export function isDacsPayDemPaymentNoticeV1(
  value: unknown,
): value is Readonly<DacsPayDemPaymentNoticeV1> {
  if (!plainObject(value) || !exactKeys(value, [
    "paymentNoticeVersion", "payment", "settlement",
  ]) || value.paymentNoticeVersion !== "1") return false;
  try {
    createDacsPayDemPaymentNoticeV1(
      value.payment as DacsPayDemBuyerPaymentInputV1,
      value.settlement as SettleResult,
    );
    return true;
  } catch {
    return false;
  }
}

function control(reasonCode: string): DacsLiveEffectExecutionControlV1 {
  return Object.freeze({
    effectControlVersion: "1",
    status: "indeterminate",
    reasonCode,
  });
}

function buyerPaymentEffectId(
  order: Readonly<FixedPricePayDemOrderRecord>,
): string {
  return sha256Hex(canonicalize({
    localBindingHash: order.localBindingHash,
    role: "buyer",
    track: "payment",
    roleLocalJob: order.sdkJobs.payment,
  }));
}

/** Read the exact completed native payment and its retained authority. */
export function loadDacsPayDemBuyerPaymentForOrderV1(
  context: Readonly<{
    role: "buyer" | "seller";
    authority: string;
    peerAuthority: string;
    database: DacsNodeSqliteDatabase;
  }>,
  order: Readonly<FixedPricePayDemOrderRecord>,
): Readonly<{
  payment: Readonly<DacsPayDemBuyerPaymentInputV1>;
  result: Readonly<DacsPayDemBuyerPaymentResultV1>;
}> {
  if (context.role !== "buyer" || order.role !== "buyer" ||
      order.buyer !== context.authority || order.seller !== context.peerAuthority ||
      order.protocol.phase !== "pay-dem") {
    throw new DacsPayDemBuyerPaymentError("pay-dem-buyer-payment-order-mismatch");
  }
  const effectId = buyerPaymentEffectId(order);
  const effect = context.database.loadEffect("payment", effectId);
  const rawInput = context.database.loadEffectInput("payment", effectId);
  if (effect === undefined || effect.state !== "completed" ||
      effect.bindingHash !== order.localBindingHash || effect.result === undefined ||
      rawInput === undefined) {
    throw new DacsPayDemBuyerPaymentError("pay-dem-buyer-payment-result-pending");
  }
  const payment = capturePaymentInput(rawInput);
  const rawResult = effect.result;
  if (!plainObject(rawResult) || !exactKeys(rawResult, [
    "paymentResultVersion", "settlement",
  ]) || rawResult.paymentResultVersion !== "1") {
    throw new DacsPayDemBuyerPaymentError("pay-dem-buyer-payment-result-invalid");
  }
  const settlement = captureSettlement(rawResult.settlement, payment);
  if (payment.jobId !== order.jobId ||
      payment.orderBindingHash !== order.bindingHash ||
      payment.orderLocalBindingHash !== order.localBindingHash ||
      payment.railId !== order.protocol.rail.railId ||
      payment.railVersion !== order.protocol.rail.railVersion) {
    throw new DacsPayDemBuyerPaymentError("pay-dem-buyer-payment-result-corrupt");
  }
  return Object.freeze({ payment, result: result(settlement) });
}

function captureChainReconciliation(
  value: unknown,
  payment: Readonly<DacsPayDemBuyerPaymentInputV1>,
): Readonly<DacsLiveEffectReconciliationV1<DacsPayDemBuyerPaymentResultV1>> {
  if (!plainObject(value) || typeof value.status !== "string") {
    throw new DacsPayDemBuyerPaymentError("pay-dem-reconciliation-invalid");
  }
  if (value.status === "completed" && exactKeys(value, ["status", "settlement"])) {
    const raw = value.settlement;
    if (!plainObject(raw) || raw.amountOs !== payment.amountOs) {
      throw new DacsPayDemBuyerPaymentError("pay-dem-reconciliation-invalid");
    }
    const settlement = { ...raw };
    delete settlement.amountOs;
    return Object.freeze({
      status: "completed",
      result: result(captureSettlement(settlement, payment)),
    });
  }
  if (value.status === "absent" && exactKeys(value, ["status", "absenceProofHash"]) &&
      typeof value.absenceProofHash === "string" && HASH_RE.test(value.absenceProofHash)) {
    return Object.freeze({ status: "absent", absenceProofHash: value.absenceProofHash });
  }
  if (value.status === "indeterminate" &&
      exactKeys(value, ["status", "reasonCode"], ["retryAt"]) &&
      safeReason(value.reasonCode) && (value.retryAt === undefined ||
        (Number.isSafeInteger(value.retryAt) && (value.retryAt as number) >= 0))) {
    return Object.freeze({
      status: "indeterminate",
      reasonCode: value.reasonCode,
      ...(value.retryAt === undefined ? {} : { retryAt: value.retryAt as number }),
    });
  }
  if (value.status === "operator-action" &&
      exactKeys(value, ["status", "reasonCode"]) && safeReason(value.reasonCode)) {
    return Object.freeze({ status: "operator-action", reasonCode: value.reasonCode });
  }
  throw new DacsPayDemBuyerPaymentError("pay-dem-reconciliation-invalid");
}

/**
 * Compose native DEM settlement into the buyer coordinator. The SQLite outer
 * effect is the sole execution grant; the signed hash/nonce checkpoint commits
 * before broadcast, and every ambiguous restart enters read-only reconciliation.
 */
export function createDacsPayDemBuyerPaymentTrackV1(
  options: Readonly<DacsPayDemBuyerPaymentTrackOptionsV1>,
): FixedPricePayDemTrackOperation {
  if (!plainObject(options) || !text(options.workerId) ||
      !plainObject(options.rail) || typeof options.rail.settle !== "function" ||
      canonicalAddress(options.rail.address) === null ||
      typeof options.resolveAuthority !== "function" ||
      typeof options.reconcile !== "function" ||
      typeof options.publishNotice !== "function" ||
      options.database.metadata.mode !== "live-demos" ||
      options.database.metadata.role !== "buyer") {
    throw new TypeError("pay-dem buyer payment track options are invalid");
  }
  const database = options.database;
  const rail = options.rail;

  return createDacsLiveEffectTrackV1<
    DacsPayDemBuyerPaymentInputV1,
    DacsPayDemBuyerPaymentResultV1,
    FixedPricePayDemTrackOperationInput
  >({
    database,
    kind: "payment",
    role: "buyer",
    track: "payment",
    workerId: options.workerId,
    async buildInput(operation) {
      const retained = loadDacsLiveOrderInputForTrackV1(operation, database);
      const authority = captureAuthority(
        await options.resolveAuthority({ operation, retained }),
        operation,
        rail,
      );
      return capturePaymentInput({
        ...authority,
        paymentInputVersion: "1",
        orderBindingHash: operation.order.bindingHash,
        orderLocalBindingHash: operation.order.localBindingHash,
        settlementKey: settlementKey(
          authority.railId,
          authority.jobId,
          authority.phaseIndex,
        ),
      });
    },
    adapter: {
      async execute({ input, fence }) {
        const payment = capturePaymentInput(input);
        await fence.assertCurrent();
        let settlement: Readonly<SettleResult>;
        try {
          const raw = await rail.settle({
            recipient: payment.payee,
            amount: payment.amountOs,
            maxTotalDebitOs: payment.maxTotalDebitOs,
            network: payment.network,
            recovery: recoveryContext(payment),
            journalPreparedTransfer: async (prepared) => {
              const captured = capturePrepared(prepared, payment);
              await fence.checkpoint(PREPARED_CHECKPOINT, captured);
            },
            assertCurrentBeforeBroadcast: () => fence.assertCurrent(),
          });
          settlement = captureSettlement(raw, payment);
          await options.publishNotice({
            notice: createDacsPayDemPaymentNoticeV1(payment, settlement),
            fence,
          });
        } catch {
          return control("pay-dem-settlement-ambiguous");
        }
        return result(settlement);
      },
      async reconcile({ input, fence }) {
        const payment = capturePaymentInput(input);
        const checkpoint = database.loadEffectCheckpoint(
          "payment",
          fence.effectId,
          PREPARED_CHECKPOINT,
        );
        let prepared: Readonly<PayDemPreparedTransfer> | undefined;
        if (checkpoint !== undefined) {
          prepared = capturePrepared(checkpoint.value, payment);
        }
        const reconciled = await options.reconcile({
          payment,
          ...(prepared === undefined ? {} : { prepared }),
          fence,
        });
        const captured = captureChainReconciliation(reconciled, payment);
        if (captured.status === "completed") {
          try {
            await options.publishNotice({
              notice: createDacsPayDemPaymentNoticeV1(
                payment,
                captured.result.settlement,
              ),
              fence,
            });
          } catch {
            return Object.freeze({
              status: "indeterminate" as const,
              reasonCode: "pay-dem-payment-notice-pending",
            });
          }
        }
        return captured;
      },
    },
    projectResult(value) {
      const settlement = value.settlement;
      if (value.paymentResultVersion !== "1" || !plainObject(settlement) ||
          settlement.ok !== true || !HASH_RE.test(settlement.txHash) ||
          settlement.chainId !== "demos" ||
          canonicalAddress(settlement.payer) === null ||
          canonicalAddress(settlement.payee) === null ||
          !plainObject(settlement.finality) ||
          settlement.finality.model !== "bft-final" ||
          !Number.isSafeInteger(settlement.blockNumber) ||
          (settlement.blockNumber as number) < 0 ||
          settlement.txRefKind !== "demos") {
        throw new DacsPayDemBuyerPaymentError("pay-dem-payment-result-invalid");
      }
      return {
        reference: `demos:${settlement.txHash}:${settlement.blockNumber}`,
        authenticationHash: settlement.txHash,
      };
    },
    ...(options.effectLeaseDurationMs === undefined
      ? {}
      : { leaseDurationMs: options.effectLeaseDurationMs }),
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
  });
}

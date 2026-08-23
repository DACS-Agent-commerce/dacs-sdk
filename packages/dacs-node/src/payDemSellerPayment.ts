import { baseUnits, canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import type {
  FixedPricePayDemOrderInput,
  FixedPricePayDemOrderRecord,
  FixedPricePayDemTrackOperation,
  FixedPricePayDemTrackOperationInput,
} from "@kynesyslabs/dacs/commerce";
import { parseCanonicalClaimReference } from "@kynesyslabs/dacs/identity";
import {
  verifySellerPaymentIntake,
  type SellerPaymentAuthorization,
  type SellerPaymentIntakeDeps,
  type SellerPaymentIntakeResult,
} from "@kynesyslabs/dacs/seller";

import {
  createDacsLiveEffectTrackV1,
  DacsLiveEffectInputControlError,
  type DacsLiveEffectExecutionControlV1,
  type DacsLiveEffectReconciliationV1,
} from "./liveEffects.js";
import {
  loadDacsLiveOrderInputForTrackV1,
  type DacsLiveOrderInputV1,
} from "./orderInput.js";
import { isDacsPayDemPaymentNoticeV1 } from "./payDemPayment.js";
import {
  captureDacsRetainedPayDemPaymentNoticeV1,
  type DacsRetainedPayDemPaymentNoticeV1,
} from "./payDemPaymentNoticeRuntime.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";
import type { DacsNodeSqliteDatabase } from "./sqlite.js";

const HASH_RE = /^[0-9a-f]{64}$/;
const REASON_CODE_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const DEMOS_AGENT_IDENTIFIER_RE = /^demos:agent:([0-9a-f]{64})$/;

export type DacsPayDemSellerPaymentIntakeDepsV1 = Pick<
  SellerPaymentIntakeDeps,
  | "resolveCommittedAgreement"
  | "resolveListingAtCommit"
  | "resolveRail"
  | "resolveIdentityBundle"
  | "observeDemosTransfer"
  | "receiptStore"
>;

export interface DacsPayDemSellerPaymentTrackOptionsV1 {
  database: DacsNodeSqliteDatabase;
  workerId: string;
  noticeRuntime: Readonly<{
    load(jobId: string): Readonly<DacsRetainedPayDemPaymentNoticeV1> | undefined;
  }>;
  resolvePayerPayingKey(input: Readonly<{
    operation: Readonly<FixedPricePayDemTrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1<FixedPricePayDemOrderInput>>;
    notice: Readonly<DacsRetainedPayDemPaymentNoticeV1>;
  }>): Promise<string> | string;
  intakeDeps: Readonly<DacsPayDemSellerPaymentIntakeDepsV1>;
  effectLeaseDurationMs?: number;
  retryDelayMs?: number;
}

export interface DacsPayDemSellerPaymentResultV1 {
  paymentResultVersion: "1";
  jobId: string;
  phaseIndex: number;
  railId: string;
  agreementHash: string;
  settlementId: string;
  txHash: string;
  blockNumber: number;
  observedAt: number;
  evidenceHash: string;
  permitId: string;
  noticeHash: string;
}

interface DacsPayDemSellerPaymentInputV1 {
  paymentInputVersion: "1";
  orderBindingHash: string;
  orderLocalBindingHash: string;
  payerPayingKey: string;
  noticeHash: string;
  notice: DacsRetainedPayDemPaymentNoticeV1["notice"];
  noticeAuthenticationHash: string;
}

export class DacsPayDemSellerPaymentError extends Error {
  override readonly name = "DacsPayDemSellerPaymentError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function plainObject(value: unknown): value is Readonly<Record<string, unknown>> {
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

function exactFields(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): boolean {
  return Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field));
}

function nonEmpty(value: unknown, maximum = 4_096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value.trim() === value && !value.includes("\0");
}

function reasonCode(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const candidate = `pay-dem-${value}`;
  return REASON_CODE_RE.test(candidate) ? candidate : fallback;
}

function captureInput(value: unknown): Readonly<DacsPayDemSellerPaymentInputV1> {
  if (!plainObject(value) || !exactFields(value, [
    "paymentInputVersion", "orderBindingHash", "orderLocalBindingHash",
    "payerPayingKey", "noticeHash", "notice", "noticeAuthenticationHash",
  ]) || value.paymentInputVersion !== "1" ||
      typeof value.orderBindingHash !== "string" ||
      !HASH_RE.test(value.orderBindingHash) ||
      typeof value.orderLocalBindingHash !== "string" ||
      !HASH_RE.test(value.orderLocalBindingHash) || !nonEmpty(value.payerPayingKey) ||
      typeof value.noticeHash !== "string" || !HASH_RE.test(value.noticeHash) ||
      !isDacsPayDemPaymentNoticeV1(value.notice) ||
      value.noticeHash !== sha256Hex(canonicalize(value.notice)) ||
      typeof value.noticeAuthenticationHash !== "string" ||
      !HASH_RE.test(value.noticeAuthenticationHash)) {
    throw new DacsPayDemSellerPaymentError("pay-dem-seller-payment-input-invalid");
  }
  return Object.freeze(JSON.parse(canonicalize(value)) as DacsPayDemSellerPaymentInputV1);
}

function noticeMatchesOperation(
  notice: DacsRetainedPayDemPaymentNoticeV1["notice"],
  operation: Readonly<FixedPricePayDemTrackOperationInput>,
): boolean {
  const payment = notice.payment;
  const settlement = notice.settlement;
  return payment.jobId === operation.order.jobId &&
    payment.railId === operation.order.protocol.rail.railId &&
    payment.railVersion === operation.order.protocol.rail.railVersion &&
    payment.railDescriptorHash ===
      operation.order.protocol.rail.railDefinitionHash &&
    payment.network === operation.order.protocol.rail.network &&
    payment.orderBindingHash === operation.order.bindingHash &&
    payment.orderLocalBindingHash === operation.order.localBindingHash &&
    settlement.txHash.length === 64 && settlement.chainId === "demos" &&
    settlement.payer === payment.payer && settlement.payee === payment.payee;
}

function demosAgentAddress(value: string): string | undefined {
  const parsed = parseCanonicalClaimReference(value);
  if (parsed === null || parsed.identity.scheme !== "did") return undefined;
  return DEMOS_AGENT_IDENTIFIER_RE.exec(parsed.identity.identifier)?.[1];
}

function nativeIntakeDeps(
  deps: Readonly<DacsPayDemSellerPaymentIntakeDepsV1>,
): SellerPaymentIntakeDeps {
  return Object.freeze({
    resolveCommittedAgreement: deps.resolveCommittedAgreement,
    resolveListingAtCommit: deps.resolveListingAtCommit,
    resolveRail: deps.resolveRail,
    resolveIdentityBundle: deps.resolveIdentityBundle,
    observeDemosTransfer: deps.observeDemosTransfer,
    receiptStore: deps.receiptStore,
    // These callbacks are required by the rail-neutral verifier surface but
    // are unreachable after its authenticated registry resolves demos-native.
    resolvePayerAddress: async () => ({
      disposition: "indeterminate" as const,
      reason: "pay-dem-only-runtime",
    }),
    resolvePayeeDestination: async () => ({
      disposition: "indeterminate" as const,
      reason: "pay-dem-only-runtime",
      tier: 2 as const,
    }),
    observeX402Transfer: async () => ({
      status: "unavailable" as const,
      reason: "pay-dem-only-runtime",
    }),
    verifyX402ReceiptExtensions: async () => ({
      disposition: "indeterminate" as const,
      reason: "pay-dem-only-runtime",
    }),
    classifyX402SettlementChain: async () => ({
      disposition: "indeterminate" as const,
      reason: "pay-dem-only-runtime",
    }),
  });
}

function captureVerified(
  value: Readonly<SellerPaymentIntakeResult>,
  input: Readonly<DacsPayDemSellerPaymentInputV1>,
): Readonly<DacsPayDemSellerPaymentResultV1> | undefined {
  const payment = input.notice.payment;
  const settlement = input.notice.settlement;
  const identity = value.settlementIdentity;
  const txRef = value.evidenceInput?.paymentTxRefs[0];
  let evidencedAmountOs: string | undefined;
  try {
    if (value.evidenceInput?.paymentAmount.currency === "DEM") {
      evidencedAmountOs = baseUnits(value.evidenceInput.paymentAmount.amount, 9);
    }
  } catch {
    evidencedAmountOs = undefined;
  }
  if (value.disposition !== "verified" ||
      (value.fulfilment !== "claim" && value.fulfilment !== "already-claimed") ||
      value.jobId !== payment.jobId || value.phaseIndex !== payment.phaseIndex ||
      value.railId !== payment.railId || value.agreementHash !== payment.agreementHash ||
      !nonEmpty(value.settlementId) || !nonEmpty(value.permitId) ||
      typeof value.evidenceHash !== "string" || !HASH_RE.test(value.evidenceHash) ||
      value.payoutBindingTier !== 1 || identity?.kind !== "demos" ||
      evidencedAmountOs !== payment.amountOs ||
      identity.txHash !== settlement.txHash ||
      identity.blockNumber !== settlement.blockNumber ||
      !Number.isSafeInteger(identity.includedAt) || identity.includedAt < 0 ||
      value.evidenceInput?.phase !== "pay-dem" || txRef?.kind !== "demos" ||
      txRef.txHash !== settlement.txHash ||
      txRef.blockNumber !== settlement.blockNumber) return undefined;
  return Object.freeze({
    paymentResultVersion: "1",
    jobId: payment.jobId,
    phaseIndex: payment.phaseIndex,
    railId: payment.railId,
    agreementHash: payment.agreementHash,
    settlementId: value.settlementId,
    txHash: identity.txHash,
    blockNumber: identity.blockNumber,
    observedAt: identity.includedAt,
    evidenceHash: value.evidenceHash,
    permitId: value.permitId,
    noticeHash: input.noticeHash,
  });
}

function captureResult(value: unknown): Readonly<DacsPayDemSellerPaymentResultV1> {
  if (!plainObject(value) || !exactFields(value, [
    "paymentResultVersion", "jobId", "phaseIndex", "railId", "agreementHash",
    "settlementId", "txHash", "blockNumber", "observedAt", "evidenceHash",
    "permitId", "noticeHash",
  ]) || value.paymentResultVersion !== "1" || !nonEmpty(value.jobId) ||
      !Number.isSafeInteger(value.phaseIndex) || Number(value.phaseIndex) < 0 ||
      !nonEmpty(value.railId) || typeof value.agreementHash !== "string" ||
      !HASH_RE.test(value.agreementHash) || !nonEmpty(value.settlementId) ||
      typeof value.txHash !== "string" || !HASH_RE.test(value.txHash) ||
      !Number.isSafeInteger(value.blockNumber) || Number(value.blockNumber) < 0 ||
      !Number.isSafeInteger(value.observedAt) || Number(value.observedAt) < 0 ||
      typeof value.evidenceHash !== "string" || !HASH_RE.test(value.evidenceHash) ||
      !nonEmpty(value.permitId) || typeof value.noticeHash !== "string" ||
      !HASH_RE.test(value.noticeHash)) {
    throw new DacsPayDemSellerPaymentError("pay-dem-seller-payment-result-invalid");
  }
  return Object.freeze(JSON.parse(canonicalize(value)) as DacsPayDemSellerPaymentResultV1);
}

function authorizationMatchesResult(
  authorization: Readonly<SellerPaymentAuthorization>,
  result: Readonly<DacsPayDemSellerPaymentResultV1>,
  order: Readonly<FixedPricePayDemOrderRecord>,
): boolean {
  const identity = authorization.settlementIdentity;
  const txRef = authorization.evidenceInput.paymentTxRefs[0];
  return authorization.jobId === order.jobId &&
    authorization.phaseIndex === result.phaseIndex &&
    authorization.agreementHash === result.agreementHash &&
    authorization.railId === order.protocol.rail.railId &&
    authorization.railId === result.railId &&
    authorization.settlementId === result.settlementId &&
    authorization.evidenceHash === result.evidenceHash &&
    authorization.payoutBindingTier === 1 &&
    identity.kind === "demos" && identity.txHash === result.txHash &&
    identity.blockNumber === result.blockNumber &&
    identity.includedAt === result.observedAt &&
    authorization.evidenceInput.phase === "pay-dem" &&
    authorization.evidenceInput.paymentAmount.currency === "DEM" &&
    authorization.evidenceInput.paymentTxRefs.length === 1 &&
    txRef?.kind === "demos" && txRef.txHash === result.txHash &&
    txRef.blockNumber === result.blockNumber;
}

function paymentEffectId(order: Readonly<FixedPricePayDemOrderRecord>): string {
  return sha256Hex(canonicalize({
    localBindingHash: order.localBindingHash,
    role: "seller",
    track: "payment",
    roleLocalJob: order.sdkJobs.payment,
  }));
}

/**
 * Recover the exact completed native-payment result selected by the durable
 * seller coordinator. This exposes only the opaque permit id; the authority
 * behind it remains in the receipt store.
 */
export function loadDacsPayDemSellerPaymentResultForOrderV1(
  context: Readonly<{
    role: "buyer" | "seller";
    authority: string;
    peerAuthority: string;
    database: DacsNodeSqliteDatabase;
  }>,
  order: Readonly<FixedPricePayDemOrderRecord>,
): Readonly<DacsPayDemSellerPaymentResultV1> {
  if (context.role !== "seller" || order.role !== "seller" ||
      order.seller !== context.authority || order.buyer !== context.peerAuthority ||
      order.protocol.phase !== "pay-dem") {
    throw new DacsPayDemSellerPaymentError("pay-dem-seller-payment-order-mismatch");
  }
  const effect = context.database.loadEffect("payment", paymentEffectId(order));
  if (effect === undefined || effect.state !== "completed" ||
      effect.bindingHash !== order.localBindingHash || effect.result === undefined) {
    throw new DacsPayDemSellerPaymentError("pay-dem-seller-payment-result-pending");
  }
  const result = captureResult(effect.result);
  if (result.jobId !== order.jobId || result.railId !== order.protocol.rail.railId) {
    throw new DacsPayDemSellerPaymentError("pay-dem-seller-payment-result-corrupt");
  }
  return result;
}

/**
 * Resolve the authoritative native payment facts retained behind the opaque
 * one-shot permit. Read-only inspection grants no fulfilment authority; the
 * durable fulfilment core must still atomically consume the exact permit and
 * its complete handoff before invoking application work.
 */
export async function loadDacsPayDemSellerPaymentAuthorizationForOrderV1(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  order: Readonly<FixedPricePayDemOrderRecord>,
): Promise<Readonly<{
  result: Readonly<DacsPayDemSellerPaymentResultV1>;
  authorization: Readonly<SellerPaymentAuthorization>;
}>> {
  if (context.role !== "seller" || context.commerceStores.role !== "seller" ||
      typeof context.commerceStores.sellerReceipts.inspectPermit !== "function") {
    throw new DacsPayDemSellerPaymentError("pay-dem-seller-payment-store-invalid");
  }
  const result = loadDacsPayDemSellerPaymentResultForOrderV1(context, order);
  const inspection = await context.commerceStores.sellerReceipts.inspectPermit(
    result.permitId,
  );
  if (inspection.status === "invalid" ||
      !authorizationMatchesResult(inspection.claim.authorization, result, order)) {
    throw new DacsPayDemSellerPaymentError("pay-dem-seller-payment-authorization-invalid");
  }
  return Object.freeze({
    result,
    authorization: Object.freeze(
      JSON.parse(canonicalize(inspection.claim.authorization)) as SellerPaymentAuthorization,
    ),
  });
}

function executionControl(
  result: Readonly<SellerPaymentIntakeResult>,
): DacsLiveEffectExecutionControlV1 {
  return Object.freeze({
    effectControlVersion: "1",
    status: result.disposition === "rejected" ? "operator-action" : "indeterminate",
    reasonCode: reasonCode(
      result.reason,
      result.disposition === "rejected"
        ? "pay-dem-payment-rejected"
        : "pay-dem-payment-indeterminate",
    ),
  });
}

/**
 * Verify the buyer's authenticated notice against Demos and the exact finalized
 * Agreement before exposing the receipt store's one-shot fulfilment permit.
 */
export function createDacsPayDemSellerPaymentTrackV1(
  options: Readonly<DacsPayDemSellerPaymentTrackOptionsV1>,
): FixedPricePayDemTrackOperation {
  if (!plainObject(options) || !nonEmpty(options.workerId) ||
      options.database === null || typeof options.database !== "object" ||
      options.database.metadata.mode !== "live-demos" ||
      options.database.metadata.role !== "seller" ||
      !plainObject(options.noticeRuntime) ||
      typeof options.noticeRuntime.load !== "function" ||
      typeof options.resolvePayerPayingKey !== "function" ||
      !plainObject(options.intakeDeps) ||
      typeof options.intakeDeps.resolveCommittedAgreement !== "function" ||
      typeof options.intakeDeps.resolveListingAtCommit !== "function" ||
      typeof options.intakeDeps.resolveRail !== "function" ||
      typeof options.intakeDeps.resolveIdentityBundle !== "function" ||
      typeof options.intakeDeps.observeDemosTransfer !== "function" ||
      options.intakeDeps.receiptStore === null ||
      typeof options.intakeDeps.receiptStore !== "object") {
    throw new TypeError("pay-DEM seller payment track options are invalid");
  }
  const database = options.database;
  const intakeDeps = nativeIntakeDeps(options.intakeDeps);
  const loadNotice = options.noticeRuntime.load.bind(options.noticeRuntime);
  const resolvePayerPayingKey = options.resolvePayerPayingKey.bind(options);

  const verify = async (
    input: Readonly<DacsPayDemSellerPaymentInputV1>,
  ): Promise<Readonly<SellerPaymentIntakeResult>> => verifySellerPaymentIntake({
    jobId: input.notice.payment.jobId,
    phaseIndex: input.notice.payment.phaseIndex,
    railId: input.notice.payment.railId,
    payerPayingKey: input.payerPayingKey,
    receipt: { kind: "pay-dem", txHash: input.notice.settlement.txHash },
  }, intakeDeps);

  return createDacsLiveEffectTrackV1<
    DacsPayDemSellerPaymentInputV1,
    DacsPayDemSellerPaymentResultV1,
    FixedPricePayDemTrackOperationInput
  >({
    database,
    kind: "payment",
    role: "seller",
    track: "payment",
    workerId: options.workerId,
    async buildInput(operation) {
      const retained = loadDacsLiveOrderInputForTrackV1(operation, database);
      const rawNotice = loadNotice(operation.order.jobId);
      if (rawNotice === undefined) {
        throw new DacsLiveEffectInputControlError(
          "pending-retry",
          "pay-dem-payment-notice-pending",
        );
      }
      let notice: Readonly<DacsRetainedPayDemPaymentNoticeV1>;
      try {
        notice = captureDacsRetainedPayDemPaymentNoticeV1(rawNotice);
      } catch {
        throw new DacsLiveEffectInputControlError(
          "operator-action",
          "pay-dem-payment-notice-corrupt",
        );
      }
      if (!noticeMatchesOperation(notice.notice, operation) ||
          notice.noticeHash !== sha256Hex(canonicalize(notice.notice))) {
        throw new DacsLiveEffectInputControlError(
          "operator-action",
          "pay-dem-payment-notice-order-mismatch",
        );
      }
      const payerPayingKey = await resolvePayerPayingKey({
        operation,
        retained,
        notice,
      });
      if (!nonEmpty(payerPayingKey)) {
        throw new DacsLiveEffectInputControlError(
          "operator-action",
          "pay-dem-payer-paying-key-invalid",
        );
      }
      if (demosAgentAddress(payerPayingKey) !== notice.notice.payment.payer ||
          demosAgentAddress(operation.order.seller) !==
            notice.notice.payment.payee) {
        throw new DacsLiveEffectInputControlError(
          "operator-action",
          "pay-dem-payment-notice-party-mismatch",
        );
      }
      return captureInput({
        paymentInputVersion: "1",
        orderBindingHash: operation.order.bindingHash,
        orderLocalBindingHash: operation.order.localBindingHash,
        payerPayingKey,
        noticeHash: notice.noticeHash,
        notice: notice.notice,
        noticeAuthenticationHash:
          notice.transportAuthentication.authenticationHash,
      });
    },
    adapter: {
      async execute({ input, fence }) {
        await fence.assertCurrent();
        let intake: Readonly<SellerPaymentIntakeResult>;
        try {
          intake = await verify(captureInput(input));
        } catch {
          return Object.freeze({
            effectControlVersion: "1" as const,
            status: "indeterminate" as const,
            reasonCode: "pay-dem-payment-intake-unavailable",
          });
        }
        return captureVerified(intake, input) ?? executionControl(intake);
      },
      async reconcile({ input, fence }): Promise<
        Readonly<DacsLiveEffectReconciliationV1<DacsPayDemSellerPaymentResultV1>>
      > {
        await fence.assertCurrent();
        let intake: Readonly<SellerPaymentIntakeResult>;
        try {
          intake = await verify(captureInput(input));
        } catch {
          return Object.freeze({
            status: "indeterminate",
            reasonCode: "pay-dem-payment-intake-unavailable",
          });
        }
        const verified = captureVerified(intake, input);
        if (verified !== undefined) {
          return Object.freeze({ status: "completed", result: verified });
        }
        return Object.freeze({
          status: intake.disposition === "rejected"
            ? "operator-action"
            : "indeterminate",
          reasonCode: reasonCode(
            intake.reason,
            intake.disposition === "rejected"
              ? "pay-dem-payment-rejected"
              : "pay-dem-payment-indeterminate",
          ),
        });
      },
    },
    projectResult(value) {
      const captured = captureResult(value);
      return Object.freeze({
        reference: `demos:${captured.txHash}:${captured.blockNumber}`,
        authenticationHash: captured.evidenceHash,
      });
    },
    ...(options.effectLeaseDurationMs === undefined
      ? {}
      : { leaseDurationMs: options.effectLeaseDurationMs }),
    ...(options.retryDelayMs === undefined
      ? {}
      : { retryDelayMs: options.retryDelayMs }),
  });
}

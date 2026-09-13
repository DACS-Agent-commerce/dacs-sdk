import {
  fixedPriceAgreementLogicalAddress,
  getDeliveryFinalisationStatus,
  resumeDeliveryFinalisation,
  runDurableFulfilmentToDeliveryReady,
  type DeliveryReadyResult,
  type DurableSellerFulfilmentDeps,
  type SellerFulfilmentDurability,
  type SellerFulfilmentReceiptStore,
  type SellerFulfilmentRequest,
  type SellerFulfilmentResult,
} from "@kynesyslabs/dacs";
import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import type {
  FixedPricePayDemTrackOperation,
  FixedPricePayDemTrackOperationInput,
} from "@kynesyslabs/dacs/commerce";

import type { DacsFixedPriceSellerFulfilmentV1 } from
  "./fixedPriceX402SellerFulfilment.js";
import {
  loadDacsPayDemSellerPaymentAuthorizationForOrderV1,
} from "./payDemSellerPayment.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";

const DELIVERY_BINDING_VERSION = "1" as const;
const DELIVERY_BINDING_DOMAIN = "dacs-live-seller-pay-dem-delivery:v1:" as const;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const HASH_RE = /^[0-9a-f]{64}$/;

interface DacsPayDemSellerDeliveryBindingV1 {
  deliveryBindingVersion: typeof DELIVERY_BINDING_VERSION;
  localBindingHash: string;
  authorizationHash: string;
  jobId: string;
  deliveryPhaseIndex: number;
  fulfilmentId: string;
  logicalAddress: string;
  evidenceHash: string;
}

export interface DacsPayDemSellerFulfilmentRuntimeOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  workerId: string;
  fulfilment: Readonly<DacsFixedPriceSellerFulfilmentV1>;
  retryDelayMs?: number;
}

export interface DacsPayDemSellerFulfilmentRuntimeV1 {
  delivery: FixedPricePayDemTrackOperation;
  deliveryEvidence: FixedPricePayDemTrackOperation;
}

export class DacsPayDemSellerFulfilmentRuntimeError extends Error {
  override readonly name = "DacsPayDemSellerFulfilmentRuntimeError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function plainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safePhase(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function retryDelay(value: unknown): number {
  const captured = value ?? DEFAULT_RETRY_DELAY_MS;
  if (!Number.isSafeInteger(captured) || Number(captured) <= 0 ||
      Number(captured) > 600_000) {
    throw new TypeError("pay-dem seller fulfilment runtime timing is invalid");
  }
  return Number(captured);
}

function retryAt(context: Readonly<DacsLiveRoleOperationContextV1>, delay: number): number {
  const value = context.database.readTime() + delay;
  if (!Number.isSafeInteger(value)) {
    throw new DacsPayDemSellerFulfilmentRuntimeError(
      "pay-dem-seller-fulfilment-retry-time-overflow",
    );
  }
  return value;
}

function operationBound(
  operation: Readonly<FixedPricePayDemTrackOperationInput>,
  track: "delivery" | "delivery-evidence",
): boolean {
  return operation.order.role === "seller" && operation.fence.role === "seller" &&
    operation.fence.track === track && operation.order.protocol.phase === "pay-dem" &&
    operation.order.jobId === operation.fence.jobId &&
    operation.order.bindingHash === operation.fence.bindingHash &&
    operation.order.localBindingHash === operation.fence.localBindingHash;
}

function deliveryId(jobId: string, deliveryPhaseIndex: number): string {
  return sha256Hex(`${DELIVERY_BINDING_DOMAIN}${canonicalize({
    jobId,
    deliveryPhaseIndex,
  })}`);
}

function captureDeliveryBinding(value: unknown): Readonly<DacsPayDemSellerDeliveryBindingV1> {
  if (!plainObject(value) || Reflect.ownKeys(value).length !== 8 ||
      value.deliveryBindingVersion !== DELIVERY_BINDING_VERSION ||
      typeof value.localBindingHash !== "string" || !HASH_RE.test(value.localBindingHash) ||
      typeof value.authorizationHash !== "string" || !HASH_RE.test(value.authorizationHash) ||
      typeof value.jobId !== "string" || value.jobId.length === 0 ||
      !safePhase(value.deliveryPhaseIndex) || typeof value.fulfilmentId !== "string" ||
      value.fulfilmentId.length === 0 || typeof value.logicalAddress !== "string" ||
      value.logicalAddress.length === 0 || typeof value.evidenceHash !== "string" ||
      !HASH_RE.test(value.evidenceHash)) {
    throw new DacsPayDemSellerFulfilmentRuntimeError(
      "pay-dem-seller-delivery-binding-corrupt",
    );
  }
  return value as unknown as Readonly<DacsPayDemSellerDeliveryBindingV1>;
}

function requestFromAuthorization(input: Awaited<ReturnType<
  typeof loadDacsPayDemSellerPaymentAuthorizationForOrderV1
>>): Readonly<SellerFulfilmentRequest> {
  const payment = input.authorization;
  return Object.freeze({
    agreementRef: fixedPriceAgreementLogicalAddress(payment.jobId),
    agreementHash: payment.agreementHash,
    commitmentRef: payment.commitment.ref,
    deliveryPhaseIndex: payment.phaseIndex + 1,
    paymentPermitId: input.result.permitId,
    ...(payment.payloadVerificationProducerAdmission === undefined
      ? {}
      : { payloadVerificationProducerAdmission: payment.payloadVerificationProducerAdmission }),
  });
}

function deliveryProjection(
  ready: Readonly<DeliveryReadyResult>,
  localBindingHash: string,
  authorizationHash: string,
): Readonly<DacsPayDemSellerDeliveryBindingV1> {
  return Object.freeze({
    deliveryBindingVersion: DELIVERY_BINDING_VERSION,
    localBindingHash,
    authorizationHash,
    jobId: ready.result.jobId,
    deliveryPhaseIndex: ready.result.deliveryPhaseIndex,
    fulfilmentId: ready.result.fulfilmentId,
    logicalAddress: ready.result.logicalAddress,
    evidenceHash: ready.result.evidenceHash,
  });
}

function completedProjection(
  result: Extract<SellerFulfilmentResult, { decision: "completed" | "failed" }>,
  jobId: string,
  deliveryPhaseIndex: number,
  localBindingHash: string,
  authorizationHash: string,
): Readonly<DacsPayDemSellerDeliveryBindingV1> {
  return Object.freeze({
    deliveryBindingVersion: DELIVERY_BINDING_VERSION,
    localBindingHash,
    authorizationHash,
    jobId,
    deliveryPhaseIndex,
    fulfilmentId: result.fulfilmentId,
    logicalAddress: result.evidence.outcome === "success"
      ? result.evidence.deliverableAnchor.locator
      : result.evidenceRef.anchor.locator,
    evidenceHash: result.evidenceHash,
  });
}

/**
 * Run native delivery only after the seller payment track has independently
 * verified Demos finality and exposed its opaque one-shot permit. The core
 * atomically consumes that permit with the complete delivery handoff before
 * any application effect can occur.
 */
export function createDacsPayDemSellerFulfilmentRuntimeV1(
  options: Readonly<DacsPayDemSellerFulfilmentRuntimeOptionsV1>,
): Readonly<DacsPayDemSellerFulfilmentRuntimeV1> {
  if (!plainObject(options) || !plainObject(options.context) ||
      options.context.role !== "seller" || options.context.commerceStores.role !== "seller" ||
      !plainObject(options.fulfilment) || typeof options.workerId !== "string" ||
      options.workerId.length === 0) {
    throw new TypeError("pay-dem seller fulfilment runtime options are invalid");
  }
  const context = options.context;
  const delay = retryDelay(options.retryDelayMs);
  const commerceStores = context.commerceStores;
  if (commerceStores.role !== "seller") {
    throw new TypeError("pay-dem seller fulfilment runtime options are invalid");
  }
  const receipts = commerceStores.sellerReceipts;
  if (typeof receipts.inspectPermit !== "function") {
    throw new TypeError("pay-dem seller fulfilment requires receipt inspection");
  }
  const receiptStore: SellerFulfilmentReceiptStore = Object.freeze({
    claim: (input: Parameters<SellerFulfilmentReceiptStore["claim"]>[0]) =>
      receipts.claim(input),
    consumePermit: (
      permitId: string,
      handoff: Parameters<SellerFulfilmentReceiptStore["consumePermit"]>[1],
    ) => receipts.consumePermit(permitId, handoff),
    inspectPermit: (permitId: string) => receipts.inspectPermit!(permitId),
  });
  const fulfilmentDeps: DurableSellerFulfilmentDeps = {
    ...options.fulfilment.fulfilmentDeps,
    receiptStore,
  };
  const fulfilmentDurability: SellerFulfilmentDurability = {
    ...options.fulfilment.fulfilmentDurability,
    store: context.sessionStore,
    workerId: options.workerId,
  };

  const retainDelivery = (
    binding: Readonly<DacsPayDemSellerDeliveryBindingV1>,
  ): Readonly<DacsPayDemSellerDeliveryBindingV1> => {
    const id = deliveryId(binding.jobId, binding.deliveryPhaseIndex);
    const put = context.database.putEffectIntent({
      kind: "session",
      effectId: id,
      bindingHash: binding.localBindingHash,
      input: binding,
      idempotencyKey: id,
      jobId: binding.jobId,
    });
    if (put.status === "conflict") {
      throw new DacsPayDemSellerFulfilmentRuntimeError(
        "pay-dem-seller-delivery-binding-conflict",
      );
    }
    return captureDeliveryBinding(context.database.loadEffectInput("session", id));
  };

  const delivery: FixedPricePayDemTrackOperation = async (operation) => {
    if (!operationBound(operation, "delivery")) {
      return Object.freeze({ status: "operator-action" as const,
        reasonCode: "pay-dem-seller-delivery-track-binding-mismatch" });
    }
    try {
      const payment = await loadDacsPayDemSellerPaymentAuthorizationForOrderV1(
        context,
        operation.order,
      );
      const request = requestFromAuthorization(payment);
      const authorizationHash = sha256Hex(canonicalize({
        permitId: payment.result.permitId,
        authorization: payment.authorization,
      }));
      const id = deliveryId(operation.order.jobId, request.deliveryPhaseIndex);
      const retained = context.database.loadEffectInput("session", id);
      if (retained !== undefined) {
        const binding = captureDeliveryBinding(retained);
        if (binding.localBindingHash !== operation.order.localBindingHash ||
            binding.authorizationHash !== authorizationHash) {
          return Object.freeze({ status: "operator-action" as const,
            reasonCode: "pay-dem-seller-delivery-binding-mismatch" });
        }
        return Object.freeze({ status: "final" as const, outcome: "success" as const,
          reference: binding.logicalAddress, authenticationHash: binding.evidenceHash });
      }
      await operation.fence.assertCurrent();
      const output = await runDurableFulfilmentToDeliveryReady(
        request,
        fulfilmentDeps,
        fulfilmentDurability,
      );
      if (output.status !== "delivery-ready") {
        if (output.result.decision === "rejected" || output.result.decision === "failed") {
          return Object.freeze({ status: "operator-action" as const,
            reasonCode: output.result.decision === "rejected"
              ? `pay-dem-seller-delivery-${output.result.code}`
              : `pay-dem-seller-delivery-${output.result.errorClass}` });
        }
        return Object.freeze({ status: "pending-retry" as const,
          reasonCode: output.result.decision === "indeterminate"
            ? output.result.code : "pay-dem-seller-delivery-pending",
          retryAt: retryAt(context, delay) });
      }
      const projected = retainDelivery(deliveryProjection(
        output,
        operation.order.localBindingHash,
        authorizationHash,
      ));
      await operation.fence.assertCurrent();
      return Object.freeze({ status: "final" as const, outcome: "success" as const,
        reference: projected.logicalAddress, authenticationHash: projected.evidenceHash });
    } catch {
      return Object.freeze({ status: "pending-retry" as const,
        reasonCode: "pay-dem-seller-delivery-projection-pending",
        retryAt: retryAt(context, delay) });
    }
  };

  const deliveryEvidence: FixedPricePayDemTrackOperation = async (operation) => {
    if (!operationBound(operation, "delivery-evidence")) {
      return Object.freeze({ status: "operator-action" as const,
        reasonCode: "pay-dem-seller-delivery-evidence-track-binding-mismatch" });
    }
    try {
      const payment = await loadDacsPayDemSellerPaymentAuthorizationForOrderV1(
        context,
        operation.order,
      );
      const request = requestFromAuthorization(payment);
      const authorizationHash = sha256Hex(canonicalize({
        permitId: payment.result.permitId,
        authorization: payment.authorization,
      }));
      await operation.fence.assertCurrent();
      const result = await resumeDeliveryFinalisation(
        operation.order.jobId,
        request,
        fulfilmentDeps,
        fulfilmentDurability,
      );
      if (result.decision === "completed") {
        const projected = retainDelivery(completedProjection(
          result,
          operation.order.jobId,
          request.deliveryPhaseIndex,
          operation.order.localBindingHash,
          authorizationHash,
        ));
        await operation.fence.assertCurrent();
        return Object.freeze({ status: "final" as const, outcome: "success" as const,
          reference: result.evidenceRef.anchor.locator,
          authenticationHash: projected.evidenceHash });
      }
      if (result.decision === "failed" || result.decision === "rejected") {
        return Object.freeze({ status: "operator-action" as const,
          reasonCode: result.decision === "failed"
            ? `pay-dem-seller-delivery-evidence-${result.errorClass}`
            : `pay-dem-seller-delivery-evidence-${result.code}` });
      }
      return Object.freeze({ status: "pending-retry" as const,
        reasonCode: result.code, retryAt: retryAt(context, delay) });
    } catch {
      let reasonCode = "pay-dem-seller-delivery-evidence-projection-pending";
      try {
        const payment = await loadDacsPayDemSellerPaymentAuthorizationForOrderV1(
          context,
          operation.order,
        );
        const status = await getDeliveryFinalisationStatus(
          context.sessionStore,
          operation.order.jobId,
          payment.authorization.phaseIndex + 1,
        );
        if (status.status === "ok") {
          reasonCode = `pay-dem-seller-delivery-evidence-${status.milestone}`;
        }
      } catch {
        // The retry result deliberately exposes no retained bearer data.
      }
      return Object.freeze({ status: "pending-retry" as const,
        reasonCode, retryAt: retryAt(context, delay) });
    }
  };

  return Object.freeze({ delivery, deliveryEvidence });
}

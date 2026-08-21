import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import {
  createBuyerPaymentEvidenceHandshake,
  createSellerPaymentEvidenceHandshake,
  fixedPriceX402ProtocolBindingHash,
  isPaymentEvidenceAnchorCompletion,
  isPaymentEvidenceAnchorRequest,
  paymentEvidenceHandshakeScopeHash,
  type BuyerPaymentEvidenceHandshake,
  type BuyerPaymentEvidenceHandshakeOptions,
  type FixedPriceX402OrderRecord,
  type FixedPriceX402TrackOperation,
  type FixedPriceX402TrackOperationInput,
  type PaymentEvidenceAnchorCompletion,
  type PaymentEvidenceAnchorRequest,
  type PaymentEvidenceHandshakeRecord,
  type SellerPaymentEvidenceHandshake,
  type SellerPaymentEvidenceHandshakeOptions,
} from "@kynesyslabs/dacs/commerce";
import type { SellerSessionSettlementAnchorResult } from "@kynesyslabs/dacs/seller";

import {
  loadDacsLiveOrderInputForTrackV1,
} from "./orderInput.js";
import type {
  DacsLiveRoleInboundOperationContextV1,
  DacsLiveRoleOperationContextV1,
} from "./roleRuntime.js";
import type { DacsLiveRoleSendInputV1 } from "./service.js";
import type {
  DacsHttpAuthenticatedEnvelopeV1,
  DacsHttpPayloadValidationV1,
  DacsHttpPayloadValidatorV1,
} from "./transport/envelope.js";
import {
  paymentEvidencePeerFromDacsHttpEnvelopeV1,
} from "./transport/envelope.js";
import type { DacsHttpInboundDispositionV1 } from "./transport/http.js";

const REQUEST_BINDING_VERSION = "1" as const;
const REQUEST_BINDING_DOMAIN = "dacs-live-payment-evidence-request:v1:" as const;
const DEFAULT_RETRY_DELAY_MS = 1_000;

interface DacsPaymentEvidenceRequestBindingV1 {
  requestBindingVersion: typeof REQUEST_BINDING_VERSION;
  localBindingHash: string;
  request: Readonly<PaymentEvidenceAnchorRequest>;
}

interface DacsPaymentEvidenceRuntimeCommonV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  workerId: string;
  leaseDurationMs?: number;
  retryDelayMs?: number;
}

export interface DacsBuyerPaymentEvidenceRuntimeOptionsV1
  extends DacsPaymentEvidenceRuntimeCommonV1 {
  verifyEvidence: BuyerPaymentEvidenceHandshakeOptions["verifyEvidence"];
  anchorEvidence: BuyerPaymentEvidenceHandshakeOptions["anchorEvidence"];
  reconcileAnchor: BuyerPaymentEvidenceHandshakeOptions["reconcileAnchor"];
  verifyAnchorReceipt: BuyerPaymentEvidenceHandshakeOptions["verifyAnchorReceipt"];
}

export interface DacsSellerPaymentEvidenceRuntimeOptionsV1
  extends DacsPaymentEvidenceRuntimeCommonV1 {
  verifyAnchorReceipt: SellerPaymentEvidenceHandshakeOptions["verifyAnchorReceipt"];
}

export interface DacsBuyerPaymentEvidenceRuntimeV1 {
  readonly operation: FixedPriceX402TrackOperation;
  readonly validatePayload: DacsHttpPayloadValidatorV1;
  handleMessage(
    authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
    context: Readonly<DacsLiveRoleInboundOperationContextV1>,
  ): Promise<DacsHttpInboundDispositionV1>;
}

export interface DacsSellerPaymentEvidenceRuntimeV1 {
  readonly validatePayload: DacsHttpPayloadValidatorV1;
  anchorEvidence(
    operation: Readonly<FixedPriceX402TrackOperationInput>,
    input: Parameters<SellerPaymentEvidenceHandshake["anchorEvidence"]>[0],
  ): Promise<SellerSessionSettlementAnchorResult>;
  flushOutboundRequests(
    operation: Readonly<FixedPriceX402TrackOperationInput>,
  ): Promise<Readonly<{ status: "acknowledged" | "pending" | "rejected" }>>;
  handleMessage(
    authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
    context: Readonly<DacsLiveRoleInboundOperationContextV1>,
  ): Promise<DacsHttpInboundDispositionV1>;
}

export class DacsPaymentEvidenceRuntimeError extends Error {
  override readonly name = "DacsPaymentEvidenceRuntimeError";

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

function timing(value: unknown, fallback: number): number {
  const captured = value ?? fallback;
  if (!Number.isSafeInteger(captured) || Number(captured) <= 0 ||
      Number(captured) > 600_000) {
    throw new TypeError("payment evidence runtime timing is invalid");
  }
  return Number(captured);
}

function retryAt(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  retryDelayMs: number,
): number {
  const value = context.database.readTime() + retryDelayMs;
  if (!Number.isSafeInteger(value)) {
    throw new DacsPaymentEvidenceRuntimeError("payment-evidence-retry-time-overflow");
  }
  return value;
}

function operationBound(
  operation: Readonly<FixedPriceX402TrackOperationInput>,
  role: "buyer" | "seller",
): boolean {
  return operation.fence.role === role && operation.fence.track === "payment-evidence" &&
    operation.order.role === role && operation.order.jobId === operation.fence.jobId &&
    operation.order.bindingHash === operation.fence.bindingHash &&
    operation.order.localBindingHash === operation.fence.localBindingHash;
}

function requestBindingId(input: Readonly<{
  jobId: string;
  buyer: string;
  seller: string;
  protocolHash: string;
}>): string {
  return sha256Hex(`${REQUEST_BINDING_DOMAIN}${canonicalize(input)}`);
}

function requestBindingIdFromOrder(order: Readonly<FixedPriceX402OrderRecord>): string {
  return requestBindingId({
    jobId: order.jobId,
    buyer: order.buyer,
    seller: order.seller,
    protocolHash: fixedPriceX402ProtocolBindingHash(order.protocol),
  });
}

function requestBindingIdFromRequest(request: Readonly<PaymentEvidenceAnchorRequest>): string {
  return requestBindingId({
    jobId: request.jobId,
    buyer: request.buyer,
    seller: request.seller,
    protocolHash: request.protocolHash,
  });
}

async function loadOrder(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  jobId: string,
): Promise<Readonly<FixedPriceX402OrderRecord> | undefined> {
  const loaded = await context.database.createLiveCoordinatorStore(context.role)
    .load(context.role, jobId);
  if (loaded.status === "missing") return undefined;
  if (loaded.status !== "ok") {
    throw new DacsPaymentEvidenceRuntimeError("payment-evidence-order-state-invalid");
  }
  return loaded.record;
}

function requestMatchesOrder(
  request: Readonly<PaymentEvidenceAnchorRequest>,
  order: Readonly<FixedPriceX402OrderRecord>,
): boolean {
  return request.jobId === order.jobId && request.buyer === order.buyer &&
    request.seller === order.seller &&
    request.protocolHash === fixedPriceX402ProtocolBindingHash(order.protocol) &&
    canonicalize(request.protocol) === canonicalize(order.protocol);
}

function completionMatchesOrder(
  completion: Readonly<PaymentEvidenceAnchorCompletion>,
  order: Readonly<FixedPriceX402OrderRecord>,
): boolean {
  return completion.jobId === order.jobId && completion.buyer === order.buyer &&
    completion.seller === order.seller &&
    completion.protocolHash === fixedPriceX402ProtocolBindingHash(order.protocol);
}

function acceptedAcknowledgement(
  acknowledgement: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
): "accepted" | "existing" | "rejected" {
  const envelope = acknowledgement.envelope;
  if (envelope.type !== "acknowledgement") return "rejected";
  return envelope.payload.disposition;
}

function captureBinding(value: unknown): Readonly<DacsPaymentEvidenceRequestBindingV1> {
  if (!plainObject(value) || Reflect.ownKeys(value).length !== 3 ||
      value.requestBindingVersion !== REQUEST_BINDING_VERSION ||
      typeof value.localBindingHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.localBindingHash) ||
      !isPaymentEvidenceAnchorRequest(value.request)) {
    throw new DacsPaymentEvidenceRuntimeError("payment-evidence-request-binding-corrupt");
  }
  return value as unknown as Readonly<DacsPaymentEvidenceRequestBindingV1>;
}

function handshakeOptions(
  options: Readonly<DacsPaymentEvidenceRuntimeCommonV1>,
): Readonly<{ workerId: string; leaseDurationMs?: number }> {
  if (!plainObject(options) || !plainObject(options.context) ||
      typeof options.workerId !== "string" || options.workerId.length === 0 ||
      options.workerId.trim() !== options.workerId) {
    throw new TypeError("payment evidence runtime options are invalid");
  }
  return Object.freeze({
    workerId: options.workerId,
    ...(options.leaseDurationMs === undefined
      ? {} : { leaseDurationMs: timing(options.leaseDurationMs, 30_000) }),
  });
}

function payloadResult(valid: boolean, reasonCode: string): DacsHttpPayloadValidationV1 {
  return valid
    ? Object.freeze({ status: "valid" as const })
    : Object.freeze({ status: "invalid" as const, reasonCode });
}

async function releaseBuyerCompletion(
  handshake: Readonly<BuyerPaymentEvidenceHandshake>,
  claim: Awaited<ReturnType<BuyerPaymentEvidenceHandshake["claimOutboundCompletions"]>>["items"][number],
  context: Readonly<DacsLiveRoleOperationContextV1>,
  retryDelayMs: number,
  reasonCode: string,
): Promise<void> {
  await handshake.releaseOutboundCompletion(claim, {
    reasonCode,
    retryAt: retryAt(context, retryDelayMs),
  });
}

export function createDacsBuyerPaymentEvidenceRuntimeV1(
  options: Readonly<DacsBuyerPaymentEvidenceRuntimeOptionsV1>,
): Readonly<DacsBuyerPaymentEvidenceRuntimeV1> {
  const common = handshakeOptions(options);
  if (options.context.role !== "buyer" ||
      typeof options.verifyEvidence !== "function" ||
      typeof options.anchorEvidence !== "function" ||
      typeof options.reconcileAnchor !== "function" ||
      typeof options.verifyAnchorReceipt !== "function") {
    throw new TypeError("buyer payment evidence runtime options are invalid");
  }
  const context = options.context;
  const store = context.database.createPaymentEvidenceHandshakeStore();
  const retryDelayMs = timing(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS);

  const createHandshake = (
    order: Pick<FixedPriceX402OrderRecord, "seller" | "buyer" | "protocol">,
  ): Readonly<BuyerPaymentEvidenceHandshake> => createBuyerPaymentEvidenceHandshake({
    store,
    seller: order.seller,
    buyer: order.buyer,
    protocol: order.protocol,
    workerId: common.workerId,
    authenticateRequest: (request, transportContext) => {
      if (!plainObject(transportContext) ||
          !Object.hasOwn(transportContext, "authenticated")) {
        return { disposition: "rejected", reason: "signed-envelope-required" };
      }
      try {
        return {
          disposition: "authenticated",
          peer: paymentEvidencePeerFromDacsHttpEnvelopeV1(
            (transportContext as { authenticated: DacsHttpAuthenticatedEnvelopeV1 })
              .authenticated,
          ),
        };
      } catch {
        return { disposition: "rejected", reason: "signed-envelope-invalid" };
      }
    },
    verifyEvidence: options.verifyEvidence,
    anchorEvidence: options.anchorEvidence,
    reconcileAnchor: options.reconcileAnchor,
    verifyAnchorReceipt: options.verifyAnchorReceipt,
    ...(common.leaseDurationMs === undefined
      ? {} : { leaseDurationMs: common.leaseDurationMs }),
    retryDelayMs,
  });

  const validatePayload: DacsHttpPayloadValidatorV1 = async (input) => {
    if (input.type !== "payment-evidence-request" ||
        !isPaymentEvidenceAnchorRequest(input.payload)) {
      return payloadResult(false, "payment-evidence-request-invalid");
    }
    const order = await loadOrder(context, input.jobId);
    return payloadResult(order !== undefined && input.sender === context.peerAuthority &&
      input.audience === context.authority && input.payload.jobId === input.jobId &&
      requestMatchesOrder(input.payload, order), "payment-evidence-request-unbound");
  };

  const operation: FixedPriceX402TrackOperation = async (operationInput) => {
    if (!operationBound(operationInput, "buyer")) {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "buyer-payment-evidence-track-binding-mismatch",
      });
    }
    try {
      loadDacsLiveOrderInputForTrackV1(operationInput, context.database);
      await operationInput.fence.assertCurrent();
      const order = await loadOrder(context, operationInput.order.jobId);
      if (order === undefined) throw new Error();
      const bindingValue = context.database.loadEffectInput(
        "session",
        requestBindingIdFromOrder(order),
      );
      if (bindingValue === undefined) {
        return Object.freeze({
          status: "pending-retry" as const,
          reasonCode: "payment-evidence-request-pending",
          retryAt: retryAt(context, retryDelayMs),
        });
      }
      const binding = captureBinding(bindingValue);
      if (binding.localBindingHash !== order.localBindingHash ||
          !requestMatchesOrder(binding.request, order)) throw new Error();
      const handshake = createHandshake(order);
      const work = await handshake.runPending({
        messageId: binding.request.messageId,
        requestHash: binding.request.requestHash,
      });
      const result = work.items[0];
      if (result?.status === "operator-action") {
        return Object.freeze({
          status: "operator-action" as const,
          reasonCode: result.reasonCode ?? "payment-evidence-anchor-operator-action",
        });
      }
      let cursor: string | undefined;
      do {
        const page = await handshake.claimOutboundCompletions({
          ...(cursor === undefined ? {} : { cursor }),
          limit: 100,
        });
        for (const claim of page.items) {
          try {
            const acknowledgement = await context.sendMessage({
              type: "payment-evidence-completion",
              jobId: claim.completion.jobId,
              payload: claim.completion,
            } satisfies DacsLiveRoleSendInputV1<"payment-evidence-completion">);
            const disposition = acceptedAcknowledgement(acknowledgement);
            if (disposition === "accepted" || disposition === "existing") {
              await handshake.acknowledgeOutboundCompletion(claim);
            } else {
              await releaseBuyerCompletion(
                handshake,
                claim,
                context,
                retryDelayMs,
                "peer-rejected-payment-evidence-completion",
              );
            }
          } catch {
            await releaseBuyerCompletion(
              handshake,
              claim,
              context,
              retryDelayMs,
              "payment-evidence-completion-transport-ambiguous",
            ).catch(() => undefined);
          }
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      const loaded = await store.load(
        "buyer",
        binding.request.messageId,
        paymentEvidenceHandshakeScopeHash({
          seller: order.seller,
          buyer: order.buyer,
          protocolHash: fixedPriceX402ProtocolBindingHash(order.protocol),
        }),
      );
      if (loaded.status !== "ok") throw new Error();
      const record = loaded.record as Readonly<PaymentEvidenceHandshakeRecord>;
      if (record.completion !== undefined &&
          record.completionOutbox?.state === "acknowledged") {
        await operationInput.fence.assertCurrent();
        return Object.freeze({
          status: "final" as const,
          outcome: "success" as const,
          reference: record.completion.anchorReceipt.logicalAddress,
          authenticationHash: record.completion.completionHash,
        });
      }
      return Object.freeze({
        status: "pending-retry" as const,
        reasonCode: result?.reasonCode ?? "payment-evidence-completion-pending",
        retryAt: retryAt(context, retryDelayMs),
      });
    } catch {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "buyer-payment-evidence-runtime-invalid",
      });
    }
  };

  const runtime: DacsBuyerPaymentEvidenceRuntimeV1 = {
    operation,
    validatePayload,
    async handleMessage(
      authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
      inboundContext: Readonly<DacsLiveRoleInboundOperationContextV1>,
    ): Promise<DacsHttpInboundDispositionV1> {
      const envelope = authenticated.envelope;
      if (inboundContext.role !== "buyer" || envelope.type !== "payment-evidence-request") {
        return Object.freeze({
          disposition: "rejected" as const,
          reasonCode: "payment-evidence-message-role-incompatible",
        });
      }
      const validation = await validatePayload({
        type: envelope.type,
        payload: envelope.payload,
        jobId: envelope.jobId,
        sender: envelope.sender,
        audience: envelope.audience,
      });
      if (validation.status !== "valid") {
        return Object.freeze({ disposition: "rejected" as const, reasonCode: validation.reasonCode });
      }
      try {
        const order = await loadOrder(context, envelope.jobId);
        if (order === undefined) throw new Error();
        await createHandshake(order).receiveRequest(
          envelope.payload,
          { authenticated },
        );
        const id = requestBindingIdFromRequest(envelope.payload);
        const put = context.database.putEffectIntent({
          kind: "session",
          effectId: id,
          bindingHash: order.localBindingHash,
          input: {
            requestBindingVersion: REQUEST_BINDING_VERSION,
            localBindingHash: order.localBindingHash,
            request: envelope.payload,
          } satisfies DacsPaymentEvidenceRequestBindingV1,
          idempotencyKey: id,
          jobId: order.jobId,
        });
        if (put.status === "conflict") throw new Error();
        return Object.freeze({ disposition: "accepted" as const });
      } catch {
        return Object.freeze({
          disposition: "rejected" as const,
          reasonCode: "payment-evidence-request-retention-failed",
        });
      }
    },
  };
  return Object.freeze(runtime);
}

export function createDacsSellerPaymentEvidenceRuntimeV1(
  options: Readonly<DacsSellerPaymentEvidenceRuntimeOptionsV1>,
): Readonly<DacsSellerPaymentEvidenceRuntimeV1> {
  const common = handshakeOptions(options);
  if (options.context.role !== "seller" ||
      typeof options.verifyAnchorReceipt !== "function") {
    throw new TypeError("seller payment evidence runtime options are invalid");
  }
  const context = options.context;
  const store = context.database.createPaymentEvidenceHandshakeStore();
  const retryDelayMs = timing(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS);

  const createHandshake = (
    order: Pick<FixedPriceX402OrderRecord, "seller" | "buyer" | "protocol">,
  ): Readonly<SellerPaymentEvidenceHandshake> => createSellerPaymentEvidenceHandshake({
    store,
    seller: order.seller,
    buyer: order.buyer,
    protocol: order.protocol,
    workerId: common.workerId,
    authenticateCompletion: (completion, transportContext) => {
      if (!plainObject(transportContext) ||
          !Object.hasOwn(transportContext, "authenticated")) {
        return { disposition: "rejected", reason: "signed-envelope-required" };
      }
      try {
        return {
          disposition: "authenticated",
          peer: paymentEvidencePeerFromDacsHttpEnvelopeV1(
            (transportContext as { authenticated: DacsHttpAuthenticatedEnvelopeV1 })
              .authenticated,
          ),
        };
      } catch {
        return { disposition: "rejected", reason: "signed-envelope-invalid" };
      }
    },
    verifyAnchorReceipt: options.verifyAnchorReceipt,
    ...(common.leaseDurationMs === undefined
      ? {} : { leaseDurationMs: common.leaseDurationMs }),
  });

  const validatePayload: DacsHttpPayloadValidatorV1 = async (input) => {
    if (input.type !== "payment-evidence-completion" ||
        !isPaymentEvidenceAnchorCompletion(input.payload)) {
      return payloadResult(false, "payment-evidence-completion-invalid");
    }
    const order = await loadOrder(context, input.jobId);
    return payloadResult(order !== undefined && input.sender === context.peerAuthority &&
      input.audience === context.authority && input.payload.jobId === input.jobId &&
      completionMatchesOrder(input.payload, order), "payment-evidence-completion-unbound");
  };

  const runtime: DacsSellerPaymentEvidenceRuntimeV1 = {
    validatePayload,
    async anchorEvidence(
      operation: Readonly<FixedPriceX402TrackOperationInput>,
      input: Parameters<SellerPaymentEvidenceHandshake["anchorEvidence"]>[0],
    ): Promise<SellerSessionSettlementAnchorResult> {
      if (!operationBound(operation, "seller")) {
        return Object.freeze({
          disposition: "rejected" as const,
          reason: "seller payment-evidence track binding mismatch",
        });
      }
      const order = await loadOrder(context, operation.order.jobId);
      if (order === undefined) {
        return Object.freeze({
          disposition: "indeterminate" as const,
          reason: "seller payment-evidence order is unavailable",
        });
      }
      await operation.fence.assertCurrent();
      return createHandshake(order).anchorEvidence(input);
    },
    async flushOutboundRequests(
      operation: Readonly<FixedPriceX402TrackOperationInput>,
    ): Promise<Readonly<{ status: "acknowledged" | "pending" | "rejected" }>> {
      if (!operationBound(operation, "seller")) {
        return Object.freeze({ status: "rejected" as const });
      }
      const order = await loadOrder(context, operation.order.jobId);
      if (order === undefined) return Object.freeze({ status: "pending" as const });
      const handshake = createHandshake(order);
      let target: "acknowledged" | "pending" | "rejected" = "pending";
      let cursor: string | undefined;
      do {
        const page = await handshake.claimOutboundRequests({
          ...(cursor === undefined ? {} : { cursor }),
          limit: 100,
        });
        for (const claim of page.items) {
          try {
            const acknowledgement = await context.sendMessage({
              type: "payment-evidence-request",
              jobId: claim.request.jobId,
              payload: claim.request,
            } satisfies DacsLiveRoleSendInputV1<"payment-evidence-request">);
            const disposition = acceptedAcknowledgement(acknowledgement);
            if (disposition === "accepted" || disposition === "existing") {
              await handshake.acknowledgeOutboundRequest(claim);
              if (claim.request.jobId === operation.order.jobId) target = "acknowledged";
            } else {
              await handshake.releaseOutboundRequest(claim, {
                reasonCode: "peer-rejected-payment-evidence-request",
                retryAt: retryAt(context, retryDelayMs),
              });
              if (claim.request.jobId === operation.order.jobId) target = "rejected";
            }
          } catch {
            await handshake.releaseOutboundRequest(claim, {
              reasonCode: "payment-evidence-request-transport-ambiguous",
              retryAt: retryAt(context, retryDelayMs),
            }).catch(() => undefined);
          }
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return Object.freeze({ status: target });
    },
    async handleMessage(
      authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
      inboundContext: Readonly<DacsLiveRoleInboundOperationContextV1>,
    ): Promise<DacsHttpInboundDispositionV1> {
      const envelope = authenticated.envelope;
      if (inboundContext.role !== "seller" ||
          envelope.type !== "payment-evidence-completion") {
        return Object.freeze({
          disposition: "rejected" as const,
          reasonCode: "payment-evidence-message-role-incompatible",
        });
      }
      const validation = await validatePayload({
        type: envelope.type,
        payload: envelope.payload,
        jobId: envelope.jobId,
        sender: envelope.sender,
        audience: envelope.audience,
      });
      if (validation.status !== "valid") {
        return Object.freeze({ disposition: "rejected" as const, reasonCode: validation.reasonCode });
      }
      try {
        const order = await loadOrder(context, envelope.jobId);
        if (order === undefined) throw new Error();
        await createHandshake(order).receiveCompletion(
          envelope.payload,
          { authenticated },
        );
        return Object.freeze({ disposition: "accepted" as const });
      } catch {
        return Object.freeze({
          disposition: "rejected" as const,
          reasonCode: "payment-evidence-completion-retention-failed",
        });
      }
    },
  };
  return Object.freeze(runtime);
}

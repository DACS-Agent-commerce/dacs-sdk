import {
  createX402Paywall,
  createX402SellerSpine,
  getDeliveryFinalisationStatus,
  resumeDeliveryFinalisation,
  runDurableFulfilmentToDeliveryReady,
  x402PaywallSettlementKey,
  type DeliveryReadyResult,
  type DurableSellerFulfilmentDeps,
  type FixedPriceX402ErrorClass,
  type FixedPriceX402FaultedParty,
  type FixedPriceX402TrackOperation,
  type FixedPriceX402TrackOperationInput,
  type SellerFulfilmentDurability,
  type SellerFulfilmentReceiptStore,
  type SellerFulfilmentRequest,
  type SellerFulfilmentResult,
  type X402Paywall,
  type X402PaywallConfig,
  type X402PaywallPaymentAuthorization,
  type X402SellerCommittedSessionScope,
  type X402SellerPaymentPermitAuthorization,
  type X402SellerSpineOptions,
} from "@kynesyslabs/dacs";
import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";

import {
  loadDacsLiveOrderInputForTrackV1,
  type DacsLiveOrderInputV1,
} from "./orderInput.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";
import type { DacsLiveRoleApplicationRequestHandlerV1 } from "./service.js";
import {
  createDacsX402ApplicationRequestHandlerV1,
  type DacsX402HttpHandlerOptionsV1,
} from "./x402Http.js";

const AUTHORIZATION_BINDING_VERSION = "1" as const;
const DELIVERY_BINDING_VERSION = "1" as const;
const AUTHORIZATION_BINDING_DOMAIN = "dacs-live-seller-x402-authorization:v1:" as const;
const DELIVERY_BINDING_DOMAIN = "dacs-live-seller-delivery:v1:" as const;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const HASH_RE = /^[0-9a-f]{64}$/;

interface DacsSellerX402AuthorizationBindingV1 {
  authorizationBindingVersion: typeof AUTHORIZATION_BINDING_VERSION;
  localBindingHash: string;
  authorizationHash: string;
  settlementKey: string;
  authorization: Readonly<X402SellerPaymentPermitAuthorization>;
}

interface DacsSellerDeliveryBindingV1 {
  deliveryBindingVersion: typeof DELIVERY_BINDING_VERSION;
  localBindingHash: string;
  authorizationHash: string;
  jobId: string;
  deliveryPhaseIndex: number;
  fulfilmentId: string;
  logicalAddress: string;
  evidenceHash: string;
}

export interface DacsSellerX402OrderScopeV1 {
  paymentPhaseIndex: number;
  deliveryPhaseIndex: number;
}

export type DacsSellerX402SpineRuntimeOptionsV1<T> = Omit<
  X402SellerSpineOptions<T>,
  "settlementStore" | "receiptStore" | "fulfilmentDurability" |
  "deliveryReady" | "renderResponse"
> & Readonly<{
  fulfilmentDurability: Omit<SellerFulfilmentDurability, "store" | "workerId">;
  deliveryReady: NonNullable<X402SellerSpineOptions<T>["deliveryReady"]>;
  renderResponse: X402SellerSpineOptions<T>["renderResponse"];
}>;

export interface DacsSellerX402RuntimeOptionsV1<T = unknown> {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  workerId: string;
  paywall: Readonly<X402PaywallConfig>;
  spine: Readonly<DacsSellerX402SpineRuntimeOptionsV1<T>>;
  publicBaseUrl: string;
  resolveHttpRequest: DacsX402HttpHandlerOptionsV1<T>["resolveRequest"];
  resolveOrderScope(input: Readonly<{
    operation: Readonly<FixedPriceX402TrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1>;
  }>): Promise<Readonly<DacsSellerX402OrderScopeV1>> |
    Readonly<DacsSellerX402OrderScopeV1>;
  authorizePaymentComplete(input: Readonly<{
    operation: Readonly<FixedPriceX402TrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1>;
    authorization: Readonly<X402SellerPaymentPermitAuthorization>;
    settlementTransaction: string;
  }>): Promise<boolean> | boolean;
  classifySettlementFailure?: (input: Readonly<{
    operation: Readonly<FixedPriceX402TrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1>;
    reason: string;
  }>) => Promise<Readonly<{
    errorClass: FixedPriceX402ErrorClass;
    faultedParty: FixedPriceX402FaultedParty;
    reference: string;
  }>> | Readonly<{
    errorClass: FixedPriceX402ErrorClass;
    faultedParty: FixedPriceX402FaultedParty;
    reference: string;
  }>;
  retryDelayMs?: number;
  maxResponseBytes?: number;
  /** Deterministic test/custom-host seam. Production uses the public SDK factory. */
  createPaywall?: typeof createX402Paywall;
}

export interface DacsSellerX402RuntimeV1<T = unknown> {
  readonly paywall: Readonly<X402Paywall<T>>;
  readonly handleApplicationRequest: DacsLiveRoleApplicationRequestHandlerV1;
  readonly payment: FixedPriceX402TrackOperation;
  readonly delivery: FixedPriceX402TrackOperation;
  readonly deliveryEvidence: FixedPriceX402TrackOperation;
  resolvePaymentAuthorization(
    operation: Readonly<FixedPriceX402TrackOperationInput>,
  ): Promise<Readonly<X402SellerPaymentPermitAuthorization>>;
}

export class DacsSellerX402RuntimeError extends Error {
  override readonly name = "DacsSellerX402RuntimeError";

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

function safePhase(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function retryDelay(value: unknown): number {
  const captured = value ?? DEFAULT_RETRY_DELAY_MS;
  if (!Number.isSafeInteger(captured) || Number(captured) <= 0 ||
      Number(captured) > 600_000) {
    throw new TypeError("seller x402 runtime timing is invalid");
  }
  return Number(captured);
}

function retryAt(context: Readonly<DacsLiveRoleOperationContextV1>, delay: number): number {
  const value = context.database.readTime() + delay;
  if (!Number.isSafeInteger(value)) {
    throw new DacsSellerX402RuntimeError("seller-x402-retry-time-overflow");
  }
  return value;
}

function operationBound(
  operation: Readonly<FixedPriceX402TrackOperationInput>,
  track: "payment" | "delivery" | "delivery-evidence",
): boolean {
  return operation.order.role === "seller" && operation.fence.role === "seller" &&
    operation.fence.track === track && operation.order.jobId === operation.fence.jobId &&
    operation.order.bindingHash === operation.fence.bindingHash &&
    operation.order.localBindingHash === operation.fence.localBindingHash;
}

function captureScope(value: unknown): Readonly<DacsSellerX402OrderScopeV1> {
  if (!plainObject(value) || Reflect.ownKeys(value).length !== 2 ||
      !safePhase(value.paymentPhaseIndex) || !safePhase(value.deliveryPhaseIndex) ||
      Number(value.deliveryPhaseIndex) <= Number(value.paymentPhaseIndex)) {
    throw new DacsSellerX402RuntimeError("seller-x402-order-scope-invalid");
  }
  return Object.freeze({
    paymentPhaseIndex: Number(value.paymentPhaseIndex),
    deliveryPhaseIndex: Number(value.deliveryPhaseIndex),
  });
}

function authorizationId(jobId: string, paymentPhaseIndex: number): string {
  return sha256Hex(`${AUTHORIZATION_BINDING_DOMAIN}${canonicalize({
    jobId,
    paymentPhaseIndex,
  })}`);
}

function deliveryId(jobId: string, deliveryPhaseIndex: number): string {
  return sha256Hex(`${DELIVERY_BINDING_DOMAIN}${canonicalize({
    jobId,
    deliveryPhaseIndex,
  })}`);
}

function authorizationShape(
  value: unknown,
): value is Readonly<X402SellerPaymentPermitAuthorization> {
  if (!plainObject(value) || Reflect.ownKeys(value).length !== 4 ||
      value.authorizationVersion !== "1" || !plainObject(value.sessionAuthorization) ||
      typeof value.paymentPermitId !== "string" || value.paymentPermitId.length === 0 ||
      !plainObject(value.paymentAuthorization)) return false;
  const session = value.sessionAuthorization as unknown as X402SellerCommittedSessionScope;
  return session.scopeVersion === "1" && typeof session.jobId === "string" &&
    safePhase(session.paymentPhaseIndex) && safePhase(session.deliveryPhaseIndex) &&
    session.deliveryPhaseIndex > session.paymentPhaseIndex;
}

function captureAuthorizationBinding(
  value: unknown,
): Readonly<DacsSellerX402AuthorizationBindingV1> {
  if (!plainObject(value) || Reflect.ownKeys(value).length !== 5 ||
      value.authorizationBindingVersion !== AUTHORIZATION_BINDING_VERSION ||
      typeof value.localBindingHash !== "string" || !HASH_RE.test(value.localBindingHash) ||
      typeof value.authorizationHash !== "string" || !HASH_RE.test(value.authorizationHash) ||
      typeof value.settlementKey !== "string" || value.settlementKey.length === 0 ||
      !authorizationShape(value.authorization) ||
      sha256Hex(canonicalize(value.authorization)) !== value.authorizationHash) {
    throw new DacsSellerX402RuntimeError("seller-x402-authorization-binding-corrupt");
  }
  return value as unknown as Readonly<DacsSellerX402AuthorizationBindingV1>;
}

function captureDeliveryBinding(value: unknown): Readonly<DacsSellerDeliveryBindingV1> {
  if (!plainObject(value) || Reflect.ownKeys(value).length !== 8 ||
      value.deliveryBindingVersion !== DELIVERY_BINDING_VERSION ||
      typeof value.localBindingHash !== "string" || !HASH_RE.test(value.localBindingHash) ||
      typeof value.authorizationHash !== "string" || !HASH_RE.test(value.authorizationHash) ||
      typeof value.jobId !== "string" || value.jobId.length === 0 ||
      !safePhase(value.deliveryPhaseIndex) || typeof value.fulfilmentId !== "string" ||
      value.fulfilmentId.length === 0 || typeof value.logicalAddress !== "string" ||
      value.logicalAddress.length === 0 || typeof value.evidenceHash !== "string" ||
      !HASH_RE.test(value.evidenceHash)) {
    throw new DacsSellerX402RuntimeError("seller-delivery-binding-corrupt");
  }
  return value as unknown as Readonly<DacsSellerDeliveryBindingV1>;
}

function requestFromAuthorization(
  authorization: Readonly<X402SellerPaymentPermitAuthorization>,
): Readonly<SellerFulfilmentRequest> {
  const session = authorization.sessionAuthorization;
  return Object.freeze({
    agreementRef: session.agreementRef,
    agreementHash: session.agreementHash,
    commitmentRef: session.commitmentRef,
    deliveryPhaseIndex: session.deliveryPhaseIndex,
    paymentPermitId: authorization.paymentPermitId,
    ...(authorization.paymentAuthorization.payloadVerificationProducerAdmission === undefined
      ? {}
      : {
          payloadVerificationProducerAdmission:
            authorization.paymentAuthorization.payloadVerificationProducerAdmission,
        }),
  });
}

function deliveryProjection(
  ready: Readonly<DeliveryReadyResult>,
  localBindingHash: string,
  authorizationHash: string,
): Readonly<DacsSellerDeliveryBindingV1> {
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
  session: Readonly<X402SellerCommittedSessionScope>,
  localBindingHash: string,
  authorizationHash: string,
): Readonly<DacsSellerDeliveryBindingV1> {
  return Object.freeze({
    deliveryBindingVersion: DELIVERY_BINDING_VERSION,
    localBindingHash,
    authorizationHash,
    jobId: session.jobId,
    deliveryPhaseIndex: session.deliveryPhaseIndex,
    fulfilmentId: result.fulfilmentId,
    logicalAddress: result.evidence.outcome === "success"
      ? result.evidence.deliverableAnchor.locator
      : result.evidenceRef.anchor.locator,
    evidenceHash: result.evidenceHash,
  });
}

export async function createDacsSellerX402RuntimeV1<T = unknown>(
  options: Readonly<DacsSellerX402RuntimeOptionsV1<T>>,
): Promise<Readonly<DacsSellerX402RuntimeV1<T>>> {
  if (!plainObject(options) || !plainObject(options.context) ||
      options.context.role !== "seller" || options.context.evm.role !== "seller" ||
      options.context.commerceStores.role !== "seller" ||
      typeof options.workerId !== "string" || options.workerId.length === 0 ||
      !plainObject(options.paywall) || !plainObject(options.spine) ||
      typeof options.publicBaseUrl !== "string" ||
      typeof options.resolveHttpRequest !== "function" ||
      typeof options.resolveOrderScope !== "function" ||
      typeof options.authorizePaymentComplete !== "function" ||
      (options.classifySettlementFailure !== undefined &&
        typeof options.classifySettlementFailure !== "function") ||
      (options.createPaywall !== undefined && typeof options.createPaywall !== "function")) {
    throw new TypeError("seller x402 runtime options are invalid");
  }
  const context = options.context;
  const stores = context.commerceStores;
  if (stores.role !== "seller") throw new TypeError("seller x402 runtime options are invalid");
  if (typeof stores.sellerReceipts.inspectPermit !== "function") {
    throw new TypeError("seller x402 runtime requires receipt inspection");
  }
  const receiptStore: SellerFulfilmentReceiptStore = {
    claim: (input: Parameters<SellerFulfilmentReceiptStore["claim"]>[0]) =>
      stores.sellerReceipts.claim(input),
    consumePermit: (
      permitId: string,
      handoff: Parameters<SellerFulfilmentReceiptStore["consumePermit"]>[1],
    ) =>
      stores.sellerReceipts.consumePermit(permitId, handoff),
    inspectPermit: (permitId: string) => stores.sellerReceipts.inspectPermit!(permitId),
  };
  Object.freeze(receiptStore);
  const delay = retryDelay(options.retryDelayMs);
  const fulfilmentDeps: DurableSellerFulfilmentDeps = {
    ...options.spine.fulfilmentDeps,
    receiptStore,
  };
  const fulfilmentDurability: SellerFulfilmentDurability = {
    ...options.spine.fulfilmentDurability,
    store: context.sessionStore,
    workerId: options.workerId,
  };

  const loadOrder = async (jobId: string) => {
    const loaded = await context.database.createLiveCoordinatorStore("seller")
      .load("seller", jobId);
    if (loaded.status !== "ok") {
      throw new DacsSellerX402RuntimeError("seller-x402-order-state-invalid");
    }
    return loaded.record;
  };

  const retainAuthorization = async (
    authorization: Readonly<X402SellerPaymentPermitAuthorization>,
  ): Promise<Readonly<DacsSellerX402AuthorizationBindingV1>> => {
    if (!authorizationShape(authorization)) {
      throw new DacsSellerX402RuntimeError("seller-x402-authorization-invalid");
    }
    const session = authorization.sessionAuthorization;
    const order = await loadOrder(session.jobId);
    if (session.jobId !== order.jobId || session.paymentPhaseIndex < 0 ||
        session.deliveryPhaseIndex <= session.paymentPhaseIndex) {
      throw new DacsSellerX402RuntimeError("seller-x402-authorization-order-mismatch");
    }
    const id = authorizationId(session.jobId, session.paymentPhaseIndex);
    const binding: DacsSellerX402AuthorizationBindingV1 = {
      authorizationBindingVersion: AUTHORIZATION_BINDING_VERSION,
      localBindingHash: order.localBindingHash,
      authorizationHash: sha256Hex(canonicalize(authorization)),
      settlementKey: x402PaywallSettlementKey({
        jobId: session.jobId,
        phaseIndex: session.paymentPhaseIndex,
      }),
      authorization,
    };
    const put = context.database.putEffectIntent({
      kind: "session",
      effectId: id,
      bindingHash: order.localBindingHash,
      input: binding,
      idempotencyKey: id,
      jobId: session.jobId,
    });
    if (put.status === "conflict") {
      throw new DacsSellerX402RuntimeError("seller-x402-authorization-binding-conflict");
    }
    return captureAuthorizationBinding(context.database.loadEffectInput("session", id));
  };

  const loadAuthorization = async (
    operation: Readonly<FixedPriceX402TrackOperationInput>,
  ): Promise<Readonly<DacsSellerX402AuthorizationBindingV1>> => {
    const retained = loadDacsLiveOrderInputForTrackV1(operation, context.database);
    const scope = captureScope(await options.resolveOrderScope({ operation, retained }));
    const value = context.database.loadEffectInput(
      "session",
      authorizationId(operation.order.jobId, scope.paymentPhaseIndex),
    );
    if (value === undefined) {
      throw new DacsSellerX402RuntimeError("seller-x402-authorization-pending");
    }
    const binding = captureAuthorizationBinding(value);
    const session = binding.authorization.sessionAuthorization;
    if (binding.localBindingHash !== operation.order.localBindingHash ||
        session.jobId !== operation.order.jobId ||
        session.paymentPhaseIndex !== scope.paymentPhaseIndex ||
        session.deliveryPhaseIndex !== scope.deliveryPhaseIndex ||
        binding.settlementKey !== x402PaywallSettlementKey({
          jobId: operation.order.jobId,
          phaseIndex: scope.paymentPhaseIndex,
        })) {
      throw new DacsSellerX402RuntimeError("seller-x402-authorization-binding-corrupt");
    }
    return binding;
  };

  const retainDelivery = (
    binding: Readonly<DacsSellerDeliveryBindingV1>,
  ): Readonly<DacsSellerDeliveryBindingV1> => {
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
      throw new DacsSellerX402RuntimeError("seller-delivery-binding-conflict");
    }
    return captureDeliveryBinding(context.database.loadEffectInput("session", id));
  };

  const spine = createX402SellerSpine<T>({
    ...options.spine,
    settlementStore: stores.x402Settlement,
    receiptStore,
    fulfilmentDurability,
    deliveryReady: {
      renderResponse: async (renderContext) => {
        const authorization = await retainAuthorization(renderContext.authorization);
        const order = await loadOrder(renderContext.jobId);
        retainDelivery(deliveryProjection(
          renderContext.deliveryReady,
          order.localBindingHash,
          authorization.authorizationHash,
        ));
        return options.spine.deliveryReady.renderResponse(renderContext);
      },
    },
    renderResponse: async (renderContext) => {
      const authorization = await retainAuthorization(renderContext.authorization);
      const order = await loadOrder(renderContext.jobId);
      retainDelivery(completedProjection(
        renderContext.fulfilment,
        renderContext.authorization.sessionAuthorization,
        order.localBindingHash,
        authorization.authorizationHash,
      ));
      return options.spine.renderResponse(renderContext);
    },
  });

  const paywallFactory = options.createPaywall ?? createX402Paywall;
  const paywall = await paywallFactory<X402SellerPaymentPermitAuthorization, T>(
    options.paywall,
    {
      ...spine,
      authorizePayment: async (authorizationContext) => {
        const result: X402PaywallPaymentAuthorization<X402SellerPaymentPermitAuthorization> =
          await spine.authorizePayment(authorizationContext);
        if (result.disposition !== "authorized") return result;
        try {
          await retainAuthorization(result.authorization);
          return result;
        } catch {
          return {
            disposition: "indeterminate" as const,
            reason: "seller-payment-authorization-retention-failed",
          };
        }
      },
    },
  );

  const payment: FixedPriceX402TrackOperation = async (operation) => {
    if (!operationBound(operation, "payment")) {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "seller-x402-payment-track-binding-mismatch",
      });
    }
    let retained: Readonly<DacsLiveOrderInputV1>;
    let scope: Readonly<DacsSellerX402OrderScopeV1>;
    try {
      retained = loadDacsLiveOrderInputForTrackV1(operation, context.database);
      scope = captureScope(await options.resolveOrderScope({ operation, retained }));
      await operation.fence.assertCurrent();
    } catch {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "seller-x402-payment-input-invalid",
      });
    }
    const settlementKey = x402PaywallSettlementKey({
      jobId: operation.order.jobId,
      phaseIndex: scope.paymentPhaseIndex,
    });
    let settlement: Awaited<ReturnType<typeof stores.x402Settlement.load>>;
    try {
      settlement = await stores.x402Settlement.load(settlementKey);
    } catch {
      return Object.freeze({
        status: "pending-retry" as const,
        reasonCode: "seller-x402-settlement-read-pending",
        retryAt: retryAt(context, delay),
      });
    }
    try {
      if (settlement.status === "absent" || settlement.status === "held") {
        return Object.freeze({
          status: "pending-retry" as const,
          reasonCode: settlement.status === "absent"
            ? "seller-x402-payment-pending"
            : "seller-x402-settlement-reconciliation-pending",
          retryAt: retryAt(context, delay),
        });
      }
      if (settlement.status === "failed") {
        if (options.classifySettlementFailure === undefined) {
          return Object.freeze({
            status: "operator-action" as const,
            reasonCode: "seller-x402-settlement-failed-unclassified",
          });
        }
        const classified = await options.classifySettlementFailure({
          operation,
          retained,
          reason: settlement.outcome.status === "failed"
            ? settlement.outcome.reason
            : "settlement-failed",
        });
        const errorClasses = new Set([
          "permanent", "transient", "counterparty", "substrate", "settlement-atomicity",
        ]);
        const faultedParties = new Set(["buyer", "seller", "none"]);
        if (!plainObject(classified) ||
            typeof classified.errorClass !== "string" ||
            !errorClasses.has(classified.errorClass) ||
            typeof classified.faultedParty !== "string" ||
            !faultedParties.has(classified.faultedParty) ||
            typeof classified.reference !== "string" || classified.reference.length === 0 ||
            ((classified.errorClass === "substrate") !==
              (classified.faultedParty === "none"))) {
          return Object.freeze({
            status: "operator-action" as const,
            reasonCode: "seller-x402-settlement-classification-invalid",
          });
        }
        return Object.freeze({
          status: "final" as const,
          outcome: "failure" as const,
          errorClass: classified.errorClass,
          faultedParty: classified.faultedParty,
          reference: classified.reference,
        });
      }
      if (settlement.outcome.status !== "settled") throw new Error();
      let authorization: Readonly<DacsSellerX402AuthorizationBindingV1>;
      try {
        authorization = await loadAuthorization(operation);
      } catch (error) {
        if (error instanceof DacsSellerX402RuntimeError &&
            error.reasonCode === "seller-x402-authorization-pending") {
          return Object.freeze({
            status: "pending-retry" as const,
            reasonCode: error.reasonCode,
            retryAt: retryAt(context, delay),
          });
        }
        return Object.freeze({
          status: "operator-action" as const,
          reasonCode: "seller-x402-authorization-invalid",
        });
      }
      if (authorization.settlementKey !== settlementKey) throw new Error();
      const inspection = await receiptStore.inspectPermit(
        authorization.authorization.paymentPermitId,
      );
      if (inspection.status === "invalid") {
        return Object.freeze({
          status: "operator-action" as const,
          reasonCode: "seller-x402-payment-permit-invalid",
        });
      }
      if (canonicalize(inspection.claim.authorization) !==
          canonicalize(authorization.authorization.paymentAuthorization)) throw new Error();
      await operation.fence.assertCurrent();
      if (await options.authorizePaymentComplete({
        operation,
        retained,
        authorization: authorization.authorization,
        settlementTransaction: settlement.outcome.settlement.transaction,
      }) !== true) {
        return Object.freeze({
          status: "operator-action" as const,
          reasonCode: "seller-x402-payment-result-unauthorized",
        });
      }
      await operation.fence.assertCurrent();
      return Object.freeze({
        status: "final" as const,
        outcome: "success" as const,
        reference: settlement.outcome.settlement.transaction,
        authenticationHash: authorization.authorizationHash,
      });
    } catch {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "seller-x402-payment-projection-invalid",
      });
    }
  };

  const delivery: FixedPriceX402TrackOperation = async (operation) => {
    if (!operationBound(operation, "delivery")) {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "seller-delivery-track-binding-mismatch",
      });
    }
    try {
      const authorization = await loadAuthorization(operation);
      await operation.fence.assertCurrent();
      const output = await runDurableFulfilmentToDeliveryReady(
        requestFromAuthorization(authorization.authorization),
        fulfilmentDeps,
        fulfilmentDurability,
      );
      if (output.status !== "delivery-ready") {
        if (output.result.decision === "rejected" || output.result.decision === "failed") {
          return Object.freeze({
            status: "operator-action" as const,
            reasonCode: output.result.decision === "rejected"
              ? `seller-delivery-${output.result.code}`
              : `seller-delivery-${output.result.errorClass}`,
          });
        }
        return Object.freeze({
          status: "pending-retry" as const,
          reasonCode: output.result.decision === "indeterminate"
            ? output.result.code
            : "seller-delivery-pending",
          retryAt: retryAt(context, delay),
        });
      }
      const projected = retainDelivery(deliveryProjection(
        output,
        operation.order.localBindingHash,
        authorization.authorizationHash,
      ));
      await operation.fence.assertCurrent();
      return Object.freeze({
        status: "final" as const,
        outcome: "success" as const,
        reference: projected.logicalAddress,
        authenticationHash: projected.evidenceHash,
      });
    } catch {
      return Object.freeze({
        status: "pending-retry" as const,
        reasonCode: "seller-delivery-projection-pending",
        retryAt: retryAt(context, delay),
      });
    }
  };

  const deliveryEvidence: FixedPriceX402TrackOperation = async (operation) => {
    if (!operationBound(operation, "delivery-evidence")) {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "seller-delivery-evidence-track-binding-mismatch",
      });
    }
    try {
      const authorization = await loadAuthorization(operation);
      const request = requestFromAuthorization(authorization.authorization);
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
          authorization.authorization.sessionAuthorization,
          operation.order.localBindingHash,
          authorization.authorizationHash,
        ));
        await operation.fence.assertCurrent();
        return Object.freeze({
          status: "final" as const,
          outcome: "success" as const,
          reference: result.evidenceRef.anchor.locator,
          authenticationHash: projected.evidenceHash,
        });
      }
      if (result.decision === "failed" || result.decision === "rejected") {
        return Object.freeze({
          status: "operator-action" as const,
          reasonCode: result.decision === "failed"
            ? `seller-delivery-evidence-${result.errorClass}`
            : `seller-delivery-evidence-${result.code}`,
        });
      }
      return Object.freeze({
        status: "pending-retry" as const,
        reasonCode: result.code,
        retryAt: retryAt(context, delay),
      });
    } catch {
      let status: Awaited<ReturnType<typeof getDeliveryFinalisationStatus>> = {
        status: "missing",
      };
      try {
        const authorization = await loadAuthorization(operation);
        status = await getDeliveryFinalisationStatus(
          context.sessionStore,
          operation.order.jobId,
          authorization.authorization.sessionAuthorization.deliveryPhaseIndex,
        );
      } catch {
        // The retry result below deliberately exposes no retained bearer data.
      }
      return Object.freeze({
        status: "pending-retry" as const,
        reasonCode: status.status === "ok"
          ? `seller-delivery-evidence-${status.milestone}`
          : "seller-delivery-evidence-projection-pending",
        retryAt: retryAt(context, delay),
      });
    }
  };

  const runtime: DacsSellerX402RuntimeV1<T> = {
    paywall,
    handleApplicationRequest: createDacsX402ApplicationRequestHandlerV1({
      paywall,
      publicBaseUrl: options.publicBaseUrl,
      resolveRequest: options.resolveHttpRequest,
      ...(options.maxResponseBytes === undefined
        ? {} : { maxResponseBytes: options.maxResponseBytes }),
    }),
    payment,
    delivery,
    deliveryEvidence,
    async resolvePaymentAuthorization(operation) {
      return (await loadAuthorization(operation)).authorization;
    },
  };
  return Object.freeze(runtime);
}

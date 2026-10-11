import type {
  FixedPricePayDemOperations,
  FixedPricePayDemTrackOperation,
} from "@kynesyslabs/dacs/commerce";

import type {
  DacsBuyerAgreementTransportRuntimeV1,
  DacsSellerAgreementTransportRuntimeV1,
} from "./agreementTransportRuntime.js";
import type {
  DacsBuyerBundleTransportRuntimeV1,
  DacsSellerBundleTransportRuntimeV1,
} from "./bundleTransportRuntime.js";
import {
  createDacsFixedPricePayDemOperationSetV1,
  type DacsFixedPricePayDemBuyerOperationsV1,
  type DacsFixedPricePayDemSellerOperationsV1,
} from "./commerceRuntime.js";
import type { DacsLiveCommerceAvailabilityV1 } from "./liveCommerceGraph.js";
import {
  createDacsLiveRoleMessageRouterV1,
  type DacsLiveRoleMessageRouterV1,
} from "./messageRouter.js";
import type { DacsPayDemSellerPaymentNoticeRuntimeV1 } from
  "./payDemPaymentNoticeRuntime.js";
import type { DacsPayDemBuyerPaymentEvidenceRuntimeV1,
  DacsSellerPaymentEvidenceRuntimeV1 } from "./paymentEvidenceRuntime.js";
import type {
  DacsBuyerSessionBootstrapTransportRuntimeV1,
  DacsSellerSessionBootstrapTransportRuntimeV1,
} from "./sessionBootstrapTransportRuntime.js";
import type { DacsLiveRoleInboundOperationContextV1 } from "./roleRuntime.js";
import type {
  DacsHttpAuthenticatedEnvelopeV1,
  DacsHttpPayloadValidatorV1,
} from "./transport/envelope.js";
import type { DacsHttpInboundDispositionV1 } from "./transport/http.js";

export interface DacsBuyerPayDemLiveCommerceGraphOptionsV1 {
  sessionBootstrap: Readonly<DacsBuyerSessionBootstrapTransportRuntimeV1>;
  agreement: FixedPricePayDemTrackOperation;
  payment: FixedPricePayDemTrackOperation;
  paymentEvidence: Readonly<DacsPayDemBuyerPaymentEvidenceRuntimeV1>;
  buyerReceived: FixedPricePayDemTrackOperation;
  audit: FixedPricePayDemTrackOperation;
  agreementTransport: Readonly<DacsBuyerAgreementTransportRuntimeV1>;
  bundleTransport: Readonly<DacsBuyerBundleTransportRuntimeV1>;
}

export interface DacsSellerPayDemLiveCommerceGraphOptionsV1 {
  sessionBootstrap: Readonly<DacsSellerSessionBootstrapTransportRuntimeV1>;
  agreement: FixedPricePayDemTrackOperation;
  paymentNotice: Readonly<DacsPayDemSellerPaymentNoticeRuntimeV1>;
  payment: FixedPricePayDemTrackOperation;
  paymentEvidence: FixedPricePayDemTrackOperation;
  delivery: FixedPricePayDemTrackOperation;
  deliveryEvidence: FixedPricePayDemTrackOperation;
  audit: FixedPricePayDemTrackOperation;
  agreementTransport: Readonly<DacsSellerAgreementTransportRuntimeV1>;
  paymentEvidenceTransport: Readonly<DacsSellerPaymentEvidenceRuntimeV1>;
  bundleTransport: Readonly<DacsSellerBundleTransportRuntimeV1>;
}

export interface DacsBuyerPayDemLiveCommerceGraphV1 {
  readonly role: "buyer";
  readonly availability: Readonly<DacsLiveCommerceAvailabilityV1>;
  readonly payDemOperations: Readonly<DacsFixedPricePayDemBuyerOperationsV1> &
    Readonly<FixedPricePayDemOperations>;
  readonly router: Readonly<DacsLiveRoleMessageRouterV1>;
  readonly validatePayload: DacsHttpPayloadValidatorV1;
  handleMessage(
    authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
    context: Readonly<DacsLiveRoleInboundOperationContextV1>,
  ): Promise<DacsHttpInboundDispositionV1>;
}

export interface DacsSellerPayDemLiveCommerceGraphV1 {
  readonly role: "seller";
  readonly availability: Readonly<DacsLiveCommerceAvailabilityV1>;
  readonly payDemOperations: Readonly<DacsFixedPricePayDemSellerOperationsV1> &
    Readonly<FixedPricePayDemOperations>;
  readonly router: Readonly<DacsLiveRoleMessageRouterV1>;
  readonly validatePayload: DacsHttpPayloadValidatorV1;
  handleMessage(
    authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
    context: Readonly<DacsLiveRoleInboundOperationContextV1>,
  ): Promise<DacsHttpInboundDispositionV1>;
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

function exactFields(value: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function operation(value: unknown): value is FixedPricePayDemTrackOperation {
  return typeof value === "function";
}

function transportRuntime(value: unknown): value is Readonly<{
  validatePayload: DacsHttpPayloadValidatorV1;
  handleMessage(
    authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
    context: Readonly<DacsLiveRoleInboundOperationContextV1>,
  ): Promise<DacsHttpInboundDispositionV1> | DacsHttpInboundDispositionV1;
}> {
  return plainObject(value) && typeof value.validatePayload === "function" &&
    typeof value.handleMessage === "function";
}

/** Close the native buyer tracks and authenticated inbound routes as one graph. */
export function createDacsBuyerPayDemLiveCommerceGraphV1(
  options: Readonly<DacsBuyerPayDemLiveCommerceGraphOptionsV1>,
): Readonly<DacsBuyerPayDemLiveCommerceGraphV1> {
  const fields = [
    "sessionBootstrap", "agreement", "payment", "paymentEvidence",
    "buyerReceived", "audit", "agreementTransport", "bundleTransport",
  ] as const;
  if (!plainObject(options) || !exactFields(options, fields) ||
      !operation(options.agreement) || !operation(options.payment) ||
      !plainObject(options.paymentEvidence) ||
      !operation(options.paymentEvidence.operation) ||
      !operation(options.buyerReceived) || !operation(options.audit) ||
      !transportRuntime(options.sessionBootstrap) ||
      !transportRuntime(options.agreementTransport) ||
      !transportRuntime(options.paymentEvidence) ||
      !transportRuntime(options.bundleTransport)) {
    throw new TypeError("buyer pay-DEM live commerce graph options are invalid");
  }
  const payDemOperations = createDacsFixedPricePayDemOperationSetV1({
    role: "buyer",
    operations: {
      agreement: options.agreement,
      payment: options.payment,
      "payment-evidence": options.paymentEvidence.operation,
      "buyer-received": options.buyerReceived,
      audit: options.audit,
    },
  }) as Readonly<DacsFixedPricePayDemBuyerOperationsV1> &
    Readonly<FixedPricePayDemOperations>;
  const router = createDacsLiveRoleMessageRouterV1({
    role: "buyer",
    routes: {
      "session-challenge": {
        validate: options.sessionBootstrap.validatePayload,
        handle: (authenticated, context) =>
          options.sessionBootstrap.handleMessage(authenticated, context),
      },
      "session-admission": {
        validate: options.sessionBootstrap.validatePayload,
        handle: (authenticated, context) =>
          options.sessionBootstrap.handleMessage(authenticated, context),
      },
      "agreement-response": {
        validate: options.agreementTransport.validatePayload,
        handle: (authenticated, context) =>
          options.agreementTransport.handleMessage(authenticated, context),
      },
      "payment-evidence-request": {
        validate: options.paymentEvidence.validatePayload,
        handle: (authenticated, context) =>
          options.paymentEvidence.handleMessage(authenticated, context),
      },
      "bundle-signature-request": {
        validate: options.bundleTransport.validatePayload,
        handle: (authenticated, context) =>
          options.bundleTransport.handleMessage(authenticated, context),
      },
    },
  });
  return Object.freeze({
    role: "buyer" as const,
    availability: Object.freeze({ status: "configured" as const }),
    payDemOperations,
    router,
    validatePayload: router.validatePayload,
    handleMessage: (
      authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
      context: Readonly<DacsLiveRoleInboundOperationContextV1>,
    ) => router.handleMessage(authenticated, context),
  });
}

/** Close native seller intake, fulfilment, evidence and audit into one graph. */
export function createDacsSellerPayDemLiveCommerceGraphV1(
  options: Readonly<DacsSellerPayDemLiveCommerceGraphOptionsV1>,
): Readonly<DacsSellerPayDemLiveCommerceGraphV1> {
  const fields = [
    "sessionBootstrap", "agreement", "paymentNotice", "payment",
    "paymentEvidence", "delivery", "deliveryEvidence", "audit",
    "agreementTransport", "paymentEvidenceTransport", "bundleTransport",
  ] as const;
  if (!plainObject(options) || !exactFields(options, fields) ||
      !operation(options.agreement) || !operation(options.payment) ||
      !operation(options.paymentEvidence) || !operation(options.delivery) ||
      !operation(options.deliveryEvidence) || !operation(options.audit) ||
      !transportRuntime(options.sessionBootstrap) ||
      !transportRuntime(options.agreementTransport) ||
      !transportRuntime(options.paymentNotice) ||
      !transportRuntime(options.paymentEvidenceTransport) ||
      !transportRuntime(options.bundleTransport)) {
    throw new TypeError("seller pay-DEM live commerce graph options are invalid");
  }
  const payDemOperations = createDacsFixedPricePayDemOperationSetV1({
    role: "seller",
    operations: {
      agreement: options.agreement,
      payment: options.payment,
      "payment-evidence": options.paymentEvidence,
      delivery: options.delivery,
      "delivery-evidence": options.deliveryEvidence,
      audit: options.audit,
    },
  }) as Readonly<DacsFixedPricePayDemSellerOperationsV1> &
    Readonly<FixedPricePayDemOperations>;
  const router = createDacsLiveRoleMessageRouterV1({
    role: "seller",
    routes: {
      "session-init": {
        validate: options.sessionBootstrap.validatePayload,
        handle: (authenticated, context) =>
          options.sessionBootstrap.handleMessage(authenticated, context),
      },
      "session-presentation": {
        validate: options.sessionBootstrap.validatePayload,
        handle: (authenticated, context) =>
          options.sessionBootstrap.handleMessage(authenticated, context),
      },
      "agreement-proposal": {
        validate: options.agreementTransport.validatePayload,
        handle: (authenticated, context) =>
          options.agreementTransport.handleMessage(authenticated, context),
      },
      "pay-dem-payment-notice": {
        validate: options.paymentNotice.validatePayload,
        handle: (authenticated, context) =>
          options.paymentNotice.handleMessage(authenticated, context),
      },
      "payment-evidence-completion": {
        validate: options.paymentEvidenceTransport.validatePayload,
        handle: (authenticated, context) =>
          options.paymentEvidenceTransport.handleMessage(authenticated, context),
      },
      "bundle-signature-response": {
        validate: options.bundleTransport.validatePayload,
        handle: (authenticated, context) =>
          options.bundleTransport.handleMessage(authenticated, context),
      },
    },
  });
  return Object.freeze({
    role: "seller" as const,
    availability: Object.freeze({ status: "configured" as const }),
    payDemOperations,
    router,
    validatePayload: router.validatePayload,
    handleMessage: (
      authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
      context: Readonly<DacsLiveRoleInboundOperationContextV1>,
    ) => router.handleMessage(authenticated, context),
  });
}

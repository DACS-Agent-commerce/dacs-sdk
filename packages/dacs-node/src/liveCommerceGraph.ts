import type {
  FixedPriceX402Operations,
  FixedPriceX402TrackOperation,
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
  createDacsFixedPriceX402OperationSetV1,
  type DacsFixedPriceX402BuyerOperationsV1,
  type DacsFixedPriceX402SellerOperationsV1,
} from "./commerceRuntime.js";
import {
  createDacsLiveRoleMessageRouterV1,
  type DacsLiveRoleMessageRouterV1,
} from "./messageRouter.js";
import type {
  DacsBuyerPaymentEvidenceRuntimeV1,
  DacsSellerPaymentEvidenceRuntimeV1,
} from "./paymentEvidenceRuntime.js";
import type { DacsLiveRoleInboundOperationContextV1 } from "./roleRuntime.js";
import type {
  DacsLiveRoleApplicationRequestHandlerV1,
} from "./service.js";
import type { DacsSellerX402RuntimeV1 } from "./sellerX402Runtime.js";
import type {
  DacsHttpAuthenticatedEnvelopeV1,
  DacsHttpPayloadValidatorV1,
} from "./transport/envelope.js";
import type { DacsHttpInboundDispositionV1 } from "./transport/http.js";

export interface DacsBuyerLiveCommerceGraphOptionsV1 {
  agreement: FixedPriceX402TrackOperation;
  payment: FixedPriceX402TrackOperation;
  paymentEvidence: Readonly<DacsBuyerPaymentEvidenceRuntimeV1>;
  buyerReceived: FixedPriceX402TrackOperation;
  audit: FixedPriceX402TrackOperation;
  agreementTransport: Readonly<DacsBuyerAgreementTransportRuntimeV1>;
  bundleTransport: Readonly<DacsBuyerBundleTransportRuntimeV1>;
}

export interface DacsSellerLiveCommerceGraphOptionsV1<T = unknown> {
  agreement: FixedPriceX402TrackOperation;
  x402: Readonly<DacsSellerX402RuntimeV1<T>>;
  paymentEvidence: FixedPriceX402TrackOperation;
  audit: FixedPriceX402TrackOperation;
  agreementTransport: Readonly<DacsSellerAgreementTransportRuntimeV1>;
  paymentEvidenceTransport: Readonly<DacsSellerPaymentEvidenceRuntimeV1>;
  bundleTransport: Readonly<DacsSellerBundleTransportRuntimeV1>;
}

export interface DacsBuyerLiveCommerceGraphV1 {
  readonly role: "buyer";
  readonly operations: Readonly<DacsFixedPriceX402BuyerOperationsV1> &
    Readonly<FixedPriceX402Operations>;
  readonly router: Readonly<DacsLiveRoleMessageRouterV1>;
  readonly validatePayload: DacsHttpPayloadValidatorV1;
  handleMessage(
    authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
    context: Readonly<DacsLiveRoleInboundOperationContextV1>,
  ): Promise<DacsHttpInboundDispositionV1>;
}

export interface DacsSellerLiveCommerceGraphV1 {
  readonly role: "seller";
  readonly operations: Readonly<DacsFixedPriceX402SellerOperationsV1> &
    Readonly<FixedPriceX402Operations>;
  readonly router: Readonly<DacsLiveRoleMessageRouterV1>;
  readonly validatePayload: DacsHttpPayloadValidatorV1;
  readonly handleApplicationRequest: DacsLiveRoleApplicationRequestHandlerV1;
  handleMessage(
    authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
    context: Readonly<DacsLiveRoleInboundOperationContextV1>,
  ): Promise<DacsHttpInboundDispositionV1>;
}

export interface DacsUnavailableLiveCommerceGraphOptionsV1 {
  role: "buyer" | "seller";
  reasonCode: string;
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
  return keys.length === fields.length && fields.every((field) =>
    Object.hasOwn(value, field));
}

function operation(value: unknown): value is FixedPriceX402TrackOperation {
  return typeof value === "function";
}

/**
 * Complete, deliberately non-performing graph used while guarded setup has not
 * installed an admitted commerce configuration. Unlike an empty operation map,
 * every coordinator track and message direction is explicit and fail-closed.
 */
export function createDacsUnavailableLiveCommerceGraphV1(
  options: Readonly<DacsUnavailableLiveCommerceGraphOptionsV1>,
): Readonly<DacsBuyerLiveCommerceGraphV1 | DacsSellerLiveCommerceGraphV1> {
  if (!plainObject(options) || !exactFields(options, ["role", "reasonCode"]) ||
      (options.role !== "buyer" && options.role !== "seller") ||
      typeof options.reasonCode !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(options.reasonCode)) {
    throw new TypeError("unavailable live commerce graph options are invalid");
  }
  const unavailableOperation: FixedPriceX402TrackOperation = async () => Object.freeze({
    status: "operator-action" as const,
    reasonCode: options.reasonCode,
  });
  const validatePayload: DacsHttpPayloadValidatorV1 = () => Object.freeze({
    status: "invalid" as const,
    reasonCode: options.reasonCode,
  });
  const handleMessage = async () => Object.freeze({
    disposition: "rejected" as const,
    reasonCode: options.reasonCode,
  });
  const runtime = Object.freeze({ validatePayload, handleMessage });
  if (options.role === "buyer") {
    return createDacsBuyerLiveCommerceGraphV1({
      agreement: unavailableOperation,
      payment: unavailableOperation,
      paymentEvidence: Object.freeze({ ...runtime, operation: unavailableOperation }),
      buyerReceived: unavailableOperation,
      audit: unavailableOperation,
      agreementTransport: runtime as unknown as DacsBuyerAgreementTransportRuntimeV1,
      bundleTransport: runtime as unknown as DacsBuyerBundleTransportRuntimeV1,
    });
  }
  const handleApplicationRequest: DacsLiveRoleApplicationRequestHandlerV1 =
    (_request, response) => {
      if (response.headersSent || response.writableEnded) return true;
      response.statusCode = 503;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ status: "blocked", reasonCode: options.reasonCode }));
      return true;
    };
  const x402 = Object.freeze({
    payment: unavailableOperation,
    delivery: unavailableOperation,
    deliveryEvidence: unavailableOperation,
    handleApplicationRequest,
  }) as unknown as Readonly<DacsSellerX402RuntimeV1>;
  return createDacsSellerLiveCommerceGraphV1({
    agreement: unavailableOperation,
    x402,
    paymentEvidence: unavailableOperation,
    audit: unavailableOperation,
    agreementTransport: runtime as unknown as DacsSellerAgreementTransportRuntimeV1,
    paymentEvidenceTransport: runtime as unknown as DacsSellerPaymentEvidenceRuntimeV1,
    bundleTransport: runtime as unknown as DacsSellerBundleTransportRuntimeV1,
  });
}

function transportRuntime(value: unknown): value is Readonly<{
  validatePayload: DacsHttpPayloadValidatorV1;
  handleMessage: DacsBuyerAgreementTransportRuntimeV1["handleMessage"];
}> {
  return plainObject(value) && typeof value.validatePayload === "function" &&
    typeof value.handleMessage === "function";
}

/**
 * Close the buyer's complete operation and inbound-message graph. This is the
 * boundary handed to the role service: omitting one required track or swapping
 * a seller-directed message is rejected synchronously during startup.
 */
export function createDacsBuyerLiveCommerceGraphV1(
  options: Readonly<DacsBuyerLiveCommerceGraphOptionsV1>,
): Readonly<DacsBuyerLiveCommerceGraphV1> {
  const fields = [
    "agreement", "payment", "paymentEvidence", "buyerReceived", "audit",
    "agreementTransport", "bundleTransport",
  ] as const;
  if (!plainObject(options) || !exactFields(options, fields) ||
      !operation(options.agreement) || !operation(options.payment) ||
      !plainObject(options.paymentEvidence) ||
      !operation(options.paymentEvidence.operation) ||
      !operation(options.buyerReceived) || !operation(options.audit) ||
      !transportRuntime(options.agreementTransport) ||
      !transportRuntime(options.paymentEvidence) ||
      !transportRuntime(options.bundleTransport)) {
    throw new TypeError("buyer live commerce graph options are invalid");
  }
  const operations = createDacsFixedPriceX402OperationSetV1({
    role: "buyer",
    operations: {
      agreement: options.agreement,
      payment: options.payment,
      "payment-evidence": options.paymentEvidence.operation,
      "buyer-received": options.buyerReceived,
      audit: options.audit,
    },
  }) as Readonly<DacsFixedPriceX402BuyerOperationsV1> &
    Readonly<FixedPriceX402Operations>;
  const router = createDacsLiveRoleMessageRouterV1({
    role: "buyer",
    routes: {
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
    operations,
    router,
    validatePayload: router.validatePayload,
    handleMessage: (
      authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
      context: Readonly<DacsLiveRoleInboundOperationContextV1>,
    ) =>
      router.handleMessage(authenticated, context),
  });
}

/**
 * Close the seller's complete operation, commerce-message and paid-resource
 * graph. The x402 paywall, fulfilment tracks and HTTP application handler come
 * from the same runtime instance, preventing a host from serving through one
 * paywall while projecting another settlement or delivery state.
 */
export function createDacsSellerLiveCommerceGraphV1<T = unknown>(
  options: Readonly<DacsSellerLiveCommerceGraphOptionsV1<T>>,
): Readonly<DacsSellerLiveCommerceGraphV1> {
  const fields = [
    "agreement", "x402", "paymentEvidence", "audit", "agreementTransport",
    "paymentEvidenceTransport", "bundleTransport",
  ] as const;
  if (!plainObject(options) || !exactFields(options, fields) ||
      !operation(options.agreement) || !plainObject(options.x402) ||
      !operation(options.x402.payment) || !operation(options.x402.delivery) ||
      !operation(options.x402.deliveryEvidence) ||
      typeof options.x402.handleApplicationRequest !== "function" ||
      !operation(options.paymentEvidence) || !operation(options.audit) ||
      !transportRuntime(options.agreementTransport) ||
      !transportRuntime(options.paymentEvidenceTransport) ||
      !transportRuntime(options.bundleTransport)) {
    throw new TypeError("seller live commerce graph options are invalid");
  }
  const operations = createDacsFixedPriceX402OperationSetV1({
    role: "seller",
    operations: {
      agreement: options.agreement,
      payment: options.x402.payment,
      "payment-evidence": options.paymentEvidence,
      delivery: options.x402.delivery,
      "delivery-evidence": options.x402.deliveryEvidence,
      audit: options.audit,
    },
  }) as Readonly<DacsFixedPriceX402SellerOperationsV1> &
    Readonly<FixedPriceX402Operations>;
  const router = createDacsLiveRoleMessageRouterV1({
    role: "seller",
    routes: {
      "agreement-proposal": {
        validate: options.agreementTransport.validatePayload,
        handle: (authenticated, context) =>
          options.agreementTransport.handleMessage(authenticated, context),
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
    operations,
    router,
    validatePayload: router.validatePayload,
    handleMessage: (
      authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
      context: Readonly<DacsLiveRoleInboundOperationContextV1>,
    ) =>
      router.handleMessage(authenticated, context),
    handleApplicationRequest: options.x402.handleApplicationRequest,
  });
}

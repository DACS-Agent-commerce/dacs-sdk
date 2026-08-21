import {
  createDacsBuyerAgreementTrackV1,
  createDacsSellerAgreementTrackV1,
  type DacsBuyerAgreementTrackOptionsV1,
  type DacsSellerAgreementTrackOptionsV1,
} from "./agreementRuntime.js";
import {
  createDacsBuyerAgreementTransportRuntimeV1,
  createDacsSellerAgreementTransportRuntimeV1,
  type DacsSellerAgreementTransportRuntimeOptionsV1,
} from "./agreementTransportRuntime.js";
import {
  createDacsBuyerAuditTrackV1,
  createDacsSellerAuditTrackV1,
  type DacsBuyerAuditRuntimeOptionsV1,
  type DacsSellerAuditRuntimeOptionsV1,
} from "./auditRuntime.js";
import {
  createDacsBuyerBundleTransportRuntimeV1,
  createDacsSellerBundleTransportRuntimeV1,
  type DacsBuyerBundleTransportRuntimeOptionsV1,
} from "./bundleTransportRuntime.js";
import {
  createDacsBuyerReceivedTrackV1,
  type DacsBuyerReceivedRuntimeOptionsV1,
} from "./buyerReceivedRuntime.js";
import {
  createDacsBuyerLiveCommerceGraphV1,
  createDacsSellerLiveCommerceGraphV1,
  type DacsBuyerLiveCommerceGraphV1,
  type DacsSellerLiveCommerceGraphV1,
} from "./liveCommerceGraph.js";
import {
  createDacsBuyerDemosPaymentEvidenceRuntimeV1,
  createDacsSellerPaymentEvidenceRuntimeV1,
  type DacsBuyerDemosPaymentEvidenceRuntimeOptionsV1,
  type DacsSellerPaymentEvidenceRuntimeOptionsV1,
} from "./paymentEvidenceRuntime.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";
import {
  createDacsSellerSettlementPublicationTrackV1,
  type DacsSellerSettlementPublicationTrackOptionsV1,
} from "./sellerSettlementRuntime.js";
import {
  createDacsSellerX402RuntimeV1,
  type DacsSellerX402RuntimeOptionsV1,
} from "./sellerX402Runtime.js";
import {
  createDacsBuyerSessionBootstrapTransportRuntimeV1,
  createDacsSellerSessionBootstrapTransportRuntimeV1,
  type DacsSellerSessionBootstrapTransportOptionsV1,
} from "./sessionBootstrapTransportRuntime.js";
import {
  createDacsX402BuyerRuntimePaymentTrackV1,
  type DacsX402BuyerRuntimePaymentTrackOptionsV1,
} from "./x402RuntimePayment.js";

export interface DacsBuyerLiveCommerceAssemblyOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  workerId: string;
  agreement: Readonly<Omit<
    DacsBuyerAgreementTrackOptionsV1,
    "context" | "workerId" | "transport"
  >>;
  payment: Readonly<Omit<
    DacsX402BuyerRuntimePaymentTrackOptionsV1,
    "context" | "workerId"
  >>;
  paymentEvidence: Readonly<Omit<
    DacsBuyerDemosPaymentEvidenceRuntimeOptionsV1,
    "context" | "workerId"
  >>;
  buyerReceived: Readonly<Omit<DacsBuyerReceivedRuntimeOptionsV1, "context">>;
  bundleTransport: Readonly<Omit<
    DacsBuyerBundleTransportRuntimeOptionsV1,
    "context"
  >>;
  audit: Readonly<Omit<
    DacsBuyerAuditRuntimeOptionsV1,
    "context" | "workerId" | "bundleTransport"
  >>;
}

export interface DacsSellerLiveCommerceAssemblyOptionsV1<T = unknown> {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  workerId: string;
  sessionBootstrap: Readonly<Omit<
    DacsSellerSessionBootstrapTransportOptionsV1,
    "context"
  >>;
  agreementTransport: Readonly<Omit<
    DacsSellerAgreementTransportRuntimeOptionsV1,
    "context"
  >>;
  agreement: Readonly<Omit<
    DacsSellerAgreementTrackOptionsV1,
    "context" | "workerId" | "resolveProposal" | "transport"
  >>;
  x402: Readonly<Omit<
    DacsSellerX402RuntimeOptionsV1<T>,
    "context" | "workerId"
  >>;
  paymentEvidence: Readonly<Omit<
    DacsSellerPaymentEvidenceRuntimeOptionsV1,
    "context" | "workerId"
  >>;
  settlement: Readonly<Omit<
    DacsSellerSettlementPublicationTrackOptionsV1,
    "context" | "paymentEvidence"
  >>;
  audit: Readonly<Omit<
    DacsSellerAuditRuntimeOptionsV1,
    "context" | "workerId" | "bundleTransport"
  >>;
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

function common(
  options: Readonly<{ context: Readonly<DacsLiveRoleOperationContextV1>; workerId: string }>,
  role: "buyer" | "seller",
): void {
  if (!plainObject(options) || !plainObject(options.context) ||
      options.context.role !== role || typeof options.workerId !== "string" ||
      options.workerId.length === 0 || options.workerId.trim() !== options.workerId) {
    throw new TypeError(`${role} live commerce assembly options are invalid`);
  }
}

/**
 * Assemble every buyer component once and connect the transport instances used
 * by the durable operations to the same instances used by inbound HTTP.
 */
export async function createDacsBuyerLiveCommerceAssemblyV1(
  options: Readonly<DacsBuyerLiveCommerceAssemblyOptionsV1>,
): Promise<Readonly<DacsBuyerLiveCommerceGraphV1>> {
  common(options, "buyer");
  const context = options.context;
  const sessionBootstrap = createDacsBuyerSessionBootstrapTransportRuntimeV1(context);
  const agreementTransport = createDacsBuyerAgreementTransportRuntimeV1(context);
  const paymentEvidence = createDacsBuyerDemosPaymentEvidenceRuntimeV1({
    ...options.paymentEvidence,
    context,
    workerId: options.workerId,
  });
  const bundleTransport = createDacsBuyerBundleTransportRuntimeV1({
    ...options.bundleTransport,
    context,
  });
  return createDacsBuyerLiveCommerceGraphV1({
    sessionBootstrap,
    agreement: createDacsBuyerAgreementTrackV1({
      ...options.agreement,
      context,
      workerId: options.workerId,
      transport: agreementTransport.transport,
    }),
    payment: createDacsX402BuyerRuntimePaymentTrackV1({
      ...options.payment,
      context,
      workerId: options.workerId,
    }),
    paymentEvidence,
    buyerReceived: createDacsBuyerReceivedTrackV1({
      ...options.buyerReceived,
      context,
    }),
    audit: createDacsBuyerAuditTrackV1({
      ...options.audit,
      context,
      workerId: options.workerId,
      bundleTransport: bundleTransport.transport,
    }),
    agreementTransport,
    bundleTransport,
  });
}

/**
 * Assemble every seller component once. In particular, the same x402 instance
 * supplies HTTP fulfilment plus payment/delivery projections, and the same
 * payment-evidence handshake supplies both settlement publication and inbound
 * completion verification.
 */
export async function createDacsSellerLiveCommerceAssemblyV1<T = unknown>(
  options: Readonly<DacsSellerLiveCommerceAssemblyOptionsV1<T>>,
): Promise<Readonly<DacsSellerLiveCommerceGraphV1>> {
  common(options, "seller");
  const context = options.context;
  const sessionBootstrap = createDacsSellerSessionBootstrapTransportRuntimeV1({
    ...options.sessionBootstrap,
    context,
  });
  const agreementTransport = createDacsSellerAgreementTransportRuntimeV1({
    ...options.agreementTransport,
    context,
  });
  const paymentEvidenceTransport = createDacsSellerPaymentEvidenceRuntimeV1({
    ...options.paymentEvidence,
    context,
    workerId: options.workerId,
  });
  const bundleTransport = createDacsSellerBundleTransportRuntimeV1(context);
  const x402 = await createDacsSellerX402RuntimeV1({
    ...options.x402,
    context,
    workerId: options.workerId,
  });
  return createDacsSellerLiveCommerceGraphV1({
    sessionBootstrap,
    agreement: createDacsSellerAgreementTrackV1({
      ...options.agreement,
      context,
      workerId: options.workerId,
      resolveProposal: ({ operation }) =>
        agreementTransport.resolveProposal({ operation }),
      transport: agreementTransport.transport,
    }),
    x402,
    paymentEvidence: createDacsSellerSettlementPublicationTrackV1({
      ...options.settlement,
      context,
      paymentEvidence: paymentEvidenceTransport,
    }),
    audit: createDacsSellerAuditTrackV1({
      ...options.audit,
      context,
      workerId: options.workerId,
      bundleTransport,
    }),
    agreementTransport,
    paymentEvidenceTransport,
    bundleTransport,
  });
}

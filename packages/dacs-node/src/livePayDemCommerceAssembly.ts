import type { BundleRequirement } from "@kynesyslabs/dacs/artifacts";
import type { FixedPricePayDemOrderInput } from "@kynesyslabs/dacs/commerce";

import {
  createDacsPayDemBuyerAgreementTrackV1,
  createDacsPayDemSellerAgreementTrackV1,
  type DacsPayDemBuyerAgreementTrackOptionsV1,
  type DacsPayDemSellerAgreementTrackOptionsV1,
} from "./agreementRuntime.js";
import {
  createDacsBuyerAgreementTransportRuntimeV1,
  createDacsSellerAgreementTransportRuntimeV1,
  type DacsAgreementSellerVetProductionV1,
  type DacsSellerAgreementTransportRuntimeOptionsV1,
} from "./agreementTransportRuntime.js";
import {
  createDacsPayDemBuyerAuditTrackV1,
  createDacsPayDemSellerAuditTrackV1,
  type DacsPayDemBuyerAuditRuntimeOptionsV1,
  type DacsPayDemSellerAuditRuntimeOptionsV1,
} from "./auditRuntime.js";
import {
  createDacsBuyerBundleTransportRuntimeV1,
  createDacsSellerBundleTransportRuntimeV1,
  type DacsBuyerBundleTransportRuntimeOptionsV1,
} from "./bundleTransportRuntime.js";
import {
  createDacsBuyerPayDemLiveCommerceGraphV1,
  createDacsSellerPayDemLiveCommerceGraphV1,
  type DacsBuyerPayDemLiveCommerceGraphV1,
  type DacsSellerPayDemLiveCommerceGraphV1,
} from "./livePayDemCommerceGraph.js";
import {
  createDacsPayDemBuyerPaymentTrackV1,
  type DacsPayDemBuyerPaymentTrackOptionsV1,
} from "./payDemPayment.js";
import {
  createDacsPayDemBuyerPaymentNoticePublisherV1,
  createDacsPayDemSellerPaymentNoticeRuntimeV1,
} from "./payDemPaymentNoticeRuntime.js";
import {
  createDacsPayDemBuyerReceivedTrackV1,
  type DacsPayDemBuyerReceivedRuntimeOptionsV1,
} from "./payDemBuyerReceivedRuntime.js";
import {
  createDacsPayDemSellerFulfilmentRuntimeV1,
  type DacsPayDemSellerFulfilmentRuntimeOptionsV1,
} from "./payDemSellerFulfilmentRuntime.js";
import {
  createDacsPayDemSellerPaymentTrackV1,
  type DacsPayDemSellerPaymentTrackOptionsV1,
} from "./payDemSellerPayment.js";
import {
  createDacsPayDemBuyerDemosPaymentEvidenceRuntimeV1,
  createDacsSellerPaymentEvidenceRuntimeV1,
  type DacsBuyerDemosPaymentEvidenceRuntimeOptionsV1,
  type DacsSellerPaymentEvidenceRuntimeOptionsV1,
} from "./paymentEvidenceRuntime.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";
import {
  createDacsPayDemSellerSettlementPublicationTrackV1,
  type DacsPayDemSellerSettlementPublicationTrackOptionsV1,
} from "./sellerSettlementRuntime.js";
import {
  createDacsPayDemBuyerSessionBootstrapAgreementTrackV1,
  createDacsPayDemSellerSessionBootstrapAgreementTrackV1,
  loadDacsPayDemBuyerSessionAgreementFactsForOrderV1,
  loadDacsPayDemBuyerSessionAgreementFactsV1,
  loadDacsPayDemSellerSessionAgreementFactsV1,
  type DacsPayDemBuyerSessionBootstrapAgreementTrackOptionsV1,
  type DacsPayDemSellerSessionBootstrapAgreementTrackOptionsV1,
} from "./sessionBootstrapAgreementRuntime.js";
import {
  createDacsBuyerSessionBootstrapTransportRuntimeV1,
  createDacsSellerSessionBootstrapTransportRuntimeV1,
  type DacsSellerSessionBootstrapTransportOptionsV1,
} from "./sessionBootstrapTransportRuntime.js";
import { authenticateDacsSessionVetProductionV1 } from
  "./sessionIdentityVetRuntime.js";

export interface DacsBuyerPayDemLiveCommerceAssemblyOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  workerId: string;
  sessionBootstrap: Readonly<Pick<
    DacsPayDemBuyerSessionBootstrapAgreementTrackOptionsV1,
    "resolveRequirements"
  >>;
  agreement: Readonly<Omit<
    DacsPayDemBuyerAgreementTrackOptionsV1,
    "context" | "workerId" | "transport" | "buildDraft"
  > & {
    buildDraft(input: Parameters<DacsPayDemBuyerAgreementTrackOptionsV1["buildDraft"]>[0] &
      Readonly<{ session: ReturnType<typeof loadDacsPayDemBuyerSessionAgreementFactsV1> }>):
      ReturnType<DacsPayDemBuyerAgreementTrackOptionsV1["buildDraft"]>;
  }>;
  payment: Readonly<Omit<
    DacsPayDemBuyerPaymentTrackOptionsV1,
    "database" | "workerId" | "rail" | "publishNotice"
  >>;
  paymentEvidence: Readonly<Omit<
    DacsBuyerDemosPaymentEvidenceRuntimeOptionsV1,
    "context" | "workerId"
  >>;
  buyerReceived: Readonly<Omit<DacsPayDemBuyerReceivedRuntimeOptionsV1, "context">>;
  bundleTransport: Readonly<Omit<
    DacsBuyerBundleTransportRuntimeOptionsV1,
    "context"
  >>;
  audit: Readonly<Omit<
    DacsPayDemBuyerAuditRuntimeOptionsV1,
    "context" | "workerId" | "bundleTransport"
  >>;
}

export interface DacsSellerPayDemLiveCommerceAssemblyOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  workerId: string;
  sessionBootstrap: Readonly<Omit<
    DacsSellerSessionBootstrapTransportOptionsV1<FixedPricePayDemOrderInput>,
    "context"
  > & Pick<
    DacsPayDemSellerSessionBootstrapAgreementTrackOptionsV1,
    "resolveBuyerRequirement"
  > & {
    resolveSellerRequirement(input: Readonly<{
      operation: Parameters<DacsPayDemSellerAgreementTrackOptionsV1[
        "resolveAuthenticatedAgreementContext"
      ]>[0]["operation"];
      retained: Parameters<DacsPayDemSellerAgreementTrackOptionsV1[
        "resolveAuthenticatedAgreementContext"
      ]>[0]["retained"];
      session: ReturnType<typeof loadDacsPayDemSellerSessionAgreementFactsV1>;
    }>): Promise<Readonly<BundleRequirement>> | Readonly<BundleRequirement>;
  }>;
  agreementTransport: Readonly<Omit<
    DacsSellerAgreementTransportRuntimeOptionsV1<FixedPricePayDemOrderInput>,
    "context"
  >>;
  agreement: Readonly<Omit<
    DacsPayDemSellerAgreementTrackOptionsV1,
    "context" | "workerId" | "resolveProposal" | "transport" |
      "resolveAuthenticatedAgreementContext"
  > & {
    resolveAuthenticatedAgreementContext(input:
      Parameters<DacsPayDemSellerAgreementTrackOptionsV1[
        "resolveAuthenticatedAgreementContext"
      ]>[0] & Readonly<{
        session: ReturnType<typeof loadDacsPayDemSellerSessionAgreementFactsV1>;
        sellerVet: Readonly<DacsAgreementSellerVetProductionV1>;
        sellerRequirement: Readonly<BundleRequirement>;
      }>): ReturnType<DacsPayDemSellerAgreementTrackOptionsV1[
        "resolveAuthenticatedAgreementContext"
      ]>;
  }>;
  payment: Readonly<Omit<
    DacsPayDemSellerPaymentTrackOptionsV1,
    "database" | "workerId" | "noticeRuntime"
  >>;
  paymentEvidence: Readonly<Omit<
    DacsSellerPaymentEvidenceRuntimeOptionsV1,
    "context" | "workerId"
  >>;
  settlement: Readonly<Omit<
    DacsPayDemSellerSettlementPublicationTrackOptionsV1,
    "context" | "paymentEvidence"
  >>;
  fulfilment: Readonly<Omit<
    DacsPayDemSellerFulfilmentRuntimeOptionsV1,
    "context" | "workerId"
  >>;
  audit: Readonly<Omit<
    DacsPayDemSellerAuditRuntimeOptionsV1,
    "context" | "workerId" | "bundleTransport"
  >>;
}

function plainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function common(
  options: Readonly<{ context: Readonly<DacsLiveRoleOperationContextV1>; workerId: string }>,
  role: "buyer" | "seller",
): void {
  if (!plainObject(options) || !plainObject(options.context) ||
      options.context.role !== role || typeof options.workerId !== "string" ||
      options.workerId.length === 0 || options.workerId.trim() !== options.workerId) {
    throw new TypeError(`${role} pay-DEM live commerce assembly options are invalid`);
  }
}

export async function createDacsBuyerPayDemLiveCommerceAssemblyV1(
  options: Readonly<DacsBuyerPayDemLiveCommerceAssemblyOptionsV1>,
): Promise<Readonly<DacsBuyerPayDemLiveCommerceGraphV1>> {
  common(options, "buyer");
  const context = options.context;
  if (context.demos.payDem === undefined) {
    throw new TypeError("buyer pay-DEM live commerce assembly requires native wallet authority");
  }
  const sessionBootstrap = createDacsBuyerSessionBootstrapTransportRuntimeV1(context);
  const agreementTransport = createDacsBuyerAgreementTransportRuntimeV1({
    context,
    resolveSellerVetProduction: ({ order }) => {
      const facts = loadDacsPayDemBuyerSessionAgreementFactsForOrderV1(
        context,
        order as never,
      );
      return Object.freeze({
        record: facts.sellerVetRecord,
        recordRef: facts.sellerVetRef,
        anchorReceipt: facts.sellerVetReceipt,
      });
    },
  });
  const paymentEvidence = createDacsPayDemBuyerDemosPaymentEvidenceRuntimeV1({
    ...options.paymentEvidence,
    context,
    workerId: options.workerId,
  });
  const bundleTransport = createDacsBuyerBundleTransportRuntimeV1({
    ...options.bundleTransport,
    context,
  });
  const agreement = createDacsPayDemBuyerAgreementTrackV1({
    ...options.agreement,
    buildDraft: (input) => options.agreement.buildDraft({
      ...input,
      session: loadDacsPayDemBuyerSessionAgreementFactsV1(context, input.operation),
    }),
    context,
    workerId: options.workerId,
    transport: agreementTransport.transport,
  });
  return createDacsBuyerPayDemLiveCommerceGraphV1({
    sessionBootstrap,
    agreement: createDacsPayDemBuyerSessionBootstrapAgreementTrackV1({
      context,
      sessionBootstrap,
      resolveRequirements: options.sessionBootstrap.resolveRequirements,
      agreement,
    }),
    payment: createDacsPayDemBuyerPaymentTrackV1({
      ...options.payment,
      database: context.database,
      workerId: options.workerId,
      rail: context.demos.payDem.rail,
      publishNotice: createDacsPayDemBuyerPaymentNoticePublisherV1(context),
    }),
    paymentEvidence,
    buyerReceived: createDacsPayDemBuyerReceivedTrackV1({
      ...options.buyerReceived,
      context,
    }),
    audit: createDacsPayDemBuyerAuditTrackV1({
      ...options.audit,
      context,
      workerId: options.workerId,
      bundleTransport: bundleTransport.transport,
    }),
    agreementTransport,
    bundleTransport,
  });
}

export async function createDacsSellerPayDemLiveCommerceAssemblyV1(
  options: Readonly<DacsSellerPayDemLiveCommerceAssemblyOptionsV1>,
): Promise<Readonly<DacsSellerPayDemLiveCommerceGraphV1>> {
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
  const paymentNotice = createDacsPayDemSellerPaymentNoticeRuntimeV1(context);
  const paymentEvidenceTransport = createDacsSellerPaymentEvidenceRuntimeV1({
    ...options.paymentEvidence,
    context,
    workerId: options.workerId,
  });
  const bundleTransport = createDacsSellerBundleTransportRuntimeV1(context);
  const agreement = createDacsPayDemSellerAgreementTrackV1({
    ...options.agreement,
    context,
    workerId: options.workerId,
    resolveProposal: ({ operation }) =>
      agreementTransport.resolveProposal({ operation: operation as never }),
    resolveAuthenticatedAgreementContext: async (input) => {
      const session = loadDacsPayDemSellerSessionAgreementFactsV1(
        context,
        input.operation,
      );
      const sellerVet = await agreementTransport.resolveSellerVetProduction({
        operation: input.operation as never,
      });
      const sellerRequirement = await options.sessionBootstrap.resolveSellerRequirement({
        operation: input.operation,
        retained: input.retained,
        session,
      });
      const authentication = await authenticateDacsSessionVetProductionV1({
        context,
        jobId: input.operation.order.jobId,
        evaluatedIdentity: session.sellerIdentity,
        requirement: sellerRequirement,
        verifier: input.operation.order.buyer,
        production: sellerVet,
      });
      if (authentication !== "valid") {
        return authentication === "invalid"
          ? Object.freeze({ disposition: "rejected" as const,
              reason: "seller-vet-production-invalid" })
          : Object.freeze({ disposition: "indeterminate" as const,
              reason: "seller-vet-production-unavailable" });
      }
      return options.agreement.resolveAuthenticatedAgreementContext({
        ...input,
        session,
        sellerVet,
        sellerRequirement,
      });
    },
    transport: agreementTransport.transport,
  });
  const payment = createDacsPayDemSellerPaymentTrackV1({
    ...options.payment,
    database: context.database,
    workerId: options.workerId,
    noticeRuntime: paymentNotice,
  });
  const fulfilment = createDacsPayDemSellerFulfilmentRuntimeV1({
    ...options.fulfilment,
    context,
    workerId: options.workerId,
  });
  return createDacsSellerPayDemLiveCommerceGraphV1({
    sessionBootstrap,
    agreement: createDacsPayDemSellerSessionBootstrapAgreementTrackV1({
      context,
      sessionBootstrap,
      resolveBuyerRequirement: options.sessionBootstrap.resolveBuyerRequirement,
      agreementProposalReady: async ({ operation }) => {
        try {
          await agreementTransport.resolveProposal({ operation: operation as never });
          return true;
        } catch {
          return false;
        }
      },
      agreement,
    }),
    paymentNotice,
    payment,
    paymentEvidence: createDacsPayDemSellerSettlementPublicationTrackV1({
      ...options.settlement,
      context,
      paymentEvidence: paymentEvidenceTransport,
    }),
    delivery: fulfilment.delivery,
    deliveryEvidence: fulfilment.deliveryEvidence,
    audit: createDacsPayDemSellerAuditTrackV1({
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

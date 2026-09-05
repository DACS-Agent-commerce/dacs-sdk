import {
  createDacsBuyerAgreementTrackV1,
  createDacsSellerAgreementTrackV1,
  type DacsBuyerAgreementTrackOptionsV1,
  type DacsSellerAgreementTrackOptionsV1,
} from "./agreementRuntime.js";
import {
  createDacsBuyerAgreementTransportRuntimeV1,
  createDacsSellerAgreementTransportRuntimeV1,
  type DacsAgreementSellerVetProductionV1,
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
  createDacsBuyerSessionBootstrapAgreementTrackV1,
  createDacsSellerSessionBootstrapAgreementTrackV1,
  advanceDacsVetTerminalTrackV1,
  loadDacsBuyerSessionAgreementFactsForOrderV1,
  loadDacsBuyerSessionAgreementFactsV1,
  loadDacsSellerSessionAgreementFactsV1,
  type DacsSessionVetTerminalTrackV1,
  type DacsBuyerSessionBootstrapAgreementTrackOptionsV1,
  type DacsSellerSessionBootstrapAgreementTrackOptionsV1,
} from "./sessionBootstrapAgreementRuntime.js";
import {
  createDacsBuyerSessionBootstrapTransportRuntimeV1,
  createDacsSellerSessionBootstrapTransportRuntimeV1,
  type DacsSellerSessionBootstrapTransportOptionsV1,
} from "./sessionBootstrapTransportRuntime.js";
import {
  createDacsX402BuyerRuntimePaymentTrackV1,
  type DacsX402BuyerRuntimePaymentTrackOptionsV1,
} from "./x402RuntimePayment.js";
import type { BundleRequirement } from "@kynesyslabs/dacs/artifacts";
import {
  authenticateDacsSessionVetProductionV1,
  type DacsSessionVetRuntimeV1,
} from "./sessionIdentityVetRuntime.js";
import {
  createDacsVetTerminalBundleTransportRuntimeV1,
  type DacsVetTerminalBundleTransportOptionsV1,
} from "./terminalBundleTransportRuntime.js";

export interface DacsBuyerLiveCommerceAssemblyOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  workerId: string;
  sessionBootstrap: Readonly<Pick<
    DacsBuyerSessionBootstrapAgreementTrackOptionsV1,
    "resolveRequirements"
  > & { vet?: Readonly<DacsSessionVetRuntimeV1> }>;
  agreement: Readonly<Omit<
    DacsBuyerAgreementTrackOptionsV1,
    "context" | "workerId" | "transport" | "buildDraft"
  > & {
    buildDraft(input: Parameters<DacsBuyerAgreementTrackOptionsV1["buildDraft"]>[0] &
      Readonly<{ session: ReturnType<typeof loadDacsBuyerSessionAgreementFactsV1> }>):
      ReturnType<DacsBuyerAgreementTrackOptionsV1["buildDraft"]>;
  }>;
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
  terminalBundle?: Readonly<Omit<
    DacsVetTerminalBundleTransportOptionsV1,
    "context"
  > & Pick<DacsSessionVetTerminalTrackV1, "createInput">>;
}

export interface DacsSellerLiveCommerceAssemblyOptionsV1<T = unknown> {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  workerId: string;
  sessionBootstrap: Readonly<Omit<
    DacsSellerSessionBootstrapTransportOptionsV1,
    "context"
  > & Pick<
    DacsSellerSessionBootstrapAgreementTrackOptionsV1,
    "resolveBuyerRequirement"
  > & {
    /** Explicit local policy for the buyer-produced Vet of this seller. */
    resolveSellerRequirement(input: Readonly<{
      operation: Parameters<DacsSellerAgreementTrackOptionsV1[
        "resolveAuthenticatedAgreementContext"
      ]>[0]["operation"];
      retained: Parameters<DacsSellerAgreementTrackOptionsV1[
        "resolveAuthenticatedAgreementContext"
      ]>[0]["retained"];
      session: ReturnType<typeof loadDacsSellerSessionAgreementFactsV1>;
    }>): Promise<Readonly<BundleRequirement>> | Readonly<BundleRequirement>;
  } & { vet?: Readonly<DacsSessionVetRuntimeV1> }>;
  agreementTransport: Readonly<Omit<
    DacsSellerAgreementTransportRuntimeOptionsV1,
    "context"
  >>;
  agreement: Readonly<Omit<
    DacsSellerAgreementTrackOptionsV1,
    "context" | "workerId" | "resolveProposal" | "transport" |
      "resolveAuthenticatedAgreementContext"
  > & {
    resolveAuthenticatedAgreementContext(input:
      Parameters<DacsSellerAgreementTrackOptionsV1[
        "resolveAuthenticatedAgreementContext"
      ]>[0] & Readonly<{
        session: ReturnType<typeof loadDacsSellerSessionAgreementFactsV1>;
        sellerVet: Readonly<DacsAgreementSellerVetProductionV1>;
        sellerRequirement: Readonly<BundleRequirement>;
      }>): ReturnType<DacsSellerAgreementTrackOptionsV1[
        "resolveAuthenticatedAgreementContext"
      ]>;
  }>;
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
  terminalBundle?: Readonly<Omit<
    DacsVetTerminalBundleTransportOptionsV1,
    "context"
  > & Pick<DacsSessionVetTerminalTrackV1, "createInput">>;
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
  const agreementTransport = createDacsBuyerAgreementTransportRuntimeV1({
    context,
    resolveSellerVetProduction: ({ order }) => {
      const facts = loadDacsBuyerSessionAgreementFactsForOrderV1(context, order);
      return Object.freeze({
        record: facts.sellerVetRecord,
        recordRef: facts.sellerVetRef,
        anchorReceipt: facts.sellerVetReceipt,
      });
    },
  });
  const paymentEvidence = createDacsBuyerDemosPaymentEvidenceRuntimeV1({
    ...options.paymentEvidence,
    context,
    workerId: options.workerId,
  });
  const bundleTransport = createDacsBuyerBundleTransportRuntimeV1({
    ...options.bundleTransport,
    context,
  });
  const terminalBundleTransport = options.terminalBundle === undefined
    ? undefined : createDacsVetTerminalBundleTransportRuntimeV1({
        context,
        authenticateProduction: options.terminalBundle.authenticateProduction,
      });
  const agreement = createDacsBuyerAgreementTrackV1({
    ...options.agreement,
    buildDraft: (input) => options.agreement.buildDraft({
      ...input,
      session: loadDacsBuyerSessionAgreementFactsV1(context, input.operation),
    }),
    context,
    workerId: options.workerId,
    transport: agreementTransport.transport,
  });
  const audit = createDacsBuyerAuditTrackV1({
    ...options.audit,
    context,
    workerId: options.workerId,
    bundleTransport: bundleTransport.transport,
  });
  return createDacsBuyerLiveCommerceGraphV1({
    sessionBootstrap,
    agreement: createDacsBuyerSessionBootstrapAgreementTrackV1({
      context,
      sessionBootstrap,
      resolveRequirements: options.sessionBootstrap.resolveRequirements,
      agreement,
      ...(options.sessionBootstrap.vet === undefined
        ? {} : { vet: options.sessionBootstrap.vet }),
      ...(terminalBundleTransport === undefined || options.terminalBundle === undefined
        ? {} : { terminalBundle: {
            runtime: terminalBundleTransport,
            createInput: options.terminalBundle.createInput,
          } }),
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
    audit: terminalBundleTransport === undefined ? audit : async (operation) => {
      const terminal = await advanceDacsVetTerminalTrackV1(
        terminalBundleTransport,
        context,
        options.audit.retryDelayMs ?? 1_000,
        operation.order.jobId,
      );
      return terminal ?? await audit(operation);
    },
    agreementTransport,
    bundleTransport,
    ...(terminalBundleTransport === undefined ? {} : { terminalBundleTransport }),
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
  const terminalBundleTransport = options.terminalBundle === undefined
    ? undefined : createDacsVetTerminalBundleTransportRuntimeV1({
        context,
        authenticateProduction: options.terminalBundle.authenticateProduction,
      });
  const x402 = await createDacsSellerX402RuntimeV1({
    ...options.x402,
    context,
    workerId: options.workerId,
  });
  const agreement = createDacsSellerAgreementTrackV1({
    ...options.agreement,
    context,
    workerId: options.workerId,
    resolveProposal: ({ operation }) =>
      agreementTransport.resolveProposal({ operation }),
    resolveAuthenticatedAgreementContext: async (input) => {
      const session = loadDacsSellerSessionAgreementFactsV1(context, input.operation);
      const sellerVet = await agreementTransport.resolveSellerVetProduction({
        operation: input.operation,
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
  const audit = createDacsSellerAuditTrackV1({
    ...options.audit,
    context,
    workerId: options.workerId,
    bundleTransport,
  });
  return createDacsSellerLiveCommerceGraphV1({
    sessionBootstrap,
    agreement: createDacsSellerSessionBootstrapAgreementTrackV1({
      context,
      sessionBootstrap,
      resolveBuyerRequirement: options.sessionBootstrap.resolveBuyerRequirement,
      agreementProposalReady: async ({ operation }) => {
        try {
          await agreementTransport.resolveProposal({ operation });
          return true;
        } catch {
          return false;
        }
      },
      agreement,
      ...(options.sessionBootstrap.vet === undefined
        ? {} : { vet: options.sessionBootstrap.vet }),
      ...(terminalBundleTransport === undefined || options.terminalBundle === undefined
        ? {} : { terminalBundle: {
            runtime: terminalBundleTransport,
            createInput: options.terminalBundle.createInput,
          } }),
    }),
    x402,
    paymentEvidence: createDacsSellerSettlementPublicationTrackV1({
      ...options.settlement,
      context,
      paymentEvidence: paymentEvidenceTransport,
    }),
    audit: terminalBundleTransport === undefined ? audit : async (operation) => {
      const terminal = await advanceDacsVetTerminalTrackV1(
        terminalBundleTransport,
        context,
        options.audit.retryDelayMs ?? 1_000,
        operation.order.jobId,
      );
      return terminal ?? await audit(operation);
    },
    agreementTransport,
    paymentEvidenceTransport,
    bundleTransport,
    ...(terminalBundleTransport === undefined ? {} : { terminalBundleTransport }),
  });
}

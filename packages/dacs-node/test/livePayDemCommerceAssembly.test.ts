import { beforeEach, describe, expect, it, vi } from "vitest";

const factories = vi.hoisted(() => ({
  buyerAgreement: vi.fn(),
  sellerAgreement: vi.fn(),
  buyerAgreementTransport: vi.fn(),
  sellerAgreementTransport: vi.fn(),
  buyerAudit: vi.fn(),
  sellerAudit: vi.fn(),
  buyerBundleTransport: vi.fn(),
  sellerBundleTransport: vi.fn(),
  buyerGraph: vi.fn(),
  sellerGraph: vi.fn(),
  buyerPayment: vi.fn(),
  buyerNoticePublisher: vi.fn(),
  sellerNotice: vi.fn(),
  sellerPayment: vi.fn(),
  buyerReceived: vi.fn(),
  sellerFulfilment: vi.fn(),
  buyerPaymentEvidence: vi.fn(),
  sellerPaymentEvidence: vi.fn(),
  sellerSettlement: vi.fn(),
  buyerSessionBootstrap: vi.fn(),
  sellerSessionBootstrap: vi.fn(),
  buyerSessionAgreement: vi.fn(),
  sellerSessionAgreement: vi.fn(),
  authenticateSellerVet: vi.fn(),
  terminalBundleTransport: vi.fn(),
  advanceTerminal: vi.fn(),
}));

vi.mock("../src/agreementRuntime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agreementRuntime.js")>()),
  createDacsPayDemBuyerAgreementTrackV1: factories.buyerAgreement,
  createDacsPayDemSellerAgreementTrackV1: factories.sellerAgreement,
}));
vi.mock("../src/agreementTransportRuntime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agreementTransportRuntime.js")>()),
  createDacsBuyerAgreementTransportRuntimeV1: factories.buyerAgreementTransport,
  createDacsSellerAgreementTransportRuntimeV1: factories.sellerAgreementTransport,
}));
vi.mock("../src/auditRuntime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/auditRuntime.js")>()),
  createDacsPayDemBuyerAuditTrackV1: factories.buyerAudit,
  createDacsPayDemSellerAuditTrackV1: factories.sellerAudit,
}));
vi.mock("../src/bundleTransportRuntime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/bundleTransportRuntime.js")>()),
  createDacsBuyerBundleTransportRuntimeV1: factories.buyerBundleTransport,
  createDacsSellerBundleTransportRuntimeV1: factories.sellerBundleTransport,
}));
vi.mock("../src/livePayDemCommerceGraph.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/livePayDemCommerceGraph.js")>()),
  createDacsBuyerPayDemLiveCommerceGraphV1: factories.buyerGraph,
  createDacsSellerPayDemLiveCommerceGraphV1: factories.sellerGraph,
}));
vi.mock("../src/payDemPayment.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/payDemPayment.js")>()),
  createDacsPayDemBuyerPaymentTrackV1: factories.buyerPayment,
}));
vi.mock("../src/payDemPaymentNoticeRuntime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/payDemPaymentNoticeRuntime.js")>()),
  createDacsPayDemBuyerPaymentNoticePublisherV1: factories.buyerNoticePublisher,
  createDacsPayDemSellerPaymentNoticeRuntimeV1: factories.sellerNotice,
}));
vi.mock("../src/payDemSellerPayment.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/payDemSellerPayment.js")>()),
  createDacsPayDemSellerPaymentTrackV1: factories.sellerPayment,
}));
vi.mock("../src/payDemBuyerReceivedRuntime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/payDemBuyerReceivedRuntime.js")>()),
  createDacsPayDemBuyerReceivedTrackV1: factories.buyerReceived,
}));
vi.mock("../src/payDemSellerFulfilmentRuntime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/payDemSellerFulfilmentRuntime.js")>()),
  createDacsPayDemSellerFulfilmentRuntimeV1: factories.sellerFulfilment,
}));
vi.mock("../src/paymentEvidenceRuntime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/paymentEvidenceRuntime.js")>()),
  createDacsPayDemBuyerDemosPaymentEvidenceRuntimeV1: factories.buyerPaymentEvidence,
  createDacsSellerPaymentEvidenceRuntimeV1: factories.sellerPaymentEvidence,
}));
vi.mock("../src/sellerSettlementRuntime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sellerSettlementRuntime.js")>()),
  createDacsPayDemSellerSettlementPublicationTrackV1: factories.sellerSettlement,
}));
vi.mock("../src/sessionBootstrapTransportRuntime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sessionBootstrapTransportRuntime.js")>()),
  createDacsBuyerSessionBootstrapTransportRuntimeV1: factories.buyerSessionBootstrap,
  createDacsSellerSessionBootstrapTransportRuntimeV1: factories.sellerSessionBootstrap,
}));
vi.mock("../src/sessionBootstrapAgreementRuntime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sessionBootstrapAgreementRuntime.js")>()),
  createDacsPayDemBuyerSessionBootstrapAgreementTrackV1: factories.buyerSessionAgreement,
  createDacsPayDemSellerSessionBootstrapAgreementTrackV1: factories.sellerSessionAgreement,
  advanceDacsVetTerminalTrackV1: factories.advanceTerminal,
  loadDacsPayDemBuyerSessionAgreementFactsV1: vi.fn(() => ({ session: true })),
  loadDacsPayDemBuyerSessionAgreementFactsForOrderV1: vi.fn(() => ({
    sellerVetRecord: "seller-vet-record",
    sellerVetRef: "seller-vet-ref",
    sellerVetReceipt: "seller-vet-receipt",
  })),
  loadDacsPayDemSellerSessionAgreementFactsV1: vi.fn(() => ({
    sellerIdentity: { presentedBy: "seller" },
    session: true,
  })),
}));
vi.mock("../src/terminalBundleTransportRuntime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/terminalBundleTransportRuntime.js")>()),
  createDacsVetTerminalBundleTransportRuntimeV1: factories.terminalBundleTransport,
}));
vi.mock("../src/sessionIdentityVetRuntime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sessionIdentityVetRuntime.js")>()),
  authenticateDacsSessionVetProductionV1: factories.authenticateSellerVet,
}));

import {
  createDacsBuyerPayDemLiveCommerceAssemblyV1,
  createDacsSellerPayDemLiveCommerceAssemblyV1,
} from "../src/livePayDemCommerceAssembly.js";

describe("native DEM one-factory live assembly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    factories.buyerAgreement.mockReturnValue("buyer-agreement");
    factories.sellerAgreement.mockReturnValue("seller-agreement");
    factories.buyerAgreementTransport.mockReturnValue({
      transport: "buyer-agreement-transport",
      resolveSellerVetProduction: vi.fn(),
    });
    factories.sellerAgreementTransport.mockReturnValue({
      transport: "seller-agreement-transport",
      resolveProposal: vi.fn(async () => ({ proposal: true })),
      resolveSellerVetProduction: vi.fn(async () => ({ record: {}, recordRef: {}, anchorReceipt: {} })),
    });
    factories.buyerBundleTransport.mockReturnValue({ transport: "buyer-bundle-transport" });
    factories.sellerBundleTransport.mockReturnValue("seller-bundle-transport");
    factories.buyerAudit.mockReturnValue("buyer-audit");
    factories.sellerAudit.mockReturnValue("seller-audit");
    factories.buyerPayment.mockReturnValue("buyer-payment");
    factories.buyerNoticePublisher.mockReturnValue("buyer-notice-publisher");
    factories.sellerNotice.mockReturnValue("seller-notice");
    factories.sellerPayment.mockReturnValue("seller-payment");
    factories.buyerReceived.mockReturnValue("buyer-received");
    factories.sellerFulfilment.mockReturnValue({
      delivery: "seller-delivery",
      deliveryEvidence: "seller-delivery-evidence",
    });
    factories.buyerPaymentEvidence.mockReturnValue("buyer-payment-evidence");
    factories.sellerPaymentEvidence.mockReturnValue("seller-payment-evidence-transport");
    factories.sellerSettlement.mockReturnValue("seller-payment-evidence");
    factories.buyerSessionBootstrap.mockReturnValue("buyer-session-bootstrap");
    factories.sellerSessionBootstrap.mockReturnValue("seller-session-bootstrap");
    factories.buyerSessionAgreement.mockReturnValue("buyer-session-agreement");
    factories.sellerSessionAgreement.mockReturnValue("seller-session-agreement");
    factories.authenticateSellerVet.mockResolvedValue("valid");
    factories.terminalBundleTransport.mockReturnValue({ terminal: true });
    factories.advanceTerminal.mockResolvedValue(undefined);
    factories.buyerGraph.mockImplementation((value) => ({ role: "buyer", value }));
    factories.sellerGraph.mockImplementation((value) => ({ role: "seller", value }));
  });

  it("uses the actor-owned rail and durable notice publisher for buyer payment", async () => {
    const rail = { address: "aa".repeat(32), settle: vi.fn() };
    const database = { role: "buyer-database" };
    const context = { role: "buyer", demos: { payDem: { rail } }, database };
    const result = await createDacsBuyerPayDemLiveCommerceAssemblyV1({
      context,
      workerId: "buyer-worker",
      sessionBootstrap: { resolveRequirements: vi.fn() },
      agreement: { buildDraft: vi.fn() },
      payment: { resolveAuthority: vi.fn(), reconcile: vi.fn() },
      paymentEvidence: { verifyEvidence: vi.fn() },
      buyerReceived: { authorizeReceived: vi.fn() },
      bundleTransport: { resolveVerification: vi.fn() },
      audit: { resolveMaterial: vi.fn() },
    } as never);

    expect(result).toMatchObject({ role: "buyer" });
    expect(factories.buyerPayment).toHaveBeenCalledWith(expect.objectContaining({
      database,
      workerId: "buyer-worker",
      rail,
      publishNotice: "buyer-notice-publisher",
    }));
    expect(factories.buyerGraph.mock.calls[0]![0]).toMatchObject({
      payment: "buyer-payment",
      paymentEvidence: "buyer-payment-evidence",
      buyerReceived: "buyer-received",
      audit: "buyer-audit",
    });
  });

  it("uses one authenticated seller notice and fulfilment authority throughout", async () => {
    const database = { role: "seller-database" };
    const context = { role: "seller", database };
    const result = await createDacsSellerPayDemLiveCommerceAssemblyV1({
      context,
      workerId: "seller-worker",
      sessionBootstrap: {
        admitInit: vi.fn(),
        resolveBuyerRequirement: vi.fn(),
        resolveSellerRequirement: vi.fn(() => ({ requirementVersion: "1", required: [] })),
      },
      agreementTransport: { admitProposal: vi.fn() },
      agreement: { resolveAuthenticatedAgreementContext: vi.fn() },
      payment: { resolvePayerPayingKey: vi.fn(), intakeDeps: {} },
      paymentEvidence: {},
      settlement: { resolvePublication: vi.fn() },
      fulfilment: { fulfilment: {} },
      audit: { resolveMaterial: vi.fn() },
    } as never);

    expect(result).toMatchObject({ role: "seller" });
    expect(factories.sellerPayment).toHaveBeenCalledWith(expect.objectContaining({
      database,
      workerId: "seller-worker",
      noticeRuntime: "seller-notice",
    }));
    expect(factories.sellerSettlement).toHaveBeenCalledWith(expect.objectContaining({
      context,
      paymentEvidence: "seller-payment-evidence-transport",
    }));
    expect(factories.sellerGraph.mock.calls[0]![0]).toMatchObject({
      paymentNotice: "seller-notice",
      payment: "seller-payment",
      delivery: "seller-delivery",
      deliveryEvidence: "seller-delivery-evidence",
    });
  });

  it("rejects buyer assembly without native wallet authority", async () => {
    await expect(createDacsBuyerPayDemLiveCommerceAssemblyV1({
      context: { role: "buyer", demos: {}, database: {} },
      workerId: "buyer-worker",
    } as never)).rejects.toThrow(/requires native wallet authority/);
    expect(factories.buyerPayment).not.toHaveBeenCalled();
  });

  it("projects a recovered Vet terminal result through seller audit without success material", async () => {
    const context = { role: "seller", database: {} };
    const normalAudit = vi.fn(async () => ({ status: "final", outcome: "success" }));
    const terminalResult = Object.freeze({
      status: "final",
      outcome: "failure",
      errorClass: "counterparty",
      faultedParty: "buyer",
      reference: "terminal-native-address",
      authenticationHash: "terminal-plan-hash",
    });
    factories.sellerAudit.mockReturnValueOnce(normalAudit);
    factories.advanceTerminal.mockResolvedValueOnce(terminalResult);

    await createDacsSellerPayDemLiveCommerceAssemblyV1({
      context,
      workerId: "seller-worker",
      sessionBootstrap: {
        admitInit: vi.fn(),
        resolveBuyerRequirement: vi.fn(),
        resolveSellerRequirement: vi.fn(() => ({ requirementVersion: "1", required: [] })),
      },
      agreementTransport: { admitProposal: vi.fn() },
      agreement: { resolveAuthenticatedAgreementContext: vi.fn() },
      payment: { resolvePayerPayingKey: vi.fn(), intakeDeps: {} },
      paymentEvidence: {},
      settlement: { resolvePublication: vi.fn() },
      fulfilment: { fulfilment: {} },
      audit: { resolveMaterial: vi.fn(), retryDelayMs: 29 },
      terminalBundle: {
        authenticateProduction: vi.fn(),
        createInput: vi.fn(),
      },
    } as never);

    const graph = factories.sellerGraph.mock.calls[0]![0];
    await expect(graph.audit({ order: { jobId: "job-terminal" } }))
      .resolves.toBe(terminalResult);
    expect(factories.advanceTerminal).toHaveBeenCalledWith(
      { terminal: true },
      context,
      29,
      "job-terminal",
    );
    expect(normalAudit).not.toHaveBeenCalled();
    expect(factories.sellerSessionAgreement.mock.calls[0]![0].terminalBundle)
      .toMatchObject({ runtime: { terminal: true } });
  });
});

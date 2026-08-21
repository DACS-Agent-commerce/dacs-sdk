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
  buyerReceived: vi.fn(),
  buyerGraph: vi.fn(),
  sellerGraph: vi.fn(),
  buyerPaymentEvidence: vi.fn(),
  sellerPaymentEvidence: vi.fn(),
  sellerSettlement: vi.fn(),
  sellerX402: vi.fn(),
  buyerPayment: vi.fn(),
  buyerSessionBootstrap: vi.fn(),
  sellerSessionBootstrap: vi.fn(),
}));

vi.mock("../src/agreementRuntime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agreementRuntime.js")>()),
  createDacsBuyerAgreementTrackV1: factories.buyerAgreement,
  createDacsSellerAgreementTrackV1: factories.sellerAgreement,
}));
vi.mock("../src/agreementTransportRuntime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agreementTransportRuntime.js")>()),
  createDacsBuyerAgreementTransportRuntimeV1: factories.buyerAgreementTransport,
  createDacsSellerAgreementTransportRuntimeV1: factories.sellerAgreementTransport,
}));
vi.mock("../src/auditRuntime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/auditRuntime.js")>()),
  createDacsBuyerAuditTrackV1: factories.buyerAudit,
  createDacsSellerAuditTrackV1: factories.sellerAudit,
}));
vi.mock("../src/bundleTransportRuntime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/bundleTransportRuntime.js")>()),
  createDacsBuyerBundleTransportRuntimeV1: factories.buyerBundleTransport,
  createDacsSellerBundleTransportRuntimeV1: factories.sellerBundleTransport,
}));
vi.mock("../src/buyerReceivedRuntime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/buyerReceivedRuntime.js")>()),
  createDacsBuyerReceivedTrackV1: factories.buyerReceived,
}));
vi.mock("../src/liveCommerceGraph.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/liveCommerceGraph.js")>()),
  createDacsBuyerLiveCommerceGraphV1: factories.buyerGraph,
  createDacsSellerLiveCommerceGraphV1: factories.sellerGraph,
}));
vi.mock("../src/paymentEvidenceRuntime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/paymentEvidenceRuntime.js")>()),
  createDacsBuyerDemosPaymentEvidenceRuntimeV1: factories.buyerPaymentEvidence,
  createDacsSellerPaymentEvidenceRuntimeV1: factories.sellerPaymentEvidence,
}));
vi.mock("../src/sellerSettlementRuntime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sellerSettlementRuntime.js")>()),
  createDacsSellerSettlementPublicationTrackV1: factories.sellerSettlement,
}));
vi.mock("../src/sellerX402Runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sellerX402Runtime.js")>()),
  createDacsSellerX402RuntimeV1: factories.sellerX402,
}));
vi.mock("../src/x402RuntimePayment.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/x402RuntimePayment.js")>()),
  createDacsX402BuyerRuntimePaymentTrackV1: factories.buyerPayment,
}));
vi.mock("../src/sessionBootstrapTransportRuntime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sessionBootstrapTransportRuntime.js")>()),
  createDacsBuyerSessionBootstrapTransportRuntimeV1: factories.buyerSessionBootstrap,
  createDacsSellerSessionBootstrapTransportRuntimeV1: factories.sellerSessionBootstrap,
}));

import {
  createDacsBuyerLiveCommerceAssemblyV1,
  createDacsSellerLiveCommerceAssemblyV1,
} from "../src/liveCommerceAssembly.js";

describe("one-factory live commerce assembly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    factories.buyerAgreement.mockReturnValue("buyer-agreement");
    factories.sellerAgreement.mockReturnValue("seller-agreement");
    factories.buyerAgreementTransport.mockReturnValue({
      transport: "buyer-agreement-transport",
      validatePayload: vi.fn(),
      handleMessage: vi.fn(),
    });
    factories.sellerAgreementTransport.mockReturnValue({
      transport: "seller-agreement-transport",
      validatePayload: vi.fn(),
      handleMessage: vi.fn(),
      resolveProposal: vi.fn(async () => ({ proposal: true })),
    });
    factories.buyerAudit.mockReturnValue("buyer-audit");
    factories.sellerAudit.mockReturnValue("seller-audit");
    factories.buyerBundleTransport.mockReturnValue({
      transport: "buyer-bundle-transport",
      validatePayload: vi.fn(),
      handleMessage: vi.fn(),
    });
    factories.sellerBundleTransport.mockReturnValue({
      validatePayload: vi.fn(),
      handleMessage: vi.fn(),
    });
    factories.buyerReceived.mockReturnValue("buyer-received");
    factories.buyerPaymentEvidence.mockReturnValue({
      operation: "buyer-payment-evidence",
      validatePayload: vi.fn(),
      handleMessage: vi.fn(),
    });
    factories.sellerPaymentEvidence.mockReturnValue({
      validatePayload: vi.fn(),
      handleMessage: vi.fn(),
      anchorEvidence: vi.fn(),
      flushOutboundRequests: vi.fn(),
    });
    factories.sellerSettlement.mockReturnValue("seller-payment-evidence");
    factories.sellerX402.mockResolvedValue({
      payment: "seller-payment",
      delivery: "seller-delivery",
      deliveryEvidence: "seller-delivery-evidence",
      handleApplicationRequest: vi.fn(),
    });
    factories.buyerPayment.mockReturnValue("buyer-payment");
    factories.buyerSessionBootstrap.mockReturnValue("buyer-session-bootstrap");
    factories.sellerSessionBootstrap.mockReturnValue("seller-session-bootstrap");
    factories.buyerGraph.mockImplementation((value) => ({ role: "buyer", value }));
    factories.sellerGraph.mockImplementation((value) => ({ role: "seller", value }));
  });

  it("uses the same buyer transports for durable operations and inbound routing", async () => {
    const context = { role: "buyer" };
    const result = await createDacsBuyerLiveCommerceAssemblyV1({
      context,
      workerId: "buyer-worker",
      agreement: { buildDraft: vi.fn() },
      payment: { resolvePreparation: vi.fn() },
      paymentEvidence: { verifyEvidence: vi.fn() },
      buyerReceived: { resolvePaymentScope: vi.fn() },
      bundleTransport: { resolveVerification: vi.fn() },
      audit: { resolveMaterial: vi.fn() },
    } as never);

    expect(result).toMatchObject({ role: "buyer" });
    const agreementOptions = factories.buyerAgreement.mock.calls[0]![0];
    expect(agreementOptions).toMatchObject({
      context,
      workerId: "buyer-worker",
      transport: "buyer-agreement-transport",
    });
    const auditOptions = factories.buyerAudit.mock.calls[0]![0];
    expect(auditOptions).toMatchObject({
      context,
      workerId: "buyer-worker",
      bundleTransport: "buyer-bundle-transport",
    });
    const graph = factories.buyerGraph.mock.calls[0]![0];
    expect(graph.sessionBootstrap).toBe("buyer-session-bootstrap");
    expect(graph.agreementTransport).toBe(
      factories.buyerAgreementTransport.mock.results[0]!.value,
    );
    expect(graph.paymentEvidence).toBe(
      factories.buyerPaymentEvidence.mock.results[0]!.value,
    );
    expect(graph.bundleTransport).toBe(
      factories.buyerBundleTransport.mock.results[0]!.value,
    );
  });

  it("uses one seller x402 and handshake runtime across HTTP and every projection", async () => {
    const context = { role: "seller" };
    const result = await createDacsSellerLiveCommerceAssemblyV1({
      context,
      workerId: "seller-worker",
      sessionBootstrap: { admitInit: vi.fn() },
      agreementTransport: { admitProposal: vi.fn() },
      agreement: { authorizeComplete: vi.fn() },
      x402: { publicBaseUrl: "https://seller.example" },
      paymentEvidence: {},
      settlement: { resolvePublication: vi.fn() },
      audit: { resolveMaterial: vi.fn() },
    } as never);

    expect(result).toMatchObject({ role: "seller" });
    const paymentEvidence = factories.sellerPaymentEvidence.mock.results[0]!.value;
    expect(factories.sellerSettlement.mock.calls[0]![0]).toMatchObject({
      context,
      paymentEvidence,
    });
    const graph = factories.sellerGraph.mock.calls[0]![0];
    expect(graph.sessionBootstrap).toBe("seller-session-bootstrap");
    expect(graph.x402).toBe(await factories.sellerX402.mock.results[0]!.value);
    expect(graph.paymentEvidenceTransport).toBe(paymentEvidence);
    expect(graph.bundleTransport).toBe(
      factories.sellerBundleTransport.mock.results[0]!.value,
    );
    const agreementOptions = factories.sellerAgreement.mock.calls[0]![0];
    await agreementOptions.resolveProposal({ operation: { fence: true } });
    expect(factories.sellerAgreementTransport.mock.results[0]!.value.resolveProposal)
      .toHaveBeenCalledWith({ operation: { fence: true } });
  });
});

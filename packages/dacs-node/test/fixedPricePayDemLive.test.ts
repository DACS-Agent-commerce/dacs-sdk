import { beforeEach, describe, expect, it, vi } from "vitest";

const factories = vi.hoisted(() => ({
  buyerAgreement: vi.fn(),
  buyerPayment: vi.fn(),
  buyerReconciliation: vi.fn(),
  buyerCommerce: vi.fn(),
  buyerAudit: vi.fn(),
  buyerAssembly: vi.fn(),
  sellerSession: vi.fn(),
  sellerAgreement: vi.fn(),
  sellerFulfilment: vi.fn(),
  sellerPaymentEvidence: vi.fn(),
  sellerAudit: vi.fn(),
  sellerAssembly: vi.fn(),
}));

vi.mock("../src/fixedPricePayDemProfile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/fixedPricePayDemProfile.js")>()),
  createDacsFixedPricePayDemBuyerAgreementPolicyV1: factories.buyerAgreement,
  createDacsFixedPricePayDemSellerSessionPolicyV1: factories.sellerSession,
  createDacsFixedPricePayDemSellerAgreementPolicyV1: factories.sellerAgreement,
}));
vi.mock("../src/fixedPricePayDemBuyerPayment.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/fixedPricePayDemBuyerPayment.js")>()),
  createDacsFixedPricePayDemBuyerPaymentV1: factories.buyerPayment,
  createDacsFixedPricePayDemBuyerReconciliationV1: factories.buyerReconciliation,
}));
vi.mock("../src/fixedPricePayDemBuyerCommerce.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/fixedPricePayDemBuyerCommerce.js")>()),
  createDacsFixedPricePayDemBuyerCommerceV1: factories.buyerCommerce,
}));
vi.mock("../src/fixedPriceX402BuyerAudit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/fixedPriceX402BuyerAudit.js")>()),
  createDacsFixedPricePayDemBuyerAuditV1: factories.buyerAudit,
}));
vi.mock("../src/fixedPricePayDemSellerFulfilment.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/fixedPricePayDemSellerFulfilment.js")>()),
  createDacsFixedPricePayDemSellerFulfilmentV1: factories.sellerFulfilment,
}));
vi.mock("../src/fixedPriceX402SellerPaymentEvidence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/fixedPriceX402SellerPaymentEvidence.js")>()),
  createDacsFixedPricePayDemSellerPaymentEvidenceV1: factories.sellerPaymentEvidence,
}));
vi.mock("../src/fixedPriceX402SellerAudit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/fixedPriceX402SellerAudit.js")>()),
  createDacsFixedPricePayDemSellerAuditV1: factories.sellerAudit,
}));
vi.mock("../src/livePayDemCommerceAssembly.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/livePayDemCommerceAssembly.js")>()),
  createDacsBuyerPayDemLiveCommerceAssemblyV1: factories.buyerAssembly,
  createDacsSellerPayDemLiveCommerceAssemblyV1: factories.sellerAssembly,
}));

import { createDacsFixedPricePayDemBuyerLiveV1 } from
  "../src/fixedPricePayDemBuyerLive.js";
import { createDacsFixedPricePayDemSellerLiveV1 } from
  "../src/fixedPricePayDemSellerLive.js";

describe("fixed-price pay-dem live factories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    factories.buyerAgreement.mockReturnValue({ buildDraft: "buyer-agreement" });
    factories.buyerPayment.mockReturnValue({ resolveAuthority: "buyer-authority" });
    factories.buyerReconciliation.mockReturnValue("buyer-reconciliation");
    factories.buyerCommerce.mockReturnValue({
      paymentEvidence: { verifyEvidence: "buyer-evidence" },
      buyerReceived: { authorizeReceived: "buyer-received" },
    });
    factories.buyerAudit.mockReturnValue({
      bundleTransport: { verify: "buyer-bundle" },
      audit: { material: "buyer-audit" },
    });
    factories.buyerAssembly.mockImplementation(async (value) => ({ buyer: value }));
    factories.sellerSession.mockReturnValue({
      admitInit: "seller-init",
      admitProposal: "seller-proposal",
      resolveBuyerRequirement: "buyer-requirement",
      resolveSellerRequirement: "seller-requirement",
    });
    factories.sellerAgreement.mockReturnValue({ verifyContribution: "seller-agreement" });
    factories.sellerFulfilment.mockReturnValue({
      authority: {
        resolveCommittedAgreement: "agreement-authority",
        resolveListingAtCommit: "listing-authority",
        resolveRail: "rail-authority",
        resolveIdentityBundle: "identity-authority",
      },
      fulfilment: { fulfilmentDeps: "delivery-deps" },
    });
    factories.sellerPaymentEvidence.mockReturnValue({
      paymentEvidence: { verifyReceipt: "seller-evidence" },
      settlement: { resolvePublication: "seller-settlement" },
    });
    factories.sellerAudit.mockReturnValue({ material: "seller-audit" });
    factories.sellerAssembly.mockImplementation(async (value) => ({ seller: value }));
  });

  it("closes the buyer graph around one observer and the actor payment rail", async () => {
    const observer = vi.fn();
    const context = { role: "buyer" };
    const result = await createDacsFixedPricePayDemBuyerLiveV1({
      context,
      workerId: "buyer-worker",
      rail: { railId: "demos-native:DEM" },
      demosRpcUrl: "https://dev.node2.demos.sh",
      recipeRegistryVersion: 1,
      observeDemosTransfer: observer,
    } as never);

    expect(result).toHaveProperty("buyer");
    expect(factories.buyerCommerce).toHaveBeenCalledWith(expect.objectContaining({
      context,
      observeDemosTransfer: observer,
    }));
    expect(factories.buyerAudit).toHaveBeenCalledWith(expect.objectContaining({
      observeDemosTransfer: observer,
    }));
    expect(factories.buyerAssembly).toHaveBeenCalledWith(expect.objectContaining({
      workerId: "buyer-worker",
      payment: expect.objectContaining({
        resolveAuthority: "buyer-authority",
        reconcile: "buyer-reconciliation",
      }),
      buyerReceived: { authorizeReceived: "buyer-received" },
    }));
  });

  it("closes the seller graph around one observer and one receipt authority", async () => {
    const observer = vi.fn();
    const sellerReceipts = { receipts: true };
    const context = {
      role: "seller",
      commerceStores: { role: "seller", sellerReceipts },
    };
    const prepareDeliverable = vi.fn();
    const result = await createDacsFixedPricePayDemSellerLiveV1({
      context,
      workerId: "seller-worker",
      rail: { railId: "demos-native:DEM" },
      demosRpcUrl: "https://dev.node2.demos.sh",
      sellerPublicEndpoint: "https://seller.example/buy",
      sellerPayee: "2".repeat(64),
      maximumServiceAmount: "2",
      recipeRegistryVersion: 1,
      prepareDeliverable,
      observeDemosTransfer: observer,
    } as never);

    expect(result).toHaveProperty("seller");
    expect(factories.sellerPaymentEvidence).toHaveBeenCalledWith({
      context,
      observeDemosTransfer: observer,
    });
    expect(factories.sellerAssembly).toHaveBeenCalledWith(expect.objectContaining({
      payment: expect.objectContaining({
        intakeDeps: expect.objectContaining({
          observeDemosTransfer: observer,
          receiptStore: sellerReceipts,
        }),
      }),
      fulfilment: { fulfilment: { fulfilmentDeps: "delivery-deps" } },
      audit: { material: "seller-audit" },
    }));
  });
});

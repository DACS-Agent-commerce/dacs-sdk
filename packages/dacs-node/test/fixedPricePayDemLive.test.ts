import { trustedSessionProfile } from "./helpers/sessionProfile.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Explicitly non-live harness: these cases run against a released profile
// record; a case that sets `release.real` gets the real record at the pin.
const release = vi.hoisted(() => ({ real: false }));
vi.mock("../../../src/discovery/standardProfileRelease.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/discovery/standardProfileRelease.js")>();
  return { get DACS_STANDARD_PROFILE_STATUS() { return release.real ? actual.DACS_STANDARD_PROFILE_STATUS : "released"; } };
});
afterEach(() => { release.real = false; });

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
    factories.buyerAssembly.mockImplementation(async (value) => ({ buyer: value, payDemOperations: {}, router: {} }));
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
    factories.sellerAssembly.mockImplementation(async (value) => ({ seller: value, payDemOperations: {}, router: {} }));
  });

  it("closes the buyer graph around one observer and the actor payment rail", async () => {
    const observer = vi.fn();
    const context = { role: "buyer", authenticateSessionProfile: vi.fn() };
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
      authenticateSessionProfile: vi.fn(),
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

for (const role of ["buyer", "seller"] as const) {
  it(`${role}: re-admits the native live session before any operation or inbound effect`, async () => {
    const jobId = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
    const buyer = "did:demos:agent:" + "1".repeat(64);
    const seller = "did:demos:agent:" + "2".repeat(64);
    const effect = vi.fn(async () => ({ status: "final" }));
    const graph = { role, payDemOperations: { agreement: effect }, router: {},
      validatePayload: effect, handleMessage: effect };
    const assembly = role === "buyer" ? factories.buyerAssembly : factories.sellerAssembly;
    assembly.mockResolvedValueOnce(graph);
    let admission = trustedSessionProfile(jobId, buyer, seller);
    const context = { role, authority: role === "buyer" ? buyer : seller,
      peerAuthority: role === "buyer" ? seller : buyer,
      commerceStores: { role, sellerReceipts: {} },
      authenticateSessionProfile: vi.fn(() => structuredClone(admission)) };
    const factory = role === "buyer" ? createDacsFixedPricePayDemBuyerLiveV1 : createDacsFixedPricePayDemSellerLiveV1;
    const options = { context, observeDemosTransfer: vi.fn() } as never;
    const live = await factory(options);
    const good = structuredClone(admission);
    // The real record at the pin refuses a complete authority reply that
    // states the candidate status.
    release.real = true;
    admission = trustedSessionProfile(jobId, buyer, seller);
    await expect(live.payDemOperations.agreement!({ order: { jobId } } as never)).rejects.toThrow(/unreleased candidate/);
    await expect(live.validatePayload({ jobId } as never)).rejects.toThrow(/unreleased candidate/);
    await expect(live.handleMessage({ envelope: { jobId } } as never, {} as never)).rejects.toThrow(/unreleased candidate/);
    expect(effect).not.toHaveBeenCalled();
    release.real = false;
    const invalid = [
      { ...good, releasePin: "historical" },
      (({ profileStatus: _status, ...pinOnly }) => pinOnly)(good),
      { ...good, profileStatus: "unreleased-candidate" },
      { ...good, moduleVersions: { core: "0.3" } },
      { ...good, roles: [good.roles[0], good.roles[0]] },
      { ...good, roles: good.roles.map((entry) => ({ ...entry, jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7E" })) },
      { ...good, roles: good.roles.map((entry) => ({ ...entry, participant: buyer })) },
    ];
    for (const bad of invalid) {
      admission = bad as typeof admission;
      await expect(live.payDemOperations.agreement!({ order: { jobId } } as never)).rejects.toThrow();
      await expect(live.validatePayload({ jobId } as never)).rejects.toThrow();
      await expect(live.handleMessage({ envelope: { jobId } } as never, {} as never)).rejects.toThrow();
      expect(effect).not.toHaveBeenCalled();
    }
    admission = good;
    await live.payDemOperations.agreement!({ order: { jobId } } as never);
    expect(effect).toHaveBeenCalledTimes(1);
    delete (context as Partial<typeof context>).authenticateSessionProfile;
    await expect(factory(options)).rejects.toThrow(/independent session profile admission/);
  });
}

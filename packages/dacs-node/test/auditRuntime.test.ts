import { describe, expect, it, vi } from "vitest";

const advanceBuyer = vi.hoisted(() => vi.fn());
const finalizeSeller = vi.hoisted(() => vi.fn());
const prepareSellerRequest = vi.hoisted(() => vi.fn());
const loadOrderInput = vi.hoisted(() => vi.fn());

vi.mock("@kynesyslabs/dacs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kynesyslabs/dacs")>()),
  advanceCompletedBuyerBundleDurable: advanceBuyer,
}));

vi.mock("@kynesyslabs/dacs/seller", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kynesyslabs/dacs/seller")>()),
  finalizeCompletedSellerBundleDurable: finalizeSeller,
  prepareCompletedSellerBundleCounterSignatureRequest: prepareSellerRequest,
}));

vi.mock("../src/orderInput.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/orderInput.js")>()),
  loadDacsLiveOrderInputForTrackV1: loadOrderInput,
}));

import {
  createDacsBuyerAuditTrackV1,
  createDacsSellerAuditTrackV1,
} from "../src/auditRuntime.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = `did:demos:agent:${"11".repeat(32)}`;
const SELLER = `did:demos:agent:${"22".repeat(32)}`;
const BINDING = "a".repeat(64);
const LOCAL_BINDING = "b".repeat(64);
const BUNDLE_HASH = "c".repeat(64);

function context(role: "buyer" | "seller") {
  const authority = role === "buyer" ? BUYER : SELLER;
  return Object.freeze({
    role,
    authority,
    peerAuthority: role === "buyer" ? SELLER : BUYER,
    database: { readTime: () => 10_000 },
    sessionStore: { apiVersion: 2 },
    demos: {
      signComponent: vi.fn(async () => Uint8Array.from(Buffer.alloc(64, 7))),
    },
  });
}

function operation(role: "buyer" | "seller") {
  const assertCurrent = vi.fn(async () => undefined);
  return {
    input: {
      order: {
        role,
        jobId: JOB_ID,
        buyer: BUYER,
        seller: SELLER,
        bindingHash: BINDING,
        localBindingHash: LOCAL_BINDING,
      },
      fence: {
        role,
        track: "audit",
        jobId: JOB_ID,
        bindingHash: BINDING,
        localBindingHash: LOCAL_BINDING,
        owner: `${role}-worker`,
        generation: 1,
        idempotencyKey: `${role}-audit`,
        assertCurrent,
      },
    },
    assertCurrent,
  };
}

const counterSignature = Object.freeze({
  party: BUYER,
  algorithm: "ed25519" as const,
  value: Buffer.alloc(64, 8).toString("base64url"),
});

function sellerDurability() {
  return {
    leaseTtlMs: 30_000,
    terminalVerification: {},
    reconcileSignature: vi.fn(),
    reconcileBundleAnchor: vi.fn(),
    reconcileBindingPublication: vi.fn(),
  };
}

function buyerDurability() {
  return {
    leaseTtlMs: 30_000,
    settlementVerification: {},
    reconcileSignature: vi.fn(),
    reconcileCounterSignaturePublication: vi.fn(),
    reconcileBuyerBundleAnchor: vi.fn(),
    reconcileBindingPublication: vi.fn(),
  };
}

describe("durable role-owned audit tracks", () => {
  it("publishes the SDK seller request and finalizes only with the returned signature", async () => {
    const retained = { application: { listing: true } };
    loadOrderInput.mockReturnValue(retained);
    prepareSellerRequest.mockReturnValue({
      bundleContentHash: BUNDLE_HASH,
      signedScope: { jobId: JOB_ID },
      signedBytes: Uint8Array.from([1, 2, 3]),
      requiredCounterSigners: [BUYER],
    });
    const bundleTransport = {
      publishRequest: vi.fn(async () => ({
        status: "acknowledged" as const,
        requestHash: "d".repeat(64),
      })),
      resolveCounterSignatures: vi.fn(async () => [counterSignature]),
    };
    const provider = {
      mapping: "pure" as const,
      submitSellerBundle: vi.fn(),
    };
    const material = {
      input: {
        agreement: { jobId: JOB_ID },
        seller: { primaryClaim: SELLER, bundleHash: "e".repeat(64) },
        verifiedListing: {},
      },
      provider,
      durability: sellerDurability(),
    };
    const finalized = {
      state: "finalised" as const,
      logicalAddress: "dacs5:bundle:seller",
      nativeAddress: "native:seller",
      bundleContentHash: BUNDLE_HASH,
    };
    finalizeSeller.mockResolvedValue(finalized);
    const roleContext = context("seller");
    const track = createDacsSellerAuditTrackV1({
      context: roleContext as never,
      workerId: "seller-audit-worker",
      bundleTransport: bundleTransport as never,
      resolveMaterial: vi.fn(async () => material as never),
      authorizeFinalized: vi.fn(async () => true),
    });
    const current = operation("seller");

    await expect(track(current.input as never)).resolves.toEqual({
      status: "final",
      outcome: "success",
      reference: finalized.nativeAddress,
      authenticationHash: BUNDLE_HASH,
    });
    expect(bundleTransport.publishRequest).toHaveBeenCalledWith({
      jobId: JOB_ID,
      request: expect.objectContaining({ bundleContentHash: BUNDLE_HASH }),
    });
    expect(finalizeSeller).toHaveBeenCalledOnce();
    const finalizedInput = finalizeSeller.mock.calls[0]![0];
    expect(finalizedInput.counterSignatures).toEqual([counterSignature]);
    await expect(finalizedInput.seller.signer(
      Uint8Array.from([4]),
      { owner: "inner", generation: 1, idempotencyKey: "sign" },
    )).resolves.toHaveLength(64);
    expect(roleContext.demos.signComponent).toHaveBeenCalledWith(
      Uint8Array.from([4]),
      { algorithm: "ed25519", signer: SELLER },
    );
    expect(current.assertCurrent).toHaveBeenCalled();
  });

  it.each([
    "seller-audit-anchor-unavailable",
    "seller-audit-authority-unavailable",
    "seller-audit-deliverable-unavailable",
  ])("retries the transient seller material state %s", async (reasonCode) => {
    loadOrderInput.mockReturnValue({ application: {} });
    const error = Object.assign(new Error(reasonCode), { reasonCode });
    const track = createDacsSellerAuditTrackV1({
      context: context("seller") as never,
      workerId: "seller-audit-worker",
      bundleTransport: {
        publishRequest: vi.fn(),
        resolveCounterSignatures: vi.fn(),
      } as never,
      resolveMaterial: vi.fn(async () => { throw error; }),
      authorizeFinalized: vi.fn(async () => true),
      retryDelayMs: 2_000,
    });

    await expect(track(operation("seller").input as never)).resolves.toEqual({
      status: "pending-retry",
      reasonCode,
      retryAt: 12_000,
    });
  });

  it("retries an unclassified seller material resolver failure", async () => {
    loadOrderInput.mockReturnValue({ application: {} });
    const track = createDacsSellerAuditTrackV1({
      context: context("seller") as never,
      workerId: "seller-audit-worker",
      bundleTransport: {
        publishRequest: vi.fn(),
        resolveCounterSignatures: vi.fn(),
      } as never,
      resolveMaterial: vi.fn(async () => { throw new Error("network unavailable"); }),
      authorizeFinalized: vi.fn(async () => true),
      retryDelayMs: 2_000,
    });

    await expect(track(operation("seller").input as never)).resolves.toEqual({
      status: "pending-retry",
      reasonCode: "seller-audit-material-unavailable",
      retryAt: 12_000,
    });
  });

  it("advances the buyer durable protocol with its own signer and transport", async () => {
    const retained = { application: { purchase: true } };
    loadOrderInput.mockReturnValue(retained);
    const bundleTransport = {
      resolveSellerRequest: vi.fn(),
      publishCounterSignature: vi.fn(),
      resolveCounterSignatures: vi.fn(),
      resolveSellerFinalization: vi.fn(),
    };
    const provider = {
      submitBuyerBundle: vi.fn(),
    };
    const material = {
      input: {
        sellerVerificationInput: { agreement: { jobId: JOB_ID } },
        settlementContext: {},
        settlement: {},
        buyer: { primaryClaim: BUYER, bundleHash: "f".repeat(64) },
      },
      provider,
      durability: buyerDurability(),
    };
    const result = {
      logicalAddress: "dacs5:bundle:buyer",
      nativeAddress: "native:buyer",
      bundleContentHash: BUNDLE_HASH,
    };
    const completion = {
      sellerClosure: {
        verificationInput: { agreement: { jobId: JOB_ID } },
        result: { logicalAddress: "dacs5:bundle:seller" },
      },
    };
    advanceBuyer.mockResolvedValue({
      disposition: "finalised",
      result,
      completion,
      recovered: false,
    });
    const roleContext = context("buyer");
    const track = createDacsBuyerAuditTrackV1({
      context: roleContext as never,
      workerId: "buyer-audit-worker",
      bundleTransport: bundleTransport as never,
      resolveMaterial: vi.fn(async () => material as never),
      authorizeFinalized: vi.fn(async () => true),
    });
    const current = operation("buyer");

    await expect(track(current.input as never)).resolves.toEqual({
      status: "final",
      outcome: "success",
      reference: result.nativeAddress,
      authenticationHash: BUNDLE_HASH,
    });
    expect(advanceBuyer).toHaveBeenCalledOnce();
    const buyerInput = advanceBuyer.mock.calls[0]![0];
    await expect(buyerInput.buyer.signer(
      Uint8Array.from([9]),
      { owner: "inner", generation: 1, idempotencyKey: "sign" },
    )).resolves.toHaveLength(64);
    expect(roleContext.demos.signComponent).toHaveBeenCalledWith(
      Uint8Array.from([9]),
      { algorithm: "ed25519", signer: BUYER },
    );
    expect(advanceBuyer.mock.calls[0]![2].transport.resolveSellerFinalization)
      .toBe(bundleTransport.resolveSellerFinalization);
  });

  it("retains a buyer wait state as a bounded coordinator retry", async () => {
    loadOrderInput.mockReturnValue({ application: {} });
    advanceBuyer.mockResolvedValue({
      disposition: "waiting",
      stage: "seller-finalisation",
      reason: "seller bundle pending",
    });
    const track = createDacsBuyerAuditTrackV1({
      context: context("buyer") as never,
      workerId: "buyer-audit-worker",
      bundleTransport: {
        resolveSellerRequest: vi.fn(),
        publishCounterSignature: vi.fn(),
        resolveCounterSignatures: vi.fn(),
        resolveSellerFinalization: vi.fn(),
      },
      resolveMaterial: vi.fn(async () => ({
        input: {
          sellerVerificationInput: { agreement: { jobId: JOB_ID } },
          settlementContext: {},
          settlement: {},
          buyer: { primaryClaim: BUYER, bundleHash: "f".repeat(64) },
        },
        provider: { submitBuyerBundle: vi.fn() },
        durability: buyerDurability(),
      }) as never),
      authorizeFinalized: vi.fn(async () => true),
      retryDelayMs: 2_000,
    });

    await expect(track(operation("buyer").input as never)).resolves.toEqual({
      status: "pending-retry",
      reasonCode: "buyer-audit-seller-finalisation-pending",
      retryAt: 12_000,
    });
  });

  it.each([
    "buyer-audit-request-pending",
    "buyer-audit-anchor-unavailable",
  ])("retries the transient buyer material state %s", async (reasonCode) => {
    loadOrderInput.mockReturnValue({ application: {} });
    const advanceCallsBefore = advanceBuyer.mock.calls.length;
    const error = Object.assign(new Error(reasonCode), { reasonCode });
    const track = createDacsBuyerAuditTrackV1({
      context: context("buyer") as never,
      workerId: "buyer-audit-worker",
      bundleTransport: {
        resolveSellerRequest: vi.fn(),
        publishCounterSignature: vi.fn(),
        resolveCounterSignatures: vi.fn(),
        resolveSellerFinalization: vi.fn(),
      },
      resolveMaterial: vi.fn(async () => { throw error; }),
      authorizeFinalized: vi.fn(async () => true),
      retryDelayMs: 2_000,
    });

    await expect(track(operation("buyer").input as never)).resolves.toEqual({
      status: "pending-retry",
      reasonCode,
      retryAt: 12_000,
    });
    expect(advanceBuyer).toHaveBeenCalledTimes(advanceCallsBefore);
  });

  it("retries an unclassified buyer material resolver failure", async () => {
    loadOrderInput.mockReturnValue({ application: {} });
    const track = createDacsBuyerAuditTrackV1({
      context: context("buyer") as never,
      workerId: "buyer-audit-worker",
      bundleTransport: {
        resolveSellerRequest: vi.fn(),
        publishCounterSignature: vi.fn(),
        resolveCounterSignatures: vi.fn(),
        resolveSellerFinalization: vi.fn(),
      },
      resolveMaterial: vi.fn(async () => { throw new Error("invalid"); }),
      authorizeFinalized: vi.fn(async () => true),
    });

    await expect(track(operation("buyer").input as never)).resolves.toEqual({
      status: "pending-retry",
      reasonCode: "buyer-audit-material-unavailable",
      retryAt: 11_000,
    });
  });

  it("keeps malformed buyer material fail-closed", async () => {
    loadOrderInput.mockReturnValue({ application: {} });
    const track = createDacsBuyerAuditTrackV1({
      context: context("buyer") as never,
      workerId: "buyer-audit-worker",
      bundleTransport: {
        resolveSellerRequest: vi.fn(),
        publishCounterSignature: vi.fn(),
        resolveCounterSignatures: vi.fn(),
        resolveSellerFinalization: vi.fn(),
      },
      resolveMaterial: vi.fn(async () => ({} as never)),
      authorizeFinalized: vi.fn(async () => true),
    });

    await expect(track(operation("buyer").input as never)).resolves.toEqual({
      status: "operator-action",
      reasonCode: "buyer-audit-material-invalid",
    });
  });
});

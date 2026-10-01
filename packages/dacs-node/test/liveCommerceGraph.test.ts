import { describe, expect, it, vi } from "vitest";

import {
  createDacsBuyerLiveCommerceGraphV1,
  createDacsSellerLiveCommerceGraphV1,
  createDacsUnavailableLiveCommerceGraphV1,
} from "../src/liveCommerceGraph.js";

const operation = () => vi.fn(async () => ({
  status: "pending-retry" as const,
  reasonCode: "pending",
  retryAt: 1,
}));

function route() {
  return {
    validatePayload: vi.fn(async () => ({ status: "valid" as const })),
    handleMessage: vi.fn(async () => ({ disposition: "accepted" as const })),
  };
}

describe("closed live commerce graphs", () => {
  it("wires every buyer track and only the buyer-directed message routes", async () => {
    const agreement = operation();
    const sessionBootstrap = route();
    const payment = operation();
    const paymentEvidence = { operation: operation(), ...route() };
    const buyerReceived = operation();
    const audit = operation();
    const agreementTransport = route();
    const bundleTransport = route();
    const terminalBundleTransport = route();
    const graph = createDacsBuyerLiveCommerceGraphV1({
      sessionBootstrap: sessionBootstrap as never,
      agreement,
      payment,
      paymentEvidence: paymentEvidence as never,
      buyerReceived,
      audit,
      agreementTransport: agreementTransport as never,
      bundleTransport: bundleTransport as never,
      terminalBundleTransport: terminalBundleTransport as never,
    });

    expect(Object.keys(graph.operations).sort()).toEqual([
      "agreement", "audit", "buyer-received", "payment", "payment-evidence",
    ]);
    expect(graph.availability).toEqual({ status: "configured" });
    expect(graph.operations.agreement).toBe(agreement);
    expect(graph.operations["payment-evidence"]).toBe(paymentEvidence.operation);
    expect(graph.terminalBundles).toBe(terminalBundleTransport);
    await expect(graph.validatePayload({
      type: "bundle-signature-request",
    } as never)).resolves.toEqual({ status: "valid" });
    expect(bundleTransport.validatePayload).toHaveBeenCalledOnce();
    await expect(graph.validatePayload({
      type: "terminal-bundle-proposal-seller",
    } as never)).resolves.toEqual({ status: "valid" });
    expect(terminalBundleTransport.validatePayload).toHaveBeenCalledOnce();
    await expect(graph.validatePayload({
      type: "agreement-proposal",
    } as never)).resolves.toEqual({
      status: "invalid",
      reasonCode: "message-type-role-incompatible",
    });
  });

  it("binds one seller x402 runtime to payment, delivery and the paid HTTP handler", () => {
    const handleApplicationRequest = vi.fn();
    const x402 = {
      paywall: {},
      payment: operation(),
      delivery: operation(),
      deliveryEvidence: operation(),
      handleApplicationRequest,
      resolvePaymentAuthorization: vi.fn(),
    };
    const paymentEvidence = operation();
    const agreementTransport = route();
    const paymentEvidenceTransport = route();
    const bundleTransport = route();
    const graph = createDacsSellerLiveCommerceGraphV1({
      sessionBootstrap: route() as never,
      agreement: operation(),
      x402: x402 as never,
      paymentEvidence,
      audit: operation(),
      agreementTransport: agreementTransport as never,
      paymentEvidenceTransport: paymentEvidenceTransport as never,
      bundleTransport: bundleTransport as never,
    });

    expect(Object.keys(graph.operations).sort()).toEqual([
      "agreement", "audit", "delivery", "delivery-evidence", "payment",
      "payment-evidence",
    ]);
    expect(graph.operations.payment).toBe(x402.payment);
    expect(graph.operations.delivery).toBe(x402.delivery);
    expect(graph.operations["delivery-evidence"]).toBe(x402.deliveryEvidence);
    expect(graph.operations["payment-evidence"]).toBe(paymentEvidence);
    expect(graph.handleApplicationRequest).toBe(handleApplicationRequest);
    expect(graph.availability).toEqual({ status: "configured" });
  });

  it("rejects partial graphs before a role service can start", () => {
    expect(() => createDacsBuyerLiveCommerceGraphV1({
      sessionBootstrap: route(),
      agreement: operation(),
      payment: operation(),
    } as never)).toThrow("buyer live commerce graph options are invalid");
    expect(() => createDacsSellerLiveCommerceGraphV1({
      sessionBootstrap: route(),
      agreement: operation(),
      paymentEvidence: operation(),
    } as never)).toThrow("seller live commerce graph options are invalid");
  });

  it("provides a complete but non-performing bootstrap graph", async () => {
    const buyer = createDacsUnavailableLiveCommerceGraphV1({
      role: "buyer",
      reasonCode: "commerce-not-admitted",
    });
    expect(buyer.role).toBe("buyer");
    expect(buyer.availability).toEqual({
      status: "blocked",
      reasonCode: "commerce-not-admitted",
    });
    expect(Object.keys(buyer.operations).sort()).toEqual([
      "agreement", "audit", "buyer-received", "payment", "payment-evidence",
    ]);
    await expect(buyer.operations.agreement({} as never)).resolves.toEqual({
      status: "operator-action",
      reasonCode: "commerce-not-admitted",
    });
    await expect(buyer.validatePayload({ type: "agreement-response" } as never))
      .resolves.toEqual({
        status: "invalid",
        reasonCode: "commerce-not-admitted",
      });

    const seller = createDacsUnavailableLiveCommerceGraphV1({
      role: "seller",
      reasonCode: "commerce-not-admitted",
    });
    expect(seller.role).toBe("seller");
    expect(seller.availability).toEqual({
      status: "blocked",
      reasonCode: "commerce-not-admitted",
    });
    expect(Object.keys(seller.operations).sort()).toEqual([
      "agreement", "audit", "delivery", "delivery-evidence", "payment",
      "payment-evidence",
    ]);
  });
});

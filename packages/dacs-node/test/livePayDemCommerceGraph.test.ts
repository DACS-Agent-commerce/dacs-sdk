import { describe, expect, it, vi } from "vitest";

import {
  createDacsBuyerPayDemLiveCommerceGraphV1,
  createDacsSellerPayDemLiveCommerceGraphV1,
} from "../src/livePayDemCommerceGraph.js";
import type { DacsLiveRoleInboundOperationContextV1 } from "../src/roleRuntime.js";
import type { DacsHttpAuthenticatedEnvelopeV1 } from "../src/transport/envelope.js";

function operation() {
  return vi.fn(async () => Object.freeze({
    status: "pending-retry" as const,
    reasonCode: "fixture-pending",
    retryAt: 1,
  }));
}

function runtime() {
  return Object.freeze({
    validatePayload: vi.fn(async () => Object.freeze({ status: "valid" as const })),
    handleMessage: vi.fn(async () => Object.freeze({ disposition: "accepted" as const })),
  });
}

function authenticated(type: string): Readonly<DacsHttpAuthenticatedEnvelopeV1> {
  return {
    status: "authenticated",
    envelope: { type },
  } as unknown as DacsHttpAuthenticatedEnvelopeV1;
}

describe("native DEM live commerce graph", () => {
  it("closes every buyer track and shared authenticated route", async () => {
    const sessionBootstrap = runtime();
    const agreementTransport = runtime();
    const paymentEvidence = Object.freeze({ ...runtime(), operation: operation() });
    const bundleTransport = runtime();
    const terminalBundleTransport = runtime();
    const graph = createDacsBuyerPayDemLiveCommerceGraphV1({
      sessionBootstrap: sessionBootstrap as never,
      agreement: operation(),
      payment: operation(),
      paymentEvidence: paymentEvidence as never,
      buyerReceived: operation(),
      audit: operation(),
      agreementTransport: agreementTransport as never,
      bundleTransport: bundleTransport as never,
      terminalBundleTransport: terminalBundleTransport as never,
    });

    expect(Object.keys(graph.payDemOperations).sort()).toEqual([
      "agreement", "audit", "buyer-received", "payment", "payment-evidence",
    ]);
    expect(graph.terminalBundles).toBe(terminalBundleTransport);
    await expect(graph.handleMessage(
      authenticated("terminal-bundle-proposal-seller"),
      { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
    )).resolves.toEqual({ disposition: "accepted" });
    expect(terminalBundleTransport.handleMessage).toHaveBeenCalledOnce();
    await expect(graph.handleMessage(
      authenticated("payment-evidence-request"),
      { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
    )).resolves.toEqual({ disposition: "accepted" });
    expect(paymentEvidence.handleMessage).toHaveBeenCalledOnce();
  });

  it("routes authenticated native payment notices only through seller intake", async () => {
    const paymentNotice = runtime();
    const graph = createDacsSellerPayDemLiveCommerceGraphV1({
      sessionBootstrap: runtime() as never,
      agreement: operation(),
      paymentNotice: paymentNotice as never,
      payment: operation(),
      paymentEvidence: operation(),
      delivery: operation(),
      deliveryEvidence: operation(),
      audit: operation(),
      agreementTransport: runtime() as never,
      paymentEvidenceTransport: runtime() as never,
      bundleTransport: runtime() as never,
    });

    expect(Object.keys(graph.payDemOperations).sort()).toEqual([
      "agreement", "audit", "delivery", "delivery-evidence", "payment",
      "payment-evidence",
    ]);
    await expect(graph.handleMessage(
      authenticated("pay-dem-payment-notice"),
      { role: "seller" } as DacsLiveRoleInboundOperationContextV1,
    )).resolves.toEqual({ disposition: "accepted" });
    expect(paymentNotice.handleMessage).toHaveBeenCalledOnce();
  });

  it("rejects an incomplete seller graph before any message can be admitted", () => {
    expect(() => createDacsSellerPayDemLiveCommerceGraphV1({
      sessionBootstrap: runtime(),
      agreement: operation(),
      payment: operation(),
    } as never)).toThrow(/options are invalid/);
  });
});

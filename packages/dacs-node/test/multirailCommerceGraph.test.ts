import { describe, expect, it, vi } from "vitest";

import { createDacsMultirailLiveCommerceGraphV1 } from
  "../src/multirailCommerceGraph.js";
import type { DacsLiveRoleInboundOperationContextV1 } from "../src/roleRuntime.js";
import type { DacsHttpAuthenticatedEnvelopeV1 } from "../src/transport/envelope.js";

function operations(role: "buyer" | "seller") {
  const operation = vi.fn(async () => ({ status: "pending-retry" as const }));
  return role === "buyer"
    ? Object.freeze({
        agreement: operation,
        payment: operation,
        "payment-evidence": operation,
        "buyer-received": operation,
        audit: operation,
      })
    : Object.freeze({
        agreement: operation,
        payment: operation,
        "payment-evidence": operation,
        delivery: operation,
        "delivery-evidence": operation,
        audit: operation,
      });
}

function graph(
  role: "buyer" | "seller",
  profile: "x402" | "pay-dem",
  validation: "valid" | "invalid" | "authentication-failure",
) {
  const handleMessage = vi.fn(async () => Object.freeze({
    disposition: "accepted" as const,
  }));
  const validatePayload = vi.fn(async () => validation === "valid"
    ? Object.freeze({ status: "valid" as const })
    : Object.freeze({
        status: validation,
        reasonCode: `${profile}-fixture-${validation}`,
      }));
  const handleApplicationRequest = vi.fn(() => true);
  return {
    value: Object.freeze({
      role,
      availability: Object.freeze({ status: "configured" as const }),
      ...(profile === "x402"
        ? { operations: operations(role) }
        : { payDemOperations: operations(role) }),
      validatePayload,
      handleMessage,
      ...(role === "seller" && profile === "x402" ? { handleApplicationRequest } : {}),
    }),
    validatePayload,
    handleMessage,
    handleApplicationRequest,
  };
}

function authenticated(type = "agreement-response"):
Readonly<DacsHttpAuthenticatedEnvelopeV1> {
  return {
    status: "authenticated",
    authenticationHash: "a".repeat(64),
    identityEvidenceHash: "b".repeat(64),
    envelope: {
      type,
      payload: {},
      jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
      sender: "seller",
      audience: "buyer",
    },
  } as unknown as Readonly<DacsHttpAuthenticatedEnvelopeV1>;
}

describe("strict multirail live commerce graph", () => {
  it("dispatches to exactly one payload-selected rail", async () => {
    const x402 = graph("buyer", "x402", "invalid");
    const payDem = graph("buyer", "pay-dem", "valid");
    const combined = createDacsMultirailLiveCommerceGraphV1({
      role: "buyer",
      x402: x402.value as never,
      payDem: payDem.value as never,
    });
    const input = {
      type: "agreement-response" as const,
      payload: {},
      jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
      sender: "seller",
      audience: "buyer",
    };
    await expect(combined.validatePayload(input)).resolves.toEqual({ status: "valid" });
    await expect(combined.handleMessage(
      authenticated(),
      { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
    )).resolves.toEqual({ disposition: "accepted" });
    expect(payDem.handleMessage).toHaveBeenCalledOnce();
    expect(x402.handleMessage).not.toHaveBeenCalled();
  });

  it("fails closed when both rail graphs accept the same message", async () => {
    const x402 = graph("buyer", "x402", "valid");
    const payDem = graph("buyer", "pay-dem", "valid");
    const combined = createDacsMultirailLiveCommerceGraphV1({
      role: "buyer",
      x402: x402.value as never,
      payDem: payDem.value as never,
    });
    await expect(combined.validatePayload({
      type: "agreement-response",
      payload: {},
      jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
      sender: "seller",
      audience: "buyer",
    })).resolves.toEqual({
      status: "authentication-failure",
      reasonCode: "multirail-message-profile-ambiguous",
    });
    await expect(combined.handleMessage(
      authenticated(),
      { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
    )).resolves.toEqual({
      disposition: "rejected",
      reasonCode: "multirail-message-profile-ambiguous",
    });
    expect(x402.handleMessage).not.toHaveBeenCalled();
    expect(payDem.handleMessage).not.toHaveBeenCalled();
  });

  it("retains only the x402 seller paid-resource handler", () => {
    const x402 = graph("seller", "x402", "valid");
    const payDem = graph("seller", "pay-dem", "invalid");
    const combined = createDacsMultirailLiveCommerceGraphV1({
      role: "seller",
      x402: x402.value as never,
      payDem: payDem.value as never,
    });
    expect(combined.handleApplicationRequest).toBe(x402.handleApplicationRequest);
  });
});

import { describe, expect, it, vi } from "vitest";

import { createDacsMultirailLiveCommerceGraphV1 } from
  "../src/multirailCommerceGraph.js";
import type { DacsLiveRoleInboundOperationContextV1 } from "../src/roleRuntime.js";
import type { DacsHttpAuthenticatedEnvelopeV1 } from "../src/transport/envelope.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";

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

function authenticated(type = "agreement-response", payload: unknown = {}):
Readonly<DacsHttpAuthenticatedEnvelopeV1> {
  return {
    status: "authenticated",
    authenticationHash: "a".repeat(64),
    identityEvidenceHash: "b".repeat(64),
    envelope: {
      type,
      payload,
      jobId: JOB_ID,
      sender: "seller",
      audience: "buyer",
    },
  } as unknown as Readonly<DacsHttpAuthenticatedEnvelopeV1>;
}

type Owner = "x402" | "pay-dem" | "both" | "stale" | undefined;

function coordinatorStore(status: "ok" | "missing" | "stale") {
  return {
    load: vi.fn(async () => status === "ok"
      ? { status: "ok" as const, record: {} }
      : { status }),
  };
}

function context(
  role: "buyer" | "seller",
  owner: Owner,
): DacsLiveRoleInboundOperationContextV1 {
  const x402Status = owner === "x402" || owner === "both"
    ? "ok"
    : owner === "stale" ? "stale" : "missing";
  const payDemStatus = owner === "pay-dem" || owner === "both" ? "ok" : "missing";
  return {
    role,
    database: {
      createLiveCoordinatorStore: () => coordinatorStore(x402Status),
      createPayDemCoordinatorStore: () => coordinatorStore(payDemStatus),
    },
  } as unknown as DacsLiveRoleInboundOperationContextV1;
}

describe("strict multirail live commerce graph", () => {
  it("routes a shared message to the rail that already owns the job", async () => {
    const x402 = graph("buyer", "x402", "valid");
    const payDem = graph("buyer", "pay-dem", "valid");
    const combined = createDacsMultirailLiveCommerceGraphV1({
      role: "buyer",
      x402: x402.value as never,
      payDem: payDem.value as never,
    });

    await expect(combined.handleMessage(
      authenticated(),
      context("buyer", "pay-dem"),
    )).resolves.toEqual({ disposition: "accepted" });
    expect(payDem.handleMessage).toHaveBeenCalledOnce();
    expect(x402.handleMessage).not.toHaveBeenCalled();
  });

  it("admits a shared message both rail schemas can parse", async () => {
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
      jobId: JOB_ID,
      sender: "seller",
      audience: "buyer",
    })).resolves.toEqual({ status: "valid" });
  });

  it("routes a fresh session-init by its declared order phase", async () => {
    const x402 = graph("seller", "x402", "valid");
    const payDem = graph("seller", "pay-dem", "valid");
    const combined = createDacsMultirailLiveCommerceGraphV1({
      role: "seller",
      x402: x402.value as never,
      payDem: payDem.value as never,
    });

    await expect(combined.handleMessage(
      authenticated("session-init", { order: { protocol: { phase: "pay-dem" } } }),
      context("seller", undefined),
    )).resolves.toEqual({ disposition: "accepted" });
    expect(payDem.handleMessage).toHaveBeenCalledOnce();
    expect(x402.handleMessage).not.toHaveBeenCalled();
  });

  it("rejects a non-init message for a job no rail owns", async () => {
    const x402 = graph("buyer", "x402", "valid");
    const payDem = graph("buyer", "pay-dem", "valid");
    const combined = createDacsMultirailLiveCommerceGraphV1({
      role: "buyer",
      x402: x402.value as never,
      payDem: payDem.value as never,
    });

    await expect(combined.handleMessage(
      authenticated(),
      context("buyer", undefined),
    )).resolves.toEqual({
      disposition: "rejected",
      reasonCode: "multirail-message-profile-unresolved",
    });
    expect(x402.handleMessage).not.toHaveBeenCalled();
    expect(payDem.handleMessage).not.toHaveBeenCalled();
  });

  it("fails closed when both coordinator stores claim the same job", async () => {
    const x402 = graph("buyer", "x402", "valid");
    const payDem = graph("buyer", "pay-dem", "valid");
    const combined = createDacsMultirailLiveCommerceGraphV1({
      role: "buyer",
      x402: x402.value as never,
      payDem: payDem.value as never,
    });

    await expect(combined.handleMessage(
      authenticated(),
      context("buyer", "both"),
    )).resolves.toEqual({
      disposition: "rejected",
      reasonCode: "multirail-job-identity-conflict",
    });
    expect(x402.handleMessage).not.toHaveBeenCalled();
    expect(payDem.handleMessage).not.toHaveBeenCalled();
  });

  it("rejects an invalid payload from the rail that owns the job", async () => {
    const x402 = graph("buyer", "x402", "valid");
    const payDem = graph("buyer", "pay-dem", "invalid");
    const combined = createDacsMultirailLiveCommerceGraphV1({
      role: "buyer",
      x402: x402.value as never,
      payDem: payDem.value as never,
    });

    await expect(combined.handleMessage(
      authenticated(),
      context("buyer", "pay-dem"),
    )).resolves.toEqual({
      disposition: "rejected",
      reasonCode: "pay-dem-fixture-invalid",
    });
    expect(payDem.handleMessage).not.toHaveBeenCalled();
  });

  it("keeps an owning-rail validation outage pending instead of rejecting it", async () => {
    const x402 = graph("buyer", "x402", "valid");
    const payDem = graph("buyer", "pay-dem", "authentication-failure");
    const combined = createDacsMultirailLiveCommerceGraphV1({
      role: "buyer",
      x402: x402.value as never,
      payDem: payDem.value as never,
    });

    await expect(combined.validatePayload({
      type: "agreement-response",
      payload: {},
      jobId: JOB_ID,
      sender: "seller",
      audience: "buyer",
    })).resolves.toEqual({ status: "valid" });
    await expect(combined.handleMessage(
      authenticated(),
      context("buyer", "pay-dem"),
    )).rejects.toMatchObject({
      reasonCode: "multirail-message-validation-unavailable",
    });
    expect(x402.handleMessage).not.toHaveBeenCalled();
    expect(payDem.handleMessage).not.toHaveBeenCalled();
  });

  it("does not let an unavailable sibling override the retained valid rail", async () => {
    const x402 = graph("buyer", "x402", "valid");
    const payDem = graph("buyer", "pay-dem", "authentication-failure");
    const combined = createDacsMultirailLiveCommerceGraphV1({
      role: "buyer",
      x402: x402.value as never,
      payDem: payDem.value as never,
    });

    await expect(combined.handleMessage(
      authenticated(),
      context("buyer", "x402"),
    )).resolves.toEqual({ disposition: "accepted" });
    expect(x402.handleMessage).toHaveBeenCalledOnce();
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

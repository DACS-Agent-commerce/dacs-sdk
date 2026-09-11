import { describe, expect, it, vi } from "vitest";

import {
  createDacsLiveRoleMessageRouterV1,
  dacsLiveRoleInboundMessageTypesV1,
  type DacsLiveMessageRouteV1,
} from "../src/messageRouter.js";
import type { DacsLiveRoleInboundOperationContextV1 } from "../src/roleRuntime.js";
import type { DacsHttpAuthenticatedEnvelopeV1 } from "../src/transport/envelope.js";

function route(): DacsLiveMessageRouteV1 {
  return {
    validate: vi.fn(async () => ({ status: "valid" as const })),
    handle: vi.fn(async () => ({ disposition: "accepted" as const })),
  };
}

function authenticated(type: string): Readonly<DacsHttpAuthenticatedEnvelopeV1> {
  return {
    status: "authenticated",
    envelope: { type },
  } as unknown as DacsHttpAuthenticatedEnvelopeV1;
}

describe("closed live role message router", () => {
  it("dispatches each complete buyer route and rejects seller direction", async () => {
    const agreement = route();
    const payment = route();
    const bundle = route();
    const router = createDacsLiveRoleMessageRouterV1({
      role: "buyer",
      routes: {
        "session-challenge": route(),
        "session-admission": route(),
        "agreement-response": agreement,
        "payment-evidence-request": payment,
        "bundle-signature-request": bundle,
      },
    });
    const input = {
      type: "payment-evidence-request" as const,
      payload: {},
      jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
      sender: "seller",
      audience: "buyer",
    };
    await expect(router.validatePayload(input)).resolves.toEqual({ status: "valid" });
    expect(payment.validate).toHaveBeenCalledOnce();
    await expect(router.handleMessage(
      authenticated("payment-evidence-request"),
      { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
    )).resolves.toEqual({ disposition: "accepted" });
    expect(payment.handle).toHaveBeenCalledOnce();
    await expect(router.handleMessage(
      authenticated("payment-evidence-completion"),
      { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
    )).resolves.toEqual({
      disposition: "rejected",
      reasonCode: "message-type-role-incompatible",
    });
  });

  it("requires the exact role-owned route set without invoking accessors", () => {
    expect(() => createDacsLiveRoleMessageRouterV1({
      role: "seller",
      routes: {
        "agreement-proposal": route(),
        "payment-evidence-completion": route(),
      },
    } as never)).toThrow(/role-incompatible/);
    expect(() => createDacsLiveRoleMessageRouterV1({
      role: "seller",
      routes: {
        "agreement-proposal": route(),
        "payment-evidence-completion": route(),
        "bundle-signature-response": route(),
        "payment-evidence-request": route(),
      },
    } as never)).toThrow(/role-incompatible/);

    const accessed = vi.fn(() => route());
    const routes = {
      "session-init": route(),
      "session-presentation": route(),
      "agreement-proposal": route(),
      "payment-evidence-completion": route(),
    } as Record<string, unknown>;
    Object.defineProperty(routes, "bundle-signature-response", {
      enumerable: true,
      get: accessed,
    });
    expect(() => createDacsLiveRoleMessageRouterV1({
      role: "seller",
      routes,
    } as never)).toThrow(/options are invalid/);
    expect(accessed).not.toHaveBeenCalled();
  });

  it("fails closed when a route validator or handler becomes unavailable", async () => {
    const unavailable = route();
    unavailable.validate = vi.fn(async () => {
      throw new Error("unavailable");
    });
    unavailable.handle = vi.fn(async () => {
      throw new Error("ambiguous");
    });
    const router = createDacsLiveRoleMessageRouterV1({
      role: "seller",
      routes: {
        "session-init": route(),
        "session-presentation": route(),
        "agreement-proposal": unavailable,
        "pay-dem-payment-notice": route(),
        "payment-evidence-completion": route(),
        "bundle-signature-response": route(),
      },
    });
    await expect(router.validatePayload({
      type: "agreement-proposal",
      payload: {},
      jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
      sender: "buyer",
      audience: "seller",
    })).resolves.toEqual({
      status: "authentication-failure",
      reasonCode: "message-route-validation-unavailable",
    });
    await expect(router.handleMessage(
      authenticated("agreement-proposal"),
      { role: "seller" } as DacsLiveRoleInboundOperationContextV1,
    )).rejects.toMatchObject({ reasonCode: "message-route-handler-indeterminate" });
  });

  it("publishes the immutable role direction catalog", () => {
    expect(dacsLiveRoleInboundMessageTypesV1("buyer")).toEqual([
      "session-challenge",
      "session-admission",
      "agreement-response",
      "payment-evidence-request",
      "bundle-signature-request",
    ]);
    expect(Object.isFrozen(dacsLiveRoleInboundMessageTypesV1("seller"))).toBe(true);
  });
});

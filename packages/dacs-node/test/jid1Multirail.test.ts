import { describe, expect, it, vi } from "vitest";

import { createX402Paywall } from "../../../src/rails/x402Paywall.js";
import { createDacsX402BuyerRuntimePaymentTrackV1 } from "../src/x402RuntimePayment.js";
import {
  createDacsFixedPriceMultirailBuyerLiveV1,
  createDacsFixedPriceMultirailSellerLiveV1,
} from "../src/fixedPriceMultirailLive.js";

const native = vi.hoisted(() => ({ buyer: vi.fn(), seller: vi.fn() }));
vi.mock("../src/fixedPricePayDemBuyerLive.js", () => ({
  createDacsFixedPricePayDemBuyerLiveV1: native.buyer,
}));
vi.mock("../src/fixedPricePayDemSellerLive.js", () => ({
  createDacsFixedPricePayDemSellerLiveV1: native.seller,
}));
vi.mock("../src/fixedPriceX402BuyerLive.js", () => ({
  createDacsFixedPriceX402BuyerLiveV1: async () => {
    // Replace only the surrounding assembly. The real runtime payment builder
    // and its real, unmocked profile gate execute with valid options.
    createDacsX402BuyerRuntimePaymentTrackV1(trackOptions() as never);
    throw new Error("unreleased buyer profile unexpectedly admitted");
  },
}));
vi.mock("../src/fixedPriceX402SellerLive.js", () => ({
  createDacsFixedPriceX402SellerLiveV1: async () => {
    await createX402Paywall({} as never, {} as never);
    throw new Error("unreleased seller profile unexpectedly admitted");
  },
}));

function trackOptions() {
  const effect = vi.fn();
  return {
    context: {
      role: "buyer", database: { metadata: { mode: "live-demos", role: "buyer" } },
      evm: { role: "buyer", runtime: { chainId: 84532, readClient: {
        getFinalityHead: effect, getLogs: effect, getTransactionReceipt: effect,
        readAuthorizationState: effect, confirmBlockAncestor: effect,
      } } },
      commerceStores: { role: "buyer", x402Settlement: {
        load: effect, claim: effect, isCurrent: effect, grantRecovery: effect,
        recordDisclosure: effect, recordOutcome: effect,
      } },
    },
    workerId: "buyer-profile-test", maximumServiceAmount: "1000000",
    minimumConfirmations: 1, authorizationSearchFromBlock: 0,
    resolvePreparation: effect, authorizeIntent: effect, authorizePreparedIntent: effect,
    walletSpendAuthority: { reserve: effect, reconcile: effect },
  };
}

describe("multirail service with the real unreleased x402 gate", () => {
  it.each(["buyer", "seller"] as const)("keeps %s pay-dem available and x402 closed", async (role) => {
    const payDemOperation = vi.fn(async () => ({ status: "pending-retry" as const }));
    const handleMessage = vi.fn(async () => ({ disposition: "accepted" as const }));
    native[role].mockResolvedValue({
      role, availability: { status: "configured" },
      payDemOperations: {
        agreement: payDemOperation, payment: payDemOperation,
        "payment-evidence": payDemOperation, audit: payDemOperation,
        ...(role === "buyer" ? { "buyer-received": payDemOperation } : {
          delivery: payDemOperation, "delivery-evidence": payDemOperation,
        }),
      },
      validatePayload: () => ({ status: "valid" }), handleMessage,
    });
    const context = {};
    const options = {
      x402: { context, workerId: "worker" },
      payDem: { context, workerId: "worker" },
    };
    const build = role === "buyer"
      ? createDacsFixedPriceMultirailBuyerLiveV1
      : createDacsFixedPriceMultirailSellerLiveV1;
    const graph = await build(options as never);
    expect(graph.role).toBe(role);
    expect(graph.operations.payment).toBeTypeOf("function");
    expect(graph.payDemOperations.payment).toBe(payDemOperation);
    await expect(graph.operations.payment!({} as never)).resolves.toMatchObject({
      status: "operator-action", reasonCode: "x402-live-profile-unavailable",
    });
    await expect(graph.payDemOperations.payment!({} as never)).resolves.toMatchObject({ status: "pending-retry" });
    const message = { envelope: {
      type: "session-init", jobId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      sender: "peer", audience: role,
      payload: { order: { protocol: { phase: "pay-dem" } } },
    } };
    const inbound = { role, database: {
      createLiveCoordinatorStore: () => ({ load: async () => ({ status: "missing" }) }),
      createPayDemCoordinatorStore: () => ({ load: async () => ({ status: "missing" }) }),
    } };
    await expect(graph.handleMessage(message as never, inbound as never))
      .resolves.toEqual({ disposition: "accepted" });
    expect(handleMessage).toHaveBeenCalledTimes(1);
    message.envelope.payload.order.protocol.phase = "pay-x402";
    await expect(graph.handleMessage(message as never, inbound as never))
      .resolves.toMatchObject({ disposition: "rejected" });
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(payDemOperation).toHaveBeenCalledTimes(1);
    expect(typeof graph.handleApplicationRequest).toBe(role === "seller" ? "function" : "undefined");
  });
});

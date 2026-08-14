import { describe, expect, it, vi } from "vitest";

import {
  createFixedPriceX402BuyerCoordinator,
  createFixedPriceX402SellerCoordinator,
  createInMemoryFixedPriceX402CoordinatorStore,
  combineFixedPriceX402OrderStatus,
  fixedPriceX402OrderBindingHash,
  type FixedPriceX402OrderInput,
  type FixedPriceX402TrackOperation,
} from "../../src/commerce/index.js";
import {
  createFixedPriceX402BuyerCoordinator as rootCreateFixedPriceX402BuyerCoordinator,
} from "../../src/index.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";

function order(overrides: Partial<FixedPriceX402OrderInput> = {}): FixedPriceX402OrderInput {
  return {
    jobId: JOB_ID,
    buyer: "did:example:buyer",
    seller: "did:example:seller",
    sdkJobs: {
      agreement: `agreement:${JOB_ID}`,
      payment: `payment:${JOB_ID}`,
      fulfilment: `fulfilment:${JOB_ID}`,
      buyerAudit: `audit:buyer:${JOB_ID}`,
      sellerAudit: `audit:seller:${JOB_ID}`,
    },
    ...overrides,
  };
}

const finalOperation = (track: string, calls: string[]): FixedPriceX402TrackOperation =>
  async ({ fence }) => {
    await fence.assertCurrent();
    calls.push(track);
    return { status: "final", reference: `${track}:${fence.jobId}` };
  };

describe("fixed-price x402 coordinator", () => {
  it("is exported from the commerce subpath and package root", async () => {
    expect(rootCreateFixedPriceX402BuyerCoordinator)
      .toBe(createFixedPriceX402BuyerCoordinator);
    const packageJson = await import("../../package.json", { with: { type: "json" } });
    expect(packageJson.default.exports["./commerce"]).toBeDefined();
  });

  it("does no invisible background work and advances bounded dependency tracks", async () => {
    const calls: string[] = [];
    const coordinator = createFixedPriceX402BuyerCoordinator({
      store: createInMemoryFixedPriceX402CoordinatorStore(),
      workerId: "buyer-worker-1",
      operations: {
        agreement: finalOperation("agreement", calls),
        payment: finalOperation("payment", calls),
        "payment-evidence": finalOperation("payment-evidence", calls),
        delivery: finalOperation("delivery", calls),
        "buyer-received": finalOperation("buyer-received", calls),
        "delivery-evidence": finalOperation("delivery-evidence", calls),
        audit: finalOperation("audit", calls),
      },
      now: () => 1_000,
    });

    const started = await coordinator.startOrder(order());
    expect(started.milestone).toBe("created");
    expect(calls).toEqual([]);

    const first = await coordinator.runPending({ limit: 2 });
    expect(first.map((item) => item.track)).toEqual(["agreement", "payment"]);
    expect((await coordinator.getOrderStatus(JOB_ID))?.milestone).toBe("payment-final");

    const rest = await coordinator.resumePendingOrders({ limit: 10 });
    expect(rest.map((item) => item.track)).toEqual([
      "payment-evidence",
      "delivery",
      "buyer-received",
      "delivery-evidence",
      "audit",
    ]);
    expect((await coordinator.getOrderStatus(JOB_ID))?.milestone).toBe("audit-complete");
    expect(calls).toEqual([
      "agreement",
      "payment",
      "payment-evidence",
      "delivery",
      "buyer-received",
      "delivery-evidence",
      "audit",
    ]);
  });

  it("resumes unfinished work through a new coordinator instance", async () => {
    const store = createInMemoryFixedPriceX402CoordinatorStore();
    const calls: string[] = [];
    const options = {
      store,
      operations: {
        agreement: finalOperation("agreement", calls),
        payment: finalOperation("payment", calls),
      },
      now: () => 2_000,
    };
    const first = createFixedPriceX402BuyerCoordinator({
      ...options,
      workerId: "buyer-before-restart",
    });
    await first.startOrder(order());
    await first.runPending({ limit: 1 });

    const resumed = createFixedPriceX402BuyerCoordinator({
      ...options,
      workerId: "buyer-after-restart",
    });
    expect((await resumed.getOrderStatus(JOB_ID))?.milestone).toBe("agreement-final");
    await resumed.resumePendingOrders();
    expect((await resumed.getOrderStatus(JOB_ID))?.milestone).toBe("payment-final");
    expect(calls).toEqual(["agreement", "payment"]);
  });

  it("is idempotent for the same binding and rejects job-id rebinding", async () => {
    const coordinator = createFixedPriceX402BuyerCoordinator({
      store: createInMemoryFixedPriceX402CoordinatorStore(),
      workerId: "buyer-worker",
      operations: {},
    });
    const original = order();
    const first = await coordinator.startOrder(original);
    const second = await coordinator.startOrder(structuredClone(original));
    expect(second.bindingHash).toBe(first.bindingHash);
    expect(first.bindingHash).toBe(fixedPriceX402OrderBindingHash(original));

    await expect(coordinator.startOrder(order({ seller: "did:example:substitute" })))
      .rejects.toThrow(/conflicts with an existing binding/);
  });

  it("projects global milestones only from both actor-local views", async () => {
    const store = createInMemoryFixedPriceX402CoordinatorStore();
    const buyer = createFixedPriceX402BuyerCoordinator({
      store,
      workerId: "buyer-worker",
      operations: {
        agreement: async () => ({ status: "final", reference: "buyer-agreement" }),
        payment: async () => ({ status: "final", reference: "buyer-payment" }),
        "payment-evidence": async () => ({
          status: "final",
          reference: "buyer-payment-evidence-observation",
        }),
        delivery: async () => ({ status: "final", reference: "buyer-delivery-observation" }),
        "delivery-evidence": async () => ({
          status: "final",
          reference: "buyer-delivery-evidence-observation",
        }),
        audit: async () => ({ status: "final", reference: "buyer-audit" }),
      },
      now: () => 5_000,
    });
    const seller = createFixedPriceX402SellerCoordinator({
      store,
      workerId: "seller-worker",
      operations: {
        agreement: async () => ({ status: "final", reference: "seller-agreement" }),
        payment: async () => ({ status: "final", reference: "seller-payment" }),
        delivery: async () => ({ status: "final", reference: "seller-delivery" }),
        "delivery-evidence": async () => ({
          status: "final",
          reference: "seller-delivery-evidence",
        }),
        "payment-evidence": async () => ({
          status: "final",
          reference: "buyer-written-payment-evidence",
        }),
        audit: async () => ({ status: "final", reference: "seller-audit" }),
      },
      now: () => 5_000,
    });
    await buyer.startOrder(order());
    await seller.startOrder(order());
    await buyer.runPending();
    await seller.runPending({ limit: 5 });

    const beforeSellerAudit = combineFixedPriceX402OrderStatus({
      buyer: (await buyer.getOrderStatus(JOB_ID))!,
      seller: (await seller.getOrderStatus(JOB_ID))!,
    });
    expect(beforeSellerAudit.milestone).toBe("commercial-performance-complete");

    await seller.runPending();
    const completed = combineFixedPriceX402OrderStatus({
      buyer: (await buyer.getOrderStatus(JOB_ID))!,
      seller: (await seller.getOrderStatus(JOB_ID))!,
    });
    expect(completed.milestone).toBe("audit-complete");
    expect(completed.bindingHash).toBe(fixedPriceX402OrderBindingHash(order()));
  });

  it("fences an operation whose lease expires before its outcome is committed", async () => {
    let now = 3_000;
    const effects = vi.fn();
    const coordinator = createFixedPriceX402BuyerCoordinator({
      store: createInMemoryFixedPriceX402CoordinatorStore(),
      workerId: "buyer-worker",
      leaseDurationMs: 10,
      now: () => now,
      operations: {
        agreement: async ({ fence }) => {
          await fence.assertCurrent();
          effects(fence.generation, fence.idempotencyKey);
          now += 11;
          return { status: "final", reference: "agreement:final" };
        },
      },
    });
    await coordinator.startOrder(order());

    expect(await coordinator.runPending()).toEqual([{
      jobId: JOB_ID,
      track: "agreement",
      status: "stale",
    }]);
    const afterFirst = await coordinator.getOrderStatus(JOB_ID);
    expect(afterFirst?.tracks.agreement.state).toBe("running");
    expect(afterFirst?.tracks.agreement.generation).toBe(1);

    await coordinator.runPending();
    const afterSecond = await coordinator.getOrderStatus(JOB_ID);
    expect(afterSecond?.tracks.agreement.generation).toBe(2);
    expect(effects.mock.calls[0]?.[1]).toBe(effects.mock.calls[1]?.[1]);
  });

  it("does not leak mutable operation inputs into retained state", async () => {
    const coordinator = createFixedPriceX402BuyerCoordinator({
      store: createInMemoryFixedPriceX402CoordinatorStore(),
      workerId: "buyer-worker",
      now: () => 4_000,
      operations: {
        agreement: ({ order: retained }) => {
          (retained.sdkJobs as { agreement: string }).agreement = "mutated";
          return { status: "final", reference: "agreement:final" };
        },
      },
    });
    await coordinator.startOrder(order());
    await coordinator.runPending();
    expect((await coordinator.getOrderStatus(JOB_ID))?.sdkJobs.agreement)
      .toBe(`agreement:${JOB_ID}`);
  });

  it("fails closed when a store labels corrupt state as usable", async () => {
    const retained = createInMemoryFixedPriceX402CoordinatorStore();
    const setup = createFixedPriceX402BuyerCoordinator({
      store: retained,
      workerId: "setup-worker",
      operations: {},
      now: () => 6_000,
    });
    await setup.startOrder(order());
    const valid = await retained.load("buyer", JOB_ID);
    expect(valid.status).toBe("ok");
    const corrupt = structuredClone(valid.status === "ok" ? valid.record : null) as
      unknown as { tracks: { agreement: { attempts: number } } };
    corrupt.tracks.agreement.attempts = 4;
    const store = {
      ...retained,
      list: async () => [{ status: "ok" as const, record: corrupt }],
    };
    const coordinator = createFixedPriceX402BuyerCoordinator({
      store: store as unknown as typeof retained,
      workerId: "buyer-worker",
      operations: { agreement: async () => ({ status: "final", reference: "unsafe" }) },
    });
    await expect(coordinator.runPending()).rejects.toThrow(/agreement track is malformed/);
  });
});

import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  combineFixedPriceX402OrderStatus,
  createFixedPriceX402BuyerCoordinator,
  createFixedPriceX402SellerCoordinator,
  createInMemoryFixedPriceX402CoordinatorStore,
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  fixedPriceX402OrderBindingHash,
  fixedPriceX402OrderViolation,
  type FixedPriceX402CoordinatorRole,
  type FixedPriceX402OrderInput,
  type FixedPriceX402ProtocolBinding,
  type FixedPriceX402TrackOperation,
} from "../../src/commerce/index.js";
import {
  createFixedPriceX402BuyerCoordinator as rootCreateFixedPriceX402BuyerCoordinator,
} from "../../src/index.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = "did:example:buyer";
const SELLER = "did:example:seller";

const PROTOCOL: FixedPriceX402ProtocolBinding = {
  commerceProfile: FIXED_PRICE_X402_COMMERCE_PROFILE,
  standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
  phase: "pay-x402",
  orchestratorTopology: "seller-as-phase-orchestrator-v1",
  orchestrator: SELLER,
  rail: {
    registryIndexRef: FIXED_PRICE_X402_REGISTRY_INDEX_REF,
    registryIndexHash: "1".repeat(64),
    railDefinitionRef: "dacs4:rail:x402%3Adefault:2",
    railDefinitionHash: "2".repeat(64),
    railId: "x402:default",
    railVersion: 2,
    railType: "x402",
    phaseHandler: "pay-x402",
    network: "eip155:8453",
    availability: "live",
  },
};

function order(
  role: FixedPriceX402CoordinatorRole,
  overrides: Partial<FixedPriceX402OrderInput> = {},
): FixedPriceX402OrderInput {
  return {
    jobId: JOB_ID,
    buyer: BUYER,
    seller: SELLER,
    protocol: PROTOCOL,
    sdkJobs: role === "buyer"
      ? {
          role,
          agreement: `buyer:agreement:${JOB_ID}`,
          payment: `buyer:payment:${JOB_ID}`,
          paymentEvidence: `buyer:payment-evidence:${JOB_ID}`,
          buyerReceived: `buyer:received:${JOB_ID}`,
          audit: `buyer:audit:${JOB_ID}`,
        }
      : {
          role,
          agreement: `seller:agreement:${JOB_ID}`,
          payment: `seller:payment:${JOB_ID}`,
          paymentEvidence: `seller:payment-evidence:${JOB_ID}`,
          fulfilment: `seller:fulfilment:${JOB_ID}`,
          deliveryEvidence: `seller:delivery-evidence:${JOB_ID}`,
          audit: `seller:audit:${JOB_ID}`,
        },
    ...overrides,
  };
}

const finalOperation = (track: string, calls: string[]): FixedPriceX402TrackOperation =>
  async ({ fence }) => {
    await fence.assertCurrent();
    calls.push(track);
    return {
      status: "final",
      outcome: "success",
      reference: `${track}:${fence.jobId}`,
    };
  };

function classBacked<T extends object>(delegate: T): T {
  class StoreAdapter {}
  for (const key of Object.keys(delegate) as Array<keyof T>) {
    const member = delegate[key];
    if (typeof member !== "function") continue;
    Object.defineProperty(StoreAdapter.prototype, key, {
      value: (...args: unknown[]) => Reflect.apply(member, delegate, args),
    });
  }
  return new StoreAdapter() as T;
}

describe("fixed-price x402 coordinator", () => {
  it("uses the repository's exact immutable Standard vector revision", () => {
    const syncScript = readFileSync(new URL("../../scripts/sync-vectors.mjs", import.meta.url),
      "utf8");
    expect(syncScript).toContain(`"${FIXED_PRICE_X402_STANDARD_REVISION}"`);
  });

  it("is exported and ships its public coordinator documentation", async () => {
    expect(rootCreateFixedPriceX402BuyerCoordinator)
      .toBe(createFixedPriceX402BuyerCoordinator);
    const packageJson = await import("../../package.json", { with: { type: "json" } });
    expect(packageJson.default.exports["./commerce"]).toBeDefined();
    expect(packageJson.default.files).toContain("docs/fixed-price-x402-coordinator.md");
  });

  it("runs only buyer-owned tracks and reserves audit-complete for the combined view", async () => {
    const calls: string[] = [];
    const coordinator = createFixedPriceX402BuyerCoordinator({
      store: createInMemoryFixedPriceX402CoordinatorStore({ now: () => 1_000 }),
      workerId: "buyer-worker-1",
      operations: {
        agreement: finalOperation("agreement", calls),
        payment: finalOperation("payment", calls),
        "payment-evidence": finalOperation("payment-evidence", calls),
        "buyer-received": finalOperation("buyer-received", calls),
        audit: finalOperation("audit", calls),
      },
    });

    expect((await coordinator.startOrder(order("buyer"))).milestone).toBe("created");
    expect((await coordinator.runPending({ limit: 2 })).items.map((item) => item.track))
      .toEqual(["agreement", "payment"]);
    expect((await coordinator.getOrderStatus(JOB_ID))?.milestone).toBe("payment-final");
    expect((await coordinator.resumePendingOrders({ limit: 10 })).items.map(
      (item) => item.track,
    )).toEqual(["payment-evidence", "buyer-received", "audit"]);
    expect((await coordinator.getOrderStatus(JOB_ID))?.milestone).toBe("actor-audit-final");
    expect(calls).toEqual([
      "agreement",
      "payment",
      "payment-evidence",
      "buyer-received",
      "audit",
    ]);
  });

  it("rejects cross-role operations at construction", () => {
    expect(() => createFixedPriceX402BuyerCoordinator({
      store: createInMemoryFixedPriceX402CoordinatorStore(),
      workerId: "buyer-worker",
      operations: {
        delivery: async () => ({
          status: "final",
          outcome: "success",
          reference: "unsafe",
        }),
      },
    })).toThrow(/not role-owned/);
    expect(() => createFixedPriceX402SellerCoordinator({
      store: createInMemoryFixedPriceX402CoordinatorStore(),
      workerId: "seller-worker",
      operations: {
        "buyer-received": async () => ({
          status: "final",
          outcome: "success",
          reference: "unsafe",
        }),
      },
    })).toThrow(/not role-owned/);
  });

  it("combines distinct role-local pointers only after both audit bundles are final", async () => {
    const store = createInMemoryFixedPriceX402CoordinatorStore({ now: () => 5_000 });
    const buyer = createFixedPriceX402BuyerCoordinator({
      store,
      workerId: "buyer-worker",
      operations: {
        agreement: finalOperation("buyer-agreement", []),
        payment: finalOperation("buyer-payment", []),
        "payment-evidence": finalOperation("buyer-payment-evidence", []),
        "buyer-received": finalOperation("buyer-received", []),
        audit: finalOperation("buyer-audit", []),
      },
    });
    const seller = createFixedPriceX402SellerCoordinator({
      store,
      workerId: "seller-worker",
      operations: {
        agreement: finalOperation("seller-agreement", []),
        payment: finalOperation("seller-payment", []),
        "payment-evidence": finalOperation("seller-payment-evidence", []),
        delivery: finalOperation("seller-delivery", []),
        "delivery-evidence": finalOperation("seller-delivery-evidence", []),
        audit: finalOperation("seller-audit", []),
      },
    });
    await buyer.startOrder(order("buyer"));
    await seller.startOrder(order("seller"));
    await buyer.runPending({ limit: 10 });
    await seller.runPending({ limit: 5 });

    const beforeSellerAudit = combineFixedPriceX402OrderStatus({
      buyer: (await buyer.getOrderStatus(JOB_ID))!,
      seller: (await seller.getOrderStatus(JOB_ID))!,
    });
    expect(beforeSellerAudit.milestone).toBe("commercial-performance-complete");
    expect(beforeSellerAudit.actors.buyer.sdkJobs).not.toEqual(
      beforeSellerAudit.actors.seller.sdkJobs,
    );

    await seller.runPending();
    const completed = combineFixedPriceX402OrderStatus({
      buyer: (await buyer.getOrderStatus(JOB_ID))!,
      seller: (await seller.getOrderStatus(JOB_ID))!,
    });
    expect(completed.milestone).toBe("audit-complete");
    expect(completed.bindingHash).toBe(fixedPriceX402OrderBindingHash(order("buyer")));
  });

  it("anchors failure evidence and a failed terminal bundle without permitting delivery", async () => {
    const delivery = vi.fn();
    const calls: string[] = [];
    const seller = createFixedPriceX402SellerCoordinator({
      store: createInMemoryFixedPriceX402CoordinatorStore({ now: () => 8_000 }),
      workerId: "seller-worker",
      operations: {
        agreement: finalOperation("agreement", calls),
        payment: async () => {
          calls.push("payment-failed");
          return {
            status: "final",
            outcome: "failure",
            errorClass: "counterparty",
            reference: "session:payment-failed",
          };
        },
        "payment-evidence": async () => {
          calls.push("failure-evidence");
          return {
            status: "final",
            outcome: "success",
            reference: "dacs4:payment:failure-evidence",
          };
        },
        delivery,
        audit: async () => {
          calls.push("failed-bundle");
          return {
            status: "final",
            outcome: "failure",
            errorClass: "counterparty",
            reference: "dacs5:bundle:failed-counterparty",
          };
        },
      },
    });
    await seller.startOrder(order("seller"));
    expect((await seller.runPending({ limit: 10 })).items.map((item) => item.track))
      .toEqual(["agreement", "payment", "payment-evidence", "audit"]);
    expect(delivery).not.toHaveBeenCalled();
    const status = await seller.getOrderStatus(JOB_ID);
    expect(status?.milestone).toBe("terminal-failure");
    expect(status?.tracks.audit).toMatchObject({
      state: "final",
      outcome: "failure",
      errorClass: "counterparty",
    });
    expect(calls).toEqual(["agreement", "payment-failed", "failure-evidence", "failed-bundle"]);
  });

  it("rejects a terminal audit whose failure class contradicts its originating phase", async () => {
    const seller = createFixedPriceX402SellerCoordinator({
      store: createInMemoryFixedPriceX402CoordinatorStore({ now: () => 8_500 }),
      workerId: "seller-worker",
      operations: {
        agreement: finalOperation("agreement", []),
        payment: async () => ({
          status: "final",
          outcome: "failure",
          errorClass: "counterparty",
          reference: "session:payment-failed",
        }),
        "payment-evidence": finalOperation("failure-evidence", []),
        audit: async () => ({
          status: "final",
          outcome: "failure",
          errorClass: "substrate",
          reference: "dacs5:bundle:wrong-failure-class",
        }),
      },
    });
    await seller.startOrder(order("seller"));
    expect((await seller.runPending({ limit: 10 })).items.at(-1)).toMatchObject({
      track: "audit",
      status: "operator-action",
      reasonCode: "invalid-normative-outcome",
    });
    expect((await seller.getOrderStatus(JOB_ID))?.tracks.audit).toMatchObject({
      state: "operator-action",
      reasonCode: "invalid-normative-outcome",
    });
  });

  it("does not project success over a one-sided terminal audit", async () => {
    const store = createInMemoryFixedPriceX402CoordinatorStore({ now: () => 9_000 });
    const buyer = createFixedPriceX402BuyerCoordinator({
      store,
      workerId: "buyer-worker",
      operations: {
        agreement: finalOperation("buyer-agreement", []),
        payment: async () => ({
          status: "final",
          outcome: "failure",
          errorClass: "counterparty",
          reference: "session:buyer-payment-failed",
        }),
        "payment-evidence": finalOperation("buyer-failure-evidence", []),
        audit: async () => ({
          status: "final",
          outcome: "failure",
          errorClass: "counterparty",
          reference: "dacs5:bundle:buyer-failed",
        }),
      },
    });
    const seller = createFixedPriceX402SellerCoordinator({
      store,
      workerId: "seller-worker",
      operations: {
        agreement: finalOperation("seller-agreement", []),
        payment: finalOperation("seller-payment", []),
        "payment-evidence": finalOperation("seller-payment-evidence", []),
        delivery: finalOperation("seller-delivery", []),
        "delivery-evidence": finalOperation("seller-delivery-evidence", []),
      },
    });
    await buyer.startOrder(order("buyer"));
    await seller.startOrder(order("seller"));
    await buyer.runPending({ limit: 10 });
    await seller.runPending({ limit: 10 });

    const combined = combineFixedPriceX402OrderStatus({
      buyer: (await buyer.getOrderStatus(JOB_ID))!,
      seller: (await seller.getOrderStatus(JOB_ID))!,
    });
    expect(combined.actors.buyer.milestone).toBe("terminal-failure");
    expect(combined.actors.seller.milestone).toBe("commercial-performance-complete");
    expect(combined.milestone).toBe("terminal-failure");
  });

  it("rejects two failed actor audits with contradictory failure classes", async () => {
    const store = createInMemoryFixedPriceX402CoordinatorStore({ now: () => 9_500 });
    const failureCoordinator = (
      role: FixedPriceX402CoordinatorRole,
      errorClass: "counterparty" | "substrate",
    ) => (role === "buyer" ? createFixedPriceX402BuyerCoordinator :
      createFixedPriceX402SellerCoordinator)({
      store,
      workerId: `${role}-worker`,
      operations: {
        agreement: finalOperation(`${role}-agreement`, []),
        payment: async () => ({
          status: "final" as const,
          outcome: "failure" as const,
          errorClass,
          reference: `session:${role}-payment-failed`,
        }),
        "payment-evidence": finalOperation(`${role}-failure-evidence`, []),
        audit: async () => ({
          status: "final" as const,
          outcome: "failure" as const,
          errorClass,
          reference: `dacs5:bundle:${role}-failed`,
        }),
      },
    });
    const buyer = failureCoordinator("buyer", "counterparty");
    const seller = failureCoordinator("seller", "substrate");
    await buyer.startOrder(order("buyer"));
    await seller.startOrder(order("seller"));
    await buyer.runPending({ limit: 10 });
    await seller.runPending({ limit: 10 });

    const buyerStatus = (await buyer.getOrderStatus(JOB_ID))!;
    const sellerStatus = (await seller.getOrderStatus(JOB_ID))!;
    expect(() => combineFixedPriceX402OrderStatus({
      buyer: buyerStatus,
      seller: sellerStatus,
    })).toThrow(/error classes contradict/);
  });

  it("rejects structurally valid-looking states that violate the dependency DAG", async () => {
    const store = createInMemoryFixedPriceX402CoordinatorStore({ now: () => 10_000 });
    const coordinator = createFixedPriceX402BuyerCoordinator({
      store,
      workerId: "buyer-worker",
      operations: {},
    });
    await coordinator.startOrder(order("buyer"));
    const loaded = await store.load("buyer", JOB_ID);
    expect(loaded.status).toBe("ok");
    const corrupt = structuredClone(loaded.status === "ok" ? loaded.record : null) as
      NonNullable<Extract<typeof loaded, { status: "ok" }>["record"]>;
    (corrupt.tracks as Record<string, unknown>).audit = {
      state: "final",
      generation: 1,
      attempts: 1,
      updatedAt: 10_000,
      outcome: "success",
      reference: "impossible-audit",
    };
    expect(fixedPriceX402OrderViolation(corrupt)).toMatch(/dependency DAG/);
  });

  it("uses distinct role-local idempotency keys for a shared binding", async () => {
    const store = createInMemoryFixedPriceX402CoordinatorStore({ now: () => 11_000 });
    const keys: string[] = [];
    const operation: FixedPriceX402TrackOperation = ({ fence }) => {
      keys.push(fence.idempotencyKey);
      return { status: "final", outcome: "success", reference: fence.role };
    };
    const buyer = createFixedPriceX402BuyerCoordinator({
      store,
      workerId: "buyer-worker",
      operations: { agreement: operation },
    });
    const seller = createFixedPriceX402SellerCoordinator({
      store,
      workerId: "seller-worker",
      operations: { agreement: operation },
    });
    await buyer.startOrder(order("buyer"));
    await seller.startOrder(order("seller"));
    await buyer.runPending();
    await seller.runPending();
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("fences expired workers while keeping the role-local idempotency key stable", async () => {
    let now = 3_000;
    const effects = vi.fn();
    const coordinator = createFixedPriceX402BuyerCoordinator({
      store: createInMemoryFixedPriceX402CoordinatorStore({ now: () => now }),
      workerId: "buyer-worker",
      leaseDurationMs: 10,
      operations: {
        agreement: async ({ fence }) => {
          await fence.assertCurrent();
          effects(fence.generation, fence.idempotencyKey);
          now += 11;
          return { status: "final", outcome: "success", reference: "agreement:final" };
        },
      },
    });
    await coordinator.startOrder(order("buyer"));
    expect((await coordinator.runPending()).items).toEqual([{
      jobId: JOB_ID,
      track: "agreement",
      status: "stale",
    }]);
    expect((await coordinator.getOrderStatus(JOB_ID))?.tracks.agreement?.state).toBe("running");
    await coordinator.runPending();
    expect((await coordinator.getOrderStatus(JOB_ID))?.tracks.agreement?.generation).toBe(2);
    expect(effects.mock.calls[0]?.[1]).toBe(effects.mock.calls[1]?.[1]);
  });

  it("sanitizes thrown errors and supports an explicit operator repair transition", async () => {
    let now = 20_000;
    const agreement = vi.fn()
      .mockRejectedValueOnce(new Error("secret provider credential"))
      .mockReturnValueOnce({
        status: "final",
        outcome: "success",
        reference: "agreement:recovered",
      });
    const store = createInMemoryFixedPriceX402CoordinatorStore({ now: () => now });
    const coordinator = createFixedPriceX402BuyerCoordinator({
      store,
      workerId: "buyer-worker",
      operations: { agreement },
    });
    await coordinator.startOrder(order("buyer"));
    expect((await coordinator.runPending()).items[0]).toMatchObject({
      status: "indeterminate",
      reasonCode: "operation-threw",
    });
    expect(JSON.stringify(await store.load("buyer", JOB_ID)))
      .not.toContain("secret provider credential");

    await coordinator.repairTrack({
      jobId: JOB_ID,
      track: "agreement",
      operatorReasonCode: "operator-requeue",
    });
    now += 1;
    expect((await coordinator.runPending()).items[0]).toMatchObject({
      status: "final",
      outcome: "success",
    });
  });

  it("passes cooperative cancellation to an in-flight operation", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const coordinator = createFixedPriceX402BuyerCoordinator({
      store: createInMemoryFixedPriceX402CoordinatorStore({ now: () => 25_000 }),
      workerId: "buyer-worker",
      operations: {
        agreement: ({ signal }) => new Promise((_resolve, reject) => {
          observedSignal = signal;
          signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          });
        }),
      },
    });
    await coordinator.startOrder(order("buyer"));
    const pending = coordinator.runPending({ signal: controller.signal });
    await vi.waitFor(() => expect(observedSignal).toBe(controller.signal));
    controller.abort();
    expect((await pending).items).toMatchObject([{
      track: "agreement",
      status: "indeterminate",
      reasonCode: "operation-threw",
    }]);
  });

  it("accepts a structurally valid store implemented with prototype methods", async () => {
    const store = classBacked(
      createInMemoryFixedPriceX402CoordinatorStore({ now: () => 27_000 }),
    );
    expect(Object.getPrototypeOf(store)).not.toBe(Object.prototype);
    const coordinator = createFixedPriceX402BuyerCoordinator({
      store,
      workerId: "buyer-worker",
      operations: { agreement: finalOperation("agreement", []) },
    });
    await coordinator.startOrder(order("buyer"));
    expect((await coordinator.runPending()).items[0]).toMatchObject({
      track: "agreement",
      status: "final",
      outcome: "success",
    });
  });

  it("paginates runnable orders rather than rescanning historical records", async () => {
    const coordinator = createFixedPriceX402BuyerCoordinator({
      store: createInMemoryFixedPriceX402CoordinatorStore({ now: () => 30_000 }),
      workerId: "buyer-worker",
      operations: { agreement: async ({ fence }) => ({
        status: "final",
        outcome: "success",
        reference: `agreement:${fence.jobId}`,
      }) },
    });
    const suffixes = "0123456789A";
    for (const suffix of suffixes) {
      const jobId = `${JOB_ID.slice(0, -1)}${suffix}`;
      const buyerOrder = order("buyer", {
        jobId,
        sdkJobs: {
          role: "buyer",
          agreement: `buyer:agreement:${jobId}`,
          payment: `buyer:payment:${jobId}`,
          paymentEvidence: `buyer:payment-evidence:${jobId}`,
          buyerReceived: `buyer:received:${jobId}`,
          audit: `buyer:audit:${jobId}`,
        },
      });
      await coordinator.startOrder(buyerOrder);
    }
    const first = await coordinator.runPending({ limit: 10 });
    expect(first.items).toHaveLength(10);
    expect(first.nextCursor).toBeDefined();
    const second = await coordinator.runPending({ cursor: first.nextCursor, limit: 10 });
    expect(second.items).toHaveLength(1);
  });

  it("does not advance a cursor past an order that still has runnable work", async () => {
    const coordinator = createFixedPriceX402BuyerCoordinator({
      store: createInMemoryFixedPriceX402CoordinatorStore({ now: () => 35_000 }),
      workerId: "buyer-worker",
      operations: {
        agreement: async ({ fence }) => ({
          status: "final",
          outcome: "success",
          reference: `agreement:${fence.jobId}`,
        }),
        payment: async ({ fence }) => ({
          status: "final",
          outcome: "success",
          reference: `payment:${fence.jobId}`,
        }),
      },
    });
    for (const suffix of ["D", "E"]) {
      const jobId = `${JOB_ID.slice(0, -1)}${suffix}`;
      await coordinator.startOrder(order("buyer", {
        jobId,
        sdkJobs: {
          role: "buyer",
          agreement: `buyer:agreement:${jobId}`,
          payment: `buyer:payment:${jobId}`,
          paymentEvidence: `buyer:payment-evidence:${jobId}`,
          buyerReceived: `buyer:received:${jobId}`,
          audit: `buyer:audit:${jobId}`,
        },
      }));
    }

    const first = await coordinator.runPending({ limit: 1 });
    expect(first.items.map((item) => item.track)).toEqual(["agreement"]);
    expect(first.nextCursor).toBeUndefined();
    expect((await coordinator.runPending({ limit: 1 })).items.map((item) => item.track))
      .toEqual(["payment"]);
  });

  it("fails closed when the shared protocol pin changes between actors", async () => {
    const store = createInMemoryFixedPriceX402CoordinatorStore({ now: () => 40_000 });
    const buyer = createFixedPriceX402BuyerCoordinator({
      store,
      workerId: "buyer-worker",
      operations: {},
    });
    const seller = createFixedPriceX402SellerCoordinator({
      store,
      workerId: "seller-worker",
      operations: {},
    });
    await buyer.startOrder(order("buyer"));
    const altered = structuredClone(PROTOCOL);
    (altered as unknown as { rail: { network: string } }).rail.network = "eip155:1";
    await seller.startOrder(order("seller", { protocol: altered }));
    const buyerStatus = (await buyer.getOrderStatus(JOB_ID))!;
    const sellerStatus = (await seller.getOrderStatus(JOB_ID))!;
    expect(() => combineFixedPriceX402OrderStatus({
      buyer: buyerStatus,
      seller: sellerStatus,
    })).toThrow(/same order/);
  });
});

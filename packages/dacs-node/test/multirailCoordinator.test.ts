import { describe, expect, it, vi } from "vitest";

import type {
  FixedPricePayDemCommerceCoordinator,
  FixedPricePayDemOrderInput,
  FixedPriceX402CommerceCoordinator,
  FixedPriceX402OrderInput,
} from "@kynesyslabs/dacs/commerce";

import {
  createDacsLiveMultirailCoordinatorV1,
  type DacsLiveCommerceRailProfileV1,
} from "../src/multirailCoordinator.js";

const JOB = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";

function order(
  phase: "pay-x402" | "pay-dem",
  jobId = JOB,
): FixedPriceX402OrderInput | FixedPricePayDemOrderInput {
  return {
    jobId,
    protocol: { phase },
  } as FixedPriceX402OrderInput | FixedPricePayDemOrderInput;
}

function fake(profile: DacsLiveCommerceRailProfileV1) {
  const statuses = new Map<string, unknown>();
  const reports = [{
    jobId: `${profile}-job`,
    track: "payment",
    status: "processed",
  }];
  const value = {
    role: "buyer" as const,
    startOrder: vi.fn(async (input: { jobId: string }) => {
      const status = { jobId: input.jobId, profile };
      statuses.set(input.jobId, status);
      return status;
    }),
    getOrderStatus: vi.fn(async (jobId: string) => statuses.get(jobId) ?? null),
    runPending: vi.fn(async (input: { cursor?: string; limit?: number }) => ({
      items: reports.slice(0, input.limit),
      ...(input.cursor === "page-two" ? {} : { nextCursor: "page-two" }),
    })),
    resumePendingOrders: vi.fn(async (input: { cursor?: string; limit?: number }) => ({
      items: reports.slice(0, input.limit),
      ...(input.cursor === "page-two" ? {} : { nextCursor: "page-two" }),
    })),
    repairTrack: vi.fn(async (input: { jobId: string }) => statuses.get(input.jobId)),
  };
  return { value, statuses };
}

describe("live multirail coordinator", () => {
  it("selects exactly one coordinator before Agreement and never falls back", async () => {
    const x402 = fake("x402");
    const payDem = fake("pay-dem");
    const coordinator = createDacsLiveMultirailCoordinatorV1({
      role: "buyer",
      x402: x402.value as unknown as FixedPriceX402CommerceCoordinator,
      payDem: payDem.value as unknown as FixedPricePayDemCommerceCoordinator,
    });

    await coordinator.startOrder(order("pay-dem"));

    expect(payDem.value.startOrder).toHaveBeenCalledOnce();
    expect(x402.value.startOrder).not.toHaveBeenCalled();
    await expect(coordinator.getOrderStatus(JOB)).resolves.toMatchObject({
      jobId: JOB,
      profile: "pay-dem",
    });
    await expect(coordinator.startOrder(order("pay-x402"))).rejects.toMatchObject({
      reasonCode: "multirail-job-profile-conflict",
    });
    expect(x402.value.startOrder).not.toHaveBeenCalled();
  });

  it("rejects an order whose selected rail profile is disabled", async () => {
    const payDem = fake("pay-dem");
    const coordinator = createDacsLiveMultirailCoordinatorV1({
      role: "buyer",
      payDem: payDem.value as unknown as FixedPricePayDemCommerceCoordinator,
    });

    await expect(coordinator.startOrder(order("pay-x402"))).rejects.toMatchObject({
      reasonCode: "multirail-profile-disabled",
    });
    expect(payDem.value.startOrder).not.toHaveBeenCalled();
  });

  it("paginates both stores without exceeding the caller's batch limit", async () => {
    const x402 = fake("x402");
    const payDem = fake("pay-dem");
    const coordinator = createDacsLiveMultirailCoordinatorV1({
      role: "buyer",
      x402: x402.value as unknown as FixedPriceX402CommerceCoordinator,
      payDem: payDem.value as unknown as FixedPricePayDemCommerceCoordinator,
    });

    const first = await coordinator.resumePendingOrders({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(x402.value.resumePendingOrders).toHaveBeenCalledWith({ limit: 1 });
    expect(payDem.value.resumePendingOrders).toHaveBeenCalledWith({ limit: 1 });

    const second = await coordinator.resumePendingOrders({
      cursor: first.nextCursor,
      limit: 2,
    });
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeUndefined();
    expect(x402.value.resumePendingOrders).toHaveBeenLastCalledWith({
      cursor: "page-two",
      limit: 1,
    });
  });

  it("alternates enabled profiles when a worker batch contains one item", async () => {
    const x402 = fake("x402");
    const payDem = fake("pay-dem");
    const coordinator = createDacsLiveMultirailCoordinatorV1({
      role: "buyer",
      x402: x402.value as unknown as FixedPriceX402CommerceCoordinator,
      payDem: payDem.value as unknown as FixedPricePayDemCommerceCoordinator,
    });

    await coordinator.runPending({ limit: 1 });
    await coordinator.runPending({ limit: 1 });

    expect(x402.value.runPending).toHaveBeenCalledOnce();
    expect(payDem.value.runPending).toHaveBeenCalledOnce();
  });

  it("fails closed if one job identity exists in both profile stores", async () => {
    const x402 = fake("x402");
    const payDem = fake("pay-dem");
    x402.statuses.set(JOB, { jobId: JOB, profile: "x402" });
    payDem.statuses.set(JOB, { jobId: JOB, profile: "pay-dem" });
    const coordinator = createDacsLiveMultirailCoordinatorV1({
      role: "buyer",
      x402: x402.value as unknown as FixedPriceX402CommerceCoordinator,
      payDem: payDem.value as unknown as FixedPricePayDemCommerceCoordinator,
    });

    await expect(coordinator.getOrderStatus(JOB)).rejects.toMatchObject({
      reasonCode: "multirail-job-identity-conflict",
    });
  });
});

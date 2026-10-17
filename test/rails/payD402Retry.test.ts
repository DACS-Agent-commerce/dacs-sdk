import { describe, expect, test, vi } from "vitest";
import type { SettleRequest } from "../../src/agent/runSessionCore.js";
import { createIdempotencyStore } from "../../src/rails/idempotency.js";
import { payD402Settle, payD402ResumeSettlement, type PayD402Rail } from "../../src/rails/payD402.js";

const recipient = "demos1recipient";
const network = "demos:testnet";
const paywall = { url: "https://seller.example/premium", recipient, network };
const request = (jobId: string): SettleRequest => ({
  rail: "pay-d402", phase: "pay-d402", amount: "1", asset: "DEM",
  payee: "did:demos:seller", expectedPayee: recipient, jobId, phaseIndex: 0,
});
function rail() {
  return {
    address: "demos1payer",
    settle: vi.fn(async () => ({
      ok: true, txHash: "same-hash", chainId: network, payer: "demos1payer", payee: recipient,
      blockNumber: 42, txRefKind: "demos" as const, finality: { model: "bft-final" as const },
    })),
    waitForSettlement: vi.fn(async () => ({
      ok: true, txHash: "same-hash", chainId: network, payer: "demos1payer", payee: recipient,
      blockNumber: 42, txRefKind: "demos" as const, finality: { model: "bft-final" as const },
    })),
  } satisfies PayD402Rail;
}

describe("D402 bridge quarantine across jobs and restarts", () => {
  test("equal-price jobs in one clock tick cannot create transactions or share settlement credit", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1780000000000);
    try {
      const r = rail();
      const store = createIdempotencyStore();
      const a = payD402Settle(r, paywall, { store });
      const b = payD402Settle(r, paywall, { store });
      const outcomes = await Promise.allSettled([a(request("job-A")), b(request("job-B"))]);
      expect(outcomes.map((r) => r.status)).toEqual(["rejected", "rejected"]);
      for (const result of outcomes) {
        if (result.status === "rejected") expect(result.reason.message).toMatch(/pay-d402 is unavailable/);
      }
      // A new bridge/store after restart also cannot submit or credit the hash.
      await expect(payD402Settle(r, paywall, { store: createIdempotencyStore() })(request("job-B")))
        .rejects.toThrow(/unavailable/);
      expect(r.settle).not.toHaveBeenCalled();
      expect(r.waitForSettlement).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  test.each([
    ["unrelated included transaction", ["same-hash"]],
    ["uncredited included transaction", ["same-hash"]],
    ["included and unresolved attempts", ["same-hash", "pending-hash"]],
    ["duplicate history entries", ["same-hash", "0xSAME-HASH"]],
    ["another job's included hash", ["same-hash"]],
  ])("recovery cannot turn %s into DACS finality", async (_label, hashes) => {
    const r = rail();
    await expect(payD402ResumeSettlement(r, paywall)({
      ...request("job-B"), priorAttempts: hashes.map((txHash) => ({ txHash, chainId: network, ok: false })),
    })).rejects.toThrow(/read-only operator reconciliation; do not pay again/);
    expect(r.settle).not.toHaveBeenCalled();
    expect(r.waitForSettlement).not.toHaveBeenCalled();
  });
});

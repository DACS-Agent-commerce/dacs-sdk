import { describe, expect, it, vi } from "vitest";
import { observeDemosExecutionByHash } from "../../src/rails/payDem.js";

const hash = "ab".repeat(32);
const payer = "11".repeat(32);
const payee = "22".repeat(32);
const expected = { blockNumber: 42,
  transfer: { payer, payee, nonce: 9, amountOs: 1n, postFork: true } };
const options = { transactionRecordTimeoutMs: 10,
  inclusionPollIntervalMs: 5, statusRequestTimeoutMs: 50 };
const record = { hash, status: "confirmed", blockNumber: 42, content: {
  type: "native", from: payer, to: payee, nonce: "9", amount: "1",
  data: ["native", { nativeOperation: "send", args: [payee, "1"] }],
} };

describe("pay-dem execution record budget boundaries", () => {
  it.each(["confirmed", "failed"])("recognizes literal terminal status %s", async (status) => {
    const read = vi.fn(async () => ({ ...record, status }));
    await expect(observeDemosExecutionByHash(hash, read, expected, {
      ...options, transactionRecordTimeoutMs: 50,
    })).resolves.toEqual({ state: status === "confirmed" ? "executed" : "failed" });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("starts no read when the remaining budget is exactly zero", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValue(1_010);
    const read = vi.fn(async () => record);
    try {
      await expect(observeDemosExecutionByHash(hash, read, expected, options))
        .resolves.toEqual({ state: "indeterminate", reason: "transaction record was not observed" });
      expect(read).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it("returns the complete outcome without scheduling a poll at the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const read = vi.fn(async () => { vi.setSystemTime(1_010); return null; });
    try {
      let outcome: unknown;
      const pending = observeDemosExecutionByHash(hash, read, expected, options)
        .then((value) => { outcome = value; });
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      expect(outcome).toEqual({ state: "indeterminate",
        reason: "transaction record is missing or malformed" });
      expect(read).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([2, 20])("bounds a record completing after %s ms by the remaining budget", async (delay) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const read = vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(record), delay)));
    try {
      let outcome: unknown;
      const pending = observeDemosExecutionByHash(hash, read, expected, options)
        .then((value) => { outcome = value; });
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(9);
      expect(outcome).toEqual(delay < 10 ? { state: "executed" } : {
        state: "indeterminate", reason: "transaction record read timed out",
      });
      await pending;
      await vi.advanceTimersByTimeAsync(20);
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

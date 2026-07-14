import { describe, expect, test } from "vitest";

import type { SettleRequest, SettleResult } from "../../src/agent/runSessionCore.js";
import { evmErc20Settle, type EvmErc20Rail } from "../../src/rails/evmErc20.js";
import {
  createIdempotencyStore,
  settlementKey,
} from "../../src/rails/idempotency.js";

const ok = (txHash: string): SettleResult => ({
  ok: true,
  txHash,
  chainId: "eip155:84532",
  payer: "0xpayer",
  payee: "0xpayee",
});

describe("settlement idempotency store (#43)", () => {
  test("a repeated call for the same key returns the recorded result WITHOUT resubmitting", async () => {
    const store = createIdempotencyStore();
    let calls = 0;
    const submit = async () => ((calls += 1), ok(`0x${calls}`));
    const first = await store.once("k", submit);
    const second = await store.once("k", submit);
    expect(calls).toBe(1); // submitted at most once
    expect(second).toEqual(first); // same tx, not a new one
  });

  test("concurrent calls for one key share a single submission (no double-submit)", async () => {
    const store = createIdempotencyStore();
    let calls = 0;
    const submit = async () => {
      calls += 1;
      await Promise.resolve();
      return ok(`0x${calls}`);
    };
    const [a, b] = await Promise.all([store.once("k", submit), store.once("k", submit)]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
  });

  test("a failed/non-definitive submission is NOT recorded (stays retryable)", async () => {
    const store = createIdempotencyStore();
    let calls = 0;
    const submit = async () => {
      calls += 1;
      return calls === 1
        ? ({ ok: false, txHash: "", chainId: "x", payer: "p", payee: "q" } as SettleResult)
        : ok("0xgood");
    };
    const bad = await store.once("k", submit);
    expect(bad.ok).toBe(false);
    const good = await store.once("k", submit); // retried, since the first wasn't recorded
    expect(calls).toBe(2);
    expect(good.txHash).toBe("0xgood");
  });

  test("a persisted `done` map makes it crash-safe across runs (resume finds the result)", async () => {
    const done = new Map<string, SettleResult>();
    let calls = 0;
    const submit = async () => ((calls += 1), ok(`0x${calls}`));
    // Run 1 settles, then "crashes" (store already recorded).
    await createIdempotencyStore(done).once("k", submit);
    // Run 2 (fresh store, SAME durable map) resumes — no resubmit.
    const resumed = await createIdempotencyStore(done).once("k", submit);
    expect(calls).toBe(1);
    expect(resumed.txHash).toBe("0x1");
  });
});

describe("evmErc20Settle bridge threads the idempotency key (#43 repro)", () => {
  // The issue's repro: calling the direct ERC-20 wrapper twice with the same
  // SettleRequest produced TWO transfers. With a store it must produce one.
  function countingRail(): EvmErc20Rail & { transferCalls: number } {
    const rail = {
      address: "0xme",
      transferCalls: 0,
      async settle() {
        rail.transferCalls += 1;
        return ok(`0x${rail.transferCalls}`);
      },
    };
    return rail;
  }
  const req: SettleRequest = {
    rail: "evm-erc20-usdc",
    amount: "1000000",
    asset: "USDC",
    payee: "0xpayee",
    jobId: "job-1",
    phaseIndex: 0,
  };
  const cfg = { tokenAddress: "0xtoken", network: "eip155:84532", recipientEvm: "0xpayee" };

  test("without a store: twice → two transfers (the bug)", async () => {
    const rail = countingRail();
    const settle = evmErc20Settle(rail, cfg);
    await settle(req);
    await settle(req);
    expect(rail.transferCalls).toBe(2);
  });

  test("with a store: twice → one transfer (fixed)", async () => {
    const rail = countingRail();
    const settle = evmErc20Settle(rail, cfg, { store: createIdempotencyStore() });
    const a = await settle(req);
    const b = await settle(req);
    expect(rail.transferCalls).toBe(1);
    expect(b).toEqual(a);
  });

  test("settlementKey is (railId, jobId, phaseIndex)", () => {
    expect(settlementKey("evm-erc20-usdc", "job-1", 0)).toBe("evm-erc20-usdc:job-1:0");
  });
});

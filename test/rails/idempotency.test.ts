import { describe, expect, test } from "vitest";

import type { SettleRequest, SettleResult } from "../../src/agent/runSessionCore.js";
import { evmErc20Settle, type EvmErc20Rail } from "../../src/rails/evmErc20.js";
import {
  createIdempotencyStore,
  createInMemorySettlementLog,
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

  test("a durable log makes it crash-safe across runs (resume finds the recorded result)", async () => {
    const log = createInMemorySettlementLog();
    let calls = 0;
    const submit = async () => ((calls += 1), ok(`0x${calls}`));
    // Run 1 settles, then "crashes" (log already recorded the outcome).
    await createIdempotencyStore(log).once("k", submit);
    // Run 2 (fresh store, SAME durable log) resumes — no resubmit.
    const resumed = await createIdempotencyStore(log).once("k", submit);
    expect(calls).toBe(1);
    expect(resumed.txHash).toBe("0x1");
  });

  test("value moved but the response was LOST → a fresh-process retry does NOT resubmit; it fails closed", async () => {
    // The reviewer's window: submit MOVES value, then throws before the outcome is
    // recorded (lost response / crash). The write-ahead intent survives in the
    // durable log, so the next attempt must NOT pay again.
    const log = createInMemorySettlementLog();
    let sends = 0;
    const submitThatMovesValueThenLosesResponse = async (): Promise<SettleResult> => {
      sends += 1; // value moved on-chain…
      throw new Error("response lost after broadcast");
    };
    // Run 1: value moves, response lost.
    await expect(
      createIdempotencyStore(log).once("k", submitThatMovesValueThenLosesResponse),
    ).rejects.toThrow(/response lost/);
    expect(sends).toBe(1);

    // Run 2 (fresh process, SAME durable log): the unresolved intent is seen. With
    // NO reconcile capability the store FAILS CLOSED rather than double-paying.
    await expect(
      createIdempotencyStore(log).once("k", async () => ok("0xsecond")),
    ).rejects.toThrow(/unresolved prior attempt|double-pay/);
    expect(sends).toBe(1); // never sent a second transfer
  });

  test("reconcile ADOPTS a prior payment that landed (no resubmit)", async () => {
    const log = createInMemorySettlementLog();
    let sends = 0;
    // Run 1: value moved, response lost → unresolved intent.
    await expect(
      createIdempotencyStore(log).once("k", async () => {
        sends += 1;
        throw new Error("lost");
      }),
    ).rejects.toThrow();
    // Run 2: reconcile proves the prior transfer landed → adopt it, don't resubmit.
    const reconcile = async () => ok("0xlanded");
    const res = await createIdempotencyStore(log).once("k", async () => {
      sends += 1;
      return ok("0xwould-be-double");
    }, reconcile);
    expect(res.txHash).toBe("0xlanded");
    expect(sends).toBe(1); // reconciled, not resubmitted
  });

  test("reconcile that PROVES no payment landed permits a safe resubmit", async () => {
    const log = createInMemorySettlementLog();
    let sends = 0;
    await expect(
      createIdempotencyStore(log).once("k", async () => {
        sends += 1;
        throw new Error("failed before broadcast");
      }),
    ).rejects.toThrow();
    // Run 2: reconcile returns null (provably NOT paid) → resubmit is allowed.
    const reconcile = async () => null;
    const res = await createIdempotencyStore(log).once("k", async () => {
      sends += 1;
      return ok("0xretry");
    }, reconcile);
    expect(res.txHash).toBe("0xretry");
    expect(sends).toBe(2); // safely resubmitted after reconcile proved no prior payment
  });

  test("atomic claim: two stores over ONE durable log, concurrent → exactly one submits (#52)", async () => {
    // Cross-process shape: two store instances (separate inflight maps) share one
    // durable log. Without an ATOMIC claim both would submit; the put-if-absent
    // claim lets exactly one win — the loser fails closed, never a second send.
    const log = createInMemorySettlementLog();
    let sends = 0;
    const submit = async () => {
      sends += 1;
      await Promise.resolve();
      return ok(`0x${sends}`);
    };
    const results = await Promise.allSettled([
      createIdempotencyStore(log).once("k", submit),
      createIdempotencyStore(log).once("k", submit),
    ]);
    expect(sends).toBe(1); // the atomic claim prevented a second on-chain submission
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
  });

  test("a TX-BEARING non-definitive result does NOT clear the intent → retry fails closed (#52)", async () => {
    // ok:false BUT with a txHash — a tx was broadcast, so value MAY have moved.
    // The intent must survive (unlike a no-tx result), so a retry can't resubmit.
    const log = createInMemorySettlementLog();
    let sends = 0;
    const submit = async (): Promise<SettleResult> => {
      sends += 1;
      return { ok: false, txHash: "0xbroadcast", chainId: "c", payer: "p", payee: "q" };
    };
    const first = await createIdempotencyStore(log).once("k", submit);
    expect(first.ok).toBe(false);
    expect(sends).toBe(1);
    // A fresh attempt with no reconcile must FAIL CLOSED — never resubmit.
    await expect(
      createIdempotencyStore(log).once("k", submit),
    ).rejects.toThrow(/unresolved|in-flight|double-pay/);
    expect(sends).toBe(1); // the broadcast tx was never re-sent
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
    phase: "pay-evm-erc20",
    amount: "1000000",
    asset: "USDC",
    payee: "0xpayee",
    expectedPayee: "0xpayee",
    jobId: "job-1",
    phaseIndex: 0,
  };
  const cfg = { tokenAddress: "0xtoken", network: "eip155:84532", recipientEvm: "0xpayee" };

  test("direct EVM bridge rejects a destination mismatch before transfer", async () => {
    const rail = countingRail();
    expect(() =>
      evmErc20Settle(rail, cfg)({ ...req, expectedPayee: "0xother" }),
    ).toThrow(/destination mismatch/);
    expect(rail.transferCalls).toBe(0);
  });

  test("SAFE BY DEFAULT: twice with the same request → one transfer (no opt-in store needed)", async () => {
    const rail = countingRail();
    const settle = evmErc20Settle(rail, cfg); // no store supplied — default is safe
    const a = await settle(req);
    const b = await settle(req);
    expect(rail.transferCalls).toBe(1); // the bug (2 transfers) is gone by default
    expect(b).toEqual(a);
  });

  test("an injected durable store dedupes across bridge instances (cross-resume)", async () => {
    const rail = countingRail();
    const store = createIdempotencyStore(createInMemorySettlementLog());
    // Two SEPARATE bridge instances sharing one durable store (a fresh-process resume).
    await evmErc20Settle(rail, cfg, { store })(req);
    const b = await evmErc20Settle(rail, cfg, { store })(req);
    expect(rail.transferCalls).toBe(1);
    expect(b.txHash).toBe("0x1");
  });

  test("settlementKey is (railId, jobId, phaseIndex)", () => {
    expect(settlementKey("evm-erc20-usdc", "job-1", 0)).toBe("evm-erc20-usdc:job-1:0");
  });

  test("settlementKey rejects a non-NFC job id instead of aliasing it", () => {
    expect(() => settlementKey("evm-erc20-usdc", "cafe\u0301-job", 0)).toThrow(
      /exact NFC/,
    );
  });
});

import { describe, expect, test, vi } from "vitest";

import type { SettleRequest, SettleResult } from "../../src/agent/runSessionCore.js";
import { evmErc20Settle, type EvmErc20Rail } from "../../src/rails/evmErc20.js";
import {
  createIdempotencyStore,
  createInMemorySettlementLog,
  type SettlementIdempotencyStore,
  type SettlementLog,
} from "../../src/rails/idempotency.js";
import { payDemSettle } from "../../src/rails/payDem.js";
import { x402Settle, type X402Rail } from "../../src/rails/x402.js";

// These unit tests exercise the recovery rules with injected capabilities.
vi.mock("../../src/rails/payDemExecutionAuthority.js", async () =>
  import("../support/payDemExecutionAuthority.js"));

const hash = "12".repeat(32);
const payer = "ab".repeat(32);
const payee = "cd".repeat(32);
const claim = `did:demos:agent:${payee}`;
const demRequest: SettleRequest = {
  rail: "pay-dem", phase: "pay-dem", phaseIndex: 0, jobId: "recovery-only",
  amount: "1", asset: "DEM", payee: claim, expectedPayee: claim,
};
const evmRequest: SettleRequest = {
  rail: "evm-erc20-usdc", phase: "pay-evm-erc20", phaseIndex: 0, jobId: "recovery-only",
  amount: "1000000", asset: "USDC", payee: "0xpayee", expectedPayee: "0xpayee",
};
const x402Request: SettleRequest = {
  rail: "pay-x402", phase: "pay-x402", phaseIndex: 0, jobId: "recovery-only",
  amount: "1", asset: "USDC", payee: "did:example:seller", expectedPayee: "0xpayee",
};
const evmCfg = { tokenAddress: "0xtoken", network: "eip155:84532", recipientEvm: "0xpayee" };
const x402Cfg = { url: "https://seller.example/deliver", network: "eip155:84532", recipientEvm: "0xpayee", asset: "0xtoken" };
const evmPaid: SettleResult = {
  ok: true, txHash: "0xpaid", chainId: "eip155:84532", payer: "0xme", payee: "0xpayee",
  finality: { model: "block-depth", finalityBlocks: 12 }, blockNumber: 1, txRefKind: "evm",
};

/** An ERC-20 rail that counts submissions; `settle` runs `behaviour` and defaults to a paid result. */
const countingEvmRail = (
  behaviour: () => Promise<SettleResult> = async () => evmPaid,
): EvmErc20Rail & { calls: number } => {
  const rail = {
    address: "0xme", finalityBlocks: 12, calls: 0,
    async settle() {
      rail.calls += 1;
      return behaviour();
    },
  };
  return rail as unknown as EvmErc20Rail & { calls: number };
};

describe("recoveryOnly never takes a fresh claim", () => {
  test("recoveryOnly refuses a fresh claim when the log has no record", async () => {
    const rail = countingEvmRail();
    const settle = evmErc20Settle(rail, evmCfg, { store: createIdempotencyStore(createInMemorySettlementLog()) });
    await expect(settle({ ...evmRequest, recoveryOnly: true })).rejects.toThrow(/no recorded settlement/);
    expect(rail.calls).toBe(0);
  });

  test("recoveryOnly with a recorded outcome returns it without paying again", async () => {
    const rail = countingEvmRail();
    const settle = evmErc20Settle(rail, evmCfg, { store: createIdempotencyStore(createInMemorySettlementLog()) });
    const paid = await settle(evmRequest);
    await expect(settle({ ...evmRequest, recoveryOnly: true })).resolves.toEqual(paid);
    expect(rail.calls).toBe(1);
  });

  test("recoveryOnly with a store that has no readOutcome refuses", async () => {
    const rail = countingEvmRail();
    const inner = createIdempotencyStore(createInMemorySettlementLog());
    const store: SettlementIdempotencyStore = { once: (...args) => inner.once(...args) };
    await expect(evmErc20Settle(rail, evmCfg, { store })({ ...evmRequest, recoveryOnly: true }))
      .rejects.toThrow(/read-only outcome lookup/);
    expect(rail.calls).toBe(0);
  });

  test("payDemSettle recoveryOnly with no retained hash never calls the rail", async () => {
    const submit = vi.fn();
    const settle = payDemSettle({ address: payer, settle: submit }, {}, {
      store: createIdempotencyStore(createInMemorySettlementLog()),
      reconcile: async () => null,
    });
    await expect(settle({ ...demRequest, recoveryOnly: true })).rejects.toThrow(/no recorded settlement/);
    expect(submit).not.toHaveBeenCalled();
  });

  test("a recovery request that carries a retained hash still reconciles", async () => {
    const submit = vi.fn();
    const reconcile = vi.fn(async () => null);
    const settle = payDemSettle({ address: payer, settle: submit }, {}, {
      store: createIdempotencyStore(createInMemorySettlementLog()), reconcile,
    });
    await expect(settle({ ...demRequest, recoveryOnly: true, priorAttempts: [{ txHash: hash, chainId: "demos", ok: false }] }))
      .rejects.toThrow(/proof of absence/);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("recoveryOnly after a crash that left an intent and no outcome", () => {
  const LEASE_MS = 30_000;
  const AFTER_EVERY_LEASE_MS = 365 * 24 * 60 * 60 * 1000;
  type Process = { settle: (req: SettleRequest) => Promise<SettleResult>; submits: () => number };

  /** One process of each rail over a shared log: `crashBeforeOutcome` makes its submit die without an outcome. */
  const rails: Array<[string, SettleRequest, (log: SettlementLog, now: number, crashBeforeOutcome: boolean) => Process]> = [
    ["pay-dem", demRequest, (log, now, crash) => {
      const submit = vi.fn(async () => { if (crash) throw new Error("process died"); throw new Error("unexpected submit"); });
      const store = createIdempotencyStore(log, { now: () => now, leaseDurationMs: LEASE_MS });
      return { settle: payDemSettle({ address: payer, settle: submit }, {}, { store, reconcile: async () => null }), submits: () => submit.mock.calls.length };
    }],
    ["evm-erc20", evmRequest, (log, now, crash) => {
      const rail = countingEvmRail(async () => { throw new Error(crash ? "process died" : "unexpected submit"); });
      const store = createIdempotencyStore(log, { now: () => now, leaseDurationMs: LEASE_MS });
      return { settle: evmErc20Settle(rail, evmCfg, { store }), submits: () => rail.calls };
    }],
    ["x402", x402Request, (log, now, crash) => {
      let submits = 0;
      const rail: X402Rail = {
        address: "0xme", finalityBlocks: 12,
        settle: async () => { submits += 1; throw new Error(crash ? "process died" : "unexpected submit"); },
      };
      const store = createIdempotencyStore(log, { now: () => now, leaseDurationMs: LEASE_MS });
      return { settle: x402Settle(rail, x402Cfg, { store }), submits: () => submits };
    }],
  ];

  test.each(rails)(
    "restart twice after an intent-only recovery refusal never submits on pay-dem, ERC-20 or x402 (%s)",
    async (_name, request, buildProcess) => {
      const log = createInMemorySettlementLog();
      const crashed = buildProcess(log, 1_000, true);
      await expect(crashed.settle(request)).rejects.toThrow();
      expect(crashed.submits()).toBe(1);

      const restarts = [1_000, 1_000 + 2 * LEASE_MS, 1_000 + AFTER_EVERY_LEASE_MS].map((now) => buildProcess(log, now, false));
      for (const restarted of restarts) {
        await expect(restarted.settle({ ...request, recoveryOnly: true })).rejects.toThrow(/no recorded settlement/);
        expect(restarted.submits()).toBe(0);
      }
    },
  );

  test("recovery-only rejects intent-only and conflicting bindings while another worker completes", async () => {
    const log = createInMemorySettlementLog();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    let entered!: () => void;
    const inRail = new Promise<void>((resolve) => { entered = resolve; });
    const workerA = countingEvmRail(async () => { entered(); await gate; return evmPaid; });
    const workerB = countingEvmRail();
    const settleA = evmErc20Settle(workerA, evmCfg, { store: createIdempotencyStore(log) });
    const settleB = evmErc20Settle(workerB, evmCfg, { store: createIdempotencyStore(log) });

    const completing = settleA(evmRequest);
    await inRail; // A holds the intent and is inside the rail
    await expect(settleB({ ...evmRequest, recoveryOnly: true })).rejects.toThrow(/no recorded settlement/);
    await expect(settleB({ ...evmRequest, amount: "2000000", recoveryOnly: true })).rejects.toThrow(/conflicts/);
    expect(workerB.calls).toBe(0);

    finish();
    const paid = await completing;
    await expect(settleB({ ...evmRequest, recoveryOnly: true })).resolves.toEqual(paid);
    await expect(settleB({ ...evmRequest, amount: "2000000", recoveryOnly: true })).rejects.toThrow(/conflicts/);
    expect(workerA.calls).toBe(1);
    expect(workerB.calls).toBe(0);
  });
});

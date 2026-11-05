import { describe, expect, test, vi } from "vitest";

import type { SettleRequest, SettleResult } from "../../src/agent/runSessionCore.js";
import { evmErc20Settle, type EvmErc20Rail } from "../../src/rails/evmErc20.js";
import {
  createIdempotencyStore,
  createInMemorySettlementLog,
  isSettlementBridge,
  registerSettlementBridge,
  settlementBindingHash,
  settlementBridgeTraits,
  settlementKey,
  type SettlementBinding,
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
const evmNotInvoked = {
  disposition: "not-invoked" as const,
  result: { ok: false, txHash: "", chainId: "eip155:84532", payer: "0xme", payee: "0xpayee" },
};
const LEASE_MS = 30_000;
const RECOVERY_REFUSED = /recovery found no recorded settlement; refusing a fresh payment/;
const NEEDS_RECOVER = /recovery requires a store with recover\(\); refusing a fresh payment/;

/** An ERC-20 rail that counts submissions; `settle` runs `behaviour` and defaults to a paid result. */
const countingEvmRail = (
  behaviour: () => Promise<unknown> = async () => evmPaid,
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

type Bridge = { settle: (req: SettleRequest) => Promise<SettleResult>; submits: () => number };
/** One bridge of each rail over `store`; its rail pays unless `crash` makes it die without an outcome. */
const bridges: Array<[string, SettleRequest, (store: SettlementIdempotencyStore, crash?: boolean) => Bridge]> = [
  ["evm-erc20", evmRequest, (store, crash) => {
    const rail = countingEvmRail(async () => { if (crash) throw new Error("process died"); return evmPaid; });
    return { settle: evmErc20Settle(rail, evmCfg, { store }), submits: () => rail.calls };
  }],
  ["x402", x402Request, (store, crash) => {
    let submits = 0;
    const rail: X402Rail = {
      address: "0xme", finalityBlocks: 12,
      settle: async () => { submits += 1; if (crash) throw new Error("process died"); return evmPaid; },
    };
    return { settle: x402Settle(rail, x402Cfg, { store }), submits: () => submits };
  }],
  ["pay-dem", demRequest, (store, crash) => {
    const submit = vi.fn(async () => { throw new Error(crash ? "process died" : "unexpected submit"); });
    return {
      settle: payDemSettle({ address: payer, settle: submit }, {}, { store, reconcile: async () => null }),
      submits: () => submit.mock.calls.length,
    };
  }],
];

/** A log that records the claim stages and releases it hands out, and lets a test hook each call. */
const tracingLog = (
  inner: SettlementLog,
  hooks: Partial<Pick<SettlementLog, "claimIntent" | "releaseIntent">> = {},
): SettlementLog & { events: string[] } => {
  const events: string[] = [];
  return {
    events,
    readOutcome: (key) => inner.readOutcome!(key),
    claimIntent: async (input) => {
      const claimed = await (hooks.claimIntent ?? inner.claimIntent)(input);
      events.push(claimed.status === "acquired" ? `claim:${claimed.lease.stage}` : `claim:${claimed.status}`);
      return claimed;
    },
    isCurrent: (input) => inner.isCurrent(input),
    grantRecovery: async (input) => {
      const grant = await inner.grantRecovery(input);
      events.push(`grant:${grant.status}`);
      return grant;
    },
    putOutcome: (input) => inner.putOutcome(input),
    releaseIntent: async (input) => {
      const released = await (hooks.releaseIntent ?? inner.releaseIntent)(input);
      events.push(`release:${released}`);
      return released;
    },
  };
};

// Store-level fixtures: a binding with a deterministic effect identity, so a bound replay is possible.
const binding: SettlementBinding = {
  bindingVersion: "1", railId: "evm-erc20-usdc", jobId: "store-level", phaseIndex: 0, phase: "pay-evm-erc20",
  amount: "1000000", agreementAsset: "USDC", settlementAsset: "0xtoken", payer: "0xme", payee: "0xpayee",
  network: "eip155:84532", finality: { model: "block-depth", finalityBlocks: 12 }, effectIdentity: "nonce-1",
};
const key = settlementKey(binding.railId, binding.jobId, binding.phaseIndex);
const storeAt = (log: SettlementLog, now: number) => createIdempotencyStore(log, { now: () => now, leaseDurationMs: LEASE_MS });
/** Leave an unresolved intent in `log`: a submit that dies at t=1000 without an outcome. */
const crashInsideRail = async (log: SettlementLog) => {
  await expect(storeAt(log, 1_000).once(key, binding, async () => { throw new Error("process died"); }))
    .rejects.toThrow(/process died/);
};

describe("a recovery request never takes a fresh claim", () => {
  test.each([
    ["{}", {}],
    ["undefined", undefined],
    ["an array", []],
    ["a result for other terms", { ...evmPaid, payee: "0xother" }],
    ["a well-shaped stale result", evmPaid],
  ])("a store without recover() is refused whatever readOutcome answers (%s)", async (_label, answer) => {
    for (const [, request, buildBridge] of bridges) {
      const inner = createIdempotencyStore(createInMemorySettlementLog());
      const store: SettlementIdempotencyStore = {
        once: (...args) => inner.once(...args),
        readOutcome: async () => answer as SettleResult | null,
      };
      const bridge = buildBridge(store);
      await expect(bridge.settle({ ...request, recoveryOnly: true })).rejects.toThrow(NEEDS_RECOVER);
      expect(bridge.submits()).toBe(0);
    }
  });

  test.each(bridges)("the built-in store over an empty log refuses with no submit (%s)", async (_name, request, buildBridge) => {
    const log = tracingLog(createInMemorySettlementLog());
    const bridge = buildBridge(createIdempotencyStore(log));
    await expect(bridge.settle({ ...request, recoveryOnly: true })).rejects.toThrow(RECOVERY_REFUSED);
    expect(bridge.submits()).toBe(0);
    expect(log.events).toEqual(["claim:fresh", "release:released"]);
  });

  test.each(bridges.slice(0, 2))("a refusal leaves no stuck state: it repeats, then a plain request pays (%s)", async (_name, request, buildBridge) => {
    const bridge = buildBridge(createIdempotencyStore(createInMemorySettlementLog()));
    await expect(bridge.settle({ ...request, recoveryOnly: true })).rejects.toThrow(RECOVERY_REFUSED);
    await expect(bridge.settle({ ...request, recoveryOnly: true })).rejects.toThrow(RECOVERY_REFUSED);
    await expect(bridge.settle(request)).resolves.toMatchObject({ ok: true, txHash: "0xpaid" });
    expect(bridge.submits()).toBe(1);
  });

  test("a record released after a not-invoked attempt is refused and stays released", async () => {
    const log = createInMemorySettlementLog();
    let answer: unknown = evmNotInvoked;
    const rail = countingEvmRail(async () => answer);
    const settle = evmErc20Settle(rail, evmCfg, { store: createIdempotencyStore(log) });
    await expect(settle(evmRequest)).resolves.toMatchObject({ ok: false });
    expect(rail.calls).toBe(1);

    await expect(settle({ ...evmRequest, recoveryOnly: true })).rejects.toThrow(RECOVERY_REFUSED);
    expect(rail.calls).toBe(1);
    const evmKey = settlementKey(evmRequest.rail, evmRequest.jobId, 0);
    expect(Object.keys((await log.readOutcome!(evmKey))!)).toEqual(["bindingHash"]);

    answer = evmPaid;
    await expect(settle(evmRequest)).resolves.toMatchObject({ ok: true, txHash: "0xpaid" });
    expect(rail.calls).toBe(2);
  });

  test("a release that lands while the recovery waits for its claim is refused by that claim", async () => {
    const inner = createInMemorySettlementLog();
    let openClaim!: () => void;
    const claimBarrier = new Promise<void>((resolve) => { openClaim = resolve; });
    let claimWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => { claimWaiting = resolve; });
    const gated = tracingLog(inner, {
      claimIntent: async (input) => { claimWaiting(); await claimBarrier; return inner.claimIntent(input); },
    });
    let finishWorker!: () => void;
    const workerGate = new Promise<void>((resolve) => { finishWorker = resolve; });
    let workerInRail!: () => void;
    const inRail = new Promise<void>((resolve) => { workerInRail = resolve; });
    const worker = createIdempotencyStore(inner).once(key, binding, async () => {
      workerInRail();
      await workerGate;
      return evmNotInvoked;
    });
    await inRail; // the worker holds the intent; its read-only record is an unresolved intent
    const submit = vi.fn(async () => evmPaid);
    const recovering = createIdempotencyStore(gated).recover!(key, binding, submit);
    await waiting;
    finishWorker();
    await expect(worker).resolves.toMatchObject({ ok: false });
    openClaim();
    await expect(recovering).rejects.toThrow(RECOVERY_REFUSED);
    expect(submit).not.toHaveBeenCalled();
  });

  test("a crash between the refusing claim and its release never submits and later needs an operator", async () => {
    const inner = createInMemorySettlementLog();
    const failingRelease = tracingLog(inner, {
      releaseIntent: async () => { throw new Error("process died before the release"); },
    });
    const submit = vi.fn(async () => evmPaid);
    await expect(storeAt(failingRelease, 1_000).recover!(key, binding, submit)).rejects.toThrow(/before the release/);

    const later = tracingLog(inner);
    await expect(storeAt(later, 1_000 + 2 * LEASE_MS).recover!(key, binding, submit, async () => null))
      .rejects.toThrow(/operator action required/);
    expect(later.events).toEqual(["claim:reconcile"]);
    expect(submit).not.toHaveBeenCalled();
  });

  test("a recovery joins an in-flight first run in the same process and adopts its result", async () => {
    const store = createIdempotencyStore(createInMemorySettlementLog());
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const first = store.once(key, binding, async () => { await gate; return evmPaid; });
    const submit = vi.fn(async () => evmPaid);
    const recovering = store.recover!(key, binding, submit);
    finish();
    await expect(first).resolves.toMatchObject({ txHash: "0xpaid" });
    await expect(recovering).resolves.toMatchObject({ txHash: "0xpaid" });
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("a recovery request after a crash that left an intent and no outcome", () => {
  const AFTER_EVERY_LEASE_MS = 365 * 24 * 60 * 60 * 1000;
  /** An intent without an outcome is held, has no reconcile, or is found absent. */
  const UNRESOLVED_INTENT_REFUSAL = /refusing to resubmit|operator action required/;

  test.each(bridges)("restarting twice never submits (%s)", async (_name, request, buildBridge) => {
    const log = createInMemorySettlementLog();
    const crashed = buildBridge(storeAt(log, 1_000), true);
    await expect(crashed.settle(request)).rejects.toThrow();
    expect(crashed.submits()).toBe(1);

    for (const now of [1_000, 1_000 + 2 * LEASE_MS, 1_000 + AFTER_EVERY_LEASE_MS]) {
      const restarted = buildBridge(storeAt(log, now));
      await expect(restarted.settle({ ...request, recoveryOnly: true })).rejects.toThrow(UNRESOLVED_INTENT_REFUSAL);
      expect(restarted.submits()).toBe(0);
    }
  });

  test("a recovery refuses an intent held by another worker and other terms, then adopts that worker's payment", async () => {
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
    await expect(settleB({ ...evmRequest, recoveryOnly: true })).rejects.toThrow(UNRESOLVED_INTENT_REFUSAL);
    await expect(settleB({ ...evmRequest, amount: "2000000", recoveryOnly: true })).rejects.toThrow(/different terms/);
    expect(workerB.calls).toBe(0);

    finish();
    const paid = await completing;
    await expect(settleB({ ...evmRequest, recoveryOnly: true })).resolves.toEqual(paid);
    await expect(settleB({ ...evmRequest, amount: "2000000", recoveryOnly: true })).rejects.toThrow(/different terms/);
    expect(workerA.calls).toBe(1);
    expect(workerB.calls).toBe(0);
  });
});

describe("a recovery request reconciles an unresolved intent", () => {
  /** Crash a submit at t=1000 with an intent and no outcome, then recover after the lease with `reconcile`. */
  const crashThenRecover = async (
    buildSettle: (store: SettlementIdempotencyStore, crash: boolean, reconcile?: () => Promise<SettleResult | null>) => Bridge,
    request: SettleRequest,
    reconcile: () => Promise<SettleResult | null>,
    log: SettlementLog = createInMemorySettlementLog(),
  ) => {
    const crashed = buildSettle(storeAt(log, 1_000), true);
    await expect(crashed.settle(request)).rejects.toThrow();
    const restarted = buildSettle(storeAt(log, 1_000 + 2 * LEASE_MS), false, reconcile);
    return { restarted, result: restarted.settle({ ...request, recoveryOnly: true }) };
  };
  const evmBridge = (store: SettlementIdempotencyStore, crash: boolean, found?: () => Promise<SettleResult | null>) => {
    const rail = countingEvmRail(async () => { throw new Error(crash ? "process died" : "unexpected submit"); });
    return { settle: evmErc20Settle(rail, evmCfg, { store, reconcile: found }), submits: () => rail.calls };
  };

  test("evm-erc20 returns the reconciled payment and submits nothing", async () => {
    const reconcile = vi.fn(async () => evmPaid);
    const { restarted, result } = await crashThenRecover(evmBridge, evmRequest, reconcile);
    await expect(result).resolves.toMatchObject({ ok: true, txHash: "0xpaid" });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(restarted.submits()).toBe(0);
  });

  test("x402 returns the reconciled payment and submits nothing", async () => {
    const reconcile = vi.fn(async () => evmPaid);
    const { restarted, result } = await crashThenRecover((store, crash, found) => {
      let submits = 0;
      const rail: X402Rail = {
        address: "0xme", finalityBlocks: 12,
        settle: async () => { submits += 1; throw new Error(crash ? "process died" : "unexpected submit"); },
      };
      return { settle: x402Settle(rail, x402Cfg, { store, reconcile: found }), submits: () => submits };
    }, x402Request, reconcile);
    await expect(result).resolves.toMatchObject({ ok: true, txHash: "0xpaid" });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(restarted.submits()).toBe(0);
  });

  test("pay-dem returns the reconciled payment and submits nothing", async () => {
    const executed = {
      ok: true as const, txHash: hash, payer, payee, chainId: "demos", amountOs: "1000000000",
      blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" as const },
      networkFeeOs: "0", execution: "executed" as const,
    };
    const log = createInMemorySettlementLog();
    const crashing = vi.fn(async () => { throw new Error("process died"); });
    await expect(payDemSettle({ address: payer, settle: crashing }, {}, { store: storeAt(log, 1_000), reconcile: async () => null })(demRequest))
      .rejects.toThrow();

    const resubmit = vi.fn();
    const reconcile = vi.fn(async () => executed);
    const store = storeAt(log, 1_000 + 2 * LEASE_MS);
    await expect(payDemSettle({ address: payer, settle: resubmit }, {}, { store, reconcile })({ ...demRequest, recoveryOnly: true }))
      .resolves.toMatchObject({ ok: true, txHash: hash });
    expect(resubmit).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalled();
  });

  test("a recovery request that carries a retained pay-dem hash still reconciles", async () => {
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

  test("a reconcile that proves nothing landed still refuses and submits nothing", async () => {
    const { restarted, result } = await crashThenRecover(evmBridge, evmRequest, async () => null);
    await expect(result).rejects.toThrow(/operator action required/);
    expect(restarted.submits()).toBe(0);
  });

  test("a log without readOutcome still recovers an unresolved intent", async () => {
    const inner = createInMemorySettlementLog();
    const { readOutcome: _omitted, ...withoutLookup } = inner;
    const reconcile = vi.fn(async () => evmPaid);
    const { restarted, result } = await crashThenRecover(evmBridge, evmRequest, reconcile, withoutLookup);
    await expect(result).resolves.toMatchObject({ ok: true, txHash: "0xpaid" });
    expect(restarted.submits()).toBe(0);
  });

  const replayAuthorization = (overrides: Record<string, unknown> = {}) => ({
    disposition: "replay-authorized" as const,
    bindingHash: settlementBindingHash(binding),
    effectIdentity: "nonce-1",
    protection: "deterministic-external-idempotency" as const,
    assertReplaySafe: async () => {},
    ...overrides,
  });

  test("a bound replay authorization submits exactly once, under a granted replay lease", async () => {
    const inner = createInMemorySettlementLog();
    await crashInsideRail(inner);
    const log = tracingLog(inner);
    const submit = vi.fn(async () => { log.events.push("submit"); return evmPaid; });
    await expect(storeAt(log, 1_000 + 2 * LEASE_MS).recover!(key, binding, submit, async () => replayAuthorization()))
      .resolves.toMatchObject({ txHash: "0xpaid" });
    expect(log.events).toEqual(["claim:reconcile", "grant:granted", "submit"]);
  });

  test.each([
    ["other terms", { bindingHash: "00".repeat(32) }],
    ["another effect identity", { effectIdentity: "nonce-2" }],
  ])("a replay authorization for %s never reaches the rail", async (_label, overrides) => {
    const log = createInMemorySettlementLog();
    await crashInsideRail(log);
    const submit = vi.fn(async () => evmPaid);
    await expect(storeAt(log, 1_000 + 2 * LEASE_MS).recover!(key, binding, submit, async () => replayAuthorization(overrides)))
      .rejects.toThrow(/does not bind the retained effect identity/);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("recovery guards against a log or store that breaks the protocol", () => {
  test("a log that hands out a replay lease from claimIntent is rejected before the rail", async () => {
    const inner = createInMemorySettlementLog();
    const log = tracingLog(inner, {
      claimIntent: async (input) => {
        const claimed = await inner.claimIntent(input);
        return claimed.status === "acquired" ? { ...claimed, lease: { ...claimed.lease, stage: "replay" } } : claimed;
      },
    });
    const submit = vi.fn(async () => evmPaid);
    await expect(createIdempotencyStore(log).recover!(key, binding, submit)).rejects.toThrow(/invalid acquired generation/);
    expect(submit).not.toHaveBeenCalled();
  });

  test("a custom recover() that returns a result for other terms is rejected", async () => {
    const rail = countingEvmRail();
    const store: SettlementIdempotencyStore = {
      once: async () => evmPaid,
      recover: async () => ({ ...evmPaid, payee: "0xother" }),
    };
    await expect(evmErc20Settle(rail, evmCfg, { store })({ ...evmRequest, recoveryOnly: true }))
      .rejects.toThrow(/does not match the retained settlement network or parties/);
  });

  test("a store with only once() still settles an ordinary first run", async () => {
    const rail = countingEvmRail();
    const inner = createIdempotencyStore(createInMemorySettlementLog());
    const store: SettlementIdempotencyStore = { once: (...args) => inner.once(...args) };
    await expect(evmErc20Settle(rail, evmCfg, { store })(evmRequest)).resolves.toMatchObject({ txHash: "0xpaid" });
    expect(rail.calls).toBe(1);
  });
});

describe("the resume registry", () => {
  test("an SDK bridge is registered and a bare function is not", () => {
    const x402Rail: X402Rail = { address: "0xme", finalityBlocks: 12, settle: vi.fn() };
    const bridges = [
      payDemSettle({ address: payer, settle: vi.fn() }),
      evmErc20Settle(countingEvmRail(), evmCfg),
      x402Settle(x402Rail, x402Cfg),
    ];
    expect(bridges.map(isSettlementBridge)).toEqual([true, true, true]);
    expect(isSettlementBridge(async () => ({}))).toBe(false);
    expect(isSettlementBridge({})).toBe(false);
  });

  test("registering a bridge again keeps what it declared", () => {
    const bridge = registerSettlementBridge(async () => evmPaid, { journaled: false });
    expect(registerSettlementBridge(bridge)).toBe(bridge);
    expect(settlementBridgeTraits(bridge)).toEqual({ journaled: false });
  });

  test("a bridge that declares nothing has empty traits and a bare function has none", () => {
    expect(settlementBridgeTraits(registerSettlementBridge(async () => evmPaid))).toEqual({});
    expect(settlementBridgeTraits(async () => evmPaid)).toBeUndefined();
  });
});

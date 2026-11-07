import { describe, expect, test, vi } from "vitest";

import type { SettleRequest, SettleResult } from "../../src/agent/runSessionCore.js";
import { evmErc20Settle, type EvmErc20Rail } from "../../src/rails/evmErc20.js";
import {
  createIdempotencyStore,
  createInMemorySettlementLog,
  settlementBindingHash,
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
  hooks: Partial<Pick<SettlementLog, "claimIntent" | "claimExistingIntent" | "releaseIntent">> = {},
): SettlementLog & { events: string[] } => {
  const events: string[] = [];
  const claimExisting = hooks.claimExistingIntent ?? inner.claimExistingIntent?.bind(inner);
  return {
    events,
    readOutcome: (key) => inner.readOutcome!(key),
    claimIntent: async (input) => {
      const claimed = await (hooks.claimIntent ?? inner.claimIntent)(input);
      events.push(claimed.status === "acquired" ? `claim:${claimed.lease.stage}` : `claim:${claimed.status}`);
      return claimed;
    },
    // Omitted when the inner log has none, so a log without it can be traced too.
    ...(claimExisting === undefined ? {} : {
      claimExistingIntent: async (input: Parameters<NonNullable<SettlementLog["claimExistingIntent"]>>[0]) => {
        const claimed = await claimExisting(input);
        events.push(claimed.status === "acquired" ? `claimExisting:${claimed.lease.stage}` : `claimExisting:${claimed.status}`);
        return claimed;
      },
    }),
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
const replayAuthorization = (overrides: Record<string, unknown> = {}) => ({
  disposition: "replay-authorized" as const,
  bindingHash: settlementBindingHash(binding),
  effectIdentity: "nonce-1",
  protection: "deterministic-external-idempotency" as const,
  assertReplaySafe: async () => {},
  ...overrides,
});
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

  test.each(bridges)("the built-in store over an empty log refuses with no submit and no write (%s)", async (_name, request, buildBridge) => {
    const log = tracingLog(createInMemorySettlementLog());
    const bridge = buildBridge(createIdempotencyStore(log));
    await expect(bridge.settle({ ...request, recoveryOnly: true })).rejects.toThrow(RECOVERY_REFUSED);
    expect(bridge.submits()).toBe(0);
    expect(log.events).toEqual(["claimExisting:absent"]);
  });

  test.each(bridges.slice(0, 2))("a refusal leaves no stuck state: it repeats, then a plain request pays (%s)", async (_name, request, buildBridge) => {
    const bridge = buildBridge(createIdempotencyStore(createInMemorySettlementLog()));
    await expect(bridge.settle({ ...request, recoveryOnly: true })).rejects.toThrow(RECOVERY_REFUSED);
    await expect(bridge.settle({ ...request, recoveryOnly: true })).rejects.toThrow(RECOVERY_REFUSED);
    await expect(bridge.settle(request)).resolves.toMatchObject({ ok: true, txHash: "0xpaid" });
    expect(bridge.submits()).toBe(1);
  });

  test("a record released after a not-invoked attempt is refused and stays released", async () => {
    const log = tracingLog(createInMemorySettlementLog());
    let answer: unknown = evmNotInvoked;
    const rail = countingEvmRail(async () => answer);
    const settle = evmErc20Settle(rail, evmCfg, { store: createIdempotencyStore(log) });
    await expect(settle(evmRequest)).resolves.toMatchObject({ ok: false });
    expect(rail.calls).toBe(1);

    await expect(settle({ ...evmRequest, recoveryOnly: true })).rejects.toThrow(RECOVERY_REFUSED);
    expect(rail.calls).toBe(1);
    const evmKey = settlementKey(evmRequest.rail, evmRequest.jobId, 0);
    expect(Object.keys((await log.readOutcome!(evmKey))!)).toEqual(["bindingHash"]);
    expect(log.events).toEqual(["claim:fresh", "release:released", "claimExisting:absent"]);

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
      claimExistingIntent: async (input) => { claimWaiting(); await claimBarrier; return inner.claimExistingIntent!(input); },
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

  test("a recovery in flight does not make another store's first run refuse", async () => {
    const inner = createInMemorySettlementLog();
    let openClaim!: () => void;
    const claimBarrier = new Promise<void>((resolve) => { openClaim = resolve; });
    let claimWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => { claimWaiting = resolve; });
    // Hold the recovery's claim after it ran, so a write it made would still be in place.
    const holdAfter = <T>(claimed: () => Promise<T>) => async () => {
      const answer = await claimed();
      claimWaiting();
      await claimBarrier;
      return answer;
    };
    const gated = tracingLog(inner, {
      claimIntent: (input) => holdAfter(() => inner.claimIntent(input))(),
      claimExistingIntent: (input) => holdAfter(() => inner.claimExistingIntent!(input))(),
    });
    const recovering = createIdempotencyStore(gated).recover!(key, binding, vi.fn(async () => evmPaid));
    await waiting;
    const submit = vi.fn(async () => evmPaid);
    await expect(createIdempotencyStore(inner).once(key, binding, submit)).resolves.toMatchObject({ txHash: "0xpaid" });
    openClaim();
    await expect(recovering).rejects.toThrow(RECOVERY_REFUSED);
    expect(submit).toHaveBeenCalledTimes(1);
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

describe("a refused recovery writes nothing, so a crash cannot leave an intent behind", () => {
  const AFTER_EVERY_LEASE_MS = 365 * 24 * 60 * 60 * 1000;
  const LATER = [1_000 + 2 * LEASE_MS, 1_000 + AFTER_EVERY_LEASE_MS];
  /** A log whose release (the old refusal's second step) dies; a recovery that never writes never reaches it. */
  const dyingRelease = (inner: SettlementLog) => tracingLog(inner, {
    releaseIntent: async () => { throw new Error("process died before the release"); },
  });
  /** Leave a record released after a not-invoked attempt, as a rail's clean refusal does. */
  const releaseNotInvoked = async (log: SettlementLog) => {
    await expect(storeAt(log, 1_000).once(key, binding, async () => evmNotInvoked))
      .resolves.toMatchObject({ ok: false });
  };

  test.each([
    ["an empty log", async () => {}],
    ["a record released after a not-invoked attempt", releaseNotInvoked],
  ])("a replay-authorizing reconcile cannot pay after a refused recovery on %s", async (_label, prepare) => {
    const inner = createInMemorySettlementLog();
    await prepare(inner);
    const submit = vi.fn(async () => evmPaid);
    await expect(storeAt(dyingRelease(inner), 1_000).recover!(key, binding, submit)).rejects.toThrow(RECOVERY_REFUSED);
    for (const now of LATER) {
      const later = tracingLog(inner);
      await expect(storeAt(later, now).recover!(key, binding, submit, async () => replayAuthorization()))
        .rejects.toThrow(RECOVERY_REFUSED);
      expect(later.events).toEqual(["claimExisting:absent"]);
    }
    expect(submit).not.toHaveBeenCalled();
  });

  test.each(bridges)("a restarted %s bridge still refuses, with no submit", async (_name, request, buildBridge) => {
    const log = createInMemorySettlementLog();
    await expect(buildBridge(storeAt(dyingRelease(log), 1_000)).settle({ ...request, recoveryOnly: true }))
      .rejects.toThrow(RECOVERY_REFUSED);
    for (const now of LATER) {
      const restarted = buildBridge(storeAt(log, now));
      await expect(restarted.settle({ ...request, recoveryOnly: true })).rejects.toThrow(RECOVERY_REFUSED);
      expect(restarted.submits()).toBe(0);
    }
  });

  test.each(bridges.slice(0, 2))("a refused %s recovery leaves the first run able to pay once", async (_name, request, buildBridge) => {
    const log = createInMemorySettlementLog();
    await expect(buildBridge(storeAt(dyingRelease(log), 1_000)).settle({ ...request, recoveryOnly: true }))
      .rejects.toThrow(RECOVERY_REFUSED);
    const firstRun = buildBridge(storeAt(log, 1_000 + 2 * LEASE_MS));
    await expect(firstRun.settle(request)).resolves.toMatchObject({ ok: true, txHash: "0xpaid" });
    expect(firstRun.submits()).toBe(1);
  });

  test("a refused recovery under other terms does not retain those terms against the first run", async () => {
    const log = createInMemorySettlementLog();
    const submit = vi.fn(async () => evmPaid);
    await expect(storeAt(log, 1_000).recover!(key, { ...binding, amount: "2000000" }, submit)).rejects.toThrow(RECOVERY_REFUSED);
    expect(await log.readOutcome!(key)).toBeNull();
    await expect(storeAt(log, 1_000).once(key, binding, submit)).resolves.toMatchObject({ txHash: "0xpaid" });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  test("a log without claimExistingIntent refuses a recovery with no write, and still serves a first run", async () => {
    const { claimExistingIntent: _omitted, ...withoutExisting } = createInMemorySettlementLog();
    const log = tracingLog(withoutExisting);
    const submit = vi.fn(async () => evmPaid);
    await expect(storeAt(log, 1_000).recover!(key, binding, submit)).rejects.toThrow(/requires a log with claimExistingIntent/);
    expect(log.events).toEqual([]);
    expect(await log.readOutcome!(key)).toBeNull();
    await expect(storeAt(log, 1_000).once(key, binding, submit)).resolves.toMatchObject({ txHash: "0xpaid" });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["an empty key", ""],
    ["a key of another job", settlementKey(evmRequest.rail, "other-job", 0)],
  ])("a recovery under %s is refused before any log call", async (_label, badKey) => {
    const log = tracingLog(createInMemorySettlementLog());
    const submit = vi.fn(async () => evmPaid);
    await expect(storeAt(log, 1_000).recover!(badKey, binding, submit, async () => replayAuthorization()))
      .rejects.toThrow(/does not match its idempotency key/);
    expect(log.events).toEqual([]);
    expect(await log.readOutcome!(key)).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  test("an unresolved intent is still acquired for reconcile at the lease boundary only", async () => {
    const log = createInMemorySettlementLog();
    await crashInsideRail(log);
    const input = { key, bindingHash: settlementBindingHash(binding), owner: "recoverer", leaseDurationMs: LEASE_MS };
    const expiresAt = 1_000 + LEASE_MS;
    expect(await log.claimExistingIntent!({ ...input, now: expiresAt - 1 })).toMatchObject({ status: "held" });
    expect(await log.claimExistingIntent!({ ...input, now: expiresAt })).toMatchObject({
      status: "acquired", lease: { stage: "reconcile", generation: 2 },
    });
  });

  test("claimExistingIntent reports other terms and outcomes, and installs nothing on a miss", async () => {
    const log = createInMemorySettlementLog();
    const input = { key, bindingHash: settlementBindingHash(binding), owner: "recoverer", now: 1_000, leaseDurationMs: LEASE_MS };
    expect(await log.claimExistingIntent!(input)).toEqual({ status: "absent" });
    expect(await log.readOutcome!(key)).toBeNull();
    await storeAt(log, 1_000).once(key, binding, async () => evmPaid);
    expect(await log.claimExistingIntent!(input)).toMatchObject({ status: "outcome" });
    expect(await log.claimExistingIntent!({ ...input, bindingHash: "00".repeat(32) })).toEqual({ status: "conflict" });
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

  test("a bound replay authorization submits exactly once, under a granted replay lease", async () => {
    const inner = createInMemorySettlementLog();
    await crashInsideRail(inner);
    const log = tracingLog(inner);
    const submit = vi.fn(async () => { log.events.push("submit"); return evmPaid; });
    await expect(storeAt(log, 1_000 + 2 * LEASE_MS).recover!(key, binding, submit, async () => replayAuthorization()))
      .resolves.toMatchObject({ txHash: "0xpaid" });
    expect(log.events).toEqual(["claimExisting:reconcile", "grant:granted", "submit"]);
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
    await expect(createIdempotencyStore(log).once(key, binding, submit)).rejects.toThrow(/invalid acquired generation/);
    expect(submit).not.toHaveBeenCalled();
  });

  test.each([
    ["a fresh lease", async (inner: SettlementLog) => inner.claimIntent({
      key, bindingHash: settlementBindingHash(binding), owner: "other", now: 1_000, leaseDurationMs: LEASE_MS,
    }), /invalid acquired generation/],
    ["a replay lease", async (inner: SettlementLog) => {
      const claimed = await inner.claimIntent({
        key, bindingHash: settlementBindingHash(binding), owner: "other", now: 1_000, leaseDurationMs: LEASE_MS,
      });
      return claimed.status === "acquired" ? { ...claimed, lease: { ...claimed.lease, stage: "replay" } } : claimed;
    }, /invalid acquired generation/],
    ["an absent answer with extra keys", async () => ({ status: "absent", written: true }), /invalid shape/],
  ])("a log whose claimExistingIntent answers %s is rejected before the rail", async (_label, answer, expected) => {
    const inner = createInMemorySettlementLog();
    const log = tracingLog(inner, { claimExistingIntent: async () => (await answer(inner)) as never });
    const submit = vi.fn(async () => evmPaid);
    await expect(storeAt(log, 1_000).recover!(key, binding, submit)).rejects.toThrow(expected);
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

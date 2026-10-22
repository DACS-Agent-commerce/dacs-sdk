import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { createIdempotencyStore, createInMemorySettlementLog,
  settlementBindingHash, type SettlementBinding, type SettlementEffectFence } from "../../src/rails/idempotency.js";
import { payDemSettle } from "../../src/rails/payDem.js";
import { demosNode, demosWebsdkMock, sdkPayDemRail } from "../fixtures/demosNodeScript.js";

vi.mock("@kynesyslabs/demosdk/websdk", async () =>
  (await import("../fixtures/demosNodeScript.js")).demosWebsdkMock);
beforeEach(() => demosNode.reset());
const payer = "ab".repeat(32), payee = "cd".repeat(32);
const binding: SettlementBinding = {
  bindingVersion: "1", railId: "pay-dem", jobId: "sweepfix", phaseIndex: 0, phase: "pay-dem",
  amount: "1000000000", agreementAsset: "DEM", settlementAsset: "DEM", payer, payee,
  network: "demos", finality: { model: "bft-final" },
};
const key = "pay-dem:sweepfix:0";
const absence = { originalLogRetained: true as const, reconcile: async () => null };
const req = { rail: "pay-dem", phase: "pay-dem", phaseIndex: 0, jobId: "sweepfix",
  amount: "1", asset: "DEM", payee: `did:demos:agent:${payee}`, expectedPayee: payee };

test("an operator closes an expired unattempted intent; restart reports unpaid without a transfer", async () => {
  const log = createInMemorySettlementLog();
  let oldFence: Readonly<SettlementEffectFence> | undefined;
  await assert.rejects(createIdempotencyStore(log, { now: () => 1, leaseDurationMs: 10 }).once(
    key, binding, async (fence) => { oldFence = fence; throw new Error("death before signing"); },
  ), /death before signing/);
  const operator = createIdempotencyStore(log, { now: () => 12 });
  assert.equal((await operator.abandonUnattempted!(key, binding, absence)).ok, false);
  await assert.rejects(oldFence!.recordAttempt!("12".repeat(32)), /stale generation/);
  const resumed = payDemSettle(await sdkPayDemRail(), {}, {
    store: createIdempotencyStore(log), reconcile: async () => { throw new Error("no tx to read"); },
  });
  assert.deepEqual(await resumed({ ...req, recoveryOnly: true }), {
    ok: false, txHash: "", chainId: "demos", payer, payee,
  });
  assert.equal(demosNode.transfers, 0);
  assert.equal(demosNode.broadcasts, 0);
});

test("operator closure refuses missing and live intents and any recorded transaction", async () => {
  const missing = createIdempotencyStore();
  await assert.rejects(missing.abandonUnattempted!(key, binding, undefined as never), /originalLogRetained.*independent absence/);
  for (const recorded of [false, true]) {
    const log = createInMemorySettlementLog();
    const original = createIdempotencyStore(log, { now: () => 1, leaseDurationMs: 10 });
    await assert.rejects(original.once(key, binding, async (fence) => {
      if (recorded) await fence!.recordAttempt!("12".repeat(32));
      throw new Error("death");
    }), /death/);
    await assert.rejects(createIdempotencyStore(log, { now: () => 2 }).abandonUnattempted!(key, binding, absence), /live/);
    if (recorded) await assert.rejects(
      createIdempotencyStore(log, { now: () => 12 }).abandonUnattempted!(key, binding, absence), /recorded transaction/,
    );
  }
});

test("operator closure refuses changed payment terms and a completed payment", async () => {
  const log = createInMemorySettlementLog();
  const store = createIdempotencyStore(log, { now: () => 1, leaseDurationMs: 10 });
  await store.once(key, binding, async (fence) => {
    await fence!.recordAttempt!("12".repeat(32));
    return { ok: true, txHash: "12".repeat(32), chainId: "demos", payer, payee,
      blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" } };
  });
  const operator = createIdempotencyStore(log, { now: () => 12 });
  await assert.rejects(operator.abandonUnattempted!(key, { ...binding, amount: "2" }, absence), /conflicting/);
  await assert.rejects(operator.abandonUnattempted!(key, binding, absence), /completed/);
});

test("an operator confirms the intact original log after a crash before its intent was written", async () => {
  const log = createInMemorySettlementLog();
  const operator = createIdempotencyStore(log);
  const closed = await operator.abandonUnattempted!(key, binding, absence);
  assert.equal(closed.ok, false);
  const adapter = payDemSettle(await sdkPayDemRail(), {}, { store: createIdempotencyStore(log) });
  assert.equal((await adapter({ ...req, recoveryOnly: true })).ok, false);
  assert.equal(demosNode.transfers, 0);
  assert.equal(demosNode.broadcasts, 0);
});

async function savedPayment() {
  demosNode.feeOs = "12";
  demosNode.confirmFeeOs = "6";
  const log = createInMemorySettlementLog();
  const first = await payDemSettle(await sdkPayDemRail(), {}, { store: createIdempotencyStore(log) })(req);
  assert.equal(first.networkFeeOs, "12"); // record declaration, not confirmation debit
  const record = structuredClone(demosNode.records.get(first.txHash));
  return { log, first, record };
}

test.each([
  ["null", null],
  ["node not-found", "error"],
  ["transport envelope", { result: 500, response: new Error("ECONNRESET") }],
  ["malformed record", { status: "confirmed" }],
  ["nonterminal record", { status: "pending" }],
])("primary %s recovers through the configured archive with no second broadcast", async (_name, primary) => {
  const { log, first, record } = await savedPayment();
  demosNode.reply = (_hash, rpc) => rpc === "https://archive.test" ? record : primary;
  const rail = await sdkPayDemRail(undefined, { recoveryRpc: "https://archive.test" });
  const adapter = payDemSettle(rail, {}, { store: createIdempotencyStore(log), reconcile: async () => ({
    ...first, payee, amountOs: "1000000000", execution: "executed",
  }) });
  assert.deepEqual(await adapter({ ...req, recoveryOnly: true }), first);
  assert.deepEqual(demosNode.readNodes.slice(-2), ["https://node.test", "https://archive.test"]);
  assert.equal(demosNode.transfers, 1);
  assert.equal(demosNode.broadcasts, 1);
});

test("an unavailable archive does not stop fresh payments or healthy primary recovery", async () => {
  const prototype = demosWebsdkMock.Demos.prototype;
  const originalConnect = prototype.connect;
  let archiveConnections = 0;
  const connect = vi.spyOn(prototype, "connect").mockImplementation(async function (this: typeof prototype, rpc) {
    if (rpc === "https://archive.test") {
      archiveConnections++;
      throw new Error("archive unavailable");
    }
    return originalConnect.call(this, rpc);
  });
  try {
    const log = createInMemorySettlementLog();
    const rail = await sdkPayDemRail(undefined, { recoveryRpc: "https://archive.test" });
    const first = await payDemSettle(rail, {}, { store: createIdempotencyStore(log) })(req);
    const adapter = payDemSettle(rail, {}, { store: createIdempotencyStore(log),
      reconcile: async () => ({ ...first, payee, amountOs: "1000000000", execution: "executed" }),
    });
    assert.deepEqual(await adapter({ ...req, recoveryOnly: true }), first);
    assert.equal(archiveConnections, 0);
    demosNode.reply = () => "error";
    await assert.rejects(adapter({ ...req, recoveryOnly: true }), /archive connection failed/);
    await assert.rejects(adapter({ ...req, recoveryOnly: true }), /archive connection failed/);
    assert.equal(archiveConnections, 2); // failed connection is retryable
    assert.equal(demosNode.broadcasts, 1);
  } finally {
    connect.mockRestore();
  }
});

test("a lagging restored log cannot close a payment that independent reconciliation finds", async () => {
  const { first } = await savedPayment();
  const backup = createInMemorySettlementLog();
  const bindingHash = settlementBindingHash(binding);
  await backup.claimIntent({ key, bindingHash, owner: "old", now: 1, leaseDurationMs: 1 });
  const operator = createIdempotencyStore(backup, { now: () => 3 });
  const reconcile = vi.fn(async () => first);
  await assert.rejects(operator.abandonUnattempted!(key, binding, {
    originalLogRetained: true, reconcile,
  }), /independent proof/);
  assert.deepEqual(reconcile.mock.calls[0], [key, binding]);
  assert.equal(await backup.readOutcome!(key), null);
  assert.equal(demosNode.broadcasts, 1);
  // Keep the unresolved intent: releasing it would permit a fresh generation.
  assert.equal((await backup.claimIntent({ key, bindingHash, owner: "next", now: 3,
    leaseDurationMs: 1 })).status, "held");
});

test("a stalled archive connection stays bounded and never resubmits the payment", async () => {
  const { log, first } = await savedPayment();
  const prototype = demosWebsdkMock.Demos.prototype;
  const originalConnect = prototype.connect;
  const connect = vi.spyOn(prototype, "connect").mockImplementation(function (this: typeof prototype, rpc) {
    return rpc === "https://archive.test" ? new Promise(() => {}) : originalConnect.call(this, rpc);
  });
  try {
    demosNode.reply = () => "error";
    const adapter = payDemSettle(await sdkPayDemRail(undefined, {
      recoveryRpc: "https://archive.test", statusRequestTimeoutMs: 10,
    }), {}, { store: createIdempotencyStore(log), reconcile: async () => ({
      ...first, payee, amountOs: "1000000000", execution: "executed",
    }) });
    await assert.rejects(adapter({ ...req, recoveryOnly: true }), /archive connection timed out/);
    assert.equal(demosNode.broadcasts, 1);
  } finally {
    connect.mockRestore();
  }
});

test("every closure requires confirmation and an independent absence check", async () => {
  const log = createInMemorySettlementLog();
  await log.claimIntent({ key, bindingHash: settlementBindingHash(binding), owner: "old",
    now: 1, leaseDurationMs: 1 });
  let now = 3;
  const operator = createIdempotencyStore(log, { now: () => now, leaseDurationMs: 1 });
  for (const options of [undefined, { originalLogRetained: true }, { reconcile: async () => null }]) {
    await assert.rejects(operator.abandonUnattempted!(key, binding, options as never),
      /originalLogRetained.*independent absence/);
  }
  const reconcile = vi.fn(async () => { throw new Error("journal unavailable"); });
  await assert.rejects(operator.abandonUnattempted!(key, binding, {
    originalLogRetained: true, reconcile,
  }), /journal unavailable/);
  assert.equal(await log.readOutcome!(key), null);
  // An unavailable independent history leaves recovery held, never fresh.
  await assert.rejects(operator.abandonUnattempted!(key, binding, absence), /live/);
  now = 5;
  assert.equal((await operator.abandonUnattempted!(key, binding, absence)).ok, false);
});

test("archive outage or wrong transfer never completes a pruned payment", async () => {
  for (const wrong of [false, true]) {
    demosNode.reset();
    const { log, first, record } = await savedPayment();
    const changed = structuredClone(record) as { content: Record<string, unknown> };
    changed.content.to = "ef".repeat(32);
    demosNode.reply = (_hash, rpc) => rpc === "https://archive.test" && wrong ? changed : null;
    const adapter = payDemSettle(await sdkPayDemRail(undefined, { recoveryRpc: "https://archive.test" }), {}, {
      store: createIdempotencyStore(log), reconcile: async () => ({ ...first, payee,
        amountOs: "1000000000", execution: "executed" }),
    });
    await assert.rejects(adapter({ ...req, recoveryOnly: true }), /could not establish/);
    assert.equal(demosNode.broadcasts, 1);
  }
});

test("a terminal primary failure cannot be overridden by an archive success", async () => {
  const { log, first, record } = await savedPayment();
  demosNode.readNodes = [];
  demosNode.reply = (_hash, rpc) => rpc === "https://archive.test" ? record : { ...record as object, status: "failed" };
  const adapter = payDemSettle(await sdkPayDemRail(undefined, { recoveryRpc: "https://archive.test" }), {}, {
    store: createIdempotencyStore(log), reconcile: async () => ({ ...first, payee,
      amountOs: "1000000000", execution: "executed" }),
  });
  await assert.rejects(adapter({ ...req, recoveryOnly: true }), /contradicts/);
  assert.deepEqual(demosNode.readNodes, ["https://node.test"]);
  assert.equal(demosNode.broadcasts, 1);
});

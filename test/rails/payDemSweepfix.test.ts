import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createIdempotencyStore, createInMemorySettlementLog,
  settlementBindingHash, type SettlementBinding, type SettlementEffectFence } from "../../src/rails/idempotency.js";
import { payDemSettle, type PayDemPreparedTransfer, type PayDemSettlementReconcile } from "../../src/rails/payDem.js";
import { demosNode, demosRpcFetch, nodeRecord, sdkPayDemRail } from "../fixtures/demosNodeScript.js";

vi.mock("@kynesyslabs/demosdk/websdk", async () =>
  (await import("../fixtures/demosNodeScript.js")).demosWebsdkMock);
beforeEach(() => { demosNode.reset(); vi.stubGlobal("fetch", demosRpcFetch); });
afterEach(() => vi.unstubAllGlobals());
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

test("credential-bearing primary and archive URLs recover all chain reads without a second broadcast", async () => {
  const { log, first, record } = await savedPayment();
  const messages = new Set<string>();
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    const archive = new URL(request.url).hostname === "archive.test";
    assert.equal(request.url, archive ? "https://archive.test/history?tenant=archive" : "https://node.test/rpc?tenant=primary");
    assert.equal(request.headers.get("Authorization"), `Basic ${Buffer.from(archive ? "arch@ive:p:fixture" : "operator:fixture").toString("base64")}`);
    assert.equal(request.redirect, "error");
    const { message } = JSON.parse(init!.body as string).params[0];
    messages.add(`${archive ? "archive" : "primary"}:${message}`);
    return demosRpcFetch(input, init);
  });
  demosNode.reply = (_hash, rpc) => rpc?.startsWith("https://archive.test/") ? record : null;
  const adapter = payDemSettle(await sdkPayDemRail(undefined, {
    rpc: "https://operator:fixture@node.test/rpc?tenant=primary",
    recoveryRpc: "https://arch%40ive:p%3Afixture@archive.test/history?tenant=archive",
  }), {}, { store: createIdempotencyStore(log), reconcile: async () => ({ ...first,
    amountOs: binding.amount, execution: "executed" }) });
  for (let retry = 0; retry < 2; retry++) {
    assert.deepEqual(await adapter({ ...req, recoveryOnly: true }), first);
  }
  for (const node of ["primary", "archive"]) {
    for (const message of ["getNetworkInfo", "getTxByHash", "getBlockByNumber"]) {
      assert.ok(messages.has(`${node}:${message}`), `missing ${node} ${message} read`);
    }
  }
  assert.equal(demosNode.transfers, 1);
  assert.equal(demosNode.broadcasts, 1);
});

test("a lost attempt-write acknowledgement keeps the intent held", async () => {
  const log = createInMemorySettlementLog();
  const putAttempt = log.putAttempt!.bind(log);
  vi.spyOn(log, "putAttempt").mockImplementation(async (input) => {
    await putAttempt(input); throw new Error("attempt acknowledgement lost");
  });
  const release = vi.spyOn(log, "releaseIntent");
  const adapter = payDemSettle(await sdkPayDemRail(), {}, { store: createIdempotencyStore(log) });
  await assert.rejects(adapter(req), /acknowledgement lost/);
  assert.equal(release.mock.calls.length, 0);
  assert.equal(demosNode.broadcasts, 0);
  assert.equal(demosNode.transfers, 1);
  assert.equal((await log.readAttempt!(key))?.txHash, demosNode.nextHash);
  await assert.rejects(adapter(req), /in-flight/);
  assert.equal(demosNode.transfers, 1);
});

test.each([["12", "6"], ["0", "2000000000"], ["6", "6"]])(
  "restart recovery keeps record fee %s separate from confirmation fee %s", async (feeOs, confirmFeeOs) => {
    Object.assign(demosNode, { feeOs, confirmFeeOs });
    const journal: PayDemPreparedTransfer[] = [];
    const log = createInMemorySettlementLog();
    const first = await payDemSettle(await sdkPayDemRail(undefined, {
      journalPreparedTransfer: async (entry) => { journal.push(entry); },
    }), {}, { store: createIdempotencyStore(log) })(req);
    assert.equal(first.networkFeeOs, feeOs);
    assert.equal(journal[0]!.confirmedTotalDebitOs, (1000000000n + BigInt(confirmFeeOs!)).toString());
    for (const history of [false, true]) {
      const resumed = payDemSettle(await sdkPayDemRail(), {}, {
        store: createIdempotencyStore(log), reconcile: async () => ({ ...first,
          amountOs: binding.amount, execution: "executed", preparedTransfer: journal[0] }),
      });
      assert.deepEqual(await resumed({ ...req, ...(history ? { recoveryOnly: true } : {}) }), first);
    }
    assert.equal(demosNode.broadcasts, 1);
  },
);

test.each(["getNetworkInfo", "getTxByHash"])(
  "archive recovery cancels stalled primary %s requests", async (message) => {
    const { log, first, record } = await savedPayment();
    let active = 0, peak = 0, calls = 0, primaryInfoReads = 0;
    demosNode.reply = (_hash, rpc) => {
      // Also exercise the former SDK transport on the review-head control.
      if (message === "getTxByHash" && rpc === "https://node.test") {
        active++; calls++; peak = Math.max(peak, active);
        return new Promise(() => undefined);
      }
      return record;
    };
    vi.stubGlobal("fetch", (...args: Parameters<typeof fetch>) => {
      const request = JSON.parse(args[1]!.body as string).params[0];
      if (args[0] !== "https://node.test" || request.message !== message) return demosRpcFetch(...args);
      if (message === "getNetworkInfo" && ++primaryInfoReads % 2 === 0) return demosRpcFetch(...args);
      active++; calls++; peak = Math.max(peak, active);
      return new Promise((_resolve, reject) => args[1]!.signal!.addEventListener("abort", () => {
        active--; reject(args[1]!.signal!.reason);
      }, { once: true }));
    });
    const adapter = payDemSettle(await sdkPayDemRail(undefined, {
      recoveryRpc: "https://archive.test", statusRequestTimeoutMs: 10,
    }), {}, { store: createIdempotencyStore(log), reconcile: async () => ({ ...first,
      amountOs: binding.amount, execution: "executed" }) });
    for (let retry = 0; retry < 3; retry++) {
      assert.deepEqual(await adapter({ ...req, recoveryOnly: true }), first);
      assert.equal(active, 0);
    }
    assert.equal(calls, 3);
    assert.equal(peak, 1);
    assert.equal(demosNode.broadcasts, 1);
  },
);

test("operator reopening fences a crashed worker and permits exactly one fresh payment", async () => {
  const log = createInMemorySettlementLog();
  let oldFence: Readonly<SettlementEffectFence> | undefined;
  await assert.rejects(createIdempotencyStore(log, { now: () => 1, leaseDurationMs: 10 }).once(
    key, binding, async (fence) => { oldFence = fence; throw new Error("crash"); },
  ));
  const adapter = payDemSettle(await sdkPayDemRail(), {}, {
    store: createIdempotencyStore(log, { now: () => 12 }), retryUnattempted: absence,
  });
  assert.equal((await adapter({ ...req, recoveryOnly: true })).ok, true);
  await assert.rejects(oldFence!.recordAttempt!("12".repeat(32)), /stale generation|another transaction/);
  assert.equal((await adapter({ ...req, recoveryOnly: true })).ok, true);
  assert.equal(demosNode.broadcasts, 1);
});

test.each(["live", "attempted", "present", "unavailable"])(
  "operator reopening refuses %s payment state", async (state) => {
    const log = createInMemorySettlementLog();
    await assert.rejects(createIdempotencyStore(log, { now: () => 1, leaseDurationMs: 10 }).once(
      key, binding, async (fence) => {
        if (state === "attempted") await fence!.recordAttempt!("12".repeat(32));
        throw new Error("crash");
      },
    ));
    const operator = createIdempotencyStore(log, { now: () => state === "live" ? 2 : 12 });
    await assert.rejects(operator.reopenUnattempted!(key, binding, {
      originalLogRetained: true, reconcile: async () => {
        if (state === "unavailable") throw new Error("journal unavailable");
        return state === "present" ? { ok: true, txHash: "12".repeat(32), payer, payee, chainId: "demos" } : null;
      },
    }), /live|recorded transaction|independent proof|unavailable/);
    assert.equal(demosNode.broadcasts, 0);
  },
);

test.each([undefined, false, true])(
  "an operator closes an expired unattempted intent; recoveryOnly=%s reports unpaid without a transfer", async (recoveryOnly) => {
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
    assert.deepEqual(await resumed({ ...req, ...(recoveryOnly === undefined ? {} : { recoveryOnly }) }), {
      ok: false, txHash: "", chainId: "demos", payer, payee,
    });
    assert.equal(demosNode.transfers, 0);
    assert.equal(demosNode.broadcasts, 0);
    assert.equal(demosNode.reads.length, 0);
  },
);

test("a transaction-bearing cached failure is reconciled against the node instead of reused as an unpaid closure", async () => {
  const log = createInMemorySettlementLog();
  const bindingHash = settlementBindingHash(binding);
  const txHash = demosNode.nextHash;
  const failed = {
    ok: false as const, txHash, chainId: "demos", payer, payee, blockNumber: 42,
    txRefKind: "demos", errorClass: "permanent" as const,
    failureProof: { kind: "demos-failed-record" as const, txHash, payer, payee,
      nonce: 9, blockNumber: 42, amountOs: binding.amount },
  };
  const claim = await log.claimIntent({ key, bindingHash, owner: "worker", now: 1, leaseDurationMs: 10 });
  assert.equal(claim.status, "acquired");
  assert.equal((await log.putOutcome({ key, bindingHash, lease: claim.lease, result: failed, now: 2 })).status,
    "recorded");
  const stored = await log.readOutcome!(key);
  assert.deepEqual(stored?.result, failed);
  assert.equal(await log.readAttempt!(key), null);
  // The paired log agrees on the failed claim; the node says this hash executed.
  demosNode.records.set(txHash, nodeRecord({ txHash, payer, payee, amountOs: binding.amount }));
  const reconcile = vi.fn<PayDemSettlementReconcile>(async () => ({ ...failed, amountOs: binding.amount }));
  const resumed = payDemSettle(await sdkPayDemRail(), {}, { store: createIdempotencyStore(log), reconcile });

  // No supplied history or recoveryOnly: exercise the cached-outcome closure reader.
  await assert.rejects(resumed(req), /contradicts the node record/);
  assert.deepEqual(reconcile.mock.calls, [[{
    railId: "pay-dem", jobId: "sweepfix", phaseIndex: 0, settlementKey: key,
    network: "demos", payer, payee, amountOs: binding.amount,
  }]]);
  assert.deepEqual(demosNode.reads, [txHash]);
  assert.deepEqual(await log.readOutcome!(key), stored);
  assert.equal(await log.readAttempt!(key), null);
  assert.equal(demosNode.transfers, 0);
  assert.equal(demosNode.broadcasts, 0);
});

test("a recorded attempt prevents a cached empty-hash outcome from being reused as an unpaid closure", async () => {
  const log = createInMemorySettlementLog();
  const bindingHash = settlementBindingHash(binding);
  const txHash = demosNode.nextHash;
  const claim = await log.claimIntent({ key, bindingHash, owner: "worker", now: 1, leaseDurationMs: 10 });
  assert.equal(claim.status, "acquired");
  assert.equal(await log.putAttempt!({ key, bindingHash, lease: claim.lease, txHash, now: 2 }), "recorded");
  const unpaid = { ok: false, txHash: "", chainId: "demos", payer, payee };
  assert.equal((await log.putOutcome({ key, bindingHash, lease: claim.lease, result: unpaid, now: 3 })).status,
    "recorded");
  const storedAttempt = await log.readAttempt!(key);
  const storedOutcome = await log.readOutcome!(key);
  assert.deepEqual(storedAttempt, { bindingHash, txHash });
  assert.deepEqual(storedOutcome?.result, unpaid);
  const reconcile = vi.fn<PayDemSettlementReconcile>(async () => ({
    ok: true, txHash, chainId: "demos", payer, payee, amountOs: binding.amount,
    execution: "executed", blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" },
  }));
  const resumed = payDemSettle(await sdkPayDemRail(), {}, { store: createIdempotencyStore(log), reconcile });

  // The saved attempt must win over the empty hash even without request history.
  await assert.rejects(resumed(req), /does not match the authoritative reconciled transaction/);
  assert.deepEqual(reconcile.mock.calls, [[{
    railId: "pay-dem", jobId: "sweepfix", phaseIndex: 0, settlementKey: key,
    network: "demos", payer, payee, amountOs: binding.amount, txHash,
  }]]);
  assert.deepEqual(await log.readAttempt!(key), storedAttempt);
  assert.deepEqual(await log.readOutcome!(key), storedOutcome);
  assert.equal(demosNode.transfers, 0);
  assert.equal(demosNode.broadcasts, 0);
});

test("an empty-hash result without a durable operator closure still refuses", async () => {
  const store = createIdempotencyStore(createInMemorySettlementLog());
  vi.spyOn(store, "once").mockResolvedValue({ ok: false, txHash: "", chainId: "demos", payer, payee });
  const resumed = payDemSettle(await sdkPayDemRail(), {}, {
    store, reconcile: async () => ({ ok: true, execution: "executed", txHash: demosNode.nextHash,
      chainId: "demos", payer, payee, amountOs: binding.amount, blockNumber: 42,
      txRefKind: "demos", finality: { model: "bft-final" } }),
  });
  await assert.rejects(resumed(req), /does not match the authoritative reconciled transaction/);
  assert.equal(demosNode.transfers, 0);
  assert.equal(demosNode.broadcasts, 0);
});

test("a durable payment at a different reconciled block still refuses without another transfer", async () => {
  const { log, first } = await savedPayment();
  const resumed = payDemSettle(await sdkPayDemRail(), {}, {
    store: createIdempotencyStore(log), reconcile: async () => ({ ...first,
      execution: "executed", amountOs: binding.amount, blockNumber: first.blockNumber! + 1 }),
  });
  await assert.rejects(resumed(req), /does not match the authoritative reconciled transaction/);
  assert.deepEqual((await log.readOutcome!(key))?.result, first);
  assert.equal(demosNode.transfers, 1);
  assert.equal(demosNode.broadcasts, 1);
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
  let archiveReads = 0;
  vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
    if (args[0] === "https://archive.test") {
      archiveReads++;
      throw new Error("archive unavailable");
    }
    return demosRpcFetch(...args);
  });
  try {
    const log = createInMemorySettlementLog();
    const rail = await sdkPayDemRail(undefined, { recoveryRpc: "https://archive.test" });
    const first = await payDemSettle(rail, {}, { store: createIdempotencyStore(log) })(req);
    const adapter = payDemSettle(rail, {}, { store: createIdempotencyStore(log),
      reconcile: async () => ({ ...first, payee, amountOs: "1000000000", execution: "executed" }),
    });
    assert.deepEqual(await adapter({ ...req, recoveryOnly: true }), first);
    assert.equal(archiveReads, 0);
    demosNode.reply = () => "error";
    await assert.rejects(adapter({ ...req, recoveryOnly: true }), /archive chain history read failed/);
    await assert.rejects(adapter({ ...req, recoveryOnly: true }), /archive chain history read failed/);
    assert.equal(archiveReads, 2); // failed read is retryable
    assert.equal(demosNode.broadcasts, 1);
  } finally {
    vi.stubGlobal("fetch", demosRpcFetch);
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

test("repeated stalled archive reads are cancelled and never resubmit the payment", async () => {
  const { log, first } = await savedPayment();
  let active = 0, peak = 0, calls = 0;
  vi.stubGlobal("fetch", (...args: Parameters<typeof fetch>) => {
    if (args[0] !== "https://archive.test") return demosRpcFetch(...args);
    active++; calls++; peak = Math.max(peak, active);
    return new Promise((_resolve, reject) => args[1]!.signal!.addEventListener("abort", () => {
      active--; reject(args[1]!.signal!.reason);
    }, { once: true }));
  });
  try {
    demosNode.reply = () => "error";
    const adapter = payDemSettle(await sdkPayDemRail(undefined, {
      recoveryRpc: "https://archive.test", statusRequestTimeoutMs: 10,
    }), {}, { store: createIdempotencyStore(log), reconcile: async () => ({
      ...first, payee, amountOs: "1000000000", execution: "executed",
    }) });
    for (let retry = 0; retry < 3; retry++) {
      await assert.rejects(adapter({ ...req, recoveryOnly: true }), (error: Error & { cause?: Error }) => {
        assert.match(error.message, /archive chain history read failed/);
        assert.match(error.cause!.message, /getNetworkInfo read timed out/);
        return true;
      });
      assert.equal(active, 0);
    }
    assert.equal(calls, 3);
    assert.equal(peak, 1);
    assert.equal(demosNode.broadcasts, 1);
  } finally {
    vi.stubGlobal("fetch", demosRpcFetch);
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

test.each(["wrong chain", "wrong schedule", "reset fork", "missing primary inclusion"])(
  "archive recovery refuses %s without rewriting or resending a saved success", async (fault) => {
    const { log, first, record } = await savedPayment();
    demosNode.reply = (_hash, rpc) => rpc === "https://archive.test" ? record : null;
    demosNode.networkInfoReply = (rpc) => ({
      chainId: fault === "wrong chain" && rpc === "https://archive.test" ? 2 : 1,
      forkScheduleDigest: (fault === "wrong schedule" && rpc === "https://archive.test" ? "12" : "ef").repeat(32),
      forks: { osDenomination: { activated: true, currentHeight: 42 } },
    });
    demosNode.blockReply = (number, rpc) => ({
      number, status: "confirmed",
      hash: (fault === "reset fork" && rpc === "https://archive.test" ? "56" : "78").repeat(32),
      content: { ordered_transactions: fault === "missing primary inclusion" && rpc === "https://node.test"
        ? [] : [first.txHash] },
    });
    const before = await log.readOutcome!(key);
    const adapter = payDemSettle(await sdkPayDemRail(undefined, { recoveryRpc: "https://archive.test" }), {}, {
      store: createIdempotencyStore(log), reconcile: async () => ({ ...first, payee,
        amountOs: "1000000000", execution: "executed" }),
    });
    await assert.rejects(adapter({ ...req, recoveryOnly: true }), /archive.*(chain|history|block|inclusion)/);
    assert.deepEqual(await log.readOutcome!(key), before);
    assert.equal(demosNode.transfers, 1);
    assert.equal(demosNode.broadcasts, 1);
  },
);

test.each([0, 42])("archive recovery accepts a primary-confirmed block %i without extra depth", async (blockNumber) => {
  demosNode.blockNumber = blockNumber;
  const { log, first, record } = await savedPayment();
  demosNode.reply = (_hash, rpc) => rpc === "https://archive.test" ? record : null;
  // Chain ID zero and uppercase hex are valid identities too.
  demosNode.networkInfoReply = (rpc) => ({
    chainId: 0, forkScheduleDigest: (rpc === "https://archive.test" ? "EF" : "ef").repeat(32),
    forks: { osDenomination: { activated: true, currentHeight: blockNumber } },
  });
  demosNode.blockReply = (number, rpc) => ({ number, status: "confirmed",
    hash: `${rpc === "https://archive.test" ? "0x" : ""}${"78".repeat(32)}`,
    content: { ordered_transactions: [first.txHash.toUpperCase()] },
  });
  const adapter = payDemSettle(await sdkPayDemRail(undefined, { recoveryRpc: "https://archive.test" }), {}, {
    store: createIdempotencyStore(log), reconcile: async () => ({ ...first, payee,
      amountOs: "1000000000", execution: "executed" }),
  });
  assert.deepEqual(await adapter({ ...req, recoveryOnly: true }), first);
  assert.equal(demosNode.broadcasts, 1);
});

test("archive recovery accepts a DEM-signed payment after the denomination fork", async () => {
  demosNode.postFork = false;
  const log = createInMemorySettlementLog();
  const first = await payDemSettle(await sdkPayDemRail(), {}, { store: createIdempotencyStore(log) })(req);
  assert.equal(first.ok, true);
  const record = structuredClone(demosNode.records.get(first.txHash));
  demosNode.postFork = true;
  demosNode.reply = (_hash, rpc) => rpc === "https://archive.test" ? record : null;
  const adapter = payDemSettle(await sdkPayDemRail(undefined, { recoveryRpc: "https://archive.test" }), {}, {
    store: createIdempotencyStore(log), reconcile: async () => ({ ...first, payee,
      amountOs: "1000000000", execution: "executed" }),
  });
  assert.deepEqual(await adapter({ ...req, recoveryOnly: true }), first);
  assert.equal(demosNode.broadcasts, 1);
});

test.each(["primary", "archive"])("archive recovery refuses missing or stale %s chain facts", async (node) => {
  const { log, first, record } = await savedPayment();
  demosNode.reply = (_hash, rpc) => rpc === "https://archive.test" ? record : null;
  const adapter = payDemSettle(await sdkPayDemRail(undefined, { recoveryRpc: "https://archive.test" }), {}, {
    store: createIdempotencyStore(log), reconcile: async () => ({ ...first, payee,
      amountOs: "1000000000", execution: "executed" }),
  });
  for (const missing of ["chainId", "forkScheduleDigest", "forks", "height", "stale height"]) {
    demosNode.networkInfoReply = (rpc) => {
      const info: Record<string, unknown> = { chainId: 1, forkScheduleDigest: "ef".repeat(32),
        forks: { osDenomination: { activated: true, currentHeight: 42 } } };
      if (rpc === (node === "primary" ? "https://node.test" : "https://archive.test")) {
        if (missing === "height" || missing === "stale height") info.forks = {
          osDenomination: { activated: true, ...(missing === "height" ? {} : { currentHeight: 41 }) },
        };
        else delete info[missing];
      }
      return info;
    };
    await assert.rejects(adapter({ ...req, recoveryOnly: true }), /archive.*(chain|block)/);
  }
  assert.equal(demosNode.broadcasts, 1);
});

test.each(["primary", "archive"])("archive recovery refuses malformed or unconfirmed %s inclusion", async (node) => {
  const { log, first, record } = await savedPayment();
  demosNode.reply = (_hash, rpc) => rpc === "https://archive.test" ? record : null;
  const adapter = payDemSettle(await sdkPayDemRail(undefined, { recoveryRpc: "https://archive.test" }), {}, {
    store: createIdempotencyStore(log), reconcile: async () => ({ ...first, payee,
      amountOs: "1000000000", execution: "executed" }),
  });
  for (const fault of ["missing", "number", "status", "hash", "transactions", "list limit"]) {
    demosNode.blockReply = (number, rpc) => {
      const block = { number, status: "confirmed", hash: "78".repeat(32),
        content: { ordered_transactions: [first.txHash] as unknown } };
      if (rpc === (node === "primary" ? "https://node.test" : "https://archive.test")) {
        if (fault === "missing") return null;
        if (fault === "number") block.number++;
        if (fault === "status") block.status = "derived";
        if (fault === "hash") block.hash = "invalid";
        if (fault === "transactions") block.content.ordered_transactions = [first.txHash, {}];
        if (fault === "list limit") block.content.ordered_transactions = Array(16_385).fill("a");
      }
      return block;
    };
    await assert.rejects(adapter({ ...req, recoveryOnly: true }), /archive inclusion block/);
  }
  assert.equal(demosNode.broadcasts, 1);
});

test.each(["no chain ID", "no digest"])(
  "configured archive refuses %s before signing and accepts restored identity", async (fault) => {
    // Real older shapes: 61b8e75 lacks chain ID; 52e2e569 exposes two forks but no complete schedule digest.
    demosNode.networkInfoReply = () => ({ ...(fault === "no chain ID" ? {} : { chainId: 1 }),
      forks: { osDenomination: { activationHeight: 0, activated: true, currentHeight: 42 },
        ...(fault === "no digest" ? { signatureDomain: { activationHeight: null, activated: false, currentHeight: 42 } } : {}) },
    });
    const adapter = payDemSettle(await sdkPayDemRail(undefined, { recoveryRpc: "https://archive.test" }), {}, {
      store: createIdempotencyStore(createInMemorySettlementLog()),
    });
    await assert.rejects(adapter(req), /archive recovery requires.*chain identity/);
    assert.equal(demosNode.transfers, 0);
    assert.equal(demosNode.broadcasts, 0);
    demosNode.networkInfoReply = undefined;
    assert.equal((await adapter(req)).ok, true);
    assert.equal(demosNode.transfers, 1);
    assert.equal(demosNode.broadcasts, 1);
  },
);

test("primary-only payments accept the older node response without an archive identity", async () => {
  demosNode.networkInfoReply = () => ({ chainId: 1, forks: {
    osDenomination: { activationHeight: 0, activated: true, currentHeight: 42 },
    signatureDomain: { activationHeight: null, activated: false, currentHeight: 42 },
  } });
  const adapter = payDemSettle(await sdkPayDemRail(), {}, {
    store: createIdempotencyStore(createInMemorySettlementLog()),
  });
  assert.equal((await adapter(req)).ok, true);
  assert.equal(demosNode.broadcasts, 1);
});

test("a fresh archive-configured payment never contacts an unavailable archive", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", (...args: Parameters<typeof fetch>) => {
    calls.push(String(args[0]));
    if (args[0] === "https://archive.test") throw new Error("archive outage");
    return demosRpcFetch(...args);
  });
  const adapter = payDemSettle(await sdkPayDemRail(undefined, { recoveryRpc: "https://archive.test" }), {}, {
    store: createIdempotencyStore(createInMemorySettlementLog()),
  });
  assert.equal((await adapter(req)).ok, true);
  assert.deepEqual(calls, ["https://node.test"]);
  assert.equal(demosNode.broadcasts, 1);
});

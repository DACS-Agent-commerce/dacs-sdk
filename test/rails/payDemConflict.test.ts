import { beforeEach, describe, expect, test, vi } from "vitest";

import type { SettleRequest, SettleResult } from "../../src/agent/runSessionCore.js";
import { createIdempotencyStore, createInMemorySettlementLog, type SettlementBinding } from "../../src/rails/idempotency.js";
import { type PayDemSettlementReconcile, payDemSettle } from "../../src/rails/payDem.js";
import {
  demosNode, heldRail, resetDemosNode, sdkAuditRail, sdkRail, sdkTransfers, serveNodeRecord,
  setNodeRecordStatus,
} from "../fixtures/demosNodeMock.js";
import { sdkFences } from "../fixtures/sdkFences.js";
import { seedSdkOutcome } from "../fixtures/settlementOutcomeSeed.js";

vi.mock("@kynesyslabs/demosdk/websdk", async () => (await import("../fixtures/demosNodeMock.js")).demosSdkModule());

const hashA = "12".repeat(32);
const hashB = "34".repeat(32);
const hashC = "56".repeat(32);
const payer = "ab".repeat(32);
const payee = "cd".repeat(32);
const claim = `did:demos:agent:${payee}`;
// The node signs hash A at nonce 9 and includes it at block 42; the SDK's own
// rail reads that record, so its verdict is the one this bridge may keep final.
beforeEach(() => resetDemosNode({ payer, txHash: hashA }));
const request: SettleRequest = {
  rail: "pay-dem", phase: "pay-dem", phaseIndex: 0, jobId: "conflicting-native",
  amount: "1", asset: "DEM", payee: claim, expectedPayee: claim,
};
// The prepared-transfer journal entry the rail wrote for this job's transfer.
const journal = (txHash: string, nonce = 9) => ({
  txHash, nonce, payer, payee, amountOs: "1000000000", denomination: "os" as const, network: "demos",
  recovery: { railId: "pay-dem", jobId: request.jobId, phaseIndex: 0,
    settlementKey: "pay-dem:conflicting-native:0", network: "demos", payer, payee, amountOs: "1000000000" },
});
const executed = (txHash = hashA) => ({
  ok: true as const, txHash, payer, payee, chainId: "demos", amountOs: "1000000000",
  blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" as const },
  execution: "executed" as const, preparedTransfer: journal(txHash),
});
const failed = (txHash = hashB) => ({
  ok: false as const, txHash, payer, payee, chainId: "demos", amountOs: "1000000000",
  blockNumber: 42, txRefKind: "demos", errorClass: "permanent" as const,
  failureProof: { kind: "demos-failed-record" as const, txHash, payer, payee,
    nonce: 9, blockNumber: 42, amountOs: "1000000000" },
  preparedTransfer: journal(txHash),
});

const history = (txHash = hashB, ok = true): SettleRequest => ({
  ...request, priorAttempts: [{ txHash, chainId: "demos", ok }],
});
const binding: SettlementBinding = {
  bindingVersion: "1", railId: "pay-dem", jobId: request.jobId, phaseIndex: 0,
  phase: "pay-dem", amount: "1000000000", agreementAsset: "DEM", settlementAsset: "DEM",
  payer, payee, network: "demos", finality: { model: "bft-final" },
};
const stored = (value: ReturnType<typeof executed> | ReturnType<typeof failed>) => {
  const { amountOs: _amount, preparedTransfer: _journal, ...result } = value;
  const { execution: _execution, ...outcome } = result as ReturnType<typeof executed>;
  return outcome as SettleResult;
};

// Paired regression for independently restored session history and rail logs.
// Older bridges preserve A; a recovery bridge may quarantine the conflict, but
// must never replace A with the unrelated B's success or permanent failure.
describe("pay-dem cross-store transaction identity", () => {
  test.each([false, true].flatMap((restart) => [false, true].map((bExecuted) => ({ restart, bExecuted }))))(
    "retains paid A or quarantines B (restart=$restart, B executed=$bExecuted)",
    async ({ restart, bExecuted }) => {
      const log = createInMemorySettlementLog();
      const reconcile = vi.fn(async () => bExecuted ? executed(hashB) : failed());
      const store = createIdempotencyStore(log);
      const rail = await sdkRail();
      const settle = payDemSettle(rail, { network: "demos" }, { store, reconcile });
      await expect(settle(request)).resolves.toMatchObject({ ok: true, txHash: hashA });
      const audit = restart
        ? payDemSettle(rail, { network: "demos" }, { store: createIdempotencyStore(log), reconcile })
        : settle;
      // The bridge's authenticated A, or the rail log's A after a restart,
      // refuses history B before any chain read.
      await expect(audit({ ...request, priorAttempts: [{ txHash: hashB, chainId: "demos", ok: true }] }))
        .rejects.toThrow(/retained transaction conflicts with the rail outcome/);
      expect(reconcile).not.toHaveBeenCalled();
      expect(sdkTransfers()).toBe(1);
      await expect(createIdempotencyStore(log).readOutcome!("pay-dem:conflicting-native:0", binding))
        .resolves.toMatchObject({ ok: true, txHash: hashA });
    },
  );
});

describe("pay-dem retained identity conflict quarantine", () => {
  test.each([false, true].flatMap((restart) => [false, true].map((paid) => ({ restart, paid }))))(
    "rejects conflicting history without claims or outcome writes (restart=$restart, paid=$paid)",
    async ({ restart, paid }) => {
      const log = createInMemorySettlementLog();
      // A store binds the log's methods when created: spy first, then clear.
      const claimIntent = vi.spyOn(log, "claimIntent");
      const putOutcome = vi.spyOn(log, "putOutcome");
      const store = createIdempotencyStore(log);
      // createPayDemRail over a node that records hash A paid or failed, so its
      // failed outcome is recorded.
      resetDemosNode({ payer, txHash: hashA, recordStatus: paid ? "confirmed" : "failed" });
      const reconcile = vi.fn<PayDemSettlementReconcile>(async () => failed());
      const rail = await sdkRail();
      const settle = payDemSettle(rail, { network: "demos" }, { store, reconcile });
      await settle(request);
      expect(claimIntent).toHaveBeenCalledTimes(1);
      expect(putOutcome).toHaveBeenCalledTimes(1);
      claimIntent.mockClear();
      putOutcome.mockClear();
      const resumed = restart
        ? payDemSettle(rail, { network: "demos" }, { store: createIdempotencyStore(log), reconcile })
        : settle;
      await expect(resumed(history())).rejects.toThrow(/conflicts with the rail outcome/);
      await expect(resumed(history())).rejects.toThrow(/different.*transaction|conflicts/);
      expect(reconcile).not.toHaveBeenCalled();
      expect(claimIntent).not.toHaveBeenCalled();
      expect(putOutcome).not.toHaveBeenCalled();
      expect(sdkTransfers()).toBe(1);
      await expect(store.readOutcome!("pay-dem:conflicting-native:0", binding))
        .resolves.toEqual(stored(paid ? executed() : failed(hashA)));
      // Correct history still audits A. A conflict never clears its identity.
      reconcile.mockImplementation(async () => paid ? executed() : failed(hashA));
      await expect(resumed(history(hashA, paid))).resolves.toMatchObject({ txHash: hashA, ok: paid });
      await expect(resumed(request)).resolves.toMatchObject({ txHash: hashA, ok: paid });
      expect(claimIntent).not.toHaveBeenCalled();
      expect(putOutcome).not.toHaveBeenCalled();
    },
  );

  test("checks a durable binding even when all retained hashes agree", async () => {
    const log = createInMemorySettlementLog();
    const store = createIdempotencyStore(log);
    await store.once("pay-dem:conflicting-native:0", binding, async () => stored(executed()));
    const submit = demosNode.transfer;
    const reconcile = vi.fn(async () => executed());
    const settle = payDemSettle(await sdkRail(), {}, { store, reconcile });
    await expect(settle({ ...history(hashA), amount: "2" })).rejects.toThrow(/binding conflicts/);
    expect(reconcile).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  test.each([
    ["success", /contradicted a permanent failed-record/],
    ["nonce", /contradicted a permanent failed-record/],
    ["block", /block conflicts/],
  ])("cannot replace a permanent proof with %s", async (change, message) => {
    const log = createInMemorySettlementLog();
    const putOutcome = vi.spyOn(log, "putOutcome");
    // This key's own submit records its hash; the failure is then persisted as
    // createPayDemRail's own record-verified settle would have left it.
    await seedSdkOutcome(log, stored(failed(hashA)), () =>
      createIdempotencyStore(log).once("pay-dem:conflicting-native:0", binding, async (fence) => {
        await fence!.recordAttempt!(hashA);
        return stored(failed(hashA));
      }));
    const store = createIdempotencyStore(log);
    putOutcome.mockClear();
    const reply = change === "success" ? executed() : {
      ...failed(hashA), ...(change === "block" ? { blockNumber: 43 } : {}),
      failureProof: { ...failed(hashA).failureProof, ...(change === "block" ? { blockNumber: 43 } : { nonce: 10 }) },
      // A journal that agrees with the reply: the conflict is with the stored proof.
      ...(change === "nonce" ? { preparedTransfer: journal(hashA, 10) } : {}),
    };
    // The SDK reads the node's record for the hash, so the node serves what the reply says.
    const { rail, submit } = await sdkAuditRail();
    serveNodeRecord(hashA, { payer, payee, ...(change === "success"
      ? { status: "confirmed" as const, nonce: 9 }
      : change === "nonce"
        ? { status: "failed" as const, nonce: 10 }
        : { status: "failed" as const, nonce: 9, blockNumber: 43 }) });
    const reconcile = vi.fn(async () => reply);
    const settle = payDemSettle(rail, {}, { store, reconcile });
    await expect(settle(history(hashA, false))).rejects.toThrow(message);
    expect(putOutcome).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  test.each([true, false])("keeps a stored permanent failure and refuses a reconciled failure that carries fee fields (history=%s)", async (withHistory) => {
    const log = createInMemorySettlementLog();
    // This key's own submit records its hash; the failure is then persisted as
    // createPayDemRail's own record-verified settle would have left it.
    await seedSdkOutcome(log, stored(failed(hashA)), () =>
      createIdempotencyStore(log).once("pay-dem:conflicting-native:0", binding, async (fence) => {
        await fence!.recordAttempt!(hashA);
        return stored(failed(hashA));
      }));
    const store = createIdempotencyStore(log);
    const putOutcome = vi.spyOn(log, "putOutcome");
    const { rail, submit } = await sdkAuditRail();
    serveNodeRecord(hashA, { payer, payee, nonce: 9, status: "failed" });
    // Same transaction, block and proof; a failure carries no fee fields.
    let reply: ReturnType<typeof failed> & { networkFeeOs?: string } = { ...failed(hashA), networkFeeOs: "5" };
    const reconcile = vi.fn(async () => reply);
    const settle = payDemSettle(rail, {}, { store, reconcile });
    const call = () => settle(withHistory ? history(hashA, false) : request);
    await expect(call()).rejects.toThrow(/invalid terminal-failure proof/);
    reply = failed(hashA);
    await expect(call()).resolves.toMatchObject({
      ok: false, errorClass: "permanent", txHash: hashA, failureProof: failed(hashA).failureProof,
    });
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(putOutcome).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  test("cannot move a durable success to another block", async () => {
    const log = createInMemorySettlementLog();
    const store = createIdempotencyStore(log);
    await store.once("pay-dem:conflicting-native:0", binding, async () => stored(executed()));
    const { rail, submit } = await sdkAuditRail();
    serveNodeRecord(hashA, { payer, payee, nonce: 9, blockNumber: 43 });
    const reconcile = vi.fn(async () => ({ ...executed(), blockNumber: 43 }));
    const settle = payDemSettle(rail, {}, { store, reconcile });
    await expect(settle(history(hashA))).rejects.toThrow(/block conflicts/);
    expect(submit).not.toHaveBeenCalled();
    await expect(store.readOutcome!("pay-dem:conflicting-native:0", binding))
      .resolves.toEqual(stored(executed()));
  });

  test("rejects another hash retained only in an indeterminate in-process result", async () => {
    const store = createIdempotencyStore();
    const once = vi.spyOn(store, "once");
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => failed());
    const settle = payDemSettle(await heldRail(), {}, { store, reconcile });
    await expect(settle(request)).resolves.toMatchObject({ ok: false, txHash: hashA });
    await expect(settle(history())).rejects.toThrow(/conflicts with the rail outcome/);
    expect(once).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();
  });

  test("an in-process indeterminate result for the retained hash does not block its audit", async () => {
    // The node's record is still pending when the rail returns, so its result is held.
    resetDemosNode({ payer, txHash: hashA, recordStatus: "pending" });
    const store = createIdempotencyStore();
    const once = vi.spyOn(store, "once");
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => executed());
    const settle = payDemSettle(await sdkRail(), {}, { store, reconcile });
    await expect(settle(request)).resolves.toMatchObject({ ok: false, txHash: hashA });
    // The held result has no block or failure class; finality is read later.
    setNodeRecordStatus("confirmed");
    await expect(settle(history(hashA, false)))
      .resolves.toMatchObject({ ok: true, txHash: hashA, blockNumber: 42 });
    expect(once).toHaveBeenCalledTimes(1);
    expect(sdkTransfers()).toBe(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  test("a delayed submit cannot be overtaken by a conflicting history audit", async () => {
    let finish!: () => void;
    let started!: () => void;
    const submitted = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    // The rail has recorded its hash and broadcast; it waits for inclusion.
    demosNode.nodeCall.mockImplementation(async () => {
      started();
      await gate;
      return { state: "included", blockNumber: 42 };
    });
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => failed());
    const store = createIdempotencyStore();
    const once = vi.spyOn(store, "once");
    const settle = payDemSettle(await sdkRail(), { network: "demos" }, { store, reconcile });
    const fresh = settle(request);
    await submitted;
    const audit = expect(settle(history())).rejects.toThrow(/conflicts with the rail outcome/);
    finish();
    await expect(fresh).resolves.toMatchObject({ txHash: hashA, ok: true });
    await audit;
    expect(reconcile).not.toHaveBeenCalled();
    expect(once).toHaveBeenCalledTimes(1);
    expect(sdkTransfers()).toBe(1);
  });

  test("keeps a success another bridge records for the retained hash during the audit", async () => {
    const log = createInMemorySettlementLog();
    const store = createIdempotencyStore(log);
    const once = vi.spyOn(store, "once");
    const { rail, submit } = await sdkAuditRail();
    serveNodeRecord(hashA, { payer, payee, nonce: 9, status: "failed" });
    const reconcile = vi.fn(async () => {
      // Another process records A executed while this audit's chain read says failed.
      await createIdempotencyStore(log).once("pay-dem:conflicting-native:0", binding, async () => stored(executed()));
      return failed(hashA);
    });
    const settle = payDemSettle(rail, {}, { store, reconcile });
    await expect(settle(history(hashA, false))).rejects.toThrow(/contradicted an authenticated successful outcome/);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(once).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    await expect(store.readOutcome!("pay-dem:conflicting-native:0", binding))
      .resolves.toMatchObject({ txHash: hashA, ok: true });
  });

  test("rechecks the rail log when another bridge finishes during the audit", async () => {
    const log = createInMemorySettlementLog();
    const store = createIdempotencyStore(log);
    const once = vi.spyOn(store, "once");
    const submit = demosNode.transfer;
    // The SDK reads the node's record for the hash, so the node serves what the reply says.
    serveNodeRecord(hashB, { payer, payee, nonce: 9, status: "failed" });
    const reconcile = vi.fn(async () => {
      // Independent process/store completes A while B's chain read is pending.
      await createIdempotencyStore(log).once("pay-dem:conflicting-native:0", binding, async () => stored(executed()));
      return failed();
    });
    const settle = payDemSettle(await sdkRail(), {}, { store, reconcile });
    await expect(settle(history())).rejects.toThrow(/conflicts with the rail outcome/);
    expect(once).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    await expect(store.readOutcome!("pay-dem:conflicting-native:0", binding))
      .resolves.toMatchObject({ txHash: hashA, ok: true });
  });

  test.each([
    ["missing", /requires read-only outcome lookup/],
    ["undefined", /must be stable canonical settlement data/],
    ["malformed", /malformed pay-dem settlement shape/],
    ["indeterminate", /read-only rail outcome is not definitive/],
    ["throws", undefined],
  ])("fails closed for a %s outcome lookup", async (mode, message) => {
    const cause = new Error("lookup timed out");
    const once = vi.fn();
    const readOutcome = vi.fn(async () => {
      if (mode === "throws") throw cause;
      if (mode === "undefined") return undefined;
      if (mode === "indeterminate") {
        const { finality: _finality, ...outcome } = stored(executed());
        return { ...outcome, ok: false };
      }
      return {};
    });
    const store = { once, ...(mode === "missing" ? {} : { readOutcome }) };
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => failed());
    const submit = demosNode.transfer;
    const settle = payDemSettle(await sdkRail(), {}, { store: store as never, reconcile });
    for (const req of [history(), request]) {
      if (message === undefined) await expect(settle(req)).rejects.toBe(cause);
      else await expect(settle(req)).rejects.toThrow(message);
    }
    expect(reconcile).not.toHaveBeenCalled();
    expect(once).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});

// A store whose once runs every call (its log forgets intents) exposes the
// bridge's own per-key serialization. It runs submit under the SDK fence and
// passes on that same store's lookups, so the rail may run.
describe("pay-dem serializes calls for one settlement key", () => {
  const unwaitingStore = () => {
    const fences = sdkFences();
    return {
      once: vi.fn(async (key: string, binding: SettlementBinding, run: Parameters<typeof fences.run>[2]) =>
        fences.run(key, binding, run)),
      readOutcome: fences.readOutcome,
      readAttempt: fences.readAttempt,
    };
  };

  test("a conflicting audit waits for a delayed submit", async () => {
    let finish!: () => void;
    let started!: () => void;
    const submitted = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    // The rail has recorded its hash and broadcast; it waits for inclusion.
    demosNode.nodeCall.mockImplementation(async () => {
      started();
      await gate;
      return { state: "included", blockNumber: 42 };
    });
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => failed());
    const store = unwaitingStore();
    const settle = payDemSettle(await sdkRail(), { network: "demos" }, { store: store as never, reconcile });
    const fresh = settle(request);
    await submitted;
    const audit = expect(settle(history())).rejects.toThrow(/conflicts with the rail outcome/);
    await new Promise((resolve) => setImmediate(resolve));
    finish();
    await expect(fresh).resolves.toMatchObject({ txHash: hashA, ok: true });
    await audit;
    expect(reconcile).not.toHaveBeenCalled();
    expect(sdkTransfers()).toBe(1);
  });

  test("a slow call on one key does not delay a call on another key", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // The node signs hash A for the first transfer and B for the next; it
    // reports A's inclusion only once released.
    resetDemosNode({ payer, txHash: hashA, laterTxHashes: [hashB] });
    demosNode.nodeCall.mockImplementation(async (_message: string, args: { hash?: string }) => {
      if (args.hash === hashA) await gate;
      return { state: "included", blockNumber: 42 };
    });
    const settle = payDemSettle(await sdkRail(), {}, { store: createIdempotencyStore() });
    const slow = settle({ ...request, jobId: "job-slow" });
    await vi.waitFor(() => expect(sdkTransfers()).toBe(1));
    await expect(settle({ ...request, jobId: "job-fast" })).resolves.toMatchObject({ txHash: hashB });
    release();
    await expect(slow).resolves.toMatchObject({ txHash: hashA });
  });

  test("a third call waits for the second even after the first has finished", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    // The node signs a new hash per transfer and reports the second one's
    // inclusion only once released.
    resetDemosNode({ payer, txHash: hashA, laterTxHashes: [hashB, hashC] });
    const sign = demosNode.transfer.getMockImplementation()!;
    let calls = 0;
    demosNode.transfer.mockImplementation(async (...args: unknown[]) => {
      order.push(`start ${++calls}`);
      return sign(...args);
    });
    demosNode.nodeCall.mockImplementation(async (_message: string, args: { hash?: string }) => {
      if (args.hash === hashB) await gate;
      return { state: "included", blockNumber: 42 };
    });
    const rail = await sdkRail();
    const numbered = (call: number, pending: Promise<unknown>) =>
      pending.finally(() => { order.push(`end ${call}`); });
    // A store that runs every call, so only the bridge orders them.
    const fences = sdkFences();
    const store = {
      once: vi.fn(fences.run),
      readOutcome: fences.readOutcome,
      readAttempt: fences.readAttempt,
    };
    const settle = payDemSettle(rail, {}, { store: store as never });
    const first = numbered(1, settle(request));
    const second = numbered(2, settle(request));
    await first;
    const third = numbered(3, settle(request));
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(["start 1", "end 1", "start 2"]);
    release();
    await Promise.all([second, third]);
    expect(order).toEqual(["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
  });

  test("a failed earlier audit does not reject the call queued behind it", async () => {
    const cause = new Error("journal read timed out");
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const reconcile = vi.fn<PayDemSettlementReconcile>()
      .mockImplementationOnce(async () => { await gate; throw cause; })
      .mockImplementation(async () => executed());
    const store = unwaitingStore();
    const settle = payDemSettle(await sdkRail(), { network: "demos" }, { store: store as never, reconcile });
    // This bridge paid A itself, so its own record binds A to the key.
    await expect(settle(request)).resolves.toMatchObject({ ok: true, txHash: hashA });
    store.once.mockClear();
    const transfers = sdkTransfers();
    const first = expect(settle(history(hashA, false))).rejects.toBe(cause);
    const second = settle(history(hashA, false));
    await new Promise((resolve) => setImmediate(resolve));
    expect(reconcile).toHaveBeenCalledTimes(1);
    finish();
    await first;
    await expect(second).resolves.toMatchObject({ ok: true, txHash: hashA });
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(store.once).not.toHaveBeenCalled();
    expect(sdkTransfers()).toBe(transfers);
  });
});

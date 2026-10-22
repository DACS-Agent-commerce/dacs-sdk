import { beforeEach, describe, expect, test, vi } from "vitest";

import type { SettleRequest } from "../../src/agent/runSessionCore.js";
import {
  createIdempotencyStore, createInMemorySettlementLog, settlementBindingHash,
  type SettlementLog,
} from "../../src/rails/idempotency.js";
import { payDemSettle } from "../../src/rails/payDem.js";
import { demosNode, resetDemosNode, sdkRail } from "../fixtures/demosNodeMock.js";

vi.mock("@kynesyslabs/demosdk/websdk", async () =>
  (await import("../fixtures/demosNodeMock.js")).demosSdkModule());

const payer = "ab".repeat(32);
const payee = "cd".repeat(32);
const hash = "56".repeat(32);
const key = "pay-dem:job-a:0";
const request = (over: Partial<SettleRequest> = {}): SettleRequest => ({
  rail: "pay-dem", phase: "pay-dem", phaseIndex: 0, jobId: "job-a", amount: "1", asset: "DEM",
  payee: `did:demos:agent:${payee}`, expectedPayee: `did:demos:agent:${payee}`, ...over,
});
const history = (ok = false) => ({ priorAttempts: [{ txHash: hash, chainId: "demos", ok }] });
beforeEach(() => resetDemosNode({ payer, txHash: hash, nonce: 7 }));

describe("independent attempt recorder identity checks", () => {
  test.each(["foreign store", "different terms"] as const)("refuses a genuine recorder for %s despite matching public fields", async (mode) => {
    const logA = createInMemorySettlementLog();
    const logB = createInMemorySettlementLog();
    const a = createIdempotencyStore(logA);
    const b = mode === "foreign store" ? createIdempotencyStore(logB) : a;
    const store: typeof a = {
      readAttempt: a.readAttempt, readOutcome: a.readOutcome,
      once: (selectedKey, terms, submit, reconcile) => b.once(
        selectedKey, mode === "different terms" ? { ...terms, amount: "2" } : terms,
        (fence) => submit(Object.freeze({
          ...fence!, settlementKey: selectedKey, bindingHash: settlementBindingHash(terms),
        })), reconcile,
      ),
    };
    await expect(payDemSettle(await sdkRail(), {}, { store })(request())).rejects.toThrow(/refusing to start/);
    expect(demosNode.transfer).not.toHaveBeenCalled();
    expect(demosNode.broadcast).not.toHaveBeenCalled();
    for (const log of [logA, logB]) {
      await expect(log.readAttempt!(key)).resolves.toBeNull();
      await expect(log.readOutcome!(key)).resolves.toBeNull();
    }
  });
});

test("session success contradicting a local permanent failure is refused without a reconciler", async () => {
  resetDemosNode({ payer, txHash: hash, nonce: 7, recordStatus: "failed" });
  const settle = payDemSettle(await sdkRail());
  await expect(settle(request())).resolves.toMatchObject({ ok: false, errorClass: "permanent", txHash: hash });
  await expect(settle(request(history(true)))).rejects.toThrow(/success|succeed/);
  expect(demosNode.transfer).toHaveBeenCalledTimes(1);
  expect(demosNode.broadcast).toHaveBeenCalledTimes(1);
});

test("local success with a failed outcome write is insufficient for a no-reconciler audit", async () => {
  const memory = createInMemorySettlementLog();
  const log: SettlementLog = {
    ...memory, putOutcome: async () => { throw new Error("outcome storage unavailable"); },
  };
  const settle = payDemSettle(await sdkRail(), {}, { store: createIdempotencyStore(log) });
  await expect(settle(request())).rejects.toThrow(/outcome storage unavailable/);
  await expect(memory.readAttempt!(key)).resolves.toMatchObject({ txHash: hash });
  await expect(memory.readOutcome!(key)).resolves.toBeNull();
  await expect(settle(request(history(true)))).rejects.toThrow(/requires read-only reconciliation/);
  expect(demosNode.transfer).toHaveBeenCalledTimes(1);
});

test.each(["blockNumber", "networkFeeOs"] as const)("a no-reconciler audit requires the saved %s to equal the local result", async (field) => {
  const memory = createInMemorySettlementLog();
  let changed = false;
  const log: SettlementLog = {
    ...memory,
    readOutcome: async (selectedKey) => {
      const saved = await memory.readOutcome!(selectedKey);
      return !changed || saved === null ? saved : {
        ...saved, result: { ...saved.result, [field]: field === "blockNumber" ? 43 : "123" },
      };
    },
  };
  const settle = payDemSettle(await sdkRail(), {}, { store: createIdempotencyStore(log) });
  await settle(request());
  changed = true;
  await expect(settle(request(history(true)))).rejects.toThrow(/requires read-only reconciliation/);
  expect(demosNode.transfer).toHaveBeenCalledTimes(1);
});

test("explicitly undefined optional recorder behaves like an omitted recorder", async () => {
  const rail = await sdkRail();
  const fence = {
    owner: "direct", generation: 1, settlementKey: key, bindingHash: "00".repeat(32),
    assertCurrent: vi.fn(async () => undefined), recordAttempt: undefined,
  };
  await expect(rail.settle({ recipient: payee, amount: "1000000000" }, fence))
    .resolves.toMatchObject({ ok: true, txHash: hash });
  expect(demosNode.transfer).toHaveBeenCalledTimes(1);
});

test("a direct rail remains usable without optional attempt recording, without restart guarantees", async () => {
  const { putAttempt: _put, readAttempt: _read, ...log } = createInMemorySettlementLog();
  const store = createIdempotencyStore(log);
  const terms = {
    bindingVersion: "1" as const, railId: "pay-dem", jobId: "job-a", phaseIndex: 0, phase: "pay-dem",
    amount: "1000000000", agreementAsset: "DEM", settlementAsset: "DEM", payer, payee,
    network: "demos", finality: { model: "bft-final" },
  };
  const rail = await sdkRail();
  await expect(store.once(key, terms, async (fence) => {
    const { execution: _execution, ...result } = await rail.settle({ recipient: payee, amount: terms.amount }, fence);
    return { ...result, payer, payee };
  })).resolves.toMatchObject({ ok: true, txHash: hash });
  expect(demosNode.broadcast).toHaveBeenCalledTimes(1);
});

test("explicitly undefined readOutcome refuses an audit before claiming", async () => {
  const once = vi.fn();
  const settle = payDemSettle(await sdkRail(), {}, { store: { once, readOutcome: undefined } });
  await expect(settle(request(history()))).rejects.toThrow(/read-only outcome lookup/);
  expect(once).not.toHaveBeenCalled();
  expect(demosNode.transfer).not.toHaveBeenCalled();
});

test("a store cannot ask the reconciler about another settlement key", async () => {
  const inner = createIdempotencyStore();
  const reconcile = vi.fn();
  const settle = payDemSettle(await sdkRail(), {}, { reconcile, store: {
    readOutcome: inner.readOutcome, readAttempt: inner.readAttempt,
    once: async (_key, _terms, _submit, recover) => {
      await recover!("pay-dem:other-job:0");
      throw new Error("unexpected reconciliation completion");
    },
  } });
  await expect(settle(request())).rejects.toThrow(/different settlement key/);
  expect(reconcile).not.toHaveBeenCalled();
  expect(demosNode.transfer).not.toHaveBeenCalled();
});

test("explicitly undefined priorAttempts behaves like omitted history", async () => {
  const settle = payDemSettle(await sdkRail());
  await expect(settle(request({ priorAttempts: undefined }))).resolves.toMatchObject({ ok: true, txHash: hash });
  await expect(settle(request())).resolves.toMatchObject({ ok: true, txHash: hash });
  expect(demosNode.transfer).toHaveBeenCalledTimes(1);
});

test("a saved current-SDK permanent failure remains readable without the attempt lookup", async () => {
  resetDemosNode({ payer, txHash: hash, nonce: 7, recordStatus: "failed" });
  const log = createInMemorySettlementLog();
  await payDemSettle(await sdkRail(), {}, { store: createIdempotencyStore(log) })(request());
  const inner = createIdempotencyStore(log);
  const reconcile = vi.fn(async () => ({
    ok: false as const, txHash: hash, payer, payee, chainId: "demos", amountOs: "1000000000",
    blockNumber: 42, txRefKind: "demos", errorClass: "permanent" as const,
    failureProof: { kind: "demos-failed-record" as const, txHash: hash, payer, payee,
      nonce: 7, blockNumber: 42, amountOs: "1000000000" },
  }));
  const settle = payDemSettle(await sdkRail(), {}, {
    store: { once: inner.once, readOutcome: inner.readOutcome }, reconcile,
  });
  await expect(settle(request())).resolves.toMatchObject({ ok: false, errorClass: "permanent", txHash: hash });
  expect(reconcile).toHaveBeenCalledTimes(1);
  expect(demosNode.transfer).toHaveBeenCalledTimes(1);
  expect(demosNode.broadcast).toHaveBeenCalledTimes(1);
});

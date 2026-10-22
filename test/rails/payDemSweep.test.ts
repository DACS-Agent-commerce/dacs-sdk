import { beforeEach, expect, test, vi } from "vitest";

import type { SettleRequest } from "../../src/agent/runSessionCore.js";
import { canonicalize } from "../../src/canonical/index.js";
import {
  createIdempotencyStore, createInMemorySettlementLog,
  type SettlementIdempotencyStore,
} from "../../src/rails/idempotency.js";
import { isPayDemSessionRecoverable, payDemSettle } from "../../src/rails/payDem.js";
import {
  demosNode, resetDemosNode, sdkRail, serveNodeRecord,
} from "../fixtures/demosNodeMock.js";

vi.mock("@kynesyslabs/demosdk/websdk", async () =>
  (await import("../fixtures/demosNodeMock.js")).demosSdkModule());

const payer = "ab".repeat(32);
const payee = "cd".repeat(32);
const txHash = "56".repeat(32);
const key = "pay-dem:sweep:0";
const request = (over: Partial<SettleRequest> = {}): SettleRequest => ({
  rail: "pay-dem", phase: "pay-dem", phaseIndex: 0, jobId: "sweep", amount: "1", asset: "DEM",
  payee: `did:demos:agent:${payee}`, expectedPayee: `did:demos:agent:${payee}`, ...over,
});
const identity = {
  txHash, chainId: "demos", payer, payee, amountOs: "1000000000", blockNumber: 42, txRefKind: "demos",
};
const executedClaim = () => ({
  ...identity, ok: true as const, execution: "executed" as const, finality: { model: "bft-final" as const },
});
const failedClaim = () => ({
  ...identity, ok: false as const, errorClass: "permanent" as const, failureProof: {
      kind: "demos-failed-record" as const, txHash, payer, payee, nonce: 7,
      blockNumber: 42, amountOs: "1000000000",
  },
});
beforeEach(() => resetDemosNode({ payer, txHash, nonce: 7 }));

test.each(["store only", "undefined store", "configured"] as const)(
  "unmocked session recovery eligibility: %s", async (mode) => {
    const store = createIdempotencyStore();
    const once = vi.spyOn(store, "once");
    const settle = payDemSettle(await sdkRail(), {}, {
      store: mode === "undefined store" ? undefined : store,
      ...(mode === "store only" ? {} : { reconcile: async () => null }),
    });
    expect(isPayDemSessionRecoverable(settle)).toBe(mode === "configured");
    expect(isPayDemSessionRecoverable(settle, false)).toBe(mode !== "undefined store");
    expect(once).not.toHaveBeenCalled();
    expect(demosNode.transfer).not.toHaveBeenCalled();
  },
);

test.each(["true", 1, null])("nonboolean recoveryOnly=%s refuses before claiming or paying", async (value) => {
  const store = createIdempotencyStore();
  const once = vi.spyOn(store, "once");
  const settle = payDemSettle(await sdkRail(), {}, { store });
  await expect(settle(request({ recoveryOnly: value as never }))).rejects.toThrow(/recoveryOnly/);
  expect(once).not.toHaveBeenCalled();
  expect(demosNode.transfer).not.toHaveBeenCalled();
  expect(demosNode.broadcast).not.toHaveBeenCalled();
});

test.each([{}, { recoveryOnly: undefined }, { recoveryOnly: false }])(
  "omitted, undefined and false recoveryOnly permit the same fresh settlement: %j", async (over) => {
    await expect(payDemSettle(await sdkRail())(request(over))).resolves.toMatchObject({ ok: true, txHash });
    expect(demosNode.transfer).toHaveBeenCalledTimes(1);
    expect(demosNode.broadcast).toHaveBeenCalledTimes(1);
  },
);

test.each([true, false])("a reconciliation-returning store binds failed records only with SDK attempt lookups: %s", async (bound) => {
  resetDemosNode({ payer, txHash, nonce: 7, recordStatus: "failed" });
  const inner = createIdempotencyStore(createInMemorySettlementLog());
  if (bound) await payDemSettle(await sdkRail(), {}, { store: inner })(request());
  else serveNodeRecord(txHash, { payer, payee, status: "failed" });
  const beforeTransfers = demosNode.transfer.mock.calls.length;
  const submit = vi.fn();
  const store: SettlementIdempotencyStore = {
    ...(bound ? { readAttempt: inner.readAttempt, readOutcome: inner.readOutcome } : {}),
    once: async (selectedKey, _terms, _submit, reconcile) => {
      expect(selectedKey).toBe(key);
      const result = await reconcile!(selectedKey);
      if (!result || !("ok" in result)) throw new Error("missing test reconciliation outcome");
      return result;
    },
  };
  const settle = payDemSettle(await sdkRail(), {}, { store, reconcile: async () => failedClaim() });
  demosNode.transfer.mockImplementation(submit);
  if (bound) {
    await expect(settle(request())).resolves.toMatchObject({
      ok: false, errorClass: "permanent", failureProof: failedClaim().failureProof,
    });
  } else {
    await expect(settle(request())).rejects.toThrow(/does not match the authoritative reconciled transaction/);
  }
  expect(submit).not.toHaveBeenCalled();
  expect(demosNode.transfer).toHaveBeenCalledTimes(beforeTransfers);
  expect(demosNode.broadcast).toHaveBeenCalledTimes(beforeTransfers);
});

test.each([true, false])("fresh definitive ok=%s reads its execution record exactly once", async (ok) => {
  resetDemosNode({ payer, txHash, nonce: 7, recordStatus: ok ? "confirmed" : "failed" });
  await expect(payDemSettle(await sdkRail())(request())).resolves.toMatchObject({ ok, txHash });
  expect(demosNode.getTxByHash).toHaveBeenCalledTimes(1);
  expect(demosNode.transfer).toHaveBeenCalledTimes(1);
  expect(demosNode.broadcast).toHaveBeenCalledTimes(1);
});

test("store-reconciled recovery reads the fork and execution record once", async () => {
  const log = createInMemorySettlementLog();
  await payDemSettle(await sdkRail(), {}, { store: createIdempotencyStore(log) })(request());
  // Preserve the genuine attempt and outcome lookups, while returning reconciliation directly.
  const inner = createIdempotencyStore(log);
  const store: SettlementIdempotencyStore = {
    readAttempt: inner.readAttempt, readOutcome: inner.readOutcome,
    once: async (selectedKey, _terms, _submit, reconcile) => {
      const result = await reconcile!(selectedKey);
      if (!result || !("ok" in result)) throw new Error("missing test reconciliation outcome");
      return result;
    },
  };
  const settle = payDemSettle(await sdkRail(), {}, { store, reconcile: async () => executedClaim() });
  demosNode.getNetworkInfo.mockClear();
  demosNode.getTxByHash.mockClear();
  await expect(settle(request())).resolves.toMatchObject({ ok: true, txHash });
  expect(demosNode.getNetworkInfo).toHaveBeenCalledTimes(1);
  expect(demosNode.getTxByHash).toHaveBeenCalledTimes(1);
  expect(demosNode.transfer).toHaveBeenCalledTimes(1);
});

test.each([262144, 262145])("recovery record canonical size boundary: %s characters", async (size) => {
  const log = createInMemorySettlementLog();
  await payDemSettle(await sdkRail(), {}, { store: createIdempotencyStore(log) })(request());
  const record = await demosNode.getTxByHash(txHash) as Record<string, unknown>;
  const padded = { ...record, padding: "" };
  padded.padding = "x".repeat(size - canonicalize(padded).length);
  expect(canonicalize(padded)).toHaveLength(size);
  demosNode.getTxByHash.mockResolvedValue(padded);
  const settle = payDemSettle(await sdkRail(), {}, {
    store: createIdempotencyStore(log), reconcile: async () => executedClaim(),
  });
  const before = await log.readOutcome!(key);
  if (size === 262144) await expect(settle(request())).resolves.toMatchObject({ ok: true, txHash });
  else await expect(settle(request())).rejects.toThrow(/size limit/);
  expect(await log.readOutcome!(key)).toEqual(before);
  expect(demosNode.transfer).toHaveBeenCalledTimes(1);
  expect(demosNode.broadcast).toHaveBeenCalledTimes(1);
});

test.each([false, undefined, "true", 1])("DEM-signed recovery requires a boolean fork state, accepting inactive: %s", async (activated) => {
  const log = createInMemorySettlementLog();
  await payDemSettle(await sdkRail(), {}, { store: createIdempotencyStore(log) })(request());
  const record = await demosNode.getTxByHash(txHash) as Record<string, unknown>;
  const content = record.content as Record<string, unknown>;
  // The current SDK supports records signed as whole DEM before the fork.
  demosNode.getTxByHash.mockResolvedValue({ ...record, content: { ...content,
    amount: 1, data: ["native", { nativeOperation: "send", args: [payee, 1] }],
  } });
  const settle = payDemSettle(await sdkRail(), {}, {
    store: createIdempotencyStore(log), reconcile: async () => executedClaim(),
  });
  demosNode.getNetworkInfo.mockResolvedValue({ forks: { osDenomination:
    activated === undefined ? {} : { activated } } });
  const before = await log.readOutcome!(key);
  if (activated === false) await expect(settle(request())).resolves.toMatchObject({ ok: true, txHash });
  else await expect(settle(request())).rejects.toThrow(/fork state is unavailable/);
  expect(await log.readOutcome!(key)).toEqual(before);
  expect(demosNode.transfer).toHaveBeenCalledTimes(1);
  expect(demosNode.broadcast).toHaveBeenCalledTimes(1);
});

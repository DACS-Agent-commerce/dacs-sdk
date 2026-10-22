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

test("explicitly undefined priorAttempts behaves like omitted history", async () => {
  const settle = payDemSettle(await sdkRail());
  await expect(settle(request({ priorAttempts: undefined }))).resolves.toMatchObject({ ok: true, txHash: hash });
  await expect(settle(request())).resolves.toMatchObject({ ok: true, txHash: hash });
  expect(demosNode.transfer).toHaveBeenCalledTimes(1);
});

// The success binding never refuses a failure. A failure is final only when
// this key's attempt record binds its hash; through a store that hides the
// attempt lookup the saved failure stays held and nothing is resubmitted.
test.each([true, false])("a saved current-SDK permanent failure is final only through the attempt lookup (lookup=%s)", async (lookup) => {
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
    store: lookup ? inner : { once: inner.once, readOutcome: inner.readOutcome }, reconcile,
  });
  await (lookup
    ? expect(settle(request())).resolves.toMatchObject({ ok: false, errorClass: "permanent", txHash: hash })
    : expect(settle(request())).rejects.toThrow(/not confirmed by the SDK's own node record read.*never resubmitted/));
  expect(reconcile).toHaveBeenCalledTimes(1);
  expect(demosNode.transfer).toHaveBeenCalledTimes(1);
  expect(demosNode.broadcast).toHaveBeenCalledTimes(1);
});

import { describe, expect, test, vi } from "vitest";

import type { SettleRequest, SettleResult } from "../../src/agent/runSessionCore.js";
import { createIdempotencyStore, createInMemorySettlementLog, type SettlementBinding } from "../../src/rails/idempotency.js";
import { type PayDemRail, type PayDemSettlementReconcile, payDemSettle } from "../../src/rails/payDem.js";

const hashA = "12".repeat(32);
const hashB = "34".repeat(32);
const payer = "ab".repeat(32);
const payee = "cd".repeat(32);
const claim = `did:demos:agent:${payee}`;
const request: SettleRequest = {
  rail: "pay-dem", phase: "pay-dem", phaseIndex: 0, jobId: "conflicting-native",
  amount: "1", asset: "DEM", payee: claim, expectedPayee: claim,
};
const executed = (txHash = hashA) => ({
  ok: true as const, txHash, payer, payee, chainId: "demos", amountOs: "1000000000",
  blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" as const },
  execution: "executed" as const,
});
const freshSuccess = () => {
  const { amountOs: _amount, ...result } = executed();
  return result;
};
const failed = (txHash = hashB) => ({
  ok: false as const, txHash, payer, payee, chainId: "demos", amountOs: "1000000000",
  blockNumber: 42, txRefKind: "demos", errorClass: "permanent" as const,
  failureProof: { kind: "demos-failed-record" as const, txHash, payer, payee,
    nonce: 9, blockNumber: 42, amountOs: "1000000000" },
});

const history = (txHash = hashB): SettleRequest => ({
  ...request, priorAttempts: [{ txHash, chainId: "demos", ok: true }],
});
const binding: SettlementBinding = {
  bindingVersion: "1", railId: "pay-dem", jobId: request.jobId, phaseIndex: 0,
  phase: "pay-dem", amount: "1000000000", agreementAsset: "DEM", settlementAsset: "DEM",
  payer, payee, network: "demos", finality: { model: "bft-final" },
};
const stored = (value: ReturnType<typeof executed> | ReturnType<typeof failed>) => {
  const { amountOs: _amount, ...result } = value;
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
      const submit = vi.fn(async () => {
        const { amountOs: _amount, ...result } = executed();
        return result;
      });
      const reconcile = vi.fn(async () => bExecuted ? executed(hashB) : failed());
      const store = createIdempotencyStore(log);
      const rail = { address: payer, settle: submit };
      const settle = payDemSettle(rail, {}, { store, reconcile });
      await expect(settle(request)).resolves.toMatchObject({ ok: true, txHash: hashA });
      const audit = restart ? payDemSettle(rail, {}, { store: createIdempotencyStore(log), reconcile }) : settle;
      let result: SettleResult | undefined;
      try {
        result = await audit({ ...request, priorAttempts: [{ txHash: hashB, chainId: "demos", ok: true }] });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/conflict|does not match/);
      }
      if (result !== undefined) expect(result.txHash).toBe(hashA);
      expect(submit).toHaveBeenCalledTimes(1);
    },
  );
});

describe("pay-dem retained identity conflict quarantine", () => {
  test.each([false, true].flatMap((restart) => [false, true].map((paid) => ({ restart, paid }))))(
    "rejects conflicting history without claims or outcome writes (restart=$restart, paid=$paid)",
    async ({ restart, paid }) => {
      const log = createInMemorySettlementLog();
      const store = createIdempotencyStore(log);
      const submit = vi.fn<PayDemRail["settle"]>(async () => {
        if (paid) return freshSuccess();
        const { amountOs: _amount, ...result } = failed(hashA);
        return result;
      });
      const reconcile = vi.fn<PayDemSettlementReconcile>(async () => failed());
      const rail = { address: payer, settle: submit };
      const settle = payDemSettle(rail, {}, { store, reconcile });
      await settle(request);
      const claimIntent = vi.spyOn(log, "claimIntent");
      const putOutcome = vi.spyOn(log, "putOutcome");
      const resumed = restart ? payDemSettle(rail, {}, { store: createIdempotencyStore(log), reconcile }) : settle;
      await expect(resumed(history())).rejects.toThrow(/conflicts with the rail outcome/);
      await expect(resumed(history())).rejects.toThrow(/different.*transaction|conflicts/);
      expect(reconcile).not.toHaveBeenCalled();
      expect(claimIntent).not.toHaveBeenCalled();
      expect(putOutcome).not.toHaveBeenCalled();
      expect(submit).toHaveBeenCalledTimes(1);
      await expect(store.readOutcome!("pay-dem:conflicting-native:0", binding))
        .resolves.toEqual(stored(paid ? executed() : failed(hashA)));
      // Correct history still audits A. A conflict never clears its identity.
      reconcile.mockImplementation(async () => paid ? executed() : failed(hashA));
      await expect(resumed(history(hashA))).resolves.toMatchObject({ txHash: hashA, ok: paid });
      await expect(resumed(request)).resolves.toMatchObject({ txHash: hashA, ok: paid });
      expect(claimIntent).not.toHaveBeenCalled();
      expect(putOutcome).not.toHaveBeenCalled();
    },
  );

  test.each([false, true])("rejects a success block change with a restarted bridge=%s", async (restart) => {
    const log = createInMemorySettlementLog();
    const store = createIdempotencyStore(log);
    const submit = vi.fn(async () => freshSuccess());
    const reconcile = vi.fn(async () => ({ ...executed(), blockNumber: 43 }));
    const rail = { address: payer, settle: submit };
    const first = payDemSettle(rail, {}, { store, reconcile });
    await first(request);
    const once = vi.spyOn(store, "once");
    const after = restart ? payDemSettle(rail, {}, { store, reconcile }) : first;
    await expect(after(history(hashA))).rejects.toThrow(/block conflicts/);
    expect(once).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  test("lets another key complete while a first key is waiting on submission", async () => {
    let release: () => void = () => { throw new Error("gate not initialized"); };
    let started: () => void = () => { throw new Error("signal not initialized"); };
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const submitting = new Promise<void>((resolve) => { started = resolve; });
    const submit: PayDemRail["settle"] = vi.fn(async (input) => {
      if (input.recovery?.phaseIndex === 0) { started(); await gate; }
      return freshSuccess();
    });
    const settle = payDemSettle({ address: payer, settle: submit });
    const first = settle(request);
    await submitting;
    try {
      await expect(settle({ ...request, phaseIndex: 1 })).resolves.toMatchObject({ ok: true });
    } finally {
      release();
      await first;
    }
    expect(submit).toHaveBeenCalledTimes(2);
  });

  test("checks a durable binding even when all retained hashes agree", async () => {
    const log = createInMemorySettlementLog();
    const store = createIdempotencyStore(log);
    await store.once("pay-dem:conflicting-native:0", binding, async () => stored(executed()));
    const submit = vi.fn();
    const reconcile = vi.fn(async () => executed());
    const settle = payDemSettle({ address: payer, settle: submit }, {}, { store, reconcile });
    await expect(settle({ ...history(hashA), amount: "2" })).rejects.toThrow(/binding conflicts/);
    expect(reconcile).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  test.each(["success", "nonce", "block"])("cannot replace a permanent proof with %s", async (change) => {
    const log = createInMemorySettlementLog();
    const store = createIdempotencyStore(log);
    await store.once("pay-dem:conflicting-native:0", binding, async () => stored(failed(hashA)));
    const reply = change === "success" ? executed() : {
      ...failed(hashA), ...(change === "block" ? { blockNumber: 43 } : {}),
      failureProof: { ...failed(hashA).failureProof, ...(change === "block" ? { blockNumber: 43 } : { nonce: 10 }) },
    };
    const submit = vi.fn();
    const reconcile = vi.fn(async () => reply);
    const putOutcome = vi.spyOn(log, "putOutcome");
    const settle = payDemSettle({ address: payer, settle: submit }, {}, { store, reconcile });
    await expect(settle(history(hashA))).rejects.toThrow(/permanent failed-record|block conflicts/);
    expect(putOutcome).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  test("rejects another hash retained only in an indeterminate in-process result", async () => {
    const submit = vi.fn(async () => ({ ok: false as const, txHash: hashA, payer, payee, chainId: "demos" }));
    const store = createIdempotencyStore();
    const once = vi.spyOn(store, "once");
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => failed());
    const settle = payDemSettle({ address: payer, settle: submit }, {}, { store, reconcile });
    await expect(settle(request)).resolves.toMatchObject({ ok: false, txHash: hashA });
    await expect(settle(history())).rejects.toThrow(/conflicts with the rail outcome/);
    expect(once).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();
  });

  test("a delayed submit cannot be overtaken by a conflicting history audit", async () => {
    let finish!: () => void;
    let started!: () => void;
    const submitted = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const submit = vi.fn(async () => { started(); await gate; return freshSuccess(); });
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => failed());
    const store = createIdempotencyStore();
    const once = vi.spyOn(store, "once");
    const settle = payDemSettle({ address: payer, settle: submit }, {}, { store, reconcile });
    const fresh = settle(request);
    await submitted;
    const audit = expect(settle(history())).rejects.toThrow(/conflicts with the rail outcome/);
    finish();
    await expect(fresh).resolves.toMatchObject({ txHash: hashA, ok: true });
    await audit;
    expect(reconcile).not.toHaveBeenCalled();
    expect(once).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  test("rechecks the rail log when another bridge finishes during the audit", async () => {
    const log = createInMemorySettlementLog();
    const store = createIdempotencyStore(log);
    const once = vi.spyOn(store, "once");
    const submit = vi.fn();
    const reconcile = vi.fn(async () => {
      // Independent process/store completes A while B's chain read is pending.
      await createIdempotencyStore(log).once("pay-dem:conflicting-native:0", binding, async () => stored(executed()));
      return failed();
    });
    const settle = payDemSettle({ address: payer, settle: submit }, {}, { store, reconcile });
    await expect(settle(history())).rejects.toThrow(/conflicts with the rail outcome/);
    expect(once).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    await expect(store.readOutcome!("pay-dem:conflicting-native:0", binding))
      .resolves.toMatchObject({ txHash: hashA, ok: true });
  });

  test.each(["missing", "undefined", "malformed", "indeterminate", "throws"])("fails closed for a %s outcome lookup", async (mode) => {
    const cause = new Error("lookup timed out");
    const once = vi.fn();
    const readOutcome = vi.fn(async () => {
      if (mode === "throws") throw cause;
      if (mode === "undefined") return undefined;
      if (mode === "indeterminate") return { ...stored(executed()), ok: false, finality: undefined };
      return {};
    });
    const store = { once, ...(mode === "missing" ? {} : { readOutcome }) };
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => failed());
    const submit = vi.fn();
    const settle = payDemSettle({ address: payer, settle: submit }, {}, { store: store as never, reconcile });
    for (const req of [history(), request]) {
      if (mode === "throws") await expect(settle(req)).rejects.toBe(cause);
      else await expect(settle(req)).rejects.toThrow();
    }
    expect(reconcile).not.toHaveBeenCalled();
    expect(once).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});

// These unit tests exercise retained settlement rules with injected capabilities.
vi.mock("../../src/rails/payDemExecutionAuthority.js", async () =>
  import("../support/payDemExecutionAuthority.js"));

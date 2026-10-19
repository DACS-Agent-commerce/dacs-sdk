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
const freshSuccess = () => {
  const { amountOs: _amount, preparedTransfer: _journal, ...result } = executed();
  return result;
};
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
      const submit = vi.fn(async () => {
        const { amountOs: _amount, preparedTransfer: _journal, ...result } = executed();
        return result;
      });
      const reconcile = vi.fn(async () => bExecuted ? executed(hashB) : failed());
      const store = createIdempotencyStore(log);
      const rail = { address: payer, settle: submit };
      const settle = payDemSettle(rail, {}, { store, reconcile });
      await expect(settle(request)).resolves.toMatchObject({ ok: true, txHash: hashA });
      const audit = restart ? payDemSettle(rail, {}, { store: createIdempotencyStore(log), reconcile }) : settle;
      // The bridge's authenticated A, or the rail log's A after a restart,
      // refuses history B before any chain read.
      await expect(audit({ ...request, priorAttempts: [{ txHash: hashB, chainId: "demos", ok: true }] }))
        .rejects.toThrow(/retained transaction conflicts with the rail outcome/);
      expect(reconcile).not.toHaveBeenCalled();
      expect(submit).toHaveBeenCalledTimes(1);
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
      const submit = vi.fn<PayDemRail["settle"]>(async () => {
        if (paid) return freshSuccess();
        const { amountOs: _amount, preparedTransfer: _journal, ...result } = failed(hashA);
        return result;
      });
      const reconcile = vi.fn<PayDemSettlementReconcile>(async () => failed());
      const rail = { address: payer, settle: submit };
      const settle = payDemSettle(rail, {}, { store, reconcile });
      await settle(request);
      expect(claimIntent).toHaveBeenCalledTimes(1);
      expect(putOutcome).toHaveBeenCalledTimes(1);
      claimIntent.mockClear();
      putOutcome.mockClear();
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
    const submit = vi.fn();
    const reconcile = vi.fn(async () => executed());
    const settle = payDemSettle({ address: payer, settle: submit }, {}, { store, reconcile });
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
    const store = createIdempotencyStore(log);
    await store.once("pay-dem:conflicting-native:0", binding, async () => stored(failed(hashA)));
    putOutcome.mockClear();
    const reply = change === "success" ? executed() : {
      ...failed(hashA), ...(change === "block" ? { blockNumber: 43 } : {}),
      failureProof: { ...failed(hashA).failureProof, ...(change === "block" ? { blockNumber: 43 } : { nonce: 10 }) },
      // A journal that agrees with the reply: the conflict is with the stored proof.
      ...(change === "nonce" ? { preparedTransfer: journal(hashA, 10) } : {}),
    };
    const submit = vi.fn();
    const reconcile = vi.fn(async () => reply);
    const settle = payDemSettle({ address: payer, settle: submit }, {}, { store, reconcile });
    await expect(settle(history(hashA, false))).rejects.toThrow(message);
    expect(putOutcome).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  test.each([true, false])("keeps a stored permanent failure that reconciliation presents with other fee fields (history=%s)", async (withHistory) => {
    const log = createInMemorySettlementLog();
    const store = createIdempotencyStore(log);
    await store.once("pay-dem:conflicting-native:0", binding, async () => stored(failed(hashA)));
    const putOutcome = vi.spyOn(log, "putOutcome");
    const submit = vi.fn();
    // Same transaction, block and proof; the reconciler also reports the fee.
    const reply = { ...failed(hashA), networkFeeOs: "5" };
    const reconcile = vi.fn(async () => reply);
    const settle = payDemSettle({ address: payer, settle: submit }, {}, { store, reconcile });
    await expect(settle(withHistory ? history(hashA, false) : request)).resolves.toMatchObject({
      ok: false, errorClass: "permanent", txHash: hashA, failureProof: failed(hashA).failureProof,
    });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(putOutcome).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  test("cannot move a durable success to another block", async () => {
    const log = createInMemorySettlementLog();
    const store = createIdempotencyStore(log);
    await store.once("pay-dem:conflicting-native:0", binding, async () => stored(executed()));
    const submit = vi.fn();
    const reconcile = vi.fn(async () => ({ ...executed(), blockNumber: 43 }));
    const settle = payDemSettle({ address: payer, settle: submit }, {}, { store, reconcile });
    await expect(settle(history(hashA))).rejects.toThrow(/block conflicts/);
    expect(submit).not.toHaveBeenCalled();
    await expect(store.readOutcome!("pay-dem:conflicting-native:0", binding))
      .resolves.toEqual(stored(executed()));
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

  test("keeps a success another bridge records for the retained hash during the audit", async () => {
    const log = createInMemorySettlementLog();
    const store = createIdempotencyStore(log);
    const once = vi.spyOn(store, "once");
    const submit = vi.fn();
    const reconcile = vi.fn(async () => {
      // Another process records A executed while this audit's chain read says failed.
      await createIdempotencyStore(log).once("pay-dem:conflicting-native:0", binding, async () => stored(executed()));
      return failed(hashA);
    });
    const settle = payDemSettle({ address: payer, settle: submit }, {}, { store, reconcile });
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
    const submit = vi.fn();
    const settle = payDemSettle({ address: payer, settle: submit }, {}, { store: store as never, reconcile });
    for (const req of [history(), request]) {
      if (message === undefined) await expect(settle(req)).rejects.toBe(cause);
      else await expect(settle(req)).rejects.toThrow(message);
    }
    expect(reconcile).not.toHaveBeenCalled();
    expect(once).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});

// A store whose readOutcome does not wait for its own in-flight once (unlike
// createIdempotencyStore) exposes the bridge's own per-key serialization.
describe("pay-dem serializes calls for one settlement key", () => {
  const unwaitingStore = () => {
    let recorded: SettleResult | null = null;
    return {
      once: vi.fn(async (_key: string, _binding: unknown, run: () => Promise<SettleResult>) => {
        recorded = await run();
        return recorded;
      }),
      readOutcome: vi.fn(async () => recorded),
    };
  };

  test("a conflicting audit waits for a delayed submit even when the store would not", async () => {
    let finish!: () => void;
    let started!: () => void;
    const submitted = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const submit = vi.fn(async () => { started(); await gate; return freshSuccess(); });
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => failed());
    const store = unwaitingStore();
    const settle = payDemSettle({ address: payer, settle: submit }, {}, { store: store as never, reconcile });
    const fresh = settle(request);
    await submitted;
    const audit = expect(settle(history())).rejects.toThrow(/conflicts with the rail outcome/);
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.readOutcome).not.toHaveBeenCalled();
    finish();
    await expect(fresh).resolves.toMatchObject({ txHash: hashA, ok: true });
    await audit;
    expect(reconcile).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  test("a failed earlier audit does not reject the call queued behind it", async () => {
    const cause = new Error("journal read timed out");
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const reconcile = vi.fn<PayDemSettlementReconcile>()
      .mockImplementationOnce(async () => { await gate; throw cause; })
      .mockImplementation(async () => executed());
    const submit = vi.fn();
    const store = unwaitingStore();
    const settle = payDemSettle({ address: payer, settle: submit }, {}, { store: store as never, reconcile });
    const first = expect(settle(history(hashA, false))).rejects.toBe(cause);
    const second = settle(history(hashA, false));
    await new Promise((resolve) => setImmediate(resolve));
    expect(reconcile).toHaveBeenCalledTimes(1);
    finish();
    await first;
    await expect(second).resolves.toMatchObject({ ok: true, txHash: hashA });
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(store.once).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});

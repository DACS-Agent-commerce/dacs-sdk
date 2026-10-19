import { describe, expect, test, vi } from "vitest";

import type { SettleRequest, SettleResult, SettlementRecoveryAttempt } from "../../src/agent/runSessionCore.js";
import { createIdempotencyStore, createInMemorySettlementLog, type SettlementBinding } from "../../src/rails/idempotency.js";
import {
  payDemSettle,
  type PayDemSettlementAuditContext,
  type PayDemSettlementReconcile,
} from "../../src/rails/payDem.js";

type ReconcileContext = Parameters<PayDemSettlementReconcile>[0];

const txHash = "12".repeat(32);
const payer = "ab".repeat(32);
const payee = "cd".repeat(32);
const payeeClaim = `did:demos:agent:${payee}`;
const prior = (ok = true): SettlementRecoveryAttempt => ({ txHash, chainId: "demos", ok });
const request = (priorAttempts: readonly SettlementRecoveryAttempt[] = [prior()]): SettleRequest => ({
  rail: "pay-dem", phase: "pay-dem", phaseIndex: 0, jobId: "retained-native",
  amount: "1", asset: "DEM", payee: payeeClaim, expectedPayee: payeeClaim, priorAttempts,
});
const executed = () => ({
  ok: true as const, txHash, payer, payee, chainId: "demos", amountOs: "1000000000",
  blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" as const },
  networkFeeOs: "0", execution: "executed" as const,
});
const failed = () => ({
  ok: false as const, txHash, payer, payee, chainId: "demos", amountOs: "1000000000",
  blockNumber: 42, txRefKind: "demos", errorClass: "permanent" as const,
  failureProof: { kind: "demos-failed-record" as const, txHash, payer, payee,
    nonce: 9, blockNumber: 42, amountOs: "1000000000" },
});

function fixture(reconcile?: PayDemSettlementReconcile) {
  const store = createIdempotencyStore();
  const once = vi.spyOn(store, "once");
  const submit = vi.fn(async () => { throw new Error("must never submit a retained transfer"); });
  const settle = payDemSettle({ address: payer, settle: submit }, {}, { store, reconcile });
  return { settle, once, submit };
}

describe("pay-dem retained transaction recovery is read-only even with an empty rail log", () => {
  test.each([true, false].flatMap((ok) => ["executed", "failed"].map((outcome) => ({ ok, outcome }))))(
    "audits prior ok=$ok as $outcome on repeat and restart without claiming an effect",
    async ({ ok, outcome }) => {
      const reconcile = vi.fn(async (context: ReconcileContext) => {
        expect(context).toEqual({ railId: "pay-dem", jobId: "retained-native", phaseIndex: 0,
          settlementKey: "pay-dem:retained-native:0", network: "demos", payer, payee,
          amountOs: "1000000000", txHash });
        expect(Object.isFrozen(context)).toBe(true);
        return outcome === "executed" ? executed() : failed();
      });
      const first = fixture(reconcile);
      const restarted = fixture(reconcile);
      for (const f of [first, first, restarted]) {
        // History ok=true is the session's claim under audit: a bound failed
        // record for the retained hash is still a permanent failure (DEM-4).
        const result = await f.settle(request([prior(false), prior(ok)]));
        expect(result).toMatchObject(outcome === "executed"
          ? { ok: true, txHash, payee: payeeClaim }
          : { ok: false, errorClass: "permanent", failureProof: failed().failureProof, txHash, payee: payeeClaim });
        expect(result).not.toHaveProperty("execution");
        expect(result).not.toHaveProperty("amountOs");
        expect(Object.isFrozen(result)).toBe(true);
        if (result.ok) expect(Object.isFrozen(result.finality)).toBe(true);
        else expect(result).not.toHaveProperty("finality");
        expect(f.once).not.toHaveBeenCalled();
        expect(f.submit).not.toHaveBeenCalled();
      }
      expect(reconcile).toHaveBeenCalledTimes(3);
    },
  );

  test.each([true, false])("requires a reconciler for retained ok=%s before touching the log", async (ok) => {
    const f = fixture();
    await expect(f.settle(request([prior(ok)]))).rejects.toThrow(/requires read-only reconciliation/);
    expect(f.once).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  test("audits the canonical hash on a configured network at the history limit", async () => {
    const network = "demos:testnet";
    const f = fixture();
    const reconcile = vi.fn(async (context: ReconcileContext) => {
      expect(context).toMatchObject({ txHash, network });
      return { ...executed(), chainId: network };
    });
    const settle = payDemSettle({ address: payer, settle: f.submit }, { network },
      { store: { once: f.once, readOutcome: async () => null }, reconcile });
    const history = Array.from({ length: 256 }, () => ({
      ...prior(), chainId: network, txHash: `0x${txHash.toUpperCase()}`,
    }));
    await expect(settle(request(history))).resolves.toMatchObject({ txHash, chainId: network });
    expect(f.once).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  const bindsTuple = /does not bind the exact pay-dem network, payer, and payee/;
  test.each([
    ["missing journal", undefined], ["conflicting journal hash", undefined],
    ["conflicting journal nonce", undefined], ["timeout", undefined],
    ["absence", /contradicts reconciliation proof of absence/],
    ["wrong hash", /does not match the retained transaction/],
    ["wrong network", bindsTuple], ["wrong payer", bindsTuple], ["wrong payee", bindsTuple],
    ["wrong amount", /does not bind the exact requested OS amount/],
    ["missing execution", /does not attest that the transaction record shows the transfer executed/],
    ["indeterminate", /reconciliation is indeterminate/],
    ["malformed", /pay-dem reconciliation result/],
    ["invalid failure proof", /invalid terminal-failure proof/],
  ] as const)("withholds recovery for %s without a new submit generation", async (reply, message) => {
    const originalCause = new Error(reply);
    const reconcile = vi.fn(async (context: PayDemSettlementAuditContext) => {
      // The application's journal is authoritative for the original signed
      // nonce. A lost/contradictory journal cannot be reconstructed from inclusion.
      if (reply.includes("journal") || reply === "timeout") throw originalCause;
      if (reply === "absence") return null;
      if (reply === "malformed") return undefined;
      if (reply === "indeterminate") {
        const { finality: _finality, execution: _execution, ...observation } = executed();
        return { ...observation, ok: false };
      }
      if (reply === "invalid failure proof") return { ...failed(), failureProof: { ...failed().failureProof, nonce: -1 } };
      const result: Record<string, unknown> = { ...executed() };
      if (reply === "wrong hash") result.txHash = "34".repeat(32);
      if (reply === "wrong network") result.chainId = "demos:other";
      if (reply === "wrong payer") result.payer = "ef".repeat(32);
      if (reply === "wrong payee") result.payee = "ef".repeat(32);
      if (reply === "wrong amount") result.amountOs = "1000000001";
      if (reply === "missing execution") delete result.execution;
      expect(context.txHash).toBe(txHash);
      return result;
    }) as unknown as PayDemSettlementReconcile;
    const f = fixture(reconcile);
    const req = request();
    const before = structuredClone(req);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const pending = expect(f.settle(req)).rejects;
      if (message === undefined) await pending.toBe(originalCause);
      else await pending.toThrow(message);
    }
    expect(req).toEqual(before);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(f.once).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  const count = /must contain 1–256 transaction attempts/;
  const identity = /invalid transaction identity or network/;
  test.each([
    [null, count], [{}, count], [[], count], [[null], /malformed attempt/],
    [[prior(), { ...prior(), txHash: "34".repeat(32) }], /conflicting native transactions/],
    [[{ ...prior(), chainId: "demos:other" }, prior()], identity], [[{ ...prior(), ok: "true" }], identity],
    [[{ ...prior(), txHash: "" }], identity], [[{ ...prior(), txHash: "invalid" }], identity],
    [[{ ...prior(), extra: true }], identity], [Array(1), /pay-dem recovery history/],
    [Array.from({ length: 257 }, () => prior()), count],
  ])("rejects malformed or conflicting history %# before reconciliation or submission", async (history, message) => {
    const reconcile = vi.fn(async () => executed());
    const f = fixture(reconcile);
    await expect(f.settle(request(history as readonly SettlementRecoveryAttempt[]))).rejects.toThrow(message);
    expect(reconcile).not.toHaveBeenCalled();
    expect(f.once).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  test("captures history before an asynchronous audit and binds the captured hash", async () => {
    const attempt = prior();
    const history = [attempt];
    const f = fixture(async () => {
      attempt.txHash = "34".repeat(32);
      return { ...executed(), txHash: attempt.txHash };
    });
    await expect(f.settle(request(history))).rejects.toThrow(/does not match the retained transaction/);
    expect(f.once).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  test("does not invoke history accessors", async () => {
    let reads = 0;
    const req = request();
    Object.defineProperty(req, "priorAttempts", { get() { reads += 1; return [prior()]; } });
    const f = fixture(async () => executed());
    await expect(f.settle(req)).rejects.toThrow(/must be stable data/);
    expect(reads).toBe(0);
    expect(f.once).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  test.each(["executed", "missing journal"])("history omission after %s cannot restore submit authority", async (reply) => {
    const reconcile = vi.fn(async () => {
      if (reply === "missing journal") throw new Error(reply);
      return executed();
    });
    const f = fixture(reconcile);
    const { priorAttempts: _history, ...withoutHistory } = request();
    for (const req of [request(), withoutHistory]) {
      if (reply === "missing journal") await expect(f.settle(req)).rejects.toThrow(reply);
      else await expect(f.settle(req)).resolves.toMatchObject({ ok: true, txHash });
    }
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(f.once).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
    for (const req of [{ ...withoutHistory, amount: "2" },
      request([{ ...prior(), txHash: "34".repeat(32) }])]) {
      await expect(f.settle(req)).rejects.toThrow(/retained (?:audit|intent\/outcome) belongs to different/);
    }
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(f.once).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  test("an in-process authenticated success is rechecked by a later audit but never demoted", async () => {
    const submit = vi.fn(async () => {
      const { amountOs: _amount, ...result } = executed();
      return result;
    });
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => failed());
    const store = createIdempotencyStore();
    const once = vi.spyOn(store, "once");
    const settle = payDemSettle({ address: payer, settle: submit }, {}, { store, reconcile });
    const { priorAttempts: _history, ...fresh } = request();
    await expect(settle(fresh)).resolves.toMatchObject({ ok: true });
    for (const req of [request([prior(false)]), request(), fresh]) {
      await expect(settle(req)).rejects.toThrow(/contradicted an authenticated successful outcome/);
    }
    // The contradiction was not recorded: a confirming audit still reports A paid.
    reconcile.mockImplementation(async () => executed());
    await expect(settle(fresh)).resolves.toMatchObject({ ok: true, txHash, blockNumber: 42 });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(once).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(4);
  });
});

// DACS-4 §9.5.1 PC-7: once the rail or its log recorded a final payment, a
// later observation may fail to confirm it but can never report it unpaid.
// Every read path refuses the demotion and keeps the recorded success. The
// session's history is the claim an audit checks, not such a record.
describe("pay-dem never reports a recorded success as a permanent failure", () => {
  const key = "pay-dem:retained-native:0";
  const binding: SettlementBinding = {
    bindingVersion: "1", railId: "pay-dem", jobId: "retained-native", phaseIndex: 0,
    phase: "pay-dem", amount: "1000000000", agreementAsset: "DEM", settlementAsset: "DEM",
    payer, payee, network: "demos", finality: { model: "bft-final" },
  };
  const { amountOs: _amount, execution: _execution, ...storedSuccess } = executed();
  const demoted = /contradicted an authenticated successful outcome/;

  test("reports a bound failure for a session-claimed success and keeps it after history is omitted", async () => {
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => failed());
    const f = fixture(reconcile);
    const { priorAttempts: _history, ...withoutHistory } = request();
    // A rail before the execution gate saved inclusion alone as success; the
    // bound failed record for that hash proves it never settled (DEM-4).
    for (const req of [request([prior(true)]), request([prior(false)]), withoutHistory]) {
      await expect(f.settle(req)).resolves.toMatchObject({ ok: false, errorClass: "permanent", txHash,
        payee: payeeClaim, failureProof: failed().failureProof });
    }
    expect(reconcile).toHaveBeenCalledTimes(3);
    expect(f.once).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
    // The proven failure is terminal for this bridge: a later success read contradicts it.
    reconcile.mockImplementation(async () => executed());
    await expect(f.settle(request([prior(true)]))).rejects.toThrow(/contradicted a permanent failed-record outcome/);
    expect(reconcile).toHaveBeenCalledTimes(4);
    expect(f.submit).not.toHaveBeenCalled();
  });

  test.each([false, true])("keeps a durable success on restart (history=%s)", async (withHistory) => {
    const log = createInMemorySettlementLog();
    await createIdempotencyStore(log).once(key, binding, async () => storedSuccess as SettleResult);
    const claimIntent = vi.spyOn(log, "claimIntent");
    const putOutcome = vi.spyOn(log, "putOutcome");
    const store = createIdempotencyStore(log);
    const submit = vi.fn();
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => failed());
    const settle = payDemSettle({ address: payer, settle: submit }, {}, { store, reconcile });
    const { priorAttempts: _history, ...withoutHistory } = request();
    await expect(settle(withHistory ? request([prior(false)]) : withoutHistory)).rejects.toThrow(demoted);
    expect(putOutcome).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(claimIntent).toHaveBeenCalledTimes(withHistory ? 0 : 1);
    await expect(store.readOutcome!(key, binding)).resolves.toEqual(storedSuccess);
  });

  test("an expired lease after a lost outcome write cannot demote this bridge's success", async () => {
    const log = createInMemorySettlementLog();
    const lost = new Error("outcome write lost");
    const putOutcome = vi.spyOn(log, "putOutcome").mockRejectedValueOnce(lost);
    let now = 1_000;
    const store = createIdempotencyStore(log, { now: () => now, leaseDurationMs: 1_000 });
    const submit = vi.fn(async () => ({ ...storedSuccess, execution: "executed" as const }));
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => failed());
    const settle = payDemSettle({ address: payer, settle: submit }, {}, { store, reconcile });
    const { priorAttempts: _history, ...fresh } = request();
    await expect(settle(fresh)).rejects.toBe(lost);
    now += 2_000;
    await expect(settle(fresh)).rejects.toThrow(demoted);
    expect(putOutcome).toHaveBeenCalledTimes(1);
    reconcile.mockImplementation(async () => executed());
    now += 2_000;
    await expect(settle(fresh)).resolves.toMatchObject({ ok: true, txHash });
    await expect(store.readOutcome!(key, binding)).resolves.toEqual(storedSuccess);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  test("another writer's cached failure cannot demote this bridge's success", async () => {
    const log = createInMemorySettlementLog();
    let now = 1_000;
    const options = { now: () => now, leaseDurationMs: 1_000 };
    let finish!: () => void;
    let started!: () => void;
    const submitted = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const submit = vi.fn(async () => {
      started();
      await gate;
      return { ...storedSuccess, execution: "executed" as const };
    });
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => failed());
    const settle = payDemSettle({ address: payer, settle: submit },
      {}, { store: createIdempotencyStore(log, { ...options, owner: "a" }), reconcile });
    const { priorAttempts: _history, ...fresh } = request();
    const slow = settle(fresh);
    await submitted;
    // The lease expires and another process records its reconciled failure.
    now += 2_000;
    const other = payDemSettle({ address: payer, settle: vi.fn() },
      {}, { store: createIdempotencyStore(log, { ...options, owner: "b" }), reconcile });
    await expect(other(fresh)).resolves.toMatchObject({ ok: false, errorClass: "permanent" });
    finish();
    await expect(slow).rejects.toThrow(/outcome conflicts/);
    await expect(settle(fresh)).rejects.toThrow(demoted);
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, test, vi } from "vitest";

import type { SettleRequest, SettlementRecoveryAttempt } from "../../src/agent/runSessionCore.js";
import * as canonicalSnapshot from "../../src/canonical/snapshot.js";
import { createIdempotencyStore } from "../../src/rails/idempotency.js";
import {
  payDemSettle,
  type PayDemSettlementReconcile,
  type PayDemSettlementRecoveryContext,
} from "../../src/rails/payDem.js";

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
      const reconcile = vi.fn(async (context: PayDemSettlementRecoveryContext) => {
        expect(context).toEqual({ railId: "pay-dem", jobId: "retained-native", phaseIndex: 0,
          settlementKey: "pay-dem:retained-native:0", network: "demos", payer, payee,
          amountOs: "1000000000", txHash });
        expect(Object.isFrozen(context)).toBe(true);
        return outcome === "executed" ? executed() : failed();
      });
      const first = fixture(reconcile);
      const restarted = fixture(reconcile);
      for (const f of [first, first, restarted]) {
        const result = await f.settle(request([prior(false), prior(ok)]));
        expect(result).toMatchObject({ ok: outcome === "executed", txHash, payee: payeeClaim });
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
    const reconcile = vi.fn(async (context: PayDemSettlementRecoveryContext) => {
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

  test.each([
    "missing journal", "conflicting journal hash", "conflicting journal nonce", "timeout", "absence",
    "wrong hash", "wrong network", "wrong payer", "wrong payee", "wrong amount", "missing execution",
    "indeterminate", "malformed", "invalid failure proof",
  ])("withholds recovery for %s without a new submit generation", async (reply) => {
    const originalCause = new Error(reply);
    const reconcile = vi.fn(async (context: PayDemSettlementRecoveryContext) => {
      // The application's journal is authoritative for the original signed
      // nonce. A lost/contradictory journal cannot be reconstructed from inclusion.
      if (reply.includes("journal") || reply === "timeout") throw originalCause;
      if (reply === "absence") return null;
      if (reply === "malformed") return undefined;
      if (reply === "indeterminate") return { ...executed(), ok: false, finality: undefined, execution: undefined };
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
      if (reply.includes("journal") || reply === "timeout") await pending.toBe(originalCause);
      else await pending.toThrow();
    }
    expect(req).toEqual(before);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(f.once).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  test.each([
    null, {}, [], [null], [prior(), { ...prior(), txHash: "34".repeat(32) }],
    [{ ...prior(), chainId: "demos:other" }, prior()], [{ ...prior(), ok: "true" }],
    [{ ...prior(), txHash: "" }], [{ ...prior(), txHash: "invalid" }],
    [{ ...prior(), extra: true }], Array(1), Array.from({ length: 257 }, () => prior()),
  ])("rejects malformed or conflicting history %# before reconciliation or submission", async (history) => {
    const reconcile = vi.fn(async () => executed());
    const f = fixture(reconcile);
    await expect(f.settle(request(history as readonly SettlementRecoveryAttempt[]))).rejects.toThrow();
    expect(reconcile).not.toHaveBeenCalled();
    expect(f.once).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  test.each(["extra", "txHash", "chainId"])("rejects oversized history %s before taking a snapshot", async (field) => {
    const history = [{ ...prior(), [field]: "x".repeat(1024 * 1024) }];
    const capture = vi.spyOn(canonicalSnapshot, "snapshotCanonicalJsonRead");
    try {
      const f = fixture(async () => executed());
      await expect(f.settle(request(history))).rejects.toThrow();
      expect(capture).not.toHaveBeenCalledWith(history, "pay-dem recovery history");
      expect(f.once).not.toHaveBeenCalled();
      expect(f.submit).not.toHaveBeenCalled();
    } finally {
      capture.mockRestore();
    }
  });

  test("bounds rejected audit keys and refuses new keys with omitted history at capacity", async () => {
    const f = fixture(async () => { throw new Error("missing journal"); });
    for (let i = 0; i < 1024; i += 1) {
      await expect(f.settle({ ...request(), jobId: `rejected-${i}` })).rejects.toThrow("missing journal");
    }
    const rejected = { ...request(), jobId: "over-capacity" };
    await expect(f.settle(rejected)).rejects.toThrow(/audit capacity/);
    const { priorAttempts: _history, ...withoutHistory } = rejected;
    await expect(f.settle(withoutHistory)).rejects.toThrow(/audit capacity/);
    await expect(f.settle({ ...request(), jobId: "rejected-0" })).rejects.toThrow("missing journal");
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

  test("an in-process authenticated result cannot bypass a later read-only audit", async () => {
    const submit = vi.fn(async () => {
      const { amountOs: _amount, ...result } = executed();
      return result;
    });
    const reconcile = vi.fn(async () => failed());
    const store = createIdempotencyStore();
    const once = vi.spyOn(store, "once");
    const settle = payDemSettle({ address: payer, settle: submit }, {}, { store, reconcile });
    const { priorAttempts: _history, ...fresh } = request();
    await expect(settle(fresh)).resolves.toMatchObject({ ok: true });
    await expect(settle(request())).rejects.toThrow(/contradicted a permanent/);
    await expect(settle(request())).rejects.toThrow(/contradicted a permanent/);
    await expect(settle(fresh)).rejects.toThrow(/contradicted a permanent/);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(once).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(3);
  });
});

// These unit tests exercise retained settlement rules with injected capabilities.
vi.mock("../../src/rails/payDemExecutionAuthority.js", async () =>
  import("../support/payDemExecutionAuthority.js"));

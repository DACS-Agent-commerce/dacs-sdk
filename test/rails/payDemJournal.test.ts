import { describe, expect, test, vi } from "vitest";

import type { SettleRequest } from "../../src/agent/runSessionCore.js";
import { createIdempotencyStore } from "../../src/rails/idempotency.js";
import {
  payDemSettle,
  type PayDemPreparedTransfer,
  type PayDemRail,
  type PayDemSettlementAuditContext,
  type PayDemSettlementReconcile,
} from "../../src/rails/payDem.js";

const hashA = "56".repeat(32);
const hashB = "78".repeat(32);
const payer = "ab".repeat(32);
const payee = "cd".repeat(32);
const claim = `did:demos:agent:${payee}`;
const request = (jobId: string, phaseIndex = 0, txHash?: string, ok = true): SettleRequest => ({
  rail: "pay-dem", phase: "pay-dem", phaseIndex, jobId, amount: "1", asset: "DEM",
  payee: claim, expectedPayee: claim,
  ...(txHash === undefined ? {} : { priorAttempts: [{ txHash, chainId: "demos", ok }] }),
});
const executed = (txHash: string) => ({
  ok: true as const, txHash, payer, payee, chainId: "demos", amountOs: "1000000000",
  blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" as const },
  execution: "executed" as const,
});
const failed = (txHash: string, nonce: number) => ({
  ok: false as const, txHash, payer, payee, chainId: "demos", amountOs: "1000000000",
  blockNumber: 42, txRefKind: "demos", errorClass: "permanent" as const,
  failureProof: { kind: "demos-failed-record" as const, txHash, payer, payee,
    nonce, blockNumber: 42, amountOs: "1000000000" },
});

/**
 * Two jobs pay the same payee the same amount through the bridge. The rail
 * journals each prepared transfer the way `createPayDemRail` does, with the
 * recovery tuple the bridge passed it, keyed by hash.
 */
function journaledPayments() {
  const journal = new Map<string, PayDemPreparedTransfer>();
  const hashes = [hashA, hashB];
  let nonce = 7;
  const rail: PayDemRail = {
    address: payer,
    settle: vi.fn(async (params) => {
      const txHash = hashes.shift()!;
      journal.set(txHash, Object.freeze({
        txHash, nonce: nonce++, payer, payee, amountOs: params.amount, denomination: "os" as const,
        network: params.network ?? "demos", recovery: params.recovery!,
      }));
      const { amountOs: _amount, ...result } = executed(txHash);
      return result;
    }),
  };
  return { journal, rail };
}

function auditor(reconcile: PayDemSettlementReconcile) {
  const store = createIdempotencyStore();
  const once = vi.spyOn(store, "once");
  const submit = vi.fn(async () => { throw new Error("must never submit a retained transfer"); });
  const settle = payDemSettle({ address: payer, settle: submit }, {}, { store, reconcile });
  return { settle, once, submit };
}

// DACS-4 §9.5.1 PC-7: recovery checks rail state by the original binding and
// transaction reference. A reconciler that looks a hash up on chain alone
// cannot tell job A's transfer from job B's, so an audit counts the retained
// hash only through the journal entry that tied it to this exact payment.
describe("pay-dem audits count a retained hash only through its prepared-transfer journal", () => {
  test("refuses another job's transfer of the same payer, payee and amount", async () => {
    const { journal, rail } = journaledPayments();
    const fresh = payDemSettle(rail, {}, { store: createIdempotencyStore() });
    await expect(fresh(request("job-a"))).resolves.toMatchObject({ ok: true, txHash: hashA });
    await expect(fresh(request("job-b"))).resolves.toMatchObject({ ok: true, txHash: hashB });
    expect(rail.settle).toHaveBeenCalledTimes(2);

    // A reconciler that keys everything by hash returns job A's journal entry.
    const byHash = vi.fn(async (context: PayDemSettlementAuditContext) => ({
      ...executed(context.txHash), preparedTransfer: journal.get(context.txHash),
    })) as unknown as PayDemSettlementReconcile;
    const f = auditor(byHash);
    // Job B's session restored with job A's hash.
    await expect(f.settle(request("job-b", 0, hashA)))
      .rejects.toThrow(/journal does not bind the retained transaction to this exact payment/);
    // Each job's own hash audits as paid.
    await expect(f.settle(request("job-a", 0, hashA))).resolves.toMatchObject({ ok: true, txHash: hashA });
    await expect(auditor(byHash).settle(request("job-b", 0, hashB)))
      .resolves.toMatchObject({ ok: true, txHash: hashB });
    expect(f.once).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
    expect(rail.settle).toHaveBeenCalledTimes(2);
  });

  test("refuses an audit whose reconciler returns no journal entry", async () => {
    const reconcile = vi.fn(async (context: PayDemSettlementAuditContext) =>
      executed(context.txHash)) as unknown as PayDemSettlementReconcile;
    for (const ok of [true, false]) {
      const f = auditor(reconcile);
      await expect(f.settle(request("job-b", 0, hashA, ok)))
        .rejects.toThrow(/must return the prepared-transfer journal entry/);
      expect(f.once).not.toHaveBeenCalled();
      expect(f.submit).not.toHaveBeenCalled();
    }
  });

  const recovery = {
    railId: "pay-dem", jobId: "job-a", phaseIndex: 0, settlementKey: "pay-dem:job-a:0",
    network: "demos", payer, payee, amountOs: "1000000000",
  };
  const entry = (over: Record<string, unknown> = {}) => ({
    txHash: hashA, nonce: 9, payer, payee, amountOs: "1000000000", denomination: "os",
    network: "demos", recovery, ...over,
  });
  const binds = /journal does not bind the retained transaction to this exact payment/;
  test.each([
    ["another phase", entry({ recovery: { ...recovery, phaseIndex: 1, settlementKey: "pay-dem:job-a:1" } })],
    ["another rail", entry({ recovery: { ...recovery, railId: "other", settlementKey: "other:job-a:0" } })],
    ["another settlement key", entry({ recovery: { ...recovery, settlementKey: "pay-dem:job-b:0" } })],
    ["another hash", entry({ txHash: hashB })],
    ["another amount", entry({ amountOs: "2000000000" })],
    ["another payee", entry({ payee: "ef".repeat(32) })],
    ["another payer", entry({ payer: "ef".repeat(32) })],
    ["another network", entry({ network: "demos:testnet" })],
    ["no recovery tuple", (({ recovery: _recovery, ...rest }) => rest)(entry())],
    ["a null recovery tuple", entry({ recovery: null })],
    ["an extra recovery field", entry({ recovery: { ...recovery, extra: 1 } })],
    ["an extra entry field", entry({ signedBytes: "00" })],
    ["a negative nonce", entry({ nonce: -1 })],
    ["a string nonce", entry({ nonce: "9" })],
    ["an unknown denomination", entry({ denomination: "invalid" })],
    ["a non-canonical debit ceiling", entry({ maxTotalDebitOs: "01000001000" })],
    ["a debit ceiling below the amount", entry({ maxTotalDebitOs: "999999999" })],
    ["a numeric confirmed debit", entry({ confirmedTotalDebitOs: 1000001000 })],
    ["a confirmed debit below the amount", entry({ confirmedTotalDebitOs: "999999999" })],
    ["a confirmed debit above the ceiling",
      entry({ maxTotalDebitOs: "1000001000", confirmedTotalDebitOs: "1000002000" })],
    ["a non-object", "journal"],
    ["a null entry", null],
  ])("refuses a journal entry with %s", async (_case, preparedTransfer) => {
    const reconcile = vi.fn(async () => ({ ...executed(hashA), preparedTransfer })) as unknown as PayDemSettlementReconcile;
    const f = auditor(reconcile);
    await expect(f.settle(request("job-a", 0, hashA))).rejects.toThrow(
      preparedTransfer === "journal" || preparedTransfer === null
        ? /must return the prepared-transfer journal entry/
        : binds,
    );
    expect(f.once).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  // A funded rail journals nonce 0 for a wallet's first transfer, and both
  // debit bounds (`createPayDemRail` with `maxTotalDebitOs`).
  test.each([
    ["nonce 0 and both debit bounds",
      { nonce: 0, maxTotalDebitOs: "1000002000", confirmedTotalDebitOs: "1000001000" }],
    ["a pre-fork denomination and a confirmed debit equal to the ceiling",
      { denomination: "dem", maxTotalDebitOs: "1000001000", confirmedTotalDebitOs: "1000001000" }],
    ["zero-fee debit bounds equal to the amount",
      { maxTotalDebitOs: "1000000000", confirmedTotalDebitOs: "1000000000" }],
    ["only a confirmed debit", { confirmedTotalDebitOs: "1000001000" }],
    ["only a debit ceiling", { maxTotalDebitOs: "1000001000" }],
    ["no optional fields", { denomination: undefined }],
  ])("accepts the entry a rail journals with %s", async (_case, over) => {
    const preparedTransfer = JSON.parse(JSON.stringify(entry(over))) as PayDemPreparedTransfer;
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => ({ ...executed(hashA), preparedTransfer }));
    const f = auditor(reconcile);
    await expect(f.settle(request("job-a", 0, hashA))).resolves.toMatchObject({ ok: true, txHash: hashA });
    expect(f.once).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  test("binds a permanent failure's proof to the journaled signed nonce", async () => {
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => ({ ...failed(hashA, 10),
      preparedTransfer: entry() as PayDemPreparedTransfer }));
    const f = auditor(reconcile);
    await expect(f.settle(request("job-a", 0, hashA, false)))
      .rejects.toThrow(/does not match the journaled signed nonce/);
    reconcile.mockImplementation(async () => ({ ...failed(hashA, 9),
      preparedTransfer: entry() as PayDemPreparedTransfer }));
    await expect(f.settle(request("job-a", 0, hashA, false)))
      .resolves.toMatchObject({ ok: false, errorClass: "permanent", txHash: hashA });
    expect(f.once).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  // A rail configured without a journal still leaves the bridge's own record:
  // the rail-log outcome under this exact settlement key and terms, or the
  // result this bridge authenticated. That record, never the session's hash,
  // ties the retained hash to the payment.
  const unjournaledRail = (): PayDemRail => ({
    address: payer,
    settle: vi.fn(async () => {
      const { amountOs: _amount, ...result } = executed(hashA);
      return result;
    }),
  });
  const honest = () => vi.fn(async (context: PayDemSettlementAuditContext) =>
    executed(context.txHash)) as unknown as PayDemSettlementReconcile;

  test("audits a journal-less payment through the rail log that recorded it", async () => {
    const store = createIdempotencyStore();
    const rail = unjournaledRail();
    const reconcile = honest();
    await expect(payDemSettle(rail, {}, { store, reconcile })(request("job-a")))
      .resolves.toMatchObject({ ok: true, txHash: hashA });
    const once = vi.spyOn(store, "once");
    // A restarted bridge has only the rail log.
    await expect(payDemSettle(rail, {}, { store, reconcile })(request("job-a", 0, hashA)))
      .resolves.toMatchObject({ ok: true, txHash: hashA, blockNumber: 42 });
    // Job B's rail log has no record of job A's hash.
    await expect(payDemSettle(rail, {}, { store, reconcile })(request("job-b", 0, hashA)))
      .rejects.toThrow(/must return the prepared-transfer journal entry/);
    // A supplied entry is still checked.
    const mismatched = vi.fn(async () => ({ ...executed(hashA),
      preparedTransfer: entry({ payee: "ef".repeat(32) }) })) as unknown as PayDemSettlementReconcile;
    await expect(payDemSettle(rail, {}, { store, reconcile: mismatched })(request("job-a", 0, hashA)))
      .rejects.toThrow(binds);
    expect(once).not.toHaveBeenCalled();
    expect(rail.settle).toHaveBeenCalledTimes(1);
  });

  test("audits a journal-less payment this bridge authenticated", async () => {
    const inner = createIdempotencyStore();
    // A rail log that cannot show the outcome: only the bridge's own result binds.
    const store = { once: inner.once.bind(inner), readOutcome: vi.fn(async () => null) };
    const rail = unjournaledRail();
    const settle = payDemSettle(rail, {}, { store, reconcile: honest() });
    await expect(settle(request("job-a"))).resolves.toMatchObject({ ok: true, txHash: hashA });
    await expect(settle(request("job-a", 0, hashA))).resolves.toMatchObject({ ok: true, txHash: hashA });
    expect(store.readOutcome).toHaveBeenCalledTimes(2);
    // Without that result, the journal entry is required.
    await expect(payDemSettle(rail, {}, { store, reconcile: honest() })(request("job-a", 0, hashA)))
      .rejects.toThrow(/must return the prepared-transfer journal entry/);
    expect(rail.settle).toHaveBeenCalledTimes(1);
  });

  test("checks a journal entry a restart reconciliation supplies, and never persists it", async () => {
    const store = createIdempotencyStore();
    const submit = vi.fn(async () => {
      const { amountOs: _amount, ...result } = executed(hashA);
      return result;
    });
    await payDemSettle({ address: payer, settle: submit }, {}, { store })(request("job-a"));
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => ({ ...executed(hashA),
      preparedTransfer: entry({ recovery: { ...recovery, jobId: "job-b", settlementKey: "pay-dem:job-b:0" } }) as PayDemPreparedTransfer }));
    const restarted = payDemSettle({ address: payer, settle: submit }, {}, { store, reconcile });
    await expect(restarted(request("job-a"))).rejects.toThrow(binds);
    reconcile.mockImplementation(async () => ({ ...executed(hashA), preparedTransfer: entry() as PayDemPreparedTransfer }));
    const result = await restarted(request("job-a"));
    expect(result).toMatchObject({ ok: true, txHash: hashA });
    expect(result).not.toHaveProperty("preparedTransfer");
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

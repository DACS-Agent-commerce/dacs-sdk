import { beforeEach, describe, expect, test, vi } from "vitest";

import type { SettleRequest, SettleResult } from "../../src/agent/runSessionCore.js";
import {
  createIdempotencyStore,
  type SettlementBinding,
  type SettlementIdempotencyStore,
  type SettlementReconcile,
} from "../../src/rails/idempotency.js";
import {
  payDemSettle,
  type PayDemPreparedTransfer,
  type PayDemRail,
  type PayDemSettlementAuditContext,
  type PayDemSettlementReconcile,
} from "../../src/rails/payDem.js";
import {
  demosNode, resetDemosNode, sdkAuditRail, sdkRail, sdkTransfers, serveNodeRecord, setNodeRecordStatus,
} from "../fixtures/demosNodeMock.js";
import { sdkFences } from "../fixtures/sdkFences.js";

vi.mock("@kynesyslabs/demosdk/websdk", async () => (await import("../fixtures/demosNodeMock.js")).demosSdkModule());

const hashA = "56".repeat(32);
const hashB = "78".repeat(32);
const payer = "ab".repeat(32);
const payee = "cd".repeat(32);
// The node signs hash A at nonce 7, then hash B at nonce 8, and includes both
// at block 42: the SDK's own rail reads those records, so its verdicts are final.
beforeEach(() => resetDemosNode({ payer, txHash: hashA, laterTxHashes: [hashB], nonce: 7 }));
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
 * Two jobs pay the same payee the same amount through the bridge. The SDK rail
 * journals each prepared transfer before its broadcast, with the recovery
 * tuple the bridge passed it, keyed by hash.
 */
async function journaledPayments() {
  const journal = new Map<string, PayDemPreparedTransfer>();
  const rail: PayDemRail = await sdkRail({
    journalPreparedTransfer: async (prepared) => { journal.set(prepared.txHash, prepared); },
  });
  return { journal, rail };
}

async function auditor(
  reconcile: PayDemSettlementReconcile,
  store: SettlementIdempotencyStore = createIdempotencyStore(),
) {
  const once = vi.spyOn(store, "once");
  const { rail, submit } = await sdkAuditRail();
  const settle = payDemSettle(rail, {}, { store, reconcile });
  return { settle, once, submit };
}

/** The rail log of a bridge that settled job A with `outcome`: the SDK's own record of hash A for job A. */
async function settledJobA(outcome: ReturnType<typeof executed> | ReturnType<typeof failed> = executed(hashA)) {
  const store = createIdempotencyStore();
  // The node signs hash A at the outcome's nonce and records it as the outcome says.
  if (!outcome.ok) {
    resetDemosNode({ payer, txHash: hashA, nonce: outcome.failureProof.nonce, recordStatus: "failed" });
  }
  await payDemSettle(await sdkRail(), {}, { store })(request("job-a"));
  return store;
}

// DACS-4 §9.5.1 PC-7: recovery checks rail state by the original binding and
// transaction reference. A reconciler that looks a hash up on chain alone
// cannot tell job A's transfer from job B's, and the journal entry it returns
// is its own object, not the one the rail wrote before broadcast. An audit
// therefore counts the retained hash only through the SDK's own record for
// this key, and refuses a supplied entry that does not bind this payment.
describe("pay-dem audits count a retained hash only through the SDK's record and check its journal entry", () => {
  test("refuses another job's transfer of the same payer, payee and amount", async () => {
    const { journal, rail } = await journaledPayments();
    const store = createIdempotencyStore();
    const fresh = payDemSettle(rail, { network: "demos" }, { store });
    await expect(fresh(request("job-a"))).resolves.toMatchObject({ ok: true, txHash: hashA });
    await expect(fresh(request("job-b"))).resolves.toMatchObject({ ok: true, txHash: hashB });
    expect(sdkTransfers()).toBe(2);

    // A reconciler that keys everything by hash returns job A's journal entry.
    const byHash = vi.fn(async (context: PayDemSettlementAuditContext) => ({
      ...executed(context.txHash), preparedTransfer: journal.get(context.txHash),
    })) as unknown as PayDemSettlementReconcile;
    const f = await auditor(byHash);
    // Job B's session restored with job A's hash.
    await expect(f.settle(request("job-b", 0, hashA)))
      .rejects.toThrow(/journal does not bind the retained transaction to this exact payment/);
    // Each job's own hash audits as paid through the rail log that recorded it.
    const restarted = await auditor(byHash, store);
    await expect(restarted.settle(request("job-a", 0, hashA))).resolves.toMatchObject({ ok: true, txHash: hashA });
    await expect(restarted.settle(request("job-b", 0, hashB))).resolves.toMatchObject({ ok: true, txHash: hashB });
    for (const audit of [f, restarted]) expect(audit.once).not.toHaveBeenCalled();
    // The audits submitted nothing: only the two payments above reached the node.
    expect(sdkTransfers()).toBe(2);
  });

  // The reconciler is the host's, so the entry it returns can name any job.
  test("refuses job A's transfer for job B when the reconciler fabricates job B's entry", async () => {
    // Job A pays through a journaling rail; job B never pays.
    const { journal, rail } = await journaledPayments();
    const store = createIdempotencyStore();
    await expect(payDemSettle(rail, { network: "demos" }, { store })(request("job-a")))
      .resolves.toMatchObject({ ok: true, txHash: hashA });
    const original = journal.get(hashA)!;
    expect(original.recovery).toMatchObject({ jobId: "job-a" });
    const forged: PayDemPreparedTransfer = { ...original,
      recovery: { ...original.recovery!, jobId: "job-b", settlementKey: "pay-dem:job-b:0" } };
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => ({ ...executed(hashA), preparedTransfer: forged }));
    // Neither a store whose lookup never answers nor the SDK rail log, which
    // has no record for job B, counts it, and a refused audit binds nothing.
    for (const auditStore of [{ once: vi.fn(), readOutcome: vi.fn(async () => null) }, store]) {
      const f = await auditor(reconcile, auditStore);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(f.settle(request("job-b", 0, hashA)))
          .rejects.toThrow(/no SDK record binds the retained transaction/);
      }
      expect(f.once).not.toHaveBeenCalled();
    }
    expect(reconcile).toHaveBeenCalledTimes(4);
    // Job A's own audit still counts its hash through that rail log.
    const genuine = vi.fn<PayDemSettlementReconcile>(async () => ({ ...executed(hashA), preparedTransfer: original }));
    await expect((await auditor(genuine, store)).settle(request("job-a", 0, hashA)))
      .resolves.toMatchObject({ ok: true, txHash: hashA });
    expect(sdkTransfers()).toBe(1);
  });

  test("refuses an audit whose reconciler returns no journal entry", async () => {
    const reconcile = vi.fn(async (context: PayDemSettlementAuditContext) =>
      executed(context.txHash)) as unknown as PayDemSettlementReconcile;
    // The node serves hash A's record; no SDK record ties it to job B.
    serveNodeRecord(hashA, { payer, payee, nonce: 7 });
    for (const ok of [true, false]) {
      const f = await auditor(reconcile);
      await expect(f.settle(request("job-b", 0, hashA, ok)))
        .rejects.toThrow(/no SDK record binds the retained transaction/);
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
    ["a debit ceiling with trailing text", entry({ maxTotalDebitOs: "1000001000 " })],
    ["a debit ceiling below the amount", entry({ maxTotalDebitOs: "999999999" })],
    ["a numeric confirmed debit", entry({ confirmedTotalDebitOs: 1000001000 })],
    ["a confirmed debit below the amount", entry({ confirmedTotalDebitOs: "999999999" })],
    ["a confirmed debit above the ceiling",
      entry({ maxTotalDebitOs: "1000001000", confirmedTotalDebitOs: "1000002000" })],
    ["a non-object", "journal"],
    ["a null entry", null],
  ])("refuses a journal entry with %s", async (_case, preparedTransfer) => {
    const reconcile = vi.fn(async () => ({ ...executed(hashA), preparedTransfer })) as unknown as PayDemSettlementReconcile;
    // The rail log binds the hash; the supplied entry is still checked.
    const f = await auditor(reconcile, await settledJobA());
    await expect(f.settle(request("job-a", 0, hashA))).rejects.toThrow(
      preparedTransfer === "journal" || preparedTransfer === null
        ? /malformed prepared-transfer journal entry/
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
    const f = await auditor(reconcile, await settledJobA());
    await expect(f.settle(request("job-a", 0, hashA))).resolves.toMatchObject({ ok: true, txHash: hashA });
    expect(f.once).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  test("binds a permanent failure's proof to the journaled signed nonce", async () => {
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => ({ ...failed(hashA, 10),
      preparedTransfer: entry() as PayDemPreparedTransfer }));
    const f = await auditor(reconcile, await settledJobA(failed(hashA, 9)));
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
  const unjournaledRail = (): Promise<PayDemRail> => sdkRail();
  const honest = () => vi.fn(async (context: PayDemSettlementAuditContext) =>
    executed(context.txHash)) as unknown as PayDemSettlementReconcile;

  test("audits a journal-less payment through the rail log that recorded it", async () => {
    const store = createIdempotencyStore();
    const rail = await unjournaledRail();
    const reconcile = honest();
    await expect(payDemSettle(rail, {}, { store, reconcile })(request("job-a")))
      .resolves.toMatchObject({ ok: true, txHash: hashA });
    const once = vi.spyOn(store, "once");
    // A restarted bridge has only the rail log.
    await expect(payDemSettle(rail, {}, { store, reconcile })(request("job-a", 0, hashA)))
      .resolves.toMatchObject({ ok: true, txHash: hashA, blockNumber: 42 });
    // Job B's rail log has no record of job A's hash.
    await expect(payDemSettle(rail, {}, { store, reconcile })(request("job-b", 0, hashA)))
      .rejects.toThrow(/no SDK record binds the retained transaction/);
    // A supplied entry is still checked.
    const mismatched = vi.fn(async () => ({ ...executed(hashA),
      preparedTransfer: entry({ payee: "ef".repeat(32) }) })) as unknown as PayDemSettlementReconcile;
    await expect(payDemSettle(rail, {}, { store, reconcile: mismatched })(request("job-a", 0, hashA)))
      .rejects.toThrow(binds);
    expect(once).not.toHaveBeenCalled();
    expect(sdkTransfers()).toBe(1);
  });

  test("audits a journal-less payment this bridge authenticated", async () => {
    // A rail log that cannot show the outcome and lost the attempt record:
    // only the bridge's own result binds.
    const fences = sdkFences({ keepAttempts: false });
    const store = { once: vi.fn(fences.run), readOutcome: vi.fn(async () => null), readAttempt: fences.readAttempt };
    const rail = await unjournaledRail();
    const settle = payDemSettle(rail, {}, { store, reconcile: honest() });
    await expect(settle(request("job-a"))).resolves.toMatchObject({ ok: true, txHash: hashA });
    await expect(settle(request("job-a", 0, hashA))).resolves.toMatchObject({ ok: true, txHash: hashA });
    expect(store.readOutcome).toHaveBeenCalledTimes(2);
    // Without that result or an attempt record, nothing binds the hash.
    await expect(payDemSettle(rail, {}, { store, reconcile: honest() })(request("job-a", 0, hashA)))
      .rejects.toThrow(/no SDK record binds the retained transaction/);
    expect(sdkTransfers()).toBe(1);
  });

  // Only a store `createIdempotencyStore` built checks a recorded outcome's key
  // and terms itself; another store's answer is not the bridge's own record.
  test("does not take an injected store's outcome as this payment's record", async () => {
    const { amountOs: _amount, execution: _execution, ...outcomeA } = executed(hashA);
    const once = vi.fn(async () => { throw new Error("must never claim a retained transfer"); });
    // Answers job A's outcome and attempt whatever key and terms it is asked for.
    const store = { once, readOutcome: vi.fn(async () => outcomeA), readAttempt: vi.fn(async () => hashA) };
    // The node has job A's record, so only the binding decides.
    serveNodeRecord(hashA, { payer, payee, nonce: 7 });
    const submit = demosNode.transfer;
    const settle = payDemSettle(await sdkRail(), {}, { store, reconcile: honest() });
    await expect(settle(request("job-b", 0, hashA)))
      .rejects.toThrow(/no SDK record binds the retained transaction.*an injected store's records never count/);
    expect(store.readOutcome).toHaveBeenCalled();
    // Its attempt lookup is never even asked: only the SDK store's own counts.
    expect(store.readAttempt).not.toHaveBeenCalled();
    // The SDK store's own attempt lookup still binds, even on another object.
    const inner = createIdempotencyStore();
    await payDemSettle(await unjournaledRail(), {}, { store: inner })(request("job-a"));
    submit.mockClear();
    const borrowed = { once, readOutcome: inner.readOutcome, readAttempt: inner.readAttempt };
    const audit = await sdkAuditRail();
    await expect(payDemSettle(audit.rail, {}, { store: borrowed, reconcile: honest() })(
      request("job-a", 0, hashA))).resolves.toMatchObject({ ok: true, txHash: hashA });
    expect(once).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(audit.submit).not.toHaveBeenCalled();
  });

  test("does not count a hash through its own journal entry without the SDK's record", async () => {
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => executed(hashA));
    reconcile.mockImplementationOnce(async () => ({ ...executed(hashA),
      preparedTransfer: entry() as PayDemPreparedTransfer }));
    // A store whose lookup never answers, on a bridge that never paid job A.
    const once = vi.fn(async () => { throw new Error("must never claim a retained transfer"); });
    const store = { once, readOutcome: vi.fn(async () => null) };
    // The node has job A's record, so only the binding decides.
    serveNodeRecord(hashA, { payer, payee, nonce: 7 });
    const submit = demosNode.transfer;
    const settle = payDemSettle(await sdkRail(), {}, { store, reconcile });
    // An entry that binds job A cannot show that the rail wrote it, so the
    // audit fails closed and binds nothing for the next one.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(settle(request("job-a", 0, hashA)))
        .rejects.toThrow(/no SDK record binds the retained transaction/);
    }
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(once).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  // A reconciler asked for a key's payment without a hash may answer with a
  // transfer of the same parties and amount. Neither that answer, nor a
  // journal entry with it, nor the bridge's cache of it ties the hash to this
  // payment for an audit.
  const { amountOs: _cachedAmount, execution: _cachedExecution, ...cachedA } = executed(hashA);
  test.each([
    ["resolves the key through the bridge's reconciliation",
      async (key: string, _binding: unknown, _submit: unknown, reconcile?: SettlementReconcile) =>
        reconcile!(key) as Promise<SettleResult>],
    ["replays a cached outcome", async () => cachedA as SettleResult],
  ])("does not bind a result reconciled for a store that %s, even with a journal entry", async (_case, once) => {
    const store = { once: vi.fn(once), readOutcome: vi.fn(async () => null) };
    const { rail, submit } = await sdkAuditRail();
    serveNodeRecord(hashA, { payer, payee, nonce: 7 });
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => executed(hashA));
    const settle = payDemSettle(rail, {}, { store, reconcile });
    await expect(settle(request("job-b"))).resolves.toMatchObject({ ok: true, txHash: hashA });
    await expect(settle(request("job-b", 0, hashA)))
      .rejects.toThrow(/no SDK record binds the retained transaction/);
    // Nor does a reconciliation that also returns an entry naming the key.
    const bound = vi.fn<PayDemSettlementReconcile>(async () => executed(hashA));
    bound.mockImplementationOnce(async () => ({ ...executed(hashA),
      preparedTransfer: entry({ recovery: { ...recovery, jobId: "job-b", settlementKey: "pay-dem:job-b:0" } }) as PayDemPreparedTransfer }));
    const journaled = payDemSettle(rail, {}, { store, reconcile: bound });
    await expect(journaled(request("job-b"))).resolves.toMatchObject({ ok: true, txHash: hashA });
    await expect(journaled(request("job-b", 0, hashA)))
      .rejects.toThrow(/no SDK record binds the retained transaction/);
    expect(bound).toHaveBeenCalledTimes(2);
    expect(submit).not.toHaveBeenCalled();
  });

  test("keeps a hash this bridge submitted bound when a reconciliation confirms it", async () => {
    // The first call broadcasts while the node's record is still pending; the
    // second reconciles the key once the node has the record. The log lost
    // the attempt record, so only this bridge's own result binds.
    const fences = sdkFences({ keepAttempts: false });
    const store = {
      once: vi.fn(async (key: string, binding: SettlementBinding,
        submit: Parameters<typeof fences.run>[2], reconcile?: SettlementReconcile) =>
        store.once.mock.calls.length === 1
          ? fences.run(key, binding, submit)
          : reconcile!(key) as Promise<SettleResult>),
      readOutcome: vi.fn(async () => null),
      readAttempt: fences.readAttempt,
    };
    for (const [found, audited] of [[hashA, true], [hashB, false]] as const) {
      resetDemosNode({ payer, txHash: hashA, laterTxHashes: [hashB], nonce: 7, recordStatus: "pending" });
      serveNodeRecord(hashB, { payer, payee, nonce: 8, status: "confirmed" });
      store.once.mockClear();
      const rail = await sdkRail();
      const reconcile = vi.fn<PayDemSettlementReconcile>(async () => executed(found));
      const settle = payDemSettle(rail, {}, { store, reconcile });
      await expect(settle(request("job-a"))).resolves.toMatchObject({ ok: false, txHash: hashA });
      setNodeRecordStatus("confirmed");
      await expect(settle(request("job-a"))).resolves.toMatchObject({ ok: true, txHash: found });
      // Another hash found for the key is only the reconciler's answer.
      const audit = settle(request("job-a", 0, found));
      await (audited
        ? expect(audit).resolves.toMatchObject({ ok: true, txHash: hashA })
        : expect(audit).rejects.toThrow(/no SDK record binds the retained transaction/));
      expect(sdkTransfers()).toBe(1);
    }
  });

  test("checks a journal entry a restart reconciliation supplies, and never persists it", async () => {
    const store = createIdempotencyStore();
    const rail = await sdkRail();
    await payDemSettle(rail, { network: "demos" }, { store })(request("job-a"));
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => ({ ...executed(hashA),
      preparedTransfer: entry({ recovery: { ...recovery, jobId: "job-b", settlementKey: "pay-dem:job-b:0" } }) as PayDemPreparedTransfer }));
    const restarted = payDemSettle(rail, { network: "demos" }, { store, reconcile });
    await expect(restarted(request("job-a"))).rejects.toThrow(binds);
    reconcile.mockImplementation(async () => ({ ...executed(hashA), preparedTransfer: entry() as PayDemPreparedTransfer }));
    const result = await restarted(request("job-a"));
    expect(result).toMatchObject({ ok: true, txHash: hashA });
    expect(result).not.toHaveProperty("preparedTransfer");
    expect(sdkTransfers()).toBe(1);
  });
});

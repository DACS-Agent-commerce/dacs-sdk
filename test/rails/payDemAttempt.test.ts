import { beforeEach, describe, expect, test, vi } from "vitest";

import type { SettleRequest } from "../../src/agent/runSessionCore.js";
import {
  createIdempotencyStore,
  createInMemorySettlementLog,
  settlementBindingHash,
  type SettlementAttemptRecord,
  type SettlementEffectFence,
  type SettlementLog,
} from "../../src/rails/index.js";
import {
  payDemSettle,
  type PayDemRail,
  type PayDemSettlementAuditContext,
  type PayDemSettlementReconcile,
} from "../../src/rails/payDem.js";
import { demosNode, resetDemosNode, sdkRail, sdkTransfers } from "../fixtures/demosNodeMock.js";

vi.mock("@kynesyslabs/demosdk/websdk", async () => (await import("../fixtures/demosNodeMock.js")).demosSdkModule());

const hashA = "56".repeat(32);
const hashB = "78".repeat(32);
const payer = "ab".repeat(32);
const payee = "cd".repeat(32);
beforeEach(() => resetDemosNode({ payer, txHash: hashA }));
const claim = `did:demos:agent:${payee}`;
const request = (jobId: string, txHash?: string, ok = false): SettleRequest => ({
  rail: "pay-dem", phase: "pay-dem", phaseIndex: 0, jobId, amount: "1", asset: "DEM",
  payee: claim, expectedPayee: claim,
  ...(txHash === undefined ? {} : { priorAttempts: [{ txHash, chainId: "demos", ok }] }),
});
const executed = (txHash: string) => ({
  ok: true as const, txHash, payer, payee, chainId: "demos", amountOs: "1000000000",
  blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" as const },
  execution: "executed" as const,
});
const failed = (txHash: string) => ({
  ok: false as const, txHash, payer, payee, chainId: "demos", amountOs: "1000000000",
  blockNumber: 42, txRefKind: "demos", errorClass: "permanent" as const,
  failureProof: { kind: "demos-failed-record" as const, txHash, payer, payee,
    nonce: 7, blockNumber: 42, amountOs: "1000000000" },
});
const ambiguous = (txHash: string) => ({ ok: false, txHash, payer, payee, chainId: "demos" });

/** One durable rail log shared by "processes" that each build their own store and bridge. */
function processes(log: SettlementLog = createInMemorySettlementLog()) {
  let now = 1_000;
  const store = (owner: string) =>
    createIdempotencyStore(log, { owner, leaseDurationMs: 1_000, now: () => now });
  return { log, store, restart: () => { now += 60_000; } };
}

/** A durable log written before attempt records existed: it keeps outcomes only. */
function legacyLog(memory: SettlementLog = createInMemorySettlementLog()): SettlementLog {
  return {
    readOutcome: (key) => memory.readOutcome!(key),
    claimIntent: (input) => memory.claimIntent(input),
    isCurrent: (input) => memory.isCurrent(input),
    grantRecovery: (input) => memory.grantRecovery(input),
    putOutcome: (input) => memory.putOutcome(input),
    releaseIntent: (input) => memory.releaseIntent(input),
  };
}

const bindingFor = (jobId: string) => ({
  bindingVersion: "1" as const, railId: "pay-dem", jobId, phaseIndex: 0, phase: "pay-dem",
  amount: "1000000000", agreementAsset: "DEM", settlementAsset: "DEM", payer, payee,
  network: "demos", finality: { model: "bft-final" },
});

/** A final success an SDK saved before it kept attempt records: no record names its hash. */
async function savedBeforeAttemptRecords(log: SettlementLog, jobId: string) {
  await createIdempotencyStore(log).once(`pay-dem:${jobId}:0`, bindingFor(jobId), async () => ({
    ok: true, txHash: hashA, payer, payee, chainId: "demos", blockNumber: 42, txRefKind: "demos",
    finality: { model: "bft-final" },
  }));
}

/** A process whose bridge must only audit or reconcile, never submit. */
function auditingProcess(
  store: ReturnType<ReturnType<typeof processes>["store"]>,
  reconcile: PayDemSettlementReconcile,
) {
  const once = vi.spyOn(store, "once");
  const submit = vi.fn(async () => { throw new Error("must never submit a retained transfer"); });
  const settle = payDemSettle({ address: payer, settle: submit }, {}, { store, reconcile });
  return { settle, once, submit };
}

// DACS-4 §9.5.1 PC-7: a final payment is never failed, resubmitted or classed
// unpaid. The SDK records the hash this key's own submit produced, under the
// submit generation, so a later process can tie the retained hash to the
// payment without trusting the session's history or the reconciler.
describe("pay-dem records this key's signed hash so a restart can finish a final payment", () => {
  test.each([
    ["executed", executed(hashA), { ok: true, txHash: hashA }],
    ["failed", failed(hashA), { ok: false, errorClass: "permanent", txHash: hashA }],
  ] as const)("completes a restart after an ambiguous result when the transfer %s", async (_label, reply, expected) => {
    const run = processes();
    const rail: PayDemRail = { address: payer, settle: vi.fn(async () => ambiguous(hashA) as never) };
    const first = await payDemSettle(rail, {}, { store: run.store("A") })(request("job-a"));
    expect(first).toMatchObject({ ok: false, txHash: hashA });
    expect(first.errorClass).toBeUndefined();

    run.restart();
    const reconcile = vi.fn(async () => reply);
    const b = auditingProcess(run.store("B"), reconcile);
    await expect(b.settle(request("job-a", hashA))).resolves.toMatchObject(expected);
    // Repeating the audit is read-only and gives the same answer.
    await expect(b.settle(request("job-a", hashA))).resolves.toMatchObject(expected);
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-a", txHash: hashA }));
    expect(b.once).not.toHaveBeenCalled();
    expect(b.submit).not.toHaveBeenCalled();
    expect(rail.settle).toHaveBeenCalledTimes(1);
  });

  test("finishes a transfer whose process died after its pre-broadcast record and broadcast, with or without history", async () => {
    const run = processes();
    // The rail records the signed hash through the fence, broadcasts, and the
    // process dies before the rail returns.
    const died = new Promise<never>(() => undefined);
    const broadcast = vi.fn();
    const rail: PayDemRail = {
      address: payer,
      settle: vi.fn(async (_params, fence?: Readonly<SettlementEffectFence>) => {
        await fence!.recordAttempt!(hashA);
        broadcast(hashA);
        return died;
      }),
    };
    void payDemSettle(rail, {}, { store: run.store("A") })(request("job-a"));
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledWith(hashA));
    await expect(run.log.readAttempt!("pay-dem:job-a:0")).resolves.toMatchObject({ txHash: hashA });

    run.restart();
    const audit = auditingProcess(run.store("B"), vi.fn(async () => executed(hashA)));
    await expect(audit.settle(request("job-a", hashA, false))).resolves.toMatchObject({ ok: true, txHash: hashA });
    expect(audit.once).not.toHaveBeenCalled();

    // The session never saw the hash: the store's expired-lease reconciliation
    // asks for exactly the recorded transaction and persists it.
    const reconcile = vi.fn(async (context: Readonly<PayDemSettlementAuditContext>) => executed(context.txHash));
    const resumed = auditingProcess(run.store("C"), reconcile as PayDemSettlementReconcile);
    await expect(resumed.settle(request("job-a"))).resolves.toMatchObject({ ok: true, txHash: hashA });
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-a", txHash: hashA }));
    expect(resumed.submit).not.toHaveBeenCalled();
    expect(rail.settle).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  // The other side of the record: a custom rail that dies before it has
  // broadcast nothing and recorded nothing. Proven absence alone never lets a
  // restart submit again; it stops for the operator.
  test("never resubmits after a custom rail died before its record", async () => {
    const run = processes();
    const silent: PayDemRail = { address: payer, settle: vi.fn(() => new Promise<never>(() => undefined)) };
    void payDemSettle(silent, {}, { store: run.store("A") })(request("job-a"));
    await vi.waitFor(() => expect(silent.settle).toHaveBeenCalled());
    await expect(run.log.readAttempt!("pay-dem:job-a:0")).resolves.toBeNull();

    run.restart();
    const reconcile = vi.fn(async () => null);
    const resumed = auditingProcess(run.store("B"), reconcile);
    await expect(resumed.settle(request("job-a"))).rejects.toThrow(/absence alone cannot revoke a prior external effect/);
    expect(reconcile).toHaveBeenCalledWith(expect.not.objectContaining({ txHash: expect.anything() }));
    expect(resumed.submit).not.toHaveBeenCalled();
    await expect(run.log.readAttempt!("pay-dem:job-a:0")).resolves.toBeNull();
    await expect(run.log.readOutcome!("pay-dem:job-a:0")).resolves.toBeNull();
  });

  // A crash between the SDK rail's pre-broadcast record and its broadcast
  // leaves a recorded hash that never reached the chain. A restart never signs
  // or sends again, with or without history: the key stays held for the operator.
  test("never resubmits after the SDK rail died between its record and its broadcast", async () => {
    let died = false;
    const memory = createInMemorySettlementLog();
    const log: SettlementLog = {
      ...memory,
      putAttempt: async (input) => {
        const write = await memory.putAttempt!(input);
        died = true;
        return write;
      },
      // The fence check right before the broadcast never returns: the process died there.
      isCurrent: (input) => died ? new Promise<never>(() => undefined) : memory.isCurrent(input),
    };
    const run = processes(log);
    void payDemSettle(await sdkRail(), { network: "demos" }, { store: run.store("A") })(request("job-a"));
    await vi.waitFor(() => expect(died).toBe(true));
    await expect(log.readAttempt!("pay-dem:job-a:0")).resolves.toMatchObject({ txHash: hashA });
    expect(demosNode.broadcast).not.toHaveBeenCalled();

    run.restart();
    died = false;
    // Nothing reached the chain, so an honest reconciler finds nothing for the recorded hash.
    const reconcile = vi.fn(async () => null);
    const resumed = auditingProcess(run.store("B"), reconcile);
    await expect(resumed.settle(request("job-a"))).rejects.toThrow(/absence alone cannot revoke a prior external effect/);
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-a", txHash: hashA }));
    const audit = auditingProcess(run.store("C"), reconcile);
    await expect(audit.settle(request("job-a", hashA))).rejects.toThrow(/contradicts reconciliation proof of absence/);
    expect(resumed.submit).not.toHaveBeenCalled();
    expect(audit.submit).not.toHaveBeenCalled();
    expect(sdkTransfers()).toBe(1);
    expect(demosNode.broadcast).not.toHaveBeenCalled();
    await expect(log.readOutcome!("pay-dem:job-a:0")).resolves.toBeNull();
  });

  test("a restart reconciliation cannot answer another transfer than the one this key recorded", async () => {
    const run = processes();
    const rail: PayDemRail = { address: payer, settle: vi.fn(async () => ambiguous(hashA) as never) };
    await payDemSettle(rail, {}, { store: run.store("A") })(request("job-a"));
    run.restart();
    // A by-key reconciler finds another job's same-amount transfer.
    const b = auditingProcess(run.store("B"), vi.fn(async () => executed(hashB)));
    await expect(b.settle(request("job-a"))).rejects.toThrow(/does not match the retained transaction/);
    await expect(run.log.readOutcome!("pay-dem:job-a:0")).resolves.toBeNull();
    expect(b.submit).not.toHaveBeenCalled();
  });

  test("counts a record another process writes while the audit reads the chain", async () => {
    const run = processes();
    const writer: PayDemRail = { address: payer, settle: vi.fn(async () => ambiguous(hashA) as never) };
    const reconcile = vi.fn(async () => {
      await payDemSettle(writer, {}, { store: run.store("A") })(request("job-a"));
      return executed(hashA);
    });
    const audit = auditingProcess(run.store("B"), reconcile);
    await expect(audit.settle(request("job-a", hashA))).resolves.toMatchObject({ ok: true, txHash: hashA });
    expect(writer.settle).toHaveBeenCalledTimes(1);
    expect(audit.submit).not.toHaveBeenCalled();
  });
});

// The bridge's own result binds a hash only once the durable attempt record
// accepted it, and an audit always checks that record, so a refused write
// cannot leave a hash counted for this key in memory.
describe("pay-dem never binds a fresh result the attempt record refused", () => {
  test("an audit through the same bridge refuses the hash the record refused, and later calls keep the recorded one", async () => {
    const run = processes();
    // The rail records B through the fence, then reports A.
    const rail: PayDemRail = {
      address: payer,
      settle: vi.fn(async (_params, fence?: Readonly<SettlementEffectFence>) => {
        await fence!.recordAttempt!(hashB);
        return ambiguous(hashA) as never;
      }),
    };
    const reconcile = vi.fn(async (context: Readonly<PayDemSettlementAuditContext>) => executed(context.txHash));
    const settle = payDemSettle(rail, {}, { store: run.store("A"), reconcile: reconcile as PayDemSettlementReconcile });
    await expect(settle(request("job-a"))).rejects.toThrow(/already records another transaction/);
    await expect(run.log.readAttempt!("pay-dem:job-a:0")).resolves.toMatchObject({ txHash: hashB });

    await expect(settle(request("job-a", hashA))).rejects.toThrow(
      /conflicts with this key's recorded attempt/,
    );
    // The audit remembers the recorded hash, not the refused one.
    await expect(settle(request("job-a", hashA))).rejects.toThrow(/different payment terms or transaction/);
    expect(reconcile).not.toHaveBeenCalledWith(expect.objectContaining({ txHash: hashA }));
    await expect(run.log.readOutcome!("pay-dem:job-a:0")).resolves.toBeNull();
    expect(rail.settle).toHaveBeenCalledTimes(1);
  });

  test("after a restart, a history for another hash than the record is refused and its success claim is not kept", async () => {
    const run = processes();
    const rail: PayDemRail = { address: payer, settle: vi.fn(async () => ambiguous(hashB) as never) };
    await payDemSettle(rail, {}, { store: run.store("A") })(request("job-a"));
    run.restart();
    const reconcile = vi.fn(async (context: Readonly<PayDemSettlementAuditContext>) => failed(context.txHash));
    const audit = auditingProcess(run.store("B"), reconcile as PayDemSettlementReconcile);
    await expect(audit.settle(request("job-a", hashA, true))).rejects.toThrow(
      /conflicts with this key's recorded attempt/,
    );
    // The success the history claimed was for A, so B's failed record is reported.
    await expect(audit.settle(request("job-a"))).resolves.toMatchObject({
      ok: false, errorClass: "permanent", txHash: hashB,
    });
    expect(audit.submit).not.toHaveBeenCalled();
  });

  // A result without a hash names no transaction: nothing is recorded for it,
  // so a later history hash is not this bridge's own, whatever it names.
  test("a result without a hash never binds a later history hash through the same bridge", async () => {
    const run = processes();
    const rail: PayDemRail = { address: payer, settle: vi.fn(async () => ambiguous("") as never) };
    const reconcile = vi.fn(async (context: Readonly<PayDemSettlementAuditContext>) => executed(context.txHash));
    const settle = payDemSettle(rail, {}, { store: run.store("A"), reconcile: reconcile as PayDemSettlementReconcile });
    await expect(settle(request("job-a"))).resolves.toMatchObject({ ok: false, txHash: "" });
    await expect(run.log.readAttempt!("pay-dem:job-a:0")).resolves.toBeNull();
    await expect(settle(request("job-a", hashB, true))).rejects.toThrow(
      /no SDK record binds the retained transaction to this payment/,
    );
    expect(reconcile).toHaveBeenCalledTimes(1);
    await expect(run.log.readOutcome!("pay-dem:job-a:0")).resolves.toBeNull();
    expect(rail.settle).toHaveBeenCalledTimes(1);
  });

  test("a stale record write leaves the returned hash unbound for an audit through the same bridge", async () => {
    let now = 1_000;
    const log = createInMemorySettlementLog();
    const store = createIdempotencyStore(log, { owner: "A", leaseDurationMs: 1_000, now: () => now });
    // The rail returns after its generation expired, so the bridge's record is refused.
    const rail: PayDemRail = {
      address: payer,
      settle: vi.fn(async () => {
        now += 60_000;
        return ambiguous(hashA) as never;
      }),
    };
    const reconcile = vi.fn(async () => executed(hashA));
    const settle = payDemSettle(rail, {}, { store, reconcile });
    await expect(settle(request("job-a"))).rejects.toThrow(/attempt was produced by a stale generation/);
    await expect(log.readAttempt!("pay-dem:job-a:0")).resolves.toBeNull();

    await expect(settle(request("job-a", hashA, true))).rejects.toThrow(
      /no SDK record binds the retained transaction to this payment/,
    );
    await expect(log.readOutcome!("pay-dem:job-a:0")).resolves.toBeNull();
    expect(rail.settle).toHaveBeenCalledTimes(1);
  });
});

// The store saves whatever a key-only restart reconciliation found, so that
// outcome is the reconciler's answer, not this key's own submit, and it never
// lets a later audit count the hash.
describe("pay-dem never binds a hash through an outcome a key-only reconciliation wrote", () => {
  test("an audit of job B refuses job A's hash that B's restart reconciliation saved", async () => {
    const run = processes();
    // Job B's first process claimed the intent and died before signing anything.
    const silent: PayDemRail = { address: payer, settle: vi.fn(() => new Promise<never>(() => undefined)) };
    void payDemSettle(silent, {}, { store: run.store("A") })(request("job-b"));
    await vi.waitFor(() => expect(silent.settle).toHaveBeenCalled());

    run.restart();
    // A careless reconciler finds job A's transfer of the same parties and amount.
    const restart = auditingProcess(run.store("B"), vi.fn(async () => executed(hashA)));
    await expect(restart.settle(request("job-b"))).resolves.toMatchObject({ ok: true, txHash: hashA });
    await expect(run.log.readOutcome!("pay-dem:job-b:0")).resolves.toMatchObject({ result: { txHash: hashA } });

    run.restart();
    const audit = auditingProcess(run.store("C"), vi.fn(async () => executed(hashA)));
    await expect(audit.settle(request("job-b", hashA, true))).rejects.toThrow(
      /no SDK record binds the retained transaction to this payment/,
    );
    expect(audit.once).not.toHaveBeenCalled();
    expect(audit.submit).not.toHaveBeenCalled();
  });

  // A log that keeps attempts can show that an outcome without a record came
  // from a key-only reconciliation, so a wrapper that hides the attempt lookup
  // does not make its outcome count either.
  test.each([
    ["the store itself", (store: ReturnType<ReturnType<typeof processes>["store"]>) => store],
    ["a wrapper that hides its attempt lookup",
      (store: ReturnType<ReturnType<typeof processes>["store"]>) =>
        ({ once: store.once, readOutcome: store.readOutcome }) as typeof store],
  ] as const)("an outcome without a record on a log that keeps attempts never binds, through %s", async (_label, view) => {
    const run = processes();
    await savedBeforeAttemptRecords(run.log, "job-a");
    run.restart();
    const audit = auditingProcess(view(run.store("B")), vi.fn(async () => executed(hashA)));
    await expect(audit.settle(request("job-a", hashA, true))).rejects.toThrow(
      /no SDK record binds the retained transaction to this payment/,
    );
    expect(audit.once).not.toHaveBeenCalled();
    expect(audit.submit).not.toHaveBeenCalled();
  });
});

// DACS-4 §9.5.1 PC-7 on a log that keeps no attempt records (one written
// before they existed): a final payment it saved still completes after a
// restart, and it never starts a payment a restart could not bind.
describe("pay-dem over a log without attempt records", () => {
  test("an audit after a restart counts the hash the log's own outcome names when the reconciliation agrees", async () => {
    const run = processes(legacyLog());
    await savedBeforeAttemptRecords(run.log, "job-a");

    run.restart();
    const reconcile = vi.fn(async () => executed(hashA));
    const audit = auditingProcess(run.store("B"), reconcile);
    await expect(audit.settle(request("job-a", hashA, true)))
      .resolves.toMatchObject({ ok: true, txHash: hashA, blockNumber: 42 });
    // Repeating the audit, or omitting the history, is read-only and gives the same answer.
    await expect(audit.settle(request("job-a", hashA, true))).resolves.toMatchObject({ ok: true, txHash: hashA });
    await expect(audit.settle(request("job-a"))).resolves.toMatchObject({ ok: true, txHash: hashA });
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-a", txHash: hashA }));
    expect(audit.once).not.toHaveBeenCalled();
    expect(audit.submit).not.toHaveBeenCalled();
  });

  test.each([
    ["history for another hash than the outcome", request("job-a", hashB, true), executed(hashB),
      /retained transaction conflicts with the rail outcome/],
    ["a reconciliation at another block", request("job-a", hashA, true), { ...executed(hashA), blockNumber: 43 },
      /retained transaction block conflicts with the rail outcome/],
    ["a reconciliation that finds the transfer failed", request("job-a", hashA), failed(hashA),
      /refusing to report a final payment unpaid/],
  ] as const)("refuses %s", async (_label, req, reply, error) => {
    const run = processes(legacyLog());
    await savedBeforeAttemptRecords(run.log, "job-a");
    run.restart();
    const audit = auditingProcess(run.store("B"), vi.fn(async () => reply));
    await expect(audit.settle(req)).rejects.toThrow(error);
    await expect(run.log.readOutcome!("pay-dem:job-a:0")).resolves.toMatchObject({ result: { ok: true, txHash: hashA } });
    expect(audit.submit).not.toHaveBeenCalled();
  });

  test("a key the log saved no outcome for still fails closed", async () => {
    const run = processes(legacyLog());
    run.restart();
    const audit = auditingProcess(run.store("B"), vi.fn(async () => executed(hashA)));
    await expect(audit.settle(request("job-a", hashA, true))).rejects.toThrow(
      /no SDK record binds the retained transaction to this payment/,
    );
    expect(audit.once).not.toHaveBeenCalled();
    expect(audit.submit).not.toHaveBeenCalled();
  });

  test.each([
    ["the SDK rail", async () => sdkRail()],
    ["a custom rail", async () => ({ address: payer, settle: vi.fn(async () => ambiguous(hashA) as never) })],
  ] as const)("a new payment through %s is refused before the rail runs, and the key is not held", async (_label, makeRail) => {
    const memory = createInMemorySettlementLog();
    const run = processes(legacyLog(memory));
    const rail = await makeRail();
    await expect(payDemSettle(rail, { network: "demos" }, { store: run.store("A") })(request("job-a")))
      .rejects.toThrow(/keeps no attempt records; refusing to start a new transfer/);
    if (vi.isMockFunction(rail.settle)) expect(rail.settle).not.toHaveBeenCalled();
    expect(sdkTransfers()).toBe(0);
    expect(demosNode.broadcast).not.toHaveBeenCalled();
    await expect(memory.readOutcome!("pay-dem:job-a:0")).resolves.toBeNull();

    // Nothing was signed, so nothing is held: once the log keeps attempts, the key settles once.
    await expect(payDemSettle(await sdkRail(), { network: "demos" }, { store: createIdempotencyStore(memory) })(
      request("job-a"),
    )).resolves.toMatchObject({ ok: true, txHash: hashA });
    expect(sdkTransfers()).toBe(1);
  });
});

// Without an attempt record (a log written before records existed), the
// restart path still checks the cached outcome against the by-key
// reconciliation, so the reconciler cannot swap in another transaction.
describe("pay-dem checks a cached outcome against reconciliation when the log keeps no attempt", () => {
  test.each([
    ["another transaction at the cached block", executed(hashB)],
    ["the cached transaction at another block", { ...executed(hashA), blockNumber: 43 }],
  ] as const)("refuses %s on a restart", async (_label, reply) => {
    const run = processes(legacyLog());
    await savedBeforeAttemptRecords(run.log, "job-a");

    run.restart();
    const reconcile = vi.fn(async () => reply);
    const b = auditingProcess(run.store("B"), reconcile);
    await expect(b.settle(request("job-a"))).rejects.toThrow(/does not match the authoritative reconciled transaction/);
    expect(reconcile).toHaveBeenCalledWith(expect.not.objectContaining({ txHash: expect.anything() }));
    await expect(run.log.readOutcome!("pay-dem:job-a:0"))
      .resolves.toMatchObject({ result: { txHash: hashA, blockNumber: 42 } });
    expect(b.submit).not.toHaveBeenCalled();
    expect(sdkTransfers()).toBe(0);
  });
});

// The attempt record compares hashes as exact strings. The bridge hands a rail
// a fence that records the canonical form, so every form a rail may return
// binds, and a value that is not a hash is refused before the rail broadcasts.
describe("pay-dem records a rail's hash in canonical form", () => {
  test.each([
    ["0x-prefixed", `0x${hashA}`, hashA],
    ["upper-case", "5E".repeat(32), "5e".repeat(32)],
  ])("a custom rail that records the %s hash it returns settles once and binds it", async (_label, exact, canonical) => {
    const run = processes();
    const broadcast = vi.fn();
    const rail: PayDemRail = {
      address: payer,
      settle: vi.fn(async (_params, fence?: Readonly<SettlementEffectFence>) => {
        await fence!.recordAttempt!(exact);
        broadcast(exact);
        return ambiguous(exact) as never;
      }),
    };
    await expect(payDemSettle(rail, {}, { store: run.store("A") })(request("job-a")))
      .resolves.toMatchObject({ ok: false, txHash: canonical });
    await expect(run.log.readAttempt!("pay-dem:job-a:0")).resolves.toMatchObject({ txHash: canonical });

    run.restart();
    const audit = auditingProcess(run.store("B"), vi.fn(async () => executed(canonical)));
    await expect(audit.settle(request("job-a", exact))).resolves.toMatchObject({ ok: true, txHash: canonical });
    expect(audit.submit).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["a value that is not hex", "not-a-transaction-hash"],
    ["a short hash", "56".repeat(31)],
    ["a padded hash", ` ${hashA}`],
  ])("a rail that records %s is refused before it broadcasts", async (_label, value) => {
    const run = processes();
    const broadcast = vi.fn();
    const rail: PayDemRail = {
      address: payer,
      settle: vi.fn(async (_params, fence?: Readonly<SettlementEffectFence>) => {
        await fence!.recordAttempt!(value);
        broadcast(value);
        return ambiguous(hashA) as never;
      }),
    };
    await expect(payDemSettle(rail, {}, { store: run.store("A") })(request("job-a")))
      .rejects.toThrow(/attempt record needs a 32-byte Demos transaction hash; refusing broadcast/);
    expect(broadcast).not.toHaveBeenCalled();
    await expect(run.log.readAttempt!("pay-dem:job-a:0")).resolves.toBeNull();
  });
});

describe("settlement attempt records are generation-fenced and immutable", () => {
  const binding = {
    bindingVersion: "1" as const, railId: "pay-dem", jobId: "job-a", phaseIndex: 0, phase: "pay-dem",
    amount: "1000000000", agreementAsset: "DEM", settlementAsset: "DEM", payer, payee,
    network: "demos", finality: { model: "bft-final" },
  };

  test("records one hash per key under the current generation only", async () => {
    let now = 1_000;
    const log = createInMemorySettlementLog();
    const store = createIdempotencyStore(log, { owner: "A", leaseDurationMs: 1_000, now: () => now });
    const seen: string[] = [];
    await store.once("pay-dem:job-a:0", binding, async (fence) => {
      await fence!.recordAttempt!(hashA);
      // The same hash again is idempotent; another hash for this key is refused.
      await fence!.recordAttempt!(hashA);
      await expect(fence!.recordAttempt!(hashB)).rejects.toThrow(/already records another transaction/);
      await expect(fence!.recordAttempt!("")).rejects.toThrow(/non-empty/);
      seen.push((await store.readAttempt!("pay-dem:job-a:0", binding))!);
      now += 60_000;
      await expect(fence!.recordAttempt!(hashA)).resolves.toBeUndefined();
      await expect(store.readAttempt!("pay-dem:job-b:0", { ...binding, jobId: "job-b" })).resolves.toBeNull();
      return { ok: false, txHash: hashA, payer, payee, chainId: "demos" };
    });
    expect(seen).toEqual([hashA]);
    await expect(store.readAttempt!("pay-dem:job-a:0", { ...binding, amount: "2" }))
      .rejects.toThrow(/attempt binding conflicts with requested terms/);
  });

  test("refuses a first record from a stale generation", async () => {
    let now = 1_000;
    const store = createIdempotencyStore(createInMemorySettlementLog(), {
      owner: "A", leaseDurationMs: 1_000, now: () => now,
    });
    await expect(store.once("pay-dem:job-a:0", binding, async (fence) => {
      now += 60_000;
      await fence!.recordAttempt!(hashA);
      return { ok: false, txHash: hashA, payer, payee, chainId: "demos" };
    })).rejects.toThrow(/attempt was produced by a stale generation/);
    await expect(store.readAttempt!("pay-dem:job-a:0", binding)).resolves.toBeNull();
  });

  test("the in-memory log refuses an attempt for an unknown key or other terms", async () => {
    const log = createInMemorySettlementLog();
    const bindingHash = settlementBindingHash(binding);
    const lease = { owner: "A", generation: 1 } as never;
    await expect(log.putAttempt!({ key: "pay-dem:job-a:0", bindingHash, lease, txHash: hashA, now: 1_000 }))
      .resolves.toBe("stale");
    await log.claimIntent({ key: "pay-dem:job-a:0", bindingHash, owner: "A", now: 1_000, leaseDurationMs: 1_000 });
    await expect(log.putAttempt!({ key: "pay-dem:job-a:0", bindingHash: "0".repeat(64), lease, txHash: hashA, now: 1_000 }))
      .resolves.toBe("conflict");
  });

  test("a lookup refuses terms for another key", async () => {
    const store = createIdempotencyStore(createInMemorySettlementLog());
    await expect(store.readAttempt!("pay-dem:job-b:0", binding))
      .rejects.toThrow(/attempt lookup binding does not match its idempotency key/);
  });

  // A host log's record and write status are refused unless exactly well formed.
  const recordedLog = async (rewrite: (record: SettlementAttemptRecord) => unknown) => {
    const memory = createInMemorySettlementLog();
    const store = createIdempotencyStore(memory);
    await store.once("pay-dem:job-a:0", binding, async (fence) => {
      await fence!.recordAttempt!(hashA);
      return { ok: false, txHash: hashA, payer, payee, chainId: "demos" };
    }).catch(() => undefined);
    const log: SettlementLog = {
      ...memory,
      readAttempt: async (key) => {
        const record = await memory.readAttempt!(key);
        return record === null ? null : rewrite({ ...record }) as SettlementAttemptRecord;
      },
    };
    return log;
  };

  test.each([
    ["an extra field", (record: SettlementAttemptRecord) => ({ ...record, ok: true })],
    ["a missing hash", ({ bindingHash }: SettlementAttemptRecord) => ({ bindingHash })],
    ["an array", () => []],
    ["a non-hex binding hash", (record: SettlementAttemptRecord) => ({ ...record, bindingHash: "Z".repeat(64) })],
    ["a binding hash with a suffix", (record: SettlementAttemptRecord) => ({ ...record, bindingHash: `${record.bindingHash}00` })],
    ["a binding hash with a prefix", (record: SettlementAttemptRecord) => ({ ...record, bindingHash: `00${record.bindingHash}` })],
    ["an empty hash", (record: SettlementAttemptRecord) => ({ ...record, txHash: "" })],
    ["a padded hash", (record: SettlementAttemptRecord) => ({ ...record, txHash: ` ${record.txHash}` })],
    ["a numeric hash", (record: SettlementAttemptRecord) => ({ ...record, txHash: 7 })],
  ] as const)("a stored attempt record with %s is refused", async (_label, rewrite) => {
    const store = createIdempotencyStore(await recordedLog(rewrite as never));
    await expect(store.readAttempt!("pay-dem:job-a:0", binding)).rejects.toThrow(/attempt record has an invalid shape/);
  });

  test("an audit refuses a recorded attempt that is not a Demos transaction hash", async () => {
    const log = await recordedLog((record) => ({ ...record, txHash: "not-a-transaction-hash" }));
    const audit = auditingProcess(createIdempotencyStore(log), vi.fn(async () => executed(hashA)));
    await expect(audit.settle(request("job-a", hashA))).rejects.toThrow(/records a malformed attempt hash/);
    expect(audit.submit).not.toHaveBeenCalled();
  });

  test("an unknown attempt write status is refused", async () => {
    const memory = createInMemorySettlementLog();
    const log: SettlementLog = { ...memory, putAttempt: async () => "accepted" as never };
    const store = createIdempotencyStore(log);
    await expect(store.once("pay-dem:job-a:0", binding, async (fence) => {
      await fence!.recordAttempt!(hashA);
      return { ok: false, txHash: hashA, payer, payee, chainId: "demos" };
    })).rejects.toThrow(/attempt write is invalid/);
  });

  test("a log must provide both attempt methods or neither", () => {
    const log = createInMemorySettlementLog();
    const { putAttempt: _put, ...partial } = log;
    expect(() => createIdempotencyStore(partial as SettlementLog))
      .toThrow(/settlement log must provide both putAttempt and readAttempt/);
  });
});

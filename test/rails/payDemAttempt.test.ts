import { beforeEach, describe, expect, test, vi } from "vitest";

import type { SettleRequest } from "../../src/agent/runSessionCore.js";
import {
  createIdempotencyStore,
  createInMemorySettlementLog,
  settlementBindingHash,
  type SettlementAttemptRecord,
  type SettlementLog,
} from "../../src/rails/index.js";
import {
  payDemSettle,
  type PayDemSettlementAuditContext,
  type PayDemSettlementReconcile,
} from "../../src/rails/payDem.js";
import { demosNode, heldRail, resetDemosNode, sdkRail, sdkTransfers } from "../fixtures/demosNodeMock.js";

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

/**
 * A process whose bridge must only audit or reconcile, never submit: its rail
 * is the SDK's own, so `submit` is the node's transfer. A test that paid
 * earlier clears it first.
 */
async function auditingProcess(
  store: ReturnType<ReturnType<typeof processes>["store"]>,
  reconcile: PayDemSettlementReconcile,
) {
  const once = vi.spyOn(store, "once");
  const submit = demosNode.transfer;
  const settle = payDemSettle(await sdkRail(), {}, { store, reconcile });
  return { settle, once, submit };
}

/** The node's transfer never returns: the process died before it signed anything. */
const dieBeforeSigning = () => {
  demosNode.transfer.mockImplementation(() => new Promise<never>(() => undefined));
};

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
    // The rail signs, records and broadcasts, but the node never reports inclusion.
    const first = await payDemSettle(await heldRail(), {}, { store: run.store("A") })(request("job-a"));
    expect(first).toMatchObject({ ok: false, txHash: hashA });
    expect(first.errorClass).toBeUndefined();
    expect(sdkTransfers()).toBe(1);
    demosNode.transfer.mockClear();

    run.restart();
    const reconcile = vi.fn(async () => reply);
    const b = await auditingProcess(run.store("B"), reconcile);
    await expect(b.settle(request("job-a", hashA))).resolves.toMatchObject(expected);
    // Repeating the audit is read-only and gives the same answer.
    await expect(b.settle(request("job-a", hashA))).resolves.toMatchObject(expected);
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-a", txHash: hashA }));
    expect(b.once).not.toHaveBeenCalled();
    expect(b.submit).not.toHaveBeenCalled();
  });

  test("finishes a transfer whose process died after its pre-broadcast record and broadcast, with or without history", async () => {
    const run = processes();
    // The rail records the signed hash through the fence and broadcasts; the
    // node reports no inclusion, so the process learns no outcome.
    await payDemSettle(await heldRail(), {}, { store: run.store("A") })(request("job-a"));
    expect(demosNode.broadcast).toHaveBeenCalledTimes(1);
    await expect(run.log.readAttempt!("pay-dem:job-a:0")).resolves.toMatchObject({ txHash: hashA });
    demosNode.transfer.mockClear();

    run.restart();
    const audit = await auditingProcess(run.store("B"), vi.fn(async () => executed(hashA)));
    await expect(audit.settle(request("job-a", hashA, false))).resolves.toMatchObject({ ok: true, txHash: hashA });
    expect(audit.once).not.toHaveBeenCalled();

    // The session never saw the hash: the store's expired-lease reconciliation
    // asks for exactly the recorded transaction and persists it.
    const reconcile = vi.fn(async (context: Readonly<PayDemSettlementAuditContext>) => executed(context.txHash));
    const resumed = await auditingProcess(run.store("C"), reconcile as PayDemSettlementReconcile);
    await expect(resumed.settle(request("job-a"))).resolves.toMatchObject({ ok: true, txHash: hashA });
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-a", txHash: hashA }));
    expect(resumed.submit).not.toHaveBeenCalled();
    expect(demosNode.broadcast).toHaveBeenCalledTimes(1);
  });

  // The other side of the record: a rail that dies before it has signed,
  // broadcast or recorded anything. Proven absence alone never lets a restart
  // submit again; it stops for the operator.
  test("never resubmits after the SDK rail died before its record", async () => {
    const run = processes();
    dieBeforeSigning();
    void payDemSettle(await sdkRail(), {}, { store: run.store("A") })(request("job-a"));
    await vi.waitFor(() => expect(demosNode.transfer).toHaveBeenCalled());
    await expect(run.log.readAttempt!("pay-dem:job-a:0")).resolves.toBeNull();
    demosNode.transfer.mockClear();

    run.restart();
    const reconcile = vi.fn(async () => null);
    const resumed = await auditingProcess(run.store("B"), reconcile);
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
    demosNode.transfer.mockClear();

    run.restart();
    died = false;
    // Nothing reached the chain, so an honest reconciler finds nothing for the recorded hash.
    const reconcile = vi.fn(async () => null);
    const resumed = await auditingProcess(run.store("B"), reconcile);
    await expect(resumed.settle(request("job-a"))).rejects.toThrow(/absence alone cannot revoke a prior external effect/);
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-a", txHash: hashA }));
    const audit = await auditingProcess(run.store("C"), reconcile);
    await expect(audit.settle(request("job-a", hashA))).rejects.toThrow(/contradicts reconciliation proof of absence/);
    expect(resumed.submit).not.toHaveBeenCalled();
    expect(audit.submit).not.toHaveBeenCalled();
    expect(sdkTransfers()).toBe(0);
    expect(demosNode.broadcast).not.toHaveBeenCalled();
    await expect(log.readOutcome!("pay-dem:job-a:0")).resolves.toBeNull();
  });

  test("a restart reconciliation cannot answer another transfer than the one this key recorded", async () => {
    const run = processes();
    await payDemSettle(await heldRail(), {}, { store: run.store("A") })(request("job-a"));
    demosNode.transfer.mockClear();
    run.restart();
    // A by-key reconciler finds another job's same-amount transfer.
    const b = await auditingProcess(run.store("B"), vi.fn(async () => executed(hashB)));
    await expect(b.settle(request("job-a"))).rejects.toThrow(/does not match the retained transaction/);
    await expect(run.log.readOutcome!("pay-dem:job-a:0")).resolves.toBeNull();
    expect(b.submit).not.toHaveBeenCalled();
  });

  test("counts a record another process writes while the audit reads the chain", async () => {
    const run = processes();
    const reconcile = vi.fn(async () => {
      await payDemSettle(await heldRail(), {}, { store: run.store("A") })(request("job-a"));
      return executed(hashA);
    });
    const audit = await auditingProcess(run.store("B"), reconcile);
    await expect(audit.settle(request("job-a", hashA))).resolves.toMatchObject({ ok: true, txHash: hashA });
    // Only the writer's own transfer reached the node, not the audit.
    expect(sdkTransfers()).toBe(1);
  });
});

// The bridge's own result binds a hash only once the durable attempt record
// accepted it, and an audit always checks that record, so a refused write
// cannot leave a hash counted for this key in memory.
describe("pay-dem never binds a fresh result the attempt record refused", () => {
  test("an audit through the same bridge refuses the hash the record refused, and later calls keep the recorded one", async () => {
    const memory = createInMemorySettlementLog();
    // The log already holds B for this key when the rail records the hash it signed, A.
    const log: SettlementLog = {
      ...memory,
      putAttempt: async (input) => {
        await memory.putAttempt!({ ...input, txHash: hashB });
        return memory.putAttempt!(input);
      },
    };
    const run = processes(log);
    const reconcile = vi.fn(async (context: Readonly<PayDemSettlementAuditContext>) => executed(context.txHash));
    const settle = payDemSettle(await sdkRail(), {}, { store: run.store("A"), reconcile: reconcile as PayDemSettlementReconcile });
    await expect(settle(request("job-a"))).rejects.toThrow(/already records another transaction/);
    await expect(run.log.readAttempt!("pay-dem:job-a:0")).resolves.toMatchObject({ txHash: hashB });

    await expect(settle(request("job-a", hashA))).rejects.toThrow(
      /conflicts with this key's recorded attempt/,
    );
    // The audit remembers the recorded hash, not the refused one.
    await expect(settle(request("job-a", hashA))).rejects.toThrow(/different payment terms or transaction/);
    expect(reconcile).not.toHaveBeenCalledWith(expect.objectContaining({ txHash: hashA }));
    await expect(run.log.readOutcome!("pay-dem:job-a:0")).resolves.toBeNull();
    expect(sdkTransfers()).toBe(1);
    expect(demosNode.broadcast).not.toHaveBeenCalled();
  });

  test("after a restart, a history for another hash than the record is refused and its success claim is not kept", async () => {
    const run = processes();
    // The node signs hash B for this key's transfer and never reports inclusion.
    resetDemosNode({ payer, txHash: hashB });
    await payDemSettle(await heldRail(), {}, { store: run.store("A") })(request("job-a"));
    demosNode.transfer.mockClear();
    run.restart();
    const reconcile = vi.fn(async (context: Readonly<PayDemSettlementAuditContext>) => failed(context.txHash));
    const audit = await auditingProcess(run.store("B"), reconcile as PayDemSettlementReconcile);
    await expect(audit.settle(request("job-a", hashA, true))).rejects.toThrow(
      /conflicts with this key's recorded attempt/,
    );
    // The success the history claimed was for A, so B's failed record is reported.
    await expect(audit.settle(request("job-a"))).resolves.toMatchObject({
      ok: false, errorClass: "permanent", txHash: hashB,
    });
    expect(audit.submit).not.toHaveBeenCalled();
  });

  // A transfer that failed before it signed names no transaction: nothing is
  // recorded for it, so a later history hash is not this bridge's own, whatever
  // it names.
  test("a transfer that signed nothing never binds a later history hash through the same bridge", async () => {
    const run = processes();
    demosNode.transfer.mockRejectedValue(new Error("lost response"));
    const reconcile = vi.fn(async (context: Readonly<PayDemSettlementAuditContext>) => executed(context.txHash));
    const settle = payDemSettle(await sdkRail(), {}, { store: run.store("A"), reconcile: reconcile as PayDemSettlementReconcile });
    await expect(settle(request("job-a"))).rejects.toThrow("lost response");
    await expect(run.log.readAttempt!("pay-dem:job-a:0")).resolves.toBeNull();
    await expect(settle(request("job-a", hashB, true))).rejects.toThrow(
      /no SDK record binds the retained transaction to this payment/,
    );
    expect(reconcile).toHaveBeenCalledTimes(1);
    await expect(run.log.readOutcome!("pay-dem:job-a:0")).resolves.toBeNull();
    expect(sdkTransfers()).toBe(1);
  });

  test("a stale record write leaves the returned hash unbound for an audit through the same bridge", async () => {
    let now = 1_000;
    const log = createInMemorySettlementLog();
    const store = createIdempotencyStore(log, { owner: "A", leaseDurationMs: 1_000, now: () => now });
    // The node signs after the rail's generation expired, so the record is refused.
    const sign = demosNode.transfer.getMockImplementation()!;
    demosNode.transfer.mockImplementation(async (...args: unknown[]) => {
      now += 60_000;
      return sign(...args);
    });
    const reconcile = vi.fn(async () => executed(hashA));
    const settle = payDemSettle(await sdkRail(), {}, { store, reconcile });
    await expect(settle(request("job-a"))).rejects.toThrow(/attempt was produced by a stale generation/);
    await expect(log.readAttempt!("pay-dem:job-a:0")).resolves.toBeNull();

    await expect(settle(request("job-a", hashA, true))).rejects.toThrow(
      /no SDK record binds the retained transaction to this payment/,
    );
    await expect(log.readOutcome!("pay-dem:job-a:0")).resolves.toBeNull();
    expect(sdkTransfers()).toBe(1);
    expect(demosNode.broadcast).not.toHaveBeenCalled();
  });
});

// The store saves whatever a key-only restart reconciliation found, so that
// outcome is the reconciler's answer, not this key's own submit, and it never
// lets a later audit count the hash.
describe("pay-dem never binds a hash through an outcome a key-only reconciliation wrote", () => {
  test("an audit of job B refuses job A's hash that B's restart reconciliation saved", async () => {
    const run = processes();
    // Job B's first process claimed the intent and died before signing anything.
    dieBeforeSigning();
    void payDemSettle(await sdkRail(), {}, { store: run.store("A") })(request("job-b"));
    await vi.waitFor(() => expect(demosNode.transfer).toHaveBeenCalled());
    demosNode.transfer.mockClear();

    run.restart();
    // A careless reconciler finds job A's transfer of the same parties and amount.
    const restart = await auditingProcess(run.store("B"), vi.fn(async () => executed(hashA)));
    await expect(restart.settle(request("job-b"))).resolves.toMatchObject({ ok: true, txHash: hashA });
    await expect(run.log.readOutcome!("pay-dem:job-b:0")).resolves.toMatchObject({ result: { txHash: hashA } });

    run.restart();
    const audit = await auditingProcess(run.store("C"), vi.fn(async () => executed(hashA)));
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
    const audit = await auditingProcess(view(run.store("B")), vi.fn(async () => executed(hashA)));
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
    const audit = await auditingProcess(run.store("B"), reconcile);
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
    const audit = await auditingProcess(run.store("B"), vi.fn(async () => reply));
    await expect(audit.settle(req)).rejects.toThrow(error);
    await expect(run.log.readOutcome!("pay-dem:job-a:0")).resolves.toMatchObject({ result: { ok: true, txHash: hashA } });
    expect(audit.submit).not.toHaveBeenCalled();
  });

  test("a key the log saved no outcome for still fails closed", async () => {
    const run = processes(legacyLog());
    run.restart();
    const audit = await auditingProcess(run.store("B"), vi.fn(async () => executed(hashA)));
    await expect(audit.settle(request("job-a", hashA, true))).rejects.toThrow(
      /no SDK record binds the retained transaction to this payment/,
    );
    expect(audit.once).not.toHaveBeenCalled();
    expect(audit.submit).not.toHaveBeenCalled();
  });

  test("a new payment is refused before the rail runs, and the key is not held", async () => {
    const memory = createInMemorySettlementLog();
    const run = processes(legacyLog(memory));
    const rail = await sdkRail();
    await expect(payDemSettle(rail, { network: "demos" }, { store: run.store("A") })(request("job-a")))
      .rejects.toThrow(/records no attempt this bridge can read back; refusing to start a new transfer/);
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
    const b = await auditingProcess(run.store("B"), reconcile);
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
  ])("a transfer the node signs with the %s hash settles once and binds it", async (_label, exact, canonical) => {
    const run = processes();
    resetDemosNode({ payer, txHash: exact });
    await expect(payDemSettle(await heldRail(), {}, { store: run.store("A") })(request("job-a")))
      .resolves.toMatchObject({ ok: false, txHash: canonical });
    await expect(run.log.readAttempt!("pay-dem:job-a:0")).resolves.toMatchObject({ txHash: canonical });
    expect(demosNode.broadcast).toHaveBeenCalledTimes(1);
    demosNode.transfer.mockClear();

    run.restart();
    const audit = await auditingProcess(run.store("B"), vi.fn(async () => executed(canonical)));
    await expect(audit.settle(request("job-a", exact))).resolves.toMatchObject({ ok: true, txHash: canonical });
    expect(audit.submit).not.toHaveBeenCalled();
  });

  test.each([
    ["a value that is not hex", "not-a-transaction-hash"],
    ["a short hash", "56".repeat(31)],
    ["a padded hash", ` ${hashA}`],
  ])("a transfer the node signs with %s is refused before it broadcasts", async (_label, value) => {
    const run = processes();
    resetDemosNode({ payer, txHash: value });
    await expect(payDemSettle(await sdkRail(), {}, { store: run.store("A") })(request("job-a")))
      .rejects.toThrow();
    expect(demosNode.broadcast).not.toHaveBeenCalled();
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
    const audit = await auditingProcess(createIdempotencyStore(log), vi.fn(async () => executed(hashA)));
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

/** A durable log written before the read-only lookup existed: no `readOutcome`, no attempt pair. */
function claimOnlyLog(memory: SettlementLog = createInMemorySettlementLog()): SettlementLog {
  const { readOutcome: _read, putAttempt: _put, readAttempt: _attempt, ...rest } = memory;
  return rest;
}

// DACS-4 §9.5.1 PC-7 on a log without the optional `readOutcome`: the store's
// lookup reads through `claimIntent`, so a final payment it saved still
// completes after a restart, and a key it saved nothing for stays fail closed
// without being held or made fresh.
describe("pay-dem over a log without a read-only outcome lookup", () => {
  test("an audit after a restart completes a final payment the log saved, and submits nothing", async () => {
    const memory = createInMemorySettlementLog();
    const run = processes(claimOnlyLog(memory));
    await savedBeforeAttemptRecords(run.log, "job-a");

    run.restart();
    const reconcile = vi.fn(async () => executed(hashA));
    const audit = await auditingProcess(run.store("B"), reconcile);
    await expect(audit.settle(request("job-a", hashA, true)))
      .resolves.toMatchObject({ ok: true, txHash: hashA, blockNumber: 42 });
    await expect(audit.settle(request("job-a"))).resolves.toMatchObject({ ok: true, txHash: hashA });
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-a", txHash: hashA }));
    expect(audit.once).not.toHaveBeenCalled();
    expect(sdkTransfers()).toBe(0);
    expect(demosNode.broadcast).not.toHaveBeenCalled();
  });

  test("a key the log saved nothing for fails closed and is left free, never held", async () => {
    const memory = createInMemorySettlementLog();
    const run = processes(claimOnlyLog(memory));
    run.restart();
    const audit = await auditingProcess(run.store("B"), vi.fn(async () => executed(hashA)));
    await expect(audit.settle(request("job-a", hashA, true))).rejects.toThrow(
      /no SDK record binds the retained transaction to this payment/,
    );
    expect(sdkTransfers()).toBe(0);
    // The intent the lookup installed was released: a later claim is fresh, not held or expired.
    await expect(memory.claimIntent({
      key: "pay-dem:job-a:0", bindingHash: settlementBindingHash(bindingFor("job-a")),
      owner: "probe", now: 70_000, leaseDurationMs: 1_000,
    })).resolves.toMatchObject({ status: "acquired", lease: { stage: "fresh" } });
  });

  test("an expired attempt the log never resolved is refused and stays fenced for reconciliation", async () => {
    const memory = createInMemorySettlementLog();
    const run = processes(claimOnlyLog(memory));
    const bindingHash = settlementBindingHash(bindingFor("job-a"));
    // A pre-upgrade process claimed the key, may have broadcast, then died.
    await memory.claimIntent({ key: "pay-dem:job-a:0", bindingHash, owner: "A", now: 1_000, leaseDurationMs: 1_000 });

    run.restart();
    const audit = await auditingProcess(run.store("B"), vi.fn(async () => executed(hashA)));
    await expect(audit.settle(request("job-a", hashA, true))).rejects.toThrow(/expired unresolved attempt/);
    expect(sdkTransfers()).toBe(0);
    // Never released: once the audit's own lease lapses, the key still needs reconciliation.
    await expect(memory.claimIntent({
      key: "pay-dem:job-a:0", bindingHash, owner: "probe", now: 200_000, leaseDurationMs: 1_000,
    })).resolves.toMatchObject({ status: "acquired", lease: { stage: "reconcile" } });
  });
});

// A fresh transfer runs only when the fence the store hands `submit` carries
// the attempt recorder of the same `createIdempotencyStore` store whose own
// `readAttempt` this bridge reads: otherwise a restart could not bind its hash.
// Function identity on a wrapper is not trusted to say so.
describe("pay-dem starts a transfer only through a fence whose record a restart can read back", () => {
  const refused = /refusing to start a new transfer whose hash a restart could not bind/;
  type Store = ReturnType<typeof createIdempotencyStore>;

  test.each([
    ["a forwarding wrapper over a store whose log keeps no attempts", (): Store => {
      const inner = createIdempotencyStore(legacyLog());
      return {
        once: (...args) => inner.once(...args),
        readOutcome: (...args) => inner.readOutcome!(...args),
      };
    }],
    ["a host store over an SDK store's once and readOutcome", (): Store => {
      const inner = createIdempotencyStore();
      return { once: inner.once, readOutcome: inner.readOutcome };
    }],
    ["a store whose readAttempt belongs to another SDK store", (): Store => {
      const inner = createIdempotencyStore();
      return { once: inner.once, readOutcome: inner.readOutcome, readAttempt: createIdempotencyStore().readAttempt };
    }],
    ["a host store that hands submit no fence", (): Store => {
      const inner = createIdempotencyStore();
      return {
        once: async (_key, _binding, submit) => submit() as never,
        readOutcome: inner.readOutcome, readAttempt: inner.readAttempt,
      };
    }],
    ["a host store whose fence brings its own recorder", (): Store => {
      const inner = createIdempotencyStore();
      return {
        once: (key, binding, submit, reconcile) => inner.once(key, binding, async (fence) => submit(Object.freeze({
          ...fence!, recordAttempt: async (hash: string) => fence!.recordAttempt!(hash),
        })), reconcile),
        readOutcome: inner.readOutcome, readAttempt: inner.readAttempt,
      };
    }],
  ] as const)("refuses %s before the rail signs", async (_label, build) => {
    const store = build();
    await expect(payDemSettle(await sdkRail(), {}, { store })(request("job-a"))).rejects.toThrow(refused);
    expect(sdkTransfers()).toBe(0);
    expect(demosNode.broadcast).not.toHaveBeenCalled();
  });

  test("a store object carrying the SDK store's own once and readAttempt settles once and records the hash", async () => {
    const memory = createInMemorySettlementLog();
    const inner = createIdempotencyStore(memory);
    const store = { once: inner.once, readOutcome: inner.readOutcome, readAttempt: inner.readAttempt };
    await expect(payDemSettle(await sdkRail(), {}, { store })(request("job-a")))
      .resolves.toMatchObject({ ok: true, txHash: hashA });
    expect(sdkTransfers()).toBe(1);
    await expect(memory.readAttempt!("pay-dem:job-a:0")).resolves.toMatchObject({ txHash: hashA });
  });

  test("a second bridge sharing a refused attempt gets the same clear refusal", async () => {
    const store = createIdempotencyStore(legacyLog());
    const rail = await sdkRail();
    const results = await Promise.allSettled([
      payDemSettle(rail, {}, { store, reconcile: vi.fn(async () => null) })(request("job-a")),
      payDemSettle(rail, {}, { store, reconcile: vi.fn(async () => null) })(request("job-a")),
    ]);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      expect(String((result as PromiseRejectedResult).reason)).toMatch(refused);
    }
    expect(sdkTransfers()).toBe(0);
  });
});

// A mixed store: the outcome lookup of a store whose log keeps no attempts
// and the attempt lookup of one that does. Its outcomes never bind a hash,
// because this bridge reads attempt records through it.
describe("pay-dem never binds an outcome through a store that has an attempt lookup", () => {
  test("an outcome-only store's saved outcome does not bind beside another store's attempt lookup", async () => {
    const run = processes(legacyLog());
    await savedBeforeAttemptRecords(run.log, "job-a");
    run.restart();
    const outcomeOnly = run.store("B");
    const store = Object.assign(Object.create(null) as object, {
      once: outcomeOnly.once, readOutcome: outcomeOnly.readOutcome, readAttempt: createIdempotencyStore().readAttempt,
    }) as typeof outcomeOnly;
    const audit = await auditingProcess(store, vi.fn(async () => executed(hashA)));
    await expect(audit.settle(request("job-a", hashA, true)))
      .rejects.toThrow(/no SDK record binds the retained transaction to this payment/);
    expect(sdkTransfers()).toBe(0);
  });
});

import { describe, expect, test, vi } from "vitest";

import type { SettleRequest } from "../../src/agent/runSessionCore.js";
import {
  createIdempotencyStore,
  createInMemorySettlementLog,
  type SettlementEffectFence,
  type SettlementLog,
} from "../../src/rails/idempotency.js";
import {
  payDemSettle,
  type PayDemRail,
  type PayDemSettlementAuditContext,
  type PayDemSettlementReconcile,
} from "../../src/rails/payDem.js";

const hashA = "56".repeat(32);
const hashB = "78".repeat(32);
const payer = "ab".repeat(32);
const payee = "cd".repeat(32);
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

// DACS-4 §9.5.1 PC-7: a final payment MUST resume after any restart. The SDK
// records the hash this key's own submit produced, under the submit
// generation, so a later process can tie the retained hash to the payment
// without trusting the session's history or the reconciler.
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

  test("finishes a transfer whose process died after its pre-broadcast record, with or without history", async () => {
    const run = processes();
    // The rail records the signed hash through the fence, broadcasts, and the
    // process dies before the rail returns.
    const died = new Promise<never>(() => undefined);
    const rail: PayDemRail = {
      address: payer,
      settle: vi.fn(async (_params, fence?: Readonly<SettlementEffectFence>) => {
        await fence!.recordAttempt!(hashA);
        return died;
      }),
    };
    void payDemSettle(rail, {}, { store: run.store("A") })(request("job-a"));
    await vi.waitFor(() => expect(rail.settle).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));

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

  test("an audit over a log without attempt records fails closed after a restart", async () => {
    const memory = createInMemorySettlementLog();
    const legacy: SettlementLog = {
      readOutcome: (key) => memory.readOutcome!(key),
      claimIntent: (input) => memory.claimIntent(input),
      isCurrent: (input) => memory.isCurrent(input),
      grantRecovery: (input) => memory.grantRecovery(input),
      putOutcome: (input) => memory.putOutcome(input),
      releaseIntent: (input) => memory.releaseIntent(input),
    };
    const run = processes(legacy);
    const { amountOs: _amount, ...result } = executed(hashA);
    const rail: PayDemRail = { address: payer, settle: vi.fn(async () => result) };
    await expect(payDemSettle(rail, {}, { store: run.store("A") })(request("job-a")))
      .resolves.toMatchObject({ ok: true, txHash: hashA });

    run.restart();
    const audit = auditingProcess(run.store("B"), vi.fn(async () => executed(hashA)));
    await expect(audit.settle(request("job-a", hashA, true))).rejects.toThrow(
      /no SDK record binds the retained transaction to this payment/,
    );
    expect(audit.submit).not.toHaveBeenCalled();
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

  test("a log must provide both attempt methods or neither", () => {
    const log = createInMemorySettlementLog();
    const { putAttempt: _put, ...partial } = log;
    expect(() => createIdempotencyStore(partial as SettlementLog))
      .toThrow(/settlement log must provide both putAttempt and readAttempt/);
  });
});

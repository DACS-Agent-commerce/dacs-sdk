import { beforeEach, describe, expect, test, vi } from "vitest";

import type { SettleRequest, SettleResult, SettlementRecoveryAttempt } from "../../src/agent/runSessionCore.js";
import {
  createIdempotencyStore,
  createInMemorySettlementLog,
  type SettlementBinding,
  type SettlementIdempotencyStore,
} from "../../src/rails/idempotency.js";
import {
  payDemSettle,
  type PayDemSettlementAuditContext,
  type PayDemSettlementReconcile,
} from "../../src/rails/payDem.js";
import { demosNode, heldRail, resetDemosNode, sdkRail, sdkTransfers } from "../fixtures/demosNodeMock.js";
import { sdkFences } from "../fixtures/sdkFences.js";
import { seedSdkOutcome } from "../fixtures/settlementOutcomeSeed.js";

vi.mock("@kynesyslabs/demosdk/websdk", async () => (await import("../fixtures/demosNodeMock.js")).demosSdkModule());

type ReconcileContext = Parameters<PayDemSettlementReconcile>[0];

const txHash = "12".repeat(32);
const payer = "ab".repeat(32);
const payee = "cd".repeat(32);
const payeeClaim = `did:demos:agent:${payee}`;
beforeEach(() => resetDemosNode({ payer, txHash }));
const prior = (ok = true): SettlementRecoveryAttempt => ({ txHash, chainId: "demos", ok });
const request = (priorAttempts: readonly SettlementRecoveryAttempt[] = [prior()]): SettleRequest => ({
  rail: "pay-dem", phase: "pay-dem", phaseIndex: 0, jobId: "retained-native",
  amount: "1", asset: "DEM", payee: payeeClaim, expectedPayee: payeeClaim, priorAttempts,
});
// The prepared-transfer journal entry the rail wrote for this job's transfer.
const journal = (network = "demos") => ({
  txHash, nonce: 9, payer, payee, amountOs: "1000000000", denomination: "os" as const, network,
  recovery: { railId: "pay-dem", jobId: "retained-native", phaseIndex: 0,
    settlementKey: "pay-dem:retained-native:0", network, payer, payee, amountOs: "1000000000" },
});
const executed = () => ({
  ok: true as const, txHash, payer, payee, chainId: "demos", amountOs: "1000000000",
  blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" as const },
  networkFeeOs: "0", execution: "executed" as const, preparedTransfer: journal(),
});
const failed = () => ({
  ok: false as const, txHash, payer, payee, chainId: "demos", amountOs: "1000000000",
  blockNumber: 42, txRefKind: "demos", errorClass: "permanent" as const,
  failureProof: { kind: "demos-failed-record" as const, txHash, payer, payee,
    nonce: 9, blockNumber: 42, amountOs: "1000000000" },
  preparedTransfer: journal(),
});

async function fixture(
  reconcile?: PayDemSettlementReconcile,
  store: SettlementIdempotencyStore = createIdempotencyStore(),
) {
  const once = vi.spyOn(store, "once");
  // The SDK's own rail: a retained transfer must never reach its node.
  const submit = demosNode.transfer;
  const settle = payDemSettle(await sdkRail(), {}, { store, reconcile });
  return { settle, once, submit };
}

// The rail log of a bridge that settled this job with `outcome`: the SDK's
// own record of the hash for the key, which an audit needs to count it.
async function settledLog(outcome: ReturnType<typeof executed> | ReturnType<typeof failed>, network = "demos") {
  const log = createInMemorySettlementLog();
  const { amountOs: _amount, preparedTransfer: _journal, ...rest } = outcome;
  const { execution: _execution, ...result } = rest as typeof rest & { execution?: unknown };
  const { priorAttempts: _history, ...fresh } = request();
  // The rail signs and broadcasts but sees no inclusion, so it holds the hash
  // with the attempt recorded; the outcome is then written as a record-read
  // verdict would have left it.
  await seedSdkOutcome(log, { ...result, chainId: network }, async () =>
    payDemSettle(await heldRail(), { network },
      { store: createIdempotencyStore(log) })(fresh));
  resetDemosNode({ payer, txHash });
  return log;
}

// A bridge whose own submit for this key returned only the signed hash. Its
// record ties the hash to the key without saying whether the transfer executed.
async function signedOnly(reconcile: PayDemSettlementReconcile) {
  const store = createIdempotencyStore();
  const once = vi.spyOn(store, "once");
  const settle = payDemSettle(await heldRail(), {}, { store, reconcile });
  const { priorAttempts: _history, ...fresh } = request();
  await expect(settle(fresh)).resolves.toMatchObject({ ok: false, txHash });
  once.mockClear();
  resetDemosNode({ payer, txHash });
  return { settle, once, submit: demosNode.transfer };
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
      const log = await settledLog(outcome === "executed" ? executed() : failed());
      const first = await fixture(reconcile, createIdempotencyStore(log));
      const restarted = await fixture(reconcile, createIdempotencyStore(log));
      for (const f of [first, first, restarted]) {
        const pending = f.settle(request([prior(false), prior(ok)]));
        if (ok && outcome === "failed") {
          // PC-7: a success the session recorded is never reported unpaid.
          await expect(pending).rejects.toThrow(/contradicted an authenticated successful outcome/);
        } else {
          const result = await pending;
          expect(result).toMatchObject({ ok: outcome === "executed", txHash, payee: payeeClaim });
          expect(result).not.toHaveProperty("execution");
          expect(result).not.toHaveProperty("amountOs");
          expect(Object.isFrozen(result)).toBe(true);
          if (result.ok) expect(Object.isFrozen(result.finality)).toBe(true);
          else expect(result).not.toHaveProperty("finality");
        }
        expect(f.once).not.toHaveBeenCalled();
        expect(f.submit).not.toHaveBeenCalled();
      }
      expect(reconcile).toHaveBeenCalledTimes(3);
    },
  );

  test.each([true, false])("requires a reconciler for retained ok=%s before touching the log", async (ok) => {
    const store = createIdempotencyStore();
    const once = vi.spyOn(store, "once");
    const readOutcome = vi.spyOn(store, "readOutcome");
    const submit = demosNode.transfer;
    const settle = payDemSettle(await sdkRail(), {}, { store });
    await expect(settle(request([prior(ok)]))).rejects.toThrow(/requires read-only reconciliation/);
    expect(readOutcome).not.toHaveBeenCalled();
    expect(once).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  test("audits the canonical hash on a configured network at the history limit", async () => {
    const network = "demos:testnet";
    const store = createIdempotencyStore(await settledLog(executed(), network));
    const f = await fixture(undefined, store);
    const reconcile = vi.fn(async (context: ReconcileContext) => {
      expect(context).toMatchObject({ txHash, network });
      return { ...executed(), chainId: network, preparedTransfer: journal(network) };
    });
    const settle = payDemSettle(await sdkRail(), { network }, { store, reconcile });
    const history = Array.from({ length: 256 }, () => ({
      ...prior(), chainId: network, txHash: `0x${txHash.toUpperCase()}`,
    }));
    await expect(settle(request(history))).resolves.toMatchObject({ txHash, chainId: network });
    expect(f.once).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  const bindsTuple = /does not bind the exact pay-dem network, payer, and payee/;
  test.each([
    ["missing journal", /no SDK record binds the retained transaction/],
    ["conflicting journal hash", /journal does not bind the retained transaction/],
    ["conflicting journal tuple", /journal does not bind the retained transaction/],
    ["conflicting journal nonce", /does not match the journaled signed nonce/],
    ["unreadable journal", undefined], ["timeout", undefined],
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
      if (reply === "unreadable journal" || reply === "timeout") throw originalCause;
      if (reply === "missing journal") {
        const { preparedTransfer: _journal, ...unjournaled } = executed();
        return unjournaled;
      }
      if (reply === "conflicting journal hash") {
        return { ...executed(), preparedTransfer: { ...journal(), txHash: "34".repeat(32) } };
      }
      if (reply === "conflicting journal tuple") {
        return { ...executed(), preparedTransfer: { ...journal(),
          recovery: { ...journal().recovery, jobId: "other-job", settlementKey: "pay-dem:other-job:0" } } };
      }
      if (reply === "conflicting journal nonce") return { ...failed(), preparedTransfer: { ...journal(), nonce: 8 } };
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
    const f = await fixture(reconcile);
    const req = request();
    const before = structuredClone(req);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const pending = expect(f.settle(req)).rejects;
      if (message === undefined) await pending.toBe(originalCause);
      else await pending.toThrow(message);
    }
    expect(req).toEqual(before);
    expect(reconcile).toHaveBeenCalledTimes(2);
    // An answer the audit could not bind is handed to the store's own `once`,
    // which finds nothing to finish; no rail runs for it.
    if (reply !== "missing journal") expect(f.once).not.toHaveBeenCalled();
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
    const f = await fixture(reconcile);
    await expect(f.settle(request(history as readonly SettlementRecoveryAttempt[]))).rejects.toThrow(message);
    expect(reconcile).not.toHaveBeenCalled();
    expect(f.once).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  test("captures history before an asynchronous audit and binds the captured hash", async () => {
    const attempt = prior();
    const history = [attempt];
    const f = await fixture(async () => {
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
    const f = await fixture(async () => executed());
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
    const f = await fixture(reconcile, createIdempotencyStore(await settledLog(executed())));
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
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => failed());
    const store = createIdempotencyStore();
    const once = vi.spyOn(store, "once");
    const settle = payDemSettle(await sdkRail(), { network: "demos" }, { store, reconcile });
    const { priorAttempts: _history, ...fresh } = request();
    await expect(settle(fresh)).resolves.toMatchObject({ ok: true });
    for (const req of [request([prior(false)]), request(), fresh]) {
      await expect(settle(req)).rejects.toThrow(/contradicted an authenticated successful outcome/);
    }
    // The contradiction was not recorded: a confirming audit still reports A paid.
    reconcile.mockImplementation(async () => executed());
    await expect(settle(fresh)).resolves.toMatchObject({ ok: true, txHash, blockNumber: 42 });
    expect(sdkTransfers()).toBe(1);
    expect(once).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(4);
  });
});

// DACS-4 §9.5.1 PC-7: once the rail, its log or the session recorded a final
// payment, a later observation may fail to confirm it but can never report it
// unpaid. Every read path refuses the demotion and keeps the recorded success.
describe("pay-dem never reports a recorded success as a permanent failure", () => {
  const key = "pay-dem:retained-native:0";
  const binding: SettlementBinding = {
    bindingVersion: "1", railId: "pay-dem", jobId: "retained-native", phaseIndex: 0,
    phase: "pay-dem", amount: "1000000000", agreementAsset: "DEM", settlementAsset: "DEM",
    payer, payee, network: "demos", finality: { model: "bft-final" },
  };
  const { amountOs: _amount, execution: _execution, preparedTransfer: _journal, ...storedSuccess } = executed();
  const demoted = /contradicted an authenticated successful outcome/;

  test("refuses a failed reconciliation of a session-recorded success, even after history is omitted", async () => {
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => failed());
    // Only the session records a success; the bridge's own record binds the hash.
    const f = await signedOnly(reconcile);
    const { priorAttempts: _history, ...withoutHistory } = request();
    for (const req of [request([prior(true)]), request([prior(false)]), withoutHistory]) {
      await expect(f.settle(req)).rejects.toThrow(demoted);
    }
    expect(reconcile).toHaveBeenCalledTimes(3);
    expect(f.once).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
    // A prior non-success may still become a success after finality.
    reconcile.mockImplementation(async () => executed());
    await expect(f.settle(request([prior(false)]))).resolves.toMatchObject({ ok: true, txHash });
  });

  test("a success an earlier audit authenticated is never demoted by a later audit", async () => {
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => executed());
    const f = await signedOnly(reconcile);
    await expect(f.settle(request([prior(false)]))).resolves.toMatchObject({ ok: true, txHash });
    // The session still holds only the earlier non-success; the chain reader now disagrees.
    reconcile.mockImplementation(async () => failed());
    await expect(f.settle(request([prior(false)]))).rejects.toThrow(demoted);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(f.once).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  test.each([false, true])("keeps a durable success on restart (history=%s)", async (withHistory) => {
    const log = createInMemorySettlementLog();
    await createIdempotencyStore(log).once(key, binding, async () => storedSuccess as SettleResult);
    const claimIntent = vi.spyOn(log, "claimIntent");
    const putOutcome = vi.spyOn(log, "putOutcome");
    const store = createIdempotencyStore(log);
    const submit = demosNode.transfer;
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => failed());
    const settle = payDemSettle(await sdkRail(), {}, { store, reconcile });
    const { priorAttempts: _history, ...withoutHistory } = request();
    // Without history the restart path compares the durable outcome itself.
    await expect(settle(withHistory ? request([prior(false)]) : withoutHistory))
      .rejects.toThrow(withHistory ? demoted : /contradicts the authoritative reconciled outcome/);
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
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => failed());
    const settle = payDemSettle(await sdkRail(), { network: "demos" }, { store, reconcile });
    const { priorAttempts: _history, ...fresh } = request();
    await expect(settle(fresh)).rejects.toBe(lost);
    now += 2_000;
    await expect(settle(fresh)).rejects.toThrow(demoted);
    expect(putOutcome).toHaveBeenCalledTimes(1);
    reconcile.mockImplementation(async () => executed());
    now += 2_000;
    await expect(settle(fresh)).resolves.toMatchObject({ ok: true, txHash });
    await expect(store.readOutcome!(key, binding)).resolves.toEqual(storedSuccess);
    expect(sdkTransfers()).toBe(1);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  // The cached-outcome path: a store answers another writer's failure for this
  // key after this bridge's own record-verified success, and the
  // reconciliation agrees with that failure. The success still stands.
  test("a cached failure the reconciliation agrees with cannot demote this bridge's success", async () => {
    let cached: SettleResult | undefined;
    const fences = sdkFences();
    const store = {
      once: vi.fn(async (key: string, binding: SettlementBinding, run: Parameters<typeof fences.run>[2]) =>
        cached ?? fences.run(key, binding, run)),
      readOutcome: fences.readOutcome,
      readAttempt: fences.readAttempt,
    };
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => failed());
    const settle = payDemSettle(await sdkRail(), { network: "demos" }, { store: store as never, reconcile });
    const { priorAttempts: _history, ...fresh } = request();
    await expect(settle(fresh)).resolves.toMatchObject({ ok: true, txHash });
    const { amountOs: _amount, preparedTransfer: _journal, ...storedFailure } = failed();
    cached = storedFailure as SettleResult;
    await expect(settle(fresh)).rejects.toThrow(demoted);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(sdkTransfers()).toBe(1);
  });

  test("another writer's reconciled failure cannot demote this bridge's success", async () => {
    const log = createInMemorySettlementLog();
    let now = 1_000;
    const options = { now: () => now, leaseDurationMs: 1_000 };
    let finish!: () => void;
    let started!: () => void;
    const submitted = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    // The rail has recorded its hash and broadcast; it waits for inclusion.
    demosNode.nodeCall.mockImplementation(async () => {
      started();
      await gate;
      return { state: "included", blockNumber: 42 };
    });
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => failed());
    const settle = payDemSettle(await sdkRail(), { network: "demos" },
      { store: createIdempotencyStore(log, { ...options, owner: "a" }), reconcile });
    const { priorAttempts: _history, ...fresh } = request();
    const slow = settle(fresh);
    await submitted;
    // The lease expires and another process reconciles a failure. A reconciled
    // failure is never recorded as the definitive outcome, so nothing is cached.
    now += 2_000;
    const other = payDemSettle(await sdkRail(), {}, { store: createIdempotencyStore(log, { ...options, owner: "b" }), reconcile });
    await expect(other(fresh)).rejects.toThrow(/reconciliation was not definitive/);
    finish();
    // The rail recorded its hash under its own generation before it broadcast;
    // the superseded generation can no longer write the outcome.
    await expect(slow).rejects.toThrow(/outcome was produced by a stale generation/);
    // The other writer's lease has expired too: the reconciled failure is
    // refused against the success this bridge authenticated.
    now += 2_000;
    await expect(settle(fresh)).rejects.toThrow(demoted);
    expect(sdkTransfers()).toBe(1);
  });
});

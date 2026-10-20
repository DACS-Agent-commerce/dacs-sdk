import { beforeEach, describe, expect, test, vi } from "vitest";

import type { SettleRequest, SettleResult, SettlementRecoveryAttempt } from "../../src/agent/runSessionCore.js";
import {
  createIdempotencyStore,
  createInMemorySettlementLog,
  type SettlementIdempotencyStore,
} from "../../src/rails/idempotency.js";
import {
  payDemSettle,
  type PayDemRail,
  type PayDemSettlementReconcile,
} from "../../src/rails/payDem.js";
import { demosNode, nodeRecord, sdkPayDemRail } from "../fixtures/demosNodeScript.js";

vi.mock("@kynesyslabs/demosdk/websdk", async () =>
  (await import("../fixtures/demosNodeScript.js")).demosWebsdkMock);

const txHash = "12".repeat(32);
const payer = "ab".repeat(32);
const payee = "cd".repeat(32);
const payeeClaim = `did:demos:agent:${payee}`;

// The SDK's own rail over a scripted node: wallet `ab…` signs `12…` at nonce 9,
// and the node includes it at block 42 with a 0 OS fee. Only this rail's
// verdicts are final, fresh or recovered (#338). `submit` sees every transfer.
let rail: PayDemRail;
const submit = vi.fn();
beforeEach(async () => {
  demosNode.reset();
  Object.assign(demosNode, { address: payer, nextHash: txHash, feeOs: "0", onTransfer: submit });
  submit.mockReset();
  rail = await sdkPayDemRail();
});
/** The node serves this record for the retained hash. */
const nodeSays = (status: "confirmed" | "failed" | "pending") => {
  demosNode.records.set(txHash, nodeRecord({ txHash, payer, payee, amountOs: "1000000000", status, feeOs: "0" }));
};
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
// A reconciler's claim. The scripted node serves the same outcome when the
// claim is made, so these tests reach the checks after the SDK's own read;
// "a reconciler's claim the node contradicts" pins that read itself.
const executed = () => {
  nodeSays("confirmed");
  return {
    ok: true as const, txHash, payer, payee, chainId: "demos", amountOs: "1000000000",
    blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" as const },
    networkFeeOs: "0", execution: "executed" as const, preparedTransfer: journal(),
  };
};
const failed = () => {
  nodeSays("failed");
  return {
    ok: false as const, txHash, payer, payee, chainId: "demos", amountOs: "1000000000",
    blockNumber: 42, txRefKind: "demos", errorClass: "permanent" as const,
    failureProof: { kind: "demos-failed-record" as const, txHash, payer, payee,
      nonce: 9, blockNumber: 42, amountOs: "1000000000" },
    preparedTransfer: journal(),
  };
};

function fixture(
  reconcile?: PayDemSettlementReconcile,
  store: SettlementIdempotencyStore = createIdempotencyStore(),
) {
  const once = vi.spyOn(store, "once");
  const settle = payDemSettle(rail, {}, { store, reconcile });
  return { settle, once, submit };
}

// The rail log of the SDK rail's bridge that settled this job with `outcome`:
// the SDK's own record of the hash for the key, which an audit needs to count it.
async function settledLog(outcome: "executed" | "failed", network = "demos") {
  const log = createInMemorySettlementLog();
  const { priorAttempts: _history, ...fresh } = request();
  demosNode.recordStatus = outcome === "executed" ? "confirmed" : "failed";
  await expect(payDemSettle(network === "demos" ? rail : await sdkPayDemRail(network), { network },
    { store: createIdempotencyStore(log) })(fresh)).resolves.toMatchObject({ ok: outcome === "executed" });
  submit.mockClear();
  return log;
}

// A reconciler's `execution: "executed"` is its claim. The verdict of every
// recovery path is the SDK rail's own read of the node's record for the hash.
describe("a recovered pay-dem verdict is the SDK rail's own read of the node record", () => {
  type Script = "failed" | "pending" | "at another block" | "for another payee" | "with another fee" | "absent";
  const scripts: Record<Script, (record: Record<string, unknown>) => unknown> = {
    "failed": (record) => ({ ...record, status: "failed" }),
    "pending": (record) => ({ ...record, status: "pending" }),
    "at another block": (record) => ({ ...record, blockNumber: 43 }),
    "for another payee": () => nodeRecord({ txHash, payer, payee: "ef".repeat(32), amountOs: "1000000000", feeOs: "0" }),
    "with another fee": (record) => ({ ...record, content: { ...(record.content as object),
      transaction_fee: { network_fee: "1", rpc_fee: "0", additional_fee: "0" } } }),
    "absent": () => null,
  };
  const messages: Record<Script, RegExp> = {
    "failed": /contradicts the node record the SDK read/,
    "pending": /could not establish the node record .*no terminal execution status/,
    "at another block": /contradicts the node record the SDK read/,
    "for another payee": /could not establish the node record .*does not match the payment/,
    "with another fee": /contradicts the node record the SDK read/,
    "absent": /could not establish the node record .*missing or malformed/,
  };
  // The reconciler claims execution; then the node serves the scripted record.
  const claimAgainst = (script: Script) => vi.fn<PayDemSettlementReconcile>(async () => {
    const claim = executed();
    demosNode.records.set(txHash, scripts[script](demosNode.records.get(txHash) as Record<string, unknown>));
    return claim;
  });
  const paths = (Object.keys(scripts) as Script[]).flatMap((node) =>
    (["retained-hash audit", "restart re-check", "lookup by key"] as const).map((path) => ({ node, path })));

  test.each(paths)("refuses an executed claim on the $path when the node's record is $node", async ({ node, path }) => {
    const reconcile = claimAgainst(node);
    const { priorAttempts: _history, ...fresh } = request();
    let settle: (req: SettleRequest) => Promise<SettleResult>;
    if (path === "lookup by key") {
      // A transfer whose response was lost: only the intent is in the log.
      const log = createInMemorySettlementLog();
      await expect(payDemSettle({ address: payer, settle: async () => { throw new Error("response lost"); } }, {},
        { store: createIdempotencyStore(log, { owner: "a", now: () => 1, leaseDurationMs: 1 }) })(fresh))
        .rejects.toThrow("response lost");
      settle = payDemSettle(rail, {}, {
        store: createIdempotencyStore(log, { owner: "b", now: () => 3, leaseDurationMs: 1 }), reconcile });
    } else {
      settle = fixture(reconcile, createIdempotencyStore(await settledLog("executed"))).settle;
    }
    await expect(settle(path === "retained-hash audit" ? request() : fresh)).rejects.toThrow(messages[node]);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(demosNode.reads).toContain(txHash);
    expect(submit).not.toHaveBeenCalled();
  });

  test("holds every recovered verdict of a rail the SDK did not build, even one wrapping the SDK rail", async () => {
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => executed());
    const { priorAttempts: _history, ...fresh } = request();
    for (const custom of [
      { address: payer, settle: vi.fn(async () => ({ ok: false as const, txHash, payer, payee, chainId: "demos" })) },
      { address: payer, settle: vi.fn((...args: Parameters<PayDemRail["settle"]>) => rail.settle(...args)) },
    ]) {
      demosNode.recordStatus = "pending";
      const settle = payDemSettle(custom, {}, { store: createIdempotencyStore(), reconcile });
      await expect(settle(fresh)).resolves.toMatchObject({ ok: false, txHash });
      // The bridge bound the hash itself, yet its audit returns no verdict.
      const audited = await settle(request());
      expect(audited).toMatchObject({ ok: false, txHash });
      expect(audited).not.toHaveProperty("finality");
      expect(audited).not.toHaveProperty("errorClass");
    }
    // A lookup by key over such a rail is never definitive either.
    const log = createInMemorySettlementLog();
    const lost = { address: payer, settle: async () => { throw new Error("response lost"); } };
    await expect(payDemSettle(lost, {}, { store: createIdempotencyStore(log,
      { owner: "a", now: () => 1, leaseDurationMs: 1 }) })(fresh)).rejects.toThrow("response lost");
    await expect(payDemSettle(lost, {}, { store: createIdempotencyStore(log,
      { owner: "b", now: () => 3, leaseDurationMs: 1 }), reconcile })(fresh))
      .rejects.toThrow(/reconciliation was not definitive/);
  });
});

describe("a by-key failed record another writer finds is never this key's outcome", () => {
  test("another writer's by-key failed record is never recorded, and a stalled writer never broadcasts", async () => {
    const log = createInMemorySettlementLog();
    let now = 1_000;
    const options = { now: () => now, leaseDurationMs: 1_000 };
    let finish!: () => void;
    let started!: () => void;
    const submitted = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    // The transfer is signed, then stalls before its broadcast.
    submit.mockImplementation(async () => {
      started();
      await gate;
    });
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => failed());
    const settle = payDemSettle(rail,
      {}, { store: createIdempotencyStore(log, { ...options, owner: "a" }), reconcile });
    const { priorAttempts: _history, ...fresh } = request();
    const slow = settle(fresh);
    await submitted;
    // The lease expires and another process reconciles by key: a failed record
    // it finds that way is never this key's outcome, so nothing is recorded.
    now += 2_000;
    const other = payDemSettle(rail,
      {}, { store: createIdempotencyStore(log, { ...options, owner: "b" }), reconcile });
    await expect(other(fresh)).rejects.toThrow(/reconciliation was not definitive/);
    finish();
    // The stalled writer lost its generation, so it never broadcasts.
    await expect(slow).rejects.toThrow(/attempt was produced by a stale generation/);
    expect(demosNode.broadcasts).toBe(0);
    // The other writer's held generation is never resubmitted or demoted.
    await expect(settle(fresh)).rejects.toThrow(/in-flight current generation; refusing to resubmit/);
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

import { readFileSync } from "node:fs";

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
  type Script = "failed" | "pending" | "at another block" | "for another payee" | "with another fee" |
    "with a malformed fee" | "absent";
  const withFee = (record: Record<string, unknown>, transaction_fee: unknown) =>
    ({ ...record, content: { ...(record.content as object), transaction_fee } });
  const scripts: Record<Script, (record: Record<string, unknown>) => unknown> = {
    "failed": (record) => ({ ...record, status: "failed" }),
    "pending": (record) => ({ ...record, status: "pending" }),
    "at another block": (record) => ({ ...record, blockNumber: 43 }),
    "for another payee": () => nodeRecord({ txHash, payer, payee: "ef".repeat(32), amountOs: "1000000000", feeOs: "0" }),
    // The node serves a large fee component as a decimal string.
    "with another fee": (record) => withFee(record, { network_fee: "1", rpc_fee: "0", additional_fee: "0" }),
    // Not an OS amount in either served form: never read as "no fee".
    "with a malformed fee": (record) => withFee(record, { network_fee: 0.5, rpc_fee: 0, additional_fee: 0 }),
    "absent": () => null,
  };
  const messages: Record<Script, RegExp> = {
    "failed": /contradicts the node record the SDK read/,
    "pending": /could not establish the node record .*no terminal execution status/,
    "at another block": /contradicts the node record the SDK read/,
    "for another payee": /could not establish the node record .*does not match the payment/,
    "with another fee": /contradicts the node record the SDK read/,
    "with a malformed fee": /could not establish the node record .*transaction record fee is malformed/,
    // node2 serves a hash from before its reset as not found.
    "absent": /could not establish the node record .*transaction record was not found/,
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

// After the denomination fork the transaction query serves each
// `transaction_fee` component as an OS number (node2's recorded envelope
// carries `network_fee: 1000000000`), while the transfer the SDK signed carries
// decimal strings. A fee the session saved from the signed transfer must be
// re-read from that served record, or a paid session can never complete.
describe("a recovered pay-dem verdict reads node2's recorded record, numeric fee and all", () => {
  const node2 = JSON.parse(readFileSync(
    new URL("../fixtures/demos-node2-records.json", import.meta.url), "utf8",
  )) as { getTxByHash: Record<string, { response: Record<string, unknown> }> };
  const hash = "330dcf1dac0839ebc138d5e2a0db6db7b9567d769c8d4bd987b0d72d7d905918";
  const node2Payer = "c0a58599ceaeba18f9c450133631cce4c45f4dc7a59c8026331504da3a913c2a";
  const node2Payee = "706b89f5e2d56498a90bc3a209842b0bd0e22ce06bb4df7c27805e655614e5f1";
  // 1 DEM network fee + 1 DEM rpc fee, as the node2 record carries them.
  const feeOs = "2000000000";
  const ask = (priorAttempts?: readonly SettlementRecoveryAttempt[]): SettleRequest => ({
    rail: "pay-dem", phase: "pay-dem", phaseIndex: 0, jobId: "node2-native", amount: "9.5", asset: "DEM",
    payee: `did:demos:agent:${node2Payee}`, expectedPayee: `did:demos:agent:${node2Payee}`,
    ...(priorAttempts === undefined ? {} : { priorAttempts }),
  });
  const claim = (echoFee: boolean) => vi.fn<PayDemSettlementReconcile>(async () => ({
    ok: true, txHash: hash, payer: node2Payer, payee: node2Payee, chainId: "demos", amountOs: "9500000000",
    blockNumber: 498447, txRefKind: "demos", finality: { model: "bft-final" }, execution: "executed",
    ...(echoFee ? { networkFeeOs: feeOs } : {}),
    preparedTransfer: { txHash: hash, nonce: 28, payer: node2Payer, payee: node2Payee, amountOs: "9500000000",
      denomination: "os", network: "demos", recovery: { railId: "pay-dem", jobId: "node2-native", phaseIndex: 0,
        settlementKey: "pay-dem:node2-native:0", network: "demos", payer: node2Payer, payee: node2Payee,
        amountOs: "9500000000" } },
  }));
  beforeEach(async () => {
    // The SDK rail signs node2's transfer with the decimal-string fee it quotes.
    Object.assign(demosNode, { address: node2Payer, nextHash: hash, nonce: 28, blockNumber: 498447, feeOs });
    rail = await sdkPayDemRail();
  });
  const servesNode2 = () => {
    const served = structuredClone(node2.getTxByHash[hash]!.response);
    expect((served.content as { transaction_fee: unknown }).transaction_fee)
      .toMatchObject({ network_fee: 1000000000, rpc_fee: 1000000000, additional_fee: 0 });
    demosNode.records.set(hash, served);
  };

  test.each([
    ...(["retained-hash audit", "restart re-check", "lookup by key"] as const)
      .flatMap((path) => [true, false].map((echoFee) => ({ path, echoFee }))),
  ])("completes the $path with the record's fee (reconciler echoes it: $echoFee)", async ({ path, echoFee }) => {
    const reconcile = claim(echoFee);
    const log = createInMemorySettlementLog();
    if (path === "lookup by key") {
      // A transfer whose response was lost: only the intent is in the log.
      await expect(payDemSettle({ address: node2Payer, settle: async () => { throw new Error("response lost"); } },
        {}, { store: createIdempotencyStore(log, { owner: "a", now: () => 1, leaseDurationMs: 1 }) })(ask()))
        .rejects.toThrow("response lost");
    } else {
      await expect(payDemSettle(rail, {}, { store: createIdempotencyStore(log) })(ask()))
        .resolves.toMatchObject({ ok: true, txHash: hash, networkFeeOs: feeOs });
    }
    submit.mockClear();
    servesNode2();
    const settle = payDemSettle(rail, {}, { reconcile, store: path === "lookup by key"
      ? createIdempotencyStore(log, { owner: "b", now: () => 3, leaseDurationMs: 1 })
      : createIdempotencyStore(log) });
    await expect(settle(path === "retained-hash audit" ? ask([{ txHash: hash, chainId: "demos", ok: true }]) : ask()))
      .resolves.toMatchObject({ ok: true, txHash: hash, blockNumber: 498447, networkFeeOs: feeOs });
    expect(demosNode.reads).toContain(hash);
    expect(submit).not.toHaveBeenCalled();
  });
});

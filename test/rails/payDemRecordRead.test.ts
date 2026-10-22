import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, test, vi } from "vitest";

import type { SettleRequest, SettleResult, SettlementRecoveryAttempt } from "../../src/agent/runSessionCore.js";
import {
  createIdempotencyStore,
  createInMemorySettlementLog,
  type SettlementIdempotencyStore,
  type SettlementLog,
} from "../../src/rails/idempotency.js";
import {
  isPayDemRecordVerifyingRail,
  isPayDemSettleAdapter,
  isRecordVerifiedSource,
  payDemRecordVerifiedTransfer,
  payDemSettle,
  readPayDemTransferRecord,
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

// A transfer whose response was lost: the SDK rail's transfer throws before it
// signs, so only the intent is in the log. Its lease (owner "a") has expired by
// the time owner "b" looks the key up.
async function lostResponse(log: SettlementLog, req: SettleRequest) {
  submit.mockImplementationOnce(async () => { throw new Error("response lost"); });
  await expect(payDemSettle(rail, {}, {
    store: createIdempotencyStore(log, { owner: "a", now: () => 1, leaseDurationMs: 1 }),
  })(req)).rejects.toThrow("response lost");
  submit.mockClear();
}

// A transfer the SDK rail signed, recorded and broadcast, but whose inclusion
// it never saw: the attempt record names the hash and no outcome is saved.
// Owner "a"'s lease has expired by the time owner "b" looks the key up.
async function unseenBroadcast(log: SettlementLog, req: SettleRequest) {
  demosNode.recordsBroadcasts = false;
  await expect(payDemSettle(await sdkPayDemRail(undefined, { inclusionTimeoutMs: 1 }), {}, {
    store: createIdempotencyStore(log, { owner: "a", now: () => 1, leaseDurationMs: 1 }),
  })(req)).resolves.toMatchObject({ ok: false });
  demosNode.recordsBroadcasts = true;
  submit.mockClear();
}

describe("same-adapter cached outcomes require a fresh node record", () => {
  const cases = [true, false].flatMap((ok) => [true, false].flatMap((history) =>
    ["matching", "opposite", "missing", "pending", "block", ok ? "fee" : "nonce"].map((observation) =>
      ({ ok, history, observation }))));

  test.each(cases)("saved ok=$ok, history=$history, node=$observation", async ({ ok, history, observation }) => {
    const { priorAttempts: _history, ...fresh } = request();
    const settle = payDemSettle(rail, {}, { store: createIdempotencyStore() });
    demosNode.recordStatus = ok ? "confirmed" : "failed";
    const saved = await settle(fresh);
    expect(saved).toMatchObject({ ok, txHash });
    const original = structuredClone(demosNode.records.get(txHash)) as Record<string, unknown>;
    const content = original.content as Record<string, unknown>;
    const changed = observation === "missing" ? null : {
      ...original,
      ...(observation === "opposite" ? { status: ok ? "failed" : "confirmed" } : {}),
      ...(observation === "pending" ? { status: "pending" } : {}),
      ...(observation === "block" ? { blockNumber: 43 } : {}),
      ...(observation === "nonce" ? { content: { ...content, nonce: "10" } } : {}),
      ...(observation === "fee" ? { content: { ...content,
        transaction_fee: { network_fee: 1, rpc_fee: 0, additional_fee: 0 } } } : {}),
    };
    demosNode.records.set(txHash, changed);
    demosNode.reads = [];
    const audit = () => settle(history ? request([prior(ok)]) : fresh);
    if (observation === "matching") await expect(audit()).resolves.toEqual(saved);
    else {
      await expect(audit()).rejects.toThrow(/node record/);
      // An unavailable or conflicting read never poisons the saved outcome.
      demosNode.records.set(txHash, original);
      await expect(audit()).resolves.toEqual(saved);
    }
    expect(demosNode.reads.length).toBeGreaterThan(0);
    expect(demosNode.reads.every((hash) => hash === txHash)).toBe(true);
    expect(demosNode.transfers).toBe(1);
    expect(demosNode.broadcasts).toBe(1);
  });
});

describe("fresh and recovered failed records use the same fee validation", () => {
  test.each([
    { label: "null", fee: null, malformed: true },
    { label: "empty object", fee: {}, malformed: true },
    { label: "array", fee: [], malformed: true },
    { label: "absent", fee: undefined, malformed: false },
    { label: "zero", fee: { network_fee: 0, rpc_fee: 0, additional_fee: 0 }, malformed: false },
    { label: "decimal strings", fee: { network_fee: "5", rpc_fee: "0", additional_fee: "0" }, malformed: false },
  ])("fee $label", async ({ fee, malformed }) => {
    demosNode.recordStatus = "failed";
    demosNode.reply = (hash) => {
      const record = structuredClone(demosNode.records.get(hash)) as Record<string, unknown>;
      const content = { ...(record.content as Record<string, unknown>) };
      if (fee === undefined) delete content.transaction_fee;
      else content.transaction_fee = fee;
      return { ...record, content };
    };
    const log = createInMemorySettlementLog();
    const store = createIdempotencyStore(log);
    const reconcile: PayDemSettlementReconcile = async () => failed();
    const settle = payDemSettle(rail, {}, { store, reconcile });
    const { priorAttempts: _history, ...fresh } = request();
    const outcome = await settle(fresh);
    expect(outcome.ok).toBe(false);
    if (malformed) {
      expect(outcome.errorClass).toBeUndefined();
      expect(outcome.failureProof).toBeUndefined();
      expect(await log.readOutcome!("pay-dem:retained-native:0")).toBeNull();
    } else {
      expect(outcome.errorClass).toBe("permanent");
      expect(outcome.failureProof).toBeDefined();
    }
    // Repeat in process and reopen the same log with a fresh bridge. Both
    // reads see the identical fee served during the initial payment.
    for (const audit of [settle, payDemSettle(await sdkPayDemRail(), {}, {
      store: createIdempotencyStore(log), reconcile,
    })]) {
      const result = audit({ ...request([prior(false)]), recoveryOnly: true });
      if (malformed) await expect(result).rejects.toThrow(/fee is malformed/);
      else await expect(result).resolves.toMatchObject({ ok: false, errorClass: "permanent" });
    }
    expect(demosNode.transfers).toBe(1);
    expect(demosNode.broadcasts).toBe(1);
  });
});

// A reconciler's `execution: "executed"` is its claim. The verdict of every
// recovery path is the SDK rail's own read of the node's record for the hash.
describe("a recovered pay-dem verdict is the SDK rail's own read of the node record", () => {
  type Script = "failed" | "pending" | "at another block" | "for another payee" | "with another fee" |
    "with a malformed fee" | "with a negative fee" | "with a non-canonical fee" | "with an unsafe fee" |
    "with a null fee" | "with an empty fee" | "with a fee list" | "absent" | "absent at node 61b8e75";
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
    "with a negative fee": (record) => withFee(record, { network_fee: -1, rpc_fee: 0, additional_fee: 0 }),
    "with a non-canonical fee": (record) => withFee(record, { network_fee: "01", rpc_fee: 0, additional_fee: 0 }),
    // Beyond the safe range a number is no exact JSON value: the read stops there.
    "with an unsafe fee": (record) => withFee(record, { network_fee: 1e16, rpc_fee: 0, additional_fee: 0 }),
    // A fee that is present is never "no fee", whatever its shape.
    "with a null fee": (record) => withFee(record, null),
    "with an empty fee": (record) => withFee(record, {}),
    "with a fee list": (record) => withFee(record, [0, 0, 0]),
    "absent": () => null,
    // The cited node commit answers not-found as `{result: 400, response:
    // "error"}`, which demosdk unwraps to "error".
    "absent at node 61b8e75": () => "error",
  };
  const messages: Record<Script, RegExp> = {
    "failed": /contradicts the node record the SDK read/,
    "pending": /could not establish the node record .*no terminal execution status/,
    "at another block": /contradicts the node record the SDK read/,
    "for another payee": /could not establish the node record .*does not match the payment/,
    "with another fee": /contradicts the node record the SDK read/,
    "with a malformed fee": /could not establish the node record .*transaction record fee is malformed/,
    "with a negative fee": /could not establish the node record .*transaction record fee is malformed/,
    "with a non-canonical fee": /could not establish the node record .*transaction record fee is malformed/,
    "with an unsafe fee": /could not establish the node record .*transaction record is not stable JSON/,
    "with a null fee": /could not establish the node record .*transaction record fee is malformed/,
    "with an empty fee": /could not establish the node record .*transaction record fee is malformed/,
    "with a fee list": /could not establish the node record .*transaction record fee is malformed/,
    // node2 serves a hash from before its reset as not found.
    "absent": /could not establish the node record .*transaction record was not found/,
    "absent at node 61b8e75": /could not establish the node record .*transaction record is missing or malformed/,
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
      const log = createInMemorySettlementLog();
      await lostResponse(log, fresh);
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

  // The SDK rail's reader reads its own wallet's transfers only: a bridge that
  // names another payer over that rail's settle gets no verdict for it.
  test("refuses a recovery that names another payer over the SDK rail's settle", async () => {
    const other = "ef".repeat(32);
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => {
      const { preparedTransfer: _journal, ...claim } = executed();
      return { ...claim, payer: other };
    });
    const borrowed = payDemSettle({ address: other, settle: rail.settle }, {},
      { store: createIdempotencyStore(), reconcile });
    await expect(borrowed(request())).rejects.toThrow(
      /could not establish the node record .*the payment's payer is not this rail's wallet/,
    );
    expect(reconcile).toHaveBeenCalledOnce();
    expect(demosNode.reads).toEqual([]);
    expect(submit).not.toHaveBeenCalled();
  });

  test("holds every recovered verdict of a rail the SDK did not build, even one wrapping the SDK rail", async () => {
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => executed());
    const { priorAttempts: _history, ...fresh } = request();
    const customs = [
      { address: payer, settle: vi.fn(async () => ({ ok: false as const, txHash, payer, payee, chainId: "demos" })) },
      { address: payer, settle: vi.fn((...args: Parameters<PayDemRail["settle"]>) => rail.settle(...args)) },
    ];
    for (const custom of customs) {
      // The SDK rail's bridge paid and recorded the hash, but the node's record
      // was still pending, so only the hash is held.
      demosNode.recordStatus = "pending";
      const log = createInMemorySettlementLog();
      await expect(payDemSettle(rail, {}, { store: createIdempotencyStore(log) })(fresh))
        .resolves.toMatchObject({ ok: false, txHash });
      // The rail log binds the hash, yet an audit over this rail returns no verdict.
      const audited = await payDemSettle(custom, {}, { store: createIdempotencyStore(log), reconcile })(request());
      expect(audited).toMatchObject({ ok: false, txHash });
      expect(audited).not.toHaveProperty("finality");
      expect(audited).not.toHaveProperty("errorClass");
    }
    // A lookup by key over such a rail is never definitive either.
    const log = createInMemorySettlementLog();
    await lostResponse(log, fresh);
    await expect(payDemSettle(customs[0]!, {}, { store: createIdempotencyStore(log,
      { owner: "b", now: () => 3, leaseDurationMs: 1 }), reconcile })(fresh))
      .rejects.toThrow(/reconciliation was not definitive/);
    // Neither rail is ever called: the SDK makes no fresh attempt through it.
    for (const custom of customs) expect(custom.settle).not.toHaveBeenCalled();
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
    ...(["retained-hash audit", "restart re-check", "lookup by recorded attempt"] as const)
      .flatMap((path) => [true, false].map((echoFee) => ({ path, echoFee }))),
  ])("completes the $path with the record's fee (reconciler echoes it: $echoFee)", async ({ path, echoFee }) => {
    const reconcile = claim(echoFee);
    const log = createInMemorySettlementLog();
    if (path === "lookup by recorded attempt") {
      await unseenBroadcast(log, ask());
    } else {
      await expect(payDemSettle(rail, {}, { store: createIdempotencyStore(log) })(ask()))
        .resolves.toMatchObject({ ok: true, txHash: hash, networkFeeOs: feeOs });
    }
    submit.mockClear();
    servesNode2();
    const settle = payDemSettle(rail, {}, { reconcile, store: path === "lookup by recorded attempt"
      ? createIdempotencyStore(log, { owner: "b", now: () => 3, leaseDurationMs: 1 })
      : createIdempotencyStore(log) });
    await expect(settle(path === "retained-hash audit" ? ask([{ txHash: hash, chainId: "demos", ok: true }]) : ask()))
      .resolves.toMatchObject({ ok: true, txHash: hash, blockNumber: 498447, networkFeeOs: feeOs });
    // The by-key lookup asks for the hash the attempt record names.
    if (path === "lookup by recorded attempt") {
      expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ txHash: hash }));
    }
    expect(demosNode.reads).toContain(hash);
    expect(submit).not.toHaveBeenCalled();
  });

  // Nothing was signed for this key, so the record the node serves can only be
  // another payment of the same parties and amount: the SDK reads it, and the
  // missing attempt record refuses it (DACS-4 §9.5.1 PC-7).
  test.each([true, false])("refuses the lookup by key without an attempt record (reconciler echoes the fee: %s)", async (echoFee) => {
    const reconcile = claim(echoFee);
    const log = createInMemorySettlementLog();
    await lostResponse(log, ask());
    servesNode2();
    const settle = payDemSettle(rail, {}, { reconcile,
      store: createIdempotencyStore(log, { owner: "b", now: () => 3, leaseDurationMs: 1 }) });
    await expect(settle(ask())).rejects.toThrow(/no SDK record binds.*this payment/);
    await expect(log.readOutcome!("pay-dem:node2-native:0")).resolves.toBeNull();
    expect(demosNode.reads).toContain(hash);
    expect(submit).not.toHaveBeenCalled();
    expect(demosNode.broadcasts).toBe(0);
  });
});

// The node keeps a transaction as it was signed: its denomination fork migrates
// balances, not transaction rows. demosdk signs a transfer in DEM numbers before
// the fork, so a payment saved then must still be read in DEM once the node
// reports the fork active, or a paid session could never complete.
describe("a payment signed before the denomination fork is read in DEM after it activates", () => {
  // 1 DEM, and a 1 DEM network fee, as demosdk signs them before the fork.
  const feeOs = "1000000000";
  const claim = (echoFee: boolean) => vi.fn<PayDemSettlementReconcile>(async () => {
    const { networkFeeOs: _postForkFee, ...answer } = executed();
    return { ...answer, ...(echoFee ? { networkFeeOs: feeOs } : {}),
      preparedTransfer: { ...journal(), denomination: "dem" as const } };
  });
  // `executed()` scripts a post-fork record; serve the one signed before the fork.
  const preForkRecord = (overrides: Partial<Parameters<typeof nodeRecord>[0]> = {}) =>
    nodeRecord({ txHash, payer, payee, amountOs: "1000000000", feeOs, denomination: "dem", ...overrides });

  test.each([
    ...(["retained-hash audit", "restart re-check", "lookup by recorded attempt", "lookup by key"] as const)
      .flatMap((path) => [true, false].map((echoFee) => ({ path, echoFee }))),
  ])("recovers the $path from the pre-fork record, without paying again (fee echoed: $echoFee)", async ({ path, echoFee }) => {
    const { priorAttempts: _history, ...fresh } = request();
    const log = createInMemorySettlementLog();
    Object.assign(demosNode, { postFork: false, feeOs });
    if (path === "lookup by key") {
      await lostResponse(log, fresh);
    } else if (path === "lookup by recorded attempt") {
      await unseenBroadcast(log, fresh);
    } else {
      await expect(payDemSettle(await sdkPayDemRail(), {}, { store: createIdempotencyStore(log) })(fresh))
        .resolves.toMatchObject({ ok: true, txHash, networkFeeOs: feeOs });
      expect((demosNode.records.get(txHash) as { content: { data: unknown } }).content.data)
        .toEqual(["native", { nativeOperation: "send", args: [payee, 1] }]);
    }
    submit.mockClear();
    // The fork activates; a restarted process builds a new rail.
    demosNode.postFork = true;
    const reconcile = vi.fn<PayDemSettlementReconcile>(async (context) => {
      const answer = await claim(echoFee)(context);
      demosNode.records.set(txHash, preForkRecord());
      return answer;
    });
    const byKey = path === "lookup by key" || path === "lookup by recorded attempt";
    const settle = payDemSettle(await sdkPayDemRail(), {}, { reconcile, store: byKey
      ? createIdempotencyStore(log, { owner: "b", now: () => 3, leaseDurationMs: 1 })
      : createIdempotencyStore(log) });
    // Nothing was signed for this key on the lookup by key, so the record the
    // node serves cannot be shown to be this payment's, and it is refused.
    await (path === "lookup by key"
      ? expect(settle(fresh)).rejects.toThrow(/no SDK record binds.*this payment/)
      : expect(settle(path === "retained-hash audit" ? request() : fresh))
        .resolves.toMatchObject({ ok: true, txHash, blockNumber: 42, networkFeeOs: feeOs }));
    if (path === "lookup by recorded attempt") {
      expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ txHash }));
    }
    expect(demosNode.reads).toContain(txHash);
    expect(submit).not.toHaveBeenCalled();
    expect(demosNode.broadcasts).toBe(path === "lookup by key" ? 0 : 1);
  });

  // The signed payload says how the record is denominated; anything that does
  // not read the same way in that denomination is not this payment.
  const refusals = {
    "signed in DEM for another amount": {
      record: () => preForkRecord({ amountOs: "2000000000" }), postFork: true,
      reason: /transaction record does not match the payment/ },
    "signed in DEM, served with an OS amount": {
      record: () => {
        const record = preForkRecord();
        return { ...record, content: { ...(record.content as object), amount: "1000000000" } };
      }, postFork: true, reason: /transaction record does not match the payment/ },
    "signed with no amount": {
      record: () => {
        const record = preForkRecord();
        return { ...record, content: { ...(record.content as object),
          data: ["native", { nativeOperation: "send", args: [payee, null] }] } };
      }, postFork: true, reason: /transaction record does not match the payment/ },
    "signed in OS on a node that reports the fork inactive": {
      record: () => nodeRecord({ txHash, payer, payee, amountOs: "1000000000", feeOs }), postFork: false,
      reason: /transaction record is signed in OS, but the node reports the denomination fork inactive/ },
  } as const;
  test.each(Object.keys(refusals) as (keyof typeof refusals)[])(
    "holds a retained success whose record is %s", async (name) => {
      const { record, postFork, reason } = refusals[name];
      demosNode.postFork = postFork;
      const reconcile = vi.fn<PayDemSettlementReconcile>(async (context) => {
        const answer = await claim(false)(context);
        demosNode.records.set(txHash, record());
        return answer;
      });
      const log = await settledLog("executed");
      await expect(fixture(reconcile, createIdempotencyStore(log)).settle(request()))
        .rejects.toThrow(reason);
      expect(demosNode.reads).toContain(txHash);
      expect(submit).not.toHaveBeenCalled();
    },
  );

  // demosdk keeps a `Demos` instance's first getNetworkInfo reply, so a rail
  // that read the fork inactive would report it inactive for good.
  test("reads the fork state afresh, so a rail that saw it inactive completes a payment signed after it", async () => {
    const { priorAttempts: _history, ...fresh } = request();
    Object.assign(demosNode, { postFork: false, nextHash: "34".repeat(32) });
    const longLived = await sdkPayDemRail();
    // This rail pays another job before the fork, reading the fork state then.
    await expect(payDemSettle(longLived, {}, { store: createIdempotencyStore() })({ ...fresh, jobId: "before-fork" }))
      .resolves.toMatchObject({ ok: true, txHash: "34".repeat(32) });
    // The fork activates; another process signs this job's transfer in OS.
    Object.assign(demosNode, { postFork: true, nextHash: txHash });
    const log = await settledLog("executed");
    expect((demosNode.records.get(txHash) as { content: { data: unknown } }).content.data)
      .toEqual(["native", { nativeOperation: "send", args: [payee, "1000000000"] }]);
    demosNode.networkInfoReads = [];
    const reconcile = vi.fn<PayDemSettlementReconcile>(async () => executed());
    await expect(payDemSettle(longLived, {}, { store: createIdempotencyStore(log), reconcile })(request()))
      .resolves.toMatchObject({ ok: true, txHash, blockNumber: 42, networkFeeOs: "0" });
    expect(demosNode.networkInfoReads).toEqual([true]);
    expect(submit).not.toHaveBeenCalled();
    expect(demosNode.broadcasts).toBe(2);
  });
});

// `readPayDemTransferRecord` is exported for @kynesyslabs/dacs-node's recovery
// re-read. It reports the record the SDK rail's own connection read; neither
// that answer nor a success assembled from it is a record-verified verdict.
describe("the exported record read reports a record and vouches for no verdict", () => {
  const retained = { txHash, payer, payee, amountOs: "1000000000", network: "demos" };
  const vouches = (value: unknown) => [
    payDemRecordVerifiedTransfer(value),
    isRecordVerifiedSource(value),
    isPayDemSettleAdapter(value),
    isPayDemRecordVerifyingRail(value),
  ];

  test.each([
    ["another network", { network: "other" }],
    ["a numeric amount", { amountOs: 1000000000 }],
    ["a leading-zero amount", { amountOs: "01000000000" }],
    ["an amount with trailing whitespace", { amountOs: "1000000000 " }],
  ])("refuses %s before any node read", async (_label, invalid) => {
    nodeSays("confirmed");
    // Exercise untyped callers with otherwise matching executed transfer facts.
    const input = { ...retained, ...invalid } as Parameters<typeof readPayDemTransferRecord>[1];
    await expect(readPayDemTransferRecord(rail, input)).resolves.toEqual({
      state: "indeterminate", reason: "retained transfer is invalid",
    });
    expect(demosNode.reads).toEqual([]);
    expect(demosNode.networkInfoReads).toEqual([]);
    expect(demosNode.transfers).toBe(0);
    expect(demosNode.broadcasts).toBe(0);
    expect(submit).not.toHaveBeenCalled();
  });

  test("an executed read through the SDK rail passes no check and settles through no rail", async () => {
    nodeSays("confirmed");
    const read = await readPayDemTransferRecord(rail, retained);
    expect(read).toEqual({ state: "executed", blockNumber: 42, nonce: 9, networkFeeOs: "0" });
    if (read.state !== "executed") throw new Error("expected an executed read");
    // It only reads: one record read, nothing signed or broadcast.
    expect(demosNode.reads).toEqual([txHash]);
    expect(demosNode.transfers).toBe(0);
    expect(demosNode.broadcasts).toBe(0);
    // Every read is a new object, never a result the SDK registered.
    expect(await readPayDemTransferRecord(rail, retained)).not.toBe(read);
    const success = Object.freeze({
      ok: true as const, execution: "executed" as const, txHash, chainId: "demos", payer, payee,
      finality: Object.freeze({ model: "bft-final" as const }), blockNumber: read.blockNumber,
      txRefKind: "demos", networkFeeOs: read.networkFeeOs, nonce: read.nonce,
    });
    for (const value of [read, { ...read }, success, { ...success, ...retained }]) {
      expect(vouches(value)).toEqual([undefined, false, false, false]);
    }
    // A rail relaying that success is refused before it runs.
    const relay = { address: payer, settle: vi.fn(async () => success) };
    const { priorAttempts: _history, ...fresh } = request();
    await expect(payDemSettle(relay, {}, { store: createIdempotencyStore() })(fresh))
      .rejects.toThrow(/createPayDemRail returned.*refusing/);
    expect(relay.settle).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  test("a rail createPayDemRail did not build gets no read, even one wrapping the SDK rail", async () => {
    nodeSays("confirmed");
    const customs = [
      { address: payer, settle: vi.fn(async () => ({ ok: false as const, txHash, payer, payee, chainId: "demos" })) },
      { address: payer, settle: vi.fn((...args: Parameters<PayDemRail["settle"]>) => rail.settle(...args)) },
      // The SDK's own payDemSettle adapter is not the rail's settle either.
      { address: payer, settle: payDemSettle(rail, {}) as unknown as PayDemRail["settle"] },
    ];
    for (const custom of customs) {
      await expect(readPayDemTransferRecord(custom, retained)).resolves.toEqual({
        state: "indeterminate", reason: "rail has no SDK transaction record reader",
      });
    }
    expect(customs[0]!.settle).not.toHaveBeenCalled();
    expect(customs[1]!.settle).not.toHaveBeenCalled();
    expect(demosNode.reads).toEqual([]);
    expect(submit).not.toHaveBeenCalled();
  });
});

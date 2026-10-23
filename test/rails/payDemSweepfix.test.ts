import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { createIdempotencyStore, createInMemorySettlementLog,
  settlementBindingHash, type SettlementBinding } from "../../src/rails/idempotency.js";
import { payDemSettle, type PayDemPreparedTransfer, type PayDemSettlementReconcile } from "../../src/rails/payDem.js";
import { demosNode, nodeRecord, sdkPayDemRail } from "../fixtures/demosNodeScript.js";

vi.mock("@kynesyslabs/demosdk/websdk", async () =>
  (await import("../fixtures/demosNodeScript.js")).demosWebsdkMock);
beforeEach(() => demosNode.reset());
const payer = "ab".repeat(32), payee = "cd".repeat(32);
const binding: SettlementBinding = {
  bindingVersion: "1", railId: "pay-dem", jobId: "sweepfix", phaseIndex: 0, phase: "pay-dem",
  amount: "1000000000", agreementAsset: "DEM", settlementAsset: "DEM", payer, payee,
  network: "demos", finality: { model: "bft-final" },
};
const key = "pay-dem:sweepfix:0";
const req = { rail: "pay-dem", phase: "pay-dem", phaseIndex: 0, jobId: "sweepfix",
  amount: "1", asset: "DEM", payee: `did:demos:agent:${payee}`, expectedPayee: payee };

test("a lost attempt-write acknowledgement keeps the intent held", async () => {
  const log = createInMemorySettlementLog();
  const putAttempt = log.putAttempt!.bind(log);
  vi.spyOn(log, "putAttempt").mockImplementation(async (input) => {
    await putAttempt(input); throw new Error("attempt acknowledgement lost");
  });
  const release = vi.spyOn(log, "releaseIntent");
  const adapter = payDemSettle(await sdkPayDemRail(), {}, { store: createIdempotencyStore(log) });
  await assert.rejects(adapter(req), /acknowledgement lost/);
  assert.equal(release.mock.calls.length, 0);
  assert.equal(demosNode.broadcasts, 0);
  assert.equal(demosNode.transfers, 1);
  assert.equal((await log.readAttempt!(key))?.txHash, demosNode.nextHash);
  await assert.rejects(adapter(req), /in-flight/);
  assert.equal(demosNode.transfers, 1);
});

test.each([["12", "6"], ["0", "2000000000"], ["6", "6"]])(
  "restart recovery keeps record fee %s separate from confirmation fee %s", async (feeOs, confirmFeeOs) => {
    Object.assign(demosNode, { feeOs, confirmFeeOs });
    const journal: PayDemPreparedTransfer[] = [];
    const log = createInMemorySettlementLog();
    const first = await payDemSettle(await sdkPayDemRail(undefined, {
      journalPreparedTransfer: async (entry) => { journal.push(entry); },
    }), {}, { store: createIdempotencyStore(log) })(req);
    assert.equal(first.networkFeeOs, feeOs);
    assert.equal(journal[0]!.confirmedTotalDebitOs, (1000000000n + BigInt(confirmFeeOs!)).toString());
    for (const history of [false, true]) {
      const resumed = payDemSettle(await sdkPayDemRail(), {}, {
        store: createIdempotencyStore(log), reconcile: async () => ({ ...first,
          amountOs: binding.amount, execution: "executed", preparedTransfer: journal[0] }),
      });
      assert.deepEqual(await resumed({ ...req, ...(history ? { recoveryOnly: true } : {}) }), first);
    }
    assert.equal(demosNode.broadcasts, 1);
  },
);

test("a transaction-bearing cached failure is reconciled against the node", async () => {
  const log = createInMemorySettlementLog();
  const bindingHash = settlementBindingHash(binding);
  const txHash = demosNode.nextHash;
  const failed = {
    ok: false as const, txHash, chainId: "demos", payer, payee, blockNumber: 42,
    txRefKind: "demos", errorClass: "permanent" as const,
    failureProof: { kind: "demos-failed-record" as const, txHash, payer, payee,
      nonce: 9, blockNumber: 42, amountOs: binding.amount },
  };
  const claim = await log.claimIntent({ key, bindingHash, owner: "worker", now: 1, leaseDurationMs: 10 });
  assert.equal(claim.status, "acquired");
  assert.equal((await log.putOutcome({ key, bindingHash, lease: claim.lease, result: failed, now: 2 })).status,
    "recorded");
  const stored = await log.readOutcome!(key);
  assert.deepEqual(stored?.result, failed);
  assert.equal(await log.readAttempt!(key), null);
  // The paired log agrees on the failed claim; the node says this hash executed.
  demosNode.records.set(txHash, nodeRecord({ txHash, payer, payee, amountOs: binding.amount }));
  const reconcile = vi.fn<PayDemSettlementReconcile>(async () => ({ ...failed, amountOs: binding.amount }));
  const resumed = payDemSettle(await sdkPayDemRail(), {}, { store: createIdempotencyStore(log), reconcile });

  // No supplied history or recoveryOnly: exercise the cached-outcome reader.
  await assert.rejects(resumed(req), /contradicts the node record/);
  assert.deepEqual(reconcile.mock.calls, [[{
    railId: "pay-dem", jobId: "sweepfix", phaseIndex: 0, settlementKey: key,
    network: "demos", payer, payee, amountOs: binding.amount,
  }]]);
  assert.deepEqual(demosNode.reads, [txHash]);
  assert.deepEqual(await log.readOutcome!(key), stored);
  assert.equal(await log.readAttempt!(key), null);
  assert.equal(demosNode.transfers, 0);
  assert.equal(demosNode.broadcasts, 0);
});

test("a durable payment at a different reconciled block still refuses without another transfer", async () => {
  const { log, first } = await savedPayment();
  const resumed = payDemSettle(await sdkPayDemRail(), {}, {
    store: createIdempotencyStore(log), reconcile: async () => ({ ...first,
      execution: "executed", amountOs: binding.amount, blockNumber: first.blockNumber! + 1 }),
  });
  await assert.rejects(resumed(req), /does not match the authoritative reconciled transaction/);
  assert.deepEqual((await log.readOutcome!(key))?.result, first);
  assert.equal(demosNode.transfers, 1);
  assert.equal(demosNode.broadcasts, 1);
});

async function savedPayment() {
  demosNode.feeOs = "12";
  demosNode.confirmFeeOs = "6";
  const log = createInMemorySettlementLog();
  const first = await payDemSettle(await sdkPayDemRail(), {}, { store: createIdempotencyStore(log) })(req);
  assert.equal(first.networkFeeOs, "12"); // record declaration, not confirmation debit
  const record = structuredClone(demosNode.records.get(first.txHash));
  return { log, first, record };
}

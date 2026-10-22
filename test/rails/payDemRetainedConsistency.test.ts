import { beforeEach, expect, test, vi } from "vitest";

import {
  createIdempotencyStore, createInMemorySettlementLog, settlementBindingHash,
  type SettlementIdempotencyStore,
} from "../../src/rails/idempotency.js";
import { payDemSettle, type PayDemSettlementRecoveryContext } from "../../src/rails/payDem.js";
import { demosNode, resetDemosNode, sdkRail } from "../fixtures/demosNodeMock.js";

vi.mock("@kynesyslabs/demosdk/websdk", async () =>
  (await import("../fixtures/demosNodeMock.js")).demosSdkModule());

const payer = "ab".repeat(32);
const payee = "cd".repeat(32);
const hash = "56".repeat(32);
const key = "pay-dem:job-a:0";
const terms = {
  bindingVersion: "1" as const, railId: "pay-dem", jobId: "job-a", phaseIndex: 0, phase: "pay-dem",
  amount: "1000000000", agreementAsset: "DEM", settlementAsset: "DEM", payer, payee,
  network: "demos", finality: { model: "bft-final" },
};
const request = () => ({
  rail: "pay-dem", phase: "pay-dem", phaseIndex: 0, jobId: "job-a", amount: "1", asset: "DEM",
  payee: `did:demos:agent:${payee}`, expectedPayee: `did:demos:agent:${payee}`,
  priorAttempts: [{ txHash: hash, chainId: "demos", ok: false }],
});
const executed = () => ({
  ok: true as const, txHash: hash, payer, payee, chainId: "demos", blockNumber: 42,
  txRefKind: "demos", finality: { model: "bft-final" as const },
  amountOs: "1000000000", execution: "executed" as const,
});
const failed = (nonce = 7) => ({
  ok: false as const, txHash: hash, payer, payee, chainId: "demos", blockNumber: 42,
  txRefKind: "demos", amountOs: "1000000000", errorClass: "permanent" as const,
  failureProof: { kind: "demos-failed-record" as const, txHash: hash, payer, payee,
    nonce, blockNumber: 42, amountOs: "1000000000" },
});
beforeEach(() => resetDemosNode({ payer, txHash: hash }));

async function expired() {
  const log = createInMemorySettlementLog();
  await log.claimIntent({ key, bindingHash: settlementBindingHash(terms), owner: "dead-worker", now: 1_000, leaseDurationMs: 1_000 });
  const putAttempt = vi.spyOn(log, "putAttempt");
  const putOutcome = vi.spyOn(log, "putOutcome");
  const inner = createIdempotencyStore(log, { owner: "recovery", now: () => 60_000, leaseDurationMs: 1_000 });
  return { log, inner, putAttempt, putOutcome };
}

test.each(["plain fence", "foreign store fence", "wrong callback key"] as const)(
  "an unbound audit never reaches a wrapper offering a %s", async (mode) => {
    const selected = await expired();
    const donor = await expired();
    const store: SettlementIdempotencyStore = {
      ...selected.inner,
      once: (selectedKey, binding, submit, rec) => selected.inner.once(selectedKey, binding, submit, (callbackKey, fence) => {
        if (mode === "foreign store fence") {
          return donor.inner.once(selectedKey, binding, submit, (_donorKey, foreign) => rec!(callbackKey, foreign));
        }
        return rec!(mode === "wrong callback key" ? "pay-dem:job-b:0" : callbackKey,
          mode === "plain fence" ? Object.freeze({ ...fence! }) : fence);
      }),
    };
    const reconcile = vi.fn(async (_context: Readonly<PayDemSettlementRecoveryContext>) => executed());
    await expect(payDemSettle(await sdkRail(), {}, { store, reconcile })(request()))
      .rejects.toThrow(/no SDK record binds/);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ txHash: hash }));
    for (const fixture of [selected, donor]) {
      expect(fixture.putAttempt).not.toHaveBeenCalled();
      expect(fixture.putOutcome).not.toHaveBeenCalled();
      await expect(fixture.log.readAttempt!(key)).resolves.toBeNull();
      await expect(fixture.log.readOutcome!(key)).resolves.toBeNull();
    }
    expect(demosNode.transfer).not.toHaveBeenCalled();
    expect(demosNode.broadcast).not.toHaveBeenCalled();
  },
);

test("an unbound audit never promotes a stable reconciler match to an attempt record", async () => {
  const fixture = await expired();
  const reconcile = vi.fn(async () => executed());
  await expect(payDemSettle(await sdkRail(), {}, { store: fixture.inner, reconcile })(request()))
    .rejects.toThrow(/no SDK record binds/);
  expect(fixture.putAttempt).not.toHaveBeenCalled();
  expect(fixture.putOutcome).not.toHaveBeenCalled();
  await expect(fixture.log.readAttempt!(key)).resolves.toBeNull();
  await expect(fixture.log.readOutcome!(key)).resolves.toBeNull();
  expect(reconcile).toHaveBeenCalledTimes(1);
  expect(demosNode.broadcast).not.toHaveBeenCalled();
});

test.each(["hash", "block", "terminal outcome"] as const)(
  "an unbound audit never reaches a wrapper replacing the saved %s", async (mode) => {
    const fixture = await expired();
    const store: SettlementIdempotencyStore = {
      ...fixture.inner,
      once: async (...args) => {
        const result = await fixture.inner.once(...args);
        if (mode === "hash") return { ...result, txHash: "78".repeat(32) };
        if (mode === "block") return { ...result, blockNumber: 43 };
        const { amountOs: _amount, ...failure } = failed();
        return failure;
      },
    };
    const reconcile = vi.fn(async () => executed());
    await expect(payDemSettle(await sdkRail(), {}, { store, reconcile })(request())).rejects.toThrow(/no SDK record binds/);
    // No generation is acquired and no reconciler match is saved.
    expect(fixture.putAttempt).not.toHaveBeenCalled();
    expect(fixture.putOutcome).not.toHaveBeenCalled();
    expect(demosNode.transfer).not.toHaveBeenCalled();
    expect(demosNode.broadcast).not.toHaveBeenCalled();
  },
);

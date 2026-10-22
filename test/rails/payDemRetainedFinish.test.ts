import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createIdempotencyStore,
  createInMemorySettlementLog,
  settlementBindingHash,
  settlementKey,
  type SettlementLog,
} from "../../src/rails/idempotency.js";
import {
  payDemSettle,
  normalizeDemosNativeAddress,
  type PayDemReconciledSettlement,
} from "../../src/rails/payDem.js";
import { demosNode, heldRail, resetDemosNode, sdkRail, sdkTransfers, serveNodeRecord } from "../fixtures/demosNodeMock.js";
import { combineWalletSpendEffectFenceV1 } from "../../src/rails/walletSpendAuthority.js";

vi.mock("@kynesyslabs/demosdk/websdk", async () => (await import("../fixtures/demosNodeMock.js")).demosSdkModule());

const PAYER = "ab".repeat(32);
const PAYEE = "cd".repeat(32);
const HASH = "7a".repeat(32);
const BLOCK = 480_877;
const LEASE_MS = 300_000;

beforeEach(() => {
  resetDemosNode({ payer: PAYER, txHash: HASH, blockNumber: BLOCK });
  // These tests reach the binding checks only after the SDK reads the retained
  // payment's node record. A reconciler's claim alone cannot do that,
  // including when no transfer was made through this process's mocked node.
  serveNodeRecord(HASH, { payer: PAYER, payee: PAYEE, amountOs: "9500000000", blockNumber: BLOCK });
});

const request = (jobId: string) => ({
  rail: "pay-dem", phase: "pay-dem" as const, amount: "9.5", asset: "DEM",
  payee: `did:demos:agent:${PAYEE}`, expectedPayee: PAYEE, jobId, phaseIndex: 0,
});
const resumed = (jobId: string) => ({
  ...request(jobId), priorAttempts: [{ txHash: HASH, chainId: "demos", ok: false }],
});
const executed = (): PayDemReconciledSettlement => ({
  ok: true, execution: "executed", txHash: HASH, chainId: "demos", payer: PAYER,
  payee: PAYEE, finality: { model: "bft-final" }, blockNumber: BLOCK, txRefKind: "demos",
  amountOs: "9500000000",
}) as PayDemReconciledSettlement;
const binding = (jobId: string) => ({
  bindingVersion: "1" as const, railId: "pay-dem", jobId, phaseIndex: 0, phase: "pay-dem",
  amount: "9500000000", agreementAsset: "DEM", settlementAsset: "DEM",
  payer: PAYER, payee: PAYEE, network: "demos", finality: { model: "bft-final" },
});

function watchWrites(log: SettlementLog) {
  return ["claimIntent", "grantRecovery", "putAttempt", "putOutcome", "releaseIntent"]
    .map((name) => vi.spyOn(log, name as "claimIntent"));
}

describe("retained audits read existing payment bindings without acquiring authority", () => {
  it.each(["absent", "held", "expired"])(
    "never attributes job A's transfer to unpaid job B with an %s intent, even after restart",
    async (state) => {
      const log = createInMemorySettlementLog();
      let clock = 1_000_000;
      const options = () => ({ now: () => clock, leaseDurationMs: LEASE_MS });
      const first = payDemSettle(await sdkRail(), {}, { store: createIdempotencyStore(log, options()) });
      await expect(first(request("job-a"))).resolves.toMatchObject({ ok: true, txHash: HASH });
      const key = settlementKey("pay-dem", "job-b", 0);
      if (state !== "absent") {
        // Current-version intent left by a process that died before signing.
        await log.claimIntent({
          key, bindingHash: settlementBindingHash(binding("job-b")), owner: "prior-worker",
          now: clock, leaseDurationMs: LEASE_MS,
        });
      }
      if (state === "expired") clock += LEASE_MS + 1;
      const writes = watchWrites(log);
      // Even a same-party, same-amount chain match cannot establish job B's identity.
      const reconcile = vi.fn(async () => executed());
      const audit = async () => payDemSettle(await sdkRail(), {}, {
        store: createIdempotencyStore(log, options()), reconcile,
      });
      await expect((await audit())(resumed("job-b"))).rejects.toThrow(/no SDK record binds/);
      // The former claim/release window could survive a crash and be promoted
      // on the next audit. Neither the first audit nor a restart may write.
      clock += LEASE_MS + 1;
      await expect((await audit())(resumed("job-b"))).rejects.toThrow(/no SDK record binds/);
      for (const write of writes) expect(write).not.toHaveBeenCalled();
      await expect(log.readAttempt!(key)).resolves.toBeNull();
      await expect(log.readOutcome!(key)).resolves.toBeNull();
      expect(sdkTransfers()).toBe(1);
      expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-b", txHash: HASH }));
    },
  );

  it("never calls an injected once during an unbound audit", async () => {
    const real = createIdempotencyStore();
    const once = vi.fn(real.once);
    const settle = payDemSettle(await sdkRail(), {}, {
      store: { once, readAttempt: real.readAttempt, readOutcome: real.readOutcome },
      reconcile: async () => executed(),
    });
    await expect(settle(resumed("job-b"))).rejects.toThrow(/no SDK record binds/);
    expect(once).not.toHaveBeenCalled();
    expect(sdkTransfers()).toBe(0);
  });

  it.each([
    { observation: "missing", reason: "transaction record was not found" },
    { observation: "pending", reason: "transaction record has no terminal execution status" },
  ])("refuses a $observation node record without claiming or writing", async ({ observation, reason }) => {
    const log = createInMemorySettlementLog();
    const writes = watchWrites(log);
    const store = createIdempotencyStore(log);
    const once = vi.spyOn(store, "once");
    const reconcile = vi.fn(async () => executed());
    const settle = payDemSettle(await sdkRail(), {}, { store, reconcile });
    if (observation === "missing") demosNode.getTxByHash.mockResolvedValue(null);
    else serveNodeRecord(HASH, {
      payer: PAYER, payee: PAYEE, amountOs: "9500000000", blockNumber: BLOCK, status: "pending",
    });

    // Omitting history on a retry must still audit the retained hash.
    for (const req of [resumed("job-t"), request("job-t")]) {
      await expect(settle(req)).rejects.toThrow(
        `pay-dem recovery could not establish the node record for ${HASH}: ${reason}; ` +
          "the payment stays unresolved and is never resubmitted",
      );
    }
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ txHash: HASH }));
    expect(demosNode.getTxByHash.mock.calls).toEqual([[HASH], [HASH]]);
    expect(once).not.toHaveBeenCalled();
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(demosNode.transfer).not.toHaveBeenCalled();
    expect(demosNode.broadcast).not.toHaveBeenCalled();
    const key = settlementKey("pay-dem", "job-t", 0);
    await expect(log.readAttempt!(key)).resolves.toBeNull();
    await expect(log.readOutcome!(key)).resolves.toBeNull();
  });

  it.each([false, true])("audits a recorded current payment after restart (expired=%s) without changing the log", async (expired) => {
    const log = createInMemorySettlementLog();
    let clock = 1_000_000;
    const options = () => ({ now: () => clock, leaseDurationMs: LEASE_MS });
    const first = payDemSettle(await heldRail(), {}, { store: createIdempotencyStore(log, options()) });
    await expect(first(request("job-a"))).resolves.toMatchObject({ ok: false, txHash: HASH });
    if (expired) clock += LEASE_MS + 1;
    const writes = watchWrites(log);
    const reconcile = vi.fn(async () => executed());
    const restarted = payDemSettle(await sdkRail(), {}, { store: createIdempotencyStore(log, options()), reconcile });
    await expect(restarted(resumed("job-a"))).resolves.toMatchObject({ ok: true, txHash: HASH, blockNumber: BLOCK });
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    await expect(log.readOutcome!(settlementKey("pay-dem", "job-a", 0))).resolves.toBeNull();
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-a", txHash: HASH }));
    expect(sdkTransfers()).toBe(1);
  });

  it("audits a current payment whose process died before saving its outcome", async () => {
    const log = createInMemorySettlementLog();
    vi.spyOn(log, "putOutcome").mockRejectedValue(new Error("process died before saving outcome"));
    const first = payDemSettle(await sdkRail(), {}, { store: createIdempotencyStore(log) });
    await expect(first(request("job-a"))).rejects.toThrow(/process died/);
    const writes = watchWrites(log);
    for (const write of writes) write.mockClear();
    const restarted = payDemSettle(await sdkRail(), {}, {
      store: createIdempotencyStore(log), reconcile: async () => executed(),
    });
    await expect(restarted(resumed("job-a"))).resolves.toMatchObject({ ok: true, txHash: HASH });
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(sdkTransfers()).toBe(1);
  });

  it("retains the attempt made through combined wallet and settlement fences for restart audit", async () => {
    const log = createInMemorySettlementLog();
    const store = createIdempotencyStore(log);
    const rail = await sdkRail();
    const key = settlementKey("pay-dem", "job-a", 0);
    const terms = binding("job-a");
    const walletAssert = vi.fn(async () => undefined);
    await expect(store.once(key, terms, async (fence) => {
      const result = await rail.settle({
        recipient: PAYEE, amount: terms.amount, network: "demos",
        recovery: { railId: "pay-dem", jobId: "job-a", phaseIndex: 0, settlementKey: key,
          network: "demos", payer: PAYER, payee: PAYEE, amountOs: terms.amount },
      }, combineWalletSpendEffectFenceV1(fence!, {
        reservationId: "wallet-a", bindingHash: "cd".repeat(32), settlementBindingHash: settlementBindingHash(terms),
        owner: "wallet-worker", generation: 1, assertCurrent: walletAssert,
      }));
      const { execution: _execution, ...settled } = result;
      return { ...settled, payer: normalizeDemosNativeAddress(result.payer)!,
        payee: normalizeDemosNativeAddress(result.payee)! };
    })).resolves.toMatchObject({ ok: true, txHash: HASH });
    expect(walletAssert).toHaveBeenCalled();
    await expect(log.readAttempt!(key)).resolves.toMatchObject({ txHash: HASH });
    const restarted = payDemSettle(await sdkRail(), {}, {
      store: createIdempotencyStore(log), reconcile: async () => executed(),
    });
    await expect(restarted(resumed("job-a"))).resolves.toMatchObject({ ok: true, txHash: HASH });
    expect(sdkTransfers()).toBe(1);
  });

  it("refuses a log without readOutcome without claiming or writing", async () => {
    const full = createInMemorySettlementLog();
    const { readOutcome: _read, putAttempt: _put, readAttempt: _attempt, ...log } = full;
    const writes = [vi.spyOn(log, "claimIntent"), vi.spyOn(log, "grantRecovery"),
      vi.spyOn(log, "releaseIntent"), vi.spyOn(log, "putOutcome")];
    const settle = payDemSettle(await sdkRail(), {}, {
      store: createIdempotencyStore(log), reconcile: async () => executed(),
    });
    await expect(settle(resumed("job-b"))).rejects.toThrow(/read-only outcome lookup/);
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(sdkTransfers()).toBe(0);
  });
});

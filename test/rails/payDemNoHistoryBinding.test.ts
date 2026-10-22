import { beforeEach, expect, test, vi } from "vitest";

import type { SettleRequest } from "../../src/agent/runSessionCore.js";
import { createIdempotencyStore, createInMemorySettlementLog } from "../../src/rails/idempotency.js";
import { payDemSettle, type PayDemSettlementRecoveryContext } from "../../src/rails/payDem.js";
import { demosNode, resetDemosNode, sdkRail } from "../fixtures/demosNodeMock.js";

vi.mock("@kynesyslabs/demosdk/websdk", async () =>
  (await import("../fixtures/demosNodeMock.js")).demosSdkModule());

const payer = "ab".repeat(32);
const payee = "cd".repeat(32);
const hashA = "56".repeat(32);
const request = (jobId: string): SettleRequest => ({
  rail: "pay-dem", phase: "pay-dem", phaseIndex: 0, jobId, amount: "1", asset: "DEM",
  payee: `did:demos:agent:${payee}`, expectedPayee: `did:demos:agent:${payee}`,
});
const binding = (jobId: string) => ({
  bindingVersion: "1" as const, railId: "pay-dem", jobId, phaseIndex: 0, phase: "pay-dem",
  amount: "1000000000", agreementAsset: "DEM", settlementAsset: "DEM", payer, payee,
  network: "demos", finality: { model: "bft-final" },
});
const confirmedA = () => ({
  ok: true as const, txHash: hashA, payer, payee, chainId: "demos", blockNumber: 42,
  txRefKind: "demos", finality: { model: "bft-final" as const },
  amountOs: "1000000000", execution: "executed" as const,
});
beforeEach(() => resetDemosNode({ payer, txHash: hashA }));

// No SessionStore is involved: the rail bridge must enforce PC-7's original
// job/phase binding even when both jobs have the same parties and amount.
test.each(["expired intent", "cached outcome", "readOutcome wrapper"] as const)(
  "job B cannot complete with job A's payment through a no-history %s",
  async (mode) => {
    const log = createInMemorySettlementLog();
    let now = 1_000;
    const options = () => ({ owner: "worker", leaseDurationMs: 1_000, now: () => now });
    await expect(payDemSettle(await sdkRail(), {}, {
      store: createIdempotencyStore(log, options()),
    })(request("job-a"))).resolves.toMatchObject({ ok: true, txHash: hashA });

    if (mode === "expired intent") {
      // Current SDK dies after claiming B, before signing or recording B.
      demosNode.transfer.mockImplementation(() => new Promise<never>(() => undefined));
      void payDemSettle(await sdkRail(), {}, {
        store: createIdempotencyStore(log, options()),
      })(request("job-b"));
      await vi.waitFor(() => expect(demosNode.transfer).toHaveBeenCalledTimes(2));
      now += 60_000;
    } else {
      // A current log can contain an unbound outcome from a key-only
      // reconciliation. Such an outcome cannot authenticate its own hash.
      await createIdempotencyStore(log, options()).once(
        "pay-dem:job-b:0", binding("job-b"), async () => {
          const { amountOs: _amount, execution: _execution, ...result } = confirmedA();
          return result;
        },
      );
    }
    await expect(log.readAttempt!("pay-dem:job-b:0")).resolves.toBeNull();
    const putAttempt = vi.spyOn(log, "putAttempt");
    const putOutcome = vi.spyOn(log, "putOutcome");
    const inner = createIdempotencyStore(log, options());
    const store = mode === "readOutcome wrapper" ? {
      ...inner,
      once: async (key: string, terms: Parameters<typeof inner.once>[1]) =>
        (await inner.readOutcome!(key, terms))!,
    } : inner;
    const reconcile = vi.fn(async (_context: Readonly<PayDemSettlementRecoveryContext>) => confirmedA());
    const settle = payDemSettle(await sdkRail(), {}, { store, reconcile });
    await expect(settle(request("job-b"))).rejects.toThrow(/no SDK record binds.*this payment/);
    await expect(settle(request("job-b"))).rejects.toThrow();
    expect(putAttempt).not.toHaveBeenCalled();
    expect(putOutcome).not.toHaveBeenCalled();
    expect(demosNode.broadcast).toHaveBeenCalledTimes(1);
    if (mode === "expired intent") {
      // M10: a key-only query omits the optional member altogether.
      expect(reconcile).toHaveBeenCalled();
      for (const [context] of reconcile.mock.calls) {
        expect(Object.hasOwn(context, "txHash")).toBe(false);
      }
      await expect(log.readOutcome!("pay-dem:job-b:0")).resolves.toBeNull();
    }
  },
);

test("a no-history restart still completes this job's recorded payment", async () => {
  const log = createInMemorySettlementLog();
  let now = 1_000;
  demosNode.nodeCall.mockResolvedValue({ state: "pending" });
  await payDemSettle(await sdkRail({ inclusionTimeoutMs: 1 }), {}, {
    store: createIdempotencyStore(log, { now: () => now, leaseDurationMs: 1_000 }),
  })(request("job-a"));
  now += 60_000;
  const reconcile = vi.fn(async () => confirmedA());
  const settle = payDemSettle(await sdkRail(), {}, {
    store: createIdempotencyStore(log, { now: () => now, leaseDurationMs: 1_000 }), reconcile,
  });
  await expect(settle(request("job-a"))).resolves.toMatchObject({ ok: true, txHash: hashA });
  expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-a", txHash: hashA }));
  expect(demosNode.transfer).toHaveBeenCalledTimes(1);
  expect(demosNode.broadcast).toHaveBeenCalledTimes(1);
});

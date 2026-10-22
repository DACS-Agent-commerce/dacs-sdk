import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createIdempotencyStore,
  createInMemorySettlementLog,
  settlementBindingHash,
  settlementKey,
  type SettlementIdempotencyStore,
} from "../../src/rails/idempotency.js";
import { payDemSettle } from "../../src/rails/payDem.js";
import { combineWalletSpendEffectFenceV1 } from "../../src/rails/walletSpendAuthority.js";
import { demosNode, resetDemosNode, sdkRail, sdkTransfers } from "../fixtures/demosNodeMock.js";

vi.mock("@kynesyslabs/demosdk/websdk", async () => (await import("../fixtures/demosNodeMock.js")).demosSdkModule());

const PAYER = "ab".repeat(32);
const PAYEE = "cd".repeat(32);
const HASH = "12".repeat(32);
const request = {
  rail: "pay-dem", phase: "pay-dem" as const, phaseIndex: 0, jobId: "wallet-fence",
  amount: "1", asset: "DEM", payee: `did:demos:agent:${PAYEE}`, expectedPayee: PAYEE,
};
const permit = (bindingHash: string, assertCurrent: () => Promise<void>) => ({
  reservationId: "wallet-reservation", bindingHash: "ef".repeat(32),
  settlementBindingHash: bindingHash, owner: "wallet-worker", generation: 1, assertCurrent,
});

beforeEach(() => resetDemosNode({ payer: PAYER, txHash: HASH, blockNumber: 42 }));

describe("pay-dem bridge with combined wallet and settlement fences", () => {
  it.each([1, 2])("pays once through %s wallet fences and audits after reconstruction without writes", async (depth) => {
    const log = createInMemorySettlementLog();
    const inner = createIdempotencyStore(log);
    const walletAssert = vi.fn(async () => undefined);
    const store: SettlementIdempotencyStore = {
      readOutcome: inner.readOutcome,
      readAttempt: inner.readAttempt,
      once: (key, binding, submit, reconcile) => inner.once(key, binding, (fence) => {
        let combined = fence!;
        for (let i = 0; i < depth; i++) {
          combined = combineWalletSpendEffectFenceV1(combined, permit(settlementBindingHash(binding), walletAssert));
        }
        return submit(combined);
      }, reconcile),
    };
    const settle = payDemSettle(await sdkRail(), {}, { store });
    await expect(settle(request)).resolves.toMatchObject({ ok: true, txHash: HASH });
    await expect(settle(request)).resolves.toMatchObject({ ok: true, txHash: HASH });
    expect(walletAssert).toHaveBeenCalled();
    await expect(log.readAttempt!(settlementKey("pay-dem", request.jobId, 0)))
      .resolves.toMatchObject({ txHash: HASH });

    const writes = [
      vi.spyOn(log, "claimIntent"), vi.spyOn(log, "grantRecovery"),
      vi.spyOn(log, "putAttempt"), vi.spyOn(log, "putOutcome"), vi.spyOn(log, "releaseIntent"),
    ];
    const walletChecks = walletAssert.mock.calls.length;
    const restarted = payDemSettle(await sdkRail(), {}, {
      store: createIdempotencyStore(log),
      reconcile: async () => ({
        ok: true, execution: "executed", txHash: HASH, chainId: "demos",
        payer: PAYER, payee: PAYEE, amountOs: "1000000000", blockNumber: 42,
        txRefKind: "demos", finality: { model: "bft-final" },
      }),
    });
    await expect(restarted({ ...request, priorAttempts: [{ txHash: HASH, chainId: "demos", ok: true }] }))
      .resolves.toMatchObject({ ok: true, txHash: HASH });
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(walletAssert.mock.calls.length).toBe(walletChecks);
    expect(demosNode.broadcast).toHaveBeenCalledTimes(1);
    expect(sdkTransfers()).toBe(1);
  });

  it.each(["injected recorder", "other key", "other terms"])(
    "refuses %s through SDK fence composition",
    async (source) => {
      const inner = createIdempotencyStore();
      const store: SettlementIdempotencyStore = {
        readOutcome: inner.readOutcome,
        readAttempt: inner.readAttempt,
        once: (key, binding, submit, reconcile) => inner.once(
          source === "other key" ? settlementKey("pay-dem", "other-job", 0) : key,
          source === "other key" ? { ...binding, jobId: "other-job" }
            : source === "other terms" ? { ...binding, amount: "2" } : binding,
          (fence) => submit(combineWalletSpendEffectFenceV1({
            ...fence!, settlementKey: key, bindingHash: settlementBindingHash(binding),
            ...(source === "injected recorder" ? {
              recordAttempt: async (hash: string) => fence!.recordAttempt!(hash),
            } : {}),
          }, permit(settlementBindingHash(binding), async () => undefined))),
          reconcile,
        ),
      };
      await expect(payDemSettle(await sdkRail(), {}, { store })(request))
        .rejects.toThrow(/store records no attempt this bridge can read back/);
      expect(sdkTransfers()).toBe(0);
      expect(demosNode.broadcast).not.toHaveBeenCalled();
    },
  );

  it("still enforces the wallet fence immediately before broadcast", async () => {
    const inner = createIdempotencyStore();
    const walletAssert = vi.fn(async () => {
      if (sdkTransfers() > 0) throw new Error("wallet generation is stale");
    });
    const store: SettlementIdempotencyStore = {
      readOutcome: inner.readOutcome,
      readAttempt: inner.readAttempt,
      once: (key, binding, submit, reconcile) => inner.once(key, binding, (fence) => submit(
        combineWalletSpendEffectFenceV1(fence!, permit(settlementBindingHash(binding), walletAssert)),
      ), reconcile),
    };
    await expect(payDemSettle(await sdkRail(), {}, { store })(request))
      .rejects.toThrow(/wallet generation is stale/);
    expect(walletAssert).toHaveBeenCalled();
    expect(sdkTransfers()).toBe(1);
    expect(demosNode.broadcast).not.toHaveBeenCalled();
    await expect(inner.readAttempt!(settlementKey("pay-dem", request.jobId, 0), {
      bindingVersion: "1", railId: "pay-dem", jobId: request.jobId, phaseIndex: 0, phase: "pay-dem",
      amount: "1000000000", agreementAsset: "DEM", settlementAsset: "DEM", payer: PAYER,
      payee: PAYEE, network: "demos", finality: { model: "bft-final" },
    })).resolves.toBeNull();
  });
});

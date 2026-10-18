import { describe, expect, it, vi } from "vitest";
import { assertCurrentDacsProfileAdmission, settlementKey } from "@kynesyslabs/dacs";
import { createDacsFixedPriceX402SellerLiveV1 } from "../src/fixedPriceX402SellerLive.js";
import { createDacsFixedPricePayDemSellerLiveV1 } from "../src/fixedPricePayDemSellerLive.js";
import { createDacsFixedPriceX402BuyerLiveV1 } from "../src/fixedPriceX402BuyerLive.js";
import { createDacsFixedPricePayDemBuyerLiveV1 } from "../src/fixedPricePayDemBuyerLive.js";
import { createDacsBuyerLiveCommerceAssemblyV1, createDacsSellerLiveCommerceAssemblyV1 } from "../src/liveCommerceAssembly.js";
import { createDacsBuyerPayDemLiveCommerceAssemblyV1, createDacsSellerPayDemLiveCommerceAssemblyV1 } from "../src/livePayDemCommerceAssembly.js";
import { createDacsX402BuyerPaymentTrackV1 } from "../src/x402Payment.js";
import { createDacsPayDemBuyerPaymentTrackV1 } from "../src/payDemPayment.js";

// No module or admission mocks: compose the real SDK release gate and host tracks.
const JOB = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const REFUSAL = { status: "operator-action", reasonCode: "current-dacs-profile-unavailable" };
function fixture(retained: boolean, recovery = false) {
  const effects = {
    prepare: vi.fn(), sign: vi.fn(), reserve: vi.fn(), beginEffect: vi.fn(),
    submit: vi.fn(), publish: vi.fn(), reconcile: vi.fn(async () => ({
      status: "indeterminate", reasonCode: "existing-payment-still-pending",
    })),
  };
  const database = {
    metadata: { mode: "live-demos", role: "buyer" },
    loadEffectInput: vi.fn(() => retained ? {} : undefined),
    putEffectIntent: vi.fn(() => ({ status: "inserted" })),
    claimEffect: vi.fn(() => ({ status: "acquired", mode: recovery ? "reconcile" : "execute",
      lease: { owner: "worker", generation: 1, expiresAt: 9999 } })),
    isCurrentEffect: () => true,
    requireEffectOperatorAction: vi.fn(),
    loadEffectCheckpoint: () => undefined,
    readTime: () => 1,
    recordEffectReconciliation: vi.fn(() => ({ status: "recorded" })),
  };
  const options = {
    database, workerId: "worker", finalityBlocks: 1,
    settlementStore: { load: vi.fn(async () => ({ status: "absent" })) },
    authorizationProvider: { authorizeIntent: vi.fn(), lookup: vi.fn(), authenticate: vi.fn() },
    transport: { submitRetained: effects.submit },
    walletSpendAuthority: { reserve: effects.reserve, reconcile: vi.fn() },
    prepareIntent: effects.sign, authorizePreparedIntent: vi.fn(),
    rail: { address: "1".repeat(64), settle: effects.submit },
    resolveAuthority: effects.prepare, reconcile: effects.reconcile,
    publishNotice: effects.publish,
  };
  const operation = {
    order: { role: "buyer", jobId: JOB },
    fence: { role: "buyer", track: "payment", jobId: JOB,
      idempotencyKey: "retained-payment", localBindingHash: "a".repeat(64),
      assertCurrent: async () => undefined },
  };
  return { effects, database, options, operation };
}

describe("unreleased current profile refuses new live effects", () => {
  it("uses SDK-owned admission", () => {
    expect(() => assertCurrentDacsProfileAdmission()).toThrow(/unreleased corrective candidate/);
  });
  it.each([
    createDacsFixedPriceX402BuyerLiveV1, createDacsFixedPricePayDemBuyerLiveV1,
    createDacsBuyerLiveCommerceAssemblyV1, createDacsBuyerPayDemLiveCommerceAssemblyV1,
    createDacsFixedPriceX402SellerLiveV1, createDacsFixedPricePayDemSellerLiveV1,
    createDacsSellerLiveCommerceAssemblyV1, createDacsSellerPayDemLiveCommerceAssemblyV1,
  ])("refuses live assembly before accessing any signing or payment capability", async (assemble) => {
    const touched = vi.fn(() => { throw new Error("unexpected capability access"); });
    await expect(assemble(new Proxy({}, { get: touched }) as never)).rejects.toMatchObject(REFUSAL);
    expect(touched).not.toHaveBeenCalled();
  });
  it.each([createDacsX402BuyerPaymentTrackV1, createDacsPayDemBuyerPaymentTrackV1])(
    "refuses fresh preparation and retained-but-unsubmitted execution with zero money effects",
    async (createTrack) => {
      for (const retained of [false, true]) {
        const f = fixture(retained);
        const track = createTrack(f.options as never);
        await expect(track(f.operation as never)).resolves.toMatchObject(REFUSAL);
        for (const spy of Object.values(f.effects)) expect(spy).not.toHaveBeenCalled();
        if (!retained) expect(f.database.putEffectIntent).not.toHaveBeenCalled();
      }
    },
  );
});

it.each([false, true])("keeps native DEM chain reconciliation available without new effects (settled=%s)", async (settled) => {
  const f = fixture(true, true);
  const hash = "a".repeat(64);
  const payment = { authorityVersion: "1", paymentInputVersion: "1", jobId: JOB,
    phaseIndex: 2, railId: "demos-native:DEM", railVersion: 1,
    railDescriptorHash: hash, network: "demos", payer: "1".repeat(64), payee: "2".repeat(64),
    amountOs: "1000000000", maxTotalDebitOs: "1000000000", agreementHash: hash,
    termsHash: hash, payoutBindingHash: hash, orderBindingHash: hash,
    orderLocalBindingHash: hash, settlementKey: settlementKey("demos-native:DEM", JOB, 2) };
  f.database.loadEffectInput.mockReturnValue(payment);
  if (settled) f.options.reconcile = vi.fn(async () => ({ status: "completed", settlement: {
    ok: true, txHash: "3".repeat(64), chainId: "demos", payer: payment.payer,
    payee: payment.payee, finality: { model: "bft-final" }, blockNumber: 43,
    txRefKind: "demos", amountOs: payment.amountOs, networkFeeOs: "0",
  } })) as never;
  const track = createDacsPayDemBuyerPaymentTrackV1(f.options as never);
  await expect(track(f.operation as never)).resolves.toMatchObject(settled
    ? { status: "final", outcome: "success" }
    : { status: "indeterminate", reasonCode: "existing-payment-still-pending" });
  expect(f.options.reconcile).toHaveBeenCalledOnce();
  for (const [key, spy] of Object.entries(f.effects)) {
    if (key !== "reconcile") expect(spy).not.toHaveBeenCalled();
  }
});

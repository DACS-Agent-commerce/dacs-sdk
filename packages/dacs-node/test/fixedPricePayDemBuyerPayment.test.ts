import { describe, expect, it, vi } from "vitest";

import {
  createDacsFixedPricePayDemBuyerReconciliationV1,
} from "../src/fixedPricePayDemBuyerPayment.js";

const payment = Object.freeze({
  authorityVersion: "1" as const,
  paymentInputVersion: "1" as const,
  jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
  phaseIndex: 2,
  railId: "demos-native:DEM",
  railVersion: 1,
  railDescriptorHash: "1".repeat(64),
  network: "demos" as const,
  payer: "2".repeat(64),
  payee: "3".repeat(64),
  amountOs: "1000000000",
  maxTotalDebitOs: "2000000000",
  agreementHash: "4".repeat(64),
  termsHash: "5".repeat(64),
  payoutBindingHash: "6".repeat(64),
  orderBindingHash: "7".repeat(64),
  orderLocalBindingHash: "8".repeat(64),
  settlementKey: "demos-native:DEM:01J8ME0SXKQ4T9V2RC5HJ6WX7D:2",
});

const prepared = Object.freeze({
  txHash: "9".repeat(64),
  nonce: 7,
  payer: payment.payer,
  payee: payment.payee,
  amountOs: payment.amountOs,
  network: "demos",
  maxTotalDebitOs: payment.maxTotalDebitOs,
  confirmedTotalDebitOs: "2000000000",
  recovery: {
    railId: payment.railId,
    jobId: payment.jobId,
    phaseIndex: payment.phaseIndex,
    settlementKey: payment.settlementKey,
    network: payment.network,
    payer: payment.payer,
    payee: payment.payee,
    amountOs: payment.amountOs,
  },
});

const fence = Object.freeze({ assertCurrent: vi.fn(async () => undefined) });

describe("fixed-price pay-dem buyer reconciliation", () => {
  it("proves no broadcast when no prepared checkpoint exists", async () => {
    const observe = vi.fn();
    const reconcile = createDacsFixedPricePayDemBuyerReconciliationV1(observe);
    const result = await reconcile({ payment, fence } as never);

    expect(result).toMatchObject({ status: "absent" });
    expect(result.status === "absent" && result.absenceProofHash)
      .toMatch(/^[0-9a-f]{64}$/);
    expect(observe).not.toHaveBeenCalled();
  });

  it("recovers only the exact included transfer", async () => {
    const reconcile = createDacsFixedPricePayDemBuyerReconciliationV1(
      vi.fn(async () => ({
        status: "included" as const,
        txHash: prepared.txHash,
        payer: payment.payer,
        payee: payment.payee,
        amountOs: payment.amountOs,
        blockNumber: 42,
        includedAt: 1_000,
      })),
    );
    await expect(reconcile({ payment, prepared, fence } as never)).resolves.toEqual({
      status: "completed",
      settlement: {
        ok: true,
        txHash: prepared.txHash,
        chainId: "demos",
        payer: payment.payer,
        payee: payment.payee,
        finality: { model: "bft-final" },
        blockNumber: 42,
        txRefKind: "demos",
        amountOs: payment.amountOs,
        networkFeeOs: "1000000000",
      },
    });
  });

  it("never treats a temporarily missing prepared hash as proof of absence", async () => {
    const reconcile = createDacsFixedPricePayDemBuyerReconciliationV1(
      vi.fn(async () => ({ status: "not-found" as const, reason: "not indexed" })),
    );
    await expect(reconcile({ payment, prepared, fence } as never)).resolves.toEqual({
      status: "indeterminate",
      reasonCode: "pay-dem-prepared-transfer-pending",
    });
  });

  it("fails closed when the observed transfer tuple differs", async () => {
    const reconcile = createDacsFixedPricePayDemBuyerReconciliationV1(
      vi.fn(async () => ({
        status: "included" as const,
        txHash: prepared.txHash,
        payer: payment.payer,
        payee: "a".repeat(64),
        amountOs: payment.amountOs,
        blockNumber: 42,
        includedAt: 1_000,
      })),
    );
    await expect(reconcile({ payment, prepared, fence } as never)).resolves.toEqual({
      status: "operator-action",
      reasonCode: "pay-dem-chain-observation-conflict",
    });
  });
});

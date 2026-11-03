import { describe, expect, it, vi } from "vitest";
import { observePayDemTransferCore } from "@kynesyslabs/dacs";

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
  it("requires operator recovery when the prepared checkpoint is missing", async () => {
    const observe = vi.fn();
    const reconcile = createDacsFixedPricePayDemBuyerReconciliationV1(observe);
    const result = await reconcile({ payment, fence } as never);

    expect(result).toEqual({
      status: "operator-action",
      reasonCode: "pay-dem-prepared-transfer-checkpoint-missing",
    });
    expect(observe).not.toHaveBeenCalled();
  });

  it("recovers only the exact executed transfer", async () => {
    const reconcile = createDacsFixedPricePayDemBuyerReconciliationV1(
      vi.fn(async () => ({
        status: "included" as const,
        execution: "executed" as const,
        nonce: prepared.nonce,
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
        execution: "executed",
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

  it.each([
    ["failed", { execution: "failed" }],
    ["unknown", { execution: "unknown" }],
    ["missing", {}],
    ["undefined", { execution: undefined }],
    ["null", { execution: null }],
    ["boolean", { execution: true }],
    ["record status", { execution: "confirmed" }],
  ] as const)("holds an included transfer with %s execution evidence", async (_label, evidence) => {
    const observe = vi.fn(async () => ({
      status: "included" as const,
      txHash: prepared.txHash,
      payer: payment.payer,
      payee: payment.payee,
      amountOs: payment.amountOs,
      blockNumber: 42,
      includedAt: 1_000,
      ...evidence,
    }));
    const reconcile = createDacsFixedPricePayDemBuyerReconciliationV1(observe as never);

    await expect(reconcile({ payment, prepared, fence } as never)).resolves.toEqual({
      status: "indeterminate",
      reasonCode: "pay-dem-chain-execution-unconfirmed",
    });
    expect(observe).toHaveBeenCalledExactlyOnceWith(prepared.txHash);
  });

  it.each([
    ["hash", { txHash: "a".repeat(64) }],
    ["payer", { payer: "a".repeat(64) }],
    ["payee", { payee: "a".repeat(64) }],
    ["amount", { amountOs: "NaN" }],
    ["nonce", { nonce: prepared.nonce + 1 }],
  ] as const)("rejects conflicting %s before missing execution evidence", async (_label, conflict) => {
    const reconcile = createDacsFixedPricePayDemBuyerReconciliationV1(async () => ({
      status: "included", nonce: prepared.nonce, txHash: prepared.txHash,
      payer: payment.payer, payee: payment.payee, amountOs: payment.amountOs,
      blockNumber: 42, includedAt: 1_000, ...conflict,
    }));
    await expect(reconcile({ payment, prepared, fence } as never)).resolves.toEqual({
      status: "operator-action", reasonCode: "pay-dem-chain-observation-conflict",
    });
  });

  it.each([
    ["confirmed", "7", "completed"],
    ["confirmed", "8", "operator-action"],
    ["confirmed", undefined, "operator-action"],
    ["included", "7", "indeterminate"],
    ["finalized", "7", "indeterminate"],
    ["failed", "7", "operator-action"],
  ] as const)("reconciles default observer record %s nonce %s as %s", async (recordStatus, nonce, status) => {
    const reconcile = createDacsFixedPricePayDemBuyerReconciliationV1((hash) =>
      observePayDemTransferCore(hash, {
        getTransactionStatus: async () => ({ state: "included", blockNumber: 42 }),
        getTxByHash: async () => ({
          hash: prepared.txHash,
          status: recordStatus,
          blockNumber: 42,
          content: {
            type: "native",
            ...(nonce === undefined ? {} : { nonce }),
            from: payment.payer,
            to: payment.payee,
            amount: payment.amountOs,
            data: ["native", {
              nativeOperation: "send",
              args: [payment.payee, payment.amountOs],
            }],
          },
        }),
        getBlockByNumber: async () => ({
          number: 42,
          status: "confirmed",
          content: { timestamp: 1, ordered_transactions: [prepared.txHash] },
        }),
      }),
    );

    const result = await reconcile({ payment, prepared, fence } as never);
    expect(result.status).toBe(status);
    if (status === "completed") {
      expect(result).toMatchObject({ settlement: {
        ok: true,
        txHash: prepared.txHash,
        payer: payment.payer,
        payee: payment.payee,
        amountOs: payment.amountOs,
        networkFeeOs: "1000000000",
        blockNumber: 42,
        finality: { model: "bft-final" },
      } });
    } else {
      expect(result).not.toHaveProperty("settlement");
      expect(result).toHaveProperty("reasonCode", status === "indeterminate"
        ? "pay-dem-chain-execution-unconfirmed" : nonce === "8"
          ? "pay-dem-chain-observation-conflict" : "pay-dem-prepared-transfer-invalid");
    }
  });

  it.each([undefined, null, "7", 8, -1, -0, 7.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects a custom execution attestation with missing or conflicting nonce %j", async (nonce) => {
      const observe = vi.fn(async () => ({
        status: "included", execution: "executed", nonce,
        txHash: prepared.txHash, payer: payment.payer, payee: payment.payee,
        amountOs: payment.amountOs, blockNumber: 42, includedAt: 1_000,
      }));
      const reconcile = createDacsFixedPricePayDemBuyerReconciliationV1(observe as never);
      await expect(reconcile({ payment, prepared, fence } as never)).resolves.toEqual({
        status: "operator-action", reasonCode: "pay-dem-chain-observation-conflict",
      });
      expect(observe).toHaveBeenCalledExactlyOnceWith(prepared.txHash);
    },
  );

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
        execution: "executed" as const,
        nonce: prepared.nonce,
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

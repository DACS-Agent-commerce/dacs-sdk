import { describe, expect, test } from "vitest";

import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import { verifyRailReceiptEvidence } from "../../src/rails/receiptEvidence.js";

const observedAt = 1780000000000;
const network = "eip155:84532";
const txHash = "0xsettled";
const chainObservation = async () => ({
  status: "success" as const,
  chainId: network,
  txHash,
  blockNumber: 100,
  blockTimestamp: observedAt,
  confirmations: 12,
});

function evidence(txRef: Record<string, unknown>, model: "block-depth" | "provider-receipt" = "block-depth") {
  return {
    evidenceVersion: "1",
    jobId: "job-receipt",
    phase: "pay-x402",
    phaseIndex: 3,
    outcome: "success",
    paymentTxRefs: [txRef],
    paymentAmount: { amount: "1000000", currency: "USDC" },
    settlementFinality: model === "block-depth"
      ? { model, finalityBlocks: 12, finalityObservedAt: observedAt }
      : { model, finalityObservedAt: observedAt },
    observedAt,
  };
}

function x402TxRef(overrides: Record<string, unknown> = {}) {
  const receipt = {
    network,
    transaction: txHash,
    x402Version: 2,
  };
  const facilitatorReceiptJcs = canonicalize(receipt);
  return {
    rail: network,
    txHash,
    kind: "x402",
    httpResource: "https://seller.example/deliver",
    paymentReceiptHash: sha256Hex(facilitatorReceiptJcs),
    protocolVersion: 2,
    facilitatorReceiptJcs,
    chainId: network,
    settlementTxHash: txHash,
    blockNumber: 100,
    blockTimestamp: observedAt,
    finalityBlocks: 12,
    ...overrides,
  };
}

describe("rail-native settlement receipt verification", () => {
  test("accepts coherent EVM block-depth evidence", async () => {
    const result = await verifyRailReceiptEvidence(
      evidence({
        rail: network,
        txHash,
        kind: "evm-erc20",
        blockNumber: 100,
        blockTimestamp: observedAt,
        finalityBlocks: 12,
      }),
      { verifyChainFinality: chainObservation },
    );
    expect(result).toEqual({ decision: "pass", reasons: [] });
  });

  test("rejects missing EVM depth or block metadata", async () => {
    const result = await verifyRailReceiptEvidence(evidence({
      rail: network,
      txHash,
      kind: "evm-erc20",
      blockNumber: 100,
      blockTimestamp: observedAt,
    }));
    expect(result.decision).toBe("fail");
  });

  test("accepts a canonical x402 receipt tied to chain finality", async () => {
    const result = await verifyRailReceiptEvidence(evidence(x402TxRef()), {
      verifyChainFinality: chainObservation,
    });
    expect(result).toEqual({ decision: "pass", reasons: [] });
  });

  test("is indeterminate when public chain-finality access is unavailable", async () => {
    const result = await verifyRailReceiptEvidence(evidence(x402TxRef()));
    expect(result.decision).toBe("indeterminate");
  });

  test.each(["reverted", "reorged", "not-final", "wrong-chain"] as const)(
    "rejects a publicly revalidated x402 transaction that is %s",
    async (status) => {
      const result = await verifyRailReceiptEvidence(evidence(x402TxRef()), {
        verifyChainFinality: async () => ({
          ...(await chainObservation()),
          status,
        }),
      });
      expect(result.decision).toBe("fail");
    },
  );

  test.each([
    ["tampered canonical receipt", { facilitatorReceiptJcs: canonicalize({ network, transaction: "0xtampered", x402Version: 2 }) }],
    ["missing receipt hash", { paymentReceiptHash: undefined }],
    ["missing protocol", { protocolVersion: undefined }],
    ["wrong chain", { chainId: "eip155:1" }],
  ])("rejects %s", async (_label, override) => {
    const result = await verifyRailReceiptEvidence(evidence(x402TxRef(override)));
    expect(result.decision).toBe("fail");
  });

  test("requires facilitator trust to verify a signed no-tx receipt", async () => {
    const receipt = { network, signature: "facilitator-signature", x402Version: 2 };
    const facilitatorReceiptJcs = canonicalize(receipt);
    const ref = x402TxRef({
      txHash: "",
      settlementTxHash: undefined,
      facilitatorReceiptJcs,
      paymentReceiptHash: sha256Hex(facilitatorReceiptJcs),
      facilitatorSignature: "facilitator-signature",
      blockNumber: undefined,
      blockTimestamp: undefined,
      finalityBlocks: undefined,
    });
    expect((await verifyRailReceiptEvidence(evidence(ref, "provider-receipt"))).decision)
      .toBe("indeterminate");
    expect((await verifyRailReceiptEvidence(evidence(ref, "provider-receipt"), {
      verifyFacilitatorReceipt: () => true,
    })).decision).toBe("pass");
    expect((await verifyRailReceiptEvidence(evidence(ref, "provider-receipt"), {
      verifyFacilitatorReceipt: () => false,
    })).decision).toBe("fail");
  });
});

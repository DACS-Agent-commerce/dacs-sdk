import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { verifyX402ReceiptClaim } from "../../src/seller/index.js";

interface ReceiptVector {
  name: string;
  expected: "pass" | "fail" | "error";
  protocolVersion: string;
  responseHeader: { name: string; value: string };
  evidence?: {
    paymentReceiptHash: string;
    settlementTxHash?: string;
    chainId?: number;
  };
  want: {
    reason?: string;
    canonicalReceipt?: string;
    paymentReceiptHash?: string;
    computedPaymentReceiptHash?: string;
  };
}

const vectors = JSON.parse(readFileSync(
  new URL(
    "../../vendor/DACS-Standard/conformance/vectors/security/x402-receipt-hash-v0.1.json",
    import.meta.url,
  ),
  "utf8",
)) as { vectors: ReceiptVector[] };

describe("verifyX402ReceiptClaim — DACS-4 §9.5.7", () => {
  for (const vector of vectors.vectors) {
    it(`replays ${vector.name}`, () => {
      const result = verifyX402ReceiptClaim({
        protocolVersion: vector.protocolVersion,
        responseHeader: vector.responseHeader,
        evidence: vector.evidence ?? { paymentReceiptHash: "0".repeat(64) },
      });

      expect(result.disposition).toBe(vector.expected);
      if (vector.want.reason) expect(result.reason).toBe(vector.want.reason);
      if (vector.want.canonicalReceipt) {
        expect(result.canonicalReceipt).toBe(vector.want.canonicalReceipt);
      }
      if (vector.want.paymentReceiptHash) {
        expect(result.computedPaymentReceiptHash).toBe(vector.want.paymentReceiptHash);
      }
      if (vector.want.computedPaymentReceiptHash) {
        expect(result.computedPaymentReceiptHash).toBe(
          vector.want.computedPaymentReceiptHash,
        );
      }
    });
  }

  it("fails closed on an unsupported otherwise-canonical version", () => {
    const result = verifyX402ReceiptClaim({
      protocolVersion: "3",
      responseHeader: { name: "PAYMENT-RESPONSE", value: "e30=" },
      evidence: { paymentReceiptHash: "0".repeat(64) },
    });
    expect(result).toEqual({
      disposition: "error",
      reason: "unsupported-protocolVersion",
    });
  });
});

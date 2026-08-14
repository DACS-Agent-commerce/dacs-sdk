import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
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

  it("rejects non-canonical base64 padding instead of accepting a lenient decode", () => {
    const result = verifyX402ReceiptClaim({
      protocolVersion: "2",
      responseHeader: { name: "PAYMENT-RESPONSE", value: "ew=" },
      evidence: { paymentReceiptHash: "0".repeat(64) },
    });
    expect(result).toEqual({ disposition: "error", reason: "invalid-base64" });
  });

  it.each([
    '{"success":false,"success":true,"transaction":"0x1","network":"eip155:1","payer":"0x2"}',
    '{"success":true,"transaction":"0x1","network":"eip155:1","payer":"0x2","extension":{"proof":false,"proof":true}}',
    '{"success":false,"\\u0073uccess":true,"transaction":"0x1","network":"eip155:1","payer":"0x2"}',
  ])("rejects duplicate decoded object names before JCS hashing: %s", (json) => {
    const result = verifyX402ReceiptClaim({
      protocolVersion: "2",
      responseHeader: {
        name: "PAYMENT-RESPONSE",
        value: Buffer.from(json, "utf8").toString("base64"),
      },
      evidence: { paymentReceiptHash: "0".repeat(64) },
    });

    expect(result).toEqual({
      disposition: "error",
      reason: "invalid-settlementResponse-schema",
    });
  });

  it.each([
    ["success", { success: 1 }],
    ["errorReason", { errorReason: false }],
    ["errorMessage", { errorMessage: {} }],
    ["payer", { payer: ["0x2"] }],
    ["transaction", { transaction: 7 }],
    ["network", { network: 84532 }],
    ["amount", { amount: 7 }],
    ["extensions", { extensions: [] }],
    ["extra", { extra: "not-an-object" }],
  ])("rejects a malformed v2 SettlementResponse %s member", (_field, override) => {
    const receipt = {
      success: true,
      transaction: "0x1",
      network: "eip155:84532",
      payer: "0x2",
      ...override,
    };
    const result = verifyX402ReceiptClaim({
      protocolVersion: "2",
      responseHeader: {
        name: "PAYMENT-RESPONSE",
        value: Buffer.from(JSON.stringify(receipt), "utf8").toString("base64"),
      },
      // Match the complete malformed object so the schema gate, rather than a
      // later commitment mismatch, is what rejects it.
      evidence: { paymentReceiptHash: sha256Hex(canonicalize(receipt)) },
    });

    expect(result).toEqual({
      disposition: "error",
      reason: "invalid-settlementResponse-schema",
    });
  });

  it("retains an unrecognised v1 member without assigning v2 schema semantics", () => {
    const receipt = {
      success: true,
      transaction: "0x1",
      network: "base-sepolia",
      payer: "0x2",
      amount: 7,
    };
    const result = verifyX402ReceiptClaim({
      protocolVersion: "1",
      responseHeader: {
        name: "X-PAYMENT-RESPONSE",
        value: Buffer.from(JSON.stringify(receipt), "utf8").toString("base64"),
      },
      evidence: { paymentReceiptHash: sha256Hex(canonicalize(receipt)) },
    });

    expect(result.disposition).toBe("pass");
    expect(result.receipt).toEqual(receipt);
  });
});

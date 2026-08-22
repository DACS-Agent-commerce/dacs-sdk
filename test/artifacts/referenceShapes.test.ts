import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  isAttestationRef,
  isChainTxRef,
  isLegacyMvpAttestationRef,
  isLegacyMvpSettlementEvidence,
  isLegacyMvpTxRef,
} from "../../src/index.js";

const VECTOR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../vendor/DACS-Standard/conformance/vectors/security/artifact-reference-shapes-v0.1.json",
);
const haveVector = existsSync(VECTOR);

interface ShapeCase {
  name: string;
  type: "AttestationRef" | "ChainTxRef";
  expected: "pass" | "fail";
  value: unknown;
}

describe.skipIf(!haveVector)(
  "DACS-2 §7.5.2 / DACS-4 §9.3 exact reference-shape oracle",
  () => {
    const vector = JSON.parse(readFileSync(VECTOR, "utf8")) as {
      count: number;
      vectors: ShapeCase[];
    };

    it("replays every pinned Standard case", () => {
      expect(vector.vectors).toHaveLength(vector.count);
      expect(vector.count).toBe(23);

      for (const testCase of vector.vectors) {
        const actual =
          testCase.type === "AttestationRef"
            ? isAttestationRef(testCase.value)
            : isChainTxRef(testCase.value);
        expect(actual, testCase.name).toBe(testCase.expected === "pass");
      }
    });

    it("keeps pre-#308 SDK records only behind the named compatibility layer", () => {
      const legacyRef = {
        kind: "dacs-4-evidence",
        id: "settlement-job-5",
        contentHash: "a".repeat(64),
      };
      const legacyTx = {
        rail: "pay-x402",
        txHash: "0xabc",
        kind: "payment",
      };

      expect(isAttestationRef(legacyRef)).toBe(false);
      expect(isChainTxRef(legacyTx)).toBe(false);
      expect(isLegacyMvpAttestationRef(legacyRef)).toBe(true);
      expect(isLegacyMvpTxRef(legacyTx)).toBe(true);

      // A current event coordinate cannot be laundered through the old
      // phaseIndex evidence envelope. Current producers use normative
      // SettlementEvidence; only a transitional bundle summary may copy it.
      expect(isLegacyMvpSettlementEvidence({
        evidenceVersion: "1",
        jobId: "job-5",
        phase: "pay-x402",
        phaseIndex: 3,
        outcome: "success",
        paymentTxRefs: [{
          kind: "x402-event",
          httpResource: "https://seller.example/deliver",
          paymentReceiptHash: "b".repeat(64),
          settlementTxHash: "c".repeat(64),
          chainId: 84532,
          logIndex: 0,
          protocolVersion: "2",
        }],
        paymentAmount: { amount: "1", currency: "USDC" },
        settlementFinality: {
          model: "block-depth",
          finalityBlocks: 1,
          finalityObservedAt: 1,
        },
        observedAt: 1,
      })).toBe(false);
    });
  },
);

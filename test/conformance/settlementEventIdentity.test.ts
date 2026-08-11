import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  canonicalize,
  ed25519Verify,
  publicKeyFromRaw,
  resolveSettlementEventIdentity,
  sha256Hex,
  type AuthenticatedSettlementLedgerEvent,
  type SettlementEventIdentityContext,
} from "../../src/index.js";

const VECTOR_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../vendor/DACS-Standard/conformance/vectors/security/settlement-event-identity-v0.6.json",
);
const haveVector = existsSync(VECTOR_PATH);

interface SettlementEventVector {
  name: string;
  expected: "pass" | "fail" | "error" | "indeterminate";
  anchorAddress: string;
  phaseIndex: number;
  verificationContext: {
    asset: string;
    payer: string;
    payee: string;
    amount: { amount: string; currency: string };
    railId: string;
    x402Receipt?: {
      verified: true;
      paymentReceiptHash: string;
      settlementTxHash: string;
      chainId: number;
    };
  };
  ledgerEvents?: AuthenticatedSettlementLedgerEvent[] | null;
  priorClaims?: Record<string, { jobId: string; phaseIndex: number }>;
  settlementEvidence: unknown;
  expectedSettlementTxId?: string;
}

describe.skipIf(!haveVector)(
  "DACS-4 v0.6 signed settlement-event identity oracle",
  () => {
    const document = JSON.parse(readFileSync(VECTOR_PATH, "utf8")) as {
      count: number;
      hash: string;
      publicKey: string;
      vectors: SettlementEventVector[];
    };
    const publicKey = Uint8Array.from(Buffer.from(document.publicKey, "hex"));
    const deps = {
      resolvePublicKey: () => publicKey,
      verify: (
        bytes: Uint8Array,
        signature: Uint8Array,
        rawKey: Uint8Array,
      ) => ed25519Verify(bytes, signature, publicKeyFromRaw(rawKey)),
    };

    it("pins the complete upstream case set and hash", () => {
      expect(document.vectors).toHaveLength(document.count);
      expect(document.count).toBe(28);
      expect(sha256Hex(canonicalize(document.vectors))).toBe(document.hash);
      expect(new Set(document.vectors.map(({ name }) => name)).size)
        .toBe(document.count);
    });

    it("replays every current and legacy event-identity decision", async () => {
      for (const vector of document.vectors) {
        const context: SettlementEventIdentityContext = {
          anchorAddress: vector.anchorAddress,
          phaseIndex: vector.phaseIndex,
          railId: vector.verificationContext.railId,
          asset: vector.verificationContext.asset,
          payer: vector.verificationContext.payer,
          payee: vector.verificationContext.payee,
          amount: vector.verificationContext.amount,
          ...(vector.ledgerEvents === undefined
            ? {}
            : { ledgerEvents: vector.ledgerEvents }),
          ...(vector.verificationContext.x402Receipt === undefined
            ? {}
            : { x402Receipt: vector.verificationContext.x402Receipt }),
          ...(vector.priorClaims === undefined
            ? {}
            : { priorClaims: vector.priorClaims }),
        };
        const result = await resolveSettlementEventIdentity(
          vector.settlementEvidence,
          context,
          deps,
        );
        expect(result.decision, `${vector.name}: ${JSON.stringify(result)}`)
          .toBe(vector.expected);
        if (vector.expected === "pass") {
          expect(result, vector.name).toMatchObject({
            settlementId: vector.expectedSettlementTxId,
          });
        }
      }
    });
  },
);

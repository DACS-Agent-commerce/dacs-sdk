import { describe, expect, it, vi } from "vitest";

// The publication receipt verifier does not consume the payment authorization;
// isolate its issuer/receipt/readback contract from native payment observation.
vi.mock("../src/sellerX402Runtime.js", () => ({
  loadDacsSellerX402AuthorizationForOrderV1: () => ({
    paymentPermitId: "permit",
    paymentAuthorization: {},
  }),
}));
vi.mock("../src/payDemSellerPayment.js", () => ({
  loadDacsPayDemSellerPaymentAuthorizationForOrderV1: async () => ({
    result: { permitId: "permit" },
    authorization: {},
  }),
}));

import type {
  AnchorReceipt,
  AttestationRef,
  SettlementEvidence,
} from "@kynesyslabs/dacs/artifacts";
import { contentHash, sha256Hex } from "@kynesyslabs/dacs/canonical";
import {
  createDacsFixedPricePayDemSellerPaymentEvidenceV1,
  createDacsFixedPriceX402SellerPaymentEvidenceV1,
} from "../src/fixedPriceX402SellerPaymentEvidence.js";
import { createSellerPaymentEvidenceReceiptVerifier } from "../src/paymentEvidenceReceipt.js";
import type { DacsLiveRoleOperationContextV1 } from "../src/roleRuntime.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = `did:demos:agent:${"1".repeat(64)}`;
const SELLER = `did:demos:agent:${"2".repeat(64)}`;
const QUALIFIED_SELLER = `${SELLER}?role=publisher`;
const OTHER_ISSUER = `did:demos:agent:${"9".repeat(64)}`;
const EFFECT_ID = "seller-publication-issuer";
const LOGICAL_ADDRESS = `dacs4:payment:${JOB_ID}:rail:0`;

function fixture(rail: "x402" | "pay-dem") {
  const evidence: SettlementEvidence = {
    evidenceVersion: "1",
    jobId: JOB_ID,
    phase: rail === "x402" ? "pay-x402" : "pay-dem",
    outcome: "success",
    observedAt: 7_000,
    paymentTxRefs: [{ kind: "demos", txHash: "3".repeat(64), blockNumber: 10 }],
    paymentAmount: { amount: "1", currency: "DEM" },
    settlementFinality: { model: "bft-final", finalityObservedAt: 7_000 },
    signature: { algorithm: "ed25519", signer: SELLER, value: "c2ln" },
  };
  const evidenceHash = contentHash(evidence as unknown as Record<string, unknown>);
  const receipt: AnchorReceipt = {
    receiptVersion: "1",
    substrate: "demos",
    finalityProfile: "demos-bft",
    logicalAddress: LOGICAL_ADDRESS,
    nativeAddress: "native:payment-evidence",
    contentHash: evidenceHash,
    transactionRef: { kind: "demos", value: "tx:payment-evidence" },
    writer: BUYER,
    state: "finalized",
    observationDisposition: "established",
    observedAt: 7_000,
    blockRef: { id: "block-10", height: "10", timestamp: 7_000 },
    evidence: { kind: "demos-bft-proof", value: "proof" },
  };
  const rows = new Map<string, unknown>([[
    sha256Hex("dacs-live-seller-payment-evidence:v1:" + EFFECT_ID),
    {
      retainedEvidenceVersion: "1",
      effectId: EFFECT_ID,
      jobId: JOB_ID,
      localBindingHash: "4".repeat(64),
      logicalAddress: LOGICAL_ADDRESS,
      evidenceHash,
      evidence,
      expectedWriter: { role: "buyer", primaryClaim: BUYER },
    },
  ]]);
  const putEffectIntent = vi.fn((input: { effectId: string; input: unknown }) => {
    rows.set(input.effectId, structuredClone(input.input));
    return { status: "created" };
  });
  const verifyDemosAnchorReceipt = vi.fn(async () => true);
  const readAnchor = vi.fn(async () => evidence);
  const context = {
    role: "seller",
    authority: SELLER,
    peerAuthority: BUYER,
    database: {
      loadEffectInput: (_kind: string, id: string) => rows.get(id),
      putEffectIntent,
    },
    demos: { adapter: { verifyDemosAnchorReceipt, readAnchor } },
  } as unknown as DacsLiveRoleOperationContextV1;
  const composed = rail === "x402"
    ? createDacsFixedPriceX402SellerPaymentEvidenceV1({
        context,
        settlement: {
          observer: {},
          resolveOrderScope: () => ({ paymentPhaseIndex: 0 }),
        } as never,
      })
    : createDacsFixedPricePayDemSellerPaymentEvidenceV1({
        context,
        observeDemosTransfer: vi.fn(),
      });
  return { composed, evidence, context, evidenceHash, receipt, putEffectIntent, verifyDemosAnchorReceipt, readAnchor };
}

describe.each(["x402", "pay-dem"] as const)("%s publication issuer admission", (rail) => {
  it.each([SELLER, QUALIFIED_SELLER, undefined, OTHER_ISSUER,
    `${OTHER_ISSUER}?role=publisher`, BUYER])(
    "admits only authenticated evidence attribution or an unsigned reference: %s",
    async (signer) => {
      const f = fixture(rail);
      const resolved = await f.composed.settlement.resolvePublication({
        operation: { order: { buyer: BUYER, seller: SELLER } } as never,
        retained: {} as never,
      });
      const evidenceRef: AttestationRef = {
        anchor: { kind: "storage-program", locator: LOGICAL_ADDRESS },
        contentHash: f.evidenceHash,
        ...(signer === undefined ? {} : { signer }),
      };
      const result = await resolved.dependencies.verifyAnchorReceipt({
        effectId: EFFECT_ID,
        expectedWriter: BUYER,
        evidenceRef,
        anchorReceipt: f.receipt,
      });
      if (signer === SELLER || signer === QUALIFIED_SELLER || signer === undefined) {
        expect(result).toEqual({ disposition: "pass" });
        expect(f.verifyDemosAnchorReceipt).toHaveBeenCalledWith(f.receipt);
        expect(f.readAnchor).toHaveBeenCalledWith(f.receipt.nativeAddress);
        expect(f.putEffectIntent).toHaveBeenCalledOnce();
        expect(f.putEffectIntent.mock.calls[0]?.[0].input).toMatchObject({ evidenceRef });
        await expect(resolved.dependencies.resolveEvidence({
          effectId: EFFECT_ID,
          evidenceRef,
        })).resolves.toMatchObject({ disposition: "present" });
      } else {
        expect(result).toMatchObject({ disposition: "fail" });
        expect(f.verifyDemosAnchorReceipt).not.toHaveBeenCalled();
        expect(f.readAnchor).not.toHaveBeenCalled();
        expect(f.putEffectIntent).not.toHaveBeenCalled();
      }
    },
  );

  it.each([SELLER, QUALIFIED_SELLER, undefined])(
    "still requires a verified native receipt for an admissible signer: %s", async (signer) => {
      const f = fixture(rail);
      f.verifyDemosAnchorReceipt.mockResolvedValue(false);
      const resolved = await f.composed.settlement.resolvePublication({
        operation: { order: { buyer: BUYER, seller: SELLER } } as never,
        retained: {} as never,
      });
      await expect(resolved.dependencies.verifyAnchorReceipt({
        effectId: EFFECT_ID,
        expectedWriter: BUYER,
        evidenceRef: {
          anchor: { kind: "storage-program", locator: LOGICAL_ADDRESS },
          contentHash: f.evidenceHash,
          ...(signer === undefined ? {} : { signer }),
        },
        anchorReceipt: f.receipt,
      })).resolves.toMatchObject({ disposition: "indeterminate" });
      expect(f.putEffectIntent).not.toHaveBeenCalled();
    },
  );
});

// Call the exact callback directly, so no core handshake guard can mask a
// missing host issuer check. All other receipt bindings are valid.
describe.each(["x402", "pay-dem", "default"] as const)("%s direct completion receipt verifier", (kind) => {
  it.each([SELLER, QUALIFIED_SELLER, undefined, OTHER_ISSUER, BUYER])(
    "checks reference issuer before readback: %s", async (signer) => {
      const f = fixture(kind === "default" ? "pay-dem" : kind);
      const verifyReceipt = kind === "default"
        ? createSellerPaymentEvidenceReceiptVerifier(f.context)
        : f.composed.paymentEvidence.verifyAnchorReceipt!;
      const result = await verifyReceipt({
        request: {
          evidence: f.evidence, logicalAddress: LOGICAL_ADDRESS, evidenceHash: f.evidenceHash,
        },
        completion: {
          evidenceRef: {
            anchor: { kind: "storage-program", locator: LOGICAL_ADDRESS },
            contentHash: f.evidenceHash,
            ...(signer === undefined ? {} : { signer }),
          },
          anchorReceipt: f.receipt,
        },
      } as never);
      if (signer === SELLER || signer === QUALIFIED_SELLER || signer === undefined) {
        expect(result).toEqual({ disposition: "valid" });
        expect(f.verifyDemosAnchorReceipt).toHaveBeenCalledOnce();
      } else {
        expect(result.disposition).toBe("invalid");
        expect(f.verifyDemosAnchorReceipt).not.toHaveBeenCalled();
        expect(f.readAnchor).not.toHaveBeenCalled();
      }
    },
  );
});

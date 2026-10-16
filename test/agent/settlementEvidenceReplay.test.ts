import { describe, expect, test, vi } from "vitest";
import {
  inspectHistoricalSettlementEvidence,
  validateSettlementEvidenceStructure,
  verifySettlementEvidence,
  type AuthenticatedEvidenceContext,
} from "../../src/agent/verifySettlementEvidence.js";
import { contentHash, stripSignature } from "../../src/canonical/index.js";

const JOB = "01JZ0000000000000000000360";
const ORCHESTRATOR = "did:demos:orchestrator";
// These tests isolate admission policy, not cryptographic authenticity.
const deps = () => ({
  resolvePublicKey: vi.fn(async () => new Uint8Array(32)),
  verify: vi.fn(() => true),
});
const signature = () => ({
  algorithm: "ed25519", signer: ORCHESTRATOR,
  value: Buffer.alloc(64).toString("base64url"),
});
function payment(phase: string, model: string, ref: object) {
  return {
    evidenceVersion: "1", jobId: JOB, phase, outcome: "success",
    observedAt: 1_700_000_000_000,
    paymentAmount: { amount: "5", currency: "TEST" },
    paymentTxRefs: [ref],
    settlementFinality: { model, finalityObservedAt: 1_700_000_000_000 },
    signature: signature(),
  };
}
const x402 = { kind: "x402", httpResource: "https://seller.example/resource",
  paymentReceiptHash: "b".repeat(64), protocolVersion: "2" };
function delivery() {
  return {
    evidenceVersion: "1", jobId: JOB, phase: "deliver-entitlement",
    outcome: "success", observedAt: 1_700_000_000_000,
    deliverableContentHash: "a".repeat(64),
    deliverableAnchor: { kind: "storage-program", locator: "delivery:expected" },
    signature: signature(),
  };
}

describe("historical evidence inspection boundaries", () => {
  test.each([
    ["pay-dem", "bft-final", { kind: "demos", txHash: "a".repeat(64) }],
    ["pay-evm-erc20", "block-depth", { kind: "evm", chainId: 80002, txHash: "0xsettled" }],
    ["pay-solana-spl", "commitment-level", { kind: "solana", cluster: "devnet", signature: "settled" }],
    ["pay-cross-chain-htlc", "htlc-reveal", { kind: "htlc-claim", chainId: 80002, contractAddress: "0xcontract", claimTxHash: "0xclaim" }],
    ["pay-cross-chain-liquidity-tank", "liquidity-tank", { kind: "liquidity-tank", bridgeId: "bridge", sourceChainId: 1, destChainId: 80002, lockTxHash: "0xlock", releaseTxHash: "0xrelease" }],
    ["pay-ap2", "provider-receipt", { kind: "ap2", mandateId: "mandate", providerRef: "provider", protocolVersion: "1", receiptAttestation: { anchor: { kind: "storage-program", locator: "ap2:receipt" }, contentHash: "a".repeat(64) } }],
    ["pay-x402", "block-depth", x402],
  ] as const)("applies the phase-owned model for %s", async (phase, model, ref) => {
    const evidence = payment(phase, model, ref);
    expect((await inspectHistoricalSettlementEvidence(evidence, {}, deps())).decision).toBe("valid");
    evidence.settlementFinality.model = model === "block-depth" ? "bft-final" : "block-depth";
    expect((await inspectHistoricalSettlementEvidence(evidence, {}, deps())).decision).toBe("invalid");
  });

  test.each(["permanent", "transient", "counterparty", "substrate", "settlement-atomicity"])(
    "accepts registered failure classification %s and rejects unknown classifications", async (errorClass) => {
      const evidence = {
        evidenceVersion: "1", jobId: JOB, phase: "pay-dem", outcome: "failure",
        observedAt: 1_700_000_000_000, reason: "settlement unavailable", signature: signature(),
      };
      expect((await inspectHistoricalSettlementEvidence(evidence, { result: { ok: false, errorClass } }, deps())).decision).toBe("valid");
      expect((await inspectHistoricalSettlementEvidence(evidence, { result: { ok: false, errorClass: "unknown" } }, deps())).decision).toBe("invalid");
    },
  );

  test.each(["both", "resolver", "verifier"])("requires both cryptographic dependencies (missing %s)", async (missing) => {
    const complete = deps();
    const incomplete = missing === "both" ? {} : missing === "resolver"
      ? { verify: complete.verify } : { resolvePublicKey: complete.resolvePublicKey };
    expect(await inspectHistoricalSettlementEvidence(delivery(), {}, incomplete as never)).toEqual({
      decision: "error", reasons: ["historical signature inspection requires cryptographic dependencies"],
    });
    expect(complete.resolvePublicKey).not.toHaveBeenCalled();
    expect(complete.verify).not.toHaveBeenCalled();
  });

  test.each(["unavailable", "throws", "malformed"])("preserves %s key disposition", async (kind) => {
    const crypto = deps();
    const resolvePublicKey = async () => {
      if (kind === "throws") throw new Error("unavailable");
      return kind === "unavailable" ? null : new Uint8Array(31);
    };
    const result = await inspectHistoricalSettlementEvidence(delivery(), {}, { ...crypto, resolvePublicKey });
    expect(result.decision).toBe(kind === "malformed" ? "error" : "incomplete");
    expect(result.reasons.join(" ")).toMatch(kind === "malformed" ? /malformed/ : /unresolvable|could not be resolved/);
    expect(crypto.verify).not.toHaveBeenCalled();
  });

  test("limits the historical finality exception to provider-receipt x402", async () => {
    expect((await inspectHistoricalSettlementEvidence(payment("pay-x402", "provider-receipt", x402), {}, deps())).decision).toBe("valid");
    expect((await inspectHistoricalSettlementEvidence(payment("pay-x402", "bft-final", x402), {}, deps())).decision).toBe("invalid");
    expect((await inspectHistoricalSettlementEvidence(payment("pay-dem", "provider-receipt", { kind: "demos", txHash: "a".repeat(64) }), {}, deps())).decision).toBe("invalid");
  });

  test("successful entitlement inspection retains the delivery-anchor requirement", async () => {
    const { deliverableAnchor: _anchor, ...evidence } = delivery();
    expect((await validateSettlementEvidenceStructure(evidence)).decision).toBe("invalid");
    expect((await inspectHistoricalSettlementEvidence(evidence, {}, deps())).decision).toBe("invalid");
  });

  test("successful delivery still requires its independently expected locator", async () => {
    const evidence = delivery();
    const context: AuthenticatedEvidenceContext = {
      orchestrator: ORCHESTRATOR, agreement: { amount: "1", currency: "TEST" },
      result: { ok: true },
      attestationRef: {
        anchor: { kind: "storage-program", locator: "evidence:delivery" },
        contentHash: contentHash(stripSignature(evidence)),
      },
    };
    const result = await verifySettlementEvidence(evidence, context, deps());
    expect(result.decision).toBe("error");
    expect(result.reasons).toContain("authenticated delivery evidence context requires the expected deliverable locator");
    expect((await verifySettlementEvidence(evidence, {
      ...context, expectedAnchorLocator: evidence.deliverableAnchor.locator,
    }, deps())).decision).toBe("pass");
  });
});

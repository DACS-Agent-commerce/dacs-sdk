import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, test } from "vitest";

import {
  verifySettlementEvidence,
  type EvidenceContext,
  type EvidenceDeps,
} from "../../src/agent/verifySettlementEvidence.js";
import { ed25519Verify, publicKeyFromRaw } from "../../src/crypto/index.js";

const CONF = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../vendor/DACS-Standard/conformance",
);
const haveVectors = existsSync(join(CONF, "vectors/golden.json"));
const read = (p: string) => JSON.parse(readFileSync(join(CONF, p), "utf8"));

const b64u = (s: string) => Uint8Array.from(Buffer.from(s, "base64url"));

// Resolve the orchestrator's real key + verify with real ed25519.
function realDeps(publicKeys: Record<string, string>): EvidenceDeps {
  return {
    resolvePublicKey: async (signer) =>
      publicKeys[signer] ? b64u(publicKeys[signer]) : null,
    verify: (bytes, sig, key) => ed25519Verify(bytes, sig, publicKeyFromRaw(key)),
  };
}

const ORCH = "did:demos:orchestrator";

describe.skipIf(!haveVectors)("verifySettlementEvidence — §14 golden fixtures", () => {
  const golden = read("vectors/golden.json").settlement;
  const paymentFx = read("fixtures/settlement-evidence-payment-success.json");
  const deliveryFx = read("fixtures/settlement-evidence-delivery-success.json");
  const deps = realDeps(golden.publicKeys ?? deliveryFx.publicKeys);

  const paymentCtx: EvidenceContext = {
    orchestrator: ORCH,
    attestationRef: paymentFx.result.attestationRef,
  };
  const deliveryCtx: EvidenceContext = {
    orchestrator: ORCH,
    attestationRef: deliveryFx.result.attestationRef,
  };

  it("paymentPass — the reference payment-success record verifies", async () => {
    const r = await verifySettlementEvidence(paymentFx.evidence, paymentCtx, deps);
    expect(r.decision).toBe("pass");
    expect(r.reasons).toEqual([]);
  });

  it("deliveryPass — the reference delivery-success record verifies", async () => {
    const r = await verifySettlementEvidence(deliveryFx.evidence, deliveryCtx, deps);
    expect(r.decision).toBe("pass");
    expect(r.reasons).toEqual([]);
  });

  it("evidence signed-scope hash equals the golden evidenceHash (sig excluded)", async () => {
    // A tampered record must not verify under the real key.
    const tampered = { ...paymentFx.evidence, observedAt: 1 };
    const r = await verifySettlementEvidence(tampered, paymentCtx, deps);
    expect(r.decision).toBe("fail");
  });
});

// ── Decision-by-decision, over constructed mutations of the base records ──
describe.skipIf(!haveVectors)("verifySettlementEvidence — settlement decision rules", () => {
  const payment = () =>
    structuredClone(read("fixtures/settlement-evidence-payment-success.json").evidence);
  const delivery = () =>
    structuredClone(read("fixtures/settlement-evidence-delivery-success.json").evidence);

  // Structural mutations run WITHOUT key deps: the record signature is left
  // intact but unverified, so the structural violation is the sole verdict.
  const verify = (ev: unknown, ctx: EvidenceContext = {}) =>
    verifySettlementEvidence(ev, ctx, {});

  test("paymentPass: base record with no context is a clean pass", async () => {
    expect((await verify(payment())).decision).toBe("pass");
  });
  test("SB-1 phase context rejects a missing event-level identity as error", async () => {
    const result = await verify(payment(), { phaseIndex: 0 });
    expect(result.decision).toBe("error");
    expect(result.reasons).toContainEqual(expect.stringMatching(/SB-1.*logIndex/));
  });
  test("SB-1 phase context accepts a canonical event-level identity", async () => {
    const ev = payment();
    ev.paymentTxRefs[0].txHash = `0x${"ab".repeat(32)}`;
    ev.paymentTxRefs[0].logIndex = 0;
    expect((await verify(ev, { phaseIndex: 0 })).decision).toBe("pass");
  });
  test("SB-1 phase context fails closed when a payment variant has no pinned identity", async () => {
    const ev = payment();
    ev.phase = "pay-cross-chain-htlc";
    ev.paymentTxRefs = [
      {
        kind: "htlc-claim",
        chainId: 1,
        contractAddress: "0xcontract",
        claimTxHash: `0x${"ab".repeat(32)}`,
      },
    ];
    const result = await verify(ev, { phaseIndex: 0 });
    expect(result.decision).toBe("error");
    expect(result.reasons).toContainEqual(
      expect.stringMatching(/SB-1.*no standalone identity recipe/),
    );
  });
  test("SB-3 mismatch fails; absent/unverifiable requires the SB-1 fallback", async () => {
    const ev = payment();
    ev.paymentTxRefs[0].txHash = `0x${"ab".repeat(32)}`;
    ev.paymentTxRefs[0].logIndex = 0;
    expect(
      (await verify(ev, { phaseIndex: 0, sessionBinding: "mismatches" }))
        .decision,
    ).toBe("fail");
    expect(
      (await verify(ev, { sessionBinding: "unverifiable" })).decision,
    ).toBe("indeterminate");
    expect(
      (await verify(ev, { phaseIndex: 0, sessionBinding: "absent" })).decision,
    ).toBe("pass");
  });
  test("deliveryPass: base delivery record passes", async () => {
    expect((await verify(delivery())).decision).toBe("pass");
  });

  test("a non-object root is `error`, not fail (input isn't a record, §7.5.1)", async () => {
    expect((await verify(null)).decision).toBe("error");
    expect((await verify("nope" as unknown)).decision).toBe("error");
  });

  test("successPaymentMissingFinality → fail", async () => {
    const ev = payment();
    delete ev.settlementFinality;
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("successMissingPaymentTxRefs → fail", async () => {
    const ev = payment();
    delete ev.paymentTxRefs;
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("successMissingPaymentAmount → fail", async () => {
    const ev = payment();
    delete ev.paymentAmount;
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("nonCanonicalAmount → fail", async () => {
    const ev = payment();
    ev.paymentAmount.amount = "5.00"; // canonical is "5"
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("nonPositiveAmount → fail", async () => {
    const ev = payment();
    ev.paymentAmount.amount = "0";
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("negativeFee → fail", async () => {
    const ev = payment();
    ev.paymentFee = { amount: "-1", currency: "USDC" };
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("failureNoReason → fail", async () => {
    const ev = payment();
    ev.outcome = "failure";
    delete ev.settlementFinality; // finality is success-only
    expect((await verify(ev)).decision).toBe("fail");
  });

  test("outOfSetFinalityModel → fail (PC-6 closed set; presence alone insufficient)", async () => {
    const ev = payment();
    ev.settlementFinality = { model: "trust-me", finalityObservedAt: 1 };
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("bftFinalModel (pay-dem §9.5.9) is accepted", async () => {
    const ev = payment();
    ev.settlementFinality = { model: "bft-final", finalityObservedAt: 1 };
    expect((await verify(ev)).decision).toBe("pass");
  });
  test("bftFinal carrying a stray finalityBlocks → fail (inclusion IS finality, §9.5.9)", async () => {
    const ev = payment();
    ev.settlementFinality = { model: "bft-final", finalityBlocks: 1, finalityObservedAt: 1 };
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("blockDepth with a negative finalityBlocks → fail", async () => {
    const ev = payment();
    ev.settlementFinality = { model: "block-depth", finalityBlocks: -1, finalityObservedAt: 1 };
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("commitmentLevel with an out-of-set commitment → fail", async () => {
    const ev = payment();
    ev.settlementFinality = { model: "commitment-level", finalityCommitmentLevel: "kinda", finalityObservedAt: 1 };
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("commitmentLevel with a valid commitment passes", async () => {
    const ev = payment();
    ev.settlementFinality = { model: "commitment-level", finalityCommitmentLevel: "confirmed", finalityObservedAt: 1 };
    expect((await verify(ev)).decision).toBe("pass");
  });
  test("finality without finalityObservedAt → fail (§9.7 requires it)", async () => {
    const ev = payment();
    ev.settlementFinality = { model: "block-depth", finalityBlocks: 1 };
    expect((await verify(ev)).decision).toBe("fail");
  });

  test("deliveryWithFinality → fail", async () => {
    const ev = delivery();
    ev.settlementFinality = { model: "block-depth", finalityBlocks: 1, finalityObservedAt: 1 };
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("deliveryMissingDeliverable → fail", async () => {
    const ev = delivery();
    delete ev.deliverableContentHash;
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("deliveryMalformedContentHash → fail", async () => {
    const ev = delivery();
    ev.deliverableContentHash = "not-a-hash";
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("storageAnchoredAsEntitlement → fail", async () => {
    const ev = delivery();
    ev.deliverableAnchor.kind = "entitlement"; // phase is deliver-storage-program
    expect((await verify(ev)).decision).toBe("fail");
  });

  test("currencyMismatchNotRejected → fail (rail asset mismatch)", async () => {
    const ev = payment();
    ev.paymentAmount.currency = "DAI";
    expect((await verify(ev, { rail: { asset: "USDC" } })).decision).toBe("fail");
  });
  test("underpaymentVsAgreement → fail", async () => {
    const ev = payment(); // amount "5"
    const ctx: EvidenceContext = { agreement: { amount: "10", currency: "USDC" } };
    expect((await verify(ev, ctx)).decision).toBe("fail");
  });
  test("phaseRailMismatch → fail", async () => {
    const ev = payment(); // phase pay-evm-erc20
    expect((await verify(ev, { rail: { railType: "solana-spl" } })).decision).toBe("fail");
  });
  test("txRefsMismatch → fail", async () => {
    const ev = payment();
    expect((await verify(ev, { rail: { railType: "solana-spl" } })).decision).toBe("fail");
  });
  test("railNetworkMismatch → fail", async () => {
    const ev = payment();
    expect((await verify(ev, { rail: { railType: "solana-spl" } })).decision).toBe("fail");
  });

  test("wrongAttestationKind → fail", async () => {
    const ev = payment();
    const ctx = {
      attestationRef: {
        anchor: { kind: "wrong", locator: "evidence" },
        contentHash: "0".repeat(64),
      },
    } as unknown as EvidenceContext;
    expect((await verify(ev, ctx)).decision).toBe("fail");
  });
  test("attestationRefHashMismatch → fail", async () => {
    const ev = payment();
    const ctx: EvidenceContext = {
      attestationRef: {
        anchor: { kind: "storage-program", locator: "evidence" },
        contentHash: "0".repeat(64),
      },
    };
    expect((await verify(ev, ctx)).decision).toBe("fail");
  });
  test("nonOrchestratorSigner → fail", async () => {
    const ev = payment(); // signer is did:demos:orchestrator
    expect((await verify(ev, { orchestrator: "did:demos:someone-else" })).decision).toBe("fail");
  });

  // Key-dependent verdicts (error / indeterminate / signature-fail).
  test("unresolvableKey → indeterminate", async () => {
    const ev = payment();
    const r = await verifySettlementEvidence(ev, {}, { resolvePublicKey: async () => null, verify: () => true });
    expect(r.decision).toBe("indeterminate");
  });
  test("malformedKey → error", async () => {
    const ev = payment();
    const r = await verifySettlementEvidence(
      ev,
      {},
      { resolvePublicKey: async () => new Uint8Array(10), verify: () => true },
    );
    expect(r.decision).toBe("error");
  });
  test("wrongSignerKey → fail (signature does not verify)", async () => {
    const ev = payment();
    const r = await verifySettlementEvidence(
      ev,
      {},
      { resolvePublicKey: async () => new Uint8Array(32), verify: () => false },
    );
    expect(r.decision).toBe("fail");
  });

  // HTLC route params (HTLC-7).
  const htlc = () => {
    const ev = payment();
    ev.phase = "pay-cross-chain-htlc";
    ev.paymentTxRefs = [
      {
        kind: "htlc-claim",
        chainId: 80002,
        contractAddress: "0x0000000000000000000000000000000000000001",
        claimTxHash: "0xclaim",
      },
    ];
    ev.settlementFinality = { model: "htlc-reveal", finalityObservedAt: 1 };
    return ev;
  };
  test("htlcFinalityParams → pass (both params pinned, margin ok)", async () => {
    const ctx: EvidenceContext = {
      rail: { railType: "cross-chain-htlc", sourceFinalitySec: 120, safetyWindowSec: 600 },
      htlcExpiry: { source: 10_000, dest: 5_000 },
    };
    expect((await verify(htlc(), ctx)).decision).toBe("pass");
  });
  test("htlcMissingSourceFinality → fail", async () => {
    const ctx: EvidenceContext = { rail: { railType: "cross-chain-htlc", safetyWindowSec: 600 } };
    expect((await verify(htlc(), ctx)).decision).toBe("fail");
  });
  test("htlcMissingSafetyWindow → fail", async () => {
    const ctx: EvidenceContext = { rail: { railType: "cross-chain-htlc", sourceFinalitySec: 120 } };
    expect((await verify(htlc(), ctx)).decision).toBe("fail");
  });
  test("htlcInsufficientMargin → fail", async () => {
    const ctx: EvidenceContext = {
      rail: { railType: "cross-chain-htlc", sourceFinalitySec: 120, safetyWindowSec: 600 },
      htlcExpiry: { source: 5_100, dest: 5_000 }, // margin 100 < 720
    };
    expect((await verify(htlc(), ctx)).decision).toBe("fail");
  });

  // Phase-result envelope coherence.
  test("okTrueWithErrorClass → fail", async () => {
    const ctx: EvidenceContext = { result: { ok: true, errorClass: "counterparty" } };
    expect((await verify(payment(), ctx)).decision).toBe("fail");
  });
  test("okFalseNoErrorClass → fail", async () => {
    const ev = payment();
    ev.outcome = "failure";
    ev.reason = "rail rejected";
    delete ev.settlementFinality;
    const ctx: EvidenceContext = { result: { ok: false } };
    expect((await verify(ev, ctx)).decision).toBe("fail");
  });

  // Anchor + rail-internal coherence.
  test("wrongAnchor → fail (locator != expected SR-2 address)", async () => {
    const ctx: EvidenceContext = { expectedAnchorLocator: "stor-somewhere-else" };
    expect((await verify(delivery(), ctx)).decision).toBe("fail");
  });
  test("incoherentRailTypeHandler → fail", async () => {
    const ctx: EvidenceContext = { rail: { railType: "evm-erc20", handler: "pay-solana-spl" } };
    expect((await verify(payment(), ctx)).decision).toBe("fail");
  });

  // Tolerated / valid cross-chain shapes → pass.
  test("crossChainAnchorPending → pass (success without a resolved anchor tx)", async () => {
    const ev = payment();
    ev.phase = "pay-cross-chain-liquidity-tank";
    ev.paymentTxRefs = [
      {
        kind: "liquidity-tank",
        bridgeId: "bridge-1",
        sourceChainId: 8453,
        destChainId: 80002,
        lockTxHash: "0xlock",
        releaseTxHash: "0xrelease",
      },
    ];
    ev.settlementFinality = { model: "liquidity-tank", finalityObservedAt: 1 };
    const ctx: EvidenceContext = { rail: { railType: "cross-chain-liquidity-tank" } };
    expect((await verify(ev, ctx)).decision).toBe("pass");
  });
  test("crossChainIdMatchingKindPass → pass (a valid cross-chain txRef kind)", async () => {
    const ev = htlc();
    ev.paymentTxRefs = [
      {
        kind: "htlc-claim",
        chainId: 80002,
        contractAddress: "0x0000000000000000000000000000000000000001",
        claimTxHash: "0xclaim",
      },
    ];
    const ctx: EvidenceContext = {
      rail: { railType: "cross-chain-htlc", sourceFinalitySec: 120, safetyWindowSec: 600 },
      htlcExpiry: { source: 10_000, dest: 5_000 },
    };
    expect((await verify(ev, ctx)).decision).toBe("pass");
  });
  test("deliveryExtraPaymentFieldPass → pass (uniform §9.7 optional field)", async () => {
    const ev = delivery();
    ev.paymentAmount = { amount: "5", currency: "USDC" }; // stray, but not finality
    expect((await verify(ev)).decision).toBe("pass");
  });
});

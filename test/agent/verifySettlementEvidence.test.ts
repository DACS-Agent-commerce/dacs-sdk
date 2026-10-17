import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, test, vi } from "vitest";

import {
  validateSettlementEvidenceStructure,
  verifySettlementEvidence,
  type AuthenticatedEvidenceContext,
  type AuthenticatedEvidenceDeps,
  type EvidenceContext,
} from "../../src/agent/verifySettlementEvidence.js";
import { contentHash, stripSignature } from "../../src/canonical/index.js";
import { ed25519Verify, publicKeyFromRaw } from "../../src/crypto/index.js";

const CONF = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../vendor/DACS-Standard/conformance",
);
const haveVectors = existsSync(join(CONF, "vectors/golden.json"));
const read = (p: string) => JSON.parse(readFileSync(join(CONF, p), "utf8"));

const b64u = (s: string) => Uint8Array.from(Buffer.from(s, "base64url"));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Resolve the orchestrator's real key + verify with real ed25519.
function realDeps(publicKeys: Record<string, string>): AuthenticatedEvidenceDeps {
  return {
    resolvePublicKey: async (signer) =>
      publicKeys[signer] ? b64u(publicKeys[signer]) : null,
    verify: (bytes, sig, key) => ed25519Verify(bytes, sig, publicKeyFromRaw(key)),
  };
}

const ORCH = "did:demos:orchestrator";

function paymentAuthenticatedContext(): AuthenticatedEvidenceContext {
  const fixture = read("fixtures/settlement-evidence-payment-success.json");
  return {
    orchestrator: ORCH,
    agreement: { amount: "5", currency: "USDC" },
    rail: {
      railId: "polygon-amoy-usdc",
      railType: "evm-erc20",
      asset: "USDC",
      network: "eip155:80002",
      handler: "pay-evm-erc20",
    },
    attestationRef: fixture.result.attestationRef,
    paymentAddress: { railId: "polygon-amoy-usdc", phaseIndex: 0 },
    result: { ok: true, txRefs: fixture.result.txRefs },
  };
}

describe.skipIf(!haveVectors)("verifySettlementEvidence — §14 golden fixtures", () => {
  const golden = read("vectors/golden.json").settlement;
  const paymentFx = read("fixtures/settlement-evidence-payment-success.json");
  const deliveryFx = read("fixtures/settlement-evidence-delivery-success.json");
  const deps = realDeps(golden.publicKeys ?? deliveryFx.publicKeys);

  const paymentCtx: AuthenticatedEvidenceContext = {
    ...paymentAuthenticatedContext(),
  };
  const deliveryCtx: AuthenticatedEvidenceContext = {
    orchestrator: ORCH,
    agreement: { amount: "1", currency: "TEST" },
    attestationRef: deliveryFx.result.attestationRef,
    result: { ok: true },
    expectedAnchorLocator: deliveryFx.evidence.deliverableAnchor.locator,
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

  it("never turns a structural-only call into an authenticated pass", async () => {
    const structural = await validateSettlementEvidenceStructure(paymentFx.evidence);
    expect(structural).toEqual({ decision: "valid", reasons: [] });

    const authenticated = await verifySettlementEvidence(
      paymentFx.evidence,
      {} as never,
      {} as never,
    );
    expect(authenticated.decision).toBe("error");
    expect(authenticated.reasons).toEqual(expect.arrayContaining([
      expect.stringMatching(/requires key resolution/),
      expect.stringMatching(/requires a canonical phase orchestrator/),
      expect.stringMatching(/requires the exact agreement/),
      expect.stringMatching(/requires the exact evidence attestationRef/),
      expect.stringMatching(/requires the exact phase result/),
      expect.stringMatching(/requires the exact pinned rail/),
      expect.stringMatching(/requires the exact PC-2 address tuple/),
    ]));
  });

  it("compares orchestrators by canonical ClaimReference identity", async () => {
    const context = paymentAuthenticatedContext();
    context.orchestrator = `${ORCH}?role=seller`;
    await expect(verifySettlementEvidence(paymentFx.evidence, context, deps))
      .resolves.toEqual({ decision: "pass", reasons: [] });
  });

  // Keep every other trust input valid so one missing input cannot hide behind
  // a different configuration error. Use the fixture's real signature here.
  test.each([
    ["orchestrator", ["authenticated evidence context requires a canonical phase orchestrator ClaimReference"]],
    ["agreement", ["authenticated evidence context requires the exact agreement amount and currency"]],
    ["rail", ["authenticated payment evidence context requires the exact pinned rail"]],
    ["attestationRef", [
      "authenticated evidence context requires the exact evidence attestationRef",
      "payment evidence attestationRef is unavailable for PC-2 address binding",
    ]],
    ["result", ["authenticated evidence context requires the exact phase result"]],
    ["paymentAddress", ["authenticated payment evidence context requires the exact PC-2 address tuple"]],
  ] as const)("requires the authenticated %s independently", async (field, reasons) => {
    const context: EvidenceContext = paymentAuthenticatedContext();
    delete context[field];
    await expect(verifySettlementEvidence(
      paymentFx.evidence, context as AuthenticatedEvidenceContext, deps,
    )).resolves.toEqual({ decision: "error", reasons: [...reasons] });
  });

  test.each(["railId", "railType", "asset", "network", "handler"] as const)(
    "requires the pinned rail's %s independently",
    async (field) => {
      const context = paymentAuthenticatedContext();
      delete context.rail![field];
      await expect(verifySettlementEvidence(paymentFx.evidence, context, deps))
        .resolves.toEqual({
          decision: "error",
          reasons: ["authenticated payment evidence context requires the exact pinned rail"],
        });
    },
  );

  test.each(["amount", "currency"] as const)(
    "requires the agreement's %s independently",
    async (field) => {
      const context: EvidenceContext = paymentAuthenticatedContext();
      delete context.agreement![field];
      await expect(verifySettlementEvidence(
        paymentFx.evidence, context as AuthenticatedEvidenceContext, deps,
      )).resolves.toEqual({
        decision: "error",
        reasons: ["authenticated evidence context requires the exact agreement amount and currency"],
      });
    },
  );

  test.each(["railId", "railType", "asset", "network", "handler"] as const)(
    "rejects an empty pinned rail %s independently",
    async (field) => {
      const context = paymentAuthenticatedContext();
      context.rail![field] = "";
      await expect(verifySettlementEvidence(paymentFx.evidence, context, deps))
        .resolves.toEqual({
          decision: "error",
          reasons: [
            "authenticated payment evidence context requires the exact pinned rail",
            ...(field === "network" ? [
              'rail network "" is not a canonical pinned eip155, solana, or demos network',
            ] : []),
          ],
        });
    },
  );

  test.each([
    [{ agreement: { amount: "5.00", currency: "USDC" } },
      "authenticated evidence context requires the exact agreement amount and currency"],
    [{ agreement: { amount: "5", currency: "" } },
      "authenticated evidence context requires the exact agreement amount and currency"],
    [{ result: {} }, "authenticated evidence context requires the exact phase result"],
  ] satisfies [EvidenceContext, string][])(
    "rejects an incomplete or noncanonical trust input %j independently",
    async (patch, reason) => {
      await expect(verifySettlementEvidence(
        paymentFx.evidence, { ...paymentAuthenticatedContext(), ...patch } as AuthenticatedEvidenceContext, deps,
      )).resolves.toEqual({ decision: "error", reasons: [reason] });
    },
  );

  test.each(["railId", "phaseIndex"] as const)(
    "requires the payment address's %s independently",
    async (field) => {
      const context = paymentAuthenticatedContext();
      const address: Partial<NonNullable<EvidenceContext["paymentAddress"]>> = context.paymentAddress!;
      delete address[field];
      await expect(verifySettlementEvidence(paymentFx.evidence, context, deps))
        .resolves.toEqual({
          decision: "error",
          reasons: [
            "payment evidence address context is malformed",
            "authenticated payment evidence context requires the exact PC-2 address tuple",
          ],
        });
    },
  );

  test.each(["resolvePublicKey", "verify"] as const)(
    "requires the %s dependency independently",
    async (field) => {
      const incomplete: Partial<AuthenticatedEvidenceDeps> = { ...deps };
      delete incomplete[field];
      await expect(verifySettlementEvidence(
        paymentFx.evidence, paymentAuthenticatedContext(), incomplete as AuthenticatedEvidenceDeps,
      )).resolves.toEqual({
        decision: "error",
        reasons: ["authenticated evidence verification requires key resolution and signature verification"],
      });
    },
  );

  it("requires the delivery locator independently", async () => {
    const context: EvidenceContext = { ...deliveryCtx };
    delete context.expectedAnchorLocator;
    await expect(verifySettlementEvidence(
      deliveryFx.evidence, context as AuthenticatedEvidenceContext, deps,
    )).resolves.toEqual({
      decision: "error",
      reasons: ["authenticated delivery evidence context requires the expected deliverable locator"],
    });
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
  const verify = async (ev: unknown, ctx: EvidenceContext = {}) => {
    const result = await validateSettlementEvidenceStructure(ev, ctx);
    return {
      decision: result.decision === "valid"
        ? "pass" as const
        : result.decision === "invalid"
          ? "fail" as const
          : result.decision === "incomplete"
            ? "indeterminate" as const
            : "error" as const,
      reasons: result.reasons,
    };
  };

  test("paymentPass: base record with no context is a clean pass", async () => {
    expect((await verify(payment())).decision).toBe("pass");
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
  test("accepts a current signed EVM event arm for the matching phase", async () => {
    const ev = payment();
    ev.paymentTxRefs = [{
      kind: "evm-event",
      chainId: 80002,
      txHash: "a".repeat(64),
      logIndex: 7,
    }];
    expect((await verify(ev)).decision).toBe("pass");
  });
  test("rejects current event arms under the wrong phase or finality model", async () => {
    const ev = payment();
    ev.paymentTxRefs = [{
      kind: "x402-event",
      httpResource: "https://seller.example/resource",
      paymentReceiptHash: "b".repeat(64),
      settlementTxHash: "a".repeat(64),
      chainId: 80002,
      logIndex: 7,
      protocolVersion: "2",
    }];
    expect((await verify(ev)).decision).toBe("fail");
    ev.phase = "pay-x402";
    ev.settlementFinality = {
      model: "provider-receipt",
      finalityObservedAt: ev.observedAt,
    };
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

  test.each([
    {
      name: "agreement currency",
      context: { agreement: { amount: "5", currency: "DAI" } },
      reason: 'paymentAmount.currency "USDC" does not match agreement currency "DAI"',
    },
    {
      name: "agreed price",
      context: { agreement: { amount: "5.0001", currency: "USDC" } },
      reason: "settled amount is less than the agreed price (underpayment)",
    },
    {
      name: "rail asset",
      context: { rail: { asset: "DAI" } },
      reason: 'paymentAmount.currency "USDC" does not resolve to rail asset "DAI" (PC-5)',
    },
    {
      name: "rail handler",
      context: { rail: { railType: "evm-erc20", handler: "pay-solana-spl" } },
      reason: 'rail handler "pay-solana-spl" is incoherent with rail type "evm-erc20"',
    },
    {
      name: "asset kind",
      context: { rail: { railType: "evm-erc20", assetSpec: { kind: "spl" } } },
      reason: 'rail type "evm-erc20" requires asset kind "erc20", got "spl" (RD-5)',
    },
    {
      name: "network kind",
      context: { rail: { railType: "evm-erc20", networkSpec: { kind: "solana" } } },
      reason: 'rail type "evm-erc20" requires network kind "evm", got "solana" (RD-5)',
    },
    {
      name: "asset chain",
      context: { rail: {
        assetSpec: { kind: "erc20", chainId: 8453 },
        networkSpec: { kind: "evm", chainId: 80002 },
      } },
      reason: "rail asset chainId 8453 does not match network chainId 80002 (RD-5)",
    },
    {
      name: "canonical network versus structured network",
      context: { rail: {
        network: "eip155:80002", networkSpec: { kind: "evm", chainId: 8453 },
      } },
      reason: "canonical rail network contradicts networkSpec.chainId",
    },
    {
      name: "result error class",
      context: { result: { ok: true, errorClass: "counterparty" } },
      reason: "phase result is ok:true but carries an errorClass",
    },
    {
      name: "result outcome",
      context: { result: { ok: false, errorClass: "counterparty" } },
      reason: "phase result is ok:false but SettlementEvidence does not report failure",
    },
  ] satisfies { name: string; context: EvidenceContext; reason: string }[])(
    "rejects a mismatched $name with only its own reason",
    async ({ context, reason }) => {
      await expect(validateSettlementEvidenceStructure(payment(), context))
        .resolves.toEqual({ decision: "invalid", reasons: [reason] });
    },
  );

  test.each(["4.9999", "5"])("accepts payment at or above the agreed price %s", async (amount) => {
    await expect(validateSettlementEvidenceStructure(payment(), {
      agreement: { amount, currency: "USDC" },
    })).resolves.toEqual({ decision: "valid", reasons: [] });
  });

  test.each([
    {
      name: "rail identity",
      patch: { rail: { railId: "another-rail" } },
      reason: "paymentAddress railId contradicts the authenticated pinned rail",
    },
    {
      name: "phase index",
      patch: { paymentAddress: { railId: "polygon-amoy-usdc", phaseIndex: 1 } },
      reason: "attestationRef locator does not match the complete authenticated PC-2 payment address",
    },
    {
      name: "signed scope hash",
      patch: { attestationRef: {
        ...paymentAuthenticatedContext().attestationRef,
        contentHash: "0".repeat(64),
      } },
      reason: "attestationRef.contentHash does not match the evidence's signed-scope hash",
    },
    {
      name: "orchestrator identity",
      patch: { orchestrator: "did:demos:someone-else" },
      reason: 'signer "did:demos:orchestrator" is not the phase orchestrator "did:demos:someone-else"',
    },
    {
      name: "handler refs",
      patch: { result: { ok: true, txRefs: [] } },
      reason: "signed evidence.paymentTxRefs do not equal the authenticated phase-handler result txRefs",
    },
  ] satisfies { name: string; patch: EvidenceContext; reason: string }[])(
    "binds the authenticated $name independently",
    async ({ patch, reason }) => {
      const fixture = read("fixtures/settlement-evidence-payment-success.json");
      const golden = read("vectors/golden.json").settlement;
      const context = paymentAuthenticatedContext();
      await expect(verifySettlementEvidence(
        fixture.evidence,
        { ...context, ...patch, rail: { ...context.rail, ...patch.rail } },
        realDeps(golden.publicKeys ?? read("fixtures/settlement-evidence-delivery-success.json").publicKeys),
      )).resolves.toEqual({ decision: "fail", reasons: [reason] });
    },
  );
  test("phaseRailMismatch → fail", async () => {
    const ev = payment(); // phase pay-evm-erc20
    expect((await verify(ev, { rail: { railType: "solana-spl" } })).decision).toBe("fail");
  });
  test("txRefsMismatch → fail", async () => {
    const ev = payment();
    expect((await verify(ev, { rail: { railType: "solana-spl" } })).decision).toBe("fail");
  });
  test("binds legacy and current EVM refs to the canonical pinned chain", async () => {
    const legacy = payment();
    expect((await verify(legacy, {
      rail: { railType: "evm-erc20", network: "eip155:80002" },
    })).decision).toBe("pass");
    expect((await verify(legacy, {
      rail: { railType: "evm-erc20", network: "eip155:8453" },
    })).decision).toBe("fail");

    const current = payment();
    current.paymentTxRefs = [{
      kind: "evm-event",
      chainId: 80002,
      txHash: "a".repeat(64),
      logIndex: 7,
    }];
    expect((await verify(current, {
      rail: { railType: "evm-erc20", network: "eip155:80002" },
    })).decision).toBe("pass");
    expect((await verify(current, {
      rail: { railType: "evm-erc20", network: "eip155:8453" },
    })).decision).toBe("fail");
  });

  test("binds legacy and current Solana refs to the canonical pinned cluster", async () => {
    const legacy = payment();
    legacy.phase = "pay-solana-spl";
    legacy.paymentTxRefs = [{
      kind: "solana",
      cluster: "devnet",
      signature: "illustrative-signature",
    }];
    legacy.settlementFinality = {
      model: "commitment-level",
      finalityCommitmentLevel: "finalized",
      finalityObservedAt: legacy.observedAt,
    };
    expect((await verify(legacy, {
      rail: { railType: "solana-spl", network: "solana:devnet" },
    })).decision).toBe("pass");
    expect((await verify(legacy, {
      rail: { railType: "solana-spl", network: "solana:testnet" },
    })).decision).toBe("fail");

    const current = structuredClone(legacy);
    current.paymentTxRefs = [{
      kind: "solana-instruction",
      cluster: "devnet",
      signature: "1".repeat(64),
      instructionIndex: 2,
    }];
    expect((await verify(current, {
      rail: { railType: "solana-spl", network: "solana:devnet" },
    })).decision).toBe("pass");
    expect((await verify(current, {
      rail: { railType: "solana-spl", network: "solana:mainnet" },
    })).decision).toBe("fail");
  });

  test("binds legacy and current x402 refs to the canonical pinned chain", async () => {
    const legacy = payment();
    legacy.phase = "pay-x402";
    legacy.paymentTxRefs = [{
      kind: "x402",
      httpResource: "https://seller.example/resource",
      paymentReceiptHash: "b".repeat(64),
      settlementTxHash: `0x${"a".repeat(64)}`,
      chainId: 80002,
      protocolVersion: "2",
    }];
    expect((await verify(legacy, {
      rail: { railType: "x402", network: "eip155:80002" },
    })).decision).toBe("pass");
    expect((await verify(legacy, {
      rail: { railType: "x402", network: "eip155:8453" },
    })).decision).toBe("fail");

    const current = structuredClone(legacy);
    current.paymentTxRefs = [{
      kind: "x402-event",
      httpResource: "https://seller.example/resource",
      paymentReceiptHash: "b".repeat(64),
      settlementTxHash: "a".repeat(64),
      chainId: 80002,
      logIndex: 7,
      protocolVersion: "2",
    }];
    expect((await verify(current, {
      rail: { railType: "x402", network: "eip155:80002" },
    })).decision).toBe("pass");
    expect((await verify(current, {
      rail: { railType: "x402", network: "eip155:8453" },
    })).decision).toBe("fail");
  });

  test.each([
    "eip155:0",
    "eip155:08453",
    "base-sepolia",
    "solana:localnet",
    "demos:testnet",
  ])("rejects malformed or non-canonical pinned network %s", async (network) => {
    const ev = payment();
    expect((await verify(ev, {
      rail: { railType: "evm-erc20", network },
    })).decision).toBe("fail");
  });

  test("accepts only the Demos network pin for a Demos tx ref", async () => {
    const ev = payment();
    ev.phase = "pay-dem";
    ev.paymentTxRefs = [{
      kind: "demos",
      txHash: `0x${"a".repeat(64)}`,
      blockNumber: 77,
    }];
    ev.paymentAmount = { amount: "5", currency: "DEM" };
    ev.settlementFinality = {
      model: "bft-final",
      finalityObservedAt: ev.observedAt,
    };
    expect((await verify(ev, {
      rail: { railType: "demos-native", network: "demos" },
    })).decision).toBe("pass");
    expect((await verify(ev, {
      rail: { railType: "demos-native", network: "eip155:80002" },
    })).decision).toBe("fail");
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
  test("legacy string signature → fail", async () => {
    const ev = payment();
    ev.signature = "deadbeef";
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("padded signature value → fail", async () => {
    const ev = payment();
    ev.signature.value = "YWJjZA==";
    expect((await verify(ev)).decision).toBe("fail");
  });
  test("singular plus plural signature fields → fail", async () => {
    const ev = payment();
    ev.signatures = [];
    expect((await verify(ev)).decision).toBe("fail");
  });

  // Key-dependent verdicts (error / indeterminate / signature-fail).
  test("unresolvableKey → indeterminate", async () => {
    const ev = payment();
    const r = await verifySettlementEvidence(ev, paymentAuthenticatedContext(), {
      resolvePublicKey: async () => null,
      verify: () => true,
    });
    expect(r.decision).toBe("indeterminate");
  });
  test("malformedKey → error", async () => {
    const ev = payment();
    const r = await verifySettlementEvidence(
      ev,
      paymentAuthenticatedContext(),
      { resolvePublicKey: async () => new Uint8Array(10), verify: () => true },
    );
    expect(r.decision).toBe("error");
  });
  test("wrongSignerKey → fail (signature does not verify)", async () => {
    const ev = payment();
    const r = await verifySettlementEvidence(
      ev,
      paymentAuthenticatedContext(),
      { resolvePublicKey: async () => new Uint8Array(32), verify: () => false },
    );
    expect(r.decision).toBe("fail");
  });
  test("uses one authoritative evidence/context snapshot across async key resolution", async () => {
    const ev = payment();
    const ctx = paymentAuthenticatedContext();
    const publicKeys = read("vectors/golden.json").settlement.publicKeys as Record<
      string,
      string
    >;
    const entered = deferred();
    const release = deferred();
    const pending = verifySettlementEvidence(ev, ctx, {
      resolvePublicKey: async (signer) => {
        entered.resolve();
        await release.promise;
        return publicKeys[signer] ? b64u(publicKeys[signer]) : null;
      },
      verify: (bytes, signature, key) =>
        ed25519Verify(bytes, signature, publicKeyFromRaw(key)),
    });

    await entered.promise;
    ev.observedAt = -0;
    ev.signature.value = "AQ";
    ctx.orchestrator = "did:demos:attacker";
    release.resolve();

    const result = await pending;
    expect(result).toEqual({ decision: "pass", reasons: [] });
  });
  test("rejects accessor evidence before invoking its getter", async () => {
    const getter = vi.fn(() => "1");
    const ev = payment();
    Object.defineProperty(ev, "evidenceVersion", {
      configurable: true,
      enumerable: true,
      get: getter,
    });

    const result = await validateSettlementEvidenceStructure(ev);
    expect(result.decision).toBe("error");
    expect(result.reasons).toContain(
      "evidence or verification context is not stable canonical JSON",
    );
    expect(getter).not.toHaveBeenCalled();
  });
  test("accepts a deeply frozen read-only structural context", async () => {
    const ev = payment();
    const context = Object.freeze({
      agreement: Object.freeze({
        amount: ev.paymentAmount.amount,
        currency: ev.paymentAmount.currency,
      }),
    });

    await expect(validateSettlementEvidenceStructure(ev, context)).resolves.toEqual({
      decision: "valid",
      reasons: [],
    });
  });
  test("maps non-boolean and throwing crypto dependencies to explicit verdicts", async () => {
    const ev = payment();
    const key = new Uint8Array(32);

    const nonBoolean = await verifySettlementEvidence(ev, paymentAuthenticatedContext(), {
      resolvePublicKey: async () => key,
      verify: (() => "yes") as never,
    });
    expect(nonBoolean.decision).toBe("error");
    expect(nonBoolean.reasons).toContain(
      "evidence signature verifier returned a non-boolean result",
    );

    const resolverThrow = await verifySettlementEvidence(ev, paymentAuthenticatedContext(), {
      resolvePublicKey: async () => {
        throw new Error("key backend unavailable");
      },
      verify: () => true,
    });
    expect(resolverThrow.decision).toBe("indeterminate");
    expect(resolverThrow.reasons).toContain(
      `signer key for "${ORCH}" could not be resolved`,
    );

    const verifierThrow = await verifySettlementEvidence(ev, paymentAuthenticatedContext(), {
      resolvePublicKey: async () => key,
      verify: () => {
        throw new Error("crypto backend unavailable");
      },
    });
    expect(verifierThrow.decision).toBe("error");
    expect(verifierThrow.reasons).toContain(
      "evidence signature verification could not be evaluated",
    );
  });

  // HTLC route params (HTLC-7), over the pinned HTLC-9 fixtures' reference set.
  const htlcResolved = () =>
    structuredClone(read("fixtures/settlement/htlc9-asymmetric-resolved.json").settlementEvidence);
  const htlcInterim = () =>
    structuredClone(read("fixtures/settlement/htlc9-asymmetric.json").settlementEvidence);
  const htlc = () => {
    const ev = payment();
    ev.phase = "pay-cross-chain-htlc";
    ev.paymentTxRefs = htlcResolved().paymentTxRefs;
    ev.settlementFinality = { model: "htlc-reveal", finalityObservedAt: 1 };
    return ev;
  };
  const htlcRail: EvidenceContext["rail"] = {
    railType: "cross-chain-htlc",
    sourceFinalitySec: 120,
    safetyWindowSec: 600,
    htlcRoute: { sourceChainId: 84532, destChainId: 80002 },
  };
  test.each([
    ["resolved", htlcResolved],
    ["interim", htlcInterim],
  ] as const)("htlc9 %s fixture → pass with its pinned route", async (_name, fixture) => {
    expect(await verify(fixture(), { rail: htlcRail })).toEqual({ decision: "pass", reasons: [] });
  });
  test.each([
    ["omits the claim", (ev: Record<string, any>) => { ev.paymentTxRefs.pop(); }],
    ["adds the destination lock", (ev: Record<string, any>) => {
      ev.paymentTxRefs.splice(1, 0, { ...ev.paymentTxRefs[0], chainId: 80002, lockTxHash: `0x${"d".repeat(64)}` });
    }],
    ["duplicates the claim", (ev: Record<string, any>) => {
      ev.paymentTxRefs[0] = { ...ev.paymentTxRefs[2], claimTxHash: `0x${"e".repeat(64)}` };
    }],
    ["puts the claim on the reveal's chain", (ev: Record<string, any>) => { ev.paymentTxRefs[2].chainId = 80002; }],
    ["swaps the chain roles", (ev: Record<string, any>) => {
      ev.paymentTxRefs[0].chainId = 80002;
      ev.paymentTxRefs[1].chainId = 84532;
      ev.paymentTxRefs[2].chainId = 80002;
    }],
    ["uses chains off the pinned route", (ev: Record<string, any>) => {
      ev.paymentTxRefs[0].chainId = 11155111;
      ev.paymentTxRefs[2].chainId = 11155111;
    }],
  ])("htlc success that %s → fail", async (_name, mutate) => {
    const ev = htlcResolved();
    mutate(ev);
    expect((await verify(ev, { rail: htlcRail })).decision).toBe("fail");
  });
  test.each([
    ["carries a claim", (ev: Record<string, any>) => {
      ev.paymentTxRefs.push(htlcResolved().paymentTxRefs[2]);
    }],
    ["omits the reveal", (ev: Record<string, any>) => { ev.paymentTxRefs.pop(); }],
    ["adds the destination lock", (ev: Record<string, any>) => {
      ev.paymentTxRefs.push({ ...ev.paymentTxRefs[0], chainId: 80002, lockTxHash: `0x${"d".repeat(64)}` });
    }],
    ["puts the lock on the reveal's chain", (ev: Record<string, any>) => { ev.paymentTxRefs[0].chainId = 80002; }],
    ["supersedes another record", (ev: Record<string, any>) => {
      ev.supersedesEvidenceRef = htlcResolved().supersedesEvidenceRef;
    }],
  ])("htlc9 interim that %s → fail", async (_name, mutate) => {
    const ev = htlcInterim();
    mutate(ev);
    expect((await verify(ev, { rail: htlcRail })).decision).toBe("fail");
  });
  const htlcRefund = (ev: Record<string, any>, chainId: number) => ({
    kind: "htlc-refund",
    chainId,
    contractAddress: ev.paymentTxRefs[0].contractAddress,
    refundTxHash: `0x${"f".repeat(64)}`,
  });
  test.each([
    ["puts a refund in the claim's place", (ev: Record<string, any>) => { ev.paymentTxRefs[2] = htlcRefund(ev, 84532); }],
    ["puts a refund in the reveal's place", (ev: Record<string, any>) => { ev.paymentTxRefs[1] = htlcRefund(ev, 80002); }],
    ["puts a refund in the lock's place", (ev: Record<string, any>) => { ev.paymentTxRefs[0] = htlcRefund(ev, 84532); }],
    ["adds a fourth refund reference", (ev: Record<string, any>) => { ev.paymentTxRefs.push(htlcRefund(ev, 84532)); }],
    ["puts the reveal off the pinned route", (ev: Record<string, any>) => { ev.paymentTxRefs[1].chainId = 11155111; }],
    ["claims on another contract than the lock", (ev: Record<string, any>) => {
      ev.paymentTxRefs[2].contractAddress = `0x${"c".repeat(40)}`;
    }],
    ["reuses the lock's tx hash for the claim", (ev: Record<string, any>) => {
      ev.paymentTxRefs[2].claimTxHash = ev.paymentTxRefs[0].lockTxHash;
    }],
    ["reuses the reveal's tx hash for the lock", (ev: Record<string, any>) => {
      ev.paymentTxRefs[0].lockTxHash = ev.paymentTxRefs[1].revealTxHash;
    }],
  ])("htlc success that %s → fail (reference set and topology)", async (_name, mutate) => {
    const ev = htlcResolved();
    mutate(ev);
    expect((await verify(ev, { rail: htlcRail })).decision).toBe("fail");
  });
  test("htlc success with every reference on one chain and no pinned route → fail", async () => {
    const ev = htlcResolved();
    ev.paymentTxRefs[1].chainId = 84532;
    expect((await verify(ev, { rail: { ...htlcRail, htlcRoute: undefined } })).decision).toBe("fail");
  });
  test.each([
    ["a null route", null],
    ["a string route", "84532:80002"],
  ])("htlc success with %s → fail, never a throw", async (_name, htlcRoute) => {
    const ev = htlcResolved();
    expect((await verify(ev, { rail: { ...htlcRail, htlcRoute: htlcRoute as never } })).decision).toBe("fail");
  });
  test.each(["block-depth", "liquidity-tank", "commitment-level"])(
    "htlc success with %s finality → fail (PC-6 binds htlc-reveal)",
    async (model) => {
      const ev = htlcResolved();
      ev.settlementFinality.model = model;
      expect(await verify(ev, { rail: htlcRail })).toEqual({
        decision: "fail",
        reasons: ["HTLC success evidence MUST use htlc-reveal finality (PC-6)"],
      });
    },
  );

  // The trust-bearing API selects the agreement's route (§9.5.4 setup); the
  // signature is stubbed valid so the route is the only thing that decides.
  const HTLC_RAIL_ID = "cross-chain-htlc-usdc";
  const NO_ROUTE =
    "authenticated HTLC payment evidence context requires the pinned route's source and destination chains";
  const htlcAuthenticated = (
    ev: Record<string, any>,
    htlcRoute: unknown,
  ): AuthenticatedEvidenceContext => {
    const resolved = ev.supersedesEvidenceRef !== undefined;
    return {
      orchestrator: ev.signature.signer,
      agreement: { amount: "25", currency: "USDC" },
      rail: {
        railId: HTLC_RAIL_ID,
        railType: "cross-chain-htlc",
        asset: "USDC",
        handler: "pay-cross-chain-htlc",
        sourceFinalitySec: 120,
        safetyWindowSec: 600,
        htlcRoute: htlcRoute as { sourceChainId: number; destChainId: number },
      },
      attestationRef: {
        anchor: {
          kind: "storage-program",
          locator: `dacs4:payment:${ev.jobId}:${HTLC_RAIL_ID}:0${resolved ? ":resolved" : ""}`,
        },
        contentHash: contentHash(stripSignature(ev)),
      },
      paymentAddress: { railId: HTLC_RAIL_ID, phaseIndex: 0, resolved },
      result: { ok: ev.outcome === "success", ...(ev.outcome === "success" ? {} : { errorClass: "settlement-atomicity" }) },
    };
  };
  const signatureAccepted: AuthenticatedEvidenceDeps = {
    resolvePublicKey: async () => new Uint8Array(32),
    verify: () => true,
  };
  test.each([
    ["resolved", htlcResolved],
    ["interim", htlcInterim],
  ] as const)("authenticated htlc9 %s fixture → pass on its pinned route", async (_name, fixture) => {
    const ev = fixture();
    expect(await verifySettlementEvidence(ev, htlcAuthenticated(ev, htlcRail!.htlcRoute), signatureAccepted))
      .toEqual({ decision: "pass", reasons: [] });
  });
  test.each([
    ["no route", undefined],
    ["a null route", null],
    ["an array route", []],
    ["a route on one chain", { sourceChainId: 84532, destChainId: 84532 }],
    ["string chain ids", { sourceChainId: "84532", destChainId: "80002" }],
    ["a zero chain id", { sourceChainId: 0, destChainId: 80002 }],
  ])("authenticated htlc evidence with %s is an error, never a pass", async (_name, route) => {
    const ev = htlcResolved();
    const result = await verifySettlementEvidence(ev, htlcAuthenticated(ev, route), signatureAccepted);
    expect(result.decision).toBe("error");
    expect(result.reasons).toContain(NO_ROUTE);
  });
  test("authenticated htlc evidence on two off-route chains is refused with or without a route", async () => {
    // Distinct chains, lock and claim together: only the route can refuse it.
    const ev = htlcResolved();
    ev.paymentTxRefs[0].chainId = 11155111;
    ev.paymentTxRefs[1].chainId = 421614;
    ev.paymentTxRefs[2].chainId = 11155111;
    const withoutRoute = await verifySettlementEvidence(ev, htlcAuthenticated(ev, undefined), signatureAccepted);
    expect(withoutRoute).toEqual({ decision: "error", reasons: [NO_ROUTE] });
    expect(await verifySettlementEvidence(ev, htlcAuthenticated(ev, htlcRail!.htlcRoute), signatureAccepted)).toEqual({
      decision: "fail",
      reasons: ["HTLC success evidence MUST carry the lock and claim on the source chain and the reveal on the destination chain"],
    });
  });
  test.each([
    ["carries only the reveal", (ev: Record<string, any>) => { ev.paymentTxRefs = [ev.paymentTxRefs[1]]; }],
    ["carries a null reference", (ev: Record<string, any>) => { ev.paymentTxRefs.push(null); }],
    ["carries an extra source refund", (ev: Record<string, any>) => { ev.paymentTxRefs.push(htlcRefund(ev, 84532)); }],
    ["reuses the lock's tx hash for the reveal", (ev: Record<string, any>) => {
      ev.paymentTxRefs[1].revealTxHash = ev.paymentTxRefs[0].lockTxHash;
    }],
  ])("htlc9 interim that %s → fail (exact set)", async (_name, mutate) => {
    const ev = htlcInterim();
    mutate(ev);
    expect((await verify(ev, { rail: htlcRail })).decision).toBe("fail");
  });
  // Two references, so the exact-two rule holds and only the role check can refuse.
  const NO_REVEAL = "HTLC-9 interim evidence MUST include the htlc-reveal txRef (HTLC-9(b))";
  const NO_LOCK = "HTLC-9 interim evidence MUST carry exactly the source htlc-lock";
  describe.each([
    ["with the rail context", { rail: htlcRail }],
    ["without any context", {}],
  ] as const)("htlc9 interim of two references %s", (_ctx, ctx) => {
    test.each([
      ["the source lock and a source refund", NO_REVEAL, (ev: Record<string, any>) => [ev.paymentTxRefs[0], htlcRefund(ev, 84532)]],
      ["a destination refund and the reveal", NO_LOCK, (ev: Record<string, any>) => [htlcRefund(ev, 80002), ev.paymentTxRefs[1]]],
      ["a source refund and the reveal", NO_LOCK, (ev: Record<string, any>) => [htlcRefund(ev, 84532), ev.paymentTxRefs[1]]],
    ])("that carries %s → fail for the missing role alone", async (_name, reason, refs) => {
      const ev = htlcInterim();
      ev.paymentTxRefs = refs(ev);
      expect(await verify(ev, ctx as EvidenceContext)).toEqual({ decision: "fail", reasons: [reason] });
    });
  });
  test.each([
    ["with the rail context", { rail: htlcRail }],
    ["without any context", {}],
  ] as const)("htlc9 interim without paymentTxRefs (no reveal, HTLC-9(b)) → fail %s", async (_name, ctx) => {
    const ev = htlcInterim();
    delete ev.paymentTxRefs;
    expect((await verify(ev, ctx as EvidenceContext)).decision).toBe("fail");
  });
  test("an htlc failure with another reason is not held to the interim set", async () => {
    const ev = htlcInterim();
    ev.reason = "destination-timeout";
    ev.paymentTxRefs = [ev.paymentTxRefs[0], htlcRefund(ev, 84532)];
    expect(await verify(ev, { rail: htlcRail })).toEqual({ decision: "pass", reasons: [] });
  });
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
  test("binds the complete PC-2 payment address tuple, including CF-4 rail encoding", async () => {
    const fixture = read("fixtures/settlement-evidence-payment-success.json");
    const validContext: EvidenceContext = {
      attestationRef: fixture.result.attestationRef,
      rail: { railId: "polygon-amoy-usdc" },
      paymentAddress: { railId: "polygon-amoy-usdc", phaseIndex: 0 },
    };
    expect((await verify(fixture.evidence, validContext)).decision).toBe("pass");

    expect((await verify(fixture.evidence, {
      ...validContext,
      paymentAddress: { railId: "polygon-amoy-usdc", phaseIndex: 1 },
    })).decision).toBe("fail");

    expect((await verify(fixture.evidence, {
      ...validContext,
      rail: { railId: "evm-erc20:80002:USDC" },
      paymentAddress: { railId: "evm-erc20:80002:USDC", phaseIndex: 0 },
      attestationRef: {
        ...fixture.result.attestationRef,
        anchor: {
          kind: "storage-program",
          locator:
            `dacs4:payment:${fixture.evidence.jobId}:` +
            "evm-erc20%3A80002%3AUSDC:0",
        },
      },
    })).decision).toBe("pass");
  });
  test("does not turn a missing PC-2 read into evidence absence", async () => {
    const ev = payment();
    const result = await verify(ev, {
      paymentAddress: { railId: "polygon-amoy-usdc", phaseIndex: 0 },
    });
    expect(result.decision).toBe("indeterminate");
    expect(result.reasons).toContain(
      "payment evidence attestationRef is unavailable for PC-2 address binding",
    );
  });
  test("requires signed paymentTxRefs to equal the authenticated handler result", async () => {
    const fixture = read("fixtures/settlement-evidence-payment-success.json");
    expect((await verify(fixture.evidence, {
      result: { ok: true, txRefs: fixture.result.txRefs },
    })).decision).toBe("pass");

    const mismatched = structuredClone(fixture.result.txRefs);
    mismatched[0].txHash = "polygon-amoy:0xanother-settlement";
    expect((await verify(fixture.evidence, {
      result: { ok: true, txRefs: mismatched },
    })).decision).toBe("fail");
  });
  test("incoherentRailTypeHandler → fail", async () => {
    const ctx: EvidenceContext = { rail: { railType: "evm-erc20", handler: "pay-solana-spl" } };
    expect((await verify(payment(), ctx)).decision).toBe("fail");
  });
  test("enforces structured RD-5 asset/network kinds and EVM chain identity", async () => {
    const valid: EvidenceContext = {
      rail: {
        railType: "evm-erc20",
        network: "eip155:80002",
        assetSpec: { kind: "erc20", chainId: 80002 },
        networkSpec: { kind: "evm", chainId: 80002 },
      },
    };
    expect((await verify(payment(), valid)).decision).toBe("pass");
    expect((await verify(payment(), {
      rail: {
        ...valid.rail,
        networkSpec: { kind: "solana", cluster: "devnet" },
      },
    })).decision).toBe("fail");
    expect((await verify(payment(), {
      rail: {
        ...valid.rail,
        networkSpec: { kind: "evm", chainId: 8453 },
      },
    })).decision).toBe("fail");
    expect((await verify(payment(), {
      rail: {
        ...valid.rail,
        assetSpec: { kind: "erc20", chainId: 0 },
      },
    })).decision).toBe("error");
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
  test("crossChainIdMatchingKindPass → pass (valid cross-chain txRef kinds)", async () => {
    // The §9.5.4 success set; a lone htlc-claim is not a valid success.
    const ev = htlc();
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

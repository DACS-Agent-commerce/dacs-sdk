import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, test, vi } from "vitest";

import {
  inspectHistoricalSettlementEvidence,
  validateSettlementEvidenceStructure,
  verifySettlementEvidence,
  type AuthenticatedEvidenceContext,
  type AuthenticatedEvidenceDeps,
  type EvidenceContext,
} from "../../src/agent/verifySettlementEvidence.js";
import { contentHash, stripSignature } from "../../src/canonical/index.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey, signedBytes, ed25519Verify, publicKeyFromRaw } from "../../src/crypto/index.js";

const CONF = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../vendor/DACS-Standard/conformance",
);
const haveVectors = existsSync(join(CONF, "vectors/golden.json"));
const readHistorical = (p: string) => JSON.parse(readFileSync(join(CONF, p), "utf8"));
const JOB = "01JZ0000000000000000000360";
const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const testPrivateKey = privateKeyFromSeed(seed);
const testPublicKey = Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("base64url");
function signEvidence(evidence: any): void {
  evidence.signature.value = Buffer.from(ed25519Sign(
    signedBytes(ARTIFACT_SEPARATORS.SettlementEvidence, contentHash(stripSignature(evidence))),
    testPrivateKey,
  )).toString("base64url");
}
// Current-profile cases use a canonical job ID and a fresh fixture signature.
// The untouched upstream signature oracles are exercised separately below.
function read(p: string): any {
  const fixture = readHistorical(p);
  if (p === "vectors/golden.json") {
    fixture.settlement.publicKeys["did:demos:orchestrator"] = testPublicKey;
  } else if (fixture.evidence) {
    const oldJob = fixture.evidence.jobId;
    fixture.evidence.jobId = JOB;
    if (fixture.evidence.deliverableAnchor) {
      fixture.evidence.deliverableAnchor.locator = fixture.evidence.deliverableAnchor.locator.replace(oldJob, JOB);
    }
    signEvidence(fixture.evidence);
    fixture.result.attestationRef.contentHash = contentHash(fixture.evidence);
    fixture.result.attestationRef.anchor.locator = fixture.result.attestationRef.anchor.locator.replace(oldJob, JOB);
  }
  return fixture;
}

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

describe.skipIf(!haveVectors)("verifySettlementEvidence — current-profile fixtures", () => {
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

  it("paymentPass — a current payment record verifies", async () => {
    const r = await verifySettlementEvidence(paymentFx.evidence, paymentCtx, deps);
    expect(r.decision).toBe("pass");
    expect(r.reasons).toEqual([]);
  });

  it("deliveryPass — a current delivery record verifies", async () => {
    const r = await verifySettlementEvidence(deliveryFx.evidence, deliveryCtx, deps);
    expect(r.decision).toBe("pass");
    expect(r.reasons).toEqual([]);
  });

  it("tampering with current evidence fails under the real orchestrator key", async () => {
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

  it("binds an optional reference signer to the evidence signer's CF-3 identity", async () => {
    const context = paymentAuthenticatedContext();
    // DACS-2 §7.5.2(3): a signer that did not sign the attestation is a mismatch.
    for (const signer of ["did:demos:other", "did:demos:validator-set"]) {
      context.attestationRef = { ...context.attestationRef, signer };
      await expect(verifySettlementEvidence(paymentFx.evidence, context, deps))
        .resolves.toEqual({
          decision: "fail",
          reasons: ["attestationRef.signer does not match the evidence signer"],
        });
    }
    context.attestationRef = { ...context.attestationRef, signer: `${ORCH}?role=seller` };
    await expect(verifySettlementEvidence(paymentFx.evidence, context, deps))
      .resolves.toEqual({ decision: "pass", reasons: [] });
    const { signer: _signer, ...withoutSigner } = context.attestationRef;
    context.attestationRef = withoutSigner;
    await expect(verifySettlementEvidence(paymentFx.evidence, context, deps))
      .resolves.toEqual({ decision: "pass", reasons: [] });
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
    ev.phase = "pay-dem";
    ev.paymentTxRefs = [{ kind: "demos", txHash: "a".repeat(64) }];
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
    ev.phase = "pay-solana-spl";
    ev.paymentTxRefs = [{ kind: "solana", cluster: "devnet", signature: "1".repeat(64) }];
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

describe.skipIf(!haveVectors)("current evidence admission and historical replay", () => {
  const deps = realDeps({ [ORCH]: testPublicKey });
  function authenticate(evidence: any, context = paymentAuthenticatedContext()) {
    signEvidence(evidence);
    context.attestationRef = {
      ...context.attestationRef, contentHash: contentHash(evidence),
      anchor: { kind: "storage-program", locator: `dacs4:payment:${evidence.jobId}:polygon-amoy-usdc:0` },
    };
    return verifySettlementEvidence(evidence, context, deps);
  }

  test.each(["DACS-VERIFY-SETTLE-0001", "", JOB.toLowerCase(), "8" + JOB.slice(1),
    JOB.slice(1), JOB + "0", JOB.slice(0, -1) + "I", JOB + "\n", 42, null])(
    "rejects malformed current jobId %j before key resolution", async (jobId) => {
      const ev = read("fixtures/settlement-evidence-payment-success.json").evidence;
      ev.jobId = jobId;
      signEvidence(ev);
      const resolvePublicKey = vi.fn(async () => b64u(testPublicKey));
      const context = paymentAuthenticatedContext();
      context.attestationRef = { ...context.attestationRef, contentHash: contentHash(ev) };
      const result = await verifySettlementEvidence(ev, context, { ...deps, resolvePublicKey });
      expect(result.decision).toBe("error");
      expect(result.reasons.join(" ")).toMatch(/canonical uppercase ULID/);
      expect(resolvePublicKey).not.toHaveBeenCalled();
      expect((await validateSettlementEvidenceStructure(ev)).decision).toBe("error");
    },
  );

  test.each(["constructor", "__proto__", "toString", "unknown"])("rejects unknown phase %s without throwing", async (phase) => {
    const ev = read("fixtures/settlement-evidence-payment-success.json").evidence;
    ev.phase = phase;
    expect((await authenticate(ev)).decision).toBe("fail");
    expect((await validateSettlementEvidenceStructure(ev)).decision).toBe("invalid");
  });

  test.each(["payment", "delivery"])("inspects the untouched historical %s signature without current authority", async (kind) => {
    const fx = readHistorical(`fixtures/settlement-evidence-${kind}-success.json`);
    const keys = readHistorical("vectors/golden.json").settlement.publicKeys;
    const result = await inspectHistoricalSettlementEvidence(fx.evidence, {
      orchestrator: ORCH, attestationRef: fx.result.attestationRef,
    }, realDeps(keys));
    expect(result).toEqual({ decision: "valid", reasons: [expect.stringContaining("no current DACS semantic conformance")] });
    const tampered = { ...fx.evidence, observedAt: 1 };
    expect((await inspectHistoricalSettlementEvidence(tampered, {}, realDeps(keys))).decision).toBe("invalid");
    expect((await verifySettlementEvidence(fx.evidence, paymentAuthenticatedContext(), realDeps(keys))).decision).toBe("error");
  });

  test.each(["block-depth", "commitment-level", "provider-receipt", "htlc-reveal", "liquidity-tank", "bft-final"])(
    "binds native DEM finality to its phase: %s", async (model) => {
      const ev = read("fixtures/settlement-evidence-payment-success.json").evidence;
      ev.phase = "pay-dem";
      ev.paymentAmount.currency = "DEM";
      delete ev.paymentFee;
      ev.paymentTxRefs = [{ kind: "demos", txHash: "a".repeat(64) }];
      ev.settlementFinality = { model, finalityObservedAt: ev.observedAt };
      const context = paymentAuthenticatedContext();
      context.agreement.currency = "DEM";
      context.rail = { railId: "polygon-amoy-usdc", railType: "demos-native", asset: "DEM", network: "demos", handler: "pay-dem" };
      context.result.txRefs = ev.paymentTxRefs;
      expect((await authenticate(ev, context)).decision).toBe(model === "bft-final" ? "pass" : "fail");
      expect((await validateSettlementEvidenceStructure(ev)).decision).toBe(model === "bft-final" ? "valid" : "invalid");
    },
  );

  test.each([
    ["pay-evm-erc20", "block-depth", { kind: "evm", chainId: 80002, txHash: "0xsettled" }],
    ["pay-solana-spl", "commitment-level", { kind: "solana", cluster: "devnet", signature: "settled" }],
    ["pay-cross-chain-htlc", "htlc-reveal", { kind: "htlc-claim", chainId: 80002, contractAddress: "0xcontract", claimTxHash: "0xclaim" }],
    ["pay-cross-chain-liquidity-tank", "liquidity-tank", { kind: "liquidity-tank", bridgeId: "bridge", sourceChainId: 1, destChainId: 80002, lockTxHash: "0xlock", releaseTxHash: "0xrelease" }],
    ["pay-ap2", "provider-receipt", { kind: "ap2", mandateId: "mandate", providerRef: "provider", protocolVersion: "1", receiptAttestation: { anchor: { kind: "storage-program", locator: "ap2:receipt" }, contentHash: "a".repeat(64) } }],
    ["pay-x402", "block-depth", { kind: "x402", httpResource: "https://seller.example/resource", paymentReceiptHash: "b".repeat(64), protocolVersion: "2" }],
  ])("checks every finality model for %s independently of reference version", async (phase, expected, ref) => {
    for (const model of ["block-depth", "commitment-level", "provider-receipt", "htlc-reveal", "liquidity-tank", "bft-final"]) {
      const ev = read("fixtures/settlement-evidence-payment-success.json").evidence;
      ev.phase = phase;
      ev.paymentTxRefs = [ref];
      ev.settlementFinality = { model, finalityObservedAt: ev.observedAt };
      const result = await validateSettlementEvidenceStructure(ev);
      expect(result.decision, JSON.stringify({ phase, model, reasons: result.reasons }))
        .toBe(model === expected ? "valid" : "invalid");
    }
  });

  test("allows provider-receipt x402 only in explicit historical replay", async () => {
    const ev = read("fixtures/settlement-evidence-payment-success.json").evidence;
    ev.phase = "pay-x402";
    ev.paymentTxRefs = [{ kind: "x402", httpResource: "https://seller.example/resource", paymentReceiptHash: "b".repeat(64), protocolVersion: "2" }];
    ev.settlementFinality = { model: "provider-receipt", finalityObservedAt: ev.observedAt };
    signEvidence(ev);
    expect((await validateSettlementEvidenceStructure(ev)).decision).toBe("invalid");
    expect((await inspectHistoricalSettlementEvidence(ev, {}, deps)).decision).toBe("valid");
  });

  test.each(["", 42, null, false])("rejects any supplied errorClass on success: %j", async (errorClass) => {
    const ev = read("fixtures/settlement-evidence-payment-success.json").evidence;
    const context = paymentAuthenticatedContext();
    context.result.errorClass = errorClass as string;
    expect((await authenticate(ev, context)).decision).toBe("fail");
  });

  test.each(["not-registered", "", 42, null, false, {}, "permanent", "transient", "counterparty", "substrate", "settlement-atomicity"])(
    "validates failure classification %j", async (errorClass) => {
      const ev = read("fixtures/settlement-evidence-payment-success.json").evidence;
      ev.outcome = "failure";
      ev.reason = "payment unavailable";
      delete ev.settlementFinality;
      const context = paymentAuthenticatedContext();
      context.result = { ok: false, errorClass: errorClass as string };
      // PC-4: settlement-atomicity is cross-chain only, so this EVM record refuses it.
      const expected = typeof errorClass === "string" && ["permanent", "transient", "counterparty", "substrate"].includes(errorClass);
      expect((await authenticate(ev, context)).decision).toBe(expected ? "pass" : "fail");
      expect((await validateSettlementEvidenceStructure(ev, context)).decision).toBe(expected ? "valid" : "invalid");
    },
  );

  test.each([
    ["pay-evm-erc20", "evm-erc20", false],
    ["pay-solana-spl", "solana-spl", false],
    ["pay-ap2", "ap2", false],
    ["pay-x402", "x402", false],
    ["pay-dem", "demos-native", false],
    ["pay-cross-chain-htlc", "cross-chain-htlc", true],
    ["pay-cross-chain-liquidity-tank", "cross-chain-liquidity-tank", true],
  ] as const)("admits settlement-atomicity only for cross-chain payment %s", async (phase, railType, crossChain) => {
    for (const errorClass of ["permanent", "transient", "counterparty", "substrate", "settlement-atomicity"]) {
      const ev = read("fixtures/settlement-evidence-payment-success.json").evidence;
      ev.phase = phase;
      ev.outcome = "failure";
      ev.reason = "payment unavailable";
      delete ev.paymentTxRefs;
      delete ev.settlementFinality;
      const context = paymentAuthenticatedContext();
      context.rail = { railId: "polygon-amoy-usdc", railType, asset: "USDC", network: "cross-chain", handler: phase,
        ...(phase === "pay-cross-chain-htlc" ? { sourceFinalitySec: 60, safetyWindowSec: 300 } : {}) };
      context.result = { ok: false, errorClass };
      const admitted = errorClass !== "settlement-atomicity" || crossChain;
      const authenticated = await authenticate(ev, context);
      expect(authenticated.decision, JSON.stringify({ errorClass, reasons: authenticated.reasons }))
        .toBe(admitted ? "pass" : "fail");
      expect((await validateSettlementEvidenceStructure(ev, context)).decision).toBe(admitted ? "valid" : "invalid");
      if (!admitted) {
        expect(authenticated.reasons).toContain("phase result errorClass settlement-atomicity is cross-chain only (PC-4)");
        expect((await inspectHistoricalSettlementEvidence(ev, context, deps)).decision).toBe("invalid");
      }
    }
  });

  test.each(["deliver-storage-program", "deliver-entitlement", "deliver-attested-payload"])(
    "authenticates failed %s without requiring an invented payload", async (phase) => {
      const ev = read("fixtures/settlement-evidence-delivery-success.json").evidence;
      ev.phase = phase;
      ev.outcome = "failure";
      ev.reason = "delivery unavailable";
      delete ev.deliverableContentHash;
      delete ev.deliverableAnchor;
      delete ev.attestationRef;
      const context: AuthenticatedEvidenceContext = {
        orchestrator: ORCH, agreement: { amount: "1", currency: "TEST" },
        attestationRef: read("fixtures/settlement-evidence-delivery-success.json").result.attestationRef,
        result: { ok: false, errorClass: "transient" },
      };
      for (const fields of [{}, { deliverableContentHash: "a".repeat(64) },
        { deliverableAnchor: { kind: "storage-program", locator: "diagnostic:attempt" } }]) {
        const candidate = { ...ev, ...fields };
        expect((await authenticate(candidate, context)).decision).toBe("pass");
        expect((await validateSettlementEvidenceStructure(candidate)).decision).toBe("valid");
      }
      for (const fields of [{ deliverableContentHash: "bad" }, { deliverableAnchor: { kind: "storage-program" } }]) {
        expect((await authenticate({ ...ev, ...fields }, context)).decision).toBe("fail");
      }
      // PC-4's cross-chain-only class never classifies a delivery phase.
      const atomicity = { ...context, result: { ok: false, errorClass: "settlement-atomicity" } };
      expect((await authenticate(ev, atomicity)).decision).toBe("fail");
      expect((await validateSettlementEvidenceStructure(ev, atomicity)).decision).toBe("invalid");
    },
  );
});

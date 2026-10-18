import { verifyFinalizedSessionSettlement as verifyCurrentFinalized } from "../../src/agent/sessionSettlement.js";
import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";

import {
  verifyLegacyFinalizedSessionSettlement as verifyFinalizedSessionSettlement,
  type SessionSettlementContext,
  type FinalizedSessionSettlement,
  type SessionSettlementVerificationProvider,
} from "../../src/agent/sessionSettlement.js";
import {
  admitArtifactJson,
  canonicalize,
  contentHash,
  sha256Hex,
} from "../../src/canonical/index.js";
import { publicKeyFromRaw, ed25519Verify } from "../../src/crypto/index.js";
import { verifySettlementEvidence, verifyConstructedSettlementEvidence } from "../../src/agent/verifySettlementEvidence.js";

test("finalized settlement requires admitted evidence and retains it for recovery with the public signature", async () => {
  const vector = JSON.parse(readFileSync(new URL(
    "../../vendor/DACS-Standard/conformance/vectors/security/identity-bundle-hash-binding-v0.1.json",
    import.meta.url,
  ), "utf8"));
  const scenario = vector.scenarios.agreement;
  const member = scenario.verifierContext.terminalAuthority.settlements[0];
  const original = member.record;
  const bytes = Buffer.from(JSON.stringify(original));
  const duplicate = Buffer.from('{"outcome":"failure",' + JSON.stringify(original).slice(1));
  expect(() => admitArtifactJson(duplicate)).toThrow(/DUPLICATE-MEMBER/);
  const parsed = JSON.parse(duplicate.toString("utf8"));
  expect(parsed).toEqual(original);
  const proof = member.executionAuthority.settlementObservation;
  const agreementHash = contentHash(scenario.agreement);
  const context: SessionSettlementContext = {
    contextVersion: "1",
    jobId: original.jobId,
    agreementRef: {
      anchor: { kind: "storage-program", locator: "fixture:agreement" },
      contentHash: agreementHash,
    },
    agreementHash,
    paymentPhaseIndex: 3,
    orchestrator: original.signature.signer,
    payer: { primaryClaim: proof.event.payer, payingKey: proof.event.payer },
    payee: { primaryClaim: proof.event.payee, receivingKey: proof.event.payee },
    paymentAmount: original.paymentAmount,
    rail: {
      railId: "demos-native:DEM",
      railVersion: 1,
      railRegistryVersion: 1,
      descriptorHash: "a".repeat(64),
      railType: "demos-native",
      handler: "pay-dem",
      asset: "DEM",
      network: "demos",
      finality: { model: "bft-final" },
    },
  };
  const settlement: FinalizedSessionSettlement = {
    settlementVersion: "1",
    outcome: "success",
    evidence: parsed,
    evidenceRef: {
      anchor: { kind: "storage-program", locator: member.receipt.logicalAddress },
      contentHash: member.ref.contentHash,
    },
    anchorReceipt: member.receipt,
    nativeProofRef: {
      proofVersion: "1",
      kind: "fixture-observation",
      locator: "fixture:proof",
      contentHash: sha256Hex(canonicalize(proof)),
      encoding: "jcs",
    },
  };
  let signatureChecks = 0;
  // These deterministic providers bind the same independent fixture for both
  // encodings. Only its existing public Ed25519 signature is verified.
  const provider: SessionSettlementVerificationProvider = {
    authenticateContext: (value) => canonicalize(value) === canonicalize(context)
      ? { disposition: "pass" }
      : { disposition: "fail", reason: "fixture mismatch" },
    verifyEvidenceAnchor: ({ evidence, anchorReceipt }) =>
      canonicalize(evidence) === canonicalize(original) &&
      canonicalize(anchorReceipt) === canonicalize(member.receipt)
        ? { disposition: "pass" }
        : { disposition: "fail", reason: "fixture mismatch" },
    resolveNativeProof: () => ({ disposition: "present", artifact: proof }),
    revalidateSettlement: () => ({
      disposition: "pass",
      outcome: "success",
      binding: {
        jobId: original.jobId,
        railId: context.rail.railId,
        phaseIndex: 3,
        settlementId: `demos:${original.paymentTxRefs[0].txHash}`,
      },
      nativeObservation: {
        observationVersion: "1",
        kind: "fixture-observation",
        observedAt: original.observedAt + 1,
        finality: original.settlementFinality,
        sessionBinding: {
          disposition: "established",
          kind: "fixture-session",
          bindingHash: sha256Hex(canonicalize(proof)),
        },
        details: proof,
      },
    }),
    evidence: {
      resolvePublicKey: async (claim) => Buffer.from(claim.slice("key:".length), "hex"),
      verify: (bytes, signature, key) => {
        signatureChecks++;
        return ed25519Verify(bytes, signature, publicKeyFromRaw(key));
      },
    },
  };
  const directContext: Parameters<typeof verifySettlementEvidence>[1] = {
    orchestrator: context.orchestrator,
    agreement: { amount: "1", currency: "DEM" },
    rail: { ...context.rail, assetSpec: { kind: "native-dem" }, networkSpec: { kind: "demos" } },
    attestationRef: settlement.evidenceRef,
    paymentAddress: { railId: context.rail.railId, phaseIndex: 3 },
    result: { ok: true },
  };
  expect((await verifySettlementEvidence(parsed, directContext, provider.evidence)).decision).toBe("error");
  const admittedEvidence = () => admitArtifactJson(bytes) as unknown as FinalizedSessionSettlement["evidence"];
  for (const mode of ["initial", "recovery"] as const) {
    for (const profile of [undefined, { standardPin: "wrong" },
      { standardPin: "d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20", participants: [context.payer.primaryClaim, context.payer.primaryClaim] },
      { release: "candidate", authenticated: true },
      { session: "another-session", participants: ["did:demos:someone-else"] },
      { modules: { CORE: "0.1" }, authenticated: true }]) {
      const deps = { resolvePublicKey: vi.fn(provider.evidence.resolvePublicKey), verify: vi.fn(provider.evidence.verify) };
      const currentContext = { ...directContext, profile };
      const verdict = await verifySettlementEvidence(admittedEvidence(), currentContext, deps);
      expect(verdict.decision).toBe("error");
      expect(verdict.reasons.join(" ")).toContain("unreleased corrective candidate");
      expect((await verifyConstructedSettlementEvidence(original, currentContext, deps)).decision).toBe("error");
      expect(await verifyCurrentFinalized({ ...context, profile }, { ...settlement, evidence: admittedEvidence() }, {
        ...provider, authenticateContext: vi.fn(() => { throw new Error("must not run"); }), evidence: deps,
      }, mode)).toMatchObject({ disposition: "error", reason: expect.stringContaining("unreleased corrective candidate") });
      expect(deps.resolvePublicKey).not.toHaveBeenCalled();
      expect(deps.verify).not.toHaveBeenCalled();
    }
  }
  const clean = await verifyFinalizedSessionSettlement(context, {
    ...settlement, evidence: admittedEvidence(),
  }, provider);
  expect(clean.disposition).toBe("verified");
  expect(signatureChecks).toBe(1);
  if (clean.disposition !== "verified") throw new Error("fixture must verify");
  const recovered = await verifyFinalizedSessionSettlement(
    context, clean.value.settlement, provider, "recovery",
  );
  expect(recovered.disposition).toBe("verified");
  const persisted = JSON.parse(JSON.stringify(clean.value.settlement));
  expect((await verifyFinalizedSessionSettlement(context, {
    ...persisted, evidence: admittedEvidence(),
  }, provider, "recovery")).disposition).toBe("verified");
  expect(signatureChecks).toBe(3);

  const changed = admittedEvidence();
  changed.outcome = "failure";
  for (const mode of ["initial", "recovery"] as const) {
    // Unproven objects and JSON-persisted state cannot call trust providers,
    // even when their surviving values carry a valid public signature.
    for (const evidence of [original, parsed, persisted.evidence, changed]) {
      const calls = {
        authenticateContext: vi.fn(provider.authenticateContext),
        verifyEvidenceAnchor: vi.fn(provider.verifyEvidenceAnchor),
        resolveNativeProof: vi.fn(provider.resolveNativeProof),
        revalidateSettlement: vi.fn(provider.revalidateSettlement),
        evidence: {
          resolvePublicKey: vi.fn(provider.evidence.resolvePublicKey),
          verify: vi.fn(provider.evidence.verify),
        },
      };
      expect(await verifyFinalizedSessionSettlement(context, {
        ...settlement, evidence,
      }, calls, mode)).toEqual({
        disposition: "error",
        reason: "finalized settlement evidence requires raw-byte admission",
      });
      for (const callback of [
        calls.authenticateContext, calls.verifyEvidenceAnchor,
        calls.resolveNativeProof, calls.revalidateSettlement,
        calls.evidence.resolvePublicKey, calls.evidence.verify,
      ]) expect(callback).not.toHaveBeenCalled();
    }
  }
  expect(signatureChecks).toBe(3);
});

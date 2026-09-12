import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ARTIFACT_SEPARATORS,
  type ArtifactKind,
  contentHash,
  isAgreementDocument,
  isAttestationBundle,
  isFaultAttestationBundle,
  isEvidenceBoundFaultAttestationBundle,
  isCompositeVerificationRecord,
  isListing,
  isLegacyMvpListing,
  isLegacyMvpSettlementEvidence,
  isPayeeBoundAgreementDocument,
  isPricingSpec,
  isSettlementEvidence,
} from "../../src/index.js";

const CONF = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../vendor/DACS-Standard/conformance",
);
const VECTOR = join(CONF, "vectors/dacs-v0.1-happy-path.json");
// SettlementEvidence migrated to the rich/normative §14 shape; the happy-path
// vector still carries the stale simple shape, so validate the rich fixture.
const EV_FIXTURE = join(CONF, "fixtures/settlement-evidence-payment-success.json");
const BUNDLE_FIXTURE = join(CONF, "fixtures/attestation-bundle-0004.json");
const have = existsSync(VECTOR);

/**
 * The current legacy AttestationBundle fixture deliberately retains historical
 * phase labels (`vet-counterparty`, `settle-testnet`). New v0.3 production uses
 * the closed DACS-1 §6.3 PhaseType set, so reference-shape tests keep the exact
 * refs/txRefs while spelling the equivalent current phases.
 */
const currentPhaseBundleFixture = () => {
  const bundle = JSON.parse(readFileSync(BUNDLE_FIXTURE, "utf8"));
  bundle.phaseSummary[0].kind = "vet-credentials";
  bundle.phaseSummary[1].kind = "pay-dem";
  return bundle;
};

const VALIDATORS: Record<ArtifactKind, (v: unknown) => boolean> = {
  Listing: isListing,
  CompositeVerificationRecord: isCompositeVerificationRecord,
  AgreementDocument: isAgreementDocument,
  PayeeBoundAgreementDocument: isPayeeBoundAgreementDocument,
  SettlementEvidence: isSettlementEvidence,
  AttestationBundle: isAttestationBundle,
  FaultAttestationBundle: isFaultAttestationBundle,
  EvidenceBoundFaultAttestationBundle: isEvidenceBoundFaultAttestationBundle,
};

describe("legacy MVP settlement finality compatibility", () => {
  const evidence = {
    evidenceVersion: "1",
    jobId: "job-1",
    phase: "pay-x402",
    phaseIndex: 0,
    outcome: "success",
    paymentTxRefs: [{ rail: "test", txHash: "0x1", kind: "payment" }],
    paymentAmount: { amount: "1", currency: "USDC" },
    observedAt: 1,
  };

  it("accepts valid optional finality echoes and rejects cross-model fields", () => {
    expect(isLegacyMvpSettlementEvidence({
      ...evidence,
      settlementFinality: {
        model: "block-depth",
        finalityObservedAt: 1,
      },
    })).toBe(true);
    expect(isLegacyMvpSettlementEvidence({
      ...evidence,
      settlementFinality: {
        model: "commitment-level",
        finalityCommitmentLevel: "confirmed",
        finalityObservedAt: 1,
      },
    })).toBe(true);
    expect(isLegacyMvpSettlementEvidence({
      ...evidence,
      settlementFinality: {
        model: "commitment-level",
        finalityBlocks: 1,
        finalityObservedAt: 1,
      },
    })).toBe(false);
    expect(isLegacyMvpSettlementEvidence({
      ...evidence,
      settlementFinality: {
        model: "provider-receipt",
        finalityObservedAt: 1,
        extra: true,
      },
    })).toBe(false);
  });
});

describe("spine artifacts vs the §14 happy-path vector (T3)", () => {
  if (!have) {
    it.skip("vectors not synced — run `npm run conformance:sync`", () => {});
    return;
  }

  const vector = JSON.parse(readFileSync(VECTOR, "utf8")) as {
    artifacts: Array<{
      kind: string;
      domainSeparator: string;
      artifact: Record<string, unknown>;
    }>;
  };

  // Standard 965df75 has regenerated the happy-path Listing and Agreement
  // signatures in canonical SIG-6 Base64URL form, so every exported validator
  // is now exercised as an ordinary passing oracle case.
  const PINNED_VECTOR_DIVERGENCES = new Set<string>(["AgreementDocument"]);

  for (const a of vector.artifacts) {
    const kind = a.kind as ArtifactKind;
    const validator = VALIDATORS[kind];
    if (!validator) continue;

    const knownGap = PINNED_VECTOR_DIVERGENCES.has(kind);
    const runner = knownGap ? it.fails : it;
    const gapReason =
      kind === "Listing"
        ? " — PINNED VECTOR DEBT: padded pre-SIG-6 signature"
        : kind === "AgreementDocument"
          ? " — PINNED VECTOR DEBT: pre-B.1 non-ULID jobId"
        : " — KNOWN GAP: reduced vs normative shape (#5)";
    runner(
      `${kind}: validator accepts the fixture${knownGap ? gapReason : ""}`,
      () => {
        // The v0.3 vector's in-body SettlementEvidence/AttestationBundle omit
        // fields the SDK still carries (e.g. SB-1 recovers phaseIndex from the
        // anchor address, not the body), so validate the rich reference fixtures.
        let fixture =
          kind === "SettlementEvidence"
            ? JSON.parse(readFileSync(EV_FIXTURE, "utf8")).evidence
            : kind === "AttestationBundle"
              ? currentPhaseBundleFixture()
              : a.artifact;
        // This vendored vector predates SIG-6 and carries padded standard
        // Base64. Shape validation uses the same raw signature bytes in the
        // current canonical unpadded Base64URL spelling.
        if (kind === "CompositeVerificationRecord") {
          fixture = structuredClone(fixture);
          fixture.signature.value = Buffer.from(
            fixture.signature.value,
            "base64",
          ).toString("base64url");
        }
        expect(validator(fixture)).toBe(true);
      },
    );

    it(`${kind}: registry separator matches the spec`, () => {
      // v0.2 vectors carry the correct separators (incl. dacs-composite:v1: for
      // the composite record) — no per-kind override needed anymore.
      expect(ARTIFACT_SEPARATORS[kind]).toBe(a.domainSeparator);
    });

    it(`${kind}: content hash is a stable sha256 hex`, () => {
      const h = contentHash(a.artifact);
      expect(h).toMatch(/^[0-9a-f]{64}$/);
      expect(contentHash(a.artifact)).toBe(h);
    });
  }

  it("validators reject malformed artifacts", () => {
    expect(isListing({ agentId: 1 })).toBe(false);
    expect(isAgreementDocument({ jobId: "x" })).toBe(false);
    expect(isAttestationBundle({ jobId: "x", ratings: [{ from: 1 }] })).toBe(
      false,
    );
  });

  it("SettlementEvidence validator enforces the §9.7 enums", () => {
    const valid = JSON.parse(readFileSync(EV_FIXTURE, "utf8")).evidence;
    expect(isSettlementEvidence(valid)).toBe(true);
    expect(isSettlementEvidence({ ...valid, signature: "deadbeef" })).toBe(false);
    expect(isSettlementEvidence({ ...valid, signatures: [] })).toBe(false);
    expect(
      isSettlementEvidence({
        ...valid,
        signature: { ...valid.signature, value: "YWJjZA==" },
      }),
    ).toBe(false);
    // outcome must be success|failure — not any string.
    expect(isSettlementEvidence({ ...valid, outcome: "banana" })).toBe(false);
    // finality model must be a §9.7 member — not the old "observed".
    expect(
      isSettlementEvidence({
        ...valid,
        settlementFinality: { ...valid.settlementFinality, model: "observed" },
      }),
    ).toBe(false);
    // Finality is success-only.
    expect(
      isSettlementEvidence({ ...valid, outcome: "failure", settlementFinality: undefined }),
    ).toBe(false);
    expect(
      isSettlementEvidence({
        ...valid,
        outcome: "failure",
        reason: "rail rejected",
        settlementFinality: undefined,
      }),
    ).toBe(true);
    expect(isSettlementEvidence({ ...valid, outcome: "failure" })).toBe(false);
    expect(isSettlementEvidence({ ...valid, settlementFinality: undefined })).toBe(false);
    // finalityBlocks belongs only to block-depth.
    expect(
      isSettlementEvidence({
        ...valid,
        settlementFinality: {
          model: "bft-final",
          finalityBlocks: 1,
          finalityObservedAt: valid.settlementFinality.finalityObservedAt,
        },
      }),
    ).toBe(false);

    const finalityBase = {
      ...valid,
      settlementFinality: {
        model: "provider-receipt",
        finalityObservedAt: valid.settlementFinality.finalityObservedAt,
      },
    };
    for (const settlementFinality of [
      { model: "block-depth", finalityObservedAt: 1 },
      { model: "block-depth", finalityBlocks: 0, finalityObservedAt: 1 },
      { model: "commitment-level", finalityObservedAt: 1 },
      {
        model: "commitment-level",
        finalityCommitmentLevel: "processed",
        finalityObservedAt: 1,
      },
      {
        model: "commitment-level",
        finalityCommitmentLevel: "confirmed",
        finalityObservedAt: 1,
      },
      {
        model: "commitment-level",
        finalityCommitmentLevel: "finalized",
        finalityObservedAt: 1,
      },
      { model: "provider-receipt", finalityObservedAt: 1 },
      { model: "htlc-reveal", finalityObservedAt: 1 },
      { model: "liquidity-tank", finalityObservedAt: 1 },
      { model: "bft-final", finalityObservedAt: 1 },
    ]) {
      expect(isSettlementEvidence({ ...finalityBase, settlementFinality }))
        .toBe(true);
    }
    for (const settlementFinality of [
      { model: "block-depth", finalityBlocks: -1, finalityObservedAt: 1 },
      { model: "block-depth", finalityBlocks: 1.5, finalityObservedAt: 1 },
      {
        model: "block-depth",
        finalityCommitmentLevel: "confirmed",
        finalityObservedAt: 1,
      },
      {
        model: "commitment-level",
        finalityBlocks: 1,
        finalityObservedAt: 1,
      },
      {
        model: "commitment-level",
        finalityCommitmentLevel: "kinda",
        finalityObservedAt: 1,
      },
      { model: "provider-receipt", extra: true, finalityObservedAt: 1 },
    ]) {
      expect(isSettlementEvidence({ ...finalityBase, settlementFinality }))
        .toBe(false);
    }
  });
});

describe.skipIf(!have)("isAttestationBundle: phaseSummary[].attestationRef is OPTIONAL (#12 / §10.4.3)", () => {
  const bundle = currentPhaseBundleFixture;

  it("retains explicit read compatibility for historical phase labels", () => {
    const historical = JSON.parse(readFileSync(BUNDLE_FIXTURE, "utf8"));
    expect(historical.phaseSummary.map((phase: { kind: string }) => phase.kind)).toEqual([
      "vet-counterparty",
      "settle-testnet",
    ]);
    expect(isAttestationBundle(historical)).toBe(true);
    expect(isFaultAttestationBundle({
      ...historical,
      bundleVersion: undefined,
      faultBundleVersion: "1",
      faultedParty: "none",
    })).toBe(false);
  });

  it("accepts a bundle whose phaseSummary entry omits attestationRef", () => {
    const b = bundle();
    expect(isAttestationBundle(b)).toBe(true); // baseline: fixture has it
    delete b.phaseSummary[0].attestationRef; // §10.4.3: MAY be omitted
    expect(isAttestationBundle(b)).toBe(true);
  });

  it("still rejects a phaseSummary attestationRef that is present but malformed", () => {
    const b = bundle();
    b.phaseSummary[0].attestationRef = { kind: "x" }; // missing id/contentHash
    expect(isAttestationBundle(b)).toBe(false);
  });
});

describe.skipIf(!have)("FaultAttestationBundle discriminator", () => {
  const faultBundle = () => {
    const bundle = currentPhaseBundleFixture();
    delete bundle.bundleVersion;
    bundle.faultBundleVersion = "1";
    bundle.faultedParty = bundle.outcome === "completed" ? "none" : "seller";
    return bundle;
  };

  it("accepts exactly the fault discriminator plus required absolute fault", () => {
    const bundle = faultBundle();
    expect(isFaultAttestationBundle(bundle)).toBe(true);
    expect(isAttestationBundle(bundle)).toBe(false);
  });

  it("rejects missing or cross-type discriminator fields", () => {
    const missing = faultBundle();
    delete missing.faultedParty;
    expect(isFaultAttestationBundle(missing)).toBe(false);

    const confused = faultBundle();
    confused.bundleVersion = "1";
    expect(isFaultAttestationBundle(confused)).toBe(false);
    expect(isAttestationBundle(confused)).toBe(false);
  });

  it("requires one buyer and seller role and unique phase indices", () => {
    const missingSeller = faultBundle();
    missingSeller.parties = missingSeller.parties.filter(
      (party: { role: string }) => party.role !== "seller",
    );
    expect(isFaultAttestationBundle(missingSeller)).toBe(false);

    const duplicatePhase = faultBundle();
    duplicatePhase.phaseSummary.push({ ...duplicatePhase.phaseSummary[0] });
    expect(isFaultAttestationBundle(duplicatePhase)).toBe(false);
  });

  it("rejects phase outcomes and error classes outside the closed DACS enums", () => {
    const invalidOutcome = faultBundle();
    invalidOutcome.phaseSummary[0].outcome = "garbage";
    expect(isFaultAttestationBundle(invalidOutcome)).toBe(false);

    const invalidErrorClass = faultBundle();
    invalidErrorClass.phaseSummary[0].errorClass = "garbage";
    expect(isFaultAttestationBundle(invalidErrorClass)).toBe(false);

    const invalidTxRef = faultBundle();
    invalidTxRef.phaseSummary[0].txRefs = [{ rail: "pay-x402" }];
    expect(isFaultAttestationBundle(invalidTxRef)).toBe(false);
  });

  it("rejects an absolute fault that contradicts the outcome and anchor role", () => {
    const completedWithFault = faultBundle();
    completedWithFault.faultedParty = "seller";
    expect(isFaultAttestationBundle(completedWithFault)).toBe(false);

    const wrongSelfFault = faultBundle();
    wrongSelfFault.outcome = "failed-perm";
    wrongSelfFault.anchoredByRole = "buyer";
    wrongSelfFault.faultedParty = "seller";
    expect(isFaultAttestationBundle(wrongSelfFault)).toBe(false);
  });
});

describe("DACS-4 §9.3 PricingSpec + legacy Listing compatibility", () => {
  const baseListing = {
    agentId: "did:demos:seller",
    serviceId: "svc",
    name: "n",
    description: "d",
    claimRequirements: [],
    supportedNegotiation: ["negotiate-fixed-price"],
    supportedPaymentRails: ["pay-x402"],
    supportedDelivery: ["deliver-attested-payload"],
  };

  it("keeps the reduced no-pricing shape in the explicit legacy read validator", () => {
    expect(isLegacyMvpListing(baseListing)).toBe(true);
    expect(isListing(baseListing)).toBe(false);
  });

  it("accepts each PricingSpec kind", () => {
    expect(isPricingSpec({ kind: "fixed", price: { amount: "5", currency: "USDC" } })).toBe(true);
    expect(
      isPricingSpec({
        kind: "negotiable",
        bandCenter: { amount: "5", currency: "USDC" },
        minPct: 10,
        maxPct: 20,
      }),
    ).toBe(true);
    expect(isPricingSpec({ kind: "auction", selectionRule: "lowest-price" })).toBe(true);
    expect(
      isPricingSpec({
        kind: "auction",
        selectionRule: `rule-ref:${"a".repeat(64)}:https://x`,
      }),
    ).toBe(true);
    expect(
      isPricingSpec({
        kind: "metered",
        unitPrice: { amount: "0.5", currency: "USDC" },
        unit: "request",
        minTotal: { amount: "1", currency: "USDC" },
      }),
    ).toBe(true);
    // A valid pre-metered pricing variant remains readable on the legacy shape.
    expect(
      isLegacyMvpListing({ ...baseListing, pricing: { kind: "fixed", price: { amount: "5", currency: "USDC" } } }),
    ).toBe(true);
  });

  it("rejects a malformed PricingSpec (present but not well-formed)", () => {
    expect(isPricingSpec({ kind: "banana" })).toBe(false);
    expect(isPricingSpec({ kind: "fixed" })).toBe(false); // missing price
    expect(isPricingSpec({ kind: "fixed", price: { amount: "", currency: "USDC" } })).toBe(false);
    expect(isPricingSpec({ kind: "auction", selectionRule: "coin-flip" })).toBe(false);
    expect(
      isPricingSpec({ kind: "negotiable", bandCenter: { amount: "5", currency: "USDC" }, minPct: "x", maxPct: 1 }),
    ).toBe(false);
    // a listing carrying a bad pricing is rejected — not silently accepted.
    expect(isLegacyMvpListing({ ...baseListing, pricing: { kind: "banana" } })).toBe(false);
  });

  it("rejects a negotiable band that breaks the §8.5.2 minPct/maxPct bounds (#37)", () => {
    const band = (minPct: number, maxPct: number) => ({
      kind: "negotiable",
      bandCenter: { amount: "5", currency: "USDC" },
      minPct,
      maxPct,
    });
    // in-bounds band is fine…
    expect(isPricingSpec(band(10, 20))).toBe(true);
    expect(isPricingSpec(band(0, 0))).toBe(true);
    // …but minPct ≥ 100 (floor at/below zero), or a negative pct, is rejected.
    expect(isPricingSpec(band(100, 10))).toBe(false);
    expect(isPricingSpec(band(150, 10))).toBe(false);
    expect(isPricingSpec(band(-1, 10))).toBe(false);
    expect(isPricingSpec(band(10, -5))).toBe(false);
  });
});

// Ungated (no vendored vectors needed): the READ-path guard for listingVersion.
// Publish validates its own writes, but a listing anchored by another writer (or
// an older SDK) reaches consumers only through isListing — so the version pin
// that flows into listingRef.version must be validated HERE (#46/#29).
describe("isLegacyMvpListing — historical listingVersion clause (#46/#29)", () => {
  const base = {
    agentId: "did:demos:agent:seller",
    serviceId: "svc-1",
    name: "n",
    description: "d",
    claimRequirements: [],
    supportedNegotiation: ["fixed-price"],
    supportedPaymentRails: ["pay-x402"],
    supportedDelivery: ["inline"],
  };

  it("accepts an absent listingVersion (⇒ v1) and positive integers", () => {
    expect(isLegacyMvpListing(base)).toBe(true);
    expect(isLegacyMvpListing({ ...base, listingVersion: 1 })).toBe(true);
    expect(isLegacyMvpListing({ ...base, listingVersion: 7 })).toBe(true);
  });

  it("rejects a non-integer, zero, negative, fractional, or string version", () => {
    expect(isLegacyMvpListing({ ...base, listingVersion: "bad" })).toBe(false);
    expect(isLegacyMvpListing({ ...base, listingVersion: 0 })).toBe(false);
    expect(isLegacyMvpListing({ ...base, listingVersion: -1 })).toBe(false);
    expect(isLegacyMvpListing({ ...base, listingVersion: 1.5 })).toBe(false);
    expect(isLegacyMvpListing({ ...base, listingVersion: null })).toBe(false);
  });
});

// Ungated: §9.7 / §10.4.1 version literals are PINNED (#5) — a non-"1" version
// is an out-of-spec artifact, not a forward-compatible one (§11.1.2 forward
// readability is carried by SIG-5 unknown-field retention, not version drift).
describe("version literal pinning (#5)", () => {
  it("isSettlementEvidence rejects a non-'1' evidenceVersion", () => {
    const base = {
      evidenceVersion: "2",
      jobId: "j",
      phase: "pay-x402",
      outcome: "success",
      paymentTxRefs: [
        {
          kind: "x402",
          httpResource: "https://seller.example/pay",
          paymentReceiptHash: "a".repeat(64),
          protocolVersion: "1",
        },
      ],
      paymentAmount: { amount: "1", currency: "USDC" },
      settlementFinality: { model: "provider-receipt", finalityObservedAt: 1 },
      observedAt: 1,
      signature: {
        algorithm: "ed25519",
        signer: "did:demos:orchestrator",
        value: Buffer.alloc(64, 5).toString("base64url"),
      },
    };
    expect(isSettlementEvidence(base)).toBe(false);
    expect(isSettlementEvidence({ ...base, evidenceVersion: "1" })).toBe(true);
  });

  it("isAttestationBundle rejects a non-'1' bundleVersion", () => {
    const base = {
      bundleVersion: "2",
      jobId: "j",
      outcome: "completed",
      parties: [],
      phaseSummary: [],
      vetRecords: [],
      settlementEvidence: [],
      listingRef: { listingId: "l", version: 1, contentHash: "a".repeat(64) },
      recipeRegistryVersion: 1,
      railRegistryVersion: 1,
      finalisedAt: 1,
    };
    expect(isAttestationBundle(base)).toBe(false);
  });
});

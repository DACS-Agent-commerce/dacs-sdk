import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  attestationBundleHash,
  buildEvidenceBoundTwoSidedBundle,
  buildTwoSidedBundle,
  ARTIFACT_SEPARATORS,
  bundlesDiverge,
  evaluateEvidenceBoundSettlementSet,
  verifyEvidenceBoundFaultBundle,
  verifyFaultBundleExtendedPointer,
  verifyBundleCopy,
  selectAuthoritativeBundleCopy,
  contentHash,
  deriveReputation,
  isEvidenceBoundFaultAttestationBundle,
  projectAlternativePaymentPipeline,
  validateAlternativePaymentListing,
  type EvidenceBoundBundleAuthority,
  type EvidenceBoundBundleVerifierDeps,
  type EvidenceBoundExactSetInput,
  type VerifiedEvidenceBoundExecutionAuthority,
} from "../../src/index.js";
import { signedBytes } from "../../src/crypto/signing.js";
import {
  ed25519Verify,
  ed25519Sign,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
} from "../../src/crypto/ed25519.js";

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/standard-next",
);

const read = (name: string): any =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

function depsFor(publicKeys: Record<string, string>): EvidenceBoundBundleVerifierDeps {
  return {
    resolvePublicKey: async (claim) => {
      const value = publicKeys[claim];
      return value === undefined
        ? null
        : Uint8Array.from(Buffer.from(value, "base64url"));
    },
    verify: async (bytes, signature, publicKey) =>
      ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
  };
}

describe("DACS-5 v0.4 EvidenceBoundFaultAttestationBundle", () => {
  const corpus = read("bundle-settlement-evidence-bijection-v0.4.json");
  const deps = depsFor(corpus.publicKeys);

  it("authenticates the Standard authority graphs and rejects every invalid graph", async () => {
    for (const [name, raw] of Object.entries<any>(corpus.executionAuthorities)) {
      const result = await verifyEvidenceBoundFaultBundle(raw, deps);
      if (name.startsWith("invalid-") || name === "mismatched-listing-signer") {
        expect(result.decision, name).not.toBe("verified");
      } else {
        expect(result.decision, `${name}: ${result.reason}`).toBe("verified");
        expect(result.authority, name).toBeDefined();
      }
    }
  });

  it("accepts the SDK's normative signed Listing shape, including inert extensions", async () => {
    const seed = (label: string) =>
      Uint8Array.from(createHash("sha256").update(label).digest());
    const buyerSeed = seed("ebfab-full-listing-buyer");
    const sellerSeed = seed("ebfab-full-listing-seller");
    const orchestratorSeed = seed("ebfab-full-listing-orchestrator");
    const buyerRaw = rawPublicKey(publicKeyFromSeed(buyerSeed));
    const sellerRaw = rawPublicKey(publicKeyFromSeed(sellerSeed));
    const orchestratorRaw = rawPublicKey(publicKeyFromSeed(orchestratorSeed));
    const buyerClaim = `demos:0x${Buffer.from(buyerRaw).toString("hex")}`;
    const sellerClaim = `demos:0x${Buffer.from(sellerRaw).toString("hex")}`;
    const orchestratorClaim = `demos:0x${Buffer.from(orchestratorRaw).toString("hex")}`;
    const listingScope = {
      dacsVersion: "1" as const,
      listingVersion: 1,
      listingId: "ebfab-full-listing",
      seller: {
        identity: {
          bundleVersion: "1" as const,
          presentedBy: sellerClaim,
          presentedAt: 1_780_000_000_000,
          claims: [{ ref: sellerClaim }],
          presentation: {
            kind: "per-claim" as const,
            signatures: [{ ref: sellerClaim, signature: "identity-proof" }],
          },
        },
        displayName: "Evidence seller",
      },
      offering: {
        title: "Evidence service",
        description: "A signed service Listing",
        category: "testing",
        tags: ["evidence"],
        deliverable: {
          kind: "entitlement" as const,
          durationSec: 3_600,
          renewable: false,
        },
      },
      buyerRequirement: { requirementVersion: "1" as const, required: [] },
      pipeline: [
        { kind: "negotiate-fixed-price" as const },
        { kind: "commit-payee-bound-agreement" as const },
        {
          kind: "pay-alternative" as const,
          parameters: {
            alternatives: [
              { railId: "dem:live", railVersion: 1 },
              { railId: "x402:base-sepolia", railVersion: 1 },
            ],
          },
        },
        { kind: "deliver-entitlement" as const },
      ],
      pricing: {
        kind: "fixed" as const,
        price: { amount: "1", currency: "DEM" },
      },
      acceptedRails: [
        { railId: "dem:live", railVersion: 1 },
        { railId: "x402:base-sepolia", railVersion: 1 },
      ],
      terms: { deadlineSecAfterCommit: 600 },
      validity: { notBefore: 1_780_000_000_000 },
      auditExtension: { preserved: true },
    };
    const listingHash = contentHash(listingScope);
    const listing = {
      ...listingScope,
      signature: {
        signer: sellerClaim,
        algorithm: "ed25519" as const,
        value: Buffer.from(
          ed25519Sign(
            signedBytes(ARTIFACT_SEPARATORS.Listing, listingHash),
            privateKeyFromSeed(sellerSeed),
          ),
        ).toString("base64url"),
      },
    };
    const admission = await validateAlternativePaymentListing(listing, {
      authenticateListing: () => ({ status: "authenticated" }),
      resolveRegistry: () => ({
        status: "authenticated",
        snapshotId: "registry-ebfab",
        resolutions: listing.acceptedRails.map((ref) => ({
          status: "verified" as const,
          snapshotId: "registry-ebfab",
          ref,
          definition: {
            railId: ref.railId,
            railVersion: ref.railVersion,
            phaseHandler: ref.railId === "dem:live" ? "pay-dem" : "pay-x402",
            availability: "live",
          },
        })),
      }),
      authenticateDefinition: () => ({ status: "authenticated" }),
      supportedHandlers: ["pay-dem", "pay-x402"],
    });
    expect(admission.verdict).toBe("pass");
    if (admission.verdict !== "pass") throw new Error(admission.reason);
    const jobId = "01J8ME0SXKQ4T9V2RC5HJ6WX7E";
    const projection = await projectAlternativePaymentPipeline(
      admission,
      {
        jobId,
        listingRef: {
          listingId: listing.listingId,
          version: listing.listingVersion,
          contentHash: listingHash,
        },
        terms: {
          rail: listing.acceptedRails[0],
          payoutBindings: [
            { railId: "dem:live", phaseIndex: 2, payeeAddress: sellerClaim },
          ],
        },
        signatures: [{ party: buyerClaim }, { party: sellerClaim }],
      },
      {
        agreementState: "signed",
        productionMode: true,
        authenticateAgreement: () => ({ status: "authenticated" }),
        pinSelectedDefinition: (ref) => ({
          status: "authenticated",
          ref,
          definition: {
            railId: ref.railId,
            railVersion: ref.railVersion ?? 1,
            phaseHandler: ref.railId === "dem:live" ? "pay-dem" : "pay-x402",
            availability: "live",
          },
        }),
      },
    );
    expect(projection.verdict).toBe("pass");
    if (projection.verdict !== "pass") throw new Error(projection.reason);
    const copies = await buildEvidenceBoundTwoSidedBundle(
      {
        jobId,
        outcome: "aborted-by-self",
        faultedParty: "buyer",
        listingRef: {
          listingId: listing.listingId,
          version: listing.listingVersion,
          contentHash: listingHash,
        },
        phaseSummary: [
          { index: 0, kind: "negotiate-fixed-price", outcome: "ok" },
        ],
        vetRecords: [],
        settlementEvidence: [],
        recipeRegistryVersion: 1,
        railRegistryVersion: 1,
        finalisedAt: 1_780_000_000_001,
        buyer: {
          primaryClaim: buyerClaim,
          bundleHash: "b".repeat(64),
          signer: privateKeyFromSeed(buyerSeed),
        },
        seller: {
          primaryClaim: sellerClaim,
          bundleHash: "c".repeat(64),
          signer: privateKeyFromSeed(sellerSeed),
        },
        orchestrator: {
          primaryClaim: orchestratorClaim,
          bundleHash: "d".repeat(64),
          signer: privateKeyFromSeed(orchestratorSeed),
        },
      },
      { validateEvidenceSet: async () => ({ decision: "verified" }) },
    );
    const bundle = copies.buyerCopy!;
    const result = await verifyEvidenceBoundFaultBundle(
      {
        bundle,
        listing,
        referenceValidationByCanonicalRef: {},
        bundleLifecycle: { state: "included" },
        sessionExecutionAuthorityByPhaseKey: {},
        verifiedReceiptByCanonicalRef: {},
        alternativePaymentProjection: projection,
      },
      depsFor({
        [buyerClaim]: Buffer.from(buyerRaw).toString("base64url"),
        [sellerClaim]: Buffer.from(sellerRaw).toString("base64url"),
        [orchestratorClaim]: Buffer.from(orchestratorRaw).toString("base64url"),
      }),
    );
    expect(result.decision, result.reason).toBe("verified");
    const incompleteSignerSet = await verifyEvidenceBoundFaultBundle(
      {
        bundle: {
          ...bundle,
          signatures: bundle.signatures.filter(
            (signature) => signature.party !== sellerClaim,
          ),
        },
        listing,
        referenceValidationByCanonicalRef: {},
        bundleLifecycle: { state: "included" },
        sessionExecutionAuthorityByPhaseKey: {},
        verifiedReceiptByCanonicalRef: {},
        alternativePaymentProjection: projection,
      },
      depsFor({
        [buyerClaim]: Buffer.from(buyerRaw).toString("base64url"),
        [sellerClaim]: Buffer.from(sellerRaw).toString("base64url"),
        [orchestratorClaim]: Buffer.from(orchestratorRaw).toString("base64url"),
      }),
    );
    expect(incompleteSignerSet).toMatchObject({
      decision: "rejected",
      reasonCode: "execution-authority",
    });
    const forged = await verifyEvidenceBoundFaultBundle(
      {
        bundle,
        listing,
        referenceValidationByCanonicalRef: {},
        bundleLifecycle: { state: "included" },
        sessionExecutionAuthorityByPhaseKey: {},
        verifiedReceiptByCanonicalRef: {},
        alternativePaymentProjection: structuredClone(projection),
      },
      depsFor({
        [buyerClaim]: Buffer.from(buyerRaw).toString("base64url"),
        [sellerClaim]: Buffer.from(sellerRaw).toString("base64url"),
        [orchestratorClaim]: Buffer.from(orchestratorRaw).toString("base64url"),
      }),
    );
    expect(forged).toMatchObject({
      decision: "rejected",
      reasonCode: "execution-authority",
    });
  });

  it("replays all 30 exact-set cases with normative reason precedence", async () => {
    const authorities = new Map<string, VerifiedEvidenceBoundExecutionAuthority>();
    for (const [name, raw] of Object.entries<any>(corpus.executionAuthorities)) {
      const result = await verifyEvidenceBoundFaultBundle(raw, deps);
      if (result.authority) authorities.set(name, result.authority);
    }
    for (const vector of corpus.vectors) {
      const verified = authorities.get(vector.input.executionAuthorityRef);
      const result = evaluateEvidenceBoundSettlementSet(
        verified ?? ({} as VerifiedEvidenceBoundExecutionAuthority),
        vector.input as EvidenceBoundExactSetInput,
      );
      expect(
        [result.decision, result.reasonCode],
        `${vector.name}: ${result.reason}`,
      ).toEqual([vector.want.disposition, vector.want.reasonCode]);
    }
  });

  it("replays the signed direct and EBFAB pointer compatibility paths", async () => {
    const fixture = read("evidence-bound-fault-bundle-compatibility-v0.4.json");
    const fixtureDeps = depsFor(fixture.publicKeys);
    const validCase = fixture.cases.find((candidate: any) => candidate.name === "valid-ebfab");
    const hash = attestationBundleHash(validCase.bundle);
    const authorityInput = {
      bundle: validCase.bundle,
      listing: fixture.listing,
      referenceValidationByCanonicalRef: fixture.referenceValidationByCanonicalRef,
      bundleLifecycle: fixture.bundleLifecycleByHash[hash],
      sessionExecutionAuthorityByPhaseKey: fixture.sessionExecutionAuthorityByPhaseKey,
      verifiedReceiptByCanonicalRef: fixture.verifiedReceiptByCanonicalRef,
    } as EvidenceBoundBundleAuthority;
    const verified = await verifyEvidenceBoundFaultBundle(authorityInput, fixtureDeps);
    expect(verified.decision, verified.reason).toBe("verified");
    expect(verified.authority).toBeDefined();

    for (const pointerCase of fixture.pointerCases) {
      const result = await verifyFaultBundleExtendedPointer(
        pointerCase.pointer,
        pointerCase.bundle,
        pointerCase.binding,
        fixtureDeps,
        pointerCase.useEbfabAuthority ? verified.authority : undefined,
      );
      expect(result.ok, `${pointerCase.name}: ${result.reason}`).toBe(pointerCase.want.ok);
    }

    for (const directCase of fixture.cases) {
      let candidateHash: string | null = null;
      try {
        candidateHash = attestationBundleHash(directCase.bundle);
      } catch {
        // A malformed discriminator is expected to fail before hash admission.
      }
      const candidate = await verifyEvidenceBoundFaultBundle(
        {
          bundle: directCase.bundle,
          listing: fixture.listing,
          referenceValidationByCanonicalRef: fixture.referenceValidationByCanonicalRef,
          bundleLifecycle:
            directCase.bundleLifecycle ??
            (candidateHash && fixture.bundleLifecycleByHash[candidateHash]) ??
            { state: "finalized", independentlyResolvable: true },
          sessionExecutionAuthorityByPhaseKey: fixture.sessionExecutionAuthorityByPhaseKey,
          verifiedReceiptByCanonicalRef: fixture.verifiedReceiptByCanonicalRef,
        },
        fixtureDeps,
      );
      expect(
        candidate.decision === "verified",
        `${directCase.name}: ${candidate.reason}`,
      ).toBe(directCase.want.sebValid);
    }
  });

  it("retains all four v0.3 FAB pointer outcomes", async () => {
    const fixture = read("fab-bundle-extended-pointer-v0.3.json");
    const pointerDeps = depsFor(fixture.publicKeys);
    for (const vector of fixture.vectors) {
      const result = await verifyFaultBundleExtendedPointer(
        vector.pointer,
        vector.dereferenced,
        vector.binding,
        pointerDeps,
      );
      expect(result.ok, `${vector.name}: ${result.reason}`).toBe(
        vector.want.expected === "pass",
      );
    }
  });

  it("replays all signed mixed-version pair authority and member-skew cases", async () => {
    const fixture = read("evidence-bound-fault-bundle-compatibility-v0.4.json");
    const fixtureDeps = depsFor(fixture.publicKeys);
    const rawSignatureValid = async (bundle: any): Promise<boolean> => {
      const separator = bundle.evidenceBoundFaultBundleVersion === "1"
        ? ARTIFACT_SEPARATORS.EvidenceBoundFaultAttestationBundle
        : bundle.faultBundleVersion === "1"
          ? ARTIFACT_SEPARATORS.FaultAttestationBundle
          : ARTIFACT_SEPARATORS.AttestationBundle;
      const message = signedBytes(separator, attestationBundleHash(bundle));
      for (const signature of bundle.signatures ?? []) {
        const raw = fixture.publicKeys[signature.party];
        if (!raw || signature.algorithm !== "ed25519") return false;
        if (!(await fixtureDeps.verify(
          message,
          Uint8Array.from(Buffer.from(signature.value, "base64url")),
          Uint8Array.from(Buffer.from(raw, "base64url")),
        ))) return false;
      }
      return (bundle.signatures?.length ?? 0) > 0;
    };

    for (const pairCase of fixture.pairCases) {
      expect(
        bundlesDiverge(pairCase.copies.buyer, pairCase.copies.seller),
        pairCase.name,
      ).toBe(pairCase.want.divergent);
      const validity = async (bundle: any): Promise<boolean> => {
        if (!(await rawSignatureValid(bundle))) return false;
        if (bundle.evidenceBoundFaultBundleVersion !== "1") return true;
        const hash = attestationBundleHash(bundle);
        return (
          await verifyEvidenceBoundFaultBundle(
            {
              bundle,
              listing: fixture.listing,
              referenceValidationByCanonicalRef: fixture.referenceValidationByCanonicalRef,
              bundleLifecycle: fixture.bundleLifecycleByHash[hash],
              sessionExecutionAuthorityByPhaseKey: fixture.sessionExecutionAuthorityByPhaseKey,
              verifiedReceiptByCanonicalRef: fixture.verifiedReceiptByCanonicalRef,
            },
            fixtureDeps,
          )
        ).decision === "verified";
      };
      const selected = await selectAuthoritativeBundleCopy(
        {
          buyer: { disposition: "present", bundle: pairCase.copies.buyer },
          seller: { disposition: "present", bundle: pairCase.copies.seller },
        },
        { isValid: (bundle) => validity(bundle) },
      );
      if (pairCase.want.divergent) {
        expect(selected, pairCase.name).toBeNull();
      } else {
        expect(selected?.type, pairCase.name).toBe(pairCase.want.authoritativeType);
        expect(attestationBundleHash(selected!.bundle as any), pairCase.name).toBe(
          pairCase.want.authoritativeBundleHash,
        );
      }
    }
  });

  it("rejects forged authority tokens, Proxy inputs, and callback mutation", async () => {
    const vector = corpus.vectors[0];
    expect(
      evaluateEvidenceBoundSettlementSet(
        {
          bundle: corpus.executionAuthorities["standard-completed"].bundle,
          expectedPhaseKeys: ["2:pay-dem", "3:deliver-attested-payload"],
          expectedOutcomeByPhaseKey: {},
          expectedErrorClassByPhaseKey: {},
          defaultReferenceLifecycle: { state: "finalized", independentlyResolvable: true },
        },
        vector.input,
      ).reasonCode,
    ).toBe("execution-authority");

    await expect(
      verifyEvidenceBoundFaultBundle(
        new Proxy(corpus.executionAuthorities["standard-completed"], {}) as any,
        deps,
      ),
    ).resolves.toMatchObject({ decision: "rejected", reasonCode: "execution-authority" });
    await expect(
      verifyEvidenceBoundFaultBundle(
        corpus.executionAuthorities["standard-completed"],
        new Proxy(deps, {}),
      ),
    ).rejects.toThrow(/plain data object/i);
  });

  it("produces cross-domain-safe copies and ranks EBFAB only after SEB validation", async () => {
    const seed = (label: string) =>
      Uint8Array.from(createHash("sha256").update(label).digest());
    const buyerSeed = seed("ebfab-producer-buyer");
    const sellerSeed = seed("ebfab-producer-seller");
    const buyerRaw = rawPublicKey(publicKeyFromSeed(buyerSeed));
    const sellerRaw = rawPublicKey(publicKeyFromSeed(sellerSeed));
    const buyerClaim = `demos:0x${Buffer.from(buyerRaw).toString("hex")}`;
    const sellerClaim = `demos:0x${Buffer.from(sellerRaw).toString("hex")}`;
    const session = {
      jobId: "ebfab-producer-job",
      outcome: "completed" as const,
      listingRef: { listingId: "listing-ebfab-producer", version: 1, contentHash: "a".repeat(64) },
      agreementRef: {
        anchor: { kind: "storage-program" as const, locator: "dacs3:commit:ebfab-producer-job" },
        contentHash: "b".repeat(64),
      },
      phaseSummary: [{ index: 0, kind: "commit-agreement" as const, outcome: "ok" as const }],
      vetRecords: [],
      settlementEvidence: [],
      recipeRegistryVersion: 1,
      railRegistryVersion: 1,
      finalisedAt: 1,
      buyer: {
        primaryClaim: buyerClaim,
        bundleHash: "c".repeat(64),
        signer: privateKeyFromSeed(buyerSeed),
      },
      seller: {
        primaryClaim: sellerClaim,
        bundleHash: "d".repeat(64),
        signer: privateKeyFromSeed(sellerSeed),
      },
    };
    const copies = await buildEvidenceBoundTwoSidedBundle(session, {
      validateEvidenceSet: async () => ({ decision: "verified" }),
    });
    expect(copies.buyerCopy?.evidenceBoundFaultBundleVersion).toBe("1");
    expect(copies.buyerCopy).not.toHaveProperty("faultBundleVersion");
    expect(
      deriveReputation(
        buyerClaim,
        [copies.buyerCopy!],
        { windowStart: 0, windowEnd: 2, computedAt: 2 },
        {
          trustBundles: true,
          trustBundlePartyRoles: true,
          copyAbsence: () => "absent",
        },
      ).bundleCount,
    ).toBe(0);
    expect(
      isEvidenceBoundFaultAttestationBundle({
        ...copies.buyerCopy,
        futureInertExtension: { preserved: true },
      }),
    ).toBe(true);
    expect(
      isEvidenceBoundFaultAttestationBundle({
        ...copies.buyerCopy,
        futureBundleVersion: "1",
      }),
    ).toBe(false);

    const keyByClaim = new Map([
      [buyerClaim, buyerRaw],
      [sellerClaim, sellerRaw],
    ]);
    const copyDeps = {
      resolvePublicKey: async (claim: string) => keyByClaim.get(claim) ?? null,
      verify: async (bytes: Uint8Array, signature: Uint8Array, publicKey: Uint8Array) =>
        ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
    };
    const withoutSeb = await verifyBundleCopy(copies.buyerCopy as any, "buyer", copyDeps);
    expect(withoutSeb).toMatchObject({ valid: false });
    expect((withoutSeb as any).reason).toMatch(/SEB-1\.\.SEB-6/i);
    const withSeb = await verifyBundleCopy(copies.buyerCopy as any, "buyer", {
      ...copyDeps,
      verifyEvidenceBound: async () => ({
        decision: "verified" as const,
        reasonCode: "ok" as const,
        reason: "verified by test authority",
      }),
    });
    expect(withSeb.valid).toBe(true);

    const replayedAsFab = {
      ...copies.buyerCopy,
      evidenceBoundFaultBundleVersion: undefined,
      faultBundleVersion: "1",
    };
    delete (replayedAsFab as any).evidenceBoundFaultBundleVersion;
    expect((await verifyBundleCopy(replayedAsFab as any, "buyer", copyDeps)).valid).toBe(false);

    const fab = await buildTwoSidedBundle(session);
    const selection = await selectAuthoritativeBundleCopy(
      {
        buyer: { disposition: "present", bundle: copies.buyerCopy as any },
        seller: { disposition: "present", bundle: fab.sellerCopy as any },
      },
      {
        isValid: async (bundle, role) =>
          (await verifyBundleCopy(bundle, role, {
            ...copyDeps,
            verifyEvidenceBound: async () => ({
              decision: "verified",
              reasonCode: "ok",
              reason: "verified by test authority",
            }),
          })).valid,
      },
    );
    expect(selection?.type).toBe("evidence-bound");
    await expect(
      buildEvidenceBoundTwoSidedBundle(session, {
        validateEvidenceSet: async () => ({ decision: "rejected", reason: "missing evidence" }),
      }),
    ).rejects.toThrow(/exact-set validation rejected/i);
  });
});

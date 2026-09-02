import { describe, expect, test } from "vitest";

import type { Signer } from "../../src/agent/signedArtifact.js";
import {
  verifyBundleCore,
  type VerifyBundleDeps,
} from "../../src/agent/verifyBundleCore.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import type { CompositeVerificationRecord } from "../../src/artifacts/types.js";
import { contentHash } from "../../src/canonical/index.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
  signedBytes,
} from "../../src/crypto/index.js";

const BUYER_SEED = Uint8Array.from(Buffer.alloc(32, 9));
const SELLER_SEED = Uint8Array.from(Buffer.alloc(32, 10));
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7E";
const OTHER_JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7F";

function signerFor(seed: Uint8Array): Signer {
  const priv = privateKeyFromSeed(seed);
  return (bytes) => ed25519Sign(bytes, priv);
}
function didFor(seed: Uint8Array): string {
  return `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
}

const buyerDid = didFor(BUYER_SEED);
const signBuyer = signerFor(BUYER_SEED);
const sellerDid = didFor(SELLER_SEED);
const signSeller = signerFor(SELLER_SEED);

// Mirrors Agent's production wiring: CCI == ed25519 pubkey hex embedded in DID.
const verify = (bytes: Uint8Array, sig: Uint8Array, pub: Uint8Array) =>
  ed25519Verify(bytes, sig, publicKeyFromRaw(pub));
function resolveFromDid(did: string): Uint8Array | null {
  const hex = did.match(/(?:^|:)(?:0x)?([0-9a-fA-F]{64})$/)?.[1];
  return hex ? Uint8Array.from(Buffer.from(hex, "hex")) : null;
}

const h = (c: string) => c.repeat(64);
const LISTING_ADDR = "stor-listing";

async function componentSignature(
  scope: Record<string, unknown>,
  separator: string,
  signer: string,
  sign: Signer,
) {
  return {
    algorithm: "ed25519" as const,
    signer,
    value: Buffer.from(
      await sign(signedBytes(separator, contentHash(scope))),
    ).toString("base64url"),
  };
}

async function agreementSignature(
  scope: Record<string, unknown>,
  party: string,
  sign: Signer,
) {
  return {
    party,
    algorithm: "ed25519" as const,
    value: Buffer.from(
      await sign(
        signedBytes(
          ARTIFACT_SEPARATORS.AgreementDocument,
          contentHash(scope),
        ),
      ),
    ).toString("base64url"),
  };
}

/** The authenticated session artifacts a real bundle references. */
async function buildArtifacts() {
  const listingScope = {
    dacsVersion: "1",
    listingVersion: 1,
    listingId: "svc",
    seller: {
      identity: {
        bundleVersion: "1",
        presentedBy: sellerDid,
        presentedAt: 1780000000000,
        claims: [{ ref: sellerDid }],
        presentation: {
          kind: "per-claim",
          signatures: [{ ref: sellerDid, signature: "identity-proof" }],
        },
      },
      displayName: "Market Data",
      publicEndpoint: "https://seller.example/dacs",
    },
    offering: {
      title: "Market Data",
      description: "Signed market-data payload",
      category: "data.finance",
      tags: ["market-data"],
      deliverable: {
        kind: "attested-payload",
        payloadFormat: "application/json",
        verificationMethod: { kind: "self-signed" },
      },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-agreement" },
      { kind: "pay-x402", parameters: { rail: "x402:default" } },
      { kind: "deliver-attested-payload" },
    ],
    pricing: { kind: "fixed", price: { amount: "1", currency: "USDC" } },
    acceptedRails: [{ railId: "x402:default" }],
    terms: { deadlineSecAfterCommit: 600 },
    validity: { notBefore: 1779999999000 },
  };
  const listing = {
    ...listingScope,
    signature: await componentSignature(
      listingScope,
      ARTIFACT_SEPARATORS.Listing,
      sellerDid,
      signSeller,
    ),
  };
  const agreementScope = {
    agreementVersion: "1",
    jobId: JOB_ID,
    listingRef: {
      listingId: listing.listingId,
      version: 1,
      contentHash: contentHash(listing),
    },
    parties: [
      {
        role: "buyer",
        bundleHash: h("c"),
        primaryClaim: buyerDid,
        vetRecordRef: {
          anchor: { kind: "storage-program", locator: "buyer-vet-j1" },
          contentHash: h("1"),
        },
      },
      {
        role: "seller",
        bundleHash: h("d"),
        primaryClaim: sellerDid,
        vetRecordRef: {
          anchor: { kind: "storage-program", locator: "seller-vet-j1" },
          contentHash: h("2"),
        },
      },
    ],
    terms: {
      deliverable: { deliverableType: "attested-payload", hash: h("3") },
      price: { amount: "1", currency: "USDC" },
      rail: { railId: "x402:default" },
      deadline: 1780000600000,
    },
    derivedFromPattern: "fixed-price",
    generatedAt: 1780000000000,
  };
  const agreement = {
    ...agreementScope,
    signatures: [
      await agreementSignature(agreementScope, buyerDid, signBuyer),
      await agreementSignature(agreementScope, sellerDid, signSeller),
    ],
  };
  const evidenceScope = {
    evidenceVersion: "1",
    jobId: JOB_ID,
    phase: "pay-x402",
    outcome: "success",
    paymentTxRefs: [
      {
        kind: "x402",
        httpResource: "https://seller.example/pay",
        paymentReceiptHash: h("e"),
        settlementTxHash: "0xabc",
        chainId: 84532,
        protocolVersion: "1",
      },
    ],
    paymentAmount: { amount: "1000000", currency: "USDC" },
    settlementFinality: {
      model: "provider-receipt",
      finalityObservedAt: 1780000000000,
    },
    observedAt: 1780000000000,
  };
  const evidence = {
    ...evidenceScope,
    signature: await componentSignature(
      evidenceScope,
      ARTIFACT_SEPARATORS.SettlementEvidence,
      buyerDid,
      signBuyer,
    ),
  };
  return { listing, agreement, evidence };
}

function buildLegacyMvpListing() {
  return {
    agentId: sellerDid,
    serviceId: "svc",
    name: "Market Data",
    description: "Historical reduced Listing",
    claimRequirements: [],
    supportedNegotiation: ["negotiate-fixed-price"],
    supportedPaymentRails: ["pay-x402"],
    supportedDelivery: ["deliver-attested-payload"],
  };
}

interface Fixture {
  bundle: Record<string, unknown>;
  listing: Record<string, unknown>;
  agreement: Record<string, unknown>;
  evidence: Record<string, unknown>;
}

/** Build a spec bundle whose refs content-address the resolvable artifacts. */
async function buildFixture(party: string, sign: Signer): Promise<Fixture> {
  const { listing, agreement, evidence } = await buildArtifacts();
  const body: Record<string, unknown> = {
    bundleVersion: "1",
    jobId: JOB_ID,
    outcome: "completed",
    anchoredByRole: "buyer",
    listingRef: {
      listingId: listing.listingId,
      version: 1,
      contentHash: contentHash(listing),
    },
    agreementRef: {
      anchor: { kind: "storage-program", locator: "agreement-j1" },
      contentHash: contentHash(agreement),
    },
    parties: [
      { role: "buyer", bundleHash: h("c"), primaryClaim: party },
      { role: "seller", bundleHash: h("d"), primaryClaim: sellerDid },
    ],
    phaseSummary: [],
    vetRecords: [],
    settlementEvidence: [
      {
        anchor: { kind: "storage-program", locator: "settlement-j1" },
        contentHash: contentHash(evidence),
      },
    ],
    recipeRegistryVersion: 1,
    railRegistryVersion: 1,
    finalisedAt: 1780000000000,
  };
  const scope = { ...body };
  delete scope["anchoredByRole"];
  const sig = await sign(
    signedBytes(ARTIFACT_SEPARATORS.AttestationBundle, contentHash(scope)),
  );
  const sellerSig = await signSeller(
    signedBytes(ARTIFACT_SEPARATORS.AttestationBundle, contentHash(scope)),
  );
  const bundle = {
    ...body,
    signatures: [
      { party, algorithm: "ed25519", value: Buffer.from(sig).toString("base64url") },
      { party: sellerDid, algorithm: "ed25519", value: Buffer.from(sellerSig).toString("base64url") },
    ],
  };
  return { bundle, listing, agreement, evidence };
}

async function resignFixture(fx: Fixture, signers: Array<{ party: string; sign: Signer }>): Promise<void> {
  const scope = { ...fx.bundle };
  delete scope["signatures"];
  delete scope["anchoredByRole"];
  const separator = fx.bundle.faultBundleVersion === "1"
    ? ARTIFACT_SEPARATORS.FaultAttestationBundle
    : ARTIFACT_SEPARATORS.AttestationBundle;
  fx.bundle.signatures = await Promise.all(
    signers.map(async ({ party, sign }) => ({
      party,
      algorithm: "ed25519",
      value: Buffer.from(
        await sign(signedBytes(separator, contentHash(scope))),
      ).toString("base64url"),
    })),
  );
}

async function resignAgreement(
  fx: Fixture,
  signers: Array<{ party: string; sign: Signer }> = [
    { party: buyerDid, sign: signBuyer },
    { party: sellerDid, sign: signSeller },
  ],
): Promise<void> {
  const scope = { ...fx.agreement };
  delete scope.signatures;
  fx.agreement.signatures = await Promise.all(
    signers.map(({ party, sign }) => agreementSignature(scope, party, sign)),
  );
}

async function convertToAlternativePaymentFixture(fx: Fixture): Promise<void> {
  const listingScope = structuredClone(fx.listing);
  delete listingScope.signature;
  listingScope.pipeline = [
    { kind: "negotiate-fixed-price" },
    { kind: "commit-agreement" },
    {
      kind: "pay-alternative",
      parameters: {
        alternatives: [
          { railId: "x402:default", railVersion: 1 },
          { railId: "demos-native:DEM", railVersion: 1 },
        ],
      },
    },
    { kind: "deliver-attested-payload" },
  ];
  listingScope.acceptedRails = [
    { railId: "x402:default", railVersion: 1 },
    { railId: "demos-native:DEM", railVersion: 1 },
  ];
  fx.listing = {
    ...listingScope,
    signature: await componentSignature(
      listingScope,
      ARTIFACT_SEPARATORS.Listing,
      sellerDid,
      signSeller,
    ),
  };
  (fx.agreement.listingRef as Record<string, unknown>).contentHash =
    contentHash(fx.listing);
  await resignAgreement(fx);
  (fx.bundle.listingRef as Record<string, unknown>).contentHash =
    contentHash(fx.listing);
  (fx.bundle.agreementRef as Record<string, unknown>).contentHash =
    contentHash(fx.agreement);
  await resignFixture(fx, [
    { party: buyerDid, sign: signBuyer },
    { party: sellerDid, sign: signSeller },
  ]);
}

async function buildLegacyMvpAbortFixture() {
  const listingScope = buildLegacyMvpListing();
  const listing = {
    ...listingScope,
    signature: await componentSignature(
      listingScope,
      ARTIFACT_SEPARATORS.Listing,
      sellerDid,
      signSeller,
    ),
  };
  const body: Record<string, unknown> = {
    bundleVersion: "1",
    jobId: "legacy-job",
    outcome: "aborted-by-self",
    listingRef: {
      listingId: listing.serviceId,
      version: 1,
      contentHash: contentHash(listing),
    },
    parties: [
      { role: "buyer", bundleHash: h("c"), primaryClaim: buyerDid },
      { role: "seller", bundleHash: h("d"), primaryClaim: sellerDid },
    ],
    phaseSummary: [],
    vetRecords: [],
    settlementEvidence: [],
    recipeRegistryVersion: 1,
    railRegistryVersion: 1,
    finalisedAt: 1780000000000,
  };
  const signature = await signBuyer(
    signedBytes(ARTIFACT_SEPARATORS.AttestationBundle, contentHash(body)),
  );
  const bundle: Record<string, unknown> = {
    ...body,
    signatures: [
      {
        party: buyerDid,
        algorithm: "ed25519",
        value: Buffer.from(signature).toString("base64url"),
      },
    ],
  };
  return { listing, bundle };
}

/** Wire deps that resolve the fixture's artifacts (overridable per test). */
function depsFor(
  fx: Fixture,
  opts: {
    resolve?: (did: string) => Uint8Array | null;
    resolveAttestationRef?: VerifyBundleDeps["resolveAttestationRef"];
    resolveListingRef?: VerifyBundleDeps["resolveListingRef"];
    resolveRef?: VerifyBundleDeps["resolveRef"];
    listing?: Record<string, unknown> | null;
    verifyEvidence?: VerifyBundleDeps["verifyEvidence"] | null;
    verifyAlternativePaymentProjection?: VerifyBundleDeps["verifyAlternativePaymentProjection"];
    verifyCompositeRecord?: VerifyBundleDeps["verifyCompositeRecord"];
  } = {},
): VerifyBundleDeps {
  const listing = opts.listing === undefined ? fx.listing : opts.listing;
  const verifyEvidence =
    opts.verifyEvidence === undefined
      ? async () => ({
          decision: "pass" as const,
          authorizedSigner: buyerDid,
        })
      : opts.verifyEvidence;
  return {
    readArtifact: async (ref) =>
      ref === LISTING_ADDR ? listing : fx.bundle,
    resolveAttestationRef:
      opts.resolveAttestationRef ??
      (async (ref) =>
        ref.anchor.locator === "agreement-j1"
          ? fx.agreement
          : ref.anchor.locator === "settlement-j1"
            ? fx.evidence
            : null),
    resolveListingRef:
      opts.resolveListingRef ?? (async () => listing),
    ...(opts.resolveRef ? { resolveRef: opts.resolveRef } : {}),
    resolvePublicKey: async (did) => (opts.resolve ?? resolveFromDid)(did),
    verify,
    ...(verifyEvidence ? { verifyEvidence } : {}),
    ...(opts.verifyAlternativePaymentProjection
      ? {
          verifyAlternativePaymentProjection:
            opts.verifyAlternativePaymentProjection,
        }
      : {}),
    ...(opts.verifyCompositeRecord
      ? { verifyCompositeRecord: opts.verifyCompositeRecord }
      : {}),
  };
}

describe("verifyBundleCore (DACS-5 bundle signature + ref integrity)", () => {
  test("happy path: signature verifies and every ref resolves + hash-matches", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const res = await verifyBundleCore("ref", depsFor(fx));
    expect(res.ok).toBe(true);
    expect(res.fullyVerified).toBe(true);
    expect(res.signatures).toEqual([
      { party: buyerDid, verdict: "valid" },
      { party: sellerDid, verdict: "valid" },
    ]);
    expect(res.refs.every((r) => r.verdict === "ok")).toBe(true);
    expect(res.bundle?.outcome).toBe("completed");
  });

  test("does not reinterpret Ed25519 bytes under another algorithm label", async () => {
    const baseline = await buildFixture(buyerDid, signBuyer);
    const baselineResolved: string[] = [];
    const baselineResult = await verifyBundleCore("ref", depsFor(baseline, {
      resolve: (claim) => {
        baselineResolved.push(claim);
        return resolveFromDid(claim);
      },
    }));
    expect(baselineResult.ok).toBe(true);

    const fx = await buildFixture(buyerDid, signBuyer);
    const signatures = fx.bundle.signatures as Array<Record<string, unknown>>;
    signatures[0]!.algorithm = "ecdsa-secp256k1";
    const resolved: string[] = [];

    const res = await verifyBundleCore("ref", depsFor(fx, {
      resolve: (claim) => {
        resolved.push(claim);
        return resolveFromDid(claim);
      },
    }));

    expect(res.ok).toBe(false);
    expect(res.fullyVerified).toBe(false);
    expect(res.signatures).toContainEqual({ party: buyerDid, verdict: "invalid" });
    expect(resolved.filter((claim) => claim === buyerDid)).toHaveLength(
      baselineResolved.filter((claim) => claim === buyerDid).length - 1,
    );
  });

  test("rejects a cryptographically valid abort signed by a non-party", async () => {
    const outsiderSeed = Uint8Array.from(Buffer.alloc(32, 44));
    const outsiderDid = didFor(outsiderSeed);
    const fx = await buildFixture(buyerDid, signBuyer);
    fx.bundle.outcome = "aborted-by-other";
    delete fx.bundle.agreementRef;
    fx.bundle.settlementEvidence = [];
    await resignFixture(fx, [{ party: outsiderDid, sign: signerFor(outsiderSeed) }]);

    const res = await verifyBundleCore("ref", depsFor(fx));

    expect(res.ok).toBe(false);
    expect(res.fullyVerified).toBe(false);
    expect(res.signatures).toEqual([{ party: outsiderDid, verdict: "invalid" }]);
    expect(res.reason).toMatch(/signature/i);
  });

  test("matches agreement and bundle signers by CF-3 identity", async () => {
    const qualifiedBuyer = `${buyerDid}?region=GB`;
    const qualifiedSignature = `${buyerDid}?session=checkout`;
    const fx = await buildFixture(buyerDid, signBuyer);
    const agreementParties = fx.agreement.parties as Array<Record<string, unknown>>;
    agreementParties[0]!.primaryClaim = qualifiedBuyer;
    await resignAgreement(fx, [
      { party: qualifiedBuyer, sign: signBuyer },
      { party: sellerDid, sign: signSeller },
    ]);
    (fx.bundle.agreementRef as { contentHash: string }).contentHash =
      contentHash(fx.agreement);
    await resignFixture(fx, [
      { party: qualifiedSignature, sign: signBuyer },
      { party: sellerDid, sign: signSeller },
    ]);
    const resolvedClaims: string[] = [];

    const res = await verifyBundleCore("ref", depsFor(fx, {
      resolve: (claim) => {
        resolvedClaims.push(claim);
        return claim === buyerDid
          ? resolveFromDid(buyerDid)
          : resolveFromDid(claim);
      },
    }));

    expect(res.ok).toBe(true);
    expect(res.fullyVerified).toBe(true);
    expect(res.signatures).toContainEqual({
      party: qualifiedSignature,
      verdict: "valid",
    });
    expect(resolvedClaims).toContain(buyerDid);
    expect(resolvedClaims).not.toContain(qualifiedSignature);
  });

  test("matches a referenced component signer by CF-3 identity", async () => {
    const qualifiedBuyer = `${buyerDid}?purpose=settlement`;
    const fx = await buildFixture(buyerDid, signBuyer);
    const evidenceScope = { ...fx.evidence };
    delete evidenceScope.signature;
    fx.evidence = {
      ...evidenceScope,
      signature: await componentSignature(
        evidenceScope,
        ARTIFACT_SEPARATORS.SettlementEvidence,
        qualifiedBuyer,
        signBuyer,
      ),
    };
    (
      fx.bundle.settlementEvidence as Array<{ contentHash: string }>
    )[0]!.contentHash = contentHash(fx.evidence);
    await resignFixture(fx, [
      { party: buyerDid, sign: signBuyer },
      { party: sellerDid, sign: signSeller },
    ]);
    const resolvedClaims: string[] = [];

    const result = await verifyBundleCore("ref", depsFor(fx, {
      resolve: (claim) => {
        resolvedClaims.push(claim);
        return resolveFromDid(claim);
      },
    }));

    expect(result.ok).toBe(true);
    expect(
      result.refs.find((ref) => ref.kind === "dacs-4-evidence"),
    ).toMatchObject({
      verdict: "ok",
      signature: { verdict: "valid", signers: [qualifiedBuyer] },
    });
    expect(resolvedClaims).toContain(buyerDid);
    expect(resolvedClaims).not.toContain(qualifiedBuyer);
  });

  test("a custom key resolver cannot authorize non-CF-2 signer bytes", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const uppercaseBuyer = `DID:${buyerDid.slice(4)}`;
    (fx.bundle.parties as Array<{ primaryClaim: string }>)[0]!.primaryClaim =
      uppercaseBuyer;
    (fx.agreement.parties as Array<{ primaryClaim: string }>)[0]!.primaryClaim =
      uppercaseBuyer;
    (fx.bundle.agreementRef as { contentHash: string }).contentHash =
      contentHash(fx.agreement);
    await resignFixture(fx, [
      { party: uppercaseBuyer, sign: signBuyer },
      { party: sellerDid, sign: signSeller },
    ]);
    const resolvedClaims: string[] = [];

    const res = await verifyBundleCore("ref", depsFor(fx, {
      // Deliberately unsafe suffix resolver: the verifier must not call it for
      // the uppercase signed bytes, even though it could return the right key.
      resolve: (claim) => {
        resolvedClaims.push(claim);
        return resolveFromDid(claim);
      },
    }));

    expect(res.ok).toBe(false);
    expect(res.fullyVerified).toBe(false);
    expect(res.reason).toMatch(/non-canonical ClaimReference/i);
    expect(res.signatures).toContainEqual({
      party: uppercaseBuyer,
      verdict: "unverified",
    });
    expect(resolvedClaims).not.toContain(uppercaseBuyer);
  });

  test("non-CF-2 signer bytes hidden in a phase attestation ref fail closed", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    fx.bundle.phaseSummary = [{
      index: 0,
      kind: "negotiate-fixed-price",
      outcome: "ok",
      attestationRef: {
        anchor: { kind: "storage-program", locator: "phase-attestation" },
        contentHash: h("f"),
        signer: `did:demos:agent:${buyerDid.slice("did:demos:agent:".length).toUpperCase()}`,
      },
    }];
    await resignFixture(fx, [
      { party: buyerDid, sign: signBuyer },
      { party: sellerDid, sign: signSeller },
    ]);

    const res = await verifyBundleCore("ref", depsFor(fx));
    expect(res.ok).toBe(false);
    expect(res.fullyVerified).toBe(false);
    expect(res.reason).toMatch(/non-canonical ClaimReference/i);
  });

  test.each([
    ["listing", "dacs-1-listing"],
    ["agreement", "dacs-3-agreement"],
    ["evidence", "dacs-4-evidence"],
  ] as const)(
    "unsigned referenced %s is reported as signature-missing",
    async (artifactName, kind) => {
      const fx = await buildFixture(buyerDid, signBuyer);
      if (artifactName === "agreement") delete fx.agreement.signatures;
      else delete fx[artifactName].signature;

      const result = await verifyBundleCore("ref", depsFor(fx));
      expect(result.ok).toBe(false);
      expect(result.refs.find((ref) => ref.kind === kind)).toMatchObject({
        verdict: "signature-missing",
        signature: { verdict: "missing" },
      });
    },
  );

  test("agreement authentication requires the exact buyer and seller", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    fx.agreement.signatures = (
      fx.agreement.signatures as Array<{ party: string }>
    ).filter((signature) => signature.party === buyerDid);

    const result = await verifyBundleCore("ref", depsFor(fx));
    expect(result.ok).toBe(false);
    expect(
      result.refs.find((ref) => ref.kind === "dacs-3-agreement"),
    ).toMatchObject({
      verdict: "signature-missing",
      signature: {
        verdict: "missing",
        reason: expect.stringContaining(sellerDid),
      },
    });
  });

  test("referenced artifacts reject a signer outside the authorised role", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    (fx.listing.signature as Record<string, unknown>).signer = buyerDid;
    (fx.evidence.signature as Record<string, unknown>).signer =
      `did:demos:agent:${"11".repeat(32)}`;

    const result = await verifyBundleCore("ref", depsFor(fx));
    expect(result.ok).toBe(false);
    for (const kind of ["dacs-1-listing", "dacs-4-evidence"]) {
      expect(result.refs.find((ref) => ref.kind === kind)).toMatchObject({
        verdict: "signature-invalid",
        signature: { verdict: "invalid", reason: "signer-not-authorized" },
      });
    }
  });

  test("malformed, unresolved, and tampered reference signatures stay distinct", async () => {
    const malformed = await buildFixture(buyerDid, signBuyer);
    (malformed.evidence.signature as Record<string, unknown>).value = "***";
    const malformedResult = await verifyBundleCore("ref", depsFor(malformed));
    expect(
      malformedResult.refs.find((ref) => ref.kind === "dacs-4-evidence"),
    ).toMatchObject({
      verdict: "signature-malformed",
      signature: { verdict: "malformed" },
    });

    const unresolved = await buildFixture(buyerDid, signBuyer);
    const unresolvedResult = await verifyBundleCore(
      "ref",
      depsFor(unresolved, {
        resolve: (did) => (did === buyerDid ? null : resolveFromDid(did)),
      }),
    );
    expect(
      unresolvedResult.refs.find((ref) => ref.kind === "dacs-4-evidence"),
    ).toMatchObject({
      verdict: "signature-unresolved",
      signature: { verdict: "unresolved", reason: "signer-key-not-found" },
    });

    const tampered = await buildFixture(buyerDid, signBuyer);
    (tampered.evidence.signature as Record<string, unknown>).value = Buffer.alloc(
      64,
      0xff,
    ).toString("base64url");
    const tamperedResult = await verifyBundleCore("ref", depsFor(tampered));
    expect(
      tamperedResult.refs.find((ref) => ref.kind === "dacs-4-evidence"),
    ).toMatchObject({
      verdict: "signature-invalid",
      signature: {
        verdict: "invalid",
        reason: "cryptographic-verification-failed",
      },
    });
  });

  test("settlement evidence requires an authenticated exact phase orchestrator", async () => {
    const missingContext = await buildFixture(buyerDid, signBuyer);
    (
      missingContext.bundle.settlementEvidence as Array<{
        signer?: string;
      }>
    )[0]!.signer = buyerDid;
    await resignFixture(missingContext, [
      { party: buyerDid, sign: signBuyer },
      { party: sellerDid, sign: signSeller },
    ]);
    const missingResult = await verifyBundleCore(
      "ref",
      depsFor(missingContext, { verifyEvidence: null }),
    );
    expect(
      missingResult.refs.find((ref) => ref.kind === "dacs-4-evidence"),
    ).toMatchObject({
      verdict: "signature-unresolved",
      signature: {
        verdict: "unresolved",
        reason: "authorization-unresolved",
      },
    });

    const wrongRole = await buildFixture(buyerDid, signBuyer);
    const evidenceScope = { ...wrongRole.evidence };
    delete evidenceScope.signature;
    wrongRole.evidence = {
      ...evidenceScope,
      signature: await componentSignature(
        evidenceScope,
        ARTIFACT_SEPARATORS.SettlementEvidence,
        sellerDid,
        signSeller,
      ),
    };
    const wrongRoleResult = await verifyBundleCore("ref", depsFor(wrongRole));
    expect(
      wrongRoleResult.refs.find((ref) => ref.kind === "dacs-4-evidence"),
    ).toMatchObject({
      verdict: "signature-invalid",
      signature: { verdict: "invalid", reason: "signer-not-authorized" },
    });
  });

  test("normative graph rejects a hash-matched legacy MVP Listing", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const legacyListing = buildLegacyMvpListing();
    const legacyHash = contentHash(legacyListing);
    (fx.agreement.listingRef as { contentHash: string }).contentHash = legacyHash;
    (fx.bundle.listingRef as { contentHash: string }).contentHash = legacyHash;
    await resignAgreement(fx);
    (fx.bundle.agreementRef as { contentHash: string }).contentHash =
      contentHash(fx.agreement);
    await resignFixture(fx, [
      { party: buyerDid, sign: signBuyer },
      { party: sellerDid, sign: signSeller },
    ]);

    const result = await verifyBundleCore(
      "ref",
      depsFor(fx, { listing: legacyListing }),
    );
    expect(
      result.refs.find((ref) => ref.kind === "dacs-3-agreement")?.verdict,
    ).toBe("ok");
    expect(
      result.refs.find((ref) => ref.kind === "dacs-1-listing")?.verdict,
    ).toBe("invalid-shape");
    expect(result.ok).toBe(false);
  });

  test("snapshots the signed bundle before any asynchronous callback", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    fx.bundle.vetRecords = [
      {
        anchor: { kind: "storage-program", locator: "missing-vet" },
        contentHash: h("f"),
      },
    ];
    await resignFixture(fx, [
      { party: buyerDid, sign: signBuyer },
      { party: sellerDid, sign: signSeller },
    ]);
    const mutableBundle = fx.bundle;
    const result = await verifyBundleCore("ref", {
      ...depsFor(fx, {
        resolveAttestationRef: async (ref) =>
          ref.anchor.locator === "agreement-j1"
            ? fx.agreement
            : ref.anchor.locator === "settlement-j1"
              ? fx.evidence
              : null,
      }),
      readArtifact: async (ref) =>
        ref === LISTING_ADDR ? fx.listing : mutableBundle,
      resolvePublicKey: async (did) => {
        (mutableBundle.vetRecords as unknown[]).length = 0;
        await Promise.resolve();
        return resolveFromDid(did);
      },
    });
    expect(result.ok).toBe(false);
    expect(
      result.refs.find((entry) => entry.kind === "dacs-2-composite"),
    ).toMatchObject({ id: "missing-vet", verdict: "missing" });
  });

  test("rejects callback-owned non-wire artifacts before snapshot normalisation", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const inheritedBundle = Object.assign(
      Object.create({ inherited: true }) as Record<string, unknown>,
      fx.bundle,
    );
    const result = await verifyBundleCore("ref", {
      ...depsFor(fx),
      readArtifact: async (ref) =>
        ref === LISTING_ADDR ? fx.listing : inheritedBundle,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not an attestation bundle/i);
  });

  test("a current vet ref requires strict closure and binds its exact returned record", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const composite: CompositeVerificationRecord = {
      recordVersion: "1",
      jobId: JOB_ID,
      evaluatedParty: sellerDid,
      bundleHash: h("d"),
      requirementHash: h("f"),
      freshness: [],
      supplementary: [],
      dealSpecific: [],
      overallDecision: "pass",
      generatedAt: 1780000000000,
      signature: {
        algorithm: "ed25519",
        signer: buyerDid,
        value: "AA",
      },
    };
    fx.bundle.vetRecords = [
      {
        anchor: { kind: "storage-program", locator: "vet-j1" },
        contentHash: contentHash(composite as unknown as Record<string, unknown>),
      },
    ];
    await resignFixture(fx, [
      { party: buyerDid, sign: signBuyer },
      { party: sellerDid, sign: signSeller },
    ]);
    const resolveAttestationRef: VerifyBundleDeps["resolveAttestationRef"] =
      async (ref) =>
        ref.anchor.locator === "vet-j1"
          ? (composite as unknown as Record<string, unknown>)
          : ref.anchor.locator === "agreement-j1"
            ? fx.agreement
            : ref.anchor.locator === "settlement-j1"
              ? fx.evidence
              : null;

    const withoutClosure = await verifyBundleCore(
      "ref",
      depsFor(fx, { resolveAttestationRef }),
    );
    expect(
      withoutClosure.refs.find((entry) => entry.kind === "dacs-2-composite"),
    ).toMatchObject({ verdict: "invalid-vet-record" });

    const withClosure = await verifyBundleCore(
      "ref",
      depsFor(fx, {
        resolveAttestationRef,
        verifyCompositeRecord: async (record) => ({
          status: "valid",
          record,
          freshness: [],
          dealSpecific: [],
          freshnessRecipes: [],
          dealSpecificRecipes: [],
        }),
      }),
    );
    expect(withClosure.ok).toBe(true);

    const nonWireClosure = await verifyBundleCore(
      "ref",
      depsFor(fx, {
        resolveAttestationRef,
        verifyCompositeRecord: async (record) =>
          Object.assign(Object.create({ inherited: true }), {
            status: "valid",
            record,
            freshness: [],
            dealSpecific: [],
            freshnessRecipes: [],
            dealSpecificRecipes: [],
          }) as never,
      }),
    );
    expect(
      nonWireClosure.refs.find(
        (entry) => entry.kind === "dacs-2-composite",
      ),
    ).toMatchObject({ verdict: "invalid-vet-record" });

    for (const replay of [
      { jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7F" },
      { evaluatedParty: buyerDid },
      { bundleHash: h("c") },
    ]) {
      const replayed = { ...composite, ...replay };
      const vetRecords = fx.bundle.vetRecords as Array<{ contentHash: string }>;
      vetRecords[0]!.contentHash = contentHash(
        replayed as unknown as Record<string, unknown>,
      );
      await resignFixture(fx, [
        { party: buyerDid, sign: signBuyer },
        { party: sellerDid, sign: signSeller },
      ]);
      const replayResult = await verifyBundleCore(
        "ref",
        depsFor(fx, {
          resolveAttestationRef: async (ref) =>
            ref.anchor.locator === "vet-j1"
              ? (replayed as unknown as Record<string, unknown>)
              : ref.anchor.locator === "agreement-j1"
                ? fx.agreement
                : ref.anchor.locator === "settlement-j1"
                  ? fx.evidence
                  : null,
          verifyCompositeRecord: async (record) => ({
            status: "valid",
            record,
            freshness: [],
            dealSpecific: [],
            freshnessRecipes: [],
            dealSpecificRecipes: [],
          }),
        }),
      );
      expect(
        replayResult.refs.find(
          (entry) => entry.kind === "dacs-2-composite",
        ),
      ).toMatchObject({ verdict: "invalid-vet-record" });
    }

    const restoredVetRefs = fx.bundle.vetRecords as Array<{ contentHash: string }>;
    restoredVetRefs[0]!.contentHash = contentHash(
      composite as unknown as Record<string, unknown>,
    );
    await resignFixture(fx, [
      { party: buyerDid, sign: signBuyer },
      { party: sellerDid, sign: signSeller },
    ]);

    const substituted = {
      ...composite,
      generatedAt: composite.generatedAt + 1,
    };
    const wrongClosure = await verifyBundleCore(
      "ref",
      depsFor(fx, {
        resolveAttestationRef,
        verifyCompositeRecord: async () => ({
          status: "valid",
          record: substituted,
          freshness: [],
          dealSpecific: [],
          freshnessRecipes: [],
          dealSpecificRecipes: [],
        }),
      }),
    );
    expect(
      wrongClosure.refs.find((entry) => entry.kind === "dacs-2-composite"),
    ).toMatchObject({ verdict: "invalid-vet-record" });

    composite.overallDecision = "fail";
    const vetRecords = fx.bundle.vetRecords as Array<{ contentHash: string }>;
    vetRecords[0]!.contentHash = contentHash(
      composite as unknown as Record<string, unknown>,
    );
    await resignFixture(fx, [
      { party: buyerDid, sign: signBuyer },
      { party: sellerDid, sign: signSeller },
    ]);
    const completedWithFailedVet = await verifyBundleCore(
      "ref",
      depsFor(fx, {
        resolveAttestationRef,
        verifyCompositeRecord: async (record) => ({
          status: "valid",
          record,
          freshness: [],
          dealSpecific: [],
          freshnessRecipes: [],
          dealSpecificRecipes: [],
        }),
      }),
    );
    expect(
      completedWithFailedVet.refs.find(
        (entry) => entry.kind === "dacs-2-composite",
      ),
    ).toMatchObject({ verdict: "invalid-vet-record" });
    expect(completedWithFailedVet.ok).toBe(false);
  });

  test("an explicitly readable legacy vet record cannot satisfy finalisation", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const legacy = {
      subject: sellerDid,
      recipeId: "legacy",
      recipeVersion: "0.1",
      results: [
        { claimRef: sellerDid, method: "self-signed", status: "pass" },
      ],
      decision: "pass",
      verifiedAt: "2026-01-01T00:00:00Z",
    };
    fx.bundle.vetRecords = [
      {
        anchor: { kind: "storage-program", locator: "legacy-vet-j1" },
        contentHash: contentHash(legacy),
      },
    ];
    await resignFixture(fx, [
      { party: buyerDid, sign: signBuyer },
      { party: sellerDid, sign: signSeller },
    ]);
    let closureCalls = 0;
    const result = await verifyBundleCore(
      "ref",
      depsFor(fx, {
        resolveAttestationRef: async (ref) =>
          ref.anchor.locator === "legacy-vet-j1"
            ? legacy
            : ref.anchor.locator === "agreement-j1"
              ? fx.agreement
              : ref.anchor.locator === "settlement-j1"
                ? fx.evidence
                : null,
        verifyCompositeRecord: async (record) => {
          closureCalls += 1;
          return {
            status: "valid",
            record,
            freshness: [],
            dealSpecific: [],
            freshnessRecipes: [],
            dealSpecificRecipes: [],
          };
        },
      }),
    );
    expect(
      result.refs.find((entry) => entry.kind === "dacs-2-composite"),
    ).toMatchObject({ verdict: "invalid-shape" });
    expect(closureCalls).toBe(0);
    expect(result.ok).toBe(false);
  });

  test("v0.3 FaultAttestationBundle verifies under its distinct domain", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    delete fx.bundle.bundleVersion;
    fx.bundle.faultBundleVersion = "1";
    fx.bundle.faultedParty = "none";
    await resignFixture(fx, [
      { party: buyerDid, sign: signBuyer },
      { party: sellerDid, sign: signSeller },
    ]);
    const res = await verifyBundleCore("ref", depsFor(fx));
    expect(res.ok).toBe(true);
    expect(res.bundle).toMatchObject({ faultBundleVersion: "1", faultedParty: "none" });
  });

  test("fault-bundle discriminator and permissible fault fail closed", async () => {
    const both = await buildFixture(buyerDid, signBuyer);
    both.bundle.faultBundleVersion = "1";
    expect((await verifyBundleCore("ref", depsFor(both))).reason).toMatch(/not an attestation bundle/i);

    const invalid = await buildFixture(buyerDid, signBuyer);
    delete invalid.bundle.bundleVersion;
    invalid.bundle.faultBundleVersion = "1";
    invalid.bundle.faultedParty = "buyer";
    await resignFixture(invalid, [
      { party: buyerDid, sign: signBuyer },
      { party: sellerDid, sign: signSeller },
    ]);
    const result = await verifyBundleCore("ref", depsFor(invalid));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/faultedParty/);
  });

  test("legacy-domain signatures cannot replay as fault-bundle signatures", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    delete fx.bundle.bundleVersion;
    fx.bundle.faultBundleVersion = "1";
    fx.bundle.faultedParty = "none";
    const scope = { ...fx.bundle };
    delete scope.signatures;
    delete scope.anchoredByRole;
    const legacyMessage = signedBytes(ARTIFACT_SEPARATORS.AttestationBundle, contentHash(scope));
    fx.bundle.signatures = [
      { party: buyerDid, algorithm: "ed25519", value: Buffer.from(await signBuyer(legacyMessage)).toString("base64url") },
      { party: sellerDid, algorithm: "ed25519", value: Buffer.from(await signSeller(legacyMessage)).toString("base64url") },
    ];
    const result = await verifyBundleCore("ref", depsFor(fx));
    expect(result.ok).toBe(false);
    expect(result.signatures.every((entry) => entry.verdict === "invalid")).toBe(true);
  });

  test("tampered bundle body => signature invalid, not ok", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    fx.bundle.outcome = "failed-substrate"; // mutate a signed-scope field after signing
    const res = await verifyBundleCore("ref", depsFor(fx));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/signature/);
    expect(res.signatures[0]?.verdict).toBe("invalid");
  });

  test("unresolvable signer => unverified, not ok (never falsely valid)", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const res = await verifyBundleCore("ref", depsFor(fx, { resolve: () => null }));
    expect(res.ok).toBe(false);
    expect(res.fullyVerified).toBe(false);
    expect(res.signatures[0]?.verdict).toBe("unverified");
  });

  test("malformed signer key => error, not a false-negative invalid (§10.4.1)", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const res = await verifyBundleCore(
      "ref",
      depsFor(fx, { resolve: () => new Uint8Array(16) }),
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/malformed/);
    expect(res.signatures[0]?.verdict).toBe("error");
  });

  test("tampered referenced artifact => hash-mismatch, not ok", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    // The signed evidence the bundle points at is altered after the fact: its
    // content hash no longer matches the ref, even though the bundle signature
    // is still valid. Tamper a benign field (observedAt) so the artifact stays a
    // structurally-valid SettlementEvidence and the mismatch surfaces as a
    // hash-mismatch — NOT invalid-shape (flipping outcome→failure would also
    // strip the required finality and trip the shape check first, §9.7).
    fx.evidence.observedAt = 1780000000001;
    const res = await verifyBundleCore("ref", depsFor(fx));
    expect(res.signatures[0]?.verdict).toBe("valid");
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/referenced artifact/);
    const ev = res.refs.find((r) => r.kind === "dacs-4-evidence");
    expect(ev?.verdict).toBe("hash-mismatch");
  });

  test("hash-matched agreements must preserve bundle job and party bindings", async () => {
    for (const variant of ["job", "buyer-claim", "seller-bundle"] as const) {
      const fx = await buildFixture(buyerDid, signBuyer);
      const parties = fx.agreement.parties as Array<Record<string, unknown>>;
      let agreementSigners = [
        { party: buyerDid, sign: signBuyer },
        { party: sellerDid, sign: signSeller },
      ];
      if (variant === "job") {
        fx.agreement.jobId = OTHER_JOB_ID;
      } else if (variant === "buyer-claim") {
        const substituteSeed = Uint8Array.from(Buffer.alloc(32, 11));
        const substitute = didFor(substituteSeed);
        parties[0]!.primaryClaim = substitute;
        agreementSigners = [
          { party: substitute, sign: signerFor(substituteSeed) },
          { party: sellerDid, sign: signSeller },
        ];
      } else {
        parties[1]!.bundleHash = h("e");
      }
      await resignAgreement(fx, agreementSigners);
      (
        fx.bundle.agreementRef as {
          contentHash: string;
        }
      ).contentHash = contentHash(fx.agreement);
      await resignFixture(fx, [
        { party: buyerDid, sign: signBuyer },
        { party: sellerDid, sign: signSeller },
      ]);

      const result = await verifyBundleCore("ref", depsFor(fx));
      expect(result.ok, variant).toBe(false);
      expect(
        result.refs.find((ref) => ref.kind === "dacs-3-agreement")?.verdict,
        variant,
      ).toBe("incoherent");
      expect(result.reason, variant).toMatch(
        /agreement.*incoherent|missing required signature/i,
      );
    }
  });

  test("rejects accessor-backed resolver results without invoking getters", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const liveAgreement = structuredClone(fx.agreement);
    let reads = 0;
    Object.defineProperty(liveAgreement, "jobId", {
      enumerable: true,
      get: () => {
        reads += 1;
        return JOB_ID;
      },
    });
    const result = await verifyBundleCore(
      "ref",
      depsFor(fx, {
        resolveAttestationRef: async (ref) =>
          ref.anchor.locator === "agreement-j1"
            ? liveAgreement
            : ref.anchor.locator === "settlement-j1"
              ? fx.evidence
              : null,
      }),
    );
    expect(result.ok).toBe(false);
    expect(
      result.refs.find((ref) => ref.kind === "dacs-3-agreement")?.verdict,
    ).toBe("invalid-shape");
    expect(reads).toBe(0);
  });

  test("owns callback results, captures deps, and isolates resolver/verifier inputs", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const deps = depsFor(fx);
    let firstKeyResolution = true;

    deps.resolveAttestationRef = async (ref, _jobId, parties) => {
      const locator = ref.anchor.locator;
      (ref as { contentHash: string }).contentHash = h("0");
      (parties[0] as { primaryClaim: string }).primaryClaim =
        "did:demos:agent:callback-mutation";
      if (locator === "agreement-j1") return fx.agreement;
      if (locator === "settlement-j1") {
        (
          fx.agreement.listingRef as {
            contentHash: string;
          }
        ).contentHash = h("f");
        return fx.evidence;
      }
      return null;
    };
    deps.resolvePublicKey = async (did) => {
      if (firstKeyResolution) {
        firstKeyResolution = false;
        const signatures = fx.bundle.signatures as Array<
          Record<string, unknown>
        >;
        signatures[1]!.value = Buffer.alloc(64).toString("base64url");
      }
      return resolveFromDid(did);
    };
    deps.verify = (bytes, signature, publicKey) => {
      const result = verify(bytes, signature, publicKey);
      bytes.fill(0);
      signature.fill(0);
      publicKey.fill(0);
      return result;
    };
    const capturedRead = deps.readArtifact;
    deps.readArtifact = async function (ref) {
      expect(this).toBe(deps);
      deps.resolveAttestationRef = async () => null;
      deps.resolvePublicKey = async () => null;
      deps.verify = () => false;
      return capturedRead(ref);
    };

    const result = await verifyBundleCore("ref", deps);
    expect(result.ok).toBe(true);
    expect(result.signatures.every(({ verdict }) => verdict === "valid")).toBe(
      true,
    );
    expect(result.refs.every(({ verdict }) => verdict === "ok")).toBe(true);
  });

  test("rejects accessor and Proxy dependency bags before reading artifacts", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const deps = depsFor(fx);
    let getterReads = 0;
    let artifactReads = 0;
    const originalRead = deps.readArtifact;
    deps.readArtifact = async (ref) => {
      artifactReads += 1;
      return originalRead(ref);
    };
    Object.defineProperty(deps, "resolvePublicKey", {
      enumerable: true,
      configurable: true,
      get: () => {
        getterReads += 1;
        fx.bundle.jobId = OTHER_JOB_ID;
        return async () => null;
      },
    });
    await expect(verifyBundleCore("ref", deps)).rejects.toThrow(
      /resolvePublicKey dependency must be an enumerable data property/,
    );
    expect(getterReads).toBe(0);
    expect(artifactReads).toBe(0);
    expect(fx.bundle.jobId).toBe(JOB_ID);

    const proxyDeps = new Proxy(depsFor(fx), {
      get() {
        throw new Error("Proxy trap must not run");
      },
    });
    await expect(verifyBundleCore("ref", proxyDeps)).rejects.toThrow(
      /plain data object/,
    );

    const callbackProxyDeps = depsFor(fx);
    callbackProxyDeps.readArtifact = new Proxy(
      callbackProxyDeps.readArtifact,
      {},
    );
    await expect(
      verifyBundleCore("ref", callbackProxyDeps),
    ).rejects.toThrow(/readArtifact dependency must be a non-Proxy function/);
  });

  test.each(["fail", "error", "indeterminate"] as const)(
    "optional verifyEvidence: %s fails closed and receives the signed record",
    async (decision) => {
      const fx = await buildFixture(buyerDid, signBuyer);
      const res = await verifyBundleCore(
        "ref",
        depsFor(fx, {
          verifyEvidence: async (evidence) => {
            expect(evidence.signature).toEqual(fx.evidence.signature);
            return { decision, authorizedSigner: buyerDid };
          },
        }),
      );
      expect(res.signatures[0]?.verdict).toBe("valid");
      expect(res.ok).toBe(false);
      const ev = res.refs.find((r) => r.kind === "dacs-4-evidence");
      expect(ev?.verdict).toBe("invalid-evidence");
      expect(res.reason).toMatch(/invalid-evidence/);
    },
  );

  test("optional verifyEvidence: a passing evidence keeps the bundle ok", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const res = await verifyBundleCore(
      "ref",
      depsFor(fx, {
        verifyEvidence: async () => ({
          decision: "pass",
          authorizedSigner: buyerDid,
        }),
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.refs.every((r) => r.verdict === "ok")).toBe(true);
  });

  test("pay-alternative fails closed before SettlementEvidence interpretation without APR-7", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    await convertToAlternativePaymentFixture(fx);
    let evidenceCalls = 0;
    const res = await verifyBundleCore(
      "ref",
      depsFor(fx, {
        verifyEvidence: async () => {
          evidenceCalls += 1;
          return { decision: "pass", authorizedSigner: buyerDid };
        },
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/projection verifier unavailable/);
    expect(evidenceCalls).toBe(0);
    expect(res.refs).toContainEqual({
      kind: "dacs-4-alternative-projection",
      id: JOB_ID,
      verdict: "unresolved",
    });
  });

  test("pay-alternative runs APR-7 on exact signed artifacts before evidence", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    await convertToAlternativePaymentFixture(fx);
    const order: string[] = [];
    const res = await verifyBundleCore(
      "ref",
      depsFor(fx, {
        verifyAlternativePaymentProjection: async (input) => {
          order.push("apr");
          expect(input.listing).toEqual(fx.listing);
          expect(input.agreement).toEqual(fx.agreement);
          expect(input.bundle).toEqual(fx.bundle);
          return { decision: "pass" };
        },
        verifyEvidence: async () => {
          order.push("evidence");
          return { decision: "pass", authorizedSigner: buyerDid };
        },
      }),
    );
    expect(res.ok).toBe(true);
    expect(order).toEqual(["apr", "evidence"]);
  });

  test("missing referenced artifact => not ok", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const res = await verifyBundleCore(
      "ref",
      depsFor(fx, { resolveAttestationRef: async () => null }),
    );
    expect(res.ok).toBe(false);
    const agr = res.refs.find((r) => r.kind === "dacs-3-agreement");
    expect(agr?.verdict).toBe("missing");
  });

  test("missing listing (resolves via the agreement chain) => not ok", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const res = await verifyBundleCore("ref", depsFor(fx, { listing: null }));
    expect(res.ok).toBe(false);
    const lst = res.refs.find((r) => r.kind === "dacs-1-listing");
    expect(lst?.verdict).toBe("missing");
  });

  test("no resolver => refs unresolved, cannot be ok", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const res = await verifyBundleCore("ref", {
      readArtifact: async () => fx.bundle,
      resolvePublicKey: async (did) => resolveFromDid(did),
      verify,
    });
    expect(res.ok).toBe(false);
    expect(res.refs.every((r) => r.verdict === "unresolved")).toBe(true);
  });

  test("normative pre-commit abort resolves its exact ListingPin directly", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    delete fx.bundle.agreementRef;
    fx.bundle.outcome = "aborted-by-other";
    fx.bundle.settlementEvidence = [];
    const scope = { ...fx.bundle };
    delete scope["signatures"];
    delete scope["anchoredByRole"];
    const sig = await signBuyer(
      signedBytes(ARTIFACT_SEPARATORS.AttestationBundle, contentHash(scope)),
    );
    fx.bundle.signatures = [
      { party: buyerDid, algorithm: "ed25519", value: Buffer.from(sig).toString("base64url") },
    ];

    const seen: Array<{
      listingRef: unknown;
      parties: unknown;
    }> = [];
    const expectedListingRef = structuredClone(fx.bundle.listingRef);
    const expectedParties = structuredClone(fx.bundle.parties);
    const res = await verifyBundleCore(
      "ref",
      depsFor(fx, {
        resolveListingRef: async (listingRef, parties) => {
          seen.push({
            listingRef: structuredClone(listingRef),
            parties: structuredClone(parties),
          });
          (listingRef as { contentHash: string }).contentHash = h("0");
          (parties[0] as { primaryClaim: string }).primaryClaim =
            "did:demos:agent:callback-mutation";
          return fx.listing;
        },
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.refs.find((r) => r.kind === "dacs-1-listing")?.verdict).toBe("ok");
    expect(seen).toEqual([
      { listingRef: expectedListingRef, parties: expectedParties },
    ]);
    expect(res.bundle?.listingRef).toEqual(expectedListingRef);
    expect(res.bundle?.parties).toEqual(expectedParties);

    let legacyCalls = 0;
    const legacyOnlyDeps = depsFor(fx, {
      resolveRef: async () => {
        legacyCalls += 1;
        return fx.listing;
      },
    });
    delete legacyOnlyDeps.resolveListingRef;
    const withoutNormativeResolver = await verifyBundleCore(
      "ref",
      legacyOnlyDeps,
    );
    expect(legacyCalls).toBe(0);
    expect(
      withoutNormativeResolver.refs.find(
        (ref) => ref.kind === "dacs-1-listing",
      )?.verdict,
    ).toBe("unresolved");
    expect(withoutNormativeResolver.ok).toBe(false);
  });

  test("explicit legacy MVP graph retains only the legacy Listing resolver", async () => {
    const fx = await buildLegacyMvpAbortFixture();
    let normativeCalls = 0;
    const legacyCalls: Array<readonly unknown[]> = [];
    const result = await verifyBundleCore("legacy-bundle", {
      readArtifact: async () => fx.bundle,
      resolveListingRef: async () => {
        normativeCalls += 1;
        return fx.listing;
      },
      resolveRef: async (kind, jobId, parties) => {
        legacyCalls.push([kind, jobId, structuredClone(parties)]);
        return kind === "dacs-1-listing" ? fx.listing : null;
      },
      resolvePublicKey: async (did) => resolveFromDid(did),
      verify,
    });
    expect(result.ok).toBe(true);
    expect(normativeCalls).toBe(0);
    expect(legacyCalls).toEqual([
      ["dacs-1-listing", "legacy-job", fx.bundle.parties],
    ]);
    expect(
      result.refs.find((ref) => ref.kind === "dacs-1-listing")?.verdict,
    ).toBe("ok");
  });

  test("completed or post-commit bundle without agreementRef fails verification", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    delete fx.bundle.agreementRef;
    await resignFixture(fx, [
      { party: buyerDid, sign: signBuyer },
      { party: sellerDid, sign: signSeller },
    ]);

    const res = await verifyBundleCore("ref", depsFor(fx));
    expect(res.ok).toBe(false);
    expect(res.refs.find((r) => r.kind === "dacs-3-agreement")?.verdict).toBe("missing");
  });

  test("single-signed completed bundle fails even when refs resolve", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    await resignFixture(fx, [{ party: buyerDid, sign: signBuyer }]);
    const res = await verifyBundleCore("ref", depsFor(fx));
    expect(res.ok).toBe(false);
    expect(res.fullyVerified).toBe(false);
    expect(res.reason).toMatch(/missing required signature/i);
  });

  test("completed bundle that omits the seller party fails even when refs resolve", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    fx.bundle.parties = (fx.bundle.parties as Array<{ role: string }>).filter((party) => party.role !== "seller");
    await resignFixture(fx, [{ party: buyerDid, sign: signBuyer }]);
    const res = await verifyBundleCore("ref", depsFor(fx));
    expect(res.ok).toBe(false);
    expect(res.reason).toContain(sellerDid);
  });

  test("completed bundle cannot satisfy seller signature by spoofing the seller party claim", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    fx.bundle.parties = (fx.bundle.parties as Array<Record<string, unknown>>).map((party) =>
      party.role === "seller" ? { ...party, primaryClaim: buyerDid } : party,
    );
    await resignFixture(fx, [{ party: buyerDid, sign: signBuyer }]);
    const res = await verifyBundleCore("ref", depsFor(fx));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/duplicate role/);
  });

  test("outsider-signed abort is rejected even when its signature is cryptographically valid", async () => {
    const outsiderSeed = Uint8Array.from(Buffer.alloc(32, 77));
    const outsiderDid = didFor(outsiderSeed);
    const fx = await buildFixture(buyerDid, signBuyer);
    delete fx.bundle.agreementRef;
    fx.bundle.outcome = "aborted-by-other";
    fx.bundle.settlementEvidence = [];
    await resignFixture(fx, [
      { party: outsiderDid, sign: signerFor(outsiderSeed) },
    ]);
    const result = await verifyBundleCore(
      "ref",
      depsFor(fx, {
        resolveRef: async (kind) =>
          kind === "dacs-1-listing" ? fx.listing : null,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.fullyVerified).toBe(false);
    expect(result.signatures).toEqual([
      { party: outsiderDid, verdict: "invalid" },
    ]);
  });

  test("single-signed abort must be signed by the party named by anchoredByRole", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    delete fx.bundle.agreementRef;
    fx.bundle.outcome = "aborted-by-other";
    fx.bundle.settlementEvidence = [];
    await resignFixture(fx, [{ party: sellerDid, sign: signSeller }]);
    const result = await verifyBundleCore(
      "ref",
      depsFor(fx, {
        resolveRef: async (kind) =>
          kind === "dacs-1-listing" ? fx.listing : null,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(buyerDid);
  });

  test("multi-signed abort still requires the full signer set", async () => {
    const orchestratorSeed = Uint8Array.from(Buffer.alloc(32, 78));
    const orchestratorDid = didFor(orchestratorSeed);
    const fx = await buildFixture(buyerDid, signBuyer);
    fx.bundle.outcome = "aborted-by-other";
    (fx.bundle.parties as Array<Record<string, unknown>>).push({
      role: "orchestrator",
      bundleHash: h("e"),
      primaryClaim: orchestratorDid,
    });
    await resignFixture(fx, [
      { party: buyerDid, sign: signBuyer },
      { party: sellerDid, sign: signSeller },
    ]);
    const result = await verifyBundleCore("ref", depsFor(fx));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(orchestratorDid);
  });

  test("unknown bundle outcomes fail closed", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    fx.bundle.outcome = "failed";
    await resignFixture(fx, [{ party: buyerDid, sign: signBuyer }]);
    const res = await verifyBundleCore("ref", depsFor(fx));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not an attestation bundle/i);
  });

  test("pre-commit phase names do not trigger the agreementRef requirement", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    delete fx.bundle.agreementRef;
    fx.bundle.outcome = "aborted-by-other";
    fx.bundle.settlementEvidence = [];
    fx.bundle.phaseSummary = [
      { index: 0, kind: "vet-credentials", outcome: "ok" },
    ];
    await resignFixture(fx, [
      { party: buyerDid, sign: signBuyer },
      { party: sellerDid, sign: signSeller },
    ]);

    const res = await verifyBundleCore("ref", depsFor(fx));
    expect(res.ok).toBe(true);
  });

  test("amendment and rating refs must resolve and hash-match", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const amendmentScope = {
      amendmentVersion: "1",
      jobId: JOB_ID,
      amendsEvidenceRef: (fx.bundle.settlementEvidence as unknown[])[0],
      amendmentType: "refund",
      refundAmount: { amount: "1000000", currency: "USDC" },
      refundTxRefs: [],
      reason: "refund",
      observedAt: 1780000000001,
    };
    const amendment = {
      ...amendmentScope,
      signature: await componentSignature(
        amendmentScope,
        "dacs-amendment:v1:",
        sellerDid,
        signSeller,
      ),
    };
    const ratingScope = {
      ratingVersion: "1",
      jobId: JOB_ID,
      rater: buyerDid,
      target: sellerDid,
      targetRole: "seller",
      value: 5,
      ratedAt: 1780000000002,
    };
    const rating = {
      ...ratingScope,
      signature: await componentSignature(
        ratingScope,
        "dacs-rating:v1:",
        buyerDid,
        signBuyer,
      ),
    };
    fx.bundle.amendments = [
      {
        anchor: { kind: "storage-program", locator: "amendment-j1" },
        contentHash: contentHash(amendment),
      },
    ];
    fx.bundle.ratingRefs = [
      {
        anchor: { kind: "storage-program", locator: "rating-j1" },
        contentHash: contentHash(rating),
      },
    ];
    await resignFixture(fx, [
      { party: buyerDid, sign: signBuyer },
      { party: sellerDid, sign: signSeller },
    ]);

    const ok = await verifyBundleCore(
      "ref",
      depsFor(fx, {
        resolveAttestationRef: async (ref) =>
          ref.anchor.locator === "agreement-j1"
            ? fx.agreement
            : ref.anchor.locator === "settlement-j1"
              ? fx.evidence
              : ref.anchor.locator === "amendment-j1"
                ? amendment
                : ref.anchor.locator === "rating-j1"
                  ? rating
                  : null,
      }),
    );
    expect(ok.ok).toBe(true);

    const bad = await verifyBundleCore(
      "ref",
      depsFor(fx, {
        resolveAttestationRef: async (ref) =>
          ref.anchor.locator === "agreement-j1"
            ? fx.agreement
            : ref.anchor.locator === "settlement-j1"
              ? fx.evidence
              : ref.anchor.locator === "amendment-j1"
                ? { ...amendment, reason: "tampered" }
                : ref.anchor.locator === "rating-j1"
                  ? rating
                  : null,
      }),
    );
    expect(bad.ok).toBe(false);
    expect(bad.refs.find((r) => r.kind === "dacs-4-amendment")?.verdict).toBe(
      "hash-mismatch",
    );

    const outsiderSeed = Uint8Array.from(Buffer.alloc(32, 11));
    const outsider = didFor(outsiderSeed);
    const outsiderRatingScope = { ...ratingScope, rater: outsider };
    const outsiderRating = {
      ...outsiderRatingScope,
      signature: await componentSignature(
        outsiderRatingScope,
        "dacs-rating:v1:",
        outsider,
        signerFor(outsiderSeed),
      ),
    };
    (fx.bundle.ratingRefs as Array<{ contentHash: string }>)[0]!.contentHash =
      contentHash(outsiderRating);
    await resignFixture(fx, [
      { party: buyerDid, sign: signBuyer },
      { party: sellerDid, sign: signSeller },
    ]);
    const outsiderResult = await verifyBundleCore(
      "ref",
      depsFor(fx, {
        resolveAttestationRef: async (ref) =>
          ref.anchor.locator === "agreement-j1"
            ? fx.agreement
            : ref.anchor.locator === "settlement-j1"
              ? fx.evidence
              : ref.anchor.locator === "amendment-j1"
                ? amendment
                : ref.anchor.locator === "rating-j1"
                  ? outsiderRating
                  : null,
      }),
    );
    expect(
      outsiderResult.refs.find((ref) => ref.kind === "dacs-5-rating"),
    ).toMatchObject({ verdict: "invalid-binding" });
  });

  test("ref that isn't a bundle => rejected", async () => {
    const res = await verifyBundleCore("ref", {
      readArtifact: async () => ({ not: "a bundle" }),
      resolvePublicKey: async () => null,
      verify,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not an attestation bundle/);
  });

  test("passes the exact ref and bundle parties to resolution for owner binding (#70)", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const seen: Array<readonly unknown[]> = [];
    const res = await verifyBundleCore(
      "ref",
      depsFor(fx, {
        resolveAttestationRef: async (ref, jobId, parties) => {
          seen.push([ref, jobId, parties]);
          return ref.anchor.locator === "agreement-j1"
            ? fx.agreement
            : ref.anchor.locator === "settlement-j1"
              ? fx.evidence
              : null;
        },
      }),
    );
    expect(res.ok).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    for (const [, , parties] of seen) {
      expect(parties).toEqual(fx.bundle.parties);
    }
  });
});

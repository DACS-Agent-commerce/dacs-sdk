import { describe, expect, test } from "vitest";

import {
  canonicalize,
  contentHash,
  createFixedPriceAgreementSignatureContribution,
  createFixedPriceAgreementSigningPlan,
  deriveFixedPriceAgreement,
  ed25519Sign,
  ed25519Verify,
  finalizeFixedPriceAgreementContributions,
  fixedPriceAgreementSignedBytes,
  isAgreementDocument,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
  sha256Hex,
  type AttestationRef,
  type FixedPriceAgreementSigningRole,
  type IdentityBundle,
  type Listing,
  type PaymentRailRef,
} from "../../src/index.js";

const NOW = 1_780_100_000_000;
const BUYER_SEED = new Uint8Array(32).fill(91);
const SELLER_SEED = new Uint8Array(32).fill(92);
const claim = (seed: Uint8Array) =>
  `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const BUYER = claim(BUYER_SEED);
const SELLER = claim(SELLER_SEED);
const SEEDS = { buyer: BUYER_SEED, seller: SELLER_SEED } as const;

function identity(primaryClaim: string): IdentityBundle {
  return {
    bundleVersion: "1",
    presentedBy: primaryClaim,
    presentedAt: NOW - 1_000,
    claims: [{ ref: primaryClaim }],
    presentation: {
      kind: "per-claim",
      signatures: [{ ref: primaryClaim, signature: "identity-proof" }],
    },
  };
}

function vetRef(role: string): AttestationRef {
  return {
    anchor: { kind: "storage-program", locator: `stor:${role}-vet` },
    contentHash: role === "buyer" ? "a".repeat(64) : "b".repeat(64),
  };
}

const rail: PaymentRailRef = {
  railId: "x402:base",
  railVersion: 1,
  parameters: { network: "eip155:8453" },
};

function listing(): Listing {
  return {
    dacsVersion: "1",
    listingVersion: 3,
    listingId: "exchange-listing",
    seller: {
      identity: identity(SELLER),
      displayName: "Independent seller",
      publicEndpoint: "https://seller.example/dacs",
    },
    offering: {
      title: "Signed data",
      description: "One independently signed payload",
      category: "data.test",
      tags: ["test"],
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
      { kind: "pay-x402", parameters: { rail: rail.railId } },
      { kind: "deliver-attested-payload" },
    ],
    pricing: { kind: "fixed", price: { amount: "1", currency: "USDC" } },
    acceptedRails: [rail],
    terms: { deadlineSecAfterCommit: 600 },
    validity: { notBefore: NOW - 10_000, notAfter: NOW + 1_000_000 },
    signature: {
      algorithm: "ed25519",
      signer: SELLER,
      value: Buffer.alloc(64, 3).toString("base64url"),
    },
  };
}

function draft() {
  const value = listing();
  return deriveFixedPriceAgreement({
    jobId: "job-independent-agreement",
    verifiedListing: {
      disposition: "verified",
      listing: value,
      pin: {
        listingId: value.listingId,
        version: value.listingVersion,
        contentHash: contentHash(value as unknown as Record<string, unknown>),
      },
    },
    buyer: { identityBundle: identity(BUYER), vetRecordRef: vetRef("buyer") },
    seller: { identityBundle: identity(SELLER), vetRecordRef: vetRef("seller") },
    selectedRail: rail,
    generatedAt: NOW,
  });
}

function signer(role: FixedPriceAgreementSigningRole) {
  return {
    party: role === "buyer" ? BUYER : SELLER,
    algorithm: "ed25519" as const,
    sign: (bytes: Uint8Array) =>
      ed25519Sign(bytes, privateKeyFromSeed(SEEDS[role])),
  };
}

const verify = ({
  role,
  value,
  signedBytes,
}: {
  role: FixedPriceAgreementSigningRole;
  value: string;
  signedBytes: Uint8Array;
}) =>
  ed25519Verify(
    signedBytes,
    Uint8Array.from(Buffer.from(value, "base64url")),
    publicKeyFromSeed(SEEDS[role]),
  )
    ? "valid" as const
    : "invalid" as const;

async function contributions() {
  const plan = createFixedPriceAgreementSigningPlan(draft());
  return {
    plan,
    buyer: await createFixedPriceAgreementSignatureContribution(
      plan,
      "buyer",
      signer("buyer"),
    ),
    seller: await createFixedPriceAgreementSignatureContribution(
      plan,
      "seller",
      signer("seller"),
    ),
  };
}

describe("role-owned fixed-price agreement exchange", () => {
  test("independent buyer and seller contributions assemble one verified agreement", async () => {
    const { plan, buyer, seller } = await contributions();
    const agreement = await finalizeFixedPriceAgreementContributions(
      plan,
      [seller, buyer],
      verify,
    );

    expect(isAgreementDocument(agreement)).toBe(true);
    expect(agreement.signatures.map((entry) => entry.party)).toEqual([BUYER, SELLER]);
    expect(agreement.signatures.map((entry) => entry.value)).toEqual([
      buyer.signature.value,
      seller.signature.value,
    ]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.draft)).toBe(true);
  });

  test("each role signs the same domain-separated bytes without a remote signing callback", async () => {
    const { plan, buyer, seller } = await contributions();
    for (const [role, contribution] of [
      ["buyer", buyer],
      ["seller", seller],
    ] as const) {
      expect(
        ed25519Verify(
          fixedPriceAgreementSignedBytes(plan),
          Uint8Array.from(Buffer.from(contribution.signature.value, "base64url")),
          publicKeyFromSeed(SEEDS[role]),
        ),
      ).toBe(true);
    }
  });

  test("missing, duplicate, wrong-role, and wrong-plan contributions fail closed", async () => {
    const { plan, buyer, seller } = await contributions();
    await expect(
      finalizeFixedPriceAgreementContributions(plan, [buyer], verify),
    ).rejects.toThrow(/exactly one buyer and one seller/i);
    await expect(
      finalizeFixedPriceAgreementContributions(plan, [buyer, buyer], verify),
    ).rejects.toThrow(/duplicated/i);
    await expect(
      createFixedPriceAgreementSignatureContribution(plan, "seller", signer("buyer")),
    ).rejects.toThrow(/does not own that role/i);

    const otherPlan = createFixedPriceAgreementSigningPlan({
      ...draft(),
      jobId: "job-substituted-agreement",
    });
    await expect(
      finalizeFixedPriceAgreementContributions(otherPlan, [buyer, seller], verify),
    ).rejects.toThrow(/missing or substituted/i);
  });

  test("cryptographic invalidity and unresolved verification never assemble", async () => {
    const { plan, buyer, seller } = await contributions();
    const tamperedBase = {
      ...structuredClone(seller),
      signature: {
        ...structuredClone(seller.signature),
        value: Buffer.alloc(64, 7).toString("base64url"),
      },
    };
    const tampered = {
      ...tamperedBase,
      contributionHash: sha256Hex(canonicalize({
        contributionVersion: tamperedBase.contributionVersion,
        planHash: tamperedBase.planHash,
        role: tamperedBase.role,
        party: tamperedBase.party,
        signature: tamperedBase.signature,
      })),
    };
    await expect(
      finalizeFixedPriceAgreementContributions(plan, [buyer, tampered], verify),
    ).rejects.toThrow(/cryptographically valid \(invalid\)/i);
    await expect(
      finalizeFixedPriceAgreementContributions(
        plan,
        [buyer, seller],
        () => "indeterminate",
      ),
    ).rejects.toThrow(/indeterminate/i);
  });

  test("captures draft bytes and rejects accessors, proxies, symbols, and sparse arrays", async () => {
    const input = draft();
    const plan = createFixedPriceAgreementSigningPlan(input);
    input.jobId = "mutated-after-plan";
    expect(plan.draft.jobId).toBe("job-independent-agreement");

    const sig5Input = draft();
    const additionalTerms = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(additionalTerms, "__proto__", {
      value: { retained: "exactly" },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    sig5Input.terms.additionalTerms = additionalTerms;
    const sig5Plan = createFixedPriceAgreementSigningPlan(sig5Input);
    expect(Object.hasOwn(sig5Plan.draft.terms.additionalTerms!, "__proto__")).toBe(true);
    expect(sig5Plan.draft.terms.additionalTerms?.["__proto__"]).toEqual({
      retained: "exactly",
    });

    const accessor = draft() as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "jobId", {
      enumerable: true,
      get: () => "getter-job",
    });
    expect(() => createFixedPriceAgreementSigningPlan(accessor as never)).toThrow(
      /data property/i,
    );
    expect(() =>
      createFixedPriceAgreementSigningPlan(new Proxy(draft(), {}) as never),
    ).toThrow(/proxies/i);

    const symbolDraft = draft() as unknown as Record<PropertyKey, unknown>;
    symbolDraft[Symbol("hidden")] = "value";
    expect(() => createFixedPriceAgreementSigningPlan(symbolDraft as never)).toThrow(
      /symbol/i,
    );

    const { buyer, seller } = await contributions();
    const sparse = [buyer, seller];
    delete sparse[0];
    await expect(
      finalizeFixedPriceAgreementContributions(plan, sparse as never, verify),
    ).rejects.toThrow(/sparse/i);
  });
});

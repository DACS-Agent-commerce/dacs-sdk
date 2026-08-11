import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  ARTIFACT_SEPARATORS,
  contentHash,
  deriveFixedPriceAgreement,
  ed25519Sign,
  ed25519Verify,
  identityBundleHash,
  isAgreementDocument,
  isPayeeBoundAgreementDocument,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
  signFixedPriceAgreement,
  signedBytes,
  type AttestationRef,
  type IdentityBundle,
  type Listing,
  type PaymentRailRef,
} from "../../src/index.js";

const NOW = 1_780_000_000_000;
const BUYER_SEED = Uint8Array.from(Buffer.alloc(32, 31));
const SELLER_SEED = Uint8Array.from(Buffer.alloc(32, 32));
const claim = (seed: Uint8Array) =>
  `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const BUYER = claim(BUYER_SEED);
const SELLER = claim(SELLER_SEED);
const HASH = "a".repeat(64);

const PAYEE_BINDING_VECTORS = JSON.parse(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../vendor/DACS-Standard/conformance/vectors/security/payee-destination-binding-v0.1.json",
    ),
    "utf8",
  ),
) as {
  vectors: Array<{ name: string; agreement: unknown }>;
};

function vectorAgreement(name: string): unknown {
  const vector = PAYEE_BINDING_VECTORS.vectors.find((entry) => entry.name === name);
  if (!vector) throw new Error(`missing Standard vector: ${name}`);
  return vector.agreement;
}

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

function vetRef(locator: string): AttestationRef {
  return {
    anchor: { kind: "storage-program", locator },
    contentHash: HASH,
  };
}

const rail: PaymentRailRef = {
  railId: "x402:default",
  railVersion: 1,
  parameters: { network: "eip155:8453" },
};

function listing(
  commit: "commit-agreement" | "commit-payee-bound-agreement" =
    "commit-agreement",
): Listing {
  return {
    dacsVersion: "1",
    listingVersion: 3,
    listingId: "market-data",
    seller: {
      identity: identity(SELLER),
      displayName: "Market Data",
      publicEndpoint: "https://seller.example/dacs",
    },
    offering: {
      title: "Market Data",
      description: "Signed price payload",
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
      { kind: commit },
      { kind: "pay-x402", parameters: { rail: rail.railId } },
      { kind: "deliver-attested-payload" },
    ],
    pricing: { kind: "fixed", price: { amount: "1", currency: "USDC" } },
    acceptedRails: [rail],
    terms: { deadlineSecAfterCommit: 600 },
    validity: { notBefore: NOW - 1_000, notAfter: NOW + 1_000_000 },
    signature: {
      algorithm: "ed25519",
      signer: SELLER,
      value: Buffer.alloc(64, 9).toString("base64url"),
    },
  };
}

function input(value = listing()) {
  return {
    jobId: "job-fixed-1",
    verifiedListing: {
      disposition: "verified" as const,
      listing: value,
      pin: {
        listingId: value.listingId,
        version: value.listingVersion,
        contentHash: contentHash(value as unknown as Record<string, unknown>),
      },
    },
    buyer: { identityBundle: identity(BUYER), vetRecordRef: vetRef("stor:buyer-vet") },
    seller: { identityBundle: identity(SELLER), vetRecordRef: vetRef("stor:seller-vet") },
    selectedRail: rail,
    generatedAt: NOW,
  };
}

describe("normative fixed-price agreement core (DACS-3 §8.4.1/§8.5)", () => {
  test("derives every action-bearing term from the exact pinned Listing", () => {
    const value = listing();
    const draft = deriveFixedPriceAgreement(input(value));
    expect(draft).toMatchObject({
      agreementVersion: "1",
      jobId: "job-fixed-1",
      listingRef: { listingId: "market-data", version: 3 },
      derivedFromPattern: "fixed-price",
      generatedAt: NOW,
      terms: {
        price: { amount: "1", currency: "USDC" },
        rail,
        deadline: NOW + 600_000,
        deliverable: {
          deliverableType: "attested-payload",
          hash: contentHash(
            value.offering.deliverable as unknown as Record<string, unknown>,
          ),
        },
      },
    });
    expect(draft.parties.map((party) => [party.role, party.primaryClaim])).toEqual([
      ["buyer", BUYER],
      ["seller", SELLER],
    ]);
    expect(draft.parties.map((party) => party.bundleHash)).toEqual([
      identityBundleHash(input().buyer.identityBundle),
      identityBundleHash(input().seller.identityBundle),
    ]);
    expect("signatures" in draft).toBe(false);
  });

  test("fails closed on pricing that requires negotiation, auction, or metering", () => {
    for (const pricing of [
      {
        kind: "negotiable",
        bandCenter: { amount: "2.5", currency: "USDC" },
        minPct: 10,
        maxPct: 20,
      } as const,
      { kind: "auction", selectionRule: "lowest-price" } as const,
      {
        kind: "metered",
        unitPrice: { amount: "1", currency: "USDC" },
        unit: "request",
      } as const,
    ]) {
      const unsupported = listing();
      unsupported.pricing = pricing;
      expect(() => deriveFixedPriceAgreement(input(unsupported))).toThrow(
        /invalid wire shape|unsupported/,
      );
    }
  });

  test("uses the normative IdentityBundle hash and excludes only presentation", () => {
    const original = input();
    const first = deriveFixedPriceAgreement(original);
    const changedPresentation = structuredClone(original);
    changedPresentation.buyer.identityBundle.presentation = {
      kind: "per-claim",
      signatures: [{ ref: BUYER, signature: "rotated-presentation" }],
    };
    const second = deriveFixedPriceAgreement(changedPresentation);
    expect(second.parties[0]!.bundleHash).toBe(first.parties[0]!.bundleHash);

    const changedClaim = structuredClone(original);
    changedClaim.buyer.identityBundle.claims[0]!.metadata = { revision: 2 };
    const third = deriveFixedPriceAgreement(changedClaim);
    expect(third.parties[0]!.bundleHash).not.toBe(first.parties[0]!.bundleHash);
  });

  test("rejects stale pins, expired Listings, rail mutation, and seller substitution", () => {
    const stale = input();
    stale.verifiedListing.pin.contentHash = "b".repeat(64);
    expect(() => deriveFixedPriceAgreement(stale)).toThrow(/pin does not match/);

    expect(() =>
      deriveFixedPriceAgreement({
        ...input(),
        verifiedListing: {
          ...input().verifiedListing,
          disposition: "indeterminate",
        } as never,
      }),
    ).toThrow(/verified Listing disposition/);

    const expired = listing();
    expired.validity.notAfter = NOW - 1;
    expect(() => deriveFixedPriceAgreement(input(expired))).toThrow(/validity/);

    const changedRail = input();
    changedRail.selectedRail = { ...rail, parameters: { network: "eip155:1" } };
    expect(() => deriveFixedPriceAgreement(changedRail)).toThrow(/exact acceptedRails/);

    const wrongSeller = input();
    wrongSeller.seller = {
      identityBundle: identity("did:demos:agent:substitute"),
      vetRecordRef: vetRef("stor:wrong-seller-vet"),
    };
    expect(() => deriveFixedPriceAgreement(wrongSeller)).toThrow(/does not match/);
  });

  test("enforces exact payee-bound pipeline coverage", () => {
    const value = listing("commit-payee-bound-agreement");
    const required = [{ railId: rail.railId, phaseIndex: 2, payeeAddress: "0xseller" }];
    expect(
      isPayeeBoundAgreementDocument({
        ...deriveFixedPriceAgreement({ ...input(value), payoutBindings: required }),
        signatures: [
          { party: BUYER, algorithm: "ed25519", value: Buffer.alloc(64).toString("base64url") },
          { party: SELLER, algorithm: "ed25519", value: Buffer.alloc(64, 1).toString("base64url") },
        ],
      }),
    ).toBe(true);
    expect(() => deriveFixedPriceAgreement(input(value))).toThrow(/cover every pay phase/);
    expect(() =>
      deriveFixedPriceAgreement({
        ...input(value),
        payoutBindings: [{ ...required[0]!, phaseIndex: 3 }],
      }),
    ).toThrow(/missing, duplicate, or extra/);
  });

  test("omits rail for a zero-pay pipeline and rejects caller-injected rail authority", () => {
    const value = listing();
    value.pipeline = [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-agreement" },
      { kind: "deliver-attested-payload" },
    ];
    value.acceptedRails = undefined;
    const { selectedRail: _ignored, ...zeroPay } = input(value);
    const draft = deriveFixedPriceAgreement(zeroPay);
    expect(draft.terms.rail).toBeUndefined();
    expect(() =>
      deriveFixedPriceAgreement({ ...zeroPay, selectedRail: rail }),
    ).toThrow(/zero-pay pipeline/);
  });

  test("collects buyer and seller signatures over the exact agreement domain", async () => {
    const draft = deriveFixedPriceAgreement(input());
    const buyerPrivate = privateKeyFromSeed(BUYER_SEED);
    const sellerPrivate = privateKeyFromSeed(SELLER_SEED);
    const signed = await signFixedPriceAgreement(
      draft,
      {
        party: BUYER,
        algorithm: "ed25519",
        sign: (bytes) => ed25519Sign(bytes, buyerPrivate),
      },
      {
        party: SELLER,
        algorithm: "ed25519",
        sign: (bytes) => ed25519Sign(bytes, sellerPrivate),
      },
    );
    expect(isAgreementDocument(signed)).toBe(true);
    const bytes = signedBytes(
      ARTIFACT_SEPARATORS.AgreementDocument,
      contentHash(signed as unknown as Record<string, unknown>),
    );
    for (const [signature, seed] of [
      [signed.signatures[0]!, BUYER_SEED],
      [signed.signatures[1]!, SELLER_SEED],
    ] as const) {
      expect(
        ed25519Verify(
          bytes,
          Uint8Array.from(Buffer.from(signature.value, "base64url")),
          publicKeyFromSeed(seed),
        ),
      ).toBe(true);
    }
  });

  test("rejects wrong role signers and non-canonical signature encodings", async () => {
    const draft = deriveFixedPriceAgreement(input());
    await expect(
      signFixedPriceAgreement(
        draft,
        { party: SELLER, algorithm: "ed25519", sign: () => new Uint8Array(64) },
        { party: BUYER, algorithm: "ed25519", sign: () => new Uint8Array(64) },
      ),
    ).rejects.toThrow(/do not match/);
    await expect(
      signFixedPriceAgreement(
        draft,
        { party: BUYER, algorithm: "ed25519", sign: () => "YWJjZA==" },
        { party: SELLER, algorithm: "ed25519", sign: () => new Uint8Array(64) },
      ),
    ).rejects.toThrow(/non-canonical/);
  });

  test("rejects malformed drafts before invoking either signer", async () => {
    let invoked = 0;
    const signer = {
      party: BUYER,
      algorithm: "unknown" as never,
      sign: () => {
        invoked += 1;
        return new Uint8Array(64);
      },
    };
    await expect(
      signFixedPriceAgreement(
        { ...deriveFixedPriceAgreement(input()), signature: "ambiguous" } as never,
        signer,
        { ...signer, party: SELLER },
      ),
    ).rejects.toThrow(/must not carry signature fields/);
    expect(invoked).toBe(0);

    await expect(
      signFixedPriceAgreement(
        deriveFixedPriceAgreement(input()),
        signer,
        { ...signer, party: SELLER },
      ),
    ).rejects.toThrow(/unsupported algorithm/);
    expect(invoked).toBe(0);
  });

  test("validator rejects discriminator coercion, plural ambiguity, and malformed known terms", async () => {
    const signed = await signFixedPriceAgreement(
      deriveFixedPriceAgreement(input()),
      { party: BUYER, algorithm: "ed25519", sign: () => new Uint8Array(64) },
      { party: SELLER, algorithm: "ed25519", sign: () => new Uint8Array(64) },
    );
    expect(isAgreementDocument(signed)).toBe(true);
    expect(
      isAgreementDocument({ ...signed, payeeBoundAgreementVersion: "1" }),
    ).toBe(false);
    expect(
      isAgreementDocument({
        ...signed,
        signatures: [
          { ...signed.signatures[0], value: "YWJjZA==" },
          signed.signatures[1],
        ],
      }),
    ).toBe(false);
    expect(
      isAgreementDocument({
        ...signed,
        terms: {
          ...signed.terms,
          meteredQuantity: { quantity: "01", unit: "request" },
        },
      }),
    ).toBe(false);
  });

  test("matches the pinned Standard payee-bound artifact-shape vectors", () => {
    expect(
      isAgreementDocument(
        vectorAgreement("agreement-current-reader-accepts-legacy-no-pb"),
      ),
    ).toBe(true);
    expect(
      isPayeeBoundAgreementDocument(
        vectorAgreement("agreement-current-reader-accepts-payee-bound"),
      ),
    ).toBe(true);

    for (const name of [
      "agreement-legacy-payoutbindings-reject",
      "agreement-both-discriminators-reject",
      "agreement-neither-discriminator-reject",
      "agreement-payee-bound-omitted-payoutbindings-reject",
    ]) {
      const agreement = vectorAgreement(name);
      expect(isAgreementDocument(agreement), name).toBe(false);
      expect(isPayeeBoundAgreementDocument(agreement), name).toBe(false);
    }

    expect(
      isPayeeBoundAgreementDocument(
        vectorAgreement("pb1-duplicate-payoutbinding-permanent"),
      ),
    ).toBe(false);
  });
});

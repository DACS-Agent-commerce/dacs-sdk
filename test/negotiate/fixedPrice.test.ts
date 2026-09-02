import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  ARTIFACT_SEPARATORS,
  canonicalize,
  ceilMeteredQuantity,
  contentHash,
  deriveMeteredPriceTerm,
  deriveFixedPriceAgreement,
  ed25519Sign,
  ed25519Verify,
  identityBundleHash,
  generateCanonicalJobId,
  isCanonicalJobId,
  isAgreementDocument,
  isPayeeBoundAgreementDocument,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
  sha256Hex,
  signFixedPriceAgreement,
  signedBytes,
  type AttestationRef,
  type AgreementSigner,
  type IdentityBundle,
  type Listing,
  type PaymentRailRef,
} from "../../src/index.js";

const NOW = 1_780_000_000_000;
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7E";
const BUYER_SEED = Uint8Array.from(Buffer.alloc(32, 31));
const SELLER_SEED = Uint8Array.from(Buffer.alloc(32, 32));
const claim = (seed: Uint8Array) =>
  `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const BUYER = claim(BUYER_SEED);
const SELLER = claim(SELLER_SEED);
const OUTSIDER = claim(Uint8Array.from(Buffer.alloc(32, 33)));
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

const METERED_PRICING_VECTORS = JSON.parse(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../vendor/DACS-Standard/conformance/vectors/security/metered-pricing-v0.3.json",
    ),
    "utf8",
  ),
) as {
  vectors: Array<{
    name: string;
    surface: "agreement-validation" | "quantity-derivation";
    expected: "accept" | "reject";
    rawMeasurement?: string;
    pricing?: Record<string, unknown>;
    terms?: {
      price?: { amount: string; currency: string };
      meteredQuantity?: { quantity: string; unit: string };
    };
    want: Record<string, unknown>;
  }>;
};

function vectorAgreement(name: string): unknown {
  const vector = PAYEE_BINDING_VECTORS.vectors.find((entry) => entry.name === name);
  if (!vector) throw new Error(`missing Standard vector: ${name}`);
  // These PB-1 vectors exercise discriminator and payout-binding shape but use
  // an illustrative pre-CORE-§B.1 job label. Preserve their target mutation
  // while supplying the canonical session identifier required by this reader.
  const agreement = structuredClone(vector.agreement) as Record<string, unknown>;
  agreement.jobId = JOB_ID;
  return agreement;
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
    jobId: JOB_ID,
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
    const agreementInput = input(value);
    const draft = deriveFixedPriceAgreement(agreementInput);
    expect(draft).toMatchObject({
      agreementVersion: "1",
      jobId: JOB_ID,
      listingRef: { listingId: "market-data", version: 3 },
      derivedFromPattern: "fixed-price",
      generatedAt: NOW,
      terms: {
        price: { amount: "1", currency: "USDC" },
        rail,
        deadline: NOW + 600_000,
        deliverable: {
          deliverableType: "attested-payload",
          hash: sha256Hex(canonicalize(value.offering.deliverable)),
        },
      },
    });
    expect(draft.parties.map((party) => [party.role, party.primaryClaim])).toEqual([
      ["buyer", BUYER],
      ["seller", SELLER],
    ]);
    expect(draft.parties.map((party) => party.bundleHash)).toEqual([
      identityBundleHash(agreementInput.buyer.identityBundle),
      identityBundleHash(agreementInput.seller.identityBundle),
    ]);
    expect("signatures" in draft).toBe(false);
  });

  test("requires the one canonical uppercase ULID spelling at derivation and read", async () => {
    for (const invalid of [
      JOB_ID.toLowerCase(),
      `8${JOB_ID.slice(1)}`,
      `${JOB_ID.slice(0, -1)}I`,
      JOB_ID.slice(1),
      `${JOB_ID}0`,
      "job-fixed-1",
    ]) {
      expect(() =>
        deriveFixedPriceAgreement({ ...input(), jobId: invalid }),
      ).toThrow(/canonical uppercase ULID/);
    }

    const signed = await signFixedPriceAgreement(
      deriveFixedPriceAgreement(input()),
      { party: BUYER, algorithm: "ed25519", sign: () => new Uint8Array(64) },
      { party: SELLER, algorithm: "ed25519", sign: () => new Uint8Array(64) },
    );
    expect(isAgreementDocument(signed)).toBe(true);
    expect(isAgreementDocument({ ...signed, jobId: "job-fixed-1" })).toBe(false);
  });

  test("fixed-price over negotiable pricing selects exactly the band centre", () => {
    const value = listing();
    value.pricing = {
      kind: "negotiable",
      bandCenter: { amount: "2.5", currency: "USDC" },
      minPct: 10,
      maxPct: 20,
    };
    expect(deriveFixedPriceAgreement(input(value)).terms.price).toEqual(
      value.pricing.bandCenter,
    );
  });

  test("enforces and generates canonical uppercase ULID job ids", async () => {
    expect(
      generateCanonicalJobId({
        timestamp: 0,
        entropy: new Uint8Array(10),
      }),
    ).toBe("00000000000000000000000000");
    const generated = generateCanonicalJobId({
      timestamp: NOW,
      entropy: Uint8Array.from({ length: 10 }, (_, index) => index),
    });
    expect(isCanonicalJobId(generated)).toBe(true);

    for (const invalid of [
      JOB_ID.toLowerCase(),
      `8${JOB_ID.slice(1)}`,
      `${JOB_ID.slice(0, -1)}I`,
      JOB_ID.slice(1),
      `${JOB_ID}0`,
      "550e8400-e29b-41d4-a716-446655440000",
    ]) {
      expect(() =>
        deriveFixedPriceAgreement({ ...input(), jobId: invalid }),
      ).toThrow(/canonical uppercase ULID/);
    }

    const nonCanonicalDraft = deriveFixedPriceAgreement(input());
    nonCanonicalDraft.jobId = "550e8400-e29b-41d4-a716-446655440000";
    let signerCalls = 0;
    await expect(
      signFixedPriceAgreement(
        nonCanonicalDraft,
        {
          party: BUYER,
          algorithm: "ed25519",
          sign: () => {
            signerCalls += 1;
            return new Uint8Array(64);
          },
        },
        {
          party: SELLER,
          algorithm: "ed25519",
          sign: () => {
            signerCalls += 1;
            return new Uint8Array(64);
          },
        },
      ),
    ).rejects.toThrow(/canonical uppercase ULID/);
    expect(signerCalls).toBe(0);
  });

  test("exposes a safe metered producer and matches every pinned MTR vector", () => {
    const value = listing();
    value.pricing = {
      kind: "metered",
      unitPrice: { amount: "1.25", currency: "USDC" },
      unit: "request",
      minTotal: { amount: "2", currency: "USDC" },
    };
    const draft = deriveFixedPriceAgreement({
      ...input(value),
      meteredQuantity: { quantity: "4", unit: "request" },
    });
    expect(draft.terms.price).toEqual({ amount: "5", currency: "USDC" });
    expect(draft.terms.meteredQuantity).toEqual({
      quantity: "4",
      unit: "request",
    });

    let decisions = 0;
    for (const vector of METERED_PRICING_VECTORS.vectors) {
      if (vector.surface === "quantity-derivation") {
        expect(
          ceilMeteredQuantity(vector.rawMeasurement!),
          vector.name,
        ).toBe(vector.want.quantity);
        decisions += 1;
        continue;
      }

      const pricing = vector.pricing as Parameters<
        typeof deriveMeteredPriceTerm
      >[0];
      const quantity = vector.terms?.meteredQuantity;
      if (!quantity) {
        const metered = listing();
        metered.pricing = pricing;
        expect(
          () => deriveFixedPriceAgreement(input(metered)),
          vector.name,
        ).toThrow();
        decisions += 1;
        continue;
      }

      if (vector.expected === "accept") {
        expect(
          deriveMeteredPriceTerm(pricing, quantity),
          vector.name,
        ).toEqual(vector.terms?.price);
      } else {
        let derived: { amount: string; currency: string } | undefined;
        let rejected = false;
        try {
          derived = deriveMeteredPriceTerm(pricing, quantity);
        } catch {
          rejected = true;
        }
        expect(
          rejected || canonicalize(derived) !== canonicalize(vector.terms?.price),
          vector.name,
        ).toBe(true);
      }
      decisions += 1;
    }
    expect(decisions).toBe(METERED_PRICING_VECTORS.vectors.length);
  });

  test("fails closed on auction and incomplete metered pricing", () => {
    const auction = listing();
    auction.pricing = { kind: "auction", selectionRule: "lowest-price" };
    expect(() => deriveFixedPriceAgreement(input(auction))).toThrow(
      /invalid wire shape|unsupported/,
    );

    const metered = listing();
    metered.pricing = {
      kind: "metered",
      unitPrice: { amount: "1", currency: "USDC" },
      unit: "request",
    };
    expect(() => deriveFixedPriceAgreement(input(metered))).toThrow(
      /missing-metered-quantity/,
    );
  });

  test("hashes the complete anchored DeliverableSpec without signature stripping", () => {
    const value = listing();
    const deliverable = value.offering.deliverable as typeof value.offering.deliverable & {
      signature?: string;
    };
    deliverable.signature = "ordinary-additive-deliverable-data";
    const draft = deriveFixedPriceAgreement(input(value));
    expect(draft.terms.deliverable.hash).toBe(
      sha256Hex(canonicalize(deliverable)),
    );
    expect(draft.terms.deliverable.hash).not.toBe(
      contentHash(deliverable as unknown as Record<string, unknown>),
    );
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

  test("owns every nested derivation input, including Vet and payout refs", () => {
    const source = {
      ...input(listing("commit-payee-bound-agreement")),
      payoutBindings: [
        { railId: rail.railId, phaseIndex: 2, payeeAddress: "0xseller" },
      ],
    };
    const draft = deriveFixedPriceAgreement(source);
    const expected = structuredClone(draft);

    source.jobId = "mutated-job";
    source.verifiedListing.pin.contentHash = "f".repeat(64);
    const sourcePrice = source.verifiedListing.listing.pricing;
    if (sourcePrice.kind === "fixed") sourcePrice.price.amount = "999";
    source.buyer.vetRecordRef.anchor.locator = "stor:mutated-buyer-vet";
    source.seller.vetRecordRef.contentHash = "e".repeat(64);
    source.selectedRail = {
      ...source.selectedRail,
      parameters: { network: "eip155:1" },
    };
    source.payoutBindings[0]!.payeeAddress = "0xattacker";

    expect(draft).toEqual(expected);

    const secondSource = input();
    const secondDraft = deriveFixedPriceAgreement(secondSource);
    secondDraft.parties[0]!.vetRecordRef.anchor.locator = "stor:draft-only";
    expect(secondSource.buyer.vetRecordRef.anchor.locator).toBe(
      "stor:buyer-vet",
    );
  });

  test("rejects accessor-backed derivation inputs without invoking getters", () => {
    const source = input();
    let reads = 0;
    Object.defineProperty(source.buyer.vetRecordRef.anchor, "locator", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "stor:live-value";
      },
    });
    expect(() => deriveFixedPriceAgreement(source)).toThrow(
      /not stable canonical JSON/,
    );
    expect(reads).toBe(0);
  });

  test("rejects Proxy and negative-zero JCS aliases before derivation", () => {
    const proxied = input();
    let proxyReads = 0;
    proxied.buyer.vetRecordRef = new Proxy(proxied.buyer.vetRecordRef, {
      ownKeys(target) {
        proxyReads += 1;
        return Reflect.ownKeys(target);
      },
    });
    expect(() => deriveFixedPriceAgreement(proxied)).toThrow(
      /not stable canonical JSON/,
    );
    expect(proxyReads).toBe(0);

    const negativeZero = input();
    negativeZero.generatedAt = -0;
    expect(() => deriveFixedPriceAgreement(negativeZero)).toThrow(
      /not stable canonical JSON/,
    );
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
      identityBundle: identity("did:demos:substitute"),
      vetRecordRef: vetRef("stor:wrong-seller-vet"),
    };
    expect(() => deriveFixedPriceAgreement(wrongSeller)).toThrow(/does not match/);
  });

  test("matches agreement parties by parameter-free CF-3 identity", () => {
    const equivalentSeller = input();
    equivalentSeller.seller = {
      identityBundle: identity(`${SELLER}?jurisdiction=GB`),
      vetRecordRef: vetRef("stor:qualified-seller-vet"),
    };
    expect(deriveFixedPriceAgreement(equivalentSeller).parties)
      .toContainEqual(expect.objectContaining({
        role: "seller",
        primaryClaim: `${SELLER}?jurisdiction=GB`,
      }));

    const samePartyTwice = input();
    samePartyTwice.buyer = {
      identityBundle: identity(`${SELLER}?role=buyer`),
      vetRecordRef: vetRef("stor:alias-buyer-vet"),
    };
    expect(() => deriveFixedPriceAgreement(samePartyTwice))
      .toThrow(/buyer and seller primary claims must be distinct/);
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
    delete value.acceptedRails;
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

  test("signs one owned draft with signer options captured before either await", async () => {
    const callerDraft = deriveFixedPriceAgreement(input());
    const expectedDraft = structuredClone(callerDraft);
    const buyerPrivate = privateKeyFromSeed(BUYER_SEED);
    const sellerPrivate = privateKeyFromSeed(SELLER_SEED);
    let sellerCalls = 0;

    const sellerSigner: AgreementSigner = {
      party: SELLER,
      algorithm: "ed25519",
      sign(bytes) {
        expect(this).toBe(sellerSigner);
        sellerCalls += 1;
        return ed25519Sign(bytes, sellerPrivate);
      },
    };
    const buyerSigner: AgreementSigner = {
      party: BUYER,
      algorithm: "ed25519",
      sign(bytes) {
        expect(this).toBe(buyerSigner);
        callerDraft.jobId = "mutated-after-snapshot";
        callerDraft.parties[0]!.vetRecordRef.anchor.locator = "stor:mutated";
        sellerSigner.party = "did:demos:agent:substitute";
        sellerSigner.algorithm = "ecdsa-secp256k1";
        sellerSigner.sign = () => new Uint8Array(1);
        return ed25519Sign(bytes, buyerPrivate);
      },
    };

    const signed = await signFixedPriceAgreement(
      callerDraft,
      buyerSigner,
      sellerSigner,
    );
    expect(sellerCalls).toBe(1);
    expect(contentHash(signed as unknown as Record<string, unknown>)).toBe(
      contentHash(expectedDraft as unknown as Record<string, unknown>),
    );
    expect(signed.jobId).toBe(expectedDraft.jobId);
    expect(signed.parties[0]!.vetRecordRef).toEqual(
      expectedDraft.parties[0]!.vetRecordRef,
    );
    expect(signed.signatures.map(({ party, algorithm }) => ({ party, algorithm })))
      .toEqual([
        { party: BUYER, algorithm: "ed25519" },
        { party: SELLER, algorithm: "ed25519" },
      ]);
  });

  test("rejects accessor and Proxy signer bags without observing live state", async () => {
    const draft = deriveFixedPriceAgreement(input());
    const originalJobId = draft.jobId;
    let getterReads = 0;
    let signerCalls = 0;
    const buyerSigner = {
      party: BUYER,
      algorithm: "ed25519" as const,
      sign: () => {
        signerCalls += 1;
        return new Uint8Array(64);
      },
    };
    Object.defineProperty(buyerSigner, "party", {
      enumerable: true,
      configurable: true,
      get: () => {
        getterReads += 1;
        draft.jobId = "getter-rebound-job";
        return BUYER;
      },
    });
    await expect(
      signFixedPriceAgreement(
        draft,
        buyerSigner,
        { party: SELLER, algorithm: "ed25519", sign: () => new Uint8Array(64) },
      ),
    ).rejects.toThrow(/party must be an enumerable data property/);
    expect(getterReads).toBe(0);
    expect(signerCalls).toBe(0);
    expect(draft.jobId).toBe(originalJobId);

    const proxyBag = new Proxy(
      { party: BUYER, algorithm: "ed25519" as const, sign: () => new Uint8Array(64) },
      {
        get() {
          throw new Error("Proxy trap must not run");
        },
      },
    );
    await expect(
      signFixedPriceAgreement(
        draft,
        proxyBag,
        { party: SELLER, algorithm: "ed25519", sign: () => new Uint8Array(64) },
      ),
    ).rejects.toThrow(/plain data object/);

    const proxiedCallback = new Proxy(() => new Uint8Array(64), {});
    await expect(
      signFixedPriceAgreement(
        draft,
        { party: BUYER, algorithm: "ed25519", sign: proxiedCallback },
        { party: SELLER, algorithm: "ed25519", sign: () => new Uint8Array(64) },
      ),
    ).rejects.toThrow(/non-Proxy function/);
  });

  test("isolates signer inputs and rejects callback mutation", async () => {
    let sellerInvoked = false;
    await expect(
      signFixedPriceAgreement(
        deriveFixedPriceAgreement(input()),
        {
          party: BUYER,
          algorithm: "ed25519",
          sign: (bytes, context) => {
            bytes[0] = (bytes[0] ?? 0) ^ 0xff;
            context.party = "did:demos:agent:mutated";
            return new Uint8Array(64);
          },
        },
        {
          party: SELLER,
          algorithm: "ed25519",
          sign: () => {
            sellerInvoked = true;
            return new Uint8Array(64);
          },
        },
      ),
    ).rejects.toThrow(/must not mutate its signing inputs/);
    expect(sellerInvoked).toBe(false);
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
    await expect(
      signFixedPriceAgreement(
        draft,
        { party: BUYER, algorithm: "ed25519", sign: () => [] as never },
        { party: SELLER, algorithm: "ed25519", sign: () => new Uint8Array(64) },
      ),
    ).rejects.toThrow(/must return signature bytes/);
    await expect(
      signFixedPriceAgreement(
        draft,
        { party: BUYER, algorithm: "ed25519", sign: () => new Uint8Array(63) },
        { party: SELLER, algorithm: "ed25519", sign: () => new Uint8Array(64) },
      ),
    ).rejects.toThrow(/exactly 64 bytes/);
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
        { ...signer, algorithm: "ed25519" },
        { ...signer, party: SELLER, algorithm: "ed25519" },
      ),
    ).rejects.toThrow(/must not carry signature fields/);
    expect(invoked).toBe(0);

    const explicitUndefined = deriveFixedPriceAgreement(input());
    explicitUndefined.terms.rail = undefined;
    await expect(
      signFixedPriceAgreement(
        explicitUndefined,
        { ...signer, algorithm: "ed25519" },
        { ...signer, party: SELLER, algorithm: "ed25519" },
      ),
    ).rejects.toThrow(/not stable canonical JSON/);
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
        signatures: [
          {
            ...signed.signatures[0],
            value: Buffer.alloc(63).toString("base64url"),
          },
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
    expect(
      isAgreementDocument({
        ...signed,
        terms: {
          ...signed.terms,
          meteredQuantity: { quantity: "2", unit: "request" },
        },
      }),
    ).toBe(true);
    let coercions = 0;
    const coercibleQuantity = {
      toString() {
        coercions += 1;
        return "2";
      },
    };
    expect(
      isAgreementDocument({
        ...signed,
        terms: {
          ...signed.terms,
          meteredQuantity: { quantity: 2, unit: "request" },
        },
      }),
    ).toBe(false);
    expect(
      isAgreementDocument({
        ...signed,
        terms: {
          ...signed.terms,
          meteredQuantity: { quantity: coercibleQuantity, unit: "request" },
        },
      }),
    ).toBe(false);
    expect(coercions).toBe(0);

    let invoked = 0;
    await expect(
      signFixedPriceAgreement(
        {
          ...deriveFixedPriceAgreement(input()),
          terms: {
            ...deriveFixedPriceAgreement(input()).terms,
            meteredQuantity: { quantity: 2, unit: "request" },
          },
        } as never,
        {
          party: BUYER,
          algorithm: "ed25519",
          sign: () => {
            invoked += 1;
            return new Uint8Array(64);
          },
        },
        {
          party: SELLER,
          algorithm: "ed25519",
          sign: () => {
            invoked += 1;
            return new Uint8Array(64);
          },
        },
      ),
    ).rejects.toThrow(/failed exact DACS-3/);
    expect(invoked).toBe(0);
  });

  test("readers and producers require distinct parties and the exact signer set", async () => {
    const signer = (party: string) => ({
      party,
      algorithm: "ed25519" as const,
      sign: () => new Uint8Array(64),
    });
    const standard = await signFixedPriceAgreement(
      deriveFixedPriceAgreement(input()),
      signer(BUYER),
      signer(SELLER),
    );
    const payeeListing = listing("commit-payee-bound-agreement");
    const payeeBound = await signFixedPriceAgreement(
      deriveFixedPriceAgreement({
        ...input(payeeListing),
        payoutBindings: [
          {
            railId: rail.railId,
            phaseIndex: 2,
            payeeAddress: "0xseller",
          },
        ],
      }),
      signer(BUYER),
      signer(SELLER),
    );
    const schemas: Array<{
      name: string;
      artifact: Record<string, unknown>;
      validate: (value: unknown) => boolean;
    }> = [
      {
        name: "AgreementDocument",
        artifact: standard as unknown as Record<string, unknown>,
        validate: isAgreementDocument,
      },
      {
        name: "PayeeBoundAgreementDocument",
        artifact: payeeBound as unknown as Record<string, unknown>,
        validate: isPayeeBoundAgreementDocument,
      },
    ];

    for (const { name, artifact, validate } of schemas) {
      const outsiderSigned = structuredClone(artifact);
      (
        outsiderSigned.signatures as Array<Record<string, unknown>>
      )[1]!.party = OUTSIDER;
      expect(validate(outsiderSigned), `${name}: exact signer set`).toBe(false);

      // Previously this passed: the required-party Set collapsed buyer=X and
      // seller=X to one member, while an unrelated X+Y signer set still had two.
      const collidingParties = structuredClone(artifact);
      const parties = collidingParties.parties as Array<Record<string, unknown>>;
      parties.find((party) => party.role === "seller")!.primaryClaim = BUYER;
      (
        collidingParties.signatures as Array<Record<string, unknown>>
      )[1]!.party = OUTSIDER;
      expect(validate(collidingParties), `${name}: colliding role claims`).toBe(
        false,
      );
    }

    const sameIdentityListing = listing();
    sameIdentityListing.seller.identity = identity(BUYER);
    sameIdentityListing.signature.signer = BUYER;
    const sameIdentityInput = input(sameIdentityListing);
    sameIdentityInput.seller.identityBundle = identity(BUYER);
    expect(() => deriveFixedPriceAgreement(sameIdentityInput)).toThrow(
      /buyer and seller primary claims must be distinct/,
    );

    const collidingDraft = deriveFixedPriceAgreement(input());
    collidingDraft.parties.find(
      (party) => party.role === "seller",
    )!.primaryClaim = BUYER;
    let callbacks = 0;
    await expect(
      signFixedPriceAgreement(
        collidingDraft,
        {
          ...signer(BUYER),
          sign: () => {
            callbacks += 1;
            return new Uint8Array(64);
          },
        },
        {
          ...signer(BUYER),
          sign: () => {
            callbacks += 1;
            return new Uint8Array(64);
          },
        },
      ),
    ).rejects.toThrow(/failed exact DACS-3/);
    expect(callbacks).toBe(0);
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

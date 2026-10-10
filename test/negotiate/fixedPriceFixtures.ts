// Fixed-price derivation inputs shared by the additional-terms suites. These
// mirror the Listings in test/negotiate/fixedPrice.test.ts and
// test/seller/agreementResponder.test.ts without reading vendored Standard
// vectors, so the byte-identity pins run in a workspace with no vendor/ sync.
import {
  contentHash,
  publicKeyFromSeed,
  rawPublicKey,
  type AttestationRef,
  type FixedPriceAgreementInput,
  type IdentityBundle,
  type Listing,
  type PaymentRailRef,
} from "../../src/index.js";

export const NOW = 1_780_000_000_000;
export const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7E";
export const BUYER_SEED = Uint8Array.from(Buffer.alloc(32, 31));
export const SELLER_SEED = Uint8Array.from(Buffer.alloc(32, 32));
const claim = (seed: Uint8Array) =>
  `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
export const BUYER = claim(BUYER_SEED);
export const SELLER = claim(SELLER_SEED);
const HASH = "a".repeat(64);

export function identity(primaryClaim: string, now = NOW): IdentityBundle {
  return {
    bundleVersion: "1",
    presentedBy: primaryClaim,
    presentedAt: now - 1_000,
    claims: [{ ref: primaryClaim }],
    presentation: {
      kind: "per-claim",
      signatures: [{ ref: primaryClaim, signature: "identity-proof" }],
    },
  };
}

function vetRef(locator: string, hash = HASH): AttestationRef {
  return {
    anchor: { kind: "storage-program", locator },
    contentHash: hash,
  };
}

export const rail: PaymentRailRef = {
  railId: "x402:default",
  railVersion: 1,
  parameters: { network: "eip155:8453" },
};

export function listing(
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

export function input(value = listing()): FixedPriceAgreementInput {
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

export const PAYOUT_BINDINGS = [
  { railId: rail.railId, phaseIndex: 2, payeeAddress: "0xseller" },
];

export function payeeBoundInput(): FixedPriceAgreementInput {
  return {
    ...input(listing("commit-payee-bound-agreement")),
    payoutBindings: structuredClone(PAYOUT_BINDINGS),
  };
}

/**
 * Every derivation fixture used by the existing fixed-price and seller
 * responder suites. Each builder returns a fresh, request-free input.
 */
export const FIXTURES: Record<string, () => FixedPriceAgreementInput> = {
  "fixed-commit-agreement": () => input(),
  "negotiable-band-centre": () => {
    const value = listing();
    value.pricing = {
      kind: "negotiable",
      bandCenter: { amount: "2.5", currency: "USDC" },
      minPct: 10,
      maxPct: 20,
    };
    return input(value);
  },
  metered: () => {
    const value = listing();
    value.pricing = {
      kind: "metered",
      unitPrice: { amount: "1.25", currency: "USDC" },
      unit: "request",
      minTotal: { amount: "2", currency: "USDC" },
    };
    return { ...input(value), meteredQuantity: { quantity: "4", unit: "request" } };
  },
  "payee-bound": () => payeeBoundInput(),
  "zero-pay": () => {
    const value = listing();
    value.pipeline = [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-agreement" },
      { kind: "deliver-attested-payload" },
    ];
    delete value.acceptedRails;
    const { selectedRail: _ignored, ...zeroPay } = input(value);
    return zeroPay;
  },
  "deliverable-with-signature-member": () => {
    const value = listing();
    (value.offering.deliverable as unknown as Record<string, unknown>).signature =
      "ordinary-additive-deliverable-data";
    return input(value);
  },
  "seller-responder-plain": () => responderContext(false),
  "seller-responder-payee-bound": () => responderContext(true),
};

// Same Listing and context as test/seller/agreementResponder.test.ts.
const RESPONDER_NOW = 1_781_500_000_000;
const RESPONDER_BUYER = claim(new Uint8Array(32).fill(111));
const RESPONDER_SELLER = claim(new Uint8Array(32).fill(112));
const RESPONDER_RAIL: PaymentRailRef = {
  railId: "x402:base",
  railVersion: 1,
  parameters: { network: "eip155:8453" },
};

function responderContext(payeeBound: boolean): FixedPriceAgreementInput {
  const exactListing: Listing = {
    dacsVersion: "1",
    listingVersion: 4,
    listingId: payeeBound
      ? "seller-responder-payee-bound"
      : "seller-responder-listing",
    seller: {
      identity: identity(RESPONDER_SELLER, RESPONDER_NOW),
      displayName: "Independent seller",
      publicEndpoint: "https://seller.example/dacs",
    },
    offering: {
      title: "Independently signed result",
      description: "A seller-local agreement response",
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
      { kind: payeeBound ? "commit-payee-bound-agreement" : "commit-agreement" },
      { kind: "pay-x402", parameters: { rail: RESPONDER_RAIL.railId } },
      { kind: "deliver-attested-payload" },
    ],
    pricing: { kind: "fixed", price: { amount: "2", currency: "USDC" } },
    acceptedRails: [RESPONDER_RAIL],
    terms: { deadlineSecAfterCommit: 600 },
    validity: { notBefore: RESPONDER_NOW - 10_000, notAfter: RESPONDER_NOW + 1_000_000 },
    signature: {
      algorithm: "ed25519",
      signer: RESPONDER_SELLER,
      value: Buffer.alloc(64, 3).toString("base64url"),
    },
  };
  return {
    jobId: payeeBound ? "01J8N4YV7YVYQ4DB7M8T4C7W0B" : "01J8N4YV7YVYQ4DB7M8T4C7W0A",
    verifiedListing: {
      disposition: "verified",
      listing: exactListing,
      pin: {
        listingId: exactListing.listingId,
        version: exactListing.listingVersion,
        contentHash: contentHash(exactListing as unknown as Record<string, unknown>),
      },
    },
    buyer: {
      identityBundle: identity(RESPONDER_BUYER, RESPONDER_NOW),
      vetRecordRef: vetRef("stor:buyer-vet"),
    },
    seller: {
      identityBundle: identity(RESPONDER_SELLER, RESPONDER_NOW),
      vetRecordRef: vetRef("stor:seller-vet", "b".repeat(64)),
    },
    selectedRail: structuredClone(RESPONDER_RAIL),
    ...(payeeBound
      ? {
          payoutBindings: [{
            railId: RESPONDER_RAIL.railId,
            phaseIndex: 2,
            payeeAddress: `0x${"22".repeat(20)}`,
          }],
        }
      : {}),
    generatedAt: RESPONDER_NOW,
  };
}

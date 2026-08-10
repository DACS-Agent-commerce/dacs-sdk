import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  authenticateReadableListingArtifact,
  discoverListings,
  verifyReadableListingArtifact,
} from "../../src/agent/discover.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import { signComponentArtifact } from "../../src/artifacts/signatures.js";
import type { Listing, ListingDraft } from "../../src/artifacts/types.js";
import {
  isDeliverableSpec,
  isLegacyMvpListing,
  isListing,
  isListingDraft,
  isListingEnvelope,
  isListingPublicEndpoint,
  isVerificationMethod,
  readListingArtifact,
} from "../../src/artifacts/validators.js";
import {
  canonicalize,
  contentHash,
  sha256Hex,
  stripSignature,
} from "../../src/canonical/index.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
} from "../../src/crypto/index.js";

const VECTOR_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../vendor/DACS-Standard/conformance/vectors/security/listing-preserve-unknown-v0.1.json",
);

const VECTOR = JSON.parse(readFileSync(VECTOR_PATH, "utf8")) as {
  spec: string;
  publicKeys: Record<string, string>;
  fixtures: {
    "listing-with-inert-extension": {
      artifactHash: string;
      listing: Listing;
    };
    "listing-with-unknown-phase": { listing: Record<string, unknown> };
  };
};

const fixture = (): Listing =>
  structuredClone(VECTOR.fixtures["listing-with-inert-extension"].listing);

const verifiedAdmissionFor = (listing: Listing) => {
  const deliverable = listing.offering.deliverable;
  if (
    deliverable.kind !== "attested-payload" ||
    !deliverable.verificationMethod
  ) {
    throw new Error("fixture drift");
  }
  return {
    disposition: "verified" as const,
    step: 9 as const,
    reason: "verified",
    listing,
    listingContentHash: contentHash(
      listing as unknown as Record<string, unknown>,
    ),
    payloadVerificationCapability: {
      disposition: "supported" as const,
      reason: "supported",
      verificationMethodKind: deliverable.verificationMethod.kind,
      verificationMethodHash: sha256Hex(
        canonicalize(deliverable.verificationMethod),
      ),
      deliverableSpecHash: sha256Hex(canonicalize(deliverable)),
    },
  };
};

const verify = (bytes: Uint8Array, signature: Uint8Array, key: Uint8Array) =>
  ed25519Verify(bytes, signature, publicKeyFromRaw(key));

describe("normative DACS-1 §6.3.4 Listing", () => {
  it("accepts and verifies the pinned Standard SIG-5 Listing vector", async () => {
    const listing = fixture();
    const signer = listing.signature.signer;

    expect(VECTOR.spec).toContain("DACS-1 §6.3.4");
    expect(isListing(listing)).toBe(true);
    expect(contentHash(listing as unknown as Record<string, unknown>)).toBe(
      VECTOR.fixtures["listing-with-inert-extension"].artifactHash,
    );

    const verified = await verifyReadableListingArtifact(
      listing as unknown as Record<string, unknown>,
      {
        verify,
        nowMs: () => 1_790_000_000_000,
        resolvePublicKey: (claim) => {
          const encoded = VECTOR.publicKeys[claim];
          return encoded
            ? Uint8Array.from(Buffer.from(encoded, "base64url"))
            : null;
        },
      },
    );
    expect(verified).toMatchObject({ compatibility: "normative" });
    expect(signer).toBe(listing.seller.identity.presentedBy);
  });

  it("returns the exact Listing snapshot authenticated before an async verifier mutates the resolver alias", async () => {
    const listing = fixture();
    const authenticatedDescription = listing.offering.description;
    const resolverMutation = "unsigned resolver mutation after verification";

    const found = await discoverListings(
      ["stor:listing"],
      async () => listing as unknown as Record<string, unknown>,
      {
        verify: async (bytes, signature, key) => {
          const valid = verify(bytes, signature, key);
          listing.offering.description = resolverMutation;
          await Promise.resolve();
          return valid;
        },
        nowMs: () => 1_790_000_000_000,
        validateListing: (raw) => verifiedAdmissionFor(raw as unknown as Listing),
        resolvePublicKey: (claim) => {
          const encoded = VECTOR.publicKeys[claim];
          return encoded
            ? Uint8Array.from(Buffer.from(encoded, "base64url"))
            : null;
        },
      },
    );

    expect(listing.offering.description).toBe(resolverMutation);
    expect(found).toHaveLength(1);
    expect(found[0]!.compatibility).toBe("normative");
    if (found[0]!.compatibility !== "normative") {
      throw new Error("expected normative Listing");
    }
    expect(found[0]!.listing.offering.description).toBe(
      authenticatedDescription,
    );
    expect(
      contentHash(found[0]!.listing as unknown as Record<string, unknown>),
    ).toBe(VECTOR.fixtures["listing-with-inert-extension"].artifactHash);
  });

  it("separates signature authentication from fresh-admission expiry", async () => {
    const listing = fixture();
    const resolvePublicKey = (claim: string) => {
      const encoded = VECTOR.publicKeys[claim];
      return encoded
        ? Uint8Array.from(Buffer.from(encoded, "base64url"))
        : null;
    };
    const expiredAt = listing.validity.notAfter! + 1;

    await expect(
      authenticateReadableListingArtifact(
        listing as unknown as Record<string, unknown>,
        { verify, nowMs: () => expiredAt, resolvePublicKey },
      ),
    ).resolves.toMatchObject({ compatibility: "normative" });
    await expect(
      verifyReadableListingArtifact(
        listing as unknown as Record<string, unknown>,
        { verify, nowMs: () => expiredAt, resolvePublicKey },
      ),
    ).resolves.toBeNull();
  });

  it("does not let one carried claim authenticate a different unproven payee", async () => {
    const signerSeed = Uint8Array.from(Buffer.alloc(32, 41));
    const payeeSeed = Uint8Array.from(Buffer.alloc(32, 42));
    const signerKey = rawPublicKey(publicKeyFromSeed(signerSeed));
    const signer = `did:demos:agent:${Buffer.from(signerKey).toString("hex")}`;
    const payee = `did:demos:agent:${Buffer.from(
      rawPublicKey(publicKeyFromSeed(payeeSeed)),
    ).toString("hex")}`;
    const draft = stripSignature(
      fixture() as unknown as Record<string, unknown>,
    ) as unknown as ListingDraft;
    draft.seller.identity = {
      bundleVersion: "1",
      presentedBy: payee,
      presentedAt: draft.seller.identity.presentedAt,
      claims: [{ ref: signer }, { ref: payee }],
      presentation: {
        kind: "per-claim",
        signatures: [
          { ref: signer, signature: "signer-presentation" },
          { ref: payee, signature: "payee-presentation" },
        ],
      },
    };
    const signed = await signComponentArtifact(
      draft,
      ARTIFACT_SEPARATORS.Listing,
      {
        algorithm: "ed25519",
        signer,
        sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(signerSeed)),
      },
    );

    expect(isListing(signed)).toBe(true); // Normative signer-membership shape.
    await expect(
      verifyReadableListingArtifact(
        signed as unknown as Record<string, unknown>,
        {
          verify,
          nowMs: () => 1_790_000_000_000,
          resolvePublicKey: (claim) => (claim === signer ? signerKey : null),
        },
      ),
    ).resolves.toBeNull();
  });

  it("preserves an inert unknown field in the signed scope", async () => {
    const listing = fixture() as Listing & {
      futureOptionalMetadata: { displayTier: string };
    };
    listing.futureOptionalMetadata.displayTier = "red";

    expect(isListing(listing)).toBe(true); // CORE §B.7 SIG-5 shape is additive.
    await expect(
      verifyReadableListingArtifact(
        listing as unknown as Record<string, unknown>,
        {
          verify,
          nowMs: () => 1_790_000_000_000,
          resolvePublicKey: (claim) => {
            const encoded = VECTOR.publicKeys[claim];
            return encoded
              ? Uint8Array.from(Buffer.from(encoded, "base64url"))
              : null;
          },
        },
      ),
    ).resolves.toBeNull(); // mutation breaks the original signature.
  });

  it("fails closed on the Standard vector with an unknown phase kind", () => {
    const unknown = structuredClone(
      VECTOR.fixtures["listing-with-unknown-phase"].listing,
    );
    expect(isListing(unknown)).toBe(false);
    expect(readListingArtifact(unknown)).toMatchObject({
      compatibility: "normative",
    });
  });

  it("rejects different payment phase kinds sharing one railId (LRR-4)", () => {
    const listing = fixture();
    listing.acceptedRails = [{ railId: "rail:shared" }];
    listing.pipeline.splice(
      2,
      0,
      { kind: "pay-x402", parameters: { rail: "rail:shared" } },
      { kind: "pay-evm-erc20", parameters: { rail: "rail:shared" } },
    );

    expect(isListing(listing)).toBe(false);
    // The envelope remains readable so ordered validation can return the
    // required step-8 rejection; it is never a valid admitted Listing.
    expect(readListingArtifact(listing)).toMatchObject({
      compatibility: "normative",
    });
  });

  it("does not reinterpret an unsupported signature algorithm as Ed25519", async () => {
    const listing = fixture();
    listing.signature.algorithm = "ecdsa-secp256k1";
    expect(isListing(listing)).toBe(true); // normative envelope, unsupported locally

    await expect(
      verifyReadableListingArtifact(
        listing as unknown as Record<string, unknown>,
        {
          verify: () => true,
          nowMs: () => 1_790_000_000_000,
          resolvePublicKey: () => new Uint8Array(32),
        },
      ),
    ).resolves.toBeNull();
  });

  it("supports HTTPS seller.publicEndpoint without inventing another coordinate", () => {
    const draft = stripSignature(
      fixture() as unknown as Record<string, unknown>,
    ) as unknown as ListingDraft;
    const withEndpoint = {
      ...draft,
      seller: {
        ...draft.seller,
        publicEndpoint: "https://seller.example/.well-known/dacs",
      },
    };
    expect(isListingPublicEndpoint(withEndpoint.seller.publicEndpoint)).toBe(
      true,
    );
    expect(isListingDraft(withEndpoint)).toBe(true);
    expect(
      isListingDraft({
        ...withEndpoint,
        seller: { ...withEndpoint.seller, publicEndpoint: "http://127.0.0.1" },
      }),
    ).toBe(false);
    expect("communication" in withEndpoint).toBe(false);
  });

  it("requires normative seller, version, pricing, pipeline, and signature fields", () => {
    const listing = fixture();
    expect(isListing({ ...listing, seller: undefined })).toBe(false);
    expect(isListing({ ...listing, listingVersion: 0 })).toBe(false);
    expect(isListing({ ...listing, pricing: { kind: "future-price" } })).toBe(
      false,
    );
    expect(
      isListing({
        ...listing,
        pipeline: [{ kind: "negotiate-fixed-price" }],
      }),
    ).toBe(false);
    expect(
      isListing({
        ...listing,
        signature: { ...listing.signature, value: `${listing.signature.value}=` },
      }),
    ).toBe(false);
  });

  it("keeps the legacy-optional method readable but enforces DPA-1 pipeline coherence", () => {
    const listing = fixture();
    const unsigned = stripSignature(
      listing as unknown as Record<string, unknown>,
    ) as unknown as ListingDraft;
    const deliverable = unsigned.offering.deliverable;
    if (deliverable.kind !== "attested-payload") throw new Error("fixture drift");
    delete deliverable.verificationMethod;

    // DACS-4 §9.12 retains the optional wire member, so an historical envelope
    // reaches reader step 7. A current producer/session may not use it.
    expect(isDeliverableSpec(deliverable)).toBe(true);
    expect(isListingDraft(unsigned)).toBe(false);
    const signedWithoutMethod = { ...unsigned, signature: listing.signature };
    expect(isListingEnvelope(signedWithoutMethod)).toBe(true);
    expect(isListing(signedWithoutMethod)).toBe(false);
    expect(readListingArtifact(signedWithoutMethod)).toMatchObject({
      compatibility: "normative",
    });

    for (const verificationMethod of [
      null,
      { kind: "future-method" },
      { kind: "tlsnotary" },
    ]) {
      const malformed = {
        kind: "attested-payload",
        payloadFormat: "application/json",
        verificationMethod,
      };
      expect(isDeliverableSpec(malformed)).toBe(false);
      expect(
        isListingDraft({
          ...unsigned,
          offering: { ...unsigned.offering, deliverable: malformed },
        }),
      ).toBe(false);
    }
  });

  it.each([
    ["blank TLSNotary endpoint", { kind: "tlsnotary", endpoint: "" }],
    ["padded TLSNotary endpoint", { kind: "tlsnotary", endpoint: " https://notary.example " }],
    ["blank zkTLS provider", { kind: "zktls", provider: "", programId: "program" }],
    ["blank zkTLS program", { kind: "zktls", provider: "reclaim", programId: "" }],
    [
      "blank proxy URL template",
      { kind: "consensus-backed-proxy", endpoint: { method: "GET", urlTemplate: "" } },
    ],
    ["blank OAuth provider", { kind: "oauth-attested", provider: "", scopes: ["openid"], maxTokenAgeSec: 60 }],
    ["blank OAuth scope", { kind: "oauth-attested", provider: "oidc", scopes: [""], maxTokenAgeSec: 60 }],
    ["zero EVM chain", { kind: "evm-rpc", chainId: 0, contract: `0x${"1".repeat(40)}`, method: "ownerOf" }],
    ["non-address EVM contract", { kind: "evm-rpc", chainId: 1, contract: "0xabc", method: "ownerOf" }],
    ["blank EVM method", { kind: "evm-rpc", chainId: 1, contract: `0x${"1".repeat(40)}`, method: "" }],
  ])("rejects a verification method with %s at every structural write/envelope gate", (_name, method) => {
    expect(isVerificationMethod(method)).toBe(false);
    const listing = fixture();
    const unsigned = stripSignature(
      listing as unknown as Record<string, unknown>,
    ) as unknown as ListingDraft;
    unsigned.offering.deliverable = {
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: method as never,
    };
    expect(isDeliverableSpec(unsigned.offering.deliverable)).toBe(false);
    expect(isListingDraft(unsigned)).toBe(false);
    expect(isListingEnvelope({ ...unsigned, signature: listing.signature })).toBe(false);
  });
});

describe("explicit legacy Listing read compatibility", () => {
  const legacy = {
    agentId: "did:demos:agent:legacy",
    serviceId: "legacy-service",
    name: "Legacy",
    description: "Historical SDK MVP artifact",
    claimRequirements: [],
    supportedNegotiation: ["negotiate-fixed-price"],
    supportedPaymentRails: ["pay-x402"],
    supportedDelivery: ["deliver-attested-payload"],
  };

  it("reads a legacy signed artifact but never treats it as normative", () => {
    expect(isLegacyMvpListing(legacy)).toBe(true);
    expect(isListing(legacy)).toBe(false);
    expect(
      readListingArtifact({ ...legacy, signature: "legacy-hex-signature" }),
    ).toMatchObject({ compatibility: "legacy-mvp", listing: legacy });
  });

  it("rejects the legacy shape as a new Listing draft", () => {
    expect(isListingDraft(legacy)).toBe(false);
  });
});

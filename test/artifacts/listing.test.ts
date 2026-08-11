import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { verifyReadableListingArtifact } from "../../src/agent/discover.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import { signComponentArtifact } from "../../src/artifacts/signatures.js";
import type { Listing, ListingDraft } from "../../src/artifacts/types.js";
import {
  isLegacyMvpListing,
  isListing,
  isListingDraft,
  isListingPublicEndpoint,
  readListingArtifact,
} from "../../src/artifacts/validators.js";
import { contentHash, stripSignature } from "../../src/canonical/index.js";
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
    expect(readListingArtifact(unknown)).toBeNull();
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

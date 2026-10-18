import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { authenticateReadableListingArtifact, verifyReadableListingArtifact, discoverListings } from "../../src/agent/discover.js";
import { validateListingArtifact, isVerifiedListingAdmission, type ListingValidationDeps } from "../../src/agent/listingValidation.js";
import { runSessionCore, type SessionDeps } from "../../src/agent/runSessionCore.js";
import { contentHash } from "../../src/canonical/index.js";
import { ed25519Sign, ed25519Verify, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey, signedBytes } from "../../src/crypto/index.js";
import type { Listing } from "../../src/artifacts/types.js";

const seed = Uint8Array.from(Buffer.alloc(32, 43));
const publicKey = publicKeyFromSeed(seed);
const seller = `did:demos:agent:${Buffer.from(rawPublicKey(publicKey)).toString("hex")}`;

function listingFixture(): Listing {
  const corpus = JSON.parse(readFileSync(new URL(
    "../../vendor/DACS-Standard/conformance/vectors/security/listing-preserve-unknown-v0.1.json", import.meta.url), "utf8"));
  const listing = corpus.fixtures["listing-with-inert-extension"].listing as Listing & {
    floor: number; magnitude: number;
  };
  listing.seller.identity.presentedBy = seller;
  listing.seller.identity.claims = [{ ref: seller }];
  listing.signature.signer = seller;
  listing.floor = 0;
  listing.magnitude = Number.MAX_SAFE_INTEGER;
  listing.signature.value = Buffer.from(ed25519Sign(
    signedBytes("dacs-listing:v1:", contentHash(listing as unknown as Record<string, unknown>)),
    privateKeyFromSeed(seed),
  )).toString("base64url");
  return listing;
}

function validationDeps(): ListingValidationDeps {
  return {
    executionMode: "simulation",
    nowMs: () => 1_790_000_000_000,
    verifyListingSignature: vi.fn(({ signedBytes: bytes, signature }) =>
      ed25519Verify(bytes, Buffer.from(signature.value, "base64url"), publicKey)),
    revocation: { surfaces: [{ kind: "well-known", status: "active", integrity: "verified" }],
      readMarker: async () => null, verifyMarkerSignature: () => false },
    verifyIdentityPresentation: () => true,
    verifySellerControl: () => true,
    resolvePayloadVerificationCapability: () => ({ disposition: "supported" }),
  };
}

function sessionDeps(value: unknown): SessionDeps {
  return {
    executionMode: "simulation",
    buyerId: seller, buyerIdentityBundle: listingFixture().seller.identity,
    authenticateBuyerIdentityBundle: () => true,
    readListing: async () => value,
    sign: vi.fn(async () => { throw new Error("must not sign"); }),
    signBytes: vi.fn(async () => { throw new Error("must not sign"); }),
    anchor: vi.fn(async () => { throw new Error("must not anchor"); }),
    resolveAnchor: vi.fn(async () => ({ status: "absent" as const })),
    settle: vi.fn(async () => { throw new Error("must not settle"); }),
    validateListing: vi.fn(async () => { throw new Error("must not validate an unadmitted record"); }),
    verifyListing: vi.fn(async () => true),
    newJobId: () => "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
    now: () => "2026-10-17T00:00:00Z", nowMs: () => 1_790_000_000_000,
  };
}

const terms = { price: { amount: "1", asset: "USDC", decimals: 6, rail: "pay-x402" },
  deliveryPhase: "deliver-attested-payload", deliveryFormat: "application/json" };

describe("Listing CF-5 ingress before verification or effects", () => {
  it("requires the simulation marker when binding a verified Listing result", async () => {
    const listing = listingFixture();
    const bytes = Buffer.from(JSON.stringify(listing));
    const result = await validateListingArtifact(bytes, validationDeps());
    expect(result).toMatchObject({ disposition: "verified", executionMode: "simulation" });
    expect(isVerifiedListingAdmission(listing as unknown as Record<string, unknown>, result)).toBe(true);
    const { executionMode: _mode, ...missingMode } = result;
    for (const altered of [missingMode, { ...result, executionMode: "live" }]) {
      expect(isVerifiedListingAdmission(
        listing as unknown as Record<string, unknown>, altered as typeof result,
      )).toBe(false);
      expect(await discoverListings(["listing"], async () => bytes, {
        executionMode: "simulation", trustListings: true,
        nowMs: validationDeps().nowMs, validateListing: () => altered as typeof result,
      })).toEqual([]);
    }
  });

  it("admits a signed unknown signatures extension through the ordered Listing gate", async () => {
    const listing = { ...listingFixture(), signatures: [{ note: "authenticated extension" }] };
    listing.signature.value = Buffer.from(ed25519Sign(
      signedBytes("dacs-listing:v1:", contentHash(listing as unknown as Record<string, unknown>)),
      privateKeyFromSeed(seed),
    )).toString("base64url");
    const deps = validationDeps();
    const bytes = Buffer.from(JSON.stringify(listing));
    expect(await validateListingArtifact(bytes, deps)).toMatchObject({ disposition: "verified", step: 9 });
    expect(await discoverListings(["listing"], async () => bytes, {
      executionMode: "simulation", verify: (payload, signature) => ed25519Verify(payload, signature, publicKey),
      resolvePublicKey: () => rawPublicKey(publicKey), nowMs: deps.nowMs,
      validateListing: (raw, received) => validateListingArtifact(received ?? raw, deps),
    })).toHaveLength(1);
    for (const signatures of [[], [{ note: "tampered" }]]) {
      expect(await validateListingArtifact(Buffer.from(JSON.stringify({ ...listing, signatures })), deps))
        .toMatchObject({ disposition: "rejected", step: 4 });
    }
  });

  it("rejects live validation-result descriptors without invoking them", async () => {
    const bytes = Buffer.from(JSON.stringify(listingFixture()));
    const result = await validateListingArtifact(bytes, validationDeps());
    const getter = vi.fn(() => result.listing);
    const live = Object.defineProperty({ ...result }, "listing", { get: getter, enumerable: true });
    expect(await discoverListings(["listing"], async () => bytes, {
      executionMode: "simulation", trustListings: true,
      nowMs: validationDeps().nowMs, validateListing: () => live,
    })).toEqual([]);
    const session = sessionDeps(bytes);
    session.validateListing = async () => live;
    await expect(runSessionCore("listing", terms, session)).rejects.toThrow(/validator threw/);
    expect(getter).not.toHaveBeenCalled();
    expect(session.sign).not.toHaveBeenCalled();
  });

  it.each([128, 129])("preserves the artifact depth budget at reader/discovery/session boundaries: %s", async (depth) => {
    let tail: unknown = 0;
    for (let index = 1; index < depth; index += 1) tail = { v: tail };
    const listing = { ...listingFixture(), extensionDepth: tail };
    if (depth === 128) {
      listing.signature.value = Buffer.from(ed25519Sign(
        signedBytes("dacs-listing:v1:", contentHash(listing as unknown as Record<string, unknown>)),
        privateKeyFromSeed(seed),
      )).toString("base64url");
    }
    const bytes = Buffer.from(JSON.stringify(listing));
    const deps = validationDeps();
    const result = await validateListingArtifact(bytes, deps);
    expect(result.disposition).toBe(depth === 128 ? "verified" : "rejected");
    expect(await discoverListings(["listing"], async () => bytes, {
      executionMode: "simulation", trustListings: true, nowMs: deps.nowMs,
      validateListing: () => result,
    })).toHaveLength(depth === 128 ? 1 : 0);
    const session = sessionDeps(bytes);
    session.validateListing = vi.fn(async () => result);
    session.verifyListing = vi.fn(() => false);
    if (depth === 128) {
      await expect(runSessionCore("listing", terms, session)).rejects.toThrow(/failed signature verification/);
      expect(session.validateListing).toHaveBeenCalledOnce();
      expect(session.verifyListing).toHaveBeenCalledOnce();
    } else {
      await expect(runSessionCore("listing", terms, session)).rejects.toMatchObject({ code: "JSON-NESTING-TOO-DEEP" });
      expect(session.validateListing).not.toHaveBeenCalled();
    }
    expect(session.sign).not.toHaveBeenCalled();
    expect(session.settle).not.toHaveBeenCalled();
  });

  it.each([verifyReadableListingArtifact, authenticateReadableListingArtifact])(
    "requires original bytes at public authentication before any verifier callback", async (authenticate) => {
      const listing = listingFixture();
      const verify = vi.fn(() => true);
      const deps = { verify, resolvePublicKey: () => rawPublicKey(publicKey), nowMs: () => 1_790_000_000_000 };
      expect(await authenticate(listing as unknown as Record<string, unknown>, deps)).toBeNull();
      expect(verify).not.toHaveBeenCalled();
      const text = JSON.stringify(listing);
      for (const malformed of [text.replace("{", '{"listingId":"ignored",'),
        text.replace('"magnitude":9007199254740991', '"magnitude":9007199254740991.1')]) {
        expect(await authenticate(Buffer.from(malformed), deps)).toBeNull();
      }
      expect(verify).not.toHaveBeenCalled();
      expect(await authenticate(Buffer.from(text), deps)).toMatchObject({ compatibility: "normative" });
      expect(verify).toHaveBeenCalled();
    });

  it("owns the exact internal byte view without invoking shadowed properties", async () => {
    const bytes = new Uint8Array(Buffer.from(JSON.stringify(listingFixture())));
    const getter = vi.fn(() => { throw new Error("must use intrinsic byte slots"); });
    Object.defineProperties(bytes, { length: { get: getter }, byteLength: { get: getter },
      [Symbol.iterator]: { get: getter } });
    const result = await validateListingArtifact(bytes, validationDeps());
    expect(result.disposition).toBe("verified");
    expect(getter).not.toHaveBeenCalled();
  });

  it("bounds the original byte view before allocating or invoking verifiers", async () => {
    const bytes = new Uint8Array(1_048_577);
    const deps = validationDeps();
    expect(await validateListingArtifact(bytes, deps)).toMatchObject({
      disposition: "rejected", reason: "parse:BYTE-LIMIT-EXCEEDED",
    });
    expect(deps.verifyListingSignature).not.toHaveBeenCalled();
    expect(await discoverListings(["listing"], async () => bytes, {
      executionMode: "simulation", trustListings: true,
    })).toEqual([]);
  });

  it.each([
    ["duplicate decoded name", (text: string) => text.replace("{", '{"listingId":"ignored",'), "profile:DUPLICATE-MEMBER"],
    ["pre-rounding unsafe number", (text: string) => text.replace('"magnitude":9007199254740991', '"magnitude":9007199254740991.1'), "profile:NUMBER-OUTSIDE-DACS-MAGNITUDE"],
  ] as const)("refuses %s through the real reader, discovery and session ingress", async (_name, corrupt, reason) => {
    const listing = listingFixture();
    const text = JSON.stringify(listing);
    const wire = Buffer.from(corrupt(text));
    // Both hostile spellings collapse to a validly signed object under JSON.parse.
    expect(contentHash(JSON.parse(wire.toString()) as Record<string, unknown>))
      .toBe(contentHash(listing as unknown as Record<string, unknown>));
    const deps = validationDeps();
    expect(await validateListingArtifact(wire, deps)).toMatchObject({ disposition: "rejected", step: 1, reason });
    expect(deps.verifyListingSignature).not.toHaveBeenCalled();

    const verify = vi.fn(async () => true);
    expect(await discoverListings(["listing"], async () => wire, {
      executionMode: "simulation", verify, validateListing: (raw, bytes) => validateListingArtifact(bytes ?? raw, deps),
    })).toEqual([]);
    expect(verify).not.toHaveBeenCalled();
    const session = sessionDeps(wire);
    await expect(runSessionCore("listing", terms, session)).rejects.toMatchObject({ code: reason.split(":")[1] });
    for (const callback of [session.validateListing, session.verifyListing, session.sign, session.signBytes, session.anchor, session.settle]) {
      expect(callback).not.toHaveBeenCalled();
    }
  });

  it("refuses parsed-only Demos records before verification, hashing admission or payment", async () => {
    const listing = listingFixture();
    const deps = validationDeps();
    expect(await validateListingArtifact(listing as unknown as Record<string, unknown>, deps))
      .toMatchObject({ disposition: "indeterminate", reason: "received-json-bytes-required" });
    expect(deps.verifyListingSignature).not.toHaveBeenCalled();
    const session = sessionDeps(listing);
    await expect(runSessionCore("listing", terms, session)).rejects.toThrow(/CF-5 provenance/);
    expect(session.validateListing).not.toHaveBeenCalled();
    expect(session.settle).not.toHaveBeenCalled();
  });

  it("retains session bytes independently of the ordered validator's byte view", async () => {
    const bytes = Buffer.from(JSON.stringify(listingFixture()));
    const session = sessionDeps(bytes);
    session.validateListing = async (_raw, received) => {
      const result = await validateListingArtifact(received!, validationDeps());
      received!.fill(0);
      return result;
    };
    let verifierBytes: Uint8Array | undefined;
    session.verifyListing = vi.fn((_raw, _seller, received) => {
      verifierBytes = received;
      return false;
    });
    await expect(runSessionCore("listing", terms, session)).rejects.toThrow(/failed signature verification/);
    expect(session.verifyListing).toHaveBeenCalledOnce();
    expect(verifierBytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(verifierBytes!).equals(bytes)).toBe(true);
    expect(session.sign).not.toHaveBeenCalled();
    expect(session.settle).not.toHaveBeenCalled();
  });

  it("verifies exact byte input, preserves received negative zero and binds its evidence", async () => {
    const listing = listingFixture();
    const bytes = Buffer.from(JSON.stringify(listing).replace('"floor":0', '"floor":-0.0'));
    const deps = validationDeps();
    const result = await validateListingArtifact(bytes, deps);
    expect(result).toMatchObject({ disposition: "verified", receivedJsonBase64: bytes.toString("base64"),
      listingContentHash: contentHash(listing as unknown as Record<string, unknown>) });
    expect(isVerifiedListingAdmission(listing as unknown as Record<string, unknown>, result)).toBe(true);
    expect(isVerifiedListingAdmission(listing as unknown as Record<string, unknown>, {
      ...result, receivedJsonBase64: Buffer.from('{"listingId":"a","listingId":"b"}').toString("base64"),
    })).toBe(false);
    expect(await discoverListings(["listing"], async () => bytes, {
      executionMode: "simulation", verify: (payload, signature) => ed25519Verify(payload, signature, publicKey),
      resolvePublicKey: () => rawPublicKey(publicKey), nowMs: deps.nowMs,
      validateListing: (raw, received) => validateListingArtifact(received ?? raw, deps),
    })).toHaveLength(1);
  });
});

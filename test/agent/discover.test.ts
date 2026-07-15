import { describe, expect, test } from "vitest";

import { discoverListings } from "../../src/agent/discover.js";
import {
  buildSignedArtifact,
  verifySignedArtifact,
} from "../../src/agent/signedArtifact.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
} from "../../src/crypto/index.js";

const LISTING = {
  agentId: "did:demos:agent:alice",
  serviceId: "svc",
  name: "Market Data",
  description: "d",
  claimRequirements: [],
  supportedNegotiation: ["negotiate-fixed-price"],
  supportedPaymentRails: ["pay-x402"],
  supportedDelivery: ["deliver-attested-payload"],
  signature: "deadbeef",
};

const store: Record<string, Record<string, unknown>> = {
  "ref:1": LISTING,
  "ref:2": { not: "a listing" },
  "ref:3": { ...LISTING, agentId: "did:demos:agent:bob" },
};
const read = async (ref: string) => store[ref] ?? null;

describe("discoverListings (resolve + validate caller-supplied refs)", () => {
  test("returns only refs that resolve to valid listings, with the signature stripped", async () => {
    const found = await discoverListings(["ref:1", "ref:2", "missing", "ref:3"], read);
    expect(found.map((f) => f.ref)).toEqual(["ref:1", "ref:3"]);
    expect(found[0]!.listing.agentId).toBe("did:demos:agent:alice");
    // returned listing is the signed scope (signature omitted)
    expect("signature" in found[0]!.listing).toBe(false);
  });

  test("skips missing refs without throwing", async () => {
    expect(await discoverListings(["missing", "also-missing"], read)).toEqual([]);
  });

  test("empty input yields empty result", async () => {
    expect(await discoverListings([], read)).toEqual([]);
  });
});

describe("discoverListings signature verification (#41)", () => {
  const seed = Uint8Array.from(Buffer.alloc(32, 33));
  const priv = privateKeyFromSeed(seed);
  const sellerDid = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
  const listing = {
    agentId: sellerDid,
    serviceId: "svc",
    name: "n",
    description: "d",
    claimRequirements: [],
    supportedNegotiation: ["negotiate-fixed-price"],
    supportedPaymentRails: ["pay-x402"],
    supportedDelivery: ["deliver-attested-payload"],
  };
  const verifier = (b: Uint8Array, s: Uint8Array, p: Uint8Array) =>
    ed25519Verify(b, s, publicKeyFromRaw(p));
  const didKey = (did: string) => {
    const hex = did.match(/(?:^|:)(?:0x)?([0-9a-fA-F]{64})$/)?.[1];
    return hex ? Uint8Array.from(Buffer.from(hex, "hex")) : null;
  };
  // Verify a listing's signature under the advertised seller (what a caller wires).
  const verifyListing = async (signed: Record<string, unknown>, sellerId: string) => {
    const key = didKey(sellerId);
    return key ? verifySignedArtifact(signed, ARTIFACT_SEPARATORS.Listing, key, verifier) : false;
  };

  test("a listing validly signed by its seller is returned", async () => {
    const signed = await buildSignedArtifact(listing, ARTIFACT_SEPARATORS.Listing, (b) => ed25519Sign(b, priv));
    const found = await discoverListings(["r"], async () => signed, verifyListing);
    expect(found.map((f) => f.ref)).toEqual(["r"]);
  });

  test("a forged/unsigned listing (fake `signature`) is DROPPED (#41)", async () => {
    const forged = { ...listing, signature: "deadbeef" };
    const found = await discoverListings(["r"], async () => forged, verifyListing);
    expect(found).toEqual([]);
  });

  test("a listing tampered after signing is DROPPED", async () => {
    const signed = await buildSignedArtifact(listing, ARTIFACT_SEPARATORS.Listing, (b) => ed25519Sign(b, priv));
    const tampered = { ...signed, supportedPaymentRails: ["pay-attacker"] }; // swap rail after signing
    const found = await discoverListings(["r"], async () => tampered, verifyListing);
    expect(found).toEqual([]);
  });
});

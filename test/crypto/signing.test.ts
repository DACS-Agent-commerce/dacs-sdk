import { describe, expect, it } from "vitest";

import {
  dacsXSeparator,
  isRegisteredSeparator,
  publicKeyFromSeed,
  rawPublicKey,
  signArtifact,
  SIGNATURE_DOMAIN_SEPARATORS,
  verifyArtifact,
} from "../../src/index.js";

// §7.7 signing vectors (DACS-Standard §14), anchored to the golden vector.
const GOLDEN = {
  seed: "1111111111111111111111111111111111111111111111111111111111111111",
  separator: "dacs-listing:v1:",
  doc: { listingId: "conf-listing", listingVersion: 1 },
  signature:
    "fppio4yI01PfnS1TVphR4g1PYsEAdc8Jt1jhmK96yhWfX7vs41z3WuOacKuJhl0NfgzdLOaOh9VcsA4B3rhDBA",
  publicKeyHex:
    "d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737",
} as const;

const seed = Uint8Array.from(Buffer.from(GOLDEN.seed, "hex"));
const pub = rawPublicKey(publicKeyFromSeed(seed));

describe("signing (§7.7)", () => {
  it("derives the golden public key from the seed", () => {
    expect(Buffer.from(pub).toString("hex")).toBe(GOLDEN.publicKeyHex);
  });

  it("sig-roundtrip: reproduces the golden signature byte-for-byte and verifies", () => {
    const sig = signArtifact(GOLDEN.separator, GOLDEN.doc, seed);
    expect(Buffer.from(sig).toString("base64").replace(/=+$/, "")).toBe(
      GOLDEN.signature,
    );
    expect(verifyArtifact(GOLDEN.separator, GOLDEN.doc, sig, pub)).toBe(true);
  });

  it("sig-tamper: mutating the signed scope breaks verification", () => {
    const sig = signArtifact(GOLDEN.separator, GOLDEN.doc, seed);
    expect(
      verifyArtifact(GOLDEN.separator, { ...GOLDEN.doc, listingVersion: 2 }, sig, pub),
    ).toBe(false);
  });

  it("sig-sig2-cross-domain: a listing signature does not verify as a bundle signature", () => {
    const sig = signArtifact("dacs-listing:v1:", GOLDEN.doc, seed);
    expect(verifyArtifact("dacs-bundle:v1:", GOLDEN.doc, sig, pub)).toBe(false);
  });

  it("sig-registry-closed-16: the domain-separator registry is the closed set of 16", () => {
    expect(SIGNATURE_DOMAIN_SEPARATORS.length).toBe(16);
    expect(new Set(SIGNATURE_DOMAIN_SEPARATORS).size).toBe(16);
  });

  it("sig-sig4-dacsx-disjoint: DACS-X separators are dacs-x-* and disjoint from the registry", () => {
    const x = dacsXSeparator("my-custom-kind");
    expect(x.startsWith("dacs-x-")).toBe(true);
    expect(isRegisteredSeparator(x)).toBe(false);
  });
});

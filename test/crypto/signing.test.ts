import { describe, expect, it } from "vitest";

import {
  autoAcceptInstanceBytes,
  COMPOSITE_DOMAIN_SEPARATORS,
  dacsXSeparator,
  isCompositeSeparator,
  isRegisteredSeparator,
  publicKeyFromSeed,
  rawPublicKey,
  signArtifact,
  signAutoAcceptInstance,
  signSessionBinding,
  SIGNATURE_DOMAIN_SEPARATORS,
  verifyArtifact,
  verifyAutoAcceptInstance,
  verifySessionBinding,
} from "../../src/index.js";

// §B.7 signing vectors (DACS-Standard), anchored to the golden vector.
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

describe("signing (§B.7)", () => {
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

  it("sig-registry-closed-28: the registry is the full closed §B.7 set of 28", () => {
    expect(SIGNATURE_DOMAIN_SEPARATORS.length).toBe(28);
    expect(new Set(SIGNATURE_DOMAIN_SEPARATORS).size).toBe(28);
    // Exact §B.7 membership added since the original 18-entry registry.
    for (const sep of [
      "dacs-finality-commitment:v1:",
      "dacs-bundle-binding:v1:",
      "dacs-fault-bundle-pointer:v1:",
      "dacs-evidence-bound-fault-bundle:v1:",
      "dacs-evidence-bound-fault-bundle-pointer:v1:",
      "dacs-prior-payment-disposition:v1:",
      "dacs-session-binding:v1:",
      "dacs-auto-accept-commitment:v1:",
      "dacs-auto-accept-instance:v1:",
      "dacs-payload-attestation:v1:",
      "dacs-evidence-bound-fault-bundle:v1:",
      "dacs-evidence-bound-fault-bundle-pointer:v1:",
      "dacs-prior-payment-disposition:v1:",
    ] as const) {
      expect(isRegisteredSeparator(sep)).toBe(true);
    }
    // The non-signature hash-domain tags are NOT signature separators (§B.7).
    expect(isRegisteredSeparator("dacs-sealed-bid:v1:")).toBe(false);
    expect(isRegisteredSeparator("dacs-sb3:v1:")).toBe(false);
    expect(isRegisteredSeparator("dacs-ap2-idem:v1:")).toBe(false);
  });

  it("662be1d: the three separators added with the pin sign + verify generically", () => {
    for (const sep of [
      "dacs-prior-payment-disposition:v1:",
      "dacs-evidence-bound-fault-bundle:v1:",
      "dacs-evidence-bound-fault-bundle-pointer:v1:",
    ] as const) {
      const sig = signArtifact(sep, GOLDEN.doc, seed);
      expect(verifyArtifact(sep, GOLDEN.doc, sig, pub)).toBe(true);
      expect(verifyArtifact("dacs-listing:v1:", GOLDEN.doc, sig, pub)).toBe(false);
    }
  });

  it("the added single-hash domains sign + verify generically", () => {
    for (const sep of [
      "dacs-finality-commitment:v1:",
      "dacs-bundle-binding:v1:",
      "dacs-fault-bundle-pointer:v1:",
      "dacs-auto-accept-commitment:v1:",
      "dacs-evidence-bound-fault-bundle:v1:",
      "dacs-evidence-bound-fault-bundle-pointer:v1:",
      "dacs-prior-payment-disposition:v1:",
    ] as const) {
      const sig = signArtifact(sep, GOLDEN.doc, seed);
      expect(verifyArtifact(sep, GOLDEN.doc, sig, pub)).toBe(true);
      // Cross-domain: does not verify under a different separator (SIG-2).
      expect(verifyArtifact("dacs-listing:v1:", GOLDEN.doc, sig, pub)).toBe(false);
    }
  });

  it("#86: the generic single-hash signer REJECTS composite separators", () => {
    // Signing a composite-payload separator as a single hash would sign the
    // wrong bytes — signArtifact must throw, verifyArtifact must fail closed.
    expect(COMPOSITE_DOMAIN_SEPARATORS).toEqual([
      "dacs-session-binding:v1:",
      "dacs-auto-accept-instance:v1:",
    ]);
    for (const sep of COMPOSITE_DOMAIN_SEPARATORS) {
      expect(isCompositeSeparator(sep)).toBe(true);
      expect(() => signArtifact(sep, GOLDEN.doc, seed)).toThrow();
      expect(verifyArtifact(sep, GOLDEN.doc, new Uint8Array(64), pub)).toBe(false);
    }
    // auto-accept-COMMITMENT is single-hash despite the family name.
    expect(isCompositeSeparator("dacs-auto-accept-commitment:v1:")).toBe(false);
  });

  describe("#86 composite recipes (§B.7)", () => {
    // Two distinct 64-char lowercase hex values to frame.
    const a = "a".repeat(64);
    const b = "b".repeat(64);

    it("session-binding: sign + verify round-trips and is tamper-evident", () => {
      const sig = signSessionBinding(a, b, seed);
      expect(verifySessionBinding(a, b, sig, pub)).toBe(true);
      // Swapping the framed values changes the payload → fails (SIG-3).
      expect(verifySessionBinding(b, a, sig, pub)).toBe(false);
    });

    it("auto-accept-instance: sign + verify round-trips and is tamper-evident", () => {
      const sig = signAutoAcceptInstance(a, b, seed);
      expect(verifyAutoAcceptInstance(a, b, sig, pub)).toBe(true);
      expect(verifyAutoAcceptInstance(b, a, sig, pub)).toBe(false);
    });

    it("cross-domain: the two composite recipes never validate each other (SIG-2)", () => {
      const sb = signSessionBinding(a, b, seed);
      const ai = signAutoAcceptInstance(a, b, seed);
      expect(verifyAutoAcceptInstance(a, b, sb, pub)).toBe(false);
      expect(verifySessionBinding(a, b, ai, pub)).toBe(false);
    });

    it("distinct byte layouts: same framed inputs → different signed_bytes", () => {
      expect(Buffer.from(autoAcceptInstanceBytes(a, b)).toString("hex")).not.toBe(
        Buffer.from(autoAcceptInstanceBytes(b, a)).toString("hex"),
      );
    });

    it("fail-closed: a non-64-hex framed value is rejected before signing", () => {
      expect(() => signSessionBinding("tooshort", b, seed)).toThrow();
      expect(() => signAutoAcceptInstance(a, "XYZ", seed)).toThrow();
      // Upper-case hex is not the canonical lowercase form.
      expect(() => signSessionBinding("A".repeat(64), b, seed)).toThrow();
    });
  });

  it("#62: the DACS-3 payee-bound agreement separator is registered", () => {
    expect(isRegisteredSeparator("dacs-payee-bound-agreement:v1:")).toBe(true);
  });

  it("#62: payee-bound and legacy agreement signatures are cross-domain (SIG-2)", () => {
    // A signature under dacs-agreement:v1: MUST NOT verify as a payee-bound
    // agreement, and vice versa — the whole point of a distinct domain.
    const legacy = signArtifact("dacs-agreement:v1:", GOLDEN.doc, seed);
    expect(verifyArtifact("dacs-payee-bound-agreement:v1:", GOLDEN.doc, legacy, pub)).toBe(false);
    const payeeBound = signArtifact("dacs-payee-bound-agreement:v1:", GOLDEN.doc, seed);
    expect(verifyArtifact("dacs-agreement:v1:", GOLDEN.doc, payeeBound, pub)).toBe(false);
    // …each still verifies under its own domain.
    expect(verifyArtifact("dacs-payee-bound-agreement:v1:", GOLDEN.doc, payeeBound, pub)).toBe(true);
  });

  it("sig-sig4-dacsx-disjoint: DACS-X separators are dacs-x-* and disjoint from the registry", () => {
    const x = dacsXSeparator("my-custom-kind");
    expect(x.startsWith("dacs-x-")).toBe(true);
    expect(isRegisteredSeparator(x)).toBe(false);
  });
});

import { readFileSync } from "node:fs";
import { contentHash } from "../../src/canonical/hash.js";
import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import { ed25519Sign, privateKeyFromSeed } from "../../src/crypto/ed25519.js";
import { signedBytes } from "../../src/crypto/signing.js";
import { identityBundleHash } from "../../src/identity/bundle.js";
import { attestationBundleHash } from "../../src/agent/twoSidedBundle.js";
import type { IdentityBundle, AnyAttestationBundle } from "../../src/artifacts/types.js";
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
  it("authenticates an unknown signatures extension for a single-signature artifact", () => {
    const doc = { ...GOLDEN.doc, signatures: [{ note: "signed extension" }] };
    const sig = signArtifact(GOLDEN.separator, doc, seed);
    expect(verifyArtifact(GOLDEN.separator, doc, sig, pub)).toBe(true);
    expect(verifyArtifact(GOLDEN.separator, { ...doc, signatures: [] }, sig, pub)).toBe(false);
    expect(verifyArtifact(GOLDEN.separator, GOLDEN.doc, sig, pub)).toBe(false);
    const original = signArtifact(GOLDEN.separator, GOLDEN.doc, seed);
    expect(verifyArtifact(GOLDEN.separator, doc, original, pub)).toBe(false);
  });

  it("uses the plural signature field only for an Agreement contract", () => {
    const doc = { value: "agreement", signature: "signed extension" };
    const sig = signArtifact("dacs-agreement:v1:", doc, seed);
    expect(verifyArtifact("dacs-agreement:v1:", { ...doc, signatures: [] }, sig, pub)).toBe(true);
    expect(verifyArtifact("dacs-agreement:v1:", { ...doc, signature: "changed" }, sig, pub)).toBe(false);
  });

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

  it("sig-registry-closed-30: the registry is the full closed §B.7 set of 30", () => {
    expect(SIGNATURE_DOMAIN_SEPARATORS.length).toBe(30);
    expect(new Set(SIGNATURE_DOMAIN_SEPARATORS).size).toBe(30);
    // Exact §B.7 membership added since the original 18-entry registry.
    for (const sep of [
      "dacs-finality-commitment:v1:",
      "dacs-bundle-binding:v1:",
      "dacs-fault-bundle-pointer:v1:",
      "dacs-evidence-bound-fault-bundle-pointer:v1:",
      "dacs-prior-payment-disposition:v1:",
      "dacs-session-binding:v1:",
      "dacs-auto-accept-commitment:v1:",
      "dacs-auto-accept-instance:v1:",
      "dacs-payload-attestation:v1:",
      "dacs-evidence-bound-fault-bundle-pointer:v1:",
      "dacs-prior-payment-disposition:v1:",
    ] as const) {
      expect(isRegisteredSeparator(sep)).toBe(true);
    }
    expect(isRegisteredSeparator("dacs-evidence-bound-fault-bundle:v1:")).toBe(true);
    // The non-signature hash-domain tags are NOT signature separators (§B.7).
    expect(isRegisteredSeparator("dacs-sealed-bid:v1:")).toBe(false);
    expect(isRegisteredSeparator("dacs-sb3:v1:")).toBe(false);
    expect(isRegisteredSeparator("dacs-ap2-idem:v1:")).toBe(false);
  });

  it("662be1d: disposition and pointer domains sign + verify generically", () => {
    for (const sep of [
      "dacs-prior-payment-disposition:v1:",
      "dacs-evidence-bound-fault-bundle-pointer:v1:",
    ] as const) {
      const sig = signArtifact(sep, GOLDEN.doc, seed);
      expect(verifyArtifact(sep, GOLDEN.doc, sig, pub)).toBe(true);
      expect(verifyArtifact("dacs-listing:v1:", GOLDEN.doc, sig, pub)).toBe(false);
    }
  });

  it("adopted identity-bound domains sign and remain distinct from legacy agreements", () => {
    for (const sep of ["dacs-identity-bound-agreement:v1:", "dacs-identity-bound-payee-agreement:v1:"] as const) {
      const sig = signArtifact(sep, GOLDEN.doc, seed);
      expect(verifyArtifact(sep, GOLDEN.doc, sig, pub)).toBe(true);
      expect(verifyArtifact("dacs-agreement:v1:", GOLDEN.doc, sig, pub)).toBe(false);
      expect(verifyArtifact("dacs-payee-bound-agreement:v1:", GOLDEN.doc, sig, pub)).toBe(false);
    }
  });

  it("the added single-hash domains sign + verify generically", () => {
    for (const sep of [
      "dacs-finality-commitment:v1:",
      "dacs-bundle-binding:v1:",
      "dacs-fault-bundle-pointer:v1:",
      "dacs-auto-accept-commitment:v1:",
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


describe("artifact-specific signature scopes", () => {
  const fixture = (name: string) => JSON.parse(readFileSync(new URL(
    `../../vendor/DACS-Standard/conformance/vectors/examples/${name}.json`, import.meta.url,
  ), "utf8")).artifact as Record<string, unknown>;

  it("requires the specialized IdentityBundle path for both correct- and wrong-scope signatures", () => {
    const bundle = fixture("identity-bundle");
    const original = identityBundleHash(bundle as unknown as IdentityBundle);
    expect(contentHash(bundle)).not.toBe(original);
    expect(identityBundleHash({ ...bundle, presentation: { kind: "per-claim", signatures: [] } } as unknown as IdentityBundle))
      .toBe(original);
    for (const hash of [original, contentHash(bundle)]) {
      const signature = ed25519Sign(signedBytes("dacs-bundle-presentation:v1:", hash), privateKeyFromSeed(seed));
      expect(verifyArtifact("dacs-bundle-presentation:v1:", bundle, signature, pub)).toBe(false);
    }
    expect(() => signArtifact("dacs-bundle-presentation:v1:", bundle, seed)).toThrow(/artifact-specific/);
  });

  it.each(["dacs-bundle:v1:", "dacs-fault-bundle:v1:", "dacs-evidence-bound-fault-bundle:v1:"] as const)(
    "%s refuses generic signing and verification of a real terminal bundle", (separator) => {
      const bundle = separator === "dacs-bundle:v1:" ? fixture("attestation-bundle")
        : separator === "dacs-fault-bundle:v1:"
          ? JSON.parse(readFileSync(new URL("../fixtures/standard-next/fab-bundle-extended-pointer-v0.3.json", import.meta.url), "utf8")).vectors[0].dereferenced
          : JSON.parse(readFileSync(new URL("../fixtures/standard-next/evidence-bound-fault-bundle-compatibility-v0.4.json", import.meta.url), "utf8")).cases[0].bundle;
      const original = attestationBundleHash(bundle as unknown as AnyAttestationBundle);
      expect(contentHash(bundle, "signatures")).not.toBe(original);
      const changed = { ...bundle, anchoredByRole: "seller", signatures: [] };
      expect(attestationBundleHash(changed as unknown as AnyAttestationBundle)).toBe(original);
      const { signatures: _signatures, anchoredByRole: _role, ...scope } = bundle;
      expect(sha256Hex(canonicalize(scope))).toBe(original);
      // A wrong-scope signature used to be accepted by the generic verifier.
      for (const hash of [original, contentHash(bundle, "signatures")]) {
        const signature = ed25519Sign(signedBytes(separator, hash), privateKeyFromSeed(seed));
        expect(verifyArtifact(separator, bundle, signature, pub)).toBe(false);
      }
      expect(() => signArtifact(separator, bundle, seed)).toThrow(/artifact-specific/);
      // Refusal precedes key conversion, even for a type-erased invalid key.
      expect(() => signArtifact(separator, bundle, new Uint8Array())).toThrow(/artifact-specific/);
    },
  );

  it("transcript signatures survive envelope attachment and co-signing, and bind a singular extension", () => {
    const transcript = { transcriptVersion: "1", channelId: "channel-1",
      members: ["did:example:buyer", "did:example:seller"], messages: [], generatedAt: 1780358400000,
      signature: { extension: "retained" } };
    const separator = "dacs-transcript:v1:";
    const signature = signArtifact(separator, transcript, seed);
    const independentlySigned = ed25519Sign(signedBytes(separator, contentHash(transcript, "signatures")), privateKeyFromSeed(seed));
    expect(signature).toEqual(independentlySigned);
    for (const signatures of [[], [{ signature: Buffer.from(signature).toString("base64url") }],
      [{ signature: "cosignature" }, { signature: "other" }]]) {
      expect(verifyArtifact(separator, { ...transcript, signatures }, signature, pub)).toBe(true);
    }
    expect(verifyArtifact(separator, { ...transcript, signature: { extension: "changed" } }, signature, pub)).toBe(false);
    expect(verifyArtifact(separator, { ...transcript, generatedAt: transcript.generatedAt + 1 }, signature, pub)).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  buildComponentSignature,
  ed25519Sign,
  ed25519Verify,
  isComponentSignature,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
  signComponentArtifact,
  verifyComponentSignature,
  type ComponentSignature,
  type VerifyComponentSignatureDeps,
} from "../../src/index.js";

const seed = new Uint8Array(32).fill(11);
const privateKey = privateKeyFromSeed(seed);
const publicKey = rawPublicKey(publicKeyFromSeed(seed));
const seller = "did:demos:agent:seller";
const outsider = "did:demos:agent:outsider";

const listing = {
  listingVersion: "1",
  seller,
  service: "market-data",
};

const sign = (bytes: Uint8Array) => ed25519Sign(bytes, privateKey);

function deps(
  overrides: Partial<VerifyComponentSignatureDeps<Uint8Array>> = {},
): VerifyComponentSignatureDeps<Uint8Array> {
  return {
    isSignerAuthorized: (artifact, signature) =>
      signature.signer === artifact["seller"],
    resolvePublicKey: () => publicKey,
    verify: ({ signedBytes, signature, publicKey: key }) =>
      ed25519Verify(
        signedBytes,
        Buffer.from(signature.value, "base64"),
        publicKeyFromRaw(key),
      ),
    ...overrides,
  };
}

describe("ComponentSignature foundation", () => {
  it("builds the normative algorithm/signer/value envelope", async () => {
    const signature = await buildComponentSignature(
      listing,
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: seller, sign },
    );

    expect(signature).toEqual({
      algorithm: "ed25519",
      signer: seller,
      value: expect.any(String),
    });
    expect(isComponentSignature(signature)).toBe(true);
  });

  it("signs then verifies a standalone artifact", async () => {
    const signed = await signComponentArtifact(
      listing,
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: seller, sign },
    );

    await expect(
      verifyComponentSignature(signed, "dacs-listing:v1:", deps()),
    ).resolves.toMatchObject({ status: "valid" });
  });

  it("preserves unknown fields in the signed scope (SIG-5)", async () => {
    const signed = await signComponentArtifact(
      { ...listing, futureMinorField: "hash-bound" },
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: seller, sign },
    );

    await expect(
      verifyComponentSignature(signed, "dacs-listing:v1:", deps()),
    ).resolves.toMatchObject({ status: "valid" });
    await expect(
      verifyComponentSignature(
        { ...signed, futureMinorField: "tampered" },
        "dacs-listing:v1:",
        deps(),
      ),
    ).resolves.toEqual({
      status: "invalid",
      reason: "cryptographic-verification-failed",
      signature: signed.signature,
    });
  });

  it("rejects cross-domain signature reuse", async () => {
    const signed = await signComponentArtifact(
      listing,
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: seller, sign },
    );

    await expect(
      verifyComponentSignature(signed, "dacs-evidence:v1:", deps()),
    ).resolves.toMatchObject({
      status: "invalid",
      reason: "cryptographic-verification-failed",
    });
  });

  it("reports missing and malformed envelopes explicitly", async () => {
    await expect(
      verifyComponentSignature(listing, "dacs-listing:v1:", deps()),
    ).resolves.toEqual({ status: "missing" });

    await expect(
      verifyComponentSignature(
        {
          ...listing,
          signature: { algorithm: "rsa", signer: seller, value: "sig" },
        },
        "dacs-listing:v1:",
        deps(),
      ),
    ).resolves.toEqual({
      status: "malformed",
      reason: "unsupported-algorithm",
    });
  });

  it("requires artifact-specific signer authorisation", async () => {
    const signed = await signComponentArtifact(
      listing,
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: outsider, sign },
    );
    const resolvePublicKey = vi.fn(() => publicKey);

    await expect(
      verifyComponentSignature(
        signed,
        "dacs-listing:v1:",
        deps({ resolvePublicKey }),
      ),
    ).resolves.toEqual({
      status: "invalid",
      reason: "signer-not-authorized",
      signature: signed.signature,
    });
    expect(resolvePublicKey).not.toHaveBeenCalled();
  });

  it("does not collapse an unresolvable signer into invalid", async () => {
    const signed = await signComponentArtifact(
      listing,
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: seller, sign },
    );

    await expect(
      verifyComponentSignature(
        signed,
        "dacs-listing:v1:",
        deps({ resolvePublicKey: () => null }),
      ),
    ).resolves.toEqual({
      status: "unresolved",
      reason: "signer-key-not-found",
      signature: signed.signature,
    });
  });

  it("rejects signing an artifact that already carries signature material", async () => {
    const existing: ComponentSignature = {
      algorithm: "ed25519",
      signer: seller,
      value: "already-signed",
    };

    await expect(
      signComponentArtifact(
        { ...listing, signature: existing },
        "dacs-listing:v1:",
        { algorithm: "ed25519", signer: seller, sign },
      ),
    ).rejects.toThrow("requires an unsigned artifact");
  });
});

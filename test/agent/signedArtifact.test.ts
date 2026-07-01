import { describe, expect, test } from "vitest";

import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
} from "../../src/crypto/index.js";
import {
  buildSignedArtifact,
  verifySignedArtifact,
} from "../../src/agent/signedArtifact.js";

const seed = new Uint8Array(32).fill(7);
const privKey = privateKeyFromSeed(seed);
const pub = rawPublicKey(publicKeyFromSeed(seed));

const sign = (b: Uint8Array) => ed25519Sign(b, privKey);
const verify = (b: Uint8Array, sig: Uint8Array, pk: Uint8Array) =>
  ed25519Verify(b, sig, publicKeyFromRaw(pk));

describe("signed artifact envelope (T4)", () => {
  const listing = {
    agentId: "did:demos:agent:alice",
    serviceId: "svc-1",
    name: "Market Data",
  };

  test("build then verify round-trips", async () => {
    const signed = await buildSignedArtifact(listing, "dacs-listing:v1:", sign);
    expect(typeof signed.signature).toBe("string");
    expect(
      await verifySignedArtifact(signed, "dacs-listing:v1:", pub, verify),
    ).toBe(true);
  });

  test("tampering a field breaks verification", async () => {
    const signed = await buildSignedArtifact(listing, "dacs-listing:v1:", sign);
    const tampered = { ...signed, name: "Tampered" };
    expect(
      await verifySignedArtifact(tampered, "dacs-listing:v1:", pub, verify),
    ).toBe(false);
  });

  test("a different separator breaks verification (no cross-kind reuse)", async () => {
    const signed = await buildSignedArtifact(listing, "dacs-listing:v1:", sign);
    expect(
      await verifySignedArtifact(signed, "dacs-agreement:v1:", pub, verify),
    ).toBe(false);
  });

  test("missing signature returns false", async () => {
    expect(
      await verifySignedArtifact(listing, "dacs-listing:v1:", pub, verify),
    ).toBe(false);
  });
});

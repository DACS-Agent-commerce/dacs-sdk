import {
  contentHash, stripSignature, signArtifact, signedBytes,
  ed25519Verify, publicKeyFromRaw, publicKeyFromSeed, rawPublicKey,
} from "../../src/index.js";

// The frozen upstream v0.6 oracle predates JID-1. Current projection tests use
// freshly signed test-owned copies; original wire bytes remain unchanged.
const seed = new Uint8Array(32).fill(42);
export const currentVectorPublicKey = rawPublicKey(publicKeyFromSeed(seed));
export function currentSettlementVector<T>(original: T, originalPublicKey: Uint8Array): T {
  const value = JSON.parse(JSON.stringify(original)
    .replaceAll("job-315-a", "01JZ0000000000000000000360")
    .replaceAll("job-315-b", "01JZ0000000000000000000361")
    .replaceAll("wrong-job", "01JZ0000000000000000000362"));
  const source = (original as any).settlementEvidence;
  const signature = source.signature;
  // Preserve the oracle's deliberately invalid signature cases.
  if (ed25519Verify(signedBytes("dacs-evidence:v1:", contentHash(stripSignature(source))),
      Uint8Array.from(Buffer.from(signature.value, "base64url")), publicKeyFromRaw(originalPublicKey))) {
    value.settlementEvidence.signature.value = Buffer.from(signArtifact(
      "dacs-evidence:v1:", stripSignature(value.settlementEvidence), seed,
    )).toString("base64url");
  }
  return value;
}

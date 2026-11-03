import {
  stripSignature, signArtifact, signedBytes, contentHash,
  ed25519Verify, publicKeyFromRaw, publicKeyFromSeed, rawPublicKey,
} from "../../src/index.js";

/** Freshly sign a test-owned canonical-ID copy of a frozen pre-JID-1 oracle. */
export function currentBundleFixture(bundle: Record<string, unknown>, seeds: Record<string, string>) {
  const copy = structuredClone(bundle) as any;
  copy.jobId = "01JZ0000000000000000000360";
  const originalScope = stripSignature(bundle);
  delete originalScope.anchoredByRole;
  const scope = stripSignature(copy);
  delete scope.anchoredByRole;
  const separator = "dacs-bundle:v1:";
  copy.signatures = (copy.signatures ?? []).map((signature: any) => {
    const seed = Uint8Array.from(Buffer.from(seeds[signature.party.replace("did:demos:", "")]!, "hex"));
    const valid = ed25519Verify(signedBytes(separator, contentHash(originalScope)),
      Uint8Array.from(Buffer.from(signature.value, "base64url")),
      publicKeyFromRaw(rawPublicKey(publicKeyFromSeed(seed))));
    return valid ? { ...signature, value: Buffer.from(signArtifact(separator, scope, seed)).toString("base64url") }
      : signature;
  });
  return copy;
}

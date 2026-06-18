import { contentHash, stripSignature } from "../canonical/index.js";
import { signedBytes } from "../crypto/index.js";
import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import type { AttestationBundle } from "../artifacts/types.js";
import { isAttestationBundle } from "../artifacts/validators.js";
import { type Verifier } from "./signedArtifact.js";

/**
 * Attestation-bundle verification (DACS-5). The bundle's signed scope is its
 * canonical form omitting `signatures` + `anchoredByRole` (§10.4.1); each entry
 * in `signatures[]` is an Ed25519 signature over
 * `signedBytes("dacs-bundle:v1:", contentHash(scope))` by a party. We resolve
 * each party's key and check its signature. Verdicts are honestly four-stated:
 * `valid` (a resolved key verified it), `invalid` (a usable key resolved but
 * didn't match — tampering/wrong key), `error` (a key resolved but is malformed
 * — §10.4.1 ERROR, not a false-negative FAIL), `unverified` (no key resolvable).
 *
 * The bundle's artifact refs (listingRef / agreementRef / vetRecords /
 * settlementEvidence) are content-addressed (`{kind,id,contentHash}`), so
 * integrity is bound by the bundle's own signed hash rather than by resolving
 * each ref on the substrate.
 */

export type SignatureVerdict = "valid" | "invalid" | "error" | "unverified";

export interface SignatureCheck {
  party: string;
  verdict: SignatureVerdict;
}

export interface BundleVerification {
  /** At least one signature verified and none are invalid/error. */
  ok: boolean;
  reason?: string;
  /** Every signature verified against a resolved key. */
  fullyVerified: boolean;
  bundle?: AttestationBundle;
  signatures: SignatureCheck[];
}

export interface VerifyBundleDeps {
  /** Read a signed artifact at a ref (null if absent). */
  readArtifact: (ref: string) => Promise<Record<string, unknown> | null>;
  /** Resolve a signer DID/claim to its ed25519 public key (null if unknown). */
  resolvePublicKey: (did: string) => Promise<Uint8Array | null>;
  /** Verify a signature over raw bytes for a public key. */
  verify: Verifier;
}

export async function verifyBundleCore(
  bundleRef: string,
  deps: VerifyBundleDeps,
): Promise<BundleVerification> {
  const raw = await deps.readArtifact(bundleRef);
  if (!raw || !isAttestationBundle(stripSignature(raw))) {
    return {
      ok: false,
      reason: "not an attestation bundle",
      fullyVerified: false,
      signatures: [],
    };
  }
  const bundle = stripSignature(raw) as unknown as AttestationBundle;

  // Signed scope = canonical form omitting signatures + anchoredByRole (§10.4.1).
  const scope = { ...raw };
  delete scope["signatures"];
  delete scope["anchoredByRole"];
  const message = signedBytes(
    ARTIFACT_SEPARATORS.AttestationBundle,
    contentHash(scope),
  );

  const sigs = Array.isArray(raw["signatures"])
    ? (raw["signatures"] as Array<{ party?: unknown; value?: unknown }>)
    : [];

  const signatures: SignatureCheck[] = [];
  for (const s of sigs) {
    const party = typeof s.party === "string" ? s.party : "";
    const key = await deps.resolvePublicKey(party);
    let verdict: SignatureVerdict;
    if (!key) {
      verdict = "unverified";
    } else if (key.length !== 32) {
      // Malformed resolved key — can't evaluate; ERROR, not a false FAIL.
      verdict = "error";
    } else {
      const sigBytes = Uint8Array.from(
        Buffer.from(typeof s.value === "string" ? s.value : "", "base64url"),
      );
      verdict = (await deps.verify(message, sigBytes, key)) ? "valid" : "invalid";
    }
    signatures.push({ party, verdict });
  }

  const anyInvalid = signatures.some((c) => c.verdict === "invalid");
  const anyError = signatures.some((c) => c.verdict === "error");
  const anyValid = signatures.some((c) => c.verdict === "valid");
  const fullyVerified =
    signatures.length > 0 && signatures.every((c) => c.verdict === "valid");

  return {
    ok: anyValid && !anyInvalid && !anyError,
    reason:
      signatures.length === 0
        ? "bundle has no signatures"
        : anyInvalid
          ? "one or more signatures failed verification"
          : anyError
            ? "one or more signer keys were malformed (could not verify)"
            : anyValid
              ? undefined
              : "no signer key could be resolved",
    fullyVerified,
    bundle,
    signatures,
  };
}

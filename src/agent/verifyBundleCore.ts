import { stripSignature } from "../canonical/index.js";
import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import type { ArtifactKind, AttestationBundle } from "../artifacts/types.js";
import {
  isAgreementDocument,
  isAttestationBundle,
  isCompositeVerificationRecord,
  isListing,
  isSettlementEvidence,
} from "../artifacts/validators.js";
import { verifySignedArtifact, type Verifier } from "./signedArtifact.js";

/**
 * Full attestation-bundle verification (T4 follow-up). Beyond the structural
 * check (every referenced artifact resolves), this recomputes and checks each
 * artifact's §7.7 signature against the public key its claimed signer resolves
 * to via CCI. Signatures are honestly four-stated: `valid` (a resolved key
 * verified it), `invalid` (a usable key resolved but no signature matched —
 * tampering or wrong key), `error` (a key resolved but is malformed, e.g.
 * wrong length, so it can't be evaluated — §10.4.1: an ERROR, never a
 * false-negative FAIL), `unverified` (no key could be resolved at all).
 */

export type SignatureVerdict = "valid" | "invalid" | "error" | "unverified";

export interface ArtifactVerification {
  ref: string;
  resolved: boolean;
  kind: ArtifactKind | "unknown";
  signature: SignatureVerdict;
  /** The signer DID whose resolved key validated the signature, if any. */
  signer?: string;
}

export interface BundleVerification {
  /** Structurally complete (all artifacts resolve) AND no invalid/error signatures. */
  ok: boolean;
  reason?: string;
  /** True only if every signature (bundle + artifacts) verified against a key. */
  fullyVerified: boolean;
  bundle?: AttestationBundle;
  /** The bundle's own signature verdict. */
  bundleSignature: SignatureVerdict;
  artifacts: ArtifactVerification[];
}

export interface VerifyBundleDeps {
  /** Read a signed artifact at a ref (null if absent). */
  readArtifact: (ref: string) => Promise<Record<string, unknown> | null>;
  /** Resolve a signer DID/claim to its ed25519 public key (null if unknown). */
  resolvePublicKey: (did: string) => Promise<Uint8Array | null>;
  /** Verify a signature over raw bytes for a public key. */
  verify: Verifier;
}

/** Best-effort kind detection from a signed artifact's shape (signature stripped). */
function detectKind(obj: Record<string, unknown>): ArtifactKind | "unknown" {
  const scope = stripSignature(obj);
  if (isListing(scope)) return "Listing";
  if (isAgreementDocument(scope)) return "AgreementDocument";
  if (isSettlementEvidence(scope)) return "SettlementEvidence";
  if (isCompositeVerificationRecord(scope)) return "CompositeVerificationRecord";
  if (isAttestationBundle(scope)) return "AttestationBundle";
  return "unknown";
}

/** The DIDs that could legitimately have signed an artifact of this kind. */
function candidateSigners(
  kind: ArtifactKind | "unknown",
  artifact: Record<string, unknown>,
  bundle: AttestationBundle,
): string[] {
  const str = (v: unknown): string[] => (typeof v === "string" ? [v] : []);
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  switch (kind) {
    case "Listing":
      return str(artifact["agentId"]);
    case "AgreementDocument":
      return [...str(artifact["buyer"]), ...str(artifact["seller"])];
    case "CompositeVerificationRecord":
      return str(artifact["subject"]);
    case "SettlementEvidence":
      // Evidence carries no signer DID — the session's signatories did.
      return bundle.signedBy;
    case "AttestationBundle":
      return arr(artifact["signedBy"]);
    default:
      return bundle.signedBy;
  }
}

/**
 * Verify one signed artifact against its candidate signers' resolved keys.
 * Returns `valid` on the first key that verifies, `invalid` if at least one key
 * resolved but none matched, `unverified` if no key could be resolved.
 */
async function verifyOne(
  ref: string,
  kind: ArtifactKind | "unknown",
  artifact: Record<string, unknown>,
  bundle: AttestationBundle,
  deps: VerifyBundleDeps,
): Promise<ArtifactVerification> {
  if (kind === "unknown") {
    return { ref, resolved: true, kind, signature: "unverified" };
  }
  const separator = ARTIFACT_SEPARATORS[kind];
  let anyUsableKey = false;
  let anyMalformedKey = false;
  for (const did of candidateSigners(kind, artifact, bundle)) {
    const key = await deps.resolvePublicKey(did);
    if (!key) continue;
    // A resolved-but-malformed key can't be evaluated — that's an ERROR, not a
    // FAIL (§10.4.1). Skip it; another candidate may still verify cleanly.
    if (key.length !== 32) {
      anyMalformedKey = true;
      continue;
    }
    anyUsableKey = true;
    if (await verifySignedArtifact(artifact, separator, key, deps.verify)) {
      return { ref, resolved: true, kind, signature: "valid", signer: did };
    }
  }
  const signature: SignatureVerdict = anyUsableKey
    ? "invalid" // a usable key existed but none matched → genuine mismatch
    : anyMalformedKey
      ? "error" // only malformed keys resolved → cannot decide
      : "unverified"; // no key resolved at all
  return { ref, resolved: true, kind, signature };
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
      bundleSignature: "unverified",
      artifacts: [],
    };
  }
  const bundle = stripSignature(raw) as unknown as AttestationBundle;

  // Verify the bundle's own signature.
  const bundleResult = await verifyOne(
    bundleRef,
    "AttestationBundle",
    raw,
    bundle,
    deps,
  );

  // Verify each referenced artifact.
  const artifacts: ArtifactVerification[] = [];
  for (const ref of bundle.artifactRefs) {
    const obj = await deps.readArtifact(ref);
    if (!obj) {
      artifacts.push({
        ref,
        resolved: false,
        kind: "unknown",
        signature: "unverified",
      });
      continue;
    }
    artifacts.push(await verifyOne(ref, detectKind(obj), obj, bundle, deps));
  }

  const all = [bundleResult, ...artifacts];
  const allResolved = artifacts.every((a) => a.resolved);
  const anyInvalid = all.some((a) => a.signature === "invalid");
  const anyError = all.some((a) => a.signature === "error");
  const fullyVerified = all.every((a) => a.signature === "valid");

  return {
    // A malformed key (error) is not a pass: we couldn't decide, so don't ok it.
    ok: allResolved && !anyInvalid && !anyError,
    reason: !allResolved
      ? "one or more referenced artifacts did not resolve"
      : anyInvalid
        ? "one or more signatures failed verification"
        : anyError
          ? "one or more signer keys were malformed (could not verify)"
          : undefined,
    fullyVerified,
    bundle,
    bundleSignature: bundleResult.signature,
    artifacts,
  };
}

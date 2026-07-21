import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import { isAttestationBundle } from "../artifacts/validators.js";
import { contentHash, stripSignature } from "../canonical/index.js";
import { signedBytes } from "../crypto/index.js";
import type { BundleRole } from "./bundleConsistency.js";
import type { Verifier } from "./signedArtifact.js";

/**
 * §10.4.3(b) COPY VALIDITY — the dedicated validator `bundleConsistency` gates
 * copies with. This is deliberately NOT `verifyBundleCore`: that one takes a
 * storage *ref* (not the fetched bundle object), dereferences referenced
 * artifacts, and does not by itself establish the signer-set / §10.11 /
 * address-role contract a consistency verdict depends on.
 *
 * A copy is valid iff ALL of:
 *  1. it is structurally an AttestationBundle;
 *  2. ADDRESS-ROLE contract — `anchoredByRole` equals the role of the address it
 *     was fetched from. A copy anchored by one role sitting at the other role's
 *     address is not that party's attestation, so it must not count as present.
 *     A missing `anchoredByRole` fails CLOSED (we can't confirm it belongs here);
 *  3. §10.4.1 SIGNATURES — every `signatures[]` entry that resolves verifies. Any
 *     entry that fails verification taints the whole copy (invalid, not ignored);
 *  4. SIGNER SET — at least one distinct party signed validly, and if EXACTLY one
 *     did, the §10.11 single-signed exception applies: the copy stands only when
 *     its `outcome` is an abort. A single-signed NON-abort copy is rejected per
 *     §10.4.1, so it never reaches `oneSided`.
 *
 * Signature scope matches §10.4.1 exactly: the canonical form omitting
 * `signatures` + `anchoredByRole` (the per-copy fields).
 */

/** Outcomes that count as an abort for the §10.11 single-signed exception. */
export const ABORT_OUTCOMES = new Set(["abort", "aborted", "cancelled", "canceled"]);

export interface BundleCopyDeps {
  /** Resolve a signer DID/claim to its ed25519 public key (null if unknown). */
  resolvePublicKey: (did: string) => Promise<Uint8Array | null>;
  /** Verify a signature over raw bytes for a public key. */
  verify: Verifier;
}

export type CopyValidity =
  | { valid: true; signers: string[]; fullySigned: boolean; abortStanding: boolean }
  | { valid: false; reason: string };

/**
 * Validate ONE fetched bundle copy for the role-address it was read from.
 * See the module doc for the exact contract.
 */
export async function verifyBundleCopy(
  bundle: Record<string, unknown>,
  role: BundleRole,
  deps: BundleCopyDeps,
): Promise<CopyValidity> {
  if (!isAttestationBundle(stripSignature(bundle))) {
    return { valid: false, reason: "not an attestation bundle" };
  }

  // (2) address-role contract — fail closed when absent or mismatched.
  const anchoredBy = bundle["anchoredByRole"];
  if (typeof anchoredBy !== "string" || anchoredBy.length === 0) {
    return { valid: false, reason: "copy has no anchoredByRole; cannot bind it to this address" };
  }
  if (anchoredBy !== role) {
    return {
      valid: false,
      reason: `copy anchoredByRole "${anchoredBy}" was fetched from the "${role}" address`,
    };
  }

  // (3) §10.4.1 signature scope: omit the per-copy fields.
  const scope = { ...bundle };
  delete scope["signatures"];
  delete scope["anchoredByRole"];
  const message = signedBytes(ARTIFACT_SEPARATORS.AttestationBundle, contentHash(scope));

  const entries = Array.isArray(bundle["signatures"])
    ? (bundle["signatures"] as Array<{ party?: unknown; value?: unknown }>)
    : [];
  if (entries.length === 0) return { valid: false, reason: "copy carries no signatures" };

  const signers = new Set<string>();
  for (const s of entries) {
    const party = typeof s.party === "string" ? s.party : "";
    const key = await deps.resolvePublicKey(party);
    // An unresolvable signer can't be counted as a valid signer, but it also
    // isn't proof of forgery — skip it rather than tainting the copy.
    if (!key || key.length !== 32) continue;
    const sigBytes = Uint8Array.from(
      Buffer.from(typeof s.value === "string" ? s.value : "", "base64url"),
    );
    if (!(await deps.verify(message, sigBytes, key))) {
      // A signature that resolves but does NOT verify taints the copy (§10.4.1).
      return { valid: false, reason: `signature by ${party} failed verification` };
    }
    signers.add(party);
  }

  if (signers.size === 0) return { valid: false, reason: "no signature could be verified" };

  // (4) signer set + the §10.11 single-signed-abort exception.
  const fullySigned = signers.size >= 2;
  const outcome = typeof bundle["outcome"] === "string" ? bundle["outcome"].toLowerCase() : "";
  const isAbort = ABORT_OUTCOMES.has(outcome);
  if (!fullySigned && !isAbort) {
    return {
      valid: false,
      reason: `single-signed copy with non-abort outcome "${outcome}" is rejected (§10.4.1; §10.11 covers aborts only)`,
    };
  }
  return { valid: true, signers: [...signers], fullySigned, abortStanding: !fullySigned && isAbort };
}

import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import { isCanonicalBase64Url } from "../artifacts/signatures.js";
import { isAnyAttestationBundle } from "../artifacts/validators.js";
import { contentHash, stripSignature } from "../canonical/index.js";
import { signedBytes } from "../crypto/index.js";
import {
  parseCanonicalClaimReference,
  sameCanonicalClaimIdentity,
} from "../identity/claimReference.js";
import type { BundleRole } from "./bundleConsistency.js";
import type { Verifier } from "./signedArtifact.js";
import type { EvidenceBoundBundleVerification } from "./evidenceBoundBundle.js";
import {
  isAbsoluteFaultBundle,
  faultedPartyIsPermitted,
  isEvidenceBoundFaultBundle,
  isFaultBundle,
} from "./bundleSemantics.js";

/**
 * §10.4.3(b) COPY VALIDITY — the dedicated validator `bundleConsistency` gates
 * copies with. This is deliberately NOT `verifyBundleCore`: that one takes a
 * storage *ref* (not the fetched bundle object), dereferences referenced
 * artifacts, and does not by itself establish the signer-set / §10.11 /
 * address-role contract a consistency verdict depends on.
 *
 * A copy is valid iff ALL of:
 *  1. it is structurally a legacy AttestationBundle or FaultAttestationBundle;
 *  2. ADDRESS-ROLE contract — `anchoredByRole` equals the role of the address it
 *     was fetched from. A copy anchored by one role sitting at the other role's
 *     address is not that party's attestation, so it must not count as present.
 *     A missing `anchoredByRole` fails CLOSED (we can't confirm it belongs here);
 *  3. a FaultAttestationBundle's absolute fault is permissible for its outcome/anchor;
 *  4. §10.4.1 SIGNATURES — every `signatures[]` entry is well-formed, uses the
 *     supported closed algorithm, names a bundle party, resolves, and verifies.
 *  5. SIGNER SET — buyer + seller are required, plus a distinct orchestrator
 *     when present. The §10.11 exception permits a single signature only when
 *     the exact bundle outcome is `aborted-by-self` or `aborted-by-other`.
 *
 * Signature scope matches §10.4.1 exactly: the canonical form omitting
 * `signatures` + `anchoredByRole` (the per-copy fields).
 */

/** Outcomes that count as an abort for the §10.11 single-signed exception. */
export const ABORT_OUTCOMES = new Set(["aborted-by-self", "aborted-by-other"]);

export interface BundleCopyDeps {
  /** Resolve a signer DID/claim to its ed25519 public key (null if unknown). */
  resolvePublicKey: (did: string) => Promise<Uint8Array | null>;
  /** Verify a signature over raw bytes for a public key. */
  verify: Verifier;
  /**
   * Mandatory for an EBFAB copy. It must run the SDK SEB-1..SEB-6 verifier
   * against the complete authenticated authority graph. A type/signature-only
   * EBFAB is inert during reconciliation.
   */
  verifyEvidenceBound?: (
    bundle: Readonly<Record<string, unknown>>,
  ) => Promise<EvidenceBoundBundleVerification>;
}

export type BundleCopyRole = BundleRole | "orchestrator";

export type CopyValidity =
  | { valid: true; signers: string[]; fullySigned: boolean; abortStanding: boolean }
  | { valid: false; reason: string };

const isObj = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Validate ONE fetched bundle copy for the role-address it was read from.
 * See the module doc for the exact contract.
 */
export async function verifyBundleCopy(
  bundle: Record<string, unknown>,
  role: BundleCopyRole,
  deps: BundleCopyDeps,
): Promise<CopyValidity> {
  const unsigned = stripSignature(bundle);
  if (isAbsoluteFaultBundle(unsigned) && !faultedPartyIsPermitted(unsigned)) {
    return { valid: false, reason: "faultedParty is not permitted for outcome and anchoredByRole" };
  }
  const encodedEntries = Array.isArray(bundle["signatures"])
    ? bundle["signatures"]
    : [];
  for (const entry of encodedEntries) {
    if (
      isObj(entry) &&
      typeof entry["value"] === "string" &&
      !isCanonicalBase64Url(entry["value"])
    ) {
      const party = typeof entry["party"] === "string" ? entry["party"] : "unknown";
      return {
        valid: false,
        reason: `signature by ${party} is not canonical unpadded base64url`,
      };
    }
  }
  if (!isAnyAttestationBundle(bundle)) {
    return { valid: false, reason: "not an attestation bundle" };
  }
  const parsed = bundle;
  if (!parsed.parties.some((party) => party.role === role)) {
    return { valid: false, reason: `anchor role "${role}" is absent from parties[]` };
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
  const scope: Record<string, unknown> = { ...bundle };
  delete scope["signatures"];
  delete scope["anchoredByRole"];
  const separator = isEvidenceBoundFaultBundle(unsigned)
    ? ARTIFACT_SEPARATORS.EvidenceBoundFaultAttestationBundle
    : isFaultBundle(unsigned)
      ? ARTIFACT_SEPARATORS.FaultAttestationBundle
      : ARTIFACT_SEPARATORS.AttestationBundle;
  const message = signedBytes(separator, contentHash(scope));

  const entries = Array.isArray(bundle["signatures"]) ? bundle["signatures"] : [];
  if (entries.length === 0) return { valid: false, reason: "copy carries no signatures" };

  const parties = parsed.parties as unknown as Array<Record<string, unknown>>;
  const anchorRoleClaim = parties.find((party) => party["role"] === role)?.[
    "primaryClaim"
  ];
  if (typeof anchorRoleClaim !== "string" || anchorRoleClaim.length === 0) {
    return {
      valid: false,
      reason: `anchor role "${role}" has no canonical party claim`,
    };
  }
  const partyClaims = parties
    .map((party) => party["primaryClaim"])
    .filter((claim): claim is string =>
      typeof claim === "string" && claim.length > 0
    );
  const buyer = parties.find((party) => party["role"] === "buyer")?.["primaryClaim"];
  const seller = parties.find((party) => party["role"] === "seller")?.["primaryClaim"];
  if (typeof buyer !== "string" || typeof seller !== "string") {
    return { valid: false, reason: "bundle does not identify both required party signers" };
  }
  const requiredSigners = [buyer, seller];
  for (const party of parties) {
    const claim = party["primaryClaim"];
    if (
      party["role"] === "orchestrator" &&
      typeof claim === "string" &&
      !sameCanonicalClaimIdentity(claim, buyer) &&
      !sameCanonicalClaimIdentity(claim, seller)
    ) {
      requiredSigners.push(claim);
    }
  }

  const signers: string[] = [];
  for (const entry of entries) {
    if (!isObj(entry)) {
      return { valid: false, reason: "malformed bundle signature entry" };
    }
    const party = entry["party"];
    const algorithm = entry["algorithm"];
    const value = entry["value"];
    if (
      typeof party !== "string" ||
      party.length === 0 ||
      typeof algorithm !== "string" ||
      typeof value !== "string" ||
      value.length === 0
    ) {
      return { valid: false, reason: "malformed bundle signature entry" };
    }
    if (algorithm !== "ed25519") {
      return { valid: false, reason: `unsupported bundle signature algorithm "${algorithm}"` };
    }
    if (!partyClaims.some((claim) =>
      sameCanonicalClaimIdentity(claim, party)
    )) {
      return { valid: false, reason: `signature party "${party}" is not a bundle party` };
    }
    if (!isCanonicalBase64Url(value)) {
      return { valid: false, reason: `signature by ${party} is not canonical unpadded base64url` };
    }
    const parsedParty = parseCanonicalClaimReference(party);
    if (parsedParty === null) {
      return { valid: false, reason: `signature party "${party}" is not canonical` };
    }
    const key = await deps.resolvePublicKey(
      `${parsedParty.identity.scheme}:${parsedParty.identity.identifier}`,
    );
    if (!key || key.length !== 32) {
      return { valid: false, reason: `signature party "${party}" could not be resolved` };
    }
    const sigBytes = Uint8Array.from(Buffer.from(value, "base64url"));
    if (sigBytes.length !== 64) {
      return { valid: false, reason: `signature by ${party} is not 64 bytes` };
    }
    if (!(await deps.verify(message, sigBytes, key))) {
      // A signature that resolves but does NOT verify taints the copy (§10.4.1).
      return { valid: false, reason: `signature by ${party} failed verification` };
    }
    if (!signers.some((claim) => sameCanonicalClaimIdentity(claim, party))) {
      signers.push(party);
    }
  }

  // (4) signer set + the §10.11 single-signed-abort exception.
  const fullySigned = requiredSigners.every((party) =>
    signers.some((signer) => sameCanonicalClaimIdentity(signer, party))
  );
  const outcome = typeof bundle["outcome"] === "string" ? bundle["outcome"] : "";
  const isAbort = ABORT_OUTCOMES.has(outcome);
  const singleSignedAbort =
    entries.length === 1 &&
    signers.length === 1 &&
    signers.some((signer) =>
      sameCanonicalClaimIdentity(signer, anchorRoleClaim)
    ) &&
    isAbort;
  if (!fullySigned && !singleSignedAbort) {
    return {
      valid: false,
      reason:
        `copy is missing required signatures for outcome "${outcome}" ` +
        "(§10.4.1; §10.11 permits exactly one signer for abort outcomes only)",
    };
  }
  if (isEvidenceBoundFaultBundle(unsigned)) {
    if (!deps.verifyEvidenceBound) {
      return {
        valid: false,
        reason: "EBFAB copy requires SEB-1..SEB-6 authority verification before reconciliation",
      };
    }
    let seb: EvidenceBoundBundleVerification;
    try {
      seb = await deps.verifyEvidenceBound(structuredClone(bundle));
    } catch {
      return { valid: false, reason: "EBFAB authority verifier failed" };
    }
    if (seb.decision !== "verified") {
      return {
        valid: false,
        reason: `EBFAB exact-set verification ${seb.decision}: ${seb.reason}`,
      };
    }
  }
  return {
    valid: true,
    signers: [...signers],
    fullySigned,
    abortStanding: !fullySigned && singleSignedAbort,
  };
}

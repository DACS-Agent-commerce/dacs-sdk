/**
 * Deterministic `identityTier` derivation — DACS-1 §6.3.2.1, rules IT-1..IT-3.
 *
 * `identityTier` is an OPTIONAL single-word summary of identity quality
 * (`institutional` / `verified` / `self-declared`) derived from an
 * IdentityBundle's *verified* claims. It is a convenience over the claim set,
 * never a trust primitive: a conformant reader MUST recompute it and MUST
 * ignore any self-asserted `identityTier` a presenter places on the bundle
 * (this function derives purely from `claims[]` and never reads a declared
 * tier). Only a **verified** claim elevates the tier — one whose `verifiedBy`
 * resolves to a `decision == "pass"` VerifyResult that is fresh per the §6.3.2
 * effective-window gate; a missing, failing, or stale `verifiedBy` does not.
 */

export type IdentityTier = "institutional" | "verified" | "self-declared";

/** The `verifiedBy` reference on a bundle claim (an anchored VerifyResult). */
export interface BundleClaimVerifiedBy {
  anchor?: { kind?: string; locator?: string } | null;
  contentHash?: string;
  recipeVersion?: number;
}

/** A claim inside an IdentityBundle (structural — only what tier derivation reads). */
export interface BundleClaimLike {
  /** Canonical claim ref, e.g. "lei:529900…", "domain:example.com", "key:aaaa". */
  ref: string;
  /** Reference to the verification that attests this claim, if any. */
  verifiedBy?: BundleClaimVerifiedBy | null;
  issuedAt?: number;
}

export interface IdentityBundleLike {
  claims?: BundleClaimLike[];
}

/**
 * Authority-issued regulatory schemes — the §6.3.2 "tier 1" claim schemes. A
 * *verified* claim in one of these makes the bundle `institutional`.
 */
export const TIER1_SCHEMES: ReadonlySet<string> = new Set([
  "lei",
  "finra-crd",
  "sam-uei",
  "fedramp",
  "cmmc",
  "naics",
]);

/** The scheme part of a claim ref (`lei:529900…` → `lei`), lower-cased. */
export function claimScheme(ref: string): string {
  const i = ref.indexOf(":");
  return i <= 0 ? "" : ref.slice(0, i).toLowerCase();
}

/**
 * Default "is this claim verified?" predicate for offline derivation: the claim
 * carries a structurally-complete `verifiedBy` (an anchor locator + a content
 * hash). Callers that can resolve the anchor SHOULD pass their own predicate
 * that checks the referenced VerifyResult is `pass` AND fresh (§6.3.2) — a
 * structural check alone cannot see a failing or stale verification.
 */
export function claimHasStructuralProof(claim: BundleClaimLike): boolean {
  const vb = claim.verifiedBy;
  return (
    !!vb &&
    typeof vb.contentHash === "string" &&
    vb.contentHash.trim() !== "" &&
    !!vb.anchor &&
    typeof vb.anchor.locator === "string" &&
    vb.anchor.locator.trim() !== ""
  );
}

/**
 * Derive `identityTier` from a bundle's claims (§6.3.2.1, normative priority
 * order IT-1..IT-3):
 *   1. a verified tier-1 (authority-issued) claim → `institutional`
 *   2. else any verified claim → `verified`
 *   3. else (no verified claim) → `self-declared`
 *
 * Verification status — not scheme strength — decides the tier: a verified
 * `key:` is `verified`, while an unverified `lei:` is `self-declared`. Pass
 * `isClaimVerified` to plug in real anchor resolution; the default treats a
 * structurally-complete `verifiedBy` as verified.
 */
export function deriveIdentityTier(
  bundle: IdentityBundleLike | null | undefined,
  isClaimVerified: (claim: BundleClaimLike) => boolean = claimHasStructuralProof,
): IdentityTier {
  const claims = Array.isArray(bundle?.claims) ? bundle!.claims! : [];
  const verified = claims.filter(
    (c) => c && typeof c.ref === "string" && isClaimVerified(c),
  );
  if (verified.some((c) => TIER1_SCHEMES.has(claimScheme(c.ref)))) {
    return "institutional";
  }
  if (verified.length > 0) return "verified";
  return "self-declared";
}

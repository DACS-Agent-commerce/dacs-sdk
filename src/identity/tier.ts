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

import { authenticatedDomainClaimReference } from "./domainClaimVerification.js";

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
  bundleVersion?: string;
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
 * `key:` is `verified`, while an unverified `lei:` is `self-declared`.
 *
 * **`isClaimVerified` is REQUIRED — there is no fail-open default.** IT-1 counts
 * a claim as verified only when its `verifiedBy` resolves to a `pass` VerifyResult
 * that is *fresh* per the §6.3.2 effective-window gate; a structural-only check
 * (a well-formed `verifiedBy` pointing at garbage, a `fail`, or a stale result)
 * would let a bare `lei:` launder an `institutional` tier — the exact
 * tier-laundering the `dacs1-tier-laundering-guard` golden exists to stop. So the
 * caller MUST supply the predicate. For a deliberate offline/structural-only read
 * (NOT IT-1-conformant) pass the exported {@link claimHasStructuralProof} — naming
 * it is the loud opt-in.
 * Authenticate the original version-1 bundle presentation before using this
 * function's historical-domain semantic view.
 */
export function deriveIdentityTier(
  bundle: IdentityBundleLike | null | undefined,
  isClaimVerified: (claim: BundleClaimLike) => boolean,
): IdentityTier {
  const source = Array.isArray(bundle?.claims) ? bundle!.claims! : [];
  const claims: BundleClaimLike[] = [];
  const domains = new Set<string>();
  for (const claim of source) {
    if (!claim || typeof claim.ref !== "string") continue;
    let ref = claim.ref;
    if (ref.startsWith("web2:domain:")) {
      if (bundle?.bundleVersion !== "1") continue;
      try { ref = authenticatedDomainClaimReference(ref); } catch { continue; }
    }
    // Proof references bind the original signed claim. Fold only verified
    // outcomes, so an unverified alias cannot hide another alias's proof.
    if (!isClaimVerified(claim)) continue;
    if (ref.startsWith("domain:")) {
      if (domains.has(ref)) continue;
      domains.add(ref);
    }
    claims.push(ref === claim.ref ? claim : { ...claim, ref });
  }
  if (claims.some((c) => TIER1_SCHEMES.has(claimScheme(c.ref)))) {
    return "institutional";
  }
  if (claims.length > 0) return "verified";
  return "self-declared";
}

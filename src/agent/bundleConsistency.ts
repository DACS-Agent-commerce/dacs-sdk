import { DacsError } from "../errors.js";
import { bundlesDiverge } from "./bundleDivergence.js";

// Re-exported for API compatibility — the canonical §10.4.3 predicate now lives
// in bundleDivergence.js and is shared with the §10.5.1 reputation deriver (#224).
export { bundlesDiverge };

/**
 * Two-sided bundle consistency verdict — DACS-5 §10.4.3.
 *
 * A session is anchored by up to two parties, each at its own SR-2 address
 * (`…-bundle-buyer`, `…-bundle-seller`). A consumer looking up "the bundle(s)
 * for session X" fetches both and MUST classify what it found:
 *
 *  - `absent`    — no valid copy anchored (incl. §10.4.3(b) third arm: a lone
 *                  single-signed copy with a NON-abort outcome is rejected per
 *                  §10.4.1, leaving no valid bundle — the `isValid` gate MUST
 *                  drop it, so it never reaches `oneSided`).
 *  - `oneSided`  — exactly one valid copy (§10.4.3(b)). Two arms both land here:
 *                  (i) a fully-signed copy whose counterpart is an anchoring
 *                  omission; (ii) a single-signed copy whose outcome is an abort,
 *                  standing via §10.11 bundle-suppression. Both are "the present
 *                  copy is the session bundle"; they are NOT the same as a mere
 *                  omission, so consumers must not read an abort-suppression copy
 *                  as one.
 *  - `unified`   — both present and they do NOT canonically diverge (equal, or
 *                  differing only in advisory fields), §10.4.3(c).
 *  - `divergent` — both present and they contradict, §10.4.3(d) — a genuine
 *                  dispute; a reputation deriver excludes this jobId entirely.
 *
 * "Canonically diverge" is defined ONCE in {@link bundleDivergence} and shared
 * verbatim with the §10.5.1 reputation deriver (#224 raised the drift between the
 * two): the copies differ in `outcome`, a `phaseSummary` entry (by `index`) is
 * present in one copy but not the other (presence-mismatch IS divergence per
 * DACS-Standard#224), or a shared entry's `outcome`/`errorClass` differ. A
 * difference confined to advisory fields (`finalisedAt` skew, one-sided
 * `ratingRefs`, `anchoredByRole`, amendment ordering) is NOT a divergence, so a
 * party cannot force a spurious "disputed" classification by perturbing one.
 *
 * `isValid` CONTRACT (load-bearing — §10.4.3(b) validity split lives here): a
 * copy passes iff it satisfies §10.4.1 signature validation **with** the §10.11
 * single-signed-abort exception — i.e. accept a fully-signed copy, OR a
 * single-signed copy whose outcome is an abort; REJECT a single-signed non-abort
 * copy. Composing `verifyBundleCore` as `isValid` must honour that exception, or
 * a suppression-standing abort copy is wrongly dropped to `absent`.
 *
 * The gate is REQUIRED, not defaultable: classifying unvalidated copies is a
 * fail-open trap (an unsigned forgery would read as a present copy and flip
 * `absent`→`oneSided` or `oneSided`→`divergent`), so the caller MUST make the
 * choice explicit — supply `deps.isValid`, or set `deps.trustBundles: true` to
 * opt out when copies are already validated upstream. Neither → throws. (Same
 * shape as the #21 reputation deriver / #26 identityTier.)
 *
 * Transport-trust caveat (non-normative): the `oneSided` verdict trusts the
 * absence signal. An attacker who can censor the counterparty's anchor at the
 * fetch layer can present a `divergent` session as a clean `oneSided`. Nothing
 * here proves the missing copy was honestly absent, so a reputation-bearing
 * consumer SHOULD read both addresses over a quorum/authenticated substrate.
 *
 * Pure: signature/anchor validity is injected via `isValid` so this composes
 * with verifyBundleCore without importing it.
 */

export type ConsistencyVerdict = "absent" | "oneSided" | "unified" | "divergent";

export type BundleRole = "buyer" | "seller";

export interface BundleCopies {
  buyer?: Record<string, unknown> | null;
  seller?: Record<string, unknown> | null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

export interface BundleConsistencyDeps {
  /**
   * §10.4.1 signature/anchor validation (with the §10.11 single-signed-abort
   * exception) — an invalid copy is treated as not-present. Wire
   * `verifyBundleCore` here. REQUIRED unless `trustBundles` is set.
   */
  isValid?: (bundle: Record<string, unknown>, role: BundleRole) => boolean;
  /**
   * Explicit, grep-able opt-out of validation (classify every present copy as
   * valid). Only for callers that have already validated the copies upstream.
   * Ignored when `isValid` is supplied.
   */
  trustBundles?: boolean;
}

/**
 * Classify the two-sided copies for a session (§10.4.3). `deps.isValid` gates
 * each copy on signature/anchor validity (e.g. wrap verifyBundleCore); an
 * invalid copy is treated as not-present. Supply `isValid` or an explicit
 * `trustBundles: true` — deriving a verdict from unvalidated copies is not a
 * safe default, so an absent gate throws.
 */
export function bundleConsistency(
  copies: BundleCopies,
  deps: BundleConsistencyDeps = {},
): ConsistencyVerdict {
  if (!deps.isValid && !deps.trustBundles) {
    throw new DacsError(
      "bundleConsistency requires deps.isValid (wire verifyBundle) or an explicit deps.trustBundles: true opt-out — " +
        "classifying unvalidated bundle copies is not a safe default",
    );
  }
  const isValid = deps.isValid;
  const keep = (b: Record<string, unknown> | null | undefined, role: BundleRole) =>
    isObj(b) && (!isValid || isValid(b, role)) ? b : null;
  const buyer = keep(copies.buyer, "buyer");
  const seller = keep(copies.seller, "seller");

  const present = [buyer, seller].filter((b): b is Record<string, unknown> => b !== null);
  if (present.length === 0) return "absent";
  if (present.length === 1) return "oneSided";
  return bundlesDiverge(buyer!, seller!) ? "divergent" : "unified";
}

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
 *  - `absent`    — both expected addresses authoritatively returned absent.
 *  - `indeterminate` — fewer than two copies are present and at least one
 *                  expected address could not be read authoritatively.
 *  - `oneSided`  — exactly one valid copy is present and the other expected
 *                  address is authoritatively absent (§10.4.3(b)).
 *  - `unified`   — both present and they do NOT canonically diverge (equal, or
 *                  differing only in advisory fields), §10.4.3(c).
 *  - `divergent` — both present and they contradict, §10.4.3(d) — a genuine
 *                  dispute; a reputation deriver excludes this jobId entirely.
 *
 * "Canonically diverge" is defined ONCE in {@link bundleDivergence} and shared
 * verbatim with the §10.5.1 reputation deriver (#224 raised the drift between the
 * two): the copies differ in `outcome`, a `phaseSummary` entry (by `index`) is
 * present in one copy but not the other (presence-mismatch IS divergence per
 * DACS-Standard#224), or a shared entry's `kind`/`outcome`/`errorClass` differ. A
 * difference confined to advisory fields (`finalisedAt` skew, one-sided
 * `ratingRefs`, `anchoredByRole`, amendment ordering) is NOT a divergence, so a
 * party cannot force a spurious "disputed" classification by perturbing one.
 *
 * `isValid` CONTRACT (load-bearing — §10.4.3(b) validity split lives here): a
 * copy passes iff it satisfies §10.4.1 signature validation **with** the §10.11
 * single-signed-abort exception — i.e. accept a fully-signed copy, OR a
 * single-signed copy whose outcome is an abort; REJECT a single-signed non-abort
 * copy. It must also enforce the address-role contract (a copy anchored by one
 * role must not be honoured at the other role's address).
 *
 * Wire {@link verifyBundleCopy} — it implements exactly that contract over the
 * fetched bundle OBJECT. Do NOT wire `verifyBundleCore` directly: it takes a
 * storage *ref* rather than the object supplied here, and does not establish the
 * signer-set / §10.11 / address-role contract on its own.
 *
 * `isValid` is awaited, and this function is ASYNC, precisely so a real
 * (asynchronous) validator can be wired safely. A sync gate would have silently
 * accepted every copy when handed an async callback, because the returned
 * Promise is truthy — a fail-open trap.
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

export type ConsistencyVerdict =
  | "absent"
  | "indeterminate"
  | "oneSided"
  | "unified"
  | "divergent";

export type BundleRole = "buyer" | "seller";

export type BundleCopyRead =
  | { disposition: "present"; bundle: Record<string, unknown> }
  | { disposition: "absent" }
  | { disposition: "indeterminate" };

export interface BundleCopies {
  buyer: BundleCopyRead;
  seller: BundleCopyRead;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

export interface BundleConsistencyDeps {
  /**
   * §10.4.1 signature/anchor validation (with the §10.11 single-signed-abort
   * exception and the address-role contract). Invalid returned content is
   * rejected; it is never converted into an `absent` disposition. Wire
   * {@link verifyBundleCopy}, NOT `verifyBundleCore`.
   * May be async; the result is awaited. REQUIRED unless `trustBundles` is set.
   */
  isValid?: (
    bundle: Record<string, unknown>,
    role: BundleRole,
  ) => boolean | Promise<boolean>;
  /**
   * Explicit, grep-able opt-out of validation (classify every present copy as
   * valid). Only for callers that have already validated the copies upstream.
   * Ignored when `isValid` is supplied.
   */
  trustBundles?: boolean;
}

/**
 * Classify the two-sided copies for a session (§10.4.3). `deps.isValid` gates
 * each present copy on signature/anchor validity (e.g. wire verifyBundleCopy);
 * invalid returned content is rejected. Supply `isValid` or an explicit
 * `trustBundles: true` — deriving a verdict from unvalidated copies is not a
 * safe default, so an absent gate throws.
 */
export async function bundleConsistency(
  copies: BundleCopies,
  deps: BundleConsistencyDeps = {},
): Promise<ConsistencyVerdict> {
  if (!deps.isValid && !deps.trustBundles) {
    throw new DacsError(
      "bundleConsistency requires deps.isValid (wire verifyBundleCopy) or an explicit deps.trustBundles: true opt-out — " +
        "classifying unvalidated bundle copies is not a safe default",
    );
  }
  const isValid = deps.isValid;
  // AWAIT the gate: a sync gate handed an async validator would treat the
  // returned Promise as truthy and accept every copy (fail-open).
  const validate = async (
    read: BundleCopyRead,
    role: BundleRole,
  ): Promise<Record<string, unknown> | null> => {
    if (read.disposition !== "present") return null;
    if (!isObj(read.bundle)) {
      throw new DacsError(`bundleConsistency received malformed present content for ${role}`);
    }
    if (isValid && !(await isValid(read.bundle, role))) {
      throw new DacsError(
        `bundleConsistency rejected invalid content returned from the ${role} address`,
      );
    }
    return read.bundle;
  };
  const buyer = await validate(copies.buyer, "buyer");
  const seller = await validate(copies.seller, "seller");

  const present = [buyer, seller].filter((b): b is Record<string, unknown> => b !== null);
  if (present.length === 2) {
    return bundlesDiverge(buyer!, seller!) ? "divergent" : "unified";
  }
  if (
    copies.buyer.disposition === "indeterminate" ||
    copies.seller.disposition === "indeterminate"
  ) {
    return "indeterminate";
  }
  if (present.length === 1) return "oneSided";
  return "absent";
}

import { bundleAddress } from "../canonical/addressing.js";
import { snapshotCanonicalJsonRead } from "../canonical/snapshot.js";
import { DacsError } from "../errors.js";
import { bundlesDiverge } from "./bundleDivergence.js";
import {
  bundleArtifactType,
  bundleArtifactTypeRank,
  type BundleArtifactType,
} from "./bundleSemantics.js";

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
 * Adapt {@link verifyBundleCopy} by returning its `.valid` boolean — it
 * implements exactly that contract over the fetched bundle OBJECT. Do NOT pass
 * its `CopyValidity` object directly, and do NOT wire `verifyBundleCore`: the
 * latter takes a storage *ref* rather than the object supplied here and does not
 * establish the signer-set / §10.11 / address-role contract on its own.
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
  | { disposition: "indeterminate"; reason?: string };

export interface BundleCopies {
  buyer: BundleCopyRead;
  seller: BundleCopyRead;
}

/**
 * Transport/substrate seam for the DACS-5 §10.4.3(a) two-sided lookup.
 * The return value is untrusted: the helper snapshots and validates it before
 * exposing a copy to bundle consistency or signature verification.
 */
export type BundleCopyReader = (
  logicalAddress: string,
  role: BundleRole,
) => BundleCopyRead | Promise<BundleCopyRead>;

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function captureBundleCopyRead(
  value: unknown,
  jobId: string,
  role: BundleRole,
): BundleCopyRead {
  let captured: unknown;
  try {
    captured = snapshotCanonicalJsonRead(value, `${role} bundle lookup`);
  } catch (error) {
    return {
      disposition: "indeterminate",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!isObj(captured) || typeof captured.disposition !== "string") {
    return {
      disposition: "indeterminate",
      reason: `${role} bundle lookup returned an invalid disposition`,
    };
  }
  if (captured.disposition === "absent") return { disposition: "absent" };
  if (captured.disposition === "indeterminate") {
    return {
      disposition: "indeterminate",
      ...(typeof captured.reason === "string" && captured.reason.length > 0
        ? { reason: captured.reason }
        : {}),
    };
  }
  if (captured.disposition !== "present" || !isObj(captured.bundle)) {
    return {
      disposition: "indeterminate",
      reason: `${role} bundle lookup returned an invalid present result`,
    };
  }
  // §10.4.3(a): content returned from a role address for another session does
  // not count as a copy of this session. Signature/address-role validation is
  // deliberately the next, separate verifyBundleCopy gate.
  if (
    typeof captured.bundle.jobId !== "string" ||
    captured.bundle.jobId.length === 0
  ) {
    return {
      disposition: "indeterminate",
      reason: `${role} bundle lookup returned content without a valid jobId`,
    };
  }
  if (captured.bundle.jobId !== jobId) return { disposition: "absent" };
  return { disposition: "present", bundle: captured.bundle };
}

/**
 * Fetch both DACS-5 role-specific logical bundle addresses concurrently.
 *
 * This is lookup, not trust. Present content remains subject to
 * {@link verifyBundleCopy}; then {@link bundleConsistency} classifies the two
 * verified dispositions. A reader exception or malformed response is retained
 * as `indeterminate`, never silently converted to authoritative absence.
 */
export async function lookupBundleCopies(
  jobId: string,
  read: BundleCopyReader,
): Promise<BundleCopies> {
  if (
    typeof jobId !== "string" ||
    jobId.length === 0 ||
    jobId !== jobId.trim() ||
    jobId !== jobId.normalize("NFC") ||
    /[\u0000-\u001f\u007f]/.test(jobId)
  ) {
    throw new DacsError("bundle lookup jobId must be non-empty canonical text");
  }
  if (typeof read !== "function") {
    throw new DacsError("bundle lookup requires a reader");
  }

  const lookup = async (role: BundleRole): Promise<BundleCopyRead> => {
    try {
      return captureBundleCopyRead(
        await read(bundleAddress(jobId, role), role),
        jobId,
        role,
      );
    } catch (error) {
      return {
        disposition: "indeterminate",
        reason: `${role} bundle lookup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  };

  const [buyer, seller] = await Promise.all([
    lookup("buyer"),
    lookup("seller"),
  ]);
  return { buyer, seller };
}

export interface BundleConsistencyDeps {
  /**
   * §10.4.1 signature/anchor validation (with the §10.11 single-signed-abort
   * exception and the address-role contract). Invalid returned content is
   * rejected; it is never converted into an `absent` disposition. Adapt
   * {@link verifyBundleCopy} as
   * `(await verifyBundleCopy(bundle, role, deps)).valid`; do not return the
   * result object itself, and do not wire `verifyBundleCore`.
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
 * each present copy on signature/anchor validity (e.g. adapt
 * `verifyBundleCopy(...).valid`);
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
    if (isValid) {
      const validity = await isValid(read.bundle, role);
      if (validity !== true) {
        throw new DacsError(
          `bundleConsistency rejected invalid content returned from the ${role} address`,
        );
      }
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

export interface AuthoritativeBundleSelection {
  role: BundleRole;
  type: BundleArtifactType;
  bundle: Record<string, unknown>;
}

/**
 * Select the strongest non-divergent, fully validated DACS-5 copy. EBFAB ranks
 * above FAB, which ranks above legacy, but type rank is never consulted until
 * the caller's complete validity gate (including SEB for EBFAB) has passed.
 */
export async function selectAuthoritativeBundleCopy(
  copies: BundleCopies,
  deps: Pick<BundleConsistencyDeps, "isValid">,
): Promise<AuthoritativeBundleSelection | null> {
  if (!deps.isValid) {
    throw new DacsError(
      "selectAuthoritativeBundleCopy requires a complete validity gate; trustBundles is not permitted",
    );
  }
  const valid: AuthoritativeBundleSelection[] = [];
  for (const role of ["buyer", "seller"] as const) {
    const read = copies[role];
    if (read.disposition !== "present") continue;
    if (!isObj(read.bundle) || !(await deps.isValid(read.bundle, role))) continue;
    const type = bundleArtifactType(read.bundle);
    if (!type) continue;
    valid.push({ role, type, bundle: structuredClone(read.bundle) });
  }
  if (valid.length === 0) return null;
  if (valid.length === 2 && bundlesDiverge(valid[0]!.bundle, valid[1]!.bundle)) {
    return null;
  }
  return valid.sort(
    (left, right) =>
      bundleArtifactTypeRank(right.bundle) - bundleArtifactTypeRank(left.bundle) ||
      (left.role === "buyer" ? -1 : 1),
  )[0]!;
}

/**
 * Two-sided bundle consistency verdict — DACS-5 §10.4.3.
 *
 * A session is anchored by up to two parties, each at its own SR-2 address
 * (`…-bundle-buyer`, `…-bundle-seller`). A consumer looking up "the bundle(s)
 * for session X" fetches both and MUST classify what it found:
 *
 *  - `absent`    — no valid copy anchored.
 *  - `oneSided`  — exactly one valid copy (the other is an anchoring omission,
 *                  §10.4.3(b) — the present copy stands as the session bundle).
 *  - `unified`   — both present and they do NOT canonically diverge (equal, or
 *                  differing only in advisory fields), §10.4.3(c).
 *  - `divergent` — both present and they contradict, §10.4.3(d) — a genuine
 *                  dispute; a reputation deriver excludes this jobId entirely.
 *
 * "Canonically diverge" is defined once (§10.4.3, the same guard the §10.5.1
 * deriver applies): the copies differ in `outcome`, or in a `phaseSummary`
 * entry's `outcome`/`errorClass` — a contradiction about what happened. A
 * difference confined to advisory fields (`finalisedAt` skew, one-sided
 * `ratingRefs`, `anchoredByRole`, amendment ordering) is NOT a divergence, so a
 * party cannot force a spurious "disputed" classification by perturbing one.
 *
 * Pure: signature/anchor validity is the caller's concern, injected via
 * `isValid` (default: treat a provided copy as valid) so this composes with
 * verifyBundleCore without importing it.
 */

export type ConsistencyVerdict = "absent" | "oneSided" | "unified" | "divergent";

export type BundleRole = "buyer" | "seller";

export interface BundleCopies {
  buyer?: Record<string, unknown> | null;
  seller?: Record<string, unknown> | null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** phaseSummary entries keyed by their `index` (the stable per-phase identifier). */
function phasesByIndex(bundle: Record<string, unknown>): Map<number, Record<string, unknown>> {
  const out = new Map<number, Record<string, unknown>>();
  const ps = bundle["phaseSummary"];
  if (Array.isArray(ps)) {
    for (const p of ps) {
      if (isObj(p) && typeof p["index"] === "number") out.set(p["index"], p);
    }
  }
  return out;
}

/**
 * Do two bundle copies canonically diverge (§10.4.3)? True iff they contradict
 * on `outcome` or on any shared `phaseSummary` entry's `outcome`/`errorClass`.
 */
export function bundlesDiverge(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  if (a["outcome"] !== b["outcome"]) return true;
  const bp = phasesByIndex(b);
  for (const [idx, pa] of phasesByIndex(a)) {
    const pb = bp.get(idx);
    if (!pb) continue; // a phase present in only one copy is not itself a contradiction
    if (pa["outcome"] !== pb["outcome"]) return true;
    if ((pa["errorClass"] ?? null) !== (pb["errorClass"] ?? null)) return true;
  }
  return false;
}

/**
 * Classify the two-sided copies for a session (§10.4.3). `isValid`, when given,
 * gates each copy on signature/anchor validity (e.g. wrap verifyBundleCore); an
 * invalid copy is treated as not-present.
 */
export function bundleConsistency(
  copies: BundleCopies,
  isValid?: (bundle: Record<string, unknown>, role: BundleRole) => boolean,
): ConsistencyVerdict {
  const keep = (b: Record<string, unknown> | null | undefined, role: BundleRole) =>
    isObj(b) && (!isValid || isValid(b, role)) ? b : null;
  const buyer = keep(copies.buyer, "buyer");
  const seller = keep(copies.seller, "seller");

  const present = [buyer, seller].filter((b): b is Record<string, unknown> => b !== null);
  if (present.length === 0) return "absent";
  if (present.length === 1) return "oneSided";
  return bundlesDiverge(buyer!, seller!) ? "divergent" : "unified";
}

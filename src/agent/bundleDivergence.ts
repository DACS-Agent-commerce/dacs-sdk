/**
 * The single canonical §10.4.3 bundle-divergence predicate, shared by the
 * two-sided consistency verdict ({@link bundleConsistency}) and the §10.5.1
 * reputation reconciliation. Two anchored copies of one session's bundle
 * "canonically diverge" when they contradict about what happened:
 *
 *  - different `outcome`; OR
 *  - a `phaseSummary` entry (keyed by its stable `index`) present in ONE copy but
 *    not the other — per DACS-Standard#224 / §10.4.3, presence-mismatch IS a
 *    divergence (a copy asserting a phase the other denies is a contradiction;
 *    the earlier terminal-phase carve-out was dropped); OR
 *  - a shared `phaseSummary` index whose `kind`/`outcome`/`errorClass` differ.
 *
 * Advisory-only differences (finalisedAt skew, one-sided ratingRefs,
 * anchoredByRole, amendment ordering) are NOT divergence — they're excluded by
 * only comparing outcome + per-phase outcome/errorClass, so a party can't force a
 * spurious "disputed" classification by perturbing one.
 *
 * Both call sites MUST use this one function; a second, subtly-different copy is
 * exactly the drift #224 was raised to close (by-index here, not by-position, so
 * a reordered-but-equal phase set doesn't false-positive).
 */

/** A bundle copy, loosely typed so both the loose and AttestationBundle callers fit. */
export interface DivergenceBundle {
  outcome?: unknown;
  phaseSummary?: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** phaseSummary entries keyed by their `index` (the stable per-phase identifier). */
function phasesByIndex(bundle: DivergenceBundle): Map<number, Record<string, unknown>> {
  const out = new Map<number, Record<string, unknown>>();
  const ps = bundle.phaseSummary;
  if (Array.isArray(ps)) {
    for (const p of ps) {
      if (isObj(p) && typeof p["index"] === "number") out.set(p["index"], p);
    }
  }
  return out;
}

/** Do two bundle copies canonically diverge (§10.4.3, #224)? */
export function bundlesDiverge(a: DivergenceBundle, b: DivergenceBundle): boolean {
  if (a.outcome !== b.outcome) return true;
  const ai = phasesByIndex(a);
  const bi = phasesByIndex(b);
  // Presence-mismatch IS divergence (#224): the size check catches a phase in `b`
  // that `a` lacks; the `!pb` check inside the loop catches the reverse.
  if (ai.size !== bi.size) return true;
  for (const [idx, pa] of ai) {
    const pb = bi.get(idx);
    if (!pb) return true;
    if (pa["kind"] !== pb["kind"]) return true;
    if (pa["outcome"] !== pb["outcome"]) return true;
    if ((pa["errorClass"] ?? null) !== (pb["errorClass"] ?? null)) return true;
  }
  return false;
}

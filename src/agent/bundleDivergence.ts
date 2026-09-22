/**
 * The single canonical §10.4.3 bundle-divergence predicate, shared by the
 * two-sided consistency verdict ({@link bundleConsistency}) and the §10.5.1
 * reputation reconciliation. Two anchored copies of one session's bundle
 * "canonically diverge" when they contradict about what happened:
 *
 *  - incompatible type-aware outcome/fault meaning; OR
 *  - a `phaseSummary` entry (keyed by its stable `index`) present in ONE copy but
 *    not the other — per DACS-Standard#224 / §10.4.3, presence-mismatch IS a
 *    divergence (a copy asserting a phase the other denies is a contradiction;
 *    the earlier terminal-phase carve-out was dropped); OR
 *  - a shared `phaseSummary` index whose `kind`/`outcome`/`errorClass` differ.
 *
 * Fault pairs compare `faultedParty` plus outcome class; legacy pairs perspective-flip the
 * counterparty copy before comparison; mixed pairs require the absolute fault to belong to the
 * legacy implied set. Advisory-only differences (finalisedAt skew, one-sided ratingRefs,
 * anchoredByRole, amendment ordering) are NOT divergence — they're excluded by
 * only comparing outcome + per-phase outcome/errorClass, so a party can't force a
 * spurious "disputed" classification by perturbing one.
 *
 * Both call sites MUST use this one function; a second, subtly-different copy is
 * exactly the drift #224 was raised to close (by-index here, not by-position, so
 * a reordered-but-equal phase set doesn't false-positive).
 */

import type { FaultedParty } from "../artifacts/types.js";
import { canonicalize } from "../canonical/jcs.js";
import {
  bundleOutcomeClass,
  isAbsoluteFaultBundle,
  legacyImpliedFaultSet,
  perspectiveFlip,
} from "./bundleSemantics.js";

/** A bundle copy, loosely typed so both the loose and AttestationBundle callers fit. */
export interface DivergenceBundle {
  bundleVersion?: unknown;
  faultBundleVersion?: unknown;
  evidenceBoundFaultBundleVersion?: unknown;
  faultedParty?: unknown;
  anchoredByRole?: unknown;
  outcome?: unknown;
  parties?: unknown;
  phaseSummary?: unknown;
  settlementEvidence?: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** phaseSummary entries keyed by their `index` (the stable per-phase identifier). */
function phasesByIndex(bundle: DivergenceBundle): Map<number, Record<string, unknown>> | null {
  const out = new Map<number, Record<string, unknown>>();
  const ps = bundle.phaseSummary;
  if (Array.isArray(ps)) {
    for (const p of ps) {
      if (isObj(p) && typeof p["index"] === "number") {
        if (out.has(p["index"])) return null;
        out.set(p["index"], p);
      }
    }
  }
  return out;
}

/** Do two bundle copies canonically diverge (§10.4.3, #224)? */
export function bundlesDiverge(a: DivergenceBundle, b: DivergenceBundle): boolean {
  const aClass = bundleOutcomeClass(a.outcome);
  const bClass = bundleOutcomeClass(b.outcome);
  if (!aClass || !bClass || aClass !== bClass) return true;

  const aFault = isAbsoluteFaultBundle(a as Record<string, unknown>);
  const bFault = isAbsoluteFaultBundle(b as Record<string, unknown>);
  const bothEvidenceBound =
    a.evidenceBoundFaultBundleVersion === "1" &&
    b.evidenceBoundFaultBundleVersion === "1";
  if (bothEvidenceBound) {
    const canonicalRefs = (bundle: DivergenceBundle): Set<string> | null => {
      const refs = bundle.settlementEvidence;
      if (!Array.isArray(refs)) return null;
      try {
        return new Set(refs.map((ref) => canonicalize(ref)));
      } catch {
        return null;
      }
    };
    const aRefs = canonicalRefs(a);
    const bRefs = canonicalRefs(b);
    if (
      !aRefs ||
      !bRefs ||
      aRefs.size !== bRefs.size ||
      [...aRefs].some((ref) => !bRefs.has(ref))
    ) return true;
  }
  if (aFault && bFault) {
    if (a.faultedParty !== b.faultedParty) return true;
  } else if (aFault || bFault) {
    const fault = aFault ? a.faultedParty : b.faultedParty;
    const legacy = aFault ? b : a;
    if (
      typeof fault !== "string" ||
      !legacyImpliedFaultSet(legacy as Record<string, unknown>).has(fault as FaultedParty)
    ) {
      return true;
    }
  } else {
    const oppositeAnchors =
      (a.anchoredByRole === "buyer" && b.anchoredByRole === "seller") ||
      (a.anchoredByRole === "seller" && b.anchoredByRole === "buyer");
    const reconciledB = oppositeAnchors ? perspectiveFlip(b.outcome) : b.outcome;
    if (a.outcome !== reconciledB) return true;
  }

  const ai = phasesByIndex(a);
  const bi = phasesByIndex(b);
  if (!ai || !bi) return true;
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

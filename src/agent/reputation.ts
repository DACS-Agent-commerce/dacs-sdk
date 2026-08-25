import type { AnyAttestationBundle } from "../artifacts/types.js";
import {
  parseCanonicalClaimReference,
  requireCanonicalClaimReference,
} from "../identity/claimReference.js";
import { bundlesDiverge } from "./bundleDivergence.js";

/**
 * Reputation for a primary claim, derived purely from its attestation bundles
 * (DACS-5). No central score — anyone holding the bundles recomputes the same
 * numbers.
 *
 * NOTE (MVP): ratings are standalone RatingRecords (§10.6) in the spec, no
 * longer embedded in the bundle, so `avgRating` is reported as null until
 * RatingRecords are wired; counts derive from each bundle's `outcome` and the
 * `parties[]` the claim appears in.
 */
export interface Reputation {
  primaryClaim: string;
  totalAgreements: number;
  completed: number;
  avgRating: number | null;
  /** Copies excluded before scoring, retained so fail-closed decisions are observable. */
  exclusions: ReputationExclusion[];
}

export interface ReputationExclusion {
  code: "invalid-bundle" | "divergent-copies";
  jobId?: string;
  ref?: string;
  reason: string;
}

/**
 * Aggregate reputation from already-validated bundles. Copies are grouped by
 * jobId and reconciled with the canonical DACS-5 divergence predicate before
 * any copy contributes. A divergent group is excluded rather than selecting
 * whichever ref happened to arrive first.
 */
export function computeReputation(
  primaryClaim: string,
  bundles: AnyAttestationBundle[],
): Reputation {
  const subject = requireCanonicalClaimReference(
    primaryClaim,
    "Reputation primaryClaim",
  ).identity;
  const canonicalIdentity = `${subject.scheme}:${subject.identifier}`;
  const mineByJob = new Map<string, AnyAttestationBundle[]>();
  for (const bundle of bundles) {
    if (
      !bundle.parties.some((party) => {
        const parsed = parseCanonicalClaimReference(party.primaryClaim);
        return parsed !== null &&
          parsed.identity.scheme === subject.scheme &&
          parsed.identity.identifier === subject.identifier;
      })
    ) {
      continue;
    }
    const copies = mineByJob.get(bundle.jobId) ?? [];
    copies.push(bundle);
    mineByJob.set(bundle.jobId, copies);
  }

  let totalAgreements = 0;
  let completed = 0;
  const exclusions: ReputationExclusion[] = [];
  const jobs = [...mineByJob.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  for (const [jobId, copies] of jobs) {
    let divergent = false;
    for (let left = 0; left < copies.length && !divergent; left += 1) {
      for (let right = left + 1; right < copies.length; right += 1) {
        if (bundlesDiverge(copies[left]!, copies[right]!)) {
          divergent = true;
          break;
        }
      }
    }
    if (divergent) {
      exclusions.push({
        code: "divergent-copies",
        jobId,
        reason: "same-job bundle copies canonically diverge",
      });
      continue;
    }
    totalAgreements += 1;
    if (copies.some((bundle) => bundle.outcome === "completed")) completed += 1;
  }

  return {
    primaryClaim: canonicalIdentity,
    totalAgreements,
    completed,
    avgRating: null,
    exclusions,
  };
}

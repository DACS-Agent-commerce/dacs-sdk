import type { AnyAttestationBundle } from "../artifacts/types.js";

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
}

/**
 * Aggregate reputation from already-validated bundles. At most one copy
 * contributes per jobId, preventing buyer/seller copies or repeated refs from
 * double-counting a session. Use `deriveReputation` when role-perspective
 * reconciliation and the full DACS-5 metrics are required.
 */
export function computeReputation(
  primaryClaim: string,
  bundles: AnyAttestationBundle[],
): Reputation {
  const mineByJob = new Map<string, AnyAttestationBundle>();
  for (const bundle of bundles) {
    if (
      bundle.parties.some((party) => party.primaryClaim === primaryClaim) &&
      !mineByJob.has(bundle.jobId)
    ) mineByJob.set(bundle.jobId, bundle);
  }
  const mine = [...mineByJob.values()];
  const completed = mine.filter((b) => b.outcome === "completed").length;
  return {
    primaryClaim,
    totalAgreements: mine.length,
    completed,
    avgRating: null,
  };
}

import type { AttestationBundle } from "../artifacts/types.js";

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
 * Aggregate reputation from a set of bundles. Counts bundles where the claim is
 * one of the `parties`; `completed` counts those whose `outcome` is "completed".
 */
export function computeReputation(
  primaryClaim: string,
  bundles: AttestationBundle[],
): Reputation {
  const mine = bundles.filter((b) =>
    b.parties.some((p) => p.primaryClaim === primaryClaim),
  );
  const completed = mine.filter((b) => b.outcome === "completed").length;
  return {
    primaryClaim,
    totalAgreements: mine.length,
    completed,
    avgRating: null,
  };
}

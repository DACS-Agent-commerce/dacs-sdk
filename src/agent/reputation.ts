import type { AttestationBundle } from "../artifacts/types.js";

/**
 * Reputation for a primary claim, derived purely from its attestation bundles
 * (DACS-5). No central score — anyone holding the bundles recomputes the same
 * numbers. `avgRating` is null when no rating is directed at the claim.
 */
export interface Reputation {
  primaryClaim: string;
  totalAgreements: number;
  completed: number;
  avgRating: number | null;
}

/**
 * Aggregate reputation from a set of bundles. Counts only bundles whose
 * `primaryClaim` is the subject; averages only ratings addressed `to` it.
 */
export function computeReputation(
  primaryClaim: string,
  bundles: AttestationBundle[],
): Reputation {
  const mine = bundles.filter((b) => b.primaryClaim === primaryClaim);
  const completed = mine.filter((b) => b.state === "completed").length;
  const scores = mine
    .flatMap((b) => b.ratings)
    .filter((r) => r.to === primaryClaim)
    .map((r) => r.score);
  const avgRating =
    scores.length > 0
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : null;
  return {
    primaryClaim,
    totalAgreements: mine.length,
    completed,
    avgRating,
  };
}

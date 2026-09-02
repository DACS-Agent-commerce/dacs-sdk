import { bundleAddress, contentHash, stripSignature } from "../canonical/index.js";
import { DacsError } from "../errors.js";
import type { AnyAttestationBundle, AttestationRef } from "../artifacts/types.js";
import {
  requireCanonicalClaimReference,
  sameCanonicalClaimIdentity,
} from "../identity/claimReference.js";
import { bundlesDiverge } from "./bundleDivergence.js";
import {
  bundleArtifactType,
  isFaultBundle,
  scoredBundleOutcome,
} from "./bundleSemantics.js";

/**
 * DACS-5 §10.5 reputation derivation — the spec-faithful, windowed reputation
 * over a party's attestation bundles. No central score: anyone holding the
 * bundles recomputes the same `ReputationDerivation`.
 *
 * Key rules implemented:
 *  - Window (§10.5.1): keep bundles the party is a party to, whose clock value
 *    (`finalisedAt`) is within [windowStart, windowEnd].
 *  - Per-jobId reconciliation: collapse buyer/seller-anchored copies of one job
 *    to a single perspective-adjusted outcome; a genuine cross-copy divergence
 *    (§10.4.3(d)) excludes the job from ALL metrics. A one-copy attribution
 *    requires authoritative absence of the missing role's copy.
 *  - Blameless substrate (§10.5, "failed-substrate denominator"):
 *    `party_fault_denom = |outcomes| − |failed-substrate|`, so substrate-induced
 *    failures never damage either party's reputation.
 *  - Null vs empty: the scalar rates are `null` when the denominator is 0 ("no
 *    signal"), while the array metrics/refs are `[]`.
 *
 * Ratings (averageBuyer/SellerRating), observedTransactionalVolume, and
 * transactionCountByCurrency are `null` / `[]` until standalone RatingRecords
 * (§10.6) and agreement-price aggregation are wired — the MVP surfaces the
 * completion / counterparty-fault / counterparty-adjusted rates.
 *
 * NOT YET HANDLED (tracked): the §10.5.1 ST-10 `cancellation` marker. A v0.2
 * deriver should resolve a cancellation marker across both non-divergent copies
 * with the ST-10 trichotomy (established → reputation-neutral like
 * failed-substrate; refuted → the fault stands; unresolvable → excluded from all
 * denominators). This deriver currently books the ordinary fault (the spec's
 * safe direction for old readers) and does NOT inspect the marker — it needs a
 * `resolveListing`-style dep for the signed-listing teeth check (§10.3.1 ST-10).
 * Gap called out here rather than silently skipped.
 */

export type SessionOutcome =
  | "completed"
  | "failed-perm"
  | "failed-counterparty"
  | "failed-substrate"
  | "aborted-by-self"
  | "aborted-by-other";

export interface ReputationMetrics {
  completionRate: number | null;
  counterpartyFaultRate: number | null;
  /**
   * §10.5.1 (v0.2): completions over the party-blameable denominator —
   * `|completed| / (party_fault_denom − (|failed-counterparty| + |aborted-by-other|))`.
   * `null` when that denominator is 0 (no signal OR all outcomes were
   * counterparty-caused). Isolates the party's own performance from
   * counterparty-caused failures.
   */
  counterpartyAdjustedCompletionRate: number | null;
  averageBuyerRating: number | null;
  averageSellerRating: number | null;
  observedTransactionalVolume: Array<{ amount: string; currency: string }>;
  /**
   * §10.5.1 (v0.2): count of completed transactions grouped by currency. `[]`
   * until agreement-price aggregation is wired (same deferral as
   * observedTransactionalVolume — schema-present, not yet populated).
   */
  transactionCountByCurrency: Array<{ currency: string; count: number }>;
}

export interface ReputationDerivation {
  derivationVersion: "1";
  partyPrimaryClaim: string;
  windowStart: number;
  windowEnd: number;
  bundleCount: number;
  metrics: ReputationMetrics;
  computedAt: number;
  windowingBasis: "finalisedAt" | "sr2-anchor-timestamp";
  bundleRefs: AttestationRef[];
}

export interface ReputationWindow {
  windowStart: number;
  windowEnd: number;
  computedAt: number;
  /** Which clock the window predicate is applied against (§10.5.3). Default finalisedAt. */
  windowingBasis?: "finalisedAt" | "sr2-anchor-timestamp";
}

// §10.4.3(d) divergence uses the ONE shared predicate (bundleDivergence.js),
// identical to the two-sided consistency verdict — presence-mismatch by phase
// `index` counts as divergence (#224). Previously a private by-position copy here
// that disagreed with bundleConsistency on length-mismatched phaseSummary.

/** §10.4.1 signed-scope content hash of a bundle (omit signatures + anchoredByRole). */
function bundleContentHash(bundle: AnyAttestationBundle): string {
  const scope = { ...stripSignature(bundle as unknown as Record<string, unknown>) };
  delete (scope as Record<string, unknown>)["anchoredByRole"];
  return contentHash(scope);
}

export interface DeriveReputationDeps {
  /**
   * §10.4.1 signature validation — drop copies that fail. Wire verifyBundle here
   * for full conformance. REQUIRED unless `trustBundles` is set: deriving
   * reputation from unvalidated bundles is a fail-open trap, so the caller must
   * make the choice explicit.
   */
  isValid?: (bundle: AnyAttestationBundle) => boolean;
  /**
   * Explicit, grep-able opt-out of signature validation (accept every copy).
   * Only for callers that have already validated the bundles upstream. Ignored
   * when `isValid` is supplied.
   */
  trustBundles?: boolean;
  /**
   * §10.5.1 SR-2 absence evidence. When only one buyer/seller copy is present,
   * a deriver may attribute it only if the other role's copy is authoritatively
   * absent. Ordinary not-found, transport failure, stale reads, or bindings
   * without an absence policy are indeterminate and must exclude.
   */
  copyAbsence?: (context: {
    jobId: string;
    missingRole: "buyer" | "seller";
    presentRole: "buyer" | "seller";
  }) => "absent" | "indeterminate";
}

/**
 * Derive a party's windowed reputation (§10.5.1). `bundles` may include both
 * buyer- and seller-anchored copies of a job; they are reconciled per jobId.
 */
export function deriveReputation(
  party: string,
  bundles: AnyAttestationBundle[],
  window: ReputationWindow,
  deps: DeriveReputationDeps = {},
): ReputationDerivation {
  const basis = window.windowingBasis ?? "finalisedAt";
  const parsedParty = requireCanonicalClaimReference(
    party,
    "ReputationDerivation partyPrimaryClaim",
  );
  const canonicalParty =
    `${parsedParty.identity.scheme}:${parsedParty.identity.identifier}`;
  if (!deps.isValid && !deps.trustBundles) {
    throw new DacsError(
      "deriveReputation requires deps.isValid (wire verifyBundle) or an explicit deps.trustBundles: true opt-out — " +
        "deriving from unvalidated bundles is not a safe default",
    );
  }
  const isValid = deps.isValid ?? (() => true);

  const scoped = bundles.filter(
    (b) =>
      b.parties.some((p) =>
        sameCanonicalClaimIdentity(p.primaryClaim, canonicalParty)
      ) &&
      window.windowStart <= b.finalisedAt &&
      b.finalisedAt <= window.windowEnd,
  );

  const empty = (): ReputationDerivation => ({
    derivationVersion: "1",
    partyPrimaryClaim: canonicalParty,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    bundleCount: 0,
    metrics: {
      completionRate: null,
      counterpartyFaultRate: null,
      counterpartyAdjustedCompletionRate: null,
      averageBuyerRating: null,
      averageSellerRating: null,
      observedTransactionalVolume: [],
      transactionCountByCurrency: [],
    },
    computedAt: window.computedAt,
    windowingBasis: basis,
    bundleRefs: [],
  });

  if (scoped.length === 0) return empty();

  // Group by jobId and reconcile to one authoritative, perspective-adjusted
  // outcome per job.
  const byJob = new Map<string, AnyAttestationBundle[]>();
  for (const b of scoped) {
    const arr = byJob.get(b.jobId) ?? [];
    arr.push(b);
    byJob.set(b.jobId, arr);
  }

  const reconciled: AnyAttestationBundle[] = [];
  const outcomes: string[] = [];
  const orchestratorFaultJobs = new Set<string>();
  for (const copies of byJob.values()) {
    const valid = copies
      .filter((b) => isValid(b))
      // Released derivation v1 has no job-bound resolution context. DACS-5
      // therefore forbids EBFAB admission here; use the distinct job-bound or
      // settlement-verified derivation path instead.
      .filter((b) => bundleArtifactType(b) !== "evidence-bound")
      .filter((b) => b.anchoredByRole === "buyer" || b.anchoredByRole === "seller");
    if (valid.length === 0) continue;
    const roleOfParty = valid[0]!.parties.find((p) =>
      sameCanonicalClaimIdentity(p.primaryClaim, canonicalParty)
    )?.role;
    if (roleOfParty !== "buyer" && roleOfParty !== "seller") continue;
    const selfCopy = valid.find((b) => b.anchoredByRole === roleOfParty);
    const cp = valid.find((b) => b.anchoredByRole !== roleOfParty);
    if (!selfCopy || !cp) {
      const present = selfCopy ?? cp;
      const presentRole = present?.anchoredByRole;
      if (!present || (presentRole !== "buyer" && presentRole !== "seller")) continue;
      const missingRole = presentRole === "buyer" ? "seller" : "buyer";
      const absence = deps.copyAbsence?.({
        jobId: present.jobId,
        missingRole,
        presentRole,
      }) ?? "indeterminate";
      if (absence !== "absent") continue;
    }
    let authoritative: AnyAttestationBundle | undefined;
    if (selfCopy) {
      if (cp && bundlesDiverge(cp, selfCopy)) continue; // genuine dispute → exclude
      authoritative = cp && isFaultBundle(cp) !== isFaultBundle(selfCopy)
        ? (isFaultBundle(cp) ? cp : selfCopy)
        : selfCopy;
    } else if (cp) {
      authoritative = cp;
    }
    if (!authoritative) continue;
    const scored = scoredBundleOutcome(authoritative, roleOfParty);
    if (!scored) continue;
    reconciled.push(authoritative);
    outcomes.push(scored);
    if (isFaultBundle(authoritative) && authoritative.faultedParty === "orchestrator") {
      orchestratorFaultJobs.add(authoritative.jobId);
    }
  }

  if (reconciled.length === 0) return empty();

  const count = (o: string) => outcomes.filter((x) => x === o).length;
  const completed = count("completed");
  const failedSubstrate = count("failed-substrate");
  const counterpartyFault = outcomes.filter(
    (outcome, index) =>
      !orchestratorFaultJobs.has(reconciled[index]!.jobId) &&
      (outcome === "aborted-by-other" || outcome === "failed-counterparty"),
  ).length;
  const partyFaultDenom = outcomes.length - failedSubstrate - orchestratorFaultJobs.size;
  const rate = (n: number) => (partyFaultDenom > 0 ? n / partyFaultDenom : null);
  // §10.5.1 (v0.2): strip counterparty-caused failures from the denominator so
  // the rate reflects only the party's own blameable performance.
  const partyBlameDenom = partyFaultDenom - counterpartyFault;
  const counterpartyAdjustedCompletionRate =
    partyBlameDenom > 0 ? completed / partyBlameDenom : null;

  const bundleRefs: AttestationRef[] = reconciled
    .map((b) => ({
      anchor: {
        kind: "storage-program" as const,
        locator: bundleAddress(b.jobId, b.anchoredByRole),
      },
      contentHash: bundleContentHash(b),
    }))
    .sort((a, b) => (a.contentHash < b.contentHash ? -1 : a.contentHash > b.contentHash ? 1 : 0));

  return {
    derivationVersion: "1",
    partyPrimaryClaim: canonicalParty,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    bundleCount: reconciled.length,
    metrics: {
      completionRate: rate(completed),
      counterpartyFaultRate: rate(counterpartyFault),
      counterpartyAdjustedCompletionRate,
      averageBuyerRating: null,
      averageSellerRating: null,
      observedTransactionalVolume: [],
      transactionCountByCurrency: [],
    },
    computedAt: window.computedAt,
    windowingBasis: basis,
    bundleRefs,
  };
}

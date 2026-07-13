import { contentHash, stripSignature } from "../canonical/index.js";
import { DacsError } from "../errors.js";
import type { AttestationBundle, AttestationRef } from "../artifacts/types.js";

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
 *    (§10.4.3(d)) excludes the job from ALL metrics.
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

/** Flip a counterparty-anchored outcome to the scored party's perspective (§10.5.1). */
function perspectiveFlip(outcome: string): string {
  switch (outcome) {
    case "aborted-by-self":
      return "aborted-by-other";
    case "aborted-by-other":
      return "aborted-by-self";
    case "failed-perm":
      return "failed-counterparty";
    case "failed-counterparty":
      return "failed-perm";
    default:
      // completed / failed-substrate are perspective-invariant.
      return outcome;
  }
}

function perspectiveFlipPhaseValue(value: unknown): unknown {
  switch (value) {
    case "aborted-by-self":
      return "aborted-by-other";
    case "aborted-by-other":
      return "aborted-by-self";
    case "failed-perm":
      return "failed-counterparty";
    case "failed-counterparty":
      return "failed-perm";
    case "permanent":
      return "counterparty";
    case "counterparty":
      return "permanent";
    default:
      return value;
  }
}

/** §10.4.3(d) "canonically diverge": contradictory outcome or phaseSummary outcome/errorClass. */
function canonicallyDiverge(a: AttestationBundle, b: AttestationBundle): boolean {
  const buyerSellerPair =
    (a.anchoredByRole === "buyer" && b.anchoredByRole === "seller") ||
    (a.anchoredByRole === "seller" && b.anchoredByRole === "buyer");
  if (a.outcome !== b.outcome && !(buyerSellerPair && perspectiveFlip(a.outcome) === b.outcome))
    return true;
  const pa = a.phaseSummary ?? [];
  const pb = b.phaseSummary ?? [];
  if (pa.length !== pb.length) return true;
  for (let i = 0; i < pa.length; i++) {
    if (
      pa[i]!.outcome !== pb[i]!.outcome &&
      !(buyerSellerPair && perspectiveFlipPhaseValue(pa[i]!.outcome) === pb[i]!.outcome)
    )
      return true;
    if (
      (pa[i] as { errorClass?: unknown }).errorClass !==
        (pb[i] as { errorClass?: unknown }).errorClass &&
      !(
        buyerSellerPair &&
        perspectiveFlipPhaseValue((pa[i] as { errorClass?: unknown }).errorClass) ===
          (pb[i] as { errorClass?: unknown }).errorClass
      )
    )
      return true;
  }
  return false;
}

/** §10.4.1 signed-scope content hash of a bundle (omit signatures + anchoredByRole). */
function bundleContentHash(bundle: AttestationBundle): string {
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
  isValid?: (bundle: AttestationBundle) => boolean;
  /**
   * Explicit, grep-able opt-out of signature validation (accept every copy).
   * Only for callers that have already validated the bundles upstream. Ignored
   * when `isValid` is supplied.
   */
  trustBundles?: boolean;
}

/**
 * Derive a party's windowed reputation (§10.5.1). `bundles` may include both
 * buyer- and seller-anchored copies of a job; they are reconciled per jobId.
 */
export function deriveReputation(
  party: string,
  bundles: AttestationBundle[],
  window: ReputationWindow,
  deps: DeriveReputationDeps = {},
): ReputationDerivation {
  const basis = window.windowingBasis ?? "finalisedAt";
  if (!deps.isValid && !deps.trustBundles) {
    throw new DacsError(
      "deriveReputation requires deps.isValid (wire verifyBundle) or an explicit deps.trustBundles: true opt-out — " +
        "deriving from unvalidated bundles is not a safe default",
    );
  }
  const isValid = deps.isValid ?? (() => true);

  const scoped = bundles.filter(
    (b) =>
      b.parties.some((p) => p.primaryClaim === party) &&
      window.windowStart <= b.finalisedAt &&
      b.finalisedAt <= window.windowEnd,
  );

  const empty = (): ReputationDerivation => ({
    derivationVersion: "1",
    partyPrimaryClaim: party,
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
  const byJob = new Map<string, AttestationBundle[]>();
  for (const b of scoped) {
    const arr = byJob.get(b.jobId) ?? [];
    arr.push(b);
    byJob.set(b.jobId, arr);
  }

  const reconciled: AttestationBundle[] = [];
  const outcomes: string[] = [];
  for (const copies of byJob.values()) {
    const valid = copies
      .filter((b) => isValid(b))
      .filter((b) => b.anchoredByRole === "buyer" || b.anchoredByRole === "seller");
    if (valid.length === 0) continue;
    const roleOfParty = valid[0]!.parties.find((p) => p.primaryClaim === party)?.role;
    const selfCopy = valid.find((b) => b.anchoredByRole === roleOfParty);
    const cp = valid.find((b) => b.anchoredByRole !== roleOfParty);
    if (selfCopy) {
      if (cp && canonicallyDiverge(cp, selfCopy)) continue; // genuine dispute → exclude
      reconciled.push(selfCopy);
      outcomes.push(selfCopy.outcome);
    } else if (cp) {
      reconciled.push(cp);
      outcomes.push(perspectiveFlip(cp.outcome));
    }
  }

  if (reconciled.length === 0) return empty();

  const count = (o: string) => outcomes.filter((x) => x === o).length;
  const completed = count("completed");
  const failedSubstrate = count("failed-substrate");
  const counterpartyFault = count("aborted-by-other") + count("failed-counterparty");
  const partyFaultDenom = outcomes.length - failedSubstrate;
  const rate = (n: number) => (partyFaultDenom > 0 ? n / partyFaultDenom : null);
  // §10.5.1 (v0.2): strip counterparty-caused failures from the denominator so
  // the rate reflects only the party's own blameable performance.
  const partyBlameDenom = partyFaultDenom - counterpartyFault;
  const counterpartyAdjustedCompletionRate =
    partyBlameDenom > 0 ? completed / partyBlameDenom : null;

  const bundleRefs: AttestationRef[] = reconciled
    .map((b) => ({
      kind: "dacs-5-bundle",
      id: b.jobId,
      contentHash: bundleContentHash(b),
    }))
    .sort((a, b) => (a.contentHash < b.contentHash ? -1 : a.contentHash > b.contentHash ? 1 : 0));

  return {
    derivationVersion: "1",
    partyPrimaryClaim: party,
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

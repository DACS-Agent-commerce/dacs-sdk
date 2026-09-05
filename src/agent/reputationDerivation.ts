import {
  bundleAddress,
  canonicalize,
  contentHash,
  stripSignature,
} from "../canonical/index.js";
import { snapshotCanonicalJsonRead } from "../canonical/snapshot.js";
import { DacsError } from "../errors.js";
import type {
  AnyAttestationBundle,
  AttestationRef,
  RatingRecord,
} from "../artifacts/types.js";
import { isRatingRecord } from "../artifacts/validators.js";
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
 * The synchronous API cannot dereference standalone RatingRecords, so its
 * averageBuyer/SellerRating fields remain null. The asynchronous validated API
 * resolves and independently authenticates those references when supplied a
 * `resolveAndAuthenticateRating` dependency. Agreement-price aggregation
 * remains separate work.
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
// `index` counts as divergence (DACS-Standard#224). Previously a private
// by-position copy here that disagreed with bundleConsistency on
// length-mismatched phaseSummary.

/** §10.4.1 signed-scope content hash of a bundle (omit signatures + anchoredByRole). */
function bundleContentHash(bundle: AnyAttestationBundle): string {
  const scope = { ...stripSignature(bundle as unknown as Record<string, unknown>) };
  delete (scope as Record<string, unknown>)["anchoredByRole"];
  return contentHash(scope);
}

export interface DeriveReputationDeps {
  /**
   * Synchronous eligibility predicate for copies that were already fully
   * authenticated upstream. This MUST return a primitive boolean. Async
   * cryptographic verification belongs in {@link deriveReputationWithValidation};
   * passing a Promise here is rejected at runtime so JavaScript/casted callers
   * cannot accidentally admit `Promise.resolve(false)` as truthy.
   *
   * REQUIRED unless `trustBundles` is set: deriving reputation from unvalidated
   * bundles is a fail-open trap, so the caller must make the choice explicit.
   */
  isValid?: (bundle: AnyAttestationBundle) => boolean;
  /**
   * Explicit, grep-able opt-out of signature validation (accept every copy).
   * Only for callers that have already validated the bundles upstream. Ignored
   * when `isValid` is supplied.
   */
  trustBundles?: boolean;
  /**
   * Resolve the scored party's buyer/seller role from independently
   * authenticated session context (normally the pinned agreement), once per
   * job. Bundle-local `parties[]` labels are signed producer assertions, not an
   * external role binding; trusting them lets a relabelled self-abort become a
   * false counterparty fault.
   *
   * The resolver is deliberately synchronous so the deterministic scorer
   * cannot admit a truthy Promise. Resolve asynchronous agreement/session data
   * before derivation and expose the retained mapping through this callback.
   * Missing, thrown, Promise-like, or non-buyer/seller results exclude that job.
   */
  resolvePartyRole?: (context: Readonly<{
    jobId: string;
    partyPrimaryClaim: string;
  }>) => "buyer" | "seller" | undefined;
  /**
   * Explicit compatibility assertion that every admitted bundle's role map was
   * already authenticated against independent session/agreement context.
   * Ignored when `resolvePartyRole` is supplied. This is distinct from
   * `trustBundles`: signature validity alone does not establish the externally
   * expected buyer/seller assignment.
   */
  trustBundlePartyRoles?: boolean;
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

export interface DeriveReputationValidationDeps {
  /**
   * Fully authenticate one untrusted candidate before it can be inspected or
   * scored. Production callers should verify the copy's role-address binding,
   * required signer set, and referenced artifacts. Only the primitive value
   * `true` admits a copy; false, non-boolean, thrown, and rejected results are
   * all excluded fail-closed.
   */
  validate: (bundle: AnyAttestationBundle) => boolean | Promise<boolean>;
  /** Authenticated per-job role binding, as defined by the pure scorer. */
  resolvePartyRole?: DeriveReputationDeps["resolvePartyRole"];
  /** Explicit pre-authenticated-role compatibility assertion. */
  trustBundlePartyRoles?: boolean;
  /** Authoritative SR-2 absence evidence, with the same contract as the pure scorer. */
  copyAbsence?: DeriveReputationDeps["copyAbsence"];
  /**
   * Resolve one untrusted `ratingRefs[]` entry and independently authenticate
   * its SR-2 anchor/binding plus `dacs-rating:v1:` signature. The SDK still
   * rechecks the exact reference hash, RatingRecord wire shape, RT-1/RT-2,
   * session parties, target role, and no-self-rating rules before aggregation.
   *
   * Omit only when rating metrics are not requested; both averages then remain
   * null. Invalid, indeterminate, malformed, thrown, and rejected resolutions
   * are excluded rather than clamped or treated as zero.
   */
  resolveAndAuthenticateRating?: (
    context: Readonly<{
      ref: Readonly<AttestationRef>;
      bundle: Readonly<AnyAttestationBundle>;
    }>,
  ) =>
    | AuthenticatedRatingResolution
    | Promise<AuthenticatedRatingResolution>;
}

export type AuthenticatedRatingResolution =
  | {
      disposition: "authenticated";
      record: Readonly<RatingRecord>;
    }
  | {
      disposition: "invalid" | "indeterminate";
      reason: string;
    };

interface ReputationCoreResult {
  derivation: ReputationDerivation;
  reconciled: Array<{
    bundle: AnyAttestationBundle;
    scoredPartyRole: "buyer" | "seller";
  }>;
}

function validatedCandidates(
  bundles: AnyAttestationBundle[],
  deps: DeriveReputationDeps,
): AnyAttestationBundle[] {
  if (deps.trustBundles === true && !deps.isValid) return bundles;
  const isValid = deps.isValid;
  if (!isValid) return [];
  return bundles.filter((bundle) => {
    const decision: unknown = isValid(bundle);
    if (typeof decision !== "boolean") {
      throw new DacsError(
        "deriveReputation deps.isValid must return a boolean synchronously; " +
          "use deriveReputationWithValidation for async cryptographic verification",
      );
    }
    return decision;
  });
}

/**
 * Derive a party's windowed reputation (§10.5.1). `bundles` may include both
 * buyer- and seller-anchored copies of a job; they are reconciled per jobId.
 */
function deriveReputationCore(
  party: string,
  bundles: AnyAttestationBundle[],
  window: ReputationWindow,
  deps: DeriveReputationDeps = {},
): ReputationCoreResult {
  const basis = window.windowingBasis ?? "finalisedAt";
  const parsedParty = requireCanonicalClaimReference(
    party,
    "ReputationDerivation partyPrimaryClaim",
  );
  const canonicalParty =
    `${parsedParty.identity.scheme}:${parsedParty.identity.identifier}`;
  if (!deps.isValid && deps.trustBundles !== true) {
    throw new DacsError(
      "deriveReputation requires deps.isValid (wire verifyBundle) or an explicit deps.trustBundles: true opt-out — " +
        "deriving from unvalidated bundles is not a safe default",
    );
  }
  if (!deps.resolvePartyRole && deps.trustBundlePartyRoles !== true) {
    throw new DacsError(
      "deriveReputation requires deps.resolvePartyRole or an explicit " +
        "deps.trustBundlePartyRoles: true assertion — bundle-local role labels " +
        "are not an independent session-role binding",
    );
  }
  // Validate before reading party/window fields. With `trustBundles`, the caller
  // explicitly attests that this happened upstream; otherwise the synchronous
  // predicate is enforced as an actual boolean at runtime.
  const candidates = validatedCandidates(bundles, deps);

  const scoped = candidates.filter(
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

  if (scoped.length === 0) {
    return { derivation: empty(), reconciled: [] };
  }

  // Group by jobId and reconcile to one authoritative, perspective-adjusted
  // outcome per job.
  const byJob = new Map<string, AnyAttestationBundle[]>();
  for (const b of scoped) {
    const arr = byJob.get(b.jobId) ?? [];
    arr.push(b);
    byJob.set(b.jobId, arr);
  }

  const reconciled: AnyAttestationBundle[] = [];
  const reconciledRoles: Array<"buyer" | "seller"> = [];
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
    let divergent = false;
    for (let left = 0; left < valid.length && !divergent; left += 1) {
      for (let right = left + 1; right < valid.length; right += 1) {
        if (bundlesDiverge(valid[left]!, valid[right]!)) {
          divergent = true;
          break;
        }
      }
    }
    if (divergent) continue;
    let roleOfParty: unknown;
    if (deps.resolvePartyRole) {
      try {
        roleOfParty = deps.resolvePartyRole(Object.freeze({
          jobId: valid[0]!.jobId,
          partyPrimaryClaim: canonicalParty,
        }));
      } catch {
        // Unavailable or malformed independent context is not permission to
        // fall back to the producer's self-declared role map.
        continue;
      }
    } else {
      // Explicit compatibility path for callers that authenticated the exact
      // party map against independent session/agreement context upstream.
      roleOfParty = valid[0]!.parties.find((candidate) =>
        sameCanonicalClaimIdentity(candidate.primaryClaim, canonicalParty)
      )?.role;
    }
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
    reconciledRoles.push(roleOfParty);
    outcomes.push(scored);
    if (isFaultBundle(authoritative) && authoritative.faultedParty === "orchestrator") {
      orchestratorFaultJobs.add(authoritative.jobId);
    }
  }

  if (reconciled.length === 0) {
    return { derivation: empty(), reconciled: [] };
  }

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
    derivation: {
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
    },
    reconciled: reconciled.map((bundle, index) => ({
      bundle,
      scoredPartyRole: reconciledRoles[index]!,
    })),
  };
}

export function deriveReputation(
  party: string,
  bundles: AnyAttestationBundle[],
  window: ReputationWindow,
  deps: DeriveReputationDeps = {},
): ReputationDerivation {
  return deriveReputationCore(party, bundles, window, deps).derivation;
}

function exactObjectKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const expected = [...required].sort();
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function capturedAuthenticatedRating(
  value: unknown,
): RatingRecord | null {
  let captured: unknown;
  try {
    captured = snapshotCanonicalJsonRead(
      value,
      "authenticated reputation rating resolution",
    );
  } catch {
    return null;
  }
  if (
    captured === null ||
    typeof captured !== "object" ||
    Array.isArray(captured)
  ) {
    return null;
  }
  const resolution = captured as Record<string, unknown>;
  if (
    resolution.disposition !== "authenticated" ||
    !exactObjectKeys(resolution, ["disposition", "record"]) ||
    !isRatingRecord(resolution.record)
  ) {
    return null;
  }
  return resolution.record;
}

function ratingTuple(record: Readonly<RatingRecord>): string {
  const rater = requireCanonicalClaimReference(
    record.rater,
    "RatingRecord rater",
  );
  return canonicalize([
    `${rater.identity.scheme}:${rater.identity.identifier}`,
    record.jobId,
    record.targetRole,
  ]);
}

function ratingWins(
  candidate: Readonly<RatingRecord>,
  retained: Readonly<RatingRecord>,
): boolean {
  if (candidate.ratedAt !== retained.ratedAt) {
    return candidate.ratedAt > retained.ratedAt;
  }
  // The Standard selects the last writer by ratedAt. A malicious or migrated
  // store can nevertheless present two authenticated records with the same
  // tuple and timestamp. The unsigned content hash is a canonical final
  // tie-break so input order and duplicate bundle copies cannot alter a score.
  const candidateHash = contentHash(
    stripSignature(candidate as unknown as Record<string, unknown>),
  );
  const retainedHash = contentHash(
    stripSignature(retained as unknown as Record<string, unknown>),
  );
  return candidateHash > retainedHash;
}

async function deriveAuthenticatedRatingAverages(
  party: string,
  sessions: ReputationCoreResult["reconciled"],
  resolve: NonNullable<
    DeriveReputationValidationDeps["resolveAndAuthenticateRating"]
  >,
): Promise<Pick<ReputationMetrics, "averageBuyerRating" | "averageSellerRating">> {
  const retained = new Map<string, RatingRecord>();
  const candidates = sessions.flatMap(({ bundle, scoredPartyRole }) =>
    (bundle.ratingRefs ?? []).map((ref) => ({ bundle, ref, scoredPartyRole })),
  );

  const resolved = await Promise.all(
    candidates.map(async ({ bundle, ref, scoredPartyRole }) => {
      try {
        const context = snapshotCanonicalJsonRead(
          { bundle, ref },
          "reputation rating resolution context",
        );
        const resolution = await resolve(context);
        return {
          bundle,
          ref,
          scoredPartyRole,
          record: capturedAuthenticatedRating(resolution),
        };
      } catch {
        return { bundle, ref, scoredPartyRole, record: null };
      }
    }),
  );

  for (const { bundle, ref, scoredPartyRole, record } of resolved) {
    if (!record) continue;
    const unsignedHash = contentHash(
      stripSignature(record as unknown as Record<string, unknown>),
    );
    const rater = bundle.parties.find((candidate) =>
      sameCanonicalClaimIdentity(candidate.primaryClaim, record.rater)
    );
    const target = bundle.parties.find((candidate) =>
      sameCanonicalClaimIdentity(candidate.primaryClaim, record.target)
    );
    if (
      unsignedHash !== ref.contentHash ||
      record.jobId !== bundle.jobId ||
      !sameCanonicalClaimIdentity(record.target, party) ||
      sameCanonicalClaimIdentity(record.rater, party) ||
      record.targetRole !== scoredPartyRole ||
      !rater ||
      !target ||
      (rater.role !== "buyer" && rater.role !== "seller") ||
      rater.role === scoredPartyRole ||
      !sameCanonicalClaimIdentity(target.primaryClaim, party) ||
      target.role !== scoredPartyRole
    ) {
      continue;
    }
    const tuple = ratingTuple(record);
    const current = retained.get(tuple);
    if (!current || ratingWins(record, current)) {
      retained.set(tuple, record);
    }
  }

  const buyerRatings: number[] = [];
  const sellerRatings: number[] = [];
  for (const rating of retained.values()) {
    (rating.targetRole === "buyer" ? buyerRatings : sellerRatings).push(
      rating.value,
    );
  }
  const average = (values: readonly number[]): number | null =>
    values.length === 0
      ? null
      : values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    averageBuyerRating: average(buyerRatings),
    averageSellerRating: average(sellerRatings),
  };
}

/**
 * Async fail-closed boundary for untrusted reputation candidates. Validation is
 * completed for every candidate before the synchronous derivation reads or
 * scores any admitted copy. This keeps the deterministic scorer pure while
 * making the cryptographic verification contract truthful for public callers.
 */
export async function deriveReputationWithValidation(
  party: string,
  bundles: AnyAttestationBundle[],
  window: ReputationWindow,
  deps: DeriveReputationValidationDeps,
): Promise<ReputationDerivation> {
  if (!deps) {
    throw new DacsError(
      "deriveReputationWithValidation requires deps.validate",
    );
  }
  // Capture every dependency before the first await. A caller cannot change
  // role/absence/rating authority while bundle validation is in flight.
  const validateSource = deps.validate;
  const resolvePartyRoleSource = deps.resolvePartyRole;
  const trustBundlePartyRoles = deps.trustBundlePartyRoles;
  const copyAbsenceSource = deps.copyAbsence;
  const ratingResolverSource = deps.resolveAndAuthenticateRating;
  if (typeof validateSource !== "function") {
    throw new DacsError(
      "deriveReputationWithValidation requires deps.validate",
    );
  }
  const validate = validateSource.bind(deps);
  const resolvePartyRole = typeof resolvePartyRoleSource === "function"
    ? resolvePartyRoleSource.bind(deps)
    : undefined;
  const copyAbsence = typeof copyAbsenceSource === "function"
    ? copyAbsenceSource.bind(deps)
    : undefined;
  const resolveAndAuthenticateRating =
    typeof ratingResolverSource === "function"
      ? ratingResolverSource.bind(deps)
      : undefined;
  if (!resolvePartyRole && trustBundlePartyRoles !== true) {
    throw new DacsError(
      "deriveReputationWithValidation requires deps.resolvePartyRole or an " +
        "explicit deps.trustBundlePartyRoles: true assertion",
    );
  }

  const capturedWindow = deepFreeze(snapshotCanonicalJsonRead(
    window,
    "reputation validation window",
  )) as ReputationWindow;
  const capturedBundles: AnyAttestationBundle[] = [];
  for (const bundle of bundles) {
    try {
      capturedBundles.push(deepFreeze(snapshotCanonicalJsonRead(
        bundle,
        "untrusted reputation bundle",
      )) as AnyAttestationBundle);
    } catch {
      // A candidate that cannot be captured as inert canonical JSON is not a
      // stable object a validator can authenticate and the scorer can reuse.
    }
  }

  const accepted: AnyAttestationBundle[] = [];
  for (const bundle of capturedBundles) {
    try {
      const decision: unknown = await validate(bundle);
      if (decision === true) {
        accepted.push(bundle);
      }
    } catch {
      // Verification transport errors, rejected Promises, and hostile inputs are
      // indeterminate, never permission to include the candidate in a score.
    }
  }

  const core = deriveReputationCore(party, accepted, capturedWindow, {
    isValid: () => true,
    ...(resolvePartyRole
      ? { resolvePartyRole }
      : { trustBundlePartyRoles: true }),
    ...(copyAbsence ? { copyAbsence } : {}),
  });
  if (!resolveAndAuthenticateRating || core.reconciled.length === 0) {
    return core.derivation;
  }
  const ratingMetrics = await deriveAuthenticatedRatingAverages(
    core.derivation.partyPrimaryClaim,
    core.reconciled,
    resolveAndAuthenticateRating,
  );
  return {
    ...core.derivation,
    metrics: {
      ...core.derivation.metrics,
      ...ratingMetrics,
    },
  };
}

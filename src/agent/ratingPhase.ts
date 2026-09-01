import type {
  AttestationRef,
  PhaseStep,
  RatingRecord,
} from "../artifacts/types.js";
import {
  isAttestationRef,
  isPhaseStep,
  isRatingRecord,
} from "../artifacts/validators.js";
import {
  canonicalize,
  contentHash,
  ratingAddress,
  sha256Hex,
  stripSignature,
} from "../canonical/index.js";
import {
  snapshotCanonicalJson,
  snapshotCanonicalJsonRead,
} from "../canonical/snapshot.js";
import { DacsError } from "../errors.js";
import { isCanonicalClaimReference } from "../identity/claimReference.js";
import type { DurablePublishedRating } from "./durableRatingPublication.js";

export type RatingPartyRole = "buyer" | "seller";

export interface RatingPhaseParty {
  role: "buyer" | "seller" | "orchestrator";
  primaryClaim: string;
}

/** Authenticated projection of one completed pre-rate phase. */
export interface RatingPhasePriorResult {
  index: number;
  step: PhaseStep;
  ok: boolean;
}

/**
 * Minimal authenticated SessionRecord projection needed to authorize rate.
 * The verifier must bind this projection to the exact full record named by
 * sessionRecordHash; this object is not a replacement SessionRecord.
 */
export interface RatingPhaseAuthorityInput {
  jobId: string;
  sessionRecordHash: string;
  state: "rate-pending";
  parties: readonly RatingPhaseParty[];
  pipeline: readonly PhaseStep[];
  phaseResults: readonly RatingPhasePriorResult[];
}

export type RatingPhaseAuthenticationVerdict =
  | { disposition: "valid" }
  | { disposition: "invalid" | "indeterminate"; reason: string };

export interface CreateRatingPhasePlanDeps {
  /**
   * Authenticate the exact projection against the retained full SessionRecord,
   * its hash, Listing pipeline, Agreement parties, and forward-only state.
   */
  authenticateAuthority: (
    authority: Readonly<RatingPhaseAuthorityInput>,
  ) =>
    | RatingPhaseAuthenticationVerdict
    | Promise<RatingPhaseAuthenticationVerdict>;
}

export interface RatingPhasePlan {
  planVersion: "1";
  jobId: string;
  sessionRecordHash: string;
  buyer: string;
  seller: string;
  phaseIndex: number;
  step: Readonly<PhaseStep>;
  settlementPhaseIndices: readonly number[];
  requiredAdvisory: boolean;
  planHash: string;
}

export type RatingPhaseSubmission =
  | {
      role: RatingPartyRole;
      disposition: "declined";
      reason: string;
    }
  | {
      role: RatingPartyRole;
      disposition: "published";
      publication: Readonly<DurablePublishedRating>;
    };

export interface RatingPhaseCompletedEntry {
  index: number;
  step: Readonly<PhaseStep>;
  invokedAt: number;
  result: Readonly<{
    ok: boolean;
    reason?: string;
    contextDelta?: Readonly<Record<string, unknown>>;
  }>;
  contextDelta: Readonly<Record<string, unknown>>;
}

export type RatingPhaseRoleResult =
  | {
      role: RatingPartyRole;
      disposition: "published";
      ref: Readonly<AttestationRef>;
    }
  | {
      role: RatingPartyRole;
      disposition: "declined" | "absent" | "rejected";
      reason: string;
    };

export interface RatingPhaseReadyHandoff {
  handoffVersion: "1";
  disposition: "ready";
  jobId: string;
  sessionRecordHash: string;
  planHash: string;
  phaseEntry: Readonly<RatingPhaseCompletedEntry>;
  ratingRefs: readonly Readonly<AttestationRef>[];
  roleResults: readonly Readonly<RatingPhaseRoleResult>[];
  /** Observability only. ST-5 forbids this advisory from blocking ST-11. */
  requiredAdvisoryMissingRoles: readonly RatingPartyRole[];
  handoffHash: string;
}

export type RatingPhaseCompletion =
  | Readonly<RatingPhaseReadyHandoff>
  | Readonly<{
      disposition: "waiting";
      jobId: string;
      planHash: string;
      pendingRoles: readonly RatingPartyRole[];
      reason: string;
    }>;

export interface CompleteRatingPhaseDeps {
  /** Re-authenticate a serialized/replayed plan against retained session state. */
  authenticatePlan: (
    plan: Readonly<RatingPhasePlan>,
  ) =>
    | RatingPhaseAuthenticationVerdict
    | Promise<RatingPhaseAuthenticationVerdict>;
  /** Re-authenticate the remote or replayed publication before its ref is used. */
  authenticatePublication: (input: Readonly<{
    plan: Readonly<RatingPhasePlan>;
    role: RatingPartyRole;
    publication: Readonly<DurablePublishedRating>;
  }>) =>
    | RatingPhaseAuthenticationVerdict
    | Promise<RatingPhaseAuthenticationVerdict>;
}

const ROLE_ORDER: readonly RatingPartyRole[] = ["buyer", "seller"];
const HASH = /^[0-9a-f]{64}$/;

function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

function sameValue(left: unknown, right: unknown): boolean {
  try {
    return canonicalize(left) === canonicalize(right);
  } catch {
    return false;
  }
}

function captureVerdict(
  value: unknown,
  label: string,
): RatingPhaseAuthenticationVerdict {
  const captured = snapshotCanonicalJsonRead(
    value,
    label,
  ) as RatingPhaseAuthenticationVerdict;
  if (
    captured === null ||
    typeof captured !== "object" ||
    Array.isArray(captured)
  ) {
    throw new DacsError(`${label} is malformed`);
  }
  const record = captured as unknown as Record<string, unknown>;
  if (
    captured.disposition === "valid" &&
    exactKeys(record, ["disposition"])
  ) {
    return captured;
  }
  if (
    (captured.disposition === "invalid" ||
      captured.disposition === "indeterminate") &&
    exactKeys(record, ["disposition", "reason"]) &&
    typeof captured.reason === "string" &&
    captured.reason.length > 0
  ) {
    return captured;
  }
  throw new DacsError(`${label} is malformed`);
}

function captureAuthority(
  value: Readonly<RatingPhaseAuthorityInput>,
): RatingPhaseAuthorityInput {
  const captured = snapshotCanonicalJson(
    value,
    "rating phase authority",
  ) as RatingPhaseAuthorityInput;
  const record = captured as unknown as Record<string, unknown>;
  if (
    !exactKeys(record, [
      "jobId",
      "sessionRecordHash",
      "state",
      "parties",
      "pipeline",
      "phaseResults",
    ]) ||
    typeof captured.jobId !== "string" ||
    captured.jobId.length === 0 ||
    captured.jobId.trim() !== captured.jobId ||
    !HASH.test(captured.sessionRecordHash) ||
    captured.state !== "rate-pending" ||
    !Array.isArray(captured.parties) ||
    !Array.isArray(captured.pipeline) ||
    !Array.isArray(captured.phaseResults)
  ) {
    throw new DacsError("rating phase authority has a non-canonical shape");
  }
  return captured;
}

function derivePlan(authority: RatingPhaseAuthorityInput): RatingPhasePlan {
  const parties = new Map<string, string>();
  const claims = new Set<string>();
  for (const party of authority.parties) {
    if (
      party === null ||
      typeof party !== "object" ||
      Array.isArray(party) ||
      !exactKeys(party as unknown as Record<string, unknown>, [
        "role",
        "primaryClaim",
      ]) ||
      !["buyer", "seller", "orchestrator"].includes(party.role) ||
      !isCanonicalClaimReference(party.primaryClaim) ||
      parties.has(party.role) ||
      claims.has(party.primaryClaim)
    ) {
      throw new DacsError("rating phase parties are malformed or duplicated");
    }
    parties.set(party.role, party.primaryClaim);
    claims.add(party.primaryClaim);
  }
  const buyer = parties.get("buyer");
  const seller = parties.get("seller");
  if (!buyer || !seller || buyer === seller) {
    throw new DacsError("rating phase requires distinct buyer and seller parties");
  }
  if (
    authority.pipeline.length === 0 ||
    authority.pipeline.some((step) => !isPhaseStep(step))
  ) {
    throw new DacsError("rating phase pipeline is malformed");
  }
  const rateIndices = authority.pipeline.flatMap((step, index) =>
    step.kind === "rate" ? [index] : [],
  );
  if (
    rateIndices.length !== 1 ||
    rateIndices[0] !== authority.pipeline.length - 1
  ) {
    throw new DacsError("rating phase must be the single final pipeline step");
  }
  const phaseIndex = rateIndices[0]!;
  if (authority.phaseResults.length !== phaseIndex) {
    throw new DacsError("rating phase requires every prior phase result exactly once");
  }
  for (let index = 0; index < phaseIndex; index += 1) {
    const result = authority.phaseResults[index];
    if (
      result === null ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      !exactKeys(result as unknown as Record<string, unknown>, [
        "index",
        "step",
        "ok",
      ]) ||
      result.index !== index ||
      result.ok !== true ||
      !isPhaseStep(result.step) ||
      !sameValue(result.step, authority.pipeline[index])
    ) {
      throw new DacsError(
        "rating phase cannot start until every prior pipeline phase succeeded",
      );
    }
  }
  const settlementPhaseIndices = authority.pipeline.flatMap((step, index) =>
    index < phaseIndex &&
    (step.kind.startsWith("pay-") || step.kind.startsWith("deliver-"))
      ? [index]
      : [],
  );
  const step = authority.pipeline[phaseIndex]!;
  const withoutHash = {
    planVersion: "1" as const,
    jobId: authority.jobId,
    sessionRecordHash: authority.sessionRecordHash,
    buyer,
    seller,
    phaseIndex,
    step,
    settlementPhaseIndices,
    requiredAdvisory: step.parameters?.required === true,
  };
  return {
    ...withoutHash,
    planHash: sha256Hex(canonicalize(withoutHash)),
  };
}

function capturePlan(value: Readonly<RatingPhasePlan>): RatingPhasePlan {
  const captured = snapshotCanonicalJsonRead(
    value,
    "rating phase plan",
  ) as RatingPhasePlan;
  if (
    captured === null ||
    typeof captured !== "object" ||
    Array.isArray(captured) ||
    !exactKeys(captured as unknown as Record<string, unknown>, [
      "planVersion",
      "jobId",
      "sessionRecordHash",
      "buyer",
      "seller",
      "phaseIndex",
      "step",
      "settlementPhaseIndices",
      "requiredAdvisory",
      "planHash",
    ]) ||
    captured.planVersion !== "1" ||
    typeof captured.jobId !== "string" ||
    captured.jobId.length === 0 ||
    captured.jobId.trim() !== captured.jobId ||
    captured.jobId.normalize("NFC") !== captured.jobId ||
    /[\u0000-\u001f\u007f]/.test(captured.jobId) ||
    !HASH.test(captured.sessionRecordHash) ||
    !HASH.test(captured.planHash) ||
    !isCanonicalClaimReference(captured.buyer) ||
    !isCanonicalClaimReference(captured.seller) ||
    captured.buyer === captured.seller ||
    !Number.isSafeInteger(captured.phaseIndex) ||
    captured.phaseIndex < 0 ||
    !isPhaseStep(captured.step) ||
    captured.step.kind !== "rate" ||
    !Array.isArray(captured.settlementPhaseIndices) ||
    captured.settlementPhaseIndices.some(
      (index) => !Number.isSafeInteger(index) || index < 0 || index >= captured.phaseIndex,
    ) ||
    new Set(captured.settlementPhaseIndices).size !==
      captured.settlementPhaseIndices.length ||
    captured.settlementPhaseIndices.some(
      (index, position) =>
        position > 0 && index <= captured.settlementPhaseIndices[position - 1]!,
    ) ||
    typeof captured.requiredAdvisory !== "boolean" ||
    captured.requiredAdvisory !== (captured.step.parameters?.required === true)
  ) {
    throw new DacsError("rating phase plan is malformed");
  }
  const { planHash, ...withoutHash } = captured;
  if (sha256Hex(canonicalize(withoutHash)) !== planHash) {
    throw new DacsError("rating phase plan hash does not match its authority");
  }
  return captured;
}

/** Authenticate a rate-pending SessionRecord projection and derive an immutable plan. */
export async function createRatingPhasePlan(
  input: Readonly<RatingPhaseAuthorityInput>,
  deps: Readonly<CreateRatingPhasePlanDeps>,
): Promise<Readonly<RatingPhasePlan>> {
  const authority = captureAuthority(input);
  const plan = derivePlan(authority);
  if (!deps || typeof deps.authenticateAuthority !== "function") {
    throw new DacsError("rating phase requires authority authentication");
  }
  const authenticateAuthority = deps.authenticateAuthority;
  let verdict: RatingPhaseAuthenticationVerdict;
  try {
    verdict = captureVerdict(
      await authenticateAuthority(deepFreeze(snapshotCanonicalJson(
        authority,
        "rating phase authentication input",
      ))),
      "rating phase authority verdict",
    );
  } catch (error) {
    throw new DacsError(
      `rating phase authority is indeterminate: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (verdict.disposition !== "valid") {
    throw new DacsError(
      `rating phase authority is ${verdict.disposition}: ${verdict.reason}`,
    );
  }
  return deepFreeze(snapshotCanonicalJson(plan, "rating phase plan output"));
}

function capturePublication(
  value: unknown,
  plan: RatingPhasePlan,
  role: RatingPartyRole,
): DurablePublishedRating {
  const publication = snapshotCanonicalJsonRead(
    value,
    `${role} rating publication`,
  ) as DurablePublishedRating;
  if (
    publication === null ||
    typeof publication !== "object" ||
    Array.isArray(publication) ||
    !exactKeys(publication as unknown as Record<string, unknown>, [
      "publicationVersion",
      "logicalAddress",
      "expectedOwner",
      "nativeAddress",
      "bindingContentHash",
      "record",
      "ref",
    ]) ||
    publication.publicationVersion !== "1" ||
    typeof publication.expectedOwner !== "string" ||
    publication.expectedOwner.length === 0 ||
    typeof publication.nativeAddress !== "string" ||
    publication.nativeAddress.length === 0 ||
    !HASH.test(publication.bindingContentHash) ||
    !isRatingRecord(publication.record) ||
    !isAttestationRef(publication.ref)
  ) {
    throw new DacsError(`${role} rating publication is malformed`);
  }
  const rater = role === "buyer" ? plan.buyer : plan.seller;
  const target = role === "buyer" ? plan.seller : plan.buyer;
  const targetRole = role === "buyer" ? "seller" : "buyer";
  const unsignedHash = contentHash(
    stripSignature(publication.record as unknown as Record<string, unknown>),
  );
  const fullHash = contentHash(
    publication.record as unknown as Record<string, unknown>,
  );
  if (
    publication.record.jobId !== plan.jobId ||
    publication.record.rater !== rater ||
    publication.record.target !== target ||
    publication.record.targetRole !== targetRole ||
    publication.logicalAddress !== ratingAddress(plan.jobId, rater) ||
    publication.ref.contentHash !== unsignedHash ||
    publication.ref.signer !== rater ||
    publication.ref.anchor.kind !== "storage-program" ||
    publication.ref.anchor.locator !== publication.nativeAddress ||
    publication.bindingContentHash !== fullHash
  ) {
    throw new DacsError(`${role} rating publication is not bound to the plan`);
  }
  return publication;
}

type CapturedRatingPhaseSubmission = RatingPhaseSubmission | {
  role: RatingPartyRole;
  disposition: "rejected";
  reason: string;
};

function captureSubmissions(
  values: readonly Readonly<RatingPhaseSubmission>[],
  plan: RatingPhasePlan,
): Map<RatingPartyRole, CapturedRatingPhaseSubmission> {
  if (!Array.isArray(values)) {
    throw new DacsError("rating phase submissions must be an array");
  }
  const submissions = new Map<RatingPartyRole, CapturedRatingPhaseSubmission>();
  for (const raw of values) {
    const value = snapshotCanonicalJsonRead(
      raw,
      "rating phase submission",
    ) as RatingPhaseSubmission;
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (value.role !== "buyer" && value.role !== "seller") ||
      submissions.has(value.role)
    ) {
      throw new DacsError("rating phase submission role is malformed or duplicated");
    }
    if (
      value.disposition === "declined" &&
      exactKeys(value as unknown as Record<string, unknown>, [
        "role",
        "disposition",
        "reason",
      ]) &&
      typeof value.reason === "string" &&
      value.reason.length > 0
    ) {
      submissions.set(value.role, value);
      continue;
    }
    if (
      value.disposition === "published" &&
      exactKeys(value as unknown as Record<string, unknown>, [
        "role",
        "disposition",
        "publication",
      ])
    ) {
      try {
        submissions.set(value.role, {
          role: value.role,
          disposition: "published",
          publication: capturePublication(value.publication, plan, value.role),
        });
      } catch (error) {
        submissions.set(value.role, {
          role: value.role,
          disposition: "rejected",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }
    throw new DacsError("rating phase submission is malformed");
  }
  return submissions;
}

/**
 * Authenticate independent role publications and produce the exact SessionRecord
 * phase entry plus ratingRefs inventory consumed by terminal bundle finalizers.
 */
export async function completeRatingPhase(
  planInput: Readonly<RatingPhasePlan>,
  submissionsInput: readonly Readonly<RatingPhaseSubmission>[],
  invokedAt: number,
  deps: Readonly<CompleteRatingPhaseDeps>,
): Promise<RatingPhaseCompletion> {
  const plan = capturePlan(planInput);
  if (!Number.isSafeInteger(invokedAt) || invokedAt < 0) {
    throw new DacsError("rating phase invokedAt must be a non-negative safe integer");
  }
  if (
    !deps ||
    typeof deps.authenticatePlan !== "function" ||
    typeof deps.authenticatePublication !== "function"
  ) {
    throw new DacsError("rating phase requires plan and publication authentication");
  }
  const authenticatePlan = deps.authenticatePlan;
  const authenticatePublication = deps.authenticatePublication;
  let planVerdict: RatingPhaseAuthenticationVerdict;
  try {
    planVerdict = captureVerdict(
      await authenticatePlan(deepFreeze(snapshotCanonicalJson(
        plan,
        "rating phase plan authentication input",
      ))),
      "rating phase plan verdict",
    );
  } catch {
    return deepFreeze({
      disposition: "waiting" as const,
      jobId: plan.jobId,
      planHash: plan.planHash,
      pendingRoles: [...ROLE_ORDER],
      reason: "rating phase plan authentication is indeterminate",
    });
  }
  if (planVerdict.disposition === "indeterminate") {
    return deepFreeze({
      disposition: "waiting" as const,
      jobId: plan.jobId,
      planHash: plan.planHash,
      pendingRoles: [...ROLE_ORDER],
      reason: planVerdict.reason,
    });
  }
  if (planVerdict.disposition === "invalid") {
    throw new DacsError(`rating phase plan is invalid: ${planVerdict.reason}`);
  }
  const submissions = captureSubmissions(submissionsInput, plan);
  const roleResults: RatingPhaseRoleResult[] = [];
  const ratingRefs: AttestationRef[] = [];
  const pendingRoles: RatingPartyRole[] = [];

  for (const role of ROLE_ORDER) {
    const submission = submissions.get(role);
    if (!submission) {
      roleResults.push({
        role,
        disposition: "absent",
        reason: "no rating submitted",
      });
      continue;
    }
    if (submission.disposition === "declined") {
      roleResults.push({
        role,
        disposition: "declined",
        reason: submission.reason,
      });
      continue;
    }
    if (submission.disposition === "rejected") {
      roleResults.push(submission);
      continue;
    }
    let verdict: RatingPhaseAuthenticationVerdict;
    try {
      verdict = captureVerdict(
        await authenticatePublication(deepFreeze(snapshotCanonicalJson({
          plan,
          role,
          publication: submission.publication,
        }, `${role} rating authentication input`))),
        `${role} rating publication verdict`,
      );
    } catch {
      pendingRoles.push(role);
      continue;
    }
    if (verdict.disposition === "indeterminate") {
      pendingRoles.push(role);
      continue;
    }
    if (verdict.disposition === "invalid") {
      roleResults.push({
        role,
        disposition: "rejected",
        reason: verdict.reason,
      });
      continue;
    }
    ratingRefs.push(snapshotCanonicalJson(
      submission.publication.ref,
      `${role} rating ref`,
    ));
    roleResults.push({
      role,
      disposition: "published",
      ref: snapshotCanonicalJson(submission.publication.ref, `${role} rating ref result`),
    });
  }

  if (pendingRoles.length > 0) {
    return deepFreeze({
      disposition: "waiting" as const,
      jobId: plan.jobId,
      planHash: plan.planHash,
      pendingRoles,
      reason: "one or more submitted ratings remain authentication-indeterminate",
    });
  }

  const contextDelta: Record<string, unknown> = ratingRefs.length > 0
    ? { ratingRefs }
    : {};
  const result = ratingRefs.length > 0
    ? { ok: true as const, contextDelta }
    : {
        ok: false as const,
        reason: "rating absent, declined, or rejected",
        contextDelta,
      };
  const phaseEntry: RatingPhaseCompletedEntry = {
    index: plan.phaseIndex,
    step: plan.step,
    invokedAt,
    result,
    contextDelta,
  };
  const requiredAdvisoryMissingRoles = plan.requiredAdvisory
    ? ROLE_ORDER.filter((role) =>
        roleResults.find((result) => result.role === role)?.disposition !== "published"
      )
    : [];
  const withoutHash = {
    handoffVersion: "1" as const,
    disposition: "ready" as const,
    jobId: plan.jobId,
    sessionRecordHash: plan.sessionRecordHash,
    planHash: plan.planHash,
    phaseEntry,
    ratingRefs,
    roleResults,
    requiredAdvisoryMissingRoles,
  };
  return deepFreeze(snapshotCanonicalJson({
    ...withoutHash,
    handoffHash: sha256Hex(canonicalize(withoutHash)),
  }, "rating phase terminal handoff"));
}

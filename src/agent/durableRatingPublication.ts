import type { RatingRecord, AttestationRef } from "../artifacts/types.js";
import { isAttestationRef, isRatingRecord } from "../artifacts/validators.js";
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
import type { AnchorBinding } from "../discovery/binding.js";
import type {
  BoundArtifactRepository,
  BoundArtifactWriteResult,
} from "../discovery/boundArtifactRepository.js";
import type { VerifiedRead } from "../discovery/verifiedRead.js";
import { DacsError } from "../errors.js";
import { isCanonicalClaimReference } from "../identity/claimReference.js";

const EFFECT_KIND = "artifact-publication" as const;
const EFFECT_SCHEMA = "dacs-rating-publication-effect/v1" as const;
const RESULT_SCHEMA = "dacs-rating-publication/v1" as const;

export interface RatingPublicationEffectLease {
  owner: string;
  generation: number;
  expiresAt: number;
  mode: "perform" | "reconcile";
}

export interface RatingPublicationEffectRecord {
  kind: typeof EFFECT_KIND;
  effectId: string;
  bindingHash: string;
  inputHash: string;
  idempotencyKey: string;
  state:
    | "intent"
    | "active"
    | "reconciliation-required"
    | "operator-action"
    | "completed";
  generation: number;
  attempts: number;
  result?: unknown;
  lease?: Readonly<RatingPublicationEffectLease>;
}

export type RatingPublicationEffectClaim = Readonly<
  | {
      status: "acquired";
      mode: "perform" | "reconcile";
      record: Readonly<RatingPublicationEffectRecord>;
      lease: Readonly<RatingPublicationEffectLease>;
    }
  | {
      status: "waiting";
      record: Readonly<RatingPublicationEffectRecord>;
      lease: Readonly<RatingPublicationEffectLease>;
    }
  | {
      status: "completed";
      record: Readonly<RatingPublicationEffectRecord>;
    }
  | {
      status: "not-runnable";
      record: Readonly<RatingPublicationEffectRecord>;
    }
  | { status: "missing" }
  | { status: "stale" }
>;

export type RatingPublicationEffectWrite = Readonly<
  | {
      status: "recorded" | "existing";
      record: Readonly<RatingPublicationEffectRecord>;
    }
  | { status: "missing" | "stale" | "conflict" }
>;

/**
 * Structural subset of the dacs-node SQLite effect store. The host database's
 * generic `artifact-publication` effect implements this interface directly;
 * alternate hosts may provide an equivalent durable generation-fenced store.
 */
export interface RatingPublicationEffectStore {
  putEffectIntent(input: Readonly<{
    kind: typeof EFFECT_KIND;
    effectId: string;
    bindingHash: string;
    input: unknown;
    idempotencyKey: string;
  }>): Readonly<{
    status: "created" | "existing" | "conflict";
    record?: Readonly<RatingPublicationEffectRecord>;
  }> | Promise<Readonly<{
    status: "created" | "existing" | "conflict";
    record?: Readonly<RatingPublicationEffectRecord>;
  }>>;
  claimEffect(input: Readonly<{
    kind: typeof EFFECT_KIND;
    effectId: string;
    bindingHash: string;
    owner: string;
    leaseDurationMs: number;
  }>): RatingPublicationEffectClaim | Promise<RatingPublicationEffectClaim>;
  isCurrentEffect(input: Readonly<{
    kind: typeof EFFECT_KIND;
    effectId: string;
    bindingHash: string;
    lease: Readonly<RatingPublicationEffectLease>;
  }>): boolean | Promise<boolean>;
  recordEffectCompleted(input: Readonly<{
    kind: typeof EFFECT_KIND;
    effectId: string;
    bindingHash: string;
    lease: Readonly<RatingPublicationEffectLease>;
    result: unknown;
  }>): RatingPublicationEffectWrite | Promise<RatingPublicationEffectWrite>;
  recordEffectAmbiguous(input: Readonly<{
    kind: typeof EFFECT_KIND;
    effectId: string;
    bindingHash: string;
    lease: Readonly<RatingPublicationEffectLease>;
    reasonCode: string;
  }>): RatingPublicationEffectWrite | Promise<RatingPublicationEffectWrite>;
  requireEffectOperatorAction(input: Readonly<{
    kind: typeof EFFECT_KIND;
    effectId: string;
    bindingHash: string;
    lease: Readonly<RatingPublicationEffectLease>;
    reasonCode: string;
  }>): RatingPublicationEffectWrite | Promise<RatingPublicationEffectWrite>;
}

export interface DurableRatingPublicationInput {
  /** Exact signed RatingRecord retained before this call and on every retry. */
  record: Readonly<RatingRecord>;
  /** Exact authenticated parties for the completed session. */
  buyer: string;
  seller: string;
  /** Substrate owner authorised by the rater's authenticated identity. */
  expectedOwner: string;
}

export type RatingAuthenticationVerdict =
  | { disposition: "valid" }
  | { disposition: "invalid"; reason: string }
  | { disposition: "indeterminate"; reason: string };

export type RatingAnchorAuthenticationVerdict = RatingAuthenticationVerdict;

type SuccessfulBoundWrite = Extract<
  BoundArtifactWriteResult,
  { status: "published" | "already-published" }
>;

export interface DurableRatingPublicationDeps {
  effectStore: RatingPublicationEffectStore;
  workerId: string;
  leaseDurationMs: number;
  repository: BoundArtifactRepository;
  /**
   * Authenticate the RatingRecord signature and the rater -> expectedOwner
   * authority relation from trusted identity/session state.
   */
  authenticateRatingRecord(input: Readonly<{
    record: Readonly<RatingRecord>;
    expectedOwner: string;
  }>): RatingAuthenticationVerdict | Promise<RatingAuthenticationVerdict>;
  /** Authenticate canonical inclusion/finality and exact writer provenance. */
  authenticateAnchor(input: Readonly<{
    logicalAddress: string;
    record: Readonly<RatingRecord>;
    publication: Readonly<SuccessfulBoundWrite>;
  }>): RatingAnchorAuthenticationVerdict | Promise<RatingAnchorAuthenticationVerdict>;
}

export interface DurablePublishedRating {
  publicationVersion: "1";
  logicalAddress: string;
  expectedOwner: string;
  nativeAddress: string;
  bindingContentHash: string;
  record: Readonly<RatingRecord>;
  ref: Readonly<AttestationRef>;
}

export type DurableRatingPublicationStage =
  | "authentication"
  | "intent"
  | "lease"
  | "anchor-and-binding"
  | "anchor-authentication"
  | "exact-readback"
  | "completion";

export type DurableRatingPublicationProgress =
  | {
      disposition: "published";
      result: Readonly<DurablePublishedRating>;
      recovered: boolean;
    }
  | {
      disposition: "waiting" | "rejected" | "indeterminate";
      stage: DurableRatingPublicationStage;
      reason: string;
    };

interface CapturedPublicationInput {
  record: RatingRecord;
  buyer: string;
  seller: string;
  expectedOwner: string;
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

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function captureInput(input: DurableRatingPublicationInput): CapturedPublicationInput {
  const captured = snapshotCanonicalJson(
    input,
    "durable RatingRecord publication input",
  ) as CapturedPublicationInput;
  if (
    typeof captured !== "object" ||
    captured === null ||
    Array.isArray(captured) ||
    !exactKeys(captured as unknown as Record<string, unknown>, [
      "record",
      "buyer",
      "seller",
      "expectedOwner",
    ])
  ) {
    throw new DacsError("durable RatingRecord publication input has unexpected fields");
  }
  if (!isRatingRecord(captured.record)) {
    throw new DacsError("durable RatingRecord publication requires a valid RatingRecord");
  }
  if (
    !isCanonicalClaimReference(captured.buyer) ||
    !isCanonicalClaimReference(captured.seller) ||
    captured.buyer === captured.seller
  ) {
    throw new DacsError("durable RatingRecord publication parties are invalid");
  }
  if (
    captured.expectedOwner.length === 0 ||
    captured.expectedOwner.trim() !== captured.expectedOwner ||
    captured.expectedOwner.normalize("NFC") !== captured.expectedOwner ||
    /[\u0000-\u001f\u007f]/.test(captured.expectedOwner)
  ) {
    throw new DacsError("durable RatingRecord publication owner is invalid");
  }
  const buyerDirection =
    captured.record.rater === captured.buyer &&
    captured.record.target === captured.seller &&
    captured.record.targetRole === "seller";
  const sellerDirection =
    captured.record.rater === captured.seller &&
    captured.record.target === captured.buyer &&
    captured.record.targetRole === "buyer";
  if (!buyerDirection && !sellerDirection) {
    throw new DacsError(
      "RatingRecord direction does not match the authenticated session parties",
    );
  }
  return captured;
}

function normalizedOwner(owner: string): string {
  const normalized = owner.trim().toLowerCase();
  return normalized.match(/^(?:0x)?([0-9a-f]{64})$/)?.[1] ?? normalized;
}

function exactValue(left: unknown, right: unknown): boolean {
  try {
    return canonicalize(left) === canonicalize(right);
  } catch {
    return false;
  }
}

function captureVerdict(value: unknown, label: string): RatingAuthenticationVerdict {
  const captured = snapshotCanonicalJsonRead(value, label) as RatingAuthenticationVerdict;
  if (
    typeof captured !== "object" ||
    captured === null ||
    Array.isArray(captured) ||
    (captured.disposition === "valid"
      ? !exactKeys(captured as unknown as Record<string, unknown>, ["disposition"])
      : (captured.disposition !== "invalid" && captured.disposition !== "indeterminate") ||
        !exactKeys(captured as unknown as Record<string, unknown>, [
          "disposition",
          "reason",
        ]) ||
        typeof captured.reason !== "string" ||
        captured.reason.length === 0)
  ) {
    throw new DacsError(`${label} is malformed`);
  }
  return captured;
}

function effectIdentity(captured: CapturedPublicationInput) {
  const logicalAddress = ratingAddress(
    captured.record.jobId,
    captured.record.rater,
  );
  const scopeContentHash = contentHash(
    stripSignature(captured.record as unknown as Record<string, unknown>),
  );
  const bindingContentHash = contentHash(
    captured.record as unknown as Record<string, unknown>,
  );
  const effectInput = {
    schema: EFFECT_SCHEMA,
    logicalAddress,
    expectedOwner: captured.expectedOwner,
    buyer: captured.buyer,
    seller: captured.seller,
    scopeContentHash,
    bindingContentHash,
    record: captured.record,
  };
  return {
    logicalAddress,
    scopeContentHash,
    bindingContentHash,
    effectInput,
    bindingHash: sha256Hex(canonicalize(effectInput)),
    idempotencyKey: `dacs-rating:${logicalAddress}`,
  };
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function captureCompletedResult(
  value: unknown,
  captured: CapturedPublicationInput,
  identity: ReturnType<typeof effectIdentity>,
): DurablePublishedRating | null {
  let result: DurablePublishedRating;
  try {
    result = snapshotCanonicalJsonRead(
      value,
      "durable RatingRecord publication result",
    ) as DurablePublishedRating;
  } catch {
    return null;
  }
  if (
    typeof result !== "object" ||
    result === null ||
    Array.isArray(result) ||
    !exactKeys(result as unknown as Record<string, unknown>, [
      "publicationVersion",
      "logicalAddress",
      "expectedOwner",
      "nativeAddress",
      "bindingContentHash",
      "record",
      "ref",
    ]) ||
    result.publicationVersion !== "1" ||
    result.logicalAddress !== identity.logicalAddress ||
    result.expectedOwner !== captured.expectedOwner ||
    typeof result.nativeAddress !== "string" ||
    result.nativeAddress.length === 0 ||
    result.bindingContentHash !== identity.bindingContentHash ||
    !exactValue(result.record, captured.record) ||
    !isRatingRecord(result.record) ||
    !isAttestationRef(result.ref) ||
    result.ref.anchor.kind !== "storage-program" ||
    result.ref.anchor.locator !== result.nativeAddress ||
    result.ref.contentHash !== identity.scopeContentHash ||
    result.ref.signer !== captured.record.rater
  ) {
    return null;
  }
  return result;
}

async function markAmbiguous(
  store: RatingPublicationEffectStore,
  identity: ReturnType<typeof effectIdentity>,
  lease: Readonly<RatingPublicationEffectLease>,
  reasonCode: string,
): Promise<void> {
  await store.recordEffectAmbiguous({
    kind: EFFECT_KIND,
    effectId: identity.logicalAddress,
    bindingHash: identity.bindingHash,
    lease,
    reasonCode,
  });
}

async function requireOperatorAction(
  store: RatingPublicationEffectStore,
  identity: ReturnType<typeof effectIdentity>,
  lease: Readonly<RatingPublicationEffectLease>,
  reasonCode: string,
): Promise<void> {
  await store.requireEffectOperatorAction({
    kind: EFFECT_KIND,
    effectId: identity.logicalAddress,
    bindingHash: identity.bindingHash,
    lease,
    reasonCode,
  });
}

function readbackFailure(read: VerifiedRead): {
  permanent: boolean;
  reason: string;
} {
  switch (read.status) {
    case "hash-mismatch":
    case "signature-invalid":
    case "binding-mismatch":
    case "unverifiable":
      return { permanent: true, reason: `rating-readback-${read.status}` };
    case "absent":
    case "unreadable":
    case "indeterminate":
      return { permanent: false, reason: `rating-readback-${read.status}` };
    case "verified":
      throw new DacsError("verified RatingRecord readback is not a failure");
  }
}

/**
 * Durably publish one already-signed RatingRecord. The effect intent stores the
 * exact record before the first external call. Every later drive, including a
 * reconciliation lease after response loss, reuses only that immutable record
 * at the same write-once logical address. Completion requires authenticated
 * anchor finality, role-owned binding visibility, exact content readback, and
 * re-authentication of the RatingRecord.
 */
export async function publishRatingRecordDurably(
  input: DurableRatingPublicationInput,
  deps: DurableRatingPublicationDeps,
): Promise<DurableRatingPublicationProgress> {
  const captured = captureInput(input);
  const identity = effectIdentity(captured);
  if (
    typeof deps.workerId !== "string" ||
    deps.workerId.length === 0 ||
    deps.workerId.trim() !== deps.workerId ||
    !Number.isSafeInteger(deps.leaseDurationMs) ||
    deps.leaseDurationMs <= 0
  ) {
    throw new DacsError("durable RatingRecord publication worker lease is invalid");
  }

  let initialAuthentication: RatingAuthenticationVerdict;
  try {
    initialAuthentication = captureVerdict(
      await deps.authenticateRatingRecord(deepFreeze({
        record: snapshotCanonicalJson(captured.record, "RatingRecord authentication input"),
        expectedOwner: captured.expectedOwner,
      })),
      "RatingRecord authentication verdict",
    );
  } catch (error) {
    return {
      disposition: "indeterminate",
      stage: "authentication",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (initialAuthentication.disposition !== "valid") {
    return {
      disposition: initialAuthentication.disposition === "invalid"
        ? "rejected"
        : "indeterminate",
      stage: "authentication",
      reason: initialAuthentication.reason,
    };
  }

  let intent;
  try {
    intent = await deps.effectStore.putEffectIntent({
      kind: EFFECT_KIND,
      effectId: identity.logicalAddress,
      bindingHash: identity.bindingHash,
      input: deepFreeze(snapshotCanonicalJson(identity.effectInput, "rating effect input")),
      idempotencyKey: identity.idempotencyKey,
    });
  } catch (error) {
    return {
      disposition: "indeterminate",
      stage: "intent",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (intent.status === "conflict") {
    return {
      disposition: "rejected",
      stage: "intent",
      reason: "a different RatingRecord is already reserved for this rater and job",
    };
  }

  let claim: RatingPublicationEffectClaim;
  try {
    claim = await deps.effectStore.claimEffect({
      kind: EFFECT_KIND,
      effectId: identity.logicalAddress,
      bindingHash: identity.bindingHash,
      owner: deps.workerId,
      leaseDurationMs: deps.leaseDurationMs,
    });
  } catch (error) {
    return {
      disposition: "indeterminate",
      stage: "lease",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (claim.status === "completed") {
    const result = captureCompletedResult(claim.record.result, captured, identity);
    return result
      ? { disposition: "published", result: deepFreeze(result), recovered: true }
      : {
          disposition: "rejected",
          stage: "completion",
          reason: "durable RatingRecord publication result is corrupt or mismatched",
        };
  }
  if (claim.status === "waiting") {
    return {
      disposition: "waiting",
      stage: "lease",
      reason: "another worker holds the RatingRecord publication lease",
    };
  }
  if (claim.status === "not-runnable") {
    return {
      disposition: "rejected",
      stage: "lease",
      reason: "RatingRecord publication requires operator action",
    };
  }
  if (claim.status === "missing" || claim.status === "stale") {
    return {
      disposition: "indeterminate",
      stage: "lease",
      reason: `RatingRecord publication effect is ${claim.status}`,
    };
  }

  const recovered = claim.mode === "reconcile";
  let current: boolean;
  try {
    current = await deps.effectStore.isCurrentEffect({
      kind: EFFECT_KIND,
      effectId: identity.logicalAddress,
      bindingHash: identity.bindingHash,
      lease: claim.lease,
    });
  } catch {
    current = false;
  }
  if (!current) {
    return {
      disposition: "indeterminate",
      stage: "lease",
      reason: "RatingRecord publication lease is no longer current",
    };
  }

  let publication: BoundArtifactWriteResult;
  try {
    publication = await deps.repository.write(
      identity.logicalAddress,
      deepFreeze(snapshotCanonicalJson(
        captured.record as unknown as Record<string, unknown>,
        "RatingRecord anchor input",
      )),
    );
  } catch (error) {
    await markAmbiguous(
      deps.effectStore,
      identity,
      claim.lease,
      "rating-publication-response-lost",
    ).catch(() => {});
    return {
      disposition: "indeterminate",
      stage: "anchor-and-binding",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (publication.status === "conflict") {
    await requireOperatorAction(
      deps.effectStore,
      identity,
      claim.lease,
      "rating-publication-conflict",
    ).catch(() => {});
    return {
      disposition: "rejected",
      stage: "anchor-and-binding",
      reason: publication.reason,
    };
  }
  if (publication.status === "indeterminate") {
    await markAmbiguous(
      deps.effectStore,
      identity,
      claim.lease,
      "rating-publication-indeterminate",
    ).catch(() => {});
    return {
      disposition: "indeterminate",
      stage: "anchor-and-binding",
      reason: publication.reason,
    };
  }
  if (
    publication.binding.logicalAddress !== identity.logicalAddress ||
    normalizedOwner(publication.binding.owner) !==
      normalizedOwner(captured.expectedOwner) ||
    publication.binding.contentHash !== identity.bindingContentHash ||
    publication.binding.nativeAddress !== publication.anchor.address
  ) {
    await requireOperatorAction(
      deps.effectStore,
      identity,
      claim.lease,
      "rating-binding-mismatch",
    ).catch(() => {});
    return {
      disposition: "rejected",
      stage: "anchor-and-binding",
      reason: "RatingRecord publication returned a mismatched role-owned binding",
    };
  }

  let anchorAuthentication: RatingAnchorAuthenticationVerdict;
  try {
    anchorAuthentication = captureVerdict(
      await deps.authenticateAnchor(deepFreeze({
        logicalAddress: identity.logicalAddress,
        record: snapshotCanonicalJson(captured.record, "rating anchor authentication record"),
        publication: snapshotCanonicalJsonRead(
          publication,
          "rating anchor publication",
        ) as SuccessfulBoundWrite,
      })),
      "RatingRecord anchor authentication verdict",
    );
  } catch (error) {
    await markAmbiguous(
      deps.effectStore,
      identity,
      claim.lease,
      "rating-anchor-authentication-indeterminate",
    ).catch(() => {});
    return {
      disposition: "indeterminate",
      stage: "anchor-authentication",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (anchorAuthentication.disposition !== "valid") {
    if (anchorAuthentication.disposition === "invalid") {
      await requireOperatorAction(
        deps.effectStore,
        identity,
        claim.lease,
        "rating-anchor-invalid",
      ).catch(() => {});
    } else {
      await markAmbiguous(
        deps.effectStore,
        identity,
        claim.lease,
        "rating-anchor-indeterminate",
      ).catch(() => {});
    }
    return {
      disposition: anchorAuthentication.disposition === "invalid"
        ? "rejected"
        : "indeterminate",
      stage: "anchor-authentication",
      reason: anchorAuthentication.reason,
    };
  }

  let readAuthentication: RatingAuthenticationVerdict | undefined;
  let readback: VerifiedRead;
  try {
    readback = await deps.repository.read(
      identity.logicalAddress,
      captured.expectedOwner,
      async (candidate, binding) => {
        if (
          binding.logicalAddress !== identity.logicalAddress ||
          normalizedOwner(binding.owner) !== normalizedOwner(captured.expectedOwner) ||
          binding.contentHash !== identity.bindingContentHash ||
          !isRatingRecord(candidate) ||
          !exactValue(candidate, captured.record)
        ) {
          return false;
        }
        try {
          readAuthentication = captureVerdict(
            await deps.authenticateRatingRecord(deepFreeze({
              record: snapshotCanonicalJsonRead(
                candidate,
                "RatingRecord exact readback",
              ) as RatingRecord,
              expectedOwner: captured.expectedOwner,
            })),
            "RatingRecord readback authentication verdict",
          );
        } catch (error) {
          readAuthentication = {
            disposition: "indeterminate",
            reason: error instanceof Error ? error.message : String(error),
          };
          throw error;
        }
        return readAuthentication.disposition === "valid";
      },
    );
  } catch (error) {
    await markAmbiguous(
      deps.effectStore,
      identity,
      claim.lease,
      "rating-readback-threw",
    ).catch(() => {});
    return {
      disposition: "indeterminate",
      stage: "exact-readback",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (readback.status !== "verified") {
    const failure = (readback.status === "signature-invalid" ||
        readback.status === "unverifiable") &&
        readAuthentication?.disposition === "indeterminate"
      ? { permanent: false, reason: "rating-readback-authentication-indeterminate" }
      : readbackFailure(readback);
    if (failure.permanent) {
      await requireOperatorAction(
        deps.effectStore,
        identity,
        claim.lease,
        failure.reason,
      ).catch(() => {});
    } else {
      await markAmbiguous(
        deps.effectStore,
        identity,
        claim.lease,
        failure.reason,
      ).catch(() => {});
    }
    return {
      disposition: failure.permanent ? "rejected" : "indeterminate",
      stage: "exact-readback",
      reason: failure.reason,
    };
  }
  if (!exactValue(readback.record, captured.record)) {
    await requireOperatorAction(
      deps.effectStore,
      identity,
      claim.lease,
      "rating-readback-byte-mismatch",
    ).catch(() => {});
    return {
      disposition: "rejected",
      stage: "exact-readback",
      reason: "RatingRecord readback differs from the durable signed record",
    };
  }

  const result: DurablePublishedRating = {
    publicationVersion: "1",
    logicalAddress: identity.logicalAddress,
    expectedOwner: captured.expectedOwner,
    nativeAddress: publication.binding.nativeAddress,
    bindingContentHash: identity.bindingContentHash,
    record: captured.record,
    ref: {
      anchor: {
        kind: "storage-program",
        locator: publication.binding.nativeAddress,
      },
      contentHash: identity.scopeContentHash,
      signer: captured.record.rater,
    },
  };
  const completed = await deps.effectStore.recordEffectCompleted({
    kind: EFFECT_KIND,
    effectId: identity.logicalAddress,
    bindingHash: identity.bindingHash,
    lease: claim.lease,
    result: deepFreeze(snapshotCanonicalJson(result, "RatingRecord publication result")),
  });
  if (completed.status !== "recorded" && completed.status !== "existing") {
    return {
      disposition: "indeterminate",
      stage: "completion",
      reason: `RatingRecord publication completion was ${completed.status}`,
    };
  }
  return {
    disposition: "published",
    result: deepFreeze(snapshotCanonicalJson(result, "RatingRecord publication result")),
    recovered,
  };
}

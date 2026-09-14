/**
 * Durable ST-11 handoff from the advisory rating phase into audit finalisation.
 *
 * The exact, authenticated handoff is first recorded as a WAL intent and then
 * atomically committed as an outcome while the fenced session advances from
 * `rate-pending` to `audit-pending`. No signing or publication authority lives
 * in this coordinator.
 */
import {
  canonicalize,
} from "../canonical/index.js";
import {
  snapshotCanonicalJson,
  snapshotCanonicalJsonRead,
} from "../canonical/snapshot.js";
import { DacsError } from "../errors.js";
import { isCanonicalJobId } from "../negotiate/jobId.js";
import {
  FENCED_SESSION_STORE_VERSION,
  sessionRecordShapeViolation,
  type CheckpointValue,
  type FencedSessionStoreV2,
  type SessionCheckpoint,
  type SessionLeaseToken,
  type SessionRecord,
} from "./fencedSessionStore.js";
import {
  captureRatingPhaseReadyHandoff,
  type RatingPhaseAuthenticationVerdict,
  type RatingPhaseReadyHandoff,
} from "./ratingPhase.js";

export const RATING_PHASE_HANDOFF_CHECKPOINT_KEY =
  "rating-phase:ready-handoff" as const;
const CHECKPOINT_SCHEMA = "dacs-rating-phase-handoff/v1";
const MAX_CAS_ATTEMPTS = 16;

export interface RatingPhaseHandoffAuthenticationInput {
  handoff: Readonly<RatingPhaseReadyHandoff>;
  /** Current fenced WAL projection; the verifier binds it to the retained full session. */
  session: Readonly<SessionRecord>;
}

export type AuthenticateRatingPhaseHandoff = (
  input: Readonly<RatingPhaseHandoffAuthenticationInput>,
) =>
  | RatingPhaseAuthenticationVerdict
  | Promise<RatingPhaseAuthenticationVerdict>;

export interface PersistRatingPhaseHandoffDeps {
  store: FencedSessionStoreV2;
  workerId: string;
  leaseTtlMs: number;
  nowMs?: () => number;
  /**
   * Authenticate `sessionRecordHash`, `planHash`, the final rate entry and all
   * rating refs against retained session/plan/publication state.
   */
  authenticateHandoff: AuthenticateRatingPhaseHandoff;
}

export interface RecoverRatingPhaseHandoffDeps {
  store: FencedSessionStoreV2;
  authenticateHandoff: AuthenticateRatingPhaseHandoff;
}

export type RatingPhaseHandoffStage =
  | "load"
  | "session"
  | "authentication"
  | "lease"
  | "checkpoint"
  | "commit";

export type PersistRatingPhaseHandoffResult =
  | Readonly<{
      disposition: "persisted";
      handoff: Readonly<RatingPhaseReadyHandoff>;
      recovered: boolean;
    }>
  | Readonly<{
      disposition: "waiting" | "rejected" | "indeterminate";
      stage: RatingPhaseHandoffStage;
      reason: string;
    }>;

export type RecoverRatingPhaseHandoffResult =
  | Readonly<{
      disposition: "recovered";
      handoff: Readonly<RatingPhaseReadyHandoff>;
    }>
  | Readonly<{
      disposition: "missing" | "pending" | "rejected" | "indeterminate";
      stage: RatingPhaseHandoffStage;
      reason: string;
    }>;

interface CapturedStore {
  load: FencedSessionStoreV2["load"];
  acquireLease: FencedSessionStoreV2["acquireLease"];
  claimCheckpoint: FencedSessionStoreV2["claimCheckpoint"];
  transition: FencedSessionStoreV2["transition"];
}

interface CapturedPersistDeps {
  store: CapturedStore;
  workerId: string;
  leaseTtlMs: number;
  nowMs: () => number;
  authenticateHandoff: AuthenticateRatingPhaseHandoff;
}

interface RatingHandoffCheckpointData extends Record<string, CheckpointValue> {
  schema: typeof CHECKPOINT_SCHEMA;
  jobId: string;
  sessionRecordHash: string;
  planHash: string;
  handoffHash: string;
  payload: string;
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
  required: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key));
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nowFrom(callback: () => number): number {
  const value = callback();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DacsError("rating handoff clock must return a non-negative safe integer");
  }
  return value;
}

function captureStore(value: unknown): CapturedStore {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DacsError("rating handoff durability requires FencedSessionStoreV2");
  }
  const store = value as FencedSessionStoreV2;
  const apiVersion = store.apiVersion;
  const load = store.load;
  const acquireLease = store.acquireLease;
  const claimCheckpoint = store.claimCheckpoint;
  const transition = store.transition;
  if (
    apiVersion !== FENCED_SESSION_STORE_VERSION ||
    typeof load !== "function" ||
    typeof acquireLease !== "function" ||
    typeof claimCheckpoint !== "function" ||
    typeof transition !== "function"
  ) {
    throw new DacsError("rating handoff durability requires FencedSessionStoreV2");
  }
  return Object.freeze({
    load: async (jobId: Parameters<FencedSessionStoreV2["load"]>[0]) => snapshotCanonicalJsonRead(
      await Reflect.apply(load, store, [jobId]),
      "rating handoff store load result",
    ) as Awaited<ReturnType<FencedSessionStoreV2["load"]>>,
    acquireLease: async (input: Parameters<FencedSessionStoreV2["acquireLease"]>[0]) => snapshotCanonicalJsonRead(
      await Reflect.apply(acquireLease, store, [snapshotCanonicalJsonRead(
        input,
        "rating handoff store lease input",
      )]),
      "rating handoff store lease result",
    ) as Awaited<ReturnType<FencedSessionStoreV2["acquireLease"]>>,
    claimCheckpoint: async (input: Parameters<FencedSessionStoreV2["claimCheckpoint"]>[0]) => snapshotCanonicalJsonRead(
      await Reflect.apply(claimCheckpoint, store, [snapshotCanonicalJsonRead(
        input,
        "rating handoff store checkpoint input",
      )]),
      "rating handoff store checkpoint result",
    ) as Awaited<ReturnType<FencedSessionStoreV2["claimCheckpoint"]>>,
    transition: async (input: Parameters<FencedSessionStoreV2["transition"]>[0]) => snapshotCanonicalJsonRead(
      await Reflect.apply(transition, store, [snapshotCanonicalJsonRead(
        input,
        "rating handoff store transition input",
      )]),
      "rating handoff store transition result",
    ) as Awaited<ReturnType<FencedSessionStoreV2["transition"]>>,
  });
}

function capturePersistDeps(
  value: Readonly<PersistRatingPhaseHandoffDeps>,
): CapturedPersistDeps {
  if (!value || typeof value !== "object") {
    throw new DacsError("rating handoff durability dependencies are required");
  }
  const store = value.store;
  const workerId = value.workerId;
  const leaseTtlMs = value.leaseTtlMs;
  const nowMs = value.nowMs;
  const authenticateHandoff = value.authenticateHandoff;
  if (
    typeof workerId !== "string" ||
    workerId.length === 0 ||
    workerId.trim() !== workerId ||
    workerId.normalize("NFC") !== workerId ||
    /[\u0000-\u001f\u007f]/.test(workerId)
  ) {
    throw new DacsError("rating handoff workerId must be canonical and non-empty");
  }
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs <= 0) {
    throw new DacsError("rating handoff leaseTtlMs must be a positive safe integer");
  }
  if (
    (nowMs !== undefined && typeof nowMs !== "function") ||
    typeof authenticateHandoff !== "function"
  ) {
    throw new DacsError("rating handoff durability callbacks are malformed");
  }
  return Object.freeze({
    store: captureStore(store),
    workerId,
    leaseTtlMs,
    nowMs: nowMs === undefined
      ? Date.now
      : () => Reflect.apply(nowMs, value, []),
    authenticateHandoff: (input: RatingPhaseHandoffAuthenticationInput) =>
      Reflect.apply(authenticateHandoff, value, [input]),
  });
}

function captureRecoverDeps(
  value: Readonly<RecoverRatingPhaseHandoffDeps>,
): Pick<CapturedPersistDeps, "store" | "authenticateHandoff"> {
  if (!value || typeof value !== "object") {
    throw new DacsError("rating handoff recovery dependencies are malformed");
  }
  const store = value.store;
  const authenticateHandoff = value.authenticateHandoff;
  if (typeof authenticateHandoff !== "function") {
    throw new DacsError("rating handoff recovery dependencies are malformed");
  }
  return Object.freeze({
    store: captureStore(store),
    authenticateHandoff: (input: RatingPhaseHandoffAuthenticationInput) =>
      Reflect.apply(authenticateHandoff, value, [input]),
  });
}

function captureRecord(value: unknown): SessionRecord {
  const captured = snapshotCanonicalJsonRead(
    value,
    "rating handoff session record",
  ) as SessionRecord;
  const violation = sessionRecordShapeViolation(captured);
  if (violation) {
    throw new DacsError(`rating handoff session is corrupt: ${violation}`);
  }
  return captured;
}

function latestCheckpoint(
  record: Readonly<SessionRecord>,
): Readonly<SessionCheckpoint> | undefined {
  return [...record.checkpoints]
    .reverse()
    .find((checkpoint) => checkpoint.key === RATING_PHASE_HANDOFF_CHECKPOINT_KEY);
}

function checkpointData(
  handoff: Readonly<RatingPhaseReadyHandoff>,
): RatingHandoffCheckpointData {
  return deepFreeze({
    schema: CHECKPOINT_SCHEMA,
    jobId: handoff.jobId,
    sessionRecordHash: handoff.sessionRecordHash,
    planHash: handoff.planHash,
    handoffHash: handoff.handoffHash,
    payload: canonicalize(handoff),
  });
}

function committedHandoff(
  record: Readonly<SessionRecord>,
  expectedData: Readonly<RatingHandoffCheckpointData>,
): Readonly<RatingPhaseReadyHandoff> {
  if (record.phase !== "audit-pending" || record.lease !== undefined) {
    throw new DacsError("rating handoff commit did not atomically advance and release its lease");
  }
  const checkpoint = latestCheckpoint(record);
  if (
    checkpoint?.stage !== "outcome" ||
    !sameCheckpointData(checkpoint.data, expectedData)
  ) {
    throw new DacsError("rating handoff commit did not retain the exact outcome");
  }
  return decodeCheckpoint(checkpoint);
}

function decodeCheckpoint(
  checkpoint: Readonly<SessionCheckpoint>,
): Readonly<RatingPhaseReadyHandoff> {
  const data = checkpoint.data;
  if (
    !data ||
    !exactKeys(data as Record<string, unknown>, [
      "schema",
      "jobId",
      "sessionRecordHash",
      "planHash",
      "handoffHash",
      "payload",
    ]) ||
    data.schema !== CHECKPOINT_SCHEMA ||
    typeof data.jobId !== "string" ||
    typeof data.sessionRecordHash !== "string" ||
    typeof data.planHash !== "string" ||
    typeof data.handoffHash !== "string" ||
    typeof data.payload !== "string"
  ) {
    throw new DacsError("rating handoff checkpoint data is malformed");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(data.payload);
  } catch {
    throw new DacsError("rating handoff checkpoint payload is not JSON");
  }
  const handoff = captureRatingPhaseReadyHandoff(decoded);
  if (
    canonicalize(handoff) !== data.payload ||
    handoff.jobId !== data.jobId ||
    handoff.sessionRecordHash !== data.sessionRecordHash ||
    handoff.planHash !== data.planHash ||
    handoff.handoffHash !== data.handoffHash
  ) {
    throw new DacsError("rating handoff checkpoint metadata does not match its payload");
  }
  return handoff;
}

function sameCheckpointData(
  left: Readonly<Record<string, CheckpointValue>> | undefined,
  right: Readonly<RatingHandoffCheckpointData>,
): boolean {
  return left !== undefined && canonicalize(left) === canonicalize(right);
}

function captureVerdict(value: unknown): RatingPhaseAuthenticationVerdict {
  const captured = snapshotCanonicalJsonRead(
    value,
    "rating handoff authentication verdict",
  ) as RatingPhaseAuthenticationVerdict;
  if (
    captured !== null &&
    typeof captured === "object" &&
    !Array.isArray(captured)
  ) {
    const record = captured as unknown as Record<string, unknown>;
    if (captured.disposition === "valid" && exactKeys(record, ["disposition"])) {
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
  }
  throw new DacsError("rating handoff authentication verdict is malformed");
}

async function authenticate(
  handoff: Readonly<RatingPhaseReadyHandoff>,
  session: Readonly<SessionRecord>,
  callback: AuthenticateRatingPhaseHandoff,
): Promise<RatingPhaseAuthenticationVerdict> {
  return captureVerdict(await callback(deepFreeze(snapshotCanonicalJsonRead({
    handoff,
    session,
  }, "rating handoff authentication input"))));
}

async function loadRecord(
  store: CapturedStore,
  jobId: string,
): Promise<
  | { disposition: "loaded"; record: SessionRecord }
  | { disposition: "missing" | "indeterminate"; reason: string }
> {
  const loaded = await store.load(jobId);
  if (loaded.status === "ok") {
    const record = captureRecord(loaded.record);
    if (record.jobId !== jobId) {
      return { disposition: "indeterminate", reason: "session store returned another job" };
    }
    return { disposition: "loaded", record };
  }
  if (loaded.status === "missing") {
    return { disposition: "missing", reason: `session ${jobId} does not exist` };
  }
  return {
    disposition: "indeterminate",
    reason: loaded.status === "corrupt"
      ? `session store is corrupt: ${loaded.reason}`
      : `session store version ${loaded.version} is unsupported`,
  };
}

async function releaseLease(
  store: CapturedStore,
  jobId: string,
  leaseToken: Readonly<SessionLeaseToken>,
  nowMs: () => number,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const loaded = await loadRecord(store, jobId);
    if (loaded.disposition !== "loaded" || !loaded.record.lease) return;
    if (
      loaded.record.lease.owner !== leaseToken.owner ||
      loaded.record.lease.generation !== leaseToken.generation
    ) return;
    const result = await store.transition({
      jobId,
      expectedRevision: loaded.record.revision,
      leaseToken,
      lease: null,
      now: nowFrom(nowMs),
    });
    if (result.ok || result.reason !== "revision-mismatch") return;
  }
}

async function authenticateForResult(
  handoff: Readonly<RatingPhaseReadyHandoff>,
  session: Readonly<SessionRecord>,
  callback: AuthenticateRatingPhaseHandoff,
): Promise<
  | { disposition: "valid" }
  | { disposition: "rejected" | "indeterminate"; reason: string }
> {
  let verdict: RatingPhaseAuthenticationVerdict;
  try {
    verdict = await authenticate(handoff, session, callback);
  } catch (error) {
    return { disposition: "indeterminate", reason: reason(error) };
  }
  if (verdict.disposition === "valid") return verdict;
  return {
    disposition: verdict.disposition === "invalid" ? "rejected" : "indeterminate",
    reason: verdict.reason,
  };
}

/**
 * Persist the exact rating result and advance to `audit-pending` in one fenced
 * commit. A replay either recovers the same hash or rejects a conflicting one.
 */
export async function persistRatingPhaseHandoffDurably(
  input: Readonly<RatingPhaseReadyHandoff>,
  dependencies: Readonly<PersistRatingPhaseHandoffDeps>,
): Promise<PersistRatingPhaseHandoffResult> {
  const handoff = captureRatingPhaseReadyHandoff(input);
  const deps = capturePersistDeps(dependencies);
  const expectedData = checkpointData(handoff);

  let initial;
  try {
    initial = await loadRecord(deps.store, handoff.jobId);
  } catch (error) {
    return deepFreeze({
      disposition: "indeterminate" as const,
      stage: "load" as const,
      reason: reason(error),
    });
  }
  if (initial.disposition !== "loaded") {
    return deepFreeze({
      disposition: initial.disposition === "missing" ? "rejected" as const : "indeterminate" as const,
      stage: "load" as const,
      reason: initial.reason,
    });
  }

  const prior = latestCheckpoint(initial.record);
  if (prior?.stage === "outcome") {
    let recovered: Readonly<RatingPhaseReadyHandoff>;
    try {
      recovered = decodeCheckpoint(prior);
    } catch (error) {
      return deepFreeze({
        disposition: "indeterminate" as const,
        stage: "checkpoint" as const,
        reason: reason(error),
      });
    }
    if (recovered.handoffHash !== handoff.handoffHash) {
      return deepFreeze({
        disposition: "rejected" as const,
        stage: "checkpoint" as const,
        reason: "session is already bound to a different rating handoff",
      });
    }
    try {
      recovered = committedHandoff(initial.record, expectedData);
    } catch (error) {
      return deepFreeze({
        disposition: "indeterminate" as const,
        stage: "commit" as const,
        reason: reason(error),
      });
    }
    const authentication = await authenticateForResult(
      recovered,
      initial.record,
      deps.authenticateHandoff,
    );
    if (authentication.disposition !== "valid") {
      return deepFreeze({
        disposition: authentication.disposition,
        stage: "authentication" as const,
        reason: authentication.reason,
      });
    }
    return deepFreeze({ disposition: "persisted", handoff: recovered, recovered: true });
  }
  if (prior?.stage === "intent" && !sameCheckpointData(prior.data, expectedData)) {
    return deepFreeze({
      disposition: "rejected" as const,
      stage: "checkpoint" as const,
      reason: "session contains a conflicting rating handoff intent",
    });
  }
  if (initial.record.phase !== "rate-pending") {
    return deepFreeze({
      disposition: "rejected" as const,
      stage: "session" as const,
      reason: `rating handoff requires rate-pending, got ${initial.record.phase}`,
    });
  }

  let acquired;
  try {
    acquired = await deps.store.acquireLease({
      jobId: handoff.jobId,
      owner: deps.workerId,
      ttlMs: deps.leaseTtlMs,
      now: nowFrom(deps.nowMs),
    });
  } catch (error) {
    return deepFreeze({
      disposition: "indeterminate" as const,
      stage: "lease" as const,
      reason: reason(error),
    });
  }
  if (!acquired.ok) {
    return deepFreeze({
      disposition: acquired.reason === "lease-held" ? "waiting" as const : "indeterminate" as const,
      stage: "lease" as const,
      reason: `rating handoff lease failed: ${acquired.reason}`,
    });
  }
  const leaseToken: SessionLeaseToken = {
    owner: acquired.lease.owner,
    generation: acquired.lease.generation,
  };
  const acquiredRecord = captureRecord(acquired.record);
  if (
    acquired.lease.owner !== deps.workerId ||
    acquiredRecord.jobId !== handoff.jobId ||
    !acquiredRecord.lease ||
    acquiredRecord.lease.owner !== deps.workerId ||
    acquiredRecord.lease.owner !== leaseToken.owner ||
    acquiredRecord.lease.generation !== leaseToken.generation ||
    acquired.lease.owner !== leaseToken.owner ||
    acquired.lease.generation !== leaseToken.generation
  ) {
    return deepFreeze({
      disposition: "indeterminate" as const,
      stage: "lease" as const,
      reason: "rating handoff store returned a contradictory lease",
    });
  }
  const racedCheckpoint = latestCheckpoint(acquiredRecord);
  if (racedCheckpoint?.stage === "outcome") {
    let persisted: Readonly<RatingPhaseReadyHandoff>;
    try {
      persisted = decodeCheckpoint(racedCheckpoint);
    } catch (error) {
      await releaseLease(deps.store, handoff.jobId, leaseToken, deps.nowMs).catch(() => {});
      return deepFreeze({
        disposition: "indeterminate" as const,
        stage: "checkpoint" as const,
        reason: reason(error),
      });
    }
    if (persisted.handoffHash !== handoff.handoffHash) {
      await releaseLease(deps.store, handoff.jobId, leaseToken, deps.nowMs).catch(() => {});
      return deepFreeze({
        disposition: "rejected" as const,
        stage: "checkpoint" as const,
        reason: "session was concurrently bound to a different rating handoff",
      });
    }
    await releaseLease(deps.store, handoff.jobId, leaseToken, deps.nowMs).catch(() => {});
    let committedRecord: SessionRecord;
    try {
      const reloaded = await loadRecord(deps.store, handoff.jobId);
      if (reloaded.disposition !== "loaded") {
        return deepFreeze({
          disposition: "indeterminate" as const,
          stage: "commit" as const,
          reason: reloaded.reason,
        });
      }
      committedRecord = reloaded.record;
      persisted = committedHandoff(committedRecord, expectedData);
    } catch (error) {
      return deepFreeze({
        disposition: "indeterminate" as const,
        stage: "commit" as const,
        reason: reason(error),
      });
    }
    const racedAuthentication = await authenticateForResult(
      persisted,
      committedRecord,
      deps.authenticateHandoff,
    );
    if (racedAuthentication.disposition !== "valid") {
      return deepFreeze({
        disposition: racedAuthentication.disposition,
        stage: "authentication" as const,
        reason: racedAuthentication.reason,
      });
    }
    return deepFreeze({ disposition: "persisted", handoff: persisted, recovered: true });
  }
  if (acquiredRecord.phase !== "rate-pending") {
    await releaseLease(deps.store, handoff.jobId, leaseToken, deps.nowMs).catch(() => {});
    return deepFreeze({
      disposition: "rejected" as const,
      stage: "session" as const,
      reason: `rating handoff requires rate-pending, got ${acquiredRecord.phase}`,
    });
  }
  const authentication = await authenticateForResult(
    handoff,
    acquiredRecord,
    deps.authenticateHandoff,
  );
  if (authentication.disposition !== "valid") {
    await releaseLease(deps.store, handoff.jobId, leaseToken, deps.nowMs).catch(() => {});
    return deepFreeze({
      disposition: authentication.disposition,
      stage: "authentication" as const,
      reason: authentication.reason,
    });
  }

  let recoveredIntent = prior?.stage === "intent";
  try {
    const claimed = await deps.store.claimCheckpoint({
      jobId: handoff.jobId,
      key: RATING_PHASE_HANDOFF_CHECKPOINT_KEY,
      data: expectedData,
      leaseToken,
      now: nowFrom(deps.nowMs),
    });
    if (!claimed.ok) {
      if ((claimed.reason !== "held" && claimed.reason !== "completed") || !claimed.record) {
        await releaseLease(deps.store, handoff.jobId, leaseToken, deps.nowMs).catch(() => {});
        return deepFreeze({
          disposition: claimed.reason === "lease-held" ? "waiting" as const : "indeterminate" as const,
          stage: "checkpoint" as const,
          reason: `rating handoff checkpoint claim failed: ${claimed.reason}`,
        });
      }
      const existing = latestCheckpoint(captureRecord(claimed.record));
      if (!existing || !sameCheckpointData(existing.data, expectedData)) {
        await releaseLease(deps.store, handoff.jobId, leaseToken, deps.nowMs).catch(() => {});
        return deepFreeze({
          disposition: "rejected" as const,
          stage: "checkpoint" as const,
          reason: "session checkpoint is bound to a different rating handoff",
        });
      }
      if (claimed.reason === "completed") {
        let persisted = decodeCheckpoint(existing);
        await releaseLease(deps.store, handoff.jobId, leaseToken, deps.nowMs).catch(() => {});
        let completedRecord: SessionRecord;
        try {
          const reloaded = await loadRecord(deps.store, handoff.jobId);
          if (reloaded.disposition !== "loaded") {
            return deepFreeze({
              disposition: "indeterminate" as const,
              stage: "commit" as const,
              reason: reloaded.reason,
            });
          }
          completedRecord = reloaded.record;
          persisted = committedHandoff(completedRecord, expectedData);
        } catch (error) {
          return deepFreeze({
            disposition: "indeterminate" as const,
            stage: "commit" as const,
            reason: reason(error),
          });
        }
        const completedAuthentication = await authenticateForResult(
          persisted,
          completedRecord,
          deps.authenticateHandoff,
        );
        if (completedAuthentication.disposition !== "valid") {
          return deepFreeze({
            disposition: completedAuthentication.disposition,
            stage: "authentication" as const,
            reason: completedAuthentication.reason,
          });
        }
        return deepFreeze({ disposition: "persisted", handoff: persisted, recovered: true });
      }
      recoveredIntent = true;
    }

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await loadRecord(deps.store, handoff.jobId);
      if (current.disposition !== "loaded") {
        return deepFreeze({
          disposition: "indeterminate" as const,
          stage: "commit" as const,
          reason: current.reason,
        });
      }
      const checkpoint = latestCheckpoint(current.record);
      if (checkpoint?.stage === "outcome") {
        let persisted = decodeCheckpoint(checkpoint);
        if (persisted.handoffHash !== handoff.handoffHash) {
          return deepFreeze({
            disposition: "rejected" as const,
            stage: "checkpoint" as const,
            reason: "rating handoff outcome changed during commit",
          });
        }
        try {
          persisted = committedHandoff(current.record, expectedData);
        } catch (error) {
          return deepFreeze({
            disposition: "indeterminate" as const,
            stage: "commit" as const,
            reason: reason(error),
          });
        }
        const completedAuthentication = await authenticateForResult(
          persisted,
          current.record,
          deps.authenticateHandoff,
        );
        if (completedAuthentication.disposition !== "valid") {
          return deepFreeze({
            disposition: completedAuthentication.disposition,
            stage: "authentication" as const,
            reason: completedAuthentication.reason,
          });
        }
        return deepFreeze({ disposition: "persisted", handoff: persisted, recovered: true });
      }
      if (checkpoint?.stage !== "intent" || !sameCheckpointData(checkpoint.data, expectedData)) {
        return deepFreeze({
          disposition: "indeterminate" as const,
          stage: "checkpoint" as const,
          reason: "rating handoff intent disappeared or changed",
        });
      }
      const currentAuthentication = await authenticateForResult(
        handoff,
        current.record,
        deps.authenticateHandoff,
      );
      if (currentAuthentication.disposition !== "valid") {
        await releaseLease(deps.store, handoff.jobId, leaseToken, deps.nowMs).catch(() => {});
        return deepFreeze({
          disposition: currentAuthentication.disposition,
          stage: "authentication" as const,
          reason: currentAuthentication.reason,
        });
      }
      const committed = await deps.store.transition({
        jobId: handoff.jobId,
        expectedRevision: current.record.revision,
        leaseToken,
        phase: "audit-pending",
        checkpoint: {
          key: RATING_PHASE_HANDOFF_CHECKPOINT_KEY,
          stage: "outcome",
          data: expectedData,
        },
        lease: null,
        now: nowFrom(deps.nowMs),
      });
      if (committed.ok) {
        const committedRecord = captureRecord(committed.record);
        const persisted = committedHandoff(committedRecord, expectedData);
        return deepFreeze({
          disposition: "persisted",
          handoff: persisted,
          recovered: recoveredIntent,
        });
      }
      if (committed.reason !== "revision-mismatch") {
        return deepFreeze({
          disposition: "indeterminate" as const,
          stage: "commit" as const,
          reason: `rating handoff commit failed: ${committed.reason}`,
        });
      }
    }
    return deepFreeze({
      disposition: "indeterminate" as const,
      stage: "commit" as const,
      reason: "rating handoff commit exceeded the CAS retry limit",
    });
  } catch (error) {
    return deepFreeze({
      disposition: "indeterminate" as const,
      stage: "commit" as const,
      reason: reason(error),
    });
  }
}

/** Read only a committed handoff; an intent is never sufficient for audit work. */
export async function recoverRatingPhaseHandoff(
  rawJobId: string,
  dependencies: Readonly<RecoverRatingPhaseHandoffDeps>,
): Promise<RecoverRatingPhaseHandoffResult> {
  if (
    !isCanonicalJobId(rawJobId)
  ) {
    throw new DacsError("rating handoff recovery jobId is malformed");
  }
  const jobId = rawJobId;
  const deps = captureRecoverDeps(dependencies);
  let loaded;
  try {
    loaded = await loadRecord(deps.store, jobId);
  } catch (error) {
    return deepFreeze({
      disposition: "indeterminate" as const,
      stage: "load" as const,
      reason: reason(error),
    });
  }
  if (loaded.disposition !== "loaded") {
    return deepFreeze({
      disposition: loaded.disposition,
      stage: "load" as const,
      reason: loaded.reason,
    });
  }
  const checkpoint = latestCheckpoint(loaded.record);
  if (!checkpoint) {
    return deepFreeze({
      disposition: "missing" as const,
      stage: "checkpoint" as const,
      reason: "session has no rating handoff checkpoint",
    });
  }
  if (checkpoint.stage !== "outcome") {
    return deepFreeze({
      disposition: "pending" as const,
      stage: "checkpoint" as const,
      reason: "rating handoff intent is not committed",
    });
  }
  let handoff: Readonly<RatingPhaseReadyHandoff>;
  try {
    handoff = decodeCheckpoint(checkpoint);
    handoff = committedHandoff(loaded.record, checkpointData(handoff));
  } catch (error) {
    return deepFreeze({
      disposition: "indeterminate" as const,
      stage: "checkpoint" as const,
      reason: reason(error),
    });
  }
  const authentication = await authenticateForResult(
    handoff,
    loaded.record,
    deps.authenticateHandoff,
  );
  if (authentication.disposition !== "valid") {
    return deepFreeze({
      disposition: authentication.disposition,
      stage: "authentication" as const,
      reason: authentication.reason,
    });
  }
  return deepFreeze({ disposition: "recovered", handoff });
}

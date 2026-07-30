import { DacsError } from "../errors.js";

/**
 * Durable session store / checkpoint API (#55) — the reusable lifecycle
 * persistence surface for restart-safe buyer and seller services.
 *
 * `runSessionCore` treats on-chain anchors as phase state, so it can only resume
 * when the caller already retained the jobId; the live Butler/Auditor therefore
 * hand-roll app-side JSON stores for job status, anti-replay hashes, receipts,
 * and restart recovery. This is the shared, injectable, schema-versioned surface
 * for that state — the durable substrate that sits BETWEEN irreversible or
 * externally-visible steps, before all evidence is anchored.
 *
 * It complements the rail-level at-most-once guarantee (#43): #43 stops a single
 * rail double-submitting; this store gives the orchestrator a durable
 * write-ahead intent → outcome checkpoint, compare-and-set phase transitions, a
 * worker lease, and anti-replay hash binding, so a crash/restart/second-worker
 * reconciles completed side effects instead of repeating them.
 *
 * Records are designed to carry references (jobId, agreement/tx hashes, receipt
 * refs), never wallet secrets or model credentials. Checkpoint data is deliberately
 * limited to primitive values, but a generic store cannot infer whether an opaque
 * string is a credential: callers MUST enforce that policy at their domain
 * boundary. Every record is schema-versioned so a future reader can distinguish
 * `unsupported` from `corrupt` from `missing`.
 */

export const SESSION_STORE_VERSION = 1 as const;

/** The lifecycle phase a session is in (free string so recipes can extend it). */
export type SessionPhase = string;

/** An immutable reference receipt for a recorded session side effect. */
export interface SessionReceipt {
  kind: "agreement" | "settlement" | "delivery" | "fulfilment" | "bundle";
  /** Content hash / tx hash / anchor address — the audit pointer. */
  ref: string;
  recordedAt?: number;
}

/**
 * A checkpoint payload value. PRIMITIVES ONLY (string / finite number / boolean)
 * so checkpoint state stays bounded and portable across store implementations.
 *
 * This is a serialization constraint, not semantic secret detection: a credential
 * is still a string. Callers MUST persist references/identifiers only and keep
 * wallet keys, bearer tokens, API keys, and model credentials out of checkpoint
 * data.
 */
export type CheckpointValue = string | number | boolean;

/**
 * A write-ahead checkpoint around an external side effect: an `intent` is
 * recorded BEFORE the effect, its `outcome` AFTER — so a crash between them is
 * recoverable (the intent is visible on restart; the outcome may be replayed).
 */
export interface SessionCheckpoint {
  /** The guarded step, e.g. "settle:0" or "deliver:0". */
  key: string;
  stage: "intent" | "outcome";
  /**
   * Opaque primitive payload (rail id, idempotency key, tx ref, …).
   * Callers MUST NOT place credentials or wallet secrets here.
   */
  data?: Record<string, CheckpointValue>;
}

const RECEIPT_KINDS = new Set<SessionReceipt["kind"]>([
  "agreement",
  "settlement",
  "delivery",
  "fulfilment",
  "bundle",
]);

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function unexpectedKey(
  value: Record<string, unknown>,
  allowed: readonly string[],
): string | undefined {
  const allowedSet = new Set(allowed);
  return Object.keys(value).find((key) => !allowedSet.has(key));
}

function checkpointShapeViolation(value: unknown): string | null {
  if (!isPlainRecord(value)) return "checkpoint must be an object";
  const extra = unexpectedKey(value, ["key", "stage", "data"]);
  if (extra) return `checkpoint.${extra} is not a v1 field`;
  if (typeof value.key !== "string" || value.key.length === 0) {
    return "checkpoint.key must be a non-empty string";
  }
  if (value.stage !== "intent" && value.stage !== "outcome") {
    return "checkpoint.stage must be intent or outcome";
  }
  if (value.data !== undefined) {
    if (!isPlainRecord(value.data)) return "checkpoint.data must be an object";
    for (const [key, item] of Object.entries(value.data)) {
      const type = typeof item;
      if (
        type !== "string" &&
        type !== "boolean" &&
        !isFiniteNumber(item)
      ) {
        return `checkpoint.data.${key} must be a string, boolean, or finite number`;
      }
    }
  }
  return null;
}

function receiptShapeViolation(value: unknown): string | null {
  if (!isPlainRecord(value)) return "receipt must be an object";
  const extra = unexpectedKey(value, ["kind", "ref", "recordedAt"]);
  if (extra) return `receipt.${extra} is not a v1 field`;
  if (!RECEIPT_KINDS.has(value.kind as SessionReceipt["kind"])) {
    return "receipt.kind is invalid";
  }
  if (typeof value.ref !== "string" || value.ref.length === 0) {
    return "receipt.ref must be a non-empty string";
  }
  if (value.recordedAt !== undefined && !isFiniteNumber(value.recordedAt)) {
    return "receipt.recordedAt must be a finite number";
  }
  return null;
}

/**
 * Enforce the portable checkpoint payload shape: every `data` value MUST be a
 * string, boolean, or finite number. This rejects nested/complex values and JSON
 * lossy numbers (`NaN`/`Infinity`); it deliberately does NOT claim to identify
 * secrets hidden in opaque strings.
 */
export function assertCheckpointPayloadShape(cp: SessionCheckpoint): void {
  const violation = checkpointShapeViolation(cp);
  if (violation) throw new DacsError(violation);
}

/** Validate a receipt before it is admitted to either store implementation. */
export function assertSessionReceiptShape(receipt: SessionReceipt): void {
  const violation = receiptShapeViolation(receipt);
  if (violation) throw new DacsError(violation);
}

/** An exclusive worker lease over a session's active phase. */
export interface SessionLease {
  owner: string;
  expiresAt: number;
}

export interface SessionRecord {
  storeVersion: typeof SESSION_STORE_VERSION;
  jobId: string;
  agreementHash?: string;
  phase: SessionPhase;
  /** Monotonic counter bumped on every mutation — the compare-and-set token. */
  revision: number;
  lease?: SessionLease;
  checkpoints: SessionCheckpoint[];
  receipts: SessionReceipt[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Validate the complete persisted v1 record. Filesystem readers use this before
 * returning `ok`; mutation paths use the narrower checkpoint/receipt validators
 * before a bad value can be written.
 */
export function sessionRecordShapeViolation(value: unknown): string | null {
  if (!isPlainRecord(value)) return "session record must be an object";
  const extra = unexpectedKey(value, [
    "storeVersion",
    "jobId",
    "agreementHash",
    "phase",
    "revision",
    "lease",
    "checkpoints",
    "receipts",
    "createdAt",
    "updatedAt",
  ]);
  if (extra) return `${extra} is not a v1 session-record field`;
  if (value.storeVersion !== SESSION_STORE_VERSION) {
    return "storeVersion does not match this reader";
  }
  if (typeof value.jobId !== "string" || value.jobId.length === 0) {
    return "jobId missing or not a non-empty string";
  }
  if (
    value.agreementHash !== undefined &&
    (typeof value.agreementHash !== "string" || value.agreementHash.length === 0)
  ) {
    return "agreementHash must be a non-empty string when present";
  }
  if (typeof value.phase !== "string" || value.phase.length === 0) {
    return "phase missing or not a non-empty string";
  }
  if (
    !Number.isInteger(value.revision) ||
    (value.revision as number) < 0
  ) {
    return "revision must be a non-negative integer";
  }
  if (!isFiniteNumber(value.createdAt)) return "createdAt must be a finite number";
  if (!isFiniteNumber(value.updatedAt)) return "updatedAt must be a finite number";
  if (value.lease !== undefined) {
    if (!isPlainRecord(value.lease)) return "lease must be an object";
    const leaseExtra = unexpectedKey(value.lease, ["owner", "expiresAt"]);
    if (leaseExtra) return `lease.${leaseExtra} is not a v1 field`;
    if (
      typeof value.lease.owner !== "string" ||
      value.lease.owner.length === 0
    ) {
      return "lease.owner must be a non-empty string";
    }
    if (!isFiniteNumber(value.lease.expiresAt)) {
      return "lease.expiresAt must be a finite number";
    }
  }
  if (!Array.isArray(value.checkpoints)) return "checkpoints missing or not an array";
  for (let index = 0; index < value.checkpoints.length; index++) {
    const violation = checkpointShapeViolation(value.checkpoints[index]);
    if (violation) return `checkpoints[${index}]: ${violation}`;
  }
  if (!Array.isArray(value.receipts)) return "receipts missing or not an array";
  for (let index = 0; index < value.receipts.length; index++) {
    const violation = receiptShapeViolation(value.receipts[index]);
    if (violation) return `receipts[${index}]: ${violation}`;
  }
  return null;
}

/**
 * A load result that distinguishes `missing` (nothing stored) from `corrupt`
 * (state exists but cannot be parsed/trusted) from `unsupported` (a newer schema
 * schema version) — a consumer MUST fail closed on `corrupt`/`unsupported`, never treat
 * them as `missing` and silently reset anti-replay state.
 */
export type SessionLoad =
  | { status: "missing" }
  | { status: "corrupt"; reason: string }
  | { status: "unsupported"; version: number }
  | { status: "ok"; record: SessionRecord };

/** Result of a compare-and-set mutation. */
export type TransitionResult =
  | { ok: true; record: SessionRecord }
  | {
      ok: false;
      reason: "not-found" | "revision-mismatch" | "immutable-receipt" | "lease-held" | "corrupt" | "unsupported";
      record?: SessionRecord;
    };

/**
 * Result of atomically claiming a checkpoint key.
 *
 * `held` means an intent already exists without an outcome; the caller MUST
 * reconcile that external effect rather than submit it again. `completed`
 * means the key already has an outcome and the caller should replay it.
 */
export type CheckpointClaimResult =
  | { ok: true; record: SessionRecord }
  | {
      ok: false;
      reason: "not-found" | "held" | "completed" | "lease-held" | "corrupt" | "unsupported";
      record?: SessionRecord;
    };

export interface CheckpointClaimInput {
  jobId: string;
  /** Stable side-effect key, e.g. `settle:0`. */
  key: string;
  /** Primitive intent metadata; callers MUST keep credentials and wallet secrets out. */
  data?: Record<string, CheckpointValue>;
  phase?: SessionPhase;
  owner?: string;
  now?: number;
}

export interface TransitionInput {
  jobId: string;
  /** The `revision` the caller last observed — the transition fails if it moved. */
  expectedRevision: number;
  /**
   * The worker asserting this transition. If the session has a LIVE lease held by
   * a DIFFERENT owner, the transition is rejected (`lease-held`) — a guarded phase
   * can only be advanced by the lease owner (#67). Omit only for unguarded writes.
   */
  owner?: string;
  phase?: SessionPhase;
  checkpoint?: SessionCheckpoint;
  receipt?: SessionReceipt;
  /** Set/refresh the lease, or pass `null` to release it. */
  lease?: SessionLease | null;
  now?: number;
}

export interface SessionStore {
  /** Create a new session. Rejects if the jobId already exists. */
  create(input: {
    jobId: string;
    agreementHash?: string;
    phase?: SessionPhase;
    now?: number;
  }): Promise<SessionRecord>;

  /** Load a session, distinguishing missing / corrupt / unsupported / ok. */
  load(jobId: string): Promise<SessionLoad>;

  /**
   * Compare-and-set a phase transition + optional checkpoint/receipt/lease
   * mutation. Fails with `revision-mismatch` if the record moved since
   * `expectedRevision` — so two workers cannot both advance the same phase.
   */
  transition(input: TransitionInput): Promise<TransitionResult>;

  /**
   * Atomically append the first `intent` for a side-effect key.
   *
   * Unlike a revision CAS performed after `load()`, this semantic claim cannot
   * be reacquired by a worker that starts after the first claimant advanced the
   * revision. An unresolved prior intent returns `held`; an existing outcome
   * returns `completed`.
   */
  claimCheckpoint(input: CheckpointClaimInput): Promise<CheckpointClaimResult>;

  /**
   * Acquire an exclusive worker lease. Succeeds if unheld, expired, or already
   * owned by `owner`; fails if a live lease is held by a different owner — so
   * only one worker processes a session's active phase at a time.
   */
  acquireLease(input: {
    jobId: string;
    owner: string;
    ttlMs: number;
    now?: number;
  }): Promise<{ ok: boolean; record?: SessionRecord }>;

  /**
   * Anti-replay: bind an agreement/transaction hash to a jobId. Idempotent for
   * the same jobId; REJECTS if the hash is already bound to a DIFFERENT session
   * (reusing an agreement/tx hash across sessions is a replay).
   */
  bindHash(input: {
    hash: string;
    jobId: string;
    kind: "agreement" | "transaction";
  }): Promise<{ ok: boolean; boundTo?: string }>;

  /** Enumerate sessions for status APIs (optionally filtered by phase). */
  list(filter?: { phase?: SessionPhase; limit?: number }): Promise<SessionRecord[]>;
}

const clone = <T>(v: T): T => structuredClone(v);

/**
 * In-memory {@link SessionStore} — the conformance reference used by tests and
 * single-process services. It gives correct compare-and-set, lease, anti-replay,
 * and missing/corrupt/unsupported semantics; durability across process restarts
 * needs a persistent backend (the atomic-filesystem impl is a follow-up). Records
 * are deep-cloned on the way in and out so a caller can't mutate stored state.
 */
export function createInMemorySessionStore(): SessionStore {
  const sessions = new Map<string, SessionRecord>();
  const hashBindings = new Map<string, { jobId: string; kind: string }>();

  const leaseHeldByOther = (rec: SessionRecord, owner: string, now: number): boolean =>
    !!rec.lease && rec.lease.expiresAt > now && rec.lease.owner !== owner;

  return {
    async create({ jobId, agreementHash, phase = "created", now = Date.now() }) {
      if (sessions.has(jobId)) {
        throw new DacsError(`session ${jobId} already exists`);
      }
      // Anti-replay: reserve the agreement hash BEFORE persisting, and REJECT if
      // it's already owned by a different session — a reused agreement hash across
      // sessions is a replay and must never silently overwrite ownership (#67).
      if (agreementHash) {
        const existing = hashBindings.get(agreementHash);
        if (existing && existing.jobId !== jobId) {
          throw new DacsError(
            `agreement hash is already bound to session ${existing.jobId} (anti-replay); cannot create ${jobId}`,
          );
        }
      }
      const record: SessionRecord = {
        storeVersion: SESSION_STORE_VERSION,
        jobId,
        ...(agreementHash ? { agreementHash } : {}),
        phase,
        revision: 0,
        checkpoints: [],
        receipts: [],
        createdAt: now,
        updatedAt: now,
      };
      const violation = sessionRecordShapeViolation(record);
      if (violation) throw new DacsError(`invalid session record: ${violation}`);
      sessions.set(jobId, record);
      if (agreementHash) hashBindings.set(agreementHash, { jobId, kind: "agreement" });
      return clone(record);
    },

    async load(jobId) {
      const record = sessions.get(jobId);
      if (!record) return { status: "missing" };
      // A future backend surfaces `unsupported` for a newer storeVersion and
      // `corrupt` for unparseable state; in-memory records are always current.
      if (record.storeVersion > SESSION_STORE_VERSION) {
        return { status: "unsupported", version: record.storeVersion };
      }
      return { status: "ok", record: clone(record) };
    },

    async transition(input) {
      const record = sessions.get(input.jobId);
      if (!record) return { ok: false, reason: "not-found" };
      if (record.revision !== input.expectedRevision) {
        return { ok: false, reason: "revision-mismatch", record: clone(record) };
      }
      // A live lease held by a DIFFERENT owner blocks the transition (#67) — a
      // guarded phase can only be advanced by the worker that holds the lease.
      // Default to the REAL clock (not record.updatedAt): a stale timestamp never
      // advances past the lease's expiresAt, so an already-expired lease would be
      // read as still-held and a legitimate takeover wrongly rejected (#67).
      const leaseNow = input.now ?? Date.now();
      if (record.lease && record.lease.expiresAt > leaseNow && input.owner !== record.lease.owner) {
        return { ok: false, reason: "lease-held", record: clone(record) };
      }
      if (input.checkpoint) assertCheckpointPayloadShape(input.checkpoint);
      if (input.receipt) assertSessionReceiptShape(input.receipt);
      // Receipts are immutable: re-recording the same kind+ref is idempotent, but
      // a different ref for a kind already recorded is rejected.
      if (input.receipt) {
        const prior = record.receipts.find((r) => r.kind === input.receipt!.kind);
        if (prior && prior.ref !== input.receipt.ref) {
          return { ok: false, reason: "immutable-receipt", record: clone(record) };
        }
      }
      const now = input.now ?? Date.now();
      const next: SessionRecord = clone(record);
      next.revision += 1;
      next.updatedAt = now;
      if (input.phase !== undefined) next.phase = input.phase;
      if (input.checkpoint) next.checkpoints.push(clone(input.checkpoint));
      if (input.receipt) {
        const exists = next.receipts.some(
          (r) => r.kind === input.receipt!.kind && r.ref === input.receipt!.ref,
        );
        if (!exists) next.receipts.push({ recordedAt: now, ...clone(input.receipt) });
      }
      if (input.lease === null) delete next.lease;
      else if (input.lease) next.lease = clone(input.lease);
      const violation = sessionRecordShapeViolation(next);
      if (violation) throw new DacsError(`invalid session transition: ${violation}`);
      sessions.set(input.jobId, next);
      return { ok: true, record: clone(next) };
    },

    async claimCheckpoint(input) {
      const record = sessions.get(input.jobId);
      if (!record) return { ok: false, reason: "not-found" };
      const now = input.now ?? Date.now();
      if (leaseHeldByOther(record, input.owner ?? "", now)) {
        return { ok: false, reason: "lease-held", record: clone(record) };
      }
      const prior = [...record.checkpoints].reverse().find((cp) => cp.key === input.key);
      if (prior) {
        return {
          ok: false,
          reason: prior.stage === "outcome" ? "completed" : "held",
          record: clone(record),
        };
      }
      const checkpoint: SessionCheckpoint = {
        key: input.key,
        stage: "intent",
        ...(input.data ? { data: input.data } : {}),
      };
      assertCheckpointPayloadShape(checkpoint);
      const next = clone(record);
      next.revision += 1;
      next.updatedAt = now;
      if (input.phase !== undefined) next.phase = input.phase;
      next.checkpoints.push(clone(checkpoint));
      const violation = sessionRecordShapeViolation(next);
      if (violation) throw new DacsError(`invalid checkpoint claim: ${violation}`);
      sessions.set(input.jobId, next);
      return { ok: true, record: clone(next) };
    },

    async acquireLease({ jobId, owner, ttlMs, now = Date.now() }) {
      // An epoch-zero clock would make every lease instantly expired, silently
      // voiding the mutual-exclusion guarantee that guards the money path (#67)
      // — so the default is the REAL clock, and the TTL must be a positive span.
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new DacsError(`acquireLease ttlMs must be a positive number, got ${ttlMs}`);
      }
      const record = sessions.get(jobId);
      if (!record) return { ok: false };
      if (leaseHeldByOther(record, owner, now)) return { ok: false, record: clone(record) };
      const next = clone(record);
      next.revision += 1;
      next.updatedAt = now;
      next.lease = { owner, expiresAt: now + ttlMs };
      const violation = sessionRecordShapeViolation(next);
      if (violation) throw new DacsError(`invalid lease: ${violation}`);
      sessions.set(jobId, next);
      return { ok: true, record: clone(next) };
    },

    async bindHash({ hash, jobId, kind }) {
      const existing = hashBindings.get(hash);
      if (existing) {
        return existing.jobId === jobId
          ? { ok: true, boundTo: jobId } // idempotent for the same session
          : { ok: false, boundTo: existing.jobId }; // replay across sessions
      }
      hashBindings.set(hash, { jobId, kind });
      return { ok: true, boundTo: jobId };
    },

    async list(filter) {
      let out = [...sessions.values()];
      if (filter?.phase !== undefined) out = out.filter((r) => r.phase === filter.phase);
      out.sort((a, b) => b.updatedAt - a.updatedAt);
      if (filter?.limit !== undefined) out = out.slice(0, filter.limit);
      return out.map(clone);
    },
  };
}

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
 * Records carry only references (jobId, agreement/tx hashes, receipt refs) — NEVER
 * wallet secrets or model credentials. Every record is schema-versioned so a
 * future reader can distinguish `unsupported` from `corrupt` from `missing`.
 */

export const SESSION_STORE_VERSION = 1 as const;

/** The lifecycle phase a session is in (free string so recipes can extend it). */
export type SessionPhase = string;

/** An immutable, secret-free receipt for a recorded session side effect. */
export interface SessionReceipt {
  kind: "agreement" | "settlement" | "delivery" | "fulfilment" | "bundle";
  /** Content hash / tx hash / anchor address — the audit pointer. */
  ref: string;
  recordedAt?: number;
}

/**
 * A checkpoint payload value. PRIMITIVES ONLY (string / number / boolean) — a
 * closed, secret-free shape so a caller can't smuggle credentials / nested
 * objects into durable state (#67). Enforced at write time by the store.
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
  /** Opaque, secret-free payload — PRIMITIVE values only (rail id, idempotency key, tx ref, …). */
  data?: Record<string, CheckpointValue>;
}

/**
 * Enforce the closed, secret-free checkpoint payload shape (#67): every `data`
 * value MUST be a primitive. Rejects nested objects/arrays/functions so
 * credentials or large blobs can't be persisted into durable session state.
 */
export function assertSecretFreeCheckpoint(cp: SessionCheckpoint): void {
  if (!cp.data) return;
  for (const [k, v] of Object.entries(cp.data)) {
    const t = typeof v;
    if (t !== "string" && t !== "number" && t !== "boolean") {
      throw new DacsError(
        `checkpoint.data.${k} must be a primitive (string/number/boolean); nested/complex values are rejected so secrets can't be persisted`,
      );
    }
  }
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
 * A load result that distinguishes `missing` (nothing stored) from `corrupt`
 * (state exists but cannot be parsed/trusted) from `unsupported` (a newer schema
 * version) — a consumer MUST fail closed on `corrupt`/`unsupported`, never treat
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
      if (input.checkpoint) assertSecretFreeCheckpoint(input.checkpoint);
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

import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { DacsError } from "../errors.js";
import {
  assertCheckpointPayloadShape,
  assertSessionReceiptShape,
  SESSION_STORE_VERSION,
  sessionRecordShapeViolation,
  type CheckpointClaimInput,
  type CheckpointClaimResult,
  type SessionLoad,
  type SessionRecord,
  type SessionStore,
  type TransitionInput,
  type TransitionResult,
} from "./sessionStore.js";

/**
 * Atomic-filesystem {@link SessionStore} (#55) — a durable, restart-safe backend
 * for a single host. Each session is one JSON file written via temp-file +
 * `rename` (atomic on POSIX); a per-session lock file serialises read-modify-write
 * so compare-and-set and lease semantics hold across concurrent workers/processes;
 * anti-replay hash bindings are one file per hash published with an atomic
 * no-overwrite hard-link, so a cross-session reuse is rejected. Session creation uses a recoverable
 * session-first transaction: atomically persist the complete session, then commit
 * its hash binding. A crash leaves an unbound but recoverable session, never a
 * binding that another live creator can mistake for an orphan. Files are written
 * mode 0600 and directories 0700. The store validates the primitive checkpoint
 * shape; callers remain responsible for persisting references rather than opaque
 * string credentials.
 *
 * `load` fails CLOSED: unparseable state is `corrupt` (including a field of the
 * wrong type, not just bad JSON) and an unknown schema is `unsupported` — neither is
 * ever silently treated as `missing`, which would reset anti-replay. A lock is
 * released in `finally`; one left by a hard-crashed holder is reclaimed once it
 * passes the stale window (`lockStaleMs`), so a session can't be blocked forever.
 */

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const LOCK_RETRY_MS = 5;
const LOCK_MAX_RETRIES = 400; // ~2s of contention before giving up

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const safe = (s: string) => encodeURIComponent(s);

/** Default age after which a lock left by a crashed process is reclaimable. */
const DEFAULT_LOCK_STALE_MS = 30_000;

export interface FsSessionStoreOptions {
  /** Directory the store owns (created if missing). */
  dir: string;
  /**
   * Age (ms) after which a lock file left behind by a hard-crashed process is
   * treated as stale and reclaimed, so a session isn't blocked forever (#67).
   * Defaults to {@link DEFAULT_LOCK_STALE_MS}.
   */
  lockStaleMs?: number;
}

export async function createFsSessionStore(
  opts: FsSessionStoreOptions,
): Promise<SessionStore> {
  const lockStaleMs = opts.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
  if (!Number.isFinite(lockStaleMs) || lockStaleMs <= 0) {
    throw new DacsError(
      `lockStaleMs must be a positive finite number, got ${lockStaleMs}`,
    );
  }
  const sessionsDir = join(opts.dir, "sessions");
  const hashesDir = join(opts.dir, "hashes");
  const locksDir = join(opts.dir, "locks");
  for (const d of [sessionsDir, hashesDir, locksDir]) {
    await mkdir(d, { recursive: true, mode: DIR_MODE });
  }

  const sessionPath = (jobId: string) => join(sessionsDir, `${safe(jobId)}.json`);
  const hashPath = (hash: string) => join(hashesDir, `${safe(hash)}.json`);
  const lockPath = (jobId: string) => join(locksDir, `${safe(jobId)}.lock`);

  async function atomicWriteJson(path: string, value: unknown): Promise<void> {
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(value), { mode: FILE_MODE });
    await rename(tmp, path);
  }

  /**
   * Publish a complete JSON file only if `path` does not exist. The hard-link is
   * the atomic commit: readers never observe a partially-written session or hash
   * binding, and concurrent creators cannot overwrite one another.
   */
  async function exclusiveWriteJson(path: string, value: unknown): Promise<void> {
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(value), {
        mode: FILE_MODE,
        flag: "wx",
      });
      await link(tmp, path);
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }

  async function readSession(jobId: string): Promise<SessionLoad> {
    let text: string;
    try {
      text = await readFile(sessionPath(jobId), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
      throw e;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return { status: "corrupt", reason: "session file is not valid JSON" };
    }
    // Check the schema version BEFORE the field shape: a newer writer may use a
    // shape this version doesn't understand, and that is `unsupported`, not
    // `corrupt` (#67 — never conflate the two).
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("storeVersion" in parsed) ||
      typeof parsed.storeVersion !== "number"
    ) {
      return { status: "corrupt", reason: "session file is missing storeVersion" };
    }
    if (parsed.storeVersion !== SESSION_STORE_VERSION) {
      return { status: "unsupported", version: parsed.storeVersion };
    }
    // Validate the COMPLETE nested shape: corrupt checkpoint/receipt/lease entries
    // must never load as `ok` and crash a later money-path mutation.
    const bad = sessionRecordShapeViolation(parsed);
    if (bad) return { status: "corrupt", reason: bad };
    return { status: "ok", record: parsed as SessionRecord };
  }

  /** Reclaim a lock left behind by a crashed holder once it's older than the stale window. */
  async function reclaimIfStale(lp: string): Promise<void> {
    try {
      const st = await stat(lp);
      if (Date.now() - st.mtimeMs > lockStaleMs) {
        // Best-effort: unlink the stale lock so a fresh holder can take it. A race
        // where another worker reclaims first is harmless — the next open() retries.
        await unlink(lp).catch(() => {});
      }
    } catch {
      // Lock vanished between EEXIST and stat — nothing to reclaim; retry loop continues.
    }
  }

  /** Serialise a read-modify-write for one session via an exclusive lock file. */
  async function withLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
    const lp = lockPath(jobId);
    for (let i = 0; ; i++) {
      try {
        const handle = await open(lp, "wx", FILE_MODE); // O_EXCL: only one holder
        await handle.close();
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        // A hard-crashed holder can never release its lock; reclaim it once stale
        // so the session isn't blocked forever (#67).
        await reclaimIfStale(lp);
        if (i >= LOCK_MAX_RETRIES) {
          throw new DacsError(`session ${jobId} lock is contended (timed out)`);
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
    try {
      return await fn();
    } finally {
      await unlink(lp).catch(() => {});
    }
  }

  const bindHashImpl = async (
    hash: string,
    jobId: string,
    kind: "agreement" | "transaction",
  ): Promise<{ ok: boolean; boundTo?: string }> => {
    const path = hashPath(hash);
    try {
      await exclusiveWriteJson(path, { jobId, kind });
      return { ok: true, boundTo: jobId };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let existing: { jobId?: unknown; kind?: unknown };
      try {
        existing = JSON.parse(await readFile(path, "utf8")) as {
          jobId?: unknown;
          kind?: unknown;
        };
      } catch {
        throw new DacsError(`hash binding ${hash} is corrupt; refusing to reclaim it`);
      }
      if (
        typeof existing.jobId !== "string" ||
        (existing.kind !== "agreement" && existing.kind !== "transaction")
      ) {
        throw new DacsError(`hash binding ${hash} has an invalid shape; refusing to reclaim it`);
      }
      if (existing.jobId === jobId) {
        return { ok: true, boundTo: jobId }; // idempotent for the same session
      }
      return { ok: false, boundTo: existing.jobId }; // replay across sessions
    }
  };

  /**
   * Find a complete session left between the session and hash commits. This is
   * the only crash residue created by the session-first protocol. A later create
   * finalizes its binding instead of stealing the hash.
   */
  async function findUnboundAgreementOwner(
    agreementHash: string,
    exceptJobId: string,
  ): Promise<string | undefined> {
    const files = (await readdir(sessionsDir)).filter(
      (f) => f.endsWith(".json") && !f.endsWith(".tmp"),
    );
    const candidates: SessionRecord[] = [];
    for (const file of files) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(join(sessionsDir, file), "utf8")) as unknown;
      } catch {
        continue;
      }
      if (sessionRecordShapeViolation(parsed) !== null) continue;
      const record = parsed as SessionRecord;
      if (
        record.jobId !== exceptJobId &&
        record.agreementHash === agreementHash &&
        record.storeVersion === SESSION_STORE_VERSION
      ) {
        candidates.push(record);
      }
    }
    candidates.sort((a, b) => a.createdAt - b.createdAt || a.jobId.localeCompare(b.jobId));
    return candidates[0]?.jobId;
  }

  return {
    async create({ jobId, agreementHash, phase = "created", now = Date.now() }) {
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
      // Reject a duplicate jobId before starting the transaction. The exclusive
      // session publish below remains the arbiter for a concurrent duplicate.
      if ((await readSession(jobId)).status !== "missing") {
        throw new DacsError(`session ${jobId} already exists`);
      }

      // Recover a crash after another creator committed its session but before it
      // committed the hash. Crucially, there is no binding-before-session window:
      // a live creator's ownership can never be mistaken for an orphan and stolen.
      if (agreementHash) {
        const recoverableOwner = await findUnboundAgreementOwner(agreementHash, jobId);
        if (recoverableOwner) {
          const recovered = await bindHashImpl(
            agreementHash,
            recoverableOwner,
            "agreement",
          );
          throw new DacsError(
            `agreement hash is already bound to session ${recovered.boundTo ?? recoverableOwner} ` +
              `(anti-replay); cannot create ${jobId}`,
          );
        }
      }

      // Recoverable transaction:
      //   1. atomically publish the complete session;
      //   2. atomically commit the hash binding;
      //   3. remove only OUR session if another creator won the hash race.
      // A crash between 1 and 2 is recovered by findUnboundAgreementOwner().
      try {
        await exclusiveWriteJson(sessionPath(jobId), record);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") {
          throw new DacsError(`session ${jobId} already exists`);
        }
        throw e;
      }

      if (agreementHash) {
        try {
          const bound = await bindHashImpl(agreementHash, jobId, "agreement");
          if (!bound.ok) {
            throw new DacsError(
              `agreement hash is already bound to session ${bound.boundTo} ` +
                `(anti-replay); cannot create ${jobId}`,
            );
          }
        } catch (e) {
          // The binding either belongs to another session or could not be trusted.
          // Roll back only the session this invocation exclusively published;
          // never unlink a hash binding whose ownership we did not establish.
          await unlink(sessionPath(jobId)).catch(() => {});
          throw e;
        }
      }
      return record;
    },

    load(jobId) {
      return readSession(jobId);
    },

    async transition(input: TransitionInput): Promise<TransitionResult> {
      return withLock(input.jobId, async () => {
        const loaded = await readSession(input.jobId);
        // Fail closed: surface corrupt/unsupported distinctly — NEVER collapse
        // them into `not-found`, which would let a caller silently reset a
        // session whose state can't be trusted (#67).
        if (loaded.status === "missing") return { ok: false, reason: "not-found" };
        if (loaded.status === "corrupt") return { ok: false, reason: "corrupt" };
        if (loaded.status === "unsupported") return { ok: false, reason: "unsupported" };
        const record = loaded.record;
        if (record.revision !== input.expectedRevision) {
          return { ok: false, reason: "revision-mismatch", record };
        }
        // A live lease held by a DIFFERENT owner blocks the transition (#67).
        // Default to the REAL clock (not record.updatedAt): a stale timestamp
        // never advances past expiresAt, so an already-expired lease would read
        // as still-held and a legitimate takeover be wrongly rejected (#67).
        const leaseNow = input.now ?? Date.now();
        if (record.lease && record.lease.expiresAt > leaseNow && input.owner !== record.lease.owner) {
          return { ok: false, reason: "lease-held", record };
        }
        if (input.checkpoint) assertCheckpointPayloadShape(input.checkpoint);
        if (input.receipt) assertSessionReceiptShape(input.receipt);
        if (input.receipt) {
          const prior = record.receipts.find((r) => r.kind === input.receipt!.kind);
          if (prior && prior.ref !== input.receipt.ref) {
            return { ok: false, reason: "immutable-receipt", record };
          }
        }
        const now = input.now ?? Date.now();
        record.revision += 1;
        record.updatedAt = now;
        if (input.phase !== undefined) record.phase = input.phase;
        if (input.checkpoint) record.checkpoints.push(input.checkpoint);
        if (input.receipt) {
          const exists = record.receipts.some(
            (r) => r.kind === input.receipt!.kind && r.ref === input.receipt!.ref,
          );
          if (!exists) record.receipts.push({ recordedAt: now, ...input.receipt });
        }
        if (input.lease === null) delete record.lease;
        else if (input.lease) record.lease = input.lease;
        const violation = sessionRecordShapeViolation(record);
        if (violation) throw new DacsError(`invalid session transition: ${violation}`);
        await atomicWriteJson(sessionPath(input.jobId), record);
        return { ok: true, record };
      });
    },

    async claimCheckpoint(
      input: CheckpointClaimInput,
    ): Promise<CheckpointClaimResult> {
      return withLock(input.jobId, async () => {
        const loaded = await readSession(input.jobId);
        if (loaded.status === "missing") return { ok: false, reason: "not-found" };
        if (loaded.status === "corrupt") return { ok: false, reason: "corrupt" };
        if (loaded.status === "unsupported") return { ok: false, reason: "unsupported" };
        const record = loaded.record;
        const now = input.now ?? Date.now();
        if (
          record.lease &&
          record.lease.expiresAt > now &&
          input.owner !== record.lease.owner
        ) {
          return { ok: false, reason: "lease-held", record };
        }
        const prior = [...record.checkpoints].reverse().find((cp) => cp.key === input.key);
        if (prior) {
          return {
            ok: false,
            reason: prior.stage === "outcome" ? "completed" : "held",
            record,
          };
        }
        const checkpoint = {
          key: input.key,
          stage: "intent" as const,
          ...(input.data ? { data: input.data } : {}),
        };
        assertCheckpointPayloadShape(checkpoint);
        record.revision += 1;
        record.updatedAt = now;
        if (input.phase !== undefined) record.phase = input.phase;
        record.checkpoints.push(checkpoint);
        const violation = sessionRecordShapeViolation(record);
        if (violation) throw new DacsError(`invalid checkpoint claim: ${violation}`);
        await atomicWriteJson(sessionPath(input.jobId), record);
        return { ok: true, record };
      });
    },

    async acquireLease({ jobId, owner, ttlMs, now = Date.now() }) {
      // Same clock/TTL discipline as the in-memory store (#67): an epoch-zero
      // default silently voids lease mutual exclusion on the money path.
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new DacsError(`acquireLease ttlMs must be a positive number, got ${ttlMs}`);
      }
      return withLock(jobId, async () => {
        const loaded = await readSession(jobId);
        if (loaded.status !== "ok") return { ok: false };
        const record = loaded.record;
        if (record.lease && record.lease.expiresAt > now && record.lease.owner !== owner) {
          return { ok: false, record };
        }
        record.revision += 1;
        record.updatedAt = now;
        record.lease = { owner, expiresAt: now + ttlMs };
        const violation = sessionRecordShapeViolation(record);
        if (violation) throw new DacsError(`invalid lease: ${violation}`);
        await atomicWriteJson(sessionPath(jobId), record);
        return { ok: true, record };
      });
    },

    bindHash({ hash, jobId, kind }) {
      return bindHashImpl(hash, jobId, kind);
    },

    async list(filter) {
      const files = (await readdir(sessionsDir)).filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"));
      const records: SessionRecord[] = [];
      for (const f of files) {
        try {
          const parsed = JSON.parse(await readFile(join(sessionsDir, f), "utf8")) as unknown;
          if (sessionRecordShapeViolation(parsed) === null) {
            records.push(parsed as SessionRecord);
          }
        } catch {
          // Skip an unreadable/partial file in a listing (load() still reports it corrupt).
        }
      }
      let out = records;
      if (filter?.phase !== undefined) out = out.filter((r) => r.phase === filter.phase);
      out.sort((a, b) => b.updatedAt - a.updatedAt);
      if (filter?.limit !== undefined) out = out.slice(0, filter.limit);
      return out;
    },
  };
}

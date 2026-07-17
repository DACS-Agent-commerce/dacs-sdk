import { mkdir, readFile, writeFile, rename, unlink, readdir, open } from "node:fs/promises";
import { join } from "node:path";

import { DacsError } from "../errors.js";
import {
  SESSION_STORE_VERSION,
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
 * anti-replay hash bindings are one file per hash created with `O_EXCL`, so a
 * cross-session reuse is rejected atomically. Files are written mode 0600 and
 * directories 0700 — and records carry only references, never secrets.
 *
 * `load` fails CLOSED: unparseable state is `corrupt` and a newer schema is
 * `unsupported` (never silently treated as `missing`, which would reset
 * anti-replay). Stale-lock recovery (a lock left by a hard-crashed process) is a
 * documented follow-up; a lock is otherwise always released in `finally`.
 */

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const LOCK_RETRY_MS = 5;
const LOCK_MAX_RETRIES = 400; // ~2s of contention before giving up

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const safe = (s: string) => encodeURIComponent(s);

export interface FsSessionStoreOptions {
  /** Directory the store owns (created if missing). */
  dir: string;
}

export async function createFsSessionStore(
  opts: FsSessionStoreOptions,
): Promise<SessionStore> {
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

  async function readSession(jobId: string): Promise<SessionLoad> {
    let text: string;
    try {
      text = await readFile(sessionPath(jobId), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
      throw e;
    }
    let record: SessionRecord;
    try {
      record = JSON.parse(text) as SessionRecord;
    } catch {
      return { status: "corrupt", reason: "session file is not valid JSON" };
    }
    if (typeof record?.storeVersion !== "number" || !Array.isArray(record.receipts)) {
      return { status: "corrupt", reason: "session file is missing required fields" };
    }
    if (record.storeVersion > SESSION_STORE_VERSION) {
      return { status: "unsupported", version: record.storeVersion };
    }
    return { status: "ok", record };
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
      const handle = await open(path, "wx", FILE_MODE); // atomic reserve
      await handle.writeFile(JSON.stringify({ jobId, kind }));
      await handle.close();
      return { ok: true, boundTo: jobId };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const existing = JSON.parse(await readFile(path, "utf8")) as { jobId: string };
      return existing.jobId === jobId
        ? { ok: true, boundTo: jobId } // idempotent for the same session
        : { ok: false, boundTo: existing.jobId }; // replay across sessions
    }
  };

  return {
    async create({ jobId, agreementHash, phase = "created", now = 0 }) {
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
      // Exclusive-create the session file so a concurrent create can't clobber it.
      try {
        const handle = await open(sessionPath(jobId), "wx", FILE_MODE);
        await handle.writeFile(JSON.stringify(record));
        await handle.close();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") {
          throw new DacsError(`session ${jobId} already exists`);
        }
        throw e;
      }
      if (agreementHash) {
        await bindHashImpl(agreementHash, jobId, "agreement");
      }
      return record;
    },

    load(jobId) {
      return readSession(jobId);
    },

    async transition(input: TransitionInput): Promise<TransitionResult> {
      return withLock(input.jobId, async () => {
        const loaded = await readSession(input.jobId);
        if (loaded.status !== "ok") return { ok: false, reason: "not-found" };
        const record = loaded.record;
        if (record.revision !== input.expectedRevision) {
          return { ok: false, reason: "revision-mismatch", record };
        }
        if (input.receipt) {
          const prior = record.receipts.find((r) => r.kind === input.receipt!.kind);
          if (prior && prior.ref !== input.receipt.ref) {
            return { ok: false, reason: "immutable-receipt", record };
          }
        }
        const now = input.now ?? record.updatedAt;
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
        await atomicWriteJson(sessionPath(input.jobId), record);
        return { ok: true, record };
      });
    },

    async acquireLease({ jobId, owner, ttlMs, now = 0 }) {
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
          const record = JSON.parse(await readFile(join(sessionsDir, f), "utf8")) as SessionRecord;
          if (record?.storeVersion === SESSION_STORE_VERSION) records.push(record);
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

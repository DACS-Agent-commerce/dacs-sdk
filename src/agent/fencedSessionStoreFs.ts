import {
  link,
  mkdir,
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
  assertSessionPaymentAuthorizationShape,
  assertSessionReceiptShape,
  compareFencedSessionRecords,
  FENCED_SESSION_STORE_VERSION,
  sessionAuthorizationPhaseFailure,
  sessionLeaseScopeFailure,
  sessionPhaseMutationFailure,
  sessionPhaseIsTerminal,
  terminalBundleSealMutationFailure,
  sessionReceiptKey,
  sessionRecordShapeViolation,
  snapshotFencedAcquireLeaseInput,
  snapshotFencedAuthorizationInput,
  snapshotFencedBindHashInput,
  snapshotFencedCheckpointClaimInput,
  snapshotFencedCreateInput,
  snapshotFencedJobId,
  snapshotFencedListFilter,
  snapshotFencedRenewLeaseInput,
  snapshotFencedTransitionInput,
  type CheckpointClaimInput,
  type CheckpointClaimResult,
  type LeaseResult,
  type SessionLoad,
  type SessionLeaseToken,
  type SessionPaymentAuthorizationBinding,
  type SessionRecord,
  type FencedSessionStoreV2,
  type SessionAuthorizationBindingResult,
  type TransitionInput,
  type TransitionResult,
} from "./fencedSessionStore.js";
import {
  SESSION_STORE_VERSION,
  sessionRecordShapeViolation as legacySessionRecordShapeViolation,
} from "./sessionStore.js";

/**
 * Atomic-filesystem generation-fenced {@link FencedSessionStoreV2} (#55) — a durable, restart-safe backend
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
 * released in `finally`; one left by a provably dead holder is reclaimed once it
 * passes the stale window (`lockStaleMs`), while age alone never evicts a live
 * writer. Reclamation gates are themselves moved to unique quarantines before
 * recovery, so a hard crash cannot wedge the store or expose a replacement gate.
 */

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const LOCK_RETRY_MS = 5;
const LOCK_MAX_RETRIES = 400; // ~2s of contention before giving up

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const safe = (s: string) => encodeURIComponent(s);

const isNonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;

function leaseFailure(
  record: SessionRecord,
  token: SessionLeaseToken | undefined,
  now: number,
): "lease-fenced" | "lease-expired" | null {
  if (!record.lease) {
    return record.leaseGeneration > 0 || token ? "lease-fenced" : null;
  }
  if (
    !token ||
    token.owner !== record.lease.owner ||
    token.generation !== record.lease.generation
  ) {
    return "lease-fenced";
  }
  return record.lease.expiresAt > now ? null : "lease-expired";
}

function samePaymentBinding(
  left: SessionPaymentAuthorizationBinding,
  right: SessionPaymentAuthorizationBinding,
): boolean {
  return (
    left.authorizationHash === right.authorizationHash &&
    left.fulfilmentId === right.fulfilmentId &&
    left.handoffBindingHash === right.handoffBindingHash &&
    left.agreementHash === right.agreementHash &&
    left.paymentEvidenceHash === right.paymentEvidenceHash &&
    left.settlementId === right.settlementId &&
    left.paymentPhaseIndex === right.paymentPhaseIndex &&
    left.deliveryPhaseIndex === right.deliveryPhaseIndex
  );
}

function validCheckpointAppend(
  record: SessionRecord,
  checkpoint: NonNullable<TransitionInput["checkpoint"]>,
): boolean {
  const prior = [...record.checkpoints]
    .reverse()
    .find((item) => item.key === checkpoint.key);
  return checkpoint.stage === "intent"
    ? prior === undefined
    : prior?.stage === "intent";
}

function assertPositiveTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new DacsError(`lease ttlMs must be a positive number, got ${ttlMs}`);
  }
}

/** Default age after which a lock left by a crashed process is reclaimable. */
const DEFAULT_LOCK_STALE_MS = 30_000;

export interface FsFencedSessionStoreOptions {
  /** Directory the store owns (created if missing). */
  dir: string;
  /**
   * Age (ms) after which a lock file left behind by a hard-crashed process is
   * treated as stale and reclaimed, so a session isn't blocked forever (#67).
   * Defaults to {@link DEFAULT_LOCK_STALE_MS}.
   */
  lockStaleMs?: number;
}

function snapshotFsOptions(value: unknown): FsFencedSessionStoreOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null)) {
    throw new DacsError("filesystem fenced-store options must be a plain object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(["dir", "lockStaleMs"]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new DacsError(`filesystem fenced-store option ${String(key)} is unsupported`);
    }
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
      throw new DacsError(
        `filesystem fenced-store option ${key} must be an enumerable data property`,
      );
    }
  }
  if (!Object.prototype.hasOwnProperty.call(value, "dir") ||
      typeof descriptors.dir?.value !== "string" || descriptors.dir.value.length === 0) {
    throw new DacsError("filesystem fenced-store dir must be a non-empty string");
  }
  if (Object.prototype.hasOwnProperty.call(value, "lockStaleMs") &&
      descriptors.lockStaleMs?.value === undefined) {
    throw new DacsError("filesystem fenced-store lockStaleMs must be omitted, not undefined");
  }
  return {
    dir: descriptors.dir.value as string,
    ...(descriptors.lockStaleMs === undefined
      ? {}
      : { lockStaleMs: descriptors.lockStaleMs.value as number }),
  };
}

export async function createFsFencedSessionStore(
  opts: FsFencedSessionStoreOptions,
): Promise<FencedSessionStoreV2> {
  opts = snapshotFsOptions(opts);
  const lockStaleMs = opts.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
  if (!Number.isFinite(lockStaleMs) || lockStaleMs <= 0) {
    throw new DacsError(
      `lockStaleMs must be a positive finite number, got ${lockStaleMs}`,
    );
  }
  const sessionsDir = join(opts.dir, "sessions");
  const hashesDir = join(opts.dir, "hashes");
  const settlementsDir = join(opts.dir, "settlements");
  const locksDir = join(opts.dir, "locks");
  for (const d of [sessionsDir, hashesDir, settlementsDir, locksDir]) {
    await mkdir(d, { recursive: true, mode: DIR_MODE });
  }

  const sessionPath = (jobId: string) => join(sessionsDir, `${safe(jobId)}.json`);
  const hashPath = (hash: string) => join(hashesDir, `${safe(hash)}.json`);
  const settlementPath = (settlementId: string) =>
    join(settlementsDir, `${safe(settlementId)}.json`);
  const lockPath = (jobId: string) => join(locksDir, `${safe(jobId)}.lock`);
  const reclaimPath = (jobId: string) => join(locksDir, `${safe(jobId)}.reclaim`);
  const reclaimQuarantinePrefix = (jobId: string) => {
    const encoded = safe(jobId);
    return `reclaim-${encoded.length}-${encoded}.`;
  };
  const reclaimQuarantinePath = (jobId: string) =>
    join(locksDir, `${reclaimQuarantinePrefix(jobId)}${randomUUID()}.quarantine`);

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

  async function unlinkIfExists(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
    if (parsed.storeVersion !== FENCED_SESSION_STORE_VERSION) {
      return { status: "unsupported", version: parsed.storeVersion };
    }
    // Validate the COMPLETE nested shape: corrupt checkpoint/receipt/lease entries
    // must never load as `ok` and crash a later money-path mutation.
    const bad = sessionRecordShapeViolation(parsed);
    if (bad) return { status: "corrupt", reason: bad };
    const record = parsed as SessionRecord;
    if (record.jobId !== jobId) {
      return {
        status: "corrupt",
        reason: `session filename belongs to ${jobId}, but record belongs to ${record.jobId}`,
      };
    }
    return { status: "ok", record };
  }

  interface LockOwner {
    pid: number;
    token: string;
  }

  async function readLockOwner(lp: string): Promise<LockOwner | null> {
    try {
      const parsed = JSON.parse(await readFile(lp, "utf8")) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "pid" in parsed &&
        Number.isSafeInteger(parsed.pid) &&
        (parsed.pid as number) > 0 &&
        "token" in parsed &&
        isNonEmpty(parsed.token)
      ) {
        return { pid: parsed.pid as number, token: parsed.token };
      }
    } catch {
      // An empty/malformed lock can be reclaimed only after the stale window.
    }
    return null;
  }

  function processIsAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM still proves that the process exists. Only ESRCH proves death.
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  const sameLockOwner = (left: LockOwner | null, right: LockOwner | null): boolean =>
    left === null
      ? right === null
      : right !== null && left.pid === right.pid && left.token === right.token;

  async function reclaimQuarantines(jobId: string): Promise<string[]> {
    const prefix = reclaimQuarantinePrefix(jobId);
    const names = (await readdir(locksDir)).filter(
      (name) => name.startsWith(prefix) && name.endsWith(".quarantine"),
    );
    const live: string[] = [];
    for (const name of names) {
      const path = join(locksDir, name);
      try {
        const metadata = await stat(path);
        const owner = await readLockOwner(path);
        if (
          Date.now() - metadata.mtimeMs <= lockStaleMs ||
          (owner !== null && processIsAlive(owner.pid))
        ) {
          live.push(path);
          continue;
        }
        // Quarantine names contain a UUID and are never reused, so deleting a
        // dead quarantine cannot target a replacement at the canonical path.
        await unlinkIfExists(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return live;
  }

  async function quarantineStaleReclaimGate(jobId: string): Promise<void> {
    const rp = reclaimPath(jobId);
    let observed;
    try {
      observed = await stat(rp);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (Date.now() - observed.mtimeMs <= lockStaleMs) return;
    const observedOwner = await readLockOwner(rp);
    if (observedOwner !== null && processIsAlive(observedOwner.pid)) return;

    const quarantine = reclaimQuarantinePath(jobId);
    try {
      // Rename, rather than unlink, atomically removes one observed gate into a
      // unique namespace that all gate contenders treat as still authoritative.
      await rename(rp, quarantine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let moved;
    try {
      moved = await stat(quarantine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const movedOwner = await readLockOwner(quarantine);
    if (
      moved.dev === observed.dev &&
      moved.ino === observed.ino &&
      sameLockOwner(movedOwner, observedOwner) &&
      Date.now() - moved.mtimeMs > lockStaleMs &&
      (movedOwner === null || !processIsAlive(movedOwner.pid))
    ) {
      await unlinkIfExists(quarantine);
    }
    // If a replacement was moved, leave its unique quarantine in place. It
    // continues to block other reclaimers and its live owner removes it below.
  }

  async function releaseReclaimGate(jobId: string, token: string): Promise<void> {
    const rp = reclaimPath(jobId);
    const owner = await readLockOwner(rp);
    if (owner?.pid === process.pid && owner.token === token) {
      const quarantine = reclaimQuarantinePath(jobId);
      try {
        await rename(rp, quarantine);
        const movedOwner = await readLockOwner(quarantine);
        if (movedOwner?.pid === process.pid && movedOwner.token === token) {
          await unlinkIfExists(quarantine);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    // A concurrent stale-gate recovery may already have moved our gate. Unique
    // quarantine paths are safe to inspect and conditionally remove by token.
    const prefix = reclaimQuarantinePrefix(jobId);
    for (const name of (await readdir(locksDir)).filter(
      (item) => item.startsWith(prefix) && item.endsWith(".quarantine"),
    )) {
      const path = join(locksDir, name);
      const quarantinedOwner = await readLockOwner(path);
      if (
        quarantinedOwner?.pid === process.pid &&
        quarantinedOwner.token === token
      ) {
        await unlinkIfExists(path);
      }
    }
  }

  async function acquireReclaimGate(jobId: string, token: string): Promise<boolean> {
    if ((await reclaimQuarantines(jobId)).length > 0) return false;
    try {
      await exclusiveWriteJson(reclaimPath(jobId), { pid: process.pid, token });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await quarantineStaleReclaimGate(jobId);
      return false;
    }
    if ((await reclaimQuarantines(jobId)).length > 0) {
      await releaseReclaimGate(jobId, token);
      return false;
    }
    return true;
  }

  /**
   * Reclaim only a lock whose owner is provably dead (or whose crash left no
   * readable owner after the stale window). Age alone is not proof of death: a
   * paused live writer must retain exclusion or it could overwrite a successor.
   */
  async function reclaimIfStale(jobId: string, lp: string): Promise<void> {
    // Safe read-only fast path: only a candidate that is both old and lacks a
    // provably live owner needs the heavier cross-process reclamation protocol.
    // These observations never authorize deletion; every destructive decision
    // is repeated after acquiring the gate below.
    try {
      const candidate = await stat(lp);
      if (Date.now() - candidate.mtimeMs <= lockStaleMs) return;
      const candidateOwner = await readLockOwner(lp);
      if (candidateOwner !== null && processIsAlive(candidateOwner.pid)) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    const reclaimToken = randomUUID();
    if (!await acquireReclaimGate(jobId, reclaimToken)) return;
    try {
      let observed;
      try {
        observed = await stat(lp);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (Date.now() - observed.mtimeMs <= lockStaleMs) return;
      const observedOwner = await readLockOwner(lp);
      if (observedOwner && processIsAlive(observedOwner.pid)) return;

      let current;
      try {
        current = await stat(lp);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const currentOwner = await readLockOwner(lp);
      if (
        current.dev !== observed.dev ||
        current.ino !== observed.ino ||
        !sameLockOwner(currentOwner, observedOwner) ||
        Date.now() - current.mtimeMs <= lockStaleMs ||
        (currentOwner !== null && processIsAlive(currentOwner.pid))
      ) {
        return;
      }
      await unlink(lp).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    } finally {
      await releaseReclaimGate(jobId, reclaimToken);
    }
  }

  /** Serialise a read-modify-write for one session via an exclusive lock file. */
  async function withLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
    const lp = lockPath(jobId);
    const token = randomUUID();
    for (let i = 0; ; i++) {
      try {
        // Publish complete ownership metadata as the same atomic hard-link used
        // by other no-overwrite bindings. There is no visible empty-lock window.
        await exclusiveWriteJson(lp, { pid: process.pid, token });
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        // A hard-crashed holder can never release its lock; reclaim it only once
        // stale and no live owner can be established (#67).
        await reclaimIfStale(jobId, lp);
        if (i >= LOCK_MAX_RETRIES) {
          throw new DacsError(`session ${jobId} lock is contended (timed out)`);
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
    try {
      return await fn();
    } finally {
      // Never delete a replacement lock if ownership somehow changed while this
      // holder was unwinding (for example after external administrative cleanup).
      const owner = await readLockOwner(lp);
      if (owner?.token === token) await unlink(lp).catch(() => {});
    }
  }

  const readHashBinding = async (
    hash: string,
  ): Promise<
    | { status: "missing" }
    | { status: "ok"; jobId: string; kind: "agreement" | "transaction" }
  > => {
    let existing: { jobId?: unknown; kind?: unknown };
    try {
      existing = JSON.parse(await readFile(hashPath(hash), "utf8")) as {
        jobId?: unknown;
        kind?: unknown;
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { status: "missing" };
      }
      throw new DacsError(`hash binding ${hash} is corrupt; refusing to reclaim it`);
    }
    if (
      typeof existing.jobId !== "string" ||
      (existing.kind !== "agreement" && existing.kind !== "transaction")
    ) {
      throw new DacsError(`hash binding ${hash} has an invalid shape; refusing to reclaim it`);
    }
    return {
      status: "ok",
      jobId: existing.jobId,
      kind: existing.kind,
    };
  };

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
      const existing = await readHashBinding(hash);
      if (existing.status === "missing") {
        throw new DacsError(`hash binding ${hash} disappeared during no-overwrite commit`);
      }
      if (existing.jobId === jobId && existing.kind === kind) {
        return { ok: true, boundTo: jobId }; // idempotent for the same session
      }
      return { ok: false, boundTo: existing.jobId }; // replay across sessions
    }
  };

  type SettlementOwner = {
    jobId: string;
    binding: SessionPaymentAuthorizationBinding;
  };

  const readSettlementBinding = async (
    settlementId: string,
  ): Promise<
    | { status: "missing" }
    | { status: "ok"; owner: SettlementOwner }
  > => {
    let existing: Record<string, unknown>;
    try {
      existing = JSON.parse(
        await readFile(settlementPath(settlementId), "utf8"),
      ) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { status: "missing" };
      }
      throw new DacsError(
        `settlement binding ${settlementId} is corrupt; refusing to reclaim it`,
      );
    }
    if (
      !isNonEmpty(existing.jobId) ||
      typeof existing.binding !== "object" ||
      existing.binding === null ||
      Array.isArray(existing.binding)
    ) {
      throw new DacsError(
        `settlement binding ${settlementId} has an invalid shape; refusing to reclaim it`,
      );
    }
    try {
      assertSessionPaymentAuthorizationShape(
        existing.binding as SessionPaymentAuthorizationBinding,
      );
    } catch {
      throw new DacsError(
        `settlement binding ${settlementId} has an invalid authorization; refusing to reclaim it`,
      );
    }
    const binding = existing.binding as SessionPaymentAuthorizationBinding;
    if (binding.settlementId !== settlementId) {
      throw new DacsError(
        `settlement binding ${settlementId} contains another settlement identity; ` +
          "refusing to reclaim it",
      );
    }
    return {
      status: "ok",
      owner: {
        jobId: existing.jobId,
        binding,
      },
    };
  };

  const bindSettlementImpl = async (
    settlementId: string,
    owner: SettlementOwner,
  ): Promise<{ ok: boolean; boundTo?: string }> => {
    try {
      await exclusiveWriteJson(settlementPath(settlementId), owner);
      return { ok: true, boundTo: owner.jobId };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readSettlementBinding(settlementId);
      if (existing.status === "missing") {
        throw new DacsError(
          `settlement binding ${settlementId} disappeared during no-overwrite commit`,
        );
      }
      const matches =
        existing.owner.jobId === owner.jobId &&
        samePaymentBinding(existing.owner.binding, owner.binding);
      return {
        ok: matches,
        boundTo: existing.owner.jobId,
      };
    }
  };

  interface PersistedOwnershipRecord {
    storeVersion: number;
    jobId: string;
    agreementHash?: string;
    paymentAuthorizations?: SessionPaymentAuthorizationBinding[];
  }

  /**
   * Read every session whose ownership might have outlived a missing atomic
   * marker. No entry may be skipped: an unreadable, unsupported, malformed, or
   * path-confused record makes anti-replay ownership unknowable and fails closed.
   */
  async function readOwnershipRecords(): Promise<PersistedOwnershipRecord[]> {
    const files = (await readdir(sessionsDir)).filter(
      (f) => f.endsWith(".json") && !f.endsWith(".tmp"),
    );
    const records: PersistedOwnershipRecord[] = [];
    for (const file of files) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(join(sessionsDir, file), "utf8")) as unknown;
      } catch (error) {
        throw new DacsError(
          `session file ${file} cannot be safely inspected for agreement ownership: ${String(error)}`,
        );
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        !("storeVersion" in parsed) ||
        typeof parsed.storeVersion !== "number"
      ) {
        throw new DacsError(
          `session file ${file} has an invalid version envelope; ` +
            "agreement ownership cannot be safely inspected",
        );
      }
      const violation = parsed.storeVersion === SESSION_STORE_VERSION
        ? legacySessionRecordShapeViolation(parsed)
        : parsed.storeVersion === FENCED_SESSION_STORE_VERSION
          ? sessionRecordShapeViolation(parsed)
          : null;
      if (
        parsed.storeVersion !== SESSION_STORE_VERSION &&
        parsed.storeVersion !== FENCED_SESSION_STORE_VERSION
      ) {
        throw new DacsError(
          `session file ${file} uses unsupported storeVersion ${parsed.storeVersion}; ` +
            "agreement ownership cannot be safely inspected",
        );
      }
      if (violation !== null) {
        throw new DacsError(
          `session file ${file} has an invalid v${parsed.storeVersion} shape: ${violation}; ` +
            "agreement ownership cannot be safely inspected",
        );
      }
      const record = parsed as unknown as PersistedOwnershipRecord;
      if (file !== `${safe(record.jobId)}.json`) {
        throw new DacsError(
          `session file ${file} belongs to another job path; ` +
            "agreement ownership cannot be safely inspected",
        );
      }
      records.push(record);
    }
    return records;
  }

  /**
   * Find any session-generation claim left between the session and hash commits.
   * A v1 owner is deliberately not upgraded, but its agreement ownership remains
   * authoritative: otherwise opening the same directory with the v2 store could
   * steal an anti-replay identity from a legacy crash residue.
   */
  async function findUnboundAgreementOwner(
    agreementHash: string,
    exceptJobId: string,
  ): Promise<string | undefined> {
    const candidates = new Set<string>();
    for (const record of await readOwnershipRecords()) {
      if (record.agreementHash === agreementHash) {
        candidates.add(record.jobId);
      }
    }
    if (candidates.size > 1) {
      throw new DacsError(
        `agreement ${agreementHash} has conflicting session owners: ` +
          [...candidates].sort().join(", "),
      );
    }
    const owner = candidates.values().next().value as string | undefined;
    return owner === exceptJobId ? undefined : owner;
  }

  /**
   * Claim an agreement for an authorization only after recovering any session-
   * first residue. The hash marker is the atomic cross-process arbiter: concurrent
   * contenders either publish the recovered owner or observe the marker winner.
   */
  async function bindAuthorizationAgreement(
    agreementHash: string,
    jobId: string,
  ): Promise<{ ok: boolean; boundTo?: string }> {
    const marker = await readHashBinding(agreementHash);
    if (marker.status === "ok") {
      return {
        ok: marker.jobId === jobId && marker.kind === "agreement",
        boundTo: marker.jobId,
      };
    }
    const recoverableOwner = await findUnboundAgreementOwner(agreementHash, jobId);
    if (recoverableOwner) {
      await bindHashImpl(
        agreementHash,
        recoverableOwner,
        "agreement",
      );
      // The no-overwrite marker remains the arbiter if another process commits
      // between the initial read and residue recovery. In particular, a marker
      // already won by this job makes its retry idempotently successful.
      const winner = await readHashBinding(agreementHash);
      if (winner.status === "missing") {
        throw new DacsError(
          `agreement binding ${agreementHash} disappeared during residue recovery`,
        );
      }
      return {
        ok: winner.jobId === jobId && winner.kind === "agreement",
        boundTo: winner.jobId,
      };
    }
    return bindHashImpl(agreementHash, jobId, "agreement");
  }

  async function findUnboundSettlementOwner(
    settlementId: string,
  ): Promise<SettlementOwner | undefined> {
    const candidates: SettlementOwner[] = [];
    for (const record of await readOwnershipRecords()) {
      if (record.storeVersion !== FENCED_SESSION_STORE_VERSION) continue;
      const binding = record.paymentAuthorizations?.find(
        (authorization) => authorization.settlementId === settlementId,
      );
      if (binding) candidates.push({ jobId: record.jobId, binding });
    }
    if (candidates.length > 1) {
      throw new DacsError(
        `settlement ${settlementId} has conflicting session owners: ` +
          candidates.map((candidate) => candidate.jobId).sort().join(", "),
      );
    }
    return candidates[0];
  }

  /**
   * Treat the no-overwrite settlement marker as arbiter, but reconstruct it from
   * the exact validated v2 session row after independent marker loss. This keeps
   * a later job from stealing a canonical settlement during recovery.
   */
  async function bindAuthorizationSettlement(
    owner: SettlementOwner,
  ): Promise<{ ok: boolean; boundTo?: string }> {
    const settlementId = owner.binding.settlementId;
    const marker = await readSettlementBinding(settlementId);
    if (marker.status === "ok") {
      return {
        ok: marker.owner.jobId === owner.jobId &&
          samePaymentBinding(marker.owner.binding, owner.binding),
        boundTo: marker.owner.jobId,
      };
    }
    const recoverableOwner = await findUnboundSettlementOwner(settlementId);
    if (recoverableOwner) {
      await bindSettlementImpl(settlementId, recoverableOwner);
      const winner = await readSettlementBinding(settlementId);
      if (winner.status === "missing") {
        throw new DacsError(
          `settlement binding ${settlementId} disappeared during residue recovery`,
        );
      }
      return {
        ok: winner.owner.jobId === owner.jobId &&
          samePaymentBinding(winner.owner.binding, owner.binding),
        boundTo: winner.owner.jobId,
      };
    }
    return bindSettlementImpl(settlementId, owner);
  }

  return {
    apiVersion: FENCED_SESSION_STORE_VERSION,
    async create(rawInput) {
      const input = snapshotFencedCreateInput(rawInput);
      const jobId = input.jobId;
      const agreementHash = input.agreementHash;
      const phase = input.phase ?? "created";
      const now = input.now ?? Date.now();
      const record: SessionRecord = {
        storeVersion: FENCED_SESSION_STORE_VERSION,
        jobId,
        ...(agreementHash === undefined ? {} : { agreementHash }),
        phase,
        revision: 0,
        leaseGeneration: 0,
        paymentAuthorizations: [],
        checkpoints: [],
        receipts: [],
        createdAt: now,
        updatedAt: now,
      };
      const violation = sessionRecordShapeViolation(record);
      if (violation) throw new DacsError(`invalid session record: ${violation}`);
      return withLock(jobId, async () => {
        // Reject a duplicate jobId before starting the transaction. The exclusive
        // session publish below remains the arbiter for a concurrent duplicate.
        if ((await readSession(jobId)).status !== "missing") {
          throw new DacsError(`session ${jobId} already exists`);
        }

        // Recover a crash after another creator committed its session but before it
        // committed the hash. Crucially, there is no binding-before-session window:
        // a live creator's ownership can never be mistaken for an orphan and stolen.
        if (agreementHash) {
          const marker = await readHashBinding(agreementHash);
          if (marker.status === "ok") {
            if (marker.jobId !== jobId || marker.kind !== "agreement") {
              throw new DacsError(
                `agreement hash is already bound to session ${marker.jobId} ` +
                  `(anti-replay); cannot create ${jobId}`,
              );
            }
          } else {
            const recoverableOwner = await findUnboundAgreementOwner(
              agreementHash,
              jobId,
            );
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
      });
    },

    load(rawJobId) {
      const jobId = snapshotFencedJobId(rawJobId);
      return readSession(jobId);
    },

    async transition(rawInput: TransitionInput): Promise<TransitionResult> {
      const input = snapshotFencedTransitionInput(rawInput);
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
        if (sessionPhaseIsTerminal(record.phase)) {
          return { ok: false, reason: "terminal-state", record };
        }
        const now = input.now ?? Date.now();
        const leaseProblem = leaseFailure(record, input.leaseToken, now);
        if (leaseProblem) return { ok: false, reason: leaseProblem, record };
        const releasesOnly =
          input.lease === null &&
          input.phase === undefined &&
          input.checkpoint === undefined &&
          input.receipt === undefined;
        const phaseProblem = releasesOnly
          ? null
          : sessionPhaseMutationFailure(record, input.phase);
        if (phaseProblem) return { ok: false, reason: phaseProblem, record };
        if (
          record.phase === "seller:failed" &&
          !releasesOnly &&
          (input.phase !== "terminal:seller:authority" ||
            input.receipt !== undefined ||
            input.checkpoint?.key !== "terminal:seller:authority")
        ) {
          return { ok: false, reason: "phase-regression", record };
        }
        const sealProblem = terminalBundleSealMutationFailure(record, input);
        if (sealProblem) return { ok: false, reason: sealProblem, record };
        if (input.checkpoint) {
          assertCheckpointPayloadShape(input.checkpoint);
          if (!validCheckpointAppend(record, input.checkpoint)) {
            return { ok: false, reason: "checkpoint-state", record };
          }
        }
        if (input.receipt) assertSessionReceiptShape(input.receipt);
        if (input.receipt) {
          const key = sessionReceiptKey(input.receipt);
          const prior = record.receipts.find(
            (receipt) => sessionReceiptKey(receipt) === key,
          );
          if (prior && prior.ref !== input.receipt.ref) {
            return { ok: false, reason: "immutable-receipt", record };
          }
        }
        record.revision += 1;
        record.updatedAt = now;
        if (input.phase !== undefined) record.phase = input.phase;
        if (input.checkpoint) record.checkpoints.push(input.checkpoint);
        if (input.receipt) {
          const key = sessionReceiptKey(input.receipt);
          const exists = record.receipts.some(
            (receipt) => sessionReceiptKey(receipt) === key,
          );
          if (!exists) record.receipts.push({ recordedAt: now, ...input.receipt });
        }
        if (input.lease === null) delete record.lease;
        const violation = sessionRecordShapeViolation(record);
        if (violation) throw new DacsError(`invalid session transition: ${violation}`);
        await atomicWriteJson(sessionPath(input.jobId), record);
        return { ok: true, record };
      });
    },

    async claimCheckpoint(
      rawInput: CheckpointClaimInput,
    ): Promise<CheckpointClaimResult> {
      const input = snapshotFencedCheckpointClaimInput(rawInput);
      return withLock(input.jobId, async () => {
        const loaded = await readSession(input.jobId);
        if (loaded.status === "missing") return { ok: false, reason: "not-found" };
        if (loaded.status === "corrupt") return { ok: false, reason: "corrupt" };
        if (loaded.status === "unsupported") return { ok: false, reason: "unsupported" };
        const record = loaded.record;
        if (sessionPhaseIsTerminal(record.phase)) {
          return { ok: false, reason: "terminal-state", record };
        }
        const now = input.now ?? Date.now();
        const leaseProblem = leaseFailure(record, input.leaseToken, now);
        if (leaseProblem) return { ok: false, reason: leaseProblem, record };
        const prior = [...record.checkpoints].reverse().find((cp) => cp.key === input.key);
        if (prior) {
          return {
            ok: false,
            reason: prior.stage === "outcome" ? "completed" : "held",
            record,
          };
        }
        const phaseProblem = sessionPhaseMutationFailure(record, input.phase);
        if (phaseProblem) return { ok: false, reason: phaseProblem, record };
        if (
          record.phase === "seller:failed" &&
          (input.phase !== "terminal:seller:authority" ||
            input.key !== "terminal:seller:authority")
        ) {
          return { ok: false, reason: "phase-regression", record };
        }
        if (input.phase?.startsWith("terminal:") && input.phase.endsWith(":finalised")) {
          return { ok: false, reason: "phase-regression", record };
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

    async acquireLease(rawInput): Promise<LeaseResult> {
      const input = snapshotFencedAcquireLeaseInput(rawInput);
      const jobId = input.jobId;
      const owner = input.owner;
      const ttlMs = input.ttlMs;
      const sellerPhaseIndex = input.sellerPhaseIndex;
      const now = input.now ?? Date.now();
      const leaseOwner = owner;
      const leasePhaseIndex = sellerPhaseIndex;
      assertPositiveTtl(ttlMs);
      if (!isNonEmpty(leaseOwner)) throw new DacsError("lease owner must be non-empty");
      if (
        leasePhaseIndex !== undefined &&
        (!Number.isSafeInteger(leasePhaseIndex) || leasePhaseIndex < 0)
      ) {
        throw new DacsError("sellerPhaseIndex must be a non-negative safe integer");
      }
      return withLock(jobId, async (): Promise<LeaseResult> => {
        const loaded = await readSession(jobId);
        if (loaded.status === "missing") return { ok: false, reason: "not-found" };
        if (loaded.status === "corrupt") return { ok: false, reason: "corrupt" };
        if (loaded.status === "unsupported") return { ok: false, reason: "unsupported" };
        const record = loaded.record;
        if (sessionPhaseIsTerminal(record.phase)) {
          return { ok: false, reason: "terminal-state", record };
        }
        if (record.lease && record.lease.expiresAt > now) {
          return { ok: false, reason: "lease-held", record };
        }
        const scopeProblem = sessionLeaseScopeFailure(record, leasePhaseIndex);
        if (scopeProblem) return { ok: false, reason: scopeProblem, record };
        record.revision += 1;
        record.updatedAt = now;
        record.leaseGeneration += 1;
        record.lease = {
          owner: leaseOwner,
          generation: record.leaseGeneration,
          expiresAt: now + ttlMs,
          ...(leasePhaseIndex === undefined ? {} : { sellerPhaseIndex: leasePhaseIndex }),
        };
        const violation = sessionRecordShapeViolation(record);
        if (violation) throw new DacsError(`invalid lease: ${violation}`);
        await atomicWriteJson(sessionPath(jobId), record);
        return { ok: true, record, lease: { ...record.lease } };
      });
    },

    async renewLease(rawInput): Promise<LeaseResult> {
      const input = snapshotFencedRenewLeaseInput(rawInput);
      const jobId = input.jobId;
      const leaseToken = input.leaseToken;
      const ttlMs = input.ttlMs;
      const now = input.now ?? Date.now();
      assertPositiveTtl(ttlMs);
      return withLock(jobId, async (): Promise<LeaseResult> => {
        const loaded = await readSession(jobId);
        if (loaded.status === "missing") return { ok: false, reason: "not-found" };
        if (loaded.status === "corrupt") return { ok: false, reason: "corrupt" };
        if (loaded.status === "unsupported") return { ok: false, reason: "unsupported" };
        const record = loaded.record;
        if (sessionPhaseIsTerminal(record.phase)) {
          return { ok: false, reason: "terminal-state", record };
        }
        const problem = leaseFailure(record, leaseToken, now);
        if (problem) return { ok: false, reason: problem, record };
        record.revision += 1;
        record.updatedAt = now;
        record.lease!.expiresAt = now + ttlMs;
        const violation = sessionRecordShapeViolation(record);
        if (violation) throw new DacsError(`invalid renewed lease: ${violation}`);
        await atomicWriteJson(sessionPath(jobId), record);
        return { ok: true, record, lease: { ...record.lease! } };
      });
    },

    async bindSessionAuthorization(rawInput): Promise<SessionAuthorizationBindingResult> {
      const input = snapshotFencedAuthorizationInput(rawInput);
      const jobId = input.jobId;
      const binding = input.binding;
      const leaseToken = input.leaseToken;
      const now = input.now ?? Date.now();
      assertSessionPaymentAuthorizationShape(binding);
      return withLock(jobId, async (): Promise<SessionAuthorizationBindingResult> => {
        const loaded = await readSession(jobId);
        if (loaded.status === "missing") return { ok: false, reason: "not-found" };
        if (loaded.status === "corrupt") return { ok: false, reason: "corrupt" };
        if (loaded.status === "unsupported") return { ok: false, reason: "unsupported" };
        const record = loaded.record;
        if (record.agreementHash !== undefined && record.agreementHash !== binding.agreementHash) {
          return { ok: false, reason: "agreement-conflict", record };
        }
        const phaseBinding = record.paymentAuthorizations.find(
          (item) => item.paymentPhaseIndex === binding.paymentPhaseIndex ||
            item.deliveryPhaseIndex === binding.deliveryPhaseIndex,
        );
        if (phaseBinding && samePaymentBinding(phaseBinding, binding)) {
          const agreement = await bindAuthorizationAgreement(
            binding.agreementHash,
            jobId,
          );
          if (!agreement.ok) {
            return {
              ok: false,
              reason: "agreement-conflict",
              boundTo: agreement.boundTo,
              record,
            };
          }
          const settlement = await bindAuthorizationSettlement({
            jobId,
            binding,
          });
          if (!settlement.ok) {
            return {
              ok: false,
              reason: "settlement-replay",
              boundTo: settlement.boundTo,
              record,
            };
          }
          return { ok: true, record };
        }
        if (sessionPhaseIsTerminal(record.phase)) {
          return { ok: false, reason: "terminal-state", record };
        }
        if (!record.lease) {
          return { ok: false, reason: "lease-fenced", record };
        }
        const leaseProblem = leaseFailure(record, leaseToken, now);
        if (leaseProblem) return { ok: false, reason: leaseProblem, record };
        const phaseProblem = sessionAuthorizationPhaseFailure(record);
        if (phaseProblem) return { ok: false, reason: phaseProblem, record };
        if (phaseBinding !== undefined && !samePaymentBinding(phaseBinding, binding)) {
          return { ok: false, reason: "payment-conflict", record };
        }

        // Each no-overwrite file is a fail-closed commit marker. A crash between
        // either marker and the session update leaves ownership with this job;
        // the same invocation can finish the record on restart, while a different
        // job can never steal the agreement or settlement.
        const agreement = await bindAuthorizationAgreement(
          binding.agreementHash,
          jobId,
        );
        if (!agreement.ok) {
          return {
            ok: false,
            reason: "agreement-conflict",
            boundTo: agreement.boundTo,
            record,
          };
        }
        if (record.agreementHash === undefined) {
          record.agreementHash = binding.agreementHash;
          record.revision += 1;
          record.updatedAt = now;
          const agreementViolation = sessionRecordShapeViolation(record);
          if (agreementViolation) {
            throw new DacsError(
              `invalid set-once agreement binding: ${agreementViolation}`,
            );
          }
          await atomicWriteJson(sessionPath(jobId), record);
        }
        const settlement = await bindAuthorizationSettlement({
          jobId,
          binding,
        });
        if (!settlement.ok) {
          return {
            ok: false,
            reason: "settlement-replay",
            boundTo: settlement.boundTo,
            record,
          };
        }
        record.paymentAuthorizations.push(structuredClone(binding));
        record.revision += 1;
        record.updatedAt = now;
        const violation = sessionRecordShapeViolation(record);
        if (violation) throw new DacsError(`invalid session authorization: ${violation}`);
        await atomicWriteJson(sessionPath(jobId), record);
        return { ok: true, record };
      });
    },

    async bindHash(rawInput) {
      const { hash, jobId, kind } = snapshotFencedBindHashInput(rawInput);
      return withLock(jobId, async () => {
        const loaded = await readSession(jobId);
        if (loaded.status === "corrupt" || loaded.status === "unsupported") {
          throw new DacsError(
            `session ${jobId} is ${loaded.status}; refusing hash binding`,
          );
        }
        if (
          kind === "agreement" &&
          loaded.status === "ok" &&
          sessionPhaseIsTerminal(loaded.record.phase)
        ) {
          return loaded.record.agreementHash === hash
            ? bindAuthorizationAgreement(hash, jobId)
            : { ok: false, boundTo: jobId };
        }
        if (
          kind === "agreement" &&
          loaded.status === "ok" &&
          loaded.record.agreementHash !== undefined &&
          loaded.record.agreementHash !== hash
        ) {
          return { ok: false, boundTo: jobId };
        }
        if (
          kind === "agreement" &&
          loaded.status === "ok" &&
          loaded.record.agreementHash === undefined &&
          loaded.record.leaseGeneration > 0
        ) {
          return { ok: false, boundTo: jobId };
        }
        if (
          kind === "agreement" &&
          loaded.status === "ok" &&
          loaded.record.agreementHash === hash
        ) {
          return bindAuthorizationAgreement(hash, jobId);
        }
        if (loaded.status === "ok" && loaded.record.leaseGeneration > 0) {
          const existing = await readHashBinding(hash);
          return existing.status === "ok" &&
              existing.jobId === jobId &&
              existing.kind === kind
            ? { ok: true, boundTo: jobId }
            : {
                ok: false,
                boundTo: existing.status === "ok" ? existing.jobId : jobId,
              };
        }
        const bound = kind === "agreement"
          ? await bindAuthorizationAgreement(hash, jobId)
          : await bindHashImpl(hash, jobId, kind);
        if (
          kind !== "agreement" ||
          !bound.ok ||
          loaded.status !== "ok" ||
          loaded.record.agreementHash !== undefined
        ) {
          return bound;
        }
        loaded.record.agreementHash = hash;
        loaded.record.revision += 1;
        loaded.record.updatedAt = Date.now();
        const violation = sessionRecordShapeViolation(loaded.record);
        if (violation) throw new DacsError(`invalid agreement binding: ${violation}`);
        await atomicWriteJson(sessionPath(jobId), loaded.record);
        return bound;
      });
    },

    async list(rawFilter) {
      const filter = snapshotFencedListFilter(rawFilter);
      const files = (await readdir(sessionsDir)).filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"));
      const records: SessionRecord[] = [];
      for (const f of files) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readFile(join(sessionsDir, f), "utf8")) as unknown;
        } catch (error) {
          throw new DacsError(
            `session file ${f} cannot be safely listed: ${String(error)}`,
          );
        }
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          !("storeVersion" in parsed) ||
          typeof parsed.storeVersion !== "number"
        ) {
          throw new DacsError(`session file ${f} has an invalid version envelope`);
        }
        if (parsed.storeVersion !== FENCED_SESSION_STORE_VERSION) {
          throw new DacsError(
            `session file ${f} uses unsupported storeVersion ${parsed.storeVersion}`,
          );
        }
        const violation = sessionRecordShapeViolation(parsed);
        if (violation !== null) {
          throw new DacsError(`session file ${f} has an invalid shape: ${violation}`);
        }
        const record = parsed as SessionRecord;
        if (f !== `${safe(record.jobId)}.json`) {
          throw new DacsError(
            `session file ${f} belongs to another job path (${record.jobId})`,
          );
        }
        records.push(record);
      }
      let out = records;
      if (filter?.phase !== undefined) out = out.filter((r) => r.phase === filter.phase);
      out.sort(compareFencedSessionRecords);
      if (filter?.limit !== undefined) out = out.slice(0, filter.limit);
      return structuredClone(out);
    },
  };
}

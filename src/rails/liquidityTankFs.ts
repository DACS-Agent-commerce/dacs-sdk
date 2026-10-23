import { registerProductionTankStore } from "./liquidityTankCapabilities.js";
import { randomUUID } from "node:crypto";
import { constants, readFileSync, readlinkSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { types as nodeTypes } from "node:util";

import { sha256Hex } from "../canonical/index.js";
import { DacsError } from "../errors.js";
import {
  atomicWritePrivateFile,
  completeExclusivePublication,
  exclusiveWritePrivateFile,
  preparePrivateStoreDirectory,
  readPrivateFile,
} from "../filesystem/privateStore.js";
import {
  assertLiquidityTankRecord,
  liquidityTankRecordTransitions as transitions,
  type LiquidityTankRecord,
  type LiquidityTankRecordTransition,
  type LiquidityTankStore,
} from "./liquidityTank.js";

/** On-disk schema version of the filesystem liquidity-tank store. */
export const LIQUIDITY_TANK_FS_STORE_VERSION = 1 as const;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_POLL_MS = 5;
const LABEL = "liquidity-tank filesystem store";
const RECORD_FIELDS = new Set([
  "storeVersion",
  "intent",
  "lease",
  "submission",
  "submissionRecordedAt",
  "observation",
  "recoveryFailure",
  "recoveryExpired",
  "settlement",
]);

export interface FsLiquidityTankStoreOptions {
  /** Directory used only by this store, on a local filesystem. */
  dir: string;
  /** Maximum time spent waiting for another process. Defaults to 5 seconds. */
  lockTimeoutMs?: number;
  /**
   * Age at which a lock whose owner cannot still hold it (a dead process, an
   * earlier process with this PID, or an exited thread of this process) may be
   * reclaimed. Defaults to 30 seconds.
   */
  lockStaleMs?: number;
  /** Contention polling interval. Defaults to 5 milliseconds. */
  lockPollMs?: number;
}

type StoredRecord = LiquidityTankRecord & { storeVersion: typeof LIQUIDITY_TANK_FS_STORE_VERSION };

interface LockOwner {
  pid: number;
  /** The OS thread that made the lock, or `null` where it cannot be read. */
  tid: number | null;
  /** The boot and PID namespace `pid` and `tid` belong to, or `null` where unreadable. */
  pidScope: string | null;
  /** The making thread's `LockRegistry.threadToken`. */
  threadToken: string;
  /** This lock's own token. */
  token: string;
  /** `process.hrtime.bigint()` when the lock was made, in decimal. */
  createdNs: string;
}

/**
 * The lock state of one JavaScript thread, shared by every copy of this module
 * on it. Every lock the thread publishes carries `threadToken`, and `held`
 * names the ones it holds now: one of its locks that it does not hold was left
 * by a failed release, and nothing holds it.
 */
interface LockRegistry {
  readonly threadToken: string;
  readonly held: Set<string>;
  readonly tid: number | null;
  readonly pidScope: string | null;
}

/**
 * Kept on `process`, which is one object per thread: the main thread and each
 * worker thread have their own, and every module copy on a thread sees the
 * same one. So a module copy never takes a lock another copy on its thread
 * holds, and a lock is told apart from another thread's by `threadToken`.
 */
const LOCK_REGISTRY = Symbol.for("@kynesyslabs/dacs/liquidity-tank-fs/lock-registry/v1");

/**
 * This thread's OS thread ID and the boot and PID namespace it belongs to,
 * read synchronously so `/proc/thread-self` names this thread. Both are `null`
 * where `/proc` cannot tell them (not Linux, or `/proc` from another PID
 * namespace); another thread can then never prove this one has exited.
 */
function threadIdentity(): { tid: number | null; pidScope: string | null } {
  try {
    const self = /^([0-9]+)\/task\/([0-9]+)$/u.exec(readlinkSync("/proc/thread-self"));
    if (self === null || Number(self[1]) !== process.pid) return { tid: null, pidScope: null };
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const pidNamespace = readlinkSync("/proc/self/ns/pid");
    const tid = Number(self[2]);
    if (!Number.isSafeInteger(tid) || tid <= 0 || bootId.length === 0 || pidNamespace.length === 0) {
      return { tid: null, pidScope: null };
    }
    return { tid, pidScope: `${bootId} ${pidNamespace}` };
  } catch {
    return { tid: null, pidScope: null };
  }
}

function isLockRegistry(value: unknown): value is LockRegistry {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) return false;
  const registry = value as Partial<Record<keyof LockRegistry, unknown>>;
  return typeof registry.threadToken === "string" && registry.threadToken.length > 0 &&
    nodeTypes.isSet(registry.held) &&
    (registry.tid === null || (Number.isSafeInteger(registry.tid) && (registry.tid as number) > 0)) &&
    (registry.pidScope === null || (typeof registry.pidScope === "string" && registry.pidScope.length > 0));
}

/** This thread's registry, made by the first store on the thread. */
function threadLockRegistry(): LockRegistry {
  const existing = (process as unknown as Record<symbol, unknown>)[LOCK_REGISTRY];
  if (existing !== undefined) {
    if (!isLockRegistry(existing)) throw new DacsError(`${LABEL} found an unreadable lock registry on this thread`);
    return existing;
  }
  const registry: LockRegistry = Object.freeze({
    threadToken: randomUUID(),
    held: new Set<string>(),
    ...threadIdentity(),
  });
  // Neither writable nor configurable: nothing replaces it while the thread runs.
  Object.defineProperty(process, LOCK_REGISTRY, { value: registry });
  return registry;
}

/**
 * No later than this process started, on the monotonic clock: in every worker
 * thread `process.uptime()` counts from the process's start, and reading it
 * after the clock only moves this earlier.
 */
const PROCESS_STARTED_BY_NS = process.hrtime.bigint() -
  BigInt(Math.ceil(process.uptime() * 1e9)) - 1_000_000n;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function ignoreMissing(error: unknown): void {
  if (errno(error) !== "ENOENT") throw error;
}

type RecordRead =
  | { status: "absent" }
  | { status: "ok"; record: LiquidityTankRecord }
  | { status: "corrupt" };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      nodeTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function positiveSafeInteger(value: unknown, fallback: number, label: string): number {
  const selected = value === undefined ? fallback : value;
  if (typeof selected !== "number" || !Number.isSafeInteger(selected) || selected <= 0) {
    throw new DacsError(`${label} must be a positive safe integer`);
  }
  return selected;
}

function snapshotOptions(value: unknown): Required<FsLiquidityTankStoreOptions> {
  if (!isPlainRecord(value)) throw new DacsError(`${LABEL} options must be a plain record`);
  const allowed = new Set(["dir", "lockTimeoutMs", "lockStaleMs", "lockPollMs"]);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = typeof key === "string" ? descriptors[key] : undefined;
    if (typeof key !== "string" || !allowed.has(key) || !descriptor || !("value" in descriptor)) {
      throw new DacsError(`${LABEL} options must be exact data properties`);
    }
  }
  const dir: unknown = descriptors["dir"]?.value;
  if (typeof dir !== "string" || dir.length === 0) {
    throw new DacsError(`${LABEL} directory must be a non-empty string`);
  }
  return {
    dir,
    lockTimeoutMs: positiveSafeInteger(descriptors["lockTimeoutMs"]?.value, DEFAULT_LOCK_TIMEOUT_MS,
      "liquidity-tank lockTimeoutMs"),
    lockStaleMs: positiveSafeInteger(descriptors["lockStaleMs"]?.value, DEFAULT_LOCK_STALE_MS,
      "liquidity-tank lockStaleMs"),
    lockPollMs: positiveSafeInteger(descriptors["lockPollMs"]?.value, DEFAULT_LOCK_POLL_MS,
      "liquidity-tank lockPollMs"),
  };
}

function unsupportedFilesystemOperation(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EINVAL" || code === "ENOSYS" || code === "ENOTSUP";
}

/**
 * Durable liquidity-tank store for one host. Each phase is one JSON row,
 * replaced by an atomic write (an `O_EXCL` temporary, fsync, rename, then
 * fsync of the directory) before a write reports success. Every method runs
 * under a per-phase filesystem lock and applies the same transitions as the
 * in-memory reference store, so it compares the same fields; a new store on
 * the same directory, in this process or another, sees every committed row.
 * Each bridge ID is reserved for one phase by a file published with a hard
 * link, which never replaces an existing reservation. The directory is
 * admitted by the SDK's private-store checks: owned by this user, not group-
 * or world-writable, no symbolic link on the path, and not a network or sync
 * filesystem. A row that fails its checks reads as `corrupt`.
 *
 * The store passes `runLiquidityTankStoreConformance` in the SDK's tests and
 * declares `restartSafety: "conformance-tested"`. It serializes writers on one
 * host only: several hosts sharing one network directory are not supported.
 */
export async function createFsLiquidityTankStore(
  rawOptions: FsLiquidityTankStoreOptions,
): Promise<LiquidityTankStore> {
  const options = snapshotOptions(rawOptions);
  const registry = threadLockRegistry();
  const root = await preparePrivateStoreDirectory(options.dir, LABEL);
  const recordsDir = join(root, "records");
  const bridgesDir = join(root, "bridges");
  const locksDir = join(root, "locks");
  const reclaimGatePath = join(locksDir, ".reclaim");
  const reclaimQuarantinePrefix = ".reclaim.";
  await preparePrivateStoreDirectory(recordsDir, LABEL);
  await preparePrivateStoreDirectory(bridgesDir, LABEL);
  await preparePrivateStoreDirectory(locksDir, LABEL);

  // Hashing the exact key makes every filename a fixed ASCII token.
  const recordPath = (settlementKey: string): string =>
    join(recordsDir, `${sha256Hex(settlementKey)}.json`);
  const bridgePath = (bridgeId: string): string =>
    join(bridgesDir, `${sha256Hex(bridgeId)}.json`);
  const lockPath = (settlementKey: string): string =>
    join(locksDir, `${sha256Hex(settlementKey)}.lock`);
  const bridgeLockPath = (bridgeId: string): string =>
    join(locksDir, `bridge.${sha256Hex(bridgeId)}.lock`);
  const pause = (): Promise<void> =>
    new Promise<void>((resolve) => setTimeout(resolve, options.lockPollMs));

  /** Runs `step` again until it succeeds or the lock timeout passes, then throws its last error. */
  async function retried(step: () => Promise<void>): Promise<void> {
    const deadline = Date.now() + options.lockTimeoutMs;
    for (;;) {
      try {
        await step();
        return;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
      }
      await pause();
    }
  }

  async function syncDirectory(path: string): Promise<void> {
    let handle;
    try {
      handle = await open(path, "r");
      await handle.sync();
    } catch (error) {
      if (!unsupportedFilesystemOperation(error)) throw error;
    } finally {
      await handle?.close();
    }
  }

  async function readOwnedFile(path: string): Promise<string> {
    const parent = await lstat(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink()) {
      throw new DacsError(`${LABEL} lock path is unsafe`);
    }
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new DacsError(`${LABEL} lock owner is unsafe`);
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  }

  /**
   * The owner recorded at `path`, or `null` if it is missing or is not one
   * this store wrote. A read that fails for another reason (`EMFILE`, `EIO`)
   * throws: it never makes a lock look ownerless.
   */
  async function readOwner(path: string): Promise<LockOwner | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readOwnedFile(path)) as unknown;
    } catch (error) {
      if (errno(error) !== "ENOENT" && errno(error) !== "ELOOP" &&
          !(error instanceof DacsError) && !(error instanceof SyntaxError)) {
        throw error;
      }
      // A missing or malformed owner is reclaimable only after the stale age.
      return null;
    }
    if (isPlainRecord(parsed) && Object.keys(parsed).length === 6 &&
        Number.isSafeInteger(parsed["pid"]) && (parsed["pid"] as number) > 0 &&
        (parsed["tid"] === null || (Number.isSafeInteger(parsed["tid"]) && (parsed["tid"] as number) > 0)) &&
        (parsed["pidScope"] === null || (typeof parsed["pidScope"] === "string" && parsed["pidScope"].length > 0)) &&
        typeof parsed["threadToken"] === "string" && parsed["threadToken"].length > 0 &&
        typeof parsed["token"] === "string" && parsed["token"].length > 0 &&
        typeof parsed["createdNs"] === "string" && DECIMAL.test(parsed["createdNs"])) {
      return {
        pid: parsed["pid"] as number,
        tid: parsed["tid"] as number | null,
        pidScope: parsed["pidScope"] as string | null,
        threadToken: parsed["threadToken"],
        token: parsed["token"],
        createdNs: parsed["createdNs"],
      };
    }
    return null;
  }

  const readLockOwner = (path: string): Promise<LockOwner | null> => readOwner(join(path, "owner.json"));

  const newOwner = (): LockOwner => ({
    pid: process.pid,
    tid: registry.tid,
    pidScope: registry.pidScope,
    threadToken: registry.threadToken,
    token: randomUUID(),
    createdNs: process.hrtime.bigint().toString(),
  });

  function processIsAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  /**
   * Whether the OS reports that the lock's thread has exited. Only for a lock
   * made in this boot and PID namespace, so its thread ID names a thread of
   * this process. A listed thread may be the owner or a later thread that
   * reused its ID, so it counts as alive; anything but a missing entry does too.
   */
  async function ownerThreadExited(owner: LockOwner): Promise<boolean> {
    if (owner.tid === null || owner.pidScope === null || owner.pidScope !== registry.pidScope) return false;
    try {
      await lstat(`/proc/self/task/${owner.tid}`);
      return false;
    } catch (error) {
      return errno(error) === "ENOENT";
    }
  }

  /**
   * Whether the lock's owner may still hold it. With this process's PID, it
   * cannot if it is one of this thread's locks that the thread does not hold;
   * if it was made before this process started (or after now, in an earlier
   * boot): a restart that reused the PID, such as PID 1 in a container; or if
   * it was made by another thread of this process that has since exited. Any
   * other lock with this PID may belong to a live thread here, and counts as
   * held. No clock but the monotonic one decides this. Owners are told apart
   * by PID, so this holds only within one host and PID namespace.
   */
  async function ownerMayBeAlive(owner: LockOwner): Promise<boolean> {
    if (owner.pid !== process.pid) return processIsAlive(owner.pid);
    if (owner.threadToken === registry.threadToken) return registry.held.has(owner.token);
    const created = BigInt(owner.createdNs);
    if (created < PROCESS_STARTED_BY_NS || created > process.hrtime.bigint()) return false;
    return !await ownerThreadExited(owner);
  }

  function sameOwner(left: LockOwner | null, right: LockOwner | null): boolean {
    return left === null
      ? right === null
      : right !== null && left.pid === right.pid && left.tid === right.tid &&
        left.pidScope === right.pidScope && left.threadToken === right.threadToken &&
        left.token === right.token && left.createdNs === right.createdNs;
  }

  const reclaimQuarantinePath = (): string =>
    join(locksDir, `${reclaimQuarantinePrefix}${randomUUID()}.quarantine`);
  const reclaimQuarantineNames = async (): Promise<string[]> =>
    (await readdir(locksDir)).filter((name) =>
      name.startsWith(reclaimQuarantinePrefix) && name.endsWith(".quarantine"));

  async function activeReclaimQuarantines(): Promise<string[]> {
    const live: string[] = [];
    for (const name of await reclaimQuarantineNames()) {
      const path = join(locksDir, name);
      try {
        const metadata = await stat(path);
        const owner = await readOwner(path);
        if (Date.now() - metadata.mtimeMs <= options.lockStaleMs ||
            (owner !== null && await ownerMayBeAlive(owner))) {
          live.push(path);
          continue;
        }
        await unlink(path).catch(ignoreMissing);
      } catch (error) {
        ignoreMissing(error);
      }
    }
    return live;
  }

  async function quarantineStaleReclaimGate(): Promise<void> {
    let observed;
    try {
      observed = await stat(reclaimGatePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (Date.now() - observed.mtimeMs <= options.lockStaleMs) return;
    const observedOwner = await readOwner(reclaimGatePath);
    if (observedOwner !== null && await ownerMayBeAlive(observedOwner)) return;

    const quarantine = reclaimQuarantinePath();
    try {
      await rename(reclaimGatePath, quarantine);
      await syncDirectory(locksDir);
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
    const movedOwner = await readOwner(quarantine);
    if (moved.dev === observed.dev && moved.ino === observed.ino &&
        sameOwner(movedOwner, observedOwner) &&
        Date.now() - moved.mtimeMs > options.lockStaleMs &&
        (movedOwner === null || !await ownerMayBeAlive(movedOwner))) {
      await unlink(quarantine).catch(ignoreMissing);
    }
    // A moved replacement remains as a live quarantine and blocks reclaimers.
  }

  /** Releases this owner's gate, retrying a failed step; afterwards this thread does not hold it. */
  async function releaseReclaimGate(owner: LockOwner): Promise<void> {
    try {
      await retried(async () => {
        if (sameOwner(await readOwner(reclaimGatePath), owner)) {
          await rename(reclaimGatePath, reclaimQuarantinePath()).catch(ignoreMissing);
        }
        // Only this owner's moved gate is removed: a moved replacement stays.
        for (const name of await reclaimQuarantineNames()) {
          const path = join(locksDir, name);
          if (sameOwner(await readOwner(path), owner)) await unlink(path).catch(ignoreMissing);
        }
        await syncDirectory(locksDir);
      });
    } catch (error) {
      throw new DacsError(`${LABEL} could not release its reclaim gate`, { cause: error });
    } finally {
      registry.held.delete(owner.token);
    }
  }

  async function acquireReclaimGate(owner: LockOwner): Promise<boolean> {
    if ((await activeReclaimQuarantines()).length > 0) return false;
    registry.held.add(owner.token);
    let linked = false;
    try {
      const temporary = `${reclaimGatePath}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", FILE_MODE);
        try {
          await handle.writeFile(JSON.stringify(owner), "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await link(temporary, reclaimGatePath);
        linked = true;
      } finally {
        await unlink(temporary).catch(() => {});
      }
      await syncDirectory(locksDir);
      if ((await activeReclaimQuarantines()).length === 0) return true;
    } catch (error) {
      // A gate this acquisition published is never left behind by its failure.
      if (linked) await releaseReclaimGate(owner);
      else registry.held.delete(owner.token);
      if (linked || errno(error) !== "EEXIST") throw error;
      await quarantineStaleReclaimGate();
      return false;
    }
    await releaseReclaimGate(owner);
    return false;
  }

  async function maybeReclaimStale(path: string): Promise<void> {
    try {
      const metadata = await stat(path);
      if (Date.now() - metadata.mtimeMs <= options.lockStaleMs) return;
      const owner = await readLockOwner(path);
      if (owner && await ownerMayBeAlive(owner)) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const gateOwner = newOwner();
    if (!await acquireReclaimGate(gateOwner)) return;
    try {
      let observed;
      try {
        observed = await stat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (Date.now() - observed.mtimeMs <= options.lockStaleMs) return;
      const observedOwner = await readLockOwner(path);
      if (observedOwner !== null && await ownerMayBeAlive(observedOwner)) return;
      const quarantine = `${path}.${randomUUID()}.stale`;
      try {
        await rename(path, quarantine);
        await syncDirectory(locksDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const moved = await stat(quarantine);
      const movedOwner = await readLockOwner(quarantine);
      if (moved.dev !== observed.dev || moved.ino !== observed.ino ||
          !sameOwner(movedOwner, observedOwner) ||
          Date.now() - moved.mtimeMs <= options.lockStaleMs ||
          (movedOwner !== null && await ownerMayBeAlive(movedOwner))) {
        throw new DacsError(`${LABEL} lock changed during stale recovery`);
      }
      await rm(quarantine, { recursive: true, force: true });
      await syncDirectory(locksDir);
    } finally {
      await releaseReclaimGate(gateOwner);
    }
  }

  /**
   * Moves this owner's lock away from `path` and deletes it, retrying a failed
   * step; afterwards this thread does not hold it. A lock that could not be
   * released throws, and this thread may reclaim it after the stale age.
   */
  async function releaseLock(path: string, owner: LockOwner): Promise<void> {
    // Moved away from its publication path before it is deleted, so a
    // successor that publishes in between is never deleted.
    const released = `${path}.${owner.token}.released`;
    try {
      await retried(async () => {
        if (sameOwner(await readLockOwner(path), owner)) {
          await rename(path, released).catch(ignoreMissing);
        }
        await syncDirectory(locksDir);
        await rm(released, { recursive: true, force: true });
      });
    } catch (error) {
      throw new DacsError(`${LABEL} could not release its lock`, { cause: error });
    } finally {
      registry.held.delete(owner.token);
    }
  }

  async function publishLockCandidate(candidate: string, path: string, owner: LockOwner): Promise<boolean> {
    // Stale recovery observes and renames `path` while holding this gate, so a
    // normal successor publishes through the same gate.
    const gateOwner = newOwner();
    if (!await acquireReclaimGate(gateOwner)) return false;
    let published = false;
    let gateReleasing = false;
    // Held before it is published, so it never looks abandoned to this thread.
    registry.held.add(owner.token);
    try {
      try {
        await rename(candidate, path);
        published = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST" || code === "ENOTEMPTY") return false;
        throw error;
      }
      await syncDirectory(locksDir);
      gateReleasing = true;
      await releaseReclaimGate(gateOwner);
      return true;
    } catch (error) {
      // A lock this acquisition published is never left behind by its failure.
      if (published) {
        published = false;
        await releaseLock(path, owner);
      }
      throw error;
    } finally {
      if (!published) registry.held.delete(owner.token);
      if (!gateReleasing) await releaseReclaimGate(gateOwner);
    }
  }

  /** Runs `operation` while this process holds the lock at `path`. */
  async function withLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const owner = newOwner();
    const deadline = Date.now() + options.lockTimeoutMs;
    for (;;) {
      // A complete lock directory is published in one rename.
      const candidate = `${path}.${randomUUID()}.candidate`;
      try {
        await mkdir(candidate, { mode: DIR_MODE });
        const handle = await open(join(candidate, "owner.json"), "wx", FILE_MODE);
        try {
          await handle.writeFile(JSON.stringify(owner), "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await syncDirectory(candidate);
        if (await publishLockCandidate(candidate, path, owner)) break;
        await maybeReclaimStale(path);
        if (Date.now() >= deadline) {
          throw new DacsError(`timed out acquiring the ${LABEL} lock`);
        }
        await pause();
      } finally {
        await rm(candidate, { recursive: true, force: true }).catch(() => {});
      }
    }
    try {
      return await operation();
    } finally {
      // A lock left behind fails the call instead of reporting its result.
      await releaseLock(path, owner);
    }
  }

  async function readJson(path: string): Promise<{ status: "absent" } | { status: "ok"; value: unknown }> {
    let text: string;
    try {
      text = await readPrivateFile(path, "utf8", LABEL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return { status: "ok", value: undefined };
    }
    // This store writes one exact JSON spelling; any other did not come from it.
    return { status: "ok", value: JSON.stringify(parsed) === text ? parsed : undefined };
  }

  async function readRecord(settlementKey: string): Promise<RecordRead> {
    // Under the phase lock, finish any interrupted rename publication before
    // acknowledging visible state, including terminal and idempotent reads.
    await completeExclusivePublication(recordPath(settlementKey), LABEL);
    const read = await readJson(recordPath(settlementKey));
    if (read.status === "absent") return read;
    const value = read.value;
    if (!isPlainRecord(value) || value["storeVersion"] !== LIQUIDITY_TANK_FS_STORE_VERSION ||
        Object.keys(value).some((key) => !RECORD_FIELDS.has(key))) {
      return { status: "corrupt" };
    }
    const { storeVersion: _version, ...record } = value as unknown as StoredRecord;
    try {
      assertLiquidityTankRecord(record, settlementKey);
    } catch {
      return { status: "corrupt" };
    }
    return { status: "ok", record };
  }

  async function writeRecord(settlementKey: string, record: LiquidityTankRecord): Promise<void> {
    assertLiquidityTankRecord(record, settlementKey);
    const stored: StoredRecord = { storeVersion: LIQUIDITY_TANK_FS_STORE_VERSION, ...record };
    await atomicWritePrivateFile(recordPath(settlementKey), JSON.stringify(stored), LABEL);
  }

  /**
   * The settlement key holding `bridgeId`, `undefined` if none, or `null` if
   * unreadable. Called under the bridge ID's lock, which every publisher of
   * its reservation holds, so a staging link found here was left by a
   * publication that stopped after its link, and is finished first.
   */
  async function readBridgeOwner(bridgeId: string): Promise<string | undefined | null> {
    await completeExclusivePublication(bridgePath(bridgeId), LABEL);
    const read = await readJson(bridgePath(bridgeId));
    if (read.status === "absent") return undefined;
    const value = read.value;
    return isPlainRecord(value) && value["storeVersion"] === LIQUIDITY_TANK_FS_STORE_VERSION &&
        value["bridgeId"] === bridgeId && typeof value["settlementKey"] === "string" &&
        Object.keys(value).length === 3
      ? value["settlementKey"]
      : null;
  }

  const corrupt = { status: "corrupt", reason: "liquidity-tank-fs-record-corrupt" } as const;

  /** Reads the row, applies `transition` and commits its new row, all under the phase's lock. */
  function transact<T>(
    settlementKey: string,
    transition: (record: LiquidityTankRecord | undefined) => LiquidityTankRecordTransition<T>,
    onCorrupt: T,
  ): Promise<T> {
    return withLock(lockPath(settlementKey), async () => {
      const read = await readRecord(settlementKey);
      if (read.status === "corrupt") return onCorrupt;
      const applied = transition(read.status === "ok" ? read.record : undefined);
      if (applied.next) await writeRecord(settlementKey, applied.next);
      return applied.result;
    });
  }

  const store: LiquidityTankStore = {
    restartSafety: "conformance-tested",
    claim(input) {
      return transact(input.intent.settlementKey, (record) => transitions.claim(record, input), corrupt);
    },
    isCurrent(input) {
      return withLock(lockPath(input.settlementKey), async () => {
        const read = await readRecord(input.settlementKey);
        return read.status === "ok" && transitions.isCurrent(read.record, input);
      });
    },
    recordSubmission(input) {
      const { settlementKey } = input;
      const { bridgeId } = input.submission;
      // The phase's lock, then the bridge ID's, in that order only: every
      // reservation of the bridge ID is read and published under the second.
      return withLock(lockPath(settlementKey), () => withLock(bridgeLockPath(bridgeId), async () => {
        const read = await readRecord(settlementKey);
        if (read.status === "corrupt") return corrupt;
        const bridgeOwner = await readBridgeOwner(bridgeId);
        if (bridgeOwner === null) return corrupt;
        const applied = transitions.recordSubmission(
          read.status === "ok" ? read.record : undefined,
          input,
          bridgeOwner,
        );
        if (!applied.next) return applied.result;
        if (bridgeOwner === undefined) {
          // The reservation is published before the row: a crash in between
          // leaves the bridge ID reserved for this phase and its row unchanged.
          try {
            await exclusiveWritePrivateFile(bridgePath(bridgeId), JSON.stringify({
              storeVersion: LIQUIDITY_TANK_FS_STORE_VERSION,
              bridgeId,
              settlementKey,
            }), LABEL);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            const winner = await readBridgeOwner(bridgeId);
            if (winner === null) return corrupt;
            if (winner !== settlementKey) {
              return { status: "conflict", reason: "liquidity-tank-bridge-cross-settlement-reuse" } as const;
            }
          }
        }
        await writeRecord(settlementKey, applied.next);
        return applied.result;
      }));
    },
    recordObservation(input) {
      return transact(input.settlementKey, (record) => transitions.recordObservation(record, input), corrupt);
    },
    recordRecoveryFailure(input) {
      return transact(input.settlementKey, (record) => transitions.recordRecoveryFailure(record, input), corrupt);
    },
    recordRecoveryExpired(input) {
      return transact(input.settlementKey, (record) => transitions.recordRecoveryExpired(record, input), corrupt);
    },
    reconcileRecoveryExpired(input) {
      return transact(input.settlementKey, (record) => transitions.reconcileRecoveryExpired(record, input), corrupt);
    },
    recordSettlement(input) {
      return transact(input.settlementKey, (record) => transitions.recordSettlement(record, input), corrupt);
    },
  };
  return registerProductionTankStore(Object.freeze(store));
}

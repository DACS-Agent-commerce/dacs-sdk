import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
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
  /** Age at which a lock owned by a dead process may be reclaimed. Defaults to 30 seconds. */
  lockStaleMs?: number;
  /** Contention polling interval. Defaults to 5 milliseconds. */
  lockPollMs?: number;
}

type StoredRecord = LiquidityTankRecord & { storeVersion: typeof LIQUIDITY_TANK_FS_STORE_VERSION };

interface LockOwner {
  pid: number;
  token: string;
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

  async function readOwner(path: string): Promise<LockOwner | null> {
    try {
      const parsed = JSON.parse(await readOwnedFile(path)) as unknown;
      if (isPlainRecord(parsed) && Number.isSafeInteger(parsed["pid"]) &&
          (parsed["pid"] as number) > 0 && typeof parsed["token"] === "string" &&
          parsed["token"].length > 0) {
        return { pid: parsed["pid"] as number, token: parsed["token"] };
      }
    } catch {
      // A missing or malformed owner is reclaimable only after the stale age.
    }
    return null;
  }

  const readLockOwner = (path: string): Promise<LockOwner | null> => readOwner(join(path, "owner.json"));

  function processIsAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  function sameOwner(left: LockOwner | null, right: LockOwner | null): boolean {
    return left === null
      ? right === null
      : right !== null && left.pid === right.pid && left.token === right.token;
  }

  async function publishCompleteOwner(path: string, owner: LockOwner): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", FILE_MODE);
      try {
        await handle.writeFile(JSON.stringify(owner), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await link(temporary, path);
      await syncDirectory(locksDir);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  const reclaimQuarantinePath = (): string =>
    join(locksDir, `${reclaimQuarantinePrefix}${randomUUID()}.quarantine`);

  async function activeReclaimQuarantines(): Promise<string[]> {
    const names = (await readdir(locksDir)).filter((name) =>
      name.startsWith(reclaimQuarantinePrefix) && name.endsWith(".quarantine"));
    const live: string[] = [];
    for (const name of names) {
      const path = join(locksDir, name);
      try {
        const metadata = await stat(path);
        const owner = await readOwner(path);
        if (Date.now() - metadata.mtimeMs <= options.lockStaleMs ||
            (owner !== null && processIsAlive(owner.pid))) {
          live.push(path);
          continue;
        }
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
    if (observedOwner !== null && processIsAlive(observedOwner.pid)) return;

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
        (movedOwner === null || !processIsAlive(movedOwner.pid))) {
      await unlink(quarantine).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    // A moved replacement remains as a live quarantine and blocks reclaimers.
  }

  async function releaseReclaimGate(owner: LockOwner): Promise<void> {
    const observed = await readOwner(reclaimGatePath);
    if (sameOwner(observed, owner)) {
      const quarantine = reclaimQuarantinePath();
      try {
        await rename(reclaimGatePath, quarantine);
        if (sameOwner(await readOwner(quarantine), owner)) {
          await unlink(quarantine).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const name of (await readdir(locksDir)).filter((item) =>
      item.startsWith(reclaimQuarantinePrefix) && item.endsWith(".quarantine"))) {
      const path = join(locksDir, name);
      if (sameOwner(await readOwner(path), owner)) {
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    }
    await syncDirectory(locksDir);
  }

  async function acquireReclaimGate(owner: LockOwner): Promise<boolean> {
    if ((await activeReclaimQuarantines()).length > 0) return false;
    try {
      await publishCompleteOwner(reclaimGatePath, owner);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await quarantineStaleReclaimGate();
      return false;
    }
    if ((await activeReclaimQuarantines()).length > 0) {
      await releaseReclaimGate(owner);
      return false;
    }
    return true;
  }

  async function maybeReclaimStale(path: string): Promise<void> {
    try {
      const metadata = await stat(path);
      if (Date.now() - metadata.mtimeMs <= options.lockStaleMs) return;
      const owner = await readLockOwner(path);
      if (owner && processIsAlive(owner.pid)) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const gateOwner: LockOwner = { pid: process.pid, token: randomUUID() };
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
      if (observedOwner !== null && processIsAlive(observedOwner.pid)) return;
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
          (movedOwner !== null && processIsAlive(movedOwner.pid))) {
        throw new DacsError(`${LABEL} lock changed during stale recovery`);
      }
      await rm(quarantine, { recursive: true, force: true });
      await syncDirectory(locksDir);
    } finally {
      await releaseReclaimGate(gateOwner);
    }
  }

  async function publishLockCandidate(candidate: string, path: string): Promise<boolean> {
    // Stale recovery observes and renames `path` while holding this gate, so a
    // normal successor publishes through the same gate.
    const gateOwner: LockOwner = { pid: process.pid, token: randomUUID() };
    if (!await acquireReclaimGate(gateOwner)) return false;
    try {
      try {
        await rename(candidate, path);
        await syncDirectory(locksDir);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST" || code === "ENOTEMPTY") return false;
        throw error;
      }
    } finally {
      await releaseReclaimGate(gateOwner);
    }
  }

  /** Runs `operation` while this process holds the lock at `path`. */
  async function withLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const owner: LockOwner = { pid: process.pid, token: randomUUID() };
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
        if (await publishLockCandidate(candidate, path)) break;
        await maybeReclaimStale(path);
        if (Date.now() >= deadline) {
          throw new DacsError(`timed out acquiring the ${LABEL} lock`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, options.lockPollMs));
      } finally {
        await rm(candidate, { recursive: true, force: true }).catch(() => {});
      }
    }
    try {
      return await operation();
    } finally {
      // Move the lock away from its publication path before deleting it, so a
      // successor that publishes in between is never deleted.
      if (sameOwner(await readLockOwner(path), owner)) {
        const released = `${path}.${owner.token}.released`;
        try {
          await rename(path, released);
          await syncDirectory(locksDir);
          await rm(released, { recursive: true, force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
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

  return {
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
    recordSettlement(input) {
      return transact(input.settlementKey, (record) => transitions.recordSettlement(record, input), corrupt);
    },
  };
}

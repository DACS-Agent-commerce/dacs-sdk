import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { types as nodeTypes } from "node:util";

import { canonicalize, sha256Hex } from "../canonical/index.js";
import { DacsError } from "../errors.js";
import {
  atomicWritePrivateFile,
  exclusiveWritePrivateFile,
  preparePrivateStoreDirectory,
  readPrivateFile,
} from "../filesystem/privateStore.js";
import {
  X402_BUYER_SETTLEMENT_STORE_VERSION,
  x402BuyerSettlementStoreInternals,
  type X402BuyerLeaseToken,
  type X402BuyerDisclosureWrite,
  type X402BuyerOutcomeWrite,
  type X402BuyerRecoveryGrant,
  type X402BuyerSettlementClaim,
  type X402BuyerSettlementLease,
  type X402BuyerSettlementLoad,
  type X402BuyerSettlementStore,
  type X402BuyerStoredRecord,
} from "./x402BuyerSettlement.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_POLL_MS = 5;
const INITIALIZATION_VERSION = 1 as const;

export interface FsX402BuyerSettlementStoreOptions {
  dir: string;
  lockTimeoutMs?: number;
  lockStaleMs?: number;
  lockPollMs?: number;
}

interface StoreReadAbsent {
  status: "absent";
}

interface StoreReadOk {
  status: "ok";
  record: Readonly<X402BuyerStoredRecord>;
}

type StoreRead =
  | StoreReadAbsent
  | StoreReadOk
  | { status: "unsupported"; version: number }
  | { status: "corrupt"; reason: string };

interface LockOwner {
  pid: number;
  token: string;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      nodeTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function captureOptions(value: unknown): FsX402BuyerSettlementStoreOptions {
  if (!plainRecord(value)) {
    throw new DacsError("x402 buyer filesystem store options must be a plain object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(["dir", "lockTimeoutMs", "lockStaleMs", "lockPollMs"]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new DacsError("x402 buyer filesystem store option is unsupported");
    }
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) ||
        descriptor.value === undefined) {
      throw new DacsError("x402 buyer filesystem store option must be an enumerable data property");
    }
  }
  const dir = descriptors.dir?.value;
  if (typeof dir !== "string" || dir.length === 0 || dir.trim() !== dir) {
    throw new DacsError("x402 buyer store directory must be a non-empty string");
  }
  return {
    dir,
    ...(descriptors.lockTimeoutMs === undefined
      ? {}
      : { lockTimeoutMs: descriptors.lockTimeoutMs.value as number }),
    ...(descriptors.lockStaleMs === undefined
      ? {}
      : { lockStaleMs: descriptors.lockStaleMs.value as number }),
    ...(descriptors.lockPollMs === undefined
      ? {}
      : { lockPollMs: descriptors.lockPollMs.value as number }),
  };
}

const finitePositive = (value: unknown, fallback: number, label: string): number => {
  const result = value === undefined ? fallback : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result <= 0) {
    throw new DacsError(`${label} must be a positive safe integer`);
  }
  return result;
};

const nonEmpty = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new DacsError(`${label} must be a non-empty string`);
  }
  return value;
};

const clone = <T>(value: T): T => structuredClone(value);

const terminalLoad = (
  record: Readonly<X402BuyerStoredRecord>,
): X402BuyerSettlementLoad | null =>
  x402BuyerSettlementStoreInternals.terminalLoad(record);

function terminalClaim(
  record: Readonly<X402BuyerStoredRecord>,
): X402BuyerSettlementClaim | null {
  const terminal = terminalLoad(record);
  if (!terminal || (terminal.status !== "captured" && terminal.status !== "failed")) {
    return null;
  }
  return terminal;
}

function terminalGrant(
  record: Readonly<X402BuyerStoredRecord>,
): X402BuyerRecoveryGrant | null {
  return terminalClaim(record) as X402BuyerRecoveryGrant | null;
}

function terminalWrite(
  record: Readonly<X402BuyerStoredRecord>,
): X402BuyerOutcomeWrite | null {
  const terminal = terminalLoad(record);
  if (!terminal || (terminal.status !== "captured" && terminal.status !== "failed")) {
    return null;
  }
  return {
    status: "existing",
    intent: terminal.intent,
    outcome: terminal.outcome,
  };
}

/**
 * Filesystem-backed reference store. Per-key mkdir locks serialize independent
 * processes, and fsync+rename publishes only complete records.
 */
export async function createFsX402BuyerSettlementStore(
  options: FsX402BuyerSettlementStoreOptions,
): Promise<X402BuyerSettlementStore> {
  const capturedOptions = captureOptions(options);
  const root = await preparePrivateStoreDirectory(
    capturedOptions.dir,
    "x402 buyer filesystem store",
  );
  const lockTimeoutMs = finitePositive(
    capturedOptions.lockTimeoutMs,
    DEFAULT_LOCK_TIMEOUT_MS,
    "x402 buyer lockTimeoutMs",
  );
  const lockStaleMs = finitePositive(
    capturedOptions.lockStaleMs,
    DEFAULT_LOCK_STALE_MS,
    "x402 buyer lockStaleMs",
  );
  const lockPollMs = finitePositive(
    capturedOptions.lockPollMs,
    DEFAULT_LOCK_POLL_MS,
    "x402 buyer lockPollMs",
  );
  const recordsDir = join(root, "records");
  const locksDir = join(root, "locks");
  const markersDir = join(root, "markers");
  const reclaimGatePath = join(locksDir, ".reclaim");
  const reclaimQuarantinePrefix = ".reclaim.";

  await preparePrivateStoreDirectory(recordsDir, "x402 buyer filesystem store");
  await preparePrivateStoreDirectory(locksDir, "x402 buyer filesystem store");
  await preparePrivateStoreDirectory(markersDir, "x402 buyer filesystem store");

  const safe = (settlementKey: string): string => sha256Hex(settlementKey);
  const recordPath = (settlementKey: string): string =>
    join(recordsDir, `${safe(settlementKey)}.json`);
  const markerPath = (settlementKey: string): string =>
    join(markersDir, `${safe(settlementKey)}.initialized`);
  const lockPath = (settlementKey: string): string =>
    join(locksDir, `${safe(settlementKey)}.lock`);

  async function syncDirectory(path: string): Promise<void> {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async function atomicWrite(path: string, value: unknown): Promise<void> {
    await atomicWritePrivateFile(
      path,
      JSON.stringify(value),
      "x402 buyer filesystem store",
    );
  }

  const initializationText = (settlementKey: string): string => JSON.stringify({
    markerVersion: INITIALIZATION_VERSION,
    settlementKeyHash: safe(settlementKey),
  });

  async function readInitializationMarker(
    settlementKey: string,
  ): Promise<"absent" | "present"> {
    const path = markerPath(settlementKey);
    let text: string;
    try {
      text = await readPrivateFile(path, "utf8", "x402 buyer filesystem marker");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new DacsError("x402 buyer initialization marker path is unsafe");
      }
      throw error;
    }
    if (text !== initializationText(settlementKey)) {
      throw new DacsError("x402 buyer initialization marker is corrupt");
    }
    return "present";
  }

  async function ensureInitializationMarker(settlementKey: string): Promise<void> {
    if (await readInitializationMarker(settlementKey) === "present") return;
    const path = markerPath(settlementKey);
    try {
      await exclusiveWritePrivateFile(
        path,
        initializationText(settlementKey),
        "x402 buyer filesystem marker",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await readInitializationMarker(settlementKey) !== "present") {
        throw new DacsError("x402 buyer initialization marker is corrupt");
      }
    }
  }

  async function readOwner(path: string): Promise<LockOwner | null> {
    try {
      const parsed = JSON.parse(await readPrivateFile(
        join(path, "owner.json"),
        "utf8",
        "x402 buyer filesystem lock",
      )) as unknown;
      if (typeof parsed === "object" && parsed !== null &&
          "pid" in parsed && Number.isSafeInteger(parsed.pid) &&
          (parsed.pid as number) > 0 && "token" in parsed &&
          typeof parsed.token === "string" && parsed.token.length > 0) {
        return { pid: parsed.pid as number, token: parsed.token };
      }
    } catch {
      // A missing/malformed owner can be reclaimed only after the stale age.
    }
    return null;
  }

  function processAlive(pid: number): boolean {
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
      // The non-empty directory makes rename an atomic no-overwrite publish.
      await rename(candidate, path);
      await syncDirectory(locksDir);
    } finally {
      await rm(candidate, { recursive: true, force: true });
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
        if (Date.now() - metadata.mtimeMs <= lockStaleMs ||
            (owner !== null && processAlive(owner.pid))) {
          live.push(path);
          continue;
        }
        await rm(path, { recursive: true, force: true });
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
    if (Date.now() - observed.mtimeMs <= lockStaleMs) return;
    const observedOwner = await readOwner(reclaimGatePath);
    if (observedOwner !== null && processAlive(observedOwner.pid)) return;

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
        Date.now() - moved.mtimeMs > lockStaleMs &&
        (movedOwner === null || !processAlive(movedOwner.pid))) {
      await rm(quarantine, { recursive: true, force: true });
    }
    // A moved replacement remains quarantined and blocks later reclaimers.
  }

  async function releaseReclaimGate(owner: LockOwner): Promise<void> {
    const observed = await readOwner(reclaimGatePath);
    if (observed?.pid === owner.pid && observed.token === owner.token) {
      const quarantine = reclaimQuarantinePath();
      try {
        await rename(reclaimGatePath, quarantine);
        const moved = await readOwner(quarantine);
        if (moved?.pid === owner.pid && moved.token === owner.token) {
          await rm(quarantine, { recursive: true, force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const name of (await readdir(locksDir)).filter((item) =>
      item.startsWith(reclaimQuarantinePrefix) && item.endsWith(".quarantine"))) {
      const path = join(locksDir, name);
      const quarantined = await readOwner(path);
      if (quarantined?.pid === owner.pid && quarantined.token === owner.token) {
        await rm(path, { recursive: true, force: true });
      }
    }
    await syncDirectory(locksDir);
  }

  async function acquireReclaimGate(owner: LockOwner): Promise<boolean> {
    if ((await activeReclaimQuarantines()).length > 0) return false;
    try {
      await publishCompleteOwner(reclaimGatePath, owner);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      await quarantineStaleReclaimGate();
      return false;
    }
    if ((await activeReclaimQuarantines()).length > 0) {
      await releaseReclaimGate(owner);
      return false;
    }
    return true;
  }

  async function maybeReclaimStale(path: string, deadline: number): Promise<boolean> {
    try {
      const metadata = await stat(path);
      if (Date.now() - metadata.mtimeMs <= lockStaleMs) return false;
      const owner = await readOwner(path);
      if (owner && processAlive(owner.pid)) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }

    return withLockMutationGate(deadline, async () => {
      let observed;
      try {
        observed = await stat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
        throw error;
      }
      if (Date.now() - observed.mtimeMs <= lockStaleMs) return false;
      const observedOwner = await readOwner(path);
      if (observedOwner !== null && processAlive(observedOwner.pid)) return false;

      const quarantine = `${path}.${randomUUID()}.stale`;
      try {
        await rename(path, quarantine);
        await syncDirectory(locksDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
        throw error;
      }
      const moved = await stat(quarantine);
      const movedOwner = await readOwner(quarantine);
      if (moved.dev !== observed.dev || moved.ino !== observed.ino ||
          !sameOwner(movedOwner, observedOwner) ||
          Date.now() - moved.mtimeMs <= lockStaleMs ||
          (movedOwner !== null && processAlive(movedOwner.pid))) {
        throw new DacsError("x402 buyer lock changed during stale recovery");
      }
      await rm(quarantine, { recursive: true, force: true });
      await syncDirectory(locksDir);
      return true;
    });
  }

  async function wait(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Every publication, release and stale quarantine of an authoritative lock
   * path must pass through the same mutation gate. Merely gating reclaimers is
   * insufficient: a normal successor can otherwise replace the path between a
   * reclaimer's observations and rename, allowing the reclaimer to displace a
   * live holder before it detects that the inode changed.
   */
  async function withLockMutationGate<T>(
    deadline: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    const owner: LockOwner = { pid: process.pid, token: randomUUID() };
    while (!await acquireReclaimGate(owner)) {
      if (Date.now() >= deadline) {
        throw new DacsError("timed out acquiring x402 buyer lock mutation gate");
      }
      await wait(lockPollMs);
    }
    try {
      return await operation();
    } finally {
      await releaseReclaimGate(owner);
    }
  }

  async function withLock<T>(settlementKey: string, operation: () => Promise<T>): Promise<T> {
    const path = lockPath(settlementKey);
    const owner: LockOwner = { pid: process.pid, token: randomUUID() };
    const deadline = Date.now() + lockTimeoutMs;
    while (true) {
      // Prepare the owner record under an unpublished, unique directory, then
      // publish the complete lock with one rename. Publishing an empty lock
      // directory first leaves a stale-reclaim race: a paused creator can later
      // resume inside a successor's path and delete/fence that successor.
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
        await withLockMutationGate(deadline, async () => {
          await rename(candidate, path);
          await syncDirectory(locksDir);
        });
        break;
      } catch (error) {
        await rm(candidate, { recursive: true, force: true }).catch(() => {});
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY") {
          throw error;
        }
        await maybeReclaimStale(path, deadline);
        if (Date.now() >= deadline) {
          throw new DacsError("timed out acquiring x402 buyer settlement lock");
        }
        await wait(lockPollMs);
      }
    }
    try {
      return await operation();
    } finally {
      // Move only the lock we still own off the publication path before delete.
      let released: string | undefined;
      await withLockMutationGate(Date.now() + lockTimeoutMs, async () => {
        const observed = await readOwner(path);
        if (observed?.pid === owner.pid && observed.token === owner.token) {
          released = `${path}.${owner.token}.released`;
          try {
            await rename(path, released);
            await syncDirectory(locksDir);
          } catch (error) {
            released = undefined;
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      });
      if (released !== undefined) {
        await rm(released, { recursive: true, force: true });
      }
    }
  }

  async function readRecord(settlementKey: string): Promise<StoreRead> {
    const initialization = await readInitializationMarker(settlementKey);
    let text: string;
    try {
      text = await readPrivateFile(
        recordPath(settlementKey),
        "utf8",
        "x402 buyer filesystem store",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return initialization === "present"
          ? { status: "corrupt", reason: "initialized record is missing" }
          : { status: "absent" };
      }
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        return { status: "corrupt", reason: "record path is unsafe" };
      }
      if (error instanceof DacsError && /symbolic link|not a regular file/u.test(error.message)) {
        return {
          status: "corrupt",
          reason: error.message.includes("symbolic link")
            ? "record path is unsafe"
            : "record path is not a file",
        };
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return { status: "corrupt", reason: "record is not valid JSON" };
    }
    if (JSON.stringify(parsed) !== text) {
      return { status: "corrupt", reason: "record is not canonical store JSON" };
    }
    if (typeof parsed !== "object" || parsed === null ||
        !("storeVersion" in parsed) || typeof parsed.storeVersion !== "number") {
      return { status: "corrupt", reason: "record is missing storeVersion" };
    }
    if (parsed.storeVersion !== X402_BUYER_SETTLEMENT_STORE_VERSION) {
      return { status: "unsupported", version: parsed.storeVersion };
    }
    try {
      const record = x402BuyerSettlementStoreInternals.captureStoredRecord(parsed);
      if (record.intent.settlementKey !== settlementKey) {
        return { status: "corrupt", reason: "record path and settlement key disagree" };
      }
      if (initialization === "absent") {
        await ensureInitializationMarker(settlementKey);
      }
      return { status: "ok", record };
    } catch (error) {
      return {
        status: "corrupt",
        reason: error instanceof Error ? error.message : "record shape is invalid",
      };
    }
  }

  async function writeRecord(record: Readonly<X402BuyerStoredRecord>): Promise<void> {
    const checked = x402BuyerSettlementStoreInternals.captureStoredRecord(record);
    await atomicWrite(recordPath(checked.intent.settlementKey), checked);
    await ensureInitializationMarker(checked.intent.settlementKey);
  }

  const unavailableClaim = (
    read: Exclude<StoreRead, StoreReadAbsent | StoreReadOk>,
  ): X402BuyerSettlementClaim => read;
  const unavailableGrant = (
    read: Exclude<StoreRead, StoreReadAbsent | StoreReadOk>,
  ): X402BuyerRecoveryGrant => read;
  const unavailableWrite = (
    read: Exclude<StoreRead, StoreReadAbsent | StoreReadOk>,
  ): X402BuyerOutcomeWrite => read;
  const unavailableDisclosure = (
    read: Exclude<StoreRead, StoreReadAbsent | StoreReadOk>,
  ): X402BuyerDisclosureWrite => read;

  return {
    async load(settlementKey) {
      nonEmpty(settlementKey, "x402 buyer settlement key");
      const read = await readRecord(settlementKey);
      if (read.status !== "ok") return read;
      const terminal = terminalLoad(read.record);
      if (terminal) return terminal;
      return {
        status: "held",
        intent: clone(read.record.intent),
        lease: clone(read.record.lease),
        ...(read.record.pendingDisclosure === undefined
          ? {}
          : { pendingDisclosure: clone(read.record.pendingDisclosure) }),
      };
    },
    async claim(input) {
      const intent = x402BuyerSettlementStoreInternals.captureIntent(input.intent);
      const owner = nonEmpty(input.owner, "x402 buyer claim owner");
      if (!Number.isFinite(input.now) || !Number.isSafeInteger(input.leaseDurationMs) ||
          input.leaseDurationMs <= 0) {
        throw new DacsError("x402 buyer claim timing is invalid");
      }
      return withLock(intent.settlementKey, async () => {
        const read = await readRecord(intent.settlementKey);
        if (read.status === "unsupported" || read.status === "corrupt") {
          return unavailableClaim(read);
        }
        if (read.status === "absent") {
          const lease: X402BuyerSettlementLease = {
            owner,
            generation: 1,
            stage: "fresh",
            expiresAt: input.now + input.leaseDurationMs,
          };
          const record: X402BuyerStoredRecord = {
            storeVersion: X402_BUYER_SETTLEMENT_STORE_VERSION,
            intent: clone(intent),
            generation: 1,
            lease,
            createdAt: input.now,
            updatedAt: input.now,
          };
          await writeRecord(record);
          return { status: "acquired", intent: clone(intent), lease: clone(lease) };
        }
        const current = read.record;
        if (current.intent.bindingHash !== intent.bindingHash) return { status: "conflict" };
        const terminal = terminalClaim(current);
        if (terminal) return terminal;
        if (current.lease.expiresAt > input.now) {
          return {
            status: "waiting",
            intent: clone(current.intent),
            lease: clone(current.lease),
            ...(current.pendingDisclosure === undefined
              ? {}
              : { pendingDisclosure: clone(current.pendingDisclosure) }),
          };
        }
        const generation = current.generation + 1;
        if (!Number.isSafeInteger(generation)) {
          return { status: "corrupt", reason: "lease generation exhausted" };
        }
        const lease: X402BuyerSettlementLease = {
          owner,
          generation,
          stage: "reconcile",
          expiresAt: input.now + input.leaseDurationMs,
        };
        const updated: X402BuyerStoredRecord = {
          ...clone(current),
          generation,
          lease,
          updatedAt: input.now,
        };
        await writeRecord(updated);
        return {
          status: "acquired",
          intent: clone(current.intent),
          lease: clone(lease),
          ...(current.pendingDisclosure === undefined
            ? {}
            : { pendingDisclosure: clone(current.pendingDisclosure) }),
        };
      });
    },
    async isCurrent(input) {
      const read = await readRecord(input.settlementKey);
      return read.status === "ok" && read.record.outcome === undefined &&
        read.record.intent.bindingHash === input.bindingHash &&
        read.record.lease.owner === input.lease.owner &&
        read.record.lease.generation === input.lease.generation &&
        read.record.lease.expiresAt > input.now;
    },
    async grantRecovery(input) {
      return withLock(input.settlementKey, async () => {
        const read = await readRecord(input.settlementKey);
        if (read.status === "absent") return { status: "stale" };
        if (read.status === "unsupported" || read.status === "corrupt") {
          return unavailableGrant(read);
        }
        const current = read.record;
        if (current.intent.bindingHash !== input.bindingHash) return { status: "conflict" };
        const terminal = terminalGrant(current);
        if (terminal) return terminal;
        if (current.lease.owner !== input.lease.owner ||
            current.lease.generation !== input.lease.generation ||
            current.lease.stage !== "reconcile" || current.lease.expiresAt <= input.now) {
          return { status: "stale" };
        }
        const generation = current.generation + 1;
        if (!Number.isSafeInteger(generation)) {
          return { status: "corrupt", reason: "lease generation exhausted" };
        }
        const lease: X402BuyerSettlementLease = {
          owner: nonEmpty(input.owner, "x402 buyer recovery owner"),
          generation,
          stage: "replay",
          expiresAt: input.now + finitePositive(
            input.leaseDurationMs,
            input.leaseDurationMs,
            "x402 buyer recovery lease duration",
          ),
        };
        await writeRecord({
          ...clone(current),
          generation,
          lease,
          updatedAt: input.now,
        });
        return {
          status: "granted",
          intent: clone(current.intent),
          lease: clone(lease),
          ...(current.pendingDisclosure === undefined
            ? {}
            : { pendingDisclosure: clone(current.pendingDisclosure) }),
        };
      });
    },
    async recordDisclosure(input) {
      return withLock(input.settlementKey, async () => {
        const read = await readRecord(input.settlementKey);
        if (read.status === "absent") return { status: "stale" };
        if (read.status === "unsupported" || read.status === "corrupt") {
          return unavailableDisclosure(read);
        }
        const current = read.record;
        if (current.intent.bindingHash !== input.bindingHash) return { status: "conflict" };
        const terminal = terminalClaim(current);
        if (terminal) return terminal as X402BuyerDisclosureWrite;
        if (current.lease.owner !== input.lease.owner ||
            current.lease.generation !== input.lease.generation) {
          return { status: "stale" };
        }
        const disclosure = x402BuyerSettlementStoreInternals.captureDisclosure(
          input.disclosure,
        );
        if (disclosure.httpResource !== current.intent.httpResource) {
          return { status: "conflict" };
        }
        if (current.pendingDisclosure) {
          return canonicalize(current.pendingDisclosure) === canonicalize(disclosure)
            ? {
                status: "existing",
                intent: clone(current.intent),
                disclosure: clone(current.pendingDisclosure),
              }
            : { status: "conflict" };
        }
        await writeRecord({
          ...clone(current),
          pendingDisclosure: clone(disclosure),
          updatedAt: input.now,
        });
        return {
          status: "recorded",
          intent: clone(current.intent),
          disclosure: clone(disclosure),
        };
      });
    },
    async recordOutcome(input) {
      return withLock(input.settlementKey, async () => {
        const read = await readRecord(input.settlementKey);
        if (read.status === "absent") return { status: "stale" };
        if (read.status === "unsupported" || read.status === "corrupt") {
          return unavailableWrite(read);
        }
        const current = read.record;
        if (current.intent.bindingHash !== input.bindingHash) return { status: "conflict" };
        const terminal = terminalWrite(current);
        if (terminal) return terminal;
        if (current.lease.owner !== input.lease.owner ||
            current.lease.generation !== input.lease.generation ||
            current.lease.expiresAt <= input.now) {
          return { status: "stale" };
        }
        const outcome = x402BuyerSettlementStoreInternals.captureOutcome(
          input.outcome,
          current.intent,
        );
        if (current.pendingDisclosure && outcome.status === "captured") {
          const terminalDisclosure = {
            protocolVersion: outcome.settlement.protocolVersion,
            headerName: outcome.settlement.headerName,
            encodedSettlementHeader: outcome.settlement.encodedSettlementHeader,
            httpResource: outcome.settlement.httpResource,
          };
          if (canonicalize(current.pendingDisclosure) !== canonicalize(terminalDisclosure)) {
            return { status: "conflict" };
          }
        }
        await writeRecord({
          ...clone(current),
          outcome: clone(outcome),
          updatedAt: input.now,
        });
        return {
          status: "recorded",
          intent: clone(current.intent),
          outcome: clone(outcome),
        };
      });
    },
  };
}

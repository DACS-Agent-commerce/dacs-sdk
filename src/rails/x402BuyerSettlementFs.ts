import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";

import { sha256Hex } from "../canonical/index.js";
import { DacsError } from "../errors.js";
import {
  X402_BUYER_SETTLEMENT_STORE_VERSION,
  x402BuyerSettlementStoreInternals,
  type X402BuyerLeaseToken,
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
  const root = nonEmpty(options?.dir, "x402 buyer store directory");
  const lockTimeoutMs = finitePositive(
    options?.lockTimeoutMs,
    DEFAULT_LOCK_TIMEOUT_MS,
    "x402 buyer lockTimeoutMs",
  );
  const lockStaleMs = finitePositive(
    options?.lockStaleMs,
    DEFAULT_LOCK_STALE_MS,
    "x402 buyer lockStaleMs",
  );
  const lockPollMs = finitePositive(
    options?.lockPollMs,
    DEFAULT_LOCK_POLL_MS,
    "x402 buyer lockPollMs",
  );
  const recordsDir = join(root, "records");
  const locksDir = join(root, "locks");
  await mkdir(recordsDir, { recursive: true, mode: DIR_MODE });
  await mkdir(locksDir, { recursive: true, mode: DIR_MODE });

  const safe = (settlementKey: string): string => sha256Hex(settlementKey);
  const recordPath = (settlementKey: string): string =>
    join(recordsDir, `${safe(settlementKey)}.json`);
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
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", FILE_MODE);
      try {
        await handle.writeFile(JSON.stringify(value), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
      await syncDirectory(recordsDir);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  async function readOwner(path: string): Promise<LockOwner | null> {
    try {
      const parsed = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as unknown;
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

  async function maybeReclaimStale(path: string): Promise<boolean> {
    try {
      const metadata = await stat(path);
      if (Date.now() - metadata.mtimeMs <= lockStaleMs) return false;
      const owner = await readOwner(path);
      if (owner && processAlive(owner.pid)) return false;
      const quarantine = `${path}.${randomUUID()}.stale`;
      try {
        await rename(path, quarantine);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
        return false;
      }
      await rm(quarantine, { recursive: true, force: true });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  }

  async function wait(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
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
        await rename(candidate, path);
        break;
      } catch (error) {
        await rm(candidate, { recursive: true, force: true }).catch(() => {});
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY") {
          throw error;
        }
        await maybeReclaimStale(path);
        if (Date.now() >= deadline) {
          throw new DacsError("timed out acquiring x402 buyer settlement lock");
        }
        await wait(lockPollMs);
      }
    }
    try {
      return await operation();
    } finally {
      // Delete only the lock we still own. A stale reclaimer may have moved it.
      const observed = await readOwner(path);
      if (observed?.pid === owner.pid && observed.token === owner.token) {
        await rm(path, { recursive: true, force: true });
      }
    }
  }

  async function readRecord(settlementKey: string): Promise<StoreRead> {
    let text: string;
    try {
      text = await readFile(recordPath(settlementKey), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return { status: "corrupt", reason: "record is not valid JSON" };
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

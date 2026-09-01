import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { types as nodeTypes } from "node:util";

import { canonicalize, sha256Hex } from "../canonical/index.js";
import { DacsError } from "../errors.js";
import {
  x402PaywallSettlementKey,
  type X402PaywallSettlementClaim,
  type X402PaywallSettlementIntent,
  type X402PaywallSettlementLoad,
  type X402PaywallSettlementOutcome,
  type X402PaywallSettlementStore,
} from "./x402Paywall.js";

/** On-disk schema version for the seller x402 paywall settlement store. */
export const X402_PAYWALL_SETTLEMENT_STORE_VERSION = 1 as const;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_POLL_MS = 5;
const HASH_RE = /^[0-9a-f]{64}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export interface FsX402PaywallSettlementStoreOptions {
  /** Directory exclusively used for this settlement store. */
  dir: string;
  /** Maximum time spent waiting for another process. Defaults to 5 seconds. */
  lockTimeoutMs?: number;
  /** Age at which a lock owned by a dead process may be reclaimed. */
  lockStaleMs?: number;
  /** Contention polling interval. Defaults to 5 milliseconds. */
  lockPollMs?: number;
}

interface StoredRecord {
  storeVersion: typeof X402_PAYWALL_SETTLEMENT_STORE_VERSION;
  intent: X402PaywallSettlementIntent;
  outcome?: X402PaywallSettlementOutcome;
}

interface LockOwner {
  pid: number;
  token: string;
}

type StoreRead =
  | { status: "absent" }
  | { status: "ok"; record: StoredRecord };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      nodeTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactRecord(
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new DacsError(`${label} must be a plain record`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new DacsError(`${label} contains an unsupported field`);
    }
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new DacsError(`${label} fields must be enumerable data properties`);
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(descriptors, key)) {
      throw new DacsError(`${label} is missing a required field`);
    }
  }
  return value;
}

/**
 * `canonicalize` rejects non-JSON values, cycles, aliases with ambiguous NFC
 * keys, unsafe numbers, accessors and sparse/extended arrays. Its one useful
 * omission for artifact hashing is an object property whose value is
 * `undefined`; on disk that property would silently disappear, so reject it.
 */
function rejectUndefinedOrProxy(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (nodeTypes.isProxy(value)) throw new DacsError("settlement data cannot contain proxies");
  const object = value as object;
  if (ancestors.has(object)) throw new DacsError("settlement data cannot be cyclic");
  ancestors.add(object);
  try {
    for (const key of Reflect.ownKeys(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new DacsError("settlement data cannot contain accessors");
      }
      if (descriptor.value === undefined) {
        throw new DacsError("settlement data cannot contain undefined values");
      }
      rejectUndefinedOrProxy(descriptor.value, ancestors);
    }
  } finally {
    ancestors.delete(object);
  }
}

function canonicalSnapshot<T>(value: T): T {
  rejectUndefinedOrProxy(value);
  canonicalize(value);
  let snapshot: T;
  try {
    snapshot = structuredClone(value);
  } catch (error) {
    throw new DacsError("settlement data is not cloneable", { cause: error });
  }
  // Recheck the owned value so an exotic clone implementation cannot weaken
  // the exact JSON boundary used for durable storage.
  rejectUndefinedOrProxy(snapshot);
  canonicalize(snapshot);
  return snapshot;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DacsError(`${label} must be a non-empty string`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, fallback: number, label: string): number {
  const selected = value === undefined ? fallback : value;
  if (typeof selected !== "number" || !Number.isSafeInteger(selected) || selected <= 0) {
    throw new DacsError(`${label} must be a positive safe integer`);
  }
  return selected;
}

function snapshotOptions(value: unknown): Required<FsX402PaywallSettlementStoreOptions> {
  const options = exactRecord(value, "x402 paywall filesystem store options", ["dir"], [
    "lockTimeoutMs",
    "lockStaleMs",
    "lockPollMs",
  ]);
  for (const key of ["lockTimeoutMs", "lockStaleMs", "lockPollMs"] as const) {
    if (Object.prototype.hasOwnProperty.call(options, key) && options[key] === undefined) {
      throw new DacsError(`x402 paywall ${key} must be omitted, not undefined`);
    }
  }
  return {
    dir: nonEmptyString(options.dir, "x402 paywall store directory"),
    lockTimeoutMs: positiveSafeInteger(
      options.lockTimeoutMs,
      DEFAULT_LOCK_TIMEOUT_MS,
      "x402 paywall lockTimeoutMs",
    ),
    lockStaleMs: positiveSafeInteger(
      options.lockStaleMs,
      DEFAULT_LOCK_STALE_MS,
      "x402 paywall lockStaleMs",
    ),
    lockPollMs: positiveSafeInteger(
      options.lockPollMs,
      DEFAULT_LOCK_POLL_MS,
      "x402 paywall lockPollMs",
    ),
  };
}

function captureIntent(value: unknown): X402PaywallSettlementIntent {
  const record = exactRecord(value, "x402 paywall settlement intent", [
    "intentVersion",
    "settlementKey",
    "bindingHash",
    "jobId",
    "phaseIndex",
    "httpResource",
    "payer",
    "paymentHeader",
    "paymentPayload",
    "paymentRequirements",
    "sessionAuthorization",
  ], ["declaredExtensions"]);
  const hasDeclaredExtensions = Object.prototype.hasOwnProperty.call(
    record,
    "declaredExtensions",
  );
  if (record.intentVersion !== "2" ||
      typeof record.bindingHash !== "string" || !HASH_RE.test(record.bindingHash) ||
      typeof record.jobId !== "string" || record.jobId.length === 0 ||
      typeof record.phaseIndex !== "number" || !Number.isSafeInteger(record.phaseIndex) ||
      record.phaseIndex < 0 || Object.is(record.phaseIndex, -0) ||
      typeof record.httpResource !== "string" ||
      typeof record.payer !== "string" || !EVM_ADDRESS_RE.test(record.payer) ||
      typeof record.paymentHeader !== "string" || record.paymentHeader.length === 0 ||
      !isPlainRecord(record.paymentPayload) ||
      !isPlainRecord(record.paymentRequirements) ||
      record.sessionAuthorization === undefined ||
      (hasDeclaredExtensions && record.declaredExtensions === undefined) ||
      (record.declaredExtensions !== undefined &&
        !isPlainRecord(record.declaredExtensions))) {
    throw new DacsError("x402 paywall settlement intent shape is invalid");
  }
  const expectedKey = x402PaywallSettlementKey({
    jobId: record.jobId,
    phaseIndex: record.phaseIndex,
  });
  if (record.settlementKey !== expectedKey) {
    throw new DacsError("x402 paywall settlement intent key is invalid");
  }
  const core = canonicalSnapshot({
    intentVersion: "2" as const,
    settlementKey: expectedKey,
    jobId: record.jobId,
    phaseIndex: record.phaseIndex,
    httpResource: record.httpResource,
    payer: record.payer,
    paymentHeader: record.paymentHeader,
    paymentPayload: record.paymentPayload,
    paymentRequirements: record.paymentRequirements,
    sessionAuthorization: record.sessionAuthorization,
    ...(record.declaredExtensions === undefined
      ? {}
      : { declaredExtensions: record.declaredExtensions }),
  });
  if (sha256Hex(canonicalize(core)) !== record.bindingHash) {
    throw new DacsError("x402 paywall settlement intent binding is invalid");
  }
  return {
    ...core,
    bindingHash: record.bindingHash,
  } as unknown as X402PaywallSettlementIntent;
}

function captureOutcome(value: unknown): X402PaywallSettlementOutcome {
  const record = exactRecord(value, "x402 paywall settlement outcome", ["status"], [
    "reason",
    "settlement",
  ]);
  if (record.status === "settled") {
    if (Object.prototype.hasOwnProperty.call(record, "reason") ||
        !Object.prototype.hasOwnProperty.call(record, "settlement") ||
        !isPlainRecord(record.settlement) || record.settlement.success !== true) {
      throw new DacsError("x402 paywall settled outcome shape is invalid");
    }
    return canonicalSnapshot({
      status: "settled" as const,
      settlement: record.settlement,
    }) as X402PaywallSettlementOutcome;
  }
  if (record.status === "failed") {
    const hasSettlement = Object.prototype.hasOwnProperty.call(record, "settlement");
    if (typeof record.reason !== "string" || record.reason.length === 0 ||
        (hasSettlement && record.settlement === undefined) ||
        (record.settlement !== undefined &&
          (!isPlainRecord(record.settlement) || record.settlement.success !== false))) {
      throw new DacsError("x402 paywall failed outcome shape is invalid");
    }
    return canonicalSnapshot({
      status: "failed" as const,
      reason: record.reason,
      ...(record.settlement === undefined ? {} : { settlement: record.settlement }),
    }) as X402PaywallSettlementOutcome;
  }
  throw new DacsError("x402 paywall settlement outcome status is invalid");
}

function captureStoredRecord(value: unknown): StoredRecord {
  const record = exactRecord(value, "x402 paywall stored record", [
    "storeVersion",
    "intent",
  ], ["outcome"]);
  if (record.storeVersion !== X402_PAYWALL_SETTLEMENT_STORE_VERSION) {
    throw new DacsError("unsupported x402 paywall settlement store version");
  }
  if (Object.prototype.hasOwnProperty.call(record, "outcome") &&
      record.outcome === undefined) {
    throw new DacsError("x402 paywall stored outcome must be omitted, not undefined");
  }
  const intent = captureIntent(record.intent);
  const outcome = record.outcome === undefined ? undefined : captureOutcome(record.outcome);
  return {
    storeVersion: X402_PAYWALL_SETTLEMENT_STORE_VERSION,
    intent,
    ...(outcome === undefined ? {} : { outcome }),
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function loadResult(record: Readonly<StoredRecord>): X402PaywallSettlementLoad {
  if (!record.outcome) return { status: "held", intent: clone(record.intent) };
  return {
    status: record.outcome.status,
    intent: clone(record.intent),
    outcome: clone(record.outcome),
  };
}

function claimResult(record: Readonly<StoredRecord>): X402PaywallSettlementClaim {
  return loadResult(record) as X402PaywallSettlementClaim;
}

function unsupportedFilesystemOperation(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EINVAL" || code === "ENOSYS" || code === "ENOTSUP";
}

/**
 * Durable seller-side x402 settlement store. Mutations are serialized by a
 * per-key filesystem lock, and a terminal record is published with
 * fsync+rename before success is returned. Repeating an operation after its
 * response was lost therefore observes the exact retained intent/outcome.
 */
export async function createFsX402PaywallSettlementStore(
  rawOptions: FsX402PaywallSettlementStoreOptions,
): Promise<X402PaywallSettlementStore> {
  const options = snapshotOptions(rawOptions);
  const recordsDir = join(options.dir, "records");
  const locksDir = join(options.dir, "locks");
  const reclaimGatePath = join(locksDir, ".reclaim");
  const reclaimQuarantinePrefix = ".reclaim.";

  async function prepareOwnedDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: DIR_MODE });
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new DacsError("x402 paywall store path is not a safe directory");
    }
    try {
      await chmod(path, DIR_MODE);
    } catch (error) {
      if (!unsupportedFilesystemOperation(error)) throw error;
    }
  }

  await prepareOwnedDirectory(recordsDir);
  await prepareOwnedDirectory(locksDir);

  // Hashing the complete, exact key makes every filename a fixed ASCII token;
  // attacker-controlled job IDs can never traverse outside the owned folders.
  const safeKey = (settlementKey: string): string => sha256Hex(settlementKey);
  const recordPath = (settlementKey: string): string =>
    join(recordsDir, `${safeKey(settlementKey)}.json`);
  const lockPath = (settlementKey: string): string =>
    join(locksDir, `${safeKey(settlementKey)}.lock`);

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

  async function atomicWrite(path: string, value: Readonly<StoredRecord>): Promise<void> {
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

  async function readLockOwner(path: string): Promise<LockOwner | null> {
    try {
      const parsed = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as unknown;
      if (isPlainRecord(parsed) && Number.isSafeInteger(parsed.pid) &&
          (parsed.pid as number) > 0 && typeof parsed.token === "string" &&
          parsed.token.length > 0) {
        return { pid: parsed.pid as number, token: parsed.token };
      }
    } catch {
      // A missing or malformed owner is reclaimable only after the stale age.
    }
    return null;
  }

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

  async function readFileOwner(path: string): Promise<LockOwner | null> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (isPlainRecord(parsed) && Number.isSafeInteger(parsed.pid) &&
          (parsed.pid as number) > 0 && typeof parsed.token === "string" &&
          parsed.token.length > 0) {
        return { pid: parsed.pid as number, token: parsed.token };
      }
    } catch {
      // Missing or malformed recovery gates remain authoritative until stale.
    }
    return null;
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
      // A hard link publishes complete bytes without an empty-file window.
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
        const owner = await readFileOwner(path);
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
    const observedOwner = await readFileOwner(reclaimGatePath);
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
    const movedOwner = await readFileOwner(quarantine);
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
    const observed = await readFileOwner(reclaimGatePath);
    if (observed?.pid === owner.pid && observed.token === owner.token) {
      const quarantine = reclaimQuarantinePath();
      try {
        await rename(reclaimGatePath, quarantine);
        const moved = await readFileOwner(quarantine);
        if (moved?.pid === owner.pid && moved.token === owner.token) {
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
      const quarantined = await readFileOwner(path);
      if (quarantined?.pid === owner.pid && quarantined.token === owner.token) {
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

  async function maybeReclaimStale(path: string): Promise<boolean> {
    try {
      const metadata = await stat(path);
      if (Date.now() - metadata.mtimeMs <= options.lockStaleMs) return false;
      const owner = await readLockOwner(path);
      if (owner && processIsAlive(owner.pid)) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }

    const gateOwner: LockOwner = { pid: process.pid, token: randomUUID() };
    if (!await acquireReclaimGate(gateOwner)) return false;
    try {
      let observed;
      try {
        observed = await stat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
        throw error;
      }
      if (Date.now() - observed.mtimeMs <= options.lockStaleMs) return false;
      const observedOwner = await readLockOwner(path);
      if (observedOwner !== null && processIsAlive(observedOwner.pid)) return false;

      const quarantine = `${path}.${randomUUID()}.stale`;
      try {
        await rename(path, quarantine);
        await syncDirectory(locksDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
        throw error;
      }
      const moved = await stat(quarantine);
      const movedOwner = await readLockOwner(quarantine);
      if (moved.dev !== observed.dev || moved.ino !== observed.ino ||
          !sameOwner(movedOwner, observedOwner) ||
          Date.now() - moved.mtimeMs <= options.lockStaleMs ||
          (movedOwner !== null && processIsAlive(movedOwner.pid))) {
        throw new DacsError("x402 paywall lock changed during stale recovery");
      }
      await rm(quarantine, { recursive: true, force: true });
      await syncDirectory(locksDir);
      return true;
    } finally {
      await releaseReclaimGate(gateOwner);
    }
  }

  async function wait(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }

  async function publishLockCandidate(candidate: string, path: string): Promise<boolean> {
    // Stale recovery observes and renames `path` while holding this gate. A
    // normal successor must use the same transition gate or it can replace the
    // observed path immediately before the reclaimer's rename.
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

  async function withLock<T>(settlementKey: string, operation: () => Promise<T>): Promise<T> {
    const path = lockPath(settlementKey);
    const owner: LockOwner = { pid: process.pid, token: randomUUID() };
    const deadline = Date.now() + options.lockTimeoutMs;
    while (true) {
      // Publish a complete lock directory in one rename. Publishing an empty
      // final directory before owner.json creates a stale-reclamation race.
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
          throw new DacsError("timed out acquiring x402 paywall settlement lock");
        }
        await wait(options.lockPollMs);
      } finally {
        await rm(candidate, { recursive: true, force: true }).catch(() => {});
      }
    }
    try {
      return await operation();
    } finally {
      // Atomically move our lock away from the publication path before
      // deleting it. Deleting owner.json and then rmdir(path) in place races a
      // successor that publishes between those two filesystem operations.
      const observed = await readLockOwner(path);
      if (observed?.pid === owner.pid && observed.token === owner.token) {
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

  async function readRecord(settlementKey: string): Promise<StoreRead> {
    const path = recordPath(settlementKey);
    let text: string;
    try {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile()) throw new DacsError("x402 paywall record is not a file");
        text = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new DacsError("x402 paywall record path is unsafe");
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new DacsError("x402 paywall settlement record is corrupt");
    }
    // This version writes one exact JSON representation. A different spelling
    // (including duplicate members that JSON.parse would silently collapse)
    // did not come from an atomic write by this implementation.
    if (JSON.stringify(parsed) !== text) {
      throw new DacsError("x402 paywall settlement record is corrupt");
    }
    if (!isPlainRecord(parsed) || typeof parsed.storeVersion !== "number") {
      throw new DacsError("x402 paywall settlement record is corrupt");
    }
    if (parsed.storeVersion !== X402_PAYWALL_SETTLEMENT_STORE_VERSION) {
      throw new DacsError("unsupported x402 paywall settlement store version");
    }
    let record: StoredRecord;
    try {
      record = captureStoredRecord(parsed);
    } catch (error) {
      throw new DacsError("x402 paywall settlement record is corrupt", { cause: error });
    }
    if (record.intent.settlementKey !== settlementKey) {
      throw new DacsError("x402 paywall settlement record key is corrupt");
    }
    return { status: "ok", record };
  }

  async function writeRecord(record: Readonly<StoredRecord>): Promise<void> {
    const captured = captureStoredRecord(record);
    await atomicWrite(recordPath(captured.intent.settlementKey), captured);
  }

  return {
    async load(rawSettlementKey) {
      const settlementKey = nonEmptyString(rawSettlementKey, "x402 paywall settlement key");
      const read = await readRecord(settlementKey);
      return read.status === "absent" ? read : loadResult(read.record);
    },

    async claim(rawIntent) {
      // Snapshot every authority-bearing byte before the first await.
      const intent = captureIntent(rawIntent);
      return withLock(intent.settlementKey, async () => {
        const read = await readRecord(intent.settlementKey);
        if (read.status === "absent") {
          await writeRecord({
            storeVersion: X402_PAYWALL_SETTLEMENT_STORE_VERSION,
            intent,
          });
          return { status: "claimed", intent: clone(intent) };
        }
        if (read.record.intent.bindingHash !== intent.bindingHash) {
          return { status: "conflict" };
        }
        return claimResult(read.record);
      });
    },

    async recordOutcome(rawInput) {
      const input = exactRecord(rawInput, "x402 paywall recordOutcome input", [
        "settlementKey",
        "bindingHash",
        "outcome",
      ]);
      const settlementKey = nonEmptyString(
        input.settlementKey,
        "x402 paywall settlement key",
      );
      const bindingHash = nonEmptyString(input.bindingHash, "x402 paywall binding hash");
      if (!HASH_RE.test(bindingHash)) {
        throw new DacsError("x402 paywall binding hash is invalid");
      }
      const outcome = captureOutcome(input.outcome);
      return withLock(settlementKey, async () => {
        const read = await readRecord(settlementKey);
        if (read.status === "absent" || read.record.intent.bindingHash !== bindingHash) {
          return { status: "conflict" };
        }
        if (read.record.outcome) {
          if (canonicalize(read.record.outcome) !== canonicalize(outcome)) {
            return { status: "conflict" };
          }
          return claimResult(read.record);
        }
        const updated: StoredRecord = {
          storeVersion: X402_PAYWALL_SETTLEMENT_STORE_VERSION,
          intent: read.record.intent,
          outcome,
        };
        await writeRecord(updated);
        return claimResult(updated);
      });
    },
  };
}

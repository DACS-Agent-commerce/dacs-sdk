import { randomBytes, randomUUID } from "node:crypto";
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

import { sha256Hex } from "../canonical/index.js";
import { DacsError } from "../errors.js";
import {
  atomicWritePrivateFile,
  exclusiveWritePrivateFile,
  preparePrivateStoreDirectory,
  readPrivateFile,
} from "../filesystem/privateStore.js";
import {
  isSellerFulfilmentHandoff,
  isValidSellerReceiptClaim,
  sellerReceiptStoreInternals,
  type SellerFulfilmentHandoff,
  type SellerFulfilmentReceiptStore,
  type SellerReceiptClaim,
  type SellerReceiptClaimResult,
  type SellerReceiptInspectionResult,
  type SellerReceiptPermitResult,
} from "./paymentIntake.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_POLL_MS = 5;
const PERMIT_RE = /^seller-payment:[A-Za-z0-9_-]{43}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const STATE_FILE = "seller-receipts.json";
const INITIALIZATION_FILE = "seller-receipts.initialized";
const LOCK_DIR = "seller-receipts.lock";
const RECLAIM_GATE = "seller-receipts.reclaim";
const RECLAIM_QUARANTINE_PREFIX = `${RECLAIM_GATE}.`;
const INITIALIZATION_TEXT = JSON.stringify({
  markerVersion: 1,
  stateFile: STATE_FILE,
});

/** On-disk schema version for {@link createFsSellerReceiptStore}. */
export const SELLER_RECEIPT_STORE_VERSION = 1 as const;

export interface FsSellerReceiptStoreOptions {
  /** Directory owned by this store. It is created and restricted to mode 0700. */
  dir: string;
  lockTimeoutMs?: number;
  lockStaleMs?: number;
  lockPollMs?: number;
}

interface FsConsumedReceipt {
  permitId: string;
  claim: SellerReceiptClaim;
  handoff: SellerFulfilmentHandoff;
}

interface FsStoredReceipt {
  selected: SellerReceiptClaim;
  pendingPermitId?: string;
  consumed?: FsConsumedReceipt;
}

interface FsSellerReceiptState {
  storeVersion: typeof SELLER_RECEIPT_STORE_VERSION;
  records: Record<string, FsStoredReceipt>;
  /** SHA-256 permit index. Raw bearer capabilities remain only in mode-0600 state. */
  permits: Record<string, string>;
}

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

function own(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => own(value, key));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function positiveSafeInteger(value: unknown, fallback: number, label: string): number {
  const selected = value === undefined ? fallback : value;
  if (typeof selected !== "number" || !Number.isSafeInteger(selected) || selected <= 0) {
    throw new DacsError(`${label} must be a positive safe integer`);
  }
  return selected;
}

function captureOptions(value: unknown): FsSellerReceiptStoreOptions {
  if (!plainRecord(value)) {
    throw new DacsError("filesystem seller receipt store options must be a plain object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(["dir", "lockTimeoutMs", "lockStaleMs", "lockPollMs"]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new DacsError("filesystem seller receipt store option is unsupported");
    }
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
      throw new DacsError("filesystem seller receipt store option must be a data property");
    }
  }
  const dir = descriptors.dir?.value;
  if (typeof dir !== "string" || dir.length === 0 || dir.trim() !== dir) {
    throw new DacsError("filesystem seller receipt store dir must be a non-empty string");
  }
  for (const optional of ["lockTimeoutMs", "lockStaleMs", "lockPollMs"] as const) {
    if (own(value, optional) && descriptors[optional]?.value === undefined) {
      throw new DacsError(`filesystem seller receipt store ${optional} must be omitted, not undefined`);
    }
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

function recordKey(settlementId: string): string {
  return sha256Hex(`dacs-seller-receipt-record:v1:${settlementId}`);
}

function permitKey(permitId: string): string {
  return sha256Hex(`dacs-seller-receipt-permit:v1:${permitId}`);
}

function corruptState(): never {
  // Do not include receipt ids, permits, paths, or parsed values in this error.
  throw new DacsError("filesystem seller receipt store state is corrupt");
}

function unsupportedState(version: number): never {
  throw new DacsError(
    `filesystem seller receipt store version ${version} is unsupported`,
  );
}

/** Reject values whose exact structured-clone representation JSON cannot retain. */
function assertDurableJson(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): void {
  if (depth > 256) throw new DacsError("seller receipt state exceeds the durable depth limit");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new DacsError("seller receipt state contains a non-durable number");
    }
    return;
  }
  if (typeof value !== "object") {
    throw new DacsError("seller receipt state contains a non-durable value");
  }
  if (seen.has(value)) throw new DacsError("seller receipt state contains a cycle");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(value).some((key) =>
        key !== "length" &&
        (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)))) {
        throw new DacsError("seller receipt state contains a non-durable array");
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
          throw new DacsError("seller receipt state contains a sparse or accessor array");
        }
        assertDurableJson(descriptor.value, seen, depth + 1);
      }
      return;
    }
    if (!plainRecord(value)) {
      throw new DacsError("seller receipt state contains a non-plain value");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new DacsError("seller receipt state contains a symbol property");
      }
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
        throw new DacsError("seller receipt state contains a hidden or accessor property");
      }
      assertDurableJson(descriptor.value, seen, depth + 1);
    }
  } finally {
    seen.delete(value);
  }
}

function cloneClaim(value: SellerReceiptClaim): SellerReceiptClaim {
  return structuredClone(value);
}

function cloneHandoff(value: SellerFulfilmentHandoff): SellerFulfilmentHandoff {
  return structuredClone(value);
}

function emptyState(): FsSellerReceiptState {
  return {
    storeVersion: SELLER_RECEIPT_STORE_VERSION,
    records: Object.create(null) as Record<string, FsStoredReceipt>,
    permits: Object.create(null) as Record<string, string>,
  };
}

function captureState(value: unknown): FsSellerReceiptState {
  if (!plainRecord(value) || typeof value.storeVersion !== "number") corruptState();
  if (value.storeVersion !== SELLER_RECEIPT_STORE_VERSION) {
    unsupportedState(value.storeVersion);
  }
  if (!hasExactKeys(value, ["storeVersion", "records", "permits"]) ||
      !plainRecord(value.records) || !plainRecord(value.permits)) corruptState();

  const records = value.records;
  const permits = value.permits;
  const expectedPermits = new Map<string, string>();

  const registerPermit = (rawPermit: string, key: string): void => {
    if (!PERMIT_RE.test(rawPermit)) corruptState();
    const hashed = permitKey(rawPermit);
    const prior = expectedPermits.get(hashed);
    if (prior !== undefined && prior !== key) corruptState();
    expectedPermits.set(hashed, key);
  };

  for (const [key, rawStored] of Object.entries(records)) {
    if (!HASH_RE.test(key) || !plainRecord(rawStored) ||
        !hasOnlyKeys(rawStored, ["selected", "pendingPermitId", "consumed"]) ||
        !own(rawStored, "selected") || !isValidSellerReceiptClaim(rawStored.selected) ||
        recordKey(rawStored.selected.settlementId) !== key) corruptState();

    const hasPending = own(rawStored, "pendingPermitId");
    const hasConsumed = own(rawStored, "consumed");
    if (hasPending === hasConsumed) corruptState();
    if (hasPending) {
      if (typeof rawStored.pendingPermitId !== "string") corruptState();
      registerPermit(rawStored.pendingPermitId, key);
      continue;
    }

    const consumed = rawStored.consumed;
    if (!plainRecord(consumed) ||
        !hasExactKeys(consumed, ["permitId", "claim", "handoff"]) ||
        typeof consumed.permitId !== "string" ||
        !isValidSellerReceiptClaim(consumed.claim) ||
        !isSellerFulfilmentHandoff(consumed.handoff) ||
        consumed.claim.settlementId !== rawStored.selected.settlementId) corruptState();
    registerPermit(consumed.permitId, key);
  }

  if (Object.keys(permits).length !== expectedPermits.size) corruptState();
  for (const [hashed, key] of Object.entries(permits)) {
    if (!HASH_RE.test(hashed) || typeof key !== "string" || !own(records, key) ||
        expectedPermits.get(hashed) !== key) corruptState();
  }

  assertDurableJson(value);
  return value as unknown as FsSellerReceiptState;
}

/**
 * Filesystem-backed seller payment receipt store.
 *
 * One global mkdir lock serializes the complete SB-2 state machine across
 * processes. A single fsync+rename commit retains selection, the opaque permit,
 * its exact authorization and the fulfilment handoff together, so recovery can
 * never observe a consumed capability without its resumable work.
 */
export async function createFsSellerReceiptStore(
  options: FsSellerReceiptStoreOptions,
): Promise<SellerFulfilmentReceiptStore> {
  const capturedOptions = captureOptions(options);
  const lockTimeoutMs = positiveSafeInteger(
    capturedOptions.lockTimeoutMs,
    DEFAULT_LOCK_TIMEOUT_MS,
    "seller receipt lockTimeoutMs",
  );
  const lockStaleMs = positiveSafeInteger(
    capturedOptions.lockStaleMs,
    DEFAULT_LOCK_STALE_MS,
    "seller receipt lockStaleMs",
  );
  const lockPollMs = positiveSafeInteger(
    capturedOptions.lockPollMs,
    DEFAULT_LOCK_POLL_MS,
    "seller receipt lockPollMs",
  );
  const root = await preparePrivateStoreDirectory(
    capturedOptions.dir,
    "filesystem seller receipt store",
  );
  const statePath = join(root, STATE_FILE);
  const initializationPath = join(root, INITIALIZATION_FILE);
  const lockPath = join(root, LOCK_DIR);
  const reclaimGatePath = join(root, RECLAIM_GATE);

  async function syncDirectory(path: string): Promise<void> {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async function syncRoot(): Promise<void> {
    await syncDirectory(root);
  }

  async function readInitializationMarker(): Promise<"absent" | "present"> {
    let text: string;
    try {
      text = await readPrivateFile(
        initializationPath,
        "utf8",
        "filesystem seller receipt store marker",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new DacsError(
          "filesystem seller receipt store initialization marker path is unsafe",
        );
      }
      if (error instanceof DacsError && error.message.includes("not a regular file")) {
        throw new DacsError(
          "filesystem seller receipt store initialization marker is corrupt",
          { cause: error },
        );
      }
      throw error;
    }
    if (text !== INITIALIZATION_TEXT) {
      throw new DacsError("filesystem seller receipt store initialization marker is corrupt");
    }
    return "present";
  }

  /** Publish only after a state file has itself been renamed and directory-fsynced. */
  async function ensureInitializationMarker(): Promise<void> {
    if (await readInitializationMarker() === "present") return;
    try {
      await exclusiveWritePrivateFile(
        initializationPath,
        INITIALIZATION_TEXT,
        "filesystem seller receipt store marker",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await readInitializationMarker() !== "present") {
        throw new DacsError(
          "filesystem seller receipt store initialization marker is corrupt",
        );
      }
    }
  }

  async function atomicWriteState(state: FsSellerReceiptState): Promise<void> {
    captureState(state);
    const text = JSON.stringify(state);
    await atomicWritePrivateFile(
      statePath,
      text,
      "filesystem seller receipt store",
    );
    // State durability is the precondition for publishing the marker. A crash
    // between these operations leaves a migratable pre-marker state.
    await ensureInitializationMarker();
  }

  async function readState(): Promise<FsSellerReceiptState> {
    const initialization = await readInitializationMarker();
    let text: string;
    try {
      text = await readPrivateFile(
        statePath,
        "utf8",
        "filesystem seller receipt store",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (initialization === "present") corruptState();
        return emptyState();
      }
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new DacsError("filesystem seller receipt store state path is unsafe");
      }
      if (error instanceof DacsError && error.message.includes("not a regular file")) {
        return corruptState();
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return corruptState();
    }
    // This implementation writes one exact JSON representation. Duplicate
    // members or alternate whitespace did not come from its atomic writer and
    // must not be allowed to erase a retained permit after JSON.parse collapse.
    if (JSON.stringify(parsed) !== text) corruptState();
    const state = captureState(parsed);
    // A valid pre-marker file is either a legacy store or the safe crash point
    // after state publication. Establish the marker only after full validation.
    if (initialization === "absent") await ensureInitializationMarker();
    return state;
  }

  async function readOwner(path: string): Promise<LockOwner | null> {
    try {
      const parsed = JSON.parse(await readPrivateFile(
        join(path, "owner.json"),
        "utf8",
        "filesystem seller receipt store lock",
      )) as unknown;
      if (plainRecord(parsed) && Number.isSafeInteger(parsed.pid) &&
          (parsed.pid as number) > 0 && typeof parsed.token === "string" &&
          parsed.token.length > 0) {
        return { pid: parsed.pid as number, token: parsed.token };
      }
    } catch {
      // Missing or malformed owners remain locked until their directory is stale.
    }
    return null;
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
      // A valid gate is non-empty, so rename is an atomic no-overwrite publish.
      await rename(candidate, path);
      await syncRoot();
    } finally {
      await rm(candidate, { recursive: true, force: true });
    }
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

  function reclaimQuarantinePath(): string {
    return join(root, `${RECLAIM_QUARANTINE_PREFIX}${randomUUID()}.quarantine`);
  }

  async function reclaimGateQuarantines(): Promise<string[]> {
    const names = (await readdir(root)).filter((name) =>
      name.startsWith(RECLAIM_QUARANTINE_PREFIX) && name.endsWith(".quarantine"));
    const live: string[] = [];
    for (const name of names) {
      const path = join(root, name);
      try {
        const metadata = await stat(path);
        const owner = await readOwner(path);
        if (Date.now() - metadata.mtimeMs <= lockStaleMs ||
            (owner !== null && processAlive(owner.pid))) {
          live.push(path);
          continue;
        }
        await rm(path, { recursive: true, force: true });
        await syncRoot();
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
      await syncRoot();
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
      await syncRoot();
    }
    // A moved replacement is left in its unique quarantine. It continues to
    // block reclaimers and its live owner can remove it by token on release.
  }

  async function releaseReclaimGate(owner: LockOwner): Promise<void> {
    const observed = await readOwner(reclaimGatePath);
    if (observed?.pid === owner.pid && observed.token === owner.token) {
      const quarantine = reclaimQuarantinePath();
      try {
        await rename(reclaimGatePath, quarantine);
        await syncRoot();
        const moved = await readOwner(quarantine);
        if (moved?.pid === owner.pid && moved.token === owner.token) {
          await rm(quarantine, { recursive: true, force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const name of (await readdir(root)).filter((item) =>
      item.startsWith(RECLAIM_QUARANTINE_PREFIX) && item.endsWith(".quarantine"))) {
      const path = join(root, name);
      const quarantined = await readOwner(path);
      if (quarantined?.pid === owner.pid && quarantined.token === owner.token) {
        await rm(path, { recursive: true, force: true });
      }
    }
    await syncRoot();
  }

  async function acquireReclaimGate(owner: LockOwner): Promise<boolean> {
    if ((await reclaimGateQuarantines()).length > 0) return false;
    try {
      await publishCompleteOwner(reclaimGatePath, owner);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      await quarantineStaleReclaimGate();
      return false;
    }
    if ((await reclaimGateQuarantines()).length > 0) {
      await releaseReclaimGate(owner);
      return false;
    }
    return true;
  }

  async function maybeReclaimStale(path: string, deadline: number): Promise<void> {
    // This fast path never authorizes deletion. Every observation is repeated
    // after obtaining the cross-process recovery gate below.
    try {
      const metadata = await stat(path);
      if (Date.now() - metadata.mtimeMs <= lockStaleMs) return;
      const owner = await readOwner(path);
      if (owner && processAlive(owner.pid)) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    await withLockMutationGate(deadline, async () => {
      let observed;
      try {
        observed = await stat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (Date.now() - observed.mtimeMs <= lockStaleMs) return;
      const observedOwner = await readOwner(path);
      if (observedOwner !== null && processAlive(observedOwner.pid)) return;

      const quarantine = `${path}.${randomUUID()}.stale`;
      try {
        await rename(path, quarantine);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const moved = await stat(quarantine);
      const movedOwner = await readOwner(quarantine);
      if (moved.dev !== observed.dev || moved.ino !== observed.ino ||
          !sameOwner(movedOwner, observedOwner) ||
          Date.now() - moved.mtimeMs <= lockStaleMs ||
          (movedOwner !== null && processAlive(movedOwner.pid))) {
        throw new DacsError("filesystem seller receipt lock changed during recovery");
      }
      await rm(quarantine, { recursive: true, force: true });
      await syncRoot();
    });
  }

  async function wait(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Publication, owner-checked release and stale quarantine must all use this
   * gate. Gating reclaimers alone lets a normal successor replace the path
   * between a reclaimer's observations and rename.
   */
  async function withLockMutationGate<T>(
    deadline: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    const owner: LockOwner = { pid: process.pid, token: randomUUID() };
    while (!await acquireReclaimGate(owner)) {
      if (Date.now() >= deadline) {
        throw new DacsError("timed out acquiring seller receipt lock mutation gate");
      }
      await wait(lockPollMs);
    }
    try {
      return await operation();
    } finally {
      await releaseReclaimGate(owner);
    }
  }

  async function withLock<T>(operation: () => Promise<T>): Promise<T> {
    const owner: LockOwner = { pid: process.pid, token: randomUUID() };
    const deadline = Date.now() + lockTimeoutMs;
    while (true) {
      const candidate = `${lockPath}.${randomUUID()}.candidate`;
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
          await rename(candidate, lockPath);
          await syncRoot();
        });
        break;
      } catch (error) {
        await rm(candidate, { recursive: true, force: true }).catch(() => {});
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
        await maybeReclaimStale(lockPath, deadline);
        if (Date.now() >= deadline) {
          throw new DacsError("timed out acquiring filesystem seller receipt store lock");
        }
        await wait(lockPollMs);
      }
    }
    try {
      return await operation();
    } finally {
      let released: string | undefined;
      await withLockMutationGate(Date.now() + lockTimeoutMs, async () => {
        const observed = await readOwner(lockPath);
        if (observed?.pid === owner.pid && observed.token === owner.token) {
          // Move only the lock we still own away from the publication path.
          released = `${lockPath}.${owner.token}.released`;
          try {
            await rename(lockPath, released);
            await syncRoot();
          } catch (error) {
            released = undefined;
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      });
      if (released !== undefined) {
        await rm(released, { recursive: true, force: true });
        await syncRoot();
      }
    }
  }

  function newPermit(state: FsSellerReceiptState): string {
    for (let attempt = 0; attempt < 128; attempt += 1) {
      const candidate = `seller-payment:${randomBytes(32).toString("base64url")}`;
      if (!own(state.permits, permitKey(candidate))) return candidate;
    }
    throw new DacsError("could not allocate an unpredictable seller payment permit");
  }

  function install(
    state: FsSellerReceiptState,
    key: string,
    claim: SellerReceiptClaim,
  ): FsStoredReceipt {
    const pendingPermitId = newPermit(state);
    const stored: FsStoredReceipt = { selected: cloneClaim(claim), pendingPermitId };
    state.records[key] = stored;
    state.permits[permitKey(pendingPermitId)] = key;
    return stored;
  }

  function replacePendingSelection(
    state: FsSellerReceiptState,
    key: string,
    stored: FsStoredReceipt,
    claim: SellerReceiptClaim,
  ): string {
    if (stored.pendingPermitId) delete state.permits[permitKey(stored.pendingPermitId)];
    const pendingPermitId = newPermit(state);
    stored.selected = cloneClaim(claim);
    stored.pendingPermitId = pendingPermitId;
    state.permits[permitKey(pendingPermitId)] = key;
    return pendingPermitId;
  }

  function locatePermit(
    state: FsSellerReceiptState,
    candidatePermitId: string,
  ): FsStoredReceipt | null {
    const key = state.permits[permitKey(candidatePermitId)];
    if (!key) return null;
    const stored = state.records[key];
    if (!stored) return null;
    if (stored.pendingPermitId === candidatePermitId ||
        stored.consumed?.permitId === candidatePermitId) return stored;
    // A SHA-256 collision never substitutes authority.
    return null;
  }

  return Object.freeze({
    async claim(input: Readonly<SellerReceiptClaim>): Promise<SellerReceiptClaimResult> {
      if (!isValidSellerReceiptClaim(input)) {
        throw new TypeError("seller receipt claim is malformed or internally inconsistent");
      }
      const candidate = cloneClaim(input);
      assertDurableJson(candidate);
      return withLock(async () => {
        const state = await readState();
        const key = recordKey(candidate.settlementId);
        const existing = state.records[key];
        if (!existing) {
          const stored = install(state, key, candidate);
          await atomicWriteState(state);
          return {
            status: "claimed",
            permitId: stored.pendingPermitId!,
            claim: cloneClaim(stored.selected),
          };
        }
        if (existing.selected.settlementId !== candidate.settlementId) corruptState();

        const order = sellerReceiptStoreInternals.winnerOrder(
          candidate,
          existing.selected,
        );
        const sameSelectedSession = existing.selected.jobId === candidate.jobId &&
          existing.selected.phaseIndex === candidate.phaseIndex;
        const sameAuthorizationScope =
          sellerReceiptStoreInternals.sameSelectedAuthorizationScope(
            existing.selected,
            candidate,
          );

        if (existing.consumed &&
            sellerReceiptStoreInternals.sameClaimAuthorizationScope(
              existing.consumed.claim,
              candidate,
            ) &&
            sellerReceiptStoreInternals.isCanonicalReplayWinner(
              existing.consumed.claim,
              candidate,
            )) {
          return {
            status: "already-consumed",
            permitId: existing.consumed.permitId,
            claim: cloneClaim(existing.consumed.claim),
          };
        }
        if (sameSelectedSession && !sameAuthorizationScope) {
          return {
            status: "conflict",
            reason: "authorization-scope-conflict",
            existing: cloneClaim(existing.selected),
            ...(existing.consumed
              ? { consumed: cloneClaim(existing.consumed.claim) }
              : {}),
          };
        }
        if (order < 0) {
          existing.selected = cloneClaim(candidate);
          if (existing.consumed) {
            await atomicWriteState(state);
            return {
              status: "conflict",
              reason: "winner-already-consumed",
              existing: cloneClaim(existing.selected),
              consumed: cloneClaim(existing.consumed.claim),
            };
          }
          const nextPermitId = replacePendingSelection(
            state,
            key,
            existing,
            candidate,
          );
          await atomicWriteState(state);
          return {
            status: "claimed",
            permitId: nextPermitId,
            claim: cloneClaim(existing.selected),
          };
        }
        if (sellerReceiptStoreInternals.exactClaim(existing.selected, candidate) ||
            (sameSelectedSession && sameAuthorizationScope)) {
          if (existing.consumed) {
            if (!sellerReceiptStoreInternals.exactClaim(
              existing.selected,
              existing.consumed.claim,
            )) {
              return {
                status: "conflict",
                reason: "winner-already-consumed",
                existing: cloneClaim(existing.selected),
                consumed: cloneClaim(existing.consumed.claim),
              };
            }
            return {
              status: "conflict",
              reason: "lower-priority",
              existing: cloneClaim(existing.selected),
              consumed: cloneClaim(existing.consumed.claim),
            };
          }
          if (!existing.pendingPermitId) corruptState();
          return {
            status: "already-claimed",
            permitId: existing.pendingPermitId,
            claim: cloneClaim(existing.selected),
          };
        }
        return {
          status: "conflict",
          reason: "lower-priority",
          existing: cloneClaim(existing.selected),
          ...(existing.consumed
            ? { consumed: cloneClaim(existing.consumed.claim) }
            : {}),
        };
      });
    },

    async inspectPermit(candidatePermitId: string): Promise<SellerReceiptInspectionResult> {
      if (typeof candidatePermitId !== "string") return { status: "invalid" };
      return withLock(async () => {
        const state = await readState();
        const stored = locatePermit(state, candidatePermitId);
        if (!stored) return { status: "invalid" };
        if (stored.consumed?.permitId === candidatePermitId) {
          return {
            status: "already-consumed",
            claim: cloneClaim(stored.consumed.claim),
            handoff: cloneHandoff(stored.consumed.handoff),
          };
        }
        if (stored.pendingPermitId !== candidatePermitId || stored.consumed) {
          return { status: "invalid" };
        }
        return { status: "available", claim: cloneClaim(stored.selected) };
      });
    },

    async consumePermit(
      candidatePermitId: string,
      handoffInput: Readonly<SellerFulfilmentHandoff>,
    ): Promise<SellerReceiptPermitResult> {
      if (!isSellerFulfilmentHandoff(handoffInput)) {
        throw new TypeError("seller fulfilment handoff is malformed");
      }
      const handoff = cloneHandoff(handoffInput);
      assertDurableJson(handoff);
      if (typeof candidatePermitId !== "string") return { status: "invalid" };
      return withLock(async () => {
        const state = await readState();
        const stored = locatePermit(state, candidatePermitId);
        if (!stored) return { status: "invalid" };
        if (stored.consumed?.permitId === candidatePermitId) {
          return {
            status: "already-consumed",
            claim: cloneClaim(stored.consumed.claim),
            handoff: cloneHandoff(stored.consumed.handoff),
          };
        }
        if (stored.pendingPermitId !== candidatePermitId || stored.consumed) {
          return { status: "invalid" };
        }
        stored.consumed = {
          permitId: candidatePermitId,
          claim: cloneClaim(stored.selected),
          handoff,
        };
        delete stored.pendingPermitId;
        await atomicWriteState(state);
        return {
          status: "consumed",
          claim: cloneClaim(stored.consumed.claim),
          handoff: cloneHandoff(stored.consumed.handoff),
        };
      });
    },
  });
}

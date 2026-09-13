import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { types as nodeTypes } from "node:util";

import { canonicalize } from "../canonical/index.js";
import { DacsError } from "../errors.js";
import type {
  WalletSpendStateStore,
  WalletSpendStateV1,
} from "./walletSpendAuthority.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_POLL_MS = 10;
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const STORE_FORMAT_VERSION = 1 as const;

export interface FsWalletSpendStateStoreOptionsV1 {
  /** Private host-local directory. Network filesystems require another store. */
  dir: string;
  /** At least 32 secret bytes, loaded independently of this directory. */
  integrityKey: Uint8Array;
  lockTimeoutMs?: number;
  lockStaleMs?: number;
  lockPollMs?: number;
}

interface StoredEnvelopeV1 {
  formatVersion: typeof STORE_FORMAT_VERSION;
  scope: string;
  state: Readonly<WalletSpendStateV1>;
  mac: string;
}

interface InitializationMarkerV1 {
  markerVersion: typeof STORE_FORMAT_VERSION;
  scope: string;
  mac: string;
}

interface LockOwnerV1 {
  pid: number;
  hostname: string;
  token: string;
  createdAt: number;
}

interface LockMutationGateOwnerV1 {
  pid: number;
  hostname: string;
  token: string;
  createdAt: number;
}

interface CapturedFsOptionsV1 {
  dir: string;
  integrityKey: Uint8Array;
  lockTimeoutMs: number;
  lockStaleMs: number;
  lockPollMs: number;
}

const HASH_RE = /^[0-9a-f]{64}$/;

function nestedErrorCode(value: unknown): string | undefined {
  let current = value;
  for (let depth = 0; depth < 4 && current !== null &&
      typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

function safePositive(value: unknown, fallback: number, label: string): number {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || (result as number) <= 0) {
    throw new DacsError(`${label} must be a positive safe integer`);
  }
  return result as number;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      nodeTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownData<T>(
  value: Record<string, unknown>,
  name: string,
  label: string,
): T {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
    throw new DacsError(`${label} must be a data property`);
  }
  return descriptor.value as T;
}

function optionalOwnData<T>(
  value: Record<string, unknown>,
  name: string,
  label: string,
): T | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !("value" in descriptor)) {
    throw new DacsError(`${label} must be a data property`);
  }
  return descriptor.value as T | undefined;
}

function captureOptions(
  input: Readonly<FsWalletSpendStateStoreOptionsV1>,
): Readonly<CapturedFsOptionsV1> {
  if (!plainObject(input)) {
    throw new DacsError("wallet spend filesystem options must be a plain object");
  }
  const allowed = new Set([
    "dir", "integrityKey", "lockTimeoutMs", "lockStaleMs", "lockPollMs",
  ]);
  if (Reflect.ownKeys(input).some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new DacsError("wallet spend filesystem option is unsupported");
  }
  const dir = ownData<string>(input, "dir", "wallet spend directory");
  const sourceKey = ownData<Uint8Array>(input, "integrityKey", "wallet spend integrity key");
  if (typeof dir !== "string" || dir.length === 0 || dir.trim() !== dir) {
    throw new DacsError("wallet spend directory must be a non-empty string");
  }
  if (!(sourceKey instanceof Uint8Array) || nodeTypes.isProxy(sourceKey) ||
      sourceKey.byteLength < 32) {
    throw new DacsError("wallet spend integrity key must contain at least 32 bytes");
  }
  return Object.freeze({
    dir,
    integrityKey: Uint8Array.from(sourceKey),
    lockTimeoutMs: safePositive(
      optionalOwnData<number>(input, "lockTimeoutMs", "wallet spend lockTimeoutMs"),
      DEFAULT_LOCK_TIMEOUT_MS,
      "wallet spend lockTimeoutMs",
    ),
    lockStaleMs: safePositive(
      optionalOwnData<number>(input, "lockStaleMs", "wallet spend lockStaleMs"),
      DEFAULT_LOCK_STALE_MS,
      "wallet spend lockStaleMs",
    ),
    lockPollMs: safePositive(
      optionalOwnData<number>(input, "lockPollMs", "wallet spend lockPollMs"),
      DEFAULT_LOCK_POLL_MS,
      "wallet spend lockPollMs",
    ),
  });
}

function permissionBits(mode: number): number {
  return mode & 0o777;
}

async function assertPrivateOwnedPath(
  path: string,
  kind: "directory" | "file",
): Promise<void> {
  const metadata = await lstat(path);
  const correctKind = kind === "directory" ? metadata.isDirectory() : metadata.isFile();
  const expectedMode = kind === "directory" ? DIRECTORY_MODE : FILE_MODE;
  if (!correctKind || metadata.isSymbolicLink() ||
      (process.platform !== "win32" && permissionBits(metadata.mode) !== expectedMode) ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw new DacsError(`wallet spend ${kind} is not private and process-owned`);
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await assertPrivateOwnedPath(path, "directory");
}

function unsupportedDirectorySync(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EINVAL" || code === "ENOSYS" || code === "ENOTSUP";
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!unsupportedDirectorySync(error)) throw error;
  } finally {
    await handle?.close();
  }
}

async function atomicWrite(path: string, text: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", FILE_MODE);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
  await assertPrivateOwnedPath(path, "file");
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves that the process is absent. Permissions and unknown
    // host errors must fail closed instead of authorizing stale reclamation.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Authenticated, atomic, cross-process reference store for a wallet policy.
 * Missing state after first initialization is corruption, never a fresh budget.
 */
export async function createFsWalletSpendStateStoreV1(
  input: Readonly<FsWalletSpendStateStoreOptionsV1>,
): Promise<WalletSpendStateStore> {
  const options = captureOptions(input);
  const root = resolve(options.dir);
  const key = Uint8Array.from(options.integrityKey);
  const recordsDirectory = join(root, "records");
  const markersDirectory = join(root, "markers");
  const locksDirectory = join(root, "locks");

  const parent = dirname(root);
  if (root === parent || !root.startsWith(`${parent}${sep}`)) {
    key.fill(0);
    throw new DacsError("wallet spend directory is invalid");
  }
  await ensurePrivateDirectory(root);
  await ensurePrivateDirectory(recordsDirectory);
  await ensurePrivateDirectory(markersDirectory);
  await ensurePrivateDirectory(locksDirectory);

  const authenticate = (body: unknown): string => createHmac("sha256", key)
    .update(canonicalize(body))
    .digest("hex");
  const equalMac = (left: unknown, right: string): boolean => {
    if (typeof left !== "string" || !HASH_RE.test(left)) return false;
    return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
  };
  const paths = (scope: string) => {
    if (!HASH_RE.test(scope)) throw new DacsError("wallet spend scope is invalid");
    return {
      record: join(recordsDirectory, `${scope}.json`),
      marker: join(markersDirectory, `${scope}.initialized`),
      lock: join(locksDirectory, `${scope}.lock`),
    };
  };
  const mutationGatePath = (scope: string): string =>
    join(locksDirectory, `${scope}.reclaim`);
  const mutationQuarantinePrefix = (scope: string): string =>
    `reclaim-${scope.length}-${scope}.`;
  const mutationQuarantinePath = (scope: string): string =>
    join(locksDirectory, `${mutationQuarantinePrefix(scope)}${randomUUID()}.quarantine`);
  const lockQuarantinePrefix = (scope: string): string =>
    `lock-${scope.length}-${scope}.`;
  const staleLockPath = (scope: string): string =>
    join(locksDirectory, `${lockQuarantinePrefix(scope)}${randomUUID()}.stale`);
  const releasedLockPath = (scope: string, token: string): string =>
    join(locksDirectory, `${lockQuarantinePrefix(scope)}${token}.released`);

  async function readBoundedJson(path: string, label: string): Promise<unknown> {
    await assertPrivateOwnedPath(path, "file");
    const metadata = await stat(path);
    if (metadata.size <= 0 || metadata.size > MAX_STATE_BYTES) {
      throw new DacsError(`${label} has an invalid size`);
    }
    try {
      return JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch (cause) {
      throw new DacsError(`${label} is not valid JSON`, { cause });
    }
  }

  async function exists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async function markerPresent(scope: string, path: string): Promise<boolean> {
    if (!await exists(path)) return false;
    const value = await readBoundedJson(path, "wallet spend initialization marker");
    if (!plainObject(value) || value.markerVersion !== STORE_FORMAT_VERSION ||
        value.scope !== scope) {
      throw new DacsError("wallet spend initialization marker is corrupt");
    }
    const body = { markerVersion: STORE_FORMAT_VERSION, scope };
    if (!equalMac(value.mac, authenticate(body))) {
      throw new DacsError("wallet spend initialization marker is unauthenticated");
    }
    return true;
  }

  async function readState(
    scope: string,
    recordPath: string,
    markerPath: string,
    repairMarker = true,
  ): Promise<Readonly<WalletSpendStateV1> | null> {
    const marked = await markerPresent(scope, markerPath);
    if (!await exists(recordPath)) {
      if (marked) {
        throw new DacsError("wallet spend state is missing after initialization");
      }
      return null;
    }
    const value = await readBoundedJson(recordPath, "wallet spend state");
    if (!plainObject(value) || value.formatVersion !== STORE_FORMAT_VERSION ||
        value.scope !== scope || !plainObject(value.state)) {
      throw new DacsError("wallet spend state envelope is corrupt");
    }
    const body = {
      formatVersion: STORE_FORMAT_VERSION,
      scope,
      state: value.state,
    };
    if (!equalMac(value.mac, authenticate(body))) {
      throw new DacsError("wallet spend state is unauthenticated");
    }
    if (!marked && repairMarker) {
      const markerBody = { markerVersion: STORE_FORMAT_VERSION, scope };
      await atomicWrite(markerPath, JSON.stringify({
        ...markerBody,
        mac: authenticate(markerBody),
      }));
    }
    return structuredClone(value.state as unknown as WalletSpendStateV1);
  }

  async function writeState(
    scope: string,
    state: Readonly<WalletSpendStateV1>,
    recordPath: string,
    markerPath: string,
  ): Promise<void> {
    const body = { formatVersion: STORE_FORMAT_VERSION, scope, state };
    await atomicWrite(recordPath, JSON.stringify({ ...body, mac: authenticate(body) }));
    if (!await markerPresent(scope, markerPath)) {
      const markerBody = { markerVersion: STORE_FORMAT_VERSION, scope };
      await atomicWrite(markerPath, JSON.stringify({
        ...markerBody,
        mac: authenticate(markerBody),
      }));
    }
  }

  function lockOwner(value: unknown): LockOwnerV1 | null {
    if (!plainObject(value) || !Number.isSafeInteger(value.pid) ||
        (value.pid as number) <= 0 || typeof value.hostname !== "string" ||
        value.hostname.length === 0 || typeof value.token !== "string" ||
        value.token.length === 0 || !Number.isSafeInteger(value.createdAt) ||
        (value.createdAt as number) < 0) return null;
    return {
      pid: value.pid as number,
      hostname: value.hostname,
      token: value.token,
      createdAt: value.createdAt as number,
    };
  }

  async function readLockOwner(path: string): Promise<LockOwnerV1 | null> {
    try {
      const metadata = await lstat(path);
      const ownerPath = metadata.isDirectory() ? join(path, "owner.json") : path;
      return lockOwner(await readBoundedJson(ownerPath, "wallet spend lock owner"));
    } catch {
      // Missing or malformed coordination records remain authoritative until
      // their enclosing gate/lock has also passed the configured stale age.
      return null;
    }
  }

  const sameLockOwner = (
    left: LockOwnerV1 | null,
    right: LockOwnerV1 | null,
  ): boolean => left === null
    ? right === null
    : right !== null && left.pid === right.pid &&
      left.hostname === right.hostname && left.token === right.token &&
      left.createdAt === right.createdAt;

  async function removeCoordinationPath(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }

  async function publishCompleteDirectoryLock(
    path: string,
    owner: LockOwnerV1 | LockMutationGateOwnerV1,
  ): Promise<void> {
    const candidate = `${path}.${randomUUID()}.candidate`;
    try {
      await mkdir(candidate, { mode: DIRECTORY_MODE });
      const handle = await open(join(candidate, "owner.json"), "wx", FILE_MODE);
      try {
        await handle.writeFile(JSON.stringify(owner), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(candidate);
      await rename(candidate, path);
      await syncDirectory(locksDirectory);
    } finally {
      await removeCoordinationPath(candidate);
    }
  }

  async function publishCompleteFileLock(
    path: string,
    owner: LockOwnerV1,
  ): Promise<void> {
    const candidate = `${path}.${randomUUID()}.candidate`;
    const handle = await open(candidate, "wx", FILE_MODE);
    try {
      await handle.writeFile(JSON.stringify(owner), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      // A hard link is the exclusive publication primitive. Unlike rename, it
      // cannot replace an existing legacy directory or a successor lock file.
      await link(candidate, path);
      await syncDirectory(locksDirectory);
    } finally {
      await unlink(candidate).catch((error: unknown) => {
        if (nestedErrorCode(error) !== "ENOENT") throw error;
      });
    }
    await assertPrivateOwnedPath(path, "file");
  }

  function ownerIsLive(owner: LockOwnerV1): boolean {
    return owner.hostname !== hostname() || processAlive(owner.pid);
  }

  async function activeMutationQuarantines(scope: string): Promise<string[]> {
    const prefix = mutationQuarantinePrefix(scope);
    const names = (await readdir(locksDirectory)).filter((name) =>
      name.startsWith(prefix) && name.endsWith(".quarantine"));
    const live: string[] = [];
    let removed = false;
    for (const name of names) {
      const path = join(locksDirectory, name);
      try {
        const metadata = await lstat(path);
        const owner = await readLockOwner(path);
        if (Date.now() - metadata.mtimeMs <= options.lockStaleMs ||
            (owner !== null && ownerIsLive(owner))) {
          live.push(path);
          continue;
        }
        await removeCoordinationPath(path);
        removed = true;
      } catch (error) {
        if (nestedErrorCode(error) !== "ENOENT") throw error;
      }
    }
    if (removed) await syncDirectory(locksDirectory);
    return live;
  }

  async function quarantineStaleMutationGate(scope: string): Promise<void> {
    const path = mutationGatePath(scope);
    let observed;
    try {
      observed = await lstat(path);
    } catch (error) {
      if (nestedErrorCode(error) === "ENOENT") return;
      throw error;
    }
    if (Date.now() - observed.mtimeMs <= options.lockStaleMs) return;
    const observedOwner = await readLockOwner(path);
    if (observedOwner !== null && ownerIsLive(observedOwner)) return;

    const quarantine = mutationQuarantinePath(scope);
    try {
      await rename(path, quarantine);
      await syncDirectory(locksDirectory);
    } catch (error) {
      if (nestedErrorCode(error) === "ENOENT") return;
      throw error;
    }
    let moved;
    try {
      moved = await lstat(quarantine);
    } catch (error) {
      if (nestedErrorCode(error) === "ENOENT") return;
      throw error;
    }
    const movedOwner = await readLockOwner(quarantine);
    if (moved.dev === observed.dev && moved.ino === observed.ino &&
        sameLockOwner(movedOwner, observedOwner) &&
        Date.now() - moved.mtimeMs > options.lockStaleMs &&
        (movedOwner === null || !ownerIsLive(movedOwner))) {
      await removeCoordinationPath(quarantine);
      await syncDirectory(locksDirectory);
    }
    // A moved replacement remains quarantined and blocks every later mutator.
  }

  async function releaseMutationGate(
    scope: string,
    owner: LockMutationGateOwnerV1,
  ): Promise<void> {
    const path = mutationGatePath(scope);
    const observedOwner = await readLockOwner(path);
    if (observedOwner?.pid === owner.pid &&
        observedOwner.hostname === owner.hostname &&
        observedOwner.token === owner.token &&
        observedOwner.createdAt === owner.createdAt) {
      const observed = await lstat(path);
      const quarantine = mutationQuarantinePath(scope);
      try {
        await rename(path, quarantine);
        await syncDirectory(locksDirectory);
      } catch (error) {
        if (nestedErrorCode(error) !== "ENOENT") throw error;
      }
      try {
        const moved = await lstat(quarantine);
        const movedOwner = await readLockOwner(quarantine);
        if (moved.dev !== observed.dev || moved.ino !== observed.ino ||
            !sameLockOwner(movedOwner, observedOwner)) {
          throw new DacsError("wallet spend mutation gate changed during release");
        }
        await removeCoordinationPath(quarantine);
        await syncDirectory(locksDirectory);
        return;
      } catch (error) {
        if (nestedErrorCode(error) !== "ENOENT") throw error;
      }
    }

    // Recover only this exact gate if an older participant already moved it.
    const prefix = mutationQuarantinePrefix(scope);
    for (const name of (await readdir(locksDirectory)).filter((item) =>
      item.startsWith(prefix) && item.endsWith(".quarantine"))) {
      const quarantine = join(locksDirectory, name);
      const quarantinedOwner = await readLockOwner(quarantine);
      if (quarantinedOwner?.pid === owner.pid &&
          quarantinedOwner.hostname === owner.hostname &&
          quarantinedOwner.token === owner.token &&
          quarantinedOwner.createdAt === owner.createdAt) {
        await removeCoordinationPath(quarantine);
        await syncDirectory(locksDirectory);
        return;
      }
    }
    throw new DacsError("wallet spend mutation gate ownership was lost");
  }

  async function acquireMutationGate(
    scope: string,
    owner: LockMutationGateOwnerV1,
  ): Promise<boolean> {
    if ((await activeMutationQuarantines(scope)).length > 0) return false;
    try {
      await publishCompleteDirectoryLock(mutationGatePath(scope), owner);
    } catch (error) {
      const code = nestedErrorCode(error);
      if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "ENOTDIR") {
        throw error;
      }
      await quarantineStaleMutationGate(scope);
      return false;
    }
    if ((await activeMutationQuarantines(scope)).length > 0) {
      await releaseMutationGate(scope, owner);
      return false;
    }
    return true;
  }

  async function withLockMutationGate<T>(
    scope: string,
    deadline: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    const owner: LockMutationGateOwnerV1 = {
      pid: process.pid,
      hostname: hostname(),
      token: randomUUID(),
      createdAt: Date.now(),
    };
    while (!await acquireMutationGate(scope, owner)) {
      if (Date.now() >= deadline) {
        throw new DacsError("wallet spend lock mutation gate timed out");
      }
      await delay(options.lockPollMs);
    }
    try {
      return await operation();
    } finally {
      await releaseMutationGate(scope, owner);
    }
  }

  async function activeStaleLockQuarantines(scope: string): Promise<string[]> {
    const prefix = lockQuarantinePrefix(scope);
    const names = (await readdir(locksDirectory)).filter((name) =>
      name.startsWith(prefix) && name.endsWith(".stale"));
    const live: string[] = [];
    let removed = false;
    for (const name of names) {
      const path = join(locksDirectory, name);
      try {
        const metadata = await lstat(path);
        const owner = await readLockOwner(path);
        if (owner === null || Date.now() - metadata.mtimeMs <= options.lockStaleMs ||
            ownerIsLive(owner)) {
          live.push(path);
          continue;
        }
        await removeCoordinationPath(path);
        removed = true;
      } catch (error) {
        if (nestedErrorCode(error) !== "ENOENT") throw error;
      }
    }
    if (removed) await syncDirectory(locksDirectory);
    return live;
  }

  async function refuseLegacyCoordination(scope: string): Promise<void> {
    const legacyQuarantinePrefix = `${scope}.lock.reclaim.`;
    if ((await readdir(locksDirectory)).some((name) =>
      name.startsWith(legacyQuarantinePrefix))) {
      throw new DacsError(
        "legacy wallet spend lock quarantine requires a quiesced upgrade",
      );
    }
  }

  async function observeStaleLock(path: string): Promise<{
    metadata: Awaited<ReturnType<typeof lstat>>;
    owner: LockOwnerV1;
  } | null> {
    let metadata;
    try {
      metadata = await lstat(path);
      if (metadata.isDirectory()) {
        // Version 1 directory locks are deliberately not reclaimed. A paused
        // legacy publisher can resume after its directory is moved, and a
        // legacy reclaimer ignores the new mutation gate. The file-form lock
        // makes mixed writers fail closed; operators must stop old writers and
        // remove a confirmed-abandoned legacy lock before upgrading.
        throw new DacsError(
          "legacy wallet spend directory lock requires a quiesced upgrade",
        );
      }
      await assertPrivateOwnedPath(path, "file");
    } catch (error) {
      if (nestedErrorCode(error) === "ENOENT") return null;
      throw error;
    }
    if (Date.now() - metadata.mtimeMs < options.lockStaleMs) return null;
    const owner = await readLockOwner(path);
    if (owner === null) {
      throw new DacsError("stale wallet spend lock has no authentic owner record");
    }
    if (owner.hostname !== hostname()) {
      throw new DacsError("wallet spend lock belongs to another host");
    }
    if (processAlive(owner.pid)) return null;
    return { metadata, owner };
  }

  async function reclaimStaleLockUnderMutationGate(
    scope: string,
    path: string,
  ): Promise<void> {
    if (await observeStaleLock(path) === null) return;
    // Repeat the authoritative observation under the mutation gate immediately
    // before rename; the post-rename inode and owner check closes the remaining
    // replacement window between compatible file-lock participants.
    const observed = await observeStaleLock(path);
    if (observed === null) return;
    const quarantine = staleLockPath(scope);
    try {
      await rename(path, quarantine);
      await syncDirectory(locksDirectory);
    } catch (error) {
      if (nestedErrorCode(error) === "ENOENT") return;
      throw error;
    }
    const moved = await lstat(quarantine);
    const movedOwner = await readLockOwner(quarantine);
    if (moved.dev !== observed.metadata.dev || moved.ino !== observed.metadata.ino ||
        !sameLockOwner(movedOwner, observed.owner) ||
        Date.now() - moved.mtimeMs < options.lockStaleMs ||
        movedOwner === null || ownerIsLive(movedOwner)) {
      throw new DacsError("wallet spend lock changed during stale recovery");
    }
    await removeCoordinationPath(quarantine);
    await syncDirectory(locksDirectory);
  }

  async function releaseOwnedLock(
    scope: string,
    path: string,
    owner: LockOwnerV1,
  ): Promise<void> {
    const observedOwner = await readLockOwner(path);
    if (sameLockOwner(observedOwner, owner)) {
      const observed = await lstat(path);
      const released = releasedLockPath(scope, owner.token);
      try {
        await rename(path, released);
        await syncDirectory(locksDirectory);
      } catch (error) {
        if (nestedErrorCode(error) !== "ENOENT") throw error;
      }
      try {
        const moved = await lstat(released);
        const movedOwner = await readLockOwner(released);
        if (moved.dev !== observed.dev || moved.ino !== observed.ino ||
            !sameLockOwner(movedOwner, owner)) {
          throw new DacsError("wallet spend lock changed during release");
        }
        await removeCoordinationPath(released);
        await syncDirectory(locksDirectory);
        return;
      } catch (error) {
        if (nestedErrorCode(error) !== "ENOENT") throw error;
      }
    }

    // Recover only a unique compatible quarantine whose complete owner record
    // still carries this exact token.
    const prefix = lockQuarantinePrefix(scope);
    for (const name of (await readdir(locksDirectory)).filter((item) =>
      item.startsWith(prefix) && item.endsWith(".stale"))) {
      const quarantine = join(locksDirectory, name);
      if (sameLockOwner(await readLockOwner(quarantine), owner)) {
        await removeCoordinationPath(quarantine);
        await syncDirectory(locksDirectory);
        return;
      }
    }
    throw new DacsError(observedOwner === null
      ? "wallet spend lock ownership was lost"
      : "wallet spend lock ownership was superseded");
  }

  async function withLock<T>(
    scope: string,
    path: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const deadline = Date.now() + options.lockTimeoutMs;
    return withLockMutationGate(scope, deadline, async () => {
      const owner: LockOwnerV1 = {
        pid: process.pid,
        hostname: hostname(),
        token: randomUUID(),
        createdAt: Date.now(),
      };
      while (true) {
        await refuseLegacyCoordination(scope);
        if ((await activeStaleLockQuarantines(scope)).length === 0) {
          try {
            await publishCompleteFileLock(path, owner);
            break;
          } catch (error) {
            const code = nestedErrorCode(error);
            if (code !== "EEXIST" && code !== "ENOTEMPTY" &&
                code !== "EISDIR" && code !== "ENOTDIR") throw error;
            await reclaimStaleLockUnderMutationGate(scope, path);
          }
        }
        if (Date.now() >= deadline) {
          throw new DacsError("wallet spend state lock timed out");
        }
        await delay(options.lockPollMs);
      }

      let completed = false;
      try {
        const value = await operation();
        completed = true;
        return value;
      } finally {
        try {
          await releaseOwnedLock(scope, path, owner);
        } catch (releaseError) {
          if (completed) throw releaseError;
        }
      }
    });
  }

  const store: WalletSpendStateStore = {
    async read(scope: string): Promise<Readonly<WalletSpendStateV1> | null> {
      const { record, marker } = paths(scope);
      return readState(scope, record, marker, false);
    },
    async transact<T>(
      scope: string,
      operation: (
        current: Readonly<WalletSpendStateV1> | null,
      ) => Readonly<{ state: Readonly<WalletSpendStateV1>; value: T }>,
    ): Promise<T> {
      const { record, marker, lock } = paths(scope);
      return withLock(scope, lock, async () => {
        const current = await readState(scope, record, marker);
        const output = operation(current);
        if (!plainObject(output) || !plainObject(output.state) ||
            !Object.hasOwn(output, "value")) {
          throw new DacsError("wallet spend transaction returned an invalid result");
        }
        await writeState(scope, output.state as unknown as WalletSpendStateV1, record, marker);
        return output.value as T;
      });
    },
  };
  return Object.freeze(store);
}

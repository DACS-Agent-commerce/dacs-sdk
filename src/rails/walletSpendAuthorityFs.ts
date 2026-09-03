import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
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
    return (error as NodeJS.ErrnoException).code === "EPERM";
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

  async function acquireLock(path: string): Promise<() => Promise<void>> {
    const startedAt = Date.now();
    const token = randomUUID();
    const owner: LockOwnerV1 = {
      pid: process.pid,
      hostname: hostname(),
      token,
      createdAt: Date.now(),
    };
    while (true) {
      let created = false;
      try {
        await mkdir(path, { mode: DIRECTORY_MODE });
        created = true;
        await atomicWrite(join(path, "owner.json"), JSON.stringify(owner));
        await syncDirectory(locksDirectory);
        return async () => {
          let current: unknown;
          try {
            current = await readBoundedJson(join(path, "owner.json"), "wallet spend lock owner");
          } catch {
            throw new DacsError("wallet spend lock ownership was lost");
          }
          if (!plainObject(current) || current.token !== token) {
            throw new DacsError("wallet spend lock ownership was superseded");
          }
          await rm(path, { recursive: true });
          await syncDirectory(locksDirectory);
        };
      } catch (error) {
        if (created) {
          await rm(path, { recursive: true, force: true });
          await syncDirectory(locksDirectory);
          throw error;
        }
        if (nestedErrorCode(error) !== "EEXIST") throw error;
      }

      const lockOwnerPath = join(path, "owner.json");
      let observed: unknown;
      let lockAge = 0;
      try {
        await assertPrivateOwnedPath(path, "directory");
        const metadata = await stat(path);
        lockAge = Date.now() - metadata.mtimeMs;
        observed = await readBoundedJson(lockOwnerPath, "wallet spend lock owner");
      } catch (error) {
        // A contender can see the freshly-created lock directory before its
        // owner file is atomically installed, or the owner can release between
        // stat and read. Both are ordinary lock races, not corrupt state.
        if (nestedErrorCode(error) !== "ENOENT") throw error;
      }
      if (lockAge >= options.lockStaleMs) {
        if (!plainObject(observed) || typeof observed.pid !== "number" ||
            typeof observed.hostname !== "string" || typeof observed.token !== "string") {
          throw new DacsError("stale wallet spend lock has no authentic owner record");
        }
        if (observed.hostname !== hostname()) {
          throw new DacsError("wallet spend lock belongs to another host");
        }
        if (!processAlive(observed.pid)) {
          const quarantine = `${path}.reclaim.${randomUUID()}`;
          try {
            await rename(path, quarantine);
            await rm(quarantine, { recursive: true });
            await syncDirectory(locksDirectory);
            continue;
          } catch (error) {
            if (nestedErrorCode(error) !== "ENOENT") throw error;
          }
        }
      }
      if (Date.now() - startedAt >= options.lockTimeoutMs) {
        throw new DacsError("wallet spend state lock timed out");
      }
      await delay(options.lockPollMs);
    }
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
      const release = await acquireLock(lock);
      let completed = false;
      try {
        const current = await readState(scope, record, marker);
        const output = operation(current);
        if (!plainObject(output) || !plainObject(output.state) ||
            !Object.hasOwn(output, "value")) {
          throw new DacsError("wallet spend transaction returned an invalid result");
        }
        await writeState(scope, output.state as unknown as WalletSpendStateV1, record, marker);
        completed = true;
        return output.value as T;
      } finally {
        try {
          await release();
        } catch (releaseError) {
          if (completed) throw releaseError;
        }
      }
    },
  };
  return Object.freeze(store);
}

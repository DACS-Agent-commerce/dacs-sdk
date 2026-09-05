import { randomUUID } from "node:crypto";
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
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { types as nodeTypes } from "node:util";

import { assertPositiveAmount, canonicalize, sha256Hex } from "../canonical/index.js";
import { snapshotWireJsonRead } from "../canonical/snapshot.js";
import { isAttestationRef } from "../artifacts/validators.js";
import { DacsError } from "../errors.js";
import {
  deriveAp2IdempotencyKey,
  type Ap2BindingClaim,
  type Ap2BindingLease,
  type Ap2BindingStore,
  type Ap2BindingWrite,
  type Ap2CapturedSettlement,
  type Ap2SettlementIntent,
} from "./ap2.js";

const STORE_VERSION = 1 as const;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_POLL_MS = 5;
const MAX_RECORD_BYTES = 1_048_576;
const HASH_RE = /^[0-9a-f]{64}$/;

export interface FsAp2BindingStoreOptions {
  dir: string;
  lockTimeoutMs?: number;
  lockStaleMs?: number;
  lockPollMs?: number;
}

interface FsAp2BindingRecord {
  storeVersion: typeof STORE_VERSION;
  intent: Ap2SettlementIntent;
  lease: Ap2BindingLease;
  providerRef?: string;
  settlement?: Ap2CapturedSettlement;
  failure?: string;
  createdAt: number;
  updatedAt: number;
}

interface LockOwner {
  token: string;
  pid: number;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function positive(value: unknown, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || (selected as number) <= 0) {
    throw new DacsError(`${label} must be a positive safe integer`);
  }
  return selected as number;
}

function exactOptions(options: FsAp2BindingStoreOptions): FsAp2BindingStoreOptions {
  if (options === null || typeof options !== "object" || Array.isArray(options) ||
      nodeTypes.isProxy(options)) {
    throw new DacsError("AP2 filesystem store options must be an object");
  }
  const allowed = new Set(["dir", "lockTimeoutMs", "lockStaleMs", "lockPollMs"]);
  const descriptors = Object.getOwnPropertyDescriptors(options);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowed.has(key) || !("value" in descriptors[key]!)) {
      throw new DacsError("AP2 filesystem store options must be exact data properties");
    }
  }
  const dir = descriptors.dir?.value as unknown;
  if (typeof dir !== "string" || dir.length === 0 || dir.trim() !== dir) {
    throw new DacsError("AP2 filesystem store directory must be a non-empty string");
  }
  const lockTimeoutMs = descriptors.lockTimeoutMs?.value as unknown;
  const lockStaleMs = descriptors.lockStaleMs?.value as unknown;
  const lockPollMs = descriptors.lockPollMs?.value as unknown;
  return {
    dir,
    ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs: lockTimeoutMs as number }),
    ...(lockStaleMs === undefined ? {} : { lockStaleMs: lockStaleMs as number }),
    ...(lockPollMs === undefined ? {} : { lockPollMs: lockPollMs as number }),
  };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateIntent(value: unknown): Ap2SettlementIntent {
  const intent = snapshotWireJsonRead(value, "stored AP2 intent") as Ap2SettlementIntent;
  if (
    intent.intentVersion !== "1" || !HASH_RE.test(intent.bindingHash) ||
    !nonEmpty(intent.transactionId) || !nonEmpty(intent.jobId) ||
    !Number.isSafeInteger(intent.phaseIndex) || intent.phaseIndex < 0 ||
    !HASH_RE.test(intent.agreementHash) || !HASH_RE.test(intent.idempotencyKey) ||
    intent.idempotencyKey !== deriveAp2IdempotencyKey(intent.jobId, intent.phaseIndex) ||
    !nonEmpty(intent.mandateId) || !nonEmpty(intent.payee) ||
    !nonEmpty(intent.currency) || !nonEmpty(intent.protocolVersion) ||
    !nonEmpty(intent.paymentInstrumentId) ||
    assertPositiveAmount(intent.amount) !== intent.amount
  ) {
    throw new DacsError("stored AP2 intent failed its authority binding checks");
  }
  const { bindingHash, ...unsigned } = intent;
  if (sha256Hex(canonicalize(unsigned)) !== bindingHash) {
    throw new DacsError("stored AP2 intent bindingHash does not recompute");
  }
  return intent;
}

function validateSettlement(
  value: unknown,
  intent: Ap2SettlementIntent,
): Ap2CapturedSettlement {
  const settlement = snapshotWireJsonRead(value, "stored AP2 settlement") as
    Ap2CapturedSettlement;
  const tx = settlement.receiptTransactionRef;
  if (
    !nonEmpty(settlement.providerRef) || settlement.mandateId !== intent.mandateId ||
    settlement.protocolVersion !== intent.protocolVersion ||
    settlement.payee !== intent.payee || settlement.amount !== intent.amount ||
    settlement.currency !== intent.currency ||
    !Number.isSafeInteger(settlement.capturedAt) || settlement.capturedAt < 0 ||
    !isAttestationRef(settlement.receiptAttestation) ||
    (tx !== undefined &&
      (!nonEmpty(tx.kind) || !nonEmpty(tx.value) || Object.keys(tx).length !== 2))
  ) {
    throw new DacsError("stored AP2 settlement failed its authority binding checks");
  }
  return settlement;
}

function validateRecord(value: unknown, transactionId: string): FsAp2BindingRecord {
  const record = snapshotWireJsonRead(value, "stored AP2 binding record") as
    FsAp2BindingRecord;
  const intent = validateIntent(record.intent);
  if (
    record.storeVersion !== STORE_VERSION || intent.transactionId !== transactionId ||
    !nonEmpty(record.lease?.owner) ||
    !Number.isSafeInteger(record.lease.generation) || record.lease.generation <= 0 ||
    !Number.isSafeInteger(record.lease.expiresAt) || record.lease.expiresAt < 0 ||
    !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 ||
    !Number.isSafeInteger(record.updatedAt) || record.updatedAt < record.createdAt ||
    (record.providerRef !== undefined && !nonEmpty(record.providerRef)) ||
    (record.failure !== undefined && !nonEmpty(record.failure)) ||
    (record.failure !== undefined && record.settlement !== undefined)
  ) {
    throw new DacsError("stored AP2 binding record is malformed");
  }
  if (record.settlement !== undefined) {
    const settlement = validateSettlement(record.settlement, intent);
    if (record.providerRef !== settlement.providerRef) {
      throw new DacsError("stored AP2 provider reference conflicts with settlement");
    }
  }
  return record;
}

/** Durable, atomic, generation-fenced AP2-7 binding store for one host. */
export async function createFsAp2BindingStore(
  rawOptions: FsAp2BindingStoreOptions,
): Promise<Ap2BindingStore> {
  const options = exactOptions(rawOptions);
  const lockTimeoutMs = positive(
    options.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS, "AP2 lockTimeoutMs",
  );
  const lockStaleMs = positive(
    options.lockStaleMs, DEFAULT_LOCK_STALE_MS, "AP2 lockStaleMs",
  );
  const lockPollMs = positive(
    options.lockPollMs, DEFAULT_LOCK_POLL_MS, "AP2 lockPollMs",
  );
  const root = options.dir;
  const recordsDir = join(root, "records");
  const locksDir = join(root, "locks");

  async function safeDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: DIR_MODE });
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new DacsError("AP2 store path is not a safe directory");
    }
    await chmod(path, DIR_MODE);
  }
  await safeDir(root);
  await safeDir(recordsDir);
  await safeDir(locksDir);

  const key = (transactionId: string): string => sha256Hex(transactionId);
  const recordPath = (transactionId: string): string =>
    join(recordsDir, `${key(transactionId)}.json`);
  const lockPath = (transactionId: string): string =>
    join(locksDir, `${key(transactionId)}.lock`);
  const gatePath = (transactionId: string): string =>
    join(locksDir, `${key(transactionId)}.gate`);
  const gateQuarantinePrefix = (transactionId: string): string =>
    `${key(transactionId)}.gate.`;
  const gateQuarantinePath = (transactionId: string): string =>
    join(
      locksDir,
      `${gateQuarantinePrefix(transactionId)}${randomUUID()}.quarantine`,
    );

  async function syncDirectory(path: string): Promise<void> {
    const handle = await open(path, "r");
    try { await handle.sync(); } finally { await handle.close(); }
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

  async function readRecord(transactionId: string): Promise<
    | { status: "absent" }
    | { status: "ok"; record: FsAp2BindingRecord }
    | { status: "corrupt"; reason: string }
  > {
    const path = recordPath(transactionId);
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_RECORD_BYTES) {
      return { status: "corrupt", reason: "AP2 record path is unsafe or oversized" };
    }
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      return { status: "ok", record: validateRecord(parsed, transactionId) };
    } catch (error) {
      return {
        status: "corrupt",
        reason: error instanceof Error ? error.message : "AP2 record cannot be decoded",
      };
    }
  }

  async function lockOwner(path: string): Promise<LockOwner | undefined> {
    let value: string;
    try {
      value = await readFile(join(path, "owner"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const token = (parsed as { token?: unknown }).token;
    const pid = (parsed as { pid?: unknown }).pid;
    if (typeof token !== "string" || !/^[0-9a-f-]{36}$/.test(token) ||
        !Number.isSafeInteger(pid) || (pid as number) <= 0) return undefined;
    return { token, pid: pid as number };
  }

  async function gateOwner(path: string): Promise<LockOwner | undefined> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return undefined;
      }
      const token = (parsed as { token?: unknown }).token;
      const pid = (parsed as { pid?: unknown }).pid;
      if (typeof token !== "string" || !/^[0-9a-f-]{36}$/.test(token) ||
          !Number.isSafeInteger(pid) || (pid as number) <= 0) return undefined;
      return { token, pid: pid as number };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return undefined;
    }
  }

  function processIsAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  function sameOwner(
    left: LockOwner | undefined,
    right: LockOwner | undefined,
  ): boolean {
    return left === undefined
      ? right === undefined
      : right !== undefined && left.pid === right.pid && left.token === right.token;
  }

  async function publishCompleteGate(
    path: string,
    owner: LockOwner,
  ): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", FILE_MODE);
      try {
        await handle.writeFile(JSON.stringify(owner), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      // A hard link publishes the fully written owner without allowing rename
      // to overwrite an already-authoritative gate.
      await link(temporary, path);
      await syncDirectory(locksDir);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  async function activeGateQuarantines(
    transactionId: string,
  ): Promise<string[]> {
    const prefix = gateQuarantinePrefix(transactionId);
    const names = (await readdir(locksDir)).filter(
      (name) => name.startsWith(prefix) && name.endsWith(".quarantine"),
    );
    const live: string[] = [];
    for (const name of names) {
      const path = join(locksDir, name);
      try {
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink()) {
          throw new DacsError("AP2 settlement-store reclaim quarantine is unsafe");
        }
        const owner = metadata.isFile() ? await gateOwner(path) : undefined;
        if (
          Date.now() - metadata.mtimeMs <= lockStaleMs ||
          (owner !== undefined && processIsAlive(owner.pid))
        ) {
          live.push(path);
          continue;
        }
        // Unique quarantine names are never reused, so a dead quarantine can
        // be removed without targeting a replacement at the canonical path.
        await rm(path, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return live;
  }

  async function quarantineStaleGate(transactionId: string): Promise<void> {
    const path = gatePath(transactionId);
    let observed;
    try {
      observed = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (observed.isSymbolicLink() ||
        (!observed.isFile() && !observed.isDirectory())) {
      throw new DacsError("AP2 settlement-store reclaim gate is unsafe");
    }
    if (Date.now() - observed.mtimeMs <= lockStaleMs) return;
    const observedOwner = observed.isFile() ? await gateOwner(path) : undefined;
    if (observedOwner !== undefined && processIsAlive(observedOwner.pid)) return;

    const quarantine = gateQuarantinePath(transactionId);
    try {
      await rename(path, quarantine);
      await syncDirectory(locksDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let moved;
    try {
      moved = await lstat(quarantine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const movedOwner = moved.isFile() ? await gateOwner(quarantine) : undefined;
    if (
      moved.dev === observed.dev &&
      moved.ino === observed.ino &&
      sameOwner(movedOwner, observedOwner) &&
      Date.now() - moved.mtimeMs > lockStaleMs &&
      (movedOwner === undefined || !processIsAlive(movedOwner.pid))
    ) {
      await rm(quarantine, { recursive: true, force: true });
    }
    // If a replacement was moved, its unique quarantine remains authoritative
    // until its live owner releases it or it later becomes provably stale.
  }

  async function releaseGate(
    transactionId: string,
    owner: LockOwner,
  ): Promise<void> {
    const path = gatePath(transactionId);
    const observed = await gateOwner(path);
    if (sameOwner(observed, owner)) {
      const quarantine = gateQuarantinePath(transactionId);
      try {
        await rename(path, quarantine);
        const moved = await gateOwner(quarantine);
        if (sameOwner(moved, owner)) {
          await unlink(quarantine).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const prefix = gateQuarantinePrefix(transactionId);
    for (const name of (await readdir(locksDir)).filter(
      (item) => item.startsWith(prefix) && item.endsWith(".quarantine"),
    )) {
      const quarantine = join(locksDir, name);
      if (sameOwner(await gateOwner(quarantine), owner)) {
        await unlink(quarantine).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    }
    await syncDirectory(locksDir);
  }

  async function acquireGate(
    transactionId: string,
    owner: LockOwner,
  ): Promise<boolean> {
    if ((await activeGateQuarantines(transactionId)).length > 0) return false;
    const path = gatePath(transactionId);
    try {
      await publishCompleteGate(path, owner);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await quarantineStaleGate(transactionId);
      return false;
    }
    if ((await activeGateQuarantines(transactionId)).length > 0 ||
        !sameOwner(await gateOwner(path), owner)) {
      await releaseGate(transactionId, owner);
      return false;
    }
    return true;
  }

  async function reclaimStaleLock(transactionId: string, path: string): Promise<boolean> {
    const gate = { token: randomUUID(), pid: process.pid };
    if (!await acquireGate(transactionId, gate)) return false;
    try {
      const observed = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!observed) return true;
      if (Date.now() - observed.mtimeMs <= lockStaleMs) return false;
      if (!observed.isDirectory() || observed.isSymbolicLink()) {
        throw new DacsError("AP2 settlement-store lock is unsafe");
      }
      const observedOwner = await lockOwner(path);
      if (observedOwner !== undefined && processIsAlive(observedOwner.pid)) return false;
      const quarantine = `${path}.${randomUUID()}.quarantine`;
      try {
        await rename(path, quarantine);
        await syncDirectory(locksDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
        throw error;
      }
      const moved = await lstat(quarantine);
      const movedOwner = await lockOwner(quarantine);
      if (
        moved.dev !== observed.dev ||
        moved.ino !== observed.ino ||
        !sameOwner(movedOwner, observedOwner) ||
        Date.now() - moved.mtimeMs <= lockStaleMs ||
        (movedOwner !== undefined && processIsAlive(movedOwner.pid))
      ) {
        throw new DacsError("AP2 settlement-store lock changed during stale recovery");
      }
      await rm(quarantine, { recursive: true, force: true });
      await syncDirectory(locksDir);
      return true;
    } finally {
      await releaseGate(transactionId, gate);
    }
  }

  async function publishLockCandidate(
    transactionId: string,
    candidate: string,
    path: string,
  ): Promise<boolean> {
    const gate = { token: randomUUID(), pid: process.pid };
    if (!await acquireGate(transactionId, gate)) return false;
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
      await releaseGate(transactionId, gate);
    }
  }

  async function acquireLock(transactionId: string): Promise<() => Promise<void>> {
    const path = lockPath(transactionId);
    const owner = { token: randomUUID(), pid: process.pid };
    const deadline = Date.now() + lockTimeoutMs;
    for (;;) {
      // Prepare the complete owner under a unique, unpublished directory. Both
      // normal publication and stale recovery hold the same transition gate.
      const candidate = `${path}.${randomUUID()}.candidate`;
      try {
        await mkdir(candidate, { mode: DIR_MODE });
        try {
          const handle = await open(join(candidate, "owner"), "wx", FILE_MODE);
          try {
            await handle.writeFile(JSON.stringify(owner), "utf8");
            await handle.sync();
          } finally {
            await handle.close();
          }
        } catch (error) {
          await rm(candidate, { recursive: true, force: true });
          throw error;
        }
        await syncDirectory(candidate);
        if (await publishLockCandidate(transactionId, candidate, path)) {
          return async () => {
            const observed = await lockOwner(path);
            if (!sameOwner(observed, owner)) return;
            const released = `${path}.${owner.token}.release`;
            try {
              await rename(path, released);
              await syncDirectory(locksDir);
              const moved = await lockOwner(released);
              if (!sameOwner(moved, owner)) {
                throw new DacsError(
                  "AP2 settlement-store lock changed during release",
                );
              }
              await rm(released, { recursive: true, force: true });
              await syncDirectory(locksDir);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          };
        }
        await reclaimStaleLock(transactionId, path);
        if (Date.now() >= deadline) {
          throw new DacsError("timed out waiting for the AP2 settlement-store lock");
        }
        await new Promise((resolve) => setTimeout(resolve, lockPollMs));
      } finally {
        await rm(candidate, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  async function locked<T>(transactionId: string, operation: () => Promise<T>): Promise<T> {
    const release = await acquireLock(transactionId);
    try { return await operation(); } finally { await release(); }
  }

  const current = (
    record: FsAp2BindingRecord,
    input: { bindingHash: string; owner: string; generation: number },
  ): boolean => record.intent.bindingHash === input.bindingHash &&
    record.lease.owner === input.owner && record.lease.generation === input.generation;

  return {
    async claim(input): Promise<Ap2BindingClaim> {
      return locked(input.intent.transactionId, async () => {
        if (!Number.isSafeInteger(input.now) || input.now < 0 ||
            !Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs <= 0 ||
            input.now + input.leaseDurationMs > Number.MAX_SAFE_INTEGER ||
            !nonEmpty(input.owner)) {
          return { status: "corrupt", reason: "ap2-binding-claim-input-invalid" };
        }
        const found = await readRecord(input.intent.transactionId);
        if (found.status === "corrupt") return found;
        if (found.status === "absent") {
          let intent: Ap2SettlementIntent;
          try { intent = validateIntent(input.intent); } catch (error) {
            return {
              status: "corrupt",
              reason: error instanceof Error ? error.message : "ap2-intent-invalid",
            };
          }
          const record: FsAp2BindingRecord = {
            storeVersion: STORE_VERSION,
            intent: clone(intent),
            lease: {
              owner: input.owner,
              generation: 1,
              expiresAt: input.now + input.leaseDurationMs,
            },
            createdAt: input.now,
            updatedAt: input.now,
          };
          validateRecord(record, intent.transactionId);
          await atomicWrite(recordPath(intent.transactionId), record);
          return { status: "acquired", intent: clone(record.intent), lease: clone(record.lease) };
        }
        const record = found.record;
        if (record.intent.bindingHash !== input.intent.bindingHash) {
          return { status: "conflict", reason: "ap2-transaction-id-replay" };
        }
        if (record.settlement) {
          return {
            status: "settled",
            intent: clone(record.intent),
            settlement: clone(record.settlement),
          };
        }
        if (record.failure) {
          return { status: "failed", intent: clone(record.intent), reason: record.failure };
        }
        if (record.lease.expiresAt > input.now) {
          return {
            status: "waiting",
            intent: clone(record.intent),
            lease: clone(record.lease),
            ...(record.providerRef ? { providerRef: record.providerRef } : {}),
          };
        }
        if (record.lease.generation >= Number.MAX_SAFE_INTEGER) {
          return { status: "corrupt", reason: "ap2-lease-generation-exhausted" };
        }
        const updated: FsAp2BindingRecord = {
          ...record,
          lease: {
            owner: input.owner,
            generation: record.lease.generation + 1,
            expiresAt: input.now + input.leaseDurationMs,
          },
          updatedAt: input.now,
        };
        validateRecord(updated, input.intent.transactionId);
        await atomicWrite(recordPath(input.intent.transactionId), updated);
        return {
          status: "acquired",
          intent: clone(updated.intent),
          lease: clone(updated.lease),
          ...(updated.providerRef ? { providerRef: updated.providerRef } : {}),
        };
      });
    },

    async isCurrent(input): Promise<boolean> {
      return locked(input.transactionId, async () => {
        if (!Number.isSafeInteger(input.now) || input.now < 0) return false;
        const found = await readRecord(input.transactionId);
        return found.status === "ok" && current(found.record, input) &&
          found.record.lease.expiresAt > input.now &&
          !found.record.settlement && !found.record.failure;
      });
    },

    async recordProviderRef(input): Promise<Ap2BindingWrite> {
      return locked(input.transactionId, async () => {
        const found = await readRecord(input.transactionId);
        if (found.status === "absent") return { status: "corrupt", reason: "binding-missing" };
        if (found.status === "corrupt") return found;
        const record = found.record;
        if (!current(record, input)) return { status: "stale", reason: "stale-lease" };
        if (!nonEmpty(input.providerRef)) return { status: "corrupt", reason: "provider-ref-invalid" };
        if (record.providerRef && record.providerRef !== input.providerRef) {
          return { status: "conflict", reason: "provider-reference-conflict" };
        }
        if (record.providerRef) return { status: "existing" };
        const updated = { ...record, providerRef: input.providerRef };
        validateRecord(updated, input.transactionId);
        await atomicWrite(recordPath(input.transactionId), updated);
        return { status: "recorded" };
      });
    },

    async recordSettlement(input): Promise<Ap2BindingWrite> {
      return locked(input.transactionId, async () => {
        const found = await readRecord(input.transactionId);
        if (found.status === "absent") return { status: "corrupt", reason: "binding-missing" };
        if (found.status === "corrupt") return found;
        const record = found.record;
        if (!current(record, input)) return { status: "stale", reason: "stale-lease" };
        if (record.failure) return { status: "conflict", reason: "terminal-failure-exists" };
        let settlement: Ap2CapturedSettlement;
        try { settlement = validateSettlement(input.settlement, record.intent); } catch (error) {
          return {
            status: "corrupt",
            reason: error instanceof Error ? error.message : "settlement-invalid",
          };
        }
        if (!record.providerRef || record.providerRef !== settlement.providerRef) {
          return { status: "conflict", reason: "provider-reference-not-bound" };
        }
        if (record.settlement) {
          return canonicalize(record.settlement) === canonicalize(settlement)
            ? { status: "existing" }
            : { status: "conflict", reason: "settlement-conflict" };
        }
        const updated = { ...record, settlement: clone(settlement) };
        validateRecord(updated, input.transactionId);
        await atomicWrite(recordPath(input.transactionId), updated);
        return { status: "recorded" };
      });
    },

    async recordFailure(input): Promise<Ap2BindingWrite> {
      return locked(input.transactionId, async () => {
        const found = await readRecord(input.transactionId);
        if (found.status === "absent") return { status: "corrupt", reason: "binding-missing" };
        if (found.status === "corrupt") return found;
        const record = found.record;
        if (!current(record, input)) return { status: "stale", reason: "stale-lease" };
        if (record.settlement) return { status: "conflict", reason: "settlement-exists" };
        if (!nonEmpty(input.reason)) return { status: "corrupt", reason: "failure-invalid" };
        if (record.failure && record.failure !== input.reason) {
          return { status: "conflict", reason: "failure-conflict" };
        }
        if (record.failure) return { status: "existing" };
        const updated = { ...record, failure: input.reason };
        validateRecord(updated, input.transactionId);
        await atomicWrite(recordPath(input.transactionId), updated);
        return { status: "recorded" };
      });
    },
  };
}

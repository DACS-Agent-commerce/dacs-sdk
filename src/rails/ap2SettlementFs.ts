import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
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

  async function acquireGate(transactionId: string): Promise<() => Promise<void>> {
    const path = gatePath(transactionId);
    const started = Date.now();
    for (;;) {
      try {
        await mkdir(path, { mode: DIR_MODE });
        return async () => { await rm(path, { recursive: true, force: true }); };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!metadata) continue;
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new DacsError("AP2 settlement-store reclaim gate is unsafe");
      }
      if (Date.now() - started >= lockTimeoutMs) {
        throw new DacsError("timed out waiting for the AP2 settlement-store reclaim gate");
      }
      await new Promise((resolve) => setTimeout(resolve, lockPollMs));
    }
  }

  async function lockOwner(path: string): Promise<
    { token: string; pid?: number } | undefined
  > {
    try {
      const value = await readFile(join(path, "owner"), "utf8");
      if (/^[0-9a-f-]{36}$/.test(value)) return { token: value };
      const parsed = JSON.parse(value) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
      const token = (parsed as { token?: unknown }).token;
      const pid = (parsed as { pid?: unknown }).pid;
      if (typeof token !== "string" || !/^[0-9a-f-]{36}$/.test(token) ||
          !Number.isSafeInteger(pid) || (pid as number) <= 0) return undefined;
      return { token, pid: pid as number };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
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

  async function reclaimStaleLock(transactionId: string, path: string): Promise<boolean> {
    const releaseGate = await acquireGate(transactionId);
    try {
      const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!metadata || Date.now() - metadata.mtimeMs <= lockStaleMs) return false;
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new DacsError("AP2 settlement-store lock is unsafe");
      }
      const owner = await lockOwner(path);
      if (owner?.pid !== undefined && processIsAlive(owner.pid)) return false;
      const quarantine = `${path}.${randomUUID()}.quarantine`;
      try {
        await rename(path, quarantine);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
      await rm(quarantine, { recursive: true, force: true });
      return true;
    } finally {
      await releaseGate();
    }
  }

  async function acquireLock(transactionId: string): Promise<() => Promise<void>> {
    const path = lockPath(transactionId);
    const started = Date.now();
    for (;;) {
      const token = randomUUID();
      try {
        await mkdir(path, { mode: DIR_MODE });
        try {
          const handle = await open(join(path, "owner"), "wx", FILE_MODE);
          try {
            await handle.writeFile(JSON.stringify({ token, pid: process.pid }), "utf8");
            await handle.sync();
          } finally {
            await handle.close();
          }
        } catch (error) {
          await rm(path, { recursive: true, force: true });
          throw error;
        }
        return async () => {
          const releaseGate = await acquireGate(transactionId);
          try {
            if ((await lockOwner(path))?.token !== token) return;
            const quarantine = `${path}.${token}.release`;
            try {
              await rename(path, quarantine);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
              throw error;
            }
            await rm(quarantine, { recursive: true, force: true });
          } finally {
            await releaseGate();
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      try {
        const metadata = await lstat(path);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
          throw new DacsError("AP2 settlement-store lock is unsafe");
        }
        if (Date.now() - metadata.mtimeMs > lockStaleMs &&
            await reclaimStaleLock(transactionId, path)) continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (Date.now() - started >= lockTimeoutMs) {
        throw new DacsError("timed out waiting for the AP2 settlement-store lock");
      }
      await new Promise((resolve) => setTimeout(resolve, lockPollMs));
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

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
  AP2_PHASE_BOUND_ELSEWHERE,
  ap2BindingConflictReason,
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
const MAX_PHASE_BYTES = 16_384;
const MAX_PHASE_TRANSACTIONS = 64;
const PHASE_VERSION = 1 as const;
const HASH_RE = /^[0-9a-f]{64}$/;
const ENTRY_NAME_RE = /^[0-9a-f]{64}\.json$/;
/** A record written before this version: it binds its phase, but never resumes. */
const LEGACY_RECORD = "ap2-legacy-record-requires-reconciliation";
/** A record no phase binding accounts for: no new transaction_id may bind. */
const UNBOUND_RECORDS = "ap2-store-has-unbound-records";

type IntentVersion = "1" | "2";

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
  replayDeadline?: number;
  updatedAt: number;
}

/**
 * AP2-7 phase binding: the AP2-6 key of one (jobId, phaseIndex) and the
 * transaction_id bound to it. More than one id means records written before
 * this binding existed already disagree; that phase then fails closed.
 */
interface FsAp2PhaseBinding {
  phaseVersion: typeof PHASE_VERSION;
  idempotencyKey: string;
  transactionIds: string[];
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

/**
 * The AP2-6 key as the previous release derived it (`intentVersion "1"`): NFC
 * of any non-empty job id. Used only to recognise records that release wrote.
 */
function legacyAp2IdempotencyKey(jobId: string, phaseIndex: number): string {
  return sha256Hex(`dacs-ap2-idem:v1:${jobId.normalize("NFC")}:${phaseIndex}`);
}

// One branch per line, not a `?:` expression: gitleaks generic-api-key reads `...Key : name` as a key assignment.
function idempotencyDeriver(version: IntentVersion) {
  if (version === "2") return deriveAp2IdempotencyKey;
  return legacyAp2IdempotencyKey;
}

function validateIntent(value: unknown, version: IntentVersion = "2"): Ap2SettlementIntent {
  const intent = snapshotWireJsonRead(value, "stored AP2 intent") as Ap2SettlementIntent;
  const operation = version === "2"
    ? typeof intent.operationJson === "string" && intent.operationHash === sha256Hex(intent.operationJson)
    : !Object.hasOwn(intent, "operationJson") && !Object.hasOwn(intent, "operationHash");
  const deriveIdempotency = idempotencyDeriver(version);
  if (
    (intent.intentVersion as string) !== version || !operation || !HASH_RE.test(intent.bindingHash) ||
    !nonEmpty(intent.transactionId) || !nonEmpty(intent.jobId) ||
    !Number.isSafeInteger(intent.phaseIndex) || intent.phaseIndex < 0 ||
    !HASH_RE.test(intent.agreementHash) || !HASH_RE.test(intent.idempotencyKey) ||
    intent.idempotencyKey !== deriveIdempotency(intent.jobId, intent.phaseIndex) ||
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

function validateRecord(
  value: unknown,
  transactionId: string,
  version: IntentVersion = "2",
): FsAp2BindingRecord {
  const record = snapshotWireJsonRead(value, "stored AP2 binding record") as
    FsAp2BindingRecord;
  const intent = validateIntent(record.intent, version);
  if (
    record.storeVersion !== STORE_VERSION || intent.transactionId !== transactionId ||
    (version === "1" && Object.hasOwn(record, "replayDeadline")) ||
    !nonEmpty(record.lease?.owner) ||
    !Number.isSafeInteger(record.lease.generation) || record.lease.generation <= 0 ||
    !Number.isSafeInteger(record.lease.expiresAt) || record.lease.expiresAt < 0 ||
    !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 ||
    (record.replayDeadline !== undefined && (!Number.isSafeInteger(record.replayDeadline) || record.replayDeadline <= record.createdAt)) ||
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
  const phasesDir = join(root, "phases");

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
  await safeDir(phasesDir);

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
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      return { status: "ok", record: validateRecord(parsed, transactionId) };
    } catch (error) {
      if (legacyIntent(parsed, transactionId)) return { status: "corrupt", reason: LEGACY_RECORD };
      return {
        status: "corrupt",
        reason: error instanceof Error ? error.message : "AP2 record cannot be decoded",
      };
    }
  }

  /** The intent of a record the previous release wrote, strictly checked; else undefined. */
  function legacyIntent(value: unknown, transactionId: string): Ap2SettlementIntent | undefined {
    try { return validateRecord(value, transactionId, "1").intent; } catch { return undefined; }
  }

  const phasePath = (idempotencyKey: string): string =>
    join(phasesDir, `${key(idempotencyKey)}.json`);
  // A transaction_id is base64url, so this lock name can never equal one.
  const phaseLock = (idempotencyKey: string): string => `ap2-phase:${idempotencyKey}`;

  async function readPhase(idempotencyKey: string): Promise<
    | { status: "absent" }
    | { status: "ok"; transactionIds: readonly string[] }
    | { status: "corrupt"; reason: string }
  > {
    const path = phasePath(idempotencyKey);
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
      throw error;
    }
    const corrupt = { status: "corrupt" as const, reason: "ap2-phase-binding-malformed" };
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_PHASE_BYTES) return corrupt;
    try {
      const phase = snapshotWireJsonRead(JSON.parse(await readFile(path, "utf8")) as unknown,
        "stored AP2 phase binding") as FsAp2PhaseBinding;
      const ids = phase.transactionIds;
      if (phase.phaseVersion !== PHASE_VERSION || phase.idempotencyKey !== idempotencyKey ||
          Object.keys(phase).length !== 3 || !Array.isArray(ids) || ids.length === 0 ||
          ids.length > MAX_PHASE_TRANSACTIONS || !ids.every(nonEmpty) || new Set(ids).size !== ids.length) {
        return corrupt;
      }
      return { status: "ok", transactionIds: ids };
    } catch {
      return corrupt;
    }
  }

  /** Publish a phase binding: `link` never overwrites one; `rename` replaces it. */
  async function writePhase(
    idempotencyKey: string,
    transactionIds: readonly string[],
    mode: "create" | "replace",
  ): Promise<void> {
    const path = phasePath(idempotencyKey);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const value: FsAp2PhaseBinding = {
      phaseVersion: PHASE_VERSION, idempotencyKey, transactionIds: [...transactionIds],
    };
    try {
      const handle = await open(temporary, "wx", FILE_MODE);
      try {
        await handle.writeFile(JSON.stringify(value), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (mode === "create") await link(temporary, path);
      else await rename(temporary, path);
      await syncDirectory(phasesDir);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  /**
   * Account for every record before any claim, so a missing phase binding
   * means a free phase. A current record, or one the previous release wrote
   * (bound under the AP2-6 key that release derived), binds its phase; two
   * such records for one phase are both kept, which makes it fail closed. A
   * record that cannot be decoded is accounted for only when a phase binding
   * already lists its transaction_id. Returns how many records are unbound.
   */
  async function bindExistingPhases(): Promise<number> {
    const undecoded: string[] = [];
    for (const name of await readdir(recordsDir)) {
      if (!ENTRY_NAME_RE.test(name)) continue;
      let intent: Ap2SettlementIntent;
      try {
        const path = join(recordsDir, name);
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_RECORD_BYTES) {
          throw new DacsError("AP2 record path is unsafe or oversized");
        }
        const parsed = JSON.parse(await readFile(path, "utf8")) as { intent?: { transactionId?: unknown } };
        const transactionId = parsed?.intent?.transactionId;
        if (typeof transactionId !== "string" || `${key(transactionId)}.json` !== name) {
          throw new DacsError("AP2 record name does not match its transaction_id");
        }
        const legacy = legacyIntent(parsed, transactionId);
        intent = legacy ?? validateRecord(parsed, transactionId).intent;
      } catch {
        undecoded.push(name);
        continue;
      }
      const seen = await readPhase(intent.idempotencyKey);
      if (seen.status === "ok" && seen.transactionIds.includes(intent.transactionId)) continue;
      await locked(phaseLock(intent.idempotencyKey), async () => {
        const found = await readPhase(intent.idempotencyKey);
        if (found.status === "corrupt") return;
        if (found.status === "absent") {
          await writePhase(intent.idempotencyKey, [intent.transactionId], "create");
        } else if (!found.transactionIds.includes(intent.transactionId)) {
          await writePhase(intent.idempotencyKey, [...found.transactionIds, intent.transactionId], "replace");
        }
      });
    }
    if (undecoded.length === 0) return 0;
    // A phase is bound before its record is written, so reading the phases
    // after listing the records sees the binding of every listed record.
    const bound = new Set<string>();
    for (const name of await readdir(phasesDir)) {
      if (!ENTRY_NAME_RE.test(name)) continue;
      try {
        const path = join(phasesDir, name);
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_PHASE_BYTES) continue;
        const phase = JSON.parse(await readFile(path, "utf8")) as { idempotencyKey?: unknown };
        if (typeof phase?.idempotencyKey !== "string" || `${key(phase.idempotencyKey)}.json` !== name) continue;
        const found = await readPhase(phase.idempotencyKey);
        if (found.status === "ok") for (const id of found.transactionIds) bound.add(`${key(id)}.json`);
      } catch {
        continue;
      }
    }
    return undecoded.filter((name) => !bound.has(name)).length;
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

  async function lockAvailability(
    path: string,
  ): Promise<"absent" | "occupied" | "reclaimable"> {
    const observed = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!observed) return "absent";
    if (Date.now() - observed.mtimeMs <= lockStaleMs) return "occupied";
    if (!observed.isDirectory() || observed.isSymbolicLink()) {
      throw new DacsError("AP2 settlement-store lock is unsafe");
    }
    const owner = await lockOwner(path);
    return owner !== undefined && processIsAlive(owner.pid)
      ? "occupied"
      : "reclaimable";
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
    // Prepare one complete owner before waiting. Rebuilding and fsyncing a new
    // candidate on every occupied-lock poll can consume the entire bounded wait
    // under contention without improving the no-overwrite publication check.
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

      for (;;) {
        const availability = await lockAvailability(path);
        if (availability === "occupied") {
          if (Date.now() >= deadline) {
            throw new DacsError("timed out waiting for the AP2 settlement-store lock");
          }
          await new Promise((resolve) => setTimeout(resolve, lockPollMs));
          continue;
        }
        if (availability === "reclaimable") {
          await reclaimStaleLock(transactionId, path);
        }
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
        if (Date.now() >= deadline) {
          throw new DacsError("timed out waiting for the AP2 settlement-store lock");
        }
        await new Promise((resolve) => setTimeout(resolve, lockPollMs));
      }
    } finally {
      await rm(candidate, { recursive: true, force: true }).catch(() => {});
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

  const unboundRecords = await bindExistingPhases();

  return {
    async claim(input): Promise<Ap2BindingClaim> {
      let phaseKey: string;
      try {
        phaseKey = deriveAp2IdempotencyKey(input.intent.jobId, input.intent.phaseIndex);
      } catch {
        return { status: "corrupt", reason: "ap2-binding-claim-input-invalid" };
      }
      if (input.intent.idempotencyKey !== phaseKey) {
        return { status: "corrupt", reason: "ap2-binding-claim-input-invalid" };
      }
      // Lock order is always phase, then transaction; no other path takes both.
      return locked(phaseLock(phaseKey), () => locked(input.intent.transactionId, async () => {
        if (!Number.isSafeInteger(input.now) || input.now < 0 ||
            !Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs <= 0 ||
            input.now + input.leaseDurationMs > Number.MAX_SAFE_INTEGER ||
            (input.noReferenceReplayWindowMs !== undefined &&
              (!Number.isSafeInteger(input.noReferenceReplayWindowMs) || input.noReferenceReplayWindowMs <= 0 ||
                !Number.isSafeInteger(input.now + input.noReferenceReplayWindowMs))) ||
            !nonEmpty(input.owner)) {
          return { status: "corrupt", reason: "ap2-binding-claim-input-invalid" };
        }
        const phase = await readPhase(phaseKey);
        if (phase.status === "corrupt") return phase;
        if (phase.status === "ok") {
          if (phase.transactionIds.length !== 1) {
            return { status: "corrupt", reason: "ap2-phase-binding-conflict" };
          }
          if (phase.transactionIds[0] !== input.intent.transactionId) {
            return { status: "conflict", reason: AP2_PHASE_BOUND_ELSEWHERE };
          }
        }
        const found = await readRecord(input.intent.transactionId);
        if (found.status === "corrupt") return found;
        if (found.status === "absent") {
          // A record no phase accounts for may hold any phase: bind nothing new.
          if (unboundRecords > 0) return { status: "corrupt", reason: UNBOUND_RECORDS };
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
            ...(input.noReferenceReplayWindowMs === undefined ? {} : { replayDeadline: input.now + input.noReferenceReplayWindowMs }),
            updatedAt: input.now,
          };
          validateRecord(record, intent.transactionId);
          // The phase is bound before its record exists, so a crash between
          // the two leaves the phase reserved for this transaction_id only.
          if (phase.status === "absent") await writePhase(phaseKey, [intent.transactionId], "create");
          await atomicWrite(recordPath(intent.transactionId), record);
          return { status: "acquired", intent: clone(record.intent), lease: clone(record.lease),
            createdAt: record.createdAt,
            ...(record.replayDeadline === undefined ? {} : { replayDeadline: record.replayDeadline }),
          };
        }
        const record = found.record;
        if (record.intent.bindingHash !== input.intent.bindingHash) {
          return { status: "conflict", reason: ap2BindingConflictReason(record.intent, input.intent) };
        }
        // A record whose phase binding was lost is rebound to itself.
        if (phase.status === "absent") await writePhase(phaseKey, [record.intent.transactionId], "create");
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
            createdAt: record.createdAt,
            ...(record.replayDeadline === undefined ? {} : { replayDeadline: record.replayDeadline }),
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
          createdAt: updated.createdAt,
          ...(updated.replayDeadline === undefined ? {} : { replayDeadline: updated.replayDeadline }),
          ...(updated.providerRef ? { providerRef: updated.providerRef } : {}),
        };
      }));
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

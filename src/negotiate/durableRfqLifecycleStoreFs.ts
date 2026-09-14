import {
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  lstat,
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { types as nodeTypes } from "node:util";

import { canonicalize, sha256Hex } from "../canonical/index.js";
import { snapshotCanonicalJsonRead } from "../canonical/snapshot.js";
import { DacsError } from "../errors.js";
import {
  atomicWritePrivateFile,
  exclusiveWritePrivateFile,
  preparePrivateStoreDirectory,
  readPrivateFile,
} from "../filesystem/privateStore.js";
import {
  DURABLE_RFQ_LIFECYCLE_STORE_VERSION,
  durableRfqLifecycleRecordViolation,
  durableRfqLifecycleTransitionViolation,
  type DurableRfqLifecycleRecord,
  type DurableRfqLifecycleRole,
  type DurableRfqLifecycleStore,
  type DurableRfqRecordCreate,
  type DurableRfqRecordLoad,
  type DurableRfqRecordWrite,
} from "./durableRfqLifecycle.js";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const ENVELOPE_VERSION = 1 as const;
const MAC_DOMAIN = "dacs-rfq-lifecycle-local-store:v1:";
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_POLL_MS = 5;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAC = /^[0-9a-f]{64}$/;
const FILESYSTEM_LABEL = "RFQ filesystem lifecycle store";

export interface FsDurableRfqLifecycleStoreOptions {
  /** Absolute, role-local directory owned exclusively by this store. */
  dir: string;
  role: DurableRfqLifecycleRole;
  /** Role-local secret with at least 256 bits of entropy; never persisted. */
  integrityKey: Uint8Array;
  lockTimeoutMs?: number;
  lockStaleMs?: number;
  lockPollMs?: number;
}

interface StoredRfqEnvelope<TSignature> {
  envelopeVersion: typeof ENVELOPE_VERSION;
  role: DurableRfqLifecycleRole;
  jobKeyHash: string;
  record: DurableRfqLifecycleRecord<TSignature>;
  mac: string;
}

interface LockOwner {
  pid: number;
  token: string;
}

type DataRecord = Record<string, unknown>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function plainRecord(value: unknown): value is DataRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: DataRecord, required: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === required.length && required.every((key) => keys.includes(key));
}

function positiveInteger(value: unknown, fallback: number, label: string): number {
  const selected = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(selected) || (selected as number) <= 0) {
    throw new DacsError(`${label} must be a positive safe integer`);
  }
  return selected as number;
}

function captureOptions(
  value: FsDurableRfqLifecycleStoreOptions,
): Readonly<{
  dir: string;
  role: DurableRfqLifecycleRole;
  integrityKey: Uint8Array;
  lockTimeoutMs: number;
  lockStaleMs: number;
  lockPollMs: number;
}> {
  if (!plainRecord(value)) {
    throw new DacsError("RFQ filesystem store options must be a plain object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set([
    "dir",
    "role",
    "integrityKey",
    "lockTimeoutMs",
    "lockStaleMs",
    "lockPollMs",
  ]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new DacsError("RFQ filesystem store option is unsupported");
    }
    const descriptor = descriptors[key];
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      descriptor.value === undefined
    ) {
      throw new DacsError("RFQ filesystem store options must use data properties");
    }
  }
  const dir = descriptors.dir?.value;
  const role = descriptors.role?.value;
  const key = descriptors.integrityKey?.value;
  if (
    typeof dir !== "string" ||
    dir.length === 0 ||
    dir.trim() !== dir ||
    !isAbsolute(dir)
  ) {
    throw new DacsError("RFQ filesystem store directory must be an absolute path");
  }
  if (role !== "buyer" && role !== "seller") {
    throw new DacsError("RFQ filesystem store role must be buyer or seller");
  }
  if (
    !(key instanceof Uint8Array) ||
    nodeTypes.isProxy(key) ||
    key.byteLength < 32
  ) {
    throw new DacsError("RFQ filesystem store integrityKey must contain at least 32 bytes");
  }
  return Object.freeze({
    dir,
    role,
    integrityKey: Uint8Array.from(key),
    lockTimeoutMs: positiveInteger(
      descriptors.lockTimeoutMs?.value,
      DEFAULT_LOCK_TIMEOUT_MS,
      "RFQ filesystem lockTimeoutMs",
    ),
    lockStaleMs: positiveInteger(
      descriptors.lockStaleMs?.value,
      DEFAULT_LOCK_STALE_MS,
      "RFQ filesystem lockStaleMs",
    ),
    lockPollMs: positiveInteger(
      descriptors.lockPollMs?.value,
      DEFAULT_LOCK_POLL_MS,
      "RFQ filesystem lockPollMs",
    ),
  });
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

async function requireExactPrivateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  const uid = currentUid();
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== DIR_MODE ||
    (uid !== undefined && metadata.uid !== uid)
  ) {
    throw new DacsError(
      "RFQ filesystem store rejects unsafe existing directory permissions",
    );
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function sameOwner(left: LockOwner, right: LockOwner | null): boolean {
  return right !== null && left.pid === right.pid && left.token === right.token;
}

export async function createFsDurableRfqLifecycleStore<TSignature = unknown>(
  options: FsDurableRfqLifecycleStoreOptions,
): Promise<DurableRfqLifecycleStore<TSignature>> {
  const captured = captureOptions(options);
  const root = await preparePrivateStoreDirectory(
    captured.dir,
    FILESYSTEM_LABEL,
  );
  const recordsDir = await preparePrivateStoreDirectory(
    join(root, "records"),
    FILESYSTEM_LABEL,
  );
  const locksDir = await preparePrivateStoreDirectory(
    join(root, "locks"),
    FILESYSTEM_LABEL,
  );
  await requireExactPrivateDirectory(root);
  await requireExactPrivateDirectory(recordsDir);
  await requireExactPrivateDirectory(locksDir);

  const jobKeyHash = (role: DurableRfqLifecycleRole, jobId: string) =>
    sha256Hex(`${role}\u0000${jobId}`);
  const recordPath = (role: DurableRfqLifecycleRole, jobId: string) =>
    join(recordsDir, `${jobKeyHash(role, jobId)}.json`);
  const lockPath = (role: DurableRfqLifecycleRole, jobId: string) =>
    join(locksDir, `${jobKeyHash(role, jobId)}.lock`);
  const reclaimGatePath = join(locksDir, ".reclaim");
  const reclaimQuarantinePrefix = ".reclaim.";
  const reclaimQuarantinePath = () =>
    join(locksDir, `${reclaimQuarantinePrefix}${randomUUID()}.quarantine`);

  async function syncDirectory(path: string): Promise<void> {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  function envelopeMaterial<T>(
    role: DurableRfqLifecycleRole,
    hash: string,
    record: Readonly<DurableRfqLifecycleRecord<T>>,
  ) {
    return {
      envelopeVersion: ENVELOPE_VERSION,
      role,
      jobKeyHash: hash,
      record,
    };
  }

  function recordMac<T>(
    role: DurableRfqLifecycleRole,
    hash: string,
    record: Readonly<DurableRfqLifecycleRecord<T>>,
  ): string {
    return createHmac("sha256", captured.integrityKey)
      .update(MAC_DOMAIN, "utf8")
      .update(canonicalize(envelopeMaterial(role, hash, record)), "utf8")
      .digest("hex");
  }

  function envelope<T>(
    role: DurableRfqLifecycleRole,
    jobId: string,
    record: Readonly<DurableRfqLifecycleRecord<T>>,
  ): StoredRfqEnvelope<T> {
    const hash = jobKeyHash(role, jobId);
    return {
      ...envelopeMaterial(role, hash, record),
      mac: recordMac(role, hash, record),
    };
  }

  async function safeReadText(path: string): Promise<"missing" | string> {
    try {
      const metadata = await lstat(path);
      const uid = currentUid();
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        (metadata.mode & 0o777) !== FILE_MODE ||
        (uid !== undefined && metadata.uid !== uid) ||
        metadata.size > MAX_RECORD_BYTES
      ) {
        throw new DacsError("RFQ filesystem record has unsafe metadata");
      }
      const text = await readPrivateFile(path, "utf8", FILESYSTEM_LABEL);
      if (Buffer.byteLength(text, "utf8") > MAX_RECORD_BYTES) {
        throw new DacsError("RFQ filesystem record exceeds the size limit");
      }
      return text;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return "missing";
      if (code === "ELOOP") {
        throw new DacsError("RFQ filesystem record path is a symbolic link");
      }
      throw cause;
    }
  }

  async function readRecord(
    role: DurableRfqLifecycleRole,
    jobId: string,
  ): Promise<DurableRfqRecordLoad<TSignature>> {
    if (role !== captured.role) {
      return { status: "corrupt", reason: "RFQ store role isolation was violated" };
    }
    let text: "missing" | string;
    try {
      text = await safeReadText(recordPath(role, jobId));
    } catch (cause) {
      return {
        status: cause instanceof DacsError ? "corrupt" : "unavailable",
        reason: cause instanceof Error ? cause.message : "RFQ record cannot be read safely",
      };
    }
    if (text === "missing") return { status: "missing" };
    let parsed: unknown;
    try {
      parsed = snapshotCanonicalJsonRead(JSON.parse(text), "stored RFQ envelope");
    } catch {
      return { status: "corrupt", reason: "RFQ record is not canonical JSON" };
    }
    if (
      !plainRecord(parsed) ||
      !exactKeys(parsed, ["envelopeVersion", "role", "jobKeyHash", "record", "mac"]) ||
      parsed.envelopeVersion !== ENVELOPE_VERSION ||
      parsed.role !== role ||
      parsed.jobKeyHash !== jobKeyHash(role, jobId) ||
      typeof parsed.mac !== "string" ||
      !MAC.test(parsed.mac) ||
      !plainRecord(parsed.record)
    ) {
      return { status: "corrupt", reason: "RFQ record envelope is malformed" };
    }
    const expected = recordMac(
      role,
      parsed.jobKeyHash as string,
      parsed.record as unknown as DurableRfqLifecycleRecord<TSignature>,
    );
    if (
      !timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(parsed.mac, "hex"))
    ) {
      return { status: "corrupt", reason: "RFQ record authentication failed" };
    }
    const version = parsed.record.storeVersion;
    if (typeof version !== "number") {
      return { status: "corrupt", reason: "RFQ record is missing storeVersion" };
    }
    if (version !== DURABLE_RFQ_LIFECYCLE_STORE_VERSION) {
      return { status: "unsupported", version };
    }
    const violation = durableRfqLifecycleRecordViolation<TSignature>(parsed.record);
    if (violation !== null) return { status: "corrupt", reason: violation };
    const record = parsed.record as unknown as DurableRfqLifecycleRecord<TSignature>;
    if (record.role !== role || record.jobId !== jobId) {
      return { status: "corrupt", reason: "RFQ record path identity differs" };
    }
    return { status: "ok", record: structuredClone(record) };
  }

  async function createRecordFile(
    role: DurableRfqLifecycleRole,
    jobId: string,
    record: Readonly<DurableRfqLifecycleRecord<TSignature>>,
  ): Promise<"created" | "exists"> {
    const path = recordPath(role, jobId);
    try {
      await exclusiveWritePrivateFile(
        path,
        canonicalize(envelope(role, jobId, record)),
        FILESYSTEM_LABEL,
      );
      return "created";
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") return "exists";
      throw cause;
    }
  }

  async function replaceRecordFile(
    role: DurableRfqLifecycleRole,
    jobId: string,
    record: Readonly<DurableRfqLifecycleRecord<TSignature>>,
  ): Promise<void> {
    const path = recordPath(role, jobId);
    await atomicWritePrivateFile(
      path,
      canonicalize(envelope(role, jobId, record)),
      FILESYSTEM_LABEL,
    );
  }

  async function readLockOwner(path: string): Promise<LockOwner | null> {
    try {
      const metadata = await lstat(path);
      if (metadata.size > 4_096) return null;
      const text = await readPrivateFile(path, "utf8", FILESYSTEM_LABEL);
      if (Buffer.byteLength(text, "utf8") > 4_096) return null;
      const parsed = JSON.parse(text) as unknown;
      return plainRecord(parsed) &&
        Number.isSafeInteger(parsed.pid) &&
        (parsed.pid as number) > 0 &&
        typeof parsed.token === "string" &&
        parsed.token.length > 0
        ? { pid: parsed.pid as number, token: parsed.token }
        : null;
    } catch {
      return null;
    }
  }

  async function lockMetadata(path: string) {
    const metadata = await lstat(path);
    const uid = currentUid();
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o777) !== FILE_MODE ||
      (uid !== undefined && metadata.uid !== uid) ||
      metadata.size > 4_096
    ) {
      throw new DacsError("RFQ filesystem lock path has unsafe metadata");
    }
    return metadata;
  }

  async function unlinkIfExists(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }

  async function exclusiveWriteOwner(path: string, owner: LockOwner): Promise<void> {
    await exclusiveWritePrivateFile(
      path,
      canonicalize(owner),
      FILESYSTEM_LABEL,
    );
  }

  async function reclaimGateQuarantines(): Promise<string[]> {
    const names = (await readdir(locksDir)).filter(
      (name) =>
        name.startsWith(reclaimQuarantinePrefix) && name.endsWith(".quarantine"),
    );
    const live: string[] = [];
    for (const name of names) {
      const path = join(locksDir, name);
      try {
        const metadata = await lockMetadata(path);
        const owner = await readLockOwner(path);
        if (
          Date.now() - metadata.mtimeMs <= captured.lockStaleMs ||
          owner === null ||
          processAlive(owner.pid)
        ) {
          live.push(path);
          continue;
        }
        await unlinkIfExists(path);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
    }
    return live;
  }

  async function quarantineStaleReclaimGate(): Promise<void> {
    let observed;
    try {
      observed = await lockMetadata(reclaimGatePath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw cause;
    }
    if (Date.now() - observed.mtimeMs <= captured.lockStaleMs) return;
    const observedOwner = await readLockOwner(reclaimGatePath);
    if (observedOwner === null) {
      throw new DacsError("RFQ filesystem reclaim gate owner is malformed");
    }
    if (processAlive(observedOwner.pid)) return;

    const quarantine = reclaimQuarantinePath();
    try {
      await rename(reclaimGatePath, quarantine);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw cause;
    }
    const moved = await lockMetadata(quarantine);
    const movedOwner = await readLockOwner(quarantine);
    if (
      moved.dev === observed.dev &&
      moved.ino === observed.ino &&
      sameOwner(observedOwner, movedOwner) &&
      Date.now() - moved.mtimeMs > captured.lockStaleMs &&
      movedOwner !== null &&
      !processAlive(movedOwner.pid)
    ) {
      await unlinkIfExists(quarantine);
    }
    // A changed gate is left under its unique name. All reclaimers treat a
    // live quarantine as authoritative, so a replacement cannot be erased.
  }

  async function releaseOwnedFile(path: string, owner: LockOwner): Promise<void> {
    if (!sameOwner(owner, await readLockOwner(path))) return;
    const released = `${path}.${owner.token}.released`;
    try {
      await rename(path, released);
      if (sameOwner(owner, await readLockOwner(released))) {
        await unlinkIfExists(released);
        await syncDirectory(locksDir);
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }

  async function releaseReclaimGate(owner: LockOwner): Promise<void> {
    await releaseOwnedFile(reclaimGatePath, owner);
    for (const name of (await readdir(locksDir)).filter(
      (item) =>
        item.startsWith(reclaimQuarantinePrefix) && item.endsWith(".quarantine"),
    )) {
      const path = join(locksDir, name);
      if (sameOwner(owner, await readLockOwner(path))) await unlinkIfExists(path);
    }
  }

  async function acquireReclaimGate(owner: LockOwner): Promise<boolean> {
    if ((await reclaimGateQuarantines()).length > 0) return false;
    try {
      await exclusiveWriteOwner(reclaimGatePath, owner);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      await quarantineStaleReclaimGate();
      return false;
    }
    if ((await reclaimGateQuarantines()).length > 0) {
      await releaseReclaimGate(owner);
      return false;
    }
    return true;
  }

  async function reclaimLockIfSafe(path: string): Promise<void> {
    let candidate;
    try {
      candidate = await lockMetadata(path);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw cause;
    }
    if (Date.now() - candidate.mtimeMs <= captured.lockStaleMs) return;
    const candidateOwner = await readLockOwner(path);
    if (candidateOwner === null) {
      throw new DacsError("RFQ filesystem lock owner is malformed");
    }
    if (processAlive(candidateOwner.pid)) return;

    const gateOwner = { pid: process.pid, token: randomUUID() };
    if (!(await acquireReclaimGate(gateOwner))) return;
    try {
      let observed;
      try {
        observed = await lockMetadata(path);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
        throw cause;
      }
      if (Date.now() - observed.mtimeMs <= captured.lockStaleMs) return;
      const observedOwner = await readLockOwner(path);
      if (observedOwner === null) {
        throw new DacsError("RFQ filesystem lock owner is malformed");
      }
      if (processAlive(observedOwner.pid)) return;

      const quarantine = `${path}.${randomUUID()}.stale`;
      try {
        await rename(path, quarantine);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
        throw cause;
      }
      const moved = await lockMetadata(quarantine);
      const movedOwner = await readLockOwner(quarantine);
      if (
        moved.dev !== observed.dev ||
        moved.ino !== observed.ino ||
        !sameOwner(observedOwner, movedOwner) ||
        Date.now() - moved.mtimeMs <= captured.lockStaleMs ||
        movedOwner === null ||
        processAlive(movedOwner.pid)
      ) {
        throw new DacsError("RFQ filesystem lock changed during stale recovery");
      }
      await unlinkIfExists(quarantine);
      await syncDirectory(locksDir);
    } finally {
      await releaseReclaimGate(gateOwner);
    }
  }

  async function withLock<T>(
    role: DurableRfqLifecycleRole,
    jobId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const path = lockPath(role, jobId);
    const owner = { pid: process.pid, token: randomUUID() };
    const deadline = Date.now() + captured.lockTimeoutMs;
    for (;;) {
      try {
        await exclusiveWriteOwner(path, owner);
        break;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
        await reclaimLockIfSafe(path);
        if (Date.now() >= deadline) {
          throw new DacsError("RFQ filesystem record lock timed out");
        }
        await sleep(captured.lockPollMs);
      }
    }
    try {
      return await operation();
    } finally {
      await releaseOwnedFile(path, owner);
    }
  }

  return {
    load(role, jobId) {
      return readRecord(role, jobId);
    },
    async create(candidate): Promise<DurableRfqRecordCreate<TSignature>> {
      let ownedCandidate: DurableRfqLifecycleRecord<TSignature>;
      try {
        ownedCandidate = snapshotCanonicalJsonRead(
          candidate,
          "RFQ filesystem create candidate",
        ) as DurableRfqLifecycleRecord<TSignature>;
      } catch {
        return { status: "corrupt", reason: "RFQ create candidate is not canonical JSON" };
      }
      if (ownedCandidate.role !== captured.role) {
        return { status: "corrupt", reason: "RFQ store role isolation was violated" };
      }
      const violation = durableRfqLifecycleRecordViolation<TSignature>(ownedCandidate);
      if (violation !== null) return { status: "corrupt", reason: violation };
      try {
        return await withLock(ownedCandidate.role, ownedCandidate.jobId, async () => {
          const loaded = await readRecord(ownedCandidate.role, ownedCandidate.jobId);
          if (loaded.status === "ok") {
            return loaded.record.bindingHash === ownedCandidate.bindingHash
              ? { status: "existing", record: loaded.record }
              : { status: "conflict", reason: "jobId already binds another RFQ" };
          }
          if (loaded.status !== "missing") return loaded;
          const created = await createRecordFile(
            ownedCandidate.role,
            ownedCandidate.jobId,
            ownedCandidate,
          );
          if (created !== "created") {
            return {
              status: "unavailable",
              reason: "RFQ record appeared during exclusive creation",
            };
          }
          return { status: "created", record: structuredClone(ownedCandidate) };
        });
      } catch {
        return { status: "unavailable", reason: "RFQ filesystem create failed" };
      }
    },
    async compareAndSwap(
      role,
      jobId,
      expectedRevision,
      candidate,
    ): Promise<DurableRfqRecordWrite<TSignature>> {
      let ownedCandidate: DurableRfqLifecycleRecord<TSignature>;
      try {
        ownedCandidate = snapshotCanonicalJsonRead(
          candidate,
          "RFQ filesystem CAS candidate",
        ) as DurableRfqLifecycleRecord<TSignature>;
      } catch {
        return { status: "corrupt", reason: "RFQ CAS candidate is not canonical JSON" };
      }
      if (
        role !== captured.role ||
        ownedCandidate.role !== role ||
        ownedCandidate.jobId !== jobId
      ) {
        return { status: "corrupt", reason: "RFQ store role/path isolation was violated" };
      }
      const violation = durableRfqLifecycleRecordViolation<TSignature>(ownedCandidate);
      if (violation !== null) return { status: "corrupt", reason: violation };
      try {
        return await withLock(role, jobId, async () => {
          const loaded = await readRecord(role, jobId);
          if (loaded.status !== "ok") return loaded;
          if (loaded.record.revision !== expectedRevision) return { status: "stale" };
          if (
            ownedCandidate.revision !== expectedRevision + 1 ||
            ownedCandidate.bindingHash !== loaded.record.bindingHash ||
            ownedCandidate.createdAt !== loaded.record.createdAt ||
            ownedCandidate.updatedAt < loaded.record.updatedAt
          ) {
            return { status: "corrupt", reason: "RFQ CAS write is non-monotonic" };
          }
          const transitionViolation =
            durableRfqLifecycleTransitionViolation<TSignature>(
              loaded.record,
              ownedCandidate,
            );
          if (transitionViolation !== null) {
            return { status: "corrupt", reason: transitionViolation };
          }
          await replaceRecordFile(role, jobId, ownedCandidate);
          return { status: "written", record: structuredClone(ownedCandidate) };
        });
      } catch {
        return { status: "unavailable", reason: "RFQ filesystem CAS failed" };
      }
    },
  };
}

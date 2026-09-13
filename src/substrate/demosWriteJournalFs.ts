import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import { DacsError } from "../errors.js";
import {
  atomicWritePrivateFile,
  exclusiveWritePrivateFile,
  preparePrivateStoreDirectory,
  readPrivateFile,
} from "../filesystem/privateStore.js";
import {
  DEMOS_WRITE_JOURNAL_VERSION,
  type DemosWriteJournal,
  type DemosWriteJournalKey,
  type DemosWriteJournalRecord,
  type DemosWriteJournalSnapshot,
} from "./demosWriteJournal.js";

const DIR_MODE = 0o700;
const DEFAULT_LOCK_STALE_MS = 30_000;
// A write lease intentionally spans Demos confirmation and authenticated
// native readback (normally up to 120 seconds). Contenders must queue beyond
// that safety boundary instead of failing during an ordinary consensus wait.
const DEFAULT_LOCK_TIMEOUT_MS = 10 * 60_000;
const LOCK_RETRY_MS = 10;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface LockOwner {
  token: string;
  pid: number;
  hostname: string;
  createdAt: number;
}

export interface FsDemosWriteJournalOptions {
  /**
   * Directory exclusively owned by this host-local journal (created if
   * absent). Multi-host writers require a shared backend with fencing; a
   * network-filesystem lock owned by another hostname is never auto-stolen.
   */
  dir: string;
  lockStaleMs?: number;
  /** Maximum queue wait; defaults to ten minutes, not the write lease TTL. */
  lockTimeoutMs?: number;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const WRITE_KINDS = new Set(["mutable", "immutable", "native-transfer"]);
const WRITE_OPERATIONS = new Set(["create", "update", "transfer"]);
const WRITE_STAGES = new Set([
  "prepared",
  "signed",
  "broadcast-intent",
  "canonical-confirmed",
  "canonical-failed",
  "native-visible",
  "index-visible",
]);

function validOptionalString(value: unknown): boolean {
  return value === undefined || nonEmpty(value);
}

function positiveIntegerText(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}

function nonNegativeIntegerText(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value);
}

function canonicalHex32(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function sameWallet(left: string, right: string): boolean {
  return left.toLowerCase().replace(/^0x/, "") ===
    right.toLowerCase().replace(/^0x/, "");
}

function validateJournalRecord(
  value: unknown,
  snapshotGeneration: number,
  index: number,
  expectedWallet: string,
): DemosWriteJournalRecord {
  const invalid = (reason: string): never => {
    throw new DacsError(`Demos write journal record ${index} ${reason}`);
  };
  if (!isObject(value)) invalid("is not a JSON object");
  const record = value as Record<string, unknown>;
  if (
    !nonEmpty(record.writeId) ||
    !nonNegativeInteger(record.generation) ||
    record.generation === 0 ||
    record.generation > snapshotGeneration ||
    !WRITE_KINDS.has(String(record.kind)) ||
    !WRITE_OPERATIONS.has(String(record.operation)) ||
    !WRITE_STAGES.has(String(record.stage)) ||
    !nonEmpty(record.logicalName) ||
    !nonEmpty(record.programName) ||
    !nonEmpty(record.owner) ||
    !sameWallet(record.owner as string, expectedWallet) ||
    !nonEmpty(record.nativeAddress) ||
    !nonEmpty(record.valueHash) ||
    !validOptionalString(record.metadataHash) ||
    !nonNegativeInteger(record.nonce) ||
    !nonNegativeInteger(record.updatedAt) ||
    !validOptionalString(record.txRef) ||
    !validOptionalString(record.signedTransaction) ||
    !validOptionalString(record.signedTransactionHash) ||
    (record.blockNumber !== undefined && !nonNegativeInteger(record.blockNumber)) ||
    !validOptionalString(record.blockHash) ||
    (record.blockTimestamp !== undefined &&
      !nonNegativeInteger(record.blockTimestamp)) ||
    !validOptionalString(record.finalityProof) ||
    !validOptionalString(record.finalityProofHash)
  ) invalid("has invalid fields");

  const stage = record.stage as DemosWriteJournalRecord["stage"];
  const nativeTransfer = record.kind === "native-transfer";
  if (record.feeBudget !== undefined) {
    if (!isObject(record.feeBudget) ||
        Object.keys(record.feeBudget).sort().join("\0") !==
          ["budgetId", "maximumPerWriteFeeOs", "maximumTotalFeeOs", "reservedFeeOs"]
            .sort().join("\0") ||
        !nonEmpty(record.feeBudget.budgetId) ||
        (record.feeBudget.budgetId as string).length > 256 ||
        !nonNegativeIntegerText(record.feeBudget.maximumPerWriteFeeOs) ||
        !nonNegativeIntegerText(record.feeBudget.maximumTotalFeeOs) ||
        !nonNegativeIntegerText(record.feeBudget.reservedFeeOs) ||
        BigInt(record.feeBudget.maximumPerWriteFeeOs as string) >
          BigInt(record.feeBudget.maximumTotalFeeOs as string) ||
        BigInt(record.feeBudget.reservedFeeOs as string) >
          BigInt(record.feeBudget.maximumPerWriteFeeOs as string) ||
        BigInt(record.feeBudget.reservedFeeOs as string) >
          BigInt(record.feeBudget.maximumTotalFeeOs as string) ||
        stage === "prepared" || nativeTransfer) {
      invalid("has an invalid aggregate fee reservation");
    }
  }
  if (nativeTransfer !== (record.operation === "transfer")) {
    invalid("has an incompatible kind and operation");
  }
  if (!nativeTransfer && stage !== "prepared" && (
    !nonEmpty(record.txRef) ||
    !nonEmpty(record.signedTransaction) ||
    !nonEmpty(record.signedTransactionHash)
  )) invalid(`at stage ${stage} lacks its signed transaction`);
  if (
    !nativeTransfer && (stage === "canonical-confirmed" ||
      stage === "native-visible" ||
      stage === "index-visible") &&
    (!nonNegativeInteger(record.blockNumber) ||
      !nonEmpty(record.blockHash) ||
      !nonNegativeInteger(record.blockTimestamp) ||
      !nonEmpty(record.finalityProof) ||
      !nonEmpty(record.finalityProofHash))
  ) invalid(`at stage ${stage} lacks canonical block evidence`);

  if (nativeTransfer) {
    if (stage !== "prepared" && stage !== "broadcast-intent" &&
        stage !== "canonical-confirmed" && stage !== "canonical-failed") {
      invalid(`has invalid native-transfer stage ${stage}`);
    }
    if (!isObject(record.transfer)) invalid("has no native transfer binding");
    const transfer = record.transfer as Record<string, unknown>;
    if (transfer.payer !== record.owner || transfer.payee !== record.nativeAddress ||
        !canonicalHex32(transfer.payer) || !canonicalHex32(transfer.payee) ||
        !canonicalHex32(record.txRef) || !canonicalHex32(record.valueHash) ||
        !positiveIntegerText(transfer.amountOs) ||
        (transfer.denomination !== "os" && transfer.denomination !== "dem") ||
        !nonEmpty(transfer.network) ||
        (transfer.maxTotalDebitOs !== undefined &&
          !positiveIntegerText(transfer.maxTotalDebitOs)) ||
        transfer.maxTotalDebitOs !== undefined &&
          BigInt(transfer.maxTotalDebitOs as string) < BigInt(transfer.amountOs as string) ||
        !validOptionalString(transfer.settlementKey) || !nonEmpty(record.txRef) ||
        stage === "canonical-confirmed" && (
          !nonNegativeInteger(record.blockNumber) || !nonEmpty(record.blockHash) ||
          !nonNegativeInteger(record.blockTimestamp) || !nonEmpty(record.finalityProof) ||
          !nonEmpty(record.finalityProofHash)) ||
        record.metadataHash !== undefined || record.signedTransaction !== undefined ||
        record.signedTransactionHash !== undefined || record.nativeRead !== undefined ||
        record.indexRead !== undefined) {
      invalid("has an invalid native transfer binding");
    }
  } else if (record.transfer !== undefined) {
    invalid("anchor record carries a native transfer binding");
  }

  if (record.nativeRead !== undefined) {
    if (!isObject(record.nativeRead)) invalid("has invalid native readback");
    const native = record.nativeRead as Record<string, unknown>;
    if (
      !nonEmpty(native.owner) ||
      native.owner.toLowerCase() !== (record.owner as string).toLowerCase() ||
      native.programName !== record.programName ||
      native.valueHash !== record.valueHash ||
      native.metadataHash !== record.metadataHash ||
      !nonNegativeInteger(native.observedAt)
    ) invalid("has a native readback that does not bind its write");
  }
  if (
    (stage === "native-visible" || stage === "index-visible") &&
    record.nativeRead === undefined
  ) invalid(`at stage ${stage} lacks native readback`);

  if (record.indexRead !== undefined) {
    if (!isObject(record.indexRead)) invalid("has invalid index observation");
    const observed = record.indexRead as Record<string, unknown>;
    if (
      observed.address !== record.nativeAddress ||
      !nonNegativeInteger(observed.observedAt)
    ) invalid("has an index observation that does not bind its native address");
  }
  if (stage === "index-visible" && record.indexRead === undefined) {
    invalid("at stage index-visible lacks its index observation");
  }
  return structuredClone(value) as DemosWriteJournalRecord;
}

function keyDigest(key: DemosWriteJournalKey): string {
  return createHash("sha256")
    .update(key.chainIdentity)
    .update("\0")
    .update(key.wallet)
    .digest("hex");
}

function cloneRecord(record: DemosWriteJournalRecord): DemosWriteJournalRecord {
  return structuredClone(record);
}

function validateAggregateFeeReservations(
  records: readonly DemosWriteJournalRecord[],
): void {
  const budgets = new Map<string, Readonly<{
    maximumPerWrite: bigint;
    maximumTotal: bigint;
    reserved: bigint;
  }>>();
  for (const record of records) {
    const feeBudget = record.feeBudget;
    if (feeBudget === undefined) continue;
    const maximumPerWrite = BigInt(feeBudget.maximumPerWriteFeeOs);
    const maximumTotal = BigInt(feeBudget.maximumTotalFeeOs);
    const prior = budgets.get(feeBudget.budgetId);
    if (prior !== undefined && prior.maximumTotal !== maximumTotal) {
      throw new DacsError("Demos write journal aggregate fee budget ceilings conflict");
    }
    if (prior !== undefined && prior.maximumPerWrite !== maximumPerWrite) {
      throw new DacsError("Demos write journal per-write fee budget ceilings conflict");
    }
    const reserved = (prior?.reserved ?? 0n) + BigInt(feeBudget.reservedFeeOs);
    if (reserved > maximumTotal) {
      throw new DacsError("Demos write journal aggregate fee budget is exceeded");
    }
    budgets.set(feeBudget.budgetId, { maximumPerWrite, maximumTotal, reserved });
  }
}

function validateSnapshot(
  value: unknown,
  key: DemosWriteJournalKey,
): DemosWriteJournalSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DacsError("Demos write journal is not a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== DEMOS_WRITE_JOURNAL_VERSION) {
    throw new DacsError(
      `unsupported Demos write journal version ${String(record.version)}`,
    );
  }
  if (
    record.chainIdentity !== key.chainIdentity ||
    record.wallet !== key.wallet
  ) {
    throw new DacsError("Demos write journal key does not match its file name");
  }
  if (!Number.isSafeInteger(record.generation) || (record.generation as number) < 0) {
    throw new DacsError("Demos write journal generation is invalid");
  }
  if (!Array.isArray(record.records)) {
    throw new DacsError("Demos write journal records are invalid");
  }
  const generation = record.generation as number;
  const records = record.records.map((candidate, index) =>
    validateJournalRecord(candidate, generation, index, key.wallet)
  );
  if (new Set(records.map(({ writeId }) => writeId)).size !== records.length) {
    throw new DacsError("Demos write journal contains duplicate write ids");
  }
  validateAggregateFeeReservations(records);
  return {
    version: DEMOS_WRITE_JOURNAL_VERSION,
    chainIdentity: key.chainIdentity,
    wallet: key.wallet,
    generation,
    records,
  };
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await atomicWritePrivateFile(
    path,
    JSON.stringify(value),
    "filesystem Demos write journal",
  );
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function nestedErrorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current !== null &&
      typeof current === "object"; depth += 1) {
    const code = (current as NodeJS.ErrnoException).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export async function createFsDemosWriteJournal(
  options: FsDemosWriteJournalOptions,
): Promise<DemosWriteJournal> {
  if (!options || !nonEmpty(options.dir)) {
    throw new DacsError("filesystem Demos write journal requires a directory");
  }
  const lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  if (!Number.isFinite(lockStaleMs) || lockStaleMs <= 0) {
    throw new DacsError("Demos write journal lockStaleMs must be positive");
  }
  if (!Number.isFinite(lockTimeoutMs) || lockTimeoutMs <= 0) {
    throw new DacsError("Demos write journal lockTimeoutMs must be positive");
  }

  const root = await preparePrivateStoreDirectory(
    options.dir,
    "filesystem Demos write journal",
  );
  const statesDir = await preparePrivateStoreDirectory(
    join(root, "wallets"),
    "filesystem Demos write journal",
  );
  const locksDir = await preparePrivateStoreDirectory(
    join(root, "locks"),
    "filesystem Demos write journal",
  );

  const localHostname = hostname();

  async function syncDirectory(path: string): Promise<void> {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  function sameOwner(left: LockOwner | null, right: LockOwner | null): boolean {
    return left === null
      ? right === null
      : right !== null &&
        left.token === right.token &&
        left.pid === right.pid &&
        left.hostname === right.hostname &&
        left.createdAt === right.createdAt;
  }

  async function readLockOwner(path: string): Promise<LockOwner | null> {
    try {
      const value = JSON.parse(await readPrivateFile(
        join(path, "owner.json"),
        "utf8",
        "filesystem Demos write journal lock",
      )) as unknown;
      if (!isObject(value) || !nonEmpty(value.token) ||
          !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 ||
          !nonEmpty(value.hostname) || !nonNegativeInteger(value.createdAt)) {
        return null;
      }
      return {
        token: value.token,
        pid: value.pid as number,
        hostname: value.hostname,
        createdAt: value.createdAt as number,
      };
    } catch (error) {
      if (nestedErrorCode(error) === "ENOENT" ||
          error instanceof SyntaxError ||
          (error instanceof DacsError && (
            /file changed while it was being (?:opened|read)/u.test(error.message) ||
            /regular file has 0 hard links/u.test(error.message)
          ))) {
        // Missing or malformed JSON is reclaimable only after it is stale.
        return null;
      }
      // Filesystem-admission failures are not evidence that an owner is absent.
      throw error;
    }
  }

  function ownerIsReclaimable(owner: LockOwner | null, age: number): boolean {
    if (owner === null) return age >= lockStaleMs;
    // This host-local journal never guesses whether a foreign-host owner died.
    if (owner.hostname !== localHostname) return false;
    return !processIsAlive(owner.pid);
  }

  async function inspectLockDirectory(path: string) {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new DacsError("Demos write journal lock path is unsafe");
    }
    return metadata;
  }

  async function publishCompleteOwnerDirectory(
    path: string,
    owner: LockOwner,
  ): Promise<void> {
    const candidate = `${path}.${randomUUID()}.candidate`;
    try {
      await mkdir(candidate, { mode: DIR_MODE });
      await exclusiveWritePrivateFile(
        join(candidate, "owner.json"),
        JSON.stringify(owner),
        "filesystem Demos write journal lock",
      );
      await syncDirectory(candidate);
      // A valid published lock is non-empty, so rename cannot replace it.
      await rename(candidate, path);
      await syncDirectory(locksDir);
    } finally {
      await rm(candidate, { recursive: true, force: true });
    }
  }

  function mutationGatePath(digest: string): string {
    return join(locksDir, `${digest}.mutation`);
  }

  function mutationQuarantinePrefix(digest: string): string {
    return `${digest}.mutation.`;
  }

  function lockQuarantinePrefix(digest: string): string {
    return `${digest}.lock.`;
  }

  async function activeQuarantines(
    prefix: string,
    suffix: string,
  ): Promise<string[]> {
    const live: string[] = [];
    for (const name of (await readdir(locksDir)).filter((candidate) =>
      candidate.startsWith(prefix) && candidate.endsWith(suffix))) {
      const path = join(locksDir, name);
      try {
        const metadata = await inspectLockDirectory(path);
        const owner = await readLockOwner(path);
        if (!ownerIsReclaimable(owner, Date.now() - metadata.mtimeMs)) {
          live.push(path);
          continue;
        }
        await rm(path, { recursive: true, force: true });
        await syncDirectory(locksDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return live;
  }

  async function quarantineStaleMutationGate(digest: string): Promise<void> {
    const path = mutationGatePath(digest);
    let observed;
    try {
      observed = await inspectLockDirectory(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const observedOwner = await readLockOwner(path);
    if (!ownerIsReclaimable(observedOwner, Date.now() - observed.mtimeMs)) return;

    const quarantine = join(
      locksDir,
      `${mutationQuarantinePrefix(digest)}${randomUUID()}.quarantine`,
    );
    try {
      await rename(path, quarantine);
      await syncDirectory(locksDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let moved;
    try {
      moved = await inspectLockDirectory(quarantine);
    } catch (error) {
      // The displaced owner may have completed and removed its own quarantine.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const movedOwner = await readLockOwner(quarantine);
    if (moved.dev === observed.dev && moved.ino === observed.ino &&
        sameOwner(movedOwner, observedOwner) &&
        ownerIsReclaimable(movedOwner, Date.now() - moved.mtimeMs)) {
      await rm(quarantine, { recursive: true, force: true });
      await syncDirectory(locksDir);
    }
    // A moved replacement remains authoritative and blocks later publishers.
  }

  async function releaseMutationGate(digest: string, owner: LockOwner): Promise<void> {
    const path = mutationGatePath(digest);
    if (sameOwner(await readLockOwner(path), owner)) {
      const quarantine = join(
        locksDir,
        `${mutationQuarantinePrefix(digest)}${randomUUID()}.quarantine`,
      );
      try {
        await rename(path, quarantine);
        await syncDirectory(locksDir);
        if (sameOwner(await readLockOwner(quarantine), owner)) {
          await rm(quarantine, { recursive: true, force: true });
          await syncDirectory(locksDir);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    for (const name of (await readdir(locksDir)).filter((candidate) =>
      candidate.startsWith(mutationQuarantinePrefix(digest)) &&
      candidate.endsWith(".quarantine"))) {
      const quarantine = join(locksDir, name);
      if (sameOwner(await readLockOwner(quarantine), owner)) {
        await rm(quarantine, { recursive: true, force: true });
        await syncDirectory(locksDir);
      }
    }
  }

  async function acquireMutationGate(digest: string, owner: LockOwner): Promise<boolean> {
    if ((await activeQuarantines(
      mutationQuarantinePrefix(digest),
      ".quarantine",
    )).length > 0) return false;
    try {
      await publishCompleteOwnerDirectory(mutationGatePath(digest), owner);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      await quarantineStaleMutationGate(digest);
      return false;
    }
    if ((await activeQuarantines(
      mutationQuarantinePrefix(digest),
      ".quarantine",
    )).length > 0) {
      await releaseMutationGate(digest, owner);
      return false;
    }
    return true;
  }

  async function withMutationGate<T>(
    digest: string,
    deadline: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    const owner: LockOwner = {
      token: randomUUID(),
      pid: process.pid,
      hostname: localHostname,
      createdAt: Date.now(),
    };
    while (!await acquireMutationGate(digest, owner)) {
      if (Date.now() >= deadline) {
        throw new DacsError(`timed out acquiring Demos wallet mutation gate ${digest}`);
      }
      await sleep(LOCK_RETRY_MS);
    }
    try {
      return await operation();
    } finally {
      await releaseMutationGate(digest, owner);
    }
  }

  return {
    async acquire(input) {
      if (!nonEmpty(input.chainIdentity) || !nonEmpty(input.wallet)) {
        throw new DacsError(
          "Demos write journal key requires chainIdentity and wallet",
        );
      }
      const key = Object.freeze({
        chainIdentity: input.chainIdentity,
        wallet: input.wallet,
      });
      const digest = keyDigest(key);
      const statePath = join(statesDir, `${digest}.json`);
      const lockPath = join(locksDir, `${digest}.lock`);
      const token = randomUUID();
      const owner: LockOwner = {
        token,
        pid: process.pid,
        hostname: localHostname,
        createdAt: Date.now(),
      };
      const deadline = Date.now() + lockTimeoutMs;

      const reclaimStaleLock = async (): Promise<boolean> =>
        withMutationGate(digest, deadline, async () => {
          if ((await activeQuarantines(
            lockQuarantinePrefix(digest),
            ".stale",
          )).length > 0) {
            throw new DacsError(
              `Demos wallet journal ${digest} has an active quarantined owner`,
            );
          }

          let observed;
          try {
            observed = await inspectLockDirectory(lockPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
            throw error;
          }
          const observedOwner = await readLockOwner(lockPath);
          if (!ownerIsReclaimable(
            observedOwner,
            Date.now() - observed.mtimeMs,
          )) return false;

          const quarantine = `${lockPath}.${randomUUID()}.stale`;
          try {
            await rename(lockPath, quarantine);
            await syncDirectory(locksDir);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
            throw error;
          }
          const moved = await inspectLockDirectory(quarantine);
          const movedOwner = await readLockOwner(quarantine);
          if (moved.dev !== observed.dev || moved.ino !== observed.ino ||
              !sameOwner(movedOwner, observedOwner) ||
              !ownerIsReclaimable(movedOwner, Date.now() - moved.mtimeMs)) {
            throw new DacsError(
              `Demos wallet journal ${digest} changed during stale recovery`,
            );
          }
          await rm(quarantine, { recursive: true, force: true });
          await syncDirectory(locksDir);
          return true;
        });

      const releaseOwnedLock = async (): Promise<void> => {
        let releasedPath: string | undefined;
        await withMutationGate(
          digest,
          Date.now() + lockTimeoutMs,
          async () => {
            if (sameOwner(await readLockOwner(lockPath), owner)) {
              releasedPath = `${lockPath}.${token}.released`;
              try {
                await rename(lockPath, releasedPath);
                await syncDirectory(locksDir);
              } catch (error) {
                releasedPath = undefined;
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              }
            }
          },
        );
        if (releasedPath !== undefined) {
          await rm(releasedPath, { recursive: true, force: true });
          await syncDirectory(locksDir);
        }
      };

      for (;;) {
        const candidate = `${lockPath}.${randomUUID()}.candidate`;
        try {
          await mkdir(candidate, { mode: DIR_MODE });
          await exclusiveWritePrivateFile(
            join(candidate, "owner.json"),
            JSON.stringify(owner),
            "filesystem Demos write journal lock",
          );
          await syncDirectory(candidate);
          await withMutationGate(digest, deadline, async () => {
            if ((await activeQuarantines(
              lockQuarantinePrefix(digest),
              ".stale",
            )).length > 0) {
              throw new DacsError(
                `Demos wallet journal ${digest} has an active quarantined owner`,
              );
            }
            await rename(candidate, lockPath);
            await syncDirectory(locksDir);
          });
          break;
        } catch (error) {
          await rm(candidate, { recursive: true, force: true }).catch(() => {});
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
          await reclaimStaleLock();
          if (Date.now() >= deadline) {
            throw new DacsError(
              `timed out acquiring Demos wallet journal ${digest}`,
            );
          }
          await sleep(LOCK_RETRY_MS);
        }
      }

      let released = false;
      const readState = async (): Promise<DemosWriteJournalSnapshot | undefined> => {
        try {
          return validateSnapshot(
            JSON.parse(await readPrivateFile(
              statePath,
              "utf8",
              "filesystem Demos write journal",
            )) as unknown,
            key,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }
      };

      try {
        const prior = await readState();
        const generation = (prior?.generation ?? 0) + 1;
        let current: DemosWriteJournalSnapshot = {
          version: DEMOS_WRITE_JOURNAL_VERSION,
          ...key,
          generation,
          records: (prior?.records ?? []).map(cloneRecord),
        };
        await atomicWrite(statePath, current);
        let putTail = Promise.resolve();

        const assertCurrent = async (): Promise<void> => {
          if (released) {
            throw new DacsError(
              `Demos write journal fence ${generation} was released`,
            );
          }
          const [disk, lockText] = await Promise.all([
            readState(),
            readLockOwner(lockPath),
          ]);
          if (disk?.generation !== generation || !sameOwner(lockText, owner)) {
            throw new DacsError(
              `Demos write journal fence ${generation} is no longer current`,
            );
          }
        };

        return {
          key,
          generation,
          get snapshot() {
            return structuredClone(current);
          },
          async put(record) {
            const operation = putTail.then(async () => {
              await assertCurrent();
              if (record.generation !== generation) {
                throw new DacsError(
                  `Demos write record generation ${record.generation} does not match lease ${generation}`,
                );
              }
              const checked = validateJournalRecord(
                record,
                generation,
                current.records.length,
                key.wallet,
              );
              const records = current.records
                .filter((candidate) => candidate.writeId !== record.writeId)
                .map(cloneRecord);
              records.push(checked);
              validateAggregateFeeReservations(records);
              current = { ...current, records };
              await atomicWrite(statePath, current);
            });
            putTail = operation.catch(() => undefined);
            await operation;
          },
          assertCurrent,
          async release() {
            if (released) return;
            await putTail;
            released = true;
            await releaseOwnedLock();
          },
        };
      } catch (error) {
        await releaseOwnedLock();
        throw error;
      }
    },
  };
}

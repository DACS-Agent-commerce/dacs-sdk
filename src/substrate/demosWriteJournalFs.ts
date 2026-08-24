import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

import { DacsError } from "../errors.js";
import {
  DEMOS_WRITE_JOURNAL_VERSION,
  type DemosWriteJournal,
  type DemosWriteJournalKey,
  type DemosWriteJournalRecord,
  type DemosWriteJournalSnapshot,
} from "./demosWriteJournal.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
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
  return {
    version: DEMOS_WRITE_JOURNAL_VERSION,
    chainIdentity: key.chainIdentity,
    wallet: key.wallet,
    generation,
    records,
  };
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

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", FILE_MODE);
    try {
      await handle.writeFile(JSON.stringify(value), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
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

  const statesDir = join(options.dir, "wallets");
  const locksDir = join(options.dir, "locks");
  await mkdir(statesDir, { recursive: true, mode: DIR_MODE });
  await mkdir(locksDir, { recursive: true, mode: DIR_MODE });

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
      const ownerPath = join(lockPath, "owner.json");
      const token = randomUUID();
      const owner: LockOwner = {
        token,
        pid: process.pid,
        hostname: hostname(),
        createdAt: Date.now(),
      };
      const deadline = Date.now() + lockTimeoutMs;

      for (;;) {
        try {
          await mkdir(lockPath, { mode: DIR_MODE });
          try {
            await writeFile(ownerPath, JSON.stringify(owner), {
              mode: FILE_MODE,
              flag: "wx",
            });
          } catch (error) {
            await rm(lockPath, { recursive: true, force: true });
            throw error;
          }
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

          let existing: LockOwner | undefined;
          try {
            existing = JSON.parse(await readFile(ownerPath, "utf8")) as LockOwner;
          } catch {
            // A creator can briefly expose the directory before owner.json.
          }
          let reclaim = false;
          if (
            existing &&
            existing.hostname === hostname() &&
            !processIsAlive(existing.pid)
          ) {
            reclaim = true;
          } else {
            try {
              const age = Date.now() - (await stat(lockPath)).mtimeMs;
              // A live process cannot be probed across hosts. Never steal a
              // well-formed foreign-host lease merely because its mtime is old.
              // Distributed deployments must share a backend with equivalent
              // fencing, rather than an eventually stale network-filesystem lock.
              reclaim = age >= lockStaleMs && !existing;
            } catch {
              // The current holder may have released it between observations.
            }
          }

          if (reclaim) {
            const quarantine = `${lockPath}.${randomUUID()}.reclaim`;
            try {
              await rename(lockPath, quarantine);
              await rm(quarantine, { recursive: true, force: true });
              continue;
            } catch {
              // Another contender won the reclaim race.
            }
          }
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
            JSON.parse(await readFile(statePath, "utf8")) as unknown,
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
            readFile(ownerPath, "utf8"),
          ]);
          const lock = JSON.parse(lockText) as LockOwner;
          if (disk?.generation !== generation || lock.token !== token) {
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
            try {
              const currentOwner = JSON.parse(
                await readFile(ownerPath, "utf8"),
              ) as LockOwner;
              if (currentOwner.token === token) {
                await rm(lockPath, { recursive: true, force: true });
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          },
        };
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
    },
  };
}

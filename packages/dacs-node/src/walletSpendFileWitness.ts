import { lstat } from "node:fs/promises";
import { join } from "node:path";

import {
  createRecordExclusive,
  ensurePrivateDirectory,
  listRecordNames,
  readRecord,
} from "./walletSpendFileRecords.js";
import {
  createDacsWalletSpendContinuitySignerV1,
  verifyDacsWalletSpendContinuityReceiptV1,
  type DacsWalletSpendContinuityHeadV1,
  type DacsWalletSpendContinuityReceiptV1,
  type DacsWalletSpendContinuityTransitionV1,
  type DacsWalletSpendContinuityWitnessV1,
} from "./walletSpendPostgres.js";

const RECORD_VERSION = 1;
const MAXIMUM_RECORD_BYTES = 16 * 1024;
const REVISION_NAME = /^(\d{16})\.json$/;
const REVISION_DIGITS = 16;

/** A continuity witness over one directory, with a read of one committed advance. */
export interface DacsWalletSpendFileWitnessV1 {
  readonly witness: DacsWalletSpendContinuityWitnessV1;
  readonly verificationKey: string;
  /** The committed advance of this exact operation at this revision, or null. Reads the disk. */
  appliedAdvance(input: Readonly<{
    roleId: string; operationId: string; requestHash: string; revision: number;
  }>): Promise<Readonly<DacsWalletSpendContinuityReceiptV1> | null>;
}

interface StoredAdvance {
  recordVersion: typeof RECORD_VERSION;
  roleId: string;
  receipt: Readonly<DacsWalletSpendContinuityReceiptV1>;
}

function revisionName(revision: number): string {
  return `${String(revision).padStart(REVISION_DIGITS, "0")}.json`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

const damaged = (): Error => new Error("wallet-spend-file-witness-record-damaged");
const foreign = (): Error => new Error("wallet-spend-file-witness-record-foreign");

/** Revisions named by the directory, ascending. Any other name is foreign; a gap or a start above zero is damaged. */
function committedRevisions(names: readonly string[]): readonly number[] {
  const revisions = names.map((name) => {
    const match = REVISION_NAME.exec(name);
    if (match === null) throw foreign();
    return Number(match[1]);
  }).sort((left, right) => left - right);
  if (revisions.some((revision, index) => revision !== index)) throw damaged();
  return revisions;
}

/**
 * Opens a continuity witness over one directory with one file per revision.
 * A revision file is created once by hard link and never replaced or removed.
 * A restored old copy of the directory is not detected, and a power loss before
 * the directory sync can lose the newest record, which was not yet answered.
 * Callers must set `mutationIndex` to the new revision.
 *
 * @throws Error `wallet-spend-file-directory-unsafe`, `wallet-spend-file-witness-record-damaged`
 *   or `wallet-spend-file-witness-record-foreign` when the directory or its head cannot be trusted.
 */
export async function openDacsWalletSpendFileWitnessV1(input: Readonly<{
  directory: string;
  authorityId: string;
  epoch: string;
  lineageKey: string;
  seed: Uint8Array;
}>): Promise<Readonly<DacsWalletSpendFileWitnessV1>> {
  const { directory, authorityId, epoch, lineageKey } = input;
  const { verificationKey, sign } = createDacsWalletSpendContinuitySignerV1({ seed: input.seed });
  await ensurePrivateDirectory(directory);

  const namesAnotherLineage = (receipt: Readonly<DacsWalletSpendContinuityReceiptV1>): boolean =>
    [receipt.authorityId, receipt.epoch, receipt.lineageKey].every(
      (name) => typeof name === "string",
    ) && (receipt.authorityId !== authorityId || receipt.epoch !== epoch ||
      receipt.lineageKey !== lineageKey);

  const readAdvance = async (revision: number): Promise<StoredAdvance | undefined> => {
    const value = await readRecord(join(directory, revisionName(revision)), MAXIMUM_RECORD_BYTES)
      .catch((error: unknown) => {
        throw error instanceof Error && error.message === "wallet-spend-file-record-damaged"
          ? damaged() : error;
      });
    if (value === undefined) return undefined;
    if (!isPlainObject(value) || Object.keys(value).length !== 3 ||
        value.recordVersion !== RECORD_VERSION || typeof value.roleId !== "string" ||
        !isPlainObject(value.receipt)) {
      throw damaged();
    }
    const receipt = value.receipt as unknown as Readonly<DacsWalletSpendContinuityReceiptV1>;
    if (namesAnotherLineage(receipt)) throw foreign();
    if (!verifyDacsWalletSpendContinuityReceiptV1(receipt, { authorityId, epoch, verificationKey }) ||
        receipt.kind !== "advance" || receipt.revision !== revision) {
      throw damaged();
    }
    return { recordVersion: RECORD_VERSION, roleId: value.roleId, receipt };
  };

  const requireAdvance = async (revision: number): Promise<StoredAdvance> => {
    const stored = await readAdvance(revision);
    if (stored === undefined) throw damaged();
    return stored;
  };

  const revisions = committedRevisions(await listRecordNames(directory));
  let head: Readonly<DacsWalletSpendContinuityHeadV1> | null = null;
  const newest = revisions[revisions.length - 1];
  if (newest !== undefined) {
    const { receipt } = await requireAdvance(newest);
    head = { revision: receipt.revision, stateHash: receipt.stateHash };
  }
  let foreignWriter = false;

  const requireIdentity = (request: Readonly<{
    authorityId: string; epoch: string; lineageKey: string;
  }>): void => {
    if (request.authorityId !== authorityId || request.epoch !== epoch ||
        request.lineageKey !== lineageKey) {
      throw new Error("wallet-spend-continuity-identity-mismatch");
    }
  };
  const requireSoleWriter = (): void => {
    if (foreignWriter) throw new Error("wallet-spend-file-witness-concurrent-writer");
  };

  let tail: Promise<unknown> = Promise.resolve();
  const inOrder = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.catch(() => undefined);
    return result;
  };

  const sameAdvance = (
    stored: StoredAdvance,
    wanted: Readonly<{ roleId: string; operationId: string; requestHash: string; mutationIndex: number }>,
  ): boolean => stored.roleId === wanted.roleId &&
    stored.receipt.operationId === wanted.operationId &&
    stored.receipt.requestHash === wanted.requestHash &&
    stored.receipt.mutationIndex === wanted.mutationIndex;

  const readCurrent: DacsWalletSpendContinuityWitnessV1["readCurrent"] = (request) =>
    inOrder(async () => {
      requireIdentity(request);
      requireSoleWriter();
      foreignWriter = await exists(join(directory, revisionName(head === null ? 0 : head.revision + 1)));
      requireSoleWriter();
      if (head === null) return null;
      return sign({
        receiptVersion: "1", kind: "current", authorityId, epoch, lineageKey,
        revision: head.revision, stateHash: head.stateHash,
        operationId: request.operationId, requestHash: request.requestHash,
        clientNonce: request.clientNonce, candidateId: null, mutationIndex: null,
        priorRevision: null, priorStateHash: null,
      });
    });

  const startsFromHead = (transition: Readonly<DacsWalletSpendContinuityTransitionV1>): boolean =>
    transition.predecessor === null
      ? head === null && transition.next.revision === 0
      : head !== null && head.revision === transition.predecessor.revision &&
        head.stateHash === transition.predecessor.stateHash &&
        transition.next.revision === head.revision + 1;

  const compareAndSet: DacsWalletSpendContinuityWitnessV1["compareAndSet"] = (transition) =>
    inOrder(async () => {
      requireIdentity(transition);
      requireSoleWriter();
      if (transition.mutationIndex !== transition.next.revision) {
        throw new Error("wallet-spend-file-witness-transition-unsupported");
      }
      if (head !== null && transition.next.revision <= head.revision) {
        const stored = await requireAdvance(transition.next.revision);
        if (stored.receipt.candidateId === transition.candidateId && sameAdvance(stored, transition)) {
          return stored.receipt;
        }
        throw new Error("wallet-spend-continuity-conflict");
      }
      if (!startsFromHead(transition)) throw new Error("wallet-spend-continuity-conflict");
      const receipt = sign({
        receiptVersion: "1", kind: "advance", authorityId, epoch, lineageKey,
        revision: transition.next.revision, stateHash: transition.next.stateHash,
        operationId: transition.operationId, requestHash: transition.requestHash,
        clientNonce: transition.clientNonce, candidateId: transition.candidateId,
        mutationIndex: transition.mutationIndex,
        priorRevision: transition.predecessor?.revision ?? null,
        priorStateHash: transition.predecessor?.stateHash ?? null,
      });
      const record: StoredAdvance = { recordVersion: RECORD_VERSION, roleId: transition.roleId, receipt };
      const created = await createRecordExclusive(
        join(directory, revisionName(transition.next.revision)),
        record,
      );
      if (!created) {
        foreignWriter = true;
        throw new Error("wallet-spend-continuity-conflict");
      }
      head = { ...transition.next };
      return receipt;
    });

  const appliedAdvance: DacsWalletSpendFileWitnessV1["appliedAdvance"] = async (request) => {
    const stored = await readAdvance(request.revision);
    return stored !== undefined &&
      sameAdvance(stored, { ...request, mutationIndex: request.revision })
      ? stored.receipt : null;
  };

  const lookupAdvance: DacsWalletSpendContinuityWitnessV1["lookupAdvance"] = async (request) => {
    requireIdentity(request);
    const stored = await readAdvance(request.mutationIndex);
    return stored !== undefined && stored.receipt.candidateId === request.candidateId &&
      sameAdvance(stored, request)
      ? stored.receipt : null;
  };

  return Object.freeze({
    witness: Object.freeze({ readCurrent, compareAndSet, lookupAdvance }),
    verificationKey,
    appliedAdvance,
  });
}

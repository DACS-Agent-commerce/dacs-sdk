import { randomBytes, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

import type { WalletSpendPolicyV1 } from "@kynesyslabs/dacs";
import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";

import {
  ensurePrivateDirectory,
  listRecordNames,
  readRecord,
  removeRecord,
  replaceRecord,
} from "./walletSpendFileRecords.js";
import { openDacsWalletSpendFileWitnessV1 } from "./walletSpendFileWitness.js";
import {
  createDurableDacsWalletSpendContinuityStateStoreV1,
  dacsWalletSpendLineageKeyV1,
  dacsWalletSpendPolicyHashV1,
  type DacsPostgresWalletSpendStateStoreV1,
  type DacsWalletSpendContinuityAttestationRequestV1,
  type DacsWalletSpendContinuityOperationV1,
  type DacsWalletSpendContinuitySnapshotPortV1,
} from "./walletSpendPostgres.js";

const MAXIMUM_STATE_BYTES = 16 * 1024 * 1024;
const WITNESS_DIRECTORY = "witness";
const STATES_DIRECTORY = "states";

/** The wallet-spend state stores of one authority, kept in one data directory. */
export interface DacsWalletSpendFileAuthorityStoresV1 {
  /** The witness's Ed25519 key, unpadded base64url; clients pin it. */
  readonly verificationKey: string;
  readonly lineageKey: string;
  readonly policyHash: string;
  /**
   * Branded view for one request. With no argument it is an internal view; read
   * the head state through `stateStore().read(lineageKey)`.
   *
   * @throws Error `wallet-spend-file-store-closed` after `close()`.
   */
  stateStore(operation?: Readonly<DacsWalletSpendContinuityOperationV1>): DacsPostgresWalletSpendStateStoreV1;
  /** Later stateStore calls refuse with "wallet-spend-file-store-closed". */
  close(): Promise<void>;
}

async function isPresent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** A fresh identity for a head read that belongs to no request. */
function headReadBinding(purpose: string): DacsWalletSpendContinuityAttestationRequestV1 {
  const operationId = randomUUID();
  const clientNonce = randomBytes(32).toString("hex");
  return {
    operationId,
    clientNonce,
    requestHash: sha256Hex(canonicalize({ purpose, operationId, clientNonce })),
  };
}

/** Keeps each state as `<stateHash>.json` in the directory. */
function stateFilePort(directory: string): DacsWalletSpendContinuitySnapshotPortV1 {
  const pathOf = (stateHash: string) => join(directory, `${stateHash}.json`);
  return {
    async load(stateHash) {
      try {
        return await readRecord(pathOf(stateHash), MAXIMUM_STATE_BYTES);
      } catch (cause) {
        if (cause instanceof Error && cause.message === "wallet-spend-file-record-damaged") {
          throw new Error("wallet-spend-continuity-state-damaged", { cause });
        }
        throw cause;
      }
    },
    persist: (stateHash, state) => replaceRecord(pathOf(stateHash), state),
  };
}

/** Removes every state file except the head's. A removal that fails is left for the next open. */
async function removeSupersededStates(directory: string, headStateHash: string): Promise<void> {
  const head = `${headStateHash}.json`;
  for (const name of await listRecordNames(directory)) {
    if (name !== head) await removeRecord(join(directory, name)).catch(() => undefined);
  }
}

/**
 * Opens the authority's data directory: `witness/` holds the continuity witness,
 * `states/` holds each state named by its hash. A directory with no witness head
 * and no states is provisioned with the empty state. At open, every state file
 * except the head's is removed.
 *
 * @returns The stores; the seed is copied, so the caller may zero its buffer.
 * @throws Error `wallet-spend-file-directory-unsafe`, `wallet-spend-file-witness-record-damaged`
 *   or `wallet-spend-file-witness-record-foreign` when the directory cannot be trusted;
 *   `wallet-spend-file-store-witness-missing` when states exist but the witness has no head;
 *   a `wallet-spend-continuity-*` code when the head state is missing, damaged or for another policy.
 */
export async function openDacsWalletSpendFileAuthorityStoresV1(input: Readonly<{
  directory: string;
  policy: Readonly<WalletSpendPolicyV1>;
  authorityId: string;
  epoch: string;
  seed: Uint8Array;
}>): Promise<Readonly<DacsWalletSpendFileAuthorityStoresV1>> {
  const { directory, policy, authorityId, epoch } = input;
  const lineageKey = dacsWalletSpendLineageKeyV1(policy.wallet, policy.chainId);
  const policyHash = dacsWalletSpendPolicyHashV1(policy);
  const statesDirectory = join(directory, STATES_DIRECTORY);
  const witnessDirectory = join(directory, WITNESS_DIRECTORY);
  await ensurePrivateDirectory(directory);
  await ensurePrivateDirectory(statesDirectory);

  const witnessMissing = () => new Error("wallet-spend-file-store-witness-missing");
  const statesInUse = (await listRecordNames(statesDirectory)).length > 0;
  if (statesInUse && !await isPresent(witnessDirectory)) throw witnessMissing();
  const { witness, verificationKey } = await openDacsWalletSpendFileWitnessV1({
    directory: witnessDirectory, authorityId, epoch, lineageKey, seed: Uint8Array.from(input.seed),
  });
  if (statesInUse && await witness.readCurrent({
    authorityId, epoch, lineageKey, ...headReadBinding("file-store-first-use"),
  }) === null) {
    throw witnessMissing();
  }

  const views = await createDurableDacsWalletSpendContinuityStateStoreV1({
    policy,
    continuity: { authorityId, epoch, verificationKey, witness },
    snapshots: stateFilePort(statesDirectory),
  });
  const head = await views.bind().attestCurrent(headReadBinding("file-store-clean-up"));
  await removeSupersededStates(statesDirectory, head.stateHash);

  let closed = false;
  return Object.freeze({
    verificationKey,
    lineageKey,
    policyHash,
    stateStore(operation?: Readonly<DacsWalletSpendContinuityOperationV1>) {
      if (closed) throw new Error("wallet-spend-file-store-closed");
      return views.bind(operation);
    },
    async close() {
      closed = true;
    },
  });
}

import type { DacsWalletSpendContinuityTransitionV1 } from "../../src/walletSpendPostgres.js";
import { openDacsWalletSpendFileWitnessV1 } from "../../src/walletSpendFileWitness.js";

export const WITNESS_AUTHORITY_ID = "authority-file-witness-test";
export const WITNESS_EPOCH = "epoch-1";
export const WITNESS_LINEAGE = "lineage-file-witness-test";
export const WITNESS_SEED = new Uint8Array(32).fill(7);

function hex64(value: number): string {
  return value.toString(16).padStart(64, "0");
}

function uuid(group: number, value: number): string {
  return `${group.toString(16).padStart(8, "0")}-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

/**
 * The transition that moves the witness to `revision`. Revision 0 has no
 * predecessor; every other revision follows the one before it.
 */
export function transitionTo(
  revision: number,
  overrides: Partial<DacsWalletSpendContinuityTransitionV1> = {},
): DacsWalletSpendContinuityTransitionV1 {
  return {
    authorityId: WITNESS_AUTHORITY_ID,
    epoch: WITNESS_EPOCH,
    lineageKey: WITNESS_LINEAGE,
    predecessor: revision === 0 ? null : { revision: revision - 1, stateHash: hex64(revision - 1) },
    next: { revision, stateHash: hex64(revision) },
    candidateId: uuid(1, revision),
    roleId: "role-a",
    operationId: uuid(2, revision),
    requestHash: hex64(1000 + revision),
    mutationIndex: revision,
    clientNonce: hex64(2000 + revision),
    ...overrides,
  };
}

export function openTestWitness(
  directory: string,
  overrides: Partial<Parameters<typeof openDacsWalletSpendFileWitnessV1>[0]> = {},
): ReturnType<typeof openDacsWalletSpendFileWitnessV1> {
  return openDacsWalletSpendFileWitnessV1({
    directory,
    authorityId: WITNESS_AUTHORITY_ID,
    epoch: WITNESS_EPOCH,
    lineageKey: WITNESS_LINEAGE,
    seed: WITNESS_SEED,
    ...overrides,
  });
}

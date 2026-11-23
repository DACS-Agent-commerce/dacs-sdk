import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WalletSpendPolicyV1, WalletSpendReservationV1 } from "@kynesyslabs/dacs";

import { openDacsWalletSpendFileAuthorityStoresV1 } from "../../src/walletSpendFileAuthorityStores.js";
import type { DacsWalletSpendContinuityReceiptV1 } from "../../src/walletSpendPostgres.js";

export const STORES_AUTHORITY_ID = "authority-file-stores-test";
export const STORES_EPOCH = "epoch-1";
export const STORES_SEED = new Uint8Array(32).fill(11);
export const STORES_WALLET = `0x${"5e".repeat(20)}`;
export const STORES_CHAIN_ID = "chain-a";

export function storesPolicy(overrides: Partial<WalletSpendPolicyV1> = {}): WalletSpendPolicyV1 {
  return {
    policyVersion: "1",
    policyId: "policy-a",
    wallet: STORES_WALLET,
    chainId: STORES_CHAIN_ID,
    maximumConcurrentEffects: 1,
    maximumRetainedReservations: 10,
    assets: [{
      asset: "ASSET",
      maximumPerOrderDebit: "100",
      maximumNetworkFeeDebit: "10",
      minimumReserve: "10",
      rollingWindowMs: 60_000,
      maximumRollingEffects: 10,
      maximumRollingDebit: "500",
      maximumCumulativeDebit: "1000",
      maximumCounterpartyDebit: "500",
    }],
    ...overrides,
  };
}

export function storesReservation(reservationId = "file-one"): WalletSpendReservationV1 {
  return {
    reservationVersion: "1",
    reservationId,
    jobId: `job-${reservationId}`,
    phaseIndex: 2,
    phase: "payment",
    agreementHash: "a".repeat(64),
    settlementBindingHash: "b".repeat(64),
    railId: "rail-one",
    railDefinitionHash: "c".repeat(64),
    wallet: STORES_WALLET,
    chainId: STORES_CHAIN_ID,
    payee: "payee-a",
    finality: { model: "final" },
    debits: [{
      asset: "ASSET",
      purpose: "service",
      expectedAmount: "25",
      maximumAmount: "25",
    }],
  };
}

type OpenInput = Parameters<typeof openDacsWalletSpendFileAuthorityStoresV1>[0];

export function openTestStores(
  directory: string,
  overrides: Partial<OpenInput> = {},
): ReturnType<typeof openDacsWalletSpendFileAuthorityStoresV1> {
  return openDacsWalletSpendFileAuthorityStoresV1({
    directory,
    policy: storesPolicy(),
    authorityId: STORES_AUTHORITY_ID,
    epoch: STORES_EPOCH,
    seed: STORES_SEED,
    ...overrides,
  });
}

/** A new private directory under the system temporary directory; remove it with `removeRoot`. */
export function privateRoot(): string {
  return mkdtempSync(join(tmpdir(), "dacs-file-stores-"));
}

export function removeRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/** Every path under the directory with its file text, so a test can tell whether anything changed. */
export function directoryContents(directory: string): Record<string, string | null> {
  const contents: Record<string, string | null> = {};
  const visit = (relative: string): void => {
    const path = join(directory, relative);
    if (statSync(path).isDirectory()) {
      contents[`${relative}/`] = null;
      for (const name of readdirSync(path).sort()) visit(join(relative, name));
    } else {
      contents[relative] = readFileSync(path, "utf8");
    }
  };
  for (const name of readdirSync(directory).sort()) visit(name);
  return contents;
}

export function stateFileNames(directory: string): string[] {
  return readdirSync(join(directory, "states")).sort();
}

/** The receipts of the witness records, in revision order. */
export function witnessReceipts(directory: string): DacsWalletSpendContinuityReceiptV1[] {
  const witness = join(directory, "witness");
  return readdirSync(witness).sort().map((name) =>
    (JSON.parse(readFileSync(join(witness, name), "utf8")) as {
      receipt: DacsWalletSpendContinuityReceiptV1;
    }).receipt);
}

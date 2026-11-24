import { open } from "node:fs/promises";
import { join } from "node:path";

import {
  canonicalize,
  payDemConfirmedTotalDebitOs,
  settlementKey,
  type WalletSpendAuthorityDependenciesV1,
  type WalletSpendPolicyV1,
  type WalletSpendRecoveryObservationV1,
  type WalletSpendReservationV1,
  type WalletSpendSettlementObservationV1,
  type WalletSpendStateV1,
} from "@kynesyslabs/dacs";

import { createRecordExclusive, ensurePrivateDirectory, readRecord } from "./walletSpendFileRecords.js";
import type { DacsWalletSpendDemosReaderV1 } from "./walletSpendDemosReader.js";

const BARE_HEX_32_RE = /^[0-9a-f]{64}$/;
const FEE_MISMATCH = "wallet-spend-dem-fee-mismatch";
const UNAVAILABLE = "wallet-spend-dem-unavailable";
const MAXIMUM_EVIDENCE_BYTES = 1024;
type DemEvidenceStore = Readonly<{ claim(hash: string, reservationId: string): Promise<boolean> }>;

/** Opens a permanent transfer-claim store; share its directory across wallet instances and policies.
 * @throws If the private directory cannot be opened safely.
 */
export async function openDacsWalletSpendDemEvidenceStoreV1(directory: string): Promise<DemEvidenceStore> {
  await ensurePrivateDirectory(directory);
  return {
    async claim(hash, reservationId) {
      const path = join(directory, `${hash}.json`);
      if (await createRecordExclusive(path, { reservationId })) return true;
      if (canonicalize(await readRecord(path, MAXIMUM_EVIDENCE_BYTES)) !== canonicalize({ reservationId })) return false;
      // A prior writer may have stopped after linking the record but before syncing its directory.
      const handle = await open(directory, "r");
      try { await handle.sync(); } finally { await handle.close(); }
      return true;
    },
  };
}

type DemRecoveryCheck = (
  reservation: Readonly<WalletSpendReservationV1>,
  observation: Readonly<WalletSpendRecoveryObservationV1>,
) => Promise<Readonly<{ accepted: boolean; reasonCode: string }>>;

class DemCheckStop extends Error {
  constructor(readonly reasonCode: string) { super(reasonCode); }
}

const stop = (reasonCode: string): never => { throw new DemCheckStop(reasonCode); };

interface BoundHold { reservationId: string; payee: string; amount: string; feeReserved: boolean }

function bindHold(reservation: Readonly<WalletSpendReservationV1>): BoundHold {
  const [service, fee, ...others] = reservation.debits;
  let expectedId: string | undefined;
  try { expectedId = `pay-dem:${settlementKey(reservation.railId, reservation.jobId, reservation.phaseIndex)}`; }
  catch { expectedId = undefined; }
  if (reservation.phase !== "pay-dem" || reservation.reservationId !== expectedId ||
      reservation.finality.model !== "bft-final" || Object.keys(reservation.finality).length !== 1 ||
      service?.purpose !== "service" || service.asset !== "DEM" || others.length > 0 ||
      (fee !== undefined && (fee.purpose !== "network-fee" || fee.asset !== "DEM" || fee.expectedAmount !== "0")) ||
      !BARE_HEX_32_RE.test(reservation.payee)) {
    return stop("wallet-spend-dem-hold-unbound");
  }
  const { reservationId, payee } = reservation;
  return { reservationId, payee, amount: service.maximumAmount, feeReserved: fee !== undefined };
}

/**
 * Authenticates an executed DEM transfer's wallet, payee, amount and fee, then claims it durably for
 * one hold. Supply the same evidence store across all instances and policies for a wallet.
 * Absence claims are refused: a signed DEM transfer has no expiry.
 * @returns The core authenticator and the same check with its reason code.
 */
export function createDacsWalletSpendTestnetDemRecoveryV1(input: Readonly<{
  policy: Readonly<WalletSpendPolicyV1>;
  reader: Pick<DacsWalletSpendDemosReaderV1, "observeTransfer">;
  readState(): Promise<Readonly<WalletSpendStateV1>>;
  /** Atomically retain one hold per transfer, durably before success; allow retries by that hold. */
  evidenceStore: DemEvidenceStore;
  report(line: Readonly<Record<string, string>>): void;
}>): Readonly<{
  authenticateRecovery: WalletSpendAuthorityDependenciesV1["authenticateRecovery"];
  check: DemRecoveryCheck;
}> {
  const payer = input.policy.wallet.slice(2);
  const reported = new Set<string>();

  function stopForOperator(reasonCode: string, reservationId: string, transactionHash?: string): never {
    const key = JSON.stringify([reservationId, reasonCode]);
    if (!reported.has(key)) {
      reported.add(key);
      input.report({
        status: "hold-needs-operator", reasonCode, reservationId,
        ...(transactionHash === undefined ? {} : { transactionHash }),
      });
    }
    return stop(reasonCode);
  }

  async function chainTotal(hold: BoundHold, hash: string): Promise<string> {
    const seen = await input.reader.observeTransfer(hash).catch((): never => stop(UNAVAILABLE));
    const chain = seen.observation;
    if (chain.status === "unavailable") stop(UNAVAILABLE);
    if (chain.status === "failed" || chain.status === "invalid") stop("wallet-spend-dem-transfer-failed");
    if (chain.status !== "included" || chain.execution !== "executed" || chain.nonce === undefined ||
        !Number.isSafeInteger(chain.nonce)) {
      return stop("wallet-spend-dem-transfer-pending");
    }
    if (chain.txHash !== hash || chain.payer !== payer || chain.payee !== hold.payee || chain.amountOs !== hold.amount) {
      stopForOperator("wallet-spend-dem-transfer-mismatch", hold.reservationId, hash);
    }
    return payDemConfirmedTotalDebitOs(seen.record, {
      txHash: hash, nonce: chain.nonce, blockNumber: chain.blockNumber, payer, payee: hold.payee, amountOs: hold.amount,
    }) ?? stop(FEE_MISMATCH);
  }

  async function checkSettled(
    hold: BoundHold,
    claim: Readonly<WalletSpendSettlementObservationV1>,
    state: Readonly<WalletSpendStateV1>,
  ): Promise<void> {
    const hash = claim.evidenceHash;
    if (!BARE_HEX_32_RE.test(hash)) stop("wallet-spend-dem-evidence-invalid");
    if (state.reservations.some((stored) => stored.reservationId !== hold.reservationId && stored.evidenceHash === hash)) {
      stopForOperator("wallet-spend-dem-evidence-reused", hold.reservationId, hash);
    }
    const fee = (BigInt(await chainTotal(hold, hash)) - BigInt(hold.amount)).toString();
    if (!hold.feeReserved && fee !== "0") stop(FEE_MISMATCH);
    const expected: WalletSpendSettlementObservationV1 = {
      disposition: "settled",
      evidenceHash: hash,
      debits: [
        { asset: "DEM", purpose: "service", amount: hold.amount },
        ...(hold.feeReserved ? [{ asset: "DEM", purpose: "network-fee" as const, amount: fee }] : []),
      ],
    };
    if (canonicalize(expected) !== canonicalize(claim)) stop(FEE_MISMATCH);
    if (!await input.evidenceStore.claim(hash, hold.reservationId)) {
      stopForOperator("wallet-spend-dem-evidence-reused", hold.reservationId, hash);
    }
  }

  const check: DemRecoveryCheck = async (reservation, observation) => {
    try {
      const hold = bindHold(reservation);
      const state = await input.readState();
      if (!state.reservations.some((stored) => stored.reservationId === hold.reservationId)) {
        stop("wallet-spend-dem-hold-missing");
      }
      if (observation.disposition !== "settled") {
        return stopForOperator("wallet-spend-dem-absence-refused", hold.reservationId);
      }
      await checkSettled(hold, observation, state);
      return { accepted: true, reasonCode: "wallet-spend-dem-paid" };
    } catch (error) {
      return { accepted: false, reasonCode: error instanceof DemCheckStop ? error.reasonCode : UNAVAILABLE };
    }
  };

  return Object.freeze({
    authenticateRecovery: async (reservation, observation) => (await check(reservation, observation)).accepted,
    check,
  });
}

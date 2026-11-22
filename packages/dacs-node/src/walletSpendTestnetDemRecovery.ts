import {
  canonicalize,
  payDemConfirmedNonceSlot,
  payDemConfirmedTotalDebitOs,
  settlementKey,
  type WalletSpendAbsenceObservationV1,
  type WalletSpendAuthorityDependenciesV1,
  type WalletSpendPolicyV1,
  type WalletSpendRecoveryObservationV1,
  type WalletSpendReservationV1,
  type WalletSpendSettlementObservationV1,
  type WalletSpendStateV1,
} from "@kynesyslabs/dacs";

import type { DacsWalletSpendDemosReaderV1 } from "./walletSpendDemosReader.js";

/** 64 lowercase hex digits: the spelling of a Demos transaction hash and of a hold's payee. */
const BARE_HEX_32_RE = /^[0-9a-f]{64}$/;
const FEE_MISMATCH = "wallet-spend-dem-fee-mismatch";
const UNAVAILABLE = "wallet-spend-dem-unavailable";
const RELEASE_PAID = "wallet-spend-dem-release-paid";
const RELEASE_UNPROVEN = "wallet-spend-dem-release-unproven";

type DemRecoveryCheck = (
  reservation: Readonly<WalletSpendReservationV1>,
  observation: Readonly<WalletSpendRecoveryObservationV1>,
) => Promise<Readonly<{ accepted: boolean; reasonCode: string }>>;

/** Ends a check with a refusal and its reason code. */
class DemCheckStop extends Error {
  constructor(readonly reasonCode: string) { super(reasonCode); }
}

const stop = (reasonCode: string): never => { throw new DemCheckStop(reasonCode); };

/** A failed node read changes nothing. */
const unavailable = (): never => stop(UNAVAILABLE);

/** The parts of a hold the chain rule checks against. */
interface BoundHold { reservationId: string; payee: string; amount: string; feeReserved: boolean }

/** Step 0: the hold is shaped exactly as the SDK's pay-dem buyer reserves it. */
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
 * Builds the chain rule for the testnet authority's Demos lane. `settled` is accepted only when the
 * chain shows that transfer executed from the policy wallet to the hold's payee for the exact amount,
 * at the hold's planned nonce when it has one, with the fee its confirmed record removed, and only for
 * one hold per transfer. A signed DEM transfer carries no expiry, so neither time nor the buyer's word
 * releases a hold. An absence claim releases one only when the chain shows the wallet's account nonce
 * past the hold's planned nonce, the claimed transfer not on chain, and the wallet's own confirmed
 * transaction at the planned nonce paying the payee nothing. A hold without a planned nonce is never
 * released.
 * @returns `authenticateRecovery` for the core, and `check`, the same decision with its reason code.
 */
export function createDacsWalletSpendTestnetDemRecoveryV1(input: Readonly<{
  policy: Readonly<WalletSpendPolicyV1>;
  reader: Pick<DacsWalletSpendDemosReaderV1,
    "observeTransfer" | "readAccountNonce" | "findTransactionAtNonce" | "readRecord">;
  readState(): Promise<Readonly<WalletSpendStateV1>>;
  report(line: Readonly<Record<string, string>>): void;
}>): Readonly<{
  authenticateRecovery: WalletSpendAuthorityDependenciesV1["authenticateRecovery"];
  check: DemRecoveryCheck;
}> {
  // The observer reports addresses as bare lowercase hex.
  const payer = input.policy.wallet.slice(2);
  const reported = new Set<string>();
  // Transfers accepted in this process, by hash, so two claims cannot both pass before the core commits either.
  const counted = new Map<string, string>();

  /** Refuses with `reasonCode` and prints one `hold-needs-operator` line per hold and code. */
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

  function assertNotCounted(hold: BoundHold, hash: string, state: Readonly<WalletSpendStateV1>): void {
    const countedFor = counted.get(hash);
    if ((countedFor !== undefined && countedFor !== hold.reservationId) || state.reservations.some(
      (stored) => stored.reservationId !== hold.reservationId && stored.evidenceHash === hash,
    )) {
      stopForOperator("wallet-spend-dem-evidence-reused", hold.reservationId, hash);
    }
  }

  /** Steps 3 to 5: the executed transfer on chain, at the planned nonce if any, and the payer's real total debit. */
  async function chainTotal(hold: BoundHold, hash: string, planned: number | undefined): Promise<string> {
    const seen = await input.reader.observeTransfer(hash).catch(unavailable);
    const chain = seen.observation;
    if (chain.status === "unavailable") stop(UNAVAILABLE);
    if (chain.status === "failed" || chain.status === "invalid") stop("wallet-spend-dem-transfer-failed");
    if (chain.status !== "included" || chain.execution !== "executed" || chain.nonce === undefined ||
        !Number.isSafeInteger(chain.nonce)) {
      return stop("wallet-spend-dem-transfer-pending");
    }
    if (chain.txHash !== hash || chain.payer !== payer || chain.payee !== hold.payee || chain.amountOs !== hold.amount ||
        (planned !== undefined && chain.nonce !== planned)) {
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
    planned: number | undefined,
  ): Promise<void> {
    const hash = claim.evidenceHash;
    if (!BARE_HEX_32_RE.test(hash)) stop("wallet-spend-dem-evidence-invalid");
    assertNotCounted(hold, hash, state);
    const fee = (BigInt(await chainTotal(hold, hash, planned)) - BigInt(hold.amount)).toString();
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
    // Re-checked after the chain read: another claim for this transfer may have been accepted meanwhile.
    assertNotCounted(hold, hash, state);
    counted.set(hash, hold.reservationId);
  }

  /**
   * The one release: the account nonce is past the hold's planned nonce, the claimed transfer is not on
   * chain, and the wallet's own confirmed transaction at the planned nonce pays the payee nothing. Then
   * the hold's transfer, which may only carry the planned nonce, can never execute.
   */
  async function checkRelease(hold: BoundHold, claim: Readonly<WalletSpendAbsenceObservationV1>, planned?: number) {
    if (planned === undefined) return stopForOperator("wallet-spend-dem-absence-refused", hold.reservationId);
    if (!BARE_HEX_32_RE.test(claim.evidenceHash)) stop("wallet-spend-dem-evidence-invalid");
    if (await input.reader.readAccountNonce().catch(unavailable) <= planned) {
      stop("wallet-spend-dem-release-nonce-pending");
    }
    const claimed = (await input.reader.observeTransfer(claim.evidenceHash).catch(unavailable)).observation;
    if (claimed.status === "unavailable") stop(UNAVAILABLE);
    if (claimed.status === "included") stopForOperator(RELEASE_PAID, hold.reservationId, claim.evidenceHash);
    if (claimed.status === "pending") stopForOperator(RELEASE_UNPROVEN, hold.reservationId, claim.evidenceHash);
    const slot = await input.reader.findTransactionAtNonce(planned).catch(unavailable) ??
      stopForOperator(RELEASE_UNPROVEN, hold.reservationId);
    const record = await input.reader.readRecord(slot).catch(unavailable);
    const kind = payDemConfirmedNonceSlot(record, { txHash: slot, nonce: planned, payer, payee: hold.payee });
    if (kind !== "other") stopForOperator(kind === null ? RELEASE_UNPROVEN : RELEASE_PAID, hold.reservationId, slot);
  }

  const check: DemRecoveryCheck = async (reservation, observation) => {
    try {
      const hold = bindHold(reservation);
      const state = await input.readState();
      const stored = state.reservations.find((row) => row.reservationId === hold.reservationId) ??
        stop("wallet-spend-dem-hold-missing");
      if (observation.disposition !== "settled") {
        await checkRelease(hold, observation, stored.plannedTransferNonce);
        return { accepted: true, reasonCode: "wallet-spend-dem-released" };
      }
      await checkSettled(hold, observation, state, stored.plannedTransferNonce);
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

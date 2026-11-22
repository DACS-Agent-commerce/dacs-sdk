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

import type { DacsWalletSpendDemosReaderV1 } from "./walletSpendDemosReader.js";

const DEM_ASSET = "DEM";
/** 64 lowercase hex digits: the spelling of a Demos transaction hash and of a hold's payee. */
const BARE_HEX_32_RE = /^[0-9a-f]{64}$/;

const ABSENCE_REFUSED = "wallet-spend-dem-absence-refused";
const EVIDENCE_REUSED = "wallet-spend-dem-evidence-reused";
const FEE_MISMATCH = "wallet-spend-dem-fee-mismatch";
const TRANSFER_MISMATCH = "wallet-spend-dem-transfer-mismatch";
const UNAVAILABLE = "wallet-spend-dem-unavailable";

/** Ends a check with a refusal and its reason code. */
class DemCheckStop extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

const stop = (reasonCode: string): never => {
  throw new DemCheckStop(reasonCode);
};

/** The parts of a hold the chain rule checks against. */
interface BoundHold {
  reservationId: string;
  payee: string;
  amount: string;
  feeReserved: boolean;
}

/** Step 0: the hold is shaped exactly as the SDK's pay-dem buyer reserves it. */
function bindHold(reservation: Readonly<WalletSpendReservationV1>): BoundHold {
  const [service, fee, ...others] = reservation.debits;
  let expectedId: string | undefined;
  try {
    expectedId = `pay-dem:${settlementKey(reservation.railId, reservation.jobId, reservation.phaseIndex)}`;
  } catch {
    expectedId = undefined;
  }
  if (reservation.phase !== "pay-dem" || reservation.reservationId !== expectedId ||
      reservation.finality.model !== "bft-final" || Object.keys(reservation.finality).length !== 1 ||
      service?.purpose !== "service" || service.asset !== DEM_ASSET || others.length > 0 ||
      (fee !== undefined && (fee.purpose !== "network-fee" || fee.asset !== DEM_ASSET || fee.expectedAmount !== "0")) ||
      !BARE_HEX_32_RE.test(reservation.payee)) {
    return stop("wallet-spend-dem-hold-unbound");
  }
  return {
    reservationId: reservation.reservationId,
    payee: reservation.payee,
    amount: service.maximumAmount,
    feeReserved: fee !== undefined,
  };
}

/**
 * Builds the chain rule for the testnet authority's Demos lane. `settled` is
 * accepted only when the chain shows that transfer executed from the policy
 * wallet to the hold's payee for the exact amount, with the fee its confirmed
 * record removed, and only for one hold per transfer. Every absence claim is
 * refused: a signed DEM transfer carries no expiry, so neither time nor the
 * buyer's word can show it will never execute.
 *
 * @returns `authenticateRecovery` for the core, and `check`, which gives the
 *   same decision with its reason code.
 */
export function createDacsWalletSpendTestnetDemRecoveryV1(input: Readonly<{
  policy: Readonly<WalletSpendPolicyV1>;
  reader: Pick<DacsWalletSpendDemosReaderV1, "observeTransfer">;
  readState(): Promise<Readonly<WalletSpendStateV1>>;
  report(line: Readonly<Record<string, string>>): void;
}>): Readonly<{
  authenticateRecovery: WalletSpendAuthorityDependenciesV1["authenticateRecovery"];
  check(
    reservation: Readonly<WalletSpendReservationV1>,
    observation: Readonly<WalletSpendRecoveryObservationV1>,
  ): Promise<Readonly<{ accepted: boolean; reasonCode: string }>>;
}> {
  const { reader } = input;
  // The observer reports addresses as bare lowercase hex.
  const payer = input.policy.wallet.slice(2);
  const reported = new Set<string>();
  // Transfers accepted in this process, by hash, so two claims cannot both pass before the core commits either.
  const counted = new Map<string, string>();

  function reportOnce(reasonCode: string, reservationId: string, transactionHash?: string): void {
    const key = JSON.stringify([reservationId, reasonCode]);
    if (reported.has(key)) return;
    reported.add(key);
    input.report({
      status: "hold-needs-operator",
      reasonCode,
      reservationId,
      ...(transactionHash === undefined ? {} : { transactionHash }),
    });
  }

  function assertNotCounted(hold: BoundHold, hash: string, state: Readonly<WalletSpendStateV1>): void {
    const countedFor = counted.get(hash);
    if ((countedFor !== undefined && countedFor !== hold.reservationId) || state.reservations.some(
      (stored) => stored.reservationId !== hold.reservationId && stored.evidenceHash === hash,
    )) {
      reportOnce(EVIDENCE_REUSED, hold.reservationId, hash);
      stop(EVIDENCE_REUSED);
    }
  }

  /** Steps 3 to 5: the executed transfer on chain, and the payer's real total debit for it. */
  async function chainTotal(hold: BoundHold, hash: string): Promise<string> {
    const seen = await reader.observeTransfer(hash).catch((): never => stop(UNAVAILABLE));
    const chain = seen.observation;
    if (chain.status === "unavailable") stop(UNAVAILABLE);
    if (chain.status === "failed" || chain.status === "invalid") stop("wallet-spend-dem-transfer-failed");
    if (chain.status !== "included" || chain.execution !== "executed" || chain.nonce === undefined ||
        !Number.isSafeInteger(chain.nonce)) {
      return stop("wallet-spend-dem-transfer-pending");
    }
    if (chain.txHash !== hash || chain.payer !== payer || chain.payee !== hold.payee || chain.amountOs !== hold.amount) {
      reportOnce(TRANSFER_MISMATCH, hold.reservationId, hash);
      stop(TRANSFER_MISMATCH);
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
    assertNotCounted(hold, hash, state);
    const fee = (BigInt(await chainTotal(hold, hash)) - BigInt(hold.amount)).toString();
    if (!hold.feeReserved && fee !== "0") stop(FEE_MISMATCH);
    const expected: WalletSpendSettlementObservationV1 = {
      disposition: "settled",
      evidenceHash: hash,
      debits: [
        { asset: DEM_ASSET, purpose: "service", amount: hold.amount },
        ...(hold.feeReserved ? [{ asset: DEM_ASSET, purpose: "network-fee" as const, amount: fee }] : []),
      ],
    };
    if (canonicalize(expected) !== canonicalize(claim)) stop(FEE_MISMATCH);
    // Re-checked after the chain read: another claim for this transfer may have been accepted meanwhile.
    assertNotCounted(hold, hash, state);
    counted.set(hash, hold.reservationId);
  }

  async function check(
    reservation: Readonly<WalletSpendReservationV1>,
    observation: Readonly<WalletSpendRecoveryObservationV1>,
  ): Promise<Readonly<{ accepted: boolean; reasonCode: string }>> {
    try {
      const hold = bindHold(reservation);
      const state = await input.readState();
      if (!state.reservations.some((stored) => stored.reservationId === hold.reservationId)) {
        stop("wallet-spend-dem-hold-missing");
      }
      if (observation.disposition !== "settled") {
        reportOnce(ABSENCE_REFUSED, hold.reservationId);
        return stop(ABSENCE_REFUSED);
      }
      await checkSettled(hold, observation, state);
      return { accepted: true, reasonCode: "wallet-spend-dem-paid" };
    } catch (error) {
      return { accepted: false, reasonCode: error instanceof DemCheckStop ? error.reasonCode : UNAVAILABLE };
    }
  }

  return Object.freeze({
    authenticateRecovery: async (
      reservation: Readonly<WalletSpendReservationV1>,
      observation: Readonly<WalletSpendRecoveryObservationV1>,
    ) => (await check(reservation, observation)).accepted,
    check,
  });
}

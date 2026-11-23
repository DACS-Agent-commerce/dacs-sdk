import {
  EIP3009_AUTHORIZATION_CANCELED_TOPIC,
  ERC20_TRANSFER_TOPIC,
  sha256Hex,
  x402BuyerSettlementKey,
  type WalletSpendAuthorityDependenciesV1,
  type WalletSpendPolicyV1,
  type WalletSpendRecoveryObservationV1,
  type WalletSpendReservationV1,
  type WalletSpendStateV1,
} from "@kynesyslabs/dacs";

import type {
  DacsWalletSpendEvmBlockLinkV1,
  DacsWalletSpendEvmLogV1,
  DacsWalletSpendEvmReaderV1,
  DacsWalletSpendEvmReceiptV1,
} from "./walletSpendEvmReader.js";

type Hex = `0x${string}`;

/** The largest signing window, in seconds, that the reservation hook binds. */
export const DACS_WALLET_SPEND_TESTNET_HOLD_EXPIRY_SECONDS = 86_400;
/**
 * The deepest finality a hold may declare, and the most blocks a check follows
 * below its final head to a receipt. The x402 rail's default depth is 1.
 */
export const DACS_WALLET_SPEND_TESTNET_MAXIMUM_ANCESTRY_DEPTH = 4_096;
/**
 * The testnet service's release depth: a cancel or an expiry counts only at a
 * head this many blocks deep (the latest block is 1), whatever depth the hold
 * declares. On Base Sepolia's 2-second blocks this is about two minutes.
 */
export const DACS_WALLET_SPEND_TESTNET_RELEASE_FINALITY_BLOCKS = 64;

/** What the chain shows for one hold's authorization. */
export type DacsWalletSpendTestnetChainVerdictV1 =
  "paid" | "cancelled" | "expired-unused" | "pending" | "used-unmatched" | "unavailable";

const VERDICT_CODES: Readonly<Record<DacsWalletSpendTestnetChainVerdictV1, string>> = Object.freeze({
  paid: "wallet-spend-chain-paid",
  cancelled: "wallet-spend-chain-cancelled",
  "expired-unused": "wallet-spend-chain-expired-unused",
  pending: "wallet-spend-chain-pending",
  "used-unmatched": "wallet-spend-chain-nonce-used-unmatched",
  unavailable: "wallet-spend-chain-unavailable",
});
const ANCESTRY_UNPROVEN = "wallet-spend-chain-ancestry-unproven";
const HOLD_UNBOUND = "wallet-spend-chain-hold-unbound";
const HOLD_CHANGED = "wallet-spend-chain-hold-changed";
const HOLD_MISSING = "wallet-spend-chain-hold-missing";
const NONCE_CLAIMED = "wallet-spend-chain-nonce-claimed";
const LOWERCASE_ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/** Ends a check early: a step-0 refusal (no verdict) or a verdict with a specific reason. */
class ChainCheckStop extends Error {
  constructor(readonly reasonCode: string, readonly verdict?: DacsWalletSpendTestnetChainVerdictV1) {
    super(reasonCode);
  }
}

const stopWith = (verdict: DacsWalletSpendTestnetChainVerdictV1, reasonCode = VERDICT_CODES[verdict]): never => {
  throw new ChainCheckStop(reasonCode, verdict);
};

/** The stored hold an absence claim is checked against, as the core supplies it. */
type StoredHold = Parameters<WalletSpendAuthorityDependenciesV1["authenticateRecovery"]>[2];

/** The parts of a hold the chain rule checks against. */
interface BoundHold {
  reservationId: string;
  nonce: Hex;
  payeeTopic: string;
  amountWord: string;
  depth: number;
}

const topicOf = (address: string): string => `0x${address.slice(2).padStart(64, "0")}`;

/** The SDK's EIP-3009 nonce for one job phase. */
function nonceFor(jobId: string, phaseIndex: number): Hex {
  return `0x${sha256Hex(`dacs-sb3:v1:${jobId.normalize("NFC")}:${phaseIndex}`)}`;
}

/**
 * Builds the chain rule's verdicts for the testnet wallet-spend authority. A
 * claim is accepted only when the chain shows it at a final head reached from
 * the latest block by parent hash: `settled` needs the exact payment at the
 * depth the hold declares, and `terminal-absent` needs a cancel or an unused
 * nonce at a head at least `releaseFinalityBlocks` deep whose time is past the
 * hold's bound `validBefore`. `not-invoked` is never accepted. A hold that
 * declares a depth above 4,096 is refused, so no hold is bound for it.
 * After the chain walk the rule reads the lane's state once more. A payment is
 * refused while another rail's hold for the same job phase, which shares the
 * nonce, is reserved, effect-pending or settled. The hold itself must be in
 * that state, so of two such holds the later read always sees the other.
 * A release is refused unless the stored hold still has the generation and
 * expiry the core supplied; the core compares both again when it releases.
 *
 * @returns `authenticateRecovery` and `bindAuthorizationValidBefore` for the
 *   core, and `check`, which gives the same decision with its reason code.
 */
export function createDacsWalletSpendTestnetRecoveryV1(input: Readonly<{
  policy: Readonly<WalletSpendPolicyV1>;
  reader: Pick<DacsWalletSpendEvmReaderV1,
    "readBlock" | "readBlockByHash" | "readAuthorizationState" | "readAuthorizationLogs" | "readReceipt">;
  /** The lane's current state; a check that cannot read it is refused. */
  readState(): Promise<Readonly<WalletSpendStateV1>>;
  report(line: Readonly<Record<string, string>>): void;
  /** The fewest blocks deep a cancel or an expiry must be before a hold is released; the hold cannot lower it. */
  releaseFinalityBlocks: number;
}>): Readonly<{
  authenticateRecovery: WalletSpendAuthorityDependenciesV1["authenticateRecovery"];
  bindAuthorizationValidBefore: NonNullable<WalletSpendAuthorityDependenciesV1["bindAuthorizationValidBefore"]>;
  check(
    reservation: Readonly<WalletSpendReservationV1>,
    observation: Readonly<WalletSpendRecoveryObservationV1>,
    hold?: StoredHold,
  ): Promise<Readonly<{ accepted: boolean; reasonCode: string }>>;
}> {
  const { policy, reader } = input;
  const asset = policy.assets[0]?.asset;
  const walletTopic = topicOf(policy.wallet.toLowerCase());
  const reported = new Set<string>();

  /** Reports a hold the rule keeps refusing, once per hold and reason. */
  function reportForOperator(reservationId: string, reasonCode: string, transactionHash?: string): void {
    const key = JSON.stringify([reservationId, reasonCode]);
    if (reported.has(key)) return;
    reported.add(key);
    input.report({
      status: "hold-needs-operator", reasonCode, reservationId,
      ...(transactionHash === undefined ? {} : { transactionHash }),
    });
  }

  /** Step 0: the hold is one x402 service debit on the policy's asset, keyed by its settlement. */
  function bindHold(reservation: Readonly<WalletSpendReservationV1>): BoundHold {
    const [debit, ...others] = reservation.debits;
    const depth = reservation.finality.finalityBlocks;
    let expectedId: string | undefined;
    try {
      expectedId = `x402:${x402BuyerSettlementKey(reservation)}`;
    } catch {
      expectedId = undefined;
    }
    if (debit === undefined || others.length > 0 || debit.purpose !== "service" || debit.asset !== asset ||
        !LOWERCASE_ADDRESS_RE.test(reservation.payee) || reservation.finality.model !== "confirmation-depth" ||
        depth === undefined || !Number.isSafeInteger(depth) || depth < 1 ||
        depth > DACS_WALLET_SPEND_TESTNET_MAXIMUM_ANCESTRY_DEPTH || reservation.reservationId !== expectedId) {
      throw new ChainCheckStop(HOLD_UNBOUND);
    }
    return {
      reservationId: reservation.reservationId,
      nonce: nonceFor(reservation.jobId, reservation.phaseIndex),
      payeeTopic: topicOf(reservation.payee),
      amountWord: `0x${BigInt(debit.maximumAmount).toString(16).padStart(64, "0")}`,
      depth,
    };
  }

  /** The parent walk: follows `parentHash` from a block read by hash down to `toNumber`. */
  async function descend(start: Readonly<DacsWalletSpendEvmBlockLinkV1>, toNumber: number) {
    let block = start;
    while (block.number > toNumber) {
      const parent = await reader.readBlockByHash(block.parentHash);
      if (parent.number !== block.number - 1) stopWith("unavailable", ANCESTRY_UNPROVEN);
      block = parent;
    }
    return block;
  }

  /** Step 1: the head `depth` blocks deep, reached from the latest block by parent hash. */
  async function finalHead(depth: number) {
    const latest = await reader.readBlock("latest");
    if (latest.number + 1 < depth) stopWith("unavailable");
    const top = await reader.readBlockByHash(latest.hash);
    if (top.number !== latest.number || top.timestamp !== latest.timestamp) {
      stopWith("unavailable", ANCESTRY_UNPROVEN);
    }
    return descend(top, latest.number - depth + 1);
  }

  /** Fails the check unless the block at the final head's height is still the final head. */
  async function assertFinalUnchanged(final: Readonly<DacsWalletSpendEvmBlockLinkV1>): Promise<void> {
    if ((await reader.readBlock(final.number)).hash !== final.hash) stopWith("unavailable");
  }

  function matchingTransfers(receipt: Readonly<DacsWalletSpendEvmReceiptV1>, hold: BoundHold): number {
    return receipt.logs.filter((log) => log.address === asset && log.data === hold.amountWord &&
      log.topics.length === 3 && log.topics[0] === ERC20_TRANSFER_TOPIC &&
      log.topics[1] === walletTopic && log.topics[2] === hold.payeeTopic).length;
  }

  /** Step 3a: the nonce is unused at the final head. */
  async function unusedVerdict(
    hold: BoundHold,
    final: Readonly<DacsWalletSpendEvmBlockLinkV1>,
    validBefore: number | undefined,
  ): Promise<DacsWalletSpendTestnetChainVerdictV1> {
    if (validBefore === undefined) {
      return stopWith("pending", "wallet-spend-chain-authorization-valid-before-missing");
    }
    if (final.timestamp <= validBefore) return stopWith("pending", "wallet-spend-chain-authorization-still-valid");
    const logs = await reader.readAuthorizationLogs({ nonce: hold.nonce, toBlock: final.number });
    if (logs.length > 0) stopWith("unavailable");
    await assertFinalUnchanged(final);
    return "expired-unused";
  }

  function receiptHoldsLog(receipt: Readonly<DacsWalletSpendEvmReceiptV1>, log: Readonly<DacsWalletSpendEvmLogV1>) {
    return receipt.logs.some((entry) => entry.logIndex === log.logIndex && entry.address === log.address &&
      entry.data === log.data && entry.topics.join() === log.topics.join());
  }

  /** Step 3b: the nonce is used at the final head; its one receipt must lie on the final chain. */
  async function usedVerdict(
    hold: BoundHold,
    final: Readonly<DacsWalletSpendEvmBlockLinkV1>,
  ): Promise<DacsWalletSpendTestnetChainVerdictV1> {
    const logs = await reader.readAuthorizationLogs({ nonce: hold.nonce, toBlock: final.number });
    const [log] = logs;
    if (log === undefined || logs.length !== 1) return stopWith("unavailable");
    const receipt = await reader.readReceipt(log.transactionHash);
    if (receipt === null || receipt.status !== "success" || receipt.transactionHash !== log.transactionHash ||
        receipt.blockNumber !== log.blockNumber || receipt.blockHash !== log.blockHash ||
        receipt.blockNumber > final.number || !receiptHoldsLog(receipt, log)) {
      return stopWith("unavailable");
    }
    if (final.number - receipt.blockNumber > DACS_WALLET_SPEND_TESTNET_MAXIMUM_ANCESTRY_DEPTH ||
        (await descend(final, receipt.blockNumber)).hash !== receipt.blockHash) {
      stopWith("unavailable", ANCESTRY_UNPROVEN);
    }
    await assertFinalUnchanged(final);
    if (log.topics[0] === EIP3009_AUTHORIZATION_CANCELED_TOPIC) return "cancelled";
    const transfers = matchingTransfers(receipt, hold);
    if (transfers > 1) stopWith("unavailable");
    if (transfers === 1) return "paid";
    reportForOperator(hold.reservationId, VERDICT_CODES["used-unmatched"], receipt.transactionHash);
    return "used-unmatched";
  }

  /**
   * Step 4, after the walk: the hold must be stored. A payment needs no other
   * live or settled hold on the same nonce, unless this hold already settled (a
   * retry, which the core answers from its record), and a release needs the
   * stored hold unchanged.
   * @returns the refusal's reason code, or `undefined` when the state allows it.
   */
  async function stateRefusal(
    reservation: Readonly<WalletSpendReservationV1>,
    disposition: "settled" | "terminal-absent",
    storedHold: StoredHold,
  ): Promise<string | undefined> {
    const state = await input.readState().catch(() => undefined);
    if (state === undefined) return VERDICT_CODES.unavailable;
    const row = state.reservations.find((stored) => stored.reservationId === reservation.reservationId);
    if (row === undefined) return HOLD_MISSING;
    if (disposition === "settled") {
      const nonce = nonceFor(reservation.jobId, reservation.phaseIndex);
      const claimed = row.stage !== "settled" && state.reservations.some((other) =>
        other.reservationId !== reservation.reservationId && other.stage !== "released" &&
        nonceFor(other.reservation.jobId, other.reservation.phaseIndex) === nonce);
      if (!claimed) return undefined;
      reportForOperator(reservation.reservationId, NONCE_CLAIMED);
      return NONCE_CLAIMED;
    }
    const unchanged = row.generation === storedHold?.generation &&
      row.authorizationValidBefore === storedHold.authorizationValidBefore;
    return unchanged ? undefined : HOLD_CHANGED;
  }

  /**
   * Steps 1 to 3: the verdict for one bound hold. A payment is judged at the
   * hold's own depth; a release at least at the service's release depth.
   */
  async function verdict(
    hold: BoundHold,
    disposition: "settled" | "terminal-absent",
    validBefore: number | undefined,
  ): Promise<DacsWalletSpendTestnetChainVerdictV1> {
    const depth = disposition === "settled" ? hold.depth : Math.max(hold.depth, input.releaseFinalityBlocks);
    const final = await finalHead(depth);
    const used = await reader.readAuthorizationState({ nonce: hold.nonce, blockHash: final.hash });
    if (used) return usedVerdict(hold, final);
    return disposition === "settled" ? "pending" : unusedVerdict(hold, final, validBefore);
  }

  async function check(
    reservation: Readonly<WalletSpendReservationV1>,
    observation: Readonly<WalletSpendRecoveryObservationV1>,
    storedHold?: StoredHold,
  ): Promise<Readonly<{ accepted: boolean; reasonCode: string }>> {
    if (observation.disposition === "not-invoked") {
      return { accepted: false, reasonCode: "wallet-spend-chain-absence-kind-refused" };
    }
    if (observation.disposition === "terminal-absent" && storedHold === undefined) {
      return { accepted: false, reasonCode: HOLD_MISSING };
    }
    let found: Readonly<{ verdict: DacsWalletSpendTestnetChainVerdictV1; reasonCode: string }>;
    try {
      const hold = bindHold(reservation);
      const reached = await verdict(hold, observation.disposition, storedHold?.authorizationValidBefore);
      found = { verdict: reached, reasonCode: VERDICT_CODES[reached] };
    } catch (error) {
      if (error instanceof ChainCheckStop && error.verdict === undefined) {
        return { accepted: false, reasonCode: error.reasonCode };
      }
      found = error instanceof ChainCheckStop && error.verdict !== undefined
        ? { verdict: error.verdict, reasonCode: error.reasonCode }
        : { verdict: "unavailable", reasonCode: VERDICT_CODES.unavailable };
    }
    const accepted = observation.disposition === "settled"
      ? found.verdict === "paid"
      : found.verdict === "cancelled" || found.verdict === "expired-unused";
    if (!accepted) return { accepted, reasonCode: found.reasonCode };
    const refusal = await stateRefusal(reservation, observation.disposition, storedHold);
    return refusal === undefined
      ? { accepted, reasonCode: found.reasonCode }
      : { accepted: false, reasonCode: refusal };
  }

  /** Binds a new hold's `validBefore` to the latest block's time plus the buyer's signing window. */
  async function bindAuthorizationValidBefore(request: Readonly<{
    reservation: Readonly<WalletSpendReservationV1>;
    authorizationWindowSeconds?: number;
  }>): Promise<number> {
    const window = request.authorizationWindowSeconds;
    if (window === undefined) throw new Error("wallet-spend-chain-authorization-window-missing");
    if (!Number.isSafeInteger(window) || window < 1 || window > DACS_WALLET_SPEND_TESTNET_HOLD_EXPIRY_SECONDS) {
      throw new Error("wallet-spend-chain-authorization-window-invalid");
    }
    bindHold(request.reservation);
    const latest = await reader.readBlock("latest").catch((cause: unknown) => {
      throw new Error(VERDICT_CODES.unavailable, { cause });
    });
    return latest.timestamp + window;
  }

  return Object.freeze({
    authenticateRecovery: async (
      reservation: Readonly<WalletSpendReservationV1>,
      observation: Readonly<WalletSpendRecoveryObservationV1>,
      hold?: StoredHold,
    ) => (await check(reservation, observation, hold)).accepted,
    bindAuthorizationValidBefore,
    check,
  });
}

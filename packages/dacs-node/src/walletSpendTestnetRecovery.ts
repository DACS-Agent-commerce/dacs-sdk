import {
  EIP3009_AUTHORIZATION_CANCELED_TOPIC,
  ERC20_TRANSFER_TOPIC,
  sha256Hex,
  x402BuyerSettlementKey,
  type WalletSpendAuthorityDependenciesV1,
  type WalletSpendPolicyV1,
  type WalletSpendRecoveryObservationV1,
  type WalletSpendReservationV1,
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
/** The most parent links a check follows below the latest block; the SDK buyer's default depth. */
export const DACS_WALLET_SPEND_TESTNET_MAXIMUM_ANCESTRY_DEPTH = 4_096;

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
 * the latest block by parent hash: `settled` needs the exact payment. Both
 * absence claims, `terminal-absent` and `not-invoked`, need a final cancel or
 * an unused nonce at a head whose time is past the hold's bound `validBefore`:
 * the service cannot see whether the buyer signed, and after that time no
 * signature for the nonce can pay. So a hold whose signed input the buyer
 * never stored is still released once it expires.
 * The core supplies the stored hold with an absence claim and releases only
 * while that hold is still current, so the expiry judged is the one released.
 *
 * @returns `authenticateRecovery` and `bindAuthorizationValidBefore` for the
 *   core, and `check`, which gives the same decision with its reason code.
 */
export function createDacsWalletSpendTestnetRecoveryV1(input: Readonly<{
  policy: Readonly<WalletSpendPolicyV1>;
  reader: Pick<DacsWalletSpendEvmReaderV1,
    "readBlock" | "readBlockByHash" | "readAuthorizationState" | "readAuthorizationLogs" | "readReceipt">;
  report(line: Readonly<Record<string, string>>): void;
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
        reservation.reservationId !== expectedId) {
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
    if (depth - 1 > DACS_WALLET_SPEND_TESTNET_MAXIMUM_ANCESTRY_DEPTH) stopWith("unavailable", ANCESTRY_UNPROVEN);
    const top = await reader.readBlockByHash(latest.hash);
    if (top.number !== latest.number || top.timestamp !== latest.timestamp) {
      stopWith("unavailable", ANCESTRY_UNPROVEN);
    }
    return { latestNumber: latest.number, final: await descend(top, latest.number - depth + 1) };
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
    head: Readonly<{ latestNumber: number; final: Readonly<DacsWalletSpendEvmBlockLinkV1> }>,
  ): Promise<DacsWalletSpendTestnetChainVerdictV1> {
    const { final } = head;
    const logs = await reader.readAuthorizationLogs({ nonce: hold.nonce, toBlock: final.number });
    const [log] = logs;
    if (log === undefined || logs.length !== 1) return stopWith("unavailable");
    const receipt = await reader.readReceipt(log.transactionHash);
    if (receipt === null || receipt.status !== "success" || receipt.transactionHash !== log.transactionHash ||
        receipt.blockNumber !== log.blockNumber || receipt.blockHash !== log.blockHash ||
        receipt.blockNumber > final.number || !receiptHoldsLog(receipt, log)) {
      return stopWith("unavailable");
    }
    if (head.latestNumber - receipt.blockNumber > DACS_WALLET_SPEND_TESTNET_MAXIMUM_ANCESTRY_DEPTH ||
        (await descend(final, receipt.blockNumber)).hash !== receipt.blockHash) {
      stopWith("unavailable", ANCESTRY_UNPROVEN);
    }
    await assertFinalUnchanged(final);
    if (log.topics[0] === EIP3009_AUTHORIZATION_CANCELED_TOPIC) return "cancelled";
    const transfers = matchingTransfers(receipt, hold);
    if (transfers > 1) stopWith("unavailable");
    if (transfers === 1) return "paid";
    if (!reported.has(hold.reservationId)) {
      reported.add(hold.reservationId);
      input.report({
        status: "hold-needs-operator",
        reasonCode: VERDICT_CODES["used-unmatched"],
        reservationId: hold.reservationId,
        transactionHash: receipt.transactionHash,
      });
    }
    return "used-unmatched";
  }

  /** Steps 1 to 3: the verdict for one bound hold. */
  async function verdict(
    hold: BoundHold,
    disposition: "settled" | "absent",
    validBefore: number | undefined,
  ): Promise<DacsWalletSpendTestnetChainVerdictV1> {
    const head = await finalHead(hold.depth);
    const used = await reader.readAuthorizationState({ nonce: hold.nonce, blockHash: head.final.hash });
    if (used) return usedVerdict(hold, head);
    return disposition === "settled" ? "pending" : unusedVerdict(hold, head.final, validBefore);
  }

  async function check(
    reservation: Readonly<WalletSpendReservationV1>,
    observation: Readonly<WalletSpendRecoveryObservationV1>,
    storedHold?: StoredHold,
  ): Promise<Readonly<{ accepted: boolean; reasonCode: string }>> {
    const disposition = observation.disposition === "settled" ? "settled" : "absent";
    if (disposition === "absent" && storedHold === undefined) {
      return { accepted: false, reasonCode: "wallet-spend-chain-hold-missing" };
    }
    let found: Readonly<{ verdict: DacsWalletSpendTestnetChainVerdictV1; reasonCode: string }>;
    try {
      const hold = bindHold(reservation);
      const reached = await verdict(hold, disposition, storedHold?.authorizationValidBefore);
      found = { verdict: reached, reasonCode: VERDICT_CODES[reached] };
    } catch (error) {
      if (error instanceof ChainCheckStop && error.verdict === undefined) {
        return { accepted: false, reasonCode: error.reasonCode };
      }
      found = error instanceof ChainCheckStop && error.verdict !== undefined
        ? { verdict: error.verdict, reasonCode: error.reasonCode }
        : { verdict: "unavailable", reasonCode: VERDICT_CODES.unavailable };
    }
    const accepted = disposition === "settled"
      ? found.verdict === "paid"
      : found.verdict === "cancelled" || found.verdict === "expired-unused";
    return { accepted, reasonCode: found.reasonCode };
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

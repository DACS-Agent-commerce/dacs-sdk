import { CounterpartyError, TransientError } from "../errors.js";

/** keccak256("Transfer(address,address,uint256)"). */
export const ERC20_TRANSFER_EVENT_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const WORD_RE = /^0x[0-9a-fA-F]{64}$/;
const RPC_READ_ATTEMPTS = 6;
const RPC_READ_INITIAL_DELAY_MS = 250;

export interface EvmTransferLog {
  address: string;
  topics: readonly string[];
  data: string;
  transactionHash: string;
  blockNumber: bigint;
  blockHash: string;
  logIndex: number;
  removed?: boolean;
}

export interface EvmTransferReceipt {
  transactionHash: string;
  blockNumber: bigint;
  blockHash: string;
  status: "success" | "reverted";
  logs: readonly EvmTransferLog[];
}

export interface EvmCanonicalBlock {
  number: bigint;
  hash: string;
  parentHash: string;
  timestamp: bigint;
}

/** Minimal read boundary required to authenticate one finalized ERC-20 event. */
export interface EvmTransferFinalityClient {
  getChainId(): Promise<number>;
  waitForTransactionReceipt(input: Readonly<{
    hash: string;
    confirmations: number;
  }>): Promise<unknown>;
  getTransactionReceipt(input: Readonly<{ hash: string }>): Promise<unknown>;
  getBlock(input: Readonly<{ blockNumber: bigint }>): Promise<unknown>;
}

export interface EvmTransferFinalityRequest {
  chainId: number;
  transactionHash: string;
  tokenAddress: string;
  payerAddress: string;
  payeeAddress: string;
  amount: bigint;
  minimumConfirmations: number;
}

export interface EvmTransferFinalityObservation {
  chainId: number;
  /** Canonical lower-case transaction hash without `0x` (DACS-4 wire form). */
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
  confirmations: number;
  /** Unix milliseconds of the Nth confirmation block. */
  finalityObservedAt: number;
}

function fail(reason: string): never {
  throw new CounterpartyError(`evm finality: ${reason}`);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonicalAddress(value: unknown, label: string): string {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) {
    return fail(`${label} is not a canonical EVM address`);
  }
  return value.toLowerCase();
}

function canonicalHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH_RE.test(value)) {
    return fail(`${label} is not a 32-byte hash`);
  }
  return value.toLowerCase();
}

function safeNumber(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return fail(`${label} is outside the safe integer range`);
  }
  return Number(value);
}

function parseBlock(value: unknown, label: string): EvmCanonicalBlock {
  const block = record(value);
  if (!block || typeof block.number !== "bigint" ||
      typeof block.timestamp !== "bigint") {
    return fail(`${label} is malformed`);
  }
  return {
    number: block.number,
    hash: canonicalHash(block.hash, `${label} hash`),
    parentHash: canonicalHash(block.parentHash, `${label} parent hash`),
    timestamp: block.timestamp,
  };
}

function parseReceipt(value: unknown): EvmTransferReceipt {
  const receipt = record(value);
  if (!receipt || (receipt.status !== "success" && receipt.status !== "reverted") ||
      typeof receipt.blockNumber !== "bigint" || !Array.isArray(receipt.logs)) {
    return fail("transaction receipt is malformed");
  }
  const transactionHash = canonicalHash(
    receipt.transactionHash,
    "receipt transaction hash",
  );
  const blockHash = canonicalHash(receipt.blockHash, "receipt block hash");
  const logs = receipt.logs.map((entry, index): EvmTransferLog => {
    const log = record(entry);
    if (!log || !Array.isArray(log.topics) ||
        !log.topics.every((topic) => typeof topic === "string") ||
        typeof log.data !== "string" || typeof log.blockNumber !== "bigint" ||
        !Number.isSafeInteger(log.logIndex) || (log.logIndex as number) < 0 ||
        (log.removed !== undefined && typeof log.removed !== "boolean")) {
      return fail(`receipt log ${index} is malformed`);
    }
    return {
      address: canonicalAddress(log.address, `receipt log ${index} address`),
      topics: log.topics.map((topic) => canonicalHash(topic, `receipt log ${index} topic`)),
      data: log.data,
      transactionHash: canonicalHash(
        log.transactionHash,
        `receipt log ${index} transaction hash`,
      ),
      blockNumber: log.blockNumber,
      blockHash: canonicalHash(log.blockHash, `receipt log ${index} block hash`),
      logIndex: log.logIndex as number,
      ...(log.removed === undefined ? {} : { removed: log.removed }),
    };
  });
  return {
    transactionHash,
    blockNumber: receipt.blockNumber,
    blockHash,
    status: receipt.status,
    logs,
  };
}

function addressTopic(address: string): string {
  return `0x${address.slice(2).padStart(64, "0")}`;
}

/**
 * A successful receipt wait and the immediately following exact read can hit
 * different replicas behind a public RPC endpoint. Retry only thrown transport
 * or not-found observations; malformed or contradictory values are parsed and
 * rejected outside this helper without retry.
 */
async function retryRpcRead<T>(label: string, read: () => Promise<T>): Promise<T> {
  let cause: unknown;
  for (let attempt = 1; attempt <= RPC_READ_ATTEMPTS; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      // Structurally malformed or contradictory authenticated data is not a
      // visibility race. Preserve the fail-closed counterparty verdict.
      if (error instanceof CounterpartyError) throw error;
      cause = error;
      if (attempt < RPC_READ_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, RPC_READ_INITIAL_DELAY_MS * 2 ** (attempt - 1)),
        );
      }
    }
  }
  throw new TransientError(
    `evm finality: ${label} remained unavailable after ${RPC_READ_ATTEMPTS} reads`,
    { cause },
  );
}

/**
 * Wait for and independently re-read the exact finalized ERC-20 Transfer event.
 * Success is impossible when the event is missing or ambiguous.
 */
export async function verifyEvmTransferFinality(
  request: Readonly<EvmTransferFinalityRequest>,
  client: EvmTransferFinalityClient,
): Promise<EvmTransferFinalityObservation> {
  // `Readonly` is a compile-time promise only. Capture every caller-owned
  // scalar before the first callback so a callback that can reach the original
  // object cannot silently weaken the amount or finality contract mid-flight.
  const expectedChainId = request.chainId;
  const requestedTransactionHash = request.transactionHash;
  const requestedTokenAddress = request.tokenAddress;
  const requestedPayerAddress = request.payerAddress;
  const requestedPayeeAddress = request.payeeAddress;
  const expectedAmount = request.amount;
  const minimumConfirmations = request.minimumConfirmations;
  if (!Number.isSafeInteger(expectedChainId) || expectedChainId <= 0) {
    return fail("expected chain id must be a positive safe integer");
  }
  if (!Number.isSafeInteger(minimumConfirmations) ||
      minimumConfirmations <= 0) {
    return fail("minimum confirmations must be a positive safe integer");
  }
  if (expectedAmount <= 0n) return fail("transfer amount must be positive");

  const transactionHash = canonicalHash(requestedTransactionHash, "transaction hash");
  const tokenAddress = canonicalAddress(requestedTokenAddress, "token address");
  const payerAddress = canonicalAddress(requestedPayerAddress, "payer address");
  const payeeAddress = canonicalAddress(requestedPayeeAddress, "payee address");
  if (await client.getChainId() !== expectedChainId) {
    return fail("RPC chain id does not match the negotiated network");
  }

  await client.waitForTransactionReceipt({
    hash: transactionHash,
    confirmations: minimumConfirmations,
  });
  const expectedFrom = addressTopic(payerAddress);
  const expectedTo = addressTopic(payeeAddress);
  const snapshot = await retryRpcRead(
    "canonical receipt/block snapshot",
    async () => {
      // Re-read after the wait so a stale/pre-reorg receipt cannot become
      // evidence. The complete snapshot is retried when independently served
      // receipt and block views have not converged yet.
      const receipt = parseReceipt(await client.getTransactionReceipt({
        hash: transactionHash,
      }));
      if (receipt.status !== "success") return fail("transaction reverted");
      if (receipt.transactionHash !== transactionHash) {
        return fail("receipt transaction hash does not match the submitted transaction");
      }

      const inclusionBlock = parseBlock(
        await client.getBlock({ blockNumber: receipt.blockNumber }),
        "inclusion block",
      );
      if (inclusionBlock.number !== receipt.blockNumber) {
        return fail("RPC returned the wrong inclusion block");
      }
      if (inclusionBlock.hash !== receipt.blockHash) {
        throw new TransientError(
          "evm finality: receipt and canonical block views have not converged",
        );
      }
      let finalityBlock = inclusionBlock;
      for (let offset = 1; offset < minimumConfirmations; offset += 1) {
        const blockNumber = receipt.blockNumber + BigInt(offset);
        const descendant = parseBlock(
          await client.getBlock({ blockNumber }),
          `confirmation block ${offset + 1}`,
        );
        if (descendant.number !== blockNumber) {
          return fail("RPC returned the wrong confirmation block");
        }
        if (descendant.parentHash !== finalityBlock.hash) {
          return fail(
            "confirmation block does not descend from the authenticated inclusion block",
          );
        }
        if (descendant.timestamp < finalityBlock.timestamp) {
          return fail("confirmation block predates its parent");
        }
        finalityBlock = descendant;
      }
      const finalityBlockNumber = finalityBlock.number;

      const candidates = receipt.logs.filter((log) => {
        if (log.removed === true || log.address !== tokenAddress ||
            log.transactionHash !== transactionHash ||
            log.blockNumber !== receipt.blockNumber || log.blockHash !== receipt.blockHash ||
            log.topics.length !== 3 ||
            log.topics[0] !== ERC20_TRANSFER_EVENT_TOPIC ||
            log.topics[1] !== expectedFrom || log.topics[2] !== expectedTo ||
            !WORD_RE.test(log.data)) return false;
        try {
          return BigInt(log.data) === expectedAmount;
        } catch {
          return false;
        }
      });
      if (candidates.length !== 1) {
        return fail(
          candidates.length === 0
            ? "exact ERC-20 Transfer event is missing"
            : "exact ERC-20 Transfer event is ambiguous",
        );
      }

      // Pin the two decisive block identities across the complete receipt/log
      // read. A reorg or replica change restarts the entire snapshot so success
      // can bind only one self-consistent canonical view.
      const inclusionRecheck = parseBlock(
        await client.getBlock({ blockNumber: receipt.blockNumber }),
        "inclusion block recheck",
      );
      const finalityRecheck = parseBlock(
        await client.getBlock({ blockNumber: finalityBlockNumber }),
        "finality block recheck",
      );
      if (inclusionRecheck.hash !== inclusionBlock.hash ||
          inclusionRecheck.parentHash !== inclusionBlock.parentHash ||
          finalityRecheck.hash !== finalityBlock.hash ||
          finalityRecheck.parentHash !== finalityBlock.parentHash ||
          finalityRecheck.timestamp !== finalityBlock.timestamp) {
        throw new TransientError(
          "evm finality: canonical block set changed during finality verification",
        );
      }
      return { receipt, finalityBlock, candidate: candidates[0]! };
    },
  );

  const finalitySeconds = safeNumber(snapshot.finalityBlock.timestamp, "finality timestamp");
  const finalityObservedAt = finalitySeconds * 1_000;
  if (!Number.isSafeInteger(finalityObservedAt)) {
    return fail("finality timestamp is outside the safe millisecond range");
  }
  return {
    chainId: expectedChainId,
    transactionHash: transactionHash.slice(2),
    logIndex: snapshot.candidate.logIndex,
    blockNumber: safeNumber(snapshot.receipt.blockNumber, "receipt block number"),
    confirmations: minimumConfirmations,
    finalityObservedAt,
  };
}

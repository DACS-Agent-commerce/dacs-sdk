import { CounterpartyError } from "../errors.js";

/** keccak256("Transfer(address,address,uint256)"). */
export const ERC20_TRANSFER_EVENT_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const WORD_RE = /^0x[0-9a-fA-F]{64}$/;

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
 * Wait for and independently re-read the exact finalized ERC-20 Transfer event.
 * Success is impossible when the event is missing or ambiguous.
 */
export async function verifyEvmTransferFinality(
  request: Readonly<EvmTransferFinalityRequest>,
  client: EvmTransferFinalityClient,
): Promise<EvmTransferFinalityObservation> {
  if (!Number.isSafeInteger(request.chainId) || request.chainId <= 0) {
    return fail("expected chain id must be a positive safe integer");
  }
  if (!Number.isSafeInteger(request.minimumConfirmations) ||
      request.minimumConfirmations <= 0) {
    return fail("minimum confirmations must be a positive safe integer");
  }
  if (request.amount <= 0n) return fail("transfer amount must be positive");

  const transactionHash = canonicalHash(request.transactionHash, "transaction hash");
  const tokenAddress = canonicalAddress(request.tokenAddress, "token address");
  const payerAddress = canonicalAddress(request.payerAddress, "payer address");
  const payeeAddress = canonicalAddress(request.payeeAddress, "payee address");
  if (await client.getChainId() !== request.chainId) {
    return fail("RPC chain id does not match the negotiated network");
  }

  await client.waitForTransactionReceipt({
    hash: transactionHash,
    confirmations: request.minimumConfirmations,
  });
  // Re-read after the wait so a stale/pre-reorg receipt cannot become evidence.
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
  if (inclusionBlock.number !== receipt.blockNumber ||
      inclusionBlock.hash !== receipt.blockHash) {
    return fail("receipt block is not on the canonical chain");
  }
  const finalityBlockNumber = receipt.blockNumber +
    BigInt(request.minimumConfirmations - 1);
  const finalityBlock = parseBlock(
    await client.getBlock({ blockNumber: finalityBlockNumber }),
    "finality block",
  );
  if (finalityBlock.number !== finalityBlockNumber) {
    return fail("RPC returned the wrong finality block");
  }
  if (finalityBlock.timestamp < inclusionBlock.timestamp) {
    return fail("finality block predates the inclusion block");
  }

  const expectedFrom = addressTopic(payerAddress);
  const expectedTo = addressTopic(payeeAddress);
  const candidates = receipt.logs.filter((log) => {
    if (log.removed === true || log.address !== tokenAddress ||
        log.transactionHash !== transactionHash ||
        log.blockNumber !== receipt.blockNumber || log.blockHash !== receipt.blockHash ||
        log.topics.length !== 3 ||
        log.topics[0] !== ERC20_TRANSFER_EVENT_TOPIC ||
        log.topics[1] !== expectedFrom || log.topics[2] !== expectedTo ||
        !WORD_RE.test(log.data)) return false;
    try {
      return BigInt(log.data) === request.amount;
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

  // Pin the two decisive block identities across the complete receipt/log read.
  // A reorg between the first canonical reads and the event check must not leave
  // a self-inconsistent observation that can be signed as final.
  const inclusionRecheck = parseBlock(
    await client.getBlock({ blockNumber: receipt.blockNumber }),
    "inclusion block recheck",
  );
  const finalityRecheck = parseBlock(
    await client.getBlock({ blockNumber: finalityBlockNumber }),
    "finality block recheck",
  );
  if (inclusionRecheck.hash !== inclusionBlock.hash ||
      finalityRecheck.hash !== finalityBlock.hash ||
      finalityRecheck.timestamp !== finalityBlock.timestamp) {
    return fail("canonical block set changed during finality verification");
  }

  const finalitySeconds = safeNumber(finalityBlock.timestamp, "finality timestamp");
  const finalityObservedAt = finalitySeconds * 1_000;
  if (!Number.isSafeInteger(finalityObservedAt)) {
    return fail("finality timestamp is outside the safe millisecond range");
  }
  return {
    chainId: request.chainId,
    transactionHash: transactionHash.slice(2),
    logIndex: candidates[0]!.logIndex,
    blockNumber: safeNumber(receipt.blockNumber, "receipt block number"),
    confirmations: request.minimumConfirmations,
    finalityObservedAt,
  };
}

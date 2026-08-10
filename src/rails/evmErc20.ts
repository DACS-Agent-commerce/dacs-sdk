import type { SettleRequest, SettleResult } from "../agent/runSessionCore.js";
import { DacsError } from "../errors.js";
import {
  createIdempotencyStore,
  settlementKey,
  type SettlementIdempotencyStore,
  type SettlementReconcile,
} from "./idempotency.js";

/**
 * Direct ERC-20 transfer rail (the second reference rail). Where x402 couples
 * payment to a paywalled fetch, this is the institutional path: the buyer sends
 * the agreed token amount straight to the seller's address and the cosigned
 * agreement + the on-chain transfer ARE the settlement. Amounts are integer
 * base units (matching DACS Price.amount) — never floats.
 *
 * evmErc20SettleCore is pure over an injected transfer client, so it's tested
 * without a chain; createEvmErc20Rail is the thin viem wiring.
 */

export interface EvmErc20SettleParams {
  /** CAIP-2 network, e.g. "eip155:84532". */
  network: string;
  /** ERC-20 token contract (e.g. USDC on the network). */
  tokenAddress: string;
  /** Recipient EVM address (payee). */
  recipientEvm: string;
  /** Amount in integer base units (string). */
  amount: string;
  /** Pinned confirmation depth required by the steward-signed rail descriptor. */
  finalityBlocks: number;
}

export interface EvmFinalityReceipt {
  status: "success" | "reverted" | "reorged" | "not-final" | "wrong-chain";
  chainId: string;
  blockNumber: number;
  blockTimestamp: number;
  blockHash?: string;
  confirmations: number;
}

export interface EvmTransferClient {
  /** The payer's EVM address. */
  address: string;
  /** Submit an ERC-20 transfer; resolves with the tx hash. */
  transfer(args: { token: string; to: string; amount: bigint }): Promise<string>;
  /** Wait for and report the actual pinned confirmation depth. */
  waitForFinality(
    txHash: string,
    finalityBlocks: number,
  ): Promise<EvmFinalityReceipt>;
}

export async function evmErc20SettleCore(
  params: EvmErc20SettleParams,
  client: EvmTransferClient,
): Promise<SettleResult> {
  let amount: bigint;
  try {
    amount = BigInt(params.amount);
  } catch {
    throw new DacsError(`evm-erc20: invalid base-unit amount ${params.amount}`);
  }
  if (amount <= 0n) {
    throw new DacsError(`evm-erc20: amount must be > 0 (got ${params.amount})`);
  }
  if (!Number.isSafeInteger(params.finalityBlocks) || params.finalityBlocks < 1) {
    throw new DacsError("evm-erc20: finalityBlocks must be a positive integer");
  }

  const txHash = await client.transfer({
    token: params.tokenAddress,
    to: params.recipientEvm,
    amount,
  });
  const receipt = await client.waitForFinality(txHash, params.finalityBlocks);
  const ok =
    receipt.status === "success" &&
    receipt.chainId === params.network &&
    receipt.confirmations >= params.finalityBlocks;

  return {
    ok,
    txHash,
    chainId: params.network,
    payer: client.address,
    payee: params.recipientEvm,
    finality: { model: "block-depth", finalityBlocks: params.finalityBlocks },
    blockNumber: receipt.blockNumber,
    txRefKind: "evm-erc20",
    receipt: {
      kind: "evm-erc20",
      blockNumber: receipt.blockNumber,
      blockTimestamp: receipt.blockTimestamp,
      ...(receipt.blockHash !== undefined ? { blockHash: receipt.blockHash } : {}),
      finalityBlocks: params.finalityBlocks,
    },
  };
}

const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** Parse the numeric chain id out of a CAIP-2 `eip155:<id>` string. */
function chainIdFromCaip2(network: string): number {
  const m = network.match(/^eip155:(\d+)$/);
  if (!m) {
    throw new DacsError(
      `evm-erc20: unsupported network ${network} (expected eip155:<id>)`,
    );
  }
  return Number(m[1]);
}

export interface EvmErc20RailConfig {
  /** Buyer EVM private key (`0x…`). */
  evmPrivateKey: string;
  /** JSON-RPC URL for the target chain. */
  rpcUrl: string;
  /** CAIP-2 network, used to derive the chain id. */
  network: string;
  /** Required confirmation depth from the pinned rail descriptor. */
  finalityBlocks: number;
}

export interface EvmErc20Rail {
  readonly address: string;
  settle(params: EvmErc20SettleParams): Promise<SettleResult>;
}

/**
 * Construct a direct-transfer rail from an EVM key + RPC. Lazily imports viem
 * so the SDK core stays importable without the chain deps.
 */
export async function createEvmErc20Rail(
  config: EvmErc20RailConfig,
): Promise<EvmErc20Rail> {
  const viem = await import("viem").catch(() => {
    throw new DacsError(
      "createEvmErc20Rail requires the optional peer viem",
    );
  });
  const accounts = await import("viem/accounts").catch(() => {
    throw new DacsError(
      "createEvmErc20Rail requires the optional peer viem",
    );
  });
  const { createWalletClient, createPublicClient, http, defineChain } = viem;
  const { privateKeyToAccount } = accounts;

  const id = chainIdFromCaip2(config.network);
  if (!Number.isSafeInteger(config.finalityBlocks) || config.finalityBlocks < 1) {
    throw new DacsError("evm-erc20 rail requires finalityBlocks >= 1");
  }
  const chain = defineChain({
    id,
    name: config.network,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
  const account = privateKeyToAccount(config.evmPrivateKey as `0x${string}`);
  const wallet = createWalletClient({ account, chain, transport: http(config.rpcUrl) });
  const pub = createPublicClient({ chain, transport: http(config.rpcUrl) });

  const client: EvmTransferClient = {
    address: account.address,
    transfer: ({ token, to, amount }) =>
      wallet.writeContract({
        address: token as `0x${string}`,
        abi: ERC20_TRANSFER_ABI,
        functionName: "transfer",
        args: [to as `0x${string}`, amount],
      }),
    waitForFinality: async (txHash, finalityBlocks) => {
      const rpcChainId = await pub.getChainId();
      if (rpcChainId !== id) {
        return {
          status: "wrong-chain",
          chainId: config.network,
          blockNumber: 0,
          blockTimestamp: 0,
          confirmations: 0,
        };
      }
      const receipt = await pub.waitForTransactionReceipt({
        hash: txHash as `0x${string}`,
        confirmations: finalityBlocks,
      });
      const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
      return {
        status: block.hash !== receipt.blockHash
            ? "reorged"
            : receipt.status === "success"
              ? "success"
              : "reverted",
        chainId: config.network,
        blockNumber: Number(receipt.blockNumber),
        blockTimestamp: Number(block.timestamp) * 1_000,
        blockHash: receipt.blockHash,
        confirmations: finalityBlocks,
      };
    },
  };

  return {
    address: account.address,
    settle: (params) => evmErc20SettleCore(params, client),
  };
}

/**
 * Bridge an EvmErc20Rail to the runSession `settle` seam. SAFE BY DEFAULT (#43):
 * the transfer is submitted AT MOST ONCE per `(railId, jobId, phaseIndex)` through
 * an idempotency store — a concurrent retry or a resume after a settle→anchor
 * crash reconciles the prior submission instead of sending another transfer. The
 * default store is in-process (closes the concurrency + same-process races); pass
 * `store` backed by a durable {@link SettlementLog} for cross-process crash-safety,
 * and `reconcile` to safely resubmit only after a chain query proves no prior
 * transfer landed (otherwise an unresolved intent fails closed).
 */
export function evmErc20Settle(
  rail: EvmErc20Rail,
  cfg: { tokenAddress: string; network: string; recipientEvm: string; finalityBlocks: number },
  opts: { store?: SettlementIdempotencyStore; reconcile?: SettlementReconcile } = {},
): (req: SettleRequest) => Promise<SettleResult> {
  const store = opts.store ?? createIdempotencyStore();
  return (req) => {
    const submit = () =>
      rail.settle({
        network: cfg.network,
        tokenAddress: cfg.tokenAddress,
        recipientEvm: cfg.recipientEvm,
        amount: req.amount,
        finalityBlocks: cfg.finalityBlocks,
      });
    return store.once(settlementKey(req.rail, req.jobId, req.phaseIndex ?? 0), submit, opts.reconcile);
  };
}

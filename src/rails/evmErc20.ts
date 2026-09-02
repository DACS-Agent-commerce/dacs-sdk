import type { SettleRequest, SettleResult } from "../agent/runSessionCore.js";
import { DacsError } from "../errors.js";
import {
  createIdempotencyStore,
  settlementKey,
  type SettlementIdempotencyStore,
  type SettlementReconcile,
} from "./idempotency.js";
import {
  verifyEvmTransferFinality,
  type EvmTransferFinalityClient,
} from "./evmTransferFinality.js";

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
  /** Signed rail-descriptor confirmation requirement. */
  finalityBlocks: number;
}

export interface EvmTransferClient {
  /** The payer's EVM address. */
  address: string;
  /** Submit an ERC-20 transfer; resolves with the tx hash. */
  transfer(args: { token: string; to: string; amount: bigint }): Promise<string>;
  /** Authenticate the exact finalized Transfer log on the negotiated chain. */
  finalityClient: EvmTransferFinalityClient;
}

export async function evmErc20SettleCore(
  params: EvmErc20SettleParams,
  client: EvmTransferClient,
): Promise<SettleResult> {
  const network = params.network;
  const tokenAddress = params.tokenAddress;
  const recipientEvm = params.recipientEvm;
  const requestedAmount = params.amount;
  const finalityBlocks = params.finalityBlocks;
  const payerAddress = client.address;
  const transfer = client.transfer.bind(client);
  const finalityClient = client.finalityClient;
  let amount: bigint;
  try {
    amount = BigInt(requestedAmount);
  } catch {
    throw new DacsError(`evm-erc20: invalid base-unit amount ${requestedAmount}`);
  }
  if (amount <= 0n) {
    throw new DacsError(`evm-erc20: amount must be > 0 (got ${requestedAmount})`);
  }
  if (!Number.isSafeInteger(finalityBlocks) || finalityBlocks <= 0) {
    throw new DacsError("evm-erc20: finalityBlocks must be a positive safe integer");
  }
  const chainId = chainIdFromCaip2(network);
  if (await finalityClient.getChainId() !== chainId) {
    throw new DacsError(
      "evm-erc20: RPC chain id does not match the negotiated network",
    );
  }

  const txHash = await transfer({
    token: tokenAddress,
    to: recipientEvm,
    amount,
  });
  const observed = await verifyEvmTransferFinality({
    chainId,
    transactionHash: txHash,
    tokenAddress,
    payerAddress,
    payeeAddress: recipientEvm,
    amount,
    minimumConfirmations: finalityBlocks,
  }, finalityClient);

  return {
    ok: true,
    txHash: `0x${observed.transactionHash}`,
    chainId: network,
    payer: payerAddress,
    payee: recipientEvm,
    finality: { model: "block-depth", finalityBlocks },
    finalityObservedAt: observed.finalityObservedAt,
    blockNumber: observed.blockNumber,
    txRef: {
      kind: "evm-event",
      chainId: observed.chainId,
      txHash: observed.transactionHash,
      logIndex: observed.logIndex,
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
  /** Trusted JSON-RPC URL for the independent target-chain read. */
  rpcUrl: string;
  /** CAIP-2 network, used to derive the chain id. */
  network: string;
  /** Signed descriptor confirmation depth; must be positive. */
  finalityBlocks: number;
}

export interface EvmErc20Rail {
  readonly address: string;
  settle(params: Omit<EvmErc20SettleParams, "finalityBlocks">): Promise<SettleResult>;
}

/**
 * Construct a direct-transfer rail from an EVM key + RPC. Lazily imports viem
 * so the SDK core stays importable without the chain deps.
 */
export async function createEvmErc20Rail(
  config: EvmErc20RailConfig,
): Promise<EvmErc20Rail> {
  const evmPrivateKey = config.evmPrivateKey;
  const requestedRpcUrl = config.rpcUrl;
  const network = config.network;
  const finalityBlocks = config.finalityBlocks;
  if (!Number.isSafeInteger(finalityBlocks) || finalityBlocks <= 0) {
    throw new DacsError(
      "createEvmErc20Rail requires a positive finalityBlocks value",
    );
  }
  let rpcUrl: URL;
  try {
    rpcUrl = new URL(requestedRpcUrl);
  } catch {
    throw new DacsError("createEvmErc20Rail requires an absolute RPC URL");
  }
  if (rpcUrl.protocol !== "https:" && rpcUrl.protocol !== "http:") {
    throw new DacsError("createEvmErc20Rail RPC URL must use HTTP(S)");
  }
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

  const id = chainIdFromCaip2(network);
  const chain = defineChain({
    id,
    name: network,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [requestedRpcUrl] } },
  });
  const account = privateKeyToAccount(evmPrivateKey as `0x${string}`);
  const wallet = createWalletClient({ account, chain, transport: http(requestedRpcUrl) });
  const pub = createPublicClient({ chain, transport: http(requestedRpcUrl) });

  const client: EvmTransferClient = {
    address: account.address,
    transfer: ({ token, to, amount }) =>
      wallet.writeContract({
        address: token as `0x${string}`,
        abi: ERC20_TRANSFER_ABI,
        functionName: "transfer",
        args: [to as `0x${string}`, amount],
      }),
    finalityClient: {
      getChainId: () => pub.getChainId(),
      waitForTransactionReceipt: ({ hash, confirmations }) =>
        pub.waitForTransactionReceipt({
          hash: hash as `0x${string}`,
          confirmations,
        }),
      getTransactionReceipt: ({ hash }) => pub.getTransactionReceipt({
        hash: hash as `0x${string}`,
      }),
      getBlock: ({ blockNumber }) => pub.getBlock({ blockNumber }),
    },
  };

  return {
    address: account.address,
    settle: (params) => evmErc20SettleCore({
      ...params,
      finalityBlocks,
    }, client),
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
  cfg: { tokenAddress: string; network: string; recipientEvm: string },
  opts: { store?: SettlementIdempotencyStore; reconcile?: SettlementReconcile } = {},
): (req: SettleRequest) => Promise<SettleResult> {
  const store = opts.store ?? createIdempotencyStore();
  const tokenAddress = cfg.tokenAddress;
  const network = cfg.network;
  const recipientEvm = cfg.recipientEvm;
  const reconcile = opts.reconcile;
  return (req) => {
    const { amount, expectedPayee, jobId, rail: railId } = req;
    const phaseIndex = req.phaseIndex ?? 0;
    if (expectedPayee !== recipientEvm) {
      throw new DacsError(
        `evm-erc20 destination mismatch: request binds ${expectedPayee}, configured rail pays ${recipientEvm}`,
      );
    }
    const submit = () =>
      rail.settle({
        network,
        tokenAddress,
        recipientEvm,
        amount,
      });
    return store.once(
      settlementKey(railId, jobId, phaseIndex),
      submit,
      reconcile,
    );
  };
}

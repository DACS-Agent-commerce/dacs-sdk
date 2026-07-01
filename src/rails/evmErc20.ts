import type { SettleRequest, SettleResult } from "../agent/runSessionCore.js";
import { DacsError } from "../errors.js";

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
}

export interface EvmTransferClient {
  /** The payer's EVM address. */
  address: string;
  /** Submit an ERC-20 transfer; resolves with the tx hash. */
  transfer(args: { token: string; to: string; amount: bigint }): Promise<string>;
  /** Resolve true iff the tx mined successfully. */
  waitForSuccess(txHash: string): Promise<boolean>;
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

  const txHash = await client.transfer({
    token: params.tokenAddress,
    to: params.recipientEvm,
    amount,
  });
  const ok = await client.waitForSuccess(txHash);

  return {
    ok,
    txHash,
    chainId: params.network,
    payer: client.address,
    payee: params.recipientEvm,
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
  const { createWalletClient, createPublicClient, http, defineChain } =
    await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");

  const id = chainIdFromCaip2(config.network);
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
    waitForSuccess: async (txHash) => {
      const receipt = await pub.waitForTransactionReceipt({
        hash: txHash as `0x${string}`,
      });
      return receipt.status === "success";
    },
  };

  return {
    address: account.address,
    settle: (params) => evmErc20SettleCore(params, client),
  };
}

/** Bridge an EvmErc20Rail to the runSession `settle` seam. */
export function evmErc20Settle(
  rail: EvmErc20Rail,
  cfg: { tokenAddress: string; network: string; recipientEvm: string },
): (req: SettleRequest) => Promise<SettleResult> {
  return (req) =>
    rail.settle({
      network: cfg.network,
      tokenAddress: cfg.tokenAddress,
      recipientEvm: cfg.recipientEvm,
      amount: req.amount,
    });
}

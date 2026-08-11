import { types as nodeTypes } from "node:util";

import type { X402BuyerEvmReadClient } from "./x402BuyerEvmAuthorization.js";

export interface ViemX402BuyerEvmReadClientOptions {
  rpcUrl: string;
  chainId: number;
  chainName?: string;
  /** `finalized` is the safe default; `safe`/`latest` require an appropriate confirmation policy. */
  finalityTag?: "finalized" | "safe" | "latest";
}

type RawRpcRequest = (input: Readonly<{
  method: string;
  params?: readonly unknown[];
}>) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    !nodeTypes.isProxy(value);
}

function quantity(value: unknown): number {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) {
    throw new TypeError("invalid EVM quantity");
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError("EVM quantity exceeds safe range");
  return Number(parsed);
}

function mapLog(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("invalid EVM log");
  return {
    address: value.address,
    topics: value.topics,
    data: value.data,
    transactionHash: value.transactionHash,
    blockNumber: quantity(value.blockNumber),
    blockHash: value.blockHash,
    logIndex: quantity(value.logIndex),
    removed: value.removed === undefined ? false : value.removed,
  };
}

/**
 * Lazy viem JSON-RPC wiring for the transport-neutral authorization provider.
 * It uses an EIP-1898 canonical block-hash `eth_call` for authorizationState,
 * so a reorg cannot silently combine state from a different finality head.
 */
export async function createViemX402BuyerEvmReadClient(
  options: Readonly<ViemX402BuyerEvmReadClientOptions>,
): Promise<X402BuyerEvmReadClient> {
  if (!isRecord(options) || typeof options.rpcUrl !== "string" ||
      !Number.isSafeInteger(options.chainId) || options.chainId <= 0 ||
      (options.chainName !== undefined &&
        (typeof options.chainName !== "string" || options.chainName.length === 0)) ||
      (options.finalityTag !== undefined &&
        !["finalized", "safe", "latest"].includes(options.finalityTag))) {
    throw new TypeError("viem x402 buyer EVM reader options are invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(options.rpcUrl);
  } catch {
    throw new TypeError("viem x402 buyer EVM rpcUrl must be an absolute URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError("viem x402 buyer EVM rpcUrl must use HTTP(S)");
  }
  const viem = await import("viem").catch(() => {
    throw new TypeError("createViemX402BuyerEvmReadClient requires the optional peer viem");
  });
  const chain = viem.defineChain({
    id: options.chainId,
    name: options.chainName ?? `eip155:${options.chainId}`,
    nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [options.rpcUrl] } },
  });
  const publicClient = viem.createPublicClient({ chain, transport: viem.http(options.rpcUrl) });
  const request: RawRpcRequest = async (input) =>
    (publicClient.request as unknown as RawRpcRequest).call(publicClient, input);
  const finalityTag = options.finalityTag ?? "finalized";

  return Object.freeze<X402BuyerEvmReadClient>({
    async getFinalityHead() {
      const [rawChainId, rawBlock] = await Promise.all([
        request({ method: "eth_chainId" }),
        request({ method: "eth_getBlockByNumber", params: [finalityTag, false] }),
      ]);
      if (!isRecord(rawBlock)) throw new TypeError("EVM finality block unavailable");
      return {
        chainId: quantity(rawChainId),
        blockNumber: quantity(rawBlock.number),
        blockHash: rawBlock.hash,
        timestamp: quantity(rawBlock.timestamp),
      };
    },

    async getLogs(input) {
      const raw = await request({
        method: "eth_getLogs",
        params: [{
          address: input.address,
          topics: [...input.topics],
          fromBlock: `0x${input.fromBlock.toString(16)}`,
          toBlock: `0x${input.toBlock.toString(16)}`,
        }],
      });
      if (!Array.isArray(raw) || nodeTypes.isProxy(raw)) {
        throw new TypeError("invalid EVM log response");
      }
      return raw.map(mapLog);
    },

    async getTransactionReceipt(transactionHash) {
      const raw = await request({
        method: "eth_getTransactionReceipt",
        params: [transactionHash],
      });
      if (raw === null) return null;
      if (!isRecord(raw) || !Array.isArray(raw.logs) || nodeTypes.isProxy(raw.logs)) {
        throw new TypeError("invalid EVM transaction receipt");
      }
      return {
        transactionHash: raw.transactionHash,
        blockNumber: quantity(raw.blockNumber),
        blockHash: raw.blockHash,
        status: raw.status === "0x1" ? "success" : raw.status === "0x0" ? "reverted" : "invalid",
        logs: raw.logs.map(mapLog),
      };
    },

    async readAuthorizationState(input) {
      const callData = `0xe94a0102${input.payer.slice(2).toLowerCase().padStart(64, "0")}` +
        input.nonce.slice(2).toLowerCase();
      const raw = await request({
        method: "eth_call",
        params: [{ to: input.asset, data: callData }, {
          blockHash: input.blockHash,
          requireCanonical: true,
        }],
      });
      if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw) ||
          (BigInt(raw) !== 0n && BigInt(raw) !== 1n)) {
        throw new TypeError("invalid EIP-3009 authorizationState result");
      }
      return {
        used: BigInt(raw) === 1n,
        blockNumber: input.blockNumber,
        blockHash: input.blockHash,
      };
    },

    async confirmBlockAncestor(input) {
      const raw = await request({
        method: "eth_getBlockByNumber",
        params: [`0x${input.blockNumber.toString(16)}`, false],
      });
      if (!isRecord(raw)) throw new TypeError("EVM ancestor block unavailable");
      const observedNumber = quantity(raw.number);
      const observedHash = typeof raw.hash === "string" ? raw.hash.toLowerCase() : "";
      return {
        canonical: observedNumber === input.blockNumber &&
          observedHash === input.blockHash.toLowerCase() &&
          input.blockNumber <= input.headBlockNumber,
        blockNumber: input.blockNumber,
        blockHash: input.blockHash,
        headBlockNumber: input.headBlockNumber,
        headBlockHash: input.headBlockHash,
      };
    },
  });
}

import { afterEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  provenance: new WeakMap<object, Readonly<Record<string, unknown>>>(),
}));

vi.mock("@kynesyslabs/dacs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kynesyslabs/dacs")>()),
  isAuthenticatedRailDefinition: (value: unknown) =>
    typeof value === "object" && value !== null && dependencies.provenance.has(value),
  getAuthenticatedRailProvenance: (value: unknown) =>
    typeof value === "object" && value !== null
      ? dependencies.provenance.get(value) ?? null : null,
}));

import {
  EIP3009_AUTHORIZATION_USED_TOPIC,
  ERC20_TRANSFER_TOPIC,
} from "@kynesyslabs/dacs";
import { createDacsX402SellerEvmObserverV1 } from "../src/x402SellerEvm.js";

const ASSET = `0x${"44".repeat(20)}`;
const PAYER = `0x${"55".repeat(20)}`;
const PAYEE = `0x${"33".repeat(20)}`;
const NONCE = `0x${"11".repeat(32)}`;
const TX = `0x${"aa".repeat(32)}`;
const BLOCK = `0x${"bb".repeat(32)}`;
const HEAD = `0x${"cc".repeat(32)}`;
const AMOUNT = "1000000";

afterEach(() => vi.restoreAllMocks());

function topic(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function rail() {
  const value = Object.freeze({
    railVersion: 2,
    railId: "x402:test",
    railType: "x402" as const,
    asset: {
      kind: "erc20" as const,
      chainId: 84532,
      contract: ASSET,
      symbol: "USDC",
      decimals: 6,
    },
    network: { kind: "x402-resource" as const,
      resourceBaseUrl: "https://seller.example/dacs/x402" },
    phaseHandler: "pay-x402" as const,
    parameters: { authorization: "eip-3009", finalityBlocks: 2 },
    availability: "live" as const,
    governance: { proposedBy: "did:demos:agent:test", acceptedAt: 1,
      anchoring: "single-signer" as const },
    signature: { algorithm: "ed25519" as const, signer: "did:demos:agent:test",
      value: Buffer.alloc(64, 1).toString("base64url") },
  });
  dependencies.provenance.set(value, Object.freeze({ registryVersion: 1 }));
  return value;
}

function transferLog(index = 1) {
  return {
    address: ASSET,
    topics: [ERC20_TRANSFER_TOPIC, topic(PAYER), topic(PAYEE)],
    data: `0x${BigInt(AMOUNT).toString(16).padStart(64, "0")}`,
    transactionHash: TX,
    blockNumber: "0x60",
    blockHash: BLOCK,
    logIndex: `0x${index.toString(16)}`,
    removed: false,
  };
}

function authorizationLog() {
  return {
    address: ASSET,
    topics: [EIP3009_AUTHORIZATION_USED_TOPIC, topic(PAYER), NONCE],
    data: "0x",
    transactionHash: TX,
    blockNumber: "0x60",
    blockHash: BLOCK,
    logIndex: "0x2",
    removed: false,
  };
}

function rpcFetch(options: Readonly<{
  logs?: unknown[];
  receiptLogs?: unknown[];
  authorizationUsed?: boolean;
  headTimestamp?: number;
}> = {}) {
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as {
      jsonrpc: "2.0";
      id: number;
      method: string;
      params: unknown[];
    };
    let result: unknown;
    if (request.method === "eth_chainId") result = `0x${(84532).toString(16)}`;
    else if (request.method === "eth_getTransactionReceipt") {
      result = {
        transactionHash: TX,
        blockNumber: "0x60",
        blockHash: BLOCK,
        status: "0x1",
        logs: options.receiptLogs ?? [transferLog(), authorizationLog()],
      };
    } else if (request.method === "eth_getBlockByNumber" && request.params[0] === "finalized") {
      result = { number: "0x64", hash: HEAD,
        timestamp: `0x${(options.headTimestamp ?? 1_800_000_100).toString(16)}` };
    } else if (request.method === "eth_getBlockByNumber") {
      result = { number: "0x60", hash: BLOCK, timestamp: "0x6b49d200" };
    } else if (request.method === "eth_getLogs") {
      result = options.logs ?? [authorizationLog()];
    } else if (request.method === "eth_call") {
      result = `0x${(options.authorizationUsed ? 1n : 0n).toString(16).padStart(64, "0")}`;
    } else throw new Error(`unexpected RPC ${request.method}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return fetchImpl;
}

function intent(validBefore = "1800000200") {
  const requirements = {
    scheme: "exact",
    network: "eip155:84532",
    amount: AMOUNT,
    asset: ASSET,
    payTo: PAYEE,
    maxTimeoutSeconds: 120,
    extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
  };
  return {
    intentVersion: "2",
    settlementKey: "settlement:test",
    bindingHash: "f".repeat(64),
    jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
    phaseIndex: 2,
    httpResource: "https://seller.example/dacs/x402/01J8ME0SXKQ4T9V2RC5HJ6WX7D",
    payer: PAYER,
    paymentHeader: "opaque",
    paymentPayload: {
      x402Version: 2,
      accepted: requirements,
      payload: {
        authorization: {
          from: PAYER,
          to: PAYEE,
          value: AMOUNT,
          validAfter: "1799999900",
          validBefore,
          nonce: NONCE,
        },
        signature: `0x${"12".repeat(65)}`,
      },
    },
    paymentRequirements: requirements,
    sessionAuthorization: { scopeVersion: "1" },
  } as never;
}

describe("seller x402 canonical EVM observation", () => {
  it("requires one canonical AuthorizationUsed and one exact ERC-20 transfer", async () => {
    const observer = createDacsX402SellerEvmObserverV1({
      rail: rail() as never,
      rpcUrl: "https://rpc.example",
      authorizationSearchFromBlock: 1,
      fetchImpl: rpcFetch(),
      now: () => 1_800_000_101_000,
    });
    await expect(observer.observeX402Transfer({
      chainId: 84532,
      txHash: TX,
    })).resolves.toEqual({
      status: "finalized",
      chainId: 84532,
      txHash: TX,
      logIndex: 1,
      payer: PAYER,
      payee: PAYEE,
      amountBaseUnits: AMOUNT,
      asset: { contract: ASSET, symbol: "USDC", decimals: 6 },
      confirmations: 5,
      includedAt: 1_800_000_000_000,
      finalityObservedAt: 1_800_000_101_000,
      sessionBinding: { kind: "eip3009", nonce: NONCE },
    });

    const ambiguous = createDacsX402SellerEvmObserverV1({
      rail: rail() as never,
      rpcUrl: "https://rpc.example",
      authorizationSearchFromBlock: 1,
      fetchImpl: rpcFetch({
        receiptLogs: [transferLog(), transferLog(3), authorizationLog()],
      }),
    });
    await expect(ambiguous.observeX402Transfer({
      chainId: 84532,
      txHash: TX,
    })).resolves.toEqual({ status: "failed", reason: "settlement-events-ambiguous" });
  });

  it("recovers a lost facilitator response from finalized chain evidence", async () => {
    const observer = createDacsX402SellerEvmObserverV1({
      rail: rail() as never,
      rpcUrl: "https://rpc.example",
      authorizationSearchFromBlock: 1,
      fetchImpl: rpcFetch(),
      now: () => 1_800_000_101_000,
    });
    const result = await observer.reconcileSettlement(intent());
    expect(result).toMatchObject({
      status: "settled",
      settlement: {
        success: true,
        transaction: TX,
        network: "eip155:84532",
        payer: PAYER,
        amount: AMOUNT,
      },
    });
    if (result.status !== "settled") throw new Error("settlement not recovered");
    const encoded = result.settlement.headers["PAYMENT-RESPONSE"]!;
    expect(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))).toEqual({
      success: true,
      transaction: TX,
      network: "eip155:84532",
      payer: PAYER,
      amount: AMOUNT,
    });
  });

  it("proves terminal failure only after a canonical expired-unused state", async () => {
    const observer = createDacsX402SellerEvmObserverV1({
      rail: rail() as never,
      rpcUrl: "https://rpc.example",
      authorizationSearchFromBlock: 1,
      fetchImpl: rpcFetch({ logs: [], authorizationUsed: false,
        headTimestamp: 1_800_000_300 }),
    });
    await expect(observer.reconcileSettlement(intent("1800000200"))).resolves.toEqual({
      status: "failed",
      reason: "authorization-expired-unused",
    });
  });

  it("fails closed for malformed retained intents and non-TLS remote RPCs", async () => {
    expect(() => createDacsX402SellerEvmObserverV1({
      rail: rail() as never,
      rpcUrl: "http://rpc.example",
      authorizationSearchFromBlock: 1,
      fetchImpl: rpcFetch(),
    })).toThrow("seller EVM RPC URL is invalid");

    const observer = createDacsX402SellerEvmObserverV1({
      rail: rail() as never,
      rpcUrl: "http://127.0.0.1:8545",
      authorizationSearchFromBlock: 1,
      fetchImpl: rpcFetch(),
    });
    await expect(observer.reconcileSettlement({ paymentPayload: null } as never))
      .resolves.toEqual({
        status: "indeterminate",
        reason: "settlement-intent-invalid",
      });
  });

  it("classifies only the exact authenticated rail definition", () => {
    const authenticatedRail = rail();
    const observer = createDacsX402SellerEvmObserverV1({
      rail: authenticatedRail as never,
      rpcUrl: "https://rpc.example",
      authorizationSearchFromBlock: 1,
      fetchImpl: rpcFetch(),
    });
    expect(observer.classifyX402SettlementChain({
      chainId: 84532,
      rail: authenticatedRail as never,
    })).toEqual({ disposition: "l2" });
    expect(observer.classifyX402SettlementChain({
      chainId: 84532,
      rail: { ...authenticatedRail, parameters: { finalityBlocks: 1 } } as never,
    })).toEqual({
      disposition: "unsupported",
      reason: "settlement-chain-unregistered",
    });
  });
});

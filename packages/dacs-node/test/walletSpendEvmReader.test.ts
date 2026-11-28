import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  EIP3009_AUTHORIZATION_CANCELED_TOPIC,
  EIP3009_AUTHORIZATION_USED_TOPIC,
  ERC20_TRANSFER_TOPIC,
  captureWalletSpendPolicyV1,
  createInMemoryWalletSpendStateStore,
  createWalletSpendAuthorityV1,
  type WalletSpendPolicyV1,
  type WalletSpendReservationV1,
} from "@kynesyslabs/dacs";

import { createDacsWalletSpendEvmReaderV1 } from "../src/walletSpendEvmReader.js";

const WALLET = `0x${"5e".repeat(20)}`;
const ASSET = `0x${"03".repeat(20)}`;
const PAYEE = `0x${"7a".repeat(20)}`;
const WALLET_TOPIC = `0x${"0".repeat(24)}${WALLET.slice(2)}`;
const PAYEE_TOPIC = `0x${"0".repeat(24)}${PAYEE.slice(2)}`;
const NONCE = `0x${"4c".repeat(32)}` as const;
const BLOCK_HASH = `0x${"b1".repeat(32)}` as const;
const TRANSACTION = `0x${"7e".repeat(32)}` as const;
const BASE_SEPOLIA = "0x14a34";

const POLICY: Readonly<WalletSpendPolicyV1> = captureWalletSpendPolicyV1({
  policyVersion: "1",
  policyId: "testnet-buyer",
  wallet: WALLET,
  chainId: "eip155:84532",
  maximumConcurrentEffects: 1,
  maximumRetainedReservations: 100,
  assets: [{
    asset: ASSET,
    maximumPerOrderDebit: "5000000",
    maximumNetworkFeeDebit: "0",
    minimumReserve: "0",
    rollingWindowMs: 86_400_000,
    maximumRollingEffects: 10,
    maximumRollingDebit: "10000000",
    maximumCumulativeDebit: "100000000",
    maximumCounterpartyDebit: "25000000",
  }],
});

interface RpcCall {
  id: number;
  method: string;
  params: unknown[];
  jsonrpc: string;
  contentType: string | undefined;
}

type Answer = (call: RpcCall, response: ServerResponse, request: IncomingMessage) => void;

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  })));
});

function reply(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(typeof body === "string" ? body : JSON.stringify(body));
}

function result(call: RpcCall, value: unknown): unknown {
  return { jsonrpc: "2.0", id: call.id, result: value };
}

/** A loopback JSON-RPC stand-in that records every call it receives. */
async function rpcStub(answer: Answer): Promise<{ url: string; calls: RpcCall[] }> {
  const calls: RpcCall[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as Omit<RpcCall, "contentType">;
      const call = { ...parsed, contentType: request.headers["content-type"] };
      calls.push(call);
      answer(call, response, request);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, calls };
}

/** Answers eth_chainId with Base Sepolia and every other method with `answer`. */
function onBaseSepolia(answer: (call: RpcCall) => unknown): Answer {
  return (call, response) => reply(response, result(call, call.method === "eth_chainId"
    ? BASE_SEPOLIA
    : answer(call)));
}

function reader(url: string, timeoutMs?: number) {
  return createDacsWalletSpendEvmReaderV1({
    rpcUrl: url,
    policy: POLICY,
    authorizationSearchFromBlock: 10_000,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

function readerWithFetch(requestFetch: typeof fetch, timeoutMs?: number) {
  return createDacsWalletSpendEvmReaderV1({
    rpcUrl: "https://user:password@example.invalid/private-rpc-key",
    policy: POLICY,
    authorizationSearchFromBlock: 10_000,
    fetch: requestFetch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

function word(value: bigint | number): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

const balanceInput = { wallet: WALLET, chainId: "eip155:84532", asset: ASSET };

function authorizationLog(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: ASSET,
    topics: [EIP3009_AUTHORIZATION_USED_TOPIC, WALLET_TOPIC, NONCE],
    data: "0x",
    blockNumber: "0x2f00",
    blockHash: BLOCK_HASH,
    transactionHash: TRANSACTION,
    logIndex: "0x0",
    removed: false,
    ...overrides,
  };
}

function receiptLog(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: ASSET,
    topics: [],
    data: "0x",
    blockNumber: "0x2f00",
    blockHash: BLOCK_HASH,
    transactionHash: TRANSACTION,
    logIndex: `0x${index.toString(16)}`,
    ...overrides,
  };
}

function receipt(logs: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transactionHash: TRANSACTION,
    blockNumber: "0x2f00",
    blockHash: BLOCK_HASH,
    status: "0x1",
    logs,
    ...overrides,
  };
}

/** Resolves when the client drops a response the stub never finishes. */
function dropped(response: ServerResponse): Promise<void> {
  return new Promise((resolve) => response.once("close", () => resolve()));
}

describe("wallet-spend EVM reader", () => {
  it("reads the ERC-20 balance as a decimal string", async () => {
    const stub = await rpcStub(onBaseSepolia(() => word(1_234_567n)));
    await expect(reader(stub.url).readBalance(balanceInput)).resolves.toBe("1234567");
    expect(stub.calls).toEqual([{
      jsonrpc: "2.0",
      id: expect.any(Number) as number,
      method: "eth_call",
      params: [{ to: ASSET, data: `0x70a08231${"0".repeat(24)}${WALLET.slice(2)}` }, "latest"],
      contentType: "application/json",
    }]);
  });

  it("checks the chain id", async () => {
    const good = await rpcStub((call, response) => reply(response, result(call, "0x14A34")));
    await expect(reader(good.url).assertChain()).resolves.toBeUndefined();
    expect(good.calls.map((call) => call.method)).toEqual(["eth_chainId"]);

    const mainnet = await rpcStub((call, response) => reply(response, result(call, "0x2105")));
    await expect(reader(mainnet.url).assertChain())
      .rejects.toThrow("wallet-spend-testnet-authority-rpc-chain-mismatch");

    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    await new Promise((resolve) => server.close(resolve));
    const error: unknown = await reader(`http://127.0.0.1:${port}/`).assertChain()
      .then(() => undefined, (reason: unknown) => reason);
    expect(error).toMatchObject({ message: "wallet-spend-testnet-authority-rpc-unavailable" });
    expect((error as Error).cause).toMatchObject({ message: "wallet-spend-evm-rpc-unavailable" });
  });

  it("enforces the byte limit, the deadline and no redirects", async () => {
    const oversized = "x".repeat(9 * 1024);
    let declaredEnd: Promise<void> | undefined;
    const declared = await rpcStub((_call, response) => {
      declaredEnd = dropped(response);
      response.writeHead(200, { "content-length": String(oversized.length) });
      response.write(oversized.slice(0, 1024));
    });
    await expect(reader(declared.url).readBalance(balanceInput))
      .rejects.toThrow("wallet-spend-evm-rpc-response-too-large");
    await declaredEnd;

    let streamedEnd: Promise<void> | undefined;
    const streamed = await rpcStub((_call, response) => {
      streamedEnd = dropped(response);
      response.writeHead(200, { "content-type": "application/json" });
      for (let offset = 0; offset < oversized.length; offset += 1024) {
        response.write(oversized.slice(offset, offset + 1024));
      }
    });
    await expect(reader(streamed.url).readBalance(balanceInput))
      .rejects.toThrow("wallet-spend-evm-rpc-response-too-large");
    await streamedEnd;

    const transactions = Array.from({ length: 13_600 }, (_, index) => word(index));
    const busyBlock = await rpcStub(onBaseSepolia(() => ({
      number: "0x2f00", hash: BLOCK_HASH, timestamp: "0x6553f100", transactions,
    })));
    expect(JSON.stringify(transactions).length).toBeGreaterThan(900 * 1024);
    await expect(reader(busyBlock.url).readBlock("latest")).resolves.toMatchObject({ number: 0x2f00 });

    const manyLogs = await rpcStub(onBaseSepolia(() =>
      Array.from({ length: 2_900 }, (_, index) =>
        authorizationLog({ logIndex: `0x${index.toString(16)}`, blockNumber: "0x3800" }))));
    await expect(reader(manyLogs.url).readAuthorizationLogs({ nonce: NONCE, toBlock: 14_500 }))
      .rejects.toThrow("wallet-spend-evm-rpc-response-too-large");

    const silent = await rpcStub(() => undefined);
    const started = performance.now();
    await expect(reader(silent.url, 100).readBalance(balanceInput))
      .rejects.toThrow("wallet-spend-evm-rpc-deadline-exceeded");
    expect(performance.now() - started).toBeLessThan(4_000);

    const redirecting = await rpcStub((_call, response) => {
      response.writeHead(302, { location: "http://127.0.0.1:9/" });
      response.end();
    });
    await expect(reader(redirecting.url).readBalance(balanceInput))
      .rejects.toThrow("wallet-spend-evm-rpc-response-invalid");
    expect(redirecting.calls).toHaveLength(1);
  });

  it("rejects malformed answers", async () => {
    const answers: readonly Answer[] = [
      (call, response) => reply(response, { jsonrpc: "2.0", id: call.id + 1, result: word(1) }),
      (call, response) => reply(response, {
        jsonrpc: "2.0", id: call.id, result: word(1), error: { code: -32000, message: "no" },
      }),
      (call, response) => reply(response, result(call, `0x${"00".repeat(31)}`)),
      (_call, response) => reply(response, "not json"),
      (call, response) => reply(response, { jsonrpc: "1.0", id: call.id, result: word(1) }),
      (call, response) => reply(response, result(call, word(1)), 500),
    ];
    for (const answer of answers) {
      const stub = await rpcStub(answer);
      await expect(reader(stub.url).readBalance(balanceInput))
        .rejects.toThrow("wallet-spend-evm-rpc-response-invalid");
    }
  });

  it("names a refused connection apart from a bad answer", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/secret-path-key`;
    await new Promise((resolve) => server.close(resolve));
    const error: unknown = await reader(url).readBalance(balanceInput)
      .then(() => undefined, (reason: unknown) => reason);
    expect(error).toMatchObject({ message: "wallet-spend-evm-rpc-unavailable" });
    expect(String(error)).not.toContain("secret-path-key");
    expect((error as Error).cause).toBeInstanceOf(Error);
  });

  it("names a response body read failure as unavailable without exposing the RPC URL", async () => {
    const bodyFailure = new TypeError("synthetic stream terminated");
    const requestFetch: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0",'));
      },
      pull(controller) {
        controller.error(bodyFailure);
      },
    }), { status: 200, headers: { "content-type": "application/json" } });

    const error: unknown = await readerWithFetch(requestFetch).readBalance(balanceInput)
      .then(() => undefined, (reason: unknown) => reason);
    expect(error).toMatchObject({ message: "wallet-spend-evm-rpc-unavailable" });
    expect((error as Error).cause).toBe(bodyFailure);
    expect(String(error)).not.toContain("example.invalid");
    expect(String(error)).not.toContain("private-rpc-key");
    expect(String(error)).not.toContain("password");
  });

  it("keeps a response body stall within the RPC deadline", async () => {
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const requestFetch: typeof fetch = async (_input, init) => {
      const response = new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
          controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0",'));
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
      init?.signal?.addEventListener("abort", () => {
        bodyController?.error(new DOMException("synthetic body abort", "AbortError"));
      }, { once: true });
      return response;
    };

    const error: unknown = await readerWithFetch(requestFetch, 20).readBalance(balanceInput)
      .then(() => undefined, (reason: unknown) => reason);
    expect(error).toMatchObject({ message: "wallet-spend-evm-rpc-deadline-exceeded" });
    expect(String(error)).not.toContain("example.invalid");
    expect(String(error)).not.toContain("private-rpc-key");
  });

  it("keeps invalid UTF-8 response bytes classified as an invalid answer", async () => {
    const requestFetch: typeof fetch = async () => new Response(new Uint8Array([0xff]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    await expect(readerWithFetch(requestFetch).readBalance(balanceInput))
      .rejects.toThrow("wallet-spend-evm-rpc-response-invalid");
  });

  it("refuses a balance outside the policy scope without a request", async () => {
    const stub = await rpcStub(onBaseSepolia(() => word(1)));
    const scoped = reader(stub.url);
    for (const input of [
      { ...balanceInput, wallet: `0x${"6f".repeat(20)}` },
      { ...balanceInput, chainId: "eip155:8453" },
      { ...balanceInput, asset: `0x${"04".repeat(20)}` },
    ]) {
      await expect(scoped.readBalance(input)).rejects.toThrow("wallet-spend-evm-rpc-scope-refused");
    }
    expect(stub.calls).toEqual([]);
  });

  it("denies a reserve when the balance read fails", async () => {
    const stub = await rpcStub((_call, response) => reply(response, "unavailable", 503));
    const evm = reader(stub.url);
    const authority = createWalletSpendAuthorityV1(POLICY, {
      store: createInMemoryWalletSpendStateStore(),
      readBalance: (input) => evm.readBalance(input),
      authenticateRecovery: async () => false,
      owner: "testnet-authority",
      leaseDurationMs: 60_000,
      now: () => 1_000,
    });
    const before = await authority.inspect();
    const reservation: WalletSpendReservationV1 = {
      reservationVersion: "1",
      reservationId: "reserve-one",
      jobId: "job-one",
      phaseIndex: 0,
      phase: "payment",
      agreementHash: "a".repeat(64),
      settlementBindingHash: "b".repeat(64),
      railId: "x402-exact-evm",
      railDefinitionHash: "c".repeat(64),
      wallet: WALLET,
      chainId: "eip155:84532",
      payee: PAYEE,
      finality: { model: "final" },
      debits: [{ asset: ASSET, purpose: "service", expectedAmount: "100", maximumAmount: "100" }],
    };
    await expect(authority.reserve(reservation))
      .resolves.toEqual({ status: "denied", reason: "balance-unavailable" });
    const after = await authority.inspect();
    expect(after).toEqual(before);
    expect(after.activeEffects).toBe(0);
    expect(after.retainedReservations).toBe(0);
  });

  it("reads a block by tag or number with the chain id", async () => {
    const stub = await rpcStub(onBaseSepolia((call) => ({
      number: call.params[0] === "latest" ? "0x3000" : call.params[0],
      hash: BLOCK_HASH.toUpperCase().replace("0X", "0x"),
      timestamp: "0x6553F100",
    })));
    await expect(reader(stub.url).readBlock("latest"))
      .resolves.toEqual({ number: 0x3000, hash: BLOCK_HASH, timestamp: 0x6553f100 });
    await expect(reader(stub.url).readBlock(12_000))
      .resolves.toEqual({ number: 12_000, hash: BLOCK_HASH, timestamp: 0x6553f100 });
    expect(stub.calls.map((call) => [call.method, call.params]).sort()).toEqual([
      ["eth_chainId", []],
      ["eth_chainId", []],
      ["eth_getBlockByNumber", ["0x2ee0", false]],
      ["eth_getBlockByNumber", ["latest", false]],
    ]);
    await expect(reader(stub.url).readBlock(-1)).rejects.toThrow("wallet-spend-evm-rpc-request-invalid");
    expect(stub.calls).toHaveLength(4);

    const mainnet = await rpcStub((call, response) => reply(response, result(call,
      call.method === "eth_chainId" ? "0x2105" : { number: "0x1", hash: BLOCK_HASH, timestamp: "0x1" })));
    await expect(reader(mainnet.url).readBlock("latest"))
      .rejects.toThrow("wallet-spend-testnet-authority-rpc-chain-mismatch");

    const missing = await rpcStub(onBaseSepolia(() => null));
    await expect(reader(missing.url).readBlock(12_000))
      .rejects.toThrow("wallet-spend-evm-rpc-response-invalid");
  });

  it("reads a block by hash with its parent hash and the chain id", async () => {
    const parent = `0x${"a7".repeat(32)}` as const;
    const mixedCase = (hash: string) => hash.toUpperCase().replace("0X", "0x");
    const block = (overrides: Record<string, unknown> = {}) => ({
      number: "0x3000", hash: mixedCase(BLOCK_HASH), parentHash: mixedCase(parent), timestamp: "0x6553F100",
      ...overrides,
    });
    const stub = await rpcStub(onBaseSepolia(() => block()));
    await expect(reader(stub.url).readBlockByHash(mixedCase(BLOCK_HASH) as `0x${string}`)).resolves.toEqual({
      number: 0x3000, hash: BLOCK_HASH, parentHash: parent, timestamp: 0x6553f100,
    });
    expect(stub.calls.map((call) => [call.method, call.params]).sort()).toEqual([
      ["eth_chainId", []],
      ["eth_getBlockByHash", [BLOCK_HASH, false]],
    ]);

    for (const answer of [
      null,
      block({ hash: `0x${"b2".repeat(32)}` }),
      block({ parentHash: undefined }),
      block({ parentHash: `0x${"a7".repeat(31)}` }),
    ]) {
      const invalid = await rpcStub(onBaseSepolia(() => answer));
      await expect(reader(invalid.url).readBlockByHash(BLOCK_HASH))
        .rejects.toThrow("wallet-spend-evm-rpc-response-invalid");
    }

    const mainnet = await rpcStub((call, response) => reply(response, result(call,
      call.method === "eth_chainId" ? "0x2105" : block())));
    await expect(reader(mainnet.url).readBlockByHash(BLOCK_HASH))
      .rejects.toThrow("wallet-spend-testnet-authority-rpc-chain-mismatch");

    const oversized = await rpcStub(onBaseSepolia(() => block({ padding: "x".repeat(1_100 * 1024) })));
    await expect(reader(oversized.url).readBlockByHash(BLOCK_HASH))
      .rejects.toThrow("wallet-spend-evm-rpc-response-too-large");

    const unsent = await rpcStub(onBaseSepolia(() => block()));
    await expect(reader(unsent.url).readBlockByHash(`0x${"b1".repeat(31)}`))
      .rejects.toThrow("wallet-spend-evm-rpc-request-invalid");
    expect(unsent.calls).toEqual([]);
  });

  it("reads authorization state pinned to a canonical block hash", async () => {
    let state: unknown = word(1);
    const stub = await rpcStub(onBaseSepolia(() => state));
    const pinned = reader(stub.url);
    await expect(pinned.readAuthorizationState({ nonce: NONCE, blockHash: BLOCK_HASH }))
      .resolves.toBe(true);
    expect(stub.calls[0]?.method).toBe("eth_call");
    expect(stub.calls[0]?.params).toEqual([
      { to: ASSET, data: `0xe94a0102${"0".repeat(24)}${WALLET.slice(2)}${NONCE.slice(2)}` },
      { blockHash: BLOCK_HASH, requireCanonical: true },
    ]);
    state = word(0);
    await expect(pinned.readAuthorizationState({ nonce: NONCE, blockHash: BLOCK_HASH }))
      .resolves.toBe(false);
    for (const bad of [word(2), `0x${"00".repeat(31)}`]) {
      state = bad;
      await expect(pinned.readAuthorizationState({ nonce: NONCE, blockHash: BLOCK_HASH }))
        .rejects.toThrow("wallet-spend-evm-rpc-response-invalid");
    }
  });

  it("searches authorization logs backward in pages down to the floor", async () => {
    const pages: [number, number][] = [];
    let found: Record<string, unknown>[] = [];
    const stub = await rpcStub(onBaseSepolia((call) => {
      const filter = call.params[0] as { fromBlock: string; toBlock: string };
      const page: [number, number] = [Number(filter.fromBlock), Number(filter.toBlock)];
      pages.push(page);
      return page[0] === 10_501 ? found : [];
    }));
    const search = reader(stub.url);

    await expect(search.readAuthorizationLogs({ nonce: NONCE, toBlock: 14_500 })).resolves.toEqual([]);
    expect(pages).toEqual([[12_501, 14_500], [10_501, 12_500], [10_000, 10_500]]);
    expect(stub.calls[0]?.params).toEqual([{
      address: ASSET,
      topics: [
        [EIP3009_AUTHORIZATION_USED_TOPIC, EIP3009_AUTHORIZATION_CANCELED_TOPIC],
        WALLET_TOPIC,
        NONCE,
      ],
      fromBlock: "0x30d5",
      toBlock: "0x38a4",
    }]);

    pages.length = 0;
    found = [authorizationLog({
      topics: [EIP3009_AUTHORIZATION_CANCELED_TOPIC, WALLET_TOPIC, NONCE],
      blockNumber: "0x2ee0",
    })];
    await expect(search.readAuthorizationLogs({ nonce: NONCE, toBlock: 14_500 })).resolves.toEqual([{
      address: ASSET,
      topics: [EIP3009_AUTHORIZATION_CANCELED_TOPIC, WALLET_TOPIC, NONCE],
      data: "0x",
      blockNumber: 12_000,
      blockHash: BLOCK_HASH,
      transactionHash: TRANSACTION,
      logIndex: 0,
    }]);
    expect(pages).toEqual([[12_501, 14_500], [10_501, 12_500]]);

    const callsBefore = stub.calls.length;
    await expect(search.readAuthorizationLogs({ nonce: NONCE, toBlock: 9_999 }))
      .rejects.toThrow("wallet-spend-evm-rpc-request-invalid");
    expect(stub.calls).toHaveLength(callsBefore);

    for (const bad of [
      { topics: [EIP3009_AUTHORIZATION_USED_TOPIC, WALLET_TOPIC, `0x${"4d".repeat(32)}`] },
      { topics: [EIP3009_AUTHORIZATION_USED_TOPIC, PAYEE_TOPIC, NONCE] },
      { address: `0x${"04".repeat(20)}` },
      { blockNumber: "0x30d5" },
      { removed: true },
      { topics: [ERC20_TRANSFER_TOPIC, WALLET_TOPIC, PAYEE_TOPIC], data: word(100) },
    ]) {
      found = [authorizationLog({ blockNumber: "0x2ee0", ...bad })];
      const answer = await search.readAuthorizationLogs({ nonce: NONCE, toBlock: 12_500 })
        .then(() => "accepted", (error: unknown) => (error as Error).message);
      expect(answer, JSON.stringify(bad)).toBe("wallet-spend-evm-rpc-response-invalid");
    }
  });

  it("parses a payment receipt with its authorization and transfer logs", async () => {
    const mixed = (value: string): string => `0x${value.slice(2).toUpperCase()}`;
    const amount = word(2_500_000);
    const logs = [
      receiptLog(0, { topics: [EIP3009_AUTHORIZATION_USED_TOPIC, WALLET_TOPIC, NONCE].map(mixed) }),
      receiptLog(1, {
        topics: [ERC20_TRANSFER_TOPIC, WALLET_TOPIC, PAYEE_TOPIC].map(mixed),
        data: mixed(amount),
      }),
      receiptLog(2, {
        address: mixed(`0x${"99".repeat(20)}`), topics: [mixed(`0x${"ee".repeat(32)}`)],
        data: mixed(`0x${"ab".repeat(64)}`),
      }),
      receiptLog(3, { address: `0x${"98".repeat(20)}`, blockHash: mixed(BLOCK_HASH) }),
    ];
    let answer: unknown = receipt(logs, { transactionHash: mixed(TRANSACTION) });
    const stub = await rpcStub(onBaseSepolia(() => answer));
    const parsed = await reader(stub.url).readReceipt(TRANSACTION);

    expect(stub.calls[0]).toMatchObject({ method: "eth_getTransactionReceipt", params: [TRANSACTION] });
    expect(parsed).toEqual({
      transactionHash: TRANSACTION,
      blockNumber: 0x2f00,
      blockHash: BLOCK_HASH,
      status: "success",
      logs: logs.map((log, logIndex) => ({
        address: String(log.address).toLowerCase(),
        topics: (log.topics as string[]).map((topic) => topic.toLowerCase()),
        data: String(log.data).toLowerCase(),
        blockNumber: 0x2f00,
        blockHash: BLOCK_HASH,
        transactionHash: TRANSACTION,
        logIndex,
      })),
    });
    expect(parsed?.logs[1]?.data).toBe(amount);

    answer = receipt(logs, { status: "0x0" });
    await expect(reader(stub.url).readReceipt(TRANSACTION)).resolves.toMatchObject({ status: "reverted" });
    answer = null;
    await expect(reader(stub.url).readReceipt(TRANSACTION)).resolves.toBeNull();
  });

  it("rejects a receipt outside the receipt shape", async () => {
    const tooMany = Array.from({ length: 1_025 }, (_, index) => receiptLog(index));
    const cases: readonly Record<string, unknown>[] = [
      receipt([], { status: "0x2" }),
      receipt({}),
      receipt(tooMany),
      receipt([receiptLog(0, { topics: Array.from({ length: 5 }, () => NONCE) })]),
      receipt([receiptLog(0, { topics: [`0x${"aa".repeat(31)}`] })]),
      receipt([receiptLog(0, { data: "0xabc" })]),
      receipt([receiptLog(0, { address: `0x${"03".repeat(19)}` })]),
      receipt([receiptLog(0, { blockHash: `0x${"b2".repeat(32)}` })]),
      receipt([receiptLog(0, { blockNumber: "0x2f01" })]),
      receipt([receiptLog(0, { transactionHash: `0x${"7f".repeat(32)}` })]),
      receipt([receiptLog(0), receiptLog(1, { logIndex: "0x0" })]),
      receipt([receiptLog(0, { removed: true })]),
      receipt([], { transactionHash: `0x${"7f".repeat(32)}` }),
    ];
    let answer: unknown;
    const stub = await rpcStub(onBaseSepolia(() => answer));
    for (const [index, entry] of cases.entries()) {
      answer = entry;
      const outcome = await reader(stub.url).readReceipt(TRANSACTION)
        .then(() => "accepted", (error: unknown) => (error as Error).message);
      expect(outcome, `case ${index}`).toBe("wallet-spend-evm-rpc-response-invalid");
    }
  });
});

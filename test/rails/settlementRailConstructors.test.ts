// The production rail constructors (createEvmErc20Rail, createX402Rail) with
// only viem's wallet/RPC boundary replaced: the effect fence is checked beside
// the broadcast, finality uses the configured depth, the RPC chain is checked
// before any paid request, and bad configuration is refused at construction.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createEvmErc20Rail } from "../../src/rails/evmErc20.js";
import { createX402Rail } from "../../src/rails/x402.js";

const peers = vi.hoisted(() => ({
  writeContract: vi.fn(),
  chainId: 84532,
  waitForTransactionReceipt: vi.fn(),
  signTypedData: vi.fn(async () => `0x${"44".repeat(65)}`),
}));
const NETWORK = "eip155:84532";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAYEE = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const TX = `0x${"a".repeat(64)}`;
const BLOCK = `0x${"b".repeat(64)}`;
const NEXT = `0x${"c".repeat(64)}`;
const topic = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
const receipt = {
  transactionHash: TX, blockNumber: 100n, blockHash: BLOCK, status: "success",
  logs: [{
    address: USDC,
    topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", topic(PAYER), topic(PAYEE)],
    data: `0x${1000000n.toString(16).padStart(64, "0")}`,
    transactionHash: TX, blockNumber: 100n, blockHash: BLOCK, logIndex: 7, removed: false,
  }],
};

vi.mock("viem/accounts", () => ({
  privateKeyToAccount: vi.fn(() => ({ address: PAYER, signTypedData: peers.signTypedData })),
}));
vi.mock("viem", async (importOriginal) => ({
  ...await importOriginal<typeof import("viem")>(),
  createWalletClient: vi.fn(() => ({ writeContract: peers.writeContract })),
  createPublicClient: vi.fn(() => ({
    getChainId: async () => peers.chainId,
    waitForTransactionReceipt: peers.waitForTransactionReceipt,
    getTransactionReceipt: async () => receipt,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
      number: blockNumber, hash: blockNumber === 100n ? BLOCK : NEXT,
      parentHash: blockNumber === 100n ? `0x${"d".repeat(64)}` : BLOCK,
      timestamp: blockNumber === 100n ? 1_700_000_000n : 1_700_000_011n,
    }),
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  peers.chainId = 84532;
  peers.writeContract.mockImplementation(async () => TX);
  peers.waitForTransactionReceipt.mockImplementation(async () => receipt);
});
afterEach(() => vi.restoreAllMocks());

const evmConfig = { evmPrivateKey: `0x${"12".repeat(32)}`, rpcUrl: "https://rpc.example", network: NETWORK, finalityBlocks: 2 };
const evmParams = { network: NETWORK, tokenAddress: USDC, recipientEvm: PAYEE, amount: "1000000" };

describe("createEvmErc20Rail (the production direct ERC-20 rail)", () => {
  test("a superseded generation never broadcasts", async () => {
    const rail = await createEvmErc20Rail(evmConfig);
    const assertCurrent = vi.fn(async () => { throw new Error("superseded generation"); });
    await expect(rail.settle(evmParams, { assertCurrent } as never)).rejects.toThrow(/superseded generation/);
    expect(assertCurrent).toHaveBeenCalledOnce();
    expect(peers.writeContract).not.toHaveBeenCalled();
  });

  test("broadcasts once and verifies at the configured finality depth", async () => {
    const rail = await createEvmErc20Rail(evmConfig);
    await expect(rail.settle(evmParams)).resolves.toMatchObject({
      ok: true, txHash: TX, finality: { model: "block-depth", finalityBlocks: 2 },
    });
    expect(peers.writeContract).toHaveBeenCalledOnce();
    expect(peers.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: TX, confirmations: 2 });
  });

  test.each([0, -1, 1.5])("refuses finalityBlocks=%s at construction", async (finalityBlocks) => {
    await expect(createEvmErc20Rail({ ...evmConfig, finalityBlocks })).rejects.toThrow(/positive finalityBlocks/);
  });

  test.each([
    ["rpc.example", /requires an absolute RPC URL/],
    ["ws://rpc.example", /RPC URL must use HTTP\(S\)/],
    ["file:///etc/passwd", /RPC URL must use HTTP\(S\)/],
  ])("refuses RPC URL %s at construction", async (rpcUrl, reason) => {
    await expect(createEvmErc20Rail({ ...evmConfig, rpcUrl })).rejects.toThrow(reason);
  });
});

const x402Config = { evmPrivateKey: `0x${"12".repeat(32)}`, rpcUrl: "https://rpc.example", finalityBlocks: 2, requireSessionBinding: true };

describe("createX402Rail pre-payment preflight", () => {
  test("a wrong-chain finality RPC is refused before any HTTP request or signature", async () => {
    peers.chainId = 1;
    const fetchImpl = vi.fn(async () => new Response("unexpected", { status: 500 }));
    const rail = await createX402Rail({ ...x402Config, fetchImpl: fetchImpl as unknown as typeof fetch, transportPolicy: { mode: "insecure-test" } });
    await expect(rail.settle({
      paywallUrl: "https://seller.example/r", network: NETWORK, recipientEvm: PAYEE, amount: "1000000", asset: USDC,
      jobId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", phaseIndex: 0,
    })).rejects.toThrow(/RPC chain id does not match the negotiated network/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(peers.signTypedData).not.toHaveBeenCalled();
  });

  test("a non-canonical jobId is refused even without a phase (CORE JID-3)", async () => {
    const fetchImpl = vi.fn(async () => new Response("unexpected", { status: 500 }));
    const rail = await createX402Rail({
      ...x402Config, requireSessionBinding: false,
      fetchImpl: fetchImpl as unknown as typeof fetch, transportPolicy: { mode: "insecure-test" },
    });
    await expect(rail.settle({
      paywallUrl: "https://seller.example/r", network: NETWORK, recipientEvm: PAYEE, amount: "1000000", asset: USDC,
      jobId: "job-restart",
    })).rejects.toThrow(/pay-x402 jobId must be a canonical uppercase ULID/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(peers.signTypedData).not.toHaveBeenCalled();
  });

  // The JID-1 check applies to a jobId the rail is given, not to an unbound
  // call that has none: that call is not refused for JID-1 and still stops at
  // its own chain preflight.
  test("an unbound call with no jobId is not refused for JID-1 and reaches the chain preflight", async () => {
    peers.chainId = 1;
    const fetchImpl = vi.fn(async () => new Response("unexpected", { status: 500 }));
    const rail = await createX402Rail({
      ...x402Config, requireSessionBinding: false,
      fetchImpl: fetchImpl as unknown as typeof fetch, transportPolicy: { mode: "insecure-test" },
    });
    await expect(rail.settle({
      paywallUrl: "https://seller.example/r", network: NETWORK, recipientEvm: PAYEE, amount: "1000000", asset: USDC,
    })).rejects.toThrow(/RPC chain id does not match the negotiated network/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(peers.signTypedData).not.toHaveBeenCalled();
  });

  test.each([0, -1, 1.5])("refuses finalityBlocks=%s at construction", async (finalityBlocks) => {
    await expect(createX402Rail({ ...x402Config, finalityBlocks })).rejects.toThrow(/positive finalityBlocks/);
  });

  test.each(["ws://rpc.example", "file:///etc/passwd"])("refuses RPC URL %s at construction", async (rpcUrl) => {
    await expect(createX402Rail({ ...x402Config, rpcUrl })).rejects.toThrow(/RPC URL must use HTTP\(S\)/);
  });
});

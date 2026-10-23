// The production direct ERC-20 constructor checks the effect fence beside
// broadcast and verifies a successful broadcast at the configured depth.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createEvmErc20Rail } from "../../src/rails/evmErc20.js";

const peers = vi.hoisted(() => ({
  writeContract: vi.fn(),
  chainId: 84532,
  waitForTransactionReceipt: vi.fn(),
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
  privateKeyToAccount: vi.fn(() => ({ address: PAYER })),
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

});

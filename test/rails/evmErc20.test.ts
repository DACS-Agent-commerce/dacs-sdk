import { describe, expect, test } from "vitest";

import {
  evmErc20SettleCore,
  type EvmTransferClient,
} from "../../src/rails/evmErc20.js";

const NETWORK = "eip155:84532";
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";

function client(over: Partial<EvmTransferClient> = {}): EvmTransferClient {
  return {
    address: PAYER,
    transfer: async () => "0xtransfer",
    waitForFinality: async (_tx, confirmations) => ({
      status: "success",
      chainId: NETWORK,
      blockNumber: 100,
      blockTimestamp: 1780000000000,
      blockHash: "0xblock",
      confirmations,
    }),
    ...over,
  };
}

const params = {
  network: NETWORK,
  tokenAddress: TOKEN,
  recipientEvm: RECIPIENT,
  amount: "1000000",
  finalityBlocks: 12,
};

describe("evmErc20SettleCore (direct ERC-20 transfer rail)", () => {
  test("transfers the base-unit amount and reports settlement", async () => {
    let sent: { token: string; to: string; amount: bigint } | null = null;
    const res = await evmErc20SettleCore(
      params,
      client({
        transfer: async (args) => {
          sent = args;
          return "0xtransfer";
        },
      }),
    );
    expect(sent).toEqual({ token: TOKEN, to: RECIPIENT, amount: 1000000n });
    expect(res).toEqual({
      ok: true,
      txHash: "0xtransfer",
      chainId: NETWORK,
      payer: PAYER,
      payee: RECIPIENT,
      finality: { model: "block-depth", finalityBlocks: 12 },
      blockNumber: 100,
      txRefKind: "evm-erc20",
      receipt: {
        kind: "evm-erc20",
        blockNumber: 100,
        blockTimestamp: 1780000000000,
        blockHash: "0xblock",
        finalityBlocks: 12,
      },
    });
  });

  test("ok=false when the transfer does not mine successfully", async () => {
    const res = await evmErc20SettleCore(
      params,
      client({
        waitForFinality: async () => ({
          status: "reverted",
          chainId: NETWORK,
          blockNumber: 100,
          blockTimestamp: 1780000000000,
          confirmations: 12,
        }),
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.txHash).toBe("0xtransfer");
  });

  test.each([
    ["reorged", NETWORK, 12],
    ["not-final", NETWORK, 11],
    ["success", "eip155:1", 12],
  ] as const)("fails closed for %s/wrong-chain/insufficient-depth", async (status, chainId, confirmations) => {
    const res = await evmErc20SettleCore(
      params,
      client({
        waitForFinality: async (_hash, requested) => {
          expect(requested).toBe(12);
          return {
            status,
            chainId,
            blockNumber: 100,
            blockTimestamp: 1780000000000,
            confirmations,
          };
        },
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.finality).toEqual({ model: "block-depth", finalityBlocks: 12 });
  });

  test("rejects a non-positive amount before sending", async () => {
    let called = false;
    await expect(
      evmErc20SettleCore(
        { ...params, amount: "0" },
        client({
          transfer: async () => {
            called = true;
            return "0x";
          },
        }),
      ),
    ).rejects.toThrow(/> 0/);
    expect(called).toBe(false);
  });

  test("rejects a non-numeric amount", async () => {
    await expect(
      evmErc20SettleCore({ ...params, amount: "abc" }, client()),
    ).rejects.toThrow(/invalid base-unit amount/);
  });
});

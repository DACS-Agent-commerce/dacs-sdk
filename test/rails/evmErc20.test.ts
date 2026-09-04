import { describe, expect, test, vi } from "vitest";

import {
  evmErc20SettleCore,
  type EvmTransferClient,
} from "../../src/rails/evmErc20.js";
import {
  verifyEvmTransferFinality,
  type EvmTransferFinalityClient,
} from "../../src/rails/evmTransferFinality.js";

const NETWORK = "eip155:84532";
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const TX_HASH = `0x${"a".repeat(64)}`;
const BLOCK_HASH = `0x${"b".repeat(64)}`;
const FINALITY_HASH = `0x${"c".repeat(64)}`;

const topic = (address: string) =>
  `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

function finalityClient(
  over: Partial<EvmTransferFinalityClient> = {},
): EvmTransferFinalityClient {
  const receipt = {
    transactionHash: TX_HASH,
    blockNumber: 100n,
    blockHash: BLOCK_HASH,
    status: "success",
    logs: [{
      address: TOKEN,
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        topic(PAYER),
        topic(RECIPIENT),
      ],
      data: `0x${1000000n.toString(16).padStart(64, "0")}`,
      transactionHash: TX_HASH,
      blockNumber: 100n,
      blockHash: BLOCK_HASH,
      logIndex: 7,
      removed: false,
    }],
  };
  return {
    getChainId: async () => 84532,
    waitForTransactionReceipt: async (_input) => receipt,
    getTransactionReceipt: async (_input) => receipt,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
      number: blockNumber,
      hash: blockNumber === 100n ? BLOCK_HASH : FINALITY_HASH,
      timestamp: blockNumber === 100n ? 1_700_000_000n : 1_700_000_011n,
    }),
    ...over,
  };
}

function client(over: Partial<EvmTransferClient> = {}): EvmTransferClient {
  return {
    address: PAYER,
    transfer: async () => TX_HASH,
    finalityClient: finalityClient(),
    ...over,
  };
}

const params = {
  network: NETWORK,
  tokenAddress: TOKEN,
  recipientEvm: RECIPIENT,
  amount: "1000000",
  finalityBlocks: 2,
};

describe("evmErc20SettleCore (direct ERC-20 transfer rail)", () => {
  test("transfers the base-unit amount and reports settlement", async () => {
    let sent: { token: string; to: string; amount: bigint } | null = null;
    const res = await evmErc20SettleCore(
      params,
      client({
        transfer: async (args) => {
          sent = args;
          return TX_HASH;
        },
      }),
    );
    expect(sent).toEqual({ token: TOKEN, to: RECIPIENT, amount: 1000000n });
    expect(res).toEqual({
      ok: true,
      txHash: TX_HASH,
      chainId: NETWORK,
      payer: PAYER,
      payee: RECIPIENT,
      finality: { model: "block-depth", finalityBlocks: 2 },
      finalityObservedAt: 1_700_000_011_000,
      blockNumber: 100,
      txRef: {
        kind: "evm-event",
        chainId: 84532,
        txHash: "a".repeat(64),
        logIndex: 7,
      },
    });
  });

  test("checks the recovery generation immediately before the token transfer", async () => {
    const transfer = vi.fn(async () => TX_HASH);
    const assertCurrent = vi.fn(async () => {
      throw new Error("stale effect generation");
    });
    await expect(evmErc20SettleCore(
      params,
      client({ transfer }),
      {
        owner: "worker",
        generation: 2,
        settlementKey: "evm:job:0",
        bindingHash: "a".repeat(64),
        assertCurrent,
      },
    )).rejects.toThrow(/stale effect generation/);
    expect(assertCurrent).toHaveBeenCalledOnce();
    expect(transfer).not.toHaveBeenCalled();
  });

  test("rejects when the transfer transaction reverted", async () => {
    await expect(evmErc20SettleCore(
      params,
      client({
        finalityClient: finalityClient({
          getTransactionReceipt: async () => ({
            ...(await finalityClient().getTransactionReceipt({
              hash: TX_HASH,
            }) as object),
            status: "reverted",
          }),
        }),
      }),
    )).rejects.toThrow(/reverted/);
  });

  test("rejects a wrong-chain RPC before accepting finality", async () => {
    let transfers = 0;
    await expect(evmErc20SettleCore(
      params,
      client({
        transfer: async () => {
          transfers += 1;
          throw new Error("must not transfer");
        },
        finalityClient: finalityClient({ getChainId: async () => 8453 }),
      }),
    )).rejects.toThrow(/chain id/);
    expect(transfers).toBe(0);
  });

  test("rejects a missing or ambiguous exact Transfer event", async () => {
    const base = finalityClient();
    const receipt = await base.getTransactionReceipt({ hash: TX_HASH }) as {
      logs: unknown[];
    };
    await expect(evmErc20SettleCore(params, client({
      finalityClient: finalityClient({
        getTransactionReceipt: async () => ({ ...receipt, logs: [] }),
      }),
    }))).rejects.toThrow(/event is missing/);
    await expect(evmErc20SettleCore(params, client({
      finalityClient: finalityClient({
        getTransactionReceipt: async () => ({
          ...receipt,
          logs: [receipt.logs[0], { ...(receipt.logs[0] as object), logIndex: 8 }],
        }),
      }),
    }))).rejects.toThrow(/event is ambiguous/);
  });

  test("fails transiently when receipt and block views never converge", async () => {
    vi.useFakeTimers();
    try {
      const outcome = evmErc20SettleCore(params, client({
        finalityClient: finalityClient({
          getBlock: async ({ blockNumber }) => ({
            number: blockNumber,
            hash: FINALITY_HASH,
            timestamp: 1_700_000_011n,
          }),
        }),
      }));
      const rejection = expect(outcome).rejects.toMatchObject({
        name: "TransientError",
        category: "transient",
        message: expect.stringMatching(/canonical receipt\/block snapshot remained unavailable/),
      });
      await vi.runAllTimersAsync();
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  test("retries transient receipt and canonical-block visibility gaps", async () => {
    const base = finalityClient();
    let receiptReads = 0;
    let inclusionReads = 0;
    const result = await evmErc20SettleCore(params, client({
      finalityClient: finalityClient({
        getTransactionReceipt: async (input) => {
          receiptReads += 1;
          if (receiptReads === 1) throw new Error("receipt replica is behind");
          return base.getTransactionReceipt(input);
        },
        getBlock: async (input) => {
          if (input.blockNumber === 100n) {
            inclusionReads += 1;
            if (inclusionReads === 1) throw new Error("block replica is behind");
          }
          return base.getBlock(input);
        },
      }),
    }));

    expect(result.txRef).toMatchObject({ kind: "evm-event" });
    // One receipt failure and one block failure each restart the whole snapshot.
    expect(receiptReads).toBe(3);
    // One failed block read, then the initial canonical read and its recheck.
    expect(inclusionReads).toBe(3);
  });

  test("fails transiently when a canonical block remains unavailable", async () => {
    vi.useFakeTimers();
    try {
      const outcome = evmErc20SettleCore(params, client({
        finalityClient: finalityClient({
          getBlock: async () => {
            throw new Error("block not found");
          },
        }),
      }));
      const rejection = expect(outcome).rejects.toMatchObject({
        name: "TransientError",
        category: "transient",
        message: expect.stringMatching(/canonical receipt\/block snapshot remained unavailable/),
      });
      await vi.runAllTimersAsync();
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  test("retries the whole snapshot when the block set changes during the read", async () => {
    let inclusionReads = 0;
    const result = await evmErc20SettleCore(params, client({
      finalityClient: finalityClient({
        getBlock: async ({ blockNumber }) => {
          if (blockNumber === 100n) inclusionReads += 1;
          return {
            number: blockNumber,
            hash: blockNumber === 100n
              ? (inclusionReads === 2 ? FINALITY_HASH : BLOCK_HASH)
              : FINALITY_HASH,
            timestamp: 1_700_000_011n,
          };
        },
      }),
    }));
    expect(result.txRef).toMatchObject({ kind: "evm-event" });
    expect(inclusionReads).toBe(4);
  });

  test("passes the descriptor confirmation depth and timestamps its Nth block", async () => {
    let confirmations = 0;
    const res = await evmErc20SettleCore(params, client({
      finalityClient: finalityClient({
        waitForTransactionReceipt: async (input) => {
          confirmations = input.confirmations;
          return finalityClient().getTransactionReceipt({ hash: input.hash });
        },
      }),
    }));
    expect(confirmations).toBe(2);
    expect(res.finalityObservedAt).toBe(1_700_000_011_000);
  });

  test("pins all settlement params before the transfer callback", async () => {
    const mutable = { ...params };
    let sent: { token: string; to: string; amount: bigint } | undefined;
    let waited = 0;
    const result = await evmErc20SettleCore(mutable, client({
      transfer: async (input) => {
        sent = input;
        Object.assign(mutable, {
          network: "eip155:8453",
          tokenAddress: "0x3333333333333333333333333333333333333333",
          recipientEvm: "0x4444444444444444444444444444444444444444",
          amount: "1",
          finalityBlocks: 1,
        });
        return TX_HASH;
      },
      finalityClient: finalityClient({
        waitForTransactionReceipt: async (input) => {
          waited = input.confirmations;
          return finalityClient().getTransactionReceipt({ hash: input.hash });
        },
      }),
    }));

    expect(sent).toEqual({ token: TOKEN, to: RECIPIENT, amount: 1000000n });
    expect(waited).toBe(2);
    expect(result).toMatchObject({
      chainId: NETWORK,
      payer: PAYER,
      payee: RECIPIENT,
      finality: { model: "block-depth", finalityBlocks: 2 },
    });
  });

  test("pins the public finality request before the chain-id callback", async () => {
    const mutable = {
      chainId: 84532,
      transactionHash: TX_HASH,
      tokenAddress: TOKEN,
      payerAddress: PAYER,
      payeeAddress: RECIPIENT,
      amount: 1000000n,
      minimumConfirmations: 2,
    };
    const base = finalityClient();
    let waited: { hash: string; confirmations: number } | undefined;
    const observed = await verifyEvmTransferFinality(mutable, {
      ...base,
      getChainId: async () => {
        Object.assign(mutable, {
          chainId: 8453,
          transactionHash: `0x${"d".repeat(64)}`,
          tokenAddress: "0x3333333333333333333333333333333333333333",
          payerAddress: "0x4444444444444444444444444444444444444444",
          payeeAddress: "0x5555555555555555555555555555555555555555",
          amount: 1n,
          minimumConfirmations: 1,
        });
        return 84532;
      },
      waitForTransactionReceipt: async (input) => {
        waited = input;
        return base.getTransactionReceipt({ hash: input.hash });
      },
    });

    expect(waited).toEqual({ hash: TX_HASH, confirmations: 2 });
    expect(observed).toMatchObject({
      chainId: 84532,
      transactionHash: "a".repeat(64),
      confirmations: 2,
    });
  });

  test("canonicalizes a valid upper-case submitted transaction hash", async () => {
    const res = await evmErc20SettleCore(params, client({
      transfer: async () => `0x${"A".repeat(64)}`,
    }));
    expect(res.txHash).toBe(TX_HASH);
  });

  test("rejects a finality block timestamp that predates inclusion", async () => {
    await expect(evmErc20SettleCore(params, client({
      finalityClient: finalityClient({
        getBlock: async ({ blockNumber }) => ({
          number: blockNumber,
          hash: blockNumber === 100n ? BLOCK_HASH : FINALITY_HASH,
          timestamp: blockNumber === 100n ? 1_700_000_011n : 1_700_000_000n,
        }),
      }),
    }))).rejects.toThrow(/predates the inclusion block/);
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

import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createIdempotencyStore,
  createInMemorySettlementLog,
  settlementKey,
} from "../../src/rails/idempotency.js";
import {
  createPayDemRail,
  observeDemosExecutionByHash,
  payDemRecordVerifiedTransfer,
  payDemSettle,
  type PayDemSettlementReconcile,
  type PayDemSettlementRecoveryContext,
} from "../../src/rails/payDem.js";

// #338: the status index reports `included` for a transaction the node records
// as `failed`. `createPayDemRail().settle()` must report success only when the
// node's transaction record shows the exact prepared transfer executed.

const WALLET = `0x${"ab".repeat(32)}`;
const PAYEE_HEX = "cd".repeat(32);
const RECIPIENT = `0x${PAYEE_HEX}`;
const TX_HASH = "85".repeat(32);
const NONCE = 9;
const BLOCK = 480_877;
const AMOUNT_OS = "9500000000";

const sdk = vi.hoisted(() => ({
  broadcast: vi.fn(),
  confirm: vi.fn(),
  connect: vi.fn(),
  connectWallet: vi.fn(),
  getNetworkInfo: vi.fn(),
  getTxByHash: vi.fn(),
  nodeCall: vi.fn(),
  transfer: vi.fn(),
  waitForNonce: vi.fn(),
}));

vi.mock("@kynesyslabs/demosdk/websdk", () => ({
  Demos: class MockDemos {
    readonly tx = { confirm: sdk.confirm };
    readonly broadcast = sdk.broadcast;
    readonly connect = sdk.connect;
    readonly connectWallet = sdk.connectWallet;
    readonly getNetworkInfo = sdk.getNetworkInfo;
    readonly getTxByHash = sdk.getTxByHash;
    readonly nodeCall = sdk.nodeCall;
    readonly transfer = sdk.transfer;
    readonly waitForNonce = sdk.waitForNonce;

    getAddress(): string {
      return WALLET;
    }
  },
}));

interface BroadcastTransaction {
  hash: string;
  content: {
    from: string;
    to: string;
    amount: string | number;
    nonce: number | string;
    data: [string, { nativeOperation: string; args: [string, string] }];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface TransactionRecord extends BroadcastTransaction {
  status: string;
  blockNumber: unknown;
}

/**
 * The node's record for the transaction that was actually broadcast, in the
 * shape `getTxByHash` serves it (node `stabilisation@61b8e75`, see the
 * recorded node2 records below): the nonce is a decimal string (a pg `bigint`
 * column), the amount is a number, the native args carry the payee without
 * `0x`, and the node adds `attrs`.
 */
function broadcastRecord(): TransactionRecord {
  const validity = sdk.broadcast.mock.calls.at(-1)?.[0] as {
    response: { data: { transaction: BroadcastTransaction } };
  };
  const transaction = structuredClone(validity.response.data.transaction);
  const [payee, amount] = transaction.content.data[1].args;
  transaction.content.nonce = String(transaction.content.nonce);
  transaction.content.amount = Number(transaction.content.amount);
  transaction.content.data[1].args = [payee.replace(/^0x/, ""), amount];
  return {
    ...transaction,
    status: "confirmed",
    blockNumber: BLOCK,
    attrs: { reference_block: BLOCK - 1 },
  };
}

function recordReturning(mutate: (record: TransactionRecord) => void) {
  return async () => {
    const record = broadcastRecord();
    mutate(record);
    return record;
  };
}

const FAST = {
  inclusionPollIntervalMs: 1,
  statusRequestTimeoutMs: 5,
  transactionRecordTimeoutMs: 30,
};

async function rail(options: Partial<typeof FAST> = {}) {
  return createPayDemRail({
    rpc: "https://node.test",
    secret: "test-secret",
    ...FAST,
    ...options,
  });
}

/** A not-ok result that carries no settlement evidence of any kind. */
const NOT_OK = {
  ok: false,
  txHash: TX_HASH,
  chainId: "demos",
  payer: WALLET,
  payee: RECIPIENT,
};

beforeEach(() => {
  vi.clearAllMocks();
  sdk.connect.mockResolvedValue(undefined);
  sdk.connectWallet.mockResolvedValue(undefined);
  sdk.getNetworkInfo.mockResolvedValue({
    forks: { osDenomination: { activated: true } },
  });
  sdk.transfer.mockImplementation(async (to: string, amountOs: bigint) => ({
    hash: TX_HASH,
    content: {
      type: "native",
      from: WALLET,
      from_ed25519_address: WALLET,
      to,
      amount: amountOs.toString(),
      nonce: NONCE,
      data: [
        "native",
        { nativeOperation: "send", args: [to, amountOs.toString()] },
      ],
    },
  }));
  sdk.confirm.mockImplementation(async (signed: {
    hash: string;
    content: Record<string, unknown>;
  }) => ({
    response: {
      data: {
        transaction: {
          hash: signed.hash,
          content: {
            ...signed.content,
            transaction_fee: {
              network_fee: "400000000",
              rpc_fee: "500000000",
              additional_fee: "100000000",
            },
          },
        },
      },
    },
  }));
  sdk.broadcast.mockResolvedValue({ result: 200, response: { hash: TX_HASH } });
  sdk.nodeCall.mockResolvedValue({ state: "included", blockNumber: BLOCK });
  sdk.getTxByHash.mockImplementation(recordReturning(() => undefined));
  sdk.waitForNonce.mockResolvedValue(undefined);
});

describe("pay-dem reports ok only for an executed transfer (#338)", () => {
  it("settles an executed record that matches the prepared transfer", async () => {
    const payDem = await rail();

    await expect(
      payDem.settle({ recipient: RECIPIENT, amount: AMOUNT_OS }),
    ).resolves.toEqual({
      ok: true,
      execution: "executed",
      txHash: TX_HASH,
      chainId: "demos",
      payer: WALLET,
      payee: RECIPIENT,
      finality: { model: "bft-final" },
      blockNumber: BLOCK,
      txRefKind: "demos",
      networkFeeOs: "1000000000",
    });
    expect(sdk.getTxByHash).toHaveBeenCalledWith(TX_HASH);
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
  });

  // A host that accepts any PayDemRail settles a payment only on this lookup,
  // never on the result's `execution` string.
  it("lists its frozen success with the exact transfer terms it signed", async () => {
    const payDem = await rail();
    const recovery = {
      railId: "demos-native:DEM",
      jobId: "job-verified",
      phaseIndex: 0,
      settlementKey: settlementKey("demos-native:DEM", "job-verified", 0),
      network: "demos",
      payer: WALLET.slice(2),
      payee: PAYEE_HEX,
      amountOs: AMOUNT_OS,
    };
    const result = await payDem.settle({
      recipient: RECIPIENT,
      amount: AMOUNT_OS,
      recovery,
    });

    expect(payDemRecordVerifiedTransfer(result)).toEqual({
      payer: WALLET.slice(2),
      payee: PAYEE_HEX,
      amountOs: AMOUNT_OS,
      network: "demos",
      settlementKey: recovery.settlementKey,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.finality)).toBe(true);
    expect(payDemRecordVerifiedTransfer({ ...result })).toBeUndefined();
    expect(payDemRecordVerifiedTransfer(structuredClone(result))).toBeUndefined();
  });

  it.each([
    ["failed", "permanent failure"],
    ["pending", "held result"],
  ])("lists no %s record's %s", async (status) => {
    sdk.getTxByHash.mockImplementation(recordReturning((record) => {
      record.status = status;
    }));
    const payDem = await rail();

    const result = await payDem.settle({ recipient: RECIPIENT, amount: AMOUNT_OS });

    expect(result.ok).toBe(false);
    expect(payDemRecordVerifiedTransfer(result)).toBeUndefined();
  });

  it.each([undefined, null, 0, "result", Symbol("result"), {}])(
    "lists nothing for %s",
    (value) => {
      expect(payDemRecordVerifiedTransfer(value)).toBeUndefined();
    },
  );

  it("accepts a record that keeps the signed wire amount and numeric nonce", async () => {
    sdk.getTxByHash.mockImplementation(recordReturning((record) => {
      record.content.amount = AMOUNT_OS;
      record.content.nonce = NONCE;
      record.content.data[1].args[0] = RECIPIENT;
    }));
    const payDem = await rail();

    await expect(
      payDem.settle({ recipient: RECIPIENT, amount: AMOUNT_OS }),
    ).resolves.toMatchObject({ ok: true, blockNumber: BLOCK });
  });

  it("classifies a bound failed record as permanent without settlement finality", async () => {
    sdk.getTxByHash.mockImplementation(recordReturning((record) => {
      record.status = "failed";
      record.attrs = {
        code: "TX_NONCE_INVALID_LOW",
        message: "Invalid nonce edit. Expected 10, got 9",
        reference_block: BLOCK - 2,
      };
    }));
    const payDem = await rail();

    await expect(
      payDem.settle({ recipient: RECIPIENT, amount: AMOUNT_OS }),
    ).resolves.toEqual({
      ...NOT_OK, errorClass: "permanent", blockNumber: BLOCK, txRefKind: "demos",
      failureProof: { kind: "demos-failed-record", txHash: TX_HASH, nonce: NONCE,
        blockNumber: BLOCK, payer: "ab".repeat(32), payee: "cd".repeat(32), amountOs: AMOUNT_OS },
    });
    expect(sdk.getTxByHash).toHaveBeenCalledTimes(1);
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
    expect(sdk.waitForNonce).not.toHaveBeenCalled();
  });

  it("does not report a failed record that does not bind the signed nonce as ok", async () => {
    sdk.getTxByHash.mockImplementation(recordReturning((record) => {
      record.status = "failed";
      delete (record.content as Record<string, unknown>).nonce;
    }));
    const payDem = await rail({ transactionRecordTimeoutMs: 1_000 });

    await expect(
      payDem.settle({ recipient: RECIPIENT, amount: AMOUNT_OS }),
    ).resolves.toEqual(NOT_OK);
    expect(sdk.getTxByHash).toHaveBeenCalledTimes(1);
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
    expect(sdk.waitForNonce).not.toHaveBeenCalled();
  });

  it.each([
    ["amount", (record: TransactionRecord) => {
      record.content.amount = 1_000_000_000;
      record.content.data[1].args[1] = "1000000000";
    }],
    ["payee", (record: TransactionRecord) => {
      record.content.to = `0x${"ef".repeat(32)}`;
      record.content.data[1].args[0] = "ef".repeat(32);
    }],
    ["nonce", (record: TransactionRecord) => {
      record.content.nonce = String(NONCE + 1);
    }],
    ["payer", (record: TransactionRecord) => {
      record.content.from = `0x${"12".repeat(32)}`;
      record.content.from_ed25519_address = `0x${"12".repeat(32)}`;
    }],
    ["inclusion block", (record: TransactionRecord) => {
      record.blockNumber = BLOCK + 1;
    }],
    ["body", (record: TransactionRecord) => {
      (record as Record<string, unknown>).content = "not-a-transaction-body";
    }],
  ])("does not report an executed record with a mismatched %s as ok", async (
    _field,
    mutate,
  ) => {
    sdk.getTxByHash.mockImplementation(recordReturning(mutate));
    const payDem = await rail({ transactionRecordTimeoutMs: 1_000 });

    await expect(
      payDem.settle({ recipient: RECIPIENT, amount: AMOUNT_OS }),
    ).resolves.toEqual(NOT_OK);
    // A confirmed record that contradicts the prepared transfer will not
    // repair itself: no further reads and no further broadcast.
    expect(sdk.getTxByHash).toHaveBeenCalledTimes(1);
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
    expect(sdk.waitForNonce).not.toHaveBeenCalled();
  });

  it("is indeterminate without stacking reads when the record read stalls", async () => {
    sdk.getTxByHash.mockImplementation(() => new Promise<never>(() => undefined));
    const payDem = await rail({ transactionRecordTimeoutMs: 1_000 });

    await expect(
      payDem.settle({ recipient: RECIPIENT, amount: AMOUNT_OS }),
    ).resolves.toEqual(NOT_OK);
    expect(sdk.getTxByHash).toHaveBeenCalledTimes(1);
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
    expect(sdk.waitForNonce).not.toHaveBeenCalled();
  });

  it.each([
    ["no record", async () => null],
    ["a pending record", recordReturning((record) => {
      record.status = "pending";
    })],
    ["a record without a status", recordReturning((record) => {
      delete (record as Record<string, unknown>).status;
    })],
    // Execution is the literal record status `confirmed`, nothing near it.
    ["an included record", recordReturning((record) => {
      record.status = "included";
    })],
    ["a finalized record", recordReturning((record) => {
      record.status = "finalized";
    })],
    ["a Confirmed record", recordReturning((record) => {
      record.status = "Confirmed";
    })],
    ["a record for another hash", recordReturning((record) => {
      record.hash = "34".repeat(32);
    })],
    ["a non-object record", async () => "Transaction not found"],
    ["an array record", async () => [broadcastRecord()]],
    ["a transport failure envelope", async () => ({
      result: 500,
      response: "connect ECONNREFUSED",
      require_reply: false,
    })],
    ["an accessor-bearing record", async () => {
      const record = broadcastRecord();
      Object.defineProperty(record, "status", {
        enumerable: true,
        get: () => "confirmed",
      });
      return record;
    }],
    ["a rejected read", async () => {
      throw new Error("socket hang up");
    }],
  ])("is indeterminate when the budget ends with %s", async (_case, read) => {
    sdk.getTxByHash.mockImplementation(read);
    const payDem = await rail();

    await expect(
      payDem.settle({ recipient: RECIPIENT, amount: AMOUNT_OS }),
    ).resolves.toEqual(NOT_OK);
    expect(sdk.getTxByHash.mock.calls.length).toBeGreaterThan(1);
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
    expect(sdk.waitForNonce).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5])(
    "rejects a transaction-record budget of %s before connecting",
    async (transactionRecordTimeoutMs) => {
      await expect(rail({ transactionRecordTimeoutMs })).rejects.toThrow(
        /transactionRecordTimeoutMs must be a positive safe integer/,
      );
      expect(sdk.connect).not.toHaveBeenCalled();
    },
  );

  it("waits within the budget for a record that lags the status index", async () => {
    const executed = recordReturning(() => undefined);
    sdk.getTxByHash
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(recordReturning((record) => {
        record.status = "pending";
      }))
      .mockImplementation(executed);
    const payDem = await rail({ transactionRecordTimeoutMs: 1_000 });

    await expect(
      payDem.settle({ recipient: RECIPIENT, amount: AMOUNT_OS }),
    ).resolves.toMatchObject({ ok: true, txHash: TX_HASH, blockNumber: BLOCK });
    expect(sdk.getTxByHash).toHaveBeenCalledTimes(3);
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
  });

  it("gives a lagging record the default 30 second budget", async () => {
    sdk.getTxByHash
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockImplementation(recordReturning(() => undefined));
    const payDem = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
      inclusionPollIntervalMs: 10,
      statusRequestTimeoutMs: 50,
    });

    await expect(
      payDem.settle({ recipient: RECIPIENT, amount: AMOUNT_OS }),
    ).resolves.toMatchObject({ ok: true, txHash: TX_HASH, blockNumber: BLOCK });
    expect(sdk.getTxByHash).toHaveBeenCalledTimes(4);
  });

  it("does not read the record when the status index reports failed", async () => {
    // Current nodes never emit status `failed` (#338), but a status index that
    // does is never overridden by a confirmed record.
    sdk.nodeCall.mockResolvedValue({ state: "failed", blockNumber: BLOCK });
    const payDem = await rail();

    await expect(
      payDem.settle({ recipient: RECIPIENT, amount: AMOUNT_OS }),
    ).resolves.toEqual(NOT_OK);
    expect(sdk.getTxByHash).not.toHaveBeenCalled();
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
  });
});

/** Serve `value()` after `ms`, as a real node read does. */
function after<T>(ms: number, value: () => T): () => Promise<T> {
  return () => new Promise((resolve) => setTimeout(() => resolve(value()), ms));
}

function statusReads(): number {
  return sdk.nodeCall.mock.calls
    .filter(([message]) => message === "getTransactionStatus").length;
}

describe("pay-dem node reads take time and are polled at the configured interval", () => {
  // Every other double here answers at once, so a per-read bound or a default
  // timing constant collapsed to 1 ms would go unnoticed.
  beforeEach(() => {
    sdk.nodeCall.mockImplementation(
      after(30, () => ({ state: "included", blockNumber: BLOCK })),
    );
    sdk.getTxByHash.mockImplementation(after(30, recordReturning(() => undefined)));
  });

  it("settles with the default bounds when each node read takes 30 ms", async () => {
    const payDem = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
    });

    await expect(
      payDem.settle({ recipient: RECIPIENT, amount: AMOUNT_OS }),
    ).resolves.toMatchObject({ ok: true, txHash: TX_HASH, blockNumber: BLOCK });
    expect(statusReads()).toBe(1);
    expect(sdk.getTxByHash).toHaveBeenCalledTimes(1);
  });

  it("settles when each node read takes 30 ms under explicit bounds", async () => {
    const payDem = await rail({
      statusRequestTimeoutMs: 500,
      transactionRecordTimeoutMs: 2_000,
    });

    await expect(
      payDem.settle({ recipient: RECIPIENT, amount: AMOUNT_OS }),
    ).resolves.toMatchObject({ ok: true, txHash: TX_HASH, blockNumber: BLOCK });
  });

  it("bounds a status read by statusRequestTimeoutMs, not the inclusion budget", async () => {
    const payDem = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
      inclusionTimeoutMs: 2_000,
      statusRequestTimeoutMs: 10,
    });

    await expect(
      payDem.settle({ recipient: RECIPIENT, amount: AMOUNT_OS }),
    ).resolves.toEqual(NOT_OK);
    expect(statusReads()).toBe(1);
    expect(sdk.getTxByHash).not.toHaveBeenCalled();
  });

  it("bounds a record read by statusRequestTimeoutMs, not the record budget", async () => {
    sdk.nodeCall.mockResolvedValue({ state: "included", blockNumber: BLOCK });
    const payDem = await rail({
      statusRequestTimeoutMs: 10,
      transactionRecordTimeoutMs: 2_000,
    });

    await expect(
      payDem.settle({ recipient: RECIPIENT, amount: AMOUNT_OS }),
    ).resolves.toEqual(NOT_OK);
    expect(sdk.getTxByHash).toHaveBeenCalledTimes(1);
    expect(sdk.waitForNonce).not.toHaveBeenCalled();
  });

  it("waits the poll interval between status reads", async () => {
    sdk.nodeCall.mockResolvedValue({ state: "pending" });
    const payDem = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
      inclusionTimeoutMs: 50,
      inclusionPollIntervalMs: 10,
      statusRequestTimeoutMs: 50,
    });

    await expect(
      payDem.settle({ recipient: RECIPIENT, amount: AMOUNT_OS }),
    ).resolves.toEqual(NOT_OK);
    // About five reads fit a 50 ms budget at 10 ms; without the wait the node
    // would be read back to back for the whole budget.
    expect(statusReads()).toBeGreaterThan(1);
    expect(statusReads()).toBeLessThanOrEqual(7);
    expect(sdk.getTxByHash).not.toHaveBeenCalled();
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
  });

  it("polls a pending status every 500 ms by default", async () => {
    sdk.nodeCall
      .mockResolvedValueOnce({ state: "pending" })
      .mockResolvedValue({ state: "included", blockNumber: BLOCK });
    sdk.getTxByHash.mockImplementation(recordReturning(() => undefined));
    const payDem = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
    });
    vi.useFakeTimers();
    try {
      const settlement = payDem.settle({ recipient: RECIPIENT, amount: AMOUNT_OS });

      await vi.advanceTimersByTimeAsync(499);
      expect(statusReads()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      // Asserted before awaiting, so a longer default fails here rather than
      // on the test timeout.
      expect(statusReads()).toBe(2);
      await expect(settlement).resolves.toMatchObject({ ok: true, blockNumber: BLOCK });
      expect(statusReads()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the execution observer tells failed from indeterminate (#338)", () => {
  // `settle()` maps both outcomes to the same not-ok result, so this asserts
  // the observer's own state and reason.
  const expected = {
    blockNumber: BLOCK,
    transfer: {
      payer: WALLET,
      payee: RECIPIENT,
      amountOs: BigInt(AMOUNT_OS),
      nonce: NONCE,
      postFork: true,
    },
  };

  /** An executed record in the node's projection (see `broadcastRecord`). */
  function executedRecord(): TransactionRecord {
    return {
      hash: TX_HASH,
      status: "confirmed",
      blockNumber: BLOCK,
      content: {
        type: "native",
        from: WALLET,
        from_ed25519_address: WALLET,
        to: RECIPIENT,
        amount: Number(AMOUNT_OS),
        nonce: String(NONCE),
        data: [
          "native",
          { nativeOperation: "send", args: [PAYEE_HEX, AMOUNT_OS] },
        ],
      },
      attrs: { reference_block: BLOCK - 1 },
    };
  }

  function observe(read: (hash: string) => Promise<unknown>, budgetMs = 1_000) {
    return observeDemosExecutionByHash(TX_HASH, read, expected, {
      ...FAST,
      transactionRecordTimeoutMs: budgetMs,
    });
  }

  it("reports an executed record that matches the prepared transfer", async () => {
    const read = vi.fn(async () => executedRecord());

    await expect(observe(read)).resolves.toEqual({ state: "executed" });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(TX_HASH);
  });

  it("reports a failed record as failed", async () => {
    const read = vi.fn(async () => ({ ...executedRecord(), status: "failed" }));

    await expect(observe(read)).resolves.toEqual({ state: "failed" });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a stalled read", "transaction record read timed out",
      () => new Promise<never>(() => undefined)],
    ["a mismatched amount", "transaction record does not match the prepared transfer",
      async () => {
        const record = executedRecord();
        record.content.amount = 1;
        record.content.data[1].args[1] = "1";
        return record;
      }],
    ["a mismatched nonce", "transaction record does not bind the signed nonce",
      async () => {
        const record = executedRecord();
        record.content.nonce = String(NONCE + 1);
        return record;
      }],
    ["another inclusion block",
      "transaction record block does not match the observed inclusion",
      async () => ({ ...executedRecord(), blockNumber: BLOCK + 1 })],
    // A failed status is only a statement about this transfer when the record
    // binds it; otherwise it is malformed.
    ["a failed record without a nonce",
      "transaction record does not bind the signed nonce",
      async () => {
        const record: Record<string, unknown> = {
          ...executedRecord(),
          status: "failed",
        };
        delete (record.content as Record<string, unknown>).nonce;
        return record;
      }],
    ["a failed record with another nonce",
      "transaction record does not bind the signed nonce",
      async () => {
        const record = { ...executedRecord(), status: "failed" };
        record.content.nonce = String(NONCE + 1);
        return record;
      }],
    ["a failed record without a body",
      "transaction record does not bind the signed nonce",
      async () => {
        const record: Record<string, unknown> = {
          ...executedRecord(),
          status: "failed",
        };
        delete record.content;
        return record;
      }],
    ["a record with null content",
      "transaction record does not bind the signed nonce",
      async () => ({ ...executedRecord(), content: null })],
    ["a failed record for another amount",
      "transaction record does not match the prepared transfer",
      async () => {
        const record = { ...executedRecord(), status: "failed" };
        record.content.amount = 1;
        record.content.data[1].args[1] = "1";
        return record;
      }],
    ["a failed record at another block",
      "transaction record block does not match the observed inclusion",
      async () => ({ ...executedRecord(), status: "failed", blockNumber: BLOCK + 1 })],
    // The record body is held to the same native send as the signed body.
    ["a record with custom charges", "transaction record does not match the prepared transfer",
      async () => {
        const record = executedRecord();
        (record.content as Record<string, unknown>).custom_charges = { rpc_fee: "1" };
        return record;
      }],
    ["a record of another transaction type",
      "transaction record does not match the prepared transfer",
      async () => {
        const record = executedRecord();
        (record.content as Record<string, unknown>).type = "web2Request";
        return record;
      }],
    ["a record of another native operation",
      "transaction record does not match the prepared transfer",
      async () => {
        const record = executedRecord();
        record.content.data[1].nativeOperation = "tokenTransfer";
        return record;
      }],
    ["a failed record with custom charges",
      "transaction record does not match the prepared transfer",
      async () => {
        const record = { ...executedRecord(), status: "failed" };
        (record.content as Record<string, unknown>).custom_charges = { rpc_fee: "1" };
        return record;
      }],
  ])("is indeterminate at once for %s", async (_case, reason, read) => {
    const spy = vi.fn(read);

    await expect(observe(spy)).resolves.toEqual({ state: "indeterminate", reason });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a malformed record", "transaction record is missing or malformed",
      async () => "Transaction not found"],
    ["a pending record", "transaction record has no terminal execution status",
      async () => ({ ...executedRecord(), status: "pending" })],
    ["an included record", "transaction record has no terminal execution status",
      async () => ({ ...executedRecord(), status: "included" })],
    ["a finalized record", "transaction record has no terminal execution status",
      async () => ({ ...executedRecord(), status: "finalized" })],
    ["a Confirmed record", "transaction record has no terminal execution status",
      async () => ({ ...executedRecord(), status: "Confirmed" })],
    ["a FAILED record", "transaction record has no terminal execution status",
      async () => ({ ...executedRecord(), status: "FAILED" })],
    // Fields the binding does not compare must still be canonical JSON.
    ["an unsafe integer in a field that is not compared",
      "transaction record is missing or malformed",
      async () => ({ ...executedRecord(), gcr_edits: [{ amount: 2 ** 53 + 2 }] })],
    ["a rejected read", "transaction record read failed",
      async () => {
        throw new Error("socket hang up");
      }],
  ])("is indeterminate when the budget ends with %s", async (_case, reason, read) => {
    const spy = vi.fn(read);

    await expect(observe(spy, FAST.transactionRecordTimeoutMs)).resolves.toEqual({
      state: "indeterminate",
      reason,
    });
    expect(spy.mock.calls.length).toBeGreaterThan(1);
  });

  it("waits the poll interval between record reads", async () => {
    const read = vi.fn(async () => null);

    await expect(observeDemosExecutionByHash(TX_HASH, read, expected, {
      ...FAST,
      inclusionPollIntervalMs: 10,
      transactionRecordTimeoutMs: 50,
    })).resolves.toEqual({
      state: "indeterminate",
      reason: "transaction record is missing or malformed",
    });
    // About five reads fit a 50 ms budget at 10 ms; without the wait the node
    // would be read back to back for the whole budget.
    expect(read.mock.calls.length).toBeGreaterThan(1);
    expect(read.mock.calls.length).toBeLessThanOrEqual(7);
  });
});

describe("the execution observer reads recorded node2 records (#338)", () => {
  // Raw `getTxByHash` envelopes read from node2 (kynesyslabs/node
  // stabilisation@61b8e75). demosdk's `getTxByHash` resolves the envelope's
  // `response` member, so that is what the observer is given.
  const node2 = JSON.parse(readFileSync(
    new URL("../fixtures/demos-node2-records.json", import.meta.url),
    "utf8",
  )) as {
    getTxByHash: Record<string, { response: Record<string, unknown> }>;
    getTransactionStatus: Record<string, { response: Record<string, unknown> }>;
  };
  const PAYER = "0xc0a58599ceaeba18f9c450133631cce4c45f4dc7a59c8026331504da3a913c2a";
  const PAYEE = "0x706b89f5e2d56498a90bc3a209842b0bd0e22ce06bb4df7c27805e655614e5f1";
  const CONFIRMED_HASH = "330dcf1dac0839ebc138d5e2a0db6db7b9567d769c8d4bd987b0d72d7d905918";
  const FAILED_HASH = "85b8fcdcee48822742a39e1b9877f5e2f8dde36430e8e486e3a8b0c9a7744cbd";

  function served(hash: string) {
    return vi.fn(async () => structuredClone(node2.getTxByHash[hash]!.response));
  }

  function transfer(nonce: number) {
    return {
      payer: PAYER,
      payee: PAYEE,
      amountOs: 9_500_000_000n,
      nonce,
      postFork: true,
    };
  }

  it("serves the nonce as a decimal string", () => {
    for (const envelope of Object.values(node2.getTxByHash)) {
      expect(typeof (envelope.response.content as { nonce: unknown }).nonce)
        .toBe("string");
    }
  });

  it("reports node2's confirmed native send as executed", async () => {
    const read = served(CONFIRMED_HASH);

    await expect(observeDemosExecutionByHash(
      CONFIRMED_HASH,
      read,
      { blockNumber: 498_447, transfer: transfer(28) },
      FAST,
    )).resolves.toEqual({ state: "executed" });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(CONFIRMED_HASH);
  });

  it("reports node2's TX_NONCE_INVALID_LOW record as failed", async () => {
    const read = served(FAILED_HASH);

    await expect(observeDemosExecutionByHash(
      FAILED_HASH,
      read,
      { blockNumber: 480_877, transfer: transfer(9) },
      FAST,
    )).resolves.toEqual({ state: "failed" });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("records node2's status index reporting that failed record as included", () => {
    // Why inclusion alone is not execution: same hash, same block.
    expect(node2.getTransactionStatus[FAILED_HASH]!.response)
      .toEqual({ state: "included", blockNumber: 480_877 });
    expect(node2.getTxByHash[FAILED_HASH]!.response)
      .toMatchObject({ status: "failed", blockNumber: 480_877 });
  });

  it.each([
    ["another nonce", CONFIRMED_HASH, 498_447, 29,
      "transaction record does not bind the signed nonce"],
    ["another inclusion block", CONFIRMED_HASH, 498_448, 28,
      "transaction record block does not match the observed inclusion"],
    ["a failed record under another nonce", FAILED_HASH, 480_877, 10,
      "transaction record does not bind the signed nonce"],
  ])("is indeterminate for a recorded record with %s", async (
    _case,
    hash,
    blockNumber,
    nonce,
    reason,
  ) => {
    await expect(observeDemosExecutionByHash(
      hash,
      served(hash),
      { blockNumber, transfer: transfer(nonce) },
      FAST,
    )).resolves.toEqual({ state: "indeterminate", reason });
  });

  it.each([
    // node2 (61b8e75) serves not-found as {result: 400, response: "error"};
    // stabilisation HEAD (52e2e569) serves {result: 404, response: null}.
    ["node2's not-found response", "error"],
    ["stabilisation HEAD's not-found response", null],
  ])("polls %s until the budget ends", async (_case, response) => {
    const read = vi.fn(async () => response);

    await expect(observeDemosExecutionByHash(
      CONFIRMED_HASH,
      read,
      { blockNumber: 498_447, transfer: transfer(28) },
      FAST,
    )).resolves.toEqual({
      state: "indeterminate",
      reason: "transaction record is missing or malformed",
    });
    expect(read.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("no failed or indeterminate execution causes another broadcast (#338)", () => {
  const request = {
    rail: "pay-dem",
    phase: "pay-dem",
    amount: "9.5",
    asset: "DEM",
    payee: `did:demos:agent:${PAYEE_HEX}`,
    expectedPayee: PAYEE_HEX,
    jobId: "job-338",
    phaseIndex: 0,
  } as const;

  it.each([
    ["a failed record", () => {
      sdk.getTxByHash.mockImplementation(recordReturning((record) => {
        record.status = "failed";
      }));
    }],
    ["a failed record that does not bind the signed nonce", () => {
      sdk.getTxByHash.mockImplementation(recordReturning((record) => {
        record.status = "failed";
        delete (record.content as Record<string, unknown>).nonce;
      }));
    }],
    ["a mismatched record", () => {
      sdk.getTxByHash.mockImplementation(recordReturning((record) => {
        record.content.amount = 1;
        record.content.data[1].args[1] = "1";
      }));
    }],
    ["a stalled record read", () => {
      sdk.getTxByHash.mockImplementation(() => new Promise<never>(() => undefined));
    }],
    ["a malformed record", () => {
      sdk.getTxByHash.mockResolvedValue("Transaction not found");
    }],
  ])("retains a failed or uncertain payment without rebroadcast after %s", async (_case, arrange) => {
    arrange();
    const settle = payDemSettle(await rail(), { network: "demos" });

    const expected = {
      ok: false,
      txHash: TX_HASH,
      chainId: "demos",
      payer: "ab".repeat(32),
      payee: request.expectedPayee,
      ...(_case === "a failed record" ? {
        errorClass: "permanent", blockNumber: BLOCK, txRefKind: "demos",
        failureProof: { kind: "demos-failed-record", txHash: TX_HASH, nonce: NONCE,
          blockNumber: BLOCK, payer: "ab".repeat(32), payee: request.expectedPayee, amountOs: AMOUNT_OS },
      } : {}),
    };
    await expect(settle(request)).resolves.toEqual(expected);
    if (_case === "a failed record") {
      await expect(settle(request)).resolves.toEqual(expected);
    } else {
      await expect(settle(request)).rejects.toThrow(/refusing to resubmit/);
    }
    expect(sdk.transfer).toHaveBeenCalledTimes(1);
    expect(sdk.confirm).toHaveBeenCalledTimes(1);
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
  });

  // The process dies after the record read and before the outcome write lands.
  // The restart sees only the held intent in the durable log and must recover
  // read-only: a confirmed record settles, a failed one stays held, and neither
  // broadcasts again.
  it.each([
    ["a confirmed record", "confirmed"],
    ["a failed record", "failed"],
  ])("recovers %s read before death at the outcome write without rebroadcast", async (
    _case,
    status,
  ) => {
    sdk.getTxByHash.mockImplementation(recordReturning((record) => {
      record.status = status;
    }));
    let clock = 1_000_000;
    const log = createInMemorySettlementLog();
    const putOutcome = log.putOutcome.bind(log);
    let died = false;
    log.putOutcome = async (input) => {
      if (!died) {
        died = true;
        throw new Error("process died before the outcome write");
      }
      return putOutcome(input);
    };
    const options = { now: () => clock, leaseDurationMs: 1_000 };
    await expect(payDemSettle(await rail(), { network: "demos" }, {
      store: createIdempotencyStore(log, options),
    })(request)).rejects.toThrow(/process died/);
    expect(sdk.getTxByHash).toHaveBeenCalled();

    clock += 10_000;
    const proof = {
      kind: "demos-failed-record", txHash: TX_HASH, nonce: NONCE, blockNumber: BLOCK,
      payer: "ab".repeat(32), payee: PAYEE_HEX, amountOs: AMOUNT_OS,
    };
    const reconcile = vi.fn(async (context: PayDemSettlementRecoveryContext) => ({
      txHash: TX_HASH, chainId: context.network, payer: context.payer, payee: context.payee,
      blockNumber: BLOCK, txRefKind: "demos", amountOs: context.amountOs,
      ...(status === "confirmed"
        ? { ok: true, execution: "executed", finality: { model: "bft-final" } }
        : { ok: false, errorClass: "permanent", failureProof: proof }),
    }));
    const restarted = payDemSettle(await rail(), { network: "demos" }, {
      store: createIdempotencyStore(log, options),
      reconcile: reconcile as unknown as PayDemSettlementReconcile,
    });
    if (status === "confirmed") {
      await expect(restarted(request)).resolves.toMatchObject({
        ok: true, txHash: TX_HASH, blockNumber: BLOCK, finality: { model: "bft-final" },
      });
      await expect(restarted(request)).resolves.toMatchObject({ ok: true, txHash: TX_HASH });
    } else {
      await expect(restarted(request)).rejects.toThrow(/reconciliation was not definitive/);
      clock += 10_000;
      await expect(restarted(request)).rejects.toThrow(/reconciliation was not definitive/);
    }
    expect(sdk.transfer).toHaveBeenCalledTimes(1);
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
  });
});

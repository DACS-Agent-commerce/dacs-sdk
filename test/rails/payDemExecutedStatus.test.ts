import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPayDemRail,
  observeDemosExecutionByHash,
  payDemSettle,
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
    nonce: number;
    data: [string, { nativeOperation: string; args: [string, string] }];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface TransactionRecord extends BroadcastTransaction {
  status: string;
  blockNumber: unknown;
}

/** The node's record for the transaction that was actually broadcast. */
function broadcastRecord(): TransactionRecord {
  const validity = sdk.broadcast.mock.calls.at(-1)?.[0] as {
    response: { data: { transaction: BroadcastTransaction } };
  };
  return {
    ...structuredClone(validity.response.data.transaction),
    status: "confirmed",
    blockNumber: BLOCK,
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

  it("accepts the record's numeric post-fork amount projection bound by the payload", async () => {
    sdk.getTxByHash.mockImplementation(recordReturning((record) => {
      record.content.amount = Number(AMOUNT_OS);
    }));
    const payDem = await rail();

    await expect(
      payDem.settle({ recipient: RECIPIENT, amount: AMOUNT_OS }),
    ).resolves.toMatchObject({ ok: true, blockNumber: BLOCK });
  });

  it("does not report an included transfer whose record failed as ok", async () => {
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
    ).resolves.toEqual(NOT_OK);
    expect(sdk.getTxByHash).toHaveBeenCalledTimes(1);
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
    expect(sdk.waitForNonce).not.toHaveBeenCalled();
  });

  it.each([
    ["amount", (record: TransactionRecord) => {
      record.content.amount = "1000000000";
      record.content.data[1].args[1] = "1000000000";
    }],
    ["payee", (record: TransactionRecord) => {
      record.content.to = `0x${"ef".repeat(32)}`;
      record.content.data[1].args[0] = `0x${"ef".repeat(32)}`;
    }],
    ["nonce", (record: TransactionRecord) => {
      record.content.nonce = NONCE + 1;
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
        amount: AMOUNT_OS,
        nonce: NONCE,
        data: [
          "native",
          { nativeOperation: "send", args: [RECIPIENT, AMOUNT_OS] },
        ],
      },
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
        record.content.amount = "1";
        record.content.data[1].args[1] = "1";
        return record;
      }],
    ["a mismatched nonce", "transaction record does not bind the signed nonce",
      async () => {
        const record = executedRecord();
        record.content.nonce = NONCE + 1;
        return record;
      }],
    ["another inclusion block",
      "transaction record block does not match the observed inclusion",
      async () => ({ ...executedRecord(), blockNumber: BLOCK + 1 })],
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
    ["a mismatched record", () => {
      sdk.getTxByHash.mockImplementation(recordReturning((record) => {
        record.content.amount = "1";
        record.content.data[1].args[1] = "1";
      }));
    }],
    ["a stalled record read", () => {
      sdk.getTxByHash.mockImplementation(() => new Promise<never>(() => undefined));
    }],
    ["a malformed record", () => {
      sdk.getTxByHash.mockResolvedValue("Transaction not found");
    }],
  ])("keeps the settlement held after %s", async (_case, arrange) => {
    arrange();
    const settle = payDemSettle(await rail(), { network: "demos" });

    await expect(settle(request)).resolves.toEqual({
      ok: false,
      txHash: TX_HASH,
      chainId: "demos",
      payer: "ab".repeat(32),
      payee: request.expectedPayee,
    });
    await expect(settle(request)).rejects.toThrow(/refusing to resubmit/);
    expect(sdk.transfer).toHaveBeenCalledTimes(1);
    expect(sdk.confirm).toHaveBeenCalledTimes(1);
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
  });
});

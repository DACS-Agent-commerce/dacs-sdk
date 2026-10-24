import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPayDemRail,
  payDemSettle,
  type PayDemRail,
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
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as { params: [{ data: { hash: string } }] };
    const record = await sdk.getTxByHash(request.params[0].data.hash);
    return new Response(JSON.stringify({ result: 200, response: record }));
  }));
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

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

async function settle(payDem: PayDemRail) {
  const pending = payDem.settle({ recipient: RECIPIENT, amount: AMOUNT_OS });
  await vi.advanceTimersByTimeAsync(2_000);
  return pending;
}

describe("pay-dem reports ok only for an executed transfer (#338)", () => {
  it("settles through the bridge with the real factory execution authority", async () => {
    const payDem = await rail();
    const pending = payDemSettle(payDem)({
      rail: "pay-dem", phase: "pay-dem", amount: "9.5", asset: "DEM",
      payee: `did:demos:agent:${PAYEE_HEX}`, expectedPayee: RECIPIENT,
      jobId: "factory-bridge", phaseIndex: 0,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toMatchObject({ ok: true, txHash: TX_HASH, blockNumber: BLOCK });
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
  });

  it("settles an executed record that matches the prepared transfer", async () => {
    const payDem = await rail();

    await expect(
      settle(payDem),
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

  it("accepts a record that keeps the signed wire amount and numeric nonce", async () => {
    sdk.getTxByHash.mockImplementation(recordReturning((record) => {
      record.content.amount = AMOUNT_OS;
      record.content.nonce = NONCE;
      record.content.data[1].args[0] = RECIPIENT;
    }));
    const payDem = await rail();

    await expect(
      settle(payDem),
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
      settle(payDem),
    ).resolves.toEqual({
      ...NOT_OK, errorClass: "permanent", blockNumber: BLOCK, txRefKind: "demos",
      failureProof: { kind: "demos-failed-record", txHash: TX_HASH, nonce: NONCE,
        blockNumber: BLOCK, payer: "ab".repeat(32), payee: "cd".repeat(32), amountOs: AMOUNT_OS },
    });
    expect(sdk.getTxByHash).toHaveBeenCalledTimes(1);
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
    expect(sdk.waitForNonce).not.toHaveBeenCalled();
  });

  it("cancels an oversized streaming record before decoding it", async () => {
    const cancel = vi.fn();
    const fetchRecord = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(64 * 1024 + 1).fill(120)); },
      cancel,
    })));
    vi.stubGlobal("fetch", fetchRecord);
    const payDem = await rail();
    await expect(settle(payDem)).resolves.toEqual(NOT_OK);
    expect(fetchRecord).toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
    expect(sdk.waitForNonce).not.toHaveBeenCalled();
  });

  it("aborts a stalled body at the remaining record deadline", async () => {
    const cancel = vi.fn();
    let signal: AbortSignal | null | undefined;
    const fetchRecord = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: 200, response: null })))
      .mockImplementation(async (_url, init: RequestInit) => {
        signal = init.signal;
        return new Response(new ReadableStream({ cancel }));
      });
    vi.stubGlobal("fetch", fetchRecord);
    const payDem = await rail({ transactionRecordTimeoutMs: 30, inclusionPollIntervalMs: 10,
      statusRequestTimeoutMs: 1_000 });
    let outcome: unknown;
    const pending = payDem.settle({ recipient: RECIPIENT, amount: AMOUNT_OS })
      .then((value) => { outcome = value; });
    await vi.advanceTimersByTimeAsync(29);
    expect(outcome).toBeUndefined();
    expect(fetchRecord).toHaveBeenCalledTimes(2);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(outcome).toEqual(NOT_OK);
    expect(signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
  });

  it("does not report a failed record that does not bind the signed nonce as ok", async () => {
    sdk.getTxByHash.mockImplementation(recordReturning((record) => {
      record.status = "failed";
      delete (record.content as Record<string, unknown>).nonce;
    }));
    const payDem = await rail({ transactionRecordTimeoutMs: 1_000 });

    await expect(
      settle(payDem),
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
      settle(payDem),
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
      settle(payDem),
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
    ["a rejected read", async () => {
      throw new Error("socket hang up");
    }],
  ])("is indeterminate when the budget ends with %s", async (_case, read) => {
    sdk.getTxByHash.mockImplementation(read);
    const payDem = await rail();

    await expect(
      settle(payDem),
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
      settle(payDem),
    ).resolves.toMatchObject({ ok: true, txHash: TX_HASH, blockNumber: BLOCK });
    expect(sdk.getTxByHash).toHaveBeenCalledTimes(3);
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
  });

  it("ends a lagging record observation at the default 30 second deadline", async () => {
    sdk.getTxByHash.mockResolvedValue(null);
    const payDem = await createPayDemRail({ rpc: "https://node.test", secret: "test-secret" });
    let outcome: unknown;
    const pending = payDem.settle({ recipient: RECIPIENT, amount: AMOUNT_OS })
      .then((value) => { outcome = value; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(outcome).toBeUndefined();
    expect(sdk.getTxByHash).toHaveBeenCalledTimes(60);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(outcome).toEqual(NOT_OK);
    expect(sdk.getTxByHash).toHaveBeenCalledTimes(60);
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
  });

  it("does not read the record when the status index reports failed", async () => {
    // Current nodes never emit status `failed` (#338), but a status index that
    // does is never overridden by a confirmed record.
    sdk.nodeCall.mockResolvedValue({ state: "failed", blockNumber: BLOCK });
    const payDem = await rail();

    await expect(
      settle(payDem),
    ).resolves.toEqual(NOT_OK);
    expect(sdk.getTxByHash).not.toHaveBeenCalled();
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
  });
});

/** Serve `value()` after `ms` on the controlled clock. */
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
      settle(payDem),
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
      settle(payDem),
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
      settle(payDem),
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
      settle(payDem),
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
      settle(payDem),
    ).resolves.toEqual(NOT_OK);
    expect(statusReads()).toBe(5);
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
    const settleOnce = payDemSettle(await rail(), { network: "demos" });

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
    const first = settleOnce(request);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(first).resolves.toEqual(expected);
    if (_case === "a failed record") {
      await expect(settleOnce(request)).resolves.toEqual(expected);
    } else {
      await expect(settleOnce(request)).rejects.toThrow(/refusing to resubmit/);
    }
    expect(sdk.transfer).toHaveBeenCalledTimes(1);
    expect(sdk.confirm).toHaveBeenCalledTimes(1);
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
  });
});

// The factory authority is intentionally real in this suite.
describe("SDK record-verifying capability identity", () => {
  it.each(["copy", "prototype", "proxy"])("refuses a %s of a factory rail before claiming", async (kind) => {
    const original = await rail();
    const copied = kind === "copy" ? { ...original }
      : kind === "prototype" ? Object.create(original) : new Proxy(original, {});
    const once = vi.fn(async () => { throw new Error("must not claim"); });
    await expect(async () => payDemSettle(copied, {}, { store: { once } })({
      rail: "pay-dem", phase: "pay-dem", amount: "9.5", asset: "DEM",
      payee: `did:demos:agent:${PAYEE_HEX}`, expectedPayee: PAYEE_HEX,
      jobId: "copied-rail", phaseIndex: 0,
    })).rejects.toThrow(/SDK.*record-verifying|must be stable data/);
    expect(once).not.toHaveBeenCalled();
    expect(sdk.transfer).not.toHaveBeenCalled();
    expect(sdk.broadcast).not.toHaveBeenCalled();
  });

  it("freezes the factory capability and verified failed-record projection", async () => {
    const native = await rail();
    expect(Object.isFrozen(native)).toBe(true);
    expect(Reflect.set(native, "settle", vi.fn())).toBe(false);
    sdk.getTxByHash.mockImplementation(recordReturning((record) => { record.status = "failed"; }));
    const result = await settle(native);
    expect(result.errorClass).toBe("permanent");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.failureProof)).toBe(true);
  });
});

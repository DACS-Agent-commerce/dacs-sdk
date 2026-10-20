import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createIdempotencyStore,
  createInMemorySettlementLog,
  settlementKey,
} from "../../src/rails/idempotency.js";
import {
  createPayDemRecordReader,
  payDemRecordVerifiedTransfer,
  payDemSettle,
  payDemSettleCore,
  type DemosNativeClient,
  type DemosTransferResult,
  type PayDemRail,
  type PayDemRecordReader,
} from "../../src/rails/payDem.js";

// #338: a custom native client that the SDK did not build can still settle a
// debited transfer, but only on the SDK's own read of the node record. With a
// reader `createPayDemRecordReader` built, payDemSettleCore observes inclusion
// of the returned hash, reads the record and binds it itself; the client's own
// verdict is never used.

const PAYER_HEX = "ab".repeat(32);
const WALLET = `0x${PAYER_HEX}`;
const PAYEE_HEX = "cd".repeat(32);
const RECIPIENT = `0x${PAYEE_HEX}`;
const TX_HASH = "85".repeat(32);
const NONCE = 9;
const BLOCK = 480_877;
const AMOUNT_OS = "9500000000";

const sdk = vi.hoisted(() => ({
  connect: vi.fn(),
  getNetworkInfo: vi.fn(),
  getTxByHash: vi.fn(),
  nodeCall: vi.fn(),
}));

vi.mock("@kynesyslabs/demosdk/websdk", () => ({
  Demos: class MockDemos {
    readonly connect = sdk.connect;
    readonly getNetworkInfo = sdk.getNetworkInfo;
    readonly getTxByHash = sdk.getTxByHash;
    readonly nodeCall = sdk.nodeCall;
  },
}));

/** The node record for the transfer, in the shape node2 served it. */
function record(): Record<string, unknown> & { content: Record<string, unknown> } {
  return {
    hash: TX_HASH,
    status: "confirmed",
    blockNumber: BLOCK,
    content: {
      type: "native",
      from: PAYER_HEX,
      from_ed25519_address: PAYER_HEX,
      to: PAYEE_HEX,
      amount: Number(AMOUNT_OS),
      nonce: String(NONCE),
      data: ["native", { nativeOperation: "send", args: [PAYEE_HEX, AMOUNT_OS] }],
    },
  };
}

const FAST = {
  inclusionTimeoutMs: 40,
  inclusionPollIntervalMs: 1,
  statusRequestTimeoutMs: 5,
  transactionRecordTimeoutMs: 30,
};

async function reader(): Promise<PayDemRecordReader> {
  return createPayDemRecordReader({ rpc: "https://node.test", ...FAST });
}

/** A client the SDK did not build, returning `result` after `transfer`. */
function customClient(
  recordReader: PayDemRecordReader | undefined,
  result: Partial<DemosTransferResult> = {},
) {
  const transfer = vi.fn(async (): Promise<DemosTransferResult> => ({
    ok: true,
    state: "included",
    execution: "executed",
    hash: TX_HASH,
    nonce: NONCE,
    blockNumber: 1,
    totalDebitOs: "10500000000",
    ...result,
  }));
  const client: DemosNativeClient = {
    address: WALLET,
    ...(recordReader === undefined ? {} : { recordReader }),
    transfer,
  };
  return { client, transfer };
}

const HELD = {
  ok: false,
  txHash: TX_HASH,
  chainId: "demos",
  payer: WALLET,
  payee: RECIPIENT,
};

const SETTLED = {
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
};

beforeEach(() => {
  vi.clearAllMocks();
  sdk.connect.mockResolvedValue(true);
  sdk.getNetworkInfo.mockResolvedValue({
    forks: { osDenomination: { activated: true } },
  });
  sdk.nodeCall.mockResolvedValue({ state: "included", blockNumber: BLOCK });
  sdk.getTxByHash.mockImplementation(async () => record());
});

describe("a custom client settles only on the SDK's own record read (#338)", () => {
  it("settles a debited transfer whose bound record the SDK read as confirmed", async () => {
    const { client, transfer } = customClient(await reader());

    const result = await payDemSettleCore(
      { recipient: RECIPIENT, amount: AMOUNT_OS },
      client,
    );

    // The block is the one the SDK observed, not the client's 1. The fee is
    // the client's bounded accounting report.
    expect(result).toEqual(SETTLED);
    expect(Object.isFrozen(result)).toBe(true);
    expect(payDemRecordVerifiedTransfer(result)).toEqual({
      payer: PAYER_HEX,
      payee: PAYEE_HEX,
      amountOs: AMOUNT_OS,
      network: "demos",
    });
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(sdk.connect).toHaveBeenCalledWith("https://node.test");
    expect(sdk.nodeCall).toHaveBeenCalledWith("getTransactionStatus", { hash: TX_HASH });
    expect(sdk.getTxByHash).toHaveBeenCalledTimes(1);
    expect(sdk.getTxByHash).toHaveBeenCalledWith(TX_HASH);
  });

  it("settles on the SDK's read even when the client did not observe execution", async () => {
    const { client } = customClient(await reader(), {
      ok: false,
      state: "timeout",
      execution: undefined,
      blockNumber: undefined,
      totalDebitOs: undefined,
    });

    const { networkFeeOs: _fee, ...withoutFee } = SETTLED;
    await expect(payDemSettleCore(
      { recipient: RECIPIENT, amount: AMOUNT_OS },
      client,
    )).resolves.toEqual(withoutFee);
  });

  it("refuses a reader-carrying client's total debit above the ceiling before reading", async () => {
    const { client } = customClient(await reader(), { totalDebitOs: "20000000000" });

    await expect(payDemSettleCore(
      { recipient: RECIPIENT, amount: AMOUNT_OS, maxTotalDebitOs: "10500000000" },
      client,
    )).rejects.toThrow(/total debit/);
    expect(sdk.getTxByHash).not.toHaveBeenCalled();
  });

  it("reports a bound failed record as permanent with the SDK's own proof, whatever the client says", async () => {
    sdk.getTxByHash.mockImplementation(async () => ({ ...record(), status: "failed" }));
    const { client } = customClient(await reader());

    const result = await payDemSettleCore(
      { recipient: RECIPIENT, amount: AMOUNT_OS },
      client,
    );

    expect(result).toEqual({
      ...HELD,
      errorClass: "permanent",
      failureProof: {
        kind: "demos-failed-record",
        txHash: TX_HASH,
        nonce: NONCE,
        blockNumber: BLOCK,
        payer: PAYER_HEX,
        payee: PAYEE_HEX,
        amountOs: AMOUNT_OS,
      },
      blockNumber: BLOCK,
      txRefKind: "demos",
    });
    expect(result).not.toHaveProperty("finality");
    expect(payDemRecordVerifiedTransfer(result)).toBeUndefined();
  });

  it.each<[string, () => void, Partial<DemosTransferResult>]>([
    ["the record is for another amount", () => {
      sdk.getTxByHash.mockImplementation(async () => {
        const value = record();
        value.content.amount = 1;
        return value;
      });
    }, {}],
    ["the record is for another payee", () => {
      sdk.getTxByHash.mockImplementation(async () => {
        const value = record();
        value.content.to = "ef".repeat(32);
        return value;
      });
    }, {}],
    ["the record is at another block than the observed inclusion", () => {
      sdk.getTxByHash.mockImplementation(async () => ({ ...record(), blockNumber: BLOCK + 1 }));
    }, {}],
    ["the record does not bind the nonce the client signed", () => undefined, { nonce: NONCE + 1 }],
    ["the client returns no signed nonce", () => undefined, { nonce: undefined }],
    ["the record has no terminal status", () => {
      sdk.getTxByHash.mockImplementation(async () => ({ ...record(), status: "pending" }));
    }, {}],
    ["the status index never reports inclusion", () => {
      sdk.nodeCall.mockResolvedValue({ state: "unknown" });
    }, {}],
    ["the status index alone reports failed", () => {
      sdk.nodeCall.mockResolvedValue({ state: "failed", blockNumber: BLOCK });
    }, {}],
    ["the fork state is unavailable", () => {
      sdk.getNetworkInfo.mockResolvedValue({});
    }, {}],
  ])("holds the result with its hash when %s", async (_label, arrange, result) => {
    arrange();
    const { client, transfer } = customClient(await reader(), result);

    const settled = await payDemSettleCore(
      { recipient: RECIPIENT, amount: AMOUNT_OS },
      client,
    );

    expect(settled).toEqual(HELD);
    expect(payDemRecordVerifiedTransfer(settled)).toBeUndefined();
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  it("reads nothing when the client returns no signed nonce", async () => {
    const { client } = customClient(await reader(), { nonce: undefined });

    await expect(payDemSettleCore(
      { recipient: RECIPIENT, amount: AMOUNT_OS },
      client,
    )).resolves.toEqual(HELD);
    expect(sdk.nodeCall).not.toHaveBeenCalled();
    expect(sdk.getTxByHash).not.toHaveBeenCalled();
  });

  it("keeps a client without a reader held, as before", async () => {
    const { client } = customClient(undefined);

    await expect(payDemSettleCore(
      { recipient: RECIPIENT, amount: AMOUNT_OS },
      client,
    )).resolves.toEqual(HELD);
    expect(sdk.getTxByHash).not.toHaveBeenCalled();
  });

  it.each<[string, () => unknown]>([
    ["a look-alike object", () => Object.freeze({ rpc: "https://node.test" })],
    ["a copy of an SDK reader", async () => ({ ...(await reader()) })],
    ["a non-object", () => "https://node.test"],
  ])("refuses %s as a reader before the transfer", async (_label, make) => {
    const forged = await make();
    const { client, transfer } = customClient(forged as unknown as PayDemRecordReader);

    await expect(payDemSettleCore(
      { recipient: RECIPIENT, amount: AMOUNT_OS },
      client,
    )).rejects.toThrow(/createPayDemRecordReader/);
    expect(transfer).not.toHaveBeenCalled();
  });

  it("bounds the connect and keeps the node's error as the cause", async () => {
    sdk.connect.mockImplementation(() => new Promise(() => undefined));
    await expect(reader()).rejects.toThrow(/did not answer in time/);

    const refused = new Error("ECONNREFUSED");
    sdk.connect.mockRejectedValue(refused);
    await expect(reader()).rejects.toMatchObject({ cause: refused });
  });
});

describe("payDemSettle accepts a custom rail's SDK record-verified success (#338)", () => {
  const request = (jobId: string) => ({
    rail: "pay-dem",
    phase: "pay-dem" as const,
    amount: "9.5",
    asset: "DEM",
    payee: `did:demos:agent:${PAYEE_HEX}`,
    expectedPayee: PAYEE_HEX,
    jobId,
    phaseIndex: 0,
  });

  it("settles and records the success of a rail built on a reader-carrying client", async () => {
    const { client, transfer } = customClient(await reader());
    const rail: PayDemRail = {
      address: WALLET,
      settle: (params) => payDemSettleCore(params, client),
    };
    const log = createInMemorySettlementLog();
    const settle = payDemSettle(rail, {}, { store: createIdempotencyStore(log) });

    const first = await settle(request("job-a"));
    expect(first).toMatchObject({
      ok: true,
      txHash: TX_HASH,
      finality: { model: "bft-final" },
      blockNumber: BLOCK,
      txRefKind: "demos",
    });
    await expect(settle(request("job-a"))).resolves.toEqual(first);
    expect(transfer).toHaveBeenCalledTimes(1);
    const outcome = await log.readOutcome!(settlementKey("pay-dem", "job-a", 0));
    expect(outcome?.result).toMatchObject({ ok: true, txHash: TX_HASH, blockNumber: BLOCK });
  });

  it("holds an SDK-verified success minted for another settlement key", async () => {
    const { client } = customClient(await reader());
    const other = await payDemSettleCore({
      recipient: PAYEE_HEX,
      amount: AMOUNT_OS,
      recovery: {
        railId: "pay-dem",
        jobId: "job-a",
        phaseIndex: 0,
        settlementKey: settlementKey("pay-dem", "job-a", 0),
        network: "demos",
        payer: PAYER_HEX,
        payee: PAYEE_HEX,
        amountOs: AMOUNT_OS,
      },
    }, client);
    expect(payDemRecordVerifiedTransfer(other)?.settlementKey)
      .toBe(settlementKey("pay-dem", "job-a", 0));
    const rail: PayDemRail = { address: WALLET, settle: async () => other };

    const result = await payDemSettle(rail)(request("job-b"));

    expect(result).toMatchObject({ ok: false, txHash: TX_HASH });
    expect(result).not.toHaveProperty("finality");
  });

  it("holds a copy of an SDK-verified success", async () => {
    const { client } = customClient(await reader());
    const rail: PayDemRail = {
      address: WALLET,
      settle: async (params) => ({ ...(await payDemSettleCore(params, client)) }),
    };

    const result = await payDemSettle(rail)(request("job-copy"));

    expect(result).toMatchObject({ ok: false, txHash: TX_HASH });
    expect(result).not.toHaveProperty("finality");
  });

  it("keeps a custom rail's failure held rather than definitive", async () => {
    sdk.getTxByHash.mockImplementation(async () => ({ ...record(), status: "failed" }));
    const { client, transfer } = customClient(await reader());
    const rail: PayDemRail = {
      address: WALLET,
      settle: (params) => payDemSettleCore(params, client),
    };
    const settle = payDemSettle(rail);

    await expect(settle(request("job-failed"))).resolves.toEqual({
      ...HELD,
      payer: PAYER_HEX,
      payee: PAYEE_HEX,
    });
    await expect(settle(request("job-failed"))).rejects.toThrow(/refusing to resubmit/);
    expect(transfer).toHaveBeenCalledTimes(1);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createIdempotencyStore,
  createInMemorySettlementLog,
  settlementKey,
} from "../../src/rails/idempotency.js";
import {
  createPayDemClientRail,
  createPayDemRecordReader,
  payDemRecordVerifiedTransfer,
  payDemSettle,
  payDemSettleCore,
  type DemosNativeClient,
  type DemosTransferResult,
  type PayDemPreparedTransfer,
  type PayDemRail,
  type PayDemReconciledSettlement,
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
/** Each test's transfer hash, set in `beforeEach`. */
let TX_HASH = "85".repeat(32);
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

/**
 * When the transfer was signed, in ms, as its signed `content.timestamp`
 * records it. Unset, it is the time of the read, so after the call began.
 */
let signedAtMs: number | undefined;

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
      // node2 serves the signed timestamp as a decimal string.
      timestamp: String(signedAtMs ?? Date.now()),
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

/** The prepared transfer a client journals before its one broadcast. */
function prepared(
  over: Partial<PayDemPreparedTransfer> = {},
): PayDemPreparedTransfer {
  return {
    txHash: TX_HASH,
    nonce: NONCE,
    payer: PAYER_HEX,
    payee: PAYEE_HEX,
    amountOs: AMOUNT_OS,
    denomination: "os",
    network: "demos",
    ...over,
  };
}

type TransferArgs = Parameters<DemosNativeClient["transfer"]>[0];

/**
 * A client the SDK did not build: it journals its prepared transfer through
 * the journal the SDK hands it (unless `journal` says otherwise), then
 * returns `result`.
 */
function customClient(
  recordReader: PayDemRecordReader | undefined,
  result: Partial<DemosTransferResult> = {},
  journal: (args: TransferArgs) => Promise<void> = async (args) => {
    await args.journalPreparedTransfer?.(prepared(
      args.recovery === undefined ? {} : { recovery: args.recovery },
    ));
  },
) {
  const transfer = vi.fn(async (args: TransferArgs): Promise<DemosTransferResult> => {
    await journal(args);
    return {
      ok: true,
      state: "included",
      execution: "executed",
      hash: TX_HASH,
      nonce: NONCE,
      blockNumber: 1,
      totalDebitOs: "10500000000",
      ...result,
    };
  });
  const client: DemosNativeClient = {
    address: WALLET,
    ...(recordReader === undefined ? {} : { recordReader }),
    transfer,
  };
  return { client, transfer };
}

const held = () => ({
  ok: false,
  txHash: TX_HASH,
  chainId: "demos",
  payer: WALLET,
  payee: RECIPIENT,
});

const settled = () => ({
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

/** What the node's status index answers for the hash. */
let status: unknown;
/** What the node answers for the payer's account nonce. */
let accountNonce: unknown;
let transfers = 0;

beforeEach(() => {
  vi.clearAllMocks();
  // The SDK settles one transaction hash once per process, so each test's
  // transfer has its own hash.
  transfers += 1;
  TX_HASH = `${String(transfers).padStart(4, "0")}${"85".repeat(30)}`;
  signedAtMs = undefined;
  sdk.connect.mockResolvedValue(true);
  sdk.getNetworkInfo.mockResolvedValue({
    forks: { osDenomination: { activated: true } },
  });
  status = { state: "included", blockNumber: BLOCK };
  // demosdk signs with the account nonce + 1: before this call the payer had
  // used NONCE - 1, so the transfer the client signs now carries NONCE.
  accountNonce = NONCE - 1;
  sdk.nodeCall.mockImplementation(async (message: string) =>
    message === "getAddressNonce" ? accountNonce : status);
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
    expect(result).toEqual(settled());
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

    const { networkFeeOs: _fee, ...withoutFee } = settled();
    await expect(payDemSettleCore(
      { recipient: RECIPIENT, amount: AMOUNT_OS },
      client,
    )).resolves.toEqual(withoutFee);
  });

  it("refuses a reader-carrying client's total debit above the ceiling before reading", async () => {
    const { client } = customClient(await reader(), { totalDebitOs: "20000000000" }, async (args) => {
      await args.journalPreparedTransfer!(prepared({ confirmedTotalDebitOs: "10500000000" }));
    });

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
      ...held(),
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
      status = { state: "unknown" };
    }, {}],
    ["the status index alone reports failed", () => {
      status = { state: "failed", blockNumber: BLOCK };
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

    expect(settled).toEqual(held());
    expect(payDemRecordVerifiedTransfer(settled)).toBeUndefined();
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  // Every payer field the record carries must name the payer, and it must
  // carry at least one (docs/pay-dem-execution.md).
  it.each<[string, (content: Record<string, unknown>) => void]>([
    ["only `from` names another payer", (content) => { content.from = "ef".repeat(32); }],
    ["only `from_ed25519_address` names another payer", (content) => {
      content.from_ed25519_address = "ef".repeat(32);
    }],
    ["the record names no payer", (content) => {
      delete content.from;
      delete content.from_ed25519_address;
    }],
  ])("holds the result after one record read when %s", async (_label, change) => {
    sdk.getTxByHash.mockImplementation(async () => {
      const value = record();
      change(value.content);
      return value;
    });
    const { client, transfer } = customClient(await reader());

    const settled = await payDemSettleCore(
      { recipient: RECIPIENT, amount: AMOUNT_OS },
      client,
    );

    expect(settled).toEqual(held());
    expect(sdk.getTxByHash).toHaveBeenCalledTimes(1);
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  it("settles a record that names the payer in only one of its payer fields", async () => {
    sdk.getTxByHash.mockImplementation(async () => {
      const value = record();
      delete value.content.from_ed25519_address;
      return value;
    });
    const { client } = customClient(await reader());

    await expect(payDemSettleCore(
      { recipient: RECIPIENT, amount: AMOUNT_OS },
      client,
    )).resolves.toEqual(settled());
  });

  it("reads nothing when the client returns no signed nonce", async () => {
    const { client } = customClient(await reader(), { nonce: undefined });

    await expect(payDemSettleCore(
      { recipient: RECIPIENT, amount: AMOUNT_OS },
      client,
    )).resolves.toEqual(held());
    expect(sdk.nodeCall).not.toHaveBeenCalledWith("getTransactionStatus", expect.anything());
    expect(sdk.getTxByHash).not.toHaveBeenCalled();
  });

  it("refuses a client without a reader before its transfer runs", async () => {
    const { client, transfer } = customClient(undefined);

    await expect(payDemSettleCore(
      { recipient: RECIPIENT, amount: AMOUNT_OS },
      client,
    )).rejects.toThrow(/createPayDemRecordReader.*refusing transfer/);
    expect(transfer).not.toHaveBeenCalled();
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

describe("a reader-carrying client's transfer must be this call's own (#338)", () => {
  it("holds a confirmed transfer the payer had already made before this call", async () => {
    // The node already counts NONCE as used: the client hands back an earlier,
    // genuinely confirmed transfer with the same payer, payee and amount.
    accountNonce = NONCE;
    const { client, transfer } = customClient(await reader());

    const result = await payDemSettleCore(
      { recipient: RECIPIENT, amount: AMOUNT_OS },
      client,
    );

    expect(result).toEqual(held());
    expect(payDemRecordVerifiedTransfer(result)).toBeUndefined();
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(sdk.nodeCall).toHaveBeenCalledWith("getAddressNonce", { address: WALLET });
    expect(sdk.getTxByHash).not.toHaveBeenCalled();
  });

  it("reads the payer's account nonce before the transfer", async () => {
    const order: string[] = [];
    sdk.nodeCall.mockImplementation(async (message: string) => {
      order.push(message);
      return message === "getAddressNonce" ? String(NONCE - 1) : status;
    });
    const { client } = customClient(await reader(), {}, async (args) => {
      order.push("transfer");
      await args.journalPreparedTransfer?.(prepared());
    });

    await expect(payDemSettleCore(
      { recipient: RECIPIENT, amount: AMOUNT_OS },
      client,
    )).resolves.toEqual(settled());
    expect(order.slice(0, 2)).toEqual(["getAddressNonce", "transfer"]);
  });

  it.each<[string, () => void, RegExp]>([
    ["the read times out", () => {
      sdk.nodeCall.mockImplementation((message: string) =>
        message === "getAddressNonce" ? new Promise(() => undefined) : status);
    }, /account nonce read timed out/],
    ["the node refuses the read", () => {
      sdk.nodeCall.mockImplementation(async (message: string) => {
        if (message === "getAddressNonce") throw new Error("ECONNREFUSED");
        return status;
      });
    }, /could not read the payer's account nonce/],
    ["the reply is not a nonce", () => {
      accountNonce = "4 apples";
    }, /account nonce is malformed/],
    ["the reply is negative", () => {
      accountNonce = -1;
    }, /account nonce is malformed/],
  ])("refuses before the transfer when %s", async (_label, arrange, message) => {
    arrange();
    const { client, transfer } = customClient(await reader());

    await expect(payDemSettleCore(
      { recipient: RECIPIENT, amount: AMOUNT_OS },
      client,
    )).rejects.toThrow(message);
    expect(transfer).not.toHaveBeenCalled();
  });

  it("keeps the node's error as the cause of a refused account nonce read", async () => {
    const refused = new Error("ECONNREFUSED");
    sdk.nodeCall.mockImplementation(async (message: string) => {
      if (message === "getAddressNonce") throw refused;
      return status;
    });
    const { client } = customClient(await reader());

    await expect(payDemSettleCore(
      { recipient: RECIPIENT, amount: AMOUNT_OS },
      client,
    )).rejects.toMatchObject({ cause: refused });
  });

  it.each<[string, (args: TransferArgs) => Promise<void>]>([
    ["journals nothing", async () => undefined],
    ["journals another hash", async (args) => {
      await args.journalPreparedTransfer?.(prepared({ txHash: "86".repeat(32) }));
    }],
    ["journals another nonce", async (args) => {
      await args.journalPreparedTransfer?.(prepared({ nonce: NONCE + 1 }));
    }],
  ])("holds the result, reading nothing, when the client %s", async (_label, journal) => {
    const { client } = customClient(await reader(), {}, journal);

    const result = await payDemSettleCore(
      { recipient: RECIPIENT, amount: AMOUNT_OS },
      client,
    );

    expect(result).toEqual(held());
    expect(payDemRecordVerifiedTransfer(result)).toBeUndefined();
    expect(sdk.getTxByHash).not.toHaveBeenCalled();
  });

  it("refuses a second journal entry and holds the result", async () => {
    const second = vi.fn();
    const { client } = customClient(await reader(), {}, async (args) => {
      await args.journalPreparedTransfer?.(prepared());
      await args.journalPreparedTransfer?.(prepared()).catch(second);
    });

    await expect(payDemSettleCore(
      { recipient: RECIPIENT, amount: AMOUNT_OS },
      client,
    )).resolves.toEqual(held());
    expect(second).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringMatching(/more than once/),
    }));
  });

  it.each<[string, Partial<PayDemPreparedTransfer>]>([
    ["another payer", { payer: "ef".repeat(32) }],
    ["another payee", { payee: "ef".repeat(32) }],
    ["another amount", { amountOs: "1" }],
    ["a malformed hash", { txHash: "not-a-hash" }],
    ["a malformed nonce", { nonce: -1 }],
  ])("refuses a journal entry for %s, so the client must not broadcast", async (_label, over) => {
    const refused = vi.fn();
    const { client } = customClient(await reader(), {}, async (args) => {
      await args.journalPreparedTransfer?.(prepared(over)).catch(refused);
    });

    await expect(payDemSettleCore(
      { recipient: RECIPIENT, amount: AMOUNT_OS },
      client,
    )).resolves.toEqual(held());
    expect(refused).toHaveBeenCalledTimes(1);
    expect(sdk.getTxByHash).not.toHaveBeenCalled();
  });

  it("hands the entry to the caller's journal and holds when that journal fails", async () => {
    const journaled: unknown[] = [];
    const { client } = customClient(await reader());

    await expect(payDemSettleCore({
      recipient: RECIPIENT,
      amount: AMOUNT_OS,
      journalPreparedTransfer: async (entry) => { journaled.push(entry); },
    }, client)).resolves.toEqual(settled());
    expect(journaled).toEqual([prepared()]);

    const failing = customClient(await reader(), {}, async (args) => {
      await args.journalPreparedTransfer?.(prepared()).catch(() => undefined);
    });
    await expect(payDemSettleCore({
      recipient: RECIPIENT,
      amount: AMOUNT_OS,
      journalPreparedTransfer: async () => { throw new Error("disk full"); },
    }, failing.client)).resolves.toEqual(held());
  });

  it("refuses a journal entry made after the transfer returned", async () => {
    let late: TransferArgs["journalPreparedTransfer"];
    const { client } = customClient(await reader(), {}, async (args) => {
      await args.journalPreparedTransfer?.(prepared());
      late = args.journalPreparedTransfer;
    });

    await expect(payDemSettleCore(
      { recipient: RECIPIENT, amount: AMOUNT_OS },
      client,
    )).resolves.toEqual(settled());
    await expect(late!(prepared())).rejects.toThrow(/after the transfer returned/);
  });

  it("never settles one transfer twice in a process", async () => {
    const first = customClient(await reader());
    await expect(payDemSettleCore(
      { recipient: RECIPIENT, amount: AMOUNT_OS },
      first.client,
    )).resolves.toEqual(settled());

    // The account nonce can lag inclusion, so the floor alone would admit the
    // same transfer again; the SDK still does not mint a second success.
    const second = customClient(await reader());
    const again = await payDemSettleCore(
      { recipient: RECIPIENT, amount: AMOUNT_OS },
      second.client,
    );

    expect(again).toEqual(held());
    expect(payDemRecordVerifiedTransfer(again)).toBeUndefined();
  });

  // Both calls pass the check before the record read; only the check after
  // it stops the second success.
  it("mints a success for at most one of two overlapping calls presenting one transfer", async () => {
    const a = customClient(await reader());
    const b = customClient(await reader());

    const results = await Promise.all([
      payDemSettleCore({ recipient: RECIPIENT, amount: AMOUNT_OS }, a.client),
      payDemSettleCore({ recipient: RECIPIENT, amount: AMOUNT_OS }, b.client),
    ]);

    expect(results.filter((result) => result.ok === true)).toHaveLength(1);
    expect(results.filter((result) => payDemRecordVerifiedTransfer(result) !== undefined))
      .toHaveLength(1);
    expect(results).toContainEqual(held());
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
  /** The same payment after a restart, with the session's retained hash. */
  const retained = (jobId: string) => ({
    ...request(jobId),
    priorAttempts: [{ txHash: TX_HASH, chainId: "demos", ok: false }],
  });
  /** A reconciler that finds the hash executed: it says nothing about the key. */
  const reconciled = () => vi.fn(async () =>
    ({ ...settled(), payer: PAYER_HEX, payee: PAYEE_HEX, amountOs: AMOUNT_OS }) as PayDemReconciledSettlement);

  it("settles and records the success of a rail built on a reader-carrying client", async () => {
    const { client, transfer } = customClient(await reader());
    const rail = createPayDemClientRail(client);
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

  // F1 (#369 review): a client that hands job-2 the genuine, confirmed
  // transfer it made for job-1 (a signer caching requests by their terms)
  // must not settle job-2 as well.
  it("holds job-2 presenting job-1's genuine transfer and does not persist it", async () => {
    const { client, transfer } = customClient(await reader());
    const log = createInMemorySettlementLog();
    const putOutcome = vi.spyOn(log, "putOutcome");
    const settle = payDemSettle(createPayDemClientRail(client), {}, {
      store: createIdempotencyStore(log),
    });

    await expect(settle(request("job-1"))).resolves.toMatchObject({
      ok: true,
      txHash: TX_HASH,
    });
    // After job-1 the payer's account counts NONCE as used.
    accountNonce = NONCE;
    const second = await settle(request("job-2"));

    expect(second).toEqual({ ...held(), payer: PAYER_HEX, payee: PAYEE_HEX });
    expect(second).not.toHaveProperty("finality");
    expect(transfer).toHaveBeenCalledTimes(2);
    expect(putOutcome).toHaveBeenCalledTimes(1);
    await expect(log.readOutcome!(settlementKey("pay-dem", "job-2", 0)))
      .resolves.toBeNull();
    await expect(settle(request("job-2"))).rejects.toThrow(/refusing to resubmit/);
  });

  // The attempt record says this key's own effect signed the hash. job-1's
  // transfer relayed for job-2 is held, and a restart audit of job-2 must not
  // bind it through a record either.
  it("never records job-1's relayed transfer as job-2's attempt", async () => {
    const { client } = customClient(await reader());
    const log = createInMemorySettlementLog();
    const settle = payDemSettle(createPayDemClientRail(client), {}, { store: createIdempotencyStore(log) });
    await expect(settle(request("job-1"))).resolves.toMatchObject({ ok: true, txHash: TX_HASH });
    accountNonce = NONCE;
    await expect(settle(request("job-2"))).resolves.toMatchObject({ ok: false, txHash: TX_HASH });

    const reconcile = vi.fn(async () =>
      ({ ...settled(), payer: PAYER_HEX, payee: PAYEE_HEX, amountOs: AMOUNT_OS }) as PayDemReconciledSettlement);
    const restarted = payDemSettle(createPayDemClientRail(client), {}, {
      store: createIdempotencyStore(log), reconcile,
    });
    await expect(restarted({ ...request("job-2"), priorAttempts: [{ txHash: TX_HASH, chainId: "demos", ok: false }] }))
      .rejects.toThrow(/no SDK record binds the retained transaction/);
    await expect(log.readAttempt!(settlementKey("pay-dem", "job-2", 0))).resolves.toBeNull();
  });

  // A client's journal entry is its own statement: the SDK cannot tell there
  // whether this call signed the transfer. Only the SDK's own read of the
  // record makes it this payment's, so a process that dies before that read
  // leaves no record, and a restart audit refuses rather than binds the hash.
  it("records no client transfer the SDK has not read yet, so a restart audit refuses rather than binds it", async () => {
    const { client, transfer } = customClient(await reader(), {}, async (args) => {
      await args.journalPreparedTransfer?.(prepared(args.recovery === undefined ? {} : { recovery: args.recovery }));
      await new Promise<never>(() => undefined);
    });
    const log = createInMemorySettlementLog();
    void payDemSettle(createPayDemClientRail(client), {}, { store: createIdempotencyStore(log) })(request("job-a"));
    await vi.waitFor(() => expect(transfer).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(log.readAttempt!(settlementKey("pay-dem", "job-a", 0))).resolves.toBeNull();

    const restarted = payDemSettle(createPayDemClientRail(customClient(await reader()).client), {}, {
      store: createIdempotencyStore(log), reconcile: reconciled(),
    });
    await expect(restarted(retained("job-a"))).rejects.toThrow(/no SDK record binds the retained transaction/);
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  it("records a client's own transfer once the SDK's read made it this payment's success, so a restart after a lost outcome binds it", async () => {
    const { client, transfer } = customClient(await reader());
    const memory = createInMemorySettlementLog();
    // The process dies while it saves the outcome.
    const log = { ...memory, putOutcome: () => new Promise<never>(() => undefined) };
    void payDemSettle(createPayDemClientRail(client), {}, { store: createIdempotencyStore(log) })(request("job-a"));
    await vi.waitFor(async () =>
      expect(await memory.readAttempt!(settlementKey("pay-dem", "job-a", 0))).toMatchObject({ txHash: TX_HASH }));

    const restarted = payDemSettle(createPayDemClientRail(customClient(await reader()).client), {}, {
      store: createIdempotencyStore(memory), reconcile: reconciled(),
    });
    await expect(restarted(retained("job-a"))).resolves.toMatchObject({ ok: true, txHash: TX_HASH });
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  // Daybreak F3 (#370 sweep): two payments in flight at once that a client
  // hands one transfer. The SDK settles at most one; only that one's record
  // names the hash, so a restart never reports the other paid with it.
  it("records one transfer handed to two overlapping payments as at most one key's attempt", async () => {
    let journals = 0;
    let bothJournaled!: () => void;
    const gate = new Promise<void>((resolve) => { bothJournaled = resolve; });
    const { client } = customClient(await reader(), {}, async (args) => {
      await args.journalPreparedTransfer?.(prepared(args.recovery === undefined ? {} : { recovery: args.recovery }));
      journals += 1;
      if (journals === 2) bothJournaled();
      await gate;
    });
    const log = createInMemorySettlementLog();
    const settle = payDemSettle(createPayDemClientRail(client), {}, { store: createIdempotencyStore(log) });

    const results = await Promise.all([settle(request("job-1")), settle(request("job-2"))]);

    const paid = results.findIndex((result) => result.ok);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const jobs = ["job-1", "job-2"] as const;
    await expect(log.readAttempt!(settlementKey("pay-dem", jobs[paid]!, 0)))
      .resolves.toMatchObject({ txHash: TX_HASH });
    const heldJob = jobs[1 - paid]!;
    await expect(log.readAttempt!(settlementKey("pay-dem", heldJob, 0))).resolves.toBeNull();
    const restarted = payDemSettle(createPayDemClientRail(client), {}, {
      store: createIdempotencyStore(log), reconcile: reconciled(),
    });
    await expect(restarted(retained(heldJob))).rejects.toThrow(/no SDK record binds the retained transaction/);
  });

  // Code F2 (#370 sweep): job-1's transfer is still pending (its record cannot
  // be read yet, so this process has not settled it) and the account nonce
  // lags, so neither process-local check stops a relay to job-2.
  it("never records another payment's still-pending transfer as this one's attempt", async () => {
    const { client } = customClient(await reader(), {}, async (args) => {
      signedAtMs ??= Date.now();
      await args.journalPreparedTransfer?.(prepared(args.recovery === undefined ? {} : { recovery: args.recovery }));
    });
    sdk.getTxByHash.mockImplementation(async () => null);
    const log = createInMemorySettlementLog();
    const settle = payDemSettle(createPayDemClientRail(client), {}, { store: createIdempotencyStore(log) });
    await expect(settle(request("job-1"))).resolves.toMatchObject({ ok: false, txHash: TX_HASH });

    await new Promise((resolve) => setTimeout(resolve, 5));
    sdk.getTxByHash.mockImplementation(async () => record());
    await expect(settle(request("job-2"))).resolves.toEqual({ ...held(), payer: PAYER_HEX, payee: PAYEE_HEX });

    await expect(log.readAttempt!(settlementKey("pay-dem", "job-2", 0))).resolves.toBeNull();
    const restarted = payDemSettle(createPayDemClientRail(client), {}, {
      store: createIdempotencyStore(log), reconcile: reconciled(),
    });
    await expect(restarted(retained("job-2"))).rejects.toThrow(/no SDK record binds the retained transaction/);
  });

  // Code F1 (#370 sweep): job-1 settled in this process and the account nonce
  // still lags. job-2's relay is neither recorded nor bound by an audit
  // through the same bridge.
  it("never records or binds job-1's settled transfer for job-2 while the account nonce lags", async () => {
    const { client } = customClient(await reader());
    const log = createInMemorySettlementLog();
    const settle = payDemSettle(createPayDemClientRail(client), {}, {
      store: createIdempotencyStore(log), reconcile: reconciled(),
    });
    await expect(settle(request("job-1"))).resolves.toMatchObject({ ok: true, txHash: TX_HASH });
    await expect(settle(request("job-2"))).resolves.toMatchObject({ ok: false, txHash: TX_HASH });

    await expect(log.readAttempt!(settlementKey("pay-dem", "job-2", 0))).resolves.toBeNull();
    await expect(settle(retained("job-2"))).rejects.toThrow(/no SDK record binds the retained transaction/);
  });

  // A reader-carrying client gets the store's fence without its recorder: it
  // could otherwise write any hash, such as job-1's, as job-2's attempt.
  it("hands a reader-carrying client no attempt recorder, so it cannot write job-2's record", async () => {
    const recorders: unknown[] = [];
    const { client } = customClient(await reader(), {}, async (args) => {
      recorders.push(args.effectFence?.recordAttempt);
      await args.effectFence?.recordAttempt?.(TX_HASH);
      await args.journalPreparedTransfer?.(prepared(args.recovery === undefined ? {} : { recovery: args.recovery }));
    });
    const log = createInMemorySettlementLog();
    const settle = payDemSettle(createPayDemClientRail(client), {}, { store: createIdempotencyStore(log) });
    await expect(settle(request("job-1"))).resolves.toMatchObject({ ok: true, txHash: TX_HASH });
    accountNonce = NONCE;
    await expect(settle(request("job-2"))).resolves.toMatchObject({ ok: false, txHash: TX_HASH });

    expect(recorders).toEqual([undefined, undefined]);
    await expect(log.readAttempt!(settlementKey("pay-dem", "job-2", 0))).resolves.toBeNull();
    const restarted = payDemSettle(createPayDemClientRail(client), {}, {
      store: createIdempotencyStore(log), reconcile: reconciled(),
    });
    await expect(restarted(retained("job-2"))).rejects.toThrow(/no SDK record binds the retained transaction/);
  });

  it("holds job-2 presenting job-1's genuine transfer even before the account nonce shows it", async () => {
    const { client } = customClient(await reader());
    const settle = payDemSettle(createPayDemClientRail(client));

    await expect(settle(request("job-1"))).resolves.toMatchObject({ ok: true });
    // The node's account nonce lags: the floor alone would admit it.
    await expect(settle(request("job-2"))).resolves.toEqual({
      ...held(),
      payer: PAYER_HEX,
      payee: PAYEE_HEX,
    });
  });

  it.each<[string, () => Promise<PayDemRail>]>([
    ["relaying a success minted for another settlement key", async () => {
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
      return { address: WALLET, settle: async () => other };
    }],
    ["copying an SDK-verified success", async () => {
      const { client } = customClient(await reader());
      return {
        address: WALLET,
        settle: async (params) => ({ ...(await payDemSettleCore(params, client)) }),
      };
    }],
    ["around a reader-carrying client it built itself", async () => {
      const { client } = customClient(await reader());
      return { address: WALLET, settle: (params) => payDemSettleCore(params, client) };
    }],
  ])("refuses a custom rail %s before it runs", async (_label, build) => {
    const rail = await build();
    const settle = vi.spyOn(rail, "settle");

    await expect(payDemSettle(rail)(request("job-custom")))
      .rejects.toThrow(/createPayDemClientRail.*refusing/);
    expect(settle).not.toHaveBeenCalled();
  });

  it("keeps a client rail's failure held rather than definitive", async () => {
    sdk.getTxByHash.mockImplementation(async () => ({ ...record(), status: "failed" }));
    const { client, transfer } = customClient(await reader());
    const settle = payDemSettle(createPayDemClientRail(client));

    await expect(settle(request("job-failed"))).resolves.toEqual({
      ...held(),
      payer: PAYER_HEX,
      payee: PAYEE_HEX,
    });
    await expect(settle(request("job-failed"))).rejects.toThrow(/refusing to resubmit/);
    expect(transfer).toHaveBeenCalledTimes(1);
  });
});

// P1-1 (#369 review): the process-local hash set and a lagging account nonce
// cannot stop a transfer that executed before a restart from settling another
// job. The record's signed timestamp can: it is in the signed bytes.
describe("a transfer signed before this call never settles it, across a restart (#369)", () => {
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
  /** A client that signs now: the record carries this signing time. */
  const signingClient = (recordReader: PayDemRecordReader) => customClient(
    recordReader,
    {},
    async (args) => {
      signedAtMs = Date.now();
      await args.journalPreparedTransfer?.(prepared(
        args.recovery === undefined ? {} : { recovery: args.recovery },
      ));
    },
  );
  /** A fresh copy of the rails modules: what a restarted process loads. */
  const restart = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    vi.resetModules();
    const idempotency = await import("../../src/rails/idempotency.js");
    return Object.assign(await import("../../src/rails/payDem.js"), {
      createIdempotencyStore: idempotency.createIdempotencyStore,
    });
  };

  it("holds job-2 at the bridge presenting job-1's executed transfer after a restart", async () => {
    const first = signingClient(await reader());
    await expect(payDemSettle(createPayDemClientRail(first.client))(request("job-1")))
      .resolves.toMatchObject({ ok: true, txHash: TX_HASH });

    const restarted = await restart();
    // The node's account nonce still lags, so the floor admits NONCE again.
    accountNonce = NONCE - 1;
    const replay = customClient(await restarted.createPayDemRecordReader({
      rpc: "https://node.test",
      ...FAST,
    }));
    const log = createInMemorySettlementLog();
    const putOutcome = vi.spyOn(log, "putOutcome");
    const second = await restarted.payDemSettle(
      restarted.createPayDemClientRail(replay.client),
      {},
      { store: restarted.createIdempotencyStore(log) },
    )(request("job-2"));

    expect(second).toEqual({ ...held(), payer: PAYER_HEX, payee: PAYEE_HEX });
    expect(restarted.payDemRecordVerifiedTransfer(second)).toBeUndefined();
    expect(putOutcome).not.toHaveBeenCalled();
    expect(sdk.getTxByHash).toHaveBeenCalledWith(TX_HASH);
    // Nor does job-1's transfer become job-2's attempt record, so a restart
    // audit never reports job-2 paid with it (Daybreak F3, #370 sweep).
    await expect(log.readAttempt!(settlementKey("pay-dem", "job-2", 0))).resolves.toBeNull();
    const reconcile = vi.fn(async () =>
      ({ ...settled(), payer: PAYER_HEX, payee: PAYEE_HEX, amountOs: AMOUNT_OS }) as PayDemReconciledSettlement);
    await expect(restarted.payDemSettle(
      restarted.createPayDemClientRail(replay.client),
      {},
      { store: restarted.createIdempotencyStore(log), reconcile },
    )({ ...request("job-2"), priorAttempts: [{ txHash: TX_HASH, chainId: "demos", ok: false }] }))
      .rejects.toThrow(/no SDK record binds the retained transaction/);
  });

  it("holds a direct settle presenting an earlier executed transfer after a restart", async () => {
    const first = signingClient(await reader());
    await expect(payDemSettleCore({ recipient: RECIPIENT, amount: AMOUNT_OS }, first.client))
      .resolves.toEqual(settled());

    const restarted = await restart();
    accountNonce = NONCE - 1;
    const replay = customClient(await restarted.createPayDemRecordReader({
      rpc: "https://node.test",
      ...FAST,
    }));
    const again = await restarted.payDemSettleCore(
      { recipient: RECIPIENT, amount: AMOUNT_OS },
      replay.client,
    );

    expect(again).toEqual(held());
    expect(restarted.payDemRecordVerifiedTransfer(again)).toBeUndefined();
  });

  it.each<[string, (beganAtMs: number) => unknown]>([
    ["signed before the call began", (beganAtMs) => String(beganAtMs - 1)],
    ["with no signed timestamp", () => undefined],
    ["with a malformed signed timestamp", () => "1e12"],
  ])("holds a bound record %s, confirmed or failed", async (_label, stamp) => {
    for (const recordStatus of ["confirmed", "failed"]) {
      // No later than the SDK's own reading of its clock at the call's start.
      const beganAtMs = Date.now();
      sdk.getTxByHash.mockImplementation(async () => {
        const body = record();
        const value = stamp(beganAtMs);
        if (value === undefined) delete body.content.timestamp;
        else body.content.timestamp = value;
        return { ...body, status: recordStatus };
      });
      const { client } = customClient(await reader());

      const result = await payDemSettleCore(
        { recipient: RECIPIENT, amount: AMOUNT_OS },
        client,
      );

      expect(result).toEqual(held());
    }
  });
});

// Cold review (#369): a capped reader-client payment needs its confirmed
// debit before broadcast, as createPayDemRail does, so its success always
// carries the fee a wallet authority settles.
describe("a capped reader-carrying client journals its confirmed debit (#369)", () => {
  const CAP = "10500000000";

  it("refuses the broadcast without a confirmed debit under maxTotalDebitOs", async () => {
    let broadcast = false;
    const { client } = customClient(await reader(), {}, async (args) => {
      await args.journalPreparedTransfer!(prepared());
      broadcast = true;
    });

    await expect(payDemSettleCore(
      { recipient: RECIPIENT, amount: AMOUNT_OS, maxTotalDebitOs: CAP },
      client,
    )).rejects.toThrow(/no confirmedTotalDebitOs; refusing broadcast under maxTotalDebitOs/);
    expect(broadcast).toBe(false);
    expect(sdk.getTxByHash).not.toHaveBeenCalled();
  });

  it.each([
    ["above the ceiling", "10500000001"],
    ["below the amount", "9499999999"],
    ["not canonical text", "010500000000"],
  ])("refuses the broadcast with a confirmed debit %s", async (_label, debit) => {
    let broadcast = false;
    const { client } = customClient(await reader(), {}, async (args) => {
      await args.journalPreparedTransfer!(prepared({
        confirmedTotalDebitOs: debit,
      }));
      broadcast = true;
    });

    await expect(payDemSettleCore(
      { recipient: RECIPIENT, amount: AMOUNT_OS, maxTotalDebitOs: CAP },
      client,
    )).rejects.toThrow(/invalid confirmedTotalDebitOs; refusing broadcast/);
    expect(broadcast).toBe(false);
  });

  it("settles with the journaled fee when the client reports no total debit", async () => {
    const { client } = customClient(await reader(), { totalDebitOs: undefined }, async (args) => {
      await args.journalPreparedTransfer!(prepared({
        confirmedTotalDebitOs: CAP,
      }));
    });

    await expect(payDemSettleCore(
      { recipient: RECIPIENT, amount: AMOUNT_OS, maxTotalDebitOs: CAP },
      client,
    )).resolves.toEqual(settled());
  });

  it("refuses a reported total debit other than the journaled one", async () => {
    const { client } = customClient(await reader(), { totalDebitOs: "10000000000" }, async (args) => {
      await args.journalPreparedTransfer!(prepared({
        confirmedTotalDebitOs: CAP,
      }));
    });

    await expect(payDemSettleCore(
      { recipient: RECIPIENT, amount: AMOUNT_OS, maxTotalDebitOs: CAP },
      client,
    )).rejects.toThrow(/invalid total debit accounting/);
  });
});

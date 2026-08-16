import { beforeEach, describe, expect, it, vi } from "vitest";

import { DacsError } from "../../src/errors.js";
import {
  PayDemIncludedNonceVisibilityError,
  createPayDemRail,
} from "../../src/rails/payDem.js";

const WALLET = `0x${"ab".repeat(32)}`;
const RECIPIENT = `0x${"cd".repeat(32)}`;
const TX_HASH = "12".repeat(32);
const OTHER_TX_HASH = "34".repeat(32);

const sdk = vi.hoisted(() => ({
  broadcast: vi.fn(),
  confirm: vi.fn(),
  connect: vi.fn(),
  connectWallet: vi.fn(),
  getNetworkInfo: vi.fn(),
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
    readonly nodeCall = sdk.nodeCall;
    readonly transfer = sdk.transfer;
    readonly waitForNonce = sdk.waitForNonce;

    getAddress(): string {
      return WALLET;
    }
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
      nonce: 7,
      type: "native",
      from: WALLET,
      to,
      amount: amountOs.toString(),
      data: [
        "native",
        { nativeOperation: "send", args: [to, amountOs.toString()] },
      ],
    },
  }));
  sdk.confirm.mockImplementation(async (input?: {
    hash: string;
    content: Record<string, unknown>;
  }) => {
    const signed = input ?? await sdk.transfer(RECIPIENT, 1_000_000_000n);
    return {
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
    };
  });
  sdk.broadcast.mockResolvedValue({ response: { hash: TX_HASH } });
  sdk.nodeCall.mockResolvedValue({ state: "included", blockNumber: 42 });
  sdk.waitForNonce.mockResolvedValue(undefined);
});

describe("createPayDemRail nonce coordination", () => {
  it("does not complete an included settlement until its nonce is readable", async () => {
    const nonceVisible = deferred<void>();
    sdk.waitForNonce.mockReturnValue(nonceVisible.promise);
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
    });

    const followOnAnchor = vi.fn();
    let completed = false;
    const settlement = rail
      .settle({ recipient: RECIPIENT, amount: "1" })
      .finally(() => {
        completed = true;
      });
    const sequence = settlement.then(followOnAnchor);

    await vi.waitFor(() =>
      expect(sdk.waitForNonce).toHaveBeenCalledWith(WALLET, 7),
    );
    expect(completed).toBe(false);
    expect(followOnAnchor).not.toHaveBeenCalled();

    nonceVisible.resolve();
    await expect(settlement).resolves.toMatchObject({
      ok: true,
      txHash: TX_HASH,
      blockNumber: 42,
    });
    await sequence;
    expect(followOnAnchor).toHaveBeenCalledTimes(1);
  });

  it("keeps the included payment final when nonce visibility delays evidence catch-up", async () => {
    sdk.waitForNonce.mockRejectedValue(new Error("nonce read timed out"));
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1" }),
    ).resolves.toMatchObject({
      ok: true,
      txHash: TX_HASH,
      blockNumber: 42,
    });
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
  });

  it("rejects a confirmed transaction whose hash differs from the signed transfer", async () => {
    sdk.confirm.mockResolvedValue({
      response: {
        data: {
          transaction: { hash: OTHER_TX_HASH, content: { nonce: 7 } },
        },
      },
    });
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1" }),
    ).rejects.toThrow(/confirmed transaction hash does not match/);
    expect(sdk.broadcast).not.toHaveBeenCalled();
  });

  it("rejects a malformed signed hash before confirmation, journalling, or broadcast", async () => {
    const journalPreparedTransfer = vi.fn(async () => undefined);
    sdk.transfer.mockResolvedValue({
      hash: "not-a-demos-transaction-hash",
      content: {
        nonce: 7,
        type: "native",
        from: WALLET,
        to: RECIPIENT,
        amount: "1",
        data: ["native", { nativeOperation: "send", args: [RECIPIENT, "1"] }],
      },
    });
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
      journalPreparedTransfer,
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1" }),
    ).rejects.toThrow(/hash must be a 32-byte hex value/);
    expect(sdk.confirm).not.toHaveBeenCalled();
    expect(journalPreparedTransfer).not.toHaveBeenCalled();
    expect(sdk.broadcast).not.toHaveBeenCalled();
    expect(sdk.nodeCall).not.toHaveBeenCalled();
  });

  it("canonicalizes the signed transaction hash before journal and observation", async () => {
    const uppercaseHash = `0X${TX_HASH.toUpperCase()}`;
    sdk.transfer.mockImplementation(async (to: string, amountOs: bigint) => ({
      hash: uppercaseHash,
      content: {
        nonce: 7,
        type: "native",
        from: WALLET,
        to,
        amount: amountOs.toString(),
        data: ["native", { nativeOperation: "send", args: [to, amountOs.toString()] }],
      },
    }));
    const journalPreparedTransfer = vi.fn(async () => undefined);
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
      journalPreparedTransfer,
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1" }),
    ).resolves.toMatchObject({ ok: true, txHash: TX_HASH });
    expect(journalPreparedTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: TX_HASH }),
    );
    expect(sdk.nodeCall).toHaveBeenCalledWith(
      "getTransactionStatus",
      { hash: TX_HASH },
    );
  });

  it("rejects a confirmed transaction whose body nonce differs from the signed transfer", async () => {
    const confirmed = await sdk.confirm();
    confirmed.response.data.transaction.content.nonce = 8;
    sdk.confirm.mockResolvedValue(confirmed);
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1" }),
    ).rejects.toThrow(/confirmed transaction nonce does not match/);
    expect(sdk.broadcast).not.toHaveBeenCalled();
  });

  it("uses independent signed-hash inclusion even if transport metadata is unrelated", async () => {
    sdk.broadcast.mockResolvedValue({ response: { hash: OTHER_TX_HASH } });
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1" }),
    ).resolves.toMatchObject({ ok: true, txHash: TX_HASH, blockNumber: 42 });
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
  });

  it("rejects an uncapped signed body that does not match the requested transfer", async () => {
    sdk.transfer.mockResolvedValue({
      hash: TX_HASH,
      content: {
        nonce: 7,
        type: "native",
        from: WALLET,
        to: RECIPIENT,
        amount: "2",
        data: [
          "native",
          { nativeOperation: "send", args: [RECIPIENT, "2"] },
        ],
      },
    });
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1" }),
    ).rejects.toThrow(/do not bind the requested native transfer/);
    expect(sdk.broadcast).not.toHaveBeenCalled();
  });

  it("rejects an uncapped confirmed owner change before broadcast", async () => {
    const signed = await sdk.transfer(RECIPIENT, 1n);
    const confirmed = await sdk.confirm(signed);
    confirmed.response.data.transaction.content.from = `0x${"ef".repeat(32)}`;
    sdk.confirm.mockResolvedValue(confirmed);
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1" }),
    ).rejects.toThrow(/do not bind the requested native transfer/);
    expect(sdk.broadcast).not.toHaveBeenCalled();
  });

  it("fails closed on unavailable fork state even without a debit ceiling", async () => {
    sdk.getNetworkInfo.mockResolvedValue({ forks: {} });
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1" }),
    ).rejects.toThrow(/denomination fork state is unavailable/);
    expect(sdk.broadcast).not.toHaveBeenCalled();
  });

  it("keeps the compatibility nonce signal non-retryable", () => {
    const error = new PayDemIncludedNonceVisibilityError({
      txHash: TX_HASH,
      blockNumber: 42,
      nonce: 7,
    });
    expect(error).toBeInstanceOf(DacsError);
    expect(error).toMatchObject({ category: "permanent" });
    expect(error.message).toMatch(/payment is final and only evidence catch-up may be retried/);
  });

  it("refuses to broadcast a transfer without a signed nonce", async () => {
    sdk.transfer.mockResolvedValue({ hash: TX_HASH, content: {} });
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1" }),
    ).rejects.toThrow(/no valid transaction nonce/);
    expect(sdk.confirm).not.toHaveBeenCalled();
    expect(sdk.broadcast).not.toHaveBeenCalled();
  });

  it("journals validated immutable transfer facts immediately before broadcast", async () => {
    const order: string[] = [];
    const journalPreparedTransfer = vi.fn(async (prepared) => {
      order.push("journal");
      expect(Object.isFrozen(prepared)).toBe(true);
      expect(prepared).toEqual({
        txHash: TX_HASH,
        nonce: 7,
        payer: "ab".repeat(32),
        payee: "cd".repeat(32),
        amountOs: "1000000000",
        network: "demos",
        maxTotalDebitOs: "2000000000",
      });
    });
    sdk.broadcast.mockImplementation(async () => {
      order.push("broadcast");
      return { response: { hash: TX_HASH } };
    });
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
      network: "demos",
      maxTotalDebitOs: 2_000_000_000n,
      journalPreparedTransfer,
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1000000000" }),
    ).resolves.toMatchObject({ ok: true, txHash: TX_HASH, blockNumber: 42 });
    expect(order).toEqual(["journal", "broadcast"]);
    expect(journalPreparedTransfer).toHaveBeenCalledTimes(1);
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
  });

  it("does not broadcast when the durable preparation journal fails", async () => {
    const journalPreparedTransfer = vi.fn(async () => {
      throw new Error("journal-fsync-failed");
    });
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
      maxTotalDebitOs: 2_000_000_000n,
      journalPreparedTransfer,
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1000000000" }),
    ).rejects.toThrow(/journal-fsync-failed/);
    expect(journalPreparedTransfer).toHaveBeenCalledTimes(1);
    expect(sdk.broadcast).not.toHaveBeenCalled();
    expect(sdk.nodeCall).not.toHaveBeenCalled();
  });

  it("observes inclusion by the pre-journaled hash when broadcast never resolves", async () => {
    const never = new Promise<never>(() => undefined);
    const journalPreparedTransfer = vi.fn(async () => undefined);
    sdk.broadcast.mockReturnValue(never);
    sdk.nodeCall
      .mockResolvedValueOnce({ state: "pending" })
      .mockResolvedValueOnce({ state: "included", blockNumber: 42 });
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
      journalPreparedTransfer,
      inclusionTimeoutMs: 100,
      inclusionPollIntervalMs: 1,
      statusRequestTimeoutMs: 10,
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1" }),
    ).resolves.toMatchObject({ ok: true, txHash: TX_HASH, blockNumber: 42 });
    expect(journalPreparedTransfer).toHaveBeenCalledTimes(1);
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
    expect(sdk.nodeCall).toHaveBeenCalledTimes(2);
  });

  it("returns tx-bearing ambiguity without a second submission when broadcast and status stall", async () => {
    sdk.broadcast.mockReturnValue(new Promise<never>(() => undefined));
    sdk.nodeCall.mockImplementation(() => new Promise<never>(() => undefined));
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
      journalPreparedTransfer: async () => undefined,
      inclusionTimeoutMs: 20,
      inclusionPollIntervalMs: 1,
      statusRequestTimeoutMs: 3,
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1" }),
    ).resolves.toMatchObject({
      ok: false,
      txHash: TX_HASH,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
    expect(sdk.nodeCall).toHaveBeenCalledTimes(1);
  });

  it("keeps polling not-found status without rebroadcasting and fails closed on timeout", async () => {
    sdk.broadcast.mockReturnValue(new Promise<never>(() => undefined));
    sdk.nodeCall.mockResolvedValue({ state: "not_found" });
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
      journalPreparedTransfer: async () => undefined,
      inclusionTimeoutMs: 20,
      inclusionPollIntervalMs: 1,
      statusRequestTimeoutMs: 3,
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1" }),
    ).resolves.toMatchObject({
      ok: false,
      txHash: TX_HASH,
    });
    expect(sdk.nodeCall.mock.calls.length).toBeGreaterThan(1);
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
  });

  it("enforces the confirmed maximum total debit before broadcast", async () => {
    const config = {
      rpc: "https://node.test",
      secret: "test-secret",
      maxTotalDebitOs: 1_500_000_000n,
    };
    const rail = await createPayDemRail(config);
    config.maxTotalDebitOs = 3_000_000_000n;

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1000000000" }),
    ).rejects.toThrow(/exceeds maxTotalDebitOs/);
    expect(sdk.broadcast).not.toHaveBeenCalled();
  });

  it("rejects a non-bigint debit ceiling at the JavaScript boundary", async () => {
    await expect(createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
      maxTotalDebitOs: "3000000000",
    } as unknown as Parameters<typeof createPayDemRail>[0])).rejects.toThrow(
      /maxTotalDebitOs must be positive/,
    );
    expect(sdk.connect).not.toHaveBeenCalled();
  });

  it("fails closed when a capped confirmation omits fee data", async () => {
    const confirmed = await sdk.confirm(await sdk.transfer(RECIPIENT, 1n));
    delete confirmed.response.data.transaction.content.transaction_fee;
    sdk.confirm.mockResolvedValue(confirmed);
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
      maxTotalDebitOs: 3_000_000_000n,
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1" }),
    ).rejects.toThrow(/no unambiguous bound OS debit/);
    expect(sdk.broadcast).not.toHaveBeenCalled();
  });

  it("accepts a capped post-fork transaction within the explicit ceiling", async () => {
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
      maxTotalDebitOs: 2_000_000_000n,
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1000000000" }),
    ).resolves.toMatchObject({ ok: true, blockNumber: 42 });
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
  });

  it("accepts a post-fork numeric confirmed amount bound by the canonical OS payload", async () => {
    const confirmed = await sdk.confirm(await sdk.transfer(RECIPIENT, 1n));
    confirmed.response.data.transaction.content.amount = 1;
    sdk.confirm.mockResolvedValue(confirmed);
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
      maxTotalDebitOs: 1_000_000_001n,
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1" }),
    ).resolves.toMatchObject({ ok: true, blockNumber: 42 });
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
  });

  it("rejects a post-fork numeric confirmed amount that disagrees with its OS payload", async () => {
    const confirmed = await sdk.confirm(await sdk.transfer(RECIPIENT, 1n));
    confirmed.response.data.transaction.content.amount = 2;
    sdk.confirm.mockResolvedValue(confirmed);
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
      maxTotalDebitOs: 3_000_000_000n,
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1" }),
    ).rejects.toThrow(/do not bind the requested native transfer/);
    expect(sdk.broadcast).not.toHaveBeenCalled();
  });

  it("does not accept a numeric post-fork amount in the signed intent", async () => {
    sdk.transfer.mockResolvedValue({
      hash: TX_HASH,
      content: {
        nonce: 7,
        type: "native",
        from: WALLET,
        to: RECIPIENT,
        amount: 1,
        data: [
          "native",
          { nativeOperation: "send", args: [RECIPIENT, "1"] },
        ],
      },
    });
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1" }),
    ).rejects.toThrow(/do not bind the requested native transfer/);
    expect(sdk.broadcast).not.toHaveBeenCalled();
  });

  it("uses authoritative gas-operation fees for the debit ceiling", async () => {
    sdk.confirm.mockResolvedValue({
      response: {
        data: {
          gas_operation: {
            fees: {
              network_fee: "1000000000",
              rpc_fee: "1000000000",
              additional_fee: "0",
            },
          },
          transaction: {
            hash: TX_HASH,
            content: {
              nonce: 7,
              type: "native",
              from: WALLET,
              to: RECIPIENT,
              amount: "1000000000",
              data: [
                "native",
                { nativeOperation: "send", args: [RECIPIENT, "1000000000"] },
              ],
              transaction_fee: {
                network_fee: "0",
                rpc_fee: "0",
                additional_fee: "0",
              },
            },
          },
        },
      },
    });
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
      maxTotalDebitOs: 2_500_000_000n,
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1000000000" }),
    ).rejects.toThrow(/exceeds maxTotalDebitOs/);
    expect(sdk.broadcast).not.toHaveBeenCalled();
  });

  it("does not fall back from malformed authoritative gas-operation fees", async () => {
    const confirmed = await sdk.confirm();
    confirmed.response.data.gas_operation = {
      fees: {
        network_fee: "not-an-os-integer",
        rpc_fee: "0",
        additional_fee: "0",
      },
    };
    sdk.confirm.mockResolvedValue(confirmed);
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
      maxTotalDebitOs: 3_000_000_000n,
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1000000000" }),
    ).rejects.toThrow(/no unambiguous bound OS debit/);
    expect(sdk.broadcast).not.toHaveBeenCalled();
  });

  it.each([{}, { fees: null }])(
    "does not fall back when a non-null gas operation omits authoritative fees",
    async (gasOperation) => {
      const confirmed = await sdk.confirm();
      confirmed.response.data.gas_operation = gasOperation;
      sdk.confirm.mockResolvedValue(confirmed);
      const rail = await createPayDemRail({
        rpc: "https://node.test",
        secret: "test-secret",
        maxTotalDebitOs: 3_000_000_000n,
      });

      await expect(
        rail.settle({ recipient: RECIPIENT, amount: "1000000000" }),
      ).rejects.toThrow(/no unambiguous bound OS debit/);
      expect(sdk.broadcast).not.toHaveBeenCalled();
    },
  );

  it("rejects an accessor debit ceiling without invoking it", async () => {
    let reads = 0;
    const config = {
      rpc: "https://node.test",
      secret: "test-secret",
      get maxTotalDebitOs(): bigint | undefined {
        reads += 1;
        return reads === 1 ? 1_500_000_000n : undefined;
      },
    };
    await expect(createPayDemRail(config)).rejects.toThrow(/must be stable data/);
    expect(reads).toBe(0);
    expect(sdk.broadcast).not.toHaveBeenCalled();
  });

  it("rejects a proxied rail config without invoking property traps", async () => {
    let reads = 0;
    const config = new Proxy({
      rpc: "https://node.test",
      secret: "test-secret",
    }, {
      get(target, property, receiver) {
        reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    await expect(createPayDemRail(config)).rejects.toThrow(/must be stable data/);
    expect(reads).toBe(0);
    expect(sdk.connect).not.toHaveBeenCalled();
  });

  it("rejects a confirmed content amount that disagrees with the payload", async () => {
    const confirmed = await sdk.confirm();
    confirmed.response.data.transaction.content.amount = "2";
    confirmed.response.data.transaction.content.data[1].args[1] = "1";
    sdk.confirm.mockResolvedValue(confirmed);
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
      maxTotalDebitOs: 3_000_000_000n,
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1" }),
    ).rejects.toThrow(/do not bind the requested native transfer/);
    expect(sdk.broadcast).not.toHaveBeenCalled();
  });

  it("converts pre-fork numeric amounts and fees from DEM to OS", async () => {
    sdk.getNetworkInfo.mockResolvedValue({
      forks: { osDenomination: { activated: false } },
    });
    sdk.transfer.mockResolvedValue({
      hash: TX_HASH,
      content: {
        nonce: 7,
        type: "native",
        from: WALLET,
        to: RECIPIENT,
        amount: 1,
        data: [
          "native",
          { nativeOperation: "send", args: [RECIPIENT, 1] },
        ],
      },
    });
    sdk.confirm.mockResolvedValue({
      response: {
        data: {
          gas_operation: null,
          transaction: {
            hash: TX_HASH,
            content: {
              nonce: 7,
              type: "native",
              from: WALLET,
              to: RECIPIENT,
              amount: 1,
              data: [
                "native",
                { nativeOperation: "send", args: [RECIPIENT, 1] },
              ],
              transaction_fee: {
                network_fee: 1,
                rpc_fee: 0,
                additional_fee: 0,
              },
            },
          },
        },
      },
    });
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
      maxTotalDebitOs: 1_500_000_000n,
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1000000000" }),
    ).rejects.toThrow(/exceeds maxTotalDebitOs/);
    expect(sdk.broadcast).not.toHaveBeenCalled();
  });

  it("rejects post-fork numeric fee fields as ambiguous", async () => {
    const confirmed = await sdk.confirm();
    confirmed.response.data.transaction.content.transaction_fee.network_fee = 1;
    sdk.confirm.mockResolvedValue(confirmed);
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
      maxTotalDebitOs: 3_000_000_000n,
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1000000000" }),
    ).rejects.toThrow(/no unambiguous bound OS debit/);
    expect(sdk.broadcast).not.toHaveBeenCalled();
  });

  it("rejects any confirmed custom charge outside the native debit model", async () => {
    const confirmed = await sdk.confirm();
    confirmed.response.data.custom_charges = {
      type: "compute",
      actual_cost_os: "1",
    };
    sdk.confirm.mockResolvedValue(confirmed);
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
      maxTotalDebitOs: 3_000_000_000n,
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1000000000" }),
    ).rejects.toThrow(/do not bind the requested native transfer/);
    expect(sdk.broadcast).not.toHaveBeenCalled();
  });

  it("rejects an altered confirmed recipient before broadcast", async () => {
    const altered = `0x${"ef".repeat(32)}`;
    sdk.confirm.mockResolvedValue({
      response: {
        data: {
          transaction: {
            hash: TX_HASH,
            content: {
              nonce: 7,
              type: "native",
              from: WALLET,
              to: altered,
              amount: "1",
              data: ["native", { nativeOperation: "send", args: [altered, "1"] }],
              transaction_fee: {
                network_fee: "1",
                rpc_fee: "1",
                additional_fee: "0",
              },
            },
          },
        },
      },
    });
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
      maxTotalDebitOs: 3_000_000_000n,
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1" }),
    ).rejects.toThrow(/do not bind the requested native transfer/);
    expect(sdk.broadcast).not.toHaveBeenCalled();
  });
});

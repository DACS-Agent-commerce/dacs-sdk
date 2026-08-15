import { beforeEach, describe, expect, it, vi } from "vitest";

import { TransientError } from "../../src/errors.js";
import { createPayDemRail } from "../../src/rails/payDem.js";

const WALLET = `0x${"ab".repeat(32)}`;
const RECIPIENT = `0x${"cd".repeat(32)}`;

const sdk = vi.hoisted(() => ({
  broadcastAndWait: vi.fn(),
  confirm: vi.fn(),
  connect: vi.fn(),
  connectWallet: vi.fn(),
  getNetworkInfo: vi.fn(),
  transfer: vi.fn(),
  waitForNonce: vi.fn(),
}));

vi.mock("@kynesyslabs/demosdk/websdk", () => ({
  Demos: class MockDemos {
    readonly tx = { confirm: sdk.confirm };
    readonly broadcastAndWait = sdk.broadcastAndWait;
    readonly connect = sdk.connect;
    readonly connectWallet = sdk.connectWallet;
    readonly getNetworkInfo = sdk.getNetworkInfo;
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
  sdk.transfer.mockResolvedValue({
    hash: "tx-pay-dem",
    content: { nonce: 7 },
  });
  sdk.confirm.mockResolvedValue({
    response: {
      data: {
        transaction: {
          hash: "tx-pay-dem",
          content: {
            type: "native",
            from: WALLET,
            to: RECIPIENT,
            data: [
              "native",
              { nativeOperation: "send", args: [RECIPIENT, "1000000000"] },
            ],
            transaction_fee: {
              network_fee: "400000000",
              rpc_fee: "500000000",
              additional_fee: "100000000",
            },
          },
        },
      },
    },
  });
  sdk.broadcastAndWait.mockResolvedValue({
    broadcast: { response: { hash: "tx-pay-dem" } },
    status: { state: "included", blockNumber: 42 },
  });
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
      txHash: "tx-pay-dem",
      blockNumber: 42,
    });
    await sequence;
    expect(followOnAnchor).toHaveBeenCalledTimes(1);
  });

  it("fails transiently instead of allowing a stale-nonce follow-on anchor", async () => {
    sdk.waitForNonce.mockRejectedValue(new Error("nonce read timed out"));
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
    });

    const error = await rail
      .settle({ recipient: RECIPIENT, amount: "1" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ category: "transient" });
    expect((error as Error).message).toMatch(
      /was included, but account nonce 7 did not become readable/,
    );
  });

  it("keeps the confirmed transaction hash authoritative", async () => {
    sdk.confirm.mockResolvedValue({
      response: { data: { transaction: { hash: "tx-confirmed" } } },
    });
    sdk.broadcastAndWait.mockResolvedValue({
      broadcast: { response: { hash: "tx-conflicting-response" } },
      status: { state: "included", blockNumber: 42 },
    });
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1" }),
    ).resolves.toMatchObject({
      ok: true,
      txHash: "tx-confirmed",
      blockNumber: 42,
    });
  });

  it("refuses to broadcast a transfer without a signed nonce", async () => {
    sdk.transfer.mockResolvedValue({ hash: "tx-missing-nonce", content: {} });
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1" }),
    ).rejects.toThrow(/no valid transaction nonce/);
    expect(sdk.confirm).not.toHaveBeenCalled();
    expect(sdk.broadcastAndWait).not.toHaveBeenCalled();
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
    expect(sdk.broadcastAndWait).not.toHaveBeenCalled();
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
    sdk.confirm.mockResolvedValue({
      response: { data: { transaction: { hash: "tx-pay-dem", content: {} } } },
    });
    const rail = await createPayDemRail({
      rpc: "https://node.test",
      secret: "test-secret",
      maxTotalDebitOs: 3_000_000_000n,
    });

    await expect(
      rail.settle({ recipient: RECIPIENT, amount: "1" }),
    ).rejects.toThrow(/no unambiguous bound OS debit/);
    expect(sdk.broadcastAndWait).not.toHaveBeenCalled();
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
    expect(sdk.broadcastAndWait).toHaveBeenCalledTimes(1);
  });

  it("rejects an altered confirmed recipient before broadcast", async () => {
    const altered = `0x${"ef".repeat(32)}`;
    sdk.confirm.mockResolvedValue({
      response: {
        data: {
          transaction: {
            hash: "tx-pay-dem",
            content: {
              type: "native",
              from: WALLET,
              to: altered,
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
    ).rejects.toThrow(/no unambiguous bound OS debit/);
    expect(sdk.broadcastAndWait).not.toHaveBeenCalled();
  });
});

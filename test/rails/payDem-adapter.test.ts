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
  transfer: vi.fn(),
  waitForNonce: vi.fn(),
}));

vi.mock("@kynesyslabs/demosdk/websdk", () => ({
  Demos: class MockDemos {
    readonly tx = { confirm: sdk.confirm };
    readonly broadcastAndWait = sdk.broadcastAndWait;
    readonly connect = sdk.connect;
    readonly connectWallet = sdk.connectWallet;
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
  sdk.transfer.mockResolvedValue({
    hash: "tx-pay-dem",
    content: { nonce: 7 },
  });
  sdk.confirm.mockResolvedValue({
    response: { data: { transaction: { hash: "tx-pay-dem" } } },
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
});

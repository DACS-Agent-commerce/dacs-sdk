import { describe, expect, it, vi } from "vitest";

import {
  createPayDemSellerObserver,
  observePayDemTransferCore,
  type PayDemObservationClient,
} from "../../src/seller/index.js";

const HASH = "ab".repeat(32);
const PAYER = "11".repeat(32);
const PAYEE = "22".repeat(32);
const BLOCK_NUMBER = 91_452;
const BLOCK_TIMESTAMP_SECONDS = 1_786_694_557;

function includedFixture(amount: string | number = "2398") {
  return {
    status: { state: "included", blockNumber: BLOCK_NUMBER },
    transaction: {
      hash: HASH,
      status: "included",
      blockNumber: BLOCK_NUMBER,
      content: {
        type: "native",
        from: `0x${PAYER}`,
        from_ed25519_address: `0x${PAYER}`,
        to: PAYEE,
        amount,
        timestamp: BLOCK_TIMESTAMP_SECONDS * 1_000 - 5_000,
        data: [
          "native",
          { nativeOperation: "send", args: [`0x${PAYEE}`, amount] },
        ],
      },
    },
    block: {
      number: BLOCK_NUMBER,
      status: "confirmed",
      content: {
        timestamp: BLOCK_TIMESTAMP_SECONDS,
        ordered_transactions: ["00".repeat(32), `0x${HASH}`],
      },
    },
  };
}

function fixtureClient(
  fixture = includedFixture(),
): PayDemObservationClient {
  return {
    getTransactionStatus: vi.fn(async () => fixture.status),
    getTxByHash: vi.fn(async () => fixture.transaction),
    getBlockByNumber: vi.fn(async () => fixture.block),
  };
}

describe("pay-DEM seller observation (DACS-4 §9.5.9)", () => {
  it("returns post-fork OS facts from one mutually-consistent confirmed block", async () => {
    await expect(
      observePayDemTransferCore(`0X${HASH.toUpperCase()}`, fixtureClient()),
    ).resolves.toEqual({
      status: "included",
      txHash: HASH,
      payer: PAYER,
      payee: PAYEE,
      amountOs: "2398",
      blockNumber: BLOCK_NUMBER,
      includedAt: BLOCK_TIMESTAMP_SECONDS * 1_000,
    });
  });

  it("converts the legacy pre-fork numeric DEM wire shape to OS", async () => {
    const fixture = includedFixture(2);
    await expect(
      observePayDemTransferCore(HASH, fixtureClient(fixture)),
    ).resolves.toMatchObject({
      status: "included",
      amountOs: "2000000000",
    });
  });

  it("accepts the observed post-fork numeric projection as OS when the payload and confirmed block establish it", async () => {
    const fixture = includedFixture(1);
    fixture.transaction.status = "confirmed";
    fixture.transaction.content.data[1] = {
      nativeOperation: "send",
      args: [`0x${PAYEE}`, "1"],
    };

    await expect(
      observePayDemTransferCore(HASH, fixtureClient(fixture)),
    ).resolves.toMatchObject({
      status: "included",
      amountOs: "1",
      blockNumber: BLOCK_NUMBER,
    });
  });

  it("reports the debited ed25519 owner rather than an alternate signing key", async () => {
    const owner = "33".repeat(32);
    const fixture = includedFixture();
    fixture.transaction.content.from_ed25519_address = `0x${owner}`;

    await expect(
      observePayDemTransferCore(HASH, fixtureClient(fixture)),
    ).resolves.toMatchObject({
      status: "included",
      payer: owner,
    });
  });

  it("fails closed on a malformed present ed25519 owner instead of falling back to the signer", async () => {
    const fixture = includedFixture();
    fixture.transaction.content.from_ed25519_address = "not-an-address";

    await expect(
      observePayDemTransferCore(HASH, fixtureClient(fixture)),
    ).resolves.toMatchObject({ status: "invalid" });
  });

  it.each(["included", "confirmed", "finalized"])(
    "accepts transaction-body state %s only behind included status and confirmed-block proof",
    async (transactionState) => {
      const fixture = includedFixture();
      fixture.transaction.status = transactionState;
      await expect(
        observePayDemTransferCore(HASH, fixtureClient(fixture)),
      ).resolves.toMatchObject({ status: "included" });
    },
  );

  it("rejects a projected numeric amount that does not exactly match the post-fork OS payload", async () => {
    const fixture = includedFixture(1);
    fixture.transaction.content.data[1] = {
      nativeOperation: "send",
      args: [`0x${PAYEE}`, "1000000000"],
    };
    await expect(
      observePayDemTransferCore(HASH, fixtureClient(fixture)),
    ).resolves.toMatchObject({ status: "invalid" });
  });

  it.each([
    ["pending", "pending"],
    ["accepted", "pending"],
    ["unknown", "not-found"],
    ["failed", "failed"],
    ["finalized", "unavailable"],
  ] as const)("maps node state %s to %s without trusting a transaction body", async (
    state,
    expected,
  ) => {
    const client: PayDemObservationClient = {
      getTransactionStatus: vi.fn(async () => ({ state })),
      getTxByHash: vi.fn(async () => {
        throw new Error("must not read");
      }),
      getBlockByNumber: vi.fn(async () => {
        throw new Error("must not read");
      }),
    };

    await expect(observePayDemTransferCore(HASH, client)).resolves.toMatchObject({
      status: expected,
    });
    expect(client.getTxByHash).not.toHaveBeenCalled();
    expect(client.getBlockByNumber).not.toHaveBeenCalled();
  });

  it.each([
    ["status block", (fixture: ReturnType<typeof includedFixture>) => {
      fixture.status.blockNumber += 1;
    }],
    ["transaction hash", (fixture: ReturnType<typeof includedFixture>) => {
      fixture.transaction.hash = "cd".repeat(32);
    }],
    ["transaction state", (fixture: ReturnType<typeof includedFixture>) => {
      fixture.transaction.status = "pending";
    }],
    ["transaction block", (fixture: ReturnType<typeof includedFixture>) => {
      fixture.transaction.blockNumber += 1;
    }],
    ["confirmed block status", (fixture: ReturnType<typeof includedFixture>) => {
      fixture.block.status = "derived";
    }],
    ["block transaction membership", (fixture: ReturnType<typeof includedFixture>) => {
      fixture.block.content.ordered_transactions = [];
    }],
    ["native transaction type", (fixture: ReturnType<typeof includedFixture>) => {
      fixture.transaction.content.type = "demoswork";
    }],
    ["payload destination", (fixture: ReturnType<typeof includedFixture>) => {
      fixture.transaction.content.data[1] = {
        nativeOperation: "send",
        args: [PAYER, fixture.transaction.content.amount],
      };
    }],
    ["payload amount", (fixture: ReturnType<typeof includedFixture>) => {
      fixture.transaction.content.data[1] = {
        nativeOperation: "send",
        args: [PAYEE, "1250000001"],
      };
    }],
    ["block timestamp", (fixture: ReturnType<typeof includedFixture>) => {
      fixture.block.content.timestamp = -1;
    }],
  ] as const)("rejects contradictory included facts: %s", async (_name, mutate) => {
    const fixture = includedFixture();
    mutate(fixture);
    await expect(
      observePayDemTransferCore(HASH, fixtureClient(fixture)),
    ).resolves.toMatchObject({ status: "invalid" });
  });

  it("keeps node/read failures retryable instead of authorizing delivery", async () => {
    const client = fixtureClient();
    client.getTransactionStatus = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(observePayDemTransferCore(HASH, client)).resolves.toEqual({
      status: "unavailable",
      reason: "transaction status read failed",
    });

    const included = fixtureClient();
    included.getBlockByNumber = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(observePayDemTransferCore(HASH, included)).resolves.toEqual({
      status: "unavailable",
      reason: "included transaction facts are unavailable",
    });

    const notYetReadable = fixtureClient();
    notYetReadable.getTxByHash = vi.fn(async () => null);
    await expect(
      observePayDemTransferCore(HASH, notYetReadable),
    ).resolves.toEqual({
      status: "unavailable",
      reason: "included transaction facts are unavailable",
    });

    const wrappedRpcFailure = fixtureClient();
    wrappedRpcFailure.getBlockByNumber = vi.fn(async () => ({
      result: 500,
      response: { message: "temporarily unavailable" },
    }));
    await expect(
      observePayDemTransferCore(HASH, wrappedRpcFailure),
    ).resolves.toEqual({
      status: "unavailable",
      reason: "included transaction facts are unavailable",
    });
  });

  it("uses the public Demos nodeCall protocol without loading demosdk", async () => {
    const fixture = includedFixture();
    const responses = new Map<string, unknown>([
      ["getTransactionStatus", fixture.status],
      ["getTxByHash", fixture.transaction],
      ["getBlockByNumber", fixture.block],
    ]);
    const messages: string[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        method: string;
        params: Array<{ message: string; data: Record<string, unknown> }>;
      };
      expect(body.method).toBe("nodeCall");
      const message = body.params[0]!.message;
      messages.push(message);
      return new Response(JSON.stringify({
        result: 200,
        response: responses.get(message),
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const observer = createPayDemSellerObserver({
      rpc: "https://node.example",
      fetchImpl,
    });

    await expect(observer.observeDemosTransfer(HASH)).resolves.toMatchObject({
      status: "included",
      amountOs: "2398",
    });
    expect(messages).toEqual([
      "getTransactionStatus",
      "getTxByHash",
      "getBlockByNumber",
    ]);
  });

  it("bounds response-body parsing even when an injected fetch ignores abort", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: () => new Promise<never>(() => undefined),
    }) as unknown as Response);
    const observer = createPayDemSellerObserver({
      rpc: "https://node.example",
      timeoutMs: 10,
      fetchImpl,
    });

    await expect(observer.observeDemosTransfer(HASH)).resolves.toEqual({
      status: "unavailable",
      reason: "transaction status read failed",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

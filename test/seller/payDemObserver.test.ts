import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  createPayDemSellerObserver,
  demosExecutedTransferNetworkFeeOs,
  isDemosExecutedTransferObservation,
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
        nonce: "7",
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("pay-DEM seller observation (DACS-4 §9.5.9)", () => {
  it.each([
    ["numeric OS projection", "2398", { network_fee: 400000000, rpc_fee: 500000000, additional_fee: 100000000 }, "1000000000"],
    ["string OS projection", "2398", { network_fee: "400000000", rpc_fee: "500000000", additional_fee: "100000000" }, "1000000000"],
    ["large string OS projection", "2398", { network_fee: "9007199254740993", rpc_fee: "0", additional_fee: "0" }, "9007199254740993"],
    ["numeric DEM projection", 2, { network_fee: 1, rpc_fee: 2, additional_fee: 3 }, "6000000000"],
    ["explicit zero", "2398", { network_fee: 0, rpc_fee: 0, additional_fee: 0 }, "0"],
    ["missing", "2398", undefined, undefined],
    ["null", "2398", null, undefined],
    ["incomplete", "2398", { network_fee: 1, rpc_fee: 0 }, undefined],
    ["fractional", "2398", { network_fee: 0.5, rpc_fee: 0, additional_fee: 0 }, undefined],
    ["negative", "2398", { network_fee: -1, rpc_fee: 0, additional_fee: 0 }, undefined],
    ["noncanonical", "2398", { network_fee: "01", rpc_fee: 0, additional_fee: 0 }, undefined],
  ] as const)("binds %s record fee evidence to the original executed observation", async (
    _label, amount, fee, expected,
  ) => {
    const fixture = includedFixture(amount);
    fixture.transaction.status = "confirmed";
    if (fee !== undefined) Object.assign(fixture.transaction.content, { transaction_fee: fee });
    const observation = await observePayDemTransferCore(HASH, fixtureClient(fixture));
    expect(isDemosExecutedTransferObservation(observation)).toBe(true);
    expect(demosExecutedTransferNetworkFeeOs(observation)).toBe(expected);
    expect(demosExecutedTransferNetworkFeeOs({ ...observation })).toBeUndefined();
    // The evidence is the SDK's captured record fee, independent of later
    // changes to the client's record or fee properties supplied by a caller.
    Object.assign(fixture.transaction.content, { transaction_fee: null });
    expect(demosExecutedTransferNetworkFeeOs(observation)).toBe(expected);
    expect(demosExecutedTransferNetworkFeeOs({ ...observation, networkFeeOs: "0" } as never))
      .toBeUndefined();
    fixture.transaction.status = "included";
    const inclusionOnly = await observePayDemTransferCore(HASH, fixtureClient(fixture));
    expect(demosExecutedTransferNetworkFeeOs(inclusionOnly)).toBeUndefined();
  });

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

  it.each(["included", "confirmed", "finalized", "CONFIRMED", "Confirmed"])(
    "attests execution only for a confirmed transaction record, not %s alone",
    async (transactionState) => {
      const fixture = includedFixture();
      fixture.transaction.status = transactionState;
      const observation = await observePayDemTransferCore(HASH, fixtureClient(fixture));

      expect(observation).toEqual({
        status: "included",
        ...(transactionState === "confirmed" ? { execution: "executed", nonce: 7 } : {}),
        txHash: HASH,
        payer: PAYER,
        payee: PAYEE,
        amountOs: "2398",
        blockNumber: BLOCK_NUMBER,
        includedAt: BLOCK_TIMESTAMP_SECONDS * 1_000,
      });
      // Only the attestation this observer built, frozen, is execution evidence.
      expect(isDemosExecutedTransferObservation(observation))
        .toBe(transactionState === "confirmed");
      expect(Object.isFrozen(observation)).toBe(transactionState === "confirmed");
      expect(isDemosExecutedTransferObservation({ ...observation })).toBe(false);
    },
  );

  // `[[7]]` passes the array `[7]`, which a coercing digit check would read as 7.
  it.each([undefined, null, "", "-1", "1.5", "07", "7 ", "9007199254740992", -1, -0, 1.5,
    [[7]], true])(
    "withholds execution for invalid confirmed-record nonce %j", async (nonce) => {
      const fixture = includedFixture();
      fixture.transaction.status = "confirmed";
      const content = fixture.transaction.content as Record<string, unknown>;
      if (nonce === undefined) delete content.nonce;
      else content.nonce = nonce;

      const observation = await observePayDemTransferCore(HASH, fixtureClient(fixture));
      // The record says the transfer executed, so a missing or malformed nonce
      // keeps it retryable rather than proving it invalid. Negative zero is
      // already refused at the JSON-read boundary before nonce parsing.
      if (Object.is(nonce, -0)) expect(observation.status).toBe("unavailable");
      else {
        expect(observation).toEqual({
          status: "unavailable",
          reason: "confirmed transaction record has no valid signed nonce",
        });
      }
      expect(observation).not.toHaveProperty("execution");
    },
  );

  it.each(["included", "finalized"])(
    "returns inclusion only for a %s record whatever its nonce", async (transactionState) => {
      const fixture = includedFixture();
      fixture.transaction.status = transactionState;
      (fixture.transaction.content as Record<string, unknown>).nonce = "not-a-nonce";
      const observation = await observePayDemTransferCore(HASH, fixtureClient(fixture));
      expect(observation).toMatchObject({ status: "included", txHash: HASH });
      expect(observation).not.toHaveProperty("execution");
      expect(observation).not.toHaveProperty("nonce");
    },
  );

  it.each([0, "0", 7, "7", Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)])(
    "carries validated confirmed-record nonce %j", async (nonce) => {
      const fixture = includedFixture();
      fixture.transaction.status = "confirmed";
      (fixture.transaction.content as Record<string, unknown>).nonce = nonce;
      await expect(observePayDemTransferCore(HASH, fixtureClient(fixture)))
        .resolves.toMatchObject({ status: "included", execution: "executed", nonce: Number(nonce) });
    },
  );

  it("rejects an included status whose transaction record failed", async () => {
    const fixture = includedFixture();
    fixture.transaction.status = "failed";

    await expect(observePayDemTransferCore(HASH, fixtureClient(fixture)))
      .resolves.toEqual({
        status: "invalid",
        reason: "transaction body does not represent included finality",
      });
  });

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

  it("binds every observation method before the first RPC await", async () => {
    const fixture = includedFixture();
    const status = deferred<typeof fixture.status>();
    const originalTx = vi.fn(async () => fixture.transaction);
    const originalBlock = vi.fn(async () => fixture.block);
    const client: PayDemObservationClient = {
      getTransactionStatus: vi.fn(() => status.promise),
      getTxByHash: originalTx,
      getBlockByNumber: originalBlock,
    };

    const observation = observePayDemTransferCore(HASH, client);
    client.getTxByHash = vi.fn(async () => ({
      ...fixture.transaction,
      content: { ...fixture.transaction.content, to: PAYER },
    }));
    client.getBlockByNumber = vi.fn(async () => ({
      ...fixture.block,
      content: { ...fixture.block.content, ordered_transactions: [] },
    }));
    status.resolve(fixture.status);

    await expect(observation).resolves.toMatchObject({
      status: "included",
      payer: PAYER,
      payee: PAYEE,
    });
    expect(originalTx).toHaveBeenCalledTimes(1);
    expect(originalBlock).toHaveBeenCalledTimes(1);
    expect(client.getTxByHash).not.toHaveBeenCalled();
    expect(client.getBlockByNumber).not.toHaveBeenCalled();
  });

  it("rejects accessor/proxy observation clients without invoking their traps", async () => {
    let getterReads = 0;
    const accessorClient = {
      get getTransactionStatus() {
        getterReads += 1;
        return async () => includedFixture().status;
      },
      getTxByHash: async () => includedFixture().transaction,
      getBlockByNumber: async () => includedFixture().block,
    } as unknown as PayDemObservationClient;
    await expect(observePayDemTransferCore(HASH, accessorClient)).resolves.toEqual({
      status: "unavailable",
      reason: "transaction observation client is unstable",
    });
    expect(getterReads).toBe(0);

    let proxyReads = 0;
    const proxyClient = new Proxy(fixtureClient(), {
      get(target, property, receiver) {
        proxyReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    await expect(observePayDemTransferCore(HASH, proxyClient)).resolves.toEqual({
      status: "unavailable",
      reason: "transaction observation client is unstable",
    });
    expect(proxyReads).toBe(0);
  });

  it("rejects accessor/proxy RPC results without invoking their traps", async () => {
    let reads = 0;
    const accessorStatus = {
      get state() {
        reads += 1;
        return "included";
      },
      blockNumber: BLOCK_NUMBER,
    };
    await expect(observePayDemTransferCore(HASH, {
      getTransactionStatus: async () => accessorStatus,
      getTxByHash: async () => includedFixture().transaction,
      getBlockByNumber: async () => includedFixture().block,
    })).resolves.toEqual({
      status: "unavailable",
      reason: "transaction status read failed",
    });
    expect(reads).toBe(0);

    const proxyTransaction = new Proxy(includedFixture().transaction, {
      get(target, property, receiver) {
        // Promise resolution performs the language-level thenable probe. Count
        // only application field reads; the observer must perform none.
        if (property !== "then") reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    await expect(observePayDemTransferCore(HASH, {
      getTransactionStatus: async () => includedFixture().status,
      getTxByHash: async () => proxyTransaction,
      getBlockByNumber: async () => includedFixture().block,
    })).resolves.toEqual({
      status: "unavailable",
      reason: "included transaction facts are unavailable",
    });
    expect(reads).toBe(0);
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

  it("captures the RPC URL once when the observer is constructed", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify({
        result: 200,
        response: { state: "pending" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const config = { rpc: "https://trusted.example", fetchImpl };
    const observer = createPayDemSellerObserver(config);
    config.rpc = "https://substituted.example";

    await expect(observer.observeDemosTransfer(HASH)).resolves.toMatchObject({
      status: "pending",
    });
    expect(requestedUrls).toEqual(["https://trusted.example"]);
  });

  it("rejects accessor/proxy observer config without invoking traps", () => {
    let reads = 0;
    const accessorConfig = {
      get rpc() {
        reads += 1;
        return "https://node.example";
      },
    };
    expect(() => createPayDemSellerObserver(accessorConfig)).toThrow(
      /must be stable data/,
    );
    expect(reads).toBe(0);

    const proxyConfig = new Proxy({ rpc: "https://node.example" }, {
      get(target, property, receiver) {
        reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => createPayDemSellerObserver(proxyConfig)).toThrow(
      /must be stable data/,
    );
    expect(reads).toBe(0);
  });

  it("bounds response-body parsing even when an injected fetch ignores abort", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<never>(() => undefined),
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
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

  it("rejects an oversized declared response before decoding it", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<never>(() => undefined),
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "1000",
      },
    }));
    const observer = createPayDemSellerObserver({
      rpc: "https://node.example",
      maxResponseBytes: 100,
      fetchImpl,
    });

    await expect(observer.observeDemosTransfer(HASH)).resolves.toEqual({
      status: "unavailable",
      reason: "transaction status read failed",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cancelled).toBe(true);
  });

  it("bounds streamed decoded bytes when content-length is absent", async () => {
    const oversized = new TextEncoder().encode(JSON.stringify({
      result: 200,
      response: { state: "pending", padding: "x".repeat(200) },
    }));
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized.subarray(0, 50));
        controller.enqueue(oversized.subarray(50));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const observer = createPayDemSellerObserver({
      rpc: "https://node.example",
      maxResponseBytes: 100,
      fetchImpl,
    });

    await expect(observer.observeDemosTransfer(HASH)).resolves.toEqual({
      status: "unavailable",
      reason: "transaction status read failed",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cancelled).toBe(true);
  });

  it("rejects an invalid response-byte limit before making any request", () => {
    const fetchImpl = vi.fn();
    expect(() => createPayDemSellerObserver({
      rpc: "https://node.example",
      maxResponseBytes: 0,
      fetchImpl,
    })).toThrow(/maxResponseBytes must be a positive integer/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the standard observer reads recorded node2 envelopes (#338)", () => {
  // Raw nodeCall envelopes read from node2 (kynesyslabs/node
  // stabilisation@61b8e75), served through the observer's own transport.
  const node2 = JSON.parse(readFileSync(
    new URL("../fixtures/demos-node2-records.json", import.meta.url),
    "utf8",
  )) as Record<"getTransactionStatus" | "getTxByHash" | "getBlockByNumber",
    Record<string, unknown>>;
  const CONFIRMED_HASH = "330dcf1dac0839ebc138d5e2a0db6db7b9567d769c8d4bd987b0d72d7d905918";
  const FAILED_HASH = "85b8fcdcee48822742a39e1b9877f5e2f8dde36430e8e486e3a8b0c9a7744cbd";

  function node2Observer() {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const { params } = JSON.parse(String(init?.body)) as {
        params: Array<{
          message: keyof typeof node2;
          data: { hash?: string; blockNumber?: number };
        }>;
      };
      const { message, data } = params[0]!;
      const envelope = node2[message][String(data.hash ?? data.blockNumber)];
      if (envelope === undefined) throw new Error(`unrecorded ${message}`);
      return new Response(JSON.stringify(envelope), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    });
    return createPayDemSellerObserver({ rpc: "https://node2.example", fetchImpl });
  }

  it("attests execution and the signed nonce for the confirmed native send", async () => {
    const observation = await node2Observer().observeDemosTransfer(CONFIRMED_HASH);
    expect(observation).toEqual({
      status: "included",
      execution: "executed",
      nonce: 28,
      txHash: CONFIRMED_HASH,
      payer: "c0a58599ceaeba18f9c450133631cce4c45f4dc7a59c8026331504da3a913c2a",
      payee: "706b89f5e2d56498a90bc3a209842b0bd0e22ce06bb4df7c27805e655614e5f1",
      amountOs: "9500000000",
      blockNumber: 498_447,
      includedAt: 1_791_649_645_000,
    });
    // The default live observer's result is the SDK's attestation itself.
    expect(isDemosExecutedTransferObservation(observation)).toBe(true);
  });

  it("refuses the included status of the TX_NONCE_INVALID_LOW failed record", async () => {
    expect(node2.getTransactionStatus[FAILED_HASH]).toMatchObject({
      response: { state: "included", blockNumber: 480_877 },
    });
    await expect(node2Observer().observeDemosTransfer(FAILED_HASH)).resolves.toEqual({
      status: "invalid",
      reason: "transaction body does not represent included finality",
    });
  });
});

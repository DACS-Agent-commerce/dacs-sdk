import { afterEach, describe, expect, it, vi } from "vitest";

import { DemosChainIdentityError, captureWalletSpendPolicyV1 } from "@kynesyslabs/dacs";
import { TP1_APPROVED_IDENTITY_RECORD, WireError } from "@kynesyslabs/dacs/wire";

import { createDacsWalletSpendDemosReaderV1 } from "../src/walletSpendDemosReader.js";
import { DacsWalletSpendTestnetAuthorityError } from "../src/walletSpendTestnetSettings.js";
import {
  CONFIRMED_HASH,
  CONFIRMED_NONCE,
  DEMOS_WALLET,
  closeDemosNodeStubs,
  closedPortUrl,
  demosNodeStub,
  demosPolicy,
  recordedDemosState,
  recordedTransaction,
  type DemosNodeAnswer,
  type DemosNodeCall,
  type DemosNodeStub,
} from "./helpers/walletSpendDemosNode.js";

afterEach(async () => {
  vi.unstubAllGlobals();
  await closeDemosNodeStubs();
});

const APPROVED = TP1_APPROVED_IDENTITY_RECORD.chainIdentity;
const POLICY = captureWalletSpendPolicyV1(demosPolicy());
const SCOPE = Object.freeze({ wallet: DEMOS_WALLET, chainId: "demos", asset: "DEM" });
/** The identity check needs an https endpoint; the test routes this name to the loopback stub. */
const NODE_URL = "https://demos-node.test/";

const readerFor = (url: string, timeoutMs?: number) =>
  createDacsWalletSpendDemosReaderV1({ rpcUrl: url, policy: POLICY, ...(timeoutMs === undefined ? {} : { timeoutMs }) });

/** Sends the SDK adapter's own requests for `NODE_URL` to `target`. */
function routeNodeUrlTo(target: string): void {
  const loopbackFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
    loopbackFetch(String(input) === NODE_URL ? target : input, init));
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(() => undefined, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

async function startRefusal(target: string): Promise<DacsWalletSpendTestnetAuthorityError> {
  routeNodeUrlTo(target);
  const error = await refusal(readerFor(NODE_URL).assertNetwork());
  expect(error).toBeInstanceOf(DacsWalletSpendTestnetAuthorityError);
  return error as DacsWalletSpendTestnetAuthorityError;
}

const onlyIdentityReads = (calls: readonly DemosNodeCall[]) =>
  calls.every((call) => call.message === "getChainIdentity" || call.message === "getBlockByNumber");

const answering = (message: string, answer: DemosNodeAnswer) =>
  (call: DemosNodeCall) => (call.message === message ? answer : undefined);

describe("Demos reader for the testnet wallet-spend authority", () => {
  it("starts only against the approved testnet identity", async () => {
    const approved = await demosNodeStub(recordedDemosState(APPROVED));
    routeNodeUrlTo(approved.url);
    await expect(readerFor(NODE_URL).assertNetwork()).resolves.toBeUndefined();
    expect(approved.calls.map((call) => call.message)).toEqual([
      "getChainIdentity", "getBlockByNumber", "getBlockByNumber",
    ]);

    const otherChain = await demosNodeStub(recordedDemosState("ee".repeat(32)));
    const mismatch = await startRefusal(otherChain.url);
    expect(mismatch.reasonCode).toBe("wallet-spend-testnet-authority-demos-network-mismatch");
    // The approved-record comparison inside bindTp1Profile is what refuses it.
    expect(mismatch.cause).toBeInstanceOf(WireError);
    expect((mismatch.cause as WireError).code).toBe("tp1_connection_unverified");
    expect(onlyIdentityReads(otherChain.calls)).toBe(true);

    const identityDiffers = await demosNodeStub(recordedDemosState(APPROVED), {
      answer: answering("getChainIdentity", {
        status: 200,
        body: { result: 200, response: { chainId: null, genesisHash: "dd".repeat(32), genesisDataHash: "cc".repeat(32) } },
      }),
    });
    const differs = await startRefusal(identityDiffers.url);
    expect(differs.reasonCode).toBe("wallet-spend-testnet-authority-demos-network-mismatch");
    expect(differs.cause).toBeInstanceOf(DemosChainIdentityError);
    expect(onlyIdentityReads(identityDiffers.calls)).toBe(true);

    const closed = await startRefusal(await closedPortUrl());
    expect(closed.reasonCode).toBe("wallet-spend-testnet-authority-demos-node-unavailable");

    const notReady = await demosNodeStub(recordedDemosState(APPROVED), {
      answer: () => ({ status: 503, body: { result: 503, response: "not ready" } }),
    });
    const unavailable = await startRefusal(notReady.url);
    expect(unavailable.reasonCode).toBe("wallet-spend-testnet-authority-demos-node-unavailable");
    expect(unavailable.cause).toBeInstanceOf(DemosChainIdentityError);
    expect(onlyIdentityReads(notReady.calls)).toBe(true);

    // The approved-record binding takes only an https node address, so a plain http node is refused unread.
    const plainHttp = await demosNodeStub(recordedDemosState(APPROVED));
    const refused = await refusal(readerFor(plainHttp.url).assertNetwork());
    expect((refused as DacsWalletSpendTestnetAuthorityError).reasonCode)
      .toBe("wallet-spend-testnet-authority-demos-node-unavailable");
    expect(plainHttp.calls).toEqual([]);
  });

  it("reads the payer's DEM balance in OS within the policy scope", async () => {
    const node = await demosNodeStub(recordedDemosState(APPROVED));
    const reader = readerFor(node.url);
    await expect(reader.readBalance(SCOPE)).resolves.toBe("12000000000");
    await expect(reader.readBalance({ ...SCOPE, wallet: DEMOS_WALLET.toUpperCase().replace("0X", "0x") }))
      .resolves.toBe("12000000000");
    node.state.balance = 5;
    await expect(reader.readBalance(SCOPE)).resolves.toBe("5");
    expect(node.calls.find((call) => call.message === "getAddressInfo")?.data).toEqual({ address: DEMOS_WALLET });

    node.state.forkActivated = false;
    node.state.balance = 3;
    await expect(reader.readBalance(SCOPE)).resolves.toBe("3000000000");

    for (const [forkActivated, balance] of [[undefined, "1"], [true, null], [true, "-1"]] as const) {
      node.state.forkActivated = forkActivated;
      node.state.balance = balance;
      expect((await refusal(reader.readBalance(SCOPE))).message).toBe("wallet-spend-demos-rpc-response-invalid");
    }

    const before = node.calls.length;
    for (const scope of [
      { ...SCOPE, wallet: `0x${"ab".repeat(32)}` },
      { ...SCOPE, chainId: "eip155:84532" },
      { ...SCOPE, asset: "USDC" },
    ]) {
      expect((await refusal(reader.readBalance(scope))).message).toBe("wallet-spend-demos-rpc-scope-refused");
    }
    expect(node.calls.length).toBe(before);
  });

  it("reads the account nonce as the node's number or its { nonce } and plans the next one", async () => {
    const node = await demosNodeStub(recordedDemosState(APPROVED));
    const reader = readerFor(node.url);
    for (const answer of [7, "7", { nonce: 7 }, { nonce: "7" }, { nonce: 7, other: true }]) {
      node.state.accountNonce = answer;
      await expect(reader.readAccountNonce()).resolves.toBe(7);
      await expect(reader.plannedTransferNonce()).resolves.toBe(8);
    }
    expect(node.calls.find((call) => call.message === "getAddressNonce")?.data).toEqual({ address: DEMOS_WALLET });

    for (const answer of [
      undefined, null, "", "07", "-1", -1, 1.5, 2 ** 53, {}, { nonce: undefined }, { nonce: null }, { nonce: -1 },
      { nonce: 1.5 }, { nonce: 2 ** 53 }, { nonce: "07" }, { nonce: { nonce: 7 } }, { balance: 7 }, [7], [{ nonce: 7 }],
    ]) {
      node.state.accountNonce = answer;
      expect((await refusal(reader.readAccountNonce())).message).toBe("wallet-spend-demos-rpc-response-invalid");
      expect((await refusal(reader.plannedTransferNonce())).message).toBe("wallet-spend-demos-rpc-response-invalid");
    }
  });

  it("bounds every node call", async () => {
    const oversized = (declaredLength: boolean): DemosNodeAnswer => ({
      status: 200,
      body: { result: 200, response: { balance: "1", padding: "x".repeat(65 * 1024) } },
      declaredLength,
    });
    for (const declaredLength of [true, false]) {
      const node = await demosNodeStub(recordedDemosState(APPROVED), {
        answer: answering("getAddressInfo", oversized(declaredLength)),
      });
      const error = await refusal(readerFor(node.url).readBalance(SCOPE));
      expect(error.message).toBe("wallet-spend-demos-rpc-response-too-large");
      expect(error.message).not.toContain(node.url);
    }

    const endless = await demosNodeStub(recordedDemosState(APPROVED), {
      answer: answering("getAddressInfo", {
        status: 200, body: `{"result":200,"response":"${"x".repeat(16 * 1024 * 1024)}"}`, declaredLength: false,
      }),
    });
    expect((await refusal(readerFor(endless.url).readBalance(SCOPE))).message)
      .toBe("wallet-spend-demos-rpc-response-too-large");
    await vi.waitFor(() => expect(endless.cutShort).toBe(1));

    const largeRecord = await demosNodeStub(recordedDemosState(APPROVED), {
      answer: answering("getTxByHash", {
        status: 200, body: { result: 200, response: { ...recordedTransaction(CONFIRMED_HASH), padding: "x".repeat(65 * 1024) } },
      }),
    });
    const tooLargeRecord = await readerFor(largeRecord.url).observeTransfer(CONFIRMED_HASH);
    expect(tooLargeRecord.observation.status).toBe("unavailable");
    expect(tooLargeRecord.record).toBeUndefined();

    const blockOf = (bytes: number) => ({
      status: 200,
      body: {
        result: 200,
        response: {
          number: 498_447,
          status: "confirmed",
          hash: "0b".repeat(32),
          content: { ordered_transactions: [CONFIRMED_HASH], timestamp: 1_791_649_650, padding: "x".repeat(bytes) },
        },
      },
    });
    const threeMiB = await demosNodeStub(recordedDemosState(APPROVED), {
      answer: answering("getBlockByNumber", blockOf(3 * 1024 * 1024)),
    });
    expect((await readerFor(threeMiB.url).observeTransfer(CONFIRMED_HASH)).observation.status).toBe("included");
    const fiveMiB = await demosNodeStub(recordedDemosState(APPROVED), {
      answer: answering("getBlockByNumber", blockOf(5 * 1024 * 1024)),
    });
    expect((await readerFor(fiveMiB.url).observeTransfer(CONFIRMED_HASH)).observation.status).toBe("unavailable");

    const stalled = await demosNodeStub(recordedDemosState(APPROVED), {
      hold: (call) => (call.message === "getAddressInfo" ? new Promise<void>(() => undefined) : undefined),
    });
    expect((await refusal(readerFor(stalled.url, 50).readBalance(SCOPE))).message)
      .toBe("wallet-spend-demos-rpc-deadline-exceeded");

    for (const answer of [
      { status: 302, body: "" },
      { status: 200, body: { result: 500, response: { balance: "1" } } },
      { status: 200, body: "not json" },
    ]) {
      const node = await demosNodeStub(recordedDemosState(APPROVED), { answer: answering("getAddressInfo", answer) });
      expect((await refusal(readerFor(node.url).readBalance(SCOPE))).message)
        .toBe("wallet-spend-demos-rpc-response-invalid");
    }
  });

  it("observes a transfer through the SDK observation core and keeps its record", async () => {
    const node = await demosNodeStub(recordedDemosState(APPROVED));
    const seen = await readerFor(node.url).observeTransfer(CONFIRMED_HASH);
    expect(seen.observation).toMatchObject({
      status: "included", execution: "executed", nonce: CONFIRMED_NONCE, txHash: CONFIRMED_HASH,
    });
    expect(seen.record).toEqual(recordedTransaction(CONFIRMED_HASH));
    expect(node.calls.filter((call) => call.message === "getTxByHash")).toHaveLength(1);

    const statusAnswered = async (body: unknown): Promise<[Awaited<ReturnType<typeof observe>>, DemosNodeStub]> => {
      const stub = await demosNodeStub(recordedDemosState(APPROVED), {
        answer: answering("getTransactionStatus", { status: 200, body }),
      });
      return [await observe(stub.url), stub];
    };
    const observe = (url: string) => readerFor(url).observeTransfer(CONFIRMED_HASH);

    for (const body of [{ result: 400, response: "error" }, { result: 404, response: null }]) {
      const [notFound, stub] = await statusAnswered(body);
      expect(notFound.observation.status).toBe("not-found");
      expect(notFound.record).toBeUndefined();
      expect(stub.calls.some((call) => call.message === "getTxByHash")).toBe(false);
    }

    for (const body of [{ result: 400, response: "bad" }, { result: 500, response: "error" }]) {
      const [unavailable] = await statusAnswered(body);
      expect(unavailable.observation.status).toBe("unavailable");
      expect(unavailable.record).toBeUndefined();
    }
    const closed = await observe(await closedPortUrl());
    expect(closed.observation.status).toBe("unavailable");
    expect(closed.record).toBeUndefined();

    // The not-found mapping belongs to the status call only.
    const recordMissing = await demosNodeStub(recordedDemosState(APPROVED), {
      answer: answering("getTxByHash", { status: 200, body: { result: 400, response: "error" } }),
    });
    const afterIncluded = await observe(recordMissing.url);
    expect(afterIncluded.observation.status).toBe("unavailable");
    expect(afterIncluded.record).toBeUndefined();
  });
});

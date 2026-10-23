import { x402Client, x402HTTPClient } from "@x402/fetch";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import { createX402Rail } from "../../src/rails/x402.js";
import {
  createX402BuyerPaidRequestTransport,
  prepareX402BuyerSettlement,
  type X402BuyerChallengeClient,
  type X402BuyerPreparationAuthority,
} from "../../src/rails/x402BuyerTransport.js";
import {
  advanceX402BuyerSettlement,
  createInMemoryX402BuyerSettlementStore,
  x402BuyerSettlementAuthenticationHash,
  type X402BuyerEffectFence,
} from "../../src/rails/x402BuyerSettlement.js";
import {
  createX402BuyerEvmAuthorizationProvider,
  EIP3009_AUTHORIZATION_USED_TOPIC,
  ERC20_TRANSFER_TOPIC,
  type X402BuyerEvmLog,
  type X402BuyerEvmReadClient,
} from "../../src/rails/x402BuyerEvmAuthorization.js";
import type { EvmTransferFinalityClient } from "../../src/rails/evmTransferFinality.js";
import type {
  DacsPublicHttpsRequestV1,
  X402OutboundTransportPolicy,
} from "../../src/rails/x402Outbound.js";

const peers = vi.hoisted(() => ({
  createPublicClient: vi.fn(),
  signTypedData: vi.fn(async () => `0x${"44".repeat(65)}`),
}));

// No wallet or RPC: only the signing/read boundaries are replaced. Both SDK
// finality verifiers and the production outbound policy execute normally.
vi.mock("viem/accounts", () => ({
  privateKeyToAccount: vi.fn(() => ({
    address: `0x${"11".repeat(20)}`,
    signTypedData: peers.signTypedData,
  })),
}));
vi.mock("viem", async (importOriginal) => ({
  ...await importOriginal<typeof import("viem")>(),
  createPublicClient: peers.createPublicClient,
}));
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(() => { throw new Error("unexpected real DNS lookup"); }),
}));
vi.mock("node:https", () => ({
  request: vi.fn(() => { throw new Error("unexpected real HTTPS request"); }),
}));

const JOB_ID = "job-x402-production-positive";
const PHASE_INDEX = 2;
const CHAIN_ID = 84532;
const NETWORK = `eip155:${CHAIN_ID}` as const;
const PAYER = `0x${"11".repeat(20)}`;
const PAYEE = `0x${"22".repeat(20)}`;
const ASSET = `0x${"33".repeat(20)}`;
const AMOUNT = "1000";
const TX = `0x${"aa".repeat(32)}`;
const BLOCK_HASH = `0x${"bb".repeat(32)}`;
const HEAD_HASH = `0x${"cc".repeat(32)}`;
const RESOURCE = `https://seller.example/deliver/${JOB_ID}`;
const NONCE = `0x${sha256Hex(`dacs-sb3:v1:${JOB_ID}:${PHASE_INDEX}`)}`;
const NOW = 1_700_000_000_000;
const POLICY = {
  mode: "production",
  timeoutMs: 2_345,
  maxResponseBytes: 16_384,
  maxHeaderBytes: 8_192,
} as const satisfies X402OutboundTransportPolicy;
// Globally routable IPv4/IPv6, never TEST-NET. Each request pins its own answer.
const RESOLVED = [
  ["8.8.8.8", "2606:4700:4700::1111"],
  ["1.1.1.1", "2001:4860:4860::8888"],
] as const;
const REQUIREMENTS = {
  scheme: "exact",
  network: NETWORK,
  amount: AMOUNT,
  asset: ASSET,
  payTo: PAYEE,
  maxTimeoutSeconds: 120,
  extra: { name: "USD Coin", version: "2" },
};
const CHALLENGE = {
  x402Version: 2,
  resource: { url: RESOURCE, mimeType: "application/json" },
  accepts: [REQUIREMENTS],
  extensions: {},
};
const SETTLEMENT = {
  success: true,
  transaction: TX,
  network: NETWORK,
  payer: PAYER,
  amount: AMOUNT,
  extensions: { retained: "production-positive" },
};
const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64");
const DISCLOSURE = {
  protocolVersion: "2",
  headerName: "PAYMENT-RESPONSE",
  encodedSettlementHeader: encode(SETTLEMENT),
  httpResource: RESOURCE,
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("unexpected fetch outside the production HTTPS seam");
  });
});
afterEach(() => vi.restoreAllMocks());

function authority(): X402BuyerPreparationAuthority {
  return {
    jobId: JOB_ID,
    phaseIndex: PHASE_INDEX,
    railId: "x402-production",
    railVersion: "2",
    railDescriptorHash: "a".repeat(64),
    agreementHash: "b".repeat(64),
    termsHash: "c".repeat(64),
    sessionBindingHash: "d".repeat(64),
    network: NETWORK,
    payer: PAYER,
    payee: PAYEE,
    asset: ASSET,
    amount: AMOUNT,
    httpResource: RESOURCE,
    method: "GET",
  };
}

function buyerClient(): X402BuyerChallengeClient {
  return new x402HTTPClient(new x402Client().register(NETWORK, {
    scheme: "exact",
    async createPaymentPayload(version, requirements) {
      expect(version).toBe(2);
      expect(requirements).toEqual(REQUIREMENTS);
      return {
        x402Version: version,
        payload: {
          authorization: {
            from: PAYER,
            to: PAYEE,
            value: AMOUNT,
            validAfter: "0",
            validBefore: "4102444800",
            nonce: NONCE,
          },
          signature: `0x${"44".repeat(65)}`,
        },
      };
    },
  }));
}

function publicHttps() {
  const events: string[] = [];
  const resolveHost = vi.fn(async (hostname: string) => {
    expect(hostname).toBe("seller.example");
    const index = resolveHost.mock.calls.length - 1;
    expect(index).toBeLessThan(2);
    events.push(`resolve:${index}`);
    return RESOLVED[index]!;
  });
  const request = vi.fn(async (input: Readonly<DacsPublicHttpsRequestV1>) => {
    const index = request.mock.calls.length - 1;
    expect(index).toBeLessThan(2);
    expect(resolveHost).toHaveBeenCalledTimes(index + 1);
    expect(input.url).toBe(RESOURCE);
    expect(new URL(input.url).protocol).toBe("https:");
    expect(input.approvedAddresses).toEqual(RESOLVED[index]);
    expect(input.timeoutMs).toBe(POLICY.timeoutMs);
    expect(input.maxBytes).toBe(POLICY.maxResponseBytes);
    expect(input.maxHeaderBytes).toBe(POLICY.maxHeaderBytes);
    expect(input.signal).toBeInstanceOf(AbortSignal);
    expect(input.signal.aborted).toBe(false);
    expect(input.headers.get("accept")).toBe("application/json");
    expect(input.headers.has("x-payment")).toBe(false);
    expect(input.headers.has("payment-signature")).toBe(index === 1);
    events.push(`request:${index}`);
    if (index === 1) expect(input.beforeConnect).toBeTypeOf("function");
    await input.beforeConnect?.();
    events.push(`connect:${index}`);
    if (index === 0) {
      return new Response(JSON.stringify(CHALLENGE), {
        status: 402,
        headers: { "PAYMENT-REQUIRED": encode(CHALLENGE) },
      });
    }
    return new Response(JSON.stringify({ data: "ok" }), {
      status: 200,
      headers: { "PAYMENT-RESPONSE": DISCLOSURE.encodedSettlementHeader },
    });
  });
  return { resolveHost, request, events, dependencies: { resolveHost, request } };
}

async function prepare(https: ReturnType<typeof publicHttps>) {
  const result = await prepareX402BuyerSettlement({
    authority: authority(),
    challengeHeaders: { accept: "application/json" },
  }, {
    client: buyerClient(),
    transportPolicy: POLICY,
    publicHttpsDependencies: https.dependencies,
  });
  if (result.disposition !== "prepared") throw new Error(result.reason);
  expect(https.request).toHaveBeenCalledOnce();
  expect(result.intent.authorizationNonce).toBe(NONCE);
  return result.intent;
}

function expectRequests(https: ReturnType<typeof publicHttps>, paymentHeader?: string) {
  expect(https.resolveHost.mock.calls).toEqual([["seller.example"], ["seller.example"]]);
  expect(https.request).toHaveBeenCalledTimes(2);
  expect(https.request.mock.calls.map(([input]) => ({
    url: input.url,
    addresses: input.approvedAddresses,
    payment: input.headers.get("payment-signature"),
  }))).toEqual([
    { url: RESOURCE, addresses: RESOLVED[0], payment: null },
    {
      url: RESOURCE,
      addresses: RESOLVED[1],
      payment: paymentHeader ?? expect.any(String),
    },
  ]);
  const paid = https.request.mock.calls[1]![0];
  expect(JSON.parse(Buffer.from(paid.headers.get("payment-signature")!, "base64")
    .toString("utf8"))).toMatchObject({
    x402Version: 2,
    resource: CHALLENGE.resource,
    accepted: REQUIREMENTS,
    payload: { authorization: { from: PAYER, to: PAYEE, value: AMOUNT, nonce: NONCE } },
  });
  expect(globalThis.fetch).not.toHaveBeenCalled();
}

const addressTopic = (address: string): string =>
  `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
const USED_LOG: X402BuyerEvmLog = {
  address: ASSET,
  topics: [EIP3009_AUTHORIZATION_USED_TOPIC, addressTopic(PAYER), NONCE],
  data: "0x",
  transactionHash: TX,
  blockNumber: 100,
  blockHash: BLOCK_HASH,
  logIndex: 5,
  removed: false,
};
const TRANSFER_LOG: X402BuyerEvmLog = {
  ...USED_LOG,
  topics: [ERC20_TRANSFER_TOPIC, addressTopic(PAYER), addressTopic(PAYEE)],
  data: `0x${BigInt(AMOUNT).toString(16).padStart(64, "0")}`,
  logIndex: 7,
};

function independentReader(canonical: boolean) {
  const confirmBlockAncestor = vi.fn(async (
    input: Parameters<X402BuyerEvmReadClient["confirmBlockAncestor"]>[0],
  ) => ({ ...input, canonical }));
  const getTransactionReceipt = vi.fn(async (hash: string) => {
    expect(hash).toBe(TX);
    return {
      transactionHash: TX,
      blockNumber: 100,
      blockHash: BLOCK_HASH,
      status: "success",
      logs: [USED_LOG, TRANSFER_LOG],
    };
  });
  const client: X402BuyerEvmReadClient = {
    getFinalityHead: async () => ({
      chainId: CHAIN_ID, blockNumber: 110, blockHash: HEAD_HASH, timestamp: NOW / 1_000,
    }),
    getLogs: async ({ topics }) =>
      topics[0] === EIP3009_AUTHORIZATION_USED_TOPIC ? [USED_LOG] : [],
    getTransactionReceipt,
    readAuthorizationState: async ({ blockNumber, blockHash }) => ({
      used: true, blockNumber, blockHash,
    }),
    confirmBlockAncestor,
  };
  return { client, getTransactionReceipt, confirmBlockAncestor };
}

function railReader(exactTransfer: boolean) {
  const receipt = {
    transactionHash: TX,
    blockNumber: 100n,
    blockHash: BLOCK_HASH,
    status: "success",
    logs: exactTransfer ? [{ ...TRANSFER_LOG, blockNumber: 100n }] : [],
  };
  const getBlock = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => {
    expect([100n, 101n]).toContain(blockNumber);
    return {
      number: blockNumber,
      hash: blockNumber === 100n ? BLOCK_HASH : HEAD_HASH,
      parentHash: blockNumber === 100n ? `0x${"dd".repeat(32)}` : BLOCK_HASH,
      timestamp: 1_700_000_010n + (blockNumber - 100n),
    };
  });
  const client = {
    getChainId: vi.fn(async () => CHAIN_ID),
    waitForTransactionReceipt: vi.fn(async () => receipt),
    getTransactionReceipt: vi.fn(async () => receipt),
    getBlock,
  } satisfies EvmTransferFinalityClient;
  peers.createPublicClient.mockReturnValue(client);
  return client;
}

describe("x402 production transport positive flow", () => {
  test("prepares the challenge and returns the paid response with DNS pins and an adjacent fence", async () => {
    const https = publicHttps();
    const intent = await prepare(https);
    const assertCurrent = vi.fn(async () => { https.events.push("fence"); });
    const fence: X402BuyerEffectFence = {
      owner: "buyer-worker",
      generation: 1,
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      idempotencyKey: intent.settlementKey,
      assertCurrent,
    };
    const transport = createX402BuyerPaidRequestTransport({
      headers: { accept: "application/json" },
      transportPolicy: POLICY,
      publicHttpsDependencies: https.dependencies,
    });
    await expect(transport.submitRetained(intent, fence)).resolves.toEqual({
      disposition: "response", disclosure: DISCLOSURE,
    });
    expectRequests(https, intent.paymentHeader.value);
    expect(assertCurrent).toHaveBeenCalledOnce();
    expect(https.events).toEqual([
      "resolve:0", "request:0", "connect:0",
      "resolve:1", "request:1", "fence", "connect:1",
    ]);
  });

  test.each([true, false])(
    "prepared settlement requires independent canonical finality (canonical=%s)",
    async (canonical) => {
      const https = publicHttps();
      const intent = await prepare(https);
      const store = createInMemoryX402BuyerSettlementStore();
      const reader = independentReader(canonical);
      const provider = createX402BuyerEvmAuthorizationProvider({
        chainId: CHAIN_ID,
        minimumConfirmations: 5,
        authorizationSearchFromBlock: 1,
        client: reader.client,
        authorizeIntent: async ({ intent: checked }) => ({
          disposition: "authorized", bindingHash: checked.bindingHash,
        }),
        verifySignature: async ({ authorization }) => ({
          disposition: "valid", signer: authorization.from,
        }),
      });
      const authenticate = vi.fn(provider.authenticate);
      const transport = createX402BuyerPaidRequestTransport({
        headers: { accept: "application/json" },
        transportPolicy: POLICY,
        publicHttpsDependencies: https.dependencies,
      });
      const submit = vi.fn(transport.submitRetained);
      const result = await advanceX402BuyerSettlement({
        intent, store, owner: "buyer-worker",
        authorizationProvider: { ...provider, authenticate },
        transport: { submitRetained: submit }, now: () => NOW,
      });
      expectRequests(https, intent.paymentHeader.value);
      expect(submit).toHaveBeenCalledOnce();
      expect(await submit.mock.results[0]!.value).toEqual({
        disposition: "response", disclosure: DISCLOSURE,
      });
      expect(authenticate).toHaveBeenCalledOnce();
      expect(reader.getTransactionReceipt).toHaveBeenCalledWith(TX);
      expect(reader.confirmBlockAncestor).toHaveBeenCalledWith({
        blockNumber: 100, blockHash: BLOCK_HASH,
        headBlockNumber: 110, headBlockHash: HEAD_HASH,
      });
      if (canonical) {
        expect(result.status).toBe("captured");
        if (result.status !== "captured") throw new Error("settlement not captured");
        const settlement = result.outcome.settlement;
        expect(settlement).toMatchObject({
          ...DISCLOSURE,
          signedEvent: {
            kind: "x402-event", httpResource: RESOURCE,
            paymentReceiptHash: sha256Hex(canonicalize(SETTLEMENT)),
            settlementTxHash: TX.slice(2), chainId: CHAIN_ID, logIndex: 7,
          },
          authenticationHash: x402BuyerSettlementAuthenticationHash({
            intent, signedEvent: settlement.signedEvent,
          }),
        });
        await expect(store.load(intent.settlementKey)).resolves.toMatchObject({
          status: "captured", outcome: result.outcome,
        });
      } else {
        expect(result).toEqual({
          status: "indeterminate", reason: "eip3009-settlement-not-finalized",
        });
        await expect(store.load(intent.settlementKey)).resolves.toMatchObject({
          status: "held", pendingDisclosure: DISCLOSURE,
        });
      }
    },
  );

  test.each([true, false])(
    "createX402Rail authenticates the chain Transfer after production HTTPS (exactTransfer=%s)",
    async (exactTransfer) => {
      const https = publicHttps();
      const reader = railReader(exactTransfer);
      const rail = await createX402Rail({
        evmPrivateKey: "offline-mocked-signer",
        requireSessionBinding: true,
        rpcUrl: "https://rpc.example",
        finalityBlocks: 2,
        transportPolicy: POLICY,
        publicHttpsDependencies: https.dependencies,
      });
      const assertCurrent = vi.fn(async () => { https.events.push("fence"); });
      const settling = rail.settle({
        paywallUrl: RESOURCE, network: NETWORK, recipientEvm: PAYEE,
        amount: AMOUNT, asset: ASSET, jobId: JOB_ID, phaseIndex: PHASE_INDEX,
        requestInit: { headers: { accept: "application/json" } },
      }, { assertCurrent });
      if (exactTransfer) {
        await expect(settling).resolves.toMatchObject({
          ok: true, txHash: TX, payer: PAYER, payee: PAYEE, chainId: NETWORK,
          blockNumber: 100,
          finality: { model: "block-depth", finalityBlocks: 2 },
          finalityObservedAt: 1_700_000_011_000,
          txRef: {
            kind: "x402-event", httpResource: RESOURCE,
            paymentReceiptHash: sha256Hex(canonicalize(SETTLEMENT)),
            settlementTxHash: TX.slice(2), chainId: CHAIN_ID, logIndex: 7,
          },
          x402Receipt: {
            protocolVersion: "2", headerName: "PAYMENT-RESPONSE",
            headerValue: DISCLOSURE.encodedSettlementHeader,
            paymentReceiptHash: sha256Hex(canonicalize(SETTLEMENT)),
          },
        });
      } else {
        await expect(settling).rejects.toThrow("exact ERC-20 Transfer event is missing");
      }
      expectRequests(https);
      expect(peers.signTypedData).toHaveBeenCalledOnce();
      expect(reader.waitForTransactionReceipt).toHaveBeenCalledWith({
        hash: TX, confirmations: 2,
      });
      expect(reader.getTransactionReceipt).toHaveBeenCalledWith({ hash: TX });
      expect(reader.getBlock).toHaveBeenCalledWith({ blockNumber: 101n });
      expect(assertCurrent).toHaveBeenCalledOnce();
      expect(https.events).toEqual([
        "resolve:0", "request:0", "connect:0",
        "resolve:1", "request:1", "fence", "connect:1",
      ]);
    },
  );
});

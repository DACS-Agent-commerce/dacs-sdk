import { describe, expect, test, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, stringToHex } from "viem";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import {
  advanceX402BuyerSettlement,
  createInMemoryX402BuyerSettlementStore,
  createX402BuyerSettlementIntent,
  x402BuyerSettlementAuthenticationHash,
  type X402BuyerEffectFence,
  type X402BuyerSettlementDisclosure,
  type X402BuyerSettlementIntent,
  type X402BuyerSettlementIntentDraft,
} from "../../src/rails/x402BuyerSettlement.js";
import {
  EIP3009_AUTHORIZATION_CANCELED_TOPIC,
  EIP3009_AUTHORIZATION_USED_TOPIC,
  ERC20_TRANSFER_TOPIC,
  createX402BuyerEvmAuthorizationProvider,
  type X402BuyerEvmAuthorizationProviderOptions,
  type X402BuyerEvmLog,
  type X402BuyerEvmReadClient,
  type X402BuyerEvmTransactionReceipt,
} from "../../src/rails/x402BuyerEvmAuthorization.js";
import { createViemX402BuyerEvmReadClient } from "../../src/rails/x402BuyerEvmViem.js";

const CHAIN_ID = 84532;
const NETWORK = `eip155:${CHAIN_ID}` as const;
const PAYER = `0x${"11".repeat(20)}` as `0x${string}`;
const PAYEE = `0x${"22".repeat(20)}` as `0x${string}`;
const ASSET = `0x${"33".repeat(20)}` as `0x${string}`;
const TX = `0x${"aa".repeat(32)}` as `0x${string}`;
const BLOCK_HASH = `0x${"bb".repeat(32)}` as `0x${string}`;
const HEAD_HASH = `0x${"cc".repeat(32)}` as `0x${string}`;
const RESOURCE = "https://seller.example/deliver/job-evm-provider";
const JOB_ID = "job-evm-provider";
const PHASE_INDEX = 2;
const AMOUNT = "1000";

const nonce = (): `0x${string}` =>
  `0x${sha256Hex(`dacs-sb3:v1:${JOB_ID}:${PHASE_INDEX}`)}`;

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function intentDraft(overrides: Partial<X402BuyerSettlementIntentDraft> = {}): X402BuyerSettlementIntentDraft {
  const chosenRequirements = {
    scheme: "exact",
    network: NETWORK,
    amount: AMOUNT,
    asset: ASSET,
    payTo: PAYEE,
    maxTimeoutSeconds: 120,
    extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
  };
  const signedPaymentPayload = {
    x402Version: 2,
    resource: { url: RESOURCE },
    accepted: chosenRequirements,
    payload: {
      authorization: {
        from: PAYER,
        to: PAYEE,
        value: AMOUNT,
        validAfter: "0",
        validBefore: "4102444800",
        nonce: nonce(),
      },
      signature: `0x${"44".repeat(65)}`,
    },
  };
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
    chosenRequirements,
    signedPaymentPayload,
    paymentHeader: { name: "PAYMENT-SIGNATURE", value: encode(signedPaymentPayload) },
    authorizationNonce: nonce(),
    ...overrides,
  };
}

function makeIntent(): Readonly<X402BuyerSettlementIntent> {
  return createX402BuyerSettlementIntent(intentDraft());
}

function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    success: true,
    transaction: TX,
    network: NETWORK,
    payer: PAYER,
    amount: AMOUNT,
    ...overrides,
  };
}

function disclosure(overrides: Partial<X402BuyerSettlementDisclosure> = {}): X402BuyerSettlementDisclosure {
  return {
    protocolVersion: "2",
    headerName: "PAYMENT-RESPONSE",
    encodedSettlementHeader: encode(response()),
    httpResource: RESOURCE,
    ...overrides,
  };
}

function addressTopic(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function uintData(value: string): string {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function log(overrides: Partial<X402BuyerEvmLog> = {}): X402BuyerEvmLog {
  return {
    address: ASSET,
    topics: [EIP3009_AUTHORIZATION_USED_TOPIC, addressTopic(PAYER), nonce()],
    data: "0x",
    transactionHash: TX,
    blockNumber: 100,
    blockHash: BLOCK_HASH,
    logIndex: 5,
    removed: false,
    ...overrides,
  };
}

function transfer(overrides: Partial<X402BuyerEvmLog> = {}): X402BuyerEvmLog {
  return log({
    topics: [ERC20_TRANSFER_TOPIC, addressTopic(PAYER), addressTopic(PAYEE)],
    data: uintData(AMOUNT),
    logIndex: 7,
    ...overrides,
  });
}

function receipt(overrides: Partial<X402BuyerEvmTransactionReceipt> = {}): X402BuyerEvmTransactionReceipt {
  return {
    transactionHash: TX,
    blockNumber: 100,
    blockHash: BLOCK_HASH,
    status: "success",
    logs: [log(), transfer()],
    ...overrides,
  };
}

interface ReaderState {
  chainId: number;
  headBlock: number;
  headTimestamp: number;
  used: unknown;
  cancelled: unknown;
  authorizationUsed: boolean;
  receipt: unknown;
  ancestryCanonical: boolean;
  throwAt?: "head" | "logs" | "state" | "receipt" | "ancestry";
}

function reader(overrides: Partial<ReaderState> = {}): X402BuyerEvmReadClient {
  const state: ReaderState = {
    chainId: CHAIN_ID,
    headBlock: 110,
    headTimestamp: 2_000,
    used: [log()],
    cancelled: [],
    authorizationUsed: true,
    receipt: receipt(),
    ancestryCanonical: true,
    ...overrides,
  };
  return {
    async getFinalityHead() {
      if (state.throwAt === "head") throw new Error("head unavailable");
      return {
        chainId: state.chainId,
        blockNumber: state.headBlock,
        blockHash: HEAD_HASH,
        timestamp: state.headTimestamp,
      };
    },
    async getLogs(input) {
      if (state.throwAt === "logs") throw new Error("logs unavailable");
      return input.topics[0] === EIP3009_AUTHORIZATION_USED_TOPIC
        ? state.used : state.cancelled;
    },
    async getTransactionReceipt() {
      if (state.throwAt === "receipt") throw new Error("receipt unavailable");
      return state.receipt;
    },
    async readAuthorizationState(input) {
      if (state.throwAt === "state") throw new Error("state unavailable");
      return {
        used: state.authorizationUsed,
        blockNumber: input.blockNumber,
        blockHash: input.blockHash,
      };
    },
    async confirmBlockAncestor(input) {
      if (state.throwAt === "ancestry") throw new Error("ancestry unavailable");
      return {
        canonical: state.ancestryCanonical,
        ...input,
      };
    },
  };
}

function fence(): Readonly<X402BuyerEffectFence> {
  return Object.freeze({
    owner: "test-worker",
    generation: 1,
    settlementKey: "test-key",
    bindingHash: "a".repeat(64),
    idempotencyKey: "test-key",
    assertCurrent: vi.fn(async () => undefined),
  });
}

function provider(
  client: X402BuyerEvmReadClient = reader(),
  overrides: Partial<X402BuyerEvmAuthorizationProviderOptions> = {},
) {
  const config: X402BuyerEvmAuthorizationProviderOptions = {
    chainId: CHAIN_ID,
    minimumConfirmations: 5,
    authorizationSearchFromBlock: 1,
    client,
    authorizeIntent: async ({ intent }) => ({
      disposition: "authorized",
      bindingHash: intent.bindingHash,
    }),
    verifySignature: async ({ authorization }) => ({
      disposition: "valid",
      signer: authorization.from,
    }),
    confirmUnused: async ({ intent }) => ({
      disposition: "safe",
      bindingHash: intent.bindingHash,
    }),
    ...overrides,
  };
  if (Object.prototype.hasOwnProperty.call(overrides, "confirmUnused") &&
      overrides.confirmUnused === undefined) delete config.confirmUnused;
  return createX402BuyerEvmAuthorizationProvider(config);
}

async function reconcile(
  customProvider = provider(),
  candidate: X402BuyerSettlementDisclosure | null = disclosure(),
) {
  const intent = makeIntent();
  const effectFence = fence();
  const presented = candidate === null ? undefined : candidate;
  const lookup = await customProvider.lookup(intent, presented, effectFence);
  if (lookup.disposition !== "observed") return { intent, lookup, result: undefined };
  const result = await customProvider.authenticate(intent, lookup, presented, effectFence);
  return { intent, lookup, result };
}

describe("x402 buyer EVM authorization provider", () => {
  test("pins the EIP-3009 and ERC-20 event topics to viem keccak", () => {
    expect(EIP3009_AUTHORIZATION_USED_TOPIC).toBe(
      keccak256(stringToHex("AuthorizationUsed(address,bytes32)")),
    );
    expect(EIP3009_AUTHORIZATION_CANCELED_TOPIC).toBe(
      keccak256(stringToHex("AuthorizationCanceled(address,bytes32)")),
    );
    expect(ERC20_TRANSFER_TOPIC).toBe(
      keccak256(stringToHex("Transfer(address,address,uint256)")),
    );
  });

  test("authenticates the exact intent and binds both independent callbacks", async () => {
    const authority = vi.fn(async ({ intent }: { intent: X402BuyerSettlementIntent }) => ({
      disposition: "authorized",
      bindingHash: intent.bindingHash,
    }));
    const signature = vi.fn(async ({ authorization }: { authorization: { from: string } }) => ({
      disposition: "valid",
      signer: authorization.from,
    }));
    const intent = makeIntent();
    const result = await provider(reader(), {
      authorizeIntent: authority as X402BuyerEvmAuthorizationProviderOptions["authorizeIntent"],
      verifySignature: signature as X402BuyerEvmAuthorizationProviderOptions["verifySignature"],
    }).authorizeIntent(intent, fence());
    expect(result).toEqual({ disposition: "authorized", bindingHash: intent.bindingHash });
    expect(authority).toHaveBeenCalledOnce();
    expect(signature).toHaveBeenCalledOnce();
    expect(Object.isFrozen(authority.mock.calls[0]![0].intent)).toBe(true);
  });

  test("rejects a non-EIP-3009 challenge before any authority callback", async () => {
    const draft = intentDraft();
    (draft.chosenRequirements.extra as Record<string, unknown>).assetTransferMethod = "permit2";
    const payload = draft.signedPaymentPayload as Record<string, unknown>;
    draft.paymentHeader = { name: "PAYMENT-SIGNATURE", value: encode(payload) };
    const intent = createX402BuyerSettlementIntent(draft);
    const authority = vi.fn(async () => ({
      disposition: "authorized",
      bindingHash: intent.bindingHash,
    }));
    const result = await provider(reader(), {
      authorizeIntent: authority,
    }).authorizeIntent(intent, fence());
    expect(result).toEqual({ disposition: "rejected", reason: "eip3009-intent-invalid" });
    expect(authority).not.toHaveBeenCalled();
  });

  test("captures only a finalized nonce use plus the exact ERC-20 Transfer", async () => {
    const { intent, result } = await reconcile();
    expect(result).toMatchObject({
      disposition: "settled-same",
      settlement: {
        signedEvent: {
          settlementTxHash: TX.slice(2),
          chainId: CHAIN_ID,
          logIndex: 7,
        },
      },
    });
    if (result?.disposition !== "settled-same") throw new Error("not settled");
    const expectedReceiptHash = sha256Hex(canonicalize(response()));
    expect(result.settlement.signedEvent.paymentReceiptHash).toBe(expectedReceiptHash);
    expect(result.settlement.authenticationHash).toBe(
      x402BuyerSettlementAuthenticationHash({
        intent,
        signedEvent: result.settlement.signedEvent,
      }),
    );
  });

  test("drives advanceX402BuyerSettlement through the public provider", async () => {
    const intent = makeIntent();
    const result = await advanceX402BuyerSettlement({
      intent,
      owner: "worker",
      store: createInMemoryX402BuyerSettlementStore(),
      authorizationProvider: provider(),
      transport: {
        async submitRetained(_intent, effectFence) {
          await effectFence.assertCurrent();
          return { disposition: "response", disclosure: disclosure() };
        },
      },
      now: () => 1_000,
    });
    expect(result.status).toBe("captured");
  });

  test("retains a response across delayed finality without disclosure recovery or resubmission", async () => {
    const intent = makeIntent();
    const store = createInMemoryX402BuyerSettlementStore();
    let now = 1_000;
    let submits = 0;
    const first = await advanceX402BuyerSettlement({
      intent,
      owner: "worker-a",
      store,
      authorizationProvider: provider(reader({ headBlock: 102 })),
      transport: {
        async submitRetained(_received, effectFence) {
          submits += 1;
          await effectFence.assertCurrent();
          return { disposition: "response", disclosure: disclosure() };
        },
      },
      now: () => now,
      leaseDurationMs: 10,
    });
    expect(first).toEqual({
      status: "indeterminate",
      reason: "eip3009-settlement-not-finalized",
    });
    await expect(store.load(intent.settlementKey)).resolves.toMatchObject({
      status: "held",
      pendingDisclosure: disclosure(),
    });

    now = 1_011;
    const recovered = await advanceX402BuyerSettlement({
      intent,
      owner: "worker-b",
      store,
      authorizationProvider: provider(reader({ headBlock: 110 })),
      transport: {
        async submitRetained() {
          submits += 1;
          throw new Error("must not resubmit while adopting retained disclosure");
        },
      },
      now: () => now,
      leaseDurationMs: 10,
    });
    expect(recovered.status).toBe("captured");
    expect(submits).toBe(1);
  });

  test.each([
    ["chain", reader({ chainId: 1 })],
    ["event nonce", reader({ used: [log({ topics: [
      EIP3009_AUTHORIZATION_USED_TOPIC,
      addressTopic(PAYER),
      `0x${"00".repeat(32)}`,
    ] })] })],
    ["event asset", reader({ used: [log({ address: `0x${"99".repeat(20)}` })] })],
  ])("rejects an invalid %s observation before authentication", async (_label, client) => {
    const { lookup } = await reconcile(provider(client));
    expect(lookup.disposition).toBe("unavailable");
  });

  test.each([
    ["asset", transfer({ address: `0x${"99".repeat(20)}` })],
    ["payer", transfer({ topics: [ERC20_TRANSFER_TOPIC, addressTopic(`0x${"99".repeat(20)}`), addressTopic(PAYEE)] })],
    ["payee", transfer({ topics: [ERC20_TRANSFER_TOPIC, addressTopic(PAYER), addressTopic(`0x${"99".repeat(20)}`)] })],
    ["amount", transfer({ data: uintData("1001") })],
  ])("classifies a nonce consumed with wrong %s as used-different", async (_label, wrongTransfer) => {
    const customReceipt = receipt({ logs: [log(), wrongTransfer] });
    const { result } = await reconcile(provider(reader({ receipt: customReceipt })));
    expect(result).toMatchObject({
      disposition: "used-different",
      reason: "eip3009-authorization-used-without-agreed-transfer",
      authenticationHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  test.each([
    ["reverted", receipt({ status: "reverted" })],
    ["wrong tx", receipt({ transactionHash: `0x${"dd".repeat(32)}` })],
    ["wrong block", receipt({ blockHash: `0x${"dd".repeat(32)}` })],
    ["missing nonce log", receipt({ logs: [transfer()] })],
    ["duplicate log index", receipt({ logs: [log(), transfer({ logIndex: 5 })] })],
  ])("keeps a %s receipt indeterminate", async (_label, malformedReceipt) => {
    const { result } = await reconcile(provider(reader({ receipt: malformedReceipt })));
    expect(result?.disposition).toBe("indeterminate");
  });

  test("requires the configured confirmation depth", async () => {
    const { result } = await reconcile(provider(reader({ headBlock: 102 })));
    expect(result).toEqual({
      disposition: "indeterminate",
      reason: "eip3009-settlement-not-finalized",
    });
  });

  test("requires an explicit canonical ancestry proof from receipt block to finality head", async () => {
    const { result } = await reconcile(provider(reader({ ancestryCanonical: false })));
    expect(result).toEqual({
      disposition: "indeterminate",
      reason: "eip3009-settlement-not-finalized",
    });
  });

  test("does not choose between duplicate exact transfers", async () => {
    const customReceipt = receipt({
      logs: [log(), transfer(), transfer({ logIndex: 8 })],
    });
    const { result } = await reconcile(provider(reader({ receipt: customReceipt })));
    expect(result).toEqual({
      disposition: "indeterminate",
      reason: "erc20-transfer-events-ambiguous",
    });
  });

  test("authenticates a finalized AuthorizationCanceled event as terminal", async () => {
    const cancelled = log({
      topics: [EIP3009_AUTHORIZATION_CANCELED_TOPIC, addressTopic(PAYER), nonce()],
    });
    const cancelledReceipt = receipt({ logs: [cancelled] });
    const { result } = await reconcile(provider(reader({
      used: [],
      cancelled: [cancelled],
      receipt: cancelledReceipt,
    })), null);
    expect(result).toMatchObject({
      disposition: "cancelled",
      authenticationHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  test("never infers unused from absence without explicit replay-safety authority", async () => {
    const noUse = reader({ used: [], authorizationUsed: false, receipt: null });
    const { result } = await reconcile(provider(noUse, { confirmUnused: undefined }), null);
    expect(result).toEqual({
      disposition: "indeterminate",
      reason: "eip3009-replay-safety-unproven",
    });
  });

  test("returns unused only for state-at-finality plus an exact safe binding", async () => {
    const noUse = reader({ used: [], authorizationUsed: false, receipt: null });
    const safe = await reconcile(provider(noUse), null);
    expect(safe.result).toMatchObject({
      disposition: "unused",
      reason: "authenticated-unused-and-replay-safe",
      authenticationHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const unsafe = await reconcile(provider(noUse, {
      confirmUnused: async () => ({ disposition: "safe", bindingHash: "0".repeat(64) }),
    }), null);
    expect(unsafe.result?.disposition).toBe("indeterminate");
  });

  test("does not replay an authenticated-unused authorization that is not yet valid", async () => {
    const confirmUnused = vi.fn(async ({ intent }: { intent: X402BuyerSettlementIntent }) => ({
      disposition: "safe",
      bindingHash: intent.bindingHash,
    }));
    const noUse = reader({
      used: [],
      authorizationUsed: false,
      receipt: null,
      headTimestamp: 0,
    });
    const { result } = await reconcile(provider(noUse, {
      confirmUnused: confirmUnused as X402BuyerEvmAuthorizationProviderOptions["confirmUnused"],
    }), null);
    expect(result).toEqual({
      disposition: "indeterminate",
      reason: "eip3009-authorization-not-yet-valid",
    });
    expect(confirmUnused).not.toHaveBeenCalled();
  });

  test("authenticates finalized unused expiry as terminal without replay authority", async () => {
    const confirmUnused = vi.fn(async ({ intent }: { intent: X402BuyerSettlementIntent }) => ({
      disposition: "safe",
      bindingHash: intent.bindingHash,
    }));
    const noUse = reader({
      used: [],
      authorizationUsed: false,
      receipt: null,
      headTimestamp: 4_102_444_800,
    });
    const { result } = await reconcile(provider(noUse, {
      confirmUnused: confirmUnused as X402BuyerEvmAuthorizationProviderOptions["confirmUnused"],
    }), null);
    expect(result).toMatchObject({
      disposition: "expired-unused",
      reason: "eip3009-authorization-expired-unused",
      authenticationHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(confirmUnused).not.toHaveBeenCalled();
  });

  test("terminates an expired-unused intent before the paid request can run", async () => {
    const intent = makeIntent();
    let submits = 0;
    const noUse = reader({
      used: [],
      authorizationUsed: false,
      receipt: null,
      headTimestamp: 4_102_444_800,
    });
    const result = await advanceX402BuyerSettlement({
      intent,
      owner: "worker",
      store: createInMemoryX402BuyerSettlementStore(),
      authorizationProvider: provider(noUse),
      transport: {
        async submitRetained() {
          submits += 1;
          return { disposition: "indeterminate", reason: "must-not-submit" };
        },
      },
      now: () => 1_000,
    });
    expect(result).toMatchObject({
      status: "failed",
      outcome: {
        status: "failed",
        failure: "expired-unused",
        authenticationHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(submits).toBe(0);
  });

  test("does not infer unused while a success candidate may still settle", async () => {
    const noUse = reader({ used: [], authorizationUsed: false, receipt: null });
    const { result } = await reconcile(provider(noUse), disclosure());
    expect(result).toEqual({
      disposition: "indeterminate",
      reason: "payment-response-not-finalized",
    });
  });

  test("treats used state without a recoverable nonce event as lookup loss", async () => {
    const { result } = await reconcile(provider(reader({ used: [], receipt: null })), null);
    expect(result).toEqual({
      disposition: "indeterminate",
      reason: "eip3009-used-event-lookup-incomplete",
    });
  });

  test.each(["head", "logs", "state", "receipt", "ancestry"] as const)(
    "fails closed when the %s read is lost",
    async (throwAt) => {
      const { lookup, result } = await reconcile(provider(reader({ throwAt })));
      if (throwAt === "receipt") {
        expect(lookup.disposition === "unavailable" || result?.disposition === "indeterminate")
          .toBe(true);
      } else {
        expect(lookup.disposition).toBe("unavailable");
      }
    },
  );

  test("recovers an authoritative PAYMENT-RESPONSE by nonce event tx", async () => {
    const recoverDisclosure = vi.fn(async ({ transactionHash }: { transactionHash: string }) => {
      expect(transactionHash).toBe(TX);
      return disclosure();
    });
    const { result } = await reconcile(provider(reader(), {
      recoverDisclosure: recoverDisclosure as X402BuyerEvmAuthorizationProviderOptions["recoverDisclosure"],
    }), null);
    expect(result?.disposition).toBe("settled-same");
    expect(recoverDisclosure).toHaveBeenCalledOnce();
  });

  test.each([
    ["chain", { network: "eip155:1" }],
    ["payer", { payer: `0x${"99".repeat(20)}` }],
    ["amount", { amount: "1001" }],
    ["transaction", { transaction: `0x${"99".repeat(32)}` }],
  ])("rejects a candidate PAYMENT-RESPONSE with wrong %s", async (_label, mutation) => {
    const bad = disclosure({ encodedSettlementHeader: encode(response(mutation)) });
    const { result } = await reconcile(provider(), bad);
    expect(result?.disposition).toBe("indeterminate");
  });

  test("rejects a substituted candidate between lookup and authentication", async () => {
    const intent = makeIntent();
    const effectFence = fence();
    const customProvider = provider();
    const original = disclosure();
    const lookup = await customProvider.lookup(intent, original, effectFence);
    if (lookup.disposition !== "observed") throw new Error("lookup failed");
    const substituted = disclosure({
      encodedSettlementHeader: encode(response({ transaction: `0x${"99".repeat(32)}` })),
    });
    expect(await customProvider.authenticate(intent, lookup, substituted, effectFence)).toEqual({
      disposition: "indeterminate",
      reason: "payment-response-candidate-mismatch",
    });
  });

  test.each([
    ["signature", { verifySignature: async () => ({ disposition: "invalid", reason: "bad-signature" }) }],
    ["authority", { authorizeIntent: async () => ({ disposition: "rejected", reason: "not-approved" }) }],
    ["binding", { authorizeIntent: async () => ({ disposition: "authorized", bindingHash: "0".repeat(64) }) }],
  ])("fails closed on %s authorization failure", async (_label, override) => {
    const intent = makeIntent();
    const result = await provider(reader(), override).authorizeIntent(intent, fence());
    expect(result.disposition).not.toBe("authorized");
  });

  test("rejects proxy and accessor reader outputs without invoking accessors", async () => {
    let reads = 0;
    const head = {
      chainId: CHAIN_ID,
      blockNumber: 110,
      blockHash: HEAD_HASH,
      get timestamp() {
        reads += 1;
        return 2_000;
      },
    };
    const custom = reader();
    custom.getFinalityHead = async () => head;
    const { lookup } = await reconcile(provider(custom));
    expect(lookup.disposition).toBe("unavailable");
    expect(reads).toBe(0);

    const proxied = reader({ used: new Proxy([log()], {}) });
    const second = await reconcile(provider(proxied));
    expect(second.lookup.disposition).toBe("unavailable");
  });

  test("rejects a forged or cloned observation even when its public hash is self-consistent", async () => {
    const intent = makeIntent();
    const effectFence = fence();
    const customProvider = provider();
    const lookup = await customProvider.lookup(intent, disclosure(), effectFence);
    if (lookup.disposition !== "observed") throw new Error("lookup failed");
    const cloned = structuredClone(lookup);
    expect(await customProvider.authenticate(intent, cloned, disclosure(), effectFence)).toEqual({
      disposition: "indeterminate",
      reason: "evm-observation-not-issued",
    });
  });

  test("rejects a read set if the finality head changes during lookup", async () => {
    const custom = reader();
    let reads = 0;
    custom.getFinalityHead = async () => ({
      chainId: CHAIN_ID,
      blockNumber: 110,
      blockHash: reads++ === 0 ? HEAD_HASH : `0x${"dd".repeat(32)}`,
      timestamp: 2_000,
    });
    const { lookup } = await reconcile(provider(custom));
    expect(lookup).toEqual({
      disposition: "unavailable",
      reason: "evm-finality-head-changed",
    });
  });

  test("accepts a hash-pinned read set when the original head remains canonical", async () => {
    const custom = reader();
    let reads = 0;
    const confirmBlockAncestor = vi.fn(custom.confirmBlockAncestor);
    custom.confirmBlockAncestor = confirmBlockAncestor;
    custom.getFinalityHead = async () => reads++ === 0
      ? {
          chainId: CHAIN_ID,
          blockNumber: 110,
          blockHash: HEAD_HASH,
          timestamp: 2_000,
        }
      : {
          chainId: CHAIN_ID,
          blockNumber: 112,
          blockHash: `0x${"dd".repeat(32)}`,
          timestamp: 2_004,
        };
    const { lookup, result } = await reconcile(provider(custom));
    expect(lookup.disposition).toBe("observed");
    expect(result?.disposition).toBe("settled-same");
    expect(confirmBlockAncestor).toHaveBeenCalledWith({
      blockNumber: 110,
      blockHash: HEAD_HASH,
      headBlockNumber: 112,
      headBlockHash: `0x${"dd".repeat(32)}`,
    });
  });

  test("rejects an advanced head when the pinned head is no longer canonical", async () => {
    const custom = reader();
    let reads = 0;
    custom.confirmBlockAncestor = async (input) => ({
      canonical: input.blockNumber !== 110,
      ...input,
    });
    custom.getFinalityHead = async () => reads++ === 0
      ? {
          chainId: CHAIN_ID,
          blockNumber: 110,
          blockHash: HEAD_HASH,
          timestamp: 2_000,
        }
      : {
          chainId: CHAIN_ID,
          blockNumber: 112,
          blockHash: `0x${"dd".repeat(32)}`,
          timestamp: 2_004,
        };
    const { lookup } = await reconcile(provider(custom));
    expect(lookup).toEqual({
      disposition: "unavailable",
      reason: "evm-finality-head-changed",
    });
  });

  test("rejects accessor callback verdicts without invoking them", async () => {
    let reads = 0;
    const verdict = {} as Record<string, unknown>;
    Object.defineProperty(verdict, "disposition", {
      enumerable: true,
      get() {
        reads += 1;
        return "valid";
      },
    });
    Object.defineProperty(verdict, "signer", {
      enumerable: true,
      value: PAYER,
    });
    const result = await provider(reader(), {
      verifySignature: async () => verdict,
    }).authorizeIntent(makeIntent(), fence());
    expect(result).toEqual({
      disposition: "indeterminate",
      reason: "signature-verifier-invalid",
    });
    expect(reads).toBe(0);
  });

  test("the default lazy viem verifier accepts a real retained EIP-3009 signature", async () => {
    const account = privateKeyToAccount(`0x${"01".repeat(32)}`);
    const draft = intentDraft({ payer: account.address });
    const payload = structuredClone(draft.signedPaymentPayload) as Record<string, unknown>;
    const authorization = ((payload.payload as Record<string, unknown>)
      .authorization as Record<string, unknown>);
    authorization.from = account.address;
    const signature = await account.signTypedData({
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: CHAIN_ID,
        verifyingContract: ASSET,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: account.address,
        to: PAYEE,
        value: BigInt(AMOUNT),
        validAfter: 0n,
        validBefore: 4_102_444_800n,
        nonce: nonce(),
      },
    });
    (payload.payload as Record<string, unknown>).signature = signature;
    draft.signedPaymentPayload = payload as X402BuyerSettlementIntentDraft["signedPaymentPayload"];
    draft.paymentHeader = { name: "PAYMENT-SIGNATURE", value: encode(payload) };
    const intent = createX402BuyerSettlementIntent(draft);
    const result = await createX402BuyerEvmAuthorizationProvider({
      chainId: CHAIN_ID,
      minimumConfirmations: 5,
      authorizationSearchFromBlock: 1,
      client: reader(),
      authorizeIntent: async ({ intent: checked }) => ({
        disposition: "authorized",
        bindingHash: checked.bindingHash,
      }),
    }).authorizeIntent(intent, fence());
    expect(result).toEqual({ disposition: "authorized", bindingHash: intent.bindingHash });
  });

  test("the lazy viem reader binds logs, receipts and authorizationState to one finality head", async () => {
    const calls: Array<{ method: string; params?: unknown[] }> = [];
    const rpcLog = (entry: X402BuyerEvmLog) => ({
      ...entry,
      blockNumber: `0x${entry.blockNumber.toString(16)}`,
      logIndex: `0x${entry.logIndex.toString(16)}`,
    });
    const server = createServer((request, responseStream) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          id: number;
          method: string;
          params?: unknown[];
        };
        calls.push({ method: body.method, params: body.params });
        let result: unknown;
        if (body.method === "eth_chainId") result = `0x${CHAIN_ID.toString(16)}`;
        else if (body.method === "eth_getBlockByNumber") {
          result = body.params?.[0] === "0x64"
            ? { number: "0x64", hash: BLOCK_HASH, timestamp: "0x700" }
            : { number: "0x6e", hash: HEAD_HASH, timestamp: "0x7d0" };
        } else if (body.method === "eth_getLogs") {
          const filter = body.params?.[0] as { topics: string[] };
          result = filter.topics[0] === EIP3009_AUTHORIZATION_USED_TOPIC
            ? [rpcLog(log())] : [];
        } else if (body.method === "eth_getTransactionReceipt") {
          result = {
            transactionHash: TX,
            blockNumber: "0x64",
            blockHash: BLOCK_HASH,
            status: "0x1",
            logs: [rpcLog(log()), rpcLog(transfer())],
          };
        } else if (body.method === "eth_call") {
          result = `0x${"0".repeat(63)}1`;
        } else throw new Error(`unexpected RPC ${body.method}`);
        responseStream.writeHead(200, { "content-type": "application/json" });
        responseStream.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const client = await createViemX402BuyerEvmReadClient({
        rpcUrl: `http://127.0.0.1:${port}`,
        chainId: CHAIN_ID,
      });
      const { result } = await reconcile(provider(client));
      expect(result?.disposition).toBe("settled-same");
      expect(calls.map((call) => call.method)).toEqual(expect.arrayContaining([
        "eth_chainId",
        "eth_getBlockByNumber",
        "eth_getLogs",
        "eth_getTransactionReceipt",
        "eth_call",
      ]));
      const stateCall = calls.find((call) => call.method === "eth_call")!;
      const callData = (stateCall.params?.[0] as { data: string }).data;
      expect(callData).toBe(
        `0xe94a0102${PAYER.slice(2).padStart(64, "0")}${nonce().slice(2)}`,
      );
      expect(stateCall.params?.[1]).toEqual({
        blockHash: HEAD_HASH,
        requireCanonical: true,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test("exports the provider without exposing optional-peer imports at module load", async () => {
    const [root, rails] = await Promise.all([
      import("../../src/index.js"),
      import("../../src/rails/index.js"),
    ]);
    for (const surface of [root, rails]) {
      expect(surface.createX402BuyerEvmAuthorizationProvider).toBeTypeOf("function");
      expect(surface.createViemX402BuyerEvmReadClient).toBeTypeOf("function");
      expect(surface.EIP3009_AUTHORIZATION_USED_TOPIC).toBe(EIP3009_AUTHORIZATION_USED_TOPIC);
    }
  }, 20_000);
});

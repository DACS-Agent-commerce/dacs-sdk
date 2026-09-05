import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_COORDINATOR_STORE_VERSION,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  createInMemoryX402BuyerSettlementStore,
  fixedPriceX402OrderBindingHash,
  fixedPriceX402OrderLocalBindingHash,
  type FixedPriceX402EffectFence,
  type FixedPriceX402OrderInput,
  type FixedPriceX402OrderRecord,
  type FixedPriceX402TrackOperationInput,
  type X402BuyerChallengeClient,
  type X402BuyerEffectFence,
  type X402BuyerEip3009Authorization,
  type X402BuyerSettlementIntent,
} from "@kynesyslabs/dacs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DACS_NODE_LIVE_PROFILE,
  DacsLiveEffectInputControlError,
  createDacsX402ExactRetainedReplayConfirmerV1,
  createDacsX402BuyerRuntimePaymentTrackV1,
  putDacsLiveOrderInputV1,
  type DacsLiveRoleOperationContextV1,
} from "../src/index.js";
import {
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = `did:demos:agent:${"11".repeat(32)}`;
const SELLER = `did:demos:agent:${"22".repeat(32)}`;
const PAYER = `0x${"11".repeat(20)}`;
const PAYEE = `0x${"22".repeat(20)}`;
const ASSET = `0x${"33".repeat(20)}`;
const RESOURCE = `https://seller.example/deliver/${JOB_ID}`;

describe("exact retained x402 replay authority", () => {
  const bindingHash = "a".repeat(64);
  const settlementKey = "dacs:x402-buyer:test";
  const nonce = `0x${"b".repeat(64)}` as const;
  const intent = {
    jobId: JOB_ID,
    httpResource: `https://seller.example/x402/${JOB_ID}`,
    method: "GET",
    bindingHash,
    settlementKey,
    authorizationNonce: nonce,
  } as Readonly<X402BuyerSettlementIntent>;
  const authorization = { nonce } as Readonly<X402BuyerEip3009Authorization>;
  const finalityHead = {
    chainId: 84532,
    blockNumber: 10,
    blockHash: `0x${"c".repeat(64)}`,
    timestamp: 100,
  };
  const authorizationState = {
    used: false,
    blockNumber: 10,
    blockHash: finalityHead.blockHash,
  };
  const current = vi.fn(async () => undefined);
  const fence = {
    owner: "buyer-worker",
    generation: 2,
    settlementKey,
    bindingHash,
    idempotencyKey: "buyer-payment-effect",
    assertCurrent: current,
  } satisfies X402BuyerEffectFence;

  it("permits only the exact canonical generated seller request", async () => {
    const confirm = createDacsX402ExactRetainedReplayConfirmerV1({
      publicBaseUrl: "https://seller.example",
    });
    await expect(confirm({
      intent,
      authorization,
      finalityHead,
      authorizationState,
      fence,
    })).resolves.toEqual({ disposition: "safe", bindingHash });
    expect(current).toHaveBeenCalledTimes(2);
  });

  it("fails closed for a different resource, nonce, binding or used state", async () => {
    const confirm = createDacsX402ExactRetainedReplayConfirmerV1({
      publicBaseUrl: "https://seller.example",
    });
    for (const changed of [
      { intent: { ...intent, httpResource: `https://other.example/x402/${JOB_ID}` } },
      { intent: { ...intent, authorizationNonce: `0x${"d".repeat(64)}` } },
      { intent: { ...intent, bindingHash: "e".repeat(64) } },
      { authorizationState: { ...authorizationState, used: true } },
    ]) {
      await expect(confirm({
        intent: (changed.intent ?? intent) as Readonly<X402BuyerSettlementIntent>,
        authorization,
        finalityHead,
        authorizationState: changed.authorizationState ?? authorizationState,
        fence,
      })).resolves.toMatchObject({ disposition: "unsafe" });
    }
  });

  it("rejects malformed or credential-bearing configured origins", () => {
    expect(() => createDacsX402ExactRetainedReplayConfirmerV1({
      publicBaseUrl: "https://user:secret@seller.example",
    })).toThrow(/public base URL/u);
  });
});

function orderInput(): FixedPriceX402OrderInput {
  return {
    jobId: JOB_ID,
    buyer: BUYER,
    seller: SELLER,
    protocol: {
      commerceProfile: FIXED_PRICE_X402_COMMERCE_PROFILE,
      standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
      phase: "pay-x402",
      orchestratorTopology: "seller-as-phase-orchestrator-v1",
      orchestrator: SELLER,
      rail: {
        registryIndexRef: FIXED_PRICE_X402_REGISTRY_INDEX_REF,
        registryIndexHash: "1".repeat(64),
        railDefinitionRef: "dacs4:rail:x402%3Adefault:2",
        railDefinitionHash: "2".repeat(64),
        railId: "x402:default",
        railVersion: 2,
        railType: "x402",
        phaseHandler: "pay-x402",
        network: "eip155:84532",
        availability: "live",
      },
    },
    sdkJobs: {
      role: "buyer",
      agreement: `buyer:agreement:${JOB_ID}`,
      payment: `buyer:payment:${JOB_ID}`,
      paymentEvidence: `buyer:payment-evidence:${JOB_ID}`,
      buyerReceived: `buyer:received:${JOB_ID}`,
      audit: `buyer:audit:${JOB_ID}`,
    },
  };
}

function operation(): FixedPriceX402TrackOperationInput {
  const input = orderInput();
  const bindingHash = fixedPriceX402OrderBindingHash(input);
  const localBindingHash = fixedPriceX402OrderLocalBindingHash(input);
  const order: FixedPriceX402OrderRecord = {
    ...input,
    storeVersion: FIXED_PRICE_X402_COORDINATOR_STORE_VERSION,
    revision: 1,
    role: "buyer",
    bindingHash,
    localBindingHash,
    tracks: {},
    createdAt: 1,
    updatedAt: 1,
  };
  const fence: FixedPriceX402EffectFence = {
    role: "buyer",
    jobId: JOB_ID,
    bindingHash,
    localBindingHash,
    track: "payment",
    owner: "buyer-worker",
    generation: 1,
    idempotencyKey: "buyer-payment-effect",
    assertCurrent: async () => undefined,
  };
  return { order, fence };
}

describe("buyer runtime x402 payment composition", () => {
  const roots: string[] = [];
  const databases: DacsNodeSqliteDatabase[] = [];

  afterEach(() => {
    for (const database of databases.splice(0).reverse()) database.close();
    for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("retries a lost read-only challenge without retaining or sending a bearer", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dacs-runtime-payment-"));
    roots.push(directory);
    const database = await openDacsNodeSqliteDatabase({
      databasePath: join(directory, "buyer.sqlite"),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      authority: BUYER,
    });
    databases.push(database);
    putDacsLiveOrderInputV1({
      database,
      order: orderInput(),
      application: { listingRef: "dacs1:listing:test:1" },
    });
    const challengeClient: X402BuyerChallengeClient = {
      getPaymentRequiredResponse: (_headers, body) => body,
      createPaymentPayload: vi.fn(),
      encodePaymentSignatureHeader: vi.fn(),
    };
    const createChallengeClient = vi.fn(async () => challengeClient);
    const readClient = {
      getFinalityHead: vi.fn(),
      getLogs: vi.fn(),
      getTransactionReceipt: vi.fn(),
      readAuthorizationState: vi.fn(),
      confirmBlockAncestor: vi.fn(),
    };
    const context = Object.freeze({
      role: "buyer" as const,
      authority: BUYER,
      peerAuthority: SELLER,
      sendMessage: vi.fn(),
      config: {} as never,
      database,
      demos: {} as never,
      sessionStore: {} as never,
      commerceStores: {
        role: "buyer" as const,
        x402Settlement: createInMemoryX402BuyerSettlementStore(),
      },
      evm: {
        role: "buyer" as const,
        address: PAYER,
        runtime: {
          network: "eip155:84532" as const,
          chainId: 84532,
          payerAddress: PAYER,
          warningCodes: [],
          readClient,
          destroyed: false,
          createChallengeClient,
          destroy: vi.fn(),
        },
      },
    }) as unknown as DacsLiveRoleOperationContextV1;
    const preparation = {
      authority: {
        jobId: JOB_ID,
        phaseIndex: 2,
        railId: "x402:default",
        railVersion: "2",
        railDescriptorHash: "2".repeat(64),
        agreementHash: "3".repeat(64),
        termsHash: "4".repeat(64),
        sessionBindingHash: "5".repeat(64),
        network: "eip155:84532",
        payer: PAYER,
        payee: PAYEE,
        asset: ASSET,
        amount: "1000",
        httpResource: RESOURCE,
        method: "GET",
      },
      expectedRequirements: {
        scheme: "exact" as const,
        network: "eip155:84532",
        amount: "1000",
        asset: ASSET,
        payTo: PAYEE,
        maxTimeoutSeconds: 120,
        extra: { name: "USD Coin", version: "2" },
      },
    } as const;
    const track = createDacsX402BuyerRuntimePaymentTrackV1({
      context,
      workerId: "buyer-worker",
      maximumServiceAmount: "1000",
      minimumConfirmations: 1,
      authorizationSearchFromBlock: 1,
      resolvePreparation: () => preparation,
      authorizeIntent: async ({ intent }) => ({
        disposition: "authorized" as const,
        bindingHash: intent.bindingHash,
      }),
      authorizePreparedIntent: () => true,
      fetchImpl: async () => { throw new Error("challenge response lost"); },
      retryDelayMs: 1,
    });

    await expect(track(operation())).resolves.toMatchObject({
      status: "pending-retry",
      reasonCode: "x402-prepare-x402-challenge-unavailable",
    });
    expect(createChallengeClient).toHaveBeenCalledOnce();
    expect(database.loadEffect("payment", "buyer-payment-effect")).toBeUndefined();
    expect(challengeClient.createPaymentPayload).not.toHaveBeenCalled();

    const overLimitTrack = createDacsX402BuyerRuntimePaymentTrackV1({
      context,
      workerId: "buyer-worker",
      maximumServiceAmount: "999",
      minimumConfirmations: 1,
      authorizationSearchFromBlock: 1,
      resolvePreparation: () => preparation,
      authorizeIntent: async ({ intent }) => ({
        disposition: "authorized" as const,
        bindingHash: intent.bindingHash,
      }),
      authorizePreparedIntent: () => true,
    });
    await expect(overLimitTrack(operation())).resolves.toEqual({
      status: "operator-action",
      reasonCode: "x402-preparation-amount-exceeds-consented-maximum",
    });
    expect(createChallengeClient).toHaveBeenCalledOnce();
    expect(database.loadEffect("payment", "buyer-payment-effect")).toBeUndefined();

    const controlledTrack = createDacsX402BuyerRuntimePaymentTrackV1({
      context,
      workerId: "buyer-worker",
      maximumServiceAmount: "1000",
      minimumConfirmations: 1,
      authorizationSearchFromBlock: 1,
      resolvePreparation: () => {
        throw new DacsLiveEffectInputControlError(
          "operator-action",
          "agreement-authority-invalid",
        );
      },
      authorizeIntent: async ({ intent }) => ({
        disposition: "authorized" as const,
        bindingHash: intent.bindingHash,
      }),
      authorizePreparedIntent: () => true,
    });
    await expect(controlledTrack(operation())).resolves.toEqual({
      status: "operator-action",
      reasonCode: "agreement-authority-invalid",
    });
    expect(database.loadEffect("payment", "buyer-payment-effect")).toBeUndefined();
  });
});

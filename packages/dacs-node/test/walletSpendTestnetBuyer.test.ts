import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import { keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_COORDINATOR_STORE_VERSION,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  createDacsX402BuyerEvmChallengeClient,
  createInMemoryX402BuyerSettlementStore,
  fixedPriceX402OrderBindingHash,
  fixedPriceX402OrderLocalBindingHash,
  x402BuyerUnsignedIntentHash,
  type FixedPriceX402OrderInput,
  type FixedPriceX402TrackOperationInput,
  type WalletSpendStateV1,
  type X402BuyerPreparationAuthority,
  type X402BuyerSettlementIntent,
} from "@kynesyslabs/dacs";

import {
  DACS_NODE_LIVE_PROFILE,
  createDacsX402BuyerRuntimePaymentTrackV1,
  putDacsLiveOrderInputV1,
  type DacsLiveRoleOperationContextV1,
} from "../src/index.js";
import { openDacsNodeSqliteDatabase, type DacsNodeSqliteDatabase } from "../src/sqlite.js";
import { createDacsRemoteWalletSpendAuthorityV2 } from "../src/walletSpendRemote.js";
import { startDacsWalletSpendTestnetAuthorityV1 } from "../src/walletSpendTestnetService.js";
import {
  LATEST_NUMBER,
  TESTNET_ASSET,
  TESTNET_DEPTH,
  TESTNET_PAYEE,
  chainBlocks,
  chainState,
  chainStub,
  closeChainStubs,
  serviceSettings,
  testnetPolicy,
} from "./helpers/walletSpendTestnetChain.js";

// A test-only key derived at run time, so the repository holds no wallet material.
const PRIVATE_KEY = keccak256(stringToHex("dacs-sdk:test:testnet-authority-buyer"));
const PAYER = privateKeyToAccount(PRIVATE_KEY).address.toLowerCase();
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = `did:demos:agent:${"11".repeat(32)}`;
const SELLER = `did:demos:agent:${"22".repeat(32)}`;
const RESOURCE = `https://seller.example/deliver/${JOB_ID}`;
const AMOUNT = "1000";
/** The generated buyer's values. */
const MAX_TIMEOUT_SECONDS = 120;
const RETRY_DELAY_MS = 5_000;
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await closeChainStubs();
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
  return {
    order: {
      ...input, storeVersion: FIXED_PRICE_X402_COORDINATOR_STORE_VERSION, revision: 1, role: "buyer",
      bindingHash, localBindingHash, tracks: {}, createdAt: 1, updatedAt: 1,
    },
    fence: {
      role: "buyer", jobId: JOB_ID, bindingHash, localBindingHash, track: "payment",
      owner: "buyer-worker", generation: 1, idempotencyKey: "buyer-payment-effect",
      assertCurrent: async () => undefined,
    },
  };
}

const authority: X402BuyerPreparationAuthority = {
  jobId: JOB_ID, phaseIndex: 2, railId: "x402:default", railVersion: "2", railDescriptorHash: "2".repeat(64),
  agreementHash: "3".repeat(64), termsHash: "4".repeat(64), sessionBindingHash: "5".repeat(64),
  network: "eip155:84532", payer: PAYER, payee: TESTNET_PAYEE, asset: TESTNET_ASSET, amount: AMOUNT,
  httpResource: RESOURCE, method: "GET",
};
const requirements = {
  scheme: "exact" as const, network: "eip155:84532" as const, amount: AMOUNT, asset: TESTNET_ASSET,
  payTo: TESTNET_PAYEE, maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
  extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
};

async function buyerDatabase(): Promise<DacsNodeSqliteDatabase> {
  const directory = mkdtempSync(join(tmpdir(), "dacs-testnet-buyer-"));
  const database = await openDacsNodeSqliteDatabase({
    databasePath: join(directory, "buyer.sqlite"), mode: "live-demos", profile: DACS_NODE_LIVE_PROFILE,
    role: "buyer", authority: BUYER,
  });
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }), () => database.close());
  putDacsLiveOrderInputV1({ database, order: orderInput(), application: { listingRef: "dacs1:listing:test:1" } });
  return database;
}

function headState(dataDirectory: string): WalletSpendStateV1 {
  const states = readdirSync(join(dataDirectory, "states")).map((name) =>
    JSON.parse(readFileSync(join(dataDirectory, "states", name), "utf8")) as WalletSpendStateV1);
  return states.reduce((head, state) => state.generation > head.generation ? state : head);
}

// One purchase through SQLite, the service's file stores and real HTTP; slower than the default on a loaded box.
describe("generated buyer against the testnet authority", { timeout: 30_000 }, () => {
  it("the generated buyer reserves on the service, then signs with the bound validBefore", async () => {
    const latestTime = 1_800_000_000;
    const events: string[] = [];
    const state = chainState(chainBlocks({ time: (number) => latestTime - (LATEST_NUMBER - number) * 2 }));
    const stub = await chainStub(state, {
      answer: (call) => {
        if (call.method === "eth_getBlockByNumber" && call.params[0] === "latest") events.push("chain:latest");
        return undefined;
      },
    });
    const policy = testnetPolicy({ wallet: PAYER });
    const settings = await serviceSettings({ rpcUrl: stub.url, policy });
    cleanups.push(() => settings.remove());
    const service = await startDacsWalletSpendTestnetAuthorityV1({ environment: settings.environment });
    cleanups.push(() => service.stop());
    const reserves: unknown[] = [];
    const walletSpendAuthority = await createDacsRemoteWalletSpendAuthorityV2({
      policy, endpoint: service.url, tokenFilePath: settings.tokenFile,
      authorityId: service.authorityId, epoch: service.epoch,
      witnessVerificationKey: service.witnessVerificationKey, allowInsecureLoopback: true,
      fetch: async (input, init) => {
        if (init?.method === "POST" && typeof init.body === "string") {
          const body = JSON.parse(init.body) as { operation: string; payload: unknown };
          events.push(`service:${body.operation}`);
          if (body.operation === "reserve") reserves.push(body.payload);
        }
        return fetch(input, init);
      },
    });

    let paymentSignature: string | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      const signature = new Headers(init?.headers).get("PAYMENT-SIGNATURE");
      if (signature === null) {
        events.push("seller:unpaid");
        return new Response(null, {
          status: 402,
          headers: {
            "PAYMENT-REQUIRED": encodePaymentRequiredHeader({
              x402Version: 2, resource: { url: RESOURCE }, accepts: [requirements],
            }),
          },
        });
      }
      events.push("seller:paid");
      paymentSignature = signature;
      return new Response("unavailable", { status: 503 });
    };
    const database = await buyerDatabase();
    const context = Object.freeze({
      role: "buyer" as const, authority: BUYER, peerAuthority: SELLER, sendMessage: vi.fn(),
      config: {} as never, database, demos: {} as never, sessionStore: {} as never,
      commerceStores: { role: "buyer" as const, x402Settlement: createInMemoryX402BuyerSettlementStore() },
      evm: {
        role: "buyer" as const,
        address: PAYER,
        runtime: {
          network: "eip155:84532" as const, chainId: 84532, payerAddress: PAYER, warningCodes: [], destroyed: false,
          readClient: {
            getFinalityHead: async () => ({
              chainId: 84532, blockNumber: LATEST_NUMBER, blockHash: state.byNumber.get(LATEST_NUMBER)?.hash,
              timestamp: latestTime,
            }),
            getLogs: vi.fn(async () => []),
            getTransactionReceipt: vi.fn(async () => null),
            readAuthorizationState: vi.fn(),
            confirmBlockAncestor: vi.fn(),
          },
          createChallengeClient: (input: { authority: X402BuyerPreparationAuthority; expectedRequirements: typeof requirements }) =>
            createDacsX402BuyerEvmChallengeClient({
              evmPrivateKey: PRIVATE_KEY, authority: input.authority,
              expectedRequirements: input.expectedRequirements, requireHoldValidBefore: true,
            }),
          destroy: vi.fn(),
        },
      },
    }) as unknown as DacsLiveRoleOperationContextV1;
    const track = createDacsX402BuyerRuntimePaymentTrackV1({
      walletSpendAuthority, context, workerId: "buyer-worker", maximumServiceAmount: AMOUNT,
      minimumConfirmations: TESTNET_DEPTH, authorizationSearchFromBlock: 1,
      resolvePreparation: () => ({ authority, expectedRequirements: requirements }),
      authorizeIntent: async ({ intent }) => ({ disposition: "authorized" as const, bindingHash: intent.bindingHash }),
      authorizePreparedIntent: () => true,
      fetchImpl,
      retryDelayMs: RETRY_DELAY_MS,
    });

    vi.useFakeTimers({ toFake: ["Date"], now: (latestTime + 1_000) * 1_000 });
    await track(operation());

    // The permit's read-only fence checks (`current`) may come between the steps.
    const steps = events.filter((event) => event !== "service:current");
    expect(steps.slice(0, steps.indexOf("seller:paid") + 1)).toEqual([
      "seller:unpaid", "service:reserve", "chain:latest", "service:begin", "seller:paid",
    ]);
    if (paymentSignature === undefined) throw new Error("expected a paid request");
    const signed = decodePaymentSignatureHeader(paymentSignature).payload as { authorization: { validBefore: string } };
    const [row] = headState(settings.dataDirectory).reservations;
    expect(signed.authorization.validBefore).toBe(String(latestTime + MAX_TIMEOUT_SECONDS));
    expect(row?.authorizationValidBefore).toBe(latestTime + MAX_TIMEOUT_SECONDS);
    const stored = database.loadEffectInput("payment", "buyer-payment-effect") as { intent: X402BuyerSettlementIntent };
    expect(row?.reservation.settlementBindingHash).toBe(x402BuyerUnsignedIntentHash(stored.intent));
    expect(reserves).toEqual([expect.objectContaining({ options: { authorizationWindowSeconds: MAX_TIMEOUT_SECONDS } })]);
  });
});

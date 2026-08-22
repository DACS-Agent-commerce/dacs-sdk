import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_COORDINATOR_STORE_VERSION,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  createInMemoryX402BuyerSettlementStore,
  createX402BuyerSettlementIntent,
  x402BuyerSettlementAuthenticationHash,
  type FixedPriceX402EffectFence,
  type FixedPriceX402OrderRecord,
  type FixedPriceX402TrackOperationInput,
  type X402BuyerAuthorizationProvider,
  type X402BuyerCapturedSettlement,
  type X402BuyerPaidRequestTransport,
  type X402BuyerSettlementIntent,
  type X402BuyerSettlementStore,
} from "@kynesyslabs/dacs";
import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DACS_NODE_LIVE_PROFILE,
  createDacsX402BuyerPaymentTrackV1,
} from "../src/index.js";
import {
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = `did:demos:agent:${"11".repeat(32)}`;
const SELLER = `did:demos:agent:${"22".repeat(32)}`;
const BINDING_HASH = "a".repeat(64);
const LOCAL_BINDING_HASH = "b".repeat(64);
const PAYER = `0x${"11".repeat(20)}`;
const PAYEE = `0x${"22".repeat(20)}`;
const ASSET = `0x${"33".repeat(20)}`;
const TX = `0x${"aa".repeat(32)}`;
const RESOURCE = "https://seller.example/deliver/test";
const PHASE_INDEX = 2;

function nonce(): `0x${string}` {
  return `0x${sha256Hex(`dacs-sb3:v1:${JOB_ID}:${PHASE_INDEX}`)}`;
}

function intent(): Readonly<X402BuyerSettlementIntent> {
  const chosenRequirements = {
    scheme: "exact",
    network: "eip155:84532" as const,
    amount: "1000",
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
        value: "1000",
        validAfter: "0",
        validBefore: "4102444800",
        nonce: nonce(),
      },
      signature: `0x${"44".repeat(65)}`,
    },
  };
  return createX402BuyerSettlementIntent({
    jobId: JOB_ID,
    phaseIndex: PHASE_INDEX,
    railId: "x402:default",
    railVersion: "1",
    railDescriptorHash: "c".repeat(64),
    agreementHash: "d".repeat(64),
    termsHash: "e".repeat(64),
    sessionBindingHash: "f".repeat(64),
    network: "eip155:84532",
    payer: PAYER,
    payee: PAYEE,
    asset: ASSET,
    amount: "1000",
    httpResource: RESOURCE,
    method: "GET",
    chosenRequirements,
    signedPaymentPayload,
    paymentHeader: {
      name: "PAYMENT-SIGNATURE",
      value: Buffer.from(JSON.stringify(signedPaymentPayload), "utf8").toString("base64"),
    },
    authorizationNonce: nonce(),
  });
}

function responseBody() {
  return {
    success: true,
    transaction: TX,
    network: "eip155:84532",
    payer: PAYER,
    amount: "1000",
  };
}

function disclosure() {
  return {
    protocolVersion: "2" as const,
    headerName: "PAYMENT-RESPONSE" as const,
    encodedSettlementHeader: Buffer.from(
      JSON.stringify(responseBody()),
      "utf8",
    ).toString("base64"),
    httpResource: RESOURCE,
  };
}

function captured(retained: Readonly<X402BuyerSettlementIntent>): X402BuyerCapturedSettlement {
  const signedEvent = {
    kind: "x402-event" as const,
    httpResource: RESOURCE,
    paymentReceiptHash: sha256Hex(canonicalize(responseBody())),
    protocolVersion: "2" as const,
    settlementTxHash: TX.slice(2),
    chainId: 84532,
    logIndex: 7,
  };
  return {
    captureVersion: "1",
    protocolVersion: "2",
    headerName: "PAYMENT-RESPONSE",
    encodedSettlementHeader: disclosure().encodedSettlementHeader,
    httpResource: RESOURCE,
    signedEvent,
    authenticationHash: x402BuyerSettlementAuthenticationHash({
      intent: retained,
      signedEvent,
    }),
  };
}

function order(): FixedPriceX402OrderRecord {
  return {
    storeVersion: FIXED_PRICE_X402_COORDINATOR_STORE_VERSION,
    revision: 0,
    role: "buyer",
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
        railDefinitionRef: "dacs4:rail:x402%3Adefault:1",
        railDefinitionHash: "c".repeat(64),
        railId: "x402:default",
        railVersion: 1,
        railType: "x402",
        phaseHandler: "pay-x402",
        network: "eip155:84532",
        availability: "live",
      },
    },
    bindingHash: BINDING_HASH,
    localBindingHash: LOCAL_BINDING_HASH,
    sdkJobs: {
      role: "buyer",
      agreement: `buyer:agreement:${JOB_ID}`,
      payment: `buyer:payment:${JOB_ID}`,
      paymentEvidence: `buyer:payment-evidence:${JOB_ID}`,
      buyerReceived: `buyer:received:${JOB_ID}`,
      audit: `buyer:audit:${JOB_ID}`,
    },
    tracks: {},
    createdAt: 1_780_000_000_000,
    updatedAt: 1_780_000_000_000,
  };
}

function operationInput(): FixedPriceX402TrackOperationInput {
  const fence: FixedPriceX402EffectFence = {
    role: "buyer",
    jobId: JOB_ID,
    bindingHash: BINDING_HASH,
    localBindingHash: LOCAL_BINDING_HASH,
    track: "payment",
    owner: "coordinator-worker",
    generation: 1,
    idempotencyKey: "dacs-fixed-price-x402:v1:buyer:payment:test",
    assertCurrent: async () => undefined,
  };
  return { order: order(), fence };
}

function provider(
  retained: Readonly<X402BuyerSettlementIntent>,
  outcomes: Array<
    | { disposition: "settled-same"; settlement: X402BuyerCapturedSettlement }
    | { disposition: "indeterminate"; reason: string }
    | { disposition: "unused"; reason: string; authenticationHash: string }
  >,
): X402BuyerAuthorizationProvider<{ exact: true }> {
  return {
    authorizeIntent: vi.fn(async (candidate, fence) => {
      await fence.assertCurrent();
      return candidate.bindingHash === retained.bindingHash
        ? { disposition: "authorized" as const, bindingHash: candidate.bindingHash }
        : { disposition: "rejected" as const, reason: "binding-mismatch" };
    }),
    lookup: vi.fn(async (_candidate, _disclosure, fence) => {
      await fence.assertCurrent();
      return {
        disposition: "observed" as const,
        observation: { exact: true as const },
      };
    }),
    authenticate: vi.fn(async (_candidate, _lookup, _disclosure, fence) => {
      await fence.assertCurrent();
      return outcomes.shift() ?? {
        disposition: "indeterminate" as const,
        reason: "no-scripted-outcome",
      };
    }),
  };
}

describe("coordinator x402 buyer payment track", () => {
  const roots: string[] = [];
  const databases: DacsNodeSqliteDatabase[] = [];

  async function database() {
    const directory = mkdtempSync(join(tmpdir(), "dacs-x402-track-"));
    roots.push(directory);
    const opened = await openDacsNodeSqliteDatabase({
      databasePath: join(directory, "buyer.sqlite"),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      authority: BUYER,
    });
    databases.push(opened);
    return opened;
  }

  afterEach(() => {
    for (const opened of databases.splice(0).reverse()) opened.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("persists the bearer before one paid request and replays the authenticated result", async () => {
    const opened = await database();
    const retained = intent();
    const settlementStore = createInMemoryX402BuyerSettlementStore();
    const prepareIntent = vi.fn(async () => retained);
    const submitRetained = vi.fn(async () => ({
      disposition: "response" as const,
      disclosure: disclosure(),
    }));
    const track = createDacsX402BuyerPaymentTrackV1({
      database: opened,
      workerId: "buyer-payment-worker",
      settlementStore,
      authorizationProvider: provider(retained, [
        {
          disposition: "settled-same",
          settlement: captured(retained),
        },
        {
          disposition: "settled-same",
          settlement: captured(retained),
        },
      ]),
      transport: { submitRetained } satisfies X402BuyerPaidRequestTransport,
      prepareIntent,
      authorizePreparedIntent: async () => true,
      retryDelayMs: 1,
    });

    await expect(track(operationInput())).resolves.toMatchObject({
      status: "final",
      outcome: "success",
      reference: `x402:84532:${TX.slice(2)}:7`,
      authenticationHash: captured(retained).authenticationHash,
    });
    await expect(track(operationInput())).resolves.toMatchObject({ status: "final" });
    expect(prepareIntent).toHaveBeenCalledTimes(1);
    expect(submitRetained).toHaveBeenCalledTimes(1);
    expect(opened.loadEffectInput(
      "payment",
      "dacs-fixed-price-x402:v1:buyer:payment:test",
    )).toMatchObject({ intent: { paymentHeader: retained.paymentHeader } });
  });

  it("recovers an ambiguous paid response from chain without submitting again", async () => {
    const opened = await database();
    const retained = intent();
    const settlementStore = createInMemoryX402BuyerSettlementStore();
    const submitRetained = vi.fn(async () => ({
      disposition: "response" as const,
      disclosure: disclosure(),
    }));
    const authorizationProvider = provider(retained, [
      { disposition: "indeterminate", reason: "chain-read-unavailable" },
      { disposition: "settled-same", settlement: captured(retained) },
    ]);
    const track = createDacsX402BuyerPaymentTrackV1({
      database: opened,
      workerId: "buyer-payment-worker",
      settlementStore,
      authorizationProvider,
      transport: { submitRetained },
      prepareIntent: async () => retained,
      authorizePreparedIntent: () => true,
      settlementLeaseDurationMs: 30_000,
      retryDelayMs: 1,
    });

    await expect(track(operationInput())).resolves.toMatchObject({
      status: "indeterminate",
    });
    expect(authorizationProvider.authenticate).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const recovered = await track(operationInput());
    expect(authorizationProvider.authenticate).toHaveBeenCalledTimes(2);
    expect(recovered).toMatchObject({
      status: "final",
      reference: `x402:84532:${TX.slice(2)}:7`,
    });
    await expect(settlementStore.load(retained.settlementKey)).resolves.toMatchObject({
      status: "captured",
      outcome: { status: "captured", settlement: captured(retained) },
    });
    expect(submitRetained).toHaveBeenCalledTimes(1);
  });

  it("does not record a reconciled settlement through an unrelated active lease", async () => {
    const opened = await database();
    const retained = intent();
    const inner = createInMemoryX402BuyerSettlementStore();
    await expect(inner.claim({
      intent: retained,
      owner: "independent-settlement-worker",
      now: opened.readTime(),
      leaseDurationMs: 30_000,
    })).resolves.toMatchObject({ status: "acquired" });
    const recordOutcome = vi.fn((input: Parameters<X402BuyerSettlementStore["recordOutcome"]>[0]) =>
      inner.recordOutcome(input));
    const settlementStore: X402BuyerSettlementStore = {
      load: (settlementKey) => inner.load(settlementKey),
      claim: (input) => inner.claim(input),
      isCurrent: (input) => inner.isCurrent(input),
      grantRecovery: (input) => inner.grantRecovery(input),
      recordDisclosure: (input) => inner.recordDisclosure(input),
      recordOutcome,
    };
    const track = createDacsX402BuyerPaymentTrackV1({
      database: opened,
      workerId: "buyer-payment-worker",
      settlementStore,
      authorizationProvider: provider(retained, [
        { disposition: "settled-same", settlement: captured(retained) },
      ]),
      transport: {
        submitRetained: vi.fn(async () => ({
          disposition: "response" as const,
          disclosure: disclosure(),
        })),
      },
      prepareIntent: async () => retained,
      authorizePreparedIntent: () => true,
      effectLeaseDurationMs: 5,
      settlementLeaseDurationMs: 30_000,
      retryDelayMs: 1,
    });

    await expect(track(operationInput())).resolves.toMatchObject({
      status: "indeterminate",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(track(operationInput())).resolves.toMatchObject({
      status: "indeterminate",
      reasonCode: "x402-store-lease-held",
    });
    expect(recordOutcome).not.toHaveBeenCalled();
    await expect(inner.load(retained.settlementKey)).resolves.toMatchObject({
      status: "held",
      lease: { owner: "independent-settlement-worker" },
    });
  });

  it("does not trust a forged terminal result in the unkeyed inner checkpoint", async () => {
    const opened = await database();
    const retained = intent();
    const inner = createInMemoryX402BuyerSettlementStore();
    let forgeTerminal = false;
    const settlementStore: X402BuyerSettlementStore = {
      load: async (settlementKey) => forgeTerminal
        ? {
            status: "captured" as const,
            intent: retained,
            outcome: {
              outcomeVersion: "1" as const,
              status: "captured" as const,
              settlement: captured(retained),
            },
          }
        : inner.load(settlementKey),
      claim: (input) => inner.claim(input),
      isCurrent: (input) => inner.isCurrent(input),
      grantRecovery: (input) => inner.grantRecovery(input),
      recordDisclosure: (input) => inner.recordDisclosure(input),
      recordOutcome: (input) => inner.recordOutcome(input),
    };
    const submitRetained = vi.fn(async () => ({
      disposition: "response" as const,
      disclosure: disclosure(),
    }));
    const track = createDacsX402BuyerPaymentTrackV1({
      database: opened,
      workerId: "buyer-payment-worker",
      settlementStore,
      authorizationProvider: provider(retained, [
        { disposition: "indeterminate", reason: "chain-read-unavailable" },
        { disposition: "indeterminate", reason: "chain-read-unavailable" },
      ]),
      transport: { submitRetained },
      prepareIntent: async () => retained,
      authorizePreparedIntent: () => true,
      retryDelayMs: 1,
    });

    await expect(track(operationInput())).resolves.toMatchObject({
      status: "indeterminate",
    });
    forgeTerminal = true;
    await new Promise((resolve) => setTimeout(resolve, 3));
    await expect(track(operationInput())).resolves.toMatchObject({
      status: "indeterminate",
      reasonCode: "x402-chain-read-unavailable",
    });
    expect(submitRetained).toHaveBeenCalledTimes(1);
  });
});

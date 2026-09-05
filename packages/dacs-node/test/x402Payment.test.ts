import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_COORDINATOR_STORE_VERSION,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  EIP3009_AUTHORIZATION_CANCELED_TOPIC,
  EIP3009_AUTHORIZATION_USED_TOPIC,
  ERC20_TRANSFER_TOPIC,
  createInMemoryWalletSpendStateStore,
  createInMemoryX402BuyerSettlementStore,
  createWalletSpendAuthorityV1,
  createX402BuyerEvmAuthorizationProvider,
  createX402BuyerSettlementIntent,
  x402BuyerSettlementAuthenticationHash,
  type FixedPriceX402EffectFence,
  type FixedPriceX402OrderRecord,
  type FixedPriceX402TrackOperationInput,
  type X402BuyerAuthorizationProvider,
  type X402BuyerCapturedSettlement,
  type X402BuyerEffectFence,
  type X402BuyerEvmLog,
  type X402BuyerEvmReadClient,
  type X402BuyerEvmTransactionReceipt,
  type X402BuyerPaidRequestTransport,
  type X402BuyerSettlementIntent,
  type X402BuyerSettlementStore,
  type WalletSpendReservationV1,
} from "@kynesyslabs/dacs";
import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DACS_NODE_LIVE_PROFILE,
  createDacsX402BuyerPaymentTrackV1,
  createDacsX402WalletSpendRecoveryAuthenticatorV1,
} from "../src/index.js";
import {
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";
import {
  createAccountingTestWalletSpendAuthorityV1,
  createPermissiveTestWalletSpendAuthorityV1,
} from "./helpers/walletSpend.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = `did:demos:agent:${"11".repeat(32)}`;
const SELLER = `did:demos:agent:${"22".repeat(32)}`;
const BINDING_HASH = "a".repeat(64);
const LOCAL_BINDING_HASH = "b".repeat(64);
const PAYER = `0x${"11".repeat(20)}`;
const PAYEE = `0x${"22".repeat(20)}`;
const ASSET = `0x${"33".repeat(20)}`;
const TX = `0x${"aa".repeat(32)}`;
const BLOCK_HASH = `0x${"bb".repeat(32)}`;
const HEAD_HASH = `0x${"cc".repeat(32)}`;
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

function addressTopic(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function uintData(value: string): string {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function authorizationLog(
  overrides: Partial<X402BuyerEvmLog> = {},
): X402BuyerEvmLog {
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

function transferLog(
  overrides: Partial<X402BuyerEvmLog> = {},
): X402BuyerEvmLog {
  return authorizationLog({
    topics: [ERC20_TRANSFER_TOPIC, addressTopic(PAYER), addressTopic(PAYEE)],
    data: uintData("1000"),
    logIndex: 7,
    ...overrides,
  });
}

function transactionReceipt(
  overrides: Partial<X402BuyerEvmTransactionReceipt> = {},
): X402BuyerEvmTransactionReceipt {
  return {
    transactionHash: TX,
    blockNumber: 100,
    blockHash: BLOCK_HASH,
    status: "success",
    logs: [authorizationLog(), transferLog()],
    ...overrides,
  };
}

interface RecoveryReaderState {
  headBlock: number;
  used: boolean;
  throwAt?: "head" | "logs" | "state" | "receipt" | "ancestry";
}

function recoveryReader(
  overrides: Partial<RecoveryReaderState> = {},
): X402BuyerEvmReadClient {
  const state: RecoveryReaderState = {
    headBlock: 110,
    used: true,
    ...overrides,
  };
  return {
    async getFinalityHead() {
      if (state.throwAt === "head") throw new Error("head unavailable");
      return {
        chainId: 84532,
        blockNumber: state.headBlock,
        blockHash: HEAD_HASH,
        timestamp: 2_000,
      };
    },
    async getLogs(input) {
      if (state.throwAt === "logs") throw new Error("logs unavailable");
      if (input.topics[0] === EIP3009_AUTHORIZATION_CANCELED_TOPIC) return [];
      return state.used ? [authorizationLog()] : [];
    },
    async getTransactionReceipt() {
      if (state.throwAt === "receipt") throw new Error("receipt unavailable");
      return transactionReceipt();
    },
    async readAuthorizationState(input) {
      if (state.throwAt === "state") throw new Error("state unavailable");
      return {
        used: state.used,
        blockNumber: input.blockNumber,
        blockHash: input.blockHash,
      };
    },
    async confirmBlockAncestor(input) {
      if (state.throwAt === "ancestry") throw new Error("ancestry unavailable");
      return { canonical: true, ...input };
    },
  };
}

function recoveryReservation(
  retained = intent(),
): WalletSpendReservationV1 {
  return {
    reservationVersion: "1",
    reservationId: `x402:${retained.settlementKey}`,
    jobId: retained.jobId,
    phaseIndex: retained.phaseIndex,
    phase: "pay-x402",
    agreementHash: retained.agreementHash,
    settlementBindingHash: retained.bindingHash,
    railId: retained.railId,
    railDefinitionHash: retained.railDescriptorHash,
    wallet: retained.payer.toLowerCase(),
    chainId: retained.network,
    payee: retained.payee.toLowerCase(),
    finality: { model: "confirmation-depth", finalityBlocks: 5 },
    debits: [{
      asset: retained.asset.toLowerCase(),
      purpose: "service",
      expectedAmount: retained.amount,
      maximumAmount: retained.amount,
    }],
  };
}

async function retainRecoveryIntent(
  store: X402BuyerSettlementStore,
  retained: Readonly<X402BuyerSettlementIntent>,
  candidate?: ReturnType<typeof disclosure>,
  settlement?: Readonly<X402BuyerCapturedSettlement>,
): Promise<void> {
  const claim = await store.claim({
    intent: retained,
    owner: "wallet-recovery-fixture",
    now: 1_000,
    leaseDurationMs: 10_000,
  });
  if (claim.status !== "acquired") throw new Error("expected x402 settlement lease");
  if (settlement !== undefined) {
    const write = await store.recordOutcome({
      settlementKey: retained.settlementKey,
      bindingHash: retained.bindingHash,
      lease: claim.lease,
      outcome: {
        outcomeVersion: "1",
        status: "captured",
        settlement,
      },
      now: 1_000,
    });
    if (write.status !== "recorded") throw new Error("expected captured settlement");
    return;
  }
  if (candidate === undefined) return;
  const write = await store.recordDisclosure({
    settlementKey: retained.settlementKey,
    bindingHash: retained.bindingHash,
    lease: claim.lease,
    disclosure: candidate,
    now: 1_000,
  });
  if (write.status !== "recorded") throw new Error("expected retained disclosure");
}

const validSignature = async (input: Readonly<{
  authorization: Readonly<{ from: string }>;
}>) => ({
  disposition: "valid" as const,
  signer: input.authorization.from,
});

const safeUnused = async (input: Readonly<{
  intent: Readonly<X402BuyerSettlementIntent>;
}>) => ({
  disposition: "safe" as const,
  bindingHash: input.intent.bindingHash,
});

async function authenticatedUnusedHash(
  retained: Readonly<X402BuyerSettlementIntent>,
  client: X402BuyerEvmReadClient,
): Promise<string> {
  const provider = createX402BuyerEvmAuthorizationProvider({
    chainId: 84532,
    minimumConfirmations: 5,
    authorizationSearchFromBlock: 1,
    client,
    authorizeIntent: async ({ intent: candidate }) => ({
      disposition: "authorized",
      bindingHash: candidate.bindingHash,
    }),
    verifySignature: validSignature,
    confirmUnused: safeUnused,
  });
  const fence: Readonly<X402BuyerEffectFence> = Object.freeze({
    owner: "proof-fixture",
    generation: 1,
    settlementKey: retained.settlementKey,
    bindingHash: retained.bindingHash,
    idempotencyKey: retained.settlementKey,
    assertCurrent: async () => undefined,
  });
  const lookup = await provider.lookup(retained, undefined, fence);
  if (lookup.disposition !== "observed") throw new Error("expected observation");
  const recovered = await provider.authenticate(retained, lookup, undefined, fence);
  if (recovered.disposition !== "unused") throw new Error("expected unused proof");
  return recovered.authenticationHash;
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
    const walletSpendAuthority = createAccountingTestWalletSpendAuthorityV1({
      wallet: PAYER.toLowerCase(),
      chainId: "eip155:84532",
      asset: ASSET.toLowerCase(),
    });
    const track = createDacsX402BuyerPaymentTrackV1({
      walletSpendAuthority,
      finalityBlocks: 1,
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
    expect(await walletSpendAuthority.inspect()).toMatchObject({
      activeEffects: 0,
      retainedReservations: 1,
      assets: [{ cumulativeSettledDebit: "1000" }],
    });
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
      walletSpendAuthority: createPermissiveTestWalletSpendAuthorityV1(),
      finalityBlocks: 1,
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
      walletSpendAuthority: createPermissiveTestWalletSpendAuthorityV1(),
      finalityBlocks: 1,
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
      effectLeaseDurationMs: 1_000,
      settlementLeaseDurationMs: 30_000,
      retryDelayMs: 1,
    });

    await expect(track(operationInput())).resolves.toMatchObject({
      status: "indeterminate",
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
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
      walletSpendAuthority: createPermissiveTestWalletSpendAuthorityV1(),
      finalityBlocks: 1,
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

  it("re-authenticates the exact finalized x402 transfer and complete debit", async () => {
    const retained = intent();
    const settlementStore = createInMemoryX402BuyerSettlementStore();
    await retainRecoveryIntent(
      settlementStore,
      retained,
      undefined,
      captured(retained),
    );
    const authenticateRecovery =
      createDacsX402WalletSpendRecoveryAuthenticatorV1({
        settlementStore,
        owner: "x402-wallet-recovery-test",
        chainId: 84532,
        minimumConfirmations: 5,
        authorizationSearchFromBlock: 1,
        client: recoveryReader(),
        verifySignature: validSignature,
        confirmUnused: safeUnused,
      });
    const reservation = recoveryReservation(retained);
    const exact = {
      disposition: "settled" as const,
      evidenceHash: captured(retained).authenticationHash,
      debits: [{
        asset: retained.asset.toLowerCase(),
        purpose: "service" as const,
        amount: retained.amount,
      }],
    };

    await expect(authenticateRecovery(reservation, exact)).resolves.toBe(true);
    await expect(authenticateRecovery(reservation, {
      ...exact,
      evidenceHash: "0".repeat(64),
    })).resolves.toBe(false);
    await expect(authenticateRecovery(reservation, {
      ...exact,
      debits: [{ ...exact.debits[0]!, amount: "999" }],
    })).resolves.toBe(false);
    await expect(authenticateRecovery({
      ...reservation,
      payee: `0x${"99".repeat(20)}`,
    }, exact)).resolves.toBe(false);

    const absent = createDacsX402WalletSpendRecoveryAuthenticatorV1({
      settlementStore: createInMemoryX402BuyerSettlementStore(),
      owner: "x402-wallet-recovery-test",
      chainId: 84532,
      minimumConfirmations: 5,
      authorizationSearchFromBlock: 1,
      client: recoveryReader(),
      verifySignature: validSignature,
      confirmUnused: safeUnused,
    });
    await expect(absent(reservation, exact)).resolves.toBe(false);

    const activeStore = createInMemoryX402BuyerSettlementStore();
    await expect(activeStore.claim({
      intent: retained,
      owner: "paid-request-worker",
      now: Date.now(),
      leaseDurationMs: 10_000,
    })).resolves.toMatchObject({ status: "acquired" });
    const active = createDacsX402WalletSpendRecoveryAuthenticatorV1({
      settlementStore: activeStore,
      owner: "x402-wallet-recovery-test",
      chainId: 84532,
      minimumConfirmations: 5,
      authorizationSearchFromBlock: 1,
      client: recoveryReader(),
      verifySignature: validSignature,
      confirmUnused: safeUnused,
    });
    await expect(active(reservation, exact)).resolves.toBe(false);

    const unavailable = createDacsX402WalletSpendRecoveryAuthenticatorV1({
      settlementStore,
      owner: "x402-wallet-recovery-test",
      chainId: 84532,
      minimumConfirmations: 5,
      authorizationSearchFromBlock: 1,
      client: recoveryReader({ throwAt: "head" }),
      verifySignature: validSignature,
      confirmUnused: safeUnused,
    });
    await expect(unavailable(reservation, exact)).resolves.toBe(false);
  });

  it("captures recovery capabilities once with their original receivers", async () => {
    const retained = intent();
    const innerStore = createInMemoryX402BuyerSettlementStore();
    await retainRecoveryIntent(innerStore, retained, undefined, captured(retained));
    const store = {
      load(settlementKey: string) {
        expect(this).toBe(store);
        return innerStore.load(settlementKey);
      },
      claim(input: Parameters<X402BuyerSettlementStore["claim"]>[0]) {
        expect(this).toBe(store);
        return innerStore.claim(input);
      },
      isCurrent(input: Parameters<X402BuyerSettlementStore["isCurrent"]>[0]) {
        expect(this).toBe(store);
        return innerStore.isCurrent(input);
      },
      grantRecovery: (input: Parameters<X402BuyerSettlementStore["grantRecovery"]>[0]) =>
        innerStore.grantRecovery(input),
      recordDisclosure: (
        input: Parameters<X402BuyerSettlementStore["recordDisclosure"]>[0],
      ) => innerStore.recordDisclosure(input),
      recordOutcome: (input: Parameters<X402BuyerSettlementStore["recordOutcome"]>[0]) =>
        innerStore.recordOutcome(input),
    };
    const innerClient = recoveryReader();
    const client: X402BuyerEvmReadClient = {
      getFinalityHead() {
        expect(this).toBe(client);
        return innerClient.getFinalityHead();
      },
      getLogs(input) {
        expect(this).toBe(client);
        return innerClient.getLogs(input);
      },
      getTransactionReceipt(transactionHash) {
        expect(this).toBe(client);
        return innerClient.getTransactionReceipt(transactionHash);
      },
      readAuthorizationState(input) {
        expect(this).toBe(client);
        return innerClient.readAuthorizationState(input);
      },
      confirmBlockAncestor(input) {
        expect(this).toBe(client);
        return innerClient.confirmBlockAncestor(input);
      },
    };
    const options = {
      settlementStore: store,
      owner: "x402-wallet-recovery-test",
      chainId: 84532,
      minimumConfirmations: 5,
      authorizationSearchFromBlock: 1,
      client,
      verifySignature: validSignature,
      confirmUnused: safeUnused,
    };
    const metadataGetter = vi.fn(() => 0);
    Object.defineProperty(store.load, "length", {
      configurable: true,
      get: metadataGetter,
    });
    const authenticateRecovery =
      createDacsX402WalletSpendRecoveryAuthenticatorV1(options);
    expect(Object.isFrozen(authenticateRecovery)).toBe(true);
    expect(metadataGetter).not.toHaveBeenCalled();
    Object.assign(store, {
      load: vi.fn(async () => ({ status: "absent" as const })),
      claim: vi.fn(async () => ({ status: "corrupt" as const, reason: "swapped" })),
      isCurrent: vi.fn(async () => false),
    });
    Object.assign(client, {
      getFinalityHead: vi.fn(async () => { throw new Error("swapped"); }),
      getLogs: vi.fn(async () => []),
      getTransactionReceipt: vi.fn(async () => { throw new Error("swapped"); }),
      readAuthorizationState: vi.fn(async () => { throw new Error("swapped"); }),
      confirmBlockAncestor: vi.fn(async () => { throw new Error("swapped"); }),
    });
    Object.assign(options, {
      verifySignature: vi.fn(async () => ({ disposition: "invalid" as const })),
    });

    const exact = {
      disposition: "settled" as const,
      evidenceHash: captured(retained).authenticationHash,
      debits: [{
        asset: retained.asset.toLowerCase(),
        purpose: "service" as const,
        amount: retained.amount,
      }],
    };
    await expect(authenticateRecovery(recoveryReservation(retained), exact))
      .resolves.toBe(true);
    expect(metadataGetter).not.toHaveBeenCalled();
  });

  it("rejects accessors, proxies, and non-literal current-fence results", async () => {
    const getter = vi.fn(() => createInMemoryX402BuyerSettlementStore());
    const accessorOptions = {
      owner: "x402-wallet-recovery-test",
      chainId: 84532,
      minimumConfirmations: 5,
      authorizationSearchFromBlock: 1,
      client: recoveryReader(),
    } as Record<string, unknown>;
    Object.defineProperty(accessorOptions, "settlementStore", {
      enumerable: true,
      get: getter,
    });
    expect(() => createDacsX402WalletSpendRecoveryAuthenticatorV1(
      accessorOptions as unknown as Parameters<
        typeof createDacsX402WalletSpendRecoveryAuthenticatorV1
      >[0],
    )).toThrow(/options are invalid/);
    expect(getter).not.toHaveBeenCalled();
    expect(() => createDacsX402WalletSpendRecoveryAuthenticatorV1(
      new Proxy(accessorOptions, {}) as unknown as Parameters<
        typeof createDacsX402WalletSpendRecoveryAuthenticatorV1
      >[0],
    )).toThrow(/options are invalid/);

    const retained = intent();
    const innerStore = createInMemoryX402BuyerSettlementStore();
    await retainRecoveryIntent(innerStore, retained);
    const malformedFenceStore = {
      load: (settlementKey: string) => innerStore.load(settlementKey),
      claim: (input: Parameters<X402BuyerSettlementStore["claim"]>[0]) =>
        innerStore.claim(input),
      isCurrent: vi.fn(async () => ({} as unknown as boolean)),
      grantRecovery: (input: Parameters<X402BuyerSettlementStore["grantRecovery"]>[0]) =>
        innerStore.grantRecovery(input),
      recordDisclosure: (
        input: Parameters<X402BuyerSettlementStore["recordDisclosure"]>[0],
      ) => innerStore.recordDisclosure(input),
      recordOutcome: (input: Parameters<X402BuyerSettlementStore["recordOutcome"]>[0]) =>
        innerStore.recordOutcome(input),
    };
    const authenticateRecovery =
      createDacsX402WalletSpendRecoveryAuthenticatorV1({
        settlementStore: malformedFenceStore,
        owner: "x402-wallet-recovery-test",
        chainId: 84532,
        minimumConfirmations: 5,
        authorizationSearchFromBlock: 1,
        client: recoveryReader(),
        verifySignature: validSignature,
        confirmUnused: safeUnused,
      });
    const exact = {
      disposition: "settled" as const,
      evidenceHash: captured(retained).authenticationHash,
      debits: [{
        asset: retained.asset.toLowerCase(),
        purpose: "service" as const,
        amount: retained.amount,
      }],
    };
    await expect(authenticateRecovery(recoveryReservation(retained), exact))
      .resolves.toBe(false);
    expect(malformedFenceStore.isCurrent).toHaveBeenCalled();
  });

  it("releases x402 spend only for a current authenticated unused proof", async () => {
    const retained = intent();
    const reservation = recoveryReservation(retained);
    const settlementStore = createInMemoryX402BuyerSettlementStore();
    await retainRecoveryIntent(settlementStore, retained);
    const client = recoveryReader({ used: false });
    const authenticateRecovery =
      createDacsX402WalletSpendRecoveryAuthenticatorV1({
        settlementStore,
        owner: "x402-wallet-recovery-test",
        chainId: 84532,
        minimumConfirmations: 5,
        authorizationSearchFromBlock: 1,
        client,
        verifySignature: validSignature,
        confirmUnused: safeUnused,
      });
    const now = { value: 1_000 };
    const ceiling = "999999999999999999999999";
    const wallet = createWalletSpendAuthorityV1({
      policyVersion: "1",
      policyId: "x402-recovery-test",
      wallet: retained.payer.toLowerCase(),
      chainId: retained.network,
      maximumConcurrentEffects: 1,
      maximumRetainedReservations: 10,
      assets: [{
        asset: retained.asset.toLowerCase(),
        maximumPerOrderDebit: ceiling,
        maximumNetworkFeeDebit: "0",
        minimumReserve: "0",
        rollingWindowMs: 86_400_000,
        maximumRollingEffects: 10,
        maximumRollingDebit: ceiling,
        maximumCumulativeDebit: ceiling,
        maximumCounterpartyDebit: ceiling,
      }],
    }, {
      store: createInMemoryWalletSpendStateStore(),
      readBalance: async () => ceiling,
      authenticateRecovery,
      now: () => now.value,
      owner: "x402-wallet-recovery-test",
      leaseDurationMs: 100,
    });
    expect((await wallet.reserve(reservation)).status).toBe("reserved");
    now.value = 1_101;

    const staleHash = await authenticatedUnusedHash(
      retained,
      recoveryReader({ used: false, headBlock: 109 }),
    );
    await expect(wallet.reconcile(reservation, {
      disposition: "terminal-absent",
      evidenceHash: staleHash,
    })).rejects.toThrow(/authentication failed/);
    expect((await wallet.inspect()).activeEffects).toBe(1);

    const exactHash = await authenticatedUnusedHash(retained, client);
    await expect(wallet.reconcile(reservation, {
      disposition: "terminal-absent",
      evidenceHash: exactHash,
    })).resolves.toBe("released");
    expect((await wallet.inspect()).activeEffects).toBe(0);
  });
});

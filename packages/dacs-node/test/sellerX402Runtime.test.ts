import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  fixedPriceX402OrderBindingHash,
  fixedPriceX402OrderLocalBindingHash,
  type FixedPriceX402OrderInput,
  type FixedPriceX402Track,
  type FixedPriceX402TrackOperationInput,
} from "@kynesyslabs/dacs/commerce";
import { afterEach, describe, expect, it, vi } from "vitest";

const runDeliveryReady = vi.hoisted(() => vi.fn());
const resumeFinalisation = vi.hoisted(() => vi.fn());
const getFinalisationStatus = vi.hoisted(() => vi.fn());
const createSpine = vi.hoisted(() => vi.fn());

vi.mock("@kynesyslabs/dacs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kynesyslabs/dacs")>()),
  createX402SellerSpine: createSpine,
  runDurableFulfilmentToDeliveryReady: runDeliveryReady,
  resumeDeliveryFinalisation: resumeFinalisation,
  getDeliveryFinalisationStatus: getFinalisationStatus,
}));

import { DACS_NODE_LIVE_PROFILE } from "../src/config.js";
import { putDacsLiveOrderInputV1 } from "../src/orderInput.js";
import type { DacsLiveRoleOperationContextV1 } from "../src/roleRuntime.js";
import { createDacsSellerX402RuntimeV1 } from "../src/sellerX402Runtime.js";
import {
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = `did:demos:agent:${"11".repeat(32)}`;
const SELLER = `did:demos:agent:${"22".repeat(32)}`;

function order(): FixedPriceX402OrderInput {
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
        railDefinitionRef: "dacs4:rail:x402%3Aruntime:2",
        railDefinitionHash: "2".repeat(64),
        railId: "x402:runtime",
        railVersion: 2,
        railType: "x402",
        phaseHandler: "pay-x402",
        network: "eip155:8453",
        availability: "live",
      },
    },
    sdkJobs: {
      role: "seller",
      agreement: `seller:agreement:${JOB_ID}`,
      payment: `seller:payment:${JOB_ID}`,
      paymentEvidence: `seller:payment-evidence:${JOB_ID}`,
      fulfilment: `seller:fulfilment:${JOB_ID}`,
      deliveryEvidence: `seller:delivery-evidence:${JOB_ID}`,
      audit: `seller:audit:${JOB_ID}`,
    },
  };
}

function authorization() {
  const paymentAuthorization = {
    jobId: JOB_ID,
    phaseIndex: 2,
    agreementHash: "3".repeat(64),
    listingRef: { listingId: "runtime", version: 4, contentHash: "4".repeat(64) },
    railId: "x402:runtime",
    railRegistryVersion: 2,
    commitment: {
      ref: "dacs3:commitment:runtime",
      contentHash: "5".repeat(64),
      finalizedAt: 1_000,
      signer: SELLER,
    },
    settlementIdentity: {
      kind: "evm" as const,
      chainId: 8453,
      txHash: `0x${"7".repeat(64)}`,
      logIndex: 0,
      includedAt: 2_000,
    },
    settlementId: "settlement-runtime",
    evidenceHash: "8".repeat(64),
    evidenceInput: {},
    payoutBindingTier: 1 as const,
  };
  return {
    authorizationVersion: "1" as const,
    sessionAuthorization: {
      scopeVersion: "1" as const,
      jobId: JOB_ID,
      paymentPhaseIndex: 2,
      deliveryPhaseIndex: 3,
      payer: `0x${"11".repeat(20)}`,
      payerPayingKey: "cci-xm:evm:runtime",
      httpResource: `https://seller.example/deliver/${JOB_ID}`,
      railId: "x402:runtime",
      railRegistryVersion: 2,
      agreementRef: "dacs3:agreement:runtime",
      agreementHash: "3".repeat(64),
      listingRef: paymentAuthorization.listingRef,
      commitmentRef: paymentAuthorization.commitment.ref,
      commitmentContentHash: paymentAuthorization.commitment.contentHash,
      commitmentFinalizedAt: 1_000,
      expected: {
        network: "eip155:8453" as const,
        payTo: `0x${"22".repeat(20)}`,
        amount: "1",
        asset: `0x${"33".repeat(20)}`,
        eip712: { name: "USDC", version: "2" },
      },
    },
    paymentPermitId: "permit-runtime",
    paymentAuthorization,
  };
}

function trackOperation(
  record: Awaited<ReturnType<ReturnType<DacsNodeSqliteDatabase["createLiveCoordinatorStore"]>["load"]>> &
    { status: "ok" },
  track: FixedPriceX402Track,
): FixedPriceX402TrackOperationInput {
  return {
    order: record.record,
    fence: {
      role: "seller",
      jobId: JOB_ID,
      bindingHash: record.record.bindingHash,
      localBindingHash: record.record.localBindingHash,
      track,
      owner: "seller-worker",
      generation: 1,
      idempotencyKey: `seller:${track}:${JOB_ID}`,
      assertCurrent: vi.fn(async () => undefined),
    },
  };
}

describe("seller x402 coordinator projection runtime", () => {
  const roots: string[] = [];
  const databases: DacsNodeSqliteDatabase[] = [];

  afterEach(() => {
    vi.clearAllMocks();
    for (const database of databases.splice(0).reverse()) database.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function open(): Promise<DacsNodeSqliteDatabase> {
    const root = mkdtempSync(join(tmpdir(), "dacs-seller-x402-runtime-"));
    roots.push(root);
    const database = await openDacsNodeSqliteDatabase({
      databasePath: join(root, "seller.sqlite"),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "seller",
      authority: SELLER,
    });
    databases.push(database);
    return database;
  }

  it("projects retained settlement, delivery-ready and final evidence", async () => {
    const database = await open();
    const sellerOrder = order();
    await database.createLiveCoordinatorStore("seller").create({
      role: "seller",
      order: sellerOrder,
      bindingHash: fixedPriceX402OrderBindingHash(sellerOrder),
      localBindingHash: fixedPriceX402OrderLocalBindingHash(sellerOrder),
    });
    putDacsLiveOrderInputV1({
      database,
      order: sellerOrder,
      application: { product: "runtime" },
    });
    const loaded = await database.createLiveCoordinatorStore("seller").load("seller", JOB_ID);
    if (loaded.status !== "ok") throw new Error();

    const exactAuthorization = authorization();
    const settlementStore = {
      load: vi.fn(async () => ({
        status: "settled" as const,
        intent: {},
        outcome: {
          status: "settled" as const,
          settlement: {
            success: true as const,
            transaction: `0x${"7".repeat(64)}`,
            network: "eip155:8453",
            headers: {},
            requirements: {},
          },
        },
      })),
      claim: vi.fn(),
      recordOutcome: vi.fn(),
    };
    const receiptStore = {
      claim: vi.fn(),
      consumePermit: vi.fn(),
      inspectPermit: vi.fn(async () => ({
        status: "available" as const,
        claim: { authorization: exactAuthorization.paymentAuthorization },
      })),
    };
    const context = {
      role: "seller",
      authority: SELLER,
      peerAuthority: BUYER,
      database,
      sessionStore: {},
      commerceStores: {
        role: "seller",
        x402Settlement: settlementStore,
        sellerReceipts: receiptStore,
      },
      evm: { role: "seller", address: `0x${"22".repeat(20)}` },
    } as unknown as DacsLiveRoleOperationContextV1;

    let paywallHandlers: Record<string, (...args: never[]) => unknown> | undefined;
    let capturedSpineOptions: Record<string, unknown> | undefined;
    createSpine.mockImplementation((spineOptions: Record<string, unknown>) => {
      capturedSpineOptions = spineOptions;
      return {
        settlementStore: spineOptions.settlementStore,
        authorizeSettlement: vi.fn(),
        reconcileSettlement: vi.fn(),
        authorizePayment: vi.fn(async () => ({
          disposition: "authorized",
          authorization: exactAuthorization,
        })),
        fulfil: vi.fn(),
      };
    });
    const createPaywall = vi.fn(async (_config, handlers) => {
      paywallHandlers = handlers as unknown as Record<string, (...args: never[]) => unknown>;
      return { terms: exactAuthorization.sessionAuthorization.expected, handle: vi.fn() };
    });
    runDeliveryReady.mockResolvedValue({
      status: "delivery-ready",
      result: {
        fulfilmentId: "fulfilment-runtime",
        jobId: JOB_ID,
        deliveryPhaseIndex: 3,
        logicalAddress: "dacs4:delivery:runtime",
        evidenceHash: "9".repeat(64),
      },
      finalisation: {
        finalisationVersion: "1",
        jobId: JOB_ID,
        fulfilmentId: "fulfilment-runtime",
        deliveryPhaseIndex: 3,
        handoffBindingHash: "a".repeat(64),
        evidenceHash: "9".repeat(64),
      },
    });
    resumeFinalisation.mockResolvedValue({
      decision: "completed",
      fulfilmentId: "fulfilment-runtime",
      evidence: {
        evidenceVersion: "1",
        jobId: JOB_ID,
        phase: "deliver-attested-payload",
        observedAt: 3_000,
        outcome: "success",
        deliverableContentHash: "b".repeat(64),
        deliverableAnchor: { kind: "storage-program", locator: "dacs4:delivery:runtime" },
        signature: { algorithm: "ed25519", signer: SELLER, value: "c2ln" },
      },
      evidenceHash: "9".repeat(64),
      evidenceRef: {
        anchor: { kind: "storage-program", locator: "dacs4:evidence:runtime" },
        contentHash: "9".repeat(64),
      },
      consumedPaymentAuthorization: exactAuthorization.paymentAuthorization,
    });

    const runtime = await createDacsSellerX402RuntimeV1({
      context,
      workerId: "seller-worker",
      paywall: {
        route: "GET /deliver/:jobId",
        network: "eip155:8453",
        payTo: `0x${"22".repeat(20)}`,
        amount: "1",
        asset: `0x${"33".repeat(20)}`,
        eip712: { name: "USDC", version: "2" },
        facilitator: { verify: vi.fn(), settle: vi.fn(), getSupported: vi.fn() },
      },
      spine: {
        reconcileSettlement: vi.fn(),
        resolveCommittedSession: vi.fn(),
        paymentIntakeDeps: {} as never,
        fulfilmentDeps: {} as never,
        fulfilmentDurability: { leaseTtlMs: 30_000 } as never,
        deliveryReady: { renderResponse: vi.fn() },
        renderResponse: vi.fn(),
      },
      publicBaseUrl: "https://seller.example",
      resolveHttpRequest: () => ({ status: "not-matched" }),
      resolveOrderScope: () => ({ paymentPhaseIndex: 2, deliveryPhaseIndex: 3 }),
      authorizePaymentComplete: () => true,
      createPaywall: createPaywall as never,
    });

    await expect(runtime.payment(trackOperation(loaded, "payment"))).resolves.toMatchObject({
      status: "pending-retry",
      reasonCode: "seller-x402-authorization-pending",
    });
    expect(paywallHandlers).toBeDefined();
    await expect(paywallHandlers!.authorizePayment!()).resolves.toMatchObject({
      disposition: "authorized",
    });
    expect(capturedSpineOptions).toBeDefined();
    const deliveryReadyRenderer = (capturedSpineOptions!.deliveryReady as {
      renderResponse(input: unknown): Promise<unknown>;
    }).renderResponse;
    await deliveryReadyRenderer({
      jobId: JOB_ID,
      paymentPhaseIndex: 2,
      deliveryPhaseIndex: 3,
      payer: exactAuthorization.sessionAuthorization.payer,
      authorization: exactAuthorization,
      deliveryReady: await runDeliveryReady(),
    });
    await expect(runtime.payment(trackOperation(loaded, "payment"))).resolves.toMatchObject({
      status: "final",
      outcome: "success",
      reference: `0x${"7".repeat(64)}`,
    });
    await expect(runtime.delivery(trackOperation(loaded, "delivery"))).resolves.toEqual({
      status: "final",
      outcome: "success",
      reference: "dacs4:delivery:runtime",
      authenticationHash: "9".repeat(64),
    });
    await expect(runtime.deliveryEvidence(
      trackOperation(loaded, "delivery-evidence"),
    )).resolves.toEqual({
      status: "final",
      outcome: "success",
      reference: "dacs4:evidence:runtime",
      authenticationHash: "9".repeat(64),
    });
    expect(runDeliveryReady).toHaveBeenCalledTimes(2);
    expect(resumeFinalisation).toHaveBeenCalledOnce();
  });
});

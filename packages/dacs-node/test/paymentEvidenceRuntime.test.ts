import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AnchorReceipt,
  AttestationRef,
  SettlementEvidence,
} from "@kynesyslabs/dacs/artifacts";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import {
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  fixedPriceX402OrderBindingHash,
  fixedPriceX402OrderLocalBindingHash,
  type FixedPriceX402OrderInput,
  type FixedPriceX402ProtocolBinding,
  type FixedPriceX402TrackOperationInput,
} from "@kynesyslabs/dacs/commerce";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DACS_NODE_LIVE_PROFILE } from "../src/config.js";
import { putDacsLiveOrderInputV1 } from "../src/orderInput.js";
import {
  createDacsBuyerPaymentEvidenceRuntimeV1,
  createDacsBuyerDemosPaymentEvidenceRuntimeV1,
  createDacsSellerPaymentEvidenceRuntimeV1,
  type DacsSellerPaymentEvidenceRuntimeV1,
} from "../src/paymentEvidenceRuntime.js";
import type {
  DacsLiveRoleInboundOperationContextV1,
  DacsLiveRoleOperationContextV1,
} from "../src/roleRuntime.js";
import {
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";
import type { DacsHttpAuthenticatedEnvelopeV1 } from "../src/transport/envelope.js";
import { createDacsSellerSettlementPublicationTrackV1 } from
  "../src/sellerSettlementRuntime.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = `did:demos:agent:${"1".repeat(64)}`;
const SELLER = `did:demos:agent:${"2".repeat(64)}`;

const PROTOCOL: FixedPriceX402ProtocolBinding = {
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
};

function order(role: "buyer" | "seller"): FixedPriceX402OrderInput {
  return {
    jobId: JOB_ID,
    buyer: BUYER,
    seller: SELLER,
    protocol: PROTOCOL,
    sdkJobs: role === "buyer"
      ? {
          role,
          agreement: `buyer:agreement:${JOB_ID}`,
          payment: `buyer:payment:${JOB_ID}`,
          paymentEvidence: `buyer:payment-evidence:${JOB_ID}`,
          buyerReceived: `buyer:received:${JOB_ID}`,
          audit: `buyer:audit:${JOB_ID}`,
        }
      : {
          role,
          agreement: `seller:agreement:${JOB_ID}`,
          payment: `seller:payment:${JOB_ID}`,
          paymentEvidence: `seller:payment-evidence:${JOB_ID}`,
          fulfilment: `seller:fulfilment:${JOB_ID}`,
          deliveryEvidence: `seller:delivery-evidence:${JOB_ID}`,
          audit: `seller:audit:${JOB_ID}`,
        },
  };
}

function operation(
  input: Readonly<FixedPriceX402OrderInput>,
): FixedPriceX402TrackOperationInput {
  const role = input.sdkJobs.role;
  const bindingHash = fixedPriceX402OrderBindingHash(input);
  const localBindingHash = fixedPriceX402OrderLocalBindingHash(input);
  return {
    order: {
      role,
      jobId: input.jobId,
      buyer: input.buyer,
      seller: input.seller,
      protocol: input.protocol,
      bindingHash,
      localBindingHash,
      sdkJobs: input.sdkJobs,
    },
    fence: {
      role,
      jobId: input.jobId,
      bindingHash,
      localBindingHash,
      track: "payment-evidence",
      owner: `${role}-worker`,
      generation: 1,
      idempotencyKey: `${role}:payment-evidence:${input.jobId}`,
      assertCurrent: vi.fn(async () => undefined),
    },
  };
}

function evidence(): SettlementEvidence {
  return {
    evidenceVersion: "1",
    jobId: JOB_ID,
    phase: "pay-x402",
    outcome: "success",
    observedAt: 7_000,
    paymentTxRefs: [{
      kind: "x402-event",
      httpResource: "https://seller.example/orders/runtime",
      paymentReceiptHash: "3".repeat(64),
      settlementTxHash: "4".repeat(64),
      chainId: 8453,
      logIndex: 0,
      protocolVersion: "2",
    }],
    paymentAmount: { amount: "1", currency: "USDC" },
    settlementFinality: { model: "provider-receipt", finalityObservedAt: 7_000 },
    signature: { algorithm: "ed25519", signer: SELLER, value: "c2ln" },
  };
}

function anchor(logicalAddress: string, evidenceHash: string): Readonly<{
  evidenceRef: AttestationRef;
  anchorReceipt: AnchorReceipt;
}> {
  return {
    evidenceRef: {
      anchor: { kind: "storage-program", locator: logicalAddress },
      contentHash: evidenceHash,
      signer: SELLER,
    },
    anchorReceipt: {
      receiptVersion: "1",
      substrate: "demos",
      finalityProfile: "demos-bft",
      logicalAddress,
      nativeAddress: `native:${logicalAddress}`,
      contentHash: evidenceHash,
      transactionRef: { kind: "demos", value: `tx:${evidenceHash}` },
      writer: BUYER,
      state: "finalized",
      observationDisposition: "established",
      observedAt: 7_000,
      blockRef: { id: "block-10", height: "10", timestamp: 7_000 },
      evidence: { kind: "demos-bft-proof", value: "proof" },
    },
  };
}

function authenticated(
  type: "payment-evidence-request" | "payment-evidence-completion",
  payload: unknown,
  sender: string,
  audience: string,
): Readonly<DacsHttpAuthenticatedEnvelopeV1> {
  return {
    status: "authenticated",
    envelope: {
      type,
      jobId: JOB_ID,
      sender,
      audience,
      payload,
    },
    authenticationHash: type === "payment-evidence-request"
      ? "5".repeat(64) : "6".repeat(64),
  } as unknown as DacsHttpAuthenticatedEnvelopeV1;
}

function acknowledgement(disposition: "accepted" | "existing" | "rejected") {
  return {
    status: "authenticated",
    envelope: { type: "acknowledgement", payload: { disposition } },
  } as unknown as DacsHttpAuthenticatedEnvelopeV1;
}

describe("live payment-evidence runtime", () => {
  const roots: string[] = [];
  const databases: DacsNodeSqliteDatabase[] = [];

  afterEach(() => {
    for (const database of databases.splice(0).reverse()) database.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function open(role: "buyer" | "seller"): Promise<DacsNodeSqliteDatabase> {
    const root = mkdtempSync(join(tmpdir(), `dacs-payment-evidence-${role}-`));
    roots.push(root);
    const database = await openDacsNodeSqliteDatabase({
      databasePath: join(root, "actor.sqlite"),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role,
      authority: role === "buyer" ? BUYER : SELLER,
    });
    databases.push(database);
    const value = order(role);
    await database.createLiveCoordinatorStore(role).create({
      role,
      order: value,
      bindingHash: fixedPriceX402OrderBindingHash(value),
      localBindingHash: fixedPriceX402OrderLocalBindingHash(value),
    });
    putDacsLiveOrderInputV1({ database, order: value, application: { product: "runtime" } });
    return database;
  }

  it("completes the buyer-owned anchor across separate durable actor stores", async () => {
    const buyerDatabase = await open("buyer");
    const sellerDatabase = await open("seller");
    let buyerRuntime: ReturnType<typeof createDacsBuyerPaymentEvidenceRuntimeV1>;
    let sellerRuntime: ReturnType<typeof createDacsSellerPaymentEvidenceRuntimeV1>;

    let anchoredArtifact: Record<string, unknown> | undefined;
    const anchorWriteOnce = vi.fn(async (logicalAddress: string, value: object) => {
      anchoredArtifact = structuredClone(value) as Record<string, unknown>;
      return { address: `native:${logicalAddress}` };
    });
    const buyerContext = {
      role: "buyer",
      authority: BUYER,
      peerAuthority: SELLER,
      database: buyerDatabase,
      demos: {
        role: "buyer",
        adapter: {
          anchorWriteOnce,
          resolveDemosAnchorReceipt: async (input: {
            logicalAddress: string;
            contentHash: string;
          }) => anchor(input.logicalAddress, input.contentHash).anchorReceipt,
          verifyDemosAnchorReceipt: async () => true,
          readAnchor: async () => anchoredArtifact === undefined
            ? null : structuredClone(anchoredArtifact),
        },
      },
      sendMessage: async (message: { type: string; payload: unknown }) => {
        const handled = await sellerRuntime.handleMessage(
          authenticated(message.type as "payment-evidence-completion", message.payload, BUYER, SELLER),
          { role: "seller" } as DacsLiveRoleInboundOperationContextV1,
        );
        return acknowledgement(handled.disposition);
      },
    } as unknown as DacsLiveRoleOperationContextV1;
    const sellerContext = {
      role: "seller",
      authority: SELLER,
      peerAuthority: BUYER,
      database: sellerDatabase,
      demos: {
        role: "seller",
        signComponent: vi.fn(),
      },
      sendMessage: async (message: { type: string; payload: unknown }) => {
        const handled = await buyerRuntime.handleMessage(
          authenticated(message.type as "payment-evidence-request", message.payload, SELLER, BUYER),
          { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
        );
        return acknowledgement(handled.disposition);
      },
    } as unknown as DacsLiveRoleOperationContextV1;

    buyerRuntime = createDacsBuyerDemosPaymentEvidenceRuntimeV1({
      context: buyerContext,
      workerId: "buyer-worker",
      verifyEvidence: () => ({ disposition: "valid" }),
    });
    sellerRuntime = createDacsSellerPaymentEvidenceRuntimeV1({
      context: sellerContext,
      workerId: "seller-worker",
      verifyAnchorReceipt: () => ({ disposition: "valid" }),
    });

    const artifact = evidence();
    const evidenceHash = contentHash(artifact as unknown as Record<string, unknown>);
    const logicalAddress = `dacs4:payment:${JOB_ID}:x402%3Aruntime:0`;
    const sellerOperation = operation(order("seller"));
    const buyerOperation = operation(order("buyer"));
    const input = {
      effectId: `seller-settlement:${JOB_ID}`,
      logicalAddress,
      evidenceHash,
      evidence: artifact,
      expectedWriter: { role: "buyer" as const, primaryClaim: BUYER },
    };

    await expect(sellerRuntime.anchorEvidence(sellerOperation, input)).resolves.toMatchObject({
      disposition: "indeterminate",
    });
    await expect(sellerRuntime.flushOutboundRequests(sellerOperation)).resolves.toEqual({
      status: "acknowledged",
    });
    await expect(buyerRuntime.operation(buyerOperation)).resolves.toMatchObject({
      status: "final",
      outcome: "success",
      reference: logicalAddress,
    });
    expect(anchorWriteOnce).toHaveBeenCalledOnce();
    await expect(sellerRuntime.anchorEvidence(sellerOperation, input)).resolves.toMatchObject({
      disposition: "anchored",
      evidenceRef: { contentHash: evidenceHash },
      anchorReceipt: { writer: BUYER },
    });
    await expect(buyerRuntime.operation(buyerOperation)).resolves.toMatchObject({
      status: "final",
      outcome: "success",
    });
  });

  it("fences seller publication composition and maps invalid input to operator action", async () => {
    const sellerDatabase = await open("seller");
    const inspectPermit = vi.fn();
    const flushOutboundRequests = vi.fn(async () => ({ status: "pending" as const }));
    const paymentEvidence = {
      validatePayload: vi.fn(),
      anchorEvidence: vi.fn(),
      flushOutboundRequests,
      handleMessage: vi.fn(),
    } as unknown as DacsSellerPaymentEvidenceRuntimeV1;
    const context = {
      role: "seller",
      authority: SELLER,
      peerAuthority: BUYER,
      database: sellerDatabase,
      demos: {
        role: "seller",
        signComponent: vi.fn(),
      },
      commerceStores: {
        role: "seller",
        x402Settlement: {},
        sellerReceipts: { inspectPermit },
      },
    } as unknown as DacsLiveRoleOperationContextV1;
    const resolvePublication = vi.fn(async () => ({
      request: {},
      dependencies: {},
    })) as unknown as Parameters<
      typeof createDacsSellerSettlementPublicationTrackV1
    >[0]["resolvePublication"];
    const track = createDacsSellerSettlementPublicationTrackV1({
      context,
      paymentEvidence,
      resolvePublication,
      authorizePublished: () => true,
    });
    const validOperation = operation(order("seller"));
    const wrongTrack = {
      ...validOperation,
      fence: { ...validOperation.fence, track: "delivery" as const },
    };

    await expect(track(wrongTrack)).resolves.toEqual({
      status: "operator-action",
      reasonCode: "seller-settlement-track-binding-mismatch",
    });
    expect(resolvePublication).not.toHaveBeenCalled();
    await expect(track(validOperation)).resolves.toMatchObject({
      status: "operator-action",
      reasonCode: expect.stringContaining("seller-settlement"),
    });
    expect(flushOutboundRequests).toHaveBeenCalledOnce();
    expect(inspectPermit).not.toHaveBeenCalled();
  });
});

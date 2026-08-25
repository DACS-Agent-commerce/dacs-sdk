import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AnchorReceipt,
  AttestationRef,
  SettlementEvidence,
} from "@kynesyslabs/dacs/artifacts";
import {
  x402Eip3009Nonce,
  x402PaywallSettlementKey,
} from "@kynesyslabs/dacs";
import { canonicalize, contentHash, sha256Hex } from "@kynesyslabs/dacs/canonical";
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
import { createDacsFixedPriceX402SellerPaymentEvidenceV1 } from
  "../src/fixedPriceX402SellerPaymentEvidence.js";
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
    } as never,
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
    const requestIdempotencyKeys: string[] = [];
    const completionIdempotencyKeys: string[] = [];
    const verifyEvidence = vi.fn()
      .mockReturnValueOnce({
        disposition: "indeterminate" as const,
        reason: "fixture verifier unavailable",
      })
      .mockReturnValue({ disposition: "valid" as const });
    const anchorWriteOnce = vi.fn(async (
      logicalAddress: string,
      value: object,
      _options?: Readonly<{ metadata?: Readonly<Record<string, string>> }>,
    ) => {
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
      sendMessage: async (message: {
        type: string;
        payload: unknown;
        idempotencyKey: string;
      }) => {
        completionIdempotencyKeys.push(message.idempotencyKey);
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
      sendMessage: async (message: {
        type: string;
        payload: unknown;
        idempotencyKey: string;
      }) => {
        requestIdempotencyKeys.push(message.idempotencyKey);
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
      verifyEvidence,
      retryDelayMs: 1,
    });
    const verifyAnchorReceipt = vi.fn()
      .mockReturnValueOnce({
        disposition: "indeterminate" as const,
        reason: "fixture receipt verifier unavailable",
      })
      .mockReturnValue({ disposition: "valid" as const });
    sellerRuntime = createDacsSellerPaymentEvidenceRuntimeV1({
      context: sellerContext,
      workerId: "seller-worker",
      retryDelayMs: 1,
      verifyAnchorReceipt,
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
      status: "pending",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(sellerRuntime.flushOutboundRequests(sellerOperation)).resolves.toEqual({
      status: "acknowledged",
    });
    expect(requestIdempotencyKeys).toHaveLength(2);
    expect(new Set(requestIdempotencyKeys).size).toBe(1);
    expect(requestIdempotencyKeys[0]).toMatch(/^payment-evidence-request:/);
    await expect(buyerRuntime.operation(buyerOperation)).resolves.toMatchObject({
      status: "pending-retry",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(buyerRuntime.operation(buyerOperation)).resolves.toMatchObject({
      status: "final",
      outcome: "success",
      reference: logicalAddress,
    });
    expect(completionIdempotencyKeys).toHaveLength(2);
    expect(new Set(completionIdempotencyKeys).size).toBe(1);
    expect(completionIdempotencyKeys[0]).toMatch(/^payment-evidence-completion:/);
    expect(anchorWriteOnce).toHaveBeenCalledOnce();
    expect(anchorWriteOnce.mock.calls[0]?.[2]).toEqual({ metadata: {
      logicalAddress,
      contentHash: evidenceHash,
      envelopeHash: sha256Hex(canonicalize(artifact)),
    } });
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
    const transientResolution = Object.assign(new Error("fixture transient"), {
      reasonCode: "seller-authority-unavailable",
    });
    const invalidResolution = Object.assign(new Error("fixture invalid"), {
      reasonCode: "seller-authorization-binding-corrupt",
    });
    const resolvePublication = vi.fn()
      .mockRejectedValueOnce(transientResolution)
      .mockRejectedValueOnce(invalidResolution)
      .mockResolvedValue({ request: {}, dependencies: {} }) as unknown as Parameters<
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
      status: "pending-retry",
      reasonCode: "seller-settlement-publication-pending-seller-authority-unavailable",
    });
    await expect(track(validOperation)).resolves.toEqual({
      status: "operator-action",
      reasonCode:
        "seller-settlement-publication-seller-authorization-binding-corrupt",
    });
    await expect(track(validOperation)).resolves.toMatchObject({
      status: "operator-action",
      reasonCode: expect.stringContaining("seller-settlement"),
    });
    expect(flushOutboundRequests).toHaveBeenCalledOnce();
    expect(inspectPermit).not.toHaveBeenCalled();
  });

  it("blocks payment evidence when the unselected rail store is corrupt", async () => {
    const retainedOrder = operation(order("seller")).order;
    const database = {
      createPaymentEvidenceHandshakeStore: () => ({}),
      createLiveCoordinatorStore: () => ({
        load: async () => ({ status: "corrupt" as const, reason: "shadow-corrupt" }),
      }),
      createPayDemCoordinatorStore: () => ({
        load: async () => ({ status: "ok" as const, record: retainedOrder }),
      }),
    };
    const context = {
      role: "seller",
      authority: SELLER,
      peerAuthority: BUYER,
      database,
    } as unknown as DacsLiveRoleOperationContextV1;
    const runtime = createDacsSellerPaymentEvidenceRuntimeV1({
      context,
      workerId: "seller-shadow-store-test",
      verifyAnchorReceipt: vi.fn(),
    });

    await expect(runtime.anchorEvidence(
      operation(order("seller")),
      {} as never,
    )).rejects.toMatchObject({
      reasonCode: "payment-evidence-order-state-invalid",
    });
  });

  it("retains seller-authored evidence before the buyer publication handoff", async () => {
    const database = await open("seller");
    const context = {
      role: "seller",
      authority: SELLER,
      peerAuthority: BUYER,
      database,
      demos: { adapter: {} },
    } as unknown as DacsLiveRoleOperationContextV1;
    const composed = createDacsFixedPriceX402SellerPaymentEvidenceV1({
      context,
      settlement: {
        observer: {},
        resolveOrderScope: vi.fn(),
      } as never,
    });
    const artifact = evidence();
    const evidenceHash = contentHash(artifact as unknown as Record<string, unknown>);
    const input = {
      effectId: `seller-settlement:${JOB_ID}`,
      logicalAddress: `dacs4:payment:${JOB_ID}:x402%3Aruntime:0`,
      evidenceHash,
      evidence: artifact,
      expectedWriter: { role: "buyer" as const, primaryClaim: BUYER },
    };
    await expect(composed.settlement.retainSignedEvidence!(input)).resolves.toBeUndefined();
    await expect(composed.settlement.retainSignedEvidence!(input)).resolves.toBeUndefined();
    await expect(composed.settlement.retainSignedEvidence!({
      ...input,
      evidence: {
        ...artifact,
        signature: { ...artifact.signature, value: "b3RoZXI" },
      },
    })).rejects.toMatchObject({
      reasonCode: "seller-payment-evidence-retention-conflict",
    });
  });

  it("refuses evidence retention when a shadow rail store is unsupported", async () => {
    const retainedOrder = operation(order("seller")).order;
    const context = {
      role: "seller",
      authority: SELLER,
      peerAuthority: BUYER,
      database: {
        createLiveCoordinatorStore: () => ({
          load: async () => ({ status: "unsupported" as const, version: 99 }),
        }),
        createPayDemCoordinatorStore: () => ({
          load: async () => ({ status: "ok" as const, record: retainedOrder }),
        }),
      },
      demos: { adapter: {} },
    } as unknown as DacsLiveRoleOperationContextV1;
    const composed = createDacsFixedPriceX402SellerPaymentEvidenceV1({
      context,
      settlement: { observer: {}, resolveOrderScope: vi.fn() } as never,
    });
    const artifact = evidence();

    await expect(composed.settlement.retainSignedEvidence!({
      effectId: `seller-settlement:${JOB_ID}`,
      logicalAddress: `dacs4:payment:${JOB_ID}:x402%3Aruntime:0`,
      evidenceHash: contentHash(artifact as unknown as Record<string, unknown>),
      evidence: artifact,
      expectedWriter: { role: "buyer", primaryClaim: BUYER },
    })).rejects.toMatchObject({
      reasonCode: "seller-payment-evidence-order-state-invalid",
    });
  });

  it("accepts a later authenticated observation of the exact finalized event", async () => {
    const database = await open("seller");
    const buyerPayingAddress = `0x${"3".repeat(40)}`;
    const buyerPayingKey = `cci-xm:evm:8453:${buyerPayingAddress}`;
    const sellerPayee = `0x${"4".repeat(40)}`;
    const asset = `0x${"5".repeat(40)}`;
    const txHash = `0x${"6".repeat(64)}`;
    const evidenceHash = "7".repeat(64);
    const paymentAuthorization = {
      jobId: JOB_ID,
      phaseIndex: 0,
      agreementHash: "8".repeat(64),
      listingRef: {
        listingId: "listing-runtime",
        version: 1,
        contentHash: "9".repeat(64),
      },
      railId: PROTOCOL.rail.railId,
      railRegistryVersion: 2,
      commitment: {
        ref: `dacs3:commitment:${JOB_ID}`,
        contentHash: "a".repeat(64),
        finalizedAt: 6_000,
        signer: SELLER,
      },
      settlementIdentity: {
        kind: "evm",
        chainId: 8453,
        txHash,
        logIndex: 1,
        includedAt: 6_500,
      },
      settlementId: `evm:8453:${txHash}:1`,
      evidenceHash,
      evidenceInput: {
        evidenceVersion: "1",
        jobId: JOB_ID,
        phase: "pay-x402",
        outcome: "success",
        paymentTxRefs: [{
          kind: "x402-event",
          httpResource: "https://seller.example/orders/runtime",
          paymentReceiptHash: "b".repeat(64),
          settlementTxHash: txHash,
          chainId: 8453,
          logIndex: 1,
          protocolVersion: "2",
        }],
        paymentAmount: { amount: "1000000", currency: "USDC" },
        settlementFinality: {
          model: "block-depth",
          finalityBlocks: 3,
          finalityObservedAt: 7_000,
        },
        observedAt: 7_000,
      },
      payoutBindingTier: 3,
      sessionBinding: "established",
    } as const;
    const authorization = {
      authorizationVersion: "1",
      sessionAuthorization: {
        scopeVersion: "1",
        jobId: JOB_ID,
        paymentPhaseIndex: 0,
        deliveryPhaseIndex: 1,
        payer: buyerPayingAddress,
        payerPayingKey: buyerPayingKey,
        httpResource: "https://seller.example/orders/runtime",
        railId: PROTOCOL.rail.railId,
        railRegistryVersion: 2,
        agreementRef: `dacs3:agreement:${JOB_ID}`,
        agreementHash: paymentAuthorization.agreementHash,
        listingRef: paymentAuthorization.listingRef,
        commitmentRef: paymentAuthorization.commitment.ref,
        commitmentContentHash: paymentAuthorization.commitment.contentHash,
        commitmentFinalizedAt: paymentAuthorization.commitment.finalizedAt,
        expected: {
          network: "eip155:8453",
          payTo: sellerPayee,
          amount: "1000000",
          asset,
          eip712: { name: "USDC", version: "2" },
        },
      },
      paymentPermitId: "permit-runtime",
      paymentAuthorization,
    } as const;
    const localBindingHash = fixedPriceX402OrderLocalBindingHash(order("seller"));
    const authorizationId = sha256Hex(
      `dacs-live-seller-x402-authorization:v1:${canonicalize({
        jobId: JOB_ID,
        paymentPhaseIndex: 0,
      })}`,
    );
    const authorizationHash = sha256Hex(canonicalize(authorization));
    expect(database.putEffectIntent({
      kind: "session",
      effectId: authorizationId,
      bindingHash: localBindingHash,
      input: {
        authorizationBindingVersion: "1",
        localBindingHash,
        authorizationHash,
        settlementKey: x402PaywallSettlementKey({ jobId: JOB_ID, phaseIndex: 0 }),
        authorization,
      },
      idempotencyKey: authorizationId,
      jobId: JOB_ID,
    }).status).toBe("created");
    let observedConfirmations = 5;
    let observedFinalityAt = 9_000;
    const observeX402Transfer = vi.fn(async () => ({
      status: "finalized" as const,
      chainId: 8453,
      txHash,
      logIndex: 1,
      payer: buyerPayingAddress,
      payee: sellerPayee,
      amountBaseUnits: "1000000",
      asset: { contract: asset, symbol: "USDC", decimals: 6 },
      confirmations: observedConfirmations,
      includedAt: 6_500,
      finalityObservedAt: observedFinalityAt,
      sessionBinding: {
        kind: "eip3009" as const,
        nonce: x402Eip3009Nonce(JOB_ID, 0),
      },
    }));
    const context = {
      role: "seller",
      authority: SELLER,
      peerAuthority: BUYER,
      database,
      demos: { adapter: {} },
    } as unknown as DacsLiveRoleOperationContextV1;
    const composed = createDacsFixedPriceX402SellerPaymentEvidenceV1({
      context,
      settlement: {
        observer: { observeX402Transfer },
        resolveOrderScope: () => ({ paymentPhaseIndex: 0, deliveryPhaseIndex: 1 }),
      } as never,
    });
    const resolved = await composed.settlement.resolvePublication({
      operation: operation(order("seller")),
      retained: {} as never,
    });
    const firstProof = await resolved.dependencies.resolveAuthenticatedNativeProof({
      authorization: paymentAuthorization as never,
    });
    expect(firstProof).toMatchObject({
      disposition: "authenticated",
      binding: {
        settlementFinality: {
          finalityObservedAt: 7_000,
          finalityBlocks: 3,
        },
      },
      proof: { artifact: { finalityObservedAt: 7_000, confirmations: 3 } },
    });
    observedConfirmations = 8;
    observedFinalityAt = 11_000;
    const replayProof = await resolved.dependencies.resolveAuthenticatedNativeProof({
      authorization: paymentAuthorization as never,
    });
    expect(replayProof).toEqual(firstProof);
  });
});

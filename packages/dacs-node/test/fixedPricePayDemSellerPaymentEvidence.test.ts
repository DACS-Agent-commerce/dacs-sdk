import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ payment: vi.fn() }));

vi.mock("../src/payDemSellerPayment.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/payDemSellerPayment.js")>()),
  loadDacsPayDemSellerPaymentAuthorizationForOrderV1: dependencies.payment,
}));

import {
  FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
  FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
  FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
} from "@kynesyslabs/dacs/commerce";

import { createDacsFixedPricePayDemSellerPaymentEvidenceV1 } from
  "../src/fixedPriceX402SellerPaymentEvidence.js";
import { createDacsFixedPricePayDemRoleOrderV1 } from "../src/liveOrder.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER_KEY = "11".repeat(32);
const SELLER_KEY = "22".repeat(32);
const BUYER = `did:demos:agent:${BUYER_KEY}`;
const SELLER = `did:demos:agent:${SELLER_KEY}`;
const TX_HASH = "33".repeat(32);

const inputOrder = createDacsFixedPricePayDemRoleOrderV1({
  role: "seller",
  jobId: JOB_ID,
  buyer: BUYER,
  seller: SELLER,
  protocol: {
    commerceProfile: FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
    standardRevision: FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
    phase: "pay-dem",
    orchestratorTopology: "seller-as-phase-orchestrator-v1",
    orchestrator: SELLER,
    rail: {
      registryIndexRef: FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
      registryIndexHash: "4".repeat(64),
      railDefinitionRef: "dacs4:rail:demos-native%3ADEM:1",
      railDefinitionHash: "5".repeat(64),
      railId: "demos-native:DEM",
      railVersion: 1,
      railType: "demos-native",
      phaseHandler: "pay-dem",
      network: "demos",
      availability: "live",
    },
  },
});

const operation = {
  order: {
    ...inputOrder,
    role: "seller",
    storeVersion: "1",
    revision: 1,
    bindingHash: "6".repeat(64),
    localBindingHash: "7".repeat(64),
    tracks: {},
    createdAt: 1,
    updatedAt: 1,
  },
  fence: {
    role: "seller",
    track: "payment-evidence",
    jobId: JOB_ID,
    bindingHash: "6".repeat(64),
    localBindingHash: "7".repeat(64),
    assertCurrent: vi.fn(),
  },
} as const;

const authorization = {
  jobId: JOB_ID,
  phaseIndex: 2,
  agreementHash: "8".repeat(64),
  listingRef: { listingId: "native", version: 1, contentHash: "9".repeat(64) },
  railId: "demos-native:DEM",
  railRegistryVersion: 1,
  commitment: {
    ref: `dacs3:commit:${JOB_ID}`,
    contentHash: "a".repeat(64),
    finalizedAt: 90,
    signer: SELLER,
  },
  settlementIdentity: {
    kind: "demos",
    txHash: TX_HASH,
    blockNumber: 123,
    includedAt: 100,
  },
  settlementId: `demos:${TX_HASH}`,
  evidenceHash: "b".repeat(64),
  evidenceInput: {
    evidenceVersion: "1",
    jobId: JOB_ID,
    phase: "pay-dem",
    outcome: "success",
    paymentTxRefs: [{ kind: "demos", txHash: TX_HASH, blockNumber: 123 }],
    paymentAmount: { amount: "1.25", currency: "DEM" },
    settlementFinality: { model: "bft-final", finalityObservedAt: 100 },
    observedAt: 100,
  },
  payoutBindingTier: 1,
} as const;

describe("native DEM seller payment evidence composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.payment.mockResolvedValue({
      result: { permitId: "opaque-native-permit" },
      authorization,
    });
  });

  it("re-observes and binds the exact finalized Demos transfer", async () => {
    const observeDemosTransfer = vi.fn(async () => ({
      status: "included" as const,
      txHash: TX_HASH,
      payer: BUYER_KEY,
      payee: SELLER_KEY,
      amountOs: "1250000000",
      blockNumber: 123,
      includedAt: 100,
    }));
    const composed = createDacsFixedPricePayDemSellerPaymentEvidenceV1({
      context: {
        role: "seller",
        authority: SELLER,
        peerAuthority: BUYER,
        demos: { adapter: {} },
      } as never,
      observeDemosTransfer,
    });
    const resolved = await composed.settlement.resolvePublication({
      operation: operation as never,
      retained: {} as never,
    });
    const proof = await resolved.dependencies.resolveAuthenticatedNativeProof({
      authorization: authorization as never,
    });
    expect(proof).toMatchObject({
      disposition: "authenticated",
      binding: {
        phase: "pay-dem",
        network: "demos",
        event: { txHash: TX_HASH, blockNumber: 123 },
        settlementFinality: { model: "bft-final", finalityObservedAt: 100 },
      },
      proof: {
        kind: "authenticated-demos-transfer",
        locator: TX_HASH,
        artifact: {
          payer: BUYER_KEY,
          payee: SELLER_KEY,
          amountOs: "1250000000",
        },
      },
    });
    expect(resolved.request).toMatchObject({
      paymentPermitId: "opaque-native-permit",
      authorization: { evidenceHash: "b".repeat(64) },
    });
    expect(observeDemosTransfer).toHaveBeenCalledWith(TX_HASH);
  });

  it("fails closed when the re-observed payer differs", async () => {
    const composed = createDacsFixedPricePayDemSellerPaymentEvidenceV1({
      context: {
        role: "seller", authority: SELLER, peerAuthority: BUYER,
        demos: { adapter: {} },
      } as never,
      observeDemosTransfer: async () => ({
        status: "included",
        txHash: TX_HASH,
        payer: "ff".repeat(32),
        payee: SELLER_KEY,
        amountOs: "1250000000",
        blockNumber: 123,
        includedAt: 100,
      }),
    });
    const resolved = await composed.settlement.resolvePublication({
      operation: operation as never,
      retained: {} as never,
    });
    await expect(resolved.dependencies.resolveAuthenticatedNativeProof({
      authorization: authorization as never,
    })).resolves.toEqual({
      disposition: "indeterminate",
      reason: "authenticated pay-dem native proof unavailable",
    });
  });
});

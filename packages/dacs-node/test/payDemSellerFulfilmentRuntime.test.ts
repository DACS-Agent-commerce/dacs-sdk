import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  payment: vi.fn(),
  deliveryReady: vi.fn(),
  finalise: vi.fn(),
  status: vi.fn(),
}));

vi.mock("@kynesyslabs/dacs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kynesyslabs/dacs")>()),
  runDurableFulfilmentToDeliveryReady: dependencies.deliveryReady,
  resumeDeliveryFinalisation: dependencies.finalise,
  getDeliveryFinalisationStatus: dependencies.status,
}));

vi.mock("../src/payDemSellerPayment.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/payDemSellerPayment.js")>()),
  loadDacsPayDemSellerPaymentAuthorizationForOrderV1: dependencies.payment,
}));

import {
  FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
  FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
  FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
} from "@kynesyslabs/dacs/commerce";

import { createDacsFixedPricePayDemRoleOrderV1 } from "../src/liveOrder.js";
import { createDacsPayDemSellerFulfilmentRuntimeV1 } from
  "../src/payDemSellerFulfilmentRuntime.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = `did:demos:agent:${"11".repeat(32)}`;
const SELLER = `did:demos:agent:${"22".repeat(32)}`;

const ORDER = {
  ...createDacsFixedPricePayDemRoleOrderV1({
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
        registryIndexHash: "1".repeat(64),
        railDefinitionRef: "dacs4:rail:demos-native%3ADEM:1",
        railDefinitionHash: "2".repeat(64),
        railId: "demos-native:DEM",
        railVersion: 1,
        railType: "demos-native",
        phaseHandler: "pay-dem",
        network: "demos",
        availability: "live",
      },
    },
  }),
  role: "seller",
  storeVersion: "1",
  revision: 4,
  bindingHash: "3".repeat(64),
  localBindingHash: "4".repeat(64),
  tracks: {},
  createdAt: 1,
  updatedAt: 1,
} as const;

function paymentAuthority() {
  return {
    result: {
      paymentResultVersion: "1",
      jobId: JOB_ID,
      phaseIndex: 2,
      railId: "demos-native:DEM",
      agreementHash: "5".repeat(64),
      settlementId: "settlement-1",
      txHash: "6".repeat(64),
      blockNumber: 10,
      observedAt: 100,
      evidenceHash: "7".repeat(64),
      permitId: "opaque-permit",
      noticeHash: "8".repeat(64),
    },
    authorization: {
      jobId: JOB_ID,
      phaseIndex: 2,
      agreementHash: "5".repeat(64),
      listingRef: { listingId: "listing", version: 1, contentHash: "9".repeat(64) },
      railId: "demos-native:DEM",
      railRegistryVersion: 1,
      commitment: {
        ref: `dacs3:commit:${JOB_ID}`,
        contentHash: "a".repeat(64),
        finalizedAt: 50,
        signer: SELLER,
      },
      settlementIdentity: {
        kind: "demos",
        txHash: "6".repeat(64),
        blockNumber: 10,
        includedAt: 100,
      },
      settlementId: "settlement-1",
      evidenceHash: "7".repeat(64),
      evidenceInput: {
        jobId: JOB_ID,
        phaseIndex: 2,
        phase: "pay-dem",
        orchestrator: SELLER,
        paymentTxRefs: [{ kind: "demos", txHash: "6".repeat(64), blockNumber: 10 }],
        paymentAmount: { amount: "1", currency: "DEM" },
        finalityModel: "bft-final",
        observedAt: 100,
      },
      payoutBindingTier: 1,
    },
  };
}

describe("native DEM seller fulfilment runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.payment.mockResolvedValue(paymentAuthority());
    dependencies.deliveryReady.mockResolvedValue({
      status: "delivery-ready",
      result: {
        jobId: JOB_ID,
        deliveryPhaseIndex: 3,
        fulfilmentId: "fulfilment-1",
        logicalAddress: `dacs4:deliverable:${JOB_ID}`,
        evidenceHash: "b".repeat(64),
      },
    });
  });

  it("passes only the store-backed native permit into durable fulfilment and replays locally", async () => {
    const effects = new Map<string, unknown>();
    const context = {
      role: "seller",
      authority: SELLER,
      peerAuthority: BUYER,
      database: {
        readTime: () => 1_000,
        loadEffectInput: (_kind: string, id: string) => effects.get(id),
        putEffectIntent: (input: { effectId: string; input: unknown }) => {
          if (effects.has(input.effectId) &&
              JSON.stringify(effects.get(input.effectId)) !== JSON.stringify(input.input)) {
            return { status: "conflict" as const };
          }
          effects.set(input.effectId, structuredClone(input.input));
          return { status: "created" as const };
        },
      },
      commerceStores: {
        role: "seller",
        sellerReceipts: {
          claim: vi.fn(), consumePermit: vi.fn(), inspectPermit: vi.fn(),
        },
      },
      sessionStore: {},
    };
    const runtime = createDacsPayDemSellerFulfilmentRuntimeV1({
      context: context as never,
      workerId: "native-delivery-worker",
      fulfilment: {
        fulfilmentDeps: {},
        fulfilmentDurability: { leaseTtlMs: 30_000 },
      } as never,
    });
    const fence = {
      role: "seller",
      track: "delivery",
      jobId: JOB_ID,
      bindingHash: ORDER.bindingHash,
      localBindingHash: ORDER.localBindingHash,
      assertCurrent: vi.fn(),
    };
    const first = await runtime.delivery({ order: ORDER, fence } as never);
    const second = await runtime.delivery({ order: ORDER, fence } as never);

    expect(first).toMatchObject({
      status: "final",
      reference: `dacs4:deliverable:${JOB_ID}`,
    });
    expect(second).toEqual(first);
    expect(dependencies.deliveryReady).toHaveBeenCalledTimes(1);
    expect(dependencies.deliveryReady).toHaveBeenCalledWith(
      expect.objectContaining({
        agreementRef: `dacs3:agreement:${JOB_ID}`,
        agreementHash: "5".repeat(64),
        commitmentRef: `dacs3:commit:${JOB_ID}`,
        deliveryPhaseIndex: 3,
        paymentPermitId: "opaque-permit",
      }),
      expect.objectContaining({ receiptStore: expect.any(Object) }),
      expect.objectContaining({ workerId: "native-delivery-worker" }),
    );
  });

  it("rejects a track or order substitution before resolving payment authority", async () => {
    const runtime = createDacsPayDemSellerFulfilmentRuntimeV1({
      context: {
        role: "seller",
        commerceStores: {
          role: "seller",
          sellerReceipts: {
            claim: vi.fn(), consumePermit: vi.fn(), inspectPermit: vi.fn(),
          },
        },
        database: { readTime: () => 1_000 },
        sessionStore: {},
      } as never,
      workerId: "native-delivery-worker",
      fulfilment: {
        fulfilmentDeps: {},
        fulfilmentDurability: { leaseTtlMs: 30_000 },
      } as never,
    });
    const result = await runtime.delivery({
      order: ORDER,
      fence: {
        role: "seller",
        track: "payment",
        jobId: JOB_ID,
        bindingHash: ORDER.bindingHash,
        localBindingHash: ORDER.localBindingHash,
      },
    } as never);
    expect(result).toEqual({
      status: "operator-action",
      reasonCode: "pay-dem-seller-delivery-track-binding-mismatch",
    });
    expect(dependencies.payment).not.toHaveBeenCalled();
  });
});

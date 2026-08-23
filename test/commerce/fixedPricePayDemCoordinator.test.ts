import { describe, expect, it } from "vitest";

import {
  FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
  FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
  FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
  captureFixedPricePayDemProtocolBinding,
  combineFixedPricePayDemOrderStatus,
  createFixedPricePayDemBuyerCoordinator,
  createFixedPricePayDemSellerCoordinator,
  createInMemoryFixedPricePayDemCoordinatorStore,
  fixedPricePayDemOrderBindingHash,
  fixedPricePayDemOrderLocalBindingHash,
  fixedPricePayDemProtocolBindingHash,
  type FixedPricePayDemOrderInput,
  type FixedPricePayDemProtocolBinding,
  type FixedPricePayDemTrackOperation,
  type FixedPriceX402CoordinatorRole,
} from "../../src/commerce/index.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = "did:example:buyer";
const SELLER = "did:example:seller";

const PROTOCOL: FixedPricePayDemProtocolBinding = {
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
};

function order(role: FixedPriceX402CoordinatorRole): FixedPricePayDemOrderInput {
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

const success = (track: string): FixedPricePayDemTrackOperation =>
  async ({ fence }) => {
    await fence.assertCurrent();
    return {
      status: "final",
      outcome: "success",
      reference: `${track}:${fence.jobId}`,
    };
  };

describe("fixed-price pay-dem coordinator", () => {
  it("captures only the native DEM registry and handler binding", () => {
    expect(captureFixedPricePayDemProtocolBinding(PROTOCOL)).toEqual(PROTOCOL);
    expect(fixedPricePayDemProtocolBindingHash(PROTOCOL)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => captureFixedPricePayDemProtocolBinding({
      ...PROTOCOL,
      phase: "pay-x402",
    })).toThrow(/unsupported/);
    expect(() => captureFixedPricePayDemProtocolBinding({
      ...PROTOCOL,
      rail: { ...PROTOCOL.rail, network: "demos:testnet" },
    })).toThrow(/unsupported/);
  });

  it("runs the existing durable two-role DAG under a distinct native binding", async () => {
    const store = createInMemoryFixedPricePayDemCoordinatorStore({ now: () => 1_000 });
    const buyer = createFixedPricePayDemBuyerCoordinator({
      store,
      workerId: "buyer-dem-worker",
      operations: {
        agreement: success("buyer-agreement"),
        payment: success("buyer-payment"),
        "payment-evidence": success("buyer-payment-evidence"),
        "buyer-received": success("buyer-received"),
        audit: success("buyer-audit"),
      },
    });
    const seller = createFixedPricePayDemSellerCoordinator({
      store,
      workerId: "seller-dem-worker",
      operations: {
        agreement: success("seller-agreement"),
        payment: success("seller-payment"),
        "payment-evidence": success("seller-payment-evidence"),
        delivery: success("seller-delivery"),
        "delivery-evidence": success("seller-delivery-evidence"),
        audit: success("seller-audit"),
      },
    });
    const buyerOrder = order("buyer");
    const sellerOrder = order("seller");
    await buyer.startOrder(buyerOrder);
    await seller.startOrder(sellerOrder);
    await buyer.runPending({ limit: 10 });
    await seller.runPending({ limit: 10 });
    const combined = combineFixedPricePayDemOrderStatus({
      buyer: (await buyer.getOrderStatus(JOB_ID))!,
      seller: (await seller.getOrderStatus(JOB_ID))!,
    });
    expect(combined.milestone).toBe("actor-audit-final");
    expect(combined.bindingHash).toBe(fixedPricePayDemOrderBindingHash(buyerOrder));
    expect(fixedPricePayDemOrderLocalBindingHash(buyerOrder))
      .not.toBe(fixedPricePayDemOrderLocalBindingHash(sellerOrder));
  });
});


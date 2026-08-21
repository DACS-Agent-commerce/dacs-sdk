import {
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  fixedPriceX402OrderBindingHash,
  fixedPriceX402OrderLocalBindingHash,
} from "@kynesyslabs/dacs/commerce";
import { describe, expect, it } from "vitest";

import {
  createDacsFixedPriceX402OrderPairV1,
  createDacsFixedPriceX402RoleOrderV1,
} from "../src/liveOrder.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = `did:demos:agent:${"11".repeat(32)}`;
const SELLER = `did:demos:agent:${"22".repeat(32)}`;

function protocol() {
  return {
    commerceProfile: FIXED_PRICE_X402_COMMERCE_PROFILE,
    standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
    phase: "pay-x402" as const,
    orchestratorTopology: "seller-as-phase-orchestrator-v1" as const,
    orchestrator: SELLER,
    rail: {
      registryIndexRef: FIXED_PRICE_X402_REGISTRY_INDEX_REF,
      registryIndexHash: "1".repeat(64),
      railDefinitionRef: "dacs4:rail:x402%3Atest:2",
      railDefinitionHash: "2".repeat(64),
      railId: "x402:test",
      railVersion: 2,
      railType: "x402" as const,
      phaseHandler: "pay-x402" as const,
      network: "eip155:84532",
      availability: "live" as const,
    },
  };
}

describe("fixed-price x402 live order construction", () => {
  it("builds one shared commercial identity with distinct role-local SDK bindings", () => {
    const mutable = protocol();
    const pair = createDacsFixedPriceX402OrderPairV1({
      jobId: JOB_ID,
      buyer: BUYER,
      seller: SELLER,
      protocol: mutable,
    });

    expect(pair.buyer.sdkJobs).toEqual({
      role: "buyer",
      agreement: `dacs-live:buyer:agreement:${JOB_ID}`,
      payment: `dacs-live:buyer:payment:${JOB_ID}`,
      paymentEvidence: `dacs-live:buyer:payment-evidence:${JOB_ID}`,
      buyerReceived: `dacs-live:buyer:buyer-received:${JOB_ID}`,
      audit: `dacs-live:buyer:audit:${JOB_ID}`,
    });
    expect(pair.seller.sdkJobs).toEqual({
      role: "seller",
      agreement: `dacs-live:seller:agreement:${JOB_ID}`,
      payment: `dacs-live:seller:payment:${JOB_ID}`,
      paymentEvidence: `dacs-live:seller:payment-evidence:${JOB_ID}`,
      fulfilment: `dacs-live:seller:fulfilment:${JOB_ID}`,
      deliveryEvidence: `dacs-live:seller:delivery-evidence:${JOB_ID}`,
      audit: `dacs-live:seller:audit:${JOB_ID}`,
    });
    expect(pair.bindingHash).toBe(fixedPriceX402OrderBindingHash(pair.buyer));
    expect(pair.bindingHash).toBe(fixedPriceX402OrderBindingHash(pair.seller));
    expect(pair.buyerLocalBindingHash).toBe(fixedPriceX402OrderLocalBindingHash(pair.buyer));
    expect(pair.sellerLocalBindingHash).toBe(fixedPriceX402OrderLocalBindingHash(pair.seller));
    expect(pair.buyerLocalBindingHash).not.toBe(pair.sellerLocalBindingHash);
    expect(Object.isFrozen(pair)).toBe(true);
    expect(Object.isFrozen(pair.buyer.protocol.rail)).toBe(true);

    mutable.rail.railId = "x402:changed";
    expect(pair.buyer.protocol.rail.railId).toBe("x402:test");
  });

  it("rejects role, authority and topology substitutions through core validation", () => {
    expect(() => createDacsFixedPriceX402RoleOrderV1({
      role: "buyer",
      jobId: JOB_ID,
      buyer: BUYER,
      seller: SELLER,
      protocol: { ...protocol(), orchestrator: BUYER },
    })).toThrow("fixed-price x402 role order is invalid");
    expect(() => createDacsFixedPriceX402RoleOrderV1({
      role: "buyer",
      jobId: "not-a-canonical-job",
      buyer: BUYER,
      seller: SELLER,
      protocol: protocol(),
    })).toThrow("fixed-price x402 role order is invalid");
  });
});

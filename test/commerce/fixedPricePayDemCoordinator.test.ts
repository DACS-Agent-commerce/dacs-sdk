import { describe, expect, it, vi } from "vitest";
import { signComponentArtifact } from "../../src/artifacts/signatures.js";
import { contentHash } from "../../src/canonical/index.js";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "../../src/crypto/index.js";
import { SubstrateError, faultCategory } from "../../src/errors.js";
import { payDemSettleCore } from "../../src/rails/payDem.js";
import { evaluateRailAvailabilitySelection } from "../../src/registry/railAvailability.js";
import { dacs5BundleOutcomeForTerminalState } from "../../src/agent/sessionSemantics.js";

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
  it("RAV-R4 preserves a pinned rail outage as substrate through the blameless terminal result", async () => {
    const seed = Uint8Array.from(Buffer.alloc(32, 42));
    const key = rawPublicKey(publicKeyFromSeed(seed));
    const steward = `did:demos:agent:${Buffer.from(key).toString("hex")}`;
    const definition = await signComponentArtifact({
      railVersion: 1,
      railId: "demos-native:DEM",
      railType: "demos-native",
      asset: { kind: "native-dem", symbol: "DEM", decimals: 9 },
      network: { kind: "demos" },
      phaseHandler: "pay-dem",
      parameters: {},
      availability: "live",
      governance: { proposedBy: steward, acceptedAt: 1, anchoring: "single-signer" },
    }, "dacs-rail:v1:", {
      algorithm: "ed25519",
      signer: steward,
      sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(seed)),
    });
    const digest = contentHash(definition as unknown as Record<string, unknown>);
    expect(evaluateRailAvailabilitySelection(definition, {
      stewardClaim: steward,
      stewardPublicKey: Buffer.from(key).toString("base64url"),
      pinnedRailDigest: digest,
      sessionState: "new",
      operatorPreflightOk: true,
      operatorContext: { source: "local-operator-policy", production: true },
    })).toMatchObject({ decision: "pass", railDigest: digest });

    // The rail goes down after selection. The pinned definition stays live;
    // this is a known rail outage before submission, not an uncertain broadcast.
    const transfer = vi.fn(async () => { throw new SubstrateError("native rail is offline before submission"); });
    const delivery = vi.fn();
    const seller: ReturnType<typeof createFixedPricePayDemSellerCoordinator> =
      createFixedPricePayDemSellerCoordinator({
      executionMode: "simulation",
        store: createInMemoryFixedPricePayDemCoordinatorStore({ now: () => 1_000 }),
        workerId: "rail-outage-test",
        operations: {
          agreement: success("agreement"),
          payment: async () => {
            try {
              await payDemSettleCore({ recipient: "d4".repeat(32), amount: "1", network: "demos" },
                { address: "c3".repeat(32), transfer }, undefined, undefined, { executionMode: "simulation" });
            } catch (error) {
              return { status: "final", outcome: "failure", errorClass: faultCategory(error),
                faultedParty: "none", reference: "payment:rail-down-before-submit" };
            }
            throw new Error("the offline rail must fail settlement");
          },
          "payment-evidence": success("failure-evidence"),
          delivery,
          audit: async () => {
            const payment = (await seller.getOrderStatus(JOB_ID))!.tracks.payment!;
            expect(payment.errorClass).toBe("substrate");
            expect(payment.faultedParty).toBe("none");
            expect(dacs5BundleOutcomeForTerminalState("failed-substrate", payment.errorClass))
              .toBe("failed-substrate");
            return { status: "final", outcome: "failure", errorClass: payment.errorClass!,
              faultedParty: payment.faultedParty!, reference: "bundle:failed-substrate" };
          },
        },
      });
    const input = order("seller");
    input.protocol = { ...PROTOCOL, rail: { ...PROTOCOL.rail, railDefinitionHash: digest } };
    await seller.startOrder(input);
    expect((await seller.runPending({ limit: 10 })).items.map((item) => item.track))
      .toEqual(["agreement", "payment", "payment-evidence", "audit"]);
    expect(transfer).toHaveBeenCalledOnce();
    expect(delivery).not.toHaveBeenCalled();
    expect(definition.availability).toBe("live");
    expect((await seller.getOrderStatus(JOB_ID))).toMatchObject({
      milestone: "terminal-failure",
      tracks: { audit: { state: "final", outcome: "failure", errorClass: "substrate", faultedParty: "none" } },
    });
  });

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
      executionMode: "simulation",
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
      executionMode: "simulation",
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

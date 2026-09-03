import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  captureFixedPriceOfflineProtocolBinding,
  captureFixedPriceX402ProtocolBinding,
  combineFixedPriceOfflineOrderStatus,
  createFixedPriceOfflineBuyerCoordinator,
  createFixedPriceOfflineSellerCoordinator,
  createFixedPriceX402BuyerCoordinator,
  createInMemoryFixedPriceOfflineCoordinatorStore,
  createInMemoryFixedPriceX402CoordinatorStore,
  FIXED_PRICE_OFFLINE_COMMERCE_PROFILE,
  FIXED_PRICE_OFFLINE_STANDARD_REVISION,
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  fixedPriceOfflineOrderBindingHash,
  fixedPriceOfflineOrderViolation,
  fixedPriceX402OrderBindingHash,
  fixedPriceX402OrderViolation,
  type FixedPriceOfflineCoordinatorRole,
  type FixedPriceOfflineCoordinatorStore,
  type FixedPriceOfflineOrderInput,
  type FixedPriceOfflineProtocolBinding,
  type FixedPriceOfflineTrackOperation,
  type FixedPriceX402CoordinatorStore,
  type FixedPriceX402OrderInput,
  type FixedPriceX402ProtocolBinding,
  type FixedPriceX402TrackOperation,
} from "../../src/commerce/index.js";
import {
  createFixedPriceOfflineBuyerCoordinator as rootCreateFixedPriceOfflineBuyerCoordinator,
} from "../../src/index.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7F";
const BUYER = "did:example:offline-buyer";
const SELLER = "did:example:offline-seller";

const OFFLINE_PROTOCOL: FixedPriceOfflineProtocolBinding = {
  commerceProfile: FIXED_PRICE_OFFLINE_COMMERCE_PROFILE,
  standardRevision: FIXED_PRICE_OFFLINE_STANDARD_REVISION,
  mode: "offline",
  orchestratorTopology: "seller-as-phase-orchestrator-v1",
  orchestrator: SELLER,
  settlement: {
    adapter: "deterministic-offline",
    version: 1,
    disposition: "mocked",
  },
};

const LIVE_PROTOCOL: FixedPriceX402ProtocolBinding = {
  commerceProfile: FIXED_PRICE_X402_COMMERCE_PROFILE,
  standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
  phase: "pay-x402",
  orchestratorTopology: "seller-as-phase-orchestrator-v1",
  orchestrator: SELLER,
  rail: {
    registryIndexRef: FIXED_PRICE_X402_REGISTRY_INDEX_REF,
    registryIndexHash: "1".repeat(64),
    railDefinitionRef: "dacs4:rail:x402%3Aoffline-isolation:1",
    railDefinitionHash: "2".repeat(64),
    railId: "x402:offline-isolation",
    railVersion: 1,
    railType: "x402",
    phaseHandler: "pay-x402",
    network: "eip155:8453",
    availability: "live",
  },
};

function sdkJobs(role: FixedPriceOfflineCoordinatorRole) {
  return role === "buyer"
    ? {
        role,
        agreement: `buyer:agreement:${JOB_ID}`,
        payment: `buyer:payment:${JOB_ID}`,
        paymentEvidence: `buyer:payment-evidence:${JOB_ID}`,
        buyerReceived: `buyer:received:${JOB_ID}`,
        audit: `buyer:audit:${JOB_ID}`,
      } as const
    : {
        role,
        agreement: `seller:agreement:${JOB_ID}`,
        payment: `seller:payment:${JOB_ID}`,
        paymentEvidence: `seller:payment-evidence:${JOB_ID}`,
        fulfilment: `seller:fulfilment:${JOB_ID}`,
        deliveryEvidence: `seller:delivery-evidence:${JOB_ID}`,
        audit: `seller:audit:${JOB_ID}`,
      } as const;
}

function offlineOrder(role: FixedPriceOfflineCoordinatorRole): FixedPriceOfflineOrderInput {
  return {
    jobId: JOB_ID,
    buyer: BUYER,
    seller: SELLER,
    protocol: OFFLINE_PROTOCOL,
    sdkJobs: sdkJobs(role),
  };
}

function liveOrder(role: FixedPriceOfflineCoordinatorRole): FixedPriceX402OrderInput {
  return {
    jobId: JOB_ID,
    buyer: BUYER,
    seller: SELLER,
    protocol: LIVE_PROTOCOL,
    sdkJobs: sdkJobs(role),
  };
}

const offlineFinal = (label: string): FixedPriceOfflineTrackOperation =>
  async ({ fence }) => {
    await fence.assertCurrent();
    return {
      status: "final",
      outcome: "simulated-success",
      reference: `offline:${label}:${fence.jobId}`,
    };
  };

describe("fixed-price offline coordinator", () => {
  it("exports a profile that cannot be admitted by the live x402 verifier", () => {
    expect(rootCreateFixedPriceOfflineBuyerCoordinator)
      .toBe(createFixedPriceOfflineBuyerCoordinator);
    expect(captureFixedPriceOfflineProtocolBinding(OFFLINE_PROTOCOL))
      .toEqual(OFFLINE_PROTOCOL);
    expect(() => captureFixedPriceX402ProtocolBinding(OFFLINE_PROTOCOL))
      .toThrow(/x402 protocol/);
    expect(() => captureFixedPriceOfflineProtocolBinding(LIVE_PROTOCOL))
      .toThrow(/offline protocol/);
  });

  it("ships its offline isolation documentation in the npm package", async () => {
    const packageJson = await import("../../package.json", { with: { type: "json" } });
    expect(packageJson.default.files).toContain("docs/fixed-price-offline-coordinator.md");
    const documentation = readFileSync(
      new URL("../../docs/fixed-price-offline-coordinator.md", import.meta.url),
      "utf8",
    );
    expect(documentation).toContain(FIXED_PRICE_OFFLINE_COMMERCE_PROFILE);
    expect(documentation).toContain("not resumable or upgradeable as live sessions");
  });

  it("binds the live x402 profile to the adopted exact Standard revision", () => {
    expect(fixedPriceX402OrderBindingHash({
      jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
      buyer: "did:example:buyer",
      seller: "did:example:seller",
      protocol: {
        ...LIVE_PROTOCOL,
        orchestrator: "did:example:seller",
        rail: {
          ...LIVE_PROTOCOL.rail,
          railDefinitionRef: "dacs4:rail:x402%3Adefault:2",
          railId: "x402:default",
          railVersion: 2,
        },
      },
    // The binding hash covers FIXED_PRICE_X402_STANDARD_REVISION (= DACS_STANDARD_PIN,
    // src/commerce/fixedPriceX402Protocol.ts), so it moves with the oracle pin. Pinned
    // here so an accidental pin or protocol change fails loudly.
    //   965df755 -> 0c58b9d65f67e8c36e8379db8d80af074470e2834f40a148fce609461ecad17c
    //   662be1d  -> a81bbc35634f8ec64b62fc820835ce498f2a976316e323cd962481b10bc0a77a
    //   f2e9662  -> 57133d65062083c6a5bc7242c664835588a03a1492d6cf15431bdbc201ae0e90
    //   741057b  -> 915e7894a433d0553ba4467a9870720eef09226047bac103a084c076c3c0bbb0
    })).toBe("915e7894a433d0553ba4467a9870720eef09226047bac103a084c076c3c0bbb0");
  });

  it("runs the shared role-separated lifecycle and combines only verified actor state", async () => {
    const store = createInMemoryFixedPriceOfflineCoordinatorStore({ now: () => 1_000 });
    const buyer = createFixedPriceOfflineBuyerCoordinator({
      store,
      workerId: "offline-buyer-worker",
      operations: {
        agreement: offlineFinal("buyer-agreement"),
        payment: offlineFinal("buyer-payment"),
        "payment-evidence": offlineFinal("buyer-payment-evidence"),
        "buyer-received": offlineFinal("buyer-received"),
        audit: offlineFinal("buyer-audit"),
      },
    });
    const seller = createFixedPriceOfflineSellerCoordinator({
      store,
      workerId: "offline-seller-worker",
      operations: {
        agreement: offlineFinal("seller-agreement"),
        payment: offlineFinal("seller-payment"),
        "payment-evidence": offlineFinal("seller-payment-evidence"),
        delivery: offlineFinal("seller-delivery"),
        "delivery-evidence": offlineFinal("seller-delivery-evidence"),
        audit: offlineFinal("seller-audit"),
      },
    });

    await buyer.startOrder(offlineOrder("buyer"));
    await seller.startOrder(offlineOrder("seller"));
    await buyer.runPending({ limit: 10 });
    await seller.runPending({ limit: 10 });

    const buyerStatus = (await buyer.getOrderStatus(JOB_ID))!;
    const sellerStatus = (await seller.getOrderStatus(JOB_ID))!;
    const combined = combineFixedPriceOfflineOrderStatus({
      buyer: buyerStatus,
      seller: sellerStatus,
    });
    // Actor-local audit completion is not ST-11 bundle completion. The
    // authenticated completion gate is the only path to global audit completion.
    expect(combined.milestone).toBe("simulation-actor-audit-exercised");
    expect(combined).toMatchObject({
      simulationOnly: true,
      normativeConformance: false,
      commercialSuccess: false,
      authority: "none",
    });
    expect(combined.actors.buyer).toMatchObject({
      simulationOnly: true,
      normativeConformance: false,
      commercialSuccess: false,
      authority: "none",
    });
    expect(combined.actors.seller).toMatchObject({
      simulationOnly: true,
      normativeConformance: false,
      commercialSuccess: false,
      authority: "none",
    });
    expect(combined.protocol).toEqual(OFFLINE_PROTOCOL);
    expect(combined.bindingHash).toBe(
      fixedPriceOfflineOrderBindingHash(offlineOrder("buyer")),
    );
    expect(() => combineFixedPriceOfflineOrderStatus({
      buyer: {
        ...buyerStatus,
        commercialSuccess: true,
      } as unknown as typeof buyerStatus,
      seller: sellerStatus,
    })).toThrow(/authority markers/);
  });

  it("uses distinct binding and effect-identity domains for matching live and offline work", async () => {
    const offlineKeys: string[] = [];
    const liveKeys: string[] = [];
    const offlineOperation: FixedPriceOfflineTrackOperation = ({ fence }) => {
      offlineKeys.push(fence.idempotencyKey);
      return {
        status: "final",
        outcome: "simulated-success",
        reference: "offline:agreement",
      };
    };
    const liveOperation: FixedPriceX402TrackOperation = ({ fence }) => {
      liveKeys.push(fence.idempotencyKey);
      return { status: "final", outcome: "success", reference: "live:agreement" };
    };
    const offline = createFixedPriceOfflineBuyerCoordinator({
      store: createInMemoryFixedPriceOfflineCoordinatorStore({ now: () => 2_000 }),
      workerId: "offline-worker",
      operations: { agreement: offlineOperation },
    });
    const live = createFixedPriceX402BuyerCoordinator({
      store: createInMemoryFixedPriceX402CoordinatorStore({ now: () => 2_000 }),
      workerId: "live-worker",
      operations: { agreement: liveOperation },
    });

    await offline.startOrder(offlineOrder("buyer"));
    await live.startOrder(liveOrder("buyer"));
    await offline.runPending();
    await live.runPending();

    expect(fixedPriceOfflineOrderBindingHash(offlineOrder("buyer")))
      .not.toBe(fixedPriceX402OrderBindingHash(liveOrder("buyer")));
    expect(offlineKeys).toHaveLength(1);
    expect(liveKeys).toHaveLength(1);
    expect(offlineKeys[0]).not.toBe(liveKeys[0]);
  });

  it("fails closed on live outcome vocabulary and never projects live authority", async () => {
    const store = createInMemoryFixedPriceOfflineCoordinatorStore({ now: () => 2_500 });
    const unsafeLiveVocabulary = (() => ({
      status: "final",
      outcome: "success",
      reference: "offline:unsafe-live-vocabulary",
    })) as unknown as FixedPriceOfflineTrackOperation;
    const coordinator = createFixedPriceOfflineBuyerCoordinator({
      store,
      workerId: "offline-vocabulary-worker",
      operations: { agreement: unsafeLiveVocabulary },
    });

    const created = await coordinator.startOrder(offlineOrder("buyer"));
    expect(created.milestone).toBe("simulation-created");
    const work = await coordinator.runPending();
    expect(work.items).toEqual([
      expect.objectContaining({
        status: "indeterminate",
        reasonCode: "operation-threw",
        simulationOnly: true,
        normativeConformance: false,
        commercialSuccess: false,
        authority: "none",
      }),
    ]);

    const retained = await coordinator.getOrderStatus(JOB_ID);
    expect(retained?.milestone).toBe("simulation-created");
    expect(JSON.stringify({ work, retained })).not.toMatch(
      /commercial-performance-complete|audit-complete/,
    );
  });

  it("retains simulation-specific failure attribution through the audit track", async () => {
    const store = createInMemoryFixedPriceOfflineCoordinatorStore({ now: () => 2_750 });
    const coordinator = createFixedPriceOfflineBuyerCoordinator({
      store,
      workerId: "offline-failure-worker",
      operations: {
        agreement: () => ({
          status: "final",
          outcome: "simulated-failure",
          errorClass: "simulated-counterparty",
          reference: "offline:failed-agreement",
        }),
        audit: () => ({
          status: "final",
          outcome: "simulated-failure",
          errorClass: "simulated-counterparty",
          reference: "offline:failed-audit",
        }),
      },
    });

    await coordinator.startOrder(offlineOrder("buyer"));
    const work = await coordinator.runPending();
    expect(work.items).toEqual([
      expect.objectContaining({
        track: "agreement",
        outcome: "simulated-failure",
        commercialSuccess: false,
      }),
      expect.objectContaining({
        track: "audit",
        outcome: "simulated-failure",
        commercialSuccess: false,
      }),
    ]);
    expect(await coordinator.getOrderStatus(JOB_ID)).toMatchObject({
      milestone: "simulation-terminal-failure",
      tracks: {
        agreement: { errorClass: "simulated-counterparty" },
        audit: { errorClass: "simulated-counterparty" },
      },
    });
  });

  it("rejects records and stores when a caller tries to cross the profile boundary", async () => {
    const offlineStore = createInMemoryFixedPriceOfflineCoordinatorStore({ now: () => 3_000 });
    const offline = createFixedPriceOfflineBuyerCoordinator({
      store: offlineStore,
      workerId: "offline-worker",
      operations: {},
    });
    await offline.startOrder(offlineOrder("buyer"));
    const retained = await offlineStore.load("buyer", JOB_ID);
    expect(retained.status).toBe("ok");
    const record = retained.status === "ok" ? retained.record : null;
    expect(fixedPriceOfflineOrderViolation(record)).toBeNull();
    expect(fixedPriceX402OrderViolation(record)).toMatch(/x402 protocol/);

    const liveOverOffline = createFixedPriceX402BuyerCoordinator({
      store: offlineStore as unknown as FixedPriceX402CoordinatorStore,
      workerId: "unsafe-live-worker",
      operations: {},
    });
    await expect(liveOverOffline.startOrder(liveOrder("buyer")))
      .rejects.toThrow(/offline protocol/);

    const liveStore = createInMemoryFixedPriceX402CoordinatorStore({ now: () => 3_000 });
    const offlineOverLive = createFixedPriceOfflineBuyerCoordinator({
      store: liveStore as unknown as FixedPriceOfflineCoordinatorStore,
      workerId: "unsafe-offline-worker",
      operations: {},
    });
    await expect(offlineOverLive.startOrder(offlineOrder("buyer")))
      .rejects.toThrow(/x402 protocol/);
  });
});

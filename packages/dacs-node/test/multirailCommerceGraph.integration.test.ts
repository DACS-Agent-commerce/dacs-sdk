import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
  FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
  FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  fixedPricePayDemOrderBindingHash,
  fixedPricePayDemOrderLocalBindingHash,
  fixedPriceX402OrderBindingHash,
  fixedPriceX402OrderLocalBindingHash,
  type FixedPricePayDemOrderInput,
  type FixedPriceX402OrderInput,
} from "@kynesyslabs/dacs/commerce";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DACS_NODE_LIVE_PROFILE } from "../src/config.js";
import {
  createDacsFixedPricePayDemOrderPairV1,
  createDacsFixedPriceX402OrderPairV1,
} from "../src/liveOrder.js";
import { createDacsMultirailLiveCommerceGraphV1 } from
  "../src/multirailCommerceGraph.js";
import {
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";
import type { DacsHttpAuthenticatedEnvelopeV1 } from "../src/transport/envelope.js";

const BUYER = "did:example:multirail-buyer";
const SELLER = "did:example:multirail-seller";
const X402_JOB = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const PAY_DEM_JOB = "01J8ME0SXKQ4T9V2RC5HJ6WX7E";
const RACE_JOB = "01J8ME0SXKQ4T9V2RC5HJ6WX7F";
const roots: string[] = [];
const databases: DacsNodeSqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0).reverse()) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function x402Protocol() {
  return {
    commerceProfile: FIXED_PRICE_X402_COMMERCE_PROFILE,
    standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
    phase: "pay-x402" as const,
    orchestratorTopology: "seller-as-phase-orchestrator-v1" as const,
    orchestrator: SELLER,
    rail: {
      registryIndexRef: FIXED_PRICE_X402_REGISTRY_INDEX_REF,
      registryIndexHash: "1".repeat(64),
      railDefinitionRef: "dacs4:rail:x402%3Amultirail:1",
      railDefinitionHash: "2".repeat(64),
      railId: "x402:multirail",
      railVersion: 1,
      railType: "x402" as const,
      phaseHandler: "pay-x402" as const,
      network: "eip155:84532" as const,
      availability: "live" as const,
    },
  };
}

function payDemProtocol() {
  return {
    commerceProfile: FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
    standardRevision: FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
    phase: "pay-dem" as const,
    orchestratorTopology: "seller-as-phase-orchestrator-v1" as const,
    orchestrator: SELLER,
    rail: {
      registryIndexRef: FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
      registryIndexHash: "3".repeat(64),
      railDefinitionRef: "dacs4:rail:demos-native%3ADEM:1",
      railDefinitionHash: "4".repeat(64),
      railId: "demos-native:DEM",
      railVersion: 1,
      railType: "demos-native" as const,
      phaseHandler: "pay-dem" as const,
      network: "demos" as const,
      availability: "live" as const,
    },
  };
}

async function actorDatabase(
  root: string,
  role: "buyer" | "seller",
): Promise<DacsNodeSqliteDatabase> {
  const database = await openDacsNodeSqliteDatabase({
    databasePath: join(root, `${role}.sqlite`),
    mode: "live-demos",
    profile: DACS_NODE_LIVE_PROFILE,
    role,
    authority: role === "buyer" ? BUYER : SELLER,
  });
  databases.push(database);
  return database;
}

function operations(role: "buyer" | "seller") {
  const pending = vi.fn(async () => ({
    status: "pending-retry" as const,
    reasonCode: "integration-pending",
  }));
  return role === "buyer"
    ? {
        agreement: pending,
        payment: pending,
        "payment-evidence": pending,
        "buyer-received": pending,
        audit: pending,
      }
    : {
        agreement: pending,
        payment: pending,
        "payment-evidence": pending,
        delivery: pending,
        "delivery-evidence": pending,
        audit: pending,
      };
}

function binding(order: FixedPriceX402OrderInput | FixedPricePayDemOrderInput) {
  return order.protocol.phase === "pay-dem"
    ? {
        bindingHash: fixedPricePayDemOrderBindingHash(order as FixedPricePayDemOrderInput),
        localBindingHash: fixedPricePayDemOrderLocalBindingHash(
          order as FixedPricePayDemOrderInput,
        ),
      }
    : {
        bindingHash: fixedPriceX402OrderBindingHash(order as FixedPriceX402OrderInput),
        localBindingHash: fixedPriceX402OrderLocalBindingHash(
          order as FixedPriceX402OrderInput,
        ),
      };
}

function graph(
  role: "buyer" | "seller",
  profile: "x402" | "pay-dem",
  database: DacsNodeSqliteDatabase,
) {
  const handled = vi.fn(async (
    authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
  ) => {
    if (role === "seller" && authenticated.envelope.type === "session-init") {
      const order = (authenticated.envelope.payload as { order: unknown }).order as
        FixedPriceX402OrderInput | FixedPricePayDemOrderInput;
      const store = profile === "x402"
        ? database.createLiveCoordinatorStore("seller")
        : database.createPayDemCoordinatorStore("seller");
      const created = await store.create({
        role: "seller",
        order: order as never,
        ...binding(order),
      });
      return created.status === "created" || created.status === "existing"
        ? Object.freeze({ disposition: "accepted" as const })
        : Object.freeze({
            disposition: "rejected" as const,
            reasonCode: "integration-order-profile-conflict",
          });
    }
    return Object.freeze({ disposition: "accepted" as const });
  });
  return {
    value: Object.freeze({
      role,
      availability: Object.freeze({ status: "configured" as const }),
      ...(profile === "x402"
        ? { operations: operations(role) }
        : { payDemOperations: operations(role) }),
      // Session bootstrap messages intentionally share one schema. Both graph
      // validators accepting them reproduces the defect that #202 repaired.
      validatePayload: vi.fn(async () => Object.freeze({ status: "valid" as const })),
      handleMessage: handled,
      ...(role === "seller" && profile === "x402"
        ? { handleApplicationRequest: vi.fn(() => true) }
        : {}),
    }),
    handled,
  };
}

function authenticated(
  type: "session-init" | "session-challenge" | "session-presentation",
  jobId: string,
  payload: unknown,
  sender: string,
  audience: string,
): Readonly<DacsHttpAuthenticatedEnvelopeV1> {
  return {
    status: "authenticated",
    authenticationHash: "a".repeat(64),
    identityEvidenceHash: "b".repeat(64),
    identityRole: sender === BUYER ? "buyer" : "seller",
    receivedAt: 1,
    envelope: { type, jobId, payload, sender, audience },
  } as unknown as Readonly<DacsHttpAuthenticatedEnvelopeV1>;
}

describe("durable two-actor multirail bootstrap routing", () => {
  it("routes shared bootstrap messages through the independently retained rail", async () => {
    const root = mkdtempSync(join(tmpdir(), "dacs-multirail-bootstrap-"));
    roots.push(root);
    const [buyerDatabase, sellerDatabase] = await Promise.all([
      actorDatabase(root, "buyer"),
      actorDatabase(root, "seller"),
    ]);
    const x402Pair = createDacsFixedPriceX402OrderPairV1({
      jobId: X402_JOB,
      buyer: BUYER,
      seller: SELLER,
      protocol: x402Protocol(),
    });
    const payDemPair = createDacsFixedPricePayDemOrderPairV1({
      jobId: PAY_DEM_JOB,
      buyer: BUYER,
      seller: SELLER,
      protocol: payDemProtocol(),
    });
    expect(await buyerDatabase.createLiveCoordinatorStore("buyer").create({
      role: "buyer",
      order: x402Pair.buyer,
      bindingHash: x402Pair.bindingHash,
      localBindingHash: x402Pair.buyerLocalBindingHash,
    })).toMatchObject({ status: "created" });
    expect(await buyerDatabase.createPayDemCoordinatorStore("buyer").create({
      role: "buyer",
      order: payDemPair.buyer,
      bindingHash: payDemPair.bindingHash,
      localBindingHash: payDemPair.buyerLocalBindingHash,
    })).toMatchObject({ status: "created" });

    const buyerX402 = graph("buyer", "x402", buyerDatabase);
    const buyerPayDem = graph("buyer", "pay-dem", buyerDatabase);
    const sellerX402 = graph("seller", "x402", sellerDatabase);
    const sellerPayDem = graph("seller", "pay-dem", sellerDatabase);
    const buyer = createDacsMultirailLiveCommerceGraphV1({
      role: "buyer",
      x402: buyerX402.value as never,
      payDem: buyerPayDem.value as never,
    });
    const seller = createDacsMultirailLiveCommerceGraphV1({
      role: "seller",
      x402: sellerX402.value as never,
      payDem: sellerPayDem.value as never,
    });
    const buyerContext = { role: "buyer", database: buyerDatabase } as never;
    const sellerContext = { role: "seller", database: sellerDatabase } as never;

    for (const pair of [x402Pair, payDemPair]) {
      await expect(seller.handleMessage(authenticated(
        "session-init",
        pair.buyer.jobId,
        { order: pair.seller },
        BUYER,
        SELLER,
      ), sellerContext)).resolves.toEqual({ disposition: "accepted" });
      await expect(buyer.handleMessage(authenticated(
        "session-challenge",
        pair.buyer.jobId,
        {},
        SELLER,
        BUYER,
      ), buyerContext)).resolves.toEqual({ disposition: "accepted" });
      await expect(seller.handleMessage(authenticated(
        "session-presentation",
        pair.buyer.jobId,
        {},
        BUYER,
        SELLER,
      ), sellerContext)).resolves.toEqual({ disposition: "accepted" });
    }

    expect(buyerX402.handled).toHaveBeenCalledTimes(1);
    expect(buyerPayDem.handled).toHaveBeenCalledTimes(1);
    expect(sellerX402.handled).toHaveBeenCalledTimes(2);
    expect(sellerPayDem.handled).toHaveBeenCalledTimes(2);
    await expect(sellerDatabase.createLiveCoordinatorStore("seller")
      .load("seller", X402_JOB)).resolves.toMatchObject({ status: "ok" });
    await expect(sellerDatabase.createPayDemCoordinatorStore("seller")
      .load("seller", PAY_DEM_JOB)).resolves.toMatchObject({ status: "ok" });
  });

  it("allows only one durable winner for simultaneous cross-rail session-init", async () => {
    const root = mkdtempSync(join(tmpdir(), "dacs-multirail-race-"));
    roots.push(root);
    const sellerDatabase = await actorDatabase(root, "seller");
    const x402Pair = createDacsFixedPriceX402OrderPairV1({
      jobId: RACE_JOB,
      buyer: BUYER,
      seller: SELLER,
      protocol: x402Protocol(),
    });
    const payDemPair = createDacsFixedPricePayDemOrderPairV1({
      jobId: RACE_JOB,
      buyer: BUYER,
      seller: SELLER,
      protocol: payDemProtocol(),
    });
    const x402 = graph("seller", "x402", sellerDatabase);
    const payDem = graph("seller", "pay-dem", sellerDatabase);
    const seller = createDacsMultirailLiveCommerceGraphV1({
      role: "seller",
      x402: x402.value as never,
      payDem: payDem.value as never,
    });
    const context = { role: "seller", database: sellerDatabase } as never;

    const dispositions = await Promise.all([
      seller.handleMessage(authenticated(
        "session-init", RACE_JOB, { order: x402Pair.seller }, BUYER, SELLER,
      ), context),
      seller.handleMessage(authenticated(
        "session-init", RACE_JOB, { order: payDemPair.seller }, BUYER, SELLER,
      ), context),
    ]);
    expect(dispositions.map((value) => value.disposition).sort())
      .toEqual(["accepted", "rejected"]);
    const [retainedX402, retainedPayDem] = await Promise.all([
      sellerDatabase.createLiveCoordinatorStore("seller").load("seller", RACE_JOB),
      sellerDatabase.createPayDemCoordinatorStore("seller").load("seller", RACE_JOB),
    ]);
    expect([retainedX402.status, retainedPayDem.status].sort())
      .toEqual(["missing", "ok"]);
  });
});

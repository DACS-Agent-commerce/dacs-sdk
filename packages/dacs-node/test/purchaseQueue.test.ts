import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authenticated = vi.hoisted(() => ({ value: true }));
vi.mock("@kynesyslabs/dacs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kynesyslabs/dacs")>()),
  isAuthenticatedRailDefinition: () => authenticated.value,
  getAuthenticatedRailProvenance: () => authenticated.value ? {
    indexContentHash: "a".repeat(64),
    definitionContentHash: "b".repeat(64),
    definitionRef: { logicalAddress: "dacs4:rail:x402%3Atest:1" },
  } : null,
}));

import {
  ARTIFACT_SEPARATORS,
  signComponentArtifact,
  type Listing,
} from "@kynesyslabs/dacs/artifacts";
import { contentHash, listingAddress } from "@kynesyslabs/dacs/canonical";
import { rawPublicKey, signedBytes } from "@kynesyslabs/dacs/crypto";
import { demosAgentClaimRef, identityBundleHash } from "@kynesyslabs/dacs/identity";

import {
  createDacsPurchaseQueueExecutorV1,
  prepareDacsPayDemPurchaseV1,
  prepareDacsX402PurchaseV1,
} from "../src/purchaseQueue.js";
import {
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";
import { DACS_NODE_LIVE_PROFILE } from "../src/config.js";

const roots: string[] = [];
const databases: DacsNodeSqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const sellerKeys = generateKeyPairSync("ed25519");
  const buyerKeys = generateKeyPairSync("ed25519");
  const seller = demosAgentClaimRef(rawPublicKey(sellerKeys.publicKey));
  const buyer = demosAgentClaimRef(rawPublicKey(buyerKeys.publicKey));
  const bundle = {
    bundleVersion: "1" as const,
    presentedBy: seller,
    presentedAt: 1_000,
    claims: [{ ref: seller }],
    presentation: {
      kind: "per-claim" as const,
      signatures: [{ ref: seller, signature: "pending" }],
    },
  };
  bundle.presentation.signatures[0]!.signature = sign(
    null,
    signedBytes("dacs-bundle-presentation:v1:", identityBundleHash(bundle)),
    sellerKeys.privateKey,
  ).toString("base64url");
  const payee = `0x${"2".repeat(40)}`;
  const assetContract = `0x${"3".repeat(40)}`;
  const listing = await signComponentArtifact({
    dacsVersion: "1",
    listingVersion: 1,
    listingId: "generated-live-service",
    seller: {
      identity: bundle,
      displayName: "Generated seller",
      publicEndpoint: "https://seller.example/buy",
    },
    offering: {
      title: "Generated result",
      description: "A bounded application result",
      category: "software.service",
      tags: ["dacs"],
      deliverable: { kind: "storage-program", accessModel: "public" },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-payee-bound-agreement" },
      { kind: "pay-x402", parameters: { rail: "x402:test" } },
      { kind: "deliver-storage-program" },
    ],
    pricing: { kind: "fixed", price: { amount: "0.5", currency: "USDC" } },
    acceptedRails: [{
      railId: "x402:test",
      railVersion: 1,
      parameters: {
        network: "eip155:84532",
        payTo: payee,
        asset: assetContract,
        httpResource: "https://seller.example/buy",
      },
    }],
    terms: { deadlineSecAfterCommit: 3_600 },
    validity: { notBefore: 900, notAfter: 2_000 },
  }, ARTIFACT_SEPARATORS.Listing, {
    algorithm: "ed25519",
    signer: seller,
    sign: (bytes) => sign(null, bytes, sellerKeys.privateKey),
  });
  const listingContentHash = contentHash(listing as unknown as Record<string, unknown>);
  const listingRef = `stor-${"4".repeat(40)}`;
  const logicalAddress = listingAddress(seller, listing.listingId, listing.listingVersion);
  const rail = {
    railVersion: 1,
    railId: "x402:test",
    railType: "x402",
    asset: { kind: "erc20", chainId: 84_532, contract: assetContract,
      symbol: "USDC", decimals: 6 },
    network: { kind: "x402-resource", resourceBaseUrl: "https://seller.example/buy" },
    phaseHandler: "pay-x402",
    parameters: {},
    availability: "live",
    governance: { proposedBy: seller, acceptedAt: 1, anchoring: "single-signer" },
    signature: { algorithm: "ed25519", signer: seller, value: "A".repeat(86) },
  };
  const admission = {
    listingRef,
    logicalAddress,
    listingContentHash,
    listing,
    rail,
    facts: {
      listingRef,
      logicalAddress,
      listingContentHash,
      listingId: listing.listingId,
      listingVersion: listing.listingVersion,
      seller,
      railId: rail.railId,
      railVersion: rail.railVersion,
      network: "eip155:84532",
      asset: "USDC",
      amount: "0.5",
      payee,
    },
  };
  return { buyer, seller, payee, listingRef, admission };
}

async function payDemFixture() {
  const value = await fixture();
  const listing = structuredClone(value.admission.listing) as unknown as Listing;
  const payee = value.seller.slice(-64);
  listing.listingId = "generated-live-service-pay-dem";
  listing.pipeline = [
    { kind: "negotiate-fixed-price" },
    { kind: "commit-payee-bound-agreement" },
    { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } },
    { kind: "deliver-storage-program" },
  ];
  listing.pricing = { kind: "fixed", price: { amount: "0.5", currency: "DEM" } };
  listing.acceptedRails = [{
    railId: "demos-native:DEM",
    railVersion: 1,
    parameters: { network: "demos", payTo: payee },
  }];
  const listingContentHash = contentHash(listing as unknown as Record<string, unknown>);
  const logicalAddress = listingAddress(value.seller, listing.listingId,
    listing.listingVersion);
  const rail = {
    ...value.admission.rail,
    railId: "demos-native:DEM",
    railType: "demos-native",
    asset: { kind: "native-dem", symbol: "DEM", decimals: 9 },
    network: { kind: "demos" },
    phaseHandler: "pay-dem",
  };
  return {
    ...value,
    payer: value.buyer.slice(-64),
    payee,
    admission: {
      listingRef: value.listingRef,
      logicalAddress,
      listingContentHash,
      listing,
      rail,
      facts: {
        listingRef: value.listingRef,
        logicalAddress,
        listingContentHash,
        listingId: listing.listingId,
        listingVersion: listing.listingVersion,
        seller: value.seller,
        railId: rail.railId,
        railVersion: rail.railVersion,
        network: "demos",
        asset: "DEM",
        amount: "0.5",
        payee,
      },
    },
  };
}

describe("guarded x402 purchase queue", () => {
  beforeEach(() => { authenticated.value = true; });

  it("pins authenticated rail provenance and enqueues exact replay once", async () => {
    const value = await fixture();
    const prepared = prepareDacsX402PurchaseV1({
      admission: value.admission as never,
      jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
      buyerAuthority: value.buyer,
      payer: `0x${"1".repeat(40)}`,
      request: { requestVersion: "1", query: "bounded test" },
      maximumServiceAmount: "1",
      maximumNetworkFeeEth: "0.001",
    });
    expect(prepared.plan).toMatchObject({
      kind: "purchase",
      resume: false,
      serviceAmount: "0.5",
      estimatedNetworkFeeEth: "0",
      listingRef: value.listingRef,
    });
    expect(prepared.order.protocol.rail).toMatchObject({
      registryIndexHash: "a".repeat(64),
      railDefinitionHash: "b".repeat(64),
      railDefinitionRef: "dacs4:rail:x402%3Atest:1",
    });
    expect(Object.isFrozen(prepared.application.request)).toBe(true);

    const root = mkdtempSync(join(tmpdir(), "dacs-purchase-queue-"));
    roots.push(root);
    const database = await openDacsNodeSqliteDatabase({
      databasePath: join(root, "buyer.sqlite"),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      authority: value.buyer,
    });
    databases.push(database);
    const executor = createDacsPurchaseQueueExecutorV1({
      prepared,
      database,
      workerId: "buyer-queue-test",
    });
    const fence = {
      effectId: prepared.plan.effectId,
      planHash: prepared.plan.planHash,
      generation: 1,
      idempotencyKey: "purchase",
      assertCurrent: vi.fn(async () => undefined),
    };
    await expect(executor({ plan: prepared.plan, consent: {} as never,
      fence: { ...fence, mode: "perform" } })).resolves.toMatchObject({
      status: "completed",
      result: { jobId: prepared.plan.jobId, orderInputStatus: "created" },
    });
    await expect(executor({ plan: prepared.plan, consent: {} as never,
      fence: { ...fence, mode: "reconcile" } })).resolves.toMatchObject({
      status: "reconciled-performed",
      result: { jobId: prepared.plan.jobId, orderInputStatus: "existing" },
    });
    expect(fence.assertCurrent).toHaveBeenCalledTimes(8);
  });

  it("never turns an explicit resume into a new retained purchase", async () => {
    const value = await fixture();
    const prepared = prepareDacsX402PurchaseV1({
      admission: value.admission as never,
      jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
      buyerAuthority: value.buyer,
      payer: `0x${"1".repeat(40)}`,
      request: { requestVersion: "1", query: "bounded test" },
      maximumServiceAmount: "1",
      maximumNetworkFeeEth: "0.001",
      resume: true,
    });
    expect(prepared.plan.resume).toBe(true);
    const root = mkdtempSync(join(tmpdir(), "dacs-purchase-resume-"));
    roots.push(root);
    const database = await openDacsNodeSqliteDatabase({
      databasePath: join(root, "buyer.sqlite"),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      authority: value.buyer,
    });
    databases.push(database);
    const executor = createDacsPurchaseQueueExecutorV1({
      prepared,
      database,
      workerId: "buyer-resume-test",
    });
    await expect(executor({
      plan: prepared.plan,
      consent: {} as never,
      fence: {
        effectId: prepared.plan.effectId,
        planHash: prepared.plan.planHash,
        generation: 1,
        idempotencyKey: "purchase-resume",
        mode: "perform",
        assertCurrent: async () => undefined,
      },
    })).resolves.toEqual({
      status: "operator-action",
      reasonCode: "purchase-resume-target-missing",
    });
  });

  it("rejects loss of authenticated rail provenance before creating a plan", async () => {
    const value = await fixture();
    authenticated.value = false;
    expect(() => prepareDacsX402PurchaseV1({
      admission: value.admission as never,
      jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
      buyerAuthority: value.buyer,
      payer: `0x${"1".repeat(40)}`,
      request: { requestVersion: "1" },
      maximumServiceAmount: "1",
      maximumNetworkFeeEth: "0.001",
    })).toThrow("authenticated x402 Listing admission is invalid");
  });
});

describe("guarded pay-dem purchase queue", () => {
  beforeEach(() => { authenticated.value = true; });

  it("pins the selected DEM sibling and starts only the native coordinator", async () => {
    const value = await payDemFixture();
    const prepared = prepareDacsPayDemPurchaseV1({
      admission: value.admission as never,
      jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
      buyerAuthority: value.buyer,
      payer: value.payer,
      request: { requestVersion: "1", query: "native bounded test" },
      maximumServiceAmount: "1",
      maximumTotalDebitDem: "1.1",
    });
    expect(prepared).toMatchObject({
      plan: {
        kind: "purchase-pay-dem",
        payer: value.payer,
        payee: value.payee,
        network: "demos",
        asset: "DEM",
        maximumTotalDebitDem: "1.1",
      },
      order: { protocol: { phase: "pay-dem", rail: { railType: "demos-native" } } },
    });
    const root = mkdtempSync(join(tmpdir(), "dacs-pay-dem-purchase-queue-"));
    roots.push(root);
    const database = await openDacsNodeSqliteDatabase({
      databasePath: join(root, "buyer.sqlite"),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      authority: value.buyer,
    });
    databases.push(database);
    const executor = createDacsPurchaseQueueExecutorV1({
      prepared,
      database,
      workerId: "pay-dem-buyer-queue-test",
    });
    await expect(executor({
      plan: prepared.plan,
      consent: {} as never,
      fence: {
        mode: "perform",
        effectId: prepared.plan.effectId,
        planHash: prepared.plan.planHash,
        generation: 1,
        idempotencyKey: "pay-dem-purchase",
        assertCurrent: vi.fn(async () => undefined),
      },
    })).resolves.toMatchObject({
      status: "completed",
      result: { jobId: prepared.plan.jobId, orderInputStatus: "created" },
    });
    await expect(database.createPayDemCoordinatorStore("buyer")
      .load("buyer", prepared.order.jobId)).resolves.toMatchObject({ status: "ok" });
    await expect(database.createLiveCoordinatorStore("buyer")
      .load("buyer", prepared.order.jobId)).resolves.toEqual({ status: "missing" });
  });
});

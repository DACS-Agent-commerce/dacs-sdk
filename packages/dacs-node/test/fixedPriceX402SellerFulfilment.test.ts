import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  railProvenance: new WeakMap<object, Readonly<Record<string, unknown>>>(),
}));

vi.mock("@kynesyslabs/dacs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kynesyslabs/dacs")>()),
  isAuthenticatedRailDefinition: (value: unknown) =>
    typeof value === "object" && value !== null &&
    dependencies.railProvenance.has(value),
  getAuthenticatedRailProvenance: (value: unknown) =>
    typeof value === "object" && value !== null
      ? dependencies.railProvenance.get(value) ?? null : null,
}));

import type { Listing } from "@kynesyslabs/dacs/artifacts";
import { canonicalize, contentHash, listingAddress, sha256Hex } from
  "@kynesyslabs/dacs/canonical";
import {
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  fixedPriceX402OrderBindingHash,
  fixedPriceX402OrderLocalBindingHash,
} from "@kynesyslabs/dacs/commerce";
import { publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { demosAgentClaimRef } from "@kynesyslabs/dacs/identity";
import { afterEach, describe, expect, it } from "vitest";

import { DACS_NODE_LIVE_PROFILE } from "../src/config.js";
import { createDacsFixedPriceX402SellerFulfilmentV1 } from
  "../src/fixedPriceX402SellerFulfilment.js";
import { createDacsFixedPriceX402OrderPairV1 } from "../src/liveOrder.js";
import { putDacsLiveOrderInputV1 } from "../src/orderInput.js";
import { retainDacsFixedPricePurchaseDemosBudgetGrantV1 } from
  "../src/purchaseDemosBudget.js";
import {
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const NOW = 1_725_000_000_000;
const BUYER_KEY = rawPublicKey(publicKeyFromSeed(Uint8Array.from(Buffer.alloc(32, 11))));
const SELLER_KEY = rawPublicKey(publicKeyFromSeed(Uint8Array.from(Buffer.alloc(32, 22))));
const BUYER = demosAgentClaimRef(BUYER_KEY);
const SELLER = demosAgentClaimRef(SELLER_KEY);
const roots: string[] = [];
const databases: DacsNodeSqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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
      network: "eip155:84532" as const,
      availability: "live" as const,
    },
  };
}

function authenticatedRail() {
  const value = Object.freeze({
    railVersion: 2,
    railId: "x402:test",
    railType: "x402" as const,
    asset: {
      kind: "erc20" as const,
      chainId: 84532,
      contract: `0x${"4".repeat(40)}`,
      symbol: "USDC",
      decimals: 6,
    },
    network: {
      kind: "x402-resource" as const,
      resourceBaseUrl: "https://seller.example/dacs/x402",
    },
    phaseHandler: "pay-x402" as const,
    parameters: {},
    availability: "live" as const,
    governance: {
      proposedBy: SELLER,
      acceptedAt: NOW - 1,
      anchoring: "single-signer" as const,
    },
    signature: {
      algorithm: "ed25519" as const,
      signer: SELLER,
      value: Buffer.alloc(64, 1).toString("base64url"),
    },
  });
  dependencies.railProvenance.set(value, Object.freeze({
    registryVersion: 1,
    indexContentHash: "1".repeat(64),
    definitionContentHash: "2".repeat(64),
  }));
  return value;
}

function listing(): Listing {
  const signature = Buffer.alloc(64, 3).toString("base64url");
  return {
    dacsVersion: "1",
    listingVersion: 1,
    listingId: "seller-fulfilment-test",
    seller: {
      identity: {
        bundleVersion: "1",
        presentedBy: SELLER,
        presentedAt: NOW - 1,
        claims: [{ ref: SELLER }],
        presentation: {
          kind: "per-claim",
          signatures: [{ ref: SELLER, signature }],
        },
      },
      displayName: "Seller",
      publicEndpoint: "https://seller.example",
    },
    offering: {
      title: "Result",
      description: "Public result",
      category: "data.test",
      tags: ["test"],
      deliverable: { kind: "storage-program", accessModel: "public" },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-payee-bound-agreement" },
      { kind: "pay-x402", parameters: { rail: "x402:test" } },
      { kind: "deliver-storage-program" },
    ],
    pricing: { kind: "fixed", price: { amount: "1", currency: "USDC" } },
    acceptedRails: [{
      railId: "x402:test",
      railVersion: 2,
      parameters: {
        network: "eip155:84532",
        payTo: `0x${"3".repeat(40)}`,
        asset: `0x${"4".repeat(40)}`,
        httpResource: "https://seller.example/dacs/x402",
      },
    }],
    terms: { deadlineSecAfterCommit: 600 },
    validity: { notBefore: NOW - 1_000, notAfter: NOW + 60_000 },
    signature: { algorithm: "ed25519", signer: SELLER, value: signature },
  };
}

describe("fixed-price x402 seller fulfilment adapter", () => {
  it("persists pure application output and owns idempotent Demos publication", async () => {
    const root = mkdtempSync(join(tmpdir(), "dacs-seller-fulfilment-"));
    roots.push(root);
    const database = await openDacsNodeSqliteDatabase({
      databasePath: join(root, "seller.sqlite"),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "seller",
      authority: SELLER,
    });
    databases.push(database);
    const pair = createDacsFixedPriceX402OrderPairV1({
      jobId: JOB_ID,
      buyer: BUYER,
      seller: SELLER,
      protocol: protocol(),
    });
    const exactListing = listing();
    const request = { query: "weather" };
    const application = {
      applicationVersion: "1" as const,
      listingRef: `stor-${"5".repeat(40)}`,
      listingContentHash: contentHash(exactListing as unknown as Record<string, unknown>),
      listingLogicalAddress: listingAddress(
        exactListing.seller.identity.presentedBy,
        exactListing.listingId,
        exactListing.listingVersion,
      ),
      listing: exactListing,
      demosWriteFeeCeilings: { buyer: "2", seller: "2" },
      requestHash: sha256Hex(canonicalize(request)),
      request,
    };
    const retained = putDacsLiveOrderInputV1({
      database,
      order: pair.seller,
      application,
    });
    expect(retained.status).toBe("created");
    retainDacsFixedPricePurchaseDemosBudgetGrantV1({
      database,
      jobId: JOB_ID,
      role: "seller",
      authority: SELLER,
      maximumPerWriteFeeDem: application.demosWriteFeeCeilings.seller,
    });
    const store = database.createLiveCoordinatorStore("seller");
    await store.create({
      role: "seller",
      order: pair.seller,
      bindingHash: fixedPriceX402OrderBindingHash(pair.seller),
      localBindingHash: fixedPriceX402OrderLocalBindingHash(pair.seller),
    });

    const anchors = new Map<string, Record<string, unknown>>();
    const names = new Map<string, string>();
    const receipt = (logicalAddress: string, nativeAddress: string, hash: string) => ({
      receiptVersion: "1" as const,
      substrate: "demos",
      finalityProfile: "demos-bft-confirmed-native-read",
      logicalAddress,
      nativeAddress,
      contentHash: hash,
      transactionRef: { kind: "demos-storage-program", value: `tx:${nativeAddress}` },
      writer: SELLER,
      state: "finalized" as const,
      observationDisposition: "established" as const,
      observedAt: NOW,
      blockRef: { id: "block:1", height: "1", timestamp: NOW },
      evidence: { kind: "demos-bft-write-proof-v1", value: "proof" },
    });
    const adapter = {
      sign: vi.fn(async () => Uint8Array.from(Buffer.alloc(64, 9))),
      anchorWriteOnce: vi.fn(async (name: string, raw: Record<string, unknown>) => {
        const address = `stor-${sha256Hex(name).slice(0, 40)}`;
        const prior = anchors.get(address);
        if (prior !== undefined && canonicalize(prior) !== canonicalize(raw)) {
          throw new Error("anchor conflict");
        }
        anchors.set(address, structuredClone(raw));
        names.set(name, address);
        return { address };
      }),
      resolveAnchorByName: vi.fn(async (name: string, owner: string) => {
        expect(owner).toBe(Buffer.from(SELLER_KEY).toString("hex"));
        const address = names.get(name);
        return address === undefined
          ? { status: "absent" as const }
          : { status: "present" as const, address };
      }),
      readAnchor: vi.fn(async (address: string) =>
        structuredClone(anchors.get(address) ?? null)),
      resolveDemosAnchorReceipt: vi.fn(async (input: {
        logicalAddress: string;
        nativeAddress: string;
        contentHash: string;
      }) => receipt(input.logicalAddress, input.nativeAddress, input.contentHash)),
      verifyDemosAnchorReceipt: vi.fn(async () => true),
    };
    const context = {
      role: "seller",
      authority: SELLER,
      peerAuthority: BUYER,
      config: {
        role: "seller",
        limits: { maxDemosNetworkFeeDem: "2" },
      },
      database,
      demos: { publicKey: SELLER_KEY, adapter },
    } as never;
    const authority = {
      resolveFulfilmentAgreement: vi.fn(),
      resolveFulfilmentListing: vi.fn(),
    } as never;
    const prepareDeliverable = vi.fn(async () => ({ answer: 42 }));
    const composed = createDacsFixedPriceX402SellerFulfilmentV1({
      context,
      rail: authenticatedRail() as never,
      authority,
      workerId: "seller-test-worker",
      recipeRegistryVersion: 1,
      prepareDeliverable,
    });
    const agreement = {
      artifactKind: "payee-bound",
      ref: `dacs3:agreement:${JOB_ID}`,
      contentHash: "6".repeat(64),
      jobId: JOB_ID,
      listingPin: {
        listingId: exactListing.listingId,
        version: exactListing.listingVersion,
        contentHash: application.listingContentHash,
      },
      buyer: { primaryClaim: BUYER, bundleHash: "7".repeat(64),
        vetRecordRef: { anchor: { kind: "storage-program", locator: "buyer-vet" },
          contentHash: "8".repeat(64), signer: SELLER } },
      seller: { primaryClaim: SELLER, bundleHash: "9".repeat(64),
        vetRecordRef: { anchor: { kind: "storage-program", locator: "seller-vet" },
          contentHash: "a".repeat(64), signer: BUYER } },
      deliverableRef: { deliverableType: "storage-program",
        hash: sha256Hex(canonicalize(exactListing.offering.deliverable)) },
      commitment: { status: "finalized", ref: `dacs3:commit:${JOB_ID}`,
        agreementHash: "6".repeat(64), recordContentHash: "b".repeat(64),
        finalizedAt: NOW, signer: SELLER },
    } as const;
    const preparationInput = {
      fulfilmentId: "fulfilment-1",
      jobId: JOB_ID,
      phaseIndex: 3,
      phase: "deliver-storage-program" as const,
      logicalAddress: `dacs4:deliverable:${JOB_ID}`,
      agreement,
      deliverable: exactListing.offering.deliverable as never,
    };
    const first = await composed.fulfilmentDeps.prepareDelivery(preparationInput);
    const second = await composed.fulfilmentDeps.prepareDelivery(preparationInput);
    if (first.status !== "prepared") throw new Error(first.reason);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      status: "prepared",
      delivery: { artifact: { anchoredValue: { answer: 42 }, access: { model: "public" } } },
    });
    expect(prepareDeliverable).toHaveBeenCalledTimes(1);

    const submission = await composed.fulfilmentDeps.submitDelivery({
      ...preparationInput,
      artifact: first.delivery.artifact,
      artifactHash: sha256Hex(canonicalize(first.delivery.artifact)),
      fence: { owner: "worker", generation: 1, idempotencyKey: "delivery:1" },
    });
    expect(submission).toMatchObject({ status: "accepted" });
    expect(await composed.fulfilmentDeps.reconcileDelivery({
      fulfilmentId: "fulfilment-1",
      jobId: JOB_ID,
      phaseIndex: 3,
      phase: "deliver-storage-program",
    })).toMatchObject({ status: "complete", observedAt: NOW });
    expect(await composed.fulfilmentDeps.resolveDelivery({
      logicalAddress: `dacs4:deliverable:${JOB_ID}`,
      jobId: JOB_ID,
      phaseIndex: 3,
      phase: "deliver-storage-program",
    })).toMatchObject({ status: "verified", value: { artifact: { anchoredValue: { answer: 42 } } } });
    expect(adapter.anchorWriteOnce).toHaveBeenCalledTimes(1);
  });
});

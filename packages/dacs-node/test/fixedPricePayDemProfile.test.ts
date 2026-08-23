import { describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  resolveListing: vi.fn(),
}));

vi.mock("../src/listingDoctor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/listingDoctor.js")>()),
  resolveDacsPayDemExistingListingV1: dependencies.resolveListing,
}));

vi.mock("../src/purchaseQueue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/purchaseQueue.js")>()),
  createDacsFixedPricePayDemProtocolBindingV1: (admission: { protocol: unknown }) =>
    structuredClone(admission.protocol),
}));

import { isListing, type Listing } from "@kynesyslabs/dacs/artifacts";
import { canonicalize, contentHash, listingAddress, sha256Hex } from
  "@kynesyslabs/dacs/canonical";
import {
  fixedPricePayDemOrderLocalBindingHash,
  FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
  FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
  FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
} from "@kynesyslabs/dacs/commerce";

import {
  createDacsFixedPricePayDemSellerSessionPolicyV1,
  loadDacsFixedPricePayDemSellerAdmissionV1,
} from "../src/fixedPricePayDemProfile.js";
import { createDacsFixedPricePayDemRoleOrderV1 } from "../src/liveOrder.js";

const SELLER_KEY = "2".repeat(64);
const BUYER_KEY = "1".repeat(64);
const SELLER = `did:demos:agent:${SELLER_KEY}`;
const BUYER = `did:demos:agent:${BUYER_KEY}`;
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const LISTING_REF = `stor-${"4".repeat(40)}`;

function identity(authority: string) {
  return {
    bundleVersion: "1" as const,
    presentedBy: authority,
    presentedAt: 1_000,
    claims: [{ ref: authority }],
    presentation: {
      kind: "per-claim" as const,
      signatures: [{ ref: authority, signature: "c2ln" }],
    },
  };
}

function fixture() {
  const listing: Listing = {
    dacsVersion: "1",
    listingVersion: 1,
    listingId: "one-click-pay-dem",
    seller: {
      identity: identity(SELLER),
      displayName: "Native seller",
      publicEndpoint: "https://seller.example/buy",
    },
    offering: {
      title: "Bounded result",
      description: "One native purchase",
      category: "software.service",
      tags: ["dacs"],
      deliverable: { kind: "storage-program", accessModel: "public" },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-payee-bound-agreement" },
      { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } },
      { kind: "deliver-storage-program" },
    ],
    pricing: { kind: "fixed", price: { amount: "1", currency: "DEM" } },
    acceptedRails: [{
      railId: "demos-native:DEM",
      railVersion: 1,
      parameters: { network: "demos", payTo: SELLER_KEY },
    }],
    terms: { deadlineSecAfterCommit: 3_600 },
    validity: { notBefore: 900, notAfter: 2_000 },
    signature: { algorithm: "ed25519", signer: SELLER, value: "c2ln" },
  };
  if (!isListing(listing)) throw new Error("native Listing fixture is invalid");
  const protocol = {
    commerceProfile: FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
    standardRevision: FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
    phase: "pay-dem" as const,
    orchestratorTopology: "seller-as-phase-orchestrator-v1" as const,
    orchestrator: SELLER,
    rail: {
      registryIndexRef: FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
      registryIndexHash: "a".repeat(64),
      railDefinitionRef: "dacs4:rail:demos-native%3ADEM:1",
      railDefinitionHash: "b".repeat(64),
      railId: "demos-native:DEM",
      railVersion: 1,
      railType: "demos-native" as const,
      phaseHandler: "pay-dem" as const,
      network: "demos" as const,
      availability: "live" as const,
    },
  };
  const buyerOrder = createDacsFixedPricePayDemRoleOrderV1({
    role: "buyer",
    jobId: JOB_ID,
    buyer: BUYER,
    seller: SELLER,
    protocol,
  });
  const listingContentHash = contentHash(listing as unknown as Record<string, unknown>);
  const logicalAddress = listingAddress(SELLER, listing.listingId, listing.listingVersion);
  const application = {
    applicationVersion: "1" as const,
    listingRef: LISTING_REF,
    listingContentHash,
    listingLogicalAddress: logicalAddress,
    listing,
    requestHash: "c".repeat(64),
    request: { requestVersion: "1" },
  };
  // Bind the request hash exactly as the application validator requires.
  application.requestHash = sha256Hex(canonicalize(application.request));
  return { listing, protocol, buyerOrder, application, listingContentHash, logicalAddress };
}

describe("fixed-price pay-dem seller session policy", () => {
  it("admits the exact selected native Listing and durably binds the seller order", async () => {
    const value = await fixture();
    const effects = new Map<string, unknown>();
    const database = {
      readTime: () => 1_000,
      loadEffectInput: (_kind: string, id: string) => effects.get(id),
      putEffectIntent: (input: { effectId: string; input: unknown }) => {
        if (effects.has(input.effectId)) return { status: "existing" as const };
        effects.set(input.effectId, structuredClone(input.input));
        return { status: "created" as const };
      },
    };
    const admission = {
      listingRef: LISTING_REF,
      logicalAddress: value.logicalAddress,
      listingContentHash: value.listingContentHash,
      listing: value.listing,
      rail: {},
      protocol: value.protocol,
      facts: {},
    };
    dependencies.resolveListing.mockResolvedValue({ status: "verified", admission });
    const context = {
      role: "seller",
      authority: SELLER,
      peerAuthority: BUYER,
      database,
      demos: { adapter: {} },
    };
    const policy = createDacsFixedPricePayDemSellerSessionPolicyV1({
      context: context as never,
      rail: {} as never,
      sellerPublicEndpoint: "https://seller.example/buy",
      sellerPayee: SELLER_KEY,
      maximumServiceAmount: "2",
      now: () => 1_000,
    });
    const result = await policy.admitInit({
      authenticated: {
        envelope: { sender: BUYER, audience: SELLER },
      } as never,
      payload: { order: value.buyerOrder, application: value.application } as never,
    });
    expect(result.order).toMatchObject({
      sdkJobs: { role: "seller" },
      protocol: { phase: "pay-dem" },
    });
    expect(dependencies.resolveListing).toHaveBeenCalledWith(expect.objectContaining({
      listingRef: LISTING_REF,
      sellerPayee: SELLER_KEY,
    }));
    expect(loadDacsFixedPricePayDemSellerAdmissionV1(
      context as never,
      ({ ...result.order, role: "seller",
        localBindingHash: fixedPricePayDemOrderLocalBindingHash(result.order) } as never),
    ).application).toEqual(value.application);
  });

  it("rejects an x402-shaped order before resolving any Listing", async () => {
    const value = await fixture();
    const policy = createDacsFixedPricePayDemSellerSessionPolicyV1({
      context: {
        role: "seller", authority: SELLER, peerAuthority: BUYER,
        database: { readTime: () => 1_000 }, demos: { adapter: {} },
      } as never,
      rail: {} as never,
      sellerPublicEndpoint: "https://seller.example/buy",
      sellerPayee: SELLER_KEY,
      maximumServiceAmount: "2",
    });
    const substituted = structuredClone(value.buyerOrder) as Record<string, unknown>;
    (substituted.protocol as Record<string, unknown>).phase = "pay-x402";
    await expect(policy.admitInit({
      authenticated: { envelope: { sender: BUYER, audience: SELLER } } as never,
      payload: { order: substituted, application: value.application } as never,
    })).rejects.toThrow(/session-party-mismatch/);
  });
});

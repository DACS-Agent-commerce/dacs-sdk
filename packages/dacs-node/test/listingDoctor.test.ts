import { generateKeyPairSync, sign } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticated = vi.hoisted(() => ({ value: true }));
vi.mock("@kynesyslabs/dacs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kynesyslabs/dacs")>()),
  isAuthenticatedRailDefinition: () => authenticated.value,
  getAuthenticatedRailProvenance: () => authenticated.value ? { registryVersion: 1 } : null,
}));

import { ARTIFACT_SEPARATORS, signComponentArtifact } from "@kynesyslabs/dacs/artifacts";
import { canonicalize, contentHash, listingAddress, sha256Hex } from "@kynesyslabs/dacs/canonical";
import { rawPublicKey, signedBytes } from "@kynesyslabs/dacs/crypto";
import { demosAgentClaimRef, identityBundleHash } from "@kynesyslabs/dacs/identity";

import {
  inspectDacsPayDemExistingListingV1,
  inspectDacsPayDemListingDraftV1,
  inspectDacsX402ExistingListingV1,
  inspectDacsX402ListingDraftV1,
  inspectDacsX402PurchaseCostV1,
  resolveDacsX402ExistingListingV1,
  resolveDacsPayDemExistingListingV1,
} from "../src/listingDoctor.js";

const PAYEE = `0x${"2".repeat(40)}`;
const ASSET = `0x${"3".repeat(40)}`;
const RESOURCE = "https://seller.example/buy";

function fixture() {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = rawPublicKey(keys.publicKey);
  const authority = demosAgentClaimRef(publicKey);
  const bundle = {
    bundleVersion: "1" as const,
    presentedBy: authority,
    presentedAt: 1_000,
    claims: [{ ref: authority }],
    presentation: {
      kind: "per-claim" as const,
      signatures: [{ ref: authority, signature: "pending" }],
    },
  };
  bundle.presentation.signatures[0]!.signature = sign(
    null,
    signedBytes("dacs-bundle-presentation:v1:", identityBundleHash(bundle)),
    keys.privateKey,
  ).toString("base64url");
  const draft = {
    dacsVersion: "1",
    listingVersion: 1,
    listingId: "generated-live-service",
    seller: { identity: bundle, displayName: "Generated seller", publicEndpoint: RESOURCE },
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
      { kind: "pay-x402", parameters: { rail: "x402:base-sepolia" } },
      { kind: "deliver-storage-program" },
    ],
    pricing: { kind: "fixed", price: { amount: "0.5", currency: "USDC" } },
    acceptedRails: [{
      railId: "x402:base-sepolia",
      railVersion: 1,
      parameters: {
        network: "eip155:84532",
        payTo: PAYEE,
        asset: ASSET,
        httpResource: RESOURCE,
      },
    }],
    terms: { deadlineSecAfterCommit: 3_600 },
    validity: { notBefore: 900, notAfter: 2_000 },
  };
  const rail = {
    railVersion: 1,
    railId: "x402:base-sepolia",
    railType: "x402",
    asset: { kind: "erc20", chainId: 84_532, contract: ASSET, symbol: "USDC", decimals: 6 },
    network: { kind: "x402-resource", resourceBaseUrl: RESOURCE },
    phaseHandler: "pay-x402",
    parameters: {},
    availability: "live",
    governance: { proposedBy: authority, acceptedAt: 1, anchoring: "single-signer" },
    signature: { algorithm: "ed25519", signer: authority, value: "A".repeat(86) },
  };
  return {
    keys,
    draft,
    options: {
      draft,
      sellerAuthority: authority,
      sellerPublicKey: publicKey,
      sellerPublicEndpoint: RESOURCE,
      sellerPayee: PAYEE,
      network: "eip155:84532" as const,
      rail,
      maximumServiceAmount: "1",
      now: 1_000,
    },
  };
}

function payDemFixture() {
  const value = fixture();
  const sellerPayee = Buffer.from(value.options.sellerPublicKey).toString("hex");
  const draft = {
    ...value.draft,
    listingId: "generated-live-service-pay-dem",
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-payee-bound-agreement" },
      { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } },
      { kind: "deliver-storage-program" },
    ],
    pricing: { kind: "fixed", price: { amount: "0.5", currency: "DEM" } },
    acceptedRails: [{
      railId: "demos-native:DEM",
      railVersion: 1,
      parameters: { network: "demos", payTo: sellerPayee },
    }],
  };
  const rail = {
    ...value.options.rail,
    railId: "demos-native:DEM",
    railType: "demos-native",
    asset: { kind: "native-dem", symbol: "DEM", decimals: 9 },
    network: { kind: "demos" },
    phaseHandler: "pay-dem",
  };
  return {
    ...value,
    draft,
    options: {
      draft,
      sellerAuthority: value.options.sellerAuthority,
      sellerPublicKey: value.options.sellerPublicKey,
      sellerPublicEndpoint: value.options.sellerPublicEndpoint,
      sellerPayee,
      rail,
      maximumServiceAmount: "1",
      now: 1_000,
    },
  };
}

async function publishedPayDemFixture() {
  const value = payDemFixture();
  const listing = await signComponentArtifact(
    value.draft,
    ARTIFACT_SEPARATORS.Listing,
    {
      algorithm: "ed25519",
      signer: value.options.sellerAuthority,
      sign: (bytes) => sign(null, bytes, value.keys.privateKey),
    },
  );
  const listingRef = `stor-${"6".repeat(40)}`;
  const listingContentHash = contentHash(listing as unknown as Record<string, unknown>);
  const logicalAddress = listingAddress(
    listing.seller.identity.presentedBy,
    listing.listingId,
    listing.listingVersion,
  );
  const index = {
    indexVersion: "1",
    generatedAt: 1_000,
    seller: value.options.sellerAuthority,
    listings: [{
      listingId: listing.listingId,
      version: listing.listingVersion,
      contentHash: listingContentHash,
      anchor: { kind: "storage-program", locator: listingRef },
      summary: {
        title: listing.offering.title,
        category: listing.offering.category,
        tags: listing.offering.tags,
        priceHint: "0.5",
      },
      status: "active",
    }],
  };
  const card = {
    dacs: {
      dacsVersion: "1",
      listings: {
        indexUrl: "https://seller.example/.well-known/dacs/listings.json",
        indexHash: `sha256-${sha256Hex(canonicalize(index))}`,
      },
    },
  };
  return {
    ...value,
    listingRef,
    listingContentHash,
    logicalAddress,
    options: {
      ...value.options,
      listingRef,
      readAnchor: vi.fn(async (locator: string) => locator === listingRef
        ? listing as unknown as Record<string, unknown> : null),
      authenticateAnchor: vi.fn(async (input: { logicalAddress: string }) =>
        input.logicalAddress === logicalAddress),
      readJson: vi.fn(async (url: string) => url.endsWith("agent.json") ? card : index),
    },
  };
}

describe("x402 Listing candidate doctor", () => {
  beforeEach(() => { authenticated.value = true; });

  it("admits an identity-, rail-, payee-, and ceiling-bound fixed-price draft", () => {
    const { draft, options } = fixture();
    expect(inspectDacsX402ListingDraftV1(options as never)).toEqual({
      status: "pass",
      facts: {
        candidateHash: contentHash(draft),
        listingId: "generated-live-service",
        listingVersion: 1,
        railId: "x402:base-sepolia",
        railVersion: 1,
        asset: "USDC",
        amount: "0.5",
        payee: PAYEE,
      },
    });
  });

  it("rejects substituted identity, payee, price, and provisional rail authority", () => {
    const first = fixture();
    expect(inspectDacsX402ListingDraftV1({
      ...first.options,
      draft: { ...first.draft, pricing: { kind: "fixed", price: { amount: "2", currency: "USDC" } } },
    } as never)).toMatchObject({ status: "fail", reasonCode: "listing-candidate-price-invalid" });
    const second = fixture();
    second.draft.acceptedRails[0]!.parameters.payTo = `0x${"4".repeat(40)}`;
    expect(inspectDacsX402ListingDraftV1(second.options as never)).toMatchObject({
      status: "fail", reasonCode: "listing-candidate-rail-invalid",
    });
    authenticated.value = false;
    expect(() => inspectDacsX402ListingDraftV1(fixture().options as never)).toThrow(
      /authority is invalid/,
    );
  });

  it("blocks a well-formed candidate outside its live interval", () => {
    const value = fixture();
    expect(inspectDacsX402ListingDraftV1({ ...value.options, now: 3_000 } as never))
      .toEqual({ status: "blocked", reasonCode: "listing-candidate-not-live" });
  });
});

describe("pay-dem Listing candidate doctor", () => {
  beforeEach(() => { authenticated.value = true; });

  it("admits only an authority-owned native payee and a one-rail DEM pipeline", () => {
    const value = payDemFixture();
    expect(inspectDacsPayDemListingDraftV1(value.options as never)).toEqual({
      status: "pass",
      facts: {
        candidateHash: contentHash(value.draft),
        listingId: "generated-live-service-pay-dem",
        listingVersion: 1,
        railId: "demos-native:DEM",
        railVersion: 1,
        asset: "DEM",
        amount: "0.5",
        payee: value.options.sellerPayee,
      },
    });
    const substituted = structuredClone(value.draft);
    substituted.acceptedRails[0]!.parameters.payTo = "9".repeat(64);
    expect(inspectDacsPayDemListingDraftV1({
      ...value.options,
      draft: substituted,
    } as never)).toEqual({
      status: "fail",
      reasonCode: "listing-candidate-rail-invalid",
    });
  });

  it("resolves the signed Listing through its authenticated discovery entry", async () => {
    const value = await publishedPayDemFixture();
    await expect(resolveDacsPayDemExistingListingV1(value.options as never)).resolves
      .toMatchObject({
        status: "verified",
        admission: {
          listingRef: value.listingRef,
          logicalAddress: value.logicalAddress,
          listingContentHash: value.listingContentHash,
          facts: {
            network: "demos",
            asset: "DEM",
            amount: "0.5",
            payee: value.options.sellerPayee,
          },
        },
      });
    await expect(inspectDacsPayDemExistingListingV1(value.options as never)).resolves
      .toMatchObject({ status: "pass", facts: { railId: "demos-native:DEM" } });
  });
});

describe("existing x402 Listing doctor", () => {
  beforeEach(() => { authenticated.value = true; });

  async function publishedFixture() {
    const value = fixture();
    const listing = await signComponentArtifact(
      value.draft,
      ARTIFACT_SEPARATORS.Listing,
      {
        algorithm: "ed25519",
        signer: value.options.sellerAuthority,
        sign: (bytes) => sign(null, bytes, value.keys.privateKey),
      },
    );
    const listingRef = `stor-${"4".repeat(40)}`;
    const listingContentHash = contentHash(listing as unknown as Record<string, unknown>);
    const logicalAddress = listingAddress(
      listing.seller.identity.presentedBy,
      listing.listingId,
      listing.listingVersion,
    );
    const index = {
      indexVersion: "1",
      generatedAt: 1_000,
      seller: value.options.sellerAuthority,
      listings: [{
        listingId: listing.listingId,
        version: listing.listingVersion,
        contentHash: listingContentHash,
        anchor: { kind: "storage-program", locator: listingRef },
        summary: {
          title: listing.offering.title,
          category: listing.offering.category,
          tags: listing.offering.tags,
          priceHint: listing.pricing.kind === "fixed" ? listing.pricing.price.amount : undefined,
        },
        status: "active",
      }],
    };
    const card = {
      dacs: {
        dacsVersion: "1",
        listings: {
          indexUrl: "https://seller.example/.well-known/dacs/listings.json",
          indexHash: `sha256-${sha256Hex(canonicalize(index))}`,
        },
      },
    };
    const options = {
      ...value.options,
      listingRef,
      now: 1_000,
      readAnchor: vi.fn(async (locator: string) => locator === listingRef
        ? listing as unknown as Record<string, unknown> : null),
      authenticateAnchor: vi.fn(async (input: { logicalAddress: string }) =>
        input.logicalAddress === logicalAddress),
      readJson: vi.fn(async (url: string) => url.endsWith("agent.json") ? card : index),
    };
    return { ...value, listing, listingRef, listingContentHash, logicalAddress, index, card, options };
  }

  it("admits an exact receipt-authenticated Listing through its integrity-bound active index", async () => {
    const value = await publishedFixture();
    const result = await resolveDacsX402ExistingListingV1(value.options as never);
    expect(result).toMatchObject({
      status: "verified",
      admission: {
        listingRef: value.listingRef,
        logicalAddress: value.logicalAddress,
        listingContentHash: value.listingContentHash,
        facts: {
          amount: "0.5",
          asset: "USDC",
          network: "eip155:84532",
          payee: PAYEE,
        },
      },
    });
    await expect(inspectDacsX402ExistingListingV1(value.options as never)).resolves
      .toMatchObject({ status: "pass", facts: { listingRef: value.listingRef } });
    if (result.status !== "verified") throw new Error("fixture was not admitted");
    expect(inspectDacsX402PurchaseCostV1({
      admission: result.admission,
      maximumServiceAmount: "0.75",
      maximumNetworkFeeEth: "0.001",
    })).toEqual({
      status: "pass",
      facts: {
        serviceAsset: "USDC",
        estimatedServiceAmount: "0.5",
        maximumServiceAmount: "0.75",
        estimatedBuyerNetworkFeeEth: "0",
        networkFeeSafetyMarginEth: "0",
        maximumNetworkFeeEth: "0.001",
        facilitatorBroadcast: true,
        demosFeesReportedSeparately: true,
      },
    });
    expect(inspectDacsX402PurchaseCostV1({
      admission: result.admission,
      maximumServiceAmount: "0.25",
      maximumNetworkFeeEth: "0",
    })).toEqual({
      status: "fail",
      reasonCode: "x402-service-cost-ceiling-exceeded",
    });
  });

  it("fails a false Demos receipt and blocks an integrity-mismatched discovery index", async () => {
    const receipt = await publishedFixture();
    receipt.options.authenticateAnchor.mockResolvedValue(false);
    await expect(resolveDacsX402ExistingListingV1(receipt.options as never)).resolves.toEqual({
      status: "fail",
      reasonCode: "listing-anchor-authentication-invalid",
    });

    const discovery = await publishedFixture();
    discovery.card.dacs.listings.indexHash = `sha256-${"0".repeat(64)}`;
    await expect(resolveDacsX402ExistingListingV1(discovery.options as never)).resolves.toEqual({
      status: "blocked",
      reasonCode: "listing-registry-resolution-unavailable",
    });
  });

  it("rejects an exact reference whose authenticated index binds another native anchor", async () => {
    const value = await publishedFixture();
    value.index.listings[0]!.anchor.locator = `stor-${"5".repeat(40)}`;
    value.card.dacs.listings.indexHash = `sha256-${sha256Hex(canonicalize(value.index))}`;
    await expect(resolveDacsX402ExistingListingV1(value.options as never)).resolves.toEqual({
      status: "blocked",
      reasonCode: "listing-registry-resolution-unavailable",
    });
  });
});

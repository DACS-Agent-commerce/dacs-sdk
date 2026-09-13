import { describe, expect, it } from "vitest";

import { isListing, type Listing } from "@kynesyslabs/dacs/artifacts";

import {
  createDacsListingOfferManifestV1,
  dacsListingOfferGroupV1,
  dacsListingRailProfileV1,
} from "../src/listingOffer.js";

const SELLER = `did:demos:agent:${"1".repeat(64)}`;
const PAYEE = "1".repeat(64);

function listing(profile: "pay-dem" | "x402"): Listing {
  const railId = profile === "pay-dem" ? "demos-native:DEM" : "x402:base-sepolia";
  const value: Listing = {
    dacsVersion: "1",
    listingVersion: 1,
    listingId: `bounded-result-${profile}`,
    seller: {
      identity: {
        bundleVersion: "1",
        presentedBy: SELLER,
        presentedAt: 1_000,
        claims: [{ ref: SELLER }],
        presentation: {
          kind: "per-claim",
          signatures: [{ ref: SELLER, signature: "c2ln" }],
        },
      },
      displayName: "Bounded seller",
      publicEndpoint: "https://seller.example/buy",
    },
    offering: {
      title: "Bounded result",
      description: "One application result",
      category: "software.service",
      tags: ["dacs"],
      deliverable: { kind: "storage-program", accessModel: "public" },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-payee-bound-agreement" },
      { kind: profile === "pay-dem" ? "pay-dem" : "pay-x402",
        parameters: { rail: railId } },
      { kind: "deliver-storage-program" },
    ],
    pricing: {
      kind: "fixed",
      price: profile === "pay-dem"
        ? { amount: "1", currency: "DEM" }
        : { amount: "0.1", currency: "USDC" },
    },
    acceptedRails: [{
      railId,
      railVersion: 1,
      parameters: profile === "pay-dem"
        ? { network: "demos", payTo: PAYEE }
        : {
            network: "eip155:84532",
            payTo: `0x${"2".repeat(40)}`,
            asset: `0x${"3".repeat(40)}`,
            httpResource: "https://seller.example/buy",
          },
    }],
    terms: { deadlineSecAfterCommit: 3_600 },
    validity: { notBefore: 900, notAfter: 2_000 },
    signature: { algorithm: "ed25519", signer: SELLER, value: "c2ln" },
  };
  if (!isListing(value)) throw new Error("Listing fixture is invalid");
  return value;
}

describe("one-click Listing offer siblings", () => {
  it("groups independent DEM and x402 Listings without grouping their rail authority", () => {
    const payDem = listing("pay-dem");
    const x402 = listing("x402");
    expect(dacsListingOfferGroupV1(payDem)).toBe(dacsListingOfferGroupV1(x402));
    expect(dacsListingRailProfileV1(payDem)).toBe("pay-dem");
    expect(dacsListingRailProfileV1(x402)).toBe("x402");
    expect(createDacsListingOfferManifestV1([x402, payDem])).toMatchObject({
      manifestVersion: "1",
      offerGroup: dacsListingOfferGroupV1(payDem),
      variants: [
        { profile: "pay-dem", listingId: "bounded-result-pay-dem" },
        { profile: "x402", listingId: "bounded-result-x402" },
      ],
    });
  });

  it("rejects duplicate rails and unrelated service siblings", () => {
    const first = listing("pay-dem");
    const duplicate = structuredClone(first);
    duplicate.listingId = "another-pay-dem";
    expect(() => createDacsListingOfferManifestV1([first, duplicate])).toThrow(
      /listing-offer-siblings-invalid/,
    );
    const unrelated = listing("x402");
    unrelated.offering.title = "Different service";
    expect(() => createDacsListingOfferManifestV1([first, unrelated])).toThrow(
      /listing-offer-siblings-invalid/,
    );
  });
});

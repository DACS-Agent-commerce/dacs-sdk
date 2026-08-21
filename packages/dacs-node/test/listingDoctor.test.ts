import { generateKeyPairSync, sign } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticated = vi.hoisted(() => ({ value: true }));
vi.mock("@kynesyslabs/dacs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kynesyslabs/dacs")>()),
  isAuthenticatedRailDefinition: () => authenticated.value,
  getAuthenticatedRailProvenance: () => authenticated.value ? { registryVersion: 1 } : null,
}));

import { contentHash } from "@kynesyslabs/dacs/canonical";
import { rawPublicKey, signedBytes } from "@kynesyslabs/dacs/crypto";
import { demosAgentClaimRef, identityBundleHash } from "@kynesyslabs/dacs/identity";

import { inspectDacsX402ListingDraftV1 } from "../src/listingDoctor.js";

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

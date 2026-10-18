import * as fixtureWire from "../../src/wire/index.js";
import { fixtureBinder } from "./authorityFixture.js";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as wire from "../../src/wire/index.js";
import { contentHash } from "../../src/canonical/index.js";
import { verifyArtifact } from "../../src/crypto/index.js";
import { isListingEnvelope } from "../../src/artifacts/validators.js";

const bindTp1Fixture = fixtureBinder(fixtureWire);

const NOW = Date.UTC(2026, 9, 18);
const JOB = "01K7FZ8Q9W3V5T2R1N0M8K6J4H";
function signer() {
  const keys = generateKeyPairSync("ed25519");
  return {
    claim: `did:demos:agent:${keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex")}`,
    publicKey: keys.publicKey,
    calls: 0,
    sign(bytes: Uint8Array) { this.calls++; return sign(null, Buffer.from(bytes), keys.privateKey); },
  };
}
async function world(change: Record<string, unknown> = {}) {
  const buyer = signer(), seller = signer();
  const local = { endpoint: "https://rpc.eligibility.invalid/", transportAuthority: "test", connectionId: "1" };
  const binding = bindTp1Fixture({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local });
  const selected = {
    pricingKind: "fixed", negotiation: "negotiate-fixed-price", rail: "pay-dem",
    delivery: wire.TP1_CAPABILITIES.delivery, service: { kind: "fixed-text" }, output: wire.TP1_CAPABILITIES.output,
    buyerRequestInput: false, ...change,
  };
  const artifact = {
    dacsVersion: "1", listingId: "report", listingVersion: 1,
    seller: { identity: { bundleVersion: "1", presentedBy: seller.claim, presentedAt: NOW - 1000,
      claims: [{ ref: seller.claim }], presentation: { kind: "per-claim", signatures: [{ ref: seller.claim, signature: "fixture-identity-proof" }] } },
      displayName: "Fixture seller", publicEndpoint: "https://seller.eligibility.invalid" },
    offering: { title: "Report", description: "Fixture report", category: "data.test", tags: [], deliverable: { kind: "storage-program" } },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [{ kind: selected.negotiation }, { kind: "commit-agreement" }, { kind: selected.rail }, { kind: "deliver-storage-program" }],
    pricing: selected.pricingKind === "metered" ? { kind: "metered", unitPrice: { amount: "1", currency: "DEM" }, unit: "request" } :
      { kind: selected.pricingKind, price: { amount: "1", currency: "DEM" } },
    acceptedRails: [{ railId: selected.rail }], terms: {}, validity: { notBefore: NOW - 1000, notAfter: NOW + 60_000 },
  };
  const pin = { listingId: artifact.listingId, version: artifact.listingVersion, contentHash: contentHash(artifact) };
  const signedListing = { ...artifact, signature: { algorithm: "ed25519", signer: seller.claim,
    value: Buffer.from(seller.sign(Buffer.from("dacs-listing:v1:" + pin.contentHash))).toString("base64url") } };
  expect(isListingEnvelope(signedListing)).toBe(true);
  const listing = { seller: seller.claim, publicEndpoint: artifact.seller.publicEndpoint, listingPin: pin };
  const eligibility = {
    ...listing, ...selected, notBefore: artifact.validity.notBefore, expiresAt: artifact.validity.notAfter,
  };
  // A trusted reader authenticates actual full Listing bytes and their hash.
  // The projection is derived from those terms and the local service config,
  // independently of the seller's discovery capability advertisement.
  const readListingEligibility: wire.ListingEligibilityReader = (scope) => {
    expect(contentHash(signedListing)).toBe(scope.listingPin.contentHash);
    expect(verifyArtifact("dacs-listing:v1:", signedListing, Buffer.from(signedListing.signature.value, "base64url"), seller.publicKey)).toBe(true);
    return { ...eligibility, pricingKind: signedListing.pricing.kind, negotiation: signedListing.pipeline[0]!.kind, rail: signedListing.pipeline[2]!.kind };
  };
  const document = await wire.signDiscoveryDocument({
    format: "dacs-seller-discovery/v1", profile: binding.profile, seller: seller.claim, publicEndpoint: listing.publicEndpoint,
    transport: ["dacs-seller-http/v1"], listings: [listing.listingPin], capabilities: wire.TP1_CAPABILITIES,
    ready: true, issuedAt: NOW, expiresAt: NOW + 60_000,
  }, seller, binding, local);
  const request = { signer: buyer, binding, local, now: NOW, publicEndpoint: listing.publicEndpoint, seller: seller.claim,
    path: "/dacs/v1/commitments", jobId: JOB, text: "{}", job: { listingPin: listing.listingPin, agreementHash: "a".repeat(64), profile: binding.profile } };
  return { buyer, seller, local, binding, listing, document, eligibility, readListingEligibility, request };
}

describe("authenticated Listing eligibility before purchase signing", () => {
  it.each([
    ["x402", { rail: "pay-x402" }], ["metered", { pricingKind: "metered" }],
    ["input-taking", { buyerRequestInput: true }], ["RFQ", { negotiation: "negotiate-rfq" }],
    ["external delivery", { delivery: { channel: "https", address: "https://delivery.invalid" } }],
    ["unknown service", { service: { kind: "remote-http" } }],
    ["unconfigured module", { service: { kind: "pure-synchronous-text-module", configured: false, pure: true, deterministic: true, synchronous: true } }],
    ["impure module", { service: { kind: "pure-synchronous-text-module", configured: true, pure: false, deterministic: true, synchronous: true } }],
    ["nondeterministic module", { service: { kind: "pure-synchronous-text-module", configured: true, pure: true, deterministic: false, synchronous: true } }],
    ["asynchronous module", { service: { kind: "pure-synchronous-text-module", configured: true, pure: true, deterministic: true, synchronous: false } }],
    ["oversized output", { output: { ...wire.TP1_CAPABILITIES.output, maxCharacters: 16385 } }],
    ["asynchronous output", { output: { ...wire.TP1_CAPABILITIES.output, synchronous: false } }],
  ])("refuses an authenticated %s Listing despite matching seller-signed discovery", async (_name, change) => {
    const w = await world(change as Record<string, unknown>);
    const readListingEligibility = w.readListingEligibility;
    await expect(Promise.resolve().then(async () => {
      const endpointProof = wire.verifyEndpointProof(w.document, { listing: w.listing, binding: w.binding, local: w.local, now: NOW, readListingEligibility });
      await wire.signWireRequest({ ...w.request, endpointProof });
    })).rejects.toMatchObject({ code: "listing_unsupported" });
    expect(w.buyer.calls).toBe(0);
  });
});

it("requires an authenticated reader and binds its decision to the exact seller, endpoint and content hash", async () => {
  const w = await world();
  const options = { listing: w.listing, binding: w.binding, local: w.local, now: NOW };
  expect(() => wire.verifyEndpointProof(w.document, options as any)).toThrowError(expect.objectContaining({ code: "listing_eligibility_required" }));
  for (const change of [
    { seller: w.buyer.claim }, { publicEndpoint: `${w.listing.publicEndpoint}/` },
    { listingPin: { ...w.listing.listingPin, contentHash: "d".repeat(64) } },
    { listingPin: { ...w.listing.listingPin, version: 2 } },
  ]) {
    expect(() => wire.verifyEndpointProof(w.document, { ...options, readListingEligibility: () => ({ ...w.eligibility, ...change }) }))
      .toThrowError(expect.objectContaining({ code: "listing_eligibility_mismatch" }));
  }
  expect(w.buyer.calls).toBe(0);
});

it.each(["request", "envelope"])("rechecks authenticated eligibility immediately before %s signing", async (entry) => {
  const w = await world();
  let decision: unknown = w.eligibility;
  const endpointProof = wire.verifyEndpointProof(w.document, { listing: w.listing, binding: w.binding, local: w.local, now: NOW, readListingEligibility: () => decision });
  const signed = await wire.signWireRequest({ ...w.request, endpointProof });
  expect(w.buyer.calls).toBe(1);
  decision = { ...w.eligibility, rail: "pay-x402" };
  const before = w.buyer.calls;
  const invoke = () => entry === "request" ? wire.signWireRequest({ ...w.request, endpointProof }) :
    wire.signWireEnvelope(signed.payload, { signer: w.buyer, binding: w.binding, local: w.local, purchaseProfile: w.binding.profile, endpointProof, publicEndpoint: w.listing.publicEndpoint, now: NOW });
  await expect(invoke()).rejects.toMatchObject({ code: "listing_unsupported" });
  expect(w.buyer.calls).toBe(before);
});

it("accepts an explicitly configured pure deterministic synchronous module and preserves reader failure causes", async () => {
  const w = await world();
  const decision = { ...w.eligibility, service: { kind: "pure-synchronous-text-module", configured: true, pure: true, deterministic: true, synchronous: true } };
  let failure: Error | undefined;
  const endpointProof = wire.verifyEndpointProof(w.document, { listing: w.listing, binding: w.binding, local: w.local, now: NOW,
    readListingEligibility: () => { if (failure) throw failure; return decision; } });
  await wire.signWireRequest({ ...w.request, endpointProof });
  failure = new Error("authenticated Listing read timed out");
  await expect(wire.signWireRequest({ ...w.request, endpointProof })).rejects.toBe(failure);
  expect(w.buyer.calls).toBe(1);
});

it.each([null, {}, { ...wire.TP1_CAPABILITIES }, Promise.resolve(null)])("fails closed on a malformed reader decision (%s)", async (decision) => {
  const w = await world();
  expect(() => wire.verifyEndpointProof(w.document, { listing: w.listing, binding: w.binding, local: w.local, now: NOW, readListingEligibility: () => decision }))
    .toThrowError(expect.objectContaining({ code: "listing_unsupported" }));
  expect(w.buyer.calls).toBe(0);
});

it.each([
  ["not yet valid", { notBefore: NOW + 1 }], ["expired", { expiresAt: NOW }],
  ["ambiguous expiry", { expiresAt: null }],
])("refuses a %s authenticated Listing decision", async (_label, change) => {
  const w = await world();
  expect(() => wire.verifyEndpointProof(w.document, { listing: w.listing, binding: w.binding, local: w.local, now: NOW,
    readListingEligibility: () => ({ ...w.eligibility, ...change }) }))
    .toThrowError(expect.objectContaining({ code: "listing_unsupported" }));
  expect(w.buyer.calls).toBe(0);
});

it("supplies an immutable source scope and refuses decisions that disappear after proof creation", async () => {
  const w = await world();
  let current: unknown = w.eligibility;
  const endpointProof = wire.verifyEndpointProof(w.document, { listing: w.listing, binding: w.binding, local: w.local, now: NOW,
    readListingEligibility: (scope) => {
      expect(Object.isFrozen(scope)).toBe(true);
      expect(Object.isFrozen(scope.listingPin)).toBe(true);
      return current;
    } });
  current = null;
  await expect(wire.signWireRequest({ ...w.request, endpointProof })).rejects.toMatchObject({ code: "listing_unsupported" });
  expect(w.buyer.calls).toBe(0);
});

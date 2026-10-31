import * as wireValidate from "../../src/wire/validate.js";
import * as wireDiscovery from "../../src/wire/discovery.js";
import * as fixtureWire from "../../src/wire/index.js";
import { fixtureBinder } from "./authorityFixture.js";
import { generateKeyPairSync, sign } from "node:crypto";
import { expect, it } from "vitest";
import { canonicalize } from "../../src/canonical/index.js";
import * as wire from "../../src/wire/index.js";
import { readFixtureListingEligibility } from "./listingEligibilityFixture.js";
import { assertEndpointProof } from "../../src/wire/discovery.js";

const bindTp1Fixture = fixtureBinder(fixtureWire);

it("admits exactly ten minutes, rejects ten minutes plus one millisecond at receiver and before producer signing", async () => {
  const keys = generateKeyPairSync("ed25519");
  const claim = `did:demos:agent:${keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex")}`;
  const local = { endpoint: "https://rpc.lifetime.invalid/", transportAuthority: "test", connectionId: "1" };
  const binding = await bindTp1Fixture({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local });
  const now = Date.UTC(2026, 9, 18);
  const listing = { seller: claim, publicEndpoint: "https://seller.lifetime.invalid", listingPin: { listingId: "report", version: 1, contentHash: "c".repeat(64) } };
  let calls = 0;
  const signer = { claim, sign(bytes: Uint8Array) { calls++; return sign(null, Buffer.from(bytes), keys.privateKey); } };
  for (const duration of [600_000, 600_001]) {
    const payload: wire.DiscoveryPayload = {
      format: "dacs-seller-discovery/v1", profile: binding.profile, seller: claim, publicEndpoint: listing.publicEndpoint,
      transport: ["dacs-seller-http/v1"], listings: [listing.listingPin], capabilities: wire.TP1_CAPABILITIES,
      ready: true, issuedAt: now, expiresAt: now + duration,
    };
    // Sign independently so the receiver is tested even when the producer
    // already refuses the overlong payload.
    const signature = sign(null, Buffer.from(wire.DACS_SELLER_HTTP_DOMAINS.discovery + canonicalize(payload)), keys.privateKey).toString("base64url");
    const bytes = Buffer.from(canonicalize({ payload, signature }));
    const receive = () => wire.verifyEndpointProof(bytes, { listing, binding, local, now, readListingEligibility: readFixtureListingEligibility });
    calls = 0;
    if (duration === 600_000) {
      expect((await receive()).ready).toBe(true);
      await wire.signDiscoveryDocument(payload, signer, binding, local);
      expect(calls).toBe(1);
    } else {
      await expect(receive()).rejects.toMatchObject({ code: "discovery_invalid" });
      await expect(wire.signDiscoveryDocument(payload, signer, binding, local)).rejects.toMatchObject({ code: "discovery_invalid" });
      expect(calls).toBe(0);
    }
  }
});


// Independent signing uses fixed keys and exact document bytes.
import { ed25519Sign, privateKeyFromSeed } from "../../src/crypto/ed25519.js";
import { committedPurchase, COMMITTED_AT, SELLER_SEED, bytes as artifactBytes } from "./committedPurchaseFixture.js";

async function proofFixture(ready = true, now = COMMITTED_AT) {
  const purchase = await committedPurchase((listing) => { listing.seller.publicEndpoint = "https://seller.proof.invalid"; });
  const binding = purchase.scope.binding, local = binding.local;
  const publicEndpoint = purchase.listing.seller.publicEndpoint;
  if (publicEndpoint === undefined) throw new Error("fixture endpoint missing");
  const listing = { seller: purchase.scope.seller, publicEndpoint, listingPin: purchase.scope.listingPin };
  const payload: wire.DiscoveryPayload = { format: "dacs-seller-discovery/v1", profile: binding.profile,
    seller: listing.seller, publicEndpoint: listing.publicEndpoint, transport: ["dacs-seller-http/v1"], listings: [listing.listingPin],
    capabilities: wire.TP1_CAPABILITIES, ready, issuedAt: now, expiresAt: now + 60_000 };
  const document = () => Buffer.from(canonicalize({ payload, signature: Buffer.from(ed25519Sign(
    Buffer.from(wire.DACS_SELLER_HTTP_DOMAINS.discovery + canonicalize(payload)), privateKeyFromSeed(SELLER_SEED))).toString("base64url") }));
  const options = { listing, binding, local, now, readListingEligibility: readFixtureListingEligibility };
  const request = { ...purchase.scope.request, path: "/dacs/v1/payments" };
  const continuation = { request, commitment: artifactBytes(purchase.anchored), agreement: artifactBytes(purchase.agreement),
    signedListing: artifactBytes(purchase.listing), readCommitmentReceipt: Object.assign(async () => "valid", { chainIdentity: binding.profile.chainIdentity }) };
  const scope = { binding, ...listing, now, request: { ...request, path: wire.DACS_SELLER_HTTP_PATHS.proposals } };
  return { purchase, payload, document, options, continuation, scope };
}

it("rejects altered discovery signatures and endpoint mismatches", async () => {
  const f = await proofFixture();
  const altered: unknown = JSON.parse(f.document().toString());
  if (!wireValidate.isRecord(altered)) throw new Error("invalid fixture document");
  altered.signature = Buffer.alloc(64).toString("base64url");
  await expect(Promise.resolve().then(() => wire.verifyEndpointProof(Buffer.from(JSON.stringify(altered)), f.options)))
    .rejects.toMatchObject({ code: "discovery_signature_invalid" });
  f.payload.publicEndpoint = "https://another.proof.invalid";
  await expect(Promise.resolve().then(() => wire.verifyEndpointProof(f.document(), f.options)))
    .rejects.toMatchObject({ code: "discovery_endpoint_mismatch" });
});

it("accepts the Listing expiry endpoint and refuses one millisecond after it", async () => {
  const f = await proofFixture();
  const readListingEligibility = (scope: Parameters<wire.ListingEligibilityReader>[0]) => ({ ...readFixtureListingEligibility(scope), expiresAt: f.options.now });
  const proof = await wire.verifyEndpointProof(f.document(), { ...f.options, readListingEligibility });
  await wireDiscovery.assertEndpointProof(proof, f.scope);
  await expect(Promise.resolve().then(() => wireDiscovery.assertEndpointProof(proof, { ...f.scope, now: f.scope.now + 1 })))
    .rejects.toMatchObject({ code: "listing_unsupported" });
});

it("rechecks revoked Listing decisions and seller readiness before a request can continue", async () => {
  const f = await proofFixture();
  let revoked = false;
  const readListingEligibility = (scope: Parameters<wire.ListingEligibilityReader>[0]) => revoked ? null : readFixtureListingEligibility(scope);
  const proof = await wire.verifyEndpointProof(f.document(), { ...f.options, readListingEligibility });
  revoked = true;
  await expect(Promise.resolve().then(() => wireDiscovery.assertEndpointProof(proof, f.scope))).rejects.toMatchObject({ code: "listing_unsupported" });
  const draining = await proofFixture(false);
  const drainingProof = await wire.verifyEndpointProof(draining.document(), draining.options);
  await expect(Promise.resolve().then(() => wireDiscovery.assertEndpointProof(drainingProof, draining.scope))).rejects.toMatchObject({ code: "seller_not_ready" });
});

it("awaits an asynchronous Listing decision and keeps the cause of its rejection", async () => {
  const f = await proofFixture();
  const readListingEligibility = async (scope: Parameters<wire.ListingEligibilityReader>[0]) => readFixtureListingEligibility(scope);
  const proof = await wire.verifyEndpointProof(f.document(), { ...f.options, readListingEligibility });
  await wireDiscovery.assertEndpointProof(proof, f.scope);
  const cause = new Error("listing store timeout");
  const failing = async () => { throw cause; };
  await expect(wire.verifyEndpointProof(f.document(), { ...f.options, readListingEligibility: failing })).rejects.toBe(cause);
});

it.each([wire.DACS_SELLER_HTTP_PATHS.payments, wire.DACS_SELLER_HTTP_PATHS.bundleRequest, wire.DACS_SELLER_HTTP_PATHS.bundleCountersignature])(
  "refuses a request on %s that carries no commitment evidence", async (path) => {
    const f = await proofFixture();
    const request = { ...f.continuation.request, path };
    const proof = await wire.verifyEndpointProof(f.document(), f.options);
    const refused = { code: "continuation_commitment_invalid", detail: "CONTINUATION-EVIDENCE-REQUIRED" };
    await expect(wireDiscovery.assertEndpointProof(proof, { ...f.scope, request })).rejects.toMatchObject(refused);
    await expect(wire.verifyEndpointProof(f.document(), { ...f.options, request })).rejects.toMatchObject(refused);
  });

it("verifies a complete committed purchase at proof creation and on proof assertion", async () => {
  const f = await proofFixture(false, COMMITTED_AT + 120_000);
  const readListingEligibility = (scope: Parameters<wire.ListingEligibilityReader>[0]) => ({ ...readFixtureListingEligibility(scope), expiresAt: COMMITTED_AT });
  let reads = 0;
  f.continuation.readCommitmentReceipt = Object.assign(async () => { reads++; return "valid"; }, { chainIdentity: f.options.binding.profile.chainIdentity });
  const proof = await wire.verifyEndpointProof(f.document(), { ...f.options, readListingEligibility, ...f.continuation });
  await wireDiscovery.assertEndpointProof(proof, { ...f.scope, ...f.continuation });
  expect(reads).toBe(2);
});

it.each([
  wire.DACS_SELLER_HTTP_PATHS.payments,
  wire.DACS_SELLER_HTTP_PATHS.bundleRequest,
  wire.DACS_SELLER_HTTP_PATHS.bundleCountersignature,
  wire.DACS_SELLER_HTTP_PATHS.bundleBuyerCopy,
])("continues %s after Listing revocation and expiry without reading current eligibility", async (path) => {
  const f = await proofFixture();
  f.payload.expiresAt = COMMITTED_AT + 600_000;
  let revoked = false, listingReads = 0, receiptReads = 0;
  const readListingEligibility = (scope: Parameters<wire.ListingEligibilityReader>[0]) => {
    listingReads++;
    return revoked ? null : readFixtureListingEligibility(scope);
  };
  f.continuation.request.path = path;
  f.continuation.readCommitmentReceipt = Object.assign(async () => { receiptReads++; return "valid"; },
    { chainIdentity: f.options.binding.profile.chainIdentity });
  const proof = await wire.verifyEndpointProof(f.document(), { ...f.options, readListingEligibility,
    readCommitmentReceipt: f.continuation.readCommitmentReceipt });
  await assertEndpointProof(proof, { ...f.scope, ...f.continuation });
  revoked = true;
  const now = COMMITTED_AT + 120_000;
  await assertEndpointProof(proof, { ...f.scope, ...f.continuation, now });
  f.payload.ready = false;
  f.payload.issuedAt = now;
  f.payload.expiresAt = now + 60_000;
  const fresh = await wire.verifyEndpointProof(f.document(), { ...f.options, ...f.continuation, now, readListingEligibility });
  await assertEndpointProof(fresh, { ...f.scope, ...f.continuation, now });
  expect(listingReads).toBe(1);
  expect(receiptReads).toBe(4);
  await expect(assertEndpointProof(fresh, { ...f.scope, now })).rejects.toMatchObject({ code: "listing_unsupported" });
});

it("continues a committed purchase when the current Listing reader throws", async () => {
  const f = await proofFixture(false, COMMITTED_AT + 120_000);
  const readListingEligibility = () => { throw new Error("Listing revoked"); };
  const proof = await wire.verifyEndpointProof(f.document(), { ...f.options, ...f.continuation, readListingEligibility });
  await assertEndpointProof(proof, { ...f.scope, ...f.continuation });
});

it.each(["bytes", "admitted"])("binds continuation endpoints to the signed Listing supplied as %s", async (input) => {
  const f = await proofFixture();
  const publicEndpoint = "https://different.proof.invalid";
  f.payload.publicEndpoint = publicEndpoint;
  const listing = { ...f.options.listing, publicEndpoint };
  const signedListing = input === "bytes" ? f.continuation.signedListing : wire.admitWireArtifact(f.continuation.signedListing);
  const continuation = { ...f.continuation, signedListing };
  const refused = { code: "continuation_listing_invalid", detail: "ENDPOINT" };
  await expect(wire.verifyEndpointProof(f.document(), { ...f.options, ...continuation, listing })).rejects.toMatchObject(refused);
  const proof = await wire.verifyEndpointProof(f.document(), { ...f.options, listing,
    readCommitmentReceipt: f.continuation.readCommitmentReceipt });
  await expect(assertEndpointProof(proof, { ...f.scope, ...continuation, publicEndpoint })).rejects.toMatchObject(refused);
});

it.each(["missing", "buyer", "seller"])("rejects a %s Agreement signature before issuing a continuation proof", async (fault) => {
  const f = await proofFixture(false);
  if (fault === "missing") f.continuation.agreement = Buffer.from("{}");
  else {
    const party = fault === "buyer" ? f.purchase.scope.request.buyer : f.purchase.scope.seller;
    const signature = f.purchase.agreement.signatures.find((item) => item.party === party);
    if (!signature) throw new Error("missing fixture signature");
    signature.value = Buffer.alloc(64).toString("base64url");
    f.continuation.agreement = artifactBytes(f.purchase.agreement);
  }
  await expect(Promise.resolve().then(() => wire.verifyEndpointProof(f.document(), { ...f.options, ...f.continuation })))
    .rejects.toMatchObject({ code: "continuation_agreement_invalid" });
});

it("requires authenticated continuation request identity and awaits a rejected receipt reader", async () => {
  const f = await proofFixture(false);
  const { request: omitted, ...withoutRequest } = f.continuation;
  expect(omitted.jobId).toBe(f.purchase.scope.request.jobId);
  await expect(Promise.resolve().then(() => wire.verifyEndpointProof(f.document(), { ...f.options, ...withoutRequest })))
    .rejects.toMatchObject({ code: "continuation_commitment_invalid" });
  const cause = new Error("receipt timeout");
  f.continuation.readCommitmentReceipt = Object.assign(async () => { throw cause; }, { chainIdentity: f.options.binding.profile.chainIdentity });
  await expect(Promise.resolve().then(() => wire.verifyEndpointProof(f.document(), { ...f.options, ...f.continuation }))).rejects.toBe(cause);
});


it("rechecks CA-7 and the receipt when asserting an already issued proof", async () => {
  const f = await proofFixture(false);
  let verdict = "valid";
  f.continuation.readCommitmentReceipt = Object.assign(async () => verdict, { chainIdentity: f.options.binding.profile.chainIdentity });
  const proof = await wire.verifyEndpointProof(f.document(), { ...f.options, ...f.continuation });
  await expect(wireDiscovery.assertEndpointProof(proof, { ...f.scope, ...f.continuation, agreement: Buffer.from("{}") }))
    .rejects.toMatchObject({ code: "continuation_agreement_invalid" });
  verdict = "invalid";
  await expect(wireDiscovery.assertEndpointProof(proof, { ...f.scope, ...f.continuation }))
    .rejects.toMatchObject({ code: "continuation_commitment_invalid" });
});

it("does not issue a proof while receipt verification is pending", async () => {
  const f = await proofFixture(false);
  let enter: (() => void) | undefined, release: ((verdict: string) => void) | undefined;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const receipt = new Promise<string>((resolve) => { release = resolve; });
  f.continuation.readCommitmentReceipt = Object.assign(async () => { if (!enter) throw new Error("missing barrier"); enter(); return receipt; },
    { chainIdentity: f.options.binding.profile.chainIdentity });
  let settled = false;
  const pending = wire.verifyEndpointProof(f.document(), { ...f.options, ...f.continuation });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await entered;
  expect(settled).toBe(false);
  if (!release) throw new Error("missing receipt barrier");
  release("invalid");
  await expect(pending).rejects.toMatchObject({ code: "continuation_commitment_invalid" });
});

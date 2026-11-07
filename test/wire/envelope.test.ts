import { expect, it } from "vitest";
import * as wire from "../../src/wire/index.js";
import { encodeHeader, wireWorld } from "./conformanceFixture.js";
import { committedPurchase, BUYER_SEED, SELLER_SEED, bytes } from "./committedPurchaseFixture.js";
import { ed25519Sign, privateKeyFromSeed } from "../../src/crypto/ed25519.js";
import { readFixtureListingEligibility } from "./listingEligibilityFixture.js";

it("requires the expected seller principal when opening a signed response", async () => {
  const x = await wireWorld();
  const payload: wire.WireResponsePayload = { ...x.request, kind: "response", requestHash: wire.wireRequestHash(x.request), status: 200 };
  const header = await wire.signWireEnvelope(payload, { ...x.context, signer: x.seller });
  expect((await wire.openWireEnvelope(header, "response", { ...x.context, principal: x.seller.claim })).payload).toEqual(payload);
  await expect(Promise.resolve().then(() => wire.openWireEnvelope(header, "response", x.context))).rejects.toMatchObject({ code: "wire_input_invalid" });
  await expect(Promise.resolve().then(() => wire.openWireEnvelope(header, "response", { ...x.context, principal: x.buyer.claim })))
    .rejects.toMatchObject({ code: "peer_signer_wrong" });
});

it("refuses response delegations, malformed response fields and a request-domain signature", async () => {
  const x = await wireWorld();
  const payload: wire.WireResponsePayload = { ...x.request, kind: "response", requestHash: wire.wireRequestHash(x.request), status: 200 };
  const options = { ...x.context, principal: x.seller.claim };
  for (const changed of [{ ...payload, status: 199 }, { ...payload, status: 200.5 }, { ...payload, requestHash: "invalid" }]) {
    const header = encodeHeader(x.signed(changed, x.seller, wire.DACS_SELLER_HTTP_DOMAINS.response));
    await expect(Promise.resolve().then(() => wire.openWireEnvelope(header, "response", options))).rejects.toMatchObject({ code: "peer_envelope_invalid" });
  }
  const signed = x.signed(payload, x.seller, wire.DACS_SELLER_HTTP_DOMAINS.response);
  await expect(Promise.resolve().then(() => wire.openWireEnvelope(encodeHeader({ ...signed, delegation: {} }), "response", options)))
    .rejects.toMatchObject({ code: "peer_envelope_invalid" });
  await expect(Promise.resolve().then(() => wire.openWireEnvelope(encodeHeader(x.signed(payload, x.seller)), "response", options)))
    .rejects.toMatchObject({ code: "peer_signature_invalid" });
});

it.each(["seller", "jobId", "listingPin"] as const)("refuses a session delegation transplanted to another %s", async (field) => {
  const x = await wireWorld();
  const delegation = x.signed(x.delegation, x.buyer, wire.DACS_SELLER_HTTP_DOMAINS.delegation);
  const valid = encodeHeader({ ...x.signed(x.request, x.session), delegation });
  expect((await wire.openWireEnvelope(valid, "request", x.context)).payload).toEqual(x.request);
  const payload = { ...x.request, [field]: field === "listingPin" ? { ...x.pin, version: 2 } : field === "jobId" ? "01J8ME0SXKQ4T9V2RC5HJ6WX7F" : `did:demos:agent:${"f".repeat(64)}` };
  const header = encodeHeader({ ...x.signed(payload, x.session), delegation });
  await expect(Promise.resolve().then(() => wire.openWireEnvelope(header, "request", x.context)))
    .rejects.toMatchObject({ code: "peer_delegation_mismatch" });
});

const OTHER_JOB = "01J8ME0SXKQ4T9V2RC5HJ6WX7F";
it.each([
  ["a payload changed after it was signed", (x: Awaited<ReturnType<typeof wireWorld>>) => ({ ...x.signed(x.delegation, x.buyer, wire.DACS_SELLER_HTTP_DOMAINS.delegation), payload: { ...x.delegation, jobId: OTHER_JOB } }), "peer_delegation_signature_invalid"],
  ["another job", (x: Awaited<ReturnType<typeof wireWorld>>) => x.signed({ ...x.delegation, jobId: OTHER_JOB }, x.buyer, wire.DACS_SELLER_HTTP_DOMAINS.delegation), "peer_delegation_mismatch"],
  ["a start in the future", (x: Awaited<ReturnType<typeof wireWorld>>) => x.signed({ ...x.delegation, notBefore: x.input.now + 1 }, x.buyer, wire.DACS_SELLER_HTTP_DOMAINS.delegation), "peer_delegation_expired"],
])("emits no request signature when the supplied delegation has %s", async (_name, delegate, code) => {
  const x = await wireWorld();
  x.session.calls = 0;
  const ctx = { ...x.input, signer: x.session, purchaseProfile: x.binding.profile };
  await expect(wire.signWireEnvelope(x.request, ctx, delegate(x) as wire.SellerSessionDelegation)).rejects.toMatchObject({ code });
  expect(x.session.calls).toBe(0);
});

it("signs a request under a delegation that has expired, leaving the routes it serves to the receiver", async () => {
  const x = await wireWorld();
  const delegation = x.signed({ ...x.delegation, expiresAt: x.input.now }, x.buyer, wire.DACS_SELLER_HTTP_DOMAINS.delegation) as wire.SellerSessionDelegation;
  const header = await wire.signWireEnvelope(x.request, { ...x.input, signer: x.session, purchaseProfile: x.binding.profile }, delegation);
  expect((await wire.openWireEnvelope(header, "request", x.context)).payload).toEqual(x.request);
});

async function continuationSigning(path: string) {
  const p = await committedPurchase((listing) => { listing.seller.publicEndpoint = "https://seller.proof.invalid"; });
  const binding = p.scope.binding, local = binding.local, now = p.scope.now, publicEndpoint = "https://seller.proof.invalid";
  const seller = { claim: p.scope.seller, sign: (input: Uint8Array) => ed25519Sign(input, privateKeyFromSeed(SELLER_SEED)) };
  const discovery = await wire.signDiscoveryDocument({ format: "dacs-seller-discovery/v1", profile: binding.profile, seller: seller.claim,
    publicEndpoint, transport: ["dacs-seller-http/v1"], listings: [p.scope.listingPin], capabilities: wire.TP1_CAPABILITIES,
    ready: true, issuedAt: now, expiresAt: now + 60_000 }, seller, binding, local);
  const endpointProof = await wire.verifyEndpointProof(discovery, { binding, local, now,
    listing: { seller: seller.claim, publicEndpoint, listingPin: p.scope.listingPin }, readListingEligibility: readFixtureListingEligibility,
    readCommitmentReceipt: Object.assign(() => "valid", { chainIdentity: binding.profile.chainIdentity }) });
  const x = await wireWorld();
  const payload: wire.WireRequestPayload = { ...x.request, ...p.scope.request, seller: seller.claim, listingPin: p.scope.listingPin,
    profile: binding.profile, path, expiresAt: now + 30_000 };
  let calls = 0;
  const buyer = { claim: payload.buyer, sign: (input: Uint8Array) => { calls++; return ed25519Sign(input, privateKeyFromSeed(BUYER_SEED)); } };
  const context = { signer: buyer, binding, local, purchaseProfile: binding.profile, endpointProof, publicEndpoint, now };
  return { p, payload, context, signatures: () => calls };
}

it("emits no request signature when the endpoint continuation lacks a verified Agreement", async () => {
  const { p, payload, context, signatures } = await continuationSigning("/dacs/v1/payments");
  await expect(wire.signWireEnvelope(payload, { ...context, commitment: bytes(p.anchored), agreement: Buffer.from("{}"), signedListing: bytes(p.listing) }))
    .rejects.toMatchObject({ code: "continuation_agreement_invalid" });
  expect(signatures()).toBe(0);
});

it.each(["/dacs/v1/payments", "/dacs/v1/bundles/request", "/dacs/v1/bundles/countersignature"])(
  "emits no signature for a request on %s that carries no commitment evidence", async (path) => {
    const { payload, context, signatures } = await continuationSigning(path);
    await expect(wire.signWireEnvelope(payload, context)).rejects.toMatchObject({ code: "continuation_commitment_invalid", detail: "CONTINUATION-EVIDENCE-REQUIRED" });
    expect(signatures()).toBe(0);
  });

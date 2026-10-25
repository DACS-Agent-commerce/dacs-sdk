import { expect, it } from "vitest";
import * as wire from "../../src/wire/index.js";
import { assertEndpointProof } from "../../src/wire/discovery.js";
import { readFixtureListingEligibility } from "./listingEligibilityFixture.js";
import { received, signedAgreement, tp1Listing, validReceipt, wireCommitment } from "./commitmentFixture.js";
import { canonicalize } from "../../src/canonical/index.js";
import { JOB, NOW, wireWorld } from "./conformanceFixture.js";

it("every discovery pin, boolean readiness, positive interval and exact document members", async () => {
  const x = (await wireWorld());
  for (const patch of [{ listings: [x.pin, { ...x.pin, version: 0 }] }, { ready: "true" }, { issuedAt: NOW + 1000, expiresAt: NOW + 1000 }]) {
    const p = { ...x.discovery, ...patch } as any;
    await expect(wire.signDiscoveryDocument(p, x.seller, x.binding, x.local)).rejects.toMatchObject({ code: "discovery_invalid" });
    await expect(Promise.resolve().then(async () => (await wire.verifyEndpointProof(x.document(p), x.options)))).rejects.toThrowError(expect.objectContaining({ code: "discovery_invalid", status: 502 }));
  }
  const extra = { ...JSON.parse(x.document().toString()), extra: true };
  await expect(Promise.resolve().then(async () => (await wire.verifyEndpointProof(Buffer.from(canonicalize(extra)), x.options)))).rejects.toThrowError(expect.objectContaining({ code: "discovery_invalid", status: 502 }));
  expect(x.seller.calls).toBe(0);
});
it("authenticated Listing timestamp validity and inclusive notBefore are rechecked at signing", async () => {
  const x = (await wireWorld());
  let notBefore = NOW;
  const readListingEligibility: wire.ListingEligibilityReader = (scope) => ({ ...readFixtureListingEligibility(scope), notBefore });
  const options = { ...x.options, readListingEligibility };
  const proof = (await wire.verifyEndpointProof(x.document(), options));
  expect((await wire.signWireRequest({ ...x.input, endpointProof: proof })).payload.buyer).toBe(x.buyer.claim);
  x.buyer.calls = 0;
  for (const bad of [-1, NOW + 1]) {
    notBefore = bad;
    await expect(Promise.resolve().then(async () => (await wire.verifyEndpointProof(x.document(), options)))).rejects.toThrowError(expect.objectContaining({ code: "listing_unsupported" }));
    await expect(wire.signWireRequest({ ...x.input, endpointProof: proof })).rejects.toMatchObject({ code: "listing_unsupported" });
  }
  expect(x.buyer.calls).toBe(0);
});
it("inclusive 60s issuedAt skew, rollback refusal and exclusive expiry on initial and retained proofs", async () => {
  const x = (await wireWorld());
  const options = { ...x.options, now: NOW - 60_000 };
  const proof = (await wire.verifyEndpointProof(x.document(), options));
  expect((await wire.signWireRequest({ ...x.input, endpointProof: proof, now: options.now })).payload.expiresAt).toBe(options.now + 30_000);
  x.buyer.calls = 0;
  await expect(Promise.resolve().then(async () => (await wire.verifyEndpointProof(x.document(), { ...options, now: NOW - 60_001 })))).rejects.toThrowError(expect.objectContaining({ code: "discovery_expired", status: 502 }));
  await expect(wire.signWireRequest({ ...x.input, endpointProof: proof, now: NOW - 60_001 })).rejects.toMatchObject({ code: "discovery_expired", status: 503 });
  await expect(Promise.resolve().then(async () => (await wire.verifyEndpointProof(x.document(), { ...options, now: x.discovery.expiresAt })))).rejects.toThrowError(expect.objectContaining({ code: "discovery_expired" }));
  await expect(wire.signWireRequest({ ...x.input, endpointProof: proof, now: x.discovery.expiresAt })).rejects.toMatchObject({ code: "discovery_expired" });
  expect(x.buyer.calls).toBe(0);
});
it("a committed continuation uses its pinned Listing when live eligibility changes", async () => {
  const x = (await wireWorld()), listing = tp1Listing({ seller: x.seller, publicEndpoint: x.discovery.publicEndpoint });
  const a = signedAgreement({ buyer: x.buyer, seller: x.seller, jobId: JOB, listingPin: listing.pin, listing });
  const c = wireCommitment({ seller: x.seller, buyer: x.buyer.claim, jobId: JOB, agreementHash: a.agreementHash, listingPin: listing.pin, committedAt: NOW + 10_000 });
  let notBefore = NOW;
  const options = { ...x.options, listing: { ...x.options.listing, listingPin: listing.pin },
    request: { ...x.request, path: wire.DACS_SELLER_HTTP_PATHS.payments, agreementHash: a.agreementHash },
    commitment: received(c), agreement: received(a.agreement), signedListing: received(listing.listing), readCommitmentReceipt: Object.assign(validReceipt, { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }),
    readListingEligibility: ((scope) => ({ ...readFixtureListingEligibility(scope), notBefore })) as wire.ListingEligibilityReader };
  const doc = x.document({ ...x.discovery, listings: [listing.pin] });
  const proof = (await wire.verifyEndpointProof(doc, options));
  const scope = { binding: x.binding, seller: x.seller.claim, listingPin: listing.pin, publicEndpoint: x.discovery.publicEndpoint, now: NOW,
    request: { ...x.request, path: wire.DACS_SELLER_HTTP_PATHS.payments, listingPin: listing.pin, agreementHash: a.agreementHash },
    commitment: options.commitment, agreement: options.agreement, signedListing: options.signedListing };
  await expect(assertEndpointProof(proof, scope)).resolves.toBeUndefined();
  notBefore = NOW + 1;
  await expect(wire.verifyEndpointProof(doc, options)).resolves.toMatchObject({ ready: true });
  await expect(assertEndpointProof(proof, scope)).resolves.toBeUndefined();
});
it("refused discovery participants cause zero trusted eligibility or receipt reads", async () => {
  const x = (await wireWorld());
  let eligibility = 0, receipts = 0;
  x.revoke();
  await expect(Promise.resolve().then(async () => (await wire.verifyEndpointProof(x.document(), { ...x.options,
    readListingEligibility: (scope) => { eligibility++; return readFixtureListingEligibility(scope); },
    readCommitmentReceipt: Object.assign(() => { receipts++; return "valid"; }, { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }) })))).rejects.toThrowError(expect.objectContaining({ code: "tp1_participant_profile_mismatch" }));
  expect({ eligibility, receipts }).toEqual({ eligibility: 0, receipts: 0 });
});
it("authority is rechecked after each trusted reader returns", async () => {
  for (const boundary of ["eligibility", "receipt"]) {
    const x = (await wireWorld()), listing = tp1Listing({ seller: x.seller, publicEndpoint: x.discovery.publicEndpoint });
    const a = signedAgreement({ buyer: x.buyer, seller: x.seller, jobId: JOB, listingPin: listing.pin, listing });
    const c = wireCommitment({ seller: x.seller, buyer: x.buyer.claim, jobId: JOB, agreementHash: a.agreementHash, listingPin: listing.pin, committedAt: NOW - 5000 });
    let calls = 0;
    // A payment request is refused without commitment evidence before any recheck, so only the receipt boundary continues a purchase.
    const options = { ...x.options, listing: { ...x.options.listing, listingPin: listing.pin },
      ...(boundary === "receipt" ? { request: { ...x.request, path: wire.DACS_SELLER_HTTP_PATHS.payments, agreementHash: a.agreementHash },
        commitment: received(c), agreement: received(a.agreement), signedListing: received(listing.listing) } : {}),
      readListingEligibility: (scope: Parameters<wire.ListingEligibilityReader>[0]) => { if (boundary === "eligibility") { calls++; x.revoke(); } return readFixtureListingEligibility(scope); },
      readCommitmentReceipt: Object.assign(() => { calls++; x.revoke(); return "valid"; }, { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }) };
    await expect(Promise.resolve().then(async () => (await wire.verifyEndpointProof(x.document({ ...x.discovery, listings: [listing.pin] }), options)))).rejects.toThrowError(expect.objectContaining({ code: "tp1_participant_profile_mismatch" }));
    expect(calls).toBe(1);
  }
});
it("primitive local identifiers and direct participant/session scope guards precede authority reads", async () => {
  const x = (await wireWorld());
  let calls = 0;
  for (const key of ["transportAuthority", "connectionId"]) for (const value of [1, true]) {
    await expect(Promise.resolve().then(async () => (await wire.bindTp1Profile({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local: { ...x.local, [key]: value }, readAuthority: () => { calls++; return null; } } as any)))).rejects.toThrowError(expect.objectContaining({ code: "tp1_local_binding_invalid" }));
  }
  expect(calls).toBe(0);
  const before = x.reads();
  for (const [participants, session] of [ [[x.buyer.claim, x.seller.claim], "bad-job"], [[], JOB], [[x.buyer.claim], JOB], [[x.buyer.claim, x.buyer.claim], JOB], [["not-a-claim", x.seller.claim], JOB], [[x.buyer.claim], null], [[x.buyer.claim, x.seller.claim], "dacs-seller-discovery/v1"] ] as const) {
    await expect(Promise.resolve().then(async () => (await wire.assertTp1Authority(x.binding, x.local, participants, session)))).rejects.toThrowError(expect.objectContaining({ code: "tp1_participant_profile_mismatch", status: 500 }));
  }
  expect(x.reads()).toBe(before);
  await expect(wire.assertTp1Authority(x.binding, x.local, [x.buyer.claim, x.seller.claim], JOB)).resolves.toBeUndefined();
  expect(x.reads()).toBe(before + 1);
});

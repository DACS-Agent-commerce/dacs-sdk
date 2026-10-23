import { expect, it } from "vitest";
import * as wire from "../../src/wire/index.js";
import { assertEndpointProof } from "../../src/wire/discovery.js";
import { readFixtureListingEligibility } from "./listingEligibilityFixture.js";
import { received, signedAgreement, tp1Listing, validReceipt, wireCommitment } from "./commitmentFixture.js";
import { canonicalize } from "../../src/canonical/index.js";
import { JOB, NOW, wireWorld } from "./conformanceFixture.js";

it("every discovery pin, boolean readiness, positive interval and exact document members", async () => {
  const x = wireWorld();
  for (const patch of [{ listings: [x.pin, { ...x.pin, version: 0 }] }, { ready: "true" }, { issuedAt: NOW + 1000, expiresAt: NOW + 1000 }]) {
    const p = { ...x.discovery, ...patch } as any;
    await expect(wire.signDiscoveryDocument(p, x.seller, x.binding, x.local)).rejects.toMatchObject({ code: "discovery_invalid" });
    expect(() => wire.verifyEndpointProof(x.document(p), x.options)).toThrowError(expect.objectContaining({ code: "discovery_invalid", status: 502 }));
  }
  const extra = { ...JSON.parse(x.document().toString()), extra: true };
  expect(() => wire.verifyEndpointProof(Buffer.from(canonicalize(extra)), x.options)).toThrowError(expect.objectContaining({ code: "discovery_invalid", status: 502 }));
  expect(x.seller.calls).toBe(0);
});
it("authenticated Listing timestamp validity and inclusive notBefore are rechecked at signing", async () => {
  const x = wireWorld();
  let notBefore = NOW;
  const readListingEligibility: wire.ListingEligibilityReader = (scope) => ({ ...readFixtureListingEligibility(scope), notBefore });
  const options = { ...x.options, readListingEligibility };
  const proof = wire.verifyEndpointProof(x.document(), options);
  expect((await wire.signWireRequest({ ...x.input, endpointProof: proof })).payload.buyer).toBe(x.buyer.claim);
  x.buyer.calls = 0;
  for (const bad of [-1, NOW + 1]) {
    notBefore = bad;
    expect(() => wire.verifyEndpointProof(x.document(), options)).toThrowError(expect.objectContaining({ code: "listing_unsupported" }));
    await expect(wire.signWireRequest({ ...x.input, endpointProof: proof })).rejects.toMatchObject({ code: "listing_unsupported" });
  }
  expect(x.buyer.calls).toBe(0);
});
it("inclusive 60s issuedAt skew, rollback refusal and exclusive expiry on initial and retained proofs", async () => {
  const x = wireWorld();
  const options = { ...x.options, now: NOW - 60_000 };
  const proof = wire.verifyEndpointProof(x.document(), options);
  expect((await wire.signWireRequest({ ...x.input, endpointProof: proof, now: options.now })).payload.expiresAt).toBe(options.now + 30_000);
  x.buyer.calls = 0;
  expect(() => wire.verifyEndpointProof(x.document(), { ...options, now: NOW - 60_001 })).toThrowError(expect.objectContaining({ code: "discovery_expired", status: 502 }));
  await expect(wire.signWireRequest({ ...x.input, endpointProof: proof, now: NOW - 60_001 })).rejects.toMatchObject({ code: "discovery_expired", status: 503 });
  expect(() => wire.verifyEndpointProof(x.document(), { ...options, now: x.discovery.expiresAt })).toThrowError(expect.objectContaining({ code: "discovery_expired" }));
  await expect(wire.signWireRequest({ ...x.input, endpointProof: proof, now: x.discovery.expiresAt })).rejects.toMatchObject({ code: "discovery_expired" });
  expect(x.buyer.calls).toBe(0);
});
it("future-skew commitment time does not admit a Listing decision that is not live yet", () => {
  const x = wireWorld(), listing = tp1Listing({ seller: x.seller });
  const a = signedAgreement({ buyer: x.buyer, seller: x.seller, jobId: JOB, listingPin: listing.pin, listing });
  const c = wireCommitment({ seller: x.seller, buyer: x.buyer.claim, jobId: JOB, agreementHash: a.agreementHash, listingPin: listing.pin, committedAt: NOW + 10_000 });
  let notBefore = NOW;
  const options = { ...x.options, listing: { ...x.options.listing, listingPin: listing.pin },
    commitment: received(c), agreement: received(a.agreement), signedListing: received(listing.listing), readCommitmentReceipt: validReceipt,
    readListingEligibility: ((scope) => ({ ...readFixtureListingEligibility(scope), notBefore })) as wire.ListingEligibilityReader };
  const doc = x.document({ ...x.discovery, listings: [listing.pin] });
  const proof = wire.verifyEndpointProof(doc, options);
  const scope = { binding: x.binding, seller: x.seller.claim, listingPin: listing.pin, publicEndpoint: x.discovery.publicEndpoint, now: NOW,
    request: { ...x.request, path: wire.DACS_SELLER_HTTP_PATHS.payments, listingPin: listing.pin, agreementHash: a.agreementHash },
    commitment: options.commitment, agreement: options.agreement, signedListing: options.signedListing };
  expect(() => assertEndpointProof(proof, scope)).not.toThrow();
  notBefore = NOW + 1;
  expect(() => wire.verifyEndpointProof(doc, options)).toThrowError(expect.objectContaining({ code: "listing_unsupported" }));
  expect(() => assertEndpointProof(proof, scope)).toThrowError(expect.objectContaining({ code: "listing_unsupported" }));
});
it("refused discovery participants cause zero trusted eligibility or receipt reads", () => {
  const x = wireWorld();
  let eligibility = 0, receipts = 0;
  x.revoke();
  expect(() => wire.verifyEndpointProof(x.document(), { ...x.options,
    readListingEligibility: (scope) => { eligibility++; return readFixtureListingEligibility(scope); },
    readCommitmentReceipt: () => { receipts++; return "valid"; } })).toThrowError(expect.objectContaining({ code: "tp1_participant_profile_mismatch" }));
  expect({ eligibility, receipts }).toEqual({ eligibility: 0, receipts: 0 });
});
it("authority is rechecked after each trusted reader returns", () => {
  for (const boundary of ["eligibility", "receipt"]) {
    const x = wireWorld(), listing = tp1Listing({ seller: x.seller });
    const a = signedAgreement({ buyer: x.buyer, seller: x.seller, jobId: JOB, listingPin: listing.pin, listing });
    const c = wireCommitment({ seller: x.seller, buyer: x.buyer.claim, jobId: JOB, agreementHash: a.agreementHash, listingPin: listing.pin, committedAt: NOW - 5000 });
    let calls = 0;
    const options = { ...x.options, listing: { ...x.options.listing, listingPin: listing.pin },
      ...(boundary === "receipt" ? { commitment: received(c), agreement: received(a.agreement), signedListing: received(listing.listing) } : {}),
      readListingEligibility: (scope: Parameters<wire.ListingEligibilityReader>[0]) => { if (boundary === "eligibility") { calls++; x.revoke(); } return readFixtureListingEligibility(scope); },
      readCommitmentReceipt: () => { calls++; x.revoke(); return "valid"; } };
    expect(() => wire.verifyEndpointProof(x.document({ ...x.discovery, listings: [listing.pin] }), options)).toThrowError(expect.objectContaining({ code: "tp1_participant_profile_mismatch" }));
    expect(calls).toBe(1);
  }
});
it("primitive local identifiers and direct participant/session scope guards precede authority reads", () => {
  const x = wireWorld();
  let calls = 0;
  for (const key of ["transportAuthority", "connectionId"]) for (const value of [1, true]) {
    expect(() => wire.bindTp1Profile({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local: { ...x.local, [key]: value }, readAuthority: () => { calls++; return null; } } as any)).toThrowError(expect.objectContaining({ code: "tp1_local_binding_invalid" }));
  }
  expect(calls).toBe(0);
  const before = x.reads();
  for (const [participants, session] of [ [[x.buyer.claim, x.seller.claim], "bad-job"], [[], JOB], [[x.buyer.claim], JOB], [[x.buyer.claim, x.buyer.claim], JOB], [["not-a-claim", x.seller.claim], JOB], [[x.buyer.claim], null], [[x.buyer.claim, x.seller.claim], "dacs-seller-discovery/v1"] ] as const) {
    expect(() => wire.assertTp1Authority(x.binding, x.local, participants, session)).toThrowError(expect.objectContaining({ code: "tp1_participant_profile_mismatch", status: 500 }));
  }
  expect(x.reads()).toBe(before);
  expect(() => wire.assertTp1Authority(x.binding, x.local, [x.buyer.claim, x.seller.claim], JOB)).not.toThrow();
  expect(x.reads()).toBe(before + 1);
});

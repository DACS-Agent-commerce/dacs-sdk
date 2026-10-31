import { expect, it } from "vitest";
import { isListing, readListingArtifact } from "../../src/artifacts/validators.js";
import { fixtureBinder } from "./authorityFixture.js";
import * as wire from "../../src/wire/index.js";
import { commitmentReceiptTime } from "../../src/wire/commitment.js";
import { fixedParty, received, signedAgreement, tp1Listing, wireCommitment } from "./commitmentFixture.js";

const buyer = fixedParty(91), seller = fixedParty(92);
const JOB = "01K7FZ8Q9W3V5T2R1N0M8K6J4H";
const NOW = Date.UTC(2026, 9, 18);
const baseline = tp1Listing({ seller });
async function purchase(listing = baseline) {
  const signed = signedAgreement({ buyer, seller, jobId: JOB, listingPin: listing.pin, listing: baseline });
  const commitment = wireCommitment({ buyer: buyer.claim, seller, jobId: JOB, agreementHash: signed.agreementHash, listingPin: listing.pin, committedAt: NOW - 5000 });
  const binding = await fixtureBinder(wire)({ record: wire.TP1_APPROVED_IDENTITY_RECORD,
    local: { endpoint: "https://rpc.profile.invalid/", transportAuthority: "test", connectionId: "1" } });
  return { signed, commitment, scope: { seller: seller.claim, listingPin: listing.pin, now: NOW, binding,
    request: { jobId: JOB, agreementHash: signed.agreementHash, buyer: buyer.claim } } };
}

it.each(["rate", "vet-credentials"])("refuses an additional %s phase before consulting the receipt reader", async (kind) => {
  const listing = tp1Listing({ seller, patch: { pipeline: [...baseline.listing.pipeline, { kind }] } });
  expect(isListing(listing.listing)).toBe(true);
  const p = await purchase(listing);
  let reads = 0;
  await expect(Promise.resolve().then(async () => await commitmentReceiptTime(received(p.commitment), received(p.signed.agreement), received(listing.listing), Object.assign(() => { reads++; return "valid"; }, { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }), p.scope))).rejects
    .toThrowError(expect.objectContaining({ code: "continuation_phase_unsupported", status: 500 }));
  expect(reads).toBe(0);
});

it.each(["demos:mainnet", "ethereum:sepolia"])("refuses a structurally valid receipt on %s before consulting its reader", async (substrate) => {
  const p = await purchase();
  let reads = 0;
  const commitment = { ...p.commitment, anchorReceipt: { ...p.commitment.anchorReceipt, substrate } };
  await expect(Promise.resolve().then(async () => await commitmentReceiptTime(received(commitment), received(p.signed.agreement), received(baseline.listing), Object.assign(() => { reads++; return "valid"; }, { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }), p.scope))).rejects
    .toThrowError(expect.objectContaining({ code: "continuation_commitment_invalid", status: 500 }));
  expect(reads).toBe(0);
});

it("retains the TP-1 four-phase Listing and testnet receipt", async () => {
  const p = await purchase();
  expect(await commitmentReceiptTime(received(p.commitment), received(p.signed.agreement), received(baseline.listing), Object.assign(() => "valid", { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }), p.scope)).toBe(NOW - 5000);
});

it("accepts the SDK reader's normative Listing with an authorized secondary signer", async () => {
  const secondary = fixedParty(93);
  const identity = baseline.listing.seller.identity;
  const listing = tp1Listing({ seller: secondary, patch: { seller: { ...baseline.listing.seller,
    identity: { ...identity, claims: [...identity.claims, { ref: secondary.claim }] } } } });
  expect(readListingArtifact(listing.listing)?.compatibility).toBe("normative");
  expect(isListing(listing.listing)).toBe(true);
  const p = await purchase(listing);
  expect(await commitmentReceiptTime(received(p.commitment), received(p.signed.agreement), received(listing.listing), Object.assign(() => "valid", { chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity }), p.scope)).toBe(NOW - 5000);
});

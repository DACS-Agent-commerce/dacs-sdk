import { expect, it } from "vitest";
import * as wire from "../../src/wire/index.js";
import { fixtureBinder } from "./authorityFixture.js";
import { fixedParty, received, signedAgreement, tp1Listing, wireCommitment } from "./commitmentFixture.js";
import { registerDiscoverySigner, signRequestWithProof } from "./requestFixture.js";

it.each(wire.CONTINUING_PATHS)("the default fixture proof matches the signed Listing on %s", async (path) => {
  const now = Date.UTC(2026, 9, 14, 12), jobId = "01K7FZ8Q9W3V5T2R1N0M8K6J4H";
  const buyer = fixedParty(41), seller = fixedParty(42);
  registerDiscoverySigner(seller);
  const listing = tp1Listing({ seller });
  const { agreement, agreementHash } = signedAgreement({ buyer, seller, jobId, listingPin: listing.pin, listing, generatedAt: now - 120_000 });
  const commitment = wireCommitment({ seller, buyer: buyer.claim, jobId, agreementHash, listingPin: listing.pin, committedAt: now - 60_000 });
  const binding = await fixtureBinder(wire)({ record: wire.TP1_APPROVED_IDENTITY_RECORD,
    local: { endpoint: "https://rpc.fixture.invalid/", transportAuthority: "test", connectionId: "fixture" } });
  const signed = await signRequestWithProof({ signer: buyer, binding, local: binding.local, path, jobId, text: "{}", seller: seller.claim,
    job: { listingPin: listing.pin, agreementHash, profile: binding.profile }, now,
    commitment: received(commitment), agreement: received(agreement), signedListing: received(listing.listing) });
  const opened = await wire.openWireEnvelope(signed.header, "request", { binding, local: binding.local, purchaseProfile: binding.profile });
  expect(opened.payload).toEqual(signed.payload);
  expect(opened.payload.path).toBe(path);
});

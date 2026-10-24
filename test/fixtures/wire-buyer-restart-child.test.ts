import * as wireValidate from "../../src/wire/validate.js";
import { it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import * as wire from "../../src/wire/index.js";
import { isListing } from "../../src/artifacts/validators.js";
import { isCanonicalJobId } from "../../src/negotiate/jobId.js";
import { ed25519Sign, privateKeyFromSeed } from "../../src/crypto/ed25519.js";
import { fixtureBinder } from "../wire/authorityFixture.js";
import { BUYER_SEED } from "../wire/committedPurchaseFixture.js";
import { readFixtureListingEligibility } from "../wire/listingEligibilityFixture.js";

const inputPath = process.env.DACS_BUYER_RESTART_INPUT;
it.skipIf(inputPath === undefined)("rebuilds buyer authority solely from retained bytes", async () => {
  const outputPath = process.env.DACS_BUYER_RESTART_OUTPUT;
  if (inputPath === undefined || outputPath === undefined) throw new Error("isolated buyer paths missing");
  const input: unknown = JSON.parse(readFileSync(inputPath, "utf8"));
  if (!wireValidate.isRecord(input) || !wireValidate.isUint(input.now) || !wireValidate.isRecord(input.listing) || !wireValidate.isRecord(input.request) ||
      !wireValidate.isClaim(input.listing.seller) || !wire.isPublicEndpoint(input.listing.publicEndpoint) || !wireValidate.isListingPin(input.listing.listingPin) ||
      !isCanonicalJobId(input.request.jobId) || !wireValidate.isHash(input.request.agreementHash) || !wireValidate.isClaim(input.request.buyer) || typeof input.request.path !== "string" ||
      typeof input.discovery !== "string" || typeof input.commitment !== "string" || typeof input.agreement !== "string" || typeof input.signedListing !== "string" || typeof input.nonce !== "string") {
    throw new Error("invalid isolated buyer fixture");
  }
  const listing = { seller: input.listing.seller, publicEndpoint: input.listing.publicEndpoint, listingPin: input.listing.listingPin };
  const request = { jobId: input.request.jobId, agreementHash: input.request.agreementHash, buyer: input.request.buyer, path: input.request.path };
  const binding = await fixtureBinder(wire)({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local: input.local });
  const local = binding.local, now = input.now, evidence = { commitment: Buffer.from(input.commitment), agreement: Buffer.from(input.agreement), signedListing: Buffer.from(input.signedListing) };
  const signedListing = wire.admitWireArtifact(evidence.signedListing);
  if (!isListing(signedListing)) throw new Error("invalid retained Listing");
  const endpointProof = await wire.verifyEndpointProof(Buffer.from(input.discovery), { binding, local, now, listing, request, ...evidence,
    readCommitmentReceipt: Object.assign(() => "valid", { chainIdentity: binding.profile.chainIdentity }),
    readListingEligibility: (scope) => ({ ...readFixtureListingEligibility(scope), notBefore: signedListing.validity.notBefore,
      expiresAt: signedListing.validity.notAfter ?? Number.MAX_SAFE_INTEGER }) });
  let calls = 0;
  const signer = { claim: request.buyer, sign: (bytes: Uint8Array) => { calls++; return ed25519Sign(bytes, privateKeyFromSeed(BUYER_SEED)); } };
  const result = await wire.signWireRequest({ signer, binding, local, now, ...request, seller: listing.seller, publicEndpoint: listing.publicEndpoint,
    endpointProof, text: "{}", nonce: input.nonce, ...evidence,
    job: { listingPin: listing.listingPin, agreementHash: request.agreementHash, profile: binding.profile } });
  writeFileSync(outputPath, JSON.stringify({ pid: process.pid, header: result.header, calls }), { flag: "wx" });
});

import { describe, expect, test } from "vitest";

import { encodeAddressSegment, sha256Hex } from "../../src/canonical/index.js";
import { generateCanonicalJobId } from "../../src/index.js";
import { sellerFulfilmentVetRequirementsViolation } from "../../src/seller/index.js";

// The seller-side pre-signature check runs the delivery runner's own
// invocation predicate (isSellerFulfilmentVetInvocationMismatch), so an
// invocation set the runner refuses after payment is refused before signing.
describe("sellerFulfilmentVetRequirementsViolation", () => {
  const jobId = generateCanonicalJobId();
  const buyerClaim = `did:demos:agent:${"b1".repeat(32)}`;
  const sellerClaim = `did:demos:agent:${"5e".repeat(32)}`;
  const recordRef = (party: string, verifier: string) => ({
    anchor: { kind: "storage-program" as const, locator: `dacs2:composite:${jobId}:${encodeAddressSegment(party)}` },
    contentHash: sha256Hex(`TEST vet record:${party}`),
    signer: verifier,
  });
  const buyer = { primaryClaim: buyerClaim, vetRecordRef: recordRef(buyerClaim, sellerClaim) };
  const seller = { primaryClaim: sellerClaim, vetRecordRef: recordRef(sellerClaim, buyerClaim) };
  const buyerRequirement = { requirementVersion: "1", required: [], preferredPresentation: "any" };
  const invocation = (party: typeof buyer, verifier: string, requirement: unknown = buyerRequirement) => ({
    vetRecordRef: structuredClone(party.vetRecordRef), evaluatedParty: party.primaryClaim,
    requirement: structuredClone(requirement), verifier, freshness: [], dealSpecific: [],
  });
  const valid = [invocation(buyer, sellerClaim), invocation(seller, buyerClaim)];
  const check = (vetRequirements: unknown) =>
    sellerFulfilmentVetRequirementsViolation(vetRequirements, { jobId, buyer, seller, buyerRequirement });

  test("accepts one invocation per party record that the delivery runner accepts", () => {
    expect(check(valid)).toBeNull();
  });

  test.each([
    ["not an array", { buyer: valid[0] }, /strict audit-source shape/],
    ["no invocation", [], /exactly one per party Vet record/],
    ["one record without its invocation", [valid[0]], /exactly one per party Vet record/],
    ["the same invocation twice", [valid[0], structuredClone(valid[0])], /exactly one per party Vet record/],
    ["an extra key", [{ ...valid[0], extra: true }, valid[1]], /strict audit-source shape/],
    ["the buyer as verifier of its own record", [invocation(buyer, buyerClaim), valid[1]], /differs from its party/],
    ["another buyer requirement", [invocation(buyer, sellerClaim, { ...buyerRequirement, preferredPresentation: "per-claim" }), valid[1]], /differs from its party/],
    ["a required claim no result covers", [valid[0], invocation(seller, buyerClaim, { ...buyerRequirement, required: [{ scheme: "test-claim", verificationRequired: true }] })], /differs from its party/],
  ])("refuses %s", (_label, vetRequirements, reason) => {
    expect(check(vetRequirements)).toMatch(reason);
  });

  test("refuses distinct party references that share one content hash", () => {
    const shared = { ...seller, vetRecordRef: { ...seller.vetRecordRef, contentHash: buyer.vetRecordRef.contentHash } };
    expect(sellerFulfilmentVetRequirementsViolation([valid[0], invocation(shared, buyerClaim)], { jobId, buyer, seller: shared, buyerRequirement }))
      .toMatch(/share one content hash/);
  });
});

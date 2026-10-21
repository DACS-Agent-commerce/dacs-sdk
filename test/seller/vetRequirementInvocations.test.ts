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

  test("answers a refusal for a shape it does not take, and never throws", () => {
    expect(() => check({ buyer: valid[0] })).not.toThrow();
    expect(() => check(null)).not.toThrow();
  });

  test("refuses one Vet reference named for two different party identities", () => {
    const sameRef = { ...seller, vetRecordRef: structuredClone(buyer.vetRecordRef) };
    expect(sellerFulfilmentVetRequirementsViolation(valid, { jobId, buyer, seller: sameRef, buyerRequirement }))
      .toMatch(/^one Vet record cannot represent different authenticated party identities$/);
  });

  test.each([
    ["buyer", "a reference with no storage-program anchor", { vetRecordRef: { ...buyer.vetRecordRef, anchor: { kind: "TEST-other", locator: "TEST" } } }],
    ["buyer", "a reference with no content hash", { vetRecordRef: { anchor: buyer.vetRecordRef.anchor, signer: sellerClaim } }],
    ["buyer", "an empty claim", { primaryClaim: "" }],
    ["seller", "a reference that is not one", { vetRecordRef: "TEST-not-a-reference" }],
    ["seller", "an empty claim", { primaryClaim: "" }],
  ] as const)("refuses a %s party with %s, with a reason that is not empty", (role, _label, change) => {
    const parties = { buyer, seller, [role]: { ...(role === "buyer" ? buyer : seller), ...change } };
    const reason = sellerFulfilmentVetRequirementsViolation(valid, { jobId, ...parties, buyerRequirement } as never);
    expect(reason).toBe(`the ${role} Vet reference or claim is malformed`);
  });

  test("refuses distinct party references that share one content hash", () => {
    const shared = { ...seller, vetRecordRef: { ...seller.vetRecordRef, contentHash: buyer.vetRecordRef.contentHash } };
    expect(sellerFulfilmentVetRequirementsViolation([valid[0], invocation(shared, buyerClaim)], { jobId, buyer, seller: shared, buyerRequirement }))
      .toMatch(/share one content hash/);
  });
});

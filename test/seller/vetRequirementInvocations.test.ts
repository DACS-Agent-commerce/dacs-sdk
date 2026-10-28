import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";

import type { AttestationRef, BundleRequirement, ClaimRequirement } from "../../src/artifacts/index.js";
import { canonicalize, encodeAddressSegment, sha256Hex } from "../../src/canonical/index.js";
import { generateCanonicalJobId } from "../../src/index.js";
import {
  isSellerFulfilmentVetInvocationMismatch,
  sellerFulfilmentVetRequirementsViolation,
  type SellerFulfilmentExpectedVerifyResult,
  type SellerFulfilmentVetRequirementInvocation,
} from "../../src/seller/index.js";

// The seller-side pre-signature check runs the delivery runner's own
// invocation predicate (isSellerFulfilmentVetInvocationMismatch), so an
// invocation mismatch is refused before signing; session roster authentication
// (including shared bundle hashes and orchestrator bindings) remains separate.
describe("sellerFulfilmentVetRequirementsViolation", () => {
  const jobId = generateCanonicalJobId({ timestamp: 1_780_000_000_000, entropy: new Uint8Array(10).fill(3) });
  const buyerClaim = `did:demos:agent:${"b1".repeat(32)}`;
  const sellerClaim = `did:demos:agent:${"5e".repeat(32)}`;
  const recordRef = (party: string, verifier: string): AttestationRef => ({
    anchor: { kind: "storage-program", locator: `dacs2:composite:${jobId}:${encodeAddressSegment(party)}` },
    contentHash: sha256Hex(`TEST vet record:${party}`),
    signer: verifier,
  });
  const buyer = { primaryClaim: buyerClaim, vetRecordRef: recordRef(buyerClaim, sellerClaim) };
  const seller = { primaryClaim: sellerClaim, vetRecordRef: recordRef(sellerClaim, buyerClaim) };
  const buyerRequirement: BundleRequirement = { requirementVersion: "1", required: [], preferredPresentation: "any" };
  const invocation = (
    party: typeof buyer,
    verifier: string,
    requirement: BundleRequirement = buyerRequirement,
  ): SellerFulfilmentVetRequirementInvocation => ({
    vetRecordRef: structuredClone(party.vetRecordRef), evaluatedParty: party.primaryClaim,
    requirement: structuredClone(requirement), verifier, freshness: [], dealSpecific: [],
  });
  const valid: [SellerFulfilmentVetRequirementInvocation, SellerFulfilmentVetRequirementInvocation] =
    [invocation(buyer, sellerClaim), invocation(seller, buyerClaim)];
  const check = (vetRequirements: unknown, requirement: unknown = buyerRequirement) =>
    sellerFulfilmentVetRequirementsViolation(vetRequirements, {
      jobId, buyer, seller, buyerRequirement: requirement,
    });
  const expectedResult = (
    requirement: ClaimRequirement,
    identifier = "test:claim",
    sourceJobId = jobId,
  ): SellerFulfilmentExpectedVerifyResult => {
    const recipeVersion = requirement.recipeVersion ?? 2;
    return {
      ref: {
        anchor: {
          kind: "storage-program",
          locator: `dacs2:${sourceJobId}:${requirement.scheme}:${encodeAddressSegment(identifier)}:v${recipeVersion}`,
        },
        contentHash: sha256Hex(`TEST result:${sourceJobId}:${identifier}:${canonicalize(requirement)}`),
        recipeVersion,
      },
      sourceJobId,
      scheme: requirement.scheme,
      identifier,
      method: "self-signed",
      requirement: structuredClone(requirement),
    };
  };
  const requiredClaim: ClaimRequirement = {
    scheme: "test-claim", verificationRequired: true, recipeVersion: 2,
    parameters: { audience: "first" },
  };

  test("uses a reproducible job ID for every fixture reference", () => {
    expect(jobId).toBe(generateCanonicalJobId({ timestamp: 1_780_000_000_000, entropy: new Uint8Array(10).fill(3) }));
  });

  test("refuses oversized invocation lists before inspecting members", () => {
    const inspect = vi.spyOn(Object, "getOwnPropertyDescriptor");
    try {
      expect(check([valid[0], valid[1], structuredClone(valid[0])])).not.toBeNull();
      expect(inspect.mock.calls.some(([value]) => value === valid[0])).toBe(false);
    } finally {
      inspect.mockRestore();
    }
  });

  test.each([120, 121])("reserves the audit-source envelope depth for %i nested parameter wrappers", (wrappers) => {
    let parameters: Record<string, unknown> = {};
    for (let depth = 0; depth < wrappers; depth += 1) parameters = { child: parameters };
    const claim = { ...requiredClaim, parameters };
    const requirement = { ...buyerRequirement, required: [claim] };
    const entry = invocation(buyer, sellerClaim, requirement);
    entry.freshness = [expectedResult(claim)];
    const entries = [entry, valid[1]];
    if (wrappers === 120) {
      expect(() => canonicalize({ artifacts: { vetRequirements: entries } })).not.toThrow();
      expect(check(entries, requirement)).toBeNull();
    } else {
      expect(() => canonicalize({ artifacts: { vetRequirements: entries } })).toThrow();
      expect(check(entries, requirement)).not.toBeNull();
    }
  });

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

  test.each([
    ["a sparse invocation list", (entries: typeof valid) => { Reflect.deleteProperty(entries, "1"); }],
    ["an extra array property", (entries: typeof valid) => { Object.defineProperty(entries, "extra", { value: true, enumerable: true }); }],
    ["a non-NFC seller requirement", (entries: typeof valid) => { Object.defineProperty(entries[1].requirement, "extension", { value: "e\u0301", enumerable: true }); }],
    ["a bigint seller requirement", (entries: typeof valid) => { Object.defineProperty(entries[1].requirement, "extension", { value: 1n, enumerable: true }); }],
    ["an overly deep seller requirement", (entries: typeof valid) => {
      let value: Record<string, unknown> = {};
      for (let depth = 0; depth < 129; depth += 1) value = { child: value };
      Object.defineProperty(entries[1].requirement, "extension", { value, enumerable: true });
    }],
    ["a throwing accessor", (entries: typeof valid) => {
      Object.defineProperty(entries[1], "evaluatedParty", { enumerable: true, get() { throw new Error("TEST accessor must not run"); } });
    }],
  ] as const)("refuses %s before structural traversal", (_label, mutate) => {
    const entries = structuredClone(valid);
    mutate(entries);
    expect(check(entries)).toMatch(/.+/);
  });

  test.each(["buyer", "seller"] as const)("refuses a noncanonical %s party reference before normalization", (role) => {
    const party = structuredClone(role === "buyer" ? buyer : seller);
    expect(party.vetRecordRef.anchor.locator).toContain("K");
    party.vetRecordRef.anchor.locator = party.vetRecordRef.anchor.locator.replace("K", "\u212a");
    expect(sellerFulfilmentVetRequirementsViolation(valid, {
      jobId, buyer, seller, [role]: party, buyerRequirement,
    })).toBe(`the ${role} Vet reference or claim is malformed`);
  });

  test.each(["required", "oneOf alternatives", "oneOf groups", "combined requirements",
    "freshness", "dealSpecific", "combined results"])("bounds %s before matching", (field) => {
    for (const count of [64, 65]) {
      const requirement: BundleRequirement = { ...buyerRequirement, required: [requiredClaim] };
      const entry = invocation(buyer, sellerClaim, requirement);
      entry.freshness = [expectedResult(requiredClaim)];
      if (field === "required") requirement.required = Array.from({ length: count }, () => requiredClaim);
      if (field === "oneOf alternatives") requirement.oneOf = [Array.from({ length: count - 1 }, () => requiredClaim)];
      if (field === "oneOf groups") requirement.oneOf = Array.from({ length: count - 1 }, () => [requiredClaim]);
      if (field === "combined requirements") {
        requirement.required = Array.from({ length: 32 }, () => requiredClaim);
        requirement.oneOf = [Array.from({ length: count - 32 }, () => requiredClaim)];
      }
      entry.requirement = structuredClone(requirement);
      if (field.includes("results") || field === "freshness" || field === "dealSpecific") {
        const results = Array.from({ length: count }, (_, i) => expectedResult(requiredClaim, `test:bounded:${i}`));
        entry.freshness = field === "dealSpecific" ? [] : results;
        if (field === "dealSpecific") entry.dealSpecific = results;
        if (field === "combined results") entry.dealSpecific = entry.freshness.splice(32);
      }
      const reason = check([entry, valid[1]], requirement);
      if (count === 64) expect(reason).toBeNull();
      else expect(reason).toMatch(/limit/);
    }
  });

  test("documents the separate session-roster authentication precondition", () => {
    const source = readFileSync(new URL("../../src/seller/fulfilmentAuditSource.ts", import.meta.url), "utf8");
    const start = source.indexOf("export function sellerFulfilmentVetRequirementsViolation(");
    expect(start).toBeGreaterThan(0);
    const doc = source.slice(source.lastIndexOf("/**", start), start);
    expect(doc).toContain("Authenticate the SessionRecord roster separately");
    expect(doc).toContain("bundle hashes");
    expect(doc).toContain("orchestrator");
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

  test("requires exact coverage of each required claim with the same scheme", () => {
    const secondClaim = { ...requiredClaim, parameters: { audience: "second" } };
    const requirement = { ...buyerRequirement, required: [requiredClaim, secondClaim] };
    const entry = invocation(buyer, sellerClaim, requirement);
    entry.freshness = [expectedResult(requiredClaim)];
    expect(check([entry, valid[1]], requirement)).toMatch(/differs from its party/);

    entry.freshness.push(expectedResult(secondClaim));
    expect(check([entry, valid[1]], requirement)).toBeNull();
  });

  test("accepts either exact oneOf alternative alongside a required result", () => {
    const firstAlternative = { ...requiredClaim, parameters: { audience: "alternative-one" } };
    const secondAlternative = { ...requiredClaim, parameters: { audience: "alternative-two" } };
    const requirement = {
      ...buyerRequirement,
      required: [requiredClaim],
      oneOf: [[firstAlternative, secondAlternative]],
    };
    const entry = invocation(buyer, sellerClaim, requirement);
    // This is a declared result of the same scheme, but its parameters cover
    // only the required claim. There is no unrelated provenance error.
    entry.freshness = [expectedResult(requiredClaim)];
    expect(check([entry, valid[1]], requirement)).toMatch(/differs from its party/);

    for (const alternative of [firstAlternative, secondAlternative]) {
      entry.freshness = [expectedResult(requiredClaim), expectedResult(alternative)];
      expect(check([entry, valid[1]], requirement)).toBeNull();
    }
    entry.freshness.push(expectedResult(firstAlternative));
    expect(check([entry, valid[1]], requirement)).toBeNull();
  });

  test("refuses a oneOf-only invocation with no results", () => {
    const requirement = { ...buyerRequirement, oneOf: [[requiredClaim]] };
    const entry = invocation(buyer, sellerClaim, requirement);
    expect(check([entry, valid[1]], requirement)).toMatch(/differs from its party/);
    entry.freshness = [expectedResult(requiredClaim)];
    expect(check([entry, valid[1]], requirement)).toBeNull();
  });

  // DACS-2 v0.6 forbids a synthetic VerifyResult for a presence-only claim: the
  // strict replay counts it in the authenticated bundle, so the invocation
  // carries no result for it.
  describe("presence-only claims", () => {
    const presenceClaim: ClaimRequirement = { scheme: "key", verificationRequired: false };
    const otherPresenceClaim: ClaimRequirement = { scheme: "did", verificationRequired: false };

    test("accepts a presence-only required claim that no result covers", () => {
      const requirement = { ...buyerRequirement, required: [presenceClaim] };
      expect(check([invocation(buyer, sellerClaim, requirement), valid[1]], requirement)).toBeNull();
    });

    test("accepts a oneOf group whose alternative is presence-only", () => {
      const requirement = { ...buyerRequirement, oneOf: [[presenceClaim, otherPresenceClaim]] };
      expect(check([invocation(buyer, sellerClaim, requirement), valid[1]], requirement)).toBeNull();
      const mixed = { ...buyerRequirement, oneOf: [[requiredClaim, presenceClaim]] };
      expect(check([invocation(buyer, sellerClaim, mixed), valid[1]], mixed)).toBeNull();
    });

    test("accepts a presence-only claim next to a verified claim that its result covers", () => {
      const requirement = { ...buyerRequirement, required: [presenceClaim, requiredClaim] };
      const entry = invocation(buyer, sellerClaim, requirement);
      entry.freshness = [expectedResult(requiredClaim)];
      expect(check([entry, valid[1]], requirement)).toBeNull();
    });

    test("still refuses an uncovered verified required claim next to a presence-only claim", () => {
      const requirement = { ...buyerRequirement, required: [presenceClaim, requiredClaim] };
      expect(check([invocation(buyer, sellerClaim, requirement), valid[1]], requirement))
        .toMatch(/differs from its party/);
    });

    test("still refuses a oneOf group of only uncovered verified alternatives", () => {
      const requirement = { ...buyerRequirement, required: [presenceClaim], oneOf: [[requiredClaim]] };
      expect(check([invocation(buyer, sellerClaim, requirement), valid[1]], requirement))
        .toMatch(/differs from its party/);
    });

    test("refuses a synthetic result bound to a presence-only claim", () => {
      const requirement = { ...buyerRequirement, required: [presenceClaim] };
      const entry = invocation(buyer, sellerClaim, requirement);
      entry.freshness = [expectedResult(presenceClaim)];
      expect(check([entry, valid[1]], requirement)).toMatch(/differs from its party/);
      entry.freshness = [];
      entry.dealSpecific = [expectedResult(presenceClaim)];
      expect(check([entry, valid[1]], requirement)).toMatch(/differs from its party/);
    });
  });

  test("binds the evaluated party to its authenticated claim even with a consistent locator", () => {
    const otherClaim = `did:demos:agent:${"a2".repeat(32)}`;
    const movedBuyer = { ...buyer, vetRecordRef: recordRef(otherClaim, sellerClaim) };
    const entry = invocation(movedBuyer, sellerClaim);
    entry.evaluatedParty = otherClaim;
    expect(sellerFulfilmentVetRequirementsViolation([entry, valid[1]], {
      jobId, buyer: movedBuyer, seller, buyerRequirement,
    })).toMatch(/differs from its party/);

    const authenticatedBuyer = { ...movedBuyer, primaryClaim: otherClaim };
    const authenticatedSeller = { ...seller, vetRecordRef: recordRef(sellerClaim, otherClaim) };
    expect(sellerFulfilmentVetRequirementsViolation([entry, invocation(authenticatedSeller, otherClaim)], {
      jobId, buyer: authenticatedBuyer, seller: authenticatedSeller, buyerRequirement,
    })).toBeNull();
  });

  test("does not give an orchestrator-only binding the seller's counterparty verifier", () => {
    const entry = invocation(seller, buyerClaim);
    const context = {
      jobId, buyerClaim, sellerClaim, buyerRequirement,
      bindings: new Map([[canonicalize(entry.vetRecordRef), {
        primaryClaim: sellerClaim, roles: new Set(["orchestrator"]),
      }]]),
    };
    expect(isSellerFulfilmentVetInvocationMismatch(entry, context)).toBe(true);
    context.bindings.get(canonicalize(entry.vetRecordRef))!.roles.add("seller");
    expect(isSellerFulfilmentVetInvocationMismatch(entry, context)).toBe(false);
  });

  test("retains the Listing-owned requirement for one record shared by buyer and seller", () => {
    const sharedParty = { primaryClaim: buyerClaim, vetRecordRef: recordRef(buyerClaim, buyerClaim), bundleHash: "b".repeat(64) };
    const entry = invocation(sharedParty, buyerClaim, {
      ...buyerRequirement, preferredPresentation: "per-claim",
    });
    expect(sellerFulfilmentVetRequirementsViolation([entry], {
      jobId, buyer: sharedParty, seller: sharedParty, buyerRequirement,
    })).toMatch(/differs from its party/);
  });

  test.each([
    ["different", "a".repeat(64), "b".repeat(64)],
    ["missing", undefined, undefined],
    ["malformed", "not-a-bundle-hash", "not-a-bundle-hash"],
  ])("refuses %s authenticated bundle hashes for a shared Vet record", (_label, buyerHash, sellerHash) => {
    const shared = { primaryClaim: buyerClaim, vetRecordRef: recordRef(buyerClaim, buyerClaim) };
    const entries = [invocation(shared, buyerClaim)];
    const input = { jobId, buyer: { ...shared, bundleHash: buyerHash },
      seller: { ...shared, bundleHash: sellerHash }, buyerRequirement };
    expect(sellerFulfilmentVetRequirementsViolation(entries, input))
      .toMatch(/one Vet record cannot represent different authenticated party identities/);
  });

  test.each(["ipfs", "https"] as const)("refuses a %s composite anchor with an otherwise correct locator", (kind) => {
    const party = structuredClone(buyer);
    party.vetRecordRef.anchor.kind = kind;
    expect(sellerFulfilmentVetRequirementsViolation([invocation(party, sellerClaim), valid[1]], {
      jobId, buyer: party, seller, buyerRequirement,
    })).toMatch(/differs from its party/);
  });

  test.each(["ipfs", "https"] as const)("refuses a %s result anchor with an otherwise correct locator", (kind) => {
    const requirement = { ...buyerRequirement, required: [requiredClaim] };
    const entry = invocation(buyer, sellerClaim, requirement);
    const result = expectedResult(requiredClaim);
    entry.freshness = [result];
    expect(check([entry, valid[1]], requirement)).toBeNull();
    result.ref.anchor.kind = kind;
    expect(check([entry, valid[1]], requirement)).toMatch(/differs from its party/);
  });

  test("refuses an exact repeated expected result, including across result arrays", () => {
    const requirement = { ...buyerRequirement, required: [requiredClaim] };
    const entry = invocation(buyer, sellerClaim, requirement);
    const result = expectedResult(requiredClaim);
    entry.freshness = [result, structuredClone(result)];
    expect(check([entry, valid[1]], requirement)).toMatch(/differs from its party/);
    entry.freshness.pop();
    entry.dealSpecific.push(structuredClone(result));
    expect(check([entry, valid[1]], requirement)).toMatch(/differs from its party/);
    entry.dealSpecific = [];
    expect(check([entry, valid[1]], requirement)).toBeNull();
  });

  test("refuses distinct valid result references that share one content hash", () => {
    const requirement = { ...buyerRequirement, required: [requiredClaim] };
    const entry = invocation(buyer, sellerClaim, requirement);
    const first = expectedResult(requiredClaim, "test:first");
    const second = expectedResult(requiredClaim, "test:second");
    entry.freshness = [first, second];
    expect(check([entry, valid[1]], requirement)).toBeNull();
    second.ref.contentHash = first.ref.contentHash;
    expect(check([entry, valid[1]], requirement)).toMatch(/differs from its party/);
  });

  test("refuses a result's mismatched scheme even when another result covers its requirement", () => {
    const requirement = { ...buyerRequirement, required: [requiredClaim] };
    const entry = invocation(buyer, sellerClaim, requirement);
    const extra = expectedResult(requiredClaim, "test:extra");
    entry.freshness = [expectedResult(requiredClaim), extra];
    expect(check([entry, valid[1]], requirement)).toBeNull();
    extra.scheme = "other-claim";
    extra.ref.anchor.locator = `dacs2:${jobId}:${extra.scheme}:${encodeAddressSegment(extra.identifier)}:v2`;
    expect(check([entry, valid[1]], requirement)).toMatch(/differs from its party/);
  });

  test("refuses a result's different recipe version even with a consistent result address", () => {
    const requirement = { ...buyerRequirement, required: [requiredClaim] };
    const entry = invocation(buyer, sellerClaim, requirement);
    const result = expectedResult(requiredClaim);
    entry.freshness = [result];
    expect(check([entry, valid[1]], requirement)).toBeNull();
    result.ref.recipeVersion = 3;
    result.ref.anchor.locator = `dacs2:${jobId}:${result.scheme}:${encodeAddressSegment(result.identifier)}:v3`;
    expect(check([entry, valid[1]], requirement)).toMatch(/differs from its party/);
  });

  test("accepts required coverage from this job's nonempty deal-specific results", () => {
    const requirement = { ...buyerRequirement, required: [requiredClaim] };
    const entry = invocation(buyer, sellerClaim, requirement);
    entry.dealSpecific = [expectedResult(requiredClaim)];
    expect(check([entry, valid[1]], requirement)).toBeNull();
    entry.dealSpecific = [expectedResult(requiredClaim, "test:claim", "job-previous")];
    expect(check([entry, valid[1]], requirement)).toMatch(/differs from its party/);
  });

  test("returns a nonempty refusal when the admitted requirement cannot be canonicalized", () => {
    const canonicalRequirement = { ...buyerRequirement, extension: 1 };
    expect(check([invocation(buyer, sellerClaim, canonicalRequirement), valid[1]], canonicalRequirement)).toBeNull();
    const requirement = { ...buyerRequirement, extension: 1n };
    // Exact JSON admission refuses the body before comparing the parties.
    expect(check([invocation(buyer, sellerClaim, requirement), valid[1]], requirement))
      .toMatch(/strict audit-source shape/);
  });

  test("returns a nonempty refusal without throwing for an unpaired surrogate in a party locator", () => {
    const party = structuredClone(buyer);
    party.vetRecordRef.anchor.locator += "\ud800";
    expect(sellerFulfilmentVetRequirementsViolation([invocation(party, sellerClaim), valid[1]], {
      jobId, buyer: party, seller, buyerRequirement,
    })).toBe("the Vet requirement invocations are not the strict audit-source shape");
  });

  test("returns a mismatch without throwing when the binding map has no entry", () => {
    expect(isSellerFulfilmentVetInvocationMismatch(valid[0]!, {
      jobId, buyerClaim, sellerClaim, buyerRequirement, bindings: new Map(),
    })).toBe(true);
  });

  test("accepts one matching invocation for a record and identity shared by buyer and seller", () => {
    const sharedParty = { primaryClaim: buyerClaim, vetRecordRef: recordRef(buyerClaim, buyerClaim), bundleHash: "b".repeat(64) };
    expect(sellerFulfilmentVetRequirementsViolation([invocation(sharedParty, buyerClaim)], {
      jobId, buyer: sharedParty, seller: sharedParty, buyerRequirement,
    })).toBeNull();
  });
});

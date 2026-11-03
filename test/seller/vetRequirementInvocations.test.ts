import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";

import type { AttestationRef, BundleRequirement, ClaimRequirement } from "../../src/artifacts/index.js";
import { canonicalize, encodeAddressSegment, sha256Hex } from "../../src/canonical/index.js";
import { generateCanonicalJobId } from "../../src/index.js";
import {
  SELLER_FULFILMENT_VET_MODES,
  isSellerFulfilmentVetInvocationMismatch,
  sellerFulfilmentVetModeOf,
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
  const check = (vetRequirements: unknown, requirement: unknown = buyerRequirement, acceptsPresenceOnly?: true) =>
    sellerFulfilmentVetRequirementsViolation(vetRequirements, {
      jobId, buyer, seller, buyerRequirement: requirement, acceptsPresenceOnly,
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

    test.each(["buyer", "seller"] as const)("default check refuses every %s presence placement, including an unused alternative", (party) => {
      for (const requirement of [
        { ...buyerRequirement, required: [presenceClaim] },
        { ...buyerRequirement, oneOf: [[presenceClaim]] },
        { ...buyerRequirement, required: [presenceClaim, requiredClaim] },
        { ...buyerRequirement, oneOf: [[presenceClaim, requiredClaim]] },
      ]) {
        const entry = invocation(party === "buyer" ? buyer : seller, party === "buyer" ? sellerClaim : buyerClaim, requirement);
        if (requirement.required.some(member => member.verificationRequired) ||
            requirement.oneOf?.flat().some(member => member.verificationRequired)) entry.freshness = [expectedResult(requiredClaim)];
        const entries = party === "buyer" ? [entry, valid[1]] : [valid[0], entry];
        const listingRequirement = party === "buyer" ? requirement : buyerRequirement;
        expect(check(entries, listingRequirement)).toMatch(/presence-only/);
        expect(check(entries, listingRequirement, true)).toBeNull();
      }
    });

    test("accepts a presence-only required claim that no result covers", () => {
      const requirement = { ...buyerRequirement, required: [presenceClaim] };
      expect(check([invocation(buyer, sellerClaim, requirement), valid[1]], requirement, true)).toBeNull();
    });

    test("accepts a oneOf group whose alternative is presence-only", () => {
      const requirement = { ...buyerRequirement, oneOf: [[presenceClaim, otherPresenceClaim]] };
      expect(check([invocation(buyer, sellerClaim, requirement), valid[1]], requirement, true)).toBeNull();
      const mixed = { ...buyerRequirement, oneOf: [[requiredClaim, presenceClaim]] };
      expect(check([invocation(buyer, sellerClaim, mixed), valid[1]], mixed, true)).toBeNull();
    });

    test("accepts a presence-only claim next to a verified claim that its result covers", () => {
      const requirement = { ...buyerRequirement, required: [presenceClaim, requiredClaim] };
      const entry = invocation(buyer, sellerClaim, requirement);
      entry.freshness = [expectedResult(requiredClaim)];
      expect(check([entry, valid[1]], requirement, true)).toBeNull();
    });

    test("still refuses an uncovered verified required claim next to a presence-only claim", () => {
      const requirement = { ...buyerRequirement, required: [presenceClaim, requiredClaim] };
      expect(check([invocation(buyer, sellerClaim, requirement), valid[1]], requirement, true))
        .toMatch(/differs from its party/);
    });

    test("still refuses a oneOf group of only uncovered verified alternatives", () => {
      const requirement = { ...buyerRequirement, required: [presenceClaim], oneOf: [[requiredClaim]] };
      expect(check([invocation(buyer, sellerClaim, requirement), valid[1]], requirement, true))
        .toMatch(/differs from its party/);
    });

    test("refuses a synthetic result bound to a presence-only claim", () => {
      const requirement = { ...buyerRequirement, required: [presenceClaim] };
      const entry = invocation(buyer, sellerClaim, requirement);
      entry.freshness = [expectedResult(presenceClaim)];
      expect(check([entry, valid[1]], requirement, true)).toMatch(/differs from its party/);
      entry.freshness = [];
      entry.dealSpecific = [expectedResult(presenceClaim)];
      expect(check([entry, valid[1]], requirement, true)).toMatch(/differs from its party/);
    });

    // DACS-1 PCR-1/PCR-2: a presence-only member names a registered scheme and
    // selects no freshness or recipe field. Counting coverage without that
    // preflight would let an invalid requirement reach delivery.
    test.each([
      ["an unregistered scheme", { scheme: "bogus", verificationRequired: false }],
      ["a freshness selection", { scheme: "did", verificationRequired: false, maxAge: 30 }],
      ["a recipe selection", { scheme: "did", verificationRequired: false, recipeVersion: 1 }],
    ])("refuses a presence-only claim with %s in required and oneOf", (_label, invalid) => {
      for (const requirement of [
        { ...buyerRequirement, required: [invalid] },
        { ...buyerRequirement, required: [], oneOf: [[invalid]] },
        { ...buyerRequirement, required: [presenceClaim], oneOf: [[invalid]] },
      ]) {
        expect(check([invocation(buyer, sellerClaim, requirement), valid[1]], requirement, true))
          .toMatch(/differs from its party/);
      }
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

  describe("TP-1 G3 orchestrator Vet mode", () => {
    const orchestrator = SELLER_FULFILMENT_VET_MODES.tp1G3Orchestrator;
    const counterparty = SELLER_FULFILMENT_VET_MODES.counterparty;
    const sellerSigned = { primaryClaim: sellerClaim, vetRecordRef: recordRef(sellerClaim, sellerClaim) };
    const sellerSignedPair: [SellerFulfilmentVetRequirementInvocation, SellerFulfilmentVetRequirementInvocation] =
      [invocation(buyer, sellerClaim), invocation(sellerSigned, sellerClaim)];
    const checkIn = (
      vetRequirements: unknown,
      vetMode: unknown,
      parties: { buyer: typeof buyer; seller: typeof buyer } = { buyer, seller: sellerSigned },
    ) => sellerFulfilmentVetRequirementsViolation(vetRequirements, {
      jobId, ...parties, buyerRequirement, vetMode,
    } as Parameters<typeof sellerFulfilmentVetRequirementsViolation>[1]);
    const withoutSigner = (party: typeof buyer): typeof buyer => {
      const { signer: _signer, ...ref } = party.vetRecordRef;
      return { ...party, vetRecordRef: ref };
    };

    test("counterparty mode accepts the buyer as verifier of the seller's record (K3-V1)", () => {
      expect(checkIn(valid, counterparty, { buyer, seller })).toBeNull();
    });

    test("counterparty mode refuses the seller as verifier of its own record (K3-V2)", () => {
      expect(checkIn(sellerSignedPair, counterparty)).toMatch(/differs from its party/);
    });

    test("orchestrator mode accepts the seller as verifier of its own record (K3-V3)", () => {
      expect(checkIn(sellerSignedPair, orchestrator)).toBeNull();
    });

    test("orchestrator mode refuses the buyer as verifier of the seller's record (K3-V4)", () => {
      expect(checkIn(valid, orchestrator, { buyer, seller })).toMatch(/differs from its party/);
    });

    test("both modes accept the seller and refuse the buyer as verifier of the buyer's record (K3-V5)", () => {
      const buyerSigned = { ...buyer, vetRecordRef: recordRef(buyerClaim, buyerClaim) };
      for (const [mode, entries, parties] of [
        [counterparty, valid, { buyer, seller }],
        [orchestrator, sellerSignedPair, { buyer, seller: sellerSigned }],
      ] as const) {
        expect(checkIn(entries, mode, parties)).toBeNull();
        expect(checkIn([invocation(buyerSigned, buyerClaim), entries[1]], mode, { ...parties, buyer: buyerSigned }))
          .toMatch(/differs from its party/);
      }
    });

    test("orchestrator mode requires the reference signer and refuses one that differs from the verifier", () => {
      expect(checkIn(sellerSignedPair, orchestrator)).toBeNull();
      const unsignedSeller = withoutSigner(sellerSigned);
      const unsignedBuyer = withoutSigner(buyer);
      expect(checkIn([invocation(buyer, sellerClaim), invocation(unsignedSeller, sellerClaim)], orchestrator,
        { buyer, seller: unsignedSeller })).toMatch(/differs from its party/);
      expect(checkIn([invocation(unsignedBuyer, sellerClaim), invocation(sellerSigned, sellerClaim)], orchestrator,
        { buyer: unsignedBuyer, seller: sellerSigned })).toMatch(/differs from its party/);
      const otherSigner = { ...sellerSigned, vetRecordRef: recordRef(sellerClaim, buyerClaim) };
      expect(checkIn([invocation(buyer, sellerClaim), invocation(otherSigner, sellerClaim)], orchestrator,
        { buyer, seller: otherSigner })).toMatch(/differs from its party/);
      expect(checkIn([invocation(buyer, sellerClaim), invocation(unsignedSeller, buyerClaim)], counterparty,
        { buyer, seller: unsignedSeller })).toBeNull();
    });

    test("an absent Vet mode answers exactly as the counterparty value on every fixture in this file", () => {
      const scenarios: Array<[unknown, { buyer: typeof buyer; seller: typeof buyer }]> = [
        [valid, { buyer, seller }],
        [sellerSignedPair, { buyer, seller: sellerSigned }],
        [[invocation(buyer, buyerClaim), valid[1]], { buyer, seller }],
        [[valid[0]], { buyer, seller }],
      ];
      for (const [entries, parties] of scenarios) {
        expect(checkIn(entries, undefined, parties)).toBe(checkIn(entries, counterparty, parties));
        expect(sellerFulfilmentVetRequirementsViolation(entries, { jobId, ...parties, buyerRequirement }))
          .toBe(checkIn(entries, counterparty, parties));
      }
    });

    test("an unsupported Vet mode is refused, never read as a default (\"TP1-G3-ORCHESTRATOR\", \"tp1-g3\", \"\", 1, null, {})", () => {
      const entry = valid[1];
      for (const mode of ["TP1-G3-ORCHESTRATOR", "tp1-g3", "", 1, null, {}]) {
        expect(checkIn(valid, mode, { buyer, seller })).toBe("the Vet mode is not a supported fulfilment Vet mode");
        expect(isSellerFulfilmentVetInvocationMismatch(entry, {
          jobId, buyerClaim, sellerClaim, buyerRequirement, vetMode: mode as never,
          bindings: new Map([[canonicalize(entry.vetRecordRef), { primaryClaim: sellerClaim, roles: new Set(["seller"]) }]]),
        })).toBe(true);
      }
    });

    test("a vetMode member inside an invocation, reference or requirement never selects the orchestrator mode", () => {
      for (const place of ["invocation", "vetRecordRef", "requirement"] as const) {
        const entries = structuredClone(sellerSignedPair);
        Object.assign(place === "invocation" ? entries[1] : entries[1][place], { vetMode: orchestrator });
        expect(checkIn(entries, undefined)).not.toBeNull();
        expect(checkIn(entries, counterparty)).not.toBeNull();
        expect(isSellerFulfilmentVetInvocationMismatch(entries[1], {
          jobId, buyerClaim, sellerClaim, buyerRequirement,
          bindings: new Map([[canonicalize(entries[1].vetRecordRef), { primaryClaim: sellerClaim, roles: new Set(["seller"]) }]]),
        })).toBe(true);
      }
    });

    test("orchestrator mode keeps the shared-record, orchestrator-only and canonical-address rules (JOB2 locator refused)", () => {
      const shared = { primaryClaim: buyerClaim, vetRecordRef: recordRef(buyerClaim, buyerClaim), bundleHash: "b".repeat(64) };
      expect(sellerFulfilmentVetRequirementsViolation([invocation(shared, buyerClaim)], {
        jobId, buyer: shared, seller: shared, buyerRequirement, vetMode: orchestrator,
      })).toBeNull();
      expect(sellerFulfilmentVetRequirementsViolation([invocation(shared, buyerClaim)], {
        jobId, buyer: shared, seller: shared,
        buyerRequirement: { ...buyerRequirement, preferredPresentation: "per-claim" }, vetMode: orchestrator,
      })).toMatch(/differs from its party/);

      const entry = invocation(sellerSigned, sellerClaim);
      const orchestratorOnly = {
        jobId, buyerClaim, sellerClaim, buyerRequirement,
        bindings: new Map([[canonicalize(entry.vetRecordRef), { primaryClaim: sellerClaim, roles: new Set(["orchestrator"]) }]]),
        vetMode: orchestrator,
      };
      expect(isSellerFulfilmentVetInvocationMismatch(entry, orchestratorOnly)).toBe(true);

      const otherJobId = generateCanonicalJobId({ timestamp: 1_780_000_000_001, entropy: new Uint8Array(10).fill(4) });
      const foreign = structuredClone(sellerSigned);
      foreign.vetRecordRef.anchor.locator =
        `dacs2:composite:${otherJobId}:${encodeAddressSegment(sellerClaim)}`;
      expect(checkIn([invocation(buyer, sellerClaim), invocation(foreign, sellerClaim)], orchestrator,
        { buyer, seller: foreign })).toMatch(/differs from its party/);
    });

    test("documents both Vet modes and names the expected verifier in the refusal reason", () => {
      const source = readFileSync(new URL("../../src/seller/fulfilmentAuditSource.ts", import.meta.url), "utf8");
      const start = source.indexOf("export function isSellerFulfilmentVetInvocationMismatch(");
      const doc = source.slice(source.lastIndexOf("/**", start), start);
      expect(doc).toContain(orchestrator);
      expect(doc).toContain(counterparty);
      const reason = checkIn(valid, orchestrator, { buyer, seller });
      expect(reason).toContain("expected verifier");
      expect(reason).not.toContain("counterparty verifier");
    });

    test("exports frozen Vet mode names and resolves option values with sellerFulfilmentVetModeOf", () => {
      expect(Object.isFrozen(SELLER_FULFILMENT_VET_MODES)).toBe(true);
      expect(SELLER_FULFILMENT_VET_MODES).toEqual({ counterparty: "counterparty", tp1G3Orchestrator: "tp1-g3-orchestrator" });
      expect(sellerFulfilmentVetModeOf(undefined)).toBe("counterparty");
      expect(sellerFulfilmentVetModeOf("counterparty")).toBe("counterparty");
      expect(sellerFulfilmentVetModeOf("tp1-g3-orchestrator")).toBe("tp1-g3-orchestrator");
      for (const bad of ["TP1-G3-ORCHESTRATOR", "tp1-g3", "", 1, null, {}]) {
        expect(sellerFulfilmentVetModeOf(bad)).toBeNull();
      }
    });
  });
});

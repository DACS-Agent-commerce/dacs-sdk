import { describe, expect, test } from "vitest";

import {
  assessRegistryGovernanceDisclosure,
  classifyRecipeAnchoringPhase,
  evaluatePinnedRecipeGovernance,
} from "../../src/index.js";

describe("DACS-2 GOV-2 progressive anchoring disclosure", () => {
  test("classifies the closed PA-1..PA-3 set without treating in-code as anchored", () => {
    expect(classifyRecipeAnchoringPhase("in-code")).toEqual({
      phase: "in-code",
      progressivePhase: "PA-1",
      canonicallyAnchored: false,
      trustRank: 0,
    });
    expect(classifyRecipeAnchoringPhase("single-signer")).toMatchObject({
      progressivePhase: "PA-2",
      canonicallyAnchored: true,
      trustRank: 1,
    });
    expect(classifyRecipeAnchoringPhase("multisig")).toMatchObject({
      progressivePhase: "PA-3",
      canonicallyAnchored: true,
      trustRank: 2,
    });
    expect(() => classifyRecipeAnchoringPhase("future-phase")).toThrow(/unknown/);
  });
});

describe("DACS-2 GOV-1 steward disclosure", () => {
  test("requires a public authority key and truthful phase representation", () => {
    expect(assessRegistryGovernanceDisclosure({
      authoritativeSigningKey: "key:steward-v1",
      actualPhase: "single-signer",
      represents: "single-steward",
    })).toMatchObject({ ok: true, actualPhase: "single-signer" });
    expect(assessRegistryGovernanceDisclosure({
      actualPhase: "single-signer",
      represents: "single-steward",
    })).toMatchObject({
      ok: false,
      reason: "missing-authoritative-signing-key",
    });
    expect(assessRegistryGovernanceDisclosure({
      authoritativeSigningKey: "key:steward-v1",
      actualPhase: "single-signer",
      represents: "constituted-body",
    })).toMatchObject({
      ok: false,
      reason: "governance-representation-mismatch",
    });
    expect(assessRegistryGovernanceDisclosure({
      authoritativeSigningKey: "key:body-v1",
      actualPhase: "multisig",
      represents: "constituted-body",
    })).toMatchObject({ ok: true, actualPhase: "multisig" });
  });

  test("rejects malformed and accessor-backed disclosures before invoking them", () => {
    expect(() => assessRegistryGovernanceDisclosure({
      authoritativeSigningKey: " key:steward-v1",
      actualPhase: "single-signer",
      represents: "single-steward",
    })).toThrow(/key disclosure/);
    expect(() => assessRegistryGovernanceDisclosure({
      authoritativeSigningKey: "key:steward-v1",
      actualPhase: "future-phase" as "single-signer",
      represents: "single-steward",
    })).toThrow(/unknown/);

    let getterInvoked = false;
    const accessor = Object.defineProperties({}, {
      actualPhase: {
        enumerable: true,
        get: () => {
          getterInvoked = true;
          return "single-signer";
        },
      },
      represents: { enumerable: true, value: "single-steward" },
    });
    expect(() => assessRegistryGovernanceDisclosure(
      accessor as never,
    )).toThrow(/data fields/);
    expect(getterInvoked).toBe(false);

    let proxyTrapInvoked = false;
    const proxy = new Proxy({
      authoritativeSigningKey: "key:steward-v1",
      actualPhase: "single-signer" as const,
      represents: "single-steward" as const,
    }, {
      ownKeys: () => {
        proxyTrapInvoked = true;
        return [];
      },
    });
    expect(() => assessRegistryGovernanceDisclosure(proxy)).toThrow(/plain data record/);
    expect(proxyTrapInvoked).toBe(false);
  });
});

describe("DACS-2 GOV-3 pin-time trust", () => {
  test("evaluates the exact pinned phase against the consumer floor", () => {
    expect(evaluatePinnedRecipeGovernance({
      recipeVersion: 3,
      pinnedPhase: "single-signer",
      minimumPhase: "single-signer",
    })).toEqual({
      recipeVersion: 3,
      evaluatedPhase: "single-signer",
      minimumPhase: "single-signer",
      canonicallyAnchored: true,
      ok: true,
    });
    expect(evaluatePinnedRecipeGovernance({
      recipeVersion: 1,
      pinnedPhase: "in-code",
      minimumPhase: "in-code",
    })).toMatchObject({ canonicallyAnchored: false, ok: true });
    expect(evaluatePinnedRecipeGovernance({
      recipeVersion: 3,
      pinnedPhase: "single-signer",
      minimumPhase: "multisig",
    }).ok).toBe(false);
    expect(evaluatePinnedRecipeGovernance({
      recipeVersion: 4,
      pinnedPhase: "multisig",
      minimumPhase: "multisig",
    }).ok).toBe(true);
  });

  test("fails closed for unknown phases and malformed pin metadata", () => {
    expect(() => evaluatePinnedRecipeGovernance({
      recipeVersion: 3,
      pinnedPhase: "unknown" as "single-signer",
      minimumPhase: "in-code",
    })).toThrow(/unknown/);
    expect(() => evaluatePinnedRecipeGovernance({
      recipeVersion: 0,
      pinnedPhase: "single-signer",
      minimumPhase: "in-code",
    })).toThrow(/positive safe integer/);
    expect(() => evaluatePinnedRecipeGovernance({
      recipeVersion: 3,
      pinnedPhase: "single-signer",
      minimumPhase: "unknown" as "in-code",
    })).toThrow(/unknown/);
  });
});

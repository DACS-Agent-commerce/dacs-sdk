import { describe, expect, test } from "vitest";

import {
  ed25519Sign,
  ed25519Verify,
  identityBundleHash,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
  resolveRecipe,
  signComponentArtifact,
  type CompositeBundleRequirement,
  type IdentityBundle,
  type RecipeDescriptor,
  type VerifyResult,
} from "../../src/index.js";
import {
  advancePartyVetPlan,
  createPartyVetPlan,
  isPartyVetPlan,
  partyVetCompositeAddress,
  type PartyVetAttemptInput,
  type PartyVetAttemptOutcome,
  type PartyVetPlan,
  type PartyVetRequirementAttempt,
} from "../../src/agent/partyVetPlan.js";

const STEWARD_SEED = new Uint8Array(32).fill(81);
const VERIFIER_SEED = new Uint8Array(32).fill(82);
const STEWARD_KEY = rawPublicKey(publicKeyFromSeed(STEWARD_SEED));
const STEWARD = `key:${Buffer.from(STEWARD_KEY).toString("hex")}`;
const VERIFIER_KEY = rawPublicKey(publicKeyFromSeed(VERIFIER_SEED));
const VERIFIER = `key:${Buffer.from(VERIFIER_KEY).toString("hex")}`;
const NOW = 1_786_400_000_000;

const claim = (scheme: string, identifier: string): string =>
  `${scheme}:${identifier}`;

function bundle(presentedBy: string, refs: readonly string[]): IdentityBundle {
  return {
    bundleVersion: "1",
    presentedBy,
    presentedAt: NOW - 1_000,
    claims: refs.map((ref) => ({ ref })),
    presentation: {
      kind: "siwd",
      message: "dacs identity presentation",
      signature: "presentation-signature",
      address: presentedBy,
    },
  };
}

async function signedRecipe(scheme: string, recipeVersion = 1) {
  const unsigned: RecipeDescriptor = {
    recipeVersion,
    scheme,
    defaultMethod: { kind: "self-signed" },
    defaultMaxAgeSec: 3_600,
    parserRules: { format: "json", successJsonPath: "$.active" },
    retryClass: "permanent",
    availability: "live",
    governance: {
      proposedBy: STEWARD,
      acceptedAt: NOW - 10_000,
      anchoring: "single-signer",
    },
  };
  return signComponentArtifact(unsigned, "dacs-recipe:v1:", {
    algorithm: "ed25519",
    signer: STEWARD,
    sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(STEWARD_SEED)),
  });
}

async function authenticatedRecipes(
  schemes: readonly string[],
): Promise<Map<string, Awaited<ReturnType<typeof resolveRecipe>>>> {
  const entries = await Promise.all(schemes.map((scheme) => signedRecipe(scheme)));
  const deps = {
    readRegistry: async () => ({
      registryId: "dacs-recipes",
      version: "snapshot-7",
      entries,
    }),
    stewardPublicKey: STEWARD_KEY,
    stewardSigner: STEWARD,
    verify: (
      bytes: Uint8Array,
      signature: Uint8Array,
      publicKey: Uint8Array,
    ) => ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
  };
  const resolved = new Map<string, Awaited<ReturnType<typeof resolveRecipe>>>();
  for (const scheme of schemes) {
    resolved.set(
      scheme,
      await resolveRecipe(
        "dacs:registry:recipes:snapshot-7",
        { scheme, method: "self-signed", recipeVersion: 1 },
        deps,
      ),
    );
  }
  return resolved;
}

function attempt(
  requirementPath: PartyVetAttemptInput["requirementPath"],
  claimSubject: string,
  recipe: Awaited<ReturnType<typeof resolveRecipe>>,
  classification: PartyVetAttemptInput["classification"] = "dealSpecific",
): PartyVetAttemptInput {
  return {
    requirementPath,
    claimSubject,
    classification,
    method: "self-signed",
    recipe,
    methodInput: { assertionDomain: `test:${claimSubject}` },
  };
}

async function resultOutcome(
  planned: Readonly<PartyVetRequirementAttempt>,
  decision: VerifyResult["decision"],
): Promise<PartyVetAttemptOutcome> {
  const separator = planned.claimSubject.indexOf(":");
  const scheme = planned.claimSubject.slice(0, separator);
  const identifier = planned.claimSubject
    .slice(separator + 1)
    .split("?", 1)[0]!;
  const result = await signComponentArtifact(
    {
      resultVersion: "1" as const,
      scheme,
      identifier,
      recipeVersion: planned.recipe.recipeVersion,
      method: planned.method.kind,
      decision,
      reason: `test ${decision}`,
      attestation: {
        anchor: {
          kind: "https" as const,
          locator: `https://authority.example/${planned.attemptId}`,
        },
        contentHash: planned.attemptId,
        signer: STEWARD,
      },
      fetchedAt: NOW - 20,
      verifiedAt: NOW - 10,
    },
    "dacs-verifyresult:v1:",
    {
      algorithm: "ed25519",
      signer: VERIFIER,
      sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(VERIFIER_SEED)),
    },
  ) as VerifyResult;
  return { attemptId: planned.attemptId, result };
}

async function requiredPlan(): Promise<PartyVetPlan> {
  const alpha = claim("alpha", "alice");
  const beta = claim("beta", "alice");
  const recipes = await authenticatedRecipes(["alpha", "beta"]);
  const requirement: CompositeBundleRequirement = {
    requirementVersion: "1",
    required: [
      { scheme: "alpha", verificationRequired: true },
      { scheme: "beta", verificationRequired: true, recipeVersion: 1 },
    ],
  };
  return createPartyVetPlan({
    jobId: "job-144-required",
    evaluatedParty: alpha,
    identityBundle: bundle(alpha, [alpha, beta]),
    requirement,
    verifier: VERIFIER,
    registryVersion: "snapshot-7",
    attempts: [
      attempt({ kind: "required", index: 0 }, alpha, recipes.get("alpha")!, "freshness"),
      attempt({ kind: "required", index: 1 }, beta, recipes.get("beta")!),
    ],
  });
}

describe("party-scoped multi-claim Vet planning", () => {
  test("freezes one exact party plan and executes all required claims in order", async () => {
    const plan = await requiredPlan();
    expect(isPartyVetPlan(plan)).toBe(true);
    expect(plan.bundleHash).toBe(identityBundleHash(plan.identityBundle));
    expect(plan.attempts).toHaveLength(2);
    expect(new Set(plan.attempts.map((entry) => entry.resultAddress)).size).toBe(2);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.identityBundle.claims)).toBe(true);

    const initial = advancePartyVetPlan(plan, []);
    expect(initial.status).toBe("pending");
    if (initial.status !== "pending") throw new Error("expected pending plan");
    expect(initial.nextAttempt.attemptId).toBe(plan.attempts[0]!.attemptId);

    const first = await resultOutcome(plan.attempts[0]!, "pass");
    const afterFirst = advancePartyVetPlan(plan, [first]);
    expect(afterFirst.status).toBe("pending");
    if (afterFirst.status !== "pending") throw new Error("expected second attempt");
    expect(afterFirst.nextAttempt.attemptId).toBe(plan.attempts[1]!.attemptId);

    const second = await resultOutcome(plan.attempts[1]!, "pass");
    const complete = advancePartyVetPlan(plan, [first, second]);
    expect(complete.status).toBe("complete");
    if (complete.status !== "complete") throw new Error("expected complete plan");
    expect(complete.overallDecision).toBe("pass");
    expect(complete.freshness).toHaveLength(1);
    expect(complete.dealSpecific).toHaveLength(1);
    expect(complete.skippedAttemptIds).toEqual([]);
  });

  test("records oneOf failures, tries the next alternative, and stops after pass", async () => {
    const alpha = claim("alpha", "alice");
    const beta = claim("beta", "alice");
    const recipes = await authenticatedRecipes(["alpha", "beta"]);
    const plan = createPartyVetPlan({
      jobId: "job-144-oneof",
      evaluatedParty: alpha,
      identityBundle: bundle(alpha, [alpha, beta]),
      requirement: {
        requirementVersion: "1",
        required: [],
        oneOf: [[
          { scheme: "alpha", verificationRequired: true },
          { scheme: "beta", verificationRequired: true },
        ]],
      },
      verifier: VERIFIER,
      registryVersion: "snapshot-7",
      attempts: [
        attempt(
          { kind: "oneOf", groupIndex: 0, alternativeIndex: 0 },
          alpha,
          recipes.get("alpha")!,
        ),
        attempt(
          { kind: "oneOf", groupIndex: 0, alternativeIndex: 1 },
          beta,
          recipes.get("beta")!,
        ),
      ],
    });

    const firstFail = await resultOutcome(plan.attempts[0]!, "fail");
    const fallback = advancePartyVetPlan(plan, [firstFail]);
    expect(fallback.status).toBe("pending");
    if (fallback.status !== "pending") throw new Error("expected fallback");
    expect(fallback.nextAttempt.attemptId).toBe(plan.attempts[1]!.attemptId);
    const secondPass = await resultOutcome(plan.attempts[1]!, "pass");
    const fallbackComplete = advancePartyVetPlan(plan, [firstFail, secondPass]);
    expect(fallbackComplete.status).toBe("complete");
    if (fallbackComplete.status !== "complete") throw new Error("expected complete");
    expect(fallbackComplete.overallDecision).toBe("pass");
    expect(fallbackComplete.completed).toHaveLength(2);

    const firstPass = await resultOutcome(plan.attempts[0]!, "pass");
    const shortCircuit = advancePartyVetPlan(plan, [firstPass]);
    expect(shortCircuit.status).toBe("complete");
    if (shortCircuit.status !== "complete") throw new Error("expected complete");
    expect(shortCircuit.overallDecision).toBe("pass");
    expect(shortCircuit.skippedAttemptIds).toEqual([plan.attempts[1]!.attemptId]);
    expect(() => advancePartyVetPlan(plan, [firstPass, secondPass])).toThrow(
      /after completion/,
    );
  });

  test("applies oneOf-local error precedence and global required-fail precedence", async () => {
    const refs = ["alpha", "beta", "gamma", "delta", "epsilon"]
      .map((scheme) => claim(scheme, "alice"));
    const recipes = await authenticatedRecipes([
      "alpha",
      "beta",
      "gamma",
      "delta",
      "epsilon",
    ]);
    const plan = createPartyVetPlan({
      jobId: "job-144-precedence",
      evaluatedParty: refs[0]!,
      identityBundle: bundle(refs[0]!, refs),
      requirement: {
        requirementVersion: "1",
        required: [{ scheme: "alpha", verificationRequired: true }],
        oneOf: [
          [
            { scheme: "beta", verificationRequired: true },
            { scheme: "gamma", verificationRequired: true },
          ],
          [
            { scheme: "delta", verificationRequired: true },
            { scheme: "epsilon", verificationRequired: true },
          ],
        ],
      },
      verifier: VERIFIER,
      registryVersion: "snapshot-7",
      attempts: [
        attempt({ kind: "required", index: 0 }, refs[0]!, recipes.get("alpha")!),
        attempt(
          { kind: "oneOf", groupIndex: 0, alternativeIndex: 0 },
          refs[1]!,
          recipes.get("beta")!,
        ),
        attempt(
          { kind: "oneOf", groupIndex: 0, alternativeIndex: 1 },
          refs[2]!,
          recipes.get("gamma")!,
        ),
        attempt(
          { kind: "oneOf", groupIndex: 1, alternativeIndex: 0 },
          refs[3]!,
          recipes.get("delta")!,
        ),
        attempt(
          { kind: "oneOf", groupIndex: 1, alternativeIndex: 1 },
          refs[4]!,
          recipes.get("epsilon")!,
        ),
      ],
    });
    const decisions: VerifyResult["decision"][] = [
      "fail",
      "fail",
      "error",
      "fail",
      "indeterminate",
    ];
    const outcomes: PartyVetAttemptOutcome[] = [];
    for (let index = 0; index < plan.attempts.length; index += 1) {
      outcomes.push(await resultOutcome(plan.attempts[index]!, decisions[index]!));
    }
    const state = advancePartyVetPlan(plan, outcomes);
    expect(state.status).toBe("complete");
    if (state.status !== "complete") throw new Error("expected complete");
    // Group 0 is error, group 1 is indeterminate, but the required hard fail wins globally.
    expect(state.overallDecision).toBe("fail");
  });

  test("rejects duplicate result addresses and out-of-order outcomes", async () => {
    const alpha = claim("alpha", "alice");
    const recipes = await authenticatedRecipes(["alpha"]);
    expect(() => createPartyVetPlan({
      jobId: "job-144-duplicate",
      evaluatedParty: alpha,
      identityBundle: bundle(alpha, [alpha]),
      requirement: {
        requirementVersion: "1",
        required: [{ scheme: "alpha", verificationRequired: true }],
        oneOf: [[{ scheme: "alpha", verificationRequired: true }]],
      },
      verifier: VERIFIER,
      registryVersion: "snapshot-7",
      attempts: [
        attempt({ kind: "required", index: 0 }, alpha, recipes.get("alpha")!),
        attempt(
          { kind: "oneOf", groupIndex: 0, alternativeIndex: 0 },
          alpha,
          recipes.get("alpha")!,
        ),
      ],
    })).toThrow(/duplicate result address/);

    const plan = await requiredPlan();
    const second = await resultOutcome(plan.attempts[1]!, "pass");
    expect(() => advancePartyVetPlan(plan, [second])).toThrow(
      /does not match its planned attempt/,
    );
  });

  test("binds the exact evaluated party and isolates caller-owned input", async () => {
    const recipes = await authenticatedRecipes(["alpha"]);
    const requirement: CompositeBundleRequirement = {
      requirementVersion: "1",
      required: [{ scheme: "alpha", verificationRequired: true }],
    };
    const alice = claim("alpha", "alice");
    const bob = claim("alpha", "bob");
    const aliceBundle = bundle(alice, [alice]);
    const aliceInput = {
      jobId: "job-144-parties",
      evaluatedParty: alice,
      identityBundle: aliceBundle,
      requirement,
      verifier: VERIFIER,
      registryVersion: "snapshot-7",
      attempts: [
        attempt({ kind: "required", index: 0 }, alice, recipes.get("alpha")!),
      ],
    };
    const alicePlan = createPartyVetPlan(aliceInput);
    const bobPlan = createPartyVetPlan({
      ...aliceInput,
      evaluatedParty: bob,
      identityBundle: bundle(bob, [bob]),
      attempts: [
        attempt({ kind: "required", index: 0 }, bob, recipes.get("alpha")!),
      ],
    });
    expect(alicePlan.recordAddress).toBe(
      partyVetCompositeAddress("job-144-parties", alice),
    );
    expect(bobPlan.recordAddress).toBe(
      partyVetCompositeAddress("job-144-parties", bob),
    );
    expect(alicePlan.recordAddress).not.toBe(bobPlan.recordAddress);

    aliceBundle.claims[0]!.ref = claim("alpha", "mallory");
    requirement.required[0]!.scheme = "mallory";
    aliceInput.attempts[0]!.methodInput!.assertionDomain = "mutated";
    expect(alicePlan.identityBundle.claims[0]!.ref).toBe(alice);
    expect(alicePlan.requirement.required[0]!.scheme).toBe("alpha");
    expect(alicePlan.attempts[0]!.methodInput).toEqual({
      assertionDomain: `test:${alice}`,
    });
  });

  test("rejects hostile attempt accessors and recipe/path substitutions", async () => {
    const alpha = claim("alpha", "alice");
    const beta = claim("beta", "alice");
    const recipes = await authenticatedRecipes(["alpha", "beta"]);
    const base = {
      jobId: "job-144-hostile",
      evaluatedParty: alpha,
      identityBundle: bundle(alpha, [alpha, beta]),
      requirement: {
        requirementVersion: "1" as const,
        required: [{ scheme: "alpha", verificationRequired: true }],
      },
      verifier: VERIFIER,
      registryVersion: "snapshot-7",
    };
    const hostile: Record<string, unknown> = {
      requirementPath: { kind: "required", index: 0 },
      claimSubject: alpha,
      classification: "dealSpecific",
      method: "self-signed",
      recipe: recipes.get("alpha")!,
    };
    Object.defineProperty(hostile, "methodInput", {
      enumerable: true,
      get: () => ({ stolen: true }),
    });
    expect(() => createPartyVetPlan({
      ...base,
      attempts: [hostile as unknown as PartyVetAttemptInput],
    })).toThrow(/exact data record/);

    expect(() => createPartyVetPlan({
      ...base,
      attempts: [
        attempt(
          { kind: "required", index: 0 },
          alpha,
          recipes.get("beta")!,
        ),
      ],
    })).toThrow(/schemes differ/);
  });
});

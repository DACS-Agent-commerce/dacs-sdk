import { describe, expect, test } from "vitest";

import {
  ed25519Sign,
  ed25519Verify,
  identityBundleHash,
  isCompositeBundleRequirement,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
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
  partyVetPinScopeHash,
  type PartyVetAttemptInput,
  type PartyVetAttemptOutcome,
  type PartyVetPlan,
  type PartyVetRequirementAttempt,
} from "../../src/agent/partyVetPlan.js";
import { createPartyVetPins } from "./partyVetPins.js";

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

function attempt(
  requirementPath: PartyVetAttemptInput["requirementPath"],
  claimSubject: string,
  recipePin: PartyVetAttemptInput["recipePin"],
  classification: PartyVetAttemptInput["classification"] = "dealSpecific",
): PartyVetAttemptInput {
  return {
    requirementPath,
    claimSubject,
    classification,
    recipePin,
    methodInput: {
      kind: "self-signed",
      assertion: claimSubject,
      signature: "a".repeat(128),
    },
  };
}

interface AttemptSpec {
  requirementPath: PartyVetAttemptInput["requirementPath"];
  claimSubject: string;
  classification?: PartyVetAttemptInput["classification"];
}

function requirementAtPath(
  requirement: CompositeBundleRequirement,
  path: PartyVetAttemptInput["requirementPath"],
) {
  return path.kind === "required"
    ? requirement.required[path.index]!
    : requirement.oneOf![path.groupIndex]![path.alternativeIndex]!;
}

async function pinnedAttempts(
  jobId: string,
  evaluatedParty: string,
  requirement: CompositeBundleRequirement,
  specs: readonly AttemptSpec[],
  identityBundle: IdentityBundle = bundle(
    evaluatedParty,
    [...new Set(specs.map((spec) => spec.claimSubject))],
  ),
): Promise<PartyVetAttemptInput[]> {
  const schemes = [...new Set(
    specs.map((spec) => requirementAtPath(requirement, spec.requirementPath).scheme),
  )];
  const recipes = await Promise.all(schemes.map((scheme) => signedRecipe(scheme)));
  const pinScopeHash = partyVetPinScopeHash({
    jobId,
    evaluatedParty,
    identityBundle,
    requirement,
    verifier: { algorithm: "ed25519", signer: VERIFIER },
    attempts: specs.map((spec) => ({
      requirementPath: spec.requirementPath,
      claimSubject: spec.claimSubject,
      classification: spec.classification ?? "dealSpecific",
      methodInput: {
        kind: "self-signed" as const,
        assertion: spec.claimSubject,
        signature: "a".repeat(128),
      },
    })),
  });
  const pins = await createPartyVetPins({
    jobId,
    evaluatedParty,
    sessionStartHash: pinScopeHash,
    partyPlanHash: pinScopeHash,
    bundleRequirement: requirement,
    recipes,
    attempts: specs.map((spec) => ({
      requirementPath: spec.requirementPath,
      requirement: requirementAtPath(requirement, spec.requirementPath),
    })),
    stewardSigner: STEWARD,
    stewardPublicKey: STEWARD_KEY,
    verify: (bytes, signature, publicKey) =>
      ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
    now: NOW,
  });
  return specs.map((spec, index) => attempt(
    spec.requirementPath,
    spec.claimSubject,
    pins[index]!,
    spec.classification,
  ));
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
  const jobId = "job-144-required";
  const requirement: CompositeBundleRequirement = {
    requirementVersion: "1",
    required: [
      { scheme: "alpha", verificationRequired: true, recipeVersion: 1 },
      { scheme: "beta", verificationRequired: true, recipeVersion: 1 },
    ],
  };
  return createPartyVetPlan({
    jobId,
    evaluatedParty: alpha,
    identityBundle: bundle(alpha, [alpha, beta]),
    requirement,
    verifier: { algorithm: "ed25519", signer: VERIFIER },
    attempts: await pinnedAttempts(jobId, alpha, requirement, [
      {
        requirementPath: { kind: "required", index: 0 },
        claimSubject: alpha,
        classification: "freshness",
      },
      { requirementPath: { kind: "required", index: 1 }, claimSubject: beta },
    ]),
  });
}

describe("party-scoped multi-claim Vet planning", () => {
  test("rejects empty oneOf groups at the normative requirement boundary", () => {
    expect(isCompositeBundleRequirement({
      requirementVersion: "1",
      required: [],
      oneOf: [[]],
    })).toBe(false);
  });

  test("freezes one exact party plan and executes all required claims in order", async () => {
    const plan = await requiredPlan();
    expect(isPartyVetPlan(plan)).toBe(true);
    expect(plan.bundleHash).toBe(identityBundleHash(plan.identityBundle));
    expect(plan.attempts).toHaveLength(2);
    expect(plan.sessionRecipeRegistrySnapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.attempts.every(
      (entry) => entry.recipePin.partyPlanHash === plan.pinScopeHash,
    )).toBe(true);
    expect(plan.attempts.every(
      (entry) =>
        entry.recipePin.sessionSnapshotHash ===
        plan.sessionRecipeRegistrySnapshotHash,
    )).toBe(true);
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
    const jobId = "job-144-oneof";
    const requirement: CompositeBundleRequirement = {
      requirementVersion: "1",
      required: [],
      oneOf: [[
        { scheme: "alpha", verificationRequired: true, recipeVersion: 1 },
        { scheme: "beta", verificationRequired: true, recipeVersion: 1 },
      ]],
    };
    const plan = createPartyVetPlan({
      jobId,
      evaluatedParty: alpha,
      identityBundle: bundle(alpha, [alpha, beta]),
      requirement,
      verifier: { algorithm: "ed25519" as const, signer: VERIFIER },
      attempts: await pinnedAttempts(jobId, alpha, requirement, [
        {
          requirementPath: {
            kind: "oneOf",
            groupIndex: 0,
            alternativeIndex: 0,
          },
          claimSubject: alpha,
        },
        {
          requirementPath: {
            kind: "oneOf",
            groupIndex: 0,
            alternativeIndex: 1,
          },
          claimSubject: beta,
        },
      ]),
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
    const jobId = "job-144-precedence";
    const requirement: CompositeBundleRequirement = {
      requirementVersion: "1",
      required: [{ scheme: "alpha", verificationRequired: true, recipeVersion: 1 }],
      oneOf: [
        [
          { scheme: "beta", verificationRequired: true, recipeVersion: 1 },
          { scheme: "gamma", verificationRequired: true, recipeVersion: 1 },
        ],
        [
          { scheme: "delta", verificationRequired: true, recipeVersion: 1 },
          { scheme: "epsilon", verificationRequired: true, recipeVersion: 1 },
        ],
      ],
    };
    const plan = createPartyVetPlan({
      jobId,
      evaluatedParty: refs[0]!,
      identityBundle: bundle(refs[0]!, refs),
      requirement,
      verifier: { algorithm: "ed25519" as const, signer: VERIFIER },
      attempts: await pinnedAttempts(jobId, refs[0]!, requirement, [
        { requirementPath: { kind: "required", index: 0 }, claimSubject: refs[0]! },
        {
          requirementPath: { kind: "oneOf", groupIndex: 0, alternativeIndex: 0 },
          claimSubject: refs[1]!,
        },
        {
          requirementPath: { kind: "oneOf", groupIndex: 0, alternativeIndex: 1 },
          claimSubject: refs[2]!,
        },
        {
          requirementPath: { kind: "oneOf", groupIndex: 1, alternativeIndex: 0 },
          claimSubject: refs[3]!,
        },
        {
          requirementPath: { kind: "oneOf", groupIndex: 1, alternativeIndex: 1 },
          claimSubject: refs[4]!,
        },
      ]),
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
    const jobId = "job-144-duplicate";
    const requirement: CompositeBundleRequirement = {
      requirementVersion: "1",
      required: [{ scheme: "alpha", verificationRequired: true, recipeVersion: 1 }],
      oneOf: [[{ scheme: "alpha", verificationRequired: true, recipeVersion: 1 }]],
    };
    const duplicateAttempts = await pinnedAttempts(jobId, alpha, requirement, [
      { requirementPath: { kind: "required", index: 0 }, claimSubject: alpha },
      {
        requirementPath: { kind: "oneOf", groupIndex: 0, alternativeIndex: 0 },
        claimSubject: alpha,
      },
    ]);
    expect(() => createPartyVetPlan({
      jobId,
      evaluatedParty: alpha,
      identityBundle: bundle(alpha, [alpha]),
      requirement,
      verifier: { algorithm: "ed25519", signer: VERIFIER },
      attempts: duplicateAttempts,
    })).toThrow(/duplicate result address/);

    const plan = await requiredPlan();
    const second = await resultOutcome(plan.attempts[1]!, "pass");
    expect(() => advancePartyVetPlan(plan, [second])).toThrow(
      /does not match its planned attempt/,
    );
  });

  test("binds the exact evaluated party and isolates caller-owned input", async () => {
    const jobId = "job-144-parties";
    const requirement: CompositeBundleRequirement = {
      requirementVersion: "1",
      required: [{ scheme: "alpha", verificationRequired: true, recipeVersion: 1 }],
    };
    const alice = claim("alpha", "alice");
    const bob = claim("alpha", "bob");
    const aliceBundle = bundle(alice, [alice]);
    const aliceAttempts = await pinnedAttempts(jobId, alice, requirement, [
      { requirementPath: { kind: "required", index: 0 }, claimSubject: alice },
    ]);
    const aliceInput = {
      jobId,
      evaluatedParty: alice,
      identityBundle: aliceBundle,
      requirement,
      verifier: { algorithm: "ed25519" as const, signer: VERIFIER },
      attempts: aliceAttempts,
    };
    const alicePlan = createPartyVetPlan(aliceInput);
    const bobAttempts = await pinnedAttempts(jobId, bob, requirement, [
      { requirementPath: { kind: "required", index: 0 }, claimSubject: bob },
    ]);
    const bobPlan = createPartyVetPlan({
      ...aliceInput,
      evaluatedParty: bob,
      identityBundle: bundle(bob, [bob]),
      attempts: bobAttempts,
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
    if (aliceInput.attempts[0]!.methodInput.kind !== "self-signed") {
      throw new Error("expected self-signed method input");
    }
    aliceInput.attempts[0]!.methodInput.assertion = "mutated";
    expect(alicePlan.identityBundle.claims[0]!.ref).toBe(alice);
    expect(alicePlan.requirement.required[0]!.scheme).toBe("alpha");
    expect(alicePlan.attempts[0]!.methodInput).toEqual({
      kind: "self-signed",
      assertion: alice,
      signature: "a".repeat(128),
    });
  });

  test("matches evaluated parties and carried claim subjects by CF-3 identity", () => {
    const base = claim("alpha", "alice");
    const qualified = `${base}?role=buyer`;
    const requirement: CompositeBundleRequirement = {
      requirementVersion: "1",
      required: [{
        scheme: "alpha",
        verificationRequired: true,
        recipeVersion: 1,
      }],
    };

    expect(() => partyVetPinScopeHash({
      jobId: "job-144-cf3",
      evaluatedParty: qualified,
      identityBundle: bundle(base, [base]),
      requirement,
      verifier: { algorithm: "ed25519", signer: VERIFIER },
      attempts: [{
        requirementPath: { kind: "required", index: 0 },
        claimSubject: qualified,
        classification: "dealSpecific",
        methodInput: {
          kind: "self-signed",
          assertion: qualified,
          signature: "a".repeat(128),
        },
      }],
    })).not.toThrow();
  });

  test("rejects hostile attempt accessors and recipe/path substitutions", async () => {
    const alpha = claim("alpha", "alice");
    const beta = claim("beta", "alice");
    const alphaRequirement = {
      scheme: "alpha",
      verificationRequired: true,
      recipeVersion: 1,
    } as const;
    const base = {
      jobId: "job-144-hostile",
      evaluatedParty: alpha,
      identityBundle: bundle(alpha, [alpha, beta]),
      requirement: {
        requirementVersion: "1" as const,
        required: [alphaRequirement],
      },
      verifier: { algorithm: "ed25519" as const, signer: VERIFIER },
    };
    const [alphaAttempt] = await pinnedAttempts(
      base.jobId,
      alpha,
      base.requirement,
      [{ requirementPath: { kind: "required", index: 0 }, claimSubject: alpha }],
    );
    const hostile: Record<string, unknown> = {
      requirementPath: { kind: "required", index: 0 },
      claimSubject: alpha,
      classification: "dealSpecific",
      recipePin: alphaAttempt!.recipePin,
    };
    Object.defineProperty(hostile, "methodInput", {
      enumerable: true,
      get: () => ({ stolen: true }),
    });
    expect(() => createPartyVetPlan({
      ...base,
      attempts: [hostile as unknown as PartyVetAttemptInput],
    })).toThrow(/exact data record/);

    const betaRequirement: CompositeBundleRequirement = {
      requirementVersion: "1",
      required: [{ scheme: "beta", verificationRequired: true, recipeVersion: 1 }],
    };
    const [betaAttempt] = await pinnedAttempts(
      base.jobId,
      alpha,
      betaRequirement,
      [{ requirementPath: { kind: "required", index: 0 }, claimSubject: beta }],
      bundle(alpha, [alpha, beta]),
    );
    expect(() => createPartyVetPlan({
      ...base,
      attempts: [
        attempt(
          { kind: "required", index: 0 },
          alpha,
          betaAttempt!.recipePin,
        ),
      ],
    })).toThrow(/does not bind this party and requirement path/);
  });

  test("rejects pins bound to different exact party-plan bytes", async () => {
    const jobId = "job-144-pin-scope-substitution";
    const alpha = claim("alpha", "alice");
    const requirement: CompositeBundleRequirement = {
      requirementVersion: "1",
      required: [
        { scheme: "alpha", verificationRequired: true, recipeVersion: 1 },
      ],
    };
    const pinnedIdentity = bundle(alpha, [alpha]);
    const attempts = await pinnedAttempts(
      jobId,
      alpha,
      requirement,
      [{ requirementPath: { kind: "required", index: 0 }, claimSubject: alpha }],
      pinnedIdentity,
    );
    const substitutedIdentity = {
      ...pinnedIdentity,
      sessionNonce: "different-exact-bundle",
    };

    expect(() => createPartyVetPlan({
      jobId,
      evaluatedParty: alpha,
      identityBundle: substitutedIdentity,
      requirement,
      verifier: { algorithm: "ed25519", signer: VERIFIER },
      attempts,
    })).toThrow(/durable recipe pin does not bind this party and requirement path/);
  });

  test("rejects attempt pins taken from different job-wide registry snapshots", async () => {
    const jobId = "job-144-mixed-registry-snapshots";
    const alpha = claim("alpha", "alice");
    const beta = claim("beta", "alice");
    const identityBundle = bundle(alpha, [alpha, beta]);
    const requirement: CompositeBundleRequirement = {
      requirementVersion: "1",
      required: [
        { scheme: "alpha", verificationRequired: true, recipeVersion: 1 },
        { scheme: "beta", verificationRequired: true, recipeVersion: 1 },
      ],
    };
    const specs: readonly AttemptSpec[] = [
      { requirementPath: { kind: "required", index: 0 }, claimSubject: alpha },
      { requirementPath: { kind: "required", index: 1 }, claimSubject: beta },
    ];
    const recipes = await Promise.all([
      signedRecipe("alpha"),
      signedRecipe("beta"),
    ]);
    const partyPlanHash = partyVetPinScopeHash({
      jobId,
      evaluatedParty: alpha,
      identityBundle,
      requirement,
      verifier: { algorithm: "ed25519", signer: VERIFIER },
      attempts: specs.map((spec) => ({
        requirementPath: spec.requirementPath,
        claimSubject: spec.claimSubject,
        classification: "dealSpecific" as const,
        methodInput: {
          kind: "self-signed" as const,
          assertion: spec.claimSubject,
          signature: "a".repeat(128),
        },
      })),
    });
    const pinInput = {
      jobId,
      evaluatedParty: alpha,
      partyPlanHash,
      bundleRequirement: requirement,
      recipes,
      attempts: specs.map((spec) => ({
        requirementPath: spec.requirementPath,
        requirement: requirementAtPath(requirement, spec.requirementPath),
      })),
      stewardSigner: STEWARD,
      stewardPublicKey: STEWARD_KEY,
      verify: (bytes: Uint8Array, signature: Uint8Array, publicKey: Uint8Array) =>
        ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
      now: NOW,
    };
    const [leftPins, rightPins] = await Promise.all([
      createPartyVetPins({ ...pinInput, sessionStartHash: "a".repeat(64) }),
      createPartyVetPins({ ...pinInput, sessionStartHash: "b".repeat(64) }),
    ]);
    expect(leftPins[0]!.sessionSnapshotHash).not.toBe(
      rightPins[1]!.sessionSnapshotHash,
    );

    expect(() => createPartyVetPlan({
      jobId,
      evaluatedParty: alpha,
      identityBundle,
      requirement,
      verifier: { algorithm: "ed25519", signer: VERIFIER },
      attempts: [
        attempt(specs[0]!.requirementPath, alpha, leftPins[0]!),
        attempt(specs[1]!.requirementPath, beta, rightPins[1]!),
      ],
    })).toThrow(/do not share one job-wide registry snapshot/);
  });

  test("requires the attempt to disambiguate same-scheme claim provenance", async () => {
    const jobId = "job-144-ambiguous-scheme";
    const alpha = claim("alpha", "alice");
    const alias = claim("alpha", "alice-alias");
    const requirement: CompositeBundleRequirement = {
      requirementVersion: "1",
      required: [{ scheme: "alpha", verificationRequired: true, recipeVersion: 1 }],
    };
    const identity = bundle(alpha, [alpha, alias]);
    const attempts = await pinnedAttempts(jobId, alpha, requirement, [{
      requirementPath: { kind: "required", index: 0 },
      claimSubject: alpha,
    }], identity);
    const plan = createPartyVetPlan({
      jobId,
      evaluatedParty: alpha,
      identityBundle: identity,
      requirement,
      verifier: { algorithm: "ed25519", signer: VERIFIER },
      attempts,
    });
    expect(plan.attempts[0]!.claimSubject).toBe(alpha);
  });

  test("preserves an own __proto__ field in the exact captured bundle hash", async () => {
    const jobId = "job-144-own-proto";
    const alpha = claim("alpha", "alice");
    const requirement: CompositeBundleRequirement = {
      requirementVersion: "1",
      required: [{ scheme: "alpha", verificationRequired: true, recipeVersion: 1 }],
    };
    const identity = bundle(alpha, [alpha]);
    Object.defineProperty(identity, "__proto__", {
      value: { extensionVersion: "1", marker: "exact-wire-member" },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const attempts = await pinnedAttempts(
      jobId,
      alpha,
      requirement,
      [{
        requirementPath: { kind: "required", index: 0 },
        claimSubject: alpha,
      }],
      identity,
    );
    const plan = createPartyVetPlan({
      jobId,
      evaluatedParty: alpha,
      identityBundle: identity,
      requirement,
      verifier: { algorithm: "ed25519", signer: VERIFIER },
      attempts,
    });
    expect(Object.prototype.hasOwnProperty.call(plan.identityBundle, "__proto__"))
      .toBe(true);
    expect(plan.bundleHash).toBe(identityBundleHash(identity));
    const withoutOwnProto = structuredClone(identity) as IdentityBundle;
    delete (withoutOwnProto as unknown as Record<string, unknown>).__proto__;
    expect(plan.bundleHash).not.toBe(identityBundleHash(withoutOwnProto));
  });
});

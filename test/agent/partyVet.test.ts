import { describe, expect, test } from "vitest";

import {
  canonicalize,
  contentHash,
  createInMemoryFencedSessionStore,
  ed25519Sign,
  ed25519Verify,
  identityBundleHash,
  isCompositeVerificationRecord,
  isVerifyResult,
  partyVetCompositeAddress,
  partyVetCore,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
  sha256Hex,
  signComponentArtifact,
  signedBytes,
  type AttestationRef,
  type CompositeBundleRequirement,
  type FinalizedVetAnchor,
  type FinalizedVetAnchorReceipt,
  type FencedSessionStoreV2,
  type FencedSessionLeaseTokenV2,
  type IdentityBundle,
  type PartyVetDeps,
  type PartyVetRequest,
  type RecipeDescriptor,
  type VerifyResult,
} from "../../src/index.js";
import { createPartyVetPins } from "./partyVetPins.js";

const VERIFIER_SEED = new Uint8Array(32).fill(91);
const VERIFIER_KEY = rawPublicKey(publicKeyFromSeed(VERIFIER_SEED));
const VERIFIER = `key:${Buffer.from(VERIFIER_KEY).toString("hex")}`;
const STEWARD_SEED = new Uint8Array(32).fill(92);
const STEWARD_KEY = rawPublicKey(publicKeyFromSeed(STEWARD_SEED));
const STEWARD = `key:${Buffer.from(STEWARD_KEY).toString("hex")}`;
const PRESENTER_SEED = new Uint8Array(32).fill(93);
const PRESENTER_KEY = rawPublicKey(publicKeyFromSeed(PRESENTER_SEED));
const NOW = 1_786_500_000_000;

interface StoredArtifact {
  logicalAddress: string;
  artifact: Record<string, unknown>;
  ref: AttestationRef;
  receipt: FinalizedVetAnchorReceipt;
}

interface StoredStep {
  operationHash: string;
  inputHash: string;
  state: "complete" | "failed";
  value?: unknown;
  error?: string;
}

interface HarnessState {
  checkpoints: Map<string, unknown>;
  steps: Map<string, StoredStep>;
  inflight: Map<string, Promise<unknown>>;
  artifacts: Map<string, StoredArtifact>;
  decisions: Map<string, "pass" | "fail" | "indeterminate" | "error">;
  effects: {
    methods: number;
    signs: number;
    anchors: number;
  };
  effectStore: FencedSessionStoreV2;
  effectLease?: FencedSessionLeaseTokenV2;
  effectJobId?: string;
  now: number;
  beforeAuthorizedEffect?: (input: {
    operationKey: string;
    operationHash: string;
    step: string;
    inputHash: string;
  }) => Promise<void> | void;
}

function state(): HarnessState {
  return {
    checkpoints: new Map(),
    steps: new Map(),
    inflight: new Map(),
    artifacts: new Map(),
    decisions: new Map(),
    effects: { methods: 0, signs: 0, anchors: 0 },
    effectStore: createInMemoryFencedSessionStore(),
    now: NOW,
  };
}

async function activateEffectLease(
  harness: HarnessState,
  jobId: string,
  owner = "party-vet-worker-1",
  ttlMs = 10_000,
): Promise<void> {
  if (harness.effectJobId === undefined) {
    await harness.effectStore.create({ jobId, now: harness.now - 1 });
    harness.effectJobId = jobId;
  } else if (harness.effectJobId !== jobId) {
    throw new Error("one party Vet harness cannot span effect-session job ids");
  }
  if (harness.effectLease !== undefined) return;
  const lease = await harness.effectStore.acquireLease({
    jobId,
    owner,
    ttlMs,
    now: harness.now - 1,
  });
  if (!lease.ok) throw new Error(`effect lease failed: ${lease.reason}`);
  harness.effectLease = {
    owner: lease.lease.owner,
    generation: lease.lease.generation,
  };
}

async function takeOverEffectLease(
  harness: HarnessState,
  owner: string,
  ttlMs = 10_000,
): Promise<void> {
  if (!harness.effectJobId || !harness.effectLease) {
    throw new Error("effect lease must be active before takeover");
  }
  harness.now += ttlMs + 1;
  const lease = await harness.effectStore.acquireLease({
    jobId: harness.effectJobId,
    owner,
    ttlMs,
    now: harness.now,
  });
  if (!lease.ok) throw new Error(`effect takeover failed: ${lease.reason}`);
  harness.effectLease = {
    owner: lease.lease.owner,
    generation: lease.lease.generation,
  };
}

function artifactHash(artifact: Record<string, unknown>): string {
  return contentHash(artifact);
}

function receiptFor(
  logicalAddress: string,
  nativeAddress: string,
  hash: string,
): FinalizedVetAnchorReceipt {
  return {
    receiptVersion: "1",
    substrate: "party-vet-memory",
    finalityProfile: "instant-test-finality",
    logicalAddress,
    nativeAddress,
    contentHash: hash,
    transactionRef: { kind: "memory-tx", value: `tx:${hash}` },
    writer: VERIFIER,
    nonce: "1",
    state: "finalized",
    observationDisposition: "established",
    observedAt: NOW,
    blockRef: { id: "memory-block", height: "1", timestamp: NOW },
    evidence: { kind: "memory-proof", value: `proof:${hash}` },
  };
}

function keyFromSigner(signer: string): Uint8Array | null {
  const match = /^key:([0-9a-f]{64})$/.exec(signer);
  return match ? Uint8Array.from(Buffer.from(match[1]!, "hex")) : null;
}

function deps(
  harness: HarnessState,
  options: { presentationValid?: boolean; randomSignatures?: boolean } = {},
): PartyVetDeps<Uint8Array> {
  if (!harness.effectLease) {
    throw new Error("party Vet harness effect lease was not activated");
  }
  return {
    proxyFetch: async ({ url }) => {
      harness.effects.methods += 1;
      const scheme = new URL(url).pathname.split("/").filter(Boolean)[0]!;
      const decision = harness.decisions.get(scheme) ?? "pass";
      const body = JSON.stringify(
        decision === "pass"
          ? { ok: true }
          : decision === "indeterminate"
            ? { pending: true }
            : {},
      );
      return {
        status: decision === "error" ? 503 : 200,
        body,
        attestation: {
          anchor: {
            kind: "https",
            locator: `https://authority.example/evidence/${scheme}`,
          },
          contentHash: sha256Hex(body),
          signer: "substrate-validator-set:demos-testnet:1",
        },
        fetchedAt: harness.now,
        complete: true,
      };
    },
    nowMs: () => harness.now,
    componentSigner: {
      algorithm: "ed25519",
      signer: VERIFIER,
      sign: (bytes) => {
        harness.effects.signs += 1;
        return options.randomSignatures
          ? new Uint8Array(64).fill(1)
          : ed25519Sign(bytes, privateKeyFromSeed(VERIFIER_SEED));
      },
    },
    anchorFinalizedArtifact: async ({ logicalAddress, artifact }) => {
      harness.effects.anchors += 1;
      const exact = structuredClone(artifact) as Record<string, unknown>;
      const hash = artifactHash(exact);
      const existing = harness.artifacts.get(logicalAddress);
      if (existing) {
        if (
          existing.ref.contentHash !== hash ||
          canonicalize(existing.artifact) !== canonicalize(exact)
        ) {
          throw new Error(`logical address collision at ${logicalAddress}`);
        }
        return structuredClone({ ref: existing.ref, receipt: existing.receipt });
      }
      const nativeAddress = `memory:${logicalAddress}`;
      const ref: AttestationRef = {
        anchor: { kind: "storage-program", locator: nativeAddress },
        contentHash: hash,
      };
      const receipt = receiptFor(logicalAddress, nativeAddress, hash);
      harness.artifacts.set(logicalAddress, {
        logicalAddress,
        artifact: exact,
        ref: structuredClone(ref),
        receipt: structuredClone(receipt),
      });
      return { ref, receipt };
    },
    verifyFinalizedAnchor: ({ logicalAddress, artifact, ref, receipt }) => {
      const stored = harness.artifacts.get(logicalAddress);
      return (
        stored !== undefined &&
        stored.ref.anchor.locator === ref.anchor.locator &&
        receipt.logicalAddress === logicalAddress &&
        receipt.contentHash === artifactHash(
          artifact as unknown as Record<string, unknown>,
        ) &&
        canonicalize(stored.artifact) === canonicalize(artifact)
      );
    },
    readAnchoredJson: async (ref) => {
      const stored = [...harness.artifacts.values()].find(
        (candidate) => candidate.ref.anchor.locator === ref.anchor.locator,
      );
      return stored ? structuredClone(stored.artifact) : null;
    },
    resolveFinalizedArtifact: async ({ logicalAddress, contentHash: hash }) => {
      const stored = harness.artifacts.get(logicalAddress);
      return stored && stored.ref.contentHash === hash
        ? structuredClone({ ref: stored.ref, receipt: stored.receipt })
        : null;
    },
    operationStore: {
      load: async (operationKey) => {
        const value = harness.checkpoints.get(operationKey);
        return value === undefined ? null : structuredClone(value);
      },
      compareAndSet: async ({ operationKey, expected, next }) => {
        const current = harness.checkpoints.get(operationKey);
        const matches = expected === null
          ? current === undefined
          : current !== undefined &&
            canonicalize(current) === canonicalize(expected);
        if (!matches) return false;
        harness.checkpoints.set(operationKey, structuredClone(next));
        return true;
      },
      runOnce: async ({
        operationKey,
        operationHash,
        step,
        inputHash,
        execute,
      }) => {
        const key = `${operationKey}\u0000${step}`;
        const replay = harness.steps.get(key);
        if (replay) {
          if (
            replay.operationHash !== operationHash ||
            replay.inputHash !== inputHash
          ) {
            throw new Error(`runOnce ${step} input mismatch`);
          }
          if (replay.state === "failed") throw new Error(replay.error);
          return structuredClone(replay.value);
        }
        let pending = harness.inflight.get(key);
        if (!pending) {
          pending = (async () => {
            try {
              const value = structuredClone(await execute());
              harness.steps.set(key, {
                operationHash,
                inputHash,
                state: "complete",
                value,
              });
              return value;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              harness.steps.set(key, {
                operationHash,
                inputHash,
                state: "failed",
                error: message,
              });
              throw error;
            } finally {
              harness.inflight.delete(key);
            }
          })();
          harness.inflight.set(key, pending);
        }
        return structuredClone(await pending);
      },
      runOnceAuthorized: async ({
        operationKey,
        operationHash,
        step,
        inputHash,
        authorize,
        execute,
      }) => {
        const key = `${operationKey}\u0000${step}`;
        const replay = harness.steps.get(key);
        if (replay) {
          if (
            replay.operationHash !== operationHash ||
            replay.inputHash !== inputHash
          ) {
            throw new Error(`runOnceAuthorized ${step} input mismatch`);
          }
          if (replay.state === "failed") throw new Error(replay.error);
          return { status: "complete" as const, value: structuredClone(replay.value) };
        }
        let pending = harness.inflight.get(key);
        if (!pending) {
          pending = (async () => {
            await harness.beforeAuthorizedEffect?.({
              operationKey,
              operationHash,
              step,
              inputHash,
            });
            const authorization = await authorize();
            if (authorization.status === "rejected") {
              return {
                authorizationRejected: true as const,
                reason: authorization.reason,
              };
            }
            try {
              const value = structuredClone(await execute());
              harness.steps.set(key, {
                operationHash,
                inputHash,
                state: "complete",
                value,
              });
              return { authorizationRejected: false as const, value };
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              harness.steps.set(key, {
                operationHash,
                inputHash,
                state: "failed",
                error: message,
              });
              throw error;
            } finally {
              harness.inflight.delete(key);
            }
          })();
          harness.inflight.set(key, pending);
        }
        const outcome = await pending as
          | { authorizationRejected: true; reason: "fenced" | "expired" | "indeterminate" }
          | { authorizationRejected: false; value: unknown };
        if (outcome.authorizationRejected) {
          harness.inflight.delete(key);
          return {
            status: "authorization-rejected" as const,
            reason: outcome.reason,
          };
        }
        return { status: "complete" as const, value: structuredClone(outcome.value) };
      },
    },
    verifyIdentityPresentation: ({ bundle, signedBytes: bytes }) => {
      if (options.presentationValid === false) return false;
      if (bundle.presentation.kind !== "siwd") return false;
      try {
        return ed25519Verify(
          bytes,
          Uint8Array.from(Buffer.from(bundle.presentation.signature, "hex")),
          publicKeyFromRaw(PRESENTER_KEY),
        );
      } catch {
        return false;
      }
    },
    componentVerifier: {
      isSignerAuthorized: (_artifact, signature) =>
        signature.signer === VERIFIER,
      resolvePublicKey: (signature) =>
        signature.algorithm === "ed25519"
          ? keyFromSigner(signature.signer)
          : null,
      verify: ({ signedBytes: bytes, signature, publicKey }) =>
        ed25519Verify(
          bytes,
          Uint8Array.from(Buffer.from(signature.value, "base64url")),
          publicKeyFromRaw(publicKey),
        ),
    },
    sessionEffectAuthority: {
      store: harness.effectStore,
      leaseToken: harness.effectLease,
    },
    matchRequirementParameters: () => true,
  };
}

async function recipe(
  scheme: string,
  availability: RecipeDescriptor["availability"] = "live",
) {
  const descriptor: RecipeDescriptor = {
    recipeVersion: 1,
    scheme,
    defaultMethod: {
      kind: "consensus-backed-proxy",
      endpoint: {
        method: "GET",
        urlTemplate: `https://authority.example/${scheme}/{identifier}`,
      },
    },
    defaultMaxAgeSec: 3_600,
    parserRules: {
      format: "json",
      successJsonPath: "$.ok",
      indeterminateOn: [{ jsonPath: "$.pending" }],
    },
    retryClass: "permanent",
    availability,
    governance: {
      proposedBy: STEWARD,
      acceptedAt: NOW - 10_000,
      anchoring: "single-signer",
    },
  };
  const signed = await signComponentArtifact(
    descriptor,
    "dacs-recipe:v1:",
    {
      algorithm: "ed25519",
      signer: STEWARD,
      sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(STEWARD_SEED)),
    },
  );
  return signed;
}

async function bundle(
  presentedBy: string,
  refs: readonly string[],
  claims: IdentityBundle["claims"] = refs.map((ref) => ({ ref })),
): Promise<IdentityBundle> {
  const unsigned: IdentityBundle = {
    bundleVersion: "1",
    presentedBy,
    presentedAt: NOW - 1_000,
    claims,
    presentation: {
      kind: "siwd",
      message: "party Vet test presentation",
      signature: "pending",
      address: presentedBy,
    },
  };
  if (unsigned.presentation.kind !== "siwd") {
    throw new Error("expected SIWD presentation");
  }
  unsigned.presentation.signature = Buffer.from(
    ed25519Sign(
      signedBytes("dacs-bundle-presentation:v1:", identityBundleHash(unsigned)),
      privateKeyFromSeed(PRESENTER_SEED),
    ),
  ).toString("hex");
  return unsigned;
}

function attempt(
  requirementPath: PartyVetRequest["attempts"][number]["requirementPath"],
  claimSubject: string,
  recipePin: PartyVetRequest["attempts"][number]["recipePin"],
): PartyVetRequest["attempts"][number] {
  return {
    requirementPath,
    claimSubject,
    recipePin,
    methodInput: { kind: "consensus-backed-proxy" },
  };
}

function requirementAtPath(
  requirement: CompositeBundleRequirement,
  path: PartyVetRequest["attempts"][number]["requirementPath"],
) {
  return path.kind === "required"
    ? requirement.required[path.index]!
    : requirement.oneOf![path.groupIndex]![path.alternativeIndex]!;
}

async function pinnedRequestAttempts(
  jobId: string,
  evaluatedParty: string,
  requirement: CompositeBundleRequirement,
  specs: readonly {
    requirementPath: PartyVetRequest["attempts"][number]["requirementPath"];
    claimSubject: string;
    recipe: Awaited<ReturnType<typeof recipe>>;
  }[],
): Promise<PartyVetRequest["attempts"]> {
  const pins = await createPartyVetPins({
    jobId,
    evaluatedParty,
    recipes: specs.map((spec) => spec.recipe),
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
  return specs.map((spec, index) =>
    attempt(spec.requirementPath, spec.claimSubject, pins[index]!));
}

async function singleClaimRequest(
  jobId: string,
  availability: RecipeDescriptor["availability"] = "live",
): Promise<PartyVetRequest> {
  const subject = "alpha:alice";
  const requirement: CompositeBundleRequirement = {
    requirementVersion: "1",
    required: [
      { scheme: "alpha", verificationRequired: true, recipeVersion: 1 },
    ],
  };
  const signedRecipe = await recipe("alpha", availability);
  return {
    jobId,
    evaluatedParty: subject,
    identityBundle: await bundle(subject, [subject]),
    requirement,
    attempts: await pinnedRequestAttempts(jobId, subject, requirement, [{
      requirementPath: { kind: "required", index: 0 },
      claimSubject: subject,
      recipe: signedRecipe,
    }]),
  };
}

describe("partyVetCore durable party-level producer", () => {
  test("produces one two-result CVR for required=[alpha,beta]", async () => {
    const harness = state();
    const alpha = "alpha:alice";
    const beta = "beta:alice";
    const [alphaRecipe, betaRecipe] = await Promise.all([
      recipe("alpha"),
      recipe("beta"),
    ]);
    const identity = await bundle(alpha, [alpha, beta]);
    const requirement: CompositeBundleRequirement = {
      requirementVersion: "1",
      required: [
        { scheme: "alpha", verificationRequired: true, recipeVersion: 1 },
        { scheme: "beta", verificationRequired: true, recipeVersion: 1 },
      ],
    };
    const jobId = "job-party-required";
    const request: PartyVetRequest = {
      jobId,
      evaluatedParty: alpha,
      identityBundle: identity,
      requirement,
      attempts: await pinnedRequestAttempts(jobId, alpha, requirement, [
        {
          requirementPath: { kind: "required", index: 0 },
          claimSubject: alpha,
          recipe: alphaRecipe,
        },
        {
          requirementPath: { kind: "required", index: 1 },
          claimSubject: beta,
          recipe: betaRecipe,
        },
      ]),
    };
    await activateEffectLease(harness, jobId);

    const production = await partyVetCore(request, deps(harness));
    expect(isCompositeVerificationRecord(production.record)).toBe(true);
    expect(production.record).toMatchObject({
      jobId: request.jobId,
      evaluatedParty: alpha,
      bundleHash: identityBundleHash(identity),
      requirementHash: sha256Hex(canonicalize(requirement)),
      overallDecision: "pass",
    });
    expect(production.record.freshness).toEqual([]);
    expect(production.record.dealSpecific).toHaveLength(2);
    expect(new Set(
      production.record.dealSpecific.map((ref) => ref.anchor.locator),
    ).size).toBe(2);
    expect(production.recordRef.contentHash).toBe(
      contentHash(production.record as unknown as Record<string, unknown>),
    );
    expect(harness.effects).toEqual({ methods: 2, signs: 3, anchors: 3 });
    expect(harness.checkpoints.size).toBe(3);

    const replay = await partyVetCore(request, deps(harness));
    expect(canonicalize(replay)).toBe(canonicalize(production));
    expect(harness.effects).toEqual({ methods: 2, signs: 3, anchors: 3 });
  });

  test("records a failing oneOf attempt, passes on fallback, and short-circuits", async () => {
    const harness = state();
    harness.decisions.set("alpha", "fail");
    harness.decisions.set("beta", "pass");
    harness.decisions.set("gamma", "pass");
    const refs = ["alpha:alice", "beta:alice", "gamma:alice"];
    const recipes = await Promise.all(refs.map((ref) => recipe(ref.split(":")[0]!)));
    const requirement: CompositeBundleRequirement = {
      requirementVersion: "1",
      required: [],
      oneOf: [[
        { scheme: "alpha", verificationRequired: true, recipeVersion: 1 },
        { scheme: "beta", verificationRequired: true, recipeVersion: 1 },
        { scheme: "gamma", verificationRequired: true, recipeVersion: 1 },
      ]],
    };
    const jobId = "job-party-oneof";
    const paths = refs.map((_, index) => ({
      kind: "oneOf" as const,
      groupIndex: 0,
      alternativeIndex: index,
    }));
    await activateEffectLease(harness, jobId);
    const production = await partyVetCore(
      {
        jobId,
        evaluatedParty: refs[0]!,
        identityBundle: await bundle(refs[0]!, refs),
        requirement,
        attempts: await pinnedRequestAttempts(
          jobId,
          refs[0]!,
          requirement,
          refs.map((ref, index) => ({
            requirementPath: paths[index]!,
            claimSubject: ref,
            recipe: recipes[index]!,
          })),
        ),
      },
      deps(harness),
    );
    expect(production.record.overallDecision).toBe("pass");
    expect(production.record.dealSpecific).toHaveLength(2);
    expect(harness.effects).toEqual({ methods: 2, signs: 3, anchors: 3 });
    expect(
      [...harness.artifacts.values()].some(
        (entry) => isVerifyResult(entry.artifact) && entry.artifact.scheme === "gamma",
      ),
    ).toBe(false);
  });

  test("ANDs oneOf groups with exact global and group-local precedence", async () => {
    const harness = state();
    harness.decisions.set("required", "fail");
    harness.decisions.set("alpha", "fail");
    harness.decisions.set("beta", "error");
    harness.decisions.set("gamma", "fail");
    harness.decisions.set("delta", "indeterminate");
    const schemes = ["required", "alpha", "beta", "gamma", "delta"];
    const refs = schemes.map((scheme) => `${scheme}:alice`);
    const recipes = await Promise.all(schemes.map((scheme) => recipe(scheme)));
    const requirement: CompositeBundleRequirement = {
      requirementVersion: "1",
      required: [
        { scheme: "required", verificationRequired: true, recipeVersion: 1 },
      ],
      oneOf: [
        [
          { scheme: "alpha", verificationRequired: true, recipeVersion: 1 },
          { scheme: "beta", verificationRequired: true, recipeVersion: 1 },
        ],
        [
          { scheme: "gamma", verificationRequired: true, recipeVersion: 1 },
          { scheme: "delta", verificationRequired: true, recipeVersion: 1 },
        ],
      ],
    };
    const paths: PartyVetRequest["attempts"][number]["requirementPath"][] = [
      { kind: "required", index: 0 },
      { kind: "oneOf", groupIndex: 0, alternativeIndex: 0 },
      { kind: "oneOf", groupIndex: 0, alternativeIndex: 1 },
      { kind: "oneOf", groupIndex: 1, alternativeIndex: 0 },
      { kind: "oneOf", groupIndex: 1, alternativeIndex: 1 },
    ];
    const jobId = "job-party-precedence";
    await activateEffectLease(harness, jobId);
    const production = await partyVetCore(
      {
        jobId,
        evaluatedParty: refs[0]!,
        identityBundle: await bundle(refs[0]!, refs),
        requirement,
        attempts: await pinnedRequestAttempts(
          jobId,
          refs[0]!,
          requirement,
          refs.map((ref, index) => ({
            requirementPath: paths[index]!,
            claimSubject: ref,
            recipe: recipes[index]!,
          })),
        ),
      },
      deps(harness),
    );
    expect(production.record.overallDecision).toBe("fail");
    expect(production.record.dealSpecific).toHaveLength(5);
  });

  test("uses exact party-level addresses and concurrent callers converge", async () => {
    const harness = state();
    const alphaRecipe = await recipe("alpha");
    const subject = "alpha:alice";
    const jobId = "job-party-concurrent";
    const requirement: CompositeBundleRequirement = {
      requirementVersion: "1",
      required: [
        { scheme: "alpha", verificationRequired: true, recipeVersion: 1 },
      ],
    };
    const request: PartyVetRequest = {
      jobId,
      evaluatedParty: subject,
      identityBundle: await bundle(subject, [subject]),
      requirement,
      attempts: await pinnedRequestAttempts(jobId, subject, requirement, [{
        requirementPath: { kind: "required", index: 0 },
        claimSubject: subject,
        recipe: alphaRecipe,
      }]),
    };
    await activateEffectLease(harness, jobId);
    const [left, right] = await Promise.all([
      partyVetCore(request, deps(harness)),
      partyVetCore(request, deps(harness)),
    ]);
    expect(canonicalize(left)).toBe(canonicalize(right));
    expect(left.recordRef.anchor.locator).toBe(
      `memory:${partyVetCompositeAddress(request.jobId, subject)}`,
    );
    expect(harness.effects).toEqual({ methods: 1, signs: 2, anchors: 2 });

    const bob = "alpha:bob";
    const bobAttempts = await pinnedRequestAttempts(jobId, bob, requirement, [{
      requirementPath: { kind: "required", index: 0 },
      claimSubject: bob,
      recipe: alphaRecipe,
    }]);
    const bobProduction = await partyVetCore(
      {
        ...request,
        evaluatedParty: bob,
        identityBundle: await bundle(bob, [bob]),
        attempts: bobAttempts,
      },
      deps(harness),
    );
    expect(bobProduction.recordRef.anchor.locator).not.toBe(
      left.recordRef.anchor.locator,
    );
  });

  test.each(["mocked", "failed"] as const)(
    "%s availability produces an authenticated aggregate error without a proxy call",
    async (availability) => {
      const harness = state();
      const request = await singleClaimRequest(
        `job-party-availability-${availability}`,
        availability,
      );
      await activateEffectLease(harness, request.jobId);
      const production = await partyVetCore(request, deps(harness));
      expect(production.record.overallDecision).toBe("error");
      expect(production.record.dealSpecific).toHaveLength(1);
      expect(harness.effects).toEqual({ methods: 0, signs: 2, anchors: 3 });
      const resultArtifacts = [...harness.artifacts.values()]
        .filter((entry) => isVerifyResult(entry.artifact));
      expect(resultArtifacts).toHaveLength(1);
      expect(resultArtifacts[0]!.artifact).toMatchObject({
        decision: "error",
        data: {
          recipeAvailability: { availability },
        },
      });
    },
  );

  test.each(["operator_gated", "closed_data", "bilateral"] as const)(
    "%s availability executes the authenticated method",
    async (availability) => {
      const harness = state();
      const request = await singleClaimRequest(
        `job-party-availability-${availability}`,
        availability,
      );
      await activateEffectLease(harness, request.jobId);
      const production = await partyVetCore(request, deps(harness));
      expect(production.record.overallDecision).toBe("pass");
      expect(harness.effects.methods).toBe(1);
    },
  );

  test("rejects disabled recipes before any party Vet effect", async () => {
    await expect(singleClaimRequest(
      "job-party-availability-disabled",
      "disabled",
    )).rejects.toThrow(/disabled|provenance bindings/);
  });

  test("rejects an unauthenticated presentation before method, sign, anchor or checkpoint", async () => {
    const harness = state();
    const request = await singleClaimRequest("job-party-bad-presentation");
    await activateEffectLease(harness, request.jobId);
    await expect(partyVetCore(
      request,
      deps(harness, { presentationValid: false }),
    )).rejects.toThrow(/presentation is not authenticated/);
    expect(harness.effects).toEqual({ methods: 0, signs: 0, anchors: 0 });
    expect(harness.checkpoints.size).toBe(0);
  });

  test("rejects a signer returning random bytes before result anchoring", async () => {
    const harness = state();
    const request = await singleClaimRequest("job-party-random-signature");
    await activateEffectLease(harness, request.jobId);
    await expect(partyVetCore(
      request,
      deps(harness, { randomSignatures: true }),
    )).rejects.toThrow(/component signature is not authenticated/);
    expect(harness.effects.methods).toBe(1);
    expect(harness.effects.signs).toBe(1);
    expect(harness.effects.anchors).toBe(0);
  });

  test("rejects a complete party checkpoint whose finalized attempt checkpoint is missing", async () => {
    const harness = state();
    const request = await singleClaimRequest("job-party-partial-complete");
    await activateEffectLease(harness, request.jobId);
    const production = await partyVetCore(request, deps(harness));
    const before = structuredClone(harness.effects);
    const partyAddress = partyVetCompositeAddress(
      request.jobId,
      request.evaluatedParty,
    );
    const attemptKey = [...harness.checkpoints.keys()]
      .find((key) => key !== partyAddress);
    if (!attemptKey) throw new Error("expected an attempt checkpoint");
    harness.checkpoints.delete(attemptKey);

    await expect(partyVetCore(request, deps(harness))).rejects.toThrow(
      /missing an exact finalized attempt checkpoint/,
    );
    expect(harness.effects).toEqual(before);
    expect(isCompositeVerificationRecord(production.record)).toBe(true);
  });

  test("fences stale generation 2 before effects and lets generation 3 take over", async () => {
    const harness = state();
    const request = await singleClaimRequest("job-party-generation-takeover");
    await activateEffectLease(harness, request.jobId, "worker-generation-1");
    await takeOverEffectLease(harness, "worker-generation-2");
    const staleGenerationTwoDeps = deps(harness);
    harness.beforeAuthorizedEffect = async ({ step }) => {
      if (step !== "method") return;
      harness.beforeAuthorizedEffect = undefined;
      await takeOverEffectLease(harness, "worker-generation-3");
    };

    await expect(partyVetCore(request, staleGenerationTwoDeps)).rejects.toThrow(
      /method effect authorization was fenced/,
    );
    expect(harness.effects).toEqual({ methods: 0, signs: 0, anchors: 0 });
    expect(harness.steps.size).toBe(0);
    expect(harness.checkpoints.size).toBe(2);

    const production = await partyVetCore(request, deps(harness));
    expect(production.record.overallDecision).toBe("pass");
    expect(harness.effects).toEqual({ methods: 1, signs: 2, anchors: 2 });
    expect(harness.effectLease?.generation).toBe(3);
  });
});

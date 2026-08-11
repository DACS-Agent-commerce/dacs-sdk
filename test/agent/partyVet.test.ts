import { describe, expect, test } from "vitest";

import {
  canonicalize,
  contentHash,
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
  resolveRecipe,
  sha256Hex,
  signComponentArtifact,
  signedBytes,
  type AttestationRef,
  type CompositeBundleRequirement,
  type FinalizedVetAnchor,
  type FinalizedVetAnchorReceipt,
  type IdentityBundle,
  type PartyVetDeps,
  type PartyVetRequest,
  type RecipeDescriptor,
  type VerifyResult,
} from "../../src/index.js";

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
}

function state(): HarnessState {
  return {
    checkpoints: new Map(),
    steps: new Map(),
    inflight: new Map(),
    artifacts: new Map(),
    decisions: new Map(),
    effects: { methods: 0, signs: 0, anchors: 0 },
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
        fetchedAt: NOW,
        complete: true,
      };
    },
    nowMs: () => NOW,
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
  return resolveRecipe(
    "memory:party-recipes",
    { scheme, method: "consensus-backed-proxy", recipeVersion: 1 },
    {
      readRegistry: async () => ({
        registryId: "dacs2:registry:v1",
        version: "1",
        entries: [signed],
      }),
      stewardPublicKey: STEWARD_KEY,
      stewardSigner: STEWARD,
      verify: (bytes, signature, publicKey) =>
        ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
    },
  );
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
  authenticatedRecipe: Awaited<ReturnType<typeof recipe>>,
): PartyVetRequest["attempts"][number] {
  return {
    requirementPath,
    claimSubject,
    recipe: authenticatedRecipe,
    methodInput: { kind: "consensus-backed-proxy" },
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
    const request: PartyVetRequest = {
      jobId: "job-party-required",
      evaluatedParty: alpha,
      identityBundle: identity,
      requirement,
      attempts: [
        attempt({ kind: "required", index: 0 }, alpha, alphaRecipe),
        attempt({ kind: "required", index: 1 }, beta, betaRecipe),
      ],
    };

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
    const production = await partyVetCore(
      {
        jobId: "job-party-oneof",
        evaluatedParty: refs[0]!,
        identityBundle: await bundle(refs[0]!, refs),
        requirement,
        attempts: refs.map((ref, index) => attempt(
          { kind: "oneOf", groupIndex: 0, alternativeIndex: index },
          ref,
          recipes[index]!,
        )),
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
    const production = await partyVetCore(
      {
        jobId: "job-party-precedence",
        evaluatedParty: refs[0]!,
        identityBundle: await bundle(refs[0]!, refs),
        requirement,
        attempts: refs.map((ref, index) => attempt(paths[index]!, ref, recipes[index]!)),
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
    const request: PartyVetRequest = {
      jobId: "job-party-concurrent",
      evaluatedParty: subject,
      identityBundle: await bundle(subject, [subject]),
      requirement: {
        requirementVersion: "1",
        required: [
          { scheme: "alpha", verificationRequired: true, recipeVersion: 1 },
        ],
      },
      attempts: [attempt({ kind: "required", index: 0 }, subject, alphaRecipe)],
    };
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
    const bobProduction = await partyVetCore(
      {
        ...request,
        evaluatedParty: bob,
        identityBundle: await bundle(bob, [bob]),
        attempts: [attempt({ kind: "required", index: 0 }, bob, alphaRecipe)],
      },
      deps(harness),
    );
    expect(bobProduction.recordRef.anchor.locator).not.toBe(
      left.recordRef.anchor.locator,
    );
  });
});

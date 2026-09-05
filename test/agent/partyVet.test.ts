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
  PARTY_VET_NATIVE_CCI_TLSN_SIGNAL_TYPE,
  partyVetCompositeAddress,
  partyVetCore,
  partyVetWithNativeCciTlsnCore,
  partyVetPinScopeHash,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
  readPartyVetNativeCciTlsnEvidence,
  sha256Hex,
  signComponentArtifact,
  signedBytes,
  verifyCompositeVerificationRecord,
  type AttestationRef,
  type CompositeBundleRequirement,
  type CciTlsnDisposition,
  type FinalizedVetAnchor,
  type FinalizedVetAnchorReceipt,
  type FencedSessionStoreV2,
  type FencedSessionLeaseTokenV2,
  type IdentityBundle,
  type ExpectedVerifyResult,
  type PartyVetDeps,
  type PartyVetNativeCciTlsnQualifier,
  type PartyVetRequest,
  type PartyVetWithNativeCciTlsnRequest,
  type RecipeDescriptor,
  type SubstrateAdapter,
  type VerifyNativeCciTlsnInput,
  type VerifyResult,
} from "../../src/index.js";
import { buildAgent } from "../../src/agent/Agent.js";
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
  authorizedExecutions: Map<string, number>;
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
  loseAuthorizedResponseAt?: string;
  lostAuthorizedResponses: Set<string>;
}

function state(): HarnessState {
  return {
    checkpoints: new Map(),
    steps: new Map(),
    authorizedExecutions: new Map(),
    inflight: new Map(),
    artifacts: new Map(),
    decisions: new Map(),
    effects: { methods: 0, signs: 0, anchors: 0 },
    effectStore: createInMemoryFencedSessionStore(),
    now: NOW,
    lostAuthorizedResponses: new Set(),
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
        let created = false;
        if (!pending) {
          created = true;
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
              harness.authorizedExecutions.set(
                key,
                (harness.authorizedExecutions.get(key) ?? 0) + 1,
              );
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
        if (
          created &&
          harness.loseAuthorizedResponseAt === step &&
          !harness.lostAuthorizedResponses.has(key)
        ) {
          harness.lostAuthorizedResponses.add(key);
          throw new Error(`simulated authorized ${step} response loss`);
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
  sessionNonce?: string,
): Promise<IdentityBundle> {
  const unsigned: IdentityBundle = {
    bundleVersion: "1",
    presentedBy,
    presentedAt: NOW - 1_000,
    ...(sessionNonce === undefined ? {} : { sessionNonce }),
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
  identityBundle: IdentityBundle,
  requirement: CompositeBundleRequirement,
  specs: readonly {
    requirementPath: PartyVetRequest["attempts"][number]["requirementPath"];
    claimSubject: string;
    recipe: Awaited<ReturnType<typeof recipe>>;
    classification?: "freshness" | "dealSpecific";
  }[],
): Promise<PartyVetRequest["attempts"]> {
  const partyPlanHash = partyVetPinScopeHash({
    jobId,
    evaluatedParty,
    identityBundle,
    requirement,
    verifier: { algorithm: "ed25519", signer: VERIFIER },
    attempts: specs.map((spec) => ({
      requirementPath: spec.requirementPath,
      claimSubject: spec.claimSubject,
      classification: spec.classification ?? "dealSpecific",
      methodInput: { kind: "consensus-backed-proxy" as const },
    })),
  });
  const pins = await createPartyVetPins({
    jobId,
    evaluatedParty,
    sessionStartHash: partyPlanHash,
    partyPlanHash,
    bundleRequirement: requirement,
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

async function storeCarriedResult(
  harness: HarnessState,
  subject: string,
  options: {
    fetchedAt?: number;
    verifiedAt?: number;
    validUntil?: number;
    decision?: VerifyResult["decision"];
    signingSeed?: Uint8Array;
    corruptReadback?: boolean;
  } = {},
): Promise<NonNullable<IdentityBundle["claims"][number]["verifiedBy"]>> {
  const separator = subject.indexOf(":");
  const scheme = subject.slice(0, separator);
  const identifier = subject.slice(separator + 1);
  const result = await signComponentArtifact(
    {
      resultVersion: "1" as const,
      scheme,
      identifier,
      recipeVersion: 1,
      method: "consensus-backed-proxy" as const,
      decision: options.decision ?? "pass",
      reason: "authenticated carried verification",
      attestation: {
        anchor: {
          kind: "https" as const,
          locator: `https://authority.example/carried/${scheme}`,
        },
        contentHash: sha256Hex(`carried:${subject}`),
        signer: "substrate-validator-set:demos-testnet:1",
      },
      fetchedAt: options.fetchedAt ?? NOW - 2_000,
      verifiedAt: options.verifiedAt ?? NOW - 1_000,
      ...(options.validUntil !== undefined
        ? { validUntil: options.validUntil }
        : {}),
    },
    "dacs-verifyresult:v1:",
    {
      algorithm: "ed25519",
      signer: VERIFIER,
      sign: (bytes) => ed25519Sign(
        bytes,
        privateKeyFromSeed(options.signingSeed ?? VERIFIER_SEED),
      ),
    },
  );
  const hash = contentHash(result as unknown as Record<string, unknown>);
  const logicalAddress = `dacs2:carried:${subject}`;
  const nativeAddress = `memory:${logicalAddress}:${hash}`;
  const ref: AttestationRef = {
    anchor: { kind: "storage-program", locator: nativeAddress },
    contentHash: hash,
  };
  const artifact = structuredClone(result) as unknown as Record<string, unknown>;
  if (options.corruptReadback) {
    artifact.reason = "different bytes returned from the anchored address";
  }
  harness.artifacts.set(logicalAddress, {
    logicalAddress,
    artifact,
    ref,
    receipt: receiptFor(logicalAddress, nativeAddress, hash),
  });
  return {
    anchor: structuredClone(ref.anchor),
    contentHash: hash,
    recipeVersion: 1,
  };
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
  const identityBundle = await bundle(subject, [subject]);
  return {
    jobId,
    evaluatedParty: subject,
    identityBundle,
    requirement,
    attempts: await pinnedRequestAttempts(jobId, subject, identityBundle, requirement, [{
      requirementPath: { kind: "required", index: 0 },
      claimSubject: subject,
      recipe: signedRecipe,
    }]),
  };
}

const NATIVE_CCI_JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7E";
const NATIVE_CCI_PROOF_HASH = "ab".repeat(32);
const NATIVE_CCI_SESSION_NONCE = "party-vet-session-nonce-1";
const DEMOS_CCI_SUBJECT =
  `did:demos:agent:${"11".repeat(32)}`;

async function nativeCciPartyRequest(
  subject = "alpha:alice",
  jobId = NATIVE_CCI_JOB_ID,
): Promise<PartyVetWithNativeCciTlsnRequest> {
  const scheme = subject.slice(0, subject.indexOf(":"));
  const nativeRef = `cci-tlsn:${NATIVE_CCI_PROOF_HASH}`;
  const requirement: CompositeBundleRequirement = {
    requirementVersion: "1",
    required: [
      { scheme, verificationRequired: true, recipeVersion: 1 },
    ],
  };
  const identityBundle = await bundle(
    subject,
    [subject, nativeRef],
    undefined,
    NATIVE_CCI_SESSION_NONCE,
  );
  return {
    vet: {
      jobId,
      evaluatedParty: subject,
      identityBundle,
      requirement,
      attempts: await pinnedRequestAttempts(
        jobId,
        subject,
        identityBundle,
        requirement,
        [{
          requirementPath: { kind: "required", index: 0 },
          claimSubject: subject,
          recipe: await recipe(scheme),
        }],
      ),
    },
    nativeCciTlsn: [{
      proofHash: NATIVE_CCI_PROOF_HASH,
      sessionNonce: NATIVE_CCI_SESSION_NONCE,
      expectedServer: "github.com",
      maxResolutionAgeSec: 60,
      maxProofAgeSec: 60,
      maxPresentationAgeSec: 60,
    }],
  };
}

function nativeCciDisposition(
  input: Parameters<PartyVetNativeCciTlsnQualifier>[0],
  overrides: {
    subject?: string;
    jobId?: string;
    sessionNonce?: string;
    bundleHash?: string;
    proofHash?: string;
    claimObservedAt?: number;
    resolutionObservedAt?: number;
    verifiedAt?: number;
    evaluatedAt?: number;
  } = {},
): CciTlsnDisposition {
  const subject = overrides.subject ?? input.subject;
  const jobId = overrides.jobId ?? input.context.jobId;
  const sessionNonce = overrides.sessionNonce ?? input.context.sessionNonce;
  const bundleHash = overrides.bundleHash ?? identityBundleHash(input.bundle);
  const proofHash = overrides.proofHash ?? input.proofHash;
  const claimObservedAt = overrides.claimObservedAt ?? NOW - 3_000;
  const resolutionObservedAt = overrides.resolutionObservedAt ?? NOW - 2_000;
  const verifiedAt = overrides.verifiedAt ?? NOW;
  const evaluatedAt = overrides.evaluatedAt ?? input.context.evaluatedAt;
  return {
    status: "native-cci",
    claim: {
      kind: "tlsn",
      context: "github",
      username: "alice",
      userId: "42",
      proofHash,
      observedAt: claimObservedAt,
      ref: `cci-tlsn:${proofHash}`,
    },
    jobId,
    sessionNonce,
    bundleHash,
    evaluatedAt,
    verification: {
      verifiedAt,
      authority: "native-tlsn:testnet",
      binding: {
        subject,
        jobId,
        sessionNonce,
        expectedServer: input.context.expectedServer,
        bundleHash,
        proofHash,
        resolutionObservedAt,
      },
      evidence: { transcript: `tlsn:${proofHash}` },
    },
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
      attempts: await pinnedRequestAttempts(jobId, alpha, identity, requirement, [
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

    const expectedDealSpecific: ExpectedVerifyResult[] = [
      {
        ref: production.record.dealSpecific[0]!,
        scheme: "alpha",
        identifier: "alice",
        method: "consensus-backed-proxy",
        requirement: requirement.required[0]!,
      },
      {
        ref: production.record.dealSpecific[1]!,
        scheme: "beta",
        identifier: "alice",
        method: "consensus-backed-proxy",
        requirement: requirement.required[1]!,
      },
    ];
    const strict = await verifyCompositeVerificationRecord(
      production.record,
      {
        jobId,
        evaluatedParty: alpha,
        bundleHash: identityBundleHash(identity),
        requirement,
        verifier: VERIFIER,
        freshness: [],
        dealSpecific: expectedDealSpecific,
      },
      {
        nowMs: () => harness.now,
        resolve: async (ref) => {
          const stored = [...harness.artifacts.values()].find(
            (entry) => entry.ref.anchor.locator === ref.anchor.locator,
          );
          if (stored) {
            return {
              encoding: "canonical-json" as const,
              value: structuredClone(stored.artifact),
            };
          }
          if (ref.anchor.locator.startsWith(
            "https://authority.example/evidence/",
          )) {
            return {
              encoding: "bytes" as const,
              value: Uint8Array.from(Buffer.from(JSON.stringify({ ok: true }))),
            };
          }
          return null;
        },
        resolveRecipe: async ({ scheme }) =>
          scheme === "alpha"
            ? alphaRecipe
            : scheme === "beta"
              ? betaRecipe
              : null,
        isRecipeSignerAuthorized: (_recipe, signature) =>
          signature.signer === STEWARD,
        isVerifyResultSignerAuthorized: (_result, signature) =>
          signature.signer === VERIFIER,
        resolvePublicKey: (signature) => {
          if (signature.signer === VERIFIER) return VERIFIER_KEY;
          if (signature.signer === STEWARD) return STEWARD_KEY;
          return null;
        },
        verify: ({ signedBytes: bytes, signature, publicKey }) =>
          ed25519Verify(
            bytes,
            Uint8Array.from(Buffer.from(signature.value, "base64url")),
            publicKeyFromRaw(publicKey),
          ),
        verifyAuthorityAttestation: () => "valid",
      },
    );
    expect(strict).toMatchObject({
      status: "valid",
      record: { overallDecision: "pass" },
    });

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
    const identity = await bundle(refs[0]!, refs);
    await activateEffectLease(harness, jobId);
    const production = await partyVetCore(
      {
        jobId,
        evaluatedParty: refs[0]!,
        identityBundle: identity,
        requirement,
        attempts: await pinnedRequestAttempts(
          jobId,
          refs[0]!,
          identity,
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
    const identity = await bundle(refs[0]!, refs);
    await activateEffectLease(harness, jobId);
    const production = await partyVetCore(
      {
        jobId,
        evaluatedParty: refs[0]!,
        identityBundle: identity,
        requirement,
        attempts: await pinnedRequestAttempts(
          jobId,
          refs[0]!,
          identity,
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
    const identity = await bundle(subject, [subject]);
    const request: PartyVetRequest = {
      jobId,
      evaluatedParty: subject,
      identityBundle: identity,
      requirement,
      attempts: await pinnedRequestAttempts(jobId, subject, identity, requirement, [{
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
    const bobIdentity = await bundle(bob, [bob]);
    const bobAttempts = await pinnedRequestAttempts(jobId, bob, bobIdentity, requirement, [{
      requirementPath: { kind: "required", index: 0 },
      claimSubject: bob,
      recipe: alphaRecipe,
    }]);
    const bobProduction = await partyVetCore(
      {
        ...request,
        evaluatedParty: bob,
        identityBundle: bobIdentity,
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

  test("rejects a presence-only requirement instead of signing a CVR that strict aggregation would fail", async () => {
    const harness = state();
    const subject = "alpha:alice";
    const jobId = "job-party-presence-only";
    const requirement: CompositeBundleRequirement = {
      requirementVersion: "1",
      required: [{ scheme: "alpha", verificationRequired: false }],
    };
    await activateEffectLease(harness, jobId);
    await expect(partyVetCore(
      {
        jobId,
        evaluatedParty: subject,
        identityBundle: await bundle(subject, [subject]),
        requirement,
        attempts: [],
      },
      deps(harness),
    )).rejects.toThrow(/strict CVR.*presence-only required claim/);
    expect(harness.effects).toEqual({ methods: 0, signs: 0, anchors: 0 });
    expect(harness.checkpoints.size).toBe(0);
  });

  test("rejects external recipe execution for a native cci-tlsn commitment", async () => {
    const harness = state();
    const subject = `cci-tlsn:${"ab".repeat(32)}`;
    const jobId = "job-party-native-tlsn";
    const requirement: CompositeBundleRequirement = {
      requirementVersion: "1",
      required: [{
        scheme: "cci-tlsn",
        verificationRequired: true,
        recipeVersion: 1,
      }],
    };
    const identity = await bundle(subject, [subject]);
    const attempts = await pinnedRequestAttempts(
      jobId,
      subject,
      identity,
      requirement,
      [{
        requirementPath: { kind: "required", index: 0 },
        claimSubject: subject,
        recipe: await recipe("cci-tlsn"),
      }],
    );
    await activateEffectLease(harness, jobId);

    await expect(partyVetCore(
      {
        jobId,
        evaluatedParty: subject,
        identityBundle: identity,
        requirement,
        attempts,
      },
      deps(harness),
    )).rejects.toThrow(/cannot re-verify a native cci-tlsn claim/);
    expect(harness.effects).toEqual({ methods: 0, signs: 0, anchors: 0 });
    expect(harness.checkpoints.size).toBe(0);
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

  test("ignores self-reported issuedAt without verifiedBy and performs deal-specific verification", async () => {
    const harness = state();
    const subject = "alpha:alice";
    const jobId = "job-party-self-reported-issued-at";
    const requirement: CompositeBundleRequirement = {
      requirementVersion: "1",
      required: [
        { scheme: "alpha", verificationRequired: true, recipeVersion: 1 },
      ],
    };
    const identity = await bundle(subject, [subject], [{
      ref: subject,
      issuedAt: NOW + 10_000,
      expiresAt: NOW + 20_000,
    }]);
    const request: PartyVetRequest = {
      jobId,
      evaluatedParty: subject,
      identityBundle: identity,
      requirement,
      attempts: await pinnedRequestAttempts(
        jobId,
        subject,
        identity,
        requirement,
        [{
          requirementPath: { kind: "required", index: 0 },
          claimSubject: subject,
          recipe: await recipe("alpha"),
          classification: "dealSpecific",
        }],
      ),
    };
    await activateEffectLease(harness, jobId);

    const production = await partyVetCore(request, deps(harness));
    expect(production.record.freshness).toEqual([]);
    expect(production.record.dealSpecific).toHaveLength(1);
    expect(production.record.overallDecision).toBe("pass");
  });

  test("authenticates a carried VerifyResult before classifying the new result as freshness", async () => {
    const harness = state();
    const subject = "alpha:alice";
    const jobId = "job-party-carried-result";
    const requirement: CompositeBundleRequirement = {
      requirementVersion: "1",
      required: [
        { scheme: "alpha", verificationRequired: true, recipeVersion: 1 },
      ],
    };
    const verifiedBy = await storeCarriedResult(harness, subject, {
      validUntil: NOW + 10_000,
    });
    const identity = await bundle(subject, [subject], [{
      ref: subject,
      verifiedBy,
      issuedAt: NOW - 2_000,
      expiresAt: NOW + 5_000,
    }]);
    const request: PartyVetRequest = {
      jobId,
      evaluatedParty: subject,
      identityBundle: identity,
      requirement,
      attempts: await pinnedRequestAttempts(
        jobId,
        subject,
        identity,
        requirement,
        [{
          requirementPath: { kind: "required", index: 0 },
          claimSubject: subject,
          recipe: await recipe("alpha"),
          classification: "freshness",
        }],
      ),
    };
    await activateEffectLease(harness, jobId);

    const production = await partyVetCore(request, deps(harness));
    expect(production.record.freshness).toHaveLength(1);
    expect(production.record.dealSpecific).toEqual([]);
    expect(harness.effects).toEqual({ methods: 1, signs: 2, anchors: 2 });
  });

  test.each([
    {
      label: "expired authority and presenter windows",
      carried: {
        fetchedAt: NOW - 3_000,
        verifiedAt: NOW - 2_000,
        validUntil: NOW - 1,
      },
      claimTimes: {
        // Presenter extensions are ignored/clamped; they never widen authority.
        issuedAt: NOW + 10_000,
        expiresAt: NOW + 20_000,
      },
    },
    {
      label: "an expired recipe-default window with no validUntil",
      carried: {
        fetchedAt: NOW - 3_700_100,
        verifiedAt: NOW - 3_700_000,
      },
      claimTimes: {},
    },
  ] as const)(
    "authenticates and refreshes $label instead of reusing stale evidence",
    async ({ label, carried, claimTimes }) => {
      const harness = state();
      const subject = "alpha:alice";
      const jobId = `job-party-refresh-${sha256Hex(label)}`;
      const requirement: CompositeBundleRequirement = {
        requirementVersion: "1",
        required: [{
          scheme: "alpha",
          verificationRequired: true,
          recipeVersion: 1,
          maxAge: 60,
        }],
      };
      const verifiedBy = await storeCarriedResult(harness, subject, carried);
      const identity = await bundle(subject, [subject], [{
        ref: subject,
        verifiedBy,
        ...claimTimes,
      }]);
      const request: PartyVetRequest = {
        jobId,
        evaluatedParty: subject,
        identityBundle: identity,
        requirement,
        attempts: await pinnedRequestAttempts(
          jobId,
          subject,
          identity,
          requirement,
          [{
            requirementPath: { kind: "required", index: 0 },
            claimSubject: subject,
            recipe: await recipe("alpha"),
            classification: "freshness",
          }],
        ),
      };
      await activateEffectLease(harness, jobId);

      const production = await partyVetCore(request, deps(harness));
      expect(production.record.freshness).toHaveLength(1);
      expect(production.record.freshness[0]!.anchor.locator).not.toBe(
        verifiedBy.anchor.locator,
      );
      expect(production.record.freshness[0]!.contentHash).not.toBe(
        verifiedBy.contentHash,
      );
      expect(harness.effects).toEqual({ methods: 1, signs: 2, anchors: 2 });
    },
  );

  test("does not grant freshness provenance to a carried non-pass result", async () => {
    const harness = state();
    const subject = "alpha:alice";
    const jobId = "job-party-carried-prior-fail";
    const requirement: CompositeBundleRequirement = {
      requirementVersion: "1",
      required: [
        { scheme: "alpha", verificationRequired: true, recipeVersion: 1 },
      ],
    };
    const verifiedBy = await storeCarriedResult(harness, subject, {
      decision: "fail",
    });
    const identity = await bundle(subject, [subject], [{ ref: subject, verifiedBy }]);
    const request: PartyVetRequest = {
      jobId,
      evaluatedParty: subject,
      identityBundle: identity,
      requirement,
      attempts: await pinnedRequestAttempts(
        jobId,
        subject,
        identity,
        requirement,
        [{
          requirementPath: { kind: "required", index: 0 },
          claimSubject: subject,
          recipe: await recipe("alpha"),
          classification: "dealSpecific",
        }],
      ),
    };
    await activateEffectLease(harness, jobId);

    const production = await partyVetCore(request, deps(harness));
    expect(production.record.freshness).toEqual([]);
    expect(production.record.dealSpecific).toHaveLength(1);
    expect(production.record.overallDecision).toBe("pass");
  });

  test.each([
    {
      label: "a cryptographically invalid component signature",
      carried: { signingSeed: new Uint8Array(32).fill(99) },
      claimExpiresAt: undefined,
      expected: /component signature is not authenticated/,
    },
    {
      label: "future authenticated timestamps",
      carried: { verifiedAt: NOW + 1 },
      claimExpiresAt: undefined,
      expected: /future or inconsistent timestamps/,
    },
    {
      label: "anchored readback bytes that do not match the bound hash",
      carried: { corruptReadback: true },
      claimExpiresAt: undefined,
      expected: /carried VerifyResult.*mismatched/,
    },
    {
      label: "an expired presenter clamp",
      carried: {},
      claimExpiresAt: NOW - 1,
      expected: /expired presenter clamp/,
    },
  ] as const)(
    "rejects carried evidence with $label before any party Vet effect",
    async ({ label, carried, claimExpiresAt, expected }) => {
      const harness = state();
      const subject = "alpha:alice";
      const jobId = `job-party-bad-carried-${sha256Hex(label)}`;
      const requirement: CompositeBundleRequirement = {
        requirementVersion: "1",
        required: [
          { scheme: "alpha", verificationRequired: true, recipeVersion: 1 },
        ],
      };
      const verifiedBy = await storeCarriedResult(harness, subject, carried);
      const identity = await bundle(subject, [subject], [{
        ref: subject,
        verifiedBy,
        issuedAt: NOW - 2_000,
        ...(claimExpiresAt !== undefined
          ? { expiresAt: claimExpiresAt }
          : {}),
      }]);
      const request: PartyVetRequest = {
        jobId,
        evaluatedParty: subject,
        identityBundle: identity,
        requirement,
        attempts: await pinnedRequestAttempts(
          jobId,
          subject,
          identity,
          requirement,
          [{
            requirementPath: { kind: "required", index: 0 },
            claimSubject: subject,
            recipe: await recipe("alpha"),
            classification: "freshness",
          }],
        ),
      };
      await activateEffectLease(harness, jobId);

      await expect(partyVetCore(request, deps(harness))).rejects.toThrow(expected);
      expect(harness.effects).toEqual({ methods: 0, signs: 0, anchors: 0 });
      expect(harness.checkpoints.size).toBe(0);
    },
  );

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

  test.each([
    ["method", "live"],
    ["method-evidence", "mocked"],
    ["verify-result", "live"],
    ["verify-result-anchor", "live"],
    ["composite", "live"],
    ["composite-anchor", "live"],
  ] as const)(
    "recovers exact bytes after a journaled %s response is lost",
    async (step, availability) => {
      const harness = state();
      const request = await singleClaimRequest(
        `job-party-response-loss-${step}`,
        availability,
      );
      await activateEffectLease(harness, request.jobId);
      harness.loseAuthorizedResponseAt = step;

      await expect(partyVetCore(request, deps(harness))).rejects.toThrow(
        new RegExp(`party Vet ${step} authorized run failed`),
      );
      const production = await partyVetCore(request, deps(harness));
      const replay = await partyVetCore(request, deps(harness));
      expect(canonicalize(replay)).toBe(canonicalize(production));

      const matchingExecutions = [...harness.authorizedExecutions.entries()]
        .filter(([key]) => key.endsWith(`\u0000${step}`));
      expect(matchingExecutions).toHaveLength(1);
      expect(matchingExecutions[0]![1]).toBe(1);
      expect(harness.effects).toEqual(
        availability === "mocked"
          ? { methods: 0, signs: 2, anchors: 3 }
          : { methods: 1, signs: 2, anchors: 2 },
      );
    },
  );
});

describe("partyVetWithNativeCciTlsnCore", () => {
  test("qualifies native CCI as a mandatory gate and retains exact signed CVR provenance", async () => {
    const harness = state();
    const request = await nativeCciPartyRequest();
    await activateEffectLease(harness, request.vet.jobId);
    let qualifierCalls = 0;
    const qualifier: PartyVetNativeCciTlsnQualifier = (input) => {
      qualifierCalls += 1;
      expect(input).toMatchObject({
        subject: request.vet.evaluatedParty,
        proofHash: NATIVE_CCI_PROOF_HASH,
        context: {
          jobId: NATIVE_CCI_JOB_ID,
          expectedPresenter: request.vet.evaluatedParty,
          sessionNonce: NATIVE_CCI_SESSION_NONCE,
          expectedServer: "github.com",
          evaluatedAt: NOW,
        },
      });
      expect(Object.isFrozen(input)).toBe(true);
      return nativeCciDisposition(input);
    };

    const production = await partyVetWithNativeCciTlsnCore(
      request,
      deps(harness),
      qualifier,
    );
    expect(production.record.overallDecision).toBe("pass");
    expect(production.record.supplementary).toHaveLength(1);
    expect(production.record.supplementary[0]).toMatchObject({
      source: "cci-tlsn",
      signalType: PARTY_VET_NATIVE_CCI_TLSN_SIGNAL_TYPE,
      observedAt: NOW,
    });
    const retained = readPartyVetNativeCciTlsnEvidence(
      production.record.supplementary[0],
    );
    expect(retained).toEqual(production.nativeCciTlsn[0]);
    expect(retained).toMatchObject({
      evidenceVersion: "1",
      subject: request.vet.evaluatedParty,
      claimRef: `cci-tlsn:${NATIVE_CCI_PROOF_HASH}`,
      jobId: NATIVE_CCI_JOB_ID,
      sessionNonce: NATIVE_CCI_SESSION_NONCE,
      expectedServer: "github.com",
      bundleHash: identityBundleHash(request.vet.identityBundle),
      proofHash: NATIVE_CCI_PROOF_HASH,
      evaluatedAt: NOW,
      claimObservedAt: NOW - 3_000,
      resolutionObservedAt: NOW - 2_000,
      verifiedAt: NOW,
      authority: "native-tlsn:testnet",
      nativeEvidenceHash: sha256Hex(canonicalize({
        transcript: `tlsn:${NATIVE_CCI_PROOF_HASH}`,
      })),
    });
    expect(harness.effects).toEqual({ methods: 1, signs: 2, anchors: 2 });
    expect(qualifierCalls).toBe(1);

    const replay = await partyVetWithNativeCciTlsnCore(
      request,
      deps(harness),
      () => {
        qualifierCalls += 1;
        throw new Error("durable replay must not invoke the qualifier");
      },
    );
    expect(canonicalize(replay)).toBe(canonicalize(production));
    expect(harness.effects).toEqual({ methods: 1, signs: 2, anchors: 2 });
    expect(qualifierCalls).toBe(1);
  });

  test("exercises the positive path through the public Agent API", async () => {
    const harness = state();
    const qualifiedSubject = `${DEMOS_CCI_SUBJECT}?network=testnet`;
    const request = await nativeCciPartyRequest(qualifiedSubject);
    await activateEffectLease(harness, request.vet.jobId);
    let resolutions = 0;
    let nativeVerifications = 0;
    const adapter = {
      resolveIdentity: async (address: string) => {
        resolutions += 1;
        expect(address).toBe("11".repeat(32));
        return {
          ref: address,
          boundTo: address,
          raw: {
            result: 200,
            response: {
              web2: {
                github: [{
                  username: "alice",
                  userId: "42",
                  proofType: "tlsn",
                  proofHash: NATIVE_CCI_PROOF_HASH,
                  timestamp: NOW - 3_000,
                }],
              },
            },
          },
        };
      },
    } as unknown as SubstrateAdapter;
    const agent = buildAgent(adapter, {
      demosRpc: "https://node.example",
      demosCci: {
        authenticateResolution: ({ subject }) => ({
          status: "authenticated",
          subject,
          observedAt: NOW - 2_000,
          authority: "demos:testnet",
        }),
        verifyIdentityPresentation: () => true,
        verifyNativeTlsn: (input: Readonly<VerifyNativeCciTlsnInput>) => {
          nativeVerifications += 1;
          expect(input.subject).toBe(DEMOS_CCI_SUBJECT);
          return {
            status: "verified",
            verifiedAt: input.evaluatedAt,
            authority: "native-tlsn:testnet",
            binding: {
              subject: input.subject,
              jobId: input.jobId,
              sessionNonce: input.sessionNonce,
              expectedServer: input.expectedServer,
              bundleHash: input.bundleHash,
              proofHash: input.proofHash,
              resolutionObservedAt: input.resolution.observedAt,
            },
          };
        },
        nowMs: () => NOW,
      },
    });

    const production = await agent.partyVetWithNativeCciTlsn(
      request,
      deps(harness),
    );
    expect(production.record.overallDecision).toBe("pass");
    expect(production.record.evaluatedParty).toBe(qualifiedSubject);
    expect(production.nativeCciTlsn[0]).toMatchObject({
      subject: qualifiedSubject,
      jobId: NATIVE_CCI_JOB_ID,
      sessionNonce: NATIVE_CCI_SESSION_NONCE,
      evaluatedAt: NOW,
      authority: "native-tlsn:testnet",
    });
    expect(resolutions).toBe(1);
    expect(nativeVerifications).toBe(1);

    await agent.partyVetWithNativeCciTlsn(request, deps(harness));
    expect(resolutions).toBe(1);
    expect(nativeVerifications).toBe(1);
  });

  test("recovers a committed native qualification after response loss without re-verifying", async () => {
    const harness = state();
    const request = await nativeCciPartyRequest();
    await activateEffectLease(harness, request.vet.jobId);
    harness.loseAuthorizedResponseAt = "method-evidence";
    let qualifierCalls = 0;
    const qualifier: PartyVetNativeCciTlsnQualifier = (input) => {
      qualifierCalls += 1;
      return nativeCciDisposition(input);
    };

    await expect(partyVetWithNativeCciTlsnCore(
      request,
      deps(harness),
      qualifier,
    )).rejects.toThrow(/qualification journal was unavailable/);
    expect(qualifierCalls).toBe(1);
    expect(harness.effects).toEqual({ methods: 0, signs: 0, anchors: 0 });

    const production = await partyVetWithNativeCciTlsnCore(
      request,
      deps(harness),
      qualifier,
    );
    const replay = await partyVetWithNativeCciTlsnCore(
      request,
      deps(harness),
      qualifier,
    );
    expect(canonicalize(replay)).toBe(canonicalize(production));
    expect(qualifierCalls).toBe(1);
    const nativeSteps = [...harness.authorizedExecutions.entries()].filter(
      ([key]) => key.startsWith("dacs2:party-vet-native-cci:") &&
        key.endsWith("\u0000method-evidence"),
    );
    expect(nativeSteps).toHaveLength(1);
    expect(nativeSteps[0]![1]).toBe(1);
  });

  test("rejects an old active-session nonce before qualification or Vet effects", async () => {
    const harness = state();
    const request = await nativeCciPartyRequest();
    request.nativeCciTlsn[0]!.sessionNonce = "old-session-nonce";
    await activateEffectLease(harness, request.vet.jobId);
    let qualifierCalls = 0;

    await expect(partyVetWithNativeCciTlsnCore(
      request,
      deps(harness),
      () => {
        qualifierCalls += 1;
        throw new Error("unreachable");
      },
    )).rejects.toThrow(/session nonce does not match/);
    expect(qualifierCalls).toBe(0);
    expect(harness.effects).toEqual({ methods: 0, signs: 0, anchors: 0 });
    expect(harness.steps.size).toBe(0);
  });

  test("preserves a plain-reference nonce bind against a qualified replay", async () => {
    const first = state();
    const firstRequest = await nativeCciPartyRequest();
    await activateEffectLease(first, firstRequest.vet.jobId);
    let qualifierCalls = 0;
    const qualifier: PartyVetNativeCciTlsnQualifier = (input) => {
      qualifierCalls += 1;
      return nativeCciDisposition(input);
    };
    await partyVetWithNativeCciTlsnCore(
      firstRequest,
      deps(first),
      qualifier,
    );
    const legacyNonceKeyHash = sha256Hex(canonicalize({
      bindingVersion: "1",
      subject: "alpha:alice",
      sessionNonce: NATIVE_CCI_SESSION_NONCE,
    }));
    expect(first.steps.has(
      `dacs2:party-vet-native-cci-nonce:${legacyNonceKeyHash}\u0000method`,
    )).toBe(true);

    const second = state();
    // A new role process/session uses the same durable operation journal.
    second.steps = first.steps;
    second.inflight = first.inflight;
    const secondRequest = await nativeCciPartyRequest(
      "alpha:alice?network=testnet",
      "01J8ME0SXKQ4T9V2RC5HJ6WX7F",
    );
    await activateEffectLease(second, secondRequest.vet.jobId);

    await expect(partyVetWithNativeCciTlsnCore(
      secondRequest,
      deps(second),
      qualifier,
    )).rejects.toThrow(/nonce was unavailable or already bound/);
    expect(qualifierCalls).toBe(1);
    expect(second.effects).toEqual({ methods: 0, signs: 0, anchors: 0 });
  });

  test("durably rejects one nonce across differently qualified CF-3 presenters", async () => {
    const first = state();
    const firstRequest = await nativeCciPartyRequest(
      "alpha:alice?network=mainnet",
    );
    await activateEffectLease(first, firstRequest.vet.jobId);
    let qualifierCalls = 0;
    const qualifier: PartyVetNativeCciTlsnQualifier = (input) => {
      qualifierCalls += 1;
      return nativeCciDisposition(input);
    };
    await partyVetWithNativeCciTlsnCore(
      firstRequest,
      deps(first),
      qualifier,
    );

    const second = state();
    second.steps = first.steps;
    second.inflight = first.inflight;
    const secondRequest = await nativeCciPartyRequest(
      "alpha:alice?network=testnet",
      "01J8ME0SXKQ4T9V2RC5HJ6WX7F",
    );
    expect(identityBundleHash(secondRequest.vet.identityBundle)).not.toBe(
      identityBundleHash(firstRequest.vet.identityBundle),
    );
    await activateEffectLease(second, secondRequest.vet.jobId);

    await expect(partyVetWithNativeCciTlsnCore(
      secondRequest,
      deps(second),
      qualifier,
    )).rejects.toThrow(/nonce was unavailable or already bound/);
    expect(qualifierCalls).toBe(1);
    expect(first.effects).toEqual({ methods: 1, signs: 2, anchors: 2 });
    expect(second.effects).toEqual({ methods: 0, signs: 0, anchors: 0 });
  });

  test("keeps same-nonce durable namespaces separate for distinct parties", async () => {
    const first = state();
    const firstRequest = await nativeCciPartyRequest(
      "alpha:alice?network=testnet",
    );
    await activateEffectLease(first, firstRequest.vet.jobId);
    let qualifierCalls = 0;
    const qualifier: PartyVetNativeCciTlsnQualifier = (input) => {
      qualifierCalls += 1;
      return nativeCciDisposition(input);
    };
    await partyVetWithNativeCciTlsnCore(
      firstRequest,
      deps(first),
      qualifier,
    );

    const second = state();
    second.steps = first.steps;
    second.inflight = first.inflight;
    const secondRequest = await nativeCciPartyRequest(
      "alpha:bob?network=testnet",
      "01J8ME0SXKQ4T9V2RC5HJ6WX7F",
    );
    await activateEffectLease(second, secondRequest.vet.jobId);

    const production = await partyVetWithNativeCciTlsnCore(
      secondRequest,
      deps(second),
      qualifier,
    );
    expect(production.record.evaluatedParty).toBe(
      secondRequest.vet.evaluatedParty,
    );
    expect(qualifierCalls).toBe(2);
    expect(second.effects).toEqual({ methods: 1, signs: 2, anchors: 2 });
  });

  test("rejects a stale signed-bundle timestamp before ordinary Vet effects", async () => {
    const harness = state();
    const request = await nativeCciPartyRequest();
    request.vet.identityBundle.presentedAt = NOW - 60_001;
    await activateEffectLease(harness, request.vet.jobId);

    await expect(partyVetWithNativeCciTlsnCore(
      request,
      deps(harness),
      (input) => nativeCciDisposition(input, {
        claimObservedAt: NOW - 60_002,
      }),
    )).rejects.toThrow(/mismatched evidence/);
    expect(harness.effects).toEqual({ methods: 0, signs: 0, anchors: 0 });
  });

  test.each([
    ["job", { jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7F" }],
    ["session", { sessionNonce: "different-session" }],
    ["presenter", { subject: "alpha:mallory" }],
    ["bundle", { bundleHash: "cd".repeat(32) }],
    ["proof", { proofHash: "ef".repeat(32) }],
    ["stale proof", { claimObservedAt: NOW - 60_001 }],
    [
      "stale resolution",
      {
        claimObservedAt: NOW - 60_002,
        resolutionObservedAt: NOW - 60_001,
      },
    ],
    ["future verification", { verifiedAt: NOW + 1 }],
    ["substituted evaluation time", { evaluatedAt: NOW - 1 }],
  ] as const)("rejects %s substitution or stale evidence", async (_label, override) => {
    const harness = state();
    const request = await nativeCciPartyRequest();
    await activateEffectLease(harness, request.vet.jobId);

    await expect(partyVetWithNativeCciTlsnCore(
      request,
      deps(harness),
      (input) => nativeCciDisposition(input, override),
    )).rejects.toThrow(/mismatched evidence/);
    expect(harness.effects).toEqual({ methods: 0, signs: 0, anchors: 0 });
  });

  test("bounds optional native verifier evidence before journalling", async () => {
    const harness = state();
    const request = await nativeCciPartyRequest();
    await activateEffectLease(harness, request.vet.jobId);

    await expect(partyVetWithNativeCciTlsnCore(
      request,
      deps(harness),
      (input) => {
        const disposition = nativeCciDisposition(input);
        if (disposition.status !== "native-cci") throw new Error("unreachable");
        return {
          ...disposition,
          verification: {
            ...disposition.verification,
            evidence: { blob: "x".repeat(256 * 1024) },
          },
        };
      },
    )).rejects.toThrow(/verifier evidence exceeds the size limit/);
    expect(harness.effects).toEqual({ methods: 0, signs: 0, anchors: 0 });
    const failed = [...harness.steps.values()].find(
      (step) => step.state === "failed",
    );
    expect(failed?.value).toBeUndefined();
    expect(failed?.error).not.toContain("xxxxx");
  });

  test("ordinary partyVetCore cannot inject the SDK-reserved native signal", async () => {
    const harness = state();
    const request = await nativeCciPartyRequest();
    request.vet.supplementary = [{
      source: "cci-tlsn",
      signalType: PARTY_VET_NATIVE_CCI_TLSN_SIGNAL_TYPE,
      value: "{}",
      observedAt: NOW,
    }];
    await activateEffectLease(harness, request.vet.jobId);

    await expect(partyVetCore(request.vet, deps(harness))).rejects.toThrow(
      /only be produced by the SDK qualification path/,
    );
    expect(harness.effects).toEqual({ methods: 0, signs: 0, anchors: 0 });
    expect(harness.steps.size).toBe(0);
  });
});

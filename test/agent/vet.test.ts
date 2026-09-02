import { describe, expect, test } from "vitest";

import {
  canonicalize,
  compositeVerificationAddress,
  contentHash,
  ed25519Sign,
  ed25519Verify,
  isCompositeVerificationRecord,
  isFinalizedVetAnchorReceipt,
  isVerifyResult,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
  resolveRecipe,
  selfSignedAssertionBytes,
  sha256Hex,
  signComponentArtifact,
  vetCore,
  type AttestationRef,
  type CompositeBundleRequirement,
  type FinalizedVetAnchor,
  type FinalizedVetAnchorReceipt,
  type RecipeDescriptor,
  type VerificationMethod,
  type VetDeps,
  type VetOperationCheckpoint,
  type VetRequest,
} from "../../src/index.js";

const VERIFIER_SEED = new Uint8Array(32).fill(7);
const VERIFIER =
  `key:${Buffer.from(rawPublicKey(publicKeyFromSeed(VERIFIER_SEED))).toString("hex")}`;
const SELF_SIGNED_SEED = new Uint8Array(32).fill(9);
const OTHER_SELF_SIGNED_SEED = new Uint8Array(32).fill(10);
const SELF_SIGNED_SUBJECT =
  `key:${Buffer.from(rawPublicKey(publicKeyFromSeed(SELF_SIGNED_SEED))).toString("hex")}`;
const OTHER_SELF_SIGNED_SUBJECT =
  `key:${Buffer.from(rawPublicKey(publicKeyFromSeed(OTHER_SELF_SIGNED_SEED))).toString("hex")}`;
const STEWARD_SEED = new Uint8Array(32).fill(8);
const STEWARD_PUBLIC_KEY = rawPublicKey(publicKeyFromSeed(STEWARD_SEED));
const STEWARD =
  `did:demos:agent:${Buffer.from(STEWARD_PUBLIC_KEY).toString("hex")}`;
const BUNDLE_HASH = "b".repeat(64);
const NOW = 1_780_000_000_000;

interface StoredArtifact {
  logicalAddress: string;
  artifact: Record<string, unknown>;
  ref: AttestationRef;
  receipt: FinalizedVetAnchorReceipt;
}

type FinalizedStore = Map<string, StoredArtifact>;

const operationStores = new WeakMap<
  FinalizedStore,
  Map<string, VetOperationCheckpoint>
>();
interface StoredOperationStep {
  operationHash: string;
  inputHash: string;
  state: "complete" | "failed";
  value?: unknown;
  error?: string;
}
const operationStepStores = new WeakMap<
  FinalizedStore,
  Map<string, StoredOperationStep>
>();
const operationStepInflight = new WeakMap<
  FinalizedStore,
  Map<string, Promise<unknown>>
>();

function operationStoreFor(
  store: FinalizedStore,
): Map<string, VetOperationCheckpoint> {
  let operations = operationStores.get(store);
  if (!operations) {
    operations = new Map();
    operationStores.set(store, operations);
  }
  return operations;
}

function operationStepsFor(
  store: FinalizedStore,
): Map<string, StoredOperationStep> {
  let steps = operationStepStores.get(store);
  if (!steps) {
    steps = new Map();
    operationStepStores.set(store, steps);
  }
  return steps;
}

function operationInflightFor(
  store: FinalizedStore,
): Map<string, Promise<unknown>> {
  let inflight = operationStepInflight.get(store);
  if (!inflight) {
    inflight = new Map();
    operationStepInflight.set(store, inflight);
  }
  return inflight;
}

function recipe(over: Partial<RecipeDescriptor> = {}): RecipeDescriptor {
  return {
    recipeVersion: 1,
    scheme: "domain",
    defaultMethod: {
      kind: "consensus-backed-proxy",
      endpoint: {
        method: "GET",
        urlTemplate: "https://authority.example/claim/{identifier}",
      },
    },
    defaultMaxAgeSec: 3_600,
    parserRules: { format: "json", successJsonPath: "$.ok" },
    retryClass: "permanent",
    availability: "live",
    governance: {
      proposedBy: STEWARD,
      acceptedAt: NOW - 10_000,
      anchoring: "single-signer",
    },
    ...over,
  };
}

async function authenticatedRecipe(
  over: Partial<RecipeDescriptor> = {},
  selectorMethod?: VerificationMethod["kind"],
) {
  const descriptor = recipe(over);
  const signed = await signComponentArtifact(
    descriptor,
    "dacs-recipe:v1:",
    {
      algorithm: "ed25519",
      signer: STEWARD,
      sign: (bytes) =>
        ed25519Sign(bytes, privateKeyFromSeed(STEWARD_SEED)),
    },
  );
  return resolveRecipe(
    "memory:recipe-registry",
    {
      scheme: descriptor.scheme,
      method: selectorMethod ?? descriptor.defaultMethod.kind,
      recipeVersion: descriptor.recipeVersion,
    },
    {
      readRegistry: async () => ({
        registryId: "dacs2:registry:v1",
        version: "1",
        entries: [signed],
      }),
      stewardPublicKey: STEWARD_PUBLIC_KEY,
      stewardSigner: STEWARD,
      verify: (bytes, signature, publicKey) =>
        ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
    },
  );
}

function requirement(
  scheme: string,
  recipeVersion = 1,
  parameters?: Record<string, unknown>,
): CompositeBundleRequirement {
  return {
    requirementVersion: "1",
    required: [
      {
        scheme,
        verificationRequired: true,
        recipeVersion,
        ...(parameters === undefined ? {} : { parameters }),
      },
    ],
  };
}

function receiptFor(
  logicalAddress: string,
  nativeAddress: string,
  artifactHash: string,
): FinalizedVetAnchorReceipt {
  return {
    receiptVersion: "1",
    substrate: "memory-finality-test",
    finalityProfile: "instant-test-finality",
    logicalAddress,
    nativeAddress,
    contentHash: artifactHash,
    transactionRef: { kind: "memory-tx", value: `tx:${artifactHash}` },
    writer: VERIFIER,
    nonce: "1",
    state: "finalized",
    observationDisposition: "established",
    observedAt: NOW,
    blockRef: { id: "memory-block-1", height: "1", timestamp: NOW },
    evidence: { kind: "memory-proof", value: `proof:${artifactHash}` },
  };
}

function finalizedArtifactHash(artifact: Record<string, unknown>): string {
  // The method-native assertion's `signature` is evidence, not the component
  // envelope field excluded from a VerifyResult/composite signed scope.
  return artifact.assertionVersion === "1"
    ? sha256Hex(canonicalize(artifact))
    : contentHash(artifact);
}

function baseDeps(
  store: FinalizedStore,
  body = JSON.stringify({ ok: true }),
): VetDeps {
  const operations = operationStoreFor(store);
  const operationSteps = operationStepsFor(store);
  const operationInflight = operationInflightFor(store);
  const authority: AttestationRef = {
    anchor: { kind: "https", locator: "https://authority.example/evidence/1" },
    contentHash: sha256Hex(body),
    signer: "substrate-validator-set:demos-testnet:1",
  };
  return {
    proxyFetch: async () => ({
      status: 200,
      body,
      attestation: authority,
      fetchedAt: NOW,
      complete: true,
    }),
    nowMs: () => NOW,
    componentSigner: {
      algorithm: "ed25519",
      signer: VERIFIER,
      sign: (bytes) =>
        ed25519Sign(bytes, privateKeyFromSeed(VERIFIER_SEED)),
    },
    anchorFinalizedArtifact: async ({ logicalAddress, artifact }) => {
      const persisted = structuredClone(
        artifact,
      ) as unknown as Record<string, unknown>;
      const artifactHash = finalizedArtifactHash(persisted);
      const nativeAddress = `memory:${logicalAddress}`;
      const existing = store.get(nativeAddress);
      if (existing) {
        if (
          existing.ref.contentHash !== artifactHash ||
          canonicalize(existing.artifact) !== canonicalize(persisted)
        ) {
          throw new Error(
            `immutable logical address collision at ${logicalAddress}`,
          );
        }
        return {
          ref: structuredClone(existing.ref),
          receipt: structuredClone(existing.receipt),
        };
      }
      const ref: AttestationRef = {
        anchor: { kind: "storage-program", locator: nativeAddress },
        contentHash: artifactHash,
        ...(persisted.assertionVersion === "1" &&
        typeof persisted.subject === "string"
          ? { signer: persisted.subject }
          : {}),
      };
      const receipt = receiptFor(
        logicalAddress,
        nativeAddress,
        artifactHash,
      );
      store.set(nativeAddress, {
        logicalAddress,
        artifact: persisted,
        ref: structuredClone(ref),
        receipt: structuredClone(receipt),
      });
      return { ref, receipt };
    },
    verifyFinalizedAnchor: ({
      logicalAddress,
      artifact,
      ref,
      receipt,
    }) => {
      const stored = store.get(ref.anchor.locator);
      return (
        stored !== undefined &&
        stored.logicalAddress === logicalAddress &&
        receipt.state === "finalized" &&
        receipt.observationDisposition === "established" &&
        receipt.contentHash === finalizedArtifactHash(
          artifact as unknown as Record<string, unknown>,
        ) &&
        canonicalize(stored.artifact) === canonicalize(artifact)
      );
    },
    readAnchoredJson: async (ref) => {
      const stored = store.get(ref.anchor.locator);
      return stored ? structuredClone(stored.artifact) : null;
    },
    resolveFinalizedArtifact: async ({ logicalAddress, contentHash }) => {
      const stored = [...store.values()].find(
        (candidate) =>
          candidate.logicalAddress === logicalAddress &&
          candidate.ref.contentHash === contentHash,
      );
      return stored
        ? {
            ref: structuredClone(stored.ref),
            receipt: structuredClone(stored.receipt),
          }
        : null;
    },
    operationStore: {
      load: async (operationKey) => {
        const checkpoint = operations.get(operationKey);
        return checkpoint === undefined ? null : structuredClone(checkpoint);
      },
      compareAndSet: async ({ operationKey, expected, next }) => {
        const current = operations.get(operationKey);
        const matches = expected === null
          ? current === undefined
          : current !== undefined &&
            canonicalize(current) === canonicalize(expected);
        if (!matches) return false;
        operations.set(operationKey, structuredClone(next));
        return true;
      },
      runOnce: async ({
        operationKey,
        operationHash,
        step,
        inputHash,
        execute,
      }) => {
        const stepKey = `${operationKey}\u0000${step}`;
        const replay = operationSteps.get(stepKey);
        if (replay) {
          if (
            replay.operationHash !== operationHash ||
            replay.inputHash !== inputHash
          ) {
            throw new Error(`operation step ${step} input mismatch`);
          }
          if (replay.state === "failed") {
            throw new Error(replay.error ?? `operation step ${step} failed`);
          }
          return structuredClone(replay.value);
        }
        let pending = operationInflight.get(stepKey);
        if (!pending) {
          pending = (async () => {
            try {
              const value = structuredClone(await execute());
              operationSteps.set(stepKey, {
                operationHash,
                inputHash,
                state: "complete",
                value,
              });
              return value;
            } catch (error) {
              const message = error instanceof Error
                ? error.message
                : "operation step failed";
              operationSteps.set(stepKey, {
                operationHash,
                inputHash,
                state: "failed",
                error: message,
              });
              throw error;
            } finally {
              operationInflight.delete(stepKey);
            }
          })();
          operationInflight.set(stepKey, pending);
        }
        return structuredClone(await pending);
      },
    },
  };
}

function storedArtifacts(store: FinalizedStore): Record<string, unknown>[] {
  return [...store.values()].map(({ artifact }) => artifact);
}

function storedVerifyResult(store: FinalizedStore) {
  const result = storedArtifacts(store).find(isVerifyResult);
  expect(result).toBeDefined();
  return result!;
}

function selfSignedSignature(
  assertion: string,
  seed = SELF_SIGNED_SEED,
): string {
  return Buffer.from(
    ed25519Sign(
      selfSignedAssertionBytes(assertion),
      privateKeyFromSeed(seed),
    ),
  ).toString("hex");
}

async function selfSignedRequest(
  over: Partial<VetRequest> = {},
): Promise<VetRequest> {
  return {
    jobId: "job-self-negative",
    subject: SELF_SIGNED_SUBJECT,
    bundleHash: BUNDLE_HASH,
    requirement: requirement("key"),
    recipe: await authenticatedRecipe({
      scheme: "key",
      defaultMethod: { kind: "self-signed" },
    }),
    selfSigned: {
      assertion: SELF_SIGNED_SUBJECT,
      signature: selfSignedSignature(SELF_SIGNED_SUBJECT),
    },
    ...over,
  };
}

describe("vetCore current DACS-2 producer", () => {
  test("accepts only the exact finalized receipt wire shape", () => {
    const valid = receiptFor(
      "dacs2:composite:job:domain%3Aalice.example",
      "memory:dacs2:composite:job:domain%3Aalice.example",
      "a".repeat(64),
    );
    expect(isFinalizedVetAnchorReceipt(valid)).toBe(true);
    expect(isFinalizedVetAnchorReceipt({ ...valid, trusted: true })).toBe(false);
    expect(
      isFinalizedVetAnchorReceipt({
        ...valid,
        transactionRef: { ...valid.transactionRef, network: "test" },
      }),
    ).toBe(false);
    expect(
      isFinalizedVetAnchorReceipt(
        Object.assign(Object.create({ trusted: true }), valid),
      ),
    ).toBe(false);
  });

  test("CF-4 encodes every variable composite-address segment", () => {
    expect(
      compositeVerificationAddress("deal:1?retry=2", "domain:alice.example"),
    ).toBe(
      "dacs2:composite:deal%3A1%3Fretry%3D2:domain%3Aalice.example",
    );
  });

  test("returns only finalized VerifyResult and composite production", async () => {
    const store: FinalizedStore = new Map();
    const production = await vetCore(
      {
        jobId: "job-vet-1",
        subject: "domain:alice.example",
        bundleHash: BUNDLE_HASH,
        requirement: requirement("domain"),
        recipe: await authenticatedRecipe(),
      },
      baseDeps(store),
    );

    expect(isCompositeVerificationRecord(production.record)).toBe(true);
    expect(production.record).toMatchObject({
      recordVersion: "1",
      jobId: "job-vet-1",
      evaluatedParty: "domain:alice.example",
      bundleHash: BUNDLE_HASH,
      requirementHash: sha256Hex(canonicalize(requirement("domain"))),
      freshness: [],
      overallDecision: "pass",
    });
    expect(production.record.dealSpecific).toHaveLength(1);
    expect(production.record.signature.signer).toBe(VERIFIER);
    expect(production.recordRef.contentHash).toBe(
      contentHash(production.record as unknown as Record<string, unknown>),
    );
    expect(production.anchorReceipt).toMatchObject({
      state: "finalized",
      observationDisposition: "established",
      contentHash: production.recordRef.contentHash,
    });
    expect(store.size).toBe(2);
    expect(storedVerifyResult(store)).toMatchObject({
      resultVersion: "1",
      scheme: "domain",
      identifier: "alice.example",
      recipeVersion: 1,
      method: "consensus-backed-proxy",
      decision: "pass",
    });
  });

  test("preserves the legacy single-claim bytes and durable effect namespace", async () => {
    const store: FinalizedStore = new Map();
    const jobId = "job-vet-refactor-equivalence";
    const subject = "domain:alice.example";
    const exactRequirement = requirement("domain");
    const request: VetRequest = {
      jobId,
      subject,
      bundleHash: BUNDLE_HASH,
      requirement: exactRequirement,
      recipe: await authenticatedRecipe(),
    };

    const first = await vetCore(request, baseDeps(store));
    const resultAddress = `${`dacs2:${jobId}`}:domain:alice.example:v1`;
    const recordAddress = compositeVerificationAddress(jobId, subject);
    const expectedResult = await signComponentArtifact(
      {
        resultVersion: "1" as const,
        scheme: "domain",
        identifier: "alice.example",
        recipeVersion: 1,
        method: "consensus-backed-proxy" as const,
        decision: "pass" as const,
        reason: "authority confirmed claim",
        attestation: {
          anchor: {
            kind: "https" as const,
            locator: "https://authority.example/evidence/1",
          },
          contentHash: sha256Hex(JSON.stringify({ ok: true })),
          signer: "substrate-validator-set:demos-testnet:1",
        },
        fetchedAt: NOW,
        verifiedAt: NOW,
      },
      "dacs-verifyresult:v1:",
      {
        algorithm: "ed25519",
        signer: VERIFIER,
        sign: (bytes) =>
          ed25519Sign(bytes, privateKeyFromSeed(VERIFIER_SEED)),
      },
    );
    const expectedRecord = await signComponentArtifact(
      {
        recordVersion: "1" as const,
        jobId,
        evaluatedParty: subject,
        bundleHash: BUNDLE_HASH,
        requirementHash: sha256Hex(canonicalize(exactRequirement)),
        freshness: [],
        supplementary: [],
        dealSpecific: [
          {
            anchor: {
              kind: "storage-program" as const,
              locator: `memory:${resultAddress}`,
            },
            contentHash: contentHash(
              expectedResult as unknown as Record<string, unknown>,
            ),
            recipeVersion: 1,
          },
        ],
        overallDecision: "pass" as const,
        generatedAt: NOW,
      },
      "dacs-composite:v1:",
      {
        algorithm: "ed25519",
        signer: VERIFIER,
        sign: (bytes) =>
          ed25519Sign(bytes, privateKeyFromSeed(VERIFIER_SEED)),
      },
    );

    expect(canonicalize(storedVerifyResult(store))).toBe(
      canonicalize(expectedResult),
    );
    expect(canonicalize(first.record)).toBe(canonicalize(expectedRecord));
    expect([...operationStoreFor(store).keys()]).toEqual([recordAddress]);
    expect([...operationStepsFor(store).keys()].sort()).toEqual(
      [
        "method",
        "verify-result",
        "verify-result-anchor",
        "composite",
        "composite-anchor",
      ].map((step) => `${recordAddress}\u0000${step}`).sort(),
    );
    expect([...store.values()].map((entry) => entry.logicalAddress).sort()).toEqual(
      [resultAddress, recordAddress].sort(),
    );

    const replay = await vetCore(request, baseDeps(store));
    expect(canonicalize(replay)).toBe(canonicalize(first));
    expect(store.size).toBe(2);
    expect(operationStepsFor(store).size).toBe(5);
  });

  test("captures dependency authority from exact data descriptors without getters", async () => {
    const store: FinalizedStore = new Map();
    const deps = baseDeps(store);
    let getterReads = 0;
    Object.defineProperty(deps, "proxyFetch", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return baseDeps(store).proxyFetch;
      },
    });

    await expect(
      vetCore(
        {
          jobId: "job-vet-dependency-getter",
          subject: "domain:alice.example",
          bundleHash: BUNDLE_HASH,
          requirement: requirement("domain"),
          recipe: await authenticatedRecipe(),
        },
        deps,
      ),
    ).rejects.toThrow(/stable callable capabilities/);
    expect(getterReads).toBe(0);
    expect(store.size).toBe(0);
  });

  test("rejects proxy callbacks and proxy request records before reflection", async () => {
    const store: FinalizedStore = new Map();
    const deps = baseDeps(store);
    let proxyApplied = false;
    deps.proxyFetch = new Proxy(deps.proxyFetch, {
      apply: () => {
        proxyApplied = true;
        throw new Error("must not run");
      },
    });
    const request: VetRequest = {
      jobId: "job-vet-proxy-callback",
      subject: "domain:alice.example",
      bundleHash: BUNDLE_HASH,
      requirement: requirement("domain"),
      recipe: await authenticatedRecipe(),
    };
    await expect(vetCore(request, deps)).rejects.toThrow(
      /stable callable capabilities/,
    );
    expect(proxyApplied).toBe(false);

    let reflected = false;
    const requestProxy = new Proxy(request, {
      ownKeys: () => {
        reflected = true;
        return [];
      },
    });
    await expect(
      vetCore(requestProxy, baseDeps(new Map())),
    ).rejects.toThrow(/Vet request must be a plain record/);
    expect(reflected).toBe(false);
  });

  test("freezes callback identity before the first await", async () => {
    const store: FinalizedStore = new Map();
    const deps = baseDeps(store);
    const originalLoad = deps.operationStore.load;
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    deps.operationStore.load = async (operationKey) => {
      await loadGate;
      return originalLoad(operationKey);
    };
    const request: VetRequest = {
      jobId: "job-vet-dependency-mutation",
      subject: "domain:alice.example",
      bundleHash: BUNDLE_HASH,
      requirement: requirement("domain"),
      recipe: await authenticatedRecipe(),
    };
    let replacementCalls = 0;
    const running = vetCore(request, deps);
    deps.proxyFetch = async () => {
      replacementCalls += 1;
      throw new Error("mutated proxy callback");
    };
    deps.componentSigner.sign = () => {
      replacementCalls += 1;
      return new Uint8Array(64);
    };
    deps.operationStore.runOnce = async () => {
      replacementCalls += 1;
      throw new Error("mutated runOnce callback");
    };
    releaseLoad();

    await expect(running).resolves.toMatchObject({
      record: { overallDecision: "pass" },
    });
    expect(replacementCalls).toBe(0);
  });

  test("invokes dependency callbacks with an inert receiver", async () => {
    const store: FinalizedStore = new Map();
    const deps = baseDeps(store);
    deps.nowMs = function (this: Record<string, unknown>) {
      return this.componentSigner === undefined ? -1 : NOW;
    };
    await expect(
      vetCore(
        {
          jobId: "job-vet-inert-receiver",
          subject: "domain:alice.example",
          bundleHash: BUNDLE_HASH,
          requirement: requirement("domain"),
          recipe: await authenticatedRecipe(),
        },
        deps,
      ),
    ).rejects.toThrow(/non-negative safe integer/);
    expect(store.size).toBe(0);
  });

  test("requires recipe provenance created by authenticated resolution", async () => {
    const plainSignedRecipe = await signComponentArtifact(
      recipe(),
      "dacs-recipe:v1:",
      {
        algorithm: "ed25519",
        signer: STEWARD,
        sign: (bytes) =>
          ed25519Sign(bytes, privateKeyFromSeed(STEWARD_SEED)),
      },
    );
    await expect(
      vetCore(
        {
          jobId: "job-vet-unauthenticated-recipe",
          subject: "domain:alice.example",
          bundleHash: BUNDLE_HASH,
          requirement: requirement("domain"),
          // Deliberately cross the compile-time provenance boundary to prove
          // the runtime WeakSet check rejects a structurally signed forgery.
          recipe: plainSignedRecipe as never,
        },
        baseDeps(new Map()),
      ),
    ).rejects.toThrow(/steward-authenticated recipe returned by resolveRecipe/);
  });

  test("cannot swap an authenticated recipe through a request accessor", async () => {
    const authenticated = await authenticatedRecipe();
    const forged = structuredClone(authenticated);
    forged.defaultMethod = {
      kind: "consensus-backed-proxy",
      endpoint: {
        method: "GET",
        urlTemplate: "https://attacker.example/{identifier}",
      },
    };
    let recipeReads = 0;
    let proxyCalled = false;
    const request: Record<string, unknown> = {
      jobId: "job-vet-recipe-accessor",
      subject: "domain:alice.example",
      bundleHash: BUNDLE_HASH,
      requirement: requirement("domain"),
    };
    Object.defineProperty(request, "recipe", {
      enumerable: true,
      get: () => {
        recipeReads += 1;
        return recipeReads === 1 ? authenticated : forged;
      },
    });
    const deps = baseDeps(new Map());
    deps.proxyFetch = async () => {
      proxyCalled = true;
      throw new Error("must not query attacker-selected authority");
    };

    await expect(
      vetCore(request as unknown as VetRequest, deps),
    ).rejects.toThrow(/own enumerable data properties/);
    expect(recipeReads).toBe(0);
    expect(proxyCalled).toBe(false);
  });

  test("rejects callback accessors without invoking them during snapshot", async () => {
    const deps = baseDeps(new Map());
    let attestationReads = 0;
    deps.proxyFetch = async () => {
      const response: Record<string, unknown> = {
        status: 200,
        body: JSON.stringify({ ok: true }),
        fetchedAt: NOW,
      };
      Object.defineProperty(response, "attestation", {
        enumerable: true,
        get: () => {
          attestationReads += 1;
          throw new Error("hostile callback accessor executed");
        },
      });
      return response as unknown as Awaited<
        ReturnType<VetDeps["proxyFetch"]>
      >;
    };

    await expect(
      vetCore(
        {
          jobId: "job-vet-callback-accessor",
          subject: "domain:alice.example",
          bundleHash: BUNDLE_HASH,
          requirement: requirement("domain"),
          recipe: await authenticatedRecipe(),
        },
        deps,
      ),
    ).rejects.toThrow(/exact JSON evidence/);
    expect(attestationReads).toBe(0);
  });

  test("rejects proxy evidence with non-normative fields before anchoring", async () => {
    const deps = baseDeps(new Map());
    const proxyFetch = deps.proxyFetch;
    let anchorCalls = 0;
    deps.proxyFetch = async (input) => ({
      ...(await proxyFetch(input)),
      trustedByCaller: true,
    });
    deps.anchorFinalizedArtifact = async () => {
      anchorCalls += 1;
      throw new Error("must not anchor malformed authority evidence");
    };

    await expect(
      vetCore(
        {
          jobId: "job-vet-proxy-extra-field",
          subject: "domain:alice.example",
          bundleHash: BUNDLE_HASH,
          requirement: requirement("domain"),
          recipe: await authenticatedRecipe(),
        },
        deps,
      ),
    ).rejects.toThrow(/exact JSON evidence/);
    expect(anchorCalls).toBe(0);
  });

  test("rejects a requirement pinned to a different recipe version", async () => {
    await expect(
      vetCore(
        {
          jobId: "job-vet-version-mismatch",
          subject: "domain:alice.example",
          bundleHash: BUNDLE_HASH,
          requirement: requirement("domain", 2),
          recipe: await authenticatedRecipe(),
        },
        baseDeps(new Map()),
      ),
    ).rejects.toThrow(/must pin authenticated recipe v1/);
  });

  test("fails closed when a requirement omits the session-start recipe pin", async () => {
    const store: FinalizedStore = new Map();
    await expect(
      vetCore(
        {
          jobId: "job-vet-unpinned-recipe",
          subject: "domain:alice.example",
          bundleHash: BUNDLE_HASH,
          requirement: {
            requirementVersion: "1",
            required: [
              { scheme: "domain", verificationRequired: true },
            ],
          },
          recipe: await authenticatedRecipe(),
        },
        baseDeps(store),
      ),
    ).rejects.toThrow(/must pin authenticated recipe v1/);
    expect(store.size).toBe(0);
  });

  test.each(["mocked", "disabled", "failed"] as const)(
    "does not execute a %s recipe for a new verification",
    async (availability) => {
      const deps = baseDeps(new Map());
      let proxyCalled = false;
      deps.proxyFetch = async () => {
        proxyCalled = true;
        throw new Error("non-operational recipes must not query an authority");
      };
      await expect(
        vetCore(
          {
            jobId: `job-vet-${availability}-recipe`,
            subject: "domain:alice.example",
            bundleHash: BUNDLE_HASH,
            requirement: requirement("domain"),
            recipe: await authenticatedRecipe({ availability }),
          },
          deps,
        ),
      ).rejects.toThrow(new RegExp(`${availability} recipes cannot start`));
      expect(proxyCalled).toBe(false);
    },
  );

  test("fails closed when requirement parameters have no method matcher", async () => {
    await expect(
      vetCore(
        {
          jobId: "job-vet-parameter-matcher-missing",
          subject: "domain:alice.example",
          bundleHash: BUNDLE_HASH,
          requirement: requirement("domain", 1, { jurisdiction: "GB" }),
          recipe: await authenticatedRecipe(),
        },
        baseDeps(new Map()),
      ),
    ).rejects.toThrow(/requires matchRequirementParameters/);
  });

  test("cannot override the canonical subject through a template parameter", async () => {
    const deps = baseDeps(new Map());
    let proxyCalled = false;
    deps.proxyFetch = async () => {
      proxyCalled = true;
      throw new Error("reserved parameters must fail before authority access");
    };
    await expect(
      vetCore(
        {
          jobId: "job-vet-reserved-identifier",
          subject: "domain:alice.example",
          bundleHash: BUNDLE_HASH,
          requirement: requirement("domain", 1, {
            identifier: "mallory.example",
          }),
          recipe: await authenticatedRecipe(),
        },
        deps,
      ),
    ).rejects.toThrow(/parameters\.identifier is reserved/);
    expect(proxyCalled).toBe(false);
  });

  test("records fail when authenticated requirement parameters do not match", async () => {
    const store: FinalizedStore = new Map();
    const deps = baseDeps(store);
    deps.matchRequirementParameters = (input) => {
      expect(input.requirement.parameters).toEqual({ jurisdiction: "GB" });
      expect(input.method.kind).toBe("consensus-backed-proxy");
      expect(Object.isFrozen(input)).toBe(true);
      return false;
    };
    const production = await vetCore(
      {
        jobId: "job-vet-parameter-mismatch",
        subject: "domain:alice.example",
        bundleHash: BUNDLE_HASH,
        requirement: requirement("domain", 1, { jurisdiction: "GB" }),
        recipe: await authenticatedRecipe(),
      },
      deps,
    );

    expect(storedVerifyResult(store).decision).toBe("fail");
    expect(production.record.overallDecision).toBe("fail");
  });

  test("rejects authority evidence fetched before this verification attempt", async () => {
    const deps = baseDeps(new Map());
    const proxyFetch = deps.proxyFetch;
    deps.proxyFetch = async (input) => ({
      ...(await proxyFetch(input)),
      fetchedAt: NOW - 1,
    });
    await expect(
      vetCore(
        {
          jobId: "job-vet-old-authority-response",
          subject: "domain:alice.example",
          bundleHash: BUNDLE_HASH,
          requirement: requirement("domain"),
          recipe: await authenticatedRecipe(),
        },
        deps,
      ),
    ).rejects.toThrow(/fetchedAt predates this verification attempt/);
  });

  test("does not manufacture a ref when an anchor returns the wrong hash", async () => {
    const deps = baseDeps(new Map());
    const anchor = deps.anchorFinalizedArtifact;
    const resolve = deps.resolveFinalizedArtifact!;
    deps.anchorFinalizedArtifact = async (input) => {
      const anchored = await anchor(input);
      return {
        ...anchored,
        ref: { ...anchored.ref, contentHash: "0".repeat(64) },
      };
    };
    deps.resolveFinalizedArtifact = async (input) => {
      const anchored = await resolve(input);
      return anchored === null
        ? null
        : {
            ...anchored,
            ref: { ...anchored.ref, contentHash: "0".repeat(64) },
          };
    };
    await expect(
      vetCore(
        {
          jobId: "job-vet-wrong-anchor-hash",
          subject: "domain:alice.example",
          bundleHash: BUNDLE_HASH,
          requirement: requirement("domain"),
          recipe: await authenticatedRecipe(),
        },
        deps,
      ),
    ).rejects.toThrow(/malformed (state|or mismatched finalized anchor)/);
  });

  test("rejects a composite anchor that is not finalized", async () => {
    const deps = baseDeps(new Map());
    const anchor = deps.anchorFinalizedArtifact;
    const resolve = deps.resolveFinalizedArtifact!;
    deps.anchorFinalizedArtifact = async (input): Promise<FinalizedVetAnchor> => {
      const anchored = await anchor(input);
      if (!input.logicalAddress.startsWith("dacs2:composite:")) return anchored;
      return {
        ...anchored,
        receipt: {
          ...anchored.receipt,
          state: "pending" as "finalized",
        },
      };
    };
    deps.resolveFinalizedArtifact = async (input) => {
      const anchored = await resolve(input);
      if (
        anchored === null ||
        !input.logicalAddress.startsWith("dacs2:composite:")
      ) {
        return anchored;
      }
      return {
        ...anchored,
        receipt: {
          ...anchored.receipt,
          state: "pending" as "finalized",
        },
      };
    };
    await expect(
      vetCore(
        {
          jobId: "job-vet-composite-not-finalized",
          subject: "domain:alice.example",
          bundleHash: BUNDLE_HASH,
          requirement: requirement("domain"),
          recipe: await authenticatedRecipe(),
        },
        deps,
      ),
    ).rejects.toThrow(/malformed (state|or mismatched finalized anchor)/);
  });

  test("rejects unauthenticated composite finality evidence", async () => {
    const deps = baseDeps(new Map());
    const verifyFinalizedAnchor = deps.verifyFinalizedAnchor;
    deps.verifyFinalizedAnchor = (input) =>
      input.logicalAddress.startsWith("dacs2:composite:")
        ? false
        : verifyFinalizedAnchor(input);
    await expect(
      vetCore(
        {
          jobId: "job-vet-composite-bad-receipt",
          subject: "domain:alice.example",
          bundleHash: BUNDLE_HASH,
          requirement: requirement("domain"),
          recipe: await authenticatedRecipe(),
        },
        deps,
      ),
    ).rejects.toThrow(/finalized receipt did not authenticate/);
  });

  test("rejects a composite readback that differs from exact signed bytes", async () => {
    const deps = baseDeps(new Map());
    const readAnchoredJson = deps.readAnchoredJson;
    deps.readAnchoredJson = async (ref) => {
      const readback = await readAnchoredJson(ref);
      if (
        readback !== null &&
        ref.anchor.locator.includes("dacs2:composite:")
      ) {
        return { ...readback, generatedAt: NOW + 1 };
      }
      return readback;
    };
    await expect(
      vetCore(
        {
          jobId: "job-vet-composite-bad-readback",
          subject: "domain:alice.example",
          bundleHash: BUNDLE_HASH,
          requirement: requirement("domain"),
          recipe: await authenticatedRecipe(),
        },
        deps,
      ),
    ).rejects.toThrow(/finalized readback does not match exact signed bytes/);
  });

  test("records authority query, verification, and composite generation in order", async () => {
    const store: FinalizedStore = new Map();
    const deps = baseDeps(store);
    const proxyFetch = deps.proxyFetch;
    const clock = [NOW, NOW + 20, NOW + 30];
    deps.nowMs = () => {
      const value = clock.shift();
      if (value === undefined) throw new Error("unexpected clock read");
      return value;
    };
    deps.proxyFetch = async (input) => ({
      ...(await proxyFetch(input)),
      fetchedAt: NOW + 10,
    });

    const production = await vetCore(
      {
        jobId: "job-vet-order",
        subject: "domain:alice.example",
        bundleHash: BUNDLE_HASH,
        requirement: requirement("domain"),
        recipe: await authenticatedRecipe(),
      },
      deps,
    );

    expect(storedVerifyResult(store)).toMatchObject({
      fetchedAt: NOW + 10,
      verifiedAt: NOW + 20,
    });
    expect(production.record.generatedAt).toBe(NOW + 30);
    expect(clock).toEqual([]);
  });

  test("rejects a verifier clock that regresses behind the authority query", async () => {
    const deps = baseDeps(new Map());
    const proxyFetch = deps.proxyFetch;
    const clock = [NOW, NOW + 5];
    deps.nowMs = () => clock.shift()!;
    deps.proxyFetch = async (input) => ({
      ...(await proxyFetch(input)),
      fetchedAt: NOW + 10,
    });

    await expect(
      vetCore(
        {
          jobId: "job-vet-clock-regression",
          subject: "domain:alice.example",
          bundleHash: BUNDLE_HASH,
          requirement: requirement("domain"),
          recipe: await authenticatedRecipe(),
        },
        deps,
      ),
    ).rejects.toThrow(/verifiedAt precedes the prior verified event/);
  });

  test("snapshots request, callback results, signer, and anchor inputs", async () => {
    const store: FinalizedStore = new Map();
    const deps = baseDeps(store);
    const originalProxyFetch = deps.proxyFetch;
    const originalSign = deps.componentSigner.sign;
    const request = {
      jobId: "job-vet-snapshot",
      subject: "domain:alice.example",
      bundleHash: BUNDLE_HASH,
      requirement: requirement("domain"),
      recipe: await authenticatedRecipe(),
      supplementary: [
        {
          source: "dacs-5" as const,
          signalType: "completion-rate",
          value: 1,
          observedAt: NOW - 100,
        },
      ],
    };
    let proxyResult: Awaited<ReturnType<VetDeps["proxyFetch"]>>;
    deps.proxyFetch = async (input) => {
      proxyResult = await originalProxyFetch(input);
      request.jobId = "job-mutated-by-proxy";
      request.requirement.required[0]!.scheme = "wallet";
      return proxyResult;
    };
    let signCalls = 0;
    deps.componentSigner.sign = async (bytes, context) => {
      signCalls += 1;
      request.bundleHash = "f".repeat(64);
      if (signCalls === 1) {
        deps.componentSigner.sign = () => Uint8Array.from([0]);
        proxyResult.attestation.contentHash = "e".repeat(64);
      }
      return originalSign(bytes, context);
    };
    const originalAnchor = deps.anchorFinalizedArtifact;
    deps.anchorFinalizedArtifact = async (input) => {
      try {
        (input.artifact as { scheme: string }).scheme = "wallet";
      } catch {
        // Frozen callback input: a hostile adapter cannot rewrite signed scope.
      }
      request.subject = "domain:mallory.example";
      return originalAnchor(input);
    };

    const production = await vetCore(request, deps);

    expect(signCalls).toBe(2);
    expect(production.record).toMatchObject({
      jobId: "job-vet-snapshot",
      evaluatedParty: "domain:alice.example",
      bundleHash: BUNDLE_HASH,
      supplementary: [{ signalType: "completion-rate", value: 1 }],
    });
    expect(production.record.requirementHash).toBe(
      sha256Hex(canonicalize(requirement("domain"))),
    );
    expect(storedVerifyResult(store)).toMatchObject({
      scheme: "domain",
      identifier: "alice.example",
    });
  });

  test("reuses exact completed bytes across an advancing-clock restart", async () => {
    const store: FinalizedStore = new Map();
    const deps = baseDeps(store);
    const authenticated = await authenticatedRecipe();
    const request: VetRequest = {
      jobId: "job-vet-restart-complete",
      subject: "domain:alice.example",
      bundleHash: BUNDLE_HASH,
      requirement: requirement("domain"),
      recipe: authenticated,
    };
    const proxyFetch = deps.proxyFetch;
    const anchor = deps.anchorFinalizedArtifact;
    const sign = deps.componentSigner.sign;
    let authorityCalls = 0;
    let anchorCalls = 0;
    let signCalls = 0;
    let clockCalls = 0;
    deps.proxyFetch = async (input) => {
      authorityCalls += 1;
      return proxyFetch(input);
    };
    deps.anchorFinalizedArtifact = async (input) => {
      anchorCalls += 1;
      return anchor(input);
    };
    deps.componentSigner.sign = async (bytes, context) => {
      signCalls += 1;
      return sign(bytes, context);
    };
    deps.nowMs = () => {
      clockCalls += 1;
      return NOW;
    };

    const first = await vetCore(request, deps);
    expect({ authorityCalls, anchorCalls, signCalls, clockCalls }).toEqual({
      authorityCalls: 1,
      anchorCalls: 2,
      signCalls: 2,
      clockCalls: 3,
    });

    deps.proxyFetch = async () => {
      authorityCalls += 1;
      throw new Error("a completed retry must not contact the authority");
    };
    deps.anchorFinalizedArtifact = async () => {
      anchorCalls += 1;
      throw new Error("a completed retry must not submit an anchor");
    };
    deps.componentSigner.sign = async () => {
      signCalls += 1;
      throw new Error("a completed retry must not re-sign");
    };
    deps.nowMs = () => {
      clockCalls += 1;
      return NOW + 86_400_000;
    };

    const recovered = await vetCore(request, deps);
    expect(canonicalize(recovered)).toBe(canonicalize(first));
    expect({ authorityCalls, anchorCalls, signCalls, clockCalls }).toEqual({
      authorityCalls: 1,
      anchorCalls: 2,
      signCalls: 2,
      clockCalls: 3,
    });
  });

  test("safely resumes a loaded intent whose method executor never started", async () => {
    const store: FinalizedStore = new Map();
    const deps = baseDeps(store);
    const durableRunOnce = deps.operationStore!.runOnce;
    const proxyFetch = deps.proxyFetch;
    let simulateCrashBeforeMethodClaim = true;
    let authorityCalls = 0;
    deps.proxyFetch = async (input) => {
      authorityCalls += 1;
      return proxyFetch(input);
    };
    deps.operationStore = {
      ...deps.operationStore!,
      runOnce: async (input) => {
        if (input.step === "method" && simulateCrashBeforeMethodClaim) {
          simulateCrashBeforeMethodClaim = false;
          throw new Error("process stopped after intent commit");
        }
        return durableRunOnce(input);
      },
    };
    const request: VetRequest = {
      jobId: "job-vet-resume-loaded-intent",
      subject: "domain:alice.example",
      bundleHash: BUNDLE_HASH,
      requirement: requirement("domain"),
      recipe: await authenticatedRecipe(),
    };

    await expect(vetCore(request, deps)).rejects.toThrow(
      /process stopped after intent commit/,
    );
    expect(authorityCalls).toBe(0);
    const recovered = await vetCore(request, deps);
    expect(recovered.record.overallDecision).toBe("pass");
    expect(authorityCalls).toBe(1);
  });

  test("fences concurrent callers across method, signing, and anchoring", async () => {
    const store: FinalizedStore = new Map();
    const deps = baseDeps(store);
    const proxyFetch = deps.proxyFetch;
    const anchor = deps.anchorFinalizedArtifact;
    const sign = deps.componentSigner.sign;
    let authorityCalls = 0;
    let anchorCalls = 0;
    let signCalls = 0;
    deps.proxyFetch = async (input) => {
      authorityCalls += 1;
      await Promise.resolve();
      return proxyFetch(input);
    };
    deps.anchorFinalizedArtifact = async (input) => {
      anchorCalls += 1;
      await Promise.resolve();
      return anchor(input);
    };
    deps.componentSigner.sign = async (bytes, context) => {
      signCalls += 1;
      await Promise.resolve();
      return sign(bytes, context);
    };
    const request: VetRequest = {
      jobId: "job-vet-concurrent-fence",
      subject: "domain:alice.example",
      bundleHash: BUNDLE_HASH,
      requirement: requirement("domain"),
      recipe: await authenticatedRecipe(),
    };

    const [first, second] = await Promise.all([
      vetCore(request, deps),
      vetCore(request, deps),
    ]);
    expect(canonicalize(second)).toBe(canonicalize(first));
    expect({ authorityCalls, anchorCalls, signCalls }).toEqual({
      authorityCalls: 1,
      anchorCalls: 2,
      signCalls: 2,
    });
  });

  test("reconciles result-anchor response loss without duplicate work", async () => {
    const store: FinalizedStore = new Map();
    const deps = baseDeps(store);
    const proxyFetch = deps.proxyFetch;
    const anchor = deps.anchorFinalizedArtifact;
    let authorityCalls = 0;
    let resultAnchorCalls = 0;
    let compositeAnchorCalls = 0;
    let loseResultResponse = true;
    deps.proxyFetch = async (input) => {
      authorityCalls += 1;
      return proxyFetch(input);
    };
    deps.anchorFinalizedArtifact = async (input) => {
      const anchored = await anchor(input);
      if (input.logicalAddress.startsWith("dacs2:composite:")) {
        compositeAnchorCalls += 1;
      } else {
        resultAnchorCalls += 1;
        if (loseResultResponse) {
          loseResultResponse = false;
          throw new Error("result anchor response lost after commit");
        }
      }
      return anchored;
    };
    const request: VetRequest = {
      jobId: "job-vet-result-response-loss",
      subject: "domain:alice.example",
      bundleHash: BUNDLE_HASH,
      requirement: requirement("domain"),
      recipe: await authenticatedRecipe(),
    };

    const first = await vetCore(request, deps);
    const recovered = await vetCore(request, deps);

    expect(canonicalize(recovered)).toBe(canonicalize(first));
    expect({ authorityCalls, resultAnchorCalls, compositeAnchorCalls }).toEqual({
      authorityCalls: 1,
      resultAnchorCalls: 1,
      compositeAnchorCalls: 1,
    });
  });

  test("reconciles composite-anchor response loss without duplicate work", async () => {
    const store: FinalizedStore = new Map();
    const deps = baseDeps(store);
    const proxyFetch = deps.proxyFetch;
    const anchor = deps.anchorFinalizedArtifact;
    let authorityCalls = 0;
    let resultAnchorCalls = 0;
    let compositeAnchorCalls = 0;
    let loseCompositeResponse = true;
    deps.proxyFetch = async (input) => {
      authorityCalls += 1;
      return proxyFetch(input);
    };
    deps.anchorFinalizedArtifact = async (input) => {
      const anchored = await anchor(input);
      if (input.logicalAddress.startsWith("dacs2:composite:")) {
        compositeAnchorCalls += 1;
        if (loseCompositeResponse) {
          loseCompositeResponse = false;
          throw new Error("composite anchor response lost after commit");
        }
      } else {
        resultAnchorCalls += 1;
      }
      return anchored;
    };
    const request: VetRequest = {
      jobId: "job-vet-composite-response-loss",
      subject: "domain:alice.example",
      bundleHash: BUNDLE_HASH,
      requirement: requirement("domain"),
      recipe: await authenticatedRecipe(),
    };

    const first = await vetCore(request, deps);
    const recovered = await vetCore(request, deps);

    expect(canonicalize(recovered)).toBe(canonicalize(first));
    expect({ authorityCalls, resultAnchorCalls, compositeAnchorCalls }).toEqual({
      authorityCalls: 1,
      resultAnchorCalls: 1,
      compositeAnchorCalls: 1,
    });
  });

  test("binds the durable namespace to bundle, requirement, recipe, and classification", async () => {
    const store: FinalizedStore = new Map();
    const deps = baseDeps(store);
    const authenticated = await authenticatedRecipe();
    const original: VetRequest = {
      jobId: "job-vet-operation-bindings",
      subject: "domain:alice.example",
      bundleHash: BUNDLE_HASH,
      requirement: requirement("domain"),
      recipe: authenticated,
    };
    await vetCore(original, deps);
    let authorityCalls = 0;
    deps.proxyFetch = async () => {
      authorityCalls += 1;
      throw new Error("a mismatched operation must not query the authority");
    };
    const mismatches: VetRequest[] = [
      { ...original, bundleHash: "c".repeat(64) },
      {
        ...original,
        requirement: {
          requirementVersion: "1",
          required: [
            {
              scheme: "domain",
              verificationRequired: true,
              recipeVersion: 1,
              maxAge: 60,
            },
          ],
        },
      },
      {
        ...original,
        recipe: await authenticatedRecipe({ defaultMaxAgeSec: 7_200 }),
      },
      { ...original, classification: "freshness" },
    ];
    for (const mismatch of mismatches) {
      await expect(vetCore(mismatch, deps)).rejects.toThrow(
        /checkpoint is corrupt or mismatched/,
      );
    }
    expect(authorityCalls).toBe(0);
  });

  test("durably replays a terminal method failure without rerunning authority", async () => {
    const store: FinalizedStore = new Map();
    const deps = baseDeps(store);
    let authorityCalls = 0;
    let anchorCalls = 0;
    deps.proxyFetch = async () => {
      authorityCalls += 1;
      throw new Error("authority unavailable after operation intent");
    };
    deps.anchorFinalizedArtifact = async () => {
      anchorCalls += 1;
      throw new Error("must not anchor without a result");
    };
    const request: VetRequest = {
      jobId: "job-vet-partial-intent",
      subject: "domain:alice.example",
      bundleHash: BUNDLE_HASH,
      requirement: requirement("domain"),
      recipe: await authenticatedRecipe(),
    };

    await expect(vetCore(request, deps)).rejects.toThrow(
      /authority unavailable/,
    );
    await expect(vetCore(request, deps)).rejects.toThrow(
      /authority unavailable/,
    );
    expect({ authorityCalls, anchorCalls }).toEqual({
      authorityCalls: 1,
      anchorCalls: 0,
    });
  });

  test("does not resubmit an unanchored result from a prior partial submission", async () => {
    const store: FinalizedStore = new Map();
    const deps = baseDeps(store);
    const proxyFetch = deps.proxyFetch;
    const anchor = deps.anchorFinalizedArtifact;
    let authorityCalls = 0;
    let anchorCalls = 0;
    deps.proxyFetch = async (input) => {
      authorityCalls += 1;
      return proxyFetch(input);
    };
    deps.anchorFinalizedArtifact = async (input) => {
      anchorCalls += 1;
      if (!input.logicalAddress.startsWith("dacs2:composite:")) {
        throw new Error("result submission failed before commit");
      }
      return anchor(input);
    };
    const request: VetRequest = {
      jobId: "job-vet-partial-result-submission",
      subject: "domain:alice.example",
      bundleHash: BUNDLE_HASH,
      requirement: requirement("domain"),
      recipe: await authenticatedRecipe(),
    };

    await expect(vetCore(request, deps)).rejects.toThrow(
      /submission outcome is indeterminate.*refusing to resubmit/,
    );
    await expect(vetCore(request, deps)).rejects.toThrow(
      /submission outcome is indeterminate.*refusing to resubmit/,
    );
    expect({ authorityCalls, anchorCalls }).toEqual({
      authorityCalls: 1,
      anchorCalls: 1,
    });
  });

  test("fails closed when durable operation lookup is indeterminate", async () => {
    const deps = baseDeps(new Map());
    let authorityCalls = 0;
    let anchorCalls = 0;
    deps.proxyFetch = async () => {
      authorityCalls += 1;
      throw new Error("must not reach authority");
    };
    deps.anchorFinalizedArtifact = async () => {
      anchorCalls += 1;
      throw new Error("must not reach anchor");
    };
    deps.operationStore = {
      ...deps.operationStore!,
      load: async () => {
        throw new Error("operation database timed out");
      },
    };

    await expect(
      vetCore(
        {
          jobId: "job-vet-indeterminate-operation-lookup",
          subject: "domain:alice.example",
          bundleHash: BUNDLE_HASH,
          requirement: requirement("domain"),
          recipe: await authenticatedRecipe(),
        },
        deps,
      ),
    ).rejects.toThrow(/operation lookup is indeterminate/);
    expect({ authorityCalls, anchorCalls }).toEqual({
      authorityCalls: 0,
      anchorCalls: 0,
    });
  });

  test("rejects corrupt checkpoint bytes before authority or anchoring", async () => {
    const store: FinalizedStore = new Map();
    const deps = baseDeps(store);
    const request: VetRequest = {
      jobId: "job-vet-corrupt-checkpoint",
      subject: "domain:alice.example",
      bundleHash: BUNDLE_HASH,
      requirement: requirement("domain"),
      recipe: await authenticatedRecipe(),
    };
    await vetCore(request, deps);
    const operations = operationStoreFor(store);
    const [operationKey, persisted] = [...operations.entries()][0]!;
    const corrupt = structuredClone(persisted);
    if (corrupt.stage !== "complete") throw new Error("expected complete checkpoint");
    corrupt.record.bundleHash = "d".repeat(64);
    operations.set(operationKey, corrupt);
    let authorityCalls = 0;
    let anchorCalls = 0;
    deps.proxyFetch = async () => {
      authorityCalls += 1;
      throw new Error("must not query authority with corrupt state");
    };
    deps.anchorFinalizedArtifact = async () => {
      anchorCalls += 1;
      throw new Error("must not anchor corrupt state");
    };

    await expect(vetCore(request, deps)).rejects.toThrow(
      /composite checkpoint is corrupt or mismatched/,
    );
    expect({ authorityCalls, anchorCalls }).toEqual({
      authorityCalls: 0,
      anchorCalls: 0,
    });
  });

  test("rejects mismatched independently read finalized bytes on recovery", async () => {
    const store: FinalizedStore = new Map();
    const deps = baseDeps(store);
    const request: VetRequest = {
      jobId: "job-vet-corrupt-readback",
      subject: "domain:alice.example",
      bundleHash: BUNDLE_HASH,
      requirement: requirement("domain"),
      recipe: await authenticatedRecipe(),
    };
    await vetCore(request, deps);
    const stored = [...store.values()].find(({ artifact }) =>
      isVerifyResult(artifact),
    );
    if (!stored) throw new Error("expected finalized VerifyResult");
    stored.artifact.decision = "fail";
    let authorityCalls = 0;
    let anchorCalls = 0;
    deps.proxyFetch = async () => {
      authorityCalls += 1;
      throw new Error("must not query authority during recovery");
    };
    deps.anchorFinalizedArtifact = async () => {
      anchorCalls += 1;
      throw new Error("must not anchor during recovery");
    };

    await expect(vetCore(request, deps)).rejects.toThrow(
      /finalized (receipt did not authenticate|readback does not match exact signed bytes)/,
    );
    expect({ authorityCalls, anchorCalls }).toEqual({
      authorityCalls: 0,
      anchorCalls: 0,
    });
  });

  test("self-signed proves key possession and finalizes exact method evidence", async () => {
    const subjectSeed = new Uint8Array(32).fill(9);
    const subject =
      `key:${Buffer.from(rawPublicKey(publicKeyFromSeed(subjectSeed))).toString("hex")}`;
    const assertionSignature = Buffer.from(
      ed25519Sign(
        selfSignedAssertionBytes(subject),
        privateKeyFromSeed(subjectSeed),
      ),
    ).toString("hex");
    const store: FinalizedStore = new Map();

    const production = await vetCore(
      {
        jobId: "job-self-1",
        subject,
        bundleHash: BUNDLE_HASH,
        requirement: requirement("key"),
        recipe: await authenticatedRecipe({
          scheme: "key",
          defaultMethod: { kind: "self-signed" },
        }),
        selfSigned: { assertion: subject, signature: assertionSignature },
      },
      baseDeps(store),
    );

    expect(production.record.overallDecision).toBe("pass");
    expect(storedVerifyResult(store).method).toBe("self-signed");
    const assertion = storedArtifacts(store).find(
      (artifact) => artifact.assertionVersion === "1",
    );
    expect(assertion).toMatchObject({ subject, assertion: subject });
  });

  test("self-signed missing or malformed proof input never passes", async () => {
    const missing = await selfSignedRequest();
    delete missing.selfSigned;
    const requests = [
      missing,
      await selfSignedRequest({
        selfSigned: {
          assertion: SELF_SIGNED_SUBJECT,
          signature: "not-a-signature",
        },
      }),
    ];
    for (const request of requests) {
      const store: FinalizedStore = new Map();
      await expect(
        vetCore(request, baseDeps(store)),
      ).rejects.toThrow(/canonical proof and SR-2 anchor/);
      expect(storedArtifacts(store)).toEqual([]);
    }
  });

  test("self-signed rejects malformed and non-canonical key ClaimReferences", async () => {
    for (const subject of [
      `did:demos:agent:${"a".repeat(64)}`,
      `key:0x${"a".repeat(64)}`,
      `key:${"A".repeat(64)}`,
      "key:abcd",
    ]) {
      const store: FinalizedStore = new Map();
      await expect(
        vetCore(
          await selfSignedRequest({ subject }),
          baseDeps(store),
        ),
      ).rejects.toThrow(/cannot verify|canonical proof and SR-2 anchor/);
      expect(storedArtifacts(store)).toEqual([]);
    }
    expect(() =>
      selfSignedAssertionBytes(`${SELF_SIGNED_SUBJECT}?z=last&a=first`),
    ).toThrow(/canonical key/);
    expect(() =>
      selfSignedAssertionBytes(`${SELF_SIGNED_SUBJECT}?purpose=bad%3avalue`),
    ).toThrow(/canonical key/);
  });

  test("self-signed signature from the wrong key is a durable failure", async () => {
    const store: FinalizedStore = new Map();
    const production = await vetCore(
      await selfSignedRequest({
        selfSigned: {
          assertion: SELF_SIGNED_SUBJECT,
          signature: selfSignedSignature(
            SELF_SIGNED_SUBJECT,
            OTHER_SELF_SIGNED_SEED,
          ),
        },
      }),
      baseDeps(store),
    );

    expect(production.record.overallDecision).toBe("fail");
    expect(storedVerifyResult(store).decision).toBe("fail");
    expect(
      storedArtifacts(store).some(
        (artifact) => artifact.assertionVersion === "1",
      ),
    ).toBe(true);
  });

  test("self-signed assertion replayed for another claim is a durable failure", async () => {
    const store: FinalizedStore = new Map();
    const production = await vetCore(
      await selfSignedRequest({
        subject: OTHER_SELF_SIGNED_SUBJECT,
        selfSigned: {
          assertion: SELF_SIGNED_SUBJECT,
          signature: selfSignedSignature(SELF_SIGNED_SUBJECT),
        },
      }),
      baseDeps(store),
    );

    expect(production.record.overallDecision).toBe("fail");
    expect(storedVerifyResult(store).decision).toBe("fail");
  });

  test("self-signed comparison preserves the signed CF-3 parameters", async () => {
    const assertion = `${SELF_SIGNED_SUBJECT}?purpose=vet&region=GB`;
    const store: FinalizedStore = new Map();
    const production = await vetCore(
      await selfSignedRequest({
        selfSigned: {
          assertion,
          signature: selfSignedSignature(assertion),
        },
      }),
      baseDeps(store),
    );

    expect(production.record.overallDecision).toBe("pass");
    expect(storedVerifyResult(store).decision).toBe("pass");
  });

  test("self-signed raw or cross-domain signatures do not verify", async () => {
    const rawSignature = Buffer.from(
      ed25519Sign(
        Buffer.from(SELF_SIGNED_SUBJECT),
        privateKeyFromSeed(SELF_SIGNED_SEED),
      ),
    ).toString("hex");
    const store: FinalizedStore = new Map();
    const production = await vetCore(
      await selfSignedRequest({
        selfSigned: {
          assertion: SELF_SIGNED_SUBJECT,
          signature: rawSignature,
        },
      }),
      baseDeps(store),
    );

    expect(production.record.overallDecision).toBe("fail");
    expect(storedVerifyResult(store).decision).toBe("fail");
  });

  test("self-signed SR-2 failure or a mismatched proof signer is an error", async () => {
    const unavailableStore: FinalizedStore = new Map();
    const unavailableDeps = baseDeps(unavailableStore);
    unavailableDeps.anchorFinalizedArtifact = async () => {
      throw new Error("substrate unavailable");
    };
    await expect(
      vetCore(await selfSignedRequest(), unavailableDeps),
    ).rejects.toThrow(/indeterminate; refusing to resubmit/);

    const mismatchedStore: FinalizedStore = new Map();
    const mismatchedDeps = baseDeps(mismatchedStore);
    const anchorFinalizedArtifact = mismatchedDeps.anchorFinalizedArtifact;
    mismatchedDeps.anchorFinalizedArtifact = async (input) => {
      const anchored = await anchorFinalizedArtifact(input);
      if (
        (input.artifact as unknown as Record<string, unknown>)
          .assertionVersion === "1"
      ) {
        return {
          ...anchored,
          ref: { ...anchored.ref, signer: OTHER_SELF_SIGNED_SUBJECT },
        };
      }
      return anchored;
    };
    await expect(
      vetCore(
        await selfSignedRequest({ jobId: "job-self-mismatched-signer" }),
        mismatchedDeps,
      ),
    ).rejects.toThrow(/does not bind the exact proof and signer/);
  });
});

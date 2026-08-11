import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  canonicalize,
  contentHash,
  createFsFencedSessionStore,
  ed25519Sign,
  ed25519Verify,
  identityBundleHash,
  partyVetCore,
  partyVetPinScopeHash,
  pinSessionRecipeRegistrySnapshot,
  pinSessionRecipeSelection,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
  recoverSessionRecipePin,
  recoverSessionRecipeRegistrySnapshot,
  sha256Hex,
  signComponentArtifact,
  signedBytes,
  type AttestationRef,
  type CompositeBundleRequirement,
  type DurableSessionRecipePin,
  type FinalizedVetAnchor,
  type FinalizedVetAnchorReceipt,
  type FencedSessionStoreV2,
  type IdentityBundle,
  type PartyVetDeps,
  type PartyVetOperationStore,
  type PartyVetRequest,
  type RecipeDescriptor,
} from "../../src/index.js";
import type { SessionLeaseToken } from "../../src/agent/fencedSessionStore.js";
import { createPartyVetPinRegistryProvider } from "./partyVetPins.js";

const VERIFIER_SEED = new Uint8Array(32).fill(101);
const VERIFIER_KEY = rawPublicKey(publicKeyFromSeed(VERIFIER_SEED));
const VERIFIER = `key:${Buffer.from(VERIFIER_KEY).toString("hex")}`;
const STEWARD_SEED = new Uint8Array(32).fill(102);
const STEWARD_KEY = rawPublicKey(publicKeyFromSeed(STEWARD_SEED));
const STEWARD = `key:${Buffer.from(STEWARD_KEY).toString("hex")}`;
const PRESENTER_SEED = new Uint8Array(32).fill(103);
const PRESENTER_KEY = rawPublicKey(publicKeyFromSeed(PRESENTER_SEED));
const T0 = 1_786_600_000_000;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })),
  );
});

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function withFileLock<T>(
  lockPath: string,
  action: () => Promise<T>,
): Promise<T> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await delay(1);
    }
  }
  if (!handle) throw new Error(`timed out acquiring test lock ${lockPath}`);
  try {
    return await action();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => {});
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

interface FsStepRecord {
  operationKey: string;
  operationHash: string;
  step: Parameters<PartyVetOperationStore["runOnce"]>[0]["step"];
  inputHash: string;
  state: "complete" | "failed";
  value?: unknown;
  error?: string;
}

interface FsCheckpointRecord {
  operationKey: string;
  value: unknown;
}

interface FsOperationHarness {
  store: PartyVetOperationStore;
  inspect: () => Promise<{ checkpoints: number; terminalSteps: number }>;
}

async function createFsPartyVetOperationHarness(
  directory: string,
  options: {
    loseCommittedResponseAt?: Parameters<PartyVetOperationStore["runOnce"]>[0]["step"];
  } = {},
): Promise<FsOperationHarness> {
  const checkpointsDirectory = join(directory, "checkpoints");
  const stepsDirectory = join(directory, "steps");
  const locksDirectory = join(directory, "locks");
  await Promise.all([
    mkdir(checkpointsDirectory, { recursive: true, mode: 0o700 }),
    mkdir(stepsDirectory, { recursive: true, mode: 0o700 }),
    mkdir(locksDirectory, { recursive: true, mode: 0o700 }),
  ]);
  const lostResponses = new Set<string>();
  const checkpointId = (operationKey: string) => sha256Hex(operationKey);
  const stepId = (
    operationKey: string,
    step: Parameters<PartyVetOperationStore["runOnce"]>[0]["step"],
  ) => sha256Hex(canonicalize({ operationKey, step }));
  const checkpointPath = (operationKey: string) =>
    join(checkpointsDirectory, `${checkpointId(operationKey)}.json`);
  const stepPath = (
    operationKey: string,
    step: Parameters<PartyVetOperationStore["runOnce"]>[0]["step"],
  ) => join(stepsDirectory, `${stepId(operationKey, step)}.json`);
  const lockPath = (id: string) => join(locksDirectory, `${id}.lock`);

  const readCheckpoint = async (operationKey: string): Promise<unknown | null> => {
    const raw = await readJson(checkpointPath(operationKey));
    if (raw === null) return null;
    const record = raw as FsCheckpointRecord;
    if (record.operationKey !== operationKey) {
      throw new Error("filesystem party Vet checkpoint address collision");
    }
    return structuredClone(record.value);
  };

  type AuthorizedInput = Parameters<PartyVetOperationStore["runOnceAuthorized"]>[0];
  type AuthorizedOutcome = Awaited<ReturnType<PartyVetOperationStore["runOnceAuthorized"]>>;

  const runAuthorized = async (input: AuthorizedInput): Promise<AuthorizedOutcome> => {
    const id = stepId(input.operationKey, input.step);
    const outcome = await withFileLock(lockPath(id), async () => {
      const raw = await readJson(stepPath(input.operationKey, input.step));
      if (raw !== null) {
        const prior = raw as FsStepRecord;
        if (
          prior.operationKey !== input.operationKey ||
          prior.operationHash !== input.operationHash ||
          prior.step !== input.step ||
          prior.inputHash !== input.inputHash
        ) {
          throw new Error(`filesystem party Vet ${input.step} journal mismatch`);
        }
        if (prior.state === "failed") throw new Error(prior.error);
        return {
          created: false,
          result: {
            status: "complete" as const,
            value: structuredClone(prior.value),
          },
        };
      }

      const authorization = await input.authorize();
      if (authorization.status === "rejected") {
        return {
          created: false,
          result: {
            status: "authorization-rejected" as const,
            reason: authorization.reason,
          },
        };
      }

      let value: unknown;
      try {
        value = structuredClone(await input.execute());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await atomicWriteJson(stepPath(input.operationKey, input.step), {
          operationKey: input.operationKey,
          operationHash: input.operationHash,
          step: input.step,
          inputHash: input.inputHash,
          state: "failed",
          error: message,
        } satisfies FsStepRecord);
        throw error;
      }
      await atomicWriteJson(stepPath(input.operationKey, input.step), {
        operationKey: input.operationKey,
        operationHash: input.operationHash,
        step: input.step,
        inputHash: input.inputHash,
        state: "complete",
        value,
      } satisfies FsStepRecord);
      return {
        created: true,
        result: { status: "complete" as const, value },
      };
    });

    if (
      outcome.created &&
      options.loseCommittedResponseAt === input.step &&
      !lostResponses.has(id)
    ) {
      lostResponses.add(id);
      throw new Error(`simulated committed ${input.step} response loss`);
    }
    return structuredClone(outcome.result);
  };

  const store: PartyVetOperationStore = {
    load: readCheckpoint,
    compareAndSet: async ({ operationKey, expected, next }) => {
      const id = checkpointId(operationKey);
      return withFileLock(lockPath(id), async () => {
        const current = await readCheckpoint(operationKey);
        const matches = expected === null
          ? current === null
          : current !== null && canonicalize(current) === canonicalize(expected);
        if (!matches) return false;
        await atomicWriteJson(checkpointPath(operationKey), {
          operationKey,
          value: structuredClone(next),
        } satisfies FsCheckpointRecord);
        return true;
      });
    },
    runOnce: async (input) => {
      const result = await runAuthorized({
        ...input,
        authorize: async () => ({ status: "authorized" as const }),
      });
      if (result.status !== "complete") {
        throw new Error(`unexpected ${result.reason} authorization rejection`);
      }
      return result.value;
    },
    runOnceAuthorized: runAuthorized,
  };
  return {
    store,
    inspect: async () => ({
      checkpoints: (await readdir(checkpointsDirectory)).filter(
        (name) => name.endsWith(".json"),
      ).length,
      terminalSteps: (await readdir(stepsDirectory)).filter(
        (name) => name.endsWith(".json"),
      ).length,
    }),
  };
}

interface EffectCounts {
  methods: number;
  signs: number;
  anchors: number;
}

interface FsArtifactRecord {
  logicalAddress: string;
  artifact: Record<string, unknown>;
  ref: AttestationRef;
  receipt: FinalizedVetAnchorReceipt;
}

interface FsEffects {
  proxyFetch: PartyVetDeps<Uint8Array>["proxyFetch"];
  sign: NonNullable<PartyVetDeps<Uint8Array>["componentSigner"]>["sign"];
  anchorFinalizedArtifact: PartyVetDeps<Uint8Array>["anchorFinalizedArtifact"];
  verifyFinalizedAnchor: PartyVetDeps<Uint8Array>["verifyFinalizedAnchor"];
  readAnchoredJson: PartyVetDeps<Uint8Array>["readAnchoredJson"];
  resolveFinalizedArtifact: PartyVetDeps<Uint8Array>["resolveFinalizedArtifact"];
  inspect: () => Promise<{ counts: EffectCounts; artifacts: number }>;
}

async function createFsEffects(
  directory: string,
  options: { beforeFirstMethod?: () => Promise<void>; now?: number } = {},
): Promise<FsEffects> {
  const artifactsDirectory = join(directory, "artifacts");
  const locksDirectory = join(directory, "locks");
  const countsPath = join(directory, "counts.json");
  const countsLock = join(locksDirectory, "counts.lock");
  await Promise.all([
    mkdir(artifactsDirectory, { recursive: true, mode: 0o700 }),
    mkdir(locksDirectory, { recursive: true, mode: 0o700 }),
  ]);
  let methodGateUsed = false;

  const artifactId = (logicalAddress: string) => sha256Hex(logicalAddress);
  const artifactPath = (logicalAddress: string) =>
    join(artifactsDirectory, `${artifactId(logicalAddress)}.json`);
  const artifactLock = (logicalAddress: string) =>
    join(locksDirectory, `${artifactId(logicalAddress)}.lock`);
  const nativeAddress = (logicalAddress: string) =>
    `fs-party-vet:${Buffer.from(logicalAddress).toString("base64url")}`;
  const logicalAddressFromNative = (locator: string): string | null => {
    if (!locator.startsWith("fs-party-vet:")) return null;
    try {
      return Buffer.from(locator.slice("fs-party-vet:".length), "base64url")
        .toString("utf8");
    } catch {
      return null;
    }
  };
  const increment = async (field: keyof EffectCounts): Promise<void> => {
    await withFileLock(countsLock, async () => {
      const prior = (await readJson(countsPath) ?? {
        methods: 0,
        signs: 0,
        anchors: 0,
      }) as EffectCounts;
      await atomicWriteJson(countsPath, { ...prior, [field]: prior[field] + 1 });
    });
  };
  const readArtifact = async (
    logicalAddress: string,
  ): Promise<FsArtifactRecord | null> => {
    const raw = await readJson(artifactPath(logicalAddress));
    if (raw === null) return null;
    const record = raw as FsArtifactRecord;
    if (record.logicalAddress !== logicalAddress) {
      throw new Error("filesystem party Vet artifact address collision");
    }
    return record;
  };

  const proxyFetch: FsEffects["proxyFetch"] = async ({ url }) => {
    await increment("methods");
    if (!methodGateUsed && options.beforeFirstMethod) {
      methodGateUsed = true;
      await options.beforeFirstMethod();
    }
    const scheme = new URL(url).pathname.split("/").filter(Boolean)[0]!;
    const body = JSON.stringify({ ok: true });
    return {
      status: 200,
      body,
      attestation: {
        anchor: {
          kind: "https",
          locator: `https://authority.example/evidence/${scheme}`,
        },
        contentHash: sha256Hex(body),
        signer: "substrate-validator-set:demos-testnet:1",
      },
      fetchedAt: options.now ?? T0 + 3,
      complete: true,
    };
  };
  const sign: FsEffects["sign"] = async (bytes) => {
    await increment("signs");
    return ed25519Sign(bytes, privateKeyFromSeed(VERIFIER_SEED));
  };
  const anchorFinalizedArtifact: FsEffects["anchorFinalizedArtifact"] = async ({
    logicalAddress,
    artifact,
  }) => {
    await increment("anchors");
    return withFileLock(artifactLock(logicalAddress), async () => {
      const exact = structuredClone(artifact) as Record<string, unknown>;
      const hash = contentHash(exact);
      const existing = await readArtifact(logicalAddress);
      if (existing) {
        if (
          existing.ref.contentHash !== hash ||
          canonicalize(existing.artifact) !== canonicalize(exact)
        ) {
          throw new Error(`filesystem logical address collision at ${logicalAddress}`);
        }
        return structuredClone({ ref: existing.ref, receipt: existing.receipt });
      }
      const native = nativeAddress(logicalAddress);
      const ref: AttestationRef = {
        anchor: { kind: "storage-program", locator: native },
        contentHash: hash,
      };
      const receipt: FinalizedVetAnchorReceipt = {
        receiptVersion: "1",
        substrate: "party-vet-filesystem-test",
        finalityProfile: "atomic-file-finality",
        logicalAddress,
        nativeAddress: native,
        contentHash: hash,
        transactionRef: { kind: "filesystem", value: `file:${hash}` },
        writer: VERIFIER,
        nonce: "1",
        state: "finalized",
        observationDisposition: "established",
        observedAt: options.now ?? T0 + 3,
        blockRef: {
          id: `file-block:${hash}`,
          height: "1",
          timestamp: options.now ?? T0 + 3,
        },
        evidence: { kind: "atomic-file", value: `proof:${hash}` },
      };
      await atomicWriteJson(artifactPath(logicalAddress), {
        logicalAddress,
        artifact: exact,
        ref,
        receipt,
      } satisfies FsArtifactRecord);
      return { ref, receipt };
    });
  };
  const verifyFinalizedAnchor: FsEffects["verifyFinalizedAnchor"] = async ({
    logicalAddress,
    artifact,
    ref,
    receipt,
  }) => {
    const stored = await readArtifact(logicalAddress);
    return stored !== null &&
      stored.ref.anchor.locator === ref.anchor.locator &&
      stored.ref.contentHash === ref.contentHash &&
      receipt.logicalAddress === logicalAddress &&
      receipt.contentHash === contentHash(
        artifact as unknown as Record<string, unknown>,
      ) &&
      canonicalize(stored.artifact) === canonicalize(artifact);
  };
  const readAnchoredJson: FsEffects["readAnchoredJson"] = async (ref) => {
    const logicalAddress = logicalAddressFromNative(ref.anchor.locator);
    if (logicalAddress === null) return null;
    const stored = await readArtifact(logicalAddress);
    return stored ? structuredClone(stored.artifact) : null;
  };
  const resolveFinalizedArtifact: FsEffects["resolveFinalizedArtifact"] = async ({
    logicalAddress,
    contentHash: hash,
  }) => {
    const stored = await readArtifact(logicalAddress);
    return stored?.ref.contentHash === hash
      ? structuredClone({ ref: stored.ref, receipt: stored.receipt })
      : null;
  };
  return {
    proxyFetch,
    sign,
    anchorFinalizedArtifact,
    verifyFinalizedAnchor,
    readAnchoredJson,
    resolveFinalizedArtifact,
    inspect: async () => ({
      counts: (await readJson(countsPath) ?? {
        methods: 0,
        signs: 0,
        anchors: 0,
      }) as EffectCounts,
      artifacts: (await readdir(artifactsDirectory)).filter(
        (name) => name.endsWith(".json"),
      ).length,
    }),
  };
}

async function recipe(scheme: string) {
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
    parserRules: { format: "json", successJsonPath: "$.ok" },
    retryClass: "permanent",
    availability: "live",
    governance: {
      proposedBy: STEWARD,
      acceptedAt: T0 - 10_000,
      anchoring: "single-signer",
    },
  };
  return signComponentArtifact(descriptor, "dacs-recipe:v1:", {
    algorithm: "ed25519",
    signer: STEWARD,
    sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(STEWARD_SEED)),
  });
}

async function bundle(presentedBy: string, refs: readonly string[]) {
  const identity: IdentityBundle = {
    bundleVersion: "1",
    presentedBy,
    presentedAt: T0 - 1_000,
    claims: refs.map((ref) => ({ ref })),
    presentation: {
      kind: "siwd",
      message: "filesystem party Vet presentation",
      signature: "pending",
      address: presentedBy,
    },
  };
  Object.defineProperty(identity, "__proto__", {
    value: { extensionVersion: "1", marker: "cold-restart-exact-member" },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  if (identity.presentation.kind !== "siwd") throw new Error("expected SIWD");
  identity.presentation.signature = Buffer.from(
    ed25519Sign(
      signedBytes("dacs-bundle-presentation:v1:", identityBundleHash(identity)),
      privateKeyFromSeed(PRESENTER_SEED),
    ),
  ).toString("hex");
  return identity;
}

async function acquireLease(
  store: FencedSessionStoreV2,
  jobId: string,
  owner: string,
  now: number,
  ttlMs: number,
): Promise<SessionLeaseToken> {
  const result = await store.acquireLease({ jobId, owner, now, ttlMs });
  if (!result.ok) throw new Error(`lease acquisition failed: ${result.reason}`);
  return { owner: result.lease.owner, generation: result.lease.generation };
}

function makeDeps(
  operationStore: PartyVetOperationStore,
  effects: FsEffects,
  sessionStore: FencedSessionStoreV2,
  leaseToken: SessionLeaseToken,
  now: number,
): PartyVetDeps<Uint8Array> {
  return {
    proxyFetch: effects.proxyFetch,
    nowMs: () => now,
    componentSigner: {
      algorithm: "ed25519",
      signer: VERIFIER,
      sign: effects.sign,
    },
    anchorFinalizedArtifact: effects.anchorFinalizedArtifact,
    verifyFinalizedAnchor: effects.verifyFinalizedAnchor,
    readAnchoredJson: effects.readAnchoredJson,
    resolveFinalizedArtifact: effects.resolveFinalizedArtifact,
    operationStore,
    verifyIdentityPresentation: ({ bundle: presented, signedBytes: bytes }) => {
      if (presented.presentation.kind !== "siwd") return false;
      return ed25519Verify(
        bytes,
        Uint8Array.from(Buffer.from(presented.presentation.signature, "hex")),
        publicKeyFromRaw(PRESENTER_KEY),
      );
    },
    componentVerifier: {
      isSignerAuthorized: (_artifact, signature) => signature.signer === VERIFIER,
      resolvePublicKey: (signature) =>
        signature.algorithm === "ed25519" ? VERIFIER_KEY : null,
      verify: ({ signedBytes: bytes, signature, publicKey }) =>
        ed25519Verify(
          bytes,
          Uint8Array.from(Buffer.from(signature.value, "base64url")),
          publicKeyFromRaw(publicKey),
        ),
    },
    sessionEffectAuthority: { store: sessionStore, leaseToken },
    matchRequirementParameters: () => true,
  };
}

describe("partyVetCore cold filesystem recovery", () => {
  test("recovers #143 pins and exact #144 bytes after a journaled crash while concurrent workers converge", async () => {
    const root = await mkdtemp(join(tmpdir(), "dacs-party-vet-fs-"));
    temporaryDirectories.push(root);
    const sessionDirectory = join(root, "session");
    const operationDirectory = join(root, "operations");
    const effectDirectory = join(root, "effects");
    const inputPath = join(root, "party-input.json");
    const jobId = "job-party-vet-cold-filesystem";
    const alpha = "alpha:alice";
    const beta = "beta:alice";
    const identityBundle = await bundle(alpha, [alpha, beta]);
    const requirement: CompositeBundleRequirement = {
      requirementVersion: "1",
      required: [
        { scheme: "alpha", verificationRequired: true, recipeVersion: 1 },
        { scheme: "beta", verificationRequired: true, recipeVersion: 1 },
      ],
    };
    const paths = [
      { kind: "required" as const, index: 0 },
      { kind: "required" as const, index: 1 },
    ];
    const subjects = [alpha, beta] as const;
    const pinScopeAttempts = paths.map((requirementPath, index) => ({
      requirementPath,
      claimSubject: subjects[index]!,
      classification: "dealSpecific" as const,
      methodInput: { kind: "consensus-backed-proxy" as const },
    }));
    const partyPlanHash = partyVetPinScopeHash({
      jobId,
      evaluatedParty: alpha,
      identityBundle,
      requirement,
      verifier: { algorithm: "ed25519", signer: VERIFIER },
      attempts: pinScopeAttempts,
    });
    await writeFile(
      inputPath,
      canonicalize({ jobId, evaluatedParty: alpha, identityBundle, requirement }),
      { mode: 0o600 },
    );

    const recipes = await Promise.all([recipe("alpha"), recipe("beta")]);
    const provider = createPartyVetPinRegistryProvider({
      recipes,
      stewardSigner: STEWARD,
      stewardPublicKey: STEWARD_KEY,
      verify: (bytes, signature, publicKey) =>
        ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
      now: T0 + 1,
    });
    const firstSession = await createFsFencedSessionStore({
      dir: sessionDirectory,
    });
    await firstSession.create({ jobId, now: T0 });
    const firstLease = await acquireLease(
      firstSession,
      jobId,
      "party-vet-worker-g1",
      T0,
      100,
    );
    const firstSnapshot = await pinSessionRecipeRegistrySnapshot({
      store: firstSession,
      jobId,
      sessionStartHash: partyPlanHash,
      provider,
      leaseToken: firstLease,
      now: T0 + 1,
    });
    const firstPins = await Promise.all(paths.map((requirementPath) =>
      pinSessionRecipeSelection({
        store: firstSession,
        sessionSnapshot: firstSnapshot,
        jobId,
        evaluatedParty: alpha,
        requirementPath,
        bundleRequirement: requirement,
        partyPlanHash,
        requestedMethod: "consensus-backed-proxy",
        leaseToken: firstLease,
        now: T0 + 2,
      })));
    const requestWith = (
      exactIdentity: IdentityBundle,
      exactRequirement: CompositeBundleRequirement,
      pins: readonly DurableSessionRecipePin[],
    ): PartyVetRequest => ({
      jobId,
      evaluatedParty: alpha,
      identityBundle: exactIdentity,
      requirement: exactRequirement,
      attempts: paths.map((requirementPath, index) => ({
        requirementPath,
        claimSubject: subjects[index]!,
        recipePin: pins[index]!,
        methodInput: { kind: "consensus-backed-proxy" },
      })),
    });
    const firstOperations = await createFsPartyVetOperationHarness(
      operationDirectory,
      { loseCommittedResponseAt: "method" },
    );
    const firstEffects = await createFsEffects(effectDirectory);

    await expect(partyVetCore(
      requestWith(identityBundle, requirement, firstPins),
      makeDeps(
        firstOperations.store,
        firstEffects,
        firstSession,
        firstLease,
        T0 + 3,
      ),
    )).rejects.toThrow(/method authorized run failed/);
    expect((await firstEffects.inspect()).counts).toEqual({
      methods: 1,
      signs: 0,
      anchors: 0,
    });

    const restartedInput = JSON.parse(await readFile(inputPath, "utf8")) as {
      jobId: string;
      evaluatedParty: string;
      identityBundle: IdentityBundle;
      requirement: CompositeBundleRequirement;
    };
    expect(Object.prototype.hasOwnProperty.call(
      restartedInput.identityBundle,
      "__proto__",
    )).toBe(true);
    expect(identityBundleHash(restartedInput.identityBundle)).toBe(
      identityBundleHash(identityBundle),
    );
    const secondSession = await createFsFencedSessionStore({
      dir: sessionDirectory,
    });
    const secondLease = await acquireLease(
      secondSession,
      jobId,
      "party-vet-worker-g2",
      T0 + 101,
      1_000,
    );
    const recoverPins = async (): Promise<DurableSessionRecipePin[]> => {
      const snapshot = await recoverSessionRecipeRegistrySnapshot({
        store: secondSession,
        jobId,
        sessionStartHash: partyPlanHash,
        leaseToken: secondLease,
        now: T0 + 102,
      });
      return Promise.all(paths.map((requirementPath) => recoverSessionRecipePin({
        store: secondSession,
        sessionSnapshot: snapshot,
        jobId,
        evaluatedParty: alpha,
        requirementPath,
        bundleRequirement: restartedInput.requirement,
        partyPlanHash,
        requestedMethod: "consensus-backed-proxy",
        leaseToken: secondLease,
        now: T0 + 103,
      })));
    };
    const [leftPins, rightPins] = await Promise.all([
      recoverPins(),
      recoverPins(),
    ]);
    expect(leftPins.map((pin) => pin.pinHash)).toEqual(
      firstPins.map((pin) => pin.pinHash),
    );
    expect(new Set(leftPins.map((pin) => pin.sessionSnapshotHash))).toEqual(
      new Set([firstSnapshot.snapshotHash]),
    );

    let methodEntered!: () => void;
    let releaseMethod!: () => void;
    const entered = new Promise<void>((resolve) => {
      methodEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseMethod = resolve;
    });
    const [leftOperations, rightOperations] = await Promise.all([
      createFsPartyVetOperationHarness(operationDirectory),
      createFsPartyVetOperationHarness(operationDirectory),
    ]);
    const [leftEffects, rightEffects] = await Promise.all([
      createFsEffects(effectDirectory, {
        now: T0 + 103,
        beforeFirstMethod: async () => {
          methodEntered();
          await release;
        },
      }),
      createFsEffects(effectDirectory, { now: T0 + 103 }),
    ]);
    const leftPromise = partyVetCore(
      requestWith(
        restartedInput.identityBundle,
        restartedInput.requirement,
        leftPins,
      ),
      makeDeps(
        leftOperations.store,
        leftEffects,
        secondSession,
        secondLease,
        T0 + 103,
      ),
    );
    await entered;
    const rightPromise = partyVetCore(
      requestWith(
        restartedInput.identityBundle,
        restartedInput.requirement,
        rightPins,
      ),
      makeDeps(
        rightOperations.store,
        rightEffects,
        secondSession,
        secondLease,
        T0 + 103,
      ),
    );
    await delay(10);
    releaseMethod();
    const [left, right] = await Promise.all([leftPromise, rightPromise]);
    expect(canonicalize(left)).toBe(canonicalize(right));

    const completedEffects = await leftEffects.inspect();
    expect(completedEffects).toEqual({
      counts: { methods: 2, signs: 3, anchors: 3 },
      artifacts: 3,
    });
    expect(await leftOperations.inspect()).toEqual({
      checkpoints: 3,
      terminalSteps: 8,
    });
    expect(left.record.dealSpecific).toHaveLength(2);
    expect(left.record.freshness).toEqual([]);
    expect(left.record.overallDecision).toBe("pass");

    const thirdSession = await createFsFencedSessionStore({
      dir: sessionDirectory,
    });
    const thirdLease = await acquireLease(
      thirdSession,
      jobId,
      "party-vet-worker-g3",
      T0 + 1_102,
      1_000,
    );
    const thirdSnapshot = await recoverSessionRecipeRegistrySnapshot({
      store: thirdSession,
      jobId,
      sessionStartHash: partyPlanHash,
      leaseToken: thirdLease,
      now: T0 + 1_103,
    });
    const thirdPins = await Promise.all(paths.map((requirementPath) =>
      recoverSessionRecipePin({
        store: thirdSession,
        sessionSnapshot: thirdSnapshot,
        jobId,
        evaluatedParty: alpha,
        requirementPath,
        bundleRequirement: restartedInput.requirement,
        partyPlanHash,
        requestedMethod: "consensus-backed-proxy",
        leaseToken: thirdLease,
        now: T0 + 1_104,
      })));
    const thirdOperations = await createFsPartyVetOperationHarness(
      operationDirectory,
    );
    const thirdEffects = await createFsEffects(effectDirectory);
    const replay = await partyVetCore(
      requestWith(
        restartedInput.identityBundle,
        restartedInput.requirement,
        thirdPins,
      ),
      makeDeps(
        thirdOperations.store,
        thirdEffects,
        thirdSession,
        thirdLease,
        T0 + 1_104,
      ),
    );
    expect(canonicalize(replay)).toBe(canonicalize(left));
    expect(await thirdEffects.inspect()).toEqual(completedEffects);
    expect(await thirdOperations.inspect()).toEqual({
      checkpoints: 3,
      terminalSteps: 8,
    });
  }, 30_000);
});

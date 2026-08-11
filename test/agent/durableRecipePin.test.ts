import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { signComponentArtifact } from "../../src/artifacts/signatures.js";
import type {
  AnchorReceipt,
  ComponentSignature,
} from "../../src/artifacts/types.js";
import { contentHash } from "../../src/canonical/index.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
} from "../../src/crypto/index.js";
import {
  isDurableSessionRecipePin,
  pinSessionRecipeSelection,
  recoverSessionRecipePin,
} from "../../src/agent/durableRecipePin.js";
import {
  createInMemoryFencedSessionStore,
  type FencedSessionStoreV2,
} from "../../src/agent/fencedSessionStore.js";
import { createFsFencedSessionStore } from "../../src/agent/fencedSessionStoreFs.js";
import type { CompositeClaimRequirement } from "../../src/agent/compositeVerification.js";
import {
  RECIPE_REGISTRY_INDEX_ADDRESS,
  authenticateRecipeRegistrySnapshot,
  isHistoricalRecipeResolution,
  isLatestRecipeSelection,
  resolveHistoricalRecipeFromSnapshot,
  selectLatestRecipeAtSessionStart,
  type CurrentRecipeRegistryIndex,
  type HistoricalRecipeResolution,
  type LatestRecipeSelection,
  type RecipeRegistryIndexDocument,
  type RecipeRegistryRecipeRef,
  type RecipeRegistrySelectionProvider,
} from "../../src/registry/recipeSelection.js";
import type { RecipeDescriptor } from "../../src/registry/types.js";

const STEWARD_SEED = new Uint8Array(32).fill(73);
const STEWARD_KEY = Uint8Array.from(
  rawPublicKey(publicKeyFromSeed(STEWARD_SEED)),
);
const STEWARD = `key:${Buffer.from(STEWARD_KEY).toString("hex")}`;
const PARTY = `key:${"a1".repeat(32)}`;
const NOW = 1_786_400_000_000;

type SignedRecipe = RecipeDescriptor & { signature: ComponentSignature };

function recipe(
  recipeVersion: number,
  patch: Partial<RecipeDescriptor> = {},
): RecipeDescriptor {
  return {
    recipeVersion,
    scheme: "key",
    defaultMethod: { kind: "self-signed" },
    defaultMaxAgeSec: 3_600,
    parserRules: { format: "raw", matcher: "present" },
    retryClass: "permanent",
    availability: "live",
    governance: {
      proposedBy: STEWARD,
      acceptedAt: NOW + recipeVersion,
      anchoring: "single-signer",
      ...(recipeVersion > 1 ? { supersedes: recipeVersion - 1 } : {}),
    },
    ...patch,
  };
}

async function signedRecipe(value: RecipeDescriptor): Promise<SignedRecipe> {
  return signComponentArtifact(value, "dacs-recipe:v1:", {
    algorithm: "ed25519",
    signer: STEWARD,
    sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(STEWARD_SEED)),
  });
}

function refFor(
  locator: string,
  value: Record<string, unknown>,
): RecipeRegistryRecipeRef {
  return {
    anchor: { kind: "storage-program", locator },
    contentHash: contentHash(value),
  };
}

function receiptFor(ref: RecipeRegistryRecipeRef): AnchorReceipt {
  return {
    receiptVersion: "1",
    substrate: "test",
    finalityProfile: "instant",
    logicalAddress: RECIPE_REGISTRY_INDEX_ADDRESS,
    nativeAddress: ref.anchor.locator,
    contentHash: ref.contentHash,
    transactionRef: { kind: "test", value: `tx:${ref.contentHash}` },
    writer: STEWARD,
    state: "finalized",
    observationDisposition: "established",
    observedAt: NOW + 100,
    blockRef: { id: "block:1", height: "1", timestamp: NOW + 100 },
    evidence: { kind: "test", value: `proof:${ref.contentHash}` },
  };
}

async function registry(
  recipes: RecipeDescriptor[],
  registryVersion: number,
): Promise<{
  snapshot: Awaited<ReturnType<typeof authenticateRecipeRegistrySnapshot>>;
  latest: (method?: "self-signed" | "tlsnotary") => LatestRecipeSelection;
  historical: (
    version: number,
    method?: "self-signed" | "tlsnotary",
  ) => HistoricalRecipeResolution;
}> {
  const signed = await Promise.all(recipes.map(signedRecipe));
  const documents = new Map<string, Record<string, unknown>>();
  const refs = signed.map((entry) => {
    const locator = `recipe:${entry.recipeVersion}:${contentHash(
      entry as unknown as Record<string, unknown>,
    )}`;
    documents.set(locator, entry as unknown as Record<string, unknown>);
    return refFor(locator, entry as unknown as Record<string, unknown>);
  });
  const index: RecipeRegistryIndexDocument = {
    registryId: RECIPE_REGISTRY_INDEX_ADDRESS,
    entries: refs,
  };
  const indexRef = refFor(
    `index:${registryVersion}:${contentHash(index as unknown as Record<string, unknown>)}`,
    index as unknown as Record<string, unknown>,
  );
  documents.set(indexRef.anchor.locator, index as unknown as Record<string, unknown>);
  const current: CurrentRecipeRegistryIndex = {
    registryVersion,
    indexRef,
    receipt: receiptFor(indexRef),
  };
  const provider: RecipeRegistrySelectionProvider = {
    resolveCurrentIndex: async () => structuredClone(current),
    authenticateCurrentIndex: () => "valid",
    readAnchoredJson: async (ref) => documents.get(ref.anchor.locator) ?? null,
    stewardWriter: STEWARD,
    stewardSigner: STEWARD,
    stewardPublicKey: STEWARD_KEY,
    verify: (bytes, signature, publicKey) =>
      ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
  };
  const snapshot = await authenticateRecipeRegistrySnapshot(provider);
  return {
    snapshot,
    latest: (method = "self-signed") =>
      selectLatestRecipeAtSessionStart(snapshot, {
        scheme: "key",
        method,
        required: true,
      }),
    historical: (version, method = "self-signed") =>
      resolveHistoricalRecipeFromSnapshot(snapshot, {
        scheme: "key",
        method,
        recipeVersion: version,
      }),
  };
}

async function sessionLease(
  store: FencedSessionStoreV2,
  jobId: string,
  owner: string,
  now: number,
  ttlMs = 100,
) {
  const result = await store.acquireLease({ jobId, owner, ttlMs, now });
  if (!result.ok) throw new Error(`lease failed: ${result.reason}`);
  return result.lease;
}

function requirement(
  patch: Partial<CompositeClaimRequirement> = {},
): CompositeClaimRequirement {
  return {
    scheme: "key",
    verificationRequired: true,
    parameters: { verificationMethod: "self-signed" },
    ...patch,
  };
}

function pinInput(
  store: FencedSessionStoreV2,
  jobId: string,
  selection: LatestRecipeSelection | HistoricalRecipeResolution,
  leaseToken: Awaited<ReturnType<typeof sessionLease>>,
  claimRequirement = requirement(),
  now = 1,
) {
  return {
    store,
    jobId,
    evaluatedParty: PARTY,
    requirementPath: { kind: "required" as const, index: 0 },
    requirement: claimRequirement,
    selection,
    leaseToken,
    now,
  };
}

function recoveryInput(
  store: FencedSessionStoreV2,
  jobId: string,
  leaseToken: Awaited<ReturnType<typeof sessionLease>>,
  claimRequirement = requirement(),
  now = 1,
) {
  return {
    store,
    jobId,
    evaluatedParty: PARTY,
    requirementPath: { kind: "required" as const, index: 0 },
    requirement: claimRequirement,
    leaseToken,
    now,
  };
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()!;
    await rm(directory, { recursive: true, force: true });
  }
});

describe("generation-fenced durable recipe pins", () => {
  test("persists complete canonical provenance before returning an immutable runtime pin", async () => {
    const store = createInMemoryFencedSessionStore();
    const jobId = "pin-memory-complete";
    await store.create({ jobId, now: 0 });
    const lease = await sessionLease(store, jobId, "worker-a", 0);
    const current = await registry([recipe(1), recipe(2)], 7);

    const pin = await pinSessionRecipeSelection(
      pinInput(store, jobId, current.latest(), lease),
    );

    expect(isDurableSessionRecipePin(pin)).toBe(true);
    expect(pin).toMatchObject({
      pinVersion: "1",
      jobId,
      evaluatedParty: PARTY,
      selectionKind: "latest-at-session-start",
      registryVersion: 7,
      family: { scheme: "key", defaultMethod: "self-signed" },
      method: "self-signed",
      recipeVersion: 2,
      pinnedBy: { owner: "worker-a", generation: 1 },
    });
    expect(pin.indexRef).toEqual(pin.provenance.registry.indexRef);
    expect(pin.recipeRef).toEqual(pin.provenance.recipeRef);
    expect(pin.recipeContentHash).toBe(
      contentHash(pin.provenance.recipe as unknown as Record<string, unknown>),
    );
    expect(Object.isFrozen(pin)).toBe(true);
    expect(Object.isFrozen(pin.provenance.registry.index)).toBe(true);
    expect(isDurableSessionRecipePin(structuredClone(pin))).toBe(false);

    const loaded = await store.load(jobId);
    expect(loaded.status).toBe("ok");
    if (loaded.status !== "ok") throw new Error("session missing");
    expect(loaded.record.checkpoints).toHaveLength(1);
    expect(loaded.record.checkpoints[0]).toMatchObject({
      key: pin.checkpointKey,
      stage: "intent",
      data: { pinHash: pin.pinHash },
    });
  });

  test("restart keeps the original unpinned family version but rejects requirement or family conflicts", async () => {
    const store = createInMemoryFencedSessionStore();
    const jobId = "pin-memory-restart";
    await store.create({ jobId, now: 0 });
    const firstLease = await sessionLease(store, jobId, "worker-a", 0, 10);
    const v1 = await registry([recipe(1)], 1);
    const first = await pinSessionRecipeSelection(
      pinInput(store, jobId, v1.latest(), firstLease, requirement(), 1),
    );
    const firstLoad = await store.load(jobId);
    if (firstLoad.status !== "ok") throw new Error("session missing");
    const released = await store.transition({
      jobId,
      expectedRevision: firstLoad.record.revision,
      leaseToken: firstLease,
      lease: null,
      now: 2,
    });
    if (!released.ok) throw new Error(`release failed: ${released.reason}`);
    const secondLease = await sessionLease(store, jobId, "worker-b", 3);
    const v2 = await registry([recipe(1), recipe(2)], 2);
    const recovered = await pinSessionRecipeSelection(
      pinInput(store, jobId, v2.latest(), secondLease, requirement(), 4),
    );
    expect(recovered.pinHash).toBe(first.pinHash);
    expect(recovered.recipeVersion).toBe(1);
    expect(recovered.registryVersion).toBe(1);
    expect(recovered.pinnedBy.generation).toBe(1);

    await expect(pinSessionRecipeSelection(
      pinInput(
        store,
        jobId,
        v2.latest(),
        secondLease,
        requirement({ maxAge: 30 }),
        5,
      ),
    )).rejects.toThrow(/conflicts with the stored requirement/);

    const changedFamily = await registry([
      recipe(3, {
        defaultMethod: { kind: "tlsnotary", endpoint: "https://notary.example" },
        alternatives: [{ kind: "self-signed" }],
        governance: {
          proposedBy: STEWARD,
          acceptedAt: NOW + 3,
          anchoring: "single-signer",
        },
      }),
    ], 3);
    await expect(pinSessionRecipeSelection(
      pinInput(store, jobId, changedFamily.latest(), secondLease, requirement(), 6),
    )).rejects.toThrow(/conflicts with the stored requirement or recipe family/);

    const omittedHistory = await registry([
      recipe(2, {
        governance: {
          proposedBy: STEWARD,
          acceptedAt: NOW + 2,
          anchoring: "single-signer",
        },
      }),
    ], 4);
    await expect(pinSessionRecipeSelection(
      pinInput(store, jobId, omittedHistory.latest(), secondLease, requirement(), 7),
    )).rejects.toThrow(/advanced registry omits.*stored recipe reference/);
  });

  test("requires runtime latest provenance for unpinned requirements and exact method/version pins", async () => {
    const store = createInMemoryFencedSessionStore();
    const jobId = "pin-provenance";
    await store.create({ jobId, now: 0 });
    const lease = await sessionLease(store, jobId, "worker", 0);
    const current = await registry([recipe(1), recipe(2)], 2);

    await expect(pinSessionRecipeSelection(
      pinInput(store, jobId, current.historical(1), lease),
    )).rejects.toThrow(/unpinned ClaimRequirement requires latest-at-session/);

    const historical = await pinSessionRecipeSelection(
      pinInput(
        store,
        jobId,
        current.historical(1),
        lease,
        requirement({ recipeVersion: 1 }),
      ),
    );
    expect(historical.selectionKind).toBe("explicit-historical");
    expect(historical.recipeVersion).toBe(1);

    const fabricated = structuredClone(current.latest()) as LatestRecipeSelection;
    await expect(pinSessionRecipeSelection({
      ...pinInput(store, "different-job", fabricated, lease),
      jobId,
      requirementPath: { kind: "required", index: 1 },
    })).rejects.toThrow(/runtime-authenticated recipe selection provenance/);

    await expect(pinSessionRecipeSelection({
      ...pinInput(store, jobId, current.latest(), lease),
      requirementPath: { kind: "required", index: 2 },
      requirement: requirement({
        parameters: { verificationMethod: "tlsnotary" },
      }),
    })).rejects.toThrow(/violates verificationMethod provenance/);
  });

  test("an exact version pin recovers when its once-latest recipe becomes historical", async () => {
    const store = createInMemoryFencedSessionStore();
    const jobId = "pin-latest-to-historical";
    await store.create({ jobId, now: 0 });
    const firstLease = await sessionLease(store, jobId, "worker-a", 0);
    const initial = await registry([recipe(1)], 1);
    const pinnedRequirement = requirement({ recipeVersion: 1 });
    const first = await pinSessionRecipeSelection(
      pinInput(
        store,
        jobId,
        initial.latest(),
        firstLease,
        pinnedRequirement,
        1,
      ),
    );
    const loaded = await store.load(jobId);
    if (loaded.status !== "ok") throw new Error("session missing");
    const released = await store.transition({
      jobId,
      expectedRevision: loaded.record.revision,
      leaseToken: firstLease,
      lease: null,
      now: 2,
    });
    if (!released.ok) throw new Error(`release failed: ${released.reason}`);
    const secondLease = await sessionLease(store, jobId, "worker-b", 3);
    const advanced = await registry([recipe(1), recipe(2)], 2);
    const recovered = await pinSessionRecipeSelection(
      pinInput(
        store,
        jobId,
        advanced.historical(1),
        secondLease,
        pinnedRequirement,
        4,
      ),
    );
    expect(recovered.pinHash).toBe(first.pinHash);
    expect(recovered.selectionKind).toBe("latest-at-session-start");
    expect(recovered.recipeVersion).toBe(1);
  });

  test("concurrent callers converge on the one checkpoint winner", async () => {
    const store = createInMemoryFencedSessionStore();
    const jobId = "pin-concurrent";
    await store.create({ jobId, now: 0 });
    const lease = await sessionLease(store, jobId, "worker", 0);
    const older = await registry([recipe(1)], 1);
    const newer = await registry([recipe(1), recipe(2)], 2);

    const [left, right] = await Promise.all([
      pinSessionRecipeSelection(
        pinInput(store, jobId, older.latest(), lease, requirement(), 1),
      ),
      pinSessionRecipeSelection(
        pinInput(store, jobId, newer.latest(), lease, requirement(), 1),
      ),
    ]);
    expect(left.pinHash).toBe(right.pinHash);
    expect(left.recipeVersion).toBe(right.recipeVersion);
    const loaded = await store.load(jobId);
    if (loaded.status !== "ok") throw new Error("session missing");
    expect(loaded.record.checkpoints).toHaveLength(1);
  });

  test("expired and superseded lease generations cannot establish or recover a pin", async () => {
    const store = createInMemoryFencedSessionStore();
    const jobId = "pin-stale-lease";
    await store.create({ jobId, now: 0 });
    const first = await sessionLease(store, jobId, "worker-a", 0, 5);
    const current = await registry([recipe(1)], 1);

    await expect(pinSessionRecipeSelection(
      pinInput(store, jobId, current.latest(), first, requirement(), 5),
    )).rejects.toThrow(/lease-expired/);
    const second = await sessionLease(store, jobId, "worker-b", 6, 100);
    await expect(pinSessionRecipeSelection(
      pinInput(store, jobId, current.latest(), first, requirement(), 7),
    )).rejects.toThrow(/lease-fenced/);
    const pin = await pinSessionRecipeSelection(
      pinInput(store, jobId, current.latest(), second, requirement(), 7),
    );
    expect(pin.pinnedBy.generation).toBe(2);
    await expect(recoverSessionRecipePin({
      ...recoveryInput(store, jobId, first, requirement(), 8),
      snapshot: current.snapshot,
    })).rejects.toThrow(/lease-fenced/);
    await expect(recoverSessionRecipePin({
      ...recoveryInput(store, jobId, second, requirement(), 106),
      snapshot: current.snapshot,
    })).rejects.toThrow(/lease-expired/);
  });

  test("filesystem cold restart recovers the old pin across registry and lease generations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dacs-recipe-pin-"));
    temporaryDirectories.push(directory);
    const jobId = "pin-fs-restart";
    const firstStore = await createFsFencedSessionStore({ dir: directory });
    await firstStore.create({ jobId, now: 0 });
    const firstLease = await sessionLease(firstStore, jobId, "worker-a", 0, 10);
    const v1 = await registry([recipe(1)], 1);
    const first = await pinSessionRecipeSelection(
      pinInput(firstStore, jobId, v1.latest(), firstLease, requirement(), 1),
    );

    const restarted = await createFsFencedSessionStore({ dir: directory });
    const v2 = await registry([recipe(1), recipe(2)], 2);
    const sameGeneration = await recoverSessionRecipePin({
      ...recoveryInput(restarted, jobId, firstLease, requirement(), 2),
      snapshot: v2.snapshot,
    });
    expect(sameGeneration.pinHash).toBe(first.pinHash);
    const nextLease = await sessionLease(restarted, jobId, "worker-b", 11, 100);
    const nextGeneration = await recoverSessionRecipePin({
      ...recoveryInput(restarted, jobId, nextLease, requirement(), 12),
      snapshot: v2.snapshot,
    });
    expect(nextGeneration.pinHash).toBe(first.pinHash);
    expect(nextGeneration.recipeVersion).toBe(1);
    expect(Object.isFrozen(nextGeneration.provenance.recipe)).toBe(true);
    expect(isDurableSessionRecipePin(structuredClone(nextGeneration))).toBe(false);
    expect(isLatestRecipeSelection(
      nextGeneration.provenance as LatestRecipeSelection,
    )).toBe(false);
    expect(isHistoricalRecipeResolution(
      nextGeneration.provenance as HistoricalRecipeResolution,
    )).toBe(false);
  });

  test("cold recovery keeps the stored method when a newer family head removes it", async () => {
    const store = createInMemoryFencedSessionStore();
    const jobId = "pin-removed-method";
    await store.create({ jobId, now: 0 });
    const firstLease = await sessionLease(store, jobId, "worker-a", 0, 10);
    const tlsRequirement = requirement({
      parameters: { verificationMethod: "tlsnotary" },
    });
    const initial = await registry([
      recipe(1, {
        alternatives: [
          { kind: "tlsnotary", endpoint: "https://notary.example" },
        ],
      }),
    ], 1);
    const first = await pinSessionRecipeSelection(
      pinInput(
        store,
        jobId,
        initial.latest("tlsnotary"),
        firstLease,
        tlsRequirement,
        1,
      ),
    );
    const loaded = await store.load(jobId);
    if (loaded.status !== "ok") throw new Error("session missing");
    const released = await store.transition({
      jobId,
      expectedRevision: loaded.record.revision,
      leaseToken: firstLease,
      lease: null,
      now: 2,
    });
    if (!released.ok) throw new Error(`release failed: ${released.reason}`);
    const secondLease = await sessionLease(store, jobId, "worker-b", 3, 100);
    const advanced = await registry([
      recipe(1, {
        alternatives: [
          { kind: "tlsnotary", endpoint: "https://notary.example" },
        ],
      }),
      recipe(2),
    ], 2);

    expect(() => advanced.latest("tlsnotary")).toThrow(/removed.*historical fallback/);
    const recovered = await recoverSessionRecipePin({
      ...recoveryInput(store, jobId, secondLease, tlsRequirement, 4),
      snapshot: advanced.snapshot,
    });
    expect(recovered.pinHash).toBe(first.pinHash);
    expect(recovered.method).toBe("tlsnotary");
    expect(recovered.recipeVersion).toBe(1);
    expect(recovered.registryVersion).toBe(1);
  });

  test("rejects malformed store callbacks, promises, records, and changed checkpoint bytes", async () => {
    const current = await registry([recipe(1)], 1);

    const callbackStore = createInMemoryFencedSessionStore();
    await callbackStore.create({ jobId: "pin-bad-callback", now: 0 });
    const callbackLease = await sessionLease(
      callbackStore,
      "pin-bad-callback",
      "worker",
      0,
    );
    const proxiedCallbackStore = {
      ...callbackStore,
      claimCheckpoint: new Proxy(callbackStore.claimCheckpoint, {}),
    };
    await expect(pinSessionRecipeSelection(
      pinInput(
        proxiedCallbackStore,
        "pin-bad-callback",
        current.latest(),
        callbackLease,
      ),
    )).rejects.toThrow(/requires FencedSessionStoreV2/);

    const malformedStore = {
      ...createInMemoryFencedSessionStore(),
      claimCheckpoint: async () => ({ ok: true, record: {} }) as never,
    };
    await expect(pinSessionRecipeSelection(
      pinInput(
        malformedStore,
        "pin-malformed",
        current.latest(),
        { owner: "worker", generation: 1, expiresAt: 100 },
      ),
    )).rejects.toThrow(/corrupt record/);

    const changedStore = createInMemoryFencedSessionStore();
    const changedJob = "pin-changed";
    await changedStore.create({ jobId: changedJob, now: 0 });
    const changedLease = await sessionLease(changedStore, changedJob, "worker", 0);
    const corruptingStore = {
      ...changedStore,
      claimCheckpoint: async (input: Parameters<FencedSessionStoreV2["claimCheckpoint"]>[0]) => {
        const result = await changedStore.claimCheckpoint(input);
        if (result.record) {
          const checkpoint = result.record.checkpoints.at(-1);
          if (checkpoint?.data) checkpoint.data.pinHash = "0".repeat(64);
        }
        return result;
      },
    };
    await expect(pinSessionRecipeSelection(
      pinInput(corruptingStore, changedJob, current.latest(), changedLease),
    )).rejects.toThrow(/checkpoint is missing or corrupt/);

    const malformedLoadStore = {
      ...changedStore,
      load: async () => ({ status: "ok", record: {} }) as never,
    };
    await expect(recoverSessionRecipePin(
      recoveryInput(malformedLoadStore, changedJob, changedLease),
    )).rejects.toThrow(/loaded a corrupt record/);
  });
});

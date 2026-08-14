import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { signComponentArtifact } from "../../src/artifacts/signatures.js";
import type { AnchorReceipt, ComponentSignature } from "../../src/artifacts/types.js";
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
  SESSION_RECIPE_REGISTRY_SNAPSHOT_CHECKPOINT_KEY,
  isDurableSessionRecipePin,
  isDurableSessionRecipeRegistrySnapshot,
  pinSessionRecipeRegistrySnapshot,
  pinSessionRecipeSelection,
  recoverSessionRecipePin,
  recoverSessionRecipeRegistrySnapshot,
} from "../../src/agent/durableRecipePin.js";
import {
  createInMemoryFencedSessionStore,
  type FencedSessionStoreV2,
} from "../../src/agent/fencedSessionStore.js";
import { createFsFencedSessionStore } from "../../src/agent/fencedSessionStoreFs.js";
import type {
  CompositeBundleRequirement,
  CompositeClaimRequirement,
} from "../../src/agent/compositeVerification.js";
import {
  RECIPE_REGISTRY_INDEX_ADDRESS,
  authenticateRecipeRegistrySnapshot,
  selectLatestRecipeAtSessionStart,
  type CurrentRecipeRegistryIndex,
  type RecipeRegistryIndexDocument,
  type RecipeRegistryRecipeRef,
  type RecipeRegistrySelectionProvider,
} from "../../src/registry/recipeSelection.js";
import type { RecipeDescriptor } from "../../src/registry/types.js";

const STEWARD_SEED = new Uint8Array(32).fill(73);
const STEWARD_KEY = Uint8Array.from(rawPublicKey(publicKeyFromSeed(STEWARD_SEED)));
const STEWARD = `key:${Buffer.from(STEWARD_KEY).toString("hex")}`;
const PARTY = `key:${"a1".repeat(32)}`;
const SECOND_PARTY = `key:${"b2".repeat(32)}`;
const NOW = 1_786_400_000_000;
const SESSION_START_HASH = "1".repeat(64);
const PARTY_PLAN_HASH = "2".repeat(64);

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

async function registry(recipes: RecipeDescriptor[], registryVersion: number) {
  const signed = await Promise.all(recipes.map(signedRecipe));
  const documents = new Map<string, Record<string, unknown>>();
  const refs = signed.map((entry) => {
    const hash = contentHash(entry as unknown as Record<string, unknown>);
    const locator = `recipe:${entry.scheme}:${entry.recipeVersion}:${hash}`;
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
  return {
    provider,
    snapshot: await authenticateRecipeRegistrySnapshot(provider),
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

function claimRequirement(
  scheme = "key",
  patch: Partial<CompositeClaimRequirement> = {},
): CompositeClaimRequirement {
  return {
    scheme,
    verificationRequired: true,
    parameters: { verificationMethod: "self-signed" },
    ...patch,
  };
}

function bundleRequirement(
  required: CompositeClaimRequirement[] = [claimRequirement()],
  oneOf?: CompositeClaimRequirement[][],
): CompositeBundleRequirement {
  return {
    requirementVersion: "1",
    required,
    ...(oneOf === undefined ? {} : { oneOf }),
  };
}

async function pinRegistry(
  store: FencedSessionStoreV2,
  jobId: string,
  provider: RecipeRegistrySelectionProvider,
  leaseToken: Awaited<ReturnType<typeof sessionLease>>,
  now = 1,
) {
  return pinSessionRecipeRegistrySnapshot({
    store,
    jobId,
    sessionStartHash: SESSION_START_HASH,
    provider,
    leaseToken,
    now,
  });
}

function pinInput(
  store: FencedSessionStoreV2,
  jobId: string,
  sessionSnapshot: Awaited<ReturnType<typeof pinRegistry>>,
  leaseToken: Awaited<ReturnType<typeof sessionLease>>,
  fullRequirement = bundleRequirement(),
  patch: Partial<Parameters<typeof pinSessionRecipeSelection>[0]> = {},
) {
  return {
    store,
    sessionSnapshot,
    jobId,
    evaluatedParty: PARTY,
    requirementPath: { kind: "required" as const, index: 0 },
    bundleRequirement: fullRequirement,
    partyPlanHash: PARTY_PLAN_HASH,
    requestedMethod: "self-signed" as const,
    leaseToken,
    now: 2,
    ...patch,
  };
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("job-scoped generation-fenced recipe registry pins", () => {
  test("persists one complete authenticated snapshot and derives immutable requirement pins", async () => {
    const store = createInMemoryFencedSessionStore();
    const jobId = "recipe-snapshot-complete";
    await store.create({ jobId, now: 0 });
    const lease = await sessionLease(store, jobId, "worker-a", 0);
    const current = await registry([recipe(1), recipe(2)], 7);

    const sessionSnapshot = await pinRegistry(store, jobId, current.provider, lease);
    const pin = await pinSessionRecipeSelection(
      pinInput(store, jobId, sessionSnapshot, lease),
    );

    expect(isDurableSessionRecipeRegistrySnapshot(sessionSnapshot)).toBe(true);
    expect(sessionSnapshot).toMatchObject({
      snapshotVersion: "1",
      jobId,
      registry: { registryVersion: 7 },
      checkpointKey: SESSION_RECIPE_REGISTRY_SNAPSHOT_CHECKPOINT_KEY,
      pinnedBy: { owner: "worker-a", generation: 1 },
    });
    expect(sessionSnapshot.entries).toHaveLength(2);
    expect(isDurableSessionRecipeRegistrySnapshot(structuredClone(sessionSnapshot))).toBe(false);
    expect(isDurableSessionRecipePin(pin)).toBe(true);
    expect(pin).toMatchObject({
      jobId,
      registryVersion: 7,
      recipeVersion: 2,
      selectionKind: "latest-at-session-start",
      sessionSnapshotHash: sessionSnapshot.snapshotHash,
      evaluatedPartyIdentity: { scheme: "key", identifier: "a1".repeat(32) },
    });
    expect(Object.isFrozen(pin.provenance.recipe)).toBe(true);

    const loaded = await store.load(jobId);
    if (loaded.status !== "ok") throw new Error("session missing");
    expect(loaded.record.checkpoints[0]?.key).toBe(
      SESSION_RECIPE_REGISTRY_SNAPSHOT_CHECKPOINT_KEY,
    );
    expect(loaded.record.checkpoints).toHaveLength(2);
  });

  test("does not accept a cached latest-selection or authenticated snapshot as a session pin", async () => {
    const old = await registry([recipe(1)], 1);
    const cached = selectLatestRecipeAtSessionStart(old.snapshot, {
      scheme: "key",
      method: "self-signed",
      required: true,
    });
    const advanced = await registry([recipe(1), recipe(2)], 2);
    const store = createInMemoryFencedSessionStore();
    const jobId = "recipe-no-selection-bypass";
    await store.create({ jobId, now: 0 });
    const lease = await sessionLease(store, jobId, "worker", 0);
    const sessionSnapshot = await pinRegistry(store, jobId, advanced.provider, lease);
    expect(sessionSnapshot.registry.registryVersion).toBe(2);

    await expect(pinSessionRecipeSelection({
      ...pinInput(store, jobId, sessionSnapshot, lease),
      selection: cached,
    } as never)).rejects.toThrow(/input must be an exact data record/);
    await expect(pinSessionRecipeSelection({
      ...pinInput(store, jobId, sessionSnapshot, lease),
      sessionSnapshot: old.snapshot,
    } as never)).rejects.toThrow(/scope is malformed/);
  });

  test("concurrent v1/v2 starters converge on one job snapshot shared by all paths and parties", async () => {
    const keyV1 = recipe(1);
    const domainV1 = recipe(1, {
      scheme: "domain",
      governance: {
        proposedBy: STEWARD,
        acceptedAt: NOW + 1,
        anchoring: "single-signer",
      },
    });
    const keyV2 = recipe(2);
    const v1 = await registry([keyV1, domainV1], 1);
    const v2 = await registry([keyV1, domainV1, keyV2], 2);
    const store = createInMemoryFencedSessionStore();
    const jobId = "recipe-concurrent-global";
    await store.create({ jobId, now: 0 });
    const lease = await sessionLease(store, jobId, "worker", 0);

    const [left, right] = await Promise.all([
      pinRegistry(store, jobId, v1.provider, lease),
      pinRegistry(store, jobId, v2.provider, lease),
    ]);
    expect(left.snapshotHash).toBe(right.snapshotHash);
    expect(left.registry.registryVersion).toBe(right.registry.registryVersion);

    const full = bundleRequirement([claimRequirement(), claimRequirement("domain")]);
    const [first, duplicate] = await Promise.all([
      pinSessionRecipeSelection(pinInput(store, jobId, left, lease, full)),
      pinSessionRecipeSelection(pinInput(store, jobId, right, lease, full)),
    ]);
    expect(duplicate.pinHash).toBe(first.pinHash);
    const second = await pinSessionRecipeSelection(
      pinInput(store, jobId, right, lease, full, {
        requirementPath: { kind: "required", index: 1 },
      }),
    );
    const otherParty = await pinSessionRecipeSelection(
      pinInput(store, jobId, right, lease, full, { evaluatedParty: SECOND_PARTY }),
    );
    expect(new Set([
      first.sessionSnapshotHash,
      second.sessionSnapshotHash,
      otherParty.sessionSnapshotHash,
    ])).toEqual(new Set([left.snapshotHash]));
    expect(first.registryVersion).toBe(left.registry.registryVersion);
    expect(second.registryVersion).toBe(left.registry.registryVersion);
  });

  test("cold restart after only the global checkpoint keeps v1 after v2 removes its method", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dacs-recipe-snapshot-"));
    temporaryDirectories.push(directory);
    const jobId = "recipe-snapshot-crash-before-path";
    const firstStore = await createFsFencedSessionStore({ dir: directory });
    await firstStore.create({ jobId, now: 0 });
    const firstLease = await sessionLease(firstStore, jobId, "worker-a", 0, 10);
    const tlsRequirement = bundleRequirement([
      claimRequirement("key", {
        parameters: { verificationMethod: "tlsnotary" },
      }),
    ]);
    const v1 = await registry([
      recipe(1, { alternatives: [{ kind: "tlsnotary", endpoint: "https://v1" }] }),
    ], 1);
    const original = await pinRegistry(firstStore, jobId, v1.provider, firstLease, 1);

    const restarted = await createFsFencedSessionStore({ dir: directory });
    const nextLease = await sessionLease(restarted, jobId, "worker-b", 11, 100);
    const v2 = await registry([
      recipe(1, { alternatives: [{ kind: "tlsnotary", endpoint: "https://v1" }] }),
      recipe(2),
    ], 2);
    const recovered = await recoverSessionRecipeRegistrySnapshot({
      store: restarted,
      jobId,
      sessionStartHash: SESSION_START_HASH,
      leaseToken: nextLease,
      currentSnapshot: v2.snapshot,
      now: 12,
    });
    expect(recovered.snapshotHash).toBe(original.snapshotHash);
    const pin = await pinSessionRecipeSelection(
      pinInput(restarted, jobId, recovered, nextLease, tlsRequirement, {
        requestedMethod: "tlsnotary",
        now: 13,
      }),
    );
    expect(pin.recipeVersion).toBe(1);
    expect(pin.method).toBe("tlsnotary");
    expect(pin.registryVersion).toBe(1);
  });

  test("derives explicit historical pins from the same job snapshot", async () => {
    const store = createInMemoryFencedSessionStore();
    const jobId = "recipe-explicit-historical";
    await store.create({ jobId, now: 0 });
    const lease = await sessionLease(store, jobId, "worker", 0);
    const current = await registry([recipe(1), recipe(2)], 2);
    const sessionSnapshot = await pinRegistry(store, jobId, current.provider, lease);
    const exact = bundleRequirement([claimRequirement("key", { recipeVersion: 1 })]);
    const pin = await pinSessionRecipeSelection(
      pinInput(store, jobId, sessionSnapshot, lease, exact),
    );
    expect(pin.selectionKind).toBe("explicit-historical");
    expect(pin.recipeVersion).toBe(1);
  });

  test("uses strict CF-2 bytes and CF-3 identity for fencing while binding the full plan", async () => {
    const store = createInMemoryFencedSessionStore();
    const jobId = "recipe-canonical-party";
    await store.create({ jobId, now: 0 });
    const lease = await sessionLease(store, jobId, "worker", 0);
    const current = await registry([recipe(1)], 1);
    const sessionSnapshot = await pinRegistry(store, jobId, current.provider, lease);
    const full = bundleRequirement();
    const first = await pinSessionRecipeSelection(
      pinInput(store, jobId, sessionSnapshot, lease, full),
    );
    const sameIdentity = await pinSessionRecipeSelection(
      pinInput(store, jobId, sessionSnapshot, lease, full, {
        evaluatedParty: `${PARTY}?a=1`,
      }),
    );
    expect(sameIdentity.pinHash).toBe(first.pinHash);

    for (const evaluatedParty of [
      "key:",
      `${PARTY}?b=2&a=1`,
      `${PARTY}?a=%2f`,
    ]) {
      await expect(pinSessionRecipeSelection(
        pinInput(store, jobId, sessionSnapshot, lease, full, { evaluatedParty }),
      )).rejects.toThrow(/scope is malformed/);
    }
    await expect(pinSessionRecipeSelection(
      pinInput(store, jobId, sessionSnapshot, lease, full, {
        partyPlanHash: "3".repeat(64),
      }),
    )).rejects.toThrow(/conflicts with the stored requirement/);
    await expect(pinSessionRecipeSelection(
      pinInput(store, jobId, sessionSnapshot, lease, full, {
        requirementPath: { kind: "required", index: 1 },
      }),
    )).rejects.toThrow(/does not locate a verifiable requirement/);
    await expect(pinSessionRecipeSelection(
      pinInput(store, jobId, sessionSnapshot, lease, bundleRequirement([
        claimRequirement("key", { maxAge: 30 }),
      ])),
    )).rejects.toThrow(/conflicts with the stored requirement/);
  });

  test("requires an exact prefix for every prior index entry, not only the selected recipe", async () => {
    const keyV1 = recipe(1);
    const domainV1 = recipe(1, {
      scheme: "domain",
      governance: {
        proposedBy: STEWARD,
        acceptedAt: NOW + 1,
        anchoring: "single-signer",
      },
    });
    const keyV2 = recipe(2);
    const old = await registry([keyV1, domainV1], 1);
    const valid = await registry([keyV1, domainV1, keyV2], 2);
    const omittedUnrelated = await registry([keyV1, keyV2], 2);
    const reordered = await registry([domainV1, keyV1, keyV2], 2);
    const sameVersionConflict = await registry([keyV1], 1);
    const store = createInMemoryFencedSessionStore();
    const jobId = "recipe-append-only-full-index";
    await store.create({ jobId, now: 0 });
    const lease = await sessionLease(store, jobId, "worker", 0);
    const durable = await pinRegistry(store, jobId, old.provider, lease);

    await expect(recoverSessionRecipeRegistrySnapshot({
      store,
      jobId,
      sessionStartHash: SESSION_START_HASH,
      leaseToken: lease,
      currentSnapshot: valid.snapshot,
      now: 2,
    })).resolves.toMatchObject({ snapshotHash: durable.snapshotHash });
    for (const currentSnapshot of [
      omittedUnrelated.snapshot,
      reordered.snapshot,
      sameVersionConflict.snapshot,
    ]) {
      await expect(recoverSessionRecipeRegistrySnapshot({
        store,
        jobId,
        sessionStartHash: SESSION_START_HASH,
        leaseToken: lease,
        currentSnapshot,
        now: 3,
      })).rejects.toThrow(/append-only|conflicting index bytes/);
    }
  });

  test("stale generations cannot establish or recover snapshots or path pins", async () => {
    const store = createInMemoryFencedSessionStore();
    const jobId = "recipe-generation-fence";
    await store.create({ jobId, now: 0 });
    const first = await sessionLease(store, jobId, "worker-a", 0, 5);
    const current = await registry([recipe(1)], 1);
    await expect(pinRegistry(store, jobId, current.provider, first, 5)).rejects.toThrow(
      /lease-expired/,
    );
    const second = await sessionLease(store, jobId, "worker-b", 6, 10);
    const sessionSnapshot = await pinRegistry(store, jobId, current.provider, second, 7);
    const pin = await pinSessionRecipeSelection(
      pinInput(store, jobId, sessionSnapshot, second, bundleRequirement(), { now: 8 }),
    );
    expect(isDurableSessionRecipePin(pin)).toBe(true);
    const third = await sessionLease(store, jobId, "worker-c", 17, 100);
    expect(isDurableSessionRecipePin(pin)).toBe(true);
    await expect(recoverSessionRecipePin({
      ...pinInput(store, jobId, sessionSnapshot, second, bundleRequirement(), { now: 18 }),
    })).rejects.toThrow(/lease-fenced/);
    const recoveredSnapshot = await recoverSessionRecipeRegistrySnapshot({
      store,
      jobId,
      sessionStartHash: SESSION_START_HASH,
      leaseToken: third,
      now: 18,
    });
    await expect(recoverSessionRecipePin({
      ...pinInput(store, jobId, recoveredSnapshot, third, bundleRequirement(), { now: 19 }),
    })).resolves.toMatchObject({ pinHash: pin.pinHash, pinnedBy: { generation: 2 } });
  });

  test("rejects proxied store callbacks and store-corrupted snapshot bytes", async () => {
    const current = await registry([recipe(1)], 1);
    const callbackStore = createInMemoryFencedSessionStore();
    const callbackJob = "recipe-proxied-store-callback";
    await callbackStore.create({ jobId: callbackJob, now: 0 });
    const callbackLease = await sessionLease(callbackStore, callbackJob, "worker", 0);
    const proxiedCallbackStore = {
      ...callbackStore,
      claimCheckpoint: new Proxy(callbackStore.claimCheckpoint, {}),
    };
    await expect(pinRegistry(
      proxiedCallbackStore,
      callbackJob,
      current.provider,
      callbackLease,
    )).rejects.toThrow(/requires FencedSessionStoreV2/);

    const changedStore = createInMemoryFencedSessionStore();
    const changedJob = "recipe-corrupt-snapshot-result";
    await changedStore.create({ jobId: changedJob, now: 0 });
    const changedLease = await sessionLease(changedStore, changedJob, "worker", 0);
    const corruptingStore = {
      ...changedStore,
      claimCheckpoint: async (
        input: Parameters<FencedSessionStoreV2["claimCheckpoint"]>[0],
      ) => {
        const result = await changedStore.claimCheckpoint(input);
        if (result.record) {
          const checkpoint = result.record.checkpoints.find(
            (candidate) =>
              candidate.key === SESSION_RECIPE_REGISTRY_SNAPSHOT_CHECKPOINT_KEY,
          );
          if (checkpoint?.data) checkpoint.data.snapshotHash = "0".repeat(64);
        }
        return result;
      },
    };
    await expect(pinRegistry(
      corruptingStore,
      changedJob,
      current.provider,
      changedLease,
    )).rejects.toThrow(/snapshot is missing or corrupt/);
  });
});

import type {
  AnchorReceipt,
  ComponentSignature,
  VerificationMethodKind,
} from "../../src/artifacts/types.js";
import { contentHash } from "../../src/canonical/index.js";
import {
  pinSessionRecipeSelection,
  type DurableRecipeRequirementPath,
  type DurableSessionRecipePin,
} from "../../src/agent/durableRecipePin.js";
import {
  createInMemoryFencedSessionStore,
} from "../../src/agent/fencedSessionStore.js";
import type {
  CompositeClaimRequirement,
} from "../../src/agent/compositeVerification.js";
import {
  RECIPE_REGISTRY_INDEX_ADDRESS,
  authenticateRecipeRegistrySnapshot,
  resolveHistoricalRecipeFromSnapshot,
  selectLatestRecipeAtSessionStart,
  type CurrentRecipeRegistryIndex,
  type RecipeRegistryIndexDocument,
  type RecipeRegistryRecipeRef,
  type RecipeRegistrySelectionProvider,
} from "../../src/registry/recipeSelection.js";
import type { RecipeDescriptor } from "../../src/registry/types.js";

type SignedRecipe = RecipeDescriptor & { signature: ComponentSignature };

export interface PartyVetPinSpec {
  requirementPath: DurableRecipeRequirementPath;
  requirement: CompositeClaimRequirement;
}

export interface PartyVetPinFixtureInput {
  jobId: string;
  evaluatedParty: string;
  recipes: readonly SignedRecipe[];
  attempts: readonly PartyVetPinSpec[];
  stewardSigner: string;
  stewardPublicKey: Uint8Array;
  verify: (
    bytes: Uint8Array,
    signature: Uint8Array,
    publicKey: Uint8Array,
  ) => Promise<boolean> | boolean;
  now: number;
}

function recipeRef(
  locator: string,
  artifact: Record<string, unknown>,
): RecipeRegistryRecipeRef {
  return {
    anchor: { kind: "storage-program", locator },
    contentHash: contentHash(artifact),
  };
}

/** Build genuine #143 runtime pins for party-Vet unit tests. */
export async function createPartyVetPins(
  input: PartyVetPinFixtureInput,
): Promise<DurableSessionRecipePin[]> {
  const documents = new Map<string, Record<string, unknown>>();
  const refs = input.recipes.map((recipe) => {
    const artifact = recipe as unknown as Record<string, unknown>;
    const ref = recipeRef(
      `party-vet-recipe:${recipe.scheme}:${recipe.recipeVersion}:${contentHash(artifact)}`,
      artifact,
    );
    documents.set(ref.anchor.locator, artifact);
    return ref;
  });
  const index: RecipeRegistryIndexDocument = {
    registryId: RECIPE_REGISTRY_INDEX_ADDRESS,
    entries: refs,
  };
  const indexArtifact = index as unknown as Record<string, unknown>;
  const indexRef = recipeRef(
    `party-vet-index:1:${contentHash(indexArtifact)}`,
    indexArtifact,
  );
  documents.set(indexRef.anchor.locator, indexArtifact);
  const receipt: AnchorReceipt = {
    receiptVersion: "1",
    substrate: "party-vet-pin-fixture",
    finalityProfile: "instant-test-finality",
    logicalAddress: RECIPE_REGISTRY_INDEX_ADDRESS,
    nativeAddress: indexRef.anchor.locator,
    contentHash: indexRef.contentHash,
    transactionRef: { kind: "memory-tx", value: `tx:${indexRef.contentHash}` },
    writer: input.stewardSigner,
    state: "finalized",
    observationDisposition: "established",
    observedAt: input.now,
    blockRef: { id: "party-vet-registry-block", height: "1", timestamp: input.now },
    evidence: { kind: "memory-proof", value: `proof:${indexRef.contentHash}` },
  };
  const current: CurrentRecipeRegistryIndex = {
    registryVersion: 1,
    indexRef,
    receipt,
  };
  const provider: RecipeRegistrySelectionProvider = {
    resolveCurrentIndex: async () => structuredClone(current),
    authenticateCurrentIndex: () => "valid",
    readAnchoredJson: async (ref) => {
      const artifact = documents.get(ref.anchor.locator);
      return artifact ? structuredClone(artifact) : null;
    },
    stewardWriter: input.stewardSigner,
    stewardSigner: input.stewardSigner,
    stewardPublicKey: Uint8Array.from(input.stewardPublicKey),
    verify: input.verify,
  };
  const snapshot = await authenticateRecipeRegistrySnapshot(provider);

  const store = createInMemoryFencedSessionStore();
  await store.create({ jobId: input.jobId, now: 0 });
  const lease = await store.acquireLease({
    jobId: input.jobId,
    owner: "party-vet-pin-fixture",
    ttlMs: 10_000,
    now: 0,
  });
  if (!lease.ok) throw new Error(`party Vet pin fixture lease failed: ${lease.reason}`);

  const pins: DurableSessionRecipePin[] = [];
  for (const attempt of input.attempts) {
    const method = (
      attempt.requirement.parameters?.verificationMethod ??
      input.recipes.find((recipe) => recipe.scheme === attempt.requirement.scheme)
        ?.defaultMethod.kind
    ) as VerificationMethodKind | undefined;
    if (method === undefined) {
      throw new Error(`party Vet pin fixture has no recipe for ${attempt.requirement.scheme}`);
    }
    const selection = attempt.requirement.recipeVersion === undefined
      ? selectLatestRecipeAtSessionStart(snapshot, {
          scheme: attempt.requirement.scheme,
          method,
          required: true,
        })
      : resolveHistoricalRecipeFromSnapshot(snapshot, {
          scheme: attempt.requirement.scheme,
          method,
          recipeVersion: attempt.requirement.recipeVersion,
        });
    pins.push(await pinSessionRecipeSelection({
      store,
      jobId: input.jobId,
      evaluatedParty: input.evaluatedParty,
      requirementPath: attempt.requirementPath,
      requirement: attempt.requirement,
      selection,
      leaseToken: lease.lease,
      now: 1,
    }));
  }
  return pins;
}

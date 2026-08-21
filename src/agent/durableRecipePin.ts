import { types as nodeTypes } from "node:util";

import type {
  AnchorReceipt,
  ComponentSignature,
  VerificationMethodKind,
} from "../artifacts/types.js";
import {
  isAnchorReceipt,
  isAttestationRef,
} from "../artifacts/validators.js";
import {
  canonicalize,
  contentHash,
  sha256Hex,
} from "../canonical/index.js";
import { DacsError } from "../errors.js";
import {
  isCanonicalClaimReference,
  parseCanonicalClaimReference,
  type CanonicalClaimIdentity,
} from "../identity/claimReference.js";
import {
  RECIPE_REGISTRY_INDEX_ADDRESS,
  authenticateRecipeRegistrySnapshot,
  isAuthenticatedRecipeRegistrySnapshot,
  resolveHistoricalRecipeRegistryEntry,
  selectLatestRecipeRegistryEntry,
  validateRecipeRegistryEntryGraph,
  type AuthenticatedRecipeRegistryEntry,
  type AuthenticatedRecipeRegistrySnapshot,
  type RecipeFamilyIdentity,
  type RecipeRegistryIndexDocument,
  type RecipeRegistryProvenance,
  type RecipeRegistryRecipeRef,
  type RecipeRegistrySelectionProvider,
} from "../registry/recipeSelection.js";
import { isRecipeDescriptor } from "../registry/resolve.js";
import type { RecipeDescriptor } from "../registry/types.js";
import {
  isCompositeBundleRequirement,
  type CompositeBundleRequirement,
  type CompositeClaimRequirement,
} from "./compositeVerification.js";
import {
  FENCED_SESSION_STORE_VERSION,
  sessionRecordShapeViolation,
  type CheckpointClaimResult,
  type FencedSessionStoreV2,
  type SessionLoad,
  type SessionLeaseToken,
  type SessionRecord,
} from "./fencedSessionStore.js";

/** Stable location of one ClaimRequirement inside the session's requirement. */
export type DurableRecipeRequirementPath =
  | { kind: "required"; index: number }
  | { kind: "oneOf"; groupIndex: number; alternativeIndex: number };

type SignedRecipe = RecipeDescriptor & { signature: ComponentSignature };

/** One immutable registry snapshot is shared by every party and requirement. */
export const SESSION_RECIPE_REGISTRY_SNAPSHOT_CHECKPOINT_KEY =
  "dacs2:recipe-registry-snapshot:v1" as const;

export type DurableRecipePartyIdentity = CanonicalClaimIdentity;

interface DurableRecipeRegistrySnapshotPayload {
  snapshotVersion: "1";
  jobId: string;
  sessionStartHash: string;
  registry: RecipeRegistryProvenance;
  entries: AuthenticatedRecipeRegistryEntry[];
  pinnedBy: SessionLeaseToken;
  pinnedAt: number;
}

export type DurableRecipeSelectionProvenance =
  | {
      selectionKind: "latest-at-session-start";
      family: RecipeFamilyIdentity;
      requestedMethod: VerificationMethodKind;
      required: boolean;
      registry: RecipeRegistryProvenance;
      recipeRef: RecipeRegistryRecipeRef;
      recipeContentHash: string;
      recipe: SignedRecipe;
    }
  | {
      selectionKind: "explicit-historical";
      family: RecipeFamilyIdentity;
      requestedMethod: VerificationMethodKind;
      registry: RecipeRegistryProvenance;
      recipeRef: RecipeRegistryRecipeRef;
      recipeContentHash: string;
      recipe: SignedRecipe;
    };

interface DurableRecipePinPayload {
  pinVersion: "1";
  jobId: string;
  evaluatedParty: string;
  evaluatedPartyIdentity: DurableRecipePartyIdentity;
  bundleRequirement: CompositeBundleRequirement;
  bundleRequirementHash: string;
  partyPlanHash: string;
  requirementPath: DurableRecipeRequirementPath;
  requirement: CompositeClaimRequirement;
  requirementHash: string;
  selectionKind: DurableRecipeSelectionProvenance["selectionKind"];
  registryVersion: number;
  family: RecipeFamilyIdentity;
  method: VerificationMethodKind;
  recipeVersion: number;
  indexRef: RecipeRegistryRecipeRef;
  indexContentHash: string;
  recipeRef: RecipeRegistryRecipeRef;
  recipeContentHash: string;
  provenance: DurableRecipeSelectionProvenance;
  provenanceHash: string;
  sessionSnapshotHash: string;
  pinnedBy: SessionLeaseToken;
  pinnedAt: number;
}

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

declare const durableSessionRecipePinBrand: unique symbol;
declare const durableSessionRecipeRegistrySnapshotBrand: unique symbol;

export type DurableSessionRecipeRegistrySnapshot =
  DeepReadonly<DurableRecipeRegistrySnapshotPayload> & {
    readonly checkpointKey: typeof SESSION_RECIPE_REGISTRY_SNAPSHOT_CHECKPOINT_KEY;
    readonly snapshotHash: string;
    readonly [durableSessionRecipeRegistrySnapshotBrand]: true;
  };

/**
 * Immutable recipe pin recovered from one generation-fenced session
 * checkpoint. It is deliberately distinct from a live registry selection: a
 * caller cannot cast parsed disk bytes into either runtime provenance class.
 * This brand proves immutable provenance only; effects still require a fresh
 * successful claim under the current live lease generation.
 */
export type DurableSessionRecipePin = DeepReadonly<DurableRecipePinPayload> & {
  readonly checkpointKey: string;
  readonly pinHash: string;
  readonly [durableSessionRecipePinBrand]: true;
};

export interface PinSessionRecipeInput {
  store: FencedSessionStoreV2;
  sessionSnapshot: DurableSessionRecipeRegistrySnapshot;
  jobId: string;
  evaluatedParty: string;
  requirementPath: DurableRecipeRequirementPath;
  /** Full requirement proves that `requirementPath` is real and in range. */
  bundleRequirement: CompositeBundleRequirement;
  /**
   * Hash of the deterministic, recipe-independent pre-pin party-plan scope
   * that owns this path. It MUST NOT include the pin produced by this call.
   */
  partyPlanHash: string;
  /** Exact method selected by listing/evidence provenance for this attempt. */
  requestedMethod: VerificationMethodKind;
  /** Exact live generation authorised to establish or recover this pin. */
  leaseToken: SessionLeaseToken;
  now?: number;
}

export interface RecoverSessionRecipePinInput {
  store: FencedSessionStoreV2;
  sessionSnapshot: DurableSessionRecipeRegistrySnapshot;
  jobId: string;
  evaluatedParty: string;
  requirementPath: DurableRecipeRequirementPath;
  bundleRequirement: CompositeBundleRequirement;
  partyPlanHash: string;
  requestedMethod: VerificationMethodKind;
  leaseToken: SessionLeaseToken;
  now?: number;
}

export interface PinSessionRecipeRegistrySnapshotInput {
  store: FencedSessionStoreV2;
  jobId: string;
  /** Hash of the durable session-start/listing plan this registry pin belongs to. */
  sessionStartHash: string;
  provider: RecipeRegistrySelectionProvider;
  leaseToken: SessionLeaseToken;
  now?: number;
}

export interface RecoverSessionRecipeRegistrySnapshotInput {
  store: FencedSessionStoreV2;
  jobId: string;
  sessionStartHash: string;
  leaseToken: SessionLeaseToken;
  /** Optional current authenticated view used only for append-only auditing. */
  currentSnapshot?: AuthenticatedRecipeRegistrySnapshot;
  now?: number;
}

const durablePins = new WeakSet<object>();
const durableRegistrySnapshots = new WeakSet<object>();
const INERT_STORE_RECEIVER = Object.freeze(Object.create(null)) as object;
const HASH = /^[0-9a-f]{64}$/;
const METHODS: ReadonlySet<string> = new Set([
  "verifiable-credential",
  "tlsnotary",
  "zktls",
  "consensus-backed-proxy",
  "oauth-attested",
  "evm-rpc",
  "domain-tls-control",
  "self-signed",
  "demos-gcr-domain",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isNonEmptyTrimmed = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;

function exactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value) || nodeTypes.isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const allowed = new Set([...required, ...optional]);
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== "string") ||
      !required.every((key) => keys.includes(key)) ||
      !keys.every((key) => typeof key === "string" && allowed.has(key))
    ) {
      return false;
    }
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable === true &&
        "value" in descriptor && descriptor.value !== undefined;
    });
  } catch {
    return false;
  }
}

function captureJsonValue(
  value: unknown,
  label: string,
  ancestors = new Set<object>(),
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      Math.abs(value) > Number.MAX_SAFE_INTEGER ||
      Object.is(value, -0)
    ) {
      throw new DacsError(`${label} contains a non-canonical number`);
    }
    return value;
  }
  if (typeof value !== "object" || nodeTypes.isProxy(value)) {
    throw new DacsError(`${label} must contain proxy-free canonical JSON data`);
  }
  if (ancestors.has(value)) throw new DacsError(`${label} must be acyclic`);
  ancestors.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw new DacsError(`${label} cannot contain symbol fields`);
    }
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) {
        throw new DacsError(`${label} arrays must use the intrinsic prototype`);
      }
      const keys = Object.keys(descriptors).filter((key) => key !== "length");
      if (
        keys.length !== value.length ||
        keys.some((key, index) => key !== String(index))
      ) {
        throw new DacsError(`${label} arrays must be dense`);
      }
      return keys.map((key) => {
        const descriptor = descriptors[key]!;
        if (descriptor.enumerable !== true || !("value" in descriptor)) {
          throw new DacsError(`${label} cannot contain accessors`);
        }
        return captureJsonValue(descriptor.value, label, ancestors);
      });
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DacsError(`${label} must contain only plain records`);
    }
    const copy = Object.create(prototype) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (
        descriptor.enumerable !== true ||
        !("value" in descriptor) ||
        descriptor.value === undefined
      ) {
        throw new DacsError(`${label} cannot contain accessors or hidden fields`);
      }
      Object.defineProperty(copy, key, {
        value: captureJsonValue(descriptor.value, label, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return copy;
  } catch (error) {
    if (error instanceof DacsError) throw error;
    throw new DacsError(`${label} could not be inspected safely`, { cause: error });
  } finally {
    ancestors.delete(value);
  }
}

function captureJson<T>(value: T, label: string): T {
  return captureJsonValue(value, label) as T;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value as object)) {
    return value;
  }
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  try {
    return canonicalize(left) === canonicalize(right);
  } catch {
    return false;
  }
}

function capturePath(value: unknown): DurableRecipeRequirementPath {
  const captured = captureJson(value, "durable recipe requirement path");
  if (
    exactKeys(captured, ["kind", "index"]) &&
    captured.kind === "required" &&
    isNonNegativeSafeInteger(captured.index)
  ) {
    return deepFreeze({ kind: "required", index: captured.index });
  }
  if (
    exactKeys(captured, ["kind", "groupIndex", "alternativeIndex"]) &&
    captured.kind === "oneOf" &&
    isNonNegativeSafeInteger(captured.groupIndex) &&
    isNonNegativeSafeInteger(captured.alternativeIndex)
  ) {
    return deepFreeze({
      kind: "oneOf",
      groupIndex: captured.groupIndex,
      alternativeIndex: captured.alternativeIndex,
    });
  }
  throw new DacsError("durable recipe requirement path is malformed");
}

function captureRequirement(value: unknown): CompositeClaimRequirement {
  const captured = captureJson(value, "durable recipe requirement");
  if (
    !isCompositeBundleRequirement({
      requirementVersion: "1",
      required: [captured],
    })
  ) {
    throw new DacsError("durable recipe requirement is not exact");
  }
  const requirement = captured as CompositeClaimRequirement;
  if (!requirement.verificationRequired) {
    throw new DacsError("durable recipe pins require a verifiable ClaimRequirement");
  }
  return deepFreeze(requirement);
}

function captureBundleRequirement(value: unknown): CompositeBundleRequirement {
  const captured = captureJson(value, "durable recipe BundleRequirement");
  if (!isRecord(captured) || !isCompositeBundleRequirement(captured)) {
    throw new DacsError("durable recipe BundleRequirement is not exact");
  }
  return deepFreeze(captured as unknown as CompositeBundleRequirement);
}

function requirementAt(
  requirement: Readonly<CompositeBundleRequirement>,
  path: Readonly<DurableRecipeRequirementPath>,
): CompositeClaimRequirement | null {
  return path.kind === "required"
    ? requirement.required[path.index] ?? null
    : requirement.oneOf?.[path.groupIndex]?.[path.alternativeIndex] ?? null;
}

function captureLeaseToken(value: unknown): SessionLeaseToken {
  if (!exactKeys(value, ["owner", "generation"], ["expiresAt", "sellerPhaseIndex"])) {
    throw new DacsError("durable recipe pin lease token is malformed");
  }
  if (!isNonEmptyTrimmed(value.owner) || !isPositiveSafeInteger(value.generation)) {
    throw new DacsError("durable recipe pin lease token is malformed");
  }
  if (
    (value.expiresAt !== undefined && !isNonNegativeSafeInteger(value.expiresAt)) ||
    (value.sellerPhaseIndex !== undefined &&
      !isNonNegativeSafeInteger(value.sellerPhaseIndex))
  ) {
    throw new DacsError("durable recipe pin lease metadata is malformed");
  }
  return deepFreeze({ owner: value.owner, generation: value.generation });
}

interface CapturedStore {
  load: FencedSessionStoreV2["load"];
  claimCheckpoint: FencedSessionStoreV2["claimCheckpoint"];
}

function captureStore(value: unknown): CapturedStore {
  if (!isRecord(value) || nodeTypes.isProxy(value)) {
    throw new DacsError("durable recipe pin store must be a non-proxy v2 store");
  }
  let apiDescriptor: PropertyDescriptor | undefined;
  let loadDescriptor: PropertyDescriptor | undefined;
  let claimDescriptor: PropertyDescriptor | undefined;
  try {
    apiDescriptor = Object.getOwnPropertyDescriptor(value, "apiVersion");
    loadDescriptor = Object.getOwnPropertyDescriptor(value, "load");
    claimDescriptor = Object.getOwnPropertyDescriptor(value, "claimCheckpoint");
  } catch (error) {
    throw new DacsError("durable recipe pin store could not be captured", {
      cause: error,
    });
  }
  if (
    !apiDescriptor || apiDescriptor.enumerable !== true || !("value" in apiDescriptor) ||
    apiDescriptor.value !== FENCED_SESSION_STORE_VERSION ||
    !loadDescriptor || loadDescriptor.enumerable !== true || !("value" in loadDescriptor) ||
    typeof loadDescriptor.value !== "function" ||
    nodeTypes.isProxy(loadDescriptor.value) ||
    !claimDescriptor || claimDescriptor.enumerable !== true || !("value" in claimDescriptor) ||
    typeof claimDescriptor.value !== "function" ||
    nodeTypes.isProxy(claimDescriptor.value)
  ) {
    throw new DacsError("durable recipe pin requires FencedSessionStoreV2");
  }
  const load = loadDescriptor.value as FencedSessionStoreV2["load"];
  const claim = claimDescriptor.value as FencedSessionStoreV2["claimCheckpoint"];
  return {
    load: (jobId) => {
      const pending = Reflect.apply(load, INERT_STORE_RECEIVER, [jobId]);
      if (
        pending !== null &&
        (typeof pending === "object" || typeof pending === "function") &&
        nodeTypes.isProxy(pending)
      ) {
        throw new DacsError("durable recipe pin store returned a proxy promise");
      }
      return pending;
    },
    claimCheckpoint: (input) => {
      const pending = Reflect.apply(claim, INERT_STORE_RECEIVER, [input]);
      if (
        pending !== null &&
        (typeof pending === "object" || typeof pending === "function") &&
        nodeTypes.isProxy(pending)
      ) {
        throw new DacsError("durable recipe pin store returned a proxy promise");
      }
      return pending;
    },
  };
}

const CLAIM_FAILURES = new Set([
  "not-found",
  "lease-held",
  "lease-fenced",
  "lease-expired",
  "phase-regression",
  "terminal-state",
  "corrupt",
  "unsupported",
  "held",
  "completed",
]);

function captureClaimResult(value: unknown): CheckpointClaimResult {
  const captured = captureJson(value, "durable recipe pin store result");
  if (!isRecord(captured)) {
    throw new DacsError("durable recipe pin store result is malformed");
  }
  if (captured.ok === true) {
    if (!exactKeys(captured, ["ok", "record"])) {
      throw new DacsError("durable recipe pin successful store result is malformed");
    }
  } else if (
    captured.ok !== false ||
    !exactKeys(captured, ["ok", "reason"], ["record"]) ||
    typeof captured.reason !== "string" ||
    !CLAIM_FAILURES.has(captured.reason)
  ) {
    throw new DacsError("durable recipe pin failed store result is malformed");
  }
  if (captured.record !== undefined) {
    const violation = sessionRecordShapeViolation(captured.record);
    if (violation) {
      throw new DacsError(`durable recipe pin store returned a corrupt record: ${violation}`);
    }
  }
  return captured as unknown as CheckpointClaimResult;
}

function captureLoadResult(value: unknown): SessionLoad {
  const captured = captureJson(value, "durable recipe pin load result");
  if (!isRecord(captured) || typeof captured.status !== "string") {
    throw new DacsError("durable recipe pin load result is malformed");
  }
  if (captured.status === "missing") {
    if (!exactKeys(captured, ["status"])) {
      throw new DacsError("durable recipe pin missing load result is malformed");
    }
  } else if (captured.status === "unsupported") {
    if (
      !exactKeys(captured, ["status", "version"]) ||
      !isNonNegativeSafeInteger(captured.version)
    ) {
      throw new DacsError("durable recipe pin unsupported load result is malformed");
    }
  } else if (captured.status === "corrupt") {
    if (
      !exactKeys(captured, ["status", "reason"]) ||
      !isNonEmptyTrimmed(captured.reason)
    ) {
      throw new DacsError("durable recipe pin corrupt load result is malformed");
    }
  } else if (captured.status === "ok") {
    if (!exactKeys(captured, ["status", "record"])) {
      throw new DacsError("durable recipe pin successful load result is malformed");
    }
    const violation = sessionRecordShapeViolation(captured.record);
    if (violation) {
      throw new DacsError(`durable recipe pin store loaded a corrupt record: ${violation}`);
    }
  } else {
    throw new DacsError("durable recipe pin load result has an unknown status");
  }
  return captured as unknown as SessionLoad;
}

function captureRecipeRef(value: unknown, label: string): RecipeRegistryRecipeRef {
  const captured = captureJson(value, label);
  if (
    !exactKeys(captured, ["anchor", "contentHash"]) ||
    !isAttestationRef(captured)
  ) {
    throw new DacsError(`${label} is malformed`);
  }
  return captured as unknown as RecipeRegistryRecipeRef;
}

function captureRegistryIndex(value: unknown): RecipeRegistryIndexDocument {
  const captured = captureJson(value, "durable recipe registry index");
  if (
    !exactKeys(captured, ["registryId", "entries"]) ||
    captured.registryId !== RECIPE_REGISTRY_INDEX_ADDRESS ||
    !Array.isArray(captured.entries) ||
    captured.entries.length === 0
  ) {
    throw new DacsError("durable recipe registry index is malformed");
  }
  for (const ref of captured.entries) {
    captureRecipeRef(ref, "durable recipe registry entry ref");
  }
  return captured as unknown as RecipeRegistryIndexDocument;
}

function captureRegistryProvenance(value: unknown): RecipeRegistryProvenance {
  const captured = captureJson(value, "durable recipe registry provenance");
  if (
    !exactKeys(captured, [
      "logicalAddress",
      "registryVersion",
      "index",
      "indexRef",
      "indexContentHash",
      "writer",
      "receipt",
    ]) ||
    captured.logicalAddress !== RECIPE_REGISTRY_INDEX_ADDRESS ||
    !isPositiveSafeInteger(captured.registryVersion) ||
    typeof captured.indexContentHash !== "string" ||
    !HASH.test(captured.indexContentHash) ||
    !isCanonicalClaimReference(captured.writer)
  ) {
    throw new DacsError("durable recipe registry provenance is malformed");
  }
  const index = captureRegistryIndex(captured.index);
  const indexRef = captureRecipeRef(
    captured.indexRef,
    "durable recipe registry index ref",
  );
  const receipt = captureJson(
    captured.receipt,
    "durable recipe registry receipt",
  ) as AnchorReceipt;
  if (
    !isAnchorReceipt(receipt) ||
    contentHash(index as unknown as Record<string, unknown>) !==
      captured.indexContentHash ||
    indexRef.contentHash !== captured.indexContentHash ||
    receipt.logicalAddress !== RECIPE_REGISTRY_INDEX_ADDRESS ||
    receipt.nativeAddress !== indexRef.anchor.locator ||
    receipt.contentHash !== indexRef.contentHash ||
    receipt.writer !== captured.writer ||
    receipt.state !== "finalized" ||
    receipt.observationDisposition !== "established"
  ) {
    throw new DacsError("durable recipe registry provenance bindings are invalid");
  }
  return captured as unknown as RecipeRegistryProvenance;
}

function captureRegistryEntries(
  value: unknown,
  index: Readonly<RecipeRegistryIndexDocument>,
): AuthenticatedRecipeRegistryEntry[] {
  const captured = captureJson(value, "durable recipe registry entries");
  if (!Array.isArray(captured) || captured.length !== index.entries.length) {
    throw new DacsError("durable recipe registry entries are incomplete");
  }
  const entries: AuthenticatedRecipeRegistryEntry[] = captured.map((entry, position) => {
    if (!exactKeys(entry, ["ref", "recipe"])) {
      throw new DacsError(`durable recipe registry entry ${position} is malformed`);
    }
    const ref = captureRecipeRef(entry.ref, `durable recipe registry entry ${position} ref`);
    const recipeValue = captureJson(
      entry.recipe,
      `durable recipe registry entry ${position} recipe`,
    );
    if (!isRecord(recipeValue) || !isRecipeDescriptor(recipeValue)) {
      throw new DacsError(`durable recipe registry entry ${position} recipe is malformed`);
    }
    const recipe = recipeValue as unknown as SignedRecipe;
    if (
      !canonicalEqual(ref, index.entries[position]) ||
      contentHash(recipe as unknown as Record<string, unknown>) !== ref.contentHash
    ) {
      throw new DacsError(`durable recipe registry entry ${position} bindings are invalid`);
    }
    return deepFreeze({ ref, recipe });
  });
  validateRecipeRegistryEntryGraph(entries);
  return deepFreeze(entries);
}

const SNAPSHOT_PAYLOAD_KEYS = [
  "snapshotVersion",
  "jobId",
  "sessionStartHash",
  "registry",
  "entries",
  "pinnedBy",
  "pinnedAt",
] as const;

function captureRegistrySnapshotPayload(
  value: unknown,
): DurableRecipeRegistrySnapshotPayload {
  const captured = captureJson(value, "durable session recipe registry snapshot");
  if (
    !exactKeys(captured, SNAPSHOT_PAYLOAD_KEYS) ||
    captured.snapshotVersion !== "1" ||
    !isNonEmptyTrimmed(captured.jobId) ||
    typeof captured.sessionStartHash !== "string" ||
    !HASH.test(captured.sessionStartHash) ||
    !isNonNegativeSafeInteger(captured.pinnedAt)
  ) {
    throw new DacsError("durable session recipe registry snapshot is malformed");
  }
  const registry = captureRegistryProvenance(captured.registry);
  const entries = captureRegistryEntries(captured.entries, registry.index);
  const pinnedBy = captureLeaseToken(captured.pinnedBy);
  return deepFreeze({
    ...(captured as unknown as DurableRecipeRegistrySnapshotPayload),
    registry,
    entries,
    pinnedBy,
  });
}

function registryProvenanceFromSnapshot(
  snapshot: Readonly<AuthenticatedRecipeRegistrySnapshot>,
): RecipeRegistryProvenance {
  return captureRegistryProvenance({
    logicalAddress: snapshot.logicalAddress,
    registryVersion: snapshot.registryVersion,
    index: snapshot.index,
    indexRef: snapshot.indexRef,
    indexContentHash: snapshot.indexContentHash,
    writer: snapshot.writer,
    receipt: snapshot.receipt,
  });
}

function assertExactAppendOnlyPrefix(
  older: { readonly entries: readonly Readonly<RecipeRegistryRecipeRef>[] },
  newer: { readonly entries: readonly Readonly<RecipeRegistryRecipeRef>[] },
): void {
  if (
    newer.entries.length < older.entries.length ||
    older.entries.some((entry, index) => !canonicalEqual(entry, newer.entries[index]))
  ) {
    throw new DacsError(
      "authenticated registry snapshot is not an exact append-only extension",
    );
  }
}

function captureFamily(value: unknown): RecipeFamilyIdentity {
  const captured = captureJson(value, "durable recipe family");
  if (
    !exactKeys(captured, ["scheme", "defaultMethod"]) ||
    typeof captured.scheme !== "string" ||
    !/^[a-z][a-z0-9-]*$/.test(captured.scheme) ||
    typeof captured.defaultMethod !== "string" ||
    !METHODS.has(captured.defaultMethod)
  ) {
    throw new DacsError("durable recipe family is malformed");
  }
  return captured as unknown as RecipeFamilyIdentity;
}

function captureProvenance(value: unknown): DurableRecipeSelectionProvenance {
  const captured = captureJson(value, "durable recipe selection provenance");
  if (!isRecord(captured)) {
    throw new DacsError("durable recipe selection provenance is malformed");
  }
  const latest = captured.selectionKind === "latest-at-session-start";
  if (
    !exactKeys(
      captured,
      latest
        ? [
            "selectionKind",
            "family",
            "requestedMethod",
            "required",
            "registry",
            "recipeRef",
            "recipeContentHash",
            "recipe",
          ]
        : [
            "selectionKind",
            "family",
            "requestedMethod",
            "registry",
            "recipeRef",
            "recipeContentHash",
            "recipe",
          ],
    ) ||
    (!latest && captured.selectionKind !== "explicit-historical") ||
    (latest && captured.required !== true) ||
    typeof captured.requestedMethod !== "string" ||
    !METHODS.has(captured.requestedMethod) ||
    typeof captured.recipeContentHash !== "string" ||
    !HASH.test(captured.recipeContentHash)
  ) {
    throw new DacsError("durable recipe selection provenance is malformed");
  }
  const family = captureFamily(captured.family);
  const registry = captureRegistryProvenance(captured.registry);
  const recipeRef = captureRecipeRef(
    captured.recipeRef,
    "durable selected recipe ref",
  );
  const recipeValue = captureJson(captured.recipe, "durable selected recipe");
  if (!isRecord(recipeValue) || !isRecipeDescriptor(recipeValue)) {
    throw new DacsError("durable selected recipe is malformed");
  }
  const recipe = recipeValue as unknown as SignedRecipe;
  const methods = [recipe.defaultMethod, ...(recipe.alternatives ?? [])];
  if (
    family.scheme !== recipe.scheme ||
    family.defaultMethod !== recipe.defaultMethod.kind ||
    methods.filter((method) => method.kind === captured.requestedMethod).length !== 1 ||
    recipe.availability === "disabled" ||
    recipe.governance.deprecated === true ||
    contentHash(recipe as unknown as Record<string, unknown>) !==
      captured.recipeContentHash ||
    recipeRef.contentHash !== captured.recipeContentHash ||
    !(registry.index.entries as RecipeRegistryRecipeRef[]).some((ref) =>
      canonicalEqual(ref, recipeRef))
  ) {
    throw new DacsError("durable recipe selection provenance bindings are invalid");
  }
  return captured as unknown as DurableRecipeSelectionProvenance;
}

const PIN_KEYS = [
  "pinVersion",
  "jobId",
  "evaluatedParty",
  "evaluatedPartyIdentity",
  "bundleRequirement",
  "bundleRequirementHash",
  "partyPlanHash",
  "requirementPath",
  "requirement",
  "requirementHash",
  "selectionKind",
  "registryVersion",
  "family",
  "method",
  "recipeVersion",
  "indexRef",
  "indexContentHash",
  "recipeRef",
  "recipeContentHash",
  "provenance",
  "provenanceHash",
  "sessionSnapshotHash",
  "pinnedBy",
  "pinnedAt",
] as const;

function capturePinPayload(value: unknown): DurableRecipePinPayload {
  const captured = captureJson(value, "durable recipe pin payload");
  if (
    !exactKeys(captured, PIN_KEYS) ||
    captured.pinVersion !== "1" ||
    !isNonEmptyTrimmed(captured.jobId) ||
    parseCanonicalClaimReference(captured.evaluatedParty) === null ||
    typeof captured.bundleRequirementHash !== "string" ||
    !HASH.test(captured.bundleRequirementHash) ||
    typeof captured.partyPlanHash !== "string" ||
    !HASH.test(captured.partyPlanHash) ||
    typeof captured.requirementHash !== "string" ||
    !HASH.test(captured.requirementHash) ||
    (captured.selectionKind !== "latest-at-session-start" &&
      captured.selectionKind !== "explicit-historical") ||
    !isPositiveSafeInteger(captured.registryVersion) ||
    typeof captured.method !== "string" ||
    !METHODS.has(captured.method) ||
    !isPositiveSafeInteger(captured.recipeVersion) ||
    typeof captured.indexContentHash !== "string" ||
    !HASH.test(captured.indexContentHash) ||
    typeof captured.recipeContentHash !== "string" ||
    !HASH.test(captured.recipeContentHash) ||
    typeof captured.provenanceHash !== "string" ||
    !HASH.test(captured.provenanceHash) ||
    typeof captured.sessionSnapshotHash !== "string" ||
    !HASH.test(captured.sessionSnapshotHash) ||
    !isNonNegativeSafeInteger(captured.pinnedAt)
  ) {
    throw new DacsError("durable recipe pin payload is malformed");
  }
  const evaluatedParty = parseCanonicalClaimReference(captured.evaluatedParty)!;
  const evaluatedPartyIdentity = captureJson(
    captured.evaluatedPartyIdentity,
    "durable recipe evaluated-party identity",
  );
  if (
    !exactKeys(evaluatedPartyIdentity, ["scheme", "identifier"]) ||
    evaluatedPartyIdentity.scheme !== evaluatedParty.identity.scheme ||
    evaluatedPartyIdentity.identifier !== evaluatedParty.identity.identifier
  ) {
    throw new DacsError("durable recipe evaluated-party identity is malformed");
  }
  const bundleRequirement = captureBundleRequirement(captured.bundleRequirement);
  const requirementPath = capturePath(captured.requirementPath);
  const requirement = captureRequirement(captured.requirement);
  const locatedRequirement = requirementAt(bundleRequirement, requirementPath);
  const family = captureFamily(captured.family);
  const indexRef = captureRecipeRef(captured.indexRef, "durable pin index ref");
  const recipeRef = captureRecipeRef(captured.recipeRef, "durable pin recipe ref");
  const provenance = captureProvenance(captured.provenance);
  const pinnedBy = captureLeaseToken(captured.pinnedBy);
  const expectedRequirementHash = sha256Hex(canonicalize(requirement));
  const expectedBundleRequirementHash = sha256Hex(canonicalize(bundleRequirement));
  const expectedProvenanceHash = sha256Hex(canonicalize(provenance));
  if (
    captured.requirementHash !== expectedRequirementHash ||
    captured.bundleRequirementHash !== expectedBundleRequirementHash ||
    locatedRequirement === null ||
    !canonicalEqual(locatedRequirement, requirement) ||
    captured.provenanceHash !== expectedProvenanceHash ||
    captured.selectionKind !== provenance.selectionKind ||
    captured.registryVersion !== provenance.registry.registryVersion ||
    !canonicalEqual(family, provenance.family) ||
    captured.method !== provenance.requestedMethod ||
    captured.recipeVersion !== provenance.recipe.recipeVersion ||
    !canonicalEqual(indexRef, provenance.registry.indexRef) ||
    captured.indexContentHash !== provenance.registry.indexContentHash ||
    !canonicalEqual(recipeRef, provenance.recipeRef) ||
    captured.recipeContentHash !== provenance.recipeContentHash
  ) {
    throw new DacsError("durable recipe pin duplicates conflicting provenance");
  }
  const verificationMethod = requirement.parameters?.verificationMethod;
  if (
    requirement.scheme !== family.scheme ||
    (verificationMethod !== undefined && verificationMethod !== captured.method) ||
    (requirement.recipeVersion === undefined &&
      captured.selectionKind !== "latest-at-session-start") ||
    (requirement.recipeVersion !== undefined &&
      requirement.recipeVersion !== captured.recipeVersion)
  ) {
    throw new DacsError("durable recipe pin does not satisfy its ClaimRequirement");
  }
  return deepFreeze({
    ...(captured as unknown as DurableRecipePinPayload),
    evaluatedPartyIdentity: evaluatedParty.identity,
    bundleRequirement,
    requirementPath,
    requirement,
    family,
    indexRef,
    recipeRef,
    provenance,
    pinnedBy,
  });
}

function targetCheckpointKey(
  jobId: string,
  evaluatedPartyIdentity: DurableRecipePartyIdentity,
  requirementPath: DurableRecipeRequirementPath,
): string {
  const targetHash = sha256Hex(canonicalize({
    targetVersion: "2",
    jobId,
    evaluatedPartyIdentity,
    requirementPath,
  }));
  return `dacs2:recipe-pin:${targetHash}`;
}

function selectionProvenanceFromDurableSnapshot(
  snapshot: Readonly<DurableSessionRecipeRegistrySnapshot>,
  requirement: Readonly<CompositeClaimRequirement>,
  requestedMethod: VerificationMethodKind,
): DurableRecipeSelectionProvenance {
  const entries = snapshot.entries as ReadonlyArray<Readonly<AuthenticatedRecipeRegistryEntry>>;
  const selected = requirement.recipeVersion === undefined
    ? selectLatestRecipeRegistryEntry(entries, {
        scheme: requirement.scheme,
        method: requestedMethod,
        required: true,
      })
    : resolveHistoricalRecipeRegistryEntry(entries, {
        scheme: requirement.scheme,
        method: requestedMethod,
        recipeVersion: requirement.recipeVersion,
      });
  if (
    selected.recipe.availability === "disabled" ||
    selected.recipe.governance.deprecated === true
  ) {
    throw new DacsError(
      "disabled or deprecated recipe cannot begin required-claim verification",
    );
  }
  const shared = {
    family: {
      scheme: selected.recipe.scheme,
      defaultMethod: selected.recipe.defaultMethod.kind,
    },
    requestedMethod,
    registry: snapshot.registry,
    recipeRef: selected.ref,
    recipeContentHash: selected.ref.contentHash,
    recipe: selected.recipe,
  };
  return captureProvenance(
    requirement.recipeVersion === undefined
      ? {
          selectionKind: "latest-at-session-start",
          required: true,
          ...shared,
        }
      : {
          selectionKind: "explicit-historical",
          ...shared,
        },
  );
}

function buildPayload(
  input: {
    sessionSnapshot: DurableSessionRecipeRegistrySnapshot;
    jobId: string;
    evaluatedParty: string;
    evaluatedPartyIdentity: DurableRecipePartyIdentity;
    bundleRequirement: CompositeBundleRequirement;
    partyPlanHash: string;
    requirementPath: DurableRecipeRequirementPath;
    requirement: CompositeClaimRequirement;
    requestedMethod: VerificationMethodKind;
    leaseToken: SessionLeaseToken;
    now: number;
  },
): DurableRecipePinPayload {
  const provenance = selectionProvenanceFromDurableSnapshot(
    input.sessionSnapshot,
    input.requirement,
    input.requestedMethod,
  );
  const bundleRequirementHash = sha256Hex(canonicalize(input.bundleRequirement));
  return capturePinPayload({
    pinVersion: "1",
    jobId: input.jobId,
    evaluatedParty: input.evaluatedParty,
    evaluatedPartyIdentity: input.evaluatedPartyIdentity,
    bundleRequirement: input.bundleRequirement,
    bundleRequirementHash,
    partyPlanHash: input.partyPlanHash,
    requirementPath: input.requirementPath,
    requirement: input.requirement,
    requirementHash: sha256Hex(canonicalize(input.requirement)),
    selectionKind: provenance.selectionKind,
    registryVersion: provenance.registry.registryVersion,
    family: provenance.family,
    method: provenance.requestedMethod,
    recipeVersion: provenance.recipe.recipeVersion,
    indexRef: provenance.registry.indexRef,
    indexContentHash: provenance.registry.indexContentHash,
    recipeRef: provenance.recipeRef,
    recipeContentHash: provenance.recipeContentHash,
    provenance,
    provenanceHash: sha256Hex(canonicalize(provenance)),
    sessionSnapshotHash: input.sessionSnapshot.snapshotHash,
    pinnedBy: input.leaseToken,
    pinnedAt: input.now,
  });
}

function pinCheckpointData(
  record: Readonly<SessionRecord>,
  checkpointKey: string,
): { pin: string; pinHash: string } {
  const checkpoint = record.checkpoints.find(
    (candidate) => candidate.key === checkpointKey && candidate.stage === "intent",
  );
  if (
    !checkpoint ||
    !checkpoint.data ||
    !exactKeys(checkpoint.data, ["pin", "pinHash"]) ||
    typeof checkpoint.data.pin !== "string" ||
    typeof checkpoint.data.pinHash !== "string" ||
    !HASH.test(checkpoint.data.pinHash) ||
    sha256Hex(checkpoint.data.pin) !== checkpoint.data.pinHash
  ) {
    throw new DacsError("durable recipe pin checkpoint is missing or corrupt");
  }
  return { pin: checkpoint.data.pin, pinHash: checkpoint.data.pinHash };
}

function registrySnapshotCheckpointData(
  record: Readonly<SessionRecord>,
): { snapshot: string; snapshotHash: string } {
  const checkpoint = record.checkpoints.find(
    (candidate) =>
      candidate.key === SESSION_RECIPE_REGISTRY_SNAPSHOT_CHECKPOINT_KEY &&
      candidate.stage === "intent",
  );
  if (
    !checkpoint ||
    !checkpoint.data ||
    !exactKeys(checkpoint.data, ["snapshot", "snapshotHash"]) ||
    typeof checkpoint.data.snapshot !== "string" ||
    typeof checkpoint.data.snapshotHash !== "string" ||
    !HASH.test(checkpoint.data.snapshotHash) ||
    sha256Hex(checkpoint.data.snapshot) !== checkpoint.data.snapshotHash
  ) {
    throw new DacsError("durable session recipe registry snapshot is missing or corrupt");
  }
  return {
    snapshot: checkpoint.data.snapshot,
    snapshotHash: checkpoint.data.snapshotHash,
  };
}

function registrySnapshotFromRecord(
  record: Readonly<SessionRecord>,
): DurableSessionRecipeRegistrySnapshot {
  const checkpointData = registrySnapshotCheckpointData(record);
  let decoded: unknown;
  try {
    decoded = JSON.parse(checkpointData.snapshot);
  } catch (error) {
    throw new DacsError("durable session recipe registry snapshot is not JSON", {
      cause: error,
    });
  }
  if (canonicalize(decoded) !== checkpointData.snapshot) {
    throw new DacsError("durable session recipe registry snapshot is not canonical JSON");
  }
  const payload = captureRegistrySnapshotPayload(decoded);
  const snapshot = deepFreeze({
    ...payload,
    checkpointKey: SESSION_RECIPE_REGISTRY_SNAPSHOT_CHECKPOINT_KEY,
    snapshotHash: checkpointData.snapshotHash,
  }) as unknown as DurableSessionRecipeRegistrySnapshot;
  durableRegistrySnapshots.add(snapshot);
  return snapshot;
}

function assertStoredRegistrySnapshotScope(
  snapshot: Readonly<DurableSessionRecipeRegistrySnapshot>,
  input: { jobId: string; sessionStartHash: string },
): void {
  if (
    snapshot.jobId !== input.jobId ||
    snapshot.sessionStartHash !== input.sessionStartHash
  ) {
    throw new DacsError(
      "durable session recipe registry snapshot conflicts with session start",
    );
  }
}

function assertAuthenticatedSnapshotExtendsDurable(
  stored: Readonly<DurableSessionRecipeRegistrySnapshot>,
  current: AuthenticatedRecipeRegistrySnapshot,
): void {
  if (!isAuthenticatedRecipeRegistrySnapshot(current)) {
    throw new DacsError("current recipe registry snapshot is not runtime-authenticated");
  }
  if (current.registryVersion < stored.registry.registryVersion) {
    throw new DacsError("durable recipe registry recovery refuses a version rollback");
  }
  if (
    current.registryVersion === stored.registry.registryVersion &&
    current.indexContentHash !== stored.registry.indexContentHash
  ) {
    throw new DacsError("one recipe registry version has conflicting index bytes");
  }
  assertExactAppendOnlyPrefix(stored.registry.index, current.index);
}

function assertConcurrentSnapshotCompatibility(
  stored: Readonly<DurableSessionRecipeRegistrySnapshot>,
  candidate: Readonly<DurableRecipeRegistrySnapshotPayload>,
): void {
  if (candidate.registry.registryVersion === stored.registry.registryVersion) {
    if (candidate.registry.indexContentHash !== stored.registry.indexContentHash) {
      throw new DacsError("concurrent recipe registry snapshots equivocate at one version");
    }
    return;
  }
  if (candidate.registry.registryVersion > stored.registry.registryVersion) {
    assertExactAppendOnlyPrefix(stored.registry.index, candidate.registry.index);
  } else {
    assertExactAppendOnlyPrefix(candidate.registry.index, stored.registry.index);
  }
}

function pinFromRecord(
  record: Readonly<SessionRecord>,
  checkpointKey: string,
): DurableSessionRecipePin {
  const checkpointData = pinCheckpointData(record, checkpointKey);
  let decoded: unknown;
  try {
    decoded = JSON.parse(checkpointData.pin);
  } catch (error) {
    throw new DacsError("durable recipe pin checkpoint is not JSON", { cause: error });
  }
  if (canonicalize(decoded) !== checkpointData.pin) {
    throw new DacsError("durable recipe pin checkpoint is not canonical JSON");
  }
  const payload = capturePinPayload(decoded);
  const pin = deepFreeze({
    ...payload,
    checkpointKey,
    pinHash: checkpointData.pinHash,
  }) as unknown as DurableSessionRecipePin;
  durablePins.add(pin);
  return pin;
}

function assertStoredRequest(
  stored: Readonly<DurableSessionRecipePin>,
  input: {
    jobId: string;
    evaluatedPartyIdentity: DurableRecipePartyIdentity;
    bundleRequirement: CompositeBundleRequirement;
    partyPlanHash: string;
    requirementPath: DurableRecipeRequirementPath;
    requestedMethod: VerificationMethodKind;
    sessionSnapshotHash: string;
  },
): void {
  if (
    stored.jobId !== input.jobId ||
    !canonicalEqual(stored.evaluatedPartyIdentity, input.evaluatedPartyIdentity) ||
    !canonicalEqual(stored.bundleRequirement, input.bundleRequirement) ||
    stored.partyPlanHash !== input.partyPlanHash ||
    !canonicalEqual(stored.requirementPath, input.requirementPath) ||
    stored.method !== input.requestedMethod ||
    stored.sessionSnapshotHash !== input.sessionSnapshotHash
  ) {
    throw new DacsError("durable recipe recovery conflicts with the stored requirement path");
  }
}

function assertRequestCompatibility(
  stored: Readonly<DurableSessionRecipePin>,
  candidate: Readonly<DurableRecipePinPayload>,
): void {
  if (
    stored.jobId !== candidate.jobId ||
    !canonicalEqual(stored.evaluatedPartyIdentity, candidate.evaluatedPartyIdentity) ||
    !canonicalEqual(stored.bundleRequirement, candidate.bundleRequirement) ||
    stored.bundleRequirementHash !== candidate.bundleRequirementHash ||
    stored.partyPlanHash !== candidate.partyPlanHash ||
    !canonicalEqual(stored.requirementPath, candidate.requirementPath) ||
    !canonicalEqual(stored.requirement, candidate.requirement) ||
    !canonicalEqual(stored.family, candidate.family) ||
    stored.method !== candidate.method ||
    stored.selectionKind !== candidate.selectionKind ||
    stored.sessionSnapshotHash !== candidate.sessionSnapshotHash ||
    !canonicalEqual(stored.provenance, candidate.provenance)
  ) {
    throw new DacsError(
      "durable recipe pin conflicts with the stored requirement or recipe family",
    );
  }
}

function assertLiveLeaseRecord(
  record: Readonly<SessionRecord>,
  jobId: string,
  leaseToken: Readonly<SessionLeaseToken>,
  now: number,
): void {
  if (
    record.jobId !== jobId ||
    !record.lease ||
    record.lease.owner !== leaseToken.owner ||
    record.lease.generation !== leaseToken.generation ||
    record.lease.expiresAt <= now
  ) {
    throw new DacsError(
      "durable recipe checkpoint is lease-fenced or its lease has expired",
    );
  }
}

/** Runtime provenance guard only; this never grants current effect authority. */
export function isDurableSessionRecipePin(
  value: unknown,
): value is DurableSessionRecipePin {
  return isRecord(value) && durablePins.has(value);
}

/** Runtime provenance guard; this proves immutable data, never current effect authority. */
export function isDurableSessionRecipeRegistrySnapshot(
  value: unknown,
): value is DurableSessionRecipeRegistrySnapshot {
  return isRecord(value) && durableRegistrySnapshots.has(value);
}

function snapshotPayloadFromAuthenticated(
  snapshot: AuthenticatedRecipeRegistrySnapshot,
  input: {
    jobId: string;
    sessionStartHash: string;
    leaseToken: SessionLeaseToken;
    now: number;
  },
): DurableRecipeRegistrySnapshotPayload {
  return captureRegistrySnapshotPayload({
    snapshotVersion: "1",
    jobId: input.jobId,
    sessionStartHash: input.sessionStartHash,
    registry: registryProvenanceFromSnapshot(snapshot),
    entries: snapshot.entries,
    pinnedBy: input.leaseToken,
    pinnedAt: input.now,
  });
}

/** Authenticate currentness inside the operation and atomically establish one job-wide snapshot. */
export async function pinSessionRecipeRegistrySnapshot(
  source: PinSessionRecipeRegistrySnapshotInput,
): Promise<DurableSessionRecipeRegistrySnapshot> {
  if (!exactKeys(source, [
    "store", "jobId", "sessionStartHash", "provider", "leaseToken",
  ], ["now"])) {
    throw new DacsError("session recipe registry snapshot input must be exact");
  }
  const descriptors = Object.getOwnPropertyDescriptors(source);
  const store = captureStore(descriptors.store!.value);
  const jobId = descriptors.jobId!.value as unknown;
  const sessionStartHash = descriptors.sessionStartHash!.value as unknown;
  const provider = descriptors.provider!.value as RecipeRegistrySelectionProvider;
  const leaseToken = captureLeaseToken(descriptors.leaseToken!.value);
  const nowValue = descriptors.now?.value as unknown;
  if (
    !isNonEmptyTrimmed(jobId) ||
    typeof sessionStartHash !== "string" ||
    !HASH.test(sessionStartHash) ||
    (nowValue !== undefined && !isNonNegativeSafeInteger(nowValue))
  ) {
    throw new DacsError("session recipe registry snapshot scope is malformed");
  }
  const authenticated = await authenticateRecipeRegistrySnapshot(provider);
  const now = nowValue ?? Date.now();
  if (!isNonNegativeSafeInteger(now)) {
    throw new DacsError("session recipe registry snapshot clock is outside the safe range");
  }
  const payload = snapshotPayloadFromAuthenticated(authenticated, {
    jobId,
    sessionStartHash,
    leaseToken,
    now,
  });
  const snapshotJson = canonicalize(payload);
  const snapshotHash = sha256Hex(snapshotJson);
  let rawClaim: unknown;
  try {
    rawClaim = await store.claimCheckpoint({
      jobId,
      key: SESSION_RECIPE_REGISTRY_SNAPSHOT_CHECKPOINT_KEY,
      data: { snapshot: snapshotJson, snapshotHash },
      leaseToken,
      now,
    });
  } catch (error) {
    if (error instanceof DacsError) throw error;
    throw new DacsError("session recipe registry snapshot claim failed", { cause: error });
  }
  const claim = captureClaimResult(rawClaim);
  if (!claim.ok && claim.reason !== "held" && claim.reason !== "completed") {
    throw new DacsError(`session recipe registry snapshot rejected: ${claim.reason}`);
  }
  if (!claim.record) {
    throw new DacsError("session recipe registry snapshot store returned no record");
  }
  assertLiveLeaseRecord(claim.record, jobId, leaseToken, now);
  const stored = registrySnapshotFromRecord(claim.record);
  assertStoredRegistrySnapshotScope(stored, { jobId, sessionStartHash });
  if (claim.ok) {
    if (stored.snapshotHash !== snapshotHash) {
      throw new DacsError("store changed the newly claimed registry snapshot");
    }
  } else {
    assertConcurrentSnapshotCompatibility(stored, payload);
  }
  return stored;
}

/** Recover the exact job-wide snapshot; an optional current view is audit-only. */
export async function recoverSessionRecipeRegistrySnapshot(
  source: RecoverSessionRecipeRegistrySnapshotInput,
): Promise<DurableSessionRecipeRegistrySnapshot> {
  if (!exactKeys(source, [
    "store", "jobId", "sessionStartHash", "leaseToken",
  ], ["currentSnapshot", "now"])) {
    throw new DacsError("session recipe registry recovery input must be exact");
  }
  const descriptors = Object.getOwnPropertyDescriptors(source);
  const store = captureStore(descriptors.store!.value);
  const jobId = descriptors.jobId!.value as unknown;
  const sessionStartHash = descriptors.sessionStartHash!.value as unknown;
  const leaseToken = captureLeaseToken(descriptors.leaseToken!.value);
  const currentSnapshot = descriptors.currentSnapshot?.value as unknown;
  const nowValue = descriptors.now?.value as unknown;
  if (
    !isNonEmptyTrimmed(jobId) ||
    typeof sessionStartHash !== "string" ||
    !HASH.test(sessionStartHash) ||
    (nowValue !== undefined && !isNonNegativeSafeInteger(nowValue)) ||
    (currentSnapshot !== undefined &&
      !isAuthenticatedRecipeRegistrySnapshot(currentSnapshot))
  ) {
    throw new DacsError("session recipe registry recovery scope is malformed");
  }
  const now = nowValue ?? Date.now();
  let rawLoad: unknown;
  try {
    rawLoad = await store.load(jobId);
  } catch (error) {
    if (error instanceof DacsError) throw error;
    throw new DacsError("session recipe registry snapshot load failed", { cause: error });
  }
  const loaded = captureLoadResult(rawLoad);
  if (loaded.status !== "ok") {
    throw new DacsError(`session recipe registry snapshot cannot be recovered: ${loaded.status}`);
  }
  const stored = registrySnapshotFromRecord(loaded.record);
  assertStoredRegistrySnapshotScope(stored, { jobId, sessionStartHash });
  if (currentSnapshot !== undefined) {
    assertAuthenticatedSnapshotExtendsDurable(
      stored,
      currentSnapshot as AuthenticatedRecipeRegistrySnapshot,
    );
  }
  const checkpointData = registrySnapshotCheckpointData(loaded.record);
  const rawClaim = await store.claimCheckpoint({
    jobId,
    key: SESSION_RECIPE_REGISTRY_SNAPSHOT_CHECKPOINT_KEY,
    data: checkpointData,
    leaseToken,
    now,
  });
  const claim = captureClaimResult(rawClaim);
  if (claim.ok || (claim.reason !== "held" && claim.reason !== "completed")) {
    throw new DacsError(
      `session recipe registry recovery rejected: ${claim.ok ? "checkpoint unexpectedly re-created" : claim.reason}`,
    );
  }
  if (!claim.record) throw new DacsError("session recipe registry recovery returned no record");
  assertLiveLeaseRecord(claim.record, jobId, leaseToken, now);
  const recovered = registrySnapshotFromRecord(claim.record);
  if (recovered.snapshotHash !== stored.snapshotHash) {
    throw new DacsError("session recipe registry snapshot changed during recovery");
  }
  return recovered;
}

interface CapturedPinOperation {
  store: CapturedStore;
  sessionSnapshot: DurableSessionRecipeRegistrySnapshot;
  jobId: string;
  evaluatedParty: string;
  evaluatedPartyIdentity: DurableRecipePartyIdentity;
  bundleRequirement: CompositeBundleRequirement;
  partyPlanHash: string;
  requirementPath: DurableRecipeRequirementPath;
  requirement: CompositeClaimRequirement;
  requestedMethod: VerificationMethodKind;
  leaseToken: SessionLeaseToken;
  now: number;
}

function capturePinOperation(source: unknown, label: string): CapturedPinOperation {
  if (!exactKeys(source, [
    "store", "sessionSnapshot", "jobId", "evaluatedParty", "requirementPath",
    "bundleRequirement", "partyPlanHash", "requestedMethod", "leaseToken",
  ], ["now"])) {
    throw new DacsError(`${label} input must be an exact data record`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(source);
  const store = captureStore(descriptors.store!.value);
  const sessionSnapshot = descriptors.sessionSnapshot!.value as unknown;
  const jobId = descriptors.jobId!.value as unknown;
  const party = parseCanonicalClaimReference(descriptors.evaluatedParty!.value);
  const bundleRequirement = captureBundleRequirement(descriptors.bundleRequirement!.value);
  const partyPlanHash = descriptors.partyPlanHash!.value as unknown;
  const requestedMethod = descriptors.requestedMethod!.value as unknown;
  const requirementPath = capturePath(descriptors.requirementPath!.value);
  const leaseToken = captureLeaseToken(descriptors.leaseToken!.value);
  const nowValue = descriptors.now?.value as unknown;
  if (
    !isDurableSessionRecipeRegistrySnapshot(sessionSnapshot) ||
    !isNonEmptyTrimmed(jobId) ||
    !party ||
    typeof partyPlanHash !== "string" ||
    !HASH.test(partyPlanHash) ||
    typeof requestedMethod !== "string" ||
    !METHODS.has(requestedMethod) ||
    (nowValue !== undefined && !isNonNegativeSafeInteger(nowValue))
  ) {
    throw new DacsError(`${label} scope is malformed`);
  }
  if (sessionSnapshot.jobId !== jobId) {
    throw new DacsError(`${label} snapshot belongs to another job`);
  }
  const requirement = requirementAt(bundleRequirement, requirementPath);
  if (!requirement || !requirement.verificationRequired) {
    throw new DacsError(`${label} path does not locate a verifiable requirement`);
  }
  const requiredMethod = requirement.parameters?.verificationMethod;
  if (requiredMethod !== undefined && requiredMethod !== requestedMethod) {
    throw new DacsError(`${label} violates verificationMethod provenance`);
  }
  const now = nowValue ?? Date.now();
  if (!isNonNegativeSafeInteger(now)) {
    throw new DacsError(`${label} clock is outside the safe range`);
  }
  return {
    store,
    sessionSnapshot,
    jobId,
    evaluatedParty: party.reference,
    evaluatedPartyIdentity: party.identity,
    bundleRequirement,
    partyPlanHash,
    requirementPath,
    requirement,
    requestedMethod: requestedMethod as VerificationMethodKind,
    leaseToken,
    now,
  };
}

async function loadBoundSessionSnapshot(input: CapturedPinOperation): Promise<SessionRecord> {
  const raw = await input.store.load(input.jobId);
  const loaded = captureLoadResult(raw);
  if (loaded.status !== "ok") {
    throw new DacsError(`durable recipe pin cannot load its session snapshot: ${loaded.status}`);
  }
  const stored = registrySnapshotFromRecord(loaded.record);
  if (stored.snapshotHash !== input.sessionSnapshot.snapshotHash) {
    throw new DacsError("durable recipe pin supplied a snapshot from another store/session");
  }
  assertLiveLeaseRecord(loaded.record, input.jobId, input.leaseToken, input.now);
  return loaded.record;
}

/** Derive and persist one requirement pin exclusively from the job-wide snapshot. */
export async function pinSessionRecipeSelection(
  source: PinSessionRecipeInput,
): Promise<DurableSessionRecipePin> {
  const input = capturePinOperation(source, "durable recipe pin");
  await loadBoundSessionSnapshot(input);
  const payload = buildPayload(input);
  const checkpointKey = targetCheckpointKey(
    input.jobId,
    input.evaluatedPartyIdentity,
    input.requirementPath,
  );
  const pinJson = canonicalize(payload);
  const pinHash = sha256Hex(pinJson);
  const rawResult = await input.store.claimCheckpoint({
    jobId: input.jobId,
    key: checkpointKey,
    data: { pin: pinJson, pinHash },
    leaseToken: input.leaseToken,
    now: input.now,
  });
  const result = captureClaimResult(rawResult);
  if (!result.ok && result.reason !== "held" && result.reason !== "completed") {
    throw new DacsError(`durable recipe pin checkpoint rejected: ${result.reason}`);
  }
  if (!result.record) throw new DacsError("durable recipe pin store returned no record");
  assertLiveLeaseRecord(result.record, input.jobId, input.leaseToken, input.now);
  const recordSnapshot = registrySnapshotFromRecord(result.record);
  if (recordSnapshot.snapshotHash !== input.sessionSnapshot.snapshotHash) {
    throw new DacsError("durable recipe session snapshot changed during pinning");
  }
  const stored = pinFromRecord(result.record, checkpointKey);
  if (result.ok && stored.pinHash !== pinHash) {
    throw new DacsError("durable recipe pin store changed the newly claimed payload");
  }
  assertRequestCompatibility(stored, payload);
  return stored;
}

/** Recover one requirement pin; no current registry head is selected or consulted. */
export async function recoverSessionRecipePin(
  source: RecoverSessionRecipePinInput,
): Promise<DurableSessionRecipePin> {
  const input = capturePinOperation(source, "durable recipe recovery");
  const loadedRecord = await loadBoundSessionSnapshot(input);
  const checkpointKey = targetCheckpointKey(
    input.jobId,
    input.evaluatedPartyIdentity,
    input.requirementPath,
  );
  const stored = pinFromRecord(loadedRecord, checkpointKey);
  const request = {
    jobId: input.jobId,
    evaluatedPartyIdentity: input.evaluatedPartyIdentity,
    bundleRequirement: input.bundleRequirement,
    partyPlanHash: input.partyPlanHash,
    requirementPath: input.requirementPath,
    requestedMethod: input.requestedMethod,
    sessionSnapshotHash: input.sessionSnapshot.snapshotHash,
  };
  assertStoredRequest(stored, request);
  const checkpointData = pinCheckpointData(loadedRecord, checkpointKey);
  const rawClaim = await input.store.claimCheckpoint({
    jobId: input.jobId,
    key: checkpointKey,
    data: checkpointData,
    leaseToken: input.leaseToken,
    now: input.now,
  });
  const claim = captureClaimResult(rawClaim);
  if (claim.ok || (claim.reason !== "held" && claim.reason !== "completed")) {
    throw new DacsError(
      `durable recipe recovery rejected: ${claim.ok ? "checkpoint unexpectedly re-created" : claim.reason}`,
    );
  }
  if (!claim.record) throw new DacsError("durable recipe recovery returned no record");
  assertLiveLeaseRecord(claim.record, input.jobId, input.leaseToken, input.now);
  const recovered = pinFromRecord(claim.record, checkpointKey);
  if (recovered.pinHash !== stored.pinHash) {
    throw new DacsError("durable recipe pin changed during recovery");
  }
  assertStoredRequest(recovered, request);
  return recovered;
}

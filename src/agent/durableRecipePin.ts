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
  RECIPE_REGISTRY_INDEX_ADDRESS,
  isAuthenticatedRecipeRegistrySnapshot,
  isHistoricalRecipeResolution,
  isLatestRecipeSelection,
  type AuthenticatedRecipeRegistrySnapshot,
  type HistoricalRecipeResolution,
  type LatestRecipeSelection,
  type RecipeFamilyIdentity,
  type RecipeRegistryIndexDocument,
  type RecipeRegistryProvenance,
  type RecipeRegistryRecipeRef,
} from "../registry/recipeSelection.js";
import { isRecipeDescriptor } from "../registry/resolve.js";
import type { RecipeDescriptor } from "../registry/types.js";
import {
  isCompositeBundleRequirement,
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

/**
 * Immutable recipe pin recovered from one generation-fenced session
 * checkpoint. It is deliberately distinct from a live registry selection: a
 * caller cannot cast parsed disk bytes into either runtime provenance class.
 */
export type DurableSessionRecipePin = DeepReadonly<DurableRecipePinPayload> & {
  readonly checkpointKey: string;
  readonly pinHash: string;
  readonly [durableSessionRecipePinBrand]: true;
};

export interface PinSessionRecipeInput {
  store: FencedSessionStoreV2;
  jobId: string;
  evaluatedParty: string;
  requirementPath: DurableRecipeRequirementPath;
  /** Exact requirement whose recipe selection must remain stable. */
  requirement: CompositeClaimRequirement;
  /** Runtime-authenticated current or explicit historical selection. */
  selection: LatestRecipeSelection | HistoricalRecipeResolution;
  /** Exact live generation authorised to establish or recover this pin. */
  leaseToken: SessionLeaseToken;
  now?: number;
}

export interface RecoverSessionRecipePinInput {
  store: FencedSessionStoreV2;
  jobId: string;
  evaluatedParty: string;
  requirementPath: DurableRecipeRequirementPath;
  requirement: CompositeClaimRequirement;
  leaseToken: SessionLeaseToken;
  /**
   * Optional authenticated current view used to prove append-only retention.
   * Recovery does not reselect its head, so a removed method cannot replace or
   * strand the stored in-flight pin.
   */
  snapshot?: AuthenticatedRecipeRegistrySnapshot;
  now?: number;
}

const durablePins = new WeakSet<object>();
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

function canonicalClaimReference(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.normalize("NFC") !== value ||
    /[\s\u0000-\u001f\u007f]/.test(value)
  ) {
    return false;
  }
  const colon = value.indexOf(":");
  return colon > 0 && /^[a-z][a-z0-9-]*$/.test(value.slice(0, colon));
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
    !canonicalClaimReference(captured.writer)
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
  "pinnedBy",
  "pinnedAt",
] as const;

function capturePinPayload(value: unknown): DurableRecipePinPayload {
  const captured = captureJson(value, "durable recipe pin payload");
  if (
    !exactKeys(captured, PIN_KEYS) ||
    captured.pinVersion !== "1" ||
    !isNonEmptyTrimmed(captured.jobId) ||
    !canonicalClaimReference(captured.evaluatedParty) ||
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
    !isNonNegativeSafeInteger(captured.pinnedAt)
  ) {
    throw new DacsError("durable recipe pin payload is malformed");
  }
  const requirementPath = capturePath(captured.requirementPath);
  const requirement = captureRequirement(captured.requirement);
  const family = captureFamily(captured.family);
  const indexRef = captureRecipeRef(captured.indexRef, "durable pin index ref");
  const recipeRef = captureRecipeRef(captured.recipeRef, "durable pin recipe ref");
  const provenance = captureProvenance(captured.provenance);
  const pinnedBy = captureLeaseToken(captured.pinnedBy);
  const expectedRequirementHash = sha256Hex(canonicalize(requirement));
  const expectedProvenanceHash = sha256Hex(canonicalize(provenance));
  if (
    captured.requirementHash !== expectedRequirementHash ||
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
  evaluatedParty: string,
  requirementPath: DurableRecipeRequirementPath,
): string {
  const targetHash = sha256Hex(canonicalize({
    targetVersion: "1",
    jobId,
    evaluatedParty,
    requirementPath,
  }));
  return `dacs2:recipe-pin:${targetHash}`;
}

function buildPayload(
  input: {
    jobId: string;
    evaluatedParty: string;
    requirementPath: DurableRecipeRequirementPath;
    requirement: CompositeClaimRequirement;
    selection: LatestRecipeSelection | HistoricalRecipeResolution;
    leaseToken: SessionLeaseToken;
    now: number;
  },
): DurableRecipePinPayload {
  const provenance = captureProvenance(input.selection);
  return capturePinPayload({
    pinVersion: "1",
    jobId: input.jobId,
    evaluatedParty: input.evaluatedParty,
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
    evaluatedParty: string;
    requirementPath: DurableRecipeRequirementPath;
    requirement: CompositeClaimRequirement;
  },
): void {
  if (
    stored.jobId !== input.jobId ||
    stored.evaluatedParty !== input.evaluatedParty ||
    !canonicalEqual(stored.requirementPath, input.requirementPath) ||
    !canonicalEqual(stored.requirement, input.requirement)
  ) {
    throw new DacsError("durable recipe recovery conflicts with the stored requirement path");
  }
}

function assertSnapshotRetainsPin(
  stored: Readonly<DurableSessionRecipePin>,
  snapshot: AuthenticatedRecipeRegistrySnapshot,
): void {
  if (!isAuthenticatedRecipeRegistrySnapshot(snapshot)) {
    throw new DacsError("durable recipe recovery snapshot is not runtime-authenticated");
  }
  if (snapshot.registryVersion < stored.registryVersion) {
    throw new DacsError("durable recipe recovery refuses a registry-version rollback");
  }
  if (
    snapshot.registryVersion === stored.registryVersion &&
    snapshot.indexContentHash !== stored.indexContentHash
  ) {
    throw new DacsError("durable recipe recovery found conflicting bytes at one registry version");
  }
  const retained = snapshot.entries.find(
    (entry) => canonicalEqual(entry.ref, stored.recipeRef),
  );
  if (
    !retained ||
    retained.recipe.scheme !== stored.provenance.recipe.scheme ||
    retained.recipe.recipeVersion !== stored.recipeVersion ||
    !canonicalEqual(retained.recipe, stored.provenance.recipe)
  ) {
    throw new DacsError("authenticated registry snapshot omits or changes the stored recipe pin");
  }
}

function assertRequestCompatibility(
  stored: Readonly<DurableSessionRecipePin>,
  candidate: Readonly<DurableRecipePinPayload>,
): void {
  if (
    stored.jobId !== candidate.jobId ||
    stored.evaluatedParty !== candidate.evaluatedParty ||
    !canonicalEqual(stored.requirementPath, candidate.requirementPath) ||
    !canonicalEqual(stored.requirement, candidate.requirement) ||
    !canonicalEqual(stored.family, candidate.family) ||
    stored.method !== candidate.method ||
    (stored.requirement.recipeVersion === undefined &&
      stored.selectionKind !== candidate.selectionKind)
  ) {
    throw new DacsError(
      "durable recipe pin conflicts with the stored requirement or recipe family",
    );
  }
  if (
    stored.requirement.recipeVersion !== undefined &&
    stored.recipeVersion !== candidate.recipeVersion
  ) {
    throw new DacsError("durable historical recipe pin conflicts with the requested version");
  }
  if (candidate.registryVersion < stored.registryVersion) {
    throw new DacsError("durable recipe pin recovery refuses a registry-version rollback");
  }
  if (
    candidate.registryVersion === stored.registryVersion &&
    candidate.indexContentHash !== stored.indexContentHash
  ) {
    throw new DacsError("durable recipe pin recovery found conflicting bytes at one registry version");
  }
  if (
    candidate.registryVersion > stored.registryVersion &&
    !candidate.provenance.registry.index.entries.some((ref) =>
      canonicalEqual(ref, stored.recipeRef))
  ) {
    throw new DacsError("advanced registry omits the session's stored recipe reference");
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
    throw new DacsError("durable recipe pin store did not authenticate the live lease generation");
  }
}

/** Runtime provenance guard; cloned or caller-cast values are never accepted. */
export function isDurableSessionRecipePin(
  value: unknown,
): value is DurableSessionRecipePin {
  return isRecord(value) && durablePins.has(value);
}

/**
 * Atomically establish or recover one session recipe pin before Vet effects.
 *
 * The first live lease persists the complete canonical payload in the
 * checkpoint intent itself. A concurrent/restarted worker must present its own
 * live generation, then recovers that immutable payload. For an unpinned
 * requirement a newer current selection is intentionally ignored on recovery;
 * the stored session-start version remains authoritative.
 */
export async function pinSessionRecipeSelection(
  source: PinSessionRecipeInput,
): Promise<DurableSessionRecipePin> {
  if (
    !exactKeys(source, [
      "store",
      "jobId",
      "evaluatedParty",
      "requirementPath",
      "requirement",
      "selection",
      "leaseToken",
    ], ["now"])
  ) {
    throw new DacsError("durable recipe pin input must be an exact data record");
  }
  const descriptors = Object.getOwnPropertyDescriptors(source);
  const store = captureStore(descriptors.store!.value);
  const jobId = descriptors.jobId!.value as unknown;
  const evaluatedParty = descriptors.evaluatedParty!.value as unknown;
  const selection = descriptors.selection!.value as unknown;
  const nowValue = descriptors.now?.value as unknown;
  if (!isNonEmptyTrimmed(jobId) || !canonicalClaimReference(evaluatedParty)) {
    throw new DacsError("durable recipe pin job or evaluated party is malformed");
  }
  if (nowValue !== undefined && !isNonNegativeSafeInteger(nowValue)) {
    throw new DacsError("durable recipe pin now must be a non-negative safe integer");
  }
  const now = nowValue ?? Date.now();
  if (!isNonNegativeSafeInteger(now)) {
    throw new DacsError("durable recipe pin clock is outside the safe range");
  }
  const requirementPath = capturePath(descriptors.requirementPath!.value);
  const requirement = captureRequirement(descriptors.requirement!.value);
  const leaseToken = captureLeaseToken(descriptors.leaseToken!.value);
  if (!isLatestRecipeSelection(selection) && !isHistoricalRecipeResolution(selection)) {
    throw new DacsError(
      "durable recipe pin requires runtime-authenticated recipe selection provenance",
    );
  }
  if (
    requirement.recipeVersion === undefined &&
    !isLatestRecipeSelection(selection)
  ) {
    throw new DacsError(
      "an unpinned ClaimRequirement requires latest-at-session selection provenance",
    );
  }
  if (
    isLatestRecipeSelection(selection) &&
    selection.required !== requirement.verificationRequired
  ) {
    throw new DacsError("latest recipe selection requiredness conflicts with the requirement");
  }
  if (
    selection.recipe.scheme !== requirement.scheme ||
    (requirement.recipeVersion !== undefined &&
      selection.recipe.recipeVersion !== requirement.recipeVersion)
  ) {
    throw new DacsError("recipe selection does not satisfy the exact requirement pin");
  }
  const requiredMethod = requirement.parameters?.verificationMethod;
  if (
    requiredMethod !== undefined &&
    (typeof requiredMethod !== "string" || requiredMethod !== selection.requestedMethod)
  ) {
    throw new DacsError("recipe selection violates verificationMethod provenance");
  }

  const payload = buildPayload({
    jobId,
    evaluatedParty,
    requirementPath,
    requirement,
    selection,
    leaseToken,
    now,
  });
  const checkpointKey = targetCheckpointKey(jobId, evaluatedParty, requirementPath);
  const pinJson = canonicalize(payload);
  const pinHash = sha256Hex(pinJson);
  let rawResult: unknown;
  try {
    rawResult = await store.claimCheckpoint({
      jobId,
      key: checkpointKey,
      data: { pin: pinJson, pinHash },
      leaseToken,
      now,
    });
  } catch (error) {
    if (error instanceof DacsError) throw error;
    throw new DacsError("durable recipe pin checkpoint claim failed", {
      cause: error,
    });
  }
  const result = captureClaimResult(rawResult);
  if (!result.ok && result.reason !== "held" && result.reason !== "completed") {
    throw new DacsError(`durable recipe pin checkpoint rejected: ${result.reason}`);
  }
  if (!result.record) {
    throw new DacsError("durable recipe pin store did not return the exact session record");
  }
  assertLiveLeaseRecord(result.record, jobId, leaseToken, now);
  const stored = pinFromRecord(result.record, checkpointKey);
  if (result.ok && stored.pinHash !== pinHash) {
    throw new DacsError("durable recipe pin store changed the newly claimed payload");
  }
  assertRequestCompatibility(stored, payload);
  return stored;
}

/**
 * Recover an already-persisted pin without reselecting a current family head.
 * This is the cold-restart path when the latest head advanced or removed the
 * method used by the in-flight session. A supplied authenticated snapshot is
 * checked only for append-only retention of the exact stored recipe.
 */
export async function recoverSessionRecipePin(
  source: RecoverSessionRecipePinInput,
): Promise<DurableSessionRecipePin> {
  if (
    !exactKeys(source, [
      "store",
      "jobId",
      "evaluatedParty",
      "requirementPath",
      "requirement",
      "leaseToken",
    ], ["snapshot", "now"])
  ) {
    throw new DacsError("durable recipe recovery input must be an exact data record");
  }
  const descriptors = Object.getOwnPropertyDescriptors(source);
  const store = captureStore(descriptors.store!.value);
  const jobId = descriptors.jobId!.value as unknown;
  const evaluatedParty = descriptors.evaluatedParty!.value as unknown;
  const nowValue = descriptors.now?.value as unknown;
  const snapshot = descriptors.snapshot?.value as unknown;
  if (!isNonEmptyTrimmed(jobId) || !canonicalClaimReference(evaluatedParty)) {
    throw new DacsError("durable recipe recovery job or evaluated party is malformed");
  }
  if (nowValue !== undefined && !isNonNegativeSafeInteger(nowValue)) {
    throw new DacsError("durable recipe recovery now must be a non-negative safe integer");
  }
  if (
    snapshot !== undefined &&
    !isAuthenticatedRecipeRegistrySnapshot(snapshot)
  ) {
    throw new DacsError("durable recipe recovery snapshot is not runtime-authenticated");
  }
  const now = nowValue ?? Date.now();
  if (!isNonNegativeSafeInteger(now)) {
    throw new DacsError("durable recipe recovery clock is outside the safe range");
  }
  const requirementPath = capturePath(descriptors.requirementPath!.value);
  const requirement = captureRequirement(descriptors.requirement!.value);
  const leaseToken = captureLeaseToken(descriptors.leaseToken!.value);
  const checkpointKey = targetCheckpointKey(jobId, evaluatedParty, requirementPath);

  let rawLoad: unknown;
  try {
    rawLoad = await store.load(jobId);
  } catch (error) {
    if (error instanceof DacsError) throw error;
    throw new DacsError("durable recipe pin load failed", { cause: error });
  }
  const loaded = captureLoadResult(rawLoad);
  if (loaded.status !== "ok") {
    throw new DacsError(`durable recipe pin cannot be recovered: ${loaded.status}`);
  }
  const stored = pinFromRecord(loaded.record, checkpointKey);
  assertStoredRequest(stored, {
    jobId,
    evaluatedParty,
    requirementPath,
    requirement,
  });
  if (snapshot !== undefined) assertSnapshotRetainsPin(stored, snapshot);
  const checkpointData = pinCheckpointData(loaded.record, checkpointKey);

  let rawClaim: unknown;
  try {
    rawClaim = await store.claimCheckpoint({
      jobId,
      key: checkpointKey,
      data: checkpointData,
      leaseToken,
      now,
    });
  } catch (error) {
    if (error instanceof DacsError) throw error;
    throw new DacsError("durable recipe recovery fence check failed", {
      cause: error,
    });
  }
  const claim = captureClaimResult(rawClaim);
  if (claim.ok || (claim.reason !== "held" && claim.reason !== "completed")) {
    const reason = claim.ok ? "checkpoint unexpectedly re-created" : claim.reason;
    throw new DacsError(`durable recipe recovery rejected: ${reason}`);
  }
  if (!claim.record) {
    throw new DacsError("durable recipe recovery did not return its session record");
  }
  assertLiveLeaseRecord(claim.record, jobId, leaseToken, now);
  const recovered = pinFromRecord(claim.record, checkpointKey);
  if (recovered.pinHash !== stored.pinHash) {
    throw new DacsError("durable recipe pin changed during recovery");
  }
  assertStoredRequest(recovered, {
    jobId,
    evaluatedParty,
    requirementPath,
    requirement,
  });
  if (snapshot !== undefined) assertSnapshotRetainsPin(recovered, snapshot);
  return recovered;
}

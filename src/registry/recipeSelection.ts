import { types as nodeTypes } from "node:util";

import {
  canonicalize,
  contentHash,
} from "../canonical/index.js";
import {
  verifyComponentSignature,
} from "../artifacts/signatures.js";
import type {
  AnchorReceipt,
  AttestationAnchor,
  ComponentSignature,
  VerificationMethodKind,
} from "../artifacts/types.js";
import {
  isAnchorReceipt,
  isAttestationRef,
  isExactJsonRecord,
} from "../artifacts/validators.js";
import { DacsError, SubstrateError } from "../errors.js";
import {
  isRecipeDescriptor,
} from "./resolve.js";
import type {
  RecipeDescriptor,
  RecipeSelector,
} from "./types.js";

/** Stable DACS-2 v0.x recipe-registry index address. */
export const RECIPE_REGISTRY_INDEX_ADDRESS = "dacs2:registry:v0.1" as const;

/**
 * An exact reference carried by the operational registry index.
 *
 * The Standard does not currently define a signed index wire artifact. This is
 * therefore an SDK provider contract, not a new normative DACS field. Index
 * authority comes from the separately authenticated finalized SR-2 binding.
 */
export interface RecipeRegistryRecipeRef {
  anchor: AttestationAnchor;
  contentHash: string;
}

/**
 * Canonical operational projection read back from the stable registry address.
 * It intentionally has no `signature`: callers must authenticate the exact
 * address/ref/hash/version/writer/finality tuple through the provider below.
 */
export interface RecipeRegistryIndexDocument {
  registryId: typeof RECIPE_REGISTRY_INDEX_ADDRESS;
  entries: RecipeRegistryRecipeRef[];
}

/** Exact current binding discovered at the canonical mutable index address. */
export interface CurrentRecipeRegistryIndex {
  /** Monotonic operational version authenticated alongside the binding. */
  registryVersion: number;
  indexRef: RecipeRegistryRecipeRef;
  receipt: AnchorReceipt;
}

export type RecipeRegistryAuthorityVerification =
  | "valid"
  | "invalid"
  | "indeterminate";

/** Exact facts passed to the binding-specific cryptographic authenticator. */
export interface RecipeRegistryAuthorityInput {
  logicalAddress: typeof RECIPE_REGISTRY_INDEX_ADDRESS;
  registryVersion: number;
  indexRef: Readonly<RecipeRegistryRecipeRef>;
  receipt: Readonly<AnchorReceipt>;
  index: Readonly<RecipeRegistryIndexDocument>;
}

/**
 * Operational trust provider for one current recipe-registry snapshot.
 *
 * `authenticateCurrentIndex` MUST independently authenticate the receipt proof,
 * confirm that it is the current binding at `logicalAddress`, and bind the exact
 * registryVersion/ref/hash/writer tuple supplied in the input. Returning `valid`
 * for a merely well-shaped, stale, cached, or caller-asserted view is unsafe.
 */
export interface RecipeRegistrySelectionProvider {
  resolveCurrentIndex: (
    logicalAddress: typeof RECIPE_REGISTRY_INDEX_ADDRESS,
  ) => Promise<CurrentRecipeRegistryIndex | null>;
  authenticateCurrentIndex: (
    input: Readonly<RecipeRegistryAuthorityInput>,
  ) =>
    | Promise<RecipeRegistryAuthorityVerification>
    | RecipeRegistryAuthorityVerification;
  /** Independent exact-content readback for both index and recipe refs. */
  readAnchoredJson: (
    ref: Readonly<RecipeRegistryRecipeRef>,
  ) => Promise<Record<string, unknown> | null>;
  /** SR-2 writer authorised to own the canonical index binding. */
  stewardWriter: string;
  /** DACS-2 RA-1 ComponentSignature signer authorised for every recipe. */
  stewardSigner: string;
  /** Pinned PA-2 Ed25519 steward key. */
  stewardPublicKey: Uint8Array;
  verify: (
    bytes: Uint8Array,
    signature: Uint8Array,
    publicKey: Uint8Array,
  ) => Promise<boolean> | boolean;
}

type SignedRecipe = RecipeDescriptor & { signature: ComponentSignature };

export interface AuthenticatedRecipeRegistryEntry {
  ref: Readonly<RecipeRegistryRecipeRef>;
  recipe: Readonly<SignedRecipe>;
}

export interface RecipeFamilyIdentity {
  scheme: string;
  defaultMethod: VerificationMethodKind;
}

export interface RecipeRegistryProvenance {
  logicalAddress: typeof RECIPE_REGISTRY_INDEX_ADDRESS;
  registryVersion: number;
  index: Readonly<RecipeRegistryIndexDocument>;
  indexRef: Readonly<RecipeRegistryRecipeRef>;
  indexContentHash: string;
  writer: string;
  receipt: Readonly<AnchorReceipt>;
}

declare const authenticatedRecipeRegistrySnapshotBrand: unique symbol;
export type AuthenticatedRecipeRegistrySnapshot = RecipeRegistryProvenance & {
  entries: ReadonlyArray<Readonly<AuthenticatedRecipeRegistryEntry>>;
  readonly [authenticatedRecipeRegistrySnapshotBrand]: true;
};

export interface LatestRecipeSelector {
  scheme: string;
  method: VerificationMethodKind;
  /** Deprecated heads cannot begin verification for a required claim. */
  required: boolean;
}

declare const latestRecipeSelectionBrand: unique symbol;
export type LatestRecipeSelection = {
  selectionKind: "latest-at-session-start";
  family: Readonly<RecipeFamilyIdentity>;
  requestedMethod: VerificationMethodKind;
  required: boolean;
  registry: Readonly<RecipeRegistryProvenance>;
  recipeRef: Readonly<RecipeRegistryRecipeRef>;
  recipeContentHash: string;
  recipe: Readonly<SignedRecipe>;
  readonly [latestRecipeSelectionBrand]: true;
};

declare const historicalRecipeResolutionBrand: unique symbol;
export type HistoricalRecipeResolution = {
  selectionKind: "explicit-historical";
  family: Readonly<RecipeFamilyIdentity>;
  requestedMethod: VerificationMethodKind;
  registry: Readonly<RecipeRegistryProvenance>;
  recipeRef: Readonly<RecipeRegistryRecipeRef>;
  recipeContentHash: string;
  recipe: Readonly<SignedRecipe>;
  readonly [historicalRecipeResolutionBrand]: true;
};

const authenticatedSnapshots = new WeakSet<object>();
const latestSelections = new WeakSet<object>();
const historicalResolutions = new WeakSet<object>();

const INERT_PROVIDER_RECEIVER = Object.freeze(Object.create(null)) as object;

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
const isPositiveSafeInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function isCanonicalClaimReference(value: unknown): value is string {
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

function exactOwnDataKeys(
  value: unknown,
  required: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value) || nodeTypes.isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== required.length ||
      ownKeys.some((key) => typeof key !== "string") ||
      !required.every((key) => ownKeys.includes(key))
    ) {
      return false;
    }
    return required.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor !== undefined &&
        descriptor.enumerable === true &&
        "value" in descriptor &&
        descriptor.value !== undefined
      );
    });
  } catch {
    return false;
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value as object)) {
    return value;
  }
  if (ArrayBuffer.isView(value)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function immutableSnapshot<T>(value: T, label: string): T {
  try {
    return deepFreeze(structuredClone(value));
  } catch {
    throw new DacsError(`${label} is not snapshot-safe`);
  }
}

function isRecipeRef(value: unknown): value is RecipeRegistryRecipeRef {
  return (
    isExactJsonRecord(value) &&
    exactOwnDataKeys(value, ["anchor", "contentHash"]) &&
    isAttestationRef(value)
  );
}

function isIndexDocument(value: unknown): value is RecipeRegistryIndexDocument {
  if (
    !isExactJsonRecord(value) ||
    !exactOwnDataKeys(value, ["registryId", "entries"]) ||
    value.registryId !== RECIPE_REGISTRY_INDEX_ADDRESS ||
    !Array.isArray(value.entries) ||
    value.entries.length === 0
  ) {
    return false;
  }
  try {
    if (Object.getPrototypeOf(value.entries) !== Array.prototype) return false;
    const keys = Reflect.ownKeys(value.entries);
    if (keys.length !== value.entries.length + 1 || !keys.includes("length")) {
      return false;
    }
    return value.entries.every(isRecipeRef);
  } catch {
    return false;
  }
}

function isCurrentIndex(value: unknown): value is CurrentRecipeRegistryIndex {
  return (
    isExactJsonRecord(value) &&
    exactOwnDataKeys(value, ["registryVersion", "indexRef", "receipt"]) &&
    isPositiveSafeInt(value.registryVersion) &&
    isRecipeRef(value.indexRef) &&
    isAnchorReceipt(value.receipt)
  );
}

interface CapturedProvider {
  resolveCurrentIndex: RecipeRegistrySelectionProvider["resolveCurrentIndex"];
  authenticateCurrentIndex: RecipeRegistrySelectionProvider["authenticateCurrentIndex"];
  readAnchoredJson: RecipeRegistrySelectionProvider["readAnchoredJson"];
  stewardWriter: string;
  stewardSigner: string;
  stewardPublicKey: Uint8Array;
  verify: RecipeRegistrySelectionProvider["verify"];
}

function captureProvider(source: RecipeRegistrySelectionProvider): CapturedProvider {
  const keys = [
    "resolveCurrentIndex",
    "authenticateCurrentIndex",
    "readAnchoredJson",
    "stewardWriter",
    "stewardSigner",
    "stewardPublicKey",
    "verify",
  ] as const;
  if (!exactOwnDataKeys(source, keys)) {
    throw new DacsError(
      "recipe registry provider must contain exact own data callbacks and trust material",
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(source);
  const resolveCurrentIndex = descriptors.resolveCurrentIndex!.value as unknown;
  const authenticateCurrentIndex = descriptors.authenticateCurrentIndex!.value as unknown;
  const readAnchoredJson = descriptors.readAnchoredJson!.value as unknown;
  const verify = descriptors.verify!.value as unknown;
  const stewardWriter = descriptors.stewardWriter!.value as unknown;
  const stewardSigner = descriptors.stewardSigner!.value as unknown;
  const stewardPublicKey = descriptors.stewardPublicKey!.value as unknown;
  if (
    typeof resolveCurrentIndex !== "function" ||
    nodeTypes.isProxy(resolveCurrentIndex) ||
    typeof authenticateCurrentIndex !== "function" ||
    nodeTypes.isProxy(authenticateCurrentIndex) ||
    typeof readAnchoredJson !== "function" ||
    nodeTypes.isProxy(readAnchoredJson) ||
    typeof verify !== "function" ||
    nodeTypes.isProxy(verify) ||
    !isCanonicalClaimReference(stewardWriter) ||
    !isCanonicalClaimReference(stewardSigner) ||
    !(stewardPublicKey instanceof Uint8Array) ||
    nodeTypes.isProxy(stewardPublicKey) ||
    Object.getPrototypeOf(stewardPublicKey) !== Uint8Array.prototype ||
    Object.getPrototypeOf(stewardPublicKey.buffer) !== ArrayBuffer.prototype ||
    stewardPublicKey.byteOffset !== 0 ||
    stewardPublicKey.byteLength !== 32 ||
    stewardPublicKey.byteLength !== stewardPublicKey.buffer.byteLength ||
    Reflect.ownKeys(stewardPublicKey).some(
      (key, index) => key !== String(index),
    )
  ) {
    throw new DacsError("recipe registry provider trust material is malformed");
  }
  const capturedResolve = resolveCurrentIndex as RecipeRegistrySelectionProvider["resolveCurrentIndex"];
  const capturedAuthenticate = authenticateCurrentIndex as RecipeRegistrySelectionProvider["authenticateCurrentIndex"];
  const capturedRead = readAnchoredJson as RecipeRegistrySelectionProvider["readAnchoredJson"];
  const capturedVerify = verify as RecipeRegistrySelectionProvider["verify"];
  return {
    resolveCurrentIndex: (logicalAddress) =>
      Reflect.apply(capturedResolve, INERT_PROVIDER_RECEIVER, [logicalAddress]),
    authenticateCurrentIndex: (input) =>
      Reflect.apply(capturedAuthenticate, INERT_PROVIDER_RECEIVER, [input]),
    readAnchoredJson: (ref) =>
      Reflect.apply(capturedRead, INERT_PROVIDER_RECEIVER, [ref]),
    stewardWriter,
    stewardSigner,
    stewardPublicKey: Uint8Array.from(stewardPublicKey),
    verify: (bytes, signature, publicKey) =>
      Reflect.apply(capturedVerify, INERT_PROVIDER_RECEIVER, [
        bytes,
        signature,
        publicKey,
      ]),
  };
}

function familyKey(recipe: Readonly<RecipeDescriptor>): string {
  return `${recipe.scheme}\u0000${recipe.defaultMethod.kind}`;
}

function versionKey(recipe: Readonly<RecipeDescriptor>): string {
  // RA-3 allocates one monotonic version sequence per scheme, including
  // across distinct families for that scheme.
  return `${recipe.scheme}\u0000${recipe.recipeVersion}`;
}

function methodKinds(recipe: Readonly<RecipeDescriptor>): VerificationMethodKind[] {
  return [recipe.defaultMethod, ...(recipe.alternatives ?? [])].map(
    (method) => method.kind,
  );
}

function assertUniqueIndexRefs(index: Readonly<RecipeRegistryIndexDocument>): void {
  const refs = index.entries.map((entry) => canonicalize(entry));
  if (new Set(refs).size !== refs.length) {
    throw new DacsError("recipe registry index repeats a recipe reference");
  }
  const locators = index.entries.map((entry) => entry.anchor.locator);
  if (new Set(locators).size !== locators.length) {
    throw new DacsError("recipe registry index repeats a recipe anchor");
  }
}

async function readExactJson(
  provider: CapturedProvider,
  ref: Readonly<RecipeRegistryRecipeRef>,
  label: string,
): Promise<Record<string, unknown>> {
  let raw: Record<string, unknown> | null;
  try {
    raw = await provider.readAnchoredJson(
      immutableSnapshot(ref, `${label} read reference`),
    );
  } catch (error) {
    throw new SubstrateError(`${label} readback errored`, { cause: error });
  }
  if (raw === null) throw new SubstrateError(`${label} readback is unresolved`);
  // Inspect the callback-owned value before cloning. This prevents an accessor,
  // proxy-normalised prototype, symbol, sparse array, or undefined overlay from
  // becoming trusted merely because structuredClone produces plain JSON.
  if (!isExactJsonRecord(raw)) {
    throw new DacsError(`${label} readback is not exact JSON`);
  }
  return immutableSnapshot(raw, `${label} readback`);
}

async function verifyStewardRecipe(
  recipe: Readonly<SignedRecipe>,
  provider: CapturedProvider,
): Promise<void> {
  const result = await verifyComponentSignature(
    recipe as unknown as Record<string, unknown>,
    "dacs-recipe:v1:",
    {
      isSignerAuthorized: (_artifact, signature) =>
        signature.signer === provider.stewardSigner,
      resolvePublicKey: (signature) =>
        signature.algorithm === "ed25519"
          ? Uint8Array.from(provider.stewardPublicKey)
          : null,
      verify: async ({ signedBytes, signature, publicKey }) =>
        (await provider.verify(
          Uint8Array.from(signedBytes),
          Uint8Array.from(Buffer.from(signature.value, "base64url")),
          Uint8Array.from(publicKey),
        )) === true,
    },
  );
  if (result.status === "unresolved") {
    throw new SubstrateError(
      `recipe signature verification is unresolved (${result.reason})`,
    );
  }
  if (result.status !== "valid") {
    throw new DacsError("recipe signature is not valid under the steward key");
  }
}

function assertFamilyGraph(
  entries: ReadonlyArray<Readonly<AuthenticatedRecipeRegistryEntry>>,
): Map<string, Readonly<AuthenticatedRecipeRegistryEntry>> {
  const byVersion = new Map<string, AuthenticatedRecipeRegistryEntry>();
  for (const entry of entries) {
    const key = versionKey(entry.recipe);
    if (byVersion.has(key)) {
      throw new DacsError(
        `recipe registry repeats (${entry.recipe.scheme}, v${entry.recipe.recipeVersion})`,
      );
    }
    byVersion.set(key, entry as AuthenticatedRecipeRegistryEntry);
  }

  // RA-3 allocates versions in one sequence per scheme, including across
  // families. `governance.acceptedAt` is inside the steward-signed recipe and
  // is the pinned schema's only authenticated publication-order signal. Equal
  // millisecond timestamps are possible, but a higher version accepted before
  // a lower version is a provable rollback and is therefore rejected.
  const schemeEntries = new Map<string, AuthenticatedRecipeRegistryEntry[]>();
  for (const entry of entries) {
    const values = schemeEntries.get(entry.recipe.scheme) ?? [];
    values.push(entry as AuthenticatedRecipeRegistryEntry);
    schemeEntries.set(entry.recipe.scheme, values);
  }
  for (const [scheme, values] of schemeEntries) {
    values.sort((left, right) =>
      left.recipe.recipeVersion - right.recipe.recipeVersion);
    for (let index = 1; index < values.length; index += 1) {
      const prior = values[index - 1]!.recipe;
      const current = values[index]!.recipe;
      if (current.governance.acceptedAt < prior.governance.acceptedAt) {
        throw new DacsError(
          `recipe scheme ${scheme} reverses signed acceptedAt ordering between ` +
            `v${prior.recipeVersion} and v${current.recipeVersion}`,
        );
      }
    }
  }

  const families = new Map<string, AuthenticatedRecipeRegistryEntry[]>();
  for (const entry of entries) {
    const key = familyKey(entry.recipe);
    const family = families.get(key) ?? [];
    family.push(entry as AuthenticatedRecipeRegistryEntry);
    families.set(key, family);
  }

  const heads = new Map<string, Readonly<AuthenticatedRecipeRegistryEntry>>();
  for (const [key, family] of families) {
    const roots = family.filter(
      (entry) => entry.recipe.governance.supersedes === undefined,
    );
    if (roots.length !== 1) {
      throw new DacsError(`recipe family ${key} has ${roots.length} roots`);
    }
    const successors = new Map<number, number>();
    for (const entry of family) {
      const supersedes = entry.recipe.governance.supersedes;
      if (supersedes === undefined) continue;
      const predecessor = byVersion.get(`${entry.recipe.scheme}\u0000${supersedes}`);
      if (!predecessor || familyKey(predecessor.recipe) !== key) {
        throw new DacsError(
          `recipe family ${key} supersedes a missing or cross-family version`,
        );
      }
      if (successors.has(supersedes)) {
        throw new DacsError(`recipe family ${key} has an ambiguous supersedes branch`);
      }
      successors.set(supersedes, entry.recipe.recipeVersion);
    }
    const candidates = family.filter(
      (entry) => !successors.has(entry.recipe.recipeVersion),
    );
    if (candidates.length !== 1) {
      throw new DacsError(`recipe family ${key} has ${candidates.length} heads`);
    }
    let visited = 0;
    let cursor = roots[0]!.recipe.recipeVersion;
    const seen = new Set<number>();
    while (!seen.has(cursor)) {
      seen.add(cursor);
      visited += 1;
      const next = successors.get(cursor);
      if (next === undefined) break;
      cursor = next;
    }
    const head = candidates[0]!;
    const maxVersion = Math.max(...family.map((entry) => entry.recipe.recipeVersion));
    if (
      visited !== family.length ||
      cursor !== head.recipe.recipeVersion ||
      head.recipe.recipeVersion !== maxVersion
    ) {
      throw new DacsError(`recipe family ${key} does not form one monotonic chain`);
    }
    heads.set(key, head);
  }

  const methodOwners = new Map<string, string>();
  for (const [key, head] of heads) {
    for (const method of methodKinds(head.recipe)) {
      const ownershipKey = `${head.recipe.scheme}\u0000${method}`;
      const existing = methodOwners.get(ownershipKey);
      if (existing !== undefined && existing !== key) {
        throw new DacsError(
          `active recipe families for ${head.recipe.scheme} overlap on method ${method}`,
        );
      }
      methodOwners.set(ownershipKey, key);
    }
  }
  return heads;
}

function registryProvenance(
  snapshot: AuthenticatedRecipeRegistrySnapshot,
): RecipeRegistryProvenance {
  return {
    logicalAddress: snapshot.logicalAddress,
    registryVersion: snapshot.registryVersion,
    index: snapshot.index,
    indexRef: snapshot.indexRef,
    indexContentHash: snapshot.indexContentHash,
    writer: snapshot.writer,
    receipt: snapshot.receipt,
  };
}

/** Runtime provenance guard; structural lookalikes and cloned values fail. */
export function isAuthenticatedRecipeRegistrySnapshot(
  value: unknown,
): value is AuthenticatedRecipeRegistrySnapshot {
  return isRecord(value) && authenticatedSnapshots.has(value);
}

/** Runtime guard distinguishing latest-at-session selection from historical reads. */
export function isLatestRecipeSelection(
  value: unknown,
): value is LatestRecipeSelection {
  return isRecord(value) && latestSelections.has(value);
}

export function isHistoricalRecipeResolution(
  value: unknown,
): value is HistoricalRecipeResolution {
  return isRecord(value) && historicalResolutions.has(value);
}

/**
 * Authenticate one complete current registry index and every recipe it names.
 * No entry is skipped: one malformed, unresolved, hash-mismatched, unsigned, or
 * non-steward recipe invalidates the snapshot and therefore cannot prove latest.
 */
export async function authenticateRecipeRegistrySnapshot(
  providerSource: RecipeRegistrySelectionProvider,
): Promise<AuthenticatedRecipeRegistrySnapshot> {
  const provider = captureProvider(providerSource);
  let rawCurrent: CurrentRecipeRegistryIndex | null;
  try {
    rawCurrent = await provider.resolveCurrentIndex(
      RECIPE_REGISTRY_INDEX_ADDRESS,
    );
  } catch (error) {
    throw new SubstrateError("recipe registry current-index lookup errored", {
      cause: error,
    });
  }
  if (rawCurrent === null) {
    throw new SubstrateError("recipe registry current-index lookup is unresolved");
  }
  if (!isCurrentIndex(rawCurrent)) {
    throw new DacsError("recipe registry current-index binding is malformed");
  }
  const current = immutableSnapshot(
    rawCurrent,
    "recipe registry current-index binding",
  );
  if (
    current.receipt.logicalAddress !== RECIPE_REGISTRY_INDEX_ADDRESS ||
    current.receipt.nativeAddress !== current.indexRef.anchor.locator ||
    current.receipt.contentHash !== current.indexRef.contentHash ||
    current.receipt.writer !== provider.stewardWriter ||
    current.receipt.state !== "finalized" ||
    current.receipt.observationDisposition !== "established"
  ) {
    throw new DacsError(
      "recipe registry index is not an exact finalized steward-owned binding",
    );
  }

  const rawIndex = await readExactJson(
    provider,
    current.indexRef,
    "recipe registry index",
  );
  if (!isIndexDocument(rawIndex)) {
    throw new DacsError("recipe registry index has an invalid operational shape");
  }
  const index = rawIndex as unknown as RecipeRegistryIndexDocument;
  const indexHash = contentHash(index as unknown as Record<string, unknown>);
  if (indexHash !== current.indexRef.contentHash) {
    throw new DacsError("recipe registry index readback hash does not match its ref");
  }
  assertUniqueIndexRefs(index);

  let authority: RecipeRegistryAuthorityVerification;
  try {
    authority = await provider.authenticateCurrentIndex(
      immutableSnapshot(
        {
          logicalAddress: RECIPE_REGISTRY_INDEX_ADDRESS,
          registryVersion: current.registryVersion,
          indexRef: current.indexRef,
          receipt: current.receipt,
          index,
        },
        "recipe registry authority input",
      ),
    );
  } catch (error) {
    throw new SubstrateError("recipe registry authority verification errored", {
      cause: error,
    });
  }
  if (authority === "indeterminate") {
    throw new SubstrateError("recipe registry authority is indeterminate");
  }
  if (authority !== "valid") {
    throw new DacsError("recipe registry authority is invalid or unauthenticated");
  }

  const entries: AuthenticatedRecipeRegistryEntry[] = [];
  for (const ref of index.entries) {
    const rawRecipe = await readExactJson(provider, ref, "recipe registry entry");
    if (!isRecipeDescriptor(rawRecipe)) {
      throw new DacsError("recipe registry entry has an invalid signed recipe shape");
    }
    const recipe = rawRecipe as unknown as SignedRecipe;
    const recipeHash = contentHash(recipe as unknown as Record<string, unknown>);
    if (recipeHash !== ref.contentHash) {
      throw new DacsError("recipe registry entry hash does not match its index ref");
    }
    await verifyStewardRecipe(recipe, provider);
    entries.push(
      immutableSnapshot({ ref, recipe }, "authenticated recipe registry entry"),
    );
  }
  assertFamilyGraph(entries);

  const snapshot = deepFreeze({
    logicalAddress: RECIPE_REGISTRY_INDEX_ADDRESS,
    registryVersion: current.registryVersion,
    index,
    indexRef: current.indexRef,
    indexContentHash: indexHash,
    writer: current.receipt.writer,
    receipt: current.receipt,
    entries,
  }) as unknown as AuthenticatedRecipeRegistrySnapshot;
  authenticatedSnapshots.add(snapshot);
  return snapshot;
}

function captureLatestSelector(selector: LatestRecipeSelector): LatestRecipeSelector {
  if (!exactOwnDataKeys(selector, ["scheme", "method", "required"])) {
    throw new DacsError("latest recipe selector must be exact");
  }
  const captured = immutableSnapshot(selector, "latest recipe selector");
  if (
    typeof captured.scheme !== "string" ||
    !/^[a-z][a-z0-9-]*$/.test(captured.scheme) ||
    typeof captured.method !== "string" ||
    !METHODS.has(captured.method) ||
    typeof captured.required !== "boolean"
  ) {
    throw new DacsError("latest recipe selector is malformed");
  }
  return captured;
}

function captureHistoricalSelector(selector: RecipeSelector): RecipeSelector {
  if (!exactOwnDataKeys(selector, ["scheme", "method", "recipeVersion"])) {
    throw new DacsError("historical recipe selector must be exact");
  }
  const captured = immutableSnapshot(selector, "historical recipe selector");
  if (
    typeof captured.scheme !== "string" ||
    !/^[a-z][a-z0-9-]*$/.test(captured.scheme) ||
    typeof captured.method !== "string" ||
    !METHODS.has(captured.method) ||
    !isPositiveSafeInt(captured.recipeVersion)
  ) {
    throw new DacsError("historical recipe selector is malformed");
  }
  return captured;
}

function requireSnapshot(
  snapshot: AuthenticatedRecipeRegistrySnapshot,
): AuthenticatedRecipeRegistrySnapshot {
  if (!isAuthenticatedRecipeRegistrySnapshot(snapshot)) {
    throw new DacsError("recipe selection requires an authenticated registry snapshot");
  }
  return snapshot;
}

/**
 * Select the family from authenticated current family heads, then use that
 * family's newest revision, then require the requested method on that exact
 * head. Historical revisions are never searched as a fallback.
 */
export function selectLatestRecipeAtSessionStart(
  snapshotSource: AuthenticatedRecipeRegistrySnapshot,
  selectorSource: LatestRecipeSelector,
): LatestRecipeSelection {
  const snapshot = requireSnapshot(snapshotSource);
  const selector = captureLatestSelector(selectorSource);
  const heads = assertFamilyGraph(snapshot.entries);
  const candidates = [...heads.values()].filter(
    (entry) =>
      entry.recipe.scheme === selector.scheme &&
      methodKinds(entry.recipe).includes(selector.method),
  );
  if (candidates.length === 0) {
    const historicalOwners = new Set(
      snapshot.entries
        .filter(
          (entry) =>
            entry.recipe.scheme === selector.scheme &&
            methodKinds(entry.recipe).includes(selector.method),
        )
        .map((entry) => familyKey(entry.recipe)),
    );
    if (historicalOwners.size > 0) {
      throw new DacsError(
        `requested method ${selector.method} was removed from its latest family head; refusing historical fallback`,
      );
    }
    throw new DacsError(
      `no current recipe family for (${selector.scheme}, ${selector.method})`,
    );
  }
  if (candidates.length !== 1) {
    throw new DacsError(
      `current recipe family for (${selector.scheme}, ${selector.method}) is ambiguous`,
    );
  }
  const selected = candidates[0]!;
  if (selected.recipe.availability === "disabled") {
    throw new DacsError("disabled recipe cannot start a new session");
  }
  if (selector.required && selected.recipe.governance.deprecated === true) {
    throw new DacsError("deprecated recipe cannot start required-claim verification");
  }
  const selection = deepFreeze({
    selectionKind: "latest-at-session-start",
    family: {
      scheme: selected.recipe.scheme,
      defaultMethod: selected.recipe.defaultMethod.kind,
    },
    requestedMethod: selector.method,
    required: selector.required,
    registry: registryProvenance(snapshot),
    recipeRef: selected.ref,
    recipeContentHash: selected.ref.contentHash,
    recipe: selected.recipe,
  }) as unknown as LatestRecipeSelection;
  latestSelections.add(selection);
  return selection;
}

/**
 * Resolve an explicitly pinned historical recipe from the same authenticated
 * snapshot. The distinct runtime brand prevents it from masquerading as proof
 * of latest-at-session selection.
 */
export function resolveHistoricalRecipeFromSnapshot(
  snapshotSource: AuthenticatedRecipeRegistrySnapshot,
  selectorSource: Readonly<RecipeSelector>,
): HistoricalRecipeResolution {
  const snapshot = requireSnapshot(snapshotSource);
  const selector = captureHistoricalSelector(selectorSource);
  const matches = snapshot.entries.filter(
    (entry) =>
      entry.recipe.scheme === selector.scheme &&
      entry.recipe.recipeVersion === selector.recipeVersion &&
      methodKinds(entry.recipe).includes(selector.method),
  );
  if (matches.length !== 1) {
    throw new DacsError(
      `historical recipe (${selector.scheme}, ${selector.method}, v${selector.recipeVersion}) resolved ${matches.length} entries`,
    );
  }
  const selected = matches[0]!;
  const resolution = deepFreeze({
    selectionKind: "explicit-historical",
    family: {
      scheme: selected.recipe.scheme,
      defaultMethod: selected.recipe.defaultMethod.kind,
    },
    requestedMethod: selector.method,
    registry: registryProvenance(snapshot),
    recipeRef: selected.ref,
    recipeContentHash: selected.ref.contentHash,
    recipe: selected.recipe,
  }) as unknown as HistoricalRecipeResolution;
  historicalResolutions.add(resolution);
  return resolution;
}

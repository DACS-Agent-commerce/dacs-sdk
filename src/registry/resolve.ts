import { DacsError } from "../errors.js";
import { type DomainSeparator } from "../crypto/index.js";
import { verifySignedArtifact, type Verifier } from "../agent/signedArtifact.js";
import {
  isComponentSignature,
  verifyComponentSignature,
} from "../artifacts/signatures.js";
import type { ComponentSignature } from "../artifacts/types.js";
import type {
  Availability,
  RailDescriptor,
  RecipeDescriptor,
  RecipeGovernance,
  RecipeSelector,
  VerificationMethod,
} from "./types.js";

/**
 * Resolve + pin a single registry entry by id. Per T12/T13 the SDK reads the
 * anchored registry, verifies the entry's steward signature (which is over its
 * content hash — so tampering or a non-steward signer fails), confirms it is
 * `live`, and returns the pinned descriptor. Anything off → throw, never a
 * silently-trusted entry.
 */

export interface RegistryResolveDeps {
  /** Read the anchored registry document at its address/name. */
  readRegistry: (anchor: string) => Promise<Record<string, unknown> | null>;
  /** The pinned steward (PA-2) public key — the registry's trust root. */
  stewardPublicKey: Uint8Array;
  /** The pinned steward claim that the ComponentSignature signer must name. */
  stewardSigner: string;
  /** Verify a signature over raw bytes for a public key. */
  verify: Verifier;
  /** Explicit opt-in for reading and normalising pre-ComponentSignature entries. */
  legacySignatures?: "reject" | "verify-with-pinned-key";
}

function hasId(e: unknown): e is { id: string; availability: string } {
  if (typeof e !== "object" || e === null) return false;
  const r = e as Record<string, unknown>;
  return (
    typeof r["id"] === "string" &&
    typeof r["availability"] === "string"
  );
}

async function resolveEntry<T extends { id: string; availability: Availability }>(
  anchor: string,
  id: string,
  separator: DomainSeparator,
  deps: RegistryResolveDeps,
  validate: (e: Record<string, unknown>) => boolean,
): Promise<T & { signature: ComponentSignature }> {
  const doc = await deps.readRegistry(anchor);
  if (!doc) {
    throw new DacsError(`registry not found at ${anchor}`);
  }
  const entries = doc["entries"];
  if (!Array.isArray(entries)) {
    throw new DacsError(`registry at ${anchor} has no entries array`);
  }

  const entry = entries.find((e) => hasId(e) && e.id === id);
  if (!entry) {
    throw new DacsError(`entry "${id}" not found in registry ${anchor}`);
  }

  // Trust root: a role-bound ComponentSignature must verify against the pinned
  // steward claim and key. Legacy hex strings are rejected by default; the
  // opt-in path authenticates and normalises them before returning.
  let verifiedEntry = entry as Record<string, unknown>;
  if (typeof verifiedEntry.signature === "string") {
    if (
      deps.legacySignatures !== "verify-with-pinned-key" ||
      !(await verifySignedArtifact(
        verifiedEntry,
        separator,
        deps.stewardPublicKey,
        deps.verify,
      ))
    ) {
      throw new DacsError(
        `entry "${id}" legacy signature is rejected or invalid under the steward key`,
      );
    }
    const legacyValue = verifiedEntry.signature;
    verifiedEntry = {
      ...verifiedEntry,
      signature: {
        algorithm: "ed25519",
        signer: deps.stewardSigner,
        value: Buffer.from(legacyValue, "hex").toString("base64url"),
      },
    };
  }

  const signed = await verifyComponentSignature(verifiedEntry, separator, {
    isSignerAuthorized: (_artifact, signature) =>
      signature.signer === deps.stewardSigner,
    resolvePublicKey: (signature) =>
      signature.algorithm === "ed25519" ? deps.stewardPublicKey : null,
    verify: ({ signedBytes, signature, publicKey }) =>
      deps.verify(
        signedBytes,
        Uint8Array.from(Buffer.from(signature.value, "base64url")),
        publicKey,
      ),
  });
  if (signed.status !== "valid") {
    throw new DacsError(
      `entry "${id}" signature is not valid under the steward key`,
    );
  }

  if (!validate(verifiedEntry)) {
    throw new DacsError(`entry "${id}" has an invalid descriptor shape`);
  }
  const descriptor = verifiedEntry as T & { signature: ComponentSignature };
  if (descriptor.availability !== "live") {
    throw new DacsError(
      `entry "${id}" is not live (availability=${descriptor.availability})`,
    );
  }
  return descriptor;
}

function isRailDescriptor(e: Record<string, unknown>): boolean {
  return (
    typeof e["id"] === "string" &&
    typeof e["kind"] === "string" &&
    typeof e["availability"] === "string" &&
    typeof e["params"] === "object" &&
    e["params"] !== null
  );
}

const authenticatedRecipes = new WeakSet<object>();
declare const authenticatedRecipeDescriptorBrand: unique symbol;

/**
 * A recipe whose exact wire shape and steward signature were checked by
 * {@link resolveRecipe}.  The private brand prevents a structurally-similar
 * caller object from satisfying producer APIs at compile time; runtime
 * provenance remains enforced by {@link isAuthenticatedRecipeDescriptor}.
 */
export type AuthenticatedRecipeDescriptor = RecipeDescriptor & {
  signature: ComponentSignature;
  readonly [authenticatedRecipeDescriptorBrand]: true;
};

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isSafeUint = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isPositiveSafeInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isCanonicalClaimReference = (value: unknown): value is string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.normalize("NFC") !== value ||
    /[\s\u0000-\u001f\u007f]/.test(value)
  ) {
    return false;
  }
  const colon = value.indexOf(":");
  if (colon <= 0 || !/^[a-z][a-z0-9-]*$/.test(value.slice(0, colon))) {
    return false;
  }
  const remainder = value.slice(colon + 1);
  const question = remainder.indexOf("?");
  const identifier = question < 0 ? remainder : remainder.slice(0, question);
  if (!identifier) return false;
  if (question < 0) return true;
  const query = remainder.slice(question + 1);
  if (!query) return false;
  const keys: string[] = [];
  for (const parameter of query.split("&")) {
    const equals = parameter.indexOf("=");
    if (equals <= 0 || equals !== parameter.lastIndexOf("=")) return false;
    const key = parameter.slice(0, equals);
    const entry = parameter.slice(equals + 1);
    if (
      !key ||
      /[:?]/.test(key) ||
      /[:?]/.test(entry) ||
      /%(?![0-9A-F]{2})/.test(key) ||
      /%(?![0-9A-F]{2})/.test(entry) ||
      keys.includes(key)
    ) {
      return false;
    }
    keys.push(key);
  }
  return keys.every((key, index) => index === 0 || keys[index - 1]! < key);
};

/**
 * Recipes are signed JSON wire records.  Do not let prototype properties,
 * accessors, symbols, non-enumerable fields or an explicitly-undefined
 * optional field pass a guard even though canonical JSON would omit them.
 */
function hasExactWireKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const allowed = [...required, ...optional];
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) return false;
    const keys = ownKeys as string[];
    if (!required.every((key) => keys.includes(key))) return false;
    if (!keys.every((key) => allowed.includes(key))) return false;
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor !== undefined &&
        descriptor.enumerable &&
        "value" in descriptor &&
        descriptor.value !== undefined
      );
    });
  } catch {
    return false;
  }
}

function isExactWireArray(
  value: unknown,
  validate: (entry: unknown) => boolean,
): value is unknown[] {
  if (!Array.isArray(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) {
      return false;
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        descriptor.value === undefined ||
        !validate(descriptor.value)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function isExactStringRecord(
  value: unknown,
): value is Record<string, string> {
  if (!isRecord(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor !== undefined &&
        descriptor.enumerable &&
        "value" in descriptor &&
        typeof descriptor.value === "string"
      );
    });
  } catch {
    return false;
  }
}

function isJsonWireValue(
  value: unknown,
  seen = new WeakSet<object>(),
): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return isExactWireArray(value, (entry) => isJsonWireValue(entry, seen));
    }
    if (!isRecord(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor !== undefined &&
        descriptor.enumerable &&
        "value" in descriptor &&
        descriptor.value !== undefined &&
        isJsonWireValue(descriptor.value, seen)
      );
    });
  } catch {
    return false;
  } finally {
    seen.delete(value);
  }
}

function isStringArray(value: unknown): value is string[] {
  return isExactWireArray(value, (entry) => typeof entry === "string");
}

function isVerificationMethod(value: unknown): value is VerificationMethod {
  if (!isRecord(value)) return false;
  const kindDescriptor = Object.getOwnPropertyDescriptor(value, "kind");
  if (
    kindDescriptor === undefined ||
    !kindDescriptor.enumerable ||
    !("value" in kindDescriptor) ||
    typeof kindDescriptor.value !== "string"
  ) {
    return false;
  }
  switch (kindDescriptor.value) {
    case "verifiable-credential":
      return (
        hasExactWireKeys(value, ["kind"], ["issuerAllowList", "schemaUrl"]) &&
        (value.issuerAllowList === undefined ||
          isStringArray(value.issuerAllowList)) &&
        (value.schemaUrl === undefined || typeof value.schemaUrl === "string")
      );
    case "tlsnotary":
      return (
        hasExactWireKeys(value, ["kind", "endpoint"], ["sessionTemplate"]) &&
        typeof value.endpoint === "string" &&
        (value.sessionTemplate === undefined || typeof value.sessionTemplate === "string")
      );
    case "zktls":
      return (
        hasExactWireKeys(value, ["kind", "provider", "programId"]) &&
        typeof value.provider === "string" &&
        typeof value.programId === "string"
      );
    case "consensus-backed-proxy":
      return (
        hasExactWireKeys(value, ["kind", "endpoint"]) &&
        hasExactWireKeys(value.endpoint, ["method", "urlTemplate"], ["headers", "body"]) &&
        (value.endpoint.method === "GET" || value.endpoint.method === "POST") &&
        typeof value.endpoint.urlTemplate === "string" &&
        (value.endpoint.headers === undefined ||
          isExactStringRecord(value.endpoint.headers)) &&
        (value.endpoint.body === undefined || typeof value.endpoint.body === "string")
      );
    case "oauth-attested":
      return (
        hasExactWireKeys(value, ["kind", "provider", "scopes", "maxTokenAgeSec"]) &&
        typeof value.provider === "string" &&
        isStringArray(value.scopes) &&
        isSafeUint(value.maxTokenAgeSec)
      );
    case "evm-rpc":
      return (
        hasExactWireKeys(value, ["kind", "chainId", "contract", "method"], ["args"]) &&
        isSafeUint(value.chainId) &&
        typeof value.contract === "string" &&
        typeof value.method === "string" &&
        (value.args === undefined ||
          isExactWireArray(value.args, (argument) => isJsonWireValue(argument)))
      );
    case "domain-tls-control":
      return (
        hasExactWireKeys(value, ["kind", "challengeType"]) &&
        (value.challengeType === "http-01" ||
          value.challengeType === "dns-01" ||
          value.challengeType === "tls-alpn-01")
      );
    case "self-signed":
    case "demos-gcr-domain":
      return hasExactWireKeys(value, ["kind"]);
    default:
      return false;
  }
}

type ParserFormat = "json" | "html" | "xml" | "raw";

function isIndeterminatePredicate(
  value: unknown,
  format: ParserFormat,
): boolean {
  const field =
    format === "json"
      ? "jsonPath"
      : format === "html"
        ? "selector"
        : format === "xml"
          ? "xPath"
          : "matcher";
  return hasExactWireKeys(value, [field]) && typeof value[field] === "string";
}

function isParserSpec(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const formatDescriptor = Object.getOwnPropertyDescriptor(value, "format");
  if (
    formatDescriptor === undefined ||
    !formatDescriptor.enumerable ||
    !("value" in formatDescriptor)
  ) {
    return false;
  }
  const format = formatDescriptor.value;
  if (format !== "json" && format !== "html" && format !== "xml" && format !== "raw") {
    return false;
  }
  const predicateField =
    format === "json"
      ? "successJsonPath"
      : format === "html"
        ? "successSelector"
        : format === "xml"
          ? "successXPath"
          : "matcher";
  const optional =
    format === "raw"
      ? ["indeterminateOn"]
      : ["indeterminateOn", "dataMap"];
  return (
    hasExactWireKeys(value, ["format", predicateField], optional) &&
    typeof value[predicateField] === "string" &&
    (value.indeterminateOn === undefined ||
      isExactWireArray(value.indeterminateOn, (predicate) =>
        isIndeterminatePredicate(predicate, format),
      )) &&
    (format === "raw" ||
      value.dataMap === undefined ||
      isExactStringRecord(value.dataMap))
  );
}

function hasUniqueVerificationMethodKinds(
  defaultMethod: VerificationMethod,
  alternatives: VerificationMethod[] | undefined,
): boolean {
  const methods = [defaultMethod, ...(alternatives ?? [])];
  const kinds = methods.map((method) => method.kind);
  return new Set(kinds).size === kinds.length;
}

function isBackoff(value: unknown): boolean {
  return (
    hasExactWireKeys(value, ["strategy"], ["baseMs"]) &&
    (value.strategy === "exponential" || value.strategy === "fixed") &&
    (value.baseMs === undefined || isSafeUint(value.baseMs))
  );
}

function isEmergencyGovernance(value: unknown): boolean {
  return (
    hasExactWireKeys(value, ["isEmergency", "failureObservation"]) &&
    value.isEmergency === true &&
    typeof value.failureObservation === "string"
  );
}

function isGovernance(value: unknown): value is RecipeGovernance {
  if (
    !hasExactWireKeys(
      value,
      ["proposedBy", "acceptedAt", "anchoring"],
      [
        "supersedes",
        "emergency",
        "deprecated",
        "deprecationReason",
      ],
    )
  ) {
    return false;
  }
  return (
    isCanonicalClaimReference(value.proposedBy) &&
    isSafeUint(value.acceptedAt) &&
    (value.anchoring === "in-code" ||
      value.anchoring === "single-signer" ||
      value.anchoring === "multisig") &&
    (value.supersedes === undefined || isPositiveSafeInt(value.supersedes)) &&
    (value.emergency === undefined || isEmergencyGovernance(value.emergency)) &&
    (value.deprecated === undefined || typeof value.deprecated === "boolean") &&
    (value.deprecationReason === undefined ||
      typeof value.deprecationReason === "string") &&
    (value.deprecated !== true ||
      (typeof value.deprecationReason === "string" &&
        value.deprecationReason.length > 0))
  );
}

const AVAILABILITIES: ReadonlySet<string> = new Set([
  "live",
  "operator_gated",
  "closed_data",
  "bilateral",
  "mocked",
  "disabled",
  "failed",
]);

function isExactComponentSignature(value: unknown): boolean {
  return (
    hasExactWireKeys(value, ["algorithm", "signer", "value"]) &&
    isComponentSignature(value) &&
    isCanonicalClaimReference(value.signer)
  );
}

export function isRecipeDescriptor(
  e: Record<string, unknown>,
): e is Record<string, unknown> & RecipeDescriptor & {
  signature: ComponentSignature;
} {
  if (
    !hasExactWireKeys(
      e,
      [
        "recipeVersion",
        "scheme",
        "defaultMethod",
        "defaultMaxAgeSec",
        "parserRules",
        "retryClass",
        "availability",
        "governance",
        "signature",
      ],
      [
        "alternatives",
        "negativeMatch",
        "retryOnIndeterminate",
        "retryBudget",
        "backoff",
      ],
    )
  ) {
    return false;
  }
  if (!isVerificationMethod(e.defaultMethod)) return false;
  const alternatives =
    e.alternatives === undefined
      ? undefined
      : isExactWireArray(e.alternatives, isVerificationMethod)
        ? (e.alternatives as VerificationMethod[])
        : null;
  if (alternatives === null) return false;
  return (
    isPositiveSafeInt(e.recipeVersion) &&
    typeof e.scheme === "string" &&
    /^[a-z][a-z0-9-]*$/.test(e.scheme) &&
    hasUniqueVerificationMethodKinds(e.defaultMethod, alternatives) &&
    isSafeUint(e.defaultMaxAgeSec) &&
    isParserSpec(e.parserRules) &&
    (e.negativeMatch === undefined || typeof e.negativeMatch === "boolean") &&
    (e.retryClass === "transient" || e.retryClass === "permanent") &&
    (e.retryOnIndeterminate === undefined ||
      typeof e.retryOnIndeterminate === "boolean") &&
    (e.retryBudget === undefined || isSafeUint(e.retryBudget)) &&
    (e.backoff === undefined || isBackoff(e.backoff)) &&
    typeof e.availability === "string" &&
    AVAILABILITIES.has(e.availability) &&
    isGovernance(e.governance) &&
    (e.governance.supersedes === undefined ||
      e.governance.supersedes < e.recipeVersion) &&
    isExactComponentSignature(e.signature)
  );
}

/** Internal runtime provenance check used by the current DACS-2 producer. */
export function isAuthenticatedRecipeDescriptor(
  value: unknown,
): value is AuthenticatedRecipeDescriptor {
  return isRecord(value) && authenticatedRecipes.has(value);
}

/** Resolve + pin a live, steward-signed rail descriptor from the rail registry. */
export function resolveRail(
  anchor: string,
  id: string,
  deps: RegistryResolveDeps,
): Promise<RailDescriptor & { signature: ComponentSignature }> {
  return resolveEntry(anchor, id, "dacs-rail:v1:", deps, isRailDescriptor);
}

/**
 * Resolve and pin one exact steward-signed DACS-2 recipe family/version.
 * Unlike rails, recipes in a non-live state remain resolvable for RAV-2/RAV-3
 * audit; the Vet producer decides whether that state may run or must become
 * `error`.
 */
export async function resolveRecipe(
  anchor: string,
  selector: Readonly<RecipeSelector>,
  deps: RegistryResolveDeps,
): Promise<AuthenticatedRecipeDescriptor> {
  if (
    !hasExactWireKeys(
      selector as unknown,
      ["scheme", "method", "recipeVersion"],
    )
  ) {
    throw new DacsError(
      "recipe selector must be an exact canonical scheme, method and version",
    );
  }
  let selected: RecipeSelector;
  try {
    selected = deepFreeze(structuredClone(selector));
  } catch {
    throw new DacsError("recipe selector is not snapshot-safe");
  }
  if (
    typeof selected.scheme !== "string" ||
    !/^[a-z][a-z0-9-]*$/.test(selected.scheme) ||
    typeof selected.method !== "string" ||
    !isPositiveSafeInt(selected.recipeVersion)
  ) {
    throw new DacsError("recipe selector must bind a canonical scheme, method and version");
  }
  const readRegistry = deps.readRegistry.bind(deps);
  const verify = deps.verify.bind(deps);
  const stewardSigner = deps.stewardSigner;
  const stewardPublicKey = Uint8Array.from(deps.stewardPublicKey);
  let doc: Record<string, unknown> | null;
  try {
    doc = await readRegistry(anchor);
  } catch {
    doc = null;
  }
  if (!doc) throw new DacsError(`registry not found at ${anchor}`);
  const entriesDescriptor = Object.getOwnPropertyDescriptor(doc, "entries");
  const entries = entriesDescriptor?.value;
  if (
    entriesDescriptor === undefined ||
    !entriesDescriptor.enumerable ||
    !("value" in entriesDescriptor) ||
    !isExactWireArray(entries, () => true)
  ) {
    throw new DacsError(`registry at ${anchor} has no entries array`);
  }
  const matches: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    // Validate the callback-owned value before cloning it: structuredClone
    // deliberately normalises prototypes/accessors and would otherwise turn a
    // hostile non-wire descriptor into an apparently-valid plain object.
    if (!isRecord(entry) || !isRecipeDescriptor(entry)) continue;
    const methods = [entry.defaultMethod, ...(entry.alternatives ?? [])];
    if (
      entry.scheme === selected.scheme &&
      entry.recipeVersion === selected.recipeVersion &&
      methods.some((method) => method.kind === selected.method)
    ) {
      matches.push(entry);
    }
  }
  const exactMatches = matches.filter(
    (entry) => entry.recipeVersion === selected.recipeVersion,
  );
  if (exactMatches.length !== 1) {
    throw new DacsError(
      `recipe (${selected.scheme}, ${selected.method}, ` +
        `v${selected.recipeVersion}) ` +
        `resolved ${exactMatches.length} exact entries; unambiguous family required`,
    );
  }
  let candidate: Record<string, unknown>;
  try {
    candidate = deepFreeze(structuredClone(exactMatches[0]!));
  } catch {
    throw new DacsError("matched recipe is not snapshot-safe");
  }
  if (!isRecipeDescriptor(candidate)) {
    throw new DacsError("matched recipe changed during snapshot");
  }
  const signed = await verifyComponentSignature(candidate, "dacs-recipe:v1:", {
    isSignerAuthorized: (_artifact, signature) =>
      signature.signer === stewardSigner,
    resolvePublicKey: (signature) =>
      signature.algorithm === "ed25519" ? Uint8Array.from(stewardPublicKey) : null,
    verify: async ({ signedBytes, signature, publicKey }) =>
      (await verify(
        Uint8Array.from(signedBytes),
        Uint8Array.from(Buffer.from(signature.value, "base64url")),
        Uint8Array.from(publicKey),
      )) === true,
  });
  if (signed.status !== "valid") {
    throw new DacsError("recipe signature is not valid under the steward key");
  }
  const descriptor = candidate as unknown as AuthenticatedRecipeDescriptor;
  authenticatedRecipes.add(descriptor);
  return descriptor;
}

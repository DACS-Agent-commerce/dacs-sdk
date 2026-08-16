import { types as nodeTypes } from "node:util";

import { DacsError } from "../errors.js";
import { type DomainSeparator } from "../crypto/index.js";
import { verifySignedArtifact, type Verifier } from "../agent/signedArtifact.js";
import {
  isComponentSignature,
  verifyComponentSignature,
} from "../artifacts/signatures.js";
import type { ComponentSignature } from "../artifacts/types.js";
import {
  isSafeJsonString,
  snapshotCanonicalJsonObject,
} from "../canonical/snapshot.js";
import type {
  AssetSpec,
  Availability,
  NetworkSpec,
  RailDefinition,
  RailGovernance,
  RailSelector,
  RailType,
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

interface CapturedRegistryResolveDeps {
  readRegistry: RegistryResolveDeps["readRegistry"];
  stewardPublicKey: Uint8Array;
  stewardSigner: string;
  verify: Verifier;
  legacySignatures: RegistryResolveDeps["legacySignatures"];
}

function captureRegistryResolveDeps(
  deps: RegistryResolveDeps,
): CapturedRegistryResolveDeps {
  try {
    const readRegistryCandidate: unknown = deps.readRegistry;
    const stewardPublicKeyCandidate: unknown = deps.stewardPublicKey;
    const stewardSignerCandidate: unknown = deps.stewardSigner;
    const verifyCandidate: unknown = deps.verify;
    const legacySignatures = deps.legacySignatures;
    if (typeof readRegistryCandidate !== "function") {
      throw new TypeError("readRegistry must be a function");
    }
    if (
      stewardPublicKeyCandidate === null ||
      typeof stewardPublicKeyCandidate !== "object" ||
      nodeTypes.isProxy(stewardPublicKeyCandidate) ||
      !nodeTypes.isUint8Array(stewardPublicKeyCandidate)
    ) {
      throw new TypeError("stewardPublicKey must be a 32-byte Uint8Array");
    }
    const stewardPublicKey = new Uint8Array(stewardPublicKeyCandidate);
    if (stewardPublicKey.byteLength !== 32) {
      throw new TypeError("stewardPublicKey must be a 32-byte Uint8Array");
    }
    if (
      typeof stewardSignerCandidate !== "string" ||
      stewardSignerCandidate.length === 0 ||
      stewardSignerCandidate.trim() !== stewardSignerCandidate ||
      !isSafeJsonString(stewardSignerCandidate)
    ) {
      throw new TypeError("stewardSigner must be a valid non-empty JSON string");
    }
    if (typeof verifyCandidate !== "function") {
      throw new TypeError("verify must be a function");
    }
    if (
      legacySignatures !== undefined &&
      legacySignatures !== "reject" &&
      legacySignatures !== "verify-with-pinned-key"
    ) {
      throw new TypeError("legacySignatures is not a supported policy");
    }

    return {
      readRegistry: Function.prototype.bind.call(
        readRegistryCandidate,
        deps,
      ) as RegistryResolveDeps["readRegistry"],
      stewardPublicKey,
      stewardSigner: stewardSignerCandidate.normalize("NFC"),
      verify: Function.prototype.bind.call(
        verifyCandidate,
        deps,
      ) as Verifier,
      legacySignatures,
    };
  } catch (cause) {
    throw new DacsError("invalid registry resolver dependencies", { cause });
  }
}

async function verifyWithCapturedDeps(
  verify: Verifier,
  bytes: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): Promise<boolean> {
  const result = await verify(
    Uint8Array.from(bytes),
    Uint8Array.from(signature),
    Uint8Array.from(publicKey),
  );
  return result === true;
}

function hasRailId(
  e: unknown,
): e is { railId: string } {
  if (typeof e !== "object" || e === null) return false;
  const r = e as Record<string, unknown>;
  return typeof r["railId"] === "string";
}

async function resolveEntry<
  T extends { railId: string; availability: Availability },
>(
  anchor: string,
  id: string,
  version: number | undefined,
  separator: DomainSeparator,
  deps: RegistryResolveDeps,
  validate: (e: Record<string, unknown>) => boolean,
): Promise<T & { signature: ComponentSignature }> {
  // Pin all trust-root configuration and callback implementations before the
  // registry reader is entered. A delayed read must not let the caller swap
  // the steward identity, key bytes, policy, or verifier mid-resolution.
  const captured = captureRegistryResolveDeps(deps);
  if (
    typeof anchor !== "string" ||
    anchor.length === 0 ||
    anchor.trim() !== anchor ||
    !isSafeJsonString(anchor) ||
    typeof id !== "string" ||
    id.length === 0 ||
    id.trim() !== id ||
    !isSafeJsonString(id)
  ) {
    throw new DacsError("registry anchor and entry id must be valid non-empty JSON strings");
  }
  const pinnedAnchor = anchor.normalize("NFC");
  const pinnedId = id.normalize("NFC");
  const readResult = await captured.readRegistry(pinnedAnchor);
  if (!readResult) {
    throw new DacsError(`registry not found at ${pinnedAnchor}`);
  }
  const doc = snapshotCanonicalJsonObject(
    readResult,
    `registry at ${pinnedAnchor}`,
  );
  const entries = doc["entries"];
  if (!Array.isArray(entries)) {
    throw new DacsError(`registry at ${pinnedAnchor} has no entries array`);
  }

  const family = entries.filter(
    (entry) => hasRailId(entry) && entry.railId === pinnedId,
  );
  if (family.length === 0) {
    throw new DacsError(
      `entry "${pinnedId}" not found in registry ${pinnedAnchor}`,
    );
  }
  if (
    family.some((candidate) => {
      const railVersion = (candidate as Record<string, unknown>)["railVersion"];
      return !isPositiveSafeInt(railVersion);
    })
  ) {
    throw new DacsError(
      `entry family "${pinnedId}" contains an invalid railVersion`,
    );
  }
  const authenticate = async (
    candidate: unknown,
  ): Promise<T & { signature: ComponentSignature }> => {
    // Trust root: a role-bound ComponentSignature must verify against the
    // pinned steward claim and key. Legacy hex strings are rejected by
    // default; the opt-in path authenticates and normalises them first.
    let verifiedEntry = candidate as Record<string, unknown>;
    if (typeof verifiedEntry.signature === "string") {
      if (
        captured.legacySignatures !== "verify-with-pinned-key" ||
        !(await verifySignedArtifact(
          verifiedEntry,
          separator,
          Uint8Array.from(captured.stewardPublicKey),
          (bytes, signature, publicKey) =>
            verifyWithCapturedDeps(
              captured.verify,
              bytes,
              signature,
              publicKey,
            ),
        ))
      ) {
        throw new DacsError(
          `entry "${pinnedId}" legacy signature is rejected or invalid under the steward key`,
        );
      }
      const legacyValue = verifiedEntry.signature;
      verifiedEntry = {
        ...verifiedEntry,
        signature: {
          algorithm: "ed25519",
          signer: captured.stewardSigner,
          value: Buffer.from(legacyValue, "hex").toString("base64url"),
        },
      };
    }

    const signed = await verifyComponentSignature(verifiedEntry, separator, {
      isSignerAuthorized: (_artifact, signature) =>
        signature.signer === captured.stewardSigner,
      resolvePublicKey: (signature) =>
        signature.algorithm === "ed25519"
          ? Uint8Array.from(captured.stewardPublicKey)
          : null,
      verify: ({ signedBytes, signature, publicKey }) =>
        verifyWithCapturedDeps(
          captured.verify,
          signedBytes,
          Uint8Array.from(Buffer.from(signature.value, "base64url")),
          publicKey,
        ),
    });
    if (signed.status !== "valid") {
      throw new DacsError(
        `entry "${pinnedId}" signature is not valid under the steward key`,
      );
    }
    if (!validate(verifiedEntry)) {
      throw new DacsError(`entry "${pinnedId}" has an invalid descriptor shape`);
    }
    const definition = verifiedEntry as unknown as RailDefinition;
    if (definition.governance.anchoring !== "single-signer") {
      // This resolver's explicit trust root is the pinned PA-2 steward key.
      // It has no in-code provenance or multisig quorum proof to authenticate
      // PA-1/PA-3, so those otherwise normative variants fail closed.
      throw new DacsError(
        `entry "${pinnedId}" uses unsupported anchoring phase ${definition.governance.anchoring}; this resolver operates PA-2 single-signer`,
      );
    }
    return verifiedEntry as T & { signature: ComponentSignature };
  };

  // RD-3, RD-4 and RD-6 are family invariants, not selected-entry invariants.
  // Authenticate every same-id version before it can influence latest-version
  // selection, then require one monotonic, unbranched supersession chain whose
  // phase handler never changes.
  const authenticatedFamily: Array<T & { signature: ComponentSignature }> = [];
  for (const candidate of family) {
    authenticatedFamily.push(await authenticate(candidate));
  }
  authenticatedFamily.sort((left, right) =>
    (left as unknown as RailDefinition).railVersion -
    (right as unknown as RailDefinition).railVersion);
  for (let index = 0; index < authenticatedFamily.length; index += 1) {
    const current = authenticatedFamily[index] as unknown as RailDefinition;
    const prior = index === 0
      ? undefined
      : authenticatedFamily[index - 1] as unknown as RailDefinition;
    if (
      prior !== undefined &&
      current.railVersion === prior.railVersion
    ) {
      throw new DacsError(
        `entry family "${pinnedId}" has duplicate version ${current.railVersion}`,
      );
    }
    const first = authenticatedFamily[0] as unknown as RailDefinition;
    if (current.phaseHandler !== first.phaseHandler) {
      throw new DacsError(
        `entry family "${pinnedId}" changes phaseHandler across versions (RD-6)`,
      );
    }
    if (prior === undefined) {
      if (current.governance.supersedes !== undefined) {
        throw new DacsError(
          `entry family "${pinnedId}" starts by superseding a missing version`,
        );
      }
      continue;
    }
    if (current.governance.supersedes !== prior.railVersion) {
      throw new DacsError(
        `entry family "${pinnedId}" does not form one monotonic supersession chain (RD-3/RD-4)`,
      );
    }
    if (current.governance.acceptedAt < prior.governance.acceptedAt) {
      throw new DacsError(
        `entry family "${pinnedId}" reverses signed acceptedAt ordering`,
      );
    }
  }

  const selectedVersion = version ??
    (authenticatedFamily.at(-1) as unknown as RailDefinition).railVersion;
  const selected = authenticatedFamily.filter(
    (candidate) =>
      (candidate as unknown as RailDefinition).railVersion === selectedVersion,
  );
  if (selected.length !== 1) {
    throw new DacsError(
      `entry family "${pinnedId}" resolved ${selected.length} definitions at version ${selectedVersion}; exactly one is required`,
    );
  }
  return selected[0]!;
}

const authenticatedRails = new WeakSet<object>();
declare const authenticatedRailDefinitionBrand: unique symbol;

/**
 * A DACS-4 §9.4.1 definition whose exact wire shape and steward signature were
 * checked by {@link resolveRail}. The private brand prevents structural caller
 * data from reaching the money path; the WeakSet enforces RAV-R5 at runtime.
 */
export type AuthenticatedRailDefinition = RailDefinition & {
  readonly [authenticatedRailDefinitionBrand]: true;
};

/** Runtime RAV-R5 provenance check for a resolved rail definition. */
export function isAuthenticatedRailDefinition(
  value: unknown,
): value is AuthenticatedRailDefinition {
  return isRecord(value) && authenticatedRails.has(value);
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
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  !nodeTypes.isProxy(value);
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
  if (!Array.isArray(value) || nodeTypes.isProxy(value)) return false;
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

const RAIL_TYPES: ReadonlySet<string> = new Set([
  "evm-erc20",
  "solana-spl",
  "cross-chain-htlc",
  "cross-chain-liquidity-tank",
  "ap2",
  "x402",
  "demos-native",
]);

const RAIL_PHASE_BY_TYPE: Readonly<Record<RailType, string>> = Object.freeze({
  "evm-erc20": "pay-evm-erc20",
  "solana-spl": "pay-solana-spl",
  "cross-chain-htlc": "pay-cross-chain-htlc",
  "cross-chain-liquidity-tank": "pay-cross-chain-liquidity-tank",
  ap2: "pay-ap2",
  x402: "pay-x402",
  "demos-native": "pay-dem",
});

const isNonEmptyWireString = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.normalize("NFC") === value &&
  isSafeJsonString(value);

const isCluster = (
  value: unknown,
): value is "mainnet" | "devnet" | "testnet" =>
  value === "mainnet" || value === "devnet" || value === "testnet";

function isChainIdentifier(value: unknown): value is number | string {
  return isPositiveSafeInt(value) || isNonEmptyWireString(value);
}

function isCrossChainRoute(value: unknown): value is {
  sourceChainId: number | string;
  destChainId: number | string;
  htlcContracts?: { source: string; dest: string };
  liquidityTankIds?: string[];
} {
  if (
    !hasExactWireKeys(
      value,
      ["sourceChainId", "destChainId"],
      ["htlcContracts", "liquidityTankIds"],
    ) ||
    !isChainIdentifier(value.sourceChainId) ||
    !isChainIdentifier(value.destChainId)
  ) {
    return false;
  }
  if (
    value.htlcContracts !== undefined &&
    (!hasExactWireKeys(value.htlcContracts, ["source", "dest"]) ||
      !isNonEmptyWireString(value.htlcContracts.source) ||
      !isNonEmptyWireString(value.htlcContracts.dest))
  ) {
    return false;
  }
  return (
    value.liquidityTankIds === undefined ||
    isExactWireArray(value.liquidityTankIds, isNonEmptyWireString)
  );
}

function isAssetSpec(value: unknown): value is AssetSpec {
  if (!isRecord(value)) return false;
  const kind = value.kind;
  switch (kind) {
    case "erc20":
      return (
        hasExactWireKeys(value, [
          "kind",
          "chainId",
          "contract",
          "symbol",
          "decimals",
        ]) &&
        isPositiveSafeInt(value.chainId) &&
        isNonEmptyWireString(value.contract) &&
        isNonEmptyWireString(value.symbol) &&
        isSafeUint(value.decimals)
      );
    case "spl":
      return (
        hasExactWireKeys(value, [
          "kind",
          "cluster",
          "mint",
          "symbol",
          "decimals",
        ]) &&
        isCluster(value.cluster) &&
        isNonEmptyWireString(value.mint) &&
        isNonEmptyWireString(value.symbol) &&
        isSafeUint(value.decimals)
      );
    case "native-evm":
      return (
        hasExactWireKeys(value, ["kind", "chainId", "symbol", "decimals"]) &&
        isPositiveSafeInt(value.chainId) &&
        isNonEmptyWireString(value.symbol) &&
        isSafeUint(value.decimals)
      );
    case "native-solana":
      return (
        hasExactWireKeys(value, ["kind", "cluster", "symbol", "decimals"]) &&
        isCluster(value.cluster) &&
        value.symbol === "SOL" &&
        value.decimals === 9
      );
    case "native-dem":
      return (
        hasExactWireKeys(value, ["kind", "symbol", "decimals"]) &&
        value.symbol === "DEM" &&
        value.decimals === 9
      );
    case "fiat-via-ap2":
      return (
        hasExactWireKeys(value, ["kind", "isoCurrency", "provider"]) &&
        isNonEmptyWireString(value.isoCurrency) &&
        isNonEmptyWireString(value.provider)
      );
    case "stablecoin-cross-chain":
      return (
        hasExactWireKeys(value, ["kind", "canonicalSymbol", "routes"]) &&
        isNonEmptyWireString(value.canonicalSymbol) &&
        isExactWireArray(value.routes, isCrossChainRoute)
      );
    default:
      return false;
  }
}

function isNetworkSpec(value: unknown): value is NetworkSpec {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "evm":
      return (
        hasExactWireKeys(value, ["kind", "chainId", "rpcAttestation"]) &&
        isPositiveSafeInt(value.chainId) &&
        (value.rpcAttestation === "consensus-backed-proxy" ||
          value.rpcAttestation === "evm-rpc")
      );
    case "solana":
      return (
        hasExactWireKeys(value, ["kind", "cluster"]) &&
        isCluster(value.cluster)
      );
    case "demos":
      return hasExactWireKeys(value, ["kind"]);
    case "ap2-provider":
      return (
        hasExactWireKeys(value, ["kind", "providerEndpoint"]) &&
        isNonEmptyWireString(value.providerEndpoint)
      );
    case "x402-resource":
      return (
        hasExactWireKeys(value, ["kind", "resourceBaseUrl"]) &&
        isNonEmptyWireString(value.resourceBaseUrl)
      );
    case "cross-chain":
      return (
        hasExactWireKeys(value, ["kind", "mechanism"]) &&
        (value.mechanism === "htlc" ||
          value.mechanism === "liquidity-tank" ||
          value.mechanism === "substrate-native")
      );
    default:
      return false;
  }
}

function railTypeMatchesAssetAndNetwork(
  railType: RailType,
  asset: AssetSpec,
  network: NetworkSpec,
): boolean {
  switch (railType) {
    case "evm-erc20":
      return (
        asset.kind === "erc20" &&
        network.kind === "evm" &&
        asset.chainId === network.chainId
      );
    case "solana-spl":
      return (
        asset.kind === "spl" &&
        network.kind === "solana" &&
        asset.cluster === network.cluster
      );
    case "cross-chain-htlc":
      return (
        asset.kind === "stablecoin-cross-chain" &&
        network.kind === "cross-chain" &&
        network.mechanism === "htlc"
      );
    case "cross-chain-liquidity-tank":
      return (
        asset.kind === "stablecoin-cross-chain" &&
        network.kind === "cross-chain" &&
        (network.mechanism === "liquidity-tank" ||
          network.mechanism === "substrate-native")
      );
    case "ap2":
      return asset.kind === "fiat-via-ap2" && network.kind === "ap2-provider";
    case "x402":
      return asset.kind === "erc20" && network.kind === "x402-resource";
    case "demos-native":
      return asset.kind === "native-dem" && network.kind === "demos";
  }
}

function isRailDefinition(
  e: Record<string, unknown>,
): e is Record<string, unknown> & RailDefinition {
  if (
    !hasExactWireKeys(e, [
      "railVersion",
      "railId",
      "railType",
      "asset",
      "network",
      "phaseHandler",
      "parameters",
      "availability",
      "governance",
      "signature",
    ]) ||
    !isPositiveSafeInt(e.railVersion) ||
    typeof e.railId !== "string" ||
    // §9.4.1 says lowercase, but its normative v0.1 registry identifiers use
    // uppercase asset symbols (for example `evm-erc20:8453:USDC`). Preserve
    // those canonical ASCII identifiers byte-for-byte while rejecting every
    // non-ASCII or whitespace form.
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(e.railId) ||
    typeof e.railType !== "string" ||
    !RAIL_TYPES.has(e.railType) ||
    !isAssetSpec(e.asset) ||
    !isNetworkSpec(e.network) ||
    !isRecord(e.parameters) ||
    !isJsonWireValue(e.parameters) ||
    typeof e.availability !== "string" ||
    !AVAILABILITIES.has(e.availability) ||
    !isGovernance(e.governance) ||
    !isExactComponentSignature(e.signature)
  ) {
    return false;
  }
  const railType = e.railType as RailType;
  const governance = e.governance as RailGovernance;
  return (
    e.phaseHandler === RAIL_PHASE_BY_TYPE[railType] &&
    railTypeMatchesAssetAndNetwork(
      railType,
      e.asset as AssetSpec,
      e.network as NetworkSpec,
    ) &&
    (governance.supersedes === undefined ||
      governance.supersedes < (e.railVersion as number))
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

/**
 * Resolve and pin one exact steward-signed DACS-4 §9.4.1 rail definition.
 * Availability is deliberately preserved: RAV-R1..RAV-R3 are point-of-use
 * policy, while RAV-R5 requires this authenticated definition as their source.
 */
export async function resolveRail(
  anchor: string,
  selector: string | Readonly<RailSelector>,
  deps: RegistryResolveDeps,
): Promise<AuthenticatedRailDefinition> {
  let railId: string;
  let railVersion: number | undefined;
  if (typeof selector === "string") {
    railId = selector;
  } else {
    if (
      !hasExactWireKeys(selector, ["railId"], ["railVersion"]) ||
      typeof selector.railId !== "string" ||
      (selector.railVersion !== undefined &&
        !isPositiveSafeInt(selector.railVersion))
    ) {
      throw new DacsError(
        "rail selector must carry an exact railId and optional positive railVersion",
      );
    }
    railId = selector.railId;
    railVersion = selector.railVersion;
  }
  const descriptor = await resolveEntry<RailDefinition>(
    anchor,
    railId,
    railVersion,
    "dacs-rail:v1:",
    deps,
    isRailDefinition,
  );
  const pinned = deepFreeze(descriptor);
  authenticatedRails.add(pinned);
  return pinned as AuthenticatedRailDefinition;
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

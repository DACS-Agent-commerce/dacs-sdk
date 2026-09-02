import { types as nodeTypes } from "node:util";

import { DacsError, SubstrateError } from "../errors.js";
import { verifySignedArtifact, type Verifier } from "../agent/signedArtifact.js";
import {
  isComponentSignature,
  verifyComponentSignature,
} from "../artifacts/signatures.js";
import type {
  AnchorReceipt,
  AttestationAnchor,
  ComponentSignature,
} from "../artifacts/types.js";
import {
  isAttestationRef,
  isReadableAnchorReceipt,
} from "../artifacts/validators.js";
import { contentHash } from "../canonical/index.js";
import {
  isSafeJsonString,
  snapshotCanonicalJsonObject,
  snapshotCanonicalJsonRead,
} from "../canonical/snapshot.js";
import {
  isCanonicalClaimReference,
  sameCanonicalClaimIdentity,
} from "../identity/claimReference.js";
import type {
  AssetSpec,
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

/** Stable DACS-4 v0.x rail-registry index address (§9.4.2/§9.4.3). */
export const RAIL_REGISTRY_INDEX_ADDRESS = "dacs4:registry:v0.1" as const;

/** Exact content-addressed rail reference carried by the canonical index. */
export interface RailRegistryDefinitionRef {
  /** Canonical SR-2 logical address published by the authenticated index. */
  logicalAddress: string;
  anchor: AttestationAnchor;
  contentHash: string;
}

/**
 * Canonical operational index projection. The Standard does not currently
 * define a signed index wire artifact, so authority comes from the separately
 * authenticated current SR-2 binding below, never from this shape alone.
 */
export interface RailRegistryIndexDocument {
  registryId: typeof RAIL_REGISTRY_INDEX_ADDRESS;
  entries: RailRegistryDefinitionRef[];
}

/** Exact current binding discovered at the canonical mutable index address. */
export interface CurrentRailRegistryIndex {
  registryVersion: number;
  indexRef: RailRegistryDefinitionRef;
  receipt: AnchorReceipt;
}

export type RailRegistryAuthorityVerification =
  | "valid"
  | "invalid"
  | "indeterminate";

/** Exact current-index facts passed to the binding-specific authenticator. */
export interface RailRegistryAuthorityInput {
  logicalAddress: typeof RAIL_REGISTRY_INDEX_ADDRESS;
  registryVersion: number;
  indexRef: Readonly<RailRegistryDefinitionRef>;
  receipt: Readonly<AnchorReceipt>;
  index: Readonly<RailRegistryIndexDocument>;
}

/** Finality/proof facts for one definition independently read from the index. */
export interface RailRegistryDefinitionAuthorityInput {
  registryAddress: typeof RAIL_REGISTRY_INDEX_ADDRESS;
  registryVersion: number;
  indexRef: Readonly<RailRegistryDefinitionRef>;
  definitionRef: Readonly<RailRegistryDefinitionRef>;
  receipt: Readonly<AnchorReceipt>;
  definition: Readonly<RailDefinition>;
}

/**
 * PA-2 provider for one current rail-registry snapshot (§9.4.3, RAV-R5).
 * `authenticateCurrentIndex` MUST independently prove that the supplied
 * receipt/ref/hash/version/writer tuple is the latest canonical binding and
 * authenticate the complete CORE SR2-4..SR2-7 receipt proof, transaction,
 * applicable nonce, finality, and lifecycle ordering. A well-shaped, cached,
 * historical, or merely signed copy is not sufficient.
 *
 * Migration from the pre-authority `RegistryResolveDeps` rail API requires an
 * SR-2 binding adapter: `readRegistry` alone cannot establish currentness or
 * definition finality, so it is intentionally accepted only by `resolveRecipe`.
 */
export interface RailRegistrySelectionProvider {
  resolveCurrentIndex: (
    logicalAddress: typeof RAIL_REGISTRY_INDEX_ADDRESS,
  ) => Promise<CurrentRailRegistryIndex | null>;
  authenticateCurrentIndex: (
    input: Readonly<RailRegistryAuthorityInput>,
  ) =>
    | Promise<RailRegistryAuthorityVerification>
    | RailRegistryAuthorityVerification;
  /** Independent exact-content readback for the index and definition refs. */
  readAnchoredJson: (
    ref: Readonly<RailRegistryDefinitionRef>,
  ) => Promise<Record<string, unknown> | null>;
  /** Independently resolve the latest SR-2 receipt for one indexed definition. */
  resolveDefinitionReceipt: (
    ref: Readonly<RailRegistryDefinitionRef>,
  ) => Promise<AnchorReceipt | null>;
  /**
   * Authenticate the complete CORE SR2-4..SR2-7 receipt claim: binding-owned
   * evidence, transactionRef, applicable nonce, block/finality profile, and
   * lifecycle ordering. The SDK separately checks logical/native address,
   * content hash, writer, finalized/established state, definition signature,
   * and authenticated-index membership before accepting `valid`.
   */
  authenticateDefinition: (
    input: Readonly<RailRegistryDefinitionAuthorityInput>,
  ) =>
    | Promise<RailRegistryAuthorityVerification>
    | RailRegistryAuthorityVerification;
  /** SR-2 writer authorised to own the canonical index binding. */
  stewardWriter: string;
  /** DACS-4 RD-1 ComponentSignature signer authorised for every definition. */
  stewardSigner: string;
  /** Pinned PA-2 Ed25519 steward key. */
  stewardPublicKey: Uint8Array;
  verify: Verifier;
  /** Explicit compatibility policy for pre-ComponentSignature definitions. */
  legacySignatures?: "reject" | "verify-with-pinned-key";
}

/** Immutable provenance retained out-of-band for a runtime-authorised rail. */
export interface RailRegistryProvenance {
  logicalAddress: typeof RAIL_REGISTRY_INDEX_ADDRESS;
  registryVersion: number;
  indexRef: Readonly<RailRegistryDefinitionRef>;
  indexContentHash: string;
  definitionRef: Readonly<RailRegistryDefinitionRef>;
  definitionContentHash: string;
  writer: string;
  indexReceipt: Readonly<AnchorReceipt>;
  definitionReceipt: Readonly<AnchorReceipt>;
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
    if (!isCanonicalClaimReference(stewardSignerCandidate)) {
      throw new TypeError("stewardSigner must be a canonical ClaimReference");
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
      stewardSigner: stewardSignerCandidate,
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

const authenticatedRails = new WeakMap<object, Readonly<RailRegistryProvenance>>();
declare const authenticatedRailDefinitionBrand: unique symbol;

/**
 * A DACS-4 §9.4.1 definition whose exact wire shape and steward signature were
 * checked by {@link resolveRail}. The private brand prevents structural caller
 * data from reaching the money path; the provenance map enforces RAV-R5 at
 * runtime without adding SDK-only fields to the signed wire shape.
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

/**
 * Return the immutable canonical-index provenance retained for a resolved rail.
 * Structural copies deliberately return `null`, just like the runtime brand.
 */
export function getAuthenticatedRailProvenance(
  value: unknown,
): Readonly<RailRegistryProvenance> | null {
  return isRecord(value) ? authenticatedRails.get(value) ?? null : null;
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

type ProviderMethod = (...args: never[]) => unknown;

function stableProviderProperty(
  source: unknown,
  key: string,
  label: string,
): { found: boolean; value?: unknown } {
  if (
    (typeof source !== "object" && typeof source !== "function") ||
    source === null ||
    nodeTypes.isProxy(source)
  ) {
    throw new DacsError(`${label} must be stable data`);
  }
  let cursor: object | null = source;
  while (cursor !== null) {
    if (nodeTypes.isProxy(cursor)) {
      throw new DacsError(`${label} must be stable data`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
    if (descriptor !== undefined) {
      if (!("value" in descriptor)) {
        throw new DacsError(`${label} must be stable data`);
      }
      return { found: true, value: descriptor.value };
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  return { found: false };
}

function stableProviderMethod<T extends ProviderMethod>(
  source: unknown,
  key: string,
  label: string,
): T {
  const property = stableProviderProperty(source, key, label);
  if (
    !property.found ||
    typeof property.value !== "function" ||
    nodeTypes.isProxy(property.value)
  ) {
    throw new DacsError(`${label} must be a stable method`);
  }
  return Function.prototype.bind.call(property.value, source) as T;
}

interface CapturedRailRegistryProvider {
  resolveCurrentIndex: RailRegistrySelectionProvider["resolveCurrentIndex"];
  authenticateCurrentIndex: RailRegistrySelectionProvider["authenticateCurrentIndex"];
  readAnchoredJson: RailRegistrySelectionProvider["readAnchoredJson"];
  resolveDefinitionReceipt: RailRegistrySelectionProvider["resolveDefinitionReceipt"];
  authenticateDefinition: RailRegistrySelectionProvider["authenticateDefinition"];
  stewardWriter: string;
  stewardSigner: string;
  stewardPublicKey: Uint8Array;
  verify: Verifier;
  legacySignatures: RailRegistrySelectionProvider["legacySignatures"];
}

function captureRailRegistryProvider(
  source: RailRegistrySelectionProvider,
): CapturedRailRegistryProvider {
  const resolveCurrentIndex = stableProviderMethod<
    RailRegistrySelectionProvider["resolveCurrentIndex"]
  >(source, "resolveCurrentIndex", "rail registry current-index resolver");
  const authenticateCurrentIndex = stableProviderMethod<
    RailRegistrySelectionProvider["authenticateCurrentIndex"]
  >(source, "authenticateCurrentIndex", "rail registry authority verifier");
  const readAnchoredJson = stableProviderMethod<
    RailRegistrySelectionProvider["readAnchoredJson"]
  >(source, "readAnchoredJson", "rail registry anchored reader");
  const resolveDefinitionReceipt = stableProviderMethod<
    RailRegistrySelectionProvider["resolveDefinitionReceipt"]
  >(
    source,
    "resolveDefinitionReceipt",
    "rail registry definition-receipt resolver",
  );
  const authenticateDefinition = stableProviderMethod<
    RailRegistrySelectionProvider["authenticateDefinition"]
  >(
    source,
    "authenticateDefinition",
    "rail registry definition authority verifier",
  );
  const verify = stableProviderMethod<Verifier>(
    source,
    "verify",
    "rail registry signature verifier",
  );
  const stewardWriter = stableProviderProperty(
    source,
    "stewardWriter",
    "rail registry steward writer",
  ).value;
  const stewardSigner = stableProviderProperty(
    source,
    "stewardSigner",
    "rail registry steward signer",
  ).value;
  const publicKey = stableProviderProperty(
    source,
    "stewardPublicKey",
    "rail registry steward public key",
  ).value;
  const legacySignatures = stableProviderProperty(
    source,
    "legacySignatures",
    "rail registry legacy-signature policy",
  );
  if (
    !isCanonicalClaimReference(stewardWriter) ||
    !isCanonicalClaimReference(stewardSigner) ||
    !nodeTypes.isUint8Array(publicKey) ||
    nodeTypes.isProxy(publicKey) ||
    publicKey.byteLength !== 32 ||
    (legacySignatures.found &&
      legacySignatures.value !== undefined &&
      legacySignatures.value !== "reject" &&
      legacySignatures.value !== "verify-with-pinned-key")
  ) {
    throw new DacsError("rail registry provider trust material is malformed");
  }
  return {
    resolveCurrentIndex,
    authenticateCurrentIndex,
    readAnchoredJson,
    resolveDefinitionReceipt,
    authenticateDefinition,
    stewardWriter,
    stewardSigner,
    stewardPublicKey: Uint8Array.from(publicKey),
    verify,
    legacySignatures: legacySignatures.value as
      | "reject"
      | "verify-with-pinned-key"
      | undefined,
  };
}

function immutableProviderJson<T>(value: unknown, label: string): T {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`${label} must be an object`);
    }
    return deepFreeze(snapshotCanonicalJsonRead(
      value as Record<string, unknown>,
      label,
    )) as T;
  } catch (cause) {
    throw new DacsError(`${label} is not exact canonical JSON`, { cause });
  }
}

function isRailRegistryDefinitionRef(
  value: unknown,
): value is RailRegistryDefinitionRef {
  return hasExactWireKeys(
    value,
    ["logicalAddress", "anchor", "contentHash"],
  ) &&
    isNonEmptyWireString(value.logicalAddress) &&
    isAttestationRef({
      anchor: value.anchor,
      contentHash: value.contentHash,
    });
}

function isRailRegistryIndexDocument(
  value: unknown,
): value is RailRegistryIndexDocument {
  return hasExactWireKeys(value, ["registryId", "entries"]) &&
    value.registryId === RAIL_REGISTRY_INDEX_ADDRESS &&
    isExactWireArray(value.entries, isRailRegistryDefinitionRef) &&
    value.entries.length > 0;
}

function isCurrentRailRegistryIndex(
  value: unknown,
): value is CurrentRailRegistryIndex {
  return hasExactWireKeys(value, ["registryVersion", "indexRef", "receipt"]) &&
    isPositiveSafeInt(value.registryVersion) &&
    isRailRegistryDefinitionRef(value.indexRef) &&
    isReadableAnchorReceipt(value.receipt);
}

async function readRailRegistryJson(
  provider: CapturedRailRegistryProvider,
  ref: Readonly<RailRegistryDefinitionRef>,
  label: string,
): Promise<Record<string, unknown>> {
  let raw: Record<string, unknown> | null;
  try {
    raw = await provider.readAnchoredJson(
      immutableProviderJson(ref, `${label} read reference`),
    );
  } catch (cause) {
    throw new SubstrateError(`${label} readback errored`, { cause });
  }
  if (raw === null) throw new SubstrateError(`${label} readback is unresolved`);
  return immutableProviderJson(raw, `${label} readback`);
}

async function resolveRailDefinitionReceipt(
  provider: CapturedRailRegistryProvider,
  ref: Readonly<RailRegistryDefinitionRef>,
): Promise<Readonly<AnchorReceipt>> {
  let raw: AnchorReceipt | null;
  try {
    raw = await provider.resolveDefinitionReceipt(
      immutableProviderJson(ref, "rail registry definition receipt reference"),
    );
  } catch (cause) {
    throw new SubstrateError(
      "rail registry definition receipt resolution errored",
      { cause },
    );
  }
  if (raw === null) {
    throw new SubstrateError(
      "rail registry definition receipt resolution is unresolved",
    );
  }
  const receipt = immutableProviderJson<AnchorReceipt>(
    raw,
    "rail registry definition receipt",
  );
  if (!isReadableAnchorReceipt(receipt)) {
    throw new DacsError("rail registry definition receipt is malformed");
  }
  return receipt;
}

async function authenticateRailEntry(
  rawEntry: Readonly<Record<string, unknown>>,
  provider: CapturedRailRegistryProvider,
): Promise<Readonly<RailDefinition>> {
  let candidate = rawEntry as Record<string, unknown>;
  if (typeof candidate.signature === "string") {
    if (
      provider.legacySignatures !== "verify-with-pinned-key" ||
      !(await verifySignedArtifact(
        candidate,
        "dacs-rail:v1:",
        Uint8Array.from(provider.stewardPublicKey),
        (bytes, signature, publicKey) =>
          verifyWithCapturedDeps(provider.verify, bytes, signature, publicKey),
      ))
    ) {
      throw new DacsError(
        "rail registry entry legacy signature is rejected or invalid under the steward key",
      );
    }
    candidate = immutableProviderJson({
      ...candidate,
      signature: {
        algorithm: "ed25519",
        signer: provider.stewardSigner,
        value: Buffer.from(candidate.signature, "hex").toString("base64url"),
      },
    }, "normalised legacy rail definition");
  }
  if (!isRailDefinition(candidate)) {
    throw new DacsError("rail registry entry has an invalid signed definition shape");
  }
  const signed = await verifyComponentSignature(candidate, "dacs-rail:v1:", {
    isSignerAuthorized: (_artifact, signature) =>
      sameCanonicalClaimIdentity(signature.signer, provider.stewardSigner),
    resolvePublicKey: (signature) =>
      signature.algorithm === "ed25519"
        ? Uint8Array.from(provider.stewardPublicKey)
        : null,
    verify: ({ signedBytes, signature, publicKey }) =>
      verifyWithCapturedDeps(
        provider.verify,
        signedBytes,
        Uint8Array.from(Buffer.from(signature.value, "base64url")),
        publicKey,
      ),
  });
  if (signed.status !== "valid") {
    throw new DacsError(
      "rail registry entry signature is not valid under the steward key",
    );
  }
  if (candidate.governance.anchoring !== "single-signer") {
    throw new DacsError(
      `rail registry entry uses unsupported anchoring phase ${candidate.governance.anchoring}; this resolver operates PA-2 single-signer`,
    );
  }
  return deepFreeze(candidate as unknown as RailDefinition);
}

interface AuthenticatedRailRegistryEntry {
  ref: Readonly<RailRegistryDefinitionRef>;
  definition: Readonly<RailDefinition>;
  receipt: Readonly<AnchorReceipt>;
}

function assertRailRegistryGraph(
  entries: ReadonlyArray<Readonly<AuthenticatedRailRegistryEntry>>,
): void {
  const families = new Map<string, AuthenticatedRailRegistryEntry[]>();
  for (const entry of entries) {
    const family = families.get(entry.definition.railId) ?? [];
    family.push(entry as AuthenticatedRailRegistryEntry);
    families.set(entry.definition.railId, family);
  }
  for (const [railId, family] of families) {
    family.sort((left, right) =>
      left.definition.railVersion - right.definition.railVersion);
    const first = family[0]!.definition;
    for (let index = 0; index < family.length; index += 1) {
      const current = family[index]!.definition;
      const prior = index === 0 ? undefined : family[index - 1]!.definition;
      if (prior !== undefined && current.railVersion === prior.railVersion) {
        throw new DacsError(
          `rail registry family "${railId}" has duplicate version ${current.railVersion}`,
        );
      }
      if (current.phaseHandler !== first.phaseHandler) {
        throw new DacsError(
          `rail registry family "${railId}" changes phaseHandler across versions (RD-6)`,
        );
      }
      if (prior === undefined) {
        if (current.governance.supersedes !== undefined) {
          throw new DacsError(
            `rail registry family "${railId}" starts by superseding a missing version`,
          );
        }
      } else {
        if (current.governance.supersedes !== prior.railVersion) {
          throw new DacsError(
            `rail registry family "${railId}" does not form one monotonic supersession chain (RD-3/RD-4)`,
          );
        }
        if (current.governance.acceptedAt < prior.governance.acceptedAt) {
          throw new DacsError(
            `rail registry family "${railId}" reverses signed acceptedAt ordering`,
          );
        }
      }
    }
  }
}

function captureRailSelector(
  selector: string | Readonly<RailSelector>,
): Readonly<{ railId: string; railVersion?: number }> {
  if (typeof selector === "string") {
    if (
      selector.length === 0 ||
      selector.trim() !== selector ||
      selector.normalize("NFC") !== selector ||
      !isSafeJsonString(selector)
    ) {
      throw new DacsError("rail selector must carry a canonical non-empty railId");
    }
    return Object.freeze({ railId: selector });
  }
  if (
    !hasExactWireKeys(selector, ["railId"], ["railVersion"]) ||
    typeof selector.railId !== "string" ||
    selector.railId.length === 0 ||
    selector.railId.trim() !== selector.railId ||
    selector.railId.normalize("NFC") !== selector.railId ||
    !isSafeJsonString(selector.railId) ||
    (selector.railVersion !== undefined &&
      !isPositiveSafeInt(selector.railVersion))
  ) {
    throw new DacsError(
      "rail selector must carry an exact canonical railId and optional positive railVersion",
    );
  }
  return Object.freeze({
    railId: selector.railId,
    ...(selector.railVersion === undefined
      ? {}
      : { railVersion: selector.railVersion }),
  });
}

/**
 * Resolve and pin one exact steward-signed DACS-4 §9.4.1 rail definition.
 * Availability is deliberately preserved: RAV-R1..RAV-R3 are point-of-use
 * policy, while RAV-R5 requires this authenticated definition as their source.
 * Even an explicitly historical version is selected only from the latest
 * independently authenticated canonical index; a signed cached registry
 * document can never acquire runtime authority by itself.
 */
export async function resolveRail(
  anchor: string,
  selector: string | Readonly<RailSelector>,
  providerSource: RailRegistrySelectionProvider,
): Promise<AuthenticatedRailDefinition> {
  if (anchor !== RAIL_REGISTRY_INDEX_ADDRESS) {
    throw new DacsError(
      `rail resolution requires canonical index ${RAIL_REGISTRY_INDEX_ADDRESS}`,
    );
  }
  // Capture selector, callbacks, trust claims, and key bytes synchronously at
  // entry. No currentness lookup may let the caller swap authority mid-read.
  const selected = captureRailSelector(selector);
  const provider = captureRailRegistryProvider(providerSource);

  let rawCurrent: CurrentRailRegistryIndex | null;
  try {
    rawCurrent = await provider.resolveCurrentIndex(RAIL_REGISTRY_INDEX_ADDRESS);
  } catch (cause) {
    throw new SubstrateError("rail registry current-index lookup errored", {
      cause,
    });
  }
  if (rawCurrent === null) {
    throw new SubstrateError("rail registry current-index lookup is unresolved");
  }
  const current = immutableProviderJson<CurrentRailRegistryIndex>(
    rawCurrent,
    "rail registry current-index binding",
  );
  if (!isCurrentRailRegistryIndex(current)) {
    throw new DacsError("rail registry current-index binding is malformed");
  }
  if (
    current.indexRef.logicalAddress !== RAIL_REGISTRY_INDEX_ADDRESS ||
    current.receipt.logicalAddress !== RAIL_REGISTRY_INDEX_ADDRESS ||
    current.receipt.nativeAddress !== current.indexRef.anchor.locator ||
    current.receipt.contentHash !== current.indexRef.contentHash ||
    !sameCanonicalClaimIdentity(
      current.receipt.writer,
      provider.stewardWriter,
    )
  ) {
    throw new DacsError(
      "rail registry index contradicts its canonical steward-owned SR-2 binding",
    );
  }
  if (
    current.receipt.state !== "finalized" ||
    current.receipt.observationDisposition !== "established"
  ) {
    throw new SubstrateError(
      "rail registry index does not yet have an established finalized SR-2 receipt",
    );
  }

  const rawIndex = await readRailRegistryJson(
    provider,
    current.indexRef,
    "rail registry index",
  );
  if (!isRailRegistryIndexDocument(rawIndex)) {
    throw new DacsError("rail registry index has an invalid operational shape");
  }
  const index = rawIndex as unknown as Readonly<RailRegistryIndexDocument>;
  const indexContentHash = contentHash(
    index as unknown as Record<string, unknown>,
  );
  if (indexContentHash !== current.indexRef.contentHash) {
    throw new DacsError("rail registry index readback hash does not match its ref");
  }
  const canonicalRefs = index.entries.map((entry) =>
    `${entry.logicalAddress}\u0000${entry.anchor.kind}\u0000${entry.anchor.locator}\u0000${entry.contentHash}`);
  if (new Set(canonicalRefs).size !== canonicalRefs.length) {
    throw new DacsError("rail registry index repeats a definition reference");
  }
  const locators = index.entries.map((entry) => entry.anchor.locator);
  if (new Set(locators).size !== locators.length) {
    throw new DacsError("rail registry index repeats a definition anchor");
  }
  const logicalAddresses = index.entries.map((entry) => entry.logicalAddress);
  if (new Set(logicalAddresses).size !== logicalAddresses.length) {
    throw new DacsError(
      "rail registry index repeats a definition logical address",
    );
  }

  let authority: RailRegistryAuthorityVerification;
  try {
    authority = await provider.authenticateCurrentIndex(
      immutableProviderJson<RailRegistryAuthorityInput>({
        logicalAddress: RAIL_REGISTRY_INDEX_ADDRESS,
        registryVersion: current.registryVersion,
        indexRef: current.indexRef,
        receipt: current.receipt,
        index,
      }, "rail registry authority input"),
    );
  } catch (cause) {
    throw new SubstrateError("rail registry authority verification errored", {
      cause,
    });
  }
  if (authority === "indeterminate") {
    throw new SubstrateError("rail registry authority is indeterminate");
  }
  if (authority !== "valid") {
    throw new DacsError("rail registry authority is invalid or unauthenticated");
  }

  const entries: AuthenticatedRailRegistryEntry[] = [];
  for (const ref of index.entries) {
    const rawDefinition = await readRailRegistryJson(
      provider,
      ref,
      "rail registry definition",
    );
    const definitionContentHash = contentHash(rawDefinition);
    if (definitionContentHash !== ref.contentHash) {
      throw new DacsError(
        "rail registry definition hash does not match its index ref",
      );
    }
    const definition = await authenticateRailEntry(rawDefinition, provider);
    const receipt = await resolveRailDefinitionReceipt(provider, ref);
    if (
      receipt.logicalAddress !== ref.logicalAddress ||
      receipt.nativeAddress !== ref.anchor.locator ||
      receipt.contentHash !== ref.contentHash ||
      !sameCanonicalClaimIdentity(receipt.writer, provider.stewardWriter)
    ) {
      throw new DacsError(
        "rail registry definition contradicts its canonical steward-owned SR-2 binding",
      );
    }
    if (
      receipt.state !== "finalized" ||
      receipt.observationDisposition !== "established"
    ) {
      throw new SubstrateError(
        "rail registry definition does not yet have an established finalized SR-2 receipt",
      );
    }
    let definitionAuthority: RailRegistryAuthorityVerification;
    try {
      definitionAuthority = await provider.authenticateDefinition(
        immutableProviderJson<RailRegistryDefinitionAuthorityInput>({
          registryAddress: RAIL_REGISTRY_INDEX_ADDRESS,
          registryVersion: current.registryVersion,
          indexRef: current.indexRef,
          definitionRef: ref,
          receipt,
          definition,
        }, "rail registry definition authority input"),
      );
    } catch (cause) {
      throw new SubstrateError(
        "rail registry definition authority verification errored",
        { cause },
      );
    }
    if (definitionAuthority === "indeterminate") {
      throw new SubstrateError(
        "rail registry definition authority is indeterminate",
      );
    }
    if (definitionAuthority !== "valid") {
      throw new DacsError(
        "rail registry definition authority is invalid or unauthenticated",
      );
    }
    entries.push(deepFreeze({ ref, definition, receipt }));
  }
  assertRailRegistryGraph(entries);

  const family = entries.filter(
    (entry) => entry.definition.railId === selected.railId,
  );
  if (family.length === 0) {
    throw new DacsError(
      `entry "${selected.railId}" not found in canonical rail registry`,
    );
  }
  const selectedVersion = selected.railVersion ?? Math.max(
    ...family.map((entry) => entry.definition.railVersion),
  );
  const matches = family.filter(
    (entry) => entry.definition.railVersion === selectedVersion,
  );
  if (matches.length !== 1) {
    throw new DacsError(
      `entry family "${selected.railId}" resolved ${matches.length} definitions at version ${selectedVersion}; exactly one is required`,
    );
  }
  const match = matches[0]!;
  const pinned = match.definition as AuthenticatedRailDefinition;
  const provenance = deepFreeze({
    logicalAddress: RAIL_REGISTRY_INDEX_ADDRESS,
    registryVersion: current.registryVersion,
    indexRef: current.indexRef,
    indexContentHash,
    definitionRef: match.ref,
    definitionContentHash: match.ref.contentHash,
    writer: current.receipt.writer,
    indexReceipt: current.receipt,
    definitionReceipt: match.receipt,
  }) satisfies Readonly<RailRegistryProvenance>;
  authenticatedRails.set(pinned, provenance);
  return pinned;
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
  const captured = captureRegistryResolveDeps(deps);
  const readRegistry = captured.readRegistry;
  const verify = captured.verify;
  const stewardSigner = captured.stewardSigner;
  const stewardPublicKey = Uint8Array.from(captured.stewardPublicKey);
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
      sameCanonicalClaimIdentity(signature.signer, stewardSigner),
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

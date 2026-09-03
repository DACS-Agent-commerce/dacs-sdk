import { canonicalize, contentHash, sha256Hex } from "../canonical/index.js";
import type {
  AttestationAnchor,
  AttestationRef,
  BundleClaim,
  ComponentSignature,
  CompositeVerificationRecord,
  IdentityBundle,
  VerificationDecision,
  VerificationMethodKind,
  VerifyResult,
  VerifyResultRef,
} from "../artifacts/types.js";
import {
  isAttestationRef,
  isCompositeVerificationRecord,
  isIdentityBundle,
  isLegacyCompositeVerificationRecord,
  isExactJsonRecord,
  isVerifyResult,
  isVerifyResultRef,
} from "../artifacts/validators.js";
import {
  verifyComponentSignature,
  type VerifyComponentSignatureDeps,
} from "../artifacts/signatures.js";
import { isRecipeDescriptor } from "../registry/resolve.js";
import type { RecipeDescriptor } from "../registry/types.js";
import {
  identityBundleHash,
  isRegisteredClaimReferenceScheme,
  parseCanonicalClaimReference,
  sameCanonicalClaimIdentity,
} from "../identity/index.js";

/** Exact DACS-1 §6.3.3 subset consumed by DACS-2 §7.7.1 aggregation. */
export interface CompositeClaimRequirement {
  scheme: string;
  verificationRequired: boolean;
  maxAge?: number;
  recipeVersion?: number;
  parameters?: Record<string, unknown>;
}

/** Exact DACS-1 §6.3.3 BundleRequirement wire shape. */
export interface CompositeBundleRequirement {
  requirementVersion: "1";
  required: CompositeClaimRequirement[];
  oneOf?: CompositeClaimRequirement[][];
  preferredPresentation?: "siwd" | "sr1-root" | "per-claim" | "session-key" | "any";
  primaryClaimSelector?: string;
}

/**
 * The closure verifier needs the session's expected classification and exact
 * claim identity for every ref. This prevents a valid result for another claim
 * (or a freshness result substituted into the deal-specific set) from being
 * accepted merely because it shares a scheme.
 */
export interface ExpectedVerifyResult {
  ref: VerifyResultRef;
  scheme: string;
  identifier: string;
  /** Exact method selected from the pinned recipe family. */
  method: VerificationMethodKind;
  /**
   * Exact claim requirement this result is intended to satisfy. It must occur
   * byte-for-byte in `CompositeVerificationExpectations.requirement`; carrying
   * it here prevents one same-scheme result from satisfying a different
   * recipe, freshness window, or parameterized requirement.
   */
  requirement: CompositeClaimRequirement;
}

export interface CompositeVerificationExpectations {
  jobId: string;
  evaluatedParty: string;
  bundleHash: string;
  /** The hash is recomputed from this complete requirement object. */
  requirement: CompositeBundleRequirement;
  /** Exact verifier identity required on the composite signature. */
  verifier: string;
  freshness: ExpectedVerifyResult[];
  dealSpecific: ExpectedVerifyResult[];
  /**
   * PCR-6 companion authority. Required whenever the requirement contains a
   * presence-only member. `bundle: null` represents a temporarily unavailable
   * exact bundle and therefore produces an unresolved, never valid, replay.
   */
  presence?: {
    bundle: IdentityBundle | null;
    /** Exact authenticated job-wide registry snapshot selected at session start. */
    sessionRecipeRegistrySnapshotHash: string;
  };
}

/** Bytes as stored at an AttestationRef, with the hashing mode made explicit. */
export type ResolvedVerificationContent =
  | { encoding: "canonical-json"; value: Record<string, unknown> }
  | { encoding: "bytes"; value: Uint8Array };

export type AuthorityVerification = "valid" | "invalid" | "unresolved";

export interface VerifyAuthorityAttestationInput {
  result: Readonly<VerifyResult>;
  expected: Readonly<ExpectedVerifyResult>;
  /** Exact steward-authenticated recipe used to interpret this result. */
  recipe: Readonly<RecipeDescriptor & { signature: ComponentSignature }>;
  content: Readonly<ResolvedVerificationContent>;
}

export interface VerifyCompositeVerificationDeps<TKey> {
  /** Acceptance-time clock used for VP-C1/VP-C3 freshness enforcement. */
  nowMs: () => number;
  /** Resolve the exact anchor supplied by either a VerifyResultRef or AttestationRef. */
  resolve: (
    ref: Readonly<{ anchor: AttestationAnchor; contentHash: string }>,
  ) => Promise<ResolvedVerificationContent | null>;
  /** Resolve the exact recipe family/version pinned by the VerifyResultRef. */
  resolveRecipe: (selector: Readonly<{
    scheme: string;
    method: VerificationMethodKind;
    recipeVersion: number;
  }>) => Promise<(RecipeDescriptor & { signature: ComponentSignature }) | null>;
  /** Steward trust policy for the resolved recipe signature. */
  isRecipeSignerAuthorized: (
    recipe: Readonly<RecipeDescriptor & { signature: ComponentSignature }>,
    signature: Readonly<ComponentSignature>,
  ) => Promise<boolean> | boolean;
  /** Artifact-specific trust policy for the signer of each VerifyResult. */
  isVerifyResultSignerAuthorized: (
    result: Readonly<VerifyResult>,
    signature: Readonly<ComponentSignature>,
    expected: Readonly<ExpectedVerifyResult>,
  ) => Promise<boolean> | boolean;
  resolvePublicKey: VerifyComponentSignatureDeps<TKey>["resolvePublicKey"];
  verify: VerifyComponentSignatureDeps<TKey>["verify"];
  /**
   * Method-specific §7.5.2 authority proof verification. The callback receives
   * already integrity-checked bytes and MUST authenticate the method-native
   * attestation signer/domain. `unresolved` is never treated as valid.
   */
  verifyAuthorityAttestation: (
    input: VerifyAuthorityAttestationInput,
  ) => Promise<AuthorityVerification> | AuthorityVerification;
  /** Re-derive exact ClaimRequirement.parameters against authenticated data. */
  verifyRequirementParameters?: (
    input: VerifyAuthorityAttestationInput,
  ) => Promise<boolean> | boolean;
  /** Authenticate CRQ-1 even when no verification recipe is invoked. */
  isSessionRecipeRegistrySnapshotAuthenticated?: (
    snapshotHash: string,
  ) => Promise<boolean> | boolean;
  /** Authenticate BP-4 over the exact PCR-6 companion bundle. */
  verifyIdentityPresentation?: (input: {
    bundle: Readonly<IdentityBundle>;
    bundleHash: string;
  }) => Promise<boolean> | boolean;
  /**
   * Optional scheme-specific DACS-1 §6.3.2 step (6) control proof. A verified
   * bundle presentation controls its exact `key:` presentedBy without this
   * callback; existence-only schemes fail closed when it is absent.
   */
  isPresentedClaimControlled?: (input: {
    bundle: Readonly<IdentityBundle>;
    claim: Readonly<BundleClaim>;
  }) => Promise<boolean> | boolean;
}

export type CompositeVerificationInvalidCode =
  | "legacy-record"
  | "record-shape"
  | "expectation-shape"
  | "job-mismatch"
  | "evaluated-party-mismatch"
  | "bundle-hash-mismatch"
  | "requirement-hash-mismatch"
  | "freshness-substitution"
  | "deal-specific-substitution"
  | "record-signature"
  | "record-time"
  | "recipe-shape"
  | "recipe-signature"
  | "verify-result-shape"
  | "verify-result-hash"
  | "verify-result-recipe"
  | "verify-result-method"
  | "verify-result-claim"
  | "verify-result-signature"
  | "verify-result-time"
  | "verify-result-stale"
  | "authority-hash"
  | "authority-signature"
  | "requirement-parameters"
  | "recipe-registry"
  | "identity-bundle"
  | "identity-presentation"
  | "presence-evidence"
  | "aggregation-mismatch";

export type CompositeVerificationUnresolvedCode =
  | "verification-dependency"
  | "verification-time"
  | "record-signature"
  | "recipe-resolution"
  | "recipe-signature"
  | "verify-result-resolution"
  | "verify-result-signature"
  | "authority-resolution"
  | "authority-signature"
  | "requirement-parameters"
  | "identity-bundle";

export type StrictCompositeVerification =
  | {
      status: "valid";
      record: CompositeVerificationRecord;
      /** Successfully resolved and authenticated freshness results. */
      freshness: VerifyResult[];
      /** Successfully resolved and authenticated deal-specific results. */
      dealSpecific: VerifyResult[];
      /** Authenticated recipes aligned with the returned `freshness` results. */
      freshnessRecipes: Array<RecipeDescriptor & { signature: ComponentSignature }>;
      /** Authenticated recipes aligned with the returned `dealSpecific` results. */
      dealSpecificRecipes: Array<RecipeDescriptor & { signature: ComponentSignature }>;
      /**
       * Referenced result bodies that were unavailable during replay. Their
       * authenticated recipe family was still preflighted and their member
       * outcome was `indeterminate`. A record can remain valid only when its
       * signed aggregate reproduces that outcome (for example an independent
       * selector failure has the global fail-first precedence).
       */
      indeterminateEvidence?: Array<{
        collection: "freshness" | "dealSpecific";
        index: number;
        ref: VerifyResultRef;
        detail?: string;
      }>;
    }
  | {
      status: "invalid";
      code: CompositeVerificationInvalidCode;
      detail?: string;
    }
  | {
      status: "unresolved";
      code: CompositeVerificationUnresolvedCode;
      detail?: string;
    };

const DECISIONS = ["pass", "fail", "indeterminate", "error"] as const;
const METHODS = [
  "verifiable-credential",
  "tlsnotary",
  "zktls",
  "consensus-backed-proxy",
  "oauth-attested",
  "evm-rpc",
  "domain-tls-control",
  "self-signed",
  "demos-gcr-domain",
] as const satisfies readonly VerificationMethodKind[];
const PREFERRED_PRESENTATIONS = [
  "siwd",
  "sr1-root",
  "per-claim",
  "session-key",
  "any",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hasExactWireKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
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
};
const isExactWireArray = (
  value: unknown,
  validate: (entry: unknown, index: number) => boolean,
): boolean => {
  if (!Array.isArray(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        !validate(descriptor.value, index)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
};
const isScheme = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z][a-z0-9-]*$/.test(value);
const isSafeUint = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isPositiveSafeInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isSha256 = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

function deepFreezeSnapshot<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value as object)) {
    return value;
  }
  // Uint8Array cannot be frozen on every supported runtime. Byte-bearing
  // callback inputs are isolated separately below and never reused afterward.
  if (ArrayBuffer.isView(value)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeSnapshot(child, seen);
  }
  return Object.freeze(value);
}

function cloneResolvedContent(value: unknown): ResolvedVerificationContent | null {
  // Validate callback-owned bytes before cloning. structuredClone deliberately
  // normalises prototypes and invokes accessors, which must not turn a non-wire
  // resolver response into an apparently valid signed artifact.
  if (!isResolvedVerificationContent(value)) return null;
  let snapshot: unknown;
  try {
    snapshot = structuredClone(value);
  } catch {
    return null;
  }
  if (!isResolvedVerificationContent(snapshot)) return null;
  if (snapshot.encoding === "bytes") {
    return { encoding: "bytes", value: Uint8Array.from(snapshot.value) };
  }
  return {
    encoding: "canonical-json",
    value: deepFreezeSnapshot(snapshot.value),
  };
}

function captureVerificationDeps<TKey>(
  deps: VerifyCompositeVerificationDeps<TKey>,
): VerifyCompositeVerificationDeps<TKey> | null {
  try {
    const resolve = deps.resolve.bind(deps);
    const nowMs = deps.nowMs.bind(deps);
    const resolveRecipe = deps.resolveRecipe.bind(deps);
    const authorizeRecipe = deps.isRecipeSignerAuthorized.bind(deps);
    const authorizeVerifyResult =
      deps.isVerifyResultSignerAuthorized.bind(deps);
    const resolvePublicKey = deps.resolvePublicKey.bind(deps);
    const cryptographicVerify = deps.verify.bind(deps);
    const verifyAuthorityAttestation =
      deps.verifyAuthorityAttestation.bind(deps);
    const verifyRequirementParameters =
      deps.verifyRequirementParameters?.bind(deps);
    const authenticateRegistry =
      deps.isSessionRecipeRegistrySnapshotAuthenticated?.bind(deps);
    const verifyIdentityPresentation =
      deps.verifyIdentityPresentation?.bind(deps);
    const isPresentedClaimControlled =
      deps.isPresentedClaimControlled?.bind(deps);
    const isVerifyResultSignerAuthorized: VerifyCompositeVerificationDeps<TKey>["isVerifyResultSignerAuthorized"] =
      async (result, signature, expected) =>
        (await authorizeVerifyResult(result, signature, expected)) === true;
    const verify: VerifyCompositeVerificationDeps<TKey>["verify"] = async (input) =>
      (await cryptographicVerify(input)) === true;
    const isRecipeSignerAuthorized: VerifyCompositeVerificationDeps<TKey>["isRecipeSignerAuthorized"] =
      async (recipe, signature) =>
        (await authorizeRecipe(recipe, signature)) === true;
    return Object.freeze({
      resolve,
      nowMs,
      resolveRecipe,
      isRecipeSignerAuthorized,
      isVerifyResultSignerAuthorized,
      resolvePublicKey,
      verify,
      verifyAuthorityAttestation,
      ...(verifyRequirementParameters ? { verifyRequirementParameters } : {}),
      ...(authenticateRegistry
        ? {
            isSessionRecipeRegistrySnapshotAuthenticated: async (hash: string) =>
              (await authenticateRegistry(hash)) === true,
          }
        : {}),
      ...(verifyIdentityPresentation
        ? {
            verifyIdentityPresentation: async (input: {
              bundle: Readonly<IdentityBundle>;
              bundleHash: string;
            }) => (await verifyIdentityPresentation(input)) === true,
          }
        : {}),
      ...(isPresentedClaimControlled
        ? {
            isPresentedClaimControlled: async (input: {
              bundle: Readonly<IdentityBundle>;
              claim: Readonly<BundleClaim>;
            }) => (await isPresentedClaimControlled(input)) === true,
          }
        : {}),
    });
  } catch {
    return null;
  }
}

function isClaimRequirement(value: unknown): value is CompositeClaimRequirement {
  if (
    !isRecord(value) ||
    !hasExactWireKeys(value, [
      "scheme",
      "verificationRequired",
    ], [
      "maxAge",
      "recipeVersion",
      "parameters",
    ])
  ) {
    return false;
  }
  return (
    isScheme(value.scheme) &&
    typeof value.verificationRequired === "boolean" &&
    (value.maxAge === undefined || isSafeUint(value.maxAge)) &&
    (value.recipeVersion === undefined || isPositiveSafeInt(value.recipeVersion)) &&
    (value.parameters === undefined || isExactJsonRecord(value.parameters))
  );
}

export function isCompositeBundleRequirement(
  value: unknown,
): value is CompositeBundleRequirement {
  if (
    !isRecord(value) ||
    !hasExactWireKeys(value, [
      "requirementVersion",
      "required",
    ], [
      "oneOf",
      "preferredPresentation",
      "primaryClaimSelector",
    ])
  ) {
    return false;
  }
  return (
    value.requirementVersion === "1" &&
    isExactWireArray(value.required, isClaimRequirement) &&
    (value.oneOf === undefined ||
      isExactWireArray(
        value.oneOf,
        (group) =>
          Array.isArray(group) &&
          group.length > 0 &&
          isExactWireArray(group, isClaimRequirement),
      )) &&
    (value.preferredPresentation === undefined ||
      (typeof value.preferredPresentation === "string" &&
        PREFERRED_PRESENTATIONS.includes(
          value.preferredPresentation as (typeof PREFERRED_PRESENTATIONS)[number],
        ))) &&
    (value.primaryClaimSelector === undefined || isScheme(value.primaryClaimSelector))
  );
}

export type PresenceClaimDecision = "pass" | "fail" | "error";

/** PCR-1/CRQ-1 preflight over every member before any OR short-circuit. */
export function presenceRequirementPreflight(
  requirement: Readonly<CompositeBundleRequirement>,
): string | null {
  const members = [
    ...requirement.required,
    ...(requirement.oneOf ?? []).flat(),
  ];
  for (const member of members) {
    if (!isRegisteredClaimReferenceScheme(member.scheme)) {
      return `unknown or non-canonical claim scheme ${member.scheme}`;
    }
    if (
      member.verificationRequired === false &&
      (member.maxAge !== undefined || member.recipeVersion !== undefined)
    ) {
      return `presence-only ${member.scheme} cannot select freshness or recipe fields`;
    }
  }
  return null;
}

function presenceParametersMatch(
  claim: Readonly<BundleClaim>,
  parameters: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (parameters === undefined) return true;
  if (claim.metadata === undefined) return false;
  for (const [key, expected] of Object.entries(parameters)) {
    if (!Object.prototype.hasOwnProperty.call(claim.metadata, key)) return false;
    try {
      if (canonicalize(claim.metadata[key]) !== canonicalize(expected)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * DACS-1 PCR-2/PCR-3 presence predicate. It deliberately never dereferences a
 * well-shaped optional `verifiedBy` and never treats `issuedAt` as authority.
 */
export function classifyPresenceClaimRequirement(
  bundle: Readonly<IdentityBundle>,
  requirement: Readonly<CompositeClaimRequirement>,
  evaluatedAt: number,
  exactClaimRef?: string,
): PresenceClaimDecision {
  if (
    requirement.verificationRequired !== false ||
    !isSafeUint(evaluatedAt) ||
    !isRegisteredClaimReferenceScheme(requirement.scheme) ||
    requirement.maxAge !== undefined ||
    requirement.recipeVersion !== undefined
  ) {
    return "error";
  }
  for (const claim of bundle.claims) {
    const parsed = parseCanonicalClaimReference(claim.ref);
    if (!parsed || parsed.schemeStatus !== "registered") {
      if (typeof claim.ref === "string" && claim.ref.startsWith(`${requirement.scheme}:`)) {
        return "error";
      }
      continue;
    }
    if (parsed.identity.scheme !== requirement.scheme) continue;
    if (
      exactClaimRef !== undefined &&
      !sameCanonicalClaimIdentity(claim.ref, exactClaimRef)
    ) {
      continue;
    }
    if (claim.verifiedBy !== undefined && !isVerifyResultRef(claim.verifiedBy)) {
      return "error";
    }
    if (claim.expiresAt !== undefined && evaluatedAt > claim.expiresAt) continue;
    if (!presenceParametersMatch(claim, requirement.parameters)) continue;
    return "pass";
  }
  return "fail";
}

function exactRef(left: VerifyResultRef, right: VerifyResultRef): boolean {
  return canonicalize(left) === canonicalize(right);
}

function expectedListMatches(
  actual: readonly VerifyResultRef[],
  expected: readonly ExpectedVerifyResult[],
  requirement: Readonly<CompositeBundleRequirement>,
): boolean {
  const completeRequirements = [
    ...requirement.required,
    ...(requirement.oneOf ?? []).flat(),
  ];
  return (
    isExactWireArray(actual, isVerifyResultRef) &&
    actual.length === expected.length &&
    isExactWireArray(
      expected,
      (item, index) => {
        if (
          !isRecord(item) ||
          !hasExactWireKeys(item, [
            "ref",
            "scheme",
            "identifier",
            "method",
            "requirement",
          ]) ||
          !isVerifyResultRef(item.ref) ||
          !isScheme(item.scheme) ||
          !METHODS.includes(item.method as VerificationMethodKind) ||
          !isClaimRequirement(item.requirement) ||
          item.requirement.verificationRequired !== true ||
          item.requirement.scheme !== item.scheme ||
          (item.requirement.parameters?.verificationMethod !== undefined &&
            item.requirement.parameters.verificationMethod !== item.method) ||
          typeof item.identifier !== "string" ||
          item.identifier.length === 0 ||
          item.identifier.normalize("NFC") !== item.identifier
        ) {
          return false;
        }
        let requirementIsBound = false;
        try {
          const expectedRequirement = canonicalize(item.requirement);
          requirementIsBound = completeRequirements.some(
            (candidate) => canonicalize(candidate) === expectedRequirement,
          );
        } catch {
          return false;
        }
        return requirementIsBound && exactRef(actual[index]!, item.ref);
      },
    )
  );
}

function isCompositeVerificationExpectations(
  value: unknown,
): value is CompositeVerificationExpectations {
  if (
    !isRecord(value) ||
    !hasExactWireKeys(value, [
      "jobId",
      "evaluatedParty",
      "bundleHash",
      "requirement",
      "verifier",
      "freshness",
      "dealSpecific",
    ], ["presence"]) ||
    typeof value.jobId !== "string" ||
    value.jobId.length === 0 ||
    typeof value.evaluatedParty !== "string" ||
    value.evaluatedParty.length === 0 ||
    !isSha256(value.bundleHash) ||
    typeof value.verifier !== "string" ||
    value.verifier.length === 0 ||
    !isCompositeBundleRequirement(value.requirement)
  ) {
    return false;
  }
  const requirement = value.requirement;
  if (
    value.presence !== undefined &&
    (!isRecord(value.presence) ||
      !hasExactWireKeys(value.presence, [
        "bundle",
        "sessionRecipeRegistrySnapshotHash",
      ]) ||
      (value.presence.bundle !== null && !isIdentityBundle(value.presence.bundle)) ||
      !isSha256(value.presence.sessionRecipeRegistrySnapshotHash))
  ) {
    return false;
  }
  const entriesAreExact = (entries: unknown): boolean =>
    isExactWireArray(entries, (item) => {
      if (
        !isRecord(item) ||
        !hasExactWireKeys(item, [
          "ref",
          "scheme",
          "identifier",
          "method",
          "requirement",
        ]) ||
        !isVerifyResultRef(item.ref) ||
        !isScheme(item.scheme) ||
        typeof item.identifier !== "string" ||
        item.identifier.length === 0 ||
        item.identifier.normalize("NFC") !== item.identifier ||
        !METHODS.includes(item.method as VerificationMethodKind) ||
        !isClaimRequirement(item.requirement) ||
        item.requirement.verificationRequired !== true ||
        item.requirement.scheme !== item.scheme ||
        (item.requirement.parameters?.verificationMethod !== undefined &&
          item.requirement.parameters.verificationMethod !== item.method)
      ) {
        return false;
      }
      try {
        const bound = canonicalize(item.requirement);
        return [
          ...requirement.required,
          ...(requirement.oneOf ?? []).flat(),
        ].some((candidate) => canonicalize(candidate) === bound);
      } catch {
        return false;
      }
    });
  return entriesAreExact(value.freshness) && entriesAreExact(value.dealSpecific);
}

function addSeconds(timestamp: number, seconds: number): number | null {
  const milliseconds = seconds * 1000;
  if (!Number.isSafeInteger(milliseconds)) return null;
  const result = timestamp + milliseconds;
  return Number.isSafeInteger(result) ? result : null;
}

function validateResultTime(
  result: Readonly<VerifyResult>,
  expected: Readonly<ExpectedVerifyResult>,
  recipe: Readonly<RecipeDescriptor>,
  now: number,
): StrictCompositeVerification | null {
  if (
    result.method !== "demos-gcr-domain" &&
    result.fetchedAt > result.verifiedAt
  ) {
    return invalid("verify-result-time", "fetchedAt exceeds verifiedAt");
  }
  if (
    result.method === "demos-gcr-domain" &&
    result.verifiedAt > result.fetchedAt
  ) {
    return invalid(
      "verify-result-time",
      "persistent GCR verifiedAt exceeds query time",
    );
  }
  if (result.fetchedAt > now) {
    return invalid("verify-result-time", "fetchedAt is in the future");
  }
  if (result.verifiedAt > now) {
    return invalid("verify-result-time", "verifiedAt is in the future");
  }
  if (result.validUntil !== undefined && result.validUntil < result.verifiedAt) {
    return invalid("verify-result-time", "validUntil precedes verifiedAt");
  }
  if (result.method === "demos-gcr-domain" && result.validUntil !== undefined) {
    const persistentCeiling = addSeconds(
      result.verifiedAt,
      recipe.defaultMaxAgeSec,
    );
    if (persistentCeiling === null || result.validUntil > persistentCeiling) {
      return invalid(
        "verify-result-time",
        "persistent GCR validUntil exceeds its historical inclusion window",
      );
    }
  }
  if (
    expected.requirement.recipeVersion !== undefined &&
    expected.requirement.recipeVersion !== result.recipeVersion
  ) {
    return invalid(
      "verify-result-recipe",
      `recipe version ${result.recipeVersion} is not permitted for ${result.scheme}`,
    );
  }

  let expiry = result.validUntil;
  if (expiry === undefined) {
    expiry = addSeconds(result.verifiedAt, recipe.defaultMaxAgeSec) ?? undefined;
    if (expiry === undefined) {
      return invalid("verify-result-time", "default freshness window overflows");
    }
  }
  if (expected.requirement.maxAge !== undefined) {
    const listingExpiry = addSeconds(
      result.verifiedAt,
      expected.requirement.maxAge,
    );
    if (listingExpiry === null) {
      return invalid("verify-result-time", "listing freshness window overflows");
    }
    expiry = Math.min(expiry, listingExpiry);
  }
  if (now > expiry) {
    return invalid(
      "verify-result-stale",
      `acceptance time ${now} exceeds effective expiry ${expiry}`,
    );
  }
  return null;
}

function isResolvedVerificationContent(
  value: unknown,
): value is ResolvedVerificationContent {
  if (
    !isRecord(value) ||
    !hasExactWireKeys(value, ["encoding", "value"])
  ) {
    return false;
  }
  return value.encoding === "bytes"
    ? value.value instanceof Uint8Array
    : value.encoding === "canonical-json" && isExactJsonRecord(value.value);
}

/** Pure §7.7.1 aggregation. Supplementary signals and warnings are absent by design. */
export function aggregateCompositeVerification(
  results: readonly VerifyResult[],
  requirement: Readonly<CompositeBundleRequirement>,
): VerificationDecision {
  const failures: string[] = [];
  const errors: string[] = [];
  const indeterminates: string[] = [];
  const forRequirement = (claim: CompositeClaimRequirement): VerifyResult[] =>
    results.filter(
      (result) =>
        result.scheme === claim.scheme &&
        (claim.recipeVersion === undefined ||
          result.recipeVersion === claim.recipeVersion),
    );

  const classifyRequired = (claim: CompositeClaimRequirement): void => {
    const matches = forRequirement(claim);
    if (matches.length === 0) {
      failures.push(claim.scheme);
    } else if (matches.some((result) => result.decision === "pass")) {
      return;
    } else if (matches.some((result) => result.decision === "fail")) {
      failures.push(claim.scheme);
    } else if (matches.some((result) => result.decision === "error")) {
      errors.push(claim.scheme);
    } else {
      indeterminates.push(claim.scheme);
    }
  };

  for (const claim of requirement.required) classifyRequired(claim);

  for (const group of requirement.oneOf ?? []) {
    const groupResults = group.flatMap(forRequirement);
    if (groupResults.some((result) => result.decision === "pass")) continue;
    if (groupResults.some((result) => result.decision === "error")) {
      errors.push("oneOf");
    } else if (groupResults.some((result) => result.decision === "indeterminate")) {
      indeterminates.push("oneOf");
    } else {
      failures.push("oneOf");
    }
  }

  if (failures.length > 0) return "fail";
  if (errors.length > 0) return "error";
  if (indeterminates.length > 0) return "indeterminate";
  return "pass";
}

function aggregateBoundCompositeVerification(
  entries: readonly {
    requirement: Readonly<CompositeClaimRequirement>;
    effectiveDecision: VerificationDecision;
  }[],
  requirement: Readonly<CompositeBundleRequirement>,
): VerificationDecision {
  const exactRequirement = (
    left: Readonly<CompositeClaimRequirement>,
    right: Readonly<CompositeClaimRequirement>,
  ): boolean => canonicalize(left) === canonicalize(right);
  const decisionsFor = (
    claim: CompositeClaimRequirement,
  ): VerificationDecision[] =>
    entries
      .filter((entry) => exactRequirement(entry.requirement, claim))
      .map((entry) => entry.effectiveDecision);
  const failures: string[] = [];
  const errors: string[] = [];
  const indeterminates: string[] = [];
  const classify = (claim: CompositeClaimRequirement): void => {
    const matches = decisionsFor(claim);
    if (matches.length === 0) {
      failures.push(claim.scheme);
    } else if (matches.includes("pass")) {
      return;
    } else if (matches.includes("fail")) {
      failures.push(claim.scheme);
    } else if (matches.includes("error")) {
      errors.push(claim.scheme);
    } else {
      indeterminates.push(claim.scheme);
    }
  };
  for (const claim of requirement.required) classify(claim);
  for (const group of requirement.oneOf ?? []) {
    const groupDecisions = group.flatMap(decisionsFor);
    if (groupDecisions.includes("pass")) continue;
    if (groupDecisions.includes("error")) {
      errors.push("oneOf");
    } else if (groupDecisions.includes("indeterminate")) {
      indeterminates.push("oneOf");
    } else {
      failures.push("oneOf");
    }
  }
  if (failures.length > 0) return "fail";
  if (errors.length > 0) return "error";
  if (indeterminates.length > 0) return "indeterminate";
  return "pass";
}

export interface PresenceAwareVerifiedEvidence {
  requirement: CompositeClaimRequirement;
  decision: VerificationDecision;
  /** Exact claim whose authenticated VerifyResult supplied this decision. */
  claimRef: string;
  /** Exact record-committed result reference, when selector authorization uses it. */
  ref?: VerifyResultRef;
}

/**
 * Authenticated time evidence needed to apply the DACS-1 verified-claim
 * freshness window without resolving or trusting a presenter-supplied clock.
 */
export interface VerifiedClaimFreshnessInput {
  /** Acceptance/evaluation time in Unix milliseconds. */
  evaluatedAt: number;
  /** Authority time from the authenticated VerifyResult. */
  verifiedAt?: number;
  /** Optional authority upper bound from the authenticated VerifyResult. */
  validUntil?: number;
  /** Exact pinned recipe default, used only when validUntil is absent. */
  defaultMaxAgeSec?: number;
  /** Optional presenter clamp; it can narrow but never widen authority time. */
  presenterExpiresAt?: number;
  /** Optional listing clamp in seconds. */
  requirementMaxAgeSec?: number;
}

/**
 * Pure DACS-1 §6.3.2/PCR-4 effective-window classifier. Inputs are already
 * authenticated by the caller; malformed or unavailable authority time fails
 * closed and configuration/clock errors remain distinguishable as `error`.
 */
export function classifyVerifiedClaimFreshness(
  input: Readonly<VerifiedClaimFreshnessInput>,
): VerificationDecision {
  if (!isSafeUint(input.evaluatedAt)) return "error";
  if (
    input.requirementMaxAgeSec !== undefined &&
    !isSafeUint(input.requirementMaxAgeSec)
  ) {
    return "error";
  }
  if (
    input.defaultMaxAgeSec !== undefined &&
    !isSafeUint(input.defaultMaxAgeSec)
  ) {
    return "error";
  }
  if (!isSafeUint(input.verifiedAt)) return "fail";
  if (
    input.validUntil !== undefined &&
    (!isSafeUint(input.validUntil) || input.validUntil < input.verifiedAt)
  ) {
    return "fail";
  }
  if (
    input.presenterExpiresAt !== undefined &&
    !isSafeUint(input.presenterExpiresAt)
  ) {
    return "fail";
  }

  let authorityExpiry = input.validUntil;
  if (authorityExpiry === undefined) {
    if (input.defaultMaxAgeSec === undefined) return "fail";
    authorityExpiry = addSeconds(input.verifiedAt, input.defaultMaxAgeSec) ??
      undefined;
    if (authorityExpiry === undefined) return "fail";
  }
  const effectiveExpiry = input.presenterExpiresAt === undefined
    ? authorityExpiry
    : Math.min(authorityExpiry, input.presenterExpiresAt);
  if (input.evaluatedAt > effectiveExpiry) return "fail";

  if (input.requirementMaxAgeSec !== undefined) {
    const requirementExpiry = addSeconds(
      input.verifiedAt,
      input.requirementMaxAgeSec,
    );
    if (requirementExpiry === null || input.evaluatedAt > requirementExpiry) {
      return "fail";
    }
  }
  return "pass";
}

function strongestDecision(
  decisions: readonly VerificationDecision[],
): VerificationDecision {
  if (decisions.includes("pass")) return "pass";
  if (decisions.includes("fail") || decisions.length === 0) return "fail";
  if (decisions.includes("error")) return "error";
  return "indeterminate";
}

function combineConjunctiveDecisions(
  left: VerificationDecision,
  right: VerificationDecision,
): VerificationDecision {
  if (left === "fail" || right === "fail") return "fail";
  if (left === "error" || right === "error") return "error";
  if (left === "indeterminate" || right === "indeterminate") {
    return "indeterminate";
  }
  return "pass";
}

export interface PresenceAwareAggregationInput {
  bundle: IdentityBundle;
  requirement: CompositeBundleRequirement;
  evaluatedAt: number;
  verified: PresenceAwareVerifiedEvidence[];
  /** Scheme-specific DACS-1 control result; exact key control is inferred. */
  presentedClaimControlled?: boolean;
}

/** Pure PCR-1..PCR-6 mixed-mode decision after signatures/refs are authenticated. */
export function aggregatePresenceAwareCompositeVerification(
  input: Readonly<PresenceAwareAggregationInput>,
): VerificationDecision {
  const preflightFailure = presenceRequirementPreflight(input.requirement);
  if (preflightFailure || !isSafeUint(input.evaluatedAt)) return "error";
  const presenceMembers = [
    ...input.requirement.required,
    ...(input.requirement.oneOf ?? []).flat(),
  ].filter((member) => member.verificationRequired === false);
  const entries: Array<{
    requirement: CompositeClaimRequirement;
    effectiveDecision: VerificationDecision;
  }> = input.verified.map((entry) => ({
    requirement: entry.requirement,
    effectiveDecision: entry.decision,
  }));
  for (const member of presenceMembers) {
    entries.push({
      requirement: member,
      effectiveDecision: classifyPresenceClaimRequirement(
        input.bundle,
        member,
        input.evaluatedAt,
      ),
    });
  }
  let decision = aggregateBoundCompositeVerification(entries, input.requirement);
  const selector = input.requirement.primaryClaimSelector;
  if (selector === undefined) return decision;
  const parsedPresented = parseCanonicalClaimReference(input.bundle.presentedBy);
  const presentedMatches = input.bundle.claims.filter((claim) =>
    sameCanonicalClaimIdentity(claim.ref, input.bundle.presentedBy)
  );
  if (
    !parsedPresented ||
    parsedPresented.identity.scheme !== selector ||
    presentedMatches.length !== 1
  ) {
    return "fail";
  }
  const presented = presentedMatches[0]!;
  const controlled = parsedPresented.identity.scheme === "key" ||
    input.presentedClaimControlled === true;
  const exactVerifiedDecisions = presented.verifiedBy === undefined
    ? []
    : input.verified
      .filter((entry) =>
        entry.ref !== undefined &&
        sameCanonicalClaimIdentity(entry.claimRef, presented.ref) &&
        exactRef(entry.ref, presented.verifiedBy!)
      )
      .map((entry) => entry.decision);
  const verifiedSelector = strongestDecision(exactVerifiedDecisions);
  const presencePassesExact = (member: CompositeClaimRequirement): boolean =>
    member.scheme === selector &&
    member.verificationRequired === false &&
    classifyPresenceClaimRequirement(
      input.bundle,
      member,
      input.evaluatedAt,
      presented.ref,
    ) === "pass";
  const allMembers = [
    ...input.requirement.required,
    ...(input.requirement.oneOf ?? []).flat(),
  ];
  let presenceSelector = allMembers.some(presencePassesExact);
  if (input.requirement.required.some(
    (member) => member.scheme === selector && member.verificationRequired === true,
  )) {
    presenceSelector = false;
  }
  const verifiedDecision = (
    member: CompositeClaimRequirement,
  ): VerificationDecision => {
    const matches = input.verified
      .filter((entry) => {
        try {
          return canonicalize(entry.requirement) === canonicalize(member);
        } catch {
          return false;
        }
      })
      .map((entry) => entry.decision);
    if (matches.includes("pass")) return "pass";
    if (matches.includes("fail") || matches.length === 0) return "fail";
    if (matches.includes("error")) return "error";
    return "indeterminate";
  };
  for (const group of input.requirement.oneOf ?? []) {
    if (!group.some(
      (member) => member.scheme === selector && member.verificationRequired === true,
    )) {
      continue;
    }
    if (
      !group.some(presencePassesExact) &&
      !group.some(
        (member) =>
          member.scheme !== selector && verifiedDecision(member) === "pass",
      )
    ) {
      presenceSelector = false;
    }
  }
  const selectorDecision: VerificationDecision = !controlled
    ? "fail"
    : presenceSelector || verifiedSelector === "pass"
      ? "pass"
      : verifiedSelector;
  return combineConjunctiveDecisions(decision, selectorDecision);
}

function invalid(
  code: CompositeVerificationInvalidCode,
  detail?: string,
): StrictCompositeVerification {
  return { status: "invalid", code, ...(detail ? { detail } : {}) };
}

function unresolved(
  code: CompositeVerificationUnresolvedCode,
  detail?: string,
): StrictCompositeVerification {
  return { status: "unresolved", code, ...(detail ? { detail } : {}) };
}

function componentFailure(
  kind: "record-signature" | "verify-result-signature",
  status: Awaited<ReturnType<typeof verifyComponentSignature>>,
): StrictCompositeVerification {
  if (status.status === "unresolved") return unresolved(kind, status.reason);
  if (status.status === "missing") return invalid(kind, "missing");
  if (status.status === "valid") return invalid(kind, "unexpected valid status");
  return invalid(kind, status.reason);
}

interface MixedVerificationEntry {
  requirement: Readonly<CompositeClaimRequirement>;
  effectiveDecision: VerificationDecision;
  expected?: Readonly<ExpectedVerifyResult>;
  result?: Readonly<VerifyResult>;
}

function decisionForExactRequirement(
  requirement: Readonly<CompositeClaimRequirement>,
  entries: readonly MixedVerificationEntry[],
): VerificationDecision {
  let target: string;
  try {
    target = canonicalize(requirement);
  } catch {
    return "error";
  }
  const decisions = entries
    .filter((entry) => {
      try {
        return canonicalize(entry.requirement) === target;
      } catch {
        return false;
      }
    })
    .map((entry) => entry.effectiveDecision);
  if (decisions.includes("pass")) return "pass";
  if (decisions.includes("fail") || decisions.length === 0) return "fail";
  if (decisions.includes("error")) return "error";
  return "indeterminate";
}

async function exactPresenceSelectorAuthorized<TKey>(
  bundle: Readonly<IdentityBundle>,
  requirement: Readonly<CompositeBundleRequirement>,
  entries: readonly MixedVerificationEntry[],
  evaluatedAt: number,
  deps: VerifyCompositeVerificationDeps<TKey>,
): Promise<VerificationDecision> {
  const selector = requirement.primaryClaimSelector;
  if (selector === undefined) return "pass";
  const parsedPresented = parseCanonicalClaimReference(bundle.presentedBy);
  if (!parsedPresented || parsedPresented.identity.scheme !== selector) {
    return "fail";
  }
  const presentedMatches = bundle.claims.filter((claim) =>
    sameCanonicalClaimIdentity(claim.ref, bundle.presentedBy)
  );
  if (presentedMatches.length !== 1) return "fail";
  const presented = presentedMatches[0]!;
  let controlled = parsedPresented.identity.scheme === "key";
  if (!controlled && deps.isPresentedClaimControlled) {
    try {
      controlled = (await deps.isPresentedClaimControlled({ bundle, claim: presented })) === true;
    } catch {
      controlled = false;
    }
  }

  const verifiedSelector = strongestDecision(
    presented.verifiedBy === undefined
      ? []
      : entries
        .filter((entry) =>
          entry.expected !== undefined &&
          exactRef(entry.expected.ref, presented.verifiedBy!) &&
          entry.expected.scheme === parsedPresented.identity.scheme &&
          entry.expected.identifier === parsedPresented.identity.identifier
        )
        .map((entry) => entry.effectiveDecision),
  );

  const presencePassesExact = (member: CompositeClaimRequirement): boolean =>
    member.scheme === selector &&
    member.verificationRequired === false &&
    classifyPresenceClaimRequirement(
      bundle,
      member,
      evaluatedAt,
      presented.ref,
    ) === "pass";
  const members = [
    ...requirement.required,
    ...(requirement.oneOf ?? []).flat(),
  ];
  let presenceSelector = members.some(presencePassesExact);
  if (requirement.required.some(
    (member) => member.scheme === selector && member.verificationRequired === true,
  )) {
    presenceSelector = false;
  }
  for (const group of requirement.oneOf ?? []) {
    if (!group.some(
      (member) => member.scheme === selector && member.verificationRequired === true,
    )) {
      continue;
    }
    const exactPresenceInGroup = group.some(presencePassesExact);
    const passingOtherScheme = group.some(
      (member) =>
        member.scheme !== selector &&
        decisionForExactRequirement(member, entries) === "pass",
    );
    if (!exactPresenceInGroup && !passingOtherScheme) presenceSelector = false;
  }
  if (!controlled) return "fail";
  if (presenceSelector || verifiedSelector === "pass") return "pass";
  return verifiedSelector;
}

async function resolveResult<TKey>(
  ref: VerifyResultRef,
  expected: ExpectedVerifyResult,
  deps: VerifyCompositeVerificationDeps<TKey>,
): Promise<
  | StrictCompositeVerification
  | {
      status: "resolved";
      result: VerifyResult;
      recipe: RecipeDescriptor & { signature: ComponentSignature };
      /** RAV-3 aggregation verdict without rewriting signed evidence. */
      effectiveDecision: VerificationDecision;
    }
  | {
      status: "indeterminate";
      recipe: RecipeDescriptor & { signature: ComponentSignature };
      detail?: string;
    }
> {
  // Snapshot resolver-owned evidence before invoking any further callback. We
  // still defer its availability/shape classification until after CRQ-1 recipe
  // authentication so an invalid registry cannot be masked by missing data.
  let resolvedSnapshot: ResolvedVerificationContent | null = null;
  let resolutionDetail: string | undefined;
  let resolutionReturnedValue = false;
  try {
    const rawResolved = await deps.resolve(
      deepFreezeSnapshot(structuredClone(ref)),
    );
    if (rawResolved) {
      resolutionReturnedValue = true;
      resolvedSnapshot = cloneResolvedContent(rawResolved);
    } else {
      resolutionDetail = ref.anchor.locator;
    }
  } catch (error) {
    resolutionDetail = String(error);
  }

  // CRQ-1 authenticates the selected recipe family before evidence
  // availability is classified. An unavailable result therefore cannot mask
  // an invalid or unavailable session-pinned registry entry.
  let rawRecipe: (RecipeDescriptor & { signature: ComponentSignature }) | null;
  try {
    rawRecipe = await deps.resolveRecipe(
      deepFreezeSnapshot({
        scheme: expected.scheme,
        method: expected.method,
        recipeVersion: ref.recipeVersion,
      }),
    );
  } catch (error) {
    return unresolved("recipe-resolution", String(error));
  }
  if (!rawRecipe) {
    return unresolved(
      "recipe-resolution",
      `${expected.scheme}/${expected.method}/v${ref.recipeVersion}`,
    );
  }
  // Reject hostile/prototype/accessor-bearing resolver values before snapshot;
  // cloning first would erase exactly the distinctions signed wire guards must
  // enforce.
  if (!isRecord(rawRecipe) || !isRecipeDescriptor(rawRecipe)) {
    return invalid("recipe-shape");
  }
  let recipeSnapshot: unknown;
  try {
    recipeSnapshot = deepFreezeSnapshot(structuredClone(rawRecipe));
  } catch {
    return invalid("recipe-shape", "resolved recipe is not snapshot-safe");
  }
  if (!isRecord(recipeSnapshot) || !isRecipeDescriptor(recipeSnapshot)) {
    return invalid("recipe-shape");
  }
  const recipe = recipeSnapshot;
  const recipeMethods = [recipe.defaultMethod, ...(recipe.alternatives ?? [])];
  const requirementMethod = expected.requirement.parameters?.verificationMethod;
  if (
    recipe.scheme !== expected.scheme ||
    recipe.recipeVersion !== ref.recipeVersion ||
    (requirementMethod === undefined
      ? expected.method !== recipe.defaultMethod.kind
      : requirementMethod !== expected.method) ||
    recipeMethods.filter((method) => method.kind === expected.method).length !== 1
  ) {
    return invalid("verify-result-recipe", "resolved recipe family does not match result");
  }
  const recipeSignature = await verifyComponentSignature(
    recipe as unknown as Record<string, unknown>,
    "dacs-recipe:v1:",
    {
      isSignerAuthorized: (_artifact, signature) =>
        deps.isRecipeSignerAuthorized(recipe, signature),
      resolvePublicKey: deps.resolvePublicKey,
      verify: deps.verify,
    },
  );
  if (recipeSignature.status !== "valid") {
    if (recipeSignature.status === "unresolved") {
      return unresolved("recipe-signature", recipeSignature.reason);
    }
    return invalid(
      "recipe-signature",
      recipeSignature.status === "missing" ? "missing" : recipeSignature.reason,
    );
  }

  if (!resolutionReturnedValue) {
    return {
      status: "indeterminate",
      recipe: structuredClone(recipe),
      ...(resolutionDetail ? { detail: resolutionDetail } : {}),
    };
  }
  if (
    !resolvedSnapshot ||
    resolvedSnapshot.encoding !== "canonical-json" ||
    !isVerifyResult(resolvedSnapshot.value)
  ) {
    return invalid("verify-result-shape", ref.anchor.locator);
  }
  const result = deepFreezeSnapshot(resolvedSnapshot.value);
  let hash: string;
  try {
    hash = contentHash(result);
  } catch (error) {
    return invalid("verify-result-shape", String(error));
  }
  if (hash !== ref.contentHash) return invalid("verify-result-hash", ref.anchor.locator);
  if (result.recipeVersion !== ref.recipeVersion) {
    return invalid("verify-result-recipe", ref.anchor.locator);
  }
  if (
    expected.requirement.recipeVersion !== undefined &&
    result.recipeVersion !== expected.requirement.recipeVersion
  ) {
    return invalid("verify-result-recipe", ref.anchor.locator);
  }
  if (result.method !== expected.method) {
    return invalid("verify-result-method", ref.anchor.locator);
  }
  if (result.scheme !== expected.scheme || result.identifier !== expected.identifier) {
    return invalid("verify-result-claim", ref.anchor.locator);
  }

  const signature = await verifyComponentSignature(
    result as unknown as Record<string, unknown>,
    "dacs-verifyresult:v1:",
    {
      isSignerAuthorized: (_artifact, candidate) =>
        deps.isVerifyResultSignerAuthorized(result, candidate, expected),
      resolvePublicKey: deps.resolvePublicKey,
      verify: deps.verify,
    },
  );
  if (signature.status !== "valid") {
    return componentFailure("verify-result-signature", signature);
  }

  let rawAttestation: ResolvedVerificationContent | null;
  try {
    rawAttestation = await deps.resolve(
      deepFreezeSnapshot(structuredClone(result.attestation)),
    );
  } catch (error) {
    return unresolved("authority-resolution", String(error));
  }
  if (!rawAttestation) {
    return unresolved("authority-resolution", result.attestation.anchor.locator);
  }
  const attestation = cloneResolvedContent(rawAttestation);
  if (!attestation) {
    return invalid("authority-hash", "unsupported resolved-content variant");
  }
  let authorityHash: string;
  try {
    authorityHash =
      attestation.encoding === "bytes"
        ? sha256Hex(attestation.value)
        : sha256Hex(canonicalize(attestation.value));
  } catch (error) {
    return invalid("authority-hash", String(error));
  }
  if (authorityHash !== result.attestation.contentHash) {
    return invalid("authority-hash", result.attestation.anchor.locator);
  }
  let authority: AuthorityVerification;
  try {
    const authorityInput: VerifyAuthorityAttestationInput = {
      result: deepFreezeSnapshot(structuredClone(result)),
      expected: deepFreezeSnapshot(structuredClone(expected)),
      recipe: deepFreezeSnapshot(structuredClone(recipe)),
      content: attestation.encoding === "bytes"
        ? { encoding: "bytes", value: Uint8Array.from(attestation.value) }
        : {
            encoding: "canonical-json",
            value: deepFreezeSnapshot(structuredClone(attestation.value)),
          },
    };
    authority = await deps.verifyAuthorityAttestation(authorityInput);
  } catch (error) {
    return unresolved("authority-signature", String(error));
  }
  if (authority === "unresolved") return unresolved("authority-signature");
  if (authority !== "valid") return invalid("authority-signature");
  if (expected.requirement.parameters !== undefined) {
    if (!deps.verifyRequirementParameters) {
      return unresolved(
        "requirement-parameters",
        "parameterized requirement has no verifier",
      );
    }
    let parametersMatch = false;
    try {
      parametersMatch =
        (await deps.verifyRequirementParameters({
          result: deepFreezeSnapshot(structuredClone(result)),
          expected: deepFreezeSnapshot(structuredClone(expected)),
          recipe: deepFreezeSnapshot(structuredClone(recipe)),
          content: attestation.encoding === "bytes"
            ? { encoding: "bytes", value: Uint8Array.from(attestation.value) }
            : {
                encoding: "canonical-json",
                value: deepFreezeSnapshot(structuredClone(attestation.value)),
              },
        })) === true;
    } catch (error) {
      return unresolved("requirement-parameters", String(error));
    }
    // §7.6 step 7: an authenticated parameter mismatch is a legitimate
    // verification outcome, but it MUST force decision=fail. Reject elevation
    // to pass/error/indeterminate; accept the producer's signed fail result.
    if (!parametersMatch && result.decision !== "fail") {
      return invalid("requirement-parameters");
    }
  }
  const effectiveDecision: VerificationDecision =
    recipe.availability === "disabled" ||
    recipe.availability === "failed" ||
    recipe.availability === "mocked"
      ? "error"
      : result.decision;
  return {
    status: "resolved",
    result: structuredClone(result),
    recipe: structuredClone(recipe),
    effectiveDecision,
  };
}

/**
 * Strict DACS-2 §7.7 closure verification. A shape-only pass is never enough:
 * all bindings, signatures, referenced results, method-native attestations and
 * the deterministic aggregation are independently reproduced.
 */
export async function verifyCompositeVerificationRecord<TKey>(
  value: unknown,
  expected: Readonly<CompositeVerificationExpectations>,
  deps: VerifyCompositeVerificationDeps<TKey>,
): Promise<StrictCompositeVerification> {
  // Validate the caller-owned object before structuredClone. In particular, a
  // getter-backed legacy/current hybrid or custom prototype must not be
  // normalised into a valid-looking current record by the snapshot operation.
  if (isLegacyCompositeVerificationRecord(value)) return invalid("legacy-record");
  if (!isCompositeVerificationRecord(value)) return invalid("record-shape");
  let valueSnapshot: unknown;
  try {
    valueSnapshot = structuredClone(value);
  } catch {
    return invalid("record-shape", "record is not snapshot-safe");
  }
  if (!isCompositeVerificationRecord(valueSnapshot)) return invalid("record-shape");
  const record = deepFreezeSnapshot(valueSnapshot);

  if (!isCompositeVerificationExpectations(expected)) {
    return invalid("expectation-shape");
  }
  let expectedSnapshot: CompositeVerificationExpectations;
  try {
    expectedSnapshot = deepFreezeSnapshot(structuredClone(expected));
  } catch {
    return invalid("expectation-shape", "expectations are not snapshot-safe");
  }
  const capturedDeps = captureVerificationDeps(deps);
  if (!capturedDeps) {
    return unresolved("verification-dependency", "verification callbacks are unavailable");
  }

  if (!isCompositeVerificationExpectations(expectedSnapshot)) {
    return invalid("expectation-shape");
  }

  const presenceMembers = [
    ...expectedSnapshot.requirement.required,
    ...(expectedSnapshot.requirement.oneOf ?? []).flat(),
  ].filter((member) => member.verificationRequired === false);
  if (presenceMembers.length > 0) {
    if (expectedSnapshot.presence === undefined) {
      return invalid("expectation-shape", "presence authority is required");
    }
    const preflightFailure = presenceRequirementPreflight(
      expectedSnapshot.requirement,
    );
    if (preflightFailure) return invalid("expectation-shape", preflightFailure);
  }

  if (record.jobId !== expectedSnapshot.jobId) return invalid("job-mismatch");
  if (record.evaluatedParty !== expectedSnapshot.evaluatedParty) {
    return invalid("evaluated-party-mismatch");
  }
  if (record.bundleHash !== expectedSnapshot.bundleHash) {
    return invalid("bundle-hash-mismatch");
  }

  let requirementHash: string;
  try {
    requirementHash = sha256Hex(canonicalize(expectedSnapshot.requirement));
  } catch (error) {
    return invalid("expectation-shape", String(error));
  }
  if (record.requirementHash !== requirementHash) {
    return invalid("requirement-hash-mismatch");
  }
  if (!expectedListMatches(
    record.freshness,
    expectedSnapshot.freshness,
    expectedSnapshot.requirement,
  )) {
    return invalid("freshness-substitution");
  }
  if (!expectedListMatches(
    record.dealSpecific,
    expectedSnapshot.dealSpecific,
    expectedSnapshot.requirement,
  )) {
    return invalid("deal-specific-substitution");
  }

  const recordSignature = await verifyComponentSignature(
    record as unknown as Record<string, unknown>,
    "dacs-composite:v1:",
    {
      isSignerAuthorized: (_artifact, signature) =>
        signature.signer === expectedSnapshot.verifier,
      resolvePublicKey: capturedDeps.resolvePublicKey,
      verify: capturedDeps.verify,
    },
  );
  if (recordSignature.status !== "valid") {
    return componentFailure("record-signature", recordSignature);
  }

  let presenceBundle: IdentityBundle | null = null;
  if (presenceMembers.length > 0) {
    const presence = expectedSnapshot.presence!;
    if (!capturedDeps.isSessionRecipeRegistrySnapshotAuthenticated) {
      return invalid("recipe-registry", "registry authentication is unavailable");
    }
    let registryAuthenticated = false;
    try {
      registryAuthenticated = (
        await capturedDeps.isSessionRecipeRegistrySnapshotAuthenticated(
          presence.sessionRecipeRegistrySnapshotHash,
        )
      ) === true;
    } catch {
      registryAuthenticated = false;
    }
    if (!registryAuthenticated) {
      return invalid("recipe-registry", "session-pinned registry is unavailable or invalid");
    }
    if (presence.bundle === null) {
      return unresolved("identity-bundle", "exact PCR-6 companion bundle is unavailable");
    }
    presenceBundle = presence.bundle;
    if (
      identityBundleHash(presenceBundle) !== record.bundleHash ||
      identityBundleHash(presenceBundle) !== expectedSnapshot.bundleHash
    ) {
      return invalid("bundle-hash-mismatch");
    }
    if (!sameCanonicalClaimIdentity(
      presenceBundle.presentedBy,
      record.evaluatedParty,
    )) {
      return invalid("identity-bundle", "bundle presenter differs from evaluated party");
    }
    if (!capturedDeps.verifyIdentityPresentation) {
      return invalid("identity-presentation", "presentation verifier is unavailable");
    }
    let presentationValid = false;
    try {
      presentationValid = (
        await capturedDeps.verifyIdentityPresentation({
          bundle: presenceBundle,
          bundleHash: record.bundleHash,
        })
      ) === true;
    } catch {
      presentationValid = false;
    }
    if (!presentationValid) return invalid("identity-presentation");
  }

  const freshness: VerifyResult[] = [];
  const freshnessRecipes: Array<RecipeDescriptor & { signature: ComponentSignature }> = [];
  const freshnessExpected: ExpectedVerifyResult[] = [];
  const mixedEntries: MixedVerificationEntry[] = [];
  const indeterminateEvidence: Array<{
    collection: "freshness" | "dealSpecific";
    index: number;
    ref: VerifyResultRef;
    detail?: string;
  }> = [];
  for (let index = 0; index < record.freshness.length; index += 1) {
    const ref = record.freshness[index]!;
    const expected = expectedSnapshot.freshness[index]!;
    const resolution = await resolveResult(
      ref,
      expected,
      capturedDeps,
    );
    if (resolution.status === "indeterminate") {
      mixedEntries.push({
        requirement: expected.requirement,
        expected,
        effectiveDecision: "indeterminate",
      });
      indeterminateEvidence.push({
        collection: "freshness",
        index,
        ref: structuredClone(ref),
        ...(resolution.detail ? { detail: resolution.detail } : {}),
      });
      continue;
    }
    if (resolution.status !== "resolved") return resolution;
    freshness.push(resolution.result);
    freshnessRecipes.push(resolution.recipe);
    freshnessExpected.push(expected);
    mixedEntries.push({
      requirement: expected.requirement,
      expected,
      result: resolution.result,
      effectiveDecision: resolution.effectiveDecision,
    });
  }

  const dealSpecific: VerifyResult[] = [];
  const dealSpecificRecipes: Array<RecipeDescriptor & { signature: ComponentSignature }> = [];
  const dealSpecificExpected: ExpectedVerifyResult[] = [];
  for (let index = 0; index < record.dealSpecific.length; index += 1) {
    const ref = record.dealSpecific[index]!;
    const expected = expectedSnapshot.dealSpecific[index]!;
    const resolution = await resolveResult(
      ref,
      expected,
      capturedDeps,
    );
    if (resolution.status === "indeterminate") {
      mixedEntries.push({
        requirement: expected.requirement,
        expected,
        effectiveDecision: "indeterminate",
      });
      indeterminateEvidence.push({
        collection: "dealSpecific",
        index,
        ref: structuredClone(ref),
        ...(resolution.detail ? { detail: resolution.detail } : {}),
      });
      continue;
    }
    if (resolution.status !== "resolved") return resolution;
    dealSpecific.push(resolution.result);
    dealSpecificRecipes.push(resolution.recipe);
    dealSpecificExpected.push(expected);
    mixedEntries.push({
      requirement: expected.requirement,
      expected,
      result: resolution.result,
      effectiveDecision: resolution.effectiveDecision,
    });
  }

  let acceptanceTime: number;
  try {
    acceptanceTime = capturedDeps.nowMs();
  } catch (error) {
    return unresolved("verification-time", String(error));
  }
  if (!isSafeUint(acceptanceTime)) {
    return unresolved(
      "verification-time",
      "acceptance clock must return a non-negative safe integer",
    );
  }
  for (let index = 0; index < freshness.length; index += 1) {
    const timeFailure = validateResultTime(
      freshness[index]!,
      freshnessExpected[index]!,
      freshnessRecipes[index]!,
      acceptanceTime,
    );
    if (timeFailure) return timeFailure;
  }
  for (let index = 0; index < dealSpecific.length; index += 1) {
    const timeFailure = validateResultTime(
      dealSpecific[index]!,
      dealSpecificExpected[index]!,
      dealSpecificRecipes[index]!,
      acceptanceTime,
    );
    if (timeFailure) return timeFailure;
  }
  const latestResultTime = Math.max(
    0,
    ...freshness.map((result) => result.verifiedAt),
    ...freshness.map((result) => result.fetchedAt),
    ...dealSpecific.map((result) => result.verifiedAt),
    ...dealSpecific.map((result) => result.fetchedAt),
  );
  if (record.generatedAt < latestResultTime) {
    return invalid(
      "record-time",
      `generatedAt ${record.generatedAt} precedes a VerifyResult at ${latestResultTime}`,
    );
  }
  if (record.generatedAt > acceptanceTime) {
    return invalid(
      "record-time",
      `generatedAt ${record.generatedAt} exceeds acceptance time ${acceptanceTime}`,
    );
  }

  if (presenceBundle) {
    for (const member of presenceMembers) {
      mixedEntries.push({
        requirement: member,
        effectiveDecision: classifyPresenceClaimRequirement(
          presenceBundle,
          member,
          acceptanceTime,
        ),
      });
    }
  }
  let aggregated = aggregateBoundCompositeVerification(
    mixedEntries,
    expectedSnapshot.requirement,
  );
  if (presenceBundle) {
    const selectorDecision = await exactPresenceSelectorAuthorized(
      presenceBundle,
      expectedSnapshot.requirement,
      mixedEntries,
      acceptanceTime,
      capturedDeps,
    );
    aggregated = combineConjunctiveDecisions(aggregated, selectorDecision);
  }
  if (!DECISIONS.includes(record.overallDecision) || record.overallDecision !== aggregated) {
    return invalid(
      "aggregation-mismatch",
      `record=${record.overallDecision}; recomputed=${aggregated}`,
    );
  }

  return structuredClone({
    status: "valid",
    record,
    freshness,
    dealSpecific,
    freshnessRecipes,
    dealSpecificRecipes,
    ...(indeterminateEvidence.length > 0 ? { indeterminateEvidence } : {}),
  });
}

/**
 * Hash-check the response returned by the producer's injected anchor transport.
 * This is deliberately an internal construction helper: shape and hash equality
 * alone are not independent proof that an arbitrary caller actually anchored
 * the result.
 */
export function verifyResultRefFromAnchor(
  result: Readonly<VerifyResult>,
  anchored: Readonly<AttestationRef>,
): VerifyResultRef {
  if (!isVerifyResult(result) || !isAttestationRef(anchored)) {
    throw new TypeError("current VerifyResult and AttestationRef are required");
  }
  const expectedHash = contentHash(result as unknown as Record<string, unknown>);
  if (anchored.contentHash !== expectedHash) {
    throw new TypeError("anchored VerifyResult contentHash does not match its signed scope");
  }
  return {
    anchor: anchored.anchor,
    contentHash: anchored.contentHash,
    recipeVersion: result.recipeVersion,
  };
}

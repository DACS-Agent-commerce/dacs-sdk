import { types as nodeTypes } from "node:util";

import type {
  ComponentSignature,
  IdentityBundle,
  SupplementarySignal,
  VerificationDecision,
  VerificationMethodKind,
  VerificationWarning,
  VerifyResult,
} from "../artifacts/types.js";
import {
  isIdentityBundle,
  isSupplementarySignal,
  isVerificationWarning,
  isVerifyResult,
} from "../artifacts/validators.js";
import {
  canonicalize,
  contentHash,
  encodeAddressSegment,
  sha256Hex,
} from "../canonical/index.js";
import { DacsError } from "../errors.js";
import { identityBundleHash } from "../identity/index.js";
import {
  isDurableSessionRecipePin,
  type DurableSessionRecipePin,
} from "./durableRecipePin.js";
import type { VerificationMethod } from "../registry/types.js";
import {
  isCompositeBundleRequirement,
  type CompositeBundleRequirement,
  type CompositeClaimRequirement,
} from "./compositeVerification.js";

/** Exact location of one ClaimRequirement inside a party-level requirement. */
export type PartyVetRequirementPath =
  | { kind: "required"; index: number }
  | { kind: "oneOf"; groupIndex: number; alternativeIndex: number };

export type PartyVetMethodInput =
  | {
      kind: "self-signed";
      assertion: string;
      signature: string;
    }
  | { kind: "consensus-backed-proxy" }
  | {
      kind: Exclude<
        VerificationMethodKind,
        "self-signed" | "consensus-backed-proxy"
      >;
      input: Record<string, unknown>;
    };

type PartyVetSignedRecipe = DurableSessionRecipePin["provenance"]["recipe"];

/** Exact serializable evidence copied from #143's runtime-authenticated pin. */
export type PartyVetRecipePinBinding = Pick<
  DurableSessionRecipePin,
  Extract<keyof DurableSessionRecipePin, string>
>;

export interface PartyVetAttemptInput {
  requirementPath: PartyVetRequirementPath;
  /** Exact claim carried by the evaluated party's IdentityBundle. */
  claimSubject: string;
  classification: "freshness" | "dealSpecific";
  /** Exact method selected from the authenticated recipe family. */
  methodInput: PartyVetMethodInput;
  /** Generation-fenced #143 pin established before any Vet effect. */
  recipePin: DurableSessionRecipePin;
}

export interface PartyVetPlanInput {
  jobId: string;
  evaluatedParty: string;
  /** Exact, already presentation-verified bundle evaluated by this plan. */
  identityBundle: IdentityBundle;
  requirement: CompositeBundleRequirement;
  verifier: Pick<ComponentSignature, "algorithm" | "signer">;
  attempts: PartyVetAttemptInput[];
  supplementary?: SupplementarySignal[];
  warnings?: VerificationWarning[];
}

export interface PartyVetPlannedRequirement {
  requirementPath: PartyVetRequirementPath;
  requirement: CompositeClaimRequirement;
  disposition: "attempt" | "presence-pass" | "absent";
  attemptId?: string;
}

export interface PartyVetRequirementAttempt {
  index: number;
  attemptId: string;
  operationKey: string;
  resultAddress: string;
  requirementPath: PartyVetRequirementPath;
  requirement: CompositeClaimRequirement;
  claimSubject: string;
  classification: "freshness" | "dealSpecific";
  method: VerificationMethod;
  methodInput: PartyVetMethodInput;
  methodInputHash: string;
  recipe: PartyVetSignedRecipe;
  recipePin: PartyVetRecipePinBinding;
  recipeFamily: {
    scheme: string;
    defaultMethod: VerificationMethodKind;
  };
  recipeVersion: number;
  recipeContentHash: string;
  recipeArtifactHash: string;
  registryProvenance: DurableSessionRecipePin["provenance"];
}

export interface PartyVetPlan {
  planVersion: "1";
  planHash: string;
  jobId: string;
  evaluatedParty: string;
  identityBundle: IdentityBundle;
  bundleHash: string;
  requirement: CompositeBundleRequirement;
  requirementHash: string;
  verifier: Pick<ComponentSignature, "algorithm" | "signer">;
  recordAddress: string;
  requirementPaths: PartyVetPlannedRequirement[];
  attempts: PartyVetRequirementAttempt[];
  supplementary: SupplementarySignal[];
  warnings?: VerificationWarning[];
}

export interface PartyVetAttemptOutcome {
  attemptId: string;
  /**
   * Exact locally-produced result. This planner checks wire and plan bindings;
   * the durable producer remains responsible for signature verification,
   * finalized anchoring and authenticated readback before CVR publication.
   */
  result: VerifyResult;
}

export type PartyVetExecutionState =
  | {
      status: "pending";
      nextAttempt: PartyVetRequirementAttempt;
      completed: PartyVetAttemptOutcome[];
      skippedAttemptIds: string[];
    }
  | {
      status: "complete";
      overallDecision: VerificationDecision;
      completed: PartyVetAttemptOutcome[];
      freshness: VerifyResult[];
      dealSpecific: VerifyResult[];
      skippedAttemptIds: string[];
    };

const partyVetPlans = new WeakSet<object>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function exactDataKeys(
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
    if (keys.some((key) => typeof key !== "string")) return false;
    if (!required.every((key) => keys.includes(key))) return false;
    if (!keys.every((key) => typeof key === "string" && allowed.has(key))) {
      return false;
    }
    return keys.every((key) => {
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

function snapshotData(
  value: unknown,
  label: string,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value !== "object") {
    if (
      value === undefined ||
      typeof value === "function" ||
      typeof value === "symbol" ||
      typeof value === "bigint" ||
      (typeof value === "number" && !Number.isFinite(value))
    ) {
      throw new DacsError(`${label} must contain canonical JSON data`);
    }
    return value;
  }
  if (seen.has(value)) throw new DacsError(`${label} must be acyclic`);
  if (nodeTypes.isProxy(value)) throw new DacsError(`${label} cannot contain proxies`);
  seen.add(value);
  let descriptors: PropertyDescriptorMap;
  let prototype: object | null;
  let symbols: symbol[];
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    throw new DacsError(`${label} could not be captured`);
  }
  if (symbols.length !== 0) {
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
    const result = keys.map((key) => {
      const descriptor = descriptors[key]!;
      if (descriptor.enumerable !== true || !("value" in descriptor)) {
        throw new DacsError(`${label} cannot contain accessors`);
      }
      return snapshotData(descriptor.value, label, seen);
    });
    seen.delete(value);
    return result;
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new DacsError(`${label} must contain only plain records`);
  }
  const result: Record<string, unknown> = prototype === null
    ? Object.create(null) as Record<string, unknown>
    : {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new DacsError(`${label} cannot contain accessors or hidden fields`);
    }
    Object.defineProperty(result, key, {
      value: snapshotData(descriptor.value, label, seen),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  seen.delete(value);
  return result;
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

function snapshot<T>(value: T, label: string): T {
  return deepFreeze(snapshotData(value, label) as T);
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  try {
    return canonicalize(left) === canonicalize(right);
  } catch {
    return false;
  }
}

function claimParts(claim: string, label: string): {
  scheme: string;
  identifier: string;
} {
  if (
    typeof claim !== "string" ||
    claim.length === 0 ||
    claim.normalize("NFC") !== claim ||
    /[\u0000-\u001f\u007f\s]/.test(claim)
  ) {
    throw new DacsError(`${label} must be a canonical ClaimReference`);
  }
  const colon = claim.indexOf(":");
  if (colon <= 0 || !/^[a-z][a-z0-9-]*$/.test(claim.slice(0, colon))) {
    throw new DacsError(`${label} must be a canonical ClaimReference`);
  }
  const scheme = claim.slice(0, colon);
  const identifier = claim.slice(colon + 1).split("?", 1)[0]!;
  if (!identifier) {
    throw new DacsError(`${label} ClaimReference has no identifier`);
  }
  return { scheme, identifier };
}

function nonEmptyNfc(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.normalize("NFC") !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new DacsError(`${label} must be a non-empty NFC string`);
  }
  return value;
}

function requirementAt(
  requirement: Readonly<CompositeBundleRequirement>,
  path: Readonly<PartyVetRequirementPath>,
): CompositeClaimRequirement | null {
  if (path.kind === "required") {
    return requirement.required[path.index] ?? null;
  }
  return requirement.oneOf?.[path.groupIndex]?.[path.alternativeIndex] ?? null;
}

function pathKey(path: Readonly<PartyVetRequirementPath>): string {
  return path.kind === "required"
    ? `required:${path.index}`
    : `oneOf:${path.groupIndex}:${path.alternativeIndex}`;
}

function capturePath(value: unknown): PartyVetRequirementPath {
  if (!isRecord(value)) {
    throw new DacsError("party Vet requirement path must be an exact record");
  }
  if (
    exactDataKeys(value, ["kind", "index"]) &&
    value.kind === "required" &&
    Number.isSafeInteger(value.index) &&
    (value.index as number) >= 0
  ) {
    return Object.freeze({ kind: "required", index: value.index as number });
  }
  if (
    exactDataKeys(value, ["kind", "groupIndex", "alternativeIndex"]) &&
    value.kind === "oneOf" &&
    Number.isSafeInteger(value.groupIndex) &&
    (value.groupIndex as number) >= 0 &&
    Number.isSafeInteger(value.alternativeIndex) &&
    (value.alternativeIndex as number) >= 0
  ) {
    return Object.freeze({
      kind: "oneOf",
      groupIndex: value.groupIndex as number,
      alternativeIndex: value.alternativeIndex as number,
    });
  }
  throw new DacsError("party Vet requirement path is malformed");
}

function exactMethod(
  recipe: Readonly<PartyVetSignedRecipe>,
  kind: VerificationMethodKind,
): VerificationMethod {
  const matches = [recipe.defaultMethod, ...(recipe.alternatives ?? [])]
    .filter((method) => method.kind === kind);
  if (matches.length !== 1) {
    throw new DacsError(
      `authenticated recipe does not unambiguously authorize method ${kind}`,
    );
  }
  return snapshot(
    matches[0]!,
    "party Vet verification method",
  ) as unknown as VerificationMethod;
}

function resultAddress(
  jobId: string,
  claimSubject: string,
  recipeVersion: number,
): string {
  const { scheme, identifier } = claimParts(claimSubject, "party Vet claim subject");
  return (
    `dacs2:${encodeAddressSegment(jobId)}:${scheme}:` +
    `${encodeAddressSegment(identifier)}:v${recipeVersion}`
  );
}

/** DACS-2 §7.7.2 exact party-level composite address. */
export function partyVetCompositeAddress(
  jobId: string,
  evaluatedParty: string,
): string {
  nonEmptyNfc(jobId, "party Vet jobId");
  claimParts(evaluatedParty, "party Vet evaluatedParty");
  return (
    `dacs2:composite:${encodeAddressSegment(jobId)}:` +
    encodeAddressSegment(evaluatedParty)
  );
}

function carriedClaimsByScheme(bundle: Readonly<IdentityBundle>): Map<string, string[]> {
  const claims = new Map<string, string[]>();
  for (const claim of bundle.claims) {
    const { scheme } = claimParts(claim.ref, "IdentityBundle claim");
    const entries = claims.get(scheme) ?? [];
    entries.push(claim.ref);
    claims.set(scheme, entries);
  }
  return claims;
}

function expectedAttemptPaths(
  requirement: Readonly<CompositeBundleRequirement>,
  claims: ReadonlyMap<string, readonly string[]>,
): {
  paths: PartyVetRequirementPath[];
  requirementPaths: Array<{
    requirementPath: PartyVetRequirementPath;
    requirement: CompositeClaimRequirement;
    disposition: "attempt" | "presence-pass" | "absent";
  }>;
} {
  const paths: PartyVetRequirementPath[] = [];
  const requirementPaths: Array<{
    requirementPath: PartyVetRequirementPath;
    requirement: CompositeClaimRequirement;
    disposition: "attempt" | "presence-pass" | "absent";
  }> = [];
  for (let index = 0; index < requirement.required.length; index += 1) {
    const claim = requirement.required[index]!;
    const carried = (claims.get(claim.scheme)?.length ?? 0) > 0;
    const requirementPath = { kind: "required" as const, index };
    if (!claim.verificationRequired) {
      if (claim.parameters !== undefined) {
        throw new DacsError(
          "presence-only parameter matching requires a scheme authenticator before party Vet planning",
        );
      }
      requirementPaths.push({
        requirementPath,
        requirement: claim,
        disposition: carried ? "presence-pass" : "absent",
      });
      continue;
    }
    requirementPaths.push({
      requirementPath,
      requirement: claim,
      disposition: carried ? "attempt" : "absent",
    });
    if (carried) paths.push(requirementPath);
  }

  for (let groupIndex = 0; groupIndex < (requirement.oneOf?.length ?? 0); groupIndex += 1) {
    const group = requirement.oneOf![groupIndex]!;
    for (let alternativeIndex = 0; alternativeIndex < group.length; alternativeIndex += 1) {
      const claim = group[alternativeIndex]!;
      const carried = (claims.get(claim.scheme)?.length ?? 0) > 0;
      const requirementPath = {
        kind: "oneOf" as const,
        groupIndex,
        alternativeIndex,
      };
      if (!claim.verificationRequired) {
        if (claim.parameters !== undefined) {
          throw new DacsError(
            "presence-only parameter matching requires a scheme authenticator before party Vet planning",
          );
        }
        requirementPaths.push({
          requirementPath,
          requirement: claim,
          disposition: carried ? "presence-pass" : "absent",
        });
        continue;
      }
      requirementPaths.push({
        requirementPath,
        requirement: claim,
        disposition: carried ? "attempt" : "absent",
      });
      if (carried) paths.push(requirementPath);
    }
  }
  return { paths, requirementPaths };
}

function captureMethodInput(
  value: unknown,
  index: number,
): PartyVetMethodInput {
  if (!isRecord(value)) {
    throw new DacsError(`party Vet attempt ${index} methodInput must be exact`);
  }
  const captured = snapshot(value, `party Vet attempt ${index} methodInput`);
  if (!isRecord(captured) || typeof captured.kind !== "string") {
    throw new DacsError(`party Vet attempt ${index} methodInput is malformed`);
  }
  if (captured.kind === "self-signed") {
    if (
      !exactDataKeys(captured, ["kind", "assertion", "signature"]) ||
      typeof captured.assertion !== "string" ||
      typeof captured.signature !== "string"
    ) {
      throw new DacsError(`party Vet attempt ${index} self-signed input is malformed`);
    }
    return captured as unknown as PartyVetMethodInput;
  }
  if (captured.kind === "consensus-backed-proxy") {
    if (!exactDataKeys(captured, ["kind"])) {
      throw new DacsError(`party Vet attempt ${index} proxy input is malformed`);
    }
    return captured as unknown as PartyVetMethodInput;
  }
  if (
    !exactDataKeys(captured, ["kind", "input"]) ||
    !isRecord(captured.input)
  ) {
    throw new DacsError(`party Vet attempt ${index} methodInput is malformed`);
  }
  return captured as unknown as PartyVetMethodInput;
}

function captureAttemptInput(
  value: unknown,
  index: number,
): {
  requirementPath: PartyVetRequirementPath;
  claimSubject: string;
  classification: "freshness" | "dealSpecific";
  methodInput: PartyVetMethodInput;
  recipePin: DurableSessionRecipePin;
} {
  if (
    !exactDataKeys(
      value,
      [
        "requirementPath",
        "claimSubject",
        "classification",
        "methodInput",
        "recipePin",
      ],
    )
  ) {
    throw new DacsError(`party Vet attempt ${index} must be an exact data record`);
  }
  const recipePin = value.recipePin;
  if (!isDurableSessionRecipePin(recipePin)) {
    throw new DacsError(
      `party Vet attempt ${index} requires a runtime-authenticated durable recipe pin`,
    );
  }
  if (value.classification !== "freshness" && value.classification !== "dealSpecific") {
    throw new DacsError(`party Vet attempt ${index} classification is invalid`);
  }
  const claimSubject = nonEmptyNfc(value.claimSubject, `party Vet attempt ${index} claimSubject`);
  claimParts(claimSubject, `party Vet attempt ${index} claimSubject`);
  return {
    requirementPath: capturePath(value.requirementPath),
    claimSubject,
    classification: value.classification,
    methodInput: captureMethodInput(value.methodInput, index),
    recipePin,
  };
}

/**
 * Capture one immutable, party-scoped Vet plan before any method, signing or
 * anchoring effect. Every requirement path is explicit, so two same-scheme
 * requirements cannot silently share a result or lose their provenance.
 */
export function createPartyVetPlan(source: PartyVetPlanInput): PartyVetPlan {
  if (
    !exactDataKeys(
      source,
      [
        "jobId",
        "evaluatedParty",
        "identityBundle",
        "requirement",
        "verifier",
        "attempts",
      ],
      ["supplementary", "warnings"],
    )
  ) {
    throw new DacsError("party Vet plan input must be an exact data record");
  }
  const jobId = nonEmptyNfc(source.jobId, "party Vet jobId");
  const evaluatedParty = nonEmptyNfc(
    source.evaluatedParty,
    "party Vet evaluatedParty",
  );
  claimParts(evaluatedParty, "party Vet evaluatedParty");
  if (
    !exactDataKeys(source.verifier, ["algorithm", "signer"]) ||
    (source.verifier.algorithm !== "ed25519" &&
      source.verifier.algorithm !== "ecdsa-secp256k1" &&
      source.verifier.algorithm !== "sr1-aggregate")
  ) {
    throw new DacsError("party Vet verifier identity is malformed");
  }
  const verifier = snapshot(source.verifier, "party Vet verifier");
  nonEmptyNfc(verifier.signer, "party Vet verifier signer");
  claimParts(verifier.signer, "party Vet verifier signer");

  const identityBundle = snapshot(source.identityBundle, "party Vet IdentityBundle");
  if (!isIdentityBundle(identityBundle)) {
    throw new DacsError("party Vet requires an exact current IdentityBundle");
  }
  if (identityBundle.presentedBy !== evaluatedParty) {
    throw new DacsError("party Vet evaluatedParty must equal IdentityBundle.presentedBy");
  }
  const requirement = snapshot(source.requirement, "party Vet BundleRequirement");
  if (!isCompositeBundleRequirement(requirement)) {
    throw new DacsError("party Vet requires an exact current BundleRequirement");
  }
  const supplementary = snapshot(
    source.supplementary ?? [],
    "party Vet supplementary signals",
  );
  if (
    !Array.isArray(supplementary) ||
    !supplementary.every(isSupplementarySignal)
  ) {
    throw new DacsError("party Vet supplementary signals are malformed");
  }
  const warnings = source.warnings === undefined
    ? undefined
    : snapshot(source.warnings, "party Vet warnings");
  if (
    warnings !== undefined &&
    (!Array.isArray(warnings) || !warnings.every(isVerificationWarning))
  ) {
    throw new DacsError("party Vet warnings are malformed");
  }
  if (!Array.isArray(source.attempts)) {
    throw new DacsError("party Vet attempts must be an array");
  }
  const attemptsDescriptor = Object.getOwnPropertyDescriptors(source.attempts) as
    Record<string, PropertyDescriptor>;
  const attemptKeys = Object.keys(attemptsDescriptor).filter((key) => key !== "length");
  const attemptLength = attemptsDescriptor.length?.value;
  if (
    Object.getPrototypeOf(source.attempts) !== Array.prototype ||
    !Number.isSafeInteger(attemptLength) ||
    (attemptLength as number) < 0 ||
    attemptKeys.length !== attemptLength ||
    attemptKeys.some((key, index) => key !== String(index)) ||
    attemptKeys.some((key) => {
      const descriptor = attemptsDescriptor[key]!;
      return descriptor.enumerable !== true || !("value" in descriptor);
    })
  ) {
    throw new DacsError("party Vet attempts must be a dense intrinsic array");
  }

  const claims = carriedClaimsByScheme(identityBundle);
  const expected = expectedAttemptPaths(requirement, claims);
  const captured = attemptKeys.map((key, index) =>
    captureAttemptInput(attemptsDescriptor[key]!.value, index));
  const expectedPathKeys = expected.paths.map(pathKey);
  const actualPathKeys = captured.map((attempt) => pathKey(attempt.requirementPath));
  if (
    actualPathKeys.length !== expectedPathKeys.length ||
    actualPathKeys.some((key, index) => key !== expectedPathKeys[index])
  ) {
    throw new DacsError(
      "party Vet attempts must cover every verifiable requirement path in deterministic order",
    );
  }

  const bundleHash = identityBundleHash(identityBundle);
  const requirementHash = sha256Hex(canonicalize(requirement));
  const recordAddress = partyVetCompositeAddress(jobId, evaluatedParty);
  const plannedAttempts: PartyVetRequirementAttempt[] = [];
  const resultAddresses = new Set<string>();
  for (let index = 0; index < captured.length; index += 1) {
    const attempt = captured[index]!;
    const claimRequirement = requirementAt(requirement, attempt.requirementPath);
    if (!claimRequirement || !claimRequirement.verificationRequired) {
      throw new DacsError(`party Vet attempt ${index} requirement path is invalid`);
    }
    const recipePin = attempt.recipePin;
    const recipe = recipePin.provenance.recipe;
    if (
      recipePin.jobId !== jobId ||
      recipePin.evaluatedParty !== evaluatedParty ||
      !canonicalEqual(recipePin.requirementPath, attempt.requirementPath) ||
      !canonicalEqual(recipePin.requirement, claimRequirement) ||
      recipePin.requirementHash !== sha256Hex(canonicalize(claimRequirement))
    ) {
      throw new DacsError(
        `party Vet attempt ${index} durable recipe pin does not bind this party and requirement path`,
      );
    }
    const { scheme } = claimParts(
      attempt.claimSubject,
      `party Vet attempt ${index} claimSubject`,
    );
    if (
      scheme !== claimRequirement.scheme ||
      recipe.scheme !== scheme ||
      recipePin.family.scheme !== scheme
    ) {
      throw new DacsError(
        `party Vet attempt ${index} claim, requirement and recipe schemes differ`,
      );
    }
    if (!identityBundle.claims.some((claim) => claim.ref === attempt.claimSubject)) {
      throw new DacsError(
        `party Vet attempt ${index} subject is not carried by the IdentityBundle`,
      );
    }
    if (
      (claimRequirement.recipeVersion === undefined &&
        recipePin.selectionKind !== "latest-at-session-start") ||
      (claimRequirement.recipeVersion !== undefined &&
        (recipePin.selectionKind !== "explicit-historical" ||
          claimRequirement.recipeVersion !== recipe.recipeVersion)) ||
      recipePin.recipeVersion !== recipe.recipeVersion
    ) {
      throw new DacsError(
        `party Vet attempt ${index} violates the durable recipe selection`,
      );
    }
    if (recipe.governance.deprecated === true) {
      throw new DacsError(
        `party Vet attempt ${index} cannot start a deprecated required recipe`,
      );
    }
    if (recipe.availability === "disabled") {
      throw new DacsError(
        `party Vet attempt ${index} cannot start a disabled recipe`,
      );
    }
    const requiredMethod = claimRequirement.parameters?.verificationMethod;
    if (requiredMethod !== undefined && typeof requiredMethod !== "string") {
      throw new DacsError(
        `party Vet attempt ${index} verificationMethod must be a string`,
      );
    }
    const selectedKind = recipePin.method;
    if (requiredMethod !== undefined && selectedKind !== requiredMethod) {
      throw new DacsError(
        `party Vet attempt ${index} durable pin violates the exact requirement method`,
      );
    }
    if (attempt.methodInput.kind !== selectedKind) {
      throw new DacsError(
        `party Vet attempt ${index} method input violates the exact requirement method`,
      );
    }
    const method = exactMethod(recipe, selectedKind as VerificationMethodKind);
    const address = resultAddress(
      jobId,
      attempt.claimSubject,
      recipe.recipeVersion,
    );
    if (resultAddresses.has(address)) {
      throw new DacsError(
        `party Vet attempts derive duplicate result address ${address}`,
      );
    }
    resultAddresses.add(address);
    const recipeContentHash = contentHash(
      recipe as unknown as Record<string, unknown>,
    );
    const recipeArtifactHash = sha256Hex(canonicalize(recipe));
    if (
      recipeContentHash !== recipePin.recipeContentHash ||
      !canonicalEqual(recipe, recipePin.provenance.recipe)
    ) {
      throw new DacsError(
        `party Vet attempt ${index} durable recipe pin has conflicting recipe bytes`,
      );
    }
    const methodInputHash = sha256Hex(canonicalize(attempt.methodInput));
    const recipePinBinding = snapshot(
      recipePin,
      `party Vet attempt ${index} durable recipe pin`,
    ) as PartyVetRecipePinBinding;
    const registryProvenance = snapshot(
      recipePin.provenance,
      `party Vet attempt ${index} registry provenance`,
    );
    const attemptIdentity = {
      attemptVersion: "1",
      index,
      jobId,
      evaluatedParty,
      bundleHash,
      requirementHash,
      verifier,
      requirementPath: attempt.requirementPath,
      requirement: claimRequirement,
      claimSubject: attempt.claimSubject,
      classification: attempt.classification,
      recipeFamily: {
        scheme: recipe.scheme,
        defaultMethod: recipe.defaultMethod.kind,
      },
      recipeVersion: recipe.recipeVersion,
      recipeContentHash,
      recipeArtifactHash,
      recipePin: recipePinBinding,
      registryProvenance,
      method,
      methodInputHash,
      recipe,
      methodInput: attempt.methodInput,
      resultAddress: address,
    };
    const attemptId = sha256Hex(canonicalize(attemptIdentity));
    plannedAttempts.push(deepFreeze({
      index,
      attemptId,
      operationKey: `${recordAddress}:attempt:${index}:${attemptId}`,
      resultAddress: address,
      requirementPath: attempt.requirementPath,
      requirement: snapshot(claimRequirement, `party Vet attempt ${index} requirement`),
      claimSubject: attempt.claimSubject,
      classification: attempt.classification,
      method,
      methodInput: attempt.methodInput,
      methodInputHash,
      recipe,
      recipePin: recipePinBinding,
      recipeFamily: deepFreeze({
        scheme: recipe.scheme,
        defaultMethod: recipe.defaultMethod.kind,
      }),
      recipeVersion: recipe.recipeVersion,
      recipeContentHash,
      recipeArtifactHash,
      registryProvenance,
    }));
  }

  const attemptsByPath = new Map(
    plannedAttempts.map((attempt) => [pathKey(attempt.requirementPath), attempt]),
  );
  const requirementPaths: PartyVetPlannedRequirement[] =
    expected.requirementPaths.map((entry) => {
      const planned = attemptsByPath.get(pathKey(entry.requirementPath));
      if ((entry.disposition === "attempt") !== (planned !== undefined)) {
        throw new DacsError("party Vet requirement-path provenance is incomplete");
      }
      return deepFreeze({
        requirementPath: snapshot(
          entry.requirementPath,
          "party Vet requirement path",
        ),
        requirement: snapshot(
          entry.requirement,
          "party Vet path requirement",
        ),
        disposition: entry.disposition,
        ...(planned ? { attemptId: planned.attemptId } : {}),
      });
    });

  const planPayload = deepFreeze({
    planVersion: "1" as const,
    jobId,
    evaluatedParty,
    identityBundle,
    bundleHash,
    requirement,
    requirementHash,
    verifier,
    recordAddress,
    requirementPaths,
    attempts: plannedAttempts,
    supplementary,
    ...(warnings !== undefined ? { warnings } : {}),
  });
  const plan = deepFreeze({
    ...planPayload,
    planHash: sha256Hex(canonicalize(planPayload)),
  }) as PartyVetPlan;
  partyVetPlans.add(plan);
  return plan;
}

export function isPartyVetPlan(value: unknown): value is PartyVetPlan {
  return isRecord(value) && partyVetPlans.has(value);
}

function validateOutcome(
  plan: Readonly<PartyVetPlan>,
  attempt: Readonly<PartyVetRequirementAttempt>,
  outcome: unknown,
  index: number,
): PartyVetAttemptOutcome {
  if (!exactDataKeys(outcome, ["attemptId", "result"])) {
    throw new DacsError(`party Vet outcome ${index} must be an exact data record`);
  }
  const result = snapshot(outcome.result, `party Vet outcome ${index} VerifyResult`);
  if (outcome.attemptId !== attempt.attemptId || !isVerifyResult(result)) {
    throw new DacsError(`party Vet outcome ${index} does not match its planned attempt`);
  }
  const { scheme, identifier } = claimParts(
    attempt.claimSubject,
    `party Vet attempt ${attempt.index} claimSubject`,
  );
  if (
    result.scheme !== scheme ||
    result.identifier !== identifier ||
    result.recipeVersion !== attempt.recipe.recipeVersion ||
    result.method !== attempt.method.kind ||
    result.signature.algorithm !== plan.verifier.algorithm ||
    result.signature.signer !== plan.verifier.signer ||
    result.verifiedAt < result.fetchedAt ||
    (result.validUntil !== undefined && result.validUntil < result.verifiedAt)
  ) {
    throw new DacsError(`party Vet outcome ${index} result bindings are invalid`);
  }
  return deepFreeze({
    attemptId: attempt.attemptId,
    result,
  });
}

function effectiveAttemptDecision(
  attempt: Readonly<PartyVetRequirementAttempt>,
  outcome: Readonly<PartyVetAttemptOutcome> | undefined,
): VerificationDecision | undefined {
  if (!outcome) return undefined;
  return attempt.recipe.availability === "mocked" ||
    attempt.recipe.availability === "failed" ||
    attempt.recipe.availability === "disabled"
    ? "error"
    : outcome.result.decision;
}

function nextAttempt(
  plan: Readonly<PartyVetPlan>,
  completed: ReadonlyMap<string, Readonly<PartyVetAttemptOutcome>>,
): PartyVetRequirementAttempt | null {
  for (let index = 0; index < plan.requirement.required.length; index += 1) {
    const attempt = plan.attempts.find(
      (candidate) =>
        candidate.requirementPath.kind === "required" &&
        candidate.requirementPath.index === index,
    );
    if (attempt && !completed.has(attempt.attemptId)) return attempt;
  }
  for (let groupIndex = 0; groupIndex < (plan.requirement.oneOf?.length ?? 0); groupIndex += 1) {
    const groupPaths = plan.requirementPaths.filter(
      (entry) =>
        entry.requirementPath.kind === "oneOf" &&
        entry.requirementPath.groupIndex === groupIndex,
    );
    for (const entry of groupPaths) {
      if (entry.disposition === "presence-pass") break;
      if (entry.disposition === "absent") continue;
      const attempt = plan.attempts.find(
        (candidate) => candidate.attemptId === entry.attemptId,
      );
      if (!attempt) {
        throw new DacsError("party Vet plan lost requirement-path provenance");
      }
      const outcome = completed.get(attempt.attemptId);
      if (!outcome) return attempt;
      if (effectiveAttemptDecision(attempt, outcome) === "pass") break;
    }
  }
  return null;
}

function skippedAttemptIds(
  plan: Readonly<PartyVetPlan>,
  completed: ReadonlyMap<string, Readonly<PartyVetAttemptOutcome>>,
): string[] {
  const skipped: string[] = [];
  for (let groupIndex = 0; groupIndex < (plan.requirement.oneOf?.length ?? 0); groupIndex += 1) {
    const groupPaths = plan.requirementPaths.filter(
      (entry) =>
        entry.requirementPath.kind === "oneOf" &&
        entry.requirementPath.groupIndex === groupIndex,
    );
    let satisfied = false;
    for (const entry of groupPaths) {
      if (satisfied && entry.attemptId !== undefined) {
        const attempt = plan.attempts.find(
          (candidate) => candidate.attemptId === entry.attemptId,
        );
        if (attempt && !completed.has(attempt.attemptId)) {
          skipped.push(attempt.attemptId);
        }
        continue;
      }
      if (entry.disposition === "presence-pass") {
        satisfied = true;
        continue;
      }
      if (entry.attemptId !== undefined) {
        const attempt = plan.attempts.find(
          (candidate) => candidate.attemptId === entry.attemptId,
        );
        if (
          attempt &&
          effectiveAttemptDecision(
            attempt,
            completed.get(attempt.attemptId),
          ) === "pass"
        ) {
          satisfied = true;
        }
      }
    }
  }
  return skipped;
}

function aggregateComplete(
  plan: Readonly<PartyVetPlan>,
  completed: ReadonlyMap<string, Readonly<PartyVetAttemptOutcome>>,
): VerificationDecision {
  const failures: string[] = [];
  const errors: string[] = [];
  const indeterminates: string[] = [];

  for (const entry of plan.requirementPaths) {
    if (entry.requirementPath.kind !== "required") continue;
    const attempt = entry.attemptId === undefined
      ? undefined
      : plan.attempts.find((candidate) => candidate.attemptId === entry.attemptId);
    const decision = entry.disposition === "presence-pass"
      ? "pass"
      : attempt
        ? effectiveAttemptDecision(attempt, completed.get(attempt.attemptId))
        : "fail";
    if (decision === "pass") continue;
    if (decision === "fail" || decision === undefined) {
      failures.push(pathKey(entry.requirementPath));
    } else if (decision === "error") {
      errors.push(pathKey(entry.requirementPath));
    } else {
      indeterminates.push(pathKey(entry.requirementPath));
    }
  }

  for (let groupIndex = 0; groupIndex < (plan.requirement.oneOf?.length ?? 0); groupIndex += 1) {
    const decisions = plan.requirementPaths
      .filter(
        (entry) =>
          entry.requirementPath.kind === "oneOf" &&
          entry.requirementPath.groupIndex === groupIndex,
      )
      .map((entry): VerificationDecision => {
        if (entry.disposition === "presence-pass") return "pass";
        if (entry.attemptId === undefined) return "fail";
        const attempt = plan.attempts.find(
          (candidate) => candidate.attemptId === entry.attemptId,
        );
        return attempt
          ? effectiveAttemptDecision(
              attempt,
              completed.get(attempt.attemptId),
            ) ?? "fail"
          : "fail";
      })
      .filter((decision): decision is VerificationDecision => decision !== undefined);
    if (decisions.includes("pass")) continue;
    if (decisions.includes("error")) {
      errors.push(`oneOf:${groupIndex}`);
    } else if (decisions.includes("indeterminate")) {
      indeterminates.push(`oneOf:${groupIndex}`);
    } else {
      failures.push(`oneOf:${groupIndex}`);
    }
  }

  if (failures.length > 0) return "fail";
  if (errors.length > 0) return "error";
  if (indeterminates.length > 0) return "indeterminate";
  return "pass";
}

/**
 * Validate an execution prefix and return the only next legal attempt. oneOf
 * alternatives stop after the first pass; required claims and separate groups
 * remain AND-composed. An out-of-order, duplicate or post-pass result is fatal.
 */
export function advancePartyVetPlan(
  plan: PartyVetPlan,
  outcomeSource: readonly PartyVetAttemptOutcome[],
): PartyVetExecutionState {
  if (!isPartyVetPlan(plan)) {
    throw new DacsError("party Vet execution requires an authenticated immutable plan");
  }
  if (!Array.isArray(outcomeSource)) {
    throw new DacsError("party Vet outcomes must be an array");
  }
  let outcomeDescriptors: Record<string, PropertyDescriptor>;
  try {
    if (Object.getPrototypeOf(outcomeSource) !== Array.prototype) {
      throw new DacsError("party Vet outcomes must use the intrinsic array prototype");
    }
    outcomeDescriptors = Object.getOwnPropertyDescriptors(outcomeSource) as
      Record<string, PropertyDescriptor>;
  } catch (error) {
    if (error instanceof DacsError) throw error;
    throw new DacsError("party Vet outcomes could not be captured");
  }
  const outcomeKeys = Object.keys(outcomeDescriptors).filter((key) => key !== "length");
  const outcomeLength = outcomeDescriptors.length?.value;
  if (
    !Number.isSafeInteger(outcomeLength) ||
    (outcomeLength as number) < 0 ||
    outcomeKeys.length !== outcomeLength ||
    outcomeKeys.some((key, index) => key !== String(index)) ||
    outcomeKeys.some((key) => {
      const descriptor = outcomeDescriptors[key]!;
      return descriptor.enumerable !== true || !("value" in descriptor);
    })
  ) {
    throw new DacsError("party Vet outcomes must be a dense data array");
  }
  const completed = new Map<string, PartyVetAttemptOutcome>();
  const ordered: PartyVetAttemptOutcome[] = [];
  for (let index = 0; index < outcomeKeys.length; index += 1) {
    const expected = nextAttempt(plan, completed);
    if (!expected) {
      throw new DacsError("party Vet execution contains an outcome after completion");
    }
    const outcome = validateOutcome(
      plan,
      expected,
      outcomeDescriptors[outcomeKeys[index]!]!.value,
      index,
    );
    if (completed.has(outcome.attemptId)) {
      throw new DacsError("party Vet execution contains a duplicate outcome");
    }
    completed.set(outcome.attemptId, outcome);
    ordered.push(outcome);
  }
  const pending = nextAttempt(plan, completed);
  const skipped = skippedAttemptIds(plan, completed);
  if (pending) {
    return deepFreeze({
      status: "pending" as const,
      nextAttempt: pending,
      completed: ordered,
      skippedAttemptIds: skipped,
    });
  }
  const freshness: VerifyResult[] = [];
  const dealSpecific: VerifyResult[] = [];
  for (const outcome of ordered) {
    const attempt = plan.attempts.find(
      (candidate) => candidate.attemptId === outcome.attemptId,
    )!;
    (attempt.classification === "freshness" ? freshness : dealSpecific)
      .push(outcome.result);
  }
  return deepFreeze({
    status: "complete" as const,
    overallDecision: aggregateComplete(plan, completed),
    completed: ordered,
    freshness,
    dealSpecific,
    skippedAttemptIds: skipped,
  });
}

import { types as nodeTypes } from "node:util";

import { canonicalize, sha256Hex } from "../canonical/index.js";
import { snapshotCanonicalJsonRead } from "../canonical/snapshot.js";
import type { AttestationRef } from "../artifacts/types.js";
import type {
  CompositeClaimRequirement,
} from "./compositeVerification.js";

export type ClaimQualificationDecision =
  | "pass"
  | "fail"
  | "error"
  | "indeterminate";

export interface ClaimQualificationResultProjection {
  scheme: string;
  method: string;
  decision: ClaimQualificationDecision;
  recipeVersion: number;
  verifiedAt: number;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export type ClaimQualificationResultReuse =
  | null
  | { kind: "current-session" }
  | {
      kind: "cross-session";
      originatingParametersAuthenticated?: boolean;
      originatingParameters?: Record<string, unknown>;
      rerunResult?: ClaimQualificationResultProjection;
    };

export interface ClaimQualificationProductionAuthority {
  kind: "production";
  /** Opaque handle resolved only by the trusted session-start dependency. */
  sessionStart: string;
  vetInput: {
    jobId: string;
    recipeRegistryVersion: number;
    sessionContext: {
      jobId: string;
      recipeRegistryVersion: number;
    };
  };
}

export interface ClaimQualificationReplayAuthority {
  kind: "replay";
  bundle: Record<string, unknown>;
  recordRef: AttestationRef;
  record: Record<string, unknown>;
  results: ReadonlyArray<{
    ref: AttestationRef & { recipeVersion?: number };
    result: Record<string, unknown>;
  }>;
}

export type ClaimQualificationAuthority =
  | ClaimQualificationProductionAuthority
  | ClaimQualificationReplayAuthority;

/** Exact CRQ projection used by the adopted conformance operation. */
export interface ClaimQualificationBundleRequirement {
  required: CompositeClaimRequirement[];
  oneOf?: CompositeClaimRequirement[][];
}

export interface ClaimQualificationInput {
  generatedAt: number;
  recordJobId: string;
  requirement: ClaimQualificationBundleRequirement;
  resolvedResults: ClaimQualificationResultProjection[];
  resultReuse?: ClaimQualificationResultReuse[];
  aggregationAuthority: ClaimQualificationAuthority;
}

export interface ClaimQualificationRecipeRegistry {
  recipeRegistryVersion: number;
  latestByFamily: Record<string, Record<string, number>>;
  versionsByFamily: Record<
    string,
    Record<string, Record<string, string>>
  >;
}

export type ClaimQualificationAuthentication =
  | "valid"
  | "invalid"
  | "indeterminate";

export interface ClaimQualificationDeps {
  /** Resolve the orchestrator-owned active SessionContext, never caller state. */
  resolveAuthenticatedSessionStart: (
    handle: string,
  ) =>
    | Promise<{ jobId: string; recipeRegistryVersion: number } | null>
    | { jobId: string; recipeRegistryVersion: number }
    | null;
  /**
   * Authenticate the complete production qualification closure. Session-start
   * authority selects the registry, but cannot by itself authenticate the
   * caller-supplied requirement, results, freshness time, or reuse metadata.
   */
  authenticateProductionQualification: (
    input: Readonly<ClaimQualificationInput>,
  ) => Promise<ClaimQualificationAuthentication> | ClaimQualificationAuthentication;
  /** Authenticate the replay bundle's exact discriminator/domain/signers. */
  authenticateReplayBundle: (
    bundle: Readonly<Record<string, unknown>>,
  ) => Promise<ClaimQualificationAuthentication> | ClaimQualificationAuthentication;
  /** Authenticate the exact CVR against `recordRef`. */
  authenticateCompositeRecord: (input: Readonly<{
    record: Readonly<Record<string, unknown>>;
    ref: Readonly<AttestationRef>;
  }>) => Promise<ClaimQualificationAuthentication> | ClaimQualificationAuthentication;
  /** Authenticate each exact VerifyResult against its reference. */
  authenticateVerifyResult: (input: Readonly<{
    result: Readonly<Record<string, unknown>>;
    ref: Readonly<AttestationRef & { recipeVersion?: number }>;
  }>) => Promise<ClaimQualificationAuthentication> | ClaimQualificationAuthentication;
  /** Resolve the exact authenticated recipe registry pinned by the authority. */
  resolveRecipeRegistry: (
    version: number,
  ) =>
    | Promise<ClaimQualificationRecipeRegistry | null>
    | ClaimQualificationRecipeRegistry
    | null;
}

export interface ClaimQualificationEvaluation {
  decision: ClaimQualificationDecision;
  reason:
    | "ok"
    | "authority-invalid"
    | "authority-unavailable"
    | "registry-unavailable"
    | "qualification-invalid"
    | "required-unsatisfied"
    | "required-error"
    | "required-indeterminate";
}

const RECIPE_AVAILABILITY = new Set([
  "live",
  "operator_gated",
  "closed_data",
  "bilateral",
  "mocked",
  "disabled",
  "failed",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);
const isSafeUint = (value: unknown): value is number =>
  isSafeInteger(value) && value >= 0;
const exact = (left: unknown, right: unknown): boolean =>
  canonicalize(left) === canonicalize(right);
const canonicalRef = (ref: unknown): string => canonicalize(ref);

function capturedFunction<T extends (...args: never[]) => unknown>(
  source: unknown,
  key: string,
): T | null {
  if (!isRecord(source) || nodeTypes.isProxy(source)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor && "value" in descriptor && typeof descriptor.value === "function"
    ? (Function.prototype.bind.call(descriptor.value, source) as T)
    : null;
}

function captureDeps(source: ClaimQualificationDeps): ClaimQualificationDeps | null {
  const resolveAuthenticatedSessionStart = capturedFunction<
    ClaimQualificationDeps["resolveAuthenticatedSessionStart"]
  >(source, "resolveAuthenticatedSessionStart");
  const authenticateReplayBundle = capturedFunction<
    ClaimQualificationDeps["authenticateReplayBundle"]
  >(source, "authenticateReplayBundle");
  const authenticateProductionQualification = capturedFunction<
    ClaimQualificationDeps["authenticateProductionQualification"]
  >(source, "authenticateProductionQualification");
  const authenticateCompositeRecord = capturedFunction<
    ClaimQualificationDeps["authenticateCompositeRecord"]
  >(source, "authenticateCompositeRecord");
  const authenticateVerifyResult = capturedFunction<
    ClaimQualificationDeps["authenticateVerifyResult"]
  >(source, "authenticateVerifyResult");
  const resolveRecipeRegistry = capturedFunction<
    ClaimQualificationDeps["resolveRecipeRegistry"]
  >(source, "resolveRecipeRegistry");
  if (
    !resolveAuthenticatedSessionStart ||
    !authenticateProductionQualification ||
    !authenticateReplayBundle ||
    !authenticateCompositeRecord ||
    !authenticateVerifyResult ||
    !resolveRecipeRegistry
  ) {
    return null;
  }
  return {
    resolveAuthenticatedSessionStart,
    authenticateProductionQualification,
    authenticateReplayBundle,
    authenticateCompositeRecord,
    authenticateVerifyResult,
    resolveRecipeRegistry,
  };
}

function outcome(
  decision: ClaimQualificationDecision,
  reason: ClaimQualificationEvaluation["reason"],
): ClaimQualificationEvaluation {
  return { decision, reason };
}

function isDecision(value: unknown): value is ClaimQualificationDecision {
  return (
    value === "pass" ||
    value === "fail" ||
    value === "error" ||
    value === "indeterminate"
  );
}

function isResultProjection(value: unknown): value is ClaimQualificationResultProjection {
  return (
    isRecord(value) &&
    typeof value.scheme === "string" &&
    value.scheme.length > 0 &&
    typeof value.method === "string" &&
    value.method.length > 0 &&
    isDecision(value.decision) &&
    isSafeInteger(value.recipeVersion) &&
    (value.recipeVersion as number) > 0 &&
    isSafeUint(value.verifiedAt) &&
    (value.data === undefined || isRecord(value.data))
  );
}

function hasExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => allowed.has(key));
}

function isQualificationRequirement(
  value: unknown,
): value is CompositeClaimRequirement {
  return (
    hasExactKeys(
      value,
      ["scheme", "verificationRequired"],
      ["maxAge", "recipeVersion", "parameters"],
    ) &&
    typeof value.scheme === "string" &&
    value.scheme.length > 0 &&
    value.verificationRequired === true &&
    (value.maxAge === undefined || isSafeUint(value.maxAge)) &&
    (value.recipeVersion === undefined ||
      (isSafeInteger(value.recipeVersion) && value.recipeVersion > 0)) &&
    (value.parameters === undefined || isRecord(value.parameters))
  );
}

function isQualificationBundleRequirement(
  value: unknown,
): value is ClaimQualificationBundleRequirement {
  return (
    hasExactKeys(value, ["required"], ["oneOf"]) &&
    Array.isArray(value.required) &&
    value.required.every(isQualificationRequirement) &&
    (value.oneOf === undefined ||
      (Array.isArray(value.oneOf) &&
        value.oneOf.every(
          (group) =>
            Array.isArray(group) &&
            group.length > 0 &&
            group.every(isQualificationRequirement),
        )))
  );
}

function isResultReuseEntry(value: unknown): value is ClaimQualificationResultReuse {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if (value.kind === "current-session") {
    return hasExactKeys(value, ["kind"]);
  }
  return (
    value.kind === "cross-session" &&
    hasExactKeys(
      value,
      ["kind"],
      [
        "originatingParametersAuthenticated",
        "originatingParameters",
        "rerunResult",
      ],
    ) &&
    (value.originatingParametersAuthenticated === undefined ||
      typeof value.originatingParametersAuthenticated === "boolean") &&
    (value.originatingParameters === undefined ||
      isRecord(value.originatingParameters)) &&
    (value.rerunResult === undefined || isResultProjection(value.rerunResult))
  );
}

function isProductionAuthority(
  value: unknown,
): value is ClaimQualificationProductionAuthority {
  if (!hasExactKeys(value, ["kind", "sessionStart", "vetInput"])) return false;
  if (
    value.kind !== "production" ||
    typeof value.sessionStart !== "string" ||
    value.sessionStart.length === 0 ||
    !hasExactKeys(value.vetInput, ["jobId", "recipeRegistryVersion", "sessionContext"])
  ) return false;
  const vetInput = value.vetInput;
  return (
    typeof vetInput.jobId === "string" &&
    vetInput.jobId.length > 0 &&
    isSafeInteger(vetInput.recipeRegistryVersion) &&
    vetInput.recipeRegistryVersion > 0 &&
    hasExactKeys(vetInput.sessionContext, ["jobId", "recipeRegistryVersion"]) &&
    typeof vetInput.sessionContext.jobId === "string" &&
    vetInput.sessionContext.jobId.length > 0 &&
    isSafeInteger(vetInput.sessionContext.recipeRegistryVersion) &&
    vetInput.sessionContext.recipeRegistryVersion > 0
  );
}

function isReplayAuthority(
  value: unknown,
): value is ClaimQualificationReplayAuthority {
  return (
    hasExactKeys(value, ["kind", "bundle", "recordRef", "record", "results"]) &&
    value.kind === "replay" &&
    isRecord(value.bundle) &&
    isRecord(value.recordRef) &&
    isRecord(value.record) &&
    Array.isArray(value.results) &&
    value.results.every(
      (entry) =>
        hasExactKeys(entry, ["ref", "result"]) &&
        isRecord(entry.ref) &&
        isRecord(entry.result),
    )
  );
}

function isRegistry(value: unknown): value is ClaimQualificationRecipeRegistry {
  return (
    isRecord(value) &&
    isSafeInteger(value.recipeRegistryVersion) &&
    isRecord(value.latestByFamily) &&
    isRecord(value.versionsByFamily)
  );
}

async function replayAuthorityVersion(
  input: Readonly<ClaimQualificationInput>,
  authority: Readonly<ClaimQualificationReplayAuthority>,
  deps: ClaimQualificationDeps,
): Promise<number | null> {
  // A rerun projection is not part of the authenticated replay closure. It may
  // only be admitted by the explicit production authenticator below.
  if (input.resultReuse?.some(
    (entry) =>
      entry !== null &&
      entry.kind === "cross-session" &&
      entry.rerunResult !== undefined,
  )) return null;
  if (
    (await deps.authenticateReplayBundle(
      structuredClone(authority.bundle),
    )) !== "valid"
  ) {
    return null;
  }
  if (
    authority.bundle.jobId !== input.recordJobId ||
    !isSafeInteger(authority.bundle.recipeRegistryVersion) ||
    !Array.isArray(authority.bundle.vetRecords) ||
    !authority.bundle.vetRecords.some((ref) => exact(ref, authority.recordRef))
  ) {
    return null;
  }
  if (
    (await deps.authenticateCompositeRecord({
      record: structuredClone(authority.record),
      ref: structuredClone(authority.recordRef),
    })) !== "valid" ||
    authority.record.jobId !== input.recordJobId ||
    authority.record.generatedAt !== input.generatedAt ||
    authority.record.requirementHash !== sha256Hex(canonicalize(input.requirement))
  ) {
    return null;
  }
  const recordRefs = [
    ...(Array.isArray(authority.record.freshness) ? authority.record.freshness : []),
    ...(Array.isArray(authority.record.dealSpecific)
      ? authority.record.dealSpecific
      : []),
  ];
  if (
    authority.results.length !== input.resolvedResults.length ||
    authority.results.length !== recordRefs.length
  ) {
    return null;
  }
  const expectedRefs = recordRefs.map(canonicalRef).sort();
  const suppliedRefs = authority.results.map((entry) => canonicalRef(entry.ref)).sort();
  if (!exact(expectedRefs, suppliedRefs)) return null;
  for (let index = 0; index < authority.results.length; index += 1) {
    const authenticated = authority.results[index]!;
    const declared = input.resolvedResults[index]!;
    if (
      (await deps.authenticateVerifyResult({
        result: structuredClone(authenticated.result),
        ref: structuredClone(authenticated.ref),
      })) !== "valid" ||
      authenticated.ref.recipeVersion !== authenticated.result.recipeVersion
    ) {
      return null;
    }
    const projection: Record<string, unknown> = {};
    for (const key of Object.keys(declared)) projection[key] = authenticated.result[key];
    if (!exact(projection, declared)) return null;
  }
  return authority.bundle.recipeRegistryVersion as number;
}

async function authorityVersion(
  input: Readonly<ClaimQualificationInput>,
  deps: ClaimQualificationDeps,
): Promise<number | null> {
  const authority = input.aggregationAuthority;
  if (authority.kind === "production") {
    const vetInput = authority.vetInput;
    if (
      vetInput.jobId !== input.recordJobId ||
      vetInput.sessionContext.jobId !== input.recordJobId ||
      vetInput.recipeRegistryVersion !== vetInput.sessionContext.recipeRegistryVersion
    ) {
      return null;
    }
    const rawAuthenticated = await deps.resolveAuthenticatedSessionStart(
      authority.sessionStart,
    );
    const authenticated = rawAuthenticated === null
      ? null
      : snapshotCanonicalJsonRead(
          rawAuthenticated,
          "authenticated session-start context",
        );
    if (authenticated === null || !exact(authenticated, vetInput.sessionContext)) {
      return null;
    }
    if (
      (await deps.authenticateProductionQualification(
        structuredClone(input),
      )) !== "valid"
    ) {
      return null;
    }
    return vetInput.sessionContext.recipeRegistryVersion;
  }
  return authority.kind === "replay"
    ? replayAuthorityVersion(input, authority, deps)
    : null;
}

function prepareResults(
  input: Readonly<ClaimQualificationInput>,
  requirement: Readonly<CompositeClaimRequirement>,
): ClaimQualificationResultProjection[] | null {
  const reuse = input.resultReuse ?? input.resolvedResults.map(() => null);
  if (reuse.length !== input.resolvedResults.length) return null;
  const prepared: ClaimQualificationResultProjection[] = [];
  for (let index = 0; index < input.resolvedResults.length; index += 1) {
    const candidate = input.resolvedResults[index]!;
    const metadata = reuse[index];
    if (!isResultProjection(candidate)) return null;
    if (candidate.scheme !== requirement.scheme || metadata === null) {
      prepared.push(candidate);
      continue;
    }
    if (!isRecord(metadata)) return null;
    if (metadata.kind === "current-session") {
      prepared.push(candidate);
      continue;
    }
    if (metadata.kind !== "cross-session") return null;
    if (candidate.decision === "pass") {
      prepared.push(candidate);
      continue;
    }
    if (
      metadata.originatingParametersAuthenticated === true &&
      exact(metadata.originatingParameters, requirement.parameters)
    ) {
      prepared.push(candidate);
      continue;
    }
    if (
      !isResultProjection(metadata.rerunResult) ||
      metadata.rerunResult.scheme !== candidate.scheme ||
      metadata.rerunResult.method !== candidate.method
    ) {
      return null;
    }
    prepared.push(metadata.rerunResult);
  }
  return prepared.every((result) => result.verifiedAt <= input.generatedAt)
    ? prepared
    : null;
}

interface QualificationContext {
  candidates: ClaimQualificationResultProjection[];
  expectedVersions: Map<string, number>;
}

function qualificationContext(
  input: Readonly<ClaimQualificationInput>,
  requirement: Readonly<CompositeClaimRequirement>,
  registry: Readonly<ClaimQualificationRecipeRegistry>,
): QualificationContext | null {
  const candidates = prepareResults(input, requirement);
  if (!candidates) return null;
  const sameScheme = candidates.filter((result) => result.scheme === requirement.scheme);
  const requiredMethodValue = requirement.parameters?.verificationMethod;
  if (
    requiredMethodValue !== undefined &&
    (typeof requiredMethodValue !== "string" || requiredMethodValue.length === 0)
  ) {
    return null;
  }
  const requiredMethod = requiredMethodValue as string | undefined;
  const methods = requiredMethod === undefined
    ? new Set(sameScheme.map((result) => result.method))
    : new Set([requiredMethod]);
  if (
    methods.size === 0 ||
    [...methods].some((method) => method.length === 0) ||
    (requirement.recipeVersion !== undefined &&
      (!isSafeInteger(requirement.recipeVersion) || requirement.recipeVersion <= 0))
  ) {
    return null;
  }
  const expectedVersions = new Map<string, number>();
  for (const method of methods) {
    const schemeVersions = registry.versionsByFamily[requirement.scheme];
    const familyVersions = schemeVersions?.[method];
    if (!isRecord(familyVersions)) return null;
    const expectedVersion = requirement.recipeVersion ??
      registry.latestByFamily[requirement.scheme]?.[method];
    if (!isSafeInteger(expectedVersion) || expectedVersion <= 0) return null;
    const availability = familyVersions[String(expectedVersion)];
    if (typeof availability !== "string" || !RECIPE_AVAILABILITY.has(availability)) {
      return null;
    }
    if (requirement.recipeVersion === undefined && availability !== "live") return null;
    if (
      requirement.recipeVersion !== undefined &&
      (availability === "mocked" ||
        availability === "disabled" ||
        availability === "failed")
    ) {
      return null;
    }
    expectedVersions.set(method, expectedVersion);
  }
  return { candidates, expectedVersions };
}

function applicableResults(
  input: Readonly<ClaimQualificationInput>,
  requirement: Readonly<CompositeClaimRequirement>,
  registry: Readonly<ClaimQualificationRecipeRegistry>,
): ClaimQualificationResultProjection[] | null {
  const context = qualificationContext(input, requirement, registry);
  if (!context) return null;
  const requiredMethodValue = requirement.parameters?.verificationMethod;
  if (
    requiredMethodValue !== undefined &&
    typeof requiredMethodValue !== "string"
  ) return null;
  const requiredMethod = requiredMethodValue as string | undefined;
  return context.candidates.filter((candidate) => {
    if (candidate.scheme !== requirement.scheme) return false;
    if (requiredMethod !== undefined && candidate.method !== requiredMethod) return false;
    if (candidate.recipeVersion !== context.expectedVersions.get(candidate.method)) {
      return false;
    }
    if (requirement.maxAge !== undefined) {
      const expiry = candidate.verifiedAt + requirement.maxAge * 1000;
      if (!Number.isSafeInteger(expiry) || input.generatedAt > expiry) return false;
    }
    return true;
  });
}

function parametersMatch(
  result: Readonly<ClaimQualificationResultProjection>,
  requirement: Readonly<CompositeClaimRequirement>,
): boolean {
  for (const [key, expected] of Object.entries(requirement.parameters ?? {})) {
    if (key === "verificationMethod") {
      if (result.method !== expected) return false;
    } else if (
      !result.data ||
      !(key in result.data) ||
      !exact(result.data[key], expected)
    ) {
      return false;
    }
  }
  return true;
}

function classifyRequired(
  input: Readonly<ClaimQualificationInput>,
  requirement: Readonly<CompositeClaimRequirement>,
  registry: Readonly<ClaimQualificationRecipeRegistry>,
): ClaimQualificationDecision | null {
  const context = qualificationContext(input, requirement, registry);
  const applicable = applicableResults(input, requirement, registry);
  if (!context || !applicable) return null;
  if (!context.candidates.some((result) => result.scheme === requirement.scheme)) {
    return "fail";
  }
  if (applicable.length === 0) return "fail";
  if (
    applicable.some(
      (result) => result.decision === "pass" && parametersMatch(result, requirement),
    )
  ) {
    return "pass";
  }
  if (applicable.some((result) => result.decision === "pass" || result.decision === "fail")) {
    return "fail";
  }
  if (applicable.some((result) => result.decision === "error")) return "error";
  return "indeterminate";
}

/**
 * DACS-2 CRQ-1..CRQ-4 exact qualification and four-value aggregation.
 * Authority is authenticated before registry/version resolution or result
 * classification, so an unsigned replay or caller-substituted session cannot
 * influence even an eventual `fail` result.
 */
export async function evaluateClaimRequirementQualification(
  inputSource: ClaimQualificationInput,
  depsSource: ClaimQualificationDeps,
): Promise<ClaimQualificationEvaluation> {
  const deps = captureDeps(depsSource);
  if (!deps) return outcome("error", "authority-invalid");
  let input: ClaimQualificationInput;
  try {
    input = snapshotCanonicalJsonRead(
      inputSource,
      "claim requirement qualification input",
    ) as ClaimQualificationInput;
  } catch {
    return outcome("error", "qualification-invalid");
  }
  if (
    !hasExactKeys(
      input,
      [
        "generatedAt",
        "recordJobId",
        "requirement",
        "resolvedResults",
        "aggregationAuthority",
      ],
      ["resultReuse"],
    ) ||
    !isSafeUint(input.generatedAt) ||
    typeof input.recordJobId !== "string" ||
    input.recordJobId.length === 0 ||
    !isQualificationBundleRequirement(input.requirement) ||
    !Array.isArray(input.resolvedResults) ||
    !input.resolvedResults.every(isResultProjection) ||
    (input.resultReuse !== undefined &&
      (!Array.isArray(input.resultReuse) ||
        input.resultReuse.length !== input.resolvedResults.length ||
        !input.resultReuse.every(isResultReuseEntry))) ||
    (!isProductionAuthority(input.aggregationAuthority) &&
      !isReplayAuthority(input.aggregationAuthority))
  ) {
    return outcome("error", "qualification-invalid");
  }

  let version: number | null;
  try {
    version = await authorityVersion(input, deps);
  } catch {
    return outcome("error", "authority-unavailable");
  }
  if (version === null) return outcome("error", "authority-invalid");

  let registry: ClaimQualificationRecipeRegistry | null;
  try {
    const resolved = await deps.resolveRecipeRegistry(version);
    registry = resolved === null
      ? null
      : snapshotCanonicalJsonRead(
          resolved,
          "authenticated claim-qualification registry",
        ) as ClaimQualificationRecipeRegistry;
  } catch {
    return outcome("error", "registry-unavailable");
  }
  if (
    !isRegistry(registry) ||
    registry.recipeRegistryVersion !== version
  ) {
    return outcome("error", "registry-unavailable");
  }

  const allRequirements = [
    ...(Array.isArray(input.requirement.required)
      ? input.requirement.required
      : []),
    ...(Array.isArray(input.requirement.oneOf)
      ? input.requirement.oneOf.flat()
      : []),
  ];
  if (
    !Array.isArray(input.requirement.required) ||
    !allRequirements.every((requirement) =>
      qualificationContext(input, requirement, registry!) !== null)
  ) {
    return outcome("error", "qualification-invalid");
  }

  const decisions: ClaimQualificationDecision[] = [];
  for (const requirement of input.requirement.required) {
    decisions.push(classifyRequired(input, requirement, registry)!);
  }
  for (const group of input.requirement.oneOf ?? []) {
    const memberResults = group.map((requirement) => ({
      requirement,
      results: applicableResults(input, requirement, registry)!,
    }));
    if (
      memberResults.some(({ requirement, results }) =>
        results.some(
          (result) =>
            result.decision === "pass" && parametersMatch(result, requirement),
        ),
      )
    ) {
      decisions.push("pass");
    } else if (memberResults.some(({ results }) =>
      results.some((result) => result.decision === "error"))) {
      decisions.push("error");
    } else if (memberResults.some(({ results }) =>
      results.some((result) => result.decision === "indeterminate"))) {
      decisions.push("indeterminate");
    } else {
      decisions.push("fail");
    }
  }
  if (decisions.includes("fail")) return outcome("fail", "required-unsatisfied");
  if (decisions.includes("error")) return outcome("error", "required-error");
  if (decisions.includes("indeterminate")) {
    return outcome("indeterminate", "required-indeterminate");
  }
  return outcome("pass", "ok");
}

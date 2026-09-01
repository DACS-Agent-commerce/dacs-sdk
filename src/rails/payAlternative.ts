import { types as nodeTypes } from "node:util";

import type {
  AttestationRef,
  ComponentSignature,
  ComponentSignatureAlgorithm,
  PaymentPhaseType,
  PaymentRailRef,
  PhaseStep,
  PriorPaymentDisposition,
  Listing,
} from "../artifacts/types.js";
import {
  isAttestationRef,
  isPaymentRailRef,
} from "../artifacts/validators.js";
import {
  isCanonicalBase64Url,
  isComponentSignature,
} from "../artifacts/signatures.js";
import {
  canonicalize,
  contentHash,
  sha256Hex,
} from "../canonical/index.js";
import {
  snapshotCanonicalJson,
  snapshotCanonicalJsonRead,
} from "../canonical/snapshot.js";
import { signedBytes } from "../crypto/index.js";
import { DacsError } from "../errors.js";
import {
  deriveFixedPriceAgreement,
  type FixedPriceAgreementInput,
  type UnsignedAgreementArtifact,
} from "../negotiate/fixedPrice.js";
import { requireCanonicalJobId } from "../negotiate/jobId.js";

export const PRIOR_PAYMENT_DISPOSITION_SEPARATOR =
  "dacs-prior-payment-disposition:v1:" as const;

export const CONCRETE_PAYMENT_PHASES = [
  "pay-evm-erc20",
  "pay-solana-spl",
  "pay-cross-chain-htlc",
  "pay-cross-chain-liquidity-tank",
  "pay-ap2",
  "pay-x402",
  "pay-dem",
] as const satisfies readonly PaymentPhaseType[];

const CONCRETE_PAYMENT_SET: ReadonlySet<string> = new Set(
  CONCRETE_PAYMENT_PHASES,
);
const ACTIVE_AVAILABILITY = new Set(["live"]);
const GATED_AVAILABILITY = new Set([
  "operator_gated",
  "closed_data",
  "bilateral",
]);
const AUTHENTICATED_ADMISSIONS = new WeakSet<object>();
const AUTHENTICATED_PROJECTIONS = new WeakSet<object>();
const AUTHENTICATED_REPLACEMENTS = new WeakMap<object, object | null>();

export type AlternativePaymentVerdict =
  | "pass"
  | "fail"
  | "indeterminate"
  | "error";

export interface AlternativePaymentDecision {
  verdict: AlternativePaymentVerdict;
  reason?: string;
}

type AlternativePaymentFailure = AlternativePaymentDecision & {
  verdict: Exclude<AlternativePaymentVerdict, "pass">;
};

export interface AlternativePaymentListingLike {
  listingId: string;
  listingVersion: number;
  pipeline: PhaseStep[];
  acceptedRails?: PaymentRailRef[];
  signature?: unknown;
}

export interface AlternativeRailDefinition {
  railId: string;
  railVersion: number;
  phaseHandler: string;
  availability: string;
  signature?: unknown;
}

export type AlternativeArtifactAuthentication =
  | { status: "authenticated" }
  | { status: "invalid" | "indeterminate" | "error"; reason: string };

export type AlternativeDefinitionResolution =
  | {
      status: "verified";
      snapshotId: string;
      ref: PaymentRailRef;
      definition: AlternativeRailDefinition;
    }
  | {
      status: "unavailable";
      snapshotId: string;
      ref: PaymentRailRef;
      reason: string;
    }
  | {
      status: "absent" | "invalid";
      snapshotId: string;
      ref: PaymentRailRef;
      reason: string;
    };

export type AlternativeRegistrySnapshot =
  | { status: "indeterminate"; reason: string }
  | {
      status: "authenticated";
      snapshotId: string;
      resolutions: AlternativeDefinitionResolution[];
    };

export interface AlternativePaymentListingDeps {
  /** Authenticate the exact captured Listing bytes before APR interpretation. */
  authenticateListing: (
    listing: Readonly<AlternativePaymentListingLike>,
  ) =>
    | Promise<AlternativeArtifactAuthentication>
    | AlternativeArtifactAuthentication;
  /** Resolve every accepted ref through one authenticated registry snapshot. */
  resolveRegistry: (
    listing: Readonly<AlternativePaymentListingLike>,
  ) => Promise<AlternativeRegistrySnapshot> | AlternativeRegistrySnapshot;
  /** Authenticate the exact resolved RailDefinition and its steward authority. */
  authenticateDefinition: (
    definition: Readonly<AlternativeRailDefinition>,
  ) =>
    | Promise<AlternativeArtifactAuthentication>
    | AlternativeArtifactAuthentication;
  supportedHandlers: readonly PaymentPhaseType[];
  /** APR-8 capability switch for intentionally legacy readers. */
  supportsPayAlternative?: boolean;
}

export interface ResolvedAlternativeRail {
  ref: PaymentRailRef;
  definition: AlternativeRailDefinition;
}

export interface AlternativePaymentListingAdmission
  extends AlternativePaymentDecision {
  verdict: "pass";
  listing: Readonly<AlternativePaymentListingLike>;
  alternativeIndex?: number;
  alternatives: readonly PaymentRailRef[];
  resolvedRails: readonly ResolvedAlternativeRail[];
}

export type AlternativePaymentListingResult =
  | AlternativePaymentListingAdmission
  | (AlternativePaymentDecision & { verdict: "fail" | "indeterminate" | "error" });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableDataProperty(
  source: object,
  key: PropertyKey,
  label: string,
): unknown {
  if (nodeTypes.isProxy(source)) throw new DacsError(`${label} must be stable data`);
  let owner: object | null = source;
  try {
    while (owner !== null) {
      if (nodeTypes.isProxy(owner)) throw new TypeError("proxy prototype");
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor) {
        if (!("value" in descriptor)) throw new TypeError("accessor property");
        return descriptor.value;
      }
      owner = Object.getPrototypeOf(owner);
    }
  } catch {
    throw new DacsError(`${label} must be stable data`);
  }
  return undefined;
}

function stableDataMethod<T extends (...args: never[]) => unknown>(
  source: object,
  key: PropertyKey,
  label: string,
): T {
  const method = stableDataProperty(source, key, label);
  if (typeof method !== "function" || nodeTypes.isProxy(method)) {
    throw new DacsError(`${label} must be a non-Proxy function`);
  }
  return method.bind(source) as T;
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

function decision<TVerdict extends AlternativePaymentVerdict>(
  verdict: TVerdict,
  reason?: string,
): AlternativePaymentDecision & { verdict: TVerdict } {
  return Object.freeze({ verdict, ...(reason ? { reason } : {}) }) as
    AlternativePaymentDecision & { verdict: TVerdict };
}

function capture<T>(value: T, label: string): T {
  return deepFreeze(snapshotCanonicalJson(value, label));
}

function captureRead<T>(value: T, label: string): T {
  return deepFreeze(snapshotCanonicalJsonRead(value, label));
}

function railKey(ref: PaymentRailRef): string {
  return canonicalize(ref);
}

function isConcretePaymentHandler(value: unknown): value is PaymentPhaseType {
  return typeof value === "string" && CONCRETE_PAYMENT_SET.has(value);
}

function isListingLike(value: unknown): value is AlternativePaymentListingLike {
  return (
    isRecord(value) &&
    typeof value.listingId === "string" &&
    value.listingId.length > 0 &&
    Number.isSafeInteger(value.listingVersion) &&
    (value.listingVersion as number) > 0 &&
    Array.isArray(value.pipeline) &&
    value.pipeline.length > 0 &&
    (value.acceptedRails === undefined || Array.isArray(value.acceptedRails))
  );
}

function authenticationDecision(
  auth: unknown,
  invalidReason: string,
  unavailableReason: string,
): AlternativePaymentFailure | null {
  if (!isRecord(auth) || typeof auth.status !== "string") {
    return decision("error", `${unavailableReason}-malformed`);
  }
  if (auth.status === "authenticated") return null;
  if (
    (auth.status === "invalid" ||
      auth.status === "indeterminate" ||
      auth.status === "error") &&
    typeof auth.reason === "string"
  ) {
    return decision(
      auth.status === "invalid" ? "fail" : auth.status,
      auth.status === "invalid" ? invalidReason : unavailableReason,
    );
  }
  return decision("error", `${unavailableReason}-malformed`);
}

function staticListingShape(
  listing: AlternativePaymentListingLike,
  supportsPayAlternative: boolean,
):
  | AlternativePaymentFailure
  | {
      alternativeIndex?: number;
      alternatives: PaymentRailRef[];
      accepted: PaymentRailRef[];
      concreteIndexes: number[];
    } {
  const accepted = listing.acceptedRails;
  if (!accepted || accepted.length === 0) {
    return decision("fail", "listing-shape");
  }
  if (!accepted.every(isPaymentRailRef)) {
    return decision("fail", "accepted-ref-shape");
  }
  let acceptedKeys: string[];
  try {
    acceptedKeys = accepted.map(railKey);
  } catch {
    return decision("error", "accepted-ref-canonicalization");
  }
  if (new Set(acceptedKeys).size !== acceptedKeys.length) {
    return decision("fail", "accepted-duplicate");
  }

  const alternativeIndexes: number[] = [];
  const concreteIndexes: number[] = [];
  for (let index = 0; index < listing.pipeline.length; index += 1) {
    const phase = listing.pipeline[index];
    if (!isRecord(phase) || typeof phase.kind !== "string") {
      return decision("fail", "listing-shape");
    }
    if (phase.kind === "pay-alternative") alternativeIndexes.push(index);
    if (isConcretePaymentHandler(phase.kind)) concreteIndexes.push(index);
  }

  if (alternativeIndexes.length > 0) {
    if (!supportsPayAlternative) return decision("fail", "unsupported-phase");
    if (alternativeIndexes.length !== 1) {
      return decision("fail", "alternative-slot-cardinality");
    }
    if (concreteIndexes.length > 0) {
      return decision("fail", "alternative-concrete-sibling");
    }
    const alternativeIndex = alternativeIndexes[0]!;
    const phase = listing.pipeline[alternativeIndex] as unknown as Record<
      string,
      unknown
    >;
    const parameters = phase.parameters;
    if (
      !isRecord(parameters) ||
      Object.keys(parameters).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(parameters, "alternatives")
    ) {
      return decision("fail", "alternative-parameters");
    }
    const alternatives = parameters.alternatives;
    if (!Array.isArray(alternatives) || alternatives.length < 2) {
      return decision("fail", "alternative-cardinality");
    }
    if (!alternatives.every(isPaymentRailRef)) {
      return decision("fail", "alternative-ref-shape");
    }
    let keys: string[];
    try {
      keys = alternatives.map(railKey);
    } catch {
      return decision("error", "alternative-ref-canonicalization");
    }
    if (new Set(keys).size !== keys.length) {
      return decision("fail", "alternative-duplicate");
    }
    if (keys.some((key) => acceptedKeys.filter((entry) => entry === key).length !== 1)) {
      return decision("fail", "alternative-membership");
    }
    return {
      alternativeIndex,
      alternatives: captureRead(alternatives, "pay-alternative refs"),
      accepted: captureRead(accepted, "accepted rail refs"),
      concreteIndexes,
    };
  }

  for (const index of concreteIndexes) {
    const phase = listing.pipeline[index] as unknown as Record<string, unknown>;
    const parameters = phase.parameters;
    if (
      !isRecord(parameters) ||
      Object.keys(parameters).length !== 1 ||
      typeof parameters.rail !== "string"
    ) {
      return decision("fail", "concrete-parameters");
    }
    if (!accepted.some((ref) => ref.railId === parameters.rail)) {
      return decision("fail", "concrete-membership");
    }
  }
  return {
    alternatives: [],
    accepted: captureRead(accepted, "accepted rail refs"),
    concreteIndexes,
  };
}

/**
 * APR-1/APR-2 authenticated Listing admission. All accepted refs are resolved
 * from one snapshot; a non-selected extra ref cannot hide from LRR checks.
 */
export async function validateAlternativePaymentListing(
  listingSource: AlternativePaymentListingLike,
  depsSource: AlternativePaymentListingDeps,
): Promise<AlternativePaymentListingResult> {
  let listing: AlternativePaymentListingLike;
  let deps: AlternativePaymentListingDeps;
  try {
    if (!isRecord(depsSource) || nodeTypes.isProxy(depsSource)) {
      return decision("error", "listing-dependencies-malformed");
    }
    const authenticateListing = stableDataMethod<
      AlternativePaymentListingDeps["authenticateListing"]
    >(depsSource, "authenticateListing", "authenticateListing");
    const resolveRegistry = stableDataMethod<
      AlternativePaymentListingDeps["resolveRegistry"]
    >(depsSource, "resolveRegistry", "resolveRegistry");
    const authenticateDefinition = stableDataMethod<
      AlternativePaymentListingDeps["authenticateDefinition"]
    >(depsSource, "authenticateDefinition", "authenticateDefinition");
    const supportedHandlers = stableDataProperty(
      depsSource,
      "supportedHandlers",
      "supportedHandlers",
    );
    const supportsPayAlternative = stableDataProperty(
      depsSource,
      "supportsPayAlternative",
      "supportsPayAlternative",
    );
    if (
      !Array.isArray(supportedHandlers) ||
      !supportedHandlers.every(isConcretePaymentHandler) ||
      (supportsPayAlternative !== undefined &&
        typeof supportsPayAlternative !== "boolean")
    ) {
      return decision("error", "listing-dependencies-malformed");
    }
    deps = Object.freeze({
      authenticateListing,
      resolveRegistry,
      authenticateDefinition,
      supportedHandlers: captureRead(
        supportedHandlers,
        "supported payment handlers",
      ),
      ...(supportsPayAlternative === undefined
        ? {}
        : { supportsPayAlternative }),
    });
  } catch {
    return decision("error", "listing-dependencies-malformed");
  }
  try {
    listing = capture(listingSource, "pay-alternative Listing");
    if (!isListingLike(listing)) return decision("fail", "listing-shape");
  } catch {
    return decision("error", "listing-input-malformed");
  }

  let listingAuth: unknown;
  try {
    listingAuth = captureRead(
      await deps.authenticateListing(listing),
      "Listing authentication result",
    );
  } catch {
    return decision("indeterminate", "listing-authentication-unavailable");
  }
  const listingAuthFailure = authenticationDecision(
    listingAuth,
    "listing-signature",
    "listing-authentication-unavailable",
  );
  if (listingAuthFailure) return listingAuthFailure;

  const shaped = staticListingShape(
    listing,
    deps.supportsPayAlternative !== false,
  );
  if ("verdict" in shaped) return shaped;

  let registry: AlternativeRegistrySnapshot;
  try {
    registry = captureRead(
      await deps.resolveRegistry(listing),
      "pay-alternative registry snapshot",
    );
  } catch {
    return decision("indeterminate", "registry-authority");
  }
  if (!isRecord(registry) || typeof registry.status !== "string") {
    return decision("error", "registry-authority-malformed");
  }
  if (registry.status === "indeterminate") {
    return typeof registry.reason === "string"
      ? decision("indeterminate", "registry-authority")
      : decision("error", "registry-authority-malformed");
  }
  if (
    registry.status !== "authenticated" ||
    typeof registry.snapshotId !== "string" ||
    registry.snapshotId.length === 0 ||
    !Array.isArray(registry.resolutions)
  ) {
    return decision("error", "registry-authority-malformed");
  }

  const supported = new Set(deps.supportedHandlers);
  const resolvedRails: ResolvedAlternativeRail[] = [];
  const handlersByRailId = new Map<string, string>();
  for (const ref of shaped.accepted) {
    const key = railKey(ref);
    const matches = registry.resolutions.filter((entry) => {
      try {
        return isRecord(entry) && isPaymentRailRef(entry.ref) && railKey(entry.ref) === key;
      } catch {
        return false;
      }
    });
    if (matches.length === 0) return decision("fail", "definition-missing");
    if (matches.length !== 1) return decision("fail", "definition-ambiguous");
    const resolution = matches[0]!;
    if (resolution.snapshotId !== registry.snapshotId) {
      return decision("fail", "registry-snapshot");
    }
    if (resolution.status === "unavailable") {
      return decision("indeterminate", "definition-unavailable");
    }
    if (resolution.status !== "verified" || !isRecord(resolution.definition)) {
      return decision("fail", "definition-status");
    }
    const definition = resolution.definition;
    let definitionAuth: unknown;
    try {
      definitionAuth = captureRead(
        await deps.authenticateDefinition(definition),
        "RailDefinition authentication result",
      );
    } catch {
      return decision("indeterminate", "definition-authentication-unavailable");
    }
    const definitionFailure = authenticationDecision(
      definitionAuth,
      "definition-signature",
      "definition-authentication-unavailable",
    );
    if (definitionFailure) return definitionFailure;
    if (
      typeof definition.railId !== "string" ||
      !Number.isSafeInteger(definition.railVersion) ||
      definition.railId !== ref.railId ||
      (ref.railVersion !== undefined && definition.railVersion !== ref.railVersion)
    ) {
      return decision("fail", "definition-ref");
    }
    if (
      !isConcretePaymentHandler(definition.phaseHandler) ||
      !supported.has(definition.phaseHandler)
    ) {
      return decision("fail", "handler-unsupported");
    }
    const priorHandler = handlersByRailId.get(ref.railId);
    if (priorHandler !== undefined && priorHandler !== definition.phaseHandler) {
      return decision("fail", "handler-invariance");
    }
    handlersByRailId.set(ref.railId, definition.phaseHandler);
    resolvedRails.push({
      ref: captureRead(ref, "resolved alternative ref"),
      definition: captureRead(definition, "resolved RailDefinition"),
    });
  }

  for (const index of shaped.concreteIndexes) {
    const phase = listing.pipeline[index]!;
    const railId = phase.parameters?.rail;
    if (
      typeof railId !== "string" ||
      resolvedRails.some(
        (entry) =>
          entry.ref.railId === railId && entry.definition.phaseHandler !== phase.kind,
      )
    ) {
      return decision("fail", "concrete-handler");
    }
  }

  const admitted = deepFreeze({
    verdict: "pass" as const,
    listing,
    ...(shaped.alternativeIndex === undefined
      ? {}
      : { alternativeIndex: shaped.alternativeIndex }),
    alternatives: shaped.alternatives,
    resolvedRails,
  });
  AUTHENTICATED_ADMISSIONS.add(admitted);
  return admitted;
}

export interface AlternativePaymentAgreementLike {
  jobId: string;
  listingRef?: {
    listingId: string;
    version: number;
    contentHash: string;
  };
  terms: {
    rail?: PaymentRailRef;
    payoutBindings?: Array<{
      railId: string;
      phaseIndex: number;
      payeeAddress?: string;
    }>;
    priorPaymentDispositionRef?: AttestationRef;
  };
  signatures?: unknown[];
  parties?: unknown[];
}

export interface AlternativePaymentProjectionDeps {
  agreementState: "draft" | "signed";
  /** Trusted local execution mode fixed before inspecting protocol artifacts. */
  productionMode: boolean;
  /** Repeat authoritative resolution and pin the selected definition at session start. */
  pinSelectedDefinition: (
    ref: Readonly<PaymentRailRef>,
  ) =>
    | Promise<AlternativeSessionDefinitionPin>
    | AlternativeSessionDefinitionPin;
  authenticateAgreement?: (
    agreement: Readonly<AlternativePaymentAgreementLike>,
  ) =>
    | Promise<AlternativeArtifactAuthentication>
    | AlternativeArtifactAuthentication;
  /** If supplied, a mismatch is rejected; it never becomes projection authority. */
  claimedProjectedStep?: unknown;
  operatorPreflight?: (
    definition: Readonly<AlternativeRailDefinition>,
  ) => Promise<boolean> | boolean;
}

export type AlternativeSessionDefinitionPin =
  | { status: "indeterminate" | "invalid"; reason: string }
  | {
      status: "authenticated";
      ref: PaymentRailRef;
      definition: AlternativeRailDefinition;
    };

export interface AlternativePaymentProjection
  extends AlternativePaymentDecision {
  verdict: "pass";
  agreement: Readonly<AlternativePaymentAgreementLike>;
  selectedRail: Readonly<PaymentRailRef>;
  selectedDefinition: Readonly<AlternativeRailDefinition>;
  paymentPhaseIndex: number;
  effectivePipeline: readonly PhaseStep[];
}

export type AlternativePaymentProjectionResult =
  | AlternativePaymentProjection
  | (AlternativePaymentDecision & { verdict: "fail" | "indeterminate" | "error" });

/** APR-3..APR-5 deterministic, index-preserving projection and payout gate. */
export async function projectAlternativePaymentPipeline(
  admission: AlternativePaymentListingAdmission,
  agreementSource: AlternativePaymentAgreementLike,
  depsSource: AlternativePaymentProjectionDeps,
): Promise<AlternativePaymentProjectionResult> {
  if (!AUTHENTICATED_ADMISSIONS.has(admission)) {
    return decision("error", "listing-admission-not-authenticated");
  }
  let agreement: AlternativePaymentAgreementLike;
  let deps: AlternativePaymentProjectionDeps;
  try {
    if (!isRecord(depsSource) || nodeTypes.isProxy(depsSource)) {
      return decision("error", "projection-dependencies-malformed");
    }
    const agreementState = stableDataProperty(
      depsSource,
      "agreementState",
      "agreementState",
    );
    const productionMode = stableDataProperty(
      depsSource,
      "productionMode",
      "productionMode",
    );
    const pinSelectedDefinitionSource = stableDataProperty(
      depsSource,
      "pinSelectedDefinition",
      "pinSelectedDefinition",
    );
    const authenticationSource = stableDataProperty(
      depsSource,
      "authenticateAgreement",
      "authenticateAgreement",
    );
    const preflightSource = stableDataProperty(
      depsSource,
      "operatorPreflight",
      "operatorPreflight",
    );
    const claimedProjectedStep = stableDataProperty(
      depsSource,
      "claimedProjectedStep",
      "claimedProjectedStep",
    );
    if (
      (agreementState !== "draft" && agreementState !== "signed") ||
      typeof productionMode !== "boolean" ||
      typeof pinSelectedDefinitionSource !== "function" ||
      (authenticationSource !== undefined &&
        typeof authenticationSource !== "function") ||
      (preflightSource !== undefined && typeof preflightSource !== "function")
    ) {
      return decision("error", "projection-dependencies-malformed");
    }
    deps = Object.freeze({
      agreementState,
      productionMode,
      pinSelectedDefinition: stableDataMethod<
        AlternativePaymentProjectionDeps["pinSelectedDefinition"]
      >(depsSource, "pinSelectedDefinition", "pinSelectedDefinition"),
      ...(authenticationSource === undefined
        ? {}
        : {
            authenticateAgreement: stableDataMethod<
              NonNullable<AlternativePaymentProjectionDeps["authenticateAgreement"]>
            >(depsSource, "authenticateAgreement", "authenticateAgreement"),
          }),
      ...(preflightSource === undefined
        ? {}
        : {
            operatorPreflight: stableDataMethod<
              NonNullable<AlternativePaymentProjectionDeps["operatorPreflight"]>
            >(depsSource, "operatorPreflight", "operatorPreflight"),
          }),
      ...(claimedProjectedStep === undefined
        ? {}
        : {
            claimedProjectedStep: captureRead(
              claimedProjectedStep,
              "claimed projected payment step",
            ),
          }),
    });
    agreement = captureRead(agreementSource, "pay-alternative Agreement");
    if (
      !isRecord(agreement) ||
      typeof agreement.jobId !== "string" ||
      !isRecord(agreement.terms)
    ) {
      return decision("error", "agreement-shape");
    }
    requireCanonicalJobId(agreement.jobId);
  } catch {
    return decision("error", "projection-input-malformed");
  }

  if (deps.agreementState === "signed") {
    if (!deps.authenticateAgreement) {
      return decision("indeterminate", "agreement-authentication-unavailable");
    }
    let auth: unknown;
    try {
      auth = captureRead(
        await deps.authenticateAgreement(agreement),
        "Agreement authentication result",
      );
    } catch {
      return decision("indeterminate", "agreement-authentication-unavailable");
    }
    const authFailure = authenticationDecision(
      auth,
      "agreement-signature",
      "agreement-authentication-unavailable",
    );
    if (authFailure) return authFailure;
    const expectedListingRef = {
      listingId: admission.listing.listingId,
      version: admission.listing.listingVersion,
      contentHash: contentHash(
        admission.listing as unknown as Record<string, unknown>,
      ),
    };
    if (
      !agreement.listingRef ||
      canonicalize(agreement.listingRef) !== canonicalize(expectedListingRef)
    ) {
      return decision("fail", "agreement-listing-ref");
    }
  } else if ((agreement.signatures?.length ?? 0) > 0) {
    return decision("fail", "agreement-already-signed");
  }

  const selected = agreement.terms.rail;
  if (!isPaymentRailRef(selected)) return decision("fail", "selection-shape");
  const selectedKey = railKey(selected);
  if (
    admission.alternativeIndex !== undefined &&
    admission.alternatives.filter((ref) => railKey(ref) === selectedKey).length !== 1
  ) {
    return decision("fail", "selection-membership");
  }
  if (
    admission.alternativeIndex === undefined &&
    !admission.resolvedRails.some((entry) => railKey(entry.ref) === selectedKey)
  ) {
    return decision("fail", "selection-membership");
  }
  const selectedResolution = admission.resolvedRails.find(
    (entry) => railKey(entry.ref) === selectedKey,
  );
  if (!selectedResolution) return decision("fail", "selection-resolution");
  let sessionPin: AlternativeSessionDefinitionPin;
  try {
    sessionPin = captureRead(
      await deps.pinSelectedDefinition(
        captureRead(selected, "selected session rail ref"),
      ),
      "selected session RailDefinition pin",
    );
  } catch {
    return decision("indeterminate", "selected-definition-unavailable");
  }
  if (!isRecord(sessionPin) || typeof sessionPin.status !== "string") {
    return decision("error", "selected-definition-pin-malformed");
  }
  if (sessionPin.status === "indeterminate") {
    return decision("indeterminate", "selected-definition-unavailable");
  }
  if (
    sessionPin.status !== "authenticated" ||
    !isPaymentRailRef(sessionPin.ref) ||
    !isRecord(sessionPin.definition)
  ) {
    return decision("fail", "selected-definition-invalid");
  }
  const definition = sessionPin.definition;
  if (
    railKey(sessionPin.ref) !== selectedKey ||
    definition.railId !== selected.railId ||
    !Number.isSafeInteger(definition.railVersion) ||
    definition.railVersion <= 0 ||
    (selected.railVersion !== undefined &&
      definition.railVersion !== selected.railVersion) ||
    !isConcretePaymentHandler(definition.phaseHandler) ||
    definition.phaseHandler !== selectedResolution.definition.phaseHandler
  ) {
    return decision("fail", "selected-definition-pin");
  }
  const mockedAllowed =
    definition.availability === "mocked" && deps.productionMode === false;
  if (!ACTIVE_AVAILABILITY.has(definition.availability) && !mockedAllowed) {
    if (!GATED_AVAILABILITY.has(definition.availability)) {
      return decision("fail", "selected-availability");
    }
    if (!deps.operatorPreflight) return decision("fail", "selected-availability");
    try {
      if ((await deps.operatorPreflight(definition)) !== true) {
        return decision("fail", "selected-availability");
      }
    } catch {
      return decision("indeterminate", "selected-availability-unavailable");
    }
  }

  const effective = snapshotCanonicalJsonRead(
    admission.listing.pipeline,
    "effective pipeline source",
  ) as PhaseStep[];
  let paymentPhaseIndex: number;
  if (admission.alternativeIndex !== undefined) {
    paymentPhaseIndex = admission.alternativeIndex;
    effective[paymentPhaseIndex] = {
      kind: definition.phaseHandler as PaymentPhaseType,
      parameters: { rail: selected.railId },
    };
    if (
      deps.claimedProjectedStep !== undefined &&
      canonicalize(deps.claimedProjectedStep) !== canonicalize(effective[paymentPhaseIndex])
    ) {
      return decision("fail", "projection-mismatch");
    }
  } else {
    const paymentIndexes = effective
      .map((phase, index) =>
        isConcretePaymentHandler(phase.kind) ? index : -1,
      )
      .filter((index) => index >= 0);
    if (paymentIndexes.length === 0) return decision("fail", "selection-membership");
    paymentPhaseIndex = paymentIndexes[0]!;
  }

  const expectedBindings = effective
    .map((phase, index) =>
      isConcretePaymentHandler(phase.kind)
        ? `${selected.railId}\u0000${index}`
        : null,
    )
    .filter((value): value is string => value !== null)
    .sort();
  const bindings = agreement.terms.payoutBindings;
  if (!Array.isArray(bindings)) return decision("fail", "payout-binding");
  const actualBindings = bindings
    .map((binding) =>
      isRecord(binding) &&
      typeof binding.railId === "string" &&
      Number.isSafeInteger(binding.phaseIndex)
        ? `${binding.railId}\u0000${binding.phaseIndex}`
        : null,
    )
    .filter((value): value is string => value !== null)
    .sort();
  if (
    actualBindings.length !== bindings.length ||
    canonicalize(actualBindings) !== canonicalize(expectedBindings)
  ) {
    return decision("fail", "payout-binding");
  }

  const projected = deepFreeze({
    verdict: "pass" as const,
    agreement,
    selectedRail: captureRead(selected, "selected rail"),
    selectedDefinition: captureRead(definition, "selected RailDefinition"),
    paymentPhaseIndex,
    effectivePipeline: effective,
  });
  AUTHENTICATED_PROJECTIONS.add(projected);
  return projected;
}

export type AlternativeFixedPriceAgreementInput = Omit<
  FixedPriceAgreementInput,
  "selectedRail"
> & {
  /** Exact complete APR-3 selection; no railId-only convenience input exists. */
  selectedRail: PaymentRailRef;
  /** Signed APR-6 carrier for a claimed fresh-job replacement, when applicable. */
  priorPaymentDispositionRef?: AttestationRef;
};

export interface AlternativeFixedPriceAgreementDeps {
  productionMode: boolean;
  pinSelectedDefinition: AlternativePaymentProjectionDeps["pinSelectedDefinition"];
  /** RAV preflight for a registry definition whose availability is operator-gated. */
  operatorPreflight?: AlternativePaymentProjectionDeps["operatorPreflight"];
}

export interface AlternativeFixedPriceAgreementSuccess {
  verdict: "pass";
  agreement: UnsignedAgreementArtifact;
  projection: AlternativePaymentProjection;
}

export type AlternativeFixedPriceAgreementResult =
  | AlternativeFixedPriceAgreementSuccess
  | (AlternativePaymentDecision & { verdict: "fail" | "indeterminate" | "error" });

/**
 * APR-3 producer boundary for fixed-price Agreements. It delegates ordinary
 * term derivation to the existing fixed-price producer, but the temporary
 * concrete pipeline never leaves this function: the returned Agreement keeps
 * the exact signed APR Listing pin and the independently verified projection.
 */
export async function deriveAlternativeFixedPriceAgreement(
  admission: AlternativePaymentListingAdmission,
  inputSource: AlternativeFixedPriceAgreementInput,
  depsSource: AlternativeFixedPriceAgreementDeps,
): Promise<AlternativeFixedPriceAgreementResult> {
  if (!AUTHENTICATED_ADMISSIONS.has(admission)) {
    return decision("error", "listing-admission-not-authenticated");
  }
  if (admission.alternativeIndex === undefined) {
    return decision("fail", "listing-has-no-alternative-slot");
  }

  let input: AlternativeFixedPriceAgreementInput;
  let operatorPreflight:
    | AlternativePaymentProjectionDeps["operatorPreflight"]
    | undefined;
  let productionMode: boolean;
  let pinSelectedDefinition: AlternativePaymentProjectionDeps["pinSelectedDefinition"];
  try {
    input = capture(inputSource, "alternative fixed-price Agreement input");
    if (!isRecord(depsSource) || nodeTypes.isProxy(depsSource)) {
      return decision("error", "agreement-producer-dependencies-malformed");
    }
    const preflightSource = stableDataProperty(
      depsSource,
      "operatorPreflight",
      "operatorPreflight",
    );
    const productionModeSource = stableDataProperty(
      depsSource,
      "productionMode",
      "productionMode",
    );
    const pinSource = stableDataProperty(
      depsSource,
      "pinSelectedDefinition",
      "pinSelectedDefinition",
    );
    if (
      typeof productionModeSource !== "boolean" ||
      typeof pinSource !== "function" ||
      (preflightSource !== undefined && typeof preflightSource !== "function")
    ) {
      return decision("error", "agreement-producer-dependencies-malformed");
    }
    productionMode = productionModeSource;
    pinSelectedDefinition = stableDataMethod<
      AlternativePaymentProjectionDeps["pinSelectedDefinition"]
    >(depsSource, "pinSelectedDefinition", "pinSelectedDefinition");
    operatorPreflight =
      preflightSource === undefined
        ? undefined
        : stableDataMethod<
            NonNullable<AlternativePaymentProjectionDeps["operatorPreflight"]>
          >(depsSource, "operatorPreflight", "operatorPreflight");
  } catch {
    return decision("error", "agreement-producer-input-malformed");
  }

  const { listing, pin } = input.verifiedListing;
  try {
    if (
      input.verifiedListing.disposition !== "verified" ||
      canonicalize(listing) !== canonicalize(admission.listing) ||
      pin.listingId !== listing.listingId ||
      pin.version !== listing.listingVersion ||
      pin.contentHash !== contentHash(listing as unknown as Record<string, unknown>)
    ) {
      return decision("fail", "listing-admission-binding");
    }
  } catch {
    return decision("error", "listing-admission-binding-malformed");
  }

  let selectedKey: string;
  try {
    if (!isPaymentRailRef(input.selectedRail)) {
      return decision("fail", "selection-shape");
    }
    selectedKey = railKey(input.selectedRail);
  } catch {
    return decision("error", "selection-shape");
  }
  const selected = admission.resolvedRails.find(
    (entry) => railKey(entry.ref) === selectedKey,
  );
  if (!selected) return decision("fail", "selection-membership");

  if (
    input.priorPaymentDispositionRef !== undefined &&
    !isAttestationRef(input.priorPaymentDispositionRef)
  ) {
    return decision("fail", "prior-disposition-ref");
  }

  let derived: UnsignedAgreementArtifact;
  try {
    const effectiveListing = snapshotCanonicalJsonRead(
      listing,
      "alternative Agreement effective Listing",
    ) as Listing;
    effectiveListing.pipeline[admission.alternativeIndex] = {
      kind: selected.definition.phaseHandler as PaymentPhaseType,
      parameters: { rail: input.selectedRail.railId },
    };
    const effectivePin = {
      listingId: effectiveListing.listingId,
      version: effectiveListing.listingVersion,
      contentHash: contentHash(
        effectiveListing as unknown as Record<string, unknown>,
      ),
    };
    derived = deriveFixedPriceAgreement(
      snapshotCanonicalJsonRead(
        {
          ...input,
          verifiedListing: {
            disposition: "verified",
            listing: effectiveListing,
            pin: effectivePin,
          },
          selectedRail: input.selectedRail,
        },
        "alternative Agreement derivation input",
      ),
    );
  } catch (error) {
    return decision(
      "fail",
      error instanceof DacsError
        ? `agreement-derivation:${error.message}`
        : "agreement-derivation",
    );
  }
  if (!("payeeBoundAgreementVersion" in derived)) {
    return decision("fail", "alternative-requires-payee-bound-agreement");
  }

  const agreement = snapshotCanonicalJsonRead({
    ...derived,
    listingRef: captureRead(pin, "signed alternative Listing pin"),
    terms: {
      ...derived.terms,
      ...(input.priorPaymentDispositionRef === undefined
        ? {}
        : {
            priorPaymentDispositionRef: captureRead(
              input.priorPaymentDispositionRef,
              "prior payment disposition ref",
            ),
          }),
    },
  }, "alternative fixed-price Agreement") as Readonly<UnsignedAgreementArtifact>;
  const projection = await projectAlternativePaymentPipeline(
    admission,
    agreement as unknown as AlternativePaymentAgreementLike,
    {
      agreementState: "draft",
      productionMode,
      pinSelectedDefinition,
      ...(operatorPreflight === undefined ? {} : { operatorPreflight }),
    },
  );
  if (projection.verdict !== "pass") return projection;
  return Object.freeze({ verdict: "pass" as const, agreement, projection });
}

export function priorPaymentDispositionHash(
  disposition: Readonly<PriorPaymentDisposition>,
): string {
  return contentHash(disposition as unknown as Record<string, unknown>);
}

export function priorPaymentDispositionAddress(
  priorJobId: string,
  priorPhaseIndex: number,
  dispositionId: string,
): string {
  requireCanonicalJobId(priorJobId);
  if (!Number.isSafeInteger(priorPhaseIndex) || priorPhaseIndex < 0) {
    throw new DacsError("priorPhaseIndex must be a non-negative safe integer");
  }
  if (!/^[0-9a-f]{64}$/.test(dispositionId)) {
    throw new DacsError("dispositionId must be 64 lower-case hexadecimal characters");
  }
  return `dacs4:payment-disposition:${priorJobId}:${priorPhaseIndex}:${dispositionId}`;
}

export function priorPaymentDispositionReference(
  dispositionSource: Readonly<PriorPaymentDisposition>,
): AttestationRef {
  const disposition = captureRead(
    dispositionSource,
    "PriorPaymentDisposition",
  );
  return deepFreeze({
    anchor: {
      kind: "storage-program",
      locator: priorPaymentDispositionAddress(
        disposition.priorJobId,
        disposition.priorPhaseIndex,
        disposition.dispositionId,
      ),
    },
    contentHash: priorPaymentDispositionHash(disposition),
    signer: disposition.signature.signer,
  });
}

export function priorPaymentDispositionSignedBytes(
  disposition: Readonly<PriorPaymentDisposition>,
): Uint8Array {
  return signedBytes(
    PRIOR_PAYMENT_DISPOSITION_SEPARATOR,
    priorPaymentDispositionHash(disposition),
  );
}

export type UnsignedPriorPaymentDisposition = Omit<
  PriorPaymentDisposition,
  "signature"
>;

export interface PriorPaymentDispositionSigner {
  algorithm: ComponentSignatureAlgorithm;
  signer: string;
  sign: (
    bytes: Uint8Array,
    context: Pick<ComponentSignature, "algorithm" | "signer">,
  ) => Promise<Uint8Array | string> | Uint8Array | string;
}

export interface PriorPaymentAuthorizationClosure {
  status: "closed" | "indeterminate";
  priorJobId: string;
  railRefHash: string;
  priorPhaseIndex: number;
  authorizationJournalClosed: boolean;
}

export interface PriorPaymentDispositionIssuanceDeps {
  /** Atomic durable close of the old authorization tuple before signing. */
  closeBeforeAuthorization: (input: Readonly<{
    priorJobId: string;
    railRefHash: string;
    priorPhaseIndex: number;
  }>) =>
    | Promise<PriorPaymentAuthorizationClosure>
    | PriorPaymentAuthorizationClosure;
  /** Selected-handler terminal proof validation for closed-cannot-settle. */
  verifyCannotSettle: (input: Readonly<{
    priorJobId: string;
    priorSelection: PaymentRailRef;
    priorPhaseIndex: number;
    evidenceRefs: AttestationRef[];
  }>) => Promise<boolean> | boolean;
}

function isPriorPaymentDispositionShape(
  value: unknown,
): value is PriorPaymentDisposition {
  if (!isRecord(value)) return false;
  const required = [
    "priorPaymentDispositionVersion",
    "dispositionId",
    "priorJobId",
    "replacementJobId",
    "priorAgreementRef",
    "priorSelection",
    "priorPhaseIndex",
    "disposition",
    "observedAt",
    "signature",
  ];
  const allowed = new Set([...required, "reconciliationEvidenceRefs"]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key)) ||
    value.priorPaymentDispositionVersion !== "1" ||
    typeof value.dispositionId !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.dispositionId) ||
    typeof value.priorJobId !== "string" ||
    typeof value.replacementJobId !== "string" ||
    !isAttestationRef(value.priorAgreementRef) ||
    !isPaymentRailRef(value.priorSelection) ||
    !Number.isSafeInteger(value.priorPhaseIndex) ||
    (value.priorPhaseIndex as number) < 0 ||
    ![
      "closed-before-authorization",
      "authorization-pending",
      "settlement-indeterminate",
      "closed-cannot-settle",
    ].includes(value.disposition as string) ||
    !Number.isSafeInteger(value.observedAt) ||
    (value.observedAt as number) < 0 ||
    !isComponentSignature(value.signature) ||
    (value.reconciliationEvidenceRefs !== undefined &&
      (!Array.isArray(value.reconciliationEvidenceRefs) ||
        !value.reconciliationEvidenceRefs.every(isAttestationRef)))
  ) {
    return false;
  }
  try {
    requireCanonicalJobId(value.priorJobId);
    requireCanonicalJobId(value.replacementJobId);
    priorPaymentDispositionAddress(
      value.priorJobId,
      value.priorPhaseIndex as number,
      value.dispositionId,
    );
    return true;
  } catch {
    return false;
  }
}

/** Create the signed APR-6 carrier without adding it to the legacy separator pin. */
export async function buildPriorPaymentDisposition(
  unsignedSource: UnsignedPriorPaymentDisposition,
  signerSource: PriorPaymentDispositionSigner,
  depsSource: PriorPaymentDispositionIssuanceDeps,
): Promise<PriorPaymentDisposition> {
  const unsigned = capture(unsignedSource, "unsigned PriorPaymentDisposition");
  let algorithm: ComponentSignatureAlgorithm;
  let signer: string;
  let sign: PriorPaymentDispositionSigner["sign"];
  let closeBeforeAuthorization: PriorPaymentDispositionIssuanceDeps["closeBeforeAuthorization"];
  let verifyCannotSettle: PriorPaymentDispositionIssuanceDeps["verifyCannotSettle"];
  try {
    if (!isRecord(signerSource) || nodeTypes.isProxy(signerSource)) {
      throw new DacsError("malformed signer");
    }
    const algorithmSource = stableDataProperty(
      signerSource,
      "algorithm",
      "signature algorithm",
    );
    const signerClaim = stableDataProperty(
      signerSource,
      "signer",
      "signer claim",
    );
    if (
      typeof signerClaim !== "string" ||
      signerClaim.length === 0 ||
      !["ed25519", "ecdsa-secp256k1", "sr1-aggregate"].includes(
        algorithmSource as string,
      )
    ) {
      throw new DacsError("malformed signer");
    }
    algorithm = algorithmSource as ComponentSignatureAlgorithm;
    signer = signerClaim;
    sign = stableDataMethod<PriorPaymentDispositionSigner["sign"]>(
      signerSource,
      "sign",
      "PriorPaymentDisposition signer",
    );
    if (!isRecord(depsSource) || nodeTypes.isProxy(depsSource)) {
      throw new DacsError("malformed issuance dependencies");
    }
    closeBeforeAuthorization = stableDataMethod<
      PriorPaymentDispositionIssuanceDeps["closeBeforeAuthorization"]
    >(
      depsSource,
      "closeBeforeAuthorization",
      "closeBeforeAuthorization",
    );
    verifyCannotSettle = stableDataMethod<
      PriorPaymentDispositionIssuanceDeps["verifyCannotSettle"]
    >(depsSource, "verifyCannotSettle", "verifyCannotSettle");
  } catch {
    throw new DacsError(
      "PriorPaymentDisposition signer or issuance dependencies are malformed",
    );
  }
  const provisional = {
    ...unsigned,
    signature: {
      algorithm,
      signer,
      value: "AA",
    },
  } as PriorPaymentDisposition;
  if (!isPriorPaymentDispositionShape(provisional)) {
    throw new DacsError("PriorPaymentDisposition is malformed");
  }
  if (unsigned.disposition === "closed-before-authorization") {
    if ((unsigned.reconciliationEvidenceRefs?.length ?? 0) !== 0) {
      throw new DacsError(
        "closed-before-authorization must not carry reconciliation evidence",
      );
    }
    const expectedClosure = {
      priorJobId: unsigned.priorJobId,
      railRefHash: sha256Hex(canonicalize(unsigned.priorSelection)),
      priorPhaseIndex: unsigned.priorPhaseIndex,
    };
    let closure: PriorPaymentAuthorizationClosure;
    try {
      closure = captureRead(
        await closeBeforeAuthorization(deepFreeze({ ...expectedClosure })),
        "prior authorization closure",
      );
    } catch (cause) {
      throw new DacsError(
        "prior authorization closure is unavailable; disposition was not signed",
        { cause },
      );
    }
    if (
      !isRecord(closure) ||
      closure.status !== "closed" ||
      closure.authorizationJournalClosed !== true ||
      closure.priorJobId !== expectedClosure.priorJobId ||
      closure.railRefHash !== expectedClosure.railRefHash ||
      closure.priorPhaseIndex !== expectedClosure.priorPhaseIndex
    ) {
      throw new DacsError(
        "prior authorization was not durably closed; disposition was not signed",
      );
    }
  } else if (unsigned.disposition === "closed-cannot-settle") {
    const evidenceRefs = unsigned.reconciliationEvidenceRefs;
    if (!evidenceRefs || evidenceRefs.length === 0) {
      throw new DacsError(
        "closed-cannot-settle requires terminal reconciliation evidence",
      );
    }
    let verified: unknown;
    try {
      verified = await verifyCannotSettle(
        deepFreeze({
          priorJobId: unsigned.priorJobId,
          priorSelection: captureRead(
            unsigned.priorSelection,
            "prior disposition selection",
          ),
          priorPhaseIndex: unsigned.priorPhaseIndex,
          evidenceRefs: captureRead(
            evidenceRefs,
            "prior terminal reconciliation evidence refs",
          ),
        }),
      );
    } catch (cause) {
      throw new DacsError(
        "terminal reconciliation verification is unavailable; disposition was not signed",
        { cause },
      );
    }
    if (verified !== true) {
      throw new DacsError(
        "terminal reconciliation does not prove cannot-settle; disposition was not signed",
      );
    }
  }
  const context = Object.freeze({
    algorithm,
    signer,
  });
  const signed = await sign(
    signedBytes(
      PRIOR_PAYMENT_DISPOSITION_SEPARATOR,
      contentHash(unsigned as unknown as Record<string, unknown>),
    ),
    context,
  );
  const value =
    typeof signed === "string" ? signed : Buffer.from(signed).toString("base64url");
  if (!isCanonicalBase64Url(value)) {
    throw new DacsError(
      "PriorPaymentDisposition signer returned non-canonical Base64URL",
    );
  }
  if (
    algorithm === "ed25519" &&
    Buffer.from(value, "base64url").byteLength !== 64
  ) {
    throw new DacsError("ed25519 PriorPaymentDisposition signature must be 64 bytes");
  }
  const disposition = deepFreeze({
    ...unsigned,
    signature: { ...context, value },
  }) as PriorPaymentDisposition;
  if (!isPriorPaymentDispositionShape(disposition)) {
    throw new DacsError("signed PriorPaymentDisposition is malformed");
  }
  return disposition;
}

export interface PriorPaymentDispositionReceipt {
  status: "finalized" | "included" | "unavailable";
  logicalAddress: string;
  contentHash: string;
  writer: string;
  /** Durable proof produced atomically with closed-before-authorization. */
  authorizationJournalClosed?: boolean;
}

export type PriorPaymentDispositionResolution =
  | { status: "indeterminate"; reason: string }
  | {
      status: "authenticated";
      disposition: PriorPaymentDisposition;
      receipt: PriorPaymentDispositionReceipt;
    };

export type PriorAgreementResolution =
  | { status: "indeterminate"; reason: string }
  | {
      status: "authenticated";
      agreement: AlternativePaymentAgreementLike;
    };

export type PriorPaymentExecutionAuthority =
  | { status: "indeterminate"; reason: string }
  | { status: "authenticated"; phaseOrchestratorClaim: string };

export interface PriorPaymentReplacementDeps {
  /** True only when the caller is explicitly attempting APR fallback. */
  replacementClaimed: boolean;
  resolveDisposition: (
    ref: Readonly<AttestationRef>,
  ) =>
    | Promise<PriorPaymentDispositionResolution>
    | PriorPaymentDispositionResolution;
  resolvePriorAgreement: (
    ref: Readonly<AttestationRef>,
  ) => Promise<PriorAgreementResolution> | PriorAgreementResolution;
  authenticatePriorAgreement: (
    agreement: Readonly<AlternativePaymentAgreementLike>,
  ) =>
    | Promise<AlternativeArtifactAuthentication>
    | AlternativeArtifactAuthentication;
  authenticateDispositionSignature: (input: Readonly<{
    disposition: PriorPaymentDisposition;
    signedBytes: Uint8Array;
  }>) => Promise<boolean> | boolean;
  resolvePriorExecutionAuthority: (input: Readonly<{
    priorAgreement: AlternativePaymentAgreementLike;
    priorSelection: PaymentRailRef;
    priorPhaseIndex: number;
  }>) =>
    | Promise<PriorPaymentExecutionAuthority>
    | PriorPaymentExecutionAuthority;
  verifyTerminalReconciliation: (input: Readonly<{
    priorAgreement: AlternativePaymentAgreementLike;
    priorSelection: PaymentRailRef;
    priorPhaseIndex: number;
    evidenceRefs: AttestationRef[];
  }>) => Promise<boolean> | boolean;
}

export interface PriorPaymentReplacementAdmission
  extends AlternativePaymentDecision {
  verdict: "pass";
  mode: "independent" | "closed-before-authorization" | "closed-cannot-settle";
  disposition?: Readonly<PriorPaymentDisposition>;
}

export type PriorPaymentReplacementResult =
  | PriorPaymentReplacementAdmission
  | (AlternativePaymentDecision & { verdict: "fail" | "indeterminate" | "error" });

function agreementRail(value: AlternativePaymentAgreementLike): PaymentRailRef | null {
  return isPaymentRailRef(value.terms?.rail) ? value.terms.rail : null;
}

/** APR-6 authenticated replacement gate. It performs no wallet operation. */
export async function verifyPriorPaymentReplacement(
  projection: AlternativePaymentProjection,
  depsSource: PriorPaymentReplacementDeps,
): Promise<PriorPaymentReplacementResult> {
  if (!AUTHENTICATED_PROJECTIONS.has(projection)) {
    return decision("error", "projection-not-authenticated");
  }
  let deps: PriorPaymentReplacementDeps;
  try {
    if (!isRecord(depsSource) || nodeTypes.isProxy(depsSource)) {
      throw new DacsError("malformed dependencies");
    }
    const replacementClaimed = stableDataProperty(
      depsSource,
      "replacementClaimed",
      "replacementClaimed",
    );
    if (typeof replacementClaimed !== "boolean") {
      throw new DacsError("malformed replacement claim");
    }
    deps = Object.freeze({
      replacementClaimed,
      resolveDisposition: stableDataMethod<
        PriorPaymentReplacementDeps["resolveDisposition"]
      >(depsSource, "resolveDisposition", "resolveDisposition"),
      resolvePriorAgreement: stableDataMethod<
        PriorPaymentReplacementDeps["resolvePriorAgreement"]
      >(depsSource, "resolvePriorAgreement", "resolvePriorAgreement"),
      authenticatePriorAgreement: stableDataMethod<
        PriorPaymentReplacementDeps["authenticatePriorAgreement"]
      >(
        depsSource,
        "authenticatePriorAgreement",
        "authenticatePriorAgreement",
      ),
      authenticateDispositionSignature: stableDataMethod<
        PriorPaymentReplacementDeps["authenticateDispositionSignature"]
      >(
        depsSource,
        "authenticateDispositionSignature",
        "authenticateDispositionSignature",
      ),
      resolvePriorExecutionAuthority: stableDataMethod<
        PriorPaymentReplacementDeps["resolvePriorExecutionAuthority"]
      >(
        depsSource,
        "resolvePriorExecutionAuthority",
        "resolvePriorExecutionAuthority",
      ),
      verifyTerminalReconciliation: stableDataMethod<
        PriorPaymentReplacementDeps["verifyTerminalReconciliation"]
      >(
        depsSource,
        "verifyTerminalReconciliation",
        "verifyTerminalReconciliation",
      ),
    });
  } catch {
    return decision("error", "replacement-dependencies-malformed");
  }
  const reference = projection.agreement.terms.priorPaymentDispositionRef;
  if (reference === undefined) {
    if (deps.replacementClaimed) {
      return decision("indeterminate", "prior-disposition-unavailable");
    }
    const independent = deepFreeze({
      verdict: "pass" as const,
      mode: "independent" as const,
    });
    AUTHENTICATED_REPLACEMENTS.set(independent, null);
    return independent;
  }
  if (!isAttestationRef(reference)) {
    return decision("fail", "prior-disposition-ref");
  }

  let resolution: PriorPaymentDispositionResolution;
  try {
    resolution = captureRead(
      await deps.resolveDisposition(reference),
      "PriorPaymentDisposition resolution",
    );
  } catch {
    return decision("indeterminate", "prior-disposition-unavailable");
  }
  if (!isRecord(resolution) || typeof resolution.status !== "string") {
    return decision("error", "prior-disposition-resolution-malformed");
  }
  if (resolution.status === "indeterminate") {
    return decision("indeterminate", "prior-disposition-unavailable");
  }
  if (
    resolution.status !== "authenticated" ||
    !isPriorPaymentDispositionShape(resolution.disposition) ||
    !isRecord(resolution.receipt)
  ) {
    return decision("fail", "prior-disposition-shape");
  }
  const disposition = resolution.disposition;
  const receipt = resolution.receipt;
  if (
    !["finalized", "included", "unavailable"].includes(receipt.status) ||
    typeof receipt.logicalAddress !== "string" ||
    typeof receipt.contentHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(receipt.contentHash) ||
    typeof receipt.writer !== "string" ||
    receipt.writer.length === 0 ||
    (receipt.authorizationJournalClosed !== undefined &&
      typeof receipt.authorizationJournalClosed !== "boolean")
  ) {
    return decision("error", "prior-disposition-receipt-malformed");
  }
  if (receipt.status !== "finalized") {
    return decision("indeterminate", "prior-disposition-unfinalized");
  }

  let executionAuthority: PriorPaymentExecutionAuthority;
  let priorResolution: PriorAgreementResolution;
  try {
    priorResolution = captureRead(
      await deps.resolvePriorAgreement(disposition.priorAgreementRef),
      "prior Agreement resolution",
    );
  } catch {
    return decision("indeterminate", "prior-disposition-unavailable");
  }
  if (!isRecord(priorResolution) || typeof priorResolution.status !== "string") {
    return decision("error", "prior-agreement-resolution-malformed");
  }
  if (priorResolution.status === "indeterminate") {
    return decision("indeterminate", "prior-disposition-unavailable");
  }
  if (
    priorResolution.status !== "authenticated" ||
    !isRecord(priorResolution.agreement) ||
    typeof priorResolution.agreement.jobId !== "string" ||
    !isRecord(priorResolution.agreement.terms) ||
    !isRecord(priorResolution.agreement.listingRef)
  ) {
    return decision("fail", "prior-agreement-shape");
  }
  const priorAgreement = priorResolution.agreement;
  try {
    requireCanonicalJobId(priorAgreement.jobId);
  } catch {
    return decision("fail", "prior-agreement-shape");
  }
  let agreementAuth: unknown;
  try {
    agreementAuth = captureRead(
      await deps.authenticatePriorAgreement(priorAgreement),
      "prior Agreement authentication",
    );
  } catch {
    return decision("indeterminate", "prior-agreement-authentication-unavailable");
  }
  const agreementFailure = authenticationDecision(
    agreementAuth,
    "prior-agreement-signature",
    "prior-agreement-authentication-unavailable",
  );
  if (agreementFailure) return agreementFailure;

  const priorSelection = agreementRail(priorAgreement);
  if (!priorSelection) return decision("fail", "prior-disposition-binding");
  try {
    executionAuthority = captureRead(
      await deps.resolvePriorExecutionAuthority({
        priorAgreement,
        priorSelection,
        priorPhaseIndex: disposition.priorPhaseIndex,
      }),
      "prior execution authority",
    );
  } catch {
    return decision("indeterminate", "prior-disposition-unavailable");
  }
  if (!isRecord(executionAuthority) || typeof executionAuthority.status !== "string") {
    return decision("error", "prior-execution-authority-malformed");
  }
  if (executionAuthority.status === "indeterminate") {
    return decision("indeterminate", "prior-disposition-unavailable");
  }
  if (
    executionAuthority.status !== "authenticated" ||
    typeof executionAuthority.phaseOrchestratorClaim !== "string" ||
    executionAuthority.phaseOrchestratorClaim.length === 0
  ) {
    return decision("fail", "prior-disposition-authority");
  }
  const orchestrator = executionAuthority.phaseOrchestratorClaim;

  let signatureValid: unknown;
  try {
    signatureValid = await deps.authenticateDispositionSignature(
      deepFreeze({
        disposition,
        signedBytes: priorPaymentDispositionSignedBytes(disposition),
      }),
    );
  } catch {
    return decision("indeterminate", "prior-disposition-signature-unavailable");
  }
  if (signatureValid !== true) {
    return decision(
      signatureValid === false ? "fail" : "error",
      signatureValid === false
        ? "prior-disposition-signature"
        : "prior-disposition-signature-malformed-result",
    );
  }

  let expectedAddress: string;
  let expectedHash: string;
  let expectedRef: AttestationRef;
  try {
    expectedAddress = priorPaymentDispositionAddress(
      disposition.priorJobId,
      disposition.priorPhaseIndex,
      disposition.dispositionId,
    );
    expectedHash = priorPaymentDispositionHash(disposition);
    expectedRef = priorPaymentDispositionReference(disposition);
  } catch {
    return decision("fail", "prior-disposition-anchor");
  }
  if (
    canonicalize(reference) !== canonicalize(expectedRef) ||
    receipt.logicalAddress !== expectedAddress ||
    receipt.contentHash !== expectedHash
  ) {
    return decision("fail", "prior-disposition-anchor");
  }
  if (
    disposition.signature.signer !== orchestrator ||
    receipt.writer !== orchestrator
  ) {
    return decision("fail", "prior-disposition-authority");
  }
  try {
    if (
      contentHash(priorAgreement as unknown as Record<string, unknown>) !==
        disposition.priorAgreementRef.contentHash
    ) {
      return decision("fail", "prior-disposition-binding");
    }
  } catch {
    return decision("fail", "prior-disposition-binding");
  }
  const priorBindings = priorAgreement.terms.payoutBindings;
  const bindingMatches =
    Array.isArray(priorBindings) &&
    priorBindings.some(
      (binding) =>
        isRecord(binding) &&
        binding.railId === priorSelection.railId &&
        binding.phaseIndex === disposition.priorPhaseIndex,
    );
  try {
    if (
      disposition.priorJobId !== priorAgreement.jobId ||
      disposition.replacementJobId !== projection.agreement.jobId ||
      canonicalize(disposition.priorSelection) !== canonicalize(priorSelection) ||
      canonicalize(priorAgreement.listingRef) !==
        canonicalize(projection.agreement.listingRef) ||
      priorAgreement.jobId === projection.agreement.jobId ||
      canonicalize(priorSelection) === canonicalize(projection.selectedRail) ||
      !bindingMatches
    ) {
      return decision("fail", "prior-disposition-binding");
    }
  } catch {
    return decision("fail", "prior-disposition-binding");
  }

  if (
    disposition.disposition === "authorization-pending" ||
    disposition.disposition === "settlement-indeterminate"
  ) {
    return decision("fail", "prior-payment-open");
  }
  if (disposition.disposition === "closed-before-authorization") {
    if (
      (disposition.reconciliationEvidenceRefs?.length ?? 0) !== 0 ||
      receipt.authorizationJournalClosed !== true
    ) {
      return decision("fail", "prior-disposition-proof");
    }
    const admitted = deepFreeze({
      verdict: "pass" as const,
      mode: "closed-before-authorization" as const,
      disposition,
    });
    AUTHENTICATED_REPLACEMENTS.set(admitted, projection);
    return admitted;
  }
  const evidenceRefs = disposition.reconciliationEvidenceRefs;
  if (!evidenceRefs || evidenceRefs.length === 0) {
    return decision("fail", "prior-disposition-proof");
  }
  let terminal = false;
  try {
    terminal =
      (await deps.verifyTerminalReconciliation({
        priorAgreement,
        priorSelection,
        priorPhaseIndex: disposition.priorPhaseIndex,
        evidenceRefs: captureRead(evidenceRefs, "reconciliation evidence refs"),
      })) === true;
  } catch {
    return decision("indeterminate", "prior-disposition-proof-unavailable");
  }
  if (!terminal) return decision("fail", "prior-disposition-proof");
  const admitted = deepFreeze({
    verdict: "pass" as const,
    mode: "closed-cannot-settle" as const,
    disposition,
  });
  AUTHENTICATED_REPLACEMENTS.set(admitted, projection);
  return admitted;
}

export interface AlternativePaymentRetryInput {
  requestedAlternative?: PaymentRailRef;
  authorizationState: "not-requested" | "submitted" | "indeterminate";
  reconciliation: {
    jobId: string;
    railRefHash: string;
    phaseIndex: number;
  };
}

/** APR-6 retry is reconcile-only and therefore never invokes a wallet. */
export function validateAlternativePaymentRetry(
  projection: AlternativePaymentProjection,
  inputSource: AlternativePaymentRetryInput,
): AlternativePaymentDecision {
  if (!AUTHENTICATED_PROJECTIONS.has(projection)) {
    return decision("error", "projection-not-authenticated");
  }
  let input: AlternativePaymentRetryInput;
  try {
    input = capture(inputSource, "pay-alternative retry input");
  } catch {
    return decision("error", "retry-input-malformed");
  }
  if (
    !isRecord(input) ||
    !["not-requested", "submitted", "indeterminate"].includes(
      input.authorizationState,
    ) ||
    !isRecord(input.reconciliation) ||
    Object.keys(input.reconciliation).length !== 3 ||
    typeof input.reconciliation.jobId !== "string" ||
    typeof input.reconciliation.railRefHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(input.reconciliation.railRefHash) ||
    !Number.isSafeInteger(input.reconciliation.phaseIndex) ||
    input.reconciliation.phaseIndex < 0
  ) {
    return decision("error", "retry-input-malformed");
  }
  try {
    requireCanonicalJobId(input.reconciliation.jobId);
  } catch {
    return decision("error", "retry-input-malformed");
  }
  if (
    input.requestedAlternative !== undefined &&
    (!isPaymentRailRef(input.requestedAlternative) ||
      railKey(input.requestedAlternative) !== railKey(projection.selectedRail))
  ) {
    return decision(
      input.authorizationState === "submitted" ||
        input.authorizationState === "indeterminate"
        ? "fail"
        : "fail",
      input.authorizationState === "submitted" ||
        input.authorizationState === "indeterminate"
        ? "fallback-forbidden"
        : "fresh-job-required",
    );
  }
  const expected = {
    jobId: projection.agreement.jobId,
    railRefHash: sha256Hex(canonicalize(projection.selectedRail)),
    phaseIndex: projection.paymentPhaseIndex,
  };
  if (canonicalize(input.reconciliation) !== canonicalize(expected)) {
    return decision("fail", "reconciliation-tuple");
  }
  return decision("pass", "reconciliation-pending");
}

export interface AlternativePaymentAuditBundleLike {
  jobId: string;
  listingRef: unknown;
  agreementRef: unknown;
  phaseSummary: Array<{ index: number; kind: string; [key: string]: unknown }>;
  settlementEvidence: Array<{
    phaseIndex: number;
    phase: string;
    [key: string]: unknown;
  }>;
  signatures?: unknown[];
}

export interface AlternativePaymentAuditDeps {
  authenticateBundle: (
    bundle: Readonly<AlternativePaymentAuditBundleLike>,
  ) =>
    | Promise<AlternativeArtifactAuthentication>
    | AlternativeArtifactAuthentication;
}

/** APR-7 independent DACS-5 effective-pipeline recomputation. */
export async function verifyAlternativePaymentAudit(
  projection: AlternativePaymentProjection,
  bundleSource: AlternativePaymentAuditBundleLike,
  depsSource: AlternativePaymentAuditDeps,
): Promise<AlternativePaymentDecision> {
  if (!AUTHENTICATED_PROJECTIONS.has(projection)) {
    return decision("error", "projection-not-authenticated");
  }
  let bundle: AlternativePaymentAuditBundleLike;
  let authenticateBundle: AlternativePaymentAuditDeps["authenticateBundle"];
  try {
    if (!isRecord(depsSource) || nodeTypes.isProxy(depsSource)) {
      return decision("error", "bundle-dependencies-malformed");
    }
    authenticateBundle = stableDataMethod<
      AlternativePaymentAuditDeps["authenticateBundle"]
    >(depsSource, "authenticateBundle", "authenticateBundle");
    bundle = capture(bundleSource, "pay-alternative audit bundle");
    if (
      !isRecord(bundle) ||
      typeof bundle.jobId !== "string" ||
      !Array.isArray(bundle.phaseSummary) ||
      !bundle.phaseSummary.every(
        (entry) =>
          isRecord(entry) &&
          Number.isSafeInteger(entry.index) &&
          entry.index >= 0 &&
          typeof entry.kind === "string",
      ) ||
      !Array.isArray(bundle.settlementEvidence) ||
      !bundle.settlementEvidence.every(
        (entry) =>
          isRecord(entry) &&
          Number.isSafeInteger(entry.phaseIndex) &&
          entry.phaseIndex >= 0 &&
          typeof entry.phase === "string",
      )
    ) {
      return decision("error", "bundle-shape");
    }
  } catch {
    return decision("error", "bundle-shape");
  }
  let auth: unknown;
  try {
    auth = captureRead(
      await authenticateBundle(bundle),
      "bundle authentication result",
    );
  } catch {
    return decision("indeterminate", "bundle-authentication-unavailable");
  }
  const authFailure = authenticationDecision(
    auth,
    "bundle-signature",
    "bundle-authentication-unavailable",
  );
  if (authFailure) return authFailure;
  if (bundle.jobId !== projection.agreement.jobId) {
    return decision("fail", "bundle-job");
  }
  try {
    if (
      canonicalize(bundle.listingRef) !==
      canonicalize(projection.agreement.listingRef)
    ) {
      return decision("fail", "bundle-listing-ref");
    }
    const expectedAgreementRef = {
      contentHash: contentHash(
        projection.agreement as unknown as Record<string, unknown>,
      ),
    };
    if (
      canonicalize(bundle.agreementRef) !== canonicalize(expectedAgreementRef)
    ) {
      return decision("fail", "bundle-agreement-ref");
    }
  } catch {
    return decision("error", "bundle-reference-malformed");
  }
  const expectedSummary = projection.effectivePipeline.map((phase, index) => [
    index,
    phase.kind,
  ]);
  const actualSummary = Array.isArray(bundle.phaseSummary)
    ? bundle.phaseSummary.map((entry) => [entry.index, entry.kind])
    : [];
  if (canonicalize(actualSummary) !== canonicalize(expectedSummary)) {
    return decision("fail", "bundle-effective-pipeline");
  }
  const expectedEvidence = projection.effectivePipeline
    .map((phase, index) =>
      isConcretePaymentHandler(phase.kind) || phase.kind.startsWith("deliver-")
        ? ([index, phase.kind] as [number, string])
        : null,
    )
    .filter((entry): entry is [number, string] => entry !== null);
  const actualEvidence = Array.isArray(bundle.settlementEvidence)
    ? bundle.settlementEvidence.map((entry) => [entry.phaseIndex, entry.phase])
    : [];
  if (canonicalize(actualEvidence) !== canonicalize(expectedEvidence)) {
    return decision("fail", "evidence-effective-pipeline");
  }
  return decision("pass");
}

export interface AlternativePaymentAuthorizationInput {
  projection: AlternativePaymentProjection;
  replacement: PriorPaymentReplacementAdmission;
}

function authenticatedAuthorizationPair(
  input: AlternativePaymentAuthorizationInput,
): {
  projection: AlternativePaymentProjection;
  replacement: PriorPaymentReplacementAdmission;
} {
  let projection: AlternativePaymentProjection;
  let replacement: PriorPaymentReplacementAdmission;
  try {
    if (!isRecord(input) || nodeTypes.isProxy(input)) throw new TypeError("input");
    projection = stableDataProperty(
      input,
      "projection",
      "payment projection",
    ) as AlternativePaymentProjection;
    replacement = stableDataProperty(
      input,
      "replacement",
      "payment replacement gate",
    ) as PriorPaymentReplacementAdmission;
  } catch {
    throw new DacsError(
      "payment authorization requires authenticated APR projection and replacement gates",
    );
  }
  const replacementProjection = AUTHENTICATED_REPLACEMENTS.get(replacement);
  const independentMatches =
    replacementProjection === null &&
    projection.agreement.terms.priorPaymentDispositionRef === undefined;
  if (
    !AUTHENTICATED_PROJECTIONS.has(projection) ||
    (replacementProjection !== projection && !independentMatches)
  ) {
    throw new DacsError(
      "payment authorization requires authenticated APR projection and replacement gates",
    );
  }
  return { projection, replacement };
}

/** @internal Commitment integration; not re-exported from the package root. */
export function assertAlternativePaymentCommitmentAuthority(
  input: AlternativePaymentAuthorizationInput,
  agreementSource: AlternativePaymentAgreementLike,
  listingSource: AlternativePaymentListingLike,
): AlternativePaymentProjection {
  const { projection } = authenticatedAuthorizationPair(input);
  let agreement: AlternativePaymentAgreementLike;
  let listing: AlternativePaymentListingLike;
  try {
    agreement = captureRead(agreementSource, "alternative commitment Agreement");
    listing = captureRead(listingSource, "alternative commitment Listing");
    const listingRef = {
      listingId: listing.listingId,
      version: listing.listingVersion,
      contentHash: contentHash(listing as unknown as Record<string, unknown>),
    };
    if (
      canonicalize(projection.agreement) !== canonicalize(agreement) ||
      canonicalize(projection.agreement.listingRef) !== canonicalize(listingRef) ||
      listing.pipeline.filter((phase) => phase.kind === "pay-alternative").length !== 1 ||
      projection.effectivePipeline.some(
        (phase) => phase.kind === "pay-alternative",
      )
    ) {
      throw new TypeError("authority binding mismatch");
    }
  } catch (cause) {
    throw new DacsError(
      "alternative commitment authority does not bind the exact Agreement and Listing",
      { cause },
    );
  }
  return projection;
}

/**
 * The only helper in this module that may invoke a wallet. Authenticated
 * projection and replacement objects must be the exact outputs above, so every
 * failed/indeterminate path is structurally pre-authorization.
 */
export async function authorizeAlternativePayment<TResult>(
  input: AlternativePaymentAuthorizationInput,
  authorize: (input: Readonly<{
    jobId: string;
    rail: PaymentRailRef;
    phaseIndex: number;
    handler: PaymentPhaseType;
  }>) => Promise<TResult> | TResult,
): Promise<TResult> {
  const { projection } = authenticatedAuthorizationPair(input);
  return authorize(
    deepFreeze({
      jobId: projection.agreement.jobId,
      rail: projection.selectedRail,
      phaseIndex: projection.paymentPhaseIndex,
      handler: projection.selectedDefinition.phaseHandler as PaymentPhaseType,
    }),
  );
}

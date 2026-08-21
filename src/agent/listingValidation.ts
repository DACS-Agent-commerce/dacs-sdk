import { isIP } from "node:net";
import { types as nodeTypes } from "node:util";

import type {
  ComponentSignature,
  DeliverableSpec,
  IdentityBundle,
  Listing,
  ListingDraft,
  PaymentRailRef,
  RevocationBinding,
  RevocationMarker,
  VerificationMethod,
} from "../artifacts/types.js";
import {
  isListing,
  isListingEnvelope,
  isListingPipelineValid,
  isPaymentRailRef,
  isRevocationBinding,
  isRevocationMarker,
} from "../artifacts/validators.js";
import {
  canonicalize,
  contentHash,
  encodeAddressSegment,
  sha256Hex,
} from "../canonical/index.js";
import {
  ed25519Verify,
  publicKeyFromRaw,
  signedBytes,
} from "../crypto/index.js";
import {
  snapshotCanonicalJson,
  snapshotCanonicalJsonRead,
} from "../canonical/snapshot.js";
import { DacsError } from "../errors.js";
import { identityBundleHash } from "../identity/bundle.js";
import { sameCanonicalClaimIdentity } from "../identity/claimReference.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

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
  } catch (cause) {
    throw new DacsError(`${label} must be stable data`, { cause });
  }
  return undefined;
}

function stableDataMethod<T>(
  source: object,
  key: PropertyKey,
  label: string,
  optional = false,
): T {
  const candidate = stableDataProperty(source, key, label);
  if (candidate === undefined && optional) return undefined as T;
  if (typeof candidate !== "function" || nodeTypes.isProxy(candidate)) {
    throw new DacsError(`${label} must be a stable data method`);
  }
  return Function.prototype.bind.call(candidate, source) as T;
}

/** DACS-1 §6.3.4 reader result; LR-3 permits new sessions only for `verified`. */
export type ListingValidationDisposition =
  | "verified"
  | "rejected"
  | "revoked"
  | "indeterminate";

/** DACS-1 §6.3.4 RB-4..RB-6 three-way revocation result. */
export type RevocationCheck = "absent" | "revoked" | "indeterminate";

/** DACS-1 §6.3.4 LRR-1..LRR-6 listing-time rail result. */
export type ListingRailResolution =
  | "verified"
  | "rejected"
  | "indeterminate";

export interface ListingRailResolutionResult {
  disposition: ListingRailResolution;
  reason: string;
  /** DACS-1 §6.3.4 LRR-6 disclosed authority basis. */
  authorityBasis?: "pa1-in-code" | "pa2" | "pa3";
}

type AttestedPayloadDeliverable = Extract<
  DeliverableSpec,
  { kind: "attested-payload" }
>;

/**
 * Local DPA-1 decision. `supported` means this SDK instance can execute the
 * selected method for exact-byte payload binding, not merely that it recognizes
 * the method discriminator.
 */
export type PayloadVerificationCapabilityDecision =
  | { disposition: "supported"; reason?: string }
  | {
      disposition: "unsupported" | "indeterminate" | "error";
      reason: string;
    };

/** Exact signed method/spec objects are supplied; integrations must not project them. */
export interface PayloadVerificationCapabilityInput {
  operation: "produce" | "verify";
  verificationMethod: Readonly<VerificationMethod>;
  verificationMethodHash: string;
  deliverableSpec: Readonly<AttestedPayloadDeliverable>;
  deliverableSpecHash: string;
}

/** Transport-neutral local capability/dependency resolver for DACS-4 DPA-1. */
export type PayloadVerificationCapabilityResolver = (
  input: PayloadVerificationCapabilityInput,
) =>
  | Promise<PayloadVerificationCapabilityDecision>
  | PayloadVerificationCapabilityDecision;

export type ListingPayloadVerificationCapability =
  | { disposition: "not-applicable"; reason: "not-applicable" }
  | { disposition: "error"; reason: string; operation?: never }
  | {
      operation: PayloadVerificationCapabilityInput["operation"];
      disposition: "supported" | "unsupported" | "indeterminate" | "error";
      reason: string;
      verificationMethodKind?: VerificationMethod["kind"];
      verificationMethodHash?: string;
      deliverableSpecHash?: string;
    };

export interface ListingValidationResult {
  disposition: ListingValidationDisposition;
  /** Normative reader step that determined the result. */
  step: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  reason: string;
  listing?: Listing;
  listingContentHash?: string;
  revocation?: RevocationCheck;
  railResolution?: ListingRailResolutionResult;
  /** DACS-4 DPA-1 local exact-byte method capability, when applicable. */
  payloadVerificationCapability?: Exclude<
    ListingPayloadVerificationCapability,
    { disposition: "not-applicable" }
  >;
}

export type VerifiedListingAdmission = ListingValidationResult & {
  disposition: "verified";
  listing: Listing;
  listingContentHash: string;
};

/**
 * Bind an ordered reader result to the exact current Listing admitted by a
 * public discovery/session boundary. This rejects stale pre-DPA validators,
 * substituted result objects, and capability decisions for another method or
 * DeliverableSpec even when a caller supplies a matching raw hash string.
 */
export function isVerifiedListingAdmission(
  raw: Record<string, unknown>,
  result: ListingValidationResult,
): result is VerifiedListingAdmission {
  if (
    result.disposition !== "verified" ||
    result.step !== 9 ||
    !result.listing ||
    !result.listingContentHash ||
    !isListing(raw) ||
    !isListing(result.listing)
  ) {
    return false;
  }
  try {
    if (
      canonicalize(result.listing) !== canonicalize(raw) ||
      contentHash(raw) !== result.listingContentHash ||
      contentHash(result.listing as unknown as Record<string, unknown>) !==
        result.listingContentHash
    ) {
      return false;
    }
    if (
      !result.listing.pipeline.some(
        (phase) => phase.kind === "deliver-attested-payload",
      )
    ) {
      return true;
    }
    const deliverable = result.listing.offering.deliverable;
    const capability = result.payloadVerificationCapability;
    return (
      deliverable.kind === "attested-payload" &&
      !!deliverable.verificationMethod &&
      capability?.operation === "verify" &&
      capability?.disposition === "supported" &&
      capability.verificationMethodHash ===
        sha256Hex(canonicalize(deliverable.verificationMethod)) &&
      capability.deliverableSpecHash === sha256Hex(canonicalize(deliverable))
    );
  } catch {
    return false;
  }
}

export type SignatureVerifier = (input: {
  signedBytes: Uint8Array;
  signature: Readonly<ComponentSignature>;
}) => Promise<boolean> | boolean;

export interface RevocationSurface {
  /** DACS-1 §6.3.5/§6.3.6 discovery surface consulted under RB-6. */
  kind: "well-known" | "catalog";
  status: "active" | "revoked";
  /** Explicit RB-6 transport/read outcome; failures are never omitted as absence. */
  readStatus?: "ok" | "unavailable";
  readFailureReason?: string;
  /** A well-known index is usable only after its listings/indexHash check. */
  integrity?: "verified" | "indeterminate";
  /** Catalog observation time; an entry older than 24h cannot establish absence. */
  catalogObservedAt?: number;
  binding?: RevocationBinding;
}

export interface ListingRevocationDeps {
  nowMs: () => number;
  surfaces: RevocationSurface[];
  readMarker: (
    anchor: RevocationBinding["markerAnchor"],
  ) => Promise<Record<string, unknown> | null>;
  verifyMarkerSignature: SignatureVerifier;
}

export interface RevocationCheckResult {
  disposition: RevocationCheck;
  reason: string;
}

function captureRevocationDeps(
  value: ListingRevocationDeps,
): ListingRevocationDeps {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) {
    throw new DacsError("revocation dependencies must be stable data");
  }
  const surfaces = snapshotCanonicalJson(
    stableDataProperty(value, "surfaces", "revocation.surfaces"),
    "revocation surfaces",
  ) as RevocationSurface[];
  return Object.freeze({
    nowMs: stableDataMethod<ListingRevocationDeps["nowMs"]>(value, "nowMs", "revocation.nowMs"),
    surfaces,
    readMarker: stableDataMethod<ListingRevocationDeps["readMarker"]>(value, "readMarker", "revocation.readMarker"),
    verifyMarkerSignature: stableDataMethod<ListingRevocationDeps["verifyMarkerSignature"]>(
      value,
      "verifyMarkerSignature",
      "revocation.verifyMarkerSignature",
    ),
  });
}

const revocationLogicalAddress = (listing: Listing): string =>
  `dacs1-revoked:${encodeAddressSegment(
    listing.seller.identity.presentedBy,
  )}:${listing.listingId}:v${listing.listingVersion}`;

async function checkRevokedSurface(
  listing: Listing,
  listingContentHash: string,
  surface: RevocationSurface,
  deps: ListingRevocationDeps,
): Promise<RevocationCheckResult> {
  const now = deps.nowMs();
  if (!Number.isSafeInteger(now) || now < 0) {
    return { disposition: "indeterminate", reason: "revocation-clock-invalid" };
  }
  if (
    !isRecord(surface) ||
    !hasOnlyKeys(
      surface,
      ["kind", "status"],
      [
        "readStatus",
        "readFailureReason",
        "integrity",
        "catalogObservedAt",
        "binding",
      ],
    ) ||
    (surface.kind !== "well-known" && surface.kind !== "catalog") ||
    (surface.status !== "active" && surface.status !== "revoked") ||
    (surface.readStatus !== undefined &&
      surface.readStatus !== "ok" &&
      surface.readStatus !== "unavailable") ||
    (surface.readFailureReason !== undefined &&
      (typeof surface.readFailureReason !== "string" ||
        surface.readFailureReason.trim().length === 0)) ||
    (surface.integrity !== undefined &&
      surface.integrity !== "verified" &&
      surface.integrity !== "indeterminate") ||
    (surface.catalogObservedAt !== undefined &&
      (!Number.isSafeInteger(surface.catalogObservedAt) ||
        surface.catalogObservedAt < 0))
  ) {
    return { disposition: "indeterminate", reason: "malformed-revocation-surface" };
  }
  if (surface.readStatus === "unavailable") {
    return {
      disposition: "indeterminate",
      reason: surface.readFailureReason ?? "surface-unavailable",
    };
  }
  if (surface.kind === "well-known" && surface.integrity !== "verified") {
    return { disposition: "indeterminate", reason: "surface-integrity" };
  }
  if (
    surface.kind === "catalog" &&
    (surface.catalogObservedAt === undefined ||
      surface.catalogObservedAt > now ||
      now - surface.catalogObservedAt > 24 * 60 * 60 * 1_000)
  ) {
    return { disposition: "indeterminate", reason: "catalog-stale" };
  }
  if (surface.status === "active") {
    return surface.binding
      ? { disposition: "indeterminate", reason: "active-record-has-binding" }
      : { disposition: "absent", reason: "integrity-consistent-active-record" };
  }
  if (!surface.binding || !isRevocationBinding(surface.binding)) {
    return { disposition: "indeterminate", reason: "required-binding-missing" };
  }

  const binding = surface.binding;
  if (
    binding.sellerPrimaryClaim !== listing.seller.identity.presentedBy ||
    binding.listingId !== listing.listingId ||
    binding.listingVersion !== listing.listingVersion ||
    binding.listingContentHash !== listingContentHash
  ) {
    return { disposition: "indeterminate", reason: "binding-tuple-mismatch" };
  }
  if (binding.logicalAddress !== revocationLogicalAddress(listing)) {
    return { disposition: "indeterminate", reason: "logical-address-mismatch" };
  }

  let raw: Record<string, unknown> | null;
  try {
    const result = await deps.readMarker(
      snapshotCanonicalJson(binding.markerAnchor, "revocation marker anchor"),
    );
    raw = result === null
      ? null
      : snapshotCanonicalJsonRead(result, "revocation marker read");
  } catch {
    return { disposition: "indeterminate", reason: "marker-fetch-failed" };
  }
  if (!raw || !isRevocationMarker(raw)) {
    return { disposition: "indeterminate", reason: "marker-unreadable" };
  }
  const marker: RevocationMarker = raw;
  if (contentHash(raw) !== binding.markerContentHash) {
    return { disposition: "indeterminate", reason: "marker-content-hash-mismatch" };
  }
  if (
    marker.listingId !== listing.listingId ||
    marker.listingVersion !== listing.listingVersion ||
    marker.listingContentHash !== listingContentHash
  ) {
    return { disposition: "indeterminate", reason: "marker-tuple-mismatch" };
  }
  if (marker.signature.signer !== listing.signature.signer) {
    return { disposition: "indeterminate", reason: "marker-signer-mismatch" };
  }
  let signatureValid: unknown;
  try {
    signatureValid = await deps.verifyMarkerSignature({
      signedBytes: signedBytes("dacs-revocation:v1:", contentHash(raw)),
      signature: snapshotCanonicalJson(
        marker.signature,
        "revocation marker signature",
      ),
    });
  } catch {
    return { disposition: "indeterminate", reason: "marker-signature-unavailable" };
  }
  return signatureValid === true
    ? { disposition: "revoked", reason: "verified-revocation-marker" }
    : signatureValid === false
      ? { disposition: "indeterminate", reason: "marker-signature-invalid" }
      : { disposition: "indeterminate", reason: "marker-signature-malformed-result" };
}

/**
 * Execute DACS-1 §6.3.4 RB-4..RB-6. A binding is discovery only: this function
 * fetches and verifies the marker before returning `revoked`.
 */
export async function checkListingRevocation(
  listing: Listing,
  listingContentHash: string,
  deps: ListingRevocationDeps,
): Promise<RevocationCheckResult> {
  try {
    deps = captureRevocationDeps(deps);
    listing = snapshotCanonicalJson(listing, "revocation Listing");
    if (!isListingEnvelope(listing)) {
      return { disposition: "indeterminate", reason: "malformed-revocation-listing" };
    }
    if (typeof listingContentHash !== "string" || !/^[0-9a-f]{64}$/.test(listingContentHash)) {
      return { disposition: "indeterminate", reason: "malformed-listing-content-hash" };
    }
  } catch {
    return { disposition: "indeterminate", reason: "malformed-revocation-input" };
  }
  let surfaces: RevocationSurface[];
  try {
    surfaces = snapshotCanonicalJson(
      deps.surfaces,
      "revocation surfaces",
    );
  } catch {
    return { disposition: "indeterminate", reason: "malformed-revocation-surfaces" };
  }
  if (surfaces.length === 0) {
    return { disposition: "indeterminate", reason: "no-revocation-surface" };
  }
  const checks: RevocationCheckResult[] = [];
  for (const surface of surfaces) {
    checks.push(
      await checkRevokedSurface(listing, listingContentHash, surface, deps),
    );
  }
  return (
    checks.find((result) => result.disposition === "revoked") ??
    checks.find((result) => result.disposition === "indeterminate") ??
    checks[0]!
  );
}

export interface ListingPayPhaseClaim {
  kind: unknown;
  rail: unknown;
}

export interface RailRegistryEntry {
  railId: string;
  latestVersion: number;
  versions: number[];
}

export interface RailDefinitionProof {
  unsigned: Record<string, unknown>;
  indexContentHash: string;
  stewardPublicKey: string;
  signature: string;
}

export interface ListingRailDefinition {
  railId: string;
  railVersion: number;
  phaseHandler: string;
  state?: "verified-finalized" | "verified-included" | "unavailable";
  governanceAnchoring?: string;
  signatureValid?: boolean;
  proof?: RailDefinitionProof;
}

export interface ListingRailResolutionInput {
  trustPhase: "PA-1" | "PA-2" | "PA-3";
  trustPolicyAcceptsPA1?: boolean;
  payPhases: ListingPayPhaseClaim[];
  acceptedRails: unknown[];
  registry: {
    state:
      | "verified-finalized"
      | "verified-included"
      | "unavailable"
      | "absent"
      | "invalid-authority"
      | "not-used";
    entries: RailRegistryEntry[];
    definitions: ListingRailDefinition[];
  };
  inCodeDefinitions?: ListingRailDefinition[];
}

/**
 * DACS-1 §6.3.4 LRR-2/LRR-6 authority material supplied by an integration.
 * Signed Listing inputs are intentionally excluded and reattached by the SDK,
 * so a loader cannot accidentally validate a different rail claim set.
 */
export type ListingRailAuthorityInput = Omit<
  ListingRailResolutionInput,
  "payPhases" | "acceptedRails"
>;

const railResult = (
  disposition: ListingRailResolution,
  reason: string,
  authorityBasis?: ListingRailResolutionResult["authorityBasis"],
): ListingRailResolutionResult => ({
  disposition,
  reason,
  ...(authorityBasis ? { authorityBasis } : {}),
});

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

function isRailDefinitionProof(value: unknown): value is RailDefinitionProof {
  return isRecord(value) &&
    hasOnlyKeys(value, ["unsigned", "indexContentHash", "stewardPublicKey", "signature"]) &&
    isRecord(value.unsigned) &&
    typeof value.indexContentHash === "string" && /^[0-9a-f]{64}$/.test(value.indexContentHash) &&
    typeof value.stewardPublicKey === "string" &&
    typeof value.signature === "string";
}

function isRailDefinition(value: unknown): value is ListingRailDefinition {
  return isRecord(value) &&
    hasOnlyKeys(
      value,
      ["railId", "railVersion", "phaseHandler"],
      ["state", "governanceAnchoring", "signatureValid", "proof"],
    ) &&
    typeof value.railId === "string" && value.railId.length > 0 &&
    typeof value.railVersion === "number" && Number.isSafeInteger(value.railVersion) && value.railVersion > 0 &&
    typeof value.phaseHandler === "string" && value.phaseHandler.startsWith("pay-") &&
    (value.state === undefined ||
      value.state === "verified-finalized" ||
      value.state === "verified-included" ||
      value.state === "unavailable") &&
    (value.governanceAnchoring === undefined || typeof value.governanceAnchoring === "string") &&
    (value.signatureValid === undefined || typeof value.signatureValid === "boolean") &&
    (value.proof === undefined || isRailDefinitionProof(value.proof));
}

function isRailResolutionInput(value: unknown): value is ListingRailResolutionInput {
  if (!isRecord(value) ||
    !hasOnlyKeys(
      value,
      ["trustPhase", "payPhases", "acceptedRails", "registry"],
      ["trustPolicyAcceptsPA1", "inCodeDefinitions"],
    ) ||
    (value.trustPhase !== "PA-1" && value.trustPhase !== "PA-2" && value.trustPhase !== "PA-3") ||
    (value.trustPolicyAcceptsPA1 !== undefined && typeof value.trustPolicyAcceptsPA1 !== "boolean") ||
    !Array.isArray(value.payPhases) ||
    !value.payPhases.every((phase) =>
      isRecord(phase) && hasOnlyKeys(phase, ["kind", "rail"])) ||
    !Array.isArray(value.acceptedRails) ||
    !isRecord(value.registry) ||
    !hasOnlyKeys(value.registry, ["state", "entries", "definitions"]) ||
    !["verified-finalized", "verified-included", "unavailable", "absent", "invalid-authority", "not-used"].includes(
      value.registry.state as string,
    ) ||
    !Array.isArray(value.registry.entries) ||
    !value.registry.entries.every((entry) =>
      isRecord(entry) && hasOnlyKeys(entry, ["railId", "latestVersion", "versions"]) &&
      typeof entry.railId === "string" && entry.railId.length > 0 &&
      typeof entry.latestVersion === "number" && Number.isSafeInteger(entry.latestVersion) && entry.latestVersion > 0 &&
      Array.isArray(entry.versions) && entry.versions.length > 0 &&
      entry.versions.every((version) => Number.isSafeInteger(version) && version > 0)) ||
    !Array.isArray(value.registry.definitions) ||
    !value.registry.definitions.every(isRailDefinition) ||
    (value.inCodeDefinitions !== undefined &&
      (!Array.isArray(value.inCodeDefinitions) ||
        !value.inCodeDefinitions.every(isRailDefinition)))) {
    return false;
  }
  return true;
}

function validateRailProof(
  proof: RailDefinitionProof,
): "valid" | "hash-mismatch" | "signature-invalid" {
  let hash: string;
  try {
    hash = sha256Hex(canonicalize(proof.unsigned));
  } catch {
    return "hash-mismatch";
  }
  if (hash !== proof.indexContentHash) return "hash-mismatch";
  try {
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(proof.stewardPublicKey) ||
      !/^[A-Za-z0-9_-]{86}$/.test(proof.signature)
    ) {
      return "signature-invalid";
    }
    const key = Buffer.from(proof.stewardPublicKey, "base64url");
    const signature = Buffer.from(proof.signature, "base64url");
    if (
      key.length !== 32 ||
      signature.length !== 64 ||
      key.toString("base64url") !== proof.stewardPublicKey ||
      signature.toString("base64url") !== proof.signature
    ) {
      return "signature-invalid";
    }
    return ed25519Verify(
      signedBytes("dacs-rail:v1:", hash),
      signature,
      publicKeyFromRaw(key),
    )
      ? "valid"
      : "signature-invalid";
  } catch {
    return "signature-invalid";
  }
}

function staticRailBinding(
  input: ListingRailResolutionInput,
): ListingRailResolutionResult | null {
  if (input.payPhases.length === 0) {
    return railResult("verified", "not-applicable");
  }
  if (input.acceptedRails.length === 0) {
    return railResult("rejected", "missing-accepted-rails");
  }
  if (!input.acceptedRails.every(isPaymentRailRef)) {
    return railResult("rejected", "malformed-accepted-rail");
  }
  if (
    input.payPhases.some(
      (phase) =>
        typeof phase.kind !== "string" ||
        !phase.kind.startsWith("pay-") ||
        typeof phase.rail !== "string" ||
        phase.rail.length === 0,
    )
  ) {
    return railResult("rejected", "malformed-pay-rail");
  }
  const rails = input.acceptedRails as PaymentRailRef[];
  const canonical = rails.map((rail) => canonicalize(rail));
  if (new Set(canonical).size !== canonical.length) {
    return railResult("rejected", "duplicate-accepted-rail-ref");
  }
  if (
    input.payPhases.some(
      (phase) => !rails.some((rail) => rail.railId === phase.rail),
    )
  ) {
    return railResult("rejected", "pay-rail-not-accepted");
  }
  return null;
}

function handlerCheck(
  payPhases: ListingPayPhaseClaim[],
  definitions: ListingRailDefinition[],
): ListingRailResolutionResult | null {
  for (const phase of payPhases) {
    const matching = definitions.filter((definition) => definition.railId === phase.rail);
    if (matching.length === 0) {
      // LRR-5: a required definition that cannot be resolved is indeterminate,
      // never a vacuous handler pass. LR-3 still blocks session admission.
      return railResult("indeterminate", "rail-definition-unavailable");
    }
    if (
      matching.some(
        (definition) =>
          definition.phaseHandler !== phase.kind ||
          definition.phaseHandler !== matching[0]?.phaseHandler,
      )
    ) {
      return railResult("rejected", "phase-handler-mismatch");
    }
  }
  return null;
}

function resolvePa1(
  input: ListingRailResolutionInput,
): ListingRailResolutionResult {
  if (!input.trustPolicyAcceptsPA1) {
    return railResult("indeterminate", "pa1-not-accepted", "pa1-in-code");
  }
  const rails = input.acceptedRails as PaymentRailRef[];
  const available = input.inCodeDefinitions ?? [];
  const selected: ListingRailDefinition[] = [];
  let indeterminateReason: string | undefined;

  for (const ref of rails) {
    const versions = available.filter((definition) => definition.railId === ref.railId);
    if (versions.length === 0) {
      return railResult("rejected", "unknown-rail", "pa1-in-code");
    }
    if (new Set(versions.map((definition) => definition.phaseHandler)).size !== 1) {
      return railResult("rejected", "pa1-handler-version-drift", "pa1-in-code");
    }
    const targetVersion =
      ref.railVersion ?? Math.max(...versions.map((definition) => definition.railVersion));
    const matches = versions.filter(
      (definition) => definition.railVersion === targetVersion,
    );
    if (matches.length === 0) {
      return railResult("rejected", "unknown-rail-version", "pa1-in-code");
    }
    if (matches.length > 1) {
      return railResult("rejected", "pa1-ambiguous-version", "pa1-in-code");
    }
    const definition = matches[0]!;
    selected.push(definition);
    if (
      definition.governanceAnchoring !== "in-code" ||
      definition.signatureValid !== true
    ) {
      indeterminateReason ??= "pa1-definition-unverifiable";
    }
  }
  const handler = handlerCheck(input.payPhases, selected);
  if (handler) return { ...handler, authorityBasis: "pa1-in-code" };
  return indeterminateReason
    ? railResult("indeterminate", indeterminateReason, "pa1-in-code")
    : railResult("verified", "verified-pa1", "pa1-in-code");
}

function resolveAnchoredRegistry(
  input: ListingRailResolutionInput,
): ListingRailResolutionResult {
  const authorityBasis = input.trustPhase === "PA-3" ? "pa3" : "pa2";
  switch (input.registry.state) {
    case "unavailable":
    case "absent":
      return railResult("indeterminate", "registry-unavailable", authorityBasis);
    case "verified-included":
      return railResult("indeterminate", "registry-not-finalized", authorityBasis);
    case "invalid-authority":
    case "not-used":
      return railResult(
        "indeterminate",
        "registry-unverifiable-no-fallback",
        authorityBasis,
      );
    case "verified-finalized":
      break;
  }

  const rails = input.acceptedRails as PaymentRailRef[];
  const selections: Array<{
    ref: PaymentRailRef;
    version: number;
    entry: RailRegistryEntry;
  }> = [];
  for (const ref of rails) {
    const entries = input.registry.entries.filter((entry) => entry.railId === ref.railId);
    if (entries.length !== 1) {
      return railResult("rejected", "unknown-rail", authorityBasis);
    }
    const entry = entries[0]!;
    const version = ref.railVersion ?? entry.latestVersion;
    if (!entry.versions.includes(version)) {
      return railResult("rejected", "unknown-rail-version", authorityBasis);
    }
    selections.push({ ref, version, entry });
  }

  const selected: ListingRailDefinition[] = [];
  let indeterminateReason: string | undefined;
  for (const selection of selections) {
    const matches = input.registry.definitions.filter(
      (definition) =>
        definition.railId === selection.ref.railId &&
        definition.railVersion === selection.version,
    );
    if (matches.length !== 1) {
      indeterminateReason ??= "rail-definition-unavailable";
      continue;
    }
    const definition = matches[0]!;
    selected.push(definition);
    if (definition.state !== "verified-finalized") {
      indeterminateReason ??= "rail-definition-unavailable";
      continue;
    }
    if (definition.proof) {
      const proof = validateRailProof(definition.proof);
      if (proof === "hash-mismatch") {
        indeterminateReason ??= "rail-definition-hash-mismatch";
      } else if (proof === "signature-invalid") {
        indeterminateReason ??= "rail-definition-signature-invalid";
      } else if (
        definition.proof.unsigned.railId !== definition.railId ||
        definition.proof.unsigned.railVersion !== definition.railVersion ||
        definition.proof.unsigned.phaseHandler !== definition.phaseHandler
      ) {
        return railResult("rejected", "rail-definition-tuple-mismatch", authorityBasis);
      }
    }
  }

  const handler = handlerCheck(input.payPhases, selected);
  if (handler) return { ...handler, authorityBasis };
  return indeterminateReason
    ? railResult("indeterminate", indeterminateReason, authorityBasis)
    : railResult("verified", "verified", authorityBasis);
}

/** Execute DACS-1 §6.3.4 LRR-1..LRR-6 over one authenticated snapshot. */
export function resolveListingRails(
  input: ListingRailResolutionInput,
): ListingRailResolutionResult {
  let captured: unknown;
  try {
    captured = snapshotCanonicalJson(input, "Listing rail resolution input");
  } catch {
    return railResult("indeterminate", "malformed-rail-authority");
  }
  if (!isRailResolutionInput(captured)) {
    return railResult("indeterminate", "malformed-rail-authority");
  }
  const staticFailure = staticRailBinding(captured);
  if (staticFailure) return staticFailure;
  return captured.trustPhase === "PA-1"
    ? resolvePa1(captured)
    : resolveAnchoredRegistry(captured);
}

function isCapabilityDecision(
  value: unknown,
): value is PayloadVerificationCapabilityDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.disposition === "supported") {
    return candidate.reason === undefined || typeof candidate.reason === "string";
  }
  return (
    (candidate.disposition === "unsupported" ||
      candidate.disposition === "indeterminate" ||
      candidate.disposition === "error") &&
    typeof candidate.reason === "string" &&
    candidate.reason.length > 0
  );
}

/**
 * Resolve DACS-4 §9.6.3 DPA-1 over the exact signed method and deliverable.
 * This is separate from the structural union check: a known method with no
 * installed/configured implementation is locally unsupported and must fail
 * before a session, payment, signature, or anchor side effect.
 */
export async function resolveListingPayloadVerificationCapability(
  listing: Readonly<Listing | ListingDraft>,
  operation: PayloadVerificationCapabilityInput["operation"],
  resolver?: PayloadVerificationCapabilityResolver,
): Promise<ListingPayloadVerificationCapability> {
  if (operation !== "produce" && operation !== "verify") {
    return {
      disposition: "error",
      reason: "payload-verification-capability-operation-invalid",
    };
  }
  let listingSnapshot: Listing | ListingDraft;
  try {
    listingSnapshot = snapshotCanonicalJson(
      listing,
      "payload verification capability Listing",
    );
  } catch {
    return {
      operation,
      disposition: "error",
      reason: "payload-verification-capability-input-not-canonicalizable",
    };
  }

  if (!listingSnapshot.pipeline.some((phase) => phase.kind === "deliver-attested-payload")) {
    return { disposition: "not-applicable", reason: "not-applicable" };
  }

  const deliverable = listingSnapshot.offering.deliverable;
  if (deliverable.kind !== "attested-payload" || !deliverable.verificationMethod) {
    return {
      operation,
      disposition: "unsupported",
      reason: "attested-payload-method-missing-or-malformed",
    };
  }

  let verificationMethod: VerificationMethod;
  let deliverableSpec: AttestedPayloadDeliverable;
  let verificationMethodCanonical: string;
  let deliverableSpecCanonical: string;
  let verificationMethodHash: string;
  let deliverableSpecHash: string;
  try {
    // Give the untrusted capability adapter exact-byte-preserving clones. This
    // retains unknown inert members in the signed/capability identity without
    // allowing an adapter to mutate the caller's Listing before a failed gate.
    verificationMethod = structuredClone(deliverable.verificationMethod);
    deliverableSpec = structuredClone(deliverable);
    verificationMethodCanonical = canonicalize(verificationMethod);
    deliverableSpecCanonical = canonicalize(deliverableSpec);
    verificationMethodHash = sha256Hex(verificationMethodCanonical);
    deliverableSpecHash = sha256Hex(deliverableSpecCanonical);
  } catch {
    return {
      operation,
      disposition: "error",
      reason: "payload-verification-capability-input-not-canonicalizable",
      verificationMethodKind: deliverable.verificationMethod.kind,
    };
  }

  const details = {
    operation,
    verificationMethodKind: deliverable.verificationMethod.kind,
    verificationMethodHash,
    deliverableSpecHash,
  } as const;
  if (!resolver) {
    return {
      disposition: "unsupported",
      reason: "payload-verification-capability-unconfigured",
      ...details,
    };
  }

  let rawDecision: PayloadVerificationCapabilityDecision;
  try {
    rawDecision = await resolver({
      operation,
      // Pass complete clones, not reconstructed normative projections.
      verificationMethod,
      verificationMethodHash,
      deliverableSpec,
      deliverableSpecHash,
    });
  } catch {
    return {
      disposition: "error",
      reason: "payload-verification-capability-resolution-threw",
      ...details,
    };
  }
  let decision: PayloadVerificationCapabilityDecision;
  try {
    decision = snapshotCanonicalJsonRead(
      rawDecision,
      "payload verification capability decision",
    );
  } catch {
    return {
      disposition: "error",
      reason: "payload-verification-capability-resolution-invalid",
      ...details,
    };
  }
  try {
    if (
      canonicalize(verificationMethod) !== verificationMethodCanonical ||
      canonicalize(deliverableSpec) !== deliverableSpecCanonical
    ) {
      return {
        disposition: "error",
        reason: "payload-verification-capability-resolution-mutated-input",
        ...details,
      };
    }
  } catch {
    return {
      disposition: "error",
      reason: "payload-verification-capability-resolution-mutated-input",
      ...details,
    };
  }
  if (!isCapabilityDecision(decision)) {
    return {
      disposition: "error",
      reason: "payload-verification-capability-resolution-invalid",
      ...details,
    };
  }
  return {
    disposition: decision.disposition,
    reason: decision.reason ?? "supported",
    ...details,
  };
}

export interface ListingValidationDeps {
  nowMs: () => number;
  verifyListingSignature: SignatureVerifier;
  revocation: Omit<ListingRevocationDeps, "nowMs">;
  /** DACS-1 §6.3.2 BP-1..BP-4 verifier over the exact presentation payload. */
  verifyIdentityPresentation: (input: {
    bundle: Readonly<IdentityBundle>;
    signedBytes: Uint8Array;
  }) => Promise<boolean> | boolean;
  /** Load the authenticated DACS-4 authority view required by LRR-2/LRR-6. */
  loadRailResolution?: (
    listing: Readonly<Listing>,
  ) => Promise<ListingRailAuthorityInput> | ListingRailAuthorityInput;
  /** DACS-4 DPA-1 local exact-byte verification support and availability. */
  resolvePayloadVerificationCapability?: PayloadVerificationCapabilityResolver;
  /** DACS-1 §6.3.4 step 9 control proof; claim membership alone is insufficient. */
  verifySellerControl: (input: {
    bundle: Readonly<IdentityBundle>;
    signer: string;
  }) => Promise<boolean> | boolean;
}

function captureListingValidationDeps(
  value: ListingValidationDeps,
): ListingValidationDeps {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) {
    throw new DacsError("Listing validation dependencies must be stable data");
  }
  const revocationValue = stableDataProperty(
    value,
    "revocation",
    "Listing validation revocation dependencies",
  );
  if (
    revocationValue === null ||
    typeof revocationValue !== "object" ||
    nodeTypes.isProxy(revocationValue)
  ) {
    throw new DacsError("Listing validation revocation dependencies must be stable data");
  }
  const revocation = revocationValue as ListingValidationDeps["revocation"];
  const surfaces = snapshotCanonicalJson(
    stableDataProperty(revocation, "surfaces", "revocation.surfaces"),
    "revocation surfaces",
  ) as RevocationSurface[];
  return Object.freeze({
    nowMs: stableDataMethod<ListingValidationDeps["nowMs"]>(value, "nowMs", "Listing validation nowMs"),
    verifyListingSignature: stableDataMethod<ListingValidationDeps["verifyListingSignature"]>(
      value,
      "verifyListingSignature",
      "Listing signature verifier",
    ),
    revocation: Object.freeze({
      surfaces,
      readMarker: stableDataMethod<ListingValidationDeps["revocation"]["readMarker"]>(
        revocation,
        "readMarker",
        "revocation marker reader",
      ),
      verifyMarkerSignature: stableDataMethod<ListingValidationDeps["revocation"]["verifyMarkerSignature"]>(
        revocation,
        "verifyMarkerSignature",
        "revocation marker verifier",
      ),
    }),
    verifyIdentityPresentation: stableDataMethod<ListingValidationDeps["verifyIdentityPresentation"]>(
      value,
      "verifyIdentityPresentation",
      "identity presentation verifier",
    ),
    loadRailResolution: stableDataMethod<ListingValidationDeps["loadRailResolution"]>(
      value,
      "loadRailResolution",
      "rail authority loader",
      true,
    ),
    resolvePayloadVerificationCapability: stableDataMethod<
      ListingValidationDeps["resolvePayloadVerificationCapability"]
    >(
      value,
      "resolvePayloadVerificationCapability",
      "payload verification capability resolver",
      true,
    ),
    verifySellerControl: stableDataMethod<ListingValidationDeps["verifySellerControl"]>(
      value,
      "verifySellerControl",
      "seller control verifier",
    ),
  });
}

const identityPresentationBytes = (bundle: IdentityBundle): Uint8Array => {
  return signedBytes(
    "dacs-bundle-presentation:v1:",
    identityBundleHash(bundle),
  );
};

/**
 * Execute the ordered DACS-1 §6.3.4 reader algorithm. LRR `indeterminate` is
 * retained through step 9 so a signer-control failure still terminates as
 * `rejected`, exactly as the Standard requires.
 */
export async function validateListingArtifact(
  raw: Record<string, unknown>,
  inputDeps: ListingValidationDeps,
): Promise<ListingValidationResult> {
  // Fix every dependency identity before inspecting caller-owned artifact data.
  const deps = captureListingValidationDeps(inputDeps);
  let capturedRaw: Record<string, unknown>;
  try {
    capturedRaw = snapshotCanonicalJson(raw, "Listing validation artifact");
  } catch {
    return { disposition: "rejected", step: 1, reason: "schema-invalid" };
  }
  if (!isListingEnvelope(capturedRaw)) {
    return { disposition: "rejected", step: 1, reason: "schema-invalid" };
  }
  const envelope = capturedRaw;
  const candidateCanonical = canonicalize(capturedRaw);
  if (envelope.dacsVersion !== "1") {
    return {
      disposition: "rejected",
      step: 2,
      reason: "unsupported-dacs-major-version",
    };
  }
  const listing = envelope as Listing;
  const now = deps.nowMs();
  if (!Number.isSafeInteger(now) || now < 0) {
    return { disposition: "indeterminate", step: 3, reason: "validation-clock-invalid" };
  }
  if (
    now < listing.validity.notBefore ||
    (listing.validity.notAfter !== undefined && now > listing.validity.notAfter)
  ) {
    return { disposition: "rejected", step: 3, reason: "outside-validity-window", listing };
  }

  const listingContentHash = contentHash(capturedRaw);
  let listingSignatureValid: unknown;
  try {
    listingSignatureValid = await deps.verifyListingSignature({
      signedBytes: signedBytes("dacs-listing:v1:", listingContentHash),
      signature: snapshotCanonicalJson(
        listing.signature,
        "Listing signature verification input",
      ),
    });
  } catch {
    return {
      disposition: "indeterminate",
      step: 4,
      reason: "listing-signature-unavailable",
      listing,
      listingContentHash,
    };
  }
  if (listingSignatureValid !== true) {
    return {
      disposition: listingSignatureValid === false ? "rejected" : "indeterminate",
      step: 4,
      reason:
        listingSignatureValid === false
          ? "listing-signature-invalid"
          : "listing-signature-malformed-result",
      listing,
      listingContentHash,
    };
  }

  const revocation = await checkListingRevocation(listing, listingContentHash, {
    ...deps.revocation,
    nowMs: deps.nowMs,
  });
  if (revocation.disposition !== "absent") {
    return {
      disposition: revocation.disposition,
      step: 5,
      reason: revocation.reason,
      listing,
      listingContentHash,
      revocation: revocation.disposition,
    };
  }

  let identityVerified: unknown;
  try {
    identityVerified = await deps.verifyIdentityPresentation({
      bundle: snapshotCanonicalJson(
        listing.seller.identity,
        "identity presentation verification bundle",
      ),
      signedBytes: identityPresentationBytes(listing.seller.identity),
    });
  } catch {
    return {
      disposition: "indeterminate",
      step: 6,
      reason: "identity-presentation-unavailable",
      listing,
      listingContentHash,
      revocation: "absent",
    };
  }
  if (identityVerified !== true) {
    return {
      disposition: identityVerified === false ? "rejected" : "indeterminate",
      step: 6,
      reason:
        identityVerified === false
          ? "identity-presentation-invalid"
          : "identity-presentation-malformed-result",
      listing,
      listingContentHash,
      revocation: "absent",
    };
  }
  if (!isListingPipelineValid(listing)) {
    return {
      disposition: "rejected",
      step: 7,
      reason: "pipeline-invalid",
      listing,
      listingContentHash,
      revocation: "absent",
    };
  }

  const payloadVerificationCapability =
    await resolveListingPayloadVerificationCapability(
      listing,
      "verify",
      deps.resolvePayloadVerificationCapability,
    );
  if (payloadVerificationCapability.disposition === "unsupported") {
    return {
      disposition: "rejected",
      step: 7,
      reason: "payload-verification-method-unsupported",
      listing,
      listingContentHash,
      revocation: "absent",
      payloadVerificationCapability,
    };
  }
  if (
    payloadVerificationCapability.disposition === "indeterminate" ||
    payloadVerificationCapability.disposition === "error"
  ) {
    // DACS-1 exposes no top-level `error` Listing disposition. Preserve the
    // method-level result while failing session admission as indeterminate.
    return {
      disposition: "indeterminate",
      step: 7,
      reason: `payload-verification-method-${payloadVerificationCapability.disposition}`,
      listing,
      listingContentHash,
      revocation: "absent",
      payloadVerificationCapability,
    };
  }
  const payloadCapabilityField =
    payloadVerificationCapability.disposition === "supported"
      ? { payloadVerificationCapability }
      : {};

  const payPhases = listing.pipeline
    .filter((phase) => phase.kind.startsWith("pay-"))
    .map((phase) => ({ kind: phase.kind, rail: phase.parameters?.rail }));
  let railResolution = railResult("verified", "not-applicable");
  if (payPhases.length > 0) {
    if (!deps.loadRailResolution) {
      railResolution = railResult("indeterminate", "rail-authority-unavailable");
    } else {
      try {
        const authority = snapshotCanonicalJsonRead(
          await deps.loadRailResolution(
            snapshotCanonicalJson(listing, "rail authority Listing input"),
          ),
          "rail authority result",
        );
        if (!isRecord(authority)) throw new TypeError("malformed rail authority");
        railResolution = resolveListingRails({
          ...authority,
          payPhases,
          acceptedRails: listing.acceptedRails ?? [],
        } as ListingRailResolutionInput);
      } catch {
        railResolution = railResult("indeterminate", "rail-authority-unavailable");
      }
    }
    if (railResolution.disposition === "rejected") {
      return {
        disposition: "rejected",
        step: 8,
        reason: railResolution.reason,
        listing,
        listingContentHash,
        revocation: "absent",
        railResolution,
        ...payloadCapabilityField,
      };
    }
  }

  const signerIsCarried = listing.seller.identity.claims.some(
    (claim) =>
      sameCanonicalClaimIdentity(claim.ref, listing.signature.signer),
  );
  let signerControlled: unknown = false;
  if (signerIsCarried) {
    try {
      signerControlled = await deps.verifySellerControl({
        bundle: snapshotCanonicalJson(
          listing.seller.identity,
          "seller control verification bundle",
        ),
        signer: listing.signature.signer,
      });
    } catch {
      return {
        disposition: "indeterminate",
        step: 9,
        reason: "signer-control-unavailable",
        listing,
        listingContentHash,
        revocation: "absent",
        railResolution,
      };
    }
  }
  if (!signerIsCarried || signerControlled !== true) {
    return {
      disposition:
        !signerIsCarried || signerControlled === false
          ? "rejected"
          : "indeterminate",
      step: 9,
      reason: !signerIsCarried
        ? "signer-not-in-identity"
        : signerControlled === false
          ? "signer-control-invalid"
          : "signer-control-malformed-result",
      listing,
      listingContentHash,
      revocation: "absent",
      railResolution,
      ...payloadCapabilityField,
    };
  }
  if (railResolution.disposition === "indeterminate") {
    return {
      disposition: "indeterminate",
      step: 8,
      reason: railResolution.reason,
      listing,
      listingContentHash,
      revocation: "absent",
      railResolution,
      ...payloadCapabilityField,
    };
  }
  try {
    if (canonicalize(listing) !== candidateCanonical) {
      return {
        disposition: "indeterminate",
        step: 9,
        reason: "listing-validation-snapshot-mutated",
        listing,
        listingContentHash,
        revocation: "absent",
        railResolution,
        ...payloadCapabilityField,
      };
    }
  } catch {
    return {
      disposition: "indeterminate",
      step: 9,
      reason: "listing-validation-snapshot-mutated",
      listing,
      listingContentHash,
      revocation: "absent",
      railResolution,
      ...payloadCapabilityField,
    };
  }
  return {
    disposition: "verified",
    step: 9,
    reason: "verified",
    listing,
    listingContentHash,
    revocation: "absent",
    railResolution,
    ...payloadCapabilityField,
  };
}

export type ListingReachability = "reachable" | "unreachable" | "indeterminate";

export interface ReachabilityProbeResult {
  status: number;
  bytes: number;
  redirected?: boolean;
  actionable: boolean;
}

export interface ListingReachabilityDeps {
  nowMs: () => number;
  resolveHost: (hostname: string) => Promise<string[]>;
  /**
   * Implementations MUST connect only to one of `approvedAddresses`, disable
   * redirects and credentials, enforce `timeoutMs`, stop at `maxBytes` after
   * decoding, and repeat DNS/address validation before every new connection.
   */
  probe: (input: {
    url: string;
    approvedAddresses: string[];
    timeoutMs: number;
    maxBytes: number;
    redirect: "error";
    credentials: "omit";
    /** Aborted by the SDK when its hard timeout wins the race. */
    signal: AbortSignal;
  }) => Promise<ReachabilityProbeResult>;
  timeoutMs?: number;
  maxBytes?: number;
  /**
   * Additional HTTPS surfaces supplied by an authenticated owning rail or
   * negotiation registry. Non-HTTPS coordinates remain governed and probed by
   * that registry; they are not reinterpreted as SDK-created URL conventions.
   */
  registryHttpsSurfaces?: readonly string[];
}

export interface ListingReachabilityResult {
  status: ListingReachability;
  checkedAt: number;
  reason: string;
  url?: string;
}

function captureReachabilityDeps(
  value: ListingReachabilityDeps,
): ListingReachabilityDeps {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) {
    throw new DacsError("Listing reachability dependencies must be stable data");
  }
  const timeoutMs = stableDataProperty(value, "timeoutMs", "reachability.timeoutMs");
  const maxBytes = stableDataProperty(value, "maxBytes", "reachability.maxBytes");
  if (
    (timeoutMs !== undefined &&
      (typeof timeoutMs !== "number" ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs <= 0)) ||
    (maxBytes !== undefined &&
      (typeof maxBytes !== "number" ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes <= 0))
  ) {
    throw new DacsError("reachability bounds must be positive safe integers");
  }
  const surfaces = stableDataProperty(
    value,
    "registryHttpsSurfaces",
    "reachability.registryHttpsSurfaces",
  );
  return Object.freeze({
    nowMs: stableDataMethod<ListingReachabilityDeps["nowMs"]>(value, "nowMs", "reachability.nowMs"),
    resolveHost: stableDataMethod<ListingReachabilityDeps["resolveHost"]>(value, "resolveHost", "reachability.resolveHost"),
    probe: stableDataMethod<ListingReachabilityDeps["probe"]>(value, "probe", "reachability.probe"),
    ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
    ...(maxBytes === undefined ? {} : { maxBytes: maxBytes as number }),
    ...(surfaces === undefined
      ? {}
      : {
          registryHttpsSurfaces: snapshotCanonicalJson(
            surfaces,
            "reachability registry HTTPS surfaces",
          ) as string[],
        }),
  });
}

const ipv4Number = (address: string): number | null => {
  if (isIP(address) !== 4) return null;
  return address
    .split(".")
    .map(Number)
    .reduce((value, part) => value * 256 + part, 0) >>> 0;
};

const ipv4InCidr = (value: number, base: string, prefix: number): boolean => {
  const baseValue = ipv4Number(base);
  if (baseValue === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (baseValue & mask);
};

function ipv6Number(address: string): bigint | null {
  if (address.includes("%")) return null; // zone identifiers are link-scoped
  let value = address.toLowerCase();
  const ipv4Tail = value.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (ipv4Tail) {
    const encoded = ipv4Number(ipv4Tail);
    if (encoded === null) return null;
    value = `${value.slice(0, -ipv4Tail.length)}${(encoded >>> 16).toString(16)}:${(
      encoded & 0xffff
    ).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0]!.split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1]!.split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))
  ) {
    return null;
  }
  return groups.reduce(
    (result, group) => (result << 16n) | BigInt(parseInt(group, 16)),
    0n,
  );
}

const ipv6InCidr = (value: bigint, base: string, prefix: number): boolean => {
  const baseValue = ipv6Number(base);
  if (baseValue === null) return false;
  const shift = BigInt(128 - prefix);
  return value >> shift === baseValue >> shift;
};

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address)!;
    return ![
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.31.196.0", 24],
      ["192.52.193.0", 24],
      ["192.88.99.0", 24],
      ["192.168.0.0", 16],
      ["192.175.48.0", 24],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ].some(([base, prefix]) => ipv4InCidr(value, base as string, prefix as number));
  }
  if (family === 6) {
    const value = ipv6Number(address);
    if (value === null) return false;
    return ![
      ["::", 96],
      ["::ffff:0:0", 96],
      ["64:ff9b::", 96],
      ["64:ff9b:1::", 48],
      ["100::", 64],
      ["2001::", 23],
      ["2001:db8::", 32],
      ["2002::", 16],
      ["fc00::", 7],
      ["fe80::", 10],
      ["fec0::", 10],
      ["ff00::", 8],
    ].some(([base, prefix]) => ipv6InCidr(value, base as string, prefix as number));
  }
  return false;
}

/**
 * DACS-1 §6.3.4 LP-5 operational reachability. The result is intentionally
 * separate from Listing validity, signature, revocation, and reputation.
 */
async function assessEndpoint(
  endpoint: string,
  checkedAt: number,
  deps: ListingReachabilityDeps,
): Promise<ListingReachabilityResult> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { status: "unreachable", checkedAt, reason: "invalid-endpoint", url: endpoint };
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname === "localhost"
  ) {
    return { status: "unreachable", checkedAt, reason: "unsafe-endpoint", url: endpoint };
  }
  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  let addresses: string[];
  try {
    addresses = snapshotCanonicalJsonRead(
      await deps.resolveHost(hostname),
      "reachability DNS result",
    );
  } catch {
    return { status: "indeterminate", checkedAt, reason: "dns-unavailable", url: endpoint };
  }
  if (!Array.isArray(addresses) || addresses.some((address) => typeof address !== "string")) {
    return { status: "indeterminate", checkedAt, reason: "dns-malformed", url: endpoint };
  }
  if (addresses.length === 0) {
    return { status: "indeterminate", checkedAt, reason: "dns-empty", url: endpoint };
  }
  if (!addresses.every(isPublicAddress)) {
    return { status: "unreachable", checkedAt, reason: "non-public-address", url: endpoint };
  }
  try {
    const timeoutMs =
      Number.isFinite(deps.timeoutMs) && (deps.timeoutMs ?? 0) > 0
        ? deps.timeoutMs!
        : 5_000;
    const maxBytes =
      Number.isSafeInteger(deps.maxBytes) && (deps.maxBytes ?? 0) > 0
        ? deps.maxBytes!
        : 64 * 1_024;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error("probe-timeout"));
        reject(new Error("probe-timeout"));
      }, timeoutMs);
    });
    let response: ReachabilityProbeResult;
    try {
      response = await Promise.race([
        deps.probe({
          url: endpoint,
          approvedAddresses: [...new Set(addresses)],
          timeoutMs,
          maxBytes,
          redirect: "error",
          credentials: "omit",
          signal: controller.signal,
        }),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    let capturedResponse: unknown;
    try {
      capturedResponse = snapshotCanonicalJsonRead(
        response,
        "reachability probe result",
      );
    } catch {
      return { status: "indeterminate", checkedAt, reason: "probe-result-malformed", url: endpoint };
    }
    if (
      !isRecord(capturedResponse) ||
      !hasOnlyKeys(capturedResponse, ["status", "bytes", "actionable"], ["redirected"]) ||
      typeof capturedResponse.status !== "number" ||
      !Number.isSafeInteger(capturedResponse.status) ||
      capturedResponse.status < 100 ||
      capturedResponse.status > 599 ||
      typeof capturedResponse.bytes !== "number" ||
      !Number.isSafeInteger(capturedResponse.bytes) ||
      capturedResponse.bytes < 0 ||
      typeof capturedResponse.actionable !== "boolean" ||
      (capturedResponse.redirected !== undefined &&
        typeof capturedResponse.redirected !== "boolean")
    ) {
      return { status: "indeterminate", checkedAt, reason: "probe-result-malformed", url: endpoint };
    }
    response = capturedResponse as unknown as ReachabilityProbeResult;
    if (response.redirected) {
      return { status: "unreachable", checkedAt, reason: "redirect-refused", url: endpoint };
    }
    if (response.bytes > maxBytes) {
      return { status: "unreachable", checkedAt, reason: "response-too-large", url: endpoint };
    }
    return response.status >= 200 && response.status < 300 && response.actionable
      ? { status: "reachable", checkedAt, reason: "actionable", url: endpoint }
      : { status: "unreachable", checkedAt, reason: "not-actionable", url: endpoint };
  } catch (error) {
    return {
      status: "indeterminate",
      checkedAt,
      reason:
        error instanceof Error && error.message === "probe-timeout"
          ? "probe-timeout"
          : "probe-failed",
      url: endpoint,
    };
  }
}

export async function assessListingReachability(
  inputListing: Listing,
  inputDeps: ListingReachabilityDeps,
): Promise<ListingReachabilityResult> {
  let deps: ListingReachabilityDeps;
  try {
    deps = captureReachabilityDeps(inputDeps);
  } catch {
    return { status: "indeterminate", checkedAt: 0, reason: "reachability-input-malformed" };
  }
  let listing: Listing;
  try {
    listing = snapshotCanonicalJson(inputListing, "reachability Listing");
  } catch {
    return { status: "indeterminate", checkedAt: 0, reason: "listing-malformed" };
  }
  if (!isListingEnvelope(listing)) {
    return { status: "indeterminate", checkedAt: 0, reason: "listing-malformed" };
  }
  const checkedAt = deps.nowMs();
  if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) {
    return { status: "indeterminate", checkedAt: 0, reason: "reachability-clock-invalid" };
  }
  const surfaces = [
    ...(listing.seller.publicEndpoint ? [listing.seller.publicEndpoint] : []),
    ...(deps.registryHttpsSurfaces ?? []),
  ];
  if (surfaces.some((surface) => typeof surface !== "string")) {
    return { status: "indeterminate", checkedAt, reason: "engagement-surface-malformed" };
  }
  if (surfaces.length === 0) {
    return { status: "indeterminate", checkedAt, reason: "no-engagement-surface" };
  }
  const results: ListingReachabilityResult[] = [];
  for (const surface of [...new Set(surfaces)]) {
    const result = await assessEndpoint(surface, checkedAt, deps);
    if (result.status === "reachable") return result;
    results.push(result);
  }
  return (
    results.find((result) => result.status === "indeterminate") ??
    results[0]!
  );
}

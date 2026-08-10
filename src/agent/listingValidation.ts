import { isIP } from "node:net";

import type {
  ComponentSignature,
  IdentityBundle,
  Listing,
  ListingDraft,
  ListingPin,
  PaymentRailRef,
  PhaseStep,
} from "../artifacts/types.js";
import {
  isLegacyMvpListing,
  isListingPipelineValid,
  isListingWireEnvelope,
} from "../artifacts/validators.js";
import {
  canonicalize,
  contentHash,
  listingRevocationAddress,
} from "../canonical/index.js";

/** The closed DACS-1 §6.3.4 reader result set. */
export type ListingValidationDisposition =
  | "verified"
  | "rejected"
  | "revoked"
  | "indeterminate";

export type ListingValidationStep =
  | "schema"
  | "version"
  | "validity"
  | "signature"
  | "revocation"
  | "identity"
  | "pipeline"
  | "rails"
  | "signer-control";

export interface ListingValidationReason {
  step: ListingValidationStep;
  code: string;
  message: string;
}

export interface ListingValidationEvidence {
  step: ListingValidationStep;
  status: "verified" | "rejected" | "revoked" | "indeterminate" | "not-applicable";
  code: string;
  detail?: Record<string, unknown>;
}

export interface ListingValidationResult {
  disposition: ListingValidationDisposition;
  reasons: ListingValidationReason[];
  evidence: ListingValidationEvidence[];
  listing?: Listing;
  listingPin?: ListingPin;
  railResolution?: ListingRailResolutionResult;
}

export type ArtifactSignatureCheck =
  | { status: "valid"; evidence?: Record<string, unknown> }
  | { status: "invalid"; reason: string; evidence?: Record<string, unknown> }
  | {
      status: "indeterminate";
      reason: string;
      evidence?: Record<string, unknown>;
    };

export interface ArtifactSignatureCheckInput {
  artifact: Readonly<Record<string, unknown>>;
  separator: "dacs-listing:v1:" | "dacs-revocation:v1:" | "dacs-rail:v1:";
  signature: Readonly<ComponentSignature>;
}

export type IdentityBundleCheck =
  | {
      status: "verified";
      /** Claims for which the presentation established control (§6.3.2 step 6). */
      controlledClaims: readonly string[];
      evidence?: Record<string, unknown>;
    }
  | { status: "rejected"; reason: string; evidence?: Record<string, unknown> }
  | {
      status: "indeterminate";
      reason: string;
      evidence?: Record<string, unknown>;
    };

export interface RevocationMarker {
  listingId: string;
  listingVersion: number;
  listingContentHash: string;
  revokedAt: number;
  reason?: string;
  signature: ComponentSignature;
}

export interface RevocationBinding {
  sellerPrimaryClaim: string;
  listingId: string;
  listingVersion: number;
  listingContentHash: string;
  logicalAddress: string;
  markerAnchor: { kind: string; locator: string };
  markerContentHash: string;
}

export type RevocationObservation =
  | {
      source: string;
      status: "active";
      integrity: "consistent" | "inconsistent" | "indeterminate";
      /** Required for catalog observations; older than 24h cannot prove absence. */
      catalogObservedAt?: number;
      evidence?: Record<string, unknown>;
    }
  | {
      source: string;
      status: "revoked";
      integrity: "consistent" | "inconsistent" | "indeterminate";
      binding: unknown;
      evidence?: Record<string, unknown>;
    }
  | {
      source: string;
      status: "indeterminate";
      reason: string;
      evidence?: Record<string, unknown>;
    };

export interface RailDefinition {
  railVersion: number;
  railId: string;
  phaseHandler: string;
  signature: ComponentSignature;
  [key: string]: unknown;
}

/**
 * One authenticated registry resolution. The resolver owns PA-1/2/3 transport
 * and receipt verification; the core independently checks the returned index
 * binding, definition hash/signature, version, and handler.
 */
export type RailResolutionAttempt =
  | {
      status: "resolved";
      authority: "pa1-in-code" | "pa2-single-signer" | "pa3-multisig";
      authenticated: boolean;
      finalized: boolean;
      /** Stable identity of the one internally consistent index snapshot. */
      snapshotId: string;
      index: { railId: string; railVersion: number; contentHash: string };
      definition: unknown;
      evidence?: Record<string, unknown>;
    }
  | {
      status: "missing";
      /** True only when an authenticated snapshot conclusively lacks the ref. */
      authoritative: boolean;
      reason: string;
      evidence?: Record<string, unknown>;
    }
  | {
      status: "indeterminate";
      reason: string;
      evidence?: Record<string, unknown>;
    };

export interface ResolvedListingRail {
  ref: PaymentRailRef;
  authority: "pa1-in-code" | "pa2-single-signer" | "pa3-multisig";
  definition: RailDefinition;
}

export interface ListingRailResolutionResult {
  disposition: "verified" | "rejected" | "indeterminate";
  reasons: ListingValidationReason[];
  evidence: ListingValidationEvidence[];
  resolved: ResolvedListingRail[];
}

export interface ListingRailResolutionDeps {
  /** Resolve through one disclosed PA-1/2/3 trust policy and authenticated snapshot. */
  resolveRail: (
    ref: Readonly<PaymentRailRef>,
  ) => Promise<RailResolutionAttempt> | RailResolutionAttempt;
  /** Cryptographically verify the independently resolved rail definition. */
  verifyArtifactSignature: (
    input: ArtifactSignatureCheckInput,
  ) => Promise<ArtifactSignatureCheck> | ArtifactSignatureCheck;
  /** Apply the complete DACS-4 RailDefinition schema and RD-1..RD-6 policy. */
  validateRailDefinition: (
    definition: Readonly<Record<string, unknown>>,
  ) => Promise<boolean> | boolean;
}

export interface ListingValidationDeps extends ListingRailResolutionDeps {
  nowMs: () => number;
  /** Verify IdentityBundle bytes/presentation and report exactly which claims are controlled. */
  verifyIdentityBundle: (
    bundle: Readonly<IdentityBundle>,
  ) => Promise<IdentityBundleCheck> | IdentityBundleCheck;
  /** Read every discovery record required by the caller's trust/discovery policy. */
  readRevocationObservations: (input: {
    listing: Readonly<Listing>;
    listingPin: Readonly<ListingPin>;
  }) => Promise<readonly RevocationObservation[]>;
  /** Resolve a marker only through its binding's typed anchor. */
  readRevocationMarker: (
    anchor: Readonly<{ kind: string; locator: string }>,
  ) => Promise<unknown>;
}

const reason = (
  step: ListingValidationStep,
  code: string,
  message: string,
): ListingValidationReason => ({ step, code, message });

const evidence = (
  step: ListingValidationStep,
  status: ListingValidationEvidence["status"],
  code: string,
  detail?: Record<string, unknown>,
): ListingValidationEvidence => ({ step, status, code, ...(detail ? { detail } : {}) });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const isComponentSignatureShape = (value: unknown): value is ComponentSignature =>
  isRecord(value) &&
  (value.algorithm === "ed25519" ||
    value.algorithm === "ecdsa-secp256k1" ||
    value.algorithm === "sr1-aggregate") &&
  typeof value.signer === "string" &&
  value.signer.length > 0 &&
  typeof value.value === "string" &&
  value.value.length > 0;

const isRevocationBinding = (value: unknown): value is RevocationBinding =>
  isRecord(value) &&
  typeof value.sellerPrimaryClaim === "string" &&
  typeof value.listingId === "string" &&
  isPositiveSafeInteger(value.listingVersion) &&
  typeof value.listingContentHash === "string" &&
  typeof value.logicalAddress === "string" &&
  isRecord(value.markerAnchor) &&
  typeof value.markerAnchor.kind === "string" &&
  typeof value.markerAnchor.locator === "string" &&
  typeof value.markerContentHash === "string";

const isRevocationMarker = (value: unknown): value is RevocationMarker =>
  isRecord(value) &&
  typeof value.listingId === "string" &&
  isPositiveSafeInteger(value.listingVersion) &&
  typeof value.listingContentHash === "string" &&
  typeof value.revokedAt === "number" &&
  Number.isSafeInteger(value.revokedAt) &&
  value.revokedAt >= 0 &&
  (value.reason === undefined || typeof value.reason === "string") &&
  isComponentSignatureShape(value.signature);

const isRailDefinition = (value: unknown): value is RailDefinition =>
  isRecord(value) &&
  isPositiveSafeInteger(value.railVersion) &&
  typeof value.railId === "string" &&
  value.railId.length > 0 &&
  typeof value.phaseHandler === "string" &&
  value.phaseHandler.startsWith("pay-") &&
  isComponentSignatureShape(value.signature);

function terminal(
  disposition: ListingValidationDisposition,
  reasons: ListingValidationReason[],
  trail: ListingValidationEvidence[],
  listing?: Listing,
  listingPin?: ListingPin,
  railResolution?: ListingRailResolutionResult,
): ListingValidationResult {
  return {
    disposition,
    reasons,
    evidence: trail,
    ...(listing ? { listing } : {}),
    ...(listingPin ? { listingPin } : {}),
    ...(railResolution ? { railResolution } : {}),
  };
}

function payPhases(listing: Listing | ListingDraft): PhaseStep[] {
  return listing.pipeline.filter((phase) => phase.kind.startsWith("pay-"));
}

/** Execute DACS-1 LRR-1..LRR-6 over every advertised rail. */
export async function resolveListingRails(
  listing: Listing | ListingDraft,
  deps: ListingRailResolutionDeps,
): Promise<ListingRailResolutionResult> {
  const reasons: ListingValidationReason[] = [];
  const trail: ListingValidationEvidence[] = [];
  const phases = payPhases(listing);
  if (phases.length === 0) {
    trail.push(evidence("rails", "not-applicable", "payless-pipeline"));
    return { disposition: "verified", reasons, evidence: trail, resolved: [] };
  }

  const refs = listing.acceptedRails;
  if (!refs || refs.length === 0) {
    const failure = reason("rails", "accepted-rails-missing", "pay-bearing pipeline has no acceptedRails");
    return {
      disposition: "rejected",
      reasons: [failure],
      evidence: [evidence("rails", "rejected", failure.code)],
      resolved: [],
    };
  }

  let canonicalRefs: string[];
  try {
    canonicalRefs = refs.map((ref) => canonicalize(ref));
  } catch (error) {
    const failure = reason("rails", "rail-reference-not-canonical", String(error));
    return {
      disposition: "rejected",
      reasons: [failure],
      evidence: [evidence("rails", "rejected", failure.code)],
      resolved: [],
    };
  }
  if (new Set(canonicalRefs).size !== canonicalRefs.length) {
    const failure = reason("rails", "duplicate-rail-reference", "acceptedRails contains a duplicate canonical PaymentRailRef");
    return {
      disposition: "rejected",
      reasons: [failure],
      evidence: [evidence("rails", "rejected", failure.code)],
      resolved: [],
    };
  }
  for (const phase of phases) {
    const rail = phase.parameters?.rail;
    if (typeof rail !== "string" || !refs.some((ref) => ref.railId === rail)) {
      const failure = reason("rails", "phase-rail-unbound", `${phase.kind} does not bind to an advertised railId`);
      return {
        disposition: "rejected",
        reasons: [failure],
        evidence: [evidence("rails", "rejected", failure.code, { phase: phase.kind })],
        resolved: [],
      };
    }
  }

  const resolved: ResolvedListingRail[] = [];
  let hasRejected = false;
  let hasIndeterminate = false;
  let snapshotId: string | undefined;

  for (const ref of refs) {
    let attempt: RailResolutionAttempt;
    try {
      attempt = await deps.resolveRail(ref);
    } catch (error) {
      attempt = { status: "indeterminate", reason: `rail resolver threw: ${String(error)}` };
    }
    if (attempt.status === "indeterminate") {
      hasIndeterminate = true;
      reasons.push(reason("rails", "rail-resolution-indeterminate", `${ref.railId}: ${attempt.reason}`));
      trail.push(evidence("rails", "indeterminate", "rail-resolution-indeterminate", { railId: ref.railId, ...(attempt.evidence ?? {}) }));
      continue;
    }
    if (attempt.status === "missing") {
      if (attempt.authoritative) {
        hasRejected = true;
        reasons.push(reason("rails", "rail-not-found", `${ref.railId}: ${attempt.reason}`));
        trail.push(evidence("rails", "rejected", "rail-not-found", { railId: ref.railId, ...(attempt.evidence ?? {}) }));
      } else {
        hasIndeterminate = true;
        reasons.push(reason("rails", "rail-source-unauthenticated", `${ref.railId}: ${attempt.reason}`));
        trail.push(evidence("rails", "indeterminate", "rail-source-unauthenticated", { railId: ref.railId, ...(attempt.evidence ?? {}) }));
      }
      continue;
    }
    if (!attempt.authenticated) {
      hasIndeterminate = true;
      reasons.push(reason("rails", "rail-authority-unauthenticated", `${ref.railId}: registry authority did not authenticate`));
      trail.push(evidence("rails", "indeterminate", "rail-authority-unauthenticated", { railId: ref.railId, authority: attempt.authority }));
      continue;
    }
    if (!attempt.finalized) {
      hasIndeterminate = true;
      reasons.push(reason("rails", "rail-receipt-not-finalized", `${ref.railId}: registry content is not finalized`));
      trail.push(evidence("rails", "indeterminate", "rail-receipt-not-finalized", { railId: ref.railId, authority: attempt.authority }));
      continue;
    }
    if (attempt.snapshotId.length === 0) {
      hasIndeterminate = true;
      reasons.push(reason("rails", "rail-snapshot-unidentified", `${ref.railId}: registry snapshot has no stable identity`));
      trail.push(evidence("rails", "indeterminate", "rail-snapshot-unidentified", { railId: ref.railId }));
      continue;
    }
    if (snapshotId !== undefined && snapshotId !== attempt.snapshotId) {
      hasIndeterminate = true;
      reasons.push(reason("rails", "rail-snapshot-inconsistent", `${ref.railId}: references resolved from different registry snapshots`));
      trail.push(evidence("rails", "indeterminate", "rail-snapshot-inconsistent", { railId: ref.railId, expectedSnapshotId: snapshotId, actualSnapshotId: attempt.snapshotId }));
      continue;
    }
    snapshotId = attempt.snapshotId;
    if (!isRailDefinition(attempt.definition)) {
      hasRejected = true;
      reasons.push(reason("rails", "rail-definition-malformed", `${ref.railId}: authenticated definition has an invalid shape`));
      trail.push(evidence("rails", "rejected", "rail-definition-malformed", { railId: ref.railId }));
      continue;
    }
    const definition = attempt.definition;
    const selectedVersion = ref.railVersion ?? attempt.index.railVersion;
    if (
      attempt.index.railId !== ref.railId ||
      definition.railId !== ref.railId ||
      attempt.index.railVersion !== selectedVersion ||
      definition.railVersion !== selectedVersion
    ) {
      hasRejected = true;
      reasons.push(reason("rails", "rail-reference-contradiction", `${ref.railId}: index/definition does not repeat the selected id and version`));
      trail.push(evidence("rails", "rejected", "rail-reference-contradiction", { railId: ref.railId, selectedVersion }));
      continue;
    }
    let actualHash: string;
    try {
      actualHash = contentHash(definition);
    } catch (error) {
      hasIndeterminate = true;
      reasons.push(reason("rails", "rail-content-unavailable", `${ref.railId}: ${String(error)}`));
      trail.push(evidence("rails", "indeterminate", "rail-content-unavailable", { railId: ref.railId }));
      continue;
    }
    if (actualHash !== attempt.index.contentHash) {
      hasIndeterminate = true;
      reasons.push(reason("rails", "rail-index-content-inconsistent", `${ref.railId}: resolved definition does not match the authenticated index hash`));
      trail.push(evidence("rails", "indeterminate", "rail-index-content-inconsistent", { railId: ref.railId, expected: attempt.index.contentHash, actual: actualHash }));
      continue;
    }
    let signatureCheck: ArtifactSignatureCheck;
    try {
      signatureCheck = await deps.verifyArtifactSignature({
        artifact: definition,
        separator: "dacs-rail:v1:",
        signature: definition.signature,
      });
    } catch (error) {
      signatureCheck = { status: "indeterminate", reason: String(error) };
    }
    if (signatureCheck.status !== "valid") {
      hasIndeterminate = true;
      reasons.push(reason("rails", "rail-signature-unverified", `${ref.railId}: ${signatureCheck.reason}`));
      trail.push(evidence("rails", "indeterminate", "rail-signature-unverified", { railId: ref.railId, ...(signatureCheck.evidence ?? {}) }));
      continue;
    }
    let definitionValid = false;
    try {
      definitionValid = await deps.validateRailDefinition(definition);
    } catch {
      definitionValid = false;
    }
    if (!definitionValid) {
      hasRejected = true;
      reasons.push(reason("rails", "rail-definition-invalid", `${ref.railId}: definition fails DACS-4 schema/RD-1..RD-6`));
      trail.push(evidence("rails", "rejected", "rail-definition-invalid", { railId: ref.railId }));
      continue;
    }
    resolved.push({ ref, authority: attempt.authority, definition });
    trail.push(evidence("rails", "verified", "rail-reference-verified", {
      railId: ref.railId,
      railVersion: definition.railVersion,
      authority: attempt.authority,
      ...(attempt.evidence ?? {}),
    }));
  }

  // LRR-4 is evaluated across all successfully resolved versions for each rail.
  for (const phase of phases) {
    const railId = phase.parameters?.rail;
    const matching = resolved.filter((entry) => entry.ref.railId === railId);
    if (matching.length === 0) continue;
    const handlers = new Set(matching.map((entry) => entry.definition.phaseHandler));
    if (handlers.size !== 1 || !handlers.has(phase.kind)) {
      hasRejected = true;
      reasons.push(reason("rails", "rail-handler-contradiction", `${String(railId)} definitions do not all bind to ${phase.kind}`));
      trail.push(evidence("rails", "rejected", "rail-handler-contradiction", { railId, phase: phase.kind, handlers: [...handlers] }));
    }
  }

  return {
    disposition: hasRejected ? "rejected" : hasIndeterminate ? "indeterminate" : "verified",
    reasons,
    evidence: trail,
    resolved,
  };
}

async function checkRevocation(
  listing: Listing,
  pin: ListingPin,
  deps: ListingValidationDeps,
): Promise<{
  disposition: "absent" | "revoked" | "indeterminate";
  reasons: ListingValidationReason[];
  evidence: ListingValidationEvidence[];
}> {
  let observations: readonly RevocationObservation[];
  try {
    observations = await deps.readRevocationObservations({ listing, listingPin: pin });
  } catch (error) {
    observations = [{ source: "discovery", status: "indeterminate", reason: String(error) }];
  }
  if (observations.length === 0) {
    return {
      disposition: "indeterminate",
      reasons: [reason("revocation", "revocation-discovery-incomplete", "no discovery record established revocation absence")],
      evidence: [evidence("revocation", "indeterminate", "revocation-discovery-incomplete")],
    };
  }

  const reasons: ListingValidationReason[] = [];
  const trail: ListingValidationEvidence[] = [];
  let sawIndeterminate = false;
  let sawRevoked = false;
  const expectedLogicalAddress = listingRevocationAddress(
    listing.seller.identity.presentedBy,
    listing.listingId,
    listing.listingVersion,
  );

  for (const observation of observations) {
    if (observation.status === "indeterminate") {
      sawIndeterminate = true;
      reasons.push(reason("revocation", "revocation-read-indeterminate", `${observation.source}: ${observation.reason}`));
      trail.push(evidence("revocation", "indeterminate", "revocation-read-indeterminate", { source: observation.source, ...(observation.evidence ?? {}) }));
      continue;
    }
    if (observation.integrity !== "consistent") {
      sawIndeterminate = true;
      reasons.push(reason("revocation", "revocation-record-inconsistent", `${observation.source}: discovery integrity is ${observation.integrity}`));
      trail.push(evidence("revocation", "indeterminate", "revocation-record-inconsistent", { source: observation.source }));
      continue;
    }
    if (observation.status === "active") {
      if (
        observation.catalogObservedAt !== undefined &&
        deps.nowMs() - observation.catalogObservedAt > 24 * 60 * 60 * 1_000
      ) {
        sawIndeterminate = true;
        reasons.push(reason("revocation", "revocation-catalog-stale", `${observation.source}: catalog observation is older than 24 hours`));
        trail.push(evidence("revocation", "indeterminate", "revocation-catalog-stale", { source: observation.source, catalogObservedAt: observation.catalogObservedAt }));
      } else {
        trail.push(evidence("revocation", "verified", "revocation-absent", { source: observation.source, ...(observation.evidence ?? {}) }));
      }
      continue;
    }

    const binding = observation.binding;
    if (
      !isRevocationBinding(binding) ||
      binding.sellerPrimaryClaim !== listing.seller.identity.presentedBy ||
      binding.listingId !== pin.listingId ||
      binding.listingVersion !== pin.version ||
      binding.listingContentHash !== pin.contentHash ||
      binding.logicalAddress !== expectedLogicalAddress
    ) {
      sawIndeterminate = true;
      reasons.push(reason("revocation", "revocation-binding-invalid", `${observation.source}: binding does not match publisher, tuple, or RB-1 address`));
      trail.push(evidence("revocation", "indeterminate", "revocation-binding-invalid", { source: observation.source }));
      continue;
    }
    let rawMarker: unknown;
    try {
      rawMarker = await deps.readRevocationMarker(binding.markerAnchor);
    } catch (error) {
      rawMarker = null;
      reasons.push(reason("revocation", "revocation-marker-unavailable", `${observation.source}: ${String(error)}`));
    }
    if (!isRevocationMarker(rawMarker)) {
      sawIndeterminate = true;
      if (!reasons.some((entry) => entry.code === "revocation-marker-unavailable")) {
        reasons.push(reason("revocation", "revocation-marker-malformed", `${observation.source}: marker is absent or malformed`));
      }
      trail.push(evidence("revocation", "indeterminate", "revocation-marker-unavailable", { source: observation.source }));
      continue;
    }
    const markerHash = contentHash(rawMarker as unknown as Record<string, unknown>);
    if (
      markerHash !== binding.markerContentHash ||
      rawMarker.listingId !== pin.listingId ||
      rawMarker.listingVersion !== pin.version ||
      rawMarker.listingContentHash !== pin.contentHash ||
      rawMarker.signature.signer !== listing.signature.signer
    ) {
      sawIndeterminate = true;
      reasons.push(reason("revocation", "revocation-marker-mismatch", `${observation.source}: marker hash, signer, or listing tuple does not match`));
      trail.push(evidence("revocation", "indeterminate", "revocation-marker-mismatch", { source: observation.source }));
      continue;
    }
    let signatureCheck: ArtifactSignatureCheck;
    try {
      signatureCheck = await deps.verifyArtifactSignature({
        artifact: rawMarker as unknown as Record<string, unknown>,
        separator: "dacs-revocation:v1:",
        signature: rawMarker.signature,
      });
    } catch (error) {
      signatureCheck = { status: "indeterminate", reason: String(error) };
    }
    if (signatureCheck.status !== "valid") {
      sawIndeterminate = true;
      reasons.push(reason("revocation", "revocation-signature-unverified", `${observation.source}: ${signatureCheck.reason}`));
      trail.push(evidence("revocation", "indeterminate", "revocation-signature-unverified", { source: observation.source, ...(signatureCheck.evidence ?? {}) }));
      continue;
    }
    sawRevoked = true;
    trail.push(evidence("revocation", "revoked", "revocation-marker-verified", {
      source: observation.source,
      markerContentHash: markerHash,
      revokedAt: rawMarker.revokedAt,
    }));
  }

  // RB-6: revoked > indeterminate > absent.
  return {
    disposition: sawRevoked ? "revoked" : sawIndeterminate ? "indeterminate" : "absent",
    reasons,
    evidence: trail,
  };
}

/** Execute the DACS-1 nine-step Listing reader pipeline in normative order. */
export async function validateListingArtifact(
  raw: unknown,
  deps: ListingValidationDeps,
): Promise<ListingValidationResult> {
  const trail: ListingValidationEvidence[] = [];
  if (isRecord(raw) && typeof raw.signature === "string" && isLegacyMvpListing((() => {
    const { signature: _signature, ...scope } = raw;
    return scope;
  })())) {
    const failure = reason("schema", "legacy-read-only", "historical MVP Listing is readable for audit but can never be verified for discovery or a new session");
    return terminal("rejected", [failure], [evidence("schema", "rejected", failure.code)]);
  }
  if (!isListingWireEnvelope(raw)) {
    const major = isRecord(raw) && typeof raw.dacsVersion === "string"
      ? raw.dacsVersion.split(".")[0]
      : undefined;
    const code = major !== undefined && major !== "1" ? "unsupported-major-version" : "schema-invalid";
    const failure = reason("schema", code, code === "unsupported-major-version" ? `unsupported dacsVersion major ${major}` : "artifact is not a canonical, structurally conformant normative Listing");
    return terminal("rejected", [failure], [evidence("schema", "rejected", code)]);
  }
  const listing = raw;
  trail.push(evidence("schema", "verified", "schema-conformant"));
  trail.push(evidence("version", "verified", "major-version-supported", { dacsVersion: listing.dacsVersion }));

  const now = deps.nowMs();
  if (now < listing.validity.notBefore || (listing.validity.notAfter !== undefined && now > listing.validity.notAfter)) {
    const failure = reason("validity", "outside-validity-window", "listing is not valid at the reader clock");
    return terminal("rejected", [failure], [...trail, evidence("validity", "rejected", failure.code, { now })], listing);
  }
  trail.push(evidence("validity", "verified", "within-validity-window", { now }));

  let signatureCheck: ArtifactSignatureCheck;
  try {
    signatureCheck = await deps.verifyArtifactSignature({
      artifact: listing as unknown as Record<string, unknown>,
      separator: "dacs-listing:v1:",
      signature: listing.signature,
    });
  } catch (error) {
    signatureCheck = { status: "indeterminate", reason: String(error) };
  }
  if (signatureCheck.status !== "valid") {
    const failure = reason("signature", "listing-signature-unverified", signatureCheck.reason);
    return terminal("rejected", [failure], [...trail, evidence("signature", "rejected", failure.code, signatureCheck.evidence)], listing);
  }
  trail.push(evidence("signature", "verified", "listing-signature-valid", signatureCheck.evidence));

  const pin: ListingPin = {
    listingId: listing.listingId,
    version: listing.listingVersion,
    contentHash: contentHash(listing as unknown as Record<string, unknown>),
  };
  const revocation = await checkRevocation(listing, pin, deps);
  trail.push(...revocation.evidence);
  if (revocation.disposition === "revoked") {
    return terminal("revoked", revocation.reasons, trail, listing, pin);
  }
  if (revocation.disposition === "indeterminate") {
    return terminal("indeterminate", revocation.reasons, trail, listing, pin);
  }

  let identityCheck: IdentityBundleCheck;
  try {
    identityCheck = await deps.verifyIdentityBundle(listing.seller.identity);
  } catch (error) {
    identityCheck = { status: "indeterminate", reason: String(error) };
  }
  if (identityCheck.status !== "verified") {
    const failure = reason("identity", "identity-bundle-unverified", identityCheck.reason);
    return terminal("rejected", [failure], [...trail, evidence("identity", "rejected", failure.code, identityCheck.evidence)], listing, pin);
  }
  if (!identityCheck.controlledClaims.includes(listing.seller.identity.presentedBy)) {
    const failure = reason("identity", "publisher-claim-uncontrolled", "IdentityBundle presentation does not establish control of presentedBy");
    return terminal("rejected", [failure], [...trail, evidence("identity", "rejected", failure.code, identityCheck.evidence)], listing, pin);
  }
  trail.push(evidence("identity", "verified", "identity-presentation-controlled", identityCheck.evidence));
  if (!isListingPipelineValid(listing)) {
    const failure = reason(
      "pipeline",
      "pipeline-references-invalid",
      "pipeline ordering, pricing pattern, or delivery references are invalid",
    );
    return terminal(
      "rejected",
      [failure],
      [...trail, evidence("pipeline", "rejected", failure.code)],
      listing,
      pin,
    );
  }
  trail.push(evidence("pipeline", "verified", "pipeline-references-valid"));

  const railResolution = await resolveListingRails(listing, deps);
  trail.push(...railResolution.evidence);
  if (railResolution.disposition === "rejected") {
    return terminal("rejected", railResolution.reasons, trail, listing, pin, railResolution);
  }

  // Step 9 deliberately runs after an indeterminate LRR result. A failure here
  // is terminal rejected and takes precedence over the retained indeterminate.
  if (!identityCheck.controlledClaims.includes(listing.signature.signer)) {
    const failure = reason("signer-control", "listing-signer-uncontrolled", "listing signature key is not a claim controlled by the publisher IdentityBundle");
    return terminal("rejected", [failure], [...trail, evidence("signer-control", "rejected", failure.code)], listing, pin, railResolution);
  }
  trail.push(evidence("signer-control", "verified", "listing-signer-controlled"));

  if (railResolution.disposition === "indeterminate") {
    return terminal("indeterminate", railResolution.reasons, trail, listing, pin, railResolution);
  }
  return terminal("verified", [], trail, listing, pin, railResolution);
}

export type ListingReachability = "reachable" | "unreachable" | "indeterminate";

export interface ReachabilityHttpResponse {
  status: number;
  headers?: Readonly<Record<string, string | undefined>>;
  body?: AsyncIterable<Uint8Array>;
}

export interface ListingReachabilityDeps {
  resolveHost: (hostname: string) => Promise<readonly string[]>;
  request: (input: {
    url: string;
    signal: AbortSignal;
    /** Connect only to one of these pre-vetted addresses to prevent DNS rebinding. */
    resolvedAddresses: readonly string[];
  }) => Promise<ReachabilityHttpResponse>;
  timeoutMs?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
}

export interface ListingReachabilityResult {
  reachability: ListingReachability;
  checkedAt: number;
  endpoint?: string;
  code: string;
  detail?: string;
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error("operation timed out"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts as [number, number, number, number];
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isBlockedAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return isBlockedIpv4(address);
  if (kind !== 6) return true;
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89a-f]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:") ||
    normalized.startsWith("::ffff:")
  ) return true;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mapped ? isBlockedIpv4(mapped) : false;
}

/**
 * Probe a listing endpoint as separate operational evidence. This function does
 * not receive or return a Listing and therefore cannot mutate validity, hashes,
 * revocation, reputation, or the validation disposition.
 */
export async function probeListingReachability(
  endpoint: string | undefined,
  deps: ListingReachabilityDeps,
  nowMs: () => number = () => Date.now(),
): Promise<ListingReachabilityResult> {
  const checkedAt = nowMs();
  if (!endpoint) return { reachability: "indeterminate", checkedAt, code: "no-endpoint" };
  const timeoutMs = deps.timeoutMs ?? 3_000;
  const maxRedirects = deps.maxRedirects ?? 3;
  const maxResponseBytes = deps.maxResponseBytes ?? 64 * 1_024;
  let current = endpoint;

  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      return { reachability: "indeterminate", checkedAt, endpoint: current, code: "invalid-url" };
    }
    if (url.protocol !== "https:" || url.username || url.password) {
      return { reachability: "indeterminate", checkedAt, endpoint: current, code: "unsafe-url" };
    }
    let addresses: readonly string[];
    try {
      addresses = await withTimeout(deps.resolveHost(url.hostname), timeoutMs);
    } catch (error) {
      return {
        reachability: "unreachable",
        checkedAt,
        endpoint: current,
        code: String(error).includes("timed out") ? "dns-timeout" : "dns-failed",
        detail: String(error),
      };
    }
    if (addresses.length === 0) {
      return { reachability: "unreachable", checkedAt, endpoint: current, code: "dns-empty" };
    }
    if (addresses.some(isBlockedAddress)) {
      return { reachability: "indeterminate", checkedAt, endpoint: current, code: "ssrf-address-blocked" };
    }

    const controller = new AbortController();
    let timedOut = false;
    let response: ReachabilityHttpResponse;
    try {
      response = await withTimeout(
        deps.request({
          url: url.toString(),
          signal: controller.signal,
          resolvedAddresses: addresses,
        }),
        timeoutMs,
        () => {
          timedOut = true;
          controller.abort();
        },
      );
    } catch (error) {
      return {
        reachability: "unreachable",
        checkedAt,
        endpoint: current,
        code: timedOut ? "timeout" : "request-failed",
        detail: String(error),
      };
    }

    if (
      !Number.isSafeInteger(response.status) ||
      response.status < 100 ||
      response.status > 599
    ) {
      return {
        reachability: "indeterminate",
        checkedAt,
        endpoint: current,
        code: "invalid-http-status",
      };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.location ?? response.headers?.Location;
      if (!location) return { reachability: "unreachable", checkedAt, endpoint: current, code: "redirect-without-location" };
      if (redirect === maxRedirects) return { reachability: "indeterminate", checkedAt, endpoint: current, code: "redirect-limit" };
      try {
        current = new URL(location, url).toString();
      } catch {
        return { reachability: "indeterminate", checkedAt, endpoint: current, code: "invalid-redirect" };
      }
      continue; // DNS and SSRF policy are deliberately repeated after every redirect.
    }

    let bytes = 0;
    if (response.body) {
      const iterator = response.body[Symbol.asyncIterator]();
      try {
        for (;;) {
          const next = await withTimeout(iterator.next(), timeoutMs, () =>
            controller.abort(),
          );
          if (next.done) break;
          const chunk = next.value;
          bytes += chunk.byteLength;
          if (bytes > maxResponseBytes) {
            await iterator.return?.();
            return { reachability: "indeterminate", checkedAt, endpoint: current, code: "response-too-large" };
          }
        }
      } catch (error) {
        await iterator.return?.();
        return {
          reachability: "unreachable",
          checkedAt,
          endpoint: current,
          code: String(error).includes("timed out")
            ? "response-timeout"
            : "response-read-failed",
          detail: String(error),
        };
      }
    }
    return {
      reachability: response.status < 500 ? "reachable" : "unreachable",
      checkedAt,
      endpoint: current,
      code: response.status < 500 ? "responded" : "server-error",
      detail: `HTTP ${response.status}`,
    };
  }
  return { reachability: "indeterminate", checkedAt, endpoint: current, code: "redirect-limit" };
}

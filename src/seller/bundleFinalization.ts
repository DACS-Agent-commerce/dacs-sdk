import type {
  AnchorReceipt,
  AttestationRef,
  BundleRequirement,
  BundleBinding,
  BundleSignature,
  ChainTxRef,
  ComponentSignature,
  FaultAttestationBundle,
  IdentityBundle,
  ListingRef,
  PhaseStep,
  PhaseSummaryEntry,
} from "../artifacts/types.js";
import {
  BUNDLE_BINDING_SEPARATOR,
  isAnchorReceipt,
  isAgreementArtifact,
  isAgreementCommitmentRecord,
  isAttestationRef,
  isBundleRequirement,
  isBundleBinding,
  isChainTxRef,
  isComponentSignature,
  isDeliverableSpec,
  isFaultAttestationBundle,
  isListing,
  isPhaseStep,
  isSettlementEvidence,
  isCanonicalBase64Url,
  signComponentArtifact,
  type BuildComponentSignatureOptions,
} from "../artifacts/index.js";
import {
  bundleAddress,
  canonicalize,
  contentHash,
  listingAddress,
  sha256Hex,
} from "../canonical/index.js";
import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import { ed25519Sign, privateKeyFromSeed, signedBytes } from "../crypto/index.js";
import { DacsError, SubstrateError } from "../errors.js";
import {
  attestationBundleHash,
  bundleSignedScope,
  type SessionParty,
  type SigningSessionParty,
} from "../agent/twoSidedBundle.js";
import {
  verifyBundleCopy,
  type BundleCopyDeps,
} from "../agent/bundleCopyValidity.js";
import type {
  SellerFulfilmentAgreement,
  SellerFulfilmentResult,
} from "../agent/runFulfilmentCore.js";

/** DACS-5 ST-11 proof-verification result. Unknown values never pass. */
export type SellerBundleVerificationDisposition =
  | "valid"
  | "invalid"
  | "indeterminate"
  | "error";

export type SellerBundleDependencyKind =
  | "listing"
  | "verify-result"
  | "verification-attestation"
  | "agreement"
  | "agreement-commitment"
  | "phase-attestation"
  | "vet-record"
  | "settlement-evidence"
  | "amendment"
  | "rating"
  | "payload-attestation"
  | "method-evidence"
  | "price-anchor"
  | "delivered-payload"
  | "superseded-evidence";

/**
 * Exact DACS-5 §10.3 PhaseHandlerResult projection retained by the seller.
 * This is off-chain session state, not a new signed artifact.
 */
export interface CompletedSellerPhaseHandlerResult {
  ok: boolean;
  reason?: string;
  txRefs?: ChainTxRef[];
  explorerUrls?: string[];
  contextDelta?: Record<string, unknown>;
  attestationRef?: AttestationRef;
  anchorReceipt?: AnchorReceipt;
  errorClass?:
    | "permanent"
    | "transient"
    | "counterparty"
    | "substrate"
    | "settlement-atomicity";
}

/** Exact DACS-5 §10.3 PhaseEntry projection. */
export interface CompletedSellerPhaseEntry {
  index: number;
  step: PhaseStep;
  invokedAt: number;
  result: CompletedSellerPhaseHandlerResult;
  contextDelta: Record<string, unknown>;
}

/** Exact DACS-5 §10.3 SessionParty projection. */
export interface CompletedSellerSessionParty {
  role: "buyer" | "seller" | "orchestrator";
  bundleHash: string;
  primaryClaim: string;
  vetRecordRef?: AttestationRef;
}

/**
 * The canonical, off-chain DACS-5 §10.3 record from which bundle facts are
 * derived. Successful finalization accepts only the ST-11 `audit-pending`
 * state; callers cannot separately assert phase, evidence, or registry arrays.
 */
export interface AuditPendingSellerSessionRecord {
  recordVersion: "1";
  jobId: string;
  state: "audit-pending";
  listingRef: ListingRef;
  parties: CompletedSellerSessionParty[];
  pipeline: PhaseStep[];
  phaseResults: CompletedSellerPhaseEntry[];
  startedAt: number;
  lastUpdatedAt: number;
  endedAt?: never;
  recipeRegistryVersion: number;
  railRegistryVersion: number;
  amendments?: AttestationRef[];
}

/**
 * Reference inventory retained beside the §10.3 SessionRecord. The entries are
 * candidates, not trusted session facts: the finalizer resolves, hashes,
 * authenticates, and assigns every entry to an executed phase. Keeping this
 * operational inventory separate preserves §10.4.3's rule that a per-phase
 * `attestationRef` is optional.
 */
export interface CompletedSellerSessionArtifacts {
  agreementCommitment: AttestationRef;
  /** Complete top-level DACS-2 §7.7 composite-record set for the session. */
  vetRecords: AttestationRef[];
  /**
   * Exact off-chain VPC-2 invocation inputs, one per `vetRecords` entry. This
   * is retained session provenance, not an extension to a signed DACS wire
   * artifact. The finalizer hashes each body and authenticates the invocation
   * through `verifyVetRequirementProvenance`.
   */
  vetRequirements: CompletedSellerVetRequirementInvocation[];
  settlementEvidence: AttestationRef[];
  ratingRecords?: AttestationRef[];
}

/** Exact DACS-2 Vet invocation facts retained by the session orchestrator. */
export interface CompletedSellerVetRequirementInvocation {
  vetRecordRef: AttestationRef;
  evaluatedParty: string;
  requirement: BundleRequirement;
  verifier: string;
}

export type SellerBundleDependencySource =
  | { kind: "listing"; listingRef: ListingRef }
  | {
      kind: "attestation-ref";
      ref: AttestationRef;
      /** Omitted for ordinary DACS artifacts, whose signature field is excluded. */
      encoding?: "artifact" | "jcs" | "bytes";
    }
  | {
      kind: "deliverable";
      anchor: { kind: string; locator: string };
      contentHash: string;
      encoding: "jcs" | "bytes";
    };

/** Operational receipt input; this is not a new signed DACS artifact. */
export interface FinalizedSellerBundleDependency {
  source: SellerBundleDependencySource;
  anchorReceipt: AnchorReceipt;
}

export interface SellerBundleDependencyRequirement {
  id: string;
  contentHash: string;
  encoding: "artifact" | "jcs" | "bytes";
  kinds: SellerBundleDependencyKind[];
  refs: AttestationRef[];
  source: SellerBundleDependencySource;
}

export type SellerBundleDependencyLookup =
  | { disposition: "present"; artifact: unknown; bytes?: never }
  | { disposition: "present"; bytes: Uint8Array; artifact?: never }
  | { disposition: "absent" }
  | { disposition: "indeterminate"; reason: string };

export interface AnchoredSellerBundle {
  bundle: unknown;
  nativeAddress: string;
  anchorReceipt: AnchorReceipt;
  /** DACS-5 §10.4.2 canonical SR-2 pointer, when the binding exposes one. */
  anchorTx?: string;
}

export type SellerBundleLookup =
  | { disposition: "present"; anchored: AnchoredSellerBundle }
  | { disposition: "absent" }
  | { disposition: "indeterminate"; reason: string };

export type SellerBundleBindingLookup =
  | { disposition: "present"; binding: unknown }
  | { disposition: "absent" }
  | { disposition: "indeterminate"; reason: string };

export type SellerBundleBindingPublication =
  | { disposition: "published" }
  | { disposition: "rejected"; reason: string }
  | { disposition: "indeterminate"; reason: string };

export type SellerPaymentPhaseIndexResolution =
  | {
      disposition: "valid";
      jobId: string;
      railId: string;
      phaseIndex: number;
      /** True only for the PC-2 `:resolved` address. */
      resolved: boolean;
    }
  | { disposition: "invalid"; reason: string }
  | { disposition: "indeterminate"; reason: string }
  | { disposition: "error"; reason: string };

/**
 * Transport- and substrate-neutral ST-11 seams. `absent` has the exact CORE
 * §5.1 meaning: authenticated absence under the binding's declared policy.
 */
export interface SellerBundleFinalizationProvider {
  mapping: "pure" | "write-input";
  /** Local cryptographic verifier used by the SDK's required-signer gate. */
  bundleCopyVerifier: BundleCopyDeps;
  resolveDependency: (
    dependency: Readonly<FinalizedSellerBundleDependency>,
    requirement: Readonly<SellerBundleDependencyRequirement>,
  ) => Promise<SellerBundleDependencyLookup> | SellerBundleDependencyLookup;
  verifyDependencyReceipt: (
    dependency: Readonly<FinalizedSellerBundleDependency>,
    requirement: Readonly<SellerBundleDependencyRequirement>,
  ) =>
    | Promise<SellerBundleVerificationDisposition>
    | SellerBundleVerificationDisposition;
  /**
   * Required authenticity gate after local hash recomputation. `valid` MUST
   * mean that every artifact-specific domain-separated signature/authority
   * rule, normative semantic verification (including DACS-2 aggregation),
   * logical/native anchor binding, and session binding was verified.
   * Receipt finality alone never satisfies this callback. For unsigned raw
   * bytes it verifies the method-/pointer-specific authenticated binding.
   */
  verifyDependencyBinding: (input: {
    dependency: Readonly<FinalizedSellerBundleDependency>;
    requirement: Readonly<SellerBundleDependencyRequirement>;
    artifact: unknown;
  }) =>
    | Promise<SellerBundleVerificationDisposition>
    | SellerBundleVerificationDisposition;
  /**
   * Authenticate that the published Listing IdentityBundle and the exact
   * post-Vet session bundle named by `sessionBundleHash` carry the same
   * controlled primary claim/key lineage. The Listing bundle hash is allowed
   * to differ (for example because the session bundle has a fresh nonce).
   */
  verifyListingPublisherIdentityLinkage: (input: {
    listingIdentity: Readonly<IdentityBundle>;
    listingBundleHash: string;
    sessionBundleHash: string;
    primaryClaim: string;
  }) =>
    | Promise<SellerBundleVerificationDisposition>
    | SellerBundleVerificationDisposition;
  /**
   * Authenticate the retained VPC-2 invocation tuple. This boundary is
   * mandatory and fail-closed while DACS-Standard #331 defines normative
   * provenance for the complementary (counterparty-owned) requirement.
   */
  verifyVetRequirementProvenance: (input: {
    invocation: Readonly<CompletedSellerVetRequirementInvocation>;
    compositeRecord: Readonly<Record<string, unknown>>;
    listingOwned: boolean;
  }) =>
    | Promise<SellerBundleVerificationDisposition>
    | SellerBundleVerificationDisposition;
  /**
   * DACS-4 DPA-3 method-native proof verification. Required when the closure
   * contains a PayloadAttestationRecord; the callback must establish that the
   * method evidence commits to the exact delivered bytes.
   */
  verifyPayloadMethodProof?: (input: {
    listingDeliverable: Readonly<Record<string, unknown>>;
    payloadAttestation: Readonly<Record<string, unknown>>;
    methodEvidence: Readonly<Record<string, unknown>> | Uint8Array;
    deliveredPayload: Uint8Array;
  }) =>
    | Promise<SellerBundleVerificationDisposition>
    | SellerBundleVerificationDisposition;
  /**
   * DACS-4 DPA-3 native-transaction authentication. Required when a resolved
   * PayloadAttestationRecord carries `methodTransactionRef`.
   */
  verifyPayloadMethodTransaction?: (input: {
    transactionRef: Readonly<{ kind: string; value: string }>;
    payloadAttestation: Readonly<Record<string, unknown>>;
  }) =>
    | Promise<SellerBundleVerificationDisposition>
    | SellerBundleVerificationDisposition;
  /**
   * DACS-4 SB-1/PC-2 recovery of the authenticated payment phase index from
   * the evidence anchor (or its substrate-equivalent binding).
   */
  resolvePaymentPhaseIndex?: (input: {
    dependency: Readonly<FinalizedSellerBundleDependency>;
    evidence: Readonly<Record<string, unknown>>;
  }) =>
    | Promise<SellerPaymentPhaseIndexResolution>
    | SellerPaymentPhaseIndexResolution;
  resolveSellerBundle: (
    logicalAddress: string,
  ) => Promise<SellerBundleLookup> | SellerBundleLookup;
  submitSellerBundle: (
    logicalAddress: string,
    bundle: Readonly<FaultAttestationBundle>,
  ) => Promise<void> | void;
  /**
   * Verify the bundle's complete SR-2 receipt proof. On a pure mapping this
   * includes logical-to-native derivation; on a write-input mapping it verifies
   * the authenticated native anchor subsequently named by BundleBinding.
   */
  verifyBundleAnchorReceipt: (
    anchored: Readonly<AnchoredSellerBundle>,
  ) =>
    | Promise<SellerBundleVerificationDisposition>
    | SellerBundleVerificationDisposition;
  /** BB-4..BB-8 resolved candidate disposition, after authorization/multiplicity handling. */
  resolveBundleBinding?: (
    logicalAddress: string,
    signer: string,
  ) => Promise<SellerBundleBindingLookup> | SellerBundleBindingLookup;
  publishBundleBinding?: (
    binding: Readonly<BundleBinding>,
  ) =>
    | Promise<SellerBundleBindingPublication>
    | SellerBundleBindingPublication;
  verifyBundleBinding?: (
    binding: Readonly<BundleBinding>,
  ) =>
    | Promise<SellerBundleVerificationDisposition>
    | SellerBundleVerificationDisposition;
}

type CompletedFulfilment = Extract<
  SellerFulfilmentResult,
  { decision: "completed" }
>;

export interface FinalizeCompletedSellerBundleInput {
  agreement: SellerFulfilmentAgreement;
  agreementRef: AttestationRef;
  fulfilment: CompletedFulfilment;
  /** Verified canonical DACS-5 §10.3 source record, still audit-pending. */
  session: AuditPendingSellerSessionRecord;
  /** Verified-candidate inventory for optional phase pointers and top-level sets. */
  sessionArtifacts: CompletedSellerSessionArtifacts;
  finalisedAt: number;
  /** Seller-local signer. No buyer key or live buyer signing oracle is accepted. */
  seller: SigningSessionParty;
  /** Buyer and, when distinct, orchestrator signatures produced out of band. */
  counterSignatures?: BundleSignature[];
  dependencies: FinalizedSellerBundleDependency[];
  /** Required only when `provider.mapping === "write-input"`. */
  bindingSigner?: BuildComponentSignatureOptions;
}

/** Transport-neutral review/sign handoff. No field here is a DACS wire field. */
export interface CompletedSellerBundleCounterSignatureRequest {
  bundleContentHash: string;
  signedScope: Record<string, unknown>;
  signedBytes: Uint8Array;
  requiredCounterSigners: string[];
}

export interface FinalizedSellerBundle {
  state: "finalised";
  logicalAddress: string;
  nativeAddress: string;
  bundleContentHash: string;
  sellerBundle: FaultAttestationBundle;
  buyerBundle: FaultAttestationBundle;
  orchestratorBundle?: FaultAttestationBundle;
  anchorReceipt: AnchorReceipt;
  anchorTx?: string;
  binding?: BundleBinding;
  resumedBundle: boolean;
  resumedBinding: boolean;
}

interface PreparedSession {
  jobId: string;
  listingRef: SellerFulfilmentAgreement["listingPin"];
  pipeline: PhaseStep[];
  agreement: SellerFulfilmentAgreement;
  agreementRef: AttestationRef;
  agreementCommitment: AttestationRef;
  phaseSummary: PhaseSummaryEntry[];
  sessionPartyVets: Array<{
    primaryClaim: string;
    bundleHash: string;
    vetRecordRef: AttestationRef;
  }>;
  vetRecords: AttestationRef[];
  vetRequirements: CompletedSellerVetRequirementInvocation[];
  settlementEvidence: AttestationRef[];
  amendments?: AttestationRef[];
  ratingRefs?: AttestationRef[];
  recipeRegistryVersion: number;
  railRegistryVersion: number;
  finalisedAt: number;
  buyer: SessionParty;
  seller: SigningSessionParty;
  /** SessionRecord orchestrator authority, including a buyer/seller acting in that role. */
  phaseOrchestratorClaim?: string;
  /** Bundle party only when the orchestrator is distinct from buyer and seller. */
  orchestrator?: SessionParty;
  counterSignatures?: BundleSignature[];
  bindingSigner?: BuildComponentSignatureOptions;
  negotiation: {
    kind:
      | "negotiate-fixed-price"
      | "negotiate-rfq"
      | "negotiate-sealed-envelope"
      | "negotiate-sealed-envelope-procurement";
    listingPublisherRole: "buyer" | "seller";
    agreementPattern: "fixed-price" | "rfq" | "sealed-envelope";
    winningBidderClaim?: string;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isHash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

const exact = (left: unknown, right: unknown): boolean =>
  canonicalize(left) === canonicalize(right);

function validUint(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function refsContain(refs: readonly AttestationRef[], candidate: AttestationRef): boolean {
  return refs.some((ref) => exact(ref, candidate));
}

function validateRefs(name: string, refs: readonly AttestationRef[]): void {
  if (!Array.isArray(refs) || refs.some((ref) => !isAttestationRef(ref))) {
    throw new DacsError(`${name} contains a non-normative AttestationRef`);
  }
  const hashes = new Set<string>();
  for (const ref of refs) {
    if (hashes.has(ref.contentHash)) {
      throw new DacsError(`${name} contains a duplicate or conflicting content hash`);
    }
    hashes.add(ref.contentHash);
  }
}

function snapshot<T>(value: T, subject: string): T {
  try {
    return structuredClone(value);
  } catch (error) {
    throw new DacsError(`${subject} cannot be snapshotted safely`, { cause: error });
  }
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isListingRef(value: unknown): value is ListingRef {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["listingId", "version", "contentHash"]) &&
    typeof value.listingId === "string" &&
    value.listingId.length > 0 &&
    Number.isSafeInteger(value.version) &&
    (value.version as number) > 0 &&
    isHash(value.contentHash)
  );
}

function isSettlementPhase(kind: string): boolean {
  return kind.startsWith("pay-") || kind.startsWith("deliver-");
}

function contextRatingRefs(entry: CompletedSellerPhaseEntry): AttestationRef[] {
  if (entry.step.kind !== "rate") return [];
  const raw = entry.contextDelta.ratingRefs;
  if (raw === undefined) {
    return entry.result.attestationRef ? [entry.result.attestationRef] : [];
  }
  if (!Array.isArray(raw) || raw.some((ref) => !isAttestationRef(ref))) {
    throw new DacsError("rate phase contextDelta.ratingRefs is not an AttestationRef array");
  }
  if (
    entry.result.attestationRef &&
    !raw.some((ref) => exact(ref, entry.result.attestationRef))
  ) {
    throw new DacsError("rate phase result points outside its canonical ratingRefs");
  }
  return snapshot(raw as AttestationRef[], "rate phase rating references");
}

const NEGOTIATION_KINDS = new Set([
  "negotiate-fixed-price",
  "negotiate-rfq",
  "negotiate-sealed-envelope",
  "negotiate-sealed-envelope-procurement",
]);

function deriveNegotiationBinding(
  session: AuditPendingSellerSessionRecord,
  agreementRef: AttestationRef,
): PreparedSession["negotiation"] {
  const entries = session.phaseResults.filter(
    (entry) => NEGOTIATION_KINDS.has(entry.step.kind),
  );
  if (entries.length !== 1 || entries[0]!.result.ok !== true) {
    throw new DacsError("completed session must carry one successful negotiation mode");
  }
  const entry = entries[0]!;
  const kind = entry.step.kind as PreparedSession["negotiation"]["kind"];
  if (!hasOnlyKeys(entry.contextDelta, [kind])) {
    throw new DacsError("successful negotiation contextDelta must carry only its executed mode");
  }
  const result = entry.contextDelta[kind];
  if (!isRecord(result)) {
    throw new DacsError("successful negotiation contextDelta is missing its mode result");
  }
  const commonValid =
    isHash(result.agreementHash) &&
    result.agreementHash === agreementRef.contentHash &&
    isAttestationRef(result.agreementRef) &&
    exact(result.agreementRef, agreementRef);
  if (!commonValid) {
    throw new DacsError("negotiation contextDelta does not bind the resolved agreement");
  }
  if (kind === "negotiate-fixed-price") {
    if (!hasOnlyKeys(result, ["agreementHash", "agreementRef"])) {
      throw new DacsError("fixed-price negotiation contextDelta is malformed");
    }
    return {
      kind,
      listingPublisherRole: "seller",
      agreementPattern: "fixed-price",
    };
  }
  if (kind === "negotiate-rfq") {
    if (
      !hasOnlyKeys(result, [
        "agreementHash",
        "agreementRef",
        "turnCount",
        "channelTranscriptRef",
      ]) ||
      !Number.isSafeInteger(result.turnCount) ||
      (result.turnCount as number) <= 0 ||
      (result.channelTranscriptRef !== undefined &&
        !isAttestationRef(result.channelTranscriptRef))
    ) {
      throw new DacsError("RFQ negotiation contextDelta is malformed");
    }
    return { kind, listingPublisherRole: "seller", agreementPattern: "rfq" };
  }
  if (
    !hasOnlyKeys(result, [
      "agreementHash",
      "agreementRef",
      "winningBidderClaim",
      "revealedBidRefs",
      "losingBidderClaims",
    ]) ||
    typeof result.winningBidderClaim !== "string" ||
    result.winningBidderClaim.length === 0 ||
    !Array.isArray(result.revealedBidRefs) ||
    result.revealedBidRefs.some((ref) => !isAttestationRef(ref)) ||
    !Array.isArray(result.losingBidderClaims) ||
    result.losingBidderClaims.some(
      (claim) => typeof claim !== "string" || claim.length === 0,
    ) ||
    new Set(result.losingBidderClaims as string[]).size !==
      result.losingBidderClaims.length ||
    (result.losingBidderClaims as string[]).includes(result.winningBidderClaim)
  ) {
    throw new DacsError("sealed-envelope negotiation contextDelta is malformed");
  }
  return {
    kind,
    listingPublisherRole:
      kind === "negotiate-sealed-envelope-procurement" ? "buyer" : "seller",
    agreementPattern: "sealed-envelope",
    winningBidderClaim: result.winningBidderClaim,
  };
}

function prepareSession(input: FinalizeCompletedSellerBundleInput): PreparedSession {
  const agreement = snapshot(input.agreement, "seller agreement");
  const fulfilment = snapshot(input.fulfilment, "seller fulfilment");
  const agreementRef = snapshot(input.agreementRef, "agreement reference");
  const session = snapshot(input.session, "DACS-5 SessionRecord");
  const sessionArtifacts = snapshot(
    input.sessionArtifacts,
    "completed-session artifact inventory",
  );
  const counterSignatures = input.counterSignatures
    ? snapshot(input.counterSignatures, "detached counter-signatures")
    : undefined;

  if (
    agreement.artifactKind !== "payee-bound" ||
    agreement.signaturesVerified !== true ||
    agreement.commitment.status !== "finalized" ||
    !isHash(agreement.contentHash) ||
    !isHash(agreement.commitment.recordContentHash) ||
    agreement.commitment.agreementHash !== agreement.contentHash ||
    !isAttestationRef(agreementRef) ||
    agreementRef.contentHash !== agreement.contentHash
  ) {
    throw new DacsError(
      "completed bundle finalization requires the exact verified payee-bound agreement and finalized commitment",
    );
  }
  if (
    !isRecord(session) ||
    !hasOnlyKeys(session, [
      "recordVersion",
      "jobId",
      "state",
      "listingRef",
      "parties",
      "pipeline",
      "phaseResults",
      "startedAt",
      "lastUpdatedAt",
      "endedAt",
      "recipeRegistryVersion",
      "railRegistryVersion",
      "amendments",
    ]) ||
    session.recordVersion !== "1" ||
    session.state !== "audit-pending" ||
    session.endedAt !== undefined ||
    session.jobId !== agreement.jobId ||
    !isListingRef(session.listingRef) ||
    !exact(session.listingRef, agreement.listingPin) ||
    !validUint(session.startedAt) ||
    !validUint(session.lastUpdatedAt) ||
    session.lastUpdatedAt < session.startedAt ||
    !validUint(session.recipeRegistryVersion) ||
    !validUint(session.railRegistryVersion) ||
    !validUint(input.finalisedAt) ||
    input.finalisedAt < session.lastUpdatedAt
  ) {
    throw new DacsError(
      "bundle facts require one exact audit-pending DACS-5 SessionRecord",
    );
  }
  if (!Array.isArray(session.parties) || !Array.isArray(session.pipeline)) {
    throw new DacsError("SessionRecord parties and pipeline must be arrays");
  }
  if (!Array.isArray(session.phaseResults) || session.phaseResults.length !== session.pipeline.length) {
    throw new DacsError("SessionRecord must retain one PhaseEntry per executed pipeline phase");
  }
  if (session.amendments !== undefined) validateRefs("SessionRecord.amendments", session.amendments);
  if (
    !isRecord(sessionArtifacts) ||
    !hasOnlyKeys(sessionArtifacts, [
      "agreementCommitment",
      "vetRecords",
      "vetRequirements",
      "settlementEvidence",
      "ratingRecords",
    ]) ||
    !isAttestationRef(sessionArtifacts.agreementCommitment) ||
    sessionArtifacts.agreementCommitment.contentHash !==
      agreement.commitment.recordContentHash ||
    !Array.isArray(sessionArtifacts.vetRecords) ||
    !Array.isArray(sessionArtifacts.vetRequirements) ||
    !Array.isArray(sessionArtifacts.settlementEvidence)
  ) {
    throw new DacsError("completed-session artifact inventory is malformed or commitment-mismatched");
  }
  validateRefs(
    "completed-session vetRecords",
    sessionArtifacts.vetRecords,
  );
  validateRefs(
    "completed-session settlementEvidence",
    sessionArtifacts.settlementEvidence,
  );
  if (sessionArtifacts.ratingRecords !== undefined) {
    validateRefs("completed-session ratingRecords", sessionArtifacts.ratingRecords);
  }

  const roles = new Set<string>();
  for (const party of session.parties) {
    if (
      !isRecord(party) ||
      !hasOnlyKeys(party, ["role", "bundleHash", "primaryClaim", "vetRecordRef"]) ||
      !["buyer", "seller", "orchestrator"].includes(String(party.role)) ||
      roles.has(String(party.role)) ||
      typeof party.primaryClaim !== "string" ||
      party.primaryClaim.length === 0 ||
      !isHash(party.bundleHash) ||
      (party.vetRecordRef !== undefined && !isAttestationRef(party.vetRecordRef))
    ) {
      throw new DacsError("SessionRecord carries an invalid or duplicate party binding");
    }
    roles.add(String(party.role));
  }
  const buyer = session.parties.find((party) => party.role === "buyer");
  const sellerRecord = session.parties.find((party) => party.role === "seller");
  const orchestrator = session.parties.find((party) => party.role === "orchestrator");
  if (
    !buyer ||
    !sellerRecord ||
    buyer.primaryClaim === sellerRecord.primaryClaim ||
    session.parties.length > 3
  ) {
    throw new DacsError("SessionRecord must identify exactly one buyer and one seller");
  }
  if (
    buyer.primaryClaim !== agreement.buyer.primaryClaim ||
    buyer.bundleHash !== agreement.buyer.bundleHash ||
    sellerRecord.primaryClaim !== agreement.seller.primaryClaim ||
    sellerRecord.bundleHash !== agreement.seller.bundleHash ||
    input.seller.primaryClaim !== sellerRecord.primaryClaim ||
    input.seller.bundleHash !== sellerRecord.bundleHash ||
    input.seller.signer === undefined
  ) {
    throw new DacsError("SessionRecord/signing parties do not match the verified agreement");
  }

  const phaseSummary: PhaseSummaryEntry[] = [];
  const sessionPartyVets: PreparedSession["sessionPartyVets"] = [];
  for (const party of session.parties) {
    if (!party.vetRecordRef) continue;
    const sameHash = sessionPartyVets.find(
      (candidate) => candidate.vetRecordRef.contentHash === party.vetRecordRef!.contentHash,
    );
    if (sameHash && !exact(sameHash.vetRecordRef, party.vetRecordRef)) {
      throw new DacsError(
        "SessionRecord parties carry conflicting vet refs for one content hash",
      );
    }
    if (!sameHash) {
      sessionPartyVets.push({
        primaryClaim: party.primaryClaim,
        bundleHash: party.bundleHash,
        vetRecordRef: snapshot(
          party.vetRecordRef,
          "SessionRecord party vet record",
        ),
      });
    } else if (
      sameHash.primaryClaim !== party.primaryClaim ||
      sameHash.bundleHash !== party.bundleHash
    ) {
      throw new DacsError("one composite vet record cannot evaluate two session parties");
    }
  }
  const vetRecords = snapshot(
    sessionArtifacts.vetRecords,
    "completed-session composite verification records",
  );
  const vetRequirements = snapshot(
    sessionArtifacts.vetRequirements,
    "completed-session Vet requirement invocations",
  );
  if (vetRequirements.length !== vetRecords.length) {
    throw new DacsError("completed session must retain one requirement invocation per Vet record");
  }
  const retainedVetHashes = new Set<string>();
  for (const invocation of vetRequirements) {
    if (
      !isRecord(invocation) ||
      !hasOnlyKeys(invocation, [
        "vetRecordRef",
        "evaluatedParty",
        "requirement",
        "verifier",
      ]) ||
      !isAttestationRef(invocation.vetRecordRef) ||
      typeof invocation.evaluatedParty !== "string" ||
      invocation.evaluatedParty.length === 0 ||
      !isBundleRequirement(invocation.requirement) ||
      typeof invocation.verifier !== "string" ||
      invocation.verifier.length === 0 ||
      !refsContain(vetRecords, invocation.vetRecordRef) ||
      retainedVetHashes.has(invocation.vetRecordRef.contentHash)
    ) {
      throw new DacsError("Vet requirement invocation inventory is malformed or not one-per-record");
    }
    retainedVetHashes.add(invocation.vetRecordRef.contentHash);
  }
  if (
    vetRecords.some(
      (recordRef) =>
        !vetRequirements.some((invocation) =>
          exact(invocation.vetRecordRef, recordRef),
        ),
    )
  ) {
    throw new DacsError("Vet requirement invocation inventory does not exactly cover Vet records");
  }
  for (const party of session.parties) {
    if (party.vetRecordRef && !refsContain(vetRecords, party.vetRecordRef)) {
      throw new DacsError(
        "SessionRecord party vet record is outside the completed-session inventory",
      );
    }
  }
  const settlementEvidence = snapshot(
    sessionArtifacts.settlementEvidence,
    "completed-session settlement evidence",
  );
  const ratingRefs = snapshot(
    sessionArtifacts.ratingRecords ?? [],
    "completed-session rating records",
  );
  for (let index = 0; index < session.pipeline.length; index++) {
    const step = session.pipeline[index];
    const entry = session.phaseResults[index];
    if (
      !isPhaseStep(step) ||
      !isRecord(entry) ||
      !hasOnlyKeys(entry, ["index", "step", "invokedAt", "result", "contextDelta"]) ||
      entry.index !== index ||
      !exact(entry.step, step) ||
      !validUint(entry.invokedAt) ||
      !isRecord(entry.result) ||
      !hasOnlyKeys(entry.result, [
        "ok",
        "reason",
        "txRefs",
        "explorerUrls",
        "contextDelta",
        "attestationRef",
        "anchorReceipt",
        "errorClass",
      ]) ||
      typeof entry.result.ok !== "boolean" ||
      (entry.result.reason !== undefined && typeof entry.result.reason !== "string") ||
      !isRecord(entry.contextDelta) ||
      (entry.result.contextDelta !== undefined &&
        !exact(entry.result.contextDelta, entry.contextDelta)) ||
      (entry.result.attestationRef !== undefined &&
        !isAttestationRef(entry.result.attestationRef)) ||
      (entry.result.anchorReceipt !== undefined &&
        !isAnchorReceipt(entry.result.anchorReceipt)) ||
      (entry.result.txRefs !== undefined &&
        (!Array.isArray(entry.result.txRefs) ||
          entry.result.txRefs.some((ref) => !isChainTxRef(ref)))) ||
      (entry.result.explorerUrls !== undefined &&
        (!Array.isArray(entry.result.explorerUrls) ||
          entry.result.explorerUrls.some((url) => typeof url !== "string"))) ||
      (entry.result.errorClass !== undefined &&
        ![
          "permanent",
          "transient",
          "counterparty",
          "substrate",
          "settlement-atomicity",
        ].includes(entry.result.errorClass))
    ) {
      throw new DacsError(`SessionRecord PhaseEntry ${index} is malformed or not pipeline-bound`);
    }
    if (!entry.result.ok && step.kind !== "rate") {
      throw new DacsError("a completed session may carry a failed/declined rate only (ST-5)");
    }
    if (entry.result.ok && entry.result.errorClass !== undefined) {
      throw new DacsError("successful PhaseHandlerResult cannot carry errorClass");
    }
    if (entry.result.ok && entry.result.reason !== undefined) {
      throw new DacsError("successful PhaseHandlerResult cannot carry a failure reason");
    }
    if (!entry.result.ok && (!entry.result.reason || entry.result.reason.length === 0)) {
      throw new DacsError("failed/declined PhaseHandlerResult must carry a reason");
    }
    if (!entry.result.ok && !entry.result.errorClass && step.kind !== "rate") {
      throw new DacsError("failed PhaseHandlerResult must carry errorClass");
    }
    const summary: PhaseSummaryEntry = {
      index,
      kind: step.kind,
      outcome: entry.result.ok ? "ok" : "fail",
      ...(entry.result.errorClass ? { errorClass: entry.result.errorClass } : {}),
      ...(entry.result.txRefs ? { txRefs: snapshot(entry.result.txRefs, `phase ${index} txRefs`) } : {}),
      ...(entry.result.attestationRef
        ? { attestationRef: snapshot(entry.result.attestationRef, `phase ${index} attestation`) }
        : {}),
    };
    phaseSummary.push(summary);

    if (step.kind === "vet-credentials") {
      if (
        entry.result.attestationRef &&
        !refsContain(vetRecords, entry.result.attestationRef)
      ) {
        throw new DacsError("Vet phase pointer is outside the canonical party vet records");
      }
    }
    if (isSettlementPhase(step.kind)) {
      if (
        entry.result.attestationRef &&
        !refsContain(settlementEvidence, entry.result.attestationRef)
      ) {
        throw new DacsError("settlement phase pointer is outside the verified-candidate inventory");
      }
    }
    const phaseRatings = contextRatingRefs(entry);
    for (const rating of phaseRatings) {
      if (!refsContain(ratingRefs, rating)) {
        throw new DacsError("rate phase pointer is outside the verified-candidate inventory");
      }
    }
  }

  const settlementPhases = phaseSummary.filter((phase) => isSettlementPhase(phase.kind));
  if (settlementEvidence.length !== settlementPhases.length) {
    throw new DacsError(
      "completed-session inventory must contain one SettlementEvidence per executed settle phase",
    );
  }
  if (!phaseSummary.some((phase) => phase.kind === "rate") && ratingRefs.length > 0) {
    throw new DacsError("RatingRecords cannot be included when the rate phase did not run");
  }

  const commits = phaseSummary.filter(
    (phase) =>
      phase.outcome === "ok" &&
      (phase.kind === "commit-agreement" ||
        phase.kind === "commit-payee-bound-agreement"),
  );
  if (
    commits.length !== 1 ||
    commits[0]!.kind !== "commit-payee-bound-agreement" ||
    (commits[0]!.attestationRef !== undefined &&
      !exact(commits[0]!.attestationRef, sessionArtifacts.agreementCommitment))
  ) {
    throw new DacsError("completed bundle must derive the exact finalized DACS-3 commitment");
  }

  const negotiation = deriveNegotiationBinding(session, agreementRef);
  const contribution = fulfilment.bundleContribution.phaseSummary;
  const derivedDelivery = phaseSummary[contribution.index];
  if (
    !isSettlementEvidence(fulfilment.evidence) ||
    !isHash(fulfilment.evidenceHash) ||
    contentHash(fulfilment.evidence as unknown as Record<string, unknown>) !==
      fulfilment.evidenceHash ||
    fulfilment.evidence.jobId !== agreement.jobId ||
    fulfilment.evidence.outcome !== "success" ||
    !isAttestationRef(fulfilment.evidenceRef) ||
    fulfilment.evidenceRef.contentHash !== fulfilment.evidenceHash ||
    !exact(fulfilment.bundleContribution.settlementEvidence, fulfilment.evidenceRef) ||
    !derivedDelivery ||
    derivedDelivery.index !== contribution.index ||
    derivedDelivery.kind !== contribution.kind ||
    derivedDelivery.outcome !== contribution.outcome ||
    derivedDelivery.errorClass !== contribution.errorClass ||
    (derivedDelivery.attestationRef !== undefined &&
      !exact(derivedDelivery.attestationRef, fulfilment.evidenceRef)) ||
    !refsContain(settlementEvidence, fulfilment.evidenceRef)
  ) {
    throw new DacsError(
      "seller fulfilment is not the exact delivery PhaseEntry in the canonical SessionRecord",
    );
  }

  return {
    jobId: agreement.jobId,
    listingRef: snapshot(session.listingRef, "listing pin"),
    pipeline: snapshot(session.pipeline, "session pipeline"),
    agreement,
    agreementRef,
    agreementCommitment: snapshot(
      sessionArtifacts.agreementCommitment,
      "agreement commitment reference",
    ),
    phaseSummary,
    sessionPartyVets,
    vetRecords,
    vetRequirements,
    settlementEvidence,
    ...(session.amendments ? { amendments: snapshot(session.amendments, "amendments") } : {}),
    ...(ratingRefs.length > 0 ? { ratingRefs } : {}),
    recipeRegistryVersion: session.recipeRegistryVersion,
    railRegistryVersion: session.railRegistryVersion,
    finalisedAt: input.finalisedAt,
    buyer: {
      primaryClaim: buyer.primaryClaim,
      bundleHash: buyer.bundleHash,
    },
    seller: {
      primaryClaim: input.seller.primaryClaim,
      bundleHash: input.seller.bundleHash,
      signer: input.seller.signer,
    },
    ...(orchestrator
      ? { phaseOrchestratorClaim: orchestrator.primaryClaim }
      : {}),
    ...(orchestrator &&
      orchestrator.primaryClaim !== buyer.primaryClaim &&
      orchestrator.primaryClaim !== sellerRecord.primaryClaim
      ? {
          orchestrator: {
            primaryClaim: orchestrator.primaryClaim,
            bundleHash: orchestrator.bundleHash,
          },
        }
      : {}),
    ...(counterSignatures ? { counterSignatures } : {}),
    ...(input.bindingSigner
      ? {
          bindingSigner: {
            algorithm: input.bindingSigner.algorithm,
            signer: input.bindingSigner.signer,
            sign: input.bindingSigner.sign,
          },
        }
      : {}),
    negotiation,
  };
}

function dependencySourceId(source: SellerBundleDependencySource): string {
  if (
    source.kind === "attestation-ref" &&
    (source.encoding === undefined || source.encoding === "artifact")
  ) {
    return canonicalize({ kind: "attestation-ref", ref: source.ref });
  }
  return canonicalize(source);
}

function sourceHash(source: SellerBundleDependencySource): string {
  if (source.kind === "listing") return source.listingRef.contentHash;
  if (source.kind === "attestation-ref") return source.ref.contentHash;
  return source.contentHash;
}

function sourceEncoding(source: SellerBundleDependencySource): "artifact" | "jcs" | "bytes" {
  if (source.kind === "deliverable") return source.encoding;
  if (source.kind === "attestation-ref") return source.encoding ?? "artifact";
  return "artifact";
}

function refSource(
  ref: AttestationRef,
  encoding: "artifact" | "jcs" | "bytes" = "artifact",
): SellerBundleDependencySource {
  return {
    kind: "attestation-ref",
    ref: snapshot(ref, "dependency AttestationRef"),
    ...(encoding === "artifact" ? {} : { encoding }),
  };
}

function requirementMap(
  session: PreparedSession,
): Map<string, SellerBundleDependencyRequirement> {
  const requirements = new Map<string, SellerBundleDependencyRequirement>();
  const add = (
    kind: SellerBundleDependencyKind,
    source: SellerBundleDependencySource,
  ): void => {
    const id = dependencySourceId(source);
    const current = requirements.get(id);
    if (current) {
      if (!current.kinds.includes(kind)) current.kinds.push(kind);
      return;
    }
    requirements.set(id, {
      id,
      contentHash: sourceHash(source),
      encoding: sourceEncoding(source),
      kinds: [kind],
      refs: source.kind === "attestation-ref" ? [source.ref] : [],
      source,
    });
  };

  add("listing", { kind: "listing", listingRef: session.listingRef });
  add("agreement", refSource(session.agreementRef));
  add("agreement-commitment", refSource(session.agreementCommitment));
  for (const phase of session.phaseSummary) {
    if (!phase.attestationRef) continue;
    const source = refSource(phase.attestationRef);
    add("phase-attestation", source);
  }
  for (const ref of session.vetRecords) add("vet-record", refSource(ref));
  for (const ref of session.settlementEvidence) {
    add("settlement-evidence", refSource(ref));
  }
  for (const ref of session.amendments ?? []) add("amendment", refSource(ref));
  for (const ref of session.ratingRefs ?? []) add("rating", refSource(ref));
  return requirements;
}

function dispositionFailure(
  subject: string,
  disposition: SellerBundleVerificationDisposition,
): never {
  if (disposition === "indeterminate" || disposition === "error") {
    throw new SubstrateError(`${subject} is not established (${disposition})`);
  }
  throw new DacsError(`${subject} is invalid`);
}

async function verifiedDisposition(
  subject: string,
  operation: () =>
    | Promise<SellerBundleVerificationDisposition>
    | SellerBundleVerificationDisposition,
): Promise<void> {
  let disposition: SellerBundleVerificationDisposition;
  try {
    disposition = await operation();
  } catch (error) {
    throw new SubstrateError(`${subject} verification errored`, { cause: error });
  }
  if (disposition !== "valid") dispositionFailure(subject, disposition);
}

function isDependencySource(value: unknown): value is SellerBundleDependencySource {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "listing") {
    return hasOnlyKeys(value, ["kind", "listingRef"]) && isListingRef(value.listingRef);
  }
  if (value.kind === "attestation-ref") {
    return (
      hasOnlyKeys(value, ["kind", "ref", "encoding"]) &&
      isAttestationRef(value.ref) &&
      (value.encoding === undefined ||
        value.encoding === "artifact" ||
        value.encoding === "jcs" ||
        value.encoding === "bytes")
    );
  }
  return (
    value.kind === "deliverable" &&
    hasOnlyKeys(value, ["kind", "anchor", "contentHash", "encoding"]) &&
    isRecord(value.anchor) &&
    hasOnlyKeys(value.anchor, ["kind", "locator"]) &&
    typeof value.anchor.kind === "string" &&
    value.anchor.kind.length > 0 &&
    typeof value.anchor.locator === "string" &&
    value.anchor.locator.length > 0 &&
    isHash(value.contentHash) &&
    (value.encoding === "jcs" || value.encoding === "bytes")
  );
}

function isPayloadAttestationRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return (
    value.payloadAttestationVersion === "1" &&
    value.resultVersion === undefined &&
    value.evidenceVersion === undefined &&
    typeof value.jobId === "string" &&
    isHash(value.agreementHash) &&
    isHash(value.deliverableSpecHash) &&
    typeof value.payloadFormat === "string" &&
    value.payloadFormat.length > 0 &&
    isHash(value.payloadContentHash) &&
    typeof value.verificationMethod === "string" &&
    value.verificationMethod.length > 0 &&
    isHash(value.verificationMethodHash) &&
    validUint(value.attempt) &&
    ["pass", "fail", "indeterminate", "error"].includes(String(value.decision)) &&
    typeof value.reason === "string" &&
    value.reason.length > 0 &&
    (value.methodEvidenceRef === undefined || isAttestationRef(value.methodEvidenceRef)) &&
    (value.methodTransactionRef === undefined ||
      (isRecord(value.methodTransactionRef) &&
        hasOnlyKeys(value.methodTransactionRef, ["kind", "value"]) &&
        typeof value.methodTransactionRef.kind === "string" &&
        value.methodTransactionRef.kind.length > 0 &&
        typeof value.methodTransactionRef.value === "string" &&
        value.methodTransactionRef.value.length > 0)) &&
    validUint(value.verifiedAt) &&
    isComponentSignature(value.signature)
  );
}

function isVerifyResultRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return (
    value.resultVersion === "1" &&
    typeof value.scheme === "string" &&
    value.scheme.length > 0 &&
    typeof value.identifier === "string" &&
    value.identifier.length > 0 &&
    Number.isSafeInteger(value.recipeVersion) &&
    (value.recipeVersion as number) > 0 &&
    typeof value.method === "string" &&
    value.method.length > 0 &&
    ["pass", "fail", "indeterminate", "error"].includes(String(value.decision)) &&
    typeof value.reason === "string" &&
    value.reason.length > 0 &&
    isAttestationRef(value.attestation) &&
    (value.data === undefined || isRecord(value.data)) &&
    validUint(value.fetchedAt) &&
    validUint(value.verifiedAt) &&
    (value.validUntil === undefined || validUint(value.validUntil)) &&
    isComponentSignature(value.signature)
  );
}

function isVerifyResultRef(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["anchor", "contentHash", "recipeVersion"]) &&
    isAttestationRef({ anchor: value.anchor, contentHash: value.contentHash }) &&
    Number.isSafeInteger(value.recipeVersion) &&
    (value.recipeVersion as number) > 0
  );
}

/** Current DACS-2 §7.7 wire shape; the repository-wide legacy guard is not used. */
function isNormativeCompositeVerificationRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const verifyRefs = (candidate: unknown): boolean =>
    Array.isArray(candidate) && candidate.every(isVerifyResultRef);
  const supplementary =
    Array.isArray(value.supplementary) &&
    value.supplementary.every(
      (signal) =>
        isRecord(signal) &&
        typeof signal.source === "string" &&
        signal.source.length > 0 &&
        typeof signal.signalType === "string" &&
        signal.signalType.length > 0 &&
        ((typeof signal.value === "number" && Number.isFinite(signal.value)) ||
          typeof signal.value === "string") &&
        validUint(signal.observedAt) &&
        (signal.attestation === undefined || isAttestationRef(signal.attestation)) &&
        (signal.source !== "external" || isAttestationRef(signal.attestation)),
    );
  const warnings =
    value.warnings === undefined ||
    (Array.isArray(value.warnings) &&
      value.warnings.every(
        (warning) =>
          isRecord(warning) &&
          typeof warning.claimRef === "string" &&
          warning.claimRef.length > 0 &&
          typeof warning.code === "string" &&
          warning.code.length > 0 &&
          typeof warning.retryable === "boolean" &&
          (warning.suggestedRetryAfterMs === undefined ||
            validUint(warning.suggestedRetryAfterMs)),
      ));
  return (
    value.recordVersion === "1" &&
    typeof value.jobId === "string" &&
    value.jobId.length > 0 &&
    typeof value.evaluatedParty === "string" &&
    value.evaluatedParty.length > 0 &&
    isHash(value.bundleHash) &&
    isHash(value.requirementHash) &&
    verifyRefs(value.freshness) &&
    supplementary &&
    verifyRefs(value.dealSpecific) &&
    ["pass", "fail", "indeterminate", "error"].includes(
      String(value.overallDecision),
    ) &&
    warnings &&
    validUint(value.generatedAt) &&
    isComponentSignature(value.signature)
  );
}

function identityBundleHash(value: unknown): string {
  if (!isRecord(value) || !("presentation" in value)) {
    throw new DacsError("Listing seller IdentityBundle is malformed");
  }
  const { presentation: _presentation, ...signedScope } = value;
  return sha256Hex(canonicalize(signedScope));
}

function isCanonicalPositiveDecimal(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/.test(value) &&
    !/^0(?:\.0*)?$/.test(value)
  );
}

function isSettlementAmendment(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (
    value.amendmentVersion !== "1" ||
    typeof value.jobId !== "string" ||
    value.jobId.length === 0 ||
    !isAttestationRef(value.amendsEvidenceRef) ||
    !["refund", "partial-refund", "correction"].includes(String(value.amendmentType)) ||
    typeof value.reason !== "string" ||
    value.reason.length === 0 ||
    !validUint(value.observedAt) ||
    !isComponentSignature(value.signature) ||
    (value.refundTxRefs !== undefined &&
      (!Array.isArray(value.refundTxRefs) ||
        value.refundTxRefs.some((ref) => !isChainTxRef(ref))))
  ) {
    return false;
  }
  if (value.amendmentType === "correction") return value.refundAmount === undefined;
  return (
    isRecord(value.refundAmount) &&
    hasOnlyKeys(value.refundAmount, ["amount", "currency"]) &&
    isCanonicalPositiveDecimal(value.refundAmount.amount) &&
    typeof value.refundAmount.currency === "string" &&
    value.refundAmount.currency.length > 0
  );
}

function isRatingRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return (
    value.ratingVersion === "1" &&
    typeof value.jobId === "string" &&
    value.jobId.length > 0 &&
    typeof value.rater === "string" &&
    value.rater.length > 0 &&
    typeof value.target === "string" &&
    value.target.length > 0 &&
    (value.targetRole === "buyer" || value.targetRole === "seller") &&
    Number.isInteger(value.value) &&
    (value.value as number) >= 1 &&
    (value.value as number) <= 5 &&
    (value.freeText === undefined ||
      (typeof value.freeText === "string" && value.freeText.length <= 1_000)) &&
    (value.dimensions === undefined ||
      (isRecord(value.dimensions) &&
        Object.values(value.dimensions).every((score) => typeof score === "number" && Number.isFinite(score)))) &&
    validUint(value.ratedAt) &&
    isComponentSignature(value.signature) &&
    (value.signature as ComponentSignature).signer === value.rater
  );
}

function decimalParts(value: string): { coefficient: bigint; scale: number } {
  const [whole, fraction = ""] = value.split(".");
  return {
    coefficient: BigInt(`${whole}${fraction}`),
    scale: fraction.length,
  };
}

function refundTotalWithin(
  amounts: readonly string[],
  maximum: string,
): boolean {
  const values = [...amounts, maximum].map(decimalParts);
  const scale = Math.max(...values.map((value) => value.scale));
  const scaled = values.map(
    (value) => value.coefficient * 10n ** BigInt(scale - value.scale),
  );
  const bound = scaled.pop()!;
  return scaled.reduce((sum, value) => sum + value, 0n) <= bound;
}

type ResolvedDependencyContent =
  | { encoding: "artifact" | "jcs"; artifact: Record<string, unknown> }
  | { encoding: "bytes"; bytes: Uint8Array };

function resolvedArtifact(
  source: SellerBundleDependencySource,
  resolved: ReadonlyMap<string, ResolvedDependencyContent>,
  subject: string,
): Record<string, unknown> {
  const value = resolved.get(dependencySourceId(source));
  if (!value || value.encoding === "bytes") {
    throw new DacsError(`${subject} did not resolve to a JSON artifact`);
  }
  return value.artifact;
}

function requirementRefsByKind(
  requirements: ReadonlyMap<string, SellerBundleDependencyRequirement>,
  kind: SellerBundleDependencyKind,
): AttestationRef[] {
  return [...requirements.values()]
    .filter((requirement) => requirement.kinds.includes(kind))
    .flatMap((requirement) => requirement.refs);
}

function roleParty(
  session: PreparedSession,
  role: "buyer" | "seller" | "orchestrator",
): SessionParty | undefined {
  if (role === "buyer") return session.buyer;
  if (role === "seller") return session.seller;
  return session.orchestrator;
}

type VetDecision = "pass" | "fail" | "indeterminate" | "error";

/** Exact DACS-2 §7.7.1 aggregation over the resolved current VerifyResults. */
function aggregateVetDecision(
  requirement: BundleRequirement,
  results: readonly Record<string, unknown>[],
): VetDecision {
  const decisionsFor = (scheme: string): VetDecision[] =>
    results
      .filter((result) => result.scheme === scheme)
      .map((result) => result.decision as VetDecision);
  let hasFailure = false;
  let hasError = false;
  let hasIndeterminate = false;
  for (const claim of requirement.required) {
    const decisions = decisionsFor(claim.scheme);
    if (decisions.includes("pass")) continue;
    if (decisions.length === 0 || decisions.includes("fail")) {
      hasFailure = true;
    } else if (decisions.includes("error")) {
      hasError = true;
    } else {
      hasIndeterminate = true;
    }
  }
  for (const group of requirement.oneOf ?? []) {
    const decisions = group.flatMap((claim) => decisionsFor(claim.scheme));
    if (decisions.includes("pass")) continue;
    // Within an OR group, a retryable error outranks an indeterminate, and a
    // hard failure is conclusive only when no member could still pass.
    if (decisions.includes("error")) {
      hasError = true;
    } else if (decisions.includes("indeterminate")) {
      hasIndeterminate = true;
    } else {
      hasFailure = true;
    }
  }
  if (hasFailure) return "fail";
  if (hasError) return "error";
  if (hasIndeterminate) return "indeterminate";
  return "pass";
}

type AuthenticatedPaymentBinding = Extract<
  SellerPaymentPhaseIndexResolution,
  { disposition: "valid" }
>;

async function resolveAuthenticatedPaymentBinding(
  session: PreparedSession,
  ref: AttestationRef,
  evidence: Readonly<Record<string, unknown>>,
  dependencies: ReadonlyMap<string, FinalizedSellerBundleDependency>,
  provider: SellerBundleFinalizationProvider,
): Promise<AuthenticatedPaymentBinding> {
  if (!provider.resolvePaymentPhaseIndex) {
    throw new DacsError("payment evidence phase binding resolver is unavailable (SB-1/PC-2)");
  }
  const dependency = dependencies.get(dependencySourceId(refSource(ref)));
  if (!dependency) {
    throw new DacsError("payment evidence dependency is absent from the verified closure");
  }
  let binding: SellerPaymentPhaseIndexResolution;
  try {
    binding = snapshot(
      await provider.resolvePaymentPhaseIndex({
        dependency: snapshot(dependency, "payment phase binding dependency"),
        evidence: snapshot(evidence, "payment phase binding evidence"),
      }),
      "payment phase binding result",
    );
  } catch (error) {
    throw new SubstrateError("payment phase binding resolution errored", { cause: error });
  }
  const validShape =
    isRecord(binding) &&
    ["valid", "invalid", "indeterminate", "error"].includes(
      String(binding.disposition),
    ) &&
    (binding.disposition === "valid"
      ? hasOnlyKeys(binding, [
          "disposition",
          "jobId",
          "railId",
          "phaseIndex",
          "resolved",
        ]) &&
        typeof binding.jobId === "string" &&
        binding.jobId.length > 0 &&
        typeof binding.railId === "string" &&
        binding.railId.length > 0 &&
        validUint(binding.phaseIndex) &&
        typeof binding.resolved === "boolean"
      : hasOnlyKeys(binding, ["disposition", "reason"]) &&
        typeof binding.reason === "string" &&
        binding.reason.length > 0);
  if (!validShape) {
    throw new SubstrateError("payment phase binding resolver returned an invalid disposition");
  }
  if (binding.disposition !== "valid") {
    dispositionFailure("payment phase binding", binding.disposition);
  }
  const step = session.pipeline[binding.phaseIndex];
  const railId = isRecord(step?.parameters) ? step.parameters.rail : undefined;
  if (
    !step ||
    !step.kind.startsWith("pay-") ||
    step.kind !== evidence.phase ||
    binding.jobId !== session.jobId ||
    binding.jobId !== evidence.jobId ||
    typeof railId !== "string" ||
    binding.railId !== railId ||
    binding.resolved !== (evidence.supersedesEvidenceRef !== undefined)
  ) {
    throw new DacsError(
      "payment evidence contradicts its authenticated job/rail/phase/resolved binding",
    );
  }
  return binding;
}

async function auditResolvedDependencyGraph(
  session: PreparedSession,
  requirements: ReadonlyMap<string, SellerBundleDependencyRequirement>,
  resolved: ReadonlyMap<string, ResolvedDependencyContent>,
  dependencies: ReadonlyMap<string, FinalizedSellerBundleDependency>,
  provider: SellerBundleFinalizationProvider,
): Promise<void> {
  const listing = resolvedArtifact(
    { kind: "listing", listingRef: session.listingRef },
    resolved,
    "signed listing",
  );
  if (!isListing(listing)) {
    throw new DacsError("resolved listing is not a normative signed DACS-1 Listing");
  }
  const listingPublisher = roleParty(
    session,
    session.negotiation.listingPublisherRole,
  );
  if (!listingPublisher) {
    throw new DacsError("negotiation mode does not resolve one agreement listing publisher");
  }
  const publishedIdentityHash = identityBundleHash(listing.seller.identity);
  if (
    listing.listingId !== session.listingRef.listingId ||
    listing.listingVersion !== session.listingRef.version ||
    listing.seller.identity.presentedBy !== listingPublisher.primaryClaim ||
    !exact(listing.pipeline, session.pipeline) ||
    !isDeliverableSpec(listing.offering.deliverable) ||
    sha256Hex(
      canonicalize(listing.offering.deliverable as unknown as Record<string, unknown>),
    ) !==
      session.agreement.deliverableRef.hash ||
    listing.offering.deliverable.kind !== session.agreement.deliverableRef.deliverableType
  ) {
    throw new DacsError("resolved listing does not bind the canonical negotiation/session");
  }
  await verifiedDisposition("Listing/session IdentityBundle claim and key linkage", () =>
    provider.verifyListingPublisherIdentityLinkage({
      listingIdentity: snapshot(
        listing.seller.identity,
        "published Listing IdentityBundle linkage input",
      ),
      listingBundleHash: publishedIdentityHash,
      sessionBundleHash: listingPublisher.bundleHash,
      primaryClaim: listingPublisher.primaryClaim,
    }),
  );
  const listingReceipt = dependencies.get(
    dependencySourceId({ kind: "listing", listingRef: session.listingRef }),
  )?.anchorReceipt;
  if (
    !listingReceipt ||
    listingReceipt.logicalAddress !==
      listingAddress(
        listingPublisher.primaryClaim,
        session.listingRef.listingId,
        session.listingRef.version,
      )
  ) {
    throw new DacsError("signed Listing receipt is bound to a different logical address");
  }
  for (const claim of listing.seller.identity.claims) {
    if (!claim.verifiedBy) continue;
    const resultRef: AttestationRef = {
      anchor: claim.verifiedBy.anchor,
      contentHash: claim.verifiedBy.contentHash,
    };
    const result = resolvedArtifact(refSource(resultRef), resolved, "VerifyResult");
    const separator = claim.ref.indexOf(":");
    if (
      separator <= 0 ||
      !isVerifyResultRecord(result) ||
      result.scheme !== claim.ref.slice(0, separator) ||
      result.identifier !== claim.ref.slice(separator + 1) ||
      result.recipeVersion !== claim.verifiedBy.recipeVersion
    ) {
      throw new DacsError("Listing IdentityBundle carries an invalid VerifyResult reference");
    }
    const proof = resolved.get(
      [...requirements.values()].find(
        (requirement) =>
          requirement.kinds.includes("verification-attestation") &&
          requirement.refs.some((ref) => exact(ref, result.attestation)),
      )?.id ?? "",
    );
    if (!proof) {
      throw new DacsError("VerifyResult authority attestation is absent from the recursive closure");
    }
  }

  const agreement = resolvedArtifact(
    refSource(session.agreementRef),
    resolved,
    "committed agreement",
  );
  if (
    !isAgreementArtifact(agreement) ||
    agreement.payeeBoundAgreementVersion !== "1" ||
    agreement.jobId !== session.jobId ||
    !exact(agreement.listingRef, session.listingRef) ||
    !exact(agreement.terms.deliverable, session.agreement.deliverableRef) ||
    new Set(agreement.parties.map((party) => party.primaryClaim)).size !==
      agreement.parties.length ||
    agreement.derivedFromPattern !== session.negotiation.agreementPattern
  ) {
    throw new DacsError("resolved agreement is not the exact payee-bound session agreement");
  }
  const expectedWinnerRole =
    session.negotiation.kind === "negotiate-sealed-envelope-procurement"
      ? "seller"
      : session.negotiation.kind === "negotiate-sealed-envelope"
        ? "buyer"
        : undefined;
  if (expectedWinnerRole) {
    const winner = agreement.parties.find((party) => party.role === expectedWinnerRole);
    if (
      !winner ||
      winner.primaryClaim !== session.negotiation.winningBidderClaim ||
      listingPublisher.primaryClaim === winner.primaryClaim
    ) {
      throw new DacsError("sealed-envelope winner/role binding contradicts negotiation context");
    }
  } else if (session.negotiation.winningBidderClaim !== undefined) {
    throw new DacsError("non-sealed negotiation cannot carry a winning bidder claim");
  }
  for (const role of ["buyer", "seller"] as const) {
    const expected = roleParty(session, role)!;
    const party = agreement.parties.find((candidate) => candidate.role === role);
    if (
      !party ||
      party.primaryClaim !== expected.primaryClaim ||
      party.bundleHash !== expected.bundleHash ||
      !refsContain(session.vetRecords, party.vetRecordRef)
    ) {
      throw new DacsError(`agreement ${role} is not bound to the canonical party/vet record`);
    }
  }
  const agreementVetRefs = agreement.parties.map((party) => party.vetRecordRef);
  const allowedVetRefs: AttestationRef[] = [];
  for (const ref of [
    ...agreementVetRefs,
    ...session.sessionPartyVets.map((party) => party.vetRecordRef),
  ]) {
    const sameHash = allowedVetRefs.find(
      (candidate) => candidate.contentHash === ref.contentHash,
    );
    if (sameHash && !exact(sameHash, ref)) {
      throw new DacsError("agreement/session parties carry conflicting vet references");
    }
    if (!sameHash) allowedVetRefs.push(ref);
  }
  if (
    allowedVetRefs.length !== session.vetRecords.length ||
    allowedVetRefs.some((ref) => !refsContain(session.vetRecords, ref))
  ) {
    throw new DacsError("bundle vetRecords do not exactly cover the agreement/session parties");
  }
  const agreementSigners = agreement.signatures.map((signature) => signature.party);
  const agreementParties = new Map(
    agreement.parties.map((party) => [party.primaryClaim, party.role] as const),
  );
  if (
    new Set(agreementSigners).size !== agreementSigners.length ||
    !agreementSigners.includes(session.buyer.primaryClaim) ||
    !agreementSigners.includes(session.seller.primaryClaim) ||
    agreementSigners.some((claim) => !agreementParties.has(claim)) ||
    (agreement.derivedFromPattern !== "sealed-envelope" &&
      agreementSigners.length !== 2) ||
    (agreement.derivedFromPattern === "sealed-envelope" &&
      agreementSigners.some(
        (claim) =>
          claim !== session.buyer.primaryClaim &&
          claim !== session.seller.primaryClaim &&
          agreementParties.get(claim) !== "bidder-non-winning",
      ))
  ) {
    throw new DacsError("payee-bound agreement carries an unauthorized or incomplete signer set");
  }

  const commitmentRequirements = [...requirements.values()].filter((requirement) =>
    requirement.kinds.includes("agreement-commitment"),
  );
  if (commitmentRequirements.length !== 1) {
    throw new DacsError("session must have exactly one agreement commitment dependency");
  }
  const commitmentRequirement = commitmentRequirements[0]!;
  const commitment = resolvedArtifact(
    commitmentRequirement.source,
    resolved,
    "agreement commitment",
  );
  const commitmentReceipt = dependencies.get(commitmentRequirement.id)?.anchorReceipt;
  if (
    !isAgreementCommitmentRecord(commitment) ||
    commitment.finalityCommitmentVersion !== "1" ||
    commitment.jobId !== session.jobId ||
    commitment.agreementHash !== session.agreementRef.contentHash ||
    !exact(commitment.listingRef, session.listingRef) ||
    commitment.pattern !== agreement.derivedFromPattern ||
    new Set(commitment.parties).size !== commitment.parties.length ||
    commitment.parties.length !== agreementSigners.length ||
    agreementSigners.some((claim) => !commitment.parties.includes(claim)) ||
    !isComponentSignature(commitment.signature) ||
    ![
      session.buyer.primaryClaim,
      session.seller.primaryClaim,
      session.phaseOrchestratorClaim,
    ]
      .filter((claim): claim is string => typeof claim === "string")
      .includes(commitment.signature.signer) ||
    (session.phaseOrchestratorClaim !== undefined &&
      commitment.signature.signer !== session.phaseOrchestratorClaim) ||
    !validUint(commitment.createdAt) ||
    commitment.createdAt < agreement.generatedAt ||
    commitmentReceipt?.blockRef?.timestamp === undefined ||
    commitment.createdAt > commitmentReceipt.blockRef.timestamp ||
    commitmentReceipt?.blockRef?.timestamp !== session.agreement.commitment.finalizedAt
  ) {
    throw new DacsError("agreement commitment fails CA-3/CA-7/CA-8 session binding");
  }

  const partyClaims = new Map<string, "buyer" | "seller" | "orchestrator">([
    [session.buyer.primaryClaim, "buyer"],
    [session.seller.primaryClaim, "seller"],
    ...(session.orchestrator
      ? ([[session.orchestrator.primaryClaim, "orchestrator"]] as const)
      : []),
  ]);
  const phaseOrchestrator = commitment.signature.signer;
  const expectedVetParties = [
    ...agreement.parties.map((party) => ({
      primaryClaim: party.primaryClaim,
      bundleHash: party.bundleHash,
      vetRecordRef: party.vetRecordRef,
    })),
    ...session.sessionPartyVets,
  ];
  for (const ref of session.vetRecords) {
    const record = resolvedArtifact(refSource(ref), resolved, "CompositeVerificationRecord");
    const expected = expectedVetParties.filter((party) =>
      exact(party.vetRecordRef, ref),
    );
    const invocation = session.vetRequirements.find((candidate) =>
      exact(candidate.vetRecordRef, ref),
    );
    const agreementParty = expected[0]
      ? agreement.parties.find(
          (party) => party.primaryClaim === expected[0]!.primaryClaim,
        )
      : undefined;
    const listingOwned = agreementParty
      ? session.negotiation.kind === "negotiate-sealed-envelope-procurement"
        ? agreementParty.role === "seller" || agreementParty.role === "bidder-non-winning"
        : agreementParty.role === "buyer" || agreementParty.role === "bidder-non-winning"
      : false;
    const requirementHash = invocation
      ? sha256Hex(
          canonicalize(
            invocation.requirement as unknown as Record<string, unknown>,
          ),
        )
      : "";
    if (
      expected.length === 0 ||
      expected.some(
        (party) =>
          party.primaryClaim !== expected[0]!.primaryClaim ||
          party.bundleHash !== expected[0]!.bundleHash,
      ) ||
      !invocation ||
      !isNormativeCompositeVerificationRecord(record) ||
      record.jobId !== session.jobId ||
      record.evaluatedParty !== expected[0]!.primaryClaim ||
      invocation.evaluatedParty !== record.evaluatedParty ||
      record.bundleHash !== expected[0]!.bundleHash ||
      record.requirementHash !== requirementHash ||
      (record.signature as ComponentSignature).signer !== invocation.verifier ||
      (record.signature as ComponentSignature).signer !== phaseOrchestrator ||
      (record.generatedAt as number) > session.finalisedAt ||
      (listingOwned && !exact(invocation.requirement, listing.buyerRequirement))
    ) {
      throw new DacsError("completed session carries an invalid Vet record/requirement invocation");
    }
    await verifiedDisposition("Vet requirement invocation provenance", () =>
      provider.verifyVetRequirementProvenance({
        invocation: snapshot(invocation, "Vet requirement provenance input"),
        compositeRecord: snapshot(record, "Vet composite provenance input"),
        listingOwned,
      }),
    );
    const resolvedVetResults: Record<string, unknown>[] = [];
    const seenResultHashes = new Set<string>();
    for (const resultRef of [
      ...(record.freshness as Record<string, unknown>[]),
      ...(record.dealSpecific as Record<string, unknown>[]),
    ]) {
      const attestationRef: AttestationRef = {
        anchor: resultRef.anchor as AttestationRef["anchor"],
        contentHash: resultRef.contentHash as string,
      };
      const result = resolvedArtifact(
        refSource(attestationRef),
        resolved,
        "CompositeVerificationRecord VerifyResult",
      );
      const resultHash = resultRef.contentHash as string;
      const proofRequirement = [...requirements.values()].find(
        (candidate) =>
          candidate.kinds.includes("verification-attestation") &&
          isVerifyResultRecord(result) &&
          candidate.refs.some((candidateRef) =>
            exact(candidateRef, result.attestation),
          ),
      );
      if (
        !isVerifyResultRecord(result) ||
        seenResultHashes.has(resultHash) ||
        result.recipeVersion !== resultRef.recipeVersion ||
        !proofRequirement ||
        !resolved.has(proofRequirement.id)
      ) {
        throw new DacsError(
          "CompositeVerificationRecord does not close its VerifyResult authority chain",
        );
      }
      seenResultHashes.add(resultHash);
      resolvedVetResults.push(result);
    }
    const recomputedDecision = aggregateVetDecision(
      invocation.requirement,
      resolvedVetResults,
    );
    if (
      record.overallDecision !== recomputedDecision ||
      recomputedDecision !== "pass"
    ) {
      throw new DacsError(
        "CompositeVerificationRecord overallDecision does not match DACS-2 aggregation",
      );
    }
  }

  const settlementByRef = new Map<string, Record<string, unknown>>();
  const paymentBindingByRef = new Map<string, AuthenticatedPaymentBinding>();
  const unmatchedSettlementPhases = new Set(
    session.phaseSummary
      .filter((phase) => isSettlementPhase(phase.kind))
      .map((phase) => phase.index),
  );
  let previousSettlementPhaseIndex = -1;
  for (const ref of session.settlementEvidence) {
    const evidence = resolvedArtifact(refSource(ref), resolved, "SettlementEvidence");
    if (!isSettlementEvidence(evidence) || evidence.jobId !== session.jobId) {
      throw new DacsError("settlement evidence is malformed or cross-session");
    }
    let phase: PhaseSummaryEntry | undefined;
    if (evidence.phase.startsWith("pay-")) {
      const binding = await resolveAuthenticatedPaymentBinding(
        session,
        ref,
        evidence,
        dependencies,
        provider,
      );
      paymentBindingByRef.set(dependencySourceId(refSource(ref)), binding);
      phase = session.phaseSummary[binding.phaseIndex];
      if (
        !phase ||
        !unmatchedSettlementPhases.has(binding.phaseIndex) ||
        (phase.attestationRef !== undefined && !exact(phase.attestationRef, ref))
      ) {
        throw new DacsError("payment evidence reuses or contradicts its authenticated phase index");
      }
    } else {
      const pointedPhase = session.phaseSummary.find(
        (candidate) =>
          unmatchedSettlementPhases.has(candidate.index) &&
          candidate.attestationRef !== undefined &&
          exact(candidate.attestationRef, ref),
      );
      if (pointedPhase) {
        phase = pointedPhase;
      } else {
        const candidates = session.phaseSummary.filter(
          (candidate) =>
            unmatchedSettlementPhases.has(candidate.index) &&
            candidate.attestationRef === undefined &&
            candidate.kind === evidence.phase &&
            candidate.outcome === (evidence.outcome === "success" ? "ok" : "fail"),
        );
        if (candidates.length !== 1) {
          throw new DacsError(
            "non-payment evidence cannot be assigned across ambiguous pointerless repeated phases",
          );
        }
        phase = candidates[0];
      }
    }
    if (
      !phase ||
      phase.index <= previousSettlementPhaseIndex ||
      phase.kind !== evidence.phase ||
      phase.outcome !== (evidence.outcome === "success" ? "ok" : "fail") ||
      evidence.signature.signer !== phaseOrchestrator ||
      (evidence.phase.startsWith("pay-") &&
        phase.txRefs !== undefined &&
        !exact(phase.txRefs, evidence.paymentTxRefs))
    ) {
      throw new DacsError("settlement evidence does not bind its executed session phase/authority");
    }
    previousSettlementPhaseIndex = phase.index;
    unmatchedSettlementPhases.delete(phase.index);
    if (phase.outcome !== "ok" || evidence.outcome !== "success") {
      throw new DacsError("completed session settlement phases must resolve to success evidence");
    }
    for (const amendmentRef of evidence.amendmentRefs ?? []) {
      if (!refsContain(session.amendments ?? [], amendmentRef)) {
        throw new DacsError("SettlementEvidence references an amendment omitted from SessionRecord");
      }
    }
    settlementByRef.set(dependencySourceId(refSource(ref)), evidence);
  }
  if (unmatchedSettlementPhases.size > 0) {
    throw new DacsError("SettlementEvidence inventory does not cover every executed settle phase");
  }

  for (const ref of session.settlementEvidence) {
    const evidence = settlementByRef.get(dependencySourceId(refSource(ref)))!;
    if (!isSettlementEvidence(evidence)) continue;
    if (evidence.supersedesEvidenceRef) {
      const superseded = resolvedArtifact(
        refSource(evidence.supersedesEvidenceRef),
        resolved,
        "superseded SettlementEvidence",
      );
      let supersededBinding: AuthenticatedPaymentBinding | undefined;
      if (
        evidence.phase.startsWith("pay-") &&
        isSettlementEvidence(superseded)
      ) {
        supersededBinding = await resolveAuthenticatedPaymentBinding(
          session,
          evidence.supersedesEvidenceRef,
          superseded,
          dependencies,
          provider,
        );
      }
      const currentBinding = paymentBindingByRef.get(
        dependencySourceId(refSource(ref)),
      );
      if (
        !isSettlementEvidence(superseded) ||
        superseded.jobId !== session.jobId ||
        superseded.phase !== evidence.phase ||
        superseded.outcome !== "failure" ||
        superseded.signature.signer !== phaseOrchestrator ||
        superseded.supersedesEvidenceRef !== undefined ||
        (superseded.amendmentRefs ?? []).some(
          (amendmentRef) => !refsContain(session.amendments ?? [], amendmentRef),
        ) ||
        refsContain(session.settlementEvidence, evidence.supersedesEvidenceRef)
      ) {
        throw new DacsError("ST-8 supersession does not bind one prior same-phase failure");
      }
      if (
        evidence.phase.startsWith("pay-") &&
        (!currentBinding ||
          !supersededBinding ||
          currentBinding.jobId !== supersededBinding.jobId ||
          currentBinding.railId !== supersededBinding.railId ||
          currentBinding.phaseIndex !== supersededBinding.phaseIndex ||
          currentBinding.resolved !== true ||
          supersededBinding.resolved !== false)
      ) {
        throw new DacsError(
          "ST-8 supersession does not preserve the exact job/rail/phase tuple",
        );
      }
    }
    if (evidence.outcome === "success" && evidence.phase.startsWith("deliver-")) {
      const deliveryAnchor = evidence.deliverableAnchor;
      const deliveryHash = evidence.deliverableContentHash;
      if (!deliveryAnchor || !deliveryHash) {
        throw new DacsError("successful delivery evidence omits its content binding");
      }
      const expectedKind = evidence.phase.slice("deliver-".length);
      if (
        listing.offering.deliverable.kind !== expectedKind ||
        session.agreement.deliverableRef.deliverableType !== expectedKind
      ) {
        throw new DacsError("delivery evidence is not coherent with the pinned DeliverableSpec");
      }
      const deliveredSource: SellerBundleDependencySource = {
        kind: "deliverable",
        anchor: deliveryAnchor,
        contentHash: deliveryHash,
        encoding: evidence.phase === "deliver-attested-payload" ? "bytes" : "jcs",
      };
      if (!resolved.has(dependencySourceId(deliveredSource))) {
        throw new DacsError("delivery anchor was not independently resolved");
      }
    }
  }

  const payloadRequirements = [...requirements.values()].filter((requirement) =>
    requirement.kinds.includes("payload-attestation"),
  );
  for (const requirement of payloadRequirements) {
    const record = resolvedArtifact(requirement.source, resolved, "PayloadAttestationRecord");
    const ref = requirement.refs[0];
    const enclosing = session.settlementEvidence
      .map((evidenceRef) => settlementByRef.get(dependencySourceId(refSource(evidenceRef))))
      .find(
        (candidate) =>
          isSettlementEvidence(candidate) &&
          candidate.phase === "deliver-attested-payload" &&
          candidate.outcome === "success" &&
          ref !== undefined &&
          exact(candidate.attestationRef, ref),
      );
    const deliverable = listing.offering.deliverable;
    if (
      !ref ||
      !enclosing ||
      !isPayloadAttestationRecord(record) ||
      record.decision !== "pass" ||
      !isAttestationRef(record.methodEvidenceRef) ||
      deliverable.kind !== "attested-payload" ||
      !deliverable.verificationMethod ||
      record.jobId !== session.jobId ||
      record.agreementHash !== session.agreementRef.contentHash ||
      record.deliverableSpecHash !==
        sha256Hex(canonicalize(deliverable as unknown as Record<string, unknown>)) ||
      record.payloadFormat !== deliverable.payloadFormat ||
      record.payloadContentHash !== enclosing.deliverableContentHash ||
      record.verificationMethod !== deliverable.verificationMethod.kind ||
      record.verificationMethodHash !==
        sha256Hex(
          canonicalize(
            deliverable.verificationMethod as unknown as Record<string, unknown>,
          ),
        )
    ) {
      throw new DacsError("PayloadAttestationRecord fails DPA-2 through DPA-9 binding");
    }
    const methodRequirement = [...requirements.values()].find(
      (candidate) =>
        candidate.kinds.includes("method-evidence") &&
        candidate.refs.some((candidateRef) =>
          exact(candidateRef, record.methodEvidenceRef)),
    );
    const methodEvidence = methodRequirement
      ? resolved.get(methodRequirement.id)
      : undefined;
    if (!methodEvidence) {
      throw new DacsError("DPA-3 method evidence was not independently resolved");
    }
    const deliveredSource: SellerBundleDependencySource = {
      kind: "deliverable",
      anchor: enclosing.deliverableAnchor as { kind: string; locator: string },
      contentHash: enclosing.deliverableContentHash as string,
      encoding: "bytes",
    };
    const delivered = resolved.get(dependencySourceId(deliveredSource));
    if (!delivered || delivered.encoding !== "bytes") {
      throw new DacsError("DPA-2 exact delivered payload bytes were not independently resolved");
    }
    if (!provider.verifyPayloadMethodProof) {
      throw new DacsError("DPA-3 method-proof verifier is unavailable");
    }
    await verifiedDisposition("DPA-3 payload method proof", () =>
      provider.verifyPayloadMethodProof!({
        listingDeliverable: snapshot(
          deliverable as unknown as Record<string, unknown>,
          "DPA listing DeliverableSpec",
        ),
        payloadAttestation: snapshot(record, "DPA PayloadAttestationRecord"),
        methodEvidence:
          methodEvidence.encoding === "bytes"
            ? new Uint8Array(methodEvidence.bytes)
            : snapshot(methodEvidence.artifact, "DPA method evidence"),
        deliveredPayload: new Uint8Array(delivered.bytes),
      }),
    );
    const methodRequiresTransaction =
      deliverable.verificationMethod.kind === "consensus-backed-proxy" ||
      deliverable.verificationMethod.kind === "demos-gcr-domain";
    if (methodRequiresTransaction && !record.methodTransactionRef) {
      throw new DacsError("selected verification method requires an authenticated native transaction");
    }
    if (record.methodTransactionRef) {
      if (!provider.verifyPayloadMethodTransaction) {
        throw new DacsError("native payload-method transaction verifier is unavailable");
      }
      await verifiedDisposition("DPA-3 method transaction", () =>
        provider.verifyPayloadMethodTransaction!({
          transactionRef: snapshot(
            record.methodTransactionRef as { kind: string; value: string },
            "method transaction",
          ),
          payloadAttestation: snapshot(record, "payload attestation transaction input"),
        }),
      );
    }
  }

  const refundsByEvidence = new Map<
    string,
    { currency: string; amounts: string[]; evidence: Record<string, unknown> }
  >();
  for (const ref of session.amendments ?? []) {
    const amendment = resolvedArtifact(refSource(ref), resolved, "SettlementAmendment");
    if (
      !isSettlementAmendment(amendment) ||
      amendment.jobId !== session.jobId ||
      !partyClaims.has((amendment.signature as ComponentSignature).signer)
    ) {
      throw new DacsError("SettlementAmendment is malformed or unauthorized for the session");
    }
    const amendedRef = amendment.amendsEvidenceRef as AttestationRef;
    if (!refsContain(session.settlementEvidence, amendedRef)) {
      throw new DacsError("SettlementAmendment targets evidence outside the canonical session");
    }
    const evidence = settlementByRef.get(dependencySourceId(refSource(amendedRef)));
    if (!evidence || !isSettlementEvidence(evidence)) {
      throw new DacsError("SettlementAmendment target did not resolve to SettlementEvidence");
    }
    if (amendment.amendmentType === "correction") continue;
    if (
      evidence.outcome !== "success" ||
      !evidence.paymentAmount ||
      !isRecord(amendment.refundAmount) ||
      amendment.refundAmount.currency !== evidence.paymentAmount.currency
    ) {
      throw new DacsError("refund amendment violates AMEND-1/AMEND-2 currency binding");
    }
    const key = dependencySourceId(refSource(amendedRef));
    const aggregate = refundsByEvidence.get(key) ?? {
      currency: evidence.paymentAmount.currency,
      amounts: [],
      evidence,
    };
    aggregate.amounts.push(amendment.refundAmount.amount as string);
    refundsByEvidence.set(key, aggregate);
  }
  for (const aggregate of refundsByEvidence.values()) {
    const evidence = aggregate.evidence;
    if (
      !isSettlementEvidence(evidence) ||
      evidence.outcome !== "success" ||
      !evidence.paymentAmount ||
      !refundTotalWithin(aggregate.amounts, evidence.paymentAmount.amount)
    ) {
      throw new DacsError("aggregate refunds exceed settled paymentAmount (AMEND-3/AMEND-4)");
    }
  }

  const ratingDirections = new Set<string>();
  for (const ref of session.ratingRefs ?? []) {
    const rating = resolvedArtifact(refSource(ref), resolved, "RatingRecord");
    const direction = isRecord(rating)
      ? `${String(rating.rater)}\u0000${String(rating.targetRole)}`
      : "";
    if (
      !isRatingRecord(rating) ||
      rating.jobId !== session.jobId ||
      rating.rater === rating.target ||
      ratingDirections.has(direction) ||
      (rating.targetRole === "seller" &&
        (rating.rater !== session.buyer.primaryClaim ||
          rating.target !== session.seller.primaryClaim)) ||
      (rating.targetRole === "buyer" &&
        (rating.rater !== session.seller.primaryClaim ||
          rating.target !== session.buyer.primaryClaim))
    ) {
      throw new DacsError("RatingRecord is malformed or not bound to the session parties");
    }
    ratingDirections.add(direction);
  }

  for (const requirement of requirements.values()) {
    if (
      requirement.kinds.length === 1 &&
      requirement.kinds[0] === "phase-attestation"
    ) {
      throw new DacsError("unsupported phase-attestation variant cannot enter the bundle closure");
    }
  }
}

async function verifyDependencies(
  session: PreparedSession,
  supplied: readonly FinalizedSellerBundleDependency[],
  provider: SellerBundleFinalizationProvider,
): Promise<void> {
  if (!Array.isArray(supplied)) {
    throw new DacsError("bundle dependencies must be an array");
  }
  const requirements = requirementMap(session);
  const suppliedSnapshot = snapshot(supplied, "bundle dependencies");
  const byId = new Map<string, FinalizedSellerBundleDependency>();
  for (const dependency of suppliedSnapshot) {
    if (
      !isRecord(dependency) ||
      !hasOnlyKeys(dependency, ["source", "anchorReceipt"]) ||
      !isDependencySource(dependency.source) ||
      !isAnchorReceipt(dependency.anchorReceipt)
    ) {
      throw new DacsError("bundle dependency must be an object");
    }
    const candidate = dependency as unknown as FinalizedSellerBundleDependency;
    if (sourceHash(candidate.source) !== candidate.anchorReceipt.contentHash) {
      throw new DacsError("bundle dependency does not match its receipt content hash");
    }
    const id = dependencySourceId(candidate.source);
    if (byId.has(id)) {
      throw new DacsError("bundle dependencies contain a duplicate source");
    }
    byId.set(id, candidate);
  }

  const suppliedSourceForRef = (
    ref: AttestationRef,
    subject: string,
    encoding?: "artifact" | "jcs" | "bytes",
  ): SellerBundleDependencySource => {
    const matches = [...byId.values()]
      .map((dependency) => dependency.source)
      .filter(
        (source): source is Extract<
          SellerBundleDependencySource,
          { kind: "attestation-ref" }
        > =>
          source.kind === "attestation-ref" &&
          exact(source.ref, ref) &&
          (encoding === undefined || sourceEncoding(source) === encoding),
      );
    if (matches.length !== 1) {
      throw new DacsError(
        `${subject} must have exactly one typed dependency source in the ST-11 closure`,
      );
    }
    return matches[0]!;
  };

  const addRequirement = (
    kind: SellerBundleDependencyKind,
    source: SellerBundleDependencySource,
  ): void => {
    const id = dependencySourceId(source);
    const existing = requirements.get(id);
    if (existing) {
      if (!existing.kinds.includes(kind)) existing.kinds.push(kind);
      return;
    }
    requirements.set(id, {
      id,
      contentHash: sourceHash(source),
      encoding: sourceEncoding(source),
      kinds: [kind],
      refs: source.kind === "attestation-ref" ? [source.ref] : [],
      source,
    });
  };
  const resolved = new Map<string, ResolvedDependencyContent>();
  const pending = [...requirements.keys()];
  const queued = new Set(pending);
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const id = pending[cursor]!;
    const requirement = requirements.get(id)!;
    const dependency = byId.get(id);
    if (!dependency) {
      throw new DacsError(`bundle dependency ${id} is missing from the recursive ST-11 closure`);
    }
    const receipt = dependency.anchorReceipt;
    if (
      receipt.state !== "finalized" ||
      receipt.observationDisposition !== "established" ||
      receipt.contentHash !== requirement.contentHash
    ) {
      throw new DacsError(`dependency ${id} lacks an established finalized AnchorReceipt`);
    }
    const locator =
      requirement.source.kind === "attestation-ref"
        ? requirement.source.ref.anchor.locator
        : requirement.source.kind === "deliverable"
          ? requirement.source.anchor.locator
          : undefined;
    if (locator !== undefined && receipt.logicalAddress !== locator) {
      throw new DacsError(`dependency ${id} receipt binds a different logical address`);
    }
    await verifiedDisposition(`dependency ${id} receipt proof`, () =>
      provider.verifyDependencyReceipt(
        snapshot(dependency, "dependency receipt verification input"),
        snapshot(requirement, "dependency requirement"),
      ),
    );

    let lookup: SellerBundleDependencyLookup;
    try {
      lookup = snapshot(
        await provider.resolveDependency(
          snapshot(dependency, "dependency resolution input"),
          snapshot(requirement, "dependency resolution requirement"),
        ),
        "dependency resolution result",
      );
    } catch (error) {
      throw new SubstrateError(`dependency ${id} resolution errored`, { cause: error });
    }
    if (!isRecord(lookup) || !["present", "absent", "indeterminate"].includes(String(lookup.disposition))) {
      throw new SubstrateError(`dependency ${id} resolution returned an invalid disposition`);
    }
    if (lookup.disposition === "indeterminate") {
      throw new SubstrateError(`dependency ${id} resolution is indeterminate: ${lookup.reason}`);
    }
    if (lookup.disposition === "absent") {
      throw new DacsError(`dependency ${id} is authoritatively absent despite its finalized receipt`);
    }
    if (requirement.encoding === "bytes") {
      if (!(lookup.bytes instanceof Uint8Array) || lookup.artifact !== undefined) {
        throw new DacsError(`dependency ${id} did not resolve to exact bytes`);
      }
      const bytes = new Uint8Array(lookup.bytes);
      if (sha256Hex(bytes) !== requirement.contentHash) {
        throw new DacsError(`dependency ${id} resolved with a different raw-byte hash`);
      }
      resolved.set(id, { encoding: "bytes", bytes });
      await verifiedDisposition(`dependency ${id} authenticity/logical/session binding`, () =>
        provider.verifyDependencyBinding({
          dependency: snapshot(dependency, "dependency binding input"),
          requirement: snapshot(requirement, "dependency binding requirement"),
          artifact: new Uint8Array(bytes),
        }),
      );
    } else {
      if (!isRecord(lookup.artifact) || lookup.bytes !== undefined) {
        throw new DacsError(`dependency ${id} resolved to a non-artifact value`);
      }
      const artifact = snapshot(lookup.artifact, "resolved dependency artifact");
      let resolvedHash: string;
      try {
        resolvedHash = requirement.encoding === "jcs"
          ? sha256Hex(canonicalize(artifact))
          : contentHash(artifact);
      } catch (error) {
        throw new DacsError(`dependency ${id} cannot be canonically hashed`, { cause: error });
      }
      if (resolvedHash !== requirement.contentHash) {
        throw new DacsError(`dependency ${id} resolved with a different canonical content hash`);
      }
      resolved.set(id, { encoding: requirement.encoding, artifact });
      await verifiedDisposition(`dependency ${id} authenticity/logical/session binding`, () =>
        provider.verifyDependencyBinding({
          dependency: snapshot(dependency, "dependency binding input"),
          requirement: snapshot(requirement, "dependency binding requirement"),
          artifact: snapshot(artifact, "dependency binding artifact"),
        }),
      );

      if (requirement.kinds.includes("listing") && isListing(artifact)) {
        for (const claim of artifact.seller.identity.claims) {
          if (!claim.verifiedBy) continue;
          addRequirement(
            "verify-result",
            refSource({
              anchor: claim.verifiedBy.anchor,
              contentHash: claim.verifiedBy.contentHash,
            }),
          );
        }
      }
      if (requirement.kinds.includes("agreement") && isAgreementArtifact(artifact)) {
        for (const party of artifact.parties) addRequirement("vet-record", refSource(party.vetRecordRef));
        if (artifact.terms.priceAnchor) {
          addRequirement(
            "price-anchor",
            suppliedSourceForRef(
              artifact.terms.priceAnchor.attestationRef,
              "price-anchor raw response",
              "bytes",
            ),
          );
        }
      }
      if (
        requirement.kinds.includes("vet-record") &&
        isNormativeCompositeVerificationRecord(artifact)
      ) {
        for (const resultRef of [
          ...(artifact.freshness as Record<string, unknown>[]),
          ...(artifact.dealSpecific as Record<string, unknown>[]),
        ]) {
          addRequirement(
            "verify-result",
            refSource({
              anchor: resultRef.anchor as AttestationRef["anchor"],
              contentHash: resultRef.contentHash as string,
            }),
          );
        }
        for (const signal of artifact.supplementary as Record<string, unknown>[]) {
          if (isAttestationRef(signal.attestation)) {
            addRequirement(
              "verification-attestation",
              suppliedSourceForRef(
                signal.attestation,
                "CompositeVerificationRecord supplementary attestation",
              ),
            );
          }
        }
      }
      if (requirement.kinds.includes("verify-result") && isVerifyResultRecord(artifact)) {
        addRequirement(
          "verification-attestation",
          suppliedSourceForRef(
            artifact.attestation as AttestationRef,
            "VerifyResult authority attestation",
          ),
        );
      }
      if (requirement.kinds.includes("settlement-evidence") || requirement.kinds.includes("superseded-evidence")) {
        if (isSettlementEvidence(artifact)) {
          if (artifact.supersedesEvidenceRef) {
            addRequirement("superseded-evidence", refSource(artifact.supersedesEvidenceRef));
          }
          for (const amendment of artifact.amendmentRefs ?? []) {
            addRequirement("amendment", refSource(amendment));
          }
          if (artifact.outcome === "success" && artifact.phase.startsWith("deliver-")) {
            const deliveryAnchor = artifact.deliverableAnchor;
            const deliveryHash = artifact.deliverableContentHash;
            if (!deliveryAnchor || !deliveryHash) {
              throw new DacsError("successful delivery evidence omits its content binding");
            }
            addRequirement("delivered-payload", {
              kind: "deliverable",
              anchor: deliveryAnchor,
              contentHash: deliveryHash,
              encoding: artifact.phase === "deliver-attested-payload" ? "bytes" : "jcs",
            });
          }
          if (artifact.phase === "deliver-attested-payload" && artifact.outcome === "success") {
            addRequirement("payload-attestation", refSource(artifact.attestationRef));
          }
        }
      }
      if (requirement.kinds.includes("amendment") && isSettlementAmendment(artifact)) {
        addRequirement("settlement-evidence", refSource(artifact.amendsEvidenceRef as AttestationRef));
      }
      if (requirement.kinds.includes("payload-attestation") && isPayloadAttestationRecord(artifact)) {
        if (artifact.methodEvidenceRef) {
          addRequirement(
            "method-evidence",
            suppliedSourceForRef(
              artifact.methodEvidenceRef as AttestationRef,
              "DPA-3 method evidence",
            ),
          );
        }
      }
    }
    for (const nextId of requirements.keys()) {
      if (!queued.has(nextId)) {
        queued.add(nextId);
        pending.push(nextId);
      }
    }
  }

  if (byId.size !== requirements.size || [...byId.keys()].some((id) => !requirements.has(id))) {
    throw new DacsError("bundle dependencies do not exactly cover the recursive ST-11 closure");
  }
  await auditResolvedDependencyGraph(session, requirements, resolved, byId, provider);
}

function expectedBundleScope(session: PreparedSession): Record<string, unknown> {
  const orchestrator =
    session.orchestrator &&
    session.orchestrator.primaryClaim !== session.buyer.primaryClaim &&
    session.orchestrator.primaryClaim !== session.seller.primaryClaim
      ? session.orchestrator
      : undefined;
  return {
    faultBundleVersion: "1",
    jobId: session.jobId,
    outcome: "completed",
    faultedParty: "none",
    listingRef: session.listingRef,
    agreementRef: session.agreementRef,
    parties: [
      {
        role: "buyer",
        bundleHash: session.buyer.bundleHash,
        primaryClaim: session.buyer.primaryClaim,
      },
      {
        role: "seller",
        bundleHash: session.seller.bundleHash,
        primaryClaim: session.seller.primaryClaim,
      },
      ...(orchestrator
        ? [
            {
              role: "orchestrator",
              bundleHash: orchestrator.bundleHash,
              primaryClaim: orchestrator.primaryClaim,
            },
          ]
        : []),
    ],
    phaseSummary: session.phaseSummary,
    vetRecords: session.vetRecords,
    settlementEvidence: session.settlementEvidence,
    ...(session.amendments ? { amendments: session.amendments } : {}),
    ...(session.ratingRefs ? { ratingRefs: session.ratingRefs } : {}),
    recipeRegistryVersion: session.recipeRegistryVersion,
    railRegistryVersion: session.railRegistryVersion,
    finalisedAt: session.finalisedAt,
  };
}

function assertNormativeExpectedScope(scope: Record<string, unknown>): void {
  const parties = Array.isArray(scope.parties) ? scope.parties : [];
  const signatures = parties.map((party) => ({
    party: isRecord(party) ? party.primaryClaim : "",
    algorithm: "ed25519" as const,
    value: "c2ln",
  }));
  const candidate = {
    ...scope,
    anchoredByRole: "seller",
    signatures,
  };
  if (!isFaultAttestationBundle(candidate)) {
    throw new DacsError("completed session facts do not form a normative FaultAttestationBundle");
  }
}

function bundlePayload(scope: Record<string, unknown>): {
  bundleContentHash: string;
  signedBytes: Uint8Array;
} {
  const bundleContentHash = sha256Hex(canonicalize(scope));
  return {
    bundleContentHash,
    signedBytes: signedBytes(
      ARTIFACT_SEPARATORS.FaultAttestationBundle,
      bundleContentHash,
    ),
  };
}

function requiredBundleClaims(bundle: FaultAttestationBundle): string[] {
  const buyer = bundle.parties.find((party) => party.role === "buyer")?.primaryClaim;
  const seller = bundle.parties.find((party) => party.role === "seller")?.primaryClaim;
  if (!buyer || !seller) {
    throw new DacsError("completed bundle does not identify buyer and seller signers");
  }
  const orchestrator = bundle.parties.find(
    (party) =>
      party.role === "orchestrator" &&
      party.primaryClaim !== buyer &&
      party.primaryClaim !== seller,
  )?.primaryClaim;
  return [buyer, seller, ...(orchestrator ? [orchestrator] : [])];
}

function assertExactCompletedSignerSet(bundle: FaultAttestationBundle): void {
  const required = requiredBundleClaims(bundle);
  const claims = bundle.signatures.map((signature) => signature.party);
  if (
    bundle.outcome !== "completed" ||
    bundle.signatures.length !== required.length ||
    new Set(claims).size !== claims.length ||
    required.some((claim) => !claims.includes(claim))
  ) {
    throw new DacsError("completed bundle lacks the exact required party signature set");
  }
}

async function locallyVerifyCompletedBundle(
  bundle: FaultAttestationBundle,
  role: "buyer" | "seller" | "orchestrator",
  provider: SellerBundleFinalizationProvider,
): Promise<void> {
  assertExactCompletedSignerSet(bundle);
  if (
    !provider.bundleCopyVerifier ||
    typeof provider.bundleCopyVerifier.resolvePublicKey !== "function" ||
    typeof provider.bundleCopyVerifier.verify !== "function"
  ) {
    throw new DacsError("local bundle signature verifier is unavailable");
  }
  const verdict = await verifyBundleCopy(
    snapshot(bundle as unknown as Record<string, unknown>, "bundle verification input"),
    role,
    provider.bundleCopyVerifier,
  );
  if (!verdict.valid || !verdict.fullySigned) {
    throw new DacsError(
      verdict.valid
        ? "completed bundle is not fully signed"
        : `completed bundle signature verification failed: ${verdict.reason}`,
    );
  }
}

async function locallyVerifyBindingSignature(
  binding: BundleBinding,
  provider: SellerBundleFinalizationProvider,
): Promise<void> {
  if (
    binding.signature.signer !== binding.signer ||
    binding.signature.algorithm !== "ed25519" ||
    !isCanonicalBase64Url(binding.signature.value)
  ) {
    throw new DacsError("BundleBinding has an unsupported or unauthorized signature");
  }
  const signature = Uint8Array.from(Buffer.from(binding.signature.value, "base64url"));
  if (signature.byteLength !== 64) {
    throw new DacsError("BundleBinding signature is not one Ed25519 signature");
  }
  const key = await provider.bundleCopyVerifier.resolvePublicKey(binding.signer);
  if (!key || key.byteLength !== 32) {
    throw new DacsError("BundleBinding signer key cannot be resolved");
  }
  const message = signedBytes(
    BUNDLE_BINDING_SEPARATOR,
    contentHash(binding as unknown as Record<string, unknown>),
  );
  if (!(await provider.bundleCopyVerifier.verify(message, signature, new Uint8Array(key)))) {
    throw new DacsError("BundleBinding signature failed local verification");
  }
  if (provider.verifyBundleBinding) {
    await verifiedDisposition("BundleBinding provider verification", () =>
      provider.verifyBundleBinding!(snapshot(binding, "BundleBinding provider verification input")),
    );
  }
}

/**
 * Export the exact §10.4.1 signed scope for transport to the buyer and, when
 * distinct, orchestrator. The finalizer independently re-derives this request;
 * carrying it back does not create or modify any normative artifact field.
 */
export function prepareCompletedSellerBundleCounterSignatureRequest(
  input: FinalizeCompletedSellerBundleInput,
): CompletedSellerBundleCounterSignatureRequest {
  const session = prepareSession(input);
  const signedScope = expectedBundleScope(session);
  assertNormativeExpectedScope(signedScope);
  const payload = bundlePayload(signedScope);
  return {
    bundleContentHash: payload.bundleContentHash,
    signedScope: snapshot(signedScope, "counter-signature scope"),
    signedBytes: new Uint8Array(payload.signedBytes),
    requiredCounterSigners: [
      session.buyer.primaryClaim,
      ...(session.orchestrator ? [session.orchestrator.primaryClaim] : []),
    ],
  };
}

function validateAnchoredBundle(
  logicalAddress: string,
  expectedScope: Record<string, unknown>,
  anchored: AnchoredSellerBundle,
): FaultAttestationBundle {
  if (!isRecord(anchored)) {
    throw new DacsError("resolved seller bundle is malformed or binds different session content");
  }
  assertCanonicalBundleSignatures(anchored.bundle, "resumed seller bundle");
  if (
    !isFaultAttestationBundle(anchored.bundle) ||
    anchored.bundle.anchoredByRole !== "seller" ||
    !exact(bundleSignedScope(anchored.bundle), expectedScope) ||
    typeof anchored.nativeAddress !== "string" ||
    anchored.nativeAddress.length === 0 ||
    (anchored.anchorTx !== undefined &&
      (typeof anchored.anchorTx !== "string" || anchored.anchorTx.length === 0))
  ) {
    throw new DacsError("resolved seller bundle is malformed or binds different session content");
  }
  const bundleHash = attestationBundleHash(anchored.bundle);
  const receipt = anchored.anchorReceipt;
  if (
    !isAnchorReceipt(receipt) ||
    receipt.state !== "finalized" ||
    receipt.observationDisposition !== "established" ||
    receipt.logicalAddress !== logicalAddress ||
    receipt.nativeAddress !== anchored.nativeAddress ||
    receipt.contentHash !== bundleHash
  ) {
    throw new DacsError("seller bundle lacks an exact established finalized AnchorReceipt");
  }
  return anchored.bundle;
}

function assertCanonicalBundleSignatures(value: unknown, subject: string): void {
  if (
    !isRecord(value) ||
    !Array.isArray(value.signatures) ||
    value.signatures.some(
      (signature) =>
        !isRecord(signature) || !isCanonicalBase64Url(signature.value),
    )
  ) {
    throw new DacsError(`${subject} carries a non-canonical Base64URL signature`);
  }
}

async function resolveBundle(
  logicalAddress: string,
  provider: SellerBundleFinalizationProvider,
): Promise<SellerBundleLookup> {
  try {
    const lookup = snapshot(
      await provider.resolveSellerBundle(logicalAddress),
      "seller bundle lookup",
    );
    if (
      !isRecord(lookup) ||
      !["present", "absent", "indeterminate"].includes(String(lookup.disposition))
    ) {
      throw new SubstrateError("seller bundle lookup returned an invalid disposition");
    }
    return lookup;
  } catch (error) {
    if (error instanceof SubstrateError) throw error;
    throw new SubstrateError("seller bundle lookup errored and is indeterminate", {
      cause: error,
    });
  }
}

async function verifyAnchoredBundle(
  logicalAddress: string,
  expectedScope: Record<string, unknown>,
  anchored: AnchoredSellerBundle,
  provider: SellerBundleFinalizationProvider,
): Promise<FaultAttestationBundle> {
  const bundle = validateAnchoredBundle(logicalAddress, expectedScope, anchored);
  await locallyVerifyCompletedBundle(bundle, "seller", provider);
  await verifiedDisposition("seller bundle anchor receipt proof", () =>
    provider.verifyBundleAnchorReceipt(snapshot(anchored, "bundle receipt proof input")),
  );
  return snapshot(bundle, "verified seller bundle");
}

function roleCopy(
  sellerBundle: FaultAttestationBundle,
  role: "buyer" | "orchestrator",
): FaultAttestationBundle {
  const copy = snapshot(sellerBundle, `${role} role-copy source`);
  copy.anchoredByRole = role;
  if (!isFaultAttestationBundle(copy)) {
    throw new DacsError(`verified seller bundle cannot form the ${role} role copy`);
  }
  return copy;
}

async function constructSignedCopies(
  session: PreparedSession,
  expectedScope: Record<string, unknown>,
  provider: SellerBundleFinalizationProvider,
): Promise<{
  sellerCopy: FaultAttestationBundle;
  buyerCopy: FaultAttestationBundle;
  orchestratorCopy?: FaultAttestationBundle;
}> {
  const requiredCounterSigners = [
    session.buyer.primaryClaim,
    ...(session.orchestrator ? [session.orchestrator.primaryClaim] : []),
  ];
  const supplied = session.counterSignatures ?? [];
  const byParty = new Map<string, BundleSignature>();
  for (const signature of supplied) {
    if (isRecord(signature) && !isCanonicalBase64Url(signature.value)) {
      throw new DacsError("detached bundle signature is not canonical Base64URL");
    }
    if (
      !isRecord(signature) ||
      !hasOnlyKeys(signature, ["party", "algorithm", "value"]) ||
      typeof signature.party !== "string" ||
      !requiredCounterSigners.includes(signature.party) ||
      signature.party === session.seller.primaryClaim ||
      byParty.has(signature.party)
    ) {
      throw new DacsError("detached bundle signature is duplicate or not authorized for a counterparty");
    }
    byParty.set(signature.party, snapshot(signature, "detached bundle signature"));
  }
  if (
    supplied.length !== requiredCounterSigners.length ||
    requiredCounterSigners.some((claim) => !byParty.has(claim))
  ) {
    throw new DacsError(
      "new completed bundle requires detached buyer and distinct-orchestrator signatures",
    );
  }

  const payload = bundlePayload(expectedScope);
  let rawSellerSignature: Uint8Array;
  try {
    const signer = session.seller.signer;
    const raw =
      typeof signer === "function"
        ? await signer(new Uint8Array(payload.signedBytes))
        : ed25519Sign(
            payload.signedBytes,
            signer instanceof Uint8Array ? privateKeyFromSeed(signer) : signer,
          );
    rawSellerSignature = new Uint8Array(raw);
  } catch (error) {
    throw new DacsError("seller bundle signing failed", { cause: error });
  }
  if (rawSellerSignature.byteLength !== 64) {
    throw new DacsError("seller bundle signer did not return one Ed25519 signature");
  }
  const sellerSignature: BundleSignature = {
    party: session.seller.primaryClaim,
    algorithm: "ed25519",
    value: Buffer.from(rawSellerSignature).toString("base64url"),
  };
  const orderedSignatures = [
    byParty.get(session.buyer.primaryClaim)!,
    sellerSignature,
    ...(session.orchestrator
      ? [byParty.get(session.orchestrator.primaryClaim)!]
      : []),
  ];
  const candidate = {
    ...snapshot(expectedScope, "completed bundle scope"),
    anchoredByRole: "seller",
    signatures: orderedSignatures,
  };
  assertCanonicalBundleSignatures(candidate, "detached bundle assembly");
  if (!isFaultAttestationBundle(candidate)) {
    throw new DacsError("detached signatures do not form a normative FaultAttestationBundle");
  }
  if (attestationBundleHash(candidate) !== payload.bundleContentHash) {
    throw new DacsError("detached signature assembly changed the reviewed bundle scope");
  }
  await locallyVerifyCompletedBundle(candidate, "seller", provider);
  const buyerCopy = roleCopy(candidate, "buyer");
  await locallyVerifyCompletedBundle(buyerCopy, "buyer", provider);
  const orchestratorCopy = session.orchestrator
    ? roleCopy(candidate, "orchestrator")
    : undefined;
  if (orchestratorCopy) {
    await locallyVerifyCompletedBundle(orchestratorCopy, "orchestrator", provider);
  }
  return {
    sellerCopy: candidate,
    buyerCopy,
    ...(orchestratorCopy ? { orchestratorCopy } : {}),
  };
}

async function anchorSellerBundle(
  session: PreparedSession,
  provider: SellerBundleFinalizationProvider,
): Promise<{
  anchored: AnchoredSellerBundle;
  sellerBundle: FaultAttestationBundle;
  buyerBundle: FaultAttestationBundle;
  orchestratorBundle?: FaultAttestationBundle;
  resumed: boolean;
}> {
  const logicalAddress = bundleAddress(session.jobId, "seller");
  const expectedScope = expectedBundleScope(session);
  assertNormativeExpectedScope(expectedScope);
  let lookup = await resolveBundle(logicalAddress, provider);
  if (lookup.disposition === "indeterminate") {
    throw new SubstrateError(`seller bundle lookup is indeterminate: ${lookup.reason}`);
  }
  if (lookup.disposition === "present") {
    const sellerBundle = await verifyAnchoredBundle(
      logicalAddress,
      expectedScope,
      lookup.anchored,
      provider,
    );
    const buyerBundle = roleCopy(sellerBundle, "buyer");
    await locallyVerifyCompletedBundle(buyerBundle, "buyer", provider);
    const orchestratorBundle = sellerBundle.parties.some(
      (party) => party.role === "orchestrator",
    )
      ? roleCopy(sellerBundle, "orchestrator")
      : undefined;
    if (orchestratorBundle) {
      await locallyVerifyCompletedBundle(orchestratorBundle, "orchestrator", provider);
    }
    return {
      anchored: lookup.anchored,
      sellerBundle,
      buyerBundle,
      ...(orchestratorBundle ? { orchestratorBundle } : {}),
      resumed: true,
    };
  }

  const copies = await constructSignedCopies(session, expectedScope, provider);
  if (!exact(bundleSignedScope(copies.sellerCopy), expectedScope)) {
    throw new DacsError("completed bundle constructor changed the verified session scope");
  }

  try {
    await provider.submitSellerBundle(
      logicalAddress,
      snapshot(copies.sellerCopy, "seller bundle submission input"),
    );
  } catch (error) {
    lookup = await resolveBundle(logicalAddress, provider);
    if (lookup.disposition !== "present") {
      throw new SubstrateError(
        "seller bundle submission outcome is ambiguous; resolve before any retry",
        { cause: error },
      );
    }
  }
  if (lookup.disposition !== "present") {
    lookup = await resolveBundle(logicalAddress, provider);
  }
  if (lookup.disposition !== "present") {
    throw new SubstrateError(
      lookup.disposition === "indeterminate"
        ? `seller bundle is not independently resolvable: ${lookup.reason}`
        : "seller bundle is authoritatively absent after submission",
    );
  }
  const sellerBundle = await verifyAnchoredBundle(
    logicalAddress,
    expectedScope,
    lookup.anchored,
    provider,
  );
  if (attestationBundleHash(sellerBundle) !== attestationBundleHash(copies.sellerCopy)) {
    throw new DacsError("independently resolved seller bundle differs from the submitted copy");
  }
  return {
    anchored: lookup.anchored,
    sellerBundle,
    buyerBundle: copies.buyerCopy,
    ...(copies.orchestratorCopy ? { orchestratorBundle: copies.orchestratorCopy } : {}),
    resumed: false,
  };
}

function bindingMatches(
  binding: BundleBinding,
  expected: Omit<BundleBinding, "signature">,
): boolean {
  const { signature: _signature, anchorTx: actualAnchorTx, ...unsigned } = binding;
  const { anchorTx: expectedAnchorTx, ...expectedCore } = expected;
  return (
    exact(unsigned, expectedCore) &&
    (!actualAnchorTx || !expectedAnchorTx || actualAnchorTx === expectedAnchorTx)
  );
}

async function publishBinding(
  session: PreparedSession,
  provider: SellerBundleFinalizationProvider,
  anchored: AnchoredSellerBundle,
  sellerBundle: FaultAttestationBundle,
): Promise<{ binding?: BundleBinding; resumed: boolean }> {
  if (provider.mapping === "pure") return { resumed: false };
  if (
    !provider.resolveBundleBinding ||
    !provider.publishBundleBinding
  ) {
    throw new DacsError("write-input bundle mapping requires BundleBinding read/write seams");
  }
  const signer = session.seller.primaryClaim;
  const expected: Omit<BundleBinding, "signature"> = {
    bindingVersion: "1",
    jobId: session.jobId,
    role: "seller",
    logicalAddress: bundleAddress(session.jobId, "seller"),
    nativeAddress: anchored.nativeAddress,
    bundleContentHash: attestationBundleHash(sellerBundle),
    ...(anchored.anchorTx ? { anchorTx: anchored.anchorTx } : {}),
    signer,
  };

  let lookup: SellerBundleBindingLookup;
  try {
    lookup = snapshot(
      await provider.resolveBundleBinding(expected.logicalAddress, signer),
      "BundleBinding lookup",
    );
  } catch (error) {
    throw new SubstrateError("BundleBinding lookup errored and is indeterminate", {
      cause: error,
    });
  }
  if (
    !isRecord(lookup) ||
    !["present", "absent", "indeterminate"].includes(String(lookup.disposition))
  ) {
    throw new SubstrateError("BundleBinding lookup returned an invalid disposition");
  }
  if (lookup.disposition === "indeterminate") {
    throw new SubstrateError(`BundleBinding lookup is indeterminate: ${lookup.reason}`);
  }
  if (lookup.disposition === "present") {
    if (!isBundleBinding(lookup.binding) || !bindingMatches(lookup.binding, expected)) {
      throw new DacsError("existing BundleBinding is malformed or maps different bundle content");
    }
    await locallyVerifyBindingSignature(lookup.binding, provider);
    return { binding: snapshot(lookup.binding, "existing BundleBinding"), resumed: true };
  }

  if (!session.bindingSigner || session.bindingSigner.signer !== signer) {
    throw new DacsError("BundleBinding signer must be the agreement seller (BB-1/BB-4)");
  }
  const binding = await signComponentArtifact(
    expected,
    BUNDLE_BINDING_SEPARATOR,
    session.bindingSigner,
  );
  if (!isBundleBinding(binding)) {
    throw new DacsError("signed BundleBinding is not normative");
  }
  await locallyVerifyBindingSignature(binding, provider);
  let publication: SellerBundleBindingPublication;
  try {
    publication = snapshot(
      await provider.publishBundleBinding(snapshot(binding, "BundleBinding publication input")),
      "BundleBinding publication result",
    );
  } catch (error) {
    try {
      lookup = snapshot(
        await provider.resolveBundleBinding(expected.logicalAddress, signer),
        "BundleBinding publication reconciliation",
      );
    } catch (readError) {
      throw new SubstrateError(
        "BundleBinding publication outcome is ambiguous; resolve before any retry",
        { cause: readError },
      );
    }
    if (
      lookup.disposition !== "present" ||
      !isBundleBinding(lookup.binding) ||
      !bindingMatches(lookup.binding, expected) ||
      contentHash(lookup.binding as unknown as Record<string, unknown>) !==
        contentHash(binding as unknown as Record<string, unknown>)
    ) {
      throw new SubstrateError(
        "BundleBinding publication outcome is ambiguous; resolve before any retry",
        { cause: error },
      );
    }
    await locallyVerifyBindingSignature(lookup.binding, provider);
    return { binding: snapshot(lookup.binding, "reconciled BundleBinding"), resumed: false };
  }
  if (!isRecord(publication) || !["published", "rejected", "indeterminate"].includes(String(publication.disposition))) {
    throw new SubstrateError("BundleBinding publisher returned an invalid disposition");
  }
  if (publication.disposition === "indeterminate") {
    throw new SubstrateError(`BundleBinding publication is indeterminate: ${publication.reason}`);
  }
  if (publication.disposition === "rejected") {
    throw new DacsError(`BundleBinding publication was rejected: ${publication.reason}`);
  }
  let publishedLookup: SellerBundleBindingLookup;
  try {
    publishedLookup = snapshot(
      await provider.resolveBundleBinding(expected.logicalAddress, signer),
      "published BundleBinding readback",
    );
  } catch (error) {
    throw new SubstrateError("published BundleBinding is not independently readable", {
      cause: error,
    });
  }
  if (
    publishedLookup.disposition !== "present" ||
    !isBundleBinding(publishedLookup.binding) ||
    !bindingMatches(publishedLookup.binding, expected) ||
    contentHash(publishedLookup.binding as unknown as Record<string, unknown>) !==
      contentHash(binding as unknown as Record<string, unknown>)
  ) {
    throw new SubstrateError("published BundleBinding is not independently readable and exact");
  }
  await locallyVerifyBindingSignature(publishedLookup.binding, provider);
  return {
    binding: snapshot(publishedLookup.binding, "published BundleBinding"),
    resumed: false,
  };
}

/**
 * DACS-5 ST-11 completed-bundle gate for the seller role. This function only
 * returns `finalised` after dependency audit, required signatures, independent
 * bundle resolution, finalized anchor proof, and applicable BB-1 publication.
 */
export async function finalizeCompletedSellerBundleCore(
  input: FinalizeCompletedSellerBundleInput,
  provider: SellerBundleFinalizationProvider,
): Promise<FinalizedSellerBundle> {
  const mapping = provider.mapping;
  if (mapping !== "pure" && mapping !== "write-input") {
    throw new DacsError("unsupported bundle address mapping policy");
  }
  if (
    !provider.bundleCopyVerifier ||
    typeof provider.bundleCopyVerifier.resolvePublicKey !== "function" ||
    typeof provider.bundleCopyVerifier.verify !== "function"
  ) {
    throw new DacsError("local bundle signature verifier is unavailable");
  }
  if (typeof provider.verifyListingPublisherIdentityLinkage !== "function") {
    throw new DacsError("Listing/session IdentityBundle linkage verifier is unavailable");
  }
  if (typeof provider.verifyVetRequirementProvenance !== "function") {
    throw new DacsError("Vet requirement provenance verifier is unavailable (#331)");
  }
  const retainedProvider: SellerBundleFinalizationProvider = {
    ...provider,
    mapping,
    bundleCopyVerifier: {
      resolvePublicKey: provider.bundleCopyVerifier.resolvePublicKey,
      verify: provider.bundleCopyVerifier.verify,
    },
  };
  const session = prepareSession(input);
  assertNormativeExpectedScope(expectedBundleScope(session));
  await verifyDependencies(session, input.dependencies, retainedProvider);
  const anchored = await anchorSellerBundle(session, retainedProvider);
  const binding = await publishBinding(
    session,
    retainedProvider,
    anchored.anchored,
    anchored.sellerBundle,
  );
  return {
    state: "finalised",
    logicalAddress: bundleAddress(session.jobId, "seller"),
    nativeAddress: anchored.anchored.nativeAddress,
    bundleContentHash: attestationBundleHash(anchored.sellerBundle),
    sellerBundle: anchored.sellerBundle,
    buyerBundle: anchored.buyerBundle,
    ...(anchored.orchestratorBundle
      ? { orchestratorBundle: anchored.orchestratorBundle }
      : {}),
    anchorReceipt: anchored.anchored.anchorReceipt,
    ...(anchored.anchored.anchorTx ? { anchorTx: anchored.anchored.anchorTx } : {}),
    ...(binding.binding ? { binding: binding.binding } : {}),
    resumedBundle: anchored.resumed,
    resumedBinding: binding.resumed,
  };
}

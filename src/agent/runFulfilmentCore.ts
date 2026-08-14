import { types as nodeTypes } from "node:util";

import type {
  AnchorReceipt,
  AttestationRef,
  BundleRequirement,
  ComponentSignature,
  DeliverableSpec,
  ListingRef,
  PhaseStep,
  VerificationMethod,
} from "../artifacts/types.js";
import {
  ARTIFACT_SEPARATORS,
  isAnchorReceipt,
  isAttestationRef,
  isBundleRequirement,
  isChainTxRef,
  isComponentSignature,
  isDeliverableSpec,
  isPhaseStep,
  signComponentArtifact,
  type BuildComponentSignatureOptions,
} from "../artifacts/index.js";
import {
  canonicalize,
  contentHash,
  encodeAddressSegment,
  sha256Hex,
} from "../canonical/index.js";
import { signedBytes, type DomainSeparator } from "../crypto/index.js";
import { finalityCommitmentAddress } from "../negotiate/commitment.js";
import {
  isSellerFulfilmentHandoff,
  isValidSellerReceiptClaim,
  sellerFulfilmentCandidateHash,
  type SellerFulfilmentReceiptStore,
  type SellerFulfilmentHandoff,
  type SellerFulfilmentHandoffEnvelope,
  type SellerFulfilmentAuditSourceCommitmentV1,
  type SellerPaymentAuthorization,
  type SellerPayloadVerificationProducerAdmission,
  type SellerReceiptClaim,
} from "../seller/paymentIntake.js";
import {
  isSellerFulfilmentAuditSource,
  sellerFulfilmentAuditSourceHash,
  type SellerFulfilmentAuditSourceV1,
  type SellerFulfilmentSessionRecord,
  type SellerSessionPhaseEntry,
  type SellerSessionPhaseHandlerResult,
} from "../seller/fulfilmentAuditSource.js";

export type {
  SellerFulfilmentSessionRecord,
  SellerSessionPhaseEntry,
  SellerSessionPhaseHandlerResult,
} from "../seller/fulfilmentAuditSource.js";

const ENTITLEMENT_SEPARATOR =
  "dacs-entitlement:v1:" as const satisfies DomainSeparator;
const PAYLOAD_ATTESTATION_SEPARATOR =
  "dacs-payload-attestation:v1:" as const satisfies DomainSeparator;
/** CORE SIG-4 SDK-operational extension; deliberately outside the closed registry. */
const AUDIT_SOURCE_COMMITMENT_SEPARATOR =
  "dacs-x-seller-fulfilment-audit-source:v1:" as const;

/** Artifact-local §B.2 scope: these records omit only singular `signature`. */
function singularSignatureScope(record: Record<string, unknown>): Record<string, unknown> {
  const signedScope: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key !== "signature") signedScope[key] = value;
  }
  return signedScope;
}

function singularSignatureContentHash(record: Record<string, unknown>): string {
  if (!hasExactJcsView(record)) {
    throw new TypeError("signed artifact contains a JCS-ambiguous JavaScript value");
  }
  return sha256Hex(canonicalize(singularSignatureScope(record)));
}

export type SellerDeliveryPhase =
  | "deliver-storage-program"
  | "deliver-entitlement"
  | "deliver-attested-payload";

/** DACS-4 §9.3 delivery variants handled by this seller core. */
export type SellerDeliverableSpec = Exclude<DeliverableSpec, { kind: "external" }>;

/** Exact DACS-2 §7.5.2 AttestationRef wire shape. */
export type SellerAttestationRef = AttestationRef;

/** DACS-4 §9.6.3 exact PayloadAttestationRecord wire shape. */
export interface SellerPayloadAttestationRecord {
  /** CORE SIG-5: later-minor inert fields remain on the raw signed record. */
  [key: string]: unknown;
  payloadAttestationVersion: "1";
  jobId: string;
  agreementHash: string;
  deliverableSpecHash: string;
  payloadFormat: string;
  payloadContentHash: string;
  verificationMethod: VerificationMethod["kind"];
  verificationMethodHash: string;
  attempt: number;
  decision: "pass" | "fail" | "indeterminate" | "error";
  reason: string;
  methodEvidenceRef?: SellerAttestationRef;
  methodTransactionRef?: { kind: string; value: string };
  verifiedAt: number;
  signature: ComponentSignature;
}

/** Raw DPA record plus the independently resolved receipt for its SR-2 anchor. */
export interface SellerResolvedPayloadAttestation {
  record: unknown;
  anchorReceipt: AnchorReceipt;
}

export type SellerVerificationResult =
  | { disposition: "valid" }
  | { disposition: "invalid" | "indeterminate" | "error"; reason: string };

/** @deprecated Resolve the raw record and use the independent signature/proof verifiers. */
export type SellerPayloadAttestationResolution =
  SellerFulfilmentResolution<SellerResolvedPayloadAttestation>;

/** DACS-4 DPA-1 local exact-byte producer capability decision. */
export type SellerPayloadVerificationCapabilityDecision =
  | { disposition: "supported"; reason?: string }
  | {
      disposition: "unsupported" | "indeterminate" | "error";
      reason: string;
    };

/** Complete signed method/spec identity supplied to the DPA-1 capability gate. */
export interface SellerPayloadVerificationCapabilityInput {
  operation: "produce";
  verificationMethod: Readonly<VerificationMethod>;
  verificationMethodHash: string;
  deliverableSpec: Readonly<Extract<SellerDeliverableSpec, { kind: "attested-payload" }>>;
  deliverableSpecHash: string;
}

/** Verified operational view of the actual DACS-3 payee-bound artifact. */
export interface SellerFulfilmentAgreement {
  artifactKind: "payee-bound";
  ref: string;
  contentHash: string;
  jobId: string;
  listingPin: ListingRef;
  buyer: {
    primaryClaim: string;
    bundleHash: string;
    vetRecordRef: AttestationRef;
    storageAddress?: string;
    encryptionKey?: string;
  };
  seller: {
    primaryClaim: string;
    bundleHash: string;
    vetRecordRef: AttestationRef;
  };
  deliverableRef: {
    deliverableType: SellerDeliverableSpec["kind"];
    hash: string;
    schemaUrl?: string;
  };
  commitment: {
    status: "finalized";
    ref: string;
    agreementHash: string;
    recordContentHash: string;
    finalizedAt: number;
    signer: string;
  };
}

/** Verified operational view of the exact signed DACS-1 Listing version. */
export interface SellerFulfilmentListing {
  pin: ListingRef;
  sellerPrimaryClaim: string;
  /** Exact signed `Listing.buyerRequirement`. */
  buyerRequirement: BundleRequirement;
  pipeline: PhaseStep[];
  /** Exact signed `Listing.offering.deliverable`, not a re-derived projection. */
  deliverable: DeliverableSpec;
}

export type SellerFulfilmentResolution<T> =
  | { status: "verified"; value: T }
  | { status: "rejected"; reason: string }
  | { status: "indeterminate"; reason: string };

export interface SellerFulfilmentRequest {
  agreementRef: string;
  agreementHash: string;
  commitmentRef: string;
  deliveryPhaseIndex: number;
  /** Opaque, one-shot bearer capability returned by seller payment intake. */
  paymentPermitId: string;
  /** Exact pre-commit DPA-1 producer admission returned by payment intake. */
  payloadVerificationProducerAdmission?: SellerPayloadVerificationProducerAdmission;
}

export type SellerDeliveredAccess =
  | { model: "public" }
  | { model: "buyer-only"; allowed: string[] }
  | { model: "encrypt-to-buyer"; encryptionRecipient: string };

/**
 * Independently resolved delivery content. It deliberately contains no caller-
 * supplied anchor locator or "verified" booleans: the core derives the logical
 * address and authenticates the accompanying AnchorReceipt.
 */
export interface SellerDeliveredArtifact {
  kind: SellerDeliveryPhase;
  /** Cleartext JSON value whose JCS bytes are committed by delivery evidence. */
  cleartextPayload?: unknown;
  /** Exact DPA-2 cleartext bytes delivered to the buyer. */
  cleartextBytes?: Uint8Array;
  /** Actual value independently read from the canonical SR-2 address. */
  anchoredValue?: unknown;
  access?: SellerDeliveredAccess;
  /** DPA-6 PayloadAttestationRecord reference; resolved separately by the core. */
  attestationRef?: SellerAttestationRef;
}

export interface SellerResolvedDelivery {
  artifact: SellerDeliveredArtifact;
  anchorReceipt: AnchorReceipt;
}

/** Side-effect-free candidate construction; only the core may authorize submit. */
export interface SellerPreparedDelivery {
  artifact: SellerDeliveredArtifact;
  /** Required only for attested payloads; raw SIG-5-preserving signed record. */
  payloadAttestationRecord?: unknown;
}

export type SellerDeliveryPreparation =
  | { status: "prepared"; delivery: SellerPreparedDelivery }
  | { status: "rejected" | "indeterminate"; reason: string };

export type SellerDeliverySubmission =
  | { status: "accepted"; reconciliationId: string }
  | { status: "rejected"; reason: string }
  | { status: "indeterminate"; reason: string; reconciliationId?: string };

export type SellerDeliveryReconciliation =
  | {
      status: "complete";
      reconciliationId: string;
      /** Immutable time of the terminal delivery event; identical on every replay. */
      observedAt: number;
    }
  | {
      status: "failed";
      reason: string;
      /** Stable time at which the reconciler authoritatively observed failure. */
      observedAt: number;
      reconciliationId?: string;
    }
  | { status: "pending" | "indeterminate"; reason: string; reconciliationId?: string }
  | {
      /** Binding-defined authoritative absence, never an ordinary not-found. */
      status: "absent";
      reason: string;
    };

/** @deprecated Use SellerDeliverySubmission/SellerDeliveryReconciliation. */
export type SellerDeliveryAttempt = SellerDeliverySubmission;

export type SellerEvidenceAnchorResult =
  | {
      status: "anchored";
      ref: SellerAttestationRef;
      anchorReceipt: AnchorReceipt;
    }
  | { status: "rejected"; reason: string }
  | { status: "indeterminate"; reason: string };

/**
 * V2 resolver for one atomic authenticated SessionRecord plus the complete
 * pre-delivery artifact/provenance inventory retained with permit consumption.
 */
export type SellerFulfilmentAuditSourceResolver = (
  jobId: string,
) => Promise<SellerFulfilmentResolution<unknown>>;

interface SellerFulfilmentDepsBase {
  /** Authoritative store created by verifySellerPaymentIntake. */
  receiptStore: SellerFulfilmentReceiptStore;
  /** `verified` means both agreement signatures and finalized commitment were checked. */
  resolveAgreement: (
    ref: string,
  ) => Promise<SellerFulfilmentResolution<SellerFulfilmentAgreement>>;
  /** `verified` means the exact signed Listing pin was validated historically. */
  resolveListing: (
    pin: Readonly<ListingRef>,
  ) => Promise<SellerFulfilmentResolution<SellerFulfilmentListing>>;
  /** Build a candidate without writing, disclosing, or invoking an irreversible effect. */
  prepareDelivery: (input: {
    fulfilmentId: string;
    jobId: string;
    phaseIndex: number;
    phase: SellerDeliveryPhase;
    /** Core-derived canonical SR-2 address; preparers must not choose one. */
    logicalAddress: string;
    agreement: Readonly<SellerFulfilmentAgreement>;
    deliverable: Readonly<SellerDeliverableSpec>;
  }) => Promise<SellerDeliveryPreparation>;
  /**
   * Submit the exact retained candidate only after the permit and handoff are
   * atomically committed. Implementations MUST atomically deduplicate by
   * `fulfilmentId`: the same id/exact `artifactHash` replays one operation, while
   * the same id with different work MUST fail closed.
   */
  submitDelivery: (input: {
    fulfilmentId: string;
    jobId: string;
    phaseIndex: number;
    phase: SellerDeliveryPhase;
    /** Exact core-derived canonical SR-2 destination for the retained artifact. */
    logicalAddress: string;
    agreement: Readonly<SellerFulfilmentAgreement>;
    deliverable: Readonly<SellerDeliverableSpec>;
    artifact: Readonly<SellerDeliveredArtifact>;
    /** Operational idempotency binding; not a DACS signed field. */
    artifactHash: string;
  }) => Promise<SellerDeliverySubmission>;
  /**
   * Independent idempotency-key reconciliation; must not invoke application
   * work. A terminal status is a durable fact: its status, reason (if any),
   * reconciliation id, and `observedAt` MUST replay identically. `observedAt`
   * is the terminal event time, never the time of the current poll.
   */
  reconcileDelivery: (input: {
    fulfilmentId: string;
    jobId: string;
    phaseIndex: number;
    phase: SellerDeliveryPhase;
    reconciliationId?: string;
  }) => Promise<SellerDeliveryReconciliation>;
  /** Independent read from the core-derived canonical delivery address. */
  resolveDelivery: (input: {
    logicalAddress: string;
    jobId: string;
    phaseIndex: number;
    phase: SellerDeliveryPhase;
  }) => Promise<SellerFulfilmentResolution<SellerResolvedDelivery>>;
  /** Authenticate binding-native AnchorReceipt evidence (CORE SR2-4..SR2-7). */
  verifyAnchorReceipt: (input: {
    purpose: "delivery" | "payload-attestation" | "settlement-evidence";
    /** Binding adapter must prove this claim controls the receipt writer. */
    expectedWriter: {
      role: "seller" | "phase-orchestrator";
      primaryClaim: string;
    };
    ref: Readonly<SellerAttestationRef>;
    receipt: Readonly<AnchorReceipt>;
  }) => Promise<SellerVerificationResult> | SellerVerificationResult;
  /** Validate a signed-listing schema against the actual cleartext storage value. */
  verifyDeliverySchema?: (input: {
    schemaUrl: string;
    cleartextPayload: unknown;
  }) => Promise<SellerVerificationResult> | SellerVerificationResult;
  /** DV-3 cryptographic proof that the anchored envelope opens to the cleartext for the bound buyer key. */
  verifyEncryptedDelivery?: (input: {
    anchoredValue: unknown;
    cleartextPayload: unknown;
    encryptionRecipient: string;
  }) => Promise<SellerVerificationResult> | SellerVerificationResult;
  /** Resolve raw DPA record bytes; the core verifies hash/signature/proof itself. */
  resolvePayloadAttestation?: (
    ref: Readonly<SellerAttestationRef>,
  ) => Promise<SellerFulfilmentResolution<SellerResolvedPayloadAttestation>>;
  /** Idempotently anchor the exact prevalidated DPA record after permit consumption. */
  anchorPayloadAttestation?: (input: {
    record: Readonly<Record<string, unknown>>;
    recordHash: string;
    ref: Readonly<SellerAttestationRef>;
  }) => Promise<SellerEvidenceAnchorResult>;
  /** DPA-1 producer support for the exact method/spec, checked before permit consumption. */
  resolvePayloadVerificationCapability?: (
    input: SellerPayloadVerificationCapabilityInput,
  ) =>
    | Promise<SellerPayloadVerificationCapabilityDecision>
    | SellerPayloadVerificationCapabilityDecision;
  verifyPayloadAttestationSignature?: (input: {
    record: Readonly<SellerPayloadAttestationRecord>;
    signedBytes: Uint8Array;
    signature: Readonly<ComponentSignature>;
  }) => Promise<SellerVerificationResult> | SellerVerificationResult;
  /**
   * DPA-3/DPA-8 verifier. `valid` means the independently resolved native proof,
   * every method-specific signature/authority rule, and any authoritative native
   * transaction all commit to `payloadContentHash`.
   */
  verifyPayloadMethodProof?: (input: {
    verificationMethod: Readonly<VerificationMethod>;
    record: Readonly<SellerPayloadAttestationRecord>;
    methodEvidenceRef: Readonly<SellerAttestationRef>;
  }) => Promise<SellerVerificationResult> | SellerVerificationResult;
  verifyEntitlementSignature?: (input: {
    record: Readonly<Record<string, unknown>>;
    signedBytes: Uint8Array;
    signature: Readonly<ComponentSignature>;
  }) => Promise<SellerVerificationResult> | SellerVerificationResult;
  evidenceSigner: BuildComponentSignatureOptions;
  /** Independent orchestrator signer for the pre-consumption durable handoff. */
  auditSourceCommitmentSigner: BuildComponentSignatureOptions;
  /** Cryptographically verify the exact signed SettlementEvidence before use. */
  verifyEvidenceSignature: (input: {
    evidence: Readonly<SignedSellerDeliveryEvidence>;
    signedBytes: Uint8Array;
    signature: Readonly<ComponentSignature>;
    expectedSigner: string;
  }) => Promise<SellerVerificationResult> | SellerVerificationResult;
  /** Verify the SIG-4 audit-source commitment before relying on its hash. */
  verifyAuditSourceCommitmentSignature: (input: {
    commitment: Readonly<SellerFulfilmentAuditSourceCommitmentV1>;
    signedBytes: Uint8Array;
    signature: Readonly<ComponentSignature>;
    expectedSigner: string;
  }) => Promise<SellerVerificationResult> | SellerVerificationResult;
  /**
   * Atomically publish by `fulfilmentId`. The same id and evidence hash must
   * return the original ref/receipt; the same id with a different hash must
   * fail closed and must never replace the first publication.
   */
  anchorEvidence: (input: {
    fulfilmentId: string;
    evidence: Readonly<SignedSellerDeliveryEvidence>;
    evidenceHash: string;
  }) => Promise<SellerEvidenceAnchorResult>;
  /** Independently read the exact signed SettlementEvidence at its anchored ref. */
  resolveEvidence: (
    ref: Readonly<SellerAttestationRef>,
  ) => Promise<SellerFulfilmentResolution<unknown>>;
  nowMs: () => number;
}

/** V2-only fulfilment dependencies with one atomic authenticated audit source. */
export interface SellerFulfilmentDeps extends SellerFulfilmentDepsBase {
  auditSourceProfile: "v2";
  resolveAuditSource: SellerFulfilmentAuditSourceResolver;
}

type SellerFulfilmentDepsCapture =
  | { status: "captured"; deps: SellerFulfilmentDeps }
  | { status: "invalid"; reason: string };

function bindCaptured<T>(callback: T, owner: unknown): T {
  return Function.prototype.bind.call(callback as unknown as Function, owner) as T;
}

/**
 * Snapshot every executable authority exactly once before the first await.
 * Bound methods remain stable if a caller later swaps properties on the
 * original object, a getter, or a Proxy. The core only sees these frozen plain
 * objects and never dereferences the caller-owned dependency graph again.
 */
function captureSellerFulfilmentDeps(source: SellerFulfilmentDeps): SellerFulfilmentDepsCapture {
  try {
    const receiptStoreSource = source.receiptStore;
    const resolveAgreementSource = source.resolveAgreement;
    const resolveListingSource = source.resolveListing;
    const resolveAuditSourceSource = source.resolveAuditSource;
    const auditSourceProfile = source.auditSourceProfile;
    const prepareDeliverySource = source.prepareDelivery;
    const submitDeliverySource = source.submitDelivery;
    const reconcileDeliverySource = source.reconcileDelivery;
    const resolveDeliverySource = source.resolveDelivery;
    const verifyAnchorReceiptSource = source.verifyAnchorReceipt;
    const verifyDeliverySchemaSource = source.verifyDeliverySchema;
    const verifyEncryptedDeliverySource = source.verifyEncryptedDelivery;
    const resolvePayloadAttestationSource = source.resolvePayloadAttestation;
    const anchorPayloadAttestationSource = source.anchorPayloadAttestation;
    const resolvePayloadVerificationCapabilitySource = source.resolvePayloadVerificationCapability;
    const verifyPayloadAttestationSignatureSource = source.verifyPayloadAttestationSignature;
    const verifyPayloadMethodProofSource = source.verifyPayloadMethodProof;
    const verifyEntitlementSignatureSource = source.verifyEntitlementSignature;
    const evidenceSignerSource = source.evidenceSigner;
    const auditSourceCommitmentSignerSource = source.auditSourceCommitmentSigner;
    const verifyEvidenceSignatureSource = source.verifyEvidenceSignature;
    const verifyAuditSourceCommitmentSignatureSource =
      source.verifyAuditSourceCommitmentSignature;
    const anchorEvidenceSource = source.anchorEvidence;
    const resolveEvidenceSource = source.resolveEvidence;
    const nowMsSource = source.nowMs;

    if (auditSourceProfile !== "v2") {
      return { status: "invalid", reason: "fulfilment audit-source profile is unsupported" };
    }

    if (!receiptStoreSource || typeof receiptStoreSource !== "object" ||
        !evidenceSignerSource || typeof evidenceSignerSource !== "object" ||
        !auditSourceCommitmentSignerSource ||
        typeof auditSourceCommitmentSignerSource !== "object") {
      return { status: "invalid", reason: "receipt store or fulfilment signer is unavailable" };
    }
    const claimSource = receiptStoreSource.claim;
    const inspectPermitSource = receiptStoreSource.inspectPermit;
    const consumePermitSource = receiptStoreSource.consumePermit;
    const evidenceAlgorithm = evidenceSignerSource.algorithm;
    const evidenceSignerClaim = evidenceSignerSource.signer;
    const evidenceSignSource = evidenceSignerSource.sign;
    const auditSourceCommitmentAlgorithm = auditSourceCommitmentSignerSource.algorithm;
    const auditSourceCommitmentSignerClaim = auditSourceCommitmentSignerSource.signer;
    const auditSourceCommitmentSignSource = auditSourceCommitmentSignerSource.sign;

    const required = [
      resolveAgreementSource,
      resolveListingSource,
      prepareDeliverySource,
      submitDeliverySource,
      reconcileDeliverySource,
      resolveDeliverySource,
      verifyAnchorReceiptSource,
      anchorEvidenceSource,
      resolveEvidenceSource,
      nowMsSource,
      claimSource,
      inspectPermitSource,
      consumePermitSource,
      evidenceSignSource,
      auditSourceCommitmentSignSource,
      verifyEvidenceSignatureSource,
      verifyAuditSourceCommitmentSignatureSource,
    ];
    if (required.some((candidate) => typeof candidate !== "function")) {
      return { status: "invalid", reason: "a required fulfilment dependency is not callable" };
    }
    const optionals = [
      verifyDeliverySchemaSource,
      verifyEncryptedDeliverySource,
      resolvePayloadAttestationSource,
      anchorPayloadAttestationSource,
      resolvePayloadVerificationCapabilitySource,
      verifyPayloadAttestationSignatureSource,
      verifyPayloadMethodProofSource,
      verifyEntitlementSignatureSource,
      resolveAuditSourceSource,
    ];
    if (optionals.some((candidate) => candidate !== undefined && typeof candidate !== "function")) {
      return { status: "invalid", reason: "an optional fulfilment dependency is not callable" };
    }
    if (typeof resolveAuditSourceSource !== "function") {
      return {
        status: "invalid",
        reason: "v2 fulfilment dependencies do not satisfy their resolver profile",
      };
    }

    const receiptStore: SellerFulfilmentReceiptStore = Object.freeze({
      claim: bindCaptured(claimSource, receiptStoreSource),
      inspectPermit: bindCaptured(inspectPermitSource, receiptStoreSource),
      consumePermit: bindCaptured(consumePermitSource, receiptStoreSource),
    });
    const evidenceSigner: BuildComponentSignatureOptions = Object.freeze({
      algorithm: evidenceAlgorithm,
      signer: evidenceSignerClaim,
      sign: bindCaptured(evidenceSignSource, evidenceSignerSource),
    });
    const auditSourceCommitmentSigner: BuildComponentSignatureOptions = Object.freeze({
      algorithm: auditSourceCommitmentAlgorithm,
      signer: auditSourceCommitmentSignerClaim,
      sign: bindCaptured(
        auditSourceCommitmentSignSource,
        auditSourceCommitmentSignerSource,
      ),
    });
    const captured = Object.freeze({
      receiptStore,
      auditSourceProfile,
      resolveAgreement: bindCaptured(resolveAgreementSource, source),
      resolveListing: bindCaptured(resolveListingSource, source),
      resolveAuditSource: bindCaptured(resolveAuditSourceSource, source),
      prepareDelivery: bindCaptured(prepareDeliverySource, source),
      submitDelivery: bindCaptured(submitDeliverySource, source),
      reconcileDelivery: bindCaptured(reconcileDeliverySource, source),
      resolveDelivery: bindCaptured(resolveDeliverySource, source),
      verifyAnchorReceipt: bindCaptured(verifyAnchorReceiptSource, source),
      ...(verifyDeliverySchemaSource
        ? { verifyDeliverySchema: bindCaptured(verifyDeliverySchemaSource, source) }
        : {}),
      ...(verifyEncryptedDeliverySource
        ? { verifyEncryptedDelivery: bindCaptured(verifyEncryptedDeliverySource, source) }
        : {}),
      ...(resolvePayloadAttestationSource
        ? { resolvePayloadAttestation: bindCaptured(resolvePayloadAttestationSource, source) }
        : {}),
      ...(anchorPayloadAttestationSource
        ? { anchorPayloadAttestation: bindCaptured(anchorPayloadAttestationSource, source) }
        : {}),
      ...(resolvePayloadVerificationCapabilitySource
        ? {
            resolvePayloadVerificationCapability:
              bindCaptured(resolvePayloadVerificationCapabilitySource, source),
          }
        : {}),
      ...(verifyPayloadAttestationSignatureSource
        ? {
            verifyPayloadAttestationSignature:
              bindCaptured(verifyPayloadAttestationSignatureSource, source),
          }
        : {}),
      ...(verifyPayloadMethodProofSource
        ? { verifyPayloadMethodProof: bindCaptured(verifyPayloadMethodProofSource, source) }
        : {}),
      ...(verifyEntitlementSignatureSource
        ? { verifyEntitlementSignature: bindCaptured(verifyEntitlementSignatureSource, source) }
        : {}),
      evidenceSigner,
      auditSourceCommitmentSigner,
      verifyEvidenceSignature: bindCaptured(verifyEvidenceSignatureSource, source),
      verifyAuditSourceCommitmentSignature:
        bindCaptured(verifyAuditSourceCommitmentSignatureSource, source),
      anchorEvidence: bindCaptured(anchorEvidenceSource, source),
      resolveEvidence: bindCaptured(resolveEvidenceSource, source),
      nowMs: bindCaptured(nowMsSource, source),
    }) as SellerFulfilmentDeps;
    return { status: "captured", deps: captured };
  } catch (error) {
    return {
      status: "invalid",
      reason: `fulfilment dependency capture failed: ${String(error)}`,
    };
  }
}

export type SignedSellerDeliveryEvidence = (
  | SellerDeliverySuccessEvidence
  | SellerDeliveryFailureEvidence
) & { signature: ComponentSignature };

interface SellerDeliveryEvidenceBase {
  /**
   * Signed operational extension committing the exact pre-delivery audit
   * source retained with permit consumption. SIG-5 preserves this field.
   */
  dacsSdkAuditSourceHash?: string;
  evidenceVersion: "1";
  jobId: string;
  phase: SellerDeliveryPhase;
  observedAt: number;
}

/** Exact DACS-4 §9.7 success delivery evidence; no SDK-only phase index. */
export interface SellerDeliverySuccessEvidence extends SellerDeliveryEvidenceBase {
  outcome: "success";
  deliverableContentHash: string;
  deliverableAnchor: { kind: string; locator: string };
  attestationRef?: SellerAttestationRef;
}

/** Exact DACS-4 §9.7 failure delivery evidence. */
export interface SellerDeliveryFailureEvidence extends SellerDeliveryEvidenceBase {
  outcome: "failure";
  reason: string;
}

export interface SellerBundleContribution {
  phaseSummary: {
    index: number;
    kind: SellerDeliveryPhase;
    outcome: "ok" | "fail";
    errorClass?: "permanent" | "transient" | "counterparty" | "substrate";
    attestationRef: SellerAttestationRef;
  };
  settlementEvidence: SellerAttestationRef;
}

type SellerFulfilmentInternalResult =
  | {
      decision: "completed";
      fulfilmentId: string;
      evidence: SignedSellerDeliveryEvidence;
      evidenceHash: string;
      evidenceRef: SellerAttestationRef;
      evidenceAnchorReceipt: AnchorReceipt;
      bundleContribution: SellerBundleContribution;
    }
  | {
      decision: "failed";
      fulfilmentId: string;
      errorClass: "permanent" | "transient" | "counterparty" | "substrate";
      evidence: SignedSellerDeliveryEvidence;
      evidenceHash: string;
      evidenceRef: SellerAttestationRef;
      evidenceAnchorReceipt: AnchorReceipt;
      bundleContribution: SellerBundleContribution;
    }
  | { decision: "rejected"; code: string; reasons: string[] }
  | {
      decision: "indeterminate";
      code: string;
      reasons: string[];
      fulfilmentId?: string;
      safeToRetryDelivery: boolean;
      recovery?: {
        action:
          | "reconcile-delivery"
          | "reconcile-payload-attestation"
          | "retry-evidence-publication";
        reconciliationId?: string;
      };
      evidenceDraft?: SellerDeliverySuccessEvidence | SellerDeliveryFailureEvidence;
      evidence?: SignedSellerDeliveryEvidence;
      evidenceHash?: string;
    };

/**
 * Fulfilment outcome with the exact store-retained authorization that was
 * already consumed. The receipt store retains that authority with the complete
 * recovery handoff; request fields and caller-constructed intake results are
 * never an authorization source.
 */
export type SellerFulfilmentResult =
  | (Extract<SellerFulfilmentInternalResult, { decision: "completed" | "failed" }> & {
      consumedPaymentAuthorization: SellerPaymentAuthorization;
    })
  | Extract<SellerFulfilmentInternalResult, { decision: "rejected" }>
  | (Extract<SellerFulfilmentInternalResult, { decision: "indeterminate" }> & {
      /** Present iff the receipt store proved the authorization was consumed. */
      consumedPaymentAuthorization?: SellerPaymentAuthorization;
    });

const rejected = (code: string, ...reasons: string[]): SellerFulfilmentInternalResult => ({
  decision: "rejected",
  code,
  reasons,
});

const indeterminate = (
  code: string,
  reasons: string[],
  options: Omit<Extract<SellerFulfilmentInternalResult, { decision: "indeterminate" }>, "decision" | "code" | "reasons">,
): SellerFulfilmentInternalResult => ({ decision: "indeterminate", code, reasons, ...options });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isNonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;
const isSafeUint = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 &&
  !Object.is(value, -0);
const isPositiveSafeInt = (value: unknown): value is number =>
  isSafeUint(value) && value > 0;
const isHash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/** Reject JavaScript views that JCS would silently alias to different values. */
function hasExactJcsView(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === undefined || typeof value === "function" || typeof value === "symbol" ||
      typeof value === "bigint") return false;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) return false;
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index) ||
          !hasExactJcsView(value[index], seen)) return false;
    }
    return true;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor) ||
        !hasExactJcsView(descriptor.value, seen)) return false;
  }
  return true;
}

const exact = (left: unknown, right: unknown): boolean => {
  try {
    return canonicalize(left) === canonicalize(right);
  } catch {
    return false;
  }
};
const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));
const isAbsoluteUrl = (value: unknown): value is string => {
  if (!isNonEmpty(value)) return false;
  try {
    return new URL(value).href === value;
  } catch {
    return false;
  }
};

function parseResolution(
  value: unknown,
): SellerFulfilmentResolution<unknown> | null {
  if (!isRecord(value)) return null;
  if (value.status === "verified" && hasOnlyKeys(value, ["status", "value"]) &&
      Object.prototype.hasOwnProperty.call(value, "value")) {
    return value as unknown as SellerFulfilmentResolution<unknown>;
  }
  if ((value.status === "rejected" || value.status === "indeterminate") &&
      hasOnlyKeys(value, ["status", "reason"]) && isNonEmpty(value.reason)) {
    return value as unknown as SellerFulfilmentResolution<unknown>;
  }
  return null;
}

const absent = Symbol("absent-own-data-property");

function parseAuditSourceResolution(
  value: unknown,
): SellerFulfilmentResolution<SellerFulfilmentAuditSourceV1> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      nodeTypes.isProxy(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) return null;
    const data = (key: string): unknown | typeof absent => {
      const descriptor = descriptors[key];
      return descriptor?.enumerable === true && "value" in descriptor &&
          descriptor.value !== undefined
        ? descriptor.value
        : absent;
    };
    const status = data("status");
    if (status === "verified" && ownKeys.length === 2 &&
        ownKeys.includes("status") && ownKeys.includes("value")) {
      const source = data("value");
      return source !== absent && isSellerFulfilmentAuditSource(source)
        ? { status: "verified", value: source }
        : null;
    }
    if ((status === "rejected" || status === "indeterminate") &&
        ownKeys.length === 2 && ownKeys.includes("status") && ownKeys.includes("reason")) {
      const reason = data("reason");
      return isNonEmpty(reason) ? { status, reason } : null;
    }
    return null;
  } catch {
    return null;
  }
}

function isListingRefValue(value: unknown): value is ListingRef {
  return isRecord(value) && hasOnlyKeys(value, ["listingId", "version", "contentHash"]) &&
    isNonEmpty(value.listingId) && isPositiveSafeInt(value.version) && isHash(value.contentHash);
}

function isProducerAdmissionValue(
  value: unknown,
): value is SellerPayloadVerificationProducerAdmission {
  return isRecord(value) && hasOnlyKeys(value, [
    "operation",
    "disposition",
    "listingRef",
    "verificationMethodKind",
    "verificationMethodHash",
    "deliverableSpecHash",
    "admittedAt",
  ]) && Object.keys(value).length === 7 && value.operation === "produce" &&
    value.disposition === "supported" && isListingRefValue(value.listingRef) &&
    isNonEmpty(value.verificationMethodKind) && isHash(value.verificationMethodHash) &&
    isHash(value.deliverableSpecHash) && isSafeUint(value.admittedAt);
}

function fulfilmentRequestViolation(
  request: unknown,
): { code: string; reason: string } | null {
  if (!isRecord(request) || !hasOnlyKeys(request, [
    "agreementRef", "agreementHash", "commitmentRef", "deliveryPhaseIndex", "paymentPermitId",
    "payloadVerificationProducerAdmission",
  ])) {
    return { code: "invalid-request", reason: "fulfilment request has unknown or malformed fields" };
  }
  if (!isPositiveSafeInt(request.deliveryPhaseIndex)) {
    return {
      code: "invalid-delivery-phase",
      reason: "deliveryPhaseIndex must be a positive safe integer",
    };
  }
  if (!isNonEmpty(request.paymentPermitId) || !isNonEmpty(request.agreementRef) ||
      !isHash(request.agreementHash) || !isNonEmpty(request.commitmentRef)) {
    return { code: "invalid-request", reason: "permit/agreement/commitment references are malformed" };
  }
  if (Object.prototype.hasOwnProperty.call(request, "payloadVerificationProducerAdmission") &&
      !isProducerAdmissionValue(request.payloadVerificationProducerAdmission)) {
    return {
      code: "payload-producer-admission-malformed",
      reason: "payloadVerificationProducerAdmission must be the exact DPA-1 producer-admission shape",
    };
  }
  return null;
}

function isAgreementValue(value: unknown): value is SellerFulfilmentAgreement {
  if (!isRecord(value) || !hasExactJcsView(value) || !hasOnlyKeys(value, [
    "artifactKind", "ref", "contentHash", "jobId", "listingPin", "buyer", "seller",
    "deliverableRef", "commitment",
  ]) || value.artifactKind !== "payee-bound" || !isNonEmpty(value.ref) ||
      !isHash(value.contentHash) || !isNonEmpty(value.jobId) ||
      !isListingRefValue(value.listingPin) || !isRecord(value.buyer) ||
      !hasOnlyKeys(value.buyer, [
        "primaryClaim", "bundleHash", "vetRecordRef", "storageAddress", "encryptionKey",
      ]) ||
      !isNonEmpty(value.buyer.primaryClaim) || !isHash(value.buyer.bundleHash) ||
      !isAttestationRef(value.buyer.vetRecordRef) ||
      (Object.prototype.hasOwnProperty.call(value.buyer, "storageAddress") &&
        !isNonEmpty(value.buyer.storageAddress)) ||
      (Object.prototype.hasOwnProperty.call(value.buyer, "encryptionKey") &&
        !isNonEmpty(value.buyer.encryptionKey)) ||
      !isRecord(value.seller) ||
      !hasOnlyKeys(value.seller, ["primaryClaim", "bundleHash", "vetRecordRef"]) ||
      !isNonEmpty(value.seller.primaryClaim) || !isHash(value.seller.bundleHash) ||
      !isAttestationRef(value.seller.vetRecordRef) ||
      !isRecord(value.deliverableRef) ||
      !hasOnlyKeys(value.deliverableRef, ["deliverableType", "hash", "schemaUrl"]) ||
      !["storage-program", "entitlement", "attested-payload"].includes(
        String(value.deliverableRef.deliverableType),
      ) || !isHash(value.deliverableRef.hash) ||
      (Object.prototype.hasOwnProperty.call(value.deliverableRef, "schemaUrl") &&
        !isNonEmpty(value.deliverableRef.schemaUrl)) ||
      !isRecord(value.commitment) || !hasOnlyKeys(value.commitment, [
        "status", "ref", "agreementHash", "recordContentHash", "finalizedAt", "signer",
      ]) || value.commitment.status !== "finalized" || !isNonEmpty(value.commitment.ref) ||
      !isHash(value.commitment.agreementHash) || !isHash(value.commitment.recordContentHash) ||
      !isNonEmpty(value.commitment.signer) ||
      !isSafeUint(value.commitment.finalizedAt)) return false;
  return true;
}

function isListingValue(value: unknown): value is SellerFulfilmentListing {
  return isRecord(value) && hasOnlyKeys(value, [
    "pin", "sellerPrimaryClaim", "buyerRequirement", "pipeline", "deliverable",
  ]) && isListingRefValue(value.pin) && isNonEmpty(value.sellerPrimaryClaim) &&
    isBundleRequirement(value.buyerRequirement) &&
    Array.isArray(value.pipeline) && value.pipeline.every(isPhaseStep) &&
    isDeliverableSpec(value.deliverable);
}

function isPayloadCapabilityDecision(
  value: unknown,
): value is SellerPayloadVerificationCapabilityDecision {
  if (!isRecord(value) || !hasOnlyKeys(value, ["disposition", "reason"])) return false;
  if (value.disposition === "supported") {
    return value.reason === undefined || typeof value.reason === "string";
  }
  return (value.disposition === "unsupported" || value.disposition === "indeterminate" ||
      value.disposition === "error") && isNonEmpty(value.reason);
}

function parseEvidenceAnchorResult(value: unknown): SellerEvidenceAnchorResult | null {
  if (!isRecord(value)) return null;
  if (value.status === "anchored" && hasOnlyKeys(value, ["status", "ref", "anchorReceipt"]) &&
      Object.prototype.hasOwnProperty.call(value, "ref") &&
      Object.prototype.hasOwnProperty.call(value, "anchorReceipt")) {
    return value as unknown as SellerEvidenceAnchorResult;
  }
  if ((value.status === "rejected" || value.status === "indeterminate") &&
      hasOnlyKeys(value, ["status", "reason"]) && isNonEmpty(value.reason)) {
    return value as unknown as SellerEvidenceAnchorResult;
  }
  return null;
}

function pinsEqual(left: ListingRef, right: ListingRef): boolean {
  return left.listingId === right.listingId &&
    left.version === right.version &&
    left.contentHash === right.contentHash;
}

/** CORE §B.1 CF-4 reserved delimiters in a logical-address variable segment. */
function logicalAddressSegment(value: string): string {
  return value.replace(/[%:?&=]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

function phaseFor(type: SellerDeliverableSpec["kind"]): SellerDeliveryPhase {
  if (type === "storage-program") return "deliver-storage-program";
  if (type === "entitlement") return "deliver-entitlement";
  return "deliver-attested-payload";
}

function deliveryAddress(jobId: string, phase: SellerDeliveryPhase): string {
  return phase === "deliver-entitlement"
    ? `dacs4:entitlement:${jobId}:0`
    : `dacs4:deliverable:${jobId}`;
}

/**
 * SDK-local idempotency identity for exactly one seller delivery invocation.
 * Canonical object hashing keeps attacker-controlled identifiers structurally
 * separated; delimiter-joined preimages can alias when values contain `:`.
 */
export function sellerFulfilmentId(input: {
  jobId: string;
  paymentPhaseIndex: number;
  deliveryPhaseIndex: number;
  settlementId: string;
  agreementHash: string;
  paymentEvidenceHash: string;
}): string {
  return sha256Hex(canonicalize({
    domain: "dacs-seller-fulfilment:v2",
    jobId: input.jobId,
    paymentPhaseIndex: input.paymentPhaseIndex,
    deliveryPhaseIndex: input.deliveryPhaseIndex,
    settlementId: input.settlementId,
    agreementHash: input.agreementHash,
    paymentEvidenceHash: input.paymentEvidenceHash,
  }));
}

function preparedArtifactHash(artifact: SellerDeliveredArtifact): string {
  if (artifact.kind !== "deliver-attested-payload") {
    return sha256Hex(canonicalize(artifact));
  }
  if (!(artifact.cleartextBytes instanceof Uint8Array) ||
      !(artifact.anchoredValue instanceof Uint8Array)) {
    throw new TypeError("attested-payload candidate bytes are missing");
  }
  return sha256Hex(canonicalize({
    kind: artifact.kind,
    cleartextBytes: {
      length: artifact.cleartextBytes.byteLength,
      sha256: sha256Hex(artifact.cleartextBytes),
    },
    anchoredValue: {
      length: artifact.anchoredValue.byteLength,
      sha256: sha256Hex(artifact.anchoredValue),
    },
    attestationRef: artifact.attestationRef,
  }));
}

function sameFulfilmentHandoff(
  left: SellerFulfilmentHandoff,
  right: SellerFulfilmentHandoff,
): boolean {
  const scalarKeys = [
    "handoffVersion",
    "fulfilmentId",
    "jobId",
    "agreementRef",
    "agreementHash",
    "commitmentRef",
    "authorizationHash",
    "settlementId",
    "paymentEvidenceHash",
    "paymentPhaseIndex",
    "deliveryPhaseIndex",
    "phase",
    "logicalAddress",
    "deliverableSpecHash",
    "agreementViewHash",
    "validationFloorAt",
  ] as const;
  if (scalarKeys.some((key) => left[key] !== right[key]) ||
      !exact(left.evidenceAuthority, right.evidenceAuthority) ||
      left.auditSourceHash !== right.auditSourceHash ||
      !exact(left.auditSource, right.auditSource) ||
      !exact(left.auditSourceCommitment, right.auditSourceCommitment) ||
      left.candidate.status !== right.candidate.status ||
      left.candidate.validatedAt !== right.candidate.validatedAt) return false;
  if (left.candidate.status === "preparation-failed" ||
      right.candidate.status === "preparation-failed") {
    return left.candidate.status === "preparation-failed" &&
      right.candidate.status === "preparation-failed" &&
      left.candidate.reason === right.candidate.reason;
  }
  const leftPayload = Object.prototype.hasOwnProperty.call(
    left.candidate.delivery,
    "payloadAttestationRecord",
  );
  const rightPayload = Object.prototype.hasOwnProperty.call(
    right.candidate.delivery,
    "payloadAttestationRecord",
  );
  return left.candidate.artifactHash === right.candidate.artifactHash &&
    leftPayload === rightPayload &&
    sameDeliveredArtifact(
      left.candidate.delivery.artifact as SellerDeliveredArtifact,
      right.candidate.delivery.artifact as SellerDeliveredArtifact,
    ) &&
    (!leftPayload || exact(
      left.candidate.delivery.payloadAttestationRecord,
      right.candidate.delivery.payloadAttestationRecord,
    ));
}

function handoffBindingViolation(
  handoff: SellerFulfilmentHandoff,
  authorization: SellerPaymentAuthorization,
  request: SellerFulfilmentRequest,
  id: string,
  phase: SellerDeliveryPhase,
  logicalAddress: string,
  deliverableSpecHash: string,
  agreementViewHash: string,
  evidenceSigner: Pick<BuildComponentSignatureOptions, "signer" | "algorithm">,
): string | null {
  let authorizationHash: string;
  try {
    authorizationHash = sha256Hex(canonicalize(authorization));
  } catch {
    return "retained payment authorization is not canonicalizable";
  }
  if (handoff.fulfilmentId !== id || handoff.jobId !== authorization.jobId ||
      handoff.agreementRef !== request.agreementRef ||
      handoff.agreementHash !== authorization.agreementHash ||
      handoff.commitmentRef !== request.commitmentRef ||
      handoff.authorizationHash !== authorizationHash ||
      handoff.settlementId !== authorization.settlementId ||
      handoff.paymentEvidenceHash !== authorization.evidenceHash ||
      handoff.paymentPhaseIndex !== authorization.phaseIndex ||
      handoff.deliveryPhaseIndex !== request.deliveryPhaseIndex ||
      handoff.phase !== phase || handoff.logicalAddress !== logicalAddress ||
      handoff.deliverableSpecHash !== deliverableSpecHash ||
      handoff.agreementViewHash !== agreementViewHash ||
      handoff.validationFloorAt < Math.max(
        authorization.commitment.finalizedAt,
        authorization.evidenceInput.observedAt,
      ) ||
      handoff.validationFloorAt > handoff.candidate.validatedAt ||
      handoff.evidenceAuthority.primaryClaim !== evidenceSigner.signer ||
      handoff.evidenceAuthority.algorithm !== evidenceSigner.algorithm) {
    return "retained fulfilment handoff does not bind the exact authorization, request, and deliverable";
  }
  return null;
}

function sameDeliveredArtifact(
  left: SellerDeliveredArtifact,
  right: SellerDeliveredArtifact,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind !== "deliver-attested-payload" ||
      right.kind !== "deliver-attested-payload") return exact(left, right);
  const attestedKeys = ["kind", "cleartextBytes", "anchoredValue", "attestationRef"];
  return hasOnlyKeys(left as unknown as Record<string, unknown>, attestedKeys) &&
    hasOnlyKeys(right as unknown as Record<string, unknown>, attestedKeys) &&
    left.cleartextBytes instanceof Uint8Array &&
    right.cleartextBytes instanceof Uint8Array &&
    left.anchoredValue instanceof Uint8Array &&
    right.anchoredValue instanceof Uint8Array &&
    Buffer.from(left.cleartextBytes).equals(Buffer.from(right.cleartextBytes)) &&
    Buffer.from(left.anchoredValue).equals(Buffer.from(right.anchoredValue)) &&
    exact(left.attestationRef, right.attestationRef);
}

function validateSpec(spec: SellerDeliverableSpec): string | null {
  if (!hasExactJcsView(spec)) {
    return "DeliverableSpec contains a JCS-ambiguous JavaScript value";
  }
  if (!isDeliverableSpec(spec)) return "DeliverableSpec is malformed or unsupported";
  if (spec.kind === "storage-program") return null;
  if (spec.kind === "entitlement") {
    return isPositiveSafeInt(spec.durationSec) &&
        Number.isSafeInteger(spec.durationSec * 1_000)
      ? null
      : "entitlement durationSec must be a positive safe integer";
  }
  return isNonEmpty(spec.payloadFormat) &&
      isRecord(spec.verificationMethod) &&
      isNonEmpty(spec.verificationMethod.kind)
    ? null
    : "attested-payload verificationMethod is required by DPA-1";
}

async function preflightPayloadCapability(
  spec: Extract<SellerDeliverableSpec, { kind: "attested-payload" }>,
  deliverableSpecHash: string,
  deps: SellerFulfilmentDeps,
): Promise<
  | { status: "ok" }
  | { status: "unsupported" | "indeterminate"; reason: string }
> {
  if (!spec.verificationMethod || !deps.resolvePayloadVerificationCapability ||
      !deps.resolvePayloadAttestation || !deps.verifyPayloadAttestationSignature ||
      !deps.verifyPayloadMethodProof || !deps.anchorPayloadAttestation) {
    return {
      status: "unsupported",
      reason: "complete attested-payload producer and verifier capabilities are not configured",
    };
  }
  let verificationMethod: VerificationMethod;
  let deliverableSpec: typeof spec;
  let methodCanonical: string;
  let specCanonical: string;
  let methodHash: string;
  try {
    verificationMethod = structuredClone(spec.verificationMethod);
    deliverableSpec = structuredClone(spec);
    methodCanonical = canonicalize(verificationMethod);
    specCanonical = canonicalize(deliverableSpec);
    methodHash = sha256Hex(methodCanonical);
    if (sha256Hex(specCanonical) !== deliverableSpecHash) {
      return { status: "unsupported", reason: "DPA-1 DeliverableSpec identity changed before preflight" };
    }
  } catch (error) {
    return { status: "unsupported", reason: `DPA-1 capability input is invalid: ${String(error)}` };
  }
  const capabilityInput: SellerPayloadVerificationCapabilityInput = {
    operation: "produce",
    verificationMethod,
    verificationMethodHash: methodHash,
    deliverableSpec,
    deliverableSpecHash,
  };
  let capabilityInputBefore: string;
  let decision: unknown;
  try {
    capabilityInputBefore = canonicalize(capabilityInput);
    decision = structuredClone(await deps.resolvePayloadVerificationCapability(capabilityInput));
  } catch (error) {
    return { status: "indeterminate", reason: `DPA-1 capability resolution threw: ${String(error)}` };
  }
  try {
    if (canonicalize(capabilityInput) !== capabilityInputBefore ||
        canonicalize(verificationMethod) !== methodCanonical ||
        canonicalize(deliverableSpec) !== specCanonical) {
      return { status: "indeterminate", reason: "DPA-1 capability resolver mutated its exact inputs" };
    }
  } catch {
    return { status: "indeterminate", reason: "DPA-1 capability resolver corrupted its exact inputs" };
  }
  if (!isPayloadCapabilityDecision(decision)) {
    return { status: "indeterminate", reason: "DPA-1 capability resolver returned a malformed decision" };
  }
  if (decision.disposition === "supported") return { status: "ok" };
  return {
    status: decision.disposition === "unsupported" ? "unsupported" : "indeterminate",
    reason: decision.reason,
  };
}

function validVerification(value: unknown): value is SellerVerificationResult {
  if (!isRecord(value) || !["valid", "invalid", "indeterminate", "error"].includes(String(value.disposition))) {
    return false;
  }
  return value.disposition === "valid"
    ? hasOnlyKeys(value, ["disposition"])
    : hasOnlyKeys(value, ["disposition", "reason"]) && isNonEmpty(value.reason);
}

function validateAccess(
  expected: "public" | "buyer-only" | "encrypt-to-buyer",
  delivered: unknown,
  buyer: SellerFulfilmentAgreement["buyer"],
): { status: "ok" } | { status: "indeterminate" | "invalid"; reason: string } {
  if (!isRecord(delivered)) {
    return { status: "invalid", reason: "resolved delivery access model is missing or malformed" };
  }
  let access: SellerDeliveredAccess;
  if (delivered.model === "public") {
    if (!hasOnlyKeys(delivered, ["model"])) {
      return { status: "invalid", reason: "public delivery access has unknown or malformed fields" };
    }
    access = { model: "public" };
  } else if (delivered.model === "buyer-only") {
    if (!hasOnlyKeys(delivered, ["model", "allowed"]) || !Array.isArray(delivered.allowed) ||
        !delivered.allowed.every(isNonEmpty)) {
      return { status: "invalid", reason: "buyer-only delivery access has an invalid allowed list" };
    }
    access = { model: "buyer-only", allowed: delivered.allowed };
  } else if (delivered.model === "encrypt-to-buyer") {
    if (!hasOnlyKeys(delivered, ["model", "encryptionRecipient"]) ||
        !isNonEmpty(delivered.encryptionRecipient)) {
      return { status: "invalid", reason: "encrypted delivery access has an invalid recipient" };
    }
    access = {
      model: "encrypt-to-buyer",
      encryptionRecipient: delivered.encryptionRecipient,
    };
  } else {
    return { status: "invalid", reason: "resolved delivery access discriminator is unsupported" };
  }

  if (expected !== "public" && access.model === "public") {
    return {
      status: "indeterminate",
      reason: `declared ${expected} delivery resolved as public (DV-2 confidentiality downgrade)`,
    };
  }
  if (expected !== "public" && access.model !== expected) {
    return { status: "invalid", reason: `resolved access model ${access.model} does not match ${expected}` };
  }
  if (access.model === "buyer-only") {
    if (!buyer.storageAddress || access.allowed.length !== 1 || access.allowed[0] !== buyer.storageAddress) {
      return { status: "invalid", reason: "buyer-only ACL is not bound exclusively to the agreement buyer" };
    }
  }
  if (access.model === "encrypt-to-buyer" &&
      (!buyer.encryptionKey || access.encryptionRecipient !== buyer.encryptionKey)) {
    return { status: "invalid", reason: "encrypted delivery is not bound to the agreement buyer key" };
  }
  return { status: "ok" };
}

function sessionRecordViolation(
  value: unknown,
  authorization: SellerPaymentAuthorization,
  agreement: SellerFulfilmentAgreement,
  listing: SellerFulfilmentListing,
  deliveryPhaseIndex: number,
  expectedCommitmentAddress: string,
): string | null {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "recordVersion", "jobId", "state", "listingRef", "parties", "pipeline",
    "phaseResults", "startedAt", "lastUpdatedAt", "endedAt",
    "recipeRegistryVersion", "railRegistryVersion", "amendments",
  ])) return "SessionRecord is not the exact DACS-5 §10.3 shape";
  if (value.recordVersion !== "1" || value.jobId !== authorization.jobId ||
      value.state !== "settle-pending" || value.endedAt !== undefined ||
      !isSafeUint(value.startedAt) || !isSafeUint(value.lastUpdatedAt) ||
      (value.lastUpdatedAt as number) < (value.startedAt as number) ||
      !isPositiveSafeInt(value.recipeRegistryVersion) ||
      value.railRegistryVersion !== authorization.railRegistryVersion ||
      (value.lastUpdatedAt as number) < authorization.evidenceInput.observedAt ||
      value.amendments !== undefined) {
    return "SessionRecord state, time, or registry pins do not authorize delivery";
  }
  if (!isRecord(value.listingRef) || !pinsEqual(value.listingRef as unknown as ListingRef, agreement.listingPin)) {
    return "SessionRecord Listing pin differs from the committed agreement";
  }
  if (!Array.isArray(value.pipeline) || !exact(value.pipeline, listing.pipeline)) {
    return "SessionRecord pipeline differs from the signed Listing pipeline";
  }
  if (!Array.isArray(value.parties)) return "SessionRecord parties are missing";
  const roles = new Set<string>();
  let buyer = false;
  let seller = false;
  for (const rawParty of value.parties) {
    if (!isRecord(rawParty) || !hasOnlyKeys(rawParty, ["role", "bundleHash", "primaryClaim", "vetRecordRef"]) ||
        !["buyer", "seller", "orchestrator"].includes(String(rawParty.role)) ||
        roles.has(String(rawParty.role)) || !isHash(rawParty.bundleHash) ||
        !isNonEmpty(rawParty.primaryClaim) ||
        (rawParty.vetRecordRef !== undefined && !isAttestationRef(rawParty.vetRecordRef))) {
      return "SessionRecord party roster is malformed or ambiguous";
    }
    roles.add(String(rawParty.role));
    if (rawParty.role === "buyer") {
      buyer = rawParty.bundleHash === agreement.buyer.bundleHash &&
        rawParty.primaryClaim === agreement.buyer.primaryClaim &&
        exact(rawParty.vetRecordRef, agreement.buyer.vetRecordRef);
    }
    if (rawParty.role === "seller") {
      seller = rawParty.bundleHash === agreement.seller.bundleHash &&
        rawParty.primaryClaim === agreement.seller.primaryClaim &&
        exact(rawParty.vetRecordRef, agreement.seller.vetRecordRef);
    }
  }
  if (!buyer || !seller) return "SessionRecord parties differ from the committed agreement";

  if (!Array.isArray(value.phaseResults) || value.phaseResults.length !== deliveryPhaseIndex) {
    return "SessionRecord must contain each and only the phases before delivery";
  }
  const indices = new Set<number>();
  let priorInvokedAt: number | undefined;
  for (let index = 0; index < deliveryPhaseIndex; index++) {
    const entry = value.phaseResults[index];
    if (!isRecord(entry) || !hasOnlyKeys(entry, ["index", "step", "invokedAt", "result", "contextDelta"]) ||
        entry.index !== index || indices.has(index) || !isPhaseStep(entry.step) ||
        !exact(entry.step, listing.pipeline[index]) || !isSafeUint(entry.invokedAt) ||
        (entry.invokedAt as number) < (value.startedAt as number) ||
        (entry.invokedAt as number) > (value.lastUpdatedAt as number) ||
        !isRecord(entry.result) || !isRecord(entry.contextDelta)) {
      return `SessionRecord phaseResults[${index}] is not the exact contiguous pipeline entry`;
    }
    if (priorInvokedAt !== undefined && (entry.invokedAt as number) < priorInvokedAt) {
      return "SessionRecord phase invocation times are not monotonic";
    }
    priorInvokedAt = entry.invokedAt as number;
    indices.add(index);
    const result = entry.result;
    if (!hasOnlyKeys(result, [
      "ok", "reason", "txRefs", "explorerUrls", "contextDelta", "attestationRef",
      "anchorReceipt", "errorClass",
    ]) || result.ok !== true || result.reason !== undefined || result.errorClass !== undefined ||
        (result.txRefs !== undefined &&
          (!Array.isArray(result.txRefs) || !result.txRefs.every(isChainTxRef))) ||
        (result.explorerUrls !== undefined &&
          (!Array.isArray(result.explorerUrls) || !result.explorerUrls.every(isAbsoluteUrl))) ||
        (result.contextDelta !== undefined && !isRecord(result.contextDelta)) ||
        !exact(result.contextDelta ?? {}, entry.contextDelta) ||
        (result.attestationRef !== undefined && !isAttestationRef(result.attestationRef)) ||
        (result.anchorReceipt !== undefined && !isAnchorReceipt(result.anchorReceipt))) {
      return `SessionRecord phaseResults[${index}] did not complete successfully`;
    }
  }

  const commitmentEntries = value.phaseResults.filter((entry) =>
    isRecord(entry) && isRecord(entry.step) &&
    (entry.step.kind === "commit-agreement" ||
      entry.step.kind === "commit-payee-bound-agreement"));
  if (commitmentEntries.length !== 1 ||
      commitmentEntries[0]!.step.kind !== "commit-payee-bound-agreement" ||
      commitmentEntries[0]!.index >= authorization.phaseIndex) {
    return "SessionRecord must contain one prior payee-bound commitment phase";
  }
  const commitmentEntry = commitmentEntries[0]!;
  const commitmentResult = commitmentEntry.result as Record<string, unknown>;
  const commitmentTxRefs = commitmentResult.txRefs;
  const commitmentDelta = (commitmentEntry.contextDelta as Record<string, unknown>)[
    "commit-payee-bound-agreement"
  ];
  if ((commitmentEntry.invokedAt as number) > authorization.commitment.finalizedAt ||
      !Array.isArray(commitmentTxRefs) || commitmentTxRefs.length !== 1 ||
      !isChainTxRef(commitmentTxRefs[0]) || !isRecord(commitmentDelta) ||
      !hasOnlyKeys(commitmentDelta, [
        "agreementHash", "anchorTxRef", "anchorReceipt", "committedAt",
      ]) || commitmentDelta.agreementHash !== authorization.agreementHash ||
      !exact(commitmentDelta.anchorTxRef, commitmentTxRefs[0]) ||
      !isAnchorReceipt(commitmentDelta.anchorReceipt) ||
      commitmentDelta.anchorReceipt.state !== "finalized" ||
      commitmentDelta.anchorReceipt.observationDisposition !== "established" ||
      commitmentDelta.anchorReceipt.logicalAddress !== expectedCommitmentAddress ||
      commitmentDelta.anchorReceipt.contentHash !== authorization.commitment.contentHash ||
      commitmentDelta.anchorReceipt.blockRef?.timestamp !==
        authorization.commitment.finalizedAt ||
      commitmentDelta.committedAt !== authorization.commitment.finalizedAt ||
      !exact(commitmentResult.contextDelta, commitmentEntry.contextDelta) ||
      (commitmentResult.anchorReceipt !== undefined &&
        !exact(commitmentResult.anchorReceipt, commitmentDelta.anchorReceipt)) ||
      (commitmentResult.attestationRef !== undefined &&
        (!isAttestationRef(commitmentResult.attestationRef) ||
          commitmentResult.attestationRef.anchor.kind !== "storage-program" ||
          commitmentResult.attestationRef.anchor.locator !== expectedCommitmentAddress ||
          commitmentResult.attestationRef.contentHash !==
            authorization.commitment.contentHash))) {
    return "SessionRecord commitment phase output differs from authenticated finality facts";
  }
  const paymentEntry = value.phaseResults[authorization.phaseIndex] as Record<string, unknown> | undefined;
  const paymentResult = paymentEntry?.result;
  const paymentStep = listing.pipeline[authorization.phaseIndex];
  const expectedPaymentAddress =
    `dacs4:payment:${authorization.jobId}:${logicalAddressSegment(authorization.railId)}:${authorization.phaseIndex}`;
  if (!paymentStep || !paymentEntry ||
      (paymentEntry.invokedAt as number) < authorization.commitment.finalizedAt ||
      paymentStep.kind !== authorization.evidenceInput.phase ||
      paymentStep.parameters?.rail !== authorization.railId || !isRecord(paymentResult) ||
      !exact(paymentResult.txRefs, authorization.evidenceInput.paymentTxRefs) ||
      (paymentResult.attestationRef !== undefined &&
        (!isAttestationRef(paymentResult.attestationRef) ||
          paymentResult.attestationRef.contentHash !== authorization.evidenceHash ||
          paymentResult.attestationRef.anchor.kind !== "storage-program" ||
          paymentResult.attestationRef.anchor.locator !== expectedPaymentAddress)) ||
      (paymentResult.anchorReceipt !== undefined &&
        (!isAnchorReceipt(paymentResult.anchorReceipt) ||
          paymentResult.anchorReceipt.logicalAddress !== expectedPaymentAddress ||
          paymentResult.anchorReceipt.contentHash !== authorization.evidenceHash)) ||
      (paymentResult.attestationRef === undefined && paymentResult.anchorReceipt !== undefined)) {
    return "SessionRecord payment phase does not bind the retained payment authorization";
  }
  return null;
}

function auditSourceViolation(
  source: unknown,
  session: SellerFulfilmentSessionRecord,
  authorization: SellerPaymentAuthorization,
  agreement: SellerFulfilmentAgreement,
  listing: SellerFulfilmentListing,
  request: SellerFulfilmentRequest,
  deliveryPhaseIndex: number,
  expectedCommitmentAddress: string,
): string | null {
  if (!isSellerFulfilmentAuditSource(source)) {
    return "audit source is not the strict versioned operational provenance shape";
  }
  if (!exact(source.session, session) ||
      source.session.phaseResults.length !== deliveryPhaseIndex) {
    return "audit source does not contain the exact authenticated pre-delivery SessionRecord";
  }
  const orchestrator = session.parties.find((party) => party.role === "orchestrator");
  if (!orchestrator) {
    return "audit source has no authenticated phase orchestrator";
  }
  const commitmentEntry = session.phaseResults.find((entry) =>
    entry.step.kind === "commit-payee-bound-agreement")!;
  const commitmentOutput = commitmentEntry.contextDelta[
    "commit-payee-bound-agreement"
  ];
  const commitmentReceipt = isRecord(commitmentOutput)
    ? commitmentOutput.anchorReceipt
    : undefined;
  if (source.artifacts.agreementCommitment.contentHash !==
        authorization.commitment.contentHash ||
      source.artifacts.agreementCommitment.anchor.kind !== "storage-program" ||
      source.artifacts.agreementCommitment.anchor.locator !== expectedCommitmentAddress ||
      (source.artifacts.agreementCommitment.signer !== undefined &&
        source.artifacts.agreementCommitment.signer !== authorization.commitment.signer) ||
      !isAnchorReceipt(commitmentReceipt) ||
      commitmentReceipt.logicalAddress !== expectedCommitmentAddress ||
      request.commitmentRef !== expectedCommitmentAddress ||
      authorization.commitment.ref !== expectedCommitmentAddress ||
      authorization.commitment.signer !== orchestrator.primaryClaim) {
    return "audit source does not bind the exact finalized AgreementCommitment";
  }
  const partyVetBindings = session.parties.flatMap((party) =>
    party.vetRecordRef === undefined
      ? []
      : [{ party, key: canonicalize(party.vetRecordRef) }]);
  const uniquePartyVetBindings = new Map<
    string,
    { primaryClaim: string; bundleHash: string; roles: Set<string> }
  >();
  for (const binding of partyVetBindings) {
    const existing = uniquePartyVetBindings.get(binding.key);
    if (existing &&
        (existing.primaryClaim !== binding.party.primaryClaim ||
          existing.bundleHash !== binding.party.bundleHash)) {
      return "one Vet record cannot represent different authenticated party identities";
    }
    if (existing) {
      existing.roles.add(binding.party.role);
    } else {
      uniquePartyVetBindings.set(binding.key, {
        primaryClaim: binding.party.primaryClaim,
        bundleHash: binding.party.bundleHash,
        roles: new Set([binding.party.role]),
      });
    }
  }
  const sessionVetRefs = [...uniquePartyVetBindings.keys()];
  const inventoryVetRefs = source.artifacts.vetRecords.map((ref) => canonicalize(ref));
  if (sessionVetRefs.length !== inventoryVetRefs.length ||
      !sessionVetRefs.every((ref) => inventoryVetRefs.includes(ref))) {
    return "audit source vet-record inventory differs from the authenticated party roster";
  }
  const buyerParty = session.parties.find((party) => party.role === "buyer");
  const sellerParty = session.parties.find((party) => party.role === "seller");
  if (!buyerParty || !sellerParty ||
      !exact(buyerParty.vetRecordRef, agreement.buyer.vetRecordRef) ||
      !exact(sellerParty.vetRecordRef, agreement.seller.vetRecordRef)) {
    return "audit source party Vet references differ from the committed Agreement";
  }
  if (source.artifacts.vetRequirements.some((invocation) => {
    const key = canonicalize(invocation.vetRecordRef);
    const binding = uniquePartyVetBindings.get(key);
    const expectedResults = [...invocation.freshness, ...invocation.dealSpecific];
    const requirementCandidates = [
      ...invocation.requirement.required,
      ...(invocation.requirement.oneOf ?? []).flat(),
    ];
    const seenResultRefs = new Set<string>();
    const seenResultHashes = new Set<string>();
    const listingOwned = binding?.roles.has("buyer") === true;
    const expectedCompositeAddress =
      `dacs2:composite:${authorization.jobId}:${encodeAddressSegment(invocation.evaluatedParty)}`;
    const uncoveredRequired = invocation.requirement.required.some(
      (required) => !expectedResults.some((result) =>
        result.scheme === required.scheme && exact(result.requirement, required)),
    );
    const uncoveredOneOf = (invocation.requirement.oneOf ?? []).some(
      (group) => group.length === 0 || !group.some((alternative) =>
        expectedResults.some((result) =>
          result.scheme === alternative.scheme && exact(result.requirement, alternative))),
    );
    return !binding || invocation.evaluatedParty !== binding.primaryClaim ||
      invocation.verifier !== orchestrator.primaryClaim ||
      invocation.vetRecordRef.anchor.kind !== "storage-program" ||
      invocation.vetRecordRef.anchor.locator !== expectedCompositeAddress ||
      (invocation.vetRecordRef.signer !== undefined &&
        invocation.vetRecordRef.signer !== invocation.verifier) ||
      (listingOwned && !exact(invocation.requirement, listing.buyerRequirement)) ||
      invocation.dealSpecific.some((result) => result.sourceJobId !== authorization.jobId) ||
      uncoveredRequired || uncoveredOneOf ||
      expectedResults.some((result) => {
        const refKey = canonicalize(result.ref);
        const expectedResultAddress =
          `dacs2:${result.sourceJobId}:${result.scheme}:` +
          `${encodeAddressSegment(result.identifier)}:v${result.ref.recipeVersion}`;
        const duplicate = seenResultRefs.has(refKey) ||
          seenResultHashes.has(result.ref.contentHash);
        seenResultRefs.add(refKey);
        seenResultHashes.add(result.ref.contentHash);
        return duplicate || result.scheme !== result.requirement.scheme ||
          result.ref.anchor.kind !== "storage-program" ||
          result.ref.anchor.locator !== expectedResultAddress ||
          !requirementCandidates.some((candidate) => exact(candidate, result.requirement)) ||
          (result.requirement.recipeVersion !== undefined &&
            result.ref.recipeVersion !== result.requirement.recipeVersion);
      });
  })) {
    return "audit source Vet provenance differs from the authenticated party/orchestrator bindings";
  }

  if (commitmentEntry.result.attestationRef !== undefined &&
        !exact(
          commitmentEntry.result.attestationRef,
          source.artifacts.agreementCommitment,
        )) {
    return "audit source does not map one prior payee-bound commitment phase to the finalized commitment";
  }

  const expectedPaymentAddress =
    `dacs4:payment:${authorization.jobId}:${logicalAddressSegment(authorization.railId)}:${authorization.phaseIndex}`;
  const expectedSettlementRefs: AttestationRef[] = [];
  let pointerlessAuthorizedPayment = false;
  for (const entry of session.phaseResults) {
    if (entry.step.kind === "vet-credentials" && entry.result.attestationRef &&
        !inventoryVetRefs.includes(canonicalize(entry.result.attestationRef))) {
      return "audit source Vet phase pointer is outside the authenticated party inventory";
    }
    if ((entry.step.kind === "commit-agreement" ||
        entry.step.kind === "commit-payee-bound-agreement") &&
        entry.result.attestationRef &&
        !exact(entry.result.attestationRef, source.artifacts.agreementCommitment)) {
      return "audit source commitment phase pointer differs from the finalized AgreementCommitment";
    }
    if (entry.step.kind.startsWith("pay-") ||
        entry.step.kind.startsWith("deliver-")) {
      if (entry.result.attestationRef) {
        expectedSettlementRefs.push(entry.result.attestationRef);
      } else if (entry.index === authorization.phaseIndex &&
          entry.step.kind.startsWith("pay-")) {
        // PC-7 permits the SessionRecord write to lag the independently
        // authenticated payment evidence. This focused fulfilment profile has
        // one prior payment, so the retained authorization supplies its exact,
        // unambiguous ref without rewriting the source SessionRecord.
        pointerlessAuthorizedPayment = true;
      } else {
        return "pointerless pre-delivery settlement phase cannot be assigned unambiguously";
      }
    }
    if (entry.step.kind === "rate") {
      return "a pre-delivery audit source cannot contain a post-settlement rate phase";
    }
  }
  if (pointerlessAuthorizedPayment) {
    const candidates = source.artifacts.settlementEvidence.filter((ref) =>
      ref.anchor.kind === "storage-program" &&
      ref.anchor.locator === expectedPaymentAddress &&
      ref.contentHash === authorization.evidenceHash &&
      (ref.signer === undefined || ref.signer === orchestrator.primaryClaim));
    if (candidates.length !== 1) {
      return "pointerless payment evidence is not uniquely retained by authenticated address/hash/signer";
    }
    expectedSettlementRefs.push(candidates[0]!);
  }
  const expectedSettlementKeys = expectedSettlementRefs.map((ref) => canonicalize(ref));
  const settlementRefs = source.artifacts.settlementEvidence.map((ref) => canonicalize(ref));
  if (expectedSettlementKeys.length === 0 ||
      settlementRefs.length !== expectedSettlementKeys.length ||
      new Set(expectedSettlementKeys).size !== expectedSettlementKeys.length ||
      new Set(source.artifacts.settlementEvidence.map((ref) => ref.contentHash)).size !==
        source.artifacts.settlementEvidence.length ||
      !expectedSettlementKeys.every((ref) => settlementRefs.includes(ref)) ||
      !settlementRefs.every((ref) => expectedSettlementKeys.includes(ref))) {
    return "audit source settlement-evidence inventory differs from the authenticated pre-delivery phases";
  }
  const ratingRefs = source.artifacts.ratingRecords ?? [];
  if (ratingRefs.length !== 0) {
    return "a pre-delivery audit source cannot retain post-settlement RatingRecords";
  }
  const authorizedEvidence = source.artifacts.settlementEvidence.filter(
    (ref) => ref.contentHash === authorization.evidenceHash,
  );
  const paymentEntry = session.phaseResults[authorization.phaseIndex];
  if (authorizedEvidence.length !== 1 ||
      authorizedEvidence[0]!.anchor.kind !== "storage-program" ||
      authorizedEvidence[0]!.anchor.locator !== expectedPaymentAddress ||
      (authorizedEvidence[0]!.signer !== undefined &&
        authorizedEvidence[0]!.signer !== orchestrator.primaryClaim) ||
      (paymentEntry?.result.attestationRef !== undefined &&
        !exact(paymentEntry.result.attestationRef, authorizedEvidence[0])) ||
      (paymentEntry?.result.anchorReceipt !== undefined &&
        paymentEntry.result.anchorReceipt.logicalAddress !== expectedPaymentAddress)) {
    return "audit source payment evidence does not exactly match the retained authorization";
  }
  return null;
}

function anchorReceiptBinding(
  receipt: unknown,
  logicalAddress: string,
  expectedContentHash: string,
  minimum: "accepted" | "included",
):
  | { status: "ok"; receipt: AnchorReceipt }
  | { status: "invalid" | "indeterminate"; reason: string } {
  if (!isAnchorReceipt(receipt) || receipt.logicalAddress !== logicalAddress ||
      receipt.contentHash !== expectedContentHash) {
    return { status: "invalid", reason: "AnchorReceipt does not bind the exact logical address/content" };
  }
  if (receipt.observationDisposition === "indeterminate") {
    return { status: "indeterminate", reason: "AnchorReceipt observation is indeterminate" };
  }
  const sufficient = minimum === "accepted"
    ? ["accepted", "included", "finalized"].includes(receipt.state)
    : ["included", "finalized"].includes(receipt.state);
  if (sufficient) return { status: "ok", receipt };
  if (["submitted", "accepted", "dropped", "expired", "reorged", "replaced"].includes(
    receipt.state,
  )) {
    return {
      status: "indeterminate",
      reason: `AnchorReceipt has not reached ${minimum} lifecycle state`,
    };
  }
  return { status: "invalid", reason: `AnchorReceipt reached terminal ${receipt.state} state` };
}

async function verifyReceipt(
  purpose: "delivery" | "payload-attestation" | "settlement-evidence",
  ref: SellerAttestationRef,
  receipt: AnchorReceipt,
  expectedWriter: {
    role: "seller" | "phase-orchestrator";
    primaryClaim: string;
  },
  deps: SellerFulfilmentDeps,
): Promise<{ status: "ok" } | { status: "invalid" | "indeterminate"; reason: string }> {
  const input = {
    purpose,
    expectedWriter: structuredClone(expectedWriter),
    ref: structuredClone(ref),
    receipt: structuredClone(receipt),
  };
  let before: string;
  try {
    before = canonicalize(input);
  } catch (error) {
    return { status: "invalid", reason: `anchor receipt verifier input is invalid: ${String(error)}` };
  }
  let result: unknown;
  try {
    result = structuredClone(await deps.verifyAnchorReceipt(input));
  } catch (error) {
    return { status: "indeterminate", reason: `anchor receipt verifier threw: ${String(error)}` };
  }
  try {
    if (canonicalize(input) !== before) {
      return { status: "indeterminate", reason: "anchor receipt verifier mutated its exact inputs" };
    }
  } catch {
    return { status: "indeterminate", reason: "anchor receipt verifier corrupted its exact inputs" };
  }
  if (!validVerification(result)) {
    return { status: "indeterminate", reason: "anchor receipt verifier returned a malformed disposition" };
  }
  if (result.disposition === "valid") return { status: "ok" };
  return {
    status: result.disposition === "invalid" ? "invalid" : "indeterminate",
    reason: result.reason,
  };
}

async function validateEntitlement(
  payload: unknown,
  agreement: SellerFulfilmentAgreement,
  spec: Extract<SellerDeliverableSpec, { kind: "entitlement" }>,
  observedAt: number,
  minimumStartsAt: number,
  deps: SellerFulfilmentDeps,
): Promise<{ status: "ok"; hash: string } | { status: "invalid" | "indeterminate"; reason: string }> {
  if (!isRecord(payload)) return { status: "invalid", reason: "entitlement payload must be an object" };
  const startsAt = payload.startsAt;
  const endsAt = payload.endsAt;
  if ("credentialRef" in payload) {
    return {
      status: "invalid",
      reason: "credentialRef delivery is unsupported until DV-5 evidence addressing is normative",
    };
  }
  if (payload.entitlementVersion !== "1" || payload.jobId !== agreement.jobId ||
      payload.grantee !== agreement.buyer.primaryClaim ||
      payload.grantor !== agreement.seller.primaryClaim ||
      !isSafeUint(startsAt) || !isSafeUint(endsAt) ||
      endsAt - startsAt !== spec.durationSec * 1_000 || startsAt < minimumStartsAt ||
      startsAt > observedAt ||
      endsAt <= observedAt || payload.renewable !== spec.renewable ||
      payload.renewalSeq !== 0 || !isComponentSignature(payload.signature) ||
      payload.signature.signer !== agreement.seller.primaryClaim ||
      !isRecord(payload.scope) ||
      !isNonEmpty(payload.scope.service) ||
      (payload.scope.tier !== undefined && !isNonEmpty(payload.scope.tier)) ||
      (payload.scope.quotas !== undefined &&
        (!isRecord(payload.scope.quotas) ||
          !Object.values(payload.scope.quotas).every((quota) =>
            typeof quota === "number" && Number.isFinite(quota)))) ||
      (payload.serviceEndpoint !== undefined && !isAbsoluteUrl(payload.serviceEndpoint))) {
    return { status: "invalid", reason: "entitlement is not bound to its parties and DeliverableSpec" };
  }
  if (!deps.verifyEntitlementSignature) {
    return { status: "indeterminate", reason: "entitlement signature verifier is unavailable" };
  }
  let hash: string;
  try {
    // CORE SIG-5: hash the complete raw record, including inert unknown fields.
    hash = singularSignatureContentHash(payload);
  } catch (error) {
    return { status: "invalid", reason: `entitlement signed scope is invalid: ${String(error)}` };
  }
  let verification: unknown;
  let verifierRecord: Record<string, unknown>;
  let verifierSignature: ComponentSignature;
  let verifierBytes: Uint8Array;
  let verifierRecordBefore: string;
  let verifierSignatureBefore: string;
  try {
    verifierRecord = structuredClone(payload);
    verifierSignature = structuredClone(payload.signature);
    verifierBytes = signedBytes(ENTITLEMENT_SEPARATOR, hash);
    verifierRecordBefore = canonicalize(verifierRecord);
    verifierSignatureBefore = canonicalize(verifierSignature);
    const expectedBytes = verifierBytes.slice();
    verification = structuredClone(await deps.verifyEntitlementSignature({
      record: verifierRecord,
      signedBytes: verifierBytes,
      signature: verifierSignature,
    }));
    if (canonicalize(verifierRecord) !== verifierRecordBefore ||
        canonicalize(verifierSignature) !== verifierSignatureBefore ||
        !Buffer.from(verifierBytes).equals(Buffer.from(expectedBytes))) {
      return { status: "indeterminate", reason: "entitlement verifier mutated its exact inputs" };
    }
  } catch (error) {
    return { status: "indeterminate", reason: `entitlement signature verification threw: ${String(error)}` };
  }
  if (!validVerification(verification)) {
    return { status: "indeterminate", reason: "entitlement signature verifier returned a malformed disposition" };
  }
  if (verification.disposition !== "valid") {
    return {
      status: verification.disposition === "invalid" ? "invalid" : "indeterminate",
      reason: verification.reason,
    };
  }
  return { status: "ok", hash };
}

function parsePayloadAttestation(value: unknown): SellerPayloadAttestationRecord | null {
  if (!isRecord(value) || value.payloadAttestationVersion !== "1" ||
      Object.prototype.hasOwnProperty.call(value, "resultVersion") ||
      Object.prototype.hasOwnProperty.call(value, "evidenceVersion") || !isNonEmpty(value.jobId) ||
      !isHash(value.agreementHash) || !isHash(value.deliverableSpecHash) ||
      !isNonEmpty(value.payloadFormat) || !isHash(value.payloadContentHash) ||
      !isNonEmpty(value.verificationMethod) || !isHash(value.verificationMethodHash) ||
      !isSafeUint(value.attempt) ||
      !["pass", "fail", "indeterminate", "error"].includes(String(value.decision)) ||
      !isNonEmpty(value.reason) ||
      (value.methodEvidenceRef !== undefined &&
        !isForwardReadableAttestationRef(value.methodEvidenceRef)) ||
      (value.methodTransactionRef !== undefined &&
        (!isRecord(value.methodTransactionRef) ||
          !isNonEmpty(value.methodTransactionRef.kind) ||
          !isNonEmpty(value.methodTransactionRef.value))) ||
      !isSafeUint(value.verifiedAt) || !isComponentSignature(value.signature)) return null;
  // Unknown top-level fields are retained on this raw object for CORE SIG-5.
  return value as unknown as SellerPayloadAttestationRecord;
}

/**
 * CORE SIG-5 validation for an AttestationRef nested in a signed, later-minor
 * record. Known fields are validated, but inert extension fields are retained
 * and hash-bound with the enclosing PayloadAttestationRecord.
 */
function isForwardReadableAttestationRef(value: unknown): value is SellerAttestationRef {
  if (!isRecord(value) || !isRecord(value.anchor)) return false;
  const kind = value.anchor.kind;
  return (kind === "storage-program" || kind === "ipfs" || kind === "https") &&
    isNonEmpty(value.anchor.locator) && isHash(value.contentHash) &&
    (value.signer === undefined || isNonEmpty(value.signer));
}

async function validatePayloadAttestationRecord(
  rawRecord: unknown,
  artifact: SellerDeliveredArtifact,
  agreement: SellerFulfilmentAgreement,
  spec: Extract<SellerDeliverableSpec, { kind: "attested-payload" }>,
  deliverableContentHash: string,
  observedAt: number,
  minimumVerifiedAt: number,
  deps: SellerFulfilmentDeps,
): Promise<
  | {
      status: "ok";
      ref: SellerAttestationRef;
      record: SellerPayloadAttestationRecord;
      recordHash: string;
    }
  | { status: "invalid" | "indeterminate"; reason: string }
> {
  if (!isAttestationRef(artifact.attestationRef)) {
    return { status: "invalid", reason: "DPA-6 attestationRef is missing or malformed" };
  }
  if (!deps.verifyPayloadAttestationSignature || !deps.verifyPayloadMethodProof) {
    return { status: "indeterminate", reason: "complete DPA verification capabilities are unavailable" };
  }
  let recordValue: unknown;
  try {
    recordValue = structuredClone(rawRecord);
  } catch {
    return { status: "invalid", reason: "PayloadAttestationRecord is not cloneable" };
  }
  const record = parsePayloadAttestation(recordValue);
  const method = spec.verificationMethod;
  if (!record || !method) {
    return { status: "invalid", reason: "PayloadAttestationRecord is malformed" };
  }
  let methodHash: string;
  let recordHash: string;
  try {
    methodHash = sha256Hex(canonicalize(method));
    // CORE SIG-5: the raw record, not a known-field projection, is hash-bound.
    recordHash = singularSignatureContentHash(record);
  } catch (error) {
    return { status: "invalid", reason: `PayloadAttestationRecord signed scope is invalid: ${String(error)}` };
  }
  const expectedLocator = `dacs4:payload-attestation:${agreement.jobId}:${methodHash}:${record.attempt}`;
  if (record.jobId !== agreement.jobId || record.agreementHash !== agreement.contentHash ||
      record.deliverableSpecHash !== agreement.deliverableRef.hash ||
      record.payloadFormat !== spec.payloadFormat ||
      record.payloadContentHash !== deliverableContentHash ||
      record.verificationMethod !== method.kind ||
      record.verificationMethodHash !== methodHash || record.attempt !== 0 ||
      record.decision !== "pass" ||
      record.verifiedAt < minimumVerifiedAt || record.verifiedAt > observedAt ||
      !record.methodEvidenceRef || recordHash !== artifact.attestationRef.contentHash ||
      (artifact.attestationRef.signer !== undefined &&
        artifact.attestationRef.signer !== record.signature.signer) ||
      artifact.attestationRef.anchor.kind !== "storage-program" ||
      artifact.attestationRef.anchor.locator !== expectedLocator) {
    return { status: "invalid", reason: "PayloadAttestationRecord commerce binding is invalid" };
  }

  let signatureResult: unknown;
  let signatureRecordInput: SellerPayloadAttestationRecord;
  let signatureEnvelopeInput: ComponentSignature;
  let signatureBytesInput: Uint8Array;
  let signatureRecordBefore: string;
  let signatureEnvelopeBefore: string;
  try {
    signatureRecordInput = structuredClone(record);
    signatureEnvelopeInput = structuredClone(record.signature);
    signatureBytesInput = signedBytes(PAYLOAD_ATTESTATION_SEPARATOR, recordHash);
    signatureRecordBefore = canonicalize(signatureRecordInput);
    signatureEnvelopeBefore = canonicalize(signatureEnvelopeInput);
    const expectedBytes = signatureBytesInput.slice();
    signatureResult = structuredClone(await deps.verifyPayloadAttestationSignature({
      record: signatureRecordInput,
      signedBytes: signatureBytesInput,
      signature: signatureEnvelopeInput,
    }));
    if (canonicalize(signatureRecordInput) !== signatureRecordBefore ||
        canonicalize(signatureEnvelopeInput) !== signatureEnvelopeBefore ||
        !Buffer.from(signatureBytesInput).equals(Buffer.from(expectedBytes))) {
      return { status: "indeterminate", reason: "payload signature verifier mutated its exact inputs" };
    }
  } catch (error) {
    return { status: "indeterminate", reason: `payload signature verification threw: ${String(error)}` };
  }
  if (!validVerification(signatureResult)) {
    return { status: "indeterminate", reason: "payload signature verifier returned a malformed disposition" };
  }
  if (signatureResult.disposition !== "valid") {
    return {
      status: signatureResult.disposition === "invalid" ? "invalid" : "indeterminate",
      reason: signatureResult.reason,
    };
  }

  const methodInput = {
    verificationMethod: structuredClone(method),
    record: structuredClone(record),
    methodEvidenceRef: structuredClone(record.methodEvidenceRef),
  };
  const before = canonicalize(methodInput);
  let proofResult: unknown;
  try {
    proofResult = structuredClone(await deps.verifyPayloadMethodProof(methodInput));
  } catch (error) {
    return { status: "indeterminate", reason: `payload method verification threw: ${String(error)}` };
  }
  try {
    if (canonicalize(methodInput) !== before) {
      return { status: "indeterminate", reason: "payload method verifier mutated its exact signed inputs" };
    }
  } catch {
    return { status: "indeterminate", reason: "payload method verifier corrupted its exact signed inputs" };
  }
  if (!validVerification(proofResult)) {
    return { status: "indeterminate", reason: "payload method verifier returned a malformed disposition" };
  }
  if (proofResult.disposition !== "valid") {
    return {
      status: proofResult.disposition === "invalid" ? "invalid" : "indeterminate",
      reason: proofResult.reason,
    };
  }
  return { status: "ok", ref: artifact.attestationRef, record, recordHash };
}

async function validatePayloadAttestation(
  artifact: SellerDeliveredArtifact,
  agreement: SellerFulfilmentAgreement,
  spec: Extract<SellerDeliverableSpec, { kind: "attested-payload" }>,
  deliverableContentHash: string,
  observedAt: number,
  minimumVerifiedAt: number,
  deps: SellerFulfilmentDeps,
  expectedRecordHash?: string,
): Promise<{ status: "ok"; ref: SellerAttestationRef } | { status: "invalid" | "indeterminate"; reason: string }> {
  if (!isAttestationRef(artifact.attestationRef)) {
    return { status: "invalid", reason: "DPA-6 attestationRef is missing or malformed" };
  }
  if (!deps.resolvePayloadAttestation) {
    return { status: "indeterminate", reason: "PayloadAttestationRecord resolver is unavailable" };
  }
  let rawResolution: unknown;
  let attestationRefInput: SellerAttestationRef;
  let attestationRefBefore: string;
  try {
    attestationRefInput = structuredClone(artifact.attestationRef);
    attestationRefBefore = canonicalize(attestationRefInput);
    rawResolution = structuredClone(await deps.resolvePayloadAttestation(attestationRefInput));
    if (canonicalize(attestationRefInput) !== attestationRefBefore) {
      return { status: "indeterminate", reason: "payload attestation resolver mutated its exact ref" };
    }
  } catch (error) {
    return { status: "indeterminate", reason: String(error) };
  }
  const resolution = parseResolution(rawResolution);
  if (!resolution) {
    return { status: "indeterminate", reason: "payload attestation resolver returned a malformed result" };
  }
  if (resolution.status !== "verified") {
    return {
      status: resolution.status === "rejected" ? "invalid" : "indeterminate",
      reason: resolution.reason,
    };
  }
  let resolvedValue: unknown;
  try {
    resolvedValue = structuredClone(resolution.value);
  } catch {
    return { status: "indeterminate", reason: "payload attestation resolver returned a non-cloneable value" };
  }
  if (!isRecord(resolvedValue) ||
      !hasOnlyKeys(resolvedValue, ["record", "anchorReceipt"])) {
    return { status: "invalid", reason: "resolved PayloadAttestationRecord anchor is malformed" };
  }
  const validated = await validatePayloadAttestationRecord(
    resolvedValue.record,
    artifact,
    agreement,
    spec,
    deliverableContentHash,
    observedAt,
    minimumVerifiedAt,
    deps,
  );
  if (validated.status !== "ok") return validated;
  if (expectedRecordHash !== undefined && validated.recordHash !== expectedRecordHash) {
    return { status: "invalid", reason: "resolved PayloadAttestationRecord differs from the anchored candidate" };
  }
  const recordBinding = anchorReceiptBinding(
    resolvedValue.anchorReceipt,
    validated.ref.anchor.locator,
    validated.recordHash,
    "included",
  );
  if (recordBinding.status !== "ok") return recordBinding;
  const recordReceipt = await verifyReceipt(
    "payload-attestation",
    validated.ref,
    recordBinding.receipt,
    { role: "seller", primaryClaim: agreement.seller.primaryClaim },
    deps,
  );
  return recordReceipt.status === "ok" ? { status: "ok", ref: validated.ref } : recordReceipt;
}

async function anchorPreparedPayloadAttestation(
  prepared: {
    record: SellerPayloadAttestationRecord;
    recordHash: string;
    ref: SellerAttestationRef;
  },
  artifact: SellerDeliveredArtifact,
  agreement: SellerFulfilmentAgreement,
  spec: Extract<SellerDeliverableSpec, { kind: "attested-payload" }>,
  deliverableContentHash: string,
  observedAt: number,
  minimumVerifiedAt: number,
  deps: SellerFulfilmentDeps,
): Promise<{ status: "ok" } | { status: "invalid" | "indeterminate"; reason: string }> {
  if (!deps.anchorPayloadAttestation) {
    return { status: "invalid", reason: "PayloadAttestationRecord anchor capability is unavailable" };
  }
  let anchorInput: {
    record: SellerPayloadAttestationRecord;
    recordHash: string;
    ref: SellerAttestationRef;
  };
  let recordBefore: string;
  let refBefore: string;
  try {
    anchorInput = {
      record: structuredClone(prepared.record),
      recordHash: prepared.recordHash,
      ref: structuredClone(prepared.ref),
    };
    recordBefore = canonicalize(anchorInput.record);
    refBefore = canonicalize(anchorInput.ref);
  } catch (error) {
    return { status: "invalid", reason: `PayloadAttestationRecord anchor input is invalid: ${String(error)}` };
  }
  let rawAnchor: unknown;
  let writerIssue: string | undefined;
  try {
    rawAnchor = await deps.anchorPayloadAttestation(anchorInput);
  } catch (error) {
    rawAnchor = { status: "indeterminate", reason: String(error) };
  }
  try {
    if (canonicalize(anchorInput.record) !== recordBefore ||
        canonicalize(anchorInput.ref) !== refBefore ||
        anchorInput.recordHash !== prepared.recordHash ||
        singularSignatureContentHash(anchorInput.record) !== prepared.recordHash) {
      writerIssue = "PayloadAttestationRecord anchor mutated its exact input";
    }
    rawAnchor = structuredClone(rawAnchor);
  } catch (error) {
    writerIssue = `PayloadAttestationRecord anchor result is ambiguous: ${String(error)}`;
  }
  if (!writerIssue) {
    const anchored = parseEvidenceAnchorResult(rawAnchor);
    if (!anchored) {
      writerIssue = "PayloadAttestationRecord anchor returned a malformed result";
    } else if (anchored.status !== "anchored") {
      writerIssue = anchored.reason;
    } else if (!exact(anchored.ref, prepared.ref)) {
      writerIssue = "PayloadAttestationRecord anchor returned a different ref";
    } else {
      const anchorBinding = anchorReceiptBinding(
        anchored.anchorReceipt,
        prepared.ref.anchor.locator,
        prepared.recordHash,
        "included",
      );
      if (anchorBinding.status !== "ok") {
        writerIssue = anchorBinding.reason;
      } else {
        const receipt = await verifyReceipt(
          "payload-attestation",
          prepared.ref,
          anchorBinding.receipt,
          { role: "seller", primaryClaim: agreement.seller.primaryClaim },
          deps,
        );
        if (receipt.status !== "ok") writerIssue = receipt.reason;
      }
    }
  }

  // Resolve independently even after a successful write acknowledgement. An
  // indeterminate write may reconcile here without an unsafe second anchor.
  const resolved = await validatePayloadAttestation(
    artifact,
    agreement,
    spec,
    deliverableContentHash,
    observedAt,
    minimumVerifiedAt,
    deps,
    prepared.recordHash,
  );
  if (resolved.status === "ok") return { status: "ok" };
  if (resolved.status === "invalid") return resolved;
  return {
    status: "indeterminate",
    reason: writerIssue ? `${writerIssue}; ${resolved.reason}` : resolved.reason,
  };
}

async function validatePreparedArtifact(
  artifactValue: unknown,
  payloadAttestationRecord: unknown,
  mode: "prepared" | "resolved",
  phase: SellerDeliveryPhase,
  agreement: SellerFulfilmentAgreement,
  spec: SellerDeliverableSpec,
  observedAt: number,
  minimumVerifiedAt: number,
  deps: SellerFulfilmentDeps,
): Promise<
  | {
      status: "ok";
      deliverableContentHash: string;
      anchoredContentHash: string;
      attestationRef?: SellerAttestationRef;
      payloadRecord?: SellerPayloadAttestationRecord;
      payloadRecordHash?: string;
    }
  | { status: "invalid" | "indeterminate"; reason: string }
> {
  if (!isRecord(artifactValue) || artifactValue.kind !== phase) {
    return { status: "invalid", reason: "delivery candidate has a different phase kind" };
  }
  const artifactRecord = artifactValue;
  const artifactKeys = phase === "deliver-attested-payload"
    ? ["kind", "cleartextBytes", "anchoredValue", "attestationRef"]
    : ["kind", "cleartextPayload", "anchoredValue", "access"];
  if (!hasOnlyKeys(artifactRecord, artifactKeys)) {
    return { status: "invalid", reason: "resolved delivery artifact has unknown operational fields" };
  }
  const artifact = artifactRecord as unknown as SellerDeliveredArtifact;
  let anchoredHash: string;
  let deliverableContentHash: string;

  if (phase === "deliver-storage-program") {
    if (spec.kind !== "storage-program" || artifact.anchoredValue === undefined) {
      return { status: "invalid", reason: "resolved storage delivery is missing its anchored value" };
    }
    let payloadJcs: string;
    let anchoredJcs: string;
    try {
      payloadJcs = canonicalize(artifact.cleartextPayload);
      anchoredJcs = canonicalize(artifact.anchoredValue);
    } catch (error) {
      return { status: "invalid", reason: `storage value is not canonicalizable: ${String(error)}` };
    }
    deliverableContentHash = sha256Hex(payloadJcs);
    anchoredHash = sha256Hex(anchoredJcs);
    const access = validateAccess(spec.accessModel ?? "public", artifact.access, agreement.buyer);
    if (access.status !== "ok") return access;
    if (artifact.access?.model === "encrypt-to-buyer") {
      if (!deps.verifyEncryptedDelivery) {
        return { status: "indeterminate", reason: "encrypted-delivery verifier is unavailable" };
      }
      let encryption: unknown;
      try {
        const encryptionInput = {
          anchoredValue: structuredClone(artifact.anchoredValue),
          cleartextPayload: structuredClone(artifact.cleartextPayload),
          encryptionRecipient: artifact.access.encryptionRecipient,
        };
        const encryptionBefore = canonicalize(encryptionInput);
        encryption = structuredClone(await deps.verifyEncryptedDelivery(encryptionInput));
        if (canonicalize(encryptionInput) !== encryptionBefore) {
          return { status: "indeterminate", reason: "encrypted-delivery verifier mutated its exact inputs" };
        }
      } catch (error) {
        return { status: "indeterminate", reason: `encrypted-delivery verification threw: ${String(error)}` };
      }
      if (!validVerification(encryption)) {
        return { status: "indeterminate", reason: "encrypted-delivery verifier returned a malformed disposition" };
      }
      if (encryption.disposition !== "valid") {
        return {
          status: encryption.disposition === "invalid" ? "invalid" : "indeterminate",
          reason: encryption.reason,
        };
      }
    }
    const size = Buffer.byteLength(payloadJcs, "utf8");
    if (spec.expectedSizeBytes !== undefined && spec.expectedSizeBytes !== size) {
      return { status: "invalid", reason: "storage payload size does not match expectedSizeBytes" };
    }
    if (size <= 128 * 1_024 && artifact.access?.model !== "encrypt-to-buyer" && anchoredJcs !== payloadJcs) {
      return { status: "invalid", reason: "inline anchored value differs from the cleartext payload" };
    }
    if (size > 128 * 1_024) {
      const pointer = artifact.anchoredValue;
      if (!isRecord(pointer) || !hasOnlyKeys(pointer, ["externalUrl", "externalContentHash", "segmentRefs"]) ||
          !isAbsoluteUrl(pointer.externalUrl) || pointer.externalContentHash !== deliverableContentHash ||
          (pointer.segmentRefs !== undefined &&
            (!Array.isArray(pointer.segmentRefs) || !pointer.segmentRefs.every(isAttestationRef)))) {
        return { status: "invalid", reason: "large storage payload lacks an exact extended-pointer record" };
      }
    }
    if (spec.schemaUrl !== undefined) {
      if (!deps.verifyDeliverySchema) {
        return { status: "indeterminate", reason: "delivery schema verifier is unavailable" };
      }
      let schema: unknown;
      try {
        const schemaInput = {
          schemaUrl: spec.schemaUrl,
          cleartextPayload: structuredClone(artifact.cleartextPayload),
        };
        const schemaBefore = canonicalize(schemaInput);
        schema = structuredClone(await deps.verifyDeliverySchema(schemaInput));
        if (canonicalize(schemaInput) !== schemaBefore) {
          return { status: "indeterminate", reason: "schema verifier mutated its exact inputs" };
        }
      } catch (error) {
        return { status: "indeterminate", reason: `schema verification threw: ${String(error)}` };
      }
      if (!validVerification(schema)) {
        return { status: "indeterminate", reason: "schema verifier returned a malformed disposition" };
      }
      if (schema.disposition !== "valid") {
        return {
          status: schema.disposition === "invalid" ? "invalid" : "indeterminate",
          reason: schema.reason,
        };
      }
    }
  } else if (phase === "deliver-entitlement") {
    if (spec.kind !== "entitlement" || !exact(artifact.anchoredValue, artifact.cleartextPayload)) {
      return { status: "invalid", reason: "resolved entitlement differs from its anchored record" };
    }
    const entitlement = await validateEntitlement(
      artifact.cleartextPayload,
      agreement,
      spec,
      observedAt,
      minimumVerifiedAt,
      deps,
    );
    if (entitlement.status !== "ok") return entitlement;
    deliverableContentHash = entitlement.hash;
    anchoredHash = entitlement.hash;
  } else {
    if (spec.kind !== "attested-payload" || !(artifact.cleartextBytes instanceof Uint8Array) ||
        !(artifact.anchoredValue instanceof Uint8Array) ||
        !Buffer.from(artifact.anchoredValue).equals(Buffer.from(artifact.cleartextBytes))) {
      return { status: "invalid", reason: "resolved attested delivery differs from the exact delivered bytes" };
    }
    if (spec.expectedSizeBytes !== undefined && spec.expectedSizeBytes !== artifact.cleartextBytes.byteLength) {
      return { status: "invalid", reason: "attested payload size does not match expectedSizeBytes" };
    }
    deliverableContentHash = sha256Hex(artifact.cleartextBytes);
    anchoredHash = deliverableContentHash;
    if (mode === "prepared") {
      const attestation = await validatePayloadAttestationRecord(
          payloadAttestationRecord,
          artifact,
          agreement,
          spec,
          deliverableContentHash,
          observedAt,
          minimumVerifiedAt,
          deps,
        );
      if (attestation.status !== "ok") return attestation;
      return {
        status: "ok",
        deliverableContentHash,
        anchoredContentHash: anchoredHash,
        attestationRef: attestation.ref,
        payloadRecord: attestation.record,
        payloadRecordHash: attestation.recordHash,
      };
    }
    const attestation = await validatePayloadAttestation(
          artifact,
          agreement,
          spec,
          deliverableContentHash,
          observedAt,
          minimumVerifiedAt,
          deps,
        );
    if (attestation.status !== "ok") return attestation;
    return {
      status: "ok",
      deliverableContentHash,
      anchoredContentHash: anchoredHash,
      attestationRef: attestation.ref,
    };
  }
  return {
    status: "ok",
    deliverableContentHash,
    anchoredContentHash: anchoredHash,
  };
}

async function validateDeliveredArtifact(
  resolved: SellerResolvedDelivery,
  phase: SellerDeliveryPhase,
  logicalAddress: string,
  agreement: SellerFulfilmentAgreement,
  spec: SellerDeliverableSpec,
  observedAt: number,
  minimumVerifiedAt: number,
  deps: SellerFulfilmentDeps,
  expectedArtifact?: SellerDeliveredArtifact,
): Promise<
  | { status: "ok"; deliverableContentHash: string; attestationRef?: SellerAttestationRef }
  | { status: "invalid" | "indeterminate"; reason: string }
> {
  if (!isRecord(resolved) || !hasOnlyKeys(resolved, ["artifact", "anchorReceipt"]) ||
      !isRecord(resolved.artifact)) {
    return { status: "invalid", reason: "resolved delivery envelope is malformed" };
  }
  if (expectedArtifact !== undefined &&
      !sameDeliveredArtifact(resolved.artifact as SellerDeliveredArtifact, expectedArtifact)) {
    return { status: "invalid", reason: "resolved delivery differs from the validated submitted candidate" };
  }
  const validated = await validatePreparedArtifact(
    resolved.artifact,
    undefined,
    "resolved",
    phase,
    agreement,
    spec,
    observedAt,
    minimumVerifiedAt,
    deps,
  );
  if (validated.status !== "ok") return validated;
  const ref: SellerAttestationRef = {
    anchor: { kind: "storage-program", locator: logicalAddress },
    contentHash: validated.anchoredContentHash,
  };
  const deliveryBinding = anchorReceiptBinding(
    resolved.anchorReceipt,
    logicalAddress,
    validated.anchoredContentHash,
    "included",
  );
  if (deliveryBinding.status !== "ok") return deliveryBinding;
  const receipt = await verifyReceipt(
    "delivery",
    ref,
    deliveryBinding.receipt,
    { role: "seller", primaryClaim: agreement.seller.primaryClaim },
    deps,
  );
  if (receipt.status !== "ok") return receipt;
  return {
    status: "ok",
    deliverableContentHash: validated.deliverableContentHash,
    ...(validated.attestationRef ? { attestationRef: validated.attestationRef } : {}),
  };
}

async function verifySignedEvidence(
  evidence: SignedSellerDeliveryEvidence,
  evidenceHash: string,
  expectedSigner: string,
  deps: SellerFulfilmentDeps,
): Promise<{ status: "ok" } | { status: "invalid" | "indeterminate"; reason: string }> {
  let input: Parameters<SellerFulfilmentDeps["verifyEvidenceSignature"]>[0];
  let evidenceBefore: string;
  let signatureBefore: string;
  let bytesBefore: string;
  try {
    input = {
      evidence: structuredClone(evidence),
      signedBytes: signedBytes(
        ARTIFACT_SEPARATORS.SettlementEvidence,
        evidenceHash,
      ),
      signature: structuredClone(evidence.signature),
      expectedSigner,
    };
    evidenceBefore = canonicalize(input.evidence);
    signatureBefore = canonicalize(input.signature);
    bytesBefore = Buffer.from(input.signedBytes).toString("base64url");
  } catch (error) {
    return { status: "invalid", reason: `SettlementEvidence verification input is invalid: ${String(error)}` };
  }
  let rawResult: unknown;
  try {
    rawResult = structuredClone(await deps.verifyEvidenceSignature(input));
  } catch (error) {
    return { status: "indeterminate", reason: `SettlementEvidence signature verifier threw: ${String(error)}` };
  }
  try {
    if (canonicalize(input.evidence) !== evidenceBefore ||
        canonicalize(input.signature) !== signatureBefore ||
        Buffer.from(input.signedBytes).toString("base64url") !== bytesBefore ||
        input.expectedSigner !== expectedSigner) {
      return {
        status: "indeterminate",
        reason: "SettlementEvidence signature verifier mutated its exact inputs",
      };
    }
  } catch {
    return {
      status: "indeterminate",
      reason: "SettlementEvidence signature verifier corrupted its exact inputs",
    };
  }
  if (!validVerification(rawResult)) {
    return {
      status: "indeterminate",
      reason: "SettlementEvidence signature verifier returned a malformed disposition",
    };
  }
  if (rawResult.disposition === "valid") return { status: "ok" };
  return {
    status: rawResult.disposition === "invalid" ? "invalid" : "indeterminate",
    reason: rawResult.reason,
  };
}

type UnsignedAuditSourceCommitment = Omit<
  SellerFulfilmentAuditSourceCommitmentV1,
  "signature"
>;

function auditSourceCommitmentHash(
  commitment: SellerFulfilmentAuditSourceCommitmentV1 | UnsignedAuditSourceCommitment,
): string {
  return singularSignatureContentHash(commitment as unknown as Record<string, unknown>);
}

async function verifyAuditSourceCommitment(
  commitment: SellerFulfilmentAuditSourceCommitmentV1,
  expectedSigner: string,
  deps: SellerFulfilmentDeps,
): Promise<{ status: "ok" } | { status: "invalid" | "indeterminate"; reason: string }> {
  if (!isComponentSignature(commitment.signature) ||
      commitment.signature.signer !== expectedSigner) {
    return { status: "invalid", reason: "audit-source commitment signer is unauthorized" };
  }
  let input: Parameters<
    SellerFulfilmentDeps["verifyAuditSourceCommitmentSignature"]
  >[0];
  let commitmentBefore: string;
  let signatureBefore: string;
  let bytesBefore: string;
  try {
    input = {
      commitment: structuredClone(commitment),
      signedBytes: signedBytes(
        AUDIT_SOURCE_COMMITMENT_SEPARATOR,
        auditSourceCommitmentHash(commitment),
      ),
      signature: structuredClone(commitment.signature),
      expectedSigner,
    };
    commitmentBefore = canonicalize(input.commitment);
    signatureBefore = canonicalize(input.signature);
    bytesBefore = Buffer.from(input.signedBytes).toString("base64url");
  } catch (error) {
    return { status: "invalid", reason: `audit-source commitment is malformed: ${String(error)}` };
  }
  let rawResult: unknown;
  try {
    rawResult = structuredClone(
      await deps.verifyAuditSourceCommitmentSignature(input),
    );
  } catch (error) {
    return {
      status: "indeterminate",
      reason: `audit-source commitment verifier threw: ${String(error)}`,
    };
  }
  try {
    if (canonicalize(input.commitment) !== commitmentBefore ||
        canonicalize(input.signature) !== signatureBefore ||
        Buffer.from(input.signedBytes).toString("base64url") !== bytesBefore ||
        input.expectedSigner !== expectedSigner) {
      return {
        status: "indeterminate",
        reason: "audit-source commitment verifier mutated its exact inputs",
      };
    }
  } catch {
    return {
      status: "indeterminate",
      reason: "audit-source commitment verifier corrupted its exact inputs",
    };
  }
  if (!validVerification(rawResult)) {
    return {
      status: "indeterminate",
      reason: "audit-source commitment verifier returned a malformed disposition",
    };
  }
  if (rawResult.disposition === "valid") return { status: "ok" };
  return {
    status: rawResult.disposition === "invalid" ? "invalid" : "indeterminate",
    reason: rawResult.reason,
  };
}

async function signAuditSourceCommitment(
  unsigned: UnsignedAuditSourceCommitment,
  signer: BuildComponentSignatureOptions,
  expectedSigner: string,
  deps: SellerFulfilmentDeps,
): Promise<
  | { status: "ok"; commitment: SellerFulfilmentAuditSourceCommitmentV1 }
  | { status: "indeterminate"; reason: string }
> {
  if (signer.signer !== expectedSigner) {
    return { status: "indeterminate", reason: "audit-source commitment signer is unauthorized" };
  }
  const context = { algorithm: signer.algorithm, signer: signer.signer };
  let bytes: Uint8Array;
  let expectedBytes: Uint8Array;
  let contextBefore: string;
  try {
    bytes = signedBytes(
      AUDIT_SOURCE_COMMITMENT_SEPARATOR,
      auditSourceCommitmentHash(unsigned),
    );
    expectedBytes = bytes.slice();
    contextBefore = canonicalize(context);
  } catch (error) {
    return {
      status: "indeterminate",
      reason: `audit-source commitment signing inputs are malformed: ${String(error)}`,
    };
  }
  let signatureValue: Uint8Array | string;
  try {
    signatureValue = await signer.sign(bytes, context);
  } catch (error) {
    return { status: "indeterminate", reason: `audit-source commitment signing failed: ${String(error)}` };
  }
  let commitment: SellerFulfilmentAuditSourceCommitmentV1;
  try {
    if (!Buffer.from(bytes).equals(Buffer.from(expectedBytes)) ||
        canonicalize(context) !== contextBefore) {
      return { status: "indeterminate", reason: "audit-source signer mutated its exact inputs" };
    }
    commitment = {
      ...unsigned,
      signature: {
        ...context,
        value: typeof signatureValue === "string"
          ? signatureValue
          : Buffer.from(signatureValue).toString("base64url"),
      },
    };
    if (!isComponentSignature(commitment.signature)) {
      return { status: "indeterminate", reason: "audit-source signer returned a malformed signature" };
    }
  } catch (error) {
    return {
      status: "indeterminate",
      reason: `audit-source signer returned an unusable result: ${String(error)}`,
    };
  }
  const verified = await verifyAuditSourceCommitment(
    commitment,
    expectedSigner,
    deps,
  );
  return verified.status === "ok"
    ? { status: "ok", commitment }
    : { status: "indeterminate", reason: verified.reason };
}

async function publishEvidence(
  evidence: SellerDeliverySuccessEvidence | SellerDeliveryFailureEvidence,
  fulfilmentId: string,
  deps: SellerFulfilmentDeps,
  evidenceSigner: BuildComponentSignatureOptions,
  requiredEvidenceSigner: string,
): Promise<
  | {
      status: "anchored";
      evidence: SignedSellerDeliveryEvidence;
      evidenceHash: string;
      evidenceRef: SellerAttestationRef;
      anchorReceipt: AnchorReceipt;
    }
  | {
      status: "pending";
      stage: "sign" | "anchor";
      reason: string;
      evidenceDraft: SellerDeliverySuccessEvidence | SellerDeliveryFailureEvidence;
      evidence?: SignedSellerDeliveryEvidence;
      evidenceHash?: string;
    }
> {
  let signed: SignedSellerDeliveryEvidence;
  let signedCanonical: string;
  let signedScopeCanonical: string;
  let evidenceHash: string;
  try {
    signed = await signComponentArtifact(
      evidence,
      ARTIFACT_SEPARATORS.SettlementEvidence,
      evidenceSigner,
    ) as SignedSellerDeliveryEvidence;
    signed = structuredClone(signed);
    if (!isComponentSignature(signed.signature) ||
        signed.signature.signer !== requiredEvidenceSigner ||
        signed.signature.algorithm !== evidenceSigner.algorithm) {
      throw new TypeError("signed SettlementEvidence is not authorized by the phase orchestrator");
    }
    signedCanonical = canonicalize(signed);
    signedScopeCanonical = canonicalize(singularSignatureScope(
      signed as unknown as Record<string, unknown>,
    ));
    evidenceHash = singularSignatureContentHash(signed as unknown as Record<string, unknown>);
  } catch (error) {
    return { status: "pending", stage: "sign", reason: String(error), evidenceDraft: evidence };
  }
  const signatureVerification = await verifySignedEvidence(
    signed,
    evidenceHash,
    requiredEvidenceSigner,
    deps,
  );
  if (signatureVerification.status !== "ok") {
    return {
      status: "pending",
      stage: "sign",
      reason: signatureVerification.reason,
      evidenceDraft: evidence,
      evidence: signed,
      evidenceHash,
    };
  }
  let anchorInput: SignedSellerDeliveryEvidence;
  let anchorInputCanonical: string;
  try {
    anchorInput = structuredClone(signed);
    anchorInputCanonical = canonicalize(anchorInput);
  } catch (error) {
    return { status: "pending", stage: "anchor", reason: String(error), evidenceDraft: evidence };
  }
  let rawAnchored: unknown;
  const evidenceAnchorCall = { fulfilmentId, evidence: anchorInput, evidenceHash };
  try {
    rawAnchored = await deps.anchorEvidence(evidenceAnchorCall);
  } catch (error) {
    rawAnchored = { status: "indeterminate", reason: String(error) };
  }
  try {
    if (!hasOnlyKeys(evidenceAnchorCall, ["fulfilmentId", "evidence", "evidenceHash"]) ||
        evidenceAnchorCall.fulfilmentId !== fulfilmentId ||
        evidenceAnchorCall.evidenceHash !== evidenceHash ||
        evidenceAnchorCall.evidence !== anchorInput ||
        canonicalize(anchorInput) !== anchorInputCanonical ||
        canonicalize(signed) !== signedCanonical ||
        singularSignatureContentHash(signed as unknown as Record<string, unknown>) !== evidenceHash) {
      return {
        status: "pending",
        stage: "anchor",
        reason: "evidence anchor mutated or invalidated the exact signed evidence",
        evidenceDraft: evidence,
        evidence: signed,
        evidenceHash,
      };
    }
    rawAnchored = structuredClone(rawAnchored);
  } catch {
    return {
      status: "pending",
      stage: "anchor",
      reason: "evidence anchor returned a non-cloneable result or corrupted its input",
      evidenceDraft: evidence,
      evidence: signed,
      evidenceHash,
    };
  }
  const anchored = parseEvidenceAnchorResult(rawAnchored);
  if (!anchored) {
    return {
      status: "pending",
      stage: "anchor",
      reason: "evidence anchor returned a malformed result",
      evidenceDraft: evidence,
      evidence: signed,
      evidenceHash,
    };
  }
  if (anchored.status !== "anchored") {
    return {
      status: "pending",
      stage: "anchor",
      reason: anchored.reason,
      evidenceDraft: evidence,
      evidence: signed,
      evidenceHash,
    };
  }
  if (!isAttestationRef(anchored.ref) || anchored.ref.anchor.kind !== "storage-program" ||
      anchored.ref.contentHash !== evidenceHash ||
      (anchored.ref.signer !== undefined && anchored.ref.signer !== requiredEvidenceSigner)) {
    return {
      status: "pending",
      stage: "anchor",
      reason: "evidence anchor is not an exact included SR-2 binding",
      evidenceDraft: evidence,
      evidence: signed,
      evidenceHash,
    };
  }
  const evidenceBinding = anchorReceiptBinding(
    anchored.anchorReceipt,
    anchored.ref.anchor.locator,
    evidenceHash,
    "included",
  );
  if (evidenceBinding.status !== "ok") {
    return {
      status: "pending",
      stage: "anchor",
      reason: evidenceBinding.reason,
      evidenceDraft: evidence,
      evidence: signed,
      evidenceHash,
    };
  }
  const receipt = await verifyReceipt(
    "settlement-evidence",
    anchored.ref,
    evidenceBinding.receipt,
    { role: "phase-orchestrator", primaryClaim: requiredEvidenceSigner },
    deps,
  );
  if (receipt.status !== "ok") {
    return {
      status: "pending",
      stage: "anchor",
      reason: receipt.reason,
      evidenceDraft: evidence,
      evidence: signed,
      evidenceHash,
    };
  }
  let evidenceRefInput: SellerAttestationRef;
  let evidenceRefCanonical: string;
  let rawResolution: unknown;
  try {
    evidenceRefInput = structuredClone(anchored.ref);
    evidenceRefCanonical = canonicalize(evidenceRefInput);
    rawResolution = structuredClone(await deps.resolveEvidence(evidenceRefInput));
    if (canonicalize(evidenceRefInput) !== evidenceRefCanonical) {
      throw new TypeError("evidence resolver mutated its exact AttestationRef input");
    }
  } catch (error) {
    return {
      status: "pending",
      stage: "anchor",
      reason: `evidence read-back is unavailable: ${String(error)}`,
      evidenceDraft: evidence,
      evidence: signed,
      evidenceHash,
    };
  }
  const resolution = parseResolution(rawResolution);
  if (!resolution || resolution.status !== "verified") {
    return {
      status: "pending",
      stage: "anchor",
      reason: !resolution
        ? "evidence resolver returned a malformed result"
        : resolution.reason,
      evidenceDraft: evidence,
      evidence: signed,
      evidenceHash,
    };
  }
  let resolvedEvidence: unknown;
  try {
    resolvedEvidence = structuredClone(resolution.value);
    if (!isRecord(resolvedEvidence) || !isComponentSignature(resolvedEvidence.signature) ||
        resolvedEvidence.signature.signer !== requiredEvidenceSigner ||
        canonicalize(singularSignatureScope(resolvedEvidence)) !== signedScopeCanonical ||
        singularSignatureContentHash(resolvedEvidence) !== evidenceHash) {
      throw new TypeError("resolved evidence differs from the exact anchored signed scope");
    }
  } catch (error) {
    return {
      status: "pending",
      stage: "anchor",
      reason: `evidence read-back is invalid: ${String(error)}`,
      evidenceDraft: evidence,
      evidence: signed,
      evidenceHash,
    };
  }
  const readBackSignature = await verifySignedEvidence(
    resolvedEvidence as unknown as SignedSellerDeliveryEvidence,
    evidenceHash,
    requiredEvidenceSigner,
    deps,
  );
  if (readBackSignature.status !== "ok") {
    return {
      status: "pending",
      stage: "anchor",
      reason: `evidence read-back signature is invalid: ${readBackSignature.reason}`,
      evidenceDraft: evidence,
      evidence: signed,
      evidenceHash,
    };
  }
  try {
    if (signed.signature.signer !== requiredEvidenceSigner ||
        signed.signature.algorithm !== evidenceSigner.algorithm ||
        canonicalize(signed) !== signedCanonical ||
        singularSignatureContentHash(signed as unknown as Record<string, unknown>) !== evidenceHash) {
      return {
        status: "pending",
        stage: "anchor",
        reason: "signed evidence changed during anchor verification",
        evidenceDraft: evidence,
        evidence: signed,
        evidenceHash,
      };
    }
  } catch {
    return {
      status: "pending",
      stage: "anchor",
      reason: "signed evidence became non-canonical during anchor verification",
      evidenceDraft: evidence,
      evidence: signed,
      evidenceHash,
    };
  }
  return {
    status: "anchored",
    evidence: structuredClone(resolvedEvidence) as unknown as SignedSellerDeliveryEvidence,
    evidenceHash,
    evidenceRef: anchored.ref,
    anchorReceipt: evidenceBinding.receipt,
  };
}

async function reconcile(
  deps: SellerFulfilmentDeps,
  input: Parameters<SellerFulfilmentDeps["reconcileDelivery"]>[0],
): Promise<SellerDeliveryReconciliation> {
  try {
    const result = structuredClone(await deps.reconcileDelivery(structuredClone(input)));
    if (!isRecord(result)) {
      return { status: "indeterminate", reason: "delivery reconciler returned an invalid result" };
    }
    if (result.status === "complete" &&
        hasOnlyKeys(result, ["status", "reconciliationId", "observedAt"]) &&
        isNonEmpty(result.reconciliationId) &&
        isSafeUint(result.observedAt)) return result as unknown as SellerDeliveryReconciliation;
    if (result.status === "failed" &&
        hasOnlyKeys(result, ["status", "reason", "observedAt", "reconciliationId"]) &&
        isNonEmpty(result.reason) &&
        isSafeUint(result.observedAt) &&
        (result.reconciliationId === undefined || isNonEmpty(result.reconciliationId))) {
      return result as unknown as SellerDeliveryReconciliation;
    }
    if ((result.status === "pending" || result.status === "indeterminate") &&
        hasOnlyKeys(result, ["status", "reason", "reconciliationId"]) &&
        isNonEmpty(result.reason) &&
        (result.reconciliationId === undefined || isNonEmpty(result.reconciliationId))) {
      return result as unknown as SellerDeliveryReconciliation;
    }
    if (result.status === "absent" && hasOnlyKeys(result, ["status", "reason"]) &&
        isNonEmpty(result.reason)) return result as unknown as SellerDeliveryReconciliation;
    return {
      status: "indeterminate",
      reason: "delivery reconciler returned an invalid result",
    };
  } catch (error) {
    return { status: "indeterminate", reason: String(error) };
  }
}

interface SellerFulfilmentExecutionContext {
  /** Set only from a receipt-store response that proves prior consumption. */
  consumedPaymentAuthorization?: SellerPaymentAuthorization;
}

/**
 * Transport-independent seller fulfilment core. Every irreversible callback
 * runs after a store-backed permit is atomically consumed, in the order DPA
 * record anchor (when applicable), exact delivery submit, then evidence anchor.
 * A replay first reconciles and may resume only the complete candidate retained
 * atomically with consumption, under the same adapter idempotency key.
 */
async function runFulfilmentCoreInner(
  request: SellerFulfilmentRequest,
  deps: SellerFulfilmentDeps,
  execution: SellerFulfilmentExecutionContext,
): Promise<SellerFulfilmentInternalResult> {
  try {
    request = structuredClone(request);
  } catch {
    return rejected("invalid-request", "fulfilment request is not an immutable cloneable value");
  }
  let evidenceSigner: BuildComponentSignatureOptions;
  let auditSourceCommitmentSigner: BuildComponentSignatureOptions;
  try {
    if (!deps.evidenceSigner || !isNonEmpty(deps.evidenceSigner.signer) ||
        typeof deps.evidenceSigner.sign !== "function") {
      return rejected("evidence-signer-invalid", "SettlementEvidence signer capability is malformed");
    }
    if (!deps.auditSourceCommitmentSigner ||
        !isNonEmpty(deps.auditSourceCommitmentSigner.signer) ||
        typeof deps.auditSourceCommitmentSigner.sign !== "function") {
      return rejected(
        "audit-source-commitment-signer-invalid",
        "audit-source commitment signer capability is malformed",
      );
    }
    // Functions cannot be structured-cloned; copy the exact authority and
    // function reference before any untrusted async dependency can mutate deps.
    evidenceSigner = {
      algorithm: deps.evidenceSigner.algorithm,
      signer: deps.evidenceSigner.signer,
      sign: deps.evidenceSigner.sign,
    };
    auditSourceCommitmentSigner = {
      algorithm: deps.auditSourceCommitmentSigner.algorithm,
      signer: deps.auditSourceCommitmentSigner.signer,
      sign: deps.auditSourceCommitmentSigner.sign,
    };
  } catch {
    return rejected(
      "fulfilment-signer-invalid",
      "a fulfilment signer capability is unavailable",
    );
  }

  let inspection: Awaited<ReturnType<SellerFulfilmentReceiptStore["inspectPermit"]>>;
  try {
    inspection = await deps.receiptStore.inspectPermit(request.paymentPermitId);
  } catch (error) {
    return indeterminate("payment-permit-store-unavailable", [String(error)], {
      safeToRetryDelivery: true,
    });
  }
  try {
    inspection = structuredClone(inspection);
  } catch {
    return indeterminate("payment-permit-store-invalid", ["receipt store returned a non-cloneable inspection"], {
      safeToRetryDelivery: false,
    });
  }
  if (!isRecord(inspection) ||
      (inspection.status === "invalid"
        ? !hasOnlyKeys(inspection, ["status"])
        : inspection.status === "available"
          ? !hasOnlyKeys(inspection, ["status", "claim"])
          : inspection.status === "already-consumed"
            ? !hasOnlyKeys(inspection, ["status", "claim", "handoff"])
            : true)) {
    return indeterminate("payment-permit-store-invalid", ["receipt store returned a malformed inspection"], {
      safeToRetryDelivery: false,
    });
  }
  if (inspection.status === "invalid") {
    return rejected("payment-permit-invalid", "payment permit is unknown, stale, or superseded");
  }
  if (!isValidSellerReceiptClaim(inspection.claim)) {
    return indeterminate("payment-permit-store-invalid", ["receipt store returned a malformed authorization"], {
      safeToRetryDelivery: false,
    });
  }
  const claim = structuredClone(inspection.claim);
  const authorization = claim.authorization;
  if (inspection.status === "already-consumed") {
    execution.consumedPaymentAuthorization = structuredClone(authorization);
    if (!isSellerFulfilmentHandoff(inspection.handoff)) {
      return indeterminate("payment-permit-store-invalid", [
        "receipt store returned a malformed consumed handoff",
      ], { safeToRetryDelivery: false });
    }
  }
  let expectedCommitmentAddress: string;
  try {
    expectedCommitmentAddress = finalityCommitmentAddress(authorization.jobId);
  } catch {
    return rejected(
      "payment-authorization-scope-mismatch",
      "permit binds a malformed commitment job identifier",
    );
  }
  let retainedHandoff: SellerFulfilmentHandoffEnvelope | undefined =
    inspection.status === "already-consumed"
    ? structuredClone(inspection.handoff) as SellerFulfilmentHandoffEnvelope
    : undefined;
  const id = sellerFulfilmentId({
    jobId: authorization.jobId,
    paymentPhaseIndex: authorization.phaseIndex,
    deliveryPhaseIndex: request.deliveryPhaseIndex,
    settlementId: authorization.settlementId,
    agreementHash: authorization.agreementHash,
    paymentEvidenceHash: authorization.evidenceHash,
  });
  if (authorization.agreementHash !== request.agreementHash) {
    return rejected("payment-authorization-scope-mismatch", "permit and request bind different agreements");
  }

  let rawAgreementResolution: unknown;
  try {
    rawAgreementResolution = structuredClone(await deps.resolveAgreement(request.agreementRef));
  } catch (error) {
    rawAgreementResolution = { status: "indeterminate", reason: String(error) };
  }
  const agreementResolution = parseResolution(rawAgreementResolution);
  if (!agreementResolution) {
    return indeterminate("agreement-resolution-invalid", ["agreement resolver returned a malformed result"], {
      fulfilmentId: id,
      safeToRetryDelivery: inspection.status === "available",
    });
  }
  if (agreementResolution.status !== "verified") {
    return agreementResolution.status === "rejected"
      ? rejected("agreement-rejected", agreementResolution.reason)
      : indeterminate("agreement-indeterminate", [agreementResolution.reason], {
          fulfilmentId: id,
          safeToRetryDelivery: inspection.status === "available",
        });
  }
  let agreementValue: unknown;
  try {
    agreementValue = structuredClone(agreementResolution.value);
  } catch {
    return rejected("agreement-fields-malformed", "agreement resolver returned a non-cloneable verified view");
  }
  if (!isAgreementValue(agreementValue)) {
    return rejected("agreement-fields-malformed", "agreement resolver returned a malformed verified view");
  }
  const agreement = agreementValue;
  if (agreement.artifactKind !== "payee-bound" || !isHash(agreement.contentHash) ||
      agreement.ref !== request.agreementRef || agreement.contentHash !== request.agreementHash ||
      agreement.contentHash !== authorization.agreementHash || agreement.jobId !== authorization.jobId ||
      agreement.commitment.status !== "finalized" ||
      agreement.commitment.ref !== request.commitmentRef ||
      agreement.commitment.ref !== authorization.commitment.ref ||
      agreement.commitment.ref !== expectedCommitmentAddress ||
      agreement.commitment.agreementHash !== request.agreementHash ||
      !isHash(agreement.commitment.recordContentHash) ||
      agreement.commitment.recordContentHash !== authorization.commitment.contentHash ||
      agreement.commitment.finalizedAt !== authorization.commitment.finalizedAt ||
      agreement.commitment.signer !== authorization.commitment.signer ||
      authorization.evidenceInput.observedAt < agreement.commitment.finalizedAt ||
      !isSafeUint(agreement.commitment.finalizedAt)) {
    return rejected("agreement-commitment-mismatch", "agreement is not the exact finalized payee-bound artifact");
  }
  if (!isNonEmpty(agreement.buyer.primaryClaim) || !isHash(agreement.buyer.bundleHash) ||
      !isNonEmpty(agreement.seller.primaryClaim) || !isHash(agreement.seller.bundleHash) ||
      !pinsEqual(agreement.listingPin, authorization.listingRef)) {
    return rejected("agreement-fields-malformed", "agreement parties or Listing binding are malformed");
  }
  let agreementViewHash: string;
  try {
    agreementViewHash = sha256Hex(canonicalize(agreement));
  } catch (error) {
    return rejected(
      "agreement-fields-malformed",
      `authenticated agreement view is not canonicalizable: ${String(error)}`,
    );
  }
  let rawListingResolution: unknown;
  let listingPinInput: ListingRef;
  let listingPinBefore: string;
  try {
    listingPinInput = structuredClone(agreement.listingPin);
    listingPinBefore = canonicalize(listingPinInput);
    rawListingResolution = structuredClone(await deps.resolveListing(listingPinInput));
    if (canonicalize(listingPinInput) !== listingPinBefore) {
      throw new TypeError("Listing resolver mutated its exact pin input");
    }
  } catch (error) {
    rawListingResolution = { status: "indeterminate", reason: String(error) };
  }
  const listingResolution = parseResolution(rawListingResolution);
  if (!listingResolution) {
    return indeterminate("listing-resolution-invalid", ["Listing resolver returned a malformed result"], {
      fulfilmentId: id,
      safeToRetryDelivery: inspection.status === "available",
    });
  }
  if (listingResolution.status !== "verified") {
    return listingResolution.status === "rejected"
      ? rejected("listing-rejected", listingResolution.reason)
      : indeterminate("listing-indeterminate", [listingResolution.reason], {
          fulfilmentId: id,
          safeToRetryDelivery: inspection.status === "available",
        });
  }
  let listingValue: unknown;
  try {
    listingValue = structuredClone(listingResolution.value);
  } catch {
    return rejected("listing-resolution-mismatch", "Listing resolver returned a non-cloneable verified view");
  }
  if (!isListingValue(listingValue)) {
    return rejected("listing-resolution-mismatch", "Listing resolver returned a malformed verified view");
  }
  const listing = listingValue;
  if (!pinsEqual(listing.pin, agreement.listingPin) ||
      listing.sellerPrimaryClaim !== agreement.seller.primaryClaim ||
      !isBundleRequirement(listing.buyerRequirement) ||
      !Array.isArray(listing.pipeline) || !listing.pipeline.every(isPhaseStep)) {
    return rejected("listing-resolution-mismatch", "resolved Listing does not match its pin or seller");
  }
  if (listing.deliverable.kind === "external") {
    return rejected("unsupported-deliverable", "external has no normative DACS delivery phase");
  }
  const spec = listing.deliverable;
  const violation = validateSpec(spec);
  let specHash: string;
  try {
    specHash = sha256Hex(canonicalize(spec));
  } catch (error) {
    return rejected("deliverable-spec-malformed", String(error));
  }
  const schemaUrl = spec.kind === "storage-program" ? spec.schemaUrl : undefined;
  if (violation || agreement.deliverableRef.deliverableType !== spec.kind ||
      agreement.deliverableRef.hash !== specHash ||
      agreement.deliverableRef.schemaUrl !== schemaUrl) {
    return rejected("deliverable-binding-mismatch", violation ?? "agreement does not hash-bind the Listing DeliverableSpec");
  }
  const phase = phaseFor(spec.kind);
  const deliveryIndices = listing.pipeline
    .map((step, index) => step.kind.startsWith("deliver-") ? index : -1)
    .filter((index) => index >= 0);
  if (deliveryIndices.length !== 1 || deliveryIndices[0] !== request.deliveryPhaseIndex ||
      listing.pipeline[request.deliveryPhaseIndex]?.kind !== phase) {
    return rejected(
      "unsupported-delivery-profile",
      "this release fails closed unless the pipeline contains exactly one bound delivery phase",
    );
  }
  const paymentIndices = listing.pipeline
    .map((step, index) => step.kind.startsWith("pay-") ? index : -1)
    .filter((index) => index >= 0);
  if (paymentIndices.length !== 1 || paymentIndices[0] !== authorization.phaseIndex ||
      authorization.phaseIndex >= request.deliveryPhaseIndex) {
    return rejected(
      "unsupported-payment-profile",
      "this focused profile requires exactly one payment phase before delivery, bound to the permit",
    );
  }
  if (authorization.phaseIndex >= request.deliveryPhaseIndex ||
      listing.pipeline[authorization.phaseIndex]?.kind !== authorization.evidenceInput.phase ||
      listing.pipeline[authorization.phaseIndex]?.parameters?.rail !== authorization.railId) {
    return rejected("payment-phase-mismatch", "permit does not bind the preceding payment phase and rail");
  }

  const requestHasProducerAdmission = Object.prototype.hasOwnProperty.call(
    request,
    "payloadVerificationProducerAdmission",
  );
  const authorizationHasProducerAdmission = Object.prototype.hasOwnProperty.call(
    authorization,
    "payloadVerificationProducerAdmission",
  );
  if (spec.kind !== "attested-payload") {
    if (requestHasProducerAdmission || authorizationHasProducerAdmission) {
      return rejected(
        "payload-producer-admission-unexpected",
        "DPA producer admission is forbidden for non-attested deliverables",
      );
    }
  } else {
    const requestAdmission = request.payloadVerificationProducerAdmission;
    const retainedAdmission = authorization.payloadVerificationProducerAdmission;
    if (!requestHasProducerAdmission || !authorizationHasProducerAdmission ||
        !isProducerAdmissionValue(requestAdmission) ||
        !isProducerAdmissionValue(retainedAdmission)) {
      return rejected(
        "payload-producer-admission-missing",
        "attested-payload fulfilment requires the exact store-retained pre-commit DPA-1 admission",
      );
    }
    let verificationMethodHash: string;
    try {
      verificationMethodHash = sha256Hex(canonicalize(spec.verificationMethod!));
    } catch (error) {
      return rejected("payload-producer-admission-mismatch", String(error));
    }
    if (!exact(requestAdmission, retainedAdmission) ||
        !pinsEqual(retainedAdmission.listingRef, listing.pin) ||
        retainedAdmission.verificationMethodKind !== spec.verificationMethod!.kind ||
        retainedAdmission.verificationMethodHash !== verificationMethodHash ||
        retainedAdmission.deliverableSpecHash !== specHash ||
        retainedAdmission.admittedAt > agreement.commitment.finalizedAt) {
      return rejected(
        "payload-producer-admission-mismatch",
        "DPA producer admission does not exactly bind the Listing, method, spec, and pre-commit time",
      );
    }
  }

  let sessionValue: unknown;
  let auditSource: SellerFulfilmentAuditSourceV1 | undefined;
  let auditSourceHash: string | undefined;
  if (inspection.status === "available") {
    if (deps.auditSourceProfile !== "v2" || !deps.resolveAuditSource) {
      return indeterminate("audit-source-unavailable", [
        "fresh permit consumption requires the explicit V2 audit-source profile",
      ], { fulfilmentId: id, safeToRetryDelivery: true });
    }
    let rawAuditSourceResolution: unknown;
    try {
      rawAuditSourceResolution = await deps.resolveAuditSource(authorization.jobId);
    } catch (error) {
      rawAuditSourceResolution = { status: "indeterminate", reason: String(error) };
    }
    const auditSourceResolution = parseAuditSourceResolution(rawAuditSourceResolution);
    if (!auditSourceResolution) {
      return indeterminate("audit-source-resolution-invalid", [
        "audit-source resolver returned a malformed result",
      ], { fulfilmentId: id, safeToRetryDelivery: true });
    }
    if (auditSourceResolution.status !== "verified") {
      return auditSourceResolution.status === "rejected"
        ? rejected("audit-source-rejected", auditSourceResolution.reason)
        : indeterminate("audit-source-indeterminate", [auditSourceResolution.reason], {
            fulfilmentId: id,
            safeToRetryDelivery: true,
          });
    }
    try {
      auditSource = structuredClone(auditSourceResolution.value) as SellerFulfilmentAuditSourceV1;
    } catch {
      return rejected("audit-source-mismatch", "audit-source resolver returned a non-cloneable value");
    }
    if (!isSellerFulfilmentAuditSource(auditSource)) {
      return rejected("audit-source-mismatch", "audit-source resolver returned a malformed value");
    }
    sessionValue = auditSource.session;
  } else if (retainedHandoff) {
    auditSource = structuredClone(retainedHandoff.auditSource);
    auditSourceHash = retainedHandoff.auditSourceHash;
    sessionValue = auditSource.session;
  }
  if (!auditSource || sessionValue === undefined) {
    return indeterminate("audit-source-unavailable", [
      "durable handoff did not retain the mandatory V2 audit source",
    ], { fulfilmentId: id, safeToRetryDelivery: false });
  }
  const sessionViolation = sessionRecordViolation(
    sessionValue,
    authorization,
    agreement,
    listing,
    request.deliveryPhaseIndex,
    expectedCommitmentAddress,
  );
  if (sessionViolation) return rejected("session-record-mismatch", sessionViolation);
  const session = sessionValue as SellerFulfilmentSessionRecord;
  const sessionOrchestrator = session.parties.find((party) => party.role === "orchestrator");
  if (!sessionOrchestrator) {
    return rejected(
      "phase-orchestrator-missing",
      "authenticated SessionRecord does not name the delivery phase orchestrator",
    );
  }
  if (authorization.commitment.signer !== sessionOrchestrator.primaryClaim) {
    return rejected(
      "agreement-commitment-mismatch",
      "finality commitment signer is not the authenticated session orchestrator",
    );
  }
  const auditViolation = auditSourceViolation(
    auditSource,
    session,
    authorization,
    agreement,
    listing,
    request,
    request.deliveryPhaseIndex,
    expectedCommitmentAddress,
  );
  if (auditViolation) return rejected("audit-source-mismatch", auditViolation);
  const derivedHash = sellerFulfilmentAuditSourceHash(auditSource);
  if (auditSourceHash !== undefined && auditSourceHash !== derivedHash) {
    return rejected("audit-source-mismatch", "audit source hash does not bind its exact bytes");
  }
  auditSourceHash = derivedHash;
  const requiredEvidenceSigner = sessionOrchestrator.primaryClaim;
  if (evidenceSigner.signer !== requiredEvidenceSigner) {
    return rejected(
      "evidence-signer-mismatch",
      "SettlementEvidence signer is not the authenticated phase orchestrator",
    );
  }
  if (auditSourceCommitmentSigner.signer !== requiredEvidenceSigner) {
    return rejected(
      "audit-source-commitment-signer-mismatch",
      "audit-source commitment signer is not the authenticated phase orchestrator",
    );
  }
  if (retainedHandoff) {
    const commitmentVerification = await verifyAuditSourceCommitment(
      retainedHandoff.auditSourceCommitment,
      requiredEvidenceSigner,
      deps,
    );
    if (commitmentVerification.status !== "ok") {
      return indeterminate(
        commitmentVerification.status === "invalid"
          ? "audit-source-commitment-invalid"
          : "audit-source-commitment-indeterminate",
        [commitmentVerification.reason],
        { fulfilmentId: id, safeToRetryDelivery: false },
      );
    }
  }

  const minimumDeliveryTime = Math.max(
    agreement.commitment.finalizedAt,
    authorization.evidenceInput.observedAt,
    session.lastUpdatedAt,
  );

  const logicalAddress = deliveryAddress(agreement.jobId, phase);
  let preparedArtifact: SellerDeliveredArtifact | undefined;
  let preparedArtifactBinding: string | undefined;
  let preparedValidation:
    | Extract<Awaited<ReturnType<typeof validatePreparedArtifact>>, { status: "ok" }>
    | undefined;
  let preparationFailureReason: string | undefined;
  let preparationValidatedAt: number | undefined;
  let retainedPreparedCandidate:
    | Extract<SellerFulfilmentHandoff["candidate"], { status: "prepared" }>
    | undefined;

  // A consumed permit is recoverable only through the complete candidate that
  // the receipt store committed atomically with consumption. Never invoke the
  // application preparer again and never accept replacement work.
  if (retainedHandoff) {
    const violation = handoffBindingViolation(
      retainedHandoff,
      authorization,
      request,
      id,
      phase,
      logicalAddress,
      specHash,
      agreementViewHash,
      evidenceSigner,
    );
    if (violation) {
      return indeterminate("payment-permit-store-invalid", [violation], {
        fulfilmentId: id,
        safeToRetryDelivery: false,
      });
    }
    preparationValidatedAt = retainedHandoff.candidate.validatedAt;
    if (retainedHandoff.candidate.status === "preparation-failed") {
      preparationFailureReason = retainedHandoff.candidate.reason;
    } else {
      retainedPreparedCandidate = structuredClone(retainedHandoff.candidate);
    }
  }
  const retainedValidationFloor = retainedHandoff?.validationFloorAt ??
    minimumDeliveryTime;

  // Reconcile a consumed permit before re-running success-path candidate
  // verifiers. An exact durable failure must not be demoted by a later schema,
  // proof, or key-service outage. Complete/absent paths still revalidate every
  // retained byte before it can authorize delivery or success evidence.
  let reconciliation = await reconcile(deps, {
    fulfilmentId: id,
    jobId: agreement.jobId,
    phaseIndex: request.deliveryPhaseIndex,
    phase,
  });
  if (reconciliation.status === "pending" || reconciliation.status === "indeterminate") {
    return indeterminate("delivery-reconciliation-pending", [reconciliation.reason], {
      fulfilmentId: id,
      safeToRetryDelivery: false,
      recovery: {
        action: "reconcile-delivery",
        ...(reconciliation.reconciliationId
          ? { reconciliationId: reconciliation.reconciliationId }
          : {}),
      },
    });
  }
  if (inspection.status === "available" &&
      (reconciliation.status === "complete" || reconciliation.status === "failed")) {
    return rejected(
      "delivery-effect-before-permit-consumption",
      "delivery reconciliation reported a terminal effect before the one-shot permit was consumed",
    );
  }

  if (reconciliation.status !== "failed" && retainedPreparedCandidate) {
      const retainedDelivery = structuredClone(retainedPreparedCandidate.delivery);
      const hasPayloadRecord = Object.prototype.hasOwnProperty.call(
        retainedDelivery,
        "payloadAttestationRecord",
      );
      if ((phase === "deliver-attested-payload") !== hasPayloadRecord) {
        return indeterminate("payment-permit-store-invalid", [
          "retained handoff has the wrong PayloadAttestationRecord profile",
        ], { fulfilmentId: id, safeToRetryDelivery: false });
      }
      const validation = await validatePreparedArtifact(
        retainedDelivery.artifact,
        retainedDelivery.payloadAttestationRecord,
        "prepared",
        phase,
        agreement,
        spec,
        retainedPreparedCandidate.validatedAt,
        retainedValidationFloor,
        deps,
      );
      if (validation.status !== "ok") {
        return indeterminate(
          validation.status === "invalid"
            ? "payment-permit-store-invalid"
            : "delivery-preparation-indeterminate",
          [`retained fulfilment candidate is not valid: ${validation.reason}`],
          { fulfilmentId: id, safeToRetryDelivery: false },
        );
      }
      preparedArtifact = retainedDelivery.artifact as SellerDeliveredArtifact;
      preparedValidation = validation;
      try {
        preparedArtifactBinding = preparedArtifactHash(preparedArtifact);
      } catch (error) {
        return indeterminate("payment-permit-store-invalid", [
          `retained fulfilment candidate identity is invalid: ${String(error)}`,
        ], { fulfilmentId: id, safeToRetryDelivery: false });
      }
      if (preparedArtifactBinding !== retainedPreparedCandidate.artifactHash) {
        return indeterminate("payment-permit-store-invalid", [
          "retained fulfilment candidate does not match its atomic artifact hash",
        ], { fulfilmentId: id, safeToRetryDelivery: false });
      }
  }

  if (reconciliation.status === "absent" && inspection.status === "available") {
    let preparationStartedAt: number;
    try {
      preparationStartedAt = deps.nowMs();
    } catch (error) {
      return indeterminate("clock-failed", [String(error)], {
        fulfilmentId: id,
        safeToRetryDelivery: true,
      });
    }
    if (!isSafeUint(preparationStartedAt)) {
      return indeterminate("clock-invalid", ["clock must return non-negative unix milliseconds"], {
        fulfilmentId: id,
        safeToRetryDelivery: true,
      });
    }
    if (preparationStartedAt < minimumDeliveryTime) {
      return indeterminate("clock-invalid", [
        "delivery clock precedes the finalized commitment, payment observation, or SessionRecord",
      ], { fulfilmentId: id, safeToRetryDelivery: true });
    }
    let rawPreparation: unknown;
    const preparationInput = {
      fulfilmentId: id,
      jobId: agreement.jobId,
      phaseIndex: request.deliveryPhaseIndex,
      phase,
      logicalAddress,
      agreement: structuredClone(agreement),
      deliverable: structuredClone(spec),
    };
    const preparationInputBefore = canonicalize(preparationInput);
    if (spec.kind === "attested-payload") {
      // DPA-1 is checked again locally at the last reversible boundary. This
      // fresh `produce` decision is never substituted with a reader `verify`
      // capability and is not reused on consumed-permit reconciliation.
      const capability = await preflightPayloadCapability(spec, specHash, deps);
      if (capability.status === "unsupported") {
        return rejected("payload-method-capability-unsupported", capability.reason);
      }
      if (capability.status === "indeterminate") {
        return indeterminate("payload-method-capability-indeterminate", [capability.reason], {
          fulfilmentId: id,
          safeToRetryDelivery: true,
        });
      }
    }
    try {
      rawPreparation = await deps.prepareDelivery(preparationInput);
      if (canonicalize(preparationInput) !== preparationInputBefore) {
        throw new TypeError("delivery preparer mutated its exact authorized input");
      }
      rawPreparation = structuredClone(rawPreparation);
    } catch (error) {
      return indeterminate("delivery-preparation-indeterminate", [String(error)], {
        fulfilmentId: id,
        safeToRetryDelivery: true,
      });
    }
    if (!isRecord(rawPreparation)) {
      return indeterminate("delivery-preparation-invalid", [
        "delivery preparer returned a malformed result",
      ], {
        fulfilmentId: id,
        safeToRetryDelivery: true,
      });
    }
    if (rawPreparation.status === "indeterminate") {
      if (!hasOnlyKeys(rawPreparation, ["status", "reason"]) ||
          !isNonEmpty(rawPreparation.reason)) {
        return indeterminate("delivery-preparation-invalid", [
          "delivery preparer returned a malformed indeterminate result",
        ], {
          fulfilmentId: id,
          safeToRetryDelivery: true,
        });
      }
      return indeterminate("delivery-preparation-indeterminate", [rawPreparation.reason], {
        fulfilmentId: id,
        safeToRetryDelivery: true,
      });
    }
    let preparationObservedAt: number;
    try {
      // Snapshot every terminal preparation outcome after the callback returns.
      // Retained failure evidence must describe when rejection/invalid work was
      // actually observed, not merely when the attempt began.
      preparationObservedAt = deps.nowMs();
    } catch (error) {
      return indeterminate("clock-failed", [String(error)], {
        fulfilmentId: id,
        safeToRetryDelivery: true,
      });
    }
    if (!isSafeUint(preparationObservedAt)) {
      return indeterminate("clock-invalid", ["clock must return non-negative unix milliseconds"], {
        fulfilmentId: id,
        safeToRetryDelivery: true,
      });
    }
    if (preparationObservedAt < minimumDeliveryTime ||
        preparationObservedAt < preparationStartedAt) {
      return indeterminate("clock-invalid", [
        "delivery clock precedes preparation or the finalized commitment, payment observation, or SessionRecord",
      ], { fulfilmentId: id, safeToRetryDelivery: true });
    }
    preparationValidatedAt = preparationObservedAt;
    if (rawPreparation.status === "rejected") {
      if (!hasOnlyKeys(rawPreparation, ["status", "reason"]) ||
          !isNonEmpty(rawPreparation.reason)) {
        return indeterminate("delivery-preparation-invalid", [
          "delivery preparer returned a malformed rejection",
        ], {
          fulfilmentId: id,
          safeToRetryDelivery: true,
        });
      }
      preparationFailureReason = rawPreparation.reason;
    } else if (rawPreparation.status === "prepared" &&
        hasOnlyKeys(rawPreparation, ["status", "delivery"]) &&
        isRecord(rawPreparation.delivery) &&
        hasOnlyKeys(rawPreparation.delivery, ["artifact", "payloadAttestationRecord"]) &&
        Object.prototype.hasOwnProperty.call(rawPreparation.delivery, "artifact")) {
      const preparedDelivery = rawPreparation.delivery;
      const hasPayloadRecord = Object.prototype.hasOwnProperty.call(
        preparedDelivery,
        "payloadAttestationRecord",
      );
      if ((phase === "deliver-attested-payload") !== hasPayloadRecord) {
        preparationFailureReason = "prepared delivery has the wrong PayloadAttestationRecord profile";
      } else {
        const validation = await validatePreparedArtifact(
          preparedDelivery.artifact,
          preparedDelivery.payloadAttestationRecord,
          "prepared",
          phase,
          agreement,
          spec,
          preparationObservedAt,
          minimumDeliveryTime,
          deps,
        );
        if (validation.status === "ok") {
          preparedArtifact = preparedDelivery.artifact as SellerDeliveredArtifact;
          preparedValidation = validation;
          try {
            preparedArtifactBinding = preparedArtifactHash(preparedArtifact);
          } catch (error) {
            preparationFailureReason = `prepared delivery identity is invalid: ${String(error)}`;
            preparedArtifact = undefined;
            preparedValidation = undefined;
          }
        } else if (validation.status === "indeterminate") {
          return indeterminate(
            validation.reason.includes("confidentiality downgrade")
              ? "delivery-confidentiality-downgrade"
              : "delivery-preparation-indeterminate",
            [validation.reason],
            { fulfilmentId: id, safeToRetryDelivery: true },
          );
        } else {
          preparationFailureReason = validation.reason;
        }
      }
    } else {
      return indeterminate("delivery-preparation-invalid", [
        "delivery preparer returned an unsupported result envelope",
      ], {
        fulfilmentId: id,
        safeToRetryDelivery: true,
      });
    }
  }

  let proposedHandoff: SellerFulfilmentHandoffEnvelope | undefined;
  if (inspection.status === "available") {
    if (preparationValidatedAt === undefined) {
      return indeterminate("delivery-preparation-invalid", [
        "delivery preparation did not produce a durable validation time",
      ], { fulfilmentId: id, safeToRetryDelivery: true });
    }
    let candidate: SellerFulfilmentHandoff["candidate"];
    if (preparationFailureReason) {
      candidate = {
        status: "preparation-failed",
        validatedAt: preparationValidatedAt,
        reason: preparationFailureReason,
      };
    } else if (preparedArtifact && preparedArtifactBinding && preparedValidation) {
      candidate = {
        status: "prepared",
        validatedAt: preparationValidatedAt,
        artifactHash: preparedArtifactBinding,
        delivery: {
          artifact: structuredClone(preparedArtifact),
          ...(preparedValidation.payloadRecord
            ? { payloadAttestationRecord: structuredClone(preparedValidation.payloadRecord) }
            : {}),
        },
      };
    } else {
      return indeterminate("delivery-preparation-invalid", [
        "validated delivery candidate was not available for atomic handoff",
      ], { fulfilmentId: id, safeToRetryDelivery: true });
    }
    if (!auditSource || !auditSourceHash) {
      return indeterminate("audit-source-unavailable", [
        "permit consumption cannot commit without the authenticated audit source",
      ], { fulfilmentId: id, safeToRetryDelivery: true });
    }
    const authorizationHash = sha256Hex(canonicalize(authorization));
    const signedAuditSourceCommitment = await signAuditSourceCommitment(
      {
        commitmentVersion: "1",
        fulfilmentId: id,
        jobId: authorization.jobId,
        authorizationHash,
        auditSourceHash,
        candidateHash: sellerFulfilmentCandidateHash(candidate),
      },
      auditSourceCommitmentSigner,
      requiredEvidenceSigner,
      deps,
    );
    if (signedAuditSourceCommitment.status !== "ok") {
      return indeterminate("audit-source-commitment-indeterminate", [
        signedAuditSourceCommitment.reason,
      ], { fulfilmentId: id, safeToRetryDelivery: true });
    }
    proposedHandoff = {
      handoffVersion: "2",
      fulfilmentId: id,
      jobId: authorization.jobId,
      agreementRef: request.agreementRef,
      agreementHash: authorization.agreementHash,
      commitmentRef: request.commitmentRef,
      authorizationHash,
      settlementId: authorization.settlementId,
      paymentEvidenceHash: authorization.evidenceHash,
      paymentPhaseIndex: authorization.phaseIndex,
      deliveryPhaseIndex: request.deliveryPhaseIndex,
      phase,
      logicalAddress,
      deliverableSpecHash: specHash,
      agreementViewHash,
      validationFloorAt: minimumDeliveryTime,
      evidenceAuthority: {
        primaryClaim: requiredEvidenceSigner,
        algorithm: evidenceSigner.algorithm,
      },
      auditSource: structuredClone(auditSource),
      auditSourceHash,
      auditSourceCommitment: signedAuditSourceCommitment.commitment,
      candidate,
    };
    if (!isSellerFulfilmentHandoff(proposedHandoff)) {
      return indeterminate("delivery-preparation-invalid", [
        "validated delivery candidate could not form an exact durable handoff",
      ], { fulfilmentId: id, safeToRetryDelivery: true });
    }
  }

  let permitClaim = claim;
  if (inspection.status === "available") {
    if (!proposedHandoff) {
      return indeterminate("delivery-preparation-invalid", [
        "permit consumption requires an exact durable handoff",
      ], { fulfilmentId: id, safeToRetryDelivery: true });
    }
    let consumed: Awaited<ReturnType<SellerFulfilmentReceiptStore["consumePermit"]>>;
    try {
      consumed = await deps.receiptStore.consumePermit(
        request.paymentPermitId,
        structuredClone(proposedHandoff),
      );
    } catch (error) {
      return indeterminate("payment-permit-store-unavailable", [String(error)], {
        fulfilmentId: id,
        // Consumption may have committed before the response was lost.
        safeToRetryDelivery: false,
        recovery: { action: "reconcile-delivery" },
      });
    }
    try {
      consumed = structuredClone(consumed);
    } catch {
      return indeterminate("payment-permit-store-invalid", [
        "receipt store returned a non-cloneable consumption result",
      ], {
        fulfilmentId: id,
        safeToRetryDelivery: false,
      });
    }
    if (!isRecord(consumed) ||
        (consumed.status === "invalid"
          ? !hasOnlyKeys(consumed, ["status"])
          : consumed.status === "consumed" || consumed.status === "already-consumed"
            ? !hasOnlyKeys(consumed, ["status", "claim", "handoff"])
            : true)) {
      return indeterminate("payment-permit-store-invalid", ["receipt store returned a malformed consumption result"], {
        fulfilmentId: id,
        safeToRetryDelivery: false,
      });
    }
    if (consumed.status === "invalid") {
      return rejected("payment-permit-invalid", "payment permit became invalid before consumption");
    }
    if (!isValidSellerReceiptClaim(consumed.claim)) {
      return indeterminate("payment-permit-store-invalid", ["permit authorization changed during consumption"], {
        fulfilmentId: id,
        safeToRetryDelivery: false,
      });
    }
    // A runtime-valid consumed response is authoritative proof of payment use,
    // even when its exact claim/handoff later fails the request-binding check.
    // Retain that proof before every post-consumption return path.
    execution.consumedPaymentAuthorization = structuredClone(
      consumed.claim.authorization,
    );
    if (!isSellerFulfilmentHandoff(consumed.handoff)) {
      return indeterminate("payment-permit-store-invalid", ["receipt store returned a malformed consumed handoff"], {
        fulfilmentId: id,
        safeToRetryDelivery: false,
      });
    }
    if (!exact(consumed.claim, claim)) {
      return indeterminate("payment-permit-store-invalid", ["permit authorization changed during consumption"], {
        fulfilmentId: id,
        safeToRetryDelivery: false,
      });
    }
    if (!sameFulfilmentHandoff(consumed.handoff, proposedHandoff)) {
      return indeterminate("payment-permit-store-invalid", [
        "receipt store returned a different retained fulfilment handoff",
      ], { fulfilmentId: id, safeToRetryDelivery: false });
    }
    permitClaim = consumed.claim;
    retainedHandoff = structuredClone(consumed.handoff);
  }
  if (!exact(permitClaim.authorization, authorization)) {
    return indeterminate("payment-permit-store-invalid", ["consumed authorization differs from preflight"], {
      fulfilmentId: id,
      safeToRetryDelivery: false,
    });
  }
  execution.consumedPaymentAuthorization = structuredClone(permitClaim.authorization);

  if (preparationFailureReason && reconciliation.status !== "absent") {
    if (reconciliation.status === "complete" ||
        (reconciliation.status === "failed" &&
          reconciliation.reason !== preparationFailureReason)) {
      return indeterminate("delivery-reconciliation-contradiction", [
        "authoritative delivery state contradicts the exact retained preparation failure",
      ], {
        fulfilmentId: id,
        safeToRetryDelivery: false,
        recovery: { action: "reconcile-delivery" },
      });
    }
    if (reconciliation.status === "failed") {
      // The retained handoff owns the failure identity and observation time;
      // an exact durable echo may contribute only its reconciliation id.
      reconciliation = {
        status: "failed",
        reason: preparationFailureReason,
        observedAt: preparationValidatedAt!,
        ...(reconciliation.reconciliationId
          ? { reconciliationId: reconciliation.reconciliationId }
          : {}),
      };
    }
  }

  if (reconciliation.status === "absent") {
    if (!retainedHandoff) {
      return indeterminate("payment-permit-store-invalid", [
        "consumed permit has no retained fulfilment handoff",
      ], { fulfilmentId: id, safeToRetryDelivery: false });
    }
    if (preparationFailureReason) {
      reconciliation = {
        status: "failed",
        reason: preparationFailureReason,
        observedAt: preparationValidatedAt!,
      };
    } else if (!preparedArtifact || !preparedArtifactBinding || !preparedValidation) {
      return indeterminate("delivery-preparation-invalid", [
        "validated delivery candidate was not retained through permit consumption",
      ], {
        fulfilmentId: id,
        safeToRetryDelivery: false,
        recovery: { action: "reconcile-delivery" },
      });
    }
    if (reconciliation.status === "absent" && phase === "deliver-attested-payload") {
      const retainedValidation = preparedValidation;
      const retainedArtifact = preparedArtifact;
      if (spec.kind !== "attested-payload" || !retainedValidation || !retainedArtifact ||
          !retainedValidation.payloadRecord || !retainedValidation.payloadRecordHash ||
          !retainedValidation.attestationRef) {
        return indeterminate("payment-permit-store-invalid", [
          "validated PayloadAttestationRecord was not retained",
        ], {
          fulfilmentId: id,
          safeToRetryDelivery: false,
          recovery: { action: "reconcile-payload-attestation" },
        });
      } else {
        let anchorObservedAt: number;
        try {
          anchorObservedAt = deps.nowMs();
        } catch (error) {
          return indeterminate("clock-failed", [String(error)], {
            fulfilmentId: id,
            safeToRetryDelivery: false,
            recovery: { action: "reconcile-payload-attestation" },
          });
        }
        if (!isSafeUint(anchorObservedAt)) {
          return indeterminate("clock-invalid", ["clock must return non-negative unix milliseconds"], {
            fulfilmentId: id,
            safeToRetryDelivery: false,
            recovery: { action: "reconcile-payload-attestation" },
          });
        }
        if (anchorObservedAt < retainedValidationFloor) {
          return indeterminate("clock-invalid", [
            "payload-attestation clock precedes the finalized payment/session state",
          ], {
            fulfilmentId: id,
            safeToRetryDelivery: false,
            recovery: { action: "reconcile-payload-attestation" },
          });
        }
        const anchoredRecord = await anchorPreparedPayloadAttestation(
          {
            record: retainedValidation.payloadRecord,
            recordHash: retainedValidation.payloadRecordHash,
            ref: retainedValidation.attestationRef,
          },
          retainedArtifact,
          agreement,
          spec,
          retainedValidation.deliverableContentHash,
          anchorObservedAt,
          retainedValidationFloor,
          deps,
        );
        if (anchoredRecord.status === "indeterminate") {
          return indeterminate("payload-attestation-publication-pending", [anchoredRecord.reason], {
            fulfilmentId: id,
            safeToRetryDelivery: false,
            recovery: { action: "reconcile-payload-attestation" },
          });
        }
        if (anchoredRecord.status === "invalid") {
          return indeterminate("payload-attestation-publication-invalid", [
            anchoredRecord.reason,
          ], {
            fulfilmentId: id,
            safeToRetryDelivery: false,
            recovery: { action: "reconcile-payload-attestation" },
          });
        }
      }
    }
    if (reconciliation.status === "failed") {
      // Preparation/record publication failed conclusively; no deliverable was submitted.
    } else {
    let submission: SellerDeliverySubmission;
    const submissionInput = {
      fulfilmentId: id,
      jobId: agreement.jobId,
      phaseIndex: request.deliveryPhaseIndex,
      phase,
      logicalAddress,
      agreement: structuredClone(agreement),
      deliverable: structuredClone(spec),
      artifact: structuredClone(preparedArtifact!),
      artifactHash: preparedArtifactBinding!,
    };
    const submissionInputSnapshot = structuredClone(submissionInput);
    try {
      submission = structuredClone(await deps.submitDelivery(submissionInput));
      if (!hasOnlyKeys(submissionInput, [
        "fulfilmentId", "jobId", "phaseIndex", "phase", "logicalAddress", "agreement",
        "deliverable", "artifact", "artifactHash",
      ]) || submissionInput.fulfilmentId !== submissionInputSnapshot.fulfilmentId ||
          submissionInput.jobId !== submissionInputSnapshot.jobId ||
          submissionInput.phaseIndex !== submissionInputSnapshot.phaseIndex ||
          submissionInput.phase !== submissionInputSnapshot.phase ||
          submissionInput.logicalAddress !== submissionInputSnapshot.logicalAddress ||
          submissionInput.artifactHash !== submissionInputSnapshot.artifactHash ||
          !exact(submissionInput.agreement, submissionInputSnapshot.agreement) ||
          !exact(submissionInput.deliverable, submissionInputSnapshot.deliverable) ||
          !sameDeliveredArtifact(submissionInput.artifact, submissionInputSnapshot.artifact)) {
        throw new TypeError("delivery submitter mutated its exact authorized input");
      }
    } catch (error) {
      return indeterminate("delivery-submission-ambiguous", [String(error)], {
        fulfilmentId: id,
        safeToRetryDelivery: false,
        recovery: { action: "reconcile-delivery" },
      });
    }
    if (!isRecord(submission) ||
        (submission.status === "accepted"
          ? !hasOnlyKeys(submission, ["status", "reconciliationId"]) ||
            !isNonEmpty(submission.reconciliationId)
          : submission.status === "rejected"
            ? !hasOnlyKeys(submission, ["status", "reason"]) ||
              !isNonEmpty(submission.reason)
            : submission.status === "indeterminate"
              ? !hasOnlyKeys(submission, ["status", "reason", "reconciliationId"]) ||
                !isNonEmpty(submission.reason) ||
                (submission.reconciliationId !== undefined &&
                  !isNonEmpty(submission.reconciliationId))
              : true)) {
      return indeterminate("delivery-submission-ambiguous", ["delivery submitter returned an invalid result"], {
        fulfilmentId: id,
        safeToRetryDelivery: false,
        recovery: { action: "reconcile-delivery" },
      });
    }
    if (submission.status === "indeterminate") {
      return indeterminate("delivery-submission-ambiguous", [submission.reason], {
        fulfilmentId: id,
        safeToRetryDelivery: false,
        recovery: {
          action: "reconcile-delivery",
          ...(submission.reconciliationId ? { reconciliationId: submission.reconciliationId } : {}),
        },
      });
    }
    if (submission.status === "rejected") {
      const afterRejection = await reconcile(deps, {
        fulfilmentId: id,
        jobId: agreement.jobId,
        phaseIndex: request.deliveryPhaseIndex,
        phase,
      });
      if (afterRejection.status === "complete" || afterRejection.status === "failed") {
        reconciliation = afterRejection;
      } else if (afterRejection.status === "absent") {
        return indeterminate("delivery-rejection-unreconciled", [submission.reason], {
          fulfilmentId: id,
          safeToRetryDelivery: false,
          recovery: { action: "reconcile-delivery" },
        });
      } else {
        return indeterminate("delivery-reconciliation-pending", [afterRejection.reason], {
          fulfilmentId: id,
          safeToRetryDelivery: false,
          recovery: {
            action: "reconcile-delivery",
            ...(afterRejection.reconciliationId
              ? { reconciliationId: afterRejection.reconciliationId }
              : {}),
          },
        });
      }
    } else {
      reconciliation = await reconcile(deps, {
        fulfilmentId: id,
        jobId: agreement.jobId,
        phaseIndex: request.deliveryPhaseIndex,
        phase,
        reconciliationId: submission.reconciliationId,
      });
      if (reconciliation.status !== "complete" && reconciliation.status !== "failed") {
        return indeterminate("delivery-reconciliation-pending", [reconciliation.reason], {
          fulfilmentId: id,
          safeToRetryDelivery: false,
          recovery: {
            action: "reconcile-delivery",
            ...("reconciliationId" in reconciliation && reconciliation.reconciliationId
              ? { reconciliationId: reconciliation.reconciliationId }
              : { reconciliationId: submission.reconciliationId }),
          },
        });
      }
    }
    }
  }

  if (reconciliation.status !== "complete" && reconciliation.status !== "failed") {
    return indeterminate("delivery-reconciliation-pending", [
      "delivery state was not terminal after permit consumption",
    ], {
      fulfilmentId: id,
      safeToRetryDelivery: false,
      recovery: { action: "reconcile-delivery" },
    });
  }

  let checkedAt: number;
  try {
    checkedAt = deps.nowMs();
  } catch (error) {
    return indeterminate("clock-failed", [String(error)], {
      fulfilmentId: id,
      safeToRetryDelivery: false,
      recovery: { action: "reconcile-delivery" },
    });
  }
  if (!isSafeUint(checkedAt)) {
    return indeterminate("clock-invalid", ["clock must return non-negative unix milliseconds"], {
      fulfilmentId: id,
      safeToRetryDelivery: false,
      recovery: { action: "reconcile-delivery" },
    });
  }
  const observedAt = reconciliation.observedAt;
  // Once the permit is consumed, the retained candidate's validation time is
  // the stable causal lower bound for this exact delivery. A later authenticated
  // SessionRecord update must not invalidate an already-terminal delivery fact
  // that followed that retained validation.
  const terminalDeliveryMinimum = retainedHandoff
    ? Math.max(
        agreement.commitment.finalizedAt,
        authorization.evidenceInput.observedAt,
        retainedHandoff.candidate.validatedAt,
      )
    : minimumDeliveryTime;
  if (!isSafeUint(observedAt) || observedAt < terminalDeliveryMinimum ||
      observedAt > checkedAt) {
    return indeterminate("clock-invalid", [
      "stable delivery observation is outside the finalized-state/current-clock bounds",
    ], {
      fulfilmentId: id,
      safeToRetryDelivery: false,
      recovery: { action: "reconcile-delivery" },
    });
  }

  let unsignedEvidence: SellerDeliverySuccessEvidence | SellerDeliveryFailureEvidence;
  let outcome: "ok" | "fail";
  let errorClass: "permanent" | "transient" | "counterparty" | "substrate" | undefined;
  if (reconciliation.status === "failed") {
    outcome = "fail";
    // Application adapters report facts/reasons, never fault attribution.
    // This focused profile has no authenticated counterparty/substrate proof,
    // so a conclusive local delivery failure is classified as permanent.
    errorClass = "permanent";
    unsignedEvidence = {
      evidenceVersion: "1",
      jobId: agreement.jobId,
      phase,
      outcome: "failure",
      reason: reconciliation.reason,
      observedAt,
    };
  } else if (reconciliation.status === "complete") {
    let rawDeliveryResolution: unknown;
    const deliveryResolutionInput = {
      logicalAddress,
      jobId: agreement.jobId,
      phaseIndex: request.deliveryPhaseIndex,
      phase,
    };
    const deliveryResolutionInputBefore = canonicalize(deliveryResolutionInput);
    try {
      rawDeliveryResolution = structuredClone(
        await deps.resolveDelivery(deliveryResolutionInput),
      );
      if (canonicalize(deliveryResolutionInput) !== deliveryResolutionInputBefore) {
        throw new TypeError("delivery resolver mutated its exact logical-address input");
      }
    } catch (error) {
      rawDeliveryResolution = { status: "indeterminate", reason: String(error) };
    }
    const deliveryResolution = parseResolution(rawDeliveryResolution);
    if (!deliveryResolution) {
      return indeterminate("delivery-resolution-pending", [
        "delivery resolver returned a malformed result",
      ], {
        fulfilmentId: id,
        safeToRetryDelivery: false,
        recovery: {
          action: "reconcile-delivery",
          reconciliationId: reconciliation.reconciliationId,
        },
      });
    }
    if (deliveryResolution.status === "indeterminate") {
      return indeterminate("delivery-resolution-pending", [deliveryResolution.reason], {
        fulfilmentId: id,
        safeToRetryDelivery: false,
        recovery: {
          action: "reconcile-delivery",
          reconciliationId: reconciliation.reconciliationId,
        },
      });
    } else if (deliveryResolution.status === "rejected") {
      // A resolver rejection is an authenticated contradiction, not an outage.
      // The phase has already reconciled complete, so preserve the contradiction
      // as terminal failure evidence rather than leaving the paid session pending.
      outcome = "fail";
      errorClass = "permanent";
      unsignedEvidence = {
        evidenceVersion: "1",
        jobId: agreement.jobId,
        phase,
        outcome: "failure",
        reason: deliveryResolution.reason,
        observedAt,
      };
    } else {
      let deliveryValue: unknown;
      try {
        deliveryValue = structuredClone(deliveryResolution.value);
      } catch {
        return indeterminate("delivery-resolution-pending", [
          "delivery resolver returned a non-cloneable verified value",
        ], {
          fulfilmentId: id,
          safeToRetryDelivery: false,
          recovery: {
            action: "reconcile-delivery",
            reconciliationId: reconciliation.reconciliationId,
          },
        });
      }
      const validated = await validateDeliveredArtifact(
        deliveryValue as SellerResolvedDelivery,
        phase,
        logicalAddress,
        agreement,
        spec,
        observedAt,
        retainedValidationFloor,
        deps,
        preparedArtifact,
      );
      if (validated.status === "ok") {
        outcome = "ok";
        unsignedEvidence = {
          evidenceVersion: "1",
          jobId: agreement.jobId,
          phase,
          outcome: "success",
          deliverableContentHash: validated.deliverableContentHash,
          deliverableAnchor: { kind: "storage-program", locator: logicalAddress },
          ...(validated.attestationRef ? { attestationRef: validated.attestationRef } : {}),
          observedAt,
        };
      } else if (validated.status === "indeterminate") {
        return indeterminate(
          validated.reason.includes("confidentiality downgrade")
            ? "delivery-confidentiality-downgrade"
            : "delivery-verification-indeterminate",
          [validated.reason],
          {
            fulfilmentId: id,
            safeToRetryDelivery: false,
            recovery: {
              action: "reconcile-delivery",
              reconciliationId: reconciliation.reconciliationId,
            },
          },
        );
      } else {
        // DPA-7 and the ordinary delivery contracts classify a resolved
        // contradiction as a terminal phase failure, not a retryable outage.
        outcome = "fail";
        errorClass = "permanent";
        unsignedEvidence = {
          evidenceVersion: "1",
          jobId: agreement.jobId,
          phase,
          outcome: "failure",
          reason: validated.reason,
          observedAt,
        };
      }
    }
  } else {
    return indeterminate("delivery-reconciliation-pending", ["delivery state was not terminal"], {
      fulfilmentId: id,
      safeToRetryDelivery: false,
      recovery: { action: "reconcile-delivery" },
    });
  }

  if (retainedHandoff) {
    unsignedEvidence = {
      ...unsignedEvidence,
      dacsSdkAuditSourceHash: retainedHandoff.auditSourceHash,
    };
  }

  const published = await publishEvidence(
    unsignedEvidence,
    id,
    deps,
    evidenceSigner,
    requiredEvidenceSigner,
  );
  if (published.status === "pending") {
    return indeterminate("delivery-evidence-publication-pending", [published.reason], {
      fulfilmentId: id,
      safeToRetryDelivery: false,
      recovery: { action: "retry-evidence-publication" },
      evidenceDraft: published.evidenceDraft,
      ...(published.evidence ? { evidence: published.evidence } : {}),
      ...(published.evidenceHash ? { evidenceHash: published.evidenceHash } : {}),
    });
  }
  const bundleContribution: SellerBundleContribution = {
    phaseSummary: {
      index: request.deliveryPhaseIndex,
      kind: phase,
      outcome,
      ...(errorClass ? { errorClass } : {}),
      attestationRef: structuredClone(published.evidenceRef),
    },
    settlementEvidence: structuredClone(published.evidenceRef),
  };
  if (outcome === "fail") {
    return {
      decision: "failed",
      fulfilmentId: id,
      errorClass: errorClass!,
      evidence: structuredClone(published.evidence),
      evidenceHash: published.evidenceHash,
      evidenceRef: structuredClone(published.evidenceRef),
      evidenceAnchorReceipt: structuredClone(published.anchorReceipt),
      bundleContribution,
    };
  }
  return {
    decision: "completed",
    fulfilmentId: id,
    evidence: structuredClone(published.evidence),
    evidenceHash: published.evidenceHash,
    evidenceRef: structuredClone(published.evidenceRef),
    evidenceAnchorReceipt: structuredClone(published.anchorReceipt),
    bundleContribution,
  };
}

/**
 * Transport-independent seller fulfilment. Terminal outcomes always expose
 * the exact store-retained consumed authorization; indeterminate outcomes do
 * so only when consumption was proven. This is the sole payment binding that
 * a durable seller session may carry into recovery.
 */
export async function runFulfilmentCore(
  request: SellerFulfilmentRequest,
  deps: SellerFulfilmentDeps,
): Promise<SellerFulfilmentResult> {
  let requestSnapshot: SellerFulfilmentRequest;
  try {
    requestSnapshot = structuredClone(request);
  } catch {
    return {
      decision: "rejected",
      code: "invalid-request",
      reasons: ["fulfilment request is not an immutable cloneable value"],
    };
  }
  const requestViolation = fulfilmentRequestViolation(requestSnapshot);
  if (requestViolation) {
    return {
      decision: "rejected",
      code: requestViolation.code,
      reasons: [requestViolation.reason],
    };
  }
  const captured = captureSellerFulfilmentDeps(deps);
  if (captured.status === "invalid") {
    return {
      decision: "rejected",
      code: "fulfilment-dependencies-invalid",
      reasons: [captured.reason],
    };
  }
  const execution: SellerFulfilmentExecutionContext = {};
  const result = await runFulfilmentCoreInner(requestSnapshot, captured.deps, execution);
  const retained = execution.consumedPaymentAuthorization;
  if (result.decision === "rejected") {
    if (!retained) return result;
    return {
      decision: "indeterminate",
      code: "consumed-fulfilment-rejected",
      reasons: [`${result.code}: ${result.reasons.join("; ")}`],
      safeToRetryDelivery: false,
      recovery: { action: "reconcile-delivery" },
      consumedPaymentAuthorization: structuredClone(retained),
    };
  }
  if (!retained) {
    if (result.decision === "indeterminate") return result;
    return {
      decision: "indeterminate",
      code: "payment-permit-store-invalid",
      reasons: ["terminal fulfilment was reached without a proven consumed authorization"],
      fulfilmentId: result.fulfilmentId,
      safeToRetryDelivery: false,
      recovery: { action: "reconcile-delivery" },
    };
  }
  const consumedPaymentAuthorization = structuredClone(retained);
  return { ...result, consumedPaymentAuthorization };
}

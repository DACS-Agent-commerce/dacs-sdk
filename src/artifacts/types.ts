/**
 * DACS spine artifacts for the MVP fixed-price + x402 path (T3).
 * Field shapes track the reproducibly pinned DACS-Standard `next` §14 oracle
 * selected by scripts/sync-vectors.mjs. DACS-Standard#308 was resolved by
 * Standard PR #310: the oracle and normative prose now agree on DACS-2 §7.5.2
 * AttestationRef and DACS-4 §9.3 ChainTxRef.
 *
 * Each artifact is signed under its domain separator (see ./registry) over the
 * content hash of its signed scope (the object with the signature field omitted).
 */

/** DACS-1 §6.3.1 ClaimReference in its canonical wire form. */
export type ClaimRef = string;

/** DACS-1 §6.3.3 requirement for one claim scheme. */
export interface ClaimRequirement {
  scheme: string;
  verificationRequired: boolean;
  maxAge?: number;
  recipeVersion?: number;
  parameters?: Record<string, unknown>;
}

/** DACS-2 §7.7 VerifyResultRef used by DACS-1 §6.3.2 BundleClaim. */
export interface VerifyResultRef {
  anchor: {
    kind: "storage-program" | "ipfs" | "https";
    locator: string;
  };
  contentHash: string;
  recipeVersion: number;
}

/** DACS-1 §6.3.2 claim carried by an IdentityBundle. */
export interface BundleClaim {
  ref: ClaimRef;
  verifiedBy?: VerifyResultRef;
  issuedAt?: number;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
}

/** DACS-1 §6.3.2 presentation variants. */
export type PresentationSignature =
  | { kind: "siwd"; message: string; signature: string; address: string }
  | {
      kind: "per-claim";
      signatures: Array<{ ref: ClaimRef; signature: string }>;
    }
  | {
      kind: "session-key";
      key: string;
      signature: string;
      rootBinding?: string;
    }
  | {
      kind: "sr1-root";
      rootClaim: ClaimRef;
      aggregateSignature: string;
    };

/** DACS-1 §6.3.2 normative IdentityBundle artifact. */
export interface IdentityBundle {
  bundleVersion: "1";
  presentedBy: ClaimRef;
  presentedAt: number;
  sessionNonce?: string;
  claims: BundleClaim[];
  presentation: PresentationSignature;
}

/** DACS-1 §6.3.3 normative buyer requirement. */
export interface BundleRequirement {
  requirementVersion: "1";
  required: ClaimRequirement[];
  oneOf?: ClaimRequirement[][];
  preferredPresentation?:
    | "siwd"
    | "sr1-root"
    | "per-claim"
    | "session-key"
    | "any";
  primaryClaimSelector?: string;
}

export interface Price {
  /** Integer base-unit amount as a string (CD-1). */
  amount: string;
  asset: string;
  decimals: number;
  /**
   * Payment rail identifier. Normative Listings use a `PaymentRailRef.railId`
   * value here (for example, `"x402:default"`), not a `pay-*` phase kind.
   */
  rail: string;
}

export interface Delivery {
  phase: string;
  format: string;
}

/**
 * DACS-4 PriceTerm — a canonical priced amount. `amount` is a CD-1 canonical
 * decimal string (minimal-digit, no exponent) and MUST be positive; `currency`
 * is an ISO 4217 code or asset id (e.g. "USDC", "SOL", "usd-stablecoin").
 */
export interface PriceTerm {
  amount: string;
  currency: string;
  unit?: string;
}

/**
 * DACS-4 PricingSpec — how a listing prices its service (referenced by DACS-1
 * `Listing.pricing`). One of: a `fixed` price; a `negotiable` band around a
 * centre (min/maxPct half-up per §8.5.2); or an `auction` with a selection rule.
 * The `auction.selectionRule` set is the SAME enum as the §8.4.3 phase-step
 * parameter, incl. the templated `rule-ref:<contentHash>:<uri>` form.
 */
export type PricingSpec =
  | { kind: "fixed"; price: PriceTerm }
  | { kind: "negotiable"; bandCenter: PriceTerm; minPct: number; maxPct: number }
  | {
      kind: "auction";
      reservePrice?: PriceTerm;
      selectionRule:
        | "lowest-price"
        | "highest-price"
        | "first-acceptable"
        | `rule-ref:${string}`;
    }
  | {
      kind: "metered";
      unitPrice: PriceTerm;
      unit: string;
      minTotal?: PriceTerm;
    };

/** DACS-2 §7.4.1 VerificationMethod variants referenced by DACS-4 §9.3. */
export type VerificationMethod =
  | {
      kind: "verifiable-credential";
      issuerAllowList?: ClaimRef[];
      schemaUrl?: string;
    }
  | { kind: "tlsnotary"; endpoint: string; sessionTemplate?: string }
  | { kind: "zktls"; provider: string; programId: string }
  | {
      kind: "consensus-backed-proxy";
      endpoint: {
        method: "GET" | "POST";
        urlTemplate: string;
        headers?: Record<string, string>;
        body?: string;
      };
    }
  | {
      kind: "oauth-attested";
      provider: string;
      scopes: string[];
      maxTokenAgeSec: number;
    }
  | {
      kind: "evm-rpc";
      chainId: number;
      contract: string;
      method: string;
      args?: unknown[];
    }
  | {
      kind: "domain-tls-control";
      challengeType: "http-01" | "dns-01" | "tls-alpn-01";
    }
  | { kind: "self-signed" }
  | { kind: "demos-gcr-domain" };

/** DACS-4 §9.3 DeliverableSpec closed discriminated union. */
export type DeliverableSpec =
  | {
      kind: "storage-program";
      schemaUrl?: string;
      expectedSizeBytes?: number;
      accessModel?: "public" | "buyer-only" | "encrypt-to-buyer";
    }
  | { kind: "entitlement"; durationSec: number; renewable: boolean }
  | {
      kind: "attested-payload";
      payloadFormat: string;
      verificationMethod?: VerificationMethod;
      expectedSizeBytes?: number;
    }
  | {
      kind: "external";
      description: string;
      verificationMethod?: VerificationMethod;
    };

/** DACS-4 §9.3 content-addressed reference to the pinned Listing deliverable. */
export interface DeliverableRef {
  deliverableType: DeliverableSpec["kind"];
  hash: string;
  schemaUrl?: string;
}

/** DACS-4 §9.3 reference to one accepted payment rail. */
export interface PaymentRailRef {
  railId: string;
  railVersion?: number;
  parameters?: Record<string, unknown>;
}

/** DACS-4 §9.9.1 listing-only projection instruction (APR-1). */
export interface AlternativePaymentPhase {
  kind: "pay-alternative";
  parameters: {
    alternatives: PaymentRailRef[];
  };
}

/** DACS-1 §6.3.4 substrate capabilities a Listing can require. */
export type SubstrateRequirement = "SR-1" | "SR-2" | "SR-3" | "SR-4" | "SR-5";

/** DACS-1 §6.3.4 PhaseStep; parameter validation is kind-owned. */
export interface PhaseStep {
  kind: PhaseType;
  parameters?: Record<string, unknown>;
}

/** DACS-1 §6.3.4 Listing terms. */
export interface ListingTerms {
  termsOfServiceUrl?: string;
  termsOfServiceHash?: string;
  jurisdictions?: string[];
  conflictOfLawsRule?:
    | "buyer-jurisdiction"
    | "seller-jurisdiction"
    | `rule-ref:${string}`;
  deadlineSecAfterCommit?: number;
  acceptanceModel?: "auto-accept";
  cancellationPolicy?: "none" | "pre-commit" | "with-fee";
  retentionYears?: number;
  transcriptDisclosurePolicy?:
    | "none"
    | "encrypted-anchored-recommended"
    | "encrypted-anchored-required";
}

/**
 * DACS-1 §6.3.4 normative signed Listing. Unknown additive fields are preserved
 * by the canonical signed scope (CORE §B.7 SIG-5); action discriminators remain
 * closed and unsupported variants fail validation.
 */
export interface Listing {
  dacsVersion: "1";
  listingVersion: number;
  listingId: string;
  requiredCapabilities?: SubstrateRequirement[];
  seller: {
    identity: IdentityBundle;
    displayName: string;
    publicEndpoint?: string;
  };
  offering: {
    title: string;
    description: string;
    category: string;
    tags: string[];
    deliverable: DeliverableSpec;
    extendedDescriptionUrl?: string;
    extendedDescriptionHash?: string;
  };
  buyerRequirement: BundleRequirement;
  pipeline: PhaseStep[];
  pricing: PricingSpec;
  acceptedRails?: PaymentRailRef[];
  terms: ListingTerms;
  validity: { notBefore: number; notAfter?: number };
  signature: ListingSignature;
}

/** DACS-1 §6.3.4 reader-step envelope before the major-version gate. */
export type ListingEnvelope = Omit<Listing, "dacsVersion"> & {
  dacsVersion: string;
};

/** DACS-1 §6.3.4 ListingSignature (CORE §B.7 SIG-6 value encoding). */
export type ListingSignature = ComponentSignature;

/** DACS-1 §6.3.4 RB-1 seller-signed withdrawal of one Listing version. */
export interface RevocationMarker {
  listingId: string;
  listingVersion: number;
  listingContentHash: string;
  revokedAt: number;
  reason?: string;
  signature: ComponentSignature;
}

/**
 * DACS-1 §6.3.4 RB-2 discovery-only pointer to an anchored
 * {@link RevocationMarker}. The binding is never itself authority.
 */
export interface RevocationBinding {
  sellerPrimaryClaim: ClaimRef;
  listingId: string;
  listingVersion: number;
  listingContentHash: string;
  logicalAddress: string;
  markerAnchor: { kind: string; locator: string };
  markerContentHash: string;
}

/** Unsigned DACS-1 §6.3.4 input accepted by Listing publication. */
export type ListingDraft = Omit<Listing, "signature">;

/** Historical SDK MVP artifact. Read-only compatibility; never a new write. */
export interface LegacyMvpListing {
  agentId: string;
  serviceId: string;
  name: string;
  description: string;
  claimRequirements: Array<{ claimRef: ClaimRef; required: boolean }>;
  supportedNegotiation: string[];
  supportedPaymentRails: string[];
  supportedDelivery: string[];
  pricing?: Exclude<PricingSpec, { kind: "metered" }>;
  listingVersion?: number;
}

/**
 * Explicit read boundary for normative and historical Listing artifacts.
 * A normative branch is only a structurally readable reader-step envelope;
 * consumers MUST obtain a `verified` ordered validation result before use.
 */
export type ReadableListing =
  | { compatibility: "normative"; listing: ListingEnvelope }
  | { compatibility: "legacy-mvp"; listing: LegacyMvpListing };

/** DACS-1 §6.3.4 / LR-1 exact Listing tuple pinned by a session. */
export interface ListingPin {
  listingId: string;
  version: number;
  contentHash: string;
}

/**
 * DACS-2 §7.7/§7.5.1 verification verdict. `indeterminate` (couldn't conclude)
 * and `error` (the check itself failed) are distinct from `fail` and are
 * security-load-bearing: indeterminate is NOT pass.
 */
export type VerificationDecision = "pass" | "fail" | "indeterminate" | "error";

/** DACS-2 §7.3 closed verification-method registry for current artifacts. */
export type VerificationMethodKind =
  | "verifiable-credential"
  | "tlsnotary"
  | "zktls"
  | "consensus-backed-proxy"
  | "oauth-attested"
  | "evm-rpc"
  | "domain-tls-control"
  | "self-signed"
  | "demos-gcr-domain";

/** DACS-2 §7.5 signature over the current VerifyResult signed scope. */
export type VerifyResultSignature = ComponentSignature;

/** DACS-2 §7.5 current, signed per-method authority result. */
export interface VerifyResult {
  resultVersion: "1";
  scheme: string;
  identifier: string;
  recipeVersion: number;
  method: VerificationMethodKind;
  decision: VerificationDecision;
  reason: string;
  attestation: AttestationRef;
  data?: Record<string, unknown>;
  fetchedAt: number;
  verifiedAt: number;
  validUntil?: number;
  signature: VerifyResultSignature;
}

/** DACS-2 §7.7 advisory signal. It never participates in aggregation. */
export interface SupplementarySignal {
  source:
    | "dacs-5"
    | "cci-nomis"
    | "cci-ethos"
    | "cci-humanpassport"
    | "external"
    | string;
  signalType: string;
  value: number | string;
  observedAt: number;
  /** Required when source is `external`. */
  attestation?: AttestationRef;
}

/** DACS-2 §7.7 v0.1 warning registry; WN-6 permits additional advisory codes. */
export type VerificationWarningCode =
  | "AUTHORITY_UNAVAILABLE"
  | "AUTHORITY_RATE_LIMITED"
  | "DNS_RESOLUTION_FAILED"
  | "TLS_HANDSHAKE_FAILED"
  | "RESPONSE_MALFORMED"
  | "RETRY_EXHAUSTED"
  | (string & {});

/** DACS-2 §7.7 advisory warning. It never participates in aggregation. */
export interface VerificationWarning {
  claimRef: ClaimRef;
  code: VerificationWarningCode;
  retryable: boolean;
  suggestedRetryAfterMs?: number;
}

/** DACS-2 §7.7 current composite verification record. */
export interface CompositeVerificationRecord {
  recordVersion: "1";
  jobId: string;
  evaluatedParty: ClaimRef;
  bundleHash: string;
  requirementHash: string;
  freshness: VerifyResultRef[];
  supplementary: SupplementarySignal[];
  dealSpecific: VerifyResultRef[];
  overallDecision: VerificationDecision;
  warnings?: VerificationWarning[];
  generatedAt: number;
  signature: ComponentSignature;
}

/**
 * Obsolete pre-§7.7 SDK result entry. This exists only behind the explicit
 * legacy read boundary; current producers and strict verifiers never emit or
 * accept it as a current VerifyResult.
 */
export interface LegacyVerifyResultEntry {
  claimRef: ClaimRef;
  method: string;
  status: VerificationDecision;
  authority?: string;
  responseHash?: string;
  proof?: { kind: "hash" | "raw"; value: string };
  data?: Record<string, unknown>;
}

/** Obsolete pre-DACS-2 §7.7 SDK record, retained for explicit historical reads. */
export interface LegacyCompositeVerificationRecord {
  subject: string;
  recipeId: string;
  recipeVersion: string;
  results: LegacyVerifyResultEntry[];
  decision: VerificationDecision;
  verifiedAt: string;
  signature?: ComponentSignature;
}

/** Explicit current-versus-legacy read result. */
export type ReadableCompositeVerificationRecord =
  | { compatibility: "current"; record: CompositeVerificationRecord }
  | { compatibility: "legacy"; record: LegacyCompositeVerificationRecord };

/** DACS-3 §8.5 party bound into an AgreementArtifact. */
export interface AgreementParty {
  role: "buyer" | "seller" | "bidder-non-winning";
  bundleHash: string;
  primaryClaim: ClaimRef;
  vetRecordRef: AttestationRef;
  encryptionKey?: string;
}

/** DACS-3 §8.5.1 signature over the selected agreement-domain payload. */
export interface AgreementSignature {
  party: ClaimRef;
  algorithm: ComponentSignatureAlgorithm;
  value: string;
}

/** DACS-3 §8.5 payout binding used only by PayeeBoundAgreementDocument. */
export interface PayoutBinding {
  railId: string;
  phaseIndex: number;
  payeeAddress: string;
}

export interface PriceAnchor {
  asset: string;
  quoteCurrency: string;
  price: string;
  attestationRef: AttestationRef;
  observedAt: number;
  sourceUrl: string;
}

export type FeeRecurrencePeriod =
  | "daily"
  | "weekly"
  | "monthly"
  | "quarterly"
  | "annual"
  | { everySeconds: number };

interface FeeItemBase {
  kind: "network" | "platform" | "processing" | "spread" | "subscription" | "other";
  collector: ClaimRef | "substrate";
  label?: string;
  toleranceBps?: number;
  recurrence?: {
    period: FeeRecurrencePeriod;
    count?: number;
    until?: number;
  };
}

export type FeeItem = FeeItemBase &
  (
    | { fixed: PriceTerm; rateBps?: never }
    | { fixed?: never; rateBps: number }
  );

export interface FeeSchedule {
  priceBasis: "inclusive" | "exclusive";
  items: FeeItem[];
  oneOffTotal: PriceTerm;
  recurringTotal?: PriceTerm;
  minimumTermSeconds?: number;
  earlyTerminationFee?: FeeItem;
  disclosureNote?: string;
}

export interface AgreementTerms {
  deliverable: DeliverableRef;
  price: PriceTerm;
  meteredQuantity?: { quantity: string; unit: string };
  rail?: PaymentRailRef;
  deadline: number;
  priceAnchor?: PriceAnchor;
  feeSchedule?: FeeSchedule;
  additionalTerms?: Record<string, unknown>;
}

export interface PayeeBoundAgreementTerms extends AgreementTerms {
  payoutBindings: PayoutBinding[];
  /** Signed APR-6 authority for an explicitly claimed fresh-job replacement. */
  priorPaymentDispositionRef?: AttestationRef;
}

/** Exact legacy agreement artifact selected by `commit-agreement` (DACS-3 §8.5). */
export interface AgreementDocument {
  agreementVersion: "1";
  jobId: string;
  listingRef: ListingPin;
  parties: AgreementParty[];
  terms: AgreementTerms;
  derivedFromPattern: "fixed-price" | "rfq" | "sealed-envelope";
  derivedFromChannel?: { subnet: string; lastMessageHash: string };
  generatedAt: number;
  signatures: AgreementSignature[];
}

/** Minor-safe payee-bound agreement selected by `commit-payee-bound-agreement`. */
export interface PayeeBoundAgreementDocument {
  payeeBoundAgreementVersion: "1";
  jobId: string;
  listingRef: ListingPin;
  parties: AgreementParty[];
  terms: PayeeBoundAgreementTerms;
  derivedFromPattern: "fixed-price" | "rfq" | "sealed-envelope";
  derivedFromChannel?: { subnet: string; lastMessageHash: string };
  generatedAt: number;
  signatures: AgreementSignature[];
}

export type AgreementArtifact = AgreementDocument | PayeeBoundAgreementDocument;

/** DACS-2 §7.5.2 — the closed set of normative attestation anchor kinds. */
export type AttestationAnchorKind = "storage-program" | "ipfs" | "https";

/** DACS-2 §7.5.2 — where a referenced attestation is fetched. */
export interface AttestationAnchor {
  kind: AttestationAnchorKind;
  locator: string;
}

/** DACS-2 §7.5.2 — one content-addressed reference to an anchored artifact. */
export interface AttestationRef {
  anchor: AttestationAnchor;
  contentHash: string;
  /** VC issuer or consensus-backed proxy validator-set ClaimReference. */
  signer?: ClaimRef;
}

/** DACS-1 listing reference — carries the listing id, version, and content hash. */
export interface ListingRef {
  listingId: string;
  version: number;
  contentHash: string;
}

/**
 * DACS-4 §9.3 — the complete v0.x discriminated transaction-reference union.
 * Variant-specific fields are deliberately not flattened: the discriminator is
 * what lets verifiers derive the rail's canonical transaction identity (SB-1).
 */
export type ChainTxRef =
  | { kind: "evm"; chainId: number; txHash: string }
  | {
      kind: "evm-event";
      chainId: number;
      txHash: string;
      logIndex: number;
    }
  | {
      kind: "solana";
      cluster: "mainnet" | "devnet" | "testnet";
      signature: string;
    }
  | {
      kind: "solana-instruction";
      cluster: "mainnet" | "devnet" | "testnet";
      signature: string;
      instructionIndex: number;
    }
  | { kind: "demos"; txHash: string; blockNumber?: number }
  | { kind: "storage-program"; address: string; writeTxHash: string }
  | {
      kind: "ap2";
      mandateId: string;
      providerRef: string;
      protocolVersion: string;
      receiptAttestation?: AttestationRef;
    }
  | {
      kind: "x402";
      httpResource: string;
      paymentReceiptHash: string;
      settlementTxHash?: string;
      chainId?: number;
      protocolVersion: string;
    }
  | {
      kind: "x402-event";
      httpResource: string;
      paymentReceiptHash: string;
      settlementTxHash: string;
      chainId: number;
      logIndex: number;
      protocolVersion: string;
    }
  | {
      kind: "htlc-lock";
      chainId: number;
      contractAddress: string;
      lockTxHash: string;
    }
  | {
      kind: "htlc-reveal";
      chainId: number;
      contractAddress: string;
      revealTxHash: string;
    }
  | {
      kind: "htlc-claim";
      chainId: number;
      contractAddress: string;
      claimTxHash: string;
    }
  | {
      kind: "htlc-refund";
      chainId: number;
      contractAddress: string;
      refundTxHash: string;
    }
  | {
      kind: "liquidity-tank";
      bridgeId: string;
      sourceChainId: number;
      destChainId: number;
      lockTxHash: string;
      releaseTxHash?: string;
      recoveryDeadline?: number;
    };

/** DACS-4 §9.3 names TxRef as an alias of ChainTxRef. */
export type TxRef = ChainTxRef;

/** DACS-4 §9.7 paymentAmount is the shared PriceTerm shape. */
export type PaymentAmount = PriceTerm;

/** §9.7 settlement outcome. */
export type SettlementOutcome = "success" | "failure";

/** §9.7 settlement finality models (PC-6 — the actual model applied). */
export type SettlementFinalityModel =
  | "block-depth"
  | "commitment-level"
  | "provider-receipt"
  | "htlc-reveal"
  | "liquidity-tank"
  | "bft-final";

/** Commitment levels permitted by the DACS-4 §9.7 commitment-level model. */
export type SettlementCommitmentLevel =
  | "processed"
  | "confirmed"
  | "finalized";

/**
 * Optional model-specific DACS-4 §9.7 echoes reported by a settlement rail.
 * Parameters belong only to their discriminated model; omission remains valid.
 */
export type SettlementFinalityParameters =
  | {
      model: "block-depth";
      finalityBlocks?: number;
      finalityCommitmentLevel?: never;
    }
  | {
      model: "commitment-level";
      finalityBlocks?: never;
      finalityCommitmentLevel?: SettlementCommitmentLevel;
    }
  | {
      model: Exclude<SettlementFinalityModel, "block-depth" | "commitment-level">;
      finalityBlocks?: never;
      finalityCommitmentLevel?: never;
    };

/** Settlement finality model and observation time for a payment. */
export type SettlementFinality = SettlementFinalityParameters & {
  finalityObservedAt: number;
};

/** Algorithms permitted by the DACS v0.x ComponentSignature envelope. */
export type ComponentSignatureAlgorithm =
  | "ed25519"
  | "ecdsa-secp256k1"
  | "sr1-aggregate";

/**
 * Detached signature on a standalone artifact (CORE §B.7 / DACS-4 §9.7).
 * The artifact-specific section determines which role `signer` must hold.
 */
export interface ComponentSignature {
  algorithm: ComponentSignatureAlgorithm;
  /**
   * Primary ClaimReference of the artifact-specific signing role. ClaimReference
   * is currently an SDK-wide string alias; validate its grammar here once the
   * shared ClaimReference parser lands.
   */
  signer: string;
  value: string;
}

/** DACS-4 §9.9.1 signed cross-job payment-closure carrier (APR-6). */
export interface PriorPaymentDisposition {
  priorPaymentDispositionVersion: "1";
  dispositionId: string;
  priorJobId: string;
  replacementJobId: string;
  priorAgreementRef: AttestationRef;
  priorSelection: PaymentRailRef;
  priorPhaseIndex: number;
  disposition:
    | "closed-before-authorization"
    | "authorization-pending"
    | "settlement-indeterminate"
    | "closed-cannot-settle";
  reconciliationEvidenceRefs?: AttestationRef[];
  observedAt: number;
  signature: ComponentSignature;
}

/** Historical DACS-3 v0.1-v0.3 commitment. New producers MUST NOT emit it. */
export interface CommitmentRecord {
  dacsVersion: "1";
  jobId: string;
  agreementHash: string;
  listingRef: ListingPin;
  parties: ClaimRef[];
  pattern: "fixed-price" | "rfq" | "sealed-envelope";
  committedAt: number;
}

/** DACS-3 §8.6 v0.4 commitment; authoritative time comes from its receipt. */
export interface FinalityCommitmentRecord {
  finalityCommitmentVersion: "1";
  jobId: string;
  agreementHash: string;
  listingRef: ListingPin;
  parties: ClaimRef[];
  pattern: "fixed-price" | "rfq" | "sealed-envelope";
  createdAt: number;
  signature: ComponentSignature;
}

export type AgreementCommitmentRecord =
  | CommitmentRecord
  | FinalityCommitmentRecord;

export interface AnchorTransactionRef {
  kind: string;
  value: string;
}

export interface AnchorReceiptEvidence {
  kind: string;
  value: string;
}

export type AnchorLifecycleState =
  | "submitted"
  | "accepted"
  | "included"
  | "finalized"
  | "rejected"
  | "dropped"
  | "replaced"
  | "expired"
  | "reorged";

/** Portable CORE §5.1 immutable SR-2 lifecycle snapshot. */
export interface AnchorReceipt {
  receiptVersion: "1";
  substrate: string;
  finalityProfile: string;
  logicalAddress: string;
  nativeAddress: string;
  contentHash: string;
  transactionRef: AnchorTransactionRef;
  writer: string;
  nonce?: string;
  state: AnchorLifecycleState;
  observationDisposition: "established" | "indeterminate";
  preservedReceiptHash?: string;
  observedAt: number;
  blockRef?: {
    id: string;
    height?: string;
    timestamp?: number;
  };
  replacementTransactionRef?: AnchorTransactionRef;
  evidence: AnchorReceiptEvidence;
}

/**
 * @deprecated Use {@link ComponentSignature}. Its broad `algorithm` field is
 * retained so existing consumers are not broken by introducing the foundation.
 */
export interface ArtifactSignature {
  algorithm: string;
  signer: string;
  value: string;
}

/** DACS-4 §9.7 payment phase discriminator. */
export type PaymentPhaseType =
  | "pay-evm-erc20"
  | "pay-solana-spl"
  | "pay-cross-chain-htlc"
  | "pay-cross-chain-liquidity-tank"
  | "pay-ap2"
  | "pay-x402"
  | "pay-dem";

/** DACS-4 §9.7 delivery phase discriminator. */
export type DeliveryPhaseType =
  | "deliver-storage-program"
  | "deliver-entitlement"
  | "deliver-attested-payload";

/** DACS-1 §6.3 PhaseType — the closed v0.x pipeline set. */
export type PhaseType =
  | "vet-credentials"
  | "negotiate-fixed-price"
  | "negotiate-rfq"
  | "negotiate-sealed-envelope"
  | "negotiate-sealed-envelope-procurement"
  | "commit-agreement"
  | "commit-payee-bound-agreement"
  | AlternativePaymentPhase["kind"]
  | PaymentPhaseType
  | DeliveryPhaseType
  | "rate";

/** Fields shared by every signed DACS-4 §9.7 SettlementEvidence variant. */
interface SettlementEvidenceBase {
  evidenceVersion: "1";
  jobId: string;
  observedAt: number;
  amendmentRefs?: AttestationRef[];
  supersedesEvidenceRef?: AttestationRef;
  /** Omitted from the signed scope when hashing (CORE §B.2). */
  signature: ComponentSignature;
}

/** DACS-4 §9.7 — exact payment and delivery evidence variants. */
export type SettlementEvidence =
  | (SettlementEvidenceBase & {
      phase: PaymentPhaseType;
      outcome: "success";
      reason?: never;
      paymentTxRefs: ChainTxRef[];
      paymentAmount: PaymentAmount;
      paymentFee?: PaymentAmount;
      settlementFinality: SettlementFinality;
      deliverableContentHash?: never;
      deliverableAnchor?: never;
      attestationRef?: never;
    })
  | (SettlementEvidenceBase & {
      phase: PaymentPhaseType;
      outcome: "failure";
      reason: string;
      paymentTxRefs?: ChainTxRef[];
      paymentAmount?: PaymentAmount;
      paymentFee?: PaymentAmount;
      settlementFinality?: never;
      deliverableContentHash?: never;
      deliverableAnchor?: never;
      attestationRef?: never;
    })
  | (SettlementEvidenceBase & {
      phase: Exclude<DeliveryPhaseType, "deliver-attested-payload">;
      outcome: "success";
      reason?: never;
      paymentTxRefs?: ChainTxRef[];
      paymentAmount?: PaymentAmount;
      paymentFee?: PaymentAmount;
      settlementFinality?: never;
      deliverableContentHash: string;
      deliverableAnchor: { kind: string; locator: string };
      attestationRef?: AttestationRef;
    })
  | (SettlementEvidenceBase & {
      phase: "deliver-attested-payload";
      outcome: "success";
      reason?: never;
      paymentTxRefs?: ChainTxRef[];
      paymentAmount?: PaymentAmount;
      paymentFee?: PaymentAmount;
      settlementFinality?: never;
      deliverableContentHash: string;
      deliverableAnchor: { kind: string; locator: string };
      attestationRef: AttestationRef;
    })
  | (SettlementEvidenceBase & {
      phase: DeliveryPhaseType;
      outcome: "failure";
      reason: string;
      paymentTxRefs?: ChainTxRef[];
      paymentAmount?: PaymentAmount;
      paymentFee?: PaymentAmount;
      settlementFinality?: never;
      deliverableContentHash?: string;
      deliverableAnchor?: { kind: string; locator: string };
      attestationRef?: AttestationRef;
    });

/** DACS-5 §10.6 — one signed, standalone rating direction. */
export interface RatingRecord {
  ratingVersion: "1";
  jobId: string;
  rater: ClaimRef;
  target: ClaimRef;
  targetRole: "buyer" | "seller";
  value: number;
  freeText?: string;
  dimensions?: Record<string, number>;
  ratedAt: number;
  signature: ComponentSignature;
}

/** A party to an attestation bundle, with the content hash of its IdentityBundle. */
export interface BundleParty {
  role: string;
  bundleHash: string;
  primaryClaim: ClaimRef;
}

export type BundlePhaseOutcome = "ok" | "fail";
export type BundlePhaseErrorClass =
  | "permanent"
  | "transient"
  | "counterparty"
  | "substrate"
  | "settlement-atomicity";

/** A phase entry in the bundle's phaseSummary. */
export interface PhaseSummaryEntry {
  index: number;
  kind: PhaseType;
  outcome: BundlePhaseOutcome;
  errorClass?: BundlePhaseErrorClass;
  txRefs?: TxRef[];
  /**
   * OPTIONAL per DACS-5 §10.4.3 / DACS-Standard#204: the authoritative
   * attestation set is the top-level `vetRecords[]` / `settlementEvidence[]`, so
   * a phaseSummary entry MAY omit its attestationRef. Producers SHOULD still emit
   * it for attestation-bearing phases (runSessionCore does).
   */
  attestationRef?: AttestationRef;
}

/**
 * DACS-5 §10.4.1 legacy-read phase entry. Historical AttestationBundle
 * producers used pre-registry phase labels; consumers retain those strings for
 * replay, while every FaultAttestationBundle write uses closed `PhaseType`.
 */
export interface LegacyBundlePhaseEntry
  extends Omit<PhaseSummaryEntry, "kind"> {
  kind: string;
}

export interface CancellationMarker {
  claimedPolicy: string;
}

/** A per-party bundle signature: `{ party, algorithm, value }`. */
export interface BundleSignature {
  party: string;
  algorithm: ComponentSignatureAlgorithm;
  value: string;
}

export type BundlePartyRole = "buyer" | "seller" | "orchestrator";
export type FaultedParty = BundlePartyRole | "none";

/** Fields shared by the legacy and v0.3 DACS-5 bundle types. */
interface BundleFields {
  jobId: string;
  outcome:
    | "completed"
    | "failed-perm"
    | "failed-counterparty"
    | "failed-substrate"
    | "aborted-by-self"
    | "aborted-by-other";
  /** Per-copy field; REQUIRED and omitted from the signed scope (§10.4.1). */
  anchoredByRole: BundlePartyRole;
  listingRef: ListingRef;
  agreementRef?: AttestationRef;
  cancellation?: CancellationMarker;
  parties: BundleParty[];
  phaseSummary: PhaseSummaryEntry[];
  vetRecords: AttestationRef[];
  settlementEvidence: AttestationRef[];
  amendments?: AttestationRef[];
  ratingRefs?: AttestationRef[];
  recipeRegistryVersion: number;
  railRegistryVersion: number;
  finalisedAt: number;
  /** Omitted from the signed scope (§10.4.1). */
  signatures: BundleSignature[];
}

/** DACS-5 legacy session audit unit; retained for read compatibility only. */
export type AttestationBundle = Omit<BundleFields, "phaseSummary"> & {
  /** Pinned literal per DACS-5 §10.4.1 (legacy two-party bundle line). */
  bundleVersion: "1";
  faultBundleVersion?: never;
  faultedParty?: never;
  phaseSummary: LegacyBundlePhaseEntry[];
};

/** DACS-5 v0.3 production type with absolute, hashed fault attribution. */
export interface FaultAttestationBundle extends BundleFields {
  faultBundleVersion: "1";
  faultedParty: FaultedParty;
  bundleVersion?: never;
}

export type AnyAttestationBundle = AttestationBundle | FaultAttestationBundle;

/** DACS-5 §10.4.2 — signed logical-to-native mapping for one anchored bundle copy. */
export interface BundleBinding {
  bindingVersion: "1";
  jobId: string;
  role: BundlePartyRole;
  logicalAddress: string;
  nativeAddress: string;
  bundleContentHash: string;
  anchorTx?: string;
  signer: ClaimRef;
  signature: ComponentSignature;
}

/** Discriminator for the spine artifact kinds (matches the vector `kind`). */
export type ArtifactKind =
  | "Listing"
  | "CompositeVerificationRecord"
  | "AgreementDocument"
  | "PayeeBoundAgreementDocument"
  | "SettlementEvidence"
  | "AttestationBundle"
  | "FaultAttestationBundle";

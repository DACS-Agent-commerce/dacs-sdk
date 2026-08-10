/**
 * DACS spine artifacts for the MVP fixed-price + x402 path (T3).
 * Field shapes track the reproducibly pinned DACS-Standard §14 oracle selected
 * by scripts/sync-vectors.mjs.
 *
 * The current oracle still identifies itself as dacsVersion 0.1 and retains
 * the legacy AttestationRef / ChainTxRef shapes even though the v0.3 prose has
 * moved on. That upstream oracle/prose divergence is tracked in
 * DACS-Standard#308; these types must not claim v0.3 fidelity until the oracle
 * and normative prose agree.
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
  /** Payment rail id, e.g. "pay-evm-erc20" / "pay-x402". */
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

/** DACS-4 §9.3 reference to one accepted payment rail. */
export interface PaymentRailRef {
  railId: string;
  railVersion?: number;
  parameters?: Record<string, unknown>;
}

/** DACS-1 §6.3.4 substrate capabilities a Listing can require. */
export type SubstrateRequirement = "SR-1" | "SR-2" | "SR-3" | "SR-4" | "SR-5";

/** DACS-1 §6.3.4 closed phase-kind set at this Standard revision. */
export type PhaseType =
  | "vet-credentials"
  | "negotiate-fixed-price"
  | "negotiate-rfq"
  | "negotiate-sealed-envelope"
  | "negotiate-sealed-envelope-procurement"
  | "commit-agreement"
  | "commit-payee-bound-agreement"
  | "pay-evm-erc20"
  | "pay-solana-spl"
  | "pay-cross-chain-htlc"
  | "pay-cross-chain-liquidity-tank"
  | "pay-ap2"
  | "pay-x402"
  | "pay-dem"
  | "deliver-storage-program"
  | "deliver-entitlement"
  | "deliver-attested-payload"
  | "rate";

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

/** DACS-1 §6.3.4 ListingSignature (CORE §B.7 SIG-6 value encoding). */
export type ListingSignature = ComponentSignature;

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

/** Explicit read boundary for normative and historical Listing artifacts. */
export type ReadableListing =
  | { compatibility: "normative"; listing: Listing }
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

/**
 * An honestly-typed claim proof reference. `kind` says whether `value` is a
 * digest (`hash`) or a raw reference such as a `/.well-known` URL or signature
 * (`raw`), so a consumer never has to guess whether the field is a hash. Used
 * for evidence that is NOT a DAHR attestation (see {@link VerifyResultEntry}).
 */
export interface ClaimProofRef {
  kind: "hash" | "raw";
  value: string;
}

/** DACS-2 — one method result inside a composite verification record. */
export interface VerifyResultEntry {
  claimRef: ClaimRef;
  method: string;
  status: VerificationDecision;
  authority?: string;
  /**
   * DAHR attestation of the proxied response body (the consensus-backed evidence
   * this result rests on) — STRICTLY a hash. Populated only by methods that run a
   * DAHR proxy fetch (consensus-backed-proxy, ofac-screen). A method with no proxy
   * fetch (e.g. cci-claim) MUST NOT populate it — its evidence goes in `proof`.
   */
  responseHash?: string;
  /**
   * The claim's attested proof, when the method rests on one that is NOT a DAHR
   * attestation (e.g. a cci-claim's stored `/.well-known` URL, proof hash, or
   * signature). Honestly typed as {@link ClaimProofRef} so consumers know whether
   * the value is a digest or a raw reference — the #31 fix for the raw-proof-in-a-
   * hash-named-field bug.
   */
  proof?: ClaimProofRef;
  /**
   * PSP-3 parsed data map: the fields a §7.4.1 ParserSpec `dataMap` extracted from
   * the attested body (audit-only — it never changes the decision). Recorded so the
   * verification is reproducible from the signed recipe + attested body.
   */
  data?: Record<string, unknown>;
}

/** DACS-2 — aggregated verification outcome for a subject. */
export interface CompositeVerificationRecord {
  subject: string;
  recipeId: string;
  recipeVersion: string;
  results: VerifyResultEntry[];
  /** Composite decision (DACS-2 §7.7); the session proceeds only on `pass`. */
  decision: VerificationDecision;
  verifiedAt: string;
}

/** DACS-3 — the agreed terms of a transaction. */
export interface AgreementDocument {
  jobId: string;
  pattern: string;
  buyer: string;
  seller: string;
  listingRef: string;
  price: Price;
  delivery: Delivery;
  expiresAt: string;
}

/** A content-addressed reference to another artifact (kind + id + content hash). */
export interface AttestationRef {
  kind: string;
  id: string;
  contentHash: string;
}

/** DACS-1 listing reference — carries the listing id, version, and content hash. */
export interface ListingRef {
  listingId: string;
  version: number;
  contentHash: string;
}

/** An on-chain transaction reference. */
export interface TxRef {
  rail: string;
  txHash: string;
  kind: string;
  /** Block/ledger height the tx landed at — carried by rails that report it (e.g. §9.5.9 `demos`). */
  blockNumber?: number;
}

/** A settled payment amount. */
export interface PaymentAmount {
  amount: string;
  currency: string;
}

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

/** Settlement finality model for a payment. */
export type SettlementFinality =
  | {
      model: "block-depth";
      finalityBlocks: number;
      finalityObservedAt: number;
    }
  | {
      model: Exclude<SettlementFinalityModel, "block-depth">;
      finalityBlocks?: never;
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

/**
 * @deprecated Use {@link ComponentSignature}. Its broad `algorithm` field is
 * retained so existing consumers are not broken by introducing the foundation.
 */
export interface ArtifactSignature {
  algorithm: string;
  signer: string;
  value: string;
}

/** DACS-4 — evidence of a settlement (payment / delivery) phase. */
interface SettlementEvidenceBase {
  /** Pinned literal per DACS-4 §9.7 (verifySettlementEvidence already enforces it). */
  evidenceVersion: "1";
  jobId: string;
  phase: string;
  phaseIndex: number;
  paymentTxRefs: TxRef[];
  observedAt: number;
  /** Omitted from the signed scope when hashing. */
  signature?: ArtifactSignature;
}

export type SettlementEvidence =
  | (SettlementEvidenceBase & {
      outcome: "success";
      paymentAmount: PaymentAmount;
      settlementFinality: SettlementFinality;
    })
  | (SettlementEvidenceBase & {
      outcome: "failure";
      reason?: string;
      paymentAmount?: PaymentAmount;
      settlementFinality?: never;
    });

/** DACS-5 — a rating recorded as a standalone RatingRecord (§10.6). */
export interface Rating {
  from: string;
  to: string;
  score: number;
  dimensions?: Record<string, number>;
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
  kind: string;
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

export interface CancellationMarker {
  claimedPolicy: string;
}

/** A per-party bundle signature: `{ party, algorithm, value }`. */
export interface BundleSignature {
  party: string;
  algorithm: string;
  value: string;
}

export type BundlePartyRole = "buyer" | "seller" | "orchestrator";
export type FaultedParty = BundlePartyRole | "none";

/** Fields shared by the legacy and v0.3 DACS-5 bundle types. */
interface BundleFields {
  jobId: string;
  outcome: string;
  /** Per-copy field; omitted from the signed scope (§10.4.1). */
  anchoredByRole?: BundlePartyRole;
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
  signatures?: BundleSignature[];
}

/** DACS-5 legacy session audit unit; retained for consumer compatibility. */
export interface AttestationBundle extends BundleFields {
  /** Pinned literal per DACS-5 §10.4.1 (legacy two-party bundle line). */
  bundleVersion: "1";
  faultBundleVersion?: never;
  faultedParty?: never;
}

/** DACS-5 v0.3 production type with absolute, hashed fault attribution. */
export interface FaultAttestationBundle extends BundleFields {
  faultBundleVersion: "1";
  faultedParty: FaultedParty;
  bundleVersion?: never;
}

export type AnyAttestationBundle = AttestationBundle | FaultAttestationBundle;

/** Discriminator for the spine artifact kinds (matches the vector `kind`). */
export type ArtifactKind =
  | "Listing"
  | "CompositeVerificationRecord"
  | "AgreementDocument"
  | "SettlementEvidence"
  | "AttestationBundle"
  | "FaultAttestationBundle";

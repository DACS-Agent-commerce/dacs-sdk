/**
 * DACS v0.1 spine artifacts for the MVP fixed-price + x402 path (T3).
 * Field shapes track the §14 conformance vectors (the source of truth) —
 * see DACS-Standard/conformance/vectors/dacs-v0.1-happy-path.json.
 *
 * Each artifact is signed under its domain separator (see ./registry) over the
 * content hash of its signed scope (the object with the signature field omitted).
 */

/** A cross-context identity reference, e.g. "web2:domain:alice.example" or "did:demos:agent:…". */
export type ClaimRef = string;

export interface ClaimRequirement {
  claimRef: ClaimRef;
  required: boolean;
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
    };

/**
 * DACS-1 — a signed, anchored service listing.
 *
 * NOTE: this is the SDK's reduced MVP shape, not the full normative Listing
 * (which also carries `pipeline`, `terms`, `validity`, `signature`, …). `pricing`
 * is the DACS-1 `pricing: PricingSpec` field (#34); it is OPTIONAL here because
 * the full required-field fidelity pass is tracked as one coherent change in #5.
 */
export interface Listing {
  agentId: string;
  serviceId: string;
  name: string;
  description: string;
  claimRequirements: ClaimRequirement[];
  supportedNegotiation: string[];
  supportedPaymentRails: string[];
  supportedDelivery: string[];
  /** DACS-1 `pricing: PricingSpec` (§ Listing) — how the service is priced. */
  pricing?: PricingSpec;
  /**
   * DACS-1 `listingVersion` (§6.3.4) — monotonic per listingId. A listing is
   * anchored at a VERSIONED address (`dacs1:<claim>:<listingId>:v<N>`), so an
   * edit is published as a NEW version at a NEW address and prior versions stay
   * immutable — old bundles keep verifying against the version they pinned (#29).
   * Optional here for back-compat; treated as 1 when absent.
   */
  listingVersion?: number;
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

/** Detached signature on a standalone artifact: `{ algorithm, signer, value }`. */
export interface ArtifactSignature {
  algorithm: string;
  signer: string;
  value: string;
}

/** DACS-4 — evidence of a settlement (payment / delivery) phase. */
interface SettlementEvidenceBase {
  evidenceVersion: string;
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
  bundleVersion: string;
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

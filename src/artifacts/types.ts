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

/** DACS-1 — a signed, anchored service listing. */
export interface Listing {
  agentId: string;
  serviceId: string;
  name: string;
  description: string;
  claimRequirements: ClaimRequirement[];
  supportedNegotiation: string[];
  supportedPaymentRails: string[];
  supportedDelivery: string[];
}

/** DACS-2 — one method result inside a composite verification record. */
export interface VerifyResultEntry {
  claimRef: ClaimRef;
  method: string;
  status: "pass" | "fail" | string;
  authority?: string;
}

/** DACS-2 — aggregated verification outcome for a subject. */
export interface CompositeVerificationRecord {
  subject: string;
  recipeId: string;
  recipeVersion: string;
  results: VerifyResultEntry[];
  requiredPassed: boolean;
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
}

/** A settled payment amount. */
export interface PaymentAmount {
  amount: string;
  currency: string;
}

/** Settlement finality model for a payment. */
export interface SettlementFinality {
  model: string;
  finalityBlocks: number;
  finalityObservedAt: number;
}

/** Detached signature on a standalone artifact: `{ algorithm, signer, value }`. */
export interface ArtifactSignature {
  algorithm: string;
  signer: string;
  value: string;
}

/** DACS-4 — evidence of a settlement (payment / delivery) phase. */
export interface SettlementEvidence {
  evidenceVersion: string;
  jobId: string;
  phase: string;
  phaseIndex: number;
  outcome: string;
  paymentTxRefs: TxRef[];
  paymentAmount: PaymentAmount;
  settlementFinality: SettlementFinality;
  observedAt: number;
  /** Omitted from the signed scope when hashing. */
  signature?: ArtifactSignature;
}

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

/** A phase entry in the bundle's phaseSummary. */
export interface PhaseSummaryEntry {
  index: number;
  kind: string;
  outcome: string;
  txRefs?: TxRef[];
  attestationRef: AttestationRef;
}

/** A per-party bundle signature: `{ party, algorithm, value }`. */
export interface BundleSignature {
  party: string;
  algorithm: string;
  value: string;
}

/** DACS-5 — the session audit unit referencing every artifact (spec shape). */
export interface AttestationBundle {
  bundleVersion: string;
  jobId: string;
  outcome: string;
  /** Per-copy field; omitted from the signed scope (§10.4.1). */
  anchoredByRole?: string;
  listingRef: ListingRef;
  agreementRef: AttestationRef;
  parties: BundleParty[];
  phaseSummary: PhaseSummaryEntry[];
  vetRecords: AttestationRef[];
  settlementEvidence: AttestationRef[];
  recipeRegistryVersion: number;
  railRegistryVersion: number;
  finalisedAt: number;
  /** Omitted from the signed scope (§10.4.1). */
  signatures?: BundleSignature[];
}

/** Discriminator for the spine artifact kinds (matches the vector `kind`). */
export type ArtifactKind =
  | "Listing"
  | "CompositeVerificationRecord"
  | "AgreementDocument"
  | "SettlementEvidence"
  | "AttestationBundle";

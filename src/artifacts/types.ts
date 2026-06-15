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

/** DACS-4 — evidence of a settlement (payment / delivery) phase. */
export interface SettlementEvidence {
  jobId: string;
  rail: string;
  chainId: string;
  txHash: string;
  payer: string;
  payee: string;
  amount: string;
  asset: string;
  ok: boolean;
  observedAt: string;
}

/** DACS-5 — a rating recorded in the bundle. */
export interface Rating {
  from: string;
  to: string;
  score: number;
  dimensions?: Record<string, number>;
}

/** DACS-5 — the session audit unit referencing every artifact. */
export interface AttestationBundle {
  jobId: string;
  state: string;
  primaryClaim: ClaimRef;
  artifactRefs: string[];
  ratings: Rating[];
  signedBy: string[];
  completedAt: string;
}

/** Discriminator for the spine artifact kinds (matches the vector `kind`). */
export type ArtifactKind =
  | "Listing"
  | "CompositeVerificationRecord"
  | "AgreementDocument"
  | "SettlementEvidence"
  | "AttestationBundle";

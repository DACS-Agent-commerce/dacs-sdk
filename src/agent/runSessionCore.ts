import { stripSignature } from "../canonical/index.js";
import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import type {
  AgreementDocument,
  AttestationBundle,
  Price,
  SettlementEvidence,
} from "../artifacts/types.js";
import { isListing } from "../artifacts/validators.js";

/**
 * Pure orchestration for the MVP buyer session (T4 runSession): negotiate
 * (fixed-price) → settle → verify, producing + anchoring the AgreementDocument,
 * SettlementEvidence, and AttestationBundle. Identify is implicit (the buyer's
 * id) and vet is a seam (see SessionDeps.vet). Settlement execution is injected
 * (`settle`) so the rail integration (x402) is pluggable and this is testable.
 */

export interface SessionTerms {
  price: Price;
  deliveryPhase: string;
  deliveryFormat: string;
}

export interface SettleRequest {
  rail: string;
  amount: string;
  asset: string;
  payee: string;
  jobId: string;
}

export interface SettleResult {
  ok: boolean;
  txHash: string;
  chainId: string;
  payer: string;
  payee: string;
}

export interface SessionDeps {
  /** The buyer agent's id / primary claim. */
  buyerId: string;
  /** Read the (signed) listing at a ref. */
  readListing: (ref: string) => Promise<unknown>;
  /** Sign an artifact under a separator, returning the signed envelope. */
  sign: (artifact: object, separator: string) => Promise<object>;
  /** Anchor a value under a name; returns the storage address. */
  anchor: (name: string, value: object) => Promise<string>;
  /** Execute payment on the chosen rail. */
  settle: (req: SettleRequest) => Promise<SettleResult>;
  /** Fresh job id (e.g. crypto.randomUUID). */
  newJobId: () => string;
  /** Current ISO-8601 timestamp. */
  now: () => string;
}

export interface SessionResult {
  outcome: "completed" | "failed";
  jobId: string;
  agreementRef: string;
  settlementRef: string;
  bundleRef: string;
}

export async function runSessionCore(
  listingRef: string,
  terms: SessionTerms,
  deps: SessionDeps,
): Promise<SessionResult> {
  const stored = await deps.readListing(listingRef);
  if (stored == null || !isListing(stripSignature(stored as Record<string, unknown>))) {
    throw new Error(`listing not found or invalid at ${listingRef}`);
  }
  const listing = stripSignature(stored as Record<string, unknown>) as unknown as {
    agentId: string;
    supportedPaymentRails: string[];
    supportedDelivery: string[];
  };

  if (!listing.supportedPaymentRails.includes(terms.price.rail)) {
    throw new Error(`rail ${terms.price.rail} not offered by the listing`);
  }
  if (!listing.supportedDelivery.includes(terms.deliveryPhase)) {
    throw new Error(`delivery ${terms.deliveryPhase} not offered by the listing`);
  }

  const jobId = deps.newJobId();

  // Negotiate (fixed-price): accept the listed terms.
  const agreement: AgreementDocument = {
    jobId,
    pattern: "negotiate-fixed-price",
    buyer: deps.buyerId,
    seller: listing.agentId,
    listingRef,
    price: terms.price,
    delivery: { phase: terms.deliveryPhase, format: terms.deliveryFormat },
    expiresAt: deps.now(),
  };
  const signedAgreement = await deps.sign(
    agreement,
    ARTIFACT_SEPARATORS.AgreementDocument,
  );
  const agreementRef = await deps.anchor(`dacs3:agreement:${jobId}`, signedAgreement);

  // Settle on the chosen rail.
  const pay = await deps.settle({
    rail: terms.price.rail,
    amount: terms.price.amount,
    asset: terms.price.asset,
    payee: listing.agentId,
    jobId,
  });
  const evidence: SettlementEvidence = {
    jobId,
    rail: terms.price.rail,
    chainId: pay.chainId,
    txHash: pay.txHash,
    payer: pay.payer,
    payee: pay.payee,
    amount: terms.price.amount,
    asset: terms.price.asset,
    ok: pay.ok,
    observedAt: deps.now(),
  };
  const signedEvidence = await deps.sign(
    evidence,
    ARTIFACT_SEPARATORS.SettlementEvidence,
  );
  const settlementRef = await deps.anchor(`dacs4:evidence:${jobId}`, signedEvidence);

  // Verify: assemble + anchor the bundle.
  const outcome: SessionResult["outcome"] = pay.ok ? "completed" : "failed";
  const bundle: AttestationBundle = {
    jobId,
    state: outcome,
    primaryClaim: listing.agentId,
    artifactRefs: [listingRef, agreementRef, settlementRef],
    ratings: [],
    signedBy: [deps.buyerId],
    completedAt: deps.now(),
  };
  const signedBundle = await deps.sign(
    bundle,
    ARTIFACT_SEPARATORS.AttestationBundle,
  );
  const bundleRef = await deps.anchor(`dacs5:bundle:${jobId}`, signedBundle);

  return { outcome, jobId, agreementRef, settlementRef, bundleRef };
}

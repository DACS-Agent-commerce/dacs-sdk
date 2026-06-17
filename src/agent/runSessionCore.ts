import { stripSignature } from "../canonical/index.js";
import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import type {
  AgreementDocument,
  AttestationBundle,
  Price,
  SettlementEvidence,
} from "../artifacts/types.js";
import {
  isAgreementDocument,
  isListing,
  isSettlementEvidence,
} from "../artifacts/validators.js";

/**
 * Pure orchestration for the MVP buyer session (T4 runSession): negotiate
 * (fixed-price) → settle → verify, producing + anchoring the AgreementDocument,
 * SettlementEvidence, and AttestationBundle. Identify is implicit (the buyer's
 * id) and vet is a seam. Settlement execution is injected (`settle`) so the rail
 * integration is pluggable and this is testable.
 *
 * Idempotent / crash-safe (T9): every phase anchors at a deterministic address
 * keyed by jobId, so the anchored artifacts ARE the session state. On resume
 * (same jobId) each phase checks-before-acting — a present agreement/evidence/
 * bundle is reused, never re-signed or re-anchored, and crucially settlement is
 * skipped if evidence already exists (no double-pay). A crash between paying and
 * anchoring evidence is the rail's idempotency window — `settle` is handed the
 * jobId so the rail can dedupe there.
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
  /** Deterministic storage address for a name (without writing) — for resume. */
  anchorAddress: (name: string) => Promise<string>;
  /** Read the artifact anchored at an address (null if absent) — for resume. */
  readAnchor: (address: string) => Promise<Record<string, unknown> | null>;
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
  resumeJobId?: string,
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

  // A caller-supplied jobId resumes an interrupted session; otherwise fresh.
  const jobId = resumeJobId ?? deps.newJobId();

  /** Anchor `build()` under `name` only if a valid artifact isn't already there. */
  const anchorOnce = async (
    name: string,
    isValid: (v: Record<string, unknown>) => boolean,
    build: () => Promise<object>,
  ): Promise<{ ref: string; existing: Record<string, unknown> | null }> => {
    const address = await deps.anchorAddress(name);
    const existing = await deps.readAnchor(address);
    if (existing && isValid(stripSignature(existing))) {
      return { ref: address, existing };
    }
    const ref = await deps.anchor(name, await build());
    return { ref, existing: null };
  };

  // Negotiate (fixed-price): accept the listed terms.
  const { ref: agreementRef } = await anchorOnce(
    `dacs3:agreement:${jobId}`,
    isAgreementDocument,
    () => {
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
      return deps.sign(agreement, ARTIFACT_SEPARATORS.AgreementDocument);
    },
  );

  // Settle on the chosen rail — but only if evidence isn't already anchored
  // (the no-double-pay guard: a present evidence record means we already paid).
  let settledOk = false;
  const { ref: settlementRef, existing: existingEvidence } = await anchorOnce(
    `dacs4:evidence:${jobId}`,
    isSettlementEvidence,
    async () => {
      const pay = await deps.settle({
        rail: terms.price.rail,
        amount: terms.price.amount,
        asset: terms.price.asset,
        payee: listing.agentId,
        jobId,
      });
      settledOk = pay.ok;
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
      return deps.sign(evidence, ARTIFACT_SEPARATORS.SettlementEvidence);
    },
  );
  if (existingEvidence) {
    // Reused a prior settlement — take the outcome from the anchored evidence.
    settledOk = (stripSignature(existingEvidence) as { ok?: unknown }).ok === true;
  }

  // Verify: assemble + anchor the bundle.
  const outcome: SessionResult["outcome"] = settledOk ? "completed" : "failed";
  const { ref: bundleRef } = await anchorOnce(
    `dacs5:bundle:${jobId}`,
    (v) => typeof v["jobId"] === "string" && Array.isArray(v["artifactRefs"]),
    () => {
      const bundle: AttestationBundle = {
        jobId,
        state: outcome,
        primaryClaim: listing.agentId,
        artifactRefs: [listingRef, agreementRef, settlementRef],
        ratings: [],
        signedBy: [deps.buyerId],
        completedAt: deps.now(),
      };
      return deps.sign(bundle, ARTIFACT_SEPARATORS.AttestationBundle);
    },
  );

  return { outcome, jobId, agreementRef, settlementRef, bundleRef };
}

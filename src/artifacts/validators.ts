import type {
  AgreementDocument,
  AttestationBundle,
  CompositeVerificationRecord,
  Listing,
  SettlementEvidence,
} from "./types.js";

const isStr = (v: unknown): v is string => typeof v === "string";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isNum = (v: unknown): v is number => typeof v === "number";
const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const isStrArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every(isStr);
const isOneOf = (set: readonly string[], v: unknown): boolean =>
  typeof v === "string" && set.includes(v);

// §9.7 enums — enforced so an out-of-spec value (e.g. outcome:"banana") is
// rejected, not just any string.
const SETTLEMENT_OUTCOMES = ["success", "failure"] as const;
const FINALITY_MODELS = [
  "block-depth",
  "commitment-level",
  "provider-receipt",
  "htlc-reveal",
  "liquidity-tank",
  "bft-final",
] as const;
// DACS-2 §7.7 verification verdicts.
const VERIFICATION_DECISIONS = [
  "pass",
  "fail",
  "indeterminate",
  "error",
] as const;

/** A DACS-4 PriceTerm: canonical positive decimal + non-empty currency. */
const isPriceTerm = (v: unknown): boolean =>
  isObj(v) && isStr(v.amount) && v.amount !== "" && isStr(v.currency) && v.currency !== "";

const AUCTION_SELECTION = ["lowest-price", "highest-price", "first-acceptable"] as const;

/** A DACS-4 PricingSpec (fixed | negotiable | auction). */
export function isPricingSpec(v: unknown): boolean {
  if (!isObj(v)) return false;
  switch (v.kind) {
    case "fixed":
      return isPriceTerm(v.price);
    case "negotiable":
      // §8.5.2: minPct/maxPct are non-negative percentages, and 0 ≤ minPct < 100
      // (a floor ≥100% below centre would price at or below zero).
      return (
        isPriceTerm(v.bandCenter) &&
        isNum(v.minPct) &&
        v.minPct >= 0 &&
        v.minPct < 100 &&
        isNum(v.maxPct) &&
        v.maxPct >= 0
      );
    case "auction":
      return (
        (v.reservePrice === undefined || isPriceTerm(v.reservePrice)) &&
        (isOneOf(AUCTION_SELECTION, v.selectionRule) ||
          (isStr(v.selectionRule) && v.selectionRule.startsWith("rule-ref:")))
      );
    default:
      return false;
  }
}

export function isListing(v: unknown): v is Listing {
  if (!isObj(v)) return false;
  return (
    isStr(v.agentId) &&
    isStr(v.serviceId) &&
    isStr(v.name) &&
    isStr(v.description) &&
    Array.isArray(v.claimRequirements) &&
    v.claimRequirements.every(
      (c) => isObj(c) && isStr(c.claimRef) && isBool(c.required),
    ) &&
    isStrArray(v.supportedNegotiation) &&
    isStrArray(v.supportedPaymentRails) &&
    isStrArray(v.supportedDelivery) &&
    // pricing is OPTIONAL (#34; full required-fidelity in #5) — but if present it
    // MUST be a well-formed PricingSpec, not any object.
    (v.pricing === undefined || isPricingSpec(v.pricing)) &&
    // listingVersion is OPTIONAL (absent ⇒ v1) — but if present it MUST be a
    // positive integer (#46/#29). runSessionCore copies it into
    // listingRef.version, so an unvalidated value (e.g. a string) would flow
    // into the bundle's version pin on the READ path even though publish
    // validates its own writes.
    (v.listingVersion === undefined ||
      (typeof v.listingVersion === "number" &&
        Number.isInteger(v.listingVersion) &&
        v.listingVersion >= 1))
  );
}

export function isCompositeVerificationRecord(
  v: unknown,
): v is CompositeVerificationRecord {
  if (!isObj(v)) return false;
  return (
    isStr(v.subject) &&
    isStr(v.recipeId) &&
    isStr(v.recipeVersion) &&
    Array.isArray(v.results) &&
    v.results.every(
      (r) =>
        isObj(r) &&
        isStr(r.claimRef) &&
        isStr(r.method) &&
        isOneOf(VERIFICATION_DECISIONS, r.status),
    ) &&
    isOneOf(VERIFICATION_DECISIONS, v.decision) &&
    isStr(v.verifiedAt)
  );
}

export function isAgreementDocument(v: unknown): v is AgreementDocument {
  if (!isObj(v)) return false;
  const price = v.price;
  const delivery = v.delivery;
  return (
    isStr(v.jobId) &&
    isStr(v.pattern) &&
    isStr(v.buyer) &&
    isStr(v.seller) &&
    isStr(v.listingRef) &&
    isObj(price) &&
    isStr(price.amount) &&
    isStr(price.asset) &&
    isNum(price.decimals) &&
    isStr(price.rail) &&
    isObj(delivery) &&
    isStr(delivery.phase) &&
    isStr(delivery.format) &&
    isStr(v.expiresAt)
  );
}

const isTxRef = (v: unknown): boolean =>
  isObj(v) && isStr(v.rail) && isStr(v.txHash) && isStr(v.kind);
const isAttestationRef = (v: unknown): boolean =>
  isObj(v) && isStr(v.kind) && isStr(v.id) && isStr(v.contentHash);

export function isSettlementEvidence(v: unknown): v is SettlementEvidence {
  if (!isObj(v)) return false;
  const amt = v.paymentAmount;
  const fin = v.settlementFinality;
  const baseValid =
    isStr(v.evidenceVersion) &&
    isStr(v.jobId) &&
    isStr(v.phase) &&
    isNum(v.phaseIndex) &&
    isOneOf(SETTLEMENT_OUTCOMES, v.outcome) &&
    Array.isArray(v.paymentTxRefs) &&
    v.paymentTxRefs.every(isTxRef) &&
    isNum(v.observedAt);
  if (!baseValid) return false;
  if (v.outcome === "failure") {
    return (
      fin === undefined &&
      (amt === undefined || (isObj(amt) && isStr(amt.amount) && isStr(amt.currency)))
    );
  }
  if (!isObj(amt) || !isStr(amt.amount) || !isStr(amt.currency) || !isObj(fin)) {
    return false;
  }
  if (!isOneOf(FINALITY_MODELS, fin.model) || !isNum(fin.finalityObservedAt)) {
    return false;
  }
  return fin.model === "block-depth"
    ? isNum(fin.finalityBlocks)
    : fin.finalityBlocks === undefined;
}

export function isAttestationBundle(v: unknown): v is AttestationBundle {
  if (!isObj(v)) return false;
  const lr = v.listingRef;
  return (
    isStr(v.bundleVersion) &&
    isStr(v.jobId) &&
    isStr(v.outcome) &&
    isObj(lr) &&
    isStr(lr.listingId) &&
    isNum(lr.version) &&
    isStr(lr.contentHash) &&
    isAttestationRef(v.agreementRef) &&
    Array.isArray(v.parties) &&
    v.parties.every(
      (p) => isObj(p) && isStr(p.role) && isStr(p.bundleHash) && isStr(p.primaryClaim),
    ) &&
    Array.isArray(v.phaseSummary) &&
    v.phaseSummary.every(
      (ph) =>
        isObj(ph) &&
        isNum(ph.index) &&
        isStr(ph.kind) &&
        isStr(ph.outcome) &&
        // §10.4.3 / DACS-Standard#204: attestationRef is OPTIONAL — a bundle MUST
        // NOT be rejected solely because a phaseSummary entry omits it.
        (ph.attestationRef === undefined || isAttestationRef(ph.attestationRef)),
    ) &&
    Array.isArray(v.vetRecords) &&
    v.vetRecords.every(isAttestationRef) &&
    Array.isArray(v.settlementEvidence) &&
    v.settlementEvidence.every(isAttestationRef) &&
    isNum(v.recipeRegistryVersion) &&
    isNum(v.railRegistryVersion) &&
    isNum(v.finalisedAt)
  );
}

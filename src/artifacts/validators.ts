import type {
  AgreementDocument,
  AnyAttestationBundle,
  AttestationBundle,
  CompositeVerificationRecord,
  FaultAttestationBundle,
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
const BUNDLE_PHASE_OUTCOMES = ["ok", "fail"] as const;
const BUNDLE_PHASE_ERROR_CLASSES = [
  "permanent",
  "transient",
  "counterparty",
  "substrate",
  "settlement-atomicity",
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
    (v.pricing === undefined || isPricingSpec(v.pricing))
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

function isLegacyBundleParties(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.every(
      (p) => isObj(p) && isStr(p.role) && isStr(p.bundleHash) && isStr(p.primaryClaim),
    )
  );
}

function isFaultBundleParties(v: unknown): boolean {
  if (!Array.isArray(v)) return false;
  if (
    !v.every(
      (p) =>
        isObj(p) &&
        isOneOf(["buyer", "seller", "orchestrator"], p.role) &&
        isStr(p.bundleHash) &&
        isStr(p.primaryClaim),
    )
  ) {
    return false;
  }
  const parties = v as Array<Record<string, unknown>>;
  const roles = parties.map((party) => party.role as string);
  if (new Set(roles).size !== roles.length || !roles.includes("buyer") || !roles.includes("seller")) {
    return false;
  }
  const orchestrator = parties.find((party) => party.role === "orchestrator")?.primaryClaim;
  if (typeof orchestrator === "string") {
    const buyer = parties.find((party) => party.role === "buyer")?.primaryClaim;
    const seller = parties.find((party) => party.role === "seller")?.primaryClaim;
    if (orchestrator === buyer || orchestrator === seller) return false;
  }
  return true;
}

/** DACS-5 §10.4.1 permissible set for one absolute-fault copy. */
export function faultedPartyIsPermitted(bundle: Record<string, unknown>): boolean {
  const anchor = bundle.anchoredByRole;
  const faulted = bundle.faultedParty;
  const outcome = bundle.outcome;
  if (anchor !== "buyer" && anchor !== "seller" && anchor !== "orchestrator") return false;
  if (!Array.isArray(bundle.parties)) return false;
  const roles = new Set<unknown>(
    bundle.parties
      .filter(isObj)
      .map((party) => party.role)
      .filter((role) => role === "buyer" || role === "seller" || role === "orchestrator"),
  );
  if (!roles.has(anchor)) return false;
  if (outcome === "completed" || outcome === "failed-substrate") return faulted === "none";
  if (outcome === "failed-perm" || outcome === "aborted-by-self") return faulted === anchor;
  if (outcome === "failed-counterparty" || outcome === "aborted-by-other") {
    return faulted !== "none" && faulted !== anchor && roles.has(faulted);
  }
  return false;
}

export function isSettlementEvidence(v: unknown): v is SettlementEvidence {
  if (!isObj(v)) return false;
  const amt = v.paymentAmount;
  const fin = v.settlementFinality;
  return (
    isStr(v.evidenceVersion) &&
    isStr(v.jobId) &&
    isStr(v.phase) &&
    isNum(v.phaseIndex) &&
    isOneOf(SETTLEMENT_OUTCOMES, v.outcome) &&
    Array.isArray(v.paymentTxRefs) &&
    v.paymentTxRefs.every(isTxRef) &&
    isObj(amt) &&
    isStr(amt.amount) &&
    isStr(amt.currency) &&
    isObj(fin) &&
    isOneOf(FINALITY_MODELS, fin.model) &&
    isNum(fin.finalityBlocks) &&
    isNum(fin.finalityObservedAt) &&
    isNum(v.observedAt)
  );
}

function hasBundleFields(
  v: Record<string, unknown>,
  partiesAreValid: (parties: unknown) => boolean,
): boolean {
  const lr = v.listingRef;
  return (
    isStr(v.jobId) &&
    isStr(v.outcome) &&
    (v.anchoredByRole === undefined ||
      isOneOf(["buyer", "seller", "orchestrator"], v.anchoredByRole)) &&
    isObj(lr) &&
    isStr(lr.listingId) &&
    isNum(lr.version) &&
    isStr(lr.contentHash) &&
    (v.agreementRef === undefined || isAttestationRef(v.agreementRef)) &&
    (v.cancellation === undefined ||
      (isObj(v.cancellation) &&
        v.cancellation.claimedPolicy === "pre-commit" &&
        (v.outcome === "aborted-by-self" || v.outcome === "aborted-by-other") &&
        v.agreementRef === undefined)) &&
    partiesAreValid(v.parties) &&
    Array.isArray(v.phaseSummary) &&
    v.phaseSummary.every(
      (ph) =>
        isObj(ph) &&
        isNum(ph.index) &&
        isStr(ph.kind) &&
        isOneOf(BUNDLE_PHASE_OUTCOMES, ph.outcome) &&
        (ph.errorClass === undefined || isOneOf(BUNDLE_PHASE_ERROR_CLASSES, ph.errorClass)) &&
        (ph.txRefs === undefined ||
          (Array.isArray(ph.txRefs) && ph.txRefs.every(isTxRef))) &&
        (ph.attestationRef === undefined || isAttestationRef(ph.attestationRef)),
    ) &&
    new Set(v.phaseSummary.map((ph) => (ph as Record<string, unknown>).index)).size ===
      v.phaseSummary.length &&
    Array.isArray(v.vetRecords) &&
    v.vetRecords.every(isAttestationRef) &&
    Array.isArray(v.settlementEvidence) &&
    v.settlementEvidence.every(isAttestationRef) &&
    (v.amendments === undefined ||
      (Array.isArray(v.amendments) && v.amendments.every(isAttestationRef))) &&
    (v.ratingRefs === undefined ||
      (Array.isArray(v.ratingRefs) && v.ratingRefs.every(isAttestationRef))) &&
    isNum(v.recipeRegistryVersion) &&
    isNum(v.railRegistryVersion) &&
    isNum(v.finalisedAt)
  );
}

export function isAttestationBundle(v: unknown): v is AttestationBundle {
  if (!isObj(v)) return false;
  return (
    isStr(v.bundleVersion) &&
    v.faultBundleVersion === undefined &&
    v.faultedParty === undefined &&
    hasBundleFields(v, isLegacyBundleParties)
  );
}

export function isFaultAttestationBundle(v: unknown): v is FaultAttestationBundle {
  if (!isObj(v)) return false;
  return (
    v.faultBundleVersion === "1" &&
    v.bundleVersion === undefined &&
    isOneOf(["buyer", "seller", "orchestrator", "none"], v.faultedParty) &&
    hasBundleFields(v, isFaultBundleParties) &&
    faultedPartyIsPermitted(v)
  );
}

export function isAnyAttestationBundle(v: unknown): v is AnyAttestationBundle {
  return isAttestationBundle(v) || isFaultAttestationBundle(v);
}

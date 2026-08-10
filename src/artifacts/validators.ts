import type {
  AgreementDocument,
  AnyAttestationBundle,
  AttestationRef,
  AttestationBundle,
  ChainTxRef,
  CompositeVerificationRecord,
  FaultAttestationBundle,
  Listing,
  SettlementEvidence,
} from "./types.js";
import { isComponentSignature } from "./signatures.js";
import { canonicalizeDecimal } from "../canonical/decimal.js";

const isStr = (v: unknown): v is string => typeof v === "string";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const isStrArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every(isStr);
const isOneOf = (set: readonly string[], v: unknown): boolean =>
  typeof v === "string" && set.includes(v);
const hasOnlyKeys = (v: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(v).every((key) => allowed.includes(key));
const isNonEmptyStr = (v: unknown): v is string => isStr(v) && v.length > 0;
const isNonNegativeInt = (v: unknown): v is number =>
  isNum(v) && Number.isInteger(v) && v >= 0;
const isSha256 = (v: unknown): v is string =>
  isStr(v) && /^[0-9a-f]{64}$/.test(v);

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
const PHASE_TYPES = [
  "vet-credentials",
  "negotiate-fixed-price",
  "negotiate-rfq",
  "negotiate-sealed-envelope",
  "negotiate-sealed-envelope-procurement",
  "commit-agreement",
  "commit-payee-bound-agreement",
  "pay-evm-erc20",
  "pay-solana-spl",
  "pay-cross-chain-htlc",
  "pay-cross-chain-liquidity-tank",
  "pay-ap2",
  "pay-x402",
  "pay-dem",
  "deliver-storage-program",
  "deliver-entitlement",
  "deliver-attested-payload",
  "rate",
] as const;
const PAYMENT_PHASES = PHASE_TYPES.filter((phase) => phase.startsWith("pay-"));
const DELIVERY_PHASES = PHASE_TYPES.filter((phase) => phase.startsWith("deliver-"));
const COMPONENT_SIGNATURE_ALGORITHMS = [
  "ed25519",
  "ecdsa-secp256k1",
  "sr1-aggregate",
] as const;
const BUNDLE_OUTCOMES = [
  "completed",
  "failed-perm",
  "failed-counterparty",
  "failed-substrate",
  "aborted-by-self",
  "aborted-by-other",
] as const;
// DACS-2 §7.7 verification verdicts.
const VERIFICATION_DECISIONS = [
  "pass",
  "fail",
  "indeterminate",
  "error",
] as const;

const isCanonicalAmount = (value: unknown, allowZero = false): value is string => {
  if (!isStr(value)) return false;
  try {
    return canonicalizeDecimal(value) === value && (allowZero || value !== "0");
  } catch {
    return false;
  }
};

/** A DACS-4 PriceTerm: canonical positive decimal + non-empty currency. */
const isPriceTerm = (v: unknown): boolean =>
  isObj(v) &&
  isCanonicalAmount(v.amount) &&
  isNonEmptyStr(v.currency);

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

/** DACS-2 §7.5.2 exact AttestationRef wire shape. */
export function isAttestationRef(v: unknown): v is AttestationRef {
  if (!isObj(v) || !hasOnlyKeys(v, ["anchor", "contentHash", "signer"])) return false;
  const anchor = v.anchor;
  return (
    isObj(anchor) &&
    hasOnlyKeys(anchor, ["kind", "locator"]) &&
    isOneOf(["storage-program", "ipfs", "https"], anchor.kind) &&
    isNonEmptyStr(anchor.locator) &&
    isSha256(v.contentHash) &&
    (v.signer === undefined || isNonEmptyStr(v.signer))
  );
}

/** DACS-4 §9.3 exact ChainTxRef discriminated union. */
export function isChainTxRef(v: unknown): v is ChainTxRef {
  if (!isObj(v) || !isStr(v.kind)) return false;
  switch (v.kind) {
    case "evm":
      return (
        hasOnlyKeys(v, ["kind", "chainId", "txHash"]) &&
        isNonNegativeInt(v.chainId) &&
        isNonEmptyStr(v.txHash)
      );
    case "solana":
      return (
        hasOnlyKeys(v, ["kind", "cluster", "signature"]) &&
        isOneOf(["mainnet", "devnet", "testnet"], v.cluster) &&
        isNonEmptyStr(v.signature)
      );
    case "demos":
      return (
        hasOnlyKeys(v, ["kind", "txHash", "blockNumber"]) &&
        isNonEmptyStr(v.txHash) &&
        (v.blockNumber === undefined || isNonNegativeInt(v.blockNumber))
      );
    case "storage-program":
      return (
        hasOnlyKeys(v, ["kind", "address", "writeTxHash"]) &&
        isNonEmptyStr(v.address) &&
        isNonEmptyStr(v.writeTxHash)
      );
    case "ap2":
      return (
        hasOnlyKeys(v, [
          "kind",
          "mandateId",
          "providerRef",
          "protocolVersion",
          "receiptAttestation",
        ]) &&
        isNonEmptyStr(v.mandateId) &&
        isNonEmptyStr(v.providerRef) &&
        isNonEmptyStr(v.protocolVersion) &&
        (v.receiptAttestation === undefined ||
          isAttestationRef(v.receiptAttestation))
      );
    case "x402":
      return (
        hasOnlyKeys(v, [
          "kind",
          "httpResource",
          "paymentReceiptHash",
          "settlementTxHash",
          "chainId",
          "protocolVersion",
        ]) &&
        isNonEmptyStr(v.httpResource) &&
        isSha256(v.paymentReceiptHash) &&
        (v.settlementTxHash === undefined || isNonEmptyStr(v.settlementTxHash)) &&
        (v.chainId === undefined || isNonNegativeInt(v.chainId)) &&
        isNonEmptyStr(v.protocolVersion)
      );
    case "htlc-lock":
    case "htlc-reveal":
    case "htlc-claim":
    case "htlc-refund": {
      const hashField = {
        "htlc-lock": "lockTxHash",
        "htlc-reveal": "revealTxHash",
        "htlc-claim": "claimTxHash",
        "htlc-refund": "refundTxHash",
      }[v.kind];
      return (
        hasOnlyKeys(v, ["kind", "chainId", "contractAddress", hashField]) &&
        isNonNegativeInt(v.chainId) &&
        isNonEmptyStr(v.contractAddress) &&
        isNonEmptyStr(v[hashField])
      );
    }
    case "liquidity-tank":
      return (
        hasOnlyKeys(v, [
          "kind",
          "bridgeId",
          "sourceChainId",
          "destChainId",
          "lockTxHash",
          "releaseTxHash",
          "recoveryDeadline",
        ]) &&
        isNonEmptyStr(v.bridgeId) &&
        isNonNegativeInt(v.sourceChainId) &&
        isNonNegativeInt(v.destChainId) &&
        isNonEmptyStr(v.lockTxHash) &&
        (v.releaseTxHash === undefined || isNonEmptyStr(v.releaseTxHash)) &&
        (v.recoveryDeadline === undefined || isNonNegativeInt(v.recoveryDeadline))
      );
    default:
      return false;
  }
}

function isBundleParties(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.every(
      (p) =>
        isObj(p) &&
        hasOnlyKeys(p, ["role", "bundleHash", "primaryClaim"]) &&
        isOneOf(["buyer", "seller", "orchestrator"], p.role) &&
        isSha256(p.bundleHash) &&
        isNonEmptyStr(p.primaryClaim),
    )
  );
}

function isFaultBundleParties(v: unknown): boolean {
  if (!isBundleParties(v)) return false;
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
  // CORE §B.7 SIG-5: unknown artifact-level fields are retained in the signed
  // scope and do not alone invalidate a known version. Variant-owned fields
  // below are still checked conditionally and nested oneOf shapes stay exact.
  // DACS-4 §9.5.8 SB-1 explicitly says phaseIndex is recovered from the anchor
  // address and is NOT an evidence field, so this known legacy field is refused.
  if (Object.prototype.hasOwnProperty.call(v, "phaseIndex")) return false;
  const amt = v.paymentAmount;
  const fee = v.paymentFee;
  const fin = v.settlementFinality;
  const baseValid =
    v.evidenceVersion === "1" &&
    isNonEmptyStr(v.jobId) &&
    isOneOf(SETTLEMENT_OUTCOMES, v.outcome) &&
    isNum(v.observedAt) &&
    isComponentSignature(v.signature) &&
    (v.amendmentRefs === undefined ||
      (Array.isArray(v.amendmentRefs) && v.amendmentRefs.every(isAttestationRef))) &&
    (v.supersedesEvidenceRef === undefined ||
      isAttestationRef(v.supersedesEvidenceRef));
  if (!baseValid) return false;

  const isPayment = isOneOf(PAYMENT_PHASES, v.phase);
  const isDelivery = isOneOf(DELIVERY_PHASES, v.phase);
  if (!isPayment && !isDelivery) return false;

  const validAmount = (value: unknown): boolean =>
    isObj(value) &&
    hasOnlyKeys(value, ["amount", "currency"]) &&
    isCanonicalAmount(value.amount) &&
    isNonEmptyStr(value.currency);
  const validFee = (value: unknown): boolean =>
    isObj(value) &&
    hasOnlyKeys(value, ["amount", "currency"]) &&
    isCanonicalAmount(value.amount, true) &&
    isNonEmptyStr(value.currency);
  const validFinality = (value: unknown): boolean => {
    if (!isObj(value) || !isOneOf(FINALITY_MODELS, value.model)) return false;
    if (!isNum(value.finalityObservedAt)) return false;
    if (value.model === "block-depth") {
      return (
        hasOnlyKeys(value, ["model", "finalityBlocks", "finalityObservedAt"]) &&
        (value.finalityBlocks === undefined || isNonNegativeInt(value.finalityBlocks))
      );
    }
    if (value.model === "commitment-level") {
      return (
        hasOnlyKeys(value, [
          "model",
          "finalityCommitmentLevel",
          "finalityObservedAt",
        ]) &&
        (value.finalityCommitmentLevel === undefined ||
          isOneOf(
            ["processed", "confirmed", "finalized"],
            value.finalityCommitmentLevel,
          ))
      );
    }
    return hasOnlyKeys(value, ["model", "finalityObservedAt"]);
  };

  if (isPayment) {
    if (
      v.deliverableContentHash !== undefined ||
      v.deliverableAnchor !== undefined ||
      v.attestationRef !== undefined
    ) {
      return false;
    }
    if (
      v.paymentTxRefs !== undefined &&
      (!Array.isArray(v.paymentTxRefs) || !v.paymentTxRefs.every(isChainTxRef))
    ) {
      return false;
    }
    if (fee !== undefined && !validFee(fee)) return false;
    if (v.outcome === "failure") {
      return (
        isNonEmptyStr(v.reason) &&
        fin === undefined &&
        (amt === undefined || validAmount(amt))
      );
    }
    return (
      v.reason === undefined &&
      Array.isArray(v.paymentTxRefs) &&
      v.paymentTxRefs.length > 0 &&
      validAmount(amt) &&
      validFinality(fin) &&
      (v.phase !== "pay-ap2" ||
        v.paymentTxRefs.every(
          (ref) => ref.kind !== "ap2" || ref.receiptAttestation !== undefined,
        ))
    );
  }

  if (fin !== undefined) return false;
  if (
    v.paymentTxRefs !== undefined &&
    (!Array.isArray(v.paymentTxRefs) || !v.paymentTxRefs.every(isChainTxRef))
  ) {
    return false;
  }
  if (amt !== undefined && !validAmount(amt)) return false;
  if (fee !== undefined && !validFee(fee)) return false;
  const anchor = v.deliverableAnchor;
  const validDeliveryFields =
    (v.deliverableContentHash === undefined || isSha256(v.deliverableContentHash)) &&
    (anchor === undefined ||
      (isObj(anchor) &&
        hasOnlyKeys(anchor, ["kind", "locator"]) &&
        isNonEmptyStr(anchor.kind) &&
        isNonEmptyStr(anchor.locator))) &&
    (v.attestationRef === undefined || isAttestationRef(v.attestationRef));
  if (!validDeliveryFields) return false;
  if (v.outcome === "failure") return isNonEmptyStr(v.reason);
  if (
    v.reason !== undefined ||
    !isSha256(v.deliverableContentHash) ||
    !isObj(anchor)
  ) {
    return false;
  }
  return v.phase !== "deliver-attested-payload" || isAttestationRef(v.attestationRef);
}

function hasBundleFields(
  v: Record<string, unknown>,
  partiesAreValid: (parties: unknown) => boolean,
  phaseKindIsValid: (kind: unknown) => boolean,
): boolean {
  const lr = v.listingRef;
  return (
    isNonEmptyStr(v.jobId) &&
    isOneOf(BUNDLE_OUTCOMES, v.outcome) &&
    isOneOf(["buyer", "seller", "orchestrator"], v.anchoredByRole) &&
    isObj(lr) &&
    hasOnlyKeys(lr, ["listingId", "version", "contentHash"]) &&
    isNonEmptyStr(lr.listingId) &&
    isNonNegativeInt(lr.version) &&
    lr.version >= 1 &&
    isSha256(lr.contentHash) &&
    (v.agreementRef === undefined || isAttestationRef(v.agreementRef)) &&
    (v.cancellation === undefined ||
      (isObj(v.cancellation) &&
        hasOnlyKeys(v.cancellation, ["claimedPolicy"]) &&
        v.cancellation.claimedPolicy === "pre-commit" &&
        (v.outcome === "aborted-by-self" || v.outcome === "aborted-by-other") &&
        v.agreementRef === undefined)) &&
    partiesAreValid(v.parties) &&
    Array.isArray(v.phaseSummary) &&
    v.phaseSummary.every(
      (ph) =>
        isObj(ph) &&
        hasOnlyKeys(ph, [
          "index",
          "kind",
          "outcome",
          "errorClass",
          "txRefs",
          "attestationRef",
        ]) &&
        isNonNegativeInt(ph.index) &&
        phaseKindIsValid(ph.kind) &&
        isOneOf(BUNDLE_PHASE_OUTCOMES, ph.outcome) &&
        (ph.errorClass === undefined || isOneOf(BUNDLE_PHASE_ERROR_CLASSES, ph.errorClass)) &&
        (ph.txRefs === undefined ||
          (Array.isArray(ph.txRefs) && ph.txRefs.every(isChainTxRef))) &&
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
    isNonNegativeInt(v.recipeRegistryVersion) &&
    isNonNegativeInt(v.railRegistryVersion) &&
    isNonNegativeInt(v.finalisedAt) &&
    Array.isArray(v.signatures) &&
    v.signatures.length > 0 &&
    v.signatures.every(
      (signature) =>
        isObj(signature) &&
        hasOnlyKeys(signature, ["party", "algorithm", "value"]) &&
        isNonEmptyStr(signature.party) &&
        isOneOf(COMPONENT_SIGNATURE_ALGORITHMS, signature.algorithm) &&
        isNonEmptyStr(signature.value),
    )
  );
}

export function isAttestationBundle(v: unknown): v is AttestationBundle {
  if (!isObj(v)) return false;
  return (
    v.bundleVersion === "1" &&
    v.faultBundleVersion === undefined &&
    v.faultedParty === undefined &&
    hasBundleFields(v, isBundleParties, isNonEmptyStr)
  );
}

export function isFaultAttestationBundle(v: unknown): v is FaultAttestationBundle {
  if (!isObj(v)) return false;
  return (
    v.faultBundleVersion === "1" &&
    v.bundleVersion === undefined &&
    isOneOf(["buyer", "seller", "orchestrator", "none"], v.faultedParty) &&
    hasBundleFields(v, isFaultBundleParties, (kind) =>
      isOneOf(PHASE_TYPES, kind),
    ) &&
    faultedPartyIsPermitted(v)
  );
}

export function isAnyAttestationBundle(v: unknown): v is AnyAttestationBundle {
  return isAttestationBundle(v) || isFaultAttestationBundle(v);
}

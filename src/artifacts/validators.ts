import type {
  AgreementDocument,
  AttestationBundle,
  CompositeVerificationRecord,
  Listing,
  Rating,
  SettlementEvidence,
} from "./types.js";

const isStr = (v: unknown): v is string => typeof v === "string";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isNum = (v: unknown): v is number => typeof v === "number";
const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const isStrArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every(isStr);

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
    isStrArray(v.supportedDelivery)
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
    v.results.every((r) => isObj(r) && isStr(r.claimRef) && isStr(r.method) && isStr(r.status)) &&
    isBool(v.requiredPassed) &&
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

export function isSettlementEvidence(v: unknown): v is SettlementEvidence {
  if (!isObj(v)) return false;
  return (
    isStr(v.jobId) &&
    isStr(v.rail) &&
    isStr(v.chainId) &&
    isStr(v.txHash) &&
    isStr(v.payer) &&
    isStr(v.payee) &&
    isStr(v.amount) &&
    isStr(v.asset) &&
    isBool(v.ok) &&
    isStr(v.observedAt)
  );
}

function isRating(v: unknown): v is Rating {
  return (
    isObj(v) &&
    isStr(v.from) &&
    isStr(v.to) &&
    isNum(v.score) &&
    (v.dimensions === undefined ||
      (isObj(v.dimensions) && Object.values(v.dimensions).every(isNum)))
  );
}

export function isAttestationBundle(v: unknown): v is AttestationBundle {
  if (!isObj(v)) return false;
  return (
    isStr(v.jobId) &&
    isStr(v.state) &&
    isStr(v.primaryClaim) &&
    isStrArray(v.artifactRefs) &&
    Array.isArray(v.ratings) &&
    v.ratings.every(isRating) &&
    isStrArray(v.signedBy) &&
    isStr(v.completedAt)
  );
}

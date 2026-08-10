import type {
  AgreementDocument,
  AnyAttestationBundle,
  AttestationBundle,
  BundleRequirement,
  CompositeVerificationRecord,
  DeliverableSpec,
  FaultAttestationBundle,
  IdentityBundle,
  LegacyMvpListing,
  Listing,
  ListingDraft,
  ListingTerms,
  PaymentRailRef,
  PhaseStep,
  ReadableListing,
  SettlementEvidence,
  VerificationMethod,
} from "./types.js";
import { assertPositiveAmount, canonicalize, stripSignature } from "../canonical/index.js";
import {
  isCanonicalBase64Url,
  isComponentSignature,
} from "./signatures.js";

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

const isSafeUint = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isPositiveSafeInt = (v: unknown): v is number => isSafeUint(v) && v > 0;
const isOptionalStr = (v: unknown): boolean => v === undefined || isStr(v);
const isClaimRef = (v: unknown): v is string =>
  isStr(v) && /^[a-z][a-z0-9-]*:.+$/.test(v) && v.trim() === v;
const isRecordOfStrings = (v: unknown): boolean =>
  isObj(v) && Object.values(v).every(isStr);

/** DACS-1 §6.3.4 `seller.publicEndpoint`: syntax-only HTTPS validation. */
export function isListingPublicEndpoint(v: unknown): v is string {
  if (!isStr(v)) return false;
  try {
    const parsed = new URL(v);
    return parsed.protocol === "https:" && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

const isVerifyResultRef = (v: unknown): boolean =>
  isObj(v) &&
  isObj(v.anchor) &&
  isOneOf(["storage-program", "ipfs", "https"], v.anchor.kind) &&
  isStr(v.anchor.locator) &&
  v.anchor.locator.length > 0 &&
  isStr(v.contentHash) &&
  v.contentHash.length > 0 &&
  isPositiveSafeInt(v.recipeVersion);

const isBundleClaim = (v: unknown): boolean =>
  isObj(v) &&
  isClaimRef(v.ref) &&
  (v.verifiedBy === undefined || isVerifyResultRef(v.verifiedBy)) &&
  (v.issuedAt === undefined || isSafeUint(v.issuedAt)) &&
  (v.expiresAt === undefined || isSafeUint(v.expiresAt)) &&
  (v.metadata === undefined || isObj(v.metadata));

const isPresentation = (v: unknown): boolean => {
  if (!isObj(v)) return false;
  switch (v.kind) {
    case "siwd":
      return isStr(v.message) && isStr(v.signature) && isStr(v.address);
    case "per-claim":
      return (
        Array.isArray(v.signatures) &&
        v.signatures.length > 0 &&
        v.signatures.every(
          (entry) =>
            isObj(entry) && isClaimRef(entry.ref) && isStr(entry.signature),
        )
      );
    case "session-key":
      return (
        isStr(v.key) &&
        isStr(v.signature) &&
        isOptionalStr(v.rootBinding)
      );
    case "sr1-root":
      return isClaimRef(v.rootClaim) && isStr(v.aggregateSignature);
    default:
      return false;
  }
};

/** DACS-1 §6.3.2 structural IdentityBundle gate used by Listing validation. */
export function isIdentityBundle(v: unknown): v is IdentityBundle {
  if (
    !isObj(v) ||
    v.bundleVersion !== "1" ||
    !isClaimRef(v.presentedBy) ||
    !isSafeUint(v.presentedAt) ||
    (v.sessionNonce !== undefined && !isStr(v.sessionNonce)) ||
    !Array.isArray(v.claims) ||
    v.claims.length === 0 ||
    !v.claims.every(isBundleClaim) ||
    !isPresentation(v.presentation)
  ) {
    return false;
  }
  // DACS-1 §6.3.2 BP-3: presentedBy resolves to one carried claim.
  return v.claims.some(
    (claim) => isObj(claim) && claim.ref === v.presentedBy,
  );
}

const isClaimRequirement = (v: unknown): boolean =>
  isObj(v) &&
  isStr(v.scheme) &&
  /^[a-z][a-z0-9-]*$/.test(v.scheme) &&
  isBool(v.verificationRequired) &&
  (v.maxAge === undefined || isSafeUint(v.maxAge)) &&
  (v.recipeVersion === undefined || isPositiveSafeInt(v.recipeVersion)) &&
  (v.parameters === undefined || isObj(v.parameters));

/** DACS-1 §6.3.3 structural BundleRequirement gate. */
export function isBundleRequirement(v: unknown): v is BundleRequirement {
  return (
    isObj(v) &&
    v.requirementVersion === "1" &&
    Array.isArray(v.required) &&
    v.required.every(isClaimRequirement) &&
    (v.oneOf === undefined ||
      (Array.isArray(v.oneOf) &&
        v.oneOf.every(
          (group) =>
            Array.isArray(group) &&
            group.length > 0 &&
            group.every(isClaimRequirement),
        ))) &&
    (v.preferredPresentation === undefined ||
      isOneOf(
        ["siwd", "sr1-root", "per-claim", "session-key", "any"],
        v.preferredPresentation,
      )) &&
    (v.primaryClaimSelector === undefined ||
      (isStr(v.primaryClaimSelector) &&
        /^[a-z][a-z0-9-]*$/.test(v.primaryClaimSelector)))
  );
}

/** DACS-4 §9.3 PriceTerm: positive CD-1 canonical amount and currency. */
const isPriceTerm = (v: unknown): boolean => {
  if (
    !isObj(v) ||
    !isStr(v.amount) ||
    !isStr(v.currency) ||
    v.currency.length === 0 ||
    (v.unit !== undefined && !isStr(v.unit))
  ) {
    return false;
  }
  try {
    return assertPositiveAmount(v.amount) === v.amount;
  } catch {
    return false;
  }
};

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
          (isStr(v.selectionRule) &&
            /^rule-ref:[0-9a-f]{64}:.+/.test(v.selectionRule)))
      );
    case "metered":
      return (
        isPriceTerm(v.unitPrice) &&
        isStr(v.unit) &&
        v.unit.length > 0 &&
        (v.minTotal === undefined ||
          (isPriceTerm(v.minTotal) &&
            isObj(v.unitPrice) &&
            isObj(v.minTotal) &&
            v.minTotal.currency === v.unitPrice.currency))
      );
    default:
      return false;
  }
}

/** DACS-2 §7.4.1 closed VerificationMethod union used by DeliverableSpec. */
export function isVerificationMethod(v: unknown): v is VerificationMethod {
  if (!isObj(v)) return false;
  switch (v.kind) {
    case "verifiable-credential":
      return (
        (v.issuerAllowList === undefined ||
          (Array.isArray(v.issuerAllowList) &&
            v.issuerAllowList.every(isClaimRef))) &&
        isOptionalStr(v.schemaUrl)
      );
    case "tlsnotary":
      return isStr(v.endpoint) && isOptionalStr(v.sessionTemplate);
    case "zktls":
      return isStr(v.provider) && isStr(v.programId);
    case "consensus-backed-proxy":
      return (
        isObj(v.endpoint) &&
        isOneOf(["GET", "POST"], v.endpoint.method) &&
        isStr(v.endpoint.urlTemplate) &&
        (v.endpoint.headers === undefined ||
          isRecordOfStrings(v.endpoint.headers)) &&
        isOptionalStr(v.endpoint.body)
      );
    case "oauth-attested":
      return (
        isStr(v.provider) &&
        isStrArray(v.scopes) &&
        isSafeUint(v.maxTokenAgeSec)
      );
    case "evm-rpc":
      return (
        isSafeUint(v.chainId) &&
        isStr(v.contract) &&
        isStr(v.method) &&
        (v.args === undefined || Array.isArray(v.args))
      );
    case "domain-tls-control":
      return isOneOf(
        ["http-01", "dns-01", "tls-alpn-01"],
        v.challengeType,
      );
    case "self-signed":
    case "demos-gcr-domain":
      return true;
    default:
      return false;
  }
}

/** DACS-4 §9.3 closed DeliverableSpec union. */
export function isDeliverableSpec(v: unknown): v is DeliverableSpec {
  if (!isObj(v)) return false;
  switch (v.kind) {
    case "storage-program":
      return (
        isOptionalStr(v.schemaUrl) &&
        (v.expectedSizeBytes === undefined || isSafeUint(v.expectedSizeBytes)) &&
        (v.accessModel === undefined ||
          isOneOf(["public", "buyer-only", "encrypt-to-buyer"], v.accessModel))
      );
    case "entitlement":
      return isPositiveSafeInt(v.durationSec) && isBool(v.renewable);
    case "attested-payload":
      return (
        isStr(v.payloadFormat) &&
        v.payloadFormat.length > 0 &&
        (v.verificationMethod === undefined ||
          isVerificationMethod(v.verificationMethod)) &&
        (v.expectedSizeBytes === undefined || isSafeUint(v.expectedSizeBytes))
      );
    case "external":
      return (
        isStr(v.description) &&
        (v.verificationMethod === undefined ||
          isVerificationMethod(v.verificationMethod))
      );
    default:
      return false;
  }
}

const isPaymentRailRef = (v: unknown): v is PaymentRailRef =>
  isObj(v) &&
  isStr(v.railId) &&
  v.railId.length > 0 &&
  (v.railVersion === undefined || isPositiveSafeInt(v.railVersion)) &&
  (v.parameters === undefined || isObj(v.parameters));

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

const NO_PARAMETER_PHASES = new Set([
  "vet-credentials",
  "negotiate-fixed-price",
  "commit-agreement",
  "commit-payee-bound-agreement",
  "deliver-storage-program",
  "deliver-entitlement",
  "deliver-attested-payload",
]);

const isSelectionRule = (v: unknown): boolean =>
  isOneOf(AUCTION_SELECTION, v) ||
  (isStr(v) && /^rule-ref:[0-9a-f]{64}:.+/.test(v));

/** DACS-1 §6.3.4 per-kind PhaseStep structural validation. */
export function isPhaseStep(v: unknown): v is PhaseStep {
  if (!isObj(v) || !isStr(v.kind) || !isOneOf(PHASE_TYPES, v.kind)) return false;
  if (NO_PARAMETER_PHASES.has(v.kind as string)) return v.parameters === undefined;
  if (v.kind === "rate") {
    return (
      v.parameters === undefined ||
      (isObj(v.parameters) &&
        (v.parameters.required === undefined || isBool(v.parameters.required)))
    );
  }
  if (!isObj(v.parameters)) return false;
  if (v.kind.startsWith("pay-")) {
    return isStr(v.parameters.rail) && v.parameters.rail.length > 0;
  }
  if (v.kind === "negotiate-rfq") {
    return (
      isSafeUint(v.parameters.maxTurns) &&
      v.parameters.maxTurns >= 2 &&
      isPositiveSafeInt(v.parameters.timeoutSec) &&
      isOptionalStr(v.parameters.channelSubnet) &&
      (v.parameters.rfqInitiator === undefined ||
        isOneOf(["buyer", "seller"], v.parameters.rfqInitiator)) &&
      (v.parameters.fixedPriceFallback === undefined ||
        isBool(v.parameters.fixedPriceFallback))
    );
  }
  if (
    v.kind === "negotiate-sealed-envelope" ||
    v.kind === "negotiate-sealed-envelope-procurement"
  ) {
    const mode = v.parameters.auctionMode;
    return (
      isSafeUint(v.parameters.commitDeadline) &&
      isSafeUint(v.parameters.revealWindow) &&
      v.parameters.revealWindow >= 60 &&
      isSelectionRule(v.parameters.selectionRule) &&
      isOptionalStr(v.parameters.channelSubnet) &&
      (v.kind === "negotiate-sealed-envelope"
        ? mode === undefined || mode === "demand"
        : mode === "procurement")
    );
  }
  return false;
}

/** DACS-1 §6.3.4 ListingTerms structural validation. */
export function isListingTerms(v: unknown): v is ListingTerms {
  return (
    isObj(v) &&
    isOptionalStr(v.termsOfServiceUrl) &&
    isOptionalStr(v.termsOfServiceHash) &&
    (v.jurisdictions === undefined ||
      (Array.isArray(v.jurisdictions) &&
        v.jurisdictions.every(
          (code) => isStr(code) && /^[A-Z]{2}$/.test(code),
        ))) &&
    (v.conflictOfLawsRule === undefined ||
      isOneOf(["buyer-jurisdiction", "seller-jurisdiction"], v.conflictOfLawsRule) ||
      (isStr(v.conflictOfLawsRule) &&
        /^rule-ref:.+/.test(v.conflictOfLawsRule))) &&
    (v.deadlineSecAfterCommit === undefined ||
      isPositiveSafeInt(v.deadlineSecAfterCommit)) &&
    (v.acceptanceModel === undefined || v.acceptanceModel === "auto-accept") &&
    (v.cancellationPolicy === undefined ||
      isOneOf(["none", "pre-commit", "with-fee"], v.cancellationPolicy)) &&
    (v.retentionYears === undefined || isPositiveSafeInt(v.retentionYears)) &&
    (v.transcriptDisclosurePolicy === undefined ||
      isOneOf(
        [
          "none",
          "encrypted-anchored-recommended",
          "encrypted-anchored-required",
        ],
        v.transcriptDisclosurePolicy,
      ))
  );
}

function pipelineIsCoherent(listing: Record<string, unknown>): boolean {
  const pipeline = listing.pipeline as PhaseStep[];
  const negotiate = pipeline
    .map((phase, index) => ({ phase, index }))
    .filter(({ phase }) => phase.kind.startsWith("negotiate-"));
  const commits = pipeline
    .map((phase, index) => ({ phase, index }))
    .filter(({ phase }) => phase.kind.startsWith("commit-"));
  if (
    negotiate.length !== 1 ||
    commits.length !== 1 ||
    commits[0]!.index !== negotiate[0]!.index + 1
  ) {
    return false; // DACS-3 §8.8 PS-1 / PS-2.
  }

  const priceKind = (listing.pricing as { kind: string }).kind;
  const pattern = negotiate[0]!.phase.kind;
  if (
    (pattern === "negotiate-fixed-price" &&
      !["fixed", "negotiable", "metered"].includes(priceKind)) ||
    (pattern === "negotiate-rfq" &&
      !["negotiable", "metered"].includes(priceKind)) ||
    ((pattern === "negotiate-sealed-envelope" ||
      pattern === "negotiate-sealed-envelope-procurement") &&
      priceKind !== "auction")
  ) {
    return false; // DACS-3 §8.8 PS-3.
  }

  if (!pipeline.some((phase) => phase.kind.startsWith("deliver-"))) {
    return false; // DACS-4 §9.9 PIPE-1.
  }
  return true;
}

function listingRailsAreBound(listing: Record<string, unknown>): boolean {
  const pipeline = listing.pipeline as PhaseStep[];
  const payPhases = pipeline.filter((phase) => phase.kind.startsWith("pay-"));
  const rails = listing.acceptedRails as PaymentRailRef[] | undefined;
  if (payPhases.length > 0) {
    if (!rails || rails.length === 0) return false; // DACS-1 §6.3.4 step 8.
    if (
      !payPhases.every((phase) =>
        rails.some((rail) => rail.railId === phase.parameters?.rail),
      )
    ) {
      return false; // DACS-1 §6.3.4 LRR-1 listing binding.
    }
  }
  if (rails) {
    try {
      const canonical = rails.map((rail) => canonicalize(rail));
      if (new Set(canonical).size !== canonical.length) return false; // LRR-1.
    } catch {
      return false;
    }
  }

  return true;
}

function isListingBody(
  v: unknown,
  options: { semanticPipeline: boolean },
): v is ListingDraft {
  if (!isObj(v)) return false;
  return (
    v.dacsVersion === "1" &&
    isPositiveSafeInt(v.listingVersion) &&
    isStr(v.listingId) &&
    /^[A-Za-z0-9._~-]{1,128}$/.test(v.listingId) &&
    (v.requiredCapabilities === undefined ||
      (Array.isArray(v.requiredCapabilities) &&
        v.requiredCapabilities.every((capability) =>
          isOneOf(["SR-1", "SR-2", "SR-3", "SR-4", "SR-5"], capability),
        ))) &&
    isObj(v.seller) &&
    isIdentityBundle(v.seller.identity) &&
    isStr(v.seller.displayName) &&
    v.seller.displayName.length <= 200 &&
    (v.seller.publicEndpoint === undefined ||
      isListingPublicEndpoint(v.seller.publicEndpoint)) &&
    isObj(v.offering) &&
    isStr(v.offering.title) &&
    v.offering.title.length <= 200 &&
    isStr(v.offering.description) &&
    v.offering.description.length <= 2_000 &&
    isStr(v.offering.category) &&
    v.offering.category.split(".").every((part) => part.length > 0) &&
    Array.isArray(v.offering.tags) &&
    v.offering.tags.length <= 16 &&
    v.offering.tags.every((tag) => isStr(tag) && tag.length <= 32) &&
    isDeliverableSpec(v.offering.deliverable) &&
    isOptionalStr(v.offering.extendedDescriptionUrl) &&
    isOptionalStr(v.offering.extendedDescriptionHash) &&
    isBundleRequirement(v.buyerRequirement) &&
    Array.isArray(v.pipeline) &&
    v.pipeline.length > 0 &&
    v.pipeline.every(isPhaseStep) &&
    isPricingSpec(v.pricing) &&
    (v.acceptedRails === undefined ||
      (Array.isArray(v.acceptedRails) &&
        v.acceptedRails.every(isPaymentRailRef))) &&
    isListingTerms(v.terms) &&
    isObj(v.validity) &&
    isSafeUint(v.validity.notBefore) &&
    (v.validity.notAfter === undefined ||
      (isSafeUint(v.validity.notAfter) &&
        v.validity.notAfter >= v.validity.notBefore)) &&
    (!options.semanticPipeline ||
      (pipelineIsCoherent(v) && listingRailsAreBound(v)))
  );
}

/** Unsigned DACS-1 §6.3.4 publication input; legacy shapes are refused. */
export function isListingDraft(v: unknown): v is ListingDraft {
  return (
    isObj(v) &&
    !("signature" in v) &&
    isListingBody(v, { semanticPipeline: true })
  );
}

function isListingWithPipelinePolicy(
  v: unknown,
  semanticPipeline: boolean,
): v is Listing {
  if (
    !isObj(v) ||
    !isComponentSignature(v.signature) ||
    !isCanonicalBase64Url(v.signature.value) ||
    !isListingBody(v, { semanticPipeline })
  ) {
    return false;
  }
  try {
    return Buffer.byteLength(canonicalize(v), "utf8") <= 16_384; // LR-2 size cap.
  } catch {
    return false;
  }
}

/** Signed normative DACS-1 §6.3.4 Listing conformance validator. */
export function isListing(v: unknown): v is Listing {
  return isListingWithPipelinePolicy(v, true);
}

/**
 * Structural wire envelope used by the ordered reader. Semantic pipeline and
 * rail binding are intentionally deferred to steps 7 and 8 respectively.
 */
export function isListingWireEnvelope(v: unknown): v is Listing {
  return isListingWithPipelinePolicy(v, false);
}

/** DACS-1 reader step 7, excluding the LRR-1 checks owned by step 8. */
export function isListingPipelineValid(v: Listing): boolean {
  return pipelineIsCoherent(v as unknown as Record<string, unknown>);
}

/** Historical reduced SDK shape, deliberately isolated to read compatibility. */
export function isLegacyMvpListing(v: unknown): v is LegacyMvpListing {
  if (!isObj(v)) return false;
  return (
    isStr(v.agentId) &&
    isStr(v.serviceId) &&
    isStr(v.name) &&
    isStr(v.description) &&
    Array.isArray(v.claimRequirements) &&
    v.claimRequirements.every(
      (claim) =>
        isObj(claim) && isStr(claim.claimRef) && isBool(claim.required),
    ) &&
    isStrArray(v.supportedNegotiation) &&
    isStrArray(v.supportedPaymentRails) &&
    isStrArray(v.supportedDelivery) &&
    (v.pricing === undefined ||
      (isPricingSpec(v.pricing) &&
        isObj(v.pricing) &&
        v.pricing.kind !== "metered")) &&
    (v.listingVersion === undefined || isPositiveSafeInt(v.listingVersion))
  );
}

/** Parse a signed artifact through the explicit normative/legacy read boundary. */
export function readListingArtifact(v: unknown): ReadableListing | null {
  if (isListing(v)) return { compatibility: "normative", listing: v };
  if (!isObj(v) || typeof v.signature !== "string") return null;
  const scope = stripSignature(v);
  return isLegacyMvpListing(scope)
    ? { compatibility: "legacy-mvp", listing: scope }
    : null;
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
  const baseValid =
    v.evidenceVersion === "1" &&
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
    v.bundleVersion === "1" &&
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

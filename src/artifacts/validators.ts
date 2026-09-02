import type {
  AgreementDocument,
  AgreementArtifact,
  AgreementParty,
  AgreementCommitmentRecord,
  AnchorReceipt,
  AnyAttestationBundle,
  AttestationRef,
  AttestationBundle,
  ChainTxRef,
  CommitmentRecord,
  BundleRequirement,
  BundleBinding,
  CompositeVerificationRecord,
  DeliverableSpec,
  EvidenceBoundFaultAttestationBundle,
  EvidenceBoundFaultBundleExtendedPointer,
  FaultBundleExtendedPointer,
  FaultAttestationBundle,
  FinalityCommitmentRecord,
  IdentityBundle,
  LegacyMvpListing,
  Listing,
  ListingDraft,
  ListingEnvelope,
  ListingTerms,
  PayeeBoundAgreementDocument,
  PaymentRailRef,
  PhaseStep,
  ReadableListing,
  RevocationBinding,
  RevocationMarker,
  SettlementEvidence,
  VerificationMethod,
  LegacyCompositeVerificationRecord,
  ReadableCompositeVerificationRecord,
  SupplementarySignal,
  VerificationWarning,
  VerifyResult,
  VerifyResultRef,
} from "./types.js";
import { canonicalizeDecimal } from "../canonical/decimal.js";
import {
  assertPositiveAmount,
  bundleAddress,
  canonicalize,
  stripSignature,
} from "../canonical/index.js";
import {
  isCanonicalBase64Url,
  isComponentSignature,
} from "./signatures.js";
import { sameCanonicalClaimIdentity } from "../identity/claimReference.js";

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
/**
 * Current signed artifacts are JSON wire records, not class instances or
 * prototype overlays. Requiring enumerable own data properties prevents a
 * value from passing a guard with fields that canonical JSON would omit.
 */
const hasExactWireKeys = (
  v: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  try {
    const prototype = Object.getPrototypeOf(v);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const allowed = [...required, ...optional];
    const ownKeys = Reflect.ownKeys(v);
    if (ownKeys.some((key) => typeof key !== "string")) return false;
    const keys = ownKeys as string[];
    if (!required.every((key) => keys.includes(key))) return false;
    if (!keys.every((key) => allowed.includes(key))) return false;
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      return (
        descriptor !== undefined &&
        descriptor.enumerable &&
        "value" in descriptor &&
        descriptor.value !== undefined
      );
    });
  } catch {
    return false;
  }
};
const isExactWireArray = (
  value: unknown,
  validate: (entry: unknown) => boolean,
): boolean => {
  if (!Array.isArray(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        !validate(descriptor.value)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
};

function isExactJsonValue(
  value: unknown,
  seen: WeakSet<object>,
): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return isExactWireArray(value, (entry) => isExactJsonValue(entry, seen));
    }
    if (!isObj(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return false;
    return (keys as string[]).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor !== undefined &&
        descriptor.enumerable === true &&
        "value" in descriptor &&
        descriptor.value !== undefined &&
        isExactJsonValue(descriptor.value, seen)
      );
    });
  } catch {
    return false;
  } finally {
    // Shared subtrees are serializable as repeated JSON values; only an object
    // that reappears on its current ancestor path is a cycle.
    seen.delete(value);
  }
}

/** Exact JSON object tree used by signed generic data/parameter fields. */
export function isExactJsonRecord(
  value: unknown,
): value is Record<string, unknown> {
  return isObj(value) && isExactJsonValue(value, new WeakSet<object>());
}
const isNonEmptyStr = (v: unknown): v is string => isStr(v) && v.length > 0;
/** CORE §B.1 canonical logical-address spelling for session identifiers. */
export const isCanonicalJobId = (v: unknown): v is string =>
  isStr(v) && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
/** Semantic method fields are exact signed values: reject blank/padded input. */
const isCanonicalNonBlankStr = (v: unknown): v is string =>
  isStr(v) && v.length > 0 && v.trim() === v;
const isNonNegativeInt = (v: unknown): v is number =>
  isNum(v) && Number.isInteger(v) && v >= 0;
const isNonNegativeSafeInt = (v: unknown): v is number =>
  isNum(v) && Number.isSafeInteger(v) && v >= 0;
const isPositiveSafeInt = (v: unknown): v is number =>
  isNum(v) && Number.isSafeInteger(v) && v > 0;
const isSha256 = (v: unknown): v is string =>
  isStr(v) && /^[0-9a-f]{64}$/.test(v);
const isCanonicalEvmEventHash = (v: unknown): v is string =>
  isStr(v) && /^[0-9a-f]{64}$/.test(v);
const isMinimalUnsignedDecimal = (v: unknown): v is string =>
  isStr(v) && /^(0|[1-9][0-9]*)$/.test(v);

const isIdentityBundleHash = (v: unknown): v is string =>
  isSha256(v) || (isStr(v) && /^sha256:[0-9a-f]{64}$/.test(v));
const hasValidOptionalComponentSignature = (
  v: Record<string, unknown>,
): boolean =>
  !Object.prototype.hasOwnProperty.call(v, "signatures") &&
  (!Object.prototype.hasOwnProperty.call(v, "signature") ||
    isComponentSignature(v.signature));

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
  "pay-alternative",
  "deliver-storage-program",
  "deliver-entitlement",
  "deliver-attested-payload",
  "rate",
] as const;
const PAYMENT_PHASES = PHASE_TYPES.filter(
  (phase) => phase.startsWith("pay-") && phase !== "pay-alternative",
);
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
const VERIFICATION_METHODS = [
  "verifiable-credential",
  "tlsnotary",
  "zktls",
  "consensus-backed-proxy",
  "oauth-attested",
  "evm-rpc",
  "domain-tls-control",
  "self-signed",
  "demos-gcr-domain",
] as const;

/** Minimal shared CF-2 gate; scheme-specific identifier rules remain method-specific. */
const isCanonicalClaimRef = (v: unknown): v is string => {
  if (!isNonEmptyStr(v) || v.normalize("NFC") !== v || /[\s\u0000-\u001f\u007f]/.test(v)) {
    return false;
  }
  const colon = v.indexOf(":");
  if (colon <= 0 || !/^[a-z][a-z0-9-]*$/.test(v.slice(0, colon))) return false;
  const remainder = v.slice(colon + 1);
  const question = remainder.indexOf("?");
  const identifier = question < 0 ? remainder : remainder.slice(0, question);
  if (!identifier) return false;
  if (question < 0) return true;
  const query = remainder.slice(question + 1);
  if (!query) return false;
  const keys: string[] = [];
  for (const parameter of query.split("&")) {
    const equals = parameter.indexOf("=");
    if (equals <= 0 || equals !== parameter.lastIndexOf("=")) return false;
    const key = parameter.slice(0, equals);
    const value = parameter.slice(equals + 1);
    if (
      !key ||
      /[:?]/.test(key) ||
      /[:?]/.test(value) ||
      /%(?![0-9A-F]{2})/.test(key) ||
      /%(?![0-9A-F]{2})/.test(value)
    ) {
      return false;
    }
    if (keys.includes(key)) return false;
    keys.push(key);
  }
  return keys.every((key, index) => index === 0 || keys[index - 1]! < key);
};

const isExactComponentSignature = (v: unknown): boolean =>
  isObj(v) &&
  hasExactWireKeys(v, ["algorithm", "signer", "value"]) &&
  isComponentSignature(v) &&
  isCanonicalClaimRef(v.signer);

/** Historical envelopes predate the current ClaimReference signer gate. */
const isExactLegacyComponentSignature = (v: unknown): boolean =>
  isObj(v) &&
  hasOnlyKeys(v, ["algorithm", "signer", "value"]) &&
  isComponentSignature(v);

const isCanonicalAmount = (value: unknown, allowZero = false): value is string => {
  if (!isStr(value)) return false;
  try {
    return canonicalizeDecimal(value) === value && (allowZero || value !== "0");
  } catch {
    return false;
  }
};

const isSafeUint = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
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
    (claim) =>
      isObj(claim) &&
      sameCanonicalClaimIdentity(claim.ref, v.presentedBy),
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
      return (
        isCanonicalNonBlankStr(v.endpoint) &&
        isOptionalStr(v.sessionTemplate)
      );
    case "zktls":
      return (
        isCanonicalNonBlankStr(v.provider) &&
        isCanonicalNonBlankStr(v.programId)
      );
    case "consensus-backed-proxy":
      return (
        isObj(v.endpoint) &&
        isOneOf(["GET", "POST"], v.endpoint.method) &&
        isCanonicalNonBlankStr(v.endpoint.urlTemplate) &&
        (v.endpoint.headers === undefined ||
          isRecordOfStrings(v.endpoint.headers)) &&
        isOptionalStr(v.endpoint.body)
      );
    case "oauth-attested":
      return (
        isCanonicalNonBlankStr(v.provider) &&
        Array.isArray(v.scopes) &&
        v.scopes.every(isCanonicalNonBlankStr) &&
        isSafeUint(v.maxTokenAgeSec)
      );
    case "evm-rpc":
      return (
        isPositiveSafeInt(v.chainId) &&
        isStr(v.contract) &&
        /^0x[0-9a-fA-F]{40}$/.test(v.contract) &&
        isCanonicalNonBlankStr(v.method) &&
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

export const isPaymentRailRef = (v: unknown): v is PaymentRailRef =>
  isObj(v) &&
  isStr(v.railId) &&
  v.railId.length > 0 &&
  (v.railVersion === undefined || isPositiveSafeInt(v.railVersion)) &&
  (v.parameters === undefined || isObj(v.parameters));

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
  if (v.kind === "pay-alternative") {
    return (
      hasExactWireKeys(v.parameters, ["alternatives"]) &&
      Array.isArray(v.parameters.alternatives) &&
      v.parameters.alternatives.length >= 2 &&
      v.parameters.alternatives.every(isPaymentRailRef)
    );
  }
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

/** DACS-1 §6.3.4 PhaseStep envelope before reader step 7 dispatches by kind. */
const isPhaseStepEnvelope = (v: unknown): boolean =>
  isObj(v) &&
  isStr(v.kind) &&
  v.kind.length > 0 &&
  (v.parameters === undefined || isObj(v.parameters));

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

function pipelineIsCoherent(
  listing: Record<string, unknown>,
  includeRailBinding = true,
): boolean {
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
  if (pipeline.some((phase) => phase.kind === "deliver-attested-payload")) {
    const offering = listing.offering;
    const deliverable = isObj(offering) ? offering.deliverable : undefined;
    if (
      !isObj(deliverable) ||
      deliverable.kind !== "attested-payload" ||
      !isVerificationMethod(deliverable.verificationMethod)
    ) {
      return false; // DACS-4 §9.6.3 DPA-1: reject before session/payment.
    }
  }
  if (!includeRailBinding) return true;

  const alternativePhases = pipeline.filter(
    (phase) => phase.kind === "pay-alternative",
  );
  const payPhases = pipeline.filter(
    (phase) => phase.kind.startsWith("pay-") && phase.kind !== "pay-alternative",
  );
  const rails = listing.acceptedRails as PaymentRailRef[] | undefined;
  if (alternativePhases.length > 0) {
    if (
      alternativePhases.length !== 1 ||
      payPhases.length !== 0 ||
      !rails ||
      rails.length === 0
    ) {
      return false;
    }
    const alternatives = alternativePhases[0]!.parameters?.alternatives;
    if (!Array.isArray(alternatives) || alternatives.length < 2) return false;
    try {
      const acceptedCanonical = rails.map((rail) => canonicalize(rail));
      const alternativeCanonical = alternatives.map((rail) => canonicalize(rail));
      if (
        new Set(alternativeCanonical).size !== alternativeCanonical.length ||
        alternativeCanonical.some(
          (entry) => acceptedCanonical.filter((value) => value === entry).length !== 1,
        )
      ) {
        return false;
      }
    } catch {
      return false;
    }
  } else if (payPhases.length > 0) {
    if (!rails || rails.length === 0) return false; // DACS-1 §6.3.4 step 8.
    if (
      !payPhases.every((phase) =>
        rails.some((rail) => rail.railId === phase.parameters?.rail),
      )
    ) {
      return false; // DACS-1 §6.3.4 LRR-1 listing binding.
    }
    const phaseKindByRail = new Map<string, string>();
    for (const phase of payPhases) {
      const railId = phase.parameters?.rail;
      if (typeof railId !== "string") return false;
      const priorKind = phaseKindByRail.get(railId);
      if (priorKind !== undefined && priorKind !== phase.kind) {
        return false; // LRR-4 local consequence; registry resolution stays separate.
      }
      phaseKindByRail.set(railId, phase.kind);
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

/**
 * DACS-1 §6.3.4 reader step 7 and the static DACS-4 §9.6.3 DPA-1
 * shape/coherence gate, excluding local method capability and step 8 rails.
 */
export function isListingPipelineValid(v: unknown): boolean {
  return (
    isObj(v) &&
    Array.isArray(v.pipeline) &&
    v.pipeline.length > 0 &&
    v.pipeline.every(isPhaseStep) &&
    isPricingSpec(v.pricing) &&
    pipelineIsCoherent(v, false)
  );
}

function isListingBody(
  v: unknown,
  requireSupportedVersion = true,
  requirePipelineSemantics = true,
): boolean {
  if (!isObj(v)) return false;
  return (
    (requireSupportedVersion
      ? v.dacsVersion === "1"
      : isStr(v.dacsVersion) && v.dacsVersion.length > 0) &&
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
    v.pipeline.every(
      requirePipelineSemantics ? isPhaseStep : isPhaseStepEnvelope,
    ) &&
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
    (!requirePipelineSemantics || pipelineIsCoherent(v))
  );
}

/** Unsigned DACS-1 §6.3.4 publication input; legacy shapes are refused. */
export function isListingDraft(v: unknown): v is ListingDraft {
  return isObj(v) && !("signature" in v) && isListingBody(v, true, true);
}

/**
 * DACS-1 §6.3.4 signed Listing envelope shape used by the ordered reader.
 * Runtime validity, cryptographic verification, revocation and authority reads
 * remain in their numbered steps. Signer authorization is deliberately
 * excluded so step 9 can still run after retaining an LRR `indeterminate`.
 */
export function isListingEnvelope(v: unknown): v is ListingEnvelope {
  if (
    !isObj(v) ||
    !isComponentSignature(v.signature) ||
    !isCanonicalBase64Url(v.signature.value) ||
    !isListingBody(v, false, false)
  ) {
    return false;
  }
  try {
    return Buffer.byteLength(canonicalize(v), "utf8") <= 16_384; // LR-2 size cap.
  } catch {
    return false;
  }
}

/** Signed normative DACS-1 §6.3.4 Listing structural validator. */
export function isListing(v: unknown): v is Listing {
  if (
    !isListingEnvelope(v) ||
    v.dacsVersion !== "1" ||
    !isListingPipelineValid(v) ||
    !pipelineIsCoherent(v as unknown as Record<string, unknown>, true)
  ) {
    return false;
  }
  return v.seller.identity.claims.some(
    (claim) => sameCanonicalClaimIdentity(claim.ref, v.signature.signer),
  ); // §6.3.4 ListingSignature signer authorization.
}

/** DACS-1 §6.3.4 RB-1 RevocationMarker structural validator. */
export function isRevocationMarker(v: unknown): v is RevocationMarker {
  return (
    isObj(v) &&
    isStr(v.listingId) &&
    /^[A-Za-z0-9._~-]{1,128}$/.test(v.listingId) &&
    isPositiveSafeInt(v.listingVersion) &&
    isStr(v.listingContentHash) &&
    /^[0-9a-f]{64}$/.test(v.listingContentHash) &&
    isSafeUint(v.revokedAt) &&
    isOptionalStr(v.reason) &&
    isComponentSignature(v.signature) &&
    isCanonicalBase64Url(v.signature.value)
  );
}

/** DACS-1 §6.3.4 RB-2 RevocationBinding structural validator. */
export function isRevocationBinding(v: unknown): v is RevocationBinding {
  return (
    isObj(v) &&
    isClaimRef(v.sellerPrimaryClaim) &&
    isStr(v.listingId) &&
    /^[A-Za-z0-9._~-]{1,128}$/.test(v.listingId) &&
    isPositiveSafeInt(v.listingVersion) &&
    isStr(v.listingContentHash) &&
    /^[0-9a-f]{64}$/.test(v.listingContentHash) &&
    isStr(v.logicalAddress) &&
    v.logicalAddress.length > 0 &&
    isObj(v.markerAnchor) &&
    isStr(v.markerAnchor.kind) &&
    v.markerAnchor.kind.length > 0 &&
    isStr(v.markerAnchor.locator) &&
    v.markerAnchor.locator.length > 0 &&
    isStr(v.markerContentHash) &&
    /^[0-9a-f]{64}$/.test(v.markerContentHash)
  );
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
  // Ordered DACS-1 validation owns semantic steps 2..9. Keep a structurally
  // readable normative envelope readable here so unsupported versions,
  // missing conditional DPA-1 methods, and unknown phase discriminators reach
  // their required ordered disposition instead of disappearing at parse time.
  if (isListingEnvelope(v)) return { compatibility: "normative", listing: v };
  if (!isObj(v) || typeof v.signature !== "string") return null;
  const scope = stripSignature(v);
  return isLegacyMvpListing(scope)
    ? { compatibility: "legacy-mvp", listing: scope }
    : null;
}

/** DACS-2 §7.5 exact current VerifyResult wire shape. */
export function isVerifyResult(v: unknown): v is VerifyResult {
  if (
    !isObj(v) ||
    !hasExactWireKeys(v, [
      "resultVersion",
      "scheme",
      "identifier",
      "recipeVersion",
      "method",
      "decision",
      "reason",
      "attestation",
      "fetchedAt",
      "verifiedAt",
      "signature",
    ], ["data", "validUntil"])
  ) {
    return false;
  }
  return (
    v.resultVersion === "1" &&
    isNonEmptyStr(v.scheme) &&
    /^[a-z][a-z0-9-]*$/.test(v.scheme) &&
    isNonEmptyStr(v.identifier) &&
    v.identifier.normalize("NFC") === v.identifier &&
    isPositiveSafeInt(v.recipeVersion) &&
    isOneOf(VERIFICATION_METHODS, v.method) &&
    isOneOf(VERIFICATION_DECISIONS, v.decision) &&
    isStr(v.reason) &&
    isAttestationRef(v.attestation) &&
    (v.data === undefined || isExactJsonRecord(v.data)) &&
    isNonNegativeSafeInt(v.fetchedAt) &&
    isNonNegativeSafeInt(v.verifiedAt) &&
    (v.validUntil === undefined || isNonNegativeSafeInt(v.validUntil)) &&
    isExactComponentSignature(v.signature)
  );
}

/** DACS-2 §7.7 exact reference to an anchored current VerifyResult. */
export function isVerifyResultRef(v: unknown): v is VerifyResultRef {
  if (!isObj(v) || !hasExactWireKeys(v, ["anchor", "contentHash", "recipeVersion"])) {
    return false;
  }
  return (
    isAttestationRef({ anchor: v.anchor, contentHash: v.contentHash }) &&
    isPositiveSafeInt(v.recipeVersion)
  );
}

/** DACS-2 §7.7 exact advisory supplementary-signal shape. */
export function isSupplementarySignal(v: unknown): v is SupplementarySignal {
  if (
    !isObj(v) ||
    !hasExactWireKeys(
      v,
      ["source", "signalType", "value", "observedAt"],
      ["attestation"],
    )
  ) {
    return false;
  }
  const valueIsSafeNumber =
    typeof v.value === "number" &&
    Number.isFinite(v.value) &&
    Math.abs(v.value) <= Number.MAX_SAFE_INTEGER;
  return (
    isNonEmptyStr(v.source) &&
    isNonEmptyStr(v.signalType) &&
    (isStr(v.value) || valueIsSafeNumber) &&
    isNonNegativeSafeInt(v.observedAt) &&
    (v.attestation === undefined || isAttestationRef(v.attestation)) &&
    (v.source !== "external" || isAttestationRef(v.attestation))
  );
}

/** DACS-2 §7.7 exact advisory warning shape. Unknown WN-6 codes stay advisory. */
export function isVerificationWarning(v: unknown): v is VerificationWarning {
  if (
    !isObj(v) ||
    !hasExactWireKeys(
      v,
      ["claimRef", "code", "retryable"],
      ["suggestedRetryAfterMs"],
    )
  ) {
    return false;
  }
  return (
    isCanonicalClaimRef(v.claimRef) &&
    isNonEmptyStr(v.code) &&
    isBool(v.retryable) &&
    (v.suggestedRetryAfterMs === undefined ||
      isNonNegativeSafeInt(v.suggestedRetryAfterMs))
  );
}

/** DACS-2 §7.7 exact current record; a legacy shape can never satisfy it. */
export function isCompositeVerificationRecord(
  v: unknown,
): v is CompositeVerificationRecord {
  if (
    !isObj(v) ||
    !hasExactWireKeys(v, [
      "recordVersion",
      "jobId",
      "evaluatedParty",
      "bundleHash",
      "requirementHash",
      "freshness",
      "supplementary",
      "dealSpecific",
      "overallDecision",
      "generatedAt",
      "signature",
    ], ["warnings"])
  ) {
    return false;
  }
  return (
    v.recordVersion === "1" &&
    isNonEmptyStr(v.jobId) &&
    isCanonicalClaimRef(v.evaluatedParty) &&
    isSha256(v.bundleHash) &&
    isSha256(v.requirementHash) &&
    isExactWireArray(v.freshness, isVerifyResultRef) &&
    isExactWireArray(v.supplementary, isSupplementarySignal) &&
    isExactWireArray(v.dealSpecific, isVerifyResultRef) &&
    isOneOf(VERIFICATION_DECISIONS, v.overallDecision) &&
    (v.warnings === undefined ||
      isExactWireArray(v.warnings, isVerificationWarning)) &&
    isNonNegativeSafeInt(v.generatedAt) &&
    isExactComponentSignature(v.signature)
  );
}

/** Explicit historical guard for the obsolete pre-§7.7 SDK record. */
export function isLegacyCompositeVerificationRecord(
  v: unknown,
): v is LegacyCompositeVerificationRecord {
  if (
    !isObj(v) ||
    !hasExactWireKeys(v, [
      "subject",
      "recipeId",
      "recipeVersion",
      "results",
      "decision",
      "verifiedAt",
    ], ["signature"])
  ) {
    return false;
  }
  return (
    isNonEmptyStr(v.subject) &&
    isNonEmptyStr(v.recipeId) &&
    isNonEmptyStr(v.recipeVersion) &&
    isExactWireArray(
      v.results,
      (result) =>
        isObj(result) &&
        hasExactWireKeys(result, [
          "claimRef",
          "method",
          "status",
        ], [
          "authority",
          "responseHash",
          "proof",
          "data",
        ]) &&
        isNonEmptyStr(result.claimRef) &&
        isNonEmptyStr(result.method) &&
        isOneOf(VERIFICATION_DECISIONS, result.status) &&
        (result.authority === undefined || isNonEmptyStr(result.authority)) &&
        (result.responseHash === undefined || isNonEmptyStr(result.responseHash)) &&
        (result.proof === undefined ||
          (isObj(result.proof) &&
            hasExactWireKeys(result.proof, ["kind", "value"]) &&
            isOneOf(["hash", "raw"], result.proof.kind) &&
            isNonEmptyStr(result.proof.value))) &&
        (result.data === undefined || isObj(result.data)),
    ) &&
    isOneOf(VERIFICATION_DECISIONS, v.decision) &&
    isNonEmptyStr(v.verifiedAt) &&
    (v.signature === undefined || isExactLegacyComponentSignature(v.signature))
  );
}

/** Parse through the explicit current/legacy boundary without shape conflation. */
export function readCompositeVerificationRecord(
  v: unknown,
): ReadableCompositeVerificationRecord | null {
  if (isCompositeVerificationRecord(v)) {
    return { compatibility: "current", record: v };
  }
  if (isLegacyCompositeVerificationRecord(v)) {
    return { compatibility: "legacy", record: v };
  }
  return null;
}

const isListingPin = (v: unknown): boolean =>
  isObj(v) &&
  hasOnlyKeys(v, ["listingId", "version", "contentHash"]) &&
  isNonEmptyStr(v.listingId) &&
  isPositiveSafeInt(v.version) &&
  isSha256(v.contentHash);

const isDeliverableRef = (v: unknown): boolean =>
  isObj(v) &&
  hasOnlyKeys(v, ["deliverableType", "hash", "schemaUrl"]) &&
  isOneOf(["storage-program", "entitlement", "attested-payload", "external"], v.deliverableType) &&
  isSha256(v.hash) &&
  (v.schemaUrl === undefined || isStr(v.schemaUrl));

const isAgreementParty = (v: unknown): v is AgreementParty =>
  isObj(v) &&
  hasOnlyKeys(v, ["role", "bundleHash", "primaryClaim", "vetRecordRef", "encryptionKey"]) &&
  isOneOf(["buyer", "seller", "bidder-non-winning"], v.role) &&
  isIdentityBundleHash(v.bundleHash) &&
  isClaimRef(v.primaryClaim) &&
  isAttestationRef(v.vetRecordRef) &&
  (v.encryptionKey === undefined || isNonEmptyStr(v.encryptionKey));

const isAgreementSignature = (v: unknown): boolean => {
  if (
    !isObj(v) ||
    !hasOnlyKeys(v, ["party", "algorithm", "value"]) ||
    !isClaimRef(v.party) ||
    !isOneOf(COMPONENT_SIGNATURE_ALGORITHMS, v.algorithm) ||
    !isCanonicalBase64Url(v.value)
  ) {
    return false;
  }
  // CORE §B.7 requires algorithm-specific validation after canonical wire
  // decoding. Ed25519 has a fixed 64-byte representation; formats for the
  // other registered algorithms are verified by their algorithm adapters.
  return (
    v.algorithm !== "ed25519" ||
    Buffer.from(v.value, "base64url").byteLength === 64
  );
};

const isFeeRecurrence = (v: unknown): boolean => {
  if (!isObj(v)) return false;
  const period = v.period;
  const validPeriod =
    isOneOf(["daily", "weekly", "monthly", "quarterly", "annual"], period) ||
    (isObj(period) &&
      hasOnlyKeys(period, ["everySeconds"]) &&
      isPositiveSafeInt(period.everySeconds));
  return (
    validPeriod &&
    (v.count === undefined || isPositiveSafeInt(v.count)) &&
    (v.until === undefined || isSafeUint(v.until)) &&
    !(v.count !== undefined && v.until !== undefined)
  );
};

const isFeeItem = (v: unknown): boolean =>
  isObj(v) &&
  isOneOf(["network", "platform", "processing", "spread", "subscription", "other"], v.kind) &&
  (v.collector === "substrate" || isClaimRef(v.collector)) &&
  (v.label === undefined || isStr(v.label)) &&
  ((v.fixed !== undefined && isPriceTerm(v.fixed) && v.rateBps === undefined) ||
    (v.fixed === undefined && isNonNegativeInt(v.rateBps))) &&
  (v.toleranceBps === undefined || isNonNegativeInt(v.toleranceBps)) &&
  (v.recurrence === undefined || isFeeRecurrence(v.recurrence));

const isFeeSchedule = (v: unknown, priceCurrency: string): boolean => {
  if (
    !isObj(v) ||
    !isOneOf(["inclusive", "exclusive"], v.priceBasis) ||
    !Array.isArray(v.items) ||
    !v.items.every(isFeeItem) ||
    !isPriceTerm(v.oneOffTotal) ||
    (v.oneOffTotal as { currency: string }).currency !== priceCurrency ||
    (v.recurringTotal !== undefined &&
      (!isPriceTerm(v.recurringTotal) ||
        (v.recurringTotal as { currency: string }).currency !== priceCurrency)) ||
    (v.minimumTermSeconds !== undefined && !isNonNegativeInt(v.minimumTermSeconds)) ||
    (v.earlyTerminationFee !== undefined && !isFeeItem(v.earlyTerminationFee)) ||
    (v.disclosureNote !== undefined && !isStr(v.disclosureNote))
  ) {
    return false;
  }
  const hasRecurringItem = v.items.some(
    (item) => isObj(item) && item.recurrence !== undefined,
  );
  return hasRecurringItem === (v.recurringTotal !== undefined);
};

const isPriceAnchor = (v: unknown): boolean =>
  isObj(v) &&
  isNonEmptyStr(v.asset) &&
  isNonEmptyStr(v.quoteCurrency) &&
  isCanonicalAmount(v.price) &&
  isAttestationRef(v.attestationRef) &&
  isSafeUint(v.observedAt) &&
  isNonEmptyStr(v.sourceUrl);

const hasAgreementCommon = (
  v: Record<string, unknown>,
  payeeBound: boolean,
): boolean => {
  const parties = v.parties;
  const terms = v.terms;
  if (
    Object.prototype.hasOwnProperty.call(v, "signature") ||
    !isCanonicalJobId(v.jobId) ||
    !isListingPin(v.listingRef) ||
    !Array.isArray(parties) ||
    parties.length < 2 ||
    !parties.every(isAgreementParty) ||
    !isObj(terms) ||
    !isDeliverableRef(terms.deliverable) ||
    !isPriceTerm(terms.price) ||
    (terms.meteredQuantity !== undefined &&
      (!isObj(terms.meteredQuantity) ||
        typeof terms.meteredQuantity.quantity !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(terms.meteredQuantity.quantity) ||
        !isNonEmptyStr(terms.meteredQuantity.unit))) ||
    (terms.rail !== undefined && !isPaymentRailRef(terms.rail)) ||
    (terms.priorPaymentDispositionRef !== undefined &&
      (!payeeBound || !isAttestationRef(terms.priorPaymentDispositionRef))) ||
    !isSafeUint(terms.deadline) ||
    (terms.priceAnchor !== undefined && !isPriceAnchor(terms.priceAnchor)) ||
    (terms.feeSchedule !== undefined &&
      !isFeeSchedule(
        terms.feeSchedule,
        (terms.price as { currency: string }).currency,
      )) ||
    (terms.additionalTerms !== undefined && !isObj(terms.additionalTerms)) ||
    !isOneOf(["fixed-price", "rfq", "sealed-envelope"], v.derivedFromPattern) ||
    !isSafeUint(v.generatedAt) ||
    (v.derivedFromChannel !== undefined &&
      (!isObj(v.derivedFromChannel) ||
        !hasOnlyKeys(v.derivedFromChannel, ["subnet", "lastMessageHash"]) ||
        !isNonEmptyStr(v.derivedFromChannel.subnet) ||
        !isSha256(v.derivedFromChannel.lastMessageHash))) ||
    !Array.isArray(v.signatures) ||
    v.signatures.length !== 2 ||
    !v.signatures.every(isAgreementSignature)
  ) {
    return false;
  }
  const buyer = parties.filter((party) => party.role === "buyer");
  const seller = parties.filter((party) => party.role === "seller");
  if (buyer.length !== 1 || seller.length !== 1) return false;
  const buyerClaim = buyer[0]!.primaryClaim;
  const sellerClaim = seller[0]!.primaryClaim;
  if (sameCanonicalClaimIdentity(buyerClaim, sellerClaim)) return false;
  const required = [buyerClaim, sellerClaim];
  const signers = (v.signatures as Array<Record<string, unknown>>).map(
    (signature) => signature.party as string,
  );
  if (
    required.some((claim) =>
      signers.filter((signer) =>
        sameCanonicalClaimIdentity(signer, claim)
      ).length !== 1
    ) ||
    signers.some((signer) => !required.some((claim) =>
      sameCanonicalClaimIdentity(signer, claim)
    ))
  ) {
    return false;
  }
  if (!payeeBound) {
    return !Object.prototype.hasOwnProperty.call(terms, "payoutBindings");
  }
  if (!Array.isArray(terms.payoutBindings)) {
    return false;
  }
  const keys = new Set<string>();
  for (const binding of terms.payoutBindings) {
    if (
      !isObj(binding) ||
      !hasOnlyKeys(binding, ["railId", "phaseIndex", "payeeAddress"]) ||
      !isNonEmptyStr(binding.railId) ||
      !isNonNegativeInt(binding.phaseIndex) ||
      !isNonEmptyStr(binding.payeeAddress)
    ) {
      return false;
    }
    const key = `${binding.railId}\u0000${binding.phaseIndex}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
};

export function isAgreementDocument(v: unknown): v is AgreementDocument {
  return (
    isObj(v) &&
    v.agreementVersion === "1" &&
    v.payeeBoundAgreementVersion === undefined &&
    hasAgreementCommon(v, false)
  );
}

export function isPayeeBoundAgreementDocument(
  v: unknown,
): v is PayeeBoundAgreementDocument {
  return (
    isObj(v) &&
    v.payeeBoundAgreementVersion === "1" &&
    v.agreementVersion === undefined &&
    hasAgreementCommon(v, true)
  );
}

export function isAgreementArtifact(v: unknown): v is AgreementArtifact {
  return isAgreementDocument(v) || isPayeeBoundAgreementDocument(v);
}

const isCommitmentParties = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  v.length >= 2 &&
  v.every(isClaimRef) &&
  new Set(v).size === v.length;

const hasCommitmentCommon = (v: Record<string, unknown>): boolean =>
  isNonEmptyStr(v.jobId) &&
  isSha256(v.agreementHash) &&
  isListingPin(v.listingRef) &&
  isCommitmentParties(v.parties) &&
  isOneOf(["fixed-price", "rfq", "sealed-envelope"], v.pattern);

/** DACS-3 §8.6 CA-9 historical read arm. Never use this type for new writes. */
export function isCommitmentRecord(v: unknown): v is CommitmentRecord {
  return (
    isObj(v) &&
    hasOnlyKeys(v, [
      "dacsVersion",
      "jobId",
      "agreementHash",
      "listingRef",
      "parties",
      "pattern",
      "committedAt",
    ]) &&
    v.dacsVersion === "1" &&
    v.finalityCommitmentVersion === undefined &&
    hasCommitmentCommon(v) &&
    isSafeUint(v.committedAt)
  );
}

/** Exact new-write DACS-3 §8.6 FinalityCommitmentRecord arm. */
export function isFinalityCommitmentRecord(
  v: unknown,
): v is FinalityCommitmentRecord {
  return (
    isObj(v) &&
    hasOnlyKeys(v, [
      "finalityCommitmentVersion",
      "jobId",
      "agreementHash",
      "listingRef",
      "parties",
      "pattern",
      "createdAt",
      "signature",
    ]) &&
    v.finalityCommitmentVersion === "1" &&
    v.dacsVersion === undefined &&
    hasCommitmentCommon(v) &&
    isSafeUint(v.createdAt) &&
    isComponentSignature(v.signature) &&
    isObj(v.signature) &&
    hasOnlyKeys(v.signature, ["algorithm", "signer", "value"]) &&
    isClaimRef(v.signature.signer)
  );
}

/**
 * Forward-readable DACS-3 v0.x finality arm.
 *
 * Producers use {@link isFinalityCommitmentRecord}'s exact shape. Readers may
 * accept additive optional fields from a later minor, but must reject the
 * legacy discriminator and validate every known action-bearing field. The
 * caller is responsible for hashing the complete received object (SIG-5).
 */
export function isReadableFinalityCommitmentRecord(
  v: unknown,
): v is FinalityCommitmentRecord {
  return (
    isObj(v) &&
    v.finalityCommitmentVersion === "1" &&
    !Object.prototype.hasOwnProperty.call(v, "dacsVersion") &&
    !Object.prototype.hasOwnProperty.call(v, "signatures") &&
    hasCommitmentCommon(v) &&
    isSafeUint(v.createdAt) &&
    isComponentSignature(v.signature) &&
    isObj(v.signature) &&
    isClaimRef(v.signature.signer)
  );
}

export function isAgreementCommitmentRecord(
  v: unknown,
): v is AgreementCommitmentRecord {
  return isCommitmentRecord(v) || isFinalityCommitmentRecord(v);
}

const ANCHOR_STATES = [
  "submitted",
  "accepted",
  "included",
  "finalized",
  "rejected",
  "dropped",
  "replaced",
  "expired",
  "reorged",
] as const;

const isAnchorTransactionRef = (
  v: unknown,
  exactShape: boolean,
): boolean =>
  isObj(v) &&
  (!exactShape || hasOnlyKeys(v, ["kind", "value"])) &&
  isNonEmptyStr(v.kind) &&
  isNonEmptyStr(v.value);

function isAnchorReceiptShape(v: unknown, exactShape: boolean): v is AnchorReceipt {
  if (
    !isObj(v) ||
    (exactShape &&
      !hasOnlyKeys(v, [
        "receiptVersion",
        "substrate",
        "finalityProfile",
        "logicalAddress",
        "nativeAddress",
        "contentHash",
        "transactionRef",
        "writer",
        "nonce",
        "state",
        "observationDisposition",
        "preservedReceiptHash",
        "observedAt",
        "blockRef",
        "replacementTransactionRef",
        "evidence",
      ])) ||
    v.receiptVersion !== "1" ||
    !isNonEmptyStr(v.substrate) ||
    !isNonEmptyStr(v.finalityProfile) ||
    !isNonEmptyStr(v.logicalAddress) ||
    !isNonEmptyStr(v.nativeAddress) ||
    !isSha256(v.contentHash) ||
    !isAnchorTransactionRef(v.transactionRef, exactShape) ||
    !isNonEmptyStr(v.writer) ||
    (v.nonce !== undefined && !isNonEmptyStr(v.nonce)) ||
    !isOneOf(ANCHOR_STATES, v.state) ||
    !isOneOf(["established", "indeterminate"], v.observationDisposition) ||
    !isSafeUint(v.observedAt) ||
    !isAnchorTransactionRef(v.evidence, exactShape) ||
    (v.replacementTransactionRef !== undefined &&
      !isAnchorTransactionRef(v.replacementTransactionRef, exactShape))
  ) {
    return false;
  }
  if (
    v.observationDisposition === "indeterminate" &&
    v.preservedReceiptHash === undefined
  ) {
    return false;
  }
  if (
    v.preservedReceiptHash !== undefined &&
    !isSha256(v.preservedReceiptHash)
  ) {
    return false;
  }
  if (v.blockRef !== undefined) {
    if (
      !isObj(v.blockRef) ||
      (exactShape && !hasOnlyKeys(v.blockRef, ["id", "height", "timestamp"])) ||
      !isNonEmptyStr(v.blockRef.id) ||
      (v.blockRef.height !== undefined &&
        (!isStr(v.blockRef.height) || !/^(0|[1-9][0-9]*)$/.test(v.blockRef.height))) ||
      (v.blockRef.timestamp !== undefined && !isSafeUint(v.blockRef.timestamp))
    ) {
      return false;
    }
  }
  return (
    !["included", "finalized"].includes(String(v.state)) ||
    v.blockRef !== undefined
  );
}

/** CORE §5.1 structural receipt gate; proof authentication remains binding-owned. */
export function isAnchorReceipt(v: unknown): v is AnchorReceipt {
  return isAnchorReceiptShape(v, true);
}

/**
 * Forward-readable CORE v0.x receipt gate. Unknown additive fields are retained
 * by the caller and authenticated by the binding-specific proof callback.
 */
export function isReadableAnchorReceipt(v: unknown): v is AnchorReceipt {
  return isAnchorReceiptShape(v, false);
}

/** DACS-2 §7.5.2 exact AttestationRef wire shape. */
export function isAttestationRef(v: unknown): v is AttestationRef {
  if (!isObj(v) || !hasExactWireKeys(v, ["anchor", "contentHash"], ["signer"])) {
    return false;
  }
  const anchor = v.anchor;
  return (
    isObj(anchor) &&
    hasExactWireKeys(anchor, ["kind", "locator"]) &&
    isOneOf(["storage-program", "ipfs", "https"], anchor.kind) &&
    isNonEmptyStr(anchor.locator) &&
    isSha256(v.contentHash) &&
    (v.signer === undefined || isCanonicalClaimRef(v.signer))
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
    case "evm-event":
      return (
        hasOnlyKeys(v, ["kind", "chainId", "txHash", "logIndex"]) &&
        isPositiveSafeInt(v.chainId) &&
        isCanonicalEvmEventHash(v.txHash) &&
        isNonNegativeSafeInt(v.logIndex) &&
        !Object.is(v.logIndex, -0)
      );
    case "solana":
      return (
        hasOnlyKeys(v, ["kind", "cluster", "signature"]) &&
        isOneOf(["mainnet", "devnet", "testnet"], v.cluster) &&
        isNonEmptyStr(v.signature)
      );
    case "solana-instruction":
      return (
        hasOnlyKeys(v, ["kind", "cluster", "signature", "instructionIndex"]) &&
        isOneOf(["mainnet", "devnet", "testnet"], v.cluster) &&
        // §9.3 wire validation remains structural (the Standard reference-shape
        // vector uses an illustrative signature). SB-1 projection performs the
        // required exact 64-byte Base58 decode before minting an identity.
        isNonEmptyStr(v.signature) &&
        isNonNegativeSafeInt(v.instructionIndex) &&
        !Object.is(v.instructionIndex, -0)
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
    case "x402-event":
      return (
        hasOnlyKeys(v, [
          "kind",
          "httpResource",
          "paymentReceiptHash",
          "settlementTxHash",
          "chainId",
          "logIndex",
          "protocolVersion",
        ]) &&
        isNonEmptyStr(v.httpResource) &&
        isSha256(v.paymentReceiptHash) &&
        isCanonicalEvmEventHash(v.settlementTxHash) &&
        isPositiveSafeInt(v.chainId) &&
        isNonNegativeSafeInt(v.logIndex) &&
        !Object.is(v.logIndex, -0) &&
        isMinimalUnsignedDecimal(v.protocolVersion)
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
    if (
      sameCanonicalClaimIdentity(orchestrator, buyer) ||
      sameCanonicalClaimIdentity(orchestrator, seller)
    ) return false;
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
  if (Object.prototype.hasOwnProperty.call(v, "signatures")) return false;
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
  if (v.reason !== undefined || !isSha256(v.deliverableContentHash)) {
    return false;
  }
  if (v.phase === "deliver-storage-program") {
    return isObj(anchor) && anchor.kind === "storage-program";
  }
  if (v.phase === "deliver-attested-payload") {
    return isObj(anchor) && isAttestationRef(v.attestationRef);
  }
  return true;
}

function hasBundleFields(
  v: Record<string, unknown>,
  partiesAreValid: (parties: unknown) => boolean,
  phaseKindIsValid: (kind: unknown) => boolean,
  allowRetryExhausted = false,
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
          ...(allowRetryExhausted ? ["retryExhausted"] : []),
        ]) &&
        isNonNegativeInt(ph.index) &&
        phaseKindIsValid(ph.kind) &&
        isOneOf(BUNDLE_PHASE_OUTCOMES, ph.outcome) &&
        (ph.errorClass === undefined || isOneOf(BUNDLE_PHASE_ERROR_CLASSES, ph.errorClass)) &&
        (ph.txRefs === undefined ||
          (Array.isArray(ph.txRefs) && ph.txRefs.every(isChainTxRef))) &&
        (ph.attestationRef === undefined || isAttestationRef(ph.attestationRef)) &&
        (!allowRetryExhausted ||
          ph.retryExhausted === undefined ||
          ph.retryExhausted === true),
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
        isCanonicalBase64Url(signature.value),
    )
  );
}

function hasNoUnknownBundleDiscriminator(v: Record<string, unknown>): boolean {
  const known = new Set([
    "bundleVersion",
    "faultBundleVersion",
    "evidenceBoundFaultBundleVersion",
  ]);
  return !Object.keys(v).some(
    (key) => key.endsWith("BundleVersion") && !known.has(key),
  );
}

export function isAttestationBundle(v: unknown): v is AttestationBundle {
  if (!isObj(v)) return false;
  return (
    hasNoUnknownBundleDiscriminator(v) &&
    v.bundleVersion === "1" &&
    v.faultBundleVersion === undefined &&
    v.evidenceBoundFaultBundleVersion === undefined &&
    v.faultedParty === undefined &&
    hasBundleFields(v, isBundleParties, isNonEmptyStr)
  );
}

export function isFaultAttestationBundle(v: unknown): v is FaultAttestationBundle {
  if (!isObj(v)) return false;
  return (
    hasNoUnknownBundleDiscriminator(v) &&
    v.faultBundleVersion === "1" &&
    v.bundleVersion === undefined &&
    v.evidenceBoundFaultBundleVersion === undefined &&
    isOneOf(["buyer", "seller", "orchestrator", "none"], v.faultedParty) &&
    hasBundleFields(v, isFaultBundleParties, (kind) =>
      isOneOf(PHASE_TYPES, kind),
    ) &&
    faultedPartyIsPermitted(v)
  );
}

export function isEvidenceBoundFaultAttestationBundle(
  v: unknown,
): v is EvidenceBoundFaultAttestationBundle {
  if (!isObj(v)) return false;
  return (
    hasNoUnknownBundleDiscriminator(v) &&
    v.evidenceBoundFaultBundleVersion === "1" &&
    v.bundleVersion === undefined &&
    v.faultBundleVersion === undefined &&
    isOneOf(["buyer", "seller", "orchestrator", "none"], v.faultedParty) &&
    hasBundleFields(
      v,
      isFaultBundleParties,
      (kind) => isOneOf(PHASE_TYPES, kind),
      true,
    ) &&
    faultedPartyIsPermitted(v)
  );
}

function isAbsoluteHttpsWithoutUserinfo(value: unknown): boolean {
  if (!isNonEmptyStr(value)) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname.length > 0 &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

export function isFaultBundleExtendedPointer(
  v: unknown,
): v is FaultBundleExtendedPointer {
  return (
    isObj(v) &&
    hasOnlyKeys(v, [
      "faultBundleVersion",
      "pointerKind",
      "fullBundleUrl",
      "fullBundleContentHash",
      "segmentRefs",
      "signature",
    ]) &&
    v.faultBundleVersion === "1" &&
    v.pointerKind === "extended" &&
    isStr(v.fullBundleUrl) &&
    isSha256(v.fullBundleContentHash) &&
    (v.segmentRefs === undefined ||
      (Array.isArray(v.segmentRefs) && v.segmentRefs.every(isAttestationRef))) &&
    isComponentSignature(v.signature)
  );
}

export function isEvidenceBoundFaultBundleExtendedPointer(
  v: unknown,
): v is EvidenceBoundFaultBundleExtendedPointer {
  return (
    isObj(v) &&
    hasOnlyKeys(v, [
      "evidenceBoundFaultBundleVersion",
      "pointerKind",
      "fullBundleUrl",
      "fullBundleContentHash",
      "segmentRefs",
      "signature",
    ]) &&
    v.evidenceBoundFaultBundleVersion === "1" &&
    v.pointerKind === "extended" &&
    isAbsoluteHttpsWithoutUserinfo(v.fullBundleUrl) &&
    isSha256(v.fullBundleContentHash) &&
    (v.segmentRefs === undefined ||
      (Array.isArray(v.segmentRefs) && v.segmentRefs.every(isAttestationRef))) &&
    isComponentSignature(v.signature)
  );
}

/** DACS-5 §10.4.2 BB-4/BB-5 structural and self-consistency gate. */
export function isBundleBinding(v: unknown): v is BundleBinding {
  return (
    isObj(v) &&
    hasOnlyKeys(v, [
      "bindingVersion",
      "jobId",
      "role",
      "logicalAddress",
      "nativeAddress",
      "bundleContentHash",
      "anchorTx",
      "signer",
      "signature",
    ]) &&
    v.bindingVersion === "1" &&
    isNonEmptyStr(v.jobId) &&
    isOneOf(["buyer", "seller", "orchestrator"], v.role) &&
    isNonEmptyStr(v.logicalAddress) &&
    isNonEmptyStr(v.nativeAddress) &&
    isSha256(v.bundleContentHash) &&
    (v.anchorTx === undefined || isNonEmptyStr(v.anchorTx)) &&
    isNonEmptyStr(v.signer) &&
    isComponentSignature(v.signature) &&
    v.signature.signer === v.signer &&
    v.logicalAddress ===
      bundleAddress(v.jobId as string, v.role as "buyer" | "seller" | "orchestrator")
  );
}

export function isAnyAttestationBundle(v: unknown): v is AnyAttestationBundle {
  return (
    isAttestationBundle(v) ||
    isFaultAttestationBundle(v) ||
    isEvidenceBoundFaultAttestationBundle(v)
  );
}

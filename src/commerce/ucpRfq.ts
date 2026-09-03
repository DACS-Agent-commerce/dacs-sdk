import type {
  AgreementArtifact,
  AgreementParty,
  PaymentRailRef,
  PriceTerm,
} from "../artifacts/types.js";
import {
  isAgreementArtifact,
  isAttestationRef,
  isIdentityBundle,
  isListing,
} from "../artifacts/validators.js";
import {
  canonicalize,
  canonicalizeDecimal,
  contentHash,
  sha256Hex,
  stripSignature,
} from "../canonical/index.js";
import { snapshotCanonicalJson } from "../canonical/snapshot.js";
import { DacsError } from "../errors.js";
import { identityBundleHash } from "../identity/bundle.js";
import { sameCanonicalClaimIdentity } from "../identity/claimReference.js";
import type {
  FixedPricePartyInput,
  UnsignedAgreementArtifact,
  VerifiedListingInput,
} from "../negotiate/fixedPrice.js";
import { requireCanonicalJobId } from "../negotiate/jobId.js";
import {
  DACS_UCP_X402_HANDLER,
  type UcpBusinessProfileSnapshot,
} from "./ucp.js";

export const DACS_UCP_X402_COMMERCE_PROFILE =
  "dacs-sdk:negotiated-ucp-x402:experimental-v1" as const;
export const DACS_UCP_COMPOSITION_TERM =
  "io.github.dacs-agent-commerce.ucp" as const;

export interface UcpRfqChannelBinding {
  /** Authenticated SR-4 channel/subnet identifier. */
  subnet: string;
  /** Hash of the accepted final ChannelMessage, not a public transcript. */
  lastMessageHash: string;
  turnCount: number;
}

export interface UcpRfqAgreementInput {
  jobId: string;
  verifiedListing: VerifiedListingInput;
  buyer: FixedPricePartyInput;
  seller: FixedPricePartyInput;
  selectedRail: PaymentRailRef;
  agreedPrice: PriceTerm;
  channel: UcpRfqChannelBinding;
  business: Readonly<UcpBusinessProfileSnapshot>;
  generatedAt: number;
}

const HASH_RE = /^[0-9a-f]{64}$/;
const isSafeTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;

function pow10(scale: number): bigint {
  return 10n ** BigInt(scale);
}

function decimalParts(value: string): { units: bigint; scale: number } {
  const canonical = canonicalizeDecimal(value);
  const [whole, fraction = ""] = canonical.split(".");
  return {
    units: BigInt(`${whole}${fraction}`),
    scale: fraction.length,
  };
}

function percentageParts(value: number): { units: bigint; scale: number } {
  if (!Number.isFinite(value) || value < 0 || Object.is(value, -0)) {
    throw new DacsError("RFQ percentage bounds must be finite and non-negative");
  }
  const rendered = String(value);
  if (rendered.includes("e") || rendered.includes("E")) {
    throw new DacsError("RFQ MVP does not accept exponent-form percentage bounds");
  }
  return decimalParts(rendered);
}

function roundedHalfUp(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

function renderScaled(units: bigint, scale: number): string {
  const digits = units.toString().padStart(scale + 1, "0");
  if (scale === 0) return digits;
  const split = digits.length - scale;
  return canonicalizeDecimal(`${digits.slice(0, split)}.${digits.slice(split)}`);
}

/** Exact DACS-3 §8.5.2 negotiable interval, rounded half-up at centre precision. */
export function ucpRfqPriceBand(input: {
  center: string;
  minPct: number;
  maxPct: number;
}): Readonly<{ lower: string; upper: string }> {
  const center = decimalParts(input.center);
  if (center.units <= 0n) throw new DacsError("RFQ band center must be positive");
  const min = percentageParts(input.minPct);
  const max = percentageParts(input.maxPct);
  if (input.minPct >= 100) {
    throw new DacsError("RFQ minimum percentage must keep the lower bound positive");
  }
  const minDenominator = 100n * pow10(min.scale);
  const maxDenominator = 100n * pow10(max.scale);
  const lowerFactor = minDenominator - min.units;
  const upperFactor = maxDenominator + max.units;
  const lowerUnits = roundedHalfUp(center.units * lowerFactor, minDenominator);
  const upperUnits = roundedHalfUp(center.units * upperFactor, maxDenominator);
  if (lowerUnits <= 0n) throw new DacsError("RFQ rounded lower bound must be positive");
  return Object.freeze({
    lower: renderScaled(lowerUnits, center.scale),
    upper: renderScaled(upperUnits, center.scale),
  });
}

function compareDecimal(left: string, right: string): number {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const scale = Math.max(a.scale, b.scale);
  const aUnits = a.units * pow10(scale - a.scale);
  const bUnits = b.units * pow10(scale - b.scale);
  return aUnits === bUnits ? 0 : aUnits < bUnits ? -1 : 1;
}

function requireAgreedPrice(
  price: Readonly<PriceTerm>,
  pricing: Extract<
    VerifiedListingInput["listing"]["pricing"],
    { kind: "negotiable" }
  >,
): PriceTerm {
  const amount = canonicalizeDecimal(price.amount);
  if (amount !== price.amount || amount === "0") {
    throw new DacsError("RFQ agreed price must be a positive CD-1 canonical decimal");
  }
  if (price.currency !== pricing.bandCenter.currency || price.unit !== pricing.bandCenter.unit) {
    throw new DacsError("RFQ agreed price currency/unit differs from the Listing band");
  }
  const band = ucpRfqPriceBand({
    center: pricing.bandCenter.amount,
    minPct: pricing.minPct,
    maxPct: pricing.maxPct,
  });
  if (compareDecimal(amount, band.lower) < 0 || compareDecimal(amount, band.upper) > 0) {
    throw new DacsError(
      `RFQ agreed price ${amount} is outside the inclusive ${band.lower}..${band.upper} band`,
    );
  }
  return {
    amount,
    currency: price.currency,
    ...(price.unit === undefined ? {} : { unit: price.unit }),
  };
}

function exact(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}

function requireParty(role: "buyer" | "seller", value: FixedPricePartyInput): AgreementParty {
  if (!isIdentityBundle(value.identityBundle)) {
    throw new DacsError(`${role} IdentityBundle is malformed`);
  }
  if (!isAttestationRef(value.vetRecordRef)) {
    throw new DacsError(`${role} DACS-2 Vet reference is malformed`);
  }
  return {
    role,
    bundleHash: identityBundleHash(value.identityBundle),
    primaryClaim: value.identityBundle.presentedBy,
    vetRecordRef: structuredClone(value.vetRecordRef),
    ...(value.encryptionKey === undefined ? {} : { encryptionKey: value.encryptionKey }),
  };
}

/**
 * Construct the signed-scope draft for a bilateral DACS RFQ that will execute
 * as a UCP checkout paid over the already-supported x402 rail.
 */
export function deriveUcpRfqAgreement(
  callerInput: UcpRfqAgreementInput,
): UnsignedAgreementArtifact {
  const input = snapshotCanonicalJson(callerInput, "UCP RFQ agreement input");
  requireCanonicalJobId(input.jobId);
  const { listing, pin } = input.verifiedListing;
  if (input.verifiedListing.disposition !== "verified" || !isListing(listing)) {
    throw new DacsError("UCP RFQ requires an explicitly verified normative Listing");
  }
  const listingHash = contentHash(listing as unknown as Record<string, unknown>);
  if (
    pin.listingId !== listing.listingId ||
    pin.version !== listing.listingVersion ||
    pin.contentHash !== listingHash
  ) {
    throw new DacsError("UCP RFQ Listing pin does not match the verified bytes");
  }
  if (!isSafeTime(input.generatedAt)) throw new DacsError("RFQ generatedAt must be unix ms");
  if (
    input.generatedAt < listing.validity.notBefore ||
    (listing.validity.notAfter !== undefined && input.generatedAt > listing.validity.notAfter)
  ) {
    throw new DacsError("UCP RFQ Listing is outside its validity window");
  }
  if (listing.pricing.kind !== "negotiable") {
    throw new DacsError("UCP RFQ MVP requires a negotiable Listing price band");
  }

  const negotiations = listing.pipeline
    .map((phase, index) => ({ phase, index }))
    .filter(({ phase }) => phase.kind.startsWith("negotiate-"));
  if (negotiations.length !== 1 || negotiations[0]!.phase.kind !== "negotiate-rfq") {
    throw new DacsError("UCP RFQ Listing must select exactly one negotiate-rfq phase");
  }
  const parameters = negotiations[0]!.phase.parameters;
  if (
    !parameters ||
    !Number.isSafeInteger(parameters.maxTurns) ||
    (parameters.maxTurns as number) < 2 ||
    !Number.isSafeInteger(parameters.timeoutSec) ||
    (parameters.timeoutSec as number) <= 0
  ) {
    throw new DacsError("UCP RFQ Listing requires maxTurns >= 2 and timeoutSec > 0");
  }
  const commits = listing.pipeline.filter((phase) => phase.kind.startsWith("commit-"));
  if (commits.length !== 1 || commits[0]!.kind !== "commit-agreement") {
    throw new DacsError("UCP RFQ MVP currently requires commit-agreement");
  }
  const payments = listing.pipeline
    .map((phase, index) => ({ phase, index }))
    .filter(({ phase }) => phase.kind.startsWith("pay-"));
  if (
    payments.length !== 1 ||
    payments[0]!.phase.kind !== "pay-x402" ||
    payments[0]!.phase.parameters?.rail !== input.selectedRail.railId ||
    !(listing.acceptedRails ?? []).some((rail) => exact(rail, input.selectedRail)) ||
    input.selectedRail.railId !== input.business.x402.config.railId
  ) {
    throw new DacsError("UCP RFQ requires one pay-x402 phase bound to the selected handler rail");
  }
  if (
    !nonEmpty(input.channel.subnet) ||
    !HASH_RE.test(input.channel.lastMessageHash) ||
    !Number.isSafeInteger(input.channel.turnCount) ||
    input.channel.turnCount < 2 ||
    input.channel.turnCount > (parameters.maxTurns as number)
  ) {
    throw new DacsError("UCP RFQ channel binding/turn count is malformed");
  }

  const buyer = requireParty("buyer", input.buyer);
  const seller = requireParty("seller", input.seller);
  if (
    !sameCanonicalClaimIdentity(seller.primaryClaim, listing.seller.identity.presentedBy) ||
    sameCanonicalClaimIdentity(buyer.primaryClaim, seller.primaryClaim)
  ) {
    throw new DacsError("UCP RFQ parties do not match the verified Listing");
  }
  const deadlineSec = listing.terms.deadlineSecAfterCommit;
  if (!Number.isSafeInteger(deadlineSec) || (deadlineSec ?? 0) <= 0) {
    throw new DacsError("UCP RFQ Listing requires a positive settlement deadline");
  }
  const deadline = input.generatedAt + deadlineSec! * 1_000;
  if (!Number.isSafeInteger(deadline)) throw new DacsError("UCP RFQ deadline overflow");

  const deliverable = listing.offering.deliverable;
  const price = requireAgreedPrice(input.agreedPrice, listing.pricing);
  if (price.currency !== input.business.x402.config.assetSymbol) {
    throw new DacsError("RFQ agreement currency must match the x402 settlement asset symbol");
  }
  return snapshotCanonicalJson({
    agreementVersion: "1",
    jobId: input.jobId,
    listingRef: { ...pin },
    parties: [buyer, seller],
    terms: {
      deliverable: {
        deliverableType: deliverable.kind,
        hash: sha256Hex(canonicalize(deliverable)),
        ...(deliverable.kind === "storage-program" && deliverable.schemaUrl !== undefined
          ? { schemaUrl: deliverable.schemaUrl }
          : {}),
      },
      price,
      rail: structuredClone(input.selectedRail),
      deadline,
      additionalTerms: {
        [DACS_UCP_COMPOSITION_TERM]: {
          profile: DACS_UCP_X402_COMMERCE_PROFILE,
          businessProfileUrl: input.business.profileUrl,
          businessProfileHash: input.business.profileHash,
          paymentHandler: {
            name: DACS_UCP_X402_HANDLER,
            id: input.business.x402.id,
            version: input.business.x402.version,
          },
        },
      },
    },
    derivedFromPattern: "rfq",
    derivedFromChannel: {
      subnet: input.channel.subnet,
      lastMessageHash: input.channel.lastMessageHash,
    },
    generatedAt: input.generatedAt,
  } satisfies UnsignedAgreementArtifact, "UCP RFQ agreement draft");
}

/** Re-derive and compare every signed agreement field before creating checkout. */
export function assertUcpRfqAgreementMatches(
  agreementValue: AgreementArtifact,
  derivation: UcpRfqAgreementInput,
): void {
  const agreement = snapshotCanonicalJson(agreementValue, "signed UCP RFQ agreement");
  if (!isAgreementArtifact(agreement) || agreement.derivedFromPattern !== "rfq") {
    throw new DacsError("UCP checkout requires a normative signed RFQ agreement");
  }
  const expected = deriveUcpRfqAgreement(derivation);
  if (!exact(stripSignature(agreement as unknown as Record<string, unknown>), expected)) {
    throw new DacsError("signed UCP RFQ agreement differs from the verified derivation");
  }
}

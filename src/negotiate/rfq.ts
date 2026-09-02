import { types as nodeTypes } from "node:util";

import type {
  AttestationRef,
  ListingPin,
  PriceTerm,
  PricingSpec,
  VerificationDecision,
} from "../artifacts/types.js";
import {
  isAttestationRef,
  isIdentityBundle,
  isListing,
} from "../artifacts/validators.js";
import {
  canonicalize,
  canonicalizeDecimal,
  contentHash,
  sha256Hex,
} from "../canonical/index.js";
import {
  snapshotCanonicalJson,
  snapshotCanonicalJsonRead,
} from "../canonical/snapshot.js";
import { DacsError } from "../errors.js";
import { identityBundleHash } from "../identity/bundle.js";
import {
  admitChannelMessage,
  type ChannelMessage,
  type ChannelMessageAdmissionFailure,
  type ChannelMessageSignatureVerifier,
} from "./channel.js";
import {
  deriveMeteredPriceTerm,
  type FixedPricePartyInput,
  type MeteredQuantityInput,
  type VerifiedListingInput,
} from "./fixedPrice.js";
import { requireCanonicalJobId } from "./jobId.js";

export type RfqPricing = Extract<
  PricingSpec,
  { kind: "negotiable" | "metered" }
>;

export type RfqPartyInput = FixedPricePartyInput;

export interface RfqPriceBand {
  minimum: PriceTerm;
  maximum: PriceTerm;
}

export interface RfqProposal {
  rfqProposalVersion: "1";
  price: PriceTerm;
  meteredQuantity?: MeteredQuantityInput;
}

export interface RfqProposalBody {
  rfqBodyVersion: "1";
  proposal: RfqProposal;
}

export interface RfqAcceptBody {
  rfqBodyVersion: "1";
  acceptedSequence: number;
}

export interface RfqTerminalBody {
  rfqBodyVersion: "1";
  reason?: string;
}

export type RfqTurnBody = RfqProposalBody | RfqAcceptBody | RfqTerminalBody;

export interface RfqSessionPartyBinding {
  primaryClaim: string;
  bundleHash: string;
  vetRecordRef: AttestationRef;
}

export type RfqSessionStatus =
  | "open"
  | "accepted"
  | "rejected"
  | "aborted"
  | "timed-out"
  | "max-turns";

export interface RfqStandingProposal extends RfqProposal {
  sequence: number;
  proposer: string;
}

/** Immutable, transport-neutral state suitable for an authenticated store. */
export interface RfqSessionState {
  rfqSessionVersion: "1";
  jobId: string;
  listingPin: ListingPin;
  channelId: string;
  buyer: RfqSessionPartyBinding;
  seller: RfqSessionPartyBinding;
  pricing: RfqPricing;
  initiator: "buyer" | "seller";
  maxTurns: number;
  timeoutMs: number;
  startedAt: number;
  awaitingSince: number;
  expectedSender: string;
  lastSequence: number;
  /** Canonical hash of the last admitted unsigned channel envelope. */
  lastMessageHash?: string;
  turnCount: number;
  status: RfqSessionStatus;
  standingProposal?: RfqStandingProposal;
  terminalReason?: string;
}

export interface OpenRfqSessionInput {
  jobId: string;
  verifiedListing: VerifiedListingInput;
  buyer: RfqPartyInput;
  seller: RfqPartyInput;
  channelId: string;
  startedAt: number;
}

export interface RfqChannelReservationInput {
  reservationVersion: "1";
  jobId: string;
  listingPin: ListingPin;
  channelId: string;
  members: readonly [string, string];
}

/**
 * Must durably and idempotently reserve the exact channelId. `pass` means this
 * same reservation owns it; `fail` means it belongs to a prior/different
 * session. Unavailable durable state is `indeterminate`, never a fresh pass.
 */
export type RfqChannelReservation = (
  input: Readonly<RfqChannelReservationInput>,
) => Promise<VerificationDecision> | VerificationDecision;

export type OpenRfqSessionResult =
  | { decision: "pass"; state: Readonly<RfqSessionState> }
  | ChannelMessageAdmissionFailure;

export type AdvanceRfqSessionResult =
  | { decision: "pass"; state: Readonly<RfqSessionState> }
  | ChannelMessageAdmissionFailure;

type DataRecord = Record<string, unknown>;

const DECISIONS: ReadonlySet<string> = new Set<VerificationDecision>([
  "pass",
  "fail",
  "indeterminate",
  "error",
]);

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function isRecord(value: unknown): value is DataRecord {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !nodeTypes.isProxy(value)
  );
}

function exactKeys(
  value: Readonly<DataRecord>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key)) &&
    optional.every((key) => !hasOwn(value, key) || value[key] !== undefined)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    value.normalize("NFC") === value
  );
}

function isSafeTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (
    value === null ||
    typeof value !== "object" ||
    seen.has(value as object) ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  seen.add(value as object);
  for (const child of Object.values(value as DataRecord))
    deepFreeze(child, seen);
  return Object.freeze(value);
}

function failure(
  decision: Exclude<VerificationDecision, "pass">,
  reason: string,
): ChannelMessageAdmissionFailure {
  return { decision, reason };
}

function decimalParts(value: string): { digits: bigint; scale: number } {
  const canonical = canonicalizeDecimal(value);
  const [whole = "0", fraction = ""] = canonical.split(".");
  return {
    digits: BigInt(`${whole}${fraction}`),
    scale: fraction.length,
  };
}

function numberAsPlainDecimal(value: number): string {
  const encoded = JSON.stringify(value);
  if (!encoded || encoded.startsWith("-") || !Number.isFinite(value)) {
    throw new DacsError("RFQ percentage must be a non-negative finite number");
  }
  if (!/[eE]/.test(encoded)) return canonicalizeDecimal(encoded);
  const [coefficient = "0", exponentText = "0"] = encoded
    .toLowerCase()
    .split("e");
  const exponent = Number(exponentText);
  const [whole = "0", fraction = ""] = coefficient.split(".");
  const digits = `${whole}${fraction}`;
  const decimalIndex = whole.length + exponent;
  const expanded =
    decimalIndex <= 0
      ? `0.${"0".repeat(-decimalIndex)}${digits}`
      : decimalIndex >= digits.length
        ? `${digits}${"0".repeat(decimalIndex - digits.length)}`
        : `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  return canonicalizeDecimal(expanded);
}

function canonicalAmountFromUnits(units: bigint, scale: number): string {
  const digits = units.toString().padStart(scale + 1, "0");
  if (scale === 0) return digits;
  const split = digits.length - scale;
  return canonicalizeDecimal(
    `${digits.slice(0, split)}.${digits.slice(split)}`,
  );
}

function roundedBandAmount(
  centerAmount: string,
  percentage: number,
  direction: "down" | "up",
): string {
  const center = decimalParts(centerAmount);
  const percent = decimalParts(numberAsPlainDecimal(percentage));
  const pctScale = 10n ** BigInt(percent.scale);
  const hundred = 100n * pctScale;
  const factor =
    direction === "down" ? hundred - percent.digits : hundred + percent.digits;
  if (factor <= 0n) {
    throw new DacsError("RFQ negotiable lower bound must remain positive");
  }
  const numerator = center.digits * factor;
  // Positive rational, rounded half-up to the centre amount's precision.
  const rounded = (2n * numerator + hundred) / (2n * hundred);
  if (rounded <= 0n) {
    throw new DacsError("RFQ negotiable lower bound must remain positive");
  }
  return canonicalAmountFromUnits(rounded, center.scale);
}

function compareDecimal(left: string, right: string): number {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const scale = Math.max(a.scale, b.scale);
  const leftUnits = a.digits * 10n ** BigInt(scale - a.scale);
  const rightUnits = b.digits * 10n ** BigInt(scale - b.scale);
  return leftUnits === rightUnits ? 0 : leftUnits < rightUnits ? -1 : 1;
}

/** DACS-3 §8.5.2 inclusive, centre-precision, half-up negotiable band. */
export function deriveRfqPriceBand(
  callerPricing: Extract<PricingSpec, { kind: "negotiable" }>,
): RfqPriceBand {
  const pricing = snapshotCanonicalJsonRead(
    callerPricing,
    "RFQ negotiable pricing",
  );
  if (
    pricing.kind !== "negotiable" ||
    !Number.isFinite(pricing.minPct) ||
    pricing.minPct < 0 ||
    pricing.minPct >= 100 ||
    !Number.isFinite(pricing.maxPct) ||
    pricing.maxPct < 0 ||
    !validatePriceTerm(pricing.bandCenter, false) ||
    canonicalizeDecimal(pricing.bandCenter.amount) !==
      pricing.bandCenter.amount ||
    pricing.bandCenter.amount === "0" ||
    !isNonEmptyString(pricing.bandCenter.currency)
  ) {
    throw new DacsError("RFQ negotiable pricing is malformed");
  }
  const common = {
    currency: pricing.bandCenter.currency,
    ...(pricing.bandCenter.unit === undefined
      ? {}
      : { unit: pricing.bandCenter.unit }),
  };
  return deepFreeze({
    minimum: {
      amount: roundedBandAmount(
        pricing.bandCenter.amount,
        pricing.minPct,
        "down",
      ),
      ...common,
    },
    maximum: {
      amount: roundedBandAmount(
        pricing.bandCenter.amount,
        pricing.maxPct,
        "up",
      ),
      ...common,
    },
  });
}

function validatePriceTerm(
  value: unknown,
  requireExactKeys = true,
): value is PriceTerm {
  if (
    !isRecord(value) ||
    (requireExactKeys && !exactKeys(value, ["amount", "currency"], ["unit"])) ||
    !isNonEmptyString(value.amount) ||
    !isNonEmptyString(value.currency) ||
    (value.unit !== undefined && !isNonEmptyString(value.unit))
  ) {
    return false;
  }
  try {
    return (
      canonicalizeDecimal(value.amount) === value.amount && value.amount !== "0"
    );
  } catch {
    return false;
  }
}

/** RFQ-3 client-side hard guard. Policy callbacks may narrow, never widen it. */
export function validateRfqProposal(
  callerProposal: unknown,
  callerPricing: RfqPricing,
): Readonly<RfqProposal> {
  const proposal = snapshotCanonicalJsonRead(callerProposal, "RFQ proposal");
  const pricing = snapshotCanonicalJsonRead(
    callerPricing,
    "RFQ pricing authority",
  );
  if (
    !isRecord(proposal) ||
    !exactKeys(
      proposal,
      ["rfqProposalVersion", "price"],
      ["meteredQuantity"],
    ) ||
    proposal.rfqProposalVersion !== "1" ||
    !validatePriceTerm(proposal.price)
  ) {
    throw new DacsError("RFQ proposal is malformed");
  }

  if (pricing.kind === "negotiable") {
    if (proposal.meteredQuantity !== undefined) {
      throw new DacsError("negotiable RFQ proposal must omit meteredQuantity");
    }
    const band = deriveRfqPriceBand(pricing);
    if (
      proposal.price.currency !== pricing.bandCenter.currency ||
      proposal.price.unit !== pricing.bandCenter.unit ||
      compareDecimal(proposal.price.amount, band.minimum.amount) < 0 ||
      compareDecimal(proposal.price.amount, band.maximum.amount) > 0
    ) {
      throw new DacsError(
        "RFQ proposal is outside the signed Listing price band (RFQ-3)",
      );
    }
  } else if (pricing.kind === "metered") {
    if (
      !isRecord(proposal.meteredQuantity) ||
      !exactKeys(proposal.meteredQuantity, ["quantity", "unit"])
    ) {
      throw new DacsError("metered RFQ proposal requires a canonical quantity");
    }
    const expected = deriveMeteredPriceTerm(
      pricing,
      proposal.meteredQuantity as unknown as MeteredQuantityInput,
    );
    if (canonicalize(proposal.price) !== canonicalize(expected)) {
      throw new DacsError(
        "metered RFQ proposal price does not match its Listing quantity",
      );
    }
  } else {
    throw new DacsError(
      "RFQ requires negotiable or metered Listing pricing (PS-3)",
    );
  }
  return deepFreeze(proposal as unknown as RfqProposal);
}

function partyBinding(
  role: "buyer" | "seller",
  input: RfqPartyInput,
): RfqSessionPartyBinding {
  if (!isIdentityBundle(input.identityBundle)) {
    throw new DacsError(`${role} IdentityBundle is not normative`);
  }
  if (!isAttestationRef(input.vetRecordRef)) {
    throw new DacsError(`${role} Vet reference is not normative`);
  }
  return {
    primaryClaim: input.identityBundle.presentedBy,
    bundleHash: identityBundleHash(input.identityBundle),
    vetRecordRef: structuredClone(input.vetRecordRef),
  };
}

function rfqAuthority(input: OpenRfqSessionInput): {
  listingPin: ListingPin;
  pricing: RfqPricing;
  initiator: "buyer" | "seller";
  maxTurns: number;
  timeoutMs: number;
  buyer: RfqSessionPartyBinding;
  seller: RfqSessionPartyBinding;
} {
  const { listing, pin } = input.verifiedListing;
  if (input.verifiedListing.disposition !== "verified" || !isListing(listing)) {
    throw new DacsError("RFQ requires an exact verified Listing");
  }
  requireCanonicalJobId(input.jobId);
  const exactPin: ListingPin = {
    listingId: listing.listingId,
    version: listing.listingVersion,
    contentHash: contentHash(listing as unknown as DataRecord),
  };
  if (canonicalize(pin) !== canonicalize(exactPin)) {
    throw new DacsError(
      "RFQ Listing pin does not match the exact verified bytes",
    );
  }
  if (
    input.startedAt < listing.validity.notBefore ||
    (listing.validity.notAfter !== undefined &&
      input.startedAt > listing.validity.notAfter)
  ) {
    throw new DacsError("RFQ Listing is outside its validity window");
  }
  const phases = listing.pipeline.filter((phase) =>
    phase.kind.startsWith("negotiate-"),
  );
  if (phases.length !== 1 || phases[0]!.kind !== "negotiate-rfq") {
    throw new DacsError(
      "Listing does not select exactly one RFQ negotiation phase",
    );
  }
  const params = phases[0]!.parameters;
  if (
    !isRecord(params) ||
    !Number.isSafeInteger(params.maxTurns) ||
    (params.maxTurns as number) < 2 ||
    !Number.isSafeInteger(params.timeoutSec) ||
    (params.timeoutSec as number) <= 0 ||
    (params.rfqInitiator !== undefined &&
      params.rfqInitiator !== "buyer" &&
      params.rfqInitiator !== "seller") ||
    (params.channelSubnet !== undefined &&
      params.channelSubnet !== input.channelId)
  ) {
    throw new DacsError("Listing RFQ parameters do not authorize this session");
  }
  if (
    listing.pricing.kind !== "negotiable" &&
    listing.pricing.kind !== "metered"
  ) {
    throw new DacsError(
      "RFQ requires negotiable or metered Listing pricing (PS-3)",
    );
  }
  const timeoutMs = (params.timeoutSec as number) * 1_000;
  if (!Number.isSafeInteger(timeoutMs))
    throw new DacsError("RFQ timeout overflows unix ms");
  const buyer = partyBinding("buyer", input.buyer);
  const seller = partyBinding("seller", input.seller);
  if (
    buyer.primaryClaim === seller.primaryClaim ||
    seller.primaryClaim !== listing.seller.identity.presentedBy
  ) {
    throw new DacsError(
      "RFQ members do not match the buyer/seller Listing authority",
    );
  }
  return {
    listingPin: exactPin,
    pricing: structuredClone(listing.pricing),
    initiator: params.rfqInitiator === "seller" ? "seller" : "buyer",
    maxTurns: params.maxTurns as number,
    timeoutMs,
    buyer,
    seller,
  };
}

/** Open a CH-6-reserved RFQ session from the exact signed Listing authority. */
export async function openRfqSession(
  callerInput: OpenRfqSessionInput,
  reserveChannelId: RfqChannelReservation,
): Promise<OpenRfqSessionResult> {
  if (
    typeof reserveChannelId !== "function" ||
    nodeTypes.isProxy(reserveChannelId)
  ) {
    return failure(
      "error",
      "durable RFQ channel reservation is unavailable or unsafe",
    );
  }
  let input: OpenRfqSessionInput;
  let authority: ReturnType<typeof rfqAuthority>;
  try {
    input = snapshotCanonicalJson(callerInput, "RFQ session input");
    if (!isNonEmptyString(input.channelId) || !isSafeTime(input.startedAt)) {
      return failure(
        "error",
        "RFQ session channelId or start time is malformed",
      );
    }
    authority = rfqAuthority(input);
  } catch {
    return failure(
      "error",
      "RFQ session authority is malformed or inconsistent",
    );
  }

  const reservation = deepFreeze({
    reservationVersion: "1" as const,
    jobId: input.jobId,
    listingPin: authority.listingPin,
    channelId: input.channelId,
    members: [authority.buyer.primaryClaim, authority.seller.primaryClaim] as [
      string,
      string,
    ],
  });
  let decision: unknown;
  try {
    decision = await reserveChannelId(reservation);
  } catch {
    return failure("error", "durable RFQ channel reservation failed");
  }
  if (typeof decision !== "string" || !DECISIONS.has(decision)) {
    return failure(
      "error",
      "durable RFQ channel reservation returned malformed state",
    );
  }
  if (decision !== "pass") {
    return failure(
      decision as Exclude<VerificationDecision, "pass">,
      `durable RFQ channel reservation returned ${decision}`,
    );
  }

  const initiator =
    authority.initiator === "buyer"
      ? authority.buyer.primaryClaim
      : authority.seller.primaryClaim;
  return {
    decision: "pass",
    state: deepFreeze({
      rfqSessionVersion: "1",
      jobId: input.jobId,
      listingPin: authority.listingPin,
      channelId: input.channelId,
      buyer: authority.buyer,
      seller: authority.seller,
      pricing: authority.pricing,
      initiator: authority.initiator,
      maxTurns: authority.maxTurns,
      timeoutMs: authority.timeoutMs,
      startedAt: input.startedAt,
      awaitingSince: input.startedAt,
      expectedSender: initiator,
      lastSequence: 0,
      turnCount: 0,
      status: "open",
    }),
  };
}

function parseProposalBody(
  body: unknown,
  pricing: RfqPricing,
): Readonly<RfqProposal> {
  if (
    !isRecord(body) ||
    !exactKeys(body, ["rfqBodyVersion", "proposal"]) ||
    body.rfqBodyVersion !== "1"
  ) {
    throw new DacsError("RFQ offer/counter body is malformed");
  }
  return validateRfqProposal(body.proposal, pricing);
}

function acceptedSequence(body: unknown): number {
  if (
    !isRecord(body) ||
    !exactKeys(body, ["rfqBodyVersion", "acceptedSequence"]) ||
    body.rfqBodyVersion !== "1" ||
    !Number.isSafeInteger(body.acceptedSequence) ||
    (body.acceptedSequence as number) < 1
  ) {
    throw new DacsError("RFQ accept body is malformed");
  }
  return body.acceptedSequence as number;
}

function terminalReason(body: unknown): string | undefined {
  if (
    !isRecord(body) ||
    !exactKeys(body, ["rfqBodyVersion"], ["reason"]) ||
    body.rfqBodyVersion !== "1" ||
    (body.reason !== undefined && !isNonEmptyString(body.reason))
  ) {
    throw new DacsError("RFQ terminal body is malformed");
  }
  return body.reason as string | undefined;
}

function otherMember(state: Readonly<RfqSessionState>, sender: string): string {
  return sender === state.buyer.primaryClaim
    ? state.seller.primaryClaim
    : state.buyer.primaryClaim;
}

function validListingPin(value: unknown): value is ListingPin {
  return (
    isRecord(value) &&
    exactKeys(value, ["listingId", "version", "contentHash"]) &&
    isNonEmptyString(value.listingId) &&
    Number.isSafeInteger(value.version) &&
    (value.version as number) >= 1 &&
    typeof value.contentHash === "string" &&
    /^[0-9a-f]{64}$/.test(value.contentHash)
  );
}

function validPartyBinding(value: unknown): value is RfqSessionPartyBinding {
  return (
    isRecord(value) &&
    exactKeys(value, ["primaryClaim", "bundleHash", "vetRecordRef"]) &&
    isNonEmptyString(value.primaryClaim) &&
    typeof value.bundleHash === "string" &&
    /^[0-9a-f]{64}$/.test(value.bundleHash) &&
    isAttestationRef(value.vetRecordRef)
  );
}

function validPricing(value: unknown): value is RfqPricing {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  try {
    if (value.kind === "negotiable") {
      deriveRfqPriceBand(
        value as unknown as Extract<PricingSpec, { kind: "negotiable" }>,
      );
      return true;
    }
    if (value.kind === "metered") {
      if (
        !isNonEmptyString(value.unit) ||
        !validatePriceTerm(value.unitPrice, false) ||
        (value.minTotal !== undefined &&
          !validatePriceTerm(value.minTotal, false))
      ) {
        return false;
      }
      deriveMeteredPriceTerm(
        value as unknown as Extract<PricingSpec, { kind: "metered" }>,
        { quantity: "1", unit: value.unit },
      );
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function validStandingProposal(
  value: unknown,
  state: Readonly<RfqSessionState>,
): value is RfqStandingProposal {
  if (
    !isRecord(value) ||
    !exactKeys(
      value,
      ["rfqProposalVersion", "price", "sequence", "proposer"],
      ["meteredQuantity"],
    ) ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    (value.sequence as number) > state.lastSequence ||
    (value.proposer !== state.buyer.primaryClaim &&
      value.proposer !== state.seller.primaryClaim)
  ) {
    return false;
  }
  try {
    validateRfqProposal(
      {
        rfqProposalVersion: value.rfqProposalVersion,
        price: value.price,
        ...(value.meteredQuantity === undefined
          ? {}
          : { meteredQuantity: value.meteredQuantity }),
      },
      state.pricing,
    );
    return true;
  } catch {
    return false;
  }
}

function validateStoredState(value: RfqSessionState): boolean {
  if (
    !isRecord(value) ||
    !exactKeys(
      value,
      [
        "rfqSessionVersion",
        "jobId",
        "listingPin",
        "channelId",
        "buyer",
        "seller",
        "pricing",
        "initiator",
        "maxTurns",
        "timeoutMs",
        "startedAt",
        "awaitingSince",
        "expectedSender",
        "lastSequence",
        "turnCount",
        "status",
      ],
      ["lastMessageHash", "standingProposal", "terminalReason"],
    )
  ) {
    return false;
  }
  try {
    requireCanonicalJobId(value.jobId);
  } catch {
    return false;
  }
  if (
    value.rfqSessionVersion !== "1" ||
    !validListingPin(value.listingPin) ||
    !isNonEmptyString(value.channelId) ||
    !validPartyBinding(value.buyer) ||
    !validPartyBinding(value.seller) ||
    !validPricing(value.pricing)
  ) {
    return false;
  }
  if (
    !isSafeTime(value.startedAt) ||
    !isSafeTime(value.awaitingSince) ||
    value.awaitingSince < value.startedAt ||
    !Number.isSafeInteger(value.lastSequence) ||
    value.lastSequence < 0 ||
    !Number.isSafeInteger(value.turnCount) ||
    value.turnCount < 0 ||
    !Number.isSafeInteger(value.maxTurns) ||
    value.maxTurns < 2 ||
    !Number.isSafeInteger(value.timeoutMs) ||
    value.timeoutMs <= 0 ||
    value.turnCount > value.maxTurns ||
    value.lastSequence < value.turnCount
  ) {
    return false;
  }
  if (
    (value.lastSequence === 0 && value.lastMessageHash !== undefined) ||
    (value.lastSequence > 0 &&
      (typeof value.lastMessageHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(value.lastMessageHash)))
  ) {
    return false;
  }
  if (
    value.buyer.primaryClaim === value.seller.primaryClaim ||
    (value.initiator !== "buyer" && value.initiator !== "seller") ||
    (value.expectedSender === value.buyer.primaryClaim ||
      value.expectedSender === value.seller.primaryClaim) === false ||
    !(
      [
        "open",
        "accepted",
        "rejected",
        "aborted",
        "timed-out",
        "max-turns",
      ] as const
    ).includes(value.status) ||
    (value.terminalReason !== undefined &&
      !isNonEmptyString(value.terminalReason))
  ) {
    return false;
  }
  const standing = value.standingProposal;
  if (standing !== undefined && !validStandingProposal(standing, value)) {
    return false;
  }
  const initiatorClaim =
    value.initiator === "buyer"
      ? value.buyer.primaryClaim
      : value.seller.primaryClaim;
  if (value.turnCount === 0) {
    if (
      value.lastSequence !== 0 ||
      standing !== undefined ||
      value.expectedSender !== initiatorClaim
    ) {
      return false;
    }
    return value.status === "open"
      ? value.terminalReason === undefined
      : value.status === "timed-out" && value.terminalReason !== undefined;
  }
  if (standing === undefined) return false;
  if (value.status === "open") {
    return (
      value.turnCount < value.maxTurns &&
      standing.sequence === value.lastSequence &&
      value.expectedSender === otherMember(value, standing.proposer) &&
      value.terminalReason === undefined
    );
  }
  if (value.status === "max-turns") {
    return (
      value.turnCount === value.maxTurns &&
      standing.sequence === value.lastSequence &&
      value.terminalReason !== undefined
    );
  }
  if (value.status === "accepted") {
    return (
      value.turnCount >= 2 &&
      value.lastSequence > standing.sequence &&
      value.terminalReason !== undefined
    );
  }
  if (value.status === "timed-out") {
    return value.terminalReason !== undefined;
  }
  return value.lastSequence > standing.sequence;
}

/**
 * Apply one authenticated RFQ turn. `receivedAt` is the trusted local receipt
 * clock used for RFQ-4; the sender-controlled `sentAt` never extends timeout.
 */
export async function advanceRfqSession<TSignature = unknown>(
  callerState: RfqSessionState,
  candidateMessage: unknown,
  receivedAt: number,
  verifySignature: ChannelMessageSignatureVerifier<RfqTurnBody, TSignature>,
): Promise<AdvanceRfqSessionResult> {
  let state: RfqSessionState;
  try {
    state = snapshotCanonicalJsonRead(callerState, "RFQ session state");
  } catch {
    return failure("error", "RFQ session state is malformed");
  }
  if (
    !validateStoredState(state) ||
    !isSafeTime(receivedAt) ||
    receivedAt < state.awaitingSince
  ) {
    return failure(
      "error",
      "RFQ session state or trusted receipt time is inconsistent",
    );
  }
  if (state.status !== "open") {
    return failure("fail", "RFQ session is already terminal");
  }
  const timeoutAt = state.awaitingSince + state.timeoutMs;
  if (!Number.isSafeInteger(timeoutAt)) {
    return failure("error", "RFQ timeout boundary overflows unix ms");
  }
  if (receivedAt > timeoutAt) {
    return {
      decision: "pass",
      state: deepFreeze({
        ...state,
        status: "timed-out",
        terminalReason: "RFQ turn timeout elapsed (RFQ-4)",
      }),
    };
  }

  const admitted = await admitChannelMessage<RfqTurnBody, TSignature>(
    candidateMessage,
    {
      sessionChannelId: state.channelId,
      lastSequence: state.lastSequence,
      priorChannelIds: [],
    },
    verifySignature,
  );
  if (admitted.decision !== "pass") return admitted;
  const message = admitted.message as Readonly<
    ChannelMessage<RfqTurnBody, TSignature>
  >;
  if (message.sender !== state.expectedSender) {
    return failure("fail", "RFQ turn is signed by the wrong member");
  }
  if (
    state.standingProposal !== undefined &&
    message.refs?.repliesTo !== undefined &&
    message.refs.repliesTo !== state.standingProposal.sequence
  ) {
    return failure("fail", "RFQ reply does not bind the standing proposal");
  }

  const turnCount = state.turnCount + 1;
  try {
    if (state.turnCount === 0 || message.type === "counter") {
      if (state.turnCount === 0 && message.type !== "offer") {
        return failure("fail", "the RFQ initiator must send the first offer");
      }
      if (state.turnCount > 0 && message.type !== "counter") {
        return failure(
          "fail",
          "an open RFQ proposal must be followed by a counter or terminal turn",
        );
      }
      const proposal = parseProposalBody(message.body, state.pricing);
      const standingProposal = deepFreeze({
        ...proposal,
        sequence: message.sequence,
        proposer: message.sender,
      });
      if (turnCount >= state.maxTurns) {
        return {
          decision: "pass",
          state: deepFreeze({
            ...state,
            lastSequence: message.sequence,
            lastMessageHash: admitted.envelopeHash,
            turnCount,
            standingProposal,
            status: "max-turns",
            terminalReason: "RFQ maxTurns reached without acceptance (RFQ-1)",
          }),
        };
      }
      return {
        decision: "pass",
        state: deepFreeze({
          ...state,
          lastSequence: message.sequence,
          lastMessageHash: admitted.envelopeHash,
          turnCount,
          standingProposal,
          awaitingSince: receivedAt,
          expectedSender: otherMember(state, message.sender),
        }),
      };
    }

    if (message.type === "accept") {
      if (
        state.standingProposal === undefined ||
        acceptedSequence(message.body) !== state.standingProposal.sequence
      ) {
        return failure(
          "fail",
          "RFQ acceptance does not bind the standing proposal",
        );
      }
      return {
        decision: "pass",
        state: deepFreeze({
          ...state,
          lastSequence: message.sequence,
          lastMessageHash: admitted.envelopeHash,
          turnCount,
          status: "accepted",
          terminalReason: "standing RFQ proposal accepted",
        }),
      };
    }
    if (message.type === "reject" || message.type === "abort") {
      const reason = terminalReason(message.body);
      return {
        decision: "pass",
        state: deepFreeze({
          ...state,
          lastSequence: message.sequence,
          lastMessageHash: admitted.envelopeHash,
          turnCount,
          status: message.type === "reject" ? "rejected" : "aborted",
          ...(reason === undefined ? {} : { terminalReason: reason }),
        }),
      };
    }
    return failure(
      "fail",
      `message type ${message.type} is not valid in an RFQ session`,
    );
  } catch (cause) {
    return failure(
      "fail",
      cause instanceof DacsError
        ? cause.message
        : "RFQ turn body or pricing is invalid",
    );
  }
}

/** Stable content key for an authenticated durable RFQ state checkpoint. */
export function rfqSessionCheckpointHash(state: RfqSessionState): string {
  const snapshot = snapshotCanonicalJsonRead(state, "RFQ session checkpoint");
  if (!validateStoredState(snapshot)) {
    throw new DacsError("RFQ session checkpoint is malformed");
  }
  return sha256Hex(canonicalize(snapshot));
}

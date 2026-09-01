import { types as nodeTypes } from "node:util";

import {
  canonicalize,
  canonicalizeDecimal,
  contentHash,
  sha256Hex,
} from "../canonical/index.js";
import { snapshotCanonicalJson } from "../canonical/snapshot.js";
import { signedBytes } from "../crypto/index.js";
import { DacsError } from "../errors.js";
import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import {
  COMPONENT_SIGNATURE_ALGORITHMS,
  isCanonicalBase64Url,
} from "../artifacts/signatures.js";
import type {
  AgreementArtifact,
  AgreementDocument,
  AgreementParty,
  AgreementSignature,
  AttestationRef,
  ComponentSignatureAlgorithm,
  IdentityBundle,
  Listing,
  ListingPin,
  PayeeBoundAgreementDocument,
  PaymentRailRef,
  PayoutBinding,
  PriceTerm,
  PricingSpec,
} from "../artifacts/types.js";
import {
  isAgreementArtifact,
  isAttestationRef,
  isIdentityBundle,
  isListing,
} from "../artifacts/validators.js";
import { identityBundleHash } from "../identity/bundle.js";
import { requireCanonicalJobId } from "./jobId.js";

export interface VerifiedListingInput {
  /** Overall DACS-1 §6.3.4 disposition after signature, validity, and revocation. */
  disposition: "verified";
  /** A Listing whose structure, signature, validity, and revocation were verified. */
  listing: Listing;
  /** Exact LR-1 tuple derived from those same immutable Listing bytes. */
  pin: ListingPin;
}

export interface FixedPricePartyInput {
  /** Exact DACS-1 bundle whose normative bundle_hash becomes AgreementParty.bundleHash. */
  identityBundle: IdentityBundle;
  /**
   * Anchored DACS-2 Vet result for this party. The agreement retains this
   * reference; recursive DACS-5 verification resolves its subject/bundle
   * binding rather than treating the ref itself as the IdentityBundle hash.
   */
  vetRecordRef: AttestationRef;
  encryptionKey?: string;
}

export interface FixedPriceAgreementInput {
  jobId: string;
  verifiedListing: VerifiedListingInput;
  buyer: FixedPricePartyInput;
  seller: FixedPricePartyInput;
  /** Required iff the pipeline contains a pay phase; matched as a complete ref. */
  selectedRail?: PaymentRailRef;
  /** Required only for `commit-payee-bound-agreement`. */
  payoutBindings?: PayoutBinding[];
  /** Required exactly when the pinned Listing uses metered pricing. */
  meteredQuantity?: MeteredQuantityInput;
  /** Provisional signing-time clock; #99 re-checks deadlines at finalized commit. */
  generatedAt: number;
}

export interface MeteredQuantityInput {
  /** Canonical unsigned whole-unit count: `"0"` or `[1-9][0-9]*`. */
  quantity: string;
  /** Must exactly equal the pinned metered Listing unit. */
  unit: string;
}

export type UnsignedAgreementArtifact =
  | Omit<AgreementDocument, "signatures">
  | Omit<PayeeBoundAgreementDocument, "signatures">;

export interface AgreementSigner {
  party: string;
  algorithm: ComponentSignatureAlgorithm;
  sign: (
    bytes: Uint8Array,
    context: Pick<AgreementSignature, "party" | "algorithm">,
  ) => Promise<Uint8Array | string> | Uint8Array | string;
}

interface CapturedAgreementSigner {
  party: string;
  algorithm: ComponentSignatureAlgorithm;
  sign: AgreementSigner["sign"];
}

const isSafeTime = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

type MeteredPricing = Extract<PricingSpec, { kind: "metered" }>;

function decimalParts(value: string): { whole: string; fraction: string } {
  const [whole = "0", fraction = ""] = value.split(".");
  return { whole, fraction };
}

function compareCanonicalDecimal(left: string, right: string): number {
  const a = decimalParts(left);
  const b = decimalParts(right);
  if (a.whole.length !== b.whole.length) {
    return a.whole.length < b.whole.length ? -1 : 1;
  }
  if (a.whole !== b.whole) return a.whole < b.whole ? -1 : 1;
  const width = Math.max(a.fraction.length, b.fraction.length);
  const aFraction = a.fraction.padEnd(width, "0");
  const bFraction = b.fraction.padEnd(width, "0");
  return aFraction === bFraction ? 0 : aFraction < bFraction ? -1 : 1;
}

function multiplyCanonicalDecimal(amount: string, quantity: string): string {
  const { whole, fraction } = decimalParts(amount);
  const digits = `${whole}${fraction}`;
  const product = BigInt(digits) * BigInt(quantity);
  if (fraction.length === 0) return product.toString();
  const padded = product.toString().padStart(fraction.length + 1, "0");
  const split = padded.length - fraction.length;
  return canonicalizeDecimal(`${padded.slice(0, split)}.${padded.slice(split)}`);
}

function requirePositiveCanonicalAmount(value: string, label: string): void {
  if (canonicalizeDecimal(value) !== value || value === "0") {
    throw new DacsError(`${label} must be a positive CD-1 canonical decimal`);
  }
}

/** MTR-4 whole-unit ceil without floating-point arithmetic. */
export function ceilMeteredQuantity(rawMeasurement: string): string {
  const canonical = canonicalizeDecimal(rawMeasurement);
  const { whole, fraction } = decimalParts(canonical);
  return fraction.length === 0 ? whole : (BigInt(whole) + 1n).toString();
}

/** Recompute the signed metered total from exact Listing terms and quantity. */
export function deriveMeteredPriceTerm(
  callerPricing: MeteredPricing,
  callerQuantity: MeteredQuantityInput,
): PriceTerm {
  const { pricing, quantity } = snapshotCanonicalJson(
    { pricing: callerPricing, quantity: callerQuantity },
    "metered price input",
  );
  if (
    pricing.kind !== "metered" ||
    typeof pricing.unit !== "string" ||
    pricing.unit.length === 0
  ) {
    throw new DacsError("metered pricing requires a non-empty unit");
  }
  requirePositiveCanonicalAmount(pricing.unitPrice.amount, "metered unitPrice");
  if (
    typeof pricing.unitPrice.currency !== "string" ||
    pricing.unitPrice.currency.length === 0
  ) {
    throw new DacsError("metered unitPrice currency must be non-empty");
  }
  if (
    typeof quantity.quantity !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(quantity.quantity)
  ) {
    throw new DacsError(
      "non-canonical-metered-quantity: quantity must be an unsigned canonical integer",
    );
  }
  if (quantity.unit !== pricing.unit) {
    throw new DacsError(
      "metered-unit-mismatch: metered quantity unit differs from the Listing",
    );
  }
  if (pricing.minTotal !== undefined) {
    requirePositiveCanonicalAmount(pricing.minTotal.amount, "metered minTotal");
    if (pricing.minTotal.currency !== pricing.unitPrice.currency) {
      throw new DacsError(
        "min-total-currency-mismatch: metered minimum uses a different currency",
      );
    }
  }

  const product = multiplyCanonicalDecimal(
    pricing.unitPrice.amount,
    quantity.quantity,
  );
  const minimum = pricing.minTotal?.amount;
  const amount =
    minimum !== undefined && compareCanonicalDecimal(minimum, product) > 0
      ? minimum
      : product;
  if (amount === "0") {
    throw new DacsError(
      "metered total must be positive when no minimum total applies",
    );
  }
  return { amount, currency: pricing.unitPrice.currency };
}

const railEquals = (a: PaymentRailRef, b: PaymentRailRef): boolean =>
  canonicalize(a) === canonicalize(b);

function agreementParty(
  role: "buyer" | "seller",
  input: FixedPricePartyInput,
): AgreementParty {
  if (!isIdentityBundle(input.identityBundle)) {
    throw new DacsError(`${role} IdentityBundle is not a normative DACS-1 bundle`);
  }
  if (!isAttestationRef(input.vetRecordRef)) {
    throw new DacsError(`${role} vetRecordRef is not a DACS-2 §7.5.2 AttestationRef`);
  }
  if (input.encryptionKey !== undefined && input.encryptionKey.length === 0) {
    throw new DacsError(`${role} encryptionKey must be non-empty when present`);
  }
  return {
    role,
    bundleHash: identityBundleHash(input.identityBundle),
    primaryClaim: input.identityBundle.presentedBy,
    vetRecordRef: structuredClone(input.vetRecordRef),
    ...(input.encryptionKey === undefined
      ? {}
      : { encryptionKey: input.encryptionKey }),
  };
}

function requirePipeline(listing: Listing): {
  commitment: "commit-agreement" | "commit-payee-bound-agreement";
  paymentIndexes: number[];
} {
  const negotiate = listing.pipeline
    .map((phase, index) => ({ phase, index }))
    .filter(({ phase }) => phase.kind.startsWith("negotiate-"));
  if (
    negotiate.length !== 1 ||
    negotiate[0]!.phase.kind !== "negotiate-fixed-price"
  ) {
    throw new DacsError(
      "fixed-price core requires exactly one negotiate-fixed-price phase (PS-1)",
    );
  }
  const commitments = listing.pipeline
    .map((phase, index) => ({ phase, index }))
    .filter(({ phase }) => phase.kind.startsWith("commit-"));
  if (
    commitments.length !== 1 ||
    commitments[0]!.index !== negotiate[0]!.index + 1 ||
    (commitments[0]!.phase.kind !== "commit-agreement" &&
      commitments[0]!.phase.kind !== "commit-payee-bound-agreement")
  ) {
    throw new DacsError(
      "exactly one supported agreement commitment must immediately follow negotiation (PS-2)",
    );
  }
  return {
    commitment: commitments[0]!.phase.kind,
    paymentIndexes: listing.pipeline
      .map((phase, index) => (phase.kind.startsWith("pay-") ? index : -1))
      .filter((index) => index >= 0),
  };
}

function requireRail(
  listing: Listing,
  selected: PaymentRailRef | undefined,
  paymentIndexes: readonly number[],
): PaymentRailRef | undefined {
  if (paymentIndexes.length === 0) {
    if (selected !== undefined) {
      throw new DacsError("a zero-pay pipeline MUST omit agreement terms.rail");
    }
    return undefined;
  }
  if (!selected) throw new DacsError("a pay pipeline requires one selected rail");
  if (!(listing.acceptedRails ?? []).some((rail) => railEquals(rail, selected))) {
    throw new DacsError("selected rail is not an exact acceptedRails member");
  }
  for (const index of paymentIndexes) {
    const phase = listing.pipeline[index]!;
    if (phase.parameters?.rail !== selected.railId) {
      throw new DacsError(
        `pay phase ${index} does not bind selected rail ${selected.railId}`,
      );
    }
  }
  return structuredClone(selected);
}

function requirePayoutBindings(
  selectedRail: PaymentRailRef | undefined,
  paymentIndexes: readonly number[],
  bindings: readonly PayoutBinding[] | undefined,
): PayoutBinding[] {
  if (!selectedRail || paymentIndexes.length === 0) {
    if ((bindings?.length ?? 0) !== 0) {
      throw new DacsError("payoutBindings cannot target a non-pay phase");
    }
    return [];
  }
  if (!bindings || bindings.length !== paymentIndexes.length) {
    throw new DacsError("payoutBindings must cover every pay phase exactly once");
  }
  const expected = new Set(
    paymentIndexes.map((index) => `${selectedRail.railId}\u0000${index}`),
  );
  const seen = new Set<string>();
  for (const binding of bindings) {
    const key = `${binding.railId}\u0000${binding.phaseIndex}`;
    if (
      !expected.has(key) ||
      seen.has(key) ||
      !Number.isSafeInteger(binding.phaseIndex) ||
      binding.phaseIndex < 0 ||
      typeof binding.payeeAddress !== "string" ||
      binding.payeeAddress.length === 0
    ) {
      throw new DacsError("payoutBindings contain a missing, duplicate, or extra pay tuple");
    }
    seen.add(key);
  }
  return bindings.map((binding) => ({ ...binding }));
}

/**
 * DACS-3 §8.4.1/§8.5 pure derivation. No transport, anchor, payment, or private
 * repository dependency is involved. Caller-selected price/delivery never enter
 * this boundary: every signed term is derived from the exact pinned Listing.
 */
export function deriveFixedPriceAgreement(
  callerInput: FixedPriceAgreementInput,
): UnsignedAgreementArtifact {
  const input = snapshotCanonicalJson(
    callerInput,
    "fixed-price agreement input",
  );
  const { listing, pin } = input.verifiedListing;
  if (input.verifiedListing.disposition !== "verified") {
    throw new DacsError("fixed-price agreement requires a verified Listing disposition");
  }
  if (!isListing(listing)) throw new DacsError("verified Listing has invalid wire shape");
  requireCanonicalJobId(input.jobId);
  if (
    pin.listingId !== listing.listingId ||
    pin.version !== listing.listingVersion ||
    pin.contentHash !==
      contentHash(listing as unknown as Record<string, unknown>)
  ) {
    throw new DacsError("Listing pin does not match the exact verified Listing bytes (LR-1)");
  }
  if (!isSafeTime(input.generatedAt)) throw new DacsError("generatedAt must be unix ms");
  if (
    input.generatedAt < listing.validity.notBefore ||
    (listing.validity.notAfter !== undefined &&
      input.generatedAt > listing.validity.notAfter)
  ) {
    throw new DacsError("Listing is outside its validity window");
  }
  if (listing.terms.acceptanceModel === "auto-accept") {
    throw new DacsError(
      "auto-accept requires its verified commitment and live instance-signature path",
    );
  }
  const deadlineSec = listing.terms.deadlineSecAfterCommit;
  if (!Number.isSafeInteger(deadlineSec) || (deadlineSec ?? 0) <= 0) {
    throw new DacsError("deadlineSecAfterCommit must be a positive integer");
  }
  // DACS-1 §6.3.4 validity and DACS-3 generatedAt/deadline use unix ms;
  // deadlineSecAfterCommit is the one seconds-valued input and is converted once.
  const deadline = input.generatedAt + deadlineSec! * 1_000;
  if (!Number.isSafeInteger(deadline)) throw new DacsError("derived deadline overflows unix ms");

  // PS-3: fixed-price acceptance over a negotiable Listing selects the exact
  // band centre. It cannot pick an arbitrary price merely within the band.
  let price: PriceTerm;
  let meteredQuantity: MeteredQuantityInput | undefined;
  if (listing.pricing.kind === "fixed" || listing.pricing.kind === "negotiable") {
    if (input.meteredQuantity !== undefined) {
      throw new DacsError(
        "unexpected-metered-quantity: non-metered agreement must omit meteredQuantity",
      );
    }
    price =
      listing.pricing.kind === "fixed"
        ? listing.pricing.price
        : listing.pricing.bandCenter;
  } else if (listing.pricing.kind === "metered") {
    if (input.meteredQuantity === undefined) {
      throw new DacsError(
        "missing-metered-quantity: metered agreement requires meteredQuantity",
      );
    }
    meteredQuantity = { ...input.meteredQuantity };
    price = deriveMeteredPriceTerm(listing.pricing, meteredQuantity);
  } else {
    throw new DacsError(
      `${listing.pricing.kind} pricing is unsupported by the fixed-price handler`,
    );
  }
  const { commitment, paymentIndexes } = requirePipeline(listing);
  const rail = requireRail(listing, input.selectedRail, paymentIndexes);
  const buyer = agreementParty("buyer", input.buyer);
  const seller = agreementParty("seller", input.seller);
  if (seller.primaryClaim !== listing.seller.identity.presentedBy) {
    throw new DacsError("seller bundle primary claim does not match the pinned Listing");
  }
  if (buyer.primaryClaim === seller.primaryClaim) {
    throw new DacsError("buyer and seller primary claims must be distinct");
  }
  const deliverable = listing.offering.deliverable;
  const terms = {
    deliverable: {
      deliverableType: deliverable.kind,
      // DACS-4 §9.3 hashes the complete anchored DeliverableSpec. Do not use
      // contentHash(): its artifact helper intentionally strips fields named
      // `signature`/`signatures`, which are ordinary additive data here.
      hash: sha256Hex(canonicalize(deliverable)),
      ...(deliverable.kind === "storage-program" && deliverable.schemaUrl !== undefined
        ? { schemaUrl: deliverable.schemaUrl }
        : {}),
    },
    price: structuredClone(price),
    ...(meteredQuantity === undefined
      ? {}
      : { meteredQuantity: { ...meteredQuantity } }),
    ...(rail === undefined ? {} : { rail }),
    deadline,
  };
  const common = {
    jobId: input.jobId,
    listingRef: { ...pin },
    parties: [buyer, seller],
    derivedFromPattern: "fixed-price" as const,
    generatedAt: input.generatedAt,
  };
  if (commitment === "commit-agreement") {
    if ((input.payoutBindings?.length ?? 0) !== 0) {
      throw new DacsError("AgreementDocument MUST NOT carry payoutBindings");
    }
    return { agreementVersion: "1", ...common, terms };
  }
  return {
    payeeBoundAgreementVersion: "1",
    ...common,
    terms: {
      ...terms,
      payoutBindings: requirePayoutBindings(
        rail,
        paymentIndexes,
        input.payoutBindings,
      ),
    },
  };
}

function encodedSignature(
  value: unknown,
  algorithm: ComponentSignatureAlgorithm,
): string {
  if (typeof value !== "string" && !(value instanceof Uint8Array)) {
    throw new DacsError(
      "agreement signer must return signature bytes or a canonical unpadded Base64URL string",
    );
  }
  const encoded =
    typeof value === "string" ? value : Buffer.from(value).toString("base64url");
  if (!isCanonicalBase64Url(encoded)) {
    throw new DacsError("agreement signer returned a non-canonical Base64URL value");
  }
  // CORE §B.7 leaves decoded length algorithm-specific. Ed25519 is the only
  // AgreementSignature algorithm whose exact 64-byte contract is implemented
  // by this SDK; do not guess encodings for the other registered algorithms.
  if (
    algorithm === "ed25519" &&
    Buffer.from(encoded, "base64url").byteLength !== 64
  ) {
    throw new DacsError("ed25519 agreement signatures must be exactly 64 bytes");
  }
  return encoded;
}

function captureAgreementSigner(
  signer: AgreementSigner,
  label: "buyer" | "seller",
): CapturedAgreementSigner {
  if (
    signer === null ||
    typeof signer !== "object" ||
    nodeTypes.isProxy(signer) ||
    (Object.getPrototypeOf(signer) !== Object.prototype &&
      Object.getPrototypeOf(signer) !== null)
  ) {
    throw new DacsError(`${label} agreement signer must be a plain data object`);
  }
  const ownDataProperty = (key: keyof AgreementSigner): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(signer, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new DacsError(
        `${label} agreement signer.${key} must be an enumerable data property`,
      );
    }
    return descriptor.value;
  };
  const party = ownDataProperty("party");
  const algorithm = ownDataProperty("algorithm");
  const signCandidate = ownDataProperty("sign");
  const algorithms: ReadonlySet<unknown> = new Set(
    COMPONENT_SIGNATURE_ALGORITHMS,
  );
  if (typeof party !== "string" || party.length === 0 || party.trim() !== party) {
    throw new DacsError(`${label} agreement signer party must be a non-empty string`);
  }
  if (!algorithms.has(algorithm)) {
    throw new DacsError(`${label} agreement signer uses an unsupported algorithm`);
  }
  if (typeof signCandidate !== "function" || nodeTypes.isProxy(signCandidate)) {
    throw new DacsError(
      `${label} agreement signer callback must be a non-Proxy function`,
    );
  }
  return {
    party: party as string,
    algorithm: algorithm as ComponentSignatureAlgorithm,
    sign: Function.prototype.bind.call(
      signCandidate,
      signer,
    ) as AgreementSigner["sign"],
  };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function collectAgreementSignature(
  signer: CapturedAgreementSigner,
  expectedBytes: Uint8Array,
): Promise<AgreementSignature> {
  const context = { party: signer.party, algorithm: signer.algorithm };
  const callbackBytes = Uint8Array.from(expectedBytes);
  const callbackContext = { ...context };
  const rawValue = await signer.sign(callbackBytes, callbackContext);
  if (
    !sameBytes(callbackBytes, expectedBytes) ||
    callbackContext.party !== context.party ||
    callbackContext.algorithm !== context.algorithm ||
    Object.keys(callbackContext).length !== 2
  ) {
    throw new DacsError("agreement signer must not mutate its signing inputs");
  }
  return {
    ...context,
    value: encodedSignature(rawValue, signer.algorithm),
  };
}

async function signAgreementArtifactForPattern(
  callerDraft: UnsignedAgreementArtifact,
  buyerSigner: AgreementSigner,
  sellerSigner: AgreementSigner,
  expectedPattern?: AgreementArtifact["derivedFromPattern"],
): Promise<AgreementArtifact> {
  // Capture both option bags and preserve method-style `this` before the first
  // access to callerDraft. A draft accessor must not be able to switch signer
  // identity or implementation selected for this operation.
  const capturedBuyerSigner = captureAgreementSigner(buyerSigner, "buyer");
  const capturedSellerSigner = captureAgreementSigner(sellerSigner, "seller");
  const draft = snapshotCanonicalJson(callerDraft, "unsigned agreement draft");
  requireCanonicalJobId(draft.jobId, "agreement jobId");
  if (
    expectedPattern !== undefined &&
    draft.derivedFromPattern !== expectedPattern
  ) {
    throw new DacsError(
      `agreement draft is not derived from ${expectedPattern}`,
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(draft, "signatures") ||
    Object.prototype.hasOwnProperty.call(draft, "signature")
  ) {
    throw new DacsError("agreement draft must not carry signature fields");
  }
  const buyer = draft.parties.find((party) => party.role === "buyer")?.primaryClaim;
  const seller = draft.parties.find((party) => party.role === "seller")?.primaryClaim;
  if (
    !buyer ||
    !seller ||
    capturedBuyerSigner.party !== buyer ||
    capturedSellerSigner.party !== seller
  ) {
    throw new DacsError("agreement signers do not match the bound buyer and seller claims");
  }
  const placeholder = Buffer.alloc(64).toString("base64url");
  if (
    !isAgreementArtifact({
      ...draft,
      signatures: [
        {
          party: buyer,
          algorithm: capturedBuyerSigner.algorithm,
          value: placeholder,
        },
        {
          party: seller,
          algorithm: capturedSellerSigner.algorithm,
          value: placeholder,
        },
      ],
    })
  ) {
    throw new DacsError("agreement draft failed exact DACS-3 §8.5 validation");
  }
  const separator =
    "agreementVersion" in draft
      ? ARTIFACT_SEPARATORS.AgreementDocument
      : ARTIFACT_SEPARATORS.PayeeBoundAgreementDocument;
  const bytes = signedBytes(
    separator,
    contentHash(draft as unknown as Record<string, unknown>),
  );
  const signatures: AgreementSignature[] = [
    await collectAgreementSignature(capturedBuyerSigner, bytes),
    await collectAgreementSignature(capturedSellerSigner, bytes),
  ];
  const signed = { ...draft, signatures } as AgreementArtifact;
  if (!isAgreementArtifact(signed)) {
    throw new DacsError("signed agreement failed exact DACS-3 §8.5 validation");
  }
  return signed;
}

/** Collect the exact buyer + seller DACS-3 §8.5.1 signatures. */
export async function signAgreementArtifact(
  callerDraft: UnsignedAgreementArtifact,
  buyerSigner: AgreementSigner,
  sellerSigner: AgreementSigner,
): Promise<AgreementArtifact> {
  return signAgreementArtifactForPattern(
    callerDraft,
    buyerSigner,
    sellerSigner,
  );
}

/** Fixed-price convenience wrapper retaining the pattern-specific guard. */
export async function signFixedPriceAgreement(
  callerDraft: UnsignedAgreementArtifact,
  buyerSigner: AgreementSigner,
  sellerSigner: AgreementSigner,
): Promise<AgreementArtifact> {
  return signAgreementArtifactForPattern(
    callerDraft,
    buyerSigner,
    sellerSigner,
    "fixed-price",
  );
}

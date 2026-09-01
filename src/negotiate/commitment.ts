import { types as nodeTypes } from "node:util";

import {
  canonicalize,
  contentHash,
  sha256Hex,
} from "../canonical/index.js";
import {
  snapshotCanonicalJson,
  snapshotCanonicalJsonRead,
} from "../canonical/snapshot.js";
import { signedBytes, type DomainSeparator } from "../crypto/index.js";
import {
  CounterpartyError,
  DacsError,
  SubstrateError,
  TransientError,
} from "../errors.js";
import {
  COMPONENT_SIGNATURE_ALGORITHMS,
  isComponentSignature,
  signComponentArtifact,
  type BuildComponentSignatureOptions,
} from "../artifacts/signatures.js";
import type {
  AgreementArtifact,
  AgreementCommitmentRecord,
  AnchorReceipt,
  AttestationRef,
  ChainTxRef,
  CommitmentRecord,
  ComponentSignature,
  FinalityCommitmentRecord,
  Listing,
  ListingPin,
} from "../artifacts/types.js";
import {
  isAgreementArtifact,
  isAttestationRef,
  isChainTxRef,
  isCommitmentRecord,
  isFinalityCommitmentRecord,
  isListing,
  isReadableAnchorReceipt,
  isReadableFinalityCommitmentRecord,
} from "../artifacts/validators.js";
import {
  deriveMeteredPriceTerm,
  type VerifiedListingInput,
} from "./fixedPrice.js";
import { requireCanonicalJobId } from "./jobId.js";
import {
  rfqSessionCheckpointHash,
  validateRfqProposal,
  type RfqSessionState,
} from "./rfq.js";

export const FINALITY_COMMITMENT_SEPARATOR =
  "dacs-finality-commitment:v1:" as const satisfies DomainSeparator;
export const LEGACY_COMMITMENT_SEPARATOR =
  "dacs-commitment:v1:" as const satisfies DomainSeparator;

export type CommitmentVerificationDisposition =
  | "valid"
  | "invalid"
  | "indeterminate"
  | "error";

export interface CommitmentSignatureVerificationInput {
  purpose: "agreement" | "legacy-commitment" | "finality-commitment";
  signedBytes: Uint8Array;
  algorithm: string;
  signer: string;
  value: string;
}

export type CommitmentSignatureVerifier = (
  input: CommitmentSignatureVerificationInput,
) =>
  | Promise<CommitmentVerificationDisposition>
  | CommitmentVerificationDisposition;

interface AnchoredCommitmentBase {
  record: unknown;
  nativeAddress: string;
  anchorTxRef: ChainTxRef;
  anchorReceipt: AnchorReceipt;
}

export interface AnchoredFinalityCommitment extends AnchoredCommitmentBase {
  legacySignature?: never;
}

export interface AnchoredLegacyCommitment extends AnchoredCommitmentBase {
  /** Historical external/carried DACS-3 v0.1-v0.3 commitment signature. */
  legacySignature: ComponentSignature;
}

export type AnchoredAgreementCommitment =
  | AnchoredFinalityCommitment
  | AnchoredLegacyCommitment;

export type FinalityCommitmentLookup =
  | { disposition: "present"; anchored: AnchoredAgreementCommitment }
  | { disposition: "absent" }
  | { disposition: "indeterminate"; reason: string };

/**
 * SR-2 boundary. `absent` MUST mean authoritative absence under the binding's
 * declared policy; an ordinary not-found/timeout is `indeterminate` (CORE §5.1).
 */
export interface FinalityCommitmentReader {
  resolve: (
    logicalAddress: string,
  ) => Promise<FinalityCommitmentLookup> | FinalityCommitmentLookup;
  /** Authenticate evidence and every substrate-specific transaction/writer/nonce binding. */
  verifyAnchorReceipt: (
    anchored: Readonly<AnchoredAgreementCommitment>,
  ) =>
    | Promise<CommitmentVerificationDisposition>
    | CommitmentVerificationDisposition;
}

export interface FinalityCommitmentProvider extends FinalityCommitmentReader {
  submit: (
    logicalAddress: string,
    record: FinalityCommitmentRecord,
  ) => Promise<AnchoredFinalityCommitment>;
}

export interface CommitmentSessionPartyBinding {
  primaryClaim: string;
  bundleHash: string;
  vetRecordRef: AttestationRef;
}

/** Exact authenticated CORE §B.5 facts owned by the executing session. */
export interface CommitmentSessionBinding {
  jobId: string;
  listingRef: ListingPin;
  phaseKind: "commit-agreement" | "commit-payee-bound-agreement";
  orchestrator: string;
  buyer: CommitmentSessionPartyBinding;
  seller: CommitmentSessionPartyBinding;
}

interface CommitmentBindingInput {
  agreement: AgreementArtifact;
  verifiedListing: VerifiedListingInput;
  session: CommitmentSessionBinding;
}

export interface CommitAgreementInput extends CommitmentBindingInput {
  /** Record construction time only; never used as authoritative committedAt (CA-8). */
  createdAt: number;
  commitmentSigner: BuildComponentSignatureOptions;
}

/** Backward-compatible fixed-price name for the shared commitment contract. */
export interface CommitFixedPriceAgreementInput extends CommitAgreementInput {}

/** RFQ commitment additionally binds the exact accepted channel checkpoint. */
export interface CommitRfqAgreementInput extends CommitAgreementInput {
  rfqSession: RfqSessionState;
}

export interface ReadLegacyFixedPriceAgreementCommitmentInput
  extends CommitmentBindingInput {}

interface FinalizedAgreementCommitmentBase {
  logicalAddress: string;
  nativeAddress: string;
  agreementHash: string;
  anchorTxRef: ChainTxRef;
  anchorReceipt: AnchorReceipt;
  /** Derived exclusively from verified `anchorReceipt.blockRef.timestamp`. */
  committedAt: number;
  resumed: boolean;
}

export interface FinalizedFinalityAgreementCommitment
  extends FinalizedAgreementCommitmentBase {
  recordKind: "finality";
  record: FinalityCommitmentRecord;
}

export interface FinalizedLegacyAgreementCommitment
  extends FinalizedAgreementCommitmentBase {
  recordKind: "legacy";
  record: CommitmentRecord;
  legacySignature: ComponentSignature;
  resumed: true;
}

export type FinalizedAgreementCommitment =
  | FinalizedFinalityAgreementCommitment
  | FinalizedLegacyAgreementCommitment;

interface CapturedCommitmentInput {
  agreement: AgreementArtifact;
  verifiedListing: VerifiedListingInput;
  session: CommitmentSessionBinding;
  createdAt: number;
  commitmentSigner: BuildComponentSignatureOptions;
}

interface CapturedCommitmentBindingInput {
  agreement: AgreementArtifact;
  verifiedListing: VerifiedListingInput;
  session: CommitmentSessionBinding;
}

interface CapturedCommitmentReader {
  resolve: FinalityCommitmentReader["resolve"];
  verifyAnchorReceipt: FinalityCommitmentReader["verifyAnchorReceipt"];
}

interface CapturedCommitmentProvider extends CapturedCommitmentReader {
  submit: FinalityCommitmentProvider["submit"];
}

interface AgreementBinding {
  agreementHash: string;
  pin: ListingPin;
  parties: string[];
  deadlineSeconds: number;
}

const isSafeTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) =>
      typeof key === "string" && expected.includes(key),
    )
  );
}

function exact(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b);
}

function listingPinEquals(a: ListingPin, b: ListingPin): boolean {
  return (
    a.listingId === b.listingId &&
    a.version === b.version &&
    a.contentHash === b.contentHash
  );
}

function ownDataProperty(
  value: unknown,
  key: string,
  label: string,
): unknown {
  if (
    !isRecord(value) ||
    nodeTypes.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new DacsError(`${label} must be a plain data object`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
    throw new DacsError(`${label}.${key} must be an enumerable data property`);
  }
  return descriptor.value;
}

function capturedSignerOptions(value: unknown): BuildComponentSignatureOptions {
  const algorithm = ownDataProperty(
    value,
    "algorithm",
    "commitmentSigner",
  );
  const signer = ownDataProperty(value, "signer", "commitmentSigner");
  const signCandidate = ownDataProperty(value, "sign", "commitmentSigner");
  const algorithms: ReadonlySet<unknown> = new Set(
    COMPONENT_SIGNATURE_ALGORITHMS,
  );
  if (!algorithms.has(algorithm)) {
    throw new DacsError("commitment signer uses an unsupported algorithm");
  }
  if (
    typeof signer !== "string" ||
    signer.length === 0 ||
    signer.trim() !== signer
  ) {
    throw new DacsError("commitment signer claim must be a non-empty string");
  }
  if (typeof signCandidate !== "function" || nodeTypes.isProxy(signCandidate)) {
    throw new DacsError("commitment signer callback must be a function");
  }
  return {
    algorithm: algorithm as BuildComponentSignatureOptions["algorithm"],
    signer,
    sign: Function.prototype.bind.call(
      signCandidate,
      value,
    ) as BuildComponentSignatureOptions["sign"],
  };
}

function assertSessionPartyBinding(
  value: unknown,
  label: "buyer" | "seller",
): asserts value is CommitmentSessionPartyBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["primaryClaim", "bundleHash", "vetRecordRef"]) ||
    typeof value.primaryClaim !== "string" ||
    !/^[a-z][a-z0-9-]*:.+$/.test(value.primaryClaim) ||
    value.primaryClaim.trim() !== value.primaryClaim ||
    typeof value.bundleHash !== "string" ||
    !/^(?:sha256:)?[0-9a-f]{64}$/.test(value.bundleHash) ||
    !isAttestationRef(value.vetRecordRef)
  ) {
    throw new DacsError(
      `authenticated ${label} session binding is not exact and normative`,
    );
  }
}

function assertSessionBinding(
  value: unknown,
): asserts value is CommitmentSessionBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "jobId",
      "listingRef",
      "phaseKind",
      "orchestrator",
      "buyer",
      "seller",
    ]) ||
    typeof value.jobId !== "string" ||
    value.jobId.length === 0 ||
    !isRecord(value.listingRef) ||
    !hasExactKeys(value.listingRef, ["listingId", "version", "contentHash"]) ||
    typeof value.listingRef.listingId !== "string" ||
    value.listingRef.listingId.length === 0 ||
    !Number.isSafeInteger(value.listingRef.version) ||
    (value.listingRef.version as number) <= 0 ||
    typeof value.listingRef.contentHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.listingRef.contentHash) ||
    (value.phaseKind !== "commit-agreement" &&
      value.phaseKind !== "commit-payee-bound-agreement") ||
    typeof value.orchestrator !== "string" ||
    !/^[a-z][a-z0-9-]*:.+$/.test(value.orchestrator) ||
    value.orchestrator.trim() !== value.orchestrator
  ) {
    throw new DacsError("authenticated commitment session binding is not exact");
  }
  assertSessionPartyBinding(value.buyer, "buyer");
  assertSessionPartyBinding(value.seller, "seller");
}

function captureCommitmentBindingInput(
  value: CommitmentBindingInput,
  label: string,
): CapturedCommitmentBindingInput {
  const agreement = ownDataProperty(value, "agreement", label);
  const verifiedListing = ownDataProperty(value, "verifiedListing", label);
  const session = ownDataProperty(value, "session", label);
  const captured = snapshotCanonicalJson(
    { agreement, verifiedListing, session },
    `${label} artifacts`,
  ) as CapturedCommitmentBindingInput;
  assertSessionBinding(captured.session);
  return captured;
}

/** Capture all scalar/callback choices before inspecting either signed artifact. */
function captureCommitmentInput(
  value: CommitAgreementInput,
): CapturedCommitmentInput {
  const signerOptions = capturedSignerOptions(
    ownDataProperty(value, "commitmentSigner", "commitment input"),
  );
  const createdAt = ownDataProperty(value, "createdAt", "commitment input");
  if (!isSafeTime(createdAt)) {
    throw new DacsError("commitment createdAt must be non-negative unix ms");
  }
  const captured = captureCommitmentBindingInput(value, "commitment input");
  return {
    ...captured,
    createdAt,
    commitmentSigner: signerOptions,
  };
}

function captureRfqSession(value: CommitRfqAgreementInput): RfqSessionState {
  const candidate = ownDataProperty(value, "rfqSession", "RFQ commitment input");
  const session = snapshotCanonicalJsonRead(
    candidate,
    "RFQ commitment session checkpoint",
  ) as RfqSessionState;
  rfqSessionCheckpointHash(session);
  return session;
}

function providerDataMethod<
  TProvider extends FinalityCommitmentReader,
  K extends keyof TProvider,
>(
  provider: TProvider,
  key: K,
): TProvider[K] {
  if (
    provider === null ||
    typeof provider !== "object" ||
    nodeTypes.isProxy(provider)
  ) {
    throw new SubstrateError("commitment provider must be a stable object");
  }
  let cursor: object | null = provider;
  while (cursor !== null) {
    if (nodeTypes.isProxy(cursor)) {
      throw new SubstrateError(
        `commitment provider ${String(key)} must not come from a proxy prototype`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
    if (descriptor) {
      if (
        !("value" in descriptor) ||
        typeof descriptor.value !== "function" ||
        nodeTypes.isProxy(descriptor.value)
      ) {
        throw new SubstrateError(
          `commitment provider ${String(key)} must be a data method`,
        );
      }
      return Function.prototype.bind.call(
        descriptor.value,
        provider,
      ) as TProvider[K];
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  throw new SubstrateError(
    `commitment provider is missing ${String(key)}`,
  );
}

function captureReader(
  reader: FinalityCommitmentReader,
): CapturedCommitmentReader {
  return Object.freeze({
    resolve: providerDataMethod(reader, "resolve"),
    verifyAnchorReceipt: providerDataMethod(reader, "verifyAnchorReceipt"),
  });
}

function captureProvider(
  provider: FinalityCommitmentProvider,
): CapturedCommitmentProvider {
  return Object.freeze({
    resolve: providerDataMethod(provider, "resolve"),
    submit: providerDataMethod(provider, "submit"),
    verifyAnchorReceipt: providerDataMethod(provider, "verifyAnchorReceipt"),
  });
}

function captureVerifier(
  verifier: CommitmentSignatureVerifier,
): CommitmentSignatureVerifier {
  if (typeof verifier !== "function" || nodeTypes.isProxy(verifier)) {
    throw new DacsError("commitment signature verifier must be a function");
  }
  return Function.prototype.bind.call(
    verifier,
    undefined,
  ) as CommitmentSignatureVerifier;
}

export function finalityCommitmentAddress(jobId: string): string {
  return `dacs3:commit:${requireCanonicalJobId(jobId, "commitment jobId")}`;
}

/** Frozen pre-ULID address grammar, used only by the explicit legacy reader. */
function legacyCommitmentAddress(jobId: string): string {
  if (typeof jobId !== "string" || jobId.length === 0 || jobId.includes(":")) {
    throw new DacsError(
      "legacy commitment jobId must be a non-empty delimiter-free value",
    );
  }
  return `dacs3:commit:${jobId}`;
}

function expectedDeliverable(listing: Listing): Record<string, unknown> {
  const deliverable = listing.offering.deliverable;
  return {
    deliverableType: deliverable.kind,
    // DACS-4 §9.3 hashes the complete anchored DeliverableSpec JCS bytes. Do
    // not use contentHash(), whose artifact scope omits signature-named fields.
    hash: sha256Hex(canonicalize(deliverable)),
    ...(deliverable.kind === "storage-program" &&
    deliverable.schemaUrl !== undefined
      ? { schemaUrl: deliverable.schemaUrl }
      : {}),
  };
}

function payIndexes(listing: Listing): number[] {
  return listing.pipeline
    .map((phase, index) => (phase.kind.startsWith("pay-") ? index : -1))
    .filter((index) => index >= 0);
}

function validateRailAndPayoutCoverage(
  listing: Listing,
  agreement: AgreementArtifact,
): void {
  const indexes = payIndexes(listing);
  const rail = agreement.terms.rail;
  if (indexes.length === 0) {
    if (rail !== undefined) {
      throw new DacsError(
        "zero-pay commitment requires agreement terms.rail to be absent",
      );
    }
  } else {
    if (
      rail === undefined ||
      !(listing.acceptedRails ?? []).some((candidate) => exact(candidate, rail))
    ) {
      throw new DacsError(
        "agreement rail is not an exact acceptedRails member",
      );
    }
    for (const index of indexes) {
      if (listing.pipeline[index]!.parameters?.rail !== rail.railId) {
        throw new DacsError(
          `pay phase ${index} does not bind the agreement rail`,
        );
      }
    }
  }

  if (!("payeeBoundAgreementVersion" in agreement)) return;
  const expected = new Set(
    indexes.map(
      (index) =>
        `${listing.pipeline[index]!.parameters?.rail}\u0000${index}`,
    ),
  );
  const actual = new Set(
    agreement.terms.payoutBindings.map(
      (binding) => `${binding.railId}\u0000${binding.phaseIndex}`,
    ),
  );
  if (
    expected.size !== agreement.terms.payoutBindings.length ||
    expected.size !== actual.size ||
    [...expected].some((key) => !actual.has(key))
  ) {
    throw new DacsError(
      "payee-bound agreement does not exactly cover the Listing pay phases",
    );
  }
}

type SupportedCommitmentPattern = "fixed-price" | "rfq";

interface SelectedAgreementArtifact {
  agreement: AgreementArtifact;
  listing: Listing;
}

function selectAgreementArtifact(
  input: Pick<
    CapturedCommitmentBindingInput,
    "agreement" | "verifiedListing"
  >,
  pattern: SupportedCommitmentPattern,
  options: { allowLegacyJobId?: boolean } = {},
): SelectedAgreementArtifact {
  const agreement = input.agreement;
  const verified = input.verifiedListing;
  if (verified.disposition !== "verified") {
    throw new DacsError(
      "commitment requires an explicitly verified Listing disposition",
    );
  }
  const candidate = verified.listing as unknown;
  if (isRecord(candidate) && isRecord(candidate.pricing)) {
    const kind = candidate.pricing.kind;
    if (
      typeof kind === "string" &&
      !["fixed", "negotiable", "auction", "metered"].includes(kind)
    ) {
      throw new DacsError(`unrecognized-pricing-kind: ${kind}`);
    }
  }
  if (!options.allowLegacyJobId) {
    // Validate the address-bearing discriminator before the broader artifact
    // shape so a malformed/lowercase spelling cannot be hidden behind the
    // generic agreement error and no resolver/verifier callback can run first.
    requireCanonicalJobId(agreement.jobId, "agreement jobId");
  }
  const agreementIsReadable = options.allowLegacyJobId
    ? isLegacyReadableAgreementArtifact(agreement)
    : isAgreementArtifact(agreement);
  if (!isListing(verified.listing) || !agreementIsReadable) {
    throw new DacsError(
      "commitment input has a non-normative Listing or agreement shape",
    );
  }
  const listing = verified.listing;
  if (listing.terms.acceptanceModel === "auto-accept") {
    throw new DacsError(
      "auto-accept requires a verified commitment and live instance-signature path",
    );
  }
  const negotiate = listing.pipeline
    .map((phase, index) => ({ phase, index }))
    .filter(({ phase }) => phase.kind.startsWith("negotiate-"));
  const commits = listing.pipeline
    .map((phase, index) => ({ phase, index }))
    .filter(({ phase }) => phase.kind.startsWith("commit-"));
  const expectedNegotiation =
    pattern === "fixed-price" ? "negotiate-fixed-price" : "negotiate-rfq";
  if (
    negotiate.length !== 1 ||
    negotiate[0]!.phase.kind !== expectedNegotiation ||
    commits.length !== 1 ||
    commits[0]!.index !== negotiate[0]!.index + 1 ||
    agreement.derivedFromPattern !== pattern
  ) {
    throw new DacsError(
      `Listing/agreement does not select one ${pattern} commitment pipeline`,
    );
  }
  const expectedCommit =
    "agreementVersion" in agreement
      ? "commit-agreement"
      : "commit-payee-bound-agreement";
  if (commits[0]!.phase.kind !== expectedCommit) {
    throw new DacsError(
      "agreement artifact discriminator does not match the commit phase (CA-5)",
    );
  }
  return { agreement, listing };
}

function selectFixedPriceArtifact(
  input: Pick<
    CapturedCommitmentBindingInput,
    "agreement" | "verifiedListing"
  >,
  options: { allowLegacyJobId?: boolean } = {},
): SelectedAgreementArtifact {
  return selectAgreementArtifact(input, "fixed-price", options);
}

function selectRfqArtifact(
  input: Pick<
    CapturedCommitmentBindingInput,
    "agreement" | "verifiedListing"
  >,
): SelectedAgreementArtifact {
  return selectAgreementArtifact(input, "rfq");
}

/**
 * Historical pre-ULID agreements differ from the current exact wire contract
 * only in the job identifier grammar. Validate every other byte/field through
 * the normative parser by substituting a canonical probe id; the original id
 * remains signed, session-bound, and used for the read-only legacy address.
 */
function isLegacyReadableAgreementArtifact(
  value: unknown,
): value is AgreementArtifact {
  if (
    !isRecord(value) ||
    typeof value.jobId !== "string" ||
    value.jobId.length === 0 ||
    value.jobId.includes(":")
  ) {
    return false;
  }
  return isAgreementArtifact({
    ...value,
    jobId: "00000000000000000000000000",
  });
}

function validatePricingBinding(
  listing: Listing,
  agreement: AgreementArtifact,
  pattern: SupportedCommitmentPattern,
): void {
  if (pattern === "rfq") {
    if (
      listing.pricing.kind !== "negotiable" &&
      listing.pricing.kind !== "metered"
    ) {
      throw new DacsError(
        "RFQ commitment requires negotiable or metered Listing pricing",
      );
    }
    validateRfqProposal(
      {
        rfqProposalVersion: "1",
        price: agreement.terms.price,
        ...(agreement.terms.meteredQuantity === undefined
          ? {}
          : { meteredQuantity: agreement.terms.meteredQuantity }),
      },
      listing.pricing,
    );
    return;
  }
  const quantity = agreement.terms.meteredQuantity;
  if (listing.pricing.kind === "fixed" || listing.pricing.kind === "negotiable") {
    if (quantity !== undefined) {
      throw new DacsError(
        "unexpected-metered-quantity: non-metered agreement must omit meteredQuantity",
      );
    }
    const expectedPrice =
      listing.pricing.kind === "fixed"
        ? listing.pricing.price
        : listing.pricing.bandCenter;
    if (agreement.terms.price.currency !== expectedPrice.currency) {
      throw new DacsError("agreement price currency does not match the Listing");
    }
    if (!exact(agreement.terms.price, expectedPrice)) {
      throw new DacsError(
        "agreement price is not the exact fixed-price Listing term",
      );
    }
    return;
  }

  if (listing.pricing.kind !== "metered") {
    throw new DacsError(
      `${listing.pricing.kind} pricing is unsupported by fixed-price commitment`,
    );
  }
  if (agreement.terms.price.currency !== listing.pricing.unitPrice.currency) {
    throw new DacsError(
      "price-currency-mismatch: metered agreement currency differs from unitPrice",
    );
  }
  if (
    listing.pricing.minTotal !== undefined &&
    listing.pricing.minTotal.currency !== listing.pricing.unitPrice.currency
  ) {
    throw new DacsError(
      "min-total-currency-mismatch: metered minimum uses a different currency",
    );
  }
  if (!quantity) {
    throw new DacsError(
      "missing-metered-quantity: metered agreement requires meteredQuantity",
    );
  }
  const expected = deriveMeteredPriceTerm(listing.pricing, quantity);
  if (!exact(agreement.terms.price, expected)) {
    throw new DacsError(
      `metered-total-mismatch: expected ${expected.amount}`,
    );
  }
}

function validateAuthenticatedSessionBinding(
  input: CapturedCommitmentBindingInput,
  selected: ReturnType<typeof selectFixedPriceArtifact>,
): {
  pin: ListingPin;
  buyer: AgreementArtifact["parties"][number];
  seller: AgreementArtifact["parties"][number];
} {
  const { agreement, listing } = selected;
  const pin: ListingPin = {
    listingId: listing.listingId,
    version: listing.listingVersion,
    contentHash: contentHash(listing as unknown as Record<string, unknown>),
  };
  const expectedPhase =
    "agreementVersion" in agreement
      ? "commit-agreement"
      : "commit-payee-bound-agreement";
  if (
    input.session.jobId !== agreement.jobId ||
    input.session.phaseKind !== expectedPhase ||
    !listingPinEquals(input.session.listingRef, pin) ||
    !listingPinEquals(input.verifiedListing.pin, pin) ||
    !listingPinEquals(agreement.listingRef, pin)
  ) {
    throw new DacsError(
      "authenticated commitment session does not bind the exact job, phase, and Listing pin",
    );
  }

  const buyer = agreement.parties.find((party) => party.role === "buyer");
  const seller = agreement.parties.find((party) => party.role === "seller");
  const partyMatches = (
    party: AgreementArtifact["parties"][number] | undefined,
    sessionParty: CommitmentSessionPartyBinding,
  ): boolean =>
    party !== undefined &&
    party.primaryClaim === sessionParty.primaryClaim &&
    party.bundleHash === sessionParty.bundleHash &&
    exact(party.vetRecordRef, sessionParty.vetRecordRef);
  if (
    !partyMatches(buyer, input.session.buyer) ||
    !partyMatches(seller, input.session.seller) ||
    buyer!.primaryClaim === seller!.primaryClaim ||
    seller!.primaryClaim !== listing.seller.identity.presentedBy
  ) {
    throw new DacsError(
      "authenticated commitment session parties do not match the signed agreement and Listing",
    );
  }
  return { pin, buyer: buyer!, seller: seller! };
}

function validateRfqSessionBinding(
  rfqSession: RfqSessionState,
  input: CapturedCommitmentBindingInput,
  selected: SelectedAgreementArtifact,
): void {
  const { agreement, listing } = selected;
  const proposal = rfqSession.standingProposal;
  const channel = agreement.derivedFromChannel;
  if (
    rfqSession.status !== "accepted" ||
    proposal === undefined ||
    rfqSession.lastMessageHash === undefined ||
    channel === undefined
  ) {
    throw new DacsError(
      "RFQ commitment requires an accepted transcript-bound session",
    );
  }
  if (
    rfqSession.jobId !== agreement.jobId ||
    !listingPinEquals(rfqSession.listingPin, agreement.listingRef) ||
    !exact(rfqSession.pricing, listing.pricing) ||
    channel.subnet !== rfqSession.channelId ||
    channel.lastMessageHash !== rfqSession.lastMessageHash
  ) {
    throw new DacsError(
      "RFQ agreement does not bind the exact accepted channel checkpoint",
    );
  }
  const buyer = agreement.parties.find((party) => party.role === "buyer");
  const seller = agreement.parties.find((party) => party.role === "seller");
  if (
    buyer === undefined ||
    seller === undefined ||
    rfqSession.buyer.primaryClaim !== buyer.primaryClaim ||
    rfqSession.buyer.bundleHash !== buyer.bundleHash ||
    !exact(rfqSession.buyer.vetRecordRef, buyer.vetRecordRef) ||
    rfqSession.seller.primaryClaim !== seller.primaryClaim ||
    rfqSession.seller.bundleHash !== seller.bundleHash ||
    !exact(rfqSession.seller.vetRecordRef, seller.vetRecordRef) ||
    input.session.buyer.primaryClaim !== rfqSession.buyer.primaryClaim ||
    input.session.seller.primaryClaim !== rfqSession.seller.primaryClaim
  ) {
    throw new DacsError(
      "RFQ channel parties do not match the authenticated commitment session",
    );
  }
  const accepted = validateRfqProposal(
    {
      rfqProposalVersion: proposal.rfqProposalVersion,
      price: proposal.price,
      ...(proposal.meteredQuantity === undefined
        ? {}
        : { meteredQuantity: proposal.meteredQuantity }),
    },
    rfqSession.pricing,
  );
  const agreementQuantity = agreement.terms.meteredQuantity;
  const acceptedQuantity = accepted.meteredQuantity;
  if (
    !exact(agreement.terms.price, accepted.price) ||
    ((agreementQuantity === undefined) !==
      (acceptedQuantity === undefined)) ||
    (agreementQuantity !== undefined &&
      acceptedQuantity !== undefined &&
      !exact(agreementQuantity, acceptedQuantity))
  ) {
    throw new DacsError(
      "RFQ agreement terms differ from the authenticated accepted proposal",
    );
  }
}

function agreementBinding(
  selected: SelectedAgreementArtifact,
  authenticated: ReturnType<typeof validateAuthenticatedSessionBinding>,
  pattern: SupportedCommitmentPattern,
): AgreementBinding {
  const { agreement, listing } = selected;
  if (agreement.derivedFromPattern !== pattern) {
    throw new DacsError(
      `this commitment path requires a ${pattern} agreement`,
    );
  }
  validatePricingBinding(listing, agreement, pattern);
  if (!exact(agreement.terms.deliverable, expectedDeliverable(listing))) {
    throw new DacsError(
      "agreement deliverable does not match the pinned Listing",
    );
  }
  validateRailAndPayoutCoverage(listing, agreement);
  const deadlineSeconds = listing.terms.deadlineSecAfterCommit;
  if (!Number.isSafeInteger(deadlineSeconds) || (deadlineSeconds ?? 0) <= 0) {
    throw new DacsError(
      "Listing commitment requires a positive deadlineSecAfterCommit",
    );
  }
  return {
    agreementHash: contentHash(
      agreement as unknown as Record<string, unknown>,
    ),
    pin: authenticated.pin,
    parties: [
      authenticated.buyer.primaryClaim,
      authenticated.seller.primaryClaim,
    ],
    deadlineSeconds: deadlineSeconds!,
  };
}

function validateProvisionalTime(
  input: CapturedCommitmentInput,
  selected: ReturnType<typeof selectFixedPriceArtifact>,
  binding: AgreementBinding,
): void {
  const { agreement, listing } = selected;
  if (
    !isSafeTime(input.createdAt) ||
    agreement.generatedAt > input.createdAt ||
    input.createdAt < listing.validity.notBefore ||
    (listing.validity.notAfter !== undefined &&
      input.createdAt > listing.validity.notAfter)
  ) {
    throw new DacsError(
      "agreement commitment fails its provisional time checks",
    );
  }
  const provisionalLimit =
    input.createdAt + binding.deadlineSeconds * 1_000;
  if (
    !Number.isSafeInteger(provisionalLimit) ||
    agreement.terms.deadline > provisionalLimit
  ) {
    throw new DacsError(
      "agreement deadline exceeds the provisional Listing limit",
    );
  }
}

/**
 * Pure DACS-3 §8.5.2 AgreementArtifact → exact pinned Listing verifier for a
 * caller that has already authenticated CA-7 signatures and CA-8 finality.
 * This deliberately does not replace the stricter commitment/session gate:
 * seller intake supplies the authenticated finality timestamp and uses this
 * only to re-check the complete agreement/listing commerce binding.
 */
function validateAgreementBindingForPattern(
  callerInput: {
    agreement: AgreementArtifact;
    verifiedListing: VerifiedListingInput;
    committedAt: number;
  },
  pattern: SupportedCommitmentPattern,
): AgreementBinding {
  const input = snapshotCanonicalJson(
    callerInput,
    `${pattern} agreement binding input`,
  );
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["agreement", "verifiedListing", "committedAt"])
  ) {
    throw new DacsError(`${pattern} agreement binding input is not exact`);
  }
  const selected =
    pattern === "fixed-price"
      ? selectFixedPriceArtifact(input)
      : selectRfqArtifact(input);
  const { agreement, listing } = selected;
  const pin: ListingPin = {
    listingId: listing.listingId,
    version: listing.listingVersion,
    contentHash: contentHash(listing as unknown as Record<string, unknown>),
  };
  if (
    !listingPinEquals(input.verifiedListing.pin, pin) ||
    !listingPinEquals(agreement.listingRef, pin)
  ) {
    throw new DacsError(
      "agreement commitment does not bind the exact verified Listing pin",
    );
  }
  validatePricingBinding(listing, agreement, pattern);
  if (!exact(agreement.terms.deliverable, expectedDeliverable(listing))) {
    throw new DacsError(
      "agreement deliverable does not match the pinned Listing",
    );
  }
  validateRailAndPayoutCoverage(listing, agreement);

  const buyer = agreement.parties.find((party) => party.role === "buyer");
  const seller = agreement.parties.find((party) => party.role === "seller");
  if (
    !buyer ||
    !seller ||
    buyer.primaryClaim === seller.primaryClaim ||
    seller.primaryClaim !== listing.seller.identity.presentedBy
  ) {
    throw new DacsError(
      "agreement parties do not match the pinned Listing seller",
    );
  }
  const deadlineSeconds = listing.terms.deadlineSecAfterCommit;
  if (
    !Number.isSafeInteger(deadlineSeconds) ||
    (deadlineSeconds ?? 0) <= 0 ||
    !isSafeTime(input.committedAt) ||
    agreement.generatedAt > input.committedAt ||
    input.committedAt < listing.validity.notBefore ||
    (listing.validity.notAfter !== undefined &&
      input.committedAt > listing.validity.notAfter)
  ) {
    throw new DacsError(
      "agreement commitment fails its authenticated finality time checks",
    );
  }
  const deadlineLimit = input.committedAt + deadlineSeconds! * 1_000;
  if (
    !Number.isSafeInteger(deadlineLimit) ||
    agreement.terms.deadline > deadlineLimit
  ) {
    throw new DacsError(
      "agreement deadline exceeds the authenticated finality Listing limit",
    );
  }
  return {
    agreementHash: contentHash(
      agreement as unknown as Record<string, unknown>,
    ),
    pin,
    parties: [buyer.primaryClaim, seller.primaryClaim],
    deadlineSeconds: deadlineSeconds!,
  };
}

export function validateFixedPriceAgreementBinding(callerInput: {
  agreement: AgreementArtifact;
  verifiedListing: VerifiedListingInput;
  committedAt: number;
}): AgreementBinding {
  return validateAgreementBindingForPattern(callerInput, "fixed-price");
}

/** Pure post-finality RFQ agreement/listing binding verifier. */
export function validateRfqAgreementBinding(callerInput: {
  agreement: AgreementArtifact;
  verifiedListing: VerifiedListingInput;
  committedAt: number;
}): AgreementBinding {
  return validateAgreementBindingForPattern(callerInput, "rfq");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function verificationRequestUnchanged(
  request: CommitmentSignatureVerificationInput,
  expected: CommitmentSignatureVerificationInput,
): boolean {
  const descriptors = Object.getOwnPropertyDescriptors(request);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== 5 ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !["purpose", "signedBytes", "algorithm", "signer", "value"].includes(
          key,
        ),
    )
  ) {
    return false;
  }
  const data = (key: string): unknown => {
    const descriptor = descriptors[key];
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  };
  const callbackBytes = data("signedBytes");
  return (
    data("purpose") === expected.purpose &&
    callbackBytes instanceof Uint8Array &&
    sameBytes(callbackBytes, expected.signedBytes) &&
    data("algorithm") === expected.algorithm &&
    data("signer") === expected.signer &&
    data("value") === expected.value
  );
}

async function requireSignature(
  verifier: CommitmentSignatureVerifier,
  expected: CommitmentSignatureVerificationInput,
): Promise<void> {
  const request: CommitmentSignatureVerificationInput = {
    ...expected,
    signedBytes: Uint8Array.from(expected.signedBytes),
  };
  let disposition: unknown;
  let verificationError: unknown;
  let verificationThrew = false;
  try {
    disposition = await verifier(request);
  } catch (error) {
    verificationThrew = true;
    verificationError = error;
  }
  if (!verificationRequestUnchanged(request, expected)) {
    throw new DacsError(
      `${expected.purpose} signature verifier mutated its verification input`,
    );
  }
  if (verificationThrew) {
    throw new TransientError(
      `${expected.purpose} signature verification is uncertain because the verifier threw`,
      { cause: verificationError },
    );
  }
  if (disposition === "valid") return;
  if (disposition === "invalid") {
    throw new CounterpartyError(
      `${expected.purpose} signature is not verified (invalid)`,
    );
  }
  if (disposition === "indeterminate" || disposition === "error") {
    throw new TransientError(
      `${expected.purpose} signature verification is uncertain (${disposition})`,
    );
  }
  throw new DacsError(
    `${expected.purpose} signature verifier returned an invalid disposition`,
  );
}

async function verifyAgreementSignatures(
  agreement: AgreementArtifact,
  verifier: CommitmentSignatureVerifier,
): Promise<void> {
  const separator =
    "agreementVersion" in agreement
      ? "dacs-agreement:v1:"
      : "dacs-payee-bound-agreement:v1:";
  const bytes = signedBytes(
    separator,
    contentHash(agreement as unknown as Record<string, unknown>),
  );
  // The captured Agreement has exactly two required signatures. Iterate this
  // owned fixed-length snapshot so a verifier cannot remove the second check.
  for (const signature of agreement.signatures) {
    await requireSignature(verifier, {
      purpose: "agreement",
      signedBytes: bytes,
      algorithm: signature.algorithm,
      signer: signature.party,
      value: signature.value,
    });
  }
}

function unsignedFinalityRecord(
  input: CapturedCommitmentInput,
  binding: AgreementBinding,
): Omit<FinalityCommitmentRecord, "signature"> {
  return {
    finalityCommitmentVersion: "1",
    jobId: input.agreement.jobId,
    agreementHash: binding.agreementHash,
    listingRef: { ...binding.pin },
    parties: [...binding.parties],
    pattern: input.agreement.derivedFromPattern,
    createdAt: input.createdAt,
  };
}

function recordMatchesBinding(
  record: AgreementCommitmentRecord,
  input: CapturedCommitmentBindingInput,
  binding: AgreementBinding,
): boolean {
  return (
    record.jobId === input.agreement.jobId &&
    record.agreementHash === binding.agreementHash &&
    listingPinEquals(record.listingRef, binding.pin) &&
    record.parties.length === binding.parties.length &&
    binding.parties.every(
      (party, index) => record.parties[index] === party,
    ) &&
    record.pattern === input.agreement.derivedFromPattern
  );
}

async function verifyCommitmentSignature(
  record: FinalityCommitmentRecord,
  verifier: CommitmentSignatureVerifier,
): Promise<void> {
  await requireSignature(verifier, {
    purpose: "finality-commitment",
    signedBytes: signedBytes(
      FINALITY_COMMITMENT_SEPARATOR,
      contentHash(record as unknown as Record<string, unknown>),
    ),
    algorithm: record.signature.algorithm,
    signer: record.signature.signer,
    value: record.signature.value,
  });
}

async function verifyLegacyCommitmentSignature(
  record: CommitmentRecord,
  signature: ComponentSignature,
  verifier: CommitmentSignatureVerifier,
): Promise<void> {
  await requireSignature(verifier, {
    purpose: "legacy-commitment",
    signedBytes: signedBytes(
      LEGACY_COMMITMENT_SEPARATOR,
      contentHash(record as unknown as Record<string, unknown>),
    ),
    algorithm: signature.algorithm,
    signer: signature.signer,
    value: signature.value,
  });
}

function snapshotAnchored(
  value: unknown,
  label: string,
): AnchoredAgreementCommitment {
  let captured: unknown;
  try {
    captured = snapshotCanonicalJson(value, label);
  } catch (cause) {
    throw new SubstrateError(
      `${label} returned an unstable or non-wire anchor result`,
      { cause },
    );
  }
  if (!isRecord(captured)) {
    throw new SubstrateError(`${label} returned a malformed anchor result`);
  }
  const finalityEnvelope = hasExactKeys(captured, [
    "record",
    "nativeAddress",
    "anchorTxRef",
    "anchorReceipt",
  ]);
  const legacyEnvelope = hasExactKeys(captured, [
    "record",
    "nativeAddress",
    "anchorTxRef",
    "anchorReceipt",
    "legacySignature",
  ]);
  if (
    (!finalityEnvelope && !legacyEnvelope) ||
    !isRecord(captured.record) ||
    typeof captured.nativeAddress !== "string" ||
    captured.nativeAddress.length === 0 ||
    !isRecord(captured.anchorTxRef) ||
    !isRecord(captured.anchorReceipt) ||
    (legacyEnvelope &&
      (!isComponentSignature(captured.legacySignature) ||
        !isRecord(captured.legacySignature) ||
        !hasExactKeys(captured.legacySignature, [
          "algorithm",
          "signer",
          "value",
        ])))
  ) {
    throw new SubstrateError(`${label} returned a malformed anchor result`);
  }
  return captured as unknown as AnchoredAgreementCommitment;
}

function snapshotLookup(value: unknown): FinalityCommitmentLookup {
  let captured: unknown;
  try {
    captured = snapshotCanonicalJson(value, "commitment lookup");
  } catch (cause) {
    throw new SubstrateError(
      "commitment lookup returned an unstable or non-wire result",
      { cause },
    );
  }
  if (!isRecord(captured)) {
    throw new SubstrateError(
      "commitment lookup returned a malformed lookup envelope",
    );
  }
  if (
    captured.disposition === "absent" &&
    hasExactKeys(captured, ["disposition"])
  ) {
    return { disposition: "absent" };
  }
  if (
    captured.disposition === "indeterminate" &&
    hasExactKeys(captured, ["disposition", "reason"]) &&
    typeof captured.reason === "string" &&
    captured.reason.trim().length > 0
  ) {
    return { disposition: "indeterminate", reason: captured.reason };
  }
  if (
    captured.disposition === "present" &&
    hasExactKeys(captured, ["disposition", "anchored"])
  ) {
    return {
      disposition: "present",
      anchored: snapshotAnchored(
        captured.anchored,
        "commitment lookup present result",
      ),
    };
  }
  throw new SubstrateError(
    "commitment lookup returned a malformed lookup envelope",
  );
}

async function finalizedReceiptTime(
  logicalAddress: string,
  anchored: AnchoredAgreementCommitment,
  verifyAnchorReceipt: CapturedCommitmentReader["verifyAnchorReceipt"],
): Promise<number> {
  const record = anchored.record as AgreementCommitmentRecord;
  const receipt = anchored.anchorReceipt;
  if (
    !isReadableAnchorReceipt(receipt) ||
    !isChainTxRef(anchored.anchorTxRef) ||
    typeof anchored.nativeAddress !== "string" ||
    anchored.nativeAddress.length === 0 ||
    receipt.state !== "finalized" ||
    receipt.observationDisposition !== "established" ||
    receipt.logicalAddress !== logicalAddress ||
    receipt.nativeAddress !== anchored.nativeAddress ||
    receipt.contentHash !==
      contentHash(record as unknown as Record<string, unknown>) ||
    !isSafeTime(receipt.blockRef?.timestamp)
  ) {
    throw new DacsError(
      "commitment receipt is not an exact finalized SR-2 binding",
    );
  }
  // Capture authoritative time before the proof callback and give that callback
  // a separate owned view. Mutation is a provider contract violation, not time.
  const committedAt = receipt.blockRef.timestamp;
  const callbackAnchored = snapshotCanonicalJson(
    anchored,
    "commitment receipt proof input",
  );
  const expectedCallbackCanonical = canonicalize(callbackAnchored);
  let disposition: unknown;
  try {
    disposition = await verifyAnchorReceipt(callbackAnchored);
  } catch (error) {
    throw new SubstrateError(
      "commitment receipt proof verification errored",
      { cause: error },
    );
  }
  try {
    if (
      canonicalize(
        snapshotCanonicalJson(
          callbackAnchored,
          "commitment receipt proof callback input",
        ),
      ) !== expectedCallbackCanonical
    ) {
      throw new TypeError("proof callback changed its input");
    }
  } catch (cause) {
    throw new SubstrateError(
      "commitment receipt proof verifier mutated its input",
      { cause },
    );
  }
  if (disposition === "indeterminate" || disposition === "error") {
    throw new SubstrateError(
      `commitment receipt proof is not established (${disposition})`,
    );
  }
  if (disposition === "invalid") {
    throw new DacsError("commitment receipt proof is invalid");
  }
  if (disposition !== "valid") {
    throw new SubstrateError(
      "commitment receipt proof verifier returned an invalid disposition",
    );
  }
  return committedAt;
}

function validateAuthoritativeTime(
  committedAt: number,
  selected: ReturnType<typeof selectFixedPriceArtifact>,
  binding: AgreementBinding,
): void {
  const finalizedLimit = committedAt + binding.deadlineSeconds * 1_000;
  if (
    !Number.isSafeInteger(finalizedLimit) ||
    selected.agreement.terms.deadline > finalizedLimit ||
    (selected.listing.validity.notAfter !== undefined &&
      selected.listing.validity.notAfter < committedAt)
  ) {
    throw new DacsError(
      "finalized receipt timestamp fails authoritative agreement/Listing checks",
    );
  }
}

async function resolveCommitment(
  logicalAddress: string,
  reader: CapturedCommitmentReader,
): Promise<Exclude<FinalityCommitmentLookup, { disposition: "indeterminate" }>> {
  let lookup: FinalityCommitmentLookup;
  try {
    lookup = snapshotLookup(await reader.resolve(logicalAddress));
  } catch (error) {
    if (error instanceof SubstrateError) throw error;
    throw new SubstrateError(
      "commitment lookup errored and is indeterminate",
      { cause: error },
    );
  }
  if (lookup.disposition === "indeterminate") {
    throw new SubstrateError(
      `commitment lookup is indeterminate: ${lookup.reason}`,
    );
  }
  return lookup;
}

async function verifyAnchoredCommitment(
  logicalAddress: string,
  anchored: AnchoredAgreementCommitment,
  input: CapturedCommitmentBindingInput,
  selected: ReturnType<typeof selectFixedPriceArtifact>,
  binding: AgreementBinding,
  verifyAnchorReceipt: CapturedCommitmentReader["verifyAnchorReceipt"],
  verifySignature: CommitmentSignatureVerifier,
  options: {
    resumed: boolean;
    submittedCanonical?: string;
    freshSignatureAlreadyVerified?: boolean;
  },
): Promise<FinalizedAgreementCommitment> {
  const record = anchored.record;
  const hasLegacyDiscriminator =
    isRecord(record) &&
    Object.prototype.hasOwnProperty.call(record, "dacsVersion");
  const hasFinalityDiscriminator =
    isRecord(record) &&
    Object.prototype.hasOwnProperty.call(record, "finalityCommitmentVersion");
  if (hasLegacyDiscriminator === hasFinalityDiscriminator) {
    throw new DacsError(
      "existing commitment has ambiguous or missing record discriminator (CA-9)",
    );
  }

  let recordKind: "legacy" | "finality";
  let commitmentRecord: AgreementCommitmentRecord;
  let legacySignature: ComponentSignature | undefined;
  if (hasLegacyDiscriminator) {
    if (
      !isCommitmentRecord(record) ||
      !("legacySignature" in anchored) ||
      !isComponentSignature(anchored.legacySignature)
    ) {
      throw new DacsError(
        "existing legacy commitment or its carried signature is malformed (CA-9)",
      );
    }
    recordKind = "legacy";
    commitmentRecord = record;
    legacySignature = anchored.legacySignature;
  } else {
    if (
      !isReadableFinalityCommitmentRecord(record) ||
      "legacySignature" in anchored
    ) {
      throw new DacsError(
        "existing finality commitment is malformed or discriminator-ambiguous (CA-9)",
      );
    }
    recordKind = "finality";
    commitmentRecord = record;
  }

  if (!recordMatchesBinding(commitmentRecord, input, binding)) {
    throw new DacsError(
      "existing commitment binds different authenticated session content (CA-3/CA-7)",
    );
  }
  if (
    options.submittedCanonical !== undefined &&
    (recordKind !== "finality" ||
      canonicalize(commitmentRecord) !== options.submittedCanonical)
  ) {
    throw new DacsError(
      "fresh commitment anchor does not contain the exact submitted record (CA-3)",
    );
  }

  if (recordKind === "finality") {
    const finalityRecord = commitmentRecord as FinalityCommitmentRecord;
    if (finalityRecord.signature.signer !== input.session.orchestrator) {
      throw new DacsError(
        "finality commitment signer is not the authenticated session orchestrator (CA-6)",
      );
    }
    if (!options.freshSignatureAlreadyVerified) {
      await verifyCommitmentSignature(finalityRecord, verifySignature);
    }
  } else {
    if (legacySignature!.signer !== input.session.orchestrator) {
      throw new DacsError(
        "legacy commitment signer is not the authenticated session orchestrator (CA-6)",
      );
    }
    await verifyLegacyCommitmentSignature(
      commitmentRecord as CommitmentRecord,
      legacySignature!,
      verifySignature,
    );
  }

  const committedAt = await finalizedReceiptTime(
    logicalAddress,
    anchored,
    verifyAnchorReceipt,
  );
  if (
    recordKind === "legacy" &&
    (commitmentRecord as CommitmentRecord).committedAt !== committedAt
  ) {
    throw new DacsError(
      "legacy commitment committedAt does not match authenticated anchor time (CA-8)",
    );
  }
  validateAuthoritativeTime(committedAt, selected, binding);

  const common = {
    logicalAddress,
    nativeAddress: anchored.nativeAddress,
    agreementHash: binding.agreementHash,
    anchorTxRef: anchored.anchorTxRef,
    anchorReceipt: anchored.anchorReceipt,
    committedAt,
    resumed: options.resumed,
  };
  if (recordKind === "legacy") {
    return snapshotCanonicalJson(
      {
        ...common,
        recordKind,
        record: commitmentRecord,
        legacySignature,
        resumed: true,
      },
      "finalized legacy agreement commitment result",
    ) as FinalizedLegacyAgreementCommitment;
  }
  return snapshotCanonicalJson(
    { ...common, recordKind, record: commitmentRecord },
    "finalized agreement commitment result",
  ) as FinalizedFinalityAgreementCommitment;
}

async function commitAgreementForPattern(
  callerInput: CommitAgreementInput | CommitRfqAgreementInput,
  callerProvider: FinalityCommitmentProvider,
  callerVerifySignature: CommitmentSignatureVerifier,
  pattern: SupportedCommitmentPattern,
): Promise<FinalizedAgreementCommitment> {
  // Dependency identity is fixed before any caller-owned artifact is read.
  const provider = captureProvider(callerProvider);
  const verifySignature = captureVerifier(callerVerifySignature);
  const rfqSession =
    pattern === "rfq"
      ? captureRfqSession(callerInput as CommitRfqAgreementInput)
      : undefined;
  const input = captureCommitmentInput(callerInput);
  const selected =
    pattern === "fixed-price"
      ? selectFixedPriceArtifact(input)
      : selectRfqArtifact(input);
  const logicalAddress = finalityCommitmentAddress(selected.agreement.jobId);
  const authenticated = validateAuthenticatedSessionBinding(input, selected);
  if (rfqSession !== undefined) {
    validateRfqSessionBinding(rfqSession, input, selected);
  }
  if (input.commitmentSigner.signer !== input.session.orchestrator) {
    throw new DacsError(
      "commitment signer is not the authenticated orchestrator (CA-6)",
    );
  }

  await verifyAgreementSignatures(selected.agreement, verifySignature);
  const binding = agreementBinding(selected, authenticated, pattern);
  const lookup = await resolveCommitment(logicalAddress, provider);
  if (lookup.disposition === "present") {
    // A retry clock cannot invalidate an immutable commitment that finalized
    // while the Listing was live. Only its receipt timestamp is authoritative.
    return verifyAnchoredCommitment(
      logicalAddress,
      lookup.anchored,
      input,
      selected,
      binding,
      provider.verifyAnchorReceipt,
      verifySignature,
      { resumed: true },
    );
  }

  validateProvisionalTime(input, selected, binding);
  const unsigned = unsignedFinalityRecord(input, binding);
  const placeholder: ComponentSignature = {
    algorithm: input.commitmentSigner.algorithm,
    signer: input.commitmentSigner.signer,
    value: Buffer.alloc(64).toString("base64url"),
  };
  if (!isFinalityCommitmentRecord({ ...unsigned, signature: placeholder })) {
    throw new DacsError("finality commitment draft is not normative");
  }
  const record = await signComponentArtifact(
    unsigned,
    FINALITY_COMMITMENT_SEPARATOR,
    input.commitmentSigner,
  );
  if (!isFinalityCommitmentRecord(record)) {
    throw new DacsError("signed finality commitment is not normative");
  }

  // Authenticate the exact locally produced signature before an immutable
  // submit. Invalid or uncertain verification must have a zero-submit outcome.
  await verifyCommitmentSignature(record, verifySignature);
  const submittedCanonical = canonicalize(record);
  let anchored: AnchoredAgreementCommitment;
  try {
    anchored = snapshotAnchored(
      await provider.submit(
        logicalAddress,
        snapshotCanonicalJson(record, "commitment submission record"),
      ),
      "commitment submission",
    );
  } catch (error) {
    if (error instanceof SubstrateError) throw error;
    throw new SubstrateError(
      "commitment submission outcome is ambiguous; resolve before any retry",
      { cause: error },
    );
  }
  return verifyAnchoredCommitment(
    logicalAddress,
    anchored,
    input,
    selected,
    binding,
    provider.verifyAnchorReceipt,
    verifySignature,
    {
      resumed: false,
      submittedCanonical,
      freshSignatureAlreadyVerified: true,
    },
  );
}

/**
 * DACS-3 §8.6 + CORE §5.1 fixed-price commitment gate. It is deliberately
 * transport-independent and fails closed before any caller may enter DACS-4.
 */
export async function commitFixedPriceAgreement(
  callerInput: CommitFixedPriceAgreementInput,
  callerProvider: FinalityCommitmentProvider,
  callerVerifySignature: CommitmentSignatureVerifier,
): Promise<FinalizedAgreementCommitment> {
  return commitAgreementForPattern(
    callerInput,
    callerProvider,
    callerVerifySignature,
    "fixed-price",
  );
}

/** RFQ commitment gate bound to the exact accepted channel checkpoint. */
export async function commitRfqAgreement(
  callerInput: CommitRfqAgreementInput,
  callerProvider: FinalityCommitmentProvider,
  callerVerifySignature: CommitmentSignatureVerifier,
): Promise<FinalizedAgreementCommitment> {
  return commitAgreementForPattern(
    callerInput,
    callerProvider,
    callerVerifySignature,
    "rfq",
  );
}

/**
 * Explicit read-only recovery for pre-ULID DACS-3 v0.1-v0.3 commitments.
 * This path can never submit or upgrade the immutable historical record.
 */
export async function readLegacyFixedPriceAgreementCommitment(
  callerInput: ReadLegacyFixedPriceAgreementCommitmentInput,
  callerReader: FinalityCommitmentReader,
  callerVerifySignature: CommitmentSignatureVerifier,
): Promise<FinalizedLegacyAgreementCommitment> {
  const reader = captureReader(callerReader);
  const verifySignature = captureVerifier(callerVerifySignature);
  const input = captureCommitmentBindingInput(
    callerInput,
    "legacy commitment input",
  );
  const selected = selectFixedPriceArtifact(input, {
    allowLegacyJobId: true,
  });
  const logicalAddress = legacyCommitmentAddress(selected.agreement.jobId);
  const authenticated = validateAuthenticatedSessionBinding(input, selected);
  await verifyAgreementSignatures(selected.agreement, verifySignature);
  const binding = agreementBinding(selected, authenticated, "fixed-price");
  const lookup = await resolveCommitment(logicalAddress, reader);
  if (lookup.disposition === "absent") {
    throw new DacsError("legacy commitment is authoritatively absent");
  }
  const result = await verifyAnchoredCommitment(
    logicalAddress,
    lookup.anchored,
    input,
    selected,
    binding,
    reader.verifyAnchorReceipt,
    verifySignature,
    { resumed: true },
  );
  if (result.recordKind !== "legacy") {
    throw new DacsError(
      "explicit legacy commitment reader refuses a finality record",
    );
  }
  return result;
}

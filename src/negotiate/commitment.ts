import { canonicalize, contentHash, sha256Hex } from "../canonical/index.js";
import { signedBytes, type DomainSeparator } from "../crypto/index.js";
import { DacsError, SubstrateError } from "../errors.js";
import {
  signComponentArtifact,
  type BuildComponentSignatureOptions,
} from "../artifacts/signatures.js";
import type {
  AgreementArtifact,
  AnchorReceipt,
  ChainTxRef,
  ComponentSignature,
  FinalityCommitmentRecord,
  Listing,
  ListingPin,
} from "../artifacts/types.js";
import {
  isAgreementArtifact,
  isAnchorReceipt,
  isChainTxRef,
  isFinalityCommitmentRecord,
  isListing,
} from "../artifacts/validators.js";
import type { VerifiedListingInput } from "./fixedPrice.js";

export const FINALITY_COMMITMENT_SEPARATOR =
  "dacs-finality-commitment:v1:" as const satisfies DomainSeparator;

export type CommitmentVerificationDisposition =
  | "valid"
  | "invalid"
  | "indeterminate"
  | "error";

export interface CommitmentSignatureVerificationInput {
  purpose: "agreement" | "finality-commitment";
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

export interface AnchoredFinalityCommitment {
  record: unknown;
  nativeAddress: string;
  anchorTxRef: ChainTxRef;
  anchorReceipt: AnchorReceipt;
}

export type FinalityCommitmentLookup =
  | { disposition: "present"; anchored: AnchoredFinalityCommitment }
  | { disposition: "absent" }
  | { disposition: "indeterminate"; reason: string };

/**
 * SR-2 boundary. `absent` MUST mean authoritative absence under the binding's
 * declared policy; an ordinary not-found/timeout is `indeterminate` (CORE §5.1).
 */
export interface FinalityCommitmentProvider {
  resolve: (
    logicalAddress: string,
  ) => Promise<FinalityCommitmentLookup> | FinalityCommitmentLookup;
  submit: (
    logicalAddress: string,
    record: FinalityCommitmentRecord,
  ) => Promise<AnchoredFinalityCommitment>;
  /** Authenticate evidence and every substrate-specific transaction/writer/nonce binding. */
  verifyAnchorReceipt: (
    anchored: Readonly<AnchoredFinalityCommitment>,
  ) =>
    | Promise<CommitmentVerificationDisposition>
    | CommitmentVerificationDisposition;
}

export interface CommitFixedPriceAgreementInput {
  agreement: AgreementArtifact;
  verifiedListing: VerifiedListingInput;
  /** Authenticated CORE §B.5 session orchestrator primary claim (CA-6). */
  orchestrator: string;
  /** Record construction time only; never used as authoritative committedAt (CA-8). */
  createdAt: number;
  commitmentSigner: BuildComponentSignatureOptions;
}

export interface FinalizedAgreementCommitment {
  logicalAddress: string;
  nativeAddress: string;
  agreementHash: string;
  record: FinalityCommitmentRecord;
  anchorTxRef: ChainTxRef;
  anchorReceipt: AnchorReceipt;
  /** Derived exclusively from verified `anchorReceipt.blockRef.timestamp`. */
  committedAt: number;
  resumed: boolean;
}

const isSafeTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const exact = (a: unknown, b: unknown): boolean =>
  canonicalize(a) === canonicalize(b);

const listingPinEquals = (a: ListingPin, b: ListingPin): boolean =>
  a.listingId === b.listingId &&
  a.version === b.version &&
  a.contentHash === b.contentHash;

export function finalityCommitmentAddress(jobId: string): string {
  if (typeof jobId !== "string" || jobId.length === 0 || jobId.includes(":")) {
    throw new DacsError("commitment jobId must be a non-empty delimiter-free value");
  }
  return `dacs3:commit:${jobId}`;
}

function expectedDeliverable(listing: Listing): Record<string, unknown> {
  const deliverable = listing.offering.deliverable;
  return {
    deliverableType: deliverable.kind,
    // DACS-4 §9.3 hashes the complete, anchored DeliverableSpec JCS bytes. This
    // is deliberately not the artifact signed-scope helper.
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
      throw new DacsError("zero-pay commitment requires agreement terms.rail to be absent");
    }
  } else {
    if (
      rail === undefined ||
      !(listing.acceptedRails ?? []).some((candidate) => exact(candidate, rail))
    ) {
      throw new DacsError("agreement rail is not an exact acceptedRails member");
    }
    for (const index of indexes) {
      if (listing.pipeline[index]!.parameters?.rail !== rail.railId) {
        throw new DacsError(`pay phase ${index} does not bind the agreement rail`);
      }
    }
  }

  if (!("payeeBoundAgreementVersion" in agreement)) return;
  const expected = new Set(
    indexes.map((index) => `${listing.pipeline[index]!.parameters?.rail}\u0000${index}`),
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
    throw new DacsError("payee-bound agreement does not exactly cover the Listing pay phases");
  }
}

type FixedPriceBindingInput = Pick<
  CommitFixedPriceAgreementInput,
  "agreement" | "verifiedListing" | "createdAt"
>;

function selectFixedPriceArtifact(
  input: Pick<FixedPriceBindingInput, "agreement" | "verifiedListing">,
): { agreement: AgreementArtifact; listing: Listing } {
  const agreement = input.agreement;
  const verified = input.verifiedListing;
  if (verified.disposition !== "verified") {
    throw new DacsError("commitment requires an explicitly verified Listing disposition");
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
  if (!isListing(verified.listing) || !isAgreementArtifact(agreement)) {
    throw new DacsError("commitment input has a non-normative Listing or agreement shape");
  }
  const listing = verified.listing;
  const negotiate = listing.pipeline.filter((phase) =>
    phase.kind.startsWith("negotiate-"),
  );
  const commits = listing.pipeline.filter((phase) => phase.kind.startsWith("commit-"));
  if (
    negotiate.length !== 1 ||
    negotiate[0]!.kind !== "negotiate-fixed-price" ||
    commits.length !== 1
  ) {
    throw new DacsError("Listing does not select one fixed-price commitment pipeline");
  }
  const expectedCommit =
    "agreementVersion" in agreement
      ? "commit-agreement"
      : "commit-payee-bound-agreement";
  if (commits[0]!.kind !== expectedCommit) {
    throw new DacsError("agreement artifact discriminator does not match the commit phase (CA-5)");
  }
  return { agreement, listing };
}

function fixedPriceBinding(
  input: FixedPriceBindingInput,
  selected: ReturnType<typeof selectFixedPriceArtifact>,
): {
  agreementHash: string;
  pin: ListingPin;
  parties: string[];
  deadlineSeconds: number;
} {
  const { agreement, listing } = selected;
  const verified = input.verifiedListing;
  const pin: ListingPin = {
    listingId: listing.listingId,
    version: listing.listingVersion,
    contentHash: contentHash(listing as unknown as Record<string, unknown>),
  };
  if (!listingPinEquals(verified.pin, pin) || !listingPinEquals(agreement.listingRef, pin)) {
    throw new DacsError("agreement commitment does not bind the exact verified Listing pin");
  }
  if (agreement.derivedFromPattern !== "fixed-price") {
    throw new DacsError("this commitment core supports only fixed-price agreements");
  }
  const expectedPrice =
    listing.pricing.kind === "fixed"
      ? listing.pricing.price
      : listing.pricing.kind === "negotiable"
        ? listing.pricing.bandCenter
        : null;
  if (!expectedPrice || !exact(agreement.terms.price, expectedPrice)) {
    throw new DacsError("agreement price is not the exact fixed-price Listing term");
  }
  if (!exact(agreement.terms.deliverable, expectedDeliverable(listing))) {
    throw new DacsError("agreement deliverable does not match the pinned Listing");
  }
  validateRailAndPayoutCoverage(listing, agreement);

  const buyer = agreement.parties.find((party) => party.role === "buyer");
  const seller = agreement.parties.find((party) => party.role === "seller");
  if (
    !buyer ||
    !seller ||
    seller.primaryClaim !== listing.seller.identity.presentedBy
  ) {
    throw new DacsError("agreement parties do not match the pinned Listing seller");
  }
  const deadlineSeconds = listing.terms.deadlineSecAfterCommit;
  if (
    !Number.isSafeInteger(deadlineSeconds) ||
    (deadlineSeconds ?? 0) <= 0 ||
    !isSafeTime(input.createdAt) ||
    agreement.generatedAt > input.createdAt ||
    input.createdAt < listing.validity.notBefore ||
    (listing.validity.notAfter !== undefined &&
      input.createdAt > listing.validity.notAfter)
  ) {
    throw new DacsError("agreement commitment fails its provisional time checks");
  }
  const provisionalLimit = input.createdAt + deadlineSeconds! * 1_000;
  if (!Number.isSafeInteger(provisionalLimit) || agreement.terms.deadline > provisionalLimit) {
    throw new DacsError("agreement deadline exceeds the provisional Listing limit");
  }
  return {
    agreementHash: contentHash(agreement as unknown as Record<string, unknown>),
    pin,
    parties: [buyer.primaryClaim, seller.primaryClaim],
    deadlineSeconds: deadlineSeconds!,
  };
}

/**
 * Pure DACS-3 §8.5.2 fixed-price AgreementArtifact → pinned Listing verifier.
 * `committedAt` is the authenticated CA-8 finality timestamp, never a caller
 * clock. Unsupported negotiation patterns fail closed through `DacsError`.
 */
export function validateFixedPriceAgreementBinding(input: {
  agreement: AgreementArtifact;
  verifiedListing: VerifiedListingInput;
  committedAt: number;
}): ReturnType<typeof fixedPriceBinding> {
  const bindingInput: FixedPriceBindingInput = {
    agreement: input.agreement,
    verifiedListing: input.verifiedListing,
    createdAt: input.committedAt,
  };
  return fixedPriceBinding(bindingInput, selectFixedPriceArtifact(bindingInput));
}

async function requireSignature(
  verifier: CommitmentSignatureVerifier,
  request: CommitmentSignatureVerificationInput,
): Promise<void> {
  let disposition: CommitmentVerificationDisposition;
  try {
    disposition = await verifier(request);
  } catch (error) {
    throw new DacsError(`${request.purpose} signature verification errored`, {
      cause: error,
    });
  }
  if (disposition !== "valid") {
    throw new DacsError(
      `${request.purpose} signature is not verified (${disposition})`,
    );
  }
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
  input: CommitFixedPriceAgreementInput,
  binding: ReturnType<typeof fixedPriceBinding>,
): Omit<FinalityCommitmentRecord, "signature"> {
  return {
    finalityCommitmentVersion: "1",
    jobId: input.agreement.jobId,
    agreementHash: binding.agreementHash,
    listingRef: { ...binding.pin },
    parties: [...binding.parties],
    pattern: "fixed-price",
    createdAt: input.createdAt,
  };
}

function recordMatchesBinding(
  record: FinalityCommitmentRecord,
  input: CommitFixedPriceAgreementInput,
  binding: ReturnType<typeof fixedPriceBinding>,
): boolean {
  return (
    record.jobId === input.agreement.jobId &&
    record.agreementHash === binding.agreementHash &&
    listingPinEquals(record.listingRef, binding.pin) &&
    record.parties.length === binding.parties.length &&
    binding.parties.every((party, index) => record.parties[index] === party) &&
    record.pattern === "fixed-price" &&
    record.signature.signer === input.orchestrator
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

async function finalizedReceiptTime(
  logicalAddress: string,
  anchored: AnchoredFinalityCommitment,
  provider: FinalityCommitmentProvider,
): Promise<number> {
  const record = anchored.record as FinalityCommitmentRecord;
  const receipt = anchored.anchorReceipt;
  if (
    !isAnchorReceipt(receipt) ||
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
    throw new DacsError("commitment receipt is not an exact finalized SR-2 binding");
  }
  let disposition: CommitmentVerificationDisposition;
  try {
    disposition = await provider.verifyAnchorReceipt(anchored);
  } catch (error) {
    throw new SubstrateError("commitment receipt proof verification errored", {
      cause: error,
    });
  }
  if (disposition === "indeterminate" || disposition === "error") {
    throw new SubstrateError(
      `commitment receipt proof is not established (${disposition})`,
    );
  }
  if (disposition !== "valid") {
    throw new DacsError("commitment receipt proof is invalid");
  }
  return receipt.blockRef!.timestamp!;
}

/**
 * DACS-3 §8.6 + CORE §5.1 fixed-price commitment gate. It is deliberately
 * transport-independent and fails closed before any caller may enter DACS-4.
 */
export async function commitFixedPriceAgreement(
  input: CommitFixedPriceAgreementInput,
  provider: FinalityCommitmentProvider,
  verifySignature: CommitmentSignatureVerifier,
): Promise<FinalizedAgreementCommitment> {
  const selected = selectFixedPriceArtifact(input);
  await verifyAgreementSignatures(selected.agreement, verifySignature);
  const binding = fixedPriceBinding(input, selected);
  if (input.commitmentSigner.signer !== input.orchestrator) {
    throw new DacsError("commitment signer is not the authenticated orchestrator (CA-6)");
  }

  const logicalAddress = finalityCommitmentAddress(input.agreement.jobId);
  let lookup: FinalityCommitmentLookup;
  try {
    lookup = await provider.resolve(logicalAddress);
  } catch (error) {
    throw new SubstrateError("commitment lookup errored and is indeterminate", {
      cause: error,
    });
  }
  if (
    !isRecord(lookup) ||
    !["present", "absent", "indeterminate"].includes(
      String(lookup.disposition),
    )
  ) {
    throw new SubstrateError("commitment lookup returned an invalid disposition");
  }
  if (lookup.disposition === "indeterminate") {
    throw new SubstrateError(`commitment lookup is indeterminate: ${lookup.reason}`);
  }

  let anchored: AnchoredFinalityCommitment;
  let resumed = false;
  if (lookup.disposition === "present") {
    anchored = lookup.anchored;
    resumed = true;
  } else {
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
    try {
      anchored = await provider.submit(logicalAddress, record);
    } catch (error) {
      throw new SubstrateError(
        "commitment submission outcome is ambiguous; resolve before any retry",
        { cause: error },
      );
    }
  }

  if (!isRecord(anchored)) {
    throw new SubstrateError("commitment provider returned an invalid anchor result");
  }
  if (
    !isFinalityCommitmentRecord(anchored.record) ||
    !recordMatchesBinding(anchored.record, input, binding)
  ) {
    throw new DacsError(
      "existing commitment is legacy, malformed, or binds different session content (CA-3/CA-9)",
    );
  }
  await verifyCommitmentSignature(anchored.record, verifySignature);
  const committedAt = await finalizedReceiptTime(
    logicalAddress,
    anchored,
    provider,
  );
  const listing = input.verifiedListing.listing;
  const finalizedLimit = committedAt + binding.deadlineSeconds * 1_000;
  if (
    !Number.isSafeInteger(finalizedLimit) ||
    input.agreement.terms.deadline > finalizedLimit ||
    (listing.validity.notAfter !== undefined &&
      listing.validity.notAfter < committedAt)
  ) {
    throw new DacsError(
      "finalized receipt timestamp fails authoritative agreement/Listing checks",
    );
  }

  return {
    logicalAddress,
    nativeAddress: anchored.nativeAddress,
    agreementHash: binding.agreementHash,
    record: anchored.record,
    anchorTxRef: anchored.anchorTxRef,
    anchorReceipt: anchored.anchorReceipt,
    committedAt,
    resumed,
  };
}

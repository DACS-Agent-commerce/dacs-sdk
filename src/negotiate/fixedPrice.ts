import {
  canonicalize,
  contentHash,
} from "../canonical/index.js";
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
} from "../artifacts/types.js";
import {
  isAgreementArtifact,
  isAttestationRef,
  isIdentityBundle,
  isListing,
} from "../artifacts/validators.js";
import { identityBundleHash } from "../identity/bundle.js";

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
  /** Provisional signing-time clock; #99 re-checks deadlines at finalized commit. */
  generatedAt: number;
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

const isSafeTime = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

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
    vetRecordRef: input.vetRecordRef,
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
  input: FixedPriceAgreementInput,
): UnsignedAgreementArtifact {
  const { listing, pin } = input.verifiedListing;
  if (input.verifiedListing.disposition !== "verified") {
    throw new DacsError("fixed-price agreement requires a verified Listing disposition");
  }
  if (!isListing(listing)) throw new DacsError("verified Listing has invalid wire shape");
  if (typeof input.jobId !== "string" || input.jobId.length === 0) {
    throw new DacsError("jobId must be non-empty");
  }
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

  if (listing.pricing.kind !== "fixed") {
    throw new DacsError(
      `${listing.pricing.kind} pricing is unsupported by the fixed-price handler`,
    );
  }
  const price = listing.pricing.price;
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
      hash: contentHash(deliverable as unknown as Record<string, unknown>),
      ...(deliverable.kind === "storage-program" && deliverable.schemaUrl !== undefined
        ? { schemaUrl: deliverable.schemaUrl }
        : {}),
    },
    price: structuredClone(price),
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

function encodedSignature(value: Uint8Array | string): string {
  const encoded =
    typeof value === "string" ? value : Buffer.from(value).toString("base64url");
  if (!isCanonicalBase64Url(encoded)) {
    throw new DacsError("agreement signer returned a non-canonical Base64URL value");
  }
  return encoded;
}

/** Collect the exact buyer + seller DACS-3 §8.5.1 signatures. */
export async function signFixedPriceAgreement(
  draft: UnsignedAgreementArtifact,
  buyerSigner: AgreementSigner,
  sellerSigner: AgreementSigner,
): Promise<AgreementArtifact> {
  if ("signatures" in draft || "signature" in draft) {
    throw new DacsError("agreement draft must not carry signature fields");
  }
  const buyer = draft.parties.find((party) => party.role === "buyer")?.primaryClaim;
  const seller = draft.parties.find((party) => party.role === "seller")?.primaryClaim;
  if (
    !buyer ||
    !seller ||
    buyerSigner.party !== buyer ||
    sellerSigner.party !== seller
  ) {
    throw new DacsError("agreement signers do not match the bound buyer and seller claims");
  }
  const algorithms: ReadonlySet<string> = new Set(COMPONENT_SIGNATURE_ALGORITHMS);
  if (
    !algorithms.has(buyerSigner.algorithm) ||
    !algorithms.has(sellerSigner.algorithm)
  ) {
    throw new DacsError("agreement signer uses an unsupported algorithm");
  }
  const placeholder = Buffer.alloc(64).toString("base64url");
  if (
    !isAgreementArtifact({
      ...draft,
      signatures: [
        { party: buyer, algorithm: buyerSigner.algorithm, value: placeholder },
        { party: seller, algorithm: sellerSigner.algorithm, value: placeholder },
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
  const signatures: AgreementSignature[] = [];
  for (const signer of [buyerSigner, sellerSigner]) {
    const context = { party: signer.party, algorithm: signer.algorithm };
    signatures.push({
      ...context,
      value: encodedSignature(await signer.sign(bytes, context)),
    });
  }
  const signed = { ...draft, signatures } as AgreementArtifact;
  if (!isAgreementArtifact(signed)) {
    throw new DacsError("signed agreement failed exact DACS-3 §8.5 validation");
  }
  return signed;
}

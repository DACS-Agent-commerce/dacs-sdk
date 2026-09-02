import {
  canonicalize,
  contentHash,
  sha256Hex,
} from "../canonical/index.js";
import {
  snapshotCanonicalJson,
  snapshotCanonicalJsonRead,
} from "../canonical/snapshot.js";
import { DacsError } from "../errors.js";
import { identityBundleHash } from "../identity/bundle.js";
import type {
  AgreementArtifact,
  AgreementParty,
  PaymentRailRef,
  PayoutBinding,
} from "../artifacts/types.js";
import {
  isAgreementArtifact,
  isAttestationRef,
  isIdentityBundle,
  isListing,
} from "../artifacts/validators.js";
import {
  signAgreementArtifact,
  type AgreementSigner,
  type UnsignedAgreementArtifact,
  type VerifiedListingInput,
} from "./fixedPrice.js";
import { requireCanonicalJobId } from "./jobId.js";
import {
  rfqSessionCheckpointHash,
  validateRfqProposal,
  type RfqPartyInput,
  type RfqProposal,
  type RfqSessionState,
} from "./rfq.js";

export interface RfqAgreementInput {
  /** Exact accepted, authenticated RFQ checkpoint. */
  session: RfqSessionState;
  /** The same verified Listing authority used to open the session. */
  verifiedListing: VerifiedListingInput;
  /** Exact post-Vet bundles retained for agreement party construction. */
  buyer: RfqPartyInput;
  seller: RfqPartyInput;
  /** Required iff the pinned pipeline contains a pay phase. */
  selectedRail?: PaymentRailRef;
  /** Required only for `commit-payee-bound-agreement`. */
  payoutBindings?: PayoutBinding[];
  /** Provisional signing-time clock; commitment rechecks receipt time. */
  generatedAt: number;
}

type CommitmentKind = "commit-agreement" | "commit-payee-bound-agreement";

const isSafeTime = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

const railEquals = (left: PaymentRailRef, right: PaymentRailRef): boolean =>
  canonicalize(left) === canonicalize(right);

function agreementParty(
  role: "buyer" | "seller",
  input: RfqPartyInput,
): AgreementParty {
  if (!isIdentityBundle(input.identityBundle)) {
    throw new DacsError(`${role} IdentityBundle is not normative`);
  }
  if (!isAttestationRef(input.vetRecordRef)) {
    throw new DacsError(`${role} Vet reference is not normative`);
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

function requirePipeline(listing: VerifiedListingInput["listing"]): {
  commitment: CommitmentKind;
  paymentIndexes: number[];
} {
  const negotiations = listing.pipeline
    .map((phase, index) => ({ phase, index }))
    .filter(({ phase }) => phase.kind.startsWith("negotiate-"));
  if (
    negotiations.length !== 1 ||
    negotiations[0]!.phase.kind !== "negotiate-rfq"
  ) {
    throw new DacsError("RFQ agreement requires exactly one negotiate-rfq phase");
  }
  const commitments = listing.pipeline
    .map((phase, index) => ({ phase, index }))
    .filter(({ phase }) => phase.kind.startsWith("commit-"));
  if (
    commitments.length !== 1 ||
    commitments[0]!.index !== negotiations[0]!.index + 1 ||
    (commitments[0]!.phase.kind !== "commit-agreement" &&
      commitments[0]!.phase.kind !== "commit-payee-bound-agreement")
  ) {
    throw new DacsError(
      "RFQ agreement requires one supported commitment immediately after negotiation",
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
  listing: VerifiedListingInput["listing"],
  selected: PaymentRailRef | undefined,
  paymentIndexes: readonly number[],
): PaymentRailRef | undefined {
  if (paymentIndexes.length === 0) {
    if (selected !== undefined) {
      throw new DacsError("a zero-pay RFQ pipeline MUST omit terms.rail");
    }
    return undefined;
  }
  if (selected === undefined) {
    throw new DacsError("a paid RFQ pipeline requires one selected rail");
  }
  if (!(listing.acceptedRails ?? []).some((rail) => railEquals(rail, selected))) {
    throw new DacsError("selected RFQ rail is not an exact acceptedRails member");
  }
  for (const index of paymentIndexes) {
    if (listing.pipeline[index]!.parameters?.rail !== selected.railId) {
      throw new DacsError(
        `pay phase ${index} does not bind selected rail ${selected.railId}`,
      );
    }
  }
  return structuredClone(selected);
}

function requirePayoutBindings(
  rail: PaymentRailRef | undefined,
  paymentIndexes: readonly number[],
  bindings: readonly PayoutBinding[] | undefined,
): PayoutBinding[] {
  if (rail === undefined || paymentIndexes.length === 0) {
    if ((bindings?.length ?? 0) !== 0) {
      throw new DacsError("RFQ payoutBindings cannot target a non-pay phase");
    }
    return [];
  }
  if (bindings === undefined || bindings.length !== paymentIndexes.length) {
    throw new DacsError("RFQ payoutBindings must cover every pay phase exactly once");
  }
  const expected = new Set(
    paymentIndexes.map((index) => `${rail.railId}\u0000${index}`),
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
      throw new DacsError(
        "RFQ payoutBindings contain a missing, duplicate, or extra pay tuple",
      );
    }
    seen.add(key);
  }
  return bindings.map((binding) => ({ ...binding }));
}

function assertSessionAuthority(
  session: RfqSessionState,
  input: RfqAgreementInput,
  buyer: AgreementParty,
  seller: AgreementParty,
): void {
  // This validates the complete persisted-state grammar before any accepted
  // values are projected into a signed artifact.
  rfqSessionCheckpointHash(session);
  if (
    session.status !== "accepted" ||
    session.standingProposal === undefined ||
    session.lastMessageHash === undefined
  ) {
    throw new DacsError("RFQ agreement requires an accepted session checkpoint");
  }
  const { listing, pin } = input.verifiedListing;
  if (
    canonicalize(session.listingPin) !== canonicalize(pin) ||
    canonicalize(session.pricing) !== canonicalize(listing.pricing)
  ) {
    throw new DacsError("RFQ session does not match the exact Listing authority");
  }
  if (
    session.buyer.primaryClaim !== buyer.primaryClaim ||
    session.buyer.bundleHash !== buyer.bundleHash ||
    canonicalize(session.buyer.vetRecordRef) !==
      canonicalize(buyer.vetRecordRef) ||
    session.seller.primaryClaim !== seller.primaryClaim ||
    session.seller.bundleHash !== seller.bundleHash ||
    canonicalize(session.seller.vetRecordRef) !==
      canonicalize(seller.vetRecordRef)
  ) {
    throw new DacsError("RFQ agreement parties differ from the admitted session");
  }
  acceptedProposal(session);
}

function acceptedProposal(session: RfqSessionState): Readonly<RfqProposal> {
  const standing = session.standingProposal;
  if (standing === undefined) {
    throw new DacsError("RFQ session has no standing proposal");
  }
  return validateRfqProposal(
    {
      rfqProposalVersion: standing.rfqProposalVersion,
      price: standing.price,
      ...(standing.meteredQuantity === undefined
        ? {}
        : { meteredQuantity: standing.meteredQuantity }),
    },
    session.pricing,
  );
}

/**
 * DACS-3 §8.4.2 step 4 pure agreement derivation. The price and quantity come
 * only from the authenticated proposal accepted by the session reducer.
 */
export function deriveRfqAgreement(
  callerInput: RfqAgreementInput,
): UnsignedAgreementArtifact {
  const input = snapshotCanonicalJsonRead(callerInput, "RFQ agreement input");
  const { listing, pin } = input.verifiedListing;
  if (input.verifiedListing.disposition !== "verified" || !isListing(listing)) {
    throw new DacsError("RFQ agreement requires an exact verified Listing");
  }
  requireCanonicalJobId(input.session.jobId, "RFQ agreement jobId");
  const exactHash = contentHash(listing as unknown as Record<string, unknown>);
  if (
    pin.listingId !== listing.listingId ||
    pin.version !== listing.listingVersion ||
    pin.contentHash !== exactHash
  ) {
    throw new DacsError("RFQ Listing pin does not match the exact verified bytes");
  }
  if (
    !isSafeTime(input.generatedAt) ||
    input.generatedAt < input.session.startedAt ||
    input.generatedAt < listing.validity.notBefore ||
    (listing.validity.notAfter !== undefined &&
      input.generatedAt > listing.validity.notAfter)
  ) {
    throw new DacsError("RFQ agreement generation time is invalid");
  }
  const deadlineSec = listing.terms.deadlineSecAfterCommit;
  if (!Number.isSafeInteger(deadlineSec) || (deadlineSec ?? 0) <= 0) {
    throw new DacsError("deadlineSecAfterCommit must be a positive integer");
  }
  const deadline = input.generatedAt + deadlineSec! * 1_000;
  if (!Number.isSafeInteger(deadline)) {
    throw new DacsError("derived RFQ deadline overflows unix ms");
  }

  const buyer = agreementParty("buyer", input.buyer);
  const seller = agreementParty("seller", input.seller);
  if (
    buyer.primaryClaim === seller.primaryClaim ||
    seller.primaryClaim !== listing.seller.identity.presentedBy
  ) {
    throw new DacsError("RFQ agreement parties do not match Listing roles");
  }
  assertSessionAuthority(input.session, input, buyer, seller);
  const accepted = acceptedProposal(input.session);
  const { commitment, paymentIndexes } = requirePipeline(listing);
  const rail = requireRail(listing, input.selectedRail, paymentIndexes);
  const deliverable = listing.offering.deliverable;
  const commonTerms = {
    deliverable: {
      deliverableType: deliverable.kind,
      hash: sha256Hex(canonicalize(deliverable)),
      ...(deliverable.kind === "storage-program" &&
      deliverable.schemaUrl !== undefined
        ? { schemaUrl: deliverable.schemaUrl }
        : {}),
    },
    price: structuredClone(accepted.price),
    ...(accepted.meteredQuantity === undefined
      ? {}
      : { meteredQuantity: structuredClone(accepted.meteredQuantity) }),
    ...(rail === undefined ? {} : { rail }),
    deadline,
  };
  const common = {
    jobId: input.session.jobId,
    listingRef: { ...pin },
    parties: [buyer, seller],
    derivedFromPattern: "rfq" as const,
    derivedFromChannel: {
      subnet: input.session.channelId,
      lastMessageHash: input.session.lastMessageHash!,
    },
    generatedAt: input.generatedAt,
  };
  const draft: UnsignedAgreementArtifact =
    commitment === "commit-agreement"
      ? (() => {
          if ((input.payoutBindings?.length ?? 0) !== 0) {
            throw new DacsError("AgreementDocument MUST NOT carry payoutBindings");
          }
          return { agreementVersion: "1", ...common, terms: commonTerms };
        })()
      : {
          payeeBoundAgreementVersion: "1",
          ...common,
          terms: {
            ...commonTerms,
            payoutBindings: requirePayoutBindings(
              rail,
              paymentIndexes,
              input.payoutBindings,
            ),
          },
        };

  const placeholder = Buffer.alloc(64).toString("base64url");
  if (
    !isAgreementArtifact({
      ...draft,
      signatures: [
        { party: buyer.primaryClaim, algorithm: "ed25519", value: placeholder },
        { party: seller.primaryClaim, algorithm: "ed25519", value: placeholder },
      ],
    })
  ) {
    throw new DacsError("derived RFQ agreement failed exact artifact validation");
  }
  return structuredClone(draft);
}

/** Collect the required buyer + seller signatures for an RFQ-derived draft. */
export async function signRfqAgreement(
  callerDraft: UnsignedAgreementArtifact,
  buyerSigner: AgreementSigner,
  sellerSigner: AgreementSigner,
): Promise<AgreementArtifact> {
  const draft = snapshotCanonicalJson(callerDraft, "unsigned RFQ agreement");
  if (
    draft.derivedFromPattern !== "rfq" ||
    draft.derivedFromChannel === undefined ||
    !/^[0-9a-f]{64}$/.test(draft.derivedFromChannel.lastMessageHash)
  ) {
    throw new DacsError(
      "RFQ agreement must bind its authenticated channel transcript",
    );
  }
  return signAgreementArtifact(draft, buyerSigner, sellerSigner);
}

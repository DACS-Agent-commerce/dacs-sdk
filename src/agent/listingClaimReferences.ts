import type {
  Listing,
  ListingDraft,
  ListingEnvelope,
  ReadableListing,
} from "../artifacts/types.js";
import { parseCanonicalClaimReference } from "../identity/claimReference.js";

/**
 * CORE §B.1 CF-2 gate for every ClaimReference embedded by a normative
 * DACS-1 §6.3.4 Listing producer, including the §6.3.1 prohibition on
 * emitting native `demos:0x` notation. Authorization and ordered Listing
 * admission remain separate checks.
 */
export function listingDraftClaimReferencesArePublishable(
  listing: Readonly<ListingDraft>,
): boolean {
  return normativeListingClaimReferences(listing).every((reference) => {
    const parsed = parseCanonicalClaimReference(reference);
    return parsed !== null && !(
      parsed.identity.scheme === "demos" &&
      /^0x[0-9a-fA-F]{64}$/i.test(parsed.identity.identifier)
    );
  });
}

/** Exact signed/read form, including the Listing signature's signer. */
export function readableListingClaimReferencesAreCanonical(
  readable: Readonly<ReadableListing>,
): boolean {
  if (readable.compatibility === "legacy-mvp") {
    return parseCanonicalClaimReference(readable.listing.agentId) !== null;
  }
  return normativeListingClaimReferences(readable.listing).every(
    (reference) => parseCanonicalClaimReference(reference) !== null,
  );
}

function normativeListingClaimReferences(
  listing: Readonly<ListingDraft | Listing | ListingEnvelope>,
): string[] {
  const identity = listing.seller.identity;
  const presentationReferences = identity.presentation.kind === "per-claim"
    ? identity.presentation.signatures.map((signature) => signature.ref)
    : identity.presentation.kind === "sr1-root"
      ? [identity.presentation.rootClaim]
      : [];
  const deliverable = listing.offering.deliverable;
  const method = "verificationMethod" in deliverable
    ? deliverable.verificationMethod
    : undefined;
  const issuerReferences = method?.kind === "verifiable-credential"
    ? method.issuerAllowList ?? []
    : [];
  const signatureReferences = "signature" in listing
    ? [listing.signature.signer]
    : [];
  return [
    identity.presentedBy,
    ...identity.claims.map((claim) => claim.ref),
    ...presentationReferences,
    ...issuerReferences,
    ...signatureReferences,
  ];
}

import {
  isListing,
  isListingDraft,
  type Listing,
  type ListingDraft,
} from "@kynesyslabs/dacs/artifacts";
import { canonicalize, contentHash, sha256Hex } from "@kynesyslabs/dacs/canonical";

const OFFER_GROUP_DOMAIN = "dacs-node-listing-offer-group:v1:" as const;

export type DacsListingRailProfileV1 = "pay-dem" | "x402";

export interface DacsListingOfferVariantV1 {
  profile: DacsListingRailProfileV1;
  listingId: string;
  listingVersion: number;
  listingContentHash: string;
}

export interface DacsListingOfferManifestV1 {
  manifestVersion: "1";
  offerGroup: string;
  variants: readonly Readonly<DacsListingOfferVariantV1>[];
}

export class DacsListingOfferError extends Error {
  override readonly name = "DacsListingOfferError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Classify only the deliberately narrow one-click fixed-price profiles. A
 * Listing with multiple rails, multiple payment phases, or a mismatched phase
 * is never guessed into one of these profiles.
 */
export function dacsListingRailProfileV1(
  listing: Readonly<Listing | ListingDraft>,
): DacsListingRailProfileV1 | undefined {
  if (!isListing(listing) && !isListingDraft(listing)) return undefined;
  const rails = listing.acceptedRails;
  if (!Array.isArray(rails) || rails.length !== 1) return undefined;
  const payments = listing.pipeline.filter((phase) =>
    phase.kind === "pay-dem" || phase.kind === "pay-x402");
  const payment = payments[0];
  if (payments.length !== 1 || payment === undefined ||
      payment.parameters?.rail !== rails[0]?.railId) {
    return undefined;
  }
  return payment.kind === "pay-dem" ? "pay-dem" : "x402";
}

/**
 * Compute a non-authoritative presentation group for sibling Listings. The
 * group excludes price, rail, pipeline, Listing slot and signature, while
 * retaining the exact seller, service, requirements, terms and live interval.
 * Buyers still fetch and authenticate the selected Listing independently.
 */
export function dacsListingOfferGroupV1(
  listing: Readonly<Listing | ListingDraft>,
): string {
  if (!isListing(listing) && !isListingDraft(listing)) {
    throw new TypeError("Listing offer group input is invalid");
  }
  return sha256Hex(`${OFFER_GROUP_DOMAIN}${canonicalize({
    dacsVersion: listing.dacsVersion,
    seller: listing.seller,
    offering: listing.offering,
    buyerRequirement: listing.buyerRequirement,
    terms: listing.terms,
    validity: listing.validity,
  })}`);
}

/**
 * Close a seller's one-click multirail offer manifest. This is UI/discovery
 * metadata only: session admission remains bound to one exact Listing hash.
 */
export function createDacsListingOfferManifestV1(
  listings: readonly Readonly<Listing>[],
): Readonly<DacsListingOfferManifestV1> {
  if (!Array.isArray(listings) || listings.length === 0 || listings.length > 2 ||
      listings.some((listing) => !isListing(listing))) {
    throw new TypeError("Listing offer manifest input is invalid");
  }
  const groups = new Set(listings.map(dacsListingOfferGroupV1));
  const variants = listings.map((listing) => {
    const profile = dacsListingRailProfileV1(listing);
    if (profile === undefined) {
      throw new DacsListingOfferError("listing-offer-profile-invalid");
    }
    return {
      profile,
      listingId: listing.listingId,
      listingVersion: listing.listingVersion,
      listingContentHash: contentHash(listing as unknown as Record<string, unknown>),
    };
  }).sort((left, right) => left.profile.localeCompare(right.profile));
  if (groups.size !== 1 || new Set(variants.map((variant) => variant.profile)).size !==
        variants.length ||
      new Set(variants.map((variant) => variant.listingId)).size !== variants.length) {
    throw new DacsListingOfferError("listing-offer-siblings-invalid");
  }
  return deepFreeze({
    manifestVersion: "1",
    offerGroup: [...groups][0]!,
    variants,
  });
}

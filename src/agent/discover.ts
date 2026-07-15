import { stripSignature } from "../canonical/index.js";
import type { Listing } from "../artifacts/types.js";
import { isListing } from "../artifacts/validators.js";

/**
 * Verify an anchored listing's signature against the advertised seller (#41).
 * Given the resolved signed listing and its seller id, return true iff the
 * listing's signature verifies under the seller's key — so a forged or tampered
 * listing can't enter discovery/settlement. Wire `resolvePublicKey` +
 * `verifySignedArtifact` here; return true only on a positive verification.
 */
export type VerifyListingSignature = (
  signed: Record<string, unknown>,
  sellerId: string,
) => Promise<boolean> | boolean;

/**
 * Resolve + structurally validate anchored listings at the given refs (the core
 * of Agent.discover). Refs are caller-supplied — a marketplace crawl needs an
 * indexer the deterministic substrate doesn't provide. Missing refs and
 * anything that isn't a well-formed Listing are skipped, so the result holds
 * only usable listings paired with the ref they came from.
 *
 * When `verifyListing` is supplied, a listing is ALSO required to carry a valid
 * signature by its advertised seller (`listing.agentId`) — a forged/unsigned/
 * tampered listing is dropped, not returned (#41). Omitting it keeps the old
 * structural-only behaviour, but a marketplace caller SHOULD wire it: a listing
 * drives negotiation, rail/recipient config, and payment.
 */
export async function discoverListings(
  listingRefs: string[],
  readAnchor: (ref: string) => Promise<Record<string, unknown> | null>,
  verifyListing?: VerifyListingSignature,
): Promise<Array<{ ref: string; listing: Listing }>> {
  const found: Array<{ ref: string; listing: Listing }> = [];
  for (const ref of listingRefs) {
    const raw = await readAnchor(ref);
    if (!raw) continue;
    const scope = stripSignature(raw);
    if (!isListing(scope)) continue;
    if (verifyListing) {
      const sellerId = (scope as unknown as Listing).agentId;
      if (!(await verifyListing(raw, sellerId))) continue; // unsigned/forged → drop
    }
    found.push({ ref, listing: scope as unknown as Listing });
  }
  return found;
}

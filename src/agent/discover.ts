import { stripSignature } from "../canonical/index.js";
import type { Listing } from "../artifacts/types.js";
import { isListing } from "../artifacts/validators.js";

/**
 * Resolve + structurally validate anchored listings at the given refs (the core
 * of Agent.discover). Refs are caller-supplied — a marketplace crawl needs an
 * indexer the deterministic substrate doesn't provide. Missing refs and
 * anything that isn't a well-formed Listing are skipped, so the result holds
 * only usable listings paired with the ref they came from.
 */
export async function discoverListings(
  listingRefs: string[],
  readAnchor: (ref: string) => Promise<Record<string, unknown> | null>,
): Promise<Array<{ ref: string; listing: Listing }>> {
  const found: Array<{ ref: string; listing: Listing }> = [];
  for (const ref of listingRefs) {
    const raw = await readAnchor(ref);
    if (!raw) continue;
    const scope = stripSignature(raw);
    if (isListing(scope)) {
      found.push({ ref, listing: scope as unknown as Listing });
    }
  }
  return found;
}

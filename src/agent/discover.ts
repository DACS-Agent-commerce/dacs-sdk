import { stripSignature } from "../canonical/index.js";
import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import type { Listing } from "../artifacts/types.js";
import { isListing } from "../artifacts/validators.js";
import { DacsError } from "../errors.js";
import { demosAgentPublicKey } from "../identity/index.js";
import { verifySignedArtifact, type Verifier } from "./signedArtifact.js";

/**
 * Resolve, structurally validate, and VERIFY anchored listings at the given refs
 * (the core of Agent.discover). Refs are caller-supplied — a marketplace crawl
 * needs an indexer the deterministic substrate doesn't provide.
 *
 * Signature verification is load-bearing (#41): a listing drives negotiation,
 * vetting, rail/recipient selection and ultimately payment, so a forged or
 * tampered listing that reaches discovery output can steer real money. Every
 * listing is therefore verified before it is returned, and anything that fails
 * is SKIPPED rather than surfaced.
 *
 * SIGNER↔SELLER BINDING is intrinsic: a Demos primary claim *is* the signer's
 * ed25519 public key, so we verify against the key embedded in the listing's own
 * `agentId`. A signature that verifies therefore proves the advertised seller
 * signed this exact content — there is no separate signer field to trust, and a
 * valid signature lifted from another seller's listing fails.
 *
 * Fails CLOSED: a missing, malformed, wrong-key or tampered signature drops the
 * listing. A seller claim that doesn't embed a resolvable key is also dropped
 * (we cannot establish who signed it). The gate is REQUIRED — pass `verify`, or
 * set `trustListings: true` to opt out explicitly when listings were verified
 * upstream. Neither → throws, because silently returning unverified listings is
 * the fail-open trap this exists to close.
 */

export interface DiscoverDeps {
  /** Verify a signature over raw bytes for a public key. */
  verify?: Verifier;
  /**
   * Resolve a seller claim to its ed25519 public key. Defaults to the intrinsic
   * registered Demos form (`did:demos:agent:<64-lowercase-hex>`; the leading
   * `did` scheme is case-insensitive on read). Return null for a claim whose
   * key cannot be established.
   */
  resolvePublicKey?: (claim: string) => Promise<Uint8Array | null> | Uint8Array | null;
  /**
   * Explicit, grep-able opt-out of verification. Only for callers that already
   * verified the listings. Ignored when `verify` is supplied.
   */
  trustListings?: boolean;
}

export async function discoverListings(
  listingRefs: string[],
  readAnchor: (ref: string) => Promise<Record<string, unknown> | null>,
  deps: DiscoverDeps = {},
): Promise<Array<{ ref: string; listing: Listing }>> {
  if (!deps.verify && !deps.trustListings) {
    throw new DacsError(
      "discoverListings requires deps.verify or an explicit deps.trustListings: true opt-out — " +
        "returning unverified listings lets a forged listing drive negotiation and payment (#41)",
    );
  }
  const resolveKey = deps.resolvePublicKey ?? demosAgentPublicKey;

  const found: Array<{ ref: string; listing: Listing }> = [];
  for (const ref of listingRefs) {
    const raw = await readAnchor(ref);
    if (!raw) continue;
    const scope = stripSignature(raw);
    if (!isListing(scope)) continue;
    const listing = scope as unknown as Listing;

    if (deps.verify) {
      // Bind to the ADVERTISED seller: verify against the key in listing.agentId.
      // Key resolution AND verification are BOTH inside the guard — a throwing or
      // unresolvable resolver drops just this listing, never the whole batch, so
      // one malformed entry can't deny discovery of every later valid listing.
      let ok = false;
      try {
        const key = await resolveKey(listing.agentId);
        if (key && key.length === 32) {
          ok = await verifySignedArtifact(raw, ARTIFACT_SEPARATORS.Listing, key, deps.verify);
        }
      } catch {
        ok = false; // unresolvable/malformed → fail closed, never throw out of discovery
      }
      if (!ok) continue;
    }
    found.push({ ref, listing });
  }
  return found;
}

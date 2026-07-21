import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import type { Listing } from "../artifacts/types.js";
import { contentHash, listingAddress, listingStorageName, stripSignature } from "../canonical/index.js";
import { DacsError } from "../errors.js";
import { buildSignedArtifact, type Signer } from "./signedArtifact.js";

/**
 * Publish a DACS-1 listing at its VERSIONED §6.3.4 address, with write-once
 * version-slot immutability (#29 / #46). Pure over injected substrate deps, so
 * it's unit-tested without a node; Agent.publishListing wires the DemosAdapter.
 *
 * Rules enforced:
 *  - `listingVersion` MUST be a positive integer ≥ 1 (§6.3.4) — 0 / fractional /
 *    negative are rejected. Absent → the initial version 1.
 *  - The version slot is WRITE-ONCE: read the target before anchoring. A
 *    byte/content-identical re-publish is an idempotent retry (allowed); DIFFERENT
 *    content at an existing version is REJECTED — overwriting it would silently
 *    orphan every bundle that pinned that version's content hash. To change a
 *    listing the seller publishes a NEW version at a new address.
 *
 * Addressing (§6.3.4): the colon-bearing LOGICAL address is separated from the
 * colon-free NATIVE storage-program name (Demos rejects `:` in program names).
 * We anchor under `listingStorageName(logicalAddress)` and RETURN the logical
 * address + native name as the discovery binding — the mapping is deterministic,
 * so a consumer holding the logical address re-derives the native name and reads
 * the slot without a separate catalog.
 *
 * NOT enforced here (tracked follow-up): monotonicity / no-gaps (versions
 * increase by exactly 1, no skips). That needs a latest-version index the
 * deterministic substrate doesn't expose — so full §6.3.4 closure is NOT claimed.
 */

export interface PublishListingResult {
  /** Native storage address the listing version was anchored at (or already lived at). */
  ref: string;
  /** §6.3.4 colon-bearing LOGICAL address (the discovery key / metadata). */
  logicalAddress: string;
  /** Colon-free NATIVE storage-program name the logical address binds to. */
  storageName: string;
  txRef?: string;
}

export interface PublishListingDeps {
  /** Sign the listing artifact under its domain separator. */
  sign: Signer;
  /** Deterministic storage address for a logical name (without writing). */
  anchorAddress: (name: string) => string;
  /** Read the artifact anchored at an address (null if absent). */
  readAnchor: (address: string) => Promise<Record<string, unknown> | null>;
  /** Anchor a value under a name; returns the storage address + optional txRef. */
  anchor: (name: string, value: object) => Promise<{ address: string; txRef?: string }>;
}

export async function publishListingCore(
  listing: Listing,
  deps: PublishListingDeps,
): Promise<PublishListingResult> {
  const version = listing.listingVersion ?? 1;
  if (!Number.isInteger(version) || version < 1) {
    throw new DacsError(
      `listingVersion must be a positive integer ≥ 1 (§6.3.4), got ${version}`,
    );
  }

  const signed = await buildSignedArtifact(listing, ARTIFACT_SEPARATORS.Listing, deps.sign);
  // The colon-bearing logical address is the discovery key; the colon-free native
  // name is what actually goes to the substrate (Demos rejects `:` in names).
  const logicalAddress = listingAddress(listing.agentId, listing.serviceId, version);
  const storageName = listingStorageName(logicalAddress);
  const address = deps.anchorAddress(storageName);

  const existing = await deps.readAnchor(address);
  if (existing) {
    const identical =
      contentHash(stripSignature(existing)) ===
      contentHash(stripSignature(signed as unknown as Record<string, unknown>));
    if (!identical) {
      throw new DacsError(
        `listing "${listing.serviceId}" version ${version} is already anchored with different content — ` +
          `a version slot is immutable; publish a new listingVersion instead of overwriting it (§6.3.4, #46)`,
      );
    }
    // idempotent re-publish of the byte-identical version
    return { ref: address, logicalAddress, storageName };
  }

  const { address: anchored, txRef } = await deps.anchor(storageName, signed);
  return { ref: anchored, logicalAddress, storageName, txRef };
}

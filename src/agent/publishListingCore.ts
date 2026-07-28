import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import type { Listing } from "../artifacts/types.js";
import {
  contentHash,
  listingAddress,
  logicalToStorageProgramName,
  stripSignature,
} from "../canonical/index.js";
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
 * Addressing (§6.3.4 Demos binding): the logical listing address is colon-bearing
 * (`dacs1:<claim>:<listingId>:v<n>`), but Demos requires colon-free program names.
 * The name anchored under is therefore `logicalToStorageProgramName(logical)` —
 * this SDK's implementation-defined colon-free name (the spec mandates only that
 * the name be colon-free and treated as an opaque write input, NOT a specific
 * or reversible encoding) — and the result RETURNS the binding
 * — `logicalAddress` + the native `ref` — so the logical→native mapping is
 * discoverable (spec point (c), via return). Carrying the logical address as
 * on-record metadata + a published index (points (b)/(c)-via-index) is the fuller
 * discovery surface, tracked with #54.
 *
 * NOT enforced here (tracked follow-up): monotonicity / no-gaps (versions
 * increase by exactly 1, no skips). That needs a latest-version index the
 * deterministic substrate doesn't expose — so full §6.3.4 closure is NOT claimed.
 */

export interface PublishListingResult {
  /** Native storage address the listing version was anchored at (or already lived at). */
  ref: string;
  /** §6.3.4 colon-bearing LOGICAL address — the discovery key / metadata. */
  logicalAddress: string;
  /** Colon-free NATIVE storage-program name the logical address encodes to. */
  storageName: string;
  txRef?: string;
}

export interface PublishListingDeps {
  /** Sign the listing artifact under its domain separator. */
  sign: Signer;
  /** The storage address a name would anchor to (without writing) — async (#70). */
  anchorAddress: (name: string) => Promise<string>;
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
  // Logical (colon-bearing, discovery key) vs native (colon-free program name the
  // substrate actually accepts). Anchor under the encoded name; return both.
  const logicalAddress = listingAddress(listing.agentId, listing.serviceId, version);
  const storageName = logicalToStorageProgramName(logicalAddress);
  const address = await deps.anchorAddress(storageName);

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

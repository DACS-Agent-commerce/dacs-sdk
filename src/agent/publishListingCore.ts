import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import type { Listing } from "../artifacts/types.js";
import { listingAddress, logicalToStorageProgramName } from "../canonical/index.js";
import { DacsError, SubstrateError } from "../errors.js";
import type { OwnedAnchorScan } from "../substrate/anchorResolution.js";
import { buildSignedArtifact, type Signer } from "./signedArtifact.js";

/**
 * Publish a DACS-1 listing at its VERSIONED §6.3.4 address, with write-once
 * version-slot immutability (#29 / #46). Pure over injected substrate deps, so
 * it's unit-tested without a node; Agent.publishListing wires the DemosAdapter.
 *
 * Rules enforced:
 *  - `listingVersion` MUST be a positive integer ≥ 1 (§6.3.4) — 0 / fractional /
 *    negative are rejected. Absent → the initial version 1.
 *  - Versions MUST be contiguous and monotonic: an absent target may be created
 *    only when it is exactly `max(existing versions) + 1`, and the visible
 *    owner-bound history must contain every version from 1 through max.
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
  /**
   * Owner-bound, fail-closed scan used to enforce the §6.3.4 monotonic/no-gap
   * rule before attempting an immutable version create.
   */
  scanOwnAnchorsByNamePrefix: (prefix: string) => Promise<OwnedAnchorScan>;
  /**
   * Owner-bound, fail-closed immutable publication seam. It resolves existing
   * programs by name, returns signed-scope-identical retries, rejects changed
   * content, and uses a create-only path when absent.
   */
  anchorWriteOnce: (
    name: string,
    value: object,
  ) => Promise<{ address: string; txRef?: string }>;
}

function listingHistoryPrefix(listing: Listing): string {
  // Passing the already-prefixed version token "v" yields the logical prefix
  // `...:v`; the storage binding is idempotently colon-encoded.
  return logicalToStorageProgramName(
    listingAddress(listing.agentId, listing.serviceId, "v"),
  );
}

function assertContiguousHistory(
  listing: Listing,
  prefix: string,
  scan: OwnedAnchorScan,
): Set<number> {
  if (scan.status === "indeterminate") {
    throw new SubstrateError(
      `listing version history lookup was indeterminate (${scan.reason})`,
    );
  }

  const versions = new Set<number>();
  for (const anchor of scan.anchors) {
    if (!anchor.programName.startsWith(prefix)) continue;
    const suffix = anchor.programName.slice(prefix.length);
    if (!/^[1-9]\d*$/.test(suffix)) continue;
    const version = Number(suffix);
    if (!Number.isSafeInteger(version)) {
      throw new DacsError(
        `listing history contains an unsafe version suffix: ${suffix}`,
      );
    }
    if (versions.has(version)) {
      throw new DacsError(
        `listing history contains duplicate owner-bound anchors for version ${version}`,
      );
    }

    const storedVersion = anchor.value["listingVersion"] ?? 1;
    if (
      anchor.value["agentId"] !== listing.agentId ||
      anchor.value["serviceId"] !== listing.serviceId ||
      storedVersion !== version
    ) {
      throw new DacsError(
        `listing history anchor ${anchor.address} does not match its owner-bound ` +
          `listing/version name`,
      );
    }
    versions.add(version);
  }

  const ordered = [...versions].sort((a, b) => a - b);
  for (let index = 0; index < ordered.length; index += 1) {
    const expected = index + 1;
    if (ordered[index] !== expected) {
      throw new DacsError(
        `listing version history has a gap: expected v${expected}, found v${ordered[index]}`,
      );
    }
  }
  return versions;
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

  // Logical (colon-bearing, discovery key) vs native (colon-free program name the
  // substrate actually accepts). Anchor under the encoded name; return both.
  const logicalAddress = listingAddress(listing.agentId, listing.serviceId, version);
  const storageName = logicalToStorageProgramName(logicalAddress);
  const historyPrefix = listingHistoryPrefix(listing);
  const versions = assertContiguousHistory(
    listing,
    historyPrefix,
    await deps.scanOwnAnchorsByNamePrefix(historyPrefix),
  );
  if (!versions.has(version)) {
    const expected = versions.size + 1;
    if (version !== expected) {
      throw new DacsError(
        `listingVersion must advance monotonically without gaps: expected ${expected}, got ${version}`,
      );
    }
  }

  const signed = await buildSignedArtifact(
    listing,
    ARTIFACT_SEPARATORS.Listing,
    deps.sign,
  );
  const { address: anchored, txRef } = await deps.anchorWriteOnce(storageName, signed);
  return { ref: anchored, logicalAddress, storageName, txRef };
}

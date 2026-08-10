import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import { signComponentArtifact } from "../artifacts/signatures.js";
import type { ListingDraft, ListingPin } from "../artifacts/types.js";
import {
  isListing,
  isListingDraft,
  readListingArtifact,
} from "../artifacts/validators.js";
import {
  canonicalize,
  contentHash,
  listingAddress,
  logicalToStorageProgramName,
  sha256Hex,
} from "../canonical/index.js";
import { DacsError, SubstrateError } from "../errors.js";
import type { OwnedAnchorScan } from "../substrate/anchorResolution.js";
import type { Signer } from "./signedArtifact.js";
import {
  resolveListingPayloadVerificationCapability,
  resolveListingRails,
  type ListingRailAuthorityInput,
  type PayloadVerificationCapabilityResolver,
} from "./listingValidation.js";

/**
 * Publish a DACS-1 listing at its VERSIONED §6.3.4 address, with write-once
 * version-slot immutability (#29 / #46). Pure over injected substrate deps, so
 * it's unit-tested without a node; Agent.publishListing wires the DemosAdapter.
 *
 * Rules enforced:
 *  - `listingVersion` MUST be a positive integer ≥ 1 (§6.3.4) — 0 / fractional /
 *    negative are rejected.
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
  /** DACS-1 §6.3.4 LR-1 tuple for the exact signed Listing version. */
  listingPin: ListingPin;
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
  /**
   * DACS-1 §6.3.4 LP-6 authenticated listing-time rail authority. Required
   * for pay-bearing publication; the listing is not signed or anchored unless
   * LRR-1..LRR-6 return `verified`.
   */
  loadRailResolution?: (
    listing: Readonly<ListingDraft>,
  ) => Promise<ListingRailAuthorityInput> | ListingRailAuthorityInput;
  /**
   * DACS-4 DPA-1 producer capability. A recognized method discriminator is not
   * sufficient: the local seller must be able to bind the exact payload bytes.
   */
  resolvePayloadVerificationCapability?: PayloadVerificationCapabilityResolver;
}

function listingHistoryPrefix(listing: ListingDraft): string {
  // Passing the already-prefixed version token "v" yields the logical prefix
  // `...:v`; the storage binding is idempotently colon-encoded.
  return logicalToStorageProgramName(
    listingAddress(
      listing.seller.identity.presentedBy,
      listing.listingId,
      "v",
    ),
  );
}

function isOwnedAnchorScanValue(value: unknown): value is OwnedAnchorScan {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const scan = value as Record<string, unknown>;
  if (scan.status === "indeterminate") {
    return Object.keys(scan).every((key) => key === "status" || key === "reason") &&
      typeof scan.reason === "string" && scan.reason.length > 0;
  }
  if (scan.status !== "ok" ||
      Object.keys(scan).some((key) => key !== "status" && key !== "anchors") ||
      !Array.isArray(scan.anchors)) return false;
  return scan.anchors.every((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    const anchor = entry as Record<string, unknown>;
    return Object.keys(anchor).every((key) => [
      "address",
      "programName",
      "value",
    ].includes(key)) &&
      typeof anchor.address === "string" && anchor.address.length > 0 &&
      typeof anchor.programName === "string" && anchor.programName.length > 0 &&
      anchor.value !== null && typeof anchor.value === "object" &&
      !Array.isArray(anchor.value);
  });
}

function assertContiguousHistory(
  listing: ListingDraft,
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

    const stored = readListingArtifact(anchor.value);
    if (!stored) {
      throw new DacsError(
        `listing history anchor ${anchor.address} is not a readable signed Listing`,
      );
    }
    // DACS-1 §6.3.4 prior versions remain readable. Historical reduced MVP
    // versions participate only through this explicit read compatibility arm;
    // the new version written below must still be normative.
    const storedPublisher =
      stored.compatibility === "normative"
        ? stored.listing.seller.identity.presentedBy
        : stored.listing.agentId;
    const storedId =
      stored.compatibility === "normative"
        ? stored.listing.listingId
        : stored.listing.serviceId;
    const storedVersion = stored.listing.listingVersion ?? 1;
    if (
      storedPublisher !== listing.seller.identity.presentedBy ||
      storedId !== listing.listingId ||
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
  listing: ListingDraft,
  deps: PublishListingDeps,
): Promise<PublishListingResult> {
  let candidate: ListingDraft;
  try {
    // Own one exact snapshot for the whole async publication. Capability and
    // authority adapters receive separate clones, so caller/dependency mutation
    // can never swap the method/spec after DPA-1 approval but before signing.
    candidate = structuredClone(listing);
  } catch {
    throw new DacsError("publishListing requires a cloneable normative Listing");
  }
  const candidateVersion = (candidate as { listingVersion?: unknown })
    .listingVersion;
  if (
    !Number.isSafeInteger(candidateVersion) ||
    (candidateVersion as number) < 1
  ) {
    throw new DacsError(
      `listingVersion must be a positive integer within the safe range (§6.3.4), got ${String(candidateVersion)}`,
    );
  }
  // DACS-1 §6.3.4 LP-2 and CORE §11.1.2: new writes are normative only.
  // Historical MVP artifacts are accepted solely by readListingArtifact().
  if (!isListingDraft(candidate)) {
    throw new DacsError(
      "publishListing requires a normative unsigned DACS-1 §6.3.4 Listing; " +
        "legacy MVP shapes are read-only",
    );
  }
  const payloadCapability = await resolveListingPayloadVerificationCapability(
    candidate,
    "produce",
    deps.resolvePayloadVerificationCapability,
  );
  if (
    payloadCapability.disposition !== "not-applicable" &&
    payloadCapability.disposition !== "supported"
  ) {
    const localContractError = new Set([
      "payload-verification-capability-input-not-canonicalizable",
      "payload-verification-capability-resolution-invalid",
      "payload-verification-capability-resolution-mutated-input",
    ]).has(payloadCapability.reason);
    throw new DacsError(
      `attested-payload verification method is ${payloadCapability.disposition} ` +
      `(${payloadCapability.reason}); DPA-1 refuses publication`,
      {
        // DACS-2 VP-R4 does not retry `indeterminate` by default. A method
        // `error` means resolution did not complete, so a later retry may work.
        category:
          (payloadCapability.disposition === "indeterminate" ||
            payloadCapability.disposition === "error") &&
          !localContractError
            ? "transient"
            : "permanent",
      },
    );
  }
  if (candidate.pipeline.some((phase) => phase.kind.startsWith("pay-"))) {
    if (!deps.loadRailResolution) {
      throw new DacsError(
        "pay-bearing Listing publication requires an authenticated DACS-4 rail " +
          "authority read; LP-6 forbids treating acceptedRails as proof",
      );
    }
    let railResolution;
    try {
      const authority = structuredClone(
        await deps.loadRailResolution(structuredClone(candidate)),
      );
      railResolution = resolveListingRails({
        ...authority,
        payPhases: candidate.pipeline
          .filter((phase) => phase.kind.startsWith("pay-"))
          .map((phase) => ({ kind: phase.kind, rail: phase.parameters?.rail })),
        acceptedRails: candidate.acceptedRails ?? [],
      });
    } catch (error) {
      throw new DacsError(
        `listing-time rail resolution was indeterminate: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (railResolution.disposition !== "verified") {
      throw new DacsError(
        `listing-time rail resolution is ${railResolution.disposition} ` +
          `(${railResolution.reason}); LP-6 refuses pay-bearing publication`,
      );
    }
  }
  const version = candidate.listingVersion;

  // Logical (colon-bearing, discovery key) vs native (colon-free program name the
  // substrate actually accepts). Anchor under the encoded name; return both.
  const logicalAddress = listingAddress(
    candidate.seller.identity.presentedBy,
    candidate.listingId,
    version,
  );
  const storageName = logicalToStorageProgramName(logicalAddress);
  const historyPrefix = listingHistoryPrefix(candidate);
  let history: OwnedAnchorScan;
  try {
    history = structuredClone(
      await deps.scanOwnAnchorsByNamePrefix(historyPrefix),
    );
  } catch {
    throw new SubstrateError("listing version history returned an invalid snapshot");
  }
  if (!isOwnedAnchorScanValue(history)) {
    throw new SubstrateError("listing version history returned a malformed result");
  }
  const versions = assertContiguousHistory(candidate, historyPrefix, history);
  if (!versions.has(version)) {
    const expected = versions.size + 1;
    if (version !== expected) {
      throw new DacsError(
        `listingVersion must advance monotonically without gaps: expected ${expected}, got ${version}`,
      );
    }
  }

  if (payloadCapability.disposition === "supported") {
    if (payloadCapability.operation !== "produce") {
      throw new DacsError(
        "attested-payload publication requires a producer capability decision",
      );
    }
    const deliverable = candidate.offering.deliverable;
    if (
      deliverable.kind !== "attested-payload" ||
      !deliverable.verificationMethod ||
      sha256Hex(canonicalize(deliverable.verificationMethod)) !==
        payloadCapability.verificationMethodHash ||
      sha256Hex(canonicalize(deliverable)) !==
        payloadCapability.deliverableSpecHash
    ) {
      throw new DacsError(
        "attested-payload method/spec changed after DPA-1 capability approval",
      );
    }
  }

  const rawSigned = await signComponentArtifact(
    candidate,
    ARTIFACT_SEPARATORS.Listing,
    {
      algorithm: "ed25519",
      signer: candidate.seller.identity.presentedBy,
      sign: (bytes) => deps.sign(bytes),
    },
  );
  let signed: typeof rawSigned;
  let signedCanonical: string;
  let signedContentHash: string;
  try {
    // signComponentArtifact shallow-spreads its input. Detach the signed
    // artifact from the candidate before an effect adapter sees either one.
    signed = structuredClone(rawSigned);
    signedCanonical = canonicalize(signed);
    signedContentHash = contentHash(
      signed as unknown as Record<string, unknown>,
    );
  } catch {
    throw new DacsError("signed Listing could not be retained as an exact snapshot");
  }
  if (!isListing(signed)) {
    throw new DacsError(
      "signed Listing failed DACS-1 §6.3.4 structural/signature-envelope validation",
    );
  }
  let writeInput: typeof signed;
  let rawWrite: unknown;
  try {
    writeInput = structuredClone(signed);
    rawWrite = await deps.anchorWriteOnce(storageName, writeInput);
  } catch (error) {
    throw new SubstrateError(
      `Listing publication was indeterminate: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  let write: { address: string; txRef?: string };
  try {
    if (canonicalize(writeInput) !== signedCanonical ||
        canonicalize(signed) !== signedCanonical ||
        contentHash(signed as unknown as Record<string, unknown>) !==
          signedContentHash) {
      throw new TypeError("anchor adapter mutated the exact signed Listing");
    }
    const snapshot = structuredClone(rawWrite);
    if (snapshot === null || typeof snapshot !== "object" ||
        Array.isArray(snapshot)) throw new TypeError("malformed anchor result");
    const result = snapshot as Record<string, unknown>;
    if (typeof result.address !== "string" || result.address.length === 0 ||
        (result.txRef !== undefined &&
          (typeof result.txRef !== "string" || result.txRef.length === 0)) ||
        Object.keys(result).some((key) => key !== "address" && key !== "txRef")) {
      throw new TypeError("malformed anchor result");
    }
    write = snapshot as { address: string; txRef?: string };
  } catch (error) {
    throw new SubstrateError(
      `Listing publication result was indeterminate: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const listingPin = {
    listingId: candidate.listingId,
    version,
    contentHash: signedContentHash,
  };
  return {
    ref: write.address,
    logicalAddress,
    storageName,
    listingPin,
    ...(write.txRef ? { txRef: write.txRef } : {}),
  };
}

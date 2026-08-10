import { types as nodeTypes } from "node:util";

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
import {
  snapshotCanonicalJson,
  snapshotCanonicalJsonRead,
} from "../canonical/snapshot.js";
import { DacsError, SubstrateError } from "../errors.js";
import type { OwnedAnchorScan } from "../substrate/anchorResolution.js";
import type { AnchorWriteOnceOptions } from "../substrate/SubstrateAdapter.js";
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
    options?: AnchorWriteOnceOptions,
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

type CapturedPublishListingDeps = Readonly<PublishListingDeps>;

/**
 * Capture a dependency as a data method without invoking caller-controlled
 * accessors. Prototype methods remain supported, but proxy-backed dependency
 * objects/functions are rejected because even inspecting them can run traps.
 */
function captureDataMethod<K extends keyof PublishListingDeps>(
  deps: PublishListingDeps,
  key: K,
  optional = false,
): PublishListingDeps[K] {
  if (
    deps === null ||
    typeof deps !== "object" ||
    nodeTypes.isProxy(deps)
  ) {
    throw new DacsError("publishListing dependencies must be a stable object");
  }

  let owner: object | null = deps;
  try {
    while (owner !== null) {
      if (nodeTypes.isProxy(owner)) throw new TypeError("proxy prototype");
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor) {
        if (optional && "value" in descriptor && descriptor.value === undefined) {
          return undefined as PublishListingDeps[K];
        }
        if (
          !("value" in descriptor) ||
          typeof descriptor.value !== "function" ||
          nodeTypes.isProxy(descriptor.value)
        ) {
          throw new TypeError("dependency is not a data method");
        }
        return Function.prototype.bind.call(
          descriptor.value,
          deps,
        ) as PublishListingDeps[K];
      }
      owner = Object.getPrototypeOf(owner);
    }
  } catch (cause) {
    throw new DacsError(
      `publishListing dependency ${String(key)} must be a stable data method`,
      { cause },
    );
  }

  if (optional) return undefined as PublishListingDeps[K];

  throw new DacsError(
    `publishListing dependency ${String(key)} must be a stable data method`,
  );
}

/** Select all asynchronous seams before inspecting the caller's Listing. */
function capturePublishListingDeps(
  deps: PublishListingDeps,
): CapturedPublishListingDeps {
  return Object.freeze({
    sign: captureDataMethod(deps, "sign"),
    scanOwnAnchorsByNamePrefix: captureDataMethod(
      deps,
      "scanOwnAnchorsByNamePrefix",
    ),
    anchorWriteOnce: captureDataMethod(deps, "anchorWriteOnce"),
    loadRailResolution: captureDataMethod(deps, "loadRailResolution", true),
    resolvePayloadVerificationCapability: captureDataMethod(
      deps,
      "resolvePayloadVerificationCapability",
      true,
    ),
  });
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

/** Own and validate the exact owner-bound history callback envelope. */
function snapshotOwnedAnchorScan(
  value: unknown,
  prefix: string,
): OwnedAnchorScan {
  let snapshot: unknown;
  try {
    snapshot = snapshotCanonicalJsonRead(value, "listing history scan");
  } catch (cause) {
    throw new SubstrateError(
      "listing history scan returned an unstable or non-wire result",
      { cause },
    );
  }
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    throw new SubstrateError("listing history scan returned a malformed envelope");
  }

  const record = snapshot as Record<string, unknown>;
  if (
    record.status === "indeterminate" &&
    hasExactKeys(record, ["status", "reason"]) &&
    typeof record.reason === "string" &&
    record.reason.length > 0 &&
    record.reason.trim() === record.reason
  ) {
    return record as OwnedAnchorScan;
  }
  if (
    record.status !== "ok" ||
    !hasExactKeys(record, ["status", "anchors"]) ||
    !Array.isArray(record.anchors)
  ) {
    throw new SubstrateError("listing history scan returned a malformed envelope");
  }

  for (const candidate of record.anchors) {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new SubstrateError("listing history scan returned a malformed anchor");
    }
    const anchor = candidate as Record<string, unknown>;
    if (
      !hasExactKeys(anchor, ["address", "programName", "value"]) ||
      typeof anchor.address !== "string" ||
      anchor.address.length === 0 ||
      anchor.address.trim() !== anchor.address ||
      typeof anchor.programName !== "string" ||
      !anchor.programName.startsWith(prefix) ||
      anchor.value === null ||
      typeof anchor.value !== "object" ||
      Array.isArray(anchor.value)
    ) {
      throw new SubstrateError("listing history scan returned a malformed anchor");
    }
  }
  return record as OwnedAnchorScan;
}

/** Own and validate the immutable-write result before exposing its refs. */
function snapshotAnchorWriteResult(
  value: unknown,
): { address: string; txRef?: string } {
  let snapshot: unknown;
  try {
    snapshot = snapshotCanonicalJsonRead(
      value,
      "immutable listing anchor result",
    );
  } catch (cause) {
    throw new SubstrateError(
      "immutable listing anchor returned an unstable or non-wire result",
      { cause },
    );
  }
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    throw new SubstrateError("immutable listing anchor returned a malformed result");
  }
  const record = snapshot as Record<string, unknown>;
  const exact =
    hasExactKeys(record, ["address"]) ||
    hasExactKeys(record, ["address", "txRef"]);
  if (
    !exact ||
    typeof record.address !== "string" ||
    record.address.length === 0 ||
    record.address.trim() !== record.address ||
    (Object.prototype.hasOwnProperty.call(record, "txRef") &&
      (typeof record.txRef !== "string" ||
        record.txRef.length === 0 ||
        record.txRef.trim() !== record.txRef))
  ) {
    throw new SubstrateError("immutable listing anchor returned a malformed result");
  }
  return record as { address: string; txRef?: string };
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

/**
 * Make the exact signed publication graph immutable before it crosses the
 * asynchronous substrate seam. Listings are JSON artifacts, so every nested
 * object/array participates in the signature scope and must be frozen.
 */
function deepFreezePublication<T extends object>(value: T): Readonly<T> {
  const seen = new WeakSet<object>();
  const freeze = (candidate: object): void => {
    if (seen.has(candidate)) return;
    seen.add(candidate);
    for (const nested of Object.values(candidate)) {
      if (nested !== null && typeof nested === "object") freeze(nested);
    }
    Object.freeze(candidate);
  };
  freeze(value);
  return value;
}

export async function publishListingCore(
  inputListing: ListingDraft,
  deps: PublishListingDeps,
): Promise<PublishListingResult> {
  // Select dependency identities without invoking accessors, then own the
  // caller's exact canonical JSON view. Neither side can swap the other while
  // this synchronous entry boundary is being established.
  const capturedDeps = capturePublishListingDeps(deps);
  const listing = snapshotCanonicalJson(
    inputListing,
    "publishListing Listing draft",
  ) as ListingDraft;
  const candidateVersion = (listing as { listingVersion?: unknown })
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
  if (!isListingDraft(listing)) {
    throw new DacsError(
      "publishListing requires a normative unsigned DACS-1 §6.3.4 Listing; " +
        "legacy MVP shapes are read-only",
    );
  }
  const payloadCapability = await resolveListingPayloadVerificationCapability(
    listing,
    "produce",
    capturedDeps.resolvePayloadVerificationCapability,
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
  if (listing.pipeline.some((phase) => phase.kind.startsWith("pay-"))) {
    if (!capturedDeps.loadRailResolution) {
      throw new DacsError(
        "pay-bearing Listing publication requires an authenticated DACS-4 rail " +
          "authority read; LP-6 forbids treating acceptedRails as proof",
      );
    }
    let railResolution;
    try {
      const authority = snapshotCanonicalJsonRead(
        await capturedDeps.loadRailResolution(
          snapshotCanonicalJson(listing, "rail authority Listing input"),
        ),
        "listing rail authority result",
      );
      if (authority === null || typeof authority !== "object" || Array.isArray(authority)) {
        throw new TypeError("malformed rail authority result");
      }
      railResolution = resolveListingRails({
        ...authority,
        payPhases: listing.pipeline
          .filter((phase) => phase.kind.startsWith("pay-"))
          .map((phase) => ({ kind: phase.kind, rail: phase.parameters?.rail })),
        acceptedRails: listing.acceptedRails ?? [],
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
  const version = listing.listingVersion;

  // Logical (colon-bearing, discovery key) vs native (colon-free program name the
  // substrate actually accepts). Anchor under the encoded name; return both.
  const logicalAddress = listingAddress(
    listing.seller.identity.presentedBy,
    listing.listingId,
    version,
  );
  if (logicalAddress !== logicalAddress.normalize("NFC")) {
    throw new DacsError("listing logical address must be NFC-normalized");
  }
  const storageName = logicalToStorageProgramName(logicalAddress);
  const historyPrefix = listingHistoryPrefix(listing);
  const versions = assertContiguousHistory(
    listing,
    historyPrefix,
    snapshotOwnedAnchorScan(
      await capturedDeps.scanOwnAnchorsByNamePrefix(historyPrefix),
      historyPrefix,
    ),
  );
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
    const deliverable = listing.offering.deliverable;
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

  const signed = await signComponentArtifact(
    listing,
    ARTIFACT_SEPARATORS.Listing,
    {
      algorithm: "ed25519",
      signer: listing.seller.identity.presentedBy,
      sign: capturedDeps.sign,
    },
  );
  if (!isListing(signed)) {
    throw new DacsError(
      "signed Listing failed DACS-1 §6.3.4 structural/signature-envelope validation",
    );
  }
  let publication: typeof signed;
  let listingContentHash: string;
  try {
    // The signer result is authoritative. Give the adapter an owned, deeply
    // immutable copy so no await-time mutation can change the bytes written.
    const owned = snapshotCanonicalJson(signed, "signed Listing publication");
    // Hash the owned mutable wire snapshot before freezing it for the adapter;
    // strict authoring hashes intentionally reject exotic/read-only inputs.
    listingContentHash = contentHash(
      owned as unknown as Record<string, unknown>,
    );
    publication = deepFreezePublication(owned);
  } catch (cause) {
    throw new DacsError("signed Listing could not form an immutable publication", {
      cause,
    });
  }
  const listingPin = {
    listingId: listing.listingId,
    version,
    contentHash: listingContentHash,
  };
  let rawWrite: unknown;
  try {
    rawWrite = await capturedDeps.anchorWriteOnce(storageName, publication, {
      metadata: { logicalAddress },
    });
  } catch (cause) {
    if (cause instanceof DacsError) throw cause;
    throw new SubstrateError("Listing publication was indeterminate", { cause });
  }
  const { address: anchored, txRef } = snapshotAnchorWriteResult(
    rawWrite,
  );
  return { ref: anchored, logicalAddress, storageName, listingPin, txRef };
}

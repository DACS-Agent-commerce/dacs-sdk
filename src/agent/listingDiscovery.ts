import type { Listing, ListingPin } from "../artifacts/types.js";
import { readListingArtifact } from "../artifacts/validators.js";
import {
  contentHash,
  decodeAddressSegment,
  listingAddress,
} from "../canonical/index.js";
import type {
  AnchorBinding,
  BindingIndex,
} from "../discovery/binding.js";
import { normalizedBindingOwner } from "../discovery/owner.js";
import {
  scanAnchorPage,
  type AnchorHistoryPageFetcher,
} from "../discovery/scanner.js";
import { parseCanonicalClaimReference } from "../identity/claimReference.js";
import { DEMOS_HISTORY_MAX_PAGE_SIZE } from "../substrate/demosHistory.js";
import {
  isVerifiedListingAdmission,
  validateListingArtifact,
  type ListingValidationDeps,
  type ListingValidationResult,
  type VerifiedListingAdmission,
} from "./listingValidation.js";
import { readableListingClaimReferencesAreCanonical } from "./listingClaimReferences.js";

const CANONICAL_DEMOS_AGENT_IDENTIFIER = /^demos:agent:([0-9a-f]{64})$/;
const DEMOS_OWNER = /^(?:0x)?[0-9a-f]{64}$/i;
const LOWER_HEX_HASH = /^[0-9a-f]{64}$/;
const LISTING_LOGICAL_ADDRESS = /^dacs1:([^:]+):([^:]+):v([1-9][0-9]*)$/;

interface ParsedListingAddress {
  sellerPrimaryClaim: string;
  owner: string;
  listingId: string;
  version: number;
}

type ParseResult =
  | { ok: true; value: ParsedListingAddress }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function canonicalAgent(agentId: string): { owner: string } | null {
  const parsed = parseCanonicalClaimReference(agentId);
  const match = parsed?.identity.scheme === "did"
    ? parsed.identity.identifier.match(CANONICAL_DEMOS_AGENT_IDENTIFIER)
    : null;
  if (!match) return null;
  return { owner: match[1]! };
}

function parseListingAddress(logicalAddress: string): ParseResult {
  if (!isWellFormedUtf16(logicalAddress)) {
    return {
      ok: false,
      reason: "Listing logical address contains invalid Unicode",
    };
  }
  if (
    logicalAddress !== logicalAddress.trim() ||
    logicalAddress !== logicalAddress.normalize("NFC")
  ) {
    return {
      ok: false,
      reason: "Listing logical address must be trimmed and NFC-normalized",
    };
  }
  const match = logicalAddress.match(LISTING_LOGICAL_ADDRESS);
  if (!match) {
    return {
      ok: false,
      reason:
        "Listing logical address must be dacs1:<seller>:<service>:v<positive-version>",
    };
  }

  const sellerPrimaryClaim = decodeAddressSegment(match[1]!);
  const listingId = decodeAddressSegment(match[2]!);
  const version = Number(match[3]);
  if (!Number.isSafeInteger(version) || version < 1) {
    return { ok: false, reason: "Listing version must be a positive safe integer" };
  }
  if (listingId.length === 0) {
    return { ok: false, reason: "Listing id must not be empty" };
  }
  const agent = canonicalAgent(sellerPrimaryClaim);
  if (!agent) {
    return {
      ok: false,
      reason:
        "Listing seller must use canonical did:demos:agent:<lowercase-ed25519-key> ClaimReference bytes",
    };
  }
  if (listingAddress(sellerPrimaryClaim, listingId, version) !== logicalAddress) {
    return {
      ok: false,
      reason: "Listing logical address is not in canonical CF-4 form",
    };
  }
  return {
    ok: true,
    value: { sellerPrimaryClaim, listingId, version, ...agent },
  };
}

export type ListingReadRejectionCheck =
  | "binding"
  | "content-hash"
  | "shape"
  | "context"
  | "validation";

export type ListingReadRejectionCode =
  | "malformed-binding"
  | "logical-address-mismatch"
  | "owner-mismatch"
  | "native-address-mismatch"
  | "version-mismatch"
  | "generic-tombstone"
  | "invalid-content-hash"
  | "content-hash-mismatch"
  | "content-not-canonical"
  | "invalid-record"
  | "unsupported-listing-shape"
  | "seller-mismatch"
  | "listing-id-mismatch"
  | "listing-validation-failed"
  | "history-owner-mismatch";

interface AuthenticatedListingBase {
  /** Native address only after every integrity/authorship check succeeds. */
  ref: string;
  logicalAddress: string;
  version: number;
  contentHash: string;
  listingPin: ListingPin;
}

export type AuthenticatedListing = AuthenticatedListingBase & {
  status: "verified";
  compatibility: "normative";
  /** Exact Listing promoted only from the SDK-owned ordered step-9 result. */
  listing: Listing;
  validation: VerifiedListingAdmission;
};

export type ListingReadFailure =
  | {
      status: "invalid-address";
      logicalAddress: string | null;
      reason: string;
    }
  | { status: "absent"; logicalAddress: string }
  | {
      status: "unreadable";
      logicalAddress: string;
      nativeAddress: string;
    }
  | {
      status: "rejected";
      logicalAddress: string;
      check: ListingReadRejectionCheck;
      code: ListingReadRejectionCode;
      reason: string;
      nativeAddress?: string;
      validation?: ListingValidationResult;
    }
  | {
      status: "indeterminate";
      logicalAddress: string;
      stage: "index" | "read" | "validation";
      reason: string;
      validation?: ListingValidationResult;
    };

/**
 * A `verified` result has passed the exact binding, content-hash and
 * Listing-context checks and the SDK-owned ordered DACS-1 reader through step 9.
 */
export type ListingReadResult =
  | AuthenticatedListing
  | ListingReadFailure;

export interface ListingDiscoveryDeps {
  index: BindingIndex;
  readAnchor: (
    nativeAddress: string,
    anchorKind?: string,
  ) => Promise<Record<string, unknown> | null>;
  /** Required to read a Listing; the SDK executes the ordered algorithm. */
  listingValidationDeps?: ListingValidationDeps;
  /** Required only for owner-scoped history enumeration. */
  createHistoryPageFetcher?: (
    expectedOwner: string,
  ) => AnchorHistoryPageFetcher;
}

function captureListingValidationDeps(
  deps: ListingValidationDeps,
): ListingValidationDeps {
  const revocationSurfaces = structuredClone(deps.revocation.surfaces);
  return Object.freeze({
    nowMs: deps.nowMs.bind(deps),
    verifyListingSignature: deps.verifyListingSignature.bind(deps),
    revocation: Object.freeze({
      surfaces: revocationSurfaces,
      readMarker: deps.revocation.readMarker.bind(deps.revocation),
      verifyMarkerSignature:
        deps.revocation.verifyMarkerSignature.bind(deps.revocation),
    }),
    verifyIdentityPresentation: deps.verifyIdentityPresentation.bind(deps),
    ...(deps.loadRailResolution
      ? { loadRailResolution: deps.loadRailResolution.bind(deps) }
      : {}),
    ...(deps.resolvePayloadVerificationCapability
      ? {
          resolvePayloadVerificationCapability:
            deps.resolvePayloadVerificationCapability.bind(deps),
        }
      : {}),
    verifySellerControl: deps.verifySellerControl.bind(deps),
  });
}

function rejected(
  logicalAddress: string,
  check: ListingReadRejectionCheck,
  code: ListingReadRejectionCode,
  reason: string,
  nativeAddress?: string,
): ListingReadFailure {
  return {
    status: "rejected",
    logicalAddress,
    check,
    code,
    reason,
    ...(nativeAddress === undefined ? {} : { nativeAddress }),
  };
}

function malformedIndexResponse(
  logicalAddress: string,
  reason: string,
): ListingReadFailure {
  return {
    status: "indeterminate",
    logicalAddress,
    stage: "index",
    reason: `binding index returned a malformed response: ${reason}`,
  };
}

/**
 * Resolve one normative DACS-1 Listing by its canonical logical address and
 * admit it through the ordered reader. The owner is derived from that address;
 * callers cannot pair an arbitrary logical address with an unrelated owner
 * hint.
 */
export async function readListingByLogicalAddress(
  logicalAddress: string,
  deps: ListingDiscoveryDeps,
  expectedNativeAddress?: string,
): Promise<ListingReadResult> {
  if (typeof (logicalAddress as unknown) !== "string") {
    return {
      status: "invalid-address",
      logicalAddress: null,
      reason: "Listing logical address must be a string",
    };
  }
  const parsed = parseListingAddress(logicalAddress);
  if (!parsed.ok) {
    return { status: "invalid-address", logicalAddress, reason: parsed.reason };
  }

  const resolveBinding = deps.index.resolve.bind(deps.index);
  const readAnchor = deps.readAnchor.bind(deps);
  let capturedValidationDeps: ListingValidationDeps | undefined;
  if (deps.listingValidationDeps) {
    try {
      capturedValidationDeps = captureListingValidationDeps(
        deps.listingValidationDeps,
      );
    } catch {
      return {
        status: "indeterminate",
        logicalAddress,
        stage: "validation",
        reason: "normative Listing validation configuration is not snapshot-safe",
      };
    }
  }

  let resolutionValue: unknown;
  try {
    resolutionValue = structuredClone(
      await resolveBinding(logicalAddress, parsed.value.owner),
    );
  } catch (error) {
    return {
      status: "indeterminate",
      logicalAddress,
      stage: "index",
      reason:
        "binding resolution failed: " +
        (error instanceof Error ? error.message : String(error)),
    };
  }
  if (!isRecord(resolutionValue)) {
    return malformedIndexResponse(logicalAddress, "result is not an object");
  }
  if (resolutionValue.status === "absent") {
    return { status: "absent", logicalAddress };
  }
  if (resolutionValue.status === "indeterminate") {
    return typeof resolutionValue.reason === "string"
      ? {
          status: "indeterminate",
          logicalAddress,
          stage: "index",
          reason: resolutionValue.reason,
        }
      : malformedIndexResponse(logicalAddress, "indeterminate result has no reason");
  }
  if (resolutionValue.status !== "present" || !isRecord(resolutionValue.binding)) {
    return malformedIndexResponse(logicalAddress, "unknown status or missing binding");
  }

  const candidate = resolutionValue.binding;
  if (
    typeof candidate.logicalAddress !== "string" ||
    typeof candidate.nativeAddress !== "string" ||
    typeof candidate.owner !== "string" ||
    (candidate.anchorKind !== undefined &&
      (typeof candidate.anchorKind !== "string" ||
        candidate.anchorKind.length === 0 ||
        candidate.anchorKind !== candidate.anchorKind.trim()))
  ) {
    return rejected(
      logicalAddress,
      "binding",
      "malformed-binding",
      "resolved binding is missing a logical, native, or owner address",
    );
  }
  const binding = candidate as unknown as AnchorBinding;
  if (binding.logicalAddress !== logicalAddress) {
    return rejected(
      logicalAddress,
      "binding",
      "logical-address-mismatch",
      "resolved binding does not echo the requested logical address",
      binding.nativeAddress,
    );
  }
  if (
    !DEMOS_OWNER.test(binding.owner) ||
    normalizedBindingOwner(binding.owner) !== parsed.value.owner
  ) {
    return rejected(
      logicalAddress,
      "binding",
      "owner-mismatch",
      "resolved binding owner does not match the seller embedded in the logical address",
      binding.nativeAddress,
    );
  }
  if (binding.nativeAddress.trim().length === 0) {
    return rejected(
      logicalAddress,
      "binding",
      "malformed-binding",
      "resolved binding has an empty native address",
    );
  }
  if (binding.nativeAddress !== binding.nativeAddress.trim()) {
    return rejected(
      logicalAddress,
      "binding",
      "malformed-binding",
      "resolved binding native address must be trimmed",
    );
  }
  if (
    expectedNativeAddress !== undefined &&
    binding.nativeAddress !== expectedNativeAddress
  ) {
    return rejected(
      logicalAddress,
      "binding",
      "native-address-mismatch",
      "published binding does not point at the enumerated history candidate",
      binding.nativeAddress,
    );
  }
  if (
    !Number.isSafeInteger(binding.version) ||
    binding.version !== parsed.value.version
  ) {
    return rejected(
      logicalAddress,
      "binding",
      "version-mismatch",
      "resolved binding version does not match the logical address",
      binding.nativeAddress,
    );
  }
  if (
    binding.revoked !== undefined &&
    typeof binding.revoked !== "boolean"
  ) {
    return rejected(
      logicalAddress,
      "binding",
      "malformed-binding",
      "resolved binding revoked state must be boolean when present",
      binding.nativeAddress,
    );
  }
  if (binding.revoked === true) {
    return rejected(
      logicalAddress,
      "binding",
      "generic-tombstone",
      "resolved binding is a generic index tombstone, not signed revocation evidence",
      binding.nativeAddress,
    );
  }
  if (
    typeof binding.contentHash !== "string" ||
    !LOWER_HEX_HASH.test(binding.contentHash)
  ) {
    return rejected(
      logicalAddress,
      "binding",
      "invalid-content-hash",
      "resolved binding must carry a lowercase SHA-256 content hash",
      binding.nativeAddress,
    );
  }

  let readValue: unknown;
  try {
    readValue = await readAnchor(binding.nativeAddress, binding.anchorKind);
  } catch (error) {
    return {
      status: "indeterminate",
      logicalAddress,
      stage: "read",
      reason:
        `read of ${binding.nativeAddress} failed: ` +
        (error instanceof Error ? error.message : String(error)),
    };
  }
  if (readValue === null) {
    return {
      status: "unreadable",
      logicalAddress,
      nativeAddress: binding.nativeAddress,
    };
  }

  let record: Record<string, unknown>;
  try {
    const snapshot: unknown = structuredClone(readValue);
    if (!isRecord(snapshot)) throw new Error("record is not a JSON object");
    record = snapshot;
  } catch (error) {
    return rejected(
      logicalAddress,
      "shape",
      "invalid-record",
      error instanceof Error ? error.message : String(error),
      binding.nativeAddress,
    );
  }

  let actualContentHash: string;
  try {
    actualContentHash = contentHash(record);
  } catch (error) {
    return rejected(
      logicalAddress,
      "content-hash",
      "content-not-canonical",
      error instanceof Error ? error.message : String(error),
      binding.nativeAddress,
    );
  }
  if (actualContentHash !== binding.contentHash) {
    return rejected(
      logicalAddress,
      "content-hash",
      "content-hash-mismatch",
      "read record does not match the content hash pinned by the binding",
      binding.nativeAddress,
    );
  }

  const readable = readListingArtifact(record);
  if (readable?.compatibility !== "normative") {
    return rejected(
      logicalAddress,
      "shape",
      "unsupported-listing-shape",
      "record is not a normative DACS-1 Listing",
      binding.nativeAddress,
    );
  }
  if (!readableListingClaimReferencesAreCanonical(readable.listing)) {
    return rejected(
      logicalAddress,
      "shape",
      "unsupported-listing-shape",
      "Listing contains a non-canonical CORE B.1 CF-2 ClaimReference",
      binding.nativeAddress,
    );
  }

  const sellerId = readable.listing.seller.identity.presentedBy;
  const listingId = readable.listing.listingId;
  const recordVersion = readable.listing.listingVersion;
  if (sellerId !== parsed.value.sellerPrimaryClaim) {
    return rejected(
      logicalAddress,
      "context",
      "seller-mismatch",
      "Listing seller does not match the seller embedded in the logical address",
      binding.nativeAddress,
    );
  }
  if (listingId !== parsed.value.listingId) {
    return rejected(
      logicalAddress,
      "context",
      "listing-id-mismatch",
      "Listing id does not match the id embedded in the logical address",
      binding.nativeAddress,
    );
  }
  if (
    !Number.isSafeInteger(recordVersion) ||
    recordVersion !== parsed.value.version
  ) {
    return rejected(
      logicalAddress,
      "context",
      "version-mismatch",
      "Listing version does not match the logical address",
      binding.nativeAddress,
    );
  }
  if (
    listingAddress(sellerId, listingId, recordVersion) !==
    logicalAddress
  ) {
    return rejected(
      logicalAddress,
      "context",
      "logical-address-mismatch",
      "Listing fields do not reconstruct the requested logical address",
      binding.nativeAddress,
    );
  }

  if (!capturedValidationDeps) {
    return {
      status: "indeterminate",
      logicalAddress,
      stage: "validation",
      reason:
        "normative Listing reads require SDK-owned ordered validation dependencies",
    };
  }
  let validation: ListingValidationResult;
  try {
    validation = structuredClone(
      await validateListingArtifact(
        structuredClone(record),
        capturedValidationDeps,
      ),
    );
  } catch {
    return {
      status: "indeterminate",
      logicalAddress,
      stage: "validation",
      reason: "normative Listing ordered validation did not complete",
    };
  }
  if (!isVerifiedListingAdmission(record, validation)) {
    if (validation.disposition === "indeterminate") {
      return {
        status: "indeterminate",
        logicalAddress,
        stage: "validation",
        reason:
          `normative Listing admission is indeterminate at reader step ` +
          `${validation.step} (${validation.reason})`,
        validation,
      };
    }
    if (
      validation.disposition === "rejected" ||
      validation.disposition === "revoked"
    ) {
      return {
        status: "rejected",
        logicalAddress,
        nativeAddress: binding.nativeAddress,
        check: "validation",
        code: "listing-validation-failed",
        reason:
          `normative Listing admission is ${validation.disposition} at reader ` +
          `step ${validation.step} (${validation.reason})`,
        validation,
      };
    }
    return {
      status: "indeterminate",
      logicalAddress,
      stage: "validation",
      reason:
        "normative Listing validator returned a stale, substituted, or incomplete verified result",
      validation,
    };
  }
  return {
    status: "verified",
    compatibility: "normative",
    ref: binding.nativeAddress,
    logicalAddress,
    version: parsed.value.version,
    contentHash: validation.listingContentHash,
    listingPin: {
      listingId: validation.listing.listingId,
      version: validation.listing.listingVersion,
      contentHash: validation.listingContentHash,
    },
    listing: validation.listing,
    validation,
  };
}

export interface EnumerateListingsOptions {
  /** Opaque owner-bound Demos continuation returned by the preceding call. */
  cursor?: string | null;
  /** Raw Demos history rows per page, not guaranteed Listing count (1..100). */
  historyPageSize?: number;
}

export interface ListingEnumerationDiagnostic {
  logicalAddress: string;
  nativeAddress: string;
  result: ListingReadFailure;
}

export type ListingEnumerationResult =
  | {
      status: "page";
      listings: readonly AuthenticatedListing[];
      diagnostics: readonly ListingEnumerationDiagnostic[];
      nextCursor: string | null;
    }
  | {
      status: "invalid-seller";
      sellerId: string | null;
      reason: string;
    }
  | {
      status: "invalid-options";
      reason: string;
    }
  | {
      status: "indeterminate";
      stage: "history" | "index" | "read" | "validation";
      listings: readonly [];
      diagnostics: readonly [];
      reason: string;
      retryCursor: string | null;
    };

/**
 * Page through verified Listings for one known canonical Demos seller. This is
 * owner-scoped history discovery, not a global marketplace search. Independent
 * calls are at-least-once: idempotently upsert by
 * `(logicalAddress, contentHash, ref)`.
 * A null `nextCursor` ends only the current traversal; restart from null after
 * late binding repair or when refreshing the seller's history.
 */
export async function enumerateListingsForSeller(
  sellerId: string,
  deps: ListingDiscoveryDeps,
  options: EnumerateListingsOptions = {},
): Promise<ListingEnumerationResult> {
  if (typeof (sellerId as unknown) !== "string") {
    return {
      status: "invalid-seller",
      sellerId: null,
      reason: "sellerId must be a string",
    };
  }
  const seller = canonicalAgent(sellerId);
  if (!seller) {
    return {
      status: "invalid-seller",
      sellerId,
      reason:
        "sellerId must be a canonical did:demos:agent:<lowercase-ed25519-key>",
    };
  }
  const optionsValue: unknown = options;
  if (!isRecord(optionsValue)) {
    return {
      status: "invalid-options",
      reason: "enumeration options must be an object",
    };
  }
  const cursorValue = optionsValue["cursor"];
  if (
    cursorValue !== undefined &&
    cursorValue !== null &&
    (typeof cursorValue !== "string" || cursorValue.length === 0)
  ) {
    return {
      status: "invalid-options",
      reason: "cursor must be a non-empty opaque string or null",
    };
  }
  const historyPageSizeValue = optionsValue["historyPageSize"];
  if (
    historyPageSizeValue !== undefined &&
    (typeof historyPageSizeValue !== "number" ||
      !Number.isSafeInteger(historyPageSizeValue) ||
      historyPageSizeValue < 1 ||
      historyPageSizeValue > DEMOS_HISTORY_MAX_PAGE_SIZE)
  ) {
    return {
      status: "invalid-options",
      reason: `historyPageSize must be an integer from 1 to ${DEMOS_HISTORY_MAX_PAGE_SIZE}`,
    };
  }
  const cursor = (cursorValue ?? null) as string | null;
  const historyPageSize = historyPageSizeValue as number | undefined;
  if (!deps.createHistoryPageFetcher) {
    return {
      status: "indeterminate",
      stage: "history",
      listings: [],
      diagnostics: [],
      reason: "no Demos history page fetcher is configured",
      retryCursor: cursor,
    };
  }

  let fetchPage: AnchorHistoryPageFetcher;
  try {
    fetchPage = deps.createHistoryPageFetcher(seller.owner);
  } catch (error) {
    return {
      status: "indeterminate",
      stage: "history",
      listings: [],
      diagnostics: [],
      reason:
        "history adapter setup failed: " +
        (error instanceof Error ? error.message : String(error)),
      retryCursor: cursor,
    };
  }
  const scan = await scanAnchorPage(fetchPage, cursor, {
    ...(historyPageSize === undefined
      ? {}
      : { limit: historyPageSize }),
  });
  if (scan.status === "indeterminate") {
    return {
      status: "indeterminate",
      stage: "history",
      listings: [],
      diagnostics: [],
      reason: scan.reason,
      retryCursor: cursor,
    };
  }

  const listings: AuthenticatedListing[] = [];
  const diagnostics: ListingEnumerationDiagnostic[] = [];
  for (const candidate of scan.anchors) {
    if (candidate.kind !== "listing") continue;
    if (
      candidate.owner === undefined ||
      !DEMOS_OWNER.test(candidate.owner) ||
      normalizedBindingOwner(candidate.owner) !== seller.owner
    ) {
      diagnostics.push({
        logicalAddress: candidate.logicalAddress,
        nativeAddress: candidate.nativeAddress,
        result: rejected(
          candidate.logicalAddress,
          "binding",
          "history-owner-mismatch",
          "history candidate owner does not match the requested seller",
          candidate.nativeAddress,
        ),
      });
      continue;
    }
    const parsed = parseListingAddress(candidate.logicalAddress);
    if (!parsed.ok || parsed.value.sellerPrimaryClaim !== sellerId) {
      diagnostics.push({
        logicalAddress: candidate.logicalAddress,
        nativeAddress: candidate.nativeAddress,
        result: parsed.ok
          ? rejected(
              candidate.logicalAddress,
              "context",
              "seller-mismatch",
              "history Listing address belongs to a different seller",
              candidate.nativeAddress,
            )
          : {
              status: "invalid-address",
              logicalAddress: candidate.logicalAddress,
              reason: parsed.reason,
            },
      });
      continue;
    }

    const result = await readListingByLogicalAddress(
      candidate.logicalAddress,
      deps,
      candidate.nativeAddress,
    );
    if (result.status === "verified") {
      listings.push(result);
      continue;
    }
    if (result.status === "indeterminate" || result.status === "unreadable") {
      return {
        status: "indeterminate",
        stage: result.status === "unreadable" ? "read" : result.stage,
        listings: [],
        diagnostics: [],
        reason:
          result.status === "unreadable"
            ? `resolved Listing ${candidate.logicalAddress} was unreadable`
            : result.reason,
        retryCursor: cursor,
      };
    }
    diagnostics.push({
      logicalAddress: candidate.logicalAddress,
      nativeAddress: candidate.nativeAddress,
      result,
    });
  }

  return {
    status: "page",
    listings,
    diagnostics,
    nextCursor: scan.nextCursor,
  };
}

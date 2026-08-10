import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import type { Listing } from "../artifacts/types.js";
import { isListing } from "../artifacts/validators.js";
import {
  contentHash,
  decodeAddressSegment,
  listingAddress,
  stripSignature,
} from "../canonical/index.js";
import { signedBytes } from "../crypto/index.js";
import type {
  AnchorBinding,
  BindingIndex,
} from "../discovery/binding.js";
import { normalizedBindingOwner } from "../discovery/owner.js";
import {
  scanAnchorPage,
  type AnchorHistoryPageFetcher,
} from "../discovery/scanner.js";
import { DEMOS_HISTORY_MAX_PAGE_SIZE } from "../substrate/demosHistory.js";
import { type Verifier } from "./signedArtifact.js";

const CANONICAL_DEMOS_AGENT = /^did:demos:agent:([0-9a-f]{64})$/;
const DEMOS_OWNER = /^(?:0x)?[0-9a-f]{64}$/i;
const LOWER_HEX_HASH = /^[0-9a-f]{64}$/;
const LOWER_HEX_ED25519_SIGNATURE = /^[0-9a-f]{128}$/;
const LISTING_LOGICAL_ADDRESS = /^dacs1:([^:]+):([^:]+):v([1-9][0-9]*)$/;

interface ParsedListingAddress {
  agentId: string;
  owner: string;
  publicKey: Uint8Array;
  serviceId: string;
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

function canonicalAgent(agentId: string): {
  owner: string;
  publicKey: Uint8Array;
} | null {
  const match = agentId.match(CANONICAL_DEMOS_AGENT);
  if (!match) return null;
  const owner = match[1]!;
  return {
    owner,
    publicKey: Uint8Array.from(Buffer.from(owner, "hex")),
  };
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

  const agentId = decodeAddressSegment(match[1]!);
  const serviceId = decodeAddressSegment(match[2]!);
  const version = Number(match[3]);
  if (!Number.isSafeInteger(version) || version < 1) {
    return { ok: false, reason: "Listing version must be a positive safe integer" };
  }
  if (serviceId.length === 0) {
    return { ok: false, reason: "Listing service id must not be empty" };
  }
  const agent = canonicalAgent(agentId);
  if (!agent) {
    return {
      ok: false,
      reason:
        "Listing seller must be a canonical did:demos:agent:<lowercase-ed25519-key>",
    };
  }
  if (listingAddress(agentId, serviceId, version) !== logicalAddress) {
    return {
      ok: false,
      reason: "Listing logical address is not in canonical CF-4 form",
    };
  }
  return {
    ok: true,
    value: { agentId, serviceId, version, ...agent },
  };
}

export type ListingReadRejectionCheck =
  | "binding"
  | "content-hash"
  | "shape"
  | "context"
  | "signature";

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
  | "invalid-signature-envelope"
  | "unsupported-listing-shape"
  | "seller-mismatch"
  | "service-mismatch"
  | "signature-invalid"
  | "history-owner-mismatch";

export interface AuthenticatedListing {
  status: "authenticated";
  /** Current writer/reader shape; normative Listing support integrates separately. */
  compatibility: "legacy-mvp";
  /** Native address only after every integrity/authorship check succeeds. */
  ref: string;
  logicalAddress: string;
  version: number;
  contentHash: string;
  /** Signed scope with the standalone signature removed. */
  listing: Listing;
}

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
    }
  | {
      status: "indeterminate";
      logicalAddress: string;
      stage: "index" | "read" | "verification";
      reason: string;
    };

/**
 * `authenticated` proves exact binding/hash/context and legacy SDK Listing
 * domain-signature integrity. It does NOT mean the Listing is currently active,
 * unrevoked, reachable, or fully valid under the normative DACS-1 reader
 * pipeline; that separate disposition is supplied by the #116 validation path.
 */
export type ListingReadResult =
  | AuthenticatedListing
  | ListingReadFailure;

export interface ListingDiscoveryDeps {
  index: BindingIndex;
  readAnchor: (
    nativeAddress: string,
  ) => Promise<Record<string, unknown> | null>;
  verify: Verifier;
  /** Required only for owner-scoped history enumeration. */
  createHistoryPageFetcher?: (
    expectedOwner: string,
  ) => AnchorHistoryPageFetcher;
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
 * Resolve and authenticate one historical reduced-MVP Listing by its canonical
 * logical address. The owner is derived from that address; callers cannot pair
 * an arbitrary logical address with an unrelated owner hint.
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

  let resolutionValue: unknown;
  try {
    resolutionValue = structuredClone(
      await deps.index.resolve(logicalAddress, parsed.value.owner),
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
    typeof candidate.owner !== "string"
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
    readValue = await deps.readAnchor(binding.nativeAddress);
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

  if (
    typeof record.signature !== "string" ||
    !LOWER_HEX_ED25519_SIGNATURE.test(record.signature) ||
    Object.prototype.hasOwnProperty.call(record, "signatures")
  ) {
    return rejected(
      logicalAddress,
      "shape",
      "invalid-signature-envelope",
      "legacy Listing requires one exact lowercase Ed25519 signature and no signatures field",
      binding.nativeAddress,
    );
  }

  const scope = stripSignature(record);
  if (!isListing(scope)) {
    return rejected(
      logicalAddress,
      "shape",
      "unsupported-listing-shape",
      "record does not satisfy the SDK's supported reduced Listing shape",
      binding.nativeAddress,
    );
  }
  const listing = scope as unknown as Listing;
  if (listing.agentId !== parsed.value.agentId) {
    return rejected(
      logicalAddress,
      "context",
      "seller-mismatch",
      "Listing seller does not match the seller embedded in the logical address",
      binding.nativeAddress,
    );
  }
  if (listing.serviceId !== parsed.value.serviceId) {
    return rejected(
      logicalAddress,
      "context",
      "service-mismatch",
      "Listing service does not match the service embedded in the logical address",
      binding.nativeAddress,
    );
  }
  const recordVersion = listing.listingVersion ?? 1;
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
    listingAddress(listing.agentId, listing.serviceId, recordVersion) !==
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

  let signatureValid: boolean;
  try {
    signatureValid = await deps.verify(
      signedBytes(ARTIFACT_SEPARATORS.Listing, actualContentHash),
      Uint8Array.from(Buffer.from(record.signature, "hex")),
      parsed.value.publicKey,
    );
  } catch (error) {
    return {
      status: "indeterminate",
      logicalAddress,
      stage: "verification",
      reason:
        "Listing signature verification failed: " +
        (error instanceof Error ? error.message : String(error)),
    };
  }
  if (signatureValid !== true) {
    return rejected(
      logicalAddress,
      "signature",
      "signature-invalid",
      "Listing signature is not valid for the seller and Listing domain",
      binding.nativeAddress,
    );
  }

  return {
    status: "authenticated",
    compatibility: "legacy-mvp",
    ref: binding.nativeAddress,
    logicalAddress,
    version: parsed.value.version,
    contentHash: actualContentHash,
    listing,
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
      stage: "history" | "index" | "read" | "verification";
      listings: readonly [];
      diagnostics: readonly [];
      reason: string;
      retryCursor: string | null;
    };

/**
 * Page through authenticated historical Listings for one known canonical Demos
 * seller. This is owner-scoped history discovery, not a global marketplace
 * search and not an active/unrevoked Listing decision. Independent calls are
 * at-least-once: idempotently upsert by `(logicalAddress, contentHash, ref)`.
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
    if (!parsed.ok || parsed.value.agentId !== sellerId) {
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
    if (result.status === "authenticated") {
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

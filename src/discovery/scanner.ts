/**
 * Incremental anchor scanner (#54). Enumerates DACS-related anchors from a
 * substrate's write history, page by page, with an OPAQUE resume cursor — the
 * discovery primitive a Directory or catalog builds its index from, instead of
 * re-deriving addresses or scraping prose.
 *
 * SUBSTRATE-NEUTRAL by construction: the actual page fetch (Demos transaction
 * history → `stor-…` extraction + logical-address metadata) is an INJECTED seam,
 * so the classification, deduplication, and cursor discipline here are pure and
 * testable without a node. The Demos-backed `fetchPage` is the thin adapter layer.
 *
 * CLASSIFICATION is by the record's LOGICAL address (§6.3.4 point (b) metadata),
 * not the opaque native program name — the spec forbids the name as an
 * identifier. An entry with no logical-address metadata is not a DACS anchor and
 * is dropped.
 *
 * Two invariants the tests pin:
 *  - DEDUP: the same native address seen twice across pages is yielded once (a tx
 *    can appear in overlapping pages).
 *  - NO SKIPPED PAGES: a page fetch that FAILS returns `indeterminate` carrying
 *    the SAME cursor, so the caller retries from exactly where it was and never
 *    advances past unread history. Absence of results is only ever a real end of
 *    history (`nextCursor: null`), not a swallowed error.
 */

import {
  decodeAddressSegment,
  encodeAddressSegment,
  isCanonicalAddressSegmentValue,
} from "../canonical/addressing.js";
import { describeError } from "./describeError.js";

export type AnchorKind =
  | "listing"
  | "listing-revocation"
  | "verification-result"
  | "verification-composite"
  | "verification-registry"
  | "agreement-commitment"
  | "rail-registry"
  | "settlement-evidence"
  | "deliverable"
  | "entitlement"
  | "settlement-amendment"
  | "payment-disposition"
  | "payload-attestation"
  | "bundle"
  | "rating"
  | "unknown";

/**
 * A CF-4 variable segment is canonical when it is exactly what the SDK's
 * encoder produces for its decoded value: the reserved delimiters are escaped
 * with uppercase hex, nothing else is escaped, and the value is non-empty,
 * NFC-normalized Unicode scalar text. Identifier grammar is left to verifiers.
 * Check NFC before encoding: a delimiter escape's final hex letter can compose
 * with a following combining mark even when the decoded value is already NFC.
 */
function isCanonicalVariableSegment(segment: string): boolean {
  const value = decodeAddressSegment(segment);
  return (
    isCanonicalAddressSegmentValue(value) &&
    encodeAddressSegment(value) === segment
  );
}

/**
 * Classify current-profile logical-address structures (CORE §B.1 CF-4).
 * Broad `dacsN:` prefix matching is deliberately insufficient: ratings are not
 * bundles, and only `dacs4:payment:` is SettlementEvidence. Every `{jobId}` must
 * be a JID-1 canonical ULID, every variable segment must be canonical CF-4
 * (DACS-4 SB-1 makes a non-CF-4 rail segment an error), and fixed segments must
 * match their grammar: a URL-safe `listingId` of at most 128 characters and a
 * lowercase `scheme` token. Any other address is `unknown`, which a consumer
 * must not repair or resolve (JID-3). The CF-2 form of a ClaimReference inside
 * a variable segment is not parsed; the verifier checks the logical slot. A
 * `stor-` bundle address has the same shape as a DACS-1 stor-cred slot;
 * classification cannot tell them apart.
 */
export function classifyAnchor(logicalAddress: string): AnchorKind {
  // The only capturing group is a variable segment; `matches` checks each one.
  const segment = "([^:]+)";
  const jobId = "[0-7][0-9A-HJKMNP-TV-Z]{25}";
  const index = "(?:0|[1-9][0-9]*)";
  const hash = "[0-9a-f]{64}";
  const listingId = "[A-Za-z0-9._~-]{1,128}";
  const scheme = "[a-z][a-z0-9-]*";
  const matches = (pattern: string): boolean => {
    const match = new RegExp(pattern).exec(logicalAddress);
    return match !== null && match[0] === logicalAddress &&
      match.slice(1).every(isCanonicalVariableSegment);
  };
  if (matches(`^dacs1-revoked:${segment}:${listingId}:v[1-9][0-9]*$`)) {
    return "listing-revocation";
  }
  if (matches(`^dacs1:${segment}:${listingId}:v[1-9][0-9]*$`)) {
    return "listing";
  }
  if (logicalAddress === "dacs2:registry:v0.1") return "verification-registry";
  if (matches(`^dacs2:composite:${jobId}:${segment}$`)) {
    return "verification-composite";
  }
  if (matches(`^dacs2:${jobId}:${scheme}:${segment}:v[1-9][0-9]*$`)) {
    return "verification-result";
  }
  if (matches(`^dacs3:commit:${jobId}$`)) {
    return "agreement-commitment";
  }
  if (logicalAddress === "dacs4:registry:v0.1") return "rail-registry";
  if (matches(`^dacs4:payment:${jobId}:${segment}:${index}(?::resolved)?$`)) {
    return "settlement-evidence";
  }
  if (matches(`^dacs4:payment-disposition:${jobId}:${index}:${hash}$`)) {
    return "payment-disposition";
  }
  if (matches(`^dacs4:payload-attestation:${jobId}:${hash}:${index}$`)) {
    return "payload-attestation";
  }
  if (matches(`^dacs4:deliverable:${jobId}$`)) return "deliverable";
  if (matches(`^dacs4:entitlement:${jobId}:${index}$`)) {
    return "entitlement";
  }
  if (matches(`^dacs4:amendment:${jobId}:${hash}:${index}$`)) {
    return "settlement-amendment";
  }
  if (matches(`^stor-${hash}$`)) return "bundle";
  if (matches(`^dacs5:rating:${jobId}:${segment}$`)) return "rating";
  return "unknown";
}

/** One raw entry as the substrate reports it in a history page. */
export interface RawAnchorEntry {
  nativeAddress: string;
  /** The §6.3.4 logical address carried as record metadata; absent ⇒ not a DACS anchor. */
  logicalAddress?: string;
  owner?: string;
}

/** One page of raw entries plus the opaque cursor for the next page. */
export interface RawScanPage {
  entries: RawAnchorEntry[];
  /** Opaque cursor for the next page; null at the end of history. */
  nextCursor: string | null;
}

/** Substrate page seam consumed by the scanner. */
export type AnchorHistoryPageFetcher = (
  cursor: string | null,
  limit: number,
) => Promise<RawScanPage>;

/** A classified, DACS-recognised anchor. */
export interface ScannedAnchor {
  nativeAddress: string;
  logicalAddress: string;
  owner?: string;
  kind: AnchorKind;
}

/**
 * Thrown by a history fetcher when its cursor can no longer be resumed, for
 * example because the page boundary left the history window. Retrying the same
 * cursor cannot succeed; the traversal must restart from a null cursor.
 *
 * The scanner recognizes this signal by its `code`, not by `instanceof`, so a
 * fetcher bundled with another copy of the package is still recognized. Any
 * thrown value carrying the code therefore restarts the traversal: that fails
 * safe, because a restart re-reads history and never marks a row handled.
 */
export class AnchorHistoryRestartRequiredError extends Error {
  readonly code = "history-restart-required" as const;

  constructor(message: string) {
    super(message);
    this.name = "AnchorHistoryRestartRequiredError";
  }
}

/**
 * Machine-readable causes of an indeterminate page. An uncoded result is an
 * unavailable or malformed fetch that may succeed on retry. `metadata-conflict`,
 * `cursor-cycle` and `history-restart-required` cannot succeed on retry of the
 * same cursor; `page-limit-exceeded` and `invalid-limit` are fetcher or caller
 * faults.
 */
export type ScanPageCode =
  | "metadata-conflict"
  | "cursor-cycle"
  | "history-restart-required"
  | "page-limit-exceeded"
  | "invalid-limit";

export type ScanPage =
  | { status: "page"; anchors: ScannedAnchor[]; nextCursor: string | null }
  | {
      status: "indeterminate";
      reason: string;
      cursor: string | null;
      code?: ScanPageCode;
    };

/**
 * Incremental dedup state. A Map is preferred because its logical-address value
 * preserves conflict detection when state is persisted and reconstructed. A
 * Set remains accepted for backwards-compatible address-only deduplication.
 */
export type ScanSeen = Set<string> | Map<string, string>;

export interface ScanOptions {
  /** Max entries per page (bounded so a huge history can't be pulled at once). */
  limit?: number;
  /**
   * Native addresses already yielded in this scan — dedup carries across pages.
   * The caller owns it and reuses it between {@link scanAnchorPage} calls. Newly
   * yielded addresses are added to it.
   */
  seen?: ScanSeen;
  /**
   * Optional separate logical metadata for conflict detection, including filtered
   * rows. Newly observed metadata is added only after a page passes validation.
   * Entries here do not mark an address as handled in `seen`. It is checked in
   * addition to, never instead of, the metadata already held by `seen`.
   */
  logicalMetadata?: Map<string, string>;
  /** Keep `unknown`-kind anchors (default drops them — they aren't DACS artifacts). */
  includeUnknown?: boolean;
}

const DEFAULT_LIMIT = 100;
const logicalMetadataByLegacySeenSet = new WeakMap<
  Set<string>,
  Map<string, string>
>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a thrown value's restart code without letting a hostile value throw. */
function requiresRestart(e: unknown): boolean {
  try {
    return (
      typeof e === "object" &&
      e !== null &&
      (e as { code?: unknown }).code === "history-restart-required"
    );
  } catch {
    return false;
  }
}

// Marked by identity, never by a message or code a forwarded error could carry.
const historyMetadataConflicts = new WeakSet<object>();

/**
 * For the bundled history fetchers; not exported by the package. An `Error` for
 * history that assigns two logical addresses to one native address, which no
 * retry clears: {@link scanAnchorPage} codes it `metadata-conflict`, like the
 * conflicts it detects itself.
 */
export function historyMetadataConflictError(message: string): Error {
  const error = new Error(message);
  historyMetadataConflicts.add(error);
  return error;
}

function isHistoryMetadataConflict(e: unknown): boolean {
  return typeof e === "object" && e !== null && historyMetadataConflicts.has(e);
}

function validateRawPage(value: unknown): RawScanPage {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw new Error("history page must contain an entries array");
  }
  if (value.nextCursor !== null && typeof value.nextCursor !== "string") {
    throw new Error("history page nextCursor must be a string or null");
  }

  const entries: RawAnchorEntry[] = value.entries.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new Error(`history entry ${index} must be an object`);
    }
    if (
      typeof candidate.nativeAddress !== "string" ||
      candidate.nativeAddress.trim().length === 0
    ) {
      throw new Error(`history entry ${index} has no native address`);
    }
    if (
      candidate.logicalAddress !== undefined &&
      (typeof candidate.logicalAddress !== "string" ||
        candidate.logicalAddress.trim().length === 0)
    ) {
      throw new Error(`history entry ${index} has invalid logical metadata`);
    }
    if (
      candidate.owner !== undefined &&
      (typeof candidate.owner !== "string" || candidate.owner.trim().length === 0)
    ) {
      throw new Error(`history entry ${index} has an invalid owner`);
    }
    return {
      nativeAddress: candidate.nativeAddress,
      ...(candidate.logicalAddress === undefined
        ? {}
        : { logicalAddress: candidate.logicalAddress }),
      ...(candidate.owner === undefined ? {} : { owner: candidate.owner }),
    };
  });

  return { entries, nextCursor: value.nextCursor };
}

/**
 * Fetch, classify, and dedup ONE page from `cursor`. Returns the classified
 * anchors + the next cursor, or `indeterminate` (carrying the unchanged cursor)
 * when the page fetch fails — the caller retries the same cursor, never skipping.
 */
export async function scanAnchorPage(
  fetchPage: AnchorHistoryPageFetcher,
  cursor: string | null,
  opts: ScanOptions = {},
): Promise<ScanPage> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const seen = opts.seen ?? new Map<string, string>();
  let dedupLogicalMetadata: Map<string, string>;
  if (seen instanceof Map) {
    dedupLogicalMetadata = seen;
  } else {
    dedupLogicalMetadata = logicalMetadataByLegacySeenSet.get(seen) ?? new Map();
    logicalMetadataByLegacySeenSet.set(seen, dedupLogicalMetadata);
  }
  // Separate metadata adds to, never replaces, the dedup state's metadata.
  const logicalMetadata = opts.logicalMetadata;
  const seenLogicalMetadata = logicalMetadata ?? dedupLogicalMetadata;
  const knownLogicalMetadata = logicalMetadata === undefined
    ? [dedupLogicalMetadata]
    : [logicalMetadata, dedupLogicalMetadata];

  if (!Number.isSafeInteger(limit) || limit <= 0) {
    return {
      status: "indeterminate",
      code: "invalid-limit",
      reason: "page limit must be a positive safe integer",
      cursor,
    };
  }

  let page: RawScanPage;
  try {
    page = validateRawPage(await fetchPage(cursor, limit));
  } catch (e) {
    return {
      status: "indeterminate",
      reason: `page fetch failed: ${describeError(e)}`,
      cursor,
      ...(requiresRestart(e)
        ? { code: "history-restart-required" as const }
        : isHistoryMetadataConflict(e) ? { code: "metadata-conflict" as const } : {}),
    };
  }
  if (cursor !== null && page.nextCursor === cursor) {
    return {
      status: "indeterminate",
      code: "cursor-cycle",
      reason: "page fetch failed: history page cursor did not advance",
      cursor,
    };
  }
  // A custom fetcher must honour the bound; an oversized page is never consumed.
  if (page.entries.length > limit) {
    return {
      status: "indeterminate",
      code: "page-limit-exceeded",
      reason: `page fetch failed: history page returned ${page.entries.length} entries for limit ${limit}`,
      cursor,
    };
  }

  const anchors: ScannedAnchor[] = [];
  const pendingLogicalMetadata = new Map<string, string>();
  const pendingSeen = new Set<string>();
  for (const entry of page.entries) {
    if (!entry.logicalAddress) continue; // not a DACS anchor (no logical metadata)
    const previousLogicalAddress = [
      pendingLogicalMetadata.get(entry.nativeAddress),
      ...knownLogicalMetadata.map((metadata) => metadata.get(entry.nativeAddress)),
    ].find((logical) => logical !== undefined && logical !== entry.logicalAddress);
    if (previousLogicalAddress !== undefined) {
      return {
        status: "indeterminate",
        code: "metadata-conflict",
        reason:
          `conflicting logical metadata for ${entry.nativeAddress}: ` +
          `${previousLogicalAddress} vs ${entry.logicalAddress}`,
        cursor,
      };
    }
    pendingLogicalMetadata.set(entry.nativeAddress, entry.logicalAddress);
    if (seen.has(entry.nativeAddress) || pendingSeen.has(entry.nativeAddress)) {
      continue; // duplicate tx within/across pages
    }
    const kind = classifyAnchor(entry.logicalAddress);
    if (kind === "unknown" && !opts.includeUnknown) continue;
    pendingSeen.add(entry.nativeAddress);
    anchors.push({
      nativeAddress: entry.nativeAddress,
      logicalAddress: entry.logicalAddress,
      ...(entry.owner !== undefined ? { owner: entry.owner } : {}),
      kind,
    });
  }
  for (const [nativeAddress, logicalAddress] of pendingLogicalMetadata) {
    seenLogicalMetadata.set(nativeAddress, logicalAddress);
  }
  for (const nativeAddress of pendingSeen) {
    if (seen instanceof Map) {
      seen.set(nativeAddress, pendingLogicalMetadata.get(nativeAddress)!);
    } else {
      seen.add(nativeAddress);
    }
  }
  return { status: "page", anchors, nextCursor: page.nextCursor };
}

/**
 * Drain the whole history from `startCursor` into a single deduped list. A
 * convenience over {@link scanAnchorPage} for callers that want everything at
 * once; a page fetch failure ABORTS with the partial results and a resume cursor,
 * so nothing is silently dropped. `maxPages` bounds a runaway/adversarial history.
 */
export async function scanAllAnchors(
  fetchPage: AnchorHistoryPageFetcher,
  opts: ScanOptions & { startCursor?: string | null; maxPages?: number } = {},
): Promise<
  | { status: "complete"; anchors: ScannedAnchor[] }
  | { status: "aborted"; anchors: ScannedAnchor[]; resumeCursor: string | null; reason: string }
> {
  const seen = opts.seen ?? new Map<string, string>();
  const all: ScannedAnchor[] = [];
  let cursor = opts.startCursor ?? null;
  const maxPages = opts.maxPages ?? 10_000;
  const visitedCursors = new Set<string>();

  for (let i = 0; i < maxPages; i++) {
    const res = await scanAnchorPage(fetchPage, cursor, { ...opts, seen });
    if (res.status === "indeterminate") {
      return { status: "aborted", anchors: all, resumeCursor: res.cursor, reason: res.reason };
    }
    all.push(...res.anchors);
    if (res.nextCursor === null) return { status: "complete", anchors: all };
    if (visitedCursors.has(res.nextCursor)) {
      return {
        status: "aborted",
        anchors: all,
        resumeCursor: cursor,
        reason: `history cursor cycle detected at ${res.nextCursor}`,
      };
    }
    if (cursor !== null) visitedCursors.add(cursor);
    cursor = res.nextCursor;
  }
  return {
    status: "aborted",
    anchors: all,
    resumeCursor: cursor,
    reason: `stopped after ${maxPages} pages (maxPages bound)`,
  };
}

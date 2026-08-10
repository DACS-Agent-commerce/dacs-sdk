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
  | "bundle"
  | "rating"
  | "unknown";

/**
 * Classify exact current-profile logical-address structures. Broad `dacsN:`
 * prefix matching is deliberately insufficient: ratings are not bundles, and
 * only `dacs4:payment:` is SettlementEvidence.
 */
export function classifyAnchor(logicalAddress: string): AnchorKind {
  const segment = "[^:]+";
  if (new RegExp(`^dacs1-revoked:${segment}:${segment}:v[1-9][0-9]*$`).test(logicalAddress)) {
    return "listing-revocation";
  }
  if (new RegExp(`^dacs1:${segment}:${segment}:v[1-9][0-9]*$`).test(logicalAddress)) {
    return "listing";
  }
  if (logicalAddress === "dacs2:registry:v0.1") return "verification-registry";
  if (new RegExp(`^dacs2:composite:${segment}:${segment}$`).test(logicalAddress)) {
    return "verification-composite";
  }
  if (new RegExp(`^dacs2:${segment}:${segment}:${segment}:v[1-9][0-9]*$`).test(logicalAddress)) {
    return "verification-result";
  }
  if (new RegExp(`^dacs3:commit:${segment}$`).test(logicalAddress)) {
    return "agreement-commitment";
  }
  if (logicalAddress === "dacs4:registry:v0.1") return "rail-registry";
  if (new RegExp(`^dacs4:payment:${segment}:${segment}:(0|[1-9][0-9]*)(:resolved)?$`).test(logicalAddress)) {
    return "settlement-evidence";
  }
  if (new RegExp(`^dacs4:deliverable:${segment}$`).test(logicalAddress)) return "deliverable";
  if (new RegExp(`^dacs4:entitlement:${segment}:(0|[1-9][0-9]*)$`).test(logicalAddress)) {
    return "entitlement";
  }
  if (new RegExp(`^dacs4:amendment:${segment}:[0-9a-f]{64}:(0|[1-9][0-9]*)$`).test(logicalAddress)) {
    return "settlement-amendment";
  }
  if (/^stor-[0-9a-f]{64}$/.test(logicalAddress)) return "bundle";
  if (new RegExp(`^dacs5:rating:${segment}:${segment}$`).test(logicalAddress)) return "rating";
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

export type ScanPage =
  | { status: "page"; anchors: ScannedAnchor[]; nextCursor: string | null }
  | { status: "indeterminate"; reason: string; cursor: string | null };

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
  let seenLogicalMetadata: Map<string, string>;
  if (seen instanceof Map) {
    seenLogicalMetadata = seen;
  } else {
    seenLogicalMetadata = logicalMetadataByLegacySeenSet.get(seen) ?? new Map();
    logicalMetadataByLegacySeenSet.set(seen, seenLogicalMetadata);
  }

  if (!Number.isSafeInteger(limit) || limit <= 0) {
    return {
      status: "indeterminate",
      reason: "page limit must be a positive safe integer",
      cursor,
    };
  }

  let page: RawScanPage;
  try {
    page = validateRawPage(await fetchPage(cursor, limit));
    if (cursor !== null && page.nextCursor === cursor) {
      throw new Error("history page cursor did not advance");
    }
  } catch (e) {
    return {
      status: "indeterminate",
      reason: `page fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      cursor,
    };
  }

  const anchors: ScannedAnchor[] = [];
  const pendingLogicalMetadata = new Map<string, string>();
  const pendingSeen = new Set<string>();
  for (const entry of page.entries) {
    if (!entry.logicalAddress) continue; // not a DACS anchor (no logical metadata)
    const previousLogicalAddress =
      pendingLogicalMetadata.get(entry.nativeAddress) ??
      seenLogicalMetadata.get(entry.nativeAddress);
    if (
      previousLogicalAddress !== undefined &&
      previousLogicalAddress !== entry.logicalAddress
    ) {
      return {
        status: "indeterminate",
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

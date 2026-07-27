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
  | "verification"
  | "agreement"
  | "settlement-evidence"
  | "bundle"
  | "unknown";

/** Classify a DACS logical address by its `dacsN[...]:` structural prefix. */
export function classifyAnchor(logicalAddress: string): AnchorKind {
  if (logicalAddress.startsWith("dacs1-revoked:")) return "listing-revocation";
  if (logicalAddress.startsWith("dacs1:")) return "listing";
  if (logicalAddress.startsWith("dacs2:")) return "verification";
  if (logicalAddress.startsWith("dacs3:")) return "agreement";
  if (logicalAddress.startsWith("dacs4:")) return "settlement-evidence";
  if (logicalAddress.startsWith("dacs5:")) return "bundle";
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

export interface ScanOptions {
  /** Max entries per page (bounded so a huge history can't be pulled at once). */
  limit?: number;
  /**
   * Native addresses already yielded in this scan — dedup carries across pages.
   * The caller owns it and reuses it between {@link scanAnchorPage} calls. Newly
   * yielded addresses are added to it.
   */
  seen?: Set<string>;
  /** Keep `unknown`-kind anchors (default drops them — they aren't DACS artifacts). */
  includeUnknown?: boolean;
}

const DEFAULT_LIMIT = 100;

/**
 * Fetch, classify, and dedup ONE page from `cursor`. Returns the classified
 * anchors + the next cursor, or `indeterminate` (carrying the unchanged cursor)
 * when the page fetch fails — the caller retries the same cursor, never skipping.
 */
export async function scanAnchorPage(
  fetchPage: (cursor: string | null, limit: number) => Promise<RawScanPage>,
  cursor: string | null,
  opts: ScanOptions = {},
): Promise<ScanPage> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const seen = opts.seen ?? new Set<string>();

  let page: RawScanPage;
  try {
    page = await fetchPage(cursor, limit);
  } catch (e) {
    return {
      status: "indeterminate",
      reason: `page fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      cursor,
    };
  }

  const anchors: ScannedAnchor[] = [];
  for (const entry of page.entries) {
    if (!entry.logicalAddress) continue; // not a DACS anchor (no logical metadata)
    if (seen.has(entry.nativeAddress)) continue; // duplicate tx across pages
    const kind = classifyAnchor(entry.logicalAddress);
    if (kind === "unknown" && !opts.includeUnknown) continue;
    seen.add(entry.nativeAddress);
    anchors.push({
      nativeAddress: entry.nativeAddress,
      logicalAddress: entry.logicalAddress,
      ...(entry.owner !== undefined ? { owner: entry.owner } : {}),
      kind,
    });
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
  fetchPage: (cursor: string | null, limit: number) => Promise<RawScanPage>,
  opts: ScanOptions & { startCursor?: string | null; maxPages?: number } = {},
): Promise<
  | { status: "complete"; anchors: ScannedAnchor[] }
  | { status: "aborted"; anchors: ScannedAnchor[]; resumeCursor: string | null; reason: string }
> {
  const seen = opts.seen ?? new Set<string>();
  const all: ScannedAnchor[] = [];
  let cursor = opts.startCursor ?? null;
  const maxPages = opts.maxPages ?? 10_000;

  for (let i = 0; i < maxPages; i++) {
    const res = await scanAnchorPage(fetchPage, cursor, { ...opts, seen });
    if (res.status === "indeterminate") {
      return { status: "aborted", anchors: all, resumeCursor: res.cursor, reason: res.reason };
    }
    all.push(...res.anchors);
    if (res.nextCursor === null) return { status: "complete", anchors: all };
    cursor = res.nextCursor;
  }
  return {
    status: "aborted",
    anchors: all,
    resumeCursor: cursor,
    reason: `stopped after ${maxPages} pages (maxPages bound)`,
  };
}

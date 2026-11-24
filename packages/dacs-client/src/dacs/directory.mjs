// Community DACS Directory client. Results are discovery hints only; nothing
// here is treated as chain authority.
//
// Discovery wire contract: https://github.com/DACS-Agent-commerce/Community/tree/
// 074f040e2165fb581000fb60c53c65530d6e29d6/reference-implementations/dacs-directory
// app/api/dacs/listings/route.ts and src/catalog/types.ts. Bounded-origin
// transport is local policy, with no historical demo authority claim.
//
// A row is read as the Directory's row contract defines it: the required
// top-level row members are present, `status` is `active` or `revoked`, a
// `revocation` object is present exactly when the row is revoked,
// `transactionReadiness` is `{disposition: "unassessed", reason}` and
// `catalogObservedAt` is an integer. A row that does not match is refused,
// never repaired, and no legacy field is read in its place.
import { encodeAddressSegment, isRevocationBinding } from '@kynesyslabs/dacs';
import { fetchBoundedJson, OutboundError } from '../util/http.mjs';
import { SIMULATION_HEADER, isRecord } from './chain.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
const LOCATOR = /^stor-[0-9a-f]{40}$/;
const LISTING_ID = /^(?!\.+$)[A-Za-z0-9._~-]{1,128}$/;
const CLAIM = /^did:demos:agent:[0-9a-f]{64}$/;
const CURSOR = /^\d{1,9}$/;

const MIN_PAGE_LIMIT = 1;
const MAX_PAGE_LIMIT = 50;
// A lookup reads at most this many pages of MAX_PAGE_LIMIT rows. With a cursor
// still present after the last one, the scan did not reach the end of the list.
const MAX_SCAN_PAGES = 5;
const MAX_MEMBER_NAME = 64;
const REVOCATION_MEMBERS = ['sellerPrimaryClaim', 'listingId', 'listingVersion', 'listingContentHash', 'logicalAddress', 'markerAnchor', 'markerContentHash'];
const MARKER_ANCHOR_MEMBERS = ['kind', 'locator'];

/** Codes (on an `invalid` OutboundError) for a Directory answer that breaks the row or list contract. */
export const DIRECTORY_CONTRACT_CODES = Object.freeze([
  'directory_row_ambiguous',
  'directory_row_malformed',
  'directory_scan_incomplete',
  'directory_scan_unconfirmed',
  'directory_cursor_invalid',
  'directory_page_oversized',
]);

function contractError(code, message, member) {
  const error = new OutboundError('invalid', message);
  error.code = code;
  if (member !== undefined) error.member = member;
  return error;
}

function str(value, max = 2000) {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);

/**
 * Epoch milliseconds from a Directory observation time. This is the reader's
 * policy, stricter than the schema's `integer`: only a non-negative safe
 * integer is accepted, and a date string is not. Returns undefined otherwise.
 */
export function normalizeCatalogObservedAt(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

const extraMember = (record, allowed) => Object.keys(record).find((name) => !allowed.includes(name));

// The first member of a revoked row's `revocation` that breaks the contract,
// or null. It must have exactly its seven members, and name this row's
// Listing: claim, id, version, content hash and the dacs1-revoked address.
function revocationProblem(revocation, row) {
  if (!isRecord(revocation)) return 'revocation';
  const extra = extraMember(revocation, REVOCATION_MEMBERS);
  if (extra !== undefined) return `revocation.${extra.slice(0, MAX_MEMBER_NAME)}`;
  const expected = {
    sellerPrimaryClaim: row.seller.primaryClaim,
    listingId: row.listingId,
    listingVersion: row.version,
    listingContentHash: row.contentHash,
    logicalAddress: `dacs1-revoked:${encodeAddressSegment(row.seller.primaryClaim)}:${row.listingId}:v${row.version}`,
  };
  const wrong = Object.keys(expected).find((name) => revocation[name] !== expected[name]);
  if (wrong !== undefined) return `revocation.${wrong}`;
  if (!isRecord(revocation.markerAnchor)) return 'revocation.markerAnchor';
  const anchorExtra = extraMember(revocation.markerAnchor, MARKER_ANCHOR_MEMBERS);
  if (anchorExtra !== undefined) return `revocation.markerAnchor.${anchorExtra.slice(0, MAX_MEMBER_NAME)}`;
  if (isRevocationBinding(revocation)) return null;
  return HEX64.test(revocation.markerContentHash) ? 'revocation.markerAnchor' : 'revocation.markerContentHash';
}

const readinessIsUnassessed = (readiness) => isRecord(readiness)
  && Object.keys(readiness).length === 2
  && readiness.disposition === 'unassessed'
  && typeof readiness.reason === 'string'
  && readiness.reason.length > 0;

// The member of `raw` that breaks the row contract, or null.
function rowProblem(raw) {
  if (!matches(LISTING_ID, raw.listingId)) return 'listingId';
  if (!Number.isSafeInteger(raw.version) || raw.version < 1) return 'version';
  if (!matches(HEX64, raw.contentHash)) return 'contentHash';
  if (raw.anchor?.kind !== 'storage-program' || !matches(LOCATOR, raw.anchor.locator)) return 'anchor';
  if (!matches(CLAIM, raw.seller?.primaryClaim)) return 'seller.primaryClaim';
  if (!isRecord(raw.offering)) return 'offering';
  if (!isRecord(raw.pricing)) return 'pricing';
  if (raw.status !== 'active' && raw.status !== 'revoked') return 'status';
  // Presence decides for an active row: `revocation: null` is still a violation.
  if (raw.status === 'active' && Object.hasOwn(raw, 'revocation')) return 'revocation';
  if (raw.status === 'revoked') {
    const problem = revocationProblem(raw.revocation, raw);
    if (problem !== null) return problem;
  }
  if (!readinessIsUnassessed(raw.transactionReadiness)) return 'transactionReadiness';
  if (normalizeCatalogObservedAt(raw.catalogObservedAt) === undefined) return 'catalogObservedAt';
  return null;
}

/**
 * Whitelist projection: only these fields ever reach the model, with lengths
 * capped, so a hostile directory cannot inject arbitrary payloads. Returns
 * exactly one of `{summary}` or `{problem}`, where `problem` names the member
 * of the row that breaks the contract.
 */
function projectSummary(raw) {
  if (!isRecord(raw)) return { problem: 'row' };
  const problem = rowProblem(raw);
  if (problem !== null) return { problem };
  const { offering, pricing } = raw;
  return { summary: {
    listingId: raw.listingId,
    version: raw.version,
    contentHash: raw.contentHash,
    anchor: { kind: 'storage-program', locator: raw.anchor.locator },
    seller: { primaryClaim: raw.seller.primaryClaim, displayName: str(raw.seller.displayName, 200) },
    title: str(offering.title, 200) ?? '',
    description: str(offering.description, 2000),
    category: str(offering.category, 64),
    tags: Array.isArray(offering.tags) ? offering.tags.filter((t) => typeof t === 'string').slice(0, 16).map((t) => t.slice(0, 32)) : [],
    rails: Array.isArray(offering.rails) ? offering.rails.filter((t) => typeof t === 'string').slice(0, 8) : [],
    pricingHint: {
      kind: str(pricing.kind, 32),
      priceHint: str(pricing.priceHint, 64),
      currency: str(pricing.currency, 16),
      unit: str(pricing.unit, 32),
    },
    publicEndpoint: str(raw.publicEndpoint, 512),
    artifactProfile: str(raw.artifactProfile, 64),
    status: raw.status,
    ...(raw.status === 'revoked' ? { revocation: { ...raw.revocation, markerAnchor: { ...raw.revocation.markerAnchor } } } : {}),
    catalogObservedAt: raw.catalogObservedAt,
  } };
}

// The one integer limit a page request sends: an integer, held to 1 to 50.
function pageLimit(limit) {
  if (!Number.isSafeInteger(limit)) throw new OutboundError('invalid', 'directory page limit must be an integer');
  return Math.min(Math.max(limit, MIN_PAGE_LIMIT), MAX_PAGE_LIMIT);
}

// A page's continuation cursor: absent means the end of the list; a present one must be well formed.
function pageCursor(body) {
  if (body.cursor === undefined) return undefined;
  if (!matches(CURSOR, body.cursor)) throw contractError('directory_cursor_invalid', 'directory page cursor is malformed');
  return body.cursor;
}

// The summary of a row a lookup matched, or a directory_row_malformed error naming the broken member.
function summaryOf(raw) {
  const { summary, problem } = projectSummary(raw);
  if (!summary) throw contractError('directory_row_malformed', `directory row is malformed at ${problem}`, problem);
  return summary;
}

const sameCoordinates = (raw, { listingId, version, seller }) =>
  isRecord(raw) && raw.listingId === listingId && raw.version === version && raw.seller?.primaryClaim === seller;

export function createDirectoryClient({ origin, timeoutMs = 8000, maxBytes = 1_000_000, fetchImpl = globalThis.fetch }) {
  let simulated = false;
  const observingFetch = async (input, init) => {
    const response = await fetchImpl(input, init);
    if (response.headers.get(SIMULATION_HEADER)) simulated = true;
    return response;
  };
  const get = (path, max = maxBytes) =>
    fetchBoundedJson(`${origin}${path}`, { fetchImpl: observingFetch, timeoutMs, maxBytes: max, expectedOrigin: origin });

  // One bounded page: its raw rows (never more than the limit sent), its
  // continuation cursor and its total.
  async function readPage({ query, category, primaryClaim, limit, cursor }) {
    const sent = pageLimit(limit);
    const params = new URLSearchParams({ profile: 'dacs-v0.1', limit: String(sent) });
    if (query) params.set('q', query.slice(0, 200));
    if (category) params.set('category', category.slice(0, 64));
    if (primaryClaim) params.set('primaryClaim', primaryClaim);
    if (cursor) params.set('cursor', String(cursor).slice(0, 32));
    const body = await get(`/api/dacs/listings?${params}`);
    if (!body || !Array.isArray(body.listings)) throw new OutboundError('invalid', 'directory listings response is malformed');
    if (body.listings.length > sent) throw contractError('directory_page_oversized', `directory page holds ${body.listings.length} rows, more than the ${sent} requested`);
    return { rows: body.listings, cursor: pageCursor(body), total: Number.isSafeInteger(body.total) ? body.total : undefined };
  }

  /**
   * One page of listing summaries. Only rows that match the contract are
   * listed; every other row adds one to `rejected`. Throws OutboundError for an
   * unavailable, oversized or malformed answer, or a malformed cursor.
   */
  async function search({ query, category, primaryClaim, limit = 20, cursor } = {}) {
    const page = await readPage({ query, category, primaryClaim, limit, cursor });
    const listings = [];
    let rejected = 0;
    for (const raw of page.rows) {
      const { summary } = projectSummary(raw);
      if (summary) listings.push(summary);
      else rejected += 1;
    }
    return { listings, rejected, cursor: page.cursor, total: page.total };
  }

  /**
   * The summary (anchor locator, catalog status) for one exact listing, or null
   * when a complete scan finds none. The scan reads at most five pages of 50
   * rows. It answers only at a valid end of the list (a page with no cursor)
   * within those pages, because the Directory has no exact-coordinates query
   * and a second row for the same listing could sit past the fifth page.
   * Throws OutboundError with a DIRECTORY_CONTRACT_CODES code for a second
   * matching row, a malformed matching row, a repeated or malformed cursor, an
   * oversized page, a cursor still present after the fifth page with a match
   * found (directory_scan_unconfirmed), or with no match found
   * (directory_scan_incomplete).
   */
  async function findSummary(coordinates) {
    const cursors = new Set();
    let match = null;
    let cursor;
    for (let pages = 0; pages < MAX_SCAN_PAGES; pages += 1) {
      const page = await readPage({ primaryClaim: coordinates.seller, limit: MAX_PAGE_LIMIT, cursor });
      for (const raw of page.rows.filter((row) => sameCoordinates(row, coordinates))) {
        if (match) throw contractError('directory_row_ambiguous', 'more than one directory row matches the listing coordinates');
        match = raw;
      }
      if (page.cursor === undefined) return match && summaryOf(match);
      if (cursors.has(page.cursor)) throw contractError('directory_cursor_invalid', 'directory page cursor repeats an earlier cursor');
      cursors.add(page.cursor);
      cursor = page.cursor;
    }
    if (match) throw contractError('directory_scan_unconfirmed', `a matching directory row was found but the seller's rows after page ${MAX_SCAN_PAGES} were not read, so it cannot be shown to be the only one`);
    throw contractError('directory_scan_incomplete', `directory scan has more pages after ${MAX_SCAN_PAGES}`);
  }

  async function getListingDetail({ listingId, version, seller }) {
    if (!LISTING_ID.test(listingId) || !Number.isSafeInteger(version) || !CLAIM.test(seller)) {
      throw new OutboundError('invalid', 'listing coordinates are malformed');
    }
    const params = new URLSearchParams({ seller });
    const body = await get(`/api/dacs/listings/${encodeURIComponent(listingId)}/${version}?${params}`, 64 * 1024);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OutboundError('invalid', 'directory listing detail is malformed');
    return body;
  }

  return {
    origin,
    get evidenceMode() {
      return simulated ? 'simulated-fixture' : 'public-directory-read';
    },
    search,
    findSummary,
    getListingDetail,
  };
}

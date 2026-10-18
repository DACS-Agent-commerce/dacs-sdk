// Community DACS Directory client. Results are discovery hints only; nothing
// here is treated as chain authority.
//
// Discovery wire contract: https://github.com/DACS-Agent-commerce/Community/tree/
// 074f040e2165fb581000fb60c53c65530d6e29d6/reference-implementations/dacs-directory
// app/api/dacs/listings/route.ts and src/catalog/types.ts. Bounded-origin
// transport is local policy, with no historical demo authority claim.
import { fetchBoundedJson, OutboundError } from '../util/http.mjs';
import { SIMULATION_HEADER } from './chain.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
const LOCATOR = /^stor-[0-9a-f]{40}$/;
const LISTING_ID = /^(?!\.+$)[A-Za-z0-9._~-]{1,128}$/;
const CLAIM = /^did:demos:agent:[0-9a-f]{64}$/;

function str(value, max = 2000) {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

// The SDK uses epoch milliseconds; retain bounded legacy date strings too.
export function normalizeCatalogObservedAt(value) {
  const observedAt = typeof value === 'string' && value.length <= 64 ? Date.parse(value) : value;
  return Number.isSafeInteger(observedAt) && observedAt >= 0 ? observedAt : undefined;
}

// Whitelist projection: only these fields ever reach the model, with lengths
// capped, so a hostile directory cannot inject arbitrary payloads.
export function projectSummary(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!LISTING_ID.test(raw.listingId ?? '') || !Number.isSafeInteger(raw.version) || raw.version < 1) return null;
  if (!HEX64.test(raw.contentHash ?? '')) return null;
  if (raw.anchor?.kind !== 'storage-program' || !LOCATOR.test(raw.anchor?.locator ?? '')) return null;
  if (!CLAIM.test(raw.seller?.primaryClaim ?? '')) return null;
  if (!['active', 'revoked'].includes(raw.status)) return null;
  const pricing = raw.pricing ?? {};
  return {
    listingId: raw.listingId,
    version: raw.version,
    contentHash: raw.contentHash,
    anchor: { kind: 'storage-program', locator: raw.anchor.locator },
    seller: { primaryClaim: raw.seller.primaryClaim, displayName: str(raw.seller.displayName, 200) },
    title: str(raw.offering?.title, 200) ?? '',
    description: str(raw.offering?.description, 2000),
    category: str(raw.offering?.category, 64),
    tags: Array.isArray(raw.offering?.tags) ? raw.offering.tags.filter((t) => typeof t === 'string').slice(0, 16).map((t) => t.slice(0, 32)) : [],
    rails: Array.isArray(raw.offering?.rails) ? raw.offering.rails.filter((t) => typeof t === 'string').slice(0, 8) : [],
    pricingHint: {
      kind: str(pricing.kind, 32),
      priceHint: str(pricing.priceHint, 64),
      currency: str(pricing.currency, 16),
      unit: str(pricing.unit, 32),
    },
    publicEndpoint: str(raw.publicEndpoint, 512),
    artifactProfile: str(raw.artifactProfile, 64),
    status: raw.status,
    revocationBinding: raw.revocationBinding && typeof raw.revocationBinding === 'object' ? raw.revocationBinding : undefined,
    catalogObservedAt: normalizeCatalogObservedAt(raw.catalogObservedAt),
  };
}

export function createDirectoryClient({ origin, timeoutMs = 8000, maxBytes = 1_000_000, fetchImpl = globalThis.fetch }) {
  let simulated = false;
  const observingFetch = async (input, init) => {
    const response = await fetchImpl(input, init);
    if (response.headers.get(SIMULATION_HEADER)) simulated = true;
    return response;
  };
  const get = (path, max = maxBytes) =>
    fetchBoundedJson(`${origin}${path}`, { fetchImpl: observingFetch, timeoutMs, maxBytes: max, expectedOrigin: origin });

  async function search({ query, category, primaryClaim, limit = 20, cursor } = {}) {
    const params = new URLSearchParams({ profile: 'dacs-v0.1', limit: String(Math.min(Math.max(limit, 1), 50)) });
    if (query) params.set('q', query.slice(0, 200));
    if (category) params.set('category', category.slice(0, 64));
    if (primaryClaim) params.set('primaryClaim', primaryClaim);
    if (cursor) params.set('cursor', String(cursor).slice(0, 32));
    const body = await get(`/api/dacs/listings?${params}`);
    if (!body || !Array.isArray(body.listings)) throw new OutboundError('invalid', 'directory listings response is malformed');
    const listings = [];
    let rejected = 0;
    for (const raw of body.listings.slice(0, 200)) {
      const projected = projectSummary(raw);
      if (projected) listings.push(projected);
      else rejected += 1;
    }
    return {
      listings,
      rejected,
      cursor: typeof body.cursor === 'string' && /^\d{1,9}$/.test(body.cursor) ? body.cursor : undefined,
      total: Number.isSafeInteger(body.total) ? body.total : undefined,
    };
  }

  // Find the summary (anchor locator, catalog status) for one exact listing.
  async function findSummary({ listingId, version, seller }) {
    let cursor;
    for (let page = 0; page < 5; page += 1) {
      const result = await search({ primaryClaim: seller, limit: 50, cursor });
      const match = result.listings.find((l) => l.listingId === listingId && l.version === version && l.seller.primaryClaim === seller);
      if (match) return match;
      if (!result.cursor) return null;
      cursor = result.cursor;
    }
    return null;
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

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

// DACS-1 RevocationBinding is discovery data; post-fetch RB-4 verification
// still belongs to the artifact verifier. Do not pass extension objects on.
function projectRevocationBinding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const bounds = { sellerPrimaryClaim: 256, listingId: 128, listingContentHash: 64,
    logicalAddress: 1024, markerContentHash: 64 };
  for (const [field, max] of Object.entries(bounds)) {
    if (typeof value[field] !== 'string' || !value[field].length || value[field].length > max) return undefined;
  }
  if (!HEX64.test(value.listingContentHash) || !HEX64.test(value.markerContentHash)
    // DACS-1 RB-1/RB-2, CORE CF-4: encode the claim's reserved delimiters.
    || value.logicalAddress !== `dacs1-revoked:${value.sellerPrimaryClaim.replace(/[:?&=%]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase())}:${value.listingId}:v${value.listingVersion}`) return undefined;
  if (!Number.isSafeInteger(value.listingVersion) || value.listingVersion < 1
    || !value.markerAnchor || Array.isArray(value.markerAnchor)
    || typeof value.markerAnchor.kind !== 'string' || !value.markerAnchor.kind.length || value.markerAnchor.kind.length > 64
    || typeof value.markerAnchor.locator !== 'string' || !value.markerAnchor.locator.length || value.markerAnchor.locator.length > 1024) return undefined;
  return { ...Object.fromEntries(Object.keys(bounds).map(field => [field, value[field]])),
    listingVersion: value.listingVersion,
    markerAnchor: { kind: value.markerAnchor.kind, locator: value.markerAnchor.locator } };
}

// DACS-1 §6.3.6 calls this field revocation; the pinned Community wire
// contract calls it revocationBinding. Conflicting hints remain unavailable.
function summaryRevocation(raw) {
  // DACS-1 RB-3: active discovery records MUST NOT carry a binding.
  if (raw.status !== 'revoked') return undefined;
  const standard = projectRevocationBinding(raw.revocation);
  const community = projectRevocationBinding(raw.revocationBinding);
  if (raw.revocation !== undefined && raw.revocationBinding !== undefined) {
    if (!standard || !community || JSON.stringify(standard) !== JSON.stringify(community)) return undefined;
  }
  const binding = standard ?? community;
  return binding && binding.sellerPrimaryClaim === raw.seller.primaryClaim
    && binding.listingId === raw.listingId && binding.listingVersion === raw.version
    && binding.listingContentHash === raw.contentHash ? binding : undefined;
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
  // RB-3/RB-6: refuse inconsistent discovery rather than erase evidence
  // and let a downstream reader interpret it as clean revocation absence.
  if (raw.status === 'active' && (raw.revocation !== undefined || raw.revocationBinding !== undefined)) {
    throw new OutboundError('invalid', 'active-record-has-binding');
  }
  const pricing = raw.pricing ?? {};
  return {
    verified: false,
    listingId: raw.listingId,
    version: raw.version,
    contentHash: raw.contentHash,
    anchor: { kind: 'storage-program', locator: raw.anchor.locator },
    seller: { primaryClaim: raw.seller.primaryClaim, displayName: str(raw.seller.displayName, 200) },
    title: str(raw.offering?.title, 200) ?? '',
    description: str(raw.offering?.description, 2000),
    category: str(raw.offering?.category, 64),
    tags: Array.isArray(raw.offering?.tags) ? raw.offering.tags.filter((t) => typeof t === 'string').slice(0, 16).map((t) => t.slice(0, 32)) : [],
    rails: Array.isArray(raw.offering?.rails) ? raw.offering.rails.filter((t) => typeof t === 'string' && t.length <= 256).slice(0, 8) : [],
    pricingHint: {
      kind: ['fixed', 'negotiable', 'auction', 'metered'].includes(pricing.kind) ? pricing.kind : undefined,
      priceHint: str(pricing.priceHint, 64),
      currency: str(pricing.currency, 16),
      unit: str(pricing.unit, 32),
    },
    publicEndpoint: str(raw.publicEndpoint, 512),
    artifactProfile: ['dacs-v0.1', 'legacy-sdk-v0.1', 'fixture-listing'].includes(raw.artifactProfile) ? raw.artifactProfile : undefined,
    status: raw.status,
    revocationBinding: summaryRevocation(raw),
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

  // The pinned search route includes active listings only. The seller route
  // retains revoked summaries too; exact lookup must use that route.
  async function findSummary({ listingId, version, seller }) {
    if (!LISTING_ID.test(listingId) || !Number.isSafeInteger(version) || version < 1 || !CLAIM.test(seller)) {
      throw new OutboundError('invalid', 'listing coordinates are malformed');
    }
    let body;
    try {
      body = await get(`/api/dacs/sellers/${encodeURIComponent(seller)}`);
    } catch (error) {
      if (error instanceof OutboundError && error.kind === 'not-found') return null;
      throw error;
    }
    if (!body || !Array.isArray(body.listings) || body.listings.length > 200) throw new OutboundError('invalid', 'directory seller listings response is malformed or exceeds 200 records');
    const matches = body.listings.map(projectSummary).filter(l => l && l.listingId === listingId && l.version === version && l.seller.primaryClaim === seller);
    if (matches.length > 1) throw new OutboundError('invalid', 'directory listing coordinates are ambiguous');
    return matches[0] ?? null;
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

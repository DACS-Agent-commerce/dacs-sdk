// Portal-side check of a seller session delegation before the wallet signs it.
// The server builds the delegation message; the portal refuses to forward it
// to the wallet unless every field matches the purchase terms the portal
// already shows, and the expiry is within fixed bounds. Pure and DOM-free so
// it can be unit tested in Node. See docs/SELLER-SESSION-DELEGATION.md.

import { assertSellerSessionLifetime, SELLER_SESSION_MAX_LIFETIME_MS } from '../../dacs/seller-session-limits.mjs';

export const SELLER_SESSION_DELEGATION_PREFIX = 'dacs-chatgpt-plugin:seller-session-delegation:v1:';
export const SELLER_SESSION_DELEGATION_BOUNDS = Object.freeze({
  // Longest delegation the portal will sign (notBefore to expiresAt).
  maxLifetimeMs: SELLER_SESSION_MAX_LIFETIME_MS,
  // How far notBefore may lie ahead of this browser's clock.
  maxFutureSkewMs: 5 * 60 * 1000,
});

const FIELDS = ['buyer', 'expiresAt', 'jobId', 'kind', 'listingPin', 'notBefore', 'seller', 'sessionPublicKey', 'version'];
const PIN_FIELDS = ['contentHash', 'listingId', 'version'];
const HEX64 = /^[0-9a-f]{64}$/;
const CLAIM = /^did:demos:agent:[0-9a-f]{64}$/;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value, keys) => plain(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys);
const uint = (value) => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);

// Canonical JSON for this payload shape only (strings, safe integers and plain
// objects): keys sorted, no whitespace. It equals the SDK's JCS output here.
function canonical(value) {
  if (typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))) return JSON.stringify(value);
  if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  throw new Error('the delegation contains a value the portal does not sign');
}

class DelegationRefused extends Error {
  constructor(reason) { super(`refusing to sign the seller session delegation: ${reason}`); this.name = 'DelegationRefused'; this.code = 'delegation_refused'; }
}

// terms: the purchase view's terms ({ buyer: { wallet }, seller: { claim },
// listing: { listingId, version, contentHash }, protocol: { jobId } }).
// Returns a readable summary; throws DelegationRefused on any mismatch.
export function checkSellerSessionDelegation(request, terms, { now = Date.now() } = {}) {
  const refuse = (reason) => { throw new DelegationRefused(reason); };
  const message = request?.message;
  if (typeof message !== 'string' || !message.startsWith(SELLER_SESSION_DELEGATION_PREFIX)) refuse('the message is not a v1 seller session delegation');
  const body = message.slice(SELLER_SESSION_DELEGATION_PREFIX.length);
  let payload;
  try { payload = JSON.parse(body); } catch { refuse('the message is not valid JSON'); }
  if (!exactKeys(payload, FIELDS) || !exactKeys(payload.listingPin, PIN_FIELDS)) refuse('the delegation has missing or extra fields');
  let bytes;
  try { bytes = canonical(payload); } catch { refuse('the delegation contains a value of the wrong type'); }
  if (bytes !== body) refuse('the message is not in canonical form');
  if (request.payload !== undefined) {
    let shown;
    try { shown = canonical(request.payload); } catch { shown = null; }
    if (shown !== body) refuse('the message differs from the delegation the server described');
  }
  if (payload.version !== '1' || payload.kind !== 'seller-session-delegation') refuse('unsupported delegation version or kind');
  const wallet = String(terms?.buyer?.wallet ?? '').trim().replace(/^0x/i, '').toLowerCase();
  if (!HEX64.test(wallet) || payload.buyer !== `did:demos:agent:${wallet}`) refuse('the buyer is not this purchase wallet');
  if (!CLAIM.test(payload.seller) || payload.seller !== terms?.seller?.claim) refuse('the seller differs from this purchase');
  const listing = terms?.listing ?? {};
  if (payload.listingPin.listingId !== listing.listingId || payload.listingPin.version !== listing.version || payload.listingPin.contentHash !== listing.contentHash) refuse('the Listing differs from this purchase');
  if (typeof payload.jobId !== 'string' || payload.jobId !== terms?.protocol?.jobId) refuse('the job differs from this purchase');
  const session = payload.sessionPublicKey;
  if (typeof session !== 'string' || !HEX64.test(session) || `did:demos:agent:${session}` === payload.buyer || `did:demos:agent:${session}` === payload.seller) refuse('the session key is malformed or reuses a party key');
  if (!uint(payload.notBefore) || !uint(payload.expiresAt) || payload.expiresAt <= payload.notBefore) refuse('the validity window is malformed');
  if (!uint(now)) refuse('this browser clock is unavailable');
  if (payload.notBefore > now + SELLER_SESSION_DELEGATION_BOUNDS.maxFutureSkewMs) refuse('the delegation starts in the future');
  if (payload.expiresAt <= now) refuse('the delegation has already expired');
  try { assertSellerSessionLifetime(payload.expiresAt - payload.notBefore); } catch { refuse('the delegation lasts longer than 24 hours'); }
  return Object.freeze({
    seller: payload.seller,
    listing: `${payload.listingPin.listingId} v${payload.listingPin.version}`,
    listingHash: payload.listingPin.contentHash,
    jobId: payload.jobId,
    notBefore: new Date(payload.notBefore).toISOString(),
    expiresAt: new Date(payload.expiresAt).toISOString(),
  });
}

export function describeSellerSessionDelegation(summary) {
  return `Authorize this app to call seller ${summary.seller} for Listing ${summary.listing} (hash ${summary.listingHash}) and job ${summary.jobId} only, until ${summary.expiresAt}. No funds move; it cannot sign the Agreement or a payment.`;
}

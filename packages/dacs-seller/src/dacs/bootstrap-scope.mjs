// The seller's request-local bootstrap scope. Before the wire opens a signed request, the host checks the buyer's own
// signature on it and, when that holds for this seller and Listing, relates the buyer to the job for the rest of that
// request only. The authority reader reads the scope; it grants no admission, nonce, hold or effect authority, writes
// nothing, and ends with its request.
import { AsyncLocalStorage } from 'node:async_hooks';
import { canonicalize } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_DOMAINS, DACS_SELLER_HTTP_LIMITS, WireError, admitWireJson, isWirePayload, wireEnvelopeSigningBytes } from '@kynesyslabs/dacs/wire';
import { addressForClaim, verifyDemosSignature } from './demos-claims.mjs';

const BASE64URL = /^[A-Za-z0-9_-]+$/;
// A job whose retained context admission row is in one of these states opens no new scope; a request already in flight keeps its own.
const REVOKED_STATES = Object.freeze(['compensating', 'aborted']);
// What a request that registered no scope ends.
const NO_SCOPE = Object.freeze({ end() {} });

// The envelope a header carries, decoded as the wire decodes it, or null when it cannot be read.
function readEnvelope(header) {
  if (typeof header !== 'string' || header.length > DACS_SELLER_HTTP_LIMITS.maxHeaderLength || !BASE64URL.test(header)) return null;
  const bytes = Buffer.from(header, 'base64url');
  if (bytes.toString('base64url') !== header) return null;
  try { return admitWireJson(bytes, DACS_SELLER_HTTP_LIMITS.maxHeaderLength, 'wire_json_rejected', 401); } catch { return null; }
}

// The wallet address of a canonical claim, or null for any other spelling (the wire canonicalises those itself).
function addressOf(claim) {
  try { return addressForClaim(claim); } catch { return null; }
}

// The `{jobId, buyer, seller, listingPin}` the buyer signed: a delegation's payload, signed by the buyer wallet over the
// delegation domain and its canonical bytes, or a direct request's payload, signed over the wire's envelope bytes. Null for
// a payload that cannot be read this way. Throws the wire's own signature refusal (401) when the signature does not verify.
function signedScope(envelope) {
  if (Object.hasOwn(envelope, 'delegation')) {
    const { payload, signature } = envelope.delegation ?? {};
    const address = addressOf(payload?.buyer);
    if (address === null) return null;
    const message = `${DACS_SELLER_HTTP_DOMAINS.delegation}${canonicalize(payload)}`;
    if (!verifyDemosSignature({ address, message, signature })) throw new WireError('peer_delegation_signature_invalid', 401);
    return payload;
  }
  const { payload, signature } = envelope;
  const address = isWirePayload(payload, 'request') ? addressOf(payload.buyer) : null;
  if (address === null) return null;
  const message = wireEnvelopeSigningBytes(payload).toString('utf8');
  if (!verifyDemosSignature({ address, message, signature })) throw new WireError('peer_signature_invalid', 401);
  return payload;
}

/**
 * Returns `{enter(header), current(jobId)}`, the bootstrap scopes of one seller (`sellerClaim`) and its current Listing
 * (`listingPin`), at most `maxConcurrent` live at once. `retainedJob(jobId)` reads the job's retained context admission row, or null.
 * - `enter(header)`, called once per request before any wire call, reads the request's envelope header within the wire's
 *   header limit and verifies the buyer's signature: a delegation's by the buyer wallet, a direct request's by the buyer. When
 *   the signed payload names this seller and Listing, and the job's retained row is not `compensating` or `aborted`, it registers
 *   `{jobId, buyer, seller, listingPin}` for the calling request and returns its handle; `handle.end()` (idempotent) ends it. A
 *   header it cannot read, another seller or Listing, a claim spelling that is not canonical, such a row, or a full set registers
 *   nothing and returns a handle whose `end()` does nothing; the wire then refuses the request with its own code. Throws WireError
 *   `peer_delegation_signature_invalid` or `peer_signature_invalid` (401) when the signature does not verify, before any authority read.
 * - `current(jobId)` returns the calling request's scope while its handle is live and names that job; else null, also for
 *   work that outlives its request.
 * Throws TypeError for a missing seller claim, Listing pin, `retainedJob` function or positive integer `maxConcurrent`.
 */
export function createBootstrapScopes({ sellerClaim, listingPin, retainedJob, maxConcurrent }) {
  if (typeof sellerClaim !== 'string' || listingPin === null || typeof listingPin !== 'object') throw new TypeError('bootstrap scopes need the seller claim and its Listing pin');
  if (typeof retainedJob !== 'function') throw new TypeError('retainedJob is required as a function');
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new TypeError('maxConcurrent must be a positive integer');
  const pinText = canonicalize(listingPin);
  const requests = new AsyncLocalStorage();
  const live = new Set();
  return Object.freeze({
    enter(header) {
      const envelope = readEnvelope(header);
      const signed = envelope === null ? null : signedScope(envelope);
      if (signed === null || signed.seller !== sellerClaim || canonicalize(signed.listingPin ?? null) !== pinText || live.size >= maxConcurrent
        || REVOKED_STATES.includes(retainedJob(signed.jobId)?.state)) return NO_SCOPE;
      const handle = Object.freeze({ scope: Object.freeze({ jobId: signed.jobId, buyer: signed.buyer, seller: signed.seller, listingPin }), end: () => { live.delete(handle); } });
      live.add(handle);
      requests.enterWith(handle);
      return handle;
    },
    current(jobId) {
      const handle = requests.getStore();
      return handle !== undefined && live.has(handle) && handle.scope.jobId === jobId ? handle.scope : null;
    },
  });
}

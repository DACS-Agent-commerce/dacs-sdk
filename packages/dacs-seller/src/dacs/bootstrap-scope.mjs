// The seller's request-local bootstrap scope: a buyer whose own signature the host checked is related to the job for that
// request only. It grants no admission, nonce, hold or effect authority, and writes nothing.
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

// A claim as the wire reads it: a `DID:` scheme in any letter case resolves as `did:`; any other value comes back unchanged.
const RECEIVED_CLAIM = /^[dD][iI][dD]:demos:agent:[0-9a-f]{64}$/;
const canonicalClaim = (value) => (typeof value === 'string' && RECEIVED_CLAIM.test(value) ? `did${value.slice(3)}` : value);

// A copy of a received payload with its buyer and seller claims in canonical spelling. The shape check, the signature and the
// scope all read this copy, as the wire's own checks do, never the received spelling.
function withCanonicalClaims(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const copy = { ...payload };
  for (const field of ['buyer', 'seller']) if (Object.hasOwn(copy, field)) copy[field] = canonicalClaim(copy[field]);
  return copy;
}

// The wallet address of a canonical claim, or null for any other value.
function addressOf(claim) {
  try { return addressForClaim(claim); } catch { return null; }
}

// The `{jobId, buyer, seller, listingPin}` the buyer signed: a delegation's payload, signed by the buyer wallet over the
// delegation domain and its canonical bytes, or a direct request's payload, signed over the wire's envelope bytes; in both the
// canonical copy of the claims. Null for a payload that cannot be read this way. Throws the wire's own signature refusal (401)
// when the signature does not verify.
function signedScope(envelope) {
  if (Object.hasOwn(envelope, 'delegation')) {
    const { payload: received, signature } = envelope.delegation ?? {};
    const payload = withCanonicalClaims(received);
    const address = addressOf(payload?.buyer);
    if (address === null) return null;
    const message = `${DACS_SELLER_HTTP_DOMAINS.delegation}${canonicalize(payload)}`;
    if (!verifyDemosSignature({ address, message, signature })) throw new WireError('peer_delegation_signature_invalid', 401);
    return payload;
  }
  const payload = withCanonicalClaims(envelope.payload);
  const address = isWirePayload(payload, 'request') ? addressOf(payload.buyer) : null;
  if (address === null) return null;
  const message = wireEnvelopeSigningBytes(payload).toString('utf8');
  if (!verifyDemosSignature({ address, message, signature: envelope.signature })) throw new WireError('peer_signature_invalid', 401);
  return payload;
}

/**
 * Returns `{enter(header), current(jobId)}`: the bootstrap scopes of one seller and Listing, at most `maxConcurrent` live.
 * `enter(header)`, called once per request before any wire call, reads the envelope header within the wire's limit and
 * verifies the buyer's signature (the buyer wallet's on a delegation, else the buyer's on the request). When the signed payload
 * names this seller and Listing and the job's row (`retainedJob(jobId)`) is not `compensating` or `aborted`, it registers
 * `{jobId, buyer, seller, listingPin}` for the calling request and returns a handle whose `end()` ends it. Anything else registers
 * nothing, and the wire refuses the request with its own code. Throws WireError `peer_delegation_signature_invalid` or
 * `peer_signature_invalid` (401) when the signature does not verify. `current(jobId)` returns the calling request's live scope
 * for that job, else null, also for work that outlives its request. Throws TypeError for a missing or malformed input.
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

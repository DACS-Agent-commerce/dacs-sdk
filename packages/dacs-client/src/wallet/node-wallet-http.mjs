// One bounded JSON-RPC read over a node transport owner, for readers outside this package that need a node method the
// read-only authority capability does not send. It reaches only the owner's own endpoint.
import { fetchBoundedJson } from '../util/http.mjs';

/**
 * Posts `body` as JSON to the endpoint of `owner` (a `createNodeTransportOwner` owner) through the owner's own fetch, which
 * refuses other origins and redirects, and resolves the decoded reply. Options: `maxBytes` (the reply's byte limit before
 * decoding), `timeoutMs` and an optional caller `signal`. The reply passes raw JSON admission, which refuses duplicate member
 * names. Rejects with the bounded fetch's `OutboundError` (`kind` `timeout`, `invalid`, `not-found` or `unavailable`), the
 * caller's abort reason unchanged, the owner's `transport_closed` when called after it is closed, or TypeError for anything that
 * is not a transport owner.
 */
export async function fetchBoundedNodeJson(owner, body, { maxBytes, timeoutMs, signal } = {}) {
  if (typeof owner?.currentLocal !== 'function' || typeof owner.fetchImpl !== 'function') throw new TypeError('a node transport owner is required');
  const { endpoint } = owner.currentLocal();
  return fetchBoundedJson(endpoint, { method: 'POST', body, fetchImpl: (...args) => owner.fetchImpl(...args), timeoutMs, maxBytes, signal,
    expectedOrigin: new URL(endpoint).origin });
}

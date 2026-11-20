// The node's own chain-identity read, for the network binder's stabilised-genesis policy. It sends one
// `getChainIdentity` call and returns the binder's read receipt. The binder checks the answer; nothing here
// trusts it, caches it or reads another node.
import { NetworkBindingError } from '../dacs/network-binding.mjs';

/**
 * Returns `getChainIdentity(policy)` for a binder reader. `context()` returns the active transport context and
 * `post(body, headers, { signal })` one bounded node reply, so the byte limit and the deadline are the caller's.
 * The returned function resolves `{ value, context, observedAt, fromCache: false, redirected: false }` and rejects
 * with the reader's or post's own error, the caller's abort reason, or NetworkBindingError `invalid_policy` for a
 * policy other than no-store with redirects refused.
 */
export function chainIdentityRead({ context, post, signal, now }) {
  return async function getChainIdentity(policy) {
    if (policy.cache !== 'no-store' || policy.redirect !== 'error') throw new NetworkBindingError('invalid_policy', 'A fresh bounded identity observation is required');
    signal?.throwIfAborted();
    const readContext = await context();
    const answer = await post({ method: 'nodeCall', params: [{ message: 'getChainIdentity', data: {} }] }, {}, { signal });
    return { value: answer, context: readContext, observedAt: now(), fromCache: false, redirected: false };
  };
}

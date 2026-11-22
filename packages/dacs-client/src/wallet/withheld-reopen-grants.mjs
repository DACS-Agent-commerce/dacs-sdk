// One-use capabilities for the explicit reopen of a withheld native broadcast. Internal: not exported by the
// package. The trusted composition holds `register`; the transport is given only `consume`.
import { passContext } from './pass-context.mjs';

const HASH = /^[0-9a-f]{64}$/;
const MAX_OPERATION_ID_BYTES = 128;
const refusal = (code, message) => Object.assign(new Error(message), { code });

/**
 * A registry of one-use reopen capabilities. `register({ operationId, lane, hash, operationClass, currentAuthorization })`
 * names the retained operation, wallet lane and exact transaction hash, and returns an opaque frozen capability.
 * Holding one proves it was registered, not that the reopen is still authorized. `operationClass` and
 * `currentAuthorization` are the job owner's private pass context (see `passContext`): they stay inside the registry and
 * reach the transport's final transmit check. It throws `reopen_scope_invalid` for a malformed scope.
 * `consume(capability)` removes the capability before anything else can fail and returns `{ operationId, lane, hash,
 * privateContext }`; it throws `reopen_capability_invalid` for an unknown, forged or used one.
 */
export function createReopenGrants() {
  const live = new WeakMap();
  return Object.freeze({
    register({ operationId, lane, hash, operationClass = null, currentAuthorization } = {}) {
      const named = typeof operationId === 'string' && operationId !== '' && Buffer.byteLength(operationId) <= MAX_OPERATION_ID_BYTES && typeof lane === 'string' && lane !== '' && HASH.test(hash);
      if (!named || (currentAuthorization !== undefined && typeof currentAuthorization !== 'function')) throw refusal('reopen_scope_invalid', 'a reopen capability names an operation id, a wallet lane and a transaction hash');
      let privateContext;
      try { privateContext = passContext({ operationClass, operationId, currentAuthorization }); } catch (cause) { throw Object.assign(refusal('reopen_scope_invalid', 'the pass class of a reopen capability is unknown'), { cause }); }
      const capability = Object.freeze({});
      live.set(capability, Object.freeze({ operationId, lane, hash, privateContext }));
      return capability;
    },
    consume(capability) {
      const scope = live.get(capability);
      if (scope === undefined) throw refusal('reopen_capability_invalid', 'the reopen capability is unknown or already used');
      live.delete(capability);
      return scope;
    },
  });
}

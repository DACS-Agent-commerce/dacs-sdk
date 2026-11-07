// A non-reentrant, single-holder transport owner in the old operator's queued mode.
// It counts fence acquisitions, lets a test hold the fence, and can swap in a new
// connection to model a replacement. Tests only.
import { createNodeTransportOwner } from '../../src/wallet/node-wallet-session.mjs';

export const OWNER_ENDPOINT = 'https://rpc.example.invalid/';
export const OWNER_AUTHORITY = 'vector-authority';

/** Returns the owner's own members plus acquisitions(), held(), queued() (resolves once an acquirer waits) and replaceConnection(). */
export function queuedOwner({ fetchImpl }) {
  const open = () => createNodeTransportOwner({ endpoint: OWNER_ENDPOINT, transportAuthority: OWNER_AUTHORITY, fetchImpl });
  let inner = open(), acquisitions = 0, waiting = 0;
  const live = new Set(), watchers = [];
  return {
    get local() { return inner.local; },
    currentLocal: () => inner.currentLocal(),
    getContext: () => inner.getContext(),
    fetchImpl: (...args) => inner.fetchImpl(...args),
    async acquireConnectionFence(...args) {
      acquisitions += 1; waiting += 1;
      for (const wake of watchers.splice(0)) wake();
      const lease = await inner.acquireConnectionFence(...args);
      waiting -= 1; live.add(lease);
      return Object.freeze({ context: lease.context, release() { live.delete(lease); lease.release(); } });
    },
    acquisitions: () => acquisitions,
    held: () => live.size > 0,
    queued: () => (waiting > 0 ? Promise.resolve() : new Promise(resolve => watchers.push(resolve))),
    replaceConnection() { inner = open(); },
    close: () => inner.close(),
  };
}

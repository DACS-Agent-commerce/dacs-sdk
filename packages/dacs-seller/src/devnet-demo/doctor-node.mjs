// The seller doctor's read-only node connection and exact balance read. It opens no wallet, key, journal, lock or file, signs
// nothing, and its imports reach no SQLite module.
import { TP1_APPROVED_IDENTITY_RECORD, canonicalNodeEndpoint } from '@kynesyslabs/dacs/wire';
import { createNodeObserver, createNodeTransportOwner, readNodeAddressBalance } from '@kynesyslabs/dacs-client/node-wallet';
import { SELLER_TRANSPORT_AUTHORITY, createConnectionAuthorityReader } from './connection-authority.mjs';

// The chain identity the doctor's connection is pinned to; binding checks the live node against it.
const CHAIN_IDENTITY = TP1_APPROVED_IDENTITY_RECORD.chainIdentity;

/**
 * Opens the doctor's one read-only connection to `rpcUrl` and returns the frozen `{ owner, readAuthority, observer, close() }`.
 * `rpcUrl` must be a canonical node root: https, or plain http only under the approved TP-1 chain identity, which binding then
 * checks against the live node. `owner` is the client's transport owner with the fixed SELLER_TRANSPORT_AUTHORITY; `readAuthority`
 * is the production connection reader over it, for `bindTp1Profile` with `owner.currentLocal()`; `observer` is the client's
 * read-only observer of the same owner. `close()` closes the owner, once; every read after it refuses transport_closed. It gives
 * no qualification source. Throws TypeError for an empty `sellerClaim`, a `fetchImpl` that is not a function or an `rpcUrl` that
 * is not such a root, each before a connection opens; a later construction failure closes the owner and is rethrown.
 */
export function openDoctorNode({ rpcUrl, sellerClaim, fetchImpl = globalThis.fetch }) {
  if (typeof sellerClaim !== 'string' || sellerClaim === '') throw new TypeError('sellerClaim must be a nonempty string');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const endpoint = canonicalNodeEndpoint(rpcUrl, { chainIdentity: CHAIN_IDENTITY });
  if (endpoint === null) throw new TypeError('rpcUrl must be a canonical node root URL: https, or http for the approved TP-1 testnet');
  const owner = createNodeTransportOwner({ endpoint, transportAuthority: SELLER_TRANSPORT_AUTHORITY, fetchImpl, chainIdentity: CHAIN_IDENTITY });
  try {
    const { connectionAuthority } = createConnectionAuthorityReader({ owner, claim: () => sellerClaim });
    const nodeObserver = createNodeObserver({ owner });
    const observer = Object.freeze({
      provenance: nodeObserver.provenance,
      observe: async (options) => { owner.currentLocal(); return nodeObserver.observe(options); },
      readNodeInfo: async (message, options) => { owner.currentLocal(); return nodeObserver.readNodeInfo(message, options); },
    });
    return Object.freeze({ owner, readAuthority: connectionAuthority, observer, close: () => owner.close() });
  } catch (error) {
    owner.close();
    throw error;
  }
}

/**
 * Resolves `{ address, balanceOs }` over the doctor's `owner`: the normalized address and its exact balance as a canonical decimal
 * OS string. Rejects as the client's readNodeAddressBalance does (seller_balance_*, transport_closed, the caller's abort reason).
 */
export function readSellerBalance({ owner, address, signal }) {
  return readNodeAddressBalance({ owner, address, signal });
}

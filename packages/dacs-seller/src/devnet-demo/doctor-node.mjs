// The seller doctor's read-only node connection and balance read: no wallet, key, journal, lock, file, signature or SQLite import.
import { TP1_APPROVED_IDENTITY_RECORD, canonicalNodeEndpoint } from '@kynesyslabs/dacs/wire';
import { createNodeObserver, createNodeTransportOwner, readNodeAddressBalance } from '@kynesyslabs/dacs-client/node-wallet';
import { SELLER_TRANSPORT_AUTHORITY, createConnectionAuthorityReader } from './connection-authority.mjs';

// The pinned chain identity; binding checks the live node against it.
const CHAIN_IDENTITY = TP1_APPROVED_IDENTITY_RECORD.chainIdentity;

/**
 * Opens one read-only connection to `rpcUrl` (a canonical https root, or http only under the approved TP-1 chain identity) and returns
 * frozen `{ owner, readAuthority, observer, close() }`: the client's owner with SELLER_TRANSPORT_AUTHORITY, the production connection
 * reader (for `bindTp1Profile` with `owner.currentLocal()`) and observer over it; after `close()` every read refuses transport_closed.
 * Throws TypeError for an empty `sellerClaim`, a non-function `fetchImpl` or another `rpcUrl`, before any connection; a later
 * construction failure closes the owner and is rethrown. It gives no qualification source.
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

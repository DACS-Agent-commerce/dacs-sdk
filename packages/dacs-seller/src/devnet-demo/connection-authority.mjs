// The one read-only connection pair the wallet-session port and the doctor both build. It imports no wallet, journal or SQLite module.
import { TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { createAuthorityReader } from '@kynesyslabs/dacs-client';
import { createNodeAuthorityCapability } from '@kynesyslabs/dacs-client/node-wallet';

/** The seller's fixed transport authority: a local name for its one node connection, never taken from a URL or a node's answer. */
export const SELLER_TRANSPORT_AUTHORITY = 'dacs-seller-tp1-node';

/**
 * Returns frozen `{ authority, connectionAuthority }` over `owner`: the client's read-only authority capability (`claim` its claim reader)
 * and the client's authority reader over it, with no Listing, purchase or participant source, so it decides the connection scope only.
 * Neither takes a fence, signs or opens a file. Throws the client's TypeError for an owner it refuses or a non-function `claim`.
 */
export function createConnectionAuthorityReader({ owner, claim }) {
  const authority = createNodeAuthorityCapability({ owner, claim });
  const connectionAuthority = createAuthorityReader({ authority, identityRecord: TP1_APPROVED_IDENTITY_RECORD, claim: authority.claim,
    listings: { isRegistered: () => false }, purchases: { findByJobId: () => null }, participantImplementations: { entriesFor: () => [] } });
  return Object.freeze({ authority, connectionAuthority });
}

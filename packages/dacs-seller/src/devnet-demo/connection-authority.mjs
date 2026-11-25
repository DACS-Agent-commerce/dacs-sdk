// The one read-only connection pair the wallet-session port and the doctor both build. It imports no wallet, journal or SQLite module.
import { TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { createAuthorityReader } from '@kynesyslabs/dacs-client';
import { createNodeAuthorityCapability } from '@kynesyslabs/dacs-client/node-wallet';

/** The seller's fixed transport authority: a local name for its one node connection, never taken from a URL or a node's answer. */
export const SELLER_TRANSPORT_AUTHORITY = 'dacs-seller-tp1-node';

/**
 * Returns the frozen `{ authority, connectionAuthority }` pair over `owner`: the client's read-only authority capability, with
 * `claim` as its claim reader, and the client's authority reader over it. The reader decides the connection scope only: it has no
 * Listing, purchase or participant source, so a job or discovery scope gets no participants. Neither member takes a connection
 * fence, signs or opens a file. Throws the client's TypeError for an owner its observer refuses or a `claim` that is not a function.
 */
export function createConnectionAuthorityReader({ owner, claim }) {
  const authority = createNodeAuthorityCapability({ owner, claim });
  const connectionAuthority = createAuthorityReader({ authority, identityRecord: TP1_APPROVED_IDENTITY_RECORD, claim: authority.claim,
    listings: { isRegistered: () => false }, purchases: { findByJobId: () => null }, participantImplementations: { entriesFor: () => [] } });
  return Object.freeze({ authority, connectionAuthority });
}

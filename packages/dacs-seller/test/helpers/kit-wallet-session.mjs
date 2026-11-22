// Unshipped test helper: the seller host's `walletSession` port, built from the client's real stage-one parts (its
// transport owner over a scripted TP-1 node, its read-only authority capability and its production authority reader),
// and enrollment sources for `participantImplementations`. The node, the enrollment and the finalization step are the
// test's: the kit's own Node wallet session is not built here.
import { addressForClaim } from '../../src/dacs/demos-claims.mjs';
import { TESTNET_PROFILE_TP1, TP1_APPROVED_IDENTITY_RECORD, TP1_BASE_REVISION, TP1_PROFILE_ID, TP1_PROFILE_REVISION } from '@kynesyslabs/dacs/wire';
import { createAuthorityReader } from '../../../dacs-client/src/wallet/authority-reader.mjs';
import { createNodeAuthorityCapability, createNodeTransportOwner } from '../../../dacs-client/src/wallet/node-wallet-session.mjs';
import { buyer } from './protocol-fixture.mjs';

export const NODE_ENDPOINT = 'https://rpc.example.invalid/';
const NODE_AUTHORITY = 'vector-authority';
const CHAIN = TP1_APPROVED_IDENTITY_RECORD.chainIdentity;
/** The TP-1 profile every enrolled party declares. */
export const TP1_PROFILE = Object.freeze({ id: TP1_PROFILE_ID, revision: TP1_PROFILE_REVISION, base: TP1_BASE_REVISION, chainIdentity: CHAIN, pinVersion: TP1_APPROVED_IDENTITY_RECORD.pinVersion });

export const jsonResponse = (text) => new Response(text, { headers: { 'content-type': 'application/json' } });
const nodeAnswer = (response) => jsonResponse(JSON.stringify({ result: 200, response, require_reply: false, extra: null }));

/** A scripted TP-1 node: it answers the identity reads, lists each read's message in `calls`, and lets `intercept({ init, call })` answer instead. */
export function scriptedNode() {
  const node = { calls: [], intercept: null };
  node.fetch = async (_url, init) => {
    const call = JSON.parse(init.body).params[0];
    node.calls.push(call.message);
    const intercepted = await node.intercept?.({ init, call });
    if (intercepted) return intercepted;
    if (call.message !== 'getBlockByNumber') throw new Error(`TEST-unscripted-node-read:${call.message}`);
    return nodeAnswer(call.data.blockNumber === 0 ? { number: 0, status: 'confirmed', hash: CHAIN, content: {} }
      : { number: call.data.blockNumber, status: 'confirmed', hash: 'b'.repeat(64), content: { previousHash: CHAIN } });
  };
  return node;
}

/** One current enrollment of `claim` on the TP-1 profile and tuple; `patch` replaces members. */
export const enrolled = (claim, patch = {}) => ({ claim, profile: { ...TP1_PROFILE }, modules: { ...TESTNET_PROFILE_TP1.tuple }, evidence: 'TEST-enrollment-record', revoked: false, ...patch });

/**
 * A `participantImplementations` source that enrolls each of `claims` once (the protocol fixture's buyer by default). `entries` is
 * the map it reads on every call, so a test can change or remove an enrollment; `reads` counts the lookups.
 */
export function enrollment(claims = [buyer.claim]) {
  const source = { entries: new Map(claims.map((claim) => [claim, [enrolled(claim)]])), reads: 0 };
  source.entriesFor = (claim) => { source.reads++; return source.entries.get(claim) ?? []; };
  return source;
}

/**
 * The host's `walletSession` port over a fresh client transport owner on `node`. Returns `{ walletSession, owner, events }`: `owner`
 * counts its fence acquisitions (`acquisitions`), and `events` lists the port's `finalize` and `close` calls in order. `finalize(input)`
 * replaces the default finalization, which records its input and resolves a session whose `close()` is recorded. The port's `close()`
 * is recorded and leaves the owner open, so a test may start a host on the same options again.
 */
export function testWalletSession({ node = scriptedNode(), finalize = null } = {}) {
  const inner = createNodeTransportOwner({ endpoint: NODE_ENDPOINT, transportAuthority: NODE_AUTHORITY, fetchImpl: (url, init) => node.fetch(url, init) });
  const owner = { ...inner, acquisitions: 0, acquireConnectionFence: (...args) => { owner.acquisitions++; return inner.acquireConnectionFence(...args); } };
  const events = [];
  // The connection reader is only asked the connection scope, so its claim, Listing and purchase sources are never read.
  const authority = createNodeAuthorityCapability({ owner, claim: () => { throw new Error('TEST the connection reader reads no claim'); } });
  const connectionAuthority = createAuthorityReader({ authority, identityRecord: TP1_APPROVED_IDENTITY_RECORD, claim: authority.claim, listings: { isRegistered: () => false },
    purchases: { findByJobId: () => null }, participantImplementations: { entriesFor: () => [] } });
  const finalizeSession = finalize ?? (async (input) => ({ input, close: async () => { events.push('session-close'); } }));
  const walletSession = {
    authority, connectionAuthority,
    finalize: async (input) => { events.push({ finalize: input }); return finalizeSession(input); },
    close: () => { events.push('close'); },
  };
  return { walletSession, owner, events, node };
}

/** The two host options a test host needs: a fresh `walletSession` port and the enrollment of `claims` (the protocol fixture's buyer by default). */
export const hostAuthority = (claims) => ({ walletSession: testWalletSession().walletSession, participantImplementations: enrollment(claims) });

/** A saved purchase row of `buyerClaim`'s wallet for `jobId` from `sellerClaim`, as the client's reader reads it. */
export const purchaseRow = (jobId, buyerClaim, sellerClaim) => ({ terms: { buyer: { accountId: 'TEST-buyer', wallet: addressForClaim(buyerClaim) }, seller: { claim: sellerClaim }, protocol: { jobId } },
  state: { protocol: { stage: 'identity', listing: { seller: { identity: { presentedBy: sellerClaim } } }, attempts: [] } } });

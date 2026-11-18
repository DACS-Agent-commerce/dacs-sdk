// The client's production TP-1 authority reader. It reads only: the chain through the session's authority seam, and
// local evidence (the Listing registry, saved purchases and the enrollment source), each on every call. It takes no
// connection fence, journal lock or signer, and it keeps no state between calls.
import { createHash } from 'node:crypto';
import { canonicalize } from '@kynesyslabs/dacs';
import { DACS_SELLER_DISCOVERY_FORMAT, TESTNET_PROFILE_TP1, TP1_BASE_REVISION, TP1_PROFILE_ID, TP1_PROFILE_REVISION } from '@kynesyslabs/dacs/wire';
import { createDemosNetworkBinder, NetworkBindingError } from '../dacs/network-binding.mjs';
import { AUTHORITY_READ_DEADLINE_MS } from '../public-admission.mjs';
import { claimForAddress } from '../signatures.mjs';
import { DEVNET_NODE2_BLOCK_LAYOUT, DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE, sourceBlockReader, TP1_REVIEWED_BLOCK_TWO_HASH } from './devnet-native-transport.mjs';

const PROVENANCE_PREFIX = 'dacs-client-authority:';
// A node that answers another chain, disagrees with itself or is not the reviewed endpoint cannot be authenticated.
const UNAUTHENTICATED_CODES = ['identity_mismatch', 'conflicting_identity', 'transport_mismatch'];
const REQUIRED_MEMBERS = {
  authority: ['authorityRpc', 'context', 'connectionGeneration'],
  listings: ['isRegistered'],
  purchases: ['findByJobId'],
  participantImplementations: ['entriesFor'],
};

function requireInputs({ identityRecord, claim, ...sources } = {}) {
  for (const [name, members] of Object.entries(REQUIRED_MEMBERS)) {
    for (const member of members) if (typeof sources[name]?.[member] !== 'function') throw new TypeError(`${name}.${member} is required`);
  }
  if (['network', 'chainIdentity', 'pinVersion'].some(member => typeof identityRecord?.[member] !== 'string')) throw new TypeError('identityRecord is required');
  if (typeof claim !== 'function') throw new TypeError('claim is required as a function');
}

// The claim of a wallet address, or undefined when the address is malformed.
function claimOfWallet(wallet) {
  try { return claimForAddress(wallet); } catch { return undefined; }
}

// The actor's own profile, built from the record and the wire's constants as `bindTp1Profile` builds `binding.profile`.
const ownProfile = record => ({ id: TP1_PROFILE_ID, revision: TP1_PROFILE_REVISION, base: TP1_BASE_REVISION, chainIdentity: record.chainIdentity, pinVersion: record.pinVersion });

// The chain identity this connection answers with, or undefined when the connection cannot be authenticated.
// Any other failure (timeout, refusal, transport) is thrown with its original cause.
async function observeChainIdentity(authority, record) {
  const { endpoint, transportAuthority } = authority.context();
  const expected = { network: record.network, chainIdentity: record.chainIdentity, pinVersion: record.pinVersion, endpoint, transportAuthority };
  const documentation = record.provenance?.documentation;
  const fallback = typeof documentation === 'string' ? { blockZeroUnavailable: 'literal-error', documentation } : null;
  const now = () => Date.now();
  // The observation's own reads stop when it ends, so a read that outlives the observation's deadline is cancelled.
  const observation = new AbortController();
  // The node's replies are read under the native transport's reviewed Node2 policy: its four-field block-zero error,
  // its block-one layout and the reviewed block-two hash.
  const reader = sourceBlockReader({ chainIdentity: record.chainIdentity, reviewedReads: {}, fallback, blockZeroErrorEnvelope: DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE,
    blockOneLayout: DEVNET_NODE2_BLOCK_LAYOUT, reviewedBlockTwoHash: TP1_REVIEWED_BLOCK_TWO_HASH, strictEnvelope: false,
    signal: observation.signal, context: async () => authority.context(), post: (body, _headers, { signal }) => authority.authorityRpc(body, { signal }), now });
  try {
    return (await createDemosNetworkBinder({ expected, fallback, now, timeoutMs: AUTHORITY_READ_DEADLINE_MS, reader }).bind()).chainIdentity;
  } catch (error) {
    if (error instanceof NetworkBindingError && UNAUTHENTICATED_CODES.includes(error.code)) return undefined;
    throw error;
  } finally {
    observation.abort();
  }
}

/**
 * Returns the client's `Tp1AuthorityReader` for `bindTp1Profile` and every later wire check. All inputs are required:
 * - `authority`: the session's stage-one capability, `authorityRpc(body, {signal})`, `context()` and `connectionGeneration()`;
 * - `identityRecord`: the SDK-approved identity record;
 * - `claim()`: the session wallet's current claim, read synchronously;
 * - `listings.isRegistered(seller)`: true for a seller whose Listing this composition chain-verified and registered;
 * - `purchases.findByJobId(jobId)`: the saved purchase row for that job, or null. The reader reads `terms.protocol.jobId`,
 *   `terms.buyer.wallet` (an address) and `terms.seller.claim` from it, as the purchase service saves them;
 * - `participantImplementations.entriesFor(claim)`: the independently approved enrollment for a claim, as entries
 *   `{claim, profile, modules, evidence, revoked}`.
 * The reader needs no completed binding. Its answer is the connection decision with the participants asked for, in order:
 * the wallet's own claim with its own profile, and a counterparty only when local evidence relates it to the scope (a registered
 * Listing for discovery, the seller of the wallet's own saved purchase for a job) and exactly one current, unrevoked enrollment
 * names it. A job whose saved purchase has another buyer wallet, or none, answers no participants, the wallet's own claim
 * included. Anything else answers with no participants, which the wire refuses as a participant mismatch. A connection that cannot be authenticated
 * (another chain, a conflicting identity, another endpoint) answers nothing. A transport failure rejects with its original error.
 * Throws TypeError at construction when an input is missing.
 */
export function createAuthorityReader(inputs) {
  requireInputs(inputs);
  const { authority, identityRecord, claim, listings, purchases, participantImplementations } = inputs;

  // The registered sellers a discovery scope asks about, or null when any of them is not registered.
  async function registeredSellers(participants) {
    const registered = await Promise.all(participants.map(seller => listings.isRegistered(seller)));
    return registered.every(Boolean) ? participants : null;
  }

  // The seller of the saved purchase for `jobId`, only when that purchase is this wallet's own; else null.
  async function sellerOfOwnJob(jobId, own) {
    const terms = (await purchases.findByJobId(jobId))?.terms;
    if (terms?.protocol?.jobId !== jobId || claimOfWallet(terms.buyer?.wallet) !== own) return null;
    return typeof terms.seller?.claim === 'string' ? [terms.seller.claim] : null;
  }

  // The one current, unrevoked enrollment for a claim, as `{claim, profile, modules}`; else null.
  async function enrolledImplementation(peer) {
    const entries = await participantImplementations.entriesFor(peer);
    if (!Array.isArray(entries) || entries.length !== 1) return null;
    const [entry] = entries;
    if (entry?.claim !== peer || entry.revoked !== false || typeof entry.evidence !== 'string' || entry.evidence === '' || !entry.profile || !entry.modules) return null;
    return { claim: peer, profile: entry.profile, modules: entry.modules };
  }

  async function participantsFor(scope) {
    if (scope.sessionId === null) return [];
    const own = claim(), discovery = scope.sessionId === DACS_SELLER_DISCOVERY_FORMAT;
    const related = discovery ? await registeredSellers(scope.participants) : await sellerOfOwnJob(scope.sessionId, own);
    // A job that is not this wallet's answers no participants, the wallet's own claim included.
    if (related === null && !discovery) return [];
    const peers = related ?? [];
    const entries = await Promise.all(scope.participants.map(asked => {
      if (asked === own) return { claim: own, profile: ownProfile(identityRecord), modules: { ...TESTNET_PROFILE_TP1.tuple } };
      return peers.includes(asked) ? enrolledImplementation(asked) : null;
    }));
    return entries.includes(null) ? [] : entries;
  }

  return async function readAuthority(scope) {
    const { endpoint, transportAuthority, connectionId } = authority.context();
    const chainIdentity = await observeChainIdentity(authority, identityRecord);
    if (chainIdentity === undefined) return undefined;
    const provenance = PROVENANCE_PREFIX + createHash('sha256').update(canonicalize({ transportAuthority, connectionId, connectionGeneration: authority.connectionGeneration() })).digest('hex');
    return { local: { endpoint, transportAuthority, connectionId }, chainIdentity, provenance, sessionId: scope.sessionId, participants: await participantsFor(scope) };
  };
}

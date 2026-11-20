// The seller kit's production TP-1 authority reader, the wire's `readAuthority`. It reads its sources on every call, takes no
// fence, lock or signer, and keeps no state between calls.
import { canonicalize } from '@kynesyslabs/dacs';
import { DACS_SELLER_DISCOVERY_FORMAT, TESTNET_PROFILE_TP1, TP1_BASE_REVISION, TP1_PROFILE_ID, TP1_PROFILE_REVISION } from '@kynesyslabs/dacs/wire';

// A retained context admission row in one of these states relates its buyer to its job on its own.
const GRANTING_STATES = Object.freeze(['intent', 'admitted', 'running']);

function requireInputs({ connectionAuthority, identityRecord, claim, listingPin, bootstrap, retainedJob, participantImplementations }) {
  if (typeof connectionAuthority !== 'function') throw new TypeError('connectionAuthority is required as a function');
  if (['chainIdentity', 'pinVersion'].some((member) => typeof identityRecord?.[member] !== 'string')) throw new TypeError('identityRecord is required');
  if (typeof claim !== 'string') throw new TypeError('claim is required as a string');
  if (listingPin === null || typeof listingPin !== 'object') throw new TypeError('listingPin is required');
  if (typeof bootstrap?.current !== 'function') throw new TypeError('bootstrap.current is required');
  if (typeof retainedJob !== 'function') throw new TypeError('retainedJob is required as a function');
  if (typeof participantImplementations?.entriesFor !== 'function') throw new TypeError('participantImplementations.entriesFor is required');
}

/**
 * Returns the seller's `Tp1AuthorityReader` for `bindTp1Profile` and every later wire check. Inputs, all required:
 * `connectionAuthority(scope)` (the session's connection reader, asked only the connection scope), the SDK-approved
 * `identityRecord`, the seller's `claim` and current `listingPin`, `bootstrap.current(jobId)` (the calling request's scope or
 * null), `retainedJob(jobId)` (the job's context admission row or null) and `participantImplementations.entriesFor(claim)`.
 * Discovery answers the seller's own entry for exactly its own claim. A job answers its buyer and the seller, in the order
 * asked, from the request's scope or else a row in `intent`, `admitted` or `running`, when it names this seller and Listing;
 * the buyer's profile and modules come only from its one current, unrevoked enrollment. Anything else answers no
 * participants, which the wire refuses as a participant mismatch. An unauthenticated connection answers nothing, and a
 * connection reader failure rejects with its own error. Throws TypeError when an input is missing.
 */
export function createSellerAuthorityReader(inputs = {}) {
  requireInputs(inputs);
  const { connectionAuthority, identityRecord, claim, listingPin, bootstrap, retainedJob, participantImplementations } = inputs;
  const pinText = canonicalize(listingPin);
  // The seller's own entry, built from the record and the wire's constants as `bindTp1Profile` builds `binding.profile`.
  const ownEntry = () => ({ claim, profile: { id: TP1_PROFILE_ID, revision: TP1_PROFILE_REVISION, base: TP1_BASE_REVISION,
    chainIdentity: identityRecord.chainIdentity, pinVersion: identityRecord.pinVersion }, modules: { ...TESTNET_PROFILE_TP1.tuple } });

  // The job's scope on this call: the request's own bootstrap scope, else a retained row that still grants; null when nothing
  // relates a buyer to the job.
  function jobScope(jobId) {
    const scope = bootstrap.current(jobId);
    if (scope !== null) return scope;
    const row = retainedJob(jobId);
    return GRANTING_STATES.includes(row?.state) ? row : null;
  }

  // The one current, unrevoked enrollment for a claim, as `{claim, profile, modules}`; else null.
  async function enrolledImplementation(peer) {
    const entries = await participantImplementations.entriesFor(peer);
    if (!Array.isArray(entries) || entries.length !== 1) return null;
    const [entry] = entries;
    if (entry?.claim !== peer || entry.revoked !== false || typeof entry.evidence !== 'string' || entry.evidence === '' || !entry.profile || !entry.modules) return null;
    return { claim: peer, profile: entry.profile, modules: entry.modules };
  }

  async function participantsFor({ sessionId, participants }) {
    if (sessionId === null) return [];
    if (sessionId === DACS_SELLER_DISCOVERY_FORMAT) return participants.length === 1 && participants[0] === claim ? [ownEntry()] : [];
    const scope = jobScope(sessionId);
    if (scope === null || scope.seller !== claim || canonicalize(scope.listingPin) !== pinText) return [];
    if (participants.length !== 2 || !participants.includes(scope.buyer) || !participants.includes(claim)) return [];
    const buyer = await enrolledImplementation(scope.buyer);
    if (buyer === null) return [];
    return participants.map((asked) => (asked === claim ? ownEntry() : buyer));
  }

  return async function readAuthority(scope) {
    const connection = await connectionAuthority({ local: scope.local, sessionId: null, participants: [] });
    if (connection === undefined || connection === null) return undefined;
    if (scope.sessionId === null) return connection;
    return { ...connection, sessionId: scope.sessionId, participants: await participantsFor(scope) };
  };
}

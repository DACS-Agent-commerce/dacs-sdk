// The seller kit's production TP-1 authority reader: the function the wire calls as `readAuthority`. It reads only:
// the connection through the kit session's connection reader, and local evidence (the request's own bootstrap scope,
// the retained context admission row and the enrollment source), each on every call. It takes no fence, lock or
// signer, and it keeps no state between calls.
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
 * Returns the seller's `Tp1AuthorityReader` for `bindTp1Profile` and every later wire check. All inputs are required:
 * - `connectionAuthority(scope)`: the kit session's connection reader, asked only `{local, sessionId: null, participants: []}`;
 *   it resolves the connection decision, or nothing for a connection it cannot authenticate;
 * - `identityRecord`: the SDK-approved identity record; `claim`: the seller's own claim; `listingPin`: its current Listing pin;
 * - `bootstrap.current(jobId)`: the calling request's authenticated bootstrap scope `{jobId, buyer, seller, listingPin}`, or null
 *   (`createBootstrapScopes` enters none for a job whose retained row was already `compensating` or `aborted`);
 * - `retainedJob(jobId)`: the job's retained context admission row (with `state`, `buyer`, `seller` and `listingPin`), or null;
 * - `participantImplementations.entriesFor(claim)`: the independently approved enrollment for a claim, as entries
 *   `{claim, profile, modules, evidence, revoked}`.
 * The answer is the connection decision with the participants asked for, in the order asked. Discovery answers the seller's
 * own entry for exactly its own claim. A job answers the buyer and the seller of the request's bootstrap scope, or of a retained
 * row in `intent`, `admitted` or `running`, when that scope names this seller and Listing; the buyer's profile and modules come
 * only from its one current, unrevoked enrollment. A row in any other state with no scope, a missing enrollment, or any other
 * set of participants answers no participants, which the wire refuses as a participant mismatch. A connection the session
 * cannot authenticate answers nothing, and a connection reader failure rejects with its original error.
 * Throws TypeError at construction when an input is missing; no completed binding is needed.
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

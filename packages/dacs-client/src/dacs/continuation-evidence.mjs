// The finalized-commitment evidence a continuing request, or a read of a
// committed purchase, carries: retained verified bytes rebuilt from the row.
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { OperationError } from '../client-errors.mjs';

const canonicalBytes = (value) => (value === undefined ? undefined : Buffer.from(canonicalize(value)));

/** Returns the `anchoredB64` and `anchoredHash` members that keep a verified commitment's anchored tuple as canonical bytes with their SHA-256. Throws if the tuple cannot be canonicalized. */
export function anchoredTupleMembers(anchored) {
  const bytes = canonicalBytes(anchored);
  return { anchoredB64: bytes.toString('base64'), anchoredHash: sha256Hex(bytes) };
}

/** Returns the tuple bytes kept on a commitment summary, or null when none are kept or they do not match their stored hash. */
export function keptTupleBytes(commitment) {
  if (typeof commitment?.anchoredB64 !== 'string' || typeof commitment.anchoredHash !== 'string') return null;
  const bytes = Buffer.from(commitment.anchoredB64, 'base64');
  return sha256Hex(bytes) === commitment.anchoredHash ? bytes : null;
}

const sameCommitment = (a, b) => a.contentHash === b.contentHash && a.signer === b.signer && a.committedAt === b.committedAt;

/** Returns whether a readback result is a verified commitment with the summary's content hash, signer and commit time. */
export const matchesCommitmentSummary = (readback, summary) => readback?.status === 'verified' && sameCommitment(readback, summary);

/**
 * Keeps `members` (`anchoredB64`, `anchoredHash`) on the stored commitment summary when it is still the one the caller read and holds no usable bytes. Like
 * keepChainPointers it is not progress: the protocol revision stays, so no flow's snapshot goes stale. Returns the stored row, or the caller's when nothing was written.
 */
export function keepCommitmentTuple({ db, ops, transaction }, operation, members) {
  return transaction(db, () => {
    const stored = ops.get(operation.accountId, operation.id);
    const summary = stored?.state.protocol.commitment;
    if (!stored || stored.status !== operation.status || !summary || keptTupleBytes(summary) || !sameCommitment(summary, operation.state.protocol.commitment)) return operation;
    return ops.transition(operation.id, stored.status, stored.status, { state: { protocol: { ...stored.state.protocol, commitment: { ...summary, ...members } } },
      event: 'protocol_commitment_tuple_kept', data: { anchoredHash: members.anchoredHash } });
  });
}

/**
 * Returns `async (operation) => evidence`, where evidence is `{commitment, agreement, signedListing}` as canonical bytes for the wire, or undefined before
 * commitment. Without usable kept tuple bytes it asks `readCommitment(operation)` once for a fresh authenticated readback and keeps its tuple through
 * `keep(operation, members)`. Rejects `commitment_unverified` when that readback does not match the stored summary: nothing is signed.
 */
export function createContinuationEvidence({ readCommitment, keep }) {
  return async function continuationEvidence(operation) {
    const { commitment, agreement, listing } = operation.state.protocol;
    if (!commitment) return undefined;
    let tuple = keptTupleBytes(commitment);
    if (!tuple) {
      const readback = await readCommitment(operation);
      if (!matchesCommitmentSummary(readback, commitment)) throw new OperationError('commitment_unverified', 'no kept finalized commitment matches a fresh authenticated readback; nothing was signed or sent');
      const members = anchoredTupleMembers(readback.anchored);
      keep(operation, members);
      tuple = Buffer.from(members.anchoredB64, 'base64');
    }
    return { commitment: tuple, agreement: canonicalBytes(agreement?.artifact), signedListing: canonicalBytes(listing) };
  };
}

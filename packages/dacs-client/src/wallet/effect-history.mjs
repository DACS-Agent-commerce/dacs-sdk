// The client's dispatch history (K0 "Dispatch history", DS-4): every authorization
// and dispatch record of an artifact's exact signed bytes, in order, in the
// durable wallet journal under `eb/<lane>/<artifactHash>/<seq>`. Records are only
// ever added: through the journal's appendUnderLock, never `put`, and never to the
// native transport's own `lane(...)` and `intent(...)` keys. Internal: not exported
// by the package.
import { OperationError } from '../client-errors.mjs';

const KEY_PREFIX = 'eb/';
const SEQ_DIGITS = 10;
const ARTIFACT_HASH = /^[0-9a-f]{64}$/;
const SEQ_SUFFIX = new RegExp(`^[0-9]{${SEQ_DIGITS}}$`);

const historyPrefix = (lane, artifactHash) => `${KEY_PREFIX}${lane}/${artifactHash}/`;
const historyKey = (lane, artifactHash, seq) => historyPrefix(lane, artifactHash) + String(seq).padStart(SEQ_DIGITS, '0');
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const unavailable = (message) => new OperationError('eb_history_unavailable', `the dispatch history is unavailable: ${message}`);
const persistFailed = (cause) => new OperationError('eb_persist_failed', 'the dispatch record was not persisted; nothing was transmitted', undefined, { cause });

const isArtifact = ({ lane, artifactHash } = {}) => typeof lane === 'string' && lane !== '' && ARTIFACT_HASH.test(artifactHash);

function checkedRecord(record) {
  if (!isPlainObject(record) || !isArtifact(record) || typeof record.passId !== 'string' || !record.passId
    || typeof record.state !== 'string' || !record.state || 'seq' in record) {
    throw new TypeError('a history record is an object with a lane, a 64-hex artifactHash, a passId and a state, and no seq');
  }
  return record;
}

// One artifact's stored records, checked against their keys: a key that is not
// this artifact's, a body that disagrees with its key, a gap or a record out of
// order makes the history unavailable, never empty.
async function readHistory(journal, lane, artifactHash) {
  const prefix = historyPrefix(lane, artifactHash);
  const records = [];
  for (const [key, value] of await journal.entries()) {
    const suffix = key.slice(prefix.length);
    if (!key.startsWith(prefix) || !SEQ_SUFFIX.test(suffix)) continue;
    if (!isPlainObject(value) || value.lane !== lane || value.artifactHash !== artifactHash || value.seq !== Number(suffix)
      || typeof value.passId !== 'string' || typeof value.state !== 'string') throw unavailable(`the record at ${key} does not match its key`);
    records.push(value);
  }
  records.forEach((stored, index) => { if (stored.seq !== index + 1) throw unavailable(`the record sequence has a gap before ${stored.seq}`); });
  return records;
}

// Under the lane owner: classify a repeated record, else add it as the next seq.
async function appendUnderOwner(journal, record) {
  const history = await readHistory(journal, record.lane, record.artifactHash);
  const prior = history.find((stored) => stored.passId === record.passId && stored.state === record.state);
  if (prior) {
    if (JSON.stringify(prior) !== JSON.stringify({ ...record, seq: prior.seq })) throw new OperationError('eb_history_conflict', `a different ${record.state} record already exists for pass ${record.passId}`);
    return { status: 'existing', seq: prior.seq };
  }
  const seq = history.length + 1;
  await journal.appendUnderLock(record.lane, historyKey(record.lane, record.artifactHash, seq), { ...record, seq });
  return { status: 'appended', seq };
}

/**
 * The dispatch history over an explicit durable wallet journal.
 *
 * `append(record)` takes `{ lane, artifactHash, passId, state, ...fields }` and
 * resolves `{ status: 'appended', seq }`, or `{ status: 'existing', seq }` for an
 * identical record of the same pass and state (a retry; it grants no send). It runs
 * in the frame that already owns `record.lane` and acquires the lane once when none
 * does. It rejects `eb_persist_failed` with the real cause (a conflicting record,
 * an unavailable history, `journal-fenced`, `journal-capacity`, `journal-busy`) and
 * throws `TypeError` for a malformed record.
 *
 * `read({ lane, artifactHash })` resolves the artifact's records in order, or
 * rejects `eb_history_unavailable` when the stored history cannot be trusted. It
 * throws `TypeError` without a lane and a 64-hex artifactHash, never an empty history.
 */
export function createEffectHistory({ journal }) {
  return {
    async append(record) {
      const checked = checkedRecord(record);
      try {
        return await journal.withOwnedOrAcquiredLane(checked.lane, () => appendUnderOwner(journal, checked));
      } catch (error) { throw persistFailed(error); }
    },
    async read(artifact) {
      if (!isArtifact(artifact)) throw new TypeError('reading a history needs a lane and a 64-hex artifactHash');
      return readHistory(journal, artifact.lane, artifact.artifactHash);
    },
  };
}

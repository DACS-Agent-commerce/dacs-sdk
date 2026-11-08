// The client's dispatch history: the authorization and dispatch records of an
// artifact's exact signed bytes, one per pass and state, in the durable wallet
// journal under `eb/<lane>/<artifactHash>/<passId>/<state>` (lane, passId and
// state URI-encoded). Each record has its own key and is only ever added,
// through the journal's appendUnderLock, never `put`, and never to the native
// transport's own `lane(...)` and `intent(...)` keys. The journal's commit
// order is the history's order. Internal: not exported by the package.
import { isDeepStrictEqual } from 'node:util';
import { OperationError } from '../client-errors.mjs';

const ARTIFACT_HASH = /^[0-9a-f]{64}$/;

const historyPrefix = (lane, artifactHash) => `eb/${encodeURIComponent(lane)}/${artifactHash}/`;
const historyKey = ({ lane, artifactHash, passId, state }) => `${historyPrefix(lane, artifactHash)}${encodeURIComponent(passId)}/${encodeURIComponent(state)}`;
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value !== '';
const isArtifact = ({ lane, artifactHash } = {}) => isText(lane) && ARTIFACT_HASH.test(artifactHash);
const unavailable = (message, options) => new OperationError('eb_history_unavailable', `the dispatch history is unavailable: ${message}`, undefined, options);
const persistFailed = (cause) => new OperationError('eb_persist_failed', 'the dispatch record was not persisted; nothing was transmitted', undefined, { cause });

function checkedRecord(record) {
  if (!isPlainObject(record) || !isArtifact(record) || !isText(record.passId) || !isText(record.state)) {
    throw new TypeError('a history record is an object with a lane, a 64-hex artifactHash, a passId and a state');
  }
  return record;
}

// The record under `key` when its suffix is exactly an encoded passId and state
// and its body names the same lane, artifact, pass and state; anything else
// under this artifact's prefix makes the history unavailable, never shorter.
function storedRecord(key, value, lane, artifactHash, prefix) {
  const parts = key.slice(prefix.length).split('/');
  let passId, state;
  try { [passId, state] = parts.map(decodeURIComponent); } catch { /* reported below */ }
  if (parts.length !== 2 || !isText(passId) || !isText(state) || key !== historyKey({ lane, artifactHash, passId, state })) throw unavailable(`the key ${key} is not a history record key`);
  if (!isPlainObject(value) || value.lane !== lane || value.artifactHash !== artifactHash || value.passId !== passId || value.state !== state) throw unavailable(`the record at ${key} does not match its key`);
  return value;
}

/**
 * The dispatch history over an explicit durable wallet journal.
 *
 * `append(record)` takes `{ lane, artifactHash, passId, state, ...fields }` and
 * resolves `{ status: 'appended' }`, or `{ status: 'existing' }` when the same
 * pass and state already hold a deep-equal record (a retry, also a concurrent
 * one; it grants no send). It runs in the frame that already owns `record.lane`
 * and acquires the lane once when none does. It rejects `eb_persist_failed` with
 * the real cause (`eb_history_conflict` for a different record of that pass and
 * state, `journal-fenced`, `journal-capacity`, `journal-busy`, `journal-invalid`)
 * and throws `TypeError` for a malformed record.
 *
 * `read({ lane, artifactHash })` resolves the artifact's records in commit
 * order, or rejects `eb_history_unavailable` (with the journal's error as
 * `cause` when the journal failed) when the stored history cannot be trusted.
 * It throws `TypeError` without a lane and a 64-hex artifactHash, never
 * answering with an empty history.
 */
export function createEffectHistory({ journal }) {
  async function classifyExisting(key, record) {
    const stored = await journal.get(key);
    if (!isDeepStrictEqual(stored, JSON.parse(JSON.stringify(record)))) throw new OperationError('eb_history_conflict', `a different ${record.state} record already exists for pass ${record.passId}`);
    return { status: 'existing' };
  }

  return {
    async append(record) {
      const checked = checkedRecord(record);
      const key = historyKey(checked);
      try {
        await journal.withOwnedOrAcquiredLane(checked.lane, () => journal.appendUnderLock(checked.lane, key, checked));
        return { status: 'appended' };
      } catch (error) {
        if (error?.code !== 'journal-key-exists') throw persistFailed(error);
      }
      try { return await classifyExisting(key, checked); } catch (error) { throw persistFailed(error); }
    },
    async read(artifact) {
      if (!isArtifact(artifact)) throw new TypeError('reading a history needs a lane and a 64-hex artifactHash');
      const { lane, artifactHash } = artifact;
      const prefix = historyPrefix(lane, artifactHash);
      let rows;
      try { rows = await journal.entries(); } catch (error) { throw unavailable('the journal could not be read', { cause: error }); }
      return rows.filter(([key]) => key.startsWith(prefix)).map(([key, value]) => storedRecord(key, value, lane, artifactHash, prefix));
    },
  };
}

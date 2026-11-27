// The client's dispatch history: the authorization and dispatch records of an
// artifact's exact signed bytes, one per pass and state, in the durable wallet
// journal under `eb/<lane>/<artifactHash>/<passId>/<state>` (lane, passId and
// state URI-encoded). Each record has its own key and is only ever added,
// through the journal's appendUnderLock, never `put`, and never to the native
// transport's own `lane(...)` and `intent(...)` keys. The journal's commit
// order is the history's order. A lane's records can also be read for one
// operation across all its artifacts. The package's `./wallet/effect-history`
// entry exports the readers and the lane key below; the appender stays internal.
import { isDeepStrictEqual } from 'node:util';
import { OperationError } from '../client-errors.mjs';
import { deepFreeze } from '../util/deep-freeze.mjs';
import { registeredJournal } from './journal-identity.mjs';

const ARTIFACT_HASH = /^[0-9a-f]{64}$/;
const ARTIFACT_HASH_LENGTH = 64;
// Room kept in a history key after the lane and artifact hash for `<passId>/<state>`.
const HISTORY_KEY_SUFFIX_RESERVE_BYTES = 64;
const NATIVE_WALLET_LANE_PREFIX = 'devnet/native-wallet/';
const BARE_CHAIN_IDENTITY = /^(?:0x)?([0-9a-f]{64})$/;

const lanePrefix = (lane) => `eb/${encodeURIComponent(lane)}/`;
const historyPrefix = (lane, artifactHash) => `${lanePrefix(lane)}${artifactHash}/`;
const historyKey = ({ lane, artifactHash, passId, state }) => `${historyPrefix(lane, artifactHash)}${encodeURIComponent(passId)}/${encodeURIComponent(state)}`;
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value !== '';
const isArtifact = ({ lane, artifactHash } = {}) => isText(lane) && typeof artifactHash === 'string' && ARTIFACT_HASH.test(artifactHash);
const unavailable = (message, options) => new OperationError('eb_history_unavailable', `the dispatch history is unavailable: ${message}`, undefined, options);
const persistFailed = (cause) => new OperationError('eb_persist_failed', 'the dispatch record was not persisted', undefined, { cause });
const asUnavailable = (error) => (error instanceof OperationError && error.code === 'eb_history_unavailable' ? error : unavailable('the lane could not be checked', { cause: error }));

// A lower-case 64-hex chain identity, with or without 0x, is returned bare. Any other value is returned
// unchanged, never lower-cased or trimmed, so the network binder refuses it with its own cause.
export const canonicalChainIdentity = (chainIdentity) => (typeof chainIdentity === 'string' ? BARE_CHAIN_IDENTITY.exec(chainIdentity)?.[1] ?? chainIdentity : chainIdentity);

/** Returns the journal key of the native write lane for `address` on the pinned network and chain. The chain identity is keyed in its bare lower-case form, with or without a 0x prefix. */
export const nativeWalletLaneKey = ({ network, chainIdentity }, address) => `${NATIVE_WALLET_LANE_PREFIX}${JSON.stringify([network, canonicalChainIdentity(chainIdentity), address])}`;

/** isNativeWalletLaneKey(lane) returns true only for a string nativeWalletLaneKey returns for three non-empty strings, in that exact spelling. It never throws. */
export function isNativeWalletLaneKey(lane) {
  if (typeof lane !== 'string' || !lane.startsWith(NATIVE_WALLET_LANE_PREFIX)) return false;
  let members;
  try { members = JSON.parse(lane.slice(NATIVE_WALLET_LANE_PREFIX.length)); } catch { return false; }
  return Array.isArray(members) && members.length === 3 && members.every(isText)
    && nativeWalletLaneKey({ network: members[0], chainIdentity: members[1] }, members[2]) === lane;
}

function checkedRecord(record) {
  if (!isPlainObject(record) || Object.hasOwn(record, 'seq') || !isArtifact(record) || !isText(record.passId) || !isText(record.state)) {
    throw new TypeError('a history record is an object with a lane, a 64-hex artifactHash, a passId and a state');
  }
  return record;
}

// The record under `key` when its suffix is exactly an artifact hash, an
// encoded passId and a state, and its body names the same lane, artifact, pass
// and state; anything else under this lane's prefix makes the history
// unavailable, never shorter.
function storedRecord(key, value, lane) {
  const parts = key.slice(lanePrefix(lane).length).split('/');
  const artifactHash = parts[0];
  let passId, state;
  try { [passId, state] = parts.slice(1).map(decodeURIComponent); } catch { /* reported below */ }
  if (parts.length !== 3 || !ARTIFACT_HASH.test(artifactHash) || !isText(passId) || !isText(state) || key !== historyKey({ lane, artifactHash, passId, state })) throw unavailable(`the key ${key} is not a history record key`);
  if (!isPlainObject(value) || value.lane !== lane || value.artifactHash !== artifactHash || value.passId !== passId || value.state !== state) throw unavailable(`the record at ${key} does not match its key`);
  return value;
}

// Every record under `prefix` of the rows `readEntries()` resolves, each checked against its key, in commit order.
async function storedRecords(readEntries, lane, prefix) {
  let rows;
  try { rows = await readEntries(); } catch (error) { throw unavailable('the journal could not be read', { cause: error }); }
  return rows.filter(([key]) => key.startsWith(prefix)).map(([key, value]) => storedRecord(key, value, lane));
}

/**
 * The dispatch history over an explicit durable wallet journal.
 *
 * `append(record, { owner } = {})` takes a record with
 * `{ lane, artifactHash, passId, state, ...fields }`. It reserves `seq` for journal ordering (a record carrying it throws TypeError),
 * and resolves `{ status: 'appended' }`, or `{ status: 'existing' }` when the same
 * pass and state already hold a deep-equal record (a retry, also a concurrent
 * one; it grants no send). It runs in the frame that already owns `record.lane`
 * or reuses the explicit lane owner passed by `withWalletLock`, including from
 * outside that frame, and acquires the lane once when neither is supplied.
 * It rejects `eb_persist_failed` with the real cause (`eb_history_conflict` for a different record of that pass and
 * state, `journal-fenced`, `journal-capacity`, `journal-busy`, `journal-invalid`)
 * and throws `TypeError` for a malformed record.
 *
 * `read({ lane, artifactHash })` resolves the artifact's records in commit
 * order, or rejects `eb_history_unavailable` (with the journal's error as
 * `cause` when the journal failed) when the stored history cannot be trusted.
 * It throws `TypeError` without a lane and a 64-hex artifactHash, never
 * answering with an empty history.
 *
 * `readOperation({ lane, operationId })` resolves the records of every
 * artifact on that lane whose `operationId` matches, in commit order, with the
 * same checks and refusals as `read`. It throws `TypeError` without a lane and
 * an operationId.
 */
export function createEffectHistory({ journal }) {
  async function classifyExisting(key, record) {
    const stored = await journal.get(key);
    if (!isDeepStrictEqual(stored, JSON.parse(JSON.stringify(record)))) throw new OperationError('eb_history_conflict', `a different ${record.state} record already exists for pass ${record.passId}`);
    return { status: 'existing' };
  }

  const readEntries = () => journal.entries();

  return {
    async append(record, { owner } = {}) {
      const checked = checkedRecord(record);
      const key = historyKey(checked);
      try {
        await journal.withOwnedOrAcquiredLane(checked.lane, () => journal.appendUnderLock(checked.lane, key, checked), { owner });
        return { status: 'appended' };
      } catch (error) {
        if (error?.code !== 'journal-key-exists') throw persistFailed(error);
      }
      try { return await classifyExisting(key, checked); } catch (error) { throw persistFailed(error); }
    },
    async read(artifact) {
      if (!isArtifact(artifact)) throw new TypeError('reading a history needs a lane and a 64-hex artifactHash');
      return storedRecords(readEntries, artifact.lane, historyPrefix(artifact.lane, artifact.artifactHash));
    },
    async readOperation({ lane, operationId } = {}) {
      if (!isText(lane) || !isText(operationId)) throw new TypeError('reading an operation needs a lane and an operationId');
      return (await storedRecords(readEntries, lane, lanePrefix(lane))).filter((record) => record.operationId === operationId);
    },
  };
}

/** createEffectHistoryReader(journal) returns a frozen {read, readOperation} over the durable wallet journal `journal`: the readers of createEffectHistory, with no appender. */
export function createEffectHistoryReader(journal) {
  const { read, readOperation } = createEffectHistory({ journal });
  return Object.freeze({ read, readOperation });
}

// The records of `operationId` on `lane`, after every record under the lane checks against its key and names an operation.
async function checkedOperationRecords(readEntries, lane, operationId) {
  const records = await storedRecords(readEntries, lane, lanePrefix(lane));
  if (!records.every((record) => isText(record.operationId))) throw unavailable('a record on the lane names no operation');
  return deepFreeze(records.filter((record) => record.operationId === operationId));
}

/** withCheckedOperationHistory({journal, lane, operationId}, work) resolves what `work({records, laneOwner, readChecked})` returns, run with
 * `lane` held: `records` are the deep-frozen records of `operationId` after the whole lane checked, and `readChecked()` reads them again.
 * Afterwards the lane must still be held and unchanged; a refusal then does not undo `work`. Throws TypeError checked_history_request_invalid,
 * checked_history_journal_invalid (not an unchanged handle openDurableWalletJournal returned) or checked_history_lane_invalid (not a native
 * wallet lane key whose history keys fit the journal) before any journal call. Rejects eb_history_unavailable, keeping the journal error as
 * `cause`, for a closed, busy, fenced, unreadable or changed history; an error `work` throws while the lane is held passes through unchanged. */
export async function withCheckedOperationHistory(request, work) {
  if (!isPlainObject(request) || typeof work !== 'function' || !isText(request.operationId)) throw new TypeError('checked_history_request_invalid');
  const { journal, lane, operationId } = request;
  const registration = registeredJournal(journal);
  if (!registration) throw new TypeError('checked_history_journal_invalid');
  const keyBytes = isNativeWalletLaneKey(lane) ? Buffer.byteLength(lanePrefix(lane)) + ARTIFACT_HASH_LENGTH + 1 + HISTORY_KEY_SUFFIX_RESERVE_BYTES : Infinity;
  if (keyBytes > registration.maxKeyBytes) throw new TypeError('checked_history_lane_invalid');
  const { entries, withOwnedOrAcquiredLane } = registration;
  const readEntries = () => entries.call(journal);
  let workFailure = null;
  try {
    return await withOwnedOrAcquiredLane.call(journal, lane, async (laneOwner) => {
      const readChecked = () => withOwnedOrAcquiredLane.call(journal, lane, () => checkedOperationRecords(readEntries, lane, operationId), { owner: laneOwner })
        .catch((error) => { throw asUnavailable(error); });
      const records = await readChecked();
      let value;
      try { value = await work(Object.freeze({ records, laneOwner, readChecked })); } catch (error) { workFailure = { error }; throw error; }
      if (!isDeepStrictEqual(await readChecked(), records)) throw unavailable('the history changed while the lane was held');
      return value;
    });
  } catch (error) {
    if (workFailure && error === workFailure.error) throw error;
    throw asUnavailable(error);
  }
}

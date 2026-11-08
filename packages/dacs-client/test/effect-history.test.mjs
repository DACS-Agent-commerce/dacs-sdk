// The client's dispatch history on the real durable journal. Appends go through
// the journal's owned append, never through `put`, and reuse the lane owner of
// the frame they run in. Crash tests kill a real child. No network, no keys.
import assert from 'node:assert/strict';
import { AsyncResource } from 'node:async_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';
import { createEffectHistory } from '../src/wallet/effect-history.mjs';
import { spawnJournalChild } from './helpers/journal-child-process.mjs';

const LANE = 'devnet/native-wallet/TEST-lane';
const ARTIFACT = '1'.repeat(64);
const PREFIX = `eb/${encodeURIComponent(LANE)}/${ARTIFACT}/`;
const keyOf = (passId, state) => `${PREFIX}${passId}/${state}`;
const entry = (passId, state, extra = {}) => ({ lane: LANE, artifactHash: ARTIFACT, passId, state, ...extra });
const ARTIFACT_ID = { lane: LANE, artifactHash: ARTIFACT };

function tempJournal(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'effect-history-'));
  const path = join(dir, 'journal.sqlite');
  const journal = openDurableWalletJournal({ path, mode: 'create', ...options });
  const opened = [journal];
  const reopen = (reopenOptions = {}) => { const next = openDurableWalletJournal({ path, mode: 'open', ...reopenOptions }); opened.push(next); return next; };
  t.after(() => { for (const j of opened) { try { j.close(); } catch { /* already closed by the test */ } } rmSync(dir, { recursive: true, force: true }); });
  return { path, journal, reopen };
}

// The journal the adapter sees, with every `put` logged and the lane lock's
// acquisition number logged each time a frame or an append runs.
function observed(journal) {
  const puts = [], frames = [], appends = [];
  const laneFence = () => journal.inspectLocks().find((row) => row.key === LANE)?.fence ?? null;
  return {
    puts, frames, appends,
    journal: {
      ...journal,
      put: (key, value) => { puts.push(key); return journal.put(key, value); },
      withOwnedOrAcquiredLane: (lane, work) => journal.withOwnedOrAcquiredLane(lane, () => { frames.push(laneFence()); return work(); }),
      appendUnderLock: (lane, key, value) => { appends.push(laneFence()); return journal.appendUnderLock(lane, key, value); },
    },
  };
}

const refusal = async (promise, code, causeCode) => {
  const error = await promise.then(() => null, (e) => e);
  assert.equal(error?.code, code);
  assert.equal(error.cause?.code, causeCode);
  return error;
};
const outcome = (promise) => promise.then((value) => value.status, (error) => `${error.code}/${error.cause?.code}`);

test('an identical retry, with its fields in another order at the top level and nested, is existing after a reopen, adds no row, never puts and leaves the native lane record unchanged', async (t) => {
  const { journal, reopen } = tempJournal(t);
  const laneRecord = { stage: 'broadcast-started', hash: ARTIFACT };
  await journal.put(LANE, laneRecord);
  const first = observed(journal);
  const record = entry('pass-1', 'dispatch-started', { detail: { kind: 'native', amounts: ['1', '2'] } });
  assert.deepEqual(await createEffectHistory({ journal: first.journal }).append(record), { status: 'appended' });
  const stored = await journal.entries();
  assert.deepEqual(stored.map(([key]) => key), [LANE, keyOf('pass-1', 'dispatch-started')], 'the lane is encoded in the key, so its slashes are not key segments');

  journal.close();
  const restarted = observed(reopen());
  const history = createEffectHistory({ journal: restarted.journal });
  const reordered = { detail: { amounts: ['1', '2'], kind: 'native' }, state: 'dispatch-started', passId: 'pass-1', artifactHash: ARTIFACT, lane: LANE };
  assert.deepEqual(await history.append(reordered), { status: 'existing' });
  assert.deepEqual(await history.append(record), { status: 'existing' });
  assert.deepEqual(await restarted.journal.entries(), stored, 'nothing was rewritten or added');
  assert.deepEqual(first.puts.concat(restarted.puts), [], 'no history key was ever put');
  assert.deepEqual(await restarted.journal.get(LANE), laneRecord);
});

test('a changed field, a different array order, different bytes or a differently normalized string is refused eb_persist_failed caused by eb_history_conflict, with no write', async (t) => {
  const { journal } = tempJournal(t);
  const history = createEffectHistory({ journal });
  await history.append(entry('pass-1', 'signed', { items: [1, 2], bytes: '0a0b', note: 'café' }));
  const stored = await journal.entries();
  for (const changed of [{ items: [1, 2], bytes: '0a0b', note: 'café', extra: true }, { items: [2, 1], bytes: '0a0b', note: 'café' },
    { items: [1, 2], bytes: '0a0c', note: 'café' }, { items: [1, 2], bytes: '0a0b', note: 'café' }]) {
    await refusal(history.append(entry('pass-1', 'signed', changed)), 'eb_persist_failed', 'eb_history_conflict');
  }
  assert.deepEqual(await journal.entries(), stored);
});

test('concurrent appends in one owned frame: identical ones give one appended and the rest existing, a changed one conflicts, distinct ones are all appended, and a reopen reads them back in commit order', async (t) => {
  const { journal, reopen } = tempJournal(t);
  const history = createEffectHistory({ journal });
  const signed = entry('pass-1', 'signed', { a: 1, b: 2 });
  const results = await journal.withWalletLock(LANE, () => Promise.all([
    outcome(history.append(signed)),
    outcome(history.append(entry('pass-1', 'signed', { b: 2, a: 1 }))),
    outcome(history.append(entry('pass-1', 'dispatch-started'))),
    outcome(history.append(entry('pass-1', 'dispatch-acknowledged'))),
    outcome(history.append(entry('pass-1', 'signed', { a: 1, b: 3 }))),
  ]));
  assert.deepEqual(results, ['appended', 'existing', 'appended', 'appended', 'eb_persist_failed/eb_history_conflict']);
  journal.close();
  const read = await createEffectHistory({ journal: reopen() }).read(ARTIFACT_ID);
  assert.deepEqual(read.map((r) => r.state), ['signed', 'dispatch-started', 'dispatch-acknowledged']);
  assert.deepEqual(read[0], signed);
});

test('concurrent identical appends through two adapters over one journal, outside any frame, acquire the lane once each and give one appended and one existing', async (t) => {
  const { journal } = tempJournal(t);
  const left = observed(journal), right = observed(journal);
  const record = entry('pass-1', 'signed');
  const results = await Promise.all([outcome(createEffectHistory({ journal: left.journal }).append(record)), outcome(createEffectHistory({ journal: right.journal }).append(record))]);
  assert.deepEqual(results.sort(), ['appended', 'existing']);
  assert.equal(left.frames.length + right.frames.length, 2, 'each append ran in one frame');
  assert.notEqual(left.frames[0], right.frames[0], 'each append acquired the lane itself');
  assert.deepEqual(journal.inspectLocks(), []);
  assert.equal((await journal.entries()).length, 1);
});

test('an append inside a frame that owns the lane reuses that owner and never reaches journal-reentrant; one outside acquires the lane once; a foreign, expired or removed owner refuses eb_persist_failed with journal-fenced and writes nothing', async (t) => {
  const { journal, reopen } = tempJournal(t);
  const watch = observed(journal);
  const history = createEffectHistory({ journal: watch.journal });

  const ownedFence = await journal.withWalletLock(LANE, async () => {
    const owner = journal.inspectLocks().find((row) => row.key === LANE);
    assert.deepEqual(await history.append(entry('pass-1', 'signed')), { status: 'appended' });
    assert.deepEqual(await history.append(entry('pass-1', 'dispatch-started')), { status: 'appended' });
    assert.deepEqual(journal.inspectLocks().find((row) => row.key === LANE), owner, 'the lane row is the frame\'s own, never reacquired');
    return owner.fence;
  });
  assert.deepEqual(watch.frames, [ownedFence, ownedFence]);
  assert.deepEqual(await history.append(entry('pass-2', 'signed')), { status: 'appended' });
  assert.deepEqual(watch.frames.slice(2), [ownedFence + 1], 'outside a frame the lane is acquired once');
  assert.deepEqual(watch.appends, [ownedFence, ownedFence, ownedFence + 1]);
  assert.deepEqual(journal.inspectLocks(), []);

  const before = await journal.entries();
  const expired = await journal.withWalletLock(LANE, async () => new AsyncResource('kept-past-release'));
  await refusal(expired.runInAsyncScope(() => history.append(entry('pass-3', 'signed'))), 'eb_persist_failed', 'journal-fenced');

  const other = reopen();
  await assert.rejects(journal.withWalletLock(LANE, async () => {
    const lock = journal.inspectLocks().find((row) => row.key === LANE);
    other.releaseAbandonedLock({ key: LANE, instance: lock.instance, fence: lock.fence });
    await refusal(history.append(entry('pass-3', 'signed')), 'eb_persist_failed', 'journal-fenced');
    await other.withWalletLock(LANE, async () => {
      await refusal(history.append(entry('pass-3', 'signed')), 'eb_persist_failed', 'journal-fenced');
    });
  }), { code: 'journal-fenced' });
  assert.deepEqual(await journal.entries(), before, 'a fenced owner wrote nothing');
});

test('a full journal or an oversized record refuses eb_persist_failed with journal-capacity and writes nothing', async (t) => {
  const { journal: full } = tempJournal(t, { maxRecords: 1 });
  const fullHistory = createEffectHistory({ journal: full });
  await fullHistory.append(entry('pass-1', 'signed'));
  await refusal(fullHistory.append(entry('pass-2', 'signed')), 'eb_persist_failed', 'journal-capacity');
  assert.equal((await full.entries()).length, 1);
  const { journal: small } = tempJournal(t, { maxValueBytes: 128 });
  await refusal(createEffectHistory({ journal: small }).append(entry('pass-1', 'signed', { text: 'x'.repeat(300) })), 'eb_persist_failed', 'journal-capacity');
  assert.equal((await small.entries()).length, 0);
});

test('read rejects eb_history_unavailable for a key under the artifact that is not a pass and state, for a body that disagrees with its key, and for a journal read error, which it keeps as the cause', async (t) => {
  const strays = [[`${PREFIX}%E0%A4%A/signed`, entry('pass-1', 'signed')], [`${PREFIX}pass-1`, entry('pass-1', 'signed')],
    [`${PREFIX}pass-1/signed/extra`, entry('pass-1', 'signed')], [`${PREFIX}pass%2d1/signed`, entry('pass-1', 'signed')],
    [keyOf('pass-1', 'signed'), entry('pass-1', 'dispatch-started')], [keyOf('pass-1', 'signed'), { ...entry('pass-1', 'signed'), artifactHash: '2'.repeat(64) }]];
  for (const [key, value] of strays) {
    const { journal } = tempJournal(t);
    await journal.put(key, value);
    await assert.rejects(createEffectHistory({ journal }).read(ARTIFACT_ID), { code: 'eb_history_unavailable' }, key);
  }
  const { journal } = tempJournal(t);
  const failure = new Error('journal unreadable');
  const error = await createEffectHistory({ journal: { ...journal, entries: async () => { throw failure; } } }).read(ARTIFACT_ID).catch((e) => e);
  assert.equal(error.code, 'eb_history_unavailable');
  assert.equal(error.cause, failure);
  const history = createEffectHistory({ journal });
  await assert.rejects(history.read({ lane: LANE }), TypeError, 'a read without an artifact is refused, never answered as an empty history');
  await assert.rejects(history.append({ lane: LANE, artifactHash: ARTIFACT, passId: 'pass-1' }), TypeError, 'a record without a state is refused');
});

test('a history append committed before its lane owner was killed is kept, the lane is reclaimed only from the dead holder, and the same record is existing after restart', async (t) => {
  const { path, journal, reopen } = tempJournal(t);
  const laneRecord = { stage: 'broadcast-started', hash: ARTIFACT };
  await journal.put(LANE, laneRecord);
  journal.close();
  const child = await spawnJournalChild(t, { path });
  child.request('crashAfterHistoryAppend', { record: entry('pass-1', 'dispatch-started') });
  await child.event('recorded');
  assert.equal(await child.exited, 'SIGKILL');

  const restarted = reopen();
  assert.deepEqual(restarted.inspectLocks().map((row) => [row.key, row.instance, row.holder]), [[LANE, child.instance, 'exited']], 'the killed holder is proven dead, not assumed');
  const committed = await restarted.entries();
  assert.deepEqual(committed.map(([key]) => key), [LANE, keyOf('pass-1', 'dispatch-started')]);

  const history = createEffectHistory({ journal: restarted });
  assert.deepEqual(await history.append(entry('pass-2', 'signed')), { status: 'appended' }, 'the lane is reclaimed');
  assert.deepEqual(restarted.inspectLocks(), []);
  assert.deepEqual((await restarted.entries()).slice(0, 2), committed, 'every earlier record is byte-identical');
  assert.deepEqual(await restarted.get(LANE), laneRecord, 'the replay restriction is untouched');
  assert.deepEqual(await history.append(entry('pass-1', 'dispatch-started')), { status: 'existing' }, 'the crashed pass\'s record is never appended twice');
  assert.deepEqual((await history.read(ARTIFACT_ID)).map((r) => [r.passId, r.state]), [['pass-1', 'dispatch-started'], ['pass-2', 'signed']]);
});

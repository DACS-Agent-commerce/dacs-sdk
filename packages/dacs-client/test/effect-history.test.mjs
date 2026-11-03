// P16a1a: the client's dispatch history on the real durable journal. Appends go
// through the journal's owned append, never through `put`, and reuse the lane
// owner of the frame they run in. Crash tests kill a real child. No network, no keys.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';
import { createEffectHistory } from '../src/wallet/effect-history.mjs';
import { spawnJournalChild } from './helpers/journal-child-process.mjs';

const LANE = 'devnet/native-wallet/TEST-lane';
const ARTIFACT = '1'.repeat(64);
const keyOf = (seq) => `eb/${LANE}/${ARTIFACT}/${String(seq).padStart(10, '0')}`;
const entry = (passId, state, extra = {}) => ({ lane: LANE, artifactHash: ARTIFACT, passId, state, ...extra });

function tempJournal(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'effect-history-'));
  const path = join(dir, 'journal.sqlite');
  const journal = openDurableWalletJournal({ path, mode: 'create', ...options });
  const opened = [journal];
  const reopen = (reopenOptions = {}) => { const next = openDurableWalletJournal({ path, mode: 'open', ...reopenOptions }); opened.push(next); return next; };
  t.after(() => { for (const j of opened) { try { j.close(); } catch { /* already closed by the test */ } } rmSync(dir, { recursive: true, force: true }); });
  return { path, journal, reopen };
}

// The journal the adapter sees, with every `put` on any key logged and the
// lane lock's acquisition number logged each time a frame or append runs.
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

const eachRefusal = async (promise, code, causeCode) => {
  const error = await promise.then(() => null, (e) => e);
  assert.equal(error?.code, code);
  assert.equal(error.cause?.code, causeCode);
  return error;
};

test('on the real durable journal, a history key left by our own prior run is never put again: identical is idempotent and grants no send, conflicting refuses eb_persist_failed, a full journal refuses eb_persist_failed, and each has zero transmissions', async (t) => {
  const { journal, reopen } = tempJournal(t);
  const laneRecord = { stage: 'broadcast-started', hash: ARTIFACT };
  await journal.put(LANE, laneRecord);
  const sent = [];
  const dispatch = async (history, record) => {
    const result = await history.append(record);
    if (result.status === 'appended') sent.push(record);
    return result;
  };

  const first = observed(journal);
  const history = createEffectHistory({ journal: first.journal });
  assert.deepEqual(await history.append(entry('pass-1', 'dispatch-started')), { status: 'appended', seq: 1 });
  assert.deepEqual(await history.append(entry('pass-1', 'dispatch-withheld', { cause: 'writes_stopped' })), { status: 'appended', seq: 2 });
  sent.length = 0;
  const stored = await journal.entries();

  journal.close();
  const restarted = observed(reopen());
  const afterRestart = createEffectHistory({ journal: restarted.journal });
  assert.deepEqual(await dispatch(afterRestart, entry('pass-1', 'dispatch-started')), { status: 'existing', seq: 1 }, 'identical is an idempotent retry');
  assert.deepEqual(await dispatch(afterRestart, entry('pass-1', 'dispatch-withheld', { cause: 'writes_stopped' })), { status: 'existing', seq: 2 });
  await eachRefusal(dispatch(afterRestart, entry('pass-1', 'dispatch-started', { cause: 'another body' })), 'eb_persist_failed', 'eb_history_conflict');
  assert.deepEqual(await restarted.journal.entries(), stored, 'nothing was rewritten or added');
  assert.deepEqual(first.puts.concat(restarted.puts), [], 'no history key was ever put');
  assert.equal(sent.length, 0, 'an idempotent or conflicting retry grants no send');
  assert.deepEqual(await afterRestart.append(entry('pass-2', 'signed')), { status: 'appended', seq: 3 }, 'the sequence continues from the retained history after restart');
  assert.deepEqual((await afterRestart.read({ lane: LANE, artifactHash: ARTIFACT })).map((r) => [r.seq, r.passId, r.state]), [[1, 'pass-1', 'dispatch-started'], [2, 'pass-1', 'dispatch-withheld'], [3, 'pass-2', 'signed']]);
  assert.deepEqual(await restarted.journal.get(LANE), laneRecord);

  const { journal: gapped } = tempJournal(t);
  await gapped.put(keyOf(2), { ...entry('pass-1', 'dispatch-started'), seq: 2 });
  const gappedHistory = createEffectHistory({ journal: gapped });
  await eachRefusal(gappedHistory.append(entry('pass-1', 'signed')), 'eb_persist_failed', 'eb_history_unavailable');
  await assert.rejects(gappedHistory.read({ lane: LANE, artifactHash: ARTIFACT }), { code: 'eb_history_unavailable' });
  assert.equal(await gapped.get(keyOf(1)), undefined, 'a history with a gap is unavailable evidence, never extended');
  await assert.rejects(gappedHistory.read({ lane: LANE }), TypeError, 'a read without an artifact is refused, never answered as an empty history');
  await assert.rejects(gappedHistory.append({ lane: LANE, artifactHash: ARTIFACT, passId: 'pass-1' }), TypeError, 'a record without a state is refused');

  const { journal: full } = tempJournal(t, { maxRecords: 1, maxValueBytes: 256 });
  const fullHistory = createEffectHistory({ journal: full });
  await fullHistory.append(entry('pass-1', 'signed'));
  await eachRefusal(dispatch(fullHistory, entry('pass-2', 'signed')), 'eb_persist_failed', 'journal-capacity');
  const { journal: small } = tempJournal(t, { maxRecords: 8, maxValueBytes: 128 });
  await eachRefusal(dispatch(createEffectHistory({ journal: small }), entry('pass-1', 'signed', { text: 'x'.repeat(300) })), 'eb_persist_failed', 'journal-capacity');
  assert.equal(sent.length, 0, 'every refusal has zero transmissions');
  assert.equal((await full.entries()).length, 1);
  assert.equal((await small.entries()).length, 0);
});

test('on the real durable journal, an EB append made inside an operation that already owns the lane reuses that owner with zero same-key acquisitions and never reaches journal-reentrant; one made outside acquires the lane once; a foreign, expired or removed owner refuses eb_persist_failed with journal-fenced as its cause', async (t) => {
  const { journal, reopen } = tempJournal(t);
  const watch = observed(journal);
  const history = createEffectHistory({ journal: watch.journal });

  const acquiredBefore = await journal.withWalletLock(LANE, async () => journal.inspectLocks().find((row) => row.key === LANE).fence);
  await journal.withWalletLock(LANE, async () => {
    const owner = journal.inspectLocks().find((row) => row.key === LANE);
    assert.equal(owner.fence, acquiredBefore + 1);
    assert.deepEqual(await history.append(entry('pass-1', 'signed')), { status: 'appended', seq: 1 });
    assert.deepEqual(await history.append(entry('pass-1', 'dispatch-started')), { status: 'appended', seq: 2 });
    assert.deepEqual(journal.inspectLocks().find((row) => row.key === LANE), owner, 'the lane row is the frame\'s own, never reacquired');
  });
  assert.deepEqual(watch.frames, [acquiredBefore + 1, acquiredBefore + 1], 'both appends ran in the existing frame');
  assert.deepEqual(journal.inspectLocks(), []);

  assert.deepEqual(await history.append(entry('pass-2', 'signed')), { status: 'appended', seq: 3 });
  assert.equal(watch.frames.at(-1), acquiredBefore + 2, 'outside a frame the lane is acquired once');
  assert.equal(watch.frames.length, 3);
  assert.deepEqual(journal.inspectLocks(), []);
  assert.deepEqual(watch.appends, [acquiredBefore + 1, acquiredBefore + 1, acquiredBefore + 2]);

  const other = reopen();
  const before = await journal.entries();
  await assert.rejects(journal.withWalletLock(LANE, async () => {
    const lock = journal.inspectLocks().find((row) => row.key === LANE);
    other.releaseAbandonedLock({ key: LANE, instance: lock.instance, fence: lock.fence });
    await eachRefusal(history.append(entry('pass-3', 'signed')), 'eb_persist_failed', 'journal-fenced');
    await other.withWalletLock(LANE, async () => {
      await eachRefusal(history.append(entry('pass-3', 'signed')), 'eb_persist_failed', 'journal-fenced');
    });
  }), { code: 'journal-fenced' });
  assert.deepEqual(await journal.entries(), before, 'a fenced owner wrote nothing');
});

test('client-history-commit-before-owner-release', async (t) => {
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
  assert.deepEqual(committed.map(([key]) => key), [LANE, keyOf(1)]);

  const history = createEffectHistory({ journal: restarted });
  assert.deepEqual(await history.append(entry('pass-2', 'signed')), { status: 'appended', seq: 2 }, 'the lane is reclaimed and the sequence continues');
  assert.deepEqual(restarted.inspectLocks(), []);
  assert.deepEqual((await restarted.entries()).slice(0, 2), committed, 'every earlier record is byte-identical');
  assert.deepEqual(await restarted.get(LANE), laneRecord, 'the replay restriction is untouched');
  assert.deepEqual(await history.append(entry('pass-1', 'dispatch-started')), { status: 'existing', seq: 1 }, 'the crashed pass\'s record is never appended twice');
});

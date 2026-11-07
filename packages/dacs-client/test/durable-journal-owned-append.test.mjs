// P16a0: appendUnderLock writes a new record inside an owned wallet lane,
// never overwrites and never reacquires the lane. No network, no keys.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';

const LANE = 'devnet/native-wallet/TEST-lane';

function tempJournal(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'durable-journal-owned-append-'));
  const path = join(dir, 'journal.sqlite');
  const journal = openDurableWalletJournal({ path, mode: 'create', ...options });
  const open = () => { const other = openDurableWalletJournal({ path, mode: 'open' }); t.after(() => other.close()); return other; };
  t.after(() => { journal.close(); rmSync(dir, { recursive: true, force: true }); });
  return { journal, open };
}
const ownRow = (journal, key = LANE) => journal.inspectLocks().find((row) => row.key === key);

test('appendUnderLock writes once inside an owned lane with zero lane reacquisitions and refuses outside one; withOwnedOrAcquiredLane acquires once; a foreign or removed token refuses journal-fenced; an existing key is never overwritten; a full journal refuses journal-capacity; same-key withWalletLock nesting still refuses journal-reentrant', async (t) => {
  const { journal, open } = tempJournal(t);

  await assert.rejects(journal.appendUnderLock(LANE, 'history/1', { n: 1 }), { code: 'journal-fenced' });
  assert.equal(await journal.get('history/1'), undefined);

  await journal.withWalletLock(LANE, async () => {
    const lock = ownRow(journal);
    await journal.appendUnderLock(LANE, 'history/1', { n: 1 });
    await journal.appendUnderLock(LANE, 'history/2', { n: 2 });
    assert.deepEqual(ownRow(journal), lock, 'the lane was not reacquired');
    assert.deepEqual(await journal.get('history/1'), { n: 1 });
    await assert.rejects(journal.appendUnderLock(LANE, 'history/1', { n: 99 }), { code: 'journal-key-exists' });
    assert.deepEqual(await journal.get('history/1'), { n: 1 }, 'an existing key is never overwritten');
    await assert.rejects(journal.appendUnderLock('devnet/native-wallet/TEST-other', 'history/3', { n: 3 }), { code: 'journal-fenced' });
    assert.equal(await journal.withOwnedOrAcquiredLane(LANE, async () => ownRow(journal).fence), lock.fence, 'an owned lane is reused');
    await assert.rejects(journal.withWalletLock(LANE, async () => {}), { code: 'journal-reentrant' });
  });
  assert.deepEqual(journal.inspectLocks(), []);

  const acquired = await journal.withOwnedOrAcquiredLane(LANE, async () => {
    await journal.appendUnderLock(LANE, 'history/3', { n: 3 });
    return ownRow(journal).fence;
  });
  assert.equal(acquired, 2, 'a lane that is not owned is acquired once');
  assert.deepEqual(journal.inspectLocks(), []);

  await journal.put('history/put', { n: 'put' });
  await journal.withWalletLock(LANE, async () => {
    await assert.rejects(journal.appendUnderLock(LANE, 'history/put', { n: 'append' }), { code: 'journal-key-exists' });
  });
  assert.deepEqual(await journal.get('history/put'), { n: 'put' });

  const other = open();
  await assert.rejects(journal.withWalletLock(LANE, async () => {
    const lock = ownRow(journal);
    other.releaseAbandonedLock({ key: LANE, instance: lock.instance, fence: lock.fence });
    await assert.rejects(journal.appendUnderLock(LANE, 'history/removed', { n: 4 }), { code: 'journal-fenced' });
    await other.withWalletLock(LANE, async () => {
      await assert.rejects(journal.appendUnderLock(LANE, 'history/foreign', { n: 5 }), { code: 'journal-fenced' });
    });
  }), { code: 'journal-fenced' });
  assert.equal(await journal.get('history/removed'), undefined);
  assert.equal(await journal.get('history/foreign'), undefined);

  const { journal: full } = tempJournal(t, { maxRecords: 1, maxValueBytes: 64 });
  await full.withWalletLock(LANE, async () => {
    await full.appendUnderLock(LANE, 'history/1', { n: 1 });
    await assert.rejects(full.appendUnderLock(LANE, 'history/2', { n: 2 }), { code: 'journal-capacity' });
    await assert.rejects(full.appendUnderLock(LANE, 'history/big', { text: 'x'.repeat(100) }), { code: 'journal-capacity' });
  });
  assert.equal(await full.get('history/2'), undefined);
  assert.equal((await full.entries()).length, 1);
});

test('withOwnedOrAcquiredLane refuses journal-fenced and never runs its work when the lane context outlives its lock: after release, or while another holder owns the lane', async (t) => {
  const { journal, open } = tempJournal(t);
  const other = open();
  let ran = 0;
  const retain = () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const call = (async () => { await gate; return journal.withOwnedOrAcquiredLane(LANE, async () => { ran += 1; }); })();
    call.catch(() => {});
    return { release, call };
  };

  let first;
  await journal.withWalletLock(LANE, async () => { first = retain(); });
  assert.deepEqual(journal.inspectLocks(), []);
  first.release();
  await assert.rejects(first.call, { code: 'journal-fenced' }, 'a retained context with no lock row is refused');
  assert.equal(ran, 0);

  let second;
  await journal.withWalletLock(LANE, async () => { second = retain(); });
  await other.withWalletLock(LANE, async () => {
    second.release();
    await assert.rejects(second.call, { code: 'journal-fenced' }, 'another holder owns the lane');
    assert.equal(ran, 0);
  });
  assert.deepEqual(other.inspectLocks(), []);

  assert.equal(await journal.withWalletLock(LANE, () => journal.withOwnedOrAcquiredLane(LANE, async () => 'ok')), 'ok', 'a context that still owns its lane reuses it');
});

test('appendUnderLock refuses journal-fenced for a key another holder locks, as put does, and writes nothing; its own lane or nested lane key still appends', async (t) => {
  const { journal, open } = tempJournal(t);
  const other = open();
  const target = 'history/1';

  await other.withWalletLock(target, async () => {
    await journal.withWalletLock(LANE, async () => {
      await assert.rejects(journal.appendUnderLock(LANE, target, { n: 1 }), { code: 'journal-fenced' });
      await assert.rejects(journal.put(target, { n: 1 }), { code: 'journal-fenced' });
    });
  });
  assert.equal(await journal.get(target), undefined, 'nothing was written under the foreign lock');

  await journal.withWalletLock(LANE, async () => {
    await journal.appendUnderLock(LANE, target, { n: 1 });
    await journal.withWalletLock('history/nested', async () => {
      await journal.appendUnderLock(LANE, 'history/nested', { n: 2 });
    });
  });
  assert.deepEqual(await journal.get(target), { n: 1 });
  assert.deepEqual(await journal.get('history/nested'), { n: 2 });

  await journal.withWalletLock('history/self', async () => {
    await journal.appendUnderLock('history/self', 'history/self', { n: 3 });
  });
  assert.deepEqual(await journal.get('history/self'), { n: 3 });
});

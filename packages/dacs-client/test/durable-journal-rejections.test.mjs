import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';

const lane = 'wallet/rejection';
const reasons = [undefined, null, 0, '', false, 0n, NaN, new Error('work failed')];
const workTypes = [
  ['async rejection', (reason) => async () => { throw reason; }],
  ['sync throw', (reason) => () => { throw reason; }],
];

function tempJournal(t) {
  const directory = mkdtempSync(join(tmpdir(), 'durable-journal-rejections-'));
  const path = join(directory, 'journal.sqlite');
  const journal = openDurableWalletJournal({ path, mode: 'create' });
  t.after(() => { journal.close(); rmSync(directory, { recursive: true, force: true }); });
  return journal;
}

for (const [kind, work] of workTypes) {
  for (const reason of reasons) {
    const label = typeof reason === 'bigint' ? `${reason}n` : String(reason);
    test(`withWalletLock preserves ${kind} with ${label}`, async (t) => {
      const journal = tempJournal(t);
      try {
        await assert.rejects(journal.withWalletLock(lane, work(reason)), (error) => Object.is(error, reason));
      } finally {
        assert.deepEqual(journal.inspectLocks(), [], 'settled work releases its lock');
      }
      const value = { completed: true };
      assert.equal(await journal.withWalletLock(lane, () => value), value, 'the lane can be acquired again');
      assert.deepEqual(journal.inspectLocks(), []);
    });
  }
}

for (const reason of reasons) {
  const label = typeof reason === 'bigint' ? `${reason}n` : String(reason);
  test(`withWalletLock preserves ${label} as the cause when release is fenced`, async (t) => {
    const journal = tempJournal(t);
    const other = openDurableWalletJournal({ path: journal.path, mode: 'open' });
    t.after(() => other.close());
    await assert.rejects(journal.withWalletLock(lane, async () => {
      const lock = journal.inspectLocks().find((row) => row.key === lane);
      other.releaseAbandonedLock({ key: lane, instance: lock.instance, fence: lock.fence });
      throw reason;
    }), (error) => error.code === 'journal-fenced' && 'cause' in error && Object.is(error.cause, reason));
    assert.deepEqual(journal.inspectLocks(), []);
  });
}

test('withWalletLock returns undefined for successful work and omits a fenced failure cause', async (t) => {
  const journal = tempJournal(t);
  assert.equal(await journal.withWalletLock(lane, async () => undefined), undefined);
  assert.deepEqual(journal.inspectLocks(), []);
  const other = openDurableWalletJournal({ path: journal.path, mode: 'open' });
  t.after(() => other.close());
  await assert.rejects(journal.withWalletLock(lane, async () => {
    const lock = journal.inspectLocks().find((row) => row.key === lane);
    other.releaseAbandonedLock({ key: lane, instance: lock.instance, fence: lock.fence });
  }), (error) => error.code === 'journal-fenced' && !('cause' in error));
  assert.deepEqual(journal.inspectLocks(), []);
});

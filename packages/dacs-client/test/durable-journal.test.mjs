import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDurableWalletJournal } from '@kynesyslabs/dacs-client/wallet/durable-journal';

for (const reason of [undefined, null, false, 0, NaN, '', new Error('TEST-original')]) {
  test(`wallet lock preserves rejection reason ${String(reason)} and releases the lane`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'dacs-journal-result-'));
    const journal = openDurableWalletJournal({ path: join(directory, 'journal.sqlite'), mode: 'create' });
    t.after(() => { journal.close(); rmSync(directory, { recursive: true, force: true }); });
    let rejected = false;
    try {
      await journal.withWalletLock('TEST-lane', () => Promise.reject(reason));
    } catch (error) {
      rejected = true;
      assert.ok(Object.is(error, reason), 'the original rejection value propagates');
    }
    assert.equal(rejected, true, 'rejection must never become successful resolution');
    assert.deepEqual(journal.inspectLocks(), []);
    assert.equal(await journal.withWalletLock('TEST-lane', async () => 'TEST-next-holder'), 'TEST-next-holder');
  });
}

test('wallet lock preserves a successful undefined result', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dacs-journal-result-'));
  const journal = openDurableWalletJournal({ path: join(directory, 'journal.sqlite'), mode: 'create' });
  t.after(() => { journal.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(await journal.withWalletLock('TEST-lane', async () => undefined), undefined);
  assert.deepEqual(journal.inspectLocks(), []);
});

test('every read detects journal version changes after opening', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const directory = mkdtempSync(join(tmpdir(), 'dacs-journal-version-'));
  const path = join(directory, 'journal.sqlite');
  const journal = openDurableWalletJournal({ path, mode: 'create' });
  t.after(() => { journal.close(); rmSync(directory, { recursive: true, force: true }); });
  await journal.put('TEST-record', { stage: 'issued' });
  assert.deepEqual(await journal.get('TEST-record'), { stage: 'issued' });
  const writer = new DatabaseSync(path);
  try { writer.prepare("UPDATE meta SET value='2' WHERE key='version'").run(); }
  finally { writer.close(); }
  await assert.rejects(journal.get('TEST-record'), { code: 'journal-integrity' });
  await assert.rejects(journal.entries(), { code: 'journal-integrity' });
});

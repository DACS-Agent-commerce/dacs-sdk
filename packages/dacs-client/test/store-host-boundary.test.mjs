import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkSqlitePurchaseInput } from '../src/util/sqlite-purchase-admission.mjs';
import { retireSqliteHandle } from '../src/util/sqlite-write-lease.mjs';
import { inTransaction } from './helpers/sqlite-engine-floor.mjs';

const callback = () => {};
function database(t, memory = false) {
  const dir = mkdtempSync(join(tmpdir(), 'dacs-purchase-admission-'));
  const db = new DatabaseSync(memory ? ':memory:' : join(dir, 'state.sqlite'));
  t.after(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  db.exec('PRAGMA synchronous=EXTRA; CREATE TABLE records(id TEXT)');
  return { db, dir };
}
test('a compatible-looking handle is refused before database or callback access', () => {
  let calls = 0;
  const db = { prepare() { calls++; }, exec() { calls++; } };
  assert.throws(() => checkSqlitePurchaseInput(db, () => { calls++; }),
    { name: 'OperationError', code: 'purchase_store_invalid_handle' });
  assert.equal(calls, 0);
});
for (const fn of [undefined, 'TEST-callback']) {
  test(`a ${typeof fn} callback is refused`, t => {
    const { db } = database(t);
    assert.throws(() => checkSqlitePurchaseInput(db, fn), { code: 'purchase_store_invalid_callback' });
  });
}
for (const fn of [async () => {}, function* () {}, async function* () {}]) {
  test(`${fn.constructor.name} requires an ordinary synchronous callback`, t => {
    const { db } = database(t);
    assert.throws(() => checkSqlitePurchaseInput(db, fn), { code: 'purchase_store_async_callback' });
  });
}
test('a retired handle stays refused after reopen', t => {
  const { db } = database(t);
  retireSqliteHandle(db);
  for (const reopen of [false, true]) {
    if (reopen) db.open();
    assert.throws(() => checkSqlitePurchaseInput(db, callback), { code: 'purchase_store_retired_handle' });
  }
});
for (const mode of ['WAL', 'DELETE']) for (const memory of [false, true]) for (const hostTransaction of [false, true]) {
  test(`persistent ${mode} attachment refusal preserves host work, memory=${memory}, hostTransaction=${hostTransaction}`, t => {
    const { db, dir } = database(t, memory);
    db.exec(`PRAGMA journal_mode=${mode}`);
    db.prepare('ATTACH ? AS archive').run(join(dir, 'archive.sqlite'));
    if (hostTransaction) db.exec("BEGIN; INSERT INTO records VALUES ('TEST-host')");
    assert.throws(() => checkSqlitePurchaseInput(db, callback), { code: 'purchase_store_persistent_attachment' });
    assert.equal(inTransaction(db), hostTransaction);
    assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, hostTransaction ? 1 : 0);
    if (hostTransaction) db.exec('ROLLBACK');
    db.exec('DETACH archive');
    assert.equal(checkSqlitePurchaseInput(db, callback), undefined);
    assert.deepEqual(db.prepare('SELECT name FROM temp.sqlite_master').all(), []);
  });
}
for (const memory of [false, true]) for (const file of [':memory:', '']) {
  test(`volatile attachments are refused, memory=${memory}, file=${file}`, t => {
    const { db } = database(t, memory);
    db.prepare('ATTACH ? AS volatile').run(file);
    assert.throws(() => checkSqlitePurchaseInput(db, callback), { code: 'purchase_store_unsupported_attachment' });
    db.exec('DETACH volatile; CREATE TEMP TABLE session(id TEXT)');
    assert.equal(checkSqlitePurchaseInput(db, callback), undefined);
  });
}

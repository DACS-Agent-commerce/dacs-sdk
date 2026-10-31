import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkSqlitePurchaseInput } from '../src/util/sqlite-purchase-admission.mjs';

function database(t, file = 'state.sqlite') {
  const dir = mkdtempSync(join(tmpdir(), 'dacs-purchase-journal-'));
  const db = new DatabaseSync(file === ':memory:' || file === '' ? file : join(dir, file));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec('PRAGMA synchronous=EXTRA; PRAGMA cache_size=10; CREATE TABLE records(value TEXT)');
  return db;
}
const callback = () => assert.fail('admission must never run the callback');
for (const mode of ['OFF', 'MEMORY']) for (const warm of [false, true]) for (const hostTransaction of [false, true]) {
  test(`persistent ${mode} is refused without changing host work, warm=${warm}, hostTransaction=${hostTransaction}`, t => {
    const db = database(t);
    if (warm) checkSqlitePurchaseInput(db, callback);
    db.exec(`PRAGMA journal_mode=${mode}`);
    if (hostTransaction) db.exec("BEGIN; INSERT INTO records VALUES ('TEST-host')");
    const tables = () => db.prepare("SELECT name FROM temp.sqlite_master ORDER BY name").all();
    const before = tables();
    assert.throws(() => checkSqlitePurchaseInput(db, callback),
      { name: 'OperationError', code: 'purchase_store_unsupported_journal_mode' });
    assert.equal(db.prepare('PRAGMA main.journal_mode').get().journal_mode, mode.toLowerCase());
    assert.equal(db.isTransaction, hostTransaction);
    assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, hostTransaction ? 1 : 0);
    assert.deepEqual(tables(), before);
    if (hostTransaction) db.exec('ROLLBACK');
    db.exec('PRAGMA journal_mode=DELETE');
    assert.equal(checkSqlitePurchaseInput(db, callback), undefined);
  });
}
for (const mode of ['DELETE', 'TRUNCATE', 'PERSIST', 'WAL']) for (const synchronous of mode === 'WAL' ? ['FULL', 'EXTRA'] : ['EXTRA']) {
  test(`persistent ${mode}/${synchronous} admission preserves rollback after cache spills`, t => {
    const db = database(t);
    db.exec(`PRAGMA journal_mode=${mode}; PRAGMA synchronous=${synchronous}`);
    const original = 'TEST-original-' + 'a'.repeat(10_000);
    db.exec('BEGIN');
    const insert = db.prepare('INSERT INTO records VALUES (?)');
    for (let i = 0; i < 1_000; i++) insert.run(original);
    db.exec('COMMIT');
    checkSqlitePurchaseInput(db, callback);
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE records SET value=?').run('TEST-updated-' + 'b'.repeat(10_000));
    db.exec('ROLLBACK');
    assert.equal(db.prepare('SELECT count(*) n FROM records WHERE value != ?').get(original).n, 0);
    assert.equal(db.prepare('PRAGMA main.journal_mode').get().journal_mode, mode.toLowerCase());
  });
}
for (const mode of ['DELETE', 'TRUNCATE', 'PERSIST', 'WAL']) for (const synchronous of mode === 'WAL' ? ['OFF', 'NORMAL'] : ['OFF', 'NORMAL', 'FULL']) for (const warm of [false, true]) for (const hostTransaction of [false, true]) {
  test(`persistent ${mode}/${synchronous} refuses without changing host work, warm=${warm}, hostTransaction=${hostTransaction}`, t => {
    const db = database(t);
    db.exec(`PRAGMA journal_mode=${mode}; CREATE TEMP TABLE session(id TEXT)`);
    if (warm) checkSqlitePurchaseInput(db, callback);
    db.exec(`PRAGMA synchronous=${synchronous}`);
    const level = db.prepare('PRAGMA main.synchronous').get().synchronous;
    if (hostTransaction) db.exec("BEGIN; INSERT INTO records VALUES ('TEST-host')");
    const tables = () => db.prepare('SELECT name, sql FROM temp.sqlite_master ORDER BY name').all();
    const before = tables();
    assert.throws(() => checkSqlitePurchaseInput(db, callback),
      { name: 'OperationError', code: 'purchase_store_unsupported_synchronous' });
    assert.equal(db.prepare('PRAGMA main.synchronous').get().synchronous, level);
    assert.equal(db.prepare('PRAGMA main.journal_mode').get().journal_mode, mode.toLowerCase());
    assert.equal(db.isTransaction, hostTransaction);
    assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, hostTransaction ? 1 : 0);
    assert.deepEqual(tables(), before);
    if (hostTransaction) db.exec('ROLLBACK');
    db.exec('PRAGMA synchronous=EXTRA');
    assert.equal(checkSqlitePurchaseInput(db, callback), undefined);
  });
}
for (const file of [':memory:', '']) for (const synchronous of ['OFF', 'NORMAL', 'FULL', 'EXTRA']) {
  test(`volatile main admits ${synchronous} with its native journal and refuses OFF: ${file}`, t => {
    const db = database(t, file);
    db.exec(`PRAGMA synchronous=${synchronous}`);
    const level = db.prepare('PRAGMA main.synchronous').get().synchronous;
    const mode = db.prepare('PRAGMA main.journal_mode').get().journal_mode;
    assert.equal(checkSqlitePurchaseInput(db, callback), undefined);
    assert.equal(db.prepare('PRAGMA main.synchronous').get().synchronous, level);
    assert.equal(db.prepare('PRAGMA main.journal_mode').get().journal_mode, mode);
    db.exec('PRAGMA journal_mode=OFF');
    assert.throws(() => checkSqlitePurchaseInput(db, callback), { code: 'purchase_store_unsupported_journal_mode' });
  });
}

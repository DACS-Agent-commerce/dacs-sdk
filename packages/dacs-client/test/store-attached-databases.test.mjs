import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSqlitePurchaseStore } from '../src/seams/purchase-store-not-wired.mjs';

const refused = { code: 'purchase_store_persistent_attachment' };
const attach = 'ATTACH DATABASE ? AS "attached archive"';
function world(t, mode = 'WAL', memory = false) {
  const dir = mkdtempSync(join(tmpdir(), 'dacs-store-attachments-'));
  const path = join(dir, 'main.sqlite'), auxiliary = join(dir, 'aux.sqlite');
  const db = new DatabaseSync(memory ? ':memory:' : path), aux = new DatabaseSync(auxiliary);
  for (const connection of [db, aux]) connection.exec(`PRAGMA journal_mode=${mode}; PRAGMA synchronous=${mode === 'WAL' ? 'FULL' : 'EXTRA'}; CREATE TABLE records(id TEXT)`);
  aux.close();
  t.after(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return { db, path, auxiliary, store: createSqlitePurchaseStore() };
}
for (const mode of ['WAL', 'DELETE']) for (const warm of [false, true]) for (const hostTransaction of [false, true]) {
  test(`persistent ${mode} attachment is refused before callback or host work changes, warm=${warm}, hostTransaction=${hostTransaction}`, t => {
    const { db, auxiliary, store } = world(t, mode);
    if (warm) store.transaction(db, () => {});
    db.prepare(attach).run(auxiliary);
    if (hostTransaction) db.exec("BEGIN; INSERT INTO records VALUES ('TEST-host')");
    assert.throws(() => store.transaction(db, () => assert.fail('callback ran')), refused);
    assert.equal(db.isTransaction, hostTransaction);
    if (hostTransaction) {
      assert.equal(db.prepare('SELECT id FROM records').get().id, 'TEST-host');
      db.exec('ROLLBACK');
    }
    db.exec('DETACH DATABASE "attached archive"');
    store.transaction(db, () => db.exec("INSERT INTO records VALUES ('TEST-retry')"));
    assert.equal(db.prepare('SELECT id FROM records').get().id, 'TEST-retry');
  });
}
for (const nested of [false, true]) for (const following of ['last', 'batch', 'prepared', 'caught']) {
  test(`persistent attachment during callback rolls back both files, nested=${nested}, following=${following}`, t => {
    const { db, path, auxiliary, store } = world(t);
    const body = () => {
      db.exec("INSERT INTO records VALUES ('TEST-before')");
      if (following === 'batch') {
        db.exec(`ATTACH DATABASE '${auxiliary.replaceAll("'", "''")}' AS "attached archive"; INSERT INTO "attached archive".records VALUES ('TEST-aux')`);
      } else {
        db.prepare(attach).run(auxiliary);
        if (following === 'prepared') db.prepare('INSERT INTO "attached archive".records VALUES (?)').run('TEST-aux');
        if (following === 'caught') assert.throws(() => db.exec("INSERT INTO records VALUES ('TEST-after')"), refused);
      }
    };
    assert.throws(() => store.transaction(db, () => nested ? store.transaction(db, body) : body()), refused);
    for (const file of [path, auxiliary]) {
      const reopened = new DatabaseSync(file);
      try { assert.equal(reopened.prepare('SELECT count(*) n FROM records').get().n, 0); }
      finally { reopened.close(); }
    }
    if (db.isOpen) {
      assert.equal(db.isTransaction, false);
      db.exec('DETACH DATABASE "attached archive"');
      assert.equal(store.transaction(db, () => 'TEST-retry'), 'TEST-retry');
    }
  });
}
test('an in-memory main database still refuses persistent attachments', t => {
  const { db, auxiliary, store } = world(t, 'WAL', true);
  db.prepare(attach).run(auxiliary);
  assert.throws(() => store.transaction(db, () => assert.fail('callback ran')), refused);
});
for (const memory of [false, true]) for (const file of [':memory:', '']) for (const nested of [false, true]) {
  test(`volatile attachments are refused before callback entry, memory main=${memory}, file=${file}, nested=${nested}`, t => {
    const { db, store } = world(t, 'WAL', memory);
    const body = () => {
      db.prepare('ATTACH ? AS volatile').run(file);
      assert.throws(() => store.transaction(db, () => assert.fail('callback ran')), { code: 'purchase_store_unsupported_attachment' });
    };
    if (nested) assert.throws(() => store.transaction(db, body), { code: 'purchase_store_unsupported_attachment' });
    else body();
    db.exec('DETACH volatile; CREATE TEMP TABLE session(id TEXT)');
    store.transaction(db, () => db.exec("INSERT INTO records VALUES ('TEST-main'); INSERT INTO session VALUES ('TEST-temp')"));
    for (const table of ['records', 'session']) assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 1);
  });
}

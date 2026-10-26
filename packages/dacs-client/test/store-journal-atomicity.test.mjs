import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createSqlitePurchaseStore } from '../src/seams/purchase-store-not-wired.mjs';

const original = 'a'.repeat(10_000), updated = 'b'.repeat(10_000);
function database(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dacs-store-journal-')), path = join(dir, 'state.sqlite');
  const db = new DatabaseSync(path), store = createSqlitePurchaseStore();
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec('CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT NOT NULL); BEGIN');
  const insert = db.prepare('INSERT INTO records(value) VALUES (?)');
  for (let i = 0; i < 1_000; i++) insert.run(original);
  db.exec('COMMIT; PRAGMA synchronous=EXTRA; PRAGMA cache_size=10');
  return { db, path, store };
}
function assertUnchanged(path) {
  const reopened = new DatabaseSync(path);
  try {
    assert.equal(reopened.prepare('SELECT count(*) n FROM records').get().n, 1_000);
    assert.equal(reopened.prepare('SELECT count(*) n FROM records WHERE value != ?').get(original).n, 0);
  } finally { reopened.close(); }
}
for (const mode of ['OFF', 'MEMORY', 'DELETE', 'TRUNCATE', 'PERSIST', 'WAL']) for (const warm of [false, true]) {
  test(`spilled writes never survive a refused or failed ${mode} transaction, warm=${warm}`, t => {
    const { db, path, store } = database(t), cause = new Error('TEST-rollback');
    if (warm) store.transaction(db, () => {});
    db.exec(`PRAGMA journal_mode=${mode}`);
    let called = false;
    const body = () => {
      called = true;
      db.prepare('UPDATE records SET value=?').run(updated);
      throw cause;
    };
    const refused = ['OFF', 'MEMORY'].includes(mode);
    assert.throws(() => store.transaction(db, body), refused
      ? { name: 'OperationError', code: 'purchase_store_unsupported_journal_mode' }
      : error => error === cause);
    assert.equal(called, !refused);
    assert.equal(db.isTransaction, false);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, mode.toLowerCase());
    assertUnchanged(path);
    if (refused) {
      db.exec('PRAGMA journal_mode=DELETE');
      assert.equal(store.transaction(db, () => 'TEST-retry'), 'TEST-retry');
    }
  });
}
for (const mode of ['OFF', 'MEMORY', 'DELETE', 'TRUNCATE', 'PERSIST', 'WAL']) {
  test(`pre-commit process exit leaves no partial ${mode} updates`, t => {
    const { path } = database(t);
    const result = spawnSync(process.execPath,
      [fileURLToPath(new URL('./helpers/store-journal-worker.mjs', import.meta.url)), path, mode], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, ['OFF', 'MEMORY'].includes(mode) ? 'TEST-refused' : 'TEST-before-commit');
    assertUnchanged(path);
  });
}

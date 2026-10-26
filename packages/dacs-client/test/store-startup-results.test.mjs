import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSqlitePurchaseStore, purchaseStore } from '../src/seams/purchase-store-not-wired.mjs';
import { isSqliteHandleRetired } from '../src/util/sqlite-write-lease.mjs';

function world(t, Database = DatabaseSync) {
  const dir = mkdtempSync(join(tmpdir(), 'dacs-store-lifecycle-'));
  const file = join(dir, 'state.sqlite'), db = new Database(file);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE records (id TEXT PRIMARY KEY)');
  t.after(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return { db, file, store: createSqlitePurchaseStore() };
}

class InterleavedDatabase extends DatabaseSync {
  afterCommit;
  hideTransaction = false;
  get isTransaction() { return this.hideTransaction ? undefined : super.isTransaction; }
  exec(sql) {
    super.exec(sql);
    if (sql === 'COMMIT' && this.afterCommit) {
      const next = this.afterCommit;
      this.afterCommit = undefined;
      next();
    }
  }
}

for (const sql of ['CREATE TABLE migrated (id TEXT)', 'VACUUM']) for (const legacy of [false, true]) {
  test(`refused lease startup releases its write lock and permits a durable retry: ${sql}, legacy=${legacy}`, t => {
    const { db, file, store } = world(t, InterleavedDatabase), rival = new DatabaseSync(file);
    t.after(() => rival.close());
    db.hideTransaction = legacy;
    store.transaction(db, () => db.exec("INSERT INTO records VALUES ('TEST-warm')"));
    db.afterCommit = () => rival.exec(sql);
    assert.throws(() => store.transaction(db, () => assert.fail('stale schema callback ran')), { code: 'client_not_wired' });
    assert.equal(isSqliteHandleRetired(db), false);
    if (!legacy) assert.equal(db.isTransaction, false);
    rival.exec("INSERT INTO records VALUES ('TEST-rival')");
    store.transaction(db, () => db.exec("INSERT INTO records VALUES ('TEST-retry')"));
    const reopened = new DatabaseSync(file);
    try {
      assert.deepEqual(reopened.prepare('SELECT id FROM records ORDER BY id').all().map(row => row.id),
        ['TEST-retry', 'TEST-rival', 'TEST-warm']);
    } finally { reopened.close(); }
  });
}

for (const nested of [false, true]) for (const kind of ['throwing getter', 'promise with throwing getter', 'promise with hidden then', 'thenable']) {
  test(`result refusal retires retained writers before queued work: ${kind}, nested=${nested}`, async t => {
    const { db, file, store } = world(t), failure = new Error('TEST-result-inspection');
    const writer = db.prepare("INSERT INTO records VALUES ('TEST-late')");
    let getterCalls = 0, thenCalls = 0, lateError;
    const result = kind.startsWith('promise') ? Promise.resolve('TEST-value') : {};
    if (kind === 'thenable') result.then = () => { thenCalls++; };
    else Object.defineProperty(result, 'then', { get() {
      getterCalls++;
      if (kind === 'promise with hidden then') return undefined;
      throw failure;
    } });
    const body = () => {
      db.exec("INSERT INTO records VALUES ('TEST-before')");
      queueMicrotask(() => { try { writer.run(); } catch (error) { lateError = error; } });
      return result;
    };
    assert.throws(() => store.transaction(db, () => nested ? store.transaction(db, body) : body()),
      kind === 'throwing getter' ? error => error === failure : { code: 'purchase_store_async_result' });
    await Promise.resolve();
    assert.equal(isSqliteHandleRetired(db), true);
    assert.ok(lateError, 'queued writer must fail before any durable write');
    assert.equal(getterCalls, kind === 'throwing getter' ? 1 : 0);
    assert.equal(thenCalls, 0, 'refusal must not execute a thenable body');
    assert.throws(() => store.transaction(db, () => {}), { code: 'purchase_store_retired_handle' });
    const reopened = new DatabaseSync(file);
    try { assert.equal(reopened.prepare('SELECT count(*) n FROM records').get().n, 0); }
    finally { reopened.close(); }
  });
}

for (const native of [false, true]) {
  test(`classifier result inspection never adopts thenables or reads a native promise then: native=${native}`, async () => {
    let thenCalls = 0;
    const result = native ? Promise.reject(new Error('TEST-classifier-rejection')) : { then() { thenCalls++; } };
    if (native) Object.defineProperty(result, 'then', { get() { assert.fail('native promise then getter ran'); } });
    const store = purchaseStore({ ...createSqlitePurchaseStore(), isUniqueViolation: () => result });
    assert.throws(() => store.isUniqueViolation(new Error('TEST-constraint')), { code: 'purchase_store_async_classifier_result' });
    await Promise.resolve();
    assert.equal(thenCalls, 0);
  });
}

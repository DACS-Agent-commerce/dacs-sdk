import test from 'node:test';
import assert from 'node:assert/strict';
import { purchaseStore } from '../src/seams/purchase-store-not-wired.mjs';

for (const kind of ['callback-then-thenable', 'deferred', 'pass-through']) {
  test(`unqualified ${kind} transaction is refused before its callback can write`, async () => {
    let writes = 0;
    const transaction = kind === 'callback-then-thenable' ? (_db, fn) => { fn(); return Promise.resolve(); }
      : kind === 'deferred' ? (_db, fn) => Promise.resolve().then(fn) : (_db, fn) => fn();
    assert.throws(() => {
      const seam = purchaseStore({ transaction, isUniqueViolation: () => false });
      seam.transaction({}, () => writes++);
    }, { code: 'client_not_wired' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes, 0);
  });
}

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createSqlitePurchaseStore } from '../src/seams/purchase-store-not-wired.mjs';

test('a compatible-looking non-DatabaseSync handle is refused before database or callback access', () => {
  let calls = 0;
  const db = { prepare() { calls++; }, exec() { calls++; } };
  assert.throws(() => createSqlitePurchaseStore().transaction(db, () => { calls++; }),
    { code: 'client_not_wired', seam: 'purchase-store-not-wired' });
  assert.equal(calls, 0);
});

function database(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dacs-store-'));
  const path = join(dir, 'state.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE records (id TEXT PRIMARY KEY)');
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { db, path };
}
test('concrete adapter commits nested writes and rolls back the original thrown error', t => {
  const { db } = database(t), store = purchaseStore(createSqlitePurchaseStore()), cause = new Error('TEST-rollback');
  const write = id => db.prepare('INSERT INTO records VALUES (?)').run(id);
  assert.throws(() => store.transaction(db, () => {
    write('TEST-outer');
    store.transaction(db, () => write('TEST-inner'));
    throw cause;
  }), error => error === cause);
  assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 0);
  assert.equal(store.transaction(db, () => { write('TEST-first'); return store.transaction(db, () => { write('TEST-second'); return 'TEST-result'; }); }), 'TEST-result');
  assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 2);
});
for (const rejected of [false, true]) {
  test(`callback-then-thenable rolls back before rejecting, rejected=${rejected}`, async t => {
    const { db } = database(t), store = createSqlitePurchaseStore();
    assert.throws(() => store.transaction(db, () => {
      db.prepare('INSERT INTO records VALUES (?)').run('TEST-thenable');
      return rejected ? Promise.reject(new Error('TEST-refused')) : Promise.resolve();
    }), { code: 'client_not_wired' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 0);
    assert.equal(store.transaction(db, () => 'TEST-retry'), 'TEST-retry');
  });
}
test('BEGIN IMMEDIATE blocks a second connection before its callback and permits retry', t => {
  const { db, path } = database(t), second = new DatabaseSync(path), store = createSqlitePurchaseStore();
  t.after(() => second.close());
  second.exec('PRAGMA busy_timeout=0');
  let called = false;
  store.transaction(db, () => {
    assert.throws(() => store.transaction(second, () => { called = true; }), /locked/);
    assert.equal(called, false);
  });
  assert.equal(store.transaction(second, () => 'TEST-retry'), 'TEST-retry');
});
for (const stage of ['before-commit', 'after-commit']) {
  test(`process death ${stage} preserves atomic state on reopen`, t => {
    const { db, path } = database(t);
    const result = spawnSync(process.execPath, [new URL('./helpers/store-crash-worker.mjs', import.meta.url).pathname, path, stage], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, stage === 'before-commit' ? 0 : 2);
    const reopened = new DatabaseSync(path);
    try { assert.equal(reopened.prepare('SELECT count(*) n FROM records').get().n, stage === 'before-commit' ? 0 : 2); } finally { reopened.close(); }
  });
}
for (const classifier of [async () => false, function* () {}, async function* () {}]) {
  test(`non-synchronous classifier refuses construction: ${classifier.constructor.name}`, () => {
    assert.throws(() => purchaseStore({ ...createSqlitePurchaseStore(), isUniqueViolation: classifier }), { code: 'client_not_wired' });
  });
}

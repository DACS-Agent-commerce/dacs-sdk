import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSqlitePurchaseStore } from '../src/seams/purchase-store-not-wired.mjs';

function world(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE records (id TEXT PRIMARY KEY)');
  t.after(() => { try { db.close(); } catch {} });
  return { db, store: createSqlitePurchaseStore(), rows: () => db.prepare('SELECT id FROM records ORDER BY id').all().map(row => row.id) };
}
for (const sql of ['COMMIT', 'END', 'END TRANSACTION']) for (const prepared of [false, true]) for (const nested of [false, true]) {
  test(`callback ${sql}, prepared=${prepared}, nested=${nested}, cannot persist a partial write`, t => {
    const { db, store, rows } = world(t);
    const statement = prepared ? db.prepare(sql) : null;
    const body = () => {
      db.exec("INSERT INTO records VALUES ('TEST-partial')");
      if (prepared) statement.run(); else db.exec(sql);
      throw new Error('TEST-after-control');
    };
    assert.throws(() => store.transaction(db, () => nested ? store.transaction(db, body) : body()));
    assert.deepEqual(rows(), []);
    store.transaction(db, () => db.exec("INSERT INTO records VALUES ('TEST-complete')"));
    assert.deepEqual(rows(), ['TEST-complete']);
  });
}
for (const warm of [false, true]) {
  test(`refusing a host transaction leaves its connection and retry usable, warm=${warm}`, t => {
    const { db, store, rows } = world(t);
    if (warm) store.transaction(db, () => {});
    db.exec("BEGIN; INSERT INTO records VALUES ('TEST-host')");
    let called = false;
    assert.throws(() => store.transaction(db, () => { called = true; }));
    assert.equal(called, false);
    if (!warm) assert.deepEqual(db.prepare("SELECT name FROM temp.sqlite_master WHERE name LIKE 'dacs_purchase_%'").all(), []);
    db.exec('ROLLBACK');
    store.transaction(db, () => db.exec("INSERT INTO records VALUES ('TEST-retry')"));
    assert.deepEqual(rows(), ['TEST-retry']);
    db.exec("INSERT INTO records VALUES ('TEST-outside')");
    assert.deepEqual(rows(), ['TEST-outside', 'TEST-retry']);
  });
}
test('nested entry after a swallowed outer rollback does not recover an unopened savepoint', t => {
  const { db, store, rows } = world(t);
  db.exec("INSERT INTO records VALUES ('TEST-existing')");
  assert.throws(() => store.transaction(db, () => {
    assert.throws(() => db.exec("INSERT OR ROLLBACK INTO records VALUES ('TEST-existing')"), /UNIQUE/);
    assert.throws(() => store.transaction(db, () => assert.fail('lost transaction callback ran')));
  }));
  assert.deepEqual(rows(), ['TEST-existing']);
  store.transaction(db, () => db.exec("INSERT INTO records VALUES ('TEST-retry')"));
  assert.deepEqual(rows(), ['TEST-existing', 'TEST-retry']);
});

test('a missing TEMP marker is rebuilt without leaving stale guard triggers', t => {
  const { db, store, rows } = world(t);
  store.transaction(db, () => {});
  const { name } = db.prepare("SELECT name FROM temp.sqlite_master WHERE type='table' AND name LIKE 'dacs_purchase_%'").get();
  db.exec(`DROP TABLE "${name}"`);
  store.transaction(db, () => db.exec("INSERT INTO records VALUES ('TEST-rebuilt')"));
  assert.deepEqual(rows(), ['TEST-rebuilt']);
});

test('a caught callback COMMIT error cannot split a later failure from earlier writes', t => {
  const { db, store, rows } = world(t);
  assert.throws(() => store.transaction(db, () => {
    db.exec("INSERT INTO records VALUES ('TEST-first')");
    assert.throws(() => db.exec('COMMIT'), /statements in progress/);
    db.exec("INSERT INTO records VALUES ('TEST-second')");
    throw new Error('TEST-failure');
  }), /TEST-failure/);
  assert.deepEqual(rows(), []);
});

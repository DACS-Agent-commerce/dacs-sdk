import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { isSqliteHandleRetired } from '../src/util/sqlite-write-lease.mjs';
import { purchaseDatabase, durableIds, LegacyDatabase } from './helpers/purchase-tx-fixtures.mjs';
import { inTransaction } from './helpers/sqlite-engine-floor.mjs';

// Captured before the first adapter installs the statement guard.
const nativeExec = DatabaseSync.prototype.exec;
const callbackRan = () => assert.fail('callback ran');
const leaseObjects = db => db.prepare("SELECT name FROM temp.sqlite_master WHERE name LIKE 'dacs_purchase_%'").all();

// Run a rival schema change between the lease's COMMIT and the adapter's BEGIN.
const interleaved = Base => class extends Base {
  afterCommit;
  exec(sql) {
    super.exec(sql);
    if (sql !== 'COMMIT' || !this.afterCommit) return;
    const next = this.afterCommit;
    this.afterCommit = undefined;
    next();
  }
};
for (const sql of ['CREATE TABLE migrated (id TEXT)', 'VACUUM']) for (const [runtime, Base] of [['current', DatabaseSync], ['legacy', LegacyDatabase]]) {
  test(`a schema change before BEGIN is retryable and leaves no transaction or lock: ${sql}, ${runtime}`, t => {
    const { db, path, store } = purchaseDatabase(t, undefined, { Database: interleaved(Base) }), rival = new DatabaseSync(path);
    t.after(() => rival.close());
    store.transaction(db, () => db.exec("INSERT INTO records VALUES ('TEST-warm')"));
    db.afterCommit = () => rival.exec(sql);
    assert.throws(() => store.transaction(db, callbackRan), { name: 'OperationError', code: 'purchase_store_schema_changed' });
    assert.equal(isSqliteHandleRetired(db), false);
    // BEGIN succeeds only when the refused startup left no transaction open.
    db.exec('BEGIN; ROLLBACK');
    rival.exec("INSERT INTO records VALUES ('TEST-rival')");
    store.transaction(db, () => db.exec("INSERT INTO records VALUES ('TEST-retry')"));
    assert.deepEqual(durableIds(db, path), ['TEST-retry', 'TEST-rival', 'TEST-warm']);
  });
}

test('a dropped lease marker is rebuilt without touching host TEMP tables', t => {
  const { db, path, store } = purchaseDatabase(t);
  db.exec("CREATE TEMP TABLE session(id TEXT); INSERT INTO session VALUES ('TEST-host'); INSERT INTO records VALUES ('TEST-existing')");
  store.transaction(db, () => {});
  const [{ name }] = db.prepare("SELECT name FROM temp.sqlite_master WHERE type='table' AND name LIKE 'dacs_purchase_%'").all();
  db.exec(`DROP TABLE temp."${name}"`);
  store.transaction(db, () => db.exec("INSERT INTO records VALUES ('TEST-commit'); INSERT INTO session VALUES ('TEST-tx')"));
  assert.throws(() => store.transaction(db, () => { db.exec("INSERT INTO records VALUES ('TEST-refused')"); throw new Error('TEST-failure'); }), /TEST-failure/);
  assert.throws(() => store.transaction(db, () => {
    assert.throws(() => db.exec("INSERT OR ROLLBACK INTO records VALUES ('TEST-existing')"), /UNIQUE/);
    assert.throws(() => db.exec("INSERT INTO session VALUES ('TEST-after-rollback')"), /transaction ended/);
  }), { code: 'purchase_store_transaction_ended' });
  assert.deepEqual(durableIds(db, null, { volatile: true }, 'session'), ['TEST-host', 'TEST-tx']);
  assert.deepEqual(durableIds(db, path), ['TEST-commit', 'TEST-existing']);
  db.exec("INSERT INTO session VALUES ('TEST-outside')");
});

for (const warm of [false, true]) {
  test(`an explicit host transaction is refused without changing its work, warm=${warm}`, t => {
    const { db, path, store } = purchaseDatabase(t);
    if (warm) store.transaction(db, () => {});
    const objects = leaseObjects(db);
    db.exec("BEGIN; INSERT INTO records VALUES ('TEST-host')");
    assert.throws(() => store.transaction(db, callbackRan), /within a transaction/);
    assert.equal(inTransaction(db), true);
    assert.deepEqual(leaseObjects(db), objects);
    assert.deepEqual(durableIds(db, null, { volatile: true }), ['TEST-host']);
    db.exec('COMMIT');
    store.transaction(db, () => db.exec("INSERT INTO records VALUES ('TEST-retry')"));
    assert.deepEqual(durableIds(db, path), ['TEST-host', 'TEST-retry']);
  });
  test(`an unfinished host writer is refused and keeps its iterator and durable row, warm=${warm}`, t => {
    const { db, path, store } = purchaseDatabase(t);
    if (warm) store.transaction(db, () => {});
    const iterator = db.prepare("INSERT INTO records VALUES ('TEST-host') RETURNING id").iterate();
    assert.equal(iterator.next().value.id, 'TEST-host');
    assert.throws(() => store.transaction(db, callbackRan));
    assert.equal(iterator.next().done, true);
    assert.deepEqual(durableIds(db, path), ['TEST-host']);
    store.transaction(db, () => db.exec("INSERT INTO records VALUES ('TEST-retry')"));
    assert.deepEqual(durableIds(db, path), ['TEST-host', 'TEST-retry']);
  });
}

for (const sql of ['COMMIT', 'END', 'END TRANSACTION']) for (const prepared of [false, true]) for (const nested of [false, true]) {
  test(`callback ${sql}, prepared=${prepared}, nested=${nested}, cannot persist a partial write`, t => {
    const { db, path, store } = purchaseDatabase(t);
    const statement = prepared ? db.prepare(sql) : null;
    const body = () => {
      db.exec("INSERT INTO records VALUES ('TEST-partial')");
      assert.throws(() => prepared ? statement.run() : db.exec(sql), /statements in progress/);
      throw new Error('TEST-after-control');
    };
    assert.throws(() => store.transaction(db, () => nested ? store.transaction(db, body) : body()), /TEST-after-control/);
    assert.deepEqual(durableIds(db, path), []);
    store.transaction(db, () => db.exec("INSERT INTO records VALUES ('TEST-complete')"));
    assert.deepEqual(durableIds(db, path), ['TEST-complete']);
  });
}
test('nested entry after a swallowed outer rollback runs no callback and leaves a retryable connection', t => {
  const { db, path, store } = purchaseDatabase(t);
  db.exec("INSERT INTO records VALUES ('TEST-existing')");
  assert.throws(() => store.transaction(db, () => {
    assert.throws(() => db.exec("INSERT OR ROLLBACK INTO records VALUES ('TEST-existing')"), /UNIQUE/);
    assert.throws(() => store.transaction(db, callbackRan), { code: 'purchase_store_transaction_ended' });
  }), { code: 'purchase_store_transaction_ended' });
  store.transaction(db, () => db.exec("INSERT INTO records VALUES ('TEST-retry')"));
  assert.deepEqual(durableIds(db, path), ['TEST-existing', 'TEST-retry']);
});
test('a caught recoverable statement error still permits a complete commit', t => {
  const { db, path, store } = purchaseDatabase(t);
  db.exec("INSERT INTO records VALUES ('TEST-existing')");
  store.transaction(db, () => {
    db.exec("INSERT INTO records VALUES ('TEST-before')");
    assert.throws(() => db.exec("INSERT INTO records VALUES ('TEST-existing')"), /UNIQUE constraint/);
    db.exec("INSERT INTO records VALUES ('TEST-after')");
  });
  assert.deepEqual(durableIds(db, path), ['TEST-after', 'TEST-before', 'TEST-existing']);
});

test('a retained native exec cannot persist schema writes after a caught rollback', t => {
  const { db, path, store } = purchaseDatabase(t);
  db.exec("INSERT INTO records VALUES ('TEST-existing')");
  assert.throws(() => store.transaction(db, () => {
    assert.throws(() => db.exec("INSERT OR ROLLBACK INTO records VALUES ('TEST-existing')"), /UNIQUE/);
    assert.throws(() => nativeExec.call(db, 'CREATE TABLE escaped AS SELECT 1'), /readonly/);
  }), { code: 'purchase_store_transaction_ended' });
  const reopened = new DatabaseSync(path);
  try { assert.equal(reopened.prepare("SELECT count(*) n FROM sqlite_master WHERE name='escaped'").get().n, 0); }
  finally { reopened.close(); }
});
test('an SQL callback cannot run under a transaction or delete rows', t => {
  const { db, path, store } = purchaseDatabase(t);
  db.exec("CREATE TABLE search(body TEXT); INSERT INTO search VALUES ('TEST-retained')");
  let calls = 0;
  db.function('expire_and_write(', () => { calls++; nativeExec.call(db, 'ROLLBACK; DELETE FROM search'); return 1; });
  assert.throws(() => store.transaction(db, () => db.prepare('SELECT "expire_and_write("()').get()), /SQL callbacks/);
  assert.throws(() => store.transaction(db, () => db.prepare('SELECT * FROM pragma_table_list()').all()), /virtual tables/);
  assert.equal(calls, 0);
  const reopened = new DatabaseSync(path);
  try { assert.equal(reopened.prepare('SELECT count(*) n FROM search').get().n, 1); }
  finally { reopened.close(); }
});

test('BEGIN IMMEDIATE refuses a competing connection before its callback and permits retry', t => {
  const { db, path, store } = purchaseDatabase(t), second = new DatabaseSync(path);
  t.after(() => second.close());
  second.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL');
  store.transaction(db, () => {
    db.exec("INSERT INTO records VALUES ('TEST-first')");
    assert.throws(() => store.transaction(second, callbackRan), /locked/);
  });
  store.transaction(second, () => second.exec("INSERT INTO records VALUES ('TEST-retry')"));
  assert.deepEqual(durableIds(db, path), ['TEST-first', 'TEST-retry']);
});
test('a COMMIT blocked by a reader rolls back and a retry commits', t => {
  const { db, path, store } = purchaseDatabase(t, { journal: 'DELETE', synchronous: 'EXTRA', temp: 'DELETE' }), reader = new DatabaseSync(path);
  t.after(() => reader.close());
  db.exec("PRAGMA busy_timeout=0; INSERT INTO records VALUES ('TEST-existing')");
  const rows = reader.prepare('SELECT id FROM records').iterate();
  rows.next();
  assert.throws(() => store.transaction(db, () => db.exec("INSERT INTO records VALUES ('TEST-blocked')")), /locked|busy/i);
  assert.equal(inTransaction(db), false);
  rows.return();
  store.transaction(db, () => db.exec("INSERT INTO records VALUES ('TEST-retry')"));
  assert.deepEqual(durableIds(db, path), ['TEST-existing', 'TEST-retry']);
});
test('a deferred foreign-key failure at COMMIT rolls back and a retry commits', t => {
  const { db, path, store } = purchaseDatabase(t);
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE child (id TEXT REFERENCES records(id) DEFERRABLE INITIALLY DEFERRED)');
  assert.throws(() => store.transaction(db, () => db.exec("INSERT INTO child VALUES ('TEST-orphan')")), /FOREIGN KEY/);
  assert.equal(inTransaction(db), false);
  assert.deepEqual(durableIds(db, path, undefined, 'child'), []);
  store.transaction(db, () => db.exec("INSERT INTO child VALUES ('TEST-parent'); INSERT INTO records VALUES ('TEST-parent')"));
  assert.deepEqual(durableIds(db, path, undefined, 'child'), ['TEST-parent']);
});

test('schema refresh replaces renamed trigger targets without accumulating guards', t => {
  const { db, store } = purchaseDatabase(t);
  store.transaction(db, () => {});
  for (const suffix of ['one', 'two']) {
    db.exec(`ALTER TABLE records RENAME TO archived_${suffix}; CREATE TABLE records(id TEXT PRIMARY KEY)`);
    store.transaction(db, () => db.exec(`INSERT INTO records VALUES ('TEST-${suffix}')`));
    const triggers = db.prepare("SELECT tbl_name, count(*) n FROM temp.sqlite_master WHERE type='trigger' GROUP BY tbl_name").all();
    assert.equal(triggers.find(row => row.tbl_name === 'records')?.n, 3);
    assert.ok(triggers.every(row => row.n === 3));
  }
});
test('constructing the adapter tracks host statements before its first transaction', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    import { createSqlitePurchaseStore } from ${JSON.stringify(new URL('../src/seams/purchase-store-not-wired.mjs', import.meta.url).href)};
    const db = new DatabaseSync(':memory:'), store = createSqlitePurchaseStore();
    db.exec('CREATE TABLE records(id TEXT)');
    const write = db.prepare("INSERT INTO records VALUES ('TEST-cached')");
    store.transaction(db, () => write.run());
    if (db.prepare('SELECT count(*) n FROM records').get().n !== 1) throw Error('TEST-missing');
    db.close();
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

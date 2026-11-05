import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { sqliteWriteLease } from '../src/util/sqlite-write-lease.mjs';

function database(t, options) {
  const db = new DatabaseSync(':memory:', options);
  t.after(() => db.close());
  db.exec("CREATE TABLE records(id TEXT PRIMARY KEY); INSERT INTO records VALUES ('TEST-existing'); CREATE TEMP TABLE session(id TEXT); INSERT INTO session VALUES ('TEST-existing')");
  return db;
}
function begin(db, lease) {
  lease.arm(); db.exec('BEGIN IMMEDIATE'); lease.start();
}

for (const readBigInts of [false, true]) for (const returnArrays of [false, true]) {
  const options = { readBigInts, returnArrays }, label = JSON.stringify(options);
  test(`lease fingerprint acquisition, start and cache preserve caller results ${label}`, t => {
    const db = database(t, options), saved = db.prepare('SELECT 7 AS n'), expected = saved.get();
    const lease = sqliteWriteLease(db);
    assert.equal(sqliteWriteLease(db), lease);
    begin(db, lease); lease.check(); lease.disarm(); db.exec('COMMIT');
    assert.deepEqual(saved.get(), expected);
    assert.deepEqual(db.prepare('SELECT 7 AS n').get(), expected);
  });
  for (const action of ['INSERT', 'UPDATE', 'DELETE']) test(`lease table enumeration guards main and TEMP ${action} ${label}`, t => {
    const db = database(t, options), lease = sqliteWriteLease(db);
    begin(db, lease); db.exec('ROLLBACK');
    assert.equal(lease.present(), false);
    for (const table of ['main.records', 'temp.session']) {
      const sql = action === 'INSERT' ? `INSERT INTO ${table} VALUES ('TEST-after')`
        : action === 'UPDATE' ? `UPDATE ${table} SET id='TEST-after'` : `DELETE FROM ${table}`;
      assert.throws(() => db.exec(sql), /transaction ended/);
    }
    lease.disarm();
  });
  test(`lease schema refresh guards new main and TEMP tables ${label}`, t => {
    const db = database(t, options), lease = sqliteWriteLease(db);
    db.exec('CREATE TABLE added(id TEXT); CREATE TEMP TABLE added_session(id TEXT)');
    assert.equal(sqliteWriteLease(db), lease);
    begin(db, lease); db.exec('ROLLBACK');
    for (const table of ['main.added', 'temp.added_session']) {
      assert.throws(() => db.exec(`INSERT INTO ${table} VALUES ('TEST-after')`), /transaction ended/);
    }
    lease.disarm();
  });
  test(`lease commit barrier inspects completion independently of result shape ${label}`, t => {
    const db = database(t, options), lease = sqliteWriteLease(db);
    begin(db, lease);
    const barrier = lease.blockCommit();
    db.exec("INSERT INTO records VALUES ('TEST-kept')");
    assert.throws(() => db.exec('COMMIT'), /SQL statements in progress/);
    barrier.return(); lease.disarm(); db.exec('COMMIT');
    const statement = db.prepare('SELECT count(*) n FROM records');
    statement.setReturnArrays?.(false); statement.setReadBigInts(false);
    assert.equal(statement.get().n, 2);
  });
}

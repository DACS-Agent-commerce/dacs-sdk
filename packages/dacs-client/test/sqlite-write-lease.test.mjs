import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { sqliteWriteLease, retireSqliteHandle, isSqliteHandleRetired } from '../src/util/sqlite-write-lease.mjs';

function database(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE records (id TEXT PRIMARY KEY)');
  t.after(() => { try { db.close(); } catch {} });
  return db;
}
function begin(db, lease) {
  lease.arm();
  db.exec('BEGIN IMMEDIATE');
  lease.start();
}

test('a lease blocks commit until its private write iterator is finished', t => {
  const db = database(t), lease = sqliteWriteLease(db);
  begin(db, lease);
  const barrier = lease.blockCommit();
  db.exec("INSERT INTO records VALUES ('TEST-kept')");
  assert.throws(() => db.exec('COMMIT'), /SQL statements in progress/);
  assert.throws(() => db.prepare('END').run(), /SQL statements in progress/);
  lease.check();
  barrier.return();
  lease.disarm();
  db.exec('COMMIT');
  assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 1);
});

test('automatic rollback leaves the lease armed and prevents later table writes', t => {
  const db = database(t), lease = sqliteWriteLease(db);
  db.exec("INSERT INTO records VALUES ('TEST-existing')");
  const prepared = db.prepare('INSERT INTO records VALUES (?)');
  begin(db, lease);
  db.exec("INSERT INTO records VALUES ('TEST-before')");
  assert.throws(() => db.exec("INSERT OR ROLLBACK INTO records VALUES ('TEST-existing')"), /UNIQUE/);
  assert.equal(lease.present(), false);
  assert.throws(() => prepared.run('TEST-after'), /transaction ended/);
  assert.throws(() => lease.check());
  lease.disarm();
  prepared.run('TEST-outside');
  assert.deepEqual(db.prepare('SELECT id FROM records ORDER BY id').all().map(row => row.id), ['TEST-existing', 'TEST-outside']);
});

for (const ddl of ['CREATE TABLE added (id TEXT)', 'ALTER TABLE records RENAME TO renamed; CREATE TABLE records (id TEXT PRIMARY KEY)']) {
  test(`schema refresh protects new table bindings: ${ddl}`, t => {
    const db = database(t), lease = sqliteWriteLease(db);
    db.exec(ddl);
    assert.equal(sqliteWriteLease(db), lease);
    begin(db, lease);
    db.exec('ROLLBACK');
    const table = ddl.startsWith('CREATE') ? 'added' : 'records';
    assert.throws(() => db.exec(`INSERT INTO ${table} VALUES ('TEST-after')`), /transaction ended/);
    lease.disarm();
    assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  });
}

test('unchanged schemas reuse the same lease and triggers', t => {
  const db = database(t), lease = sqliteWriteLease(db);
  const triggers = () => db.prepare("SELECT name FROM temp.sqlite_master WHERE type='trigger' ORDER BY name").all();
  const before = triggers();
  assert.equal(before.length, 3);
  for (let i = 0; i < 3; i++) assert.equal(sqliteWriteLease(db), lease);
  assert.deepEqual(triggers(), before);
});

test('a rollback of lease creation rebuilds its temporary marker on retry', t => {
  const db = database(t);
  db.exec('BEGIN');
  const lease = sqliteWriteLease(db);
  db.exec('ROLLBACK');
  assert.equal(lease.exists(), false);
  assert.equal(sqliteWriteLease(db), lease);
  begin(db, lease);
  lease.check();
  lease.disarm();
  db.exec('COMMIT');
});

test('retirement survives reopening the same connection object', t => {
  const db = database(t), lease = sqliteWriteLease(db);
  assert.equal(isSqliteHandleRetired(db), false);
  begin(db, lease);
  retireSqliteHandle(db);
  assert.equal(isSqliteHandleRetired(db), true);
  assert.equal(lease.present(), false);
  db.open();
  assert.equal(isSqliteHandleRetired(db), true);
  assert.equal(lease.present(), false);
});

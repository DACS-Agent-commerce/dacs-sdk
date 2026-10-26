import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// Execute a rival connection at a precise native enumeration boundary,
// without sleeps or depending on worker scheduling.
class InterleavedDatabase extends DatabaseSync {
  afterTableList;
  afterTrigger;
  exec(sql) {
    super.exec(sql);
    if (sql.startsWith('CREATE TEMP TRIGGER')) this.afterTrigger?.();
  }
  prepare(sql) {
    const statement = super.prepare(sql);
    if (sql === 'PRAGMA table_list') {
      const all = statement.all;
      statement.all = (...args) => {
        const rows = all.apply(statement, args);
        const after = this.afterTableList;
        this.afterTableList = undefined;
        after?.();
        return rows;
      };
    }
    return statement;
  }
}

const triggerNames = db => db.prepare("SELECT name FROM temp.sqlite_master WHERE type='trigger' ORDER BY name").all();

test('interrupted refresh restores its triggers and preserves the caller transaction', t => {
  const db = new InterleavedDatabase(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE records (id TEXT)');
  const lease = sqliteWriteLease(db), before = triggerNames(db);
  db.exec("BEGIN; INSERT INTO records VALUES ('TEST-parent'); CREATE TABLE added (id TEXT)");
  const failure = new Error('TEST-refresh-interrupted');
  db.afterTrigger = () => { throw failure; };
  assert.throws(() => sqliteWriteLease(db), error => error === failure);
  db.afterTrigger = undefined;
  assert.deepEqual(triggerNames(db), before);
  assert.equal(sqliteWriteLease(db), lease);
  db.exec('COMMIT');
  assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 1);
  begin(db, lease);
  db.exec('ROLLBACK');
  assert.throws(() => db.exec("INSERT INTO added VALUES ('TEST-after')"), /transaction ended/);
  lease.disarm();
});

test('caller rollback cannot leave an untracked trigger generation on retry', t => {
  const db = database(t), lease = sqliteWriteLease(db);
  const before = triggerNames(db);
  db.exec('BEGIN; CREATE TEMP TABLE transient (id TEXT)');
  assert.equal(sqliteWriteLease(db), lease);
  db.exec('ROLLBACK');
  assert.equal(sqliteWriteLease(db), lease);
  assert.deepEqual(triggerNames(db), before);
});

for (const schema of ['main', 'other']) {
  test(`concurrent ${schema} schema creation is covered on reacquisition`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlite-lease-schema-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'records.sqlite');
    const rival = new DatabaseSync(file);
    const db = new InterleavedDatabase(schema === 'main' ? file : ':memory:');
    t.after(() => { db.close(); rival.close(); });
    rival.exec('PRAGMA journal_mode=WAL; CREATE TABLE records (id TEXT)');
    if (schema === 'other') db.prepare('ATTACH DATABASE ? AS other').run(file);
    db.afterTableList = () => rival.exec('CREATE TABLE added_by_other_run (id TEXT)');
    const lease = sqliteWriteLease(db);
    assert.equal(sqliteWriteLease(db), lease);
    const prepared = db.prepare(`INSERT INTO ${schema}.added_by_other_run VALUES ('TEST-after')`);
    begin(db, lease);
    const barrier = lease.blockCommit();
    db.exec('ROLLBACK');
    assert.equal(lease.present(), false);
    assert.throws(() => prepared.run(), /transaction ended/);
    barrier.return();
    lease.disarm();
    assert.equal(rival.prepare('SELECT count(*) n FROM added_by_other_run').get().n, 0);
  });
}

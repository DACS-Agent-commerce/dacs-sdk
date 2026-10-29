import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqliteWriteLease, retireSqliteHandle, isSqliteHandleRetired } from '../src/util/sqlite-write-lease.mjs';
import { collectGarbage } from './helpers/collect-garbage.mjs';

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

test('a lease keeps its commit barrier usable across garbage collections', t => {
  const db = database(t), lease = sqliteWriteLease(db);
  begin(db, lease);
  const barrier = lease.blockCommit();
  collectGarbage();
  assert.throws(() => db.exec('COMMIT'), /SQL statements in progress/);
  collectGarbage();
  barrier.return();
  lease.disarm();
  db.exec('COMMIT');
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

test('refused initial acquisition leaves no temporary marker in the caller transaction', t => {
  const db = database(t);
  db.exec('BEGIN');
  assert.throws(() => sqliteWriteLease(db), /within a transaction/);
  assert.deepEqual(db.prepare('SELECT name FROM temp.sqlite_master').all(), []);
  db.exec('ROLLBACK');
  const lease = sqliteWriteLease(db);
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
  beforeRollback;
  exec(sql) {
    if (sql === 'ROLLBACK') this.beforeRollback?.();
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

test('interrupted installation restores its committed trigger generation on retry', t => {
  const db = new InterleavedDatabase(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE records (id TEXT)');
  const lease = sqliteWriteLease(db), before = triggerNames(db);
  db.exec("INSERT INTO records VALUES ('TEST-parent'); CREATE TABLE added (id TEXT)");
  const failure = new Error('TEST-refresh-interrupted');
  db.afterTrigger = () => { throw failure; };
  assert.throws(() => sqliteWriteLease(db), error => error === failure);
  db.afterTrigger = undefined;
  assert.deepEqual(triggerNames(db), before);
  assert.equal(sqliteWriteLease(db), lease);
  assert.doesNotThrow(() => db.exec('BEGIN IMMEDIATE; ROLLBACK'));
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
  assert.throws(() => sqliteWriteLease(db), /within a transaction/);
  db.exec('ROLLBACK');
  assert.equal(sqliteWriteLease(db), lease);
  assert.deepEqual(triggerNames(db), before);
});

test('concurrent schema creation is covered on reacquisition', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sqlite-lease-schema-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'records.sqlite');
  const rival = new DatabaseSync(file);
  const db = new InterleavedDatabase(file);
  t.after(() => { db.close(); rival.close(); });
  rival.exec('PRAGMA journal_mode=WAL; CREATE TABLE records (id TEXT)');
  db.afterTableList = () => assert.throws(() => rival.exec('CREATE TABLE added_by_other_run (id TEXT)'), /locked/);
  const lease = sqliteWriteLease(db);
  rival.exec('CREATE TABLE added_by_other_run (id TEXT)');
  assert.equal(sqliteWriteLease(db), lease);
  const prepared = db.prepare("INSERT INTO added_by_other_run VALUES ('TEST-after')");
  begin(db, lease);
  const barrier = lease.blockCommit();
  db.exec('ROLLBACK');
  assert.equal(lease.present(), false);
  assert.throws(() => prepared.run(), /transaction ended/);
  barrier.return();
  lease.disarm();
  assert.equal(rival.prepare('SELECT count(*) n FROM added_by_other_run').get().n, 0);
});

for (const timing of ['during enumeration', 'after acquisition']) {
  test(`schema changes ${timing} require a fresh committed generation`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlite-lease-generation-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'records.sqlite'), rival = new DatabaseSync(file);
    const db = new InterleavedDatabase(file);
    t.after(() => { db.close(); rival.close(); });
    rival.exec('PRAGMA journal_mode=WAL; CREATE TABLE records (id TEXT)');
      let created = false, locked = false;
    const create = () => { rival.exec('CREATE TABLE during_refresh (id TEXT)'); created = true; };
    if (timing === 'during enumeration') db.afterTableList = () => {
      try { create(); } catch (error) { assert.match(error.message, /locked/); locked = true; }
    };
    const lease = sqliteWriteLease(db);
    if (!created) create();
    lease.arm();
    db.exec('BEGIN IMMEDIATE');
    assert.throws(() => lease.start(), { name: 'OperationError', code: 'purchase_store_schema_changed' });
    assert.equal(lease.present(), false);
    db.exec('ROLLBACK');
    lease.disarm();
    if (timing === 'during enumeration') assert.equal(locked, true);
    assert.equal(sqliteWriteLease(db), lease);
    const prepared = db.prepare("INSERT INTO during_refresh VALUES ('TEST-after')");
    begin(db, lease);
    const barrier = lease.blockCommit();
    db.exec('ROLLBACK');
    assert.equal(lease.present(), false);
    assert.throws(() => prepared.run(), /transaction ended/);
    barrier.return();
    lease.disarm();
    assert.equal(rival.prepare('SELECT count(*) n FROM during_refresh').get().n, 0);
  });
}

test('new and cached acquisitions refuse enclosing transactions without changing their work', t => {
  const db = database(t);
  for (const cached of [false, true]) {
    if (cached) sqliteWriteLease(db);
    const before = db.prepare('SELECT name FROM temp.sqlite_master ORDER BY name').all();
    db.exec("BEGIN; INSERT INTO records VALUES ('TEST-host')");
    assert.throws(() => sqliteWriteLease(db), /within a transaction/);
    assert.deepEqual(db.prepare('SELECT name FROM temp.sqlite_master ORDER BY name').all(), before);
    db.exec('COMMIT');
    assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 1);
    db.exec('DELETE FROM records');
  }
});

test('an interrupted first installation rolls back all temporary objects before retry', t => {
  const db = new InterleavedDatabase(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE records (id TEXT)');
  const failure = new Error('TEST-first-install-interrupted');
  db.afterTrigger = () => { throw failure; };
  assert.throws(() => sqliteWriteLease(db), error => error === failure);
  assert.deepEqual(db.prepare('SELECT name FROM temp.sqlite_master').all(), []);
  db.afterTrigger = undefined;
  const lease = sqliteWriteLease(db);
  begin(db, lease);
  db.exec('ROLLBACK');
  assert.throws(() => db.exec("INSERT INTO records VALUES ('TEST-after')"), /transaction ended/);
  lease.disarm();
});

test('an installation recovery failure preserves its cause and retires the handle', t => {
  const db = new InterleavedDatabase(':memory:');
  t.after(() => { try { db.close(); } catch {} });
  db.exec('CREATE TABLE records (id TEXT)');
  const failure = new Error('TEST-install-interrupted');
  db.afterTrigger = () => { throw failure; };
  db.beforeRollback = () => { throw new Error('TEST-recovery-interrupted'); };
  assert.throws(() => sqliteWriteLease(db), error => error === failure);
  assert.equal(isSqliteHandleRetired(db), true);
  assert.throws(() => db.prepare('SELECT 1'), /not open/);
});

test('attached databases are refused before installing any temporary guards', t => {
  const db = database(t);
  db.exec("ATTACH ':memory:' AS other; CREATE TABLE other.records (id TEXT)");
  assert.throws(() => sqliteWriteLease(db), { name: 'OperationError', code: 'purchase_store_unsupported_attachment' });
  assert.deepEqual(db.prepare('SELECT name FROM temp.sqlite_master').all(), []);
  db.exec("INSERT INTO other.records VALUES ('TEST-host')");
});

test('an attachment added after acquisition cannot start a lease', t => {
  const db = database(t), lease = sqliteWriteLease(db);
  db.exec("ATTACH ':memory:' AS other; CREATE TABLE other.records (id TEXT)");
  lease.arm();
  db.exec('BEGIN IMMEDIATE');
  assert.throws(() => lease.start(), { name: 'OperationError', code: 'purchase_store_unsupported_attachment' });
  db.exec('ROLLBACK');
  lease.disarm();
});

for (const point of ['installation', 'body']) {
  test(`a crash during ${point} leaves no committed body or persistent guards`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlite-lease-crash-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'records.sqlite'), setup = new DatabaseSync(file);
    setup.exec('PRAGMA journal_mode=WAL; CREATE TABLE records (id TEXT)');
    setup.close();
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      const { sqliteWriteLease } = await import(process.argv[2]);
      class CrashDatabase extends DatabaseSync {
        exec(sql) {
          super.exec(sql);
          if (process.argv[3] === 'installation' && sql.startsWith('CREATE TEMP TRIGGER')) process.kill(process.pid, 'SIGKILL');
        }
      }
      const db = new CrashDatabase(process.argv[1]), lease = sqliteWriteLease(db);
      lease.arm(); db.exec('BEGIN IMMEDIATE'); lease.start();
      db.exec("INSERT INTO records VALUES ('TEST-uncommitted')");
      process.kill(process.pid, 'SIGKILL');
    `, file, new URL('../src/util/sqlite-write-lease.mjs', import.meta.url).href, point], { encoding: 'utf8' });
    assert.equal(result.signal, 'SIGKILL', result.stderr);
    const db = new DatabaseSync(file);
    t.after(() => db.close());
    assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 0);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all(), []);
    db.exec("INSERT INTO records VALUES ('TEST-reopened')");
    const lease = sqliteWriteLease(db);
    begin(db, lease);
    lease.check();
    lease.disarm();
    db.exec('COMMIT');
  });
}

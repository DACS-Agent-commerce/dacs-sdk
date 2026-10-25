import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { withSqliteStatementGuard } from '../src/util/sqlite-statement-boundary.mjs';
import { isSqliteHandleRetired } from '../src/util/sqlite-write-lease.mjs';

for (const kind of ['async', 'generator', 'async generator']) {
  test(`the statement boundary refuses a declared ${kind} body before entry`, () => {
    const db = new DatabaseSync(':memory:');
    let entered = false;
    const body = {
      async: async () => { entered = true; },
      generator: function* () { entered = true; },
      'async generator': async function* () { entered = true; },
    }[kind];
    try {
      assert.throws(() => withSqliteStatementGuard(db, () => {}, body), /synchronous function/);
      assert.equal(entered, false);
      assert.equal(db.prepare('PRAGMA query_only').get().query_only, 0);
      assert.equal(isSqliteHandleRetired(db), false);
    } finally { db.close(); }
  });
  test(`the statement boundary refuses a declared ${kind} predicate before entry`, () => {
    const db = new DatabaseSync(':memory:');
    let entered = false;
    const predicate = {
      async: async () => { entered = true; },
      generator: function* () { entered = true; },
      'async generator': async function* () { entered = true; },
    }[kind];
    try {
      assert.throws(() => withSqliteStatementGuard(db, predicate, () => {}), /synchronous function/);
      assert.equal(entered, false);
    } finally { db.close(); }
  });
}

test('a promise-returning predicate is refused before the guarded body runs', () => {
  const db = new DatabaseSync(':memory:');
  let entered = false;
  try {
    assert.throws(() => withSqliteStatementGuard(db, () => Promise.resolve(), () => { entered = true; }), /synchronous result/);
    assert.equal(entered, false);
    assert.equal(isSqliteHandleRetired(db), true);
  } finally { try { db.close(); } catch {} }
});

test('a returned promise retires the connection before a retained writer resumes and leaves no writes on reopen', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'statement-boundary-'));
  const path = join(dir, 'store.sqlite');
  const db = new DatabaseSync(path);
  t.after(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  db.exec('CREATE TABLE records(id TEXT); BEGIN');
  const writer = db.prepare("INSERT INTO records VALUES ('TEST-late')");
  let continuation, refusal, lateError;
  try {
    withSqliteStatementGuard(db, () => {}, () => {
      db.exec("INSERT INTO records VALUES ('TEST-pending')");
      continuation = Promise.resolve().then(() => {
        try { writer.run(); } catch (error) { lateError = error; }
      });
      return continuation;
    });
  } catch (error) { refusal = error; }
  await continuation;
  assert.match(refusal?.message ?? '', /synchronous result/);
  assert.equal(isSqliteHandleRetired(db), true);
  assert.ok(lateError, 'the retained writer must not run after the guard returns');
  const reopened = new DatabaseSync(path);
  try { assert.equal(reopened.prepare('SELECT count(*) n FROM records').get().n, 0); }
  finally { reopened.close(); }
  db.open();
  assert.throws(() => withSqliteStatementGuard(db, () => {}, () => {}), /retired/);
});

test('a thenable result in a nested guard retires the shared connection', () => {
  const db = new DatabaseSync(':memory:');
  try {
    withSqliteStatementGuard(db, () => {}, () => {
      assert.throws(() => withSqliteStatementGuard(db, () => {}, () => ({ then() {} })), /synchronous result/);
      assert.equal(isSqliteHandleRetired(db), true);
      assert.throws(() => db.exec('CREATE TABLE escaped(id)'), /closed|not open|retired/i);
    });
  } finally { try { db.close(); } catch {} }
});

function isolated(source) {
  const boundary = new URL('../src/util/sqlite-statement-boundary.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { DatabaseSync } from 'node:sqlite';
    import { withSqliteStatementGuard } from ${JSON.stringify(boundary)};
    const nativeExec = DatabaseSync.prototype.exec;
    const nativePrepare = DatabaseSync.prototype.prepare;
    const db = new DatabaseSync(':memory:');
    const nativeRun = Object.getPrototypeOf(nativePrepare.call(db, 'SELECT 1')).run;
    ${source}
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test('pre-installation statements and iterators cannot call an indistinguishable bundled-function override', () => {
  isolated(`
    const other = new DatabaseSync(':memory:');
    other.exec('CREATE TABLE records(id)');
    let calls = 0;
    db.function('rtreenode', (a, b) => {
      calls++;
      nativeExec.call(other, "INSERT INTO records VALUES ('TEST-escaped')");
      return a + b;
    });
    const statement = nativePrepare.call(db, 'SELECT rtreenode(1, 2) AS value');
    const iterator = statement.iterate();
    try {
      withSqliteStatementGuard(db, () => {}, () => {
        for (const method of ['run', 'get', 'all', 'iterate']) {
          assert.throws(() => statement[method](), /SQL callbacks/);
        }
        assert.throws(() => iterator.next(), /SQL callbacks/);
      });
      assert.equal(calls, 0);
      assert.equal(other.prepare('SELECT count(*) n FROM records').get().n, 0);
    } finally { iterator.return(); db.close(); other.close(); }
  `);
});

for (const sql of ["SELECT * FROM pragma_integrity_check('checked')", "SELECT * FROM pragma_quick_check('checked')", 'ALTER TABLE checked ADD COLUMN y CHECK (rtreenode(y, 0))']) {
  test(`pre-installation bundled-function collisions cannot run through virtual-table programs: ${sql}`, () => {
    isolated(`
      db.exec('CREATE TABLE records(id TEXT PRIMARY KEY)');
      const write = nativePrepare.call(db, "INSERT INTO records VALUES ('TEST-escaped')");
      let armed = false, calls = 0;
      db.function('rtreenode', (a, b) => {
        if (armed) {
          calls++;
          try { nativeExec.call(db, "INSERT OR ROLLBACK INTO records VALUES ('TEST-existing')"); } catch {}
          nativeRun.call(write);
        }
        return 1;
      });
      db.exec("CREATE TABLE checked(x CHECK (rtreenode(x, 0))); INSERT INTO checked VALUES (1); INSERT INTO records VALUES ('TEST-existing'); BEGIN; CREATE TEMP TABLE test_live(id)");
      armed = true;
      try {
        withSqliteStatementGuard(db, () => {
          assert.ok(db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name='test_live'").get());
        }, () => assert.throws(() => db.prepare(${JSON.stringify(sql)}).all(), /SQL callbacks/));
        assert.equal(calls, 0);
        assert.equal(db.prepare("SELECT count(*) n FROM records WHERE id='TEST-escaped'").get().n, 0);
      } finally { db.close(); }
    `);
  });
}

test('a rejected promise result is observed after the connection is retired', () => {
  isolated(`
    assert.throws(() => withSqliteStatementGuard(db, () => {}, () => Promise.reject(new Error('TEST-rejected'))), /synchronous result/);
  `);
});

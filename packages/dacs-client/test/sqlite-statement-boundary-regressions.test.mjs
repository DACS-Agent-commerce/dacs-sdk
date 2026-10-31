import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { withSqliteStatementGuard } from '../src/util/sqlite-statement-boundary.mjs';
import { isSqliteHandleRetired } from '../src/util/sqlite-write-lease.mjs';
const nativeExec = DatabaseSync.prototype.exec;
const nativePrepare = DatabaseSync.prototype.prepare;
const policyProbe = new DatabaseSync(':memory:');
const nativeGet = Object.getPrototypeOf(policyProbe.prepare('SELECT 1')).get;
policyProbe.close();
const policy = db => nativeGet.call(nativePrepare.call(db, 'PRAGMA query_only')).query_only;

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
      assert.equal(policy(db), 0);
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
  const result = spawnSync(process.execPath, [...process.execArgv, '--input-type=module', '-e', `
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

for (const callback of ['body', 'predicate']) for (const kind of ['masked promise', 'throwing promise getter', 'throwing thenable getter']) {
  test(`${callback} result retirement precedes retained writes for a ${kind}`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'statement-result-'));
    const path = join(dir, 'store.sqlite');
    const db = new DatabaseSync(path);
    t.after(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
    db.exec("CREATE TABLE records(id TEXT); BEGIN; INSERT INTO records VALUES ('TEST-pending')");
    const writer = db.prepare("INSERT INTO records VALUES ('TEST-late')");
    let continuation, lateError, refusal, entered = false, reads = 0;
    const deferred = () => {
      continuation = Promise.resolve().then(() => {
        try { writer.run(); } catch (error) { lateError = error; }
      });
      const result = kind === 'throwing thenable getter' ? {} : continuation;
      Object.defineProperty(result, 'then', kind === 'masked promise' ? { value: undefined } : {
        get() { reads++; throw cause; },
      });
      return result;
    };
    try {
      withSqliteStatementGuard(db, callback === 'predicate' ? deferred : () => {}, () => {
        entered = true;
        return callback === 'body' ? deferred() : undefined;
      });
    } catch (error) { refusal = error; }
    // A transaction caller rolls back after refusal, before queued work resumes.
    try { db.exec('ROLLBACK'); } catch { /* Retirement has already rolled back and closed. */ }
    await continuation;
    assert.match(refusal?.message ?? '', /synchronous result/);
    assert.equal(reads, 0);
    assert.equal(entered, callback === 'body');
    assert.equal(isSqliteHandleRetired(db), true);
    assert.ok(lateError, 'a retained writer must fail before it can autocommit');
    const reopened = new DatabaseSync(path);
    try { assert.equal(reopened.prepare('SELECT count(*) n FROM records').get().n, 0); }
    finally { reopened.close(); }
  });
}

for (const sql of [
  'PRAGMA query_only=OFF',
  '/* TEST-policy */ PRAGMA main."QuErY_OnLy" (FALSE)',
  "-- TEST-policy\n PRAGMA [query_only]='unknown'",
]) {
  test(`guarded exec refuses clearing the saved read-only policy before a batch writes: ${sql}`, t => {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    db.exec('CREATE TABLE records(id)');
    withSqliteStatementGuard(db, () => {}, () => {
      assert.throws(() => db.exec(`${sql}; INSERT INTO records VALUES ('TEST-late')`), /read-only policy/);
      assert.equal(policy(db), 1);
      assert.throws(() => nativeExec.call(db, "INSERT INTO records VALUES ('TEST-after')"), /readonly/);
    });
    assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 0);
    assert.equal(policy(db), 0);
  });
}

test('preparing SQL cannot leave either a writable or a read-only guard fence open', t => {
  for (const saved of [0, 1]) {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    db.exec(`CREATE TABLE records(id); PRAGMA query_only=${saved}`);
    if (saved) {
      assert.throws(() => withSqliteStatementGuard(db, () => {}, () => {}), /read-only policy/);
      assert.equal(policy(db), 1);
      continue;
    }
    withSqliteStatementGuard(db, () => {}, () => {
      withSqliteStatementGuard(db, () => {}, () => {
        assert.throws(() => db.prepare('PRAGMA temp.`query_only`=0'), /read-only policy/);
        assert.throws(() => nativeExec.call(db, "INSERT INTO records VALUES ('TEST-captured')"), /readonly/);
        db.prepare('PRAGMA query_only=ON').run();
        assert.equal(db.prepare('SELECT 1 AS value').get().value, 1);
      });
      assert.throws(() => nativeExec.call(db, "INSERT INTO records VALUES ('TEST-outer')"), /readonly/);
    });
    assert.equal(policy(db), saved);
    db.exec('PRAGMA query_only=OFF');
    assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 0);
  }
});

for (const method of ['run', 'get', 'all', 'iterate', 'next']) {
  test(`an earlier prepared pragma cannot clear a read-only guard during ${method}`, t => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE records(id)');
    // Install ownership tracking before preparing a setter outside a guard.
    withSqliteStatementGuard(db, () => {}, () => {});
    const clear = db.prepare('PRAGMA query_only=OFF');
    const iterator = method === 'next' ? clear.iterate() : undefined;
    t.after(() => { iterator?.return(); db.close(); });
    withSqliteStatementGuard(db, () => {}, () => {
      assert.throws(() => method === 'next' ? iterator.next() : clear[method](), /read-only policy/);
      assert.equal(policy(db), 1);
      assert.throws(() => nativeExec.call(db, "INSERT INTO records VALUES ('TEST-late')"), /readonly/);
    });
    assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 0);
    assert.equal(policy(db), 0);
  });
}

for (const role of ['body', 'predicate']) for (const kind of ['async', 'generator', 'async generator']) {
  for (const bound of [false, true]) test(`${role} rejects spoofed ${kind}, bound=${bound}`, () => {
    const db = new DatabaseSync(':memory:');
    const callback = { async: async () => {}, generator: function* () {}, 'async generator': async function* () {} }[kind];
    const candidate = bound ? callback.bind(null) : callback;
    Object.defineProperty(candidate, Symbol.toStringTag, { value: 'Function' });
    try {
      assert.throws(() => withSqliteStatementGuard(db, role === 'predicate' ? candidate : () => {}, role === 'body' ? candidate : () => {}), /synchronous/);
      assert.equal(isSqliteHandleRetired(db), bound);
    } finally { try { db.close(); } catch {} }
  });
}
for (const role of ['body', 'predicate']) for (const kind of ['object', 'number', 'generator', 'async generator', 'cross-realm promise']) {
  test(`${role} retires before using a returned ${kind}`, async () => {
    const { runInNewContext } = await import('node:vm');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE records(id)');
    const writer = db.prepare('INSERT INTO records VALUES (1)');
    const result = {
      object: () => ({}), number: () => 1,
      generator: () => (function* () { writer.run(); })(),
      'async generator': () => (async function* () { writer.run(); })(),
      'cross-realm promise': () => runInNewContext('Promise.reject(new Error("TEST-rejected"))'),
    }[kind]();
    try {
      assert.throws(() => withSqliteStatementGuard(db, role === 'predicate' ? () => result : () => {}, role === 'body' ? () => result : () => {}), /synchronous result/);
      assert.equal(isSqliteHandleRetired(db), true);
      if (kind === 'generator' || kind === 'async generator') await assert.rejects(async () => result.next(), /closed|not open|finalized/i);
      assert.throws(() => writer.run(), /closed|not open|finalized/i);
    } finally { try { db.close(); } catch {} }
  });
}
test('failure to reclose a granted fence records permanent retirement', () => {
  isolated(`
    const { isSqliteHandleRetired } = await import(new URL('./sqlite-write-lease.mjs', ${JSON.stringify(new URL('../src/util/sqlite-statement-boundary.mjs', import.meta.url).href)}));
    let granted = false;
    DatabaseSync.prototype.exec = function(sql) {
      if (sql === 'PRAGMA query_only=OFF') granted = true;
      if (granted && sql === 'PRAGMA query_only=ON') throw new Error('TEST-reclose');
      return nativeExec.call(this, sql);
    };
    withSqliteStatementGuard(db, () => {}, () => { db.prepare('SELECT 1').get(); });
    assert.equal(isSqliteHandleRetired(db), true);
  `);
});

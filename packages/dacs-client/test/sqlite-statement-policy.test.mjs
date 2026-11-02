import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { withSqliteStatementGuard } from '../src/util/sqlite-statement-boundary.mjs';

const nativeExec = DatabaseSync.prototype.exec;
const nativePrepare = DatabaseSync.prototype.prepare;
const probe = new DatabaseSync(':memory:');
const nativeGet = Object.getPrototypeOf(probe.prepare('SELECT 1')).get;
probe.close();
function metadata(db, sql) {
  const statement = nativePrepare.call(db, sql);
  statement.setReturnArrays?.(false); statement.setReadBigInts?.(false);
  return nativeGet.call(statement);
}
const policy = db => metadata(db, 'PRAGMA query_only').query_only;
const count = db => metadata(db, 'SELECT count(*) n FROM records').n;

for (const readBigInts of [false, true]) for (const returnArrays of [false, true]) {
  const options = { readBigInts, returnArrays }, label = JSON.stringify(options);
  function world(t) {
    const db = new DatabaseSync(':memory:', options);
    t.after(() => db.close());
    db.exec('CREATE TABLE records(id TEXT)');
    withSqliteStatementGuard(db, () => {}, () => {});
    return db;
  }
  test(`empty, nested and throwing guards preserve caller defaults ${label}`, t => {
    const db = world(t), saved = db.prepare('SELECT 7 AS n'), before = saved.get(), cause = Error('TEST-body');
    for (const nested of [false, true]) {
      const body = () => { assert.equal(policy(db), 1); };
      withSqliteStatementGuard(db, () => {}, () => { if (nested) withSqliteStatementGuard(db, () => {}, body); else body(); });
      assert.throws(() => withSqliteStatementGuard(db, () => {}, () => { throw cause; }), error => error === cause);
      assert.equal(policy(db), 0);
      assert.deepEqual(saved.get(), before);
      assert.deepEqual(db.prepare('SELECT 7 AS n').get(), before);
    }
  });
  test(`read-only entry is refused without changing policy ${label}`, t => {
    const db = world(t); db.exec('PRAGMA query_only=ON');
    let calls = 0;
    assert.throws(() => withSqliteStatementGuard(db, () => { calls++; }, () => { calls++; }), /read-only policy/);
    assert.equal(calls, 0); assert.equal(policy(db), 1);
    assert.throws(() => nativeExec.call(db, 'INSERT INTO records VALUES (1)'), /readonly/);
  });
  for (const method of ['exec', 'run', 'get', 'all', 'iterate', 'next']) {
    test(`nested ${method} grants reclose before captured writers ${label}`, t => {
      const db = world(t), statement = db.prepare("INSERT INTO records VALUES ('TEST-guarded') RETURNING id");
      const earlier = method === 'next' ? statement.iterate() : undefined;
      db.exec('BEGIN');
      try {
        withSqliteStatementGuard(db, () => {}, () => {
          withSqliteStatementGuard(db, () => {}, () => {
            if (method === 'exec') db.exec(statement.sourceSQL);
            else if (method === 'next' || method === 'iterate') {
              const iterator = earlier ?? statement.iterate();
              try { assert.equal(iterator.next().done, false); } finally { iterator.return(); }
            } else statement[method]();
            assert.equal(policy(db), 1);
            assert.throws(() => nativeExec.call(db, 'INSERT INTO records VALUES (2)'), /readonly/);
          });
          assert.equal(policy(db), 1);
        });
        db.exec('COMMIT'); assert.equal(policy(db), 0); assert.equal(count(db), 1);
      } finally { earlier?.return(); }
    });
  }
  for (const sql of ['PRAGMA query_only=OFF', 'EXPLAIN PRAGMA query_only=OFF', '/* TEST */ PRAGMA main."QuErY_OnLy" (FALSE)']) {
    for (const method of ['prepare', 'batch']) test(`${method} refuses policy setter ${sql} ${label}`, t => {
      const db = world(t);
      withSqliteStatementGuard(db, () => {}, () => {
        assert.throws(() => method === 'prepare' ? db.prepare(sql) : db.exec(`SELECT 1; ${sql}; INSERT INTO records VALUES (1)`), /read-only policy/);
        assert.equal(policy(db), 1);
        assert.throws(() => nativeExec.call(db, 'INSERT INTO records VALUES (2)'), /readonly/);
      });
      assert.equal(count(db), 0); assert.equal(policy(db), 0);
    });
  }
  for (const kind of ['application', 'builtin override', 'bundled override', 'trigger']) test(`function refusal for ${kind} ${label}`, t => {
    const db = world(t); let calls = 0;
    const name = kind === 'bundled override' ? 'rtreenode' : kind === 'builtin override' ? 'abs' : 'TEST_callback';
    db.function(name, () => { calls++; return 1; });
    if (kind === 'trigger') db.exec(`CREATE TRIGGER test_callback AFTER INSERT ON records BEGIN SELECT ${name}(); END`);
    withSqliteStatementGuard(db, () => {}, () => {
      assert.throws(() => db.prepare(kind === 'trigger' ? 'INSERT INTO records VALUES (1)' : `SELECT ${name}()`).get(), /SQL callbacks/);
    });
    assert.equal(calls, 0); assert.equal(count(db), 0);
  });
  for (const sql of ['EXPLAIN SELECT 1', '/* TEST */ EXPLAIN QUERY PLAN SELECT * FROM records']) test(`explicit EXPLAIN gets guard error ${label} ${sql}`, t => {
    const db = world(t);
    withSqliteStatementGuard(db, () => {}, () => { assert.throws(() => db.prepare(sql).all(), /statement guard/); });
  });
}

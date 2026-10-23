import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { withSqliteStatementGuard } from '../src/util/guarded-sqlite.mjs';

function world(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE records(id TEXT PRIMARY KEY)');
  t.after(() => db.close());
  return db;
}
test('an inactive capability preserves native exec including comments and trigger bodies', t => {
  const db = world(t);
  db.exec("CREATE TRIGGER fill AFTER INSERT ON records BEGIN UPDATE records SET id=id || '-trigger'; END; INSERT INTO records VALUES ('TEST'); -- tail");
  assert.equal(db.prepare('SELECT id FROM records').get().id, 'TEST-trigger');
});
for (const method of ['run', 'get', 'all', 'iterate']) {
  test(`guard checks earlier prepared ${method} executions and iterator advancement`, t => {
    const db = world(t), statement = db.prepare('INSERT INTO records VALUES (?) RETURNING id');
    let live = true, checks = 0;
    withSqliteStatementGuard(db, () => { checks++; if (!live) throw new Error('TEST-ended'); }, () => {
      if (method === 'iterate') {
        const iterator = statement.iterate('TEST');
        live = false;
        assert.throws(() => iterator.next(), /TEST-ended/);
        iterator.return();
      } else {
        live = false;
        assert.throws(() => statement[method]('TEST'), /TEST-ended/);
      }
    });
    assert.ok(checks > 0);
    assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 0);
  });
}
test('each statement in exec is checked after rollback before CTAS can autocommit', t => {
  const db = world(t);
  db.exec("INSERT INTO records VALUES ('TEST-existing')");
  const probe = db.prepare('PRAGMA transaction_state');
  let live = true;
  withSqliteStatementGuard(db, () => { if (!live) throw new Error('TEST-ended'); }, () => {
    db.exec('BEGIN');
    assert.throws(() => db.exec("INSERT OR ROLLBACK INTO records VALUES ('TEST-existing')"), /UNIQUE/);
    live = false;
    assert.throws(() => db.exec("CREATE TABLE escaped AS SELECT 1; INSERT INTO records VALUES ('TEST-after')"), /TEST-ended/);
  });
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='escaped'").get().n, 0);
  assert.equal(probe.all().length, 0);
});
test('SQLite parses guarded exec boundaries including trigger semicolons', t => {
  const db = world(t);
  withSqliteStatementGuard(db, () => {}, () => db.exec("CREATE TRIGGER fill AFTER INSERT ON records BEGIN UPDATE records SET id=id || '-trigger'; END; INSERT INTO records VALUES ('TEST'); /* tail */"));
  assert.equal(db.prepare('SELECT id FROM records').get().id, 'TEST-trigger');
});
test('nested guards restore the outer predicate and always leave on errors', t => {
  const db = world(t), cause = new Error('TEST-cause');
  let outer = 0, inner = 0;
  assert.throws(() => withSqliteStatementGuard(db, () => outer++, () => {
    withSqliteStatementGuard(db, () => inner++, () => db.prepare('SELECT 1').get());
    const before = inner;
    db.prepare('SELECT 2').get();
    assert.equal(inner, before);
    throw cause;
  }), error => error === cause);
  const before = outer;
  db.exec("INSERT INTO records VALUES ('TEST-outside')");
  assert.equal(outer, before);
  assert.ok(inner > 0);
});
test('guarded exec preserves native argument errors instead of silently accepting invalid SQL', t => {
  const db = world(t);
  withSqliteStatementGuard(db, () => {}, () => {
    for (const value of [undefined, null, 123, {}]) assert.throws(() => db.exec(value), { code: 'ERR_INVALID_ARG_TYPE' });
  });
});

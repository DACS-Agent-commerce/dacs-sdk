import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
const nativeExec = DatabaseSync.prototype.exec;
const probe = new DatabaseSync(':memory:');
const nativeRun = Object.getPrototypeOf(probe.prepare('SELECT 1')).run;
probe.close();
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
test('captured native execution functions cannot bypass a guarded callback', t => {
  const db = world(t), prepared = db.prepare("INSERT INTO records VALUES ('TEST-bypass')");
  withSqliteStatementGuard(db, () => {}, () => {
    for (const write of [() => nativeExec.call(db, "CREATE TABLE escaped AS SELECT 1"), () => nativeRun.call(prepared)]) assert.throws(write, /readonly/);
    db.exec("INSERT INTO records VALUES ('TEST-guarded')");
  });
  nativeExec.call(db, "INSERT INTO records VALUES ('TEST-outside')");
  assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 2);
});
test('read-only host policy is preserved within and after nested guards', t => {
  const db = world(t); db.exec('PRAGMA query_only=ON');
  withSqliteStatementGuard(db, () => {}, () => {
    withSqliteStatementGuard(db, () => {}, () => assert.throws(() => db.exec("INSERT INTO records VALUES ('TEST')"), /readonly/));
    assert.equal(db.prepare('PRAGMA query_only').get().query_only, 1);
  });
  assert.equal(db.prepare('PRAGMA query_only').get().query_only, 1);
});

test('exec consumes later rows and preserves their native errors', t => {
  const db=world(t);
  db.exec("INSERT INTO records VALUES ('{}'), ('bad')");
  assert.throws(()=>withSqliteStatementGuard(db,()=>{},()=>db.exec("SELECT json_extract(id, '$') FROM records")), /malformed JSON/);
});
test('exec accepts SQLite comment tails and rejects non-SQLite whitespace', t => {
  const db=world(t);
  withSqliteStatementGuard(db,()=>{},()=>{
    db.exec("INSERT INTO records VALUES ('TEST-comment'); /* unfinished");
    db.exec('/* unfinished');
    assert.throws(()=>db.exec('\u00a0'), /syntax/);
  });
  assert.equal(db.prepare('SELECT count(*) n FROM records').get().n,1);
});
test('iterators created before a guard still check liveness on next', t => {
  const db=world(t), iterator=db.prepare('SELECT 1').iterate();
  let live=true;
  withSqliteStatementGuard(db,()=>{if(!live)throw Error('TEST-ended');},()=>{
    live=false;
    assert.throws(()=>iterator.next(), /TEST-ended/);
    iterator.return();
  });
});
test('a rollback in one exec batch is checked before the second statement', t => {
  const db=world(t); db.exec('BEGIN; CREATE TEMP TABLE test_live(id)');
  const live=db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name='test_live'");
  withSqliteStatementGuard(db,()=>{if(!live.get())throw Error('TEST-ended');},()=>{
    assert.throws(()=>db.exec('ROLLBACK; CREATE TABLE escaped AS SELECT 1'), /TEST-ended/);
  });
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='escaped'").get().n,0);
});

test('exec preserves native NUL and BOM empty remainders after a write', t=>{
  for(const tail of ['\0 SELECT invalid_column','\ufeff','\ufeff /* unfinished']){
    const native=world(t),guarded=world(t),sql="INSERT INTO records VALUES ('TEST-tail');"+tail;
    nativeExec.call(native,sql);
    withSqliteStatementGuard(guarded,()=>{},()=>{
      guarded.exec(sql);
      guarded.exec('\0 SELECT invalid_column');
    });
    assert.deepEqual(guarded.prepare('SELECT id FROM records').all(),native.prepare('SELECT id FROM records').all());
  }
});
for (const kind of ['accessor', 'proxy', 'function accessor', 'callable proxy']) {
  test(`named bindings that run code are refused before the writable fence opens: ${kind}`, t => {
    const db = world(t);
    db.exec('BEGIN; CREATE TEMP TABLE test_live(id)');
    const live = db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name='test_live'");
    const insert = db.prepare('INSERT INTO records VALUES ($id)');
    let reads = 0;
    const read = () => { reads++; nativeExec.call(db, 'ROLLBACK'); return 'TEST-escaped'; };
    const functionWithAccessor = () => Object.defineProperty(() => {}, '$id', { enumerable: true, get: read });
    const bindings = {
      accessor: () => ({ get $id() { return read(); } }),
      proxy: () => new Proxy({ $id: 'TEST-value' }, { get: read }),
      'function accessor': functionWithAccessor,
      'callable proxy': () => new Proxy(() => {}, { get: read, ownKeys: () => ['$id'], getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: 'TEST-value' }) }),
    }[kind]();
    withSqliteStatementGuard(db, () => { if (!live.get()) throw Error('TEST-ended'); }, () => {
      assert.throws(() => insert.run(bindings), /named bindings/);
    });
    assert.equal(reads, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 0);
  });
}
test('plain named and positional bindings still run under a guard', t => {
  const db = world(t);
  withSqliteStatementGuard(db, () => {}, () => {
    db.prepare('INSERT INTO records VALUES ($id)').run({ $id: 'TEST-named' });
    db.prepare('INSERT INTO records VALUES (?)').run('TEST-positional');
  });
  assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 2);
});

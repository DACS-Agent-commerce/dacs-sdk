import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
const nativeExec = DatabaseSync.prototype.exec;
const nativePrepare = DatabaseSync.prototype.prepare;
const probe = new DatabaseSync(':memory:');
const nativeRun = Object.getPrototypeOf(probe.prepare('SELECT 1')).run;
probe.close();
import { withSqliteStatementGuard } from '../src/util/sqlite-statement-boundary.mjs';

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
  assert.throws(() => withSqliteStatementGuard(db, () => { outer++; }, () => {
    withSqliteStatementGuard(db, () => { inner++; }, () => { db.prepare('SELECT 1').get(); });
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
test('read-only host policy is refused before either callback runs', t => {
  const db = world(t); db.exec('PRAGMA query_only=ON');
  let calls = 0;
  assert.throws(() => withSqliteStatementGuard(db, () => { calls++; }, () => { calls++; }), /read-only policy/);
  assert.equal(calls, 0);
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
for(const functionName of ['expire_and_write','expire_and_write(','expire_and_write(0)']) for(const separate of [false,true])test(`SQL callbacks cannot use retained writers across rollback, name=${functionName}, separate=${separate}`, t => {
  const db=world(t), other=separate?world(t):db;
  other.exec("INSERT INTO records VALUES ('TEST-existing'); BEGIN; CREATE TEMP TABLE test_live(id)");
  const live=other.prepare("SELECT 1 FROM sqlite_temp_master WHERE name='test_live'");
  const write=other.prepare("INSERT INTO records VALUES ('TEST-escaped')");
  db.function(functionName,()=>{
    try{nativeExec.call(other,"INSERT OR ROLLBACK INTO records VALUES ('TEST-existing')");}catch{}
    nativeRun.call(write); return 1;
  });
  const run=()=>withSqliteStatementGuard(other,()=>{if(!live.get())throw Error('TEST-ended');},()=>{
    assert.throws(()=>db.prepare('SELECT '+JSON.stringify(functionName)+'()').get(), /SQL callbacks/);
  });
  if(separate)withSqliteStatementGuard(db,()=>{},run);else run();
  assert.equal(other.prepare("SELECT count(*) n FROM records WHERE id='TEST-escaped'").get().n,0);
});
test('a statement prepared before installation cannot run an application callback inside a guard', t => {
  const db = world(t);
  db.function('TEST_callback', () => {
    nativeExec.call(db, 'PRAGMA query_only=OFF');
    nativeExec.call(db, "INSERT INTO records VALUES ('TEST-escaped')");
    return 1;
  });
  const earlier = nativePrepare.call(db, 'SELECT TEST_callback() AS value');
  withSqliteStatementGuard(db, () => {}, () => assert.throws(() => earlier.get(), /SQL callbacks/));
  assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 0);
});
test('registering SQL callbacks is refused during guards', t => {
  const db=world(t);
  withSqliteStatementGuard(db,()=>{},()=>assert.throws(()=>db.function('TEST_callback',()=>1), /SQL callbacks/));
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
for (const sql of ["SELECT * FROM pragma_integrity_check('checked')", "SELECT * FROM pragma_quick_check('checked')", 'ALTER TABLE checked ADD COLUMN y CHECK (chk(y))']) {
  test(`virtual-table programs cannot run application callbacks inside a guard: ${sql}`, t => {
    const db = world(t);
    let armed = false, calls = 0;
    db.function('chk', value => {
      if (!armed) return value;
      calls++;
      try { nativeExec.call(db, "INSERT OR ROLLBACK INTO records VALUES ('TEST-existing')"); } catch { /* the conflict rolls the transaction back */ }
      nativeRun.call(write);
      return 1;
    });
    db.exec("CREATE TABLE checked(x CHECK (chk(x))); INSERT INTO checked VALUES (1); INSERT INTO records VALUES ('TEST-existing'); BEGIN; CREATE TEMP TABLE test_live(id)");
    const live = db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name='test_live'");
    const write = db.prepare("INSERT INTO records VALUES ('TEST-escaped')");
    armed = true;
    withSqliteStatementGuard(db, () => { if (!live.get()) throw Error('TEST-ended'); }, () => {
      assert.throws(() => db.prepare(sql).all(), /SQL callbacks/);
    });
    assert.equal(calls, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM records WHERE id='TEST-escaped'").get().n, 0);
  });
}
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
test('unowned statements and virtual tables are refused even without visible application functions', t => {
  const db = world(t), earlier = nativePrepare.call(db, 'SELECT 1 AS value');
  withSqliteStatementGuard(db, () => {}, () => {
    assert.throws(() => earlier.get(), /SQL callbacks/);
    assert.throws(() => db.prepare("SELECT count(*) n FROM pragma_table_info('records')").get(), /SQL callbacks/);
    assert.throws(() => db.prepare("SELECT count(*) n FROM json_each('[1,2]')").get(), /SQL callbacks/);
    assert.equal(db.prepare('SELECT 1 AS value').get().value, 1);
  });
});
test('an application override of a bundled extension function is still refused', t => {
  const db = world(t);
  db.function('geopoly_bbox', { deterministic: true }, value => value);
  withSqliteStatementGuard(db, () => {}, () => {
    assert.throws(() => db.prepare("SELECT geopoly_bbox('[[0,0],[1,0],[1,1]]')").get(), /SQL callbacks/);
  });
});
test('an application override of rtreenode cannot write after a rollback inside a guard', t => {
  const db = world(t);
  db.exec('BEGIN; CREATE TEMP TABLE test_live(id)');
  const live = db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name='test_live'");
  const write = db.prepare("INSERT INTO records VALUES ('TEST-escaped')");
  let calls = 0;
  // Two parameters give the override the same name and arity as the bundled function.
  db.function('rtreenode', (nodeSize, nodeData) => {
    calls++;
    nativeExec.call(db, 'ROLLBACK');
    nativeRun.call(write);
    return nodeSize + nodeData;
  });
  withSqliteStatementGuard(db, () => { if (!live.get()) throw Error('TEST-ended'); }, () => {
    assert.throws(() => db.prepare('SELECT rtreenode(1, 2)').get(), /SQL callbacks/);
  });
  assert.equal(calls, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM records WHERE id='TEST-escaped'").get().n, 0);
});
test('a bundled extension function is refused because an override cannot be told apart', t => {
  const db = world(t);
  withSqliteStatementGuard(db, () => {}, () => {
    assert.throws(() => db.prepare("SELECT geopoly_area('[[0,0],[1,0],[1,1]]')").get(), /SQL callbacks/);
  });
});
test('a colliding override registered after installation makes virtual-table programs refused', t => {
  const db = world(t);
  withSqliteStatementGuard(db, () => {}, () => {});
  db.function('rtreenode', (nodeSize, nodeData) => nodeSize + nodeData);
  withSqliteStatementGuard(db, () => {}, () => {
    assert.throws(() => db.prepare("SELECT count(*) n FROM pragma_table_info('records')").get(), /SQL callbacks/);
  });
});

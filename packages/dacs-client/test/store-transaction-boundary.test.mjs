import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSqlitePurchaseStore } from '../src/seams/purchase-store-not-wired.mjs';

function world(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE records (id TEXT PRIMARY KEY)');
  t.after(() => { try { db.close(); } catch {} });
  return { db, store: createSqlitePurchaseStore(), rows: () => db.prepare('SELECT id FROM records ORDER BY id').all().map(row => row.id) };
}
for (const sql of ['COMMIT', 'END', 'END TRANSACTION']) for (const prepared of [false, true]) for (const nested of [false, true]) {
  test(`callback ${sql}, prepared=${prepared}, nested=${nested}, cannot persist a partial write`, t => {
    const { db, store, rows } = world(t);
    const statement = prepared ? db.prepare(sql) : null;
    const body = () => {
      db.exec("INSERT INTO records VALUES ('TEST-partial')");
      if (prepared) statement.run(); else db.exec(sql);
      throw new Error('TEST-after-control');
    };
    assert.throws(() => store.transaction(db, () => nested ? store.transaction(db, body) : body()));
    assert.deepEqual(rows(), []);
    store.transaction(db, () => db.exec("INSERT INTO records VALUES ('TEST-complete')"));
    assert.deepEqual(rows(), ['TEST-complete']);
  });
}
for (const warm of [false, true]) {
  test(`refusing a host transaction leaves its connection and retry usable, warm=${warm}`, t => {
    const { db, store, rows } = world(t);
    if (warm) store.transaction(db, () => {});
    db.exec("BEGIN; INSERT INTO records VALUES ('TEST-host')");
    let called = false;
    assert.throws(() => store.transaction(db, () => { called = true; }));
    assert.equal(called, false);
    if (!warm) assert.deepEqual(db.prepare("SELECT name FROM temp.sqlite_master WHERE name LIKE 'dacs_purchase_%'").all(), []);
    db.exec('ROLLBACK');
    store.transaction(db, () => db.exec("INSERT INTO records VALUES ('TEST-retry')"));
    assert.deepEqual(rows(), ['TEST-retry']);
    db.exec("INSERT INTO records VALUES ('TEST-outside')");
    assert.deepEqual(rows(), ['TEST-outside', 'TEST-retry']);
  });
}
test('nested entry after a swallowed outer rollback does not recover an unopened savepoint', t => {
  const { db, store, rows } = world(t);
  db.exec("INSERT INTO records VALUES ('TEST-existing')");
  assert.throws(() => store.transaction(db, () => {
    assert.throws(() => db.exec("INSERT OR ROLLBACK INTO records VALUES ('TEST-existing')"), /UNIQUE/);
    assert.throws(() => store.transaction(db, () => assert.fail('lost transaction callback ran')));
  }));
  assert.deepEqual(rows(), ['TEST-existing']);
  store.transaction(db, () => db.exec("INSERT INTO records VALUES ('TEST-retry')"));
  assert.deepEqual(rows(), ['TEST-existing', 'TEST-retry']);
});

test('a caught callback COMMIT error cannot split a later failure from earlier writes', t => {
  const { db, store, rows } = world(t);
  assert.throws(() => store.transaction(db, () => {
    db.exec("INSERT INTO records VALUES ('TEST-first')");
    assert.throws(() => db.exec('COMMIT'), /statements in progress/);
    db.exec("INSERT INTO records VALUES ('TEST-second')");
    throw new Error('TEST-failure');
  }), /TEST-failure/);
  assert.deepEqual(rows(), []);
});

test('uniqueness uses native constraint codes and preserves a trigger policy error', t => {
  const {db,store}=world(t);
  db.exec("CREATE TRIGGER policy BEFORE INSERT ON records WHEN NEW.id='TEST-policy' BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: records.id'); END");
  assert.throws(()=>store.transaction(db,()=>db.exec("INSERT INTO records VALUES ('TEST-policy')")),error=>{
    assert.equal(error.errcode,1811); assert.equal(store.isUniqueViolation(error),false); return true;
  });
  db.exec("INSERT INTO records VALUES ('TEST-existing')");
  assert.throws(()=>db.exec("INSERT INTO records VALUES ('TEST-existing')"),error=>{
    assert.equal(store.isUniqueViolation(error),true); return true;
  });
});
test('schema refresh replaces renamed trigger targets without accumulating guards', t => {
  const {db,store}=world(t);
  store.transaction(db,()=>{});
  for(const suffix of ['one','two']){
    db.exec(`ALTER TABLE records RENAME TO archived_${suffix}; CREATE TABLE records(id TEXT PRIMARY KEY)`);
    store.transaction(db,()=>db.exec(`INSERT INTO records VALUES ('TEST-${suffix}')`));
    const triggers=db.prepare("SELECT tbl_name,count(*) n FROM temp.sqlite_master WHERE type='trigger' GROUP BY tbl_name").all();
    assert.equal(triggers.find(row=>row.tbl_name==='records')?.n,3);
    assert.ok(triggers.every(row=>row.n===3));
  }
});

test('constructing the adapter tracks host statements before its first transaction', () => {
  const result=spawnSync(process.execPath,['--input-type=module','-e',`
    import {DatabaseSync} from 'node:sqlite';
    import {createSqlitePurchaseStore} from ${JSON.stringify(new URL('../src/seams/purchase-store-not-wired.mjs',import.meta.url).href)};
    const db=new DatabaseSync(':memory:'),store=createSqlitePurchaseStore();
    db.exec('CREATE TABLE records(id TEXT)');
    const write=db.prepare("INSERT INTO records VALUES ('TEST-cached')");
    store.transaction(db,()=>write.run());
    if(db.prepare('SELECT count(*) n FROM records').get().n!==1)throw Error('TEST-missing');
    db.close();
  `],{encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
});

for (const warm of [false, true]) {
  test(`refusing an unfinished host writer preserves its iterator and durable row, warm=${warm}`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'dacs-host-writer-')), path = join(dir, 'state.sqlite');
    const db = new DatabaseSync(path), store = createSqlitePurchaseStore();
    t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
    db.exec('CREATE TABLE records(id TEXT PRIMARY KEY)');
    const rows = () => db.prepare('SELECT id FROM records ORDER BY id').all().map(row => row.id);
    if (warm) store.transaction(db, () => {});
    const iterator = db.prepare("INSERT INTO records VALUES ('TEST-host') RETURNING id").iterate();
    assert.equal(iterator.next().value.id, 'TEST-host');
    let called = false;
    assert.throws(() => store.transaction(db, () => { called = true; }));
    assert.equal(called, false);
    assert.equal(iterator.next().done, true);
    assert.deepEqual(rows(), ['TEST-host']);
    const reopened = new DatabaseSync(path);
    try { assert.equal(reopened.prepare('SELECT id FROM records').get().id, 'TEST-host'); }
    finally { reopened.close(); }
    store.transaction(db, () => db.exec("INSERT INTO records VALUES ('TEST-retry')"));
    assert.deepEqual(rows(), ['TEST-host', 'TEST-retry']);
  });
}

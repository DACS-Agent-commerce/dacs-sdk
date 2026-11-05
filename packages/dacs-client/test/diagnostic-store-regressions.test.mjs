import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqlitePurchaseStore } from '../src/seams/purchase-store-not-wired.mjs';

function database(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dacs-diagnostic-store-')), path = join(dir, 'state.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA synchronous=EXTRA; CREATE TABLE records (id TEXT PRIMARY KEY, value INTEGER DEFAULT 0)');
  t.after(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return { db, path, store: createSqlitePurchaseStore() };
}

test('updating an active SELECT iterator returns success exactly when the writes commit', t => {
  const { db, path, store } = database(t);
  db.exec("INSERT INTO records(id) VALUES ('one'), ('two')");
  let iterator;
  t.after(() => { try { iterator?.return(); } catch {} });
  assert.equal(store.transaction(db, () => {
    iterator = db.prepare('SELECT * FROM records').iterate();
    const row = iterator.next().value;
    db.prepare('UPDATE records SET value=value+1 WHERE id=?').run(row.id);
    return 'committed';
  }), 'committed');
  const reopened = new DatabaseSync(path);
  try { assert.equal(reopened.prepare('SELECT sum(value) n FROM records').get().n, 1); }
  finally { reopened.close(); }
});

for (const module of ['fts5(body)', 'rtree(id, minX, maxX)']) {
  test(`unrelated ${module} virtual and shadow tables permit ordinary transactions`, t => {
    const { db, store } = database(t);
    if (!db.prepare('PRAGMA module_list').all().some(row => row.name === module.split('(')[0])) {
      return t.skip('this Node SQLite build does not include the requested optional module');
    }
    db.exec(`CREATE VIRTUAL TABLE search USING ${module}`);
    assert.equal(store.transaction(db, () => db.prepare('INSERT INTO records(id) VALUES (?)').run('one').changes), 1);
    assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 1);
  });
}

test('automatic rollback protects legal sqlite-prefixed host tables and retains an outer handle', t => {
  const { db, store } = database(t);
  db.exec("INSERT INTO records(id) VALUES ('existing'); CREATE TABLE sqliteCache (id TEXT)");
  const insert = db.prepare('INSERT INTO sqliteCache VALUES (?)');
  assert.throws(() => store.transaction(db, () => {
    assert.throws(() => db.exec("INSERT OR ROLLBACK INTO records(id) VALUES ('existing')"), /UNIQUE/);
    assert.throws(() => insert.run('after'), /transaction ended/);
  }), { code: 'purchase_store_transaction_ended' });
  assert.equal(db.prepare('SELECT count(*) n FROM sqliteCache').get().n, 0);
  insert.run('outside');
  store.transaction(db, () => insert.run('retry'));
  assert.equal(db.prepare('SELECT count(*) n FROM sqliteCache').get().n, 2);
});

for (const nested of [false, true]) {
  test(`a returned promise cannot write after refusal (nested=${nested})`, async t => {
    const { db, path, store } = database(t);
    const insert = db.prepare('INSERT INTO records(id) VALUES (?)');
    let continued = false;
    const body = () => {
      insert.run('before');
      return Promise.resolve().then(() => { continued = true; insert.run('after'); });
    };
    assert.throws(() => store.transaction(db, () => nested ? store.transaction(db, body) : body()), { code: 'purchase_store_async_result' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(continued, true);
    assert.throws(() => insert.run('outside'), /closed|not open|finalized/i);
    const reopened = new DatabaseSync(path);
    try { assert.equal(reopened.prepare('SELECT count(*) n FROM records').get().n, 0); }
    finally { reopened.close(); }
  });
}

test('guards are reused at host scale and refresh for added or recreated tables', t => {
  const { db, store } = database(t);
  for (let i = 0; i < 400; i++) db.exec(`CREATE TABLE host_${i} (id TEXT)`);
  let serial = 0;
  const write = () => db.prepare('INSERT INTO records(id) VALUES (?)').run(`TEST-${serial++}`);
  store.transaction(db, write);
  const triggers = () => db.prepare("SELECT name FROM sqlite_temp_master WHERE type='trigger' ORDER BY name").all();
  const before = triggers();
  for (let i = 0; i < 5; i++) store.transaction(db, write);
  assert.deepEqual(triggers(), before);
  assert.equal(before.length, 401 * 3);
  for (const ddl of ['CREATE TABLE added (id TEXT)', 'DROP TABLE added; CREATE TABLE added (id TEXT)']) {
    db.exec(ddl);
    db.exec("INSERT INTO records(id) VALUES ('existing') ON CONFLICT DO NOTHING");
    assert.throws(() => store.transaction(db, () => {
      assert.throws(() => db.exec("INSERT OR ROLLBACK INTO records(id) VALUES ('existing')"), /UNIQUE/);
      assert.throws(() => db.exec("INSERT INTO added VALUES ('after')"), /transaction ended/);
    }), { code: 'purchase_store_transaction_ended' });
    assert.equal(db.prepare('SELECT count(*) n FROM added').get().n, 0);
  }
  db.exec("INSERT INTO added VALUES ('outside')");
});

for (const [name, ddl, seed, write] of [
  ['FTS5 delete', 'CREATE VIRTUAL TABLE search USING fts5(body)', "INSERT INTO search VALUES ('TEST-existing')", 'DELETE FROM search'],
  ['RTree insert', 'CREATE VIRTUAL TABLE search USING rtree(id,minX,maxX)', 'INSERT INTO search VALUES (1,0,1)', 'INSERT INTO search VALUES (2,0,1)'],
  ['CTAS', 'CREATE TABLE search(body TEXT)', "INSERT INTO search VALUES ('TEST-existing')", "CREATE TABLE escaped AS SELECT 'TEST-after' AS body"],
]) {
  test(`automatic rollback prevents ${name} writes on reopen`, t => {
    const { db, path, store } = database(t);
    db.exec(`${ddl}; ${seed}; INSERT INTO records(id) VALUES ('TEST-existing')`);
    const prepared = db.prepare(write);
    assert.throws(() => store.transaction(db, () => {
      assert.throws(() => db.exec("INSERT OR ROLLBACK INTO records(id) VALUES ('TEST-existing')"), /UNIQUE/);
      for (const execute of [() => db.exec(write), () => prepared.run(), () => prepared.get(), () => prepared.all(), () => [...prepared.iterate()]]) {
        assert.throws(execute, /transaction ended/);
      }
    }), { code: 'purchase_store_transaction_ended' });
    const reopened = new DatabaseSync(path);
    try {
      assert.equal(reopened.prepare('SELECT count(*) n FROM search').get().n, 1);
      assert.equal(reopened.prepare("SELECT count(*) n FROM sqlite_master WHERE name='escaped'").get().n, 0);
    } finally { reopened.close(); }
  });
}
test('detach and reattach of the same persistent file is refused on every call', t => {
  const { db, path, store } = database(t);
  store.transaction(db, () => {});
  for (const attempt of [1, 2]) {
    db.prepare('ATTACH DATABASE ? AS aux').run(`${path}.aux`);
    assert.throws(() => store.transaction(db, () => assert.fail('callback ran')),
      { code: 'purchase_store_persistent_attachment' });
    assert.equal(db.isTransaction, false);
    db.exec('DETACH aux');
    store.transaction(db, () => db.prepare('INSERT INTO records(id) VALUES (?)').run(`TEST-${attempt}`));
  }
  assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 2);
});

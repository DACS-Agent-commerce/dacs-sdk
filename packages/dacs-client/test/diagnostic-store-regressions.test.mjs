import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createSqlitePurchaseStore } from '../src/seams/purchase-store-not-wired.mjs';

function database(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dacs-diagnostic-store-')), path = join(dir, 'state.sqlite');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE records (id TEXT PRIMARY KEY, value INTEGER DEFAULT 0)');
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
  }), { code: 'client_not_wired' });
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
    assert.throws(() => store.transaction(db, () => nested ? store.transaction(db, body) : body()), { code: 'client_not_wired' });
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
  const write = () => db.exec("INSERT INTO records(id) VALUES (lower(hex(randomblob(8))))");
  store.transaction(db, write);
  const triggers = () => db.prepare("SELECT name FROM sqlite_temp_master WHERE type='trigger' ORDER BY name").all();
  const before = triggers(), start = performance.now();
  for (let i = 0; i < 5; i++) store.transaction(db, write);
  assert.deepEqual(triggers(), before);
  assert.equal(before.length, 401 * 3);
  assert.ok((performance.now() - start) / 5 < 100, 'warm transactions should take less than 100 ms at 400 host tables');
  for (const ddl of ['CREATE TABLE added (id TEXT)', 'DROP TABLE added; CREATE TABLE added (id TEXT)']) {
    db.exec(ddl);
    db.exec("INSERT INTO records(id) VALUES ('existing') ON CONFLICT DO NOTHING");
    assert.throws(() => store.transaction(db, () => {
      assert.throws(() => db.exec("INSERT OR ROLLBACK INTO records(id) VALUES ('existing')"), /UNIQUE/);
      assert.throws(() => db.exec("INSERT INTO added VALUES ('after')"), /transaction ended/);
    }), { code: 'client_not_wired' });
    assert.equal(db.prepare('SELECT count(*) n FROM added').get().n, 0);
  }
  db.exec("INSERT INTO added VALUES ('outside')");
});


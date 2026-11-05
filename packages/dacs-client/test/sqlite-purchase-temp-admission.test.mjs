import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkSqlitePurchaseDatabase, checkSqlitePurchaseInput } from '../src/util/sqlite-purchase-admission.mjs';
import { sqliteWriteLease } from '../src/util/sqlite-write-lease.mjs';

const admitters = [checkSqlitePurchaseDatabase, db => checkSqlitePurchaseInput(db, () => {})];
function rows(db, sql) {
  const statement = db.prepare(sql);
  statement.setReturnArrays?.(false); statement.setReadBigInts(false);
  return statement.all();
}
const inventory = db => rows(db, 'PRAGMA database_list');
function memory(t, options = {}) {
  const db = new DatabaseSync(':memory:', options);
  t.after(() => db.close());
  return db;
}
function file(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dacs-temp-admission-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'state.sqlite');
}
for (const readBigInts of [false, true]) for (const returnArrays of [false, true]) {
  const options = { readBigInts, returnArrays }, label = JSON.stringify(options);
  for (const mode of ['DELETE', 'TRUNCATE', 'PERSIST', 'MEMORY']) test(`present TEMP ${mode} is admitted with ${label}`, t => {
    const db = memory(t, options);
    db.exec(`PRAGMA temp.journal_mode=${mode}`);
    const before = inventory(db);
    for (const admit of admitters) assert.equal(admit(db), undefined);
    assert.deepEqual(inventory(db), before);
  });
  test(`TEMP OFF refusal then each supported-mode retry preserves caller results ${label}`, t => {
    const db = memory(t, options), saved = db.prepare('SELECT 7 AS n'), expected = saved.get();
    for (const mode of ['DELETE', 'TRUNCATE', 'PERSIST', 'MEMORY']) {
      db.exec('PRAGMA temp.journal_mode=OFF');
      for (const admit of admitters) assert.throws(() => admit(db), { code: 'purchase_store_unsupported_temp_journal_mode' });
      db.exec(`PRAGMA temp.journal_mode=${mode}`);
      for (const admit of admitters) assert.equal(admit(db), undefined);
      assert.deepEqual(saved.get(), expected);
      assert.deepEqual(db.prepare('SELECT 7 AS n').get(), expected);
    }
  });
  test(`repeated admission does not create absent TEMP ${label}`, t => {
    const db = memory(t, options), before = inventory(db);
    assert.deepEqual(before.map(row => row.name), ['main']);
    for (let repeat = 0; repeat < 2; repeat++) for (const admit of admitters) assert.equal(admit(db), undefined);
    assert.deepEqual(inventory(db), before);
  });
  test(`discarded TEMP is not recreated or judged by stale OFF state ${label}`, t => {
    const db = memory(t, options);
    db.exec('CREATE TEMP TABLE host(x); PRAGMA temp.journal_mode=OFF; PRAGMA temp_store=MEMORY');
    const before = inventory(db);
    assert.deepEqual(before.map(row => row.name), ['main']);
    for (const admit of admitters) assert.equal(admit(db), undefined);
    assert.deepEqual(inventory(db), before);
  });
  test(`reopen checks preserve absent TEMP and accept initialized TEMP ${label}`, t => {
    const path = file(t);
    const initial = new DatabaseSync(path);
    initial.exec('CREATE TABLE records(id); INSERT INTO records VALUES (7)'); initial.close();
    for (let repeat = 0; repeat < 2; repeat++) {
      const db = new DatabaseSync(path, options);
      try {
        db.exec('PRAGMA synchronous=EXTRA');
        const before = inventory(db);
        for (const admit of admitters) assert.equal(admit(db), undefined);
        assert.deepEqual(inventory(db), before);
        db.exec('PRAGMA temp.journal_mode=MEMORY');
        for (const admit of admitters) assert.equal(admit(db), undefined);
        assert.equal(rows(db, 'SELECT id FROM records')[0].id, 7);
      } finally { db.close(); }
    }
  });
  for (const present of [false, true]) test(`overlapping writer handles preserve TEMP presence=${present} ${label}`, t => {
    const path = file(t), writer = new DatabaseSync(path), reader = new DatabaseSync(path, options);
    t.after(() => { reader.close(); writer.close(); });
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE records(id)');
    reader.exec('PRAGMA synchronous=FULL');
    if (present) { writer.exec('PRAGMA temp.journal_mode=MEMORY'); reader.exec('PRAGMA temp.journal_mode=MEMORY'); }
    writer.exec('BEGIN IMMEDIATE; INSERT INTO records VALUES (7)');
    const beforeWriter = inventory(writer), beforeReader = inventory(reader);
    for (const db of [reader, writer]) for (const admit of admitters) assert.equal(admit(db), undefined);
    assert.deepEqual(inventory(writer), beforeWriter); assert.deepEqual(inventory(reader), beforeReader);
    assert.notEqual(writer.isTransaction, false);
    writer.exec('ROLLBACK');
    assert.equal(rows(reader, 'SELECT count(*) n FROM records')[0].n, 0);
  });
}

for (const readBigInts of [false, true]) for (const returnArrays of [false, true]) {
  const options = { readBigInts, returnArrays }, label = JSON.stringify(options);
  for (const repair of ['MEMORY', 'DELETE']) test(`unqualified OFF leaves initialized TEMP unsafe after main WAL, repair=${repair} ${label}`, t => {
    const db = new DatabaseSync(file(t), options);
    t.after(() => db.close());
    db.exec('CREATE TABLE records(id); CREATE TEMP TABLE host(id); PRAGMA journal_mode=OFF; PRAGMA main.journal_mode=WAL; PRAGMA main.synchronous=FULL');
    const saved = db.prepare('SELECT 7 AS n'), expected = saved.get(), before = inventory(db);
    let calls = 0;
    for (const admit of [checkSqlitePurchaseDatabase, db => checkSqlitePurchaseInput(db, () => { calls++; })]) {
      assert.throws(() => admit(db), { code: 'purchase_store_unsupported_temp_journal_mode' });
      assert.equal(rows(db, 'PRAGMA temp.journal_mode')[0].journal_mode, 'off');
      assert.deepEqual(inventory(db), before);
      assert.deepEqual(rows(db, 'SELECT name FROM temp.sqlite_master').map(row => row.name), ['host']);
    }
    assert.equal(calls, 0);
    db.exec(`PRAGMA temp.journal_mode=${repair}`);
    for (const admit of admitters) assert.equal(admit(db), undefined);
    assert.deepEqual(saved.get(), expected);
    assert.deepEqual(db.prepare('SELECT 7 AS n').get(), expected);
  });
}
for (const mode of ['DELETE', 'TRUNCATE', 'PERSIST', 'MEMORY', 'OFF']) test(`real lease rollback marker with TEMP ${mode}`, t => {
  // The lease owns metadata normalization in 03c; use its supported native format here.
  const db = memory(t);
  db.exec(`CREATE TABLE records(id); PRAGMA temp.journal_mode=${mode}`);
  for (const admit of admitters) {
    if (mode === 'OFF') assert.throws(() => admit(db), { code: 'purchase_store_unsupported_temp_journal_mode' });
    else assert.equal(admit(db), undefined);
  }
  // Deliberately acquire the raw lease even for OFF to demonstrate why admission refuses it.
  const lease = sqliteWriteLease(db);
  lease.arm(); db.exec('BEGIN IMMEDIATE'); lease.start(); db.exec('ROLLBACK');
  const marker = rows(db, "SELECT name FROM temp.sqlite_master WHERE type='table' AND name LIKE 'dacs_purchase_%'")[0].name;
  assert.equal(rows(db, `SELECT present FROM temp."${marker}"`)[0].present, mode === 'OFF' ? 1 : 0);
  if (mode === 'OFF') {
    db.exec('INSERT INTO records VALUES (7)');
    assert.equal(rows(db, 'SELECT count(*) n FROM records')[0].n, 1);
  } else {
    assert.throws(() => db.exec('INSERT INTO records VALUES (7)'), /purchase transaction ended/);
    assert.equal(rows(db, 'SELECT count(*) n FROM records')[0].n, 0);
  }
  lease.disarm();
});

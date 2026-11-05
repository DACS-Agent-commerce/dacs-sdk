// Node 22.13.0 and 23.4.0, the engine floors, have no db.isTransaction and no
// FTS5 or RTREE module. These cases keep the test suite free of both.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inTransaction, hasSqliteModule } from './helpers/sqlite-engine-floor.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const thisFile = fileURLToPath(import.meta.url);

function openMemory(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => { try { db.close(); } catch { /* A closed handle is already released. */ } });
  db.exec('CREATE TABLE records(id TEXT)');
  return db;
}

test('inTransaction follows BEGIN, COMMIT and ROLLBACK', t => {
  const db = openMemory(t);
  assert.equal(inTransaction(db), false);
  db.exec('BEGIN');
  assert.equal(inTransaction(db), true);
  db.exec('COMMIT');
  assert.equal(inTransaction(db), false);
  db.exec('BEGIN IMMEDIATE');
  assert.equal(inTransaction(db), true);
  db.exec('ROLLBACK');
  assert.equal(inTransaction(db), false);
});
test('inTransaction leaves a host transaction and its uncommitted work in place', t => {
  const db = openMemory(t);
  db.exec("BEGIN; INSERT INTO records VALUES ('TEST-host')");
  assert.equal(inTransaction(db), true);
  assert.equal(inTransaction(db), true);
  assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 1);
  db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 0);
});
test('inTransaction agrees with isTransaction wherever the engine provides it', t => {
  const db = openMemory(t);
  if (typeof db.isTransaction !== 'boolean') return t.skip('this Node has no isTransaction');
  for (const sql of ['SELECT 1', 'BEGIN', "INSERT INTO records VALUES ('TEST-row')", 'COMMIT']) {
    db.exec(sql);
    assert.equal(inTransaction(db), db.isTransaction, sql);
  }
});
test('inTransaction refuses a closed handle instead of answering false', t => {
  const db = openMemory(t);
  db.close();
  assert.throws(() => inTransaction(db), /not open/);
});

test('hasSqliteModule reports every module this build lists and refuses an unknown name', t => {
  const db = openMemory(t);
  const listed = db.prepare('PRAGMA module_list').all();
  assert.ok(listed.length > 0);
  for (const { name } of listed) assert.equal(hasSqliteModule(db, name), true, name);
  assert.equal(hasSqliteModule(db, 'TEST-absent-module'), false);
});

function testSources(directory = testDirectory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return testSources(path);
    return entry.name.endsWith('.mjs') && path !== thisFile ? [{ file: relative(testDirectory, path), lines: readFileSync(path, 'utf8').split('\n') }] : [];
  });
}
const ENGINE_FLOOR_GAPS = [
  { gap: 'db.isTransaction', pattern: /\.isTransaction\b/, instead: 'inTransaction() from helpers/sqlite-engine-floor.mjs, or the TEMP-table marker inside a statement guard' },
  { gap: 'an FTS5 or RTREE table spelled out in SQL', pattern: /USING\s+(?:fts5|rtree)\b/i, instead: 'a plain table, or hasSqliteModule() with a skip' },
];
for (const { gap, pattern, instead } of ENGINE_FLOOR_GAPS) {
  test(`no client test relies on ${gap}, which the engine floors lack`, () => {
    const offenders = testSources().flatMap(({ file, lines }) => lines.flatMap((line, index) => pattern.test(line) ? [`${file}:${index + 1}`] : []));
    assert.deepEqual(offenders, [], `use ${instead}`);
  });
}

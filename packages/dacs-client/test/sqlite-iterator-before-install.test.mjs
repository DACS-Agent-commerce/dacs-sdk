// On Node 22.13.0 and 23.4.0 an iterator keeps its own native `next`, so the
// statement guard cannot wrap one that exists before the guard installs. This
// file creates such iterators first, with the engine-floor layout, and checks
// what the guard still enforces for them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { useFloorIteratorsEverywhere } from './helpers/sqlite-floor-iterators.mjs';

useFloorIteratorsEverywhere();

function world(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE records(id TEXT PRIMARY KEY)');
  t.after(() => db.close());
  return db;
}
// Created before the guard module is imported, so nothing wraps their next.
const readDb = new DatabaseSync(':memory:');
const earlyRead = readDb.prepare('SELECT 1 AS one UNION ALL SELECT 2').iterate();
const writeDb = new DatabaseSync(':memory:');
writeDb.exec('CREATE TABLE records(id TEXT PRIMARY KEY)');
const earlyWrite = writeDb.prepare("INSERT INTO records VALUES ('TEST-early') RETURNING id").iterate();
const { withSqliteStatementGuard } = await import('../src/util/sqlite-statement-boundary.mjs');

test('the fixture gives the earlier iterators their own next, as the engine floors do', () => {
  assert.ok(Object.hasOwn(earlyRead, 'next'));
  assert.ok(Object.hasOwn(earlyWrite, 'next'));
});

test('a guard whose liveness ends during a step of an earlier iterator does not return normally', () => {
  let live = true;
  const rows = [];
  assert.throws(() => withSqliteStatementGuard(readDb, () => { if (!live) throw new Error('TEST-ended'); }, () => {
    live = false;
    rows.push(earlyRead.next().value.one);
  }), /TEST-ended/);
  // The earlier step itself is unobserved; the guard still refuses to finish.
  assert.deepEqual(rows, [1]);
  earlyRead.return();
});

test('an iterator created before installation cannot write while a guard is active', () => {
  withSqliteStatementGuard(writeDb, () => {}, () => {
    assert.throws(() => earlyWrite.next(), /readonly/);
  });
  assert.equal(writeDb.prepare('SELECT count(*) n FROM records').get().n, 0);
  earlyWrite.return();
});

test('an iterator created after installation but before the guard checks liveness on every step', t => {
  const db = world(t), iterator = db.prepare('SELECT 1 AS one UNION ALL SELECT 2').iterate();
  let live = true;
  withSqliteStatementGuard(db, () => { if (!live) throw new Error('TEST-ended'); }, () => {
    assert.equal(iterator.next().value.one, 1);
    live = false;
    assert.throws(() => iterator.next(), /TEST-ended/);
  });
  iterator.return();
});

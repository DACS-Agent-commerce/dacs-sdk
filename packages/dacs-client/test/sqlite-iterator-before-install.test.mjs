// On Node 22.13.0 and 23.4.0 an iterator keeps its own native `next`, so the
// statement guard cannot wrap one that exists before the guard installs. This
// file creates such iterators first, with the engine-floor layout, and checks
// what the guard still enforces for them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { useFloorIteratorsEverywhere } from './helpers/sqlite-floor-iterators.mjs';
import { holdIterators } from './helpers/held-iterators.mjs';

useFloorIteratorsEverywhere();
const earlyIterators = holdIterators();

function world(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE records(id TEXT PRIMARY KEY)');
  t.after(() => db.close());
  return db;
}
// Created before the guard module is imported, so nothing wraps their next.
const readDb = new DatabaseSync(':memory:');
const earlyRead = earlyIterators.iterate(readDb.prepare('SELECT 1 AS one UNION ALL SELECT 2'));
const writeDb = new DatabaseSync(':memory:');
writeDb.exec('CREATE TABLE records(id TEXT PRIMARY KEY)');
const earlyWrite = earlyIterators.iterate(writeDb.prepare("INSERT INTO records VALUES ('TEST-early') RETURNING id"));
// One unused earlier read iterator per test that steps one.
const spareReads = Array.from({ length: 2 }, () => earlyIterators.iterate(readDb.prepare('SELECT 1 AS one UNION ALL SELECT 2')));
const { withSqliteStatementGuard } = await import('../src/util/sqlite-statement-boundary.mjs');
const { isSqliteHandleRetired } = await import('../src/util/sqlite-write-lease.mjs');
const otherDb = new DatabaseSync(':memory:');
test.after(() => {
  earlyIterators.release();
  readDb.close();
  writeDb.close();
  otherDb.close();
});

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
});

test('an iterator created before installation cannot write while a guard is active', () => {
  withSqliteStatementGuard(writeDb, () => {}, () => {
    assert.throws(() => earlyWrite.next(), /readonly/);
  });
  assert.equal(writeDb.prepare('SELECT count(*) n FROM records').get().n, 0);
});

test('an iterator created after installation but before the guard checks liveness on every step', t => {
  const db = world(t), held = holdIterators(), iterator = held.iterate(db.prepare('SELECT 1 AS one UNION ALL SELECT 2'));
  let live = true;
  withSqliteStatementGuard(db, () => { if (!live) throw new Error('TEST-ended'); }, () => {
    assert.equal(iterator.next().value.one, 1);
    live = false;
    assert.throws(() => iterator.next(), /TEST-ended/);
  });
  held.release();
});

test('a guard whose own end was reported to its body and caught there returns normally', () => {
  let live = true;
  withSqliteStatementGuard(readDb, () => { if (!live) throw new Error('TEST-ended'); }, () => {
    live = false;
    assert.throws(() => readDb.prepare('SELECT 1'), /TEST-ended/);
  });
});

test('an outer end reported through a nested guard and caught by the outer body returns normally', () => {
  let outerLive = true;
  withSqliteStatementGuard(readDb, () => { if (!outerLive) throw new Error('TEST-outer-ended'); }, () => {
    outerLive = false;
    assert.throws(() => withSqliteStatementGuard(readDb, () => {}, () => {}), /TEST-outer-ended/);
  });
});

test('a refusal from a nested guard on another database does not excuse the outer guard from its final check', () => {
  let live = true;
  assert.throws(() => withSqliteStatementGuard(readDb, () => { if (!live) throw new Error('TEST-outer-ended'); }, () => {
    assert.throws(() => withSqliteStatementGuard(otherDb, () => { throw new Error('TEST-inner-ended'); }, () => {}), /TEST-inner-ended/);
    live = false;
    spareReads[0].next();
  }), /TEST-outer-ended/);
});

test('a different failure of a nested guard on the same database does not excuse the outer guard from its final check', () => {
  let live = true;
  assert.throws(() => withSqliteStatementGuard(readDb, () => { if (!live) throw new Error('TEST-outer-ended'); }, () => {
    let innerLive = false;
    assert.throws(() => withSqliteStatementGuard(readDb, () => { if (!innerLive) throw new Error('TEST-inner-ended'); }, () => {}), /TEST-inner-ended/);
    live = false;
    spareReads[1].next();
  }), /TEST-outer-ended/);
});

for (const [name, value] of [['a promise', () => Promise.resolve()], ['a rejected promise', () => Promise.reject(new Error('TEST-late'))], ['a number', () => 1]]) {
  test(`a body that returns ${name} after liveness ended still retires the connection`, () => {
    // Retiring closes the connection, so there is nothing left to close here.
    const db = new DatabaseSync(':memory:');
    let live = true;
    assert.throws(() => withSqliteStatementGuard(db, () => { if (!live) throw new Error('TEST-ended'); }, () => {
      live = false;
      return value();
    }), /must return undefined/);
    assert.equal(isSqliteHandleRetired(db), true);
  });
}

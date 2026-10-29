// Node 22.13.0 and 23.4.0 give every statement iterator its own next/return
// instead of inheriting them from a shared prototype. This file gives native
// iterators that shape before the statement guard installs, so the guard is
// checked against the engine-floor layout on any Node version.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { useFloorIteratorsEverywhere } from './helpers/sqlite-floor-iterators.mjs';

const probe = new DatabaseSync(':memory:');
useFloorIteratorsEverywhere();
const { withSqliteStatementGuard } = await import('../src/util/sqlite-statement-boundary.mjs');
// Install the guard now so every statement below is prepared under it.
withSqliteStatementGuard(probe, () => {}, () => {});
probe.close();

function world(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE records(id TEXT PRIMARY KEY)');
  t.after(() => db.close());
  return db;
}

test('the fixture gives iterators their own next, as the engine floors do', t => {
  const iterator = world(t).prepare('SELECT 1 AS one').iterate();
  assert.ok(Object.hasOwn(iterator, 'next'));
  assert.ok(Object.hasOwn(iterator, 'return'));
  iterator.return();
});

test('a guarded iterator with its own next checks liveness on every step', t => {
  const db = world(t), statement = db.prepare('INSERT INTO records VALUES (?) RETURNING id');
  let live = true;
  withSqliteStatementGuard(db, () => { if (!live) throw new Error('TEST-ended'); }, () => {
    const iterator = statement.iterate('TEST');
    live = false;
    assert.throws(() => iterator.next(), /TEST-ended/);
    iterator.return();
  });
  assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 0);
});

test('a guarded iterator with its own next opens the writable fence for its steps', t => {
  const db = world(t), statement = db.prepare('INSERT INTO records VALUES (?) RETURNING id');
  db.exec('BEGIN IMMEDIATE');
  withSqliteStatementGuard(db, () => {}, () => {
    const iterator = statement.iterate('TEST-row');
    assert.equal(iterator.next().value.id, 'TEST-row');
    iterator.return();
  });
  db.exec('COMMIT');
  assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 1);
});

test('a read iterator with its own next checks changed liveness between rows', t => {
  const db = world(t), statement = db.prepare('SELECT 1 AS one UNION ALL SELECT 2');
  let live = true;
  const rows = [];
  withSqliteStatementGuard(db, () => { if (!live) throw new Error('TEST-ended'); }, () => {
    const iterator = statement.iterate();
    try {
      assert.throws(() => {
        for (const row of iterator) { rows.push(row.one); live = false; }
      }, /TEST-ended/);
    } finally { iterator.return(); }
  });
  assert.deepEqual(rows, [1]);
});

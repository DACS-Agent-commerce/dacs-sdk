// An iterator whose own `next` the statement guard cannot wrap would step with no
// liveness check and no writable fence, so the guard must refuse it. This file
// gives iterators such a `next` before the guard installs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const probe = new DatabaseSync(':memory:');
const statementPrototype = Object.getPrototypeOf(probe.prepare('SELECT 1'));
const nativeIterate = statementPrototype.iterate;
let ownNext;

statementPrototype.iterate = function (...args) {
  const iterator = Reflect.apply(nativeIterate, this, args);
  if (ownNext) Object.defineProperty(iterator, 'next', ownNext);
  return iterator;
};
const { withSqliteStatementGuard } = await import('../src/util/sqlite-statement-boundary.mjs');
// Install the guard now so every statement below is prepared under it.
withSqliteStatementGuard(probe, () => {}, () => {});
probe.close();

let getterRuns = 0;
const UNWRAPPABLE = [
  ['an accessor', { get() { getterRuns++; return () => ({ done: true }); }, configurable: true }],
  ['undefined', { value: undefined, writable: true, configurable: true }],
  ['a number', { value: 1, writable: true, configurable: true }],
];

for (const [name, descriptor] of UNWRAPPABLE) {
  test(`a guarded statement refuses an iterator whose own next is ${name}`, t => {
    const db = new DatabaseSync(':memory:');
    t.after(() => { ownNext = undefined; db.close(); });
    const statement = db.prepare('SELECT 1 AS one');
    ownNext = descriptor;
    withSqliteStatementGuard(db, () => {}, () => {
      assert.throws(() => statement.iterate(), { name: 'TypeError', message: /own next/ });
    });
  });

  test(`an unguarded statement refuses an iterator whose own next is ${name}`, t => {
    const db = new DatabaseSync(':memory:');
    t.after(() => { ownNext = undefined; db.close(); });
    const statement = db.prepare('SELECT 1 AS one');
    ownNext = descriptor;
    assert.throws(() => statement.iterate(), { name: 'TypeError', message: /own next/ });
  });
}

test('refusing an accessor next never runs the accessor', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => { ownNext = undefined; db.close(); });
  const statement = db.prepare('SELECT 1 AS one');
  ownNext = UNWRAPPABLE[0][1];
  getterRuns = 0;
  assert.throws(() => statement.iterate(), TypeError);
  assert.equal(getterRuns, 0);
});

test('an iterator without an own next is not refused', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  ownNext = undefined;
  withSqliteStatementGuard(db, () => {}, () => {
    assert.deepEqual([...db.prepare('SELECT 1 AS one').iterate()].map(row => row.one), [1]);
  });
});

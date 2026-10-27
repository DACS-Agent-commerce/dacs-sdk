// The LegacyDatabase fixture stands in for the engine floors (Node 22.13.0 and
// 23.4.0), whose statement iterators carry their own next and return.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LegacyDatabase } from './helpers/purchase-tx-fixtures.mjs';

function legacyIterator(t, sql) {
  const db = new LegacyDatabase(':memory:');
  t.after(() => db.close());
  return db.prepare(sql).iterate();
}

test('a LegacyDatabase iterator has its own next', t => {
  const iterator = legacyIterator(t, 'SELECT 1 AS one');
  assert.ok(Object.hasOwn(iterator, 'next'));
  iterator.return();
});

test('a LegacyDatabase iterator has its own return', t => {
  const iterator = legacyIterator(t, 'SELECT 1 AS one');
  assert.ok(Object.hasOwn(iterator, 'return'));
  iterator.return();
});

test('a LegacyDatabase iterator still yields every row and then finishes', t => {
  const iterator = legacyIterator(t, 'SELECT 1 AS one UNION ALL SELECT 2');
  assert.deepEqual([...iterator].map(row => row.one), [1, 2]);
});

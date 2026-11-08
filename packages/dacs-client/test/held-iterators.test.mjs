// The fixtures with iterators created before the statement guard rely on this
// helper to keep each iterator's statement alive on the engine floors.
import test from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { holdIterators } from './helpers/held-iterators.mjs';

v8.setFlagsFromString('--expose-gc');
const collect = vm.runInNewContext('gc');
const settle = () => new Promise(resolve => setImmediate(resolve));

function startIterator(held, returns) {
  const statement = { iterate: () => ({ return() { returns.push('returned'); } }) };
  held.iterate(statement);
  return new WeakRef(statement);
}

test('a held iterator keeps its statement alive until release', async () => {
  const held = holdIterators(), returns = [];
  const statement = startIterator(held, returns);
  await settle();
  collect();
  assert.ok(statement.deref(), 'the statement was collected while its iterator was held');
  held.release();
  assert.deepEqual(returns, ['returned']);
  await settle();
  collect();
  assert.equal(statement.deref(), undefined);
});

test('release finishes each held iterator once', () => {
  const held = holdIterators(), returns = [];
  startIterator(held, returns);
  startIterator(held, returns);
  held.release();
  held.release();
  assert.deepEqual(returns, ['returned', 'returned']);
});

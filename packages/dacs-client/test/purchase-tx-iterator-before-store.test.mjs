// A host iterator created before the first purchase store keeps its own native
// next on Node 22.13.0 and 23.4.0, so the statement guard cannot wrap it. It
// still must not write inside a purchase transaction or let an ended
// transaction finish.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { useFloorIteratorsEverywhere } from './helpers/sqlite-floor-iterators.mjs';
import { holdIterators } from './helpers/held-iterators.mjs';
import { DEFAULT_PROFILE, configure, durableIds } from './helpers/purchase-tx-fixtures.mjs';
import { createSqlitePurchaseStore } from '../src/seams/purchase-store-not-wired.mjs';

useFloorIteratorsEverywhere();
const dir = mkdtempSync(join(tmpdir(), 'dacs-purchase-iterator-')), path = join(dir, 'state.sqlite');
const db = new DatabaseSync(path);
configure(db, DEFAULT_PROFILE);
db.exec("CREATE TABLE records (id TEXT PRIMARY KEY); INSERT INTO records VALUES ('TEST-existing')");
const earlyIterators = holdIterators();
const earlyRead = earlyIterators.iterate(db.prepare('SELECT id FROM records'));
const earlyWrite = earlyIterators.iterate(db.prepare("INSERT INTO records VALUES ('TEST-early') RETURNING id"));
// The first store installs the statement guard, after both iterators exist.
const store = createSqlitePurchaseStore();
test.after(() => { earlyIterators.release(); db.close(); rmSync(dir, { recursive: true, force: true }); });

test('an iterator created before the store cannot write inside a purchase transaction', () => {
  assert.ok(Object.hasOwn(earlyWrite, 'next'));
  store.transaction(db, () => { assert.throws(() => earlyWrite.next(), /readonly/); });
  assert.deepEqual(durableIds(db, path), ['TEST-existing']);
});

test('a purchase transaction that ends during a step of an earlier iterator is refused and persists nothing', () => {
  assert.ok(Object.hasOwn(earlyRead, 'next'));
  assert.throws(() => store.transaction(db, () => {
    db.exec("INSERT INTO records VALUES ('TEST-partial')");
    assert.throws(() => db.exec("INSERT OR ROLLBACK INTO records VALUES ('TEST-existing')"), /UNIQUE/);
    assert.equal(earlyRead.next().value.id, 'TEST-existing');
  }), { code: 'purchase_store_transaction_ended' });
  assert.deepEqual(durableIds(db, path), ['TEST-existing']);
});

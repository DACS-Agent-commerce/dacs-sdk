import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSqlitePurchaseStore, purchaseStore } from '../src/seams/purchase-store-not-wired.mjs';

function database(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE records (id TEXT PRIMARY KEY)');
  t.after(() => { try { db.close(); } catch {} });
  return { db, store: createSqlitePurchaseStore() };
}

test('an unqualified store retains the integration error', () => {
  assert.throws(() => purchaseStore({ transaction: (_db, fn) => fn(), isUniqueViolation: () => false }),
    { name: 'NotWiredError', code: 'client_not_wired', seam: 'purchase-store-not-wired' });
});

test('a promise result identifies the result refusal and a retry identifies the retired handle', t => {
  const { db, store } = database(t);
  assert.throws(() => store.transaction(db, () => Promise.resolve()), { code: 'purchase_store_async_result' });
  assert.throws(() => store.transaction(db, () => {}), { code: 'purchase_store_retired_handle' });
  db.open();
  assert.throws(() => store.transaction(db, () => {}), { code: 'purchase_store_retired_handle' });
});

for (const nested of [false, true]) {
  test(`an ended transaction identifies its lost boundary (nested=${nested})`, t => {
    const { db, store } = database(t);
    const body = () => db.exec('ROLLBACK');
    assert.throws(() => store.transaction(db, () => nested ? store.transaction(db, body) : body()),
      { code: 'purchase_store_transaction_ended' });
  });
}

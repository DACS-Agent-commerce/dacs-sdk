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

test('a non-SQLite handle identifies the refused database', () => {
  assert.throws(() => createSqlitePurchaseStore().transaction({}, () => {}),
    { name: 'OperationError', code: 'purchase_store_invalid_handle' });
});

for (const fn of [undefined, 'TEST-callback']) {
  test(`a ${typeof fn} callback identifies the invalid callback`, t => {
    const { db, store } = database(t);
    assert.throws(() => store.transaction(db, fn), { code: 'purchase_store_invalid_callback' });
  });
}

for (const fn of [async () => {}, function* () {}, async function* () {}]) {
  test(`${fn.constructor.name} identifies the synchronous callback requirement`, t => {
    const { db, store } = database(t);
    assert.throws(() => store.transaction(db, fn), { code: 'purchase_store_async_callback' });
  });
}

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

for (const value of [undefined, 1, 'true']) {
  test(`a ${typeof value} classifier result identifies the boolean requirement`, () => {
    const store = purchaseStore({ ...createSqlitePurchaseStore(), isUniqueViolation: () => value });
    assert.throws(() => store.isUniqueViolation(new Error('TEST')), { code: 'purchase_store_invalid_classifier_result' });
  });
}

test('a classifier promise identifies its own synchronous result requirement', () => {
  const store = purchaseStore({ ...createSqlitePurchaseStore(), isUniqueViolation: () => Promise.reject(new Error('TEST')) });
  assert.throws(() => store.isUniqueViolation(new Error('TEST')), { code: 'purchase_store_async_classifier_result' });
});

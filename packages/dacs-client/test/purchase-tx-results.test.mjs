import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSqlitePurchaseStore, purchaseStore } from '../src/seams/purchase-store-not-wired.mjs';
import { isSqliteHandleRetired } from '../src/util/sqlite-write-lease.mjs';
import { purchaseDatabase, durableIds } from './helpers/purchase-tx-fixtures.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
const asyncResult = { code: 'purchase_store_async_result' };

// Each kind returns [result, accessor reads, expected failure].
function hostileResult(kind, db) {
  const reads = { then: 0, called: 0 }, failure = new Error('TEST-result-inspection');
  const native = kind.startsWith('native');
  const result = native ? (kind.includes('rejected') ? Promise.reject(new Error('TEST-rejected')) : Promise.resolve('TEST-value')) : {};
  if (kind === 'thenable') result.then = () => { reads.called++; };
  if (kind.includes('getter')) {
    Object.defineProperty(result, 'then', { get() {
      reads.then++;
      if (kind === 'rollback getter') db.exec("ROLLBACK; CREATE TABLE escaped(id TEXT); DELETE FROM search");
      if (kind.includes('throwing') || kind === 'rollback getter') throw failure;
      return undefined;
    } });
  }
  const expected = kind === 'throwing getter' ? error => error === failure
    : kind === 'rollback getter' ? /transaction ended|closed|not open/i : asyncResult;
  return { result, reads, expected };
}
for (const nested of [false, true]) for (const kind of ['thenable', 'native fulfilled', 'native rejected', 'native rejected with throwing getter', 'throwing getter', 'rollback getter']) {
  test(`a ${kind} result is read at most once, never adopted, and retires the connection: nested=${nested}`, async t => {
    const { db, path, store } = purchaseDatabase(t);
    db.exec("CREATE VIRTUAL TABLE search USING fts5(body); INSERT INTO search VALUES ('TEST-retained')");
    const writer = db.prepare("INSERT INTO records VALUES ('TEST-late')");
    const { result, reads, expected } = hostileResult(kind, db);
    let lateError;
    const body = () => {
      db.exec("INSERT INTO records VALUES ('TEST-before')");
      queueMicrotask(() => { try { writer.run(); } catch (error) { lateError = error; } });
      return result;
    };
    assert.throws(() => store.transaction(db, () => nested ? store.transaction(db, body) : body()), expected);
    await settle();
    assert.equal(isSqliteHandleRetired(db), true);
    assert.ok(lateError, 'a queued writer must fail before any durable write');
    // A native promise is recognized without reading its then accessor.
    assert.deepEqual(reads, { then: kind.endsWith('getter') && !kind.startsWith('native') ? 1 : 0, called: 0 });
    assert.throws(() => store.transaction(db, () => {}), { code: 'purchase_store_retired_handle' });
    assert.deepEqual(durableIds(db, path), []);
    const reopened = new DatabaseSync(path);
    try {
      assert.equal(reopened.prepare('SELECT count(*) n FROM search').get().n, 1);
      assert.equal(reopened.prepare("SELECT count(*) n FROM sqlite_master WHERE name='escaped'").get().n, 0);
    } finally { reopened.close(); }
  });
}
for (const nested of [false, true]) {
  test(`an ordinary result with a non-function then is read once and returned after commit: nested=${nested}`, t => {
    const { db, path, store } = purchaseDatabase(t);
    let reads = 0;
    const result = Object.defineProperty({}, 'then', { get() { reads++; return 'TEST-not-callable'; } });
    const body = () => { db.exec("INSERT INTO records VALUES ('TEST-row')"); return result; };
    let value;
    store.transaction(db, () => { value = nested ? store.transaction(db, body) : body(); return nested ? undefined : value; });
    assert.equal(value, result);
    assert.equal(reads, 1);
    assert.deepEqual(durableIds(db, path), ['TEST-row']);
  });
}

for (const kind of ['callback-then-thenable', 'deferred', 'pass-through']) {
  test(`unqualified ${kind} transaction is refused before its callback can write`, async () => {
    let writes = 0;
    const transaction = kind === 'callback-then-thenable' ? (_db, fn) => { fn(); return Promise.resolve(); }
      : kind === 'deferred' ? (_db, fn) => Promise.resolve().then(fn) : (_db, fn) => fn();
    assert.throws(() => purchaseStore({ transaction, isUniqueViolation: () => false }).transaction({}, () => writes++),
      { name: 'NotWiredError', code: 'client_not_wired', seam: 'purchase-store-not-wired' });
    await settle();
    assert.equal(writes, 0);
  });
}
for (const classifier of [async () => false, function* () {}, async function* () {}]) {
  test(`a non-synchronous classifier refuses construction: ${classifier.constructor.name}`, () => {
    assert.throws(() => purchaseStore({ ...createSqlitePurchaseStore(), isUniqueViolation: classifier }), { code: 'client_not_wired' });
  });
}
for (const value of [true, false, undefined, 1, 'true']) {
  test(`the classifier requires a synchronous boolean result (${typeof value}, ${String(value)})`, () => {
    const store = purchaseStore({ ...createSqlitePurchaseStore(), isUniqueViolation: () => value });
    if (typeof value === 'boolean') assert.equal(store.isUniqueViolation(new Error('TEST')), value);
    else assert.throws(() => store.isUniqueViolation(new Error('TEST')), { code: 'purchase_store_invalid_classifier_result' });
  });
}
for (const native of [false, true]) {
  test(`classifier result inspection never adopts a thenable or reads a native promise then: native=${native}`, async () => {
    let thenCalls = 0;
    const result = native ? Promise.reject(new Error('TEST-classifier-rejection')) : { then() { thenCalls++; } };
    if (native) Object.defineProperty(result, 'then', { get() { assert.fail('native promise then getter ran'); } });
    const store = purchaseStore({ ...createSqlitePurchaseStore(), isUniqueViolation: () => result });
    assert.throws(() => store.isUniqueViolation(new Error('TEST-constraint')), { code: 'purchase_store_async_classifier_result' });
    await settle();
    assert.equal(thenCalls, 0);
  });
}
test('uniqueness uses native constraint codes, not error text', t => {
  const { db } = purchaseDatabase(t), store = purchaseStore(createSqlitePurchaseStore());
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE constraints_test(id TEXT UNIQUE, required TEXT NOT NULL, checked INTEGER CHECK(checked>0), parent TEXT REFERENCES records(id));
    INSERT INTO constraints_test VALUES ('TEST', 'TEST', 1, NULL);
    CREATE TRIGGER policy BEFORE INSERT ON records WHEN NEW.id='TEST-policy' BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: records.id'); END`);
  for (const [sql, unique] of [
    ["INSERT INTO constraints_test VALUES ('TEST','TEST',1,NULL)", true],
    ["INSERT INTO constraints_test VALUES ('TEST-null',NULL,1,NULL)", false],
    ["INSERT INTO constraints_test VALUES ('TEST-check','TEST',0,NULL)", false],
    ["INSERT INTO constraints_test VALUES ('TEST-fk','TEST',1,'TEST-missing')", false],
    ["INSERT INTO records VALUES ('TEST-policy')", false],
    ['TEST invalid SQL', false],
  ]) assert.throws(() => db.exec(sql), error => store.isUniqueViolation(error) === unique);
  assert.equal(store.isUniqueViolation(new Error('UNIQUE constraint failed')), false);
});

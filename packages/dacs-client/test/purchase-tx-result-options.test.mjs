import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { purchaseDatabase, durableIds } from './helpers/purchase-tx-fixtures.mjs';

function tempIds(db) {
  const statement = db.prepare('SELECT id FROM session ORDER BY id');
  statement.setReturnArrays?.(false); statement.setReadBigInts(false);
  return statement.all().map(row => row.id);
}
for (const readBigInts of [false, true]) for (const returnArrays of [false, true]) {
  const options = { readBigInts, returnArrays }, label = JSON.stringify(options);
  class OptionDatabase extends DatabaseSync {
    constructor(path) { super(path, options); }
  }
  const open = t => {
    const world = purchaseDatabase(t, undefined, { Database: OptionDatabase });
    world.db.exec('CREATE TEMP TABLE session(id TEXT)');
    return world;
  };
  test(`root and nested commits preserve caller results ${label}`, t => {
    const { db, path, store } = open(t), saved = db.prepare('SELECT 7 AS n'), expected = saved.get();
    assert.equal(store.transaction(db, () => {
      db.exec("INSERT INTO records VALUES ('TEST-root'); INSERT INTO session VALUES ('TEST-root')");
      return store.transaction(db, () => {
        db.exec("INSERT INTO records VALUES ('TEST-nested'); INSERT INTO session VALUES ('TEST-nested')");
        return 'TEST-result';
      });
    }), 'TEST-result');
    assert.deepEqual(durableIds(db, path), ['TEST-nested', 'TEST-root']);
    assert.deepEqual(tempIds(db), ['TEST-nested', 'TEST-root']);
    assert.deepEqual(saved.get(), expected);
    assert.deepEqual(db.prepare('SELECT 7 AS n').get(), expected);
  });
  test(`root rollback and retry preserve main and TEMP atomicity ${label}`, t => {
    const { db, path, store } = open(t), cause = new Error('TEST-root-failure');
    assert.throws(() => store.transaction(db, () => {
      store.transaction(db, () => db.exec("INSERT INTO records VALUES ('TEST-refused'); INSERT INTO session VALUES ('TEST-refused')"));
      throw cause;
    }), error => error === cause);
    assert.deepEqual(durableIds(db, path), []); assert.deepEqual(tempIds(db), []);
    store.transaction(db, () => db.exec("INSERT INTO records VALUES ('TEST-retry'); INSERT INTO session VALUES ('TEST-retry')"));
    assert.deepEqual(durableIds(db, path), ['TEST-retry']); assert.deepEqual(tempIds(db), ['TEST-retry']);
  });
  test(`caught nested rollback removes only nested main and TEMP writes ${label}`, t => {
    const { db, path, store } = open(t), cause = new Error('TEST-nested-failure');
    store.transaction(db, () => {
      db.exec("INSERT INTO records VALUES ('TEST-outer'); INSERT INTO session VALUES ('TEST-outer')");
      assert.throws(() => store.transaction(db, () => {
        db.exec("INSERT INTO records VALUES ('TEST-refused'); INSERT INTO session VALUES ('TEST-refused')");
        throw cause;
      }), error => error === cause);
    });
    assert.deepEqual(durableIds(db, path), ['TEST-outer']); assert.deepEqual(tempIds(db), ['TEST-outer']);
  });
}

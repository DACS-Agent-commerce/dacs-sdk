import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSqlitePurchaseDatabase } from '../src/util/sqlite-purchase-admission.mjs';
import { PROFILES, FILE_PROFILES, DEFAULT_PROFILE, label, purchaseDatabase, durableIds } from './helpers/purchase-tx-fixtures.mjs';

const pragma = (db, name) => Object.values(db.prepare(`PRAGMA ${name}`).get())[0];
const tempObjects = db => db.prepare('SELECT name FROM temp.sqlite_master ORDER BY name').all().map(row => row.name);
const callbackRan = () => assert.fail('callback ran');

test('every shared fixture profile is admitted and reads back as configured', t => {
  for (const profile of PROFILES) {
    const { db } = purchaseDatabase(t, profile);
    assert.doesNotThrow(() => checkSqlitePurchaseDatabase(db), label(profile));
    assert.equal(pragma(db, 'main.journal_mode'), profile.journal.toLowerCase());
    assert.equal(pragma(db, 'temp.journal_mode'), profile.temp.toLowerCase());
  }
});

for (const warm of [false, true]) for (const hostTemp of [false, true]) {
  test(`TEMP OFF is refused before the lease or callback, warm=${warm}, hostTemp=${hostTemp}`, t => {
    const { db, store } = purchaseDatabase(t);
    if (warm) store.transaction(db, () => {});
    if (hostTemp) db.exec("CREATE TEMP TABLE staging(id TEXT); INSERT INTO staging VALUES ('TEST-host')");
    db.exec('PRAGMA temp.journal_mode=OFF');
    const objects = tempObjects(db);
    assert.throws(() => store.transaction(db, callbackRan), { name: 'OperationError', code: 'purchase_store_unsupported_temp_journal_mode' });
    assert.deepEqual(tempObjects(db), objects);
    assert.equal(db.isTransaction, false);
    assert.equal(pragma(db, 'temp.journal_mode'), 'off');
    assert.equal(pragma(db, 'main.journal_mode'), 'wal');
    if (hostTemp) assert.deepEqual(durableIds(db, null, { volatile: true }, 'staging'), ['TEST-host']);
    db.exec('PRAGMA temp.journal_mode=DELETE');
    assert.equal(store.transaction(db, () => 'TEST-retry'), 'TEST-retry');
  });
}

// An inner call writes main and TEMP, then throws; its parent copies TEMP into main.
function copyRefusedTempWork(db, store, depth) {
  const inner = level => store.transaction(db, () => {
    db.exec(`INSERT INTO records VALUES ('TEST-refused-${level}'); INSERT INTO staging VALUES ('TEST-refused-${level}')`);
    if (level < depth) inner(level + 1);
    throw new Error('TEST-inner');
  });
  return store.transaction(db, () => {
    assert.throws(() => inner(2), /TEST-inner/);
    db.exec('INSERT INTO records SELECT id FROM staging');
    return 'TEST-committed';
  });
}
for (const temp of ['OFF', 'MEMORY']) for (const depth of [2, 3]) {
  test(`refused nested TEMP work cannot reach a durable commit, TEMP ${temp}, depth=${depth}`, t => {
    const { db, path, store } = purchaseDatabase(t);
    db.exec(`CREATE TEMP TABLE staging(id TEXT); PRAGMA temp.journal_mode=${temp}`);
    if (temp === 'OFF') assert.throws(() => copyRefusedTempWork(db, store, depth), { code: 'purchase_store_unsupported_temp_journal_mode' });
    else assert.equal(copyRefusedTempWork(db, store, depth), 'TEST-committed');
    assert.deepEqual(durableIds(db, null, { volatile: true }, 'staging'), []);
    assert.deepEqual(durableIds(db, path), []);
  });
}
for (const profile of PROFILES) {
  test(`nested and sequential refusals leave no TEMP or main rows: ${label(profile)}`, t => {
    const { db, path, store } = purchaseDatabase(t, profile);
    db.exec('CREATE TEMP TABLE staging(id TEXT)');
    assert.equal(copyRefusedTempWork(db, store, 2), 'TEST-committed');
    assert.throws(() => store.transaction(db, () => {
      db.exec("INSERT INTO staging VALUES ('TEST-outer'); INSERT INTO records VALUES ('TEST-outer')");
      throw new Error('TEST-outer');
    }), /TEST-outer/);
    assert.deepEqual(durableIds(db, null, { volatile: true }, 'staging'), []);
    assert.deepEqual(durableIds(db, path, profile), []);
  });
}
test('a callback cannot switch TEMP journaling off inside its transaction', t => {
  const { db, path, store } = purchaseDatabase(t);
  db.exec('CREATE TEMP TABLE staging(id TEXT)');
  store.transaction(db, () => {
    db.exec('PRAGMA temp.journal_mode=OFF');
    assert.equal(pragma(db, 'temp.journal_mode'), 'delete');
    assert.throws(() => store.transaction(db, () => {
      db.exec("INSERT INTO staging VALUES ('TEST-refused')");
      throw new Error('TEST-inner');
    }), /TEST-inner/);
    db.exec('INSERT INTO records SELECT id FROM staging');
  });
  assert.deepEqual(durableIds(db, path), []);
  assert.equal(pragma(db, 'temp.journal_mode'), 'delete');
});

const persistent = { code: 'purchase_store_persistent_attachment' };
const attach = 'ATTACH DATABASE ? AS "attached archive"';
function attachable(t, profile = DEFAULT_PROFILE) {
  const world = purchaseDatabase(t, profile), auxiliary = join(world.dir, 'aux.sqlite');
  const aux = new DatabaseSync(auxiliary);
  aux.exec('CREATE TABLE records(id TEXT)');
  aux.close();
  return { ...world, auxiliary };
}
for (const profile of FILE_PROFILES.filter(({ journal }) => journal !== 'TRUNCATE')) for (const warm of [false, true]) for (const hostTransaction of [false, true]) {
  test(`persistent attachment is refused before callback or host work changes: ${label(profile)}, warm=${warm}, hostTransaction=${hostTransaction}`, t => {
    const { db, auxiliary, store } = attachable(t, profile);
    if (warm) store.transaction(db, () => {});
    db.prepare(attach).run(auxiliary);
    if (hostTransaction) db.exec("BEGIN; INSERT INTO records VALUES ('TEST-host')");
    assert.throws(() => store.transaction(db, callbackRan), persistent);
    assert.equal(db.isTransaction, hostTransaction);
    if (hostTransaction) {
      assert.equal(db.prepare('SELECT id FROM records').get().id, 'TEST-host');
      db.exec('ROLLBACK');
    }
    db.exec('DETACH DATABASE "attached archive"');
    store.transaction(db, () => db.exec("INSERT INTO records VALUES ('TEST-retry')"));
    assert.equal(db.prepare('SELECT id FROM records').get().id, 'TEST-retry');
  });
}
const guardedAttachment = { name: 'TypeError', message: /unsupported by the statement guard/ };
for (const nested of [false, true]) for (const following of ['last', 'batch', 'prepared', 'caught']) {
  test(`an attachment during the callback rolls back both files, nested=${nested}, following=${following}`, t => {
    const { db, path, auxiliary, store } = attachable(t);
    const body = () => {
      db.exec("INSERT INTO records VALUES ('TEST-before')");
      if (following === 'batch') {
        db.exec(`ATTACH DATABASE '${auxiliary.replaceAll("'", "''")}' AS "attached archive"; INSERT INTO "attached archive".records VALUES ('TEST-aux')`);
      } else {
        db.prepare(attach).run(auxiliary);
        if (following === 'prepared') db.prepare('INSERT INTO "attached archive".records VALUES (?)').run('TEST-aux');
        if (following === 'caught') assert.throws(() => db.exec("INSERT INTO records VALUES ('TEST-after')"), persistent);
      }
    };
    assert.throws(() => store.transaction(db, () => nested ? store.transaction(db, body) : body()), guardedAttachment);
    for (const file of [path, auxiliary]) assert.deepEqual(durableIds(db, file), []);
    if (db.isOpen) {
      assert.equal(db.isTransaction, false);
      assert.equal(db.prepare('PRAGMA database_list').all().some(row => row.name === 'attached archive'), false);
      assert.equal(store.transaction(db, () => 'TEST-retry'), 'TEST-retry');
    }
  });
}
for (const volatileMain of [false, true]) for (const file of [':memory:', '']) for (const nested of [false, true]) {
  test(`volatile attachments are refused before callback entry, volatile main=${volatileMain}, file=${JSON.stringify(file)}, nested=${nested}`, t => {
    const profile = PROFILES.find(candidate => Boolean(candidate.volatile) === volatileMain);
    const { db, store } = purchaseDatabase(t, profile), refused = { code: 'purchase_store_unsupported_attachment' };
    const body = () => {
      db.prepare('ATTACH ? AS volatile').run(file);
      assert.throws(() => store.transaction(db, callbackRan), refused);
    };
    if (nested) assert.throws(() => store.transaction(db, body), guardedAttachment);
    else body();
    if (!nested) db.exec('DETACH volatile');
    else assert.equal(db.prepare('PRAGMA database_list').all().some(row => row.name === 'volatile'), false);
    db.exec('CREATE TEMP TABLE session(id TEXT)');
    store.transaction(db, () => db.exec("INSERT INTO records VALUES ('TEST-main'); INSERT INTO session VALUES ('TEST-temp')"));
    for (const table of ['records', 'session']) assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 1);
  });
}

for (const [journal, synchronous, code] of [
  ['OFF', 'EXTRA', 'purchase_store_unsupported_journal_mode'], ['MEMORY', 'EXTRA', 'purchase_store_unsupported_journal_mode'],
  ['DELETE', 'FULL', 'purchase_store_unsupported_synchronous'], ['TRUNCATE', 'NORMAL', 'purchase_store_unsupported_synchronous'],
  ['PERSIST', 'FULL', 'purchase_store_unsupported_synchronous'], ['WAL', 'NORMAL', 'purchase_store_unsupported_synchronous'],
  ['WAL', 'OFF', 'purchase_store_unsupported_synchronous'],
]) for (const warm of [false, true]) {
  test(`main ${journal}/${synchronous} is refused without changing configuration or host work, warm=${warm}`, t => {
    const { db, path, store } = purchaseDatabase(t);
    if (warm) store.transaction(db, () => {});
    db.exec(`PRAGMA journal_mode=${journal}; PRAGMA synchronous=${synchronous}; INSERT INTO records VALUES ('TEST-host')`);
    const settings = [pragma(db, 'main.journal_mode'), pragma(db, 'main.synchronous')];
    assert.throws(() => store.transaction(db, callbackRan), { name: 'OperationError', code });
    assert.deepEqual([pragma(db, 'main.journal_mode'), pragma(db, 'main.synchronous')], settings);
    assert.equal(db.isTransaction, false);
    assert.deepEqual(durableIds(db, path), ['TEST-host']);
  });
}

const original = 'a'.repeat(10_000), ROWS = 200;
function spillable(t, profile) {
  const world = purchaseDatabase(t, profile, { schema: 'CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT NOT NULL)' });
  const insert = world.db.prepare('INSERT INTO records(value) VALUES (?)');
  world.store.transaction(world.db, () => { for (let i = 0; i < ROWS; i++) insert.run(original); });
  world.db.exec('PRAGMA cache_size=10');
  return world;
}
function assertUnchanged(path, value = original) {
  const reopened = new DatabaseSync(path);
  try { assert.deepEqual(reopened.prepare('SELECT value, count(*) n FROM records GROUP BY value').all().map(row => [row.value, row.n]), [[value, ROWS]]); }
  finally { reopened.close(); }
}
for (const profile of FILE_PROFILES) {
  test(`spilled writes never survive a failed transaction: ${label(profile)}`, t => {
    const { db, path, store } = spillable(t, profile), cause = new Error('TEST-rollback');
    assert.throws(() => store.transaction(db, () => {
      db.prepare('UPDATE records SET value=?').run('b'.repeat(10_000));
      throw cause;
    }), error => error === cause);
    assert.equal(db.isTransaction, false);
    assertUnchanged(path);
  });
  for (const stage of ['before-commit', 'after-commit']) {
    test(`process exit ${stage} leaves one complete state on reopen: ${label(profile)}`, t => {
      const { db, path } = spillable(t, profile);
      db.close();
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('./helpers/purchase-tx-exit-worker.mjs', import.meta.url)), path, JSON.stringify(profile), stage], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.stdout, stage === 'before-commit' ? 'TEST-before-commit' : 'TEST-committed');
      assertUnchanged(path, stage === 'before-commit' ? original : 'b'.repeat(10_000));
    });
  }
}

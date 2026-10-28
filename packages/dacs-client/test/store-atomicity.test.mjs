import test from 'node:test';
import assert from 'node:assert/strict';
import { purchaseStore } from '../src/seams/purchase-store-not-wired.mjs';

for (const kind of ['callback-then-thenable', 'deferred', 'pass-through']) {
  test(`unqualified ${kind} transaction is refused before its callback can write`, async () => {
    let writes = 0;
    const transaction = kind === 'callback-then-thenable' ? (_db, fn) => { fn(); return Promise.resolve(); }
      : kind === 'deferred' ? (_db, fn) => Promise.resolve().then(fn) : (_db, fn) => fn();
    assert.throws(() => {
      const seam = purchaseStore({ transaction, isUniqueViolation: () => false });
      seam.transaction({}, () => writes++);
    }, { code: 'client_not_wired' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes, 0);
  });
}

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createSqlitePurchaseStore } from '../src/seams/purchase-store-not-wired.mjs';

test('a compatible-looking non-DatabaseSync handle is refused before database or callback access', () => {
  let calls = 0;
  const db = { prepare() { calls++; }, exec() { calls++; } };
  assert.throws(() => createSqlitePurchaseStore().transaction(db, () => { calls++; }),
    { code: 'client_not_wired', seam: 'purchase-store-not-wired' });
  assert.equal(calls, 0);
});

function database(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dacs-store-'));
  const path = join(dir, 'state.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE records (id TEXT PRIMARY KEY)');
  t.after(() => {
    try { db.close(); } catch (error) { assert.equal(error.code, 'ERR_INVALID_STATE'); }
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, path };
}
test('concrete adapter commits nested writes and rolls back the original thrown error', t => {
  const { db } = database(t), store = purchaseStore(createSqlitePurchaseStore()), cause = new Error('TEST-rollback');
  const write = id => db.prepare('INSERT INTO records VALUES (?)').run(id);
  assert.throws(() => store.transaction(db, () => {
    write('TEST-outer');
    store.transaction(db, () => write('TEST-inner'));
    throw cause;
  }), error => error === cause);
  assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 0);
  assert.equal(store.transaction(db, () => { write('TEST-first'); return store.transaction(db, () => { write('TEST-second'); return 'TEST-result'; }); }), 'TEST-result');
  assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 2);
});
test('caught nested synchronous error rolls back only that call and leaves the outer transaction usable', t => {
    const { db } = database(t), store = createSqlitePurchaseStore(), cause = new Error('TEST-inner');
    const write = id => db.prepare('INSERT INTO records VALUES (?)').run(id);
    store.transaction(db, () => {
      write('TEST-outer');
      assert.throws(() => store.transaction(db, () => {
        write('TEST-refused');
        store.transaction(db, () => write('TEST-refused-child'));
        throw cause;
      }), error => error === cause);
      store.transaction(db, () => write('TEST-after'));
    });
    assert.deepEqual(db.prepare('SELECT id FROM records ORDER BY id').all().map(row => row.id), ['TEST-after', 'TEST-outer']);
});
for (const rejected of [false, true]) {
  test(`caught nested thenable retires the entire transaction, rejected=${rejected}`, async t => {
    const { db, path } = database(t), store = createSqlitePurchaseStore();
    let called = false;
    const insert = db.prepare('INSERT INTO records VALUES (?)');
    assert.throws(() => store.transaction(db, () => {
      insert.run('TEST-outer');
      assert.throws(() => store.transaction(db, () => {
        insert.run('TEST-inner');
        store.transaction(db, () => insert.run('TEST-inner-child'));
        return rejected ? Promise.reject(new Error('TEST-refused')) : Promise.resolve();
      }), { code: 'client_not_wired' });
      assert.throws(() => insert.run('TEST-after'), /closed|not open|finalized/i);
      assert.throws(() => store.transaction(db, () => { called = true; }), { code: 'client_not_wired' });
    }), { code: 'client_not_wired' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(called, false);
    const reopened = new DatabaseSync(path);
    try { assert.equal(reopened.prepare('SELECT count(*) n FROM records').get().n, 0); }
    finally { reopened.close(); }
  });
}
for (const kind of ['conflict', 'trigger']) {
  test(`nested automatic rollback (${kind}) closes the connection before a catching outer body can write`, t => {
    const { db, path } = database(t), store = createSqlitePurchaseStore();
    db.exec("INSERT INTO records VALUES ('TEST-existing')");
    if (kind === 'trigger') db.exec(`CREATE TRIGGER abort_insert BEFORE INSERT ON records
      WHEN NEW.id = 'TEST-abort' BEGIN SELECT RAISE(ROLLBACK, 'TEST-trigger-rollback'); END`);
    const insert = db.prepare('INSERT INTO records VALUES (?)');
    const caught = fn => { try { fn(); } catch (error) { return error; } };
    let innerError, directError, execError, nestedError, called = false, finished = false;
    const outerError = caught(() => store.transaction(db, () => {
      insert.run('TEST-outer');
      innerError = caught(() => store.transaction(db, () => {
        insert.run('TEST-inner');
        if (kind === 'conflict') db.exec("INSERT OR ROLLBACK INTO records VALUES ('TEST-existing')");
        else insert.run('TEST-abort');
      }));
      directError = caught(() => insert.run('TEST-autocommit'));
      execError = caught(() => db.exec("INSERT INTO records VALUES ('TEST-autocommit-exec')"));
      nestedError = caught(() => store.transaction(db, () => { called = true; }));
      // Catching all inner errors still cannot turn the outer call into success.
      finished = true;
      return 'TEST-caught';
    }));
    assert.equal(finished, true);
    assert.ok(outerError);
    assert.match(innerError.message, kind === 'conflict' ? /UNIQUE constraint/ : /TEST-trigger-rollback/);
    assert.throws(() => db.prepare('SELECT 1'), /closed|not open/i, 'recovery failure closes the connection before returning the inner error');
    assert.match(directError?.message ?? '', /closed|not open|finalized/i);
    assert.match(execError?.message ?? '', /closed|not open/i);
    assert.equal(nestedError?.code, 'client_not_wired');
    assert.equal(called, false);
    const reopened = new DatabaseSync(path);
    try {
      assert.deepEqual(reopened.prepare('SELECT id FROM records').all().map(row => row.id), ['TEST-existing']);
      store.transaction(reopened, () => reopened.prepare('INSERT INTO records VALUES (?)').run('TEST-retry'));
      assert.equal(reopened.prepare('SELECT count(*) n FROM records').get().n, 2);
    } finally { reopened.close(); }
    db.open();
    called = false;
    assert.throws(() => store.transaction(db, () => { called = true; }), { code: 'client_not_wired' });
    assert.equal(called, false, 'the failed handle stays fenced even if the host reopens it');
  });
}
for (const rejected of [false, true]) {
  test(`callback-then-thenable rolls back and retires its handle, rejected=${rejected}`, async t => {
    const { db, path } = database(t), store = createSqlitePurchaseStore();
    assert.throws(() => store.transaction(db, () => {
      db.prepare('INSERT INTO records VALUES (?)').run('TEST-thenable');
      return rejected ? Promise.reject(new Error('TEST-refused')) : Promise.resolve();
    }), { code: 'client_not_wired' });
    await new Promise(resolve => setImmediate(resolve));
    assert.throws(() => store.transaction(db, () => 'TEST-retry'), { code: 'client_not_wired' });
    const reopened = new DatabaseSync(path);
    try {
      assert.equal(reopened.prepare('SELECT count(*) n FROM records').get().n, 0);
      assert.equal(store.transaction(reopened, () => 'TEST-retry'), 'TEST-retry');
    } finally { reopened.close(); }
  });
}

for (const depth of ['outer', 'nested']) for (const kind of ['conflict', 'trigger']) {
  test(`${depth} body catching its own ${kind} rollback cannot autocommit any later write`, t => {
    const { db, path } = database(t), store = createSqlitePurchaseStore();
    db.exec("INSERT INTO records VALUES ('TEST-existing'); CREATE TABLE sibling (id TEXT PRIMARY KEY)");
    if (kind === 'trigger') db.exec(`CREATE TRIGGER abort_insert BEFORE INSERT ON records
      WHEN NEW.id = 'TEST-abort' BEGIN SELECT RAISE(ROLLBACK, 'TEST-trigger-rollback'); END`);
    // Statements prepared before guard installation must be protected too.
    const insert = db.prepare('INSERT INTO records VALUES (?)');
    const update = db.prepare('UPDATE records SET id=? WHERE id=?');
    const remove = db.prepare('DELETE FROM records');
    const returning = db.prepare('INSERT INTO sibling VALUES (?) RETURNING id');
    let cause;
    const body = () => {
      insert.run('TEST-before');
      try {
        if (kind === 'conflict') db.exec("INSERT OR ROLLBACK INTO records VALUES ('TEST-existing')");
        else insert.run('TEST-abort');
      } catch (error) { cause = error; }
      assert.match(cause?.message ?? '', kind === 'conflict' ? /UNIQUE constraint/ : /TEST-trigger-rollback/);
      for (const write of [
        () => insert.run('TEST-after'),
        () => db.exec("INSERT INTO records VALUES ('TEST-exec')"),
        () => db.exec("INSERT OR IGNORE INTO records VALUES ('TEST-existing')"),
        () => db.exec("INSERT OR REPLACE INTO records VALUES ('TEST-existing')"),
        () => db.exec("INSERT INTO records VALUES ('TEST-existing') ON CONFLICT(id) DO UPDATE SET id='TEST-upsert'"),
        () => update.run('TEST-changed', 'TEST-existing'),
        () => remove.run(),
        () => returning.get('TEST-get'),
        () => returning.all('TEST-all'),
        () => [...returning.iterate('TEST-iterate')],
      ]) assert.throws(write, /transaction ended|closed|not open|finalized/i);
      return 'TEST-caught';
    };
    assert.throws(() => store.transaction(db, () => depth === 'nested' ? store.transaction(db, body) : body()));
    if (depth === 'nested') assert.throws(() => db.prepare('SELECT 1'), /closed|not open/i);
    else {
      assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 1);
      assert.equal(store.transaction(db, () => 'TEST-retry'), 'TEST-retry');
    }
    const reopened = new DatabaseSync(path);
    try {
      assert.deepEqual(reopened.prepare('SELECT id FROM records').all().map(row => row.id), ['TEST-existing']);
      assert.deepEqual(reopened.prepare('SELECT id FROM sibling').all(), []);
      store.transaction(reopened, () => reopened.prepare('INSERT INTO records VALUES (?)').run('TEST-retry'));
      assert.equal(reopened.prepare('SELECT count(*) n FROM records').get().n, 2);
      // Unarmed connection guards permit host writes outside package calls.
      reopened.exec("INSERT INTO sibling VALUES ('TEST-outside')");
    } finally { reopened.close(); }
  });
}

test('a caught recoverable statement error still permits a complete commit', t => {
  const { db, path } = database(t), store = createSqlitePurchaseStore();
  db.exec("INSERT INTO records VALUES ('TEST-existing')");
  store.transaction(db, () => {
    db.exec("INSERT INTO records VALUES ('TEST-before')");
    assert.throws(() => db.exec("INSERT INTO records VALUES ('TEST-existing')"), /UNIQUE constraint/);
    db.exec("INSERT INTO records VALUES ('TEST-after')");
  });
  const reopened = new DatabaseSync(path);
  try { assert.equal(reopened.prepare('SELECT count(*) n FROM records').get().n, 3); }
  finally { reopened.close(); }
  assert.ok(db.prepare("SELECT count(*) n FROM sqlite_temp_master WHERE type='trigger'").get().n >= 3);
  db.exec("INSERT INTO records VALUES ('TEST-outside')");
});

test('automatic rollback guards TEMP and attached tables, including quoted host identifiers', t => {
  const { db, path } = database(t), store = createSqlitePurchaseStore();
  db.exec(`INSERT INTO records VALUES ('TEST-existing');
    CREATE TEMP TABLE "TEST-temp" (id TEXT);`);
  db.prepare('ATTACH DATABASE ? AS "TEST-attached"').run(`${path}.attached`);
  db.exec('CREATE TABLE "TEST-attached"."TEST-table" (id TEXT)');
  const tempInsert = db.prepare('INSERT INTO "TEST-temp" VALUES (?)');
  const attachedInsert = db.prepare('INSERT INTO "TEST-attached"."TEST-table" VALUES (?)');
  assert.throws(() => store.transaction(db, () => {
    tempInsert.run('TEST-before');
    attachedInsert.run('TEST-before');
    assert.throws(() => db.exec("INSERT OR ROLLBACK INTO records VALUES ('TEST-existing')"), /UNIQUE constraint/);
    assert.throws(() => tempInsert.run('TEST-after'), /transaction ended/);
    assert.throws(() => attachedInsert.run('TEST-after'), /transaction ended/);
    assert.equal(db.prepare('SELECT count(*) n FROM "TEST-temp"').get().n, 0);
  }), { code: 'client_not_wired' });
  const reopened = new DatabaseSync(`${path}.attached`);
  try { assert.equal(reopened.prepare('SELECT count(*) n FROM "TEST-table"').get().n, 0); }
  finally { reopened.close(); }
});
test('BEGIN IMMEDIATE blocks a second connection before its callback and permits retry', t => {
  const { db, path } = database(t), second = new DatabaseSync(path), store = createSqlitePurchaseStore();
  t.after(() => second.close());
  second.exec('PRAGMA busy_timeout=0');
  let called = false;
  store.transaction(db, () => {
    assert.throws(() => store.transaction(second, () => { called = true; }), /locked/);
    assert.equal(called, false);
  });
  assert.equal(store.transaction(second, () => 'TEST-retry'), 'TEST-retry');
});
for (const stage of ['before-commit', 'after-commit']) {
  test(`process death ${stage} preserves atomic state on reopen`, t => {
    const { db, path } = database(t);
    const result = spawnSync(process.execPath, [new URL('./helpers/store-crash-worker.mjs', import.meta.url).pathname, path, stage], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, stage === 'before-commit' ? 0 : 2);
    const reopened = new DatabaseSync(path);
    try { assert.equal(reopened.prepare('SELECT count(*) n FROM records').get().n, stage === 'before-commit' ? 0 : 2); } finally { reopened.close(); }
  });
}
for (const classifier of [async () => false, function* () {}, async function* () {}]) {
  test(`non-synchronous classifier refuses construction: ${classifier.constructor.name}`, () => {
    assert.throws(() => purchaseStore({ ...createSqlitePurchaseStore(), isUniqueViolation: classifier }), { code: 'client_not_wired' });
  });
}

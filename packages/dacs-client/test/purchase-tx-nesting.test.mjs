import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { purchaseDatabase, durableIds, LegacyDatabase } from './helpers/purchase-tx-fixtures.mjs';
import { collectGarbage } from './helpers/collect-garbage.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
const ended = /transaction ended|closed|not open|finalized/i;
// Every case also runs with isTransaction hidden, as on the oldest supported Node versions.
const RUNTIMES = [['current', DatabaseSync], ['legacy', LegacyDatabase]];
const world = (t, Database) => {
  const opened = purchaseDatabase(t, undefined, { Database });
  return { ...opened, write: id => opened.db.prepare('INSERT INTO records VALUES (?)').run(id) };
};

for (const [runtime, Database] of RUNTIMES) {
  test(`nested calls join the outer commit and an outer throw rolls all back: ${runtime}`, t => {
    const { db, path, store, write } = world(t, Database), cause = new Error('TEST-rollback');
    assert.throws(() => store.transaction(db, () => {
      write('TEST-outer');
      store.transaction(db, () => write('TEST-inner'));
      throw cause;
    }), error => error === cause);
    assert.deepEqual(durableIds(db, path), []);
    assert.equal(store.transaction(db, () => { write('TEST-first'); return store.transaction(db, () => { write('TEST-second'); return 'TEST-result'; }); }), 'TEST-result');
    assert.deepEqual(durableIds(db, path), ['TEST-first', 'TEST-second']);
  });
  test(`a caught nested error rolls back only its savepoint, at three levels: ${runtime}`, t => {
    const { db, path, store, write } = world(t, Database), cause = new Error('TEST-inner');
    store.transaction(db, () => {
      write('TEST-outer');
      assert.throws(() => store.transaction(db, () => {
        write('TEST-refused');
        store.transaction(db, () => write('TEST-refused-child'));
        throw cause;
      }), error => error === cause);
      store.transaction(db, () => {
        assert.throws(() => store.transaction(db, () => { write('TEST-refused-grandchild'); throw cause; }), error => error === cause);
        write('TEST-after');
      });
    });
    assert.deepEqual(durableIds(db, path), ['TEST-after', 'TEST-outer']);
  });
  test(`the commit barrier is restored after nested entry, failure and repeat: ${runtime}`, t => {
    const { db, path, store, write } = world(t, Database);
    assert.throws(() => store.transaction(db, () => {
      write('TEST-partial');
      store.transaction(db, () => write('TEST-nested'));
      assert.throws(() => store.transaction(db, () => { throw new Error('TEST-inner'); }), /TEST-inner/);
      store.transaction(db, () => store.transaction(db, () => write('TEST-deep')));
      for (const sql of ['COMMIT', 'END']) assert.throws(() => db.exec(sql), /statements in progress/);
      throw new Error('TEST-after-control');
    }), /TEST-after-control/);
    assert.deepEqual(durableIds(db, path), []);
  });
  test(`a garbage collection in a root or nested body keeps the commit barrier and the commit: ${runtime}`, t => {
    const { db, path, store, write } = world(t, Database);
    store.transaction(db, () => {
      write('TEST-root');
      collectGarbage();
      store.transaction(db, () => { collectGarbage(); write('TEST-nested'); });
      collectGarbage();
      assert.throws(() => db.exec('COMMIT'), /statements in progress/);
    });
    assert.deepEqual(durableIds(db, path), ['TEST-nested', 'TEST-root']);
  });
  test(`guessed package savepoint names cannot be rolled back: ${runtime}`, t => {
    const { db, path, store, write } = world(t, Database);
    store.transaction(db, () => {
      assert.equal(store.transaction(db, () => {
        write('TEST-kept');
        assert.throws(() => db.exec('ROLLBACK TO dacs_purchase_1'), /no such savepoint/);
        return 'TEST-success';
      }), 'TEST-success');
    });
    assert.deepEqual(durableIds(db, path), ['TEST-kept']);
  });
  test(`a caught nested deferred result retires the whole transaction: ${runtime}`, async t => {
    const { db, path, store } = world(t, Database);
    const insert = db.prepare('INSERT INTO records VALUES (?)');
    let called = false;
    assert.throws(() => store.transaction(db, () => {
      insert.run('TEST-outer');
      assert.throws(() => store.transaction(db, () => {
        insert.run('TEST-inner');
        return Promise.reject(new Error('TEST-refused'));
      }), { code: 'purchase_store_async_result' });
      assert.throws(() => insert.run('TEST-after'), ended);
      assert.throws(() => store.transaction(db, () => { called = true; }), { code: 'purchase_store_retired_handle' });
    }), { code: 'purchase_store_transaction_ended' });
    await settle();
    assert.equal(called, false);
    assert.deepEqual(durableIds(db, path), []);
  });
  test(`a retired handle reopened inside a catching callback cannot autocommit: ${runtime}`, t => {
    const { db, path, store } = world(t, Database);
    db.exec("INSERT INTO records VALUES ('TEST-existing')");
    assert.throws(() => store.transaction(db, () => store.transaction(db, () => {
      assert.throws(() => store.transaction(db, () => db.exec("INSERT OR ROLLBACK INTO records VALUES ('TEST-existing')")), /UNIQUE/);
      db.open();
      assert.throws(() => db.exec("INSERT INTO records VALUES ('TEST-escaped')"), /transaction ended/);
    })));
    assert.deepEqual(durableIds(db, path), ['TEST-existing']);
    assert.throws(() => store.transaction(db, () => {}), { code: 'purchase_store_retired_handle' });
  });
  for (const depth of ['outer', 'nested']) for (const kind of ['conflict', 'trigger']) {
    test(`a ${depth} body catching its own ${kind} rollback cannot write afterwards: ${runtime}`, t => {
      const { db, path, store } = world(t, Database);
      db.exec("INSERT INTO records VALUES ('TEST-existing'); CREATE TABLE sibling (id TEXT PRIMARY KEY); CREATE TEMP TABLE session (id TEXT)");
      if (kind === 'trigger') db.exec(`CREATE TRIGGER abort_insert BEFORE INSERT ON records
        WHEN NEW.id = 'TEST-abort' BEGIN SELECT RAISE(ROLLBACK, 'TEST-trigger-rollback'); END`);
      // Statements prepared before the adapter's first call are guarded too.
      const insert = db.prepare('INSERT INTO records VALUES (?)'), update = db.prepare('UPDATE records SET id=? WHERE id=?');
      const remove = db.prepare('DELETE FROM records'), returning = db.prepare('INSERT INTO sibling VALUES (?) RETURNING id');
      const body = () => {
        insert.run('TEST-before');
        assert.throws(() => kind === 'conflict' ? db.exec("INSERT OR ROLLBACK INTO records VALUES ('TEST-existing')") : insert.run('TEST-abort'),
          kind === 'conflict' ? /UNIQUE constraint/ : /TEST-trigger-rollback/);
        for (const write of [
          () => insert.run('TEST-after'), () => db.exec("INSERT INTO records VALUES ('TEST-exec')"),
          () => db.exec("INSERT OR IGNORE INTO records VALUES ('TEST-existing')"), () => db.exec("INSERT OR REPLACE INTO records VALUES ('TEST-existing')"),
          () => db.exec("INSERT INTO records VALUES ('TEST-existing') ON CONFLICT(id) DO UPDATE SET id='TEST-upsert'"),
          () => update.run('TEST-changed', 'TEST-existing'), () => remove.run(), () => returning.get('TEST-get'),
          () => returning.all('TEST-all'), () => [...returning.iterate('TEST-iterate')], () => db.exec("INSERT INTO session VALUES ('TEST-temp')"),
        ]) assert.throws(write, ended);
        return 'TEST-caught';
      };
      assert.throws(() => store.transaction(db, () => depth === 'nested' ? store.transaction(db, body) : body()));
      if (depth === 'nested') assert.throws(() => db.prepare('SELECT 1'), ended);
      else {
        assert.deepEqual(durableIds(db, null, { volatile: true }, 'session'), []);
        assert.equal(store.transaction(db, () => 'TEST-retry'), 'TEST-retry');
      }
      assert.deepEqual(durableIds(db, path), ['TEST-existing']);
      assert.deepEqual(durableIds(db, path, undefined, 'sibling'), []);
    });
  }
}

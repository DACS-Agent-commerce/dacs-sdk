import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { withSqliteStatementGuard } from '../src/util/sqlite-statement-boundary.mjs';

const nativeExec = DatabaseSync.prototype.exec;
const nativePrepare = DatabaseSync.prototype.prepare;
const probe = new DatabaseSync(':memory:');
const nativeGet = Object.getPrototypeOf(probe.prepare('SELECT 1')).get;
probe.close();
const policy = db => Number(nativeGet.call(nativePrepare.call(db, 'PRAGMA query_only')).query_only);

function world(t, readBigInts) {
  const db = new DatabaseSync(':memory:', { readBigInts });
  t.after(() => db.close());
  db.exec('CREATE TABLE records(id TEXT)');
  withSqliteStatementGuard(db, () => {}, () => {});
  return db;
}

for (const readBigInts of [false, true]) {
  for (const method of ['exec', 'run', 'get', 'all', 'iterate', 'next']) {
    test(`writable nested guards commit ${method} with readBigInts=${readBigInts}`, t => {
      const db = world(t, readBigInts);
      const sql = "INSERT INTO records VALUES ('TEST-guarded') RETURNING id";
      const statement = db.prepare(sql);
      const earlier = method === 'next' ? statement.iterate() : undefined;
      db.exec('BEGIN');
      try {
        withSqliteStatementGuard(db, () => {}, () => {
          withSqliteStatementGuard(db, () => {}, () => {
            if (method === 'exec') db.exec(sql);
            else if (method === 'next' || method === 'iterate') {
              const iterator = earlier ?? statement.iterate();
              try { assert.equal(iterator.next().value.id, 'TEST-guarded'); }
              finally { iterator.return(); }
            } else statement[method]();
            assert.equal(policy(db), 1);
            assert.throws(() => nativeExec.call(db, "INSERT INTO records VALUES ('TEST-captured')"), /readonly/);
          });
          assert.equal(policy(db), 1);
        });
        assert.equal(policy(db), 0);
        db.exec('COMMIT');
        assert.equal(Number(db.prepare('SELECT count(*) n FROM records').get().n), 1);
      } finally { earlier?.return(); }
    });
  }

  for (const saved of [0, 1]) {
    for (const sql of ['PRAGMA query_only=OFF', '/* TEST-policy */ PRAGMA main."QuErY_OnLy" (FALSE)', "-- TEST-policy\n PRAGMA [query_only]='unknown'"]) {
      for (const method of ['exec', 'prepare', 'run', 'get', 'all', 'iterate', 'next']) {
        test(`saved policy ${saved} refuses ${method} setter with readBigInts=${readBigInts}: ${sql}`, t => {
          const db = world(t, readBigInts);
          const statement = db.prepare(sql);
          const iterator = method === 'next' ? statement.iterate() : undefined;
          db.exec(`PRAGMA query_only=${saved}`);
          try {
            withSqliteStatementGuard(db, () => {}, () => {
              withSqliteStatementGuard(db, () => {}, () => {
                assert.throws(() => {
                  if (method === 'exec') db.exec(`${sql}; INSERT INTO records VALUES ('TEST-late')`);
                  else if (method === 'prepare') db.prepare(sql);
                  else if (method === 'next') iterator.next();
                  else statement[method]();
                }, /read-only policy/);
                assert.equal(policy(db), 1);
                assert.throws(() => nativeExec.call(db, "INSERT INTO records VALUES ('TEST-captured')"), /readonly/);
              });
              assert.equal(policy(db), 1);
              if (saved) assert.throws(() => db.exec("INSERT INTO records VALUES ('TEST-after')"), /readonly/);
              else db.exec("INSERT INTO records VALUES ('TEST-after')");
            });
            assert.equal(policy(db), saved);
            assert.equal(Number(db.prepare('SELECT count(*) n FROM records').get().n), saved ? 0 : 1);
          } finally { iterator?.return(); }
        });
      }
    }

    test(`a throwing nested guard restores saved policy ${saved} with readBigInts=${readBigInts}`, t => {
      const db = world(t, readBigInts), cause = new Error('TEST-body-error');
      db.exec(`PRAGMA query_only=${saved}`);
      assert.throws(() => withSqliteStatementGuard(db, () => {}, () => {
        withSqliteStatementGuard(db, () => {}, () => {
          if (saved) assert.throws(() => db.exec("INSERT INTO records VALUES ('TEST-error')"), /readonly/);
          else db.prepare("INSERT INTO records VALUES ('TEST-error')").run();
          throw cause;
        });
      }), error => error === cause);
      assert.equal(policy(db), saved);
    });
  }
}

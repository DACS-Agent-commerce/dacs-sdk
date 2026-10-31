import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MODULE_URL = new URL('../src/util/guarded-sqlite.mjs', import.meta.url).href;
const LEASE_LOST = { code: 'lease_lost', message: 'commit refused: lease lost' };
function sqlitePrototypes() {
  const db = new DatabaseSync(':memory:');
  try {
    const statement = db.prepare('SELECT 1');
    return [DatabaseSync.prototype, Object.getPrototypeOf(statement), Object.getPrototypeOf(statement.iterate())]
      .map(prototype => Object.getOwnPropertyDescriptors(prototype));
  } finally { db.close(); }
}
// Taken before the module is imported, so import-time changes count too.
const untouched = sqlitePrototypes();
const { claimSqliteWriteLease, withSqliteWriteLease } = await import(MODULE_URL);

// Two connections to one file stand for two workers of the same program.
function workers(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dacs-lease-'));
  const file = join(dir, 'store.sqlite');
  const first = new DatabaseSync(file), second = new DatabaseSync(file);
  t.after(() => { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); });
  first.exec('CREATE TABLE records(id TEXT PRIMARY KEY)');
  return { file, first, second };
}
const count = db => db.prepare('SELECT count(*) AS n FROM records').get().n;
const leaseRow = db => ({ ...db.prepare('SELECT owner, epoch FROM dacs_write_lease').get() });

test('a worker whose lease was claimed by another commits nothing and its body never runs', t => {
  const { first, second } = workers(t);
  const stale = claimSqliteWriteLease(first), current = claimSqliteWriteLease(second);
  assert.equal(current.epoch, stale.epoch + 1);
  let ran = false;
  assert.throws(() => withSqliteWriteLease(first, stale, () => { ran = true; }), LEASE_LOST);
  assert.equal(ran, false);
  withSqliteWriteLease(second, current, () => second.exec("INSERT INTO records VALUES ('TEST-current')"));
  assert.equal(count(first), 1);
});

// Each entry is a path an earlier review used to run SQL or application code
// in the middle of a guarded write. `rival` is another worker claiming the
// lease at that moment. Setup runs after the claim, before the transaction.
const WRITE_PATHS = {
  'a statement prepared before the transaction': db => {
    const early = db.prepare('INSERT INTO records VALUES (?)');
    return rival => { rival(); early.run('TEST-early'); };
  },
  'an iterator created before the transaction': db => {
    const rows = db.prepare("SELECT 'TEST-iterated' AS id UNION ALL SELECT 'TEST-iterated-2'").iterate();
    rows.next();
    return rival => { rival(); db.prepare('INSERT INTO records VALUES (?)').run(rows.next().value.id); rows.return(); };
  },
  'RETURNING statements read with get and all': db => rival => {
    db.prepare('INSERT INTO records VALUES (?) RETURNING id').get('TEST-get');
    rival();
    db.prepare('INSERT INTO records VALUES (?) RETURNING id').all('TEST-all');
  },
  'an iterator advanced after the rival': db => rival => {
    const rows = db.prepare("INSERT INTO records VALUES ('TEST-a'), ('TEST-b') RETURNING id").iterate();
    rows.next();
    rival();
    rows.next();
    rows.return();
  },
  'an exec batch whose trigger calls back': db => rival => {
    db.function('rival_id', () => { rival(); return 'TEST-trigger'; });
    db.exec("CREATE TRIGGER fill AFTER INSERT ON records WHEN NEW.id = 'TEST-batch' BEGIN INSERT INTO records VALUES (rival_id()); END; INSERT INTO records VALUES ('TEST-batch'); -- tail");
  },
  'an SQL function callback': db => rival => {
    db.function('expire', () => { rival(); return 'TEST-42'; });
    db.exec('INSERT INTO records SELECT expire()');
  },
  'an aggregate callback': db => rival => {
    db.aggregate('pick', { start: null, step: (_, value) => { rival(); return value; } });
    db.exec("INSERT INTO records SELECT pick(id) FROM (SELECT 'TEST-aggregate' AS id)");
  },
  'an override of a bundled SQLite function': db => rival => {
    // Two parameters give it the bundled function's name and arity.
    db.function('rtreenode', (_nodeSize, _nodeData) => { rival(); return 'TEST-override'; });
    db.exec('INSERT INTO records SELECT rtreenode(1, 2)');
  },
  'a virtual-table program that calls back': db => rival => {
    let armed = false;
    db.function('chk', _value => { if (armed) rival(); return 1; });
    db.exec('CREATE TABLE checked(x CHECK (chk(x))); INSERT INTO checked VALUES (1)');
    armed = true;
    db.prepare("SELECT * FROM pragma_integrity_check('checked')").all();
    db.exec("INSERT INTO records VALUES ('TEST-virtual')");
  },
  'a named binding accessor': db => rival => {
    db.prepare('INSERT INTO records VALUES ($id)').run({ get $id() { rival(); return 'TEST-accessor'; } });
  },
  'a proxy binding': db => rival => {
    const traps = { ownKeys: target => { rival(); return Reflect.ownKeys(target); }, get: (target, key) => { rival(); return target[key]; } };
    db.prepare('INSERT INTO records VALUES ($id)').run(new Proxy({ $id: 'TEST-proxy' }, traps));
  },
  'a function used as named bindings': db => rival => {
    db.prepare('INSERT INTO records VALUES ($id)').run(Object.defineProperty(() => {}, '$id', { enumerable: true, get() { rival(); return 'TEST-function'; } }));
  },
  'a callable proxy binding': db => rival => {
    db.prepare('INSERT INTO records VALUES ($id)').run(new Proxy(() => {}, {
      ownKeys: () => { rival(); return ['$id']; },
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: 'TEST-callable' }),
      get: (_, key) => { rival(); return key === '$id' ? 'TEST-callable' : undefined; },
    }));
  },
};
for (const [path, setup] of Object.entries(WRITE_PATHS)) {
  test(`no rival can claim the lease while the holder writes through ${path}`, t => {
    const { first, second } = workers(t);
    const held = claimSqliteWriteLease(first), write = setup(first), refusals = [];
    const rival = () => {
      try { claimSqliteWriteLease(second); refusals.push('claimed'); } catch (error) { refusals.push(error.message); }
    };
    withSqliteWriteLease(first, held, () => write(rival));
    assert.ok(refusals.length > 0);
    assert.deepEqual([...new Set(refusals)], ['database is locked']);
    assert.deepEqual(leaseRow(second), { ...held });
    assert.ok(count(second) > 0);
  });
}

test('a body that restarts its transaction after another worker claimed the lease cannot commit', t => {
  const { first, second } = workers(t);
  const held = claimSqliteWriteLease(first);
  assert.throws(() => withSqliteWriteLease(first, held, () => {
    first.exec('ROLLBACK');
    claimSqliteWriteLease(second);
    first.exec("BEGIN IMMEDIATE; INSERT INTO records VALUES ('TEST-stale')");
  }), LEASE_LOST);
  assert.equal(count(second), 0);
});
const TRANSACTION_ENDINGS = {
  'ROLLBACK in an exec batch': db => db.exec("INSERT INTO records VALUES ('TEST-second'); ROLLBACK"),
  'an ON CONFLICT ROLLBACK constraint': db => assert.throws(() => db.exec("INSERT OR ROLLBACK INTO records VALUES ('TEST-leased')"), /UNIQUE/),
};
for (const [ending, end] of Object.entries(TRANSACTION_ENDINGS)) {
  test(`a body whose transaction ended through ${ending} fails and keeps none of its leased writes`, t => {
    const { first } = workers(t);
    const held = claimSqliteWriteLease(first);
    assert.throws(() => withSqliteWriteLease(first, held, () => {
      first.exec("INSERT INTO records VALUES ('TEST-leased')");
      end(first);
    }), /no transaction is active/);
    assert.equal(count(first), 0);
  });
}
test('a holder that crashes inside its transaction commits nothing and the lease can be claimed again', t => {
  const { file, first } = workers(t);
  const crash = `import { DatabaseSync } from 'node:sqlite';
    const { claimSqliteWriteLease, withSqliteWriteLease } = await import(${JSON.stringify(MODULE_URL)});
    const db = new DatabaseSync(${JSON.stringify(file)});
    const lease = claimSqliteWriteLease(db);
    withSqliteWriteLease(db, lease, () => {
      db.exec("INSERT INTO records VALUES ('TEST-crashed')");
      process.kill(process.pid, 'SIGKILL');
    });`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', crash], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const crashed = leaseRow(first);
  assert.equal(count(first), 0);
  const restarted = claimSqliteWriteLease(first);
  assert.equal(restarted.epoch, crashed.epoch + 1);
  assert.throws(() => withSqliteWriteLease(first, crashed, () => {}), LEASE_LOST);
  withSqliteWriteLease(first, restarted, () => first.exec("INSERT INTO records VALUES ('TEST-restarted')"));
  assert.equal(count(first), 1);
});

test('a body error rolls the transaction back and reaches the caller unchanged', t => {
  const { first } = workers(t);
  const held = claimSqliteWriteLease(first), cause = new Error('TEST-cause');
  assert.throws(() => withSqliteWriteLease(first, held, () => {
    first.exec("INSERT INTO records VALUES ('TEST-undone')");
    throw cause;
  }), error => error === cause);
  assert.equal(count(first), 0);
  assert.equal(withSqliteWriteLease(first, held, () => 'TEST-result'), 'TEST-result');
});
test('a nested leased call on the same connection is refused without ending the outer transaction', t => {
  const { first } = workers(t);
  const held = claimSqliteWriteLease(first);
  let innerRan = false;
  withSqliteWriteLease(first, held, () => {
    first.exec("INSERT INTO records VALUES ('TEST-before')");
    assert.throws(() => withSqliteWriteLease(first, held, () => { innerRan = true; }), /within a transaction/);
    first.exec("INSERT INTO records VALUES ('TEST-after')");
  });
  assert.equal(innerRan, false);
  assert.equal(count(first), 2);
});
for (const [kind, body] of Object.entries({ 'async function': async () => {}, 'generator function': function* () {} })) {
  test(`a body that would run after the call returns is refused before BEGIN: ${kind}`, t => {
    const { first } = workers(t);
    const held = claimSqliteWriteLease(first);
    assert.throws(() => withSqliteWriteLease(first, held, body), /synchronous function/);
    withSqliteWriteLease(first, held, () => first.exec("INSERT INTO records VALUES ('TEST-next')"));
    assert.equal(count(first), 1);
  });
}
test('a body that returns a promise is rolled back and refused', t => {
  const { first } = workers(t);
  const held = claimSqliteWriteLease(first);
  assert.throws(() => withSqliteWriteLease(first, held, () => {
    first.exec("INSERT INTO records VALUES ('TEST-promised')");
    return Promise.resolve();
  }), /returned a promise/);
  assert.equal(count(first), 0);
});
test('a read-only connection cannot run a leased transaction and keeps its policy', t => {
  const { first } = workers(t);
  const held = claimSqliteWriteLease(first);
  first.exec('PRAGMA query_only=ON');
  assert.throws(() => withSqliteWriteLease(first, held, () => {}), /readonly/);
  assert.equal(first.prepare('PRAGMA query_only').get().query_only, 1);
});
test('a connection that reads integers as BigInt claims and commits normally', t => {
  const { file, first } = workers(t);
  const wide = new DatabaseSync(file, { readBigInts: true });
  t.after(() => wide.close());
  const held = claimSqliteWriteLease(wide);
  withSqliteWriteLease(wide, held, () => wide.exec("INSERT INTO records VALUES ('TEST-wide')"));
  assert.equal(count(first), 1);
});
test('a database whose lease was never claimed refuses leased transactions', t => {
  const { first } = workers(t);
  assert.throws(() => withSqliteWriteLease(first, { owner: 'TEST-owner', epoch: 1 }, () => {}), /no such table: dacs_write_lease/);
});
test('malformed inputs are refused before any SQL runs', t => {
  const { first } = workers(t);
  const held = claimSqliteWriteLease(first);
  assert.throws(() => claimSqliteWriteLease({}), /DatabaseSync required/);
  assert.throws(() => withSqliteWriteLease({}, held, () => {}), /DatabaseSync required/);
  for (const lease of [undefined, {}, { owner: held.owner }, { owner: held.owner, epoch: String(held.epoch) }]) {
    assert.throws(() => withSqliteWriteLease(first, lease, () => {}), /a lease from claimSqliteWriteLease/);
  }
  assert.throws(() => withSqliteWriteLease(first, held, 'TEST-not-a-function'), /synchronous function/);
  assert.equal(first.prepare('PRAGMA query_only').get().query_only, 0);
  assert.equal(withSqliteWriteLease(first, held, () => count(first)), 0);
});
test('node:sqlite prototypes are left untouched by import, claim and leased transactions', t => {
  const { first } = workers(t);
  withSqliteWriteLease(first, claimSqliteWriteLease(first), () => first.exec("INSERT INTO records VALUES ('TEST-native')"));
  assert.deepEqual(sqlitePrototypes(), untouched);
});

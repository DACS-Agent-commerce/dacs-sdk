import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { NotWiredError } from '../client-errors.mjs';

const require = createRequire(import.meta.url);
const active = new WeakMap();
const fenced = new WeakSet();
const nonSynchronous = fn => ['[object AsyncFunction]', '[object GeneratorFunction]', '[object AsyncGeneratorFunction]'].includes(Object.prototype.toString.call(fn));
function synchronousResult(result) {
  if (result && typeof result.then === 'function') {
    Promise.resolve(result).catch(() => {});
    throw new NotWiredError('purchase-store-not-wired');
  }
  return result;
}

function fence(db) {
  // SQLite can roll back the entire transaction (e.g. OR ROLLBACK),
  // destroying every savepoint. Close before a catching outer callback can
  // resume, and permanently retire this handle.
  fenced.add(db);
  try { db.close(); } catch { /* Preserve the original failure. */ }
}
function recover(db, sql) {
  try { db.exec(sql); } catch { fence(db); }
}

const identifier = name => `"${name.replaceAll('"', '""')}"`;
function writeGuard(db) {
  // Install outside BEGIN: automatic rollback must remove the marker row,
  // but leave the triggers protecting statements prepared by the host too.
  const name = `dacs_purchase_${randomUUID().replaceAll('-', '')}`;
  const marker = `temp.${identifier(name)}`, triggers = [];
  const clear = () => {
    if (fenced.has(db)) return;
    for (const trigger of triggers) db.exec(`DROP TRIGGER IF EXISTS temp.${identifier(trigger)}`);
    db.exec(`DROP TABLE IF EXISTS ${marker}`);
  };
  db.exec(`CREATE TEMP TABLE ${identifier(name)} (present INTEGER)`);
  try {
    for (const { name: schema } of db.prepare('PRAGMA database_list').all()) {
      const tables = db.prepare(`SELECT name FROM ${identifier(schema)}.sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all();
      for (const table of tables) {
        if (schema === 'temp' && table.name === name) continue;
        for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
          const trigger = `${name}_${triggers.length}`;
          db.exec(`CREATE TEMP TRIGGER ${identifier(trigger)} BEFORE ${action}
            ON ${identifier(schema)}.${identifier(table.name)}
            WHEN NOT EXISTS (SELECT 1 FROM ${marker})
            BEGIN SELECT RAISE(ABORT, 'purchase transaction ended'); END`);
          triggers.push(trigger);
        }
      }
    }
  } catch (error) {
    clear();
    throw error;
  }
  return {
    start() { db.exec(`INSERT INTO ${marker} VALUES (1)`); },
    check() {
      // isTransaction is unavailable on the minimum supported Node versions;
      // the transactional marker supplies the same check on those versions.
      if (fenced.has(db) || db.isTransaction === false || !db.prepare(`SELECT 1 FROM ${marker}`).get()) {
        throw new NotWiredError('purchase-store-not-wired');
      }
    },
    clear,
  };
}

// The package owns the transaction boundary. Host wrappers cannot commit a
// callback before the package has checked its synchronous result.
function sqliteTransaction(db, fn) {
  const { DatabaseSync } = require('node:sqlite');
  if (!(db instanceof DatabaseSync) || fenced.has(db) || typeof fn !== 'function' || nonSynchronous(fn)) throw new NotWiredError('purchase-store-not-wired');
  if (active.has(db)) {
    const state = active.get(db), depth = ++state.depth;
    const savepoint = `dacs_purchase_${depth}`;
    try {
      state.guard.check();
      db.exec(`SAVEPOINT ${savepoint}`);
      const result = synchronousResult(fn());
      state.guard.check();
      db.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      recover(db, `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    } finally {
      state.depth--;
    }
  }
  const guard = writeGuard(db);
  let begun = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    begun = true;
    guard.start();
    active.set(db, { depth: 0, guard });
    const result = synchronousResult(fn());
    guard.check();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (begun) recover(db, 'ROLLBACK');
    throw error;
  } finally {
    active.delete(db);
    guard.clear();
  }
}
function sqliteUniqueViolation(error) {
  return error?.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(error.message);
}

export function createSqlitePurchaseStore() {
  return Object.freeze({ transaction: sqliteTransaction, isUniqueViolation: sqliteUniqueViolation });
}

// Only the concrete package transaction is qualified for durable writes.
// A host may specialize the classifier, but it must remain a sync predicate.
export function purchaseStore(store) {
  const classify = store?.isUniqueViolation;
  if (store?.transaction !== sqliteTransaction || typeof classify !== 'function' || nonSynchronous(classify)) {
    throw new NotWiredError('purchase-store-not-wired');
  }
  return Object.freeze({
    transaction: sqliteTransaction,
    isUniqueViolation(error) {
      const result = synchronousResult(classify.call(store, error));
      if (typeof result !== 'boolean') throw new NotWiredError('purchase-store-not-wired');
      return result;
    },
  });
}

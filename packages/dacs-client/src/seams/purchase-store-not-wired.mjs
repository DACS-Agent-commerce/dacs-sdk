import { createRequire } from 'node:module';
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

function recover(db, sql) {
  try { db.exec(sql); } catch {
    // SQLite can roll back the entire transaction (e.g. OR ROLLBACK),
    // destroying every savepoint. Close before a catching outer callback can
    // run statements in autocommit mode, including already prepared ones.
    fenced.add(db);
    try { db.close(); } catch { /* Preserve the original failure. */ }
  }
}

// The package owns the transaction boundary. Host wrappers cannot commit a
// callback before the package has checked its synchronous result.
function sqliteTransaction(db, fn) {
  const { DatabaseSync } = require('node:sqlite');
  if (!(db instanceof DatabaseSync) || fenced.has(db) || typeof fn !== 'function' || nonSynchronous(fn)) throw new NotWiredError('purchase-store-not-wired');
  if (active.has(db)) {
    const depth = active.get(db) + 1;
    const savepoint = `dacs_purchase_${depth}`;
    active.set(db, depth);
    try {
      db.exec(`SAVEPOINT ${savepoint}`);
      const result = synchronousResult(fn());
      if (fenced.has(db)) throw new NotWiredError('purchase-store-not-wired');
      db.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      recover(db, `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    } finally {
      active.set(db, depth - 1);
    }
  }
  db.exec('BEGIN IMMEDIATE');
  active.set(db, 0);
  try {
    const result = synchronousResult(fn());
    if (fenced.has(db)) throw new NotWiredError('purchase-store-not-wired');
    db.exec('COMMIT');
    return result;
  } catch (error) {
    recover(db, 'ROLLBACK');
    throw error;
  } finally {
    active.delete(db);
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

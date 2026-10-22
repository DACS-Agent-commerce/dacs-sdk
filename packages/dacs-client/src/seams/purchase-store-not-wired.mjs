import { createRequire } from 'node:module';
import { NotWiredError } from '../client-errors.mjs';

const require = createRequire(import.meta.url);
const active = new WeakSet();
const nonSynchronous = fn => ['[object AsyncFunction]', '[object GeneratorFunction]', '[object AsyncGeneratorFunction]'].includes(Object.prototype.toString.call(fn));
function synchronousResult(result) {
  if (result && typeof result.then === 'function') {
    Promise.resolve(result).catch(() => {});
    throw new NotWiredError('purchase-store-not-wired');
  }
  return result;
}

// The package owns the transaction boundary. Host wrappers cannot commit a
// callback before the package has checked its synchronous result.
function sqliteTransaction(db, fn) {
  const { DatabaseSync } = require('node:sqlite');
  if (!(db instanceof DatabaseSync) || typeof fn !== 'function' || nonSynchronous(fn)) throw new NotWiredError('purchase-store-not-wired');
  if (active.has(db)) return synchronousResult(fn());
  db.exec('BEGIN IMMEDIATE');
  active.add(db);
  try {
    const result = synchronousResult(fn());
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
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

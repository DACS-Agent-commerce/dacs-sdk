import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { NotWiredError, OperationError } from '../client-errors.mjs';
import { checkSqlitePurchaseInput, checkSqlitePurchaseDatabase } from '../util/sqlite-purchase-admission.mjs';
import { withSqliteStatementGuard } from '../util/sqlite-statement-boundary.mjs';
import { sqliteWriteLease, retireSqliteHandle, isSqliteHandleRetired } from '../util/sqlite-write-lease.mjs';

const require = createRequire(import.meta.url);
const active = new WeakMap();
// SQLite extended constraint codes: PRIMARYKEY, UNIQUE and ROWID.
const UNIQUE_CONSTRAINT_CODES = new Set([1555, 2067, 2579]);
const nonSynchronous = fn => ['[object AsyncFunction]', '[object GeneratorFunction]', '[object AsyncGeneratorFunction]'].includes(Object.prototype.toString.call(fn));
function synchronousResult(result, db, code = 'purchase_store_async_result') {
  // Result accessors and continuations may retain writers at any nesting depth.
  const refuse = () => { if (db) { recover(db, 'ROLLBACK'); retireSqliteHandle(db); } };
  let deferred;
  try { deferred = types.isPromise(result) || typeof result?.then === 'function'; }
  catch (error) { refuse(); throw error; }
  if (deferred) {
    refuse();
    if (types.isPromise(result)) Promise.prototype.then.call(result, undefined, () => {});
    throw new OperationError(code, 'purchase store requires a synchronous result');
  }
  return result;
}

function recover(db, sql) {
  if (isSqliteHandleRetired(db)) return;
  try { db.exec(sql); } catch { retireSqliteHandle(db); }
}
function checkTransaction(db, guard) {
  guard.check();
  checkSqlitePurchaseDatabase(db);
}

// The package owns the transaction boundary. Host wrappers cannot commit a
// callback before the package has checked its synchronous result.
function sqliteTransaction(db, fn) {
  checkSqlitePurchaseInput(db, fn);
  if (active.has(db)) {
    const state = active.get(db);
    const savepoint = `dacs_purchase_${randomUUID().replaceAll('-', '')}`;
    let opened = false;
    try {
      checkTransaction(db, state.guard);
      state.barrier.return();
      state.barrier = null;
      db.exec(`SAVEPOINT ${savepoint}`);
      opened = true;
      state.barrier = state.guard.blockCommit();
      const result = withSqliteStatementGuard(db, () => checkTransaction(db, state.guard), () => synchronousResult(fn(), db));
      checkTransaction(db, state.guard);
      state.barrier.return();
      state.barrier = null;
      db.exec(`RELEASE ${savepoint}`);
      opened = false;
      return result;
    } catch (error) {
      if (opened) {
        try { state.barrier?.return(); } catch { /* Preserve the callback error. */ }
        state.barrier = null;
        recover(db, `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      }
      throw error;
    } finally {
      if (!state.barrier && !isSqliteHandleRetired(db) && state.guard.present()) state.barrier = state.guard.blockCommit();
    }
  }
  // Refuse unfinished host writers without rolling back their implicit work.
  db.exec('SAVEPOINT dacs_purchase_host_probe; RELEASE dacs_purchase_host_probe');
  // Refuse explicit host transactions before creating any TEMP objects.
  db.exec('BEGIN IMMEDIATE');
  db.exec('ROLLBACK');
  const guard = sqliteWriteLease(db);
  let begun = false, state;
  try {
    guard.arm();
    db.exec('BEGIN IMMEDIATE');
    begun = true;
    guard.start();
    state = { guard, barrier: guard.blockCommit() };
    active.set(db, state);
    const result = withSqliteStatementGuard(db, () => checkTransaction(db, guard), () => synchronousResult(fn(), db));
    checkTransaction(db, guard);
    state.barrier.return();
    state.barrier = null;
    // All fallible guard cleanup precedes COMMIT. It is DML, so an active
    // host SELECT iterator does not require a schema lock.
    guard.disarm();
    db.exec('COMMIT');
    begun = false;
    return result;
  } catch (error) {
    try { state?.barrier?.return(); } catch { /* Preserve the callback error. */ }
    // Before body entry, BEGIN ownership requires recovery even if startup
    // never marked the lease live. During the body SQLite may already roll back.
    try { if (begun && (!state || guard.present())) recover(db, 'ROLLBACK'); } catch { retireSqliteHandle(db); }
    try { guard.disarm(); } catch { retireSqliteHandle(db); }
    throw error;
  } finally {
    active.delete(db);
  }
}
function sqliteUniqueViolation(error) {
  return error?.code === 'ERR_SQLITE_ERROR' && UNIQUE_CONSTRAINT_CODES.has(error.errcode);
}

let statementGuardReady = false;
/** Create the synchronous SQLite transaction and unique-error adapter.
 * Transactions refuse attached schemas before callbacks or further SQL.
 */
export function createSqlitePurchaseStore() {
  // Track host statements prepared after construction, before the first write.
  if (!statementGuardReady) {
    const { DatabaseSync } = require('node:sqlite'), probe = new DatabaseSync(':memory:');
    try { withSqliteStatementGuard(probe, () => {}, () => {}); statementGuardReady = true; }
    finally { probe.close(); }
  }
  return Object.freeze({ transaction: sqliteTransaction, isUniqueViolation: sqliteUniqueViolation });
}

// Only the concrete package transaction is qualified for durable writes.
// A host may specialize the classifier, but it must remain a sync predicate.
/** Qualify the concrete transaction adapter and a synchronous boolean classifier. */
export function purchaseStore(store) {
  const classify = store?.isUniqueViolation;
  if (store?.transaction !== sqliteTransaction || typeof classify !== 'function' || nonSynchronous(classify)) {
    throw new NotWiredError('purchase-store-not-wired');
  }
  return Object.freeze({
    transaction: sqliteTransaction,
    isUniqueViolation(error) {
      const result = synchronousResult(classify.call(store, error), undefined, 'purchase_store_async_classifier_result');
      if (typeof result !== 'boolean') throw new OperationError('purchase_store_invalid_classifier_result', 'purchase store classifier must return a boolean');
      return result;
    },
  });
}
export const isUniqueViolation = (..._args) => { throw new NotWiredError('purchase-store-not-wired'); };
export const transaction = (..._args) => { throw new NotWiredError('purchase-store-not-wired'); };

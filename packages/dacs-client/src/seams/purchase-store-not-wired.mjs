import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { NotWiredError, OperationError } from '../client-errors.mjs';
import { checkSqlitePurchaseInput, checkSqlitePurchaseDatabase, nonSynchronous } from '../util/sqlite-purchase-admission.mjs';
import { withSqliteStatementGuard } from '../util/sqlite-statement-boundary.mjs';
import { sqliteWriteLease, retireSqliteHandle, isSqliteHandleRetired } from '../util/sqlite-write-lease.mjs';

const require = createRequire(import.meta.url);
const active = new WeakMap();
// SQLite extended constraint codes: PRIMARYKEY, UNIQUE and ROWID.
const UNIQUE_CONSTRAINT_CODES = new Set([1555, 2067, 2579]);

// The only inspection of a callback or classifier result. A native promise is
// detected before `then` is read, and a thenable is never adopted.
function synchronousResult(result, code, refuse) {
  let deferred;
  try { deferred = types.isPromise(result) || typeof result?.then === 'function'; }
  catch (error) { refuse(); throw error; }
  if (!deferred) return result;
  refuse();
  if (types.isPromise(result)) Promise.prototype.then.call(result, undefined, () => {});
  throw new OperationError(code, 'purchase store requires a synchronous result');
}

function recover(db, sql) {
  if (isSqliteHandleRetired(db)) return;
  try { db.exec(sql); } catch { retireSqliteHandle(db); }
}
function checkTransaction(db, guard) {
  guard.check();
  checkSqlitePurchaseDatabase(db);
}
// Run fn under the statement guard and keep its value out of the guard, which
// therefore never reads a caller accessor. A deferred result may retain
// writers, so it ends the whole transaction and retires the connection first.
function guardedCall(db, guard, fn) {
  let value;
  withSqliteStatementGuard(db, () => checkTransaction(db, guard), () => {
    value = synchronousResult(fn(), 'purchase_store_async_result', () => { recover(db, 'ROLLBACK'); retireSqliteHandle(db); });
  });
  return value;
}
function releaseBarrier(state) {
  const barrier = state.barrier;
  state.barrier = null;
  barrier?.return();
}

function nestedTransaction(db, state, fn) {
  const savepoint = `dacs_purchase_${randomUUID().replaceAll('-', '')}`;
  let opened = false;
  try {
    checkTransaction(db, state.guard);
    // The barrier is lifted only around package savepoint control.
    releaseBarrier(state);
    db.exec(`SAVEPOINT ${savepoint}`);
    opened = true;
    state.barrier = state.guard.blockCommit();
    const value = guardedCall(db, state.guard, fn);
    checkTransaction(db, state.guard);
    releaseBarrier(state);
    db.exec(`RELEASE ${savepoint}`);
    opened = false;
    return value;
  } catch (error) {
    if (opened) {
      try { releaseBarrier(state); } catch { /* Preserve the callback error. */ }
      recover(db, `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
    }
    throw error;
  } finally {
    // Restore the parent's barrier before control returns to its callback.
    if (!state.barrier && !isSqliteHandleRetired(db) && state.guard.present()) state.barrier = state.guard.blockCommit();
  }
}

function rootTransaction(db, fn) {
  // Refuse unfinished host writers without rolling back their implicit work.
  // The lease's own BEGIN IMMEDIATE refuses explicit host transactions.
  db.exec('SAVEPOINT dacs_purchase_host_probe; RELEASE dacs_purchase_host_probe');
  const guard = sqliteWriteLease(db);
  let begun = false, state;
  try {
    guard.arm();
    db.exec('BEGIN IMMEDIATE');
    begun = true;
    guard.start();
    state = { guard, barrier: guard.blockCommit() };
    active.set(db, state);
    const value = guardedCall(db, guard, fn);
    checkTransaction(db, guard);
    releaseBarrier(state);
    // All fallible guard cleanup precedes COMMIT. It is DML, so an active
    // host SELECT iterator does not require a schema lock.
    guard.disarm();
    db.exec('COMMIT');
    begun = false;
    return value;
  } catch (error) {
    try { if (state) releaseBarrier(state); } catch { /* Preserve the original error. */ }
    // Roll back every BEGIN this call opened, unless SQLite already ended it
    // after the body started.
    try { if (begun && (!state || guard.present())) recover(db, 'ROLLBACK'); } catch { retireSqliteHandle(db); }
    try { guard.disarm(); } catch { retireSqliteHandle(db); }
    throw error;
  } finally {
    active.delete(db);
  }
}

// The package owns the transaction boundary. Host wrappers cannot commit a
// callback before the package has checked its synchronous result.
function sqliteTransaction(db, fn) {
  checkSqlitePurchaseInput(db, fn);
  const state = active.get(db);
  return state ? nestedTransaction(db, state, fn) : rootTransaction(db, fn);
}
function sqliteUniqueViolation(error) {
  return error?.code === 'ERR_SQLITE_ERROR' && UNIQUE_CONSTRAINT_CODES.has(error.errcode);
}

let statementGuardReady = false;
/** Create the synchronous SQLite transaction and unique-error adapter.
 * Returns a frozen `{ transaction, isUniqueViolation }`. `transaction(db, fn)`
 * returns fn's value after COMMIT, or joins an enclosing call as a savepoint.
 * @throws {OperationError} for an unsupported handle, callback, schema, journal
 * or synchronous setting before fn runs, and for a deferred result or an ended
 * transaction; SQLite and callback errors pass through after rollback.
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
/** Qualify the concrete transaction adapter and a synchronous boolean classifier.
 * Returns a frozen store whose classifier result is checked on every call.
 * @throws {NotWiredError} for any other transaction or a non-synchronous classifier.
 */
export function purchaseStore(store) {
  const classify = store?.isUniqueViolation;
  if (store?.transaction !== sqliteTransaction || typeof classify !== 'function' || nonSynchronous(classify)) {
    throw new NotWiredError('purchase-store-not-wired');
  }
  return Object.freeze({
    transaction: sqliteTransaction,
    isUniqueViolation(error) {
      const result = synchronousResult(classify.call(store, error), 'purchase_store_async_classifier_result', () => {});
      if (typeof result !== 'boolean') throw new OperationError('purchase_store_invalid_classifier_result', 'purchase store classifier must return a boolean');
      return result;
    },
  });
}
export const isUniqueViolation = (..._args) => { throw new NotWiredError('purchase-store-not-wired'); };
export const transaction = (..._args) => { throw new NotWiredError('purchase-store-not-wired'); };

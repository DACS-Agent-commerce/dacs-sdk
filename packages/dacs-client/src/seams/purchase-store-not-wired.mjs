import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { NotWiredError, OperationError } from '../client-errors.mjs';
import { withSqliteStatementGuard } from '../util/sqlite-statement-boundary.mjs';
import { sqliteWriteLease, retireSqliteHandle, isSqliteHandleRetired } from '../util/sqlite-write-lease.mjs';

const require = createRequire(import.meta.url);
const active = new WeakMap();
// SQLite extended constraint codes: PRIMARYKEY, UNIQUE and ROWID.
const UNIQUE_CONSTRAINT_CODES = new Set([1555, 2067, 2579]);
const nonSynchronous = fn => ['[object AsyncFunction]', '[object GeneratorFunction]', '[object AsyncGeneratorFunction]'].includes(Object.prototype.toString.call(fn));
function synchronousResult(result, refuse = () => {}, code = 'purchase_store_async_result') {
  if (result && typeof result.then === 'function') {
    refuse();
    Promise.resolve(result).catch(() => {});
    throw new OperationError(code, 'purchase store requires a synchronous result');
  }
  return result;
}

function recover(db, sql) {
  if (isSqliteHandleRetired(db)) return;
  try { db.exec(sql); } catch { retireSqliteHandle(db); }
}

function transactionResult(db, result) {
  return synchronousResult(result, () => {
    // A continuation may retain prepared statements. Retire the whole handle
    // before returning, even when the promise came from a nested body.
    recover(db, 'ROLLBACK');
    retireSqliteHandle(db);
  });
}

// The package owns the transaction boundary. Host wrappers cannot commit a
// callback before the package has checked its synchronous result.
function sqliteTransaction(db, fn) {
  const { DatabaseSync } = require('node:sqlite');
  if (!(db instanceof DatabaseSync)) throw new OperationError('purchase_store_invalid_handle', 'purchase store requires a DatabaseSync handle');
  if (isSqliteHandleRetired(db)) throw new OperationError('purchase_store_retired_handle', 'purchase store handle is retired');
  if (typeof fn !== 'function') throw new OperationError('purchase_store_invalid_callback', 'purchase transaction requires a callback');
  if (nonSynchronous(fn)) throw new OperationError('purchase_store_async_callback', 'purchase transaction requires an ordinary synchronous callback');
  if (active.has(db)) {
    const state = active.get(db);
    const savepoint = `dacs_purchase_${randomUUID().replaceAll('-', '')}`;
    let opened = false;
    try {
      state.guard.check();
      state.barrier.return();
      state.barrier = null;
      db.exec(`SAVEPOINT ${savepoint}`);
      opened = true;
      state.barrier = state.guard.blockCommit();
      const result = withSqliteStatementGuard(db, () => {
        if (!state.guard.present()) throw new OperationError('purchase_store_transaction_ended', 'purchase transaction ended');
      }, () => transactionResult(db, fn()));
      state.guard.check();
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
    const result = withSqliteStatementGuard(db, () => {
      if (!guard.present()) throw new OperationError('purchase_store_transaction_ended', 'purchase transaction ended');
    }, () => transactionResult(db, fn()));
    guard.check();
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
    // At outer depth SQLite may already have rolled back everything. There
    // is no savepoint to recover and no reason to retire that host handle.
    try { if (begun && guard.present()) recover(db, 'ROLLBACK'); } catch { retireSqliteHandle(db); }
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
/** Create the package-owned synchronous SQLite transaction and unique-error adapter. */
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

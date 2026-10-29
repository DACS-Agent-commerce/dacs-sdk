import { createRequire } from 'node:module';
import { OperationError } from '../client-errors.mjs';
import { isSqliteHandleRetired } from './sqlite-write-lease.mjs';

const require = createRequire(import.meta.url);
const PERSISTENT_JOURNAL_MODES = new Set(['delete', 'truncate', 'persist', 'wal']);
// TEMP holds the lease marker, savepoint state and host TEMP tables; OFF cannot roll them back.
const TEMP_JOURNAL_MODES = new Set(['delete', 'truncate', 'persist', 'memory']);
const SYNCHRONOUS_FULL = 2;
const SYNCHRONOUS_EXTRA = 3;
/** Return whether fn is an async, generator or async generator function. */
export const nonSynchronous = fn => ['[object AsyncFunction]', '[object GeneratorFunction]', '[object AsyncGeneratorFunction]'].includes(Object.prototype.toString.call(fn));

function metadataStatement(db, sql) {
  const statement = db.prepare(sql);
  // Normalize only our reads, preserving the caller's statement defaults.
  // Older runtimes without array results already return object rows.
  statement.setReturnArrays?.(false);
  statement.setReadBigInts(false);
  return statement;
}

/** Check the schemas and rollback/crash journals supported by a purchase transaction.
 * Only main and TEMP are admitted, each with a journal mode that can roll back.
 * Returns undefined; throws OperationError for unsupported attachments, journals or synchronization.
 * This read-only check preserves the caller's configuration and host work.
 */
export function checkSqlitePurchaseDatabase(db) {
  // Separate durable files can recover different parts of one WAL commit.
  const databases = metadataStatement(db, 'PRAGMA database_list').all();
  const attached = databases.filter(({ name }) => !['main', 'temp'].includes(name));
  if (attached.some(({ file }) => file)) {
    throw new OperationError('purchase_store_persistent_attachment', 'purchase transactions cannot include persistent attached databases');
  }
  if (attached.length) {
    throw new OperationError('purchase_store_unsupported_attachment', 'purchase transactions support only main and TEMP schemas');
  }
  const main = databases.find(({ name }) => name === 'main');
  const mode = metadataStatement(db, 'PRAGMA main.journal_mode').get()?.journal_mode;
  // MEMORY supports rollback only while a volatile main database exists.
  // OFF cannot undo spilled writes even without a process exit.
  if (!main || !(PERSISTENT_JOURNAL_MODES.has(mode) || (!main.file && mode === 'memory'))) {
    throw new OperationError('purchase_store_unsupported_journal_mode', 'purchase transactions require a rollback and crash-safe journal mode');
  }
  if (main.file) {
    const synchronous = metadataStatement(db, 'PRAGMA main.synchronous').get()?.synchronous;
    // WAL needs a commit sync; rollback journals also need the EXTRA directory sync.
    if (synchronous !== SYNCHRONOUS_EXTRA && !(mode === 'wal' && synchronous === SYNCHRONOUS_FULL)) {
      throw new OperationError('purchase_store_unsupported_synchronous', 'persistent purchase transactions require synchronous FULL or EXTRA for WAL, and EXTRA for rollback journals');
    }
  }
  if (databases.some(({ name }) => name === 'temp') && !TEMP_JOURNAL_MODES.has(metadataStatement(db, 'PRAGMA temp.journal_mode').get()?.journal_mode)) {
    throw new OperationError('purchase_store_unsupported_temp_journal_mode', 'purchase transactions require a TEMP journal mode that can roll back');
  }
}

/** Admit a native, live SQLite connection and an ordinary synchronous callback.
 * Returns undefined; throws OperationError before any transaction or callback
 * on an invalid handle, callback or unsupported database configuration.
 */
export function checkSqlitePurchaseInput(db, fn) {
  const { DatabaseSync } = require('node:sqlite');
  if (!(db instanceof DatabaseSync)) throw new OperationError('purchase_store_invalid_handle', 'purchase store requires a DatabaseSync handle');
  if (isSqliteHandleRetired(db)) throw new OperationError('purchase_store_retired_handle', 'purchase store handle is retired');
  if (typeof fn !== 'function') throw new OperationError('purchase_store_invalid_callback', 'purchase transaction requires a callback');
  if (nonSynchronous(fn)) throw new OperationError('purchase_store_async_callback', 'purchase transaction requires an ordinary synchronous callback');
  checkSqlitePurchaseDatabase(db);
}

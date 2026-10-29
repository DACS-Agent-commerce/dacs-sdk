import { createRequire } from 'node:module';
import { OperationError } from '../client-errors.mjs';
import { isSqliteHandleRetired } from './sqlite-write-lease.mjs';

const require = createRequire(import.meta.url);
const POLICY = {
  main: { journalModes: new Set(['delete', 'truncate', 'persist', 'wal']) },
  volatileMain: { journalModes: new Set(['delete', 'truncate', 'persist', 'wal', 'memory']) },
  temp: { journalModes: new Set(['delete', 'truncate', 'persist', 'memory']) },
};
const SYNCHRONOUS_FULL = 2;
const SYNCHRONOUS_EXTRA = 3;
const nonSynchronous = fn => ['[object AsyncFunction]', '[object GeneratorFunction]', '[object AsyncGeneratorFunction]'].includes(Object.prototype.toString.call(fn));

function metadataStatement(db, sql) {
  const statement = db.prepare(sql);
  // Normalize our statements only, leaving saved and future caller statements alone.
  statement.setReturnArrays?.(false);
  statement.setReadBigInts(false);
  return statement;
}

/** Check every supported schema's rollback journal and persistent main's durability.
 * Returns undefined; throws OperationError for unsupported schemas, journals or synchronization.
 * Reads only listed schemas, preserving configuration, TEMP presence and host work.
 */
export function checkSqlitePurchaseDatabase(db) {
  const schemas = metadataStatement(db, 'PRAGMA database_list').all();
  const attached = schemas.filter(({ name }) => name !== 'main' && name !== 'temp');
  if (attached.some(({ file }) => file)) {
    throw new OperationError('purchase_store_persistent_attachment', 'purchase transactions cannot include persistent attached databases');
  }
  if (attached.length) {
    throw new OperationError('purchase_store_unsupported_attachment', 'purchase transactions support only main and TEMP schemas');
  }
  const main = schemas.find(({ name }) => name === 'main');
  const mainMode = metadataStatement(db, 'PRAGMA main.journal_mode').get()?.journal_mode;
  const mainPolicy = main?.file ? POLICY.main : POLICY.volatileMain;
  if (!main || !mainPolicy.journalModes.has(mainMode)) {
    throw new OperationError('purchase_store_unsupported_journal_mode', 'purchase transactions require a rollback and crash-safe journal mode');
  }
  if (main.file) {
    const synchronous = metadataStatement(db, 'PRAGMA main.synchronous').get()?.synchronous;
    if (synchronous !== SYNCHRONOUS_EXTRA && !(mainMode === 'wal' && synchronous === SYNCHRONOUS_FULL)) {
      throw new OperationError('purchase_store_unsupported_synchronous', 'persistent purchase transactions require synchronous FULL or EXTRA for WAL, and EXTRA for rollback journals');
    }
  }
  // Reading temp.journal_mode itself opens TEMP. Absent TEMP has no rollback state to protect.
  if (schemas.some(({ name }) => name === 'temp')) {
    const tempMode = metadataStatement(db, 'PRAGMA temp.journal_mode').get()?.journal_mode;
    if (!POLICY.temp.journalModes.has(tempMode)) {
      throw new OperationError('purchase_store_unsupported_temp_journal_mode', 'purchase transactions require a TEMP journal mode that can roll back');
    }
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

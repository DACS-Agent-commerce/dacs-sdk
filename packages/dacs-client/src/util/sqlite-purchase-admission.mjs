import { createRequire } from 'node:module';
import { OperationError } from '../client-errors.mjs';
import { isSqliteHandleRetired } from './sqlite-write-lease.mjs';

const require = createRequire(import.meta.url);
const nonSynchronous = fn => ['[object AsyncFunction]', '[object GeneratorFunction]', '[object AsyncGeneratorFunction]'].includes(Object.prototype.toString.call(fn));

/** Check the schemas supported by a purchase transaction.
 * Returns undefined; throws OperationError for unsupported attachments.
 * This read-only check preserves the caller's configuration and host work.
 */
export function checkSqlitePurchaseDatabase(db) {
  // Separate durable files can recover different parts of one WAL commit.
  const attached = db.prepare('PRAGMA database_list').all().filter(({ name }) => !['main', 'temp'].includes(name));
  if (attached.some(({ file }) => file)) {
    throw new OperationError('purchase_store_persistent_attachment', 'purchase transactions cannot include persistent attached databases');
  }
  if (attached.length) {
    throw new OperationError('purchase_store_unsupported_attachment', 'purchase transactions support only main and TEMP schemas');
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

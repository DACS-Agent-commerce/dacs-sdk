// The purchase store an SDK buyer composes for a live buy: a state file in an
// admitted durability mode holding only the package schema, the package's own
// transaction adapter and its shipped operations store. It exports the names of
// the offline harness (purchase-integrity-database.mjs and
// purchase-integrity-operations.mjs), so a suite written against that harness
// runs unchanged on this store once composed-purchase-store-hooks.mjs is
// registered. It imports the package modules directly rather than the package
// entry, so a suite that substitutes package modules after its own imports
// still loads them through its loader.
import { DatabaseSync } from 'node:sqlite';
import { PURCHASE_STATE_SCHEMA } from '../../src/purchase-state-schema.mjs';
import { createSqlitePurchaseStore } from '../../src/seams/purchase-store-not-wired.mjs';
import { createPurchaseOperations } from '../../src/host/purchase-ops.mjs';

// The handoff lifetime the offline harness gives every purchase.
const HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;
const BUSY_TIMEOUT_MS = 5000;

// Constructed before any statement is prepared, as the package README asks.
const store = createSqlitePurchaseStore();
export const { transaction, isUniqueViolation } = store;

/**
 * Open (or reopen) the state file at `path` as a deployed buyer does: WAL with
 * synchronous FULL, foreign keys and a bounded busy timeout, then the package
 * schema. Every package transaction checks these settings again.
 * @throws {TypeError} for an in-memory path; SQLite errors pass through.
 */
export function openDatabase(path) {
  if (typeof path !== 'string' || path === '' || path === ':memory:') throw new TypeError('the composed purchase store needs a state file path');
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec(PURCHASE_STATE_SCHEMA);
  return db;
}

/** The package's shipped operations store on `db`, over the shared package transaction adapter. */
export function createOperationStore({ db, handoffSecret, now }) {
  return createPurchaseOperations({ db, store, handoffSecret, handoffTtlMs: HANDOFF_TTL_MS, now });
}

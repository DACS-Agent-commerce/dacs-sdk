import { randomUUID } from 'node:crypto';
import { OperationError } from '../client-errors.mjs';

const guards = new WeakMap();
const fenced = new WeakSet();

/** Close and permanently retire a connection whose transaction cannot recover. */
export function retireSqliteHandle(db) {
  fenced.add(db);
  try { db.close(); } catch { /* Preserve the original failure. */ }
}

/** Return whether this connection was permanently retired by the package. */
export const isSqliteHandleRetired = db => fenced.has(db);

const identifier = name => `"${name.replaceAll('"', '""')}"`;
function metadataStatement(db, sql) {
  const statement = db.prepare(sql);
  // Normalize only lease metadata, preserving saved and future caller statements.
  statement.setReturnArrays?.(false);
  statement.setReadBigInts(false);
  return statement;
}
function schemaVersions(db) {
  const schemas = metadataStatement(db, 'PRAGMA database_list').all();
  if (schemas.some(({ name }) => !['main', 'temp'].includes(name))) {
    throw new OperationError('purchase_store_unsupported_attachment', 'purchase transactions support only main and TEMP schemas');
  }
  return JSON.stringify(schemas.map(({ name, file }) =>
    [name, file, metadataStatement(db, `PRAGMA ${identifier(name)}.schema_version`).get().schema_version]));
}

/** Install committed main/temp ordinary-table guards outside caller transactions.
 * Returns arm/start/check/disarm and a private commit barrier. After arming,
 * the caller must BEGIN IMMEDIATE before start; a refused start requires
 * rollback, disarm and reacquisition. Attached schemas are refused; SQLite
 * installation errors pass through.
 */
export function sqliteWriteLease(db) {
  // Refuse enclosing transactions before modifying any of their TEMP state.
  db.exec('BEGIN IMMEDIATE');
  try {
    let state = guards.get(db);
    if (!state || !state.exists()) {
      // Guards naming a dropped marker would refuse every later write.
      state?.dropTriggers();
      state = createLease(db);
    }
    const versions = state.refresh();
    db.exec('COMMIT');
    state.versions = versions;
    guards.set(db, state);
    return state.guard;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { retireSqliteHandle(db); }
    throw error;
  }
}

function createLease(db) {
  const name = `dacs_purchase_${randomUUID().replaceAll('-', '')}`;
  const marker = `temp.${identifier(name)}`;
  let triggerCount = 0;
  db.exec(`CREATE TEMP TABLE ${identifier(name)} (armed INTEGER, present INTEGER);
    INSERT INTO ${marker} VALUES (0, 0)`);
  const state = {
    versions: undefined,
    exists() { return Boolean(db.prepare("SELECT 1 FROM temp.sqlite_master WHERE type='table' AND name=?").get(name)); },
    dropTriggers() {
      // Reuse a closed range of names, including after an interrupted refresh.
      for (let i = 0; i < triggerCount; i++) db.exec(`DROP TRIGGER IF EXISTS temp.${identifier(`${name}_${i}`)}`);
    },
    refresh() {
      // BEGIN IMMEDIATE locks main before enumeration. Publish
      // this fingerprint only after the trigger installation has committed.
      if (schemaVersions(db) !== state.versions) {
        state.dropTriggers();
        let serial = 0;
        for (const { schema, name: table, type } of metadataStatement(db, 'PRAGMA table_list').all()) {
          if (type !== 'table' || table.startsWith('sqlite_') || (schema === 'temp' && table === name)) continue;
          for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
            const trigger = `${name}_${serial++}`;
            triggerCount = Math.max(triggerCount, serial);
            db.exec(`CREATE TEMP TRIGGER ${identifier(trigger)} BEFORE ${action}
              ON ${identifier(schema)}.${identifier(table)}
              WHEN EXISTS (SELECT 1 FROM ${marker} WHERE armed = 1 AND present = 0)
              BEGIN SELECT RAISE(ABORT, 'purchase transaction ended'); END`);
          }
        }
      }
      return schemaVersions(db);
    },
    guard: {
      arm() { db.exec(`UPDATE ${marker} SET armed = 1, present = 0`); },
      start() {
        // The caller now holds BEGIN IMMEDIATE's locks. A generation installed
        // in a different schema cannot authorize this transaction's body.
        if (schemaVersions(db) !== state.versions) throw new OperationError('purchase_store_schema_changed', 'purchase database schema changed before the transaction started');
        db.exec(`UPDATE ${marker} SET present = 1`);
      },
      blockCommit() {
        // SQLite refuses COMMIT/END while a write statement is in progress.
        // Keep the iterator private; only package code may finish this statement.
        const iterator = db.prepare(`UPDATE ${marker} SET present = present RETURNING present`).iterate();
        if (iterator.next().done) throw new OperationError('purchase_store_transaction_ended', 'purchase transaction ended');
        return iterator;
      },
      present() { return !fenced.has(db) && db.isTransaction !== false && Boolean(db.prepare(`SELECT 1 FROM ${marker} WHERE present = 1`).get()); },
      check() {
        // isTransaction is unavailable on the minimum supported Node versions;
        // the transactional marker supplies the same check on those versions.
        if (!state.guard.present()) throw new OperationError('purchase_store_transaction_ended', 'purchase transaction ended');
      },
      disarm() { if (!fenced.has(db)) db.exec(`UPDATE ${marker} SET armed = 0`); },
    },
  };
  return state;
}

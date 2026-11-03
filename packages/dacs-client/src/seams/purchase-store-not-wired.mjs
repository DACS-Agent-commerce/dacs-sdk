import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { NotWiredError } from '../client-errors.mjs';

const require = createRequire(import.meta.url);
const active = new WeakMap();
const fenced = new WeakSet();
const guards = new WeakMap();
const nonSynchronous = fn => ['[object AsyncFunction]', '[object GeneratorFunction]', '[object AsyncGeneratorFunction]'].includes(Object.prototype.toString.call(fn));
function synchronousResult(result, refuse = () => {}) {
  if (result && typeof result.then === 'function') {
    refuse();
    Promise.resolve(result).catch(() => {});
    throw new NotWiredError('purchase-store-not-wired');
  }
  return result;
}

function fence(db) {
  // SQLite can roll back the entire transaction (e.g. OR ROLLBACK),
  // destroying every savepoint. Close before a catching outer callback can
  // resume, and permanently retire this handle.
  fenced.add(db);
  try { db.close(); } catch { /* Preserve the original failure. */ }
}
function recover(db, sql) {
  if (fenced.has(db)) return;
  try { db.exec(sql); } catch { fence(db); }
}

function transactionResult(db, result) {
  return synchronousResult(result, () => {
    // A continuation may retain prepared statements. Retire the whole handle
    // before returning, even when the promise came from a nested body.
    recover(db, 'ROLLBACK');
    fence(db);
  });
}

const identifier = name => `"${name.replaceAll('"', '""')}"`;
function writeGuard(db) {
  const existing = guards.get(db);
  if (existing) {
    if (!existing.exists()) existing.rebuild();
    existing.refresh();
    return existing;
  }
  // Install once, outside BEGIN. Arming survives automatic rollback, while
  // the in-transaction update does not. Unarmed guards allow host DML.
  const name = `dacs_purchase_${randomUUID().replaceAll('-', '')}`;
  const marker = `temp.${identifier(name)}`, tables = new Map();
  let serial = 0, versions;
  db.exec(`CREATE TEMP TABLE ${identifier(name)} (armed INTEGER, present INTEGER);
    INSERT INTO ${marker} VALUES (0, 0)`);
  const schemaVersions = () => db.prepare('PRAGMA database_list').all().map(({ name: schema, file }) =>
    [schema, file, db.prepare(`PRAGMA ${identifier(schema)}.schema_version`).get().schema_version]);
  const guard = {
    exists() { return Boolean(db.prepare("SELECT 1 FROM temp.sqlite_master WHERE type='table' AND name=?").get(name)); },
    rebuild() {
      db.exec(`CREATE TEMP TABLE ${identifier(name)} (armed INTEGER, present INTEGER);
        INSERT INTO ${marker} VALUES (0, 0)`);
      versions = undefined;
    },
    refresh() {
      const current = JSON.stringify(schemaVersions());
      if (current === versions) return;
      const installed = new Set(db.prepare("SELECT name FROM temp.sqlite_master WHERE type='trigger'").all().map(row => row.name));
      for (const { schema, name: table, type } of db.prepare('PRAGMA table_list').all()) {
        if (type !== 'table' || table.startsWith('sqlite_') || (schema === 'temp' && table === name)) continue;
        const key = JSON.stringify([schema, table]);
        const triggers = (tables.get(key) ?? []).filter(trigger => installed.has(trigger.name));
        tables.set(key, triggers);
        for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
          if (triggers.some(trigger => trigger.action === action && installed.has(trigger.name))) continue;
          const trigger = `${name}_${serial++}`;
          db.exec(`CREATE TEMP TRIGGER ${identifier(trigger)} BEFORE ${action}
            ON ${identifier(schema)}.${identifier(table)}
            WHEN EXISTS (SELECT 1 FROM ${marker} WHERE armed = 1 AND present = 0)
            BEGIN SELECT RAISE(ABORT, 'purchase transaction ended'); END`);
          triggers.push({ action, name: trigger });
        }
      }
      versions = JSON.stringify(schemaVersions());
    },
    arm() { db.exec(`UPDATE ${marker} SET armed = 1, present = 0`); },
    start() { db.exec(`UPDATE ${marker} SET present = 1`); },
    blockCommit() {
      // SQLite refuses COMMIT/END while a write statement is in progress.
      // Keep the iterator private; only package code may finish this statement.
      // This also covers control statements prepared before guard installation.
      const iterator = db.prepare(`UPDATE ${marker} SET present = present RETURNING present`).iterate();
      if (iterator.next().done) throw new NotWiredError('purchase-store-not-wired');
      return iterator;
    },
    present() { return !fenced.has(db) && db.isTransaction !== false && Boolean(db.prepare(`SELECT 1 FROM ${marker} WHERE present = 1`).get()); },
    check() {
      // isTransaction is unavailable on the minimum supported Node versions;
      // the transactional marker supplies the same check on those versions.
      if (!guard.present()) {
        throw new NotWiredError('purchase-store-not-wired');
      }
    },
    disarm() { if (!fenced.has(db)) db.exec(`UPDATE ${marker} SET armed = 0`); },
  };
  guards.set(db, guard);
  guard.refresh();
  return guard;
}

// The package owns the transaction boundary. Host wrappers cannot commit a
// callback before the package has checked its synchronous result.
function sqliteTransaction(db, fn) {
  const { DatabaseSync } = require('node:sqlite');
  if (!(db instanceof DatabaseSync) || fenced.has(db) || typeof fn !== 'function' || nonSynchronous(fn)) throw new NotWiredError('purchase-store-not-wired');
  if (active.has(db)) {
    const state = active.get(db), depth = ++state.depth;
    const savepoint = `dacs_purchase_${depth}`;
    let opened = false;
    try {
      state.guard.check();
      state.barrier.return();
      state.barrier = null;
      db.exec(`SAVEPOINT ${savepoint}`);
      opened = true;
      state.barrier = state.guard.blockCommit();
      const result = transactionResult(db, fn());
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
      state.depth--;
      if (!state.barrier && !fenced.has(db) && state.guard.present()) state.barrier = state.guard.blockCommit();
    }
  }
  // Probe with BEGIN before creating any TEMP objects. A host transaction
  // must be refused without installing guards that its ROLLBACK would erase.
  db.exec('BEGIN IMMEDIATE');
  db.exec('ROLLBACK');
  const guard = writeGuard(db);
  let begun = false, state;
  try {
    guard.arm();
    db.exec('BEGIN IMMEDIATE');
    begun = true;
    guard.start();
    state = { depth: 0, guard, barrier: guard.blockCommit() };
    active.set(db, state);
    const result = transactionResult(db, fn());
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
    try { if (begun && guard.present()) recover(db, 'ROLLBACK'); } catch { fence(db); }
    try { guard.disarm(); } catch { fence(db); }
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

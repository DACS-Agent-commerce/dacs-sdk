import { randomUUID } from 'node:crypto';
import { NotWiredError } from '../client-errors.mjs';

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
/** Reuse a connection-local write lease; throws when its transaction has ended. */
export function sqliteWriteLease(db) {
  const existing = guards.get(db);
  if (existing) {
    if (!existing.exists()) existing.rebuild();
    existing.refresh();
    return existing;
  }
  // Install once, outside BEGIN. Arming survives automatic rollback, while
  // the in-transaction update does not. Unarmed guards allow host DML.
  const name = `dacs_purchase_${randomUUID().replaceAll('-', '')}`;
  const marker = `temp.${identifier(name)}`;
  let triggerCount = 0, versions;
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
      const savepoint = identifier(`${name}_refresh`);
      db.exec(`SAVEPOINT ${savepoint}`);
      try {
        // Schema versions, enumeration and trigger bindings share one SQLite
        // snapshot. A rival WAL commit must never be cached for an older scan.
        const snapshot = schemaVersions();
        let next = JSON.stringify(snapshot);
        if (next !== versions || snapshot.some(([schema]) => !['main', 'temp'].includes(schema))) {
          // Reuse a closed range of names. Even an enclosing rollback that
          // restores an older generation cannot leave untracked TEMP triggers.
          for (let i = 0; i < triggerCount; i++) db.exec(`DROP TRIGGER IF EXISTS temp.${identifier(`${name}_${i}`)}`);
          let serial = 0;
          for (const { schema, name: table, type } of db.prepare('PRAGMA table_list').all()) {
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
          next = JSON.stringify(schemaVersions());
        }
        db.exec(`RELEASE ${savepoint}`);
        versions = next;
      } catch (error) {
        versions = undefined;
        try { db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); }
        catch { retireSqliteHandle(db); }
        throw error;
      }
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

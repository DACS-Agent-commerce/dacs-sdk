// What tests may rely on at the engine floors, Node 22.13.0 and 23.4.0: those
// builds have no isTransaction property and no FTS5 or RTREE module.

/**
 * Whether db has an open transaction, found without the isTransaction property.
 * SQLite refuses to start a transaction inside one and changes nothing, so a
 * refusal means a transaction is open; otherwise the probe starts and rolls
 * back an empty transaction. Any other SQLite error, such as a closed handle,
 * is thrown unchanged.
 */
export function inTransaction(db) {
  try { db.exec('BEGIN'); }
  catch (error) {
    if (/within a transaction/.test(error.message)) return true;
    throw error;
  }
  db.exec('ROLLBACK');
  return false;
}

/** Whether this build of SQLite includes the named optional module, such as fts5 or rtree. */
export function hasSqliteModule(db, name) {
  return db.prepare('PRAGMA module_list').all().some(row => row.name === name);
}

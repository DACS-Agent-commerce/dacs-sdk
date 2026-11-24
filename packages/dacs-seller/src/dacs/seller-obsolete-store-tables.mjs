// The transport store's removed tables. An earlier store created them at every open; no code writes or reads them now.
// A store that still has them keeps its other state: the tables are dropped when they are all empty, and a row in
// any of them refuses the start, since only an older version could have written it. Nothing is migrated.
import { kitFormatRefusal } from './kit-data-format.mjs';

/** The tables an earlier transport store created and this one no longer has. */
export const OBSOLETE_TRANSPORT_TABLES = Object.freeze(['peer_slots', 'peer_transactions', 'peer_nonces', 'peer_nonce_retention', 'kit_context_reservations']);

// A store with no binding yet is current; a bound one is current only when its stored version is the one this code writes.
// Any other version, or a binding that does not parse, is left whole for the store's own binding check to refuse.
function hasSupportedVersion(db, storeVersion) {
  const config = db.prepare("SELECT value FROM peer_meta WHERE key = 'config'").get();
  if (config === undefined) return true;
  try { return JSON.parse(config.value)?.storeVersion === storeVersion; } catch { return false; }
}

/**
 * Drops each of `OBSOLETE_TRANSPORT_TABLES` that exists, with its indexes, in one transaction, when every one of them is empty.
 * Does nothing to a store whose `peer_meta` binding names another version than `storeVersion`.
 * Throws an Error with code `kit_store_format_unsupported`, naming each table that has rows, and changes nothing when any has a row.
 * `peer_meta` must exist. A crash inside the transaction leaves all the tables or none.
 */
export function dropEmptyObsoleteTables(db, storeVersion) {
  if (!hasSupportedVersion(db, storeVersion)) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = OBSOLETE_TRANSPORT_TABLES.filter((name) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined);
    const withRows = existing.filter((name) => db.prepare(`SELECT 1 FROM ${name} LIMIT 1`).get() !== undefined);
    if (withRows.length > 0) throw kitFormatRefusal('unknown-format', `the transport store holds rows in removed tables: ${withRows.join(', ')}`);
    for (const name of existing) db.exec(`DROP TABLE ${name}`);
    db.exec('COMMIT');
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

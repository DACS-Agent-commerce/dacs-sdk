import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const LEASE_TABLE = 'dacs_write_lease';
const LEASE_LOST = 'commit refused: lease lost';
// Bodies of these kinds run after the call returns, outside the transaction.
const DEFERRED_BODY = /^\[object (?:Async|Generator|AsyncGenerator)Function\]$/;

function requireDatabase(db) {
  const { DatabaseSync } = require('node:sqlite');
  if (!(db instanceof DatabaseSync)) throw new TypeError('DatabaseSync required');
}

// BEGIN stays outside the try: a refused BEGIN (for example inside another
// transaction on this connection) must not roll that transaction back.
function inImmediateTransaction(db, body) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = body();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* SQLite has already ended the transaction. */ }
    throw error;
  }
}

// Compare-and-set on the lease row inside the caller's write transaction.
// RETURNING keeps the check independent of the connection's readBigInts mode.
function holdLease(db, owner, epoch) {
  const held = db.prepare(`UPDATE ${LEASE_TABLE} SET epoch = epoch WHERE id = 1 AND owner = ? AND epoch = ? RETURNING epoch`).get(owner, epoch);
  if (!held) throw Object.assign(new Error(LEASE_LOST), { code: 'lease_lost' });
}

/** Claim the database's single write lease for a new owner, taking it over
 * from any earlier owner: the epoch goes up by one, so every lease claimed
 * before this one can no longer commit. The caller decides when a takeover is
 * due. The lease table is created on first claim, in the same transaction.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Readonly<{owner: string, epoch: number}>} the lease to pass to withSqliteWriteLease.
 * @throws {TypeError} when db is not a node:sqlite DatabaseSync.
 * SQLite errors pass through unchanged, including "database is locked" while
 * another connection holds a write transaction.
 */
export function claimSqliteWriteLease(db) {
  requireDatabase(db);
  const owner = randomUUID();
  return inImmediateTransaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS ${LEASE_TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, epoch INTEGER NOT NULL)`);
    const { epoch } = db.prepare(`INSERT INTO ${LEASE_TABLE} (id, owner, epoch) VALUES (1, ?, 1)
      ON CONFLICT (id) DO UPDATE SET owner = excluded.owner, epoch = epoch + 1 RETURNING epoch`).get(owner);
    return Object.freeze({ owner, epoch: Number(epoch) });
  });
}

/** Run fn in one BEGIN IMMEDIATE transaction that commits only while lease is
 * still the database's current lease. The lease row is compared and set right
 * after BEGIN, before fn runs, and again right before COMMIT. SQLite holds the
 * write lock from BEGIN to COMMIT, so no other connection can claim the lease
 * in between: a worker whose lease was claimed by another commits nothing,
 * whichever statement, binding or SQL callback its body used. Nothing in
 * node:sqlite is patched or wrapped.
 * SQL that runs outside this call is not checked against the lease. That
 * includes SQL a body runs after SQLite itself ended the transaction (ROLLBACK,
 * ON CONFLICT ROLLBACK); the call then fails at COMMIT.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{owner: string, epoch: number}} lease from claimSqliteWriteLease.
 * @param {() => T} fn synchronous body; its result is returned after COMMIT.
 * @returns {T}
 * @throws {Error} code 'lease_lost' ("commit refused: lease lost") when another
 * claim replaced the lease; the transaction is rolled back.
 * @throws {TypeError} for a db that is not a DatabaseSync, a malformed lease,
 * or a body that is not a synchronous function (checked before BEGIN) or that
 * returns a promise (rolled back).
 * Errors from fn and from SQLite pass through unchanged after rollback.
 * @template T
 */
export function withSqliteWriteLease(db, lease, fn) {
  requireDatabase(db);
  const { owner, epoch } = lease ?? {};
  if (typeof owner !== 'string' || !Number.isSafeInteger(epoch)) throw new TypeError('a lease from claimSqliteWriteLease is required');
  if (typeof fn !== 'function' || DEFERRED_BODY.test(Object.prototype.toString.call(fn))) {
    throw new TypeError('the leased transaction body must be a synchronous function');
  }
  return inImmediateTransaction(db, () => {
    holdLease(db, owner, epoch);
    const result = fn();
    if (typeof result?.then === 'function') throw new TypeError('the leased transaction body returned a promise');
    holdLease(db, owner, epoch);
    return result;
  });
}

// Test-only offline harness from frontend 82bf8c4; no application wiring.
// Durable state for accounts, wallets, agents, operations, challenges and the
// OAuth provider. Backed by node:sqlite (WAL, synchronous=FULL) so idempotency
// keys, one-use challenges and approvals are enforced by UNIQUE constraints and
// survive process restarts.
import { DatabaseSync } from 'node:sqlite';
import { PURCHASE_STATE_SCHEMA } from '../../src/purchase-state-schema.mjs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// v2: reported_tx_hash no longer UNIQUE (verified-only partial index). Pre-release:
// older files are refused rather than migrated.
const SCHEMA_VERSION = 2;

const MIGRATIONS = [
  PURCHASE_STATE_SCHEMA,
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS wallets (
     address TEXT PRIMARY KEY,
     account_id TEXT NOT NULL REFERENCES accounts(id),
     scheme TEXT NOT NULL,
     linked_at TEXT NOT NULL,
     link_challenge_id TEXT NOT NULL UNIQUE
   )`,
  `CREATE INDEX IF NOT EXISTS wallets_by_account ON wallets(account_id)`,
  `CREATE TABLE IF NOT EXISTS agents (
     id TEXT PRIMARY KEY,
     account_id TEXT NOT NULL REFERENCES accounts(id),
     wallet_address TEXT NOT NULL REFERENCES wallets(address),
     listing_id TEXT NOT NULL,
     profile TEXT NOT NULL,
     status TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE (account_id, listing_id),
     UNIQUE (wallet_address, listing_id)
   )`,
  `CREATE TABLE IF NOT EXISTS oidc_models (
     model TEXT NOT NULL,
     id TEXT NOT NULL,
     payload TEXT NOT NULL,
     grant_id TEXT,
     user_code TEXT,
     uid TEXT,
     expires_at INTEGER,
     consumed_at INTEGER,
     PRIMARY KEY (model, id)
   )`,
  `CREATE INDEX IF NOT EXISTS oidc_by_grant ON oidc_models(grant_id)`,
  `CREATE INDEX IF NOT EXISTS oidc_by_uid ON oidc_models(model, uid)`,
  `CREATE INDEX IF NOT EXISTS oidc_by_user_code ON oidc_models(model, user_code)`,
  `CREATE TABLE IF NOT EXISTS used_link_nonces (
     nonce TEXT PRIMARY KEY,
     account_id TEXT NOT NULL,
     used_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS secrets (
     name TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
];

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  for (const statement of MIGRATIONS) db.exec(statement);
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
  if (!row) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  } else if (Number(row.value) !== SCHEMA_VERSION) {
    db.close();
    throw new Error(`unsupported state schema version ${row.value}; expected ${SCHEMA_VERSION}`);
  }
  return db;
}

// node:sqlite DatabaseSync is not re-entrant across BEGIN; nested calls join
// the outer transaction.
const depth = new WeakMap();

// Runs fn inside BEGIN IMMEDIATE so concurrent writers (other processes on the
// same file) serialize instead of interleaving read-check-write sequences.
// The depth is set only once BEGIN succeeds: a BEGIN that fails (the lock is
// held past the busy timeout) must not leave later calls running as nested,
// that is without a transaction of their own.
export function transaction(db, fn) {
  const current = depth.get(db) ?? 0;
  if (current > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth.set(db, 1);
  try {
    const result = fn();
    if (result && typeof result.then === 'function') throw new Error('transaction bodies must be synchronous');
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    depth.set(db, 0);
  }
}

export function isUniqueViolation(error) {
  return error?.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(error.message);
}

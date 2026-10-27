// Test-only offline harness from frontend 82bf8c4; no application wiring.
// Durable state for accounts, wallets, agents, operations, challenges and the
// OAuth provider. Backed by node:sqlite (WAL, synchronous=FULL) so idempotency
// keys, one-use challenges and approvals are enforced by UNIQUE constraints and
// survive process restarts.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// v2: reported_tx_hash no longer UNIQUE (verified-only partial index). Pre-release:
// older files are refused rather than migrated.
const SCHEMA_VERSION = 2;

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS accounts (
     id TEXT PRIMARY KEY,
     auth_issuer TEXT NOT NULL,
     auth_subject TEXT NOT NULL,
     display_name TEXT,
     created_at TEXT NOT NULL,
     UNIQUE (auth_issuer, auth_subject)
   )`,
  `CREATE TABLE IF NOT EXISTS wallets (
     address TEXT PRIMARY KEY,
     account_id TEXT NOT NULL REFERENCES accounts(id),
     scheme TEXT NOT NULL,
     linked_at TEXT NOT NULL,
     link_challenge_id TEXT NOT NULL UNIQUE
   )`,
  `CREATE INDEX IF NOT EXISTS wallets_by_account ON wallets(account_id)`,
  `CREATE TABLE IF NOT EXISTS challenges (
     id TEXT PRIMARY KEY,
     nonce TEXT NOT NULL UNIQUE,
     purpose TEXT NOT NULL,
     account_id TEXT,
     binding TEXT NOT NULL,
     message TEXT NOT NULL,
     issued_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     consumed_at TEXT,
     consumed_by TEXT
   )`,
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
  `CREATE TABLE IF NOT EXISTS operations (
     id TEXT PRIMARY KEY,
     account_id TEXT NOT NULL REFERENCES accounts(id),
     kind TEXT NOT NULL,
     idempotency_key TEXT NOT NULL,
     request_hash TEXT NOT NULL,
     status TEXT NOT NULL,
     subject_id TEXT,
     terms TEXT NOT NULL,
     terms_hash TEXT NOT NULL,
     state TEXT NOT NULL DEFAULT '{}',
     handoff_token_hash TEXT NOT NULL UNIQUE,
     expires_at TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE (account_id, kind, idempotency_key)
   )`,
  `CREATE INDEX IF NOT EXISTS operations_by_subject ON operations(account_id, kind, subject_id)`,
  `CREATE INDEX IF NOT EXISTS operations_by_account ON operations(account_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS operation_events (
     operation_id TEXT NOT NULL REFERENCES operations(id),
     seq INTEGER NOT NULL,
     at TEXT NOT NULL,
     type TEXT NOT NULL,
     data TEXT NOT NULL,
     PRIMARY KEY (operation_id, seq)
   )`,
  `CREATE TABLE IF NOT EXISTS approvals (
     id TEXT PRIMARY KEY,
     operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),
     challenge_id TEXT NOT NULL UNIQUE REFERENCES challenges(id),
     signer_address TEXT NOT NULL,
     terms_hash TEXT NOT NULL,
     signature TEXT NOT NULL,
     approved_at TEXT NOT NULL
   )`,
  // Saved before any transaction payload is handed to a wallet. The wallet
  // signs and broadcasts, so the hash is unknown in advance; the durable
  // coordinates are the sender, its pre-handoff nonce fence, the expected
  // nonce, the target and the exact unsigned payload. Only one transaction
  // can ever consume expected_nonce for from_address.
  `CREATE TABLE IF NOT EXISTS write_coordinates (
     operation_id TEXT PRIMARY KEY REFERENCES operations(id),
     kind TEXT NOT NULL,
     network TEXT NOT NULL,
     from_address TEXT NOT NULL,
     nonce_fence INTEGER NOT NULL,
     expected_nonce INTEGER NOT NULL,
     target TEXT NOT NULL,
     amount_os TEXT,
     payload TEXT NOT NULL,
     payload_hash TEXT NOT NULL,
     saved_at TEXT NOT NULL,
     handoffs INTEGER NOT NULL DEFAULT 1,
     reported_tx_hash TEXT,
     reported_at TEXT,
     observation TEXT,
     verified_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS write_coordinates_by_sender ON write_coordinates(from_address, expected_nonce)`,
  // A reported hash is only a pointer and may be claimed by anyone, so only a
  // *verified* settlement hash is unique: one chain transaction can settle at
  // most one operation, and an unverified claim cannot block another account.
  `CREATE UNIQUE INDEX IF NOT EXISTS write_coordinates_verified_tx ON write_coordinates(reported_tx_hash) WHERE verified_at IS NOT NULL`,
  // Insert-only record that a confirmed body the wallet itself signed used its
  // nonce, read through an operation's pointer. Independent of that pointer
  // and its observation, so no later read, pointer move or supersession
  // removes it. Added without a schema bump: older files gain it empty.
  `CREATE TABLE IF NOT EXISTS wallet_nonce_consumptions (
     from_address TEXT NOT NULL,
     network TEXT NOT NULL,
     nonce INTEGER NOT NULL,
     tx_hash TEXT NOT NULL,
     operation_id TEXT NOT NULL REFERENCES operations(id),
     recorded_at TEXT NOT NULL,
     PRIMARY KEY (from_address, network, nonce, tx_hash, operation_id)
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
  // One-use wallet-link capabilities (start_wallet_link).
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

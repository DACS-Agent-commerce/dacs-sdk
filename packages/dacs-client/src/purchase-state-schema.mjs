// Required buyer-state DDL. Apply to a new database before constructing stores.
// Hosts own migrations and must retain every constraint when extending it.
export const PURCHASE_STATE_SCHEMA = `CREATE TABLE IF NOT EXISTS accounts (
     id TEXT PRIMARY KEY,
     auth_issuer TEXT NOT NULL,
     auth_subject TEXT NOT NULL,
     display_name TEXT,
     created_at TEXT NOT NULL,
     UNIQUE (auth_issuer, auth_subject)
   );
CREATE TABLE IF NOT EXISTS challenges (
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
   );
CREATE TABLE IF NOT EXISTS operations (
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
     handoff_expires_at TEXT,
     expires_at TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE (account_id, kind, idempotency_key)
   );
CREATE INDEX IF NOT EXISTS operations_by_subject ON operations(account_id, kind, subject_id);
CREATE INDEX IF NOT EXISTS operations_by_account ON operations(account_id, created_at);
CREATE TABLE IF NOT EXISTS operation_events (
     operation_id TEXT NOT NULL REFERENCES operations(id),
     seq INTEGER NOT NULL,
     at TEXT NOT NULL,
     type TEXT NOT NULL,
     data TEXT NOT NULL,
     PRIMARY KEY (operation_id, seq)
   );
CREATE TABLE IF NOT EXISTS approvals (
     id TEXT PRIMARY KEY,
     operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),
     challenge_id TEXT NOT NULL UNIQUE REFERENCES challenges(id),
     signer_address TEXT NOT NULL,
     terms_hash TEXT NOT NULL,
     signature TEXT NOT NULL,
     approved_at TEXT NOT NULL
   );
CREATE TABLE IF NOT EXISTS write_coordinates (
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
   );
CREATE INDEX IF NOT EXISTS write_coordinates_by_sender ON write_coordinates(from_address, expected_nonce);
CREATE UNIQUE INDEX IF NOT EXISTS write_coordinates_verified_tx ON write_coordinates(reported_tx_hash) WHERE verified_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS wallet_nonce_consumptions (
     from_address TEXT NOT NULL,
     network TEXT NOT NULL,
     nonce INTEGER NOT NULL,
     tx_hash TEXT NOT NULL,
     operation_id TEXT NOT NULL REFERENCES operations(id),
     recorded_at TEXT NOT NULL,
     PRIMARY KEY (from_address, network, nonce, tx_hash, operation_id)
   );`;

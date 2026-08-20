-- Exact schema emitted by public SDK commit 811a7dac (PR #162), before any
-- subsequent integrity repair. Keep immutable: migration tests depend on this
-- being a historical input rather than a reconstruction from the current DDL.
PRAGMA application_id = 1145127763;
PRAGMA user_version = 2;

CREATE TABLE dacs_store_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  mode TEXT NOT NULL,
  profile TEXT NOT NULL,
  role TEXT NOT NULL,
  authority TEXT NOT NULL,
  sdk_version TEXT NOT NULL,
  standard_revision TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE dacs_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
) STRICT;

CREATE TABLE dacs_reservations (
  kind TEXT NOT NULL,
  identity TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  payload_hash TEXT,
  job_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, identity)
) STRICT, WITHOUT ROWID;

CREATE TABLE dacs_effects (
  effect_kind TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  job_id TEXT,
  binding_hash TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  input_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL,
  active_mode TEXT,
  generation INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  owner TEXT,
  lease_expires_at INTEGER,
  retry_at INTEGER,
  reason_code TEXT,
  absence_proof_hash TEXT,
  result_hash TEXT,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (effect_kind, effect_id),
  UNIQUE (effect_kind, idempotency_key),
  CHECK (generation >= 0),
  CHECK (attempts >= 0),
  CHECK (updated_at >= created_at)
) STRICT, WITHOUT ROWID;

CREATE TABLE dacs_effect_history (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  effect_kind TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  event TEXT NOT NULL,
  generation INTEGER NOT NULL,
  occurred_at INTEGER NOT NULL,
  detail_hash TEXT NOT NULL,
  FOREIGN KEY (effect_kind, effect_id)
    REFERENCES dacs_effects (effect_kind, effect_id)
) STRICT;

CREATE INDEX dacs_effects_runnable_idx
  ON dacs_effects (state, retry_at, effect_kind, effect_id);
CREATE INDEX dacs_effect_history_effect_idx
  ON dacs_effect_history (effect_kind, effect_id, sequence);

CREATE TABLE dacs_coordinator_orders (
  profile TEXT NOT NULL,
  role TEXT NOT NULL,
  job_id TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  record_hash TEXT NOT NULL,
  record_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile, role, job_id),
  CHECK (revision > 0),
  CHECK (updated_at >= created_at)
) STRICT, WITHOUT ROWID;

CREATE INDEX dacs_coordinator_orders_runnable_idx
  ON dacs_coordinator_orders (profile, role, job_id);

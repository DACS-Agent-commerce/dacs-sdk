import type BetterSqlite3 from "better-sqlite3";

/** Restore the immutable v6 coordinator schema when constructing legacy fixtures. */
export function downgradeCoordinatorSchemaToV6(database: BetterSqlite3.Database): void {
  database.exec(`
    DROP INDEX dacs_coordinator_tracks_runnable_idx;
    ALTER TABLE dacs_coordinator_tracks RENAME TO dacs_coordinator_tracks_v7;
    ALTER TABLE dacs_coordinator_orders RENAME TO dacs_coordinator_orders_v7;

    CREATE TABLE dacs_coordinator_orders (
      profile TEXT NOT NULL,
      role TEXT NOT NULL,
      job_id TEXT NOT NULL,
      binding_hash TEXT NOT NULL,
      local_binding_hash TEXT NOT NULL,
      record_hash TEXT NOT NULL,
      record_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (profile, role, job_id),
      CHECK (profile IN ('live-x402', 'offline')),
      CHECK (role IN ('buyer', 'seller')),
      CHECK (length(binding_hash) = 64 AND binding_hash NOT GLOB '*[^0-9a-f]*'),
      CHECK (length(local_binding_hash) = 64 AND local_binding_hash NOT GLOB '*[^0-9a-f]*'),
      CHECK (length(record_hash) = 64 AND record_hash NOT GLOB '*[^0-9a-f]*'),
      CHECK (revision > 0),
      CHECK (created_at >= 0),
      CHECK (updated_at >= created_at)
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE dacs_coordinator_tracks (
      profile TEXT NOT NULL,
      role TEXT NOT NULL,
      job_id TEXT NOT NULL,
      local_binding_hash TEXT NOT NULL,
      track TEXT NOT NULL,
      eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
      state TEXT NOT NULL,
      outcome TEXT,
      error_class TEXT,
      faulted_party TEXT,
      withdrawn_by TEXT,
      generation INTEGER NOT NULL,
      attempts INTEGER NOT NULL,
      lease_expires_at INTEGER,
      next_attempt_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (profile, role, job_id, track),
      FOREIGN KEY (profile, role, job_id)
        REFERENCES dacs_coordinator_orders (profile, role, job_id)
        ON DELETE CASCADE,
      CHECK (profile IN ('live-x402', 'offline')),
      CHECK (role IN ('buyer', 'seller')),
      CHECK (length(local_binding_hash) = 64 AND
        local_binding_hash NOT GLOB '*[^0-9a-f]*'),
      CHECK (track IN (
        'agreement', 'payment', 'payment-evidence', 'delivery',
        'buyer-received', 'delivery-evidence', 'audit'
      )),
      CHECK (generation >= 0),
      CHECK (attempts >= 0),
      CHECK (attempts = generation),
      CHECK (lease_expires_at IS NULL OR lease_expires_at >= 0),
      CHECK (next_attempt_at IS NULL OR next_attempt_at >= 0),
      CHECK (updated_at >= 0),
      CHECK (state IN (
        'not-started', 'running', 'pending-retry', 'indeterminate',
        'operator-action', 'final'
      )),
      CHECK ((state = 'running') = (lease_expires_at IS NOT NULL)),
      CHECK ((state IN ('pending-retry', 'indeterminate')) OR next_attempt_at IS NULL),
      CHECK ((state = 'final') = (outcome IS NOT NULL)),
      CHECK (
        (profile = 'live-x402' AND
          (outcome IS NULL OR outcome IN ('success', 'failure', 'aborted')) AND
          (error_class IS NULL OR error_class IN (
            'permanent', 'transient', 'counterparty', 'substrate',
            'settlement-atomicity'
          )) AND
          (faulted_party IS NULL OR faulted_party IN ('buyer', 'seller', 'none')) AND
          (withdrawn_by IS NULL OR withdrawn_by IN ('buyer', 'seller')) AND
          (
            (outcome = 'failure' AND error_class IS NOT NULL AND
              faulted_party IS NOT NULL AND withdrawn_by IS NULL AND
              ((error_class = 'substrate') = (faulted_party = 'none'))) OR
            (outcome = 'aborted' AND error_class IS NULL AND
              faulted_party IS NULL AND withdrawn_by IS NOT NULL) OR
            ((outcome IS NULL OR outcome = 'success') AND error_class IS NULL AND
              faulted_party IS NULL AND withdrawn_by IS NULL)
          )) OR
        (profile = 'offline' AND
          (outcome IS NULL OR outcome IN (
            'simulated-success', 'simulated-failure', 'simulated-aborted'
          )) AND
          (error_class IS NULL OR error_class IN (
            'simulated-permanent', 'simulated-transient',
            'simulated-counterparty', 'simulated-substrate',
            'simulated-settlement-atomicity'
          )) AND
          faulted_party IS NULL AND withdrawn_by IS NULL AND
          (
            (outcome = 'simulated-failure' AND error_class IS NOT NULL) OR
            ((outcome IS NULL OR outcome IN (
              'simulated-success', 'simulated-aborted'
            )) AND error_class IS NULL)
          ))
      )
    ) STRICT, WITHOUT ROWID;

    INSERT INTO dacs_coordinator_orders
      SELECT * FROM dacs_coordinator_orders_v7;
    INSERT INTO dacs_coordinator_tracks
      SELECT * FROM dacs_coordinator_tracks_v7;
    DROP TABLE dacs_coordinator_tracks_v7;
    DROP TABLE dacs_coordinator_orders_v7;
    CREATE INDEX dacs_coordinator_tracks_runnable_idx
      ON dacs_coordinator_tracks (
        profile, role, track, eligible, state, next_attempt_at,
        lease_expires_at, job_id
      );
  `);
}

/** Remove the immutable v7 HTTP lifecycle additions when constructing v6 fixtures. */
export function downgradeHttpSchemaToV6(database: BetterSqlite3.Database): void {
  database.exec(`
    DROP INDEX dacs_http_inbox_semantic_idx;
    DROP INDEX dacs_http_outbox_semantic_idx;
    DROP INDEX dacs_http_inbox_retention_idx;
    DROP INDEX dacs_http_outbox_retention_idx;
    DROP INDEX dacs_http_outbox_active_scan_idx;
    DROP TABLE dacs_http_lifecycle;
    DROP TABLE dacs_http_usage;
    DROP TABLE dacs_http_policy;
    ALTER TABLE dacs_http_inbox DROP COLUMN semantic_key;
    ALTER TABLE dacs_http_outbox DROP COLUMN semantic_key;
  `);
}

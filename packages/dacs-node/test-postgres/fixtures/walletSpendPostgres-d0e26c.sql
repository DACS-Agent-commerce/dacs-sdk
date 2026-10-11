-- Exact PostgreSQL schema shipped by the initial PR head d0e26c1618ad514e485f35dcf495c3a93decf647.
-- The current adoption contract explicitly supports this database shape.
CREATE TABLE IF NOT EXISTS dacs_wallet_spend_lineages (
  lineage_key text PRIMARY KEY,
  wallet text NOT NULL,
  chain_id text NOT NULL,
  policy_hash text NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 0),
  state_hash text NOT NULL,
  state jsonb NOT NULL,
  provisioning_kind text NOT NULL CHECK (provisioning_kind IN ('fresh', 'legacy-import')),
  source_identity text NOT NULL CHECK (length(source_identity) > 0),
  source_evidence_hash text NOT NULL
    CHECK (source_evidence_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (wallet, chain_id)
);
CREATE TABLE IF NOT EXISTS dacs_wallet_spend_candidates (
  candidate_id uuid PRIMARY KEY,
  lineage_key text NOT NULL REFERENCES dacs_wallet_spend_lineages(lineage_key),
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  mutation_index integer NOT NULL CHECK (mutation_index >= 0),
  prior_revision bigint NOT NULL,
  prior_state_hash text NOT NULL,
  next_revision bigint NOT NULL,
  next_state_hash text NOT NULL,
  candidate_state jsonb NOT NULL,
  candidate_value jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('prepared', 'applied', 'superseded')),
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_at timestamptz,
  UNIQUE (lineage_key, operation_id, mutation_index)
);
CREATE INDEX IF NOT EXISTS dacs_wallet_spend_candidates_operation
  ON dacs_wallet_spend_candidates(lineage_key, operation_id);
CREATE TABLE IF NOT EXISTS dacs_wallet_spend_operations (
  role_id text NOT NULL,
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  request jsonb NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (role_id, operation_id)
);

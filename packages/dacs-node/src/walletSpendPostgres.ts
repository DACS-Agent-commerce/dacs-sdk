import { randomUUID } from "node:crypto";

import {
  WALLET_SPEND_STATE_VERSION,
  validateWalletSpendStateV1,
  type WalletSpendPolicyV1,
  type WalletSpendStateStore,
  type WalletSpendStateV1,
} from "@kynesyslabs/dacs";
import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";

import type { DacsWalletSpendRemoteOperationStoreV1 } from "./walletSpendRemote.js";

export interface DacsPostgresQueryResultV1<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount: number | null;
}

export interface DacsPostgresClientV1 {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<DacsPostgresQueryResultV1<Row>>;
  release(): void;
}

export interface DacsPostgresPoolV1 {
  connect(): Promise<DacsPostgresClientV1>;
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<DacsPostgresQueryResultV1<Row>>;
}

export interface DacsWalletSpendPostgresOperationV1 {
  /** Authenticated service role that owns this operation and its candidates. */
  roleId: string;
  operationId: string;
  requestHash: string;
  /** Logical mutation ordinal within one remote operation (normally omitted). */
  mutationIndex?: number;
}

export const DACS_WALLET_SPEND_POSTGRES_SCHEMA_V1 = `
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
  role_id text NOT NULL,
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
DO $dacs_wallet_spend_role_migration$
BEGIN
  -- This is a quiesced migration. The exclusive lock fences any old writer
  -- until role_id has become mandatory; an old insert released afterward then
  -- fails the NOT NULL constraint instead of creating an unusable candidate.
  LOCK TABLE dacs_wallet_spend_operations IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE dacs_wallet_spend_candidates IN ACCESS EXCLUSIVE MODE;
  ALTER TABLE dacs_wallet_spend_candidates
    ADD COLUMN IF NOT EXISTS role_id text;
  WITH unambiguous_candidate_roles AS (
    SELECT operation_id, request_hash, min(role_id) AS role_id
      FROM dacs_wallet_spend_operations
     GROUP BY operation_id, request_hash
    HAVING count(*) = 1
  )
  UPDATE dacs_wallet_spend_candidates AS candidate
     SET role_id = binding.role_id
    FROM unambiguous_candidate_roles AS binding
   WHERE candidate.role_id IS NULL
     AND candidate.operation_id = binding.operation_id
     AND candidate.request_hash = binding.request_hash;
  IF EXISTS (
    SELECT 1 FROM dacs_wallet_spend_candidates WHERE role_id IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23502',
      MESSAGE = 'wallet-spend-candidate-role-migration-ambiguous';
  END IF;
  ALTER TABLE dacs_wallet_spend_candidates
    ALTER COLUMN role_id SET NOT NULL;
END
$dacs_wallet_spend_role_migration$;
CREATE INDEX IF NOT EXISTS dacs_wallet_spend_candidates_role_operation
  ON dacs_wallet_spend_candidates(lineage_key, role_id, operation_id);
`;

export function dacsWalletSpendLineageKeyV1(wallet: string, chainId: string): string {
  if (wallet.length === 0 || chainId.length === 0 ||
      wallet.trim() !== wallet || chainId.trim() !== chainId) {
    throw new TypeError("wallet spend lineage is invalid");
  }
  return sha256Hex(`dacs-wallet-spend-scope:v1:${canonicalize({ wallet, chainId })}`);
}

export function dacsWalletSpendPolicyHashV1(
  policy: Readonly<WalletSpendPolicyV1>,
): string {
  return sha256Hex(`dacs-wallet-spend-policy:v1:${canonicalize(policy)}`);
}

export interface DacsWalletSpendProvisioningEvidenceV1 {
  sourceIdentity: string;
  evidenceHash: string;
}

type AuthenticateProvisioningEvidence = (
  evidence: Readonly<DacsWalletSpendProvisioningEvidenceV1>,
  state: Readonly<WalletSpendStateV1>,
) => Promise<boolean> | boolean;

function provisioningEvidence(
  value: Readonly<DacsWalletSpendProvisioningEvidenceV1>,
): Readonly<DacsWalletSpendProvisioningEvidenceV1> {
  if (value.sourceIdentity.length === 0 || value.sourceIdentity.trim() !== value.sourceIdentity ||
      !/^[0-9a-f]{64}$/.test(value.evidenceHash)) {
    throw new Error("wallet-spend-provisioning-evidence-invalid");
  }
  return Object.freeze({ ...value });
}

function emptyState(policyHash: string): WalletSpendStateV1 {
  return {
    stateVersion: WALLET_SPEND_STATE_VERSION,
    policyHash,
    generation: 0,
    reservations: [],
    totals: [],
    rollingEvents: [],
  };
}

function stateHash(state: Readonly<WalletSpendStateV1>): string {
  return sha256Hex(`dacs-wallet-spend-state:v1:${canonicalize(state)}`);
}

function safeRevision(value: unknown): number {
  const revision = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
    throw new Error("wallet-spend-postgres-revision-invalid");
  }
  return revision as number;
}

interface LineageRow {
  policy_hash: string;
  revision: string | number;
  state_hash: string;
  state: WalletSpendStateV1;
}

interface CandidateRow {
  candidate_id: string;
  role_id: string | null;
  request_hash: string;
  prior_revision: string | number;
  prior_state_hash: string;
  next_revision: string | number;
  next_state_hash: string;
  candidate_state: WalletSpendStateV1;
  candidate_value: unknown;
  status: "prepared" | "applied" | "superseded";
}

interface CandidateValueV1 {
  valueVersion: "1";
  defined: boolean;
  value: unknown;
}

function encodeCandidateValue(value: unknown): Readonly<CandidateValueV1> {
  return Object.freeze({
    valueVersion: "1",
    defined: value !== undefined,
    value: value === undefined ? null : value,
  });
}

function decodedCandidateValue(value: unknown): Readonly<{
  defined: boolean;
  value: unknown;
}> {
  // d0e26c candidates stored result.value directly and represented undefined
  // as JSON null. Preserve that exact legacy meaning after the quiesced upgrade.
  if (value === null) return Object.freeze({ defined: false, value: undefined });
  if (typeof value === "object" && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>;
    if (Object.hasOwn(candidate, "valueVersion")) {
      if (Object.keys(candidate).length !== 3 || candidate.valueVersion !== "1" ||
          typeof candidate.defined !== "boolean" || !Object.hasOwn(candidate, "value") ||
          (!candidate.defined && candidate.value !== null)) {
        throw new Error("wallet-spend-postgres-candidate-value-invalid");
      }
      return Object.freeze({
        defined: candidate.defined,
        value: candidate.defined ? candidate.value : undefined,
      });
    }
  }
  return Object.freeze({ defined: true, value });
}

function decodeCandidateValue<T>(value: unknown): T {
  return decodedCandidateValue(value).value as T;
}

function candidateValueMatches(value: unknown, expected: unknown): boolean {
  const decoded = decodedCandidateValue(value);
  if (!decoded.defined) return expected === undefined;
  return expected !== undefined && canonicalize(decoded.value) === canonicalize(expected);
}

function postgresErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function transaction<T>(
  pool: DacsPostgresPoolV1,
  operation: (client: DacsPostgresClientV1) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve the original failure */ }
      const code = postgresErrorCode(error);
      if ((code !== "40001" && code !== "40P01") || attempt === 7) throw error;
    } finally {
      client.release();
    }
  }
  throw new Error("wallet-spend-postgres-serialization-exhausted");
}

/** Explicit operator-only lineage provisioning; the agent HTTP API never calls this. */
export async function provisionDacsWalletSpendPostgresLineageV1(
  pool: DacsPostgresPoolV1,
  input: Readonly<{
    policy: Readonly<WalletSpendPolicyV1>;
    newLineageEvidence: Readonly<DacsWalletSpendProvisioningEvidenceV1>;
    authenticateEvidence: AuthenticateProvisioningEvidence;
  }>,
): Promise<void> {
  const policy = input.policy;
  const policyHash = dacsWalletSpendPolicyHashV1(policy);
  const lineage = dacsWalletSpendLineageKeyV1(policy.wallet, policy.chainId);
  const state = validateWalletSpendStateV1(emptyState(policyHash), policy);
  const evidence = provisioningEvidence(input.newLineageEvidence);
  if (!await input.authenticateEvidence(evidence, state)) {
    throw new Error("wallet-spend-new-lineage-evidence-rejected");
  }
  const result = await pool.query(
    `INSERT INTO dacs_wallet_spend_lineages
      (lineage_key, wallet, chain_id, policy_hash, revision, state_hash, state,
       provisioning_kind, source_identity, source_evidence_hash)
     VALUES ($1, $2, $3, $4, 0, $5, $6::jsonb, 'fresh', $7, $8)
     ON CONFLICT DO NOTHING`,
    [lineage, policy.wallet, policy.chainId, policyHash, stateHash(state), canonicalize(state),
      evidence.sourceIdentity, evidence.evidenceHash],
  );
  if (result.rowCount !== 1) throw new Error("wallet-spend-lineage-already-exists");
}

/**
 * Explicit operator-only import of an authenticated legacy filesystem/custom
 * state. The agent HTTP API never exposes this operation.
 */
export async function importDacsWalletSpendPostgresLegacyStateV1(
  pool: DacsPostgresPoolV1,
  input: Readonly<{
    policy: Readonly<WalletSpendPolicyV1>;
    state: Readonly<WalletSpendStateV1>;
    sourceEvidence: Readonly<DacsWalletSpendProvisioningEvidenceV1>;
    authenticateEvidence: AuthenticateProvisioningEvidence;
  }>,
): Promise<void> {
  const state = validateWalletSpendStateV1(input.state, input.policy);
  const evidence = provisioningEvidence(input.sourceEvidence);
  if (!await input.authenticateEvidence(evidence, state)) {
    throw new Error("wallet-spend-legacy-state-evidence-rejected");
  }
  const policyHash = dacsWalletSpendPolicyHashV1(input.policy);
  const lineage = dacsWalletSpendLineageKeyV1(input.policy.wallet, input.policy.chainId);
  const result = await pool.query(
    `INSERT INTO dacs_wallet_spend_lineages
      (lineage_key, wallet, chain_id, policy_hash, revision, state_hash, state,
       provisioning_kind, source_identity, source_evidence_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb,
             'legacy-import', $8, $9)
     ON CONFLICT DO NOTHING`,
    [lineage, input.policy.wallet, input.policy.chainId, policyHash, state.generation,
      stateHash(state), canonicalize(state), evidence.sourceIdentity, evidence.evidenceHash],
  );
  if (result.rowCount !== 1) throw new Error("wallet-spend-lineage-already-exists");
}

/**
 * Explicit operator-only policy migration. Accounting and unresolved
 * reservations are retained; removing an asset they reference is refused.
 */
export async function migrateDacsWalletSpendPostgresPolicyV1(
  pool: DacsPostgresPoolV1,
  input: Readonly<{
    previousPolicyHash: string;
    policy: Readonly<WalletSpendPolicyV1>;
  }>,
): Promise<void> {
  const lineage = dacsWalletSpendLineageKeyV1(input.policy.wallet, input.policy.chainId);
  const nextPolicyHash = dacsWalletSpendPolicyHashV1(input.policy);
  const loaded = await pool.query<LineageRow>(
    `SELECT policy_hash, revision, state_hash, state
       FROM dacs_wallet_spend_lineages WHERE lineage_key = $1`,
    [lineage],
  );
  const row = loaded.rows[0];
  if (!row) throw new Error("wallet-spend-lineage-missing");
  if (safeRevision(row.revision) !== row.state.generation ||
      row.state_hash !== stateHash(row.state) || row.policy_hash !== row.state.policyHash) {
    throw new Error("wallet-spend-authoritative-head-invalid");
  }
  if (row.policy_hash !== input.previousPolicyHash ||
      row.state.policyHash !== input.previousPolicyHash) {
    throw new Error("wallet-spend-policy-head-mismatch");
  }
  const allowedAssets = new Set(input.policy.assets.map(({ asset }) => asset));
  if (row.state.totals.some(({ asset }) => !allowedAssets.has(asset)) ||
      row.state.reservations.some(({ reservation }) =>
        reservation.debits.some(({ asset }) => !allowedAssets.has(asset)))) {
    throw new Error("wallet-spend-policy-removes-accounted-asset");
  }
  const priorRevision = safeRevision(row.revision);
  const revision = priorRevision + 1;
  if (!Number.isSafeInteger(revision)) {
    throw new Error("wallet-spend-postgres-revision-exhausted");
  }
  const nextState = validateWalletSpendStateV1({
    ...row.state,
    policyHash: nextPolicyHash,
    generation: revision,
  }, input.policy);
  const candidateId = randomUUID();
  const operationId = randomUUID();
  const requestHash = sha256Hex(canonicalize({
    operation: "migrate-policy",
    lineage,
    previousPolicyHash: input.previousPolicyHash,
    policy: input.policy,
  }));
  const nextHash = stateHash(nextState);
  await pool.query(
    `INSERT INTO dacs_wallet_spend_candidates
      (candidate_id, lineage_key, role_id, operation_id, request_hash, mutation_index,
       prior_revision, prior_state_hash, next_revision, next_state_hash,
       candidate_state, candidate_value, status)
     VALUES ($1::uuid, $2, 'operator:policy-migration', $3::uuid, $4, 0,
             $5, $6, $7, $8, $9::jsonb, $10::jsonb, 'prepared')`,
    [candidateId, lineage, operationId, requestHash, priorRevision, row.state_hash,
      revision, nextHash, canonicalize(nextState), canonicalize(encodeCandidateValue(undefined))],
  );
  await transaction(pool, async (client) => {
    const head = (await client.query<LineageRow>(
      `SELECT policy_hash, revision, state_hash, state
         FROM dacs_wallet_spend_lineages WHERE lineage_key = $1 FOR UPDATE`,
      [lineage],
    )).rows[0];
    if (!head || safeRevision(head.revision) !== priorRevision ||
        head.state_hash !== row.state_hash || head.policy_hash !== input.previousPolicyHash) {
      throw new Error("wallet-spend-policy-head-moved");
    }
    const updated = await client.query(
      `UPDATE dacs_wallet_spend_lineages
          SET policy_hash = $2, revision = $3, state_hash = $4,
              state = $5::jsonb, updated_at = clock_timestamp()
        WHERE lineage_key = $1 AND revision = $6 AND state_hash = $7`,
      [lineage, nextPolicyHash, revision, nextHash, canonicalize(nextState),
        priorRevision, row.state_hash],
    );
    if (updated.rowCount !== 1) throw new Error("wallet-spend-policy-head-moved");
    await client.query(
      `UPDATE dacs_wallet_spend_candidates
          SET status = 'applied', applied_at = clock_timestamp()
        WHERE candidate_id = $1::uuid AND status = 'prepared'`,
      [candidateId],
    );
  });
}

/**
 * PostgreSQL authority state store. Missing lineage is always nonauthorizing.
 * Each changed state is first committed as an immutable candidate, then a
 * separate SERIALIZABLE/row-locked transaction advances the exact prior head.
 */
export function createDacsPostgresWalletSpendStateStoreV1(input: Readonly<{
  pool: DacsPostgresPoolV1;
  wallet: string;
  chainId: string;
  operation?: () => Readonly<DacsWalletSpendPostgresOperationV1> | undefined;
}>): WalletSpendStateStore {
  const lineage = dacsWalletSpendLineageKeyV1(input.wallet, input.chainId);
  let mutationIndex = 0;
  let contextualMutationIndex = 0;

  const operationContext = () => {
    const context = input.operation?.();
    if (context === undefined) return undefined;
    if (typeof context.roleId !== "string" || context.roleId.length === 0 ||
        context.roleId.trim() !== context.roleId || context.roleId.normalize("NFC") !== context.roleId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          .test(context.operationId) || !/^[0-9a-f]{64}$/.test(context.requestHash) ||
        (context.mutationIndex !== undefined &&
          (!Number.isSafeInteger(context.mutationIndex) || context.mutationIndex < 0))) {
      throw new Error("wallet-spend-postgres-operation-identity-invalid");
    }
    return Object.freeze({
      roleId: context.roleId,
      operationId: context.operationId,
      requestHash: context.requestHash,
      mutationIndex: context.mutationIndex ?? contextualMutationIndex++,
    });
  };

  const load = async (): Promise<LineageRow> => {
    const result = await input.pool.query<LineageRow>(
      `SELECT policy_hash, revision, state_hash, state
         FROM dacs_wallet_spend_lineages WHERE lineage_key = $1`,
      [lineage],
    );
    const row = result.rows[0];
    if (!row) throw new Error("wallet-spend-lineage-missing");
    if (safeRevision(row.revision) !== row.state.generation ||
        row.state_hash !== stateHash(row.state) || row.policy_hash !== row.state.policyHash) {
      throw new Error("wallet-spend-authoritative-head-invalid");
    }
    return row;
  };

  const store: WalletSpendStateStore = {
    lineageScope(selectedPolicy): string {
      if (selectedPolicy.wallet !== input.wallet || selectedPolicy.chainId !== input.chainId) {
        throw new Error("wallet-spend-lineage-policy-mismatch");
      }
      return lineage;
    },
    async serverNow(): Promise<number> {
      const result = await input.pool.query<{ now_ms: string }>(
        "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now_ms",
      );
      return safeRevision(result.rows[0]?.now_ms);
    },
    async read(scope): Promise<Readonly<WalletSpendStateV1>> {
      if (scope !== lineage) throw new Error("wallet-spend-lineage-scope-mismatch");
      return structuredClone((await load()).state);
    },
    async transact<T>(
      scope: string,
      operation: (
        current: Readonly<WalletSpendStateV1> | null,
      ) => Readonly<{ state: Readonly<WalletSpendStateV1>; value: T }>,
    ): Promise<T> {
      if (scope !== lineage) throw new Error("wallet-spend-lineage-scope-mismatch");
      const context = operationContext();
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const prior = await load();
        const priorRevision = safeRevision(prior.revision);
        if (priorRevision === Number.MAX_SAFE_INTEGER) {
          throw new Error("wallet-spend-postgres-revision-exhausted");
        }
        const result = operation(structuredClone(prior.state));
        if (canonicalize(result.state) === canonicalize(prior.state)) return result.value;
        if (!Number.isSafeInteger(result.state.generation) ||
            result.state.generation !== priorRevision + 1) {
          throw new Error("wallet-spend-postgres-revision-not-monotonic");
        }
        const operationId = context?.operationId ?? randomUUID();
        const requestHash = context?.requestHash ?? sha256Hex(canonicalize({
          lineage, priorRevision, state: result.state,
        }));
        // Reserve a bounded retry range for each logical mutation. One remote
        // request can legitimately prune rolling events and then reserve, so
        // separate transitions must not collide on the same candidate key.
        const index = context === undefined ? mutationIndex++ :
          context.mutationIndex * 8 + attempt;
        if (!Number.isSafeInteger(index) || index < 0 || index > 2_147_483_647) {
          throw new Error("wallet-spend-postgres-mutation-index-invalid");
        }
        const candidateId = randomUUID();
        const nextHash = stateHash(result.state);
        const storedValue = encodeCandidateValue(result.value);
        await input.pool.query(
          `INSERT INTO dacs_wallet_spend_candidates
            (candidate_id, lineage_key, role_id, operation_id, request_hash, mutation_index,
             prior_revision, prior_state_hash, next_revision, next_state_hash,
             candidate_state, candidate_value, status)
           VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, $7, $8, $9, $10,
                   $11::jsonb, $12::jsonb, 'prepared')
           ON CONFLICT (lineage_key, operation_id, mutation_index) DO NOTHING`,
          [candidateId, lineage, context?.roleId ?? "internal:unscoped",
            operationId, requestHash, index, priorRevision,
            prior.state_hash, result.state.generation, nextHash,
            canonicalize(result.state), canonicalize(storedValue)],
        );
        const retained = (await input.pool.query<CandidateRow>(
          `SELECT candidate_id, role_id, request_hash, prior_revision, prior_state_hash,
                  next_revision, next_state_hash, candidate_state, candidate_value, status
             FROM dacs_wallet_spend_candidates
            WHERE lineage_key = $1 AND role_id = $2
              AND operation_id = $3::uuid AND mutation_index = $4`,
          [lineage, context?.roleId ?? "internal:unscoped", operationId, index],
        )).rows[0];
        if (!retained || retained.role_id !== (context?.roleId ?? "internal:unscoped") ||
            retained.request_hash !== requestHash) {
          throw new Error("wallet-spend-postgres-operation-conflict");
        }
        if (retained.status === "superseded") continue;
        if (
            safeRevision(retained.prior_revision) !== priorRevision ||
            retained.prior_state_hash !== prior.state_hash ||
            safeRevision(retained.next_revision) !== result.state.generation ||
            retained.next_state_hash !== nextHash ||
            canonicalize(retained.candidate_state) !== canonicalize(result.state) ||
            !candidateValueMatches(retained.candidate_value, result.value)) {
          throw new Error("wallet-spend-postgres-operation-conflict");
        }

        const applied = await transaction(input.pool, async (client) => {
          const headResult = await client.query<LineageRow>(
            `SELECT policy_hash, revision, state_hash, state
               FROM dacs_wallet_spend_lineages WHERE lineage_key = $1 FOR UPDATE`,
            [lineage],
          );
          const head = headResult.rows[0];
          if (!head) throw new Error("wallet-spend-lineage-missing");
          if (safeRevision(head.revision) === result.state.generation &&
              head.state_hash === nextHash && retained.status === "applied") {
            return true;
          }
          if (safeRevision(head.revision) !== priorRevision ||
              head.state_hash !== prior.state_hash) {
            await client.query(
              `UPDATE dacs_wallet_spend_candidates SET status = 'superseded'
                WHERE candidate_id = $1::uuid AND status = 'prepared'`,
              [retained.candidate_id],
            );
            return false;
          }
          const update = await client.query(
            `UPDATE dacs_wallet_spend_lineages
                SET revision = $2, state_hash = $3, state = $4::jsonb,
                    updated_at = clock_timestamp()
              WHERE lineage_key = $1 AND revision = $5 AND state_hash = $6`,
            [lineage, result.state.generation, nextHash, canonicalize(result.state),
              priorRevision, prior.state_hash],
          );
          if (update.rowCount !== 1) throw new Error("wallet-spend-head-advance-failed");
          await client.query(
            `UPDATE dacs_wallet_spend_candidates
                SET status = 'applied', applied_at = clock_timestamp()
              WHERE candidate_id = $1::uuid AND status = 'prepared'`,
            [retained.candidate_id],
          );
          return true;
        });
        if (applied) return result.value;
      }
      throw new Error("wallet-spend-postgres-concurrency-exhausted");
    },
  };
  return Object.freeze(store);
}

/** Durable request identity/result log used by the narrow authority service. */
export function createDacsPostgresWalletSpendRemoteOperationStoreV1(
  pool: DacsPostgresPoolV1,
): DacsWalletSpendRemoteOperationStoreV1 {
  const recoverReservedResponse = async (
    roleId: string,
    operationId: string,
    requestHash: string,
    request: unknown,
  ): Promise<unknown | undefined> => {
    if (request === null || typeof request !== "object" || Array.isArray(request)) {
      throw new Error("wallet-spend-authority-stored-request-invalid");
    }
    const retainedRequest = request as Record<string, unknown>;
    if (retainedRequest.operation !== "reserve" ||
        retainedRequest.operationId !== operationId ||
        sha256Hex(canonicalize(retainedRequest)) !== requestHash ||
        typeof retainedRequest.wallet !== "string" ||
        typeof retainedRequest.chainId !== "string" ||
        typeof retainedRequest.policyHash !== "string" ||
        retainedRequest.payload === null || typeof retainedRequest.payload !== "object" ||
        Array.isArray(retainedRequest.payload)) {
      return undefined;
    }
    const payload = retainedRequest.payload as Record<string, unknown>;
    if (payload.reservation === null || typeof payload.reservation !== "object" ||
        Array.isArray(payload.reservation)) {
      throw new Error("wallet-spend-authority-stored-request-invalid");
    }
    const reservation = payload.reservation as Record<string, unknown>;
    const lineage = dacsWalletSpendLineageKeyV1(
      retainedRequest.wallet,
      retainedRequest.chainId,
    );
    const candidates = await pool.query<CandidateRow & { lineage_key: string }>(
      `SELECT candidate_id, lineage_key, role_id, request_hash, prior_revision,
              prior_state_hash, next_revision, next_state_hash, candidate_state,
              candidate_value, status
         FROM dacs_wallet_spend_candidates
        WHERE lineage_key = $1 AND role_id = $2 AND operation_id = $3::uuid
          AND request_hash = $4 AND status = 'applied'
        ORDER BY next_revision`,
      [lineage, roleId, operationId, requestHash],
    );
    const recoverable = candidates.rows.flatMap((candidate) => {
      const priorRevision = safeRevision(candidate.prior_revision);
      const nextRevision = safeRevision(candidate.next_revision);
      if (candidate.lineage_key !== lineage || candidate.role_id !== roleId ||
          nextRevision !== priorRevision + 1 ||
          candidate.candidate_state.generation !== nextRevision ||
          candidate.candidate_state.policyHash !== retainedRequest.policyHash ||
          candidate.next_state_hash !== stateHash(candidate.candidate_state)) {
        throw new Error("wallet-spend-postgres-candidate-invalid");
      }
      const value = decodeCandidateValue<unknown>(candidate.candidate_value);
      if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
      const claim = value as Record<string, unknown>;
      if (Object.keys(claim).length !== 2 || claim.status !== "reserved" ||
          !Number.isSafeInteger(claim.generation) || claim.generation !== nextRevision) {
        return [];
      }
      const stored = candidate.candidate_state.reservations.find(({ reservationId }) =>
        reservationId === reservation.reservationId);
      if (!stored || stored.stage !== "reserved" || stored.generation !== nextRevision ||
          canonicalize(stored.reservation) !== canonicalize(reservation) ||
          typeof stored.owner !== "string") {
        throw new Error("wallet-spend-postgres-reserved-candidate-invalid");
      }
      return [{ candidate, stored, nextRevision }];
    });
    if (recoverable.length === 0) return undefined;
    if (recoverable.length !== 1) {
      throw new Error("wallet-spend-postgres-operation-conflict");
    }
    const recovered = recoverable[0]!;
    const headResult = await pool.query<LineageRow>(
      `SELECT policy_hash, revision, state_hash, state
         FROM dacs_wallet_spend_lineages WHERE lineage_key = $1`,
      [lineage],
    );
    const head = headResult.rows[0];
    if (!head || head.policy_hash !== retainedRequest.policyHash ||
        safeRevision(head.revision) !== head.state.generation ||
        head.state_hash !== stateHash(head.state) ||
        safeRevision(head.revision) < recovered.nextRevision ||
        (safeRevision(head.revision) === recovered.nextRevision &&
          head.state_hash !== recovered.candidate.next_state_hash)) {
      throw new Error("wallet-spend-postgres-applied-candidate-missing");
    }
    return {
      protocolVersion: "1",
      operationId,
      requestHash,
      revision: recovered.nextRevision,
      status: "ok",
      result: {
        status: "reserved",
        permit: {
          reservationId: recovered.stored.reservationId,
          bindingHash: recovered.stored.bindingHash,
          settlementBindingHash: recovered.stored.reservation.settlementBindingHash,
          owner: recovered.stored.owner,
          generation: recovered.stored.generation,
          reservation: recovered.stored.reservation,
        },
      },
    };
  };

  const load: DacsWalletSpendRemoteOperationStoreV1["load"] = async (input) => {
    const result = await pool.query<{
      request_hash: string;
      request: unknown;
      response: unknown | null;
    }>(
      `SELECT request_hash, request, response FROM dacs_wallet_spend_operations
        WHERE role_id = $1 AND operation_id = $2::uuid`,
      [input.roleId, input.operationId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const recovered = row.response === null
      ? await recoverReservedResponse(
          input.roleId,
          input.operationId,
          row.request_hash,
          row.request,
        )
      : undefined;
    return row.response === null && recovered === undefined
      ? { requestHash: row.request_hash, request: row.request as never }
      : {
          requestHash: row.request_hash,
          request: row.request as never,
          response: (row.response ?? recovered) as never,
        };
  };
  const store: DacsWalletSpendRemoteOperationStoreV1 = {
    load,
    async claim(input) {
      const inserted = await pool.query(
        `INSERT INTO dacs_wallet_spend_operations
          (role_id, operation_id, request_hash, request)
         VALUES ($1, $2::uuid, $3, $4::jsonb) ON CONFLICT DO NOTHING`,
        [input.roleId, input.operationId, input.requestHash,
          canonicalize(input.request)],
      );
      if (inserted.rowCount === 1) return "new";
      const prior = await load({
        roleId: input.roleId,
        operationId: input.operationId,
      });
      if (prior?.requestHash !== input.requestHash) {
        throw new Error("wallet-spend-authority-operation-conflict");
      }
      return "existing";
    },
    async complete(input) {
      const result = await pool.query(
        `UPDATE dacs_wallet_spend_operations
            SET response = $4::jsonb, completed_at = clock_timestamp()
          WHERE role_id = $1 AND operation_id = $2::uuid AND request_hash = $3
            AND (response IS NULL OR response = $4::jsonb)`,
        [input.roleId, input.operationId, input.requestHash,
          canonicalize(input.response)],
      );
      if (result.rowCount !== 1) {
        throw new Error("wallet-spend-authority-operation-conflict");
      }
    },
  };
  return Object.freeze(store);
}

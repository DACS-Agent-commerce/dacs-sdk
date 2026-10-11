import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

import {
  WALLET_SPEND_STATE_VERSION,
  type WalletSpendPolicyV1,
  type WalletSpendReservationV1,
  type WalletSpendStateV1,
} from "@kynesyslabs/dacs";
import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";

import {
  DACS_WALLET_SPEND_POSTGRES_CONTINUITY_ADOPTION_SCHEMA_V1,
  DACS_WALLET_SPEND_POSTGRES_SCHEMA_V1,
  adoptDacsWalletSpendPostgresContinuityV1,
  createDacsPostgresWalletSpendRemoteOperationStoreV1,
  createDacsPostgresWalletSpendStateStoreV1,
  createDacsWalletSpendContinuityAuthorityV2,
  createInMemoryDacsWalletSpendContinuityWitnessV1,
  dacsWalletSpendLineageKeyV1,
  dacsWalletSpendPolicyHashV1,
  provisionDacsWalletSpendPostgresLineageV1,
  type DacsPostgresClientV1,
  type DacsPostgresPoolV1,
  type DacsWalletSpendContinuityPinV1,
} from "../src/walletSpendPostgres.js";
import {
  createDacsRemoteWalletSpendAuthorityV2,
  createDacsWalletSpendAuthorityServiceV2,
} from "../src/walletSpendRemote.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const SCHEMA_RE = /^dacs_pg_[0-9a-f]{32}$/;
const TOKEN = "synthetic-postgres-test-token-which-is-long-enough";
const HASH = "a".repeat(64);

let databaseUrl: string;
let adminPool: Pool;
let legacySchema: string;

interface PostgresHarness {
  schema: string;
  raw: Pool;
  pool: DacsPostgresPoolV1;
}

const harnesses = new Set<PostgresHarness>();
const temporaryRoots = new Set<string>();

function requiredTestDatabaseUrl(): string {
  const raw = process.env.DACS_TEST_POSTGRES_URL;
  if (raw === undefined || raw.length === 0) {
    throw new Error("DACS_TEST_POSTGRES_URL is required for the real PostgreSQL test");
  }
  const parsed = new URL(raw);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if ((parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
      !LOOPBACK_HOSTS.has(parsed.hostname) || !/^dacs_test(?:_[a-z0-9_]+)?$/.test(database)) {
    throw new Error(
      "DACS_TEST_POSTGRES_URL must target a loopback dacs_test database",
    );
  }
  return parsed.toString();
}

function quotedSchema(schema: string): string {
  if (!SCHEMA_RE.test(schema)) throw new Error("unsafe PostgreSQL test schema name");
  return `"${schema}"`;
}

async function runQuery<Row = Record<string, unknown>>(
  target: Pool | PoolClient,
  text: string,
  values?: readonly unknown[],
): Promise<{ rows: Row[]; rowCount: number | null }> {
  const result = values === undefined
    ? await target.query(text)
    : await target.query(text, [...values]);
  if (Array.isArray(result)) {
    throw new Error("wallet spend runtime issued an unexpected multi-statement query");
  }
  return { rows: result.rows as Row[], rowCount: result.rowCount };
}

function adaptPool(raw: Pool): DacsPostgresPoolV1 {
  return {
    query: <Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) =>
      runQuery<Row>(raw, text, values),
    async connect(): Promise<DacsPostgresClientV1> {
      const client = await raw.connect();
      return {
        query: <Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) =>
          runQuery<Row>(client, text, values),
        release: () => client.release(),
      };
    },
  };
}

async function createHarness(): Promise<PostgresHarness> {
  const schema = `dacs_pg_${randomUUID().replaceAll("-", "")}`;
  await adminPool.query(`CREATE SCHEMA ${quotedSchema(schema)}`);
  const raw = new Pool({
    connectionString: databaseUrl,
    max: 12,
    options: [
      `-c search_path=${schema},pg_catalog`,
      "-c statement_timeout=20000",
      "-c lock_timeout=5000",
      "-c idle_in_transaction_session_timeout=20000",
    ].join(" "),
  });
  const harness = { schema, raw, pool: adaptPool(raw) };
  harnesses.add(harness);
  try {
    const current = await raw.query<{ current_schema: string }>(
      "SELECT current_schema() AS current_schema",
    );
    expect(current.rows[0]?.current_schema).toBe(schema);
    return harness;
  } catch (error) {
    await destroyHarness(harness);
    throw error;
  }
}

async function destroyHarness(harness: PostgresHarness): Promise<void> {
  if (!harnesses.delete(harness)) return;
  try {
    await harness.raw.end();
  } finally {
    await adminPool.query(`DROP SCHEMA ${quotedSchema(harness.schema)} CASCADE`);
  }
}

async function expectPostgresError(
  operation: Promise<unknown>,
  code: string,
  message: RegExp,
  column?: string,
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).toMatchObject({ code, ...(column === undefined ? {} : { column }) });
  expect((caught as Error).message).toMatch(message);
}

const policy = (policyId = "postgres-policy"): WalletSpendPolicyV1 => ({
  policyVersion: "1",
  policyId,
  wallet: "wallet-postgres",
  chainId: "chain-postgres",
  maximumConcurrentEffects: 2,
  maximumRetainedReservations: 10,
  assets: [{
    asset: "ASSET",
    maximumPerOrderDebit: "100",
    maximumNetworkFeeDebit: "10",
    minimumReserve: "10",
    rollingWindowMs: 60_000,
    maximumRollingEffects: 10,
    maximumRollingDebit: "500",
    maximumCumulativeDebit: "1000",
    maximumCounterpartyDebit: "500",
  }],
});

function reservation(id: string): WalletSpendReservationV1 {
  return {
    reservationVersion: "1",
    reservationId: id,
    jobId: `job-${id}`,
    phaseIndex: 0,
    phase: "payment",
    agreementHash: HASH,
    settlementBindingHash: "b".repeat(64),
    railId: "rail-postgres",
    railDefinitionHash: "c".repeat(64),
    wallet: "wallet-postgres",
    chainId: "chain-postgres",
    payee: "payee-postgres",
    finality: { model: "final" },
    debits: [{
      asset: "ASSET",
      purpose: "service",
      expectedAmount: "25",
      maximumAmount: "25",
    }],
  };
}

function continuity(seedByte: number): DacsWalletSpendContinuityPinV1 {
  const reference = createInMemoryDacsWalletSpendContinuityWitnessV1({
    authorityId: `postgres-authority-${seedByte}`,
    epoch: "postgres-test-epoch",
    seed: new Uint8Array(32).fill(seedByte),
  });
  return {
    authorityId: `postgres-authority-${seedByte}`,
    epoch: "postgres-test-epoch",
    verificationKey: reference.verificationKey,
    witness: reference.witness,
  };
}

function legacyState(selected: WalletSpendPolicyV1): WalletSpendStateV1 {
  return {
    stateVersion: WALLET_SPEND_STATE_VERSION,
    policyHash: dacsWalletSpendPolicyHashV1(selected),
    generation: 5,
    reservations: [],
    totals: [],
    rollingEvents: [],
  };
}

function stateHash(state: Readonly<WalletSpendStateV1>): string {
  return sha256Hex(`dacs-wallet-spend-state:v1:${canonicalize(state)}`);
}

async function tokenFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dacs-postgres-real-"));
  temporaryRoots.add(root);
  const path = join(root, "token");
  await writeFile(path, `${TOKEN}\n`, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(path, 0o600);
  return path;
}

async function seedLegacyDatabase(
  harness: PostgresHarness,
  selected: WalletSpendPolicyV1,
  ambiguousRole: boolean,
): Promise<Readonly<{ lineage: string; state: WalletSpendStateV1 }>> {
  await harness.raw.query(legacySchema);
  const lineage = dacsWalletSpendLineageKeyV1(selected.wallet, selected.chainId);
  const state = legacyState(selected);
  const hash = stateHash(state);
  const operationId = "00000000-0000-4000-8000-000000000301";
  const requestHash = "3".repeat(64);
  await harness.raw.query(
    `INSERT INTO dacs_wallet_spend_lineages
      (lineage_key, wallet, chain_id, policy_hash, revision, state_hash, state,
       provisioning_kind, source_identity, source_evidence_hash)
     VALUES ($1, $2, $3, $4, 5, $5, $6::jsonb, 'legacy-import', $7, $8)`,
    [lineage, selected.wallet, selected.chainId, state.policyHash, hash,
      canonicalize(state), "authenticated-legacy-postgres-test", "d".repeat(64)],
  );
  const roles = ambiguousRole ? ["buyer", "auditor"] : ["buyer"];
  for (const role of roles) {
    await harness.raw.query(
      `INSERT INTO dacs_wallet_spend_operations
        (role_id, operation_id, request_hash, request)
       VALUES ($1, $2::uuid, $3, $4::jsonb)`,
      [role, operationId, requestHash, canonicalize({ legacy: true, role })],
    );
  }
  await harness.raw.query(
    `INSERT INTO dacs_wallet_spend_candidates
      (candidate_id, lineage_key, operation_id, request_hash, mutation_index,
       prior_revision, prior_state_hash, next_revision, next_state_hash,
       candidate_state, candidate_value, status, applied_at)
     VALUES ($1::uuid, $2, $3::uuid, $4, 7, 4, $5, 5, $6,
             $7::jsonb, 'null'::jsonb, 'applied', clock_timestamp())`,
    ["00000000-0000-4000-8000-000000000302", lineage, operationId,
      requestHash, "e".repeat(64), hash, canonicalize(state)],
  );
  return { lineage, state };
}

beforeAll(async () => {
  databaseUrl = requiredTestDatabaseUrl();
  legacySchema = await readFile(
    new URL("./fixtures/walletSpendPostgres-d0e26c.sql", import.meta.url),
    "utf8",
  );
  adminPool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    options: [
      "-c statement_timeout=20000",
      "-c lock_timeout=5000",
      "-c idle_in_transaction_session_timeout=20000",
    ].join(" "),
  });
  await adminPool.query("SELECT 1");
});

afterAll(async () => {
  for (const harness of [...harnesses]) await destroyHarness(harness);
  await Promise.all([...temporaryRoots].map(async (root) => {
    temporaryRoots.delete(root);
    await rm(root, { recursive: true, force: true });
  }));
  if (adminPool !== undefined) await adminPool.end();
});

describe("real PostgreSQL wallet spend authority", () => {
  it("executes the fresh schema and generated-style V2 lifecycle with real locks", async () => {
    const harness = await createHarness();
    try {
      await harness.raw.query(DACS_WALLET_SPEND_POSTGRES_SCHEMA_V1);
      await harness.raw.query(DACS_WALLET_SPEND_POSTGRES_SCHEMA_V1);
      const selected = policy();
      const pin = continuity(41);
      const lineage = dacsWalletSpendLineageKeyV1(selected.wallet, selected.chainId);
      await provisionDacsWalletSpendPostgresLineageV1(harness.pool, {
        policy: selected,
        operationId: "00000000-0000-4000-8000-000000000303",
        continuity: pin,
        newLineageEvidence: {
          sourceIdentity: "authenticated-new-postgres-test",
          evidenceHash: "f".repeat(64),
        },
        authenticateEvidence: () => true,
      });

      await expectPostgresError(
        harness.raw.query(
          "UPDATE dacs_wallet_spend_lineages SET updated_at = clock_timestamp() " +
            "WHERE lineage_key = $1",
          [lineage],
        ),
        "55000",
        /wallet-spend-writer-contract-v2-required/,
      );

      const operations = createDacsPostgresWalletSpendRemoteOperationStoreV1(harness.pool);
      const handler = createDacsWalletSpendAuthorityServiceV2({
        authenticate: (presented) => presented === TOKEN ? "buyer" : null,
        resolveAuthority: (scope) => {
          if (scope.roleId !== "buyer" || scope.authorityId !== pin.authorityId ||
              scope.epoch !== pin.epoch || scope.lineageKey !== lineage ||
              scope.wallet !== selected.wallet || scope.chainId !== selected.chainId ||
              scope.policyHash !== dacsWalletSpendPolicyHashV1(selected)) return null;
          return createDacsWalletSpendContinuityAuthorityV2({
            policy: selected,
            store: createDacsPostgresWalletSpendStateStoreV1({
              pool: harness.pool,
              wallet: selected.wallet,
              chainId: selected.chainId,
              continuity: pin,
              operation: () => ({
                roleId: "buyer",
                operationId: scope.operationId,
                requestHash: scope.requestHash,
              }),
            }),
            dependencies: {
              readBalance: async () => "1000",
              authenticateRecovery: async () => true,
              owner: "postgres-wallet-service",
              leaseDurationMs: 60_000,
            },
          });
        },
        operations,
      });
      const remote = await createDacsRemoteWalletSpendAuthorityV2({
        policy: selected,
        endpoint: "http://127.0.0.1:18080/",
        tokenFilePath: await tokenFile(),
        authorityId: pin.authorityId,
        epoch: pin.epoch,
        witnessVerificationKey: pin.verificationKey,
        allowInsecureLoopback: true,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
          handler(new Request(input, init))) as typeof fetch,
      });
      const claim = await remote.reserve(reservation("real-postgres-reserve"));
      expect(claim).toMatchObject({
        status: "reserved",
        permit: { reservationId: "real-postgres-reserve", generation: 1 },
      });
      if (claim.status !== "reserved") throw new Error("expected PostgreSQL reservation");
      await claim.permit.beginEffect();
      await claim.permit.settle({
        disposition: "settled",
        evidenceHash: "9".repeat(64),
        debits: [{ asset: "ASSET", purpose: "service", amount: "25" }],
      });
      await expect(remote.inspect()).resolves.toMatchObject({
        revision: 3,
        activeEffects: 0,
        assets: [{ cumulativeSettledDebit: "25" }],
      });

      const head = await harness.raw.query<{
        revision: string;
        state: WalletSpendStateV1;
      }>(
        "SELECT revision::text, state FROM dacs_wallet_spend_lineages " +
          "WHERE lineage_key = $1",
        [lineage],
      );
      expect(head.rows).toMatchObject([{
        revision: "3",
        state: {
          generation: 3,
          reservations: [{ reservationId: "real-postgres-reserve", stage: "settled" }],
          totals: [{ cumulativeDebit: "25", counterpartyDebits: { "payee-postgres": "25" } }],
        },
      }]);
      await expect(harness.raw.query(
        "SELECT status, count(*)::text AS count FROM dacs_wallet_spend_candidates " +
          "GROUP BY status ORDER BY status",
      )).resolves.toMatchObject({ rows: [{ status: "applied", count: "4" }] });
      await expect(harness.raw.query(
        "SELECT count(*)::text AS count FROM dacs_wallet_spend_operations " +
          "WHERE response IS NOT NULL",
      )).resolves.toMatchObject({ rows: [{ count: "3" }] });

      const bounded = createDacsPostgresWalletSpendRemoteOperationStoreV1(harness.pool, {
        maximumOperationsPerRole: 2,
        maximumOperations: 6,
      });
      const operationClaim = (roleId: string, suffix: number) => {
        const operationId = `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
        const requestHash = suffix.toString(16).padStart(64, "0");
        return bounded.claim({
          roleId,
          operationId,
          requestHash,
          request: {
            protocolVersion: "1",
            operationId,
            policyHash: dacsWalletSpendPolicyHashV1(selected),
            wallet: selected.wallet,
            chainId: selected.chainId,
            operation: "reserve",
            payload: { reservation: reservation(`admission-${suffix}`), options: {} },
          },
        });
      };
      expect((await Promise.all([
        operationClaim("role-a", 401), operationClaim("role-a", 402),
        operationClaim("role-a", 403), operationClaim("role-a", 404),
      ])).sort()).toEqual(["full", "full", "new", "new"]);
      await expect(operationClaim("role-b", 405)).resolves.toBe("new");
      await expect(operationClaim("role-b", 406)).resolves.toBe("full");
      await expect(harness.raw.query(
        "SELECT scope, retained_operations::text AS retained_operations " +
          "FROM dacs_wallet_spend_operation_counts ORDER BY scope",
      )).resolves.toMatchObject({
        rows: [
          { scope: "global", retained_operations: "6" },
          { scope: "role:buyer", retained_operations: "3" },
          { scope: "role:role-a", retained_operations: "2" },
          { scope: "role:role-b", retained_operations: "1" },
        ],
      });
    } finally {
      await destroyHarness(harness);
    }
  });

  it("rejects expiry before linearization and completes witnessed catch-up", async () => {
    const expiryHarness = await createHarness();
    try {
      await expiryHarness.raw.query(DACS_WALLET_SPEND_POSTGRES_SCHEMA_V1);
      const selected = policy("postgres-lock-expiry");
      const pin = continuity(44);
      const lineage = dacsWalletSpendLineageKeyV1(selected.wallet, selected.chainId);
      await provisionDacsWalletSpendPostgresLineageV1(expiryHarness.pool, {
        policy: selected,
        operationId: "00000000-0000-4000-8000-000000000308",
        continuity: pin,
        newLineageEvidence: {
          sourceIdentity: "authenticated-lock-expiry-test",
          evidenceHash: "5".repeat(64),
        },
        authenticateEvidence: () => true,
      });
      const authority = createDacsWalletSpendContinuityAuthorityV2({
        policy: selected,
        store: createDacsPostgresWalletSpendStateStoreV1({
          pool: expiryHarness.pool,
          wallet: selected.wallet,
          chainId: selected.chainId,
          continuity: pin,
        }),
        dependencies: {
          readBalance: async () => "1000",
          authenticateRecovery: async () => true,
          owner: "postgres-lock-expiry-test",
          leaseDurationMs: 100,
        },
      }).authority;
      const claim = await authority.reserve(reservation("postgres-lock-expiry"));
      if (claim.status !== "reserved") throw new Error("expected PostgreSQL reservation");
      const before = await expiryHarness.raw.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM dacs_wallet_spend_candidates",
      );
      const blocker = await expiryHarness.raw.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query(
          "LOCK TABLE dacs_wallet_spend_lineages IN ACCESS EXCLUSIVE MODE",
        );
        let beginSettled = false;
        let currentSettled = false;
        const begin = claim.permit.beginEffect();
        const current = claim.permit.assertCurrent();
        void begin.then(
          () => { beginSettled = true; },
          () => { beginSettled = true; },
        );
        void current.then(
          () => { currentSettled = true; },
          () => { currentSettled = true; },
        );
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect({ beginSettled, currentSettled }).toEqual({
          beginSettled: false,
          currentSettled: false,
        });
        await blocker.query("COMMIT");
        const results = await Promise.allSettled([begin, current]);
        expect(results).toHaveLength(2);
        for (const result of results) {
          expect(result.status).toBe("rejected");
          if (result.status === "rejected") {
            expect(String(result.reason)).toMatch(/no longer current|cannot begin an effect/);
          }
        }
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        blocker.release();
      }
      await expect(expiryHarness.raw.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM dacs_wallet_spend_candidates",
      )).resolves.toMatchObject({ rows: before.rows });
      await expect(authority.inspect()).resolves.toMatchObject({ revision: 1 });
    } finally {
      await destroyHarness(expiryHarness);
    }

    const catchUpHarness = await createHarness();
    try {
      await catchUpHarness.raw.query(DACS_WALLET_SPEND_POSTGRES_SCHEMA_V1);
      const selected = policy("postgres-witness-catch-up");
      const reference = continuity(45);
      let observeAdvance = false;
      let signalAdvance: (() => void) | undefined;
      const witnessAdvanced = new Promise<void>((resolve) => {
        signalAdvance = resolve;
      });
      const pin: DacsWalletSpendContinuityPinV1 = {
        authorityId: reference.authorityId,
        epoch: reference.epoch,
        verificationKey: reference.verificationKey,
        witness: {
          readCurrent: (input) => reference.witness.readCurrent(input),
          async compareAndSet(input) {
            const receipt = await reference.witness.compareAndSet(input);
            if (observeAdvance) signalAdvance?.();
            return receipt;
          },
          lookupAdvance: (input) => reference.witness.lookupAdvance(input),
        },
      };
      const lineage = dacsWalletSpendLineageKeyV1(selected.wallet, selected.chainId);
      await provisionDacsWalletSpendPostgresLineageV1(catchUpHarness.pool, {
        policy: selected,
        operationId: "00000000-0000-4000-8000-000000000309",
        continuity: pin,
        newLineageEvidence: {
          sourceIdentity: "authenticated-witness-catch-up-test",
          evidenceHash: "4".repeat(64),
        },
        authenticateEvidence: () => true,
      });
      const authority = createDacsWalletSpendContinuityAuthorityV2({
        policy: selected,
        store: createDacsPostgresWalletSpendStateStoreV1({
          pool: catchUpHarness.pool,
          wallet: selected.wallet,
          chainId: selected.chainId,
          continuity: pin,
        }),
        dependencies: {
          readBalance: async () => "1000",
          authenticateRecovery: async () => true,
          owner: "postgres-witness-catch-up-test",
          leaseDurationMs: 2_000,
        },
      }).authority;
      const claim = await authority.reserve(reservation("postgres-witness-catch-up"));
      if (claim.status !== "reserved") throw new Error("expected PostgreSQL reservation");
      const blocker = await catchUpHarness.raw.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query(
          "SELECT lineage_key FROM dacs_wallet_spend_lineages " +
            "WHERE lineage_key = $1 FOR NO KEY UPDATE",
          [lineage],
        );
        observeAdvance = true;
        let beginSettled = false;
        const begin = claim.permit.beginEffect();
        void begin.then(
          () => { beginSettled = true; },
          () => { beginSettled = true; },
        );
        let signalTimeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            witnessAdvanced,
            new Promise<never>((_resolve, reject) => {
              signalTimeout = setTimeout(
                () => reject(new Error("witness advance was not observed")),
                3_000,
              );
            }),
          ]);
        } finally {
          if (signalTimeout !== undefined) clearTimeout(signalTimeout);
        }
        await new Promise((resolve) => setTimeout(resolve, 2_100));
        expect(beginSettled).toBe(false);
        await blocker.query("COMMIT");
        await expect(begin).resolves.toBeUndefined();
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        blocker.release();
      }
      await expect(authority.inspect()).resolves.toMatchObject({ activeEffects: 1 });
      await expect(catchUpHarness.raw.query<{ state: WalletSpendStateV1 }>(
        "SELECT state FROM dacs_wallet_spend_lineages WHERE lineage_key = $1",
        [lineage],
      )).resolves.toMatchObject({ rows: [{
        state: {
          generation: 2,
          reservations: [{
            reservationId: "postgres-witness-catch-up",
            stage: "effect-pending",
          }],
        },
      }] });
      await expect(catchUpHarness.raw.query(
        "SELECT status, count(*)::text AS count FROM dacs_wallet_spend_candidates " +
          "GROUP BY status ORDER BY status",
      )).resolves.toMatchObject({ rows: [{ status: "applied", count: "3" }] });
    } finally {
      await destroyHarness(catchUpHarness);
    }
  });

  it("recovers exact fresh provisioning after the activation commit loses confirmation", async () => {
    const harness = await createHarness();
    try {
      await harness.raw.query(DACS_WALLET_SPEND_POSTGRES_SCHEMA_V1);
      const selected = policy("fresh-provisioning-recovery");
      const basePin = continuity(44);
      let failRead = true;
      const uncertainPin: DacsWalletSpendContinuityPinV1 = {
        ...basePin,
        witness: {
          ...basePin.witness,
          async readCurrent(input) {
            if (failRead) {
              failRead = false;
              throw new Error("continuity confirmation acknowledgement lost");
            }
            return basePin.witness.readCurrent(input);
          },
        },
      };
      const operationId = "00000000-0000-4000-8000-000000000308";
      const evidence = {
        sourceIdentity: "authenticated-new-postgres-recovery-test",
        evidenceHash: "5".repeat(64),
      };
      const input = {
        policy: selected,
        operationId,
        continuity: uncertainPin,
        newLineageEvidence: evidence,
        authenticateEvidence: () => true,
      };

      await expect(provisionDacsWalletSpendPostgresLineageV1(harness.pool, input))
        .rejects.toThrow(/confirmation acknowledgement lost/);
      await expect(harness.raw.query(
        `SELECT l.continuity_status, c.status, count(*) OVER ()::text AS candidate_count
           FROM dacs_wallet_spend_lineages l
           JOIN dacs_wallet_spend_candidates c USING (lineage_key)`,
      )).resolves.toMatchObject({ rows: [{
        continuity_status: "active",
        status: "applied",
        candidate_count: "1",
      }] });

      await expect(provisionDacsWalletSpendPostgresLineageV1(harness.pool, {
        ...input,
        continuity: basePin,
      })).resolves.toBeUndefined();
      await expect(provisionDacsWalletSpendPostgresLineageV1(harness.pool, {
        ...input,
        continuity: basePin,
        operationId: "00000000-0000-4000-8000-000000000309",
      })).rejects.toThrow(/initialization-conflict/);
      await expect(provisionDacsWalletSpendPostgresLineageV1(harness.pool, {
        ...input,
        continuity: basePin,
        newLineageEvidence: { ...evidence, evidenceHash: "4".repeat(64) },
      })).rejects.toThrow(/initialization-conflict/);
    } finally {
      await destroyHarness(harness);
    }
  });

  it("adopts the initial schema and rejects an ambiguous legacy candidate role", async () => {
    const selected = policy("legacy-postgres-policy");
    const accepted = await createHarness();
    try {
      const seeded = await seedLegacyDatabase(accepted, selected, false);
      const pin = continuity(42);
      await accepted.raw.query(DACS_WALLET_SPEND_POSTGRES_CONTINUITY_ADOPTION_SCHEMA_V1);
      await adoptDacsWalletSpendPostgresContinuityV1(accepted.pool, {
        policy: selected,
        operationId: "00000000-0000-4000-8000-000000000304",
        continuity: pin,
        sourceEvidence: {
          sourceIdentity: "authenticated-postgres-adoption-test",
          evidenceHash: "7".repeat(64),
        },
        authenticateEvidence: () => true,
      });
      await accepted.raw.query(DACS_WALLET_SPEND_POSTGRES_SCHEMA_V1);
      await accepted.raw.query(DACS_WALLET_SPEND_POSTGRES_SCHEMA_V1);

      await expect(accepted.raw.query(
        `SELECT writer_contract_version, authority_id, continuity_epoch, role_id, status
           FROM dacs_wallet_spend_candidates
          WHERE operation_id = '00000000-0000-4000-8000-000000000301'::uuid`,
      )).resolves.toMatchObject({ rows: [{
        writer_contract_version: 2,
        authority_id: pin.authorityId,
        continuity_epoch: pin.epoch,
        role_id: "buyer",
        status: "applied",
      }] });
      await expect(accepted.raw.query(
        "SELECT scope, retained_operations::text AS retained_operations " +
          "FROM dacs_wallet_spend_operation_counts ORDER BY scope",
      )).resolves.toMatchObject({ rows: [
        { scope: "global", retained_operations: "1" },
        { scope: "role:buyer", retained_operations: "1" },
      ] });
      await expect(createDacsPostgresWalletSpendStateStoreV1({
        pool: accepted.pool,
        wallet: selected.wallet,
        chainId: selected.chainId,
        continuity: pin,
      }).read!(seeded.lineage)).resolves.toMatchObject({ generation: 5 });

      await expectPostgresError(
        accepted.raw.query(
          `INSERT INTO dacs_wallet_spend_candidates
            (candidate_id, lineage_key, writer_contract_version, authority_id,
             continuity_epoch, operation_id, request_hash, mutation_index,
             prior_revision, prior_state_hash, next_revision, next_state_hash,
             candidate_state, candidate_value, status)
           VALUES ($1::uuid, $2, 2, $3, $4, $5::uuid, $6, 8,
                   5, $7, 6, $8, $9::jsonb, 'null'::jsonb, 'prepared')`,
          ["00000000-0000-4000-8000-000000000305", seeded.lineage,
            pin.authorityId, pin.epoch, "00000000-0000-4000-8000-000000000306",
            "8".repeat(64), stateHash(seeded.state), "9".repeat(64),
            canonicalize({ ...seeded.state, generation: 6 })],
        ),
        "23502",
        /null value in column "role_id"/i,
        "role_id",
      );
      await expectPostgresError(
        accepted.raw.query(
          "UPDATE dacs_wallet_spend_lineages SET updated_at = clock_timestamp() " +
            "WHERE lineage_key = $1",
          [seeded.lineage],
        ),
        "55000",
        /wallet-spend-writer-contract-v2-required/,
      );
    } finally {
      await destroyHarness(accepted);
    }

    const rejected = await createHarness();
    try {
      await seedLegacyDatabase(rejected, selected, true);
      const pin = continuity(43);
      await rejected.raw.query(DACS_WALLET_SPEND_POSTGRES_CONTINUITY_ADOPTION_SCHEMA_V1);
      await adoptDacsWalletSpendPostgresContinuityV1(rejected.pool, {
        policy: selected,
        operationId: "00000000-0000-4000-8000-000000000307",
        continuity: pin,
        sourceEvidence: {
          sourceIdentity: "authenticated-ambiguous-adoption-test",
          evidenceHash: "6".repeat(64),
        },
        authenticateEvidence: () => true,
      });
      await expectPostgresError(
        rejected.raw.query(DACS_WALLET_SPEND_POSTGRES_SCHEMA_V1),
        "23502",
        /wallet-spend-candidate-role-migration-ambiguous/,
      );
      await expect(rejected.raw.query(
        `SELECT role_id FROM dacs_wallet_spend_candidates
          WHERE operation_id = '00000000-0000-4000-8000-000000000301'::uuid`,
      )).resolves.toMatchObject({ rows: [{ role_id: null }] });
      await expect(rejected.raw.query(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'dacs_wallet_spend_candidates'
            AND column_name = 'role_id'`,
        [rejected.schema],
      )).resolves.toMatchObject({ rows: [{ is_nullable: "YES" }] });
    } finally {
      await destroyHarness(rejected);
    }
  });
});

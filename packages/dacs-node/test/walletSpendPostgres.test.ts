import { describe, expect, it } from "vitest";

import {
  WALLET_SPEND_STATE_VERSION,
  createInMemoryWalletSpendStateStore,
  createWalletSpendAuthorityV1,
  type WalletSpendPolicyV1,
  type WalletSpendReservationV1,
  type WalletSpendStateV1,
} from "@kynesyslabs/dacs";
import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";

import {
  DACS_WALLET_SPEND_POSTGRES_SCHEMA_V1,
  createDacsPostgresWalletSpendStateStoreV1,
  createDacsPostgresWalletSpendRemoteOperationStoreV1,
  dacsWalletSpendLineageKeyV1,
  dacsWalletSpendPolicyHashV1,
  importDacsWalletSpendPostgresLegacyStateV1,
  migrateDacsWalletSpendPostgresPolicyV1,
  provisionDacsWalletSpendPostgresLineageV1,
  type DacsPostgresClientV1,
  type DacsPostgresPoolV1,
} from "../src/walletSpendPostgres.js";
import { createDacsWalletSpendAuthorityServiceV1 } from "../src/walletSpendRemote.js";

function policy(policyId: string): WalletSpendPolicyV1 {
  return {
    policyVersion: "1",
    policyId,
    wallet: "wallet-a",
    chainId: "chain-a",
    maximumConcurrentEffects: 1,
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
  };
}

function hashState(state: WalletSpendStateV1): string {
  return sha256Hex(`dacs-wallet-spend-state:v1:${canonicalize(state)}`);
}

function legacyState(selected: WalletSpendPolicyV1): WalletSpendStateV1 {
  const reservation: WalletSpendReservationV1 = {
    reservationVersion: "1",
    reservationId: "legacy-unresolved",
    jobId: "job-legacy",
    phaseIndex: 0,
    phase: "payment",
    agreementHash: "a".repeat(64),
    settlementBindingHash: "b".repeat(64),
    railId: "rail-a",
    railDefinitionHash: "c".repeat(64),
    wallet: selected.wallet,
    chainId: selected.chainId,
    payee: "payee-a",
    finality: { model: "final" },
    debits: [{
      asset: "ASSET",
      purpose: "service",
      expectedAmount: "25",
      maximumAmount: "25",
    }],
  };
  return {
    stateVersion: WALLET_SPEND_STATE_VERSION,
    policyHash: dacsWalletSpendPolicyHashV1(selected),
    generation: 5,
    reservations: [{
      reservationId: reservation.reservationId,
      bindingHash: sha256Hex(
        `dacs-wallet-spend-reservation:v1:${canonicalize(reservation)}`,
      ),
      reservation,
      stage: "effect-pending",
      generation: 5,
      owner: "legacy-worker",
      leaseExpiresAt: 2_000,
      createdAt: 1_000,
      updatedAt: 1_100,
    }],
    totals: [],
    rollingEvents: [],
  };
}

interface FakeCandidate {
  candidate_id: string;
  role_id: string | null;
  request_hash: string;
  prior_revision: number;
  prior_state_hash: string;
  next_revision: number;
  next_state_hash: string;
  candidate_state: WalletSpendStateV1;
  candidate_value: unknown;
  status: "prepared" | "applied" | "superseded";
}

class FakePostgresPool implements DacsPostgresPoolV1 {
  readonly candidates = new Map<string, FakeCandidate>();
  failNextConnect = false;
  failNextCommitAfterApply = false;
  failNextSerializableAdvance = false;
  private lockTail: Promise<void> = Promise.resolve();

  constructor(readonly row: {
    policy_hash: string;
    revision: number;
    state_hash: string;
    state: WalletSpendStateV1;
  }) {}

  async query<Row = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    if (text.startsWith("SELECT policy_hash")) {
      return { rows: [structuredClone(this.row) as Row], rowCount: 1 };
    }
    if (text.startsWith("INSERT INTO dacs_wallet_spend_candidates")) {
      const key = `${String(values[1])}\0${String(values[2])}\0${String(values[3])}` +
        `\0${String(values[5])}`;
      if (!this.candidates.has(key)) {
        this.candidates.set(key, {
          candidate_id: String(values[0]),
          role_id: String(values[2]),
          request_hash: String(values[4]),
          prior_revision: Number(values[6]),
          prior_state_hash: String(values[7]),
          next_revision: Number(values[8]),
          next_state_hash: String(values[9]),
          candidate_state: JSON.parse(String(values[10])) as WalletSpendStateV1,
          candidate_value: JSON.parse(String(values[11])) as unknown,
          status: "prepared",
        });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (text.startsWith("SELECT candidate_id") && text.includes("ORDER BY mutation_index")) {
      const prefix = `${String(values[0])}\0${String(values[1])}\0${String(values[2])}\0`;
      const candidates = [...this.candidates.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([left], [right]) => Number(left.slice(prefix.length)) -
          Number(right.slice(prefix.length)))
        .map(([, candidate]) => structuredClone(candidate) as Row);
      return { rows: candidates, rowCount: candidates.length };
    }
    if (text.startsWith("SELECT candidate_id")) {
      const key = `${String(values[0])}\0${String(values[1])}\0${String(values[2])}` +
        `\0${String(values[3])}`;
      const candidate = this.candidates.get(key);
      return {
        rows: candidate === undefined ? [] : [structuredClone(candidate) as Row],
        rowCount: candidate === undefined ? 0 : 1,
      };
    }
    throw new Error(`unexpected pool query: ${text}`);
  }

  async connect(): Promise<DacsPostgresClientV1> {
    if (this.failNextConnect) {
      this.failNextConnect = false;
      throw new Error("database connection outcome unknown");
    }
    let releaseLock: (() => void) | undefined;
    const acquire = async () => {
      const prior = this.lockTail;
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      this.lockTail = prior.then(() => held);
      await prior;
      releaseLock = release;
    };
    return {
      query: async <Row = Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = [],
      ) => {
        if (text === "BEGIN ISOLATION LEVEL SERIALIZABLE" || text === "ROLLBACK") {
          if (text === "ROLLBACK") releaseLock?.();
          return { rows: [], rowCount: 0 };
        }
        if (text === "COMMIT") {
          releaseLock?.();
          if (this.failNextCommitAfterApply) {
            this.failNextCommitAfterApply = false;
            throw new Error("database commit acknowledgement outcome unknown");
          }
          return { rows: [], rowCount: 0 };
        }
        if (text.includes("FOR UPDATE")) {
          await acquire();
          return { rows: [structuredClone(this.row) as Row], rowCount: 1 };
        }
        if (text.startsWith("UPDATE dacs_wallet_spend_lineages")) {
          if (this.failNextSerializableAdvance) {
            this.failNextSerializableAdvance = false;
            const error = new Error("serialization failure") as Error & { code: string };
            error.code = "40001";
            throw error;
          }
          if (this.row.revision !== Number(values[4]) ||
              this.row.state_hash !== String(values[5])) {
            return { rows: [], rowCount: 0 };
          }
          this.row.revision = Number(values[1]);
          this.row.state_hash = String(values[2]);
          this.row.state = JSON.parse(String(values[3])) as WalletSpendStateV1;
          return { rows: [], rowCount: 1 };
        }
        if (text.startsWith("UPDATE dacs_wallet_spend_candidates")) {
          const candidate = [...this.candidates.values()].find(({ candidate_id }) =>
            candidate_id === String(values[0]));
          if (candidate?.status === "prepared") {
            candidate.status = text.includes("'superseded'") ? "superseded" : "applied";
            return { rows: [], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        throw new Error(`unexpected client query: ${text}`);
      },
      release() { releaseLock?.(); },
    };
  }
}

function fakePool(): FakePostgresPool {
  const selected = policy("policy-a");
  const policyHash = dacsWalletSpendPolicyHashV1(selected);
  const state: WalletSpendStateV1 = {
    stateVersion: WALLET_SPEND_STATE_VERSION,
    policyHash,
    generation: 0,
    reservations: [],
    totals: [],
    rollingEvents: [],
  };
  return new FakePostgresPool({
    policy_hash: policyHash,
    revision: 0,
    state_hash: hashState(state),
    state,
  });
}

describe("PostgreSQL wallet authority persistence", () => {
  it("keys lineage only by canonical wallet+chain and declares unique durable tables", () => {
    expect(dacsWalletSpendLineageKeyV1("wallet-a", "chain-a")).toBe(
      dacsWalletSpendLineageKeyV1(policy("deployment-b").wallet, policy("policy-b").chainId),
    );
    expect(dacsWalletSpendPolicyHashV1(policy("policy-a"))).not.toBe(
      dacsWalletSpendPolicyHashV1(policy("policy-b")),
    );
    expect(DACS_WALLET_SPEND_POSTGRES_SCHEMA_V1).toContain("UNIQUE (wallet, chain_id)");
    expect(DACS_WALLET_SPEND_POSTGRES_SCHEMA_V1).toContain("candidate_state jsonb NOT NULL");
    expect(DACS_WALLET_SPEND_POSTGRES_SCHEMA_V1).toContain("role_id text NOT NULL");
    expect(DACS_WALLET_SPEND_POSTGRES_SCHEMA_V1).toContain(
      "WITH unambiguous_candidate_roles AS",
    );
    expect(DACS_WALLET_SPEND_POSTGRES_SCHEMA_V1).toContain(
      "UNIQUE (lineage_key, operation_id, mutation_index)",
    );
  });

  it("quiesces role migration, rejects ambiguous rows and fences legacy writers", () => {
    const schema = DACS_WALLET_SPEND_POSTGRES_SCHEMA_V1;
    const operationLock = schema.indexOf(
      "LOCK TABLE dacs_wallet_spend_operations IN ACCESS EXCLUSIVE MODE",
    );
    const lock = schema.indexOf(
      "LOCK TABLE dacs_wallet_spend_candidates IN ACCESS EXCLUSIVE MODE",
    );
    const addRole = schema.indexOf("ADD COLUMN IF NOT EXISTS role_id text", lock);
    const backfill = schema.indexOf("WITH unambiguous_candidate_roles AS", addRole);
    const rejectNull = schema.indexOf("IF EXISTS (", backfill);
    const requireRole = schema.indexOf("ALTER COLUMN role_id SET NOT NULL", rejectNull);
    const migrationEnd = schema.indexOf("$dacs_wallet_spend_role_migration$;", requireRole);

    expect(operationLock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(operationLock);
    expect(addRole).toBeGreaterThan(lock);
    expect(backfill).toBeGreaterThan(addRole);
    expect(rejectNull).toBeGreaterThan(backfill);
    expect(schema.slice(rejectNull, requireRole)).toContain(
      "wallet-spend-candidate-role-migration-ambiguous",
    );
    expect(requireRole).toBeGreaterThan(rejectNull);
    expect(migrationEnd).toBeGreaterThan(requireRole);
    // Once the exclusive migration lock releases, a d0e26c INSERT that omits
    // role_id is rejected by this database constraint.
    expect(schema.slice(lock, migrationEnd)).toContain(
      "ALTER COLUMN role_id SET NOT NULL",
    );
  });

  it("treats missing lineage and read-only inspection as nonauthorizing without writes", async () => {
    const statements: string[] = [];
    const pool = {
      async query(text: string) {
        statements.push(text);
        if (text.startsWith("SELECT floor")) {
          return { rows: [{ now_ms: "1000" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      async connect() { throw new Error("unexpected transaction"); },
    } as unknown as DacsPostgresPoolV1;
    const store = createDacsPostgresWalletSpendStateStoreV1({
      pool, wallet: "wallet-a", chainId: "chain-a",
    });
    await expect(store.read!(dacsWalletSpendLineageKeyV1("wallet-a", "chain-a")))
      .rejects.toThrow(/lineage-missing/);
    expect(statements.some((statement) => /INSERT|UPDATE|DELETE/.test(statement))).toBe(false);
  });

  it("imports only authenticated complete legacy state and refuses overwrite", async () => {
    const selected = policy("policy-a");
    const state = legacyState(selected);
    const inserts: { text: string; values: readonly unknown[] }[] = [];
    let exists = false;
    const pool = {
      async query(text: string, values: readonly unknown[] = []) {
        inserts.push({ text, values });
        if (exists) return { rows: [], rowCount: 0 };
        exists = true;
        return { rows: [], rowCount: 1 };
      },
      async connect() { throw new Error("unexpected transaction"); },
    } as DacsPostgresPoolV1;
    const evidence = {
      sourceIdentity: "authenticated-fs-journal:buyer-production-v1",
      evidenceHash: "d".repeat(64),
    };

    await importDacsWalletSpendPostgresLegacyStateV1(pool, {
      policy: selected,
      state,
      sourceEvidence: evidence,
      authenticateEvidence: async (observed, imported) =>
        observed.evidenceHash === evidence.evidenceHash && imported.generation === 5,
    });
    expect(inserts[0]?.text).toContain("'legacy-import'");
    expect(inserts[0]?.values[4]).toBe(5);
    expect(JSON.parse(String(inserts[0]?.values[6]))).toMatchObject({
      generation: 5,
      reservations: [{ stage: "effect-pending", owner: "legacy-worker" }],
    });
    await expect(importDacsWalletSpendPostgresLegacyStateV1(pool, {
      policy: selected,
      state,
      sourceEvidence: evidence,
      authenticateEvidence: () => true,
    })).rejects.toThrow(/already-exists/);
  });

  it("requires authenticated evidence for both legacy import and a demonstrably new lineage", async () => {
    const selected = policy("policy-a");
    const state = legacyState(selected);
    let writes = 0;
    const pool = {
      async query() { writes += 1; return { rows: [], rowCount: 1 }; },
      async connect() { throw new Error("unexpected transaction"); },
    } as unknown as DacsPostgresPoolV1;
    await expect(importDacsWalletSpendPostgresLegacyStateV1(pool, {
      policy: selected,
      state,
      sourceEvidence: {
        sourceIdentity: "authenticated-fs-journal:buyer-production-v1",
        evidenceHash: "d".repeat(64),
      },
      authenticateEvidence: () => false,
    })).rejects.toThrow(/evidence-rejected/);
    await expect(provisionDacsWalletSpendPostgresLineageV1(pool, {
      policy: selected,
      newLineageEvidence: {
        sourceIdentity: "operator-wallet-inventory:new-wallet-chain",
        evidenceHash: "e".repeat(64),
      },
      authenticateEvidence: () => false,
    })).rejects.toThrow(/evidence-rejected/);
    await expect(importDacsWalletSpendPostgresLegacyStateV1(pool, {
      policy: selected,
      state,
      sourceEvidence: { sourceIdentity: "", evidenceHash: "d".repeat(64) },
      authenticateEvidence: () => true,
    })).rejects.toThrow(/evidence-invalid/);
    expect(writes).toBe(0);
  });

  it("recovers a legacy raw reserve candidate only for its authenticated role", async () => {
    const selected = policy("policy-a");
    const policyHash = dacsWalletSpendPolicyHashV1(selected);
    const retainedReservation: WalletSpendReservationV1 = {
      reservationVersion: "1",
      reservationId: "remote-reserve",
      jobId: "job-remote",
      phaseIndex: 0,
      phase: "payment",
      agreementHash: "a".repeat(64),
      settlementBindingHash: "b".repeat(64),
      railId: "rail-a",
      railDefinitionHash: "c".repeat(64),
      wallet: selected.wallet,
      chainId: selected.chainId,
      payee: "payee-a",
      finality: { model: "final" },
      debits: [{
        asset: "ASSET",
        purpose: "service",
        expectedAmount: "25",
        maximumAmount: "25",
      }],
    };
    const bindingHash = sha256Hex(
      `dacs-wallet-spend-reservation:v1:${canonicalize(retainedReservation)}`,
    );
    const candidateState: WalletSpendStateV1 = {
      stateVersion: WALLET_SPEND_STATE_VERSION,
      policyHash,
      generation: 1,
      reservations: [{
        reservationId: retainedReservation.reservationId,
        bindingHash,
        reservation: retainedReservation,
        stage: "reserved",
        generation: 1,
        owner: "wallet-service",
        leaseExpiresAt: 60_000,
        createdAt: 1_000,
        updatedAt: 1_000,
      }],
      totals: [],
      rollingEvents: [],
    };
    const operationId = "00000000-0000-4000-8000-000000000021";
    const request = {
      protocolVersion: "1",
      operationId,
      policyHash,
      wallet: selected.wallet,
      chainId: selected.chainId,
      operation: "reserve",
      payload: { reservation: retainedReservation, options: {} },
    };
    const requestHash = sha256Hex(canonicalize(request));
    const authoritative: {
      policy_hash: string;
      revision: number;
      state_hash: string;
      state: WalletSpendStateV1;
    } = {
      policy_hash: policyHash,
      revision: 1,
      state_hash: hashState(candidateState),
      state: candidateState,
    };
    const victimRole = "victim";
    const attackerRole = "attacker";
    const pool = {
      async query(text: string, values: readonly unknown[] = []) {
        if (text.startsWith("SELECT request_hash")) {
          if (values[0] !== victimRole && values[0] !== attackerRole) {
            return { rows: [], rowCount: 0 };
          }
          return { rows: [{
            request_hash: requestHash,
            request,
            response: null,
          }], rowCount: 1 };
        }
        if (text.startsWith("SELECT candidate_id")) {
          if (values[1] !== victimRole) return { rows: [], rowCount: 0 };
          return { rows: [{
            candidate_id: "00000000-0000-4000-8000-000000000022",
            lineage_key: dacsWalletSpendLineageKeyV1(selected.wallet, selected.chainId),
            role_id: victimRole,
            request_hash: requestHash,
            prior_revision: 0,
            prior_state_hash: "d".repeat(64),
            next_revision: 1,
            next_state_hash: hashState(candidateState),
            candidate_state: candidateState,
            // d0e26c wrote the result directly rather than using an envelope.
            candidate_value: { status: "reserved", generation: 1 },
            status: "applied",
          }], rowCount: 1 };
        }
        if (text.startsWith("SELECT policy_hash")) {
          return { rows: [structuredClone(authoritative)], rowCount: 1 };
        }
        throw new Error(`unexpected query: ${text}`);
      },
      async connect() { throw new Error("unexpected transaction"); },
    } as unknown as DacsPostgresPoolV1;
    const operations = createDacsPostgresWalletSpendRemoteOperationStoreV1(pool);

    await expect(operations.load({
      roleId: victimRole,
      operationId,
    })).resolves.toMatchObject({
      requestHash,
      response: {
        operationId,
        requestHash,
        revision: 1,
        result: {
          status: "reserved",
          permit: {
            reservationId: retainedReservation.reservationId,
            bindingHash,
            owner: "wallet-service",
            generation: 1,
          },
        },
      },
    });
    await expect(operations.load({
      roleId: attackerRole,
      operationId,
    })).resolves.toEqual({ requestHash, request });

    const authority = createWalletSpendAuthorityV1(selected, {
      store: createInMemoryWalletSpendStateStore(),
      readBalance: async () => "1000",
      authenticateRecovery: async () => true,
      owner: "wallet-service",
      now: () => 1_000,
    });
    const victimToken = "victim-role-token-which-is-long-enough";
    const attackerToken = "attacker-role-token-which-is-long-enough";
    const handler = createDacsWalletSpendAuthorityServiceV1({
      authenticate: (token) => token === victimToken ? victimRole :
        token === attackerToken ? attackerRole : null,
      resolveAuthority: ({ roleId, wallet, chainId, policyHash: resolvedHash }) =>
        roleId === victimRole && wallet === selected.wallet && chainId === selected.chainId &&
          resolvedHash === policyHash ? authority : null,
      operations,
    });
    const operationUrl = `http://authority.test/v1/wallet-spend/operations/${operationId}` +
      `?requestHash=${requestHash}`;
    const attackerResponse = await handler(new Request(operationUrl, {
      headers: { authorization: `Bearer ${attackerToken}` },
    }));
    expect(attackerResponse.status).toBe(400);
    await expect(attackerResponse.json()).resolves.toEqual({
      reasonCode: "wallet-spend-authority-lineage-unavailable",
    });
    const victimResponse = await handler(new Request(operationUrl, {
      headers: { authorization: `Bearer ${victimToken}` },
    }));
    expect(victimResponse.status).toBe(200);
    await expect(victimResponse.json()).resolves.toMatchObject({
      operationId,
      requestHash,
      result: { status: "reserved", permit: { reservationId: "remote-reserve" } },
    });

    const staleState: WalletSpendStateV1 = {
      stateVersion: WALLET_SPEND_STATE_VERSION,
      policyHash,
      generation: 0,
      reservations: [],
      totals: [],
      rollingEvents: [],
    };
    authoritative.revision = 0;
    authoritative.state_hash = hashState(staleState);
    authoritative.state = staleState;
    await expect(operations.load({
      roleId: victimRole,
      operationId,
    })).rejects.toThrow(/applied-candidate-missing/);
  });

  it("prepares policy migration before exact row-locked head advance and retains accounting", async () => {
    const previous = policy("policy-a");
    const next = { ...policy("policy-b"), maximumRetainedReservations: 20 };
    const previousHash = dacsWalletSpendPolicyHashV1(previous);
    const settledReservation: WalletSpendReservationV1 = {
      reservationVersion: "1",
      reservationId: "settled-before-migration",
      jobId: "job-settled",
      phaseIndex: 0,
      phase: "payment",
      agreementHash: "a".repeat(64),
      settlementBindingHash: "b".repeat(64),
      railId: "rail-a",
      railDefinitionHash: "c".repeat(64),
      wallet: previous.wallet,
      chainId: previous.chainId,
      payee: "payee-a",
      finality: { model: "final" },
      debits: [{
        asset: "ASSET",
        purpose: "service",
        expectedAmount: "25",
        maximumAmount: "25",
      }],
    };
    let row: {
      policy_hash: string;
      revision: number;
      state_hash: string;
      state: WalletSpendStateV1;
    } = {
      policy_hash: previousHash,
      revision: 3,
      state_hash: "",
      state: {
        stateVersion: WALLET_SPEND_STATE_VERSION,
        policyHash: previousHash,
        generation: 3,
        reservations: [{
          reservationId: settledReservation.reservationId,
          bindingHash: sha256Hex(
            `dacs-wallet-spend-reservation:v1:${canonicalize(settledReservation)}`,
          ),
          reservation: settledReservation,
          stage: "settled",
          generation: 1,
          evidenceHash: "d".repeat(64),
          actualDebits: [{ asset: "ASSET", purpose: "service", amount: "25" }],
          createdAt: 1_000,
          updatedAt: 1_100,
        }],
        totals: [{
          asset: "ASSET",
          cumulativeDebit: "25",
          counterpartyDebits: { "payee-a": "25" },
        }],
        rollingEvents: [],
      } satisfies WalletSpendStateV1,
    };
    row.state_hash = hashState(row.state);
    const statements: string[] = [];
    const client: DacsPostgresClientV1 = {
      async query(text, values = []) {
        statements.push(text.trim());
        if (text.startsWith("SELECT policy_hash")) {
          return { rows: [structuredClone(row)], rowCount: 1 } as never;
        }
        if (text.startsWith("UPDATE dacs_wallet_spend_lineages")) {
          row = {
            policy_hash: String(values[1]),
            revision: Number(values[2]),
            state_hash: String(values[3]),
            state: JSON.parse(String(values[4])) as WalletSpendStateV1,
          };
          return { rows: [], rowCount: 1 } as never;
        }
        return { rows: [], rowCount: 1 } as never;
      },
      release() {},
    };
    const pool: DacsPostgresPoolV1 = {
      async query(text) {
        statements.push(text.trim());
        if (text.startsWith("SELECT policy_hash")) {
          return { rows: [structuredClone(row)], rowCount: 1 } as never;
        }
        return { rows: [], rowCount: 1 } as never;
      },
      async connect() { return client; },
    };

    await migrateDacsWalletSpendPostgresPolicyV1(pool, {
      previousPolicyHash: previousHash,
      policy: next,
    });

    const prepared = statements.findIndex((text) =>
      text.startsWith("INSERT INTO dacs_wallet_spend_candidates"));
    const locked = statements.findIndex((text) =>
      text.includes("FOR UPDATE"));
    const advanced = statements.findIndex((text) =>
      text.startsWith("UPDATE dacs_wallet_spend_lineages"));
    expect(prepared).toBeGreaterThanOrEqual(0);
    expect(locked).toBeGreaterThan(prepared);
    expect(advanced).toBeGreaterThan(locked);
    expect(statements).toContain("BEGIN ISOLATION LEVEL SERIALIZABLE");
    expect(row).toMatchObject({
      policy_hash: dacsWalletSpendPolicyHashV1(next),
      revision: 4,
      state: {
        generation: 4,
        totals: [{ cumulativeDebit: "25", counterpartyDebits: { "payee-a": "25" } }],
      },
    });
  });

  it("reuses an immutable prepared candidate after an uncertain connection outcome", async () => {
    const pool = fakePool();
    pool.failNextConnect = true;
    const store = () => createDacsPostgresWalletSpendStateStoreV1({
      pool,
      wallet: "wallet-a",
      chainId: "chain-a",
      operation: () => ({
        roleId: "buyer",
        operationId: "00000000-0000-4000-8000-000000000001",
        requestHash: "1".repeat(64),
      }),
    });
    const mutate = (current: Readonly<WalletSpendStateV1> | null) => ({
      state: { ...current!, generation: current!.generation + 1 },
      value: "authorized",
    });

    await expect(store().transact(
      dacsWalletSpendLineageKeyV1("wallet-a", "chain-a"), mutate,
    )).rejects.toThrow(/outcome unknown/);
    expect([...pool.candidates.values()]).toMatchObject([{ status: "prepared" }]);

    await expect(store().transact(
      dacsWalletSpendLineageKeyV1("wallet-a", "chain-a"), mutate,
    )).resolves.toBe("authorized");
    expect(pool.row.revision).toBe(1);
    expect([...pool.candidates.values()]).toMatchObject([{ status: "applied" }]);
  });

  it("applies d0e26c prepared candidates with raw values and raw null as undefined", async () => {
    const cases: readonly Readonly<{ raw: unknown; expected: unknown; suffix: string }>[] = [
      { raw: "authorized", expected: "authorized", suffix: "31" },
      { raw: null, expected: undefined, suffix: "32" },
    ];
    for (const selectedCase of cases) {
      const pool = fakePool();
      const lineage = dacsWalletSpendLineageKeyV1("wallet-a", "chain-a");
      const roleId = "buyer";
      const operationId = `00000000-0000-4000-8000-0000000000${selectedCase.suffix}`;
      const requestHash = selectedCase.suffix[0]!.repeat(64);
      const nextState = { ...pool.row.state, generation: 1 };
      const key = `${lineage}\0${roleId}\0${operationId}\0${0}`;
      pool.candidates.set(key, {
        candidate_id: `00000000-0000-4000-8000-0000000001${selectedCase.suffix}`,
        role_id: roleId,
        request_hash: requestHash,
        prior_revision: 0,
        prior_state_hash: pool.row.state_hash,
        next_revision: 1,
        next_state_hash: hashState(nextState),
        candidate_state: nextState,
        candidate_value: selectedCase.raw,
        status: "prepared",
      });
      const store = createDacsPostgresWalletSpendStateStoreV1({
        pool,
        wallet: "wallet-a",
        chainId: "chain-a",
        operation: () => ({ roleId, operationId, requestHash }),
      });

      await expect(store.transact<unknown>(lineage, (current) => ({
        state: { ...current!, generation: current!.generation + 1 },
        value: selectedCase.expected,
      }))).resolves.toBe(selectedCase.expected);
      expect(pool.row.revision).toBe(1);
      expect(pool.candidates.get(key)?.status).toBe("applied");
    }
  });

  it("rejects a malformed version-marked candidate value during upgrade", async () => {
    const pool = fakePool();
    const lineage = dacsWalletSpendLineageKeyV1("wallet-a", "chain-a");
    const roleId = "buyer";
    const operationId = "00000000-0000-4000-8000-000000000033";
    const requestHash = "3".repeat(64);
    const nextState = { ...pool.row.state, generation: 1 };
    pool.candidates.set(`${lineage}\0${roleId}\0${operationId}\0${0}`, {
      candidate_id: "00000000-0000-4000-8000-000000000133",
      role_id: roleId,
      request_hash: requestHash,
      prior_revision: 0,
      prior_state_hash: pool.row.state_hash,
      next_revision: 1,
      next_state_hash: hashState(nextState),
      candidate_state: nextState,
      candidate_value: { valueVersion: "1", defined: true },
      status: "prepared",
    });
    const store = createDacsPostgresWalletSpendStateStoreV1({
      pool,
      wallet: "wallet-a",
      chainId: "chain-a",
      operation: () => ({ roleId, operationId, requestHash }),
    });

    await expect(store.transact(lineage, (current) => ({
      state: { ...current!, generation: current!.generation + 1 },
      value: "authorized",
    }))).rejects.toThrow(/candidate-value-invalid/);
    expect(pool.row.revision).toBe(0);
  });

  it("retains the exact applied candidate after a lost commit acknowledgement", async () => {
    const pool = fakePool();
    pool.failNextCommitAfterApply = true;
    const store = createDacsPostgresWalletSpendStateStoreV1({
      pool,
      wallet: "wallet-a",
      chainId: "chain-a",
      operation: () => ({
        roleId: "buyer",
        operationId: "00000000-0000-4000-8000-000000000011",
        requestHash: "a".repeat(64),
      }),
    });
    const mutate = (current: Readonly<WalletSpendStateV1> | null) => ({
      state: { ...current!, generation: current!.generation + 1 },
      value: Object.freeze({ status: "authorized", generation: 1 }),
    });
    const scope = dacsWalletSpendLineageKeyV1("wallet-a", "chain-a");

    await expect(store.transact(scope, mutate)).rejects.toThrow(/outcome unknown/);
    expect(pool.row.revision).toBe(1);
    expect([...pool.candidates.values()]).toMatchObject([{ status: "applied" }]);
  });

  it("retries a serialization failure against the same durable candidate", async () => {
    const pool = fakePool();
    pool.failNextSerializableAdvance = true;
    const store = createDacsPostgresWalletSpendStateStoreV1({
      pool,
      wallet: "wallet-a",
      chainId: "chain-a",
      operation: () => ({
        roleId: "buyer",
        operationId: "00000000-0000-4000-8000-000000000012",
        requestHash: "b".repeat(64),
      }),
    });
    const scope = dacsWalletSpendLineageKeyV1("wallet-a", "chain-a");

    await expect(store.transact(scope, (current) => ({
      state: { ...current!, generation: current!.generation + 1 },
      value: "authorized",
    }))).resolves.toBe("authorized");
    expect(pool.row.revision).toBe(1);
    expect([...pool.candidates.values()]).toMatchObject([{ status: "applied" }]);
  });

  it("assigns distinct candidate ordinals to multiple mutations in one request", async () => {
    const pool = fakePool();
    const store = createDacsPostgresWalletSpendStateStoreV1({
      pool,
      wallet: "wallet-a",
      chainId: "chain-a",
      operation: () => ({
        roleId: "buyer",
        operationId: "00000000-0000-4000-8000-000000000013",
        requestHash: "c".repeat(64),
      }),
    });
    const scope = dacsWalletSpendLineageKeyV1("wallet-a", "chain-a");
    const mutate = (value: string) => store.transact(scope, (current) => ({
      state: { ...current!, generation: current!.generation + 1 },
      value,
    }));

    await expect(mutate("first")).resolves.toBe("first");
    await expect(mutate("second")).resolves.toBe("second");
    expect(pool.row.revision).toBe(2);
    expect([...pool.candidates.keys()].map((key) => key.split("\0").at(-1)))
      .toEqual(["0", "8"]);
    expect([...pool.candidates.values()]).toMatchObject([
      { status: "applied" }, { status: "applied" },
    ]);
  });

  it("serializes concurrent heads, supersedes the loser and advances both mutations", async () => {
    const pool = fakePool();
    const scope = dacsWalletSpendLineageKeyV1("wallet-a", "chain-a");
    const store = (suffix: string) => createDacsPostgresWalletSpendStateStoreV1({
      pool,
      wallet: "wallet-a",
      chainId: "chain-a",
      operation: () => ({
        roleId: "buyer",
        operationId: `00000000-0000-4000-8000-00000000000${suffix}`,
        requestHash: suffix.repeat(64),
      }),
    });
    const mutate = (label: string) => (current: Readonly<WalletSpendStateV1> | null) => ({
      state: {
        ...current!,
        generation: current!.generation + 1,
      },
      value: label,
    });

    await expect(Promise.all([
      store("2").transact(scope, mutate("a")),
      store("3").transact(scope, mutate("b")),
    ])).resolves.toEqual(["a", "b"]);
    expect(pool.row.revision).toBe(2);
    expect(pool.row.state.generation).toBe(2);
    expect([...pool.candidates.values()].filter(({ status }) => status === "applied"))
      .toHaveLength(2);
    expect([...pool.candidates.values()].filter(({ status }) => status === "superseded"))
      .toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";

import {
  WALLET_SPEND_STATE_VERSION,
  type WalletSpendPolicyV1,
  type WalletSpendReservationV1,
  type WalletSpendStateV1,
} from "@kynesyslabs/dacs";
import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";

import {
  DACS_WALLET_SPEND_POSTGRES_SCHEMA_V1,
  createDacsPostgresWalletSpendStateStoreV1,
  dacsWalletSpendLineageKeyV1,
  dacsWalletSpendPolicyHashV1,
  importDacsWalletSpendPostgresLegacyStateV1,
  migrateDacsWalletSpendPostgresPolicyV1,
  provisionDacsWalletSpendPostgresLineageV1,
  type DacsPostgresClientV1,
  type DacsPostgresPoolV1,
} from "../src/walletSpendPostgres.js";

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
      const key = `${String(values[1])}\0${String(values[2])}\0${String(values[4])}`;
      if (!this.candidates.has(key)) {
        this.candidates.set(key, {
          candidate_id: String(values[0]),
          request_hash: String(values[3]),
          prior_revision: Number(values[5]),
          prior_state_hash: String(values[6]),
          next_revision: Number(values[7]),
          next_state_hash: String(values[8]),
          candidate_state: JSON.parse(String(values[9])) as WalletSpendStateV1,
          candidate_value: JSON.parse(String(values[10])) as unknown,
          status: "prepared",
        });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (text.startsWith("SELECT candidate_id")) {
      const key = `${String(values[0])}\0${String(values[1])}\0${String(values[2])}`;
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
          return { rows: [], rowCount: 0 };
        }
        if (text.includes("FOR UPDATE")) {
          await acquire();
          return { rows: [structuredClone(this.row) as Row], rowCount: 1 };
        }
        if (text.startsWith("UPDATE dacs_wallet_spend_lineages")) {
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
    expect(DACS_WALLET_SPEND_POSTGRES_SCHEMA_V1).toContain(
      "UNIQUE (lineage_key, operation_id, mutation_index)",
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

  it("prepares policy migration before exact row-locked head advance and retains accounting", async () => {
    const previous = policy("policy-a");
    const next = { ...policy("policy-b"), maximumRetainedReservations: 20 };
    const previousHash = dacsWalletSpendPolicyHashV1(previous);
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
        reservations: [],
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
    const store = createDacsPostgresWalletSpendStateStoreV1({
      pool,
      wallet: "wallet-a",
      chainId: "chain-a",
      operation: () => ({
        operationId: "00000000-0000-4000-8000-000000000001",
        requestHash: "1".repeat(64),
      }),
    });
    const mutate = (current: Readonly<WalletSpendStateV1> | null) => ({
      state: { ...current!, generation: current!.generation + 1 },
      value: "authorized",
    });

    await expect(store.transact(
      dacsWalletSpendLineageKeyV1("wallet-a", "chain-a"), mutate,
    )).rejects.toThrow(/outcome unknown/);
    expect([...pool.candidates.values()]).toMatchObject([{ status: "prepared" }]);

    await expect(store.transact(
      dacsWalletSpendLineageKeyV1("wallet-a", "chain-a"), mutate,
    )).resolves.toBe("authorized");
    expect(pool.row.revision).toBe(1);
    expect([...pool.candidates.values()]).toMatchObject([{ status: "applied" }]);
  });

  it("serializes concurrent heads, supersedes the loser and advances both mutations", async () => {
    const pool = fakePool();
    const scope = dacsWalletSpendLineageKeyV1("wallet-a", "chain-a");
    const store = (suffix: string) => createDacsPostgresWalletSpendStateStoreV1({
      pool,
      wallet: "wallet-a",
      chainId: "chain-a",
      operation: () => ({
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

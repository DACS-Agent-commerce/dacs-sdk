import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  DACS_WALLET_SPEND_POSTGRES_CONTINUITY_ADOPTION_SCHEMA_V1,
  adoptDacsWalletSpendPostgresContinuityV1,
  createInMemoryDacsWalletSpendContinuityWitnessV1,
  createDacsPostgresWalletSpendStateStoreV1,
  createDacsPostgresWalletSpendRemoteOperationStoreV1,
  dacsWalletSpendLineageKeyV1,
  dacsWalletSpendPolicyHashV1,
  importDacsWalletSpendPostgresLegacyStateV1,
  migrateDacsWalletSpendPostgresPolicyV1,
  provisionDacsWalletSpendPostgresLineageV1,
  type DacsPostgresClientV1,
  type DacsPostgresPoolV1,
  type DacsWalletSpendContinuityPinV1,
  type DacsWalletSpendContinuityReceiptV1,
} from "../src/walletSpendPostgres.js";
import {
  createDacsRemoteWalletSpendAuthorityV1,
  createDacsWalletSpendAuthorityServiceV1,
} from "../src/walletSpendRemote.js";

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

function newContinuity(seedByte = 7): DacsWalletSpendContinuityPinV1 {
  const reference = createInMemoryDacsWalletSpendContinuityWitnessV1({
    authorityId: "authority-test", epoch: "epoch-1",
    seed: new Uint8Array(32).fill(seedByte),
  });
  return {
    authorityId: "authority-test", epoch: "epoch-1",
    verificationKey: reference.verificationKey, witness: reference.witness,
  };
}

interface FakeCandidate {
  candidate_id: string;
  authority_id: string;
  continuity_epoch: string;
  role_id: string | null;
  request_hash: string;
  mutation_index: number;
  prior_revision: number | null;
  prior_state_hash: string | null;
  next_revision: number;
  next_state_hash: string;
  candidate_state: WalletSpendStateV1;
  candidate_value: unknown;
  continuity_receipt: DacsWalletSpendContinuityReceiptV1 | null;
  status: "prepared" | "applied" | "superseded";
}

interface RecoveryLineageRow {
  writer_contract_version: number | null;
  authority_id: string | null;
  continuity_epoch: string | null;
  continuity_verification_key: string | null;
  continuity_status: "active" | null;
  continuity_receipt: DacsWalletSpendContinuityReceiptV1 | null;
  policy_hash: string;
  revision: number;
  state_hash: string;
  state: WalletSpendStateV1;
}

/** Minimal operator-flow database with an injectable post-witness connection loss. */
class RecoveryPostgresPool implements DacsPostgresPoolV1 {
  readonly candidates = new Map<string, FakeCandidate>();
  failNextConnect = false;
  failNextCommitAfterApply = false;

  constructor(readonly row: RecoveryLineageRow) {}

  private candidateKey(
    lineageKey: unknown,
    roleId: unknown,
    operationId: unknown,
    mutationIndex: unknown,
  ): string {
    return `${String(lineageKey)}\0${String(roleId)}\0${String(operationId)}` +
      `\0${String(mutationIndex)}`;
  }

  async query<Row = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    if (text.includes("FROM dacs_wallet_spend_lineages")) {
      return { rows: [structuredClone(this.row) as Row], rowCount: 1 };
    }
    if (text.startsWith("INSERT INTO dacs_wallet_spend_candidates")) {
      const adoption = values.length === 11;
      const key = this.candidateKey(values[1], values[4], values[5], 0);
      if (this.candidates.has(key)) return { rows: [], rowCount: 0 };
      this.candidates.set(key, {
        candidate_id: String(values[0]),
        authority_id: String(values[2]),
        continuity_epoch: String(values[3]),
        role_id: String(values[4]),
        request_hash: String(values[6]),
        mutation_index: 0,
        prior_revision: adoption ? null : Number(values[7]),
        prior_state_hash: adoption ? null : String(values[8]),
        next_revision: Number(values[adoption ? 7 : 9]),
        next_state_hash: String(values[adoption ? 8 : 10]),
        candidate_state: JSON.parse(String(values[adoption ? 9 : 11])) as WalletSpendStateV1,
        candidate_value: JSON.parse(String(values[adoption ? 10 : 12])) as unknown,
        continuity_receipt: null,
        status: "prepared",
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("SELECT candidate_id")) {
      const candidate = this.candidates.get(
        this.candidateKey(values[0], values[1], values[2], values[3]),
      );
      return {
        rows: candidate === undefined ? [] : [structuredClone(candidate) as Row],
        rowCount: candidate === undefined ? 0 : 1,
      };
    }
    throw new Error(`unexpected recovery pool query: ${text}`);
  }

  async connect(): Promise<DacsPostgresClientV1> {
    if (this.failNextConnect) {
      this.failNextConnect = false;
      throw new Error("database connection outcome unknown");
    }
    return {
      query: async <Row = Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = [],
      ) => {
        if (text === "BEGIN ISOLATION LEVEL SERIALIZABLE" || text === "ROLLBACK" ||
            text.startsWith("SELECT set_config")) {
          return { rows: [] as Row[], rowCount: 0 };
        }
        if (text === "COMMIT") {
          if (this.failNextCommitAfterApply) {
            this.failNextCommitAfterApply = false;
            throw new Error("database commit acknowledgement outcome unknown");
          }
          return { rows: [] as Row[], rowCount: 0 };
        }
        if (text.includes("FROM dacs_wallet_spend_lineages") && text.includes("FOR UPDATE")) {
          return { rows: [structuredClone(this.row) as Row], rowCount: 1 };
        }
        if (text.startsWith("UPDATE dacs_wallet_spend_lineages") &&
            text.includes("SET writer_contract_version = 2")) {
          if (this.row.revision !== Number(values[5]) ||
              this.row.state_hash !== String(values[6]) || this.row.authority_id !== null) {
            return { rows: [] as Row[], rowCount: 0 };
          }
          this.row.writer_contract_version = 2;
          this.row.authority_id = String(values[1]);
          this.row.continuity_epoch = String(values[2]);
          this.row.continuity_verification_key = String(values[3]);
          this.row.continuity_status = "active";
          this.row.continuity_receipt = JSON.parse(
            String(values[4]),
          ) as DacsWalletSpendContinuityReceiptV1;
          return { rows: [] as Row[], rowCount: 1 };
        }
        if (text.startsWith("UPDATE dacs_wallet_spend_lineages")) {
          if (this.row.revision !== Number(values[6]) ||
              this.row.state_hash !== String(values[7])) {
            return { rows: [] as Row[], rowCount: 0 };
          }
          this.row.policy_hash = String(values[1]);
          this.row.revision = Number(values[2]);
          this.row.state_hash = String(values[3]);
          this.row.state = JSON.parse(String(values[4])) as WalletSpendStateV1;
          this.row.continuity_receipt = JSON.parse(
            String(values[5]),
          ) as DacsWalletSpendContinuityReceiptV1;
          return { rows: [] as Row[], rowCount: 1 };
        }
        if (text.startsWith("UPDATE dacs_wallet_spend_candidates") &&
            text.includes("SET writer_contract_version = 2")) {
          return { rows: [] as Row[], rowCount: this.candidates.size };
        }
        if (text.startsWith("UPDATE dacs_wallet_spend_candidates")) {
          const candidate = [...this.candidates.values()].find(({ candidate_id }) =>
            candidate_id === String(values[0]));
          if (candidate?.status !== "prepared") {
            return { rows: [] as Row[], rowCount: 0 };
          }
          candidate.status = "applied";
          candidate.continuity_receipt = JSON.parse(
            String(values[1]),
          ) as DacsWalletSpendContinuityReceiptV1;
          return { rows: [] as Row[], rowCount: 1 };
        }
        if (text.startsWith("UPDATE dacs_wallet_spend_operations")) {
          return { rows: [] as Row[], rowCount: 1 };
        }
        throw new Error(`unexpected recovery client query: ${text}`);
      },
      release() {},
    };
  }
}

function failOneContinuityAdvance(
  pin: DacsWalletSpendContinuityPinV1,
): DacsWalletSpendContinuityPinV1 {
  let fail = true;
  return {
    ...pin,
    witness: {
      readCurrent: (input) => pin.witness.readCurrent(input),
      async compareAndSet(input) {
        if (fail) {
          fail = false;
          throw new Error("continuity service unavailable before advance");
        }
        return pin.witness.compareAndSet(input);
      },
      lookupAdvance: (input) => pin.witness.lookupAdvance(input),
    },
  };
}

class FakePostgresPool implements DacsPostgresPoolV1 {
  readonly candidates = new Map<string, FakeCandidate>();
  readonly operations = new Map<string, {
    request_hash: string;
    request: unknown;
    response: unknown | null;
  }>();
  readonly operationCounts = new Map<string, number>([["global", 0]]);
  failNextConnect = false;
  failNextCommitAfterApply = false;
  failNextSerializableAdvance = false;
  nowMs = 1_000;
  private lockTail: Promise<void> = Promise.resolve();

  constructor(readonly row: {
    writer_contract_version: number;
    authority_id: string;
    continuity_epoch: string;
    continuity_verification_key: string;
    continuity_status: "active";
    continuity_receipt: DacsWalletSpendContinuityReceiptV1;
    policy_hash: string;
    revision: number;
    state_hash: string;
    state: WalletSpendStateV1;
  }, readonly continuity: DacsWalletSpendContinuityPinV1) {}

  async query<Row = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    if (text.startsWith("SELECT floor")) {
      return { rows: [{ now_ms: String(this.nowMs) } as Row], rowCount: 1 };
    }
    if (text.startsWith("SELECT request_hash")) {
      const operation = this.operations.get(`${String(values[0])}\0${String(values[1])}`);
      return {
        rows: operation === undefined ? [] : [structuredClone(operation) as Row],
        rowCount: operation === undefined ? 0 : 1,
      };
    }
    if (text.startsWith("INSERT INTO dacs_wallet_spend_operations")) {
      const key = `${String(values[0])}\0${String(values[1])}`;
      if (this.operations.has(key)) return { rows: [], rowCount: 0 };
      this.operations.set(key, {
        request_hash: String(values[2]),
        request: JSON.parse(String(values[3])) as unknown,
        response: null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("UPDATE dacs_wallet_spend_operations")) {
      const operation = this.operations.get(`${String(values[0])}\0${String(values[1])}`);
      const response = JSON.parse(String(values[3])) as unknown;
      if (operation === undefined || operation.request_hash !== String(values[2]) ||
          (operation.response !== null &&
            canonicalize(operation.response) !== canonicalize(response))) {
        return { rows: [], rowCount: 0 };
      }
      operation.response = response;
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("FROM dacs_wallet_spend_lineages") &&
        !text.includes("FOR UPDATE")) {
      return { rows: [structuredClone(this.row) as Row], rowCount: 1 };
    }
    if (text.startsWith("INSERT INTO dacs_wallet_spend_candidates")) {
      const key = `${String(values[1])}\0${String(values[4])}\0${String(values[5])}` +
        `\0${String(values[7])}`;
      if (!this.candidates.has(key)) {
        this.candidates.set(key, {
          candidate_id: String(values[0]),
          authority_id: String(values[2]),
          continuity_epoch: String(values[3]),
          role_id: String(values[4]),
          request_hash: String(values[6]),
          mutation_index: Number(values[7]),
          prior_revision: Number(values[8]),
          prior_state_hash: String(values[9]),
          next_revision: Number(values[10]),
          next_state_hash: String(values[11]),
          candidate_state: JSON.parse(String(values[12])) as WalletSpendStateV1,
          candidate_value: JSON.parse(String(values[13])) as unknown,
          continuity_receipt: null,
          status: "prepared",
        });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (text.startsWith("SELECT candidate_id") && text.includes("status = 'applied'")) {
      const prefix = `${String(values[0])}\0${String(values[1])}\0${String(values[2])}\0`;
      const candidates = [...this.candidates.entries()]
        .filter(([key, candidate]) => key.startsWith(prefix) &&
          candidate.request_hash === values[3] && candidate.status === "applied")
        .sort(([, left], [, right]) => left.next_revision - right.next_revision)
        .map(([, candidate]) => ({
          ...structuredClone(candidate),
          lineage_key: String(values[0]),
        }) as Row);
      return { rows: candidates, rowCount: candidates.length };
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
        if (text.startsWith("SELECT pg_advisory_xact_lock(")) {
          await acquire();
          return { rows: [] as Row[], rowCount: 1 };
        }
        if (text === "BEGIN ISOLATION LEVEL SERIALIZABLE" ||
            text === "BEGIN ISOLATION LEVEL READ COMMITTED" || text === "ROLLBACK" ||
            text.startsWith("SELECT set_config")) {
          if (text === "ROLLBACK") releaseLock?.();
          return { rows: [], rowCount: 0 };
        }
        if (text.startsWith("SELECT request_hash, request FROM dacs_wallet_spend_operations")) {
          const operation = this.operations.get(`${String(values[0])}\0${String(values[1])}`);
          return {
            rows: operation === undefined ? [] : [structuredClone(operation) as Row],
            rowCount: operation === undefined ? 0 : 1,
          };
        }
        if (text.startsWith("SELECT scope, retained_operations")) {
          const roleScope = String(values[0]);
          const rows = ["global", roleScope].flatMap((scope) => {
            const count = this.operationCounts.get(scope);
            return count === undefined ? [] : [{
              scope,
              retained_operations: String(count),
            } as Row];
          });
          return {
            rows,
            rowCount: rows.length,
          };
        }
        if (text.startsWith("INSERT INTO dacs_wallet_spend_operations")) {
          const key = `${String(values[0])}\0${String(values[1])}`;
          if (this.operations.has(key)) return { rows: [] as Row[], rowCount: 0 };
          this.operations.set(key, {
            request_hash: String(values[2]),
            request: JSON.parse(String(values[3])) as unknown,
            response: null,
          });
          return { rows: [] as Row[], rowCount: 1 };
        }
        if (text.startsWith("UPDATE dacs_wallet_spend_operation_counts")) {
          const count = this.operationCounts.get("global");
          if (count === undefined) return { rows: [] as Row[], rowCount: 0 };
          this.operationCounts.set("global", count + 1);
          return { rows: [] as Row[], rowCount: 1 };
        }
        if (text.startsWith("INSERT INTO dacs_wallet_spend_operation_counts")) {
          const scope = String(values[0]);
          this.operationCounts.set(scope, (this.operationCounts.get(scope) ?? 0) + 1);
          return { rows: [] as Row[], rowCount: 1 };
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
          if (this.row.revision !== Number(values[5]) ||
              this.row.state_hash !== String(values[6])) {
            return { rows: [], rowCount: 0 };
          }
          this.row.revision = Number(values[1]);
          this.row.state_hash = String(values[2]);
          this.row.state = JSON.parse(String(values[3])) as WalletSpendStateV1;
          this.row.continuity_receipt = JSON.parse(
            String(values[4]),
          ) as DacsWalletSpendContinuityReceiptV1;
          return { rows: [], rowCount: 1 };
        }
        if (text.startsWith("UPDATE dacs_wallet_spend_candidates")) {
          const candidate = [...this.candidates.values()].find(({ candidate_id }) =>
            candidate_id === String(values[0]));
          if (candidate?.status === "prepared") {
            candidate.status = text.includes("'superseded'") ? "superseded" : "applied";
            if (values[1] !== undefined) {
              candidate.continuity_receipt = JSON.parse(
                String(values[1]),
              ) as DacsWalletSpendContinuityReceiptV1;
            }
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

async function fakePool(
  selected: WalletSpendPolicyV1 = policy("policy-a"),
): Promise<FakePostgresPool> {
  const policyHash = dacsWalletSpendPolicyHashV1(selected);
  const state: WalletSpendStateV1 = {
    stateVersion: WALLET_SPEND_STATE_VERSION,
    policyHash,
    generation: 0,
    reservations: [],
    totals: [],
    rollingEvents: [],
  };
  const continuity = newContinuity();
  const lineage = dacsWalletSpendLineageKeyV1(selected.wallet, selected.chainId);
  const receipt = await continuity.witness.compareAndSet({
    authorityId: continuity.authorityId, epoch: continuity.epoch, lineageKey: lineage,
    predecessor: null, next: { revision: 0, stateHash: hashState(state) },
    candidateId: "00000000-0000-4000-8000-000000000090",
    roleId: "operator:test", operationId: "00000000-0000-4000-8000-000000000091",
    requestHash: "9".repeat(64), mutationIndex: 0, clientNonce: "8".repeat(64),
  });
  return new FakePostgresPool({
    writer_contract_version: 2,
    authority_id: continuity.authorityId,
    continuity_epoch: continuity.epoch,
    continuity_verification_key: continuity.verificationKey,
    continuity_status: "active",
    continuity_receipt: receipt,
    policy_hash: policyHash,
    revision: 0,
    state_hash: hashState(state),
    state,
  }, continuity);
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
    expect(DACS_WALLET_SPEND_POSTGRES_SCHEMA_V1).toContain(
      "wallet-spend-writer-contract-v2-required",
    );
    expect(DACS_WALLET_SPEND_POSTGRES_SCHEMA_V1).toContain(
      "wallet-spend-continuity-migration-required",
    );
    expect(DACS_WALLET_SPEND_POSTGRES_SCHEMA_V1).toContain(
      "CREATE TABLE IF NOT EXISTS dacs_wallet_spend_operation_counts",
    );
    // Fresh lineages are inserted as pending before the external witness CAS.
    // Only active lineages require a receipt, so this column must remain nullable.
    expect(DACS_WALLET_SPEND_POSTGRES_SCHEMA_V1).not.toContain(
      "ALTER COLUMN continuity_receipt SET NOT NULL",
    );
    expect(DACS_WALLET_SPEND_POSTGRES_CONTINUITY_ADOPTION_SCHEMA_V1).toContain(
      "ALTER COLUMN prior_revision DROP NOT NULL",
    );
    expect(DACS_WALLET_SPEND_POSTGRES_CONTINUITY_ADOPTION_SCHEMA_V1).toContain(
      "ADD COLUMN IF NOT EXISTS role_id text",
    );
  });

  it("adds the legacy candidate role before continuity adoption", () => {
    const schema = DACS_WALLET_SPEND_POSTGRES_CONTINUITY_ADOPTION_SCHEMA_V1;
    const lock = schema.indexOf(
      "LOCK TABLE dacs_wallet_spend_candidates IN ACCESS EXCLUSIVE MODE",
    );
    const addRole = schema.indexOf("ADD COLUMN IF NOT EXISTS role_id text", lock);
    const commit = schema.indexOf("COMMIT;", addRole);

    expect(lock).toBeGreaterThanOrEqual(0);
    expect(addRole).toBeGreaterThan(lock);
    expect(commit).toBeGreaterThan(addRole);
  });

  it("atomically bounds retained operations per role and globally", async () => {
    const pool = await fakePool();
    const operations = createDacsPostgresWalletSpendRemoteOperationStoreV1(pool, {
      maximumOperationsPerRole: 2,
      maximumOperations: 3,
    });
    const claim = (roleId: string, suffix: string) => {
      const operationId = `00000000-0000-4000-8000-0000000000${suffix.padStart(2, "0")}`;
      const requestHash = suffix.repeat(64);
      return operations.claim({
        roleId,
        operationId,
        requestHash,
        request: {
          protocolVersion: "1",
          operationId,
          policyHash: "a".repeat(64),
          wallet: "wallet-a",
          chainId: "chain-a",
          operation: "reserve",
          payload: { reservation: {}, options: {} },
        },
      });
    };

    const roleResults = await Promise.all([
      claim("role-a", "1"),
      claim("role-a", "2"),
      claim("role-a", "3"),
      claim("role-a", "4"),
    ]);
    const retainedSuffix = String(roleResults.findIndex((result) => result === "new") + 1);
    expect([...roleResults].sort()).toEqual(["full", "full", "new", "new"]);
    await expect(claim("role-b", "5")).resolves.toBe("new");
    await expect(claim("role-b", "6")).resolves.toBe("full");
    await expect(claim("role-a", retainedSuffix)).resolves.toBe("existing");
    expect(pool.operations.size).toBe(3);
    expect([...pool.operations.keys()].filter((key) => key.startsWith("role-a\0")))
      .toHaveLength(2);
    expect([...pool.operations.keys()].filter((key) => key.startsWith("role-b\0")))
      .toHaveLength(1);
    expect(pool.operationCounts).toEqual(new Map([
      ["global", 3],
      ["role:role-a", 2],
      ["role:role-b", 1],
    ]));
  });

  it("quiesces role migration, rejects ambiguous rows and fences legacy writers", () => {
    const schema = DACS_WALLET_SPEND_POSTGRES_SCHEMA_V1;
    const operationLock = schema.indexOf(
      "LOCK TABLE dacs_wallet_spend_operations IN ACCESS EXCLUSIVE MODE",
    );
    const operationCountLock = schema.indexOf(
      "LOCK TABLE dacs_wallet_spend_operation_counts IN ACCESS EXCLUSIVE MODE",
      operationLock,
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
    expect(operationCountLock).toBeGreaterThan(operationLock);
    expect(lock).toBeGreaterThan(operationCountLock);
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
    expect(schema.slice(lock, migrationEnd)).toContain(
      "DELETE FROM dacs_wallet_spend_operation_counts",
    );
    expect(schema.slice(lock, migrationEnd)).toContain(
      "SELECT 'global', count(*) FROM dacs_wallet_spend_operations",
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
      pool, wallet: "wallet-a", chainId: "chain-a", continuity: newContinuity(),
    });
    await expect(store.read!(dacsWalletSpendLineageKeyV1("wallet-a", "chain-a")))
      .rejects.toThrow(/lineage-missing/);
    expect(statements.some((statement) => /INSERT|UPDATE|DELETE/.test(statement))).toBe(false);
  });

  it("imports only authenticated complete legacy state and refuses overwrite", async () => {
    const selected = policy("policy-a");
    const state = legacyState(selected);
    const statements: { text: string; values: readonly unknown[] }[] = [];
    let lineageRow: Record<string, unknown> | undefined;
    const client: DacsPostgresClientV1 = {
      async query<Row = Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = [],
      ) {
        statements.push({ text, values });
        if (text.startsWith("INSERT INTO dacs_wallet_spend_lineages")) {
          lineageRow = {
            writer_contract_version: 2, authority_id: values[1], continuity_epoch: values[2],
            continuity_verification_key: values[3], continuity_status: "pending",
            continuity_receipt: null, policy_hash: values[6], revision: values[7],
            state_hash: values[8], state: JSON.parse(String(values[9])),
          };
        } else if (text.includes("FROM dacs_wallet_spend_lineages") &&
            text.includes("FOR UPDATE")) {
          return {
            rows: lineageRow === undefined ? [] : [structuredClone(lineageRow) as Row],
            rowCount: 1,
          };
        } else if (text.startsWith("UPDATE dacs_wallet_spend_lineages")) {
          lineageRow = { ...lineageRow, continuity_status: "active",
            continuity_receipt: JSON.parse(String(values[1])) };
        }
        return { rows: [] as Row[], rowCount: 1 };
      },
      release() {},
    };
    const pool: DacsPostgresPoolV1 = {
      async query(text, values = []) {
        statements.push({ text, values });
        if (text.includes("FROM dacs_wallet_spend_lineages")) {
          return { rows: lineageRow === undefined ? [] : [structuredClone(lineageRow)],
            rowCount: lineageRow === undefined ? 0 : 1 } as never;
        }
        return { rows: [], rowCount: 1 } as never;
      },
      async connect() { return client; },
    };
    const evidence = {
      sourceIdentity: "authenticated-fs-journal:buyer-production-v1",
      evidenceHash: "d".repeat(64),
    };

    await importDacsWalletSpendPostgresLegacyStateV1(pool, {
      policy: selected,
      state,
      operationId: "00000000-0000-4000-8000-000000000041",
      continuity: newContinuity(8),
      sourceEvidence: evidence,
      authenticateEvidence: async (observed, imported) =>
        observed.evidenceHash === evidence.evidenceHash && imported.generation === 5,
    });
    const lineageInsert = statements.find(({ text }) =>
      text.startsWith("INSERT INTO dacs_wallet_spend_lineages"));
    expect(lineageInsert?.values[7]).toBe(5);
    expect(lineageInsert?.values[10]).toBe("legacy-import");
    expect(JSON.parse(String(lineageInsert?.values[9]))).toMatchObject({
      generation: 5,
      reservations: [{ stage: "effect-pending", owner: "legacy-worker" }],
    });
    await expect(importDacsWalletSpendPostgresLegacyStateV1(pool, {
      policy: selected,
      state,
      operationId: "00000000-0000-4000-8000-000000000041",
      continuity: newContinuity(8),
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
      operationId: "00000000-0000-4000-8000-000000000042",
      continuity: newContinuity(9),
      sourceEvidence: {
        sourceIdentity: "authenticated-fs-journal:buyer-production-v1",
        evidenceHash: "d".repeat(64),
      },
      authenticateEvidence: () => false,
    })).rejects.toThrow(/evidence-rejected/);
    await expect(provisionDacsWalletSpendPostgresLineageV1(pool, {
      policy: selected,
      operationId: "00000000-0000-4000-8000-000000000043",
      continuity: newContinuity(10),
      newLineageEvidence: {
        sourceIdentity: "operator-wallet-inventory:new-wallet-chain",
        evidenceHash: "e".repeat(64),
      },
      authenticateEvidence: () => false,
    })).rejects.toThrow(/evidence-rejected/);
    await expect(importDacsWalletSpendPostgresLegacyStateV1(pool, {
      policy: selected,
      state,
      operationId: "00000000-0000-4000-8000-000000000044",
      continuity: newContinuity(11),
      sourceEvidence: { sourceIdentity: "", evidenceHash: "d".repeat(64) },
      authenticateEvidence: () => true,
    })).rejects.toThrow(/evidence-invalid/);
    expect(writes).toBe(0);
  });

  it("rejects fresh-database reprovision when the witness already owns the lineage", async () => {
    const established = await fakePool();
    const client: DacsPostgresClientV1 = {
      async query<Row>() { return { rows: [] as Row[], rowCount: 1 }; },
      release() {},
    };
    const restoredEmptyDatabase: DacsPostgresPoolV1 = {
      async query<Row>() { return { rows: [] as Row[], rowCount: 0 }; },
      async connect() { return client; },
    };
    await expect(provisionDacsWalletSpendPostgresLineageV1(restoredEmptyDatabase, {
      policy: policy("policy-a"),
      operationId: "00000000-0000-4000-8000-000000000049",
      continuity: established.continuity,
      newLineageEvidence: {
        sourceIdentity: "operator-wallet-inventory:new-wallet-chain",
        evidenceHash: "e".repeat(64),
      },
      authenticateEvidence: () => true,
    })).rejects.toThrow(/continuity-conflict/);
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

    const authorityStore = createInMemoryWalletSpendStateStore();
    const authorityScope = sha256Hex(`dacs-wallet-spend-scope:v1:${canonicalize({
      wallet: selected.wallet,
      chainId: selected.chainId,
      policyId: selected.policyId,
    })}`);
    await authorityStore.transact(authorityScope, () => ({
      state: candidateState,
      value: undefined,
    }));
    const authority = createWalletSpendAuthorityV1(selected, {
      store: authorityStore,
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
      writer_contract_version: number;
      authority_id: string;
      continuity_epoch: string;
      continuity_verification_key: string;
      continuity_status: "active";
      continuity_receipt: DacsWalletSpendContinuityReceiptV1;
      policy_hash: string;
      revision: number;
      state_hash: string;
      state: WalletSpendStateV1;
    };
    const continuity = newContinuity(12);
    const initialState = {
        stateVersion: WALLET_SPEND_STATE_VERSION,
        policyHash: previousHash,
        generation: 3,
        reservations: [{
          reservationId: settledReservation.reservationId,
          bindingHash: sha256Hex(
            `dacs-wallet-spend-reservation:v1:${canonicalize(settledReservation)}`,
          ),
          reservation: settledReservation,
          stage: "settled" as const,
          generation: 1,
          evidenceHash: "d".repeat(64),
          actualDebits: [{ asset: "ASSET", purpose: "service" as const, amount: "25" }],
          createdAt: 1_000,
          updatedAt: 1_100,
        }],
        totals: [{
          asset: "ASSET",
          cumulativeDebit: "25",
          counterpartyDebits: { "payee-a": "25" },
        }],
        rollingEvents: [],
      } satisfies WalletSpendStateV1;
    const initialHash = hashState(initialState);
    const initialReceipt = await continuity.witness.compareAndSet({
      authorityId: continuity.authorityId, epoch: continuity.epoch,
      lineageKey: dacsWalletSpendLineageKeyV1(previous.wallet, previous.chainId),
      predecessor: null, next: { revision: 3, stateHash: initialHash },
      candidateId: "00000000-0000-4000-8000-000000000046",
      roleId: "operator:initial", operationId: "00000000-0000-4000-8000-000000000047",
      requestHash: "4".repeat(64), mutationIndex: 0, clientNonce: "5".repeat(64),
    });
    row = {
      writer_contract_version: 2,
      authority_id: continuity.authorityId,
      continuity_epoch: continuity.epoch,
      continuity_verification_key: continuity.verificationKey,
      continuity_status: "active",
      continuity_receipt: initialReceipt,
      policy_hash: previousHash,
      revision: 3,
      state_hash: initialHash,
      state: initialState,
    };
    const statements: string[] = [];
    let preparedCandidate: FakeCandidate | undefined;
    const client: DacsPostgresClientV1 = {
      async query(text, values = []) {
        statements.push(text.trim());
        if (text.includes("FROM dacs_wallet_spend_lineages")) {
          return { rows: [structuredClone(row)], rowCount: 1 } as never;
        }
        if (text.startsWith("UPDATE dacs_wallet_spend_lineages")) {
          row = { ...row,
            policy_hash: String(values[1]),
            revision: Number(values[2]),
            state_hash: String(values[3]),
            state: JSON.parse(String(values[4])) as WalletSpendStateV1,
            continuity_receipt: JSON.parse(
              String(values[5]),
            ) as DacsWalletSpendContinuityReceiptV1,
          };
          return { rows: [], rowCount: 1 } as never;
        }
        return { rows: [], rowCount: 1 } as never;
      },
      release() {},
    };
    const pool: DacsPostgresPoolV1 = {
      async query(text, values = []) {
        statements.push(text.trim());
        if (text.includes("FROM dacs_wallet_spend_lineages")) {
          return { rows: [structuredClone(row)], rowCount: 1 } as never;
        }
        if (text.startsWith("INSERT INTO dacs_wallet_spend_candidates")) {
          if (preparedCandidate === undefined) {
            preparedCandidate = {
              candidate_id: String(values[0]),
              authority_id: String(values[2]),
              continuity_epoch: String(values[3]),
              role_id: String(values[4]),
              request_hash: String(values[6]),
              mutation_index: 0,
              prior_revision: Number(values[7]),
              prior_state_hash: String(values[8]),
              next_revision: Number(values[9]),
              next_state_hash: String(values[10]),
              candidate_state: JSON.parse(String(values[11])) as WalletSpendStateV1,
              candidate_value: JSON.parse(String(values[12])) as unknown,
              continuity_receipt: null,
              status: "prepared",
            };
          }
          return { rows: [], rowCount: 1 } as never;
        }
        if (text.startsWith("SELECT candidate_id")) {
          return { rows: preparedCandidate === undefined
            ? [] : [structuredClone(preparedCandidate)],
          rowCount: preparedCandidate === undefined ? 0 : 1 } as never;
        }
        return { rows: [], rowCount: 1 } as never;
      },
      async connect() { return client; },
    };

    await migrateDacsWalletSpendPostgresPolicyV1(pool, {
      previousPolicyHash: previousHash,
      policy: next,
      operationId: "00000000-0000-4000-8000-000000000045",
      continuity,
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

  it.each(["before-continuity", "after-continuity", "after-database"] as const)(
    "retries continuity adoption with the exact retained candidate %s uncertainty",
    async (failurePoint) => {
      const selected = policy("policy-adoption");
      const state = legacyState(selected);
      const baseContinuity = newContinuity(31);
      const continuity = failurePoint === "before-continuity"
        ? failOneContinuityAdvance(baseContinuity)
        : baseContinuity;
      const pool = new RecoveryPostgresPool({
        writer_contract_version: 1,
        authority_id: null,
        continuity_epoch: null,
        continuity_verification_key: null,
        continuity_status: null,
        continuity_receipt: null,
        policy_hash: dacsWalletSpendPolicyHashV1(selected),
        revision: state.generation,
        state_hash: hashState(state),
        state,
      });
      pool.failNextConnect = failurePoint === "after-continuity";
      pool.failNextCommitAfterApply = failurePoint === "after-database";
      const input = {
        policy: selected,
        operationId: "00000000-0000-4000-8000-000000000051",
        continuity,
        sourceEvidence: {
          sourceIdentity: "authenticated-postgres-adoption:test",
          evidenceHash: "a".repeat(64),
        },
        authenticateEvidence: () => true,
      };

      await expect(adoptDacsWalletSpendPostgresContinuityV1(pool, input)).rejects.toThrow();
      expect(pool.candidates.size).toBe(1);
      const candidateId = [...pool.candidates.values()][0]!.candidate_id;

      await expect(adoptDacsWalletSpendPostgresContinuityV1(pool, input)).resolves.toBeUndefined();
      expect([...pool.candidates.values()]).toHaveLength(1);
      expect([...pool.candidates.values()][0]).toMatchObject({
        candidate_id: candidateId,
        status: "applied",
      });
      expect(pool.row).toMatchObject({
        writer_contract_version: 2,
        authority_id: continuity.authorityId,
        continuity_epoch: continuity.epoch,
        continuity_status: "active",
      });
      // A lost success response is also exactly idempotent.
      await expect(adoptDacsWalletSpendPostgresContinuityV1(pool, input)).resolves.toBeUndefined();
    },
  );

  it("fails continuity adoption closed when an advanced witness loses its candidate", async () => {
    const selected = policy("policy-adoption-missing-candidate");
    const state = legacyState(selected);
    const continuity = newContinuity(32);
    const pool = new RecoveryPostgresPool({
      writer_contract_version: 1,
      authority_id: null,
      continuity_epoch: null,
      continuity_verification_key: null,
      continuity_status: null,
      continuity_receipt: null,
      policy_hash: dacsWalletSpendPolicyHashV1(selected),
      revision: state.generation,
      state_hash: hashState(state),
      state,
    });
    pool.failNextConnect = true;
    const input = {
      policy: selected,
      operationId: "00000000-0000-4000-8000-000000000052",
      continuity,
      sourceEvidence: {
        sourceIdentity: "authenticated-postgres-adoption:test",
        evidenceHash: "b".repeat(64),
      },
      authenticateEvidence: () => true,
    };

    await expect(adoptDacsWalletSpendPostgresContinuityV1(pool, input)).rejects.toThrow(
      /outcome unknown/,
    );
    pool.candidates.clear();
    await expect(adoptDacsWalletSpendPostgresContinuityV1(pool, input)).rejects.toThrow(
      /continuity-conflict/,
    );
    expect(pool.row.authority_id).toBeNull();
  });

  it.each(["before-continuity", "after-continuity", "after-database"] as const)(
    "retries policy migration with the exact retained candidate %s uncertainty",
    async (failurePoint) => {
      const previous = policy("policy-migration-before");
      const next = { ...policy("policy-migration-after"), maximumRetainedReservations: 20 };
      const previousHash = dacsWalletSpendPolicyHashV1(previous);
      const initialState: WalletSpendStateV1 = {
        stateVersion: WALLET_SPEND_STATE_VERSION,
        policyHash: previousHash,
        generation: 0,
        reservations: [],
        totals: [],
        rollingEvents: [],
      };
      const baseContinuity = newContinuity(33);
      const lineage = dacsWalletSpendLineageKeyV1(previous.wallet, previous.chainId);
      const initialReceipt = await baseContinuity.witness.compareAndSet({
        authorityId: baseContinuity.authorityId,
        epoch: baseContinuity.epoch,
        lineageKey: lineage,
        predecessor: null,
        next: { revision: 0, stateHash: hashState(initialState) },
        candidateId: "00000000-0000-4000-8000-000000000053",
        roleId: "operator:initial",
        operationId: "00000000-0000-4000-8000-000000000054",
        requestHash: "c".repeat(64),
        mutationIndex: 0,
        clientNonce: "d".repeat(64),
      });
      const continuity = failurePoint === "before-continuity"
        ? failOneContinuityAdvance(baseContinuity)
        : baseContinuity;
      const pool = new RecoveryPostgresPool({
        writer_contract_version: 2,
        authority_id: continuity.authorityId,
        continuity_epoch: continuity.epoch,
        continuity_verification_key: continuity.verificationKey,
        continuity_status: "active",
        continuity_receipt: initialReceipt,
        policy_hash: previousHash,
        revision: 0,
        state_hash: hashState(initialState),
        state: initialState,
      });
      pool.failNextConnect = failurePoint === "after-continuity";
      pool.failNextCommitAfterApply = failurePoint === "after-database";
      const input = {
        previousPolicyHash: previousHash,
        policy: next,
        operationId: "00000000-0000-4000-8000-000000000055",
        continuity,
      };

      await expect(migrateDacsWalletSpendPostgresPolicyV1(pool, input)).rejects.toThrow();
      expect(pool.candidates.size).toBe(1);
      const candidateId = [...pool.candidates.values()][0]!.candidate_id;

      await expect(migrateDacsWalletSpendPostgresPolicyV1(pool, input)).resolves.toBeUndefined();
      expect([...pool.candidates.values()]).toHaveLength(1);
      expect([...pool.candidates.values()][0]).toMatchObject({
        candidate_id: candidateId,
        status: "applied",
      });
      expect(pool.row).toMatchObject({
        policy_hash: dacsWalletSpendPolicyHashV1(next),
        revision: 1,
        state: { policyHash: dacsWalletSpendPolicyHashV1(next), generation: 1 },
      });
      // A lost commit acknowledgement is distinguishable from another migration.
      await expect(migrateDacsWalletSpendPostgresPolicyV1(pool, input)).resolves.toBeUndefined();
    },
  );

  it("fails policy migration closed when an advanced witness loses its candidate", async () => {
    const previous = policy("policy-migration-missing-before");
    const next = policy("policy-migration-missing-after");
    const previousHash = dacsWalletSpendPolicyHashV1(previous);
    const initialState: WalletSpendStateV1 = {
      stateVersion: WALLET_SPEND_STATE_VERSION,
      policyHash: previousHash,
      generation: 0,
      reservations: [],
      totals: [],
      rollingEvents: [],
    };
    const continuity = newContinuity(34);
    const lineage = dacsWalletSpendLineageKeyV1(previous.wallet, previous.chainId);
    const initialReceipt = await continuity.witness.compareAndSet({
      authorityId: continuity.authorityId,
      epoch: continuity.epoch,
      lineageKey: lineage,
      predecessor: null,
      next: { revision: 0, stateHash: hashState(initialState) },
      candidateId: "00000000-0000-4000-8000-000000000056",
      roleId: "operator:initial",
      operationId: "00000000-0000-4000-8000-000000000057",
      requestHash: "e".repeat(64),
      mutationIndex: 0,
      clientNonce: "f".repeat(64),
    });
    const pool = new RecoveryPostgresPool({
      writer_contract_version: 2,
      authority_id: continuity.authorityId,
      continuity_epoch: continuity.epoch,
      continuity_verification_key: continuity.verificationKey,
      continuity_status: "active",
      continuity_receipt: initialReceipt,
      policy_hash: previousHash,
      revision: 0,
      state_hash: hashState(initialState),
      state: initialState,
    });
    pool.failNextConnect = true;
    const input = {
      previousPolicyHash: previousHash,
      policy: next,
      operationId: "00000000-0000-4000-8000-000000000058",
      continuity,
    };

    await expect(migrateDacsWalletSpendPostgresPolicyV1(pool, input)).rejects.toThrow(
      /outcome unknown/,
    );
    pool.candidates.clear();
    await expect(migrateDacsWalletSpendPostgresPolicyV1(pool, input)).rejects.toThrow(
      /recovery-unavailable/,
    );
    expect(pool.row.policy_hash).toBe(previousHash);
  });

  it("reuses an immutable prepared candidate after an uncertain connection outcome", async () => {
    const pool = await fakePool();
    pool.failNextConnect = true;
    const store = () => createDacsPostgresWalletSpendStateStoreV1({
      pool,
      wallet: "wallet-a",
      chainId: "chain-a",
      continuity: pool.continuity,
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

  it("uses the next ordinal when a timestamped reserve no longer matches", async () => {
    const pool = await fakePool();
    const selected = policy("policy-a");
    const operation = () => ({
      roleId: "buyer",
      operationId: "00000000-0000-4000-8000-000000000021",
      requestHash: "2".repeat(64),
    });
    const reservation: WalletSpendReservationV1 = {
      reservationVersion: "1",
      reservationId: "timestamped-reserve",
      jobId: "job-timestamped",
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
    const authority = (continuity: DacsWalletSpendContinuityPinV1) =>
      createWalletSpendAuthorityV1(selected, {
        store: createDacsPostgresWalletSpendStateStoreV1({
          pool, wallet: selected.wallet, chainId: selected.chainId, continuity, operation,
        }),
        readBalance: async () => "1000",
        authenticateRecovery: async () => true,
        owner: "wallet-service",
        leaseDurationMs: 30_000,
      });

    await expect(authority(failOneContinuityAdvance(pool.continuity)).reserve(reservation))
      .rejects.toThrow(/outcome-unresolved/);
    const retained = [...pool.candidates.values()][0]!;
    expect(retained).toMatchObject({ mutation_index: 8, status: "prepared" });
    expect(retained.candidate_state.reservations[0]).toMatchObject({
      createdAt: 1_000,
      updatedAt: 1_000,
      leaseExpiresAt: 31_000,
    });

    pool.nowMs = 2_000;
    await expect(authority(pool.continuity).reserve(reservation)).resolves.toMatchObject({
      status: "reserved",
      permit: { reservationId: reservation.reservationId, generation: 1 },
    });
    expect([...pool.candidates.values()]).toMatchObject([
      { candidate_id: retained.candidate_id, mutation_index: 8, status: "prepared" },
      {
        mutation_index: 9,
        status: "applied",
        candidate_state: {
          reservations: [{ createdAt: 2_000, updatedAt: 2_000, leaseExpiresAt: 32_000 }],
        },
      },
    ]);
    expect(pool.row.state.reservations[0]).toMatchObject({
      createdAt: 2_000,
      updatedAt: 2_000,
      leaseExpiresAt: 32_000,
    });
  });

  it("does not adopt a forged prepared candidate", async () => {
    const pool = await fakePool();
    const lineage = dacsWalletSpendLineageKeyV1("wallet-a", "chain-a");
    const roleId = "buyer";
    const operationId = "00000000-0000-4000-8000-000000000022";
    const requestHash = "3".repeat(64);
    const forgedState: WalletSpendStateV1 = {
      ...pool.row.state,
      policyHash: "f".repeat(64),
      generation: 1,
    };
    pool.candidates.set(`${lineage}\0${roleId}\0${operationId}\0${0}`, {
      candidate_id: "00000000-0000-4000-8000-000000000122",
      authority_id: pool.continuity.authorityId,
      continuity_epoch: pool.continuity.epoch,
      role_id: roleId,
      request_hash: requestHash,
      mutation_index: 0,
      prior_revision: 0,
      prior_state_hash: pool.row.state_hash,
      next_revision: 1,
      next_state_hash: hashState(forgedState),
      candidate_state: forgedState,
      candidate_value: "forged",
      continuity_receipt: null,
      status: "prepared",
    });
    const store = createDacsPostgresWalletSpendStateStoreV1({
      pool, wallet: "wallet-a", chainId: "chain-a", continuity: pool.continuity,
      operation: () => ({ roleId, operationId, requestHash }),
    });

    await expect(store.transact(lineage, (current) => ({
      state: { ...current!, generation: current!.generation + 1 },
      value: "authorized",
    }))).resolves.toBe("authorized");
    expect(pool.row.state.policyHash).toBe(dacsWalletSpendPolicyHashV1(policy("policy-a")));
    expect([...pool.candidates.values()]).toMatchObject([
      {
        candidate_id: "00000000-0000-4000-8000-000000000122",
        mutation_index: 0,
        status: "prepared",
        candidate_state: { policyHash: "f".repeat(64) },
      },
      {
        mutation_index: 1,
        status: "applied",
        candidate_state: { policyHash: dacsWalletSpendPolicyHashV1(policy("policy-a")) },
        candidate_value: { valueVersion: "1", defined: true, value: "authorized" },
      },
    ]);
  });

  it("applies d0e26c prepared candidates with raw values and raw null as undefined", async () => {
    const cases: readonly Readonly<{ raw: unknown; expected: unknown; suffix: string }>[] = [
      { raw: "authorized", expected: "authorized", suffix: "31" },
      { raw: null, expected: undefined, suffix: "32" },
    ];
    for (const selectedCase of cases) {
      const pool = await fakePool();
      const lineage = dacsWalletSpendLineageKeyV1("wallet-a", "chain-a");
      const roleId = "buyer";
      const operationId = `00000000-0000-4000-8000-0000000000${selectedCase.suffix}`;
      const requestHash = selectedCase.suffix[0]!.repeat(64);
      const nextState = { ...pool.row.state, generation: 1 };
      const key = `${lineage}\0${roleId}\0${operationId}\0${0}`;
      pool.candidates.set(key, {
        candidate_id: `00000000-0000-4000-8000-0000000001${selectedCase.suffix}`,
        authority_id: pool.continuity.authorityId,
        continuity_epoch: pool.continuity.epoch,
        role_id: roleId,
        request_hash: requestHash,
        mutation_index: 0,
        prior_revision: 0,
        prior_state_hash: pool.row.state_hash,
        next_revision: 1,
        next_state_hash: hashState(nextState),
        candidate_state: nextState,
        candidate_value: selectedCase.raw,
        continuity_receipt: null,
        status: "prepared",
      });
      const store = createDacsPostgresWalletSpendStateStoreV1({
        pool,
        wallet: "wallet-a",
        chainId: "chain-a",
        continuity: pool.continuity,
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
    const pool = await fakePool();
    const lineage = dacsWalletSpendLineageKeyV1("wallet-a", "chain-a");
    const roleId = "buyer";
    const operationId = "00000000-0000-4000-8000-000000000033";
    const requestHash = "3".repeat(64);
    const nextState = { ...pool.row.state, generation: 1 };
    pool.candidates.set(`${lineage}\0${roleId}\0${operationId}\0${0}`, {
      candidate_id: "00000000-0000-4000-8000-000000000133",
      authority_id: pool.continuity.authorityId,
      continuity_epoch: pool.continuity.epoch,
      role_id: roleId,
      request_hash: requestHash,
      mutation_index: 0,
      prior_revision: 0,
      prior_state_hash: pool.row.state_hash,
      next_revision: 1,
      next_state_hash: hashState(nextState),
      candidate_state: nextState,
      candidate_value: { valueVersion: "1", defined: true },
      continuity_receipt: null,
      status: "prepared",
    });
    const store = createDacsPostgresWalletSpendStateStoreV1({
      pool,
      wallet: "wallet-a",
      chainId: "chain-a",
      continuity: pool.continuity,
      operation: () => ({ roleId, operationId, requestHash }),
    });

    await expect(store.transact(lineage, (current) => ({
      state: { ...current!, generation: current!.generation + 1 },
      value: "authorized",
    }))).rejects.toThrow(/candidate-value-invalid/);
    expect(pool.row.revision).toBe(0);
  });

  it("retains the exact applied candidate after a lost commit acknowledgement", async () => {
    const pool = await fakePool();
    pool.failNextCommitAfterApply = true;
    const store = createDacsPostgresWalletSpendStateStoreV1({
      pool,
      wallet: "wallet-a",
      chainId: "chain-a",
      continuity: pool.continuity,
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
    const pool = await fakePool();
    pool.failNextSerializableAdvance = true;
    const store = createDacsPostgresWalletSpendStateStoreV1({
      pool,
      wallet: "wallet-a",
      chainId: "chain-a",
      continuity: pool.continuity,
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
    const pool = await fakePool();
    const store = createDacsPostgresWalletSpendStateStoreV1({
      pool,
      wallet: "wallet-a",
      chainId: "chain-a",
      continuity: pool.continuity,
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

  it("aborts an earlier callback after recovering a later mutation", async () => {
    const pool = await fakePool();
    const scope = dacsWalletSpendLineageKeyV1("wallet-a", "chain-a");
    const createStore = () => createDacsPostgresWalletSpendStateStoreV1({
      pool,
      wallet: "wallet-a",
      chainId: "chain-a",
      continuity: pool.continuity,
      operation: () => ({
        roleId: "buyer",
        operationId: "00000000-0000-4000-8000-000000000014",
        requestHash: "d".repeat(64),
      }),
    });
    const mutateOnce = (label: string) => (
      current: Readonly<WalletSpendStateV1> | null,
    ) => {
      if (current!.rollingEvents.some(({ reservationId }) => reservationId === label)) {
        return { state: current!, value: label };
      }
      return {
        state: {
          ...current!,
          generation: current!.generation + 1,
          rollingEvents: [...current!.rollingEvents, {
            reservationId: label,
            asset: "ASSET",
            payee: "payee-a",
            amount: "1",
            settledAt: 1_000,
          }],
        },
        value: label,
      };
    };

    const interrupted = createStore();
    await expect(interrupted.transact(scope, mutateOnce("first"))).resolves.toBe("first");
    pool.failNextConnect = true;
    await expect(interrupted.transact(scope, mutateOnce("second")))
      .rejects.toThrow(/outcome unknown/);
    expect(pool.row.revision).toBe(1);
    expect([...pool.candidates.values()]).toMatchObject([
      { mutation_index: 0, status: "applied" },
      { mutation_index: 8, status: "prepared" },
    ]);

    const restarted = createStore();
    await expect(restarted.transact(scope, mutateOnce("first")))
      .rejects.toThrow(/operation-recovery-required/);
    await expect(restarted.transact(scope, mutateOnce("second"))).resolves.toBe("second");
    expect(pool.row.revision).toBe(2);
    expect(pool.row.state.rollingEvents.map(({ reservationId }) => reservationId))
      .toEqual(["first", "second"]);
    expect([...pool.candidates.values()]).toMatchObject([
      { mutation_index: 0, status: "applied" },
      { mutation_index: 8, status: "applied" },
    ]);
  });

  it("recovers the exact remote reserve after a witnessed later mutation", async () => {
    const pool = await fakePool();
    const selected = policy("policy-a");
    const roleId = "buyer";
    const token = "buyer-role-token-which-is-long-enough";
    const durableOperations = createDacsPostgresWalletSpendRemoteOperationStoreV1(pool);
    const operations = {
      load: (input: Parameters<typeof durableOperations.load>[0]) =>
        durableOperations.load(input),
      async claim(input: Parameters<typeof durableOperations.claim>[0]) {
        const result = await durableOperations.claim(input);
        pool.failNextConnect = true;
        return result;
      },
      complete: (input: Parameters<typeof durableOperations.complete>[0]) =>
        durableOperations.complete(input),
    };
    const handler = createDacsWalletSpendAuthorityServiceV1({
      authenticate: (presented) => presented === token ? roleId : null,
      resolveAuthority: ({ roleId: requestedRole, operationId, requestHash,
        wallet, chainId, policyHash }) => {
        if (requestedRole !== roleId || wallet !== selected.wallet ||
            chainId !== selected.chainId ||
            policyHash !== dacsWalletSpendPolicyHashV1(selected)) {
          return null;
        }
        return createWalletSpendAuthorityV1(selected, {
          store: createDacsPostgresWalletSpendStateStoreV1({
            pool,
            wallet: selected.wallet,
            chainId: selected.chainId,
            continuity: pool.continuity,
            operation: () => ({ roleId, operationId, requestHash }),
          }),
          readBalance: async () => "1000",
          authenticateRecovery: async () => true,
          owner: "wallet-service",
          leaseDurationMs: 60_000,
        });
      },
      operations,
    });
    const retainedReservation: WalletSpendReservationV1 = {
      reservationVersion: "1",
      reservationId: "recovered-remote-reserve",
      jobId: "job-recovered-remote",
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
    const tokenRoot = await mkdtemp(join(tmpdir(), "dacs-postgres-remote-"));
    const tokenPath = join(tokenRoot, "token");
    await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(tokenPath, 0o600);
    let handledPosts = 0;
    let handledGets = 0;
    const fetchWithExactRetry = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === "POST") {
        handledPosts += 1;
        return handler(request);
      }
      handledGets += 1;
      return handler(request);
    }) as typeof fetch;

    try {
      const remote = await createDacsRemoteWalletSpendAuthorityV1({
        policy: selected,
        endpoint: "http://127.0.0.1:8080/",
        tokenFilePath: tokenPath,
        allowInsecureLoopback: true,
        fetch: fetchWithExactRetry,
      });
      const claim = await remote.reserve(retainedReservation);

      expect(claim).toMatchObject({
        status: "reserved",
        permit: {
          reservationId: retainedReservation.reservationId,
          owner: "wallet-service",
          generation: 1,
        },
      });
      expect(handledPosts).toBe(1);
      expect(handledGets).toBe(1);
      expect([...pool.operations.values()]).toMatchObject([{ response: null }]);
      expect(pool.row).toMatchObject({
        revision: 1,
        state: {
          generation: 1,
          reservations: [{
            reservationId: retainedReservation.reservationId,
            stage: "reserved",
            generation: 1,
          }],
        },
      });
      expect([...pool.candidates.values()]).toMatchObject([
        { mutation_index: 8, status: "applied" },
      ]);

      const operation = [...pool.operations.values()][0]!;
      const storedRequest = operation.request as { operationId: string };
      const bindingHash = pool.row.state.reservations[0]!.bindingHash;
      const heldResponse = {
        protocolVersion: "1" as const,
        operationId: storedRequest.operationId,
        requestHash: operation.request_hash,
        revision: 1,
        status: "ok" as const,
        result: { status: "held", bindingHash, stage: "reserved" },
      };
      await operations.complete({
        roleId,
        operationId: storedRequest.operationId,
        requestHash: operation.request_hash,
        response: heldResponse as never,
      });
      expect(operation.response).toMatchObject({
        result: {
          status: "reserved",
          permit: { reservationId: retainedReservation.reservationId },
        },
      });

      operation.response = structuredClone(heldResponse);
      await expect(operations.load({
        roleId,
        operationId: storedRequest.operationId,
      })).resolves.toMatchObject({
        response: {
          result: {
            status: "reserved",
            permit: { reservationId: retainedReservation.reservationId },
          },
        },
      });
    } finally {
      await rm(tokenRoot, { recursive: true, force: true });
    }
  });

  it("revalidates an exact reserve without reusing its pruning ordinal", async () => {
    const selected = { ...policy("policy-a"), maximumConcurrentEffects: 2 };
    const pool = await fakePool(selected);
    const roleId = "buyer";
    const token = "buyer-role-token-which-is-long-enough";
    const item = (id: string): WalletSpendReservationV1 => ({
      reservationVersion: "1",
      reservationId: id,
      jobId: `job-${id}`,
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
    });
    const observation = (suffix: string) => ({
      disposition: "settled" as const,
      evidenceHash: suffix.repeat(64),
      debits: [{ asset: "ASSET", purpose: "service" as const, amount: "25" }],
    });
    const localAuthority = (identity: string, owner: string) =>
      createWalletSpendAuthorityV1(selected, {
        store: createDacsPostgresWalletSpendStateStoreV1({
          pool,
          wallet: selected.wallet,
          chainId: selected.chainId,
          continuity: pool.continuity,
          operation: () => ({
            roleId: `seed-${identity}`,
            operationId: `00000000-0000-4000-8000-0000000000${identity}`,
            requestHash: identity.at(-1)!.repeat(64),
          }),
        }),
        readBalance: async () => "1000",
        authenticateRecovery: async () => true,
        owner,
        leaseDurationMs: 1_000_000,
      });
    const settle = async (
      authority: ReturnType<typeof localAuthority>,
      reservation: WalletSpendReservationV1,
      evidence: string,
    ) => {
      const claim = await authority.reserve(reservation);
      if (claim.status !== "reserved") throw new Error("expected seed reservation");
      await claim.permit.beginEffect();
      await claim.permit.settle(observation(evidence));
    };

    await settle(localAuthority("91", "seed-one"), item("expired-one"), "d");
    pool.nowMs = 70_001;

    const operations = createDacsPostgresWalletSpendRemoteOperationStoreV1(pool);
    const handler = createDacsWalletSpendAuthorityServiceV1({
      authenticate: (presented) => presented === token ? roleId : null,
      resolveAuthority: ({ roleId: requestedRole, operationId, requestHash,
        wallet, chainId, policyHash }) => {
        if (requestedRole !== roleId || wallet !== selected.wallet ||
            chainId !== selected.chainId ||
            policyHash !== dacsWalletSpendPolicyHashV1(selected)) {
          return null;
        }
        return createWalletSpendAuthorityV1(selected, {
          store: createDacsPostgresWalletSpendStateStoreV1({
            pool,
            wallet: selected.wallet,
            chainId: selected.chainId,
            continuity: pool.continuity,
            operation: () => ({ roleId, operationId, requestHash }),
          }),
          readBalance: async () => "1000",
          authenticateRecovery: async () => true,
          owner: "wallet-service",
          leaseDurationMs: 1_000_000,
        });
      },
      operations,
    });
    const tokenRoot = await mkdtemp(join(tmpdir(), "dacs-postgres-current-read-"));
    const tokenPath = join(tokenRoot, "token");
    await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(tokenPath, 0o600);
    let handledPosts = 0;
    let handledGets = 0;
    let remoteRequestHash = "";
    const fetchWithLostResponse = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === "GET") {
        handledGets += 1;
        return handler(request);
      }
      handledPosts += 1;
      const body = await request.clone().json();
      remoteRequestHash = sha256Hex(canonicalize(body));
      const response = await handler(request);
      await settle(localAuthority("92", "seed-two"), item("expired-two"), "e");
      pool.nowMs = 131_002;
      throw new Error(`lost response ${response.status}`);
    }) as typeof fetch;

    try {
      const remote = await createDacsRemoteWalletSpendAuthorityV1({
        policy: selected,
        endpoint: "http://127.0.0.1:8080/",
        tokenFilePath: tokenPath,
        allowInsecureLoopback: true,
        fetch: fetchWithLostResponse,
      });
      await expect(remote.reserve(item("retained-reserve"))).resolves.toMatchObject({
        status: "reserved",
        permit: { reservationId: "retained-reserve", owner: "wallet-service" },
      });
      expect(handledPosts).toBe(1);
      expect(handledGets).toBe(1);
      expect([...pool.candidates.values()]
        .filter((candidate) => candidate.role_id === roleId &&
          candidate.request_hash === remoteRequestHash)
        .map(({ mutation_index, status }) => ({ mutation_index, status })))
        .toEqual([
          { mutation_index: 0, status: "applied" },
          { mutation_index: 8, status: "applied" },
        ]);
      expect(pool.row.state.rollingEvents).toMatchObject([
        { reservationId: "expired-two", settledAt: 70_001 },
      ]);
    } finally {
      await rm(tokenRoot, { recursive: true, force: true });
    }
  });

  it("rejects a whole-database rollback and stale replica for a brand-new client", async () => {
    const pool = await fakePool();
    const stale = structuredClone(pool.row);
    const scope = dacsWalletSpendLineageKeyV1("wallet-a", "chain-a");
    const writer = createDacsPostgresWalletSpendStateStoreV1({
      pool, wallet: "wallet-a", chainId: "chain-a", continuity: pool.continuity,
      operation: () => ({
        roleId: "buyer", operationId: "00000000-0000-4000-8000-000000000051",
        requestHash: "5".repeat(64),
      }),
    });
    await writer.transact(scope, (current) => ({
      state: { ...current!, generation: current!.generation + 1 }, value: "settled-debit",
    }));
    expect(pool.row.revision).toBe(1);
    Object.assign(pool.row, stale);
    const restored = createDacsPostgresWalletSpendStateStoreV1({
      pool, wallet: "wallet-a", chainId: "chain-a", continuity: pool.continuity,
    });
    await expect(restored.read!(scope)).rejects.toThrow(/continuity-head-mismatch/);
  });

  it("retains candidate-before-witness crashes and lets only the exact operation retry", async () => {
    const pool = await fakePool();
    const scope = dacsWalletSpendLineageKeyV1("wallet-a", "chain-a");
    const interrupted: DacsWalletSpendContinuityPinV1 = {
      ...pool.continuity,
      witness: {
        readCurrent: (input) => pool.continuity.witness.readCurrent(input),
        compareAndSet: async () => { throw new Error("witness unavailable before CAS"); },
        lookupAdvance: async () => null,
      },
    };
    const operation = () => ({
      roleId: "buyer", operationId: "00000000-0000-4000-8000-000000000052",
      requestHash: "6".repeat(64),
    });
    const mutate = (current: Readonly<WalletSpendStateV1> | null) => ({
      state: { ...current!, generation: current!.generation + 1 }, value: "authorized",
    });
    await expect(createDacsPostgresWalletSpendStateStoreV1({
      pool, wallet: "wallet-a", chainId: "chain-a", continuity: interrupted, operation,
    }).transact(scope, mutate)).rejects.toThrow(/outcome-unresolved/);
    expect([...pool.candidates.values()]).toMatchObject([{ status: "prepared" }]);
    await expect(createDacsPostgresWalletSpendStateStoreV1({
      pool, wallet: "wallet-a", chainId: "chain-a", continuity: pool.continuity, operation,
    }).transact(scope, mutate)).resolves.toBe("authorized");
  });

  it("resolves an ambiguous witness CAS by exact candidate lookup", async () => {
    const pool = await fakePool();
    const scope = dacsWalletSpendLineageKeyV1("wallet-a", "chain-a");
    const ambiguous: DacsWalletSpendContinuityPinV1 = {
      ...pool.continuity,
      witness: {
        readCurrent: (input) => pool.continuity.witness.readCurrent(input),
        compareAndSet: async (input) => {
          await pool.continuity.witness.compareAndSet(input);
          throw new Error("witness acknowledgement lost");
        },
        lookupAdvance: (input) => pool.continuity.witness.lookupAdvance(input),
      },
    };
    const store = createDacsPostgresWalletSpendStateStoreV1({
      pool, wallet: "wallet-a", chainId: "chain-a", continuity: ambiguous,
      operation: () => ({
        roleId: "buyer", operationId: "00000000-0000-4000-8000-000000000053",
        requestHash: "7".repeat(64),
      }),
    });
    await expect(store.transact(scope, (current) => ({
      state: { ...current!, generation: current!.generation + 1 }, value: "authorized",
    }))).resolves.toBe("authorized");
    expect(pool.row.revision).toBe(1);
  });

  it("fails closed when restore loses the post-witness candidate", async () => {
    const pool = await fakePool();
    pool.failNextConnect = true;
    const scope = dacsWalletSpendLineageKeyV1("wallet-a", "chain-a");
    const operation = () => ({
      roleId: "buyer", operationId: "00000000-0000-4000-8000-000000000054",
      requestHash: "8".repeat(64),
    });
    const store = () => createDacsPostgresWalletSpendStateStoreV1({
      pool, wallet: "wallet-a", chainId: "chain-a", continuity: pool.continuity, operation,
    });
    const mutate = (current: Readonly<WalletSpendStateV1> | null) => ({
      state: { ...current!, generation: current!.generation + 1 }, value: "authorized",
    });
    await expect(store().transact(scope, mutate)).rejects.toThrow(/outcome unknown/);
    pool.candidates.clear();
    await expect(store().transact(scope, mutate)).rejects.toThrow(/recovery-unavailable/);
    expect(pool.row.revision).toBe(0);
  });

  it("lets one split-brain writer win witness CAS and rejects the old-head writer", async () => {
    const pool = await fakePool();
    const scope = dacsWalletSpendLineageKeyV1("wallet-a", "chain-a");
    const store = (suffix: string) => createDacsPostgresWalletSpendStateStoreV1({
      pool,
      wallet: "wallet-a",
      chainId: "chain-a",
      continuity: pool.continuity,
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

    const outcomes = await Promise.allSettled([
      store("2").transact(scope, mutate("a")),
      store("3").transact(scope, mutate("b")),
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect((outcomes.find(({ status }) => status === "rejected") as PromiseRejectedResult)
      .reason).toMatchObject({ message: "wallet-spend-continuity-conflict" });
    expect(pool.row.revision).toBe(1);
    expect(pool.row.state.generation).toBe(1);
    expect([...pool.candidates.values()].filter(({ status }) => status === "applied"))
      .toHaveLength(1);
  });
});

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  VERSION,
} from "@kynesyslabs/dacs";
import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import {
  createFixedPriceX402BuyerCoordinator,
  FIXED_PRICE_OFFLINE_COMMERCE_PROFILE,
  FIXED_PRICE_OFFLINE_STANDARD_REVISION,
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  fixedPriceOfflineOrderBindingHash,
  fixedPriceOfflineOrderLocalBindingHash,
  fixedPriceX402OrderBindingHash,
  fixedPriceX402OrderLocalBindingHash,
  type FixedPriceOfflineOrderInput,
  type FixedPriceOfflineProtocolBinding,
  type FixedPriceX402OrderInput,
  type FixedPriceX402ProtocolBinding,
  type FixedPriceX402TrackOperation,
} from "@kynesyslabs/dacs/commerce";

import {
  DACS_NODE_LIVE_PROFILE,
  DACS_NODE_OFFLINE_PROFILE,
} from "../src/index.js";
import {
  DACS_NODE_SQLITE_APPLICATION_ID,
  DACS_NODE_SQLITE_MAX_PAGE_SIZE,
  DACS_NODE_SQLITE_SCHEMA_VERSION,
  DacsNodeSqliteError,
  inspectDacsNodeSqliteUpgradeSafetyV1,
  inspectExistingDacsNodeSqliteDatabaseV1,
  inspectDacsNodeSqliteLocation,
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabaseOptions,
} from "../src/sqlite.js";

const BINDING_HASH = "a".repeat(64);
const OTHER_BINDING_HASH = "b".repeat(64);
const ABSENCE_PROOF_HASH = "c".repeat(64);
const JOB_ID = "01J8N4YV7YVYQ4DB7M8T4C7W0A";
const OTHER_JOB_ID = "01J8N4YV7YVYQ4DB7M8T4C7W0B";
const THIRD_JOB_ID = "01J8N4YV7YVYQ4DB7M8T4C7W0C";
const BUYER = "did:example:sqlite-buyer";
const SELLER = "did:example:sqlite-seller";
const LIVE_PROTOCOL: FixedPriceX402ProtocolBinding = {
  commerceProfile: FIXED_PRICE_X402_COMMERCE_PROFILE,
  standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
  phase: "pay-x402",
  orchestratorTopology: "seller-as-phase-orchestrator-v1",
  orchestrator: SELLER,
  rail: {
    registryIndexRef: FIXED_PRICE_X402_REGISTRY_INDEX_REF,
    registryIndexHash: "1".repeat(64),
    railDefinitionRef: "dacs4:rail:x402%3Asqlite:1",
    railDefinitionHash: "2".repeat(64),
    railId: "x402:sqlite",
    railVersion: 1,
    railType: "x402",
    phaseHandler: "pay-x402",
    network: "eip155:8453",
    availability: "live",
  },
};
const OFFLINE_PROTOCOL: FixedPriceOfflineProtocolBinding = {
  commerceProfile: FIXED_PRICE_OFFLINE_COMMERCE_PROFILE,
  standardRevision: FIXED_PRICE_OFFLINE_STANDARD_REVISION,
  mode: "offline",
  orchestratorTopology: "seller-as-phase-orchestrator-v1",
  orchestrator: SELLER,
  settlement: {
    adapter: "deterministic-offline",
    version: 1,
    disposition: "mocked",
  },
};

function liveOrder(jobId = JOB_ID): FixedPriceX402OrderInput {
  return {
    jobId,
    buyer: BUYER,
    seller: SELLER,
    protocol: LIVE_PROTOCOL,
    sdkJobs: {
      role: "buyer",
      agreement: `buyer:agreement:${jobId}`,
      payment: `buyer:payment:${jobId}`,
      paymentEvidence: `buyer:payment-evidence:${jobId}`,
      buyerReceived: `buyer:received:${jobId}`,
      audit: `buyer:audit:${jobId}`,
    },
  };
}

function liveSellerOrder(jobId = JOB_ID): FixedPriceX402OrderInput {
  return {
    ...liveOrder(jobId),
    sdkJobs: {
      role: "seller",
      agreement: `seller:agreement:${jobId}`,
      payment: `seller:payment:${jobId}`,
      paymentEvidence: `seller:payment-evidence:${jobId}`,
      fulfilment: `seller:fulfilment:${jobId}`,
      deliveryEvidence: `seller:delivery-evidence:${jobId}`,
      audit: `seller:audit:${jobId}`,
    },
  };
}

function offlineOrder(jobId = JOB_ID): FixedPriceOfflineOrderInput {
  return {
    ...liveOrder(jobId),
    protocol: OFFLINE_PROTOCOL,
  };
}

function liveOrderBinding(order: FixedPriceX402OrderInput): Readonly<{
  bindingHash: string;
  localBindingHash: string;
}> {
  return {
    bindingHash: fixedPriceX402OrderBindingHash(order),
    localBindingHash: fixedPriceX402OrderLocalBindingHash(order),
  };
}

function offlineOrderBinding(order: FixedPriceOfflineOrderInput): Readonly<{
  bindingHash: string;
  localBindingHash: string;
}> {
  return {
    bindingHash: fixedPriceOfflineOrderBindingHash(order),
    localBindingHash: fixedPriceOfflineOrderLocalBindingHash(order),
  };
}

const finalCoordinatorOperation = (label: string): FixedPriceX402TrackOperation =>
  async ({ fence }) => {
    await fence.assertCurrent();
    return {
      status: "final",
      outcome: "success",
      reference: `${label}:${fence.jobId}`,
    };
  };

describe("DACS Node SQLite durability foundation", () => {
  const roots: string[] = [];
  const databases: DacsNodeSqliteDatabase[] = [];

  function temporaryRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "dacs-node-sqlite-"));
    roots.push(root);
    return root;
  }

  function options(
    databasePath: string,
    overrides: Partial<DacsNodeSqliteDatabaseOptions> = {},
  ): DacsNodeSqliteDatabaseOptions {
    return {
      databasePath,
      mode: "offline",
      profile: DACS_NODE_OFFLINE_PROFILE,
      role: "buyer",
      authority: "claim:buyer:primary",
      ...overrides,
    };
  }

  async function open(
    databasePath: string,
    overrides: Partial<DacsNodeSqliteDatabaseOptions> = {},
  ): Promise<DacsNodeSqliteDatabase> {
    const database = await openDacsNodeSqliteDatabase(options(databasePath, overrides));
    databases.push(database);
    return database;
  }

  async function createV1Database(
    databasePath: string,
    beforeDowngrade?: (database: DacsNodeSqliteDatabase) => void,
  ): Promise<void> {
    const current = await open(databasePath);
    beforeDowngrade?.(current);
    current.close();
    databases.splice(databases.indexOf(current), 1);
    const raw = new BetterSqlite3(databasePath);
    raw.exec(`
      DROP TABLE dacs_http_inbox_history;
      DROP TABLE dacs_http_outbox_history;
      DROP TABLE dacs_http_inbox;
      DROP TABLE dacs_http_outbox;
      DROP TABLE dacs_http_clock;
      DROP TABLE dacs_payment_evidence_history;
      DROP TABLE dacs_payment_evidence_reservations;
      DROP TABLE dacs_payment_evidence_handshakes;
      DROP TABLE dacs_effect_history;
      DROP TABLE dacs_effects;
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
      DROP TABLE dacs_coordinator_tracks;
      DROP TABLE dacs_coordinator_orders;
      DELETE FROM dacs_migrations WHERE version = 6;
      DELETE FROM dacs_migrations WHERE version = 5;
      DELETE FROM dacs_migrations WHERE version = 4;
      DELETE FROM dacs_migrations WHERE version = 3;
      DELETE FROM dacs_migrations WHERE version = 2;
      UPDATE dacs_store_metadata SET schema_version = 1 WHERE singleton = 1;
      PRAGMA user_version = 1;
    `);
    raw.close();
  }

  function createHistoricalV2Database(
    databasePath: string,
    metadata: Readonly<{ sdkVersion: string; standardRevision: string }>,
  ): void {
    const raw = new BetterSqlite3(databasePath);
    raw.exec(readFileSync(
      new URL("./fixtures/sqlite-v2-811a7dac.sql", import.meta.url),
      "utf8",
    ));
    raw.prepare(`
      INSERT INTO dacs_store_metadata (
        singleton, schema_version, mode, profile, role, authority,
        sdk_version, standard_revision, created_at
      ) VALUES (1, 2, 'offline', ?, 'buyer', 'claim:buyer:primary', ?, ?, 1)
    `).run(
      DACS_NODE_OFFLINE_PROFILE,
      metadata.sdkVersion,
      metadata.standardRevision,
    );
    raw.exec(`
      INSERT INTO dacs_migrations (version, applied_at) VALUES (1, 1), (2, 1);
    `);
    raw.close();
  }

  function downgradeCurrentCoordinatorDatabaseToV3(databasePath: string): void {
    const raw = new BetterSqlite3(databasePath);
    raw.pragma("foreign_keys = OFF");
    const metadata = raw.prepare(`
      SELECT profile FROM dacs_store_metadata WHERE singleton = 1
    `).get() as { profile: string };
    const orderRows = raw.prepare(`
      SELECT profile, role, job_id, binding_hash, record_json, revision,
        created_at, updated_at
      FROM dacs_coordinator_orders ORDER BY profile, role, job_id
    `).all() as Array<{
      profile: string;
      role: string;
      job_id: string;
      binding_hash: string;
      record_json: string;
      revision: number;
      created_at: number;
      updated_at: number;
    }>;
    type LegacyTrackRow = {
      profile: string;
      role: string;
      job_id: string;
      track: string;
      eligible: number;
      state: string;
      outcome: string | null;
      error_class: string | null;
      generation: number;
      attempts: number;
      lease_expires_at: number | null;
      next_attempt_at: number | null;
      updated_at: number;
    };
    const trackRows = raw.prepare(`
      SELECT profile, role, job_id, track, eligible, state, outcome,
        error_class, generation, attempts, lease_expires_at, next_attempt_at,
        updated_at
      FROM dacs_coordinator_tracks ORDER BY profile, role, job_id, track
    `).all() as LegacyTrackRow[];
    const legacyOutcome = {
      "simulated-success": "success",
      "simulated-failure": "failure",
      "simulated-aborted": "aborted",
    } as const;
    const legacyErrorClass = {
      "simulated-permanent": "permanent",
      "simulated-transient": "transient",
      "simulated-counterparty": "counterparty",
      "simulated-substrate": "substrate",
      "simulated-settlement-atomicity": "settlement-atomicity",
    } as const;
    const retainedOrders = orderRows.map((row) => {
      const record = JSON.parse(row.record_json) as Record<string, unknown>;
      delete record.localBindingHash;
      const tracks = record.tracks as Record<string, Record<string, unknown>>;
      for (const track of Object.values(tracks)) {
        delete track.faultedParty;
        delete track.withdrawnBy;
        if (metadata.profile === DACS_NODE_OFFLINE_PROFILE) {
          if (track.outcome !== undefined) {
            track.outcome = legacyOutcome[
              track.outcome as keyof typeof legacyOutcome
            ];
          }
          if (track.errorClass !== undefined) {
            track.errorClass = legacyErrorClass[
              track.errorClass as keyof typeof legacyErrorClass
            ];
          }
        }
      }
      const recordJson = canonicalize(record);
      return { ...row, recordJson, recordHash: sha256Hex(recordJson) };
    });
    const retainedTracks: LegacyTrackRow[] = trackRows.map((row) => ({
      ...row,
      ...(metadata.profile === DACS_NODE_OFFLINE_PROFILE && row.outcome !== null
        ? {
            outcome: legacyOutcome[
              row.outcome as keyof typeof legacyOutcome
            ],
          }
        : {}),
      ...(metadata.profile === DACS_NODE_OFFLINE_PROFILE && row.error_class !== null
        ? {
            error_class: legacyErrorClass[
              row.error_class as keyof typeof legacyErrorClass
            ],
          }
        : {}),
    }));

    const downgrade = raw.transaction(() => {
      raw.exec(`
        DROP TABLE dacs_http_inbox_history;
        DROP TABLE dacs_http_outbox_history;
        DROP TABLE dacs_http_inbox;
        DROP TABLE dacs_http_outbox;
        DROP TABLE dacs_http_clock;
        DROP TABLE dacs_payment_evidence_history;
        DROP TABLE dacs_payment_evidence_reservations;
        DROP TABLE dacs_payment_evidence_handshakes;
        DROP TABLE dacs_coordinator_tracks;
        ALTER TABLE dacs_coordinator_orders RENAME TO dacs_coordinator_orders_v4;
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
      `);
      const insertOrder = raw.prepare(`
        INSERT INTO dacs_coordinator_orders (
          profile, role, job_id, binding_hash, record_hash, record_json,
          revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of retainedOrders) {
        insertOrder.run(
          row.profile,
          row.role,
          row.job_id,
          row.binding_hash,
          row.recordHash,
          row.recordJson,
          row.revision,
          row.created_at,
          row.updated_at,
        );
      }
      raw.exec(`
        DROP TABLE dacs_coordinator_orders_v4;
        CREATE TABLE dacs_coordinator_tracks (
          profile TEXT NOT NULL,
          role TEXT NOT NULL,
          job_id TEXT NOT NULL,
          track TEXT NOT NULL,
          eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
          state TEXT NOT NULL,
          outcome TEXT,
          error_class TEXT,
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
          CHECK (outcome IS NULL OR outcome IN ('success', 'failure', 'aborted')),
          CHECK (error_class IS NULL OR error_class IN (
            'permanent', 'transient', 'counterparty', 'substrate',
            'settlement-atomicity'
          )),
          CHECK (error_class IS NULL OR outcome = 'failure'),
          CHECK (outcome IS NULL OR outcome != 'failure' OR error_class IS NOT NULL)
        ) STRICT, WITHOUT ROWID;
      `);
      const insertTrack = raw.prepare(`
        INSERT INTO dacs_coordinator_tracks (
          profile, role, job_id, track, eligible, state, outcome, error_class,
          generation, attempts, lease_expires_at, next_attempt_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of retainedTracks) {
        insertTrack.run(
          row.profile,
          row.role,
          row.job_id,
          row.track,
          row.eligible,
          row.state,
          row.outcome,
          row.error_class,
          row.generation,
          row.attempts,
          row.lease_expires_at,
          row.next_attempt_at,
          row.updated_at,
        );
      }
      raw.exec(`
        CREATE INDEX dacs_coordinator_tracks_runnable_idx
          ON dacs_coordinator_tracks (
            profile, role, track, eligible, state, next_attempt_at,
            lease_expires_at, job_id
          );
        DELETE FROM dacs_migrations WHERE version = 6;
        DELETE FROM dacs_migrations WHERE version = 5;
        DELETE FROM dacs_migrations WHERE version = 4;
        UPDATE dacs_store_metadata SET schema_version = 3 WHERE singleton = 1;
        PRAGMA user_version = 3;
      `);
    });
    downgrade();
    raw.close();
  }

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("creates a WAL/FULL database permanently bound to one actor and runtime", async () => {
    const databasePath = join(temporaryRoot(), "nested", "buyer.sqlite");
    const database = await open(databasePath);

    expect(database.readTime()).toBeGreaterThan(0);
    expect(database.diagnostics()).toMatchObject({
      databasePath,
      schemaVersion: DACS_NODE_SQLITE_SCHEMA_VERSION,
      applicationId: DACS_NODE_SQLITE_APPLICATION_ID,
      mode: "offline",
      profile: DACS_NODE_OFFLINE_PROFILE,
      role: "buyer",
      authority: "claim:buyer:primary",
      sdkVersion: VERSION,
      standardRevision: FIXED_PRICE_OFFLINE_STANDARD_REVISION,
      journalMode: "wal",
      synchronous: "full",
      quickCheck: "ok",
    });
    if (process.platform !== "win32") {
      expect(statSync(databasePath).mode & 0o777).toBe(0o600);
    }

    database.close();
    databases.splice(databases.indexOf(database), 1);
    const reopened = await open(databasePath);
    expect(reopened.metadata).toEqual(database.metadata);
  });

  it("blocks upgrades while an irreversible effect is unfinished", async () => {
    const database = await open(join(temporaryRoot(), "upgrade-safety.sqlite"));
    expect(database.upgradeSafety()).toEqual({
      safe: true,
      intentEffects: 0,
      activeEffects: 0,
      reconciliationEffects: 0,
      operatorActionEffects: 0,
      incompleteOrders: 0,
    });
    const effect = {
      kind: "payment" as const,
      effectId: "payment:upgrade-safety",
      bindingHash: BINDING_HASH,
      input: { amount: "1", asset: "USDC" },
      idempotencyKey: "payment:idempotency:upgrade-safety",
      jobId: JOB_ID,
    };
    database.putEffectIntent(effect);
    expect(database.upgradeSafety()).toMatchObject({ safe: false, intentEffects: 1 });
    const claim = database.claimEffect({
      kind: effect.kind,
      effectId: effect.effectId,
      bindingHash: effect.bindingHash,
      owner: "upgrade-safety-worker",
      leaseDurationMs: 10_000,
    });
    if (claim.status !== "acquired") throw new Error("expected effect claim");
    expect(database.upgradeSafety()).toMatchObject({
      safe: false,
      intentEffects: 0,
      activeEffects: 1,
    });
    database.recordEffectAmbiguous({
      kind: effect.kind,
      effectId: effect.effectId,
      bindingHash: effect.bindingHash,
      lease: claim.lease,
      reasonCode: "settlement-unknown",
    });
    expect(database.upgradeSafety()).toMatchObject({
      safe: false,
      activeEffects: 0,
      reconciliationEffects: 1,
    });
    const databasePath = database.databasePath;
    database.close();
    databases.splice(databases.indexOf(database), 1);
    const before = statSync(databasePath);
    expect(inspectDacsNodeSqliteUpgradeSafetyV1(options(databasePath))).toMatchObject({
      status: "pass",
      safety: { safe: false, reconciliationEffects: 1 },
    });
    const after = statSync(databasePath);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("blocks upgrades while a coordinator order awaits audit closure", async () => {
    const database = await open(join(temporaryRoot(), "upgrade-order.sqlite"), {
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      authority: BUYER,
    });
    const order = liveOrder();
    expect(await database.createLiveCoordinatorStore("buyer").create({
      role: "buyer",
      order,
      ...liveOrderBinding(order),
    })).toMatchObject({ status: "created" });
    expect(database.upgradeSafety()).toEqual({
      safe: false,
      intentEffects: 0,
      activeEffects: 0,
      reconciliationEffects: 0,
      operatorActionEffects: 0,
      incompleteOrders: 1,
    });
  });

  it("inspects an existing actor store without creating or mutating it", async () => {
    const root = temporaryRoot();
    const missingPath = join(root, "missing.sqlite");
    expect(inspectExistingDacsNodeSqliteDatabaseV1(options(missingPath))).toEqual({
      status: "blocked",
      reasonCode: "database-missing",
      databasePath: missingPath,
    });
    expect(existsSync(missingPath)).toBe(false);

    const databasePath = join(root, "buyer.sqlite");
    const database = await open(databasePath);
    database.close();
    databases.splice(databases.indexOf(database), 1);
    const before = statSync(databasePath);
    expect(inspectExistingDacsNodeSqliteDatabaseV1(options(databasePath))).toMatchObject({
      status: "pass",
      diagnostics: {
        databasePath,
        schemaVersion: DACS_NODE_SQLITE_SCHEMA_VERSION,
        applicationId: DACS_NODE_SQLITE_APPLICATION_ID,
        quickCheck: "ok",
      },
    });
    const after = statSync(databasePath);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("derives immutable SDK and Standard bindings and rejects caller labels", async () => {
    const root = temporaryRoot();
    const databasePath = join(root, "buyer.sqlite");
    const database = await open(databasePath);
    expect(database.metadata).toMatchObject({
      sdkVersion: VERSION,
      standardRevision: FIXED_PRICE_OFFLINE_STANDARD_REVISION,
    });

    const rejectedPath = join(root, "arbitrary-version.sqlite");
    await expect(openDacsNodeSqliteDatabase({
      ...options(rejectedPath),
      sdkVersion: "consumer-label" as typeof VERSION,
    })).rejects.toMatchObject({ reasonCode: "configuration-malformed" });
    expect(existsSync(rejectedPath)).toBe(false);

    await expect(openDacsNodeSqliteDatabase({
      ...options(rejectedPath),
      standardRevision: "consumer-label" as typeof FIXED_PRICE_OFFLINE_STANDARD_REVISION,
    })).rejects.toMatchObject({ reasonCode: "configuration-malformed" });
    expect(existsSync(rejectedPath)).toBe(false);
  });

  it("captures options and public write inputs without evaluating accessors or proxies", async () => {
    const root = temporaryRoot();
    let optionReads = 0;
    const accessorOptions = {
      get databasePath() {
        optionReads += 1;
        return join(root, "accessor.sqlite");
      },
      mode: "offline",
      profile: DACS_NODE_OFFLINE_PROFILE,
      role: "buyer",
      authority: "claim:buyer:primary",
    } as unknown as DacsNodeSqliteDatabaseOptions;
    await expect(openDacsNodeSqliteDatabase(accessorOptions)).rejects.toMatchObject({
      reasonCode: "configuration-malformed",
    });
    expect(optionReads).toBe(0);

    let proxyReads = 0;
    const proxiedOptions = new Proxy(options(join(root, "proxy.sqlite")), {
      get(target, property, receiver) {
        proxyReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    await expect(openDacsNodeSqliteDatabase(proxiedOptions)).rejects.toMatchObject({
      reasonCode: "configuration-malformed",
    });
    expect(proxyReads).toBe(0);

    const database = await open(join(root, "buyer.sqlite"));
    let identityReads = 0;
    const reservation = {
      kind: "message",
      get identity() {
        identityReads += 1;
        return "message:accessor";
      },
      bindingHash: BINDING_HASH,
    } as const;
    expect(() => database.reserveIdentity(reservation)).toThrowError(
      expect.objectContaining({ reasonCode: "reservation-input-malformed" }),
    );
    expect(identityReads).toBe(0);

    let amountReads = 0;
    const effectInput = {
      get amount() {
        amountReads += 1;
        return "1";
      },
      asset: "USDC",
    };
    expect(() => database.putEffectIntent({
      kind: "payment",
      effectId: "payment:accessor",
      bindingHash: BINDING_HASH,
      input: effectInput,
      idempotencyKey: "payment:idempotency:accessor",
    })).toThrowError(expect.objectContaining({ reasonCode: "effect-input-malformed" }));
    expect(amountReads).toBe(0);

    const intent = {
      kind: "payment" as const,
      effectId: "payment:write-accessor",
      bindingHash: BINDING_HASH,
      input: { amount: "1", asset: "USDC" },
      idempotencyKey: "payment:idempotency:write-accessor",
    };
    expect(database.putEffectIntent(intent)).toMatchObject({ status: "created" });
    const claim = database.claimEffect({
      kind: intent.kind,
      effectId: intent.effectId,
      bindingHash: intent.bindingHash,
      owner: "worker",
      leaseDurationMs: 10_000,
    });
    if (claim.status !== "acquired") throw new Error("expected effect claim");
    let resultReads = 0;
    expect(() => database.recordEffectCompleted({
      kind: intent.kind,
      effectId: intent.effectId,
      bindingHash: intent.bindingHash,
      lease: claim.lease,
      result: {
        get transactionHash() {
          resultReads += 1;
          return "transaction";
        },
      },
    })).toThrowError(expect.objectContaining({ reasonCode: "effect-result-malformed" }));
    expect(resultReads).toBe(0);

    let leaseReads = 0;
    const accessorLease = {
      get owner() {
        leaseReads += 1;
        return claim.lease.owner;
      },
      generation: claim.lease.generation,
      expiresAt: claim.lease.expiresAt,
      mode: claim.lease.mode,
    };
    expect(() => database.recordEffectAmbiguous({
      kind: intent.kind,
      effectId: intent.effectId,
      bindingHash: intent.bindingHash,
      lease: accessorLease,
      reasonCode: "ambiguous",
    })).toThrowError(expect.objectContaining({ reasonCode: "effect-result-malformed" }));
    expect(leaseReads).toBe(0);

    let coordinatorReads = 0;
    const coordinatorInput = {
      get role() {
        coordinatorReads += 1;
        return "buyer" as const;
      },
      order: offlineOrder(),
      bindingHash: fixedPriceOfflineOrderBindingHash(offlineOrder()),
      localBindingHash: fixedPriceOfflineOrderLocalBindingHash(offlineOrder()),
    };
    await expect(database.createOfflineCoordinatorStore("buyer").create(coordinatorInput))
      .resolves.toMatchObject({ status: "corrupt" });
    expect(coordinatorReads).toBe(0);
  });

  it("reports a busy FULL checkpoint instead of treating a partial checkpoint as success", async () => {
    const databasePath = join(temporaryRoot(), "checkpoint.sqlite");
    const database = await open(databasePath, { busyTimeoutMs: 10 });
    database.reserveIdentity({
      kind: "message",
      identity: "before-reader",
      bindingHash: BINDING_HASH,
    });
    const reader = new BetterSqlite3(databasePath);
    try {
      reader.pragma("journal_mode = WAL");
      reader.exec("BEGIN");
      reader.prepare("SELECT COUNT(*) FROM dacs_reservations").get();
      database.reserveIdentity({
        kind: "message",
        identity: "after-reader",
        bindingHash: OTHER_BINDING_HASH,
      });
      expect(() => database.checkpoint()).toThrowError(
        expect.objectContaining({ reasonCode: "database-checkpoint-busy" }),
      );
      reader.exec("ROLLBACK");
      database.checkpoint();
    } finally {
      if (reader.inTransaction) reader.exec("ROLLBACK");
      reader.close();
    }
  });

  it("refuses profile/authority reuse, unrecognized databases, and newer schemas", async () => {
    const root = temporaryRoot();
    const boundPath = join(root, "bound.sqlite");
    const bound = await open(boundPath);
    bound.close();
    databases.splice(databases.indexOf(bound), 1);

    await expect(openDacsNodeSqliteDatabase(options(boundPath, {
      authority: "claim:other:primary",
    }))).rejects.toMatchObject({ reasonCode: "database-binding-mismatch" });

    const raw = new BetterSqlite3(boundPath);
    raw.pragma(`user_version = ${DACS_NODE_SQLITE_SCHEMA_VERSION + 1}`);
    raw.close();
    await expect(openDacsNodeSqliteDatabase(options(boundPath))).rejects.toMatchObject({
      reasonCode: "database-schema-newer",
    });

    const foreignPath = join(root, "foreign.sqlite");
    const foreign = new BetterSqlite3(foreignPath);
    foreign.exec("CREATE TABLE foreign_state (value TEXT)");
    foreign.close();
    await expect(openDacsNodeSqliteDatabase(options(foreignPath))).rejects.toMatchObject({
      reasonCode: "database-unrecognized",
    });
  });

  it("admits versioned files only with the exact DACS application and schema", async () => {
    const root = temporaryRoot();
    const zeroApplicationId = join(root, "zero-application-id.sqlite");
    await createV1Database(zeroApplicationId);
    const zeroRaw = new BetterSqlite3(zeroApplicationId);
    zeroRaw.pragma("application_id = 0");
    zeroRaw.close();
    await expect(openDacsNodeSqliteDatabase(options(zeroApplicationId)))
      .rejects.toMatchObject({ reasonCode: "database-application-mismatch" });

    const missingIndex = join(root, "missing-index.sqlite");
    const current = await open(missingIndex);
    current.close();
    databases.splice(databases.indexOf(current), 1);
    const indexRaw = new BetterSqlite3(missingIndex);
    indexRaw.exec("DROP INDEX dacs_effects_runnable_idx");
    indexRaw.close();
    await expect(openDacsNodeSqliteDatabase(options(missingIndex)))
      .rejects.toMatchObject({ reasonCode: "database-schema-invalid" });

    const renamedColumn = join(root, "renamed-column.sqlite");
    const columnCurrent = await open(renamedColumn);
    columnCurrent.close();
    databases.splice(databases.indexOf(columnCurrent), 1);
    const columnRaw = new BetterSqlite3(renamedColumn);
    columnRaw.exec(`
      ALTER TABLE dacs_reservations
      RENAME COLUMN payload_hash TO payload_digest
    `);
    columnRaw.close();
    await expect(openDacsNodeSqliteDatabase(options(renamedColumn)))
      .rejects.toMatchObject({ reasonCode: "database-schema-invalid" });

    const historyGap = join(root, "history-gap.sqlite");
    const historyCurrent = await open(historyGap);
    historyCurrent.close();
    databases.splice(databases.indexOf(historyCurrent), 1);
    const historyRaw = new BetterSqlite3(historyGap);
    historyRaw.exec("DELETE FROM dacs_migrations WHERE version = 1");
    historyRaw.close();
    await expect(openDacsNodeSqliteDatabase(options(historyGap)))
      .rejects.toMatchObject({ reasonCode: "database-migration-history-invalid" });

    const orphanHistory = join(root, "orphan-history.sqlite");
    const foreignCurrent = await open(orphanHistory);
    foreignCurrent.close();
    databases.splice(databases.indexOf(foreignCurrent), 1);
    const foreignRaw = new BetterSqlite3(orphanHistory);
    foreignRaw.pragma("foreign_keys = OFF");
    foreignRaw.prepare(`
      INSERT INTO dacs_effect_history (
        effect_kind, effect_id, event, generation, occurred_at, detail_hash,
        detail_json, previous_entry_hash, entry_hash
      ) VALUES ('payment', 'missing-effect', 'forged-event', 0, 1, ?, '{}', NULL, ?)
    `).run(BINDING_HASH, OTHER_BINDING_HASH);
    foreignRaw.close();
    await expect(openDacsNodeSqliteDatabase(options(orphanHistory)))
      .rejects.toMatchObject({ reasonCode: "database-foreign-key-invalid" });
  });

  it("rejects incomplete, forged, or reservation-detached effect lifecycles", async () => {
    const root = temporaryRoot();
    const mutations = [
      {
        name: "missing-history",
        terminal: "intent" as const,
        mutate(raw: BetterSqlite3.Database) {
          raw.exec("DELETE FROM dacs_effect_history");
        },
      },
      {
        name: "forged-terminal-history",
        terminal: "completed" as const,
        mutate(raw: BetterSqlite3.Database) {
          raw.exec(`
            UPDATE dacs_effect_history SET event = 'operator-action-required'
            WHERE sequence = (SELECT MAX(sequence) FROM dacs_effect_history)
          `);
        },
      },
      {
        name: "missing-reservation",
        terminal: "intent" as const,
        mutate(raw: BetterSqlite3.Database) {
          raw.exec("DELETE FROM dacs_reservations");
        },
      },
      {
        name: "mismatched-reservation",
        terminal: "intent" as const,
        mutate(raw: BetterSqlite3.Database) {
          raw.prepare("UPDATE dacs_reservations SET binding_hash = ?")
            .run(OTHER_BINDING_HASH);
        },
      },
      {
        name: "demoted-ambiguous-effect",
        terminal: "ambiguous" as const,
        mutate(raw: BetterSqlite3.Database) {
          raw.exec(`
            UPDATE dacs_effects SET state = 'intent', retry_at = NULL, reason_code = NULL
          `);
        },
      },
      {
        name: "mutated-ambiguous-idempotency-key",
        terminal: "ambiguous" as const,
        mutate(raw: BetterSqlite3.Database) {
          raw.exec(`
            UPDATE dacs_effects
            SET idempotency_key = idempotency_key || '-forged'
          `);
        },
      },
    ];

    for (const mutation of mutations) {
      const databasePath = join(root, `${mutation.name}.sqlite`);
      const database = await open(databasePath);
      const effectId = `payment:${mutation.name}`;
      database.putEffectIntent({
        kind: "payment",
        effectId,
        bindingHash: BINDING_HASH,
        input: { amount: "1", asset: "USDC" },
        idempotencyKey: `payment:idempotency:${mutation.name}`,
        jobId: JOB_ID,
      });
      if (mutation.terminal !== "intent") {
        const claim = database.claimEffect({
          kind: "payment",
          effectId,
          bindingHash: BINDING_HASH,
          owner: "buyer-worker",
          leaseDurationMs: 10_000,
        });
        if (claim.status !== "acquired") throw new Error("expected effect claim");
        if (mutation.terminal === "completed") {
          expect(database.recordEffectCompleted({
            kind: "payment",
            effectId,
            bindingHash: BINDING_HASH,
            lease: claim.lease,
            result: { transaction: "confirmed" },
          })).toMatchObject({ status: "recorded" });
        } else {
          expect(database.recordEffectAmbiguous({
            kind: "payment",
            effectId,
            bindingHash: BINDING_HASH,
            lease: claim.lease,
            reasonCode: "settlement-unknown",
          })).toMatchObject({ status: "recorded" });
        }
      }
      database.close();
      databases.splice(databases.indexOf(database), 1);

      const validReopen = await open(databasePath);
      expect(validReopen.loadEffect("payment", effectId)?.state).toBe(
        mutation.terminal === "ambiguous" ? "reconciliation-required" : mutation.terminal,
      );
      validReopen.close();
      databases.splice(databases.indexOf(validReopen), 1);

      const raw = new BetterSqlite3(databasePath);
      mutation.mutate(raw);
      raw.close();

      await expect(openDacsNodeSqliteDatabase(options(databasePath)))
        .rejects.toMatchObject({ reasonCode: "database-logical-corruption" });
    }
  });

  it("fails closed on an idempotency-key mutation through an already-open connection", async () => {
    const databasePath = join(temporaryRoot(), "open-mutation.sqlite");
    const database = await open(databasePath);
    const effectId = "payment:open-mutation";
    database.putEffectIntent({
      kind: "payment",
      effectId,
      bindingHash: BINDING_HASH,
      input: { amount: "1", asset: "USDC" },
      idempotencyKey: "payment:idempotency:open-mutation",
      jobId: JOB_ID,
    });
    const claim = database.claimEffect({
      kind: "payment",
      effectId,
      bindingHash: BINDING_HASH,
      owner: "buyer-worker",
      leaseDurationMs: 10_000,
    });
    if (claim.status !== "acquired") throw new Error("expected effect claim");
    expect(database.recordEffectAmbiguous({
      kind: "payment",
      effectId,
      bindingHash: BINDING_HASH,
      lease: claim.lease,
      reasonCode: "settlement-unknown",
    })).toMatchObject({ status: "recorded" });

    const raw = new BetterSqlite3(databasePath);
    raw.prepare(`
      UPDATE dacs_effects SET idempotency_key = ?
      WHERE effect_kind = 'payment' AND effect_id = ?
    `).run("payment:idempotency:attacker-selected", effectId);
    raw.close();

    expect(() => database.loadEffect("payment", effectId)).toThrowError(
      expect.objectContaining({ reasonCode: "database-logical-corruption" }),
    );
    expect(() => database.claimEffect({
      kind: "payment",
      effectId,
      bindingHash: BINDING_HASH,
      owner: "buyer-recovery-worker",
      leaseDurationMs: 10_000,
    })).toThrowError(expect.objectContaining({ reasonCode: "database-logical-corruption" }));
  });

  it("rejects a pre-fix origin proof instead of fabricating an idempotency binding", async () => {
    const databasePath = join(temporaryRoot(), "legacy-origin.sqlite");
    const database = await open(databasePath);
    database.putEffectIntent({
      kind: "payment",
      effectId: "payment:legacy-origin",
      bindingHash: BINDING_HASH,
      input: { amount: "1", asset: "USDC" },
      idempotencyKey: "payment:idempotency:legacy-origin",
      jobId: JOB_ID,
    });
    database.close();
    databases.splice(databases.indexOf(database), 1);

    const raw = new BetterSqlite3(databasePath);
    const row = raw.prepare(`
      SELECT sequence, effect_kind, effect_id, event, generation, occurred_at
      FROM dacs_effect_history
    `).get() as {
      sequence: number;
      effect_kind: string;
      effect_id: string;
      event: string;
      generation: number;
      occurred_at: number;
    };
    const legacyDetailJson = canonicalize({
      bindingHash: BINDING_HASH,
      inputHash: sha256Hex(canonicalize({ amount: "1", asset: "USDC" })),
    });
    const legacyDetailHash = sha256Hex(legacyDetailJson);
    const legacyEntryHash = sha256Hex(canonicalize({
      effectKind: row.effect_kind,
      effectId: row.effect_id,
      event: row.event,
      generation: row.generation,
      occurredAt: row.occurred_at,
      detailHash: legacyDetailHash,
      previousEntryHash: null,
    }));
    raw.prepare(`
      UPDATE dacs_effect_history
      SET detail_hash = ?, detail_json = ?, entry_hash = ?
      WHERE sequence = ?
    `).run(legacyDetailHash, legacyDetailJson, legacyEntryHash, row.sequence);
    raw.close();

    await expect(openDacsNodeSqliteDatabase(options(databasePath)))
      .rejects.toMatchObject({ reasonCode: "database-logical-corruption" });
  });

  it("integrity-checks every intermediate effect-history entry with a rolling chain", async () => {
    const databasePath = join(temporaryRoot(), "history-chain.sqlite");
    const database = await open(databasePath);
    const effectId = "payment:history-chain";
    database.putEffectIntent({
      kind: "payment",
      effectId,
      bindingHash: BINDING_HASH,
      input: { amount: "1", asset: "USDC" },
      idempotencyKey: "payment:idempotency:history-chain",
      jobId: JOB_ID,
    });
    const claim = database.claimEffect({
      kind: "payment",
      effectId,
      bindingHash: BINDING_HASH,
      owner: "buyer-worker",
      leaseDurationMs: 10_000,
    });
    if (claim.status !== "acquired") throw new Error("expected effect claim");
    database.recordEffectAmbiguous({
      kind: "payment",
      effectId,
      bindingHash: BINDING_HASH,
      lease: claim.lease,
      reasonCode: "settlement-unknown",
    });
    database.close();
    databases.splice(databases.indexOf(database), 1);

    const raw = new BetterSqlite3(databasePath);
    const row = raw.prepare(`
      SELECT sequence, effect_kind, effect_id, event, generation, occurred_at,
        previous_entry_hash
      FROM dacs_effect_history
      WHERE event = 'perform-claimed'
    `).get() as {
      sequence: number;
      effect_kind: string;
      effect_id: string;
      event: string;
      generation: number;
      occurred_at: number;
      previous_entry_hash: string;
    };
    const detailJson = canonicalize({
      owner: "attacker-selected-worker",
      expiresAt: row.occurred_at + 10_000,
    });
    const detailHash = sha256Hex(detailJson);
    const entryHash = sha256Hex(canonicalize({
      effectKind: row.effect_kind,
      effectId: row.effect_id,
      event: row.event,
      generation: row.generation,
      occurredAt: row.occurred_at,
      detailHash,
      previousEntryHash: row.previous_entry_hash,
    }));
    raw.prepare(`
      UPDATE dacs_effect_history
      SET detail_hash = ?, detail_json = ?, entry_hash = ?
      WHERE sequence = ?
    `).run(detailHash, detailJson, entryHash, row.sequence);
    raw.close();

    await expect(openDacsNodeSqliteDatabase(options(databasePath)))
      .rejects.toMatchObject({ reasonCode: "database-logical-corruption" });
  });

  it("does not mutate or back up unauthenticated or corrupt v1 sources", async () => {
    const root = temporaryRoot();
    const cases = [
      {
        name: "wrong-authority",
        mutate: (_database: BetterSqlite3.Database) => undefined,
        overrides: { authority: "claim:other:primary" },
        reasonCode: "database-binding-mismatch",
      },
      {
        name: "history-gap",
        mutate: (database: BetterSqlite3.Database) => {
          database.exec("DELETE FROM dacs_migrations WHERE version = 1");
        },
        overrides: {},
        reasonCode: "database-migration-history-invalid",
      },
      {
        name: "schema-drift",
        mutate: (database: BetterSqlite3.Database) => {
          database.exec("DROP INDEX dacs_effects_runnable_idx");
        },
        overrides: {},
        reasonCode: "database-schema-invalid",
      },
      {
        name: "logical-corruption",
        mutate: (database: BetterSqlite3.Database) => {
          database.prepare(`
            INSERT INTO dacs_reservations (
              kind, identity, binding_hash, payload_hash, job_id, created_at
            ) VALUES ('foreign-kind', 'identity', ?, NULL, NULL, 1)
          `).run(BINDING_HASH);
        },
        overrides: {},
        reasonCode: "reservation-corrupt",
      },
    ] as const;

    for (const testCase of cases) {
      const databasePath = join(root, `${testCase.name}.sqlite`);
      await createV1Database(databasePath);
      const raw = new BetterSqlite3(databasePath);
      testCase.mutate(raw);
      raw.close();
      const before = readFileSync(databasePath);
      const backupsBefore = readdirSync(root).filter((name) =>
        name.startsWith(`${testCase.name}.sqlite.backup-v1-`));

      await expect(openDacsNodeSqliteDatabase(options(
        databasePath,
        testCase.overrides,
      ))).rejects.toMatchObject({ reasonCode: testCase.reasonCode });

      expect(readFileSync(databasePath).equals(before)).toBe(true);
      expect(readdirSync(root).filter((name) =>
        name.startsWith(`${testCase.name}.sqlite.backup-v1-`)))
        .toEqual(backupsBefore);
    }
  });

  it("backs up and atomically advances an older supported schema", async () => {
    const root = temporaryRoot();
    const databasePath = join(root, "buyer.sqlite");
    await createV1Database(databasePath);

    const migrated = await open(databasePath);
    expect(migrated.diagnostics().schemaVersion).toBe(DACS_NODE_SQLITE_SCHEMA_VERSION);
    expect(readdirSync(root).filter((name) => name.includes(".backup-v1-")))
      .toHaveLength(1);

    const raw = new BetterSqlite3(databasePath, { readonly: true });
    expect(raw.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name IN (
        'dacs_coordinator_orders', 'dacs_coordinator_tracks'
      ) ORDER BY name
    `).all()).toEqual([
      { name: "dacs_coordinator_orders" },
      { name: "dacs_coordinator_tracks" },
    ]);
    expect(raw.prepare("SELECT version FROM dacs_migrations ORDER BY version").all())
      .toEqual([
        { version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 },
        { version: 6 },
      ]);
    raw.close();
  });

  it("preserves unchanged reservations through the supported migration", async () => {
    const databasePath = join(temporaryRoot(), "reservation-v1.sqlite");
    await createV1Database(databasePath, (database) => {
      expect(database.reserveIdentity({
        kind: "message",
        identity: "message:migrated",
        bindingHash: BINDING_HASH,
        payloadHash: OTHER_BINDING_HASH,
        jobId: JOB_ID,
      })).toMatchObject({ status: "created" });
    });

    const migrated = await open(databasePath);
    expect(migrated.loadReservation("message", "message:migrated")).toMatchObject({
      bindingHash: BINDING_HASH,
      payloadHash: OTHER_BINDING_HASH,
      jobId: JOB_ID,
    });
  });

  it("refuses to migrate a pre-proof effect row or synthesize its identity proof", async () => {
    const root = temporaryRoot();
    const databasePath = join(root, "pre-proof-v1.sqlite");
    await createV1Database(databasePath);
    const inputJson = canonicalize({ amount: "1", asset: "USDC" });
    const inputHash = sha256Hex(inputJson);
    const raw = new BetterSqlite3(databasePath);
    raw.prepare(`
      INSERT INTO dacs_reservations
        (kind, identity, binding_hash, payload_hash, job_id, created_at)
      VALUES ('payment-effect', 'payment:pre-proof', ?, ?, ?, 1)
    `).run(BINDING_HASH, inputHash, JOB_ID);
    raw.prepare(`
      INSERT INTO dacs_effects (
        effect_kind, effect_id, job_id, binding_hash, input_hash, input_json,
        idempotency_key, state, active_mode, generation, attempts, owner,
        lease_expires_at, retry_at, reason_code, absence_proof_hash,
        result_hash, result_json, created_at, updated_at
      ) VALUES ('payment', 'payment:pre-proof', ?, ?, ?, ?,
        'payment:idempotency:pre-proof', 'intent', NULL, 0, 0, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, 1, 1)
    `).run(JOB_ID, BINDING_HASH, inputHash, inputJson);
    raw.prepare(`
      INSERT INTO dacs_effect_history
        (effect_kind, effect_id, event, generation, occurred_at, detail_hash)
      VALUES ('payment', 'payment:pre-proof', 'intent-created', 0, 1, ?)
    `).run(sha256Hex(canonicalize({ bindingHash: BINDING_HASH, inputHash })));
    raw.close();
    const before = readFileSync(databasePath);

    await expect(openDacsNodeSqliteDatabase(options(databasePath)))
      .rejects.toMatchObject({ reasonCode: "effect-corrupt" });
    expect(readFileSync(databasePath).equals(before)).toBe(true);
    expect(readdirSync(root).some((name) => name.includes(".backup-v1-"))).toBe(false);
  });

  it("backs up v2 and preserves an authority-bound coordinator while adding proofs", async () => {
    const root = temporaryRoot();
    const schemaSourcePath = join(root, "schema-v1.sqlite");
    await createV1Database(schemaSourcePath);
    const schemaSource = new BetterSqlite3(schemaSourcePath, { readonly: true });
    const preProofSql = schemaSource.prepare(`
      SELECT sql FROM sqlite_schema
      WHERE name IN (
        'dacs_effects', 'dacs_effect_history',
        'dacs_effects_runnable_idx', 'dacs_effect_history_effect_idx'
      )
      ORDER BY CASE name
        WHEN 'dacs_effects' THEN 1
        WHEN 'dacs_effect_history' THEN 2
        WHEN 'dacs_effects_runnable_idx' THEN 3
        ELSE 4
      END
    `).all() as Array<{ sql: string }>;
    schemaSource.close();

    const databasePath = join(root, "buyer-v2.sqlite");
    const liveOptions = {
      mode: "live-demos" as const,
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer" as const,
      authority: BUYER,
    };
    const current = await open(databasePath, liveOptions);
    const order = liveOrder();
    expect(await current.createLiveCoordinatorStore("buyer").create({
      role: "buyer",
      order,
      ...liveOrderBinding(order),
    })).toMatchObject({ status: "created" });
    current.close();
    databases.splice(databases.indexOf(current), 1);

    const raw = new BetterSqlite3(databasePath);
    const retainedOrder = raw.prepare(`
      SELECT profile, role, job_id, binding_hash, record_json, revision,
        created_at, updated_at
      FROM dacs_coordinator_orders
      WHERE profile = 'live-x402' AND role = 'buyer' AND job_id = ?
    `).get(JOB_ID) as {
      profile: string;
      role: string;
      job_id: string;
      binding_hash: string;
      record_json: string;
      revision: number;
      created_at: number;
      updated_at: number;
    };
    const legacyRecord = JSON.parse(retainedOrder.record_json) as Record<string, unknown>;
    delete legacyRecord.localBindingHash;
    const legacyRecordJson = canonicalize(legacyRecord);
    raw.exec(`
      DROP TABLE dacs_effect_history;
      DROP TABLE dacs_effects;
    `);
    for (const object of preProofSql) raw.exec(object.sql);
    raw.exec(`
      DROP TABLE dacs_coordinator_tracks;
      ALTER TABLE dacs_coordinator_orders RENAME TO dacs_coordinator_orders_v4;
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
      DROP TABLE dacs_coordinator_orders_v4;
    `);
    raw.prepare(`
      INSERT INTO dacs_coordinator_orders (
        profile, role, job_id, binding_hash, record_hash, record_json,
        revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      retainedOrder.profile,
      retainedOrder.role,
      retainedOrder.job_id,
      retainedOrder.binding_hash,
      sha256Hex(legacyRecordJson),
      legacyRecordJson,
      retainedOrder.revision,
      retainedOrder.created_at,
      retainedOrder.updated_at,
    );
    raw.exec(`
      DROP TABLE dacs_http_inbox_history;
      DROP TABLE dacs_http_outbox_history;
      DROP TABLE dacs_http_inbox;
      DROP TABLE dacs_http_outbox;
      DROP TABLE dacs_http_clock;
      DROP TABLE dacs_payment_evidence_history;
      DROP TABLE dacs_payment_evidence_reservations;
      DROP TABLE dacs_payment_evidence_handshakes;
      DELETE FROM dacs_migrations WHERE version = 6;
      DELETE FROM dacs_migrations WHERE version = 5;
      DELETE FROM dacs_migrations WHERE version = 4;
      DELETE FROM dacs_migrations WHERE version = 3;
      UPDATE dacs_store_metadata SET schema_version = 2 WHERE singleton = 1;
      PRAGMA user_version = 2;
    `);
    raw.close();

    const migrated = await open(databasePath, liveOptions);
    expect(await migrated.createLiveCoordinatorStore("buyer").load("buyer", JOB_ID))
      .toMatchObject({ status: "ok", record: { buyer: BUYER } });
    expect(readdirSync(root).filter((name) => name.includes(".backup-v2-")))
      .toHaveLength(1);
  });

  it("migrates the immutable public v2 schema only with exact supported metadata", async () => {
    const root = temporaryRoot();
    const supportedPath = join(root, "historical-supported.sqlite");
    createHistoricalV2Database(supportedPath, {
      sdkVersion: VERSION,
      standardRevision: FIXED_PRICE_OFFLINE_STANDARD_REVISION,
    });
    const migrated = await open(supportedPath);
    expect(migrated.diagnostics()).toMatchObject({
      schemaVersion: DACS_NODE_SQLITE_SCHEMA_VERSION,
    });
    expect(readdirSync(root).filter((name) =>
      name.startsWith("historical-supported.sqlite.backup-v2-")
    )).toHaveLength(1);

    const unsupportedPath = join(root, "historical-unsupported.sqlite");
    createHistoricalV2Database(unsupportedPath, {
      sdkVersion: "0.1.0-alpha.0",
      standardRevision: "standard-test-revision",
    });
    const before = readFileSync(unsupportedPath);
    await expect(openDacsNodeSqliteDatabase(options(unsupportedPath)))
      .rejects.toMatchObject({
        reasonCode: "database-legacy-metadata-unsupported",
      });
    expect(readFileSync(unsupportedPath).equals(before)).toBe(true);
    expect(readdirSync(root).some((name) =>
      name.startsWith("historical-unsupported.sqlite.backup-v2-")
    )).toBe(false);
  });

  it("migrates v3 offline terminal state into authenticated simulation vocabulary", async () => {
    const root = temporaryRoot();
    const databasePath = join(root, "offline-v3.sqlite");
    const current = await open(databasePath, { authority: BUYER });
    const store = current.createOfflineCoordinatorStore("buyer");
    const order = offlineOrder();
    const { bindingHash, localBindingHash } = offlineOrderBinding(order);
    expect(await store.create({
      role: "buyer",
      order,
      bindingHash,
      localBindingHash,
    })).toMatchObject({ status: "created" });
    const claim = await store.claim({
      role: "buyer",
      jobId: JOB_ID,
      bindingHash,
      localBindingHash,
      track: "agreement",
      owner: "offline-v3-worker",
      leaseDurationMs: 10_000,
    });
    if (claim.status !== "acquired") throw new Error("expected offline agreement claim");
    expect(await store.record({
      role: "buyer",
      jobId: JOB_ID,
      bindingHash,
      localBindingHash,
      track: "agreement",
      lease: claim.lease,
      result: {
        status: "final",
        outcome: "simulated-failure",
        errorClass: "simulated-counterparty",
        reference: "offline:agreement:failed",
      },
    })).toMatchObject({ status: "recorded" });
    current.close();
    databases.splice(databases.indexOf(current), 1);
    downgradeCurrentCoordinatorDatabaseToV3(databasePath);

    const migrated = await open(databasePath, { authority: BUYER });
    expect(migrated.diagnostics()).toMatchObject({
      schemaVersion: DACS_NODE_SQLITE_SCHEMA_VERSION,
    });
    expect(await migrated.createOfflineCoordinatorStore("buyer").load("buyer", JOB_ID))
      .toMatchObject({
        status: "ok",
        record: {
          localBindingHash,
          tracks: {
            agreement: {
              outcome: "simulated-failure",
              errorClass: "simulated-counterparty",
            },
          },
        },
      });
    expect(readdirSync(root).filter((name) => name.includes(".backup-v3-")))
      .toHaveLength(1);
    const raw = new BetterSqlite3(databasePath, { readonly: true });
    expect(raw.prepare(`
      SELECT local_binding_hash FROM dacs_coordinator_orders
      WHERE profile = 'offline' AND role = 'buyer' AND job_id = ?
    `).get(JOB_ID)).toEqual({ local_binding_hash: localBindingHash });
    expect(raw.prepare(`
      SELECT local_binding_hash, outcome, error_class, faulted_party, withdrawn_by
      FROM dacs_coordinator_tracks
      WHERE profile = 'offline' AND role = 'buyer' AND job_id = ?
        AND track = 'agreement'
    `).get(JOB_ID)).toEqual({
      local_binding_hash: localBindingHash,
      outcome: "simulated-failure",
      error_class: "simulated-counterparty",
      faulted_party: null,
      withdrawn_by: null,
    });
    raw.close();
  });

  it("rejects legacy live terminal rows whose DACS-5 attribution cannot be proven", async () => {
    const root = temporaryRoot();
    const databasePath = join(root, "live-terminal-v3.sqlite");
    const liveOptions = {
      mode: "live-demos" as const,
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer" as const,
      authority: BUYER,
    };
    const current = await open(databasePath, liveOptions);
    const store = current.createLiveCoordinatorStore("buyer");
    const order = liveOrder();
    const { bindingHash, localBindingHash } = liveOrderBinding(order);
    expect(await store.create({
      role: "buyer",
      order,
      bindingHash,
      localBindingHash,
    })).toMatchObject({ status: "created" });
    const claim = await store.claim({
      role: "buyer",
      jobId: JOB_ID,
      bindingHash,
      localBindingHash,
      track: "agreement",
      owner: "live-v3-worker",
      leaseDurationMs: 10_000,
    });
    if (claim.status !== "acquired") throw new Error("expected live agreement claim");
    expect(await store.record({
      role: "buyer",
      jobId: JOB_ID,
      bindingHash,
      localBindingHash,
      track: "agreement",
      lease: claim.lease,
      result: {
        status: "final",
        outcome: "failure",
        errorClass: "counterparty",
        faultedParty: "seller",
        reference: "live:agreement:failed",
      },
    })).toMatchObject({ status: "recorded" });
    current.close();
    databases.splice(databases.indexOf(current), 1);
    downgradeCurrentCoordinatorDatabaseToV3(databasePath);
    const before = readFileSync(databasePath);

    await expect(openDacsNodeSqliteDatabase(options(databasePath, liveOptions)))
      .rejects.toMatchObject({ reasonCode: "database-logical-corruption" });
    expect(readFileSync(databasePath).equals(before)).toBe(true);
    expect(readdirSync(root).some((name) => name.includes(".backup-v3-"))).toBe(false);
  });

  it("resumes the live coordinator DAG from durable role-local state", async () => {
    const databasePath = join(temporaryRoot(), "buyer.sqlite");
    const liveOptions = {
      mode: "live-demos" as const,
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer" as const,
      authority: BUYER,
    };
    const first = await open(databasePath, liveOptions);
    const initialCoordinator = createFixedPriceX402BuyerCoordinator({
      store: first.createLiveCoordinatorStore("buyer"),
      workerId: "buyer-worker-before-restart",
      operations: {
        agreement: finalCoordinatorOperation("agreement"),
        payment: finalCoordinatorOperation("payment"),
        "payment-evidence": finalCoordinatorOperation("payment-evidence"),
        "buyer-received": finalCoordinatorOperation("buyer-received"),
        audit: finalCoordinatorOperation("audit"),
      },
    });

    expect((await initialCoordinator.startOrder(liveOrder())).milestone).toBe("created");
    expect((await initialCoordinator.runPending({ limit: 2 })).items.map(
      (item) => item.track,
    )).toEqual(["agreement", "payment"]);
    first.close();
    databases.splice(databases.indexOf(first), 1);

    const restarted = await open(databasePath, liveOptions);
    const resumedCoordinator = createFixedPriceX402BuyerCoordinator({
      store: restarted.createLiveCoordinatorStore("buyer"),
      workerId: "buyer-worker-after-restart",
      operations: {
        agreement: finalCoordinatorOperation("agreement"),
        payment: finalCoordinatorOperation("payment"),
        "payment-evidence": finalCoordinatorOperation("payment-evidence"),
        "buyer-received": finalCoordinatorOperation("buyer-received"),
        audit: finalCoordinatorOperation("audit"),
      },
    });
    expect((await resumedCoordinator.resumePendingOrders({ limit: 10 })).items.map(
      (item) => item.track,
    )).toEqual(["payment-evidence", "buyer-received", "audit"]);
    expect((await resumedCoordinator.getOrderStatus(JOB_ID))?.milestone)
      .toBe("actor-audit-final");
  });

  it("filters and limits runnable orders from integrity-checked track projections", async () => {
    const databasePath = join(temporaryRoot(), "buyer.sqlite");
    const database = await open(databasePath, {
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      authority: BUYER,
    });
    const store = database.createLiveCoordinatorStore("buyer");
    for (const jobId of [JOB_ID, OTHER_JOB_ID, THIRD_JOB_ID]) {
      const order = liveOrder(jobId);
      expect(await store.create({
        role: "buyer",
        order,
        ...liveOrderBinding(order),
      })).toMatchObject({ status: "created" });
    }
    for (const jobId of [OTHER_JOB_ID, THIRD_JOB_ID]) {
      const order = liveOrder(jobId);
      const { bindingHash, localBindingHash } = liveOrderBinding(order);
      const claim = await store.claim({
        role: "buyer",
        jobId,
        bindingHash,
        localBindingHash,
        track: "agreement",
        owner: `worker:${jobId}`,
        leaseDurationMs: 10_000,
      });
      expect(claim).toMatchObject({ status: "acquired" });
      if (claim.status !== "acquired") throw new Error("expected agreement claim");
      expect(await store.record({
        role: "buyer",
        jobId,
        bindingHash,
        localBindingHash,
        track: "agreement",
        lease: claim.lease,
        result: { status: "final", outcome: "success", reference: `agreement:${jobId}` },
      })).toMatchObject({ status: "recorded" });
    }

    const first = await store.listRunnable({
      role: "buyer",
      tracks: ["payment"],
      limit: 1,
    });
    expect(first.items.map((item) => item.jobId)).toEqual([OTHER_JOB_ID]);
    expect(first.nextCursor).toBe(OTHER_JOB_ID);
    const second = await store.listRunnable({
      role: "buyer",
      tracks: ["payment"],
      cursor: first.nextCursor,
      limit: 1,
    });
    expect(second.items.map((item) => item.jobId)).toEqual([THIRD_JOB_ID]);
    expect(second.nextCursor).toBeUndefined();
    await expect(store.listRunnable({
      role: "buyer",
      tracks: ["payment"],
      limit: DACS_NODE_SQLITE_MAX_PAGE_SIZE + 1,
    })).rejects.toMatchObject({ reasonCode: "coordinator-query-malformed" });

    const raw = new BetterSqlite3(databasePath);
    raw.prepare(`
      UPDATE dacs_coordinator_tracks SET eligible = 0
      WHERE profile = 'live-x402' AND role = 'buyer' AND job_id = ?
        AND track = 'payment'
    `).run(OTHER_JOB_ID);
    raw.close();
    await expect(store.listRunnable({
      role: "buyer",
      tracks: ["payment"],
      limit: 1,
    })).resolves.toMatchObject({ items: [{ jobId: THIRD_JOB_ID }] });
    expect(await store.load("buyer", OTHER_JOB_ID)).toMatchObject({
      status: "corrupt",
      reason: expect.stringContaining("track projection"),
    });
    const selectedRaw = new BetterSqlite3(databasePath);
    selectedRaw.prepare(`
      UPDATE dacs_coordinator_tracks SET generation = 1, attempts = 1
      WHERE profile = 'live-x402' AND role = 'buyer' AND job_id = ?
        AND track = 'payment'
    `).run(THIRD_JOB_ID);
    selectedRaw.close();
    await expect(store.listRunnable({
      role: "buyer",
      tracks: ["payment"],
      limit: 1,
    })).rejects.toMatchObject({ reasonCode: "coordinator-record-corrupt" });
  });

  it("loads each coordinator record and projection from one SQLite snapshot", async () => {
    const databasePath = join(temporaryRoot(), "buyer.sqlite");
    const liveOptions = {
      mode: "live-demos" as const,
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer" as const,
      authority: BUYER,
    };
    const first = await open(databasePath, liveOptions);
    const second = await open(databasePath, liveOptions);
    const firstStore = first.createLiveCoordinatorStore("buyer");
    const secondStore = second.createLiveCoordinatorStore("buyer");
    const order = liveOrder();
    const { bindingHash, localBindingHash } = liveOrderBinding(order);
    expect(await firstStore.create({ role: "buyer", order, bindingHash, localBindingHash }))
      .toMatchObject({ status: "created" });

    interface InstrumentedStatement {
      get(...parameters: unknown[]): unknown;
    }
    interface InstrumentedDatabase {
      prepare(source: string): InstrumentedStatement;
    }
    const internal = (first as unknown as { database: InstrumentedDatabase }).database;
    const retainedPrepare = internal.prepare.bind(internal);
    let writerPromise: Promise<unknown> | undefined;
    let intercepted = false;
    internal.prepare = (source) => {
      const statement = retainedPrepare(source);
      if (!intercepted && source.includes("SELECT * FROM dacs_coordinator_orders") &&
          source.includes("job_id = ?")) {
        const retainedGet = statement.get.bind(statement);
        statement.get = (...parameters) => {
          const row = retainedGet(...parameters);
          intercepted = true;
          writerPromise = secondStore.claim({
            role: "buyer",
            jobId: JOB_ID,
            bindingHash,
            localBindingHash,
            track: "agreement",
            owner: "concurrent-worker",
            leaseDurationMs: 10_000,
          });
          return row;
        };
      }
      return statement;
    };

    let loaded;
    try {
      loaded = await firstStore.load("buyer", JOB_ID);
    } finally {
      internal.prepare = retainedPrepare;
    }
    expect(intercepted).toBe(true);
    expect(loaded).toMatchObject({
      status: "ok",
      record: { tracks: { agreement: { state: "not-started" } } },
    });
    expect(await writerPromise).toMatchObject({ status: "acquired" });
    expect(await firstStore.load("buyer", JOB_ID)).toMatchObject({
      status: "ok",
      record: { tracks: { agreement: { state: "running" } } },
    });
  });

  it("lists runnable coordinator work from one SQLite snapshot", async () => {
    const databasePath = join(temporaryRoot(), "buyer.sqlite");
    const liveOptions = {
      mode: "live-demos" as const,
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer" as const,
      authority: BUYER,
    };
    const first = await open(databasePath, liveOptions);
    const second = await open(databasePath, liveOptions);
    const firstStore = first.createLiveCoordinatorStore("buyer");
    const secondStore = second.createLiveCoordinatorStore("buyer");
    const order = liveOrder();
    const { bindingHash, localBindingHash } = liveOrderBinding(order);
    expect(await firstStore.create({ role: "buyer", order, bindingHash, localBindingHash }))
      .toMatchObject({ status: "created" });

    interface InstrumentedStatement {
      get(...parameters: unknown[]): unknown;
    }
    interface InstrumentedDatabase {
      prepare(source: string): InstrumentedStatement;
    }
    const internal = (first as unknown as { database: InstrumentedDatabase }).database;
    const retainedPrepare = internal.prepare.bind(internal);
    let writerPromise: Promise<unknown> | undefined;
    let intercepted = false;
    internal.prepare = (source) => {
      const statement = retainedPrepare(source);
      if (!intercepted && source.includes("julianday('now')")) {
        const retainedGet = statement.get.bind(statement);
        statement.get = (...parameters) => {
          const row = retainedGet(...parameters);
          intercepted = true;
          writerPromise = secondStore.claim({
            role: "buyer",
            jobId: JOB_ID,
            bindingHash,
            localBindingHash,
            track: "agreement",
            owner: "concurrent-worker",
            leaseDurationMs: 10_000,
          });
          return row;
        };
      }
      return statement;
    };

    let listed;
    try {
      listed = await firstStore.listRunnable({
        role: "buyer",
        tracks: ["agreement"],
        limit: 1,
      });
    } finally {
      internal.prepare = retainedPrepare;
    }
    expect(intercepted).toBe(true);
    expect(listed).toMatchObject({
      items: [{ jobId: JOB_ID, tracks: { agreement: { state: "not-started" } } }],
    });
    expect(await writerPromise).toMatchObject({ status: "acquired" });
    expect(await firstStore.listRunnable({
      role: "buyer",
      tracks: ["agreement"],
      limit: 1,
    })).toEqual({ items: [] });
  });

  it("validates an effect row, reservation, and history from one SQLite snapshot", async () => {
    const databasePath = join(temporaryRoot(), "effect-snapshot.sqlite");
    const first = await open(databasePath);
    const second = await open(databasePath);
    const intent = {
      kind: "payment" as const,
      effectId: "payment:snapshot",
      bindingHash: BINDING_HASH,
      input: { amount: "1", asset: "USDC" },
      idempotencyKey: "payment:idempotency:snapshot",
      jobId: JOB_ID,
    };
    expect(first.putEffectIntent(intent)).toMatchObject({ status: "created" });

    interface InstrumentedStatement {
      get(...parameters: unknown[]): unknown;
    }
    interface InstrumentedDatabase {
      prepare(source: string): InstrumentedStatement;
    }
    const internal = (first as unknown as { database: InstrumentedDatabase }).database;
    const retainedPrepare = internal.prepare.bind(internal);
    let claim: ReturnType<DacsNodeSqliteDatabase["claimEffect"]> | undefined;
    let intercepted = false;
    internal.prepare = (source) => {
      const statement = retainedPrepare(source);
      if (!intercepted && source.includes("SELECT * FROM dacs_effects") &&
          source.includes("effect_kind = ?")) {
        const retainedGet = statement.get.bind(statement);
        statement.get = (...parameters) => {
          const row = retainedGet(...parameters);
          intercepted = true;
          claim = second.claimEffect({
            kind: intent.kind,
            effectId: intent.effectId,
            bindingHash: intent.bindingHash,
            owner: "concurrent-worker",
            leaseDurationMs: 10_000,
          });
          return row;
        };
      }
      return statement;
    };

    let loaded;
    try {
      loaded = first.loadEffect(intent.kind, intent.effectId);
    } finally {
      internal.prepare = retainedPrepare;
    }
    expect(intercepted).toBe(true);
    expect(claim).toMatchObject({ status: "acquired" });
    expect(loaded).toMatchObject({ state: "intent", generation: 0 });
    expect(first.loadEffect(intent.kind, intent.effectId)).toMatchObject({
      state: "active",
      generation: 1,
      lease: { owner: "concurrent-worker" },
    });
  });

  it("fences stale coordinator workers across SQLite connections", async () => {
    const databasePath = join(temporaryRoot(), "buyer.sqlite");
    const liveOptions = {
      mode: "live-demos" as const,
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer" as const,
      authority: BUYER,
    };
    const first = await open(databasePath, liveOptions);
    const second = await open(databasePath, liveOptions);
    const firstStore = first.createLiveCoordinatorStore("buyer");
    const secondStore = second.createLiveCoordinatorStore("buyer");
    const order = liveOrder();
    const { bindingHash, localBindingHash } = liveOrderBinding(order);
    expect(await firstStore.create({ role: "buyer", order, bindingHash, localBindingHash }))
      .toMatchObject({ status: "created" });
    const staleClaim = await firstStore.claim({
      role: "buyer",
      jobId: JOB_ID,
      bindingHash,
      localBindingHash,
      track: "agreement",
      owner: "worker-1",
      leaseDurationMs: 1,
    });
    expect(staleClaim).toMatchObject({ status: "acquired" });
    if (staleClaim.status !== "acquired") throw new Error("expected first claim");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    const currentClaim = await secondStore.claim({
      role: "buyer",
      jobId: JOB_ID,
      bindingHash,
      localBindingHash,
      track: "agreement",
      owner: "worker-2",
      leaseDurationMs: 10_000,
    });
    expect(currentClaim).toMatchObject({ status: "acquired" });
    if (currentClaim.status !== "acquired") throw new Error("expected replacement claim");

    expect(await firstStore.record({
      role: "buyer",
      jobId: JOB_ID,
      bindingHash,
      localBindingHash,
      track: "agreement",
      lease: staleClaim.lease,
      result: { status: "final", outcome: "success", reference: "stale" },
    })).toEqual({ status: "stale" });
    expect(await secondStore.record({
      role: "buyer",
      jobId: JOB_ID,
      bindingHash,
      localBindingHash,
      track: "agreement",
      lease: currentClaim.lease,
      result: { status: "final", outcome: "success", reference: "current" },
    })).toMatchObject({
      status: "recorded",
      record: { tracks: { agreement: { reference: "current" } } },
    });
  });

  it("fences every durable coordinator path with the exact role-local binding", async () => {
    const root = temporaryRoot();
    const databasePath = join(root, "buyer-local-binding.sqlite");
    const liveOptions = {
      mode: "live-demos" as const,
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer" as const,
      authority: BUYER,
    };
    const first = await open(databasePath, liveOptions);
    const store = first.createLiveCoordinatorStore("buyer");
    const order = liveOrder();
    const { bindingHash, localBindingHash } = liveOrderBinding(order);
    const swappedOrder = {
      ...order,
      sdkJobs: { ...order.sdkJobs, audit: "buyer:audit:swapped-local-binding" },
    };
    const swappedLocalBindingHash = fixedPriceX402OrderLocalBindingHash(swappedOrder);
    expect(swappedLocalBindingHash).not.toBe(localBindingHash);

    expect(await store.create({
      role: "buyer",
      order,
      bindingHash,
      localBindingHash: swappedLocalBindingHash,
    })).toEqual({ status: "conflict" });
    expect(await store.create({
      role: "buyer",
      order,
      bindingHash,
      localBindingHash,
    })).toMatchObject({
      status: "created",
      record: { localBindingHash },
    });
    expect(await store.claim({
      role: "buyer",
      jobId: JOB_ID,
      bindingHash,
      localBindingHash: swappedLocalBindingHash,
      track: "agreement",
      owner: "wrong-local-worker",
      leaseDurationMs: 10_000,
    })).toEqual({ status: "stale" });
    const claim = await store.claim({
      role: "buyer",
      jobId: JOB_ID,
      bindingHash,
      localBindingHash,
      track: "agreement",
      owner: "right-local-worker",
      leaseDurationMs: 10_000,
    });
    if (claim.status !== "acquired") throw new Error("expected local-binding claim");
    expect(await store.isCurrent({
      role: "buyer",
      jobId: JOB_ID,
      bindingHash,
      localBindingHash: swappedLocalBindingHash,
      track: "agreement",
      lease: claim.lease,
    })).toBe(false);
    expect(await store.isCurrent({
      role: "buyer",
      jobId: JOB_ID,
      bindingHash,
      localBindingHash,
      track: "agreement",
      lease: claim.lease,
    })).toBe(true);
    expect(await store.record({
      role: "buyer",
      jobId: JOB_ID,
      bindingHash,
      localBindingHash: swappedLocalBindingHash,
      track: "agreement",
      lease: claim.lease,
      result: { status: "operator-action", reasonCode: "wrong-local" },
    })).toEqual({ status: "stale" });
    expect(await store.requeue({
      role: "buyer",
      jobId: JOB_ID,
      bindingHash,
      localBindingHash: swappedLocalBindingHash,
      track: "agreement",
      operatorReasonCode: "wrong-local",
    })).toEqual({ status: "conflict" });
    expect(await store.record({
      role: "buyer",
      jobId: JOB_ID,
      bindingHash,
      localBindingHash,
      track: "agreement",
      lease: claim.lease,
      result: {
        status: "pending-retry",
        reasonCode: "retry-local-binding",
        retryAt: first.readTime(),
      },
    })).toMatchObject({ status: "recorded", record: { localBindingHash } });
    expect(await store.requeue({
      role: "buyer",
      jobId: JOB_ID,
      bindingHash,
      localBindingHash,
      track: "agreement",
      operatorReasonCode: "operator-requeue",
      retryAt: first.readTime(),
    })).toMatchObject({ status: "recorded", record: { localBindingHash } });
    first.close();
    databases.splice(databases.indexOf(first), 1);

    const restarted = await open(databasePath, liveOptions);
    expect(await restarted.createLiveCoordinatorStore("buyer").load("buyer", JOB_ID))
      .toMatchObject({ status: "ok", record: { localBindingHash } });
    const projection = new BetterSqlite3(databasePath, { readonly: true });
    expect(projection.prepare(`
      SELECT DISTINCT local_binding_hash FROM dacs_coordinator_tracks
      WHERE profile = 'live-x402' AND role = 'buyer' AND job_id = ?
    `).all(JOB_ID)).toEqual([{ local_binding_hash: localBindingHash }]);
    projection.close();
    restarted.close();
    databases.splice(databases.indexOf(restarted), 1);

    const raw = new BetterSqlite3(databasePath);
    const retained = raw.prepare(`
      SELECT record_json FROM dacs_coordinator_orders
      WHERE profile = 'live-x402' AND role = 'buyer' AND job_id = ?
    `).get(JOB_ID) as { record_json: string };
    const record = JSON.parse(retained.record_json) as Record<string, unknown>;
    record.localBindingHash = swappedLocalBindingHash;
    const recordJson = canonicalize(record);
    raw.prepare(`
      UPDATE dacs_coordinator_orders
      SET local_binding_hash = ?, record_hash = ?, record_json = ?
      WHERE profile = 'live-x402' AND role = 'buyer' AND job_id = ?
    `).run(swappedLocalBindingHash, sha256Hex(recordJson), recordJson, JOB_ID);
    raw.prepare(`
      UPDATE dacs_coordinator_tracks SET local_binding_hash = ?
      WHERE profile = 'live-x402' AND role = 'buyer' AND job_id = ?
    `).run(swappedLocalBindingHash, JOB_ID);
    raw.close();

    await expect(openDacsNodeSqliteDatabase(options(databasePath, liveOptions)))
      .rejects.toMatchObject({ reasonCode: "database-logical-corruption" });
  });

  it("keeps live and offline coordinator stores profile-isolated", async () => {
    const offline = await open(join(temporaryRoot(), "buyer.sqlite"), {
      authority: BUYER,
    });
    expect(() => offline.createLiveCoordinatorStore("buyer")).toThrowError(
      expect.objectContaining({ reasonCode: "coordinator-profile-mismatch" }),
    );
    expect(() => offline.createOfflineCoordinatorStore("seller")).toThrowError(
      expect.objectContaining({ reasonCode: "coordinator-role-mismatch" }),
    );
    const store = offline.createOfflineCoordinatorStore("buyer");
    const order = offlineOrder();
    const { bindingHash, localBindingHash } = offlineOrderBinding(order);
    expect(await store.create({ role: "buyer", order, bindingHash, localBindingHash }))
      .toMatchObject({ status: "created", record: { protocol: OFFLINE_PROTOCOL } });
    expect(await store.load("buyer", JOB_ID))
      .toMatchObject({ status: "ok", record: { bindingHash } });
  });

  it("enforces live DACS-5 terminal attribution and irreversible-effect rules", async () => {
    const databasePath = join(temporaryRoot(), "buyer-live-terminal.sqlite");
    const database = await open(databasePath, {
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      authority: BUYER,
    });
    const store = database.createLiveCoordinatorStore("buyer");

    const failedOrder = liveOrder(JOB_ID);
    const failedBinding = liveOrderBinding(failedOrder);
    await store.create({ role: "buyer", order: failedOrder, ...failedBinding });
    const failedClaim = await store.claim({
      role: "buyer",
      jobId: JOB_ID,
      ...failedBinding,
      track: "agreement",
      owner: "live-failure-worker",
      leaseDurationMs: 10_000,
    });
    if (failedClaim.status !== "acquired") throw new Error("expected failure claim");
    expect(await store.record({
      role: "buyer",
      jobId: JOB_ID,
      ...failedBinding,
      track: "agreement",
      lease: failedClaim.lease,
      result: {
        status: "final",
        outcome: "failure",
        errorClass: "counterparty",
        reference: "missing-fault-attribution",
      } as never,
    })).toEqual({ status: "conflict" });
    expect(await store.record({
      role: "buyer",
      jobId: JOB_ID,
      ...failedBinding,
      track: "agreement",
      lease: failedClaim.lease,
      result: {
        status: "final",
        outcome: "failure",
        errorClass: "counterparty",
        faultedParty: "none",
        reference: "non-neutral-counterparty-failure",
      },
    })).toEqual({ status: "conflict" });
    expect(await store.record({
      role: "buyer",
      jobId: JOB_ID,
      ...failedBinding,
      track: "agreement",
      lease: failedClaim.lease,
      result: {
        status: "final",
        outcome: "failure",
        errorClass: "counterparty",
        faultedParty: "seller",
        reference: "seller-fault",
      },
    })).toMatchObject({ status: "recorded" });
    const failedAudit = await store.claim({
      role: "buyer",
      jobId: JOB_ID,
      ...failedBinding,
      track: "audit",
      owner: "live-failure-audit-worker",
      leaseDurationMs: 10_000,
    });
    if (failedAudit.status !== "acquired") throw new Error("expected failure audit claim");
    expect(await store.record({
      role: "buyer",
      jobId: JOB_ID,
      ...failedBinding,
      track: "audit",
      lease: failedAudit.lease,
      result: {
        status: "final",
        outcome: "failure",
        errorClass: "counterparty",
        faultedParty: "buyer",
        reference: "mismatched-fault",
      },
    })).toEqual({ status: "conflict" });
    expect(await store.record({
      role: "buyer",
      jobId: JOB_ID,
      ...failedBinding,
      track: "audit",
      lease: failedAudit.lease,
      result: {
        status: "final",
        outcome: "failure",
        errorClass: "counterparty",
        faultedParty: "seller",
        reference: "matching-fault",
      },
    })).toMatchObject({ status: "recorded" });

    const abortedOrder = liveOrder(OTHER_JOB_ID);
    const abortedBinding = liveOrderBinding(abortedOrder);
    await store.create({ role: "buyer", order: abortedOrder, ...abortedBinding });
    const abortedClaim = await store.claim({
      role: "buyer",
      jobId: OTHER_JOB_ID,
      ...abortedBinding,
      track: "agreement",
      owner: "live-abort-worker",
      leaseDurationMs: 10_000,
    });
    if (abortedClaim.status !== "acquired") throw new Error("expected abort claim");
    expect(await store.record({
      role: "buyer",
      jobId: OTHER_JOB_ID,
      ...abortedBinding,
      track: "agreement",
      lease: abortedClaim.lease,
      result: {
        status: "final",
        outcome: "aborted",
        reference: "missing-withdrawal-attribution",
      } as never,
    })).toEqual({ status: "conflict" });
    expect(await store.record({
      role: "buyer",
      jobId: OTHER_JOB_ID,
      ...abortedBinding,
      track: "agreement",
      lease: abortedClaim.lease,
      result: {
        status: "final",
        outcome: "aborted",
        withdrawnBy: "buyer",
        reference: "buyer-withdrew",
      },
    })).toMatchObject({ status: "recorded" });

    const substrateOrder = liveOrder(THIRD_JOB_ID);
    const substrateBinding = liveOrderBinding(substrateOrder);
    await store.create({ role: "buyer", order: substrateOrder, ...substrateBinding });
    const substrateClaim = await store.claim({
      role: "buyer",
      jobId: THIRD_JOB_ID,
      ...substrateBinding,
      track: "agreement",
      owner: "live-substrate-worker",
      leaseDurationMs: 10_000,
    });
    if (substrateClaim.status !== "acquired") throw new Error("expected substrate claim");
    expect(await store.record({
      role: "buyer",
      jobId: THIRD_JOB_ID,
      ...substrateBinding,
      track: "agreement",
      lease: substrateClaim.lease,
      result: {
        status: "final",
        outcome: "failure",
        errorClass: "substrate",
        faultedParty: "seller",
        reference: "incorrect-substrate-attribution",
      },
    })).toEqual({ status: "conflict" });
    expect(await store.record({
      role: "buyer",
      jobId: THIRD_JOB_ID,
      ...substrateBinding,
      track: "agreement",
      lease: substrateClaim.lease,
      result: {
        status: "final",
        outcome: "failure",
        errorClass: "substrate",
        faultedParty: "none",
        reference: "neutral-substrate-failure",
      },
    })).toMatchObject({ status: "recorded" });

    const irreversibleJob = "01J8N4YV7YVYQ4DB7M8T4C7W0D";
    const irreversibleOrder = liveOrder(irreversibleJob);
    const irreversibleBinding = liveOrderBinding(irreversibleOrder);
    await store.create({ role: "buyer", order: irreversibleOrder, ...irreversibleBinding });
    for (const track of ["agreement", "payment"] as const) {
      const claim = await store.claim({
        role: "buyer",
        jobId: irreversibleJob,
        ...irreversibleBinding,
        track,
        owner: `irreversible-${track}`,
        leaseDurationMs: 10_000,
      });
      if (claim.status !== "acquired") throw new Error(`expected ${track} claim`);
      expect(await store.record({
        role: "buyer",
        jobId: irreversibleJob,
        ...irreversibleBinding,
        track,
        lease: claim.lease,
        result: { status: "final", outcome: "success", reference: `${track}:final` },
      })).toMatchObject({ status: "recorded" });
    }
    const receivedClaim = await store.claim({
      role: "buyer",
      jobId: irreversibleJob,
      ...irreversibleBinding,
      track: "buyer-received",
      owner: "irreversible-received",
      leaseDurationMs: 10_000,
    });
    if (receivedClaim.status !== "acquired") throw new Error("expected received claim");
    expect(await store.record({
      role: "buyer",
      jobId: irreversibleJob,
      ...irreversibleBinding,
      track: "buyer-received",
      lease: receivedClaim.lease,
      result: {
        status: "final",
        outcome: "aborted",
        withdrawnBy: "buyer",
        reference: "late-abort",
      },
    })).toEqual({ status: "conflict" });

    const raw = new BetterSqlite3(databasePath, { readonly: true });
    expect(raw.prepare(`
      SELECT outcome, error_class, faulted_party, withdrawn_by
      FROM dacs_coordinator_tracks
      WHERE profile = 'live-x402' AND role = 'buyer' AND job_id = ?
        AND track = 'agreement'
    `).get(JOB_ID)).toEqual({
      outcome: "failure",
      error_class: "counterparty",
      faulted_party: "seller",
      withdrawn_by: null,
    });
    expect(raw.prepare(`
      SELECT outcome, error_class, faulted_party, withdrawn_by
      FROM dacs_coordinator_tracks
      WHERE profile = 'live-x402' AND role = 'buyer' AND job_id = ?
        AND track = 'agreement'
    `).get(OTHER_JOB_ID)).toEqual({
      outcome: "aborted",
      error_class: null,
      faulted_party: null,
      withdrawn_by: "buyer",
    });
    raw.close();
  });

  it("persists only simulation terminal outcomes in the offline profile", async () => {
    const databasePath = join(temporaryRoot(), "offline-terminal.sqlite");
    const first = await open(databasePath, { authority: BUYER });
    const store = first.createOfflineCoordinatorStore("buyer");
    const cases = [
      {
        jobId: JOB_ID,
        result: {
          status: "final" as const,
          outcome: "simulated-success" as const,
          reference: "offline:success",
        },
      },
      {
        jobId: OTHER_JOB_ID,
        result: {
          status: "final" as const,
          outcome: "simulated-failure" as const,
          errorClass: "simulated-counterparty" as const,
          reference: "offline:failure",
        },
      },
      {
        jobId: THIRD_JOB_ID,
        result: {
          status: "final" as const,
          outcome: "simulated-aborted" as const,
          reference: "offline:aborted",
        },
      },
    ];
    for (const entry of cases) {
      const order = offlineOrder(entry.jobId);
      const binding = offlineOrderBinding(order);
      await store.create({ role: "buyer", order, ...binding });
      const claim = await store.claim({
        role: "buyer",
        jobId: entry.jobId,
        ...binding,
        track: "agreement",
        owner: `offline-${entry.jobId}`,
        leaseDurationMs: 10_000,
      });
      if (claim.status !== "acquired") throw new Error("expected offline claim");
      if (entry.jobId === JOB_ID) {
        expect(await store.record({
          role: "buyer",
          jobId: entry.jobId,
          ...binding,
          track: "agreement",
          lease: claim.lease,
          result: {
            status: "final",
            outcome: "success",
            reference: "normative-value-in-simulation",
          } as never,
        })).toEqual({ status: "conflict" });
      }
      expect(await store.record({
        role: "buyer",
        jobId: entry.jobId,
        ...binding,
        track: "agreement",
        lease: claim.lease,
        result: entry.result,
      })).toMatchObject({ status: "recorded" });
    }

    const failureOrder = offlineOrder(OTHER_JOB_ID);
    const failureBinding = offlineOrderBinding(failureOrder);
    const auditClaim = await store.claim({
      role: "buyer",
      jobId: OTHER_JOB_ID,
      ...failureBinding,
      track: "audit",
      owner: "offline-failure-audit",
      leaseDurationMs: 10_000,
    });
    if (auditClaim.status !== "acquired") throw new Error("expected offline audit claim");
    expect(await store.record({
      role: "buyer",
      jobId: OTHER_JOB_ID,
      ...failureBinding,
      track: "audit",
      lease: auditClaim.lease,
      result: {
        status: "final",
        outcome: "simulated-failure",
        errorClass: "simulated-substrate",
        reference: "offline:mismatched-audit",
      },
    })).toEqual({ status: "conflict" });
    expect(await store.record({
      role: "buyer",
      jobId: OTHER_JOB_ID,
      ...failureBinding,
      track: "audit",
      lease: auditClaim.lease,
      result: {
        status: "final",
        outcome: "simulated-failure",
        errorClass: "simulated-counterparty",
        reference: "offline:matching-audit",
      },
    })).toMatchObject({ status: "recorded" });
    first.close();
    databases.splice(databases.indexOf(first), 1);

    const restarted = await open(databasePath, { authority: BUYER });
    const restartedStore = restarted.createOfflineCoordinatorStore("buyer");
    for (const entry of cases) {
      expect(await restartedStore.load("buyer", entry.jobId)).toMatchObject({
        status: "ok",
        record: { tracks: { agreement: { outcome: entry.result.outcome } } },
      });
    }
    const raw = new BetterSqlite3(databasePath, { readonly: true });
    expect(raw.prepare(`
      SELECT job_id, outcome, error_class, faulted_party, withdrawn_by
      FROM dacs_coordinator_tracks
      WHERE profile = 'offline' AND role = 'buyer' AND track = 'agreement'
        AND outcome IS NOT NULL
      ORDER BY job_id
    `).all()).toEqual([
      {
        job_id: JOB_ID,
        outcome: "simulated-success",
        error_class: null,
        faulted_party: null,
        withdrawn_by: null,
      },
      {
        job_id: OTHER_JOB_ID,
        outcome: "simulated-failure",
        error_class: "simulated-counterparty",
        faulted_party: null,
        withdrawn_by: null,
      },
      {
        job_id: THIRD_JOB_ID,
        outcome: "simulated-aborted",
        error_class: null,
        faulted_party: null,
        withdrawn_by: null,
      },
    ]);
    raw.close();
  });

  it("binds buyer and seller coordinator orders to their exact database authority", async () => {
    const root = temporaryRoot();
    const buyerDatabase = await open(join(root, "buyer.sqlite"), {
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      authority: BUYER,
    });
    const buyerStore = buyerDatabase.createLiveCoordinatorStore("buyer");
    const buyerOrder = liveOrder();
    expect(await buyerStore.create({
      role: "buyer",
      order: buyerOrder,
      ...liveOrderBinding(buyerOrder),
    })).toMatchObject({ status: "created", record: { buyer: BUYER } });
    const wrongBuyer = { ...liveOrder(OTHER_JOB_ID), buyer: "did:example:other-buyer" };
    expect(await buyerStore.create({
      role: "buyer",
      order: wrongBuyer,
      ...liveOrderBinding(wrongBuyer),
    })).toMatchObject({
      status: "corrupt",
      reason: expect.stringContaining("database actor authority"),
    });

    const sellerDatabase = await open(join(root, "seller.sqlite"), {
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "seller",
      authority: SELLER,
    });
    const sellerStore = sellerDatabase.createLiveCoordinatorStore("seller");
    const sellerOrder = liveSellerOrder();
    expect(await sellerStore.create({
      role: "seller",
      order: sellerOrder,
      ...liveOrderBinding(sellerOrder),
    })).toMatchObject({ status: "created", record: { seller: SELLER } });
    const otherSeller = "did:example:other-seller";
    const wrongSeller = {
      ...liveSellerOrder(OTHER_JOB_ID),
      seller: otherSeller,
      protocol: { ...LIVE_PROTOCOL, orchestrator: otherSeller },
    };
    expect(await sellerStore.create({
      role: "seller",
      order: wrongSeller,
      ...liveOrderBinding(wrongSeller),
    })).toMatchObject({
      status: "corrupt",
      reason: expect.stringContaining("database actor authority"),
    });
  });

  it("rejects recomputed coordinator hashes that move buyer or seller ownership", async () => {
    const root = temporaryRoot();
    for (const role of ["buyer", "seller"] as const) {
      const databasePath = join(root, `${role}.sqlite`);
      const authority = role === "buyer" ? BUYER : SELLER;
      const database = await open(databasePath, {
        mode: "live-demos",
        profile: DACS_NODE_LIVE_PROFILE,
        role,
        authority,
      });
      const store = database.createLiveCoordinatorStore(role);
      const order = role === "buyer" ? liveOrder() : liveSellerOrder();
      expect(await store.create({
        role,
        order,
        ...liveOrderBinding(order),
      })).toMatchObject({ status: "created" });
      database.close();
      databases.splice(databases.indexOf(database), 1);

      const raw = new BetterSqlite3(databasePath);
      const retained = raw.prepare(`
        SELECT record_json FROM dacs_coordinator_orders
        WHERE profile = 'live-x402' AND role = ? AND job_id = ?
      `).get(role, JOB_ID) as { record_json: string };
      const record = JSON.parse(retained.record_json) as FixedPriceX402OrderInput & {
        bindingHash: string;
      };
      if (role === "buyer") {
        record.buyer = "did:example:rebound-buyer";
      } else {
        record.seller = "did:example:rebound-seller";
        record.protocol = { ...record.protocol, orchestrator: record.seller };
      }
      record.bindingHash = fixedPriceX402OrderBindingHash({
        jobId: record.jobId,
        buyer: record.buyer,
        seller: record.seller,
        protocol: record.protocol,
      });
      const recordJson = canonicalize(record);
      raw.prepare(`
        UPDATE dacs_coordinator_orders
        SET binding_hash = ?, record_hash = ?, record_json = ?
        WHERE profile = 'live-x402' AND role = ? AND job_id = ?
      `).run(record.bindingHash, sha256Hex(recordJson), recordJson, role, JOB_ID);
      raw.close();

      await expect(openDacsNodeSqliteDatabase(options(databasePath, {
        mode: "live-demos",
        profile: DACS_NODE_LIVE_PROFILE,
        role,
        authority,
      }))).rejects.toMatchObject({ reasonCode: "database-logical-corruption" });
    }
  });

  it("fails closed when persisted coordinator JSON loses its integrity binding", async () => {
    const databasePath = join(temporaryRoot(), "buyer.sqlite");
    const database = await open(databasePath, {
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      authority: BUYER,
    });
    const store = database.createLiveCoordinatorStore("buyer");
    const order = liveOrder();
    const { bindingHash, localBindingHash } = liveOrderBinding(order);
    await store.create({ role: "buyer", order, bindingHash, localBindingHash });

    const raw = new BetterSqlite3(databasePath);
    raw.prepare(`
      UPDATE dacs_coordinator_orders SET record_json = ?
      WHERE profile = 'live-x402' AND role = 'buyer' AND job_id = ?
    `).run("{}", JOB_ID);
    raw.close();
    expect(await store.load("buyer", JOB_ID)).toMatchObject({ status: "corrupt" });
  });

  it("blocks non-filesystem, symlinked, and consumer-sync locations", () => {
    const root = temporaryRoot();
    expect(inspectDacsNodeSqliteLocation(":memory:")).toMatchObject({
      status: "blocked",
      reasonCode: "database-path-not-filesystem",
    });
    for (const uncPath of ["\\\\server\\share\\buyer.sqlite", "//server/share/buyer.sqlite"]) {
      expect(inspectDacsNodeSqliteLocation(uncPath)).toMatchObject({
        status: "blocked",
        databasePath: uncPath,
        reasonCode: "database-path-not-filesystem",
      });
    }
    expect(inspectDacsNodeSqliteLocation(join(root, "Dropbox", "buyer.sqlite")))
      .toMatchObject({
        status: "blocked",
        reasonCode: "consumer-sync-directory",
      });

    const target = join(root, "target.sqlite");
    const link = join(root, "buyer.sqlite");
    writeFileSync(target, "");
    symlinkSync(target, link);
    expect(inspectDacsNodeSqliteLocation(link)).toMatchObject({
      status: "blocked",
      reasonCode: "database-path-symlink",
    });
  });

  it("rejects unsafe pre-existing POSIX write permissions without repair", async () => {
    if (process.platform === "win32" || typeof process.getuid !== "function") return;
    const root = temporaryRoot();
    const databasePath = join(root, "buyer.sqlite");
    writeFileSync(databasePath, "");
    chmodSync(databasePath, 0o622);

    expect(inspectDacsNodeSqliteLocation(databasePath)).toMatchObject({
      status: "blocked",
      reasonCode: "database-path-permissions-unsafe",
    });
    await expect(openDacsNodeSqliteDatabase(options(databasePath))).rejects.toMatchObject({
      reasonCode: "database-path-permissions-unsafe",
    });
    expect(statSync(databasePath).mode & 0o777).toBe(0o622);

    chmodSync(databasePath, 0o600);
    chmodSync(root, 0o722);
    expect(inspectDacsNodeSqliteLocation(databasePath)).toMatchObject({
      status: "blocked",
      reasonCode: "database-directory-permissions-unsafe",
    });
    await expect(openDacsNodeSqliteDatabase(options(databasePath))).rejects.toMatchObject({
      reasonCode: "database-directory-permissions-unsafe",
    });
    expect(statSync(root).mode & 0o777).toBe(0o722);
  });

  it("atomically reserves identities and detects cross-connection conflicts", async () => {
    const databasePath = join(temporaryRoot(), "buyer.sqlite");
    const first = await open(databasePath);
    const second = await open(databasePath);
    const reservation = {
      kind: "message" as const,
      identity: "message-1",
      bindingHash: BINDING_HASH,
      payloadHash: OTHER_BINDING_HASH,
      jobId: JOB_ID,
    };

    expect(first.reserveIdentity(reservation)).toMatchObject({ status: "created" });
    expect(second.reserveIdentity(reservation)).toMatchObject({ status: "existing" });
    expect(second.reserveIdentity({ ...reservation, payloadHash: BINDING_HASH }))
      .toEqual({ status: "conflict" });
    expect(first.loadReservation("message", "message-1")).toMatchObject(reservation);
  });

  it("retains one effect identity and result across restart", async () => {
    const databasePath = join(temporaryRoot(), "buyer.sqlite");
    const database = await open(databasePath);
    const intent = {
      kind: "payment" as const,
      effectId: "payment-effect-1",
      bindingHash: BINDING_HASH,
      input: { amount: "1.00", asset: "USDC" },
      idempotencyKey: "payment:idempotency:1",
      jobId: JOB_ID,
    };

    expect(database.putEffectIntent(intent)).toMatchObject({ status: "created" });
    expect(database.putEffectIntent(intent)).toMatchObject({ status: "existing" });
    expect(database.putEffectIntent({ ...intent, input: { amount: "2.00", asset: "USDC" } }))
      .toEqual({ status: "conflict" });
    expect(database.putEffectIntent({ ...intent, jobId: OTHER_JOB_ID }))
      .toEqual({ status: "conflict" });
    expect(database.putEffectIntent({
      ...intent,
      effectId: "payment-effect-2",
    })).toEqual({ status: "conflict" });

    const claim = database.claimEffect({
      kind: "payment",
      effectId: intent.effectId,
      bindingHash: BINDING_HASH,
      owner: "buyer-worker-1",
      leaseDurationMs: 10_000,
    });
    expect(claim).toMatchObject({
      status: "acquired",
      mode: "perform",
      record: { idempotencyKey: intent.idempotencyKey },
    });
    if (claim.status !== "acquired") throw new Error("expected effect claim");
    const completedInput = {
      kind: "payment",
      effectId: intent.effectId,
      bindingHash: BINDING_HASH,
      lease: claim.lease,
      result: { providerReceipt: "receipt-1", status: "confirmed" },
    } as const;
    expect(database.recordEffectCompleted(completedInput))
      .toMatchObject({ status: "recorded", record: { state: "completed" } });
    expect(database.recordEffectCompleted(completedInput))
      .toMatchObject({ status: "existing", record: { state: "completed" } });
    expect(database.recordEffectCompleted({
      ...completedInput,
      result: { providerReceipt: "receipt-conflict", status: "confirmed" },
    })).toEqual({ status: "conflict" });

    database.close();
    databases.splice(databases.indexOf(database), 1);
    const reopened = await open(databasePath);
    const retained = reopened.loadEffect("payment", intent.effectId);
    expect(retained).toMatchObject({
      state: "completed",
      idempotencyKey: intent.idempotencyKey,
      result: { providerReceipt: "receipt-1", status: "confirmed" },
    });
    expect(reopened.claimEffect({
      kind: "payment",
      effectId: intent.effectId,
      bindingHash: BINDING_HASH,
      owner: "buyer-worker-2",
      leaseDurationMs: 1_000,
    })).toMatchObject({ status: "completed" });
  });

  it("forces an expired perform lease through reconciliation before any repeat", async () => {
    const databasePath = join(temporaryRoot(), "buyer.sqlite");
    const database = await open(databasePath);
    database.putEffectIntent({
      kind: "fulfilment",
      effectId: "fulfilment-effect-1",
      bindingHash: BINDING_HASH,
      input: { requestHash: OTHER_BINDING_HASH },
      idempotencyKey: "fulfilment:idempotency:1",
    });
    const initial = database.claimEffect({
      kind: "fulfilment",
      effectId: "fulfilment-effect-1",
      bindingHash: BINDING_HASH,
      owner: "seller-worker-1",
      leaseDurationMs: 1,
    });
    expect(initial).toMatchObject({ status: "acquired", mode: "perform" });
    database.close();
    databases.splice(databases.indexOf(database), 1);

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    const restarted = await open(databasePath);
    const reconcile = restarted.claimEffect({
      kind: "fulfilment",
      effectId: "fulfilment-effect-1",
      bindingHash: BINDING_HASH,
      owner: "seller-worker-2",
      leaseDurationMs: 10_000,
    });
    expect(reconcile).toMatchObject({
      status: "acquired",
      mode: "reconcile",
      record: { idempotencyKey: "fulfilment:idempotency:1" },
    });
    if (reconcile.status !== "acquired" || reconcile.mode !== "reconcile") {
      throw new Error("expected reconciliation claim");
    }

    expect(restarted.recordEffectReconciliation({
      kind: "fulfilment",
      effectId: "fulfilment-effect-1",
      bindingHash: BINDING_HASH,
      lease: reconcile.lease as typeof reconcile.lease & { mode: "reconcile" },
      result: { disposition: "indeterminate", reasonCode: "provider-unknown" },
    })).toMatchObject({
      status: "recorded",
      record: { state: "reconciliation-required" },
    });

    const stillReconcile = restarted.claimEffect({
      kind: "fulfilment",
      effectId: "fulfilment-effect-1",
      bindingHash: BINDING_HASH,
      owner: "seller-worker-3",
      leaseDurationMs: 10_000,
    });
    expect(stillReconcile).toMatchObject({ status: "acquired", mode: "reconcile" });
    if (stillReconcile.status !== "acquired" || stillReconcile.mode !== "reconcile") {
      throw new Error("expected second reconciliation claim");
    }
    expect(restarted.recordEffectReconciliation({
      kind: "fulfilment",
      effectId: "fulfilment-effect-1",
      bindingHash: BINDING_HASH,
      lease: stillReconcile.lease as typeof stillReconcile.lease & { mode: "reconcile" },
      result: { disposition: "absent", absenceProofHash: ABSENCE_PROOF_HASH },
    })).toMatchObject({ status: "recorded", record: { state: "intent" } });

    expect(restarted.claimEffect({
      kind: "fulfilment",
      effectId: "fulfilment-effect-1",
      bindingHash: BINDING_HASH,
      owner: "seller-worker-4",
      leaseDurationMs: 10_000,
    })).toMatchObject({
      status: "acquired",
      mode: "perform",
      record: {
        idempotencyKey: "fulfilment:idempotency:1",
        absenceProofHash: ABSENCE_PROOF_HASH,
      },
    });
  });

  it("fences stale generations and makes operator action terminally non-runnable", async () => {
    const database = await open(join(temporaryRoot(), "seller.sqlite"), {
      role: "seller",
      authority: "claim:seller:primary",
    });
    database.putEffectIntent({
      kind: "artifact-publication",
      effectId: "publication-1",
      bindingHash: BINDING_HASH,
      input: { contentHash: OTHER_BINDING_HASH },
      idempotencyKey: "publication:idempotency:1",
    });
    const claim = database.claimEffect({
      kind: "artifact-publication",
      effectId: "publication-1",
      bindingHash: BINDING_HASH,
      owner: "seller-worker",
      leaseDurationMs: 10_000,
    });
    if (claim.status !== "acquired") throw new Error("expected effect claim");

    expect(database.recordEffectAmbiguous({
      kind: "artifact-publication",
      effectId: "publication-1",
      bindingHash: OTHER_BINDING_HASH,
      lease: claim.lease,
      reasonCode: "submission-unknown",
    })).toEqual({ status: "stale" });
    expect(database.requireEffectOperatorAction({
      kind: "artifact-publication",
      effectId: "publication-1",
      bindingHash: BINDING_HASH,
      lease: claim.lease,
      reasonCode: "manual-reconciliation-required",
    })).toMatchObject({
      status: "recorded",
      record: { state: "operator-action" },
    });
    expect(database.isCurrentEffect({
      kind: "artifact-publication",
      effectId: "publication-1",
      bindingHash: BINDING_HASH,
      lease: claim.lease,
    })).toBe(false);
    expect(database.claimEffect({
      kind: "artifact-publication",
      effectId: "publication-1",
      bindingHash: BINDING_HASH,
      owner: "seller-worker-2",
      leaseDurationMs: 10_000,
    })).toMatchObject({ status: "not-runnable" });
  });

  it("does not expose mutable retained results and rejects use after close", async () => {
    const database = await open(join(temporaryRoot(), "buyer.sqlite"));
    database.putEffectIntent({
      kind: "payment",
      effectId: "payment-effect-1",
      bindingHash: BINDING_HASH,
      input: { amount: "1" },
      idempotencyKey: "payment:idempotency:1",
    });
    const claim = database.claimEffect({
      kind: "payment",
      effectId: "payment-effect-1",
      bindingHash: BINDING_HASH,
      owner: "buyer-worker",
      leaseDurationMs: 10_000,
    });
    if (claim.status !== "acquired") throw new Error("expected effect claim");
    database.recordEffectCompleted({
      kind: "payment",
      effectId: "payment-effect-1",
      bindingHash: BINDING_HASH,
      lease: claim.lease,
      result: { receipt: { reference: "receipt-1" } },
    });

    const loaded = database.loadEffect("payment", "payment-effect-1")!;
    const loadedInput = database.loadEffectInput("payment", "payment-effect-1") as {
      amount: string;
    };
    loadedInput.amount = "mutated";
    expect(database.loadEffectInput("payment", "payment-effect-1")).toEqual({
      amount: "1",
    });
    (loaded.result as { receipt: { reference: string } }).receipt.reference = "mutated";
    expect(database.loadEffect("payment", "payment-effect-1")?.result).toEqual({
      receipt: { reference: "receipt-1" },
    });

    database.close();
    expect(() => database.readTime()).toThrow(DacsNodeSqliteError);
  });

  it("creates parent directories without accepting a symlink database target", async () => {
    const root = temporaryRoot();
    const nested = join(root, "one", "two");
    mkdirSync(nested, { recursive: true });
    const target = join(root, "target.sqlite");
    writeFileSync(target, "");
    const link = join(nested, "buyer.sqlite");
    symlinkSync(target, link);

    await expect(openDacsNodeSqliteDatabase(options(link))).rejects.toMatchObject({
      reasonCode: "database-path-symlink",
    });
  });
});

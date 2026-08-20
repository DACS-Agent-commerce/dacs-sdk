import {
  mkdirSync,
  mkdtempSync,
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
  createFixedPriceX402BuyerCoordinator,
  FIXED_PRICE_OFFLINE_COMMERCE_PROFILE,
  FIXED_PRICE_OFFLINE_STANDARD_REVISION,
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  fixedPriceOfflineOrderBindingHash,
  fixedPriceX402OrderBindingHash,
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
  DACS_NODE_SQLITE_SCHEMA_VERSION,
  DacsNodeSqliteError,
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

function liveOrder(): FixedPriceX402OrderInput {
  return {
    jobId: JOB_ID,
    buyer: BUYER,
    seller: SELLER,
    protocol: LIVE_PROTOCOL,
    sdkJobs: {
      role: "buyer",
      agreement: `buyer:agreement:${JOB_ID}`,
      payment: `buyer:payment:${JOB_ID}`,
      paymentEvidence: `buyer:payment-evidence:${JOB_ID}`,
      buyerReceived: `buyer:received:${JOB_ID}`,
      audit: `buyer:audit:${JOB_ID}`,
    },
  };
}

function offlineOrder(): FixedPriceOfflineOrderInput {
  return {
    ...liveOrder(),
    protocol: OFFLINE_PROTOCOL,
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
      sdkVersion: "0.1.0-alpha.0",
      standardRevision: "standard-test-revision",
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

  it("backs up and atomically advances an older supported schema", async () => {
    const root = temporaryRoot();
    const databasePath = join(root, "buyer.sqlite");
    const current = await open(databasePath);
    current.close();
    databases.splice(databases.indexOf(current), 1);

    const old = new BetterSqlite3(databasePath);
    old.exec(`
      DROP TABLE dacs_coordinator_orders;
      DELETE FROM dacs_migrations WHERE version = 2;
      UPDATE dacs_store_metadata SET schema_version = 1 WHERE singleton = 1;
      PRAGMA user_version = 1;
    `);
    old.close();

    const migrated = await open(databasePath);
    expect(migrated.diagnostics().schemaVersion).toBe(DACS_NODE_SQLITE_SCHEMA_VERSION);
    expect(readdirSync(root).filter((name) => name.includes(".backup-v1-")))
      .toHaveLength(1);

    const raw = new BetterSqlite3(databasePath, { readonly: true });
    expect(raw.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name = 'dacs_coordinator_orders'
    `).get()).toMatchObject({ name: "dacs_coordinator_orders" });
    expect(raw.prepare("SELECT version FROM dacs_migrations ORDER BY version").all())
      .toEqual([{ version: 1 }, { version: 2 }]);
    raw.close();
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
    const bindingHash = fixedPriceX402OrderBindingHash(order);
    expect(await firstStore.create({ role: "buyer", order, bindingHash }))
      .toMatchObject({ status: "created" });
    const staleClaim = await firstStore.claim({
      role: "buyer",
      jobId: JOB_ID,
      bindingHash,
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
      track: "agreement",
      lease: staleClaim.lease,
      result: { status: "final", outcome: "success", reference: "stale" },
    })).toEqual({ status: "stale" });
    expect(await secondStore.record({
      role: "buyer",
      jobId: JOB_ID,
      bindingHash,
      track: "agreement",
      lease: currentClaim.lease,
      result: { status: "final", outcome: "success", reference: "current" },
    })).toMatchObject({
      status: "recorded",
      record: { tracks: { agreement: { reference: "current" } } },
    });
  });

  it("keeps live and offline coordinator stores profile-isolated", async () => {
    const offline = await open(join(temporaryRoot(), "buyer.sqlite"));
    expect(() => offline.createLiveCoordinatorStore("buyer")).toThrowError(
      expect.objectContaining({ reasonCode: "coordinator-profile-mismatch" }),
    );
    expect(() => offline.createOfflineCoordinatorStore("seller")).toThrowError(
      expect.objectContaining({ reasonCode: "coordinator-role-mismatch" }),
    );
    const store = offline.createOfflineCoordinatorStore("buyer");
    const order = offlineOrder();
    const bindingHash = fixedPriceOfflineOrderBindingHash(order);
    expect(await store.create({ role: "buyer", order, bindingHash }))
      .toMatchObject({ status: "created", record: { protocol: OFFLINE_PROTOCOL } });
    expect(await store.load("buyer", JOB_ID))
      .toMatchObject({ status: "ok", record: { bindingHash } });
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
    const bindingHash = fixedPriceX402OrderBindingHash(order);
    await store.create({ role: "buyer", order, bindingHash });

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
    expect(claim).toMatchObject({ status: "acquired", mode: "perform" });
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
    expect(reconcile).toMatchObject({ status: "acquired", mode: "reconcile" });
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

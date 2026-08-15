import {
  mkdirSync,
  mkdtempSync,
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

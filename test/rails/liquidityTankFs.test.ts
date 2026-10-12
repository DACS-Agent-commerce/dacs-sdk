import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import {
  advanceLiquidityTankSettlement,
  createLiquidityTankIntent,
  type LiquidityTankAdapter,
  type LiquidityTankAuthority,
  type LiquidityTankObservation,
  type LiquidityTankStore,
  type LiquidityTankVerifier,
} from "../../src/rails/liquidityTank.js";
import { createFsLiquidityTankStore } from "../../src/rails/liquidityTankFs.js";
import { runLiquidityTankStoreConformance } from "../../src/rails/liquidityTankStoreConformance.js";

/** Every fsync, rename and link under a traced root, in order. */
const trace = vi.hoisted(() => ({
  root: "",
  events: [] as string[],
  /** Runs once before the next link to `linkTarget`, as another process could. */
  linkTarget: "",
  beforeLink: undefined as ((to: string) => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const traced = (path: unknown) => trace.root !== "" && String(path).startsWith(trace.root);
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (traced(args[0])) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          trace.events.push(`sync ${String(args[0])}`);
        };
      }
      return handle;
    },
    rename: async (from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) => {
      await actual.rename(from, to);
      if (traced(to)) trace.events.push(`rename ${String(from)} -> ${String(to)}`);
    },
    link: async (from: Parameters<typeof actual.link>[0], to: Parameters<typeof actual.link>[1]) => {
      const before = String(to) === trace.linkTarget ? trace.beforeLink : undefined;
      trace.beforeLink = before ? undefined : trace.beforeLink;
      await before?.(String(to));
      await actual.link(from, to);
      if (traced(to)) trace.events.push(`link ${String(from)} -> ${String(to)}`);
    },
  };
});

const roots: string[] = [];

async function freshDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dacs-liquidity-tank-fs-"));
  roots.push(root);
  return join(root, "store");
}

afterEach(async () => {
  trace.root = "";
  trace.linkTarget = "";
  trace.beforeLink = undefined;
  trace.events.length = 0;
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

const BRIDGE_ID = "fsStoreBridge-01";
const T0 = 1_785_000_000_000;
const DEADLINE = T0 + 86_400_000;

function authority(phaseIndex = 0): LiquidityTankAuthority {
  return {
    jobId: "01JZ0000000000000000000007",
    phaseIndex,
    railId: "demos-tank-sepolia-amoy-usdc",
    railDescriptorHash: "b".repeat(64),
    agreementHash: "c".repeat(64),
    sr5BindingHash: "d".repeat(64),
    assetKind: "stablecoin-cross-chain",
    networkKind: "cross-chain",
    mechanism: "liquidity-tank",
    sourceChainId: 11_155_111,
    destinationChainId: 80_002,
    sourceChainType: "EVM",
    destinationChainType: "EVM",
    sourceAsset: "USDC",
    destinationAsset: "USDC",
    sourceTokenDecimals: 6,
    destinationTokenDecimals: 6,
    amount: "1.25",
    currency: "USDC",
    originAddress: "fs-origin",
    destinationAddress: "fs-destination",
    sourceLiquidityTankId: "fs-tank-source",
    destinationLiquidityTankId: "fs-tank-destination",
    supportedScope: "dacs-v0.1-eth-sepolia-polygon-amoy-usdc",
  };
}

const intent = createLiquidityTankIntent(authority());

function submission(bridgeId = BRIDGE_ID) {
  const unsigned = {
    submissionVersion: "1" as const,
    authorityHash: intent.bindingHash,
    operationHash: intent.operationHash,
    bridgeId,
    substrateTxHash: "fs-native-bridge-tx",
    signedSubmissionBase64: Buffer.from(`signed-${bridgeId}`, "utf8").toString("base64"),
    preparedAt: T0,
  };
  return { ...unsigned, submissionHash: sha256Hex(canonicalize(unsigned)) };
}

function lockedPending(observedAt = T0 + 10): Extract<LiquidityTankObservation, { status: "pending" }> {
  return {
    status: "pending",
    bridgeId: BRIDGE_ID,
    operationHash: intent.operationHash,
    history: ["empty", "pending"],
    observedAt,
    authenticationHash: "a".repeat(64),
    lockTxHash: "fs-source-lock-tx",
    recoveryDeadline: DEADLINE,
  };
}

/** Claims the phase at `now` and returns the write authority of the acquired lease. */
async function acquire(store: LiquidityTankStore, owner: string, now: number) {
  const claimed = await store.claim({ intent, owner, now, leaseDurationMs: 1_000 });
  if (claimed.status !== "acquired") throw new Error(`expected acquired, got ${claimed.status}`);
  return {
    claimed,
    write: {
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      owner,
      generation: claimed.lease.generation,
      now,
    },
  };
}

describe("createFsLiquidityTankStore", () => {
  test("passes every store conformance case, restarts and races included, through new instances", async () => {
    const dirs = new WeakMap<LiquidityTankStore, string>();
    const open = async (dir: string) => {
      const store = await createFsLiquidityTankStore({ dir });
      dirs.set(store, dir);
      return store;
    };
    const results = await runLiquidityTankStoreConformance({
      createStore: async () => open(await freshDir()),
      reopenStore: (store) => open(dirs.get(store) as string),
    });
    expect(results.filter((result) => !result.passed)).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(28);
  }, 120_000);

  test("declares that it passed conformance", async () => {
    const store = await createFsLiquidityTankStore({ dir: await freshDir() });
    expect(store.restartSafety).toBe("conformance-tested");
  });

  test("a new instance on the same directory sees every committed row", async () => {
    const dir = await freshDir();
    const first = await createFsLiquidityTankStore({ dir });
    const { write } = await acquire(first, "worker-1", T0);
    await expect(first.recordSubmission({ ...write, submission: submission() }))
      .resolves.toEqual({ status: "recorded" });
    await expect(first.recordObservation({ ...write, now: T0 + 5, observation: lockedPending() }))
      .resolves.toEqual({ status: "recorded" });

    const restarted = await createFsLiquidityTankStore({ dir });
    const waiting = await restarted.claim({ intent, owner: "worker-2", now: T0 + 10, leaseDurationMs: 1_000 });
    expect(waiting).toMatchObject({
      status: "waiting",
      lease: { owner: "worker-1", generation: write.generation },
      submission: submission(),
      submissionRecordedAt: T0,
      observation: lockedPending(),
    });
    const { claimed } = await acquire(restarted, "worker-2", T0 + 2_000);
    expect(claimed).toMatchObject({
      lease: { owner: "worker-2", generation: write.generation + 1 },
      submission: submission(),
      submissionRecordedAt: T0,
      observation: lockedPending(),
    });
    // The old owner is fenced on the restarted state.
    await expect(first.recordObservation({ ...write, now: T0 + 2_001, observation: lockedPending(T0 + 20) }))
      .resolves.toEqual({ status: "stale", reason: "stale-lease" });
    // The bridge ID stays reserved for this phase across the restart.
    const other = createLiquidityTankIntent(authority(1));
    const otherClaim = await restarted.claim({ intent: other, owner: "worker-3", now: T0, leaseDurationMs: 1_000 });
    if (otherClaim.status !== "acquired") throw new Error("expected acquired");
    await expect(restarted.recordSubmission({
      settlementKey: other.settlementKey, bindingHash: other.bindingHash, owner: "worker-3",
      generation: otherClaim.lease.generation, now: T0,
      submission: { ...submission(), authorityHash: other.bindingHash },
    })).resolves.toEqual({ status: "conflict", reason: "liquidity-tank-bridge-cross-settlement-reuse" });
  });

  test("a restarted worker reuses the retained submission instead of signing a second one", async () => {
    const dir = await freshDir();
    let now = T0;
    let observation: LiquidityTankObservation = {
      status: "empty",
      bridgeId: BRIDGE_ID,
      operationHash: intent.operationHash,
      history: ["empty"],
      observedAt: T0,
      authenticationHash: "a".repeat(64),
    };
    const prepareSubmission = vi.fn<LiquidityTankAdapter["prepareSubmission"]>(async () => {
      const { submissionHash: _hash, ...unsigned } = submission();
      return unsigned;
    });
    const broadcastRetained = vi.fn<LiquidityTankAdapter["broadcastRetained"]>(async () => {
      observation = lockedPending(now);
    });
    const adapter: LiquidityTankAdapter = {
      prepareSubmission,
      broadcastRetained,
      observe: async () => observation,
    };
    const verifier: LiquidityTankVerifier = {
      authenticateObservation: async () => true,
      verifySignedSubmission: async () => true,
    };
    const run = async (owner: string) => advanceLiquidityTankSettlement({
      authority: authority(),
      owner,
      store: await createFsLiquidityTankStore({ dir }),
      adapter,
      verifier,
      now: () => now,
      leaseDurationMs: 1_000,
    });
    await expect(run("worker-1")).resolves.toMatchObject({ status: "settle-asymmetric" });
    now += 2_000;
    await expect(run("worker-2")).resolves.toMatchObject({ status: "settle-asymmetric" });
    expect(prepareSubmission).toHaveBeenCalledTimes(1);
    expect(new Set(broadcastRetained.mock.calls.map(([sent]) => sent.submissionHash)).size).toBe(1);
  });

  test("each row write fsyncs a temporary, renames it over the row and fsyncs the directory before it returns", async () => {
    const dir = await freshDir();
    const store = await createFsLiquidityTankStore({ dir });
    const records = join(dir, "records");
    const bridges = join(dir, "bridges");
    const row = join(records, `${sha256Hex(intent.settlementKey)}.json`);
    const reservation = join(bridges, `${sha256Hex(BRIDGE_ID)}.json`);
    trace.root = dir;
    const { write } = await acquire(store, "worker-1", T0);
    await expect(store.recordSubmission({ ...write, submission: submission() }))
      .resolves.toEqual({ status: "recorded" });
    const before = await lstat(row);
    await expect(store.recordObservation({ ...write, now: T0 + 5, observation: lockedPending() }))
      .resolves.toEqual({ status: "recorded" });
    const events = trace.events;

    const publications = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.endsWith(` -> ${row}`));
    // The claim, the submission and the observation each replace the row.
    expect(publications).toHaveLength(3);
    for (const { event, index } of publications) {
      expect(event).toMatch(/^rename /);
      const temporary = event.slice("rename ".length, event.indexOf(" -> "));
      const synced = events.indexOf(`sync ${temporary}`);
      expect(synced).toBeGreaterThanOrEqual(0);
      expect(synced).toBeLessThan(index);
      expect(events.slice(index + 1).some((later) => later === `sync ${records}`)).toBe(true);
    }
    // Each write is a new file, so a reader never sees one half written.
    expect((await lstat(row)).ino).not.toBe(before.ino);

    // The bridge reservation is linked, never renamed over, and lands before
    // the row that holds the submission.
    const reserved = events.findIndex((event) => event.startsWith("link ") && event.endsWith(` -> ${reservation}`));
    expect(reserved).toBeGreaterThanOrEqual(0);
    expect(events.some((event) => event.startsWith("rename ") && event.endsWith(` -> ${reservation}`))).toBe(false);
    expect(reserved).toBeLessThan((publications[1] as { index: number }).index);
    expect(events.slice(reserved + 1).some((later) => later === `sync ${bridges}`)).toBe(true);
    // No temporary is left behind.
    expect((await readdir(records)).filter((name) => name !== `${sha256Hex(intent.settlementKey)}.json`)).toEqual([]);
  });

  test("a phase that loses the bridge-ID reservation race reports the conflict and commits nothing", async () => {
    const dir = await freshDir();
    const store = await createFsLiquidityTankStore({ dir });
    const { write } = await acquire(store, "worker-1", T0);
    const reservation = join(dir, "bridges", `${sha256Hex(BRIDGE_ID)}.json`);
    const otherKey = createLiquidityTankIntent(authority(1)).settlementKey;
    // Another phase publishes the same bridge ID after this write read the
    // reservations and before it links its own.
    trace.linkTarget = reservation;
    trace.beforeLink = async (to) => {
      await writeFile(to, JSON.stringify({ storeVersion: 1, bridgeId: BRIDGE_ID, settlementKey: otherKey }), {
        flag: "wx", mode: 0o600,
      });
    };
    await expect(store.recordSubmission({ ...write, submission: submission() }))
      .resolves.toEqual({ status: "conflict", reason: "liquidity-tank-bridge-cross-settlement-reuse" });
    expect(trace.beforeLink).toBeUndefined();
    const restarted = await createFsLiquidityTankStore({ dir });
    const claimed = await restarted.claim({ intent, owner: "worker-2", now: T0 + 5_000, leaseDurationMs: 1_000 });
    expect(claimed.status).toBe("acquired");
    expect(claimed).not.toHaveProperty("submission");
  });

  test("a row that was not written by the store reads as corrupt, and nothing is written over it", async () => {
    const dir = await freshDir();
    const store = await createFsLiquidityTankStore({ dir });
    const { write } = await acquire(store, "worker-1", T0);
    await store.recordSubmission({ ...write, submission: submission() });
    const row = join(dir, "records", `${sha256Hex(intent.settlementKey)}.json`);
    const written = await readFile(row, "utf8");
    const corruptions = [
      written.replace(`"submissionRecordedAt":${T0}`, '"submissionRecordedAt":-1'),
      written.replace(/"preparedAt":\d+/, '"preparedAt":1'),
      written.replace('"storeVersion":1', '"storeVersion":2'),
      JSON.stringify(JSON.parse(written), null, 1),
      `${written.slice(0, -1)},"extra":true}`,
      written.slice(0, 40),
    ];
    for (const corruption of corruptions) {
      await writeFile(row, corruption, { mode: 0o600 });
      const restarted = await createFsLiquidityTankStore({ dir });
      await expect(restarted.claim({ intent, owner: "worker-2", now: T0 + 5_000, leaseDurationMs: 1_000 }))
        .resolves.toEqual({ status: "corrupt", reason: "liquidity-tank-fs-record-corrupt" });
      await expect(restarted.recordObservation({ ...write, now: T0 + 1, observation: lockedPending() }))
        .resolves.toEqual({ status: "corrupt", reason: "liquidity-tank-fs-record-corrupt" });
      expect(await readFile(row, "utf8")).toBe(corruption);
    }
  });

  test("refuses a group- or world-writable directory and a symlinked one", async () => {
    for (const mode of [0o770, 0o707]) {
      const dir = await freshDir();
      await mkdir(dir, { mode: 0o700 });
      await chmod(dir, mode);
      await expect(createFsLiquidityTankStore({ dir })).rejects.toThrow(/group\/world writable/);
    }
    const target = await freshDir();
    await mkdir(target, { mode: 0o700 });
    const linked = `${target}-link`;
    await symlink(target, linked);
    await expect(createFsLiquidityTankStore({ dir: linked })).rejects.toThrow(/symbolic link/);
  });

  test("refuses inexact options", async () => {
    const dir = await freshDir();
    await expect(createFsLiquidityTankStore({ dir, lockTimeoutMs: 0 })).rejects.toThrow(/positive safe integer/);
    await expect(createFsLiquidityTankStore({ dir, extra: true } as never)).rejects.toThrow(/exact data properties/);
    await expect(createFsLiquidityTankStore({ dir: "" })).rejects.toThrow(/non-empty string/);
  });
});

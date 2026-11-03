import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync, readlinkSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";

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
import { createLiquidityTankEvmFinalityVerifier } from "../../src/rails/liquidityTankEvmFinality.js";
import { createFsLiquidityTankStore } from "../../src/rails/liquidityTankFs.js";
import { runLiquidityTankStoreConformance } from "../../src/rails/liquidityTankStoreConformance.js";
import { CRASH_BRIDGE_ID, CRASH_T0, crashAuthority, crashSubmission } from "../fixtures/liquidityTankFsCrash.js";

/** Every fsync, rename and link under a traced root, in order. */
const trace = vi.hoisted(() => ({
  root: "",
  events: [] as string[],
  /** Runs once before the next link to `linkTarget`, as another process could. */
  linkTarget: "",
  beforeLink: undefined as ((to: string) => Promise<void>) | undefined,
  /**
   * Sees each operation before it runs (`rename` and `link` as `from -> to`);
   * an error code it returns fails that operation instead.
   */
  fault: undefined as ((operation: string, path: string) => string | undefined) | undefined,
  /** Runs before each unlink and may hold it. */
  beforeUnlink: undefined as ((path: string) => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const traced = (path: unknown) => trace.root !== "" && String(path).startsWith(trace.root);
  const inject = (operation: string, path: string) => {
    const code = trace.fault?.(operation, path);
    if (code !== undefined) throw Object.assign(new Error(`injected ${code}: ${operation} ${path}`), { code });
  };
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      inject("open", String(args[0]));
      const handle = await actual.open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        inject("sync", String(args[0]));
        await sync();
        if (traced(args[0])) trace.events.push(`sync ${String(args[0])}`);
      };
      return handle;
    },
    rename: async (from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) => {
      inject("rename", `${String(from)} -> ${String(to)}`);
      await actual.rename(from, to);
      if (traced(to)) trace.events.push(`rename ${String(from)} -> ${String(to)}`);
    },
    link: async (from: Parameters<typeof actual.link>[0], to: Parameters<typeof actual.link>[1]) => {
      const before = String(to) === trace.linkTarget ? trace.beforeLink : undefined;
      trace.beforeLink = before ? undefined : trace.beforeLink;
      await before?.(String(to));
      inject("link", `${String(from)} -> ${String(to)}`);
      await actual.link(from, to);
      if (traced(to)) trace.events.push(`link ${String(from)} -> ${String(to)}`);
    },
    unlink: async (path: Parameters<typeof actual.unlink>[0]) => {
      await trace.beforeUnlink?.(String(path));
      inject("unlink", String(path));
      await actual.unlink(path);
    },
    rm: async (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      inject("rm", String(path));
      await actual.rm(path, options);
    },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      inject("stat", String(args[0]));
      return actual.stat(...args);
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      inject("lstat", String(args[0]));
      return actual.lstat(...args);
    },
  };
});

function resolvedAuthority(a = authority()) {
  return { authority: a, rail: {
    railId: a.railId, railType: "cross-chain-liquidity-tank" as const,
    phaseHandler: "pay-cross-chain-liquidity-tank" as const,
    asset: { kind: "stablecoin-cross-chain" as const, canonicalSymbol: "USDC", routes: [{
      sourceChainId: a.sourceChainId, destChainId: a.destinationChainId,
      liquidityTankIds: [a.sourceLiquidityTankId, a.destinationLiquidityTankId],
    }] },
    network: { kind: "cross-chain" as const, mechanism: "liquidity-tank" as const },
  } };
}

const roots: string[] = [];

async function freshDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dacs-liquidity-tank-fs-"));
  roots.push(root);
  return join(root, "store");
}

afterEach(async () => {
  vi.unstubAllEnvs();
  trace.root = "";
  trace.linkTarget = "";
  trace.beforeLink = undefined;
  trace.fault = undefined;
  trace.beforeUnlink = undefined;
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

  test.each(["development", "test"])("with NODE_ENV=%s, a durable restarted worker reuses the retained submission", async (nodeEnv) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
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
      observation = { ...lockedPending(now), lockTxHash: `0x${"1".repeat(64)}` };
    });
    const adapter: LiquidityTankAdapter = {
      prepareSubmission,
      broadcastRetained,
      observe: async () => observation,
    };
    const verifier = createLiquidityTankEvmFinalityVerifier({
      verifier: { authenticateObservation: async () => true, verifySignedSubmission: async () => true },
      sourceRpcUrl: "https://sepolia.example/",
      fetch: async (_url, init) => {
        const { id, method, params } = JSON.parse(init?.body as string);
        const lockHash = `0x${"1".repeat(64)}`;
        const blockHash = `0x${"2".repeat(64)}`;
        const result = method === "eth_chainId" ? "0xaa36a7" : method === "eth_getTransactionReceipt"
          ? { transactionHash: lockHash, blockHash, blockNumber: "0x10", status: "0x1" }
          : { hash: blockHash, number: "0x10", transactions: [lockHash] };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));
      },
    });
    const run = async (owner: string) => advanceLiquidityTankSettlement({
      authority: authority(),
      owner,
      store: await createFsLiquidityTankStore({ dir }),
      adapter,
      verifier,
      resolveAuthority: async () => resolvedAuthority(),
      now: () => now,
      leaseDurationMs: 1_000,
    });
    await expect(run("worker-1")).resolves.toMatchObject({ status: "settle-asymmetric" });
    now += 2_000;
    await expect(run("worker-2")).resolves.toMatchObject({ status: "settle-asymmetric" });
    expect(prepareSubmission).toHaveBeenCalledTimes(1);
    expect(new Set(broadcastRetained.mock.calls.map(([sent]) => sent.submissionHash)).size).toBe(1);
  }, 30_000);

  describe("a contradicted lock across a restart", () => {
    const emptyAt = (observedAt: number): LiquidityTankObservation => ({
      status: "empty", bridgeId: BRIDGE_ID, operationHash: intent.operationHash, history: ["empty"], observedAt,
      authenticationHash: "a".repeat(64),
    });
    /** Locks the phase (checkpoint observed at T0 + 10); each call opens a new store instance, as a restart would. */
    async function locked(dir: string) {
      const phase = { now: T0, observation: emptyAt(T0) };
      const prepareSubmission = vi.fn<LiquidityTankAdapter["prepareSubmission"]>(async () => {
        const { submissionHash: _hash, ...unsigned } = submission();
        return unsigned;
      });
      const broadcastRetained = vi.fn<LiquidityTankAdapter["broadcastRetained"]>(async () => {
        phase.observation = lockedPending();
      });
      const adapter: LiquidityTankAdapter = { prepareSubmission, broadcastRetained, observe: async () => phase.observation };
      const run = async (owner: string) => advanceLiquidityTankSettlement({
        authority: authority(), owner, store: await createFsLiquidityTankStore({ dir }), adapter,
        verifier: { authenticateObservation: async () => true, verifySignedSubmission: async () => true },
        now: () => phase.now, leaseDurationMs: 1_000,
      });
      await expect(run("locker")).resolves.toMatchObject({ status: "settle-asymmetric", reason: "tank-locked-unreleased" });
      return { phase, run, prepareSubmission, broadcastRetained };
    }

    test("a read no later than the checkpoint never expires the lock, and its timely completion then settles", async () => {
      const dir = await freshDir();
      const { phase, run, prepareSubmission, broadcastRetained } = await locked(dir);
      phase.now = DEADLINE + 1;
      for (const stamp of [T0 + 5, T0 + 10]) {
        phase.observation = emptyAt(stamp);
        await expect(run(`stale-${stamp}`)).resolves.toMatchObject({
          status: "settle-asymmetric", reason: "lock-contradicted", bridgeStatus: "conflicting", pastDeadline: true,
        });
        phase.now += 1_000;
      }
      // A restarted store still holds the open lock, and refuses the same evidence written directly.
      const { claimed, write } = await acquire(await createFsLiquidityTankStore({ dir }), "direct", phase.now);
      expect(claimed.observation).toEqual(lockedPending());
      await expect((await createFsLiquidityTankStore({ dir })).recordRecoveryExpired({
        ...write, expectedObservation: lockedPending(),
        observation: { status: "contradicted-after-lock", checkpoint: lockedPending(), contradiction: emptyAt(T0 + 10) } as never,
      })).resolves.toEqual({ status: "conflict", reason: "liquidity-tank-recovery-expiry-not-due" });
      phase.observation = {
        status: "completed", bridgeId: BRIDGE_ID, operationHash: intent.operationHash,
        history: ["empty", "pending", "completed"], observedAt: DEADLINE - 1, finalityObservedAt: DEADLINE - 1,
        recoveryDeadline: DEADLINE, authenticationHash: "a".repeat(64),
        lockTxHash: "fs-source-lock-tx", releaseTxHash: "fs-release-tx",
      };
      phase.now = DEADLINE + 5_000;
      await expect(run("settler")).resolves.toMatchObject({
        status: "settled", settlement: { txRef: { lockTxHash: "fs-source-lock-tx", releaseTxHash: "fs-release-tx" } },
      });
      expect(prepareSubmission).toHaveBeenCalledTimes(1);
      expect(broadcastRetained).toHaveBeenCalledTimes(1);
    }, 30_000);

    test("a read after the checkpoint but not after the deadline leaves the lock open across a restart, so its timely completion settles", async () => {
      // Round 5: this host's clock reads just past the deadline while the
      // bridge's is behind it, and the lock releases thirty seconds before it.
      const dir = await freshDir();
      const { phase, run, prepareSubmission, broadcastRetained } = await locked(dir);
      phase.now = DEADLINE + 1;
      for (const stamp of [T0 + 11, DEADLINE - 120_000, DEADLINE - 1, DEADLINE]) {
        phase.observation = emptyAt(stamp);
        await expect(run(`early-${stamp}`)).resolves.toMatchObject({
          status: "settle-asymmetric", reason: "lock-contradicted", bridgeStatus: "conflicting", pastDeadline: true,
        });
        phase.now += 1_000;
      }
      // A restarted store still holds the open lock, and refuses the same evidence written directly.
      const { claimed, write } = await acquire(await createFsLiquidityTankStore({ dir }), "direct", phase.now);
      expect(claimed.observation).toEqual(lockedPending());
      await expect((await createFsLiquidityTankStore({ dir })).recordRecoveryExpired({
        ...write, expectedObservation: lockedPending(),
        observation: { status: "contradicted-after-lock", checkpoint: lockedPending(), contradiction: emptyAt(DEADLINE) } as never,
      })).resolves.toEqual({ status: "conflict", reason: "liquidity-tank-recovery-expiry-not-due" });
      const completion: LiquidityTankObservation = {
        status: "completed", bridgeId: BRIDGE_ID, operationHash: intent.operationHash,
        history: ["empty", "pending", "completed"], observedAt: DEADLINE - 30_000, finalityObservedAt: DEADLINE - 30_000,
        recoveryDeadline: DEADLINE, authenticationHash: "a".repeat(64),
        lockTxHash: "fs-source-lock-tx", releaseTxHash: "fs-release-tx",
      };
      phase.observation = completion;
      phase.now += 2_000;
      const settled = {
        status: "settled", settlement: { txRef: { lockTxHash: "fs-source-lock-tx", releaseTxHash: "fs-release-tx" } },
      };
      await expect(run("settler")).resolves.toMatchObject(settled);
      // Saved success is checked against a fresh completion after restart.
      phase.observation = emptyAt(DEADLINE - 1);
      phase.now += 5_000;
      await expect(run("replayer")).resolves.toMatchObject({ status: "indeterminate",
        reason: "liquidity-tank-settlement-reconciliation-unavailable" });
      phase.observation = completion;
      await expect(run("verified-replayer")).resolves.toMatchObject(settled);
      expect(prepareSubmission).toHaveBeenCalledTimes(1);
      expect(broadcastRetained).toHaveBeenCalledTimes(1);
    }, 30_000);

    test("a read after the checkpoint and after the deadline expires the lock, and a restarted store replays the expiry", async () => {
      const dir = await freshDir();
      const { phase, run, broadcastRetained } = await locked(dir);
      const expired = {
        status: "failed", errorClass: "failed-substrate", reason: "tank-lock-contradicted-recovery-expired",
        reputationNeutral: true,
        // The checkpoint's lock, which the interim record names.
        lockTxRef: {
          kind: "liquidity-tank", bridgeId: BRIDGE_ID, sourceChainId: 11_155_111, destChainId: 80_002,
          lockTxHash: "fs-source-lock-tx", recoveryDeadline: DEADLINE,
        },
      };
      phase.observation = emptyAt(DEADLINE + 1);
      phase.now = DEADLINE + 1;
      await expect(run("expirer")).resolves.toEqual(expired);
      await expect((await createFsLiquidityTankStore({ dir })).claim({
        intent, owner: "inspector", now: DEADLINE + 2_000, leaseDurationMs: 1_000,
      })).resolves.toMatchObject({
        status: "recovery-expired",
        observation: { status: "contradicted-after-lock", checkpoint: lockedPending(), contradiction: emptyAt(DEADLINE + 1) },
      });
      phase.now = DEADLINE + 5_000;
      await expect(run("replayer")).resolves.toEqual(expired);
      expect(broadcastRetained).toHaveBeenCalledTimes(1);
    }, 30_000);
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

  test("reservation recovery fsyncs an existing publication without a staging name before acknowledging its row", async () => {
    const dir = await freshDir();
    const bridges = join(dir, "bridges");
    const reservation = join(bridges, `${sha256Hex(BRIDGE_ID)}.json`);
    const row = join(dir, "records", `${sha256Hex(intent.settlementKey)}.json`);
    const store = await createFsLiquidityTankStore({ dir });
    const first = await acquire(store, "first", T0);
    trace.root = dir;
    trace.fault = (operation, path) => operation === "sync" && path === bridges ? "EIO" : undefined;
    await expect(store.recordSubmission({ ...first.write, submission: submission() })).rejects.toMatchObject({ code: "EIO" });
    expect((await lstat(reservation)).nlink).toBe(1);
    expect(await readdir(bridges)).toEqual([`${sha256Hex(BRIDGE_ID)}.json`]);
    const reopened = await createFsLiquidityTankStore({ dir });
    const second = await acquire(reopened, "retry", T0 + 1_001);
    // Recovery must also fail if that barrier still cannot be completed.
    await expect(reopened.recordSubmission({ ...second.write, submission: submission() })).rejects.toMatchObject({ code: "EIO" });
    expect(JSON.parse(await readFile(row, "utf8")).submission).toBeUndefined();
    trace.fault = undefined;
    trace.events.length = 0;
    await expect(reopened.recordSubmission({ ...second.write, submission: submission() })).resolves.toEqual({ status: "recorded" });
    const barrier = trace.events.indexOf(`sync ${bridges}`);
    const published = trace.events.findIndex((event) => event.startsWith("rename ") && event.endsWith(` -> ${row}`));
    expect(barrier).toBeGreaterThanOrEqual(0);
    expect(barrier).toBeLessThan(published);
    const final = await acquire(await createFsLiquidityTankStore({ dir }), "inspect", T0 + 2_002);
    expect(final.claimed.submission).toEqual(submission());
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

  // Each row is spelled exactly as the store writes one, so only the record
  // check refuses it, and each trips one of that check's guards (code P2-6).
  describe("a well-spelled row that the store's transitions could not have written reads as corrupt", () => {
    type Row = Record<string, unknown> & { intent: Record<string, unknown>; lease: Record<string, unknown> };
    type Rows = { claimed: Row; submitted: Row; observed: Row };
    const rebound = (fields: Record<string, unknown>) => {
      const { bindingHash: _hash, ...unsigned } = { ...intent, ...fields };
      return { ...unsigned, bindingHash: sha256Hex(canonicalize(unsigned)) };
    };
    test.each<[string, (rows: Rows) => Row]>([
      ["an intent of another version, its binding hash recomputed",
        ({ claimed }) => ({ ...claimed, intent: rebound({ intentVersion: "2" }) })],
      ["another phase's intent", ({ claimed }) => ({ ...claimed, intent: { ...createLiquidityTankIntent(authority(1)) } })],
      ["an intent changed under its binding hash", ({ claimed }) => ({ ...claimed, intent: { ...claimed.intent, phaseIndex: 1 } })],
      ["a lease owner that is not a string", ({ claimed }) => ({ ...claimed, lease: { ...claimed.lease, owner: 7 } })],
      ["a lease of generation 0", ({ claimed }) => ({ ...claimed, lease: { ...claimed.lease, generation: 0 } })],
      ["a lease that expires before the epoch", ({ claimed }) => ({ ...claimed, lease: { ...claimed.lease, expiresAt: -1 } })],
      ["a submission receipt without a submission", ({ claimed }) => ({ ...claimed, submissionRecordedAt: T0 })],
      ["a submission without its receipt", ({ submitted }) => {
        const { submissionRecordedAt: _receipt, ...row } = submitted;
        return row as Row;
      }],
      ["an observation without a submission", ({ claimed, observed }) => ({ ...claimed, observation: observed.observation })],
      ["a recovery failure without a submission", ({ claimed, observed }) => ({ ...claimed, recoveryFailure: observed.observation })],
      ["a recovery expiry without a submission", ({ claimed, observed }) => ({ ...claimed, recoveryExpired: observed.observation })],
      ["an observation of another operation", ({ observed }) => ({
        ...observed, observation: { ...(observed.observation as object), operationHash: "f".repeat(64) },
      })],
      ["a recovery failure that is not a failure after the lock", ({ observed }) => ({ ...observed, recoveryFailure: observed.observation })],
      ["a recovery expiry that is not recovery evidence", ({ observed }) => ({ ...observed, recoveryExpired: { status: "unknown" } })],
      ["a settlement that is not one", ({ submitted }) => ({ ...submitted, settlement: { txRef: {} } })],
    ])("%s", async (_label, change) => {
      const dir = await freshDir();
      const store = await createFsLiquidityTankStore({ dir });
      const row = join(dir, "records", `${sha256Hex(intent.settlementKey)}.json`);
      const read = async () => JSON.parse(await readFile(row, "utf8")) as Row;
      const { write } = await acquire(store, "worker-1", T0);
      const claimed = await read();
      await store.recordSubmission({ ...write, submission: submission() });
      const submitted = await read();
      await store.recordObservation({ ...write, now: T0 + 5, observation: lockedPending() });
      const observed = await read();
      const corruption = JSON.stringify(change({ claimed, submitted, observed }));
      await writeFile(row, corruption, { mode: 0o600 });
      const restarted = await createFsLiquidityTankStore({ dir });
      await expect(restarted.claim({ intent, owner: "worker-2", now: T0 + 5_000, leaseDurationMs: 1_000 }))
        .resolves.toEqual({ status: "corrupt", reason: "liquidity-tank-fs-record-corrupt" });
      expect(await readFile(row, "utf8")).toBe(corruption);
    });
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

/** Every step of a reservation's publication and of the row write after it, in order. */
const CRASH_STEPS = [
  "staging-created",
  "staging-written",
  "staging-synced",
  "linked",
  "staging-unlinked",
  "reservation-directory-synced",
  "row-renamed",
  "row-directory-synced",
] as const;

/** Runs the child store until it reaches `step`, then kills its process group with SIGKILL. */
async function killChildAt(dir: string, step: string): Promise<string> {
  const ready = join(dirname(dir), `reached-${step}`);
  const child = spawn(
    process.execPath,
    [
      "./node_modules/vitest/vitest.mjs",
      "run",
      "test/fixtures/liquidity-tank-fs-child.test.ts",
      "--pool=forks",
      "--maxWorkers=1",
      "--reporter=dot",
    ],
    {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        DACS_TANK_FS_CHILD: "1",
        DACS_TANK_FS_DIR: dir,
        DACS_TANK_FS_READY: ready,
        DACS_TANK_FS_STOP: step,
      },
    },
  );
  if (child.pid === undefined) throw new Error("child process has no pid");
  let exited = false;
  const exit = new Promise<void>((resolve) => child.once("exit", () => {
    exited = true;
    resolve();
  }));
  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const reached = await readFile(ready, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return "";
      });
      if (reached !== "") return reached;
      if (exited || Date.now() >= deadline) throw new Error(`child store never reached ${step}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    await exit;
  }
}

async function outcome(call: () => Promise<{ status: string; reason?: string }>): Promise<string> {
  try {
    const result = await call();
    return result.reason === undefined ? result.status : `${result.status} ${result.reason}`;
  } catch (error) {
    return `threw: ${(error as Error).message}`;
  }
}

describe("createFsLiquidityTankStore after a crash while reserving a bridge ID", () => {
  test("a store reopened after a SIGKILL at any reservation step finishes recordSubmission with the bytes signed before the kill", async () => {
    const crashIntent = createLiquidityTankIntent(crashAuthority());
    const other = createLiquidityTankIntent(crashAuthority(1));
    const reservationName = `${sha256Hex(CRASH_BRIDGE_ID)}.json`;
    const rows = [];
    for (const step of CRASH_STEPS) {
      const dir = await freshDir();
      const reached = await killChildAt(dir, step);
      // The child's locks name a dead PID, so a short stale age reclaims them.
      const store = await createFsLiquidityTankStore({ dir, lockStaleMs: 1 });
      const now = CRASH_T0 + 2_000;
      const claimed = await store.claim({ intent: crashIntent, owner: "worker-2", now, leaseDurationMs: 1_000 });
      if (claimed.status !== "acquired") throw new Error(`expected acquired, got ${claimed.status}`);
      const recorded = await outcome(() => store.recordSubmission({
        settlementKey: crashIntent.settlementKey,
        bindingHash: crashIntent.bindingHash,
        owner: "worker-2",
        generation: claimed.lease.generation,
        now,
        submission: crashSubmission(),
      }));
      const otherClaim = await store.claim({ intent: other, owner: "worker-3", now, leaseDurationMs: 1_000 });
      if (otherClaim.status !== "acquired") throw new Error(`expected acquired, got ${otherClaim.status}`);
      const reused = await outcome(() => store.recordSubmission({
        settlementKey: other.settlementKey,
        bindingHash: other.bindingHash,
        owner: "worker-3",
        generation: otherClaim.lease.generation,
        now,
        submission: { ...crashSubmission(), authorityHash: other.bindingHash },
      }));
      rows.push({
        step,
        reached,
        retained: claimed.submission?.submissionHash === crashSubmission().submissionHash,
        recorded,
        links: (await lstat(join(dir, "bridges", reservationName))).nlink,
        bridges: await readdir(join(dir, "bridges")),
        reused,
      });
    }
    const committed = CRASH_STEPS.indexOf("row-renamed");
    expect(rows).toEqual(CRASH_STEPS.map((step, index) => ({
      step,
      reached: step,
      // Once the row holds the submission, a restarted core reuses it.
      retained: index >= committed,
      recorded: index >= committed ? "existing" : "recorded",
      links: 1,
      bridges: [reservationName],
      reused: "conflict liquidity-tank-bridge-cross-settlement-reuse",
    })));
  }, 600_000);

  test("a restarted core finishes a phase whose reservation a killed worker left linked twice, and signs once", async () => {
    const dir = await freshDir();
    const seeded = await createFsLiquidityTankStore({ dir });
    await acquire(seeded, "worker-0", T0);
    // What a SIGKILL right after the reservation's link leaves: its staging
    // name, as the store makes it, still linked to the reservation.
    const bridges = join(dir, "bridges");
    const reservation = join(bridges, `${sha256Hex(BRIDGE_ID)}.json`);
    const staging = join(bridges, `.${sha256Hex(BRIDGE_ID)}.json.${"5a".repeat(24)}.tmp`);
    await writeFile(staging, JSON.stringify({ storeVersion: 1, bridgeId: BRIDGE_ID, settlementKey: intent.settlementKey }), {
      flag: "wx", mode: 0o600,
    });
    await link(staging, reservation);

    let now = T0 + 2_000;
    let observation: LiquidityTankObservation = {
      status: "empty",
      bridgeId: BRIDGE_ID,
      operationHash: intent.operationHash,
      history: ["empty"],
      observedAt: now,
      authenticationHash: "a".repeat(64),
    };
    const prepareSubmission = vi.fn<LiquidityTankAdapter["prepareSubmission"]>(async () => {
      const { submissionHash: _hash, ...unsigned } = submission();
      return { ...unsigned, preparedAt: now };
    });
    const broadcastRetained = vi.fn<LiquidityTankAdapter["broadcastRetained"]>(async () => {
      observation = lockedPending(now);
    });
    const run = async (owner: string) => advanceLiquidityTankSettlement({
      authority: authority(),
      owner,
      store: await createFsLiquidityTankStore({ dir }),
      adapter: { prepareSubmission, broadcastRetained, observe: async () => observation },
      verifier: { authenticateObservation: async () => true, verifySignedSubmission: async () => true },
      now: () => now,
      leaseDurationMs: 1_000,
    });
    trace.root = dir;
    await expect(run("worker-1")).resolves.toMatchObject({ status: "settle-asymmetric" });
    now += 2_000;
    await expect(run("worker-2")).resolves.toMatchObject({ status: "settle-asymmetric" });
    // The removal is fsynced before the row that holds the submission is
    // written: the claim's write is the only row write before it.
    const row = join(dir, "records", `${sha256Hex(intent.settlementKey)}.json`);
    const finished = trace.events.indexOf(`sync ${bridges}`);
    expect(finished).toBeGreaterThanOrEqual(0);
    expect(trace.events.slice(0, finished).filter((event) => event.endsWith(` -> ${row}`))).toHaveLength(1);
    expect(prepareSubmission).toHaveBeenCalledTimes(1);
    expect(broadcastRetained).toHaveBeenCalled();
    expect(new Set(broadcastRetained.mock.calls.map(([sent]) => sent.submissionHash)).size).toBe(1);
    expect(await readdir(bridges)).toEqual([`${sha256Hex(BRIDGE_ID)}.json`]);
    expect((await lstat(reservation)).nlink).toBe(1);
  });

  test("a reservation's second link is removed only when it is the store's own staging name", async () => {
    const base = `${sha256Hex(BRIDGE_ID)}.json`;
    const ownStaging = `.${base}.${"0f".repeat(24)}.tmp`;
    const shapes = [
      { shape: "the store's staging name", extra: [ownStaging] },
      { shape: "a name the store does not make", extra: [`${base}.crash.tmp`] },
      { shape: "a staging name with a random part too short", extra: [`.${base}.${"0f".repeat(23)}.tmp`] },
      { shape: "the store's staging name and a third link", extra: [ownStaging, `${base}.copy`] },
    ];
    const rows = [];
    for (const { shape, extra } of shapes) {
      const dir = await freshDir();
      const store = await createFsLiquidityTankStore({ dir });
      const { write } = await acquire(store, "worker-1", T0);
      const bridges = join(dir, "bridges");
      const reservation = join(bridges, base);
      await writeFile(reservation, JSON.stringify({ storeVersion: 1, bridgeId: BRIDGE_ID, settlementKey: intent.settlementKey }), {
        flag: "wx", mode: 0o600,
      });
      for (const name of extra) await link(reservation, join(bridges, name));
      rows.push({
        shape,
        recorded: (await outcome(() => store.recordSubmission({ ...write, submission: submission() })))
          .replace(/: \/.*$/u, ""),
        bridges: (await readdir(bridges)).sort(),
      });
    }
    expect(rows).toEqual([
      { shape: shapes[0]!.shape, recorded: "recorded", bridges: [base] },
      {
        shape: shapes[1]!.shape,
        recorded: "threw: liquidity-tank filesystem store regular file has 2 hard links; exactly one is required",
        bridges: [base, `${base}.crash.tmp`].sort(),
      },
      {
        shape: shapes[2]!.shape,
        recorded: "threw: liquidity-tank filesystem store regular file has 2 hard links; exactly one is required",
        bridges: [base, `.${base}.${"0f".repeat(23)}.tmp`].sort(),
      },
      {
        shape: shapes[3]!.shape,
        recorded: "threw: liquidity-tank filesystem store regular file has 3 hard links; exactly one is required",
        bridges: [base, ownStaging, `${base}.copy`].sort(),
      },
    ]);
  });

  test("another phase with the same bridge ID waits for a live publisher stopped right after its link", async () => {
    const dir = await freshDir();
    const bridges = join(dir, "bridges");
    const store = await createFsLiquidityTankStore({ dir });
    const otherStore = await createFsLiquidityTankStore({ dir });
    const other = createLiquidityTankIntent(authority(1));
    const { write } = await acquire(store, "worker-1", T0);
    const otherClaim = await otherStore.claim({ intent: other, owner: "worker-2", now: T0, leaseDurationMs: 1_000 });
    if (otherClaim.status !== "acquired") throw new Error("expected acquired");
    let resume = (): void => undefined;
    const linked = new Promise<void>((resolve) => {
      trace.beforeUnlink = async (path) => {
        if (dirname(path) !== bridges || !path.endsWith(".tmp")) return;
        trace.beforeUnlink = undefined;
        resolve();
        await new Promise<void>((resumed) => {
          resume = resumed;
        });
      };
    });
    const publishing = store.recordSubmission({ ...write, submission: submission() });
    // The reservation is linked and its staging name not yet removed.
    await linked;
    const reading = otherStore.recordSubmission({
      settlementKey: other.settlementKey, bindingHash: other.bindingHash, owner: "worker-2",
      generation: otherClaim.lease.generation, now: T0,
      submission: { ...submission(), authorityHash: other.bindingHash },
    });
    const meanwhile = await Promise.race([
      reading.then(() => "finished", () => "finished"),
      new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 300)),
    ]);
    const stagingWhileStopped = (await readdir(bridges)).filter((name) => name.endsWith(".tmp")).length;
    resume();
    await expect(publishing).resolves.toEqual({ status: "recorded" });
    await expect(reading).resolves.toEqual({ status: "conflict", reason: "liquidity-tank-bridge-cross-settlement-reuse" });
    // It neither read the reservation nor removed the live publisher's staging name.
    expect({ meanwhile, stagingWhileStopped }).toEqual({ meanwhile: "waiting", stagingWhileStopped: 1 });
  });
});

/**
 * This thread's OS thread ID and its boot and PID namespace, as the store
 * records them in a lock's owner; `null` where `/proc` cannot tell them.
 */
function threadScope(): { tid: number; pidScope: string } | null {
  try {
    const self = /^([0-9]+)\/task\/([0-9]+)$/u.exec(readlinkSync("/proc/thread-self"));
    if (self === null || Number(self[1]) !== process.pid) return null;
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return { tid: Number(self[2]), pidScope: `${bootId} ${readlinkSync("/proc/self/ns/pid")}` };
  } catch {
    return null;
  }
}

/** Plants `owner` as the phase's lock, made a minute ago. */
async function plantStaleLock(dir: string, owner: Record<string, unknown>): Promise<void> {
  const lock = join(dir, "locks", `${sha256Hex(intent.settlementKey)}.lock`);
  await mkdir(lock, { mode: 0o700 });
  await writeFile(join(lock, "owner.json"), JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  const stale = new Date(Date.now() - 60_000);
  await utimes(lock, stale, stale);
}

/** Resolves once the OS no longer lists thread `tid` of this process. */
async function threadExited(tid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (existsSync(`/proc/self/task/${tid}`)) {
    if (Date.now() >= deadline) throw new Error(`thread ${tid} did not exit`);
    await new Promise((done) => setTimeout(done, 5));
  }
}

const TIMED_OUT = "threw: timed out acquiring the liquidity-tank filesystem store lock";

/** Fails the first operation `match` accepts, once `after` has accepted an earlier one. */
function failOnce(
  match: (operation: string, path: string) => boolean,
  after?: (operation: string, path: string) => boolean,
  code = "EIO",
) {
  const state = { fired: false, armed: after === undefined };
  const fault = (operation: string, path: string): string | undefined => {
    if (state.fired) return undefined;
    if (!state.armed) {
      state.armed = after?.(operation, path) ?? true;
      return undefined;
    }
    if (!match(operation, path)) return undefined;
    state.fired = true;
    return code;
  };
  return Object.assign(fault, { state });
}

describe("createFsLiquidityTankStore locks", () => {
  test("reclaims a stale lock an earlier process with this PID left, but not one another thread of this process may hold", async () => {
    const startedNs = process.hrtime.bigint() - BigInt(Math.ceil(process.uptime() * 1e9));
    const cases = [
      { left: "before this process started", createdNs: startedNs - 1_000_000_000n },
      { left: "in an earlier boot: after now on the monotonic clock", createdNs: process.hrtime.bigint() + 3_600_000_000_000n },
      { left: "after this process started, as another worker thread would", createdNs: process.hrtime.bigint() },
    ];
    const outcomes = [];
    for (const { left, createdNs } of cases) {
      const dir = await freshDir();
      const store = await createFsLiquidityTankStore({ dir, lockStaleMs: 20, lockTimeoutMs: 500 });
      // A live thread: this one, as another worker thread here would be.
      await plantStaleLock(dir, {
        pid: process.pid,
        ...(threadScope() ?? { tid: null, pidScope: null }),
        threadToken: "another-thread-token",
        token: "its-lock-token",
        createdNs: String(createdNs),
      });
      outcomes.push({ left, claim: await outcome(() => store.claim({ intent, owner: "worker-1", now: T0, leaseDurationMs: 1_000 })) });
    }
    expect(outcomes).toEqual([
      { left: cases[0]!.left, claim: "acquired" },
      { left: cases[1]!.left, claim: "acquired" },
      { left: cases[2]!.left, claim: "threw: timed out acquiring the liquidity-tank filesystem store lock" },
    ]);
  });

  test("a failure at any lock acquisition or release step leaves no lock behind, and a second store acquires at once", async () => {
    const candidateRename = (operation: string, path: string) => operation === "rename" && path.includes(".candidate -> ");
    const sites = [
      { site: "acquire: directory fsync after the reclaim gate's link", first: "rejected",
        fault: (locks: string) => failOnce((op, path) => op === "sync" && path === locks,
          (op, path) => op === "link" && path.endsWith(` -> ${locks}/.reclaim`)) },
      { site: "acquire: rename of the lock into place", first: "rejected",
        fault: () => failOnce(candidateRename) },
      { site: "acquire: directory fsync after the lock's rename", first: "rejected",
        fault: (locks: string) => failOnce((op, path) => op === "sync" && path === locks, candidateRename) },
      { site: "acquire: owner read of the reclaim gate on its release", first: "acquired",
        fault: (locks: string) => failOnce((op, path) => op === "open" && path === `${locks}/.reclaim`, candidateRename, "EMFILE") },
      { site: "acquire: rename of the reclaim gate on its release", first: "acquired",
        fault: (locks: string) => failOnce((op, path) => op === "rename" && path.startsWith(`${locks}/.reclaim -> `)) },
      { site: "acquire: owner read of the moved reclaim gate", first: "acquired",
        fault: () => failOnce((op, path) => op === "open" && path.endsWith(".quarantine"), undefined, "EMFILE") },
      { site: "acquire: removal of the moved reclaim gate", first: "acquired",
        fault: () => failOnce((op, path) => op === "unlink" && path.endsWith(".quarantine")) },
      { site: "acquire: directory fsync after the reclaim gate's removal", first: "acquired",
        fault: (locks: string) => failOnce((op, path) => op === "sync" && path === locks,
          (op, path) => op === "unlink" && path.endsWith(".quarantine")) },
      { site: "release: owner read of the lock", first: "acquired",
        fault: () => failOnce((op, path) => op === "open" && path.endsWith(".lock/owner.json"), undefined, "EMFILE") },
      { site: "release: rename of the lock away", first: "acquired",
        fault: () => failOnce((op, path) => op === "rename" && path.endsWith(".released")) },
      { site: "release: directory fsync after the lock's rename", first: "acquired",
        fault: (locks: string) => failOnce((op, path) => op === "sync" && path === locks,
          (op, path) => op === "rename" && path.endsWith(".released")) },
      { site: "release: removal of the released lock", first: "acquired",
        fault: () => failOnce((op, path) => op === "rm" && path.endsWith(".released")) },
    ];
    const outcomes = [];
    for (const { site, fault } of sites) {
      const dir = await freshDir();
      const store = await createFsLiquidityTankStore({ dir, lockTimeoutMs: 2_000 });
      const locks = join(dir, "locks");
      const injected = fault(locks);
      trace.fault = injected;
      const first = await outcome(() => store.claim({ intent, owner: "worker-1", now: T0, leaseDurationMs: 1_000 }));
      trace.fault = undefined;
      // Never reclaims within the test: only a released lock lets it in.
      const second = await createFsLiquidityTankStore({ dir, lockStaleMs: 600_000, lockTimeoutMs: 1_000 });
      outcomes.push({
        site,
        fired: injected.state.fired,
        first: first.startsWith("threw: ") ? "rejected" : first,
        leftovers: await readdir(locks),
        second: await outcome(() => second.claim({ intent, owner: "worker-2", now: T0, leaseDurationMs: 1_000 })),
      });
    }
    expect(outcomes).toEqual(sites.map(({ site, first }) => ({
      site,
      fired: true,
      first,
      leftovers: [],
      second: first === "acquired" ? "waiting" : "acquired",
    })));
  }, 120_000);

  test("a release that keeps failing fails the call, and its lock is reclaimed by this live process after the stale age", async () => {
    const dir = await freshDir();
    const first = await createFsLiquidityTankStore({ dir, lockTimeoutMs: 200 });
    trace.fault = (operation, path) =>
      operation === "open" && path.endsWith(".lock/owner.json") ? "EMFILE" : undefined;
    await expect(first.claim({ intent, owner: "worker-1", now: T0, leaseDurationMs: 1_000 }))
      .rejects.toThrow(/could not release its lock/);
    trace.fault = undefined;
    // The lock is still there: a store that waits out a long stale age cannot take it ...
    const patient = await createFsLiquidityTankStore({ dir, lockStaleMs: 600_000, lockTimeoutMs: 200 });
    await expect(patient.claim({ intent, owner: "worker-2", now: T0, leaseDurationMs: 1_000 }))
      .rejects.toThrow(/timed out acquiring/);
    // ... but once it is stale this process reclaims it, although its PID is alive.
    const reclaiming = await createFsLiquidityTankStore({ dir, lockStaleMs: 1, lockTimeoutMs: 2_000 });
    await expect(reclaiming.claim({ intent, owner: "worker-2", now: T0, leaseDurationMs: 1_000 }))
      .resolves.toMatchObject({ status: "waiting", lease: { owner: "worker-1" } });
    expect(await readdir(join(dir, "locks"))).toEqual([]);
  });
});

describe("createFsLiquidityTankStore locks of other threads and module copies", () => {
  test.skipIf(threadScope() === null)(
    "reclaims a stale lock whose thread has exited, never one a live thread holds or one from another boot or PID namespace",
    async () => {
      const scope = threadScope()!;
      const worker = new Worker(
        "require('node:worker_threads').parentPort.postMessage(require('node:fs').readlinkSync('/proc/thread-self'));" +
          "setInterval(() => {}, 1_000);",
        { eval: true },
      );
      const [self] = await once(worker, "message") as [string];
      const workerTid = Number(self.split("/").pop());
      const attempt = async (tid: number | null, pidScope: string | null) => {
        const dir = await freshDir();
        const store = await createFsLiquidityTankStore({ dir, lockStaleMs: 20, lockTimeoutMs: 300 });
        // What a sibling thread with its own registry leaves: this PID, made since this process started.
        await plantStaleLock(dir, {
          pid: process.pid, tid, pidScope, threadToken: "a-worker-thread", token: randomUUID(),
          createdNs: String(process.hrtime.bigint()),
        });
        return outcome(() => store.claim({ intent, owner: "worker-1", now: T0, leaseDurationMs: 1_000 }));
      };
      const whileAlive = await attempt(workerTid, scope.pidScope);
      await worker.terminate();
      await threadExited(workerTid);
      expect({
        whileAlive,
        afterExit: await attempt(workerTid, scope.pidScope),
        anotherBootOrNamespace: await attempt(workerTid, `another-boot ${scope.pidScope.split(" ")[1]}`),
        unknownThread: await attempt(null, scope.pidScope),
      }).toEqual({
        whileAlive: TIMED_OUT,
        afterExit: "acquired",
        anotherBootOrNamespace: TIMED_OUT,
        unknownThread: TIMED_OUT,
      });
    },
  );

  test.skipIf(threadScope() === null || typeof (nodeModule as { registerHooks?: unknown }).registerHooks !== "function")
    .each(["phase lock", "bridge-ID lock", "reclaim gate"] as const)(
      "a worker thread terminated inside the %s leaves a lock this process reclaims after the stale age, and none while it runs",
      async (stopIn) => {
        const dir = await freshDir();
        // The worker holds phase 0; another phase with the same bridge ID needs its bridge-ID lock.
        const other = createLiquidityTankIntent(authority(1));
        const otherSubmission = { ...submission(), authorityHash: other.bindingHash };
        const { submissionHash: _hash, ...unsignedOther } = otherSubmission;
        otherSubmission.submissionHash = sha256Hex(canonicalize(unsignedOther));
        const worker = new Worker(resolve("test/fixtures/liquidity-tank-fs-worker.mjs"), {
          execArgv: ["--experimental-transform-types"],
          workerData: { repo: process.cwd(), dir, stopIn, intent, submission: submission(), now: T0 },
        });
        const exited = once(worker, "exit");
        expect(await once(worker, "message")).toEqual(["holding"]);
        const attempt = async (lockTimeoutMs: number) => {
          const store = await createFsLiquidityTankStore({ dir, lockStaleMs: 20, lockTimeoutMs });
          if (stopIn !== "bridge-ID lock") {
            return outcome(() => store.claim({ intent, owner: "worker-1", now: T0, leaseDurationMs: 1_000 }));
          }
          const claimed = await store.claim({ intent: other, owner: "worker-1", now: T0, leaseDurationMs: 600_000 });
          if (claimed.status !== "acquired" && claimed.status !== "waiting") return `claimed ${claimed.status}`;
          return outcome(() => store.recordSubmission({
            settlementKey: other.settlementKey, bindingHash: other.bindingHash, owner: "worker-1",
            generation: claimed.lease.generation, now: T0, submission: otherSubmission,
          }));
        };
        const whileRunning = await attempt(300);
        await worker.terminate();
        await exited;
        // The terminated thread's ID leaves the OS's list once the thread is gone.
        const owners = await readdir(join(dir, "locks"));
        expect({ whileRunning, afterTermination: await attempt(10_000), owners: owners.length > 0 }).toEqual({
          whileRunning: TIMED_OUT,
          afterTermination: stopIn === "bridge-ID lock" ? "recorded" : "acquired",
          owners: true,
        });
      },
      60_000,
    );

  test.skipIf(typeof (nodeModule as { registerHooks?: unknown }).registerHooks !== "function")(
    "a thread whose process carries something else under the lock registry's key refuses to open a store",
    async () => {
      const worker = new Worker(resolve("test/fixtures/liquidity-tank-fs-worker.mjs"), {
        execArgv: ["--experimental-transform-types"],
        workerData: { repo: process.cwd(), dir: await freshDir(), stopIn: "corrupt registry", intent,
          submission: submission(), now: T0 },
      });
      const exited = new Promise((done) => worker.once("exit", done));
      await expect(once(worker, "message")).rejects.toThrow(
        "liquidity-tank filesystem store found an unreadable lock registry on this thread",
      );
      await exited;
    },
    60_000,
  );

  test("module copies on one thread share their locks: a copy reclaims another's failed release, and never takes its live lock", async () => {
    vi.resetModules();
    const copy = await import("../../src/rails/liquidityTankFs.js");
    expect(copy.createFsLiquidityTankStore).not.toBe(createFsLiquidityTankStore);

    // A live lock of the first copy, paused inside the phase and bridge-ID locks.
    const liveDir = await freshDir();
    const first = await createFsLiquidityTankStore({ dir: liveDir, lockTimeoutMs: 5_000 });
    const { write } = await acquire(first, "worker-1", T0);
    let resume = (): void => undefined;
    const paused = new Promise<void>((reached) => {
      trace.linkTarget = join(liveDir, "bridges", `${sha256Hex(BRIDGE_ID)}.json`);
      trace.beforeLink = () => {
        reached();
        return new Promise<void>((resumed) => { resume = resumed; });
      };
    });
    const holding = first.recordSubmission({ ...write, submission: submission() });
    await paused;
    const second = await copy.createFsLiquidityTankStore({ dir: liveDir, lockStaleMs: 1, lockTimeoutMs: 300 });
    const live = await outcome(() => second.claim({ intent, owner: "worker-2", now: T0 + 2_000, leaseDurationMs: 1_000 }));
    resume();
    await expect(holding).resolves.toEqual({ status: "recorded" });

    // A lock the first copy left by a failed release: nothing on this thread holds it.
    const leftDir = await freshDir();
    const leaving = await createFsLiquidityTankStore({ dir: leftDir, lockTimeoutMs: 200 });
    trace.fault = (operation, path) =>
      operation === "open" && path.endsWith(".lock/owner.json") ? "EMFILE" : undefined;
    await expect(leaving.claim({ intent, owner: "worker-1", now: T0, leaseDurationMs: 1_000 }))
      .rejects.toThrow(/could not release its lock/);
    trace.fault = undefined;
    const reclaiming = await copy.createFsLiquidityTankStore({ dir: leftDir, lockStaleMs: 1, lockTimeoutMs: 2_000 });
    expect({
      live,
      left: await outcome(() => reclaiming.claim({ intent, owner: "worker-2", now: T0, leaseDurationMs: 1_000 })),
    }).toEqual({ live: TIMED_OUT, left: "waiting" });
  });
});

/** A PID no process here holds: a child's, once it has exited. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  return child.pid as number;
}

/** An owner record of another process; only its PID is read for another PID. */
function processOwner(pid: number, token: string): Record<string, unknown> {
  return { pid, tid: null, pidScope: null, threadToken: `${token}-thread`, token, createdNs: "1" };
}

/** Plants `owner` as a reclaim-gate file at `path`, last modified `ageMs` ago. */
async function plantGateFile(path: string, owner: Record<string, unknown>, ageMs = 60_000): Promise<void> {
  await writeFile(path, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  const when = new Date(Date.now() - ageMs);
  await utimes(path, when, when);
}

const gateFiles = async (dir: string) =>
  (await readdir(join(dir, "locks"))).filter((name) => name.startsWith(".reclaim")).sort();

describe("createFsLiquidityTankStore lock liveness and stale recovery", () => {
  const claimOf = (store: LiquidityTankStore) =>
    outcome(() => store.claim({ intent, owner: "worker-1", now: T0, leaseDurationMs: 1_000 }));

  // Launch review 4: the lock and reclaim paths take a directory fsync the
  // filesystem does not support as done, but a row is never reported written
  // without one, so such a filesystem fails every claim closed.
  test.each(["EINVAL", "ENOSYS", "ENOTSUP"])("a filesystem whose directory fsync fails %s never reports a row written", async (code) => {
    const dir = await freshDir();
    const store = await createFsLiquidityTankStore({ dir });
    const directorySyncs: string[] = [];
    trace.fault = (operation, path) => {
      if (operation !== "sync" || !path.startsWith(dir) || !statSync(path).isDirectory()) return undefined;
      directorySyncs.push(path);
      return code;
    };
    const claim = await claimOf(store);
    trace.fault = undefined;
    // The lock directory's fsync was taken as done; the row's was not.
    expect(directorySyncs).toContain(join(dir, "locks"));
    expect(claim).toMatch(new RegExp(`^threw: .*injected ${code}`));
  });

  test("a stale lock is reclaimed when its owner is another process that has exited, never while it lives", async () => {
    expect(process.ppid).not.toBe(process.pid);
    const outcomes = [];
    for (const [owner, pid] of [["live", process.ppid], ["exited", await exitedPid()]] as const) {
      const dir = await freshDir();
      const store = await createFsLiquidityTankStore({ dir, lockStaleMs: 20, lockTimeoutMs: 400 });
      await plantStaleLock(dir, processOwner(pid, `${owner}-process-lock`));
      outcomes.push({ owner, claim: await claimOf(store) });
    }
    expect(outcomes).toEqual([{ owner: "live", claim: TIMED_OUT }, { owner: "exited", claim: "acquired" }]);
  });

  test.skipIf(threadScope() === null)(
    "a stale lock another listed thread of this process made during this process's lifetime is never reclaimed",
    async () => {
      const dir = await freshDir();
      const store = await createFsLiquidityTankStore({ dir, lockStaleMs: 20, lockTimeoutMs: 400 });
      // Made just after this process started, so only a live-thread check can decide it.
      const startedNs = process.hrtime.bigint() - BigInt(Math.ceil(process.uptime() * 1e9));
      await plantStaleLock(dir, {
        pid: process.pid,
        ...threadScope(),
        threadToken: "another-thread-of-this-process",
        token: "another-thread-lock",
        createdNs: String(startedNs + 2_000_000n),
      });
      expect(await claimOf(store)).toBe(TIMED_OUT);
    },
  );

  test("a stale reclaim gate whose owner is another live process is never quarantined", async () => {
    const dir = await freshDir();
    const store = await createFsLiquidityTankStore({ dir, lockStaleMs: 20, lockTimeoutMs: 400 });
    await plantStaleLock(dir, processOwner(await exitedPid(), "exited-lock"));
    await plantGateFile(join(dir, "locks", ".reclaim"), processOwner(process.ppid, "live-gate"));
    expect({ claim: await claimOf(store), gate: await gateFiles(dir) })
      .toEqual({ claim: TIMED_OUT, gate: [".reclaim"] });
  });

  test("a quarantined gate blocks reclaim while it is fresh or its owner lives, and is removed once neither holds", async () => {
    const outcomes = [];
    for (const [label, pid, ageMs, lockStaleMs] of [
      ["stale, live owner", process.ppid, 60_000, 20],
      ["fresh, exited owner", await exitedPid(), 0, 30_000],
      ["stale, exited owner", await exitedPid(), 60_000, 20],
    ] as const) {
      const dir = await freshDir();
      const store = await createFsLiquidityTankStore({ dir, lockStaleMs, lockTimeoutMs: 400 });
      await plantStaleLock(dir, processOwner(await exitedPid(), "exited-lock"));
      await plantGateFile(join(dir, "locks", `.reclaim.${randomUUID()}.quarantine`), processOwner(pid, "gate"), ageMs);
      outcomes.push({ label, claim: await claimOf(store), quarantines: (await gateFiles(dir)).length });
    }
    expect(outcomes).toEqual([
      { label: "stale, live owner", claim: TIMED_OUT, quarantines: 1 },
      { label: "fresh, exited owner", claim: TIMED_OUT, quarantines: 1 },
      { label: "stale, exited owner", claim: "acquired", quarantines: 0 },
    ]);
  });

  test("a reclaim gate replaced just before its quarantine rename stays as a live quarantine", async () => {
    const dir = await freshDir();
    const store = await createFsLiquidityTankStore({ dir, lockStaleMs: 20, lockTimeoutMs: 400 });
    const gate = join(dir, "locks", ".reclaim");
    await plantStaleLock(dir, processOwner(await exitedPid(), "exited-lock"));
    await plantGateFile(gate, processOwner(await exitedPid(), "exited-gate"));
    const replacement = processOwner(process.ppid, "replacement-gate");
    let replaced = false;
    // Another reclaimer quarantines the stale gate and publishes its own between this one's checks and its rename.
    trace.fault = (operation, path) => {
      if (!replaced && operation === "rename" && path.startsWith(`${gate} -> `) && path.endsWith(".quarantine")) {
        replaced = true;
        unlinkSync(gate);
        writeFileSync(gate, JSON.stringify(replacement), { flag: "wx", mode: 0o600 });
      }
      return undefined;
    };
    const claim = await claimOf(store);
    trace.fault = undefined;
    const left = await gateFiles(dir);
    expect({ replaced, claim, left: left.length }).toEqual({ replaced: true, claim: TIMED_OUT, left: 1 });
    expect(JSON.parse(await readFile(join(dir, "locks", left[0] as string), "utf8"))).toEqual(replacement);
  });

  // The quarantine step deletes the gate it moved only when it is the very gate
  // it found stale and ownerless. Each replacement here differs from that gate
  // in one way only, so one part of the re-check alone keeps it (code P2-8).
  // The modified gate must still read as fresh at the step's re-check, after a
  // rename, a directory fsync, a stat and an owner read: under load that takes
  // longer than 20 ms, so that case allows two seconds before a gate is stale.
  test.each([
    ["another file with the same exited owner", "acquired"],
    ["the same file rewritten for another exited owner", "acquired"],
    ["the same file, modified again", "acquired"],
    ["the same file, its owner's PID live again", TIMED_OUT],
  ] as const)("a stale gate replaced by %s before its quarantine rename is never deleted by that step", async (change, expected) => {
    const dir = await freshDir();
    const modified = change === "the same file, modified again";
    const store = await createFsLiquidityTankStore({
      dir,
      lockStaleMs: modified ? 2_000 : 20,
      lockTimeoutMs: expected === TIMED_OUT ? 400 : modified ? 10_000 : 2_000,
    });
    const gate = join(dir, "locks", ".reclaim");
    const owner = processOwner(await exitedPid(), "exited-gate");
    const otherOwner = processOwner(await exitedPid(), "other-exited-gate");
    await plantStaleLock(dir, processOwner(await exitedPid(), "exited-lock"));
    await plantGateFile(gate, owner);
    const kill = process.kill.bind(process);
    let reused = false;
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => reused && pid === owner.pid ? true : kill(pid, signal));
    const stale = new Date(Date.now() - 60_000);
    let quarantine: string | undefined;
    const onQuarantine: string[] = [];
    trace.fault = (operation, path) => {
      if (quarantine === undefined && operation === "rename" && path.startsWith(`${gate} -> `) && path.endsWith(".quarantine")) {
        quarantine = path.slice(`${gate} -> `.length);
        if (change === "another file with the same exited owner") {
          // Moved away, as another reclaimer would, the old gate keeps its inode number from the new one.
          renameSync(gate, join(dirname(dir), "moved-gate"));
          writeFileSync(gate, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
          utimesSync(gate, stale, stale);
        } else if (change === "the same file rewritten for another exited owner") {
          writeFileSync(gate, JSON.stringify(otherOwner));
          utimesSync(gate, stale, stale);
        } else if (modified) {
          utimesSync(gate, new Date(), new Date());
        } else {
          reused = true;
        }
      } else if (path === quarantine) {
        onQuarantine.push(operation);
      }
      return undefined;
    };
    let claim;
    try {
      claim = await claimOf(store);
    } finally {
      trace.fault = undefined;
      vi.restoreAllMocks();
    }
    // The step's own stat comes first; a later one is the next poll's scan of live quarantines.
    const removal = onQuarantine.indexOf("unlink");
    const statsBeforeRemoval = onQuarantine.slice(0, removal === -1 ? undefined : removal)
      .filter((operation) => operation === "stat").length;
    expect({ moved: quarantine !== undefined, claim, deletedByTheQuarantineStep: removal !== -1 && statsBeforeRemoval === 1 })
      .toEqual({ moved: true, claim: expected, deletedByTheQuarantineStep: false });
    expect((await gateFiles(dir)).length).toBe(expected === TIMED_OUT ? 1 : 0);
  }, 30_000);

  test.each([
    ["the reclaim gate's stat", true,
      (locks: string) => failOnce((op, path) => op === "stat" && path === `${locks}/.reclaim`, undefined, "ENOENT")],
    ["the reclaim gate's quarantine rename", true,
      (locks: string) => failOnce((op, path) => op === "rename" && path.startsWith(`${locks}/.reclaim -> `), undefined, "ENOENT")],
    ["the quarantined gate's stat", true,
      () => failOnce((op, path) => op === "stat" && path.endsWith(".quarantine"), undefined, "ENOENT")],
    // The first stat of the lock is its staleness check before the gate; the second is the re-check under it.
    ["the stale lock's stat under the reclaim gate", false,
      () => failOnce((op, path) => op === "stat" && path.endsWith(".lock"),
        (op, path) => op === "stat" && path.endsWith(".lock"), "ENOENT")],
    ["the stale lock's quarantine rename", false,
      () => failOnce((op, path) => op === "rename" && path.includes(".lock -> ") && path.endsWith(".stale"), undefined, "ENOENT")],
  ])("a path that vanishes at %s is a lost race, and the next poll reclaims", async (_site, staleGate, fault) => {
    const dir = await freshDir();
    const store = await createFsLiquidityTankStore({ dir, lockStaleMs: 20, lockTimeoutMs: 2_000 });
    await plantStaleLock(dir, processOwner(await exitedPid(), "exited-lock"));
    if (staleGate) await plantGateFile(join(dir, "locks", ".reclaim"), processOwner(await exitedPid(), "exited-gate"));
    const injected = fault(join(dir, "locks"));
    trace.fault = injected;
    const claim = await claimOf(store);
    trace.fault = undefined;
    expect({ fired: injected.state.fired, claim }).toEqual({ fired: true, claim: "acquired" });
  });

  test("a reservation staging name that vanishes while it is checked is skipped", async () => {
    const dir = await freshDir();
    const store = await createFsLiquidityTankStore({ dir });
    const reservation = `${sha256Hex(BRIDGE_ID)}.json`;
    const staging = join(dir, "bridges", `.${reservation}.${"0".repeat(48)}.tmp`);
    await writeFile(staging, "{}", { flag: "wx", mode: 0o600 });
    const { write } = await acquire(store, "worker-1", T0);
    const injected = failOnce((op, path) => op === "lstat" && path === staging, undefined, "ENOENT");
    trace.fault = injected;
    const recorded = await store.recordSubmission({ ...write, submission: submission() });
    trace.fault = undefined;
    expect({ fired: injected.state.fired, recorded }).toEqual({ fired: true, recorded: { status: "recorded" } });
  });

  test.each([
    ["another store version", { storeVersion: 2, bridgeId: BRIDGE_ID, settlementKey: intent.settlementKey }],
    ["another bridge ID", { storeVersion: 1, bridgeId: "fsStoreBridge-02", settlementKey: intent.settlementKey }],
    ["a settlement key that is not a string", { storeVersion: 1, bridgeId: BRIDGE_ID, settlementKey: 7 }],
    ["an extra field", { storeVersion: 1, bridgeId: BRIDGE_ID, settlementKey: intent.settlementKey, extra: true }],
  ])("a bridge-ID reservation with %s is corrupt, and the submission is not recorded", async (_label, reservation) => {
    const dir = await freshDir();
    const store = await createFsLiquidityTankStore({ dir });
    await writeFile(join(dir, "bridges", `${sha256Hex(BRIDGE_ID)}.json`), JSON.stringify(reservation),
      { flag: "wx", mode: 0o600 });
    const { write } = await acquire(store, "worker-1", T0);
    await expect(store.recordSubmission({ ...write, submission: submission() }))
      .resolves.toEqual({ status: "corrupt", reason: "liquidity-tank-fs-record-corrupt" });
    const reclaimed = await store.claim({ intent, owner: "worker-1", now: T0 + 1, leaseDurationMs: 1_000 });
    expect(reclaimed).not.toHaveProperty("submission");
  });
});

describe("production execution capabilities", () => {
  const bridgeVerifier: LiquidityTankVerifier = {
    authenticateObservation: async () => true,
    verifySignedSubmission: async () => true,
  };
  test("a plain bridge authenticator cannot authorize production source finality", async () => {
    const store = await createFsLiquidityTankStore({ dir: await freshDir() });
    const prepareSubmission = vi.fn();
    vi.stubEnv("NODE_ENV", "production");
    const input = {
      authority: authority(), owner: "production", store,
      adapter: { prepareSubmission, broadcastRetained: vi.fn(), observe: vi.fn() },
      verifier: bridgeVerifier, resolveAuthority: async () => resolvedAuthority(), now: () => T0,
    };
    await expect(advanceLiquidityTankSettlement(input)).resolves.toMatchObject({
      status: "indeterminate", reason: "liquidity-tank-source-finality-required",
    });
    expect(prepareSubmission).not.toHaveBeenCalled();
  });

  test("a resolved agreement's tank pair must match before any preparation", async () => {
    const store = await createFsLiquidityTankStore({ dir: await freshDir() });
    const prepareSubmission = vi.fn();
    vi.stubEnv("NODE_ENV", "production");
    const input = {
      authority: authority(), owner: "production", store,
      adapter: { prepareSubmission, broadcastRetained: vi.fn(), observe: vi.fn() },
      verifier: createLiquidityTankEvmFinalityVerifier({ verifier: bridgeVerifier, sourceRpcUrl: "https://sepolia.example/" }),
      resolveAuthority: async () => resolvedAuthority({ ...authority(), sourceLiquidityTankId: "wrong-resolved-tank" }), now: () => T0,
    };
    await expect(advanceLiquidityTankSettlement(input)).resolves.toMatchObject({
      status: "indeterminate", reason: "liquidity-tank-resolved-authority-mismatch",
    });
    expect(prepareSubmission).not.toHaveBeenCalled();
  });
});

test.each([
  ["agreement hash", (r: ReturnType<typeof resolvedAuthority>) => { r.authority.agreementHash = "e".repeat(64); }],
  ["SR-5 binding hash", (r: ReturnType<typeof resolvedAuthority>) => { r.authority.sr5BindingHash = "e".repeat(64); }],
  ["descriptor hash", (r: ReturnType<typeof resolvedAuthority>) => { r.authority.railDescriptorHash = "e".repeat(64); }],
  ["destination", (r: ReturnType<typeof resolvedAuthority>) => { r.authority.destinationAddress = "another-destination"; }],
  ["resolved tank IDs", (r: ReturnType<typeof resolvedAuthority>) => { r.rail.asset.routes[0]!.liquidityTankIds = ["unapproved-source", "unapproved-destination"]; }],
  ["resolved route", (r: ReturnType<typeof resolvedAuthority>) => { r.rail.asset.routes[0]!.destChainId = 1; }],
  ["resolved currency", (r: ReturnType<typeof resolvedAuthority>) => { r.rail.asset.canonicalSymbol = "USDT"; }],
] as const)("production rejects a mismatched %s before claiming or preparing", async (_label, rewrite) => {
  const resolved = resolvedAuthority();
  rewrite(resolved);
  const store = await createFsLiquidityTankStore({ dir: await freshDir() });
  const prepareSubmission = vi.fn();
  vi.stubEnv("NODE_ENV", "production");
  await expect(advanceLiquidityTankSettlement({ authority: authority(), owner: "production", store,
    adapter: { prepareSubmission, broadcastRetained: vi.fn(), observe: vi.fn() },
    verifier: createLiquidityTankEvmFinalityVerifier({
      verifier: { authenticateObservation: () => true, verifySignedSubmission: () => true }, sourceRpcUrl: "https://sepolia.example/",
    }), resolveAuthority: async () => resolved, now: () => T0,
  })).resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-resolved-authority-mismatch" });
  expect(prepareSubmission).not.toHaveBeenCalled();
  await expect(store.claim({ intent, owner: "inspect", now: T0, leaseDurationMs: 1_000 })).resolves.toMatchObject({ status: "acquired", lease: { generation: 1 } });
});

test("test mode accepts an authorized tank pair, reopens it, and rechecks saved success against the source", async () => {
  const dir = await freshDir();
  let sourceAvailable = true;
  const lockHash = `0x${"1".repeat(64)}`;
  const blockHash = `0x${"2".repeat(64)}`;
  const verifier = createLiquidityTankEvmFinalityVerifier({
    verifier: { authenticateObservation: () => true, verifySignedSubmission: () => true },
    sourceRpcUrl: "https://sepolia.example/",
    fetch: async (_url, init) => {
      const { id, method } = JSON.parse(init?.body as string);
      const result = method === "eth_chainId" ? "0xaa36a7" : method === "eth_getTransactionReceipt"
        ? sourceAvailable ? { transactionHash: lockHash, blockHash, blockNumber: "0x10", status: "0x1" } : null
        : { hash: blockHash, number: "0x10", transactions: [lockHash] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));
    },
  });
  let observed: LiquidityTankObservation = { status: "empty", bridgeId: BRIDGE_ID, operationHash: intent.operationHash,
    history: ["empty"], observedAt: T0, authenticationHash: "a".repeat(64) };
  const prepareSubmission = vi.fn<LiquidityTankAdapter["prepareSubmission"]>(async () => {
    const { submissionHash: _hash, ...unsigned } = submission();
    return unsigned;
  });
  const broadcastRetained = vi.fn<LiquidityTankAdapter["broadcastRetained"]>(async () => {
    observed = { status: "completed", bridgeId: BRIDGE_ID, operationHash: intent.operationHash,
      history: ["empty", "pending", "completed"], observedAt: T0 + 10, finalityObservedAt: T0 + 10,
      lockTxHash: lockHash, releaseTxHash: "fs-release-tx", recoveryDeadline: DEADLINE, authenticationHash: "a".repeat(64) };
  });
  const resolved = resolvedAuthority();
  // The Standard allows string chain IDs and multiple authorized tank IDs.
  const route = resolved.rail.asset.routes[0]!;
  const allowed = { ...resolved, rail: { ...resolved.rail, asset: { ...resolved.rail.asset, routes: [{
    ...route, sourceChainId: String(route.sourceChainId), destChainId: String(route.destChainId),
    liquidityTankIds: ["another-authorized-tank", ...route.liquidityTankIds],
  }] } } };
  vi.stubEnv("NODE_ENV", "test");
  const run = async (owner: string) => advanceLiquidityTankSettlement({ authority: authority(), owner,
    store: await createFsLiquidityTankStore({ dir }), verifier, resolveAuthority: async () => allowed,
    adapter: { prepareSubmission, broadcastRetained, observe: async () => observed }, now: () => T0 + 100, leaseDurationMs: 1_000,
  });
  await expect(run("first")).resolves.toMatchObject({ status: "settled" });
  await expect(run("reopened")).resolves.toMatchObject({ status: "settled" });
  sourceAvailable = false;
  await expect(run("source-outage")).resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-verifier-unavailable" });
  sourceAvailable = true;
  await expect(run("restored")).resolves.toMatchObject({ status: "settled" });
  expect(prepareSubmission).toHaveBeenCalledTimes(1);
  expect(broadcastRetained).toHaveBeenCalledTimes(1);
}, 30_000);

test("a Unicode job ID in resolved authority cannot be repaired by its snapshot", async () => {
  const a = { ...authority(), jobId: "01JZ0000000000000000000K01" };
  const resolved = resolvedAuthority({ ...a, jobId: a.jobId.replace("K", "\u212a") });
  const store = await createFsLiquidityTankStore({ dir: await freshDir() });
  const prepareSubmission = vi.fn();
  vi.stubEnv("NODE_ENV", "production");
  await expect(advanceLiquidityTankSettlement({ authority: a, owner: "production", store,
    adapter: { prepareSubmission, broadcastRetained: vi.fn(), observe: vi.fn() },
    verifier: createLiquidityTankEvmFinalityVerifier({
      verifier: { authenticateObservation: () => true, verifySignedSubmission: () => true }, sourceRpcUrl: "https://sepolia.example/",
    }), resolveAuthority: async () => resolved, now: () => T0,
  })).resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-authority-resolver-unavailable" });
  expect(prepareSubmission).not.toHaveBeenCalled();
});

test("a corrected expiry survives a filesystem reopen without another submission", async () => {
  const dir = await freshDir();
  const original = await createFsLiquidityTankStore({ dir });
  const first = await acquire(original, "first", T0);
  await original.recordSubmission({ ...first.write, submission: submission() });
  const takeover = await acquire(original, "after-deadline", DEADLINE + 1);
  const checkpoint = lockedPending(DEADLINE + 1);
  await expect(original.recordObservation({ ...takeover.write, observation: checkpoint })).resolves.toEqual({ status: "recorded" });
  await expect(original.recordRecoveryExpired({ ...takeover.write, expectedObservation: checkpoint, observation: checkpoint as never })).resolves.toEqual({ status: "recorded" });
  const prepareSubmission = vi.fn();
  const broadcastRetained = vi.fn();
  const completion: LiquidityTankObservation = { status: "completed", bridgeId: BRIDGE_ID, operationHash: intent.operationHash,
    history: ["empty", "pending", "completed"], observedAt: T0 + 20, finalityObservedAt: T0 + 20,
    lockTxHash: checkpoint.lockTxHash!, releaseTxHash: "fs-release-tx", recoveryDeadline: DEADLINE, authenticationHash: "a".repeat(64) };
  await expect(advanceLiquidityTankSettlement({ authority: authority(), owner: "reconcile",
    store: await createFsLiquidityTankStore({ dir }), now: () => DEADLINE + 100,
    verifier: { authenticateObservation: () => true, verifySignedSubmission: () => true },
    adapter: { prepareSubmission, broadcastRetained, observe: async () => completion },
  })).resolves.toMatchObject({ status: "settled" });
  const reopened = await createFsLiquidityTankStore({ dir });
  await expect(reopened.claim({ intent, owner: "inspect", now: DEADLINE + 101, leaseDurationMs: 100 })).resolves.toMatchObject({
    status: "settled", settlement: { txRef: { releaseTxHash: "fs-release-tx" } },
  });
  expect(prepareSubmission).not.toHaveBeenCalled();
  expect(broadcastRetained).not.toHaveBeenCalled();
}, 30_000);

test.each(["observation", "failure", "expiry", "settlement", "reconciliation"])(
  "sweep F2: recovered %s publication must finish its records-directory barrier", async (kind) => {
    const dir = await freshDir();
    const store = await createFsLiquidityTankStore({ dir });
    const { write } = await acquire(store, "writer", DEADLINE + 5);
    await store.recordSubmission({ ...write, submission: submission() });
    const checkpoint = lockedPending(DEADLINE + 1);
    await store.recordObservation({ ...write, observation: checkpoint });
    const completed = { status: "completed" as const, bridgeId: BRIDGE_ID, operationHash: intent.operationHash,
      history: ["empty", "pending", "completed"] as ["empty", "pending", "completed"],
      observedAt: DEADLINE + 2, finalityObservedAt: T0 + 20, authenticationHash: "a".repeat(64),
      lockTxHash: checkpoint.lockTxHash!, releaseTxHash: "fs-release-tx", recoveryDeadline: DEADLINE };
    const failure = { status: "failed-after-lock" as const, checkpoint: checkpoint as never,
      failure: { status: "failed" as const, bridgeId: BRIDGE_ID, operationHash: intent.operationHash,
        history: ["empty", "pending", "failed"] as ["empty", "pending", "failed"],
        observedAt: DEADLINE + 2, authenticationHash: "a".repeat(64),
        lockTxHash: checkpoint.lockTxHash!, recoveryDeadline: DEADLINE, reason: "shard failed" } };
    const expiryInput = { ...write, expectedObservation: checkpoint, observation: checkpoint as never };
    if (kind === "settlement") await store.recordObservation({ ...write, observation: completed });
    if (kind === "reconciliation") await store.recordRecoveryExpired(expiryInput);
    const publish = (s: LiquidityTankStore) => kind === "observation" ? s.recordObservation({ ...write, observation: completed })
      : kind === "failure" ? s.recordRecoveryFailure({ ...write, recoveryFailure: failure })
      : kind === "expiry" ? s.recordRecoveryExpired(expiryInput)
      : kind === "reconciliation" ? s.reconcileRecoveryExpired!({ settlementKey: intent.settlementKey,
        bindingHash: intent.bindingHash, expectedEvidence: checkpoint as never, completion: completed })
      : s.recordSettlement({ ...write, settlement: { txRef: { kind: "liquidity-tank", bridgeId: BRIDGE_ID,
        sourceChainId: intent.sourceChainId, destChainId: intent.destinationChainId,
        lockTxHash: completed.lockTxHash, releaseTxHash: completed.releaseTxHash, recoveryDeadline: DEADLINE },
        paymentAmount: { amount: intent.amount, currency: intent.currency },
        settlementFinality: { model: "liquidity-tank", finalityObservedAt: completed.finalityObservedAt },
        authenticationHash: completed.authenticationHash } });
    const records = join(dir, "records");
    const row = join(records, `${sha256Hex(intent.settlementKey)}.json`);
    trace.root = dir;
    // Fail only after rename, so a visible but unacknowledged row remains.
    trace.fault = (op, path) => op === "sync" && path === records &&
      trace.events.some((event) => event.endsWith(` -> ${row}`)) ? "EIO" : undefined;
    await expect(publish(store)).rejects.toMatchObject({ code: "EIO" });
    const reopened = await createFsLiquidityTankStore({ dir });
    await expect(publish(reopened)).rejects.toMatchObject({ code: "EIO" });
    await expect(reopened.claim({ intent, owner: "retry", now: DEADLINE + 6, leaseDurationMs: 1_000 }))
      .rejects.toMatchObject({ code: "EIO" });
    trace.fault = undefined;
    trace.events.length = 0;
    await expect(publish(reopened)).resolves.toMatchObject({ status: "existing" });
    expect(trace.events).toContain(`sync ${records}`);
    expect(trace.events.some((event) => event.endsWith(` -> ${row}`))).toBe(false);
  }, 30_000,
);

test("sweep daybreak 1 / survivor 1546: production without a resolver cannot claim or prepare", async () => {
  const store = await createFsLiquidityTankStore({ dir: await freshDir() });
  const prepareSubmission = vi.fn();
  const broadcastRetained = vi.fn();
  vi.stubEnv("NODE_ENV", "production");
  await expect(advanceLiquidityTankSettlement({ authority: authority(), owner: "production", store,
    adapter: { prepareSubmission, broadcastRetained, observe: vi.fn() },
    verifier: createLiquidityTankEvmFinalityVerifier({
      verifier: { authenticateObservation: () => true, verifySignedSubmission: () => true },
      sourceRpcUrl: "https://sepolia.example/",
    }), now: () => T0,
  })).resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-authority-resolver-unavailable" });
  expect(prepareSubmission).not.toHaveBeenCalled();
  expect(broadcastRetained).not.toHaveBeenCalled();
  await expect(store.claim({ intent, owner: "inspect", now: T0, leaseDurationMs: 1_000 }))
    .resolves.toMatchObject({ status: "acquired", lease: { generation: 1 } });
});

test.each(["production", "staging", "unset"])(
  "sweep F4 / daybreak 2,3: %s refuses unreviewed effectful preparation and host-asserted proofs", async (environment) => {
    const dir = await freshDir();
    const prepareSubmission = vi.fn(async () => {
      // Simulate an adapter's value-moving prepare that crashes before retention.
      throw new Error("external effect happened before WAL");
    });
    const broadcastRetained = vi.fn();
    const verifier = createLiquidityTankEvmFinalityVerifier({
      verifier: { authenticateObservation: () => true, verifySignedSubmission: () => true },
      sourceRpcUrl: "https://sepolia.example/",
    });
    vi.stubEnv("NODE_ENV", environment === "unset" ? undefined : environment);
    for (const owner of ["first", "restart"]) {
      await expect(advanceLiquidityTankSettlement({ authority: authority(), owner,
        store: await createFsLiquidityTankStore({ dir }), verifier, resolveAuthority: async () => resolvedAuthority(),
        adapter: { prepareSubmission, broadcastRetained, observe: vi.fn() }, now: () => T0,
      })).resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-production-integration-unavailable" });
    }
    expect(prepareSubmission).not.toHaveBeenCalled();
    expect(broadcastRetained).not.toHaveBeenCalled();
    await expect((await createFsLiquidityTankStore({ dir })).claim({ intent, owner: "inspect", now: T0, leaseDurationMs: 1_000 }))
      .resolves.toMatchObject({ status: "acquired", lease: { generation: 1 } });
  }, 30_000,
);

test.each(["forged-release", "wrong-signed-amount"])(
  "sweep F4: finalized source receipt and host true cannot authorize %s in production", async (kind) => {
    const dir = await freshDir();
    const lockHash = `0x${"1".repeat(64)}`;
    const blockHash = `0x${"2".repeat(64)}`;
    let sent = false;
    const prepareSubmission = vi.fn(async () => {
      const { submissionHash: _hash, ...unsigned } = submission();
      return { ...unsigned, signedSubmissionBase64: Buffer.from(kind).toString("base64") };
    });
    const broadcastRetained = vi.fn(async () => { sent = true; });
    const verifier = createLiquidityTankEvmFinalityVerifier({ sourceRpcUrl: "https://sepolia.example/",
      verifier: { authenticateObservation: () => true, verifySignedSubmission: () => true },
      fetch: async (_url, init) => {
        const { id, method } = JSON.parse(init?.body as string);
        const result = method === "eth_chainId" ? "0xaa36a7" : method === "eth_getTransactionReceipt"
          ? { transactionHash: lockHash, blockHash, blockNumber: "0x10", status: "0x1" }
          : { hash: blockHash, number: "0x10", transactions: [lockHash] };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));
      },
    });
    const observe = vi.fn(async (): Promise<LiquidityTankObservation> => sent
      ? { status: "completed", bridgeId: BRIDGE_ID, operationHash: intent.operationHash,
        history: ["empty", "pending", "completed"], observedAt: T0 + 1, finalityObservedAt: T0 + 1,
        lockTxHash: lockHash, releaseTxHash: "fabricated-release", recoveryDeadline: DEADLINE, authenticationHash: "a".repeat(64) }
      : { status: "empty", bridgeId: BRIDGE_ID, operationHash: intent.operationHash,
        history: ["empty"], observedAt: T0, authenticationHash: "a".repeat(64) });
    vi.stubEnv("NODE_ENV", "production");
    await expect(advanceLiquidityTankSettlement({ authority: authority(), owner: "production",
      store: await createFsLiquidityTankStore({ dir }), verifier, resolveAuthority: async () => resolvedAuthority(),
      adapter: { prepareSubmission, broadcastRetained, observe }, now: () => T0,
    })).resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-production-integration-unavailable" });
    expect(prepareSubmission).not.toHaveBeenCalled();
    expect(broadcastRetained).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  }, 30_000,
);

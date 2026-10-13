import { spawn } from "node:child_process";
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
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
      inject("unlink", String(path));
      await actual.unlink(path);
    },
    rm: async (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      inject("rm", String(path));
      await actual.rm(path, options);
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
  trace.fault = undefined;
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
    await expect(run("worker-1")).resolves.toMatchObject({ status: "settle-asymmetric" });
    now += 2_000;
    await expect(run("worker-2")).resolves.toMatchObject({ status: "settle-asymmetric" });
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
});

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
      const lock = join(dir, "locks", `${sha256Hex(intent.settlementKey)}.lock`);
      await mkdir(lock, { mode: 0o700 });
      await writeFile(join(lock, "owner.json"), JSON.stringify({
        pid: process.pid,
        processToken: "another-process-token",
        token: "its-lock-token",
        createdNs: String(createdNs),
      }), { flag: "wx", mode: 0o600 });
      const stale = new Date(Date.now() - 60_000);
      await utimes(lock, stale, stale);
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

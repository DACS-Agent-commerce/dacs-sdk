import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execute = promisify(execFile);
const DAY = 24 * 60 * 60 * 1000;
const WINDOW = DAY - 5 * 60 * 1000;
const START = 1000;
interface Result {
  pid: number;
  progress: { status: string; reason?: string };
  state: { effects: number; posts: Array<{ key: string; body: string }> };
  reads: number;
}
async function worker(root: string, time: number, behavior = "ok", delay = 0, jws?: string): Promise<Result> {
  const { stdout } = await execute(process.execPath, [
    "--loader", fileURLToPath(new URL("../fixtures/settlementProcessLoader.mjs", import.meta.url)),
    fileURLToPath(new URL("../fixtures/ap2StripeRecoveryWorker.ts", import.meta.url)),
    root, String(time), behavior, String(delay), ...(jws === undefined ? [] : [jws]),
  ], { timeout: 20_000, env: { ...process.env, DACS_TEST_TRANSPILE_CACHE: join(root, "transpiled") } });
  return JSON.parse(stdout) as Result;
}

// AP2-7: a phase is bound to its first transaction_id. A second checkout for an
// occupied (jobId, phaseIndex) must not get a fresh record and replay deadline,
// or it re-posts the same AP2-6 key after Stripe has pruned it.
test.each([1000, DAY + 1])("a different checkout for a charged phase is refused after restart at +%i ms", async (elapsed) => {
  const root = await mkdtemp(join(tmpdir(), "dacs-stripe-other-checkout-"));
  try {
    const first = await worker(root, START, "lost");
    expect(first.state.effects).toBe(1);
    const retry = await worker(root, START + elapsed, "ok", 0, "e31.e30.c2ln");
    expect(retry.pid).not.toBe(first.pid);
    expect(retry.progress).toEqual({ status: "failed", reason: "ap2-phase-bound-to-another-transaction" });
    expect(retry.state.effects).toBe(1);
    expect(retry.state.posts).toEqual(first.state.posts);
    expect(retry.reads).toBe(0);
    // The first checkout still owns the phase and recovers under its own deadline.
    const same = await worker(root, START + elapsed);
    expect(same.state.effects).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 40_000);

// The reviewer provider-retention probe, made permanent and run in fresh OS processes.
test("a retained deadline still blocks a restarted wrapper that omits the window", async () => {
  const root = await mkdtemp(join(tmpdir(), "dacs-stripe-policy-"));
  try {
    const first = await worker(root, START, "lost");
    expect(first.progress.status).toBe("indeterminate");
    expect(first.state.effects).toBe(1);
    const retry = await worker(root, START + DAY + 1, "omit-window");
    expect(retry.pid).not.toBe(first.pid);
    expect(retry.progress).toEqual({
      status: "failed", reason: "pay-ap2: noReferenceReplayWindowMs must be a positive safe integer",
    });
    expect(retry.state.effects).toBe(1);
    expect(retry.state.posts).toEqual(first.state.posts);
    expect(retry.reads).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 25_000);

test.each([WINDOW - 1, DAY * 2])("a restarted wrapper cannot change the retained replay policy to %i ms", async (window) => {
  const root = await mkdtemp(join(tmpdir(), "dacs-stripe-policy-change-"));
  try {
    const first = await worker(root, START, "lost");
    const retry = await worker(root, START + 1000, "change-window", window);
    expect(retry.pid).not.toBe(first.pid);
    // Same transaction_id, job and phase with a changed policy: an operation conflict.
    expect(retry.progress).toEqual({ status: "failed", reason: "ap2-retained-operation-conflict" });
    expect(retry.state.effects).toBe(1);
    expect(retry.state.posts).toEqual(first.state.posts);
    expect(retry.reads).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 25_000);

test.each([1000, WINDOW - 1, WINDOW, WINDOW + 1, DAY + 1])(
  "lost Stripe response stays one charge after restart at +%i ms", async (elapsed) => {
    const root = await mkdtemp(join(tmpdir(), "dacs-stripe-restart-"));
    try {
      const first = await worker(root, START, "lost");
      expect(first.progress.status).toBe("indeterminate");
      expect(first.state.effects).toBe(1);
      const retry = await worker(root, START + elapsed);
      expect(retry.pid).not.toBe(first.pid);
      expect(retry.state.effects).toBe(1);
      if (elapsed < WINDOW) {
        expect(retry.progress.status).toBe("settled");
        expect(retry.state.posts).toHaveLength(2);
        expect(retry.state.posts[1]).toEqual(retry.state.posts[0]);
      } else {
        expect(retry.progress).toEqual({ status: "indeterminate", reason: "ap2-provider-replay-window-expired" });
        expect(retry.state.posts).toHaveLength(1);
        expect(retry.reads).toBe(0);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 25_000,
);

// A real kill, not a lost response: inside the window the restart replays the
// same idempotent request; at or past it the kill cannot refresh the deadline.
test.each([1000, WINDOW - 1, WINDOW, DAY + 1])(
  "SIGKILL after charge commit stays one charge after restart at +%i ms", async (elapsed) => {
    const root = await mkdtemp(join(tmpdir(), "dacs-stripe-kill-"));
    try {
      await expect(worker(root, START, "kill")).rejects.toMatchObject({ signal: "SIGKILL" });
      const retry = await worker(root, START + elapsed);
      expect(retry.state.effects).toBe(1);
      if (elapsed < WINDOW) {
        expect(retry.progress.status).toBe("settled");
        expect(retry.state.posts).toHaveLength(2);
        expect(retry.state.posts[1]).toEqual(retry.state.posts[0]);
      } else {
        expect(retry.progress).toEqual({ status: "indeterminate", reason: "ap2-provider-replay-window-expired" });
        expect(retry.state.posts).toHaveLength(1);
        expect(retry.reads).toBe(0);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 25_000,
);

// Reserved, never dispatched: the binding and its replay deadline are durable
// before the provider request, so a restart sends that one request in time or none.
test.each([1000, WINDOW - 1, WINDOW, DAY + 1])(
  "SIGKILL after reserve, before dispatch, charges at most once after restart at +%i ms", async (elapsed) => {
    const root = await mkdtemp(join(tmpdir(), "dacs-stripe-reserve-kill-"));
    try {
      await expect(worker(root, START, "kill-before-submit")).rejects.toMatchObject({ signal: "SIGKILL" });
      const retry = await worker(root, START + elapsed);
      if (elapsed < WINDOW) {
        expect(retry.progress.status).toBe("settled");
        expect(retry.state.effects).toBe(1);
        expect(retry.state.posts).toHaveLength(1);
      } else {
        expect(retry.progress).toEqual({ status: "indeterminate", reason: "ap2-provider-replay-window-expired" });
        expect(retry.state).toEqual({ effects: 0, posts: [] });
        expect(retry.reads).toBe(0);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 25_000,
);

test.each([false, true])("a retained reference recovers after expiry (legacy=%s)", async (legacy) => {
  const root = await mkdtemp(join(tmpdir(), "dacs-stripe-reference-"));
  try {
    expect((await worker(root, START, "pending")).progress.status).toBe("indeterminate");
    if (legacy) {
      const records = join(root, "binding", "records");
      const [file] = await readdir(records);
      const path = join(records, file!);
      const record = JSON.parse(await readFile(path, "utf8"));
      delete record.replayDeadline;
      await writeFile(path, JSON.stringify(record));
    }
    const retry = await worker(root, START + DAY + 1);
    expect(retry.progress.status).toBe("settled");
    expect(retry.state.effects).toBe(1);
    expect(retry.state.posts).toHaveLength(1);
    expect(retry.reads).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 25_000);

test("legacy records without a deadline refuse no-reference replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "dacs-stripe-legacy-"));
  try {
    await worker(root, START, "lost");
    const records = join(root, "binding", "records");
    const [file] = await readdir(records);
    const path = join(records, file!);
    const record = JSON.parse(await readFile(path, "utf8"));
    delete record.replayDeadline;
    await writeFile(path, JSON.stringify(record));
    const retry = await worker(root, START + 1000);
    expect(retry.state.posts).toHaveLength(1);
    expect(retry.progress).toEqual({ status: "indeterminate", reason: "ap2-provider-replay-window-expired" });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 25_000);

test.each([WINDOW, -1])("Stripe rechecks dispatch time after a clock change of %i ms", async (delay) => {
  const root = await mkdtemp(join(tmpdir(), "dacs-stripe-delay-"));
  try {
    const result = await worker(root, START, "delay", delay);
    expect(result.state.effects).toBe(0);
    expect(result.state.posts).toHaveLength(0);
    expect(result.progress).toEqual({ status: "indeterminate", reason: "ap2-provider-replay-window-expired" });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 25_000);

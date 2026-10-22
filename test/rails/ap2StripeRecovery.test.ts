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
  ], { timeout: 20_000, env: { ...process.env, DACS_TEST_TRANSPILE_CACHE: join(root, "transpiled"), DACS_TEST_AP2_PUBLICATION: ["before-phase", "after-phase", "before-record", "after-record"].includes(behavior) ? behavior : "" } });
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

// Kill the real writer at all four publication edges, then recover in
// independent OS processes. Before phase publication no payment was reserved;
// after it the original checkout owns the phase even if its record is absent.
test.each(["before-phase", "after-phase", "before-record", "after-record"])(
  "SIGKILL at %s preserves ownership and a single retained replay deadline", async (point) => {
    const root = await mkdtemp(join(tmpdir(), "dacs-ap2-publication-"));
    try {
      await expect(worker(root, START, point)).rejects.toMatchObject({ signal: "SIGKILL" });
      const marker = JSON.parse(await readFile(join(root, "publication-kill.json"), "utf8"));
      expect(marker.point).toBe(point);
      const records = join(root, "binding", "records");
      const phases = join(root, "binding", "phases");
      expect((await readdir(phases)).filter(name => name.endsWith(".json"))).toHaveLength(point === "before-phase" ? 0 : 1);
      expect((await readdir(records)).filter(name => name.endsWith(".json"))).toHaveLength(point === "after-record" ? 1 : 0);
      const retainedBefore = point === "after-record"
        ? JSON.parse(await readFile(join(records, (await readdir(records)).find(name => name.endsWith(".json"))!), "utf8"))
        : undefined;
      // After the reservation, even an expired provider-retention period must
      // not allow another checkout to refresh this payment's replay window.
      if (point !== "before-phase") {
        const other = await worker(root, START + DAY + 1, "ok", 0, "e31.e30.c2ln");
        expect(other.pid).not.toBe(marker.pid);
        expect(other.progress).toEqual({ status: "failed", reason: "ap2-phase-bound-to-another-transaction" });
        expect(other.state.effects).toBe(0);
      }
      const resumed = await worker(root, START + 1000);
      expect(resumed.pid).not.toBe(marker.pid);
      expect(resumed.progress.status).toBe("settled");
      expect(resumed.state.effects).toBe(1);
      const paths = (await readdir(records)).filter(name => name.endsWith(".json"));
      expect(paths).toHaveLength(1);
      const retained = JSON.parse(await readFile(join(records, paths[0]!), "utf8"));
      expect(retained.createdAt).toBe(retainedBefore?.createdAt ?? START + 1000);
      expect(retained.replayDeadline).toBe(retainedBefore?.replayDeadline ?? START + 1000 + WINDOW);
      const repeated = await worker(root, START + DAY + 1);
      expect(repeated.state.effects).toBe(1);
      expect(repeated.state.posts).toEqual(resumed.state.posts);
      const other = await worker(root, START + DAY + 2, "ok", 0, "e31.e30.c2ln");
      expect(other.progress).toEqual({ status: "failed", reason: "ap2-phase-bound-to-another-transaction" });
      expect(other.state.effects).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 40_000,
);


test("same open store refuses a competing checkout first after phase loss and provider expiry", async () => {
  const root = await mkdtemp(join(tmpdir(), "dacs-ap2-open-phase-loss-"));
  try {
    const result = await worker(root, START, "phase-loss");
    expect(result.progress).toEqual({ status: "failed", reason: "ap2-phase-bound-to-another-transaction" });
    expect(result.state.effects).toBe(1);
    expect(result.state.posts).toHaveLength(1);
    expect(result.reads).toBe(0);
    expect((await readdir(join(root, "binding", "records"))).filter(name => name.endsWith(".json"))).toHaveLength(1);
    const retry = await worker(root, START + DAY + 2);
    expect(retry.progress).toEqual({ status: "indeterminate", reason: "ap2-provider-replay-window-expired" });
    expect(retry.state.effects).toBe(1);
    expect(retry.state.posts).toEqual(result.state.posts);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

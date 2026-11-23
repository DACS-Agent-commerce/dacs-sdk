// Runs part of one node:test file's tests, so scripts/ci-shards.mjs can spread one long file over several CI shards.
//
//   node scripts/ci-test-names.mjs <file>     prints the file's top-level test names as a JSON array
//
// listTests lists the names without running any test; runSome runs the file with every other test skipped by exact
// name and reports whether exactly the given tests ran (scripts/ci-test-reporter.mjs is the reporter that records them).
//
// The file is loaded in a child process in which "node:test" resolves to this module, whose test() only records the
// name; it is both the named and the default export, so `import { test } from "node:test"` and
// `import test from "node:test"` both work. The file's own top-level code runs; test bodies never do. Anything else
// the file imports from node:test (describe, it, before, mock, ...) does not exist here, so loading fails instead of
// listing the wrong tests. A name that is not a string, or a test registered with test.only/skip/todo (or any other
// property of the default export, such as test.describe), is refused for the same reason.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const self = import.meta.url;
const MARK = "[ci-test-names] ";

// Module customization hook (runs on the loader thread): "node:test" is this module.
export async function resolve(specifier, context, next) {
  if (specifier === "node:test") return { url: self, shortCircuit: true };
  return next(specifier, context);
}

// The stand-in node:test export.
export function test(name) {
  if (typeof name !== "string" || name === "") throw new Error(`ci-test-names: a test name is not a non-empty string: ${String(name)}`);
  process.stdout.write(`${MARK}${JSON.stringify(name)}\n`);
}

// The default import of node:test is the same test() (it has no only/skip/todo or other properties here).
export default test;

/** The top-level test names registered by file (absolute, or relative to cwd), in registration order. */
export function listTests(file, cwd = process.cwd()) {
  const register = `data:text/javascript,import{register}from"node:module";register(${encodeURIComponent(JSON.stringify(self))});`;
  const child = spawnSync(process.execPath, ["--import", register, resolvePath(cwd, file)], {
    cwd, encoding: "utf8", maxBuffer: 16 << 20, timeout: 120_000,
  });
  if (child.error) throw new Error(`ci-test-names: ${file}: ${child.error.message}`);
  if (child.status !== 0) {
    const lines = child.stderr.split("\n").map((line) => line.trim()).filter(Boolean);
    const why = lines.find((line) => /^[A-Za-z]*Error\b/.test(line)) ?? lines.at(-1) ?? "no output";
    throw new Error(`ci-test-names: loading ${file} failed (exit ${child.status}): ${why}`);
  }
  return child.stdout.split("\n").filter((line) => line.startsWith(MARK)).map((line) => JSON.parse(line.slice(MARK.length)));
}

/** A --test-skip-pattern value that matches exactly this test name. */
export const exactPattern = (name) => `^${name.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")}$`;

export const SPLIT_RUN_TIMEOUT_MS = 30 * 60_000;
const SPLIT_RUN_KILL_GRACE_MS = 5_000;
const MAX_CAPTURE_BYTES = 16 << 20;

// Share a single pair of terminal listeners across concurrent split runs and remove them when
// the last run closes, so repeated use does not accumulate process listeners.
const activeRuns = new Set();
let parentSignalHandlers;
function trackRun(run) {
  if (process.platform === "win32") return;
  activeRuns.add(run);
  if (parentSignalHandlers) return;
  parentSignalHandlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (!parentSignalHandlers) return;
      for (const active of activeRuns) active.cancelForParent();
      const handlers = parentSignalHandlers;
      parentSignalHandlers = undefined;
      for (const [name, listener] of handlers) process.removeListener(name, listener);
      // Re-raise after this signal dispatch returns to preserve the caller's signal exit status.
      setImmediate(() => process.kill(process.pid, signal));
    };
    parentSignalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
}

function untrackRun(run) {
  if (process.platform === "win32") return;
  activeRuns.delete(run);
  if (activeRuns.size !== 0 || !parentSignalHandlers) return;
  for (const [signal, handler] of parentSignalHandlers) process.removeListener(signal, handler);
  parentSignalHandlers = undefined;
}

/**
 * Runs file (relative to cwd) with node --test, every test of all that is not in given skipped by exact name.
 * The child's output is forwarded as it arrives and also returned. Resolves to the child result and wrong: null when
 * the tests that ran are exactly given (each once) and the TAP count
 * agrees, else why not. A test that listTests missed is not skipped, so it runs and makes wrong non-null.
 */
export async function runSome(file, all, given, { cwd, env = process.env, args = [], timeoutMs = SPLIT_RUN_TIMEOUT_MS, maxCaptureBytes = MAX_CAPTURE_BYTES } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("split test timeout must be a positive finite number");
  if (!Number.isSafeInteger(maxCaptureBytes) || maxCaptureBytes <= 0) throw new RangeError("split test capture limit must be a positive safe integer");
  const out = mkdtempSync(join(tmpdir(), "ci-test-names-"));
  // A node --test process started under another node --test run (NODE_TEST_CONTEXT set) reports to that parent and
  // ignores its own reporters, so the record of what ran would never be written.
  const childEnv = { ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  try {
    const skip = all.filter((name) => !given.includes(name)).map((name) => `--test-skip-pattern=${exactPattern(name)}`);
    const result = await new Promise((settle) => {
      const child = spawn(process.execPath, ["--test", ...args, ...skip, "--test-reporter=tap", "--test-reporter-destination=stdout",
        `--test-reporter=${fileURLToPath(new URL("./ci-test-reporter.mjs", self))}`, `--test-reporter-destination=${join(out, "ran.jsonl")}`, file],
      { cwd, env: childEnv, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      const stdout = [];
      const stderr = [];
      let capturedBytes = 0;
      let outputOverflow = false;
      let error;
      let timedOut = false;
      let timer;
      let killTimer;
      let exitKillTimer;
      let childExited = false;
      let closed = false;
      let stopping = false;
      const killGroup = (signal) => {
        if (child.pid === undefined) return;
        try {
          if (process.platform === "win32") child.kill(signal);
          else process.kill(-child.pid, signal);
        } catch (failure) {
          if (failure.code !== "ESRCH") error ??= failure;
        }
      };
      const groupExists = () => {
        if (child.pid === undefined || process.platform === "win32") return false;
        try { process.kill(-child.pid, 0); return true; }
        catch (failure) { return failure.code !== "ESRCH"; }
      };
      const terminate = () => {
        if (stopping) return;
        stopping = true;
        killGroup("SIGTERM");
        killTimer = setTimeout(() => {
          // On POSIX, signal only a group that still exists; the leader PID may already be reaped.
          if (process.platform === "win32" || groupExists()) killGroup("SIGKILL");
        }, SPLIT_RUN_KILL_GRACE_MS);
        killTimer.unref();
      };
      const forward = (source, destination) => {
        source.on("data", (chunk) => {
          const available = maxCaptureBytes - capturedBytes;
          if (available > 0) {
            const captured = chunk.length <= available ? chunk : chunk.subarray(0, available);
            (source === child.stdout ? stdout : stderr).push(captured);
            capturedBytes += captured.length;
          }
          if (chunk.length > available && !outputOverflow) {
            outputOverflow = true;
            terminate();
          }
          if (!destination.write(chunk)) {
            source.pause();
            destination.once("drain", () => source.resume());
          }
        });
      };
      forward(child.stdout, process.stdout);
      forward(child.stderr, process.stderr);
      child.on("error", (failure) => { error = failure; });
      const trackedRun = {
        cancelForParent() {
          // The runner is about to exit on this signal, so clean the detached group immediately.
          if (!childExited || groupExists()) killGroup("SIGKILL");
          if (child.pid === undefined) child.kill("SIGKILL");
        },
      };
      trackRun(trackedRun);
      timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
      child.on("exit", () => {
        childExited = true;
        clearTimeout(timer);
        // The leader can finish while a descendant holds inherited stdout/stderr open. Clean its
        // process group now, but keep waiting for close so all completed output is captured.
        if (process.platform !== "win32") {
          if (groupExists()) killGroup("SIGTERM");
          exitKillTimer = setTimeout(() => {
            if (!closed && groupExists()) killGroup("SIGKILL");
          }, SPLIT_RUN_KILL_GRACE_MS);
          exitKillTimer.unref();
        }
      });
      child.on("close", (status, signal) => {
        closed = true;
        clearTimeout(timer);
        // `close` may arrive before the grace timer when a background child closed its pipes but
        // ignored SIGTERM. The group existence check avoids signaling a reused, now-stale PID.
        if (childExited && groupExists()) killGroup("SIGKILL");
        clearTimeout(killTimer);
        clearTimeout(exitKillTimer);
        untrackRun(trackedRun);
        settle({ status, signal, error, timedOut, outputOverflow, capturedBytes, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
      });
    });
    const timeout = result.timedOut ? `timed out after ${timeoutMs / 1000} s; ` : "";
    let ran;
    try {
      ran = readFileSync(join(out, "ran.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).name);
    } catch (error) {
      if (!result.timedOut) return { result, wrong: `no list of the tests that ran (${error.message})` };
      // A killed node --test process may not flush its custom reporter. Treat every requested test as unconfirmed.
      ran = [];
    }
    const count = /^# tests (\d+)$/m.exec(result.stdout ?? "");
    const extra = ran.filter((name, index) => !given.includes(name) || ran.indexOf(name) !== index);
    const missing = given.filter((name) => !ran.includes(name));
    const parts = [];
    if (extra.length > 0) parts.push(`ran but not given, or ran twice: ${extra.join(" | ")}`);
    if (missing.length > 0) parts.push(`given but not run: ${missing.join(" | ")}`);
    if (result.outputOverflow) parts.push(`child output exceeded the ${maxCaptureBytes}-byte capture limit`);
    if (parts.length === 0 && Number(count?.[1]) !== given.length) parts.push(`TAP says # tests ${count?.[1] ?? "(none)"}`);
    if (result.timedOut && parts.length === 0) parts.push("every given test finished");
    return { result, wrong: parts.length ? `${timeout}not exactly this shard's ${given.length} tests: ${parts.join("; ")}` : null };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(self) === resolvePath(process.argv[1])) {
  if (process.argv.length !== 3) {
    console.error("usage: ci-test-names.mjs <file>");
    process.exitCode = 2;
  } else {
    process.stdout.write(`${JSON.stringify(listTests(process.argv[2]))}\n`);
  }
}

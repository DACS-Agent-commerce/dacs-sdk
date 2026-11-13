// Runs part of one node:test file's tests, so scripts/ci-shards.mjs can spread one long file over several CI shards.
//
//   node scripts/ci-test-names.mjs <file>     prints the file's top-level test names as a JSON array
//
// listTests lists the names without running any test; runSome runs the file with every other test skipped by exact
// name and reports whether exactly the given tests ran (this module is also the reporter that records them).
//
// The file is loaded in a child process in which "node:test" resolves to this module, whose test() only records the
// name. The file's own top-level code runs; test bodies never do. Anything else the file imports from node:test
// (describe, it, before, mock, ...) does not exist here, so loading fails instead of listing the wrong tests. A name
// that is not a string, or a test registered with test.only/skip/todo, is refused for the same reason.
import { spawnSync } from "node:child_process";
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

/**
 * Runs file (relative to cwd) with node --test, every test of all that is not in given skipped by exact name.
 * Returns the child result and wrong: null when the tests that ran are exactly given (each once) and the TAP count
 * agrees, else why not. A test that listTests missed is not skipped, so it runs and makes wrong non-null.
 */
export function runSome(file, all, given, { cwd, env = process.env, args = [] } = {}) {
  const out = mkdtempSync(join(tmpdir(), "ci-test-names-"));
  // A node --test process started under another node --test run (NODE_TEST_CONTEXT set) reports to that parent and
  // ignores its own reporters, so the record of what ran would never be written.
  const childEnv = { ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  try {
    const skip = all.filter((name) => !given.includes(name)).map((name) => `--test-skip-pattern=${exactPattern(name)}`);
    const result = spawnSync(process.execPath, ["--test", ...args, ...skip, "--test-reporter=tap", "--test-reporter-destination=stdout",
      `--test-reporter=${fileURLToPath(self)}`, `--test-reporter-destination=${join(out, "ran.jsonl")}`, file],
    { cwd, env: childEnv, encoding: "utf8", maxBuffer: 16 << 20 });
    let ran;
    try {
      ran = readFileSync(join(out, "ran.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).name);
    } catch (error) {
      return { result, wrong: `no list of the tests that ran (${error.message})` };
    }
    const count = /^# tests (\d+)$/m.exec(result.stdout ?? "");
    const extra = ran.filter((name, index) => !given.includes(name) || ran.indexOf(name) !== index);
    const missing = given.filter((name) => !ran.includes(name));
    const parts = [];
    if (extra.length > 0) parts.push(`ran but not given, or ran twice: ${extra.join(" | ")}`);
    if (missing.length > 0) parts.push(`given but not run: ${missing.join(" | ")}`);
    if (parts.length === 0 && Number(count?.[1]) !== given.length) parts.push(`TAP says # tests ${count?.[1] ?? "(none)"}`);
    return { result, wrong: parts.length ? `not exactly this shard's ${given.length} tests: ${parts.join("; ")}` : null };
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

/**
 * node:test reporter (--test-reporter=<this file>): one JSON line per top-level test that ran, {"name", "ok"}.
 * Skipped and todo tests are left out, so the lines are the tests that actually ran.
 */
export default async function* ranTests(source) {
  for await (const event of source) {
    if ((event.type !== "test:pass" && event.type !== "test:fail") || event.data.nesting !== 0) continue;
    if (event.data.skip !== undefined || event.data.todo !== undefined) continue;
    yield `${JSON.stringify({ name: event.data.name, ok: event.type === "test:pass" })}\n`;
  }
}

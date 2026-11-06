// Runs a script as an ES module in a fresh Node process, in its own temporary directory.
// The child gets no NODE_OPTIONS and no --import, --loader or --require, so nothing but the
// script itself registers a resolver or hook. Bare specifiers do not resolve from that
// directory; the script receives file URLs in its arguments instead. It reports its result
// by writing result.json beside itself, which keeps the child's whole stdout and stderr
// available for silence assertions.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const CHILD_TIMEOUT_MS = 120_000;
const FORBIDDEN_ARGUMENT = /^--(?:import|loader|experimental-loader|require)\b/;

/** Returns `{status, stdout, stderr, result}`; `result` is the parsed result.json, or null when the child wrote none. */
export function runFreshChild(t, source, args = [], { directory: consumerDirectory } = {}) {
  for (const arg of args) assert.doesNotMatch(String(arg), FORBIDDEN_ARGUMENT);
  const directory = consumerDirectory ?? mkdtempSync(join(tmpdir(), 'dacs-client-fresh-child-'));
  if (!consumerDirectory) t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = join(directory, 'child.mjs');
  writeFileSync(script, source);
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, [script, ...args], { cwd: directory, env, encoding: 'utf8', timeout: CHILD_TIMEOUT_MS });
  let result = null;
  try { result = JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8')); } catch { /* the child wrote no result */ }
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, result };
}

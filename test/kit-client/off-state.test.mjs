// The harness ships nowhere and runs only where the client can: static checks of the package file lists and of the CI workflow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { ADMITTED_DECLARATION, HELD_DECLARATION, admitPurchases } from './purchase-admission-hook.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LOADER_OPTION = `--import=${new URL('./test-loader.mjs', import.meta.url).href}`;
const CLIENT_ADMISSION_STATE = new URL('../../packages/dacs-client/src/dacs/purchase-admission-state.mjs', import.meta.url);
const CHILD_DEADLINE_MS = 60_000;

const repositoryFile = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const packageFiles = (path) => JSON.parse(repositoryFile(path)).files;
const HARNESS_PATHS = ['test/kit-client', 'scripts/run-kit-client-tests.mjs'];
const HARNESS_STEP = 'npm run kit-client:test';
const SELLER_STEP = 'npm run seller:test';
const NODE_22_ONLY = "matrix.node-version == '22'";

const entryReaches = (entry, path) => { const base = entry.replace(/\/+$/, ''); return path === base || path.startsWith(`${base}/`); };
const workflowJobs = () => Object.values(parse(repositoryFile('.github/workflows/ci.yml')).jobs);
const stepsRunning = (command, steps) => steps.filter((step) => step.run === command);

test("P06 off state: no package's files list reaches test/kit-client or the runner", () => {
  for (const entry of packageFiles('package.json')) {
    assert.deepEqual(HARNESS_PATHS.filter((path) => entryReaches(entry, path)), [], `root files entry ${entry}`);
  }
  // A package's entries are relative to its own directory, so only a parent-relative or harness-named entry could reach the harness.
  for (const path of ['packages/dacs-seller/package.json', 'packages/dacs-client/package.json']) {
    assert.deepEqual(packageFiles(path).filter((entry) => entry.includes('..') || entry.includes('kit-client')), [], path);
  }
});

test('P06 CI wiring: ci.yml gains exactly one `run: npm run kit-client:test` step, on the Node 22 leg only, and keeps `run: npm run seller:test` exactly once', () => {
  const jobs = workflowJobs();
  const harness = stepsRunning(HARNESS_STEP, jobs.flatMap((job) => job.steps));
  assert.equal(harness.length, 1);
  assert.equal(harness[0].if, NODE_22_ONLY);
  assert.equal(stepsRunning(SELLER_STEP, jobs.flatMap((job) => job.steps)).length, 1);
  const { steps } = jobs.find((job) => job.steps.includes(harness[0]));
  const position = (command) => steps.indexOf(stepsRunning(command, steps)[0]);
  assert.ok(position(HARNESS_STEP) > position('npm run build'), 'runs after Build');
  // Since the build-test split the seller suite runs in its own shard jobs, so no step order ties the two together.
  if (position(SELLER_STEP) !== -1) assert.ok(position(HARNESS_STEP) > position(SELLER_STEP), 'runs after the seller tests');
});

test('P06 runner wiring: the kit-client:test script names the harness test files, so the repository file-selection check finds every one', () => {
  const command = JSON.parse(repositoryFile('package.json')).scripts['kit-client:test'];
  assert.deepEqual(command.match(/\S+\.test\.mjs/gu), ['test/kit-client/*.test.mjs']);
});

test('P06 runner wiring: the runner refuses to start without test files instead of running every test in the repository', () => {
  const child = spawnSync(process.execPath, ['scripts/run-kit-client-tests.mjs'], { cwd: REPOSITORY_ROOT, encoding: 'utf8', timeout: CHILD_DEADLINE_MS });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /no test files given/);
});

/** Runs node on `args` in a child with this process's environment plus `env`, minus the test runner's own context, so a child `--test` run is a runner of its own. */
function spawnNode(args, env) {
  const inherited = { ...process.env };
  delete inherited.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--experimental-vm-modules', ...args], { cwd: REPOSITORY_ROOT, encoding: 'utf8', timeout: CHILD_DEADLINE_MS, env: { ...inherited, ...env } });
}

/** Runs the teardown probe in a child process and returns what it reported (the host's URL and state directory) with its exit status. */
async function runTeardownProbe() {
  const directory = await mkdtemp(join(tmpdir(), 'TEST-kit-client-probe-'));
  try {
    const out = join(directory, 'probe.json');
    const child = spawnNode(['--test', 'test/kit-client/teardown-probe.mjs'], { NODE_OPTIONS: LOADER_OPTION, KIT_CLIENT_PROBE_OUT: out });
    return { status: child.status, ...JSON.parse(readFileSync(out, 'utf8')) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('harness failure closes hosts, nodes and state locks before a rerun', async () => {
  const first = await runTeardownProbe();
  assert.equal(first.status, 1, 'the probe failed on purpose and exited on its own');
  assert.equal(first.listening, false, 'the failed test left no listening host');
  assert.equal(first.directoryExists, false, 'the failed test left no state directory');
  const rerun = await runTeardownProbe();
  assert.notEqual(rerun.dataDirectory, first.dataDirectory, 'the rerun uses its own isolated state');
  assert.deepEqual([rerun.status, rerun.listening, rerun.directoryExists], [1, false, false]);
});

test('preload drift fails closed and child processes retain real public admission', () => {
  assert.ok((process.env.NODE_OPTIONS ?? '').includes(LOADER_OPTION), 'the runner hands the loader to every child through NODE_OPTIONS');
  const admittedIn = (env) => JSON.parse(spawnNode(['test/kit-client/admission-probe.mjs'], env).stdout).admitted;
  assert.equal(admittedIn({ NODE_OPTIONS: LOADER_OPTION }), true, 'a child with the preload runs the real wrapper admitted');
  assert.equal(admittedIn({ NODE_OPTIONS: '' }), false, 'a child without the preload stays held: the shipped source is unchanged');
  const held = readFileSync(CLIENT_ADMISSION_STATE, 'utf8');
  assert.equal(admitPurchases(held, 'checkout').includes(ADMITTED_DECLARATION), true);
  for (const drifted of [held.replace(HELD_DECLARATION, "export const PURCHASE_ADMISSION = 'held' ;"), '', held + held.slice(held.indexOf(HELD_DECLARATION))]) {
    assert.throws(() => admitPurchases(drifted, 'drifted'), /cannot find the one hold declaration in drifted/);
  }
});

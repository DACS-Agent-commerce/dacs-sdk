// scripts/ci-shards.mjs, scripts/ci-test-names.mjs and the shard entry of scripts/run-seller-tests.mjs: the shard
// split, and the per-test split of a long file.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EVENTS, SHARDS, SPLIT_FILES, WEIGHTS, assign, assignUnits, checkPartition, checkPlan, clientDir, clientFiles, plan, sellerDir,
  sellerFiles, splitTests,
} from "../../scripts/ci-shards.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
import { exactPattern, listTests, runSome } from "../../scripts/ci-test-names.mjs";

function scratch(t, files) {
  const dir = mkdtempSync(join(tmpdir(), "ci-shards-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const SAMPLE = [
  "import { test } from 'node:test';",
  "globalThis.loaded = true;",
  "test('alpha (one)', () => {});",
  'test("beta\'s [two] $x", () => {});',
  "for (const n of [1, 2]) test(`gamma ${n}`, () => {});",
  "test('gamma 1 and more', () => {});",
  "test('throws if run', () => { throw new Error('ran'); });",
].join("\n");
const SAMPLE_NAMES = ["alpha (one)", "beta's [two] $x", "gamma 1", "gamma 2", "gamma 1 and more", "throws if run"];

test("listTests lists every top-level test, loop-made ones included, without running any", (t) => {
  const dir = scratch(t, { "a.test.mjs": SAMPLE });
  assert.deepEqual(listTests("a.test.mjs", dir), SAMPLE_NAMES);
});

test("listTests refuses files it cannot list exactly", (t) => {
  const dir = scratch(t, {
    "skip.test.mjs": "import { test } from 'node:test'; test('a', () => {}); test.skip('b', () => {});",
    "describe.test.mjs": "import { describe, test } from 'node:test'; describe('d', () => test('a', () => {}));",
    "name.test.mjs": "import { test } from 'node:test'; test(() => {});",
    "mock.test.mjs": "import test, { mock } from 'node:test'; test('a', () => mock.fn());",
    "default-skip.test.mjs": "import test from 'node:test'; test('a', () => {}); test.skip('b', () => {});",
    "default-describe.test.mjs": "import test from 'node:test'; test.describe('d', () => test('a', () => {}));",
  });
  for (const file of ["skip.test.mjs", "describe.test.mjs", "name.test.mjs", "mock.test.mjs", "default-skip.test.mjs", "default-describe.test.mjs"]) {
    assert.throws(() => listTests(file, dir), /ci-test-names: loading .* failed/, file);
  }
});

test("listTests lists a file that default-imports node:test, and runSome runs part of it", async (t) => {
  const dir = scratch(t, { "a.test.mjs": SAMPLE.replace("import { test } from 'node:test';", "import test from 'node:test';") });
  assert.deepEqual(listTests("a.test.mjs", dir), SAMPLE_NAMES);
  const { result, wrong } = await runSome("a.test.mjs", SAMPLE_NAMES, ["gamma 2"], { cwd: dir });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(wrong, null);
});

test("exactPattern matches only its own name", () => {
  for (const name of SAMPLE_NAMES) {
    const re = new RegExp(exactPattern(name));
    assert.ok(re.test(name), name);
    for (const other of SAMPLE_NAMES) if (other !== name) assert.ok(!re.test(other), `${name} vs ${other}`);
  }
});

test("runSome runs exactly the given tests and says so", async (t) => {
  const dir = scratch(t, { "a.test.mjs": SAMPLE });
  const given = ["beta's [two] $x", "gamma 1"];
  const { result, wrong } = await runSome("a.test.mjs", SAMPLE_NAMES, given, { cwd: dir });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(wrong, null);
  assert.match(result.stdout, /^# tests 2$/m);
});

test("runSome reports a test the listing missed, and a given test that does not exist", async (t) => {
  const dir = scratch(t, { "a.test.mjs": SAMPLE });
  // "gamma 2" is missing from the list, so nothing skips it: it runs in this shard although it was not given.
  const listed = SAMPLE_NAMES.filter((name) => name !== "gamma 2");
  const missed = await runSome("a.test.mjs", listed, ["alpha (one)"], { cwd: dir });
  assert.match(missed.wrong, /ran but not given, or ran twice: gamma 2/);
  const absent = await runSome("a.test.mjs", [...SAMPLE_NAMES, "delta"], ["alpha (one)", "delta"], { cwd: dir });
  assert.match(absent.wrong, /given but not run: delta/);
});

test("runSome streams child output before completion and reports a timed-out selected test", async (t) => {
  const dir = scratch(t, { "h.test.mjs": "import { test } from 'node:test'; test('hangs', async () => { console.log('live-marker'); await new Promise(() => setInterval(() => {}, 1000)); });" });
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = function (chunk, ...args) {
    if (String(chunk).includes("live-marker")) writes.push(Date.now());
    return originalWrite.call(this, chunk, ...args);
  };
  const started = Date.now();
  let result;
  let wrong;
  try {
    ({ result, wrong } = await runSome("h.test.mjs", ["hangs"], ["hangs"], { cwd: dir, timeoutMs: 300 }));
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.notEqual(result.status, 0);
  assert.equal(writes.length, 1, "live output was forwarded exactly once");
  assert.ok(writes[0] < started + 300, "output arrived before the deadline");
  assert.match(wrong, /^timed out after 0\.3 s; not exactly this shard's 1 tests: given but not run: hangs$/);
  assert.match(result.stdout, /live-marker/);
});

test("runSome bounds retained output and honors destination backpressure", async (t) => {
  const dir = scratch(t, { "v.test.mjs": "import { test } from 'node:test'; test('passes', () => { console.log('verbose-' + 'x'.repeat(2000)); });" });
  const writes = [];
  const originalWrite = process.stdout.write;
  let blocked = false;
  process.stdout.write = function (chunk) {
    writes.push(String(chunk));
    if (!blocked) {
      blocked = true;
      setImmediate(() => process.stdout.emit("drain"));
      return false;
    }
    return true;
  };
  let result;
  let wrong;
  try {
    ({ result, wrong } = await runSome("v.test.mjs", ["passes"], ["passes"], { cwd: dir, maxCaptureBytes: 4096 }));
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(writes.filter((chunk) => chunk.includes("verbose-")).length, 1, "verbose output was forwarded once");
  assert.ok(writes.join("").includes("# tests 1"), "the child resumed after the destination drained");
  assert.ok(result.capturedBytes <= 4096);
  assert.ok(result.stdout.length + result.stderr.length <= 4096);
  assert.equal(result.outputOverflow, false);
  assert.equal(result.status, 0);
  assert.equal(wrong, null);
  assert.match(result.stdout, /^# tests 1$/m);
});

test("runSome stops an endless writer at the capture limit and reports overflow, not timeout", async (t) => {
  const dir = scratch(t, {
    "f.test.mjs": "import { test } from 'node:test'; test('floods', async () => { process.stdout.write('x'.repeat(4096)); setInterval(() => process.stdout.write('y'.repeat(4096)), 5); await new Promise(() => {}); });",
  });
  const started = Date.now();
  const { result, wrong } = await runSome("f.test.mjs", ["floods"], ["floods"], {
    cwd: dir, timeoutMs: 30_000, maxCaptureBytes: 1024,
  });
  assert.ok(Date.now() - started < 5_000, "capture overflow terminates the writer well before its deadline");
  assert.equal(result.outputOverflow, true);
  assert.equal(result.timedOut, false);
  assert.notEqual(result.status, 0);
  assert.equal(result.capturedBytes, 1024);
  assert.ok(result.stdout.length + result.stderr.length <= 1024);
  assert.match(wrong, /child output exceeded the 1024-byte capture limit/);
  assert.doesNotMatch(wrong, /timed out/);
});

test("runSome kills the process group when a child ignores the deadline termination", async (t) => {
  const dir = scratch(t, {});
  const pidFile = join(dir, "grandchild.pid");
  const grandchild = "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)";
  writeFileSync(join(dir, "h.test.mjs"), `import { spawn } from 'node:child_process'; import { test } from 'node:test'; test('hangs', async () => { const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}, ${JSON.stringify(pidFile)}], { stdio: 'ignore' }); await new Promise((resolve) => child.once('spawn', resolve)); console.log('child-started'); await new Promise(() => setInterval(() => {}, 1000)); });`);
  const started = Date.now();
  const { result, wrong } = await runSome("h.test.mjs", ["hangs"], ["hangs"], { cwd: dir, timeoutMs: 300 });
  assert.notEqual(result.status, 0);
  assert.match(wrong, /^timed out after 0\.3 s;/);
  assert.match(result.stdout, /child-started/);
  assert.ok(Date.now() - started < 5_000, "the process group was reaped within the kill grace period");
  const childPid = Number(readFileSync(pidFile, "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" }, "a child that ignored SIGTERM was killed");
});

test("runSome cleans up descendants when the test process exits before its deadline", async (t) => {
  if (process.platform === "win32") return t.skip("Windows does not provide POSIX process-group cleanup");
  const dir = scratch(t, {});
  const pidFile = join(dir, "grandchild.pid");
  const grandchild = "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)";
  writeFileSync(join(dir, "h.test.mjs"), `import { spawn } from 'node:child_process'; import { existsSync } from 'node:fs'; import { test } from 'node:test'; import { setTimeout as delay } from 'node:timers/promises'; test('spawns and finishes', async () => { const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}, ${JSON.stringify(pidFile)}], { stdio: 'ignore' }); await new Promise((resolve) => child.once('spawn', resolve)); child.unref(); for (let attempt = 0; attempt < 100 && !existsSync(${JSON.stringify(pidFile)}); attempt++) await delay(10); });`);
  const { result, wrong } = await runSome("h.test.mjs", ["spawns and finishes"], ["spawns and finishes"], { cwd: dir, timeoutMs: 30_000 });
  assert.equal(result.status, 0);
  assert.equal(wrong, null);
  const childPid = Number(readFileSync(pidFile, "utf8"));
  let alive = true;
  for (let attempt = 0; attempt < 100 && alive; attempt++) {
    try { process.kill(childPid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; else throw error; }
    if (alive) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(alive, false, "a descendant was killed after the test leader exited");
});

test("runSome closes inherited pipes after leader exit and reaps a descendant that ignores SIGTERM", async (t) => {
  if (process.platform === "win32") return t.skip("Windows does not provide POSIX process-group cleanup");
  const dir = scratch(t, {});
  const pidFile = join(dir, "grandchild.pid");
  const grandchild = "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)";
  writeFileSync(join(dir, "h.test.mjs"), `import { spawn } from 'node:child_process'; import { existsSync } from 'node:fs'; import { test } from 'node:test'; import { setTimeout as delay } from 'node:timers/promises'; test('finishes', async () => { const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}, ${JSON.stringify(pidFile)}], { stdio: 'inherit' }); await new Promise((resolve) => child.once('spawn', resolve)); child.unref(); for (let attempt = 0; attempt < 100 && !existsSync(${JSON.stringify(pidFile)}); attempt++) await delay(10); });`);
  const started = Date.now();
  const { result, wrong } = await runSome("h.test.mjs", ["finishes"], ["finishes"], {
    cwd: dir, args: ["--experimental-test-isolation=none"], timeoutMs: 30_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.timedOut, false);
  assert.equal(wrong, null);
  assert.match(result.stdout, /^# tests 1$/m);
  assert.ok(Date.now() - started < 8_000, "close completed after prompt orphan cleanup instead of waiting for the test deadline");
  const childPid = Number(readFileSync(pidFile, "utf8"));
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(childPid, 0); }
    catch (error) { if (error.code === "ESRCH") return; else throw error; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("the descendant that ignored SIGTERM was not reaped");
});

test("runSome cleans process groups on parent SIGINT and SIGTERM without swallowing signal status", async (t) => {
  if (process.platform === "win32") return t.skip("Windows does not provide POSIX process-group cleanup");
  const dir = scratch(t, {});
  const pidFile = join(dir, "pids.json");
  const runner = fileURLToPath(new URL("../../scripts/ci-test-names.mjs", import.meta.url));
  const worker = "import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'; import { test } from 'node:test'; test('waits', async () => { const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); await new Promise((resolve) => grandchild.once('spawn', resolve)); writeFileSync(process.env.CI_TEST_PID_FILE, JSON.stringify([process.pid, grandchild.pid])); await new Promise(() => setInterval(() => {}, 1000)); });";
  writeFileSync(join(dir, "h.test.mjs"), worker);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    rmSync(pidFile, { force: true });
    const childEnv = { ...process.env, CI_TEST_PID_FILE: pidFile };
    const driver = `import { runSome } from ${JSON.stringify(runner)}; await runSome('h.test.mjs', ['waits'], ['waits'], { cwd: process.cwd(), env: process.env, timeoutMs: 30000 });`;
    const parent = spawn(process.execPath, ["--input-type=module", "-e", driver], { cwd: dir, env: childEnv, detached: true, stdio: "ignore" });
    const pids = await new Promise((resolve, reject) => {
      const deadline = Date.now() + 5_000;
      const poll = () => {
        try { resolve(JSON.parse(readFileSync(pidFile, "utf8"))); }
        catch (error) {
          if (Date.now() >= deadline) reject(new Error(`worker did not start before ${signal}: ${error.message}`));
          else setTimeout(poll, 10);
        }
      };
      poll();
    });
    try {
      parent.kill(signal);
      const exitSignal = await new Promise((resolve) => parent.once("exit", (_code, received) => resolve(received)));
      assert.equal(exitSignal, signal, `parent preserves ${signal} termination`);
      for (let attempt = 0; attempt < 100; attempt++) {
        const alive = pids.filter((pid) => {
          try { process.kill(pid, 0); return true; }
          catch (error) { if (error.code === "ESRCH") return false; throw error; }
        });
        if (alive.length === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `${signal} reaps pid ${pid}`);
    } finally {
      try { process.kill(-parent.pid, "SIGKILL"); } catch { /* the parent already exited and its group was cleaned */ }
    }
  }
});

test("runSome removes shared terminal listeners after concurrent and repeated runs", async (t) => {
  if (process.platform === "win32") return t.skip("Windows terminal behavior is unchanged");
  const dir = scratch(t, { "a.test.mjs": "import { test } from 'node:test'; test('passes', () => {});" });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const before = process.listenerCount(signal);
    await Promise.all([
      runSome("a.test.mjs", ["passes"], ["passes"], { cwd: dir }),
      runSome("a.test.mjs", ["passes"], ["passes"], { cwd: dir }),
    ]);
    assert.equal(process.listenerCount(signal), before, `${signal} handler count returns to baseline`);
    await runSome("a.test.mjs", ["passes"], ["passes"], { cwd: dir });
    assert.equal(process.listenerCount(signal), before, `${signal} handler count stays stable on repeated calls`);
  }
});

test("runSome preserves a selected test's failure status and exact-run accounting", async (t) => {
  const dir = scratch(t, { "f.test.mjs": "import assert from 'node:assert/strict'; import { test } from 'node:test'; test('fails', () => assert.equal(1, 2));" });
  const { result, wrong } = await runSome("f.test.mjs", ["fails"], ["fails"], { cwd: dir });
  assert.equal(result.status, 1);
  assert.equal(wrong, null);
  assert.match(result.stdout, /# tests 1/);
});

test("assignUnits puts every whole file and every test of a split file in exactly one shard", () => {
  const files = ["a.test.mjs", "big.test.mjs", "c.test.mjs"];
  const split = { "big.test.mjs": ["t1", "t2", "t3", "t4", "t5"] };
  const shards = assignUnits("client", files, split);
  assert.equal(shards.length, SHARDS.client);
  const seen = shards.flatMap((list) => list.flatMap((entry) => (entry.tests === null ? [entry.file] : entry.tests.map((name) => `big > ${name}`))));
  assert.deepEqual([...seen].sort(), ["a.test.mjs", "big > t1", "big > t2", "big > t3", "big > t4", "big > t5", "c.test.mjs"]);
  for (const list of shards) for (const entry of list) {
    if (entry.file === "big.test.mjs") assert.deepEqual(entry.tests, split[entry.file].filter((name) => entry.tests.includes(name)));
    else assert.equal(entry.tests, null);
  }
  assert.deepEqual(assignUnits("client", files, split), shards, "the same input gives the same split");
  // These made-up files are not this checkout's client files, so only the real SPLIT_FILES entry is reported missing.
  assert.deepEqual(checkPartition("client", files, split).failures.filter((f) => !/listed in SPLIT_FILES/.test(f)), []);
});

test("assign keeps its file-list shape and never splits a file", () => {
  const files = ["x.test.mjs", "y.test.mjs", "z.test.mjs", ...SPLIT_FILES.seller];
  const lists = assign("seller", files);
  assert.equal(lists.length, SHARDS.seller);
  assert.deepEqual(lists.flat().sort(), [...files].sort());
});

test("plans the same shards for every event ci.yml runs on, and refuses any other event", () => {
  assert.deepEqual(checkPlan(), []);
  for (const event of EVENTS) assert.deepEqual(plan(event), plan("push"), event);
  for (const event of ["pull_request_target", "schedule", "", undefined]) assert.throws(() => plan(event), /unknown event/);
});

test("this checkout: the plan has every client shard on node 22 and the split covers every test once", async () => {
  for (const event of EVENTS) {
    const client = plan(event).filter((entry) => entry.suite === "client");
    assert.deepEqual(client.map((entry) => `${entry["node-version"]} ${entry.shard}`),
      Array.from({ length: SHARDS.client }, (_, i) => `22 ${i + 1}/${SHARDS.client}`), event);
  }
  const files = await clientFiles();
  const split = splitTests("client", files, clientDir);
  assert.deepEqual(Object.keys(split), SPLIT_FILES.client);
  for (const [file, names] of Object.entries(split)) assert.ok(names.length > 1, file);
  assert.deepEqual(checkPartition("client", files, split).failures, []);
  for (const file of SPLIT_FILES.client) assert.ok(!Object.hasOwn(WEIGHTS.client, file), `${file} has a whole-file weight`);
});

// Listing the split seller file loads its imports, so this needs npm run build first (ci.yml runs it after the build).
test("this checkout: the plan has every seller shard on both legs and the split covers every seller test once", () => {
  for (const event of EVENTS) {
    const seller = plan(event).filter((entry) => entry.suite === "seller");
    assert.deepEqual(seller.map((entry) => `${entry["node-version"]} ${entry.part} ${entry.shard}`),
      ["22", "24"].flatMap((node) => Array.from({ length: SHARDS.seller }, (_, i) => `${node} seller-${i + 1} ${i + 1}/${SHARDS.seller}`)), event);
  }
  const files = sellerFiles();
  const split = splitTests("seller", files, sellerDir);
  assert.deepEqual(Object.keys(split), SPLIT_FILES.seller);
  for (const [file, names] of Object.entries(split)) assert.ok(names.length > 1, file);
  const { shards, failures } = checkPartition("seller", files, split);
  assert.deepEqual(failures, []);
  for (const file of SPLIT_FILES.seller) {
    assert.ok(!Object.hasOwn(WEIGHTS.seller, file), `${file} has a whole-file weight`);
    assert.ok(shards.filter((list) => list.some((entry) => entry.file === file)).length > 1, `${file} is spread over shards`);
  }
});

test("the seller runner refuses a shard count other than the planned one before it runs any test", () => {
  const child = spawnSync(process.execPath, [join(repoRoot, "scripts/run-seller-tests.mjs")], {
    cwd: repoRoot, encoding: "utf8", env: { ...process.env, DACS_SELLER_TEST_SHARD: `1/${SHARDS.seller + 1}` },
  });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, new RegExp(`is not K/${SHARDS.seller} for the seller suite`));
  assert.doesNotMatch(child.stdout, /^TAP version/m);
});

// scripts/ci-shards.mjs, scripts/ci-test-names.mjs and the shard entry of scripts/run-seller-tests.mjs: the shard
// split, and the per-test split of a long file.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EVENTS, SHARDS, SPLIT_FILES, TEST_WEIGHTS, WEIGHTS, assign, assignUnits, checkPartition, checkPlan, clientDir, clientFiles, plan,
  sellerDir, sellerFiles, splitTests, staleKeys,
} from "../../scripts/ci-shards.mjs";
import { exactPattern, listTests, runSome } from "../../scripts/ci-test-names.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

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

test("listTests lists a file that default-imports node:test, and runSome runs part of it", (t) => {
  const dir = scratch(t, { "a.test.mjs": SAMPLE.replace("import { test } from 'node:test';", "import test from 'node:test';") });
  assert.deepEqual(listTests("a.test.mjs", dir), SAMPLE_NAMES);
  const { result, wrong } = runSome("a.test.mjs", SAMPLE_NAMES, ["gamma 2"], { cwd: dir });
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

test("runSome runs exactly the given tests and says so", (t) => {
  const dir = scratch(t, { "a.test.mjs": SAMPLE });
  const given = ["beta's [two] $x", "gamma 1"];
  const { result, wrong } = runSome("a.test.mjs", SAMPLE_NAMES, given, { cwd: dir });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(wrong, null);
  assert.match(result.stdout, /^# tests 2$/m);
});

test("runSome reports a test the listing missed, and a given test that does not exist", (t) => {
  const dir = scratch(t, { "a.test.mjs": SAMPLE });
  // "gamma 2" is missing from the list, so nothing skips it: it runs in this shard although it was not given.
  const listed = SAMPLE_NAMES.filter((name) => name !== "gamma 2");
  const missed = runSome("a.test.mjs", listed, ["alpha (one)"], { cwd: dir });
  assert.match(missed.wrong, /ran but not given, or ran twice: gamma 2/);
  const absent = runSome("a.test.mjs", [...SAMPLE_NAMES, "delta"], ["alpha (one)", "delta"], { cwd: dir });
  assert.match(absent.wrong, /given but not run: delta/);
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

test("staleKeys names each weight whose file or test is gone, and no test that merely has no weight", () => {
  const files = ["a.test.mjs", "new.test.mjs", "big.test.mjs"];
  const split = { "big.test.mjs": ["t1", "t2 renamed"] };
  const weights = { "a.test.mjs": 1, "gone.test.mjs": 2 };
  const testWeights = { "big.test.mjs": { t1: 1, t2: 2 } };
  assert.deepEqual(staleKeys("client", files, split, weights, testWeights), [
    'client weight "gone.test.mjs": not a test file',
    'client big.test.mjs test weight "t2": not a test of the file',
  ]);
  // new.test.mjs and "t2 renamed" have no weight, which is allowed; with the stale keys removed nothing is reported.
  assert.deepEqual(staleKeys("client", files, split, { "a.test.mjs": 1 }, { "big.test.mjs": { t1: 1 } }), []);
  assert.deepEqual(staleKeys("client", files, split, { "big.test.mjs": 9 }, {}), ['client weight "big.test.mjs": a split file has no whole-file weight']);
});

test("every TEST_WEIGHTS file is a split file", () => {
  for (const file of Object.keys(TEST_WEIGHTS)) assert.ok(Object.values(SPLIT_FILES).flat().includes(file), file);
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
  assert.deepEqual(staleKeys("client", files, split), []);
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
  assert.deepEqual(staleKeys("seller", files, split), []);
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

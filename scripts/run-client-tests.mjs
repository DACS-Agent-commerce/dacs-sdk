// One CI shard of the client package suite: DACS_CLIENT_TEST_SHARD=K/N (required) picks the files
// scripts/ci-shards.mjs assigns to shard K of N. It does what `npm test --workspace @kynesyslabs/dacs-client` does
// for those files: the package's check-hold gate first (stop if it fails), then each file once with the package
// runner's own rules (packages/dacs-client/scripts/test.mjs, runTests: one `node --test --test-concurrency=1`
// process per file from the package directory; a file fails on a non-zero exit, no `# tests` line, zero tests, or
// no registered test cases). File discovery is the package runner's discoverTests, so both see the same files.
// A file in SPLIT_FILES runs in every shard that holds some of its tests, with the other tests skipped by exact name
// (--test-skip-pattern); the shard then fails unless the tests that ran are exactly the ones it was given.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverTests } from "../packages/dacs-client/scripts/test.mjs";
import { parseShard, shardEntries, splitTests } from "./ci-shards.mjs";
import { runSome } from "./ci-test-names.mjs";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "../packages/dacs-client");
const shard = parseShard(process.env.DACS_CLIENT_TEST_SHARD, "client");
// The test processes never see the shard variable.
const env = { ...process.env };
delete env.DACS_CLIENT_TEST_SHARD;

const hold = spawnSync(process.execPath, ["scripts/check-hold.mjs"], { cwd: packageDir, stdio: "inherit", env });
if (hold.error) throw hold.error;
if (hold.status !== 0) {
  process.exitCode = hold.status ?? 1;
} else {
  const all = discoverTests(packageDir);
  if (all.length === 0) throw new Error("no executable package tests found");
  const split = splitTests("client", all, packageDir);
  const entries = shardEntries("client", all, split, shard.index);
  console.log(`[client-tests] shard ${shard.index}/${shard.count}: ${entries.length} of ${all.length} files`);
  let failed = false;
  let tests = 0;
  for (const { file, tests: given } of entries) {
    let result;
    let wrong = null;
    if (given === null) {
      result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", file], { cwd: packageDir, encoding: "utf8", maxBuffer: 16 << 20, env });
    } else {
      console.log(`[client-tests] ${file}: ${given.length} of its ${split[file].length} tests in this shard`);
      ({ result, wrong } = runSome(file, split[file], given, { cwd: packageDir, env, args: ["--test-concurrency=1"] }));
    }
    process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
    const count = /^# tests (\d+)$/m.exec(result.stdout ?? "");
    // Node counts a file with no test() calls as one successful file subtest.
    const fileOnly = (result.stdout ?? "").split("\n").some((line) => line === `# Subtest: ${file}` || line === `# Subtest: ${join(packageDir, file)}`);
    if (result.status !== 0 || !count || Number(count[1]) === 0 || fileOnly || wrong) {
      console.error(`[client-tests] FAIL ${file}: ${result.error?.message ?? (fileOnly ? "no registered test cases" : wrong ?? `exit ${result.status}, registered ${count?.[1] ?? "no"} tests`)}`);
      failed = true;
    } else {
      console.log(`[client-tests] ${file}: # tests ${count[1]}`);
      tests += Number(count[1]);
    }
  }
  console.log(`[client-tests] shard ${shard.index}/${shard.count}: ${entries.length} files, ${tests} tests passed${failed ? ", with failures" : ""}`);
  process.exitCode = failed ? 1 : 0;
}

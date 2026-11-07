// Test-only harness: runs scripts/publish-release-set.mjs as a child process against
// registry-double.mjs and a stub npm that records its calls.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const registryDouble = join(repoRoot, "test/scripts/fixtures/registry-double.mjs");
export const PLANNED = "0.1.0-alpha.1";
export const CORE = "@kynesyslabs/dacs";
export const HOST = "@kynesyslabs/dacs-node";
export const CLIENT = "@kynesyslabs/dacs-client";
export const SELLER = "@kynesyslabs/dacs-seller";
export const GENERATOR = "create-dacs-agent";
export const FIVE = [CORE, HOST, CLIENT, SELLER, GENERATOR];
/** The virtual wall-clock time at which the registry double starts the publisher. */
export const CLOCK_START_MS = 1_900_000_000_000;

const scratch = [];
after(() => { for (const directory of scratch) rmSync(directory, { recursive: true, force: true }); });
const lines = (path) => existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const integrityOf = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

// A publish whose arguments contain NPM_FAIL_ON exits 1 before it is recorded, as a failed publish leaves no release.
const STUB_NPM = `#!/bin/sh
if [ -n "$NPM_FAIL_ON" ]; then case "$*" in *"$NPM_FAIL_ON"*) exit 1;; esac; fi
echo "$@" >> "$REGISTRY_DOUBLE_DIR/npm.log"
mode=ok
mode_file="$REGISTRY_DOUBLE_DIR/mode.$(basename "$2")"
[ -f "$mode_file" ] && mode=$(cat "$mode_file")
case "$mode" in
  hang) echo $$ > "$REGISTRY_DOUBLE_DIR/hung.pid"; : > "$REGISTRY_DOUBLE_DIR/hung"; exec sleep 600 ;;
  auth) echo "npm error code ENEEDAUTH" >&2; exit 1 ;;
  ack-lost) echo "$2" >> "$REGISTRY_DOUBLE_DIR/accepted.log"; exit 1 ;;
  *) echo "$2" >> "$REGISTRY_DOUBLE_DIR/accepted.log" ;;
esac
`;

/**
 * Builds a release set and its registry. A null `admission` leaves the field out. `existing` maps a package name to "same"
 * or "other": a registry release whose integrity equals the receipt's, or differs from it. `modes` maps a package name to
 * how the stub npm treats its publish: "hang", "auth" or "ack-lost" (accepted, but exits 1). `registry` adds registry.json
 * fields (see registry-double.mjs).
 */
export function publisherFixture({ names = FIVE, admission = "strict-five", existing = {}, modes = {}, registry = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "dacs-publisher-"));
  scratch.push(directory);
  const artifactDirectory = join(directory, "set");
  mkdirSync(artifactDirectory);
  const receipts = {};
  const archives = {};
  const releases = {};
  for (const name of names) {
    const filename = `${basename(name)}-${PLANNED}.tgz`;
    const bytes = Buffer.from(`archive bytes of ${name}`);
    writeFileSync(join(artifactDirectory, filename), bytes);
    receipts[name] = { filename, sha256: sha256(bytes), integrity: integrityOf(bytes) };
    archives[join(artifactDirectory, filename)] = { name, integrity: receipts[name].integrity };
    if (existing[name]) releases[name] = existing[name] === "same" ? receipts[name].integrity : "sha512-other";
    if (modes[name]) writeFileSync(join(directory, `mode.${filename}`), modes[name]);
  }
  writeFileSync(join(artifactDirectory, "release-provenance.json"), JSON.stringify({
    schema: "dacs-release-set/v1", version: PLANNED, admission: admission ?? undefined, source: { clean: true }, packages: receipts,
  }));
  writeFileSync(join(directory, "registry.json"), JSON.stringify({ clockStartMs: CLOCK_START_MS, version: PLANNED, releases, archives, ...registry }));
  mkdirSync(join(directory, "bin"));
  writeFileSync(join(directory, "bin/npm"), STUB_NPM, { mode: 0o700 });
  return { directory, artifactDirectory, archives, receipts };
}

/** Changes the fixture's registry.json between runs: `change` edits the parsed content in place. */
export function updateRegistry(fixture, change) {
  const path = join(fixture.directory, "registry.json");
  const registry = JSON.parse(readFileSync(path, "utf8"));
  change(registry);
  writeFileSync(path, JSON.stringify(registry));
}

/**
 * Runs the publisher. `env` entries set to null are removed from the child's environment. `budgetUsedMs` is how much of the
 * job's budget had passed when the publisher started; `jobStartedAt` overrides the computed `--job-started-at` value.
 */
export function publish(fixture, env = {}, { budgetUsedMs = 0, jobStartedAt = String(CLOCK_START_MS - budgetUsedMs) } = {}) {
  const childEnv = {
    ...process.env,
    PATH: `${join(fixture.directory, "bin")}:${process.env.PATH}`,
    REGISTRY_DOUBLE_DIR: fixture.directory,
    GITHUB_ACTIONS: "true",
    DACS_NPM_PUBLISH_CONFIRM: `publish:${PLANNED}:next`,
    ...env,
  };
  for (const [key, value] of Object.entries(env)) if (value === null) delete childEnv[key];
  const jobArguments = jobStartedAt === null ? [] : ["--job-started-at", jobStartedAt];
  const result = spawnSync(process.execPath, [
    "--import", registryDouble, join(repoRoot, "scripts/publish-release-set.mjs"),
    "--artifact-dir", fixture.artifactDirectory, "--tag", "next", ...jobArguments,
  ], { encoding: "utf8", env: childEnv, timeout: 60_000 });
  const npmCalls = lines(join(fixture.directory, "npm.log"));
  return {
    status: result.status,
    output: result.stdout + result.stderr,
    fetchCalls: lines(join(fixture.directory, "fetch.log")),
    npmCalls,
    publishedNames: npmCalls.map((call) => fixture.archives[call.split(" ")[1]].name),
    timers: lines(join(fixture.directory, "timers.log")).map(Number),
    clockEndMs: Number(lines(join(fixture.directory, "clock.log")).at(-1)),
  };
}

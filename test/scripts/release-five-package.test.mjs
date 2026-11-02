import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { prepare } from "../../scripts/release-checks.mjs";
import { checkRecord } from "../../packages/dacs-client/scripts/check-hold.mjs";
import { discoverTests } from "../../packages/dacs-client/scripts/test.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const registryDouble = join(repoRoot, "test/scripts/fixtures/registry-double.mjs");
const PLANNED = "0.1.0-alpha.1";
const CORE = "@kynesyslabs/dacs";
const HOST = "@kynesyslabs/dacs-node";
const CLIENT = "@kynesyslabs/dacs-client";
const SELLER = "@kynesyslabs/dacs-seller";
const GENERATOR = "create-dacs-agent";
const FIVE = [CORE, HOST, CLIENT, SELLER, GENERATOR];

const scratch = [];
after(() => { for (const directory of scratch) rmSync(directory, { recursive: true, force: true }); });
function tempDirectory(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(directory);
  return directory;
}
const lines = (path) => existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];

// ---- The publisher, run as a child process against an in-memory registry ----

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const integrityOf = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

// A null `admission` leaves the field out. `existing` maps a package name to "same" or "other": a registry release whose
// integrity equals the receipt's, or differs from it.
function publisherFixture({ names = FIVE, admission = "strict-five", existing = {} } = {}) {
  const directory = tempDirectory("dacs-publisher-");
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
  }
  writeFileSync(join(artifactDirectory, "release-provenance.json"), JSON.stringify({
    schema: "dacs-release-set/v1", version: PLANNED, admission: admission ?? undefined, source: { clean: true }, packages: receipts,
  }));
  writeFileSync(join(directory, "registry.json"), JSON.stringify({ releases, archives }));
  mkdirSync(join(directory, "bin"));
  // A publish whose arguments contain NPM_FAIL_ON exits 1 before it is recorded, as a failed publish leaves no release.
  writeFileSync(join(directory, "bin/npm"), [
    "#!/bin/sh",
    "if [ -n \"$NPM_FAIL_ON\" ]; then case \"$*\" in *\"$NPM_FAIL_ON\"*) exit 1;; esac; fi",
    "echo \"$@\" >> \"$REGISTRY_DOUBLE_DIR/npm.log\"",
    "",
  ].join("\n"), { mode: 0o700 });
  return { directory, artifactDirectory, archives };
}

// `env` entries set to null are removed from the child's environment.
function publish(fixture, env = {}) {
  const childEnv = {
    ...process.env,
    PATH: `${join(fixture.directory, "bin")}:${process.env.PATH}`,
    REGISTRY_DOUBLE_DIR: fixture.directory,
    GITHUB_ACTIONS: "true",
    DACS_NPM_PUBLISH_CONFIRM: `publish:${PLANNED}:next`,
    ...env,
  };
  for (const [key, value] of Object.entries(env)) if (value === null) delete childEnv[key];
  const result = spawnSync(process.execPath, [
    "--import", registryDouble, join(repoRoot, "scripts/publish-release-set.mjs"),
    "--artifact-dir", fixture.artifactDirectory, "--tag", "next",
  ], { encoding: "utf8", env: childEnv, timeout: 30_000 });
  const npmCalls = lines(join(fixture.directory, "npm.log"));
  return {
    status: result.status,
    output: result.stdout + result.stderr,
    fetchCalls: lines(join(fixture.directory, "fetch.log")),
    npmCalls,
    publishedNames: npmCalls.map((call) => fixture.archives[call.split(" ")[1]].name),
  };
}

function assertRefusedBeforeNetwork(result, pattern) {
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, pattern);
  assert.equal(result.fetchCalls.length, 0);
  assert.equal(result.npmCalls.length, 0);
}

test("the publisher refuses provenance missing one of the five packages before any registry read or publish", () => {
  for (const missing of FIVE) {
    const result = publish(publisherFixture({ names: FIVE.filter((name) => name !== missing) }));
    assertRefusedBeforeNetwork(result, new RegExp(`provenance is missing ${missing.replaceAll("/", "\\/")}\\s`));
  }
});

test("the publisher refuses provenance naming an unknown sixth package", () => {
  const result = publish(publisherFixture({ names: [...FIVE, "@kynesyslabs/dacs-extra"] }));
  assertRefusedBeforeNetwork(result, /provenance names unknown @kynesyslabs\/dacs-extra\s/);
});

test("the publisher refuses provenance not produced by strict admission", () => {
  for (const admission of ["preparation", null, "strict-three"]) {
    assertRefusedBeforeNetwork(publish(publisherFixture({ admission })), /strict five-package admission/);
  }
});

test("the publisher refuses provenance listing the five out of policy order", () => {
  const result = publish(publisherFixture({ names: [CORE, CLIENT, HOST, SELLER, GENERATOR] }));
  assertRefusedBeforeNetwork(result, /not in policy order/);
});

test("the publisher publishes the five in policy order: core, dacs-node, client, seller, generator", () => {
  const result = publish(publisherFixture());
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.publishedNames, [
    "@kynesyslabs/dacs", "@kynesyslabs/dacs-node", "@kynesyslabs/dacs-client", "@kynesyslabs/dacs-seller", "create-dacs-agent",
  ]);
});

test("an existing exact version is skipped and the remaining packages publish in order", () => {
  const result = publish(publisherFixture({ existing: { [CORE]: "same", [HOST]: "same" } }));
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.publishedNames, [CLIENT, SELLER, GENERATOR]);
  assert.match(result.output, /@kynesyslabs\/dacs@0\.1\.0-alpha\.1 already matches/);
});

test("a conflicting existing version of the last package refuses before the first publish", () => {
  const result = publish(publisherFixture({ existing: { [GENERATOR]: "other" } }));
  assert.notEqual(result.status, 0);
  assert.match(result.output, /existing registry release conflicts for create-dacs-agent/);
  assert.equal(result.fetchCalls.length, 5);
  assert.equal(result.npmCalls.length, 0);
});

test("a publish that fails midway leaves the earlier packages published and a rerun resumes after them", () => {
  const fixture = publisherFixture();
  const failed = publish(fixture, { NPM_FAIL_ON: `${basename(CLIENT)}-${PLANNED}.tgz` });
  assert.notEqual(failed.status, 0);
  assert.match(failed.output, /npm publish failed for @kynesyslabs\/dacs-client/);
  assert.deepEqual(failed.publishedNames, [CORE, HOST]);
  const rerun = publish(fixture);
  assert.equal(rerun.status, 0, rerun.output);
  // The log accumulates: no package appears twice, so the rerun sent only the remaining three.
  assert.deepEqual(rerun.publishedNames, FIVE);
});

test("the publisher refuses an artifact directory with no provenance before any registry read", () => {
  const fixture = publisherFixture();
  rmSync(join(fixture.artifactDirectory, "release-provenance.json"));
  assertRefusedBeforeNetwork(publish(fixture), /release-provenance\.json/);
});

test("the publisher refuses to run outside GitHub Actions or without the exact confirmation", () => {
  assertRefusedBeforeNetwork(publish(publisherFixture(), { GITHUB_ACTIONS: null }), /restricted to the reviewed GitHub workflow/);
  assertRefusedBeforeNetwork(publish(publisherFixture(), { DACS_NPM_PUBLISH_CONFIRM: null }), /confirmation is absent/);
  assertRefusedBeforeNetwork(publish(publisherFixture(), { DACS_NPM_PUBLISH_CONFIRM: `publish:${PLANNED}:latest` }), /confirmation is absent/);
});

// ---- The release set, run on a fixture checkout holding the real scripts ----

const COMPILED = [CORE, HOST, GENERATOR];
const DIRECTORIES = {
  [CORE]: ".", [HOST]: "packages/dacs-node", [CLIENT]: "packages/dacs-client",
  [SELLER]: "packages/dacs-seller", [GENERATOR]: "packages/create-dacs-agent",
};
const DIST_FILES = ["index.js", "index.d.ts", "sqlite.js", "demosLoader.js", "demosLoaderHook.js", "bin.js"];
const REPOSITORY_URL = "git+https://github.com/DACS-Agent-commerce/dacs-sdk.git";

function fixtureManifest(name, version) {
  const compiled = COMPILED.includes(name);
  return {
    name, version, license: "MIT", repository: { type: "git", url: REPOSITORY_URL },
    publishConfig: { access: "public", provenance: true },
    files: [compiled ? "dist" : "src"],
    exports: { ".": compiled ? { types: "./dist/index.d.ts", import: "./dist/index.js" } : "./src/index.mjs" },
    ...(compiled ? { dacs: { releaseMetadataVersion: 1 } } : {}),
    ...(name === CORE ? { scripts: { build: "node -e 0", "host:build": "node -e 0", "generator:build": "node -e 0" } } : {}),
    ...([HOST, CLIENT, SELLER].includes(name) ? { peerDependencies: { [CORE]: version } } : {}),
  };
}

// `changes` maps a package name to manifest fields to override, or to null for
// a package whose directory has no manifest.
function releaseFixture({ version = PLANNED, changes = {} } = {}) {
  const root = tempDirectory("dacs-release-set-");
  mkdirSync(join(root, "scripts"));
  for (const script of ["verify-release-set.mjs", "release-checks.mjs", "release-identity.mjs"]) {
    cpSync(join(repoRoot, "scripts", script), join(root, "scripts", script));
  }
  writeFileSync(join(root, "scripts/release-policy.json"), JSON.stringify({
    plannedVersion: PLANNED,
    packages: FIVE.map((name) => ({
      name, directory: DIRECTORIES[name], requiredExports: ["."],
      allow: ["package.json", "README.md", "LICENSE", "dist/**/*.js", "dist/**/*.d.ts", "src/**/*.mjs"],
    })),
  }));
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package-lock.json"), "{}");
  writeFileSync(join(root, ".gitignore"), "node_modules\npackage-artifacts\n");
  mkdirSync(join(root, "package-artifacts"));
  for (const name of FIVE) {
    if (changes[name] === null) continue;
    const directory = join(root, DIRECTORIES[name]);
    const output = join(directory, COMPILED.includes(name) ? "dist" : "src");
    mkdirSync(output, { recursive: true });
    for (const file of COMPILED.includes(name) ? DIST_FILES : ["index.mjs"]) writeFileSync(join(output, file), "export {};\n");
    writeFileSync(join(directory, "LICENSE"), "MIT\n");
    writeFileSync(join(directory, "package.json"), JSON.stringify({ ...fixtureManifest(name, version), ...changes[name] }));
  }
  const git = (...args) => spawnSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  return root;
}

// npm runs offline, so an internal package that resolved from the registry
// instead of the set's own archive would fail the run.
function releaseSet(root, { strict }) {
  const output = join(root, "package-artifacts/release-set");
  const result = spawnSync(process.execPath, [
    join(root, "scripts/verify-release-set.mjs"), "--output-dir", output, ...(strict ? ["--strict"] : []),
  ], { cwd: root, encoding: "utf8", env: { ...process.env, npm_config_offline: "true" }, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  const provenancePath = join(output, "release-provenance.json");
  return {
    status: result.status,
    output: result.stdout + result.stderr,
    outputDirectory: output,
    provenance: existsSync(provenancePath) ? JSON.parse(readFileSync(provenancePath, "utf8")) : undefined,
  };
}

let strictRun;
const strictRunOnFiveReleasablePackages = () => (strictRun ??= releaseSet(releaseFixture(), { strict: true }));

test("the strict release set records strict-five admission and the policy order", { timeout: 150_000 }, () => {
  const run = strictRunOnFiveReleasablePackages();
  assert.equal(run.status, 0, run.output);
  assert.equal(run.provenance.admission, "strict-five");
  assert.deepEqual(run.provenance.order, FIVE);
  assert.deepEqual(Object.keys(run.provenance.packages), FIVE);
});

test("the strict release set refuses a package whose internal dependency comes later in policy order", { timeout: 150_000 }, () => {
  const root = releaseFixture({ changes: { [HOST]: { peerDependencies: { [CORE]: PLANNED, [SELLER]: PLANNED } } } });
  const run = releaseSet(root, { strict: true });
  assert.notEqual(run.status, 0);
  assert.match(run.output, /@kynesyslabs\/dacs-node depends on @kynesyslabs\/dacs-seller, which comes later in policy order/);
  assert.equal(run.provenance, undefined);
});

test("the strict release set refuses unless all five are releasable at the planned version, even when the subset installs", { timeout: 300_000 }, () => {
  const cases = [
    [{ changes: { [CLIENT]: { private: true } } }, /@kynesyslabs\/dacs-client: private package is not releasable/],
    [{ changes: { [SELLER]: null } }, /@kynesyslabs\/dacs-seller: missing package manifest/],
    [{ version: "0.1.0-alpha.0" }, /release versions differ: 0\.1\.0-alpha\.0 vs 0\.1\.0-alpha\.1/],
  ];
  for (const [options, pattern] of cases) {
    const run = releaseSet(releaseFixture(options), { strict: true });
    assert.notEqual(run.status, 0);
    assert.match(run.output, pattern);
    assert.equal(run.provenance, undefined);
  }
});

test("the preparation release set reports private or absent packages not ready and still packs the others", { timeout: 150_000 }, () => {
  const run = releaseSet(releaseFixture({ changes: { [CLIENT]: { private: true }, [SELLER]: null } }), { strict: false });
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /not ready: @kynesyslabs\/dacs-client: private package is not releasable/);
  assert.match(run.output, /not ready: @kynesyslabs\/dacs-seller: missing package manifest/);
  assert.equal(run.provenance.admission, "preparation");
  assert.deepEqual(Object.keys(run.provenance.packages), [CORE, HOST, GENERATOR]);
});

test("the preparation release set still fails on a package that is neither private nor absent", { timeout: 150_000 }, () => {
  const run = releaseSet(releaseFixture({ changes: { [CLIENT]: { license: "UNLICENSED" } } }), { strict: false });
  assert.notEqual(run.status, 0);
  assert.match(run.output, /@kynesyslabs\/dacs-client: release identity or publish policy is invalid/);
});

test("client and kit SBOM consumers resolve internal packages from the set's own archives", { timeout: 150_000 }, () => {
  const run = strictRunOnFiveReleasablePackages();
  assert.equal(run.status, 0, run.output);
  for (const label of ["client", "seller"]) {
    const sbom = JSON.parse(readFileSync(join(run.outputDirectory, `${label}.cdx.json`), "utf8"));
    const names = sbom.components.map((component) => component.name);
    const own = label === "client" ? CLIENT : SELLER;
    for (const name of [CORE, own]) {
      assert.ok(names.includes(name), `${label} SBOM lists ${name}`);
      const [distribution] = sbom.components.find((component) => component.name === name).externalReferences;
      assert.match(distribution.url, /^file:.+\.tgz$/u, `${label} SBOM resolves ${name} from an archive`);
    }
  }
});

// ---- Existing checks that make up the phase-0 integration receipt (O1) ----

function coreTree({ dropExport, extraFile } = {}) {
  const root = tempDirectory("dacs-receipt-");
  const core = JSON.parse(readFileSync(join(repoRoot, "scripts/release-policy.json"), "utf8")).packages[0];
  const keys = core.requiredExports.filter((key) => key !== dropExport);
  mkdirSync(join(root, "dist"));
  const exports = {};
  keys.forEach((key, index) => {
    exports[key] = { types: `./dist/e${index}.d.ts`, import: `./dist/e${index}.js` };
    writeFileSync(join(root, `dist/e${index}.js`), "export {};\n");
    writeFileSync(join(root, `dist/e${index}.d.ts`), "export {};\n");
  });
  writeFileSync(join(root, "LICENSE"), "MIT\n");
  if (extraFile) writeFileSync(join(root, extraFile), "outside the allow-list\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({
    ...fixtureManifest(CORE, "0.1.0-alpha.0"), exports, files: ["dist", ...(extraFile ? [extraFile] : [])],
  }));
  return root;
}

const preparationErrors = async (root) => (await prepare(root, join(root, "scratch"), () => {})).errors;

test("the existing checks refuse an integrated phase-0 fixture with a missing or mismatching receipt item: a path outside the allow-list, a missing required export or a stale preparation snapshot fails 377's real exported preparation validation (the `release:dry-run` path), and a changed hold pin fails `check-hold.mjs`'s `checkRecord`; each refuses before OP-2 pinning and is repaired in phase 0", { timeout: 120_000 }, async () => {
  assert.deepEqual((await preparationErrors(coreTree())).filter((error) => error.startsWith(`${CORE}:`)), []);
  assert.ok((await preparationErrors(coreTree({ extraFile: "internal-notes.txt" })))
    .includes(`${CORE}: outside allow-list: internal-notes.txt`));
  assert.ok((await preparationErrors(coreTree({ dropExport: "./rails" })))
    .includes(`${CORE}: missing public export ./rails`));
  const clientRoot = coreTree();
  mkdirSync(join(clientRoot, "packages/dacs-client/src"), { recursive: true });
  writeFileSync(join(clientRoot, "packages/dacs-client/src/index.mjs"), "export {};\n");
  writeFileSync(join(clientRoot, "packages/dacs-client/package.json"), JSON.stringify({
    name: CLIENT, version: "0.1.0-alpha.0", private: true, files: ["src"], exports: { ".": "./src/index.mjs" },
  }));
  assert.ok((await preparationErrors(clientRoot)).includes(`${CLIENT}: release identity or publish policy is invalid`));
  const hold = JSON.parse(readFileSync(join(repoRoot, "packages/dacs-client/HOLD.json"), "utf8"));
  assert.deepEqual(checkRecord(hold), []);
  hold.holds[0].files[0].heldBlob = "0".repeat(40);
  assert.match(checkRecord(hold).join("\n"), /heldBlob/);
});

// ---- Every node:test file is selected by some command ----

const testFilesUnder = (directory) => readdirSync(join(repoRoot, directory), { withFileTypes: true }).flatMap((entry) => {
  if (entry.name === "node_modules") return [];
  const path = `${directory}/${entry.name}`;
  if (entry.isDirectory()) return testFilesUnder(path);
  return entry.name.endsWith(".test.mjs") ? [path] : [];
});
const expandGlob = (pattern) => {
  const matcher = new RegExp(`^${basename(pattern).replace(/[.]/gu, "\\.").replace(/\*/gu, ".*")}$`, "u");
  return readdirSync(join(repoRoot, dirname(pattern))).filter((name) => matcher.test(name)).map((name) => `${dirname(pattern)}/${name}`);
};

function selectingCommands() {
  const scripts = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).scripts;
  const commands = new Map();
  for (const [name, command] of Object.entries(scripts)) {
    const files = (command.match(/\S+\.test\.mjs/gu) ?? []).flatMap((argument) => argument.includes("*") ? expandGlob(argument) : [argument]);
    if (files.length > 0) commands.set(`npm run ${name}`, files);
  }
  // The kit's runner takes no file arguments; its --list output is its selection.
  const listed = spawnSync(process.execPath, [join(repoRoot, scripts["seller:test"].replace(/^node /u, "")), "--list"], { encoding: "utf8" });
  commands.set("npm run seller:test", JSON.parse(listed.stdout).map((name) => `packages/dacs-seller/test/${name}`));
  commands.set("npm test --workspace @kynesyslabs/dacs-client",
    discoverTests(join(repoRoot, "packages/dacs-client")).map((file) => `packages/dacs-client/${file}`));
  return commands;
}

test("every test/**/*.test.mjs and packages/*/test/**/*.test.mjs file is selected by release:test, a kit script (seller:test, or P06's kit-client:test), or release:qualification:test; discover files and derive command arguments from package.json, with one table row per file × eligible command, and fail when no command selects a file, including seller-transport-auth.test.mjs; for `seller:test`, whose command `node scripts/run-seller-tests.mjs` takes no file arguments, the selected files are the runner's `--list` output", () => {
  const commands = selectingCommands();
  const discovered = [
    ...testFilesUnder("test"),
    ...readdirSync(join(repoRoot, "packages")).flatMap((name) => testFilesUnder(`packages/${name}/test`)),
  ];
  assert.ok(discovered.includes("packages/dacs-seller/test/seller-transport-auth.test.mjs"));
  assert.ok(discovered.includes("test/scripts/release-five-package.test.mjs"));
  const rows = discovered.flatMap((file) => [...commands].filter(([, files]) => files.includes(file)).map(([command]) => [file, command]));
  const unselected = discovered.filter((file) => !rows.some(([selected]) => selected === file));
  assert.deepEqual(unselected, []);
});

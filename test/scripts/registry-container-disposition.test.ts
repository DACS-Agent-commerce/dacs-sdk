import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheArchive, npmCi, packTarball, serveArchives } from "./npm-archive-fixtures.js";

// Keep the classifier executable as plain Node ESM.
const dispositionModulePath = "../../scripts/registry-container-disposition.mjs";
const { classifyRegistryAudit, registryDependencyViolations, runtimeImageInventoryFindings, satisfiesEngineRange, scanLockEngines } = await import(dispositionModulePath);
const inventoryModulePath = "../../scripts/runtime-image-inventory.mjs";
const { runtimeImageInventory } = await import(inventoryModulePath);
const archiveModulePath = "../../scripts/installation-closure.mjs";
const { npmToolchain, runNpmNode } = await import(archiveModulePath);
// Reference replay invokes the real npm toolchain for each policy scenario.
vi.setConfig({ testTimeout: 60_000 });
const repoRoot = resolve(import.meta.dirname, "../..");
const workflowPath = join(repoRoot, ".github/workflows/registry-container-acceptance.yml");
const scratch: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const CANDIDATE_VERSION = "0.1.0-test";
const CANDIDATE_REGISTRY = "http://host.docker.internal:4873";
const CANDIDATES = ["@kynesyslabs/dacs", "@kynesyslabs/dacs-node"];
const DUAL_RAIL_DEPENDENCIES = [...CANDIDATES, "@kynesyslabs/demosdk", "@x402/core", "@x402/evm", "@x402/fetch", "better-sqlite3", "viem"];
const sri = (bytes: Buffer) => "sha512-" + createHash("sha512").update(bytes).digest("base64");
const releaseFile = (name: string) => `${name.slice(1).replace("/", "-")}-${CANDIDATE_VERSION}.tgz`;
const packageJson = (name: string | undefined, version: string, fields: Record<string, unknown> = {}) =>
  JSON.stringify({ ...(name === undefined ? {} : { name }), version, ...fields });

// Runs the dependency-policy command against a generated consumer whose lock
// names the exact packed candidate tarballs, as release-provenance.json
// records them. Every locked archive is in the consumer's npm cache, and `run`
// installs each one's files where npm puts them, as npm ci --ignore-scripts does.
function dependencyPolicyHarness(candidateFields: Record<string, unknown> = {}, candidateFiles: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "dacs-registry-integrity-"));
  scratch.push(directory);
  const project = join(directory, "project");
  const cache = join(directory, "npm-cache");
  mkdirSync(project);
  const packages: Record<string, Record<string, unknown>> = {};
  const contents: Record<string, Record<string, string>> = {};
  const provenance = { version: CANDIDATE_VERSION, packages: {} as Record<string, { integrity: string }> };
  // Locks `files` at `location` as the archive npm fetched for it; `fields` are added to its lock entry.
  const lockPackage = (location: string, files: Record<string, string>, fields: Record<string, unknown> = {}) => {
    const archive = packTarball(files);
    cacheArchive(cache, archive);
    contents[location] = files;
    packages[location] = { version: JSON.parse(files["package.json"] ?? "{}").version ?? "1.0.0",
      resolved: `${CANDIDATE_REGISTRY}/${location.replace(/^.*node_modules\//, "")}.tgz`, integrity: sri(archive), ...fields };
    return archive;
  };
  // Locks and installs another copy of the archive at `from`.
  const copyPackage = (from: string, to: string, fields: Record<string, unknown> = {}) => {
    contents[to] = contents[from] ?? {};
    packages[to] = { ...packages[from], ...fields };
  };
  for (const name of DUAL_RAIL_DEPENDENCIES) {
    const archive = lockPackage(`node_modules/${name}`, { "package.json": packageJson(name, CANDIDATE_VERSION, CANDIDATES.includes(name) ? candidateFields : {}),
      "index.js": `module.exports = "${name}";\n`, ...(CANDIDATES.includes(name) ? candidateFiles : {}) });
    if (CANDIDATES.includes(name)) {
      writeFileSync(join(directory, releaseFile(name)), archive);
      provenance.packages[name] = { integrity: sri(archive) };
    }
  }
  const manifest: Record<string, unknown> = {
    dependencies: Object.fromEntries(DUAL_RAIL_DEPENDENCIES.map(name => [name, CANDIDATE_VERSION])) };
  const report = join(directory, "report.json");
  // The files installed at a lock location instead of its archive's; `null` installs none.
  const installed: Record<string, Record<string, string> | null> = {};
  // `environment` adds to the command's environment; `script` and `projectPath` are the paths it is given.
  const run = (afterInstall: (project: string) => void = () => undefined, { environment = {}, script = "scripts/registry-container-disposition.mjs",
    projectPath = project }: { environment?: Record<string, string>; script?: string; projectPath?: string } = {}) => {
    // Supply a complete npm lock/manifest contract, including every fixture
    // package, before applying the test's interrupted or changed tree state.
    const dependencies = ["dependencies", "optionalDependencies", "devDependencies"];
    for (const location of Object.keys(packages)) {
      for (let end = location.lastIndexOf("/node_modules/"); end >= 0;) {
        const parent = location.slice(0, end);
        if (!packages[parent]) lockPackage(parent, { "package.json": packageJson(parent.slice("node_modules/".length), "1.0.0") });
        end = parent.lastIndexOf("/node_modules/");
      }
    }
    // Keep declared aliases in a complete graph, even when a test adds a
    // file shadow or carried copy rather than supplying the ordinary lock edge.
    for (const [owner, fields] of [["", manifest], ...Object.entries(packages)] as [string, Record<string, unknown>][]) {
      for (const field of [...dependencies, "peerDependencies"]) {
        for (const [name, spec] of Object.entries((fields[field] ?? {}) as Record<string, unknown>)) {
          const candidate = typeof spec === "string" && /^npm:(@kynesyslabs\/(?:dacs|dacs-node))@/.exec(spec)?.[1];
          const location = (owner ? owner + "/" : "") + "node_modules/" + name;
          if (candidate && !packages[location] && !packages["node_modules/" + name] && packages["node_modules/" + candidate]) {
            copyPackage("node_modules/" + candidate, location, { name: candidate });
          }
        }
      }
    }
    for (const [location, entry] of Object.entries(packages)) {
      const split = location.lastIndexOf("/node_modules/");
      const name = location.slice(split < 0 ? "node_modules/".length : split + "/node_modules/".length);
      const owner = split < 0 ? manifest : packages[location.slice(0, split)];
      if (split < 0 && DUAL_RAIL_DEPENDENCIES.includes(name)) continue;
      if (owner && !dependencies.some(field => Object.hasOwn(owner[field] ?? {}, name))) {
        const declared = owner.dependencies;
        owner.dependencies = { ...(typeof declared === "object" && declared !== null ? declared : {}), [name]: entry.version };
      }
    }
    const lock = { lockfileVersion: 3, packages: { "": manifest, ...packages } };
    writeFileSync(join(project, "package.json"), JSON.stringify(manifest));
    writeFileSync(join(project, "package-lock.json"), JSON.stringify(lock));
    writeFileSync(join(project, ".npmrc"), "legacy-peer-deps=true\n");
    writeFileSync(join(directory, "release-provenance.json"), JSON.stringify(provenance));
    rmSync(join(project, "node_modules"), { recursive: true, force: true });
    const modes = new Map<string, number>();
    let hiddenLock: Buffer | undefined;
    if (Object.values(packages).every(entry => typeof entry.resolved === "string" && /^https?:/.test(entry.resolved))) {
      try {
        const toolchain = npmToolchain();
        runNpmNode(toolchain, [toolchain.cli, "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", `--cache=${cache}`], { cwd: project });
        hiddenLock = readFileSync(join(project, "node_modules/.package-lock.json"));
        for (const [location, files] of Object.entries(contents)) {
          for (const path of Object.keys(files)) {
            const installedPath = join(project, location, path);
            if (existsSync(installedPath)) modes.set(installedPath, statSync(installedPath).mode & 0o777);
          }
        }
      } catch { /* Invalid contracts deliberately have no completed baseline. */ }
    }
    rmSync(join(project, "node_modules"), { recursive: true, force: true });
    for (const location of Object.keys(packages)) {
      for (const [path, body] of Object.entries((location in installed ? installed[location] : contents[location]) ?? {})) {
        const installedPath = join(project, location, path);
        mkdirSync(dirname(installedPath), { recursive: true });
        writeFileSync(installedPath, body);
        const mode = modes.get(installedPath);
        if (mode !== undefined) chmodSync(installedPath, mode);
      }
    }
    if (hiddenLock) writeFileSync(join(project, "node_modules/.package-lock.json"), hiddenLock);
    afterInstall(project);
    const result = spawnSync(process.execPath, [script, "--dependency-policy", projectPath, CANDIDATE_REGISTRY, report, directory, CANDIDATE_VERSION],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, npm_config_cache: cache, ...environment } });
    return { ...result, report: result.status === 0 ? JSON.parse(readFileSync(report, "utf8")) : null };
  };
  return { directory, cache, packages, contents, manifest, provenance, installed, lockPackage, copyPackage, run, report };
}
const TREE = "installed tree is not the locked archives: ";

describe("registry/container evidence", () => {
  it("accepts a consumer installed exactly from its locked archives", () => {
    expect(dependencyPolicyHarness().run()).toMatchObject({ status: 0, report: { passed: true, violations: [] } });
  });

  it.each(["dacs", "dacs-node"])("rejects an untracked installed nested or aliased %s", name => {
    const fixture = dependencyPolicyHarness();
    const result = fixture.run(project => {
      for (const location of [`node_modules/plugin/node_modules/@kynesyslabs/${name}`, "node_modules/untracked-alias"]) {
        mkdirSync(join(project, location), { recursive: true });
        writeFileSync(join(project, location, "package.json"), packageJson(`@kynesyslabs/${name}`, "0.0.0-wrong"));
      }
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(TREE + "unexpected directory: node_modules/plugin");
    expect(result.stderr).toContain(TREE + "unexpected directory: node_modules/untracked-alias");
  });

  it.each(["dacs", "dacs-node"])("requires the top-level %s even with valid nested and aliased copies", name => {
    const { packages, contents, copyPackage, run } = dependencyPolicyHarness();
    const top = `node_modules/@kynesyslabs/${name}`;
    copyPackage(top, `node_modules/plugin/node_modules/@kynesyslabs/${name}`);
    copyPackage(top, "node_modules/alias", { name: `@kynesyslabs/${name}` });
    delete packages[top];
    delete contents[top];
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("candidate package is not installed at the top level: @kynesyslabs/" + name);
  });

  it("requires a top-level candidate even if its absent lock entry is optional", () => {
    const fixture = dependencyPolicyHarness();
    const location = "node_modules/@kynesyslabs/dacs";
    fixture.packages[location] = { ...fixture.packages[location], optional: true };
    fixture.installed[location] = null;
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(TREE + "missing: node_modules/@kynesyslabs/dacs");
  });

  it("invalidates a previous success report before a rejected repeat", () => {
    const fixture = dependencyPolicyHarness();
    expect(fixture.run().status).toBe(0);
    expect(JSON.parse(readFileSync(fixture.report, "utf8")).passed).toBe(true);
    const entry = fixture.packages["node_modules/@kynesyslabs/dacs"];
    if (!entry) throw new Error("missing fixture candidate");
    entry.integrity = "sha512-wrong";
    expect(fixture.run().status).not.toBe(0);
    expect(existsSync(fixture.report)).toBe(false);
  });

  it("runs the policy, and invalidates a previous success report, when started through a linked script path", () => {
    const fixture = dependencyPolicyHarness();
    expect(fixture.run().status).toBe(0);
    const linked = join(fixture.directory, "linked-scripts");
    symlinkSync(join(repoRoot, "scripts"), linked);
    fixture.packages["node_modules/@kynesyslabs/dacs"] = { ...fixture.packages["node_modules/@kynesyslabs/dacs"], integrity: "sha512-wrong" };
    const result = fixture.run(undefined, { script: join(linked, "registry-container-disposition.mjs") });
    expect(result.status).not.toBe(0);
    expect(existsSync(fixture.report)).toBe(false);
  });

  it.each(["dacs", "dacs-node"])("rejects an installed %s whose runtime file differs from the packed tarball", name => {
    const root = `node_modules/@kynesyslabs/${name}`;
    const result = dependencyPolicyHarness().run(project => writeFileSync(join(project, root, "index.js"), "module.exports = 'replaced';\n"));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${TREE}changed: ${root}/index.js`);
  });

  it.each([
    ["an added file", (root: string) => writeFileSync(join(root, "postinstall.js"), "x"), "unexpected file: node_modules/@kynesyslabs/dacs/postinstall.js"],
    ["a missing file", (root: string) => rmSync(join(root, "index.js")), "missing: node_modules/@kynesyslabs/dacs/index.js"],
    ["a file that is a link", (root: string) => { rmSync(join(root, "index.js")); symlinkSync("../dacs-node/index.js", join(root, "index.js")); },
      "expected file, found link: node_modules/@kynesyslabs/dacs/index.js"],
    ["a file that is a hard link", (root: string) => linkSync(join(root, "index.js"), join(root, "alias.js")),
      "hard link: node_modules/@kynesyslabs/dacs/index.js"],
    ["a directory the tarball does not hold", (root: string) => mkdirSync(join(root, "dist")), "unexpected directory: node_modules/@kynesyslabs/dacs/dist"],
  ])("rejects an installed candidate with %s", (_form, change, difference) => {
    const result = dependencyPolicyHarness().run(project => change(join(project, "node_modules/@kynesyslabs/dacs")));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(TREE + difference);
  });

  it.each([
    ["preinstall", { scripts: { preinstall: "node setup.js" } }, {}],
    ["install", { scripts: { install: "node setup.js" } }, {}],
    ["postinstall", { scripts: { postinstall: "node setup.js" } }, {}],
    ["binding.gyp", {}, { "binding.gyp": "{}" }],
  ])("rejects a candidate whose tarball declares %s", (declared, fields, files) => {
    const result = dependencyPolicyHarness(fields, files).run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`candidate package runs code when installed (${declared}): @kynesyslabs/dacs`);
  });

  it("accepts the dependencies npm installs inside a candidate directory", () => {
    const fixture = dependencyPolicyHarness();
    fixture.lockPackage("node_modules/@kynesyslabs/dacs/node_modules/dependency", { "package.json": packageJson("dependency", "1.0.0"), "index.js": "" });
    expect(fixture.run()).toMatchObject({ status: 0, report: { passed: true } });
  });

  it("rejects a packed tarball that is not an npm package archive", () => {
    const { directory, run, provenance } = dependencyPolicyHarness();
    const bytes = packTarball({ "index.js": "" });
    provenance.packages["@kynesyslabs/dacs"] = { integrity: sri(bytes) };
    const result = run(() => writeFileSync(join(directory, releaseFile("@kynesyslabs/dacs")), bytes));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("packed tarball has no package.json");
  });

  it("rejects release provenance for another version", () => {
    const { provenance, run } = dependencyPolicyHarness();
    provenance.version = "0.0.0-other";
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`release-provenance.json is not for version ${CANDIDATE_VERSION}`);
  });

  it("rejects a consumer missing a dual-rail dependency", () => {
    const { manifest, run } = dependencyPolicyHarness();
    manifest.dependencies = Object.fromEntries(DUAL_RAIL_DEPENDENCIES.filter(name => name !== "viem").map(name => [name, CANDIDATE_VERSION]));
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("dual-rail consumer is missing viem");
  });

  it("rejects an installation whose locked archives npm's cache does not hold", () => {
    const fixture = dependencyPolicyHarness();
    rmSync(fixture.cache, { recursive: true });
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/node_modules\/@kynesyslabs\/dacs: cannot read npm's cached archive .*\(ENOENT\)/);
  });

  it("rejects an unknown policy mode", () => {
    expect(spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", "--dependency-polciy"],
      { cwd: repoRoot }).status).not.toBe(0);
  });

  it.each(["dacs", "dacs-node"])("rejects a %s lock entry with different tarball bytes and reports both digests", name => {
    const { packages, run } = dependencyPolicyHarness();
    const location = `node_modules/@kynesyslabs/${name}`;
    const expected = packages[location]?.integrity;
    packages[location] = { ...packages[location], integrity: "sha512-wrong" };
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`candidate package integrity does not match the packed tarball: ${location} ` +
      `(expected ${String(expected)}, observed sha512-wrong)`);
  });

  it("rejects a candidate lock entry naming another package", () => {
    const { packages, run } = dependencyPolicyHarness();
    packages["node_modules/@kynesyslabs/dacs"] = { ...packages["node_modules/@kynesyslabs/dacs"], name: "@kynesyslabs/other" };
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("candidate package lock name does not match the release: node_modules/@kynesyslabs/dacs");
  });

  it.each(["dacs", "dacs-node"])("rejects a nested @kynesyslabs/%s copy that is not the candidate", name => {
    const fixture = dependencyPolicyHarness();
    const nested = `node_modules/some-plugin/node_modules/@kynesyslabs/${name}`;
    fixture.copyPackage(`node_modules/@kynesyslabs/${name}`, nested);
    expect(fixture.run().status).toBe(0);
    fixture.lockPackage(nested, { "package.json": packageJson(`@kynesyslabs/${name}`, CANDIDATE_VERSION), "index.js": "old" });
    const substituted = fixture.run();
    expect(substituted.status).not.toBe(0);
    expect(substituted.stderr).toContain(`integrity does not match the packed tarball: ${nested}`);
    fixture.copyPackage(`node_modules/@kynesyslabs/${name}`, nested, { resolved: `https://registry.npmjs.org/${name}.tgz` });
    const outside = fixture.run();
    expect(outside.status).not.toBe(0);
    expect(outside.stderr).toContain(`did not resolve through the isolated registry: ${nested}`);
  });

  it.each(["dacs", "dacs-node"])("compares the installed @kynesyslabs/%s with release-provenance.json", name => {
    const { packages, provenance, run } = dependencyPolicyHarness();
    expect(run()).toMatchObject({ status: 0, report: { passed: true, violations: [] } });
    const packed = provenance.packages[`@kynesyslabs/${name}`]?.integrity;
    provenance.packages[`@kynesyslabs/${name}`] = { integrity: sri(Buffer.from("another build")) };
    const recorded = run();
    expect(recorded.status).not.toBe(0);
    expect(recorded.stderr).toContain(`release-provenance.json records ${sri(Buffer.from("another build"))} ` +
      `for @kynesyslabs/${name}, but the packed tarball is ${String(packed)}`);
    // A lock that matches the provenance record but not the packed bytes fails too.
    packages[`node_modules/@kynesyslabs/${name}`] = { ...packages[`node_modules/@kynesyslabs/${name}`], integrity: sri(Buffer.from("another build")) };
    expect(run().status).not.toBe(0);
  });

  // Every installed candidate copy is the release's version in the lock, and
  // its installed package.json is the archive's, top-level or nested. Each
  // case runs the policy once, so it stays well inside the test deadline.
  const releaseCopy = (name: string, nested: boolean) => {
    const fixture = dependencyPolicyHarness();
    const nestedLocation = `node_modules/some-plugin/node_modules/${name}`;
    fixture.copyPackage(`node_modules/${name}`, nestedLocation);
    return { fixture, location: nested ? nestedLocation : `node_modules/${name}` };
  };
  const releaseCopies = CANDIDATES.flatMap(name => [false, true].map(nested => [name, nested] as const));

  it.each(releaseCopies.flatMap(([name, nested]) => [undefined, "0.0.0-wrong", "0.1.0-alpha.0"]
    .map(version => [name, nested, version] as const)))("rejects a %s copy, nested=%s, whose lock version is %s", (name, nested, version) => {
    const { fixture, location } = releaseCopy(name, nested);
    fixture.packages[location] = { ...fixture.packages[location], version };
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`lock version does not match the release: ${location} ` +
      `(expected ${CANDIDATE_VERSION}, observed ${String(version)})`);
  });

  it.each(releaseCopies.flatMap(([name, nested]) => ([[name, "0.0.0-wrong"], ["@kynesyslabs/other", CANDIDATE_VERSION]] as const)
    .map(([installedName, installedVersion]) => [name, nested, installedName, installedVersion] as const)))(
    "rejects a %s copy, nested=%s, whose installed package.json is %s@%s", (name, nested, installedName, installedVersion) => {
      const { fixture, location } = releaseCopy(name, nested);
      fixture.installed[location] = { ...fixture.contents[location], "package.json": packageJson(installedName, installedVersion) };
      const result = fixture.run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`${TREE}changed: ${location}/package.json`);
    });

  it("reports registry-source violations and refuses an unreplayable override contract", () => {
    const fixture = dependencyPolicyHarness();
    fixture.lockPackage("node_modules/x", { "package.json": packageJson("x", "1.0.0") }, { resolved: "https://example.com/x-1.0.0.tgz" });
    expect(fixture.run()).toMatchObject({ status: 0, report: { schema: "dacs-registry-dependency-policy/v1", passed: false,
      violations: [{ location: "node_modules/x", field: "resolved", value: "https://example.com/x-1.0.0.tgz" }] } });
    fixture.manifest.overrides = { viem: "npm:not-viem@1.0.0" };
    expect(registryDependencyViolations({ manifest: fixture.manifest, lock: { packages: { "": fixture.manifest, ...fixture.packages } },
      registry: CANDIDATE_REGISTRY })).toContainEqual({ location: "package.json", field: "overrides", value: '{"viem":"npm:not-viem@1.0.0"}' });
    expect(fixture.run().status).not.toBe(0);
  });

  it("refuses a Git dependency without verified bytes, including a carried module", () => {
    const fixture = dependencyPolicyHarness();
    const location = "node_modules/git-dependency";
    fixture.packages[location] = { version: "1.0.0", resolved: "git+ssh://git@example.com/git-dependency.git#0" };
    fixture.installed[location] = { "package.json": packageJson("git-dependency", "1.0.0"), "lib/index.js": "" };
    expect(fixture.run().status).not.toBe(0);
    const hidden = fixture.run(project => {
      mkdirSync(join(project, location, "lib/node_modules/@kynesyslabs/dacs"), { recursive: true });
      writeFileSync(join(project, location, "lib/node_modules/@kynesyslabs/dacs/package.json"), packageJson("@kynesyslabs/dacs", "0.0.0-old"));
    });
    expect(hidden.status).not.toBe(0);
    expect(hidden.stderr).toContain("cannot authenticate an unverified registry archive: " + location);
  });
});


// The consumer may install registry packages only: an allowlist over every
// lock entry and every dependency spec, not a list of known bad forms.
describe("registry dependency allowlist", () => {
  const registry = "http://127.0.0.1:4873";
  const registered = (name: string) => ({ version: "1.0.0", resolved: `${registry}/${name}/-/${name}-1.0.0.tgz`,
    integrity: sri(Buffer.from(name)) });
  const violationsWith = (packages: Record<string, unknown>, manifest: Record<string, unknown> = {}) =>
    registryDependencyViolations({ manifest, registry,
      lock: { packages: { "": { name: "consumer" }, "node_modules/ok": registered("ok"), ...packages } } });

  it("passes registry tarballs with an integrity and registry specs", () => {
    expect(violationsWith({ "node_modules/a": { ...registered("a"), dependencies: { b: "^1.2.3", c: "1.x || >=2.0.0 <3",
      d: "latest", e: "*", f: "", g: "npm:bitcoinjs-lib@^5.2.0", h: "npm:@scope/pkg@1.0.0", i: ">= 1.2.3-beta.1+build.5" },
    optionalDependencies: { j: "~1.0.0" }, peerDependencies: { k: "^5 || ^6" } } },
    { dependencies: { a: "1.0.0" }, devDependencies: { typescript: "5.9.2" } })).toEqual([]);
  });

  it.each([
    ["a tarball from an arbitrary host", "https://example.com/x/-/x-1.0.0.tgz"],
    ["a codeload.github.com tarball", "https://codeload.github.com/o/x/tar.gz/0123456789abcdef0123456789abcdef01234567"],
    ["a Git URL with a ref", "git+ssh://git@github.com/o/x.git#0123456789abcdef0123456789abcdef01234567"],
    ["a Git URL without a ref", "git+https://github.com/o/x.git"],
    ["a GitLab tarball", "https://gitlab.com/o/x/-/archive/main/x-main.tar.gz"],
    ["a file: tarball", "file:../x-1.0.0.tgz"],
    ["a registry tarball on another port", "http://127.0.0.1:4874/x/-/x-1.0.0.tgz"],
    ["a registry tarball over another scheme", "https://127.0.0.1:4873/x/-/x-1.0.0.tgz"],
    ["a relative path", "../x"],
  ])("rejects an installed entry resolved from %s", (_label, resolved) => {
    expect(violationsWith({ "node_modules/x": { ...registered("x"), resolved } }))
      .toEqual([{ location: "node_modules/x", field: "resolved", value: resolved }]);
  });

  it("rejects an installed entry without resolved, without integrity, or linked to a directory", () => {
    const { resolved: _resolved, ...unresolved } = registered("x");
    const { integrity: _integrity, ...unpinned } = registered("y");
    expect(violationsWith({ "node_modules/x": unresolved, "node_modules/y": unpinned,
      "node_modules/z": { link: true, resolved: "packages/z" }, "node_modules/w": { ...registered("w"), integrity: "sha512-" } }))
      .toEqual([
        { location: "node_modules/x", field: "resolved", value: null },
        { location: "node_modules/y", field: "integrity", value: null },
        { location: "node_modules/z", field: "link", value: "packages/z" },
        { location: "node_modules/z", field: "integrity", value: null },
        { location: "node_modules/w", field: "integrity", value: "sha512-" },
      ]);
  });

  it.each([
    ["a github: shorthand", "github:Irys-xyz/avsc#csp-fixes"],
    ["an owner/repo shorthand", "Irys-xyz/avsc#csp-fixes"],
    ["an owner/repo shorthand without a ref", "Irys-xyz/avsc"],
    ["a GitHub URL without a ref", "https://github.com/Irys-xyz/avsc"],
    ["a GitHub URL with a ref (the #191 avsc form)", "https://github.com/Irys-xyz/avsc#csp-fixes"],
    ["a GitLab URL", "https://gitlab.com/o/avsc#main"],
    ["a gitlab: shorthand", "gitlab:o/avsc"],
    ["a Git URL", "git://github.com/o/avsc.git"],
    ["an scp-style Git URL", "git@github.com:o/avsc.git"],
    ["a tarball URL", "https://example.com/avsc-1.0.0.tgz"],
    ["a file: spec", "file:../avsc"],
    ["a link: spec", "link:../avsc"],
    ["a relative directory", "./avsc"],
    ["a parent directory", "../avsc"],
    ["a tarball file", "avsc-1.0.0.tgz"],
    ["a workspace: spec", "workspace:*"],
  ])("rejects a dependency spec that is %s, in the lock and the manifest", (_label, spec) => {
    expect(violationsWith({ "node_modules/z": { ...registered("z"), dependencies: { avsc: spec } } }))
      .toEqual([{ location: "node_modules/z", field: "dependencies.avsc", value: spec }]);
    expect(violationsWith({ "node_modules/z": { ...registered("z"), optionalDependencies: { avsc: spec } } }))
      .toEqual([{ location: "node_modules/z", field: "optionalDependencies.avsc", value: spec }]);
    expect(violationsWith({}, { dependencies: { avsc: spec } }))
      .toEqual([{ location: "package.json", field: "dependencies.avsc", value: spec }]);
  });

  // Daybreak r10 P3: a present map that was not a plain object was read as
  // empty, so a spec inside it was never checked.
  it.each([
    ["an array", ["github:Irys-xyz/avsc#csp-fixes"]],
    ["a string", "github:Irys-xyz/avsc#csp-fixes"],
    ["null", null],
  ])("rejects a dependency map that is %s, in the lock and the manifest", (_label, map) => {
    const value = JSON.stringify(map);
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
      expect(violationsWith({ "node_modules/z": { ...registered("z"), [field]: map } }))
        .toEqual([{ location: "node_modules/z", field, value }]);
      expect(violationsWith({ "": { name: "consumer", [field]: map } })).toEqual([{ location: "", field, value }]);
      expect(violationsWith({}, { [field]: map })).toEqual([{ location: "package.json", field, value }]);
    }
  });

  it("rejects overrides, which can redirect a package to another source", () => {
    expect(violationsWith({}, { overrides: { viem: "npm:not-viem@2.55.19" } }))
      .toEqual([{ location: "package.json", field: "overrides", value: '{"viem":"npm:not-viem@2.55.19"}' }]);
    expect(violationsWith({}, { overrides: { semver: "7.5.4" } })).toHaveLength(1);
  });

  it("rejects an unreadable lock", () => {
    expect(registryDependencyViolations({ manifest: {}, registry, lock: { packages: [] } }))
      .toEqual([{ location: "package-lock.json", field: "packages", value: null }]);
    expect(violationsWith({ "node_modules/x": [] })).toEqual([{ location: "node_modules/x", field: "entry", value: "[]" }]);
  });

  it("refuses a registry that is neither HTTPS nor this run's loopback registry", () => {
    for (const value of ["http://registry.npmjs.org", "http://10.0.0.1:4873"]) {
      expect(() => registryDependencyViolations({ manifest: {}, lock: { packages: { "": {} } }, registry: value })).toThrow("HTTPS or loopback");
    }
    expect(registryDependencyViolations({ manifest: {}, lock: { packages: { "": {} } }, registry: "https://registry.npmjs.org" })).toEqual([]);
  });

  it("reports exactly the #191 baseline's Git dependency for the b7b180f lock", () => {
    const lock = JSON.parse(readFileSync(join(repoRoot, "test/scripts/fixtures/registry-container-b7b180f/generated-package-lock.json"), "utf8"));
    const baseline = JSON.parse(readFileSync(join(repoRoot, "scripts/registry-container-audit-baseline.json"), "utf8"));
    const violations = registryDependencyViolations({ manifest: lock.packages[""], lock, registry: "http://127.0.0.1:32768" });
    expect(violations).toEqual(baseline.policyFindings.gitDependencies.map(({ location, field, value }:
      { location: string; field: string; value: string }) => ({ location, field, value })));
  });
});

describe("advisory-ID baseline", () => {
  const baseline = JSON.parse(readFileSync(join(repoRoot, "scripts/registry-container-audit-baseline.json"), "utf8"));
  it("accepts an empty #191 list, in which every observed ID is unlisted", () => {
    expect(classifyRegistryAudit(["GHSA-23hp-3jrh-7fpw"], { ...baseline, advisoryIds: [] }))
      .toMatchObject({ unlistedAdvisories: ["GHSA-23hp-3jrh-7fpw"], assessedAdvisories: [] });
  });
});
// Selected original lock entries used by the offline engine scan.
const b7b180f = join(repoRoot, "test/scripts/fixtures/registry-container-b7b180f");
describe("runtime-image package inventory", () => {
  it("reports a lock without packages as an incomplete scan", () => {
    expect(runtimeImageInventoryFindings({ schema: "dacs-runtime-image-inventory/v1", packages: [] }, {}))
      .toEqual({ scanComplete: false, errors: ["the generated lock has no packages"], unexpected: [], missing: [] });
  });

  // The script the acceptance mounts into the image.
  const inventoryScript = join(repoRoot, "scripts/runtime-image-inventory.mjs");
  function imageTree(extra: (root: string) => void = () => undefined) {
    const root = mkdtempSync(join(tmpdir(), "dacs-image-inventory-"));
    scratch.push(root);
    const pkg = (location: string, manifest: Record<string, unknown>) => {
      mkdirSync(join(root, location), { recursive: true });
      writeFileSync(join(root, location, "package.json"), JSON.stringify(manifest));
    };
    pkg("node_modules/a", { name: "a", version: "1.0.0" });
    pkg("node_modules/@s/b", { name: "@s/b", version: "2.0.0" });
    pkg("node_modules/a/node_modules/c", { name: "c", version: "3.0.0" });
    pkg("node_modules/alias", { name: "real", version: "4.0.0" });
    mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
    writeFileSync(join(root, "node_modules/.package-lock.json"), "{}");
    extra(root);
    return root;
  }
  const treeLock = { packages: { "": { name: "app" },
    "node_modules/a": { version: "1.0.0" }, "node_modules/@s/b": { version: "2.0.0" },
    "node_modules/a/node_modules/c": { version: "3.0.0" }, "node_modules/alias": { name: "real", version: "4.0.0" },
    "node_modules/opt": { version: "5.0.0", optional: true } } };

  it("lists every package in the image tree, nested, scoped and aliased", () => {
    const listed = runtimeImageInventory(imageTree());
    expect(listed).toEqual({ schema: "dacs-runtime-image-inventory/v1", packages: [
      { location: "node_modules/@s/b", name: "@s/b", version: "2.0.0" },
      { location: "node_modules/a", name: "a", version: "1.0.0" },
      { location: "node_modules/a/node_modules/c", name: "c", version: "3.0.0" },
      { location: "node_modules/alias", name: "real", version: "4.0.0" },
    ] });
    expect(runtimeImageInventoryFindings(listed, treeLock))
      .toEqual({ scanComplete: true, errors: [], unexpected: [], missing: [] });
    // The CLI the image runs prints the same inventory.
    const cli = spawnSync(process.execPath, [inventoryScript, imageTree()], { encoding: "utf8" });
    expect(cli.status).toBe(0);
    expect(JSON.parse(cli.stdout)).toEqual(listed);
  });

  it.each([
    ["a directory without a readable manifest", (root: string) => mkdirSync(join(root, "node_modules/d"))],
    ["a file Node could load as a module", (root: string) => writeFileSync(join(root, "node_modules/evil.js"), "")],
    ["a symbolic link", (root: string) => symlinkSync(join(root, "node_modules/a"), join(root, "node_modules/e"))],
  ])("lists %s unread, so the scan is incomplete", (_label, extra) => {
    const listed = runtimeImageInventory(imageTree(extra));
    const unread = listed.packages.filter((item: { name: unknown }) => item.name === null);
    expect(unread).toHaveLength(1);
    // A link is recorded as one, so the evidence shows why it was not read.
    expect(unread[0].link === true).toBe(_label === "a symbolic link");
    expect(runtimeImageInventoryFindings(listed, treeLock).scanComplete).toBe(false);
  });

  it("lists an image without node_modules as empty, which lacks the closure", () => {
    const root = mkdtempSync(join(tmpdir(), "dacs-image-inventory-"));
    scratch.push(root);
    const listed = runtimeImageInventory(root);
    expect(listed.packages).toEqual([]);
    expect(runtimeImageInventoryFindings(listed, treeLock).missing).toEqual(
      ["node_modules/a", "node_modules/@s/b", "node_modules/a/node_modules/c", "node_modules/alias"]);
  });

});

// The 206adc1 run stopped here: `npm ci --no-engine-strict` printed every
// EBADENGINE and then failed npm's lock sync check on the nested Git `avsc`
// (EUSAGE), so the scan never completed and the job exited 3.
describe("lock engine scan", () => {
  const lock = () => JSON.parse(readFileSync(join(b7b180f, "generated-package-lock.json"), "utf8"));
  const container = { node: "v20.19.1", npm: "11.19.0" };
  it("skips optional packages and non-object engines, as npm's check does", () => {
    // @arbitrum/sdk (optional) declares engines.npm "please-use-yarn"; verror
    // (optional) declares the legacy array form.
    const value = lock();
    expect(value.packages["node_modules/@arbitrum/sdk"]).toMatchObject({ optional: true,
      engines: { npm: "please-use-yarn" } });
    value.packages["node_modules/verror"].optional = false;
    expect(scanLockEngines(value, container)).toMatchObject({ scanComplete: true, errors: [] });
    value.packages["node_modules/@arbitrum/sdk"].optional = false;
    expect(scanLockEngines(value, container)).toMatchObject({ scanComplete: false,
      errors: [expect.stringContaining("node_modules/@arbitrum/sdk")] });
  });

  it("counts an array-valued lock entry as unreadable, not as evaluated", () => {
    const value = lock();
    value.packages["node_modules/semver"] = [];
    expect(scanLockEngines(value, container)).toMatchObject({ scanComplete: false,
      errors: ["node_modules/semver: unreadable lock entry"] });
  });

  it("checks engines.npm against the container's npm", () => {
    const value = lock();
    value.packages["node_modules/semver"].engines = { node: ">=10", npm: ">=12" };
    expect(scanLockEngines(value, container).violations).toContainEqual({ package: "semver@7.8.5",
      location: "node_modules/semver", integrity: value.packages["node_modules/semver"].integrity,
      required: { node: ">=10", npm: ">=12" } });
    expect(scanLockEngines(value, { ...container, npm: "12.0.0" }).violations).toHaveLength(16);
  });

  it.each([
    ["no lock", undefined, container],
    ["no packages map", { lockfileVersion: 1, dependencies: {} }, container],
    ["no recorded versions", "fixture", null],
    ["a prerelease Node", "fixture", { ...container, node: "v20.19.1-nightly" }],
    ["no recorded npm", "fixture", { node: "v20.19.1" }],
  ])("is incomplete with %s", (_label, value, versions) => {
    const scan = scanLockEngines(value === "fixture" ? lock() : value, versions);
    expect(scan).toMatchObject({ scanComplete: false, evaluatedPackages: 0 });
    expect(scan.errors.length).toBeGreaterThan(0);
  });

  // Expectations from semver.satisfies(version, range, { includePrerelease: true }),
  // which npm's EBADENGINE check uses; the first rows are ranges in the generated lock.
  it.each([
    ["^22.22.2 || ^24.15.0 || >=26.0.0", "20.19.1", false], ["^22.22.2 || ^24.15.0 || >=26.0.0", "22.22.2", true],
    ["^22.22.2 || ^24.15.0 || >=26.0.0", "24.14.9", false], ["^22.22.2 || ^24.15.0 || >=26.0.0", "26.0.0", true],
    ["^20.19.0 || >=22.12.0", "20.19.1", true], ["^20.19.0 || >=22.12.0", "22.11.0", false],
    [">= 0.4", "20.19.1", true], [">= 0.4", "0.3.9", false], [">=v11", "20.19.1", true], [">=v11", "10.9.9", false],
    [">=16 || 14 >=14.17", "14.17.0", true], [">=16 || 14 >=14.17", "14.16.9", false], [">=16 || 14 >=14.17", "15.0.0", false],
    ["4.x || >=6.0.0", "4.9.0", true], ["4.x || >=6.0.0", "5.1.0", false],
    ["6.* || 8.* || >= 10.*", "9.0.0", false], ["6.* || 8.* || >= 10.*", "20.19.1", true],
    ["20.x || 22.x || 23.x || 24.x || 25.x", "20.19.1", true], ["20.x || 22.x || 23.x || 24.x || 25.x", "21.0.0", false],
    ["18 || 20 || >=22", "20.19.1", true], ["18 || 20 || >=22", "21.1.0", false],
    ["> 0.1.90", "0.1.90", false], ["> 0.1.90", "0.1.91", true], ["^14.0 || >=16.0", "15.0.0", false],
    ["^14.0 || >=16.0", "16.0.0", true], ["*", "20.19.1", true], ["<*", "20.19.1", false],
    ["^0.2.3", "0.2.9", true], ["^0.2.3", "0.3.0", false], ["^0.0.3", "0.0.3", true], ["^0.0.3", "0.0.4", false],
    ["^1.2", "1.9.9", true], ["^1.2", "2.0.0", false], ["~1.2.3", "1.2.9", true], ["~1.2.3", "1.3.0", false],
    ["~1", "1.9.0", true], ["~1", "2.0.0", false], ["~> 1.2", "1.2.0", true], ["~> 1.2", "1.3.0", false],
    [">1.2", "1.2.9", false], [">1.2", "1.3.0", true], ["<=1.2", "1.2.9", true], ["<=1.2", "1.3.0", false],
    ["<1", "0.9.9", true], ["<1", "1.0.0", false], ["=1.2", "1.2.5", true], ["=1.2", "1.3.0", false],
    ["1.2.3 - 2.3", "2.3.9", true], ["1.2.3 - 2.3", "2.4.0", false], ["1.2.3 - 2.3.4", "2.3.4", true],
    ["1.2.3 - 2.3.4", "2.3.5", false], ["1.2.3-beta - 2.3.4-rc.1", "1.2.3", true], ["1.2.3-beta - 2.3.4-rc.1", "2.3.4", false],
    [">1.2.3-beta", "1.2.3", true], ["<=1.2.3-beta", "1.2.3", false], ["1.2.3-beta", "1.2.3", false],
    [">=1.2.3+build", "1.2.3", true], ["11.19.0", "11.19.0", true], ["11.19.0", "11.19.1", false],
  ])("evaluates %j at %s as semver does (%s)", (range, version, expected) => {
    expect(satisfiesEngineRange(version, range)).toBe(expected);
    expect(satisfiesEngineRange(`v${version}`, range)).toBe(expected);
  });

  // semver rejects each of these, so npm would not pass them either.
  // The pinned npm's semver 7.8.5 also rejects a plain comparator with a
  // numeric part after an X.
  it.each(["please-use-yarn", "01.2.3", ">=1.2.3.4", "^", "1 -2", "> = 1", "1.2-beta", ">=1 || foo", "V1.2.3",
    "1.x.0", ">=1.x.0", "<1.x.0", "*.1.2", "x.1", "=x.1.2", ">=20 || 1.x.0"])(
    "fails closed on the range %j", (range) => {
      expect(() => satisfiesEngineRange("20.19.1", range)).toThrow(/unsupported engine range/);
    });

  // ...but reads tildes, carets and hyphen ranges with one, as semver 7.8.5 does.
  it.each([
    ["1.5.0", "~1.x.0", true], ["2.0.0", "~1.x.0", false], ["1.5.0", "^1.x.2", true], ["2.0.0", "^1.x.2", false],
    ["1.5.0", "~>1.x.0", true], ["9.9.9", "^x.1", true], ["2.5.0", "1.x.0 - 2", true], ["3.0.0", "1.x.0 - 2", false],
    ["2.9.0", "1 - 2.x.1", true],
  ] as const)("reads %s against %j as semver 7.8.5 does", (version, range, expected) => {
    expect(satisfiesEngineRange(version, range)).toBe(expected);
  });

});


describe("candidate copies hidden in the installed tree", () => {
  const evil = { "package.json": packageJson("@kynesyslabs/dacs", "0.0.0-evil"), "index.js": "module.exports = 'shadow';" };
  const plugin = "node_modules/plugin";
  // Locks a package `plugin` whose archive holds `files` besides its package.json.
  const lockPlugin = (fixture: ReturnType<typeof dependencyPolicyHarness>, files: Record<string, string>) =>
    fixture.lockPackage(plugin, { "package.json": packageJson("plugin", "1.0.0"), ...files });
  const below = (directory: string, files: Record<string, string>) =>
    Object.fromEntries(Object.entries(files).map(([path, body]) => [`${directory}/${path}`, body]));

  it.each([".js", ".json", ".node"])("rejects canonical and declared alias file shadows with extension %s", extension => {
    for (const name of ["dacs", "dacs-node"]) for (const alias of [false, true]) {
      const fixture = dependencyPolicyHarness();
      const specifier = alias ? "candidate-alias" : `@kynesyslabs/${name}`;
      if (alias) fixture.manifest.dependencies = { ...fixture.manifest.dependencies as object,
        [specifier]: `npm:@kynesyslabs/${name}@${CANDIDATE_VERSION}` };
      const location = `node_modules/${specifier}${extension}`;
      const result = fixture.run(project => writeFileSync(join(project, location), extension === ".json" ? "{}" : "module.exports = 42;"));
      expect(result.status, `${name} ${specifier}${extension}`).not.toBe(0);
      expect(result.stderr).toContain(`${TREE}unexpected file: ${location}`);
    }
  });

  it("rejects scope-level node_modules hiding a candidate the lock does not record", () => {
    const scope = "node_modules/@kynesyslabs/node_modules";
    const result = dependencyPolicyHarness().run(project => {
      for (const [path, body] of Object.entries(below("@kynesyslabs/dacs", evil))) {
        mkdirSync(dirname(join(project, scope, path)), { recursive: true });
        writeFileSync(join(project, scope, path), body);
      }
      expect(createRequire(join(project, "node_modules/@kynesyslabs/dacs-node/index.js")).resolve("@kynesyslabs/dacs"))
        .toBe(join(project, scope, "@kynesyslabs/dacs/index.js"));
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(TREE + "unexpected directory: " + scope);
  });

  // Node's ESM resolver, unlike require, searches a `node_modules` directory
  // that is itself inside `node_modules`.
  it("rejects a candidate copy hidden in node_modules/node_modules", () => {
    let resolved = "";
    const result = dependencyPolicyHarness().run(project => {
      const holder = join(project, "node_modules/node_modules/@kynesyslabs/dacs");
      mkdirSync(holder, { recursive: true });
      writeFileSync(join(holder, "package.json"), packageJson("@kynesyslabs/dacs", "0.0.0-evil", { type: "module" }));
      writeFileSync(join(holder, "index.js"), "export default 'shadow';");
      const probe = join(project, "node_modules/@kynesyslabs/dacs-node/probe.mjs");
      writeFileSync(probe, "process.stdout.write(import.meta.resolve('@kynesyslabs/dacs'));");
      resolved = spawnSync(process.execPath, [probe], { encoding: "utf8" }).stdout;
      rmSync(probe);
    });
    expect(resolved).toContain("node_modules/node_modules/@kynesyslabs/dacs/index.js");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(TREE + "unexpected directory: node_modules/node_modules");
  });

  it.each(["dist", "lib/inner"])("rejects a candidate copy in %s/node_modules inside an installed candidate", directory => {
    const host = "node_modules/@kynesyslabs/dacs-node";
    const result = dependencyPolicyHarness().run(project => {
      const holder = join(project, host, directory, "node_modules/@kynesyslabs/dacs");
      mkdirSync(holder, { recursive: true });
      writeFileSync(join(holder, "package.json"), evil["package.json"]);
      expect(createRequire(join(project, host, directory, "index.js")).resolve("@kynesyslabs/dacs/package.json"))
        .toBe(join(holder, "package.json"));
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${TREE}unexpected directory: ${host}/${directory.split("/")[0]}`);
  });

  it.each([
    ["a linked scope directory", (project: string) => symlinkSync(join(project, "elsewhere"), join(project, plugin, "dist/node_modules/@kynesyslabs")),
      `${plugin}/dist/node_modules/@kynesyslabs`],
    ["a linked directory", (project: string) => symlinkSync(join(project, "elsewhere"), join(project, plugin, "dist/linked")), `${plugin}/dist/linked`],
    ["a link to a file outside the package", (project: string) => symlinkSync(join(project, "elsewhere/main.cjs"), join(project, plugin, "main.cjs")),
      `${plugin}/main.cjs`],
    ["a link to a file inside the package", (project: string) => symlinkSync("package.json", join(project, plugin, "main.json")), `${plugin}/main.json`],
  ])("rejects %s inside an installed package, which npm never creates", (_form, link, location) => {
    const fixture = dependencyPolicyHarness();
    lockPlugin(fixture, { "dist/index.js": "", "dist/node_modules/other/package.json": packageJson("other", "1.0.0") });
    const result = fixture.run(project => {
      mkdirSync(join(project, "elsewhere/node_modules/@kynesyslabs/dacs"), { recursive: true });
      writeFileSync(join(project, "elsewhere/main.cjs"), "module.exports = require('@kynesyslabs/dacs');");
      link(project);
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${TREE}unexpected link: ${location}`);
  });

  // npm links the commands of a package's lock `bin` map into .bin, and only those.
  describe("executable links", () => {
    const withBin = () => {
      const fixture = dependencyPolicyHarness();
      fixture.packages["node_modules/@kynesyslabs/dacs"] = { ...fixture.packages["node_modules/@kynesyslabs/dacs"], bin: { dacs: "index.js" } };
      return fixture;
    };
    const linkBin = (project: string, command: string, target: string) => {
      mkdirSync(join(project, "node_modules/.bin"), { recursive: true });
      symlinkSync(target, join(project, "node_modules/.bin", command));
    };
    it("accepts an installed candidate's ordinary executable link", () => {
      expect(withBin().run(project => linkBin(project, "dacs", "../@kynesyslabs/dacs/index.js")))
        .toMatchObject({ status: 0, report: { passed: true } });
    });
    it("accepts an ordinary executable link when the project path goes through a link", () => {
      const fixture = withBin();
      const linked = join(fixture.directory, "linked");
      symlinkSync(fixture.directory, linked);
      expect(fixture.run(project => linkBin(project, "dacs", "../@kynesyslabs/dacs/index.js"), { projectPath: join(linked, "project") }))
        .toMatchObject({ status: 0, report: { passed: true } });
    });
    it.each([
      ["to a file outside every installed package", "runner", "../../elsewhere/runner.cjs", "unexpected link: node_modules/.bin/runner"],
      ["whose target does not exist", "dacs", "../missing-command", "link to an unexpected target: node_modules/.bin/dacs -> ../missing-command"],
    ])("rejects an executable link %s", (_form, command, target, difference) => {
      const result = withBin().run(project => {
        linkBin(project, "dacs", "../@kynesyslabs/dacs/index.js");
        rmSync(join(project, "node_modules/.bin", command), { force: true });
        linkBin(project, command, target);
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(TREE + difference);
    });
    // Node resolves a candidate from a `node_modules` directory placed inside `.bin`.
    it.each(["a directory", "a link to a directory"])("rejects a candidate copy hidden in .bin as %s", form => {
      const hidden = "node_modules/.bin/node_modules";
      const result = withBin().run(project => {
        linkBin(project, "dacs", "../@kynesyslabs/dacs/index.js");
        const holder = form === "a directory" ? join(project, hidden) : join(project, "elsewhere");
        mkdirSync(join(holder, "@kynesyslabs/dacs"), { recursive: true });
        writeFileSync(join(holder, "@kynesyslabs/dacs/package.json"), evil["package.json"]);
        if (form !== "a directory") symlinkSync(holder, join(project, hidden));
        expect(createRequire(join(project, "node_modules/.bin/runner.js")).resolve("@kynesyslabs/dacs/package.json"))
          .toContain(form === "a directory" ? hidden : "elsewhere");
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`${TREE}unexpected ${form === "a directory" ? "directory" : "link"}: ${hidden}`);
    });
  });
});

// Runs the dependency policy on a consumer npm ci --ignore-scripts installed
// from a loopback registry serving the release candidates, the other dual-rail
// packages and `archives`. `locked` adds lock entries (location: the archive
// served and fields for its entry); `declared` adds to the consumer manifest.
async function registryInstallation(directory: string, archives: Record<string, Buffer>,
  locked: Record<string, [archive: string, fields: Record<string, unknown>]>,
  declared: { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> } = {}, npmrc = "") {
  const project = join(directory, "project");
  const cache = join(directory, "npm-cache");
  mkdirSync(project, { recursive: true });
  const served = new Map(Object.entries(archives));
  const provenance = { version: CANDIDATE_VERSION, packages: {} as Record<string, { integrity: string }> };
  for (const name of DUAL_RAIL_DEPENDENCIES) {
    const archive = archives[name] ?? packTarball({ "package.json": packageJson(name, CANDIDATE_VERSION), "index.js": `module.exports = ${JSON.stringify(name)};\n` });
    served.set(name, archive);
    if (CANDIDATES.includes(name)) {
      writeFileSync(join(directory, releaseFile(name)), archive);
      provenance.packages[name] = { integrity: sri(archive) };
    }
  }
  writeFileSync(join(directory, "release-provenance.json"), JSON.stringify(provenance));
  const server = await serveArchives(served);
  try {
    const entry = (archive: string, fields: Record<string, unknown>) => {
      const bytes = served.get(archive);
      if (!bytes) throw new Error("no fixture archive " + archive);
      return { version: CANDIDATE_VERSION, resolved: `${server.registry}/${encodeURIComponent(archive)}.tgz`, integrity: sri(bytes), ...fields };
    };
    const manifest = { name: "fixture-consumer", version: "1.0.0", ...declared,
      dependencies: { ...Object.fromEntries(DUAL_RAIL_DEPENDENCIES.map(name => [name, CANDIDATE_VERSION])), ...declared.dependencies } };
    const packages = { "": manifest, ...Object.fromEntries(DUAL_RAIL_DEPENDENCIES.map(name => [`node_modules/${name}`, entry(name, {})])),
      ...Object.fromEntries(Object.entries(locked).map(([location, [archive, fields]]) => [location, entry(archive, fields)])) };
    writeFileSync(join(project, "package.json"), JSON.stringify(manifest));
    writeFileSync(join(project, "package-lock.json"), JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages }));
    writeFileSync(join(project, ".npmrc"), npmrc);
    const install = await npmCi(project, server.registry, cache);
    expect(install.status, install.output).toBe(0);
    const runPolicy = () => spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", "--dependency-policy",
      project, server.registry, join(directory, "report.json"), directory, CANDIDATE_VERSION],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, npm_config_cache: cache, npm_config_registry: server.registry } });
    return { project, cache, policy: runPolicy(), runPolicy };
  } finally { await server.close(); }
}

describe("dependency policy over npm ci installations", () => {
  const temporaryDirectory = () => {
    const directory = mkdtempSync(join(tmpdir(), "dacs-registry-installation-"));
    scratch.push(directory);
    return directory;
  };

  const oldCandidateGraph = (name = "@kynesyslabs/dacs", intermediate = false, alias = false) => {
    const specifier = alias ? "inner" : name;
    const dependencies = { [specifier]: alias ? `npm:${name}@0.0.9` : "0.0.9" };
    const owner = intermediate ? "mid" : "plugin";
    const archives = {
      plugin: packTarball({ "package.json": packageJson("plugin", CANDIDATE_VERSION,
        { dependencies: intermediate ? { mid: CANDIDATE_VERSION } : dependencies }),
      "index.js": `module.exports = require(${JSON.stringify(intermediate ? "mid" : specifier)});` }),
      mid: packTarball({ "package.json": packageJson("mid", CANDIDATE_VERSION, { dependencies }),
        "index.js": `module.exports = require(${JSON.stringify(specifier)});` }),
      old: packTarball({ "package.json": packageJson(name, "0.0.9"), "index.js": "module.exports = 'unreleased-copy';" }),
    };
    const locked: Record<string, [string, Record<string, unknown>]> = {
      "node_modules/plugin": ["plugin", { dependencies: intermediate ? { mid: CANDIDATE_VERSION } : dependencies }],
      [`node_modules/${owner}/node_modules/${specifier}`]: ["old", { version: "0.0.9", ...(alias ? { name } : {}) }],
    };
    if (intermediate) locked["node_modules/mid"] = ["mid", { dependencies }];
    return { archives, locked };
  };
  const expectLinkedRefusal = (directory: string, policy: { status: number | null; stderr: string }) => {
    expect(policy.status, policy.stderr).not.toBe(0);
    expect(policy.stderr).toContain("install-strategy=linked");
    expect(existsSync(join(directory, "report.json"))).toBe(false);
  };

  it.each(CANDIDATES.flatMap(name => [false, true].map(intermediate => [name, intermediate] as const)))(
    "refuses linked %s copies below a dependency (transitive owner: %s)", async (name, intermediate) => {
      const directory = temporaryDirectory();
      const { archives, locked } = oldCandidateGraph(name, intermediate);
      const { project, policy } = await registryInstallation(directory, archives, locked,
        { dependencies: { plugin: CANDIDATE_VERSION } }, "install-strategy=linked\n");
      const loaded = spawnSync(process.execPath, ["-p", "require('plugin')"], { cwd: project, encoding: "utf8" });
      expect(loaded.status, loaded.stderr).toBe(0);
      expect(loaded.stdout).toBe("unreleased-copy\n");
      expectLinkedRefusal(directory, policy);
    });

  it.each(["environment", "userconfig", "globalconfig"])("refuses linked installs selected through %s", async source => {
    const directory = temporaryDirectory();
    if (source === "environment") vi.stubEnv("npm_config_install_strategy", "linked");
    else {
      const config = join(directory, `${source}.npmrc`);
      writeFileSync(config, "install-strategy=linked\n");
      vi.stubEnv(`npm_config_${source}`, config);
    }
    const { archives, locked } = oldCandidateGraph();
    const { policy } = await registryInstallation(directory, archives, locked, { dependencies: { plugin: CANDIDATE_VERSION } });
    expectLinkedRefusal(directory, policy);
  });

  it("refuses a correct linked install with the explicit layout reason", async () => {
    const directory = temporaryDirectory();
    const { policy } = await registryInstallation(directory, {}, {}, {}, "install-strategy=linked\n");
    expectLinkedRefusal(directory, policy);
  });

  it("refuses linked nested aliases before the shared candidate identity scans", async () => {
    const directory = temporaryDirectory();
    const { archives, locked } = oldCandidateGraph(CANDIDATES[0], false, true);
    const { policy } = await registryInstallation(directory, archives, locked,
      { dependencies: { plugin: CANDIDATE_VERSION } }, "install-strategy=linked\n");
    expectLinkedRefusal(directory, policy);
  });

  it("invalidates a hoisted success report after a linked reinstall", async () => {
    const directory = temporaryDirectory();
    const fixture = await registryInstallation(directory, {}, {});
    expect(fixture.policy.status, fixture.policy.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(directory, "report.json"), "utf8")).passed).toBe(true);
    writeFileSync(join(fixture.project, ".npmrc"), "install-strategy=linked\n");
    const toolchain = npmToolchain();
    runNpmNode(toolchain, [toolchain.cli, "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", `--cache=${fixture.cache}`],
      { cwd: fixture.project });
    expectLinkedRefusal(directory, fixture.runPolicy());
  });

  it("refuses a linked tree when the verifier's contract instead selects hoisted", async () => {
    const directory = temporaryDirectory();
    const fixture = await registryInstallation(directory, {}, {}, {}, "install-strategy=linked\n");
    writeFileSync(join(fixture.project, ".npmrc"), "install-strategy=hoisted\n");
    const policy = fixture.runPolicy();
    expect(policy.status).not.toBe(0);
    expect(policy.stderr).toContain(TREE);
    expect(existsSync(join(directory, "report.json"))).toBe(false);
  });

  it.each(["hoisted", "nested", "shallow"])("keeps canonical checks for %s installs outside the linked layout", async strategy => {
    const directory = temporaryDirectory();
    const { archives, locked } = oldCandidateGraph();
    const { policy } = await registryInstallation(directory, archives, locked,
      { dependencies: { plugin: CANDIDATE_VERSION } }, `install-strategy=${strategy}\n`);
    expect(policy.status).not.toBe(0);
    expect(policy.stderr).toContain("candidate package integrity does not match");
    expect(policy.stderr).toContain("candidate package lock version does not match");
    expect(existsSync(join(directory, "report.json"))).toBe(false);
  });

  it("accepts the release candidates npm installed from the isolated registry", async () => {
    const { policy } = await registryInstallation(temporaryDirectory(), {}, {});
    expect(policy.status, policy.stderr).toBe(0);
  }, 60_000);

  // npm would link the command to a directory, adding a module root inside
  // .bin; the closure admits command links to archive files only.
  it("refuses npm-generated directory links that create additional module roots", async () => {
    const directory = temporaryDirectory();
    const plugin = packTarball({ "package.json": packageJson("plugin", CANDIDATE_VERSION,
      { main: "node_modules/.bin/runner.cjs", dependencies: { "bin-owner": CANDIDATE_VERSION } }),
      "node_modules/.bin/runner.cjs": "module.exports = require('@kynesyslabs/dacs');" });
    const binOwner = packTarball({ "package.json": packageJson("bin-owner", CANDIDATE_VERSION,
      { bin: { node_modules: "modules" } }),
      "modules/@kynesyslabs/dacs/package.json": packageJson(undefined, CANDIDATE_VERSION),
      "modules/@kynesyslabs/dacs/index.js": "module.exports = 'unreleased-copy';" });
    const { project, policy } = await registryInstallation(directory, { plugin, "bin-owner": binOwner }, {
      "node_modules/plugin": ["plugin", { dependencies: { "bin-owner": CANDIDATE_VERSION } }],
      "node_modules/plugin/node_modules/bin-owner": ["bin-owner", { bin: { node_modules: "modules" } }],
    }, { dependencies: { plugin: CANDIDATE_VERSION } });
    const loaded = spawnSync(process.execPath, ["--eval", "console.log(require('plugin'))"], { cwd: project, encoding: "utf8" });
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(loaded.stdout).toBe("unreleased-copy\n");
    expect(policy.status, policy.stderr).not.toBe(0);
    expect(policy.stderr).toContain("link target is not a reference file or package directory: node_modules/plugin/node_modules/.bin/node_modules");
    expect(existsSync(join(directory, "report.json"))).toBe(false);
  }, 60_000);

  it.each(CANDIDATES.flatMap(name => ["name", "version"].map(field => [name, field] as const)))(
    "refuses a %s release archive with the wrong manifest %s despite matching provenance and lock", async (name, field) => {
      const directory = temporaryDirectory();
      const archive = packTarball({ "package.json": packageJson(name, CANDIDATE_VERSION, { [field]: field === "name" ? "other" : "0.0.0-old" }),
        "index.js": "module.exports = 'incorrect-release';" });
      const { project, policy } = await registryInstallation(directory, { [name]: archive }, {});
      expect(JSON.parse(readFileSync(join(project, `node_modules/${name}/package.json`), "utf8"))[field])
        .toBe(field === "name" ? "other" : "0.0.0-old");
      expect(policy.status).not.toBe(0);
      expect(policy.stderr).toContain(`packed candidate manifest does not match the release: ${name}@${CANDIDATE_VERSION}`);
      expect(existsSync(join(directory, "report.json"))).toBe(false);
    }, 60_000);

  it.each(CANDIDATES.flatMap(name => [CANDIDATE_VERSION, "0.0.0-old"].map(version => [name, version] as const)))(
    "refuses bundled %s@%s claiming the release archive's integrity", async (name, version) => {
      const directory = temporaryDirectory();
      const plugin = packTarball({ "package.json": packageJson("plugin", CANDIDATE_VERSION, { bundleDependencies: [name] }),
        "index.js": `module.exports = require(${JSON.stringify(name)});`,
        [`node_modules/${name}/package.json`]: packageJson(name, version),
        [`node_modules/${name}/index.js`]: "module.exports = 'bundled-copy';" });
      const location = `node_modules/plugin/node_modules/${name}`;
      const { project, policy } = await registryInstallation(directory, { plugin }, {
        "node_modules/plugin": ["plugin", {}], [location]: [name, { inBundle: true }],
      }, { dependencies: { plugin: CANDIDATE_VERSION } });
      const loaded = spawnSync(process.execPath, ["--eval", "console.log(require('plugin'))"], { cwd: project, encoding: "utf8" });
      expect(loaded.status, loaded.stderr).toBe(0);
      expect(loaded.stdout).toBe("bundled-copy\n");
      expect(policy.status).not.toBe(0);
      expect(policy.stderr).toContain("candidate package has no independently verified release archive: " + location);
      expect(existsSync(join(directory, "report.json"))).toBe(false);
    }, 60_000);
});

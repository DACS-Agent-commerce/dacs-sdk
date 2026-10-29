import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheArchive, npmCi, packTarball, serveArchives } from "./npm-archive-fixtures.js";
import { auditLock, auditReport } from "./npm-audit-fixtures.js";

// Keep the classifier executable as plain Node ESM.
const dispositionModulePath = "../../scripts/registry-container-disposition.mjs";
const { classifyPolicyChecks, classifyRegistryAudit, registryDependencyViolations, runtimeImageInventoryFindings, satisfiesEngineRange, scanLockEngines } = await import(dispositionModulePath);
const inventoryModulePath = "../../scripts/runtime-image-inventory.mjs";
const { runtimeImageInventory } = await import(inventoryModulePath);
const archiveModulePath = "../../scripts/installation-closure.mjs";
const { npmToolchain, runNpmNode } = await import(archiveModulePath);
// Reference replay invokes the real npm toolchain for each policy scenario.
vi.setConfig({ testTimeout: 60_000 });
const repoRoot = resolve(import.meta.dirname, "../..");
const workflowPath = join(repoRoot, ".github/workflows/registry-container-acceptance.yml");

// A runtime-image inventory that matches the lock's production closure.
const completeInventory = { scanComplete: true, errors: [], missing: [] };

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
  // `environment` adds to the install's and command's environment; `script` and `projectPath` are the
  // paths the command is given, and `nodeArgs` its Node options.
  const run = (afterInstall: (project: string) => void = () => undefined, { environment = {}, script = "scripts/registry-container-disposition.mjs",
    projectPath = project, nodeArgs = [] }: { environment?: Record<string, string>; script?: string; projectPath?: string; nodeArgs?: string[] } = {}) => {
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
        runNpmNode(toolchain, [toolchain.cli, "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", `--cache=${cache}`],
          { cwd: project, env: { ...process.env, ...environment } });
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
    const result = spawnSync(process.execPath, [...nodeArgs, script, "--dependency-policy", projectPath, CANDIDATE_REGISTRY, report, directory, CANDIDATE_VERSION],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, npm_config_cache: cache, ...environment } });
    return { ...result, report: result.status === 0 ? JSON.parse(readFileSync(report, "utf8")) : null };
  };
  return { directory, cache, packages, contents, manifest, provenance, installed, lockPackage, copyPackage, run, report };
}
const TREE = "installed tree is not the locked archives: ";

describe("npm audit graph severity", () => {
  const severities = ["info", "low", "moderate", "high", "critical"];
  const id = "GHSA-23hp-3jrh-7fpw";
  const edge = (name: string, severity: string, url = `https://github.com/advisories/${id}`) =>
    ({ name, url, severity, range: "*" });
  type PackageFinding = { severity: string; isDirect: boolean; via: (string | ReturnType<typeof edge>)[] };
  // Each package marked isDirect is a root dependency in the audited lock.
  function auditFixture() {
    const directory = mkdtempSync(join(tmpdir(), "dacs-audit-severity-"));
    scratch.push(directory);
    const input = join(directory, "audit.json"), lock = join(directory, "lock.json"), output = join(directory, "policy.json");
    const run = (vulnerabilities: Record<string, PackageFinding>) => {
      writeFileSync(input, JSON.stringify(auditReport(vulnerabilities)));
      writeFileSync(lock, JSON.stringify(auditLock(vulnerabilities)));
      return spawnSync(process.execPath, [join(repoRoot, "scripts/registry-container-disposition.mjs"), "--audit-policy", input, lock, output],
        { cwd: repoRoot, encoding: "utf8" });
    };
    return { run, output };
  }

  it.each(severities.flatMap(severity => severities.filter(via => via !== severity)
    .flatMap(via => [true, false].map(isDirect => ({ severity, via, isDirect }))))) (
    "refuses a $severity package with only a $via advisory (direct: $isDirect)", ({ severity, via, isDirect }) => {
      const fixture = auditFixture();
      const result = fixture.run({ fixture: { severity, isDirect, via: [edge("fixture", via)] } });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("npm audit package severity disagrees with reachable advisories");
      expect(existsSync(fixture.output)).toBe(false);
    });

  it.each([
    { root: { severity: "high", isDirect: true, via: ["leaf"] },
      leaf: { severity: "low", isDirect: false, via: [edge("leaf", "low")] } },
    { root: { severity: "high", isDirect: true, via: ["leaf"] },
      leaf: { severity: "high", isDirect: false, via: ["root", edge("leaf", "low")] } },
  ])("refuses contradictory inherited severities %j", graph => {
    const fixture = auditFixture();
    const result = fixture.run(graph);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("npm audit package severity disagrees with reachable advisories");
    expect(existsSync(fixture.output)).toBe(false);
  });

  it.each(severities.flatMap((severity, index) => severities.slice(index + 1)
    .flatMap(via => [true, false].map(isDirect => ({ severity, via, isDirect }))))) (
    "accepts $severity inherited from aggregated $via evidence (direct: $isDirect)", ({ severity, via, isDirect }) => {
      const fixture = auditFixture();
      const result = fixture.run({ root: { severity, isDirect, via: ["leaf"] },
        leaf: { severity: via, isDirect: false, via: [edge("leaf", via)] } });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(fixture.output, "utf8"))).toMatchObject({
        observedAdvisories: [id], directAdvisories: [] });
    });

  it.each([
    { severity: "low", own: "moderate", inherited: "critical", accepted: false },
    { severity: "critical", own: "low", inherited: "high", accepted: false },
    { severity: "moderate", own: "low", inherited: "critical", accepted: true },
    { severity: "high", own: "high", inherited: "critical", accepted: true },
  ])("bounds mixed evidence by own and reachable advisories: %j", ({ severity, own, inherited, accepted }) => {
    const fixture = auditFixture();
    const result = fixture.run({ root: { severity, isDirect: true, via: [edge("root", own), "leaf"] },
      leaf: { severity: inherited, isDirect: false, via: [edge("leaf", inherited)] } });
    expect(result.status === 0, result.stderr).toBe(accepted);
    expect(existsSync(fixture.output)).toBe(accepted);
    if (accepted) expect(JSON.parse(readFileSync(fixture.output, "utf8")).directAdvisories)
      .toEqual(own === "high" ? [id] : []);
  });

  it.each([false, true])("admits a collapsed two-copy audit graph in either package order (reversed: %s)", reversed => {
    const fixture = auditFixture();
    // npm groups leaf@1 (moderate) and leaf@2 (high) into one name-level record.
    const graph = { parent: { severity: "moderate", isDirect: true, via: ["leaf"] },
      other: { severity: "high", isDirect: true, via: ["leaf"] },
      leaf: { severity: "high", isDirect: false, via: [edge("leaf", "moderate"),
        edge("leaf", "high", "https://github.com/advisories/GHSA-2pr8-phx7-x9h3")] } };
    const result = fixture.run(reversed ? Object.fromEntries(Object.entries(graph).reverse()) : graph);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(fixture.output, "utf8"))).toMatchObject({ directAdvisories: [], unlistedAdvisories: [],
      observedAdvisories: [id, "GHSA-2pr8-phx7-x9h3"], observed: { moderate: 1, high: 2, total: 3 } });
  });

  it.each([["low", "critical"], ["critical", "low"]])("uses the maximum own severity in order %j, %j", (first, second) => {
    const fixture = auditFixture();
    expect(fixture.run({ fixture: { severity: "critical", isDirect: true, via: [edge("fixture", first), edge("fixture", second)] } }).status).toBe(0);
    expect(JSON.parse(readFileSync(fixture.output, "utf8")).directAdvisories).toEqual([id]);
  });

  it("propagates a higher severity through an already reached inherited cycle", () => {
    const fixture = auditFixture();
    expect(fixture.run({
      low: { severity: "low", isDirect: false, via: [edge("low", "low")] },
      root: { severity: "critical", isDirect: true, via: ["low", "middle"] },
      middle: { severity: "critical", isDirect: false, via: ["root", "critical"] },
      critical: { severity: "critical", isDirect: false, via: [edge("critical", "critical")] },
    }).status).toBe(0);
    expect(JSON.parse(readFileSync(fixture.output, "utf8")).directAdvisories).toEqual([]);
  });

  it("refuses direct evidence whose own advisory is below its package severity", () => {
    const fixture = auditFixture();
    expect(fixture.run({ fixture: { severity: "high", isDirect: true, via: [edge("fixture", "high")] } }).status).toBe(0);
    expect(JSON.parse(readFileSync(fixture.output, "utf8")).directAdvisories).toEqual([id]);
    const result = fixture.run({ fixture: { severity: "high", isDirect: true, via: [edge("fixture", "low")] } });
    expect(result.status).not.toBe(0);
    expect(existsSync(fixture.output)).toBe(false);
  });
});

describe("complete installed package scopes", { timeout: 60_000 }, () => {
  it.each([
    ["identity", "cannot authenticate a candidate copy carried in the archive of node_modules/plugin: node_modules/plugin/arbitrary/deep"],
    ["alias-name", "the project declares @kynesyslabs/dacs under another name: alias"],
    ["alias-declaration", "node_modules/plugin/arbitrary/deep declares @kynesyslabs/dacs under another name: alias"],
  ])("refuses a nested package scope's %s", (form, refusal) => {
    const fixture = dependencyPolicyHarness();
    fixture.manifest.optionalDependencies = { alias: `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}` };
    fixture.lockPackage("node_modules/plugin", { "package.json": packageJson("plugin", "1.0.0"),
      "arbitrary/deep/package.json": packageJson(form === "identity" ? "@kynesyslabs/dacs" : form === "alias-name" ? "alias" : "inner", "1.0.0",
        { exports: "./copy.cjs", ...(form === "alias-declaration" ? { dependencies: { alias: `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}` } } : {}) }),
      "arbitrary/deep/copy.cjs": "module.exports = 'unreleased-copy';" });
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(refusal);
  });

  it("accepts a package scope whose nested objects and string values reuse the key name", () => {
    const fixture = dependencyPolicyHarness();
    fixture.lockPackage("node_modules/plugin", { "package.json": packageJson("plugin", "1.0.0"),
      "dist/package.json": '{"name":"inner","exports":{"name":{"name":"./a.js"},"./b":[{"name":"x"}]},"description":"name:\\"name\\":"}',
      "dist/a.js": "export default 1;" });
    expect(fixture.run()).toMatchObject({ status: 0, report: { passed: true } });
  });

  it("refuses a package scope that repeats a top-level key", () => {
    const fixture = dependencyPolicyHarness();
    fixture.lockPackage("node_modules/plugin", { "package.json": packageJson("plugin", "1.0.0"),
      "dist/package.json": '{"name":"inner","exports":"./a.js","exports":"./b.js"}', "dist/a.js": "", "dist/b.js": "" });
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("node_modules/plugin/dist");
  });

  it("accepts an ordinary nested package scope without candidate identities or declarations", () => {
    const fixture = dependencyPolicyHarness();
    fixture.lockPackage("node_modules/plugin", { "package.json": packageJson("plugin", "1.0.0"),
      "dist/package.json": packageJson("inner", "1.0.0", { type: "module", exports: "./index.js" }), "dist/index.js": "export default 1;" });
    expect(fixture.run()).toMatchObject({ status: 0, report: { passed: true } });
  });
});

describe("the project's own package scope", { timeout: 60_000 }, () => {
  const shadow = (project: string) => writeFileSync(join(project, "shadow.cjs"), "module.exports = 'unreleased-copy';\n");

  it.each(CANDIDATES)("refuses a project named for candidate %s, which Node resolves to the project itself", name => {
    const fixture = dependencyPolicyHarness();
    Object.assign(fixture.manifest, { name, exports: "./shadow.cjs" });
    const result = fixture.run(project => {
      shadow(project);
      expect(spawnSync(process.execPath, ["-p", `require(${JSON.stringify(name)})`], { cwd: project, encoding: "utf8" }).stdout)
        .toBe("unreleased-copy\n");
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("the project is named for candidate package " + name);
    expect(existsSync(fixture.report)).toBe(false);
  });

  it.each([
    ["the candidates' scope", "@kynesyslabs", { "./dacs": "./shadow.cjs" }, "@kynesyslabs/dacs", "@kynesyslabs/dacs"],
    ["a subpath of dacs-node", "@kynesyslabs/dacs-node/transport", "./shadow.cjs", "@kynesyslabs/dacs-node/transport", "@kynesyslabs/dacs-node"],
    ["a subpath of dacs", "@kynesyslabs/dacs/extra", "./shadow.cjs", "@kynesyslabs/dacs/extra", "@kynesyslabs/dacs"],
  ])("refuses a project named for %s, which Node resolves to the project itself", (_form, name, exports, request, candidate) => {
    const fixture = dependencyPolicyHarness();
    Object.assign(fixture.manifest, { name, exports });
    const result = fixture.run(project => {
      shadow(project);
      expect(spawnSync(process.execPath, ["-p", `require(${JSON.stringify(request)})`], { cwd: project, encoding: "utf8" }).stdout)
        .toBe("unreleased-copy\n");
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("the project is named for candidate package " + candidate);
    expect(existsSync(fixture.report)).toBe(false);
  });

  it.each([["plain", '"name"'], ["escaped", '"\\u006eame"']])("refuses a project package.json that repeats a top-level key (%s spelling)", (_form, key) => {
    const fixture = dependencyPolicyHarness();
    Object.assign(fixture.manifest, { name: "ordinary-root", exports: "./shadow.cjs" });
    const result = fixture.run(project => {
      shadow(project);
      writeFileSync(join(project, "package.json"), `{"name":"@kynesyslabs/dacs",${key}:"ordinary-root",` +
        JSON.stringify({ ...fixture.manifest, name: undefined }).slice(1));
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot read the project package.json: it repeats a top-level key");
    expect(existsSync(fixture.report)).toBe(false);
  });

  it("accepts a project with an ordinary name that exports its own files", () => {
    const fixture = dependencyPolicyHarness();
    Object.assign(fixture.manifest, { name: "ordinary-root", exports: "./shadow.cjs" });
    expect(fixture.run(shadow)).toMatchObject({ status: 0, report: { passed: true } });
  });
});

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

  // npm omits an optional top-level entry, so the replay completes without it.
  it.each(["dacs", "dacs-node"])("requires the top-level %s even with valid nested and aliased copies", name => {
    const { packages, manifest, installed, copyPackage, run } = dependencyPolicyHarness();
    const top = `node_modules/@kynesyslabs/${name}`;
    copyPackage(top, `node_modules/plugin/node_modules/@kynesyslabs/${name}`);
    manifest.dependencies = { ...manifest.dependencies as Record<string, string>, alias: `npm:@kynesyslabs/${name}@${CANDIDATE_VERSION}` };
    manifest.optionalDependencies = { [`@kynesyslabs/${name}`]: CANDIDATE_VERSION };
    packages[top] = { ...packages[top], optional: true };
    installed[top] = null;
    const result = run(undefined, { environment: { npm_config_omit: "optional" } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("candidate package is not installed at the top level: @kynesyslabs/" + name);
    expect(result.stderr).not.toContain("cannot derive reference installation");
  });

  it("refuses an unreplayable candidate integrity without judging candidates", () => {
    const fixture = dependencyPolicyHarness();
    const location = "node_modules/@kynesyslabs/dacs";
    fixture.packages[location] = { ...fixture.packages[location], integrity: "sha512-wrong" };
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot derive reference installation");
    expect(result.stderr).not.toMatch(/not installed at the top level/);
  });

  it("accepts a package.json and lock that start with a byte-order mark, as npm does", () => {
    const fixture = dependencyPolicyHarness();
    const result = fixture.run(project => {
      for (const file of ["package.json", "package-lock.json"]) {
        writeFileSync(join(project, file), "\uFEFF" + readFileSync(join(project, file), "utf8"));
      }
    });
    expect(result.stderr).toBe("");
    expect(result).toMatchObject({ status: 0, report: { passed: true, violations: [] } });
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

  // Node then runs the module by its linked path rather than its real path.
  describe("started through a linked script path with --preserve-symlinks-main", () => {
    const linkedRun = () => {
      const fixture = dependencyPolicyHarness();
      // Link the whole checkout, so files the module finds beside its linked path exist.
      const linked = join(fixture.directory, "linked-checkout");
      symlinkSync(repoRoot, linked);
      const options = { script: join(linked, "scripts/registry-container-disposition.mjs"), nodeArgs: ["--preserve-symlinks-main"] };
      const direct = (...args: string[]) => spawnSync(process.execPath, [...options.nodeArgs, options.script, ...args],
        { cwd: repoRoot, encoding: "utf8" });
      return { fixture, options, direct };
    };

    it("runs the policy and invalidates a previous success report", () => {
      const { fixture, options } = linkedRun();
      expect(fixture.run(undefined, options)).toMatchObject({ status: 0, report: { passed: true } });
      fixture.packages["node_modules/@kynesyslabs/dacs"] = { ...fixture.packages["node_modules/@kynesyslabs/dacs"], integrity: "sha512-wrong" };
      expect(fixture.run(undefined, options).status).not.toBe(0);
      expect(existsSync(fixture.report)).toBe(false);
    });

    it("refuses missing policy arguments and an unknown mode", () => {
      const { fixture, direct } = linkedRun();
      expect(fixture.run().status).toBe(0);
      const usage = direct("--dependency-policy", fixture.directory, CANDIDATE_REGISTRY, fixture.report);
      expect(usage.status).not.toBe(0);
      expect(usage.stderr).toContain("usage: --dependency-policy");
      expect(existsSync(fixture.report)).toBe(false);
      const unknown = direct("--bogus");
      expect(unknown.status).not.toBe(0);
      expect(unknown.stderr).toContain("unsupported registry policy mode: --bogus");
    });
  });

  it.each([["standard input", ["-"]], ["an evaluated script", ["-e"]]])("can be imported from %s without running a mode", (_entry, entry) => {
    const program = `await import(${JSON.stringify(pathToFileURL(join(repoRoot, "scripts/registry-container-disposition.mjs")).href)}); console.log("ok");`;
    const result = spawnSync(process.execPath, ["--input-type=module", ...entry, ...(entry[0] === "-e" ? [program] : [])],
      { cwd: repoRoot, encoding: "utf8", input: program });
    expect(result.stderr).toBe("");
    expect(result).toMatchObject({ status: 0, stdout: "ok\n" });
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
    const { packages, lockPackage, run } = dependencyPolicyHarness();
    const location = `node_modules/@kynesyslabs/${name}`;
    const expected = packages[location]?.integrity;
    const other = lockPackage(location, { "package.json": packageJson(`@kynesyslabs/${name}`, CANDIDATE_VERSION), "index.js": "old" });
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`candidate package integrity does not match the packed tarball: ${location} ` +
      `(expected ${String(expected)}, observed ${sri(other)})`);
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

  it.each(["dacs", "dacs-node"])("rejects an npm alias of %s, substituted or the release", name => {
    const fixture = dependencyPolicyHarness();
    const anotherName = `candidate package @kynesyslabs/${name} is installed under another name: node_modules/alias`;
    fixture.copyPackage(`node_modules/@kynesyslabs/${name}`, "node_modules/alias", { name: `@kynesyslabs/${name}` });
    const release = fixture.run();
    expect(release.status).not.toBe(0);
    expect(release.stderr).toContain(anotherName);
    fixture.lockPackage("node_modules/alias", { "package.json": packageJson("other", CANDIDATE_VERSION) }, { name: `@kynesyslabs/${name}` });
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(anotherName);
  });

  it.each(["dacs", "dacs-node"])("rejects an installed package whose package.json alone names @kynesyslabs/%s", name => {
    const fixture = dependencyPolicyHarness();
    fixture.lockPackage("node_modules/undocumented-copy", { "package.json": packageJson(`@kynesyslabs/${name}`, CANDIDATE_VERSION),
      "index.js": "module.exports = 'old-copy';\n" });
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`candidate package @kynesyslabs/${name} is installed under another name: node_modules/undocumented-copy`);
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
    // npm ci keeps a top-level lock entry only while the root spec accepts it.
    if (!nested) fixture.manifest.dependencies = { ...fixture.manifest.dependencies as Record<string, string>, [name]: version ?? "*" };
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

it("pins the recorded pqcrypto image version while accepting its recorded metadata spelling", () => {
  const known = { name: "pqcrypto", location: "node_modules/pqcrypto", version: "1.0.01" };
  const baseline = { policyFindings: { productionImageDependencies: [known] } };
  const summary = (version: string) => ({ docker: { policy: { typescriptPresent: false, rubicSdkPresent: false, productionDependencyPolicyPassed: false } }, securityGate: {
    productionImageDependencyPolicyPassed: false, engineStrictExitCode: 0,
    lockSbomExitCode: 0, physicalSbomExitCode: 0,
    findings: { productionImageDependencies: [{ ...known, version }], productionImageInventory: completeInventory },
  } });
  expect(classifyPolicyChecks(summary("1.0.01"), baseline).productionImage).toBe("baseline");
  expect(classifyPolicyChecks(summary("9.0.0"), baseline).productionImage).toBe("blocked");
});

// A candidate is declared and installed under its own name only, so an alias
// is refused wherever it is declared, whatever npm installed for it.
describe("declared candidate aliases", () => {
  const aliasOf = (name: string) => `npm:@kynesyslabs/${name}@${CANDIDATE_VERSION}`;
  const other = { "package.json": packageJson("other", CANDIDATE_VERSION) };
  const declares = (declarer: string, specifier: string, name = "dacs") =>
    `${declarer} declares @kynesyslabs/${name} under another name: ${specifier}`;

  it.each(["dacs", "dacs-node"])("rejects a same-version replacement for a declared %s alias", name => {
    const fixture = dependencyPolicyHarness();
    fixture.manifest.dependencies = { ...fixture.manifest.dependencies as object, "candidate-alias": aliasOf(name) };
    fixture.lockPackage("node_modules/candidate-alias", other);
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(declares("the project", "candidate-alias", name));
  });

  it.each(["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"])(
    "rejects installed aliases declared in nested %s maps", field => {
      for (const hoisted of [false, true]) {
        const fixture = dependencyPolicyHarness();
        const location = hoisted ? "node_modules/candidate-alias" : "node_modules/plugin/node_modules/candidate-alias";
        fixture.lockPackage("node_modules/plugin", { "package.json": packageJson("plugin", "1.0.0") },
          { [field]: { "candidate-alias": aliasOf("dacs") } });
        fixture.lockPackage(location, other);
        if (!hoisted) fixture.copyPackage("node_modules/@kynesyslabs/dacs", "node_modules/candidate-alias", { name: "@kynesyslabs/dacs" });
        const result = fixture.run();
        expect(result.status, `${field} ${location}`).not.toBe(0);
        expect(result.stderr).toContain(declares("node_modules/plugin", "candidate-alias"));
      }
    });

  it.each(["dacs", "dacs-node"])("rejects a %s alias declared only by an installed package's own manifest", name => {
    const fixture = dependencyPolicyHarness();
    fixture.lockPackage("node_modules/plugin", { "package.json": packageJson("plugin", "1.0.0",
      { dependencies: { "candidate-alias": aliasOf(name) } }) }, { dependencies: { "candidate-alias": `npm:other@${CANDIDATE_VERSION}` } });
    fixture.lockPackage("node_modules/candidate-alias", other);
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(declares("node_modules/plugin", "candidate-alias", name));
  });

  it("rejects an alias declared by an installed package without a name", () => {
    const fixture = dependencyPolicyHarness();
    fixture.lockPackage("node_modules/plugin", { "package.json": packageJson(undefined, "1.0.0",
      { dependencies: { "candidate-alias": aliasOf("dacs") } }) });
    fixture.lockPackage("node_modules/candidate-alias", other);
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(declares("node_modules/plugin", "candidate-alias"));
  });

  it("rejects an alias even when it holds the exact candidate identity and bytes", () => {
    const fixture = dependencyPolicyHarness();
    fixture.manifest.dependencies = { ...fixture.manifest.dependencies as object, alias: aliasOf("dacs") };
    fixture.copyPackage("node_modules/@kynesyslabs/dacs", "node_modules/alias", { name: "@kynesyslabs/dacs" });
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(declares("the project", "alias"));
    expect(result.stderr).toContain("candidate package @kynesyslabs/dacs is installed under another name: node_modules/alias");
  });

  it.each(["optional", "dev", "devOptional"])("rejects an omitted %s alias, and a present one that is not its archive", flag => {
    const fixture = dependencyPolicyHarness();
    const alias = "node_modules/candidate-alias";
    fixture.copyPackage("node_modules/@kynesyslabs/dacs", alias, { name: "@kynesyslabs/dacs", [flag]: true });
    fixture.manifest.optionalDependencies = { "candidate-alias": aliasOf("dacs") };
    fixture.installed[alias] = null;
    const omitted = fixture.run();
    expect(omitted.status).not.toBe(0);
    expect(omitted.stderr).toContain(declares("the project", "candidate-alias"));
    fixture.installed[alias] = { "package.json": packageJson("@kynesyslabs/dacs", "0.0.0-wrong") };
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${TREE}changed: ${alias}/package.json`);
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

  it.each(["optional", "dev", "devOptional"])("rejects an omitted %s alias Node resolves to another installed package", flag => {
    const fixture = dependencyPolicyHarness();
    const alias = "node_modules/candidate-alias";
    const omitted = "node_modules/plugin/node_modules/candidate-alias";
    fixture.lockPackage("node_modules/plugin", { "package.json": packageJson("plugin", "1.0.0") },
      { optionalDependencies: { "candidate-alias": aliasOf("dacs") } });
    fixture.copyPackage("node_modules/@kynesyslabs/dacs", omitted, { name: "@kynesyslabs/dacs", [flag]: true });
    fixture.installed[omitted] = null;
    fixture.lockPackage(alias, other);
    const result = fixture.run(project => {
      expect(createRequire(join(project, "node_modules/plugin/index.js")).resolve("candidate-alias/package.json"))
        .toBe(join(project, alias, "package.json"));
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(declares("node_modules/plugin", "candidate-alias"));
  });
});

// npm leaves an optional alias out on another platform; Node then keeps
// looking above the project, and require() also in its global folders.
describe("omitted candidate aliases Node resolves outside the installation", () => {
  const omittedAlias = () => {
    const fixture = dependencyPolicyHarness();
    fixture.copyPackage("node_modules/@kynesyslabs/dacs", "node_modules/candidate-alias", { name: "@kynesyslabs/dacs", optional: true });
    fixture.manifest.optionalDependencies = { "candidate-alias": `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}` };
    fixture.installed["node_modules/candidate-alias"] = null;
    return fixture;
  };
  const oldCopy = (directory: string) => {
    const copy = join(directory, "candidate-alias");
    mkdirSync(copy, { recursive: true });
    writeFileSync(join(copy, "package.json"), packageJson("@kynesyslabs/dacs", "0.0.0-old"));
    writeFileSync(join(copy, "index.js"), "module.exports = 'old-copy';\n");
    return realpathSync(copy);
  };
  const refusal = "the project declares @kynesyslabs/dacs under another name: candidate-alias";

  it("rejects an omitted candidate alias Node loads from a parent directory's node_modules", () => {
    const fixture = omittedAlias();
    const copy = oldCopy(join(fixture.directory, "node_modules"));
    const result = fixture.run(project => {
      expect(createRequire(join(project, "index.cjs")).resolve("candidate-alias")).toBe(join(copy, "index.js"));
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(refusal);
  });

  it("rejects an omitted candidate alias require() loads from a NODE_PATH folder", () => {
    const fixture = omittedAlias();
    const folder = join(fixture.directory, "global");
    const copy = oldCopy(folder);
    const result = fixture.run(project => {
      expect(spawnSync(process.execPath, ["--eval", "console.log(require.resolve('candidate-alias'))"],
        { cwd: project, encoding: "utf8", env: { ...process.env, NODE_PATH: folder } }).stdout).toBe(join(copy, "index.js") + "\n");
    }, { environment: { NODE_PATH: folder } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(refusal);
  });

  it("rejects an omitted candidate alias Node finds nowhere", () => {
    const result = omittedAlias().run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(refusal);
  });

  // A package named like the alias it declares resolves that specifier to its
  // own exports before any node_modules, whether or not npm installed the alias.
  it.each([true, false])("rejects a declared candidate alias Node resolves to the declaring package itself, alias installed=%s", installed => {
    const fixture = dependencyPolicyHarness();
    const declarer = "node_modules/self-named";
    fixture.lockPackage(declarer, { "package.json": packageJson("candidate-alias", "1.0.0", { exports: { ".": "./index.js" },
      dependencies: { "candidate-alias": `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}` } }), "index.js": "module.exports = 'itself';\n" });
    fixture.copyPackage("node_modules/@kynesyslabs/dacs", `${declarer}/node_modules/candidate-alias`, { name: "@kynesyslabs/dacs", optional: true });
    if (!installed) fixture.installed[`${declarer}/node_modules/candidate-alias`] = null;
    const result = fixture.run(project => {
      expect(createRequire(join(project, declarer, "index.js")).resolve("candidate-alias")).toBe(join(realpathSync(project), declarer, "index.js"));
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${declarer} declares @kynesyslabs/dacs under another name: candidate-alias`);
  });
});

describe("candidate copies hidden in the installed tree", () => {
  const evil = { "package.json": packageJson("@kynesyslabs/dacs", "0.0.0-evil"), "index.js": "module.exports = 'shadow';" };
  const carried = (owner: string, location: string) => `cannot authenticate a candidate copy carried in the archive of ${owner}: ${location}`;
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

  it.each([false, true])("rejects scope-level node_modules hiding a candidate, locked=%s", locked => {
    const fixture = dependencyPolicyHarness();
    const scope = "node_modules/@kynesyslabs/node_modules";
    if (locked) fixture.lockPackage(scope, { "package.json": packageJson("@kynesyslabs/node_modules", "1.0.0"), ...below("@kynesyslabs/dacs", evil) });
    const result = fixture.run(project => {
      if (!locked) for (const [path, body] of Object.entries(below("@kynesyslabs/dacs", evil))) {
        mkdirSync(dirname(join(project, scope, path)), { recursive: true });
        writeFileSync(join(project, scope, path), body);
      }
      expect(createRequire(join(project, "node_modules/@kynesyslabs/dacs-node/index.js")).resolve("@kynesyslabs/dacs"))
        .toBe(join(project, scope, "@kynesyslabs/dacs/index.js"));
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(locked ? carried(scope, `${scope}/@kynesyslabs/dacs`) : TREE + "unexpected directory: " + scope);
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
    ["a candidate", "@kynesyslabs/dacs", false],
    ["a declared alias of a candidate", "candidate-alias", true],
    ["a copy only its package.json names", "undocumented-copy", false],
    ["a scoped copy only its package.json names", "@other/undocumented-copy", false],
  ])("rejects %s carried in dist/node_modules of a package that is not a candidate", (_form, name, alias) => {
    const fixture = dependencyPolicyHarness();
    if (alias) fixture.manifest.dependencies = { ...fixture.manifest.dependencies as object, [name]: `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}` };
    lockPlugin(fixture, { "dist/index.js": `module.exports = require(${JSON.stringify(name)});`, ...below(`dist/node_modules/${name}`, evil) });
    const result = fixture.run(project => {
      expect(createRequire(join(project, plugin, "dist/index.js")).resolve(name)).toBe(join(project, plugin, "dist/node_modules", name, "index.js"));
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(carried(plugin, `${plugin}/dist/node_modules/${name}`));
  });

  it.each(["dist/node_modules/foo/node_modules", "a/node_modules/b/dist/node_modules"])(
    "rejects a candidate carried in %s below a package that is not a candidate", directory => {
      const fixture = dependencyPolicyHarness();
      lockPlugin(fixture, below(`${directory}/@kynesyslabs/dacs`, evil));
      const result = fixture.run(project => {
        expect(createRequire(join(project, plugin, directory, "..", "index.js")).resolve("@kynesyslabs/dacs"))
          .toBe(join(project, plugin, directory, "@kynesyslabs/dacs/index.js"));
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(carried(plugin, `${plugin}/${directory}/@kynesyslabs/dacs`));
    });

  it("rejects a candidate file shadow carried in node_modules of a package that is not a candidate", () => {
    const fixture = dependencyPolicyHarness();
    lockPlugin(fixture, { "dist/node_modules/@kynesyslabs/dacs.js": "module.exports = 'shadow';" });
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(carried(plugin, `${plugin}/dist/node_modules/@kynesyslabs/dacs.js`));
  });

  it("rejects a carried module whose package.json cannot be read", () => {
    const fixture = dependencyPolicyHarness();
    lockPlugin(fixture, { "dist/node_modules/fixture/package.json": '{"name": "fixture",' });
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(carried(plugin, `${plugin}/dist/node_modules/fixture`));
  });

  it.each([["dacs", "dist/node_modules"], ["dacs-node", "lib/inner/node_modules"]])(
    "rejects a carried package declaring a %s alias that another carried package stands in for, in %s", (name, directory) => {
      const fixture = dependencyPolicyHarness();
      lockPlugin(fixture, {
        [`${directory}/holder/package.json`]: packageJson("holder", "1.0.0", { dependencies: { alias: `npm:@kynesyslabs/${name}@${CANDIDATE_VERSION}` } }),
        [`${directory}/alias/package.json`]: packageJson("other", CANDIDATE_VERSION),
        [`${directory}/alias/index.js`]: "module.exports = 'substituted';",
      });
      const result = fixture.run(project => {
        expect(createRequire(join(project, plugin, directory, "holder/index.js")).resolve("alias"))
          .toBe(join(project, plugin, directory, "alias/index.js"));
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`${plugin}/${directory}/holder declares @kynesyslabs/${name} under another name: alias`);
    });

  it.each([
    ["a module that is no candidate", below("cli/node_modules/@kynesyslabs/other", { "package.json": packageJson("@kynesyslabs/other", "1.0.0") })],
    ["a package whose alias is not a candidate", { "dist/node_modules/holder/package.json": packageJson("holder", "1.0.0",
      { dependencies: { alias: "npm:other@1.0.0" } }) }],
  ])("accepts %s carried in node_modules of a package that is not a candidate", (_form, files) => {
    const fixture = dependencyPolicyHarness();
    lockPlugin(fixture, files);
    expect(fixture.run()).toMatchObject({ status: 0, report: { passed: true } });
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

  it.each([false, true])("rejects a declared dependency alias file shadow, hoisted=%s", hoisted => {
    const fixture = dependencyPolicyHarness();
    lockPlugin(fixture, {});
    fixture.packages[plugin] = { ...fixture.packages[plugin], dependencies: { "candidate-alias": `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}` } };
    const location = hoisted ? "node_modules/candidate-alias.js" : `${plugin}/node_modules/candidate-alias.js`;
    const result = fixture.run(project => {
      mkdirSync(dirname(join(project, location)), { recursive: true });
      writeFileSync(join(project, location), "module.exports = 42;");
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(TREE + `unexpected file: ${location}`);
    expect(result.stderr).toContain(`${plugin} declares @kynesyslabs/dacs under another name: candidate-alias`);
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

  it.each(["fs", "path"])("refuses the built-in resolution of the exact installed candidate alias %s", async specifier => {
    const directory = temporaryDirectory();
    const { project, policy } = await registryInstallation(directory, {}, {
      [`node_modules/${specifier}`]: ["@kynesyslabs/dacs", { name: "@kynesyslabs/dacs" }],
    }, { dependencies: { [specifier]: `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}` } });
    expect(createRequire(join(project, "index.cjs")).resolve(specifier)).toBe(specifier);
    expect(policy.status).not.toBe(0);
    expect(policy.stderr).toContain(`the project declares @kynesyslabs/dacs under another name: ${specifier}`);
    expect(existsSync(join(directory, "report.json"))).toBe(false);
  }, 60_000);

  it.each(["dependencies", "peerDependencies", "devDependencies", "optionalDependencies", "optional-peer"])(
    "refuses a candidate alias the %s map declares, though npm installed nothing for it", async field => {
      const directory = temporaryDirectory();
      const alias = `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}`;
      const plugin = packTarball({ "package.json": packageJson("plugin", CANDIDATE_VERSION,
        field === "optional-peer" ? { peerDependencies: { "candidate-alias": alias },
          peerDependenciesMeta: { "candidate-alias": { optional: true } } } : { [field]: { "candidate-alias": alias } }) });
      const { project, policy } = await registryInstallation(directory, { plugin }, { "node_modules/plugin": ["plugin", {}] },
        { dependencies: { plugin: CANDIDATE_VERSION } });
      expect(() => createRequire(join(project, "node_modules/plugin/index.cjs")).resolve("candidate-alias")).toThrow();
      expect(policy.status).not.toBe(0);
      expect(policy.stderr).toContain("node_modules/plugin declares @kynesyslabs/dacs under another name: candidate-alias");
      expect(existsSync(join(directory, "report.json"))).toBe(false);
    }, 60_000);

  it.each(["identity", "alias-name", "alias-declaration", "malformed", "ordinary"])(
    "authenticates an npm-generated package scope: %s", async form => {
      const directory = temporaryDirectory();
      const alias = `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}`;
      const specifier = form.startsWith("alias-") ? "candidate-alias" : "@kynesyslabs/dacs";
      const scope = form === "malformed" ? "{" : packageJson(
        form === "identity" ? "@kynesyslabs/dacs" : form === "alias-name" ? specifier : "inner", CANDIDATE_VERSION,
        { exports: "./copy.cjs", ...(form === "alias-declaration" ? { dependencies: { [specifier]: alias } } : {}) });
      const plugin = packTarball({ "package.json": packageJson("plugin", CANDIDATE_VERSION,
        { main: "node_modules/.bin/runner.cjs", dependencies: { "bin-owner": CANDIDATE_VERSION } }),
        "node_modules/.bin/runner.cjs": `module.exports = require(${JSON.stringify(specifier)});`,
        "node_modules/.bin/copy.cjs": "module.exports = 'unreleased-copy';",
        // npm replaces this archived scope with the generated command link.
        ...(form === "ordinary" ? { "node_modules/.bin/package.json": packageJson("@kynesyslabs/dacs", CANDIDATE_VERSION,
          { exports: "./copy.cjs" }) } : {}) });
      const binOwner = packTarball({ "package.json": packageJson("bin-owner", CANDIDATE_VERSION,
        { bin: { "package.json": "scope.json" } }), "scope.json": scope });
      const other = packTarball({ "package.json": packageJson("other", CANDIDATE_VERSION),
        "index.js": "module.exports = 'unreleased-copy';" });
      const { project, policy } = await registryInstallation(directory, { plugin, "bin-owner": binOwner, other }, {
        "node_modules/plugin": ["plugin", { dependencies: { "bin-owner": CANDIDATE_VERSION } }],
        "node_modules/plugin/node_modules/bin-owner": ["bin-owner", { bin: { "package.json": "scope.json" } }],
        ...(form === "alias-declaration" ? { "node_modules/candidate-alias": ["other", {}] as [string, Record<string, unknown>] } : {}),
      }, { dependencies: { plugin: CANDIDATE_VERSION },
        ...(form === "alias-name" ? { optionalDependencies: { [specifier]: alias } } : {}) });
      const installedScope = join(project, "node_modules/plugin/node_modules/.bin/package.json");
      expect(realpathSync(installedScope)).toBe(join(project, "node_modules/plugin/node_modules/bin-owner/scope.json"));
      expect(readFileSync(installedScope, "utf8")).toBe(scope);
      const loaded = spawnSync(process.execPath, ["--eval", "console.log(require('plugin'))"], { cwd: project, encoding: "utf8" });
      if (form === "ordinary") {
        expect(loaded.status, loaded.stderr).toBe(0);
        expect(loaded.stdout).toBe("@kynesyslabs/dacs\n");
        expect(policy.status, policy.stderr).toBe(0);
        expect(JSON.parse(readFileSync(join(directory, "report.json"), "utf8"))).toMatchObject({ passed: true });
      } else {
        if (form === "malformed") expect(loaded.status).not.toBe(0);
        else {
          expect(loaded.status, loaded.stderr).toBe(0);
          expect(loaded.stdout).toBe("unreleased-copy\n");
        }
        expect(policy.status, policy.stderr).not.toBe(0);
        expect(policy.stderr).toContain(form === "alias-name" ? `the project declares @kynesyslabs/dacs under another name: ${specifier}`
          : "node_modules/plugin/node_modules/.bin");
        expect(existsSync(join(directory, "report.json"))).toBe(false);
      }
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
    expect(policy.stderr).toContain("link target is not a reference file: node_modules/plugin/node_modules/.bin/node_modules");
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

  it.each(["identity", "alias"])("refuses a SHA-1 registry archive hiding a candidate %s", async form => {
    const directory = temporaryDirectory();
    const plugin = packTarball({ "package.json": packageJson(form === "identity" ? CANDIDATES[0] : "plugin", CANDIDATE_VERSION,
      form === "alias" ? { dependencies: { alias: `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}` } } : {}),
      "index.js": form === "alias" ? "module.exports = require('alias');" : "module.exports = 'unreleased-copy';" });
    const other = packTarball({ "package.json": packageJson("other", CANDIDATE_VERSION), "index.js": "module.exports = 'unreleased-copy';" });
    const { project, policy } = await registryInstallation(directory, { plugin, other }, {
      "node_modules/plugin": ["plugin", { integrity: "sha1-" + createHash("sha1").update(plugin).digest("base64") }],
      ...(form === "alias" ? { "node_modules/alias": ["other", {}] as [string, Record<string, unknown>] } : {}),
    }, { dependencies: { plugin: CANDIDATE_VERSION, ...(form === "alias" ? { alias: CANDIDATE_VERSION } : {}) } });
    expect(spawnSync(process.execPath, ["--eval", "console.log(require('plugin'))"], { cwd: project, encoding: "utf8" }).stdout)
      .toBe("unreleased-copy\n");
    expect(policy.status).not.toBe(0);
    // The reference cannot read a SHA-1 archive, so the replay refuses before any candidate rule.
    expect(policy.stderr).toContain("cannot derive reference installation");
    expect(policy.stderr).toContain("node_modules/plugin: integrity has no single sha512 digest");
    expect(existsSync(join(directory, "report.json"))).toBe(false);
  }, 60_000);

  it.each(["dist", "lib/deep/inner"])("refuses a candidate self-reference in the nested %s package scope", async scope => {
    const plugin = packTarball({ "package.json": packageJson("plugin", CANDIDATE_VERSION, { main: `${scope}/index.cjs` }),
      [`${scope}/package.json`]: packageJson("@kynesyslabs/dacs", CANDIDATE_VERSION, { exports: "./copy.cjs" }),
      [`${scope}/index.cjs`]: "module.exports = require('@kynesyslabs/dacs');",
      [`${scope}/copy.cjs`]: "module.exports = 'unreleased-copy';" });
    const { project, policy } = await registryInstallation(temporaryDirectory(), { plugin },
      { "node_modules/plugin": ["plugin", {}] }, { dependencies: { plugin: CANDIDATE_VERSION } });
    expect(spawnSync(process.execPath, ["--eval", "console.log(require('plugin'))"], { cwd: project, encoding: "utf8" }).stdout)
      .toBe("unreleased-copy\n");
    expect(policy.status).not.toBe(0);
    expect(policy.stderr).toContain(`cannot authenticate a candidate copy carried in the archive of node_modules/plugin: node_modules/plugin/${scope}`);
  }, 60_000);

  // Node matches a package scope by prefix, so a scope named for a candidate's
  // own scope or for a subpath of the candidate captures a require() of it.
  it.each([
    ["the candidates' scope", "@kynesyslabs", { "./dacs": "./copy.cjs" }, "@kynesyslabs/dacs"],
    ["a subpath of dacs-node", "@kynesyslabs/dacs-node/transport", "./copy.cjs", "@kynesyslabs/dacs-node/transport"],
    ["a subpath of dacs", "@kynesyslabs/dacs/extra", "./copy.cjs", "@kynesyslabs/dacs/extra"],
  ])("refuses a nested package scope named for %s", async (_form, scopeName, exports, request) => {
    const plugin = packTarball({ "package.json": packageJson("plugin", CANDIDATE_VERSION, { main: "dist/index.cjs" }),
      "dist/package.json": packageJson(scopeName, CANDIDATE_VERSION, { exports }),
      "dist/index.cjs": `module.exports = require(${JSON.stringify(request)});`,
      "dist/copy.cjs": "module.exports = 'unreleased-copy';" });
    const { project, policy } = await registryInstallation(temporaryDirectory(), { plugin },
      { "node_modules/plugin": ["plugin", {}] }, { dependencies: { plugin: CANDIDATE_VERSION } });
    expect(spawnSync(process.execPath, ["--eval", "console.log(require('plugin'))"], { cwd: project, encoding: "utf8" }).stdout)
      .toBe("unreleased-copy\n");
    expect(policy.status).not.toBe(0);
    expect(policy.stderr).toContain("cannot authenticate a candidate copy carried in the archive of node_modules/plugin: node_modules/plugin/dist");
  }, 60_000);

  it("accepts a nested package scope named for a sibling of a candidate", async () => {
    const plugin = packTarball({ "package.json": packageJson("plugin", CANDIDATE_VERSION, { main: "dist/index.cjs" }),
      "dist/package.json": packageJson("@kynesyslabs/dacs-other", CANDIDATE_VERSION, { exports: "./copy.cjs" }),
      "dist/index.cjs": "module.exports = 1;", "dist/copy.cjs": "module.exports = 1;" });
    const { policy } = await registryInstallation(temporaryDirectory(), { plugin },
      { "node_modules/plugin": ["plugin", {}] }, { dependencies: { plugin: CANDIDATE_VERSION } });
    expect(policy.status, policy.stderr).toBe(0);
  }, 60_000);

  // Supported Node versions differ on which name they use; the policy refuses both.
  it("refuses a package scope with an escaped duplicate name regardless of runtime resolution", async () => {
    const directory = temporaryDirectory();
    const plugin = packTarball({ "package.json": packageJson("plugin", CANDIDATE_VERSION, { main: "dist/index.cjs" }),
      "dist/package.json": '{"name":"@kynesyslabs/dacs","\\u006eame":"ordinary-scope","exports":"./copy.cjs"}',
      "dist/index.cjs": "module.exports = require('@kynesyslabs/dacs');",
      "dist/copy.cjs": "module.exports = 'unreleased-copy';" });
    const { policy } = await registryInstallation(directory, { plugin },
      { "node_modules/plugin": ["plugin", {}] }, { dependencies: { plugin: CANDIDATE_VERSION } });
    expect(policy.status).not.toBe(0);
    expect(policy.stderr).toContain("cannot authenticate a candidate copy carried in the archive of node_modules/plugin: node_modules/plugin/dist");
    expect(existsSync(join(directory, "report.json"))).toBe(false);
  }, 60_000);

  // The lock records only fixture-plugin; npm still installs the old copy its
  // archive carries, and require() from its dist directory loads that copy.
  it("rejects a candidate copy carried in a dependency's archive that the lock does not record", async () => {
    const plugin = packTarball({ "package.json": packageJson("fixture-plugin", "1.0.0", { main: "dist/index.cjs" }),
      "dist/index.cjs": "module.exports = require('@kynesyslabs/dacs');\n",
      "dist/node_modules/@kynesyslabs/dacs/package.json": packageJson("@kynesyslabs/dacs", "0.0.0-old"),
      "dist/node_modules/@kynesyslabs/dacs/index.js": "module.exports = 'old-copy';\n" });
    const { project, policy } = await registryInstallation(temporaryDirectory(), { "fixture-plugin": plugin },
      { "node_modules/fixture-plugin": ["fixture-plugin", { version: "1.0.0" }] }, { dependencies: { "fixture-plugin": "1.0.0" } });
    expect(spawnSync(process.execPath, ["--eval", "console.log(require('fixture-plugin'))"], { cwd: project, encoding: "utf8" }).stdout).toBe("old-copy\n");
    expect(policy.status).not.toBe(0);
    expect(policy.stderr).toContain("cannot authenticate a candidate copy carried in the archive of node_modules/fixture-plugin: " +
      "node_modules/fixture-plugin/dist/node_modules/@kynesyslabs/dacs");
  }, 60_000);

  // npm skips the optional alias on this platform although the lock records
  // the release's integrity for it; CommonJS and ESM then load the parent
  // project's old copy.
  it("rejects an omitted optional candidate alias that loads a parent project's copy", async () => {
    const directory = temporaryDirectory();
    const parentCopy = join(directory, "node_modules/candidate-alias");
    mkdirSync(parentCopy, { recursive: true });
    writeFileSync(join(parentCopy, "package.json"), packageJson("@kynesyslabs/dacs", "0.0.0-old"));
    writeFileSync(join(parentCopy, "index.js"), "module.exports = 'ancestor';\n");
    const { project, policy } = await registryInstallation(directory, {},
      { "node_modules/candidate-alias": ["@kynesyslabs/dacs", { name: "@kynesyslabs/dacs", optional: true, os: [`!${process.platform}`] }] },
      { optionalDependencies: { "candidate-alias": `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}` } });
    expect(existsSync(join(project, "node_modules/candidate-alias"))).toBe(false);
    expect(createRequire(join(project, "index.cjs")).resolve("candidate-alias")).toBe(join(realpathSync(parentCopy), "index.js"));
    expect(spawnSync(process.execPath, ["--input-type=module", "--eval", "console.log(import.meta.resolve('candidate-alias'))"],
      { cwd: project, encoding: "utf8" }).stdout).toContain(`${realpathSync(parentCopy)}/index.js`);
    expect(policy.status).not.toBe(0);
    expect(policy.stderr).toContain("the project declares @kynesyslabs/dacs under another name: candidate-alias");
  }, 60_000);
});

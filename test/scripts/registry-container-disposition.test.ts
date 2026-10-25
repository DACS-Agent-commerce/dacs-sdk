import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Keep the classifier executable as plain Node ESM.
const dispositionModulePath = "../../scripts/registry-container-disposition.mjs";
const { candidateIntegrityErrors, classifyRegistryAudit, registryDependencyViolations, runtimeImageInventoryFindings, satisfiesEngineRange, scanLockEngines } = await import(dispositionModulePath);
const inventoryModulePath = "../../scripts/runtime-image-inventory.mjs";
const { runtimeImageInventory } = await import(inventoryModulePath);
const repoRoot = resolve(import.meta.dirname, "../..");
const workflowPath = join(repoRoot, ".github/workflows/registry-container-acceptance.yml");
const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// Every child runs without rc files and with an explicit PATH whose `node` is
// this process's own binary, never a host node.
const CANDIDATE_VERSION = "0.1.0-test";
const CANDIDATE_REGISTRY = "http://host.docker.internal:4873";
const sri = (bytes: Buffer) => "sha512-" + createHash("sha512").update(bytes).digest("base64");

// Runs the dependency-policy command the script runs against a generated
// consumer whose lock initially names the exact packed candidate tarballs,
// as release-provenance.json records them.
function dependencyPolicyHarness() {
  const directory = mkdtempSync(join(tmpdir(), "dacs-registry-integrity-"));
  scratch.push(directory);
  const packages: Record<string, Record<string, unknown>> = {};
  const provenance = { version: CANDIDATE_VERSION, packages: {} as Record<string, { integrity: string }> };
  for (const name of ["dacs", "dacs-node"]) {
    const bytes = Buffer.from(name);
    writeFileSync(join(directory, `kynesyslabs-${name}-${CANDIDATE_VERSION}.tgz`), bytes);
    packages[`node_modules/@kynesyslabs/${name}`] = {
      version: CANDIDATE_VERSION,
      resolved: `${CANDIDATE_REGISTRY}/${name}.tgz`,
      integrity: sri(bytes),
    };
    provenance.packages[`@kynesyslabs/${name}`] = { integrity: sri(bytes) };
  }
  const project = join(directory, "project");
  mkdirSync(project);
  const manifest: Record<string, unknown> = { dependencies: Object.fromEntries([
    "@kynesyslabs/dacs", "@kynesyslabs/dacs-node", "@kynesyslabs/demosdk", "@x402/core",
    "@x402/evm", "@x402/fetch", "better-sqlite3", "viem",
  ].map((name) => [name, CANDIDATE_VERSION])) };
  const report = join(directory, "report.json");
  // The package.json installed at each candidate lock location: by default
  // the lock entry's own name and version; `null` installs none.
  const installed: Record<string, Record<string, unknown> | null> = {};
  const run = (afterInstall: (project: string) => void = () => undefined) => {
    rmSync(join(project, "node_modules"), { recursive: true, force: true });
    for (const [location, entry] of Object.entries(packages)) {
      const name = typeof entry.name === "string" ? entry.name : location.replace(/^.*node_modules\//, "");
      if (name !== "@kynesyslabs/dacs" && name !== "@kynesyslabs/dacs-node") continue;
      const installedManifest = location in installed ? installed[location] : { name, version: entry.version };
      if (installedManifest === null) continue;
      mkdirSync(join(project, location), { recursive: true });
      writeFileSync(join(project, location, "package.json"), JSON.stringify(installedManifest));
    }
    afterInstall(project);
    writeFileSync(join(project, "package.json"), JSON.stringify(manifest));
    writeFileSync(join(project, "package-lock.json"), JSON.stringify({ packages: { "": {}, ...packages } }));
    writeFileSync(join(directory, "release-provenance.json"), JSON.stringify(provenance));
    const result = spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", "--dependency-policy",
      project, CANDIDATE_REGISTRY, report, directory, CANDIDATE_VERSION], { cwd: repoRoot, encoding: "utf8" });
    return { ...result, report: result.status === 0 ? JSON.parse(readFileSync(report, "utf8")) : null };
  };
  return { packages, manifest, provenance, installed, run, report };
}

// Executes the script's own summary program over a stage holding the evidence
// a complete run collects; `overrides` replaces individual evidence files.
describe("registry/container evidence", () => {
  it.each(["dacs", "dacs-node"])("rejects an untracked installed nested or aliased %s", name => {
    for (const location of [`node_modules/plugin/node_modules/@kynesyslabs/${name}`, "node_modules/untracked-alias"]) {
      const fixture = dependencyPolicyHarness();
      const result = fixture.run(project => {
        mkdirSync(join(project, location), { recursive: true });
        writeFileSync(join(project, location, "package.json"), JSON.stringify({ name: `@kynesyslabs/${name}`, version: "0.0.0-wrong" }));
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("installed candidate has no lock entry: " + location);
    }
  });
  it.each(["dacs", "dacs-node"])("requires the top-level %s even with valid nested and aliased copies", name => {
    const { packages, run } = dependencyPolicyHarness();
    const top = `node_modules/@kynesyslabs/${name}`;
    const entry = packages[top];
    expect(entry).toBeDefined();
    packages[`node_modules/plugin/node_modules/@kynesyslabs/${name}`] = { ...entry };
    packages["node_modules/alias"] = { ...entry, name: `@kynesyslabs/${name}` };
    delete packages[top];
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("candidate package is not installed at the top level: @kynesyslabs/" + name);
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
  it("rejects an unknown policy mode", () => {
    expect(spawnSync(process.execPath, ["scripts/registry-container-disposition.mjs", "--dependency-polciy"],
      { cwd: repoRoot }).status).not.toBe(0);
  });

  it("rejects a registry lock entry with different tarball bytes and reports both digests", () => {
    const { packages, run } = dependencyPolicyHarness();
    expect(run().status).toBe(0);
    const expected = packages["node_modules/@kynesyslabs/dacs-node"]!.integrity;
    packages["node_modules/@kynesyslabs/dacs-node"]!.integrity = "sha512-wrong";
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("integrity does not match");
    expect(result.stderr).toContain(`expected ${expected}, observed sha512-wrong`);
  });

  it("rejects a core lock entry with different tarball bytes", () => {
    const { packages, run } = dependencyPolicyHarness();
    packages["node_modules/@kynesyslabs/dacs"]!.integrity = sri(Buffer.from("other core"));
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("integrity does not match the packed tarball: node_modules/@kynesyslabs/dacs");
  });

  it.each(["dacs", "dacs-node"])("rejects a nested @kynesyslabs/%s copy that is not the candidate", (name) => {
    const { packages, run } = dependencyPolicyHarness();
    const topLevel = packages[`node_modules/@kynesyslabs/${name}`]!;
    const nested = `node_modules/some-plugin/node_modules/@kynesyslabs/${name}`;
    packages[nested] = { ...topLevel };
    expect(run().status).toBe(0);
    packages[nested] = { resolved: `${CANDIDATE_REGISTRY}/${name}-old.tgz`, integrity: sri(Buffer.from("old")) };
    const substituted = run();
    expect(substituted.status).not.toBe(0);
    expect(substituted.stderr).toContain(`integrity does not match the packed tarball: ${nested}`);
    packages[nested] = { resolved: `https://registry.npmjs.org/${name}.tgz`, integrity: topLevel.integrity };
    const outside = run();
    expect(outside.status).not.toBe(0);
    expect(outside.stderr).toContain(`did not resolve through the isolated registry: ${nested}`);
  });

  it.each(["dacs", "dacs-node"])("rejects a substituted npm alias of %s", (name) => {
    const { packages, run } = dependencyPolicyHarness();
    packages["node_modules/alias"] = { ...packages[`node_modules/@kynesyslabs/${name}`]!, name: `@kynesyslabs/${name}` };
    expect(run().status).toBe(0);
    packages["node_modules/alias"]!.integrity = "sha512-wrong";
    expect(run().status).not.toBe(0);
  });

  it.each(["dacs", "dacs-node"])("compares the installed @kynesyslabs/%s with release-provenance.json", (name) => {
    const { packages, provenance, run } = dependencyPolicyHarness();
    expect(run()).toMatchObject({ status: 0, report: { passed: true, violations: [] } });
    const packed = provenance.packages[`@kynesyslabs/${name}`]!.integrity;
    provenance.packages[`@kynesyslabs/${name}`]!.integrity = sri(Buffer.from("another build"));
    const recorded = run();
    expect(recorded.status).not.toBe(0);
    expect(recorded.stderr).toContain(`release-provenance.json records ${sri(Buffer.from("another build"))} ` +
      `for @kynesyslabs/${name}, but the packed tarball is ${packed}`);
    // A lock that matches the provenance record but not the packed bytes fails too.
    packages[`node_modules/@kynesyslabs/${name}`]!.integrity = sri(Buffer.from("another build"));
    expect(run().status).not.toBe(0);
  });

  // Every installed candidate copy is the release's version, in the lock and
  // in the package.json npm installed, top-level, nested or aliased.
  it.each(["dacs", "dacs-node"])("rejects a @kynesyslabs/%s copy that is not the release version", (name) => {
    const { packages, installed, run } = dependencyPolicyHarness();
    const topLevel = `node_modules/@kynesyslabs/${name}`;
    const nested = `node_modules/some-plugin/node_modules/@kynesyslabs/${name}`;
    packages[nested] = { ...packages[topLevel]! };
    packages["node_modules/alias"] = { ...packages[topLevel]!, name: `@kynesyslabs/${name}` };
    expect(run().status).toBe(0);
    for (const location of [topLevel, nested, "node_modules/alias"]) {
      const entry = packages[location]!;
      for (const version of [undefined, "0.0.0-wrong", "0.1.0-alpha.0"]) {
        packages[location] = version === undefined
          ? Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "version"))
          : { ...entry, version };
        installed[location] = { name: `@kynesyslabs/${name}`, version: CANDIDATE_VERSION };
        const lockVersion = run();
        expect(lockVersion.status, `${location} ${String(version)}`).not.toBe(0);
        expect(lockVersion.stderr).toContain(`lock version does not match the release: ${location} ` +
          `(expected ${CANDIDATE_VERSION}, observed ${String(version)})`);
      }
      packages[location] = entry;
      for (const manifest of [null, { name: `@kynesyslabs/${name}`, version: "0.0.0-wrong" },
        { name: "@kynesyslabs/other", version: CANDIDATE_VERSION }]) {
        installed[location] = manifest;
        const installedCopy = run();
        expect(installedCopy.status, `${location} ${JSON.stringify(manifest)}`).not.toBe(0);
        expect(installedCopy.stderr).toContain(`installed candidate package is not the release: ${location}`);
      }
      delete installed[location];
      expect(run().status).toBe(0);
    }
  }, 30_000);

  it("writes every registry-policy violation to the report the summary reads", () => {
    const { packages, manifest, run } = dependencyPolicyHarness();
    packages["node_modules/x"] = { version: "1.0.0", resolved: "https://example.com/x-1.0.0.tgz", integrity: sri(Buffer.from("x")) };
    manifest.overrides = { viem: "npm:not-viem@1.0.0" };
    expect(run()).toMatchObject({ status: 0, report: { schema: "dacs-registry-dependency-policy/v1", passed: false,
      violations: [{ location: "package.json", field: "overrides", value: '{"viem":"npm:not-viem@1.0.0"}' },
        { location: "node_modules/x", field: "resolved", value: "https://example.com/x-1.0.0.tgz" }] } });
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


describe("canonical installed candidate discovery", () => {
  it.each(["dacs", "dacs-node"])("rejects untracked %s copies with missing, different or unreadable names", name => {
    for (const manifest of [{ version: "0.0.0-wrong" }, { name: "other", version: "0.0.0-wrong" }, null]) {
      const fixture = dependencyPolicyHarness();
      const location = `node_modules/plugin/node_modules/@kynesyslabs/${name}`;
      const result = fixture.run(project => {
        mkdirSync(join(project, location), { recursive: true });
        if (manifest) writeFileSync(join(project, location, "package.json"), JSON.stringify(manifest));
        writeFileSync(join(project, location, "index.js"), "module.exports = 'old';");
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("installed candidate has no lock entry: " + location);
    }
  });
});

describe("declared candidate alias authentication", () => {
  it.each(["dacs", "dacs-node"])("rejects a same-version replacement for a declared %s alias", name => {
    const fixture = dependencyPolicyHarness();
    const alias = "node_modules/candidate-alias";
    fixture.manifest.dependencies = Object.assign({}, fixture.manifest.dependencies, { "candidate-alias": `npm:@kynesyslabs/${name}@${CANDIDATE_VERSION}` });
    fixture.packages[alias] = { name: "@example/other", version: CANDIDATE_VERSION,
      resolved: `${CANDIDATE_REGISTRY}/other.tgz`, integrity: sri(Buffer.from("replacement")) };
    const result = fixture.run(project => {
      mkdirSync(join(project, alias), { recursive: true });
      writeFileSync(join(project, alias, "package.json"), JSON.stringify({ name: "@example/other", version: CANDIDATE_VERSION }));
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("candidate package integrity does not match the packed tarball: " + alias);
  });
});


describe("candidate alias lookup through dependency maps", () => {
  it.each(["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"])(
    "authenticates installed aliases declared in nested %s maps", field => {
      for (const hoisted of [false, true]) {
        const fixture = dependencyPolicyHarness();
        const location = hoisted ? "node_modules/candidate-alias" : "node_modules/plugin/node_modules/candidate-alias";
        fixture.packages["node_modules/plugin"] = { name: "plugin", version: "1.0.0",
          resolved: `${CANDIDATE_REGISTRY}/plugin.tgz`, integrity: sri(Buffer.from("plugin")),
          [field]: { "candidate-alias": `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}` } };
        fixture.packages[location] = { name: "other", version: CANDIDATE_VERSION,
          resolved: `${CANDIDATE_REGISTRY}/other.tgz`, integrity: sri(Buffer.from("other")) };
        if (!hoisted) fixture.packages["node_modules/candidate-alias"] = {
          ...fixture.packages["node_modules/@kynesyslabs/dacs"], name: "@kynesyslabs/dacs",
        };
        const result = fixture.run(project => {
          mkdirSync(join(project, "node_modules/plugin"), { recursive: true });
          writeFileSync(join(project, "node_modules/plugin/package.json"), JSON.stringify({ name: "plugin", version: "1.0.0" }));
          mkdirSync(join(project, location), { recursive: true });
          writeFileSync(join(project, location, "package.json"), JSON.stringify({ name: "other", version: CANDIDATE_VERSION }));
        });
        expect(result.status, `${field} ${location}`).not.toBe(0);
        expect(result.stderr).toContain("candidate package integrity does not match the packed tarball: " + location);
      }
    });
  it("accepts an alias that retains the exact candidate identity and bytes", () => {
    const fixture = dependencyPolicyHarness();
    fixture.manifest.dependencies = Object.assign({}, fixture.manifest.dependencies, { alias: `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}` });
    fixture.packages["node_modules/alias"] = { ...fixture.packages["node_modules/@kynesyslabs/dacs"], name: "@kynesyslabs/dacs" };
    expect(fixture.run().status).toBe(0);
  });
});


describe("candidate file shadows and omitted copies", () => {
  it.each([".js", ".json", ".node"])("rejects canonical and declared alias file shadows with extension %s", extension => {
    for (const name of ["dacs", "dacs-node"]) for (const alias of [false, true]) {
      const fixture = dependencyPolicyHarness();
      const spec = alias ? "candidate-alias" : `@kynesyslabs/${name}`;
      if (alias) fixture.manifest.dependencies = Object.assign({}, fixture.manifest.dependencies, {
        [spec]: `npm:@kynesyslabs/${name}@${CANDIDATE_VERSION}` });
      const location = `node_modules/${spec}${extension}`;
      const result = fixture.run(project => {
        writeFileSync(join(project, location), extension === ".json" ? "{}" : "module.exports = 42;");
        expect(createRequire(join(project, "package.json")).resolve(spec)).toBe(join(project, location));
      });
      expect(result.status, `${name} ${spec}${extension}`).not.toBe(0);
      expect(result.stderr).toContain(location);
    }
  });
  it.each(["optional", "dev", "devOptional"])("allows an omitted %s alias but authenticates it when present", flag => {
    const fixture = dependencyPolicyHarness();
    const alias = "node_modules/candidate-alias";
    fixture.packages[alias] = { ...fixture.packages["node_modules/@kynesyslabs/dacs"], name: "@kynesyslabs/dacs", [flag]: true };
    fixture.manifest.optionalDependencies = { "candidate-alias": `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}` };
    fixture.installed[alias] = null;
    expect(fixture.run()).toMatchObject({ status: 0, report: { passed: true } });
    fixture.installed[alias] = { name: "@kynesyslabs/dacs", version: "0.0.0-wrong" };
    expect(fixture.run().status).not.toBe(0);
  });
  it("requires a top-level candidate even if its absent lock entry is optional", () => {
    const fixture = dependencyPolicyHarness();
    const location = "node_modules/@kynesyslabs/dacs";
    fixture.packages[location] = { ...fixture.packages[location], optional: true };
    fixture.installed[location] = null;
    expect(fixture.run().status).not.toBe(0);
  });
  it.each([new SyntaxError("fixture malformed JSON"), Object.assign(new Error("permission denied"), { code: "EACCES" })])(
    "preserves installed manifest failure cause: %s", cause => {
      const location = "node_modules/@kynesyslabs/dacs";
      const errors = candidateIntegrityErrors({ manifest: {}, registry: CANDIDATE_REGISTRY,
        lock: { packages: { [location]: { version: CANDIDATE_VERSION, resolved: `${CANDIDATE_REGISTRY}/dacs.tgz`, integrity: "sha512-fixture" } } },
        candidates: [{ name: "@kynesyslabs/dacs", version: CANDIDATE_VERSION, integrity: "sha512-fixture" }],
        installedManifest: () => { throw cause; } });
      expect(errors.join("\n")).toContain(location);
      expect(errors.join("\n")).toContain(cause.message);
      expect(errors.join("\n")).toContain(cause instanceof SyntaxError ? "SyntaxError" : "EACCES");
    });
});

describe("candidate executable and nested alias lookup", () => {
  it.each([false, true])("rejects scope-level node_modules hiding a candidate, locked=%s", locked => {
    const fixture = dependencyPolicyHarness();
    const scope = "node_modules/@kynesyslabs/node_modules";
    if (locked) fixture.packages[scope] = { name: "@kynesyslabs/node_modules", version: "1.0.0",
      resolved: `${CANDIDATE_REGISTRY}/scope.tgz`, integrity: sri(Buffer.from("scope")) };
    const result = fixture.run(project => {
      const location = join(project, scope, "@kynesyslabs/dacs");
      mkdirSync(location, { recursive: true });
      writeFileSync(join(location, "package.json"), JSON.stringify({ name: "@kynesyslabs/dacs", version: "0.0.0-wrong" }));
      writeFileSync(join(location, "index.js"), "module.exports = 'shadow';");
      if (locked) writeFileSync(join(project, scope, "package.json"), JSON.stringify({ name: "@kynesyslabs/node_modules", version: "1.0.0" }));
      expect(createRequire(join(project, "node_modules/@kynesyslabs/dacs-node/index.js")).resolve("@kynesyslabs/dacs"))
        .toBe(join(location, "index.js"));
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot inspect a node_modules directory inside node_modules or a scope directory: " + scope);
  });

  // Node's ESM resolver, unlike require, searches a `node_modules` directory
  // that is itself inside `node_modules`.
  it("rejects a candidate copy hidden in node_modules/node_modules", () => {
    const fixture = dependencyPolicyHarness();
    let resolved = "";
    const result = fixture.run(project => {
      const holder = join(project, "node_modules/node_modules/@kynesyslabs/dacs");
      mkdirSync(holder, { recursive: true });
      writeFileSync(join(holder, "package.json"), JSON.stringify({ name: "@kynesyslabs/dacs", version: "0.0.0-evil", type: "module" }));
      writeFileSync(join(holder, "index.js"), "export default 'shadow';");
      const probe = join(project, "node_modules/@kynesyslabs/dacs-node/probe.mjs");
      writeFileSync(probe, "process.stdout.write(import.meta.resolve('@kynesyslabs/dacs'));");
      resolved = spawnSync(process.execPath, [probe], { encoding: "utf8" }).stdout;
    });
    expect(resolved).toContain("node_modules/node_modules/@kynesyslabs/dacs/index.js");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot inspect a node_modules directory inside node_modules or a scope directory: node_modules/node_modules");
  });

  it.each(["dist", "lib/inner"])("rejects a candidate copy hidden in %s/node_modules inside an installed candidate", directory => {
    const fixture = dependencyPolicyHarness();
    const host = "node_modules/@kynesyslabs/dacs-node";
    const result = fixture.run(project => {
      const holder = join(project, host, directory, "node_modules/@kynesyslabs/dacs");
      mkdirSync(holder, { recursive: true });
      writeFileSync(join(holder, "package.json"), JSON.stringify({ name: "@kynesyslabs/dacs", version: "0.0.0-evil" }));
      writeFileSync(join(holder, "index.js"), "module.exports = 'shadow';");
      expect(createRequire(join(project, host, directory, "index.js")).resolve("@kynesyslabs/dacs")).toBe(join(holder, "index.js"));
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`cannot inspect node_modules inside an installed candidate: ${host}/${directory}/node_modules`);
  });

  it.each([
    ["a candidate", "@kynesyslabs/dacs", false],
    ["a declared alias of a candidate", "candidate-alias", true],
  ])("rejects %s hidden in dist/node_modules inside a package that is not a candidate", (_form, name, alias) => {
    const fixture = dependencyPolicyHarness();
    if (alias) fixture.manifest.dependencies = Object.assign({}, fixture.manifest.dependencies, {
      [name]: `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}` });
    const plugin = "node_modules/plugin";
    const result = fixture.run(project => {
      const holder = join(project, plugin, "dist/node_modules", name);
      mkdirSync(holder, { recursive: true });
      writeFileSync(join(project, plugin, "package.json"), JSON.stringify({ name: "plugin", version: "1.0.0" }));
      writeFileSync(join(holder, "package.json"), JSON.stringify({ name: "@kynesyslabs/dacs", version: "0.0.0-evil" }));
      writeFileSync(join(holder, "index.js"), "module.exports = 'shadow';");
      expect(createRequire(join(project, plugin, "dist/index.js")).resolve(name)).toBe(join(holder, "index.js"));
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`cannot inspect a candidate inside node_modules in an installed package: ${plugin}/dist/node_modules`);
  });

  it.each(["undocumented-copy", "@other/undocumented-copy"])(
    "rejects a candidate hidden as %s in dist/node_modules, which only its manifest names", directory => {
      const fixture = dependencyPolicyHarness();
      const plugin = "node_modules/plugin";
      const result = fixture.run(project => {
        const holder = join(project, plugin, "dist/node_modules", directory);
        mkdirSync(holder, { recursive: true });
        writeFileSync(join(project, plugin, "package.json"), JSON.stringify({ name: "plugin", version: "1.0.0" }));
        writeFileSync(join(holder, "package.json"), JSON.stringify({ name: "@kynesyslabs/dacs", version: "0.0.0-evil" }));
        writeFileSync(join(holder, "index.js"), "module.exports = 'shadow';");
        expect(createRequire(join(project, plugin, "dist/index.js")).resolve(directory)).toBe(join(holder, "index.js"));
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`cannot inspect a candidate inside node_modules in an installed package: ${plugin}/dist/node_modules`);
    });

  it.each([
    ["dist/node_modules/foo/node_modules", "dist/node_modules/foo/node_modules"],
    ["a/node_modules/b/dist/node_modules", "a/node_modules/b/dist/node_modules"],
  ])("rejects a candidate hidden in %s below a package that is not a candidate", (directory, reported) => {
    const fixture = dependencyPolicyHarness();
    const plugin = "node_modules/plugin";
    const result = fixture.run(project => {
      const holder = join(project, plugin, directory, "@kynesyslabs/dacs");
      mkdirSync(holder, { recursive: true });
      writeFileSync(join(project, plugin, "package.json"), JSON.stringify({ name: "plugin", version: "1.0.0" }));
      writeFileSync(join(holder, "package.json"), JSON.stringify({ name: "@kynesyslabs/dacs", version: "0.0.0-evil" }));
      writeFileSync(join(holder, "index.js"), "module.exports = 'shadow';");
      const importer = join(project, plugin, directory, "..", "index.js");
      expect(createRequire(importer).resolve("@kynesyslabs/dacs")).toBe(join(holder, "index.js"));
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`cannot inspect a candidate inside node_modules in an installed package: ${plugin}/${reported}`);
  });

  it("rejects a candidate behind a linked scope directory in node_modules inside a package that is not a candidate", () => {
    const fixture = dependencyPolicyHarness();
    const plugin = "node_modules/plugin";
    const result = fixture.run(project => {
      const target = join(project, "scope-target");
      mkdirSync(join(target, "dacs"), { recursive: true });
      mkdirSync(join(project, plugin, "dist/node_modules"), { recursive: true });
      writeFileSync(join(project, plugin, "package.json"), JSON.stringify({ name: "plugin", version: "1.0.0" }));
      writeFileSync(join(target, "dacs/package.json"), JSON.stringify({ name: "@kynesyslabs/dacs", version: "0.0.0-evil" }));
      writeFileSync(join(target, "dacs/index.js"), "module.exports = 'shadow';");
      symlinkSync(target, join(project, plugin, "dist/node_modules/@kynesyslabs"));
      expect(createRequire(join(project, plugin, "dist/index.js")).resolve("@kynesyslabs/dacs")).toBe(join(target, "dacs/index.js"));
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`cannot inspect a candidate inside node_modules in an installed package: ${plugin}/dist/node_modules`);
  });

  it("rejects a candidate file shadow in node_modules inside a package that is not a candidate", () => {
    const fixture = dependencyPolicyHarness();
    const result = fixture.run(project => {
      mkdirSync(join(project, "node_modules/plugin/dist/node_modules/@kynesyslabs"), { recursive: true });
      writeFileSync(join(project, "node_modules/plugin/package.json"), JSON.stringify({ name: "plugin", version: "1.0.0" }));
      writeFileSync(join(project, "node_modules/plugin/dist/node_modules/@kynesyslabs/dacs.js"), "module.exports = 'shadow';");
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("node_modules/plugin/dist/node_modules");
  });

  it("accepts node_modules inside a package that is not a candidate when it holds no candidate", () => {
    const fixture = dependencyPolicyHarness();
    expect(fixture.run(project => {
      mkdirSync(join(project, "node_modules/plugin/cli/node_modules/@kynesyslabs/other"), { recursive: true });
      writeFileSync(join(project, "node_modules/plugin/package.json"), JSON.stringify({ name: "plugin", version: "1.0.0" }));
      writeFileSync(join(project, "node_modules/plugin/cli/node_modules/@kynesyslabs/other/package.json"), JSON.stringify({ name: "@kynesyslabs/other", version: "1.0.0" }));
    })).toMatchObject({ status: 0, report: { passed: true } });
  });

  it.each(["optional", "dev", "devOptional"])("follows the installed alias past an omitted %s lock entry", flag => {
    const fixture = dependencyPolicyHarness();
    const alias = "node_modules/candidate-alias";
    const omitted = "node_modules/plugin/node_modules/candidate-alias";
    fixture.packages["node_modules/plugin"] = { version: "1.0.0", resolved: `${CANDIDATE_REGISTRY}/plugin.tgz`,
      integrity: sri(Buffer.from("plugin")), optionalDependencies: { "candidate-alias": `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}` } };
    fixture.packages[omitted] = { ...fixture.packages["node_modules/@kynesyslabs/dacs"], name: "@kynesyslabs/dacs", [flag]: true };
    fixture.installed[omitted] = null;
    fixture.packages[alias] = { name: "other", version: CANDIDATE_VERSION,
      resolved: `${CANDIDATE_REGISTRY}/other.tgz`, integrity: sri(Buffer.from("other")) };
    const result = fixture.run(project => {
      mkdirSync(join(project, "node_modules/plugin"), { recursive: true });
      mkdirSync(join(project, alias), { recursive: true });
      writeFileSync(join(project, alias, "package.json"), JSON.stringify({ name: "other", version: CANDIDATE_VERSION }));
      expect(createRequire(join(project, "node_modules/plugin/index.js")).resolve("candidate-alias/package.json"))
        .toBe(join(project, alias, "package.json"));
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("candidate package integrity does not match the packed tarball: " + alias);
    fixture.packages[alias] = { ...fixture.packages["node_modules/@kynesyslabs/dacs"], name: "@kynesyslabs/dacs" };
    expect(fixture.run()).toMatchObject({ status: 0, report: { passed: true } });
  });

  it("accepts an installed candidate's ordinary executable link", () => {
    const fixture = dependencyPolicyHarness();
    expect(fixture.run(project => {
      const directory = join(project, "node_modules/.bin");
      mkdirSync(directory);
      writeFileSync(join(project, "node_modules/@kynesyslabs/dacs/cli.js"), "module.exports = 42;");
      symlinkSync("../@kynesyslabs/dacs/cli.js", join(directory, "dacs"));
    })).toMatchObject({ status: 0, report: { passed: true } });
  });
  // The inventory lists each `.bin` entry without descending into it, yet Node
  // resolves a candidate from a `node_modules` directory placed inside `.bin`.
  it.each(["a directory", "a link to a directory"])("rejects a candidate copy hidden in .bin as %s", form => {
    const fixture = dependencyPolicyHarness();
    const hiddenCopy = "node_modules/.bin/node_modules/@kynesyslabs/dacs";
    const result = fixture.run(project => {
      const holder = form === "a directory" ? join(project, "node_modules/.bin/node_modules") : join(project, "elsewhere");
      mkdirSync(join(holder, "@kynesyslabs/dacs"), { recursive: true });
      writeFileSync(join(holder, "@kynesyslabs/dacs/package.json"), JSON.stringify({ name: "@kynesyslabs/dacs", version: "0.0.0-evil" }));
      if (form !== "a directory") {
        mkdirSync(join(project, "node_modules/.bin"), { recursive: true });
        symlinkSync(holder, join(project, "node_modules/.bin/node_modules"));
      }
      expect(createRequire(join(project, "node_modules/.bin/runner.js")).resolve("@kynesyslabs/dacs/package.json"))
        .toContain(form === "a directory" ? hiddenCopy : "elsewhere");
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot inspect a .bin entry that is not an executable link: node_modules/.bin/node_modules");
  });
  it.each([false, true])("rejects a declared dependency alias file shadow, hoisted=%s", hoisted => {
    const fixture = dependencyPolicyHarness();
    fixture.packages["node_modules/plugin"] = { version: "1.0.0", resolved: `${CANDIDATE_REGISTRY}/plugin.tgz`,
      integrity: sri(Buffer.from("plugin")), dependencies: { "candidate-alias": `npm:@kynesyslabs/dacs@${CANDIDATE_VERSION}` } };
    const location = hoisted ? "node_modules/candidate-alias.js" : "node_modules/plugin/node_modules/candidate-alias.js";
    const result = fixture.run(project => {
      mkdirSync(dirname(join(project, location)), { recursive: true });
      writeFileSync(join(project, location), "module.exports = 42;");
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(location);
  });
});

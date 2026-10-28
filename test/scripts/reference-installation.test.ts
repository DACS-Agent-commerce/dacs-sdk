import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { cacheArchive, npmCi, packTarball, serveArchives, sri, tarArchive, type TarEntry } from "./npm-archive-fixtures.js";

// Keep the closure executable as plain Node ESM.
const closureModulePath = "../../scripts/installation-closure.mjs";
const { cachedArchive, npmToolchain, runNpmNode } = await import(closureModulePath);
const referenceModulePath = "../../scripts/reference-installation.mjs";
const { referenceInstallation, installationDifferences, installationInventory, npmInstallContract } = await import(referenceModulePath);
function installationClosure(project: string, lock: unknown, readArchive: unknown) {
  return referenceInstallation({ manifest: JSON.parse(readFileSync(join(project, "package.json"), "utf8")),
    lock, readArchive, installer: npmInstallContract(project) });
}

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const temporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), "dacs-installation-closure-"));
  scratch.push(directory);
  return directory;
};
const manifest = (name: string, version = "1.0.0", fields: Record<string, unknown> = {}) =>
  JSON.stringify({ name, version, ...fields });
const text = (files: Map<string, Buffer>) => Object.fromEntries([...files].map(([path, bytes]) => [path, bytes.toString()]));

// A project whose lock names `packages` ({ location: [lock entry, files] }),
// each archive cached and its files written where npm installs them.
function simulatedInstall(packages: Record<string, [Record<string, unknown>, Record<string, string> | null]>) {
  const project = temporaryDirectory();
  const cache = join(project, ".npm");
  const root: Record<string, unknown> = { name: "consumer", version: "1.0.0", dependencies: {} };
  const lock: { lockfileVersion: number; packages: Record<string, Record<string, unknown>> } = {
    lockfileVersion: 3, packages: { "": root },
  };
  const omitted = new Set<string>();
  for (const location of Object.keys(packages)) {
    for (let split = location.lastIndexOf("/node_modules/"); split >= 0;) {
      const parent = location.slice(0, split);
      packages[parent] ??= [{}, { "package.json": manifest(parent.slice(parent.lastIndexOf("node_modules/") + "node_modules/".length)) }];
      split = parent.lastIndexOf("/node_modules/");
    }
  }
  for (const [location, [fields, files]] of Object.entries(packages)) {
    const entry: Record<string, unknown> = { version: "1.0.0", resolved: `https://registry.invalid/${encodeURIComponent(location)}.tgz`, ...fields };
    if (files) entry.version = JSON.parse(files["package.json"] ?? "{}").version ?? entry.version;
    if (fields.devOptional) Object.assign(entry, { optional: true, dev: true });
    lock.packages[location] = entry;
    if (!files && !fields.inBundle) {
      if (fields.dev) omitted.add("dev");
      if (fields.optional || fields.devOptional) omitted.add("optional");
    }
  }
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location) continue;
    const split = location.lastIndexOf("/node_modules/");
    const name = split < 0 ? location.slice("node_modules/".length) : location.slice(split + "/node_modules/".length);
    const owner = split < 0 ? root : lock.packages[location.slice(0, split)];
    if (owner) {
      const field = entry.dev ? "devDependencies" : entry.optional || entry.devOptional ? "optionalDependencies" : "dependencies";
      const dependencies = (owner[field] ?? {}) as Record<string, unknown>;
      owner[field] = { ...dependencies, [name]: entry.version };
      if (entry.inBundle) owner.bundleDependencies = [...(owner.bundleDependencies as string[] ?? []), name];
    }
  }
  for (const [location, [entry]] of Object.entries(packages)) {
    if (!entry.inBundle) continue;
    for (const [owner, [, files]] of Object.entries(packages)) {
      const path = location.slice(owner.length + 1) + "/package.json";
      if (location.startsWith(owner + "/") && files?.[path]) {
        files[path] = JSON.stringify({ ...JSON.parse(files[path]), ...(entry.bin ? { bin: entry.bin } : {}) });
      }
    }
  }
  for (const [location, [, files]] of Object.entries(packages)) {
    if (!files) continue;
    const entry = lock.packages[location];
    if (!entry) throw new Error("missing fixture lock entry");
    // Populate the archive's dependency declarations as a real packed package would.
    const original = JSON.parse(files["package.json"] ?? "{}");
    files["package.json"] = JSON.stringify({ ...original,
      ...Object.fromEntries(["dependencies", "optionalDependencies", "devDependencies", "bundleDependencies", "bin"]
        .filter(key => entry[key] !== undefined).map(key => [key, entry[key]])) });
    const archive = packTarball(files);
    cacheArchive(cache, archive);
    entry.integrity = entry.integrity ?? sri(archive);
  }
  writeFileSync(join(project, "package.json"), JSON.stringify(root));
  writeFileSync(join(project, "package-lock.json"), JSON.stringify(lock));
  writeFileSync(join(project, ".npmrc"), omitted.size ? `omit=${[...omitted].join(",")}\n` : "");
  const toolchain = npmToolchain();
  // Complete once to obtain npm's generated artifacts; restore original archive
  // command bytes/paths below to exercise interrupted states independently.
  if (Object.values(lock.packages).every(entry => !entry.resolved || String(entry.resolved).startsWith("https://"))) {
    try { runNpmNode(toolchain, [toolchain.cli, "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", `--cache=${cache}`], { cwd: project }); }
    catch { /* Invalid/missing-source fixtures deliberately have no completed baseline. */ }
  }
  const removeBins = (directory: string) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const path = join(directory, item.name);
      if (item.name === ".bin") rmSync(path, { recursive: true });
      else removeBins(path);
    }
  };
  if (readdirSync(project).includes("node_modules")) removeBins(join(project, "node_modules"));
  for (const [location, [, files]] of Object.entries(packages)) {
    for (const [path, body] of Object.entries(files ?? {})) {
      mkdirSync(dirname(join(project, location, path)), { recursive: true });
      writeFileSync(join(project, location, path), body);
    }
  }
  // A fixture's independent inputs are immutable except for explicit .npmrc
  // edits; comparator scenarios reuse that reference rather than rerun npm.
  const references = new Map<string, ReturnType<typeof referenceInstallation>>();
  const closure = () => {
    const config = readFileSync(join(project, ".npmrc"), "utf8");
    if (!references.has(config)) references.set(config, installationClosure(project, lock,
      (_location: string, entry: { integrity: string }) => cachedArchive(cache, entry.integrity)));
    return references.get(config);
  };
  return { project, lock, closure, differences: () => installationDifferences(project, closure()) };
}

describe("reference exclusive options", { timeout: 60_000 }, () => {
  it.each([
    ["defaults", ""],
    ...["save-dev", "save-optional", "save-peer", "save-prod", "provenance"].map(key => [key, `${key}=true\n`]),
    ["provenance-file", "provenance-file=./provenance.json\n"],
    ["expect-results", "expect-results=false\n"],
    ["expect-result-count", "expect-result-count=0\n"],
  ])("replays %s and preserves other false settings", (_selected, config) => {
    const fixture = simulatedInstall({ "node_modules/a": [{}, { "package.json": manifest("a") }] });
    writeFileSync(join(fixture.project, ".npmrc"), `bin-links=false\n${config}`);
    const installer = npmInstallContract(fixture.project);
    expect(installer.config["bin-links"]).toBe(false);
    const reference = referenceInstallation({ manifest: JSON.parse(readFileSync(join(fixture.project, "package.json"), "utf8")),
      lock: fixture.lock, installer, readArchive: (_location: string, locked: { integrity: string }) =>
        cachedArchive(join(fixture.project, ".npm"), locked.integrity) });
    expect(reference.errors).toEqual([]);
    expect(reference.inventory).toBeInstanceOf(Map);
  });
});

describe("installation closure", { timeout: 60_000 }, () => {
  it("accepts an installed tree that is exactly the locked archives", () => {
    const install = simulatedInstall({
      "node_modules/a": [{ version: "1.0.0", bin: { a: "cli.js" } }, { "package.json": manifest("a"), "cli.js": "" }],
      "node_modules/a/node_modules/b": [{ version: "2.0.0" }, { "package.json": manifest("b", "2.0.0") }],
    });
    mkdirSync(join(install.project, "node_modules/.bin"));
    symlinkSync("../a/cli.js", join(install.project, "node_modules/.bin/a"));
    expect(install.closure().errors).toEqual([]);
    expect(install.differences()).toEqual([]);
  });

  it("reports every changed, missing, unexpected or hard-linked path", () => {
    const install = simulatedInstall({
      "node_modules/a": [{ version: "1.0.0" }, { "package.json": manifest("a"), "index.js": "1", "gone.js": "" }],
    });
    writeFileSync(join(install.project, "node_modules/a/index.js"), "2");
    rmSync(join(install.project, "node_modules/a/gone.js"));
    linkSync(join(install.project, "node_modules/a/package.json"), join(install.project, "node_modules/a/copy.json"));
    mkdirSync(join(install.project, "node_modules/a/dist/node_modules/@kynesyslabs/dacs"), { recursive: true });
    symlinkSync("index.js", join(install.project, "node_modules/a/main.js"));
    mkdirSync(join(install.project, "node_modules/.bin"));
    symlinkSync("../a/index.js", join(install.project, "node_modules/.bin/a"));
    expect(install.differences()).toEqual([
      "unexpected directory: node_modules/.bin", "unexpected link: node_modules/.bin/a",
      "unexpected file: node_modules/a/copy.json", "unexpected directory: node_modules/a/dist",
      "unexpected directory: node_modules/a/dist/node_modules", "unexpected directory: node_modules/a/dist/node_modules/@kynesyslabs",
      "unexpected directory: node_modules/a/dist/node_modules/@kynesyslabs/dacs", "missing: node_modules/a/gone.js",
      "changed: node_modules/a/index.js", "unexpected link: node_modules/a/main.js", "hard link: node_modules/a/package.json",
    ]);
  });

  it("refuses a .bin link to another target than the lock's bin map", () => {
    const install = simulatedInstall({
      "node_modules/a": [{ version: "1.0.0", bin: { a: "cli.js" } }, { "package.json": manifest("a"), "cli.js": "", "x.js": "" }],
    });
    mkdirSync(join(install.project, "node_modules/.bin"));
    symlinkSync("../a/x.js", join(install.project, "node_modules/.bin/a"));
    expect(install.differences()).toEqual(["link to an unexpected target: node_modules/.bin/a -> ../a/x.js"]);
  });

  it.each(["node_modules/a", "node_modules/parent/node_modules/a"])(
    "reports an interrupted installation missing its command link for %s", location => {
      const install = simulatedInstall({
        [location]: [{ version: "1.0.0", bin: { a: "cli.js" } }, { "package.json": manifest("a"), "cli.js": "" }],
      });
      const link = `${dirname(location)}/.bin/a`;
      mkdirSync(dirname(join(install.project, link)), { recursive: true });
      symlinkSync("../a/cli.js", join(install.project, link));
      expect(install.differences()).toEqual([]);
      rmSync(join(install.project, link));
      expect(install.differences()).toEqual(["missing: " + link]);
    });

  it.each(["node_modules/a", "node_modules/parent/node_modules/a"])(
    "compares npm-normalized CRLF command bytes at %s", location => {
      const install = simulatedInstall({ [location]: [{ version: "1.0.0", bin: { a: "./lib/../cli.js" } },
        { "package.json": manifest("a"), "cli.js": "#!/usr/bin/env node\r\nconsole.log('fixture');\r\n" }] });
      expect(install.closure().errors).toEqual([]);
      expect(install.differences()).toContain(`changed: ${location}/cli.js`);
    });

  it.each([false, true])("uses npm's skipped missing command target, bundled=%s", bundled => {
    const files = { "package.json": manifest("a") };
    const install = simulatedInstall(bundled ? {
      "node_modules/parent": [{}, { "package.json": manifest("parent"), "node_modules/a/package.json": manifest("a") }],
      "node_modules/parent/node_modules/a": [{ inBundle: true, bin: { a: "missing.js" } }, null],
    } : { "node_modules/a": [{ bin: { a: "missing.js" } }, files] });
    const location = bundled ? "node_modules/parent/node_modules/a" : "node_modules/a";
    const reference = install.closure();
    expect(reference.errors).toEqual([]);
    expect(reference.inventory.has(`${dirname(location)}/.bin/a`)).toBe(false);
  });

  it.each(["optional", "dev", "devOptional"])("allows empty ancestors of an omitted nested %s package only", flag => {
    const install = simulatedInstall({
      "node_modules/parent": [{}, { "package.json": manifest("parent") }],
      "node_modules/parent/node_modules/a": [{ [flag]: true }, null],
    });
    const modules = join(install.project, "node_modules/parent/node_modules");
    mkdirSync(modules, { recursive: true });
    expect(install.closure().errors).toEqual([]);
    expect(install.differences()).toEqual([]);
    writeFileSync(join(modules, "unexpected.js"), "");
    expect(install.differences()).toEqual(["unexpected file: node_modules/parent/node_modules/unexpected.js"]);
  });

  it("keeps LF command bytes and CRLF files that are not commands", () => {
    const install = simulatedInstall({ "node_modules/a": [{ bin: { a: "cli.js" } },
      { "package.json": manifest("a"), "cli.js": "#!/usr/bin/env node\n", "other.js": "#!/usr/bin/env node\r\n" }] });
    expect(install.closure().errors).toEqual([]);
  });

  it("compares normalized bytes of a bundled CRLF command", () => {
    const install = simulatedInstall({
      "node_modules/parent": [{}, { "package.json": manifest("parent"),
        "node_modules/a/package.json": manifest("a"), "node_modules/a/cli.js": "#!/usr/bin/env node\r\n" }],
      "node_modules/parent/node_modules/a": [{ inBundle: true, bin: { a: "cli.js" } }, null],
    });
    expect(install.closure().errors).toEqual([]);
    expect(install.differences()).toContain("changed: node_modules/parent/node_modules/a/cli.js");
  });

  it.each(["file", "directory"])("refuses an interrupted bundled command link replaced by an archive %s", kind => {
    const install = simulatedInstall({
      "node_modules/parent": [{}, { "package.json": manifest("parent"),
        "node_modules/child/package.json": manifest("child"), "node_modules/child/cli.js": "",
        [kind === "file" ? "node_modules/.bin/child" : "node_modules/.bin/child/packed.js"]: "packed command" }],
      "node_modules/parent/node_modules/child": [{ inBundle: true, bin: { child: "cli.js" } }, null],
    });
    const path = "node_modules/parent/node_modules/.bin/child";
    expect(install.closure().errors).toEqual([]);
    expect(install.differences()).toContain(`expected link, found ${kind}: ${path}`);
    rmSync(join(install.project, path), { recursive: true });
    symlinkSync("../child/cli.js", join(install.project, path));
    expect(install.differences()).toEqual([]);
  });

  it("lists a module an archive carries in node_modules of its own, which no lock entry names", () => {
    const install = simulatedInstall({
      "node_modules/@x/node_modules": [{ version: "1.0.0" }, { "package.json": manifest("@x/node_modules"),
        "@kynesyslabs/dacs/package.json": manifest("@kynesyslabs/dacs", "0.0.0-old") }],
      "node_modules/plugin": [{ version: "1.0.0" }, { "package.json": manifest("plugin"), "dist/node_modules/shadow.js": "",
        "dist/node_modules/@s/m/package.json": "{" }],
    });
    expect(install.differences()).toEqual([]);
    expect(Object.fromEntries(install.closure().carried)).toEqual({
      "node_modules/@x/node_modules/@kynesyslabs/dacs": { owner: "node_modules/@x/node_modules", name: "@kynesyslabs/dacs",
        manifest: { name: "@kynesyslabs/dacs", version: "0.0.0-old" } },
      "node_modules/@x/node_modules/package.json": { owner: "node_modules/@x/node_modules", name: "package.json", manifest: null },
      "node_modules/plugin/dist/node_modules/shadow.js": { owner: "node_modules/plugin", name: "shadow.js", manifest: null },
      "node_modules/plugin/dist/node_modules/@s/m": { owner: "node_modules/plugin", name: "@s/m", manifest: null, unreadable: true },
    });
  });

  it("takes a bundled entry from its bundling package's archive", () => {
    const install = simulatedInstall({
      "node_modules/bundler": [{ version: "1.0.0" }, { "package.json": manifest("bundler"),
        "node_modules/bundled/package.json": manifest("bundled") }],
      "node_modules/bundler/node_modules/bundled": [{ version: "1.0.0", inBundle: true }, null],
      "node_modules/bundler/node_modules/missing": [{ version: "1.0.0", inBundle: true }, null],
    });
    const closure = install.closure();
    expect(closure.entries.get("node_modules/bundler/node_modules/bundled"))
      .toMatchObject({ bundledBy: "node_modules/bundler", manifest: { name: "bundled" } });
    expect(closure.errors).toEqual(["cannot derive reference installation: bundled lock entry is not in the archive of the package bundling it: node_modules/bundler/node_modules/missing"]);
  });

  it.each(["optional", "dev", "devOptional"])("detects missing carried %s entries independently of the inspected tree", flag => {
    for (const name of ["child", "@scope/child"]) {
      const location = `node_modules/parent/node_modules/${name}`;
      const install = simulatedInstall({
        "node_modules/parent": [{}, { "package.json": manifest("parent"),
          [`node_modules/${name}/package.json`]: manifest(name), [`node_modules/${name}/index.js`]: "" }],
        [location]: [{ inBundle: true, [flag]: true }, null],
      });
      expect(install.closure().errors).toEqual([]);
      expect(install.differences()).toEqual([]);
      rmSync(join(install.project, location), { recursive: true });
      const closure = install.closure();
      expect(closure.entries.get(location)?.present).toBe(true);
      expect(closure.errors).toEqual([]);
      expect(installationDifferences(install.project, closure)).toContain(`missing: ${location}/package.json`);
    }
  });

  it("refuses a lock entry that another package's archive also writes", () => {
    const install = simulatedInstall({
      "node_modules/a": [{ version: "1.0.0" }, { "package.json": manifest("a"), "node_modules/b/package.json": manifest("b") }],
      "node_modules/a/node_modules/b": [{ version: "1.0.0" }, { "package.json": manifest("b") }],
    });
    expect(install.closure().errors).toEqual(["cannot derive reference installation: lock entry node_modules/a/node_modules/b is also in the archive of node_modules/a"]);
  });

  it.each([
    ["outside node_modules", "packages/a", {}],
    ["inside .bin", "node_modules/.bin/a", {}],
    ["below a package named node_modules", "node_modules/node_modules/a", {}],
    ["that is a link", "node_modules/a", { link: true, resolved: "packages/a" }],
  ])("refuses a lock entry %s", (_form, location, entry) => {
    const install = simulatedInstall({ [location]: [entry, null] });
    expect(install.closure().errors).toEqual(["cannot derive reference installation: cannot derive the installed files of lock entry " + location]);
  });

  it("refuses an archive the cache does not hold", () => {
    const install = simulatedInstall({ "node_modules/a": [{ version: "1.0.0", integrity: sri(Buffer.from("other")) }, null] });
    expect(install.closure().errors).toEqual([expect.stringContaining("cannot read npm's cached archive")]);
  });

  it.each(["optional", "dev", "devOptional"])("allows an omitted %s entry and compares it when installed", flag => {
    const install = simulatedInstall({ "node_modules/a": [{ version: "1.0.0", [flag]: true }, { "package.json": manifest("a") }] });
    expect(install.differences()).toEqual([]);
    rmSync(join(install.project, "node_modules/a"), { recursive: true });
    expect(install.closure().entries.get("node_modules/a")?.present).toBe(true);
    expect(install.differences()).toContain("missing: node_modules/a/package.json");
    writeFileSync(join(install.project, ".npmrc"), `omit=${flag === "dev" ? "dev" : "optional"}\n`);
    expect(install.closure().entries.get("node_modules/a")?.present).toBe(false);
    const toolchain = npmToolchain();
    runNpmNode(toolchain, [toolchain.cli, "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", `--cache=${join(install.project, ".npm")}`], { cwd: install.project });
    expect(install.differences()).toEqual([]);
    mkdirSync(join(install.project, "node_modules/a"));
    expect(install.differences()).toContain("unexpected directory: node_modules/a");
  });

  it("refuses unverified entries through plain, nested, linked and interrupted states", () => {
    const install = simulatedInstall({
      "node_modules/git-dependency": [{ version: "1.0.0", resolved: "git+ssh://git@example.com/a.git#0" }, null],
      "node_modules/git-dependency/node_modules/c": [{ version: "1.0.0" }, { "package.json": manifest("c") }],
    });
    mkdirSync(join(install.project, "node_modules/git-dependency/lib"), { recursive: true });
    writeFileSync(join(install.project, "node_modules/git-dependency/lib/index.js"), "");
    expect(install.closure().entries.get("node_modules/git-dependency")?.unverified).toBe(true);
    expect(install.differences()).toEqual(["reference installation did not complete"]);
    mkdirSync(join(install.project, "node_modules/git-dependency/lib/node_modules/@kynesyslabs/dacs"), { recursive: true });
    symlinkSync("index.js", join(install.project, "node_modules/git-dependency/lib/main.js"));
    expect(install.differences()).toEqual(["reference installation did not complete"]);
    rmSync(join(install.project, "node_modules/git-dependency"), { recursive: true });
    expect(install.differences()).toEqual(["reference installation did not complete"]);
  });
});

// Real npm installations of a fixture registry, compared with the closure the
// lock and npm's cache give: what npm writes is exactly what the closure lists.
describe("installation closure of real npm installations", () => {
  const archives = new Map<string, Buffer>([
    ["@kynesyslabs/dacs", packTarball({ "package.json": manifest("@kynesyslabs/dacs", "0.1.0-test"), "index.js": "module.exports = 'dacs';\n" })],
    ["fixture-plugin", gzipSync(tarArchive([
      { name: "package/package.json", body: manifest("fixture-plugin", "1.0.0", { main: "dist/index.cjs" }) },
      { name: "package/dist/", type: "5" },
      { name: "package/dist/index.cjs", body: "module.exports = require('@kynesyslabs/dacs');\n" },
      { name: "package/dist/node_modules/@kynesyslabs/dacs/package.json", body: manifest("@kynesyslabs/dacs", "0.0.0-old") },
      { name: "package/dist/node_modules/@kynesyslabs/dacs/index.js", body: "module.exports = 'old-copy';\n" },
      { name: "package/dist/latest.cjs", type: "2" },
      { name: "package/.gitignore", body: "dist\n" },
    ]))],
    ["with-bin", packTarball({ "package.json": manifest("with-bin", "1.0.0", { bin: { "with-bin": "cli.js" } }), "cli.js": "#!/usr/bin/env node\n" })],
    ["parent", packTarball({ "package.json": manifest("parent", "1.0.0", { dependencies: { child: "2.0.0" } }) })],
    ["optional-parent", packTarball({ "package.json": manifest("optional-parent", "1.0.0", { optionalDependencies: { "nested-skipped": "1.0.0" } }) })],
    ["nested-skipped", packTarball({ "package.json": manifest("nested-skipped", "1.0.0", { os: [`!${process.platform}`] }) })],
    ["child-1", packTarball({ "package.json": manifest("child", "1.0.0") })],
    ["child-2", packTarball({ "package.json": manifest("child", "2.0.0", { bin: { child: "bin.js" } }), "bin.js": "" })],
    ["@scope/pkg", gzipSync(tarArchive([{ name: "package/package.json", body: manifest("@scope/pkg"),
      pax: { size: String(Buffer.byteLength(manifest("@scope/pkg"))) } }]))],
    ["@skipped/optional", packTarball({ "package.json": manifest("@skipped/optional", "1.0.0", { os: [`!${process.platform}`] }) })],
    ["skipped-optional", packTarball({ "package.json": manifest("skipped-optional", "1.0.0", { os: [`!${process.platform}`] }) })],
    ["bundler", packTarball({ "package.json": manifest("bundler", "1.0.0", { dependencies: { bundled: "1.0.0" }, bundleDependencies: ["bundled"] }),
      "node_modules/bundled/package.json": manifest("bundled"), "node_modules/bundled/index.js": "" })],
  ]);
  const dependencies = { "@kynesyslabs/dacs": "0.1.0-test", "dacs-alias": "npm:@kynesyslabs/dacs@0.1.0-test",
    "fixture-plugin": "1.0.0", "with-bin": "1.0.0", parent: "1.0.0",
    child: "1.0.0", "optional-parent": "1.0.0", "@scope/pkg": "1.0.0", bundler: "1.0.0" };

  async function installFixture() {
    const directory = temporaryDirectory();
    const project = join(directory, "project");
    const cache = join(directory, "cache");
    mkdirSync(project);
    const server = await serveArchives(archives);
    try {
      const entry = (archive: string, version: string, fields: Record<string, unknown> = {}) => {
        const bytes = archives.get(archive);
        if (!bytes) throw new Error("no fixture archive " + archive);
        return { version, resolved: `${server.registry}/${encodeURIComponent(archive)}.tgz`, integrity: sri(bytes), ...fields };
      };
      const root = { name: "consumer", version: "1.0.0", dependencies,
        optionalDependencies: { "skipped-optional": "1.0.0", "@skipped/optional": "1.0.0" } };
      const lock = { name: "consumer", version: "1.0.0", lockfileVersion: 3, requires: true, packages: {
        "": root,
        "node_modules/@kynesyslabs/dacs": entry("@kynesyslabs/dacs", "0.1.0-test"),
        "node_modules/dacs-alias": entry("@kynesyslabs/dacs", "0.1.0-test", { name: "@kynesyslabs/dacs" }),
        "node_modules/fixture-plugin": entry("fixture-plugin", "1.0.0"),
        "node_modules/with-bin": entry("with-bin", "1.0.0", { bin: { "with-bin": "cli.js" } }),
        "node_modules/parent": entry("parent", "1.0.0", { dependencies: { child: "2.0.0" } }),
        "node_modules/parent/node_modules/child": entry("child-2", "2.0.0", { bin: { child: "bin.js" } }),
        "node_modules/optional-parent": entry("optional-parent", "1.0.0", { optionalDependencies: { "nested-skipped": "1.0.0" } }),
        "node_modules/optional-parent/node_modules/nested-skipped": entry("nested-skipped", "1.0.0", { optional: true, os: [`!${process.platform}`] }),
        "node_modules/child": entry("child-1", "1.0.0"),
        "node_modules/@scope/pkg": entry("@scope/pkg", "1.0.0"),
        "node_modules/skipped-optional": entry("skipped-optional", "1.0.0", { optional: true, os: [`!${process.platform}`] }),
        "node_modules/@skipped/optional": entry("@skipped/optional", "1.0.0", { optional: true, os: [`!${process.platform}`] }),
        "node_modules/bundler": entry("bundler", "1.0.0", { dependencies: { bundled: "1.0.0" }, bundleDependencies: ["bundled"] }),
        "node_modules/bundler/node_modules/bundled": { version: "1.0.0", inBundle: true },
      } };
      writeFileSync(join(project, "package.json"), JSON.stringify(root));
      writeFileSync(join(project, "package-lock.json"), JSON.stringify(lock));
      const install = await npmCi(project, server.registry, cache);
      expect(install.status, install.output).toBe(0);
      const reference = installationClosure(project, lock, (_location: string, locked: { integrity: string }) =>
        cachedArchive(cache, locked.integrity));
      return { project, closure: () => reference };
    } finally { await server.close(); }
  }

  it("lists exactly what npm ci --ignore-scripts installs, carried copies included", async () => {
    const { project, closure } = await installFixture();
    const derived = closure();
    expect(derived.errors).toEqual([]);
    expect(installationDifferences(project, derived)).toEqual([]);
    expect(derived.entries.get("node_modules/skipped-optional")?.present).toBe(false);
    expect(derived.entries.get("node_modules/@skipped/optional")?.present).toBe(false);
    expect([...derived.carried.keys()]).toEqual(["node_modules/fixture-plugin/dist/node_modules/@kynesyslabs/dacs"]);
  }, 60_000);

  it("refuses an archive with files after a zero block for interrupted and complete installations", async () => {
    const project = temporaryDirectory();
    const cache = join(project, ".npm");
    const packageJson = manifest("late-file", "1.0.0", { main: "late.js" });
    const archive = gzipSync(Buffer.concat([
      tarArchive([{ name: "package/package.json", body: packageJson }]).subarray(0, -512),
      tarArchive([{ name: "package/late.js", body: "module.exports = 42;\n" }]),
    ]));
    const server = await serveArchives(new Map([["late-file", archive]]));
    try {
      const root = { name: "consumer", version: "1.0.0", dependencies: { "late-file": "1.0.0" } };
      const lock = { lockfileVersion: 3, packages: { "": root, "node_modules/late-file": {
        version: "1.0.0", resolved: `${server.registry}/late-file.tgz`, integrity: sri(archive),
      } } };
      writeFileSync(join(project, "package.json"), JSON.stringify(root));
      writeFileSync(join(project, "package-lock.json"), JSON.stringify(lock));
      // The state left when extraction stops after the manifest, before late.js.
      mkdirSync(join(project, "node_modules/late-file"), { recursive: true });
      writeFileSync(join(project, "node_modules/late-file/package.json"), packageJson);
      cacheArchive(cache, archive);
      const closure = () => installationClosure(project, lock, (_location: string, entry: { integrity: string }) =>
        cachedArchive(cache, entry.integrity));
      const interrupted = closure();
      const installed = await npmCi(project, server.registry, cache);
      expect(installed.status, installed.output).toBe(0);
      expect(readFileSync(join(project, "node_modules/late-file/late.js"), "utf8")).toBe("module.exports = 42;\n");
      const error = "cannot derive reference installation: cannot extract archive node_modules/late-file: packed tarball has a malformed trailer";
      expect([interrupted.errors, closure().errors]).toEqual([[error], [error]]);
    } finally { await server.close(); }
  }, 60_000);

  it("refuses a directory body hiding a file for interrupted and complete installations", async () => {
    const project = temporaryDirectory();
    const cache = join(project, ".npm");
    const packageJson = manifest("directory-body", "1.0.0", { main: "hidden.js" });
    const hiddenFile = "module.exports = 42;\n";
    const archive = gzipSync(Buffer.concat([
      tarArchive([{ name: "package/package.json", body: packageJson },
        { name: "package/lib/", type: "5", size: "00000002000" }]).subarray(0, -1024),
      tarArchive([{ name: "package/hidden.js", body: hiddenFile }]),
    ]));
    const server = await serveArchives(new Map([["directory-body", archive]]));
    try {
      const root = { name: "consumer", version: "1.0.0", dependencies: { "directory-body": "1.0.0" } };
      const lock = { lockfileVersion: 3, packages: { "": root, "node_modules/directory-body": {
        version: "1.0.0", resolved: `${server.registry}/directory-body.tgz`, integrity: sri(archive),
      } } };
      writeFileSync(join(project, "package.json"), JSON.stringify(root));
      writeFileSync(join(project, "package-lock.json"), JSON.stringify(lock));
      // Extraction interrupted after package.json has not installed the declared main file.
      mkdirSync(join(project, "node_modules/directory-body"), { recursive: true });
      writeFileSync(join(project, "node_modules/directory-body/package.json"), packageJson);
      cacheArchive(cache, archive);
      const closure = () => installationClosure(project, lock, (_location: string, entry: { integrity: string }) =>
        cachedArchive(cache, entry.integrity));
      const interrupted = closure();
      const installed = await npmCi(project, server.registry, cache);
      expect(installed.status, installed.output).toBe(0);
      expect(readFileSync(join(project, "node_modules/directory-body/hidden.js"), "utf8")).toBe(hiddenFile);
      const error = "cannot derive reference installation: cannot extract archive node_modules/directory-body: packed tarball directory has a nonzero size";
      expect([interrupted.errors, closure().errors]).toEqual([[error], [error]]);
    } finally { await server.close(); }
  }, 60_000);

  it("allows an omitted scope directory but refuses files within it", async () => {
    const { project, closure } = await installFixture();
    expect(installationDifferences(project, closure())).toEqual([]);
    writeFileSync(join(project, "node_modules/@skipped/extra.js"), "outside the archives");
    expect(installationDifferences(project, closure())).toEqual(["unexpected file: node_modules/@skipped/extra.js"]);
  }, 60_000);

  it("allows empty nested node_modules left by npm for an omitted optional dependency", async () => {
    const { project, closure } = await installFixture();
    const derived = closure();
    expect(derived.entries.get("node_modules/optional-parent/node_modules/nested-skipped")?.present).toBe(false);
    expect(installationDifferences(project, derived)).toEqual([]);
  }, 60_000);

  it("matches a missing bin target that npm successfully skips", async () => {
    const project = temporaryDirectory();
    const cache = join(project, ".npm");
    const archive = packTarball({ "package.json": manifest("missing-bin", "1.0.0", { bin: { fixture: "missing.js" } }) });
    const server = await serveArchives(new Map([["missing-bin", archive]]));
    try {
      const root = { name: "consumer", version: "1.0.0", dependencies: { "missing-bin": "1.0.0" } };
      const lock = { lockfileVersion: 3, packages: { "": root, "node_modules/missing-bin": {
        version: "1.0.0", resolved: `${server.registry}/missing-bin.tgz`, integrity: sri(archive), bin: { fixture: "missing.js" },
      } } };
      writeFileSync(join(project, "package.json"), JSON.stringify(root));
      writeFileSync(join(project, "package-lock.json"), JSON.stringify(lock));
      const installed = await npmCi(project, server.registry, cache);
      expect(installed.status, installed.output).toBe(0);
      expect(() => readFileSync(join(project, "node_modules/.bin/fixture"))).toThrow();
      const closure = installationClosure(project, lock, (_location: string, entry: { integrity: string }) => cachedArchive(cache, entry.integrity));
      expect(closure.errors).toEqual([]);
      expect(installationDifferences(project, closure)).toEqual([]);
    } finally { await server.close(); }
  }, 60_000);

  it("explicitly refuses a real npm installation expanded from a package shrinkwrap", async () => {
    const project = temporaryDirectory();
    const cache = join(project, ".npm");
    const child = packTarball({ "package.json": manifest("child") });
    const fixtureArchives = new Map([["child", child]]);
    const server = await serveArchives(fixtureArchives);
    try {
      const childEntry = { version: "1.0.0", resolved: `${server.registry}/child.tgz`, integrity: sri(child) };
      const parent = packTarball({ "package.json": manifest("parent", "1.0.0", { dependencies: { child: "1.0.0" } }),
        "npm-shrinkwrap.json": JSON.stringify({ lockfileVersion: 3, packages: {
          "": { dependencies: { child: "1.0.0" } }, "node_modules/child": childEntry,
        } }) });
      fixtureArchives.set("parent", parent);
      const root = { name: "consumer", version: "1.0.0", dependencies: { parent: "1.0.0" } };
      const lock = { lockfileVersion: 3, packages: { "": root, "node_modules/parent": {
        version: "1.0.0", resolved: `${server.registry}/parent.tgz`, integrity: sri(parent), hasShrinkwrap: true,
      } } };
      writeFileSync(join(project, "package.json"), JSON.stringify(root));
      writeFileSync(join(project, "package-lock.json"), JSON.stringify(lock));
      const installed = await npmCi(project, server.registry, cache);
      expect(installed.status, installed.output).toBe(0);
      expect(JSON.parse(readFileSync(join(project, "node_modules/parent/node_modules/child/package.json"), "utf8")).name).toBe("child");
      const closure = installationClosure(project, lock, (_location: string, entry: { integrity: string }) => cachedArchive(cache, entry.integrity));
      expect(closure.errors.join()).toContain("package has an npm-shrinkwrap.json");
    } finally { await server.close(); }
  }, 60_000);

  it.each([false, true])("derives installed and omitted optional bundles from npm, omit=%s", async omit => {
    const project = temporaryDirectory();
    const cache = join(project, ".npm");
    const bundled = { optionalDependencies: { child: "1.0.0" }, bundleDependencies: ["child"] };
    const archive = packTarball({ "package.json": manifest("parent", "1.0.0", bundled),
      "node_modules/child/package.json": manifest("child"), "node_modules/child/index.js": "module.exports = 'child';\n" });
    const server = await serveArchives(new Map([["parent", archive]]));
    try {
      const root = { name: "consumer", version: "1.0.0", dependencies: { parent: "1.0.0" } };
      const location = "node_modules/parent/node_modules/child";
      const lock = { lockfileVersion: 3, packages: { "": root, "node_modules/parent": {
        version: "1.0.0", resolved: `${server.registry}/parent.tgz`, integrity: sri(archive), ...bundled,
      }, [location]: { version: "1.0.0", inBundle: true, optional: true } } };
      writeFileSync(join(project, "package.json"), JSON.stringify(root));
      writeFileSync(join(project, "package-lock.json"), JSON.stringify(lock));
      writeFileSync(join(project, ".npmrc"), `omit=${omit ? "optional" : ""}\n`);
      const installed = await npmCi(project, server.registry, cache);
      expect(installed.status, installed.output).toBe(0);
      const closure = installationClosure(project, lock, (_location: string, entry: { integrity: string }) => cachedArchive(cache, entry.integrity));
      expect(closure.entries.get(location)?.present).toBe(!omit);
      if (omit) {
        expect(() => readFileSync(join(project, location, "package.json"))).toThrow();
        expect(closure.errors).toEqual([]);
        expect(installationDifferences(project, closure)).toEqual([]);
      } else {
        expect(closure.errors).toEqual([]);
        expect(installationDifferences(project, closure)).toEqual([]);
      }
    } finally { await server.close(); }
  }, 60_000);

  it.each([
    ["dev", "devDependencies", { dev: true }, "omit=dev\n"],
    ["optional", "optionalDependencies", { optional: true }, "omit=optional\n"],
    ["peer", "peerDependencies", { peer: true }, "omit=peer\n"],
    ["devOptional", "optionalDependencies", { devOptional: true }, "omit[]=dev\nomit[]=optional\n"],
    ["os", "optionalDependencies", { optional: true, os: [`!${process.platform}`] }, ""],
    ["cpu", "optionalDependencies", { optional: true, cpu: [`!${process.arch}`] }, ""],
    ["libc", "optionalDependencies", { optional: true, libc: ["unsupported-fixture-libc"] }, ""],
    ["engine", "optionalDependencies", { optional: true, engines: { node: "<0.0.0" } }, ""],
  ] as const)("accepts unavailable excluded %s bundlers and nested scoped bundles", async (_case, field, flags, config) => {
    const project = temporaryDirectory();
    const cache = join(project, ".npm");
    const bundled = { dependencies: { "@scope/child": "1.0.0" }, bundleDependencies: ["@scope/child"] };
    const archive = packTarball({ "package.json": manifest("parent", "1.0.0", bundled),
      "node_modules/@scope/child/package.json": manifest("@scope/child", "1.0.0", {
        dependencies: { grandchild: "1.0.0" }, bundleDependencies: ["grandchild"],
      }), "node_modules/@scope/child/node_modules/grandchild/package.json": manifest("grandchild") });
    const server = await serveArchives(new Map([["parent", archive]]));
    try {
      const root = { name: "consumer", version: "1.0.0", [field]: { parent: "1.0.0" },
        ...(_case === "devOptional" ? { devDependencies: { parent: "1.0.0" } } : {}) };
      const owner = "node_modules/parent";
      const child = `${owner}/node_modules/@scope/child`;
      const grandchild = `${child}/node_modules/grandchild`;
      const lock = { lockfileVersion: 3, packages: { "": root, [owner]: {
        version: "1.0.0", resolved: `${server.registry}/parent.tgz`, integrity: sri(archive), ...bundled, ...flags,
      }, [child]: { version: "1.0.0", inBundle: true, ...flags },
      [grandchild]: { version: "1.0.0", inBundle: true, ...flags } } };
      writeFileSync(join(project, "package.json"), JSON.stringify(root));
      writeFileSync(join(project, "package-lock.json"), JSON.stringify(lock));
      writeFileSync(join(project, ".npmrc"), config);
      const installed = await npmCi(project, server.registry, cache);
      expect(installed.status, installed.output).toBe(0);
      const reference = installationClosure(project, lock, () => { throw new Error("archive was not acquired"); });
      expect(reference.errors).toEqual([]);
      for (const location of [owner, child, grandchild]) {
        expect(reference.entries.get(location)?.present).toBe(false);
        expect(reference.inventory.has(location)).toBe(false);
      }
      expect(installationDifferences(project, reference)).toEqual([]);
    } finally { await server.close(); }
  }, 60_000);

  it("finds a file added below an installed package after installation", async () => {
    const { project, closure } = await installFixture();
    writeFileSync(join(project, "node_modules/fixture-plugin/dist/node_modules/@kynesyslabs/dacs/extra.js"), "");
    expect(installationDifferences(project, closure()))
      .toEqual(["unexpected file: node_modules/fixture-plugin/dist/node_modules/@kynesyslabs/dacs/extra.js"]);
  }, 60_000);

  it("reports removed top-level and nested command links after a successful npm installation", async () => {
    const { project, closure } = await installFixture();
    const links = ["node_modules/.bin/with-bin", "node_modules/parent/node_modules/.bin/child"];
    expect(installationDifferences(project, closure())).toEqual([]);
    for (const link of links) rmSync(join(project, link));
    expect(installationDifferences(project, closure())).toEqual(links.map(link => "missing: " + link));
  }, 60_000);

  it("refuses the original bytes of a CRLF command that npm successfully normalizes", async () => {
    const directory = temporaryDirectory();
    const cache = join(directory, "cache");
    const files = { "package.json": manifest("crlf-bin", "1.0.0", { bin: { crlf: "cli.js" } }),
      "cli.js": "#!/usr/bin/env node\r\nconsole.log('fixture');\r\n" };
    const archive = packTarball(files);
    const server = await serveArchives(new Map([["crlf-bin", archive]]));
    try {
      const root = { name: "consumer", version: "1.0.0", dependencies: { "crlf-bin": "1.0.0" } };
      const lock = { lockfileVersion: 3, packages: { "": root, "node_modules/crlf-bin": {
        version: "1.0.0", resolved: `${server.registry}/crlf-bin.tgz`, integrity: sri(archive), bin: { crlf: "cli.js" },
      } } };
      writeFileSync(join(directory, "package.json"), JSON.stringify(root));
      writeFileSync(join(directory, "package-lock.json"), JSON.stringify(lock));
      const installed = await npmCi(directory, server.registry, cache);
      expect(installed.status, installed.output).toBe(0);
      expect(readFileSync(join(directory, "node_modules/crlf-bin/cli.js"), "utf8"))
        .toBe("#!/usr/bin/env node\nconsole.log('fixture');\r\n");
      const closure = installationClosure(directory, lock, (_location: string, entry: { integrity: string }) => cachedArchive(cache, entry.integrity));
      expect(closure.errors).toEqual([]);
      expect(installationDifferences(directory, closure)).toEqual([]);
      writeFileSync(join(directory, "node_modules/crlf-bin/cli.js"), files["cli.js"]);
      expect(installationDifferences(directory, closure)).toContain("changed: node_modules/crlf-bin/cli.js");
    } finally { await server.close(); }
  }, 60_000);
});


describe("reference contract and complete inventory", { timeout: 60_000 }, () => {
  it.each([["file", "directory"], ["file", "link"], ["directory", "file"], ["directory", "link"],
    ["link", "file"], ["link", "directory"]])("refuses %s replaced by %s, including D-1 directory precedence", (expected, observed) => {
    const project = temporaryDirectory();
    const path = join(project, "node_modules/pkg/a");
    mkdirSync(dirname(path), { recursive: true });
    const create = (type: string) => {
      if (type === "directory") mkdirSync(path);
      else if (type === "link") symlinkSync("target.js", path);
      else writeFileSync(path, "file");
    };
    create(expected);
    const reference = { errors: [], inventory: installationInventory(project) };
    rmSync(path, { recursive: true });
    create(observed);
    expect(installationDifferences(project, reference)).toContain(`expected ${expected}, found ${observed}: node_modules/pkg/a`);
  });

  it("requires the generated hidden lockfile to finish an installation", () => {
    const fixture = simulatedInstall({ "node_modules/a": [{}, { "package.json": manifest("a") }] });
    const reference = fixture.closure();
    expect(reference.errors).toEqual([]);
    expect(installationDifferences(fixture.project, reference)).toEqual([]);
    rmSync(join(fixture.project, "node_modules/.package-lock.json"));
    expect(installationDifferences(fixture.project, reference)).toContain("missing: node_modules/.package-lock.json");
  });

  it("publishes no reference after bad callback bytes or an offline replay failure", () => {
    const fixture = simulatedInstall({ "node_modules/a": [{}, { "package.json": manifest("a") }] });
    const installer = npmInstallContract(fixture.project);
    const input = { manifest: JSON.parse(readFileSync(join(fixture.project, "package.json"), "utf8")), lock: fixture.lock, installer };
    const wrong = referenceInstallation({ ...input, readArchive: () => packTarball({ "package.json": manifest("other") }) });
    expect(wrong.inventory).toBeNull();
    expect(wrong.errors.join()).toContain("does not match its integrity");
    const absent = referenceInstallation({ ...input, readArchive: () => { throw new Error("source absent"); } });
    expect(absent.inventory).toBeNull();
    expect(absent.errors.join()).toContain("npm subprocess failed");
    expect(installationDifferences(fixture.project, absent)).toEqual(["reference installation did not complete"]);
    expect(fixture.closure().errors).toEqual([]);
  });

  it("requires the explicit platform and configuration contract", () => {
    const fixture = simulatedInstall({ "node_modules/a": [{}, { "package.json": manifest("a") }] });
    const installer = npmInstallContract(fixture.project);
    const reference = referenceInstallation({ manifest: {}, lock: fixture.lock, readArchive: () => Buffer.alloc(0),
      installer: { ...installer, toolchain: { ...installer.toolchain, platform: "another-platform" } } });
    expect(reference.inventory).toBeNull();
    expect(reference.errors.join()).toContain("explicit matching npm/platform/configuration contract");
  });

  it.each(["", "omit[]=optional\ninclude[]=optional\n"])("refuses an eligible optional source read failure with config %j", config => {
    const fixture = simulatedInstall({ "node_modules/a": [{ optional: true, os: [process.platform], cpu: [process.arch] },
      { "package.json": manifest("a") }] });
    writeFileSync(join(fixture.project, ".npmrc"), config);
    const input = { manifest: JSON.parse(readFileSync(join(fixture.project, "package.json"), "utf8")),
      lock: fixture.lock, installer: npmInstallContract(fixture.project) };
    const complete = referenceInstallation({ ...input,
      readArchive: (_location: string, entry: { integrity: string }) => cachedArchive(join(fixture.project, ".npm"), entry.integrity) });
    expect(complete.errors).toEqual([]);
    expect(installationDifferences(fixture.project, complete)).toEqual([]);
    const unavailable = referenceInstallation({ ...input, readArchive: () => { throw new Error("source temporarily absent"); } });
    expect(unavailable.inventory).toBeNull();
    expect(unavailable.errors.join()).toContain("node_modules/a: source temporarily absent");
    rmSync(join(fixture.project, "node_modules/a"), { recursive: true });
    expect(installationDifferences(fixture.project, unavailable)).toEqual(["reference installation did not complete"]);
  });

  it.each([{ os: [`!${process.platform}`] }, { cpu: [`!${process.arch}`] },
    { libc: ["unsupported-fixture-libc"] }, { engines: { node: "<0.0.0" } }])(
    "allows an unavailable optional source excluded by npm's environment checks: %j", constraints => {
      const fixture = simulatedInstall({ "node_modules/a": [{ optional: true, ...constraints }, null] });
      writeFileSync(join(fixture.project, ".npmrc"), "");
      const reference = referenceInstallation({ manifest: JSON.parse(readFileSync(join(fixture.project, "package.json"), "utf8")),
        lock: fixture.lock, installer: npmInstallContract(fixture.project), readArchive: () => { throw new Error("not acquired"); } });
      expect(reference.errors).toEqual([]);
      expect(reference.entries.get("node_modules/a").present).toBe(false);
      expect(reference.inventory).toBeInstanceOf(Map);
    });

  it("matches npm when an omitted optional owner shares a command and another command starts with a dot", () => {
    const fixture = simulatedInstall({
      "node_modules/a": [{ bin: { shared: "cli.js", ".hidden": "cli.js" } }, { "package.json": manifest("a"), "cli.js": "" }],
      "node_modules/b": [{ optional: true, bin: { shared: "cli.js" } }, null],
    });
    const toolchain = npmToolchain();
    runNpmNode(toolchain, [toolchain.cli, "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
      `--cache=${join(fixture.project, ".npm")}`], { cwd: fixture.project });
    const reference = fixture.closure();
    expect(reference.errors).toEqual([]);
    expect(reference.entries.get("node_modules/a").present).toBe(true);
    expect(reference.entries.get("node_modules/b").present).toBe(false);
    expect(reference.inventory.get("node_modules/.bin/.hidden").kind).toBe("link");
    expect(reference.inventory.has("node_modules/.bin/shared")).toBe(false);
    expect(installationDifferences(fixture.project, reference)).toEqual([]);
  });

  it("uses the consumer's bin-links configuration instead of synthesizing executable links", () => {
    const fixture = simulatedInstall({ "node_modules/a": [{ bin: { a: "cli.js" } }, { "package.json": manifest("a"), "cli.js": "" }] });
    writeFileSync(join(fixture.project, ".npmrc"), "bin-links=false\n");
    const toolchain = npmToolchain();
    runNpmNode(toolchain, [toolchain.cli, "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", `--cache=${join(fixture.project, ".npm")}`], { cwd: fixture.project });
    const reference = fixture.closure();
    expect(reference.errors).toEqual([]);
    expect(reference.inventory.has("node_modules/.bin/a")).toBe(false);
    expect(installationDifferences(fixture.project, reference)).toEqual([]);
  });

  it("never runs package scripts while preparing a reference", () => {
    const marker = join(temporaryDirectory(), "script-ran");
    const fixture = simulatedInstall({ "node_modules/a": [{}, { "package.json": manifest("a", "1.0.0", {
      scripts: { install: `node -e 'require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")'` },
    }) }] });
    expect(fixture.closure().errors).toEqual([]);
    expect(() => readFileSync(marker)).toThrow();
  });

  it("isolates two simultaneous runs and repeats without saved success", async () => {
    const fixture = simulatedInstall({ "node_modules/a": [{}, { "package.json": manifest("a") }] });
    const module = pathToFileURL(resolve("scripts/reference-installation.mjs")).href;
    const archives = pathToFileURL(resolve("scripts/installation-closure.mjs")).href;
    const program = `import { referenceInstallation, npmInstallContract } from ${JSON.stringify(module)};
      import { cachedArchive } from ${JSON.stringify(archives)};
      import { readFileSync } from 'node:fs';
      const project = process.argv[1];
      const reference = referenceInstallation({manifest: JSON.parse(readFileSync(project + '/package.json')),
        lock: JSON.parse(readFileSync(project + '/package-lock.json')), installer: npmInstallContract(project),
        readArchive: (_location, entry) => cachedArchive(project + '/.npm', entry.integrity)});
      if (reference.errors.length) throw Error(reference.errors.join('\\n'));
      console.log(JSON.stringify([...reference.inventory]));`;
    const run = () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", program, fixture.project]);
      let output = "";
      let errors = "";
      child.stdout.on("data", bytes => { output += bytes; });
      child.stderr.on("data", bytes => { errors += bytes; });
      child.on("error", reject);
      child.on("close", code => code === 0 ? resolve(output) : reject(new Error(errors)));
    });
    const [one, two] = await Promise.all([run(), run()]);
    expect(one).toBe(two);
    rmSync(join(fixture.project, "node_modules/a/package.json"));
    expect(fixture.closure().entries.get("node_modules/a").present).toBe(true);
    expect(fixture.differences()).toContain("missing: node_modules/a/package.json");
  });
});


it("round-trips effective omit/include, peer and octal umask settings through npm", () => {
  const fixture = simulatedInstall({ "node_modules/a": [{}, { "package.json": manifest("a"), "index.js": "content" }] });
  writeFileSync(join(fixture.project, ".npmrc"), "umask=027\nomit[]=dev\ninclude[]=optional\nlegacy-peer-deps=true\n");
  const toolchain = npmToolchain();
  runNpmNode(toolchain, [toolchain.cli, "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", `--cache=${join(fixture.project, ".npm")}`], { cwd: fixture.project });
  const reference = fixture.closure();
  expect(reference.errors).toEqual([]);
  expect(installationDifferences(fixture.project, reference)).toEqual([]);
}, 60_000);

import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { cacheArchive, npmCi, packTarball, serveArchives, sri, tarArchive, type TarEntry } from "./npm-archive-fixtures.js";

// Keep the closure executable as plain Node ESM.
const closureModulePath = "../../scripts/installation-closure.mjs";
const { cachedArchive, installationClosure, installationDifferences, packedFiles } = await import(closureModulePath);

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

describe("packed archive files", () => {
  it("installs file entries below the first path component and skips directories and links, as npm does", () => {
    const archive = gzipSync(tarArchive([
      { name: "package/", type: "5" },
      { name: "package/package.json", body: manifest("a") },
      { name: "package/lib/", type: "5" },
      { name: "package/lib/index.js", body: "module.exports = 1;\n" },
      { name: "package/link.js", type: "2" },
      { name: "package/.gitignore", body: "dist\n" },
      { name: "package/docs/.gitignore", body: "draft\n" },
      { name: "package/docs/.npmignore", body: "notes\n" },
    ]));
    expect(text(packedFiles(archive))).toEqual({ "package.json": manifest("a"), "lib/index.js": "module.exports = 1;\n",
      ".npmignore": "dist\n", "docs/.npmignore": "notes\n" });
  });

  it.each([
    ["a pax path record", [{ name: "package/short", body: "long", pax: { path: `package/${"d/".repeat(60)}file.js` } }]],
    ["a GNU long-name entry", [{ name: "././@LongLink", type: "L", body: `package/${"d/".repeat(60)}file.js\0` },
      { name: "package/short", body: "long" }]],
  ])("takes a long name from %s", (_form, entries: TarEntry[]) => {
    const files = packedFiles(gzipSync(tarArchive([{ name: "package/package.json", body: manifest("a") }, ...entries])));
    expect(files.get(`${"d/".repeat(60)}file.js`)?.toString()).toBe("long");
  });

  const valid: TarEntry = { name: "package/package.json", body: manifest("a") };
  const complete = tarArchive([valid]);
  it.each([1, 2, 4])("accepts an archive ending in %i zero tar blocks", blocks => {
    const tar = Buffer.concat([complete.subarray(0, -1024), Buffer.alloc(blocks * 512)]);
    expect(text(packedFiles(gzipSync(tar)))).toEqual({ "package.json": valid.body });
  });
  it.each([1, 2, 4])("refuses file entries after %i zero tar blocks", blocks => {
    const tar = Buffer.concat([complete.subarray(0, -1024), Buffer.alloc(blocks * 512),
      tarArchive([{ name: "package/late.js", body: "module.exports = 42;\n" }])]);
    expect(() => packedFiles(gzipSync(tar))).toThrow("packed tarball has a malformed trailer");
  });
  it("refuses nonzero trailing bytes after the archive terminator", () => {
    expect(() => packedFiles(gzipSync(Buffer.concat([complete, Buffer.from([1])]))))
      .toThrow("packed tarball has a malformed trailer");
  });
  it("accepts a PAX size equal to the file header size", () => {
    const archive = gzipSync(tarArchive([{ ...valid, pax: { size: String(Buffer.byteLength(valid.body ?? "")) } }]));
    expect(text(packedFiles(archive))).toEqual({ "package.json": valid.body });
  });
  it.each([
    ["entry data cut short", complete.subarray(0, 520), "truncated packed tarball entry"],
    ["entry padding cut short", complete.subarray(0, 600), "truncated packed tarball entry"],
    ["a size field that is not octal", tarArchive([{ ...valid, size: "0000000009x" }]), "malformed size"],
    ["no end-of-archive block", complete.subarray(0, 1024), "no end-of-archive block"],
    ["a header with a bad checksum", Buffer.concat([complete.subarray(0, 148), Buffer.from("0000000\0"), complete.subarray(156)]),
      "bad checksum"],
    ["a global pax header", tarArchive([valid, { name: "pax_global_header", type: "g", body: "" }]), "unsupported entry type g"],
    ["a parent-directory path", tarArchive([valid, { name: "package/../escape.js" }]), "escapes the package"],
    ["an empty path segment", tarArchive([valid, { name: "package//double.js" }]), "escapes the package"],
    ["an absolute path", tarArchive([valid, { name: "/package/absolute.js" }]), "escapes the package"],
    ["a duplicate path", tarArchive([valid, valid]), "duplicate packed tarball entry"],
    ["a differing pax size record", tarArchive([valid, { name: "package/sized.js", pax: { size: "1" } }]), "pax size differs from the entry header"],
    ["a malformed pax size record", tarArchive([valid, { name: "package/sized.js", pax: { size: "1x" } }]), "malformed pax size"],
    ["no package.json", tarArchive([{ name: "package/index.js" }]), "no package.json"],
  ])("refuses an archive with %s", (_form, tar, message) => {
    expect(() => packedFiles(gzipSync(tar))).toThrow(message);
  });
});

describe("cached package archives", () => {
  const archive = packTarball({ "package.json": manifest("a") });
  it("reads an archive from npm's cache by its sha512 integrity", () => {
    const cache = temporaryDirectory();
    cacheArchive(cache, archive);
    expect(cachedArchive(cache, sri(archive)).equals(archive)).toBe(true);
  });
  it("refuses a missing archive, keeping the cause", () => {
    expect(() => cachedArchive(temporaryDirectory(), sri(archive))).toThrow(/cannot read npm's cached archive .*\(ENOENT\)/);
  });
  it("refuses cached bytes with another digest", () => {
    const cache = temporaryDirectory();
    writeFileSync(cacheArchive(cache, archive), packTarball({ "package.json": manifest("b") }));
    expect(() => cachedArchive(cache, sri(archive))).toThrow("does not match its integrity");
  });
  it.each(["sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=", `${sri(archive)} ${sri(Buffer.from("other"))}`, undefined])(
    "refuses an integrity without exactly one sha512 digest: %s", integrity => {
      expect(() => cachedArchive(temporaryDirectory(), integrity)).toThrow("no single sha512 digest");
    });
});

// A project whose lock names `packages` ({ location: [lock entry, files] }),
// each archive cached and its files written where npm installs them.
function simulatedInstall(packages: Record<string, [Record<string, unknown>, Record<string, string> | null]>) {
  const project = temporaryDirectory();
  const cache = join(project, ".npm");
  const lock: { packages: Record<string, unknown> } = { packages: { "": {} } };
  for (const [location, [entry, files]] of Object.entries(packages)) {
    const archive = files ? packTarball(files) : null;
    if (archive) cacheArchive(cache, archive);
    lock.packages[location] = { ...(archive ? { integrity: sri(archive) } : {}), ...entry };
    for (const [path, body] of Object.entries(files ?? {})) {
      mkdirSync(dirname(join(project, location, path)), { recursive: true });
      writeFileSync(join(project, location, path), body);
    }
  }
  const closure = () => installationClosure(project, lock, (_location: string, entry: { integrity: string }) =>
    cachedArchive(cache, entry.integrity));
  return { project, lock, closure, differences: () => installationDifferences(project, closure()) };
}

describe("installation closure", () => {
  it("accepts an installed tree that is exactly the locked archives", () => {
    const install = simulatedInstall({
      "node_modules/a": [{ version: "1.0.0", bin: { a: "cli.js" } }, { "package.json": manifest("a"), "cli.js": "" }],
      "node_modules/a/node_modules/b": [{ version: "2.0.0" }, { "package.json": manifest("b", "2.0.0") }],
    });
    mkdirSync(join(install.project, "node_modules/.bin"));
    symlinkSync("../a/cli.js", join(install.project, "node_modules/.bin/a"));
    writeFileSync(join(install.project, "node_modules/.package-lock.json"), "{}");
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
    expect(install.differences()).toEqual(["unexpected directory: node_modules/.bin", "unexpected file: node_modules/a/copy.json",
      "unexpected directory: node_modules/a/dist", "changed: node_modules/a/index.js", "unexpected link: node_modules/a/main.js",
      "hard link: node_modules/a/package.json", "missing: node_modules/a/gone.js"]);
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
    "refuses a CRLF shebang command npm rewrites at %s", location => {
      const install = simulatedInstall({ [location]: [{ version: "1.0.0", bin: { a: "./lib/../cli.js" } },
        { "package.json": manifest("a"), "cli.js": "#!/usr/bin/env node\r\nconsole.log('fixture');\r\n" }] });
      expect(install.closure().errors).toEqual([
        `cannot derive the installed files of ${location}: npm rewrites the CRLF shebang of bin target: cli.js`,
      ]);
    });

  it.each([false, true])("refuses a missing command target, bundled=%s", bundled => {
    const files = { "package.json": manifest("a") };
    const install = simulatedInstall(bundled ? {
      "node_modules/parent": [{}, { "package.json": manifest("parent"), "node_modules/a/package.json": manifest("a") }],
      "node_modules/parent/node_modules/a": [{ inBundle: true, bin: { a: "missing.js" } }, null],
    } : { "node_modules/a": [{ bin: { a: "missing.js" } }, files] });
    const location = bundled ? "node_modules/parent/node_modules/a" : "node_modules/a";
    expect(install.closure().errors).toEqual([
      `cannot derive the installed files of ${location}: bin target is not an archive file: missing.js`,
    ]);
  });

  it.each(["optional", "dev", "devOptional"])("allows empty ancestors of an omitted nested %s package only", flag => {
    const install = simulatedInstall({
      "node_modules/parent": [{}, { "package.json": manifest("parent") }],
      "node_modules/parent/node_modules/a": [{ [flag]: true }, null],
    });
    const modules = join(install.project, "node_modules/parent/node_modules");
    mkdirSync(modules);
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

  it("refuses a bundled command whose CRLF shebang npm rewrites", () => {
    const install = simulatedInstall({
      "node_modules/parent": [{}, { "package.json": manifest("parent"),
        "node_modules/a/package.json": manifest("a"), "node_modules/a/cli.js": "#!/usr/bin/env node\r\n" }],
      "node_modules/parent/node_modules/a": [{ inBundle: true, bin: { a: "cli.js" } }, null],
    });
    expect(install.closure().errors).toEqual([
      "cannot derive the installed files of node_modules/parent/node_modules/a: npm rewrites the CRLF shebang of bin target: cli.js",
    ]);
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
    expect(install.differences()).toContain("expected executable link: " + path);
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
    expect(closure.errors).toEqual(["bundled lock entry is not in the archive of the package bundling it: node_modules/bundler/node_modules/missing"]);
  });

  it.each(["optional", "dev", "devOptional"])("refuses omitted %s entries still carried by an installed archive", flag => {
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
      expect(closure.entries.get(location)?.present).toBe(false);
      expect(closure.errors).toEqual([
        `cannot derive the installed files of ${location}: omitted entry is in the archive of node_modules/parent`,
      ]);
    }
  });

  it("refuses a lock entry that another package's archive also writes", () => {
    const install = simulatedInstall({
      "node_modules/a": [{ version: "1.0.0" }, { "package.json": manifest("a"), "node_modules/b/package.json": manifest("b") }],
      "node_modules/a/node_modules/b": [{ version: "1.0.0" }, { "package.json": manifest("b") }],
    });
    expect(install.closure().errors).toEqual(["lock entry node_modules/a/node_modules/b is also in the archive of node_modules/a"]);
  });

  it.each([
    ["outside node_modules", "packages/a", {}],
    ["inside .bin", "node_modules/.bin/a", {}],
    ["below a package named node_modules", "node_modules/node_modules/a", {}],
    ["that is a link", "node_modules/a", { link: true, resolved: "packages/a" }],
  ])("refuses a lock entry %s", (_form, location, entry) => {
    const install = simulatedInstall({ [location]: [entry, null] });
    expect(install.closure().errors).toEqual(["cannot derive the installed files of lock entry " + location]);
  });

  it("refuses an archive the cache does not hold", () => {
    const install = simulatedInstall({ "node_modules/a": [{ version: "1.0.0", integrity: sri(Buffer.from("other")) }, null] });
    expect(install.closure().errors).toEqual([expect.stringMatching(/^cannot derive the installed files of node_modules\/a: cannot read npm's cached archive/)]);
  });

  it.each(["optional", "dev", "devOptional"])("allows an omitted %s entry and compares it when installed", flag => {
    const install = simulatedInstall({ "node_modules/a": [{ version: "1.0.0", [flag]: true }, { "package.json": manifest("a") }] });
    expect(install.differences()).toEqual([]);
    rmSync(join(install.project, "node_modules/a"), { recursive: true });
    expect(install.closure().entries.get("node_modules/a")?.present).toBe(false);
    expect(install.differences()).toEqual([]);
    mkdirSync(join(install.project, "node_modules/a"));
    expect(install.differences()).toEqual(["missing: node_modules/a/package.json"]);
  });

  it("accepts any plain files of an entry without a sha512 integrity, but no node_modules or link in it", () => {
    const install = simulatedInstall({
      "node_modules/git-dependency": [{ version: "1.0.0", resolved: "git+ssh://git@example.com/a.git#0" }, null],
      "node_modules/git-dependency/node_modules/c": [{ version: "1.0.0" }, { "package.json": manifest("c") }],
    });
    mkdirSync(join(install.project, "node_modules/git-dependency/lib"), { recursive: true });
    writeFileSync(join(install.project, "node_modules/git-dependency/lib/index.js"), "");
    expect(install.closure().entries.get("node_modules/git-dependency")?.unverified).toBe(true);
    expect(install.differences()).toEqual([]);
    mkdirSync(join(install.project, "node_modules/git-dependency/lib/node_modules/@kynesyslabs/dacs"), { recursive: true });
    symlinkSync("index.js", join(install.project, "node_modules/git-dependency/lib/main.js"));
    expect(install.differences()).toEqual(["unexpected link: node_modules/git-dependency/lib/main.js",
      "unexpected directory: node_modules/git-dependency/lib/node_modules"]);
    rmSync(join(install.project, "node_modules/git-dependency"), { recursive: true });
    expect(install.differences()).toEqual(["missing: node_modules/git-dependency/node_modules/c/package.json",
      "missing: node_modules/git-dependency"]);
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
      const closure = () => installationClosure(project, lock, (_location: string, locked: { integrity: string }) =>
        cachedArchive(cache, locked.integrity));
      return { project, closure };
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
      const error = "cannot derive the installed files of node_modules/late-file: packed tarball has a malformed trailer";
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

  it("explicitly refuses a missing bin target that npm successfully skips", async () => {
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
      expect(closure.errors).toEqual([
        "cannot derive the installed files of node_modules/missing-bin: bin target is not an archive file: missing.js",
      ]);
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
      expect(closure.errors).toContain("cannot derive the installed files of node_modules/parent: package has an npm-shrinkwrap.json");
    } finally { await server.close(); }
  }, 60_000);

  it.each([false, true])("derives an installed optional bundle or explicitly refuses its omission, omit=%s", async omit => {
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
        expect(closure.errors).toEqual([
          `cannot derive the installed files of ${location}: omitted entry is in the archive of node_modules/parent`,
        ]);
      } else {
        expect(closure.errors).toEqual([]);
        expect(installationDifferences(project, closure)).toEqual([]);
      }
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
      expect(closure.errors).toEqual([
        "cannot derive the installed files of node_modules/crlf-bin: npm rewrites the CRLF shebang of bin target: cli.js",
      ]);
    } finally { await server.close(); }
  }, 60_000);
});

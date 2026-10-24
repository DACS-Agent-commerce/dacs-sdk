import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, cp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  packages, plannedVersion, validateManifest, validateFiles, publicEntries,
  validateLock, validateArtifactSet,
} from "../../scripts/release-checks.mjs";

const core = packages[0];
const manifest = (definition = core) => ({
  name: definition.name, version: "0.1.0-alpha.0", type: "module",
  license: "MIT", repository: { url: "git+https://github.com/DACS-Agent-commerce/dacs-sdk.git" },
  publishConfig: { access: "public", provenance: true },
  exports: Object.fromEntries(definition.requiredExports.map((key, i) =>
    [key, definition.directory.match(/dacs-(client|seller)$/) ? `./src/entry${i}.mjs` :
      { types: `./dist/entry${i}.d.ts`, import: `./dist/entry${i}.js` }])),
});
const members = (p) => ["package.json", ...Object.values(p.exports).flatMap(v =>
  typeof v === "string" ? [v.slice(2)] : Object.values(v).map(s => s.slice(2)))];

// These assertions exercise the gate with independently damaged package inputs.
test("the release inventory names all five packages and the next planned version", () => {
  assert.deepEqual(packages.map(p => p.name), [
    "@kynesyslabs/dacs", "@kynesyslabs/dacs-node", "@kynesyslabs/dacs-client",
    "@kynesyslabs/dacs-seller", "create-dacs-agent",
  ]);
  assert.equal(plannedVersion, "0.1.0-alpha.1");
});

test("private packages, empty exports and removed public paths fail closed", () => {
  assert.throws(() => validateManifest({ ...manifest(), private: true }, core), /private/);
  assert.throws(() => validateManifest({ ...manifest(), exports: {} }, core), /export/);
  const p = manifest(); delete p.exports["./rails"];
  assert.throws(() => validateManifest(p, core), /rails/);
});

test("all dependency sections allow only registry specs, including aliases and nested overrides", () => {
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "overrides", "resolutions"]) {
    for (const spec of ["file:../core", "git+file:///tmp/core", "workspace:*", "link:../core", "../core", "/tmp/core",
      ".", "..", "~/core", "portal:../core", "github:org/core", "org/core",
      "git+ssh://git@example.invalid/core", "git://example.invalid/core", "https://example.invalid/core.tgz",
      "npm:core@file:../core", "npm:core@github:org/core", "not a spec"]) {
      assert.throws(() => validateManifest({ ...manifest(), [section]: { core: spec } }, core), /non-registry dependency/g);
    }
  }
  assert.throws(() => validateManifest({ ...manifest(), overrides: { outer: { inner: "file:../core" } } }, core), /non-registry dependency/g);
  for (const spec of ["1.2.3", "^1.0.0", ">=1 <3", "*", "next", "npm:external@^1.0.0", "npm:@scope/external@next"]) {
    assert.doesNotThrow(() => validateManifest({ ...manifest(), dependencies: { external: spec } }, core));
  }
  assert.throws(() => validateManifest({ ...manifest(), overrides: { outer: { inner: "github:org/core" } } }, core), /non-registry/);
});

test("file policy rejects extra files and requires every export, type and binary target", () => {
  const p = manifest(); const files = members(p);
  assert.doesNotThrow(() => validateFiles(core, p, files));
  for (const extra of [".env", "src/internal.ts", "test/fixture.json", "../outside.js", "dist/../../outside.js", "dist/fixture.txt"]) {
    assert.throws(() => validateFiles(core, p, [...files, extra]), /allow-list|path/);
  }
  assert.throws(() => validateFiles(core, p, files.filter(f => f !== "dist/entry0.js")), /missing/);
  assert.throws(() => validateFiles(core, p, files.filter(f => f !== "dist/entry0.d.ts")), /missing/);
  assert.throws(() => validateFiles(core, { ...p, bin: { dacs: "./dist/bin.js" } }, files), /missing/);
  assert.throws(() => validateFiles(core, { ...p, exports: { ...p.exports, "./bad": "../outside.js" } }, files), /target/);
});

test("wildcard exports enumerate packed files, JSON exports carry their type, empty patterns fail", () => {
  const p = { exports: { ".": "./src/index.mjs", "./src/*": "./src/*", "./package.json": "./package.json" } };
  const files = ["src/index.mjs", "src/nested/helper.mjs", "src/schema.json", "package.json"];
  const entries = publicEntries(p, files);
  assert.deepEqual(entries.map(e => e.subpath), [".", "./src/index.mjs", "./src/nested/helper.mjs", "./src/schema.json", "./package.json"]);
  assert.equal(entries.find(e => e.subpath === "./src/schema.json").json, true);
  assert.throws(() => publicEntries({ exports: { "./empty/*": "./empty/*.js" } }, files), /no packed/);
});

test("consumer lock refuses links and directory dependencies but admits the input tarballs", () => {
  const allowed = [{ name: core.name, tarball: "/tmp/core.tgz" }];
  assert.doesNotThrow(() => validateLock({ packages: { [`node_modules/${core.name}`]: { resolved: "file:/tmp/core.tgz" } } }, allowed));
  assert.doesNotThrow(() => validateLock({ packages: { [`node_modules/${core.name}`]: { resolved: "file:../core.tgz" } } }, allowed, "/tmp/consumer"));
  for (const value of [{ link: true }, { resolved: "file:../core" }, { resolved: "workspace:*" }]) {
    assert.throws(() => validateLock({ packages: { [`node_modules/${core.name}`]: value } }, allowed), /link|local|internal.*tarball/);
  }
});

test("all five packages enforce the existing release identity and publish policy", () => {
  for (const definition of packages) {
    for (const damage of [
      { name: "wrong-name" }, { license: "UNLICENSED" }, { repository: { url: "https://example.invalid/repo" } },
      { publishConfig: { access: "restricted", provenance: true } }, { publishConfig: { access: "public" } },
      { publishConfig: { access: "public", provenance: false } },
    ]) assert.throws(() => validateManifest({ ...manifest(definition), ...damage }, definition), error =>
      error.message.includes(definition.name) && /identity|publish policy/.test(error.message));
  }
});

test("release versions use strict semver", () => {
  for (const version of ["1.0.0-pre_release", "01.2.3", "1.2.3-01", "v1.2.3"]) {
    assert.throws(() => validateManifest({ ...manifest(), version }, core), /version/);
  }
  assert.doesNotThrow(() => validateManifest({ ...manifest(), version: "1.2.3-rc.1+build.5" }, core));
});

test("wildcard exports pair every condition with the same concrete subpath", () => {
  const p = { exports: { "./feature/*": { types: "./dist/*.d.ts", import: "./dist/*.js" } } };
  assert.throws(() => validateFiles(core, p, ["package.json", "dist/a.js", "dist/b.d.ts"]), /missing.*target/);
  assert.throws(() => validateFiles(core, p, ["package.json", "dist/a.js", "dist/a.d.ts", "dist/b.js"]), /missing.*target/);
  assert.doesNotThrow(() => validateFiles(core, p, ["package.json", "dist/a.js", "dist/a.d.ts", "dist/nested/b.js", "dist/nested/b.d.ts"]));
  assert.throws(() => validateFiles(core, p, ["package.json", "dist/a.d.ts"]), /missing|no packed/);
});

test("nested internal lock entries must resolve to supplied tarballs", () => {
  const name = `node_modules/${packages[1].name}/node_modules/${core.name}`;
  for (const resolved of ["https://registry.npmjs.org/@kynesyslabs/dacs/-/dacs-0.1.0-alpha.0.tgz", undefined, "file:/tmp/other.tgz"]) {
    assert.throws(() => validateLock({ packages: { [name]: { resolved } } }, [{ name: core.name, tarball: "/tmp/core.tgz" }]), /internal.*tarball/);
  }
  assert.doesNotThrow(() => validateLock({ packages: { [name]: { resolved: "file:/tmp/core.tgz" } } }, [{ name: core.name, tarball: "/tmp/core.tgz" }]));
});

test("lock checks distinguish omitted optional metadata from installed dependencies", () => {
  const lock = { packages: { "node_modules/external": {
    optional: true, resolved: "git+ssh://example.invalid/external.git#commit",
  } } };
  assert.doesNotThrow(() => validateLock(lock, [], ".", true));
  assert.throws(() => validateLock(lock, []), /non-registry/);
  lock.packages["node_modules/external"].optional = false;
  assert.throws(() => validateLock(lock, [], ".", true), /non-registry/);
  assert.throws(() => validateLock({ packages: {
    [`node_modules/${core.name}`]: { optional: true, resolved: "https://registry.npmjs.org/core.tgz" },
  } }, [], ".", true), /internal.*tarball/);
});

test("internal aliases are refused in every dependency section and aliased lock identity", () => {
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "overrides", "resolutions"]) {
    assert.throws(() => validateManifest({ ...manifest(), [section]: { compat: `npm:${core.name}@0.1.0-alpha.0` } }, core), /non-registry/);
    assert.doesNotThrow(() => validateManifest({ ...manifest(), [section]: { compat: "npm:external@1.0.0" } }, core));
  }
  for (const path of ["node_modules/compat", "node_modules/external/node_modules/compat"]) {
    assert.throws(() => validateLock({ packages: { [path]: { name: core.name, resolved: "https://registry.npmjs.org/core.tgz" } } }, []), /internal.*tarball/);
    assert.doesNotThrow(() => validateLock({ packages: { [path]: { name: "external", resolved: "https://registry.npmjs.org/external.tgz" } } }, []));
  }
});

test("registry override references and root export shorthand remain supported", () => {
  const def = packages[4];
  for (const exports of ["./dist/index.js", { types: "./dist/index.d.ts", import: "./dist/index.js" }]) {
    const p = { ...manifest(def), exports, dependencies: { external: "1.0.0" }, overrides: { external: "$external" } };
    assert.doesNotThrow(() => validateManifest(p, def));
    assert.deepEqual(publicEntries(p, ["dist/index.js", "dist/index.d.ts"]), [{ subpath: ".", json: false }]);
  }
  assert.throws(() => validateManifest({ ...manifest(), overrides: { other: "$missing" } }, core), /non-registry/);
});

test("null exclusions and more specific export overrides follow Node resolution", () => {
  const exports = { "./feature/*": { import: "./dist/*.js", types: "./dist/*.d.ts" },
    "./feature/private/*": null, "./feature/private/public": "./dist/special.js", "./disabled": null };
  const files = ["package.json", "dist/a.js", "dist/a.d.ts", "dist/private/hidden.js", "dist/special.js", "dist/special.d.ts"];
  assert.doesNotThrow(() => validateFiles(core, { exports }, files));
  const paths = publicEntries({ exports }, files).map(e => e.subpath);
  assert.ok(paths.includes("./feature/a"));
  assert.ok(paths.includes("./feature/private/public"));
  assert.ok(!paths.includes("./feature/private/hidden"));
});
test("strict artifact inventory admits exactly the five public identities", () => {
  const artifacts = packages.map(definition => ({ manifest: { ...manifest(definition), version: plannedVersion }, releasable: true }));
  assert.doesNotThrow(() => validateArtifactSet(artifacts, true));
  for (const damaged of [
    artifacts.slice(1),
    [...artifacts, { ...artifacts[0], manifest: { ...artifacts[0].manifest, name: "other" } }],
    [...artifacts.slice(0, -1), artifacts[0]],
    [...artifacts.slice(0, -1), { ...artifacts[4], manifest: { ...artifacts[4].manifest, name: "other" } }],
    artifacts.map((a, i) => i === 2 ? { ...a, releasable: false } : a),
  ]) assert.throws(() => validateArtifactSet(damaged, true), /all five/);
  assert.throws(() => validateArtifactSet(artifacts.map((a, i) => i === 2 ?
    { ...a, manifest: { ...a.manifest, private: true } } : a), true), /private package/);
});

test("dependency maps reject malformed sections and leaves", () => {
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "overrides", "resolutions"]) {
    for (const value of [null, 42, [], "1.0.0", true]) {
      assert.throws(() => validateManifest({ ...manifest(), [section]: value }, core), /dependency/);
    }
    for (const value of [null, 42, [], true, ["1.0.0"]]) {
      assert.throws(() => validateManifest({ ...manifest(), [section]: { external: value } }, core), /dependency/);
    }
  }
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    assert.throws(() => validateManifest({ ...manifest(), [section]: { external: { nested: "1.0.0" } } }, core), /dependency/);
  }
  for (const section of ["overrides", "resolutions"]) {
    assert.doesNotThrow(() => validateManifest({ ...manifest(), [section]: { outer: { ".": "1.0.0", inner: "^2.0.0" } } }, core));
    assert.throws(() => validateManifest({ ...manifest(), [section]: { outer: { inner: null } } }, core), /dependency/);
  }
});

test("export trees reject malformed conditions even with a valid fallback", () => {
  const def = packages[4];
  for (const invalid of [42, true, false, { import: 42, default: "./dist/index.js" }, ["./dist/index.js", false]]) {
    const p = { ...manifest(def), exports: { ".": invalid } };
    assert.throws(() => validateManifest(p, def), /export/);
    assert.throws(() => validateFiles(def, p, ["package.json", "dist/index.js"]), /export/);
  }
  const p = { ...manifest(def), exports: { ".": { browser: null, import: "./dist/index.js" }, "./private": null } };
  assert.doesNotThrow(() => validateManifest(p, def));
  assert.doesNotThrow(() => validateFiles(def, p, ["package.json", "dist/index.js"]));
});

test("export targets reject encoded forbidden segments in actual npm pack inventories", async () => {
  const root = await mkdtemp(join(tmpdir(), "dacs-export-policy-"));
  try {
    const def = packages[4];
    for (const segment of ["%2e%2e", "%2E", "%6eode_modules", "node%5fmodules", "%2f", "%5C"]) {
      const target = `./dist/${segment}/index.js`;
      const p = { ...manifest(def), exports: { ".": target }, files: ["dist"] };
      await mkdir(join(root, "dist", segment), { recursive: true });
      await writeFile(join(root, target), "export {};\n");
      await writeFile(join(root, "package.json"), JSON.stringify(p));
      const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--dry-run", "--json"], { cwd: root, encoding: "utf8" }));
      const files = packed[0].files.map(file => file.path);
      assert.ok(files.includes(target.slice(2)));
      assert.throws(() => validateManifest(p, def), /export target/);
      assert.throws(() => validateFiles(def, p, files), /export target/);
    }
    for (const target of ["./dist/node_modules/index.js", "./dist/NODE_MODULES/index.js", "dist/index.js"]) {
      assert.throws(() => validateManifest({ ...manifest(def), exports: target }, def), /export target/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("artifact versions agree and strict mode requires the planned version", () => {
  const artifacts = packages.map(definition => ({ manifest: { ...manifest(definition), version: plannedVersion }, releasable: true }));
  assert.doesNotThrow(() => validateArtifactSet(artifacts, true));
  assert.throws(() => validateArtifactSet(artifacts.map((a, i) => i ? a :
    { ...a, manifest: { ...a.manifest, version: "9.9.9" } })), /release versions differ/);
  assert.throws(() => validateArtifactSet(artifacts.map(a =>
    ({ ...a, manifest: { ...a.manifest, version: "9.9.9" } })), true), /release versions differ/);
});

test("every runtime dependency section requires exact internal release pins", () => {
  for (const section of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const definition of packages) {
      const p = { ...manifest(packages[4]), [section]: { [definition.name]: "0.1.0-alpha.0" } };
      assert.doesNotThrow(() => validateArtifactSet([{ manifest: p }]));
      for (const spec of ["", "^0.1.0-alpha.0", "*", "next", "9.9.9"]) {
        assert.throws(() => validateArtifactSet([{ manifest: { ...p, [section]: { [definition.name]: spec } } }]), /exact release version/);
      }
    }
  }
});

test("internal lock identities must each resolve to their own supplied artifact", () => {
  const artifacts = [{ name: core.name, tarball: "/tmp/core.tgz" }, { name: packages[2].name, tarball: "/tmp/client.tgz" }];
  for (const prefix of ["", "node_modules/outer/"]) {
    const location = `${prefix}node_modules/${core.name}`;
    assert.doesNotThrow(() => validateLock({ packages: {
      [location]: { resolved: "file:/tmp/core.tgz" },
      [`node_modules/${packages[2].name}`]: { resolved: "file:/tmp/client.tgz" },
    } }, artifacts));
    assert.throws(() => validateLock({ packages: { [location]: { resolved: "file:/tmp/client.tgz" } } }, artifacts), /internal.*tarball/);
  }
  assert.throws(() => validateLock({ packages: { "node_modules/compat": { name: core.name, resolved: "file:/tmp/client.tgz" } } }, artifacts), /internal.*tarball/);
});

test("lock evidence requires package maps and installed resolutions with explicit metadata exceptions", () => {
  for (const packages of [undefined, null, [], 42]) {
    assert.throws(() => validateLock({ packages }, []), /lock.*packages/);
  }
  for (const entry of [{}, { resolved: "" }, { resolved: null }, { resolved: 42 }, null, []]) {
    assert.throws(() => validateLock({ packages: { "node_modules/external": entry } }, []), /resolution|lock.*entry/);
  }
  assert.doesNotThrow(() => validateLock({ packages: { "": { name: "consumer", version: "1.0.0" } } }, []));
  assert.doesNotThrow(() => validateLock({ packages: { "node_modules/optional": { optional: true } } }, [], ".", true));
  assert.throws(() => validateLock({ packages: { "node_modules/external": { optional: true } } }, []), /resolution/);
  const bundled = { packages: {
    "node_modules/outer": { resolved: "https://registry.npmjs.org/outer/-/outer-1.0.0.tgz" },
    "node_modules/outer/node_modules/inner": { version: "1.0.0", inBundle: true },
  } };
  assert.doesNotThrow(() => validateLock(bundled, []));
  delete bundled.packages["node_modules/outer"];
  assert.throws(() => validateLock(bundled, []), /resolution/);
});

test("empty internal runtime pins cannot pass strict five-package admission", () => {
  for (const section of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    const artifacts = packages.map(definition => ({
      manifest: { ...manifest(definition), version: plannedVersion }, releasable: true,
    }));
    artifacts[4].manifest[section] = { [core.name]: "" };
    assert.throws(() => validateArtifactSet(artifacts, true), /exact release version/);
  }
});

test("URL export syntax in real archives is refused when Node resolves a different filename", async () => {
  const root = await mkdtemp(join(tmpdir(), "dacs-export-url-"));
  try {
    const source = join(root, "source"), installed = join(root, "node_modules", packages[4].name);
    await mkdir(source, { recursive: true });
    for (const filename of ["a%20b.js", "index#v1.js", "index?v1.js", "index%25.js"]) {
      await rm(join(source, "dist"), { recursive: true, force: true });
      await mkdir(join(source, "dist"));
      const p = { ...manifest(packages[4]), exports: { ".": `./dist/${filename}` }, files: ["dist"] };
      await writeFile(join(source, "dist", filename), "export const ready = true;\n");
      await writeFile(join(source, "package.json"), JSON.stringify(p));
      const [packed] = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root],
        { cwd: source, encoding: "utf8" }));
      const files = packed.files.map(file => file.path);
      assert.ok(files.includes(`dist/${filename}`));
      await rm(installed, { recursive: true, force: true });
      await mkdir(installed, { recursive: true });
      execFileSync("tar", ["-xzf", join(root, packed.filename), "--strip-components=1", "-C", installed]);
      assert.throws(() => execFileSync(process.execPath, ["--input-type=module", "-e", `await import('${p.name}')`],
        { cwd: root, stdio: "pipe" }), /ERR_MODULE_NOT_FOUND/);
      assert.throws(() => validateManifest(p, packages[4]), /export target/);
      assert.throws(() => validateFiles(packages[4], p, files), /export target/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("lock evidence must include every expected installed artifact", () => {
  const artifacts = [{ name: core.name, tarball: "/tmp/core.tgz" }, { name: packages[2].name, tarball: "/tmp/client.tgz" }];
  const coreEntry = { [`node_modules/${core.name}`]: { resolved: "file:/tmp/core.tgz" } };
  for (const entries of [
    {}, { "": { name: "consumer", version: "1.0.0" } }, coreEntry,
    { ...coreEntry, [`node_modules/${packages[2].name}`]: { resolved: "file:/tmp/client.tgz", optional: true } },
    { "": { name: core.name, resolved: "file:/tmp/core.tgz" } },
    { "node_modules/compat": { name: core.name, resolved: "file:/tmp/core.tgz" } },
  ]) assert.throws(() => validateLock({ packages: entries }, artifacts, ".", true), /missing.*artifact/);
  const complete = { ...coreEntry, [`node_modules/${packages[2].name}`]: { resolved: "file:/tmp/client.tgz" } };
  assert.doesNotThrow(() => validateLock({ packages: complete }, artifacts, ".", true));
});

test("strict manifests require private to be absent or exactly false", () => {
  const artifacts = packages.map(definition => ({
    manifest: { ...manifest(definition), version: plannedVersion }, releasable: true,
  }));
  assert.doesNotThrow(() => validateArtifactSet(artifacts, true));
  artifacts[0].manifest.private = false;
  assert.doesNotThrow(() => validateArtifactSet(artifacts, true));
  for (const value of [true, "true", "false", 1, 0, null, [], {}]) {
    artifacts[0].manifest.private = value;
    assert.throws(() => validateArtifactSet(artifacts, true), /private/);
  }
});

test("manifest and file admission reject malformed public export subpaths", () => {
  const def = packages[4], files = ["package.json", "dist/index.js"];
  for (const key of ["..", "./", "./../outside", "./a/./b", "./a/../b", "./node_modules/a",
    "./a%2fb", "./a%5Cb", "./%2e%2e/outside", "./a\\b", "./a/**", "./a/*/*", "./a//b", "./a/"]) {
    const p = { ...manifest(def), exports: { ".": "./dist/index.js", [key]: "./dist/index.js" } };
    assert.throws(() => validateManifest(p, def), /export.*subpath|export.*pattern/);
    assert.throws(() => validateFiles(def, p, files), /export.*subpath|export.*pattern/);
  }
  const p = { ...manifest(def), exports: { ".": "./dist/index.js", "./feature/*.js": "./dist/*.js" } };
  assert.doesNotThrow(() => validateManifest(p, def));
  assert.doesNotThrow(() => validateFiles(def, p, files));
});

test("manifest entry fields reject malformed scalars and every non-string bin leaf", () => {
  const def = packages[4], files = ["package.json", "dist/entry0.js", "dist/entry0.d.ts"];
  for (const field of ["bin", "main", "types"]) {
    const invalid = [false, true, null, 42, [], ["./dist/entry0.js"], ""];
    if (field !== "bin") invalid.push({ path: "./dist/entry0.js" });
    for (const value of invalid) {
      const p = { ...manifest(def), [field]: value };
      assert.throws(() => validateManifest(p, def), /bin|main|types/);
      assert.throws(() => validateFiles(def, p, files), /bin|main|types/);
    }
  }
  for (const value of [false, true, null, 42, [], {}, { nested: "./dist/entry0.js" }, ""]) {
    const p = { ...manifest(def), bin: { valid: "./dist/entry0.js", agent: value } };
    assert.throws(() => validateManifest(p, def), /bin/);
    assert.throws(() => validateFiles(def, p, files), /bin/);
  }
  for (const bin of ["./dist/entry0.js", { agent: "./dist/entry0.js" }, {}]) {
    const p = { ...manifest(def), bin, main: "./dist/entry0.js", types: "./dist/entry0.d.ts" };
    assert.doesNotThrow(() => validateManifest(p, def));
    assert.doesNotThrow(() => validateFiles(def, p, files));
  }
});

test("wildcard captures obey the same URL and subpath rules as literal exports", () => {
  const def = packages[4];
  const p = { ...manifest(def), exports: { ".": "./dist/index.js", "./feature/*": "./dist/*.js" } };
  for (const capture of ["a%20b", "index#v1", "index?v1", "node_modules/internal"]) {
    assert.throws(() => validateFiles(def, p, ["package.json", "dist/index.js", `dist/${capture}.js`]), /export target|export subpath/);
  }
});

test("wildcard exports preserve dollar tokens in literal filenames and Node imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "dacs-export-dollars-"));
  try {
    const def = packages[4], p = { ...manifest(def), exports: {
      ".": "./dist/index.js", "./feature/*": "./dist/*.js",
    } };
    const captures = ["a$&b", "a$`b", "a$'b", "a$$b", "a*b"];
    const files = ["package.json", "dist/index.js", ...captures.map(c => `dist/${c}.js`)];
    validateManifest(p, def);
    validateFiles(def, p, files);
    const subpaths = publicEntries(p, files).map(e => e.subpath);
    for (const capture of captures) assert.ok(subpaths.includes(`./feature/${capture}`), capture);
    const installed = join(root, "node_modules", p.name);
    await mkdir(join(installed, "dist"), { recursive: true });
    await writeFile(join(installed, "package.json"), JSON.stringify(p));
    for (const file of files.filter(f => f.endsWith(".js"))) await writeFile(join(installed, file), "export const ready = true;\n");
    const specs = captures.map(c => `${p.name}/feature/${c}`);
    execFileSync(process.execPath, ["--input-type=module", "-e",
      `for (const spec of ${JSON.stringify(specs)}) if (!(await import(spec)).ready) throw Error(spec);`], { cwd: root });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("expanded wildcard subpaths reject forbidden segments", () => {
  const def = packages[4];
  for (const [key, target, file] of [
    ["./node_*", "./dist/*.js", "dist/modules/a.js"],
    ["./feature/*", "./dist/prefix*.js", "dist/prefix/a.js"],
    ["./feature/*/a", "./dist/*suffix.js", "dist/nested/suffix.js"],
  ]) {
    const p = { ...manifest(def), exports: { ".": "./dist/index.js", [key]: target } };
    validateManifest(p, def);
    assert.throws(() => validateFiles(def, p, ["package.json", "dist/index.js", file]), /invalid export subpath/);
    assert.throws(() => publicEntries(p, ["dist/index.js", file]), /invalid export subpath/);
  }
});

test("required public exports reject unusable runtime trees in manifest and strict admission", () => {
  const js = "./dist/runtime.js", types = "./dist/runtime.d.ts";
  for (const definition of packages) for (const key of definition.requiredExports) {
    for (const target of [[], {}, [null], { types }, { browser: js }, { require: js },
      { node: null, default: js }, { node: { types }, default: null }, [null, { types }],
      { default: types, import: js }, { import: { types } }, { import: [] }]) {
      const p = manifest(definition); p.exports[key] = target;
      assert.throws(() => validateManifest(p, definition), /missing public export|runtime.*export/);
      const artifacts = packages.map(d => ({ manifest: { ...manifest(d), version: plannedVersion }, releasable: true }));
      artifacts[packages.indexOf(definition)].manifest.exports[key] = target;
      assert.throws(() => validateArtifactSet(artifacts, true), /missing public export|runtime.*export/);
    }
  }
});

test("required public exports refuse targets Node cannot import, such as source maps", () => {
  for (const target of ["./dist/index.js.map", "./dist/index.d.ts.map", "./dist/index.node", "./dist/index"]) {
    const p = manifest(); p.exports["."] = { import: target };
    assert.throws(() => validateManifest(p, core), /runtime.*export/);
  }
  const p = manifest(); p.exports["."] = { import: "./dist/index.mjs" };
  assert.doesNotThrow(() => validateManifest(p, core));
});

test("lock file resolutions with a query, fragment or escape cannot name a supplied tarball", () => {
  const allowed = [{ name: core.name, tarball: "/tmp/expected.tgz" }];
  for (const resolved of ["file:../other.tgz?/../expected.tgz", "file:../other.tgz#/../expected.tgz", "file:../other%2f../expected.tgz"]) {
    assert.throws(() => validateLock({ packages: { [`node_modules/${core.name}`]: { resolved } } }, allowed, "/tmp/consumer"), /ambiguous local file/);
  }
});

test("admitted required subpaths resolve and import in Node", async () => {
  const root = await mkdtemp(join(tmpdir(), "dacs-required-imports-"));
  try {
    for (const definition of packages) {
      const p = manifest(definition), files = members(p);
      validateManifest(p, definition); validateFiles(definition, p, files);
      const installed = join(root, "node_modules", p.name);
      for (const file of files) {
        await mkdir(dirname(join(installed, file)), { recursive: true });
        await writeFile(join(installed, file), file === "package.json" ? JSON.stringify(p) :
          file.endsWith(".d.ts") ? "export declare const ready: boolean;\n" : "export const ready = true;\n");
      }
      const specs = definition.requiredExports.map(key => p.name + (key === "." ? "" : key.slice(1)));
      execFileSync(process.execPath, ["--input-type=module", "-e", `for (const spec of ${JSON.stringify(specs)}) {
        import.meta.resolve(spec); if (!(await import(spec)).ready) throw Error(spec);
      }`], { cwd: root });
    }
    const def = packages[4], installed = join(root, "node_modules", def.name);
    for (const target of ["./dist/entry0.js", [null, { types: "./dist/entry0.d.ts" }, "./dist/entry0.js"],
      { browser: null, node: { types: "./dist/entry0.d.ts" }, default: "./dist/entry0.js" },
      { node: { import: "./dist/entry0.js" }, default: null },
      { "node-addons": "./dist/entry0.js", default: null }]) {
      const p = { ...manifest(def), exports: { ".": target } };
      validateManifest(p, def);
      await writeFile(join(installed, "package.json"), JSON.stringify(p));
      execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(p.name)});`], { cwd: root });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("non-strict artifact admission rejects unknown and duplicate identities and invalid release identity", () => {
  const artifacts = packages.map(definition => ({ manifest: manifest(definition) }));
  assert.doesNotThrow(() => validateArtifactSet(artifacts.slice(0, 1)));
  const unknown = { manifest: { ...manifest(), name: "unlisted-sixth" } };
  for (const damaged of [[unknown], [...artifacts, unknown], [artifacts[0], artifacts[0]], [...artifacts, artifacts[0]]]) {
    assert.throws(() => validateArtifactSet(damaged), /unknown|duplicate|identit/);
  }
  for (const damage of [{ license: "UNLICENSED" }, { repository: {} }, { publishConfig: { access: "restricted" } }]) {
    assert.throws(() => validateArtifactSet([{ manifest: { ...manifest(), ...damage } }]), /identity|publish policy/);
  }
});

test("a star is a wildcard only in pattern export keys, never in entry fields or literal exports", () => {
  const def = packages[4];
  const base = manifest(def), files = members(base);
  for (const damage of [{ main: "./dist/*.js" }, { types: "./dist/*.d.ts" }, { bin: "./dist/*.js" }, { bin: { agent: "./dist/*.js" } }]) {
    assert.throws(() => validateFiles(def, { ...base, ...damage }, [...files, "dist/.js", "dist/.d.ts"]), /missing packed target/);
  }
  const literal = { ...base, exports: { ".": "./dist/runtime*.js" } };
  assert.throws(() => validateFiles(def, literal, ["package.json", "dist/runtime.js"]), /missing packed target/);
  assert.throws(() => validateFiles(def, { ...base, exports: { ".": "./dist/*.js" } }, ["package.json", "dist/.js"]), /missing packed target/);
  const present = ["package.json", "dist/runtime*.js"];
  assert.doesNotThrow(() => validateFiles(def, literal, present));
  assert.deepEqual(publicEntries(literal, present).map(e => e.subpath), ["."]);
  assert.doesNotThrow(() => validateFiles(def, { ...base, bin: "./dist/a*b.js" }, [...files, "dist/a*b.js"]));
});

test("module-sync export conditions are refused because Node 22 resolves them before default", () => {
  const def = packages[4];
  for (const exports of [
    { ".": { "module-sync": null, default: "./dist/index.js" } },
    { ".": { import: { "module-sync": "./dist/sync.js", default: "./dist/index.js" } } },
    { ".": ["./dist/index.js", { "module-sync": "./dist/sync.js" }] },
  ]) {
    const p = { ...manifest(def), exports };
    assert.throws(() => validateManifest(p, def), /module-sync/);
    assert.throws(() => validateFiles(def, p, ["package.json", "dist/index.js", "dist/sync.js"]), /module-sync/);
  }
});

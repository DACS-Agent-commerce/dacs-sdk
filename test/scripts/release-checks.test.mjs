import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  packages, plannedVersion, validateManifest, validateFiles, publicEntries,
  validateLock, checkInstalled, prepare, consume, dryRun, expectedNode20Rejection,
} from "../../scripts/release-checks.mjs";

const core = packages[0];
const manifest = (definition = core) => ({
  name: definition.name, version: "0.1.0-alpha.0", type: "module",
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

test("all dependency sections reject local links, including nested overrides", () => {
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "overrides", "resolutions"]) {
    for (const spec of ["file:../core", "git+file:///tmp/core", "workspace:*", "link:../core", "../core", "/tmp/core"]) {
      assert.throws(() => validateManifest({ ...manifest(), [section]: { core: spec } }, core), /local dependency/);
    }
  }
  assert.throws(() => validateManifest({ ...manifest(), overrides: { outer: { inner: "file:../core" } } }, core), /local dependency/);
  assert.doesNotThrow(() => validateManifest({ ...manifest(), dependencies: { external: "^1.0.0" } }, core));
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
  const allowed = ["/tmp/core.tgz"];
  assert.doesNotThrow(() => validateLock({ packages: { "node_modules/core": { resolved: "file:/tmp/core.tgz" } } }, allowed));
  assert.doesNotThrow(() => validateLock({ packages: { "node_modules/core": { resolved: "file:../core.tgz" } } }, allowed, "/tmp/consumer"));
  for (const value of [{ link: true }, { resolved: "file:../core" }, { resolved: "workspace:*" }]) {
    assert.throws(() => validateLock({ packages: { "node_modules/core": value } }, allowed), /link|local/);
  }
});

test("only declared Node 22 surfaces may reject node:sqlite on Node 20", () => {
  const error = { code: "ERR_UNKNOWN_BUILTIN_MODULE", message: "No such built-in module: node:sqlite" };
  const p = { name: packages[3].name, engines: { node: ">=22.13.0" } };
  assert.equal(expectedNode20Rejection(p, ".", error, "20.19.0"), true);
  assert.equal(expectedNode20Rejection(p, ".", error, "22.21.1"), false);
  assert.equal(expectedNode20Rejection({ ...p, name: core.name }, ".", error, "20.19.0"), false);
  assert.equal(expectedNode20Rejection({ ...p, name: packages[2].name }, ".", error, "20.19.0"), false);
  assert.equal(expectedNode20Rejection({ ...p, name: packages[2].name }, "./durable-journal", error, "20.19.0"), true);
  assert.equal(expectedNode20Rejection(p, ".", { ...error, code: "ERR_MODULE_NOT_FOUND" }, "20.19.0"), false);
});

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "dacs-release-test-"));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("installed package directories cannot resolve through workspace symlinks", () => fixture(async root => {
  const outside = join(root, "outside"); const consumer = join(root, "consumer");
  await mkdir(outside); await mkdir(join(consumer, "node_modules", "@kynesyslabs"), { recursive: true });
  await symlink(outside, join(consumer, "node_modules", core.name));
  await assert.rejects(checkInstalled(consumer, [{ manifest: manifest(), definition: core }]), /link|outside/);
}));

async function sourceTree(root) {
  for (const definition of packages) {
    const dir = join(root, definition.directory); const p = manifest(definition);
    await mkdir(join(dir, "dist"), { recursive: true });
    p.scripts = { clean: 'node -e "require(\'fs\').rmSync(\'dist\',{recursive:true,force:true})"', build: "node build.mjs" };
    p.files = ["dist"];
    if (definition !== core) p.peerDependencies = { [core.name]: p.version };
    const count = Object.keys(p.exports).length;
    const direct = definition.directory.match(/dacs-(client|seller)$/);
    const output = direct ? "src" : "dist";
    p.files = [output];
    const build = `import fs from 'node:fs';fs.mkdirSync('${output}',{recursive:true});for(let i=0;i<${count};i++){fs.writeFileSync('${output}/entry'+i+'.${direct ? "mjs" : "js"}','export const ready = true;');${direct ? "" : "fs.writeFileSync('dist/entry'+i+'.d.ts','export declare const ready: boolean;');"}}`;
    await writeFile(join(dir, "package.json"), JSON.stringify(p));
    await writeFile(join(dir, "build.mjs"), build);
    if (definition.name === "@kynesyslabs/dacs-node") {
      p.exports["./vectors/dacs-http-envelope-v1.json"] = "./vectors/dacs-http-envelope-v1.json";
      p.files.push("vectors");
      await mkdir(join(dir, "vectors"));
      await writeFile(join(dir, "vectors/dacs-http-envelope-v1.json"), "{}");
    }
    if (definition.name === "@kynesyslabs/dacs-seller") {
      p.exports["./src/*"] = "./src/*";
      p.exports["./package.json"] = "./package.json";
      delete p.scripts;
      await mkdir(join(dir, "src"));
      await writeFile(join(dir, "src/entry0.mjs"), "export const ready = true;");
    }
    await writeFile(join(dir, "package.json"), JSON.stringify(p));
  }
}

test("compiled builds, direct-source packs, wildcard/JSON imports and five dry-runs work without a registry", { timeout: 120_000 }, () => fixture(async root => {
  await sourceTree(root); const logs = [];
  await writeFile(join(root, "dist/stale.js"), "throw Error('stale output');");
  const result = await prepare(root, join(root, "scratch"), message => logs.push(message));
  assert.equal(result.errors.length, 0, result.errors.join("\n"));
  assert.equal(result.artifacts.length, 5);
  assert.ok(!result.artifacts[0].files.includes("dist/stale.js"), "build must clean stale output before pack");
  await consume(result.artifacts, join(root, "scratch"), message => logs.push(message));
  await dryRun(result.artifacts, message => logs.push(message));
  for (const p of packages) assert.ok(logs.some(line => line.includes(p.name) && line.includes("dry-run")));
  assert.ok(logs.some(line => line.includes("@kynesyslabs/dacs-node") && line.includes("peerDependencies")));
  assert.ok(logs.some(line => line.includes("0.1.0-alpha.1") && line.includes("0.1.0-alpha.0")));
  const installed = JSON.parse(await readFile(join(root, "scratch", "consumer", "node_modules", core.name, "package.json")));
  assert.equal(installed.version, "0.1.0-alpha.0");
  assert.ok(logs.some(line => line.includes("imported @kynesyslabs/dacs-seller/src/entry0.mjs")));
  assert.ok(logs.some(line => line.includes("imported @kynesyslabs/dacs-node/vectors/dacs-http-envelope-v1.json")));
}));

test("every publish invocation is offline, dry-run only, with lifecycle hooks disabled", async () => {
  const calls = [];
  await dryRun(packages.map(definition => ({ manifest: manifest(definition), tarball: `/tmp/${definition.directory.replaceAll("/", "-")}.tgz` })), () => {}, (...args) => { calls.push(args); return "dry-run output"; });
  assert.equal(calls.length, 5);
  for (const [command, args, , env] of calls) {
    assert.equal(command, "npm");
    assert.equal(args[0], "publish");
    for (const flag of ["--dry-run", "--ignore-scripts", "--provenance=false"]) assert.ok(args.includes(flag));
    assert.equal(env.npm_config_offline, "true");
  }
});

test("one failed npm dry-run preserves its cause and still attempts the other packages", async () => {
  let calls = 0;
  await assert.rejects(dryRun(packages.map(definition => ({ manifest: manifest(definition), tarball: "/tmp/fixture.tgz" })), () => {}, () => {
    if (++calls === 1) throw new Error("fixture refusal");
    return "dry-run output";
  }), /fixture refusal/);
  assert.equal(calls, 5);
});

test("an internal runtime dependency must come from this packed set", async () => {
  for (const section of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    const p = { ...manifest(packages[4]), [section]: { [core.name]: "0.1.0-alpha.0" } };
    await assert.rejects(consume([{ manifest: p }], "/unused"), /missing packed internal dependency/);
  }
});

test("missing packages stay errors while the other packages are packed", { timeout: 120_000 }, () => fixture(async root => {
  await sourceTree(root);
  await rm(join(root, packages[3].directory), { recursive: true });
  const result = await prepare(root, join(root, "scratch"), () => {});
  assert.equal(result.artifacts.length, 4);
  assert.ok(result.errors.some(e => e.includes("dacs-seller")));
}));

test("a shipped module with an unresolved import fails from the clean consumer", { timeout: 120_000 }, () => fixture(async root => {
  await sourceTree(root);
  const path = join(root, "build.mjs");
  await writeFile(path, (await readFile(path, "utf8")) + "\nfs.appendFileSync('dist/entry0.js', \"import 'missing-release-dependency';\");");
  const result = await prepare(root, join(root, "scratch"), () => {});
  const logs = [];
  await assert.rejects(consume(result.artifacts, join(root, "scratch"), message => logs.push(message)), /missing-release-dependency/);
  assert.ok(logs.some(line => line.includes("imported create-dacs-agent")), "later imports must still run");
}));

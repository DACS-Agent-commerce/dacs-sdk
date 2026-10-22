import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  packages, plannedVersion, validateManifest, validateFiles, publicEntries,
  validateLock, checkInstalled, prepare, consume, dryRun, expectedNode20Rejection, release,
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

test("missing packages stay not ready while the other packages are packed", { timeout: 120_000 }, () => fixture(async root => {
  await sourceTree(root);
  await rm(join(root, packages[3].directory), { recursive: true });
  const result = await prepare(root, join(root, "scratch"), () => {});
  assert.equal(result.artifacts.length, 4);
  assert.ok(result.notReady.some(e => e.includes("dacs-seller")));
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


test("all five packages enforce the existing release identity and publish policy", () => {
  for (const definition of packages) {
    for (const damage of [
      { name: "wrong-name" }, { license: "UNLICENSED" }, { repository: { url: "https://example.invalid/repo" } },
      { publishConfig: { access: "restricted", provenance: true } }, { publishConfig: { access: "public" } },
      { publishConfig: { access: "public", provenance: false } },
    ]) assert.throws(() => validateManifest({ ...manifest(definition), ...damage }, definition), /identity|publish policy/);
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
    assert.throws(() => validateLock({ packages: { [name]: { resolved } } }, ["/tmp/core.tgz"]), /internal.*tarball/);
  }
  assert.doesNotThrow(() => validateLock({ packages: { [name]: { resolved: "file:/tmp/core.tgz" } } }, ["/tmp/core.tgz"]));
});

test("mutating an installed package identity fails", () => fixture(async root => {
  const dir = join(root, "node_modules", core.name);
  await mkdir(dir, { recursive: true });
  for (const damage of [{ name: "impostor" }, { version: "9.9.9" }]) {
    await writeFile(join(dir, "package.json"), JSON.stringify({ ...manifest(), ...damage }));
    await assert.rejects(checkInstalled(root, [{ manifest: manifest() }]), /installed identity mismatch/);
  }
}));

async function changeManifest(root, definition, damage) {
  const path = join(root, definition.directory, "package.json");
  await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path)), ...damage }));
}

test("mixed release versions and ranged internal peers fail preparation", { timeout: 120_000 }, () => fixture(async root => {
  await sourceTree(root);
  await changeManifest(root, packages[2], { version: "0.1.0-alpha.9" });
  await changeManifest(root, packages[3], { peerDependencies: { [core.name]: "^0.1.0-alpha.0" } });
  const result = await prepare(root, join(root, "scratch"), () => {});
  assert.ok(result.notReady.some(e => e.includes("release versions differ")));
  assert.ok(result.notReady.some(e => e.includes("internal dependency must use exact release version")));
}));

test("strict release rejects a private package even when the surviving subset imports", { timeout: 120_000 }, () => fixture(async root => {
  await sourceTree(root);
  await changeManifest(root, packages[2], { private: true });
  const logs = [];
  await assert.rejects(release("check", { root, log: line => logs.push(line) }), /private package/);
  assert.ok(logs.some(line => line.includes("imported create-dacs-agent")), "the surviving subset must actually import");
  assert.ok(!logs.some(line => line.includes("Release ready")));
}));

test("preparation dry run reports not ready without failing on missing/private packages", { timeout: 120_000 }, () => fixture(async root => {
  await sourceTree(root);
  await changeManifest(root, packages[2], { private: true });
  await rm(join(root, packages[3].directory), { recursive: true });
  const logs = [];
  const result = await release("dry-run", { root, log: line => logs.push(line) });
  assert.equal(result.ready, false);
  assert.ok(logs.some(line => line.includes("not ready") && line.includes("private package")));
  assert.ok(logs.some(line => line.includes("not ready") && line.includes(packages[3].name)));
  assert.ok(logs.some(line => line.includes("npm publish --dry-run")));
}));

test("preparation dry run still fails on build defects", { timeout: 120_000 }, () => fixture(async root => {
  await sourceTree(root);
  await writeFile(join(root, "build.mjs"), "throw Error('fixture build failure');");
  const logs = [];
  await assert.rejects(release("dry-run", { root, log: line => logs.push(line) }), /fixture build failure/);
}));

test("native sqlite uses its exact pin; root and sqlite entries import with only its build allowed", { timeout: 240_000 }, () => fixture(async root => {
  await sourceTree(root);
  const def = packages[1];
  await changeManifest(root, def, { optionalDependencies: { "better-sqlite3": "12.6.2" } });
  const coreManifest = JSON.parse(await readFile(join(root, "package.json")));
  await changeManifest(root, core, { scripts: { ...coreManifest.scripts, postinstall: "node -e \"throw Error('unrelated install script ran')\"" } });
  const path = join(root, def.directory, "build.mjs");
  await writeFile(path, (await readFile(path, "utf8")) + "\nfs.appendFileSync('dist/entry2.js', \"import 'better-sqlite3';\");fs.appendFileSync('dist/entry0.js', \"import './entry2.js';\");");
  const result = await prepare(root, join(root, "scratch"), () => {});
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.notReady, []);
  const logs = [];
  await consume(result.artifacts, join(root, "scratch"), line => logs.push(line));
  assert.ok(logs.some(line => line.includes("native sqlite ready: better-sqlite3@12.6.2")));
  assert.ok(logs.some(line => line.includes("imported @kynesyslabs/dacs-node/sqlite")));
  assert.ok(logs.some(line => line === "imported @kynesyslabs/dacs-node"));
  assert.ok(!logs.some(line => line.includes("not imported")));
  const installed = join(root, "scratch/consumer/node_modules", def.name);
  await writeFile(join(installed, "dist/entry2.js"), "import 'better-sqlite3-extra';");
  await assert.rejects(consumeImports(join(root, "scratch/consumer"), result.artifacts), /better-sqlite3-extra/);
}));

test("the allowed native dependency must have an exact version pin", async () => {
  await assert.rejects(consume([{ manifest: { ...manifest(packages[1]), optionalDependencies: { "better-sqlite3": "^12.6.2" } } }], "/unused"), /native dependency must use an exact version/);
});

// Recheck public imports after mutating the installed consumer.
async function consumeImports(...args) {
  return (await import("../../scripts/release-checks.mjs")).consumeImports(...args, () => {});
}

test("public imports accept a symlinked scratch root and reject exports escaping node_modules", { timeout: 120_000 }, () => fixture(async root => {
  await sourceTree(root);
  const scratch = join(root, "scratch");
  const result = await prepare(root, scratch, () => {});
  const alias = join(root, "alias"); await symlink(scratch, alias);
  await consume(result.artifacts, alias, () => {});
  const dir = join(scratch, "consumer/node_modules", core.name);
  await symlink(join(root, "outside.mjs"), join(dir, "dist/outside.js"));
  await writeFile(join(root, "outside.mjs"), "export const outside = true;");
  const p = result.artifacts[0].manifest;
  await writeFile(join(dir, "package.json"), JSON.stringify({ ...p, exports: { ...p.exports, ".": "./dist/outside.js" } }));
  await assert.rejects(consumeImports(join(alias, "consumer"), result.artifacts), /export resolves outside consumer/);
}));

const execute = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

test("archive file lists must agree with npm pack metadata", { timeout: 120_000 }, () => fixture(async root => {
  await sourceTree(root);
  const result = await prepare(root, join(root, "scratch"), () => {}, (command, args, cwd) => {
    const output = execute(command, args, cwd);
    if (command !== "npm" || args[0] !== "pack") return output;
    const pack = JSON.parse(output); pack[0].files.pop(); return JSON.stringify(pack);
  });
  assert.equal(result.artifacts.length, 0);
  assert.equal(result.errors.length, 5);
  assert.ok(result.errors.every(e => e.includes("archive members disagree")));
}));

test("a damaged packed manifest does not poison the following extraction directory", { timeout: 120_000 }, () => fixture(async root => {
  await sourceTree(root);
  const result = await prepare(root, join(root, "scratch"), () => {}, (command, args, cwd) => {
    const output = execute(command, args, cwd);
    if (command === "tar" && args[0] === "-xzf" && args[1].endsWith("kynesyslabs-dacs-0.1.0-alpha.0.tgz")) {
      execFileSync(process.execPath, ["-e", "const fs=require('fs');const p=JSON.parse(fs.readFileSync(process.argv[1]));p.name='damaged';fs.writeFileSync(process.argv[1],JSON.stringify(p));", join(args[3], "package/package.json")]);
    }
    return output;
  });
  assert.equal(result.errors.length, 1, result.errors.join("\n"));
  assert.equal(result.artifacts.length, 4);
}));

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

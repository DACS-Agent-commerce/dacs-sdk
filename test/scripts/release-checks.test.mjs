import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, cp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  packages, plannedVersion, validateManifest, validateFiles, publicEntries,
  validateLock, checkInstalled, prepare, consume, dryRun, expectedNode20Rejection, release, checkGenerator, validateArtifactSet,
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

test("only declared Node 22 surfaces may reject node:sqlite on Node 20", () => {
  const error = { code: "ERR_UNKNOWN_BUILTIN_MODULE", message: "No such built-in module: node:sqlite" };
  const p = { name: packages[3].name, engines: { node: ">=22.13.0" } };
  assert.equal(expectedNode20Rejection(p, ".", error, "20.19.0"), true);
  assert.equal(expectedNode20Rejection(p, ".", error, "22.21.1"), false);
  assert.equal(expectedNode20Rejection({ ...p, name: core.name }, ".", error, "20.19.0"), false);
  assert.equal(expectedNode20Rejection({ ...p, name: packages[2].name }, ".", error, "20.19.0"), false);
  assert.equal(expectedNode20Rejection({ ...p, name: packages[2].name }, "./durable-journal", error, "20.19.0"), true);
  for (const message of ["No such built-in module: node:sqlite-extra", "No such built-in module: node:sqlite/extra", "other failure involving node:sqlite"]) {
    assert.equal(expectedNode20Rejection(p, ".", { ...error, message }, "20.19.0"), false);
  }
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

async function sourceTree(root, version = "0.1.0-alpha.0", native = false) {
  for (const definition of packages) {
    const dir = join(root, definition.directory); const p = { ...manifest(definition), version };
    await mkdir(join(dir, "dist"), { recursive: true });
    p.scripts = { clean: 'node -e "require(\'fs\').rmSync(\'dist\',{recursive:true,force:true})"', build: "node build.mjs" };
    p.files = ["dist"];
    if (definition !== core) p.peerDependencies = { [core.name]: p.version };
    const count = Object.keys(p.exports).length;
    const direct = definition.directory.match(/dacs-(client|seller)$/);
    const output = direct ? "src" : "dist";
    p.files = [output];
    let build = `import fs from 'node:fs';fs.mkdirSync('${output}',{recursive:true});for(let i=0;i<${count};i++){fs.writeFileSync('${output}/entry'+i+'.${direct ? "mjs" : "js"}','export const ready = true;');${direct ? "" : "fs.writeFileSync('dist/entry'+i+'.d.ts','export declare const ready: boolean;');"}}`;
    if (definition.name === "create-dacs-agent") {
      const generator = `import fs from 'node:fs/promises';
        export const CREATE_DACS_AGENT_VERSION = ${JSON.stringify(version)};
        export async function createDacsAgentProject({targetDirectory, mode}) {
          await fs.mkdir(targetDirectory);
          const native = JSON.parse(await fs.readFile(process.cwd() + '/node_modules/@kynesyslabs/dacs-node/package.json', 'utf8')).optionalDependencies?.['better-sqlite3'];
          await fs.writeFile(targetDirectory + '/package.json', JSON.stringify({
            dependencies: {'@kynesyslabs/dacs': CREATE_DACS_AGENT_VERSION, '@kynesyslabs/dacs-node': CREATE_DACS_AGENT_VERSION,
              ...(mode === 'live-demos' && native ? {'better-sqlite3': native} : {})},
            ...(mode === 'live-demos' ? {dacs: {generatorVersion: CREATE_DACS_AGENT_VERSION}} : {})
          }));
        }`;
      build += `fs.writeFileSync('dist/entry0.js', ${JSON.stringify(generator)});`;
    }
    await writeFile(join(dir, "package.json"), JSON.stringify(p));
    await writeFile(join(dir, "build.mjs"), build);
    if (definition.name === "@kynesyslabs/dacs-node") {
      if (native) p.optionalDependencies = { "better-sqlite3": "12.6.2" };
      p.exports["./vectors/dacs-http-envelope-v1.json"] = "./vectors/dacs-http-envelope-v1.json";
      p.files.push("vectors");
      await mkdir(join(dir, "vectors"), { recursive: true });
      await writeFile(join(dir, "vectors/dacs-http-envelope-v1.json"), "{}");
    }
    if (definition.name === "@kynesyslabs/dacs-seller") {
      p.exports["./src/*"] = "./src/*";
      p.exports["./package.json"] = "./package.json";
      delete p.scripts;
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src/entry0.mjs"), "export const ready = true;");
    }
    await writeFile(join(dir, "package.json"), JSON.stringify(p));
  }
}

test("compiled builds, direct-source packs, wildcard/JSON imports and five dry-runs work without a registry", { timeout: 120_000 }, () => fixture(async root => {
  await sourceTree(root, "0.1.0-alpha.0", true); const logs = [];
  const buildPath = join(root, "build.mjs");
  await writeFile(buildPath, (await readFile(buildPath, "utf8")) +
    "if(process.env.npm_config_fetch_retries !== '2' || process.env.npm_config_fetch_timeout !== '20000') throw Error('bounded npm retry policy missing');");
  await writeFile(join(root, "dist/stale.js"), "throw Error('stale output');");
  const result = await prepare(root, join(root, "scratch"), message => logs.push(message));
  assert.equal(result.errors.length, 0, result.errors.join("\n"));
  assert.equal(result.artifacts.length, 5);
  assert.ok(!result.artifacts[0].files.includes("dist/stale.js"), "build must clean stale output before pack");
  await consume(result.artifacts, join(root, "scratch"), message => logs.push(message),
    { execute: nativeFixtureExecutor(result.artifacts) });
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


for (const [name, body] of [
  ["without its completion line", "process.exit(0);"],
  ["after printing its completion line", "console.log('imported @kynesyslabs/dacs'); process.exit(0);"],
]) {
  test(`a public export that exits its importer ${name} is refused even with a zero exit status`, { timeout: 120_000 }, () => fixture(async root => {
    await sourceTree(root);
    const path = join(root, "build.mjs");
    await writeFile(path, (await readFile(path, "utf8")) + `\nfs.appendFileSync('dist/entry0.js', ${JSON.stringify(body)});`);
    const result = await prepare(root, join(root, "scratch"), () => {});
    result.artifacts = result.artifacts.filter(a => a.manifest.name !== "create-dacs-agent");
    await assert.rejects(consume(result.artifacts, join(root, "scratch"), () => {}), /exited before finishing/);
  }));
}

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
  assert.ok(!logs.some(line => line.includes("Release checks passed")));
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

// Keep registry/native ABI qualification explicit; default regressions use local artifacts.
for (const integration of [false, true]) {
test(integration ? "native sqlite integration qualifies the real registry driver" :
  "native sqlite uses its exact pin; root and sqlite entries import with only its build allowed (offline fixture)",
  { timeout: 240_000, skip: integration && process.env.DACS_RELEASE_NATIVE_INTEGRATION !== "1" }, () => fixture(async root => {
  await sourceTree(root);
  const def = packages[1];
  await changeManifest(root, def, { optionalDependencies: { "better-sqlite3": "12.6.2" } });
  const coreManifest = JSON.parse(await readFile(join(root, "package.json")));
  await changeManifest(root, core, { scripts: { ...coreManifest.scripts, postinstall: "node -e \"throw Error('unrelated install script ran')\"" } });
  const path = join(root, def.directory, "build.mjs");
  await writeFile(path, (await readFile(path, "utf8")) + "\nfs.appendFileSync('dist/entry2.js', \"import 'better-sqlite3';\");");
  const result = await prepare(root, join(root, "scratch"), () => {});
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.notReady, []);
  const logs = [];
  await consume(result.artifacts, join(root, "scratch"), line => logs.push(line), {
    outputDirectory: join(root, "receipts"), execute: integration ? undefined : nativeFixtureExecutor(result.artifacts),
  });
  assert.ok(logs.indexOf("imported @kynesyslabs/dacs-node") < logs.findIndex(line => line.includes("native sqlite ready")));
  const beforeNative = logs.slice(0, logs.findIndex(line => line.includes("native sqlite ready")));
  for (const artifact of result.artifacts) for (const entry of publicEntries(artifact.manifest, artifact.files)) {
    if (artifact.manifest.name === def.name && entry.subpath === "./sqlite") continue;
    const spec = artifact.manifest.name + (entry.subpath === "." ? "" : entry.subpath.slice(1));
    assert.ok(beforeNative.includes(`imported ${spec}`), `${spec} must import without the optional driver`);
  }
  const before = JSON.parse(await readFile(join(root, "receipts/without-native/package.json")));
  const after = JSON.parse(await readFile(join(root, "receipts/with-native/package.json")));
  assert.equal(before.dependencies["better-sqlite3"], undefined);
  assert.equal(after.dependencies["better-sqlite3"], "12.6.2");
  assert.ok(logs.some(line => line.includes("native sqlite ready: better-sqlite3@12.6.2")));
  assert.ok(logs.some(line => line.includes("imported @kynesyslabs/dacs-node/sqlite")));
  assert.ok(logs.some(line => line === "imported @kynesyslabs/dacs-node"));
  assert.ok(!logs.some(line => line.includes("not imported")));
  const installed = join(root, "scratch/consumer/node_modules", def.name);
  await writeFile(join(installed, "dist/entry2.js"), "import 'better-sqlite3-extra';");
  await assert.rejects(consumeImports(join(root, "scratch/consumer"), result.artifacts), /better-sqlite3-extra/);
}));

}

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
  // Exercise real offline npm installation with the non-native package subset.
  result.artifacts = result.artifacts.filter(a => a.manifest.name !== "create-dacs-agent");
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

test("a package whose archive filename repeats another's cannot replace an archive already accepted", { timeout: 120_000 }, () => fixture(async root => {
  await sourceTree(root);
  const generator = packages.find(p => p.name === "create-dacs-agent");
  await changeManifest(root, generator, { name: core.name });
  const result = await prepare(root, join(root, "scratch"), () => {});
  assert.ok(result.errors.some(e => e.startsWith("create-dacs-agent: ")), result.errors.join("\n"));
  const accepted = result.artifacts.find(a => a.definition === core);
  assert.ok(accepted);
  assert.deepEqual(execute("tar", ["-tzf", accepted.tarball], root).trim().split("\n").map(path => path.slice(8)).filter(path => path && !path.endsWith("/")).sort(), [...accepted.files].sort());
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

test("packed export exclusions admit public imports while private files remain inaccessible", { timeout: 120_000 }, () => fixture(async root => {
  await sourceTree(root, "0.1.0-alpha.0", true);
  const p = JSON.parse(await readFile(join(root, "package.json")));
  p.exports["./feature/*"] = "./dist/feature/*.js";
  p.exports["./feature/private/*"] = null;
  await writeFile(join(root, "package.json"), JSON.stringify(p));
  await writeFile(join(root, "build.mjs"), (await readFile(join(root, "build.mjs"), "utf8")) +
    "fs.mkdirSync('dist/feature/private',{recursive:true});fs.writeFileSync('dist/feature/public.js','export const ready=true;');fs.writeFileSync('dist/feature/private/hidden.js',\"throw Error('private module imported');\");");
  const scratch = join(root, "scratch"); const result = await prepare(root, scratch, () => {});
  assert.deepEqual(result.errors, []);
  await consume(result.artifacts, scratch, () => {}, { execute: nativeFixtureExecutor(result.artifacts) });
  const code = `await import('${core.name}/feature/public');try {await import('${core.name}/feature/private/hidden');throw Error('private exported');}catch(e){if(e.code!=='ERR_PACKAGE_PATH_NOT_EXPORTED')throw e;}`;
  execute(process.execPath, ["--input-type=module", "-e", code], join(scratch, "consumer"));
}));

test("build-time changes to packed versions and internal pins fail preparation", { timeout: 120_000 }, () => fixture(async root => {
  await sourceTree(root);
  const def = packages[4], path = join(root, def.directory, "build.mjs");
  const original = await readFile(path, "utf8");
  for (const [damage, expected] of [[{ version: "9.9.9" }, /packed version changed/],
    [{ peerDependencies: { [core.name]: "^0.1.0-alpha.0" } }, /internal dependency must use exact release version/]]) {
    await changeManifest(root, def, { version: "0.1.0-alpha.0", peerDependencies: { [core.name]: "0.1.0-alpha.0" } });
    await writeFile(path, original + `const p=JSON.parse(fs.readFileSync('package.json'));Object.assign(p,${JSON.stringify(damage)});fs.writeFileSync('package.json',JSON.stringify(p));`);
    const result = await prepare(root, await mkdtemp(join(root, "scratch-")), () => {});
    assert.ok(result.errors.some(e => expected.test(e)), result.errors.join("\n"));
    assert.equal(result.artifacts.length, 4);
  }
}));

test("strict release requires the planned version and admits a coherent complete set", { timeout: 120_000 }, () => fixture(async root => {
  await sourceTree(root);
  await assert.rejects(release("check", { root, log: () => {} }), /planned release version/);
  await sourceTree(root, plannedVersion, true);
  const result = await release("check", { root, log: () => {}, execute: nativeFixtureExecutor() });
  assert.equal(result.ready, true);
  assert.deepEqual(result.errors, []);
  const receipts = join(root, "package-artifacts/five-package", `node-${process.versions.node}`);
  const runs = await readdir(receipts);
  assert.equal(runs.length, 2, "each check must retain a separate run without stale receipts");
  const statuses = await Promise.all(runs.map(async run => JSON.parse(await readFile(join(receipts, run, "result.json")))));
  assert.deepEqual(statuses.map(s => s.status).sort(), ["blocked", "passed"]);
  assert.ok(statuses.find(s => s.status === "passed").artifacts.every(a => a.version === plannedVersion));
  const passedRun = runs[statuses.findIndex(s => s.status === "passed")];
  const receipt = JSON.parse(await readFile(join(receipts, passedRun, "without-native/receipt.json")));
  assert.deepEqual(receipt.artifacts.map(a => a.name), packages.map(p => p.name), "success must consume all five artifacts");
}));

test("not-ready manifests still build, pack and enforce the file policy", { timeout: 120_000 }, () => fixture(async root => {
  await sourceTree(root);
  await changeManifest(root, packages[1], { devDependencies: { [core.name]: "file:../.." } });
  await changeManifest(root, packages[2], { private: true });
  const result = await prepare(root, join(root, "scratch"), () => {});
  assert.equal(result.artifacts.length, 5);
  assert.deepEqual(result.errors, []);
  assert.equal(result.notReady.length, 2);
  await changeManifest(root, packages[1], { devDependencies: { [core.name]: "file:../..", extra: "github:org/extra" } });
  const masked = await prepare(root, join(root, "masked"), () => {});
  assert.ok(masked.errors.some(e => e.includes("github:org/extra")), "an expected blocker must not hide a second defect");
  const path = join(root, packages[1].directory, "build.mjs");
  await writeFile(path, "throw Error('blocked package build still runs');");
  const broken = await prepare(root, join(root, "broken"), () => {});
  assert.ok(broken.errors.some(e => e.includes("blocked package build still runs")));
  await changeManifest(root, core, { dependencies: { external: "github:org/external" }, files: ["dist", "scripts"] });
  await mkdir(join(root, "scripts")); await writeFile(join(root, "scripts/leak.mjs"), "export {};");
  const invalid = await prepare(root, join(root, "invalid"), () => {});
  assert.ok(invalid.errors.some(e => e.includes("non-registry")));
  assert.ok(invalid.errors.some(e => e.includes("outside allow-list: scripts/leak.mjs")));
}));

test("consumer retains locks, resolutions, artifact hashes and toolchain after scratch removal", { timeout: 120_000 }, () => fixture(async root => {
  await sourceTree(root, "0.1.0-alpha.0", true); const scratch = join(root, "scratch"), outputDirectory = join(root, "receipt");
  const result = await prepare(root, scratch, () => {});
  const expectedHash = createHash("sha512").update(await readFile(result.artifacts[0].tarball)).digest("hex");
  await consume(result.artifacts, scratch, () => {}, { outputDirectory, execute: nativeFixtureExecutor(result.artifacts) });
  await rm(scratch, { recursive: true });
  const receipt = JSON.parse(await readFile(join(outputDirectory, "without-native/receipt.json")));
  const lock = JSON.parse(await readFile(join(outputDirectory, "without-native/package-lock.json")));
  assert.equal(receipt.node, process.version);
  assert.match(receipt.npm, /^\d+\.\d+\.\d+/);
  assert.equal(receipt.artifacts.length, 5);
  assert.equal(receipt.artifacts.find(a => a.name === core.name).sha512, expectedHash);
  assert.ok(receipt.artifacts.every(a => /^[a-f0-9]{128}$/.test(a.sha512)));
  assert.deepEqual(receipt.resolved, lock.packages);
  assert.equal(lock.packages[`node_modules/${core.name}`].version, "0.1.0-alpha.0");
}));

test("packed generator rejects stale exported version, offline pins, live pins and metadata", { timeout: 120_000 }, () => fixture(async root => {
  await sourceTree(root, "0.1.0-alpha.0", true); const scratch = join(root, "scratch");
  const result = await prepare(root, scratch, () => {});
  await consume(result.artifacts, scratch, () => {}, { execute: nativeFixtureExecutor(result.artifacts) });
  const consumer = join(scratch, "consumer"), entry = join(consumer, "node_modules/create-dacs-agent/dist/entry0.js");
  const original = await readFile(entry, "utf8");
  for (const [source, pattern] of [
    [original.replace('"0.1.0-alpha.0"', '"9.9.9"'), /generator version mismatch/],
    [original.replace("dependencies: {'@kynesyslabs/dacs': CREATE_DACS_AGENT_VERSION", "dependencies: {'@kynesyslabs/dacs': '9.9.9'"), /generated dependency mismatch: offline/],
    [original.replace("dependencies: {'@kynesyslabs/dacs': CREATE_DACS_AGENT_VERSION", "dependencies: {'@kynesyslabs/dacs': mode === 'live-demos' ? '9.9.9' : CREATE_DACS_AGENT_VERSION"), /generated dependency mismatch: live-demos/],
    [original.replace("generatorVersion: CREATE_DACS_AGENT_VERSION", "generatorVersion: '9.9.9'"), /generated metadata version mismatch/],
  ]) {
    await rm(join(consumer, "generated-offline"), { recursive: true, force: true });
    await rm(join(consumer, "generated-live-demos"), { recursive: true, force: true });
    await writeFile(entry, source);
    await assert.rejects(checkGenerator(consumer, result.artifacts, () => {}), pattern);
  }
}));

test("node root must import with its optional native driver absent", { timeout: 120_000 }, () => fixture(async root => {
  await sourceTree(root); const def = packages[1];
  await changeManifest(root, def, { optionalDependencies: { "better-sqlite3": "12.6.2" } });
  const path = join(root, def.directory, "build.mjs");
  await writeFile(path, (await readFile(path, "utf8")) + "fs.appendFileSync('dist/entry0.js',\"import 'better-sqlite3';\");");
  const scratch = join(root, "scratch"), result = await prepare(root, scratch, () => {}), logs = [];
  await assert.rejects(consume(result.artifacts, scratch, line => logs.push(line),
    { execute: nativeFixtureExecutor(result.artifacts) }), /better-sqlite3/);
  assert.ok(!logs.some(line => line.includes("native sqlite ready")));
}));

test("public packages cannot import the optional driver at module load", { timeout: 120_000 }, () => fixture(async root => {
  await sourceTree(root);
  for (const definition of [core, packages[1]]) {
    await changeManifest(root, definition, { optionalDependencies: { "better-sqlite3": "12.6.2" } });
  }
  const path = join(root, "build.mjs");
  await writeFile(path, (await readFile(path, "utf8")) + "fs.appendFileSync('dist/entry0.js',\"import 'better-sqlite3';\");");
  const scratch = join(root, "scratch"), result = await prepare(root, scratch, () => {}), logs = [];
  assert.deepEqual(result.errors, []);
  await assert.rejects(consume(result.artifacts, scratch, line => logs.push(line),
    { execute: nativeFixtureExecutor(result.artifacts) }), error =>
      error.message.includes(`${core.name}:`) && error.message.includes("better-sqlite3"));
  assert.ok(!logs.some(line => line.includes("native sqlite ready")));
}));


test("the held private snapshot's preparation inventory cannot admit a new packed path", { timeout: 120_000 }, () => fixture(async root => {
  await sourceTree(root);
  const dir = join(root, packages[2].directory);
  await rm(dir, { recursive: true });
  await cp(new URL("../../packages/dacs-client/", import.meta.url), dir, { recursive: true });
  const baseline = await prepare(root, join(root, "baseline"), () => {});
  assert.deepEqual(baseline.errors, []);
  assert.equal(baseline.artifacts.length, 5);
  const identityReason = `${packages[2].name}: release identity or publish policy is invalid`;
  assert.ok(baseline.notReady.includes(identityReason), "held snapshot diagnostics name the package exactly once");
  const heldManifest = await readFile(join(dir, "package.json"));
  await changeManifest(root, packages[2], { license: "UNLICENSED" });
  const damaged = await prepare(root, join(root, "damaged-manifest"), () => {});
  assert.ok(damaged.errors.some(e => e.includes("identity or publish policy")), "only the exact held manifest gets baseline exceptions");
  assert.ok(damaged.errors.includes(identityReason), "unexpected source and packed identity defects keep one package prefix");
  await writeFile(join(dir, "package.json"), heldManifest);
  await writeFile(join(dir, "unreviewed.mjs"), "export const extra = true;");
  const changed = await prepare(root, join(root, "changed"), () => {});
  assert.ok(changed.errors.some(e => e.includes("outside allow-list")));
  assert.equal(changed.artifacts.length, 4);
}));


test("generator admission preserves the cause when a required packed dependency is missing", async () => {
  await assert.rejects(checkGenerator("/unused", [{ manifest: manifest(packages[4]) }], () => {}), /missing packed generator dependency: @kynesyslabs\/dacs/);
});


test("a build-time private blocker cannot approve a four-package consumer", { timeout: 120_000 }, () => fixture(async root => {
  await sourceTree(root, plannedVersion);
  const path = join(root, packages[2].directory, "build.mjs");
  await writeFile(path, (await readFile(path, "utf8")) +
    "const p=JSON.parse(fs.readFileSync('package.json'));p.private=true;fs.writeFileSync('package.json',JSON.stringify(p));");
  const logs = [], outputDirectory = join(root, "results");
  await assert.rejects(release("check", { root, outputDirectory, log: line => logs.push(line) }), /private package/);
  assert.ok(!logs.some(line => line.includes("Release checks passed")));
  const [run] = await readdir(outputDirectory);
  const result = JSON.parse(await readFile(join(outputDirectory, run, "result.json")));
  assert.equal(result.status, "blocked");
  assert.ok(result.notReady.some(e => e.includes("private package")));
  assert.ok(result.errors.some(e => e.includes("all five")));
  const receipt = JSON.parse(await readFile(join(outputDirectory, run, "without-native/receipt.json")));
  assert.deepEqual(receipt.artifacts.map(a => a.name), packages.filter(p => p !== packages[2]).map(p => p.name));
}));

test("known blockers do not mask independent source or packed manifest defects", { timeout: 240_000 }, () => fixture(async root => {
  for (const packed of [false, true]) {
    for (const [damage, expected] of [
      [{ license: "UNLICENSED" }, /identity or publish policy/],
      [{ version: "9.9.9" }, /release versions differ|packed version changed/],
      [{ version: "not-semver" }, /invalid package version/],
      [{ exports: {} }, /missing public export/],
      [{ peerDependencies: { [core.name]: "^0.1.0-alpha.0" } }, /internal dependency must use exact release version/],
    ]) {
      await sourceTree(root);
      for (const [definition, blocker] of [
        [packages[1], { devDependencies: { [core.name]: "file:../.." } }],
        [packages[2], { private: true }],
      ]) {
        await changeManifest(root, definition, blocker);
        if (packed) {
          const path = join(root, definition.directory, "build.mjs");
          await writeFile(path, (await readFile(path, "utf8")) +
            `const p=JSON.parse(fs.readFileSync('package.json'));Object.assign(p,${JSON.stringify(damage)});fs.writeFileSync('package.json',JSON.stringify(p));`);
        } else await changeManifest(root, definition, damage);
      }
      const result = await prepare(root, await mkdtemp(join(root, "manifest-case-")), () => {});
      for (const definition of [packages[1], packages[2]]) {
        assert.ok(result.errors.some(e => e.includes(definition.name) && expected.test(e)),
          `${packed ? "packed" : "source"} ${definition.name}: ${JSON.stringify(damage)}: ${result.errors.join("\n")}`);
        assert.ok(!result.artifacts.some(a => a.manifest.name === definition.name && a.releasable));
      }
    }
  }
}));

test("a known development link cannot excuse a different dependency with the same spec", { timeout: 120_000 }, () => fixture(async root => {
  await sourceTree(root);
  await changeManifest(root, packages[1], { devDependencies: { other: "file:../.." } });
  const result = await prepare(root, join(root, "scratch"), () => {});
  assert.ok(result.errors.some(e => e.includes("non-registry") && e.includes("other")));
}));


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

// Reify only local fixture archives; never ask npm to resolve optional registry metadata.
function nativeFixtureExecutor(artifacts) {
  const nativeVersion = "12.6.2";
  return (command, args, cwd, env) => {
    if (command !== "npm") return execute(command, args, cwd);
    if (args[0] === "rebuild") {
      assert.deepEqual(args, ["rebuild", `better-sqlite3@${nativeVersion}`, "--ignore-scripts=false", "--foreground-scripts", "--no-audit", "--no-fund"]);
      assert.equal(env.npm_config_jobs, "2");
      assert.equal(env.npm_config_devdir, join(cwd, "../node-gyp"));
      assert.equal(JSON.parse(readFileSync(join(cwd, "node_modules/better-sqlite3/package.json"))).version, nativeVersion);
      return "fixture native rebuild";
    }
    assert.equal(args[0], "install");
    assert.deepEqual(args.slice(1, 5), ["--ignore-scripts", "--no-audit", "--no-fund", "--omit=optional"]);
    artifacts ??= args.slice(5).map(tarball => ({ tarball,
      manifest: JSON.parse(execFileSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8" })),
    }));
    const p = JSON.parse(readFileSync(join(cwd, "package.json")));
    const native = args.includes(`better-sqlite3@${nativeVersion}`);
    const lock = { lockfileVersion: 3, packages: { "": p } };
    p.dependencies ??= {};
    for (const artifact of artifacts) {
      const dir = join(cwd, "node_modules", artifact.manifest.name);
      mkdirSync(dir, { recursive: true });
      execFileSync("tar", ["-xzf", artifact.tarball, "-C", dir, "--strip-components=1"]);
      p.dependencies[artifact.manifest.name] = `file:${artifact.tarball}`;
      lock.packages[`node_modules/${artifact.manifest.name}`] = {
        version: artifact.manifest.version, resolved: `file:${artifact.tarball}`,
      };
    }
    if (native) {
      assert.deepEqual(args.slice(5), ["--save-exact", `better-sqlite3@${nativeVersion}`]);
      const dir = join(cwd, "node_modules/better-sqlite3"); mkdirSync(dir);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "better-sqlite3", version: nativeVersion, main: "index.cjs" }));
      writeFileSync(join(dir, "index.cjs"), "module.exports = class { prepare() { return { get: () => ({ready: 1}) }; } close() {} };\n");
      p.dependencies["better-sqlite3"] = nativeVersion;
      lock.packages["node_modules/better-sqlite3"] = { version: nativeVersion,
        resolved: `https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-${nativeVersion}.tgz` };
    } else assert.deepEqual(args.slice(5), artifacts.map(a => a.tarball));
    writeFileSync(join(cwd, "package.json"), JSON.stringify(p));
    writeFileSync(join(cwd, "package-lock.json"), JSON.stringify(lock));
    return "";
  };
}

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

async function generatorConsumer(root, damage = "") {
  const artifacts = [core, packages[1], packages[4]].map(definition => ({ manifest: manifest(definition) }));
  artifacts[1].manifest.optionalDependencies = { "better-sqlite3": "12.6.2" };
  const directory = join(root, "node_modules", packages[4].name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ ...manifest(packages[4]), exports: "./index.js" }));
  await writeFile(join(directory, "index.js"), `
    import { mkdir, writeFile } from 'node:fs/promises';
    export const CREATE_DACS_AGENT_VERSION = '0.1.0-alpha.0';
    export async function createDacsAgentProject({targetDirectory, mode}) {
      const p = {
        dependencies: {'@kynesyslabs/dacs': CREATE_DACS_AGENT_VERSION, '@kynesyslabs/dacs-node': CREATE_DACS_AGENT_VERSION,
          ...(mode === 'live-demos' ? {'better-sqlite3': '12.6.2'} : {})},
        ...(mode === 'live-demos' ? {dacs: {generatorVersion: CREATE_DACS_AGENT_VERSION}} : {})
      };
      ${damage}
      await mkdir(targetDirectory, {recursive: true});
      await writeFile(targetDirectory + '/package.json', JSON.stringify(p));
    }
  `);
  return artifacts;
}

test("generated dependency maps obey registry policy in every section and mode", () => fixture(async root => {
  const valid = await generatorConsumer(root);
  await assert.doesNotReject(checkGenerator(root, valid, () => {}));
  for (const mode of ["offline", "live-demos"]) {
    for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "overrides", "resolutions"]) {
      for (const spec of ["file:/tmp/owner-source", `npm:${core.name}@0.1.0-alpha.0`]) {
        const artifacts = await generatorConsumer(root,
          `if (mode === ${JSON.stringify(mode)}) (p[${JSON.stringify(section)}] ??= {}).other = ${JSON.stringify(spec)};`);
        await assert.rejects(checkGenerator(root, artifacts, () => {}), /non-registry dependency/);
      }
    }
  }
}));

test("a generator that exits with status zero before validating every mode is refused", () => fixture(async root => {
  const artifacts = await generatorConsumer(root, `if (mode === 'live-demos') {
    await mkdir(targetDirectory, {recursive: true});
    await writeFile(targetDirectory + '/package.json', JSON.stringify({dependencies: {'better-sqlite3': '12.6.2'}}));
    process.exit(0);
  }`);
  await assert.rejects(checkGenerator(root, artifacts, () => {}), /exited before finishing/);
}));

for (const spec of [undefined, "9.9.9"]) {
  test(`live generated native pin rejects ${spec === undefined ? "an omitted dependency" : "a version differing from the Node artifact"}`, () => fixture(async root => {
    const damage = spec === undefined ? "delete p.dependencies['better-sqlite3'];" :
      `p.dependencies['better-sqlite3'] = ${JSON.stringify(spec)};`;
    const artifacts = await generatorConsumer(root, `if (mode === 'live-demos') { ${damage} }`);
    await assert.rejects(checkGenerator(root, artifacts, () => {}), /generated native dependency mismatch/);
  }));
}

test("live generated driver requires the exact qualified optional pin", () => fixture(async root => {
  const artifacts = await generatorConsumer(root);
  delete artifacts[1].manifest.optionalDependencies;
  await assert.rejects(checkGenerator(root, artifacts, () => {}), /generated native dependency mismatch/);
  artifacts[1].manifest.optionalDependencies = { "better-sqlite3": "^12.6.2" };
  await assert.rejects(checkGenerator(root, artifacts, () => {}), /generated native dependency mismatch/);
  artifacts[1].manifest.optionalDependencies["better-sqlite3"] = "11.8.1";
  await generatorConsumer(root, "if (mode === 'live-demos') p.dependencies['better-sqlite3'] = '11.8.1';");
  await assert.doesNotReject(checkGenerator(root, artifacts, () => {}));
}));

test("live generation rejects matching absent Node and generated native pins", () => fixture(async root => {
  const artifacts = await generatorConsumer(root, "delete p.dependencies['better-sqlite3'];");
  delete artifacts[1].manifest.optionalDependencies;
  await assert.rejects(checkGenerator(root, artifacts, () => {}), /generated native dependency mismatch: live-demos better-sqlite3/);
}));

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

test("generated runtime sections reject mismatched internal pins", () => fixture(async root => {
  for (const mode of ["offline", "live-demos"]) {
    for (const section of ["optionalDependencies", "peerDependencies", "dependencies"]) {
      for (const definition of packages) {
        const artifacts = await generatorConsumer(root,
          `if (mode === ${JSON.stringify(mode)}) (p[${JSON.stringify(section)}] ??= {})[${JSON.stringify(definition.name)}] = '^0.1.0-alpha.0';`);
        artifacts.push(...packages.filter(d => !artifacts.some(a => a.manifest.name === d.name)).map(d => ({ manifest: manifest(d) })));
        await assert.rejects(checkGenerator(root, artifacts, () => {}), /generated dependency mismatch/);
      }
      const pins = Object.fromEntries(packages.map(d => [d.name, "0.1.0-alpha.0"]));
      const artifacts = await generatorConsumer(root,
        `if (mode === ${JSON.stringify(mode)}) Object.assign(p[${JSON.stringify(section)}] ??= {}, ${JSON.stringify(pins)});`);
      artifacts.push(...packages.filter(d => !artifacts.some(a => a.manifest.name === d.name)).map(d => ({ manifest: manifest(d) })));
      await assert.doesNotReject(checkGenerator(root, artifacts, () => {}));
    }
  }
}));

test("generated native runtime declarations reject mismatched pins", () => fixture(async root => {
  for (const mode of ["live-demos", "offline"]) {
    for (const section of ["optionalDependencies", "peerDependencies", "dependencies"]) {
      for (const spec of ["11.8.1", "^12.6.2"]) {
        const artifacts = await generatorConsumer(root,
          `if (mode === ${JSON.stringify(mode)}) (p[${JSON.stringify(section)}] ??= {})['better-sqlite3'] = ${JSON.stringify(spec)};`);
        await assert.rejects(checkGenerator(root, artifacts, () => {}), /generated native dependency mismatch/);
      }
      const artifacts = await generatorConsumer(root,
        `if (mode === ${JSON.stringify(mode)}) (p[${JSON.stringify(section)}] ??= {})['better-sqlite3'] = '12.6.2';`);
      await assert.doesNotReject(checkGenerator(root, artifacts, () => {}));
    }
  }
}));

test("packed imports use the selected conditional target's JSON attribute", { timeout: 120_000 }, () => fixture(async root => {
  await sourceTree(root, plannedVersion, true);
  const definition = packages[2], path = join(root, definition.directory, "package.json");
  const p = JSON.parse(await readFile(path, "utf8"));
  p.exports["."] = { node: "./src/entry0.mjs", default: "./package.json" };
  p.exports["./metadata"] = { node: "./package.json", default: "./src/entry0.mjs" };
  p.exports["./fallback"] = { browser: "./package.json", import: "./src/entry0.mjs" };
  await writeFile(path, JSON.stringify(p));
  const logs = [], result = await release("check", { root, log: line => logs.push(line), execute: nativeFixtureExecutor() });
  assert.equal(result.ready, true);
  for (const suffix of ["", "/metadata", "/fallback"]) {
    assert.ok(logs.includes(`imported ${definition.name}${suffix}`));
  }
}));

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

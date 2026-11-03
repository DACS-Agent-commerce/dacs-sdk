import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, cp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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

async function sourceTree(root, version = "0.1.0-alpha.0") {
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
          await fs.writeFile(targetDirectory + '/package.json', JSON.stringify({
            dependencies: {'@kynesyslabs/dacs': CREATE_DACS_AGENT_VERSION, '@kynesyslabs/dacs-node': CREATE_DACS_AGENT_VERSION},
            ...(mode === 'live-demos' ? {dacs: {generatorVersion: CREATE_DACS_AGENT_VERSION}} : {})
          }));
        }`;
      build += `fs.writeFileSync('dist/entry0.js', ${JSON.stringify(generator)});`;
    }
    await writeFile(join(dir, "package.json"), JSON.stringify(p));
    await writeFile(join(dir, "build.mjs"), build);
    if (definition.name === "@kynesyslabs/dacs-node") {
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
  await sourceTree(root); const logs = [];
  const buildPath = join(root, "build.mjs");
  await writeFile(buildPath, (await readFile(buildPath, "utf8")) +
    "if(process.env.npm_config_fetch_retries !== '2' || process.env.npm_config_fetch_timeout !== '20000') throw Error('bounded npm retry policy missing');");
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

test("native sqlite uses its exact pin; root and sqlite entries import with only its build allowed", { timeout: 240_000 }, () => fixture(async root => {
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
  await consume(result.artifacts, join(root, "scratch"), line => logs.push(line), { outputDirectory: join(root, "receipts") });
  assert.ok(logs.indexOf("imported @kynesyslabs/dacs-node") < logs.findIndex(line => line.includes("native sqlite ready")));
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
  await sourceTree(root);
  const p = JSON.parse(await readFile(join(root, "package.json")));
  p.exports["./feature/*"] = "./dist/feature/*.js";
  p.exports["./feature/private/*"] = null;
  await writeFile(join(root, "package.json"), JSON.stringify(p));
  await writeFile(join(root, "build.mjs"), (await readFile(join(root, "build.mjs"), "utf8")) +
    "fs.mkdirSync('dist/feature/private',{recursive:true});fs.writeFileSync('dist/feature/public.js','export const ready=true;');fs.writeFileSync('dist/feature/private/hidden.js',\"throw Error('private module imported');\");");
  const scratch = join(root, "scratch"); const result = await prepare(root, scratch, () => {});
  assert.deepEqual(result.errors, []);
  await consume(result.artifacts, scratch, () => {});
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
  await sourceTree(root, plannedVersion);
  const result = await release("check", { root, log: () => {} });
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
  await sourceTree(root); const scratch = join(root, "scratch"), outputDirectory = join(root, "receipt");
  const result = await prepare(root, scratch, () => {});
  const expectedHash = createHash("sha512").update(await readFile(result.artifacts[0].tarball)).digest("hex");
  await consume(result.artifacts, scratch, () => {}, { outputDirectory });
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
  await sourceTree(root); const scratch = join(root, "scratch");
  const result = await prepare(root, scratch, () => {});
  await consume(result.artifacts, scratch, () => {});
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
  await assert.rejects(consume(result.artifacts, scratch, line => logs.push(line)), /better-sqlite3/);
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

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import npa from "npm-package-arg";
import semver from "semver";
import { validateReleaseIdentity } from "./release-identity.mjs";

const policy = JSON.parse(readFileSync(new URL("./release-policy.json", import.meta.url)));
export const { packages, plannedVersion } = policy;
const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "overrides", "resolutions"];
function registrySpec(value) {
  if (typeof value !== "string") return false;
  try {
    const parsed = npa.resolve("dependency", value);
    const spec = parsed.type === "alias" ? parsed.subSpec : parsed;
    return ["version", "range", "tag"].includes(spec.type) &&
      !(parsed.type === "alias" && packages.some(p => p.name === spec.name));
  } catch { return false; }
}
// Node can load these from an export target; maps, declarations and other files cannot be imported.
const runtimeTarget = /\.(?:[cm]?js|json)$/;
const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fail = message => { throw new Error(message); };
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);

function entryTargets(p) {
  return ["bin", "main", "types"].flatMap(field => {
    if (!Object.hasOwn(p, field)) return [];
    const paths = field === "bin" && record(p[field]) ? Object.values(p[field]) : [p[field]];
    if (paths.some(path => typeof path !== "string" || !path)) fail(`invalid ${field} target`);
    return paths;
  });
}

function exportTargets(value) {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") {
    let decoded;
    try { decoded = decodeURIComponent(value.slice(2)); } catch { fail(`invalid export target: ${value}`); }
    if (!value.startsWith("./") || /[%?#]/.test(value) || decoded.includes("\\") ||
        decoded.split("/").some(segment => /^(\.{1,2}|node_modules)$/i.test(segment))) fail(`invalid export target: ${value}`);
    return [value];
  }
  if (Array.isArray(value) || record(value)) {
    if (Object.hasOwn(value, "module-sync")) fail("unsupported export condition: module-sync");
    if (!Array.isArray(value) && Object.keys(value).some(key => /^\d+$/.test(key))) fail("invalid export condition");
    return Object.values(value).flatMap(exportTargets);
  }
  fail("invalid export target type");
}

function run(command, args, cwd, extraEnv = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/token|auth|password/i.test(key)));
  Object.assign(env, { NO_COLOR: "1", NODE_PATH: "", npm_config_userconfig: "/dev/null",
    npm_config_fetch_timeout: "20000", npm_config_fetch_retries: "2", npm_config_fetch_retry_mintimeout: "1000", npm_config_fetch_retry_maxtimeout: "5000", ...extraEnv });
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${command === process.execPath ? "node public-entry import" : `${command} ${args.join(" ")}`} failed (${result.status})\n${result.stdout}${result.stderr}`);
  return result.stdout + (command === "npm" && args[0] === "publish" ? result.stderr : "");
}

function exportMap(value) {
  if (typeof value === "string" || Array.isArray(value) || value === null) return { ".": value };
  if (value && Object.keys(value).length && Object.keys(value).every(key => !key.startsWith("."))) return { ".": value };
  const map = value ?? {};
  for (const key of Object.keys(map)) validateExportSubpath(key);
  return map;
}

function validateExportSubpath(key) {
  if (key !== "." && (!key.startsWith("./") ||
    /[%?#\\]/.test(key) || key.split("*").length > 2 ||
    key.slice(2).split("/").some(segment => /^(|\.{1,2}|node_modules)$/i.test(segment)))) fail(`invalid export subpath: ${key}`);
}

function importTarget(value) {
  if (typeof value === "string" || value === null) return value;
  if (Array.isArray(value)) {
    for (const child of value) { const target = importTarget(child); if (target) return target; }
    return null;
  }
  for (const [condition, child] of Object.entries(value ?? {})) {
    if (["node", "node-addons", "import", "default"].includes(condition)) {
      const target = importTarget(child);
      if (target !== undefined) return target;
    }
  }
}

function dependencyTargets(value, nested, path = "") {
  if (!record(value)) fail(`malformed dependency map: ${path}`);
  return Object.entries(value).flatMap(([key, child]) => {
    const name = path ? `${path}/${key}` : key;
    if (typeof child === "string") return [[name, child]];
    if (nested && record(child)) return dependencyTargets(child, true, name);
    fail(`malformed dependency value: ${name}`);
  });
}

function collectProblems(checks) {
  const errors = [];
  for (const check of checks) try { check(); } catch (error) { errors.push(...error.message.split("\n")); }
  return errors;
}

function manifestSnapshot(p) {
  const json = JSON.stringify(p, (_, value) => value && typeof value === "object" && !Array.isArray(value) ?
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
  return createHash("sha256").update(json).digest("hex");
}

function validateDependencies(p) {
  const errors = [];
  for (const section of sections) for (let [path, value] of Object.hasOwn(p, section) ?
    dependencyTargets(p[section], ["overrides", "resolutions"].includes(section), section) : []) {
    if (section === "overrides" && value.startsWith("$")) {
      const name = value.slice(1);
      value = p.dependencies?.[name] ?? p.devDependencies?.[name] ?? p.optionalDependencies?.[name];
    }
    if (!registrySpec(value)) errors.push(`non-registry dependency in ${section}: ${value} (${path.slice(section.length + 1)})`);
  }
  if (errors.length) fail(errors.join("\n"));
}

function validateInternalPins(p, version) {
  const errors = [];
  for (const section of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const name of packages.map(d => d.name)) if (Object.hasOwn(p[section] ?? {}, name) && p[section][name] !== version) errors.push(`internal dependency must use exact release version: ${name}`);
  }
  if (errors.length) fail(errors.join("\n"));
}

export function validateArtifactSet(artifacts, planned = false) {
  if (planned) {
    if (artifacts.length !== packages.length || packages.some(definition =>
      artifacts.filter(a => a.manifest.name === definition.name && a.releasable).length !== 1))
      fail("strict release requires all five publicly releasable package identities");
    for (const { manifest } of artifacts) validateManifest(manifest, packages.find(p => p.name === manifest.name));
  }
  const version = planned ? plannedVersion : artifacts[0]?.manifest.version;
  const names = new Set();
  for (const { manifest: p } of artifacts) {
    if (!packages.some(d => d.name === p.name) || names.has(p.name)) fail(`unknown or duplicate release package identity: ${p.name}`);
    names.add(p.name);
    validateReleaseIdentity(p, p.name);
    if (p.version !== version) fail(`release versions differ: ${p.version} vs ${version}`);
    validateDependencies(p);
    validateInternalPins(p, version);
  }
}

function manifestProblems(p, definition) {
  return collectProblems([
    () => validateDependencies(p),
    () => Object.values(exportMap(p.exports)).flatMap(exportTargets),
    () => entryTargets(p),
    () => { if (Object.hasOwn(p, "private") && p.private !== false) fail("private package is not releasable"); },
    () => validateReleaseIdentity(p, definition.name),
    () => {
      const version = typeof p.version === "string" && semver.parse(p.version);
      if (!version || version.version + (version.build.length ? `+${version.build.join(".")}` : "") !== p.version) fail("invalid package version");
    },
    ...definition.requiredExports.map(key => () => {
      const value = exportMap(p.exports)[key];
      if (!value) fail(`missing public export ${key}`);
      const target = importTarget(value);
      if (!target || !runtimeTarget.test(target)) fail(`runtime target required for public export ${key}`);
    }),
  ]);
}

export function validateManifest(p, definition) {
  const errors = manifestProblems(p, definition);
  if (errors.length) fail(errors.join("\n"));
}

function pattern(glob) {
  // Only * and **/ are supported; everything else is a literal path character.
  return new RegExp("^" + glob.split(/(\*\*\/|\*)/).map(part =>
    part === "**/" ? "(?:.*/)?" : part === "*" ? "[^/]*" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("") + "$");
}

export function publicEntries(p, files) {
  const map = exportMap(p.exports), entries = new Map();
  const keys = Object.keys(map);
  if (keys.some(key => !key.startsWith("."))) fail("unsupported mixed export map");
  const matchKey = (key, subpath) => {
    if (!key.includes("*")) return key === subpath;
    const [prefix, suffix] = key.split("*");
    return subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length > prefix.length + suffix.length;
  };
  const effectiveKey = subpath => keys.includes(subpath) ? subpath : keys.filter(key => key.includes("*") && matchKey(key, subpath))
    .sort((a, b) => b.indexOf("*") - a.indexOf("*") || b.length - a.length)[0];
  for (const [key, value] of Object.entries(map)) {
    if (value === null) continue;
    const paths = exportTargets(value);
    if (!paths.length) fail(`missing export target ${key}`);
    const captures = new Set();
    if (key.includes("*")) {
      if (key.split("*").length !== 2) fail(`unsupported export pattern ${key}`);
      for (const target of paths.filter(t => t.includes("*"))) {
        const matcher = new RegExp("^" + target.slice(2).split("*").map((part, i) =>
          (i === 0 ? "" : i === 1 ? "(.+)" : "\\1") + escapePattern(part)).join("") + "$");
        for (const file of files) { const match = matcher.exec(file); if (match) captures.add(match[1]); }
      }
      if (!captures.size) fail(`export ${key} has no packed matches`);
    } else captures.add("");
    for (const capture of captures) {
      const subpath = key.replace("*", () => capture);
      if (effectiveKey(subpath) !== key) continue;
      validateExportSubpath(subpath);
      // Node substitutes the capture only for pattern keys; elsewhere a star is a literal filename character.
      const concrete = key.includes("*") ? paths.flatMap(target => exportTargets(target.replaceAll("*", () => capture))) : paths;
      for (const target of concrete) if (!files.includes(target.slice(2))) fail(`missing packed target: ${target} (${subpath})`);
      entries.set(subpath, { subpath, json: concrete.some(t => t.endsWith(".json")) });
    }
  }
  return [...entries.values()];
}

export function validateFiles(definition, p, files) {
  for (const file of files) {
    if (isAbsolute(file) || file.split("/").some(s => s === ".." || s === ".") || file.includes("\\")) fail(`invalid packed path: ${file}`);
    if (!definition.allow.some(glob => pattern(glob).test(file))) fail(`outside allow-list: ${file}`);
  }
  const literalExportTargets = Object.entries(exportMap(p.exports)).flatMap(([key, value]) =>
    exportTargets(value).filter(target => !key.includes("*") || !target.includes("*")));
  const required = ["./package.json", ...literalExportTargets, ...entryTargets(p)];
  for (const target of required) {
    const path = target.startsWith("./") ? target.slice(2) : target;
    if (path.split("/").some(s => s === ".." || s === ".") || isAbsolute(path) || path.includes("\\")) fail(`invalid export target: ${target}`);
    // Pattern-key targets containing a star are checked per concrete capture by publicEntries below.
    if (!files.includes(path)) fail(`missing packed target: ${target}`);
  }
  publicEntries(p, files);
}

export function validateLock(lock, artifacts, consumer = ".", omitOptional = false) {
  if (!record(lock?.packages)) fail("lock requires a packages map");
  const allowed = new Map(artifacts.map(({ name, tarball }) => [name, resolve(tarball)]));
  const installed = new Set();
  for (const [name, value] of Object.entries(lock.packages)) {
    if (!record(value)) fail(`invalid lock entry: ${name}`);
    const resolution = typeof value.resolved === "string" ? value.resolved : "";
    // npm does not read a query, fragment or escape in a file path the way a path resolver does.
    if (resolution.startsWith("file:") && /[?#%]/.test(resolution)) fail(`ambiguous local file resolution: ${name}`);
    const path = resolution.startsWith("file:") ? resolve(consumer, resolution.slice(5)) : null;
    const internal = packages.filter(p => value.name === p.name || name === `node_modules/${p.name}` || name.endsWith(`/node_modules/${p.name}`));
    if (internal.some(p => allowed.get(p.name) !== path)) fail(`internal package must resolve to supplied tarball: ${name}`);
    const artifact = internal.length > 0 && internal.every(p => allowed.get(p.name) === path);
    // External install resolutions must be registry tarballs, never links or git/path specs.
    let registry = false;
    try { registry = new URL(resolution).origin === "https://registry.npmjs.org"; } catch {}
    // npm records optional dependency metadata even with --omit=optional.
    // It is not installed; internal identities above must still use our tarballs.
    const omitted = omitOptional && value.optional === true;
    if (artifact && !omitted) for (const p of internal) {
      if (name === `node_modules/${p.name}` || name.endsWith(`/node_modules/${p.name}`)) installed.add(p.name);
    }
    // Bundled children are extracted from a separately qualified parent tarball.
    const parent = name.slice(0, name.lastIndexOf("/node_modules/"));
    const bundled = value.inBundle === true && parent !== name && record(lock.packages[parent]);
    if (value.link || (!omitted && name && !(bundled && !resolution) && !artifact && !registry)) fail(`installed local link or non-registry resolution: ${name}`);
  }
  for (const name of allowed.keys()) if (!installed.has(name)) fail(`missing installed artifact in lock: ${name}`);
}

export function expectedNode20Rejection(p, subpath, error, node = process.versions.node) {
  const restricted = p.name === "@kynesyslabs/dacs-seller" && p.engines?.node === ">=22.13.0" ||
    p.name === "@kynesyslabs/dacs-client" && subpath === "./durable-journal";
  return node.startsWith("20.") && Boolean(restricted) && error.code === "ERR_UNKNOWN_BUILTIN_MODULE" && error.message === "No such built-in module: node:sqlite";
}

// Prefixed to every check run in a child process. Code under test may call
// process.exit(0) or print a completion line early; the child must set
// `finished = true` immediately before its own completion line, or it exits 1.
const CHILD_EXIT_GUARD = `let finished = false;
  process.on('exit', () => { if (!finished) { process.exitCode = 1; process.stderr.write('exited before finishing\\n'); } });`;

function requireCompletion(output, accepted, what) {
  const lines = output.trim().split("\n");
  if (!accepted.includes(lines.at(-1))) fail(`${what} did not finish: a zero exit status without its completion line`);
  return output.trim();
}

export async function checkInstalled(consumer, artifacts) {
  const base = await realpath(consumer);
  for (const { manifest: p } of artifacts) {
    const dir = join(consumer, "node_modules", p.name);
    const actual = await realpath(dir);
    if ((await lstat(dir)).isSymbolicLink() || relative(base, actual).startsWith("..")) fail(`installed package link/outside consumer: ${p.name}`);
    const installed = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    if (installed.name !== p.name || installed.version !== p.version) fail(`installed identity mismatch: ${p.name}`);
    validateManifest(installed, packages.find(d => d.name === p.name));
  }
}

export async function prepare(root, scratch, log = console.log, execute = run) {
  await mkdir(scratch, { recursive: true });
  const artifacts = [], errors = [], notReady = [];
  let version;
  log("Dependency graph: all five nodes below; edges are declared manifest dependencies.");
  for (const definition of packages) {
    const dir = resolve(root, definition.directory);
    log(`${definition.name}: planned ${plannedVersion}`);
    try {
      let source;
      try { source = JSON.parse(await readFile(join(dir, "package.json"), "utf8")); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        notReady.push(`${definition.name}: missing package manifest`);
        if (!definition.preparationBlockers?.includes("missing package manifest")) errors.push(`${definition.name}: missing package manifest`);
        continue;
      }
      log(`  source ${source.version}${source.private ? " (private)" : ""}`);
      for (const section of sections) for (const [name, spec] of Object.entries(source[section] ?? {})) {
        if (packages.some(d => d.name === name)) log(`  ${section}: ${source.name} -> ${name} (${spec})`);
      }
      version ??= source.version;
      const recordProblems = (manifest, problems) => {
        const snapshot = manifestSnapshot(manifest) === definition.preparationManifestSha256;
        for (const message of new Set(problems)) {
          const reason = message.startsWith(`${definition.name}: `) ? message : `${definition.name}: ${message}`;
          if (!notReady.includes(reason)) notReady.push(reason);
          if (!definition.preparationBlockers?.includes(message) &&
              !(snapshot && definition.preparationSnapshotBlockers?.includes(message)) && !errors.includes(reason)) errors.push(reason);
        }
      };
      const sourceProblems = [...manifestProblems(source, definition), ...collectProblems([
        () => { if (source.version !== version) fail(`release versions differ: ${source.version} vs ${version}`); },
        () => validateInternalPins(source, version),
      ])];
      recordProblems(source, sourceProblems);
      if (source.scripts?.build) {
        if (source.scripts.clean) execute("npm", ["run", "clean"], dir);
        log(execute("npm", ["run", "build"], dir));
      } else log("  direct-source package (no compilation)");
      // Each package packs into its own folder so equal archive filenames cannot replace an accepted archive.
      const destination = await mkdtemp(join(scratch, "pack-"));
      const pack = JSON.parse(execute("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination], dir));
      if (pack.length !== 1) fail("expected one packed artifact");
      const tarball = join(destination, pack[0].filename);
      const files = execute("tar", ["-tzf", tarball], root).trim().split("\n").map(path => {
        if (!path.startsWith("package/")) fail(`invalid archive path ${path}`);
        return path.slice(8);
      }).filter(path => path && !path.endsWith("/"));
      // Pin the held private snapshot's existing inventory for preparation only.
      const snapshot = createHash("sha256").update(JSON.stringify([...files].sort())).digest("hex");
      const filePolicy = source.private === true && snapshot === definition.preparationFileListSha256 ?
        { ...definition, allow: [...definition.allow, ...files] } : definition;
      validateFiles(filePolicy, source, files);
      if (JSON.stringify([...files].sort()) !== JSON.stringify(pack[0].files.map(f => f.path).sort())) fail("archive members disagree with npm pack file list");
      const extracted = await mkdtemp(join(scratch, "extract-")); execute("tar", ["-xzf", tarball, "-C", extracted], root);
      const manifest = JSON.parse(await readFile(join(extracted, "package", "package.json"), "utf8"));
      const packedProblems = [...manifestProblems(manifest, definition), ...collectProblems([
        () => { if (manifest.version !== source.version) fail(`packed version changed: ${source.version} -> ${manifest.version}`); },
        () => { if (manifest.version !== version) fail(`release versions differ: ${manifest.version} vs ${version}`); },
        () => validateInternalPins(manifest, version),
      ])];
      recordProblems(manifest, packedProblems);
      validateFiles(filePolicy, manifest, files);
      const releasable = sourceProblems.length === 0 && packedProblems.length === 0;
      // Unexpectedly invalid archives are not supplied to dry-runs or consumers.
      if (errors.some(error => error.startsWith(`${definition.name}:`))) continue;
      artifacts.push({ definition, manifest, tarball, files, releasable });
      log(`  packed ${pack[0].filename}: ${files.length} allowed files`);
    } catch (error) { errors.push(`${definition.name}: ${error.message}`); }
  }
  return { artifacts, errors, notReady };
}

export async function consume(artifacts, scratch, log = console.log, options = {}) {
  const execute = options.execute ?? run;
  if (!artifacts.length) fail("no release artifacts to install");
  validateArtifactSet(artifacts);
  const peers = new Map();
  const nativeVersion = artifacts.find(a => a.manifest.name === "@kynesyslabs/dacs-node")?.manifest.optionalDependencies?.["better-sqlite3"];
  if (nativeVersion && semver.valid(nativeVersion) !== nativeVersion) fail("native dependency must use an exact version: better-sqlite3");
  for (const { manifest: p } of artifacts) for (const section of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, version] of Object.entries(p[section] ?? {})) {
      if (packages.some(d => d.name === name)) {
        if (!artifacts.some(a => a.manifest.name === name)) fail(`missing packed internal dependency: ${name}`);
      } else if (section === "peerDependencies") peers.set(name, version);
    }
  }
  const directory = join(scratch, "consumer"); await mkdir(directory);
  const consumer = await realpath(directory);
  const tarballs = await Promise.all(artifacts.map(a => realpath(a.tarball)));
  const artifactResolutions = artifacts.map((a, i) => ({ name: a.manifest.name, tarball: tarballs[i] }));
  await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "dacs-release-consumer", version: "1.0.0", private: true, type: "module" }));
  execute("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=optional", ...tarballs, ...[...peers].map(([name, version]) => `${name}@${version}`)], consumer);
  await retainConsumerReceipt(consumer, artifacts, options.outputDirectory, "without-native");
  validateLock(JSON.parse(await readFile(join(consumer, "package-lock.json"))), artifactResolutions, consumer, true);
  await checkInstalled(consumer, artifacts);
  if (nativeVersion) {
    try { await lstat(join(consumer, "node_modules/better-sqlite3")); fail("optional native dependency unexpectedly installed"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await consumeImports(consumer, artifacts, log, (artifact, entry) => !(artifact.manifest.name === "@kynesyslabs/dacs-node" && entry.subpath === "./sqlite"));
    execute("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=optional", "--save-exact", `better-sqlite3@${nativeVersion}`], consumer);
    await retainConsumerReceipt(consumer, artifacts, options.outputDirectory, "with-native");
    validateLock(JSON.parse(await readFile(join(consumer, "package-lock.json"))), artifactResolutions, consumer, true);
    await checkInstalled(consumer, artifacts);
    const installed = JSON.parse(await readFile(join(consumer, "node_modules/better-sqlite3/package.json"), "utf8"));
    if (installed.name !== "better-sqlite3" || installed.version !== nativeVersion) fail("native dependency identity mismatch: better-sqlite3");
    // The initial install disables every lifecycle hook. Only this exact native
    // package may build; dependency and release-package hooks remain disabled.
    log(execute("npm", ["rebuild", `better-sqlite3@${nativeVersion}`, "--ignore-scripts=false", "--foreground-scripts", "--no-audit", "--no-fund"], consumer,
      { npm_config_devdir: join(scratch, "node-gyp"), npm_config_jobs: "2" }));
    const nativeReady = `native sqlite ready: better-sqlite3@${nativeVersion}`;
    log(requireCompletion(execute(process.execPath, ["--input-type=module", "-e", `
      import Database from 'better-sqlite3';
      ${CHILD_EXIT_GUARD}
      const db = new Database(':memory:');
      try { if (db.prepare('SELECT 1 AS ready').get().ready !== 1) throw Error('native sqlite smoke failed'); }
      finally { db.close(); }
      finished = true;
      console.log(${JSON.stringify(nativeReady)});`], consumer), [nativeReady], "native sqlite smoke"));
  }
  await consumeImports(consumer, artifacts, log);
  await checkGenerator(consumer, artifacts, log);
}

export async function consumeImports(consumer, artifacts, log = console.log, include = () => true) {
  const base = await realpath(join(consumer, "node_modules"));
  const errors = [];
  for (const artifact of artifacts) for (const entry of publicEntries(artifact.manifest, artifact.files)) {
    if (!include(artifact, entry)) continue;
    const spec = artifact.manifest.name + (entry.subpath === "." ? "" : entry.subpath.slice(1));
    const imported = `imported ${spec}`;
    const rejected = `not imported (expected Node 20 rejection): ${spec} needs node:sqlite`;
    const code = `import {fileURLToPath} from 'node:url';
      ${CHILD_EXIT_GUARD}
      const spec = ${JSON.stringify(spec)};
      const filename = fileURLToPath(import.meta.resolve(spec));
      if (!filename.startsWith(${JSON.stringify(base + "/")})) throw Error('export resolves outside consumer');
      const attributes = filename.endsWith('.json') ? {with:{type:'json'}} : {};
      const expectedNode20Rejection = ${expectedNode20Rejection.toString()};
      const manifest = ${JSON.stringify({ name: artifact.manifest.name, engines: artifact.manifest.engines })};
      try { await import(spec, attributes); finished = true; console.log(${JSON.stringify(imported)}); }
      catch (error) {
        if (expectedNode20Rejection(manifest, ${JSON.stringify(entry.subpath)}, error)) { finished = true; console.log(${JSON.stringify(rejected)}); }
        else throw error;
      }`;
    try { log(requireCompletion(run(process.execPath, ["--input-type=module", "-e", code], consumer), [imported, rejected], spec)); }
    catch (error) { errors.push(`${spec}: ${error.message}`); }
  }
  if (errors.length) fail(errors.join("\n"));
}

export async function retainConsumerReceipt(consumer, artifacts, outputDirectory, phase) {
  if (!outputDirectory) return;
  const lock = await readFile(join(consumer, "package-lock.json"), "utf8");
  const directory = join(outputDirectory, phase);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package-lock.json"), lock);
  await writeFile(join(directory, "package.json"), await readFile(join(consumer, "package.json")));
  const hashes = await Promise.all(artifacts.map(async a => ({ name: a.manifest.name, version: a.manifest.version,
    sha512: createHash("sha512").update(await readFile(a.tarball)).digest("hex") })));
  await writeFile(join(directory, "receipt.json"), JSON.stringify({ node: process.version, npm: run("npm", ["--version"], consumer).trim(),
    platform: process.platform, arch: process.arch, artifacts: hashes,
    resolved: JSON.parse(lock).packages }, null, 2) + "\n");
}

export async function checkGenerator(consumer, artifacts, log = console.log) {
  const generator = artifacts.find(a => a.manifest.name === "create-dacs-agent");
  if (!generator) return;
  for (const name of ["@kynesyslabs/dacs", "@kynesyslabs/dacs-node"]) {
    if (!artifacts.some(a => a.manifest.name === name)) fail(`missing packed generator dependency: ${name}`);
  }
  const versions = Object.fromEntries(artifacts.map(a => [a.manifest.name, a.manifest.version]));
  const created = "generator projects created: offline, live-demos";
  log(requireCompletion(run(process.execPath, ["--input-type=module", "-e", `
    import { readFile } from 'node:fs/promises';
    import { createDacsAgentProject, CREATE_DACS_AGENT_VERSION } from 'create-dacs-agent';
    ${CHILD_EXIT_GUARD}
    const versions = ${JSON.stringify(versions)};
    if (CREATE_DACS_AGENT_VERSION !== versions['create-dacs-agent']) throw Error('generator version mismatch');
    for (const mode of ['offline', 'live-demos']) {
      const targetDirectory = process.cwd() + '/generated-' + mode;
      await createDacsAgentProject({ targetDirectory, mode, role: mode === 'offline' ? 'demo-all' : 'buyer', rails: 'both', install: false, run: false });
      const p = JSON.parse(await readFile(targetDirectory + '/package.json', 'utf8'));
      for (const name of ['@kynesyslabs/dacs', '@kynesyslabs/dacs-node']) {
        if (!versions[name] || p.dependencies?.[name] !== versions[name]) throw Error('generated dependency mismatch: ' + mode + ' ' + name);
      }
      if (mode === 'live-demos' && p.dacs?.generatorVersion !== versions['create-dacs-agent']) throw Error('generated metadata version mismatch');
      console.log('generator project created: ' + mode);
    }
    finished = true;
    console.log(${JSON.stringify(created)});`], consumer), [created], "generator project check"));
  const nativeVersion = artifacts.find(a => a.manifest.name === "@kynesyslabs/dacs-node")?.manifest.optionalDependencies?.["better-sqlite3"];
  for (const mode of ["offline", "live-demos"]) {
    const p = JSON.parse(await readFile(join(consumer, `generated-${mode}`, "package.json"), "utf8"));
    try { validateDependencies(p); }
    catch (error) { fail(`generated ${mode}: ${error.message}`); }
    for (const section of ["dependencies", "peerDependencies", "optionalDependencies"]) for (const [name, spec] of Object.entries(p[section] ?? {})) {
      if (packages.some(d => d.name === name) && spec !== versions[name]) fail(`generated dependency mismatch: ${mode} ${name}`);
      if (name === "better-sqlite3" && spec !== nativeVersion) fail(`generated native dependency mismatch: ${mode} ${name}`);
    }
    if (mode === "live-demos" && (typeof nativeVersion !== "string" || semver.valid(nativeVersion) !== nativeVersion ||
        p.dependencies?.["better-sqlite3"] !== nativeVersion))
      fail(`generated native dependency mismatch: ${mode} better-sqlite3`);
    log(`generator pins verified: ${mode}`);
  }
}

export async function dryRun(artifacts, log = console.log, execute = run) {
  const errors = [];
  for (const artifact of artifacts) {
    log(`${artifact.manifest.name}: npm publish --dry-run (source ${artifact.manifest.version}; planned ${plannedVersion}, not applied)`);
    try {
      log(execute("npm", ["publish", artifact.tarball, "--dry-run", "--ignore-scripts", "--provenance=false", "--access=public", "--tag=next"],
        // Run outside the source package so its .npmrc and lifecycle hooks cannot participate.
        resolve(artifact.tarball, ".."), { npm_config_offline: "true" }));
    } catch (error) { errors.push(`${artifact.manifest.name}: ${error.message}`); }
  }
  if (errors.length) fail(errors.join("\n"));
}

export async function release(mode, options = {}) {
  if (!["check", "dry-run"].includes(mode)) fail(`unknown release mode: ${mode}`);
  const { tmpdir } = await import("node:os");
  const { fileURLToPath } = await import("node:url");
  const root = options.root ?? fileURLToPath(new URL("..", import.meta.url));
  const log = options.log ?? console.log;
  const scratch = await mkdtemp(join(tmpdir(), "dacs-release-"));
  let outputDirectory;
  try {
    if (mode === "check") {
      const outputRoot = options.outputDirectory ?? join(root, "package-artifacts/five-package", `node-${process.versions.node}`);
      await mkdir(outputRoot, { recursive: true });
      outputDirectory = await mkdtemp(join(outputRoot, "run-"));
      await writeFile(join(outputDirectory, "result.json"), JSON.stringify({ status: "preparing", plannedVersion }));
    }
    const result = await prepare(root, scratch, log);
    if (mode === "check") for (const a of result.artifacts) if (a.manifest.version !== plannedVersion)
      result.notReady.push(`${a.manifest.name}: planned release version ${plannedVersion}, got ${a.manifest.version}`);
    for (const reason of result.notReady) log(`not ready: ${reason}`);
    try { if (mode === "dry-run") await dryRun(result.artifacts, log); else await consume(result.artifacts.filter(a => a.releasable), scratch, log, { outputDirectory, execute: options.execute }); }
    catch (error) { result.errors.push(error.message); }
    if (mode === "check") try { validateArtifactSet(result.artifacts, true); }
    catch (error) { result.errors.push(error.message); }
    // Preparation reports source readiness; broken builds/artifacts/dry-runs always fail.
    const blockers = [...result.errors, ...(mode === "check" ? result.notReady : [])];
    const ready = result.notReady.length === 0 && result.errors.length === 0;
    if (outputDirectory) await writeFile(join(outputDirectory, "result.json"), JSON.stringify({
      status: ready ? "passed" : "blocked", plannedVersion, errors: result.errors, notReady: result.notReady,
      artifacts: result.artifacts.map(a => ({ name: a.manifest.name, version: a.manifest.version })),
    }, null, 2) + "\n");
    if (blockers.length) fail(`Release checks blocked:\n${blockers.join("\n")}`);
    log(ready ? `${mode === "check" ? "Release checks" : "Preparation dry-runs"} passed: all five packages` : "Release not ready: preparation report completed; strict release:check remains blocked");
    return { ...result, ready };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const policy = JSON.parse(readFileSync(new URL("./release-policy.json", import.meta.url)));
export const { packages, plannedVersion } = policy;
const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "overrides", "resolutions"];
const local = /^(?:(?:git\+)?file:|workspace:|link:|\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/i;
const targets = value => typeof value === "string" ? [value] :
  value && typeof value === "object" ? Object.values(value).flatMap(targets) : [];
const fail = message => { throw new Error(message); };

function run(command, args, cwd, extraEnv = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/token|auth|password/i.test(key)));
  Object.assign(env, { NO_COLOR: "1", NODE_PATH: "", npm_config_userconfig: "/dev/null",
    npm_config_fetch_timeout: "20000", npm_config_fetch_retries: "0", ...extraEnv });
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${command === process.execPath ? "node public-entry import" : `${command} ${args.join(" ")}`} failed (${result.status})\n${result.stdout}${result.stderr}`);
  return result.stdout + (command === "npm" && args[0] === "publish" ? result.stderr : "");
}

export function validateManifest(p, definition) {
  if (p.private === true) fail("private package is not releasable");
  if (p.name !== definition.name || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(p.version ?? "")) fail("invalid package identity/version");
  for (const key of definition.requiredExports) if (!p.exports?.[key]) fail(`missing public export ${key}`);
  for (const section of sections) for (const value of targets(p[section])) {
    if (local.test(value)) fail(`local dependency in ${section}: ${value}`);
  }
}

function pattern(glob) {
  // Only * and **/ are supported; everything else is a literal path character.
  return new RegExp("^" + glob.split(/(\*\*\/|\*)/).map(part =>
    part === "**/" ? "(?:.*/)?" : part === "*" ? "[^/]*" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("") + "$");
}

export function publicEntries(p, files) {
  const entries = [];
  for (const [key, value] of Object.entries(p.exports ?? {})) {
    if (!key.startsWith(".")) fail(`unsupported export map key ${key}`);
    const paths = targets(value);
    if (!paths.length) fail(`missing export target ${key}`);
    if (key.includes("*")) {
      let count = 0;
      for (const target of paths.filter(t => !t.endsWith(".d.ts"))) {
        const [before, after = ""] = target.slice(2).split("*");
        for (const file of files) if (file.startsWith(before) && file.endsWith(after)) {
          const capture = file.slice(before.length, after.length ? -after.length : undefined);
          if (!capture) continue;
          entries.push({ subpath: key.replace("*", capture), json: file.endsWith(".json") }); count++;
        }
      }
      if (!count) fail(`export ${key} has no packed matches`);
    } else entries.push({ subpath: key, json: paths.some(t => t.endsWith(".json")) });
  }
  return [...new Map(entries.map(e => [e.subpath, e])).values()];
}

export function validateFiles(definition, p, files) {
  for (const file of files) {
    if (isAbsolute(file) || file.split("/").some(s => s === ".." || s === ".") || file.includes("\\")) fail(`invalid packed path: ${file}`);
    if (!definition.allow.some(glob => pattern(glob).test(file))) fail(`outside allow-list: ${file}`);
  }
  const required = ["./package.json", ...targets(p.exports), ...targets(p.bin), ...targets(p.main), ...targets(p.types)];
  for (const target of required) {
    const path = target.startsWith("./") ? target.slice(2) : target;
    if (path.startsWith("../") || isAbsolute(path) || path.includes("\\")) fail(`invalid export target: ${target}`);
    if (!files.some(file => pattern(path).test(file))) fail(`missing packed target: ${target}`);
  }
  publicEntries(p, files);
}

export function validateLock(lock, tarballs, consumer = ".") {
  const allowed = new Set(tarballs.map(path => resolve(path)));
  for (const [name, value] of Object.entries(lock.packages ?? {})) {
    const artifact = value.resolved?.startsWith("file:") && allowed.has(resolve(consumer, value.resolved.slice(5)));
    if (value.link || (local.test(value.resolved ?? "") && !artifact)) fail(`installed local link: ${name}`);
  }
}

export function expectedNode20Rejection(p, subpath, error, node = process.versions.node) {
  const restricted = p.name === "@kynesyslabs/dacs-seller" && p.engines?.node === ">=22.13.0" ||
    p.name === "@kynesyslabs/dacs-client" && subpath === "./durable-journal";
  return node.startsWith("20.") && Boolean(restricted) && error.code === "ERR_UNKNOWN_BUILTIN_MODULE" && error.message.includes("node:sqlite");
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

export async function prepare(root, scratch, log = console.log) {
  await mkdir(scratch, { recursive: true });
  const artifacts = [], errors = [];
  let version;
  log("Dependency graph: all five nodes below; edges are declared manifest dependencies.");
  for (const definition of packages) {
    const dir = resolve(root, definition.directory);
    log(`${definition.name}: planned ${plannedVersion}`);
    try {
      const source = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      log(`  source ${source.version}${source.private ? " (private)" : ""}`);
      for (const section of sections) for (const [name, spec] of Object.entries(source[section] ?? {})) {
        if (packages.some(d => d.name === name)) log(`  ${section}: ${source.name} -> ${name} (${spec})`);
      }
      validateManifest(source, definition);
      version ??= source.version;
      if (source.version !== version) fail(`release versions differ: ${source.version} vs ${version}`);
      for (const section of ["dependencies", "peerDependencies", "optionalDependencies"]) {
        for (const name of packages.map(d => d.name)) if (source[section]?.[name] && source[section][name] !== version) fail(`internal dependency must use exact release version: ${name}`);
      }
      if (source.scripts?.build) {
        if (source.scripts.clean) run("npm", ["run", "clean"], dir);
        log(run("npm", ["run", "build"], dir));
      } else log("  direct-source package (no compilation)");
      const pack = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], dir));
      if (pack.length !== 1) fail("expected one packed artifact");
      const tarball = join(scratch, pack[0].filename);
      const files = run("tar", ["-tzf", tarball], root).trim().split("\n").map(path => {
        if (!path.startsWith("package/")) fail(`invalid archive path ${path}`);
        return path.slice(8);
      }).filter(path => path && !path.endsWith("/"));
      validateFiles(definition, source, files);
      if (JSON.stringify([...files].sort()) !== JSON.stringify(pack[0].files.map(f => f.path).sort())) fail("archive members disagree with npm pack file list");
      const extracted = join(scratch, String(artifacts.length));
      await mkdir(extracted); run("tar", ["-xzf", tarball, "-C", extracted], root);
      const manifest = JSON.parse(await readFile(join(extracted, "package", "package.json"), "utf8"));
      validateManifest(manifest, definition); validateFiles(definition, manifest, files);
      artifacts.push({ definition, manifest, tarball, files });
      log(`  packed ${pack[0].filename}: ${files.length} allowed files`);
    } catch (error) { errors.push(`${definition.name}: ${error.message}`); }
  }
  return { artifacts, errors };
}

export async function consume(artifacts, scratch, log = console.log) {
  if (!artifacts.length) fail("no release artifacts to install");
  const peers = new Map();
  for (const { manifest: p } of artifacts) for (const section of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, version] of Object.entries(p[section] ?? {})) {
      if (packages.some(d => d.name === name)) {
        if (!artifacts.some(a => a.manifest.name === name)) fail(`missing packed internal dependency: ${name}`);
      } else if (section === "peerDependencies") peers.set(name, version);
    }
  }
  const consumer = join(scratch, "consumer"); await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "dacs-release-consumer", version: "1.0.0", private: true, type: "module" }));
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=optional", ...artifacts.map(a => a.tarball), ...[...peers].map(([name, version]) => `${name}@${version}`)], consumer);
  validateLock(JSON.parse(await readFile(join(consumer, "package-lock.json"))), artifacts.map(a => a.tarball), consumer);
  await checkInstalled(consumer, artifacts);
  const errors = [];
  for (const artifact of artifacts) for (const entry of publicEntries(artifact.manifest, artifact.files)) {
    const spec = artifact.manifest.name + (entry.subpath === "." ? "" : entry.subpath.slice(1));
    const code = `import {fileURLToPath} from 'node:url';
      const spec = ${JSON.stringify(spec)};
      if (!fileURLToPath(import.meta.resolve(spec)).startsWith(${JSON.stringify(consumer + "/node_modules/")})) throw Error('export resolves outside consumer');
      const expectedNode20Rejection = ${expectedNode20Rejection.toString()};
      try { await import(spec, ${entry.json ? "{with:{type:'json'}}" : "{}"}); console.log('imported ' + spec); }
      catch (error) { if (expectedNode20Rejection(${JSON.stringify({ name: artifact.manifest.name, engines: artifact.manifest.engines })}, ${JSON.stringify(entry.subpath)}, error)) console.log('expected Node 20 rejection: ' + spec + ' needs node:sqlite'); else throw error; }`;
    try { log(run(process.execPath, ["--input-type=module", "-e", code], consumer).trim()); }
    catch (error) { errors.push(`${spec}: ${error.message}`); }
  }
  if (errors.length) fail(errors.join("\n"));
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

export async function release(mode) {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const scratch = await mkdtemp(join(tmpdir(), "dacs-release-"));
  try {
    const result = await prepare(root, scratch);
    try { if (mode === "dry-run") await dryRun(result.artifacts); else await consume(result.artifacts, scratch); }
    catch (error) { result.errors.push(error.message); }
    if (result.errors.length) fail(`Release checks blocked:\n${result.errors.join("\n")}`);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

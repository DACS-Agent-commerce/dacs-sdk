// Expected installation bytes and links come only from a fresh, successful npm ci.
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { ARCHIVE_LIMITS, cachedArchive, npmToolchain, packedFileSets, runNpmNode, verifyArchive } from "./installation-closure.mjs";

const PACKAGE_NAME = "(?:@[^/.][^/]*\\/[^/.][^/]*|(?!node_modules(?:/|$))[^/.@][^/]*)";
const PACKAGE_LOCATION = new RegExp(`^node_modules/${PACKAGE_NAME}(?:/node_modules/${PACKAGE_NAME})*$`);
const isPlainObject = value => typeof value === "object" && value !== null && !Array.isArray(value);
const digest = bytes => createHash("sha256").update(bytes).digest("base64");
const kind = stat => stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "link" : stat.isFile() ? "file" : "unsupported";
const linkTarget = (path, entry) => entry?.kind !== "link" || posix.isAbsolute(entry.target) ? null
  : posix.normalize(posix.join(posix.dirname(path), entry.target));
// Registry credentials inherited from a user npmrc are irrelevant offline and
// must not be written into scratch storage that a killed verifier can leave behind.
const isCredential = key => /(?:^|\/)_(?:auth(?:token)?|password)$/i.test(key);
const withoutCredentials = config => Object.fromEntries(Object.entries(config).filter(([key]) => !isCredential(key)));

/** Snapshots a consumer's effective npm configuration, environment, toolchain and process umask,
 * including whether an existing node_modules root changes npm's empty-install result.
 * The caller must use the same contract for its scripts-disabled installation and comparison. */
export function npmInstallContract(project, toolchain = npmToolchain()) {
  const env = { ...process.env };
  const config = JSON.parse(runNpmNode(toolchain, [toolchain.cli, "config", "list", "--json"], { cwd: project, env }).toString());
  const nodeModules = join(project, "node_modules");
  let nodeModulesMode = null;
  try { nodeModulesMode = lstatSync(nodeModules).mode & 0o7777; } catch { /* absent root */ }
  return { toolchain, config, env, nodeModules: nodeModulesMode !== null, nodeModulesMode, umask: process.umask() };
}

/** Inventories every node_modules path with one explicit kind, without following links.
 * Files include their digest, full permission bits and link count; directories retain their
 * permission bits; links retain their literal target. */
export function installationInventory(project) {
  const inventory = new Map();
  const visit = path => {
    let stat;
    try { stat = lstatSync(join(project, path)); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    const entry = { kind: kind(stat) };
    if (entry.kind === "file") {
      if (stat.size > ARCHIVE_LIMITS.unpackedBytes) throw new Error("installation file is larger than the inventory limit: " + path);
      Object.assign(entry, { digest: digest(readFileSync(join(project, path))), mode: stat.mode & 0o7777, nlink: stat.nlink });
    }
    if (entry.kind === "directory") entry.mode = stat.mode & 0o7777;
    if (entry.kind === "link") entry.target = readlinkSync(join(project, path));
    inventory.set(path, entry);
    if (inventory.size > ARCHIVE_LIMITS.entries) throw new Error("installation has too many paths");
    if (entry.kind === "directory") {
      for (const name of readdirSync(join(project, path)).sort()) visit(`${path}/${name}`);
    }
  };
  visit("node_modules");
  return inventory;
}

// npm reads package.json as UTF-8 text and ignores a leading byte-order mark.
const parsedJson = bytes => JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));

function manifestOf(bytes) {
  try { return { manifest: parsedJson(bytes) }; }
  catch { return { manifest: null, unreadable: true }; }
}

// Source identity metadata is kept separate from npm's final, normalized inventory.
function moduleRoots(location, files) {
  const roots = new Map();
  const depth = location.split("/").length;
  for (const path of files.keys()) {
    const parts = `${location}/${path}`.split("/");
    for (let index = 1; index < parts.length - 1; index += 1) {
      if (parts[index] !== "node_modules") continue;
      const scoped = parts[index + 1].startsWith("@") && index + 2 < parts.length;
      const end = index + (scoped ? 3 : 2);
      const root = parts.slice(0, end).join("/");
      if (end <= depth || roots.has(root)) continue;
      const manifest = files.get(`${root}/package.json`.slice(location.length + 1));
      roots.set(root, { owner: location, name: parts.slice(index + 1, end).join("/"),
        ...(manifest ? manifestOf(manifest) : { manifest: null }) });
    }
  }
  return roots;
}

function referenceConfig(project, cache, contract) {
  const config = withoutCredentials(contract.config);
  // These describe the original invocation/storage, rather than install semantics.
  for (const key of ["prefix", "cache", "userconfig", "globalconfig", "location", "npm-version", "json", "logs-dir"]) delete config[key];
  const requireNpm = createRequire(contract.toolchain.cli);
  const { definitions } = requireNpm("@npmcli/config/lib/definitions");
  // Presence can conflict even when false. Omit only inactive, default-false
  // exclusive options; the round-trip below still verifies their defaults.
  for (const [key, definition] of Object.entries(definitions)) {
    if (definition.exclusive && definition.default === false && config[key] === false) delete config[key];
  }
  const ini = requireNpm("ini");
  if (Number.isInteger(config.umask)) config.umask = config.umask.toString(8).padStart(3, "0");
  writeFileSync(join(project, ".npmrc"), ini.stringify(Object.fromEntries(Object.entries(config).filter(([, value]) => value !== null))));
  const userconfig = join(project, "empty-user.npmrc");
  const globalconfig = join(project, "empty-global.npmrc");
  writeFileSync(userconfig, "");
  writeFileSync(globalconfig, "");
  const env = Object.fromEntries(Object.entries(contract.env).filter(([key]) => !/^npm_config_/i.test(key)));
  const args = [contract.toolchain.cli, "ci", "--ignore-scripts", "--offline", "--no-audit", "--no-fund", "--no-update-notifier",
    "--no-progress", "--no-dry-run", "--package-lock", "--no-package-lock-only", "--global=false", "--loglevel=warn",
    `--cache=${cache}`, `--prefix=${project}`, `--userconfig=${userconfig}`, `--globalconfig=${globalconfig}`];
  // Ask npm to round-trip the snapshot. A serialization or version-specific
  // configuration disagreement must refuse the replay, not change expectations.
  const restored = JSON.parse(runNpmNode(contract.toolchain,
    [contract.toolchain.cli, "config", "list", "--json", ...args.slice(2)], { cwd: project, env }).toString());
  const infrastructure = new Set(["prefix", "cache", "userconfig", "globalconfig", "location", "npm-version", "json", "logs-dir",
    "ignore-scripts", "offline", "audit", "fund", "update-notifier", "progress", "dry-run", "package-lock", "package-lock-only", "global", "loglevel"]);
  for (const [key, value] of Object.entries(contract.config)) {
    if (!infrastructure.has(key) && !isCredential(key) && JSON.stringify(restored[key]) !== JSON.stringify(value)) {
      throw new Error("npm configuration did not round-trip: " + key);
    }
  }
  return { args, env, config: restored };
}

const SPECIFICATION_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const omitted = (entry, config) => entry?.devOptional !== true && ["dev", "optional"].some(flag =>
  entry?.[flag] === true && config.omit?.includes(flag) && !config.include?.includes(flag));

// npm resolves every edge no locked node satisfies before it validates the lock
// or extracts an archive, and --offline does not stop git. Refuse every
// non-registry specification npm could resolve. An omitted hosted git edge is
// safe only when its nearest locked target is also omitted and the same project.
function refuseNonRegistrySpecifications(manifest, lock, contract) {
  const npmPackageArg = createRequire(contract.toolchain.cli)("npm-package-arg");
  const isRegistry = spec => {
    try {
      const parsed = npmPackageArg.resolve("dependency", spec);
      return parsed.registry === true && (parsed.type !== "alias" || typeof parsed.subSpec?.name === "string");
    } catch { return false; }
  };
  const omittedGit = (location, owner, name, spec) => {
    if (location === "package.json" || !omitted(owner, contract.config)) return false;
    for (let parent = location;; parent = parent.slice(0, Math.max(0, parent.lastIndexOf("/node_modules/")))) {
      const target = lock.packages[`${parent ? parent + "/" : ""}node_modules/${name}`];
      if (target) {
        try {
          const a = npmPackageArg.resolve(name, spec).hosted;
          const b = npmPackageArg.resolve(name, target.resolved).hosted;
          return omitted(target, contract.config) && !!a && !!b &&
            ["type", "user", "project"].every(key => a[key] === b[key]);
        } catch { return false; }
      }
      if (!parent) return false;
    }
  };
  const refuse = (location, field) => { throw new Error(`non-registry dependency specification: ${location} ${field}`); };
  const declarations = (location, owner, fields) => {
    for (const field of fields) {
      if (owner[field] === undefined) continue;
      if (!isPlainObject(owner[field])) refuse(location, field);
      for (const [name, spec] of Object.entries(owner[field])) {
        if (!isRegistry(spec) && !omittedGit(location, owner, name, spec)) refuse(location, `${field}.${name}`);
      }
    }
  };
  declarations("package.json", manifest, SPECIFICATION_FIELDS);
  // npm also resolves a bundled entry's edges that its bundle does not carry.
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (location !== "" && isPlainObject(entry)) {
      declarations(location, entry, SPECIFICATION_FIELDS.filter(field => field !== "devDependencies"));
    }
  }
  // A `$name` override refers to a root declaration checked above.
  const overrides = (field, value) => {
    if (typeof value === "string") { if (!value.startsWith("$") && !isRegistry(value)) refuse("package.json", field); }
    else if (isPlainObject(value)) for (const [name, child] of Object.entries(value)) overrides(`${field}.${name}`, child);
    else refuse("package.json", field);
  };
  if (manifest.overrides !== undefined) overrides("overrides", manifest.overrides);
}

function seedArchive(cache, bytes) {
  const sha512 = createHash("sha512").update(bytes).digest("hex");
  const path = join(cache, "_cacache", "content-v2", "sha512", sha512.slice(0, 2), sha512.slice(2, 4), sha512.slice(4));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function seedMetadata(source, cache, toolchain) {
  const index = join(source, "_cacache/index-v5");
  if (!existsSync(index)) return;
  cpSync(index, join(cache, "_cacache/index-v5"), { recursive: true, filter: path => {
    if (lstatSync(path).size > ARCHIVE_LIMITS.archiveBytes) throw new Error("metadata index is larger than the archive limit");
    return true;
  } });
  const command = `const c = require('node:module').createRequire(process.argv[1])('cacache');
    c.ls(process.argv[2] + '/_cacache').then(entries => process.stdout.write(JSON.stringify(
      [...new Set(Object.values(entries).filter(e => e.metadata?.resHeaders?.['content-type']?.includes('json') &&
        !/\\.tgz(?:[?#]|$)/.test(e.key)).map(e => e.integrity))]
    ))).catch(e => { throw e });`;
  const integrities = JSON.parse(runNpmNode(toolchain, ["-e", command, toolchain.cli, source]).toString());
  for (const integrity of integrities) seedArchive(cache, cachedArchive(source, integrity));
}

function sourceEntries(lock, readArchive, contract, cache, entries, roots) {
  const unavailable = new Map();
  const sources = new Map();
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (location === "") continue;
    if (!PACKAGE_LOCATION.test(location) || !isPlainObject(entry) || entry.link === true) {
      throw new Error("cannot derive the installed files of lock entry " + location);
    }
    const record = { entry, present: false, files: null, manifest: null, unverified: false };
    entries.set(location, record);
    if (entry.inBundle === true) continue;
    if (entry.hasShrinkwrap === true) throw new Error("package has an npm-shrinkwrap.json: " + location);
    if (typeof entry.resolved !== "string" || !/^https?:\/\//.test(entry.resolved)) {
      record.unverified = true;
      if (omitted(entry, contract.config)) continue;
      throw new Error("cannot authenticate an unverified registry archive: " + location);
    }
    let bytes;
    try { bytes = readArchive(location, entry); }
    catch (error) { unavailable.set(location, error); continue; }
    try { sources.set(location, verifyArchive(bytes, entry.integrity)); }
    catch (cause) { throw new Error(`cannot derive the installed files of ${location}: ${cause.message}`, { cause }); }
  }
  for (const [location, files] of packedFileSets(sources, contract.toolchain)) {
    const record = entries.get(location);
    if (files.has("npm-shrinkwrap.json")) throw new Error("package has an npm-shrinkwrap.json: " + location);
    record.manifest = manifestOf(files.get("package.json")).manifest;
    record.files = new Map([...files].map(([path, content]) => [path, digest(content)]));
    for (const [root, module] of moduleRoots(location, files)) roots.set(root, module);
    seedArchive(cache, sources.get(location));
  }
  return unavailable;
}

/** Replays an explicit npm install contract offline with scripts disabled, using independently
 * verified archive bytes in fresh private storage. Returns source entries/carried modules plus one
 * kind-tagged inventory. npm decides which packages to omit; every failed archive extraction
 * refuses the reference. Non-registry specifications are refused except satisfied, omitted hosted git edges.
 * An explicit metadataCache supplies bounded npm metadata, never archive authentication. Errors publish no inventory. Linked installs are
 * unsupported. Never reads the inspected installation. `manifest` is the root package.json bytes:
 * npm formats its generated hidden lockfile after them. */
export function referenceInstallation({ manifest: manifestBytes, lock, readArchive, installer, metadataCache }) {
  const entries = new Map();
  const roots = new Map();
  const errors = [];
  const result = { entries: new Map(), carried: new Map(), errors, inventory: null };
  const scratch = mkdtempSync(join(tmpdir(), "dacs-npm-reference-"));
  try {
    let manifest = null;
    try { if (manifestBytes instanceof Uint8Array) manifest = parsedJson(Buffer.from(manifestBytes)); } catch { /* refused below */ }
    if (!isPlainObject(lock?.packages) || !isPlainObject(manifest)) throw new Error("package-lock.json has no packages map or manifest");
    if (!installer?.config || !installer.env || typeof installer.nodeModules !== "boolean" ||
        !Number.isInteger(installer.umask) || installer.umask < 0 || installer.umask > 0o777 ||
        (installer.nodeModules ? !Number.isInteger(installer.nodeModulesMode) : installer.nodeModulesMode !== null) ||
        installer.toolchain?.platform !== process.platform || installer.toolchain.arch !== process.arch) {
      throw new Error("reference installation needs an explicit matching npm/platform/configuration contract");
    }
    refuseNonRegistrySpecifications(manifest, lock, installer);
    const project = join(scratch, "project");
    const cache = join(scratch, "cache");
    mkdirSync(project);
    // npm 11 only writes the hidden lockfile for an all-omitted tree when the
    // node_modules root already existed; reproduce that input, never its contents.
    // npm preserves an existing root's mode, so restore the inspected one exactly.
    if (installer.nodeModules) {
      mkdirSync(join(project, "node_modules"));
      chmodSync(join(project, "node_modules"), installer.nodeModulesMode);
    }
    const unavailable = sourceEntries(lock, readArchive, installer, cache, entries, roots);
    if (metadataCache !== undefined) seedMetadata(metadataCache, cache, installer.toolchain);
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta"]) {
      if (!isDeepStrictEqual(manifest[field] ?? {}, lock.packages[""]?.[field] ?? {})) {
        throw new Error("root dependency metadata differs: " + field);
      }
    }
    writeFileSync(join(project, "package.json"), manifestBytes);
    writeFileSync(join(project, "package-lock.json"), JSON.stringify(lock));
    const { args, env, config } = referenceConfig(project, cache, installer);
    if (!["hoisted", "nested", "shallow"].includes(config["install-strategy"])) {
      throw new Error("unsupported install-strategy: " + config["install-strategy"]);
    }
    if (installer.config["npm-version"] !== createRequire(installer.toolchain.cli)("../package.json").version) {
      throw new Error("npm-version differs from selected npm");
    }
    // The snapshot has no source precedence; writing default prefer-online=false
    // would mask cache-max's online-revalidation alias. Refuse that ambiguity.
    if (Number.isFinite(config["cache-max"]) && config["cache-max"] <= 0) {
      throw new Error("cannot replay cache-max online revalidation offline");
    }
    const configFile = join(scratch, "config.json");
    const failuresFile = join(scratch, "archive-failures.jsonl");
    writeFileSync(configFile, JSON.stringify({ config, umask: installer.umask, failuresFile }));
    try {
      // Observe npm's warning channel even if the captured log configuration is quiet.
      const command = `process.on('log', (level, title, ...text) => {
        if ((level === 'warn' || level === 'error') && title === 'tar') throw Error(text.join(' '));
      });
      const fs = require('node:fs');
      const configFile = process.argv.splice(1, 1)[0];
      const requireNpm = require('node:module').createRequire(process.argv[1]);
      const { config, umask, failuresFile } = JSON.parse(fs.readFileSync(configFile));
      process.umask(umask);
      const reify = requireNpm.resolve('@npmcli/arborist/lib/arborist/reify.js');
      const reifyRequire = require('node:module').createRequire(reify);
      if (requireNpm.resolve('pacote') !== reifyRequire.resolve('pacote')) throw Error('pacote instance differs from npm reifier');
      const pacote = requireNpm('pacote');
      const fetchManifest = pacote.manifest, extract = pacote.extract;
      pacote.manifest = (spec, ...options) => {
        if (!requireNpm('npm-package-arg')(spec).registry) throw Error('non-registry dependency resolution: ' + spec);
        return fetchManifest(spec, ...options);
      };
      fs.writeFileSync(failuresFile, '');
      pacote.extract = async (...args) => {
        try {
          if (!['remote', 'version', 'range', 'tag', 'alias'].includes(requireNpm('npm-package-arg')(args[0]).type)) throw Error('non-registry archive extraction: ' + args[0]);
          return await extract.apply(pacote, args);
        } catch (error) {
          fs.appendFileSync(failuresFile, JSON.stringify({ spec: args[0], resolved: args[2]?.resolved,
            code: error.code, message: error.message }) + '\\n');
          throw error;
        }
      };
      require(process.argv[1]);`;
      runNpmNode(installer.toolchain, ["-e", command, configFile, ...args], { cwd: project, env });
      let failures;
      try {
        const log = readFileSync(failuresFile, "utf8");
        failures = log.trim() ? log.trim().split("\n").map(line => JSON.parse(line)) : [];
        if (!failures.every(failure => typeof failure.spec === "string" && typeof failure.message === "string")) {
          throw new Error("invalid failure record");
        }
      } catch (cause) { throw new Error("cannot read npm archive failure log: " + cause.message, { cause }); }
      if (failures.length) {
        const details = failures.map(failure => {
          const locations = [...entries].filter(([, record]) => record.entry.resolved === (failure.resolved ?? failure.spec))
            .map(([location]) => location);
          return `${locations.join(", ") || failure.spec}: ${failure.code ?? "error"}: ${failure.message}`;
        });
        throw new Error("archive extraction failed: " + details.join("; "));
      }
    } catch (cause) {
      const missing = [...unavailable].map(([location, error]) => `${location}: ${error.message}`).join("; ");
      throw new Error(cause.message + (missing ? `; unavailable sources (may be omitted by npm): ${missing}` : ""), { cause });
    }
    const inventory = installationInventory(project);
    for (const [location, record] of entries) {
      const installed = inventory.get(location);
      record.present = installed?.kind === "directory";
      if (!record.present) continue;
      if (record.entry.inBundle === true) {
        const module = roots.get(location);
        if (!module) throw new Error("bundled lock entry is not in the archive of the package bundling it: " + location);
        Object.assign(record, { bundledBy: module.owner, manifest: module.manifest });
      } else {
        if (!record.files) throw new Error("installed package has no verified source: " + location);
        if (roots.has(location)) throw new Error(`lock entry ${location} is also in the archive of ${roots.get(location).owner}`);
      }
    }
    for (const [path, entry] of inventory) {
      if (entry.kind !== "link") continue;
      const target = linkTarget(path, entry);
      if (target === null || inventory.get(target)?.kind !== "file") {
        throw new Error("link target is not a reference file: " + path);
      }
    }
    result.entries = entries;
    result.carried = new Map([...roots].filter(([root]) => !entries.has(root) && inventory.has(root)));
    result.inventory = inventory;
  } catch (cause) { errors.push("cannot derive reference installation: " + cause.message); result.cause = cause; }
  finally { rmSync(scratch, { recursive: true, force: true }); }
  return result;
}

/** Compares an installation against a successfully completed reference. Every path has one kind;
 * missing/replaced directories, files, command links and generated artifacts are differences. */
export function installationDifferences(project, reference) {
  if (reference.errors.length || !(reference.inventory instanceof Map)) return ["reference installation did not complete"];
  let actual;
  try { actual = installationInventory(project); }
  catch (cause) { return ["cannot read the installation: " + cause.message]; }
  const differences = [];
  for (const path of [...new Set([...reference.inventory.keys(), ...actual.keys()])].sort()) {
    const expected = reference.inventory.get(path);
    const observed = actual.get(path);
    if (!expected) differences.push(`unexpected ${observed.kind}: ${path}`);
    else if (!observed) differences.push("missing: " + path);
    else if (expected.kind !== observed.kind) differences.push(`expected ${expected.kind}, found ${observed.kind}: ${path}`);
    else if (expected.kind === "file") {
      if (observed.nlink !== 1) differences.push("hard link: " + path);
      else if (observed.digest !== expected.digest || observed.mode !== expected.mode) differences.push("changed: " + path);
    } else if (expected.kind === "directory") {
      if (observed.mode !== expected.mode) differences.push("changed mode: " + path);
    } else if (expected.kind === "link" && observed.target !== expected.target) differences.push(`link to an unexpected target: ${path} -> ${observed.target}`);
    else if (expected.kind === "unsupported") differences.push("unsupported entry: " + path);
  }
  return differences;
}

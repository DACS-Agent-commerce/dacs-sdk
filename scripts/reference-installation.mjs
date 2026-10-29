// Expected installation bytes and links come only from a fresh, successful npm ci.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { ARCHIVE_LIMITS, npmToolchain, packedFileSets, runNpmNode, verifyArchive } from "./installation-closure.mjs";

const PACKAGE_NAME = "(?:@[^/.][^/]*\\/[^/.][^/]*|(?!node_modules(?:/|$))[^/.@][^/]*)";
const PACKAGE_LOCATION = new RegExp(`^node_modules/${PACKAGE_NAME}(?:/node_modules/${PACKAGE_NAME})*$`);
const isPlainObject = value => typeof value === "object" && value !== null && !Array.isArray(value);
const digest = bytes => createHash("sha256").update(bytes).digest("base64");
const kind = stat => stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "link" : stat.isFile() ? "file" : "unsupported";

/** Snapshots a consumer's effective npm configuration, environment and selected toolchain.
 * The caller must use the same contract for its scripts-disabled installation and comparison. */
export function npmInstallContract(project, toolchain = npmToolchain()) {
  const env = { ...process.env };
  const config = JSON.parse(runNpmNode(toolchain, [toolchain.cli, "config", "list", "--json"], { cwd: project, env }).toString());
  return { toolchain, config, env };
}

/** Inventories every node_modules path with one explicit kind, without following links.
 * Files include their digest, mode and link count; links retain their literal target. */
export function installationInventory(project) {
  const inventory = new Map();
  const visit = path => {
    let stat;
    try { stat = lstatSync(join(project, path)); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    const entry = { kind: kind(stat) };
    if (entry.kind === "file") Object.assign(entry, { digest: digest(readFileSync(join(project, path))), mode: stat.mode & 0o777, nlink: stat.nlink });
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

function manifestOf(bytes) {
  try { return { manifest: JSON.parse(bytes.toString("utf8")) }; }
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
  const config = { ...contract.config };
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
    if (!infrastructure.has(key) && JSON.stringify(restored[key]) !== JSON.stringify(value)) {
      throw new Error("npm configuration did not round-trip: " + key);
    }
  }
  return { args, env, config: restored };
}

function seedArchive(cache, bytes) {
  const hex = createHash("sha512").update(bytes).digest("hex");
  const path = join(cache, "_cacache", "content-v2", "sha512", hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
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

// Evaluate exclusions with the selected npm's configuration and install checks in
// its own process: npm's flattening may change the lifecycle environment.
function excludedSources(unavailable, entries, contract, scratch, manifest, lock) {
  if (!unavailable.size) return new Set();
  // npm recalculates dependency flags when root declarations change. Such flags
  // cannot establish that a failed source read was an intentional exclusion.
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta"]) {
    if (!isDeepStrictEqual(manifest[field] ?? {}, lock.packages[""]?.[field] ?? {})) {
      throw new Error("root dependency metadata differs: " + field);
    }
  }
  const input = join(scratch, "unavailable.json");
  writeFileSync(input, JSON.stringify({ config: contract.config,
    entries: [...unavailable.keys()].map(location => [location, entries.get(location).entry]) }));
  const command = `const requireNpm = require('node:module').createRequire(process.argv[1]);
    const { config, entries } = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
    const npmVersion = requireNpm('../package.json').version;
    if (config['npm-version'] !== npmVersion) throw Error('npm-version differs from selected npm');
    const options = requireNpm('@npmcli/config/lib/definitions').flatten(config);
    const { checkPlatform, checkEngine } = requireNpm('npm-install-checks');
    const omit = new Set(options.omit);
    const excluded = entries.filter(([, entry]) => {
      // The same dependency-flag rules as npm's Arborist reifier.
      if (entry.peer && omit.has('peer') || entry.dev && omit.has('dev') ||
          entry.optional && omit.has('optional') || entry.devOptional && omit.has('dev') && omit.has('optional')) return true;
      if (entry.optional) {
        try {
          checkPlatform(entry, false, options);
          checkEngine(entry, npmVersion, process.version, false);
        } catch (error) {
          if (error.code === 'EBADPLATFORM' || error.code === 'EBADENGINE') return true;
          throw error;
        }
      }
      return false;
    }).map(([location]) => location);
    console.log(JSON.stringify(excluded));`;
  return new Set(JSON.parse(runNpmNode(contract.toolchain, ["-e", command, contract.toolchain.cli, input],
    { env: contract.env }).toString()));
}

/** Replays an explicit npm install contract offline with scripts disabled, using independently
 * verified archive bytes in fresh private storage. Returns source entries/carried modules plus one
 * kind-tagged inventory. Unavailable sources need an explicit npm contract exclusion; errors
 * publish no inventory. Never reads the inspected installation. */
export function referenceInstallation({ manifest, lock, readArchive, installer }) {
  const entries = new Map();
  const roots = new Map();
  const errors = [];
  const result = { entries, carried: new Map(), errors, inventory: null };
  const scratch = mkdtempSync(join(tmpdir(), "dacs-npm-reference-"));
  try {
    if (!isPlainObject(lock?.packages) || !isPlainObject(manifest)) throw new Error("package-lock.json has no packages map or manifest");
    if (!installer?.config || !installer.env || installer.toolchain?.platform !== process.platform || installer.toolchain.arch !== process.arch) {
      throw new Error("reference installation needs an explicit matching npm/platform/configuration contract");
    }
    const project = join(scratch, "project");
    const cache = join(scratch, "cache");
    mkdirSync(project);
    const unavailable = sourceEntries(lock, readArchive, installer, cache, entries, roots);
    const excluded = excludedSources(unavailable, entries, installer, scratch, manifest, lock);
    writeFileSync(join(project, "package.json"), JSON.stringify(manifest));
    writeFileSync(join(project, "package-lock.json"), JSON.stringify(lock));
    const { args, env, config } = referenceConfig(project, cache, installer);
    const configFile = join(scratch, "config.json");
    writeFileSync(configFile, JSON.stringify(config));
    try {
      // Observe npm's warning channel even if the captured log configuration is quiet.
      const command = `process.on('log', (level, title, ...text) => {
        if ((level === 'warn' || level === 'error') && title === 'tar') throw Error(text.join(' '));
      });
      const fs = require('node:fs');
      const configFile = process.argv.splice(1, 1)[0];
      const requireNpm = require('node:module').createRequire(process.argv[1]);
      const options = requireNpm('@npmcli/config/lib/definitions').flatten(JSON.parse(fs.readFileSync(configFile)));
      if (options.omit.includes('optional')) {
        const validator = requireNpm.resolve('../lib/utils/validate-lockfile.js');
        const validate = require(validator);
        // npm 11 retains failed optional lookups as inert, versionless nodes.
        // They cannot install under omit=optional. Keep npm's original trees,
        // metadata and reifier; exclude only those failures from lock validation.
        require.cache[validator].exports = (virtual, ideal) => {
          const checked = new Map([...ideal].filter(([location, node]) => virtual.has(location) ||
            !(node.optional && node.inert && !node.version && node.errors.some(error => error.code === 'ENOTCACHED'))));
          const unresolved = [...virtual.values()].some(node => [...node.edgesOut.values()]
            .some(edge => edge.type === 'optional' && !edge.to));
          if (checked.size !== ideal.size || unresolved) {
            const manifest = JSON.parse(fs.readFileSync('package.json'));
            const lock = JSON.parse(fs.readFileSync('package-lock.json'));
            for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta']) {
              if (!require('node:util').isDeepStrictEqual(manifest[field] ?? {}, lock.packages['']?.[field] ?? {})) {
                throw Error('root dependency metadata differs: ' + field);
              }
            }
          }
          return validate(virtual, checked);
        };
      }
      require(process.argv[1]);`;
      runNpmNode(installer.toolchain, ["-e", command, configFile, ...args], { cwd: project, env });
    } catch (cause) {
      const missing = [...unavailable].map(([location, error]) => `${location}: ${error.message}`).join("; ");
      throw new Error(cause.message + (missing ? `; source reads: ${missing}` : ""), { cause });
    }
    const inventory = installationInventory(project);
    for (const [location, cause] of unavailable) {
      if (inventory.has(location) || !excluded.has(location)) {
        throw new Error(`cannot read source ${location}: ${cause.message}`, { cause });
      }
    }
    for (const [location, record] of entries) {
      record.present = inventory.get(location)?.kind === "directory";
      if (record.entry.inBundle === true && !roots.has(location)) {
        // An unavailable, explicitly excluded source has no archive roots.
        // Find this bundle's source owner, including through nested bundles.
        let owner = location;
        while (entries.get(owner)?.entry.inBundle === true) {
          const split = owner.lastIndexOf("/node_modules/");
          owner = split < 0 ? "" : owner.slice(0, split);
        }
        if (!record.present && excluded.has(owner)) continue;
        throw new Error("bundled lock entry is not in the archive of the package bundling it: " + location);
      }
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
      const target = posix.normalize(posix.join(posix.dirname(path), entry.target));
      if (posix.isAbsolute(entry.target) || inventory.get(target)?.kind !== "file") {
        throw new Error("executable link target is not a reference file: " + path);
      }
    }
    result.carried = new Map([...roots].filter(([root]) => !entries.has(root) && inventory.has(root)));
    result.inventory = inventory;
  } catch (cause) { errors.push("cannot derive reference installation: " + cause.message); }
  finally { rmSync(scratch, { recursive: true, force: true }); }
  return result;
}

/** Compares an installation against a successfully completed reference. Every path has one kind;
 * missing/replaced directories, files, command links and generated artifacts are differences. */
export function installationDifferences(project, reference) {
  if (reference.errors.length || !(reference.inventory instanceof Map)) return ["reference installation did not complete"];
  const actual = installationInventory(project);
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
    } else if (expected.kind === "link" && observed.target !== expected.target) differences.push(`link to an unexpected target: ${path} -> ${observed.target}`);
    else if (expected.kind === "unsupported") differences.push("unsupported entry: " + path);
  }
  return differences;
}

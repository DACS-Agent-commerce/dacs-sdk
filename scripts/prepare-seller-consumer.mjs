// Setup only: pack current sources into a new directory and install a graph
// derived from the root lock. It never reuses, replaces or deletes a directory
// it did not create in this run.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const SELLER = "@kynesyslabs/dacs-seller";
const CLIENT = "@kynesyslabs/dacs-client";
const NODE_HOST = "@kynesyslabs/dacs-node";
const SMOKE_RUNNER = "packages/dacs-seller/test/helpers/installed-seller-host.mjs";
// The consumer installs the seller under node_modules; the root lock records what the seller nests
// (a version it pins that differs from the root's) under the workspace folder instead.
const SELLER_CONSUMER_PATH = "node_modules/" + SELLER;
const SELLER_WORKSPACE_PATH = "packages/dacs-seller";
const NPM_TIMEOUT_MS = 240_000;
const NPM_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const npm = (args, cwd, env = process.env) =>
  execFileSync("npm", args, { cwd, env, encoding: "utf8", timeout: NPM_TIMEOUT_MS, maxBuffer: NPM_MAX_BUFFER_BYTES });

/** The native SQLite binding is built for one Node ABI, platform and architecture: returns that key for this process. */
export const runtimeKey = () => process.versions.modules + "-" + process.platform + "-" + process.arch;

// The package-relative paths npm packs for a workspace now (a dry run); throws if npm fails.
function packFiles(workspace) {
  const [pack] = JSON.parse(npm(["pack", "--dry-run", "--json", "--ignore-scripts", "--workspace", workspace], root));
  return pack.files.map((entry) => entry.path);
}

/** Returns the package-relative paths npm packs for the seller now (a dry run); throws if npm fails. */
export const sellerPackFiles = () => packFiles(SELLER);

/**
 * Returns the digest of the given packed seller and client files, the built
 * core and Node host kit (`dist/`, `packages/dacs-node/dist`), the root
 * manifest and lock, the Node host manifest, and the smoke runner: a setup is
 * current only while it matches. Throws if a file cannot be read.
 */
export function sellerSourceFingerprint(sellerFiles, clientFiles) {
  const files = ["package.json", "package-lock.json", "packages/dacs-node/package.json", SMOKE_RUNNER, ...sellerFiles.map((file) => "packages/dacs-seller/" + file),
    ...clientFiles.map((file) => "packages/dacs-client/" + file)];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(dir + "/" + entry.name);
      else files.push(dir + "/" + entry.name);
    }
  };
  walk("dist");
  walk("packages/dacs-node/dist");
  const hash = createHash("sha256");
  for (const file of files.sort()) hash.update(file).update("\0").update(readFileSync(join(root, file)));
  return hash.digest("hex");
}

/**
 * Returns why `directory` is not a completed setup of these sources for this
 * runtime, or null when it is. The default fingerprint packs the seller and the client now.
 */
export function staleSetupReason(directory, fingerprint = sellerSourceFingerprint(sellerPackFiles(), packFiles(CLIENT))) {
  const fresh = "; prepare a fresh directory with npm run seller:prepare -- <new directory>";
  let marker, lock;
  try {
    marker = json(join(directory, "prepared.json"));
    lock = readFileSync(join(directory, "package-lock.json"));
  } catch (error) {
    return directory + " has no completed setup (" + (error.code ?? error.message) + ")" + fresh;
  }
  if (marker.runtime !== runtimeKey()) return directory + " was prepared for another Node runtime" + fresh;
  if (marker.sourceFingerprint !== fingerprint) return directory + " was prepared from other sources" + fresh;
  if (marker.lockDigest !== digest(lock)) return directory + " has a changed lock" + fresh;
  return null;
}

function required(node) {
  const peers = Object.entries(node.peerDependencies ?? {}).filter(([name]) => !node.peerDependenciesMeta?.[name]?.optional);
  return { ...node.dependencies, ...node.optionalDependencies, ...Object.fromEntries(peers) };
}

function packageEntry(manifest, pack) {
  const entry = { version: manifest.version, resolved: "file:" + pack.filename, integrity: pack.integrity };
  for (const key of ["license", "dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "engines", "bin"])
    if (manifest[key]) entry[key] = manifest[key];
  return entry;
}

/** The root lock's key for a package at `consumerKey` in the consumer's tree. */
function rootLockKey(consumerKey) {
  return consumerKey.startsWith(SELLER_CONSUMER_PATH + "/") ? SELLER_WORKSPACE_PATH + consumerKey.slice(SELLER_CONSUMER_PATH.length) : consumerKey;
}

// Preserve exact versions, locations and integrity; never resolve a fresh range. `packed` lists each {manifest, pack} installed from a tarball.
function consumerLock(lock, manifest, packed) {
  const selected = {
    "": { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies },
    ...Object.fromEntries(packed.map(({ manifest: packedManifest, pack }) => ["node_modules/" + packedManifest.name, packageEntry(packedManifest, pack)])),
  };
  const queue = Object.keys(selected).filter(Boolean);
  for (let index = 0; index < queue.length; index++) {
    const parent = queue[index];
    for (const name of Object.keys(required(selected[parent]))) {
      let at = parent, key;
      for (;;) {
        const candidate = (at ? at + "/" : "") + "node_modules/" + name;
        if (selected[candidate] || lock.packages[rootLockKey(candidate)]) { key = candidate; break; }
        if (!at) break;
        const cut = at.lastIndexOf("/node_modules/");
        at = cut < 0 ? "" : at.slice(0, cut);
      }
      if (!key) throw new Error("root lock lacks production dependency " + name + " of " + parent);
      if (selected[key]) continue;
      const entry = structuredClone(lock.packages[rootLockKey(key)]);
      // A package only optional edges reach stays marked optional: the install omits it, so it may be a platform build or
      // a git dependency (demosdk's wallet adapters reach both) that the lock cannot pin.
      if (entry.link || (!entry.optional && (!entry.integrity || !entry.resolved))) throw new Error("production dependency is not pinned: " + key);
      delete entry.dev; delete entry.devOptional;
      selected[key] = entry;
      queue.push(key);
    }
  }
  const packages = Object.fromEntries(Object.entries(selected).sort(([a], [b]) => a.localeCompare(b)));
  return { name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages };
}

// Fills the new directory; prepared.json is written last, so only a complete setup has one.
function install(app) {
  const cache = join(app, ".npm-cache"), env = { ...process.env, NPM_CONFIG_CACHE: cache, npm_config_cache: cache };
  const pack = (workspace, directory) => ({ manifest: json(join(root, directory, "package.json")),
    pack: JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", app, ...(workspace ? ["--workspace", workspace] : [])], root, env))[0] });
  const core = pack(null, "."), seller = pack(SELLER, "packages/dacs-seller"), client = pack(CLIENT, "packages/dacs-client"), node = pack(NODE_HOST, "packages/dacs-node");
  const packed = [core, seller, client, node];
  const dependencies = Object.fromEntries(packed.map((entry) => [entry.manifest.name, "file:" + entry.pack.filename]));
  const manifest = { name: "dacs-seller-locked-smoke", version: "1.0.0", private: true, type: "module", dependencies };
  writeFileSync(join(app, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  const lock = consumerLock(json(join(root, "package-lock.json")), manifest, packed);
  const text = JSON.stringify(lock, null, 2) + "\n";
  writeFileSync(join(app, "package-lock.json"), text);
  // Native dependency installation belongs to setup; scripts must run here.
  npm(["ci", "--no-audit", "--no-fund", "--omit=optional", "--foreground-scripts"], app, env);
  if (digest(readFileSync(join(app, "package-lock.json"))) !== digest(text)) throw new Error("consumer install changed the pinned graph");
  copyFileSync(join(root, SMOKE_RUNNER), join(app, "run.mjs"));
  const paths = ({ pack: { files } }) => files.map((entry) => entry.path);
  const sourceFingerprint = sellerSourceFingerprint(paths(seller), paths(client));
  const marker = { runtime: runtimeKey(), sourceFingerprint, lockDigest: digest(text), corePack: core.pack, sellerPack: seller.pack, clientPack: client.pack, nodePack: node.pack };
  writeFileSync(join(app, "prepared.json"), JSON.stringify(marker, null, 2) + "\n");
}

// Creates the directory (or a fresh temporary one), so an existing path is refused untouched.
function prepare(directory) {
  if (!existsSync(join(root, "dist", "index.js"))) throw new Error("the core is not built: run npm run build before npm run seller:prepare");
  if (!existsSync(join(root, "packages/dacs-node/dist", "secrets.js"))) throw new Error("dacs-node is not built: run npm run host:build before npm run seller:prepare");
  const app = directory === undefined ? mkdtempSync(join(tmpdir(), "dacs-seller-consumer-")) : resolve(directory);
  if (directory !== undefined) {
    try {
      mkdirSync(app);
    } catch (error) {
      throw new Error("refusing to prepare " + app + ": " + (error.code === "EEXIST" ? "it already exists; pass a new directory" : error.message), { cause: error });
    }
  }
  try {
    install(app);
  } catch (error) {
    rmSync(app, { recursive: true, force: true });
    throw error;
  }
  process.stdout.write("Prepared locked seller consumer: " + app + "\n");
}

function runDirectly() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (runDirectly()) prepare(process.argv[2]);

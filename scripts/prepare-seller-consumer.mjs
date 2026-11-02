// Setup only: pack current sources into a new directory and install a graph
// derived from the root lock. It never reuses, replaces or deletes a directory
// it did not create in this run.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const SELLER = "@kynesyslabs/dacs-seller";
const SMOKE_RUNNER = "packages/dacs-seller/test/helpers/installed-seller-host.mjs";
const NPM_TIMEOUT_MS = 240_000;
const NPM_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const npm = (args, cwd, env = process.env) =>
  execFileSync("npm", args, { cwd, env, encoding: "utf8", timeout: NPM_TIMEOUT_MS, maxBuffer: NPM_MAX_BUFFER_BYTES });

/** The native SQLite binding is built for one Node ABI, platform and architecture: returns that key for this process. */
export const runtimeKey = () => process.versions.modules + "-" + process.platform + "-" + process.arch;

/** Returns the package-relative paths npm packs for the seller now (a dry run); throws if npm fails. */
export function sellerPackFiles() {
  const [pack] = JSON.parse(npm(["pack", "--dry-run", "--json", "--ignore-scripts", "--workspace", SELLER], root));
  return pack.files.map((entry) => entry.path);
}

/**
 * Returns the digest of the given packed seller files, the built core (`dist/`),
 * the root manifest and lock, and the smoke runner: a setup is current only
 * while it matches. Throws if a file cannot be read.
 */
export function sellerSourceFingerprint(sellerFiles) {
  const files = ["package.json", "package-lock.json", SMOKE_RUNNER, ...sellerFiles.map((file) => "packages/dacs-seller/" + file)];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(dir + "/" + entry.name);
      else files.push(dir + "/" + entry.name);
    }
  };
  walk("dist");
  const hash = createHash("sha256");
  for (const file of files.sort()) hash.update(file).update("\0").update(readFileSync(join(root, file)));
  return hash.digest("hex");
}

/**
 * Returns why `directory` is not a completed setup of these sources for this
 * runtime, or null when it is. The default fingerprint packs the seller now.
 */
export function staleSetupReason(directory, fingerprint = sellerSourceFingerprint(sellerPackFiles())) {
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

// Preserve exact versions, locations and integrity; never resolve a fresh range.
function consumerLock(lock, manifest, core, seller, corePack, sellerPack) {
  const selected = {
    "": { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies },
    "node_modules/@kynesyslabs/dacs": packageEntry(core, corePack),
    "node_modules/@kynesyslabs/dacs-seller": packageEntry(seller, sellerPack),
  };
  const queue = Object.keys(selected).filter(Boolean);
  for (let index = 0; index < queue.length; index++) {
    const parent = queue[index];
    for (const name of Object.keys(required(selected[parent]))) {
      let at = parent, key;
      for (;;) {
        const candidate = (at ? at + "/" : "") + "node_modules/" + name;
        if (selected[candidate] || lock.packages[candidate]) { key = candidate; break; }
        if (!at) break;
        const cut = at.lastIndexOf("/node_modules/");
        at = cut < 0 ? "" : at.slice(0, cut);
      }
      if (!key) throw new Error("root lock lacks production dependency " + name + " of " + parent);
      if (selected[key]) continue;
      const entry = structuredClone(lock.packages[key]);
      if (entry.link || !entry.integrity || !entry.resolved) throw new Error("production dependency is not pinned: " + key);
      delete entry.dev; delete entry.devOptional; delete entry.optional;
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
  const core = json(join(root, "package.json")), seller = json(join(root, "packages/dacs-seller/package.json"));
  const [corePack] = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", app], root, env));
  const [sellerPack] = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", app, "--workspace", SELLER], root, env));
  const dependencies = { [core.name]: "file:" + corePack.filename, [seller.name]: "file:" + sellerPack.filename };
  const manifest = { name: "dacs-seller-locked-smoke", version: "1.0.0", private: true, type: "module", dependencies };
  writeFileSync(join(app, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  const lock = consumerLock(json(join(root, "package-lock.json")), manifest, core, seller, corePack, sellerPack);
  const text = JSON.stringify(lock, null, 2) + "\n";
  writeFileSync(join(app, "package-lock.json"), text);
  // Native dependency installation belongs to setup; scripts must run here.
  npm(["ci", "--no-audit", "--no-fund", "--omit=optional", "--foreground-scripts"], app, env);
  if (digest(readFileSync(join(app, "package-lock.json"))) !== digest(text)) throw new Error("consumer install changed the pinned graph");
  copyFileSync(join(root, SMOKE_RUNNER), join(app, "run.mjs"));
  const sourceFingerprint = sellerSourceFingerprint(sellerPack.files.map((entry) => entry.path));
  const marker = { runtime: runtimeKey(), sourceFingerprint, lockDigest: digest(text), corePack, sellerPack };
  writeFileSync(join(app, "prepared.json"), JSON.stringify(marker, null, 2) + "\n");
}

// Creates the directory (or a fresh temporary one), so an existing path is refused untouched.
function prepare(directory) {
  if (!existsSync(join(root, "dist", "index.js"))) throw new Error("the core is not built: run npm run build before npm run seller:prepare");
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepare(process.argv[2]);

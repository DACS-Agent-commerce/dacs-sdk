// What `npm ci --ignore-scripts` writes below a project's node_modules, derived
// from package-lock.json and the archive each installed lock entry names, never
// from the installed tree: every file of each archive at its lock location, the
// .bin links npm creates from the lock's `bin` maps, and npm's hidden lockfile.
// installationDifferences compares an installed tree with that closure, so a
// file, directory or link nothing in it accounts for is found wherever it is.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { gunzipSync } from "node:zlib";

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_UNPACKED_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 100_000;
const TAR_BLOCK = 512;
const TAR_NAME = [0, 100];
const TAR_SIZE = [124, 136];
const TAR_CHECKSUM = [148, 156];
const TAR_TYPE = 156;
const TAR_MAGIC = [257, 263];
const TAR_PREFIX = [345, 500];
const USTAR_MAGIC = "ustar\0";
// npm (pacote) extracts file entries only. It skips directory, link and device
// entries, creates each file's parent directories itself, and drops the first
// path component (`package/`) of every entry.
const FILE_TYPES = new Set(["0", "7"]);
const SKIPPED_TYPES = new Set(["1", "2", "3", "4", "5", "6", "K"]);
// npm leaves out optional entries for another platform and, with --omit, dev ones.
const OMITTABLE_FLAGS = ["optional", "dev", "devOptional"];
const HIDDEN_LOCKFILE = "node_modules/.package-lock.json";
// A lock location: node_modules/<name>, optionally nested below other packages.
const PACKAGE_NAME = "(?:@[^/.][^/]*\\/[^/.][^/]*|(?!node_modules(?:/|$))[^/.@][^/]*)";
const PACKAGE_LOCATION = new RegExp(`^node_modules/${PACKAGE_NAME}(?:/node_modules/${PACKAGE_NAME})*$`);

const isPlainObject = value => typeof value === "object" && value !== null && !Array.isArray(value);
const tarText = (header, [start, end]) => header.toString("utf8", start, end).replace(/\0.*$/s, "");
const tarNumber = (header, field) => {
  const text = tarText(header, field).trim();
  return text === "" ? 0 : /^[0-7]+$/.test(text) ? Number.parseInt(text, 8) : Number.NaN;
};
const validChecksum = header => tarNumber(header, TAR_CHECKSUM) ===
  header.reduce((sum, byte, index) => sum + (index >= TAR_CHECKSUM[0] && index < TAR_CHECKSUM[1] ? 0x20 : byte), 0);
const isEscapingPath = path => path.split("/").some(part => part === "" || part === "." || part === "..");
const fileDigest = bytes => createHash("sha256").update(bytes).digest("base64");

// The path and size of a PAX extended header. Equal size records from older
// npm archives are supported; size overrides are refused explicitly.
function paxFields(data) {
  const fields = {};
  for (let offset = 0; offset < data.length;) {
    const space = data.indexOf(" ", offset);
    const length = Number.parseInt(data.toString("utf8", offset, space), 10);
    if (space < 0 || !(length > 0) || offset + length > data.length) throw new Error("malformed pax header in the packed tarball");
    const record = data.toString("utf8", space + 1, offset + length - 1);
    if (record.startsWith("path=")) fields.path = record.slice("path=".length);
    if (record.startsWith("size=")) {
      const size = record.slice("size=".length);
      if (!/^(0|[1-9][0-9]*)$/.test(size) || !Number.isSafeInteger(Number(size))) {
        throw new Error("malformed pax size in the packed tarball");
      }
      fields.size = Number(size);
    }
    offset += length;
  }
  return fields;
}

// npm installs a .gitignore as .npmignore, unless the archive holds that .npmignore.
function renameGitignores(files) {
  for (const path of [...files.keys()].filter(path => posix.basename(path) === ".gitignore")) {
    const npmignore = posix.join(posix.dirname(path), ".npmignore");
    if (!files.has(npmignore)) files.set(npmignore, files.get(path));
    files.delete(path);
  }
  return files;
}

/** Reads a gzip-compressed npm package archive into a Map from each file's installed path (its
 * entry path without the first component, as npm extracts it) to its bytes. Directory, link and
 * device entries are skipped, as npm skips them. Throws on an archive that is truncated, unpacks to
 * more than MAX_UNPACKED_ARCHIVE_BYTES or holds more than MAX_ARCHIVE_ENTRIES entries, a header with
 * a bad checksum or size, a PAX size override, an unsupported entry type, an escaping or duplicate
 * path, or no package.json. PAX sizes equal to the file header size are supported. */
export function packedFiles(archive) {
  const tar = gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_ARCHIVE_BYTES });
  const files = new Map();
  let longName;
  let paxSize;
  for (let offset = 0, entries = 0; ; entries += 1) {
    if (offset + TAR_BLOCK > tar.length) throw new Error("truncated packed tarball: no end-of-archive block");
    const header = tar.subarray(offset, offset + TAR_BLOCK);
    if (header.every(byte => byte === 0)) break;
    if (entries === MAX_ARCHIVE_ENTRIES) throw new Error(`packed tarball has more than ${MAX_ARCHIVE_ENTRIES} entries`);
    if (!validChecksum(header)) throw new Error("packed tarball header has a bad checksum");
    const size = tarNumber(header, TAR_SIZE);
    if (!Number.isSafeInteger(size)) throw new Error("packed tarball entry has a malformed size");
    const next = offset + TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    if (next > tar.length) throw new Error("truncated packed tarball entry");
    const data = tar.subarray(offset + TAR_BLOCK, offset + TAR_BLOCK + size);
    offset = next;
    const type = String.fromCharCode(header[TAR_TYPE] || 48);
    if (type === "x") {
      const fields = paxFields(data);
      longName = fields.path ?? longName;
      paxSize = fields.size ?? paxSize;
      continue;
    }
    if (type === "L") { longName = data.toString("utf8").replace(/\0.*$/s, ""); continue; }
    if (paxSize !== undefined && paxSize !== size) throw new Error("pax size differs from the entry header in the packed tarball");
    paxSize = undefined;
    const prefix = header.toString("latin1", ...TAR_MAGIC) === USTAR_MAGIC ? tarText(header, TAR_PREFIX) : "";
    const name = longName ?? (prefix ? `${prefix}/` : "") + tarText(header, TAR_NAME);
    longName = undefined;
    if (SKIPPED_TYPES.has(type)) continue;
    if (!FILE_TYPES.has(type)) throw new Error(`unsupported entry type ${type} in the packed tarball: ${name}`);
    const path = name.split("/").slice(1).join("/");
    if (name.startsWith("/") || isEscapingPath(path)) throw new Error("packed tarball entry escapes the package: " + name);
    if (files.has(path)) throw new Error("duplicate packed tarball entry: " + name);
    files.set(path, data);
  }
  if (!files.has("package.json")) throw new Error("packed tarball has no package.json");
  return renameGitignores(files);
}

// The sha512 digest an SRI integrity carries; npm verifies and caches archives by it.
function sha512Digest(integrity) {
  const digests = typeof integrity !== "string" ? [] : integrity.trim().split(/\s+/)
    .map(token => /^sha512-([A-Za-z0-9+/]{86}==)(?:\?[!-~]*)?$/.exec(token)?.[1]).filter(Boolean);
  return new Set(digests).size === 1 ? digests[0] : null;
}

/** Returns the bytes of the archive with `integrity` that npm stored in its content-addressed cache
 * below `cache` (npm's `cache` setting). Throws when the integrity has no single sha512, the cache
 * holds no such archive or one larger than MAX_ARCHIVE_BYTES, or its bytes have another digest. */
export function cachedArchive(cache, integrity) {
  const digest = sha512Digest(integrity);
  if (digest === null) throw new Error(`integrity has no single sha512 digest: ${String(integrity)}`);
  const hex = Buffer.from(digest, "base64").toString("hex");
  const path = join(cache, "_cacache", "content-v2", "sha512", hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
  let size;
  try { size = statSync(path).size; }
  catch (error) { throw new Error(`cannot read npm's cached archive for ${integrity} (${error?.code ?? error?.message})`); }
  if (size > MAX_ARCHIVE_BYTES) throw new Error(`cached archive is larger than ${MAX_ARCHIVE_BYTES} bytes: ${path}`);
  const bytes = readFileSync(path);
  if (createHash("sha512").update(bytes).digest("base64") !== digest) throw new Error("cached archive does not match its integrity: " + path);
  return bytes;
}

const pathExists = path => {
  try { lstatSync(path); return true; }
  catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
};
const readManifest = bytes => {
  try { return { manifest: JSON.parse(bytes.toString("utf8")) }; }
  catch { return { manifest: null, unreadable: true }; }
};

// Each module root inside `files` (a directory or file directly below any
// node_modules in its installed path beyond `location`, `@scope/name` for a
// scope), keyed by that path, with its name and the package.json the archive
// holds for it. Node looks for modules in every such node_modules.
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
        ...(manifest ? readManifest(manifest) : { manifest: null }) });
    }
  }
  return roots;
}

/** Derives what npm installs below `project` for `lock`: `readArchive(location, entry)` returns
 * the archive bytes of each installed entry. An optional, dev or devOptional entry counts as
 * installed only if its location exists. Returns `entries` (lock location to `{ entry, present,
 * files, manifest, bundledBy, unverified }`: `files` maps installed paths to sha256 digests, and an
 * entry without a sha512 integrity, such as a Git dependency, is `unverified`), `carried` (each
 * module an archive holds below a node_modules of its own that no lock entry installs, with its name
 * and package.json) and `errors` (entries whose installed files cannot be derived, including
 * omitted entries still carried by an installed archive, packages with npm-shrinkwrap.json,
 * missing command files and command targets with CRLF shebangs that npm rewrites when creating
 * executable links). */
export function installationClosure(project, lock, readArchive) {
  const entries = new Map();
  const roots = new Map();
  const crlfCommands = new Set();
  const errors = [];
  if (!isPlainObject(lock?.packages)) return { entries, carried: new Map(), errors: ["package-lock.json has no packages map"] };
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (location === "") continue;
    if (!PACKAGE_LOCATION.test(location) || !isPlainObject(entry) || entry.link === true) {
      errors.push("cannot derive the installed files of lock entry " + location);
      continue;
    }
    const present = !OMITTABLE_FLAGS.some(flag => entry[flag] === true) || pathExists(join(project, location));
    const record = { entry, present, files: null, manifest: null, unverified: false };
    entries.set(location, record);
    if (!present || entry.inBundle === true) continue;
    if (sha512Digest(entry.integrity) === null) { record.unverified = true; continue; }
    try {
      const files = packedFiles(readArchive(location, entry));
      if (entry.hasShrinkwrap === true || files.has("npm-shrinkwrap.json")) throw new Error("package has an npm-shrinkwrap.json");
      for (const [path, bytes] of files) {
        if (/^#![^\n]+\r\n/.test(bytes.toString("utf8"))) crlfCommands.add(`${location}/${path}`);
      }
      record.manifest = readManifest(files.get("package.json")).manifest;
      record.files = new Map([...files].map(([path, bytes]) => [path, fileDigest(bytes)]));
      for (const [root, module] of moduleRoots(location, files)) roots.set(root, module);
    } catch (error) { errors.push(`cannot derive the installed files of ${location}: ${error.message}`); }
  }
  for (const [location, record] of entries) {
    if (!record.present && roots.has(location)) {
      errors.push(`cannot derive the installed files of ${location}: omitted entry is in the archive of ${roots.get(location).owner}`);
    }
    // A bundled entry is one of the modules its bundling package's archive holds.
    if (record.entry.inBundle === true && record.present) {
      const module = roots.get(location);
      if (module === undefined) errors.push("bundled lock entry is not in the archive of the package bundling it: " + location);
      else Object.assign(record, { bundledBy: module.owner, manifest: module.manifest });
    } else if (record.files && roots.has(location)) {
      errors.push(`lock entry ${location} is also in the archive of ${roots.get(location).owner}`);
    }
    for (const target of record.present && isPlainObject(record.entry.bin) ? Object.values(record.entry.bin) : []) {
      const owner = record.bundledBy ?? location;
      const files = entries.get(owner)?.files;
      const resolved = typeof target === "string" ? posix.join(location, target) : "";
      if (files && (!resolved.startsWith(`${location}/`) || !files.has(resolved.slice(owner.length + 1)))) {
        errors.push(`cannot derive the installed files of ${location}: bin target is not an archive file: ${String(target)}`);
      }
      if (typeof target === "string" && crlfCommands.has(resolved)) {
        errors.push(`cannot derive the installed files of ${location}: npm rewrites the CRLF shebang of bin target: ${posix.normalize(target)}`);
      }
    }
  }
  const carried = new Map([...roots].filter(([root]) => !entries.has(root)));
  return { entries, carried, errors };
}

// npm links each command of a package's `bin` map into the .bin directory of
// the node_modules holding it, relative to that directory.
function binLinks(entries) {
  const links = new Map();
  for (const [location, { entry, present }] of entries) {
    if (!present || !isPlainObject(entry.bin)) continue;
    const modules = location.replace(/(?:@[^/]+\/)?[^/]+$/, "");
    for (const [command, target] of Object.entries(entry.bin)) {
      const resolved = typeof target === "string" ? posix.join(location, target) : "";
      if (!/^[^/.][^/]*$/.test(command) || !resolved.startsWith(`${location}/`)) continue;
      const link = `${modules}.bin/${command}`;
      if (!links.has(link)) links.set(link, new Set());
      links.get(link).add(resolved);
    }
  }
  return links;
}

// The paths the closure installs: file digests (null for npm's hidden lockfile,
// whose bytes are npm's own), .bin link targets, unverified entry locations
// and every directory any of them lies in.
function expectedPaths(closure) {
  const files = new Map([[HIDDEN_LOCKFILE, null]]);
  const unverified = new Set();
  const omittedAncestors = [];
  for (const [location, record] of closure.entries) {
    if (!record.present) omittedAncestors.push(location);
    if (record.present && record.unverified) unverified.add(location);
    for (const [path, digest] of record.present ? record.files ?? [] : []) files.set(`${location}/${path}`, digest);
  }
  const links = binLinks(closure.entries);
  // npm replaces extracted files/directories at generated command paths with
  // links. Only those final links belong to a completed installation.
  for (const path of files.keys()) {
    for (let parent = path; parent !== "."; parent = posix.dirname(parent)) {
      if (links.has(parent)) { files.delete(path); break; }
    }
  }
  const directories = new Set();
  for (const path of [...files.keys(), ...links.keys(), ...unverified, ...omittedAncestors]) {
    for (let parent = posix.dirname(path); parent !== "."; parent = posix.dirname(parent)) directories.add(parent);
  }
  return { files, links, unverified, directories };
}

const entryKind = item => item.isDirectory() ? "directory" : item.isSymbolicLink() ? "link" : item.isFile() ? "file" : "entry";

/** Compares `project`'s node_modules with `closure` without following any link. Every file must be
 * an unlinked regular file with the bytes its archive holds, every link a .bin link npm creates for
 * an installed entry, and every directory one of those paths lies in. An unverified entry may hold
 * any regular files and directories, but no link and no node_modules beyond the one holding its own
 * locked dependencies. Returns one line per missing, changed or unexpected path. */
export function installationDifferences(project, closure) {
  const { files, links, unverified, directories } = expectedPaths(closure);
  const differences = [];
  const seen = new Set();
  const visit = (directory, opaque) => {
    let items;
    try { items = readdirSync(join(project, directory), { withFileTypes: true }); }
    catch (error) { if (error?.code === "ENOENT") return; throw error; }
    for (const item of items.sort((a, b) => a.name < b.name ? -1 : 1)) {
      const path = `${directory}/${item.name}`;
      seen.add(path);
      if (links.has(path) && !item.isSymbolicLink()) differences.push("expected executable link: " + path);
      else if (item.isDirectory() && (unverified.has(path) || directories.has(path))) visit(path, unverified.has(path));
      else if (opaque && item.isDirectory() && item.name !== "node_modules") visit(path, true);
      else if (opaque && item.isFile()) continue;
      else if (item.isSymbolicLink() && links.has(path)) {
        const text = readlinkSync(join(project, path));
        const target = posix.isAbsolute(text) ? text : posix.join(posix.dirname(path), text);
        if (!links.get(path).has(target)) differences.push(`link to an unexpected target: ${path} -> ${text}`);
      } else if (item.isFile() && files.has(path)) {
        if (lstatSync(join(project, path)).nlink > 1) differences.push("hard link: " + path);
        else if (files.get(path) !== null && fileDigest(readFileSync(join(project, path))) !== files.get(path)) {
          differences.push("changed: " + path);
        }
      } else differences.push(`unexpected ${entryKind(item)}: ${path}`);
    }
  };
  visit("node_modules", false);
  for (const path of [...files.keys(), ...links.keys(), ...unverified]) {
    if (path !== HIDDEN_LOCKFILE && !seen.has(path)) differences.push("missing: " + path);
  }
  return differences;
}

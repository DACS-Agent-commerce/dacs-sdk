// Authenticate cached npm archives and read their extracted package files.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
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
const tarText = (header, [start, end]) => header.toString("utf8", start, end).replace(/\0.*$/s, "");
const tarNumber = (header, field) => {
  const text = tarText(header, field).trim();
  return text === "" ? 0 : /^[0-7]+$/.test(text) ? Number.parseInt(text, 8) : Number.NaN;
};
const validChecksum = header => tarNumber(header, TAR_CHECKSUM) ===
  header.reduce((sum, byte, index) => sum + (index >= TAR_CHECKSUM[0] && index < TAR_CHECKSUM[1] ? 0x20 : byte), 0);
const isEscapingPath = path => path.split("/").some(part => part === "" || part === "." || part === "..");

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
 * a bad checksum or size, a nonzero directory size, nonzero data after the end block, a PAX size
 * override, an unsupported entry type, an escaping or duplicate path, or no package.json. PAX sizes
 * equal to the file header size are supported. */
export function packedFiles(archive) {
  const tar = gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_ARCHIVE_BYTES });
  const files = new Map();
  let longName;
  let paxSize;
  for (let offset = 0, entries = 0; ; entries += 1) {
    if (offset + TAR_BLOCK > tar.length) throw new Error("truncated packed tarball: no end-of-archive block");
    const header = tar.subarray(offset, offset + TAR_BLOCK);
    if (header.every(byte => byte === 0)) {
      if (tar.subarray(offset + TAR_BLOCK).some(byte => byte !== 0)) throw new Error("packed tarball has a malformed trailer");
      break;
    }
    if (entries === MAX_ARCHIVE_ENTRIES) throw new Error(`packed tarball has more than ${MAX_ARCHIVE_ENTRIES} entries`);
    if (!validChecksum(header)) throw new Error("packed tarball header has a bad checksum");
    const size = tarNumber(header, TAR_SIZE);
    if (!Number.isSafeInteger(size)) throw new Error("packed tarball entry has a malformed size");
    const type = String.fromCharCode(header[TAR_TYPE] || 48);
    // npm treats directory sizes as zero, so advancing over their bodies could hide file headers.
    if (type === "5" && size !== 0) throw new Error("packed tarball directory has a nonzero size");
    const next = offset + TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    if (next > tar.length) throw new Error("truncated packed tarball entry");
    const data = tar.subarray(offset + TAR_BLOCK, offset + TAR_BLOCK + size);
    offset = next;
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


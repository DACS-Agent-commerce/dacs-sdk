// Archive authentication and extraction use the same trusted npm as installation.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { gunzipSync } from "node:zlib";

/** Hard ceilings for external archives and isolated npm subprocesses. Tests may use smaller limits. */
export const ARCHIVE_LIMITS = Object.freeze({ archiveBytes: 256 * 1024 * 1024,
  unpackedBytes: 512 * 1024 * 1024, entries: 100_000, timeout: 120_000, outputBytes: 1024 * 1024 });
const TAR_BLOCK = 512;
const FILE_TYPES = new Set(["File", "OldFile", "ContiguousFile"]);
const SKIPPED_TYPES = new Set(["Link", "SymbolicLink", "CharacterDevice", "BlockDevice", "Directory", "FIFO"]);

function boundedLimits(overrides = {}) {
  const limits = { ...ARCHIVE_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > ARCHIVE_LIMITS[key]) throw new Error("invalid archive limit: " + key);
  }
  return limits;
}

/** Selects the executing npm (or npm on PATH), its Node binary and actual platform. */
export function npmToolchain() {
  const cli = process.env.npm_execpath ?? join(execFileSync("npm", ["root", "--global"],
    { encoding: "utf8", timeout: ARCHIVE_LIMITS.timeout, maxBuffer: ARCHIVE_LIMITS.outputBytes }).trim(), "npm/bin/npm-cli.js");
  return { node: process.execPath, cli: realpathSync(cli), platform: process.platform, arch: process.arch };
}

/** Runs a selected npm's Node subprocess with a deadline and output bound; retains failure causes. */
export function runNpmNode(toolchain, args, options = {}, overrides) {
  const limits = boundedLimits(overrides);
  try {
    return execFileSync(toolchain.node, args, { ...options, timeout: limits.timeout,
      maxBuffer: limits.outputBytes, killSignal: "SIGKILL", stdio: ["pipe", "pipe", "pipe"] });
  } catch (cause) {
    throw new Error(`npm subprocess failed (${cause.code ?? cause.status ?? cause.signal}): ${cause.stderr?.toString() ?? cause.message}`, { cause });
  }
}

// The trusted parser advances its own cursor. We feed fixed blocks solely to
// observe its terminator event and refuse any later nonzero bytes.
function validateFraming(tar, toolchain, limits) {
  // npm 10.8 and earlier bundle tar 6, which names the parser class `Parse`.
  const tarModule = createRequire(toolchain.cli)("tar");
  const Parser = tarModule.Parser ?? tarModule.Parse;
  let block;
  let terminated = false;
  let entries = 0;
  const files = new Set();
  const ancestors = new Set();
  const count = () => {
    if (++entries > limits.entries) throw new Error(`packed tarball has more than ${limits.entries} entries`);
  };
  const parser = new Parser({
    onwarn: (code, message) => { throw new Error(`packed tarball ${code}: ${message}`); },
    filter: (name, entry) => {
      count();
      const rawSize = block.toString("ascii", 124, 136).replace(/\0.*$/s, "").trim();
      if (!/^[0-7]*$/.test(rawSize)) throw new Error("packed tarball entry has a malformed size");
      const size = Number.parseInt(rawSize || "0", 8);
      if (entry.type === "Directory" && size !== 0) throw new Error("packed tarball directory has a nonzero size");
      if (entry.type !== "Directory" && size !== entry.size) throw new Error("pax size differs from the entry header in the packed tarball");
      if (SKIPPED_TYPES.has(entry.type)) return false;
      if (!FILE_TYPES.has(entry.type)) throw new Error("unsupported entry type in the packed tarball: " + entry.type);
      const path = name.split("/").slice(1).join("/");
      if (name.startsWith("/") || path.split("/").some(part => !part || part === "." || part === "..") || path.includes("\\")) {
        throw new Error("packed tarball entry escapes the package: " + name);
      }
      if (files.has(path)) throw new Error("duplicate packed tarball entry: " + name);
      if (ancestors.has(path)) throw new Error("packed tarball file/ancestor conflict: " + name);
      for (let parent = posix.dirname(path); parent !== "."; parent = posix.dirname(parent)) {
        if (files.has(parent)) throw new Error("packed tarball file/ancestor conflict: " + name);
        ancestors.add(parent);
      }
      files.add(path);
      return true;
    },
  });
  parser.on("entry", entry => entry.resume());
  parser.on("ignoredEntry", entry => { if (entry.meta) throw new Error("packed tarball metadata is too large"); });
  parser.on("meta", data => {
    count();
    for (const match of data.matchAll(/(?:^|\n)\d+ size=([^\n]*)\n/g)) {
      if (!/^(0|[1-9][0-9]*)$/.test(match[1])) throw new Error("malformed pax size in the packed tarball");
    }
  });
  parser.on("nullBlock", () => { terminated = true; });
  for (let offset = 0; offset < tar.length; offset += TAR_BLOCK) {
    block = tar.subarray(offset, offset + TAR_BLOCK);
    if (terminated) {
      if (block.some(byte => byte !== 0)) throw new Error("packed tarball has a malformed trailer");
    } else parser.write(block);
  }
  parser.end();
  if (!terminated) throw new Error("truncated packed tarball: no end-of-archive block");
  if (!files.has("package.json")) throw new Error("packed tarball has no package.json");
}

const EXTRACT = `
const { createRequire } = require('node:module');
const { join } = require('node:path');
const [cli, scratch, count] = process.argv.slice(1);
process.on('log', (level, title, ...messages) => {
  if (level === 'warn' || level === 'error') throw new Error(title + ': ' + messages.join(' '));
});
const pacote = createRequire(cli)('pacote');
(async () => {
  for (let index = 0; index < Number(count); index++) {
    await pacote.extract(join(scratch, index + '.tgz'), join(scratch, 'package-' + index),
      { offline: true, ignoreScripts: true, cache: join(scratch, 'cache') });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

/** Extracts a Map of independently supplied archive bytes with the selected npm's pacote
 * in one bounded worker. Returns a Map of labels to file Maps only after every extraction
 * succeeds. Refuses framing/path ambiguity, warnings, limits and missing package.json. */
export function packedFileSets(archives, toolchain = npmToolchain(), overrides) {
  const limits = boundedLimits(overrides);
  const sources = [...archives];
  if (sources.length > limits.entries) throw new Error("too many package archives");
  for (const [label, archive] of sources) {
    try {
      if (archive.length > limits.archiveBytes) throw new Error("archive is larger than " + limits.archiveBytes + " bytes");
      const tar = gunzipSync(archive, { maxOutputLength: limits.unpackedBytes });
      validateFraming(tar, toolchain, limits);
    } catch (cause) { throw new Error(`cannot extract archive ${label}: ${cause.message}`, { cause }); }
  }
  const scratch = mkdtempSync(join(tmpdir(), "dacs-npm-archive-"));
  try {
    for (const [index, [, bytes]] of sources.entries()) writeFileSync(join(scratch, index + ".tgz"), bytes);
    runNpmNode(toolchain, ["-e", EXTRACT, toolchain.cli, scratch, String(sources.length)], {}, limits);
    const results = new Map();
    for (const [index, [label]] of sources.entries()) {
      const destination = join(scratch, "package-" + index);
      const files = new Map();
      const visit = directory => {
        for (const item of readdirSync(join(destination, directory), { withFileTypes: true })) {
          const path = directory ? `${directory}/${item.name}` : item.name;
          if (item.isDirectory()) visit(path);
          else if (item.isFile() && lstatSync(join(destination, path)).nlink === 1) files.set(path, readFileSync(join(destination, path)));
          else throw new Error("unexpected extracted entry: " + path);
        }
      };
      visit("");
      if (!files.has("package.json")) throw new Error("packed tarball has no package.json: " + label);
      results.set(label, files);
    }
    return results;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** Returns one archive's npm-extracted file Map; applies the same limits and refusals as packedFileSets.
 * Source identity must be authenticated separately with verifyArchive or cachedArchive. */
export function packedFiles(archive, toolchain = npmToolchain(), overrides) {
  return packedFileSets(new Map([["package", archive]]), toolchain, overrides).get("package");
}

function sha512Digest(integrity) {
  const digests = typeof integrity !== "string" ? [] : integrity.trim().split(/\s+/)
    .map(token => /^sha512-([A-Za-z0-9+/]{86}==)(?:\?[!-~]*)?$/.exec(token)?.[1]).filter(Boolean);
  return new Set(digests).size === 1 ? digests[0] : null;
}

/** Independently authenticates source bytes against one sha512 SRI; throws on a mismatch or size limit. */
export function verifyArchive(bytes, integrity, overrides) {
  const limits = boundedLimits(overrides);
  const digest = sha512Digest(integrity);
  if (digest === null) throw new Error(`integrity has no single sha512 digest: ${String(integrity)}`);
  if (bytes.length > limits.archiveBytes) throw new Error("archive is larger than " + limits.archiveBytes + " bytes");
  if (createHash("sha512").update(bytes).digest("base64") !== digest) throw new Error("archive does not match its integrity");
  return bytes;
}

/** Returns independently verified bytes from npm's content-addressed cache. Throws on missing,
 * oversized, mismatched or non-sha512 content; preserves the underlying read error as its cause. */
export function cachedArchive(cache, integrity, overrides) {
  const limits = boundedLimits(overrides);
  const digest = sha512Digest(integrity);
  if (digest === null) throw new Error(`integrity has no single sha512 digest: ${String(integrity)}`);
  const hex = Buffer.from(digest, "base64").toString("hex");
  const path = join(cache, "_cacache", "content-v2", "sha512", hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
  try {
    if (statSync(path).size > limits.archiveBytes) throw new Error("cached archive is larger than " + limits.archiveBytes + " bytes");
    return verifyArchive(readFileSync(path), integrity, limits);
  } catch (cause) {
    throw new Error(`cannot read npm's cached archive for ${integrity} (${cause.code ?? cause.message})`, { cause });
  }
}

// Archive authentication and extraction use the same trusted npm as installation.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Hard ceilings for external archives and isolated npm subprocesses. Tests may use smaller limits. */
export const ARCHIVE_LIMITS = Object.freeze({ archiveBytes: 256 * 1024 * 1024,
  unpackedBytes: 512 * 1024 * 1024, entries: 100_000, timeout: 120_000, outputBytes: 1024 * 1024,
  pathBytes: 4096, pathDepth: 128 });
const ARCHIVE_WORKER = fileURLToPath(new URL("./installation-archive-worker.mjs", import.meta.url));

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

/** Extracts a Map of independently supplied archive bytes with the selected npm's pacote.
 * Returns a Map of labels to file Maps only after every extraction succeeds. Validation
 * and extraction run in separate workers, each with its full deadline. Throws on
 * framing/path ambiguity, warnings, byte/depth limits and missing package.json. */
export function packedFileSets(archives, toolchain = npmToolchain(), overrides) {
  const limits = boundedLimits(overrides);
  const sources = [...archives];
  if (sources.length > limits.entries) throw new Error("too many package archives");
  for (const [label, archive] of sources) {
    if (archive.length > limits.archiveBytes) throw new Error(`cannot extract archive ${label}: archive is larger than ${limits.archiveBytes} bytes`);
  }
  const scratch = mkdtempSync(join(tmpdir(), "dacs-npm-archive-"));
  try {
    for (const [index, [, bytes]] of sources.entries()) writeFileSync(join(scratch, index + ".tgz"), bytes);
    writeFileSync(join(scratch, "sources.json"), JSON.stringify({ limits, labels: sources.map(([label]) => label) }));
    try {
      for (const phase of ["validate", "extract"]) {
        runNpmNode(toolchain, [ARCHIVE_WORKER, toolchain.cli, scratch, phase], {}, limits);
      }
    }
    catch (cause) {
      const failure = join(scratch, "failure.json");
      if (existsSync(failure)) throw new Error(JSON.parse(readFileSync(failure, "utf8")).message, { cause });
      throw cause;
    }
    const paths = JSON.parse(readFileSync(join(scratch, "files.json"), "utf8"));
    const results = new Map();
    for (const [index, [label]] of sources.entries()) {
      const destination = join(scratch, "package-" + index);
      results.set(label, new Map(paths[index].map(path => [path, readFileSync(join(destination, path))])));
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

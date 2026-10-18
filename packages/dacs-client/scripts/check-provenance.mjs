#!/usr/bin/env node
// Provenance check for the verbatim copy in @kynesyslabs/dacs-client.
//
//   node packages/dacs-client/scripts/check-provenance.mjs --source <frontend repo> [--package-dir <dir>]
//   node packages/dacs-client/scripts/check-provenance.mjs --local-only [--package-dir <dir>]
//
// The acceptance gate is the --source form. It binds the manifest's top-level
// sourceCommit and every entry's sourceCommit to the trusted commits below
// (the manifest is input, not authority), and binds the manifest's copy set
// (every entry's path, role, sourcePath and sourceCommit) to the set pinned
// below, so a file dropped, added or re-labelled together with its entry
// fails. It recomputes the SHA-256 of every entry, reads each source blob at
// that commit and fails if its hash differs, and fails on any missing file,
// any entry whose destination is not the mapped source path, and any file
// under the package's src/ or test/ that the manifest does not list.
//
// --local-only runs the same checks without reading source blobs. It is NOT an
// acceptance check: a copied file edited together with its manifest hash
// passes it. It exists for quick local runs and says so in its output.
//
// Exits non-zero on any failure, and with 2 on a usage error. --package-dir
// checks a copy of the package elsewhere (default: the package that contains
// this script).
//
// Git reads the repository --source names (or, when --source is a
// subdirectory of a repository, that enclosing repository), with replace
// objects off and without inherited GIT_* variables (source-git.mjs), so
// neither a replace ref in the source repository nor a GIT_DIR,
// GIT_OBJECT_DIRECTORY or alternates variable in the caller's environment
// can change the bytes read. Git does not re-hash
// objects when it reads them: a source repository whose own object store was
// altered (a rewritten loose object, or an objects/info/alternates file that
// names an altered store) can return other bytes under the trusted commit, and
// this check would accept a copy edited to match them. The gate therefore
// trusts the --source object store. Run it on a repository whose objects were
// verified, for example with `git fsck` or by a clone over the pack protocol
// (`git clone --no-local`), whose index-pack re-hashes every object it
// receives; a plain local clone links or copies the objects unverified.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDeltas, pkg as DELTA_PACKAGE, BASELINE } from "./delta-map.mjs";
import { CLIENT_PACKAGE_DIR, mapSourcePath } from "./path-mapping.mjs";
import { sourceGit as git } from "./source-git.mjs";

const PACKAGE = "@kynesyslabs/dacs-client";
const SOURCE_REPOSITORY = "DACS-Agent-commerce/frontend";
// Step 1: frontend main at the plan's citation commit. The only commit the
// manifest may name at the top level, and the only one allowed for src/test.
const STEP1_COMMIT = "82bf8c4dabb2332a72f618f6cc29950e48d6feb6";
// Exact per-file commits allowed besides STEP1_COMMIT, as "sourcePath@commit".
// The the source change/the source change port sources the brief allows (heads 5274f18 and febba6c, PLAN
// §0.3 seller row) belong to the seller step; the client brief allows none
// (the source change's two buyer-side diffs are an open coordinator item, the source change is D15), so
// this list is empty. Adding a pair is a reviewed change to this file.
const ALLOWED_FILE_COMMITS = Object.freeze([]);
// Later heads recorded in IMPORT-CUT-MAP.md §8. They are not allowed; they are
// named here so that a failure says which head an entry points at.
const KNOWN_HEADS = new Map([
  ["02f7070ddff7bf9e94ffd9a953ccc2f0af56caba", "the source change inspected head (D15, not ported in step 1)"],
  ["8a24e52c5ca41096b26d2b126485905d0faa05fb", "the source change plan head (D15, not ported in step 1)"],
  ["786aa1d9d6b6393190a6f388a4b92cb921af1fc6", "the source change inspected head (seller step)"],
  ["5274f18541ac0e8c77e3e71463bb6c811f048922", "the source change plan head (seller step)"],
  ["ffef873a58a1e71f3a91ae159d92a549992c3857", "the source change inspected head (seller step; buyer-side diffs open)"],
  ["febba6cc2e732a59124eb39f33a50f017d4e3d4c", "the source change plan head (seller step)"],
]);
// The step-1 copy set: the [path, role, sourcePath, sourceCommit] row of every
// file copy-verbatim.mjs selects at STEP1_COMMIT, sorted by path, one JSON
// array per line (copySet below). Pinned here, not read from the manifest.
// check-provenance.test.mjs re-derives it from the source repo by the copy
// rule. Changing it is a reviewed change to this file.
const EXPECTED_COPY_SET = Object.freeze({
  files: 329,
  src: 52,
  test: 277,
  sha256: "1da2dc790896a42966be4cc62bf389d4ab67719555f53f2a79ab9d5aa3d87d9f",
});

const ROLES = new Set(["src", "test"]);
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const USAGE = "usage: check-provenance.mjs (--source <frontend repo> | --local-only) [--package-dir <dir>]";

class UsageError extends Error {}

function parseArgs(argv) {
  const args = { source: null, localOnly: false, packageDir: join(dirname(fileURLToPath(import.meta.url)), "..") };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--source") args.source = argv[++i];
    else if (argv[i] === "--local-only") args.localOnly = true;
    else if (argv[i] === "--package-dir") args.packageDir = argv[++i];
    else throw new UsageError(`unknown argument ${argv[i]}; ${USAGE}`);
  }
  // An empty value (an unset variable in `--source "$REPO"`) is missing, not a
  // request for the hash-only mode.
  if ([args.source, args.packageDir].some((value) => value === undefined || value === "")) throw new UsageError(`missing option value; ${USAGE}`);
  if ((args.source !== null) === args.localOnly) throw new UsageError(USAGE);
  return args;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const named = (commit) => (KNOWN_HEADS.has(commit) ? ` (${KNOWN_HEADS.get(commit)})` : "");

function copySet(files) {
  const rows = files.map((entry) => [entry?.path, entry?.role, entry?.sourcePath, entry?.sourceCommit])
    .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0));
  const count = (role) => rows.filter((row) => row[1] === role).length;
  return { files: rows.length, src: count("src"), test: count("test"), sha256: sha256(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`) };
}

function commitAllowed(entry) {
  return entry.sourceCommit === STEP1_COMMIT || ALLOWED_FILE_COMMITS.includes(`${entry.sourcePath}@${entry.sourceCommit}`);
}

function walk(root, dir, out) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (error.code === "ENOENT") return out;
    throw error;
  }
  for (const name of names) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) walk(root, path, out);
    else out.push({ rel: relative(root, path).split(sep).join("/"), regular: stat.isFile() });
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const failures = [];
  const manifest = JSON.parse(readFileSync(join(args.packageDir, "PROVENANCE.json"), "utf8"));
  const prefix = `${CLIENT_PACKAGE_DIR}/`;
  const deltaMode = args.packageDir === DELTA_PACKAGE && existsSync(join(args.packageDir, 'DELTA-LEDGER.json'));
  const deltaResult = deltaMode ? checkDeltas(args.packageDir) : null;
  if (deltaResult) failures.push(...deltaResult.failures);
  const listed = new Set();
  if (manifest.package !== PACKAGE) failures.push(`manifest package ${JSON.stringify(manifest.package)} is not ${PACKAGE}`);
  if (manifest.sourceRepository !== SOURCE_REPOSITORY) failures.push(`manifest sourceRepository ${JSON.stringify(manifest.sourceRepository)} is not ${SOURCE_REPOSITORY}`);
  if (manifest.sourceCommit !== STEP1_COMMIT) failures.push(`manifest sourceCommit ${JSON.stringify(manifest.sourceCommit)}${named(manifest.sourceCommit)} is not the trusted step-1 commit ${STEP1_COMMIT}`);
  if (args.source !== null) {
    let resolved = null;
    try {
      resolved = git(["-C", args.source, "rev-parse", "--verify", "--quiet", `${STEP1_COMMIT}^{commit}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      // reported below
    }
    if (resolved !== STEP1_COMMIT) failures.push(`source repository has no commit ${STEP1_COMMIT}`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) failures.push("manifest lists no files");
  for (const entry of manifest.files ?? []) {
    const label = entry?.path ?? JSON.stringify(entry);
    if (typeof entry?.path !== "string" || !entry.path.startsWith(prefix)) { failures.push(`${label}: path is not under ${prefix}`); continue; }
    if (listed.has(entry.path)) { failures.push(`${label}: listed twice`); continue; }
    listed.add(entry.path);
    if (!ROLES.has(entry.role)) failures.push(`${label}: unknown role ${JSON.stringify(entry.role)}`);
    const commitOk = HEX40.test(entry.sourceCommit ?? "") && commitAllowed(entry);
    if (!HEX40.test(entry.sourceCommit ?? "")) failures.push(`${label}: sourceCommit is not a full commit hash`);
    else if (!commitOk) failures.push(`${label}: sourceCommit ${entry.sourceCommit}${named(entry.sourceCommit)} is not on the checker's allowed list (step 1: ${STEP1_COMMIT})`);
    if (!HEX64.test(entry.sha256 ?? "")) failures.push(`${label}: sha256 is not a SHA-256 hex digest`);
    let mapped = null;
    try {
      mapped = mapSourcePath(entry.sourcePath);
    } catch (error) {
      failures.push(`${label}: ${error.message}`);
    }
    if (mapped !== null && mapped !== entry.path) failures.push(`${label}: destination is not the mapped source path ${mapped}`);
    if (mapped !== null && !mapped.startsWith(`${prefix}${entry.role}/`)) failures.push(`${label}: role ${entry.role} does not match its directory`);
    const local = join(args.packageDir, entry.path.slice(prefix.length));
    // Publication mode authenticates the original manifest against the pinned
    // historical evidence and checks all destination changes from the shipped
    // publication checkpoint. Original source bytes are checked by --source;
    // no local-only run claims to recover the unavailable original Git tree.
    let bytes = null;
    try {
      if (deltaMode) bytes = null;
      else if (!lstatSync(local).isFile()) failures.push(`${label}: not a regular file`);
      else bytes = readFileSync(local);
    } catch (error) {
      failures.push(`${label}: ${error.code === "ENOENT" ? "missing" : error.message}`);
    }
    if (bytes !== null && sha256(bytes) !== entry.sha256) failures.push(`${label}: SHA-256 mismatch (file ${sha256(bytes)}, manifest ${entry.sha256})`);
    if (args.source !== null && commitOk && mapped !== null) {
      let source = null;
      try {
        source = git(["-C", args.source, "cat-file", "blob", `${entry.sourceCommit}:${entry.sourcePath}`], { maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        failures.push(`${label}: source blob ${entry.sourceCommit}:${entry.sourcePath} not readable`);
      }
      if (source !== null && sha256(source) !== entry.sha256) failures.push(`${label}: source blob SHA-256 ${sha256(source)} differs from manifest`);
    }
  }
  const set = copySet(Array.isArray(manifest.files) ? manifest.files : []);
  const want = EXPECTED_COPY_SET;
  if (set.sha256 !== want.sha256) failures.push(`copy set (${set.files} entries: src ${set.src}, test ${set.test}; digest ${set.sha256}) is not the pinned step-1 set (${want.files} entries: src ${want.src}, test ${want.test}; digest ${want.sha256}); an entry was dropped, added or changed its path, role, sourcePath or sourceCommit (compare with copy-verbatim.mjs --plan)`);
  for (const dir of ["src", "test"]) {
    for (const file of walk(args.packageDir, join(args.packageDir, dir), [])) {
      const path = `${prefix}${file.rel}`;
      if (!listed.has(path) && !deltaResult?.allowed.has(path)) failures.push(`${path}: not in the manifest`);
      else if (!file.regular) failures.push(`${path}: not a regular file`);
    }
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    console.error(`[check-provenance] ${failures.length} failure(s) in ${listed.size} manifest entries`);
    process.exitCode = 1;
    return;
  }
  const count = (role) => manifest.files.filter((entry) => entry.role === role).length;
  const files = `${listed.size} files match PROVENANCE.json (src ${count("src")}, test ${count("test")}) and the pinned step-1 copy set`;
  if (args.source !== null) console.log(`[check-provenance] OK (acceptance check): ${files}; every source commit is the trusted ${STEP1_COMMIT}; source blobs verified${deltaMode ? "; publication checkpoint verified; every later change and deletion enumerated; generated delta map matches" : ""}`);
  else console.log(`[check-provenance] LOCAL HASH CHECK ONLY, NOT AN ACCEPTANCE CHECK: ${files}; commits bound to ${STEP1_COMMIT}; source blobs not verified (run with --source <frontend repo> for the acceptance gate)`);
}

try {
  main();
} catch (error) {
  console.error(`[check-provenance] ${error.message}`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}

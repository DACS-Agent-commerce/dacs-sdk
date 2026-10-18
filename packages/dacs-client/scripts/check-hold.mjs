#!/usr/bin/env node
// client package step-1 freeze, not a module graph or behavioural load check.
//
//   node packages/dacs-client/scripts/check-hold.mjs [--package-dir <dir>] [--repo-root <dir>]
//
// HOLD.json pins the complete package file set and the Git blob of every
// ordinary file, including package.json bytes (exports: {}, no main or bin).
// HOLD.json and this gate are the reviewed control pair: changing a pin or
// lifting the hold requires changing both in the same reviewed commit. The
// gate pins both the canonical record and its exact bytes, with only its
// own blob field normalized to zeros to avoid a hash cycle. The record pins
// the actual gate blob; a gate-only or record-only edit fails. The gate itself
// is trusted executable code, as with any repository check.
//
// Outside the package, HOLD.json pins the complete inventory of repository
// files at the frozen work head, with their Git blobs. List tracked files
// in HEAD and the index (tracked ignored output counts), plus unignored
// untracked files. Require index entries and working files to match HEAD,
// with no extension or directory filter, and fail on any added, removed or
// changed outside file in any of those states, whatever it contains. A caller
// that computes, escapes or encodes the path is still an added or changed file.
// As an extra tripwire only, also report a literal dacs-client in an outside path or file; the root
// lockfile's workspace registration is its one exception. The tripwire is not
// what makes the outside rule hold. Git errors, unreadable files and symlinks
// fail closed. Any other repository change (lockfile, another workspace, a
// rebase, a delta commit) fails until a reviewed re-pin of the control pair.
//
// Limits: untracked files Git ignores (build output, .git/info/exclude, a
// global excludes file) are unseen; they belong to no commit, so they cannot
// reach review or a merge. Code outside this repository is unseen. Blobs are
// pinned; regular-file modes must agree across HEAD, index and working tree.
// HEAD and index symlinks, gitlinks and unresolved entries are refused.
// A repository with no HEAD fails closed. For step 1 the package cannot acquire
// new code or exports, so callable surfaces wait for reviewed deltas and the D15
// regressions. This check executes no package entry point and makes no
// network-isolation claim. No root install needed.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
// Keep the gate self-contained: do not execute a mutable package helper.
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
const sourceGit = (args, options = {}) => execFileSync("git", ["--no-replace-objects", ...args], { ...options, env: GIT_ENV });

const PACKAGE = "@kynesyslabs/dacs-client";
const PACKAGE_PREFIX = "packages/dacs-client/";
const USAGE = "usage: check-hold.mjs [--package-dir <dir>] [--repo-root <dir>]";
class UsageError extends Error {}

export const PINNED = Object.freeze({
  holdSha256: "a2a8601934d771a6bc8eb11e9b42751a90ef3530a6a390bfde434a90da842287",
  holdBytesSha256: "cf3f651c017ea1f1df21701151f9b4693d70be2405b007fc961bc0c934c99f73",
  schema: "dacs-client-hold/v1",
  package: PACKAGE,
  gate: "packages/dacs-client/scripts/check-hold.mjs",
  id: "inherited-stale-pointer",
  status: "lifted",
  delta: "D15",
  sourceRepository: "DACS-Agent-commerce/frontend",
  sourceCommit: "82bf8c4dabb2332a72f618f6cc29950e48d6feb6",
  files: Object.freeze([
    Object.freeze({ path: "packages/dacs-client/src/purchases.mjs", sourcePath: "http-mcp/src/purchases.mjs", heldBlob: "ee71c89fcfa2ef7fa44716084a810e546343452c", lines: Object.freeze(["666", "789", "811", "905", "927-934"]) }),
    Object.freeze({ path: "packages/dacs-client/src/dacs/wallet-transactions.mjs", sourcePath: "http-mcp/src/dacs/wallet-transactions.mjs", heldBlob: "948107e13dba08f162dd3f1b27968b2eae96d799", lines: Object.freeze(["114"]) }),
  ]),
  regressions: Object.freeze(["completion-orders", "existing-b-observation", "other-purchase-lane", "restart", "unauthenticated-pointer", "agreement-delivery", "same-hash-terminal", "native-supersession", "single-node-payment-transfer"]),
  liftCondition: "Every regression above passes against the reviewed destination head carrying D15's delta commit in this package (or a reviewed source fix copied with provenance).",
  probe: "packages/dacs-client/scripts/stale-pointer.probe.test.mjs",
  blockedPrerequisites: Object.freeze([
    Object.freeze({ id: "sdk-ci", what: "Add the freeze gate and its negative tests (npm test --workspace @kynesyslabs/dacs-client) to the SDK CI workflow before any client delta PR. The gate reads files and Git metadata only; it imports no client entry point." }),
    Object.freeze({ id: "d11-transaction-contract", what: "D11 must supply a synchronous, re-entrant, serializing transaction (BEGIN IMMEDIATE or equivalent), with nested calls joining the outer transaction. Before any live wiring, rerun test/purchase-integrity.test.mjs, test/purchase-review-races.test.mjs and test/readback-review-decisions.test.mjs against the real PurchaseStore adapter, including both completion orders, same-hash terminal decisions, native supersession and restart." }),
    Object.freeze({ id: "dec16-testnet-admission", what: "Before live wiring, D2/D4 must consume the approved immutable DEC-16 testnet identity record, reject missing or fixture pins and non-approved identities before effects, and rerun the instrumented zero-signature and zero-broadcast cases." }),
  ]),
});

function parseArgs(argv) {
  const args = { packageDir: join(dirname(fileURLToPath(import.meta.url)), ".."), repoRoot: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--package-dir") args.packageDir = argv[++i];
    else if (argv[i] === "--repo-root") args.repoRoot = argv[++i];
    else throw new UsageError(`unknown argument ${argv[i]}; ${USAGE}`);
  }
  if ([args.packageDir, args.repoRoot].some((value) => value === undefined || value === "")) throw new UsageError(`missing option value; ${USAGE}`);
  args.packageDir = realpathSync(args.packageDir);
  args.repoRoot = realpathSync(args.repoRoot ?? join(args.packageDir, "..", ".."));
  return args;
}

const gitBlob = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";
const show = (value) => (value === undefined ? "missing" : JSON.stringify(value));

const sortKeys = (value) => (Array.isArray(value) ? value.map(sortKeys)
  : value !== null && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])])) : value);
// The reciprocal gate blob is the only normalized value. All other record
// content is pinned, including every package blob, field and text. The gate
// blob itself is checked against this executable, below.
function normalizedRecord(record) {
  const copy = structuredClone(record);
  const gate = copy?.step1Freeze?.files?.["scripts/check-hold.mjs"];
  if (/^[0-9a-f]{40}$/.test(gate?.blob)) gate.blob = "0".repeat(40);
  return copy;
}
export const canonicalSha256 = (record) => sha256(Buffer.from(JSON.stringify(sortKeys(normalizedRecord(record))), "utf8"));
const recordBytesSha256 = (bytes) => sha256(bytes.toString("utf8").replace(/("scripts\/check-hold\.mjs":\s*\{[^}]*?"blob":\s*")[0-9a-f]{40}(")/, (_, before, after) => before + "0".repeat(40) + after));

function readJson(path, label, failures) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    failures.push(`${label} ${error.code === "ENOENT" ? "is missing" : `is unreadable: ${error.message}`}`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    failures.push(`${label} is not valid JSON: ${error.message}`);
    return null;
  }
}

// HOLD.json against PINNED. Returns the failures; empty when the record is the
// pinned one.
export function checkRecord(record) {
  const failures = [];
  const differs = (field, actual, pinned) => failures.push(`HOLD.json ${field} is ${show(actual)}; the gate pins ${JSON.stringify(pinned)}`);
  const missing = (field) => failures.push(`HOLD.json ${field} is missing or empty`);
  if (record === null || typeof record !== "object" || Array.isArray(record)) return ["HOLD.json is malformed: not an object"];
  for (const field of ["schema", "package", "gate"]) if (record[field] !== PINNED[field]) differs(field, record[field], PINNED[field]);
  const holds = Array.isArray(record.holds) ? record.holds : [];
  if (holds.length !== 1) failures.push(`HOLD.json holds has ${Array.isArray(record.holds) ? holds.length : "no"} entries; the gate pins exactly one (${PINNED.id})`);
  const hold = holds[0] ?? {};
  const at = `holds[0]`;
  for (const field of ["id", "status", "delta", "sourceRepository", "sourceCommit"]) if (hold[field] !== PINNED[field]) differs(`${at}.${field}`, hold[field], PINNED[field]);
  for (const field of ["title", "reason", "rule"]) if (!nonEmpty(hold[field])) missing(`${at}.${field}`);
  const files = Array.isArray(hold.files) ? hold.files : [];
  if (files.length !== PINNED.files.length) failures.push(`HOLD.json ${at}.files has ${files.length} held files; the gate pins ${PINNED.files.map((file) => file.path).join(", ")}`);
  PINNED.files.forEach((pinned, index) => {
    const file = files[index] ?? {};
    for (const field of ["path", "sourcePath", "heldBlob"]) if (file[field] !== pinned[field]) differs(`${at}.files[${index}].${field}`, file[field], pinned[field]);
    const lines = Array.isArray(file.lines) ? file.lines : [];
    const refs = lines.map((line) => line?.line);
    if (JSON.stringify(refs) !== JSON.stringify(pinned.lines)) differs(`${at}.files[${index}].lines`, refs, pinned.lines);
    lines.forEach((line, i) => { if (!nonEmpty(line?.what)) missing(`${at}.files[${index}].lines[${i}].what`); });
  });
  const lift = hold.liftRequires ?? {};
  if (!nonEmpty(lift.sourceFix)) missing(`${at}.liftRequires.sourceFix`);
  const regressions = Array.isArray(lift.regressions) ? lift.regressions : [];
  const ids = regressions.map((entry) => entry?.id);
  if (JSON.stringify(ids) !== JSON.stringify(PINNED.regressions)) differs(`${at}.liftRequires.regressions ids`, ids, PINNED.regressions);
  regressions.forEach((entry, i) => { if (!nonEmpty(entry?.case)) missing(`${at}.liftRequires.regressions[${i}].case`); });
  if (lift.condition !== PINNED.liftCondition) differs(`${at}.liftRequires.condition`, lift.condition, PINNED.liftCondition);
  if (lift.probe !== PINNED.probe) differs(`${at}.liftRequires.probe`, lift.probe, PINNED.probe);
  if (!nonEmpty(lift.probeResult)) missing(`${at}.liftRequires.probeResult`);
  const blocked = Array.isArray(hold.blockedPrerequisites) ? hold.blockedPrerequisites : [];
  const pinnedBlocked = PINNED.blockedPrerequisites.map(({ id, what }) => ({ id, what }));
  const actualBlocked = blocked.map((item) => ({ id: item?.id, what: item?.what }));
  if (JSON.stringify(actualBlocked) !== JSON.stringify(pinnedBlocked)) differs(`${at}.blockedPrerequisites`, actualBlocked, pinnedBlocked);
  blocked.forEach((item, i) => { if (!nonEmpty(item?.why)) missing(`${at}.blockedPrerequisites[${i}].why`); });
  const gateBlob = record.step1Freeze?.files?.["scripts/check-hold.mjs"]?.blob;
  if (gateBlob !== gitBlob(readFileSync(fileURLToPath(import.meta.url)))) failures.push("check-hold.mjs bytes differ from the gate blob pinned by HOLD.json");
  const digest = canonicalSha256(record);
  if (digest !== PINNED.holdSha256) {
    failures.push(`HOLD.json differs from the record the gate pins: canonical SHA-256 ${digest}, pinned ${PINNED.holdSha256}. Every field counts, text included (title, reason, rule, a line's what, liftRequires.sourceFix, a regression's case, probeResult, a prerequisite's why); changing the hold changes PINNED in check-hold.mjs in the same reviewed commit`);
  }
  return failures;
}

// Enumerate every package file, including ignored output and dot paths.
// Directories are containers; empty directories carry no executable bytes.
function packageFiles(dir, prefix = "", out = []) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const rel = prefix + name;
    const stat = lstatSync(path);
    if (stat.isDirectory()) packageFiles(path, `${rel}/`, out);
    else if (stat.isFile()) out.push(rel);
    else throw new Error(`${PACKAGE_PREFIX}${rel}: not a regular file (symlinks are refused)`);
  }
  return out;
}

// Read object identities directly, rather than relying on diff's stat cache,
// assume-unchanged or skip-worktree flags. The working files are hashed too.
function checkGitStates(repoRoot, frozen, failures) {
  const run = (...args) => sourceGit(["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: 64 << 20 });
  const head = new Map();
  for (const entry of run("ls-tree", "-r", "--full-tree", "-z", "HEAD").split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode, type, blob] = entry.slice(0, tab).split(" ");
    head.set(entry.slice(tab + 1), { mode, type, blob });
  }
  const index = new Map();
  for (const entry of run("ls-files", "--stage", "-z").split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode, blob, stage] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    if (stage !== "0") { failures.push(`${path}: unresolved index entry (stage ${stage})`); continue; }
    index.set(path, { mode, blob });
  }
  const pins = new Map([
    ...Object.entries(frozen.files).map(([path, pin]) => [PACKAGE_PREFIX + path, pin]),
    ...Object.entries(frozen.outside.files),
  ]);
  for (const path of new Set([...pins.keys(), ...head.keys(), ...index.keys()])) {
    const committed = head.get(path);
    const staged = index.get(path);
    const pin = pins.get(path);
    if (!committed) failures.push(`${path}: missing from HEAD; repository is frozen`);
    else {
      if (!pin) failures.push(`${path}: added in HEAD; repository is frozen`);
      if (committed.type !== "blob" || !/^100(644|755)$/.test(committed.mode)) failures.push(`${path}: HEAD entry is not a regular file`);
      if (pin?.blob && committed.blob !== pin.blob) failures.push(`${path}: HEAD blob differs from the freeze pin`);
      // HOLD.json has a reciprocal record pin instead of an ordinary blob pin.
      // Its exact working bytes were checked above, and must equal HEAD below.
    }
    if (staged && !/^100(644|755)$/.test(staged.mode)) failures.push(`${path}: index entry is not a regular file`);
    if (!committed || !staged || staged.blob !== committed.blob || staged.mode !== committed.mode) failures.push(`${path}: index differs from HEAD (path, blob or mode)`);
    if (!committed) continue;
    let stat;
    try { stat = lstatSync(join(repoRoot, path)); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      failures.push(`${path}: working file is missing from HEAD checkout`);
      continue;
    }
    const mode = stat.mode & 0o111 ? "100755" : "100644";
    if (!stat.isFile() || mode !== committed.mode || gitBlob(readFileSync(join(repoRoot, path))) !== committed.blob) failures.push(`${path}: working file differs from HEAD (bytes or mode)`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (relative(args.repoRoot, args.packageDir).split(sep).join("/") !== PACKAGE_PREFIX.slice(0, -1)) {
    throw new Error("package directory must be packages/dacs-client under the repository root");
  }
  const failures = [];
  const record = readJson(join(args.packageDir, "HOLD.json"), "HOLD.json", failures);
  if (record !== null) failures.push(...checkRecord(record));
  if (record === null || failures.length > 0) return finish(failures);
  if (recordBytesSha256(readFileSync(join(args.packageDir, "HOLD.json"))) !== PINNED.holdBytesSha256) failures.push("HOLD.json bytes differ from the pinned record");

  const frozen = record.step1Freeze;
  if (frozen?.schema !== "dacs-client-freeze/v2" || !frozen.files || !frozen.outside?.files || !frozen.literalNameTripwire?.exceptions) throw new Error("missing step-1 freeze record");
  const actual = new Set(packageFiles(args.packageDir));
  for (const path of actual) if (!Object.hasOwn(frozen.files, path)) failures.push(`${PACKAGE_PREFIX}${path}: added file; package is frozen`);
  for (const [path, pin] of Object.entries(frozen.files)) {
    if (!actual.has(path)) { failures.push(`${PACKAGE_PREFIX}${path}: missing file; package is frozen`); continue; }
    if (path === "HOLD.json" && pin.control === "record") continue;
    if (path === "scripts/check-hold.mjs" && pin.control === "gate") {
      // When checking another tree, its executable gate must match this one.
      if (!readFileSync(join(args.packageDir, path)).equals(readFileSync(fileURLToPath(import.meta.url)))) failures.push(`${PACKAGE_PREFIX}${path}: gate differs from the trusted running gate`);
      continue;
    }
    if (!/^[0-9a-f]{40}$/.test(pin.blob) || gitBlob(readFileSync(join(args.packageDir, path))) !== pin.blob) failures.push(`${PACKAGE_PREFIX}${path}: changed bytes; package is frozen`);
  }
  const pkg = readJson(join(args.packageDir, "package.json"), "package.json", failures);
  if (!pkg || JSON.stringify(pkg.exports) !== "{}" || Object.hasOwn(pkg, "main") || Object.hasOwn(pkg, "bin")) failures.push("package.json must retain exports: {} and no main or bin");

  // Use the Git index to include tracked ignored output, and --others for
  // newly added callers. No extension filter or directory skip list.
  const top = sourceGit(["-C", args.repoRoot, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  if (realpathSync(top) !== args.repoRoot) throw new Error("repo-root is not the Git worktree root");
  const listed = new Set(sourceGit(["-C", args.repoRoot, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8", maxBuffer: 64 << 20 }).split("\0").filter(Boolean));
  const inventory = frozen.outside.files;
  const frozenAt = `outside files are frozen at ${frozen.outside.pinnedAt}; a change needs a reviewed re-pin of HOLD.json and check-hold.mjs`;
  let outside = 0;
  for (const path of listed) {
    if (path.startsWith(PACKAGE_PREFIX)) continue;
    outside += 1;
    const pin = Object.hasOwn(inventory, path) ? inventory[path] : null;
    if (!pin) failures.push(`${path}: added file outside the package; ${frozenAt}`);
    const file = join(args.repoRoot, path);
    let stat;
    try { stat = lstatSync(file); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      failures.push(`${path}: missing file outside the package (indexed, not on disk); ${frozenAt}`);
      continue;
    }
    if (!stat.isFile()) { failures.push(`${path}: not a regular repository file`); continue; }
    const bytes = readFileSync(file);
    if (pin && (!/^[0-9a-f]{40}$/.test(pin.blob) || gitBlob(bytes) !== pin.blob)) failures.push(`${path}: changed file outside the package; ${frozenAt}`);
    // Tripwire only: the inventory above is what holds the outside rule.
    if (!Object.hasOwn(frozen.literalNameTripwire.exceptions, path) && (/dacs-client/i.test(path) || /dacs-client/i.test(bytes.toString("utf8")))) failures.push(`${path}: literal dacs-client outside the package (tripwire)`);
  }
  for (const path of Object.keys(inventory)) if (!listed.has(path)) failures.push(`${path}: missing file outside the package; ${frozenAt}`);
  checkGitStates(args.repoRoot, frozen, failures);
  finish(failures, { files: actual.size, outside, pinnedAt: frozen.outside.pinnedAt });
}

function finish(failures, summary) {
  if (failures.length) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    console.error(`[check-hold] ${failures.length} failure(s)`);
    process.exitCode = 1;
    return;
  }
  console.log(`[check-hold] OK: package frozen; pinned purchase status: ${PINNED.status}: ${PINNED.id} (${PINNED.delta}); package files (${summary.files} files, reviewed control pair included); exports: {}; outside inventory frozen (${summary.outside} files, exact blobs at ${summary.pinnedAt.slice(0, 12)}); HEAD blobs verified against pins; index and working files match HEAD (paths, blobs and regular-file modes); literal-name tripwire clear (lockfile registration excepted); no behavioural imports`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(`[check-hold] ${error.message}`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}

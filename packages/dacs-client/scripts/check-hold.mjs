#!/usr/bin/env node
// client package step-1 freeze, not a module graph or behavioural load check.
//
//   node packages/dacs-client/scripts/check-hold.mjs [--package-dir <dir>] [--repo-root <dir>]
//
// HOLD.json pins the complete package file set and the Git blob of every
// ordinary file, including the exact reviewed package.json bytes and explicit public exports.
// HOLD.json and this gate are the reviewed control pair: changing a pin or
// lifting the hold requires changing both in the same reviewed commit. The
// gate pins both the canonical record and its exact bytes, with only its
// own blob field normalized to zeros to avoid a hash cycle. The record pins
// the actual gate blob; a gate-only or record-only edit fails. The gate itself
// is trusted executable code, as with any repository check.
//
// Only this package is frozen. Other SDK files, commits and merge
// commits may evolve without re-pinning these controls. This is a package
// integrity check; it makes no claim to detect callers outside the package.
// No package entry point is imported and no live admission is granted.
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
  holdSha256: "8896aa7c91e9d21d952ca118cbc468777df130120806cfe5d3ff3bf26f86849b",
  holdBytesSha256: "cbd51b3c51ca7e6e908e119ba36b11fbe4c299efeac5cdb8ec1ebe9e3cfc65f5",
  schema: "dacs-client-hold/v1",
  package: PACKAGE,
  gate: "packages/dacs-client/scripts/check-hold.mjs",
  id: "inherited-stale-pointer",
  status: "lifted",
  delta: "D15",
  sourceRepository: "DACS-Agent-commerce/frontend",
  sourceCommit: "82bf8c4dabb2332a72f618f6cc29950e48d6feb6",
  exports: Object.freeze({ ".": "./src/index.mjs", "./wallet/durable-journal": "./src/wallet/durable-journal.mjs" }),
  files: Object.freeze([
    Object.freeze({ path: "packages/dacs-client/src/purchases.mjs", sourcePath: "http-mcp/src/purchases.mjs", heldBlob: "ee71c89fcfa2ef7fa44716084a810e546343452c", lines: Object.freeze(["666", "789", "811", "905", "927-934"]) }),
    Object.freeze({ path: "packages/dacs-client/src/dacs/wallet-transactions.mjs", sourcePath: "http-mcp/src/dacs/wallet-transactions.mjs", heldBlob: "948107e13dba08f162dd3f1b27968b2eae96d799", lines: Object.freeze(["114"]) }),
  ]),
  regressions: Object.freeze(["completion-orders", "existing-b-observation", "other-purchase-lane", "restart", "unauthenticated-pointer", "agreement-delivery", "same-hash-terminal", "native-supersession", "single-node-payment-transfer"]),
  liftCondition: "Every regression above passes against the reviewed destination head carrying D15's delta commit in this package (or a reviewed source fix copied with provenance).",
  probe: "packages/dacs-client/evidence/source-tests/scripts/stale-pointer.probe.test.mjs.txt",
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
  for (const entry of run("ls-tree", "-r", "--full-tree", "-z", "HEAD", "--", PACKAGE_PREFIX).split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode, type, blob] = entry.slice(0, tab).split(" ");
    head.set(entry.slice(tab + 1), { mode, type, blob });
  }
  const index = new Map();
  for (const entry of run("ls-files", "--stage", "-z", "--", PACKAGE_PREFIX).split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode, blob, stage] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    if (stage !== "0") { failures.push(`${path}: unresolved index entry (stage ${stage})`); continue; }
    index.set(path, { mode, blob });
  }
  const pins = new Map([
    ...Object.entries(frozen.files).map(([path, pin]) => [PACKAGE_PREFIX + path, pin]),
  ]);
  for (const path of new Set([...pins.keys(), ...head.keys(), ...index.keys()])) {
    const committed = head.get(path);
    const staged = index.get(path);
    const pin = pins.get(path);
    if (!committed) failures.push(`${path}: missing from HEAD; package is frozen`);
    else {
      if (!pin) failures.push(`${path}: added in HEAD; package is frozen`);
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
  if (frozen?.schema !== "dacs-client-freeze/v3" || !frozen.files) throw new Error("missing step-1 freeze record");
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
  if (!pkg || JSON.stringify(pkg.exports) !== JSON.stringify(PINNED.exports) || Object.hasOwn(pkg, "main") || Object.hasOwn(pkg, "bin")) failures.push("package.json must retain the reviewed explicit exports and no main or bin");

  const top = sourceGit(["-C", args.repoRoot, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  if (realpathSync(top) !== args.repoRoot) throw new Error("repo-root is not the Git worktree root");
  checkGitStates(args.repoRoot, frozen, failures);
  finish(failures, { files: actual.size });
}

function finish(failures, summary) {
  if (failures.length) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    console.error(`[check-hold] ${failures.length} failure(s)`);
    process.exitCode = 1;
    return;
  }
  console.log(`[check-hold] OK: package frozen; pinned purchase status: ${PINNED.status}: ${PINNED.id} (${PINNED.delta}); package files (${summary.files} files, reviewed control pair included); reviewed public exports; package HEAD blobs verified against pins; package index and working files match HEAD; outside SDK files are unrestricted; no behavioural imports`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(`[check-hold] ${error.message}`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}

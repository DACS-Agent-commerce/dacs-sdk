// Step-1 freeze regressions. Scratch repositories retain the exact package and
// every outside file the record pins, committed as the scratch HEAD.
// No package entry point is imported or called.
// Run with node --test --test-concurrency=1. Git is required, no install.
// Package-command negatives stop at the gate. If it wrongly passes, nested
// runs skip only those negatives to avoid recursion (DACS_HOLD_NESTED).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = join(SCRIPT_DIR, "..");
const SDK_ROOT = join(PACKAGE_DIR, "..", "..");
const GATE = join(SCRIPT_DIR, "check-hold.mjs");
const NESTED = process.env.DACS_HOLD_NESTED ? "nested run: command negatives not repeated" : false;
const scratchRoot = mkdtempSync(join(tmpdir(), "check-hold-"));
after(() => rmSync(scratchRoot, { recursive: true, force: true }));
let count = 0;
const made = [];
afterEach(() => { for (const repo of made.splice(0)) rmSync(repo, { recursive: true, force: true }); });
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { env: gitEnv, encoding: "utf8" });
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const OUTSIDE = Object.keys(readJson(join(PACKAGE_DIR, "HOLD.json")).step1Freeze.outside.files);
function scratch() {
  const repo = join(scratchRoot, String(++count));
  made.push(repo);
  const dir = join(repo, "packages", "dacs-client");
  cpSync(PACKAGE_DIR, dir, { recursive: true });
  for (const name of OUTSIDE) cpSync(join(SDK_ROOT, name), join(repo, name));
  git(repo, "init", "-q");
  git(repo, "add", "-f", "--", ...OUTSIDE, ...Object.keys(readJson(join(dir, "HOLD.json")).step1Freeze.files).map((path) => "packages/dacs-client/" + path));
  git(repo, "-c", "user.name=the SDK maintainer", "-c", "user.email=maintainer@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "test: frozen scratch baseline");
  return { repo, dir };
}
function gate(dir = PACKAGE_DIR, repo = join(dir, "..", "..")) {
  const result = spawnSync(process.execPath, [GATE, "--package-dir", dir, "--repo-root", repo], { encoding: "utf8" });
  return { status: result.status, out: result.stdout + result.stderr };
}
function put(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
function exportsFor(dir, exports) {
  const pkg = readJson(join(dir, "package.json"));
  pkg.exports = exports;
  writeJson(join(dir, "package.json"), pkg);
}
function recordEdit(dir, edit) {
  const record = readJson(join(dir, "HOLD.json"));
  edit(record);
  writeJson(join(dir, "HOLD.json"), record);
}
function refused(result, pattern) {
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, pattern);
}
const RECORD = /HOLD\.json differs from the record the gate pins/;
const MANIFEST = /packages\/dacs-client\/package\.json: changed bytes; package is frozen/;
const outsideFailure = (path, what) => new RegExp(`^FAIL ${path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}: ${what} file outside the package`, "m");
const LATE = "packages/hold-probe/late.mjs";
const INDEX = /index differs from HEAD/;
function stageThenRestore(repo, path, edit) {
  const file = join(repo, path);
  const bytes = readFileSync(file);
  edit(file);
  git(repo, "add", "--", path);
  writeFileSync(file, bytes);
  return INDEX;
}
const MUTATIONS = {
  // an earlier review: a review F1 and code P3-1, stage changes then restore disk.
  stagedOutside({ repo }) {
    return stageThenRestore(repo, "src/index.ts", (file) => appendFileSync(file, "\nexport const late = () => import('../packages/' + ['dacs', 'client'].join('-') + '/src/purchases.mjs');\n"));
  },
  stagedRootExport({ repo }) {
    return stageThenRestore(repo, "package.json", (file) => {
      const pkg = readJson(file); pkg.exports["./client-purchases"] = "./packages/dacs-client/src/purchases.mjs"; writeJson(file, pkg);
    });
  },
  stagedClientExport({ repo, dir }) {
    return stageThenRestore(repo, "packages/dacs-client/package.json", () => exportsFor(dir, { ".": "./src/purchases.mjs" }));
  },
  stagedPackage({ repo, dir }) {
    stageThenRestore(repo, "packages/dacs-client/src/purchases.mjs", (file) => appendFileSync(file, "\n// staged-only edit\n"));
    put(join(dir, "index.mjs"), 'export * from "./src/purchases.mjs";\n');
    git(repo, "add", "--", "packages/dacs-client/index.mjs");
    unlinkSync(join(dir, "index.mjs"));
    return INDEX;
  },
  stagedDeletion({ repo }) {
    const path = "README.md"; const bytes = readFileSync(join(repo, path));
    git(repo, "rm", "--", path); writeFileSync(join(repo, path), bytes);
    return INDEX;
  },
  stagedRename({ repo }) {
    const path = "packages/dacs-client/src/purchases.mjs"; const bytes = readFileSync(join(repo, path));
    git(repo, "mv", "--", path, path + ".renamed");
    unlinkSync(join(repo, path + ".renamed")); writeFileSync(join(repo, path), bytes);
    return INDEX;
  },
  stagedSymlink({ repo }) {
    const path = "README.md"; const bytes = readFileSync(join(repo, path));
    unlinkSync(join(repo, path)); symlinkSync("packages/dacs-client/src/purchases.mjs", join(repo, path));
    git(repo, "add", "--", path); unlinkSync(join(repo, path)); writeFileSync(join(repo, path), bytes);
    return /index entry is not a regular file/;
  },
  stagedMode({ repo }) {
    git(repo, "update-index", "--chmod=+x", "src/index.ts");
    return INDEX;
  },

  // a an earlier review, Finding 1, verbatim deferred-call expression.
  deferredEval({ repo }) {
    put(join(repo, LATE), 'export function late() { return globalThis["eval"](\'import("../dacs-client/src/purchases.mjs")\'); }\n');
    return outsideFailure(LATE, "added");
  },
  // a an earlier review, Finding 1, verbatim: the package path computed at run time.
  computedPath({ repo }) {
    put(join(repo, LATE), "export function late() {\n  const segment = ['dacs', 'client'].join('-');\n  return import(`../${segment}/src/purchases.mjs`);\n}\n");
    return outsideFailure(LATE, "added");
  },
  // an earlier review, P2-1: the hyphen escaped inside eval (backslash-u002d), as
  // backslash-x2d, or URL-encoded as %2D; each file tracked.
  unicodeEscape({ repo }) {
    put(join(repo, LATE), String.raw`export function late() { return globalThis["eval"]('import("../dacs\\u002dclient/src/purchases.mjs")'); }` + "\n");
    git(repo, "add", "--", LATE);
    return outsideFailure(LATE, "added");
  },
  hexEscape({ repo }) {
    put(join(repo, LATE), String.raw`export const late = () => import("../dacs\x2dclient/src/purchases.mjs");` + "\n");
    git(repo, "add", "--", LATE);
    return outsideFailure(LATE, "added");
  },
  percentEncoded({ repo }) {
    put(join(repo, LATE), 'export const late = () => import("../dacs%2Dclient/src/purchases.mjs");\n');
    git(repo, "add", "--", LATE);
    return outsideFailure(LATE, "added");
  },
  // Coordinator, an earlier review: one changed byte in an existing outside file.
  oneByteOutside({ repo }) {
    const file = join(repo, "src", "index.ts");
    const bytes = readFileSync(file); bytes[0] ^= 1; writeFileSync(file, bytes);
    return outsideFailure("src/index.ts", "changed");
  },
  // an earlier review, P1-1: all five exact export shapes.
  distPattern({ dir }) {
    exportsFor(dir, { "./*": "./dist/*.mjs" });
    put(join(dir, "dist/live.mjs"), 'export * from "../src/purchases.mjs";\n');
    return MANIFEST;
  },
  dotPattern({ dir }) {
    exportsFor(dir, { "./*": "./.lib/*.mjs" });
    put(join(dir, ".lib/live.mjs"), 'export * from "../src/purchases.mjs";\n');
    return MANIFEST;
  },
  extensionlessPattern({ dir }) {
    exportsFor(dir, { "./*": "./lib/*" });
    put(join(dir, "lib/live"), 'export * from "../src/purchases.mjs";\n');
    return MANIFEST;
  },
  missingTarget({ dir }) {
    exportsFor(dir, { ".": "./dist/index.mjs" });
    return MANIFEST;
  },
  rootExport({ repo }) {
    const file = join(repo, "package.json");
    const pkg = readJson(file);
    pkg.exports["./client-purchases"] = "./packages/dacs-client/src/purchases.mjs";
    writeJson(file, pkg);
    return outsideFailure("package.json", "changed");
  },
  // Keep both an earlier review a review mutations in the package command too.
  createRequireLoader({ dir }) {
    put(join(dir, "scripts/live.mjs"), 'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nexport const purchase = load("../src/purchases.mjs");\n');
    exportsFor(dir, { "./live": "./scripts/live.mjs" });
    return MANIFEST;
  },
  nonLiteralImport({ dir }) {
    put(join(dir, "scripts/live.mjs"), 'const target = ["..", "src", "purchases.mjs"].join("/");\nexport const purchase = await import(target);\n');
    exportsFor(dir, { "./live": "./scripts/live.mjs" });
    return MANIFEST;
  },
  weakenedRecord({ dir }) {
    recordEdit(dir, (r) => {
      const h = r.holds[0];
      h.reason = "Resolved"; h.rule = "No conditions"; h.liftRequires.sourceFix = "None";
      for (const item of h.liftRequires.regressions) item.case = "Unneeded";
      h.blockedPrerequisites = [];
    });
    return RECORD;
  },
  substitutedPath({ dir }) {
    recordEdit(dir, (r) => { r.holds[0].files = [{ path: "packages/dacs-client/test/catalog-observed-at.test.mjs", sourcePath: "http-mcp/test/catalog-observed-at.test.mjs", heldBlob: "0".repeat(40), lines: [{ line: "1", what: "harmless" }] }]; });
    exportsFor(dir, { "./purchases": "./src/purchases.mjs" });
    return RECORD;
  },
};

test("the current package and an unchanged scratch repository pass", () => {
  for (const dir of [PACKAGE_DIR, scratch().dir]) {
    const result = gate(dir);
    assert.equal(result.status, 0, result.out);
    assert.match(result.out, /OK: package frozen; pinned purchase status: (held|lifted): inherited-stale-pointer \(D15\); package files/);
    assert.match(result.out, /exports: \{\}; outside inventory frozen \(\d+ files, exact blobs at [0-9a-f]{12}\); HEAD blobs verified against pins; index and working files match HEAD .*; literal-name tripwire clear/);
    assert.match(result.out, /no behavioural imports/);
  }
});

test("HEAD corruption fails even when the index and working files have pinned bytes", () => {
  const { repo, dir } = scratch();
  const path = "src/index.ts"; const bytes = readFileSync(join(repo, path));
  appendFileSync(join(repo, path), "\n// committed change\n"); git(repo, "add", "--", path);
  git(repo, "-c", "user.name=the SDK maintainer", "-c", "user.email=maintainer@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "test: changed head");
  writeFileSync(join(repo, path), bytes); git(repo, "add", "--", path);
  refused(gate(dir), /src\/index\.ts: HEAD blob differs from the freeze pin/);
});

test("any manifest byte change fails, including whitespace, scripts, main, bin and removed exports", () => {
  const edits = [
    (f) => appendFileSync(f, "\n"),
    ...["main", "bin", "module", "browser"].map((field) => (f) => writeJson(f, { ...readJson(f), [field]: "./src/purchases.mjs" })),
    (f) => { const p = readJson(f); delete p.exports; writeJson(f, p); },
    (f) => { const p = readJson(f); p.scripts.prepare = "node build.mjs"; writeJson(f, p); },
    (f) => { const p = readJson(f); p.scripts.test = "node --test scripts/stale-pointer.probe.test.mjs"; writeJson(f, p); },
  ];
  for (const edit of edits) { const { dir } = scratch(); edit(join(dir, "package.json")); refused(gate(dir), MANIFEST); }
});

test("every ordinary package file has a blob pin and only the gate and record are controls", () => {
  const r = readJson(join(PACKAGE_DIR, "HOLD.json"));
  const controls = Object.entries(r.step1Freeze.files).filter(([, pin]) => pin.control).map(([path, pin]) => [path, pin.control]);
  assert.deepEqual(controls, [["HOLD.json", "record"], ["scripts/check-hold.mjs", "gate"]]);
  for (const [path, pin] of Object.entries(r.step1Freeze.files)) if (!pin.control) assert.match(pin.blob, /^[0-9a-f]{40}$/, path);
  assert.match(r.holds[0].liftRequires.sourceFix, /reviewed D15 delta commit in this package/);
  assert.match(r.holds[0].liftRequires.condition, /reviewed destination head/);
});

test("the record names the planned re-pins, the merge policy and the probe's lift requirement", () => {
  const r = readJson(join(PACKAGE_DIR, "HOLD.json"));
  const repins = r.step1Freeze.plannedRepins;
  assert.deepEqual(repins.changes.map((change) => change.id), ["root-lockfile", "seller-package-import", "main-rebase", "client-delta-series"]);
  assert.match(repins.what, /visible re-pin commit that updates HOLD\.json and check-hold\.mjs together/);
  assert.match(repins.mergePolicy, /never merges alone/);
  assert.match(r.holds[0].liftRequires.probeResult, /D15 must retarget it at this package/);
  assert.match(r.holds[0].liftRequires.probeResult, /# tests 2 and # pass 2 .*not exit 0/);
});

test("changed or missing copied files, tools and maps fail", () => {
  for (const file of ["src/purchases.mjs", "src/dacs/wallet-transactions.mjs", "test/catalog-observed-at.test.mjs", "scripts/copy-verbatim.mjs", "scripts/stale-pointer.probe.test.mjs", "IMPORT-CUT-MAP.md", "PROVENANCE.json"]) {
    for (const remove of [false, true]) {
      const { dir } = scratch();
      if (remove) unlinkSync(join(dir, file)); else appendFileSync(join(dir, file), "\n");
      refused(gate(dir), remove ? /missing file; package is frozen/ : /changed bytes; package is frozen/);
    }
  }
});

test("added files fail regardless of extension, directory or whether they name held code", () => {
  for (const file of ["src/extra.mjs", "scripts/harmless.txt", "dist/live.mjs", "build/live", ".lib/live", ".hidden", "node_modules/example/index.js"]) {
    const { dir } = scratch(); put(join(dir, file), "export const harmless = true;\n"); refused(gate(dir), /added file; package is frozen/);
  }
});

test("package symlinks fail closed", () => {
  const { dir } = scratch(); symlinkSync(join(dir, "src"), join(dir, "linked")); refused(gate(dir), /symlinks are refused/);
});

test("an altered checked gate fails when the trusted gate checks another tree", () => {
  const { dir } = scratch(); appendFileSync(join(dir, "scripts/check-hold.mjs"), "\n"); refused(gate(dir), /gate differs from the trusted running gate/);
});

test("a gate-only edit fails when the altered gate executes itself", () => {
  const { dir } = scratch();
  appendFileSync(join(dir, "scripts/check-hold.mjs"), "\n// unreviewed gate-only edit\n");
  const result = spawnSync(process.execPath, [join(dir, "scripts/check-hold.mjs")], { encoding: "utf8" });
  refused({ status: result.status, out: result.stdout + result.stderr }, /bytes differ from the gate blob pinned by HOLD.json/);
});

test("changing only the reciprocal gate blob in the record fails", () => {
  const { dir } = scratch();
  recordEdit(dir, (r) => { r.step1Freeze.files["scripts/check-hold.mjs"].blob = "0".repeat(40); });
  refused(gate(dir), /bytes differ from the gate blob pinned by HOLD.json/);
});

test("the record is pinned: semantics, freeze hashes, added fields and exact bytes", () => {
  for (const edit of [
    (r) => { r.holds[0].status = r.holds[0].status === "held" ? "lifted" : "held"; },
    (r) => { r.holds[0].liftRequires.sourceFix = "None"; },
    (r) => { r.holds[0].liftRequires.regressions.pop(); },
    (r) => { r.holds[0].files.reverse(); },
    (r) => { r.holds[0].blockedPrerequisites = []; },
    (r) => { delete r.step1Freeze.files["src/purchases.mjs"]; },
    (r) => { r.step1Freeze.files["src/purchases.mjs"].blob = "0".repeat(40); },
    (r) => { r.step1Freeze.extra = true; },
  ]) { const { dir } = scratch(); recordEdit(dir, edit); refused(gate(dir), RECORD); }
  const { dir } = scratch(); appendFileSync(join(dir, "HOLD.json"), "\n"); refused(gate(dir), /HOLD.json bytes differ from the pinned record/);
});

test("a missing or malformed record fails", () => {
  for (const remove of [true, false]) { const { dir } = scratch(); if (remove) unlinkSync(join(dir, "HOLD.json")); else writeFileSync(join(dir, "HOLD.json"), "{"); refused(gate(dir), /HOLD.json (is missing|is not valid JSON)/); }
});

test("added outside files fail in all extensions, dot directories and tracked ignored output; the literal tripwire also reports", () => {
  for (const [file, tracked] of [["docs/reference.txt", false], [".lib/entry", false], ["packages/other/package.json", true], ["dist/live.mjs", true], ["build/live", true], ["packages/other/.lib/live", true]]) {
    const { repo, dir } = scratch(); put(join(repo, file), '"../dacs-client/src/purchases.mjs"\n');
    if (tracked) git(repo, "add", "-f", "--", file);
    const result = gate(dir); refused(result, outsideFailure(file, "added"));
    assert.match(result.out, /literal dacs-client outside the package \(tripwire\)/);
  }
  const { repo, dir } = scratch(); put(join(repo, "docs/dacs-client.txt"), "no reference in bytes"); refused(gate(dir), outsideFailure("docs/dacs-client.txt", "added"));
});

test("an unrelated added, changed or removed outside file fails, with no literal reference", () => {
  const added = scratch(); put(join(added.repo, ".notes/input.txt"), "unrelated content"); refused(gate(added.dir), outsideFailure(".notes/input.txt", "added"));
  const changed = scratch(); appendFileSync(join(changed.repo, "README.md"), "\n"); refused(gate(changed.dir), outsideFailure("README.md", "changed"));
  const removed = scratch(); unlinkSync(join(removed.repo, "README.md")); refused(gate(removed.dir), outsideFailure("README.md", "missing"));
  for (const result of [gate(added.dir), gate(changed.dir), gate(removed.dir)]) assert.doesNotMatch(result.out, /tripwire/);
});

test("the outside inventory is the tracked tree outside the package at its pinned work head", (t) => {
  const { pinnedAt, files } = readJson(join(PACKAGE_DIR, "HOLD.json")).step1Freeze.outside;
  assert.match(pinnedAt, /^[0-9a-f]{40}$/);
  let tree;
  try { tree = git(SDK_ROOT, "--no-replace-objects", "ls-tree", "-r", "-z", pinnedAt); } catch {
    t.skip(`pinned head ${pinnedAt} is not in this repository (for example an archive copy); the gate still enforces the inventory`);
    return;
  }
  const entries = tree.split("\0").filter(Boolean).map((line) => { const [meta, path] = line.split("\t"); return [path, meta.split(" ")]; });
  const expected = Object.fromEntries(entries.filter(([path]) => !path.startsWith("packages/dacs-client/")).map(([path, [mode, type, blob]]) => {
    assert.ok(type === "blob" && /^1006[0-9]{2}$/.test(mode), `${path}: ${mode} ${type}`);
    return [path, blob];
  }));
  assert.deepEqual(Object.fromEntries(Object.entries(files).map(([path, pin]) => [path, pin.blob])), expected);
});

test("the root lockfile is pinned like every outside file and is the tripwire's only exception", () => {
  const { repo, dir } = scratch();
  const frozen = readJson(join(dir, "HOLD.json")).step1Freeze;
  assert.deepEqual(Object.keys(frozen.literalNameTripwire.exceptions), ["package-lock.json"]);
  assert.match(frozen.outside.files["package-lock.json"].blob, /^[0-9a-f]{40}$/);
  appendFileSync(join(repo, "package-lock.json"), "\n"); refused(gate(dir), outsideFailure("package-lock.json", "changed"));
});

test("untracked files Git ignores are the explicit limit; tracking one fails", () => {
  const { repo, dir } = scratch();
  put(join(repo, "dist/untracked.mjs"), 'export * from "../packages/dacs-client/src/purchases.mjs";\n');
  const result = gate(dir); assert.equal(result.status, 0, result.out);
  git(repo, "add", "-f", "--", "dist/untracked.mjs"); refused(gate(dir), outsideFailure("dist/untracked.mjs", "added"));
});

test("unreadable tracked files, repository symlinks, non-repositories and empty arguments fail", () => {
  const { repo, dir } = scratch(); unlinkSync(join(repo, "package.json")); refused(gate(dir), outsideFailure("package.json", "missing"));
  const other = scratch(); symlinkSync(join(other.repo, "package.json"), join(other.repo, "link")); refused(gate(other.dir), /link: not a regular repository file/);
  rmSync(join(other.repo, ".git"), { recursive: true }); refused(gate(other.dir), /not a git repository|not the Git worktree root/);
  const result = spawnSync(process.execPath, [GATE, "--package-dir", ""], { encoding: "utf8" }); assert.equal(result.status, 2); assert.match(result.stderr, /missing option value/);
});

test("the behavioural load runner is removed", () => {
  const { dir } = scratch();
  const result = spawnSync(process.execPath, [join(dir, "scripts/check-hold-load.mjs")], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MODULE_NOT_FOUND/);
  const source = readFileSync(GATE, "utf8");
  assert.doesNotMatch(source, /--permission|--allow-fs-read|registerHooks|loadCheck\(/);
});

for (const [name, mutate] of Object.entries(MUTATIONS)) {
  test(`review mutation ${name} fails in the gate and through the package test command`, { skip: NESTED }, () => {
    const s = scratch(); const pattern = mutate(s); refused(gate(s.dir), pattern);
    const env = { ...process.env, DACS_HOLD_NESTED: "1", npm_config_cache: join(scratchRoot, "npm-cache"), npm_config_update_notifier: "false" };
    delete env.DACS_FRONTEND_REPO;
    const [cmd, args] = process.env.npm_execpath ? [process.execPath, [process.env.npm_execpath, "test"]] : ["npm", ["test"]];
    const result = spawnSync(cmd, args, { cwd: s.dir, encoding: "utf8", env });
    refused({ status: result.status, out: result.stdout + result.stderr }, pattern);
    assert.match(result.stdout, /> node scripts\/check-hold\.mjs && node --test/);
    assert.doesNotMatch(result.stdout, /^# tests /m, "gate stops the command before tests");
  });
}

// The package and manifest cases reproduce the review's committed/restored
// states. HEAD must fail even if both other views contain the pinned bytes.
test("committed package edits and exports fail with restored index and working bytes",()=>{
  for(const path of ["packages/dacs-client/src/purchases.mjs","packages/dacs-client/package.json"]){
    const {repo,dir}=scratch(),file=join(repo,path),bytes=readFileSync(file);
    if(path.endsWith("package.json"))exportsFor(dir,{".":"./src/purchases.mjs"});else appendFileSync(file,"\n// committed probe\n");
    git(repo,"add","--",path);
    git(repo,"-c","user.name=the SDK maintainer","-c","user.email=maintainer@example.invalid","commit","-q","-m","test: changed package HEAD");
    writeFileSync(file,bytes);git(repo,"add","--",path);
    refused(gate(dir),/HEAD blob differs from the freeze pin/);
  }
});

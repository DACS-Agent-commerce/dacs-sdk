// Negative and positive cases for check-provenance.mjs on scratch copies of
// the package. Not part of the copied test set (an extra file under test/
// would fail the checker), and not reached by the root vitest include.
//
//   DACS_FRONTEND_REPO=<frontend repo> node --test --test-concurrency=1 packages/dacs-client/scripts/check-provenance.test.mjs
//
// Cases that read source blobs need DACS_FRONTEND_REPO; without it they are
// skipped and reported as such, never as passing. The derived-set case and
// the copy-plan derivation need the root `npm ci` (typescript); without it
// that case fails, it is not skipped. The hold gate needs Git, not an install.
import { publicationPolicy } from './publication-text.mjs';
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = join(SCRIPT_DIR, "..");
const CHECKER = join(SCRIPT_DIR, "check-provenance.mjs");
const SOURCE = process.env.DACS_FRONTEND_REPO || null;
const NEEDS_SOURCE = SOURCE ? false : "DACS_FRONTEND_REPO is not set: source-blob cases not run";

const STEP1 = "82bf8c4dabb2332a72f618f6cc29950e48d6feb6";
const REVIEWED_SOURCE_HEAD = "02f7070ddff7bf9e94ffd9a953ccc2f0af56caba";
const SELLER_SOURCE_HEAD = "5274f18541ac0e8c77e3e71463bb6c811f048922";
const READBACK = "src/dacs/buyer-chain-readback.mjs";

// Synchronous Git commands can still detach maintenance that races teardown.
const git = (args, options) => execFileSync("git", ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], options);

const scratchRoot = mkdtempSync(join(tmpdir(), "check-provenance-"));
after(() => rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

let scratchCount = 0;
function scratch() {
  const dir = join(scratchRoot, String(scratchCount += 1));
  mkdirSync(dir, {recursive:true});
  // A synthetic hash-only copy exercises manifest validation without requiring
  // the publication's discarded step-1 Git objects. Source tests use the actual
  // pinned source blobs when the independently supplied source repo exists.
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'PROVENANCE.json')));
  for (const entry of manifest.files) {
    const rel = entry.path.slice('packages/dacs-client/'.length);
    let bytes;
    if (SOURCE) bytes = blob(STEP1, entry.sourcePath);
    else {
      try { bytes = readFileSync(join(PACKAGE_DIR, rel)); }
      catch { bytes = Buffer.from('// synthetic local-only source fixture\n'); }
      entry.sha256 = sha256(bytes);
    }
    mkdirSync(dirname(join(dir, rel)), {recursive:true});
    writeFileSync(join(dir, rel), bytes);
  }
  writeManifest(dir, manifest);
  return dir;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readManifest = (dir) => JSON.parse(readFileSync(join(dir, "PROVENANCE.json"), "utf8"));
const writeManifest = (dir, manifest) => writeFileSync(join(dir, "PROVENANCE.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const entryFor = (manifest, rel) => manifest.files.find((entry) => entry.path === `packages/dacs-client/${rel}`);
const blob = (commit, path) => git(["-C", SOURCE, "cat-file", "blob", `${commit}:${path}`], { maxBuffer: 1 << 30 });

function check(dir, mode) {
  const args = mode === "source" ? ["--source", SOURCE] : mode === "local" ? ["--local-only"] : mode === "empty-source" ? ["--source", ""] : [];
  const result = spawnSync(process.execPath, [CHECKER, ...args, "--package-dir", dir], { encoding: "utf8" });
  return { status: result.status, out: result.stdout + result.stderr };
}

// Replace a file with another head's version and change its manifest entry to
// match (hash and, unless keepCommit, sourceCommit).
function substitute(dir, rel, commit, { keepCommit = false } = {}) {
  const manifest = readManifest(dir);
  const entry = entryFor(manifest, rel);
  const bytes = blob(commit, entry.sourcePath);
  assert.notEqual(sha256(bytes), entry.sha256, `${rel} must differ at ${commit} for this case`);
  writeFileSync(join(dir, rel), bytes);
  entry.sha256 = sha256(bytes);
  if (!keepCommit) entry.sourceCommit = commit;
  writeManifest(dir, manifest);
}

test("unmodified copy passes the acceptance check", { skip: NEEDS_SOURCE }, () => {
  const result = check(scratch(), "source");
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /OK \(acceptance check\): 329 files/);
});

test("local-only mode passes but is labelled as not an acceptance check", () => {
  const result = check(scratch(), "local");
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /LOCAL HASH CHECK ONLY, NOT AN ACCEPTANCE CHECK/);
  assert.doesNotMatch(result.out, /OK \(acceptance check\)/);
});

test("no mode is a usage error", () => {
  const result = check(scratch(), "none");
  assert.equal(result.status, 2, result.out);
});

test("an empty --source value is a usage error, not the local-only mode", () => {
  // An edit with its hash updated: the local-only mode cannot see it, so a
  // silent fall-back to that mode would exit 0.
  const dir = scratch();
  const manifest = readManifest(dir);
  appendFileSync(join(dir, READBACK), "// edit\n");
  entryFor(manifest, READBACK).sha256 = sha256(readFileSync(join(dir, READBACK)));
  writeManifest(dir, manifest);
  const result = check(dir, "empty-source");
  assert.equal(result.status, 2, result.out);
  assert.match(result.out, /missing option value/);
  assert.doesNotMatch(result.out, /OK \(acceptance check\)|LOCAL HASH CHECK ONLY/);
});

test("a file and its manifest entry changed together to the the source change head fail", { skip: NEEDS_SOURCE }, () => {
  const dir = scratch();
  substitute(dir, READBACK, REVIEWED_SOURCE_HEAD);
  for (const mode of ["source", "local"]) {
    const result = check(dir, mode);
    assert.equal(result.status, 1, `${mode}: ${result.out}`);
    assert.match(result.out, /buyer-chain-readback\.mjs: sourceCommit 02f7070\w+ \(the source change inspected head .*\) is not on the checker's allowed list/);
  }
});

test("every commit re-pointed to the the source change head, with a the source change file, fails", { skip: NEEDS_SOURCE }, () => {
  const dir = scratch();
  substitute(dir, READBACK, REVIEWED_SOURCE_HEAD);
  const manifest = readManifest(dir);
  manifest.sourceCommit = REVIEWED_SOURCE_HEAD;
  for (const entry of manifest.files) entry.sourceCommit = REVIEWED_SOURCE_HEAD;
  writeManifest(dir, manifest);
  const result = check(dir, "source");
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /manifest sourceCommit "02f7070\w+" \(the source change inspected head .*\) is not the trusted step-1 commit/);
  assert.match(result.out, /\[check-provenance\] 331 failure\(s\)/);
});

test("a changed top-level sourceCommit fails", () => {
  const dir = scratch();
  const manifest = readManifest(dir);
  manifest.sourceCommit = REVIEWED_SOURCE_HEAD;
  writeManifest(dir, manifest);
  for (const mode of SOURCE ? ["source", "local"] : ["local"]) {
    const result = check(dir, mode);
    assert.equal(result.status, 1, `${mode}: ${result.out}`);
    assert.match(result.out, /manifest sourceCommit .* is not the trusted step-1 commit/);
  }
});

test("an entry naming a the source change port-source head not allowed for the client fails", { skip: NEEDS_SOURCE }, () => {
  const dir = scratch();
  substitute(dir, "src/dacs/seller-agent.mjs", SELLER_SOURCE_HEAD);
  const result = check(dir, "source");
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /seller-agent\.mjs: sourceCommit 5274f18\w+ \(the source change plan head \(seller step\)\) is not on the checker's allowed list/);
});

test("an entry naming an unknown commit fails, with or without --source", () => {
  const dir = scratch();
  const manifest = readManifest(dir);
  entryFor(manifest, "src/dacs/chain.mjs").sourceCommit = "0123456789abcdef0123456789abcdef01234567";
  writeManifest(dir, manifest);
  for (const mode of SOURCE ? ["source", "local"] : ["local"]) {
    const result = check(dir, mode);
    assert.equal(result.status, 1, `${mode}: ${result.out}`);
    assert.match(result.out, /chain\.mjs: sourceCommit 0123456789\w+ is not on the checker's allowed list/);
  }
});

test("an edit with its hash updated fails --source; local-only cannot see it", { skip: NEEDS_SOURCE }, () => {
  const dir = scratch();
  substitute(dir, READBACK, REVIEWED_SOURCE_HEAD, { keepCommit: true });
  const gate = check(dir, "source");
  assert.equal(gate.status, 1, gate.out);
  assert.match(gate.out, /buyer-chain-readback\.mjs: source blob SHA-256 \w+ differs from manifest/);
  const local = check(dir, "local");
  assert.equal(local.status, 0, local.out);
  assert.match(local.out, /NOT AN ACCEPTANCE CHECK/);
});

// A scratch clone sharing the source repo's objects, in which the trusted
// commit's readback blob is replaced by an edited blob (git replace). The
// clone's own config turns replace refs on.
function replacedSource() {
  const repo = join(scratchRoot, `replaced-${scratchCount += 1}`);
  git(["clone", "--quiet", "--shared", "--no-checkout", SOURCE, repo]);
  const sourcePath = `http-mcp/${READBACK}`;
  const original = git(["-C", repo, "rev-parse", `${STEP1}:${sourcePath}`], { encoding: "utf8" }).trim();
  const bytes = Buffer.concat([blob(STEP1, sourcePath), Buffer.from("// replaced\n")]);
  const edited = git(["-C", repo, "hash-object", "-w", "--stdin"], { input: bytes, encoding: "utf8" }).trim();
  git(["-C", repo, "replace", original, edited]);
  git(["-C", repo, "config", "core.useReplaceRefs", "true"]);
  assert.deepEqual(git(["-C", repo, "cat-file", "blob", `${STEP1}:${sourcePath}`]), bytes, "the replace object must be in effect for plain git");
  return { repo, bytes };
}

test("a replace object in the source repository does not change the blob the gate reads", { skip: NEEDS_SOURCE }, () => {
  const { repo, bytes } = replacedSource();
  const dir = scratch();
  const manifest = readManifest(dir);
  writeFileSync(join(dir, READBACK), bytes);
  entryFor(manifest, READBACK).sha256 = sha256(bytes);
  writeManifest(dir, manifest);
  const result = spawnSync(process.execPath, [CHECKER, "--source", repo, "--package-dir", dir], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /buyer-chain-readback\.mjs: source blob SHA-256 \w+ differs from manifest/);
  assert.doesNotMatch(result.stdout, /OK \(acceptance check\)/);
});

test("an inherited GIT_DIR does not redirect --source", { skip: NEEDS_SOURCE }, () => {
  // GIT_DIR names an empty repo; --source names the real repo, which the
  // unmodified copy matches.
  const empty = join(scratchRoot, "git-dir-repo");
  git(["init", "--quiet", empty]);
  const env = { ...process.env, GIT_DIR: join(empty, ".git") };
  const result = spawnSync(process.execPath, [CHECKER, "--source", SOURCE, "--package-dir", scratch()], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /OK \(acceptance check\): 329 files/);
});

// A bare repo holding the trusted commit's objects loose, in which the
// readback blob's object is rewritten with edited bytes under its original id
// (git does not re-hash objects it reads).
function forgedStore() {
  const store = join(scratchRoot, `forged-${scratchCount += 1}.git`);
  git(["init", "--quiet", "--bare", store]);
  const ids = git(["-C", SOURCE, "rev-list", "--objects", "--no-walk", STEP1], { encoding: "utf8", maxBuffer: 1 << 30 })
    .split("\n").filter(Boolean).map((line) => line.split(" ")[0]);
  const pack = git(["-C", SOURCE, "pack-objects", "--stdout"], { input: `${ids.join("\n")}\n`, maxBuffer: 1 << 30 });
  git(["-C", store, "unpack-objects", "-q"], { input: pack });
  const sourcePath = `http-mcp/${READBACK}`;
  const id = git(["-C", SOURCE, "rev-parse", `${STEP1}:${sourcePath}`], { encoding: "utf8" }).trim();
  const bytes = Buffer.concat([blob(STEP1, sourcePath), Buffer.from("// forged\n")]);
  const loose = join(store, "objects", id.slice(0, 2), id.slice(2));
  chmodSync(loose, 0o644);
  writeFileSync(loose, deflateSync(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])));
  assert.deepEqual(git(["--git-dir", store, "cat-file", "blob", `${STEP1}:${sourcePath}`], { maxBuffer: 1 << 30 }), bytes, "the forged object must be in effect for plain git");
  return { store, bytes };
}

test("an inherited GIT_DIR or GIT_OBJECT_DIRECTORY naming a forged object store does not change the blob the gate reads", { skip: NEEDS_SOURCE }, () => {
  // --source names the real repo; the copy is edited to the forged bytes.
  const { store, bytes } = forgedStore();
  const dir = scratch();
  const manifest = readManifest(dir);
  writeFileSync(join(dir, READBACK), bytes);
  entryFor(manifest, READBACK).sha256 = sha256(bytes);
  writeManifest(dir, manifest);
  for (const env of [{ GIT_DIR: store }, { GIT_OBJECT_DIRECTORY: join(store, "objects") }]) {
    const result = spawnSync(process.execPath, [CHECKER, "--source", SOURCE, "--package-dir", dir], { encoding: "utf8", env: { ...process.env, ...env } });
    assert.equal(result.status, 1, `${Object.keys(env)[0]}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /buyer-chain-readback\.mjs: source blob SHA-256 \w+ differs from manifest/);
    assert.doesNotMatch(result.stdout, /OK \(acceptance check\)/);
  }
});

test("a corrupt byte, a removed file and an extra file fail", () => {
  const cases = [
    ["corrupt byte", (dir) => {
      const path = join(dir, "src/dacs/listing.mjs");
      const bytes = readFileSync(path);
      bytes[100] ^= 1;
      writeFileSync(path, bytes);
    }, /listing\.mjs: SHA-256 mismatch/],
    ["removed file", (dir) => unlinkSync(join(dir, "test/fixtures/listings.mjs")), /listings\.mjs: missing/],
    ["extra file", (dir) => appendFileSync(join(dir, "src/dacs/extra.mjs"), "export {};\n"), /extra\.mjs: not in the manifest/],
  ];
  for (const [name, mutate, pattern] of cases) {
    const dir = scratch();
    mutate(dir);
    for (const mode of SOURCE ? ["source", "local"] : ["local"]) {
      const result = check(dir, mode);
      assert.equal(result.status, 1, `${name}, ${mode}: ${result.out}`);
      assert.match(result.out, pattern, `${name}, ${mode}`);
    }
  }
});

const COPY_SET = /copy set \((\d+) entries: src (\d+), test (\d+); digest \w+\) is not the pinned step-1 set \(329 entries: src 52, test 277;/;

test("a file and its manifest entry dropped together fail", () => {
  const dir = scratch();
  const manifest = readManifest(dir);
  manifest.files = manifest.files.filter((entry) => entry.path !== "packages/dacs-client/src/dacs/directory.mjs");
  writeManifest(dir, manifest);
  unlinkSync(join(dir, "src/dacs/directory.mjs"));
  for (const mode of SOURCE ? ["source", "local"] : ["local"]) {
    const result = check(dir, mode);
    assert.equal(result.status, 1, `${mode}: ${result.out}`);
    assert.deepEqual(COPY_SET.exec(result.out)?.slice(1), ["328", "51", "277"], `${mode}: ${result.out}`);
    assert.match(result.out, /\[check-provenance\] 1 failure\(s\)/, mode);
  }
});

test("an extra file added together with its manifest entry fails", () => {
  // A source file outside the client set (the seller's listing.mjs), copied
  // verbatim with a correct entry. Without the source repo, any bytes do for
  // the local-only run.
  const sourcePath = "http-mcp/src/devnet-demo/listing.mjs";
  const bytes = SOURCE ? blob(STEP1, sourcePath) : Buffer.from("export {};\n");
  const dir = scratch();
  const manifest = readManifest(dir);
  manifest.files.push({ path: "packages/dacs-client/src/devnet-demo/listing.mjs", sourcePath, sourceCommit: STEP1, sha256: sha256(bytes), role: "src", selection: "added by hand" });
  writeManifest(dir, manifest);
  mkdirSync(join(dir, "src/devnet-demo"), { recursive: true });
  writeFileSync(join(dir, "src/devnet-demo/listing.mjs"), bytes);
  for (const mode of SOURCE ? ["source", "local"] : ["local"]) {
    const result = check(dir, mode);
    assert.equal(result.status, 1, `${mode}: ${result.out}`);
    assert.deepEqual(COPY_SET.exec(result.out)?.slice(1), ["330", "53", "277"], `${mode}: ${result.out}`);
    assert.match(result.out, /\[check-provenance\] 1 failure\(s\)/, mode);
  }
});

test("an entry's role re-labelled fails", () => {
  const dir = scratch();
  const manifest = readManifest(dir);
  entryFor(manifest, "test/helpers/answer-writer-worker.mjs").role = "src";
  writeManifest(dir, manifest);
  for (const mode of SOURCE ? ["source", "local"] : ["local"]) {
    const result = check(dir, mode);
    assert.equal(result.status, 1, `${mode}: ${result.out}`);
    assert.deepEqual(COPY_SET.exec(result.out)?.slice(1), ["329", "53", "276"], `${mode}: ${result.out}`);
  }
});

test("the pinned copy set is the one copy-verbatim.mjs derives from the source", { skip: NEEDS_SOURCE }, async () => {
  // A package written from the copy rule's own selection at the trusted
  // commit, independent of the committed copy, passes the acceptance check.
  const { computePlan, loadSource, manifestEntries, SOURCE_REPOSITORY } = await import("./copy-verbatim.mjs");
  const source = loadSource(SOURCE, STEP1);
  const entries = manifestEntries(source, await computePlan(source));
  const dir = join(scratchRoot, "derived");
  for (const entry of entries) {
    const target = join(dir, entry.path.slice("packages/dacs-client/".length));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.bytes);
  }
  writeManifest(dir, { package: "@kynesyslabs/dacs-client", sourceRepository: SOURCE_REPOSITORY, sourceCommit: source.commit, files: entries.map(({ bytes, ...entry }) => entry) });
  const result = check(dir, "source");
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /OK \(acceptance check\): 329 files .* and the pinned step-1 copy set/);
});

test("the purchase-path hold gate passes on this package", () => {
  // Step 1's checks include the hold (HOLD.json, check-hold.mjs): a delta that
  // drops the record, exposes a held module or imports one from a non-copied
  // module fails here as well as in the package's own test script.
  const result = spawnSync(process.execPath, [join(SCRIPT_DIR, "check-hold.mjs"), "--package-dir", PACKAGE_DIR], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\[check-hold\] OK: package frozen; pinned purchase status: (held|lifted): inherited-stale-pointer \(D15\)/);
});

test("a source repository without the trusted commit fails", () => {
  const empty = join(scratchRoot, "empty-repo");
  git(["init", "--quiet", empty]);
  const result = spawnSync(process.execPath, [CHECKER, "--source", empty, "--package-dir", scratch()], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, new RegExp(`source repository has no commit ${STEP1}`));
});


test("the package-only freeze retains the original purchase prerequisites", () => {
  const sdk = join(PACKAGE_DIR, "../..");
  const reviewed = (path) => git(["--no-replace-objects", "-C", sdk, "show", `5c7d5e066eed8ebf9b9744b7a44e6cee72abe7f1:packages/dacs-client/${path}`], { encoding: "utf8" });
  const record = JSON.parse(readFileSync(join(PACKAGE_DIR, "HOLD.json"), "utf8"));
  const step1 = JSON.parse(reviewed("HOLD.json"));
  const hold = record.holds[0], original = step1.holds[0];
  assert.equal(record.step1Freeze.schema, 'dacs-client-freeze/v3');
  assert.equal(record.step1Freeze.outside, undefined);
  assert.equal(record.step1Freeze.literalNameTripwire, undefined);
  assert.match(hold.rule, /Other SDK files and unrelated commits are unrestricted/);
  assert.match(hold.rule, /Independent programme review remains pending/);
  for (const key of ["schema", "package", "gate"]) assert.equal(record[key], step1[key], key);
  for (const key of ["id", "delta", "sourceRepository", "sourceCommit", "files"]) assert.deepEqual(hold[key], original[key], key);
  for (const key of ["sourceFix", "condition"]) assert.equal(hold.liftRequires[key], publicationPolicy(original.liftRequires[key]), key);
  assert.deepEqual(hold.liftRequires.regressions.slice(0, original.liftRequires.regressions.length), original.liftRequires.regressions);
  assert.ok(hold.liftRequires.probeResult.startsWith(publicationPolicy(original.liftRequires.probeResult)));
  assert.deepEqual(hold.blockedPrerequisites[0], original.blockedPrerequisites[0]);
  assert.match(hold.liftRequires.probe, /evidence\/source-tests\/.*\.txt$/);
  const generator = readFileSync(join(SCRIPT_DIR, "import-cut-map.mjs"), "utf8");
  assert.doesNotMatch(generator, /step1Freeze\.outside/);

});

test("the generated held map renders the record and planned re-pins", { skip: NEEDS_SOURCE }, () => {
  const generator = join(SCRIPT_DIR, "import-cut-map.mjs");
  const rendered = execFileSync(process.execPath, [generator, "--source", SOURCE], { encoding: "utf8", maxBuffer: 1 << 25 });
  assert.equal(rendered, readFileSync(join(PACKAGE_DIR, "IMPORT-CUT-MAP.md"), "utf8"));
  const record = JSON.parse(readFileSync(join(PACKAGE_DIR, "HOLD.json"), "utf8"));
  const repins = record.step1Freeze.plannedRepins;
  const expected = `Planned re-pins: ${repins.what} ${repins.changes.map((change) => `\`${change.id}\`: ${change.what}`).join(" ")} ${repins.mergePolicy}`;
  assert.ok(rendered.split("\n").includes(expected));
});

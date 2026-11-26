// The KILL check: what `<dataDirectory>/KILL` answers for every entry type and failure, the one log line per change of what
// the check observed, and that the check runs synchronously inside a SQLite BEGIN IMMEDIATE transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { generateCanonicalJobId } from '@kynesyslabs/dacs';
import { createStopCheck, killState } from '../src/kill-switch.mjs';
import { createSellerChallengeLedger } from '../src/dacs/seller-challenge-ledger.mjs';

const RUNNING_AS_ROOT = process.getuid?.() === 0;
// Linux PATH_MAX counts the terminating NUL: a path of 4094 characters can be inspected, one of 4099 cannot.
const LONGEST_INSPECTABLE_PATH = 4094;

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'kill-switch-'));
  t.after(() => { chmodTree(root); rmSync(root, { recursive: true, force: true }); });
  return root;
}
// Gives back search permission a case removed, so the scratch tree can be deleted.
function chmodTree(root) { try { chmodSync(join(root, 'data'), 0o700); } catch { /* the case kept the mode */ } }
function dataDirectory(root) { const directory = join(root, 'data'); mkdirSync(directory, { mode: 0o700 }); return directory; }
// A real directory whose own path can be inspected while `<path>/KILL` is one segment past the limit.
function longDataDirectory(root) {
  let path = root;
  while (LONGEST_INSPECTABLE_PATH - path.length > 201) path = join(path, 'd'.repeat(200));
  path = join(path, 'd'.repeat(LONGEST_INSPECTABLE_PATH - path.length - 1));
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}
function makeFifo(path) {
  const made = spawnSync('mkfifo', [path]);
  assert.equal(made.status, 0, 'mkfifo made the FIFO');
}

// Each case builds its data directory under `root` and returns the path the check is given.
const CASES = [
  { name: 'no KILL', setup: (root) => dataDirectory(root), answer: { present: false, cause: null, fsCode: null } },
  { name: 'an empty regular file', setup: (root) => { const d = dataDirectory(root); writeFileSync(join(d, 'KILL'), ''); return d; }, answer: { present: true, cause: 'kill-present', fsCode: null } },
  { name: 'a regular file with contents the check cannot read', setup: (root) => { const d = dataDirectory(root); writeFileSync(join(d, 'KILL'), 'TEST contents', { mode: 0o000 }); return d; },
    answer: { present: true, cause: 'kill-present', fsCode: null } },
  { name: 'a symlink to a regular file', setup: (root) => { const d = dataDirectory(root); writeFileSync(join(root, 'target'), ''); symlinkSync(join(root, 'target'), join(d, 'KILL')); return d; },
    answer: { present: true, cause: 'kill-present', fsCode: null } },
  { name: 'a directory', setup: (root) => { const d = dataDirectory(root); mkdirSync(join(d, 'KILL')); return d; }, answer: { present: true, cause: 'kill-present', fsCode: null } },
  { name: 'a broken symlink', setup: (root) => { const d = dataDirectory(root); symlinkSync(join(root, 'missing'), join(d, 'KILL')); return d; }, answer: { present: true, cause: 'kill-present', fsCode: null } },
  { name: 'a FIFO', setup: (root) => { const d = dataDirectory(root); makeFifo(join(d, 'KILL')); return d; }, answer: { present: true, cause: 'kill-present', fsCode: null } },
  { name: 'a KILL path past the length limit', setup: (root) => longDataDirectory(root), answer: { present: true, cause: 'kill-unreadable', fsCode: 'ENAMETOOLONG' } },
  { name: 'a data directory without search permission', root: false, setup: (root) => { const d = dataDirectory(root); chmodSync(d, 0o000); return d; },
    answer: { present: true, cause: 'kill-unreadable', fsCode: 'EACCES' } },
  { name: 'a data directory that is a symlink to a real directory', setup: (root) => { mkdirSync(join(root, 'real')); symlinkSync(join(root, 'real'), join(root, 'data')); return join(root, 'data'); },
    answer: { present: true, cause: 'data-directory-not-directory', fsCode: null } },
  { name: 'a missing data directory', setup: (root) => join(root, 'data'), answer: { present: true, cause: 'data-directory-unreadable', fsCode: 'ENOENT' } },
  { name: 'a data directory that is a regular file', setup: (root) => { writeFileSync(join(root, 'data'), ''); return join(root, 'data'); },
    answer: { present: true, cause: 'data-directory-not-directory', fsCode: null } },
];
// Root bypasses mode 0o000, so the permission case runs only for other users; the length-limit case is its stand-in under root.
const casesHere = (t) => {
  const runnable = CASES.filter((entry) => entry.root !== false || !RUNNING_AS_ROOT);
  if (runnable.length < CASES.length) t.diagnostic('running as root: the EACCES case is replaced by the ENAMETOOLONG case');
  return runnable;
};

// Collects every stderr line written while `work` runs.
function stderrLines(work) {
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => { lines.push(...String(chunk).split('\n').filter(Boolean)); const done = rest.find((value) => typeof value === 'function'); done?.(); return true; };
  try { work(); } finally { process.stderr.write = write; }
  return lines;
}
const logged = (lines) => lines.map((line) => { assert.match(line, /^seller-stop: /); return JSON.parse(line.slice('seller-stop: '.length)); });

test('the KILL check reports absent only for ENOENT on KILL inside a real, non-symlink data directory', (t) => {
  for (const entry of casesHere(t)) {
    const directory = entry.setup(scratch(t));
    assert.equal(killState(directory).present, entry.answer.present, entry.name);
    assert.equal(createStopCheck(directory)(), entry.answer.present, `${entry.name}, through the stop check`);
  }
});

test('a failed check counts as present and logs its cause', (t) => {
  const root = scratch(t);
  const directory = dataDirectory(root);
  const check = createStopCheck(directory);
  const kill = join(directory, 'KILL');
  const answers = [];
  const lines = stderrLines(() => {
    answers.push(check());
    writeFileSync(kill, '');
    answers.push(check(), check());
    rmSync(kill);
    answers.push(check());
    writeFileSync(kill, '');
    answers.push(check());
  });
  assert.deepEqual(answers, [false, true, true, false, true]);
  assert.deepEqual(logged(lines), [
    { code: 'seller_stop_observed', stopCause: 'kill-present' },
    { code: 'seller_stop_observed' },
    { code: 'seller_stop_observed', stopCause: 'kill-present' },
  ], 'the first absent state writes nothing; each change writes once, a return to the same cause included');

  const failed = casesHere(t).filter((entry) => entry.answer.cause === 'kill-unreadable');
  for (const entry of failed) {
    const failing = createStopCheck(entry.setup(scratch(t)));
    const failedAnswers = [];
    const failedLines = stderrLines(() => failedAnswers.push(failing(), failing()));
    assert.deepEqual(failedAnswers, [true, true], `${entry.name} counts as stopped`);
    assert.deepEqual(logged(failedLines), [{ code: 'seller_stop_observed', stopCause: 'kill-unreadable', fsCode: entry.answer.fsCode }], `${entry.name} is logged once`);
  }

  // The same cause with another filesystem code is a change: a missing data directory, then one whose parent is a file.
  const parent = join(root, 'parent');
  mkdirSync(parent);
  const nested = createStopCheck(join(parent, 'data'));
  const nestedLines = stderrLines(() => {
    nested(); nested();
    rmSync(parent, { recursive: true });
    writeFileSync(parent, '');
    nested(); nested();
  });
  assert.deepEqual(logged(nestedLines), [
    { code: 'seller_stop_observed', stopCause: 'data-directory-unreadable', fsCode: 'ENOENT' },
    { code: 'seller_stop_observed', stopCause: 'data-directory-unreadable', fsCode: 'ENOTDIR' },
  ]);
  for (const line of [...lines, ...nestedLines]) assert.equal(line.includes(root), false, 'no path reaches the log');
});

const T0 = Date.UTC(2026, 0, 1, 12);
const digest = (label) => createHash('sha256').update(label).digest('hex');
const BUYER = `did:demos:agent:${digest('TEST buyer')}`;
const jobFor = (label) => generateCanonicalJobId({ timestamp: T0, entropy: createHash('sha256').update(label).digest().subarray(0, 10) });

test('killState is synchronous and runs inside a BEGIN IMMEDIATE transaction', (t) => {
  const directory = dataDirectory(scratch(t));
  const db = new Database(join(directory, 'ledger.sqlite'));
  t.after(() => db.close());
  const readInside = db.transaction(() => { assert.equal(db.inTransaction, true); return killState(directory); });
  const absent = readInside.immediate();
  assert.equal(typeof absent?.then, 'undefined', 'a plain answer, not a thenable');
  assert.ok(Object.isFrozen(absent));
  assert.deepEqual(absent, { present: false, cause: null, fsCode: null });
  writeFileSync(join(directory, 'KILL'), '');
  assert.deepEqual(readInside.immediate(), { present: true, cause: 'kill-present', fsCode: null });
  rmSync(join(directory, 'KILL'));

  // The ledger takes the stop check as one of its synchronous ports and reads it inside its issue transaction.
  const transaction = (run) => { db.exec('BEGIN IMMEDIATE'); try { const result = run(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const ledger = createSellerChallengeLedger({ db, transaction, now: () => T0, generation: 'TEST-generation', sessionState: () => null,
    admissionCounts: () => ({ contextRecords: 0, starts: 0, buyerStarts: () => 0 }), ready: () => true, stopped: createStopCheck(directory) });
  const rows = () => db.prepare('SELECT COUNT(*) AS count FROM kit_challenges').get().count;
  const live = { assertStillLive() {} };
  ledger.issue({ jobId: jobFor('open'), buyer: BUYER }, digest('TEST scope'), live);
  assert.equal(rows(), 1);
  writeFileSync(join(directory, 'KILL'), '');
  assert.throws(() => ledger.issue({ jobId: jobFor('stopped'), buyer: BUYER }, digest('TEST scope'), live), { code: 'seller_stopped', status: 503 });
  assert.equal(rows(), 1, 'the stopped issuance wrote nothing');
});

test('killState gives present or absent with its cause for status, /ready and doctor to read', (t) => {
  for (const entry of casesHere(t)) {
    const directory = entry.setup(scratch(t));
    let answer;
    const lines = stderrLines(() => { answer = killState(directory); });
    assert.deepEqual(answer, entry.answer, entry.name);
    assert.ok(Object.isFrozen(answer), `${entry.name}: the answer is frozen`);
    assert.deepEqual(lines, [], `${entry.name}: killState writes nothing`);
  }
});

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readAnchor, recordName } from './delta-record.mjs';

// check-provenance.mjs on a clone of this checkout's HEAD: DELTA-NOTES.md and
// the other anchored paths start from records/ANCHOR.json, not from the
// baseline. README.md needs no record, though the anchor names it.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const P = 'packages/dacs-client/';
const README = `${P}README.md`, NOTES = `${P}DELTA-NOTES.md`;
function scratch(t) {
  const repo = mkdtempSync(join(tmpdir(), 'delta-anchor-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['clone', '--quiet', '--shared', ROOT, repo]);
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=SDK tests', '-c', 'user.email=tests@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  const check = () => {
    const result = spawnSync(process.execPath, [join(repo, P, 'scripts/check-provenance.mjs'), '--local-only'], { encoding: 'utf8' });
    return { status: result.status, text: result.stdout + result.stderr, failures: [...(result.stdout + result.stderr).matchAll(/^FAIL (.*)$/gm)].map(match => match[1]) };
  };
  return { repo, git, check };
}
// Commits an anchored file edit with a record naming only that file.
function recordAnchoredFile(s, subject, path, before) {
  appendFileSync(join(s.repo, path), `\n// ${subject}\n`);
  const after = s.git('hash-object', '--', path);
  const record = { schema: 'dacs-client-delta-record/v1', delta: 'WF', subject, kind: 'change', files: [{ path, before, after }], commitFiles: [] };
  const name = `${P}records/${recordName(record)}`;
  record.commitFiles = [path, name].sort();
  writeFileSync(join(s.repo, name), JSON.stringify(record, null, 2) + '\n');
  s.git('add', '--', P); s.git('commit', '-qm', subject);
  return s.git('rev-parse', 'HEAD');
}

test('the first record of an anchored script starts from the anchor blob', t => {
  const s = scratch(t), path = `${P}scripts/generate-payload-helpers.mjs`;
  recordAnchoredFile(s, 'delta(client): WF record an anchored script change', path, readAnchor(join(s.repo, P)).files[path]);
  const result = s.check();
  assert.equal(result.status, 0, result.text);
});

test('unrecorded and staged changes to anchored files and a record that does not start from the anchor are refused', t => {
  const s = scratch(t);
  appendFileSync(join(s.repo, NOTES), '\nTEST unrecorded line\n');
  s.git('add', '--', NOTES); s.git('commit', '-qm', 'docs(client): TEST unrecorded notes change');
  const unrecorded = s.git('rev-parse', 'HEAD');
  const recorded = recordAnchoredFile(s, 'delta(client): WF TEST notes record after an unrecorded change', NOTES, s.git('rev-parse', `HEAD:${NOTES}`));
  const bytes = readFileSync(join(s.repo, NOTES));
  appendFileSync(join(s.repo, NOTES), '\nTEST staged line\n'); s.git('add', '--', NOTES); writeFileSync(join(s.repo, NOTES), bytes);
  // An anchored script that no record names.
  appendFileSync(join(s.repo, P, 'scripts/generate-payload-helpers.mjs'), '\n// TEST unrecorded edit\n');
  const result = s.check();
  assert.equal(result.status, 1, result.text);
  for (const failure of [
    `${NOTES}: unenumerated change in ${unrecorded}`,
    `${NOTES}: delta parent is discontinuous at ${recorded}`,
    `${NOTES}: index differs from HEAD for a record-named file`,
    `${NOTES}: current blob differs from enumerated deltas`,
    `${P}scripts/generate-payload-helpers.mjs: current blob differs from enumerated deltas`,
  ]) assert.ok(result.failures.includes(failure), `${failure}\n${result.text}`);
});

test('README changes need no record: unrecorded commits, a record that does not start from the anchor and a README listed only in a commit\'s inventory all pass', t => {
  const s = scratch(t);
  appendFileSync(join(s.repo, README), '\nTEST unrecorded line\n');
  s.git('add', '--', README); s.git('commit', '-qm', 'docs(client): TEST unrecorded README change');
  recordAnchoredFile(s, 'delta(client): WF TEST README record after an unrecorded change', README, s.git('rev-parse', `HEAD:${README}`));
  // A source change whose record leaves out the README the same commit changes, with and without it in the inventory.
  for (const [subject, listed] of [['delta(client): WF TEST source change with an unlisted README edit', false], ['delta(client): WF TEST source change with a listed README edit', true]]) {
    const source = `${P}src/record-example-${listed ? 'listed' : 'unlisted'}.mjs`;
    writeFileSync(join(s.repo, source), 'export {};\n');
    appendFileSync(join(s.repo, README), `\nTEST ${subject}\n`);
    const record = { schema: 'dacs-client-delta-record/v1', delta: 'WF', subject, kind: 'change', files: [{ path: source, before: null, after: s.git('hash-object', '--', source) }], commitFiles: [] };
    const name = `${P}records/${recordName(record)}`;
    record.commitFiles = [source, name, ...(listed ? [README] : [])].sort();
    writeFileSync(join(s.repo, name), JSON.stringify(record, null, 2) + '\n');
    s.git('add', '--', source, name, README); s.git('commit', '-qm', subject);
  }
  const result = s.check();
  assert.equal(result.status, 0, result.text);
  // The same unlisted edit to package.json is refused.
  appendFileSync(join(s.repo, P, 'package.json'), '\n');
  s.git('add', '--', `${P}package.json`); s.git('commit', '-qm', 'docs(client): TEST unrecorded manifest change');
  const refused = s.check(), commit = s.git('rev-parse', 'HEAD');
  assert.equal(refused.status, 1, refused.text);
  for (const failure of [
    `${P}package.json: unenumerated change in ${commit}`,
    `complete commit/file inventory differs for ${commit}`,
    `${P}package.json: current blob differs from enumerated deltas`,
  ]) assert.ok(refused.failures.includes(failure), `${failure}\n${refused.text}`);
});

// The records of commits the anchor contains that name this script are in the tree.
const BATCH = `${P}scripts/delta-batch-git.test.mjs`;
const CONTAINED = 'records/D77-6137803ee945.json';
const readRecord = s => JSON.parse(readFileSync(join(s.repo, P, CONTAINED), 'utf8'));
const writeRecord = (s, record, name = CONTAINED) => writeFileSync(join(s.repo, P, name), JSON.stringify(record, null, 2) + '\n');

test('a record of a commit the anchor contains is skipped and the next record starts from the anchor blob', t => {
  const s = scratch(t);
  const before = s.check();
  assert.equal(before.status, 0, before.text);
  assert.ok(before.text.split('\n').some(line => line.includes(`${BATCH}: delta D77 `) && line.endsWith('is contained in the anchor; skipped')), before.text);
  recordAnchoredFile(s, 'delta(client): WF TEST first recorded batch test change', BATCH, readAnchor(join(s.repo, P)).files[BATCH]);
  const after = s.check();
  assert.equal(after.status, 0, after.text);
});

test('a record that starts from the blob of a skipped record is refused', t => {
  const s = scratch(t);
  const commit = recordAnchoredFile(s, 'delta(client): WF TEST batch test change from a skipped blob', BATCH, readRecord(s).files[0].after);
  const result = s.check();
  assert.equal(result.status, 1, result.text);
  assert.ok(result.failures.includes(`${BATCH}: delta parent is discontinuous at ${commit}`), result.text);
});

test('a record of a commit the anchor contains is refused when its before or after blob is wrong', t => {
  for (const [side, at] of [['before', /\^$/], ['after', /[0-9a-f]{40}$/]]) {
    const s = scratch(t), record = readRecord(s);
    record.files[0][side] = '1'.repeat(40);
    writeRecord(s, record);
    const result = s.check();
    assert.equal(result.status, 1, result.text);
    assert.ok(result.failures.some(failure => failure.startsWith(`${BATCH}: delta D77 blob differs at `) && at.test(failure)), `${side}\n${result.text}`);
  }
});

test('a record that selects an unknown commit is refused', t => {
  const s = scratch(t), record = { ...readRecord(s), subject: 'delta(client): D77 TEST unknown commit', sha: '1'.repeat(40), commitFiles: [BATCH] };
  writeRecord(s, record, `records/${recordName(record)}`);
  const result = s.check();
  assert.equal(result.status, 1, result.text);
  assert.ok(result.failures.includes(`delta commit selector must resolve once: ${record.sha} ${record.subject}`), result.text);
});

test('an anchor blob that differs from the file at the anchor commit is refused; the anchor\'s README entry is not read', t => {
  const s = scratch(t), file = join(s.repo, P, 'records/ANCHOR.json'), anchor = JSON.parse(readFileSync(file, 'utf8'));
  anchor.files[NOTES] = '2'.repeat(40);
  anchor.files[`${P}scripts/TEST-absent.mjs`] = '3'.repeat(40);
  anchor.files[README] = '4'.repeat(40);
  writeFileSync(file, JSON.stringify(anchor, null, 2) + '\n');
  const result = s.check();
  assert.equal(result.status, 1, result.text);
  for (const path of [NOTES, `${P}scripts/TEST-absent.mjs`]) assert.ok(result.failures.includes(`${path}: the anchor blob differs from the file at the anchor commit`), result.text);
  assert.ok(!result.failures.some(failure => failure.startsWith(README)), result.text);
});

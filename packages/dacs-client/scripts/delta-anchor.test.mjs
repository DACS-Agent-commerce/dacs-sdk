import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readAnchor, recordName } from './delta-record.mjs';

// check-provenance.mjs on a clone of this checkout's HEAD: README.md and the
// other anchored paths start from records/ANCHOR.json, not from the baseline.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const P = 'packages/dacs-client/';
const README = `${P}README.md`;
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
// Commits an edit of `file` (README.md unless given) with a record naming only
// that file, whose before is `before`, and the regenerated map. Returns the commit.
function recordReadme(s, subject, before, file = README) {
  appendFileSync(join(s.repo, file), `\n${subject}\n`);
  const after = s.git('hash-object', '--', file);
  const record = { schema: 'dacs-client-delta-record/v1', delta: 'WF', subject, kind: 'change', files: [{ path: file, before, after }], commitFiles: [] };
  const name = `${P}records/${recordName(record)}`;
  record.commitFiles = [`${P}DELTA-MAP.md`, file, name].sort();
  writeFileSync(join(s.repo, name), JSON.stringify(record, null, 2) + '\n');
  execFileSync(process.execPath, [`${P}scripts/delta-map.mjs`], { cwd: s.repo });
  s.git('add', '--', P); s.git('commit', '-qm', subject);
  return s.git('rev-parse', 'HEAD');
}

test('the first README record after the anchor starts from the anchor blob', t => {
  const s = scratch(t);
  recordReadme(s, 'delta(client): WF TEST first recorded README change', readAnchor(join(s.repo, P)).files[README]);
  const result = s.check();
  assert.equal(result.status, 0, result.text);
});

test('unrecorded and staged changes to anchored files and a record that does not start from the anchor are refused', t => {
  const s = scratch(t);
  appendFileSync(join(s.repo, README), '\nTEST unrecorded line\n');
  s.git('add', '--', README); s.git('commit', '-qm', 'docs(client): TEST unrecorded README change');
  const unrecorded = s.git('rev-parse', 'HEAD');
  const recorded = recordReadme(s, 'delta(client): WF TEST README record after an unrecorded change', s.git('rev-parse', `HEAD:${README}`));
  const bytes = readFileSync(join(s.repo, README));
  appendFileSync(join(s.repo, README), '\nTEST staged line\n'); s.git('add', '--', README); writeFileSync(join(s.repo, README), bytes);
  // An anchored script that no record names.
  appendFileSync(join(s.repo, P, 'scripts/generate-payload-helpers.mjs'), '\n// TEST unrecorded edit\n');
  const result = s.check();
  assert.equal(result.status, 1, result.text);
  for (const failure of [
    `${README}: unenumerated change in ${unrecorded}`,
    `${README}: delta parent is discontinuous at ${recorded}`,
    `${README}: index differs from HEAD for a record-named file`,
    `${README}: current blob differs from enumerated deltas`,
    `${P}scripts/generate-payload-helpers.mjs: current blob differs from enumerated deltas`,
  ]) assert.ok(result.failures.includes(failure), `${failure}\n${result.text}`);
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
  recordReadme(s, 'delta(client): WF TEST first recorded batch test change', readAnchor(join(s.repo, P)).files[BATCH], BATCH);
  const after = s.check();
  assert.equal(after.status, 0, after.text);
});

test('a record that starts from the blob of a skipped record is refused', t => {
  const s = scratch(t);
  const commit = recordReadme(s, 'delta(client): WF TEST batch test change from a skipped blob', readRecord(s).files[0].after, BATCH);
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

test('an anchor blob that differs from the file at the anchor commit is refused', t => {
  const s = scratch(t), file = join(s.repo, P, 'records/ANCHOR.json'), anchor = JSON.parse(readFileSync(file, 'utf8'));
  anchor.files[README] = '2'.repeat(40);
  anchor.files[`${P}scripts/TEST-absent.mjs`] = '3'.repeat(40);
  writeFileSync(file, JSON.stringify(anchor, null, 2) + '\n');
  const result = s.check();
  assert.equal(result.status, 1, result.text);
  for (const path of [README, `${P}scripts/TEST-absent.mjs`]) assert.ok(result.failures.includes(`${path}: the anchor blob differs from the file at the anchor commit`), result.text);
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkGitStates, packageFiles } from './check-hold.mjs';
import { checkDerivedFreeze } from './delta-freeze.mjs';
import { blob } from './delta-map.mjs';
import { readAnchor, recordName } from './delta-record.mjs';

// The derived rule alone, run on a clone of this checkout's HEAD; the pins in
// HOLD.json are enforced separately by check-hold.mjs (check-hold.test.mjs).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const P = 'packages/dacs-client/';
function scratch(t) {
  const repo = mkdtempSync(join(tmpdir(), 'delta-freeze-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['clone', '--quiet', '--shared', ROOT, repo]);
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=SDK tests', '-c', 'user.email=tests@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  // A checkout of a detached commit clones detached; give every scratch clone a named branch.
  git('switch', '-qc', 'TEST-main');
  return { repo, dir: join(repo, P), git };
}
function derived(s, pins) {
  const frozen = JSON.parse(readFileSync(join(s.dir, 'HOLD.json'), 'utf8')).step1Freeze;
  const { head, index } = checkGitStates(s.repo, frozen, []);
  return checkDerivedFreeze({ repoRoot: s.repo, packageDir: s.dir, pins: pins ?? frozen.files, files: new Set(packageFiles(s.dir)), head, index });
}
// Commits `edits` ({package path: text}) with one record file naming them;
// returns {sha, record: package path of the record file}.
function recordedCommit(s, subject, edits, kind = 'change') {
  const files = Object.entries(edits).map(([path, text]) => {
    let before = null; try { before = s.git('rev-parse', `HEAD:${P}${path}`); } catch { /* a new file */ }
    if (text !== undefined) writeFileSync(join(s.dir, path), text);
    return { path: P + path, before, after: text === undefined ? before : blob(Buffer.from(text)) };
  });
  const record = { schema: 'dacs-client-delta-record/v1', delta: 'WF', subject, kind, files, commitFiles: [] };
  const name = `records/${recordName(record)}`;
  record.commitFiles = [...files.filter(file => file.before !== file.after).map(file => file.path), P + name].sort();
  mkdirSync(join(s.dir, 'records'), { recursive: true });
  writeFileSync(join(s.dir, name), JSON.stringify(record, null, 2) + '\n');
  s.git('add', '--', P);
  s.git('commit', '-qm', subject);
  return { sha: s.git('rev-parse', 'HEAD'), record: name };
}
const readme = s => readFileSync(join(s.dir, 'README.md'), 'utf8');
const notes = s => readFileSync(join(s.dir, 'DELTA-NOTES.md'), 'utf8');
// The notes' expected blob comes from their newest record, else from the anchor.
const NOTES_FROM = '(?:its newest record|the anchor)';

test('the checked-out head passes, and a change with a new record that names only README.md or only DELTA-NOTES.md passes', t => {
  const s = scratch(t);
  assert.deepEqual(derived(s), []);
  recordedCommit(s, 'delta(client): WF TEST update the client README', { 'README.md': `${readme(s)}\nTEST recorded line\n` });
  assert.deepEqual(derived(s), []);
  recordedCommit(s, 'delta(client): WF TEST update the client notes', { 'DELTA-NOTES.md': `${notes(s)}\nTEST recorded line\n` });
  assert.deepEqual(derived(s), []);
});

test('an unrecorded DELTA-NOTES.md change is refused on each side', t => {
  const s = scratch(t), recordedBlob = s.git('rev-parse', `HEAD:${P}DELTA-NOTES.md`);
  appendFileSync(join(s.dir, 'DELTA-NOTES.md'), '\nTEST unrecorded line\n');
  let failures = derived(s);
  assert.equal(failures.length, 1, failures.join('\n'));
  assert.match(failures[0], new RegExp(`^${P}DELTA-NOTES\\.md: working file differs from ${NOTES_FROM} \\(${recordedBlob}\\)$`));
  s.git('add', '--', P); s.git('commit', '-qm', 'docs(client): TEST unrecorded notes change');
  failures = derived(s);
  assert.equal(failures.length, 1, failures.join('\n'));
  assert.match(failures[0], new RegExp(`^${P}DELTA-NOTES\\.md: HEAD, index, working file differ from ${NOTES_FROM} \\(${recordedBlob}\\)$`));
});

test('an unrecorded README change passes on each side, after a README record too', t => {
  const s = scratch(t);
  appendFileSync(join(s.dir, 'README.md'), '\nTEST unrecorded line\n');
  assert.deepEqual(derived(s), []);
  s.git('add', '--', P); s.git('commit', '-qm', 'docs(client): TEST unrecorded README change');
  assert.deepEqual(derived(s), []);
  recordedCommit(s, 'delta(client): WF TEST record a README change', { 'README.md': `${readme(s)}\nTEST recorded line\n` });
  appendFileSync(join(s.dir, 'README.md'), '\nTEST later unrecorded line\n');
  s.git('add', '--', P); s.git('commit', '-qm', 'docs(client): TEST later unrecorded README change');
  assert.deepEqual(derived(s), []);
  s.git('rm', '-q', '--', P + 'README.md'); s.git('commit', '-qm', 'docs(client): TEST remove the README');
  assert.deepEqual(derived(s), []);
});

test('a file the anchor does not name, a file outside every class and a core path without a pin are refused', t => {
  const s = scratch(t);
  for (const path of ['scripts/new-tool.mjs', 'TEST-live.mjs']) writeFileSync(join(s.dir, path), 'export {};\n');
  const pins = { ...JSON.parse(readFileSync(join(s.dir, 'HOLD.json'), 'utf8')).step1Freeze.files };
  delete pins.LICENSE;
  assert.deepEqual(derived(s, pins), [
    `${P}LICENSE: core path without an exact pin`,
    `${P}TEST-live.mjs: not a core path, a record file or a record-named path`,
    `${P}scripts/new-tool.mjs: working file differs from the anchor (no file)`,
  ]);
});

test('a record file cannot be edited, deleted, renamed or added twice', t => {
  const s = scratch(t), { record } = recordedCommit(s, 'delta(client): WF TEST record to tamper with', { 'README.md': `${readme(s)}\nTEST line\n` });
  const added = s.git('rev-parse', `HEAD:${P}${record}`), bytes = readFileSync(join(s.dir, record));
  appendFileSync(join(s.dir, record), '\n'); s.git('add', '--', P); s.git('commit', '-qm', 'TEST edit a record');
  const edited = s.git('rev-parse', 'HEAD');
  assert.deepEqual(derived(s), [
    `${P}${record}: record file changed in ${edited}; a record file is added once and never changed`,
    `${P}${record}: HEAD, index, working file differ from the blob it was added with (${added})`,
  ]);
  s.git('rm', '-q', '--', P + record); s.git('commit', '-qm', 'TEST delete a record');
  const deleted = s.git('rev-parse', 'HEAD');
  assert.ok(derived(s).includes(`${P}${record}: record file deleted in ${deleted}; a record file is added once and never changed`));
  writeFileSync(join(s.dir, record), bytes); s.git('add', '--', P); s.git('commit', '-qm', 'TEST add the record again');
  assert.ok(derived(s).includes(`${P}${record}: record file added again in ${s.git('rev-parse', 'HEAD')}; a record file is added once and never changed`));
});

test('a renamed record, a bad record name and an uncommitted record file are refused', t => {
  const s = scratch(t), { record } = recordedCommit(s, 'delta(client): WF TEST record to rename', { 'README.md': `${readme(s)}\nTEST line\n` });
  s.git('mv', '--', P + record, `${P}records/WF-000000000000.json`); s.git('commit', '-qm', 'TEST rename a record');
  const renamed = s.git('rev-parse', 'HEAD');
  const failures = derived(s);
  assert.ok(failures.includes(`${P}${record}: record file deleted in ${renamed}; a record file is added once and never changed`), failures.join('\n'));
  assert.ok(failures.some(failure => failure.startsWith(`${P}records/WF-000000000000.json: file name must be `)), failures.join('\n'));
  const other = scratch(t);
  writeFileSync(join(other.dir, 'records/notes.txt'), 'TEST\n'); other.git('add', '--', P); other.git('commit', '-qm', 'TEST bad record name');
  assert.deepEqual(derived(other), [`${P}records/notes.txt: not a record file name (<delta>-<12 hex>.json)`]);
  const loose = scratch(t), { record: kept } = recordedCommit(loose, 'delta(client): WF TEST loose record', { 'README.md': `${readme(loose)}\nTEST line\n` });
  loose.git('reset', '-q', '--soft', 'HEAD^'); loose.git('rm', '-q', '--cached', '--', P + kept);
  assert.ok(derived(loose).includes(`${P}${kept}: record file not added by a commit after the baseline`));
});

test('removing a committed checkpoint record is refused by record immutability', t => {
  const s = scratch(t), { record } = recordedCommit(s, 'delta(client): WF TEST bookkeeping checkpoint', { 'src/purchases.mjs': undefined }, 'checkpoint');
  assert.deepEqual(derived(s), []);
  const added = s.git('rev-parse', `HEAD:${P}${record}`);
  s.git('rm', '-q', '--', P + record); s.git('commit', '-qm', 'TEST remove the checkpoint');
  assert.deepEqual(derived(s), [
    `${P}${record}: record file deleted in ${s.git('rev-parse', 'HEAD')}; a record file is added once and never changed`,
    `${P}${record}: HEAD, index, working file differ from the blob it was added with (${added})`,
  ]);
});

test('parallel records of different DELTA-NOTES.md blobs conflict until a later record chooses one', t => {
  const s = scratch(t), start = s.git('rev-parse', 'HEAD'), text = notes(s);
  s.git('switch', '-qc', 'TEST-right', start);
  const right = recordedCommit(s, 'delta(client): WF TEST right notes', { 'DELTA-NOTES.md': `${text}\nTEST right\n` });
  s.git('switch', '-qc', 'TEST-left', start);
  const left = recordedCommit(s, 'delta(client): WF TEST left notes', { 'DELTA-NOTES.md': `${text}\nTEST left\n` });
  s.git('merge', '-q', '--no-ff', '-X', 'ours', '-m', 'TEST merge both records', 'TEST-right');
  const failures = derived(s);
  assert.equal(failures.length, 1, failures.join('\n'));
  assert.match(failures[0], new RegExp(`^${P}DELTA-NOTES\\.md: newest records disagree \\((${left.sha}, ${right.sha}|${right.sha}, ${left.sha})\\); record the chosen blob after the merge$`));
  recordedCommit(s, 'delta(client): WF TEST choose the left notes', { 'DELTA-NOTES.md': undefined }, 'resolution');
  assert.deepEqual(derived(s), []);
});

test('parallel records of different README blobs merge with no record choosing one', t => {
  const s = scratch(t), start = s.git('rev-parse', 'HEAD'), text = readme(s);
  s.git('switch', '-qc', 'TEST-right', start);
  recordedCommit(s, 'delta(client): WF TEST right README', { 'README.md': `${text}\nTEST right\n` });
  s.git('switch', '-qc', 'TEST-left', start);
  recordedCommit(s, 'delta(client): WF TEST left README', { 'README.md': `${text}\nTEST left\n` });
  s.git('merge', '-q', '--no-ff', '-X', 'ours', '-m', 'TEST merge both records', 'TEST-right');
  assert.deepEqual(derived(s), []);
});

// A record file for the newest commit the anchor already contains that changes `path`.
function recordOldCommit(s, anchor, path) {
  const sha = s.git('log', '--no-merges', '--format=%H', '-n', '1', anchor, '--', `${P}${path}`);
  const record = { schema: 'dacs-client-delta-record/v1', delta: 'WF', subject: s.git('log', '-1', '--format=%s', sha), sha, kind: 'change',
    files: [{ path: `${P}${path}`, before: s.git('rev-parse', `${sha}^:${P}${path}`), after: s.git('rev-parse', `${sha}:${P}${path}`) }], commitFiles: [`${P}${path}`] };
  writeFileSync(join(s.dir, 'records', recordName(record)), JSON.stringify(record, null, 2) + '\n');
  return sha;
}

// A branch cut before the anchor's last change to an anchored file holds an older copy of it.
// Its record cannot chain from the anchor's copy, so check-provenance refuses it until the branch is rebased onto the anchor.
test('a DELTA-NOTES.md record of a commit the anchor contains is left out of the chain; a branch cut where the notes already equal the anchor copy may record them', t => {
  const s = scratch(t), { commit: anchor } = readAnchor(s.dir);
  recordOldCommit(s, anchor, 'DELTA-NOTES.md');
  s.git('add', '--', P); s.git('commit', '-qm', 'TEST record a notes commit before the anchor');
  assert.deepEqual(derived(s), []);
  const early = scratch(t), main = early.git('branch', '--show-current');
  const parent = early.git('rev-list', '--parents', '-n', '1', anchor).split(' ').slice(1)
    .find(sha => early.git('rev-parse', `${sha}:${P}DELTA-NOTES.md`) === readAnchor(early.dir).files[`${P}DELTA-NOTES.md`]);
  assert.ok(parent, 'the early branch starts with the anchored notes copy');
  early.git('switch', '-qc', 'TEST-early', parent);
  recordedCommit(early, 'delta(client): WF TEST notes change from before the anchor', { 'DELTA-NOTES.md': `${notes(early)}\nTEST early line\n` });
  early.git('switch', '-q', main); early.git('merge', '-q', '--no-ff', '-m', 'TEST merge an early branch', 'TEST-early');
  recordedCommit(early, 'delta(client): WF choose the notes after a parallel change', { 'DELTA-NOTES.md': undefined }, 'resolution');
  assert.deepEqual(derived(early), []);
});

test('a DELTA-NOTES.md record from a branch cut before the anchor\'s last notes change is refused until the branch is rebased', t => {
  const s = scratch(t), { commit: anchor } = readAnchor(s.dir), main = s.git('branch', '--show-current');
  const last = s.git('log', '--no-merges', '--format=%H', '-n', '1', anchor, '--', `${P}DELTA-NOTES.md`);
  assert.notEqual(s.git('rev-parse', `${last}^:${P}DELTA-NOTES.md`), readAnchor(s.dir).files[`${P}DELTA-NOTES.md`]);
  s.git('switch', '-qc', 'TEST-early', `${last}^`);
  const early = recordedCommit(s, 'delta(client): WF TEST notes change from an old copy', { 'DELTA-NOTES.md': `${notes(s)}\nTEST early line\n` });
  s.git('switch', '-q', main); s.git('merge', '-q', '--no-ff', '--no-commit', '-s', 'ours', 'TEST-early');
  s.git('checkout', 'TEST-early', '--', `${P}DELTA-NOTES.md`, P + early.record); s.git('commit', '-qm', 'TEST merge an old branch');
  recordedCommit(s, 'delta(client): WF choose the notes after merging an old copy', { 'DELTA-NOTES.md': undefined }, 'resolution');
  assert.deepEqual(derived(s), [`${P}DELTA-NOTES.md: delta parent is discontinuous at ${early.sha}`]);
});

test('README records of a commit the anchor contains, or from a branch cut before the anchor\'s last README change, pass with no rebase', t => {
  const s = scratch(t), { commit: anchor } = readAnchor(s.dir), main = s.git('branch', '--show-current');
  recordOldCommit(s, anchor, 'README.md');
  s.git('add', '--', P); s.git('commit', '-qm', 'TEST record a README commit before the anchor');
  assert.deepEqual(derived(s), []);
  const last = s.git('log', '--no-merges', '--format=%H', '-n', '1', anchor, '--', `${P}README.md`);
  assert.notEqual(s.git('rev-parse', `${last}^:${P}README.md`), readAnchor(s.dir).files[`${P}README.md`]);
  s.git('switch', '-qc', 'TEST-early', `${last}^`);
  const early = recordedCommit(s, 'delta(client): WF TEST README change from an old copy', { 'README.md': `${readme(s)}\nTEST early line\n` });
  s.git('switch', '-q', main); s.git('merge', '-q', '--no-ff', '--no-commit', '-s', 'ours', 'TEST-early');
  s.git('checkout', 'TEST-early', '--', `${P}README.md`, P + early.record); s.git('commit', '-qm', 'TEST merge an old branch');
  assert.deepEqual(derived(s), []);
});

test('a record whose selector resolves to no commit is refused', t => {
  const s = scratch(t), subject = 'delta(client): WF TEST record without its commit';
  recordedCommit(s, subject, { 'README.md': `${readme(s)}\nTEST line\n` });
  s.git('commit', '-q', '--amend', '-m', 'docs(client): TEST another subject');
  assert.ok(derived(s).includes(`delta commit selector must resolve once: ${subject}`));
});

test('the anchor must name a commit in the history and be well formed', t => {
  const s = scratch(t), file = join(s.dir, 'records/ANCHOR.json'), anchor = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...anchor, commit: '0'.repeat(40) }));
  assert.deepEqual(derived(s), [`${P}records/ANCHOR.json: anchor commit ${'0'.repeat(40)} is not in the history from the baseline to HEAD`]);
  writeFileSync(file, JSON.stringify({ ...anchor, files: { ...anchor.files, [`${P}src/purchases.mjs`]: '0'.repeat(40) } }));
  assert.deepEqual(derived(s), [`${P}records/ANCHOR.json: not an anchor (schema, a commit and anchored paths with their blobs)`]);
  unlinkSync(file);
  assert.match(derived(s)[0], /^packages\/dacs-client\/records\/ANCHOR\.json: ENOENT/);
});

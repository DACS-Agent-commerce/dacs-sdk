import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assemble } from './delta-assemble.mjs';
import { recordName } from './delta-record.mjs';

const scripts = dirname(fileURLToPath(import.meta.url));
const pkg = join(scripts, '..');
const prefix = 'packages/dacs-client/';
const blobA = 'a'.repeat(40), blobB = 'b'.repeat(40);
const json = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); };
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

function packageDir(t, ledger = { schema: 'dacs-client-deltas/v2', changes: [] }, commits = []) {
  const dir = mkdtempSync(join(tmpdir(), 'TEST-delta-assemble-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  json(join(dir, 'DELTA-LEDGER.json'), ledger); json(join(dir, 'DELTA-COMMITS.json'), commits);
  return dir;
}
function record(subject, overrides = {}) {
  return {
    schema: 'dacs-client-delta-record/v1', delta: 'WF', subject, kind: 'change',
    files: [{ path: prefix + 'src/purchases.mjs', before: blobA, after: blobB }], commitFiles: [prefix + 'src/purchases.mjs'], ...overrides,
  };
}
const put = (dir, value) => { json(join(dir, 'records', recordName(value)), value); return recordName(value); };

test('with no record files the assembled view is the stored archive', t => {
  assert.deepEqual(assemble(pkg), { ledger: readJson(join(pkg, 'DELTA-LEDGER.json')), commits: readJson(join(pkg, 'DELTA-COMMITS.json')), failures: [] });
  const archive = { schema: 'dacs-client-deltas/v2', changes: [{ delta: 'D11', subject: 'one', files: [] }] };
  const dir = packageDir(t, archive, [{ sha: null, subject: 'one', files: ['x'] }]);
  const expected = { ledger: archive, commits: [{ sha: null, subject: 'one', files: ['x'] }], failures: [] };
  assert.deepEqual(assemble(dir), expected);
  mkdirSync(join(dir, 'records')); writeFileSync(join(dir, 'records/.gitkeep'), '');
  assert.deepEqual(assemble(dir), expected);
});

test('records follow the archive in file name order', t => {
  const dir = packageDir(t, { schema: 'dacs-client-deltas/v2', changes: [{ delta: 'D11', subject: 'archived', files: [] }] }, [{ sha: null, subject: 'archived', files: ['x'] }]);
  const names = [
    put(dir, record('later')), put(dir, record('unselected')), put(dir, record('first')), put(dir, record('first', { delta: 'D11' })),
    put(dir, record('control', { kind: 'commit-only', files: undefined, commitFiles: [prefix + 'HOLD.json'] })),
  ].sort();
  const view = assemble(dir);
  const byName = name => readJson(join(dir, 'records', name));
  assert.deepEqual(view.failures, []);
  assert.deepEqual(view.ledger.changes.map(change => change.subject), ['archived', ...names.filter(name => byName(name).kind === 'change').map(name => byName(name).subject)]);
  assert.deepEqual(view.commits, [
    { sha: null, subject: 'archived', files: ['x'] },
    ...names.map(name => ({ sha: null, subject: byName(name).subject, files: byName(name).commitFiles })),
  ]);
  assert.equal(view.ledger.supersededChanges, undefined);
});

test('a record with a sha keeps it in the ledger change and the commit row', t => {
  const dir = packageDir(t), sha = 'c'.repeat(40);
  put(dir, record('hashed', { sha }));
  const view = assemble(dir);
  assert.equal(view.ledger.changes[0].sha, sha);
  assert.equal(view.commits[0].sha, sha);
});

test('a superseded record moves to the superseded lists; superseding a missing record is refused', t => {
  const dir = packageDir(t, { schema: 'dacs-client-deltas/v2', supersededChanges: [{ delta: 'D11', subject: 'old', files: [] }], supersededCommits: [{ sha: null, subject: 'old', files: ['x'] }], changes: [] });
  const earlier = put(dir, record('earlier'));
  put(dir, record('replacement', { supersedes: [earlier] }));
  const view = assemble(dir);
  assert.deepEqual(view.failures, []);
  assert.deepEqual(view.ledger.changes.map(change => change.subject), ['replacement']);
  assert.deepEqual(view.ledger.supersededChanges.map(change => change.subject), ['old', 'earlier']);
  assert.deepEqual(view.ledger.supersededCommits.map(row => row.subject), ['old', 'earlier']);
  assert.deepEqual(view.commits.map(row => row.subject), ['replacement']);
  const missing = put(dir, record('dangling', { supersedes: ['WF-000000000000.json'] }));
  assert.deepEqual(assemble(dir).failures, [`${prefix}records/${missing}: supersedes WF-000000000000.json, which is not a valid record file`]);
});

test('a bad file name, invalid JSON, a directory or a record the schema refuses is reported and left out', t => {
  const dir = packageDir(t);
  const valid = put(dir, record('valid'));
  writeFileSync(join(dir, 'records/notes.json'), '{}');
  writeFileSync(join(dir, 'records/WF-111111111111.json'), '{');
  mkdirSync(join(dir, 'records/WF-222222222222.json'));
  const same = record('same bytes', { files: [{ path: prefix + 'README.md', before: blobA, after: blobA }] });
  put(dir, same);
  const view = assemble(dir);
  assert.deepEqual(view.ledger.changes.map(change => change.subject), [readJson(join(dir, 'records', valid)).subject]);
  assert.deepEqual(view.failures.map(failure => failure.replace(/: not valid JSON: .*/, ': not valid JSON')), [
    `${prefix}records/WF-111111111111.json: not valid JSON`,
    `${prefix}records/WF-222222222222.json: not a regular file`,
    `${prefix}records/${recordName(same)}: a change record names no file whose before differs from after`,
    `${prefix}records/notes.json: not a record file name (<delta>-<12 hex>.json)`,
  ]);
});

// A real history whose checker is this checkout's, with only its fixture pins replaced.
async function history(t) {
  const dir = mkdtempSync(join(tmpdir(), 'TEST-delta-assemble-git-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = join(dir, prefix);
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=SDK tests', '-c', 'user.email=tests@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: 'pipe' }).trimEnd();
  git('init', '--quiet');
  const evidence = { sourceManifest: { files: [{ path: prefix + 'src/example.mjs', sourcePath: 'http-mcp/src/example.mjs' }] }, deltas: { changes: [] }, commits: [] };
  json(join(fixture, 'PROVENANCE.json'), evidence.sourceManifest);
  json(join(fixture, 'DELTA-LEDGER.json'), evidence.deltas);
  json(join(fixture, 'DELTA-COMMITS.json'), evidence.commits);
  json(join(fixture, 'evidence/publication-history.json'), evidence);
  mkdirSync(join(fixture, 'src'));
  for (const [name, text] of [['DELTA-NOTES.md', 'Fixture provenance\n'], ['DELTA-MAP.md', ''], ['README.md', 'Fixture readme\n'], ['src/example.mjs', 'original\n']]) writeFileSync(join(fixture, name), text);
  git('add', '--', prefix); git('commit', '--quiet', '-m', 'TEST baseline');
  const baseline = git('rev-parse', 'HEAD');
  const anchored = Object.fromEntries(['DELTA-NOTES.md', 'README.md'].map(name => [prefix + name, git('rev-parse', `HEAD:${prefix}${name}`)]));
  json(join(fixture, 'records/ANCHOR.json'), { schema: 'dacs-client-anchor/v1', commit: baseline, files: anchored });
  const digest = createHash('sha256').update(readFileSync(join(fixture, 'evidence/publication-history.json'))).digest('hex');
  let checker = readFileSync(join(scripts, 'delta-map.mjs'), 'utf8');
  for (const [name, value] of [['BASELINE', baseline], ['PUBLICATION_HEAD', baseline], ['HISTORY_SHA256', digest]]) {
    const pin = new RegExp(`^export const ${name} = '[a-f0-9]+';`, 'm');
    assert.match(checker, pin);
    checker = checker.replace(pin, `export const ${name} = '${value}';`);
  }
  mkdirSync(join(fixture, 'scripts'));
  writeFileSync(join(fixture, 'scripts/delta-map.mjs'), checker);
  for (const name of ['delta-assemble.mjs', 'delta-record.mjs', 'source-git.mjs', 'publication-text.mjs']) copyFileSync(join(scripts, name), join(fixture, 'scripts', name));
  const { blob, checkDeltas, table, view } = await import(pathToFileURL(join(fixture, 'scripts/delta-map.mjs')));
  json(join(fixture, 'DELTA-LEDGER.json'), { schema: 'dacs-client-deltas/v2', baseline, changes: [] });
  // Commits `edits` ({package path: bytes}) with a record file, as a client change would.
  let sequence = 0;
  const commit = (edits, { kind = 'change', delta = 'WF', subject = `delta(client): ${delta} TEST change ${++sequence}`, extra = [] } = {}) => {
    const files = Object.entries(edits).map(([path, bytes]) => {
      const before = git('ls-tree', 'HEAD', '--', prefix + path).split(/\s+/)[2] ?? null;
      writeFileSync(join(fixture, path), bytes);
      return { path: prefix + path, before, after: blob(Buffer.from(bytes)) };
    });
    const value = { schema: 'dacs-client-delta-record/v1', delta, subject, kind, files };
    const name = recordName(value), changed = new Set([...files.map(file => file.path), prefix + 'records/' + name, prefix + 'DELTA-MAP.md', ...extra]);
    json(join(fixture, 'records', name), { ...value, commitFiles: [...changed].sort() });
    writeFileSync(join(fixture, 'DELTA-MAP.md'), table());
    git('add', '--', ...changed); git('commit', '--quiet', '-m', subject);
    return { name, sha: git('rev-parse', 'HEAD') };
  };
  return { fixture, git, commit, view, check: () => checkDeltas().failures };
}

test('the delta checker accepts source changes recorded in record files', async t => {
  const h = await history(t);
  h.commit({ 'src/example.mjs': 'fixed\n' }, { extra: [prefix + 'DELTA-LEDGER.json'] });
  h.commit({ 'src/example.mjs': 'fixed again\n', 'src/added.mjs': 'added\n' }, { delta: 'D11' });
  assert.deepEqual(h.check(), []);
  assert.match(readFileSync(join(h.fixture, 'DELTA-MAP.md'), 'utf8'), /\| D11 \| delta\(client\): D11 TEST change 2 \|/);
});

test('the delta checker orders records by file name, whatever the order of the commits', async t => {
  const h = await history(t);
  const first = h.commit({ 'src/example.mjs': 'one\n' }), second = h.commit({ 'src/example.mjs': 'two\n' }, { delta: 'D11' });
  assert.ok(second.name < first.name);
  assert.deepEqual(h.view().ledger.changes.map(change => change.delta), ['D11', 'WF']);
  assert.deepEqual(h.check(), []);
});

test('the delta checker accepts a record that changes only README.md, and refuses a stale README blob', async t => {
  const h = await history(t);
  h.commit({ 'README.md': 'changed readme\n' });
  assert.deepEqual(h.check(), []);
  writeFileSync(join(h.fixture, 'README.md'), 'edited after the commit\n');
  assert.ok(h.check().includes(`${prefix}README.md: current blob differs from enumerated deltas`));
});

test('the delta checker accepts the first record of README.md after unrecorded README changes, and still refuses a stale source parent', async t => {
  const h = await history(t);
  writeFileSync(join(h.fixture, 'README.md'), 'changed without a record\n');
  h.commit({ 'src/example.mjs': 'fixed\n' }, { extra: [prefix + 'README.md'] });
  h.commit({ 'README.md': 'changed readme\n' });
  assert.deepEqual(h.check(), []);
  const { name } = h.commit({ 'src/example.mjs': 'fixed again\n' });
  const file = join(h.fixture, 'records', name), good = readJson(file);
  json(file, { ...good, files: [{ ...good.files[0], before: blobA }] });
  h.git('add', '--', prefix + 'records/' + name); h.git('commit', '--quiet', '-m', 'TEST wrong source parent');
  assert.ok(h.check().some(failure => failure.includes('src/example.mjs: delta parent is discontinuous')));
});

test('the delta checker refuses a record the schema refuses, a wrong blob and a subject the archive already records', async t => {
  const h = await history(t);
  const { name, sha } = h.commit({ 'src/example.mjs': 'fixed\n' }, { extra: [prefix + 'DELTA-LEDGER.json'] });
  const file = join(h.fixture, 'records', name), good = readJson(file);
  json(file, { ...good, files: [{ ...good.files[0], after: good.files[0].before }] });
  assert.deepEqual(h.check().filter(failure => failure.includes('records/')), [`${prefix}records/${name}: a change record names no file whose before differs from after`]);
  assert.ok(h.check().includes(`${prefix}src/example.mjs: unenumerated change in ${sha}`));
  json(file, { ...good, kind: 'checkpoint', files: [{ ...good.files[0], after: blobB }] });
  assert.ok(h.check().includes(`${prefix}src/example.mjs: delta WF blob differs at ${sha}`));
  json(file, good);
  const ledger = readJson(join(h.fixture, 'DELTA-LEDGER.json'));
  json(join(h.fixture, 'DELTA-LEDGER.json'), { ...ledger, changes: [{ delta: 'WF', subject: good.subject, files: good.files }] });
  assert.ok(h.check().includes(`duplicate delta subject ${good.subject}`));
});

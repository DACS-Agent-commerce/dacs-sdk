import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assemble, readArchive } from './delta-assemble.mjs';
import { RECORD_NAME, recordName } from './delta-record.mjs';

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
  for (const row of [...(ledger.supersededChanges ?? []), ...ledger.changes]) {
    const file = join(dir, 'records/ids', row.delta + '.json');
    if (!existsSync(file)) json(file, { schema: 'dacs-client-delta-id/v1', delta: row.delta, registration: row.delta + ': fixture lane', subject: row.subject });
  }
  return dir;
}
function record(subject, overrides = {}) {
  return {
    schema: 'dacs-client-delta-record/v1', delta: 'WF', subject, kind: 'change',
    files: [{ path: prefix + 'src/purchases.mjs', before: blobA, after: blobB }], commitFiles: [prefix + 'src/purchases.mjs'], ...overrides,
  };
}
const put = (dir, value) => {
  const declaration = join(dir, 'records/ids', value.delta + '.json');
  if (!existsSync(declaration)) json(declaration, { schema: 'dacs-client-delta-id/v1', delta: value.delta, registration: value.delta + ': fixture lane', subject: value.subject });
  json(join(dir, 'records', recordName(value)), value); return recordName(value);
};

test('the assembled view starts with the stored archive, and is the archive alone when records/ holds no record', t => {
  // The package may hold record files; the archive always comes first and unchanged.
  const stored = { changes: readJson(join(pkg, 'DELTA-LEDGER.json')).changes, commits: readJson(join(pkg, 'DELTA-COMMITS.json')) }, real = assemble(pkg);
  assert.deepEqual(real.failures, []);
  assert.deepEqual(real.ledger.changes.slice(0, stored.changes.length), stored.changes);
  assert.deepEqual(real.commits.slice(0, stored.commits.length), stored.commits);
  const archived = readArchive(pkg);
  const copy = packageDir(t, archived.ledger, archived.commits);
  assert.deepEqual(assemble(copy), { ...archived, failures: [] });
  const archive = { schema: 'dacs-client-deltas/v2', changes: [{ delta: 'D11', subject: 'one', files: [] }] };
  const dir = packageDir(t, archive, [{ sha: null, subject: 'one', files: ['x'] }]);
  const expected = { ledger: archive, commits: [{ sha: null, subject: 'one', files: ['x'] }], failures: [] };
  assert.deepEqual(assemble(dir), expected);
  mkdirSync(join(dir, 'records'), { recursive: true }); writeFileSync(join(dir, 'records/.gitkeep'), '');
  assert.deepEqual(assemble(dir), expected);
});

test('the package assembles with no failures, and its ledger and commits end with its record files', () => {
  const archive = { ledger: readJson(join(pkg, 'DELTA-LEDGER.json')), commits: readJson(join(pkg, 'DELTA-COMMITS.json')) };
  const files = readdirSync(join(pkg, 'records')).filter(name => RECORD_NAME.test(name)).sort();
  const all = files.map(name => ({ name, ...readJson(join(pkg, 'records', name)) }));
  const replaced = new Set(all.flatMap(record => record.supersedes ?? []));
  const current = all.filter(record => !replaced.has(record.name));
  const view = assemble(pkg);
  assert.deepEqual(view.failures, []);
  assert.deepEqual(view.ledger.changes.slice(archive.ledger.changes.length).map(change => change.subject), current.filter(record => record.files !== undefined).map(record => record.subject));
  assert.deepEqual(view.commits.slice(archive.commits.length).map(row => row.subject), current.map(record => record.subject));
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
  for (const name of ['delta-assemble.mjs', 'delta-record.mjs', 'delta-freeze.mjs', 'source-git.mjs', 'publication-text.mjs']) copyFileSync(join(scripts, name), join(fixture, 'scripts', name));
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
    const declaration = join(fixture, 'records/ids', delta + '.json'), added = [];
    if (!existsSync(declaration)) { json(declaration, { schema: 'dacs-client-delta-id/v1', delta, registration: delta + ': fixture lane', subject }); added.push(prefix + 'records/ids/' + delta + '.json'); }
    const name = recordName(value), changed = new Set([...files.map(file => file.path), prefix + 'records/' + name, ...added, ...extra]);
    json(join(fixture, 'records', name), { ...value, commitFiles: [...changed].sort() });

    git('add', '--', ...changed); git('commit', '--quiet', '-m', subject);
    return { name, sha: git('rev-parse', 'HEAD') };
  };
  return { fixture, git, commit, view, table, check: () => checkDeltas().failures };
}

test('the delta checker accepts source changes recorded in record files', async t => {
  const h = await history(t);
  h.commit({ 'src/example.mjs': 'fixed\n' }, { extra: [prefix + 'DELTA-LEDGER.json'] });
  h.commit({ 'src/example.mjs': 'fixed again\n', 'src/added.mjs': 'added\n' }, { delta: 'D11' });
  assert.deepEqual(h.check(), []);
  assert.match(h.table(), /\| D11 \| delta\(client\): D11 TEST change 2 \|/);
});

test('the delta checker orders records by file name, whatever the order of the commits', async t => {
  const h = await history(t);
  const first = h.commit({ 'src/example.mjs': 'one\n' }), second = h.commit({ 'src/example.mjs': 'two\n' }, { delta: 'D11' });
  assert.ok(second.name < first.name);
  assert.deepEqual(h.view().ledger.changes.map(change => change.delta), ['D11', 'WF']);
  assert.deepEqual(h.check(), []);
});

test('the delta checker accepts a record that changes only DELTA-NOTES.md, and refuses a stale notes blob', async t => {
  const h = await history(t);
  h.commit({ 'DELTA-NOTES.md': 'changed notes\n' });
  assert.deepEqual(h.check(), []);
  writeFileSync(join(h.fixture, 'DELTA-NOTES.md'), 'edited after the commit\n');
  assert.ok(h.check().includes(`${prefix}DELTA-NOTES.md: current blob differs from enumerated deltas`));
});

test('the delta checker accepts a record that changes only README.md, and any README blob after it', async t => {
  const h = await history(t);
  h.commit({ 'README.md': 'changed readme\n' });
  assert.deepEqual(h.check(), []);
  writeFileSync(join(h.fixture, 'README.md'), 'edited after the commit\n');
  assert.deepEqual(h.check(), []);
});

test('the delta checker needs no README record: an unlisted README edit and a README record that does not start from the anchor pass', async t => {
  const h = await history(t);
  writeFileSync(join(h.fixture, 'README.md'), 'changed without a record\n');
  h.commit({ 'src/example.mjs': 'fixed\n' }, { extra: [prefix + 'README.md'] });
  h.commit({ 'README.md': 'changed readme\n' });
  writeFileSync(join(h.fixture, 'README.md'), 'committed with no record at all\n');
  h.git('add', '--', prefix + 'README.md'); h.git('commit', '--quiet', '-m', 'docs(client): TEST README alone');
  assert.deepEqual(h.check(), []);
});

test('the delta checker starts the first DELTA-NOTES.md record from the anchor, not from its parent, and refuses a stale source parent', async t => {
  const h = await history(t);
  writeFileSync(join(h.fixture, 'DELTA-NOTES.md'), 'changed without a record\n');
  h.commit({ 'src/example.mjs': 'fixed\n' }, { extra: [prefix + 'DELTA-NOTES.md'] });
  h.commit({ 'DELTA-NOTES.md': 'changed notes\n' });
  const failures = h.check();
  assert.ok(failures.some(failure => failure.startsWith(`${prefix}DELTA-NOTES.md: delta parent is discontinuous at `)), failures.join('\n'));
  assert.ok(failures.some(failure => failure.startsWith(`${prefix}DELTA-NOTES.md: unenumerated change in `)), failures.join('\n'));
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
  assert.ok(h.check().includes(`${prefix}records/${name}: a change record names no file whose before differs from after`));
  assert.ok(h.check().includes(`${prefix}records/${name}: record file differs from the blob it was added with`));
  assert.ok(h.check().includes(`${prefix}src/example.mjs: unenumerated change in ${sha}`));
  json(file, { ...good, kind: 'checkpoint', files: [{ ...good.files[0], after: blobB }] });
  assert.ok(h.check().includes(`${prefix}src/example.mjs: delta WF blob differs at ${sha}`));
  json(file, good);
  const ledger = readJson(join(h.fixture, 'DELTA-LEDGER.json'));
  json(join(h.fixture, 'DELTA-LEDGER.json'), { ...ledger, changes: [{ delta: 'WF', subject: good.subject, files: good.files }] });
  assert.ok(h.check().includes(`duplicate delta subject ${good.subject}`));
});

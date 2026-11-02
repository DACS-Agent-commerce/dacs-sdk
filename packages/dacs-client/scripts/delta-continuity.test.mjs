import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url));
const prefix = 'packages/dacs-client/';
const path = prefix + 'src/example.mjs';
const controls = ['DELTA-LEDGER.json', 'DELTA-COMMITS.json', 'DELTA-MAP.md'];

// Tiny real histories exercise the complete checker without relying on the
// publication ledger. Only its immutable fixture pins are substituted.
async function fixture(t, initial = 'original\n') {
  const dir = mkdtempSync(join(tmpdir(), 'TEST-delta-continuity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pkg = join(dir, prefix);
  for (const name of ['src', 'scripts', 'evidence']) mkdirSync(join(pkg, name), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=SDK tests', '-c', 'user.email=tests@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: 'pipe' }).trimEnd();
  git('init', '--quiet');
  const json = (name, value) => writeFileSync(join(pkg, name), JSON.stringify(value, null, 2) + '\n');
  const read = name => JSON.parse(readFileSync(join(pkg, name), 'utf8'));
  const writeSource = bytes => {
    if (bytes !== null) writeFileSync(join(dir, path), bytes);
    else if (existsSync(join(dir, path))) unlinkSync(join(dir, path));
  };
  writeSource(initial);
  const evidence = {
    sourceManifest: { files: [{ path, sourcePath: 'http-mcp/src/example.mjs' }] },
    deltas: { changes: [] }, commits: [],
  };
  json('PROVENANCE.json', evidence.sourceManifest);
  json('DELTA-LEDGER.json', evidence.deltas);
  json('DELTA-COMMITS.json', evidence.commits);
  json('evidence/publication-history.json', evidence);
  writeFileSync(join(pkg, 'DELTA-NOTES.md'), 'Fixture provenance\n');
  writeFileSync(join(pkg, 'DELTA-MAP.md'), '');
  git('add', '--', ...['PROVENANCE.json', ...controls, 'DELTA-NOTES.md', 'evidence/publication-history.json'].map(name => prefix + name), ...(initial === null ? [] : [path]));
  git('commit', '--quiet', '-m', 'TEST baseline');
  const baseline = git('rev-parse', 'HEAD');
  const digest = createHash('sha256').update(readFileSync(join(pkg, 'evidence/publication-history.json'))).digest('hex');
  let checker = readFileSync(join(scripts, 'delta-map.mjs'), 'utf8');
  for (const [name, value] of [['BASELINE', baseline], ['PUBLICATION_HEAD', baseline], ['HISTORY_SHA256', digest]]) {
    const pin = new RegExp(`^export const ${name} = '[a-f0-9]+';`, 'm');
    assert.match(checker, pin);
    checker = checker.replace(pin, `export const ${name} = '${value}';`);
  }
  writeFileSync(join(pkg, 'scripts/delta-map.mjs'), checker);
  for (const name of ['source-git.mjs', 'publication-text.mjs']) copyFileSync(join(scripts, name), join(pkg, 'scripts', name));
  const { blob, checkDeltas, table } = await import(pathToFileURL(join(pkg, 'scripts/delta-map.mjs')));
  json('DELTA-LEDGER.json', { schema: 'dacs-client-deltas/v2', baseline, changes: [] });
  const render = () => writeFileSync(join(pkg, 'DELTA-MAP.md'), table());
  const sourceBlob = () => existsSync(join(dir, path)) ? blob(readFileSync(join(dir, path))) : null;
  let sequence = 0;
  const record = (bytes, { generate = false } = {}) => {
    const before = sourceBlob();
    writeSource(bytes);
    const subject = `fix(client): D11 TEST change ${++sequence}`;
    if (generate) {
      git('add', '--', path);
      execFileSync(process.execPath, [prefix + 'scripts/delta-map.mjs', '--record', 'D11', subject], { cwd: dir, stdio: 'pipe' });
    } else {
      const ledger = read('DELTA-LEDGER.json');
      ledger.changes.push({ delta: 'D11', subject, files: [{ path, before, after: sourceBlob() }] });
      json('DELTA-LEDGER.json', ledger);
    }
    const files = [...controls.map(name => prefix + name), ...(before === sourceBlob() ? [] : [path])].sort();
    json('DELTA-COMMITS.json', [...read('DELTA-COMMITS.json'), { sha: null, subject, files }]);
    render();
    git('add', '--', ...files);
    git('commit', '--quiet', '-m', subject);
    return git('rev-parse', 'HEAD');
  };
  const note = () => {
    writeFileSync(join(dir, 'TEST-note.txt'), `note ${++sequence}\n`);
    git('add', '--', 'TEST-note.txt'); git('commit', '--quiet', '-m', `TEST note ${sequence}`);
  };
  const branch = (name, start = 'HEAD') => {
    git('switch', '--quiet', '-c', name, start);
    json('DELTA-LEDGER.json', { ...read('DELTA-LEDGER.json'), schema: 'dacs-client-deltas/v2', baseline });
  };
  const merge = (other, bytes) => {
    // Deliberately choose the merge tree, including combining parallel ledgers.
    const incoming = name => JSON.parse(git('show', `${other}:${prefix}${name}`));
    const ledger = read('DELTA-LEDGER.json'), inventory = read('DELTA-COMMITS.json');
    const union = (left, right) => [...left, ...right.filter(row => !left.some(item => item.subject === row.subject))];
    ledger.changes = union(ledger.changes, incoming('DELTA-LEDGER.json').changes);
    const rows = union(inventory, incoming('DELTA-COMMITS.json'));
    git('merge', '--quiet', '--no-ff', '--no-commit', '--strategy=ours', other);
    json('DELTA-LEDGER.json', ledger); json('DELTA-COMMITS.json', rows);
    writeSource(bytes); render();
    git('add', '--', ...controls.map(name => prefix + name), path);
    git('commit', '--quiet', '-m', `TEST merge ${++sequence}`);
  };
  const check = () => checkDeltas().failures;
  return { baseline, branch, check, git, json, merge, note, read, record, render };
}

async function staleMerge(t, fixed = 'fixed\n', merged = 'original\n') {
  const history = await fixture(t);
  history.branch('TEST-side'); history.note();
  history.branch('TEST-fixed', history.baseline); history.record(fixed);
  history.merge('TEST-side', merged);
  assert.deepEqual(history.check(), [`${path}: current blob differs from enumerated deltas`]);
  return history;
}

for (const [name, fixed, merged, next] of [
  ['an edit after a stale merge', 'fixed\n', 'original\n', 'next\n'],
  ['an unchanged-byte checkpoint after a stale merge', 'fixed\n', 'original\n', 'original\n'],
  ['a deletion introduced by a stale merge', 'fixed\n', null, 'next\n'],
  ['a stale restoration of a recorded deletion', null, 'original\n', 'next\n'],
]) {
  test(`${name} cannot become a valid predecessor`, async t => {
    const history = await staleMerge(t, fixed, merged);
    const sha = history.record(next);
    assert.deepEqual(history.check(), [`${path}: delta parent is discontinuous at ${sha}`]);
  });
}

test('the record generator cannot legitimize stale merged bytes', async t => {
  const history = await staleMerge(t);
  const sha = history.record('next\n', { generate: true });
  assert.deepEqual(history.check(), [`${path}: delta parent is discontinuous at ${sha}`]);
});

test('a later correct terminal record cannot conceal an earlier discontinuity', async t => {
  const history = await staleMerge(t);
  const invalid = history.record('next\n');
  history.record('final\n');
  assert.deepEqual(history.check(), [`${path}: delta parent is discontinuous at ${invalid}`]);
});

test('reordering ledger entries cannot conceal a discontinuity', async t => {
  const history = await staleMerge(t);
  const sha = history.record('next\n');
  const ledger = history.read('DELTA-LEDGER.json');
  ledger.changes.reverse(); history.json('DELTA-LEDGER.json', ledger); history.render();
  assert.deepEqual(history.check(), [`${path}: delta parent is discontinuous at ${sha}`]);
});

for (const [name, initial, merged] of [
  ['baseline edit', 'original\n', 'unrecorded\n'],
  ['baseline deletion', 'original\n', null],
  ['unrecorded addition', null, 'unrecorded\n'],
]) {
  test(`the first record must not inherit a merge's ${name}`, async t => {
    const history = await fixture(t, initial);
    history.branch('TEST-side'); history.note();
    history.branch('TEST-main', history.baseline); history.note();
    history.merge('TEST-side', merged);
    const sha = history.record('next\n');
    assert.deepEqual(history.check(), [`${path}: delta parent is discontinuous at ${sha}`]);
  });
}

test('agreeing parallel ancestor records also constrain the next parent', async t => {
  const history = await fixture(t);
  history.branch('TEST-side'); history.record('fixed\n');
  history.branch('TEST-main', history.baseline); history.record('fixed\n');
  history.merge('TEST-side', 'original\n');
  const sha = history.record('next\n');
  assert.deepEqual(history.check(), [`${path}: delta parent is discontinuous at ${sha}`]);
});

test('an explicit parallel resolution constrains descendants after another merge', async t => {
  const history = await fixture(t);
  history.branch('TEST-side'); history.record('side\n');
  history.branch('TEST-main', history.baseline); history.record('main\n');
  history.merge('TEST-side', 'main\n'); history.record('main\n');
  history.branch('TEST-later-side', 'TEST-side'); history.note();
  history.git('switch', '--quiet', 'TEST-main');
  history.merge('TEST-later-side', 'side\n');
  const sha = history.record('next\n');
  assert.deepEqual(history.check(), [`${path}: delta parent is discontinuous at ${sha}`]);
});

for (const chosen of ['main\n', 'combined\n']) {
  test(`an explicit record may resolve divergent parallel records to ${chosen.trim()} bytes`, async t => {
    const history = await fixture(t);
    history.branch('TEST-side'); history.record('side\n');
    history.branch('TEST-main', history.baseline); history.record('main\n');
    history.merge('TEST-side', chosen); history.record(chosen);
    const ledger = history.read('DELTA-LEDGER.json');
    ledger.changes.reverse(); history.json('DELTA-LEDGER.json', ledger); history.render();
    assert.deepEqual(history.check(), []);
  });
}

test('valid additions, checkpoints, deletion, restoration and intentional rollback remain accepted', async t => {
  const history = await fixture(t, null);
  history.record('added\n'); history.record('fixed\n'); history.record('fixed\n');
  history.record(null); history.record('restored\n'); history.record('added\n');
  assert.deepEqual(history.check(), []);
});

test('a clean merge preserves continuous records and checkpoints', async t => {
  const history = await fixture(t);
  history.branch('TEST-side'); history.note();
  history.branch('TEST-main', history.baseline); history.record('fixed\n');
  history.merge('TEST-side', 'fixed\n'); history.record('fixed\n');
  assert.deepEqual(history.check(), []);
});

for (const field of ['before', 'after']) {
  test(`actual Git object validation still refuses incorrect ${field} evidence`, async t => {
    const history = await fixture(t);
    const sha = history.record('next\n');
    const ledger = history.read('DELTA-LEDGER.json');
    ledger.changes[0].files[0][field] = null;
    history.json('DELTA-LEDGER.json', ledger); history.render();
    assert.ok(history.check().includes(`${path}: delta D11 blob differs at ${sha}${field === 'before' ? '^' : ''}`));
  });
}

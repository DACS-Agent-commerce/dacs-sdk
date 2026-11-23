import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assemble } from './delta-assemble.mjs';
import { blob, prefix as P, root } from './delta-map.mjs';
import { isCorePath, recordName } from './delta-record.mjs';
const json = (path, value) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); };
function scratch(t) {
  const repo = mkdtempSync(join(tmpdir(), 'client-record-switch-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['clone', '--quiet', '--shared', root, repo]);
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=SDK tests', '-c', 'user.email=tests@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: 'pipe' }).trimEnd();
  const run = (script, ...args) => {
    const r = spawnSync(process.execPath, script.endsWith('.test') ? [...args, P + 'scripts/' + script + '.mjs'] : [P + 'scripts/' + script + '.mjs', ...args], { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 25 });
    return { status: r.status, text: r.stdout + r.stderr, stdout: r.stdout };
  };
  return { repo, dir: join(repo, P), git, run };
}
function record(s, subject, edits, delta = 'WF') {
  const files = Object.entries(edits).map(([path, bytes]) => {
    let before = null; try { before = s.git('rev-parse', `HEAD:${P}${path}`); } catch { /* added path */ }
    if (bytes === null) rmSync(join(s.dir, path));
    else writeFileSync(join(s.dir, path), bytes);
    return { path: P + path, before, after: bytes === null ? null : blob(Buffer.from(bytes)) };
  });
  const value = { schema: 'dacs-client-delta-record/v1', delta, subject, kind: 'change', files, note: 'The recorded change keeps its own explanation.', commitFiles: [] };
  const name = 'records/' + recordName(value);
  value.commitFiles = [...files.map(f => f.path), P + name].sort();
  json(join(s.dir, name), value); s.git('add', '--', ...value.commitFiles); s.git('commit', '-qm', subject);
  return name;
}
const accepted = r => assert.equal(r.status, 0, r.text);
const refused = (r, message) => { assert.equal(r.status, 1, r.text); assert.match(r.text, message); };

test('the freeze pins only core files and the stored map is absent', () => {
  const hold = JSON.parse(readFileSync(join(root, P, 'HOLD.json'), 'utf8'));
  assert.deepEqual(Object.keys(hold.step1Freeze.files).filter(path => !isCorePath(path)), []);
  assert.equal(existsSync(join(root, P, 'DELTA-MAP.md')), false);
  assert.equal(existsSync(join(root, P, 'records/.gitkeep')), false);
});

test('a source change with its note passes the hold without moving either control', t => {
  const s = scratch(t), controls = ['HOLD.json', 'scripts/check-hold.mjs'].map(path => readFileSync(join(s.dir, path)));
  record(s, 'delta(client): WF update a source with a separate record', { 'src/record-example.mjs': 'export const example = true;\n' });
  accepted(s.run('check-hold'));
  for (const [i, path] of ['HOLD.json', 'scripts/check-hold.mjs'].entries()) assert.deepEqual(readFileSync(join(s.dir, path)), controls[i]);
  const map = s.run('delta-map'); accepted(map);
  assert.match(map.stdout, /The recorded change keeps its own explanation\./);
  assert.equal(existsSync(join(s.dir, 'DELTA-MAP.md')), false);
});

test('a restored stored map is refused by the closed rule', t => {
  const s = scratch(t); writeFileSync(join(s.dir, 'DELTA-MAP.md'), 'stale generated output\n');
  refused(s.run('check-hold'), /DELTA-MAP\.md: not a core path, a record file or a record-named path/);
});

test('id declarations are seeded from the archive and declare new record lanes', t => {
  const s = scratch(t), archived = JSON.parse(readFileSync(join(s.dir, 'DELTA-LEDGER.json'), 'utf8'));
  for (const id of new Set(archived.changes.map(change => change.delta))) assert.ok(existsSync(join(s.dir, 'records/ids', id + '.json')), id);
  const subject = 'delta(client): EXAMPLE declare a separate record lane';
  record(s, subject, { 'src/record-example.mjs': 'export {};\n' }, 'EXAMPLE');
  assert.match(assemble(s.dir).failures.join('\n'), /invalid delta.*EXAMPLE/);
  json(join(s.dir, 'records/ids/EXAMPLE.json'), { schema: 'dacs-client-delta-id/v1', delta: 'EXAMPLE', registration: 'EXAMPLE: example lane', subject });
  s.git('add', '--', P + 'records/ids/EXAMPLE.json'); s.git('commit', '-qm', 'declare the example lane');
  assert.deepEqual(assemble(s.dir).failures, []);
  appendFileSync(join(s.dir, 'records/ids/EXAMPLE.json'), '\n');
  refused(s.run('check-hold'), /records\/ids\/EXAMPLE\.json: working file differs from the blob it was added with/);
});

test('an undeclared commit-only id and malformed declarations are refused', t => {
  const s = scratch(t), value = { schema: 'dacs-client-delta-record/v1', delta: 'UNDECLARED', subject: 'delta(client): UNDECLARED record controls', kind: 'commit-only', commitFiles: [P + 'HOLD.json'] };
  json(join(s.dir, 'records', recordName(value)), value);
  assert.match(assemble(s.dir).failures.join('\n'), /invalid delta.*UNDECLARED/);
  for (const edit of [v => { v.delta = 'OTHER'; }, v => { v.subject = ''; }, v => { v.registration = ''; }, v => { v.extra = true; }, v => { v.schema = 'unknown'; }]) {
    const declaration = { schema: 'dacs-client-delta-id/v1', delta: 'UNDECLARED', registration: 'UNDECLARED: example lane', subject: value.subject }; edit(declaration);
    json(join(s.dir, 'records/ids/UNDECLARED.json'), declaration);
    assert.match(assemble(s.dir).failures.join('\n'), /records\/ids\/UNDECLARED\.json: invalid id declaration/);
  }
});

test('a declaration must name the subject of a record in its lane and have a valid filename', t => {
  const s = scratch(t);
  json(join(s.dir, 'records/ids/EXAMPLE.json'), { schema: 'dacs-client-delta-id/v1', delta: 'EXAMPLE', registration: 'EXAMPLE: example lane', subject: 'delta(client): EXAMPLE absent record' });
  assert.match(assemble(s.dir).failures.join('\n'), /declaration subject.*does not select a record/);
  json(join(s.dir, 'records/ids/bad-name.json'), {});
  assert.match(assemble(s.dir).failures.join('\n'), /bad-name\.json: invalid id declaration/);
});

test('a README-only change and a manifest files change need no re-pin', t => {
  const s = scratch(t), manifest = JSON.parse(readFileSync(join(s.dir, 'package.json'), 'utf8'));
  record(s, 'delta(client): WF update the README alone', { 'README.md': readFileSync(join(s.dir, 'README.md'), 'utf8') + '\nAdditional package guidance.\n' });
  accepted(s.run('check-hold'));
  manifest.files.push('records');
  record(s, 'delta(client): WF include record files in the package inventory', { 'package.json': JSON.stringify(manifest, null, 2) + '\n' });
  accepted(s.run('check-hold'));
});

test('the record command writes the staged inventory without writing the archive or changing the index', t => {
  const s = scratch(t), subject = 'delta(client): WF record a staged source edit';
  const archive = ['DELTA-LEDGER.json', 'DELTA-COMMITS.json'].map(path => readFileSync(join(s.dir, path)));
  appendFileSync(join(s.dir, 'src/index.mjs'), '\n// additional source text\n'); s.git('add', '--', P + 'src/index.mjs');
  const index = s.git('ls-files', '--stage');
  accepted(s.run('delta-map', '--record', 'WF', subject));
  assert.equal(s.git('ls-files', '--stage'), index);
  const value = { delta: 'WF', subject }, file = 'records/' + recordName(value);
  const saved = JSON.parse(readFileSync(join(s.dir, file), 'utf8'));
  assert.deepEqual(saved.commitFiles, [P + file, P + 'src/index.mjs'].sort());
  assert.equal(saved.kind, 'change');
  for (const [i, path] of ['DELTA-LEDGER.json', 'DELTA-COMMITS.json'].entries()) assert.deepEqual(readFileSync(join(s.dir, path)), archive[i]);
  s.git('add', '--', P + file); s.git('commit', '-qm', subject); accepted(s.run('check-hold'));
});

test('the record command leaves the README out of a record\'s files and keeps it in the commit inventory', t => {
  const s = scratch(t);
  appendFileSync(join(s.dir, 'src/index.mjs'), '\n// additional source text\n');
  appendFileSync(join(s.dir, 'README.md'), '\nAdditional package guidance.\n');
  s.git('add', '--', P + 'src/index.mjs', P + 'README.md');
  const subject = 'delta(client): WF record a staged source and README edit';
  accepted(s.run('delta-map', '--record', 'WF', subject));
  const file = 'records/' + recordName({ delta: 'WF', subject }), saved = JSON.parse(readFileSync(join(s.dir, file), 'utf8'));
  assert.equal(saved.kind, 'change');
  assert.deepEqual(saved.files.map(f => f.path), [P + 'src/index.mjs']);
  assert.deepEqual(saved.commitFiles, [P + 'README.md', P + file, P + 'src/index.mjs'].sort());
  s.git('add', '--', P + file); s.git('commit', '-qm', subject);
  accepted(s.run('check-hold')); accepted(s.run('check-provenance', '--local-only'));
  // A staged README edit alone makes a commit-only record.
  appendFileSync(join(s.dir, 'README.md'), '\nMore package guidance.\n'); s.git('add', '--', P + 'README.md');
  const alone = 'delta(client): WF record a staged README edit alone';
  accepted(s.run('delta-map', '--record', 'WF', alone));
  const other = 'records/' + recordName({ delta: 'WF', subject: alone }), only = JSON.parse(readFileSync(join(s.dir, other), 'utf8'));
  assert.equal(only.kind, 'commit-only');
  assert.deepEqual(only.commitFiles, [P + 'README.md', P + other].sort());
  s.git('add', '--', P + other); s.git('commit', '-qm', alone);
  accepted(s.run('check-hold')); accepted(s.run('check-provenance', '--local-only'));
});

test('a README of another package with a name of the same length keeps its place in the commit inventory', t => {
  for (const other of ['packages/dacs-seller/README.md', 'packages/dacs-wallet/README.md']) {
    const s = scratch(t);
    mkdirSync(join(s.repo, other, '..'), { recursive: true });
    appendFileSync(join(s.repo, other), '\nAdditional package guidance.\n');
    s.git('add', '--', other);
    // The record's inventory row names the notes and the record, not the other README the commit also changes.
    const notes = readFileSync(join(s.dir, 'DELTA-NOTES.md'), 'utf8') + '\nAdditional notes.\n';
    record(s, 'delta(client): WF update the notes beside another package README', { 'DELTA-NOTES.md': notes });
    refused(s.run('check-provenance', '--local-only'), new RegExp(`complete commit/file inventory differs for ${s.git('rev-parse', 'HEAD')}`));
  }
});

test('re-pinning keeps only core pins and never stages files', t => {
  const s = scratch(t), core = 'scripts/delta-record.test.mjs';
  appendFileSync(join(s.dir, core), '\n// Additional schema coverage.\n');
  s.git('add', '--', P + core);
  const index = s.git('ls-files', '--stage'), controls = ['HOLD.json', 'scripts/check-hold.mjs'].map(path => readFileSync(join(s.dir, path)));
  accepted(s.run('pin-delta'));
  assert.equal(s.git('ls-files', '--stage'), index);
  const hold = JSON.parse(readFileSync(join(s.dir, 'HOLD.json'), 'utf8'));
  assert.deepEqual(Object.keys(hold.step1Freeze.files).filter(path => !isCorePath(path)), []);
  assert.equal(hold.step1Freeze.files[core].blob, s.git('rev-parse', `:${P}${core}`));
  for (const [i, path] of ['HOLD.json', 'scripts/check-hold.mjs'].entries()) assert.notDeepEqual(readFileSync(join(s.dir, path)), controls[i]);
});

test('re-pinning ignores an unstaged edit to a file that is not a core file', t => {
  const s = scratch(t), core = 'scripts/delta-record.test.mjs';
  appendFileSync(join(s.dir, core), '\n// Additional schema coverage.\n');
  s.git('add', '--', P + core);
  appendFileSync(join(s.dir, 'README.md'), '\nUnrelated unstaged guidance.\n');
  accepted(s.run('pin-delta'));
  const hold = JSON.parse(readFileSync(join(s.dir, 'HOLD.json'), 'utf8'));
  assert.equal(hold.step1Freeze.files[core].blob, s.git('rev-parse', `:${P}${core}`));
});

test('a re-pinned core gate test passes both hold and provenance without a source record', t => {
  const s = scratch(t), subject = 'delta(client): WF update a core gate test', path = P + 'test/delta-ledger-gate.test.mjs';
  appendFileSync(join(s.repo, path), '\n// Additional gate coverage.\n');
  const value = { schema: 'dacs-client-delta-record/v1', delta: 'WF', subject, kind: 'commit-only', commitFiles: [] }, name = P + 'records/' + recordName(value);
  value.commitFiles = [path, name, P + 'HOLD.json', P + 'scripts/check-hold.mjs'].sort();
  json(join(s.repo, name), value); s.git('add', '--', path, name);
  accepted(s.run('pin-delta')); s.git('add', '--', P + 'HOLD.json', P + 'scripts/check-hold.mjs'); s.git('commit', '-qm', subject);
  accepted(s.run('check-hold')); accepted(s.run('check-provenance', '--local-only'));
});

test('unrecorded removal and restoration are refused after a recorded deletion', t => {
  const s = scratch(t), path = 'src/record-example.mjs';
  record(s, 'delta(client): WF add a separately recorded source', { [path]: 'export {};\n' });
  rmSync(join(s.dir, path)); refused(s.run('check-hold'), /src\/record-example\.mjs: working file differs from its newest record/);
  writeFileSync(join(s.dir, path), 'export {};\n');
  record(s, 'delta(client): WF delete the separately recorded source', { [path]: null }); accepted(s.run('check-hold'));
  writeFileSync(join(s.dir, path), 'export {};\n'); refused(s.run('check-hold'), /src\/record-example\.mjs: working file differs from its newest record \(no file\)/);
});


test('recorded source imports leave the pinned historical map valid', { skip: !process.env.DACS_FRONTEND_REPO }, t => {
  const s = scratch(t);
  // This is source text for the audit, rather than an import by this core test.
  const source = `export * ${'fr' + 'om'} './index.mjs';\n`;
  record(s, 'delta(client): WF record an additional relative import', { 'src/record-example.mjs': source });
  accepted(s.run('check-hold'));
  accepted(s.run('check-provenance.test', '--test', '--test-name-pattern=^the generated held map renders the record and planned re-pins$'));
});

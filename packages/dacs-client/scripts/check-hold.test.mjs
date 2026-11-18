import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {BASELINE} from './delta-map.mjs';
import {publicationJson} from './publication-text.mjs';
const SDK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const PACKAGE_DIR = join(SDK_ROOT, 'packages/dacs-client');
const GATE = join(PACKAGE_DIR, 'scripts/check-hold.mjs');
const P = 'packages/dacs-client/';
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], {env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
const commit = (repo, message) => git(repo, '-c', 'user.name=SDK tests', '-c', 'user.email=tests@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', message);
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// One FAIL line, matched whole: `path` is package-relative, `reason` a regex source.
const fail = (path, reason) => new RegExp(`^FAIL ${escape(P + path)}: ${reason}$`, 'm');
// Where the derived rule takes the expected blob of a source file from.
const DERIVED = '(?:its newest record|the baseline) \\((?:[0-9a-f]{40}|no file)\\)';
function put(file, text) { mkdirSync(dirname(file), {recursive:true}); writeFileSync(file, text); }
// A clone of this checkout's HEAD, with the history the derived freeze rule reads.
function scratch(t, ...options) {
  const repo = mkdtempSync(join(tmpdir(), 'client-hold-'));
  t.after(() => rmSync(repo, {recursive:true, force:true}));
  execFileSync('git', ['clone', '--quiet', ...options, ...(options.length ? [`file://${SDK_ROOT}`] : ['--shared', SDK_ROOT]), repo], {env: gitEnv, stdio: 'pipe'});
  // A checkout of a detached commit clones detached; give every scratch clone a named branch.
  git(repo, 'switch', '-qc', 'TEST-main');
  return {repo, dir: join(repo, 'packages/dacs-client')};
}
function gate({repo, dir}) {
  const r = spawnSync(process.execPath, [GATE, '--repo-root', repo, '--package-dir', dir], {encoding:'utf8'});
  return {status:r.status, text:r.stdout+r.stderr};
}
function passes(s) { const r=gate(s); assert.equal(r.status, 0, r.text); }
function refuses(s, ...patterns) {const r=gate(s); assert.equal(r.status, 1, r.text); for (const pattern of patterns) assert.match(r.text, pattern);}

test('launch review: unrelated working, staged and committed changes pass', t => {
  const s=scratch(t); passes(s);
  put(join(s.repo, 'docs/new-sdk-guide.md'), 'Unrelated SDK documentation\n');
  appendFileSync(join(s.repo, 'src/index.ts'), '\n// unrelated SDK hotfix\n');
  unlinkSync(join(s.repo, 'README.md'));
  passes(s);
  git(s.repo, 'add', '-A'); passes(s);
  commit(s.repo, 'unrelated SDK changes'); passes(s);
});
test('launch review: a merge commit with unrelated main changes passes', t => {
  const s=scratch(t), original=git(s.repo, 'branch', '--show-current').trim();
  git(s.repo, 'checkout', '-qb', 'advanced-main');
  put(join(s.repo, 'main-hotfix.txt'), 'hotfix\n'); git(s.repo, 'add', '.'); commit(s.repo, 'main hotfix');
  git(s.repo, 'checkout', '-q', original);
  put(join(s.repo, 'pr-guide.txt'), 'guide\n'); git(s.repo, 'add', '.'); commit(s.repo, 'PR docs');
  git(s.repo, '-c', 'user.name=SDK tests', '-c', 'user.email=tests@example.invalid', '-c', 'commit.gpgsign=false', 'merge', '--no-ff', '-qm', 'PR merge', 'advanced-main');
  passes(s);
});
test('unchanged package and checkout pass', t => passes(scratch(t)));
// Each case names the path and the reason from the pins and from the derived rule.
const PACKAGE_EDITS = {
  add: [s => put(join(s.dir,'dist/live.mjs'), 'export {};\n'), fail('dist/live.mjs', 'added file; package is frozen'), fail('dist/live.mjs', 'not a core path, a record file or a record-named path')],
  change: [s => appendFileSync(join(s.dir,'src/purchases.mjs'), '\n'), fail('src/purchases.mjs', 'changed bytes; package is frozen'), fail('src/purchases.mjs', 'working file differs from HEAD \\(bytes or mode\\)'), fail('src/purchases.mjs', `working file differs from ${DERIVED}`)],
  delete: [s => unlinkSync(join(s.dir,'src/purchases.mjs')), fail('src/purchases.mjs', 'missing file; package is frozen'), fail('src/purchases.mjs', `working file differs from ${DERIVED}`)],
  symlink: [s => symlinkSync(join(s.dir,'src/purchases.mjs'), join(s.dir,'linked')), /^\[check-hold\] packages\/dacs-client\/linked: not a regular file \(symlinks are refused\)$/m],
};
for (const [action, [edit, ...patterns]] of Object.entries(PACKAGE_EDITS)) test(`package ${action} is refused`, t => {
  const s=scratch(t); edit(s); refuses(s, ...patterns);
});
for (const field of ['exports','main','bin','scripts']) test(`package manifest ${field} cannot bypass the hold`, t => {
  const s=scratch(t), file=join(s.dir,'package.json'), p=readJson(file);
  p[field]=field==='exports'?{'.':'./src/purchases.mjs'}:field==='scripts'?{test:'true'}:'./src/purchases.mjs';
  writeFileSync(file, JSON.stringify(p));
  refuses(s, fail('package.json', 'changed bytes; package is frozen'), new RegExp(`^FAIL package\\.json: key ${field} differs from the reviewed manifest$`, 'm'), fail('package.json', 'working file differs from the anchor .*'));
});
for (const [change, key, edit] of [['an added key', 'sideEffects', p => { p.sideEffects = false; }], ['a changed version', 'version', p => { p.version = '0.1.0'; }]]) test(`package manifest ${change} is refused by the manifest pin`, t => {
  const s=scratch(t), file=join(s.dir,'package.json'), p=readJson(file); edit(p); writeFileSync(file, JSON.stringify(p, null, 2) + '\n');
  refuses(s, new RegExp(`^FAIL package\\.json: key ${key} differs from the reviewed manifest$`, 'm'));
});
test('a package.json files edit is record-named, not pinned by the manifest', t => {
  const s=scratch(t), file=join(s.dir,'package.json'), p=readJson(file); p.files.push('scripts/check-hold.mjs'); writeFileSync(file, JSON.stringify(p, null, 2) + '\n');
  const r=gate(s); assert.equal(r.status, 1, r.text);
  assert.match(r.text, fail('package.json', 'working file differs from the anchor .*'));
  assert.doesNotMatch(r.text, /key files/);
});
test('package staged changes fail even with restored working bytes', t => {
  const s=scratch(t), file=join(s.dir,'src/purchases.mjs'), bytes=readFileSync(file);
  appendFileSync(file,'\n');git(s.repo,'add','.');writeFileSync(file,bytes);
  refuses(s, fail('src/purchases.mjs', 'index differs from HEAD \\(path, blob or mode\\)'), fail('src/purchases.mjs', `index differs from ${DERIVED}`));
});
test('package HEAD changes fail even with restored index and working bytes', t => {
  const s=scratch(t), file=join(s.dir,'src/purchases.mjs'), bytes=readFileSync(file);
  appendFileSync(file,'\n');git(s.repo,'add','.');commit(s.repo,'unreviewed package change');
  writeFileSync(file,bytes);git(s.repo,'add','.');
  refuses(s, fail('src/purchases.mjs', 'HEAD blob differs from the freeze pin'), fail('src/purchases.mjs', `HEAD differs from ${DERIVED}`));
});
test('a committed package addition or deletion fails even with restored index and working files', t => {
  const added=scratch(t); put(join(added.dir,'dist/live.mjs'), 'export {};\n'); git(added.repo,'add','-f','--','packages/dacs-client/dist/live.mjs'); commit(added.repo,'unreviewed package addition');
  git(added.repo,'rm','-q','--cached','--','packages/dacs-client/dist/live.mjs'); rmSync(join(added.dir,'dist'),{recursive:true});
  refuses(added, fail('dist/live.mjs', 'added in HEAD; package is frozen'), fail('dist/live.mjs', 'not a core path, a record file or a record-named path'));
  const deleted=scratch(t); git(deleted.repo,'rm','-q','--','packages/dacs-client/src/purchases.mjs'); commit(deleted.repo,'unreviewed package deletion');
  git(deleted.repo,'checkout','HEAD^','--','packages/dacs-client/src/purchases.mjs');
  refuses(deleted, fail('src/purchases.mjs', 'missing from HEAD; package is frozen'), fail('src/purchases.mjs', `HEAD differs from ${DERIVED}`));
});
test('package index mode changes are refused', t => {
  const s=scratch(t);git(s.repo,'update-index','--chmod=+x','packages/dacs-client/src/purchases.mjs');
  refuses(s, fail('src/purchases.mjs', 'index differs from HEAD \\(path, blob or mode\\)'));
});
const CONTROL_EDITS = {
  gate: [s => appendFileSync(join(s.dir,'scripts/check-hold.mjs'),'\n'), fail('scripts/check-hold.mjs', 'gate differs from the trusted running gate')],
  record: [s => appendFileSync(join(s.dir,'HOLD.json'),'\n'), /^FAIL HOLD\.json bytes differ from the pinned record$/m],
  // Same bytes apart from the gate blob, so only the reciprocal gate-blob check sees it.
  reciprocal: [s => {const file=join(s.dir,'HOLD.json'),r=readJson(file);r.step1Freeze.files['scripts/check-hold.mjs'].blob='0'.repeat(40);writeFileSync(file,publicationJson(r));}, /^FAIL check-hold\.mjs bytes differ from the gate blob pinned by HOLD\.json$/m],
  // A pinned text field: the canonical record hash names it.
  text: [s => {const file=join(s.dir,'HOLD.json'),r=readJson(file);r.holds[0].reason+=' TEST';writeFileSync(file,publicationJson(r));}, /^FAIL HOLD\.json differs from the record the gate pins: canonical SHA-256 [0-9a-f]{64}, pinned /m],
};
for (const [action, [edit, pattern]] of Object.entries(CONTROL_EDITS)) test(`a ${action}-only control edit is refused`, t => {
  const s=scratch(t); edit(s); refuses(s, pattern);
});
test('new exports remain refused through the package command', t => {
  const s=scratch(t), file=join(s.dir,'package.json'), p=readJson(file);p.exports={'.':'./src/purchases.mjs'};writeFileSync(file,JSON.stringify(p));
  const r=spawnSync('npm',['test'],{cwd:s.dir,encoding:'utf8'});
  assert.equal(r.status,1,r.stdout+r.stderr);
  assert.match(r.stderr,fail('package.json', 'changed bytes; package is frozen'));
  assert.match(r.stderr,/^FAIL package\.json: key exports differs from the reviewed manifest$/m);
  assert.doesNotMatch(r.stdout,/^# tests /m);
});
test('missing HEAD and malformed record fail closed', t => {
  const s=scratch(t);rmSync(join(s.repo,'.git'),{recursive:true,force:true});refuses(s,/not a git repository|not the Git worktree root/);
  const other=scratch(t);writeFileSync(join(other.dir,'HOLD.json'),'{');refuses(other,/^FAIL HOLD\.json is not valid JSON: /m);
});
test('an unrecorded README change after the anchor is refused by both rules', t => {
  const s=scratch(t); appendFileSync(join(s.dir,'README.md'),'\nTEST unrecorded line\n');
  refuses(s, fail('README.md', 'changed bytes; package is frozen'), fail('README.md', 'working file differs from the anchor \\([0-9a-f]{40}\\)'));
});
test('a file the anchor does not name is refused, and a deleted baseline script cannot come back', t => {
  const s=scratch(t);
  for (const path of ['scripts/new-tool.mjs', 'scripts/stale-pointer.probe.test.mjs']) put(join(s.dir, path), 'export {};\n');
  refuses(s, ...['scripts/new-tool.mjs', 'scripts/stale-pointer.probe.test.mjs'].flatMap(path => [fail(path, 'added file; package is frozen'), fail(path, 'working file differs from the anchor \\(no file\\)')]));
});
test('an evidence file without a pin is refused as a core path', t => {
  const s=scratch(t); put(join(s.dir,'evidence/TEST-note.txt'),'unpinned\n');
  refuses(s, fail('evidence/TEST-note.txt', 'added file; package is frozen'), fail('evidence/TEST-note.txt', 'core path without an exact pin'));
});
test('without the history from the baseline the derived rule fails closed by name', t => {
  const shallow=scratch(t, '--depth', '1');
  const fresh=scratch(t); rmSync(join(fresh.repo,'.git'),{recursive:true,force:true}); git(fresh.repo,'init','-q'); git(fresh.repo,'add','-f','.'); commit(fresh.repo,'test baseline');
  // Shallow, yet holding the baseline and every commit after it.
  const grafted=scratch(t); writeFileSync(join(grafted.repo,'.git/shallow'),`${BASELINE}\n`);
  for (const s of [shallow, fresh, grafted]) {
    const r=gate(s); assert.equal(r.status, 1, r.text);
    assert.deepEqual([...r.text.matchAll(/^FAIL (.*)$/gm)].map(match => match[1]), [`the derived freeze rule needs the Git history from ${BASELINE} to HEAD; this checkout is shallow or does not contain it`]);
  }
});
test('the derived rule is not loaded while one of its modules differs from its pin', t => {
  const s=scratch(t); appendFileSync(join(s.dir,'scripts/delta-freeze.mjs'),'\nthrow new Error("TEST loaded an unverified module");\n');
  const r=gate(s); assert.equal(r.status, 1, r.text);
  assert.match(r.text, fail('scripts/delta-freeze.mjs', 'changed bytes; package is frozen'));
  assert.match(r.text, /^FAIL derived freeze rule not run: scripts\/delta-freeze\.mjs must match the freeze pins first$/m);
  assert.doesNotMatch(r.text, /TEST loaded an unverified module/);
});

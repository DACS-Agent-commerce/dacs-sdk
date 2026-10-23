import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
const SDK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const PACKAGE_DIR = join(SDK_ROOT, 'packages/dacs-client');
const GATE = join(PACKAGE_DIR, 'scripts/check-hold.mjs');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
// Synchronous Git commands can still detach maintenance that races teardown.
const git = (repo, ...args) => execFileSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-C', repo, ...args], {env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
const commit = (repo, message) => git(repo, '-c', 'user.name=SDK tests', '-c', 'user.email=tests@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', message);
function put(file, text) { mkdirSync(dirname(file), {recursive:true}); writeFileSync(file, text); }
function scratch(t) {
  const repo = mkdtempSync(join(tmpdir(), 'client-hold-'));
  t.after(() => rmSync(repo, {recursive:true, force:true, maxRetries:5, retryDelay:50}));
  const dir = join(repo, 'packages/dacs-client');
  cpSync(PACKAGE_DIR, dir, {recursive:true});
  // Old snapshots need their complete outside tree to reproduce the review.
  const outside = readJson(join(dir, 'HOLD.json')).step1Freeze.outside?.files;
  for (const path of Object.keys(outside ?? {})) cpSync(join(SDK_ROOT, path), join(repo, path));
  if (!outside) {
    put(join(repo, 'README.md'), 'SDK documentation\n');
    put(join(repo, 'src/index.ts'), 'export {};\n');
  }
  git(repo, 'init', '-q');
  git(repo, 'add', '-f', '.');
  commit(repo, 'test baseline');
  return {repo, dir};
}
function gate({repo, dir}) {
  const r = spawnSync(process.execPath, [GATE, '--repo-root', repo, '--package-dir', dir], {encoding:'utf8'});
  return {status:r.status, text:r.stdout+r.stderr};
}
function passes(s) { const r=gate(s); assert.equal(r.status, 0, r.text); }
function refuses(s, pattern) {const r=gate(s); assert.equal(r.status, 1, r.text); assert.match(r.text, pattern);}

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
for (const action of ['add','change','delete','symlink']) test(`package ${action} is refused`, t => {
  const s=scratch(t), path=join(s.dir, 'src/purchases.mjs');
  if(action==='add') put(join(s.dir,'dist/live.mjs'), 'export {};\n');
  if(action==='change') appendFileSync(path, '\n');
  if(action==='delete') unlinkSync(path);
  if(action==='symlink') symlinkSync(path, join(s.dir,'linked'));
  refuses(s, /package is frozen|symlinks are refused/);
});
for (const field of ['exports','main','bin','scripts']) test(`package manifest ${field} cannot bypass the hold`, t => {
  const s=scratch(t), file=join(s.dir,'package.json'), p=readJson(file);
  p[field]=field==='exports'?{'.':'./src/purchases.mjs'}:field==='scripts'?{test:'true'}:'./src/purchases.mjs';
  writeFileSync(file, JSON.stringify(p)); refuses(s,/package.json: changed bytes/);
});
test('package staged changes fail even with restored working bytes', t => {
  const s=scratch(t), file=join(s.dir,'src/purchases.mjs'), bytes=readFileSync(file);
  appendFileSync(file,'\n');git(s.repo,'add','.');writeFileSync(file,bytes);
  refuses(s,/index differs from HEAD/);
});
test('package HEAD changes fail even with restored index and working bytes', t => {
  const s=scratch(t), file=join(s.dir,'src/purchases.mjs'), bytes=readFileSync(file);
  appendFileSync(file,'\n');git(s.repo,'add','.');commit(s.repo,'unreviewed package change');
  writeFileSync(file,bytes);git(s.repo,'add','.');refuses(s,/HEAD blob differs from the freeze pin/);
});
test('package index mode changes are refused', t => {
  const s=scratch(t);git(s.repo,'update-index','--chmod=+x','packages/dacs-client/src/purchases.mjs');refuses(s,/index differs from HEAD/);
});
for (const action of ['gate','record','reciprocal']) test(`a ${action}-only control edit is refused`, t => {
  const s=scratch(t);
  if(action==='gate') appendFileSync(join(s.dir,'scripts/check-hold.mjs'),'\n');
  else if(action==='record') appendFileSync(join(s.dir,'HOLD.json'),'\n');
  else {const file=join(s.dir,'HOLD.json'),r=readJson(file);r.step1Freeze.files['scripts/check-hold.mjs'].blob='0'.repeat(40);writeFileSync(file,JSON.stringify(r));}
  refuses(s,/gate differs|bytes differ|record the gate pins/);
});
test('new exports remain refused through the package command', t => {
  const s=scratch(t), file=join(s.dir,'package.json'), p=readJson(file);p.exports={'.':'./src/purchases.mjs'};writeFileSync(file,JSON.stringify(p));
  const r=spawnSync('npm',['test'],{cwd:s.dir,encoding:'utf8'});
  assert.equal(r.status,1,r.stdout+r.stderr);assert.match(r.stderr,/package.json: changed bytes/);assert.doesNotMatch(r.stdout,/^# tests /m);
});
test('missing HEAD and malformed record fail closed', t => {
  const s=scratch(t);rmSync(join(s.repo,'.git'),{recursive:true,force:true,maxRetries:5,retryDelay:50});refuses(s,/not a git repository|not the Git worktree root/);
  const other=scratch(t);writeFileSync(join(other.dir,'HOLD.json'),'{');refuses(other,/not valid JSON/);
});

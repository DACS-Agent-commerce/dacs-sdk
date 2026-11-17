import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ancestorsIn, blobIds, commitsIn, independentIn, readHistory } from './delta-map.mjs';

// Each test compares one batched read with the per-commit git call it replaces,
// on a history with merges, a rename, a deleted path and a path with a newline.
const repo = mkdtempSync(join(tmpdir(), 'delta-batch-git-'));
after(() => rmSync(repo, { recursive: true, force: true }));
const gitIn = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=SDK tests', '-c', 'user.email=tests@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { encoding: 'utf8', stdio: 'pipe' }).trimEnd();
const git = (...args) => gitIn(repo, ...args);
const lines = text => text.split('\n').filter(Boolean);
const commit = (message, files = {}) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git('add', '--all'); git('commit', '--quiet', '--allow-empty', '-m', message);
  return git('rev-parse', 'HEAD');
};
const PATHS = ['a.txt', 'dir/b.txt', 'old.txt', 'renamed.txt', 'gone.txt', 'new.txt', 'side1.txt', 'dir/odd\nname.txt', 'with space.txt', 'dir', 'missing.txt'];

git('init', '--quiet', '--initial-branch=main');
const base = commit('base', { 'a.txt': 'a1\n', 'dir/b.txt': 'b1\n', 'old.txt': 'old text\n', 'gone.txt': 'g1\n', 'dir/odd\nname.txt': 'odd\n', 'with space.txt': 'space\n' });
git('switch', '--quiet', '--create', 'side1');
commit('s1', { 'dir/b.txt': 'b2\n' });
const side1 = commit('s1b', { 'side1.txt': 's\n' });
git('switch', '--quiet', '--create', 'side2', base);
git('rm', '--quiet', 'gone.txt');
const deleted = commit('t1');
const side2 = commit('t2', { 'new.txt': 'n\n' });
git('switch', '--quiet', '--create', 'side3', base);
const side3 = commit('x1', { 'extra.txt': 'x\n' });
git('switch', '--quiet', 'main');
const first = commit('c1', { 'a.txt': 'a2\n' });
git('mv', 'old.txt', 'renamed.txt');
const renamed = commit('c2');
git('merge', '--quiet', '--no-ff', '-m', 'm1', 'side1');
git('merge', '--quiet', '--no-ff', '-m', 'm2', 'side2');
git('merge', '--quiet', '--no-ff', '--strategy=ours', '-m', 'm3', 'side3');
commit('tip', { 'renamed.txt': 'new text\n', 'dir/odd\nname.txt': 'odd 2\n' });
const range = `${base}..HEAD`;
const history = readHistory(repo, base);
const nonMerges = lines(git('log', '--no-merges', '--format=%H', range));

test('readHistory lists every commit of the range with its parents and the paths git diff reports without renames', () => {
  assert.deepEqual([...history.keys()].sort(), lines(git('rev-list', range)).sort());
  for (const [sha, entry] of history) assert.deepEqual(entry.parents, lines(git('rev-list', '--parents', '-n1', sha)).join(' ').split(' ').slice(1), sha);
  for (const sha of nonMerges) assert.deepEqual(history.get(sha).files, lines(git('diff', '--no-renames', '--name-only', `${sha}^`, sha)), sha);
  // x1 changes extra.txt on a side branch that the m3 merge discards; a limited log must still list it.
  const limited = readHistory(repo, base, ['dir', 'extra.txt']);
  for (const sha of nonMerges) assert.deepEqual(limited.get(sha)?.files ?? [], lines(git('diff', '--no-renames', '--name-only', `${sha}^`, sha, '--', 'dir', 'extra.txt')), sha);
  assert.deepEqual(limited.get(side3).files, ['extra.txt']);
  assert.ok([...history.values()].some(entry => entry.files.some(path => path.startsWith('"dir/odd'))), 'a path git quotes is kept quoted');
  assert.deepEqual(history.get(renamed).files, ['old.txt', 'renamed.txt']);
  assert.deepEqual(history.get(deleted).files, ['gone.txt']);
});

test('ancestorsIn returns what git rev-list names below the first parent, bounded by the range', () => {
  for (const sha of nonMerges) assert.deepEqual([...ancestorsIn(history, sha)].sort(), lines(git('rev-list', `${base}..${sha}^`)).sort(), sha);
});

test('independentIn returns the commits git merge-base --independent returns, in the same order', () => {
  const permute = items => items.length < 2 ? [items] : items.flatMap((item, at) => permute([...items.slice(0, at), ...items.slice(at + 1)]).map(rest => [item, ...rest]));
  const inputs = permute([first, renamed, side1, side2, side3]);
  assert.equal(inputs.length, 120);
  for (const shas of inputs) assert.deepEqual(independentIn(history, shas), git('merge-base', '--independent', ...shas).split('\n'), shas.join(' '));
});

test('blobIds returns what git rev-parse --verify returns for present, deleted, renamed, directory and unknown paths', () => {
  const specs = [`${base}^:a.txt`];
  for (const sha of history.keys()) for (const path of PATHS) specs.push(`${sha}:${path}`, `${sha}^:${path}`);
  const expected = new Map(specs.map(spec => { try { return [spec, git('rev-parse', '--verify', spec)]; } catch { return [spec, null]; } }));
  assert.deepEqual(blobIds(specs, repo), expected);
  assert.ok([...expected.values()].includes(null) && new Set(expected.values()).size > 10);
});

// A second, small history whose commits are signed by a stand-in signing program, with the repository's own
// config set to print signatures in `git log`, and with files whose names end in a carriage return.
const small = mkdtempSync(join(tmpdir(), 'delta-batch-git-small-'));
after(() => rmSync(small, { recursive: true, force: true }));
gitIn(small, 'init', '--quiet', '--initial-branch=main');
const signer = join(small, '.git', 'stand-in-signer');
writeFileSync(signer, [
  '#!/bin/sh',
  'case " $* " in *" --verify "*) echo "[GNUPG:] GOODSIG 0 stand-in"; echo "gpg: Good signature from stand-in" >&2; exit 0;; esac',
  'cat > /dev/null',
  'echo "[GNUPG:] SIG_CREATED D 1 8 00 0 stand-in" >&2',
  'printf -- "-----BEGIN PGP SIGNATURE-----\\n\\nc3RhbmQtaW4=\\n-----END PGP SIGNATURE-----\\n"',
  '',
].join('\n'), { mode: 0o755 });
gitIn(small, 'config', 'gpg.program', signer);
gitIn(small, 'config', 'log.showSignature', 'true');
writeFileSync(join(small, 'a'), 'a1\n'); writeFileSync(join(small, 'b\r'), 'b1\n');
gitIn(small, 'add', '--all'); gitIn(small, 'commit', '--quiet', '-m', 'first');
const smallBase = gitIn(small, 'rev-parse', 'HEAD');
writeFileSync(join(small, 'a'), 'a2\n');
gitIn(small, 'commit', '--quiet', '-a', '-S', '-m', 'second');
writeFileSync(join(small, 'b\r'), 'b2\n');
gitIn(small, 'commit', '--quiet', '-a', '-S', '-m', 'third');

test('readHistory gives the per-commit answer when the Git config prints signatures in git log', () => {
  const printed = gitIn(small, 'log', '--no-renames', '--name-only', '--format=%x00%H %P', `${smallBase}..HEAD`);
  assert.match(printed, /Good signature/, 'with this config a plain git log prints signature lines');
  const signed = readHistory(small, smallBase);
  assert.deepEqual([...signed.keys()].sort(), lines(gitIn(small, 'rev-list', `${smallBase}..HEAD`)).sort());
  for (const [sha, entry] of signed) assert.deepEqual(entry.files, lines(gitIn(small, 'diff', '--no-renames', '--name-only', `${sha}^`, sha)), sha);
});

test('blobIds returns what git rev-parse --verify returns for paths that end in a carriage return', () => {
  const specs = ['HEAD:a', 'HEAD:a\r', 'HEAD:b', 'HEAD:b\r', `${smallBase}:b\r`, 'HEAD:a\r\n', 'HEAD:b\r\n'];
  const expected = new Map(specs.map(spec => { try { return [spec, gitIn(small, 'rev-parse', '--verify', spec)]; } catch { return [spec, null]; } }));
  assert.deepEqual(blobIds(specs, small), expected);
  assert.deepEqual([...expected.values()].map(id => id === null), [false, true, true, false, false, true, true]);
});

test('commitsIn returns the commits git merge-base --is-ancestor accepts below the head', () => {
  const isAncestor = sha => { try { git('merge-base', '--is-ancestor', sha, renamed); return true; } catch { return false; } };
  const published = commitsIn(`${base}..${renamed}`, repo);
  for (const sha of history.keys()) assert.equal(published.has(sha), isAncestor(sha), sha);
  assert.throws(() => commitsIn(`${base}..${'0'.repeat(40)}`, repo));
});

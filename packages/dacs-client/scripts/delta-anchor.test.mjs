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

test('unrecorded and staged changes to anchored files, a record that does not start from the anchor and a record of a commit the anchor contains are refused', t => {
  const s = scratch(t);
  appendFileSync(join(s.repo, README), '\nTEST unrecorded line\n');
  s.git('add', '--', README); s.git('commit', '-qm', 'docs(client): TEST unrecorded README change');
  const unrecorded = s.git('rev-parse', 'HEAD');
  const recorded = recordAnchoredFile(s, 'delta(client): WF TEST README record after an unrecorded change', README, s.git('rev-parse', `HEAD:${README}`));
  const bytes = readFileSync(join(s.repo, README));
  appendFileSync(join(s.repo, README), '\nTEST staged line\n'); s.git('add', '--', README); writeFileSync(join(s.repo, README), bytes);
  // A record of a README commit the anchor already contains.
  const old = s.git('log', '--no-merges', '--format=%H', '-n', '1', readAnchor(join(s.repo, P)).commit, '--', README);
  const early = { schema: 'dacs-client-delta-record/v1', delta: 'WF', subject: s.git('log', '-1', '--format=%s', old), sha: old, kind: 'change',
    files: [{ path: README, before: s.git('rev-parse', `${old}^:${README}`), after: s.git('rev-parse', `${old}:${README}`) }], commitFiles: [README] };
  writeFileSync(join(s.repo, P, 'records', recordName(early)), JSON.stringify(early, null, 2) + '\n');
  // An anchored script that no record names.
  appendFileSync(join(s.repo, P, 'scripts/generate-payload-helpers.mjs'), '\n// TEST unrecorded edit\n');
  const result = s.check();
  assert.equal(result.status, 1, result.text);
  for (const failure of [
    `${README}: unenumerated change in ${unrecorded}`,
    `${README}: delta parent is discontinuous at ${recorded}`,
    `${README}: index differs from HEAD for a record-named file`,
    `${README}: current blob differs from enumerated deltas`,
    `${README}: delta WF selects ${old}, which the anchor already contains`,
    `${P}scripts/generate-payload-helpers.mjs: current blob differs from enumerated deltas`,
  ]) assert.ok(result.failures.includes(failure), `${failure}\n${result.text}`);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isCorePath, isUnrecordedRepositoryPath, recordName } from './delta-record.mjs';
import { commits, expectedBlob, git, ledger, selects } from './delta-map.mjs';

// The gate reads superseded and active records together and skips selectors
// that do not resolve once (it reports those separately). It reads no README
// entry: the README needs no record.
function recordedPaths() {
  const history = commits(), data = ledger(), records = new Map();
  for (const change of [...(data.supersededChanges ?? []), ...data.changes]) {
    const matches = history.filter(commit => selects(change, commit));
    if (matches.length !== 1) continue;
    for (const file of change.files) {
      const rel = file.path.slice('packages/dacs-client/'.length);
      if (isCorePath(rel) || isUnrecordedRepositoryPath(file.path)) continue;
      records.set(file.path, [...(records.get(file.path) ?? []), { sha: matches[0].sha, after: file.after }]);
    }
  }
  return records;
}
test('every recorded path has an agreed newest blob matching HEAD', () => {
  const head = new Map(git('ls-tree', '-r', 'HEAD').split('\n').map(row => {
    const [meta, path] = row.split('\t'); return [path, meta.split(' ')[2]];
  }));
  const failures = [];
  for (const [path, entries] of recordedPaths()) {
    const expected = expectedBlob(entries, shas => git('merge-base', '--independent', ...shas).split('\n'));
    if (expected.conflict || expected.blob !== (head.get(path) ?? null)) failures.push({ path, expected, head: head.get(path) ?? null });
  }
  assert.deepEqual(failures, []);
});

// A small commit graph: each commit names its parents. Returns the
// `git merge-base --independent` view of it.
function graph(parents) {
  const ancestors = sha => {
    const seen = new Set(), stack = [...(parents[sha] ?? [])];
    while (stack.length) { const next = stack.pop(); if (!seen.has(next)) { seen.add(next); stack.push(...(parents[next] ?? [])); } }
    return seen;
  };
  return shas => shas.filter(sha => !shas.some(other => other !== sha && ancestors(other).has(sha)));
}
const sorted = result => result.conflict ? { conflict: [...result.conflict].sort() } : result;

// c1 records a; the fix c2 records b; s forks from c1 and never touches the path.
const staleSide = graph({ c2: ['c1'], s: ['c1'], m: ['c2', 's'] });
test('a merge that keeps a stale parent blob or deletes the file does not hold the expected blob', () => {
  const expected = expectedBlob([{ sha: 'c1', after: 'a' }, { sha: 'c2', after: 'b' }], staleSide);
  assert.deepEqual(expected, { blob: 'b' });
  for (const head of ['a', null]) assert.notEqual(expected.blob, head);
});
test('the ledger order of records does not choose the expected blob', () => {
  assert.deepEqual(expectedBlob([{ sha: 'c2', after: 'b' }, { sha: 'c1', after: 'a' }], staleSide), { blob: 'b' });
});
test('a fix recorded beside a parallel record cannot be rolled back by the merge alone', () => {
  const parallel = graph({ c2: ['c1'], c3: ['c1'], m: ['c2', 'c3'] });
  const records = [{ sha: 'c1', after: 'a' }, { sha: 'c2', after: 'b' }, { sha: 'c3', after: 'c' }];
  assert.deepEqual(sorted(expectedBlob(records, parallel)), { conflict: ['c2', 'c3'] });
});
test('a merge cannot restore an older reviewed blob that neither parent holds', () => {
  const linear = graph({ c2: ['c1'], c3: ['c2'], s: ['c3'], m: ['c3', 's'] });
  const expected = expectedBlob([{ sha: 'c1', after: 'a' }, { sha: 'c2', after: 'b' }, { sha: 'c3', after: 'c' }], linear);
  assert.deepEqual(expected, { blob: 'c' });
  assert.notEqual(expected.blob, 'b');
});
test('an older sibling blob coming back through a later merge is not the expected blob', () => {
  // c4 chose b after merging the siblings c2 and c3; r continues from c3.
  const later = graph({ c2: ['c1'], c3: ['c1'], m1: ['c2', 'c3'], c4: ['m1'], r: ['c3'], m2: ['c4', 'r'] });
  const records = [{ sha: 'c1', after: 'a' }, { sha: 'c2', after: 'b' }, { sha: 'c3', after: 'c' }, { sha: 'c4', after: 'b' }];
  assert.deepEqual(expectedBlob(records, later), { blob: 'b' });
});
test('parallel records of the same blob agree', () => {
  const parallel = graph({ c2: ['c1'], c3: ['c1'] });
  assert.deepEqual(expectedBlob([{ sha: 'c2', after: 'b' }, { sha: 'c3', after: 'b' }], parallel), { blob: 'b' });
});
test('parallel records of different blobs conflict until a later record chooses one', () => {
  const chosen = graph({ c2: ['c1'], c3: ['c1'], m: ['c2', 'c3'], c4: ['m'] });
  const records = [{ sha: 'c2', after: 'b' }, { sha: 'c3', after: 'c' }];
  assert.deepEqual(sorted(expectedBlob(records, chosen)), { conflict: ['c2', 'c3'] });
  assert.deepEqual(expectedBlob([...records, { sha: 'c4', after: 'c' }], chosen), { blob: 'c' });
});
for (const after of ['b', null]) test(`a parallel deletion requires a descendant choice of ${after}`, () => {
  const chosen = graph({ x: ['c1'], y: ['c1'], m: ['x', 'y'], c2: ['m'] });
  const records = [{ sha: 'x', after: 'b' }, { sha: 'y', after: null }];
  assert.deepEqual(sorted(expectedBlob(records, chosen)), { conflict: ['x', 'y'] });
  assert.deepEqual(expectedBlob([...records, { sha: 'c2', after }], chosen), { blob: after });
});
test('a three-parent merge needs a later record only when its parents recorded different blobs', () => {
  const octopus = graph({ x: ['c1'], y: ['c1'], z: ['c1'], o: ['x', 'y', 'z'], c5: ['o'] });
  const records = [{ sha: 'x', after: 'b' }, { sha: 'y', after: 'c' }, { sha: 'z', after: 'd' }];
  assert.deepEqual(sorted(expectedBlob(records, octopus)), { conflict: ['x', 'y', 'z'] });
  assert.deepEqual(expectedBlob([...records, { sha: 'c5', after: 'd' }], octopus), { blob: 'd' });
  assert.deepEqual(expectedBlob([{ sha: 'c1', after: 'a' }, { sha: 'x', after: 'b' }], octopus), { blob: 'b' });
});
test('within one commit the last record of a path counts', () => {
  assert.deepEqual(expectedBlob([{ sha: 'c1', after: 'a' }, { sha: 'c1', after: 'b' }], graph({})), { blob: 'b' });
});

// Clone tests build their own commits on top of this checkout's HEAD and
// assert only the failures each scenario adds to the clone's starting state;
// the real tree's own result is asserted by delta-provenance.test.mjs.
const root = fileURLToPath(new URL('../../..', import.meta.url));
const prefix = 'packages/dacs-client/';
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'TEST-delta-frontier-'));
  execFileSync('git', ['clone', '--quiet', '--shared', root, dir]); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=SDK tests', '-c', 'user.email=tests@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  const node = (...args) => execFileSync(process.execPath, args, { cwd: dir, stdio: 'pipe' });
  const check = () => {
    const result = spawnSync(process.execPath, [prefix + 'scripts/check-provenance.mjs', '--local-only'], { cwd: dir, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, failures: [...(result.stdout + result.stderr).matchAll(/^FAIL (.*)$/gm)].map(match => match[1]), text: result.stdout + result.stderr };
  };
  const base = new Set(check().failures);
  const added = result => result.failures.filter(failure => !base.has(failure)).sort();
  // Any moved source the starting state does not already flag.
  const source = JSON.parse(readFileSync(join(dir, prefix + 'PROVENANCE.json'), 'utf8')).files.map(file => file.path)
    .find(path => path.startsWith(prefix + 'src/') && existsSync(join(dir, path)) && ![...base].some(failure => failure.startsWith(`${path}:`)));
  assert.ok(source, 'a moved source file must exist');
  return { dir, git, node, check, added, source };
}
// Commit a newly written record together with the staged source edit.
function commitRecord(s, subject) {
  const name = prefix + 'records/' + recordName({ delta: 'D11', subject });
  s.git('add', '--', name); s.git('commit', '--quiet', '-m', subject);
  return s.git('rev-parse', 'HEAD');
}
function recordEdit(s, path, bytes, subject) {
  writeFileSync(join(s.dir, path), bytes); s.git('add', '--', path);
  s.node(prefix + 'scripts/delta-map.mjs', '--record', 'D11', subject);
  return commitRecord(s, subject);
}
// A resolution record explicitly chooses HEAD's blob on both sides.
function recordChoice(s, path, subject) {
  const chosen = s.git('rev-parse', `HEAD:${path}`), name = prefix + 'records/' + recordName({ delta: 'D11', subject });
  writeFileSync(join(s.dir, name), JSON.stringify({ schema: 'dacs-client-delta-record/v1', delta: 'D11', subject, kind: 'resolution', files: [{ path, before: chosen, after: chosen }], commitFiles: [name] }) + '\n');
  return commitRecord(s, subject);
}
// Carry the right branch's independent record while deliberately keeping the left source.
function parallelRecords(s) {
  const path = s.source, start = s.git('rev-parse', 'HEAD'), bytes = readFileSync(join(s.dir, path));
  s.git('switch', '--quiet', '-c', 'TEST-right', start);
  const right = recordEdit(s, path, Buffer.concat([bytes, Buffer.from('\n// TEST right\n')]), 'fix(client): D11 TEST right edit');
  s.git('switch', '--quiet', '-c', 'TEST-left', start);
  const left = recordEdit(s, path, Buffer.concat([bytes, Buffer.from('\n// TEST left\n')]), 'fix(client): D11 TEST left edit');
  s.git('merge', '--quiet', '--no-ff', '--no-commit', '-s', 'ours', 'TEST-right');
  const name = prefix + 'records/' + recordName({ delta: 'D11', subject: 'fix(client): D11 TEST right edit' });
  s.git('checkout', right, '--', name);
  s.git('commit', '--quiet', '-m', 'merge: TEST parallel records');
  return { path, left, right };
}
function assertDisagree(failures, path, shas) {
  assert.equal(failures.length, 1, failures.join('\n'));
  const match = new RegExp(`^${path.replace(/[.]/g, '\\.')}: newest records disagree \\(([0-9a-f]{40}), ([0-9a-f]{40})\\); record the chosen blob after the merge$`).exec(failures[0]);
  assert.ok(match, failures[0]);
  assert.deepEqual([match[1], match[2]].sort(), [...shas].sort());
}

test('a merge alone cannot keep the stale parent of a recorded fix or delete the file', t => {
  const s = scratch(t), moved = s.source;
  const start = s.git('rev-parse', 'HEAD'), stale = readFileSync(join(s.dir, moved));
  s.git('switch', '--quiet', '-c', 'TEST-stale', start);
  writeFileSync(join(s.dir, 'TEST-note.txt'), 'outside the client\n'); s.git('add', '--', 'TEST-note.txt'); s.git('commit', '--quiet', '-m', 'TEST note');
  s.git('switch', '--quiet', '-c', 'TEST-fix', start);
  recordEdit(s, moved, Buffer.concat([stale, Buffer.from('\n// TEST fix B\n')]), 'fix(client): D11 TEST fix B');
  s.git('switch', '--quiet', '-c', 'TEST-clean', 'TEST-fix');
  s.git('merge', '--quiet', '--no-ff', '-m', 'merge: TEST clean merge', 'TEST-stale');
  assert.deepEqual(s.added(s.check()), []);
  s.git('switch', '--quiet', '-c', 'TEST-rollback', 'TEST-fix');
  s.git('merge', '--quiet', '--no-ff', '--no-commit', 'TEST-stale');
  writeFileSync(join(s.dir, moved), stale);
  s.git('add', '--', moved); s.git('commit', '--quiet', '-m', 'merge: TEST keep the stale parent');
  assert.deepEqual(s.added(s.check()), [`${moved}: current blob differs from enumerated deltas`]);
  s.git('switch', '--quiet', '-c', 'TEST-delete', 'TEST-fix');
  s.git('merge', '--quiet', '--no-ff', '--no-commit', 'TEST-stale');
  s.git('rm', '--quiet', '--', moved);
 s.git('commit', '--quiet', '-m', 'merge: TEST delete the recorded file');
  assert.deepEqual(s.added(s.check()), [`${moved}: current blob differs from enumerated deltas`]);
});

test('parallel records that disagree are refused for every reader until a later record chooses', async t => {
  const s = scratch(t), { path, left, right } = parallelRecords(s);
  const first = s.check();
  assertDisagree(s.added(first), path, [left, right]);
  const run = () => promisify(execFile)(process.execPath, [prefix + 'scripts/check-provenance.mjs', '--local-only'], { cwd: s.dir })
    .then(() => assert.fail('a missing choice must be refused'), error => {
      assert.equal(error.code, 1);
      assert.deepEqual([...error.stderr.matchAll(/^FAIL (.*)$/gm)].map(match => match[1]), first.failures);
    });
  await Promise.all([run(), run()]);
  assert.deepEqual(s.check().failures, first.failures);
  recordChoice(s, path, 'fix(client): D11 TEST choose the left blob');
  assert.deepEqual(s.added(s.check()), []);
  recordEdit(s, path, Buffer.concat([readFileSync(join(s.dir, path)), Buffer.from('\n// TEST later revision\n')]), 'fix(client): D11 TEST later revision');
  assert.deepEqual(s.added(s.check()), []);
});

test('after a choice, working, deleted and staged edits are refused', t => {
  const s = scratch(t), { path } = parallelRecords(s);
  recordChoice(s, path, 'fix(client): D11 TEST choose the left blob');
  assert.deepEqual(s.added(s.check()), []);
  const bytes = readFileSync(join(s.dir, path));
  writeFileSync(join(s.dir, path), Buffer.concat([bytes, Buffer.from('\n// TEST unrecorded edit\n')]));
 
  assert.deepEqual(s.added(s.check()), [`${path}: current blob differs from enumerated deltas`]);
  unlinkSync(join(s.dir, path));
  assert.deepEqual(s.added(s.check()), [`${path}: current blob differs from enumerated deltas`]);
  writeFileSync(join(s.dir, path), Buffer.concat([bytes, Buffer.from('\n// TEST staged edit\n')]));
  s.git('add', '--', path); writeFileSync(join(s.dir, path), bytes);
  assert.deepEqual(s.added(s.check()), [`${path}: current blob differs from enumerated deltas`, `${path}: index differs from HEAD for moved source/test`]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { commits, expectedBlob, git, ledger } from './delta-map.mjs';

test('every recorded path has an agreed newest blob matching HEAD after the final carry merge', () => {
  const history = commits(), records = new Map();
  for (const change of ledger().changes) {
    const matches = history.filter(commit => commit.subject === change.subject);
    assert.equal(matches.length, 1, change.subject);
    for (const file of change.files) {
      records.set(file.path, [...(records.get(file.path) ?? []), { sha: matches[0].sha, after: file.after }]);
    }
  }
  const head = new Map(git('ls-tree', '-r', 'HEAD').split('\n').map(row => {
    const [meta, path] = row.split('\t'); return [path, meta.split(' ')[2]];
  }));
  const failures = [];
  for (const [path, entries] of records) {
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

const root = fileURLToPath(new URL('../../..', import.meta.url));
const prefix = 'packages/dacs-client/';
// Both choice records exist here, before later records can supersede them.
const HISTORICAL_CHOICES = '46b627ce0022edea1bff2bebc418a63b7b33a8e1';
function scratch(t, fixtureRef, sourceRoot = root) {
  const dir = mkdtempSync(join(tmpdir(), 'TEST-delta-frontier-'));
  execFileSync('git', ['clone', '--quiet', '--shared', sourceRoot, dir]); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=SDK tests', '-c', 'user.email=tests@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  if (fixtureRef) git('switch', '--quiet', '--detach', fixtureRef);
  // Exercise historical conflict resolution with this checkout's current rule,
  // copying it after checkout so the fixture cannot restore an older checker.
  copyFileSync(join(root, prefix + 'scripts/delta-map.mjs'), join(dir, prefix + 'scripts/delta-map.mjs'));
  const node = (...args) => execFileSync(process.execPath, args, { cwd: dir, stdio: 'pipe' });
  const check = () => {
    const result = spawnSync(process.execPath, [prefix + 'scripts/check-provenance.mjs', '--local-only'], { cwd: dir, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, failures: [...(result.stdout + result.stderr).matchAll(/^FAIL (.*)$/gm)].map(match => match[1]), text: result.stdout + result.stderr };
  };
  return { dir, git, node, check };
}
test('a recorded fix cannot be dropped by a merge that keeps the stale parent', t => {
  const { dir, git, node, check } = scratch(t), moved = prefix + 'src/dacs/buyer-chain-readback.mjs';
  const start = git('rev-parse', 'HEAD'), stale = readFileSync(join(dir, moved));
  git('switch', '--quiet', '-c', 'TEST-stale', start);
  writeFileSync(join(dir, 'TEST-note.txt'), 'outside the client\n'); git('add', '--', 'TEST-note.txt'); git('commit', '--quiet', '-m', 'TEST note');
  git('switch', '--quiet', '-c', 'TEST-fix', start);
  writeFileSync(join(dir, moved), Buffer.concat([stale, Buffer.from('\n// TEST fix B\n')])); git('add', '--', moved);
  const subject = 'fix(client): D11 TEST fix B';
  node(prefix + 'scripts/delta-map.mjs', '--record', 'D11', subject);
  const files = [moved, ...['DELTA-COMMITS.json', 'DELTA-LEDGER.json', 'DELTA-MAP.md'].map(name => prefix + name)];
  if (git('diff', '--name-only', 'HEAD', '--', prefix + 'scripts/delta-map.mjs')) files.push(prefix + 'scripts/delta-map.mjs');
  const inventory = JSON.parse(readFileSync(join(dir, prefix + 'DELTA-COMMITS.json'), 'utf8'));
  inventory.push({ sha: null, subject, files: files.sort() }); writeFileSync(join(dir, prefix + 'DELTA-COMMITS.json'), JSON.stringify(inventory, null, 2) + '\n');
  node(prefix + 'scripts/delta-map.mjs'); git('add', '--', ...files); git('commit', '--quiet', '-m', subject);
  git('switch', '--quiet', '-c', 'TEST-clean', 'TEST-fix');
  git('merge', '--quiet', '--no-ff', '-m', 'merge: TEST clean merge', 'TEST-stale');
  let result = check(); assert.equal(result.status, 0, result.text);
  git('switch', '--quiet', '-c', 'TEST-rollback', 'TEST-fix');
  git('merge', '--quiet', '--no-ff', '--no-commit', 'TEST-stale');
  writeFileSync(join(dir, moved), stale); node(prefix + 'scripts/delta-map.mjs');
  git('add', '--', moved, prefix + 'DELTA-MAP.md'); git('commit', '--quiet', '-m', 'merge: TEST keep the stale parent');
  result = check(); assert.deepEqual(result.failures, [`${moved}: current blob differs from enumerated deltas`], result.text);
});
test('parallel records that disagree are refused until a later record chooses, then edits are refused', t => {
  const { dir, git, node, check } = scratch(t, HISTORICAL_CHOICES), ledger = join(dir, prefix + 'DELTA-LEDGER.json');
  const data = JSON.parse(readFileSync(ledger, 'utf8'));
  const index = data.changes.findIndex(change => change.subject === 'fix(client): D11 record the chosen blobs of three parallel-record paths');
  assert.ok(index >= 0, 'the identity record for the parallel-record paths must exist');
  const [chosen] = data.changes.splice(index, 1);
  writeFileSync(ledger, JSON.stringify(data)); node(prefix + 'scripts/delta-map.mjs');
  let result = check();
  assert.deepEqual(result.failures.map(failure => failure.split(':')[0]).sort(), chosen.files.map(file => file.path).sort(), result.text);
  for (const failure of result.failures) assert.match(failure, /newest records disagree \([0-9a-f]{40}(, [0-9a-f]{40})+\); record the chosen blob after the merge$/);
  git('checkout', '--', prefix + 'DELTA-LEDGER.json', prefix + 'DELTA-MAP.md');
  result = check(); assert.equal(result.status, 0, result.text);
  const path = chosen.files[0].path, bytes = readFileSync(join(dir, path));
  writeFileSync(join(dir, path), Buffer.concat([bytes, Buffer.from('\n// TEST unrecorded\n')]));
  result = check(); assert.ok(result.failures.includes(`${path}: current blob differs from enumerated deltas`), result.text);
  git('add', '--', path); writeFileSync(join(dir, path), bytes);
  result = check(); assert.ok(result.failures.includes(`${path}: current blob differs from enumerated deltas`), result.text);
  assert.ok(result.failures.includes(`${path}: index differs from HEAD for moved source/test`), result.text);
});

test('the final wallet identity closes only its conflict and retains working and index checks', t => {
  const { dir, git, node, check } = scratch(t, HISTORICAL_CHOICES), path = prefix + 'src/wallet/devnet-native-transport.mjs';
  let result = check(); assert.equal(result.status, 0, result.text);
  const ledgerPath = join(dir, prefix + 'DELTA-LEDGER.json'), data = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  const index = data.changes.findIndex(change => change.subject === 'fix(client): D11 record the final merged wallet blob');
  assert.ok(index >= 0, 'the final carry merge must have a wallet identity record');
  const [chosen] = data.changes.splice(index, 1), head = git('rev-parse', `HEAD:${path}`);
  assert.deepEqual(chosen.files, [{ path, before: head, after: head }]);
  writeFileSync(ledgerPath, JSON.stringify(data)); node(prefix + 'scripts/delta-map.mjs');
  result = check();
  assert.equal(result.status, 1, result.text);
  assert.equal(result.failures.length, 1, result.text);
  assert.ok(result.failures[0].startsWith(`${path}: newest records disagree (`), result.text);
  git('checkout', '--', prefix + 'DELTA-LEDGER.json', prefix + 'DELTA-MAP.md');
  result = check(); assert.equal(result.status, 0, result.text);
  const bytes = readFileSync(join(dir, path));
  writeFileSync(join(dir, path), Buffer.concat([bytes, Buffer.from('\n// TEST unrecorded wallet edit\n')]));
  node(prefix + 'scripts/delta-map.mjs');
  result = check(); assert.deepEqual(result.failures, [`${path}: current blob differs from enumerated deltas`], result.text);
  unlinkSync(join(dir, path));
  node(prefix + 'scripts/delta-map.mjs');
  result = check(); assert.deepEqual(result.failures, [`${path}: current blob differs from enumerated deltas`], result.text);
  writeFileSync(join(dir, path), Buffer.concat([bytes, Buffer.from('\n// TEST staged wallet edit\n')]));
  git('add', '--', path); writeFileSync(join(dir, path), bytes);
  node(prefix + 'scripts/delta-map.mjs');
  result = check();
  assert.deepEqual(result.failures, [`${path}: index differs from HEAD for moved source/test`, `${path}: current blob differs from enumerated deltas`], result.text);
});

test('fresh and concurrent readers agree on the completed carry graph', async t => {
  const { dir, check } = scratch(t), first = check();
  assert.equal(first.status, 0, first.text);
  const run = () => promisify(execFile)(process.execPath, [prefix + 'scripts/check-provenance.mjs', '--local-only'], { cwd: dir });
  const results = await Promise.all([run(), run()]);
  for (const result of results) assert.equal(result.stdout, first.stdout);
  const restarted = check(); assert.equal(restarted.status, 0, restarted.text);
  assert.equal(restarted.stdout, first.stdout);
});

for (const [label, ref] of [
  ['no later selector', HISTORICAL_CHOICES],
  ['one later selector', 'fa32114109033b04e25449668969ec1a17a9966a'],
  ['multiple later selectors', 'HEAD'],
  ['a later recorded wallet revision', 'HEAD'],
]) test(`historical choices stay fixed with ${label} in the caller`, t => {
  const caller = scratch(t, ref);
  if (label === 'a later recorded wallet revision') {
    const path = prefix + 'src/wallet/devnet-native-transport.mjs';
    const subject = 'fix(client): D11 TEST later wallet revision';
    writeFileSync(join(caller.dir, path), Buffer.concat([readFileSync(join(caller.dir, path)), Buffer.from('\n// TEST later wallet revision\n')]));
    caller.git('add', '--', path);
    caller.node(prefix + 'scripts/delta-map.mjs', '--record', 'D11', subject);
    const files = [path, ...['DELTA-COMMITS.json', 'DELTA-LEDGER.json', 'DELTA-MAP.md'].map(name => prefix + name)];
    if (caller.git('diff', '--name-only', 'HEAD', '--', prefix + 'scripts/delta-map.mjs')) files.push(prefix + 'scripts/delta-map.mjs');
    const inventoryPath = join(caller.dir, prefix + 'DELTA-COMMITS.json'), inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
    inventory.push({ sha: null, subject, files: files.sort() });
    writeFileSync(inventoryPath, JSON.stringify(inventory, null, 2) + '\n');
    caller.node(prefix + 'scripts/delta-map.mjs');
    caller.git('add', '--', ...files); caller.git('commit', '--quiet', '-m', subject);
    const result = caller.check(); assert.equal(result.status, 0, result.text);
  }
  const fixture = scratch(t, HISTORICAL_CHOICES, caller.dir);
  assert.equal(fixture.git('rev-parse', 'HEAD'), HISTORICAL_CHOICES);
  const ledgerPath = join(fixture.dir, prefix + 'DELTA-LEDGER.json'), data = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  const index = data.changes.findIndex(change => change.subject === 'fix(client): D11 record the final merged wallet blob');
  assert.ok(index >= 0);
  const [chosen] = data.changes.splice(index, 1);
  writeFileSync(ledgerPath, JSON.stringify(data)); fixture.node(prefix + 'scripts/delta-map.mjs');
  const result = fixture.check();
  assert.equal(result.status, 1, result.text);
  assert.equal(result.failures.length, 1, result.text);
  assert.ok(result.failures[0].startsWith(`${chosen.files[0].path}: newest records disagree (`), result.text);
});

test('fresh, concurrent and restarted readers retain the historical missing-choice conflict', async t => {
  const { dir, node, check } = scratch(t, HISTORICAL_CHOICES);
  const ledgerPath = join(dir, prefix + 'DELTA-LEDGER.json'), data = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  const index = data.changes.findIndex(change => change.subject === 'fix(client): D11 record the final merged wallet blob');
  assert.ok(index >= 0);
  const [chosen] = data.changes.splice(index, 1);
  writeFileSync(ledgerPath, JSON.stringify(data)); node(prefix + 'scripts/delta-map.mjs');
  const first = check();
  assert.equal(first.status, 1, first.text);
  assert.equal(first.failures.length, 1, first.text);
  assert.ok(first.failures[0].startsWith(`${chosen.files[0].path}: newest records disagree (`), first.text);
  const run = () => promisify(execFile)(process.execPath, [prefix + 'scripts/check-provenance.mjs', '--local-only'], { cwd: dir })
    .then(() => assert.fail('missing historical choice must be refused'), error => {
      assert.equal(error.code, 1);
      assert.deepEqual([...error.stderr.matchAll(/^FAIL (.*)$/gm)].map(match => match[1]), first.failures);
    });
  await Promise.all([run(), run()]);
  const restarted = check(); assert.equal(restarted.status, 1, restarted.text);
  assert.deepEqual(restarted.failures, first.failures);
});

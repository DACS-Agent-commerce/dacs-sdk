// The wallet's dispatch history read under its own lane lock: the checked
// callback, the installed reader and classifier, and the native wallet lane key.
// The real durable journal runs on temporary files; packed cases install the
// archive offline in an empty directory. No network, chain or funds.
import { nativeWorld, PINS, IDENTITY as WORLD_IDENTITY } from './helpers/native-effect-world.mjs'; // first: it installs the purchase-admission hook
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { OperationError } from '../src/client-errors.mjs';
import { openDurableWalletJournal, walletLane, walletLaneKey } from '../src/wallet/durable-journal.mjs';
import { createEffectHistory, withCheckedOperationHistory, nativeWalletLaneKey } from '../src/wallet/effect-history.mjs';
import { bindFixture } from './fixtures/tp1-authority-reader.mjs';
import { installPackedPair, packageDir } from './helpers/packed-install.mjs';

const IDENTITY = 'c'.repeat(64), ADDRESS = '0x' + 'b'.repeat(64), OTHER_ADDRESS = '0x' + 'd'.repeat(64);
const LANE = nativeWalletLaneKey({ network: 'testnet', chainIdentity: IDENTITY }, ADDRESS);
const OTHER_LANE = nativeWalletLaneKey({ network: 'testnet', chainIdentity: IDENTITY }, OTHER_ADDRESS);
const ARTIFACT_A = 'a'.repeat(64), ARTIFACT_B = 'e'.repeat(64), ARTIFACT_C = 'f'.repeat(64);
const OPERATION = 'TEST-operation', OTHER_OPERATION = 'TEST-other-operation';
const lanePrefix = (lane) => `eb/${encodeURIComponent(lane)}/`;
const historyKey = ({ lane, artifactHash, passId, state }) => `${lanePrefix(lane)}${artifactHash}/${encodeURIComponent(passId)}/${encodeURIComponent(state)}`;
const record = (artifactHash, passId, state, operationId = OPERATION, lane = LANE) => ({ lane, artifactHash, passId, state, operationId });
const unavailable = (causeCode) => (error) => error instanceof OperationError && error.code === 'eb_history_unavailable' && (causeCode === undefined || error.cause?.code === causeCode);
const typeError = (message) => (error) => error instanceof TypeError && error.message === message;
const notRun = () => assert.fail('work must not run');
const returnRecords = ({ records }) => records;

// A fresh durable journal on a temporary file; `reopen(options)` opens another handle on the same file. All close after the test.
function journalFile(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'checked-history-'));
  const path = join(directory, 'journal.sqlite');
  const handles = [openDurableWalletJournal({ path, mode: 'create', ...options })];
  t.after(() => { for (const handle of handles) handle.close(); rmSync(directory, { recursive: true, force: true }); });
  const reopen = (extra = {}) => { const handle = openDurableWalletJournal({ path, mode: 'open', ...extra }); handles.push(handle); return handle; };
  // A second SQLite connection, as a process outside the journal would change the file.
  const raw = (sql, ...parameters) => { const db = new DatabaseSync(path); try { return db.prepare(sql).run(...parameters); } finally { db.close(); } };
  return { journal: handles[0], path, reopen, raw };
}

let packed;
const cleanups = [];
test.before(() => { packed = installPackedPair({ after: (cleanup) => cleanups.push(cleanup) }); });
test.after(() => { for (const cleanup of cleanups) cleanup(); });
// Runs `source` as a module in the packed app with `args` and returns its JSON output.
function packedChild(name, source, args = []) {
  writeFileSync(join(packed.app, name), source);
  return JSON.parse(packed.run(process.execPath, [name, ...args], packed.app));
}

test('the installed history entry exports the reader, the checked callback, the same classifier and the lane key but no writer', () => {
  const answer = packedChild('members.mjs', `
    const entry = await import('@kynesyslabs/dacs-client/wallet/effect-history');
    const root = await import('@kynesyslabs/dacs-client');
    const internal = await import(new URL('./node_modules/@kynesyslabs/dacs-client/src/wallet/native-dispatch-history.mjs', import.meta.url));
    const reader = entry.createEffectHistoryReader({});
    const forbidden = ['createEffectHistory', 'append', 'isLocalPurchaseAccount', 'registeredJournal', 'registerDurableJournal'];
    console.log(JSON.stringify({ entry: Object.keys(entry).sort(), reader: Object.keys(reader).sort(), readerFrozen: Object.isFrozen(reader),
      root: ['verifyDealPassive', 'withCheckedOperationHistory'].map((name) => typeof root[name]),
      sameHelper: root.withCheckedOperationHistory === entry.withCheckedOperationHistory, sameClassifier: internal.classifyDispatchHistory === entry.classifyDispatchHistory,
      leaked: forbidden.filter((name) => name in entry || name in root) }));
  `);
  assert.deepEqual(answer, { entry: ['classifyDispatchHistory', 'createEffectHistoryReader', 'isNativeWalletLaneKey', 'nativeWalletLaneKey', 'withCheckedOperationHistory'],
    reader: ['read', 'readOperation'], readerFrozen: true, root: ['function', 'function'], sameHelper: true, sameClassifier: true, leaked: [] });
});

test('the installed reader reads a real record through read and readOperation', async (t) => {
  const w = nativeWorld(t, { bound: await bindFixture() });
  w.open({});
  const { tx } = await w.send(1);
  const expected = await w.records(tx);
  assert.ok(expected.length > 0);
  const artifactHash = expected[0].artifactHash, lane = nativeWalletLaneKey(PINS, w.address);
  const answer = packedChild('reader.mjs', `
    import { openDurableWalletJournal } from '@kynesyslabs/dacs-client/wallet/durable-journal';
    import { createEffectHistoryReader } from '@kynesyslabs/dacs-client/wallet/effect-history';
    const [path, lane, artifactHash, operationId] = process.argv.slice(2);
    const journal = openDurableWalletJournal({ path, mode: 'open' });
    const reader = createEffectHistoryReader(journal);
    const answer = { read: await reader.read({ lane, artifactHash }), readOperation: await reader.readOperation({ lane, operationId }) };
    journal.close();
    console.log(JSON.stringify(answer));
  `, [w.journal().path, lane, artifactHash, expected[0].operationId]);
  assert.deepEqual(answer.read, expected);
  assert.deepEqual(answer.readOperation, expected);
});

test('the checked callback sees every artifact and pass of one operation in commit order and acquires the lane once', async (t) => {
  const { journal } = journalFile(t);
  const history = createEffectHistory({ journal });
  const written = [record(ARTIFACT_A, 'p1', 'signed'), record(ARTIFACT_A, 'p1', 'dispatch-started'), record(ARTIFACT_B, 'p1', 'signed', OTHER_OPERATION),
    record(ARTIFACT_C, 'p2', 'signed'), record(ARTIFACT_A, 'p2', 'dispatch-withheld'), record(ARTIFACT_C, 'p2', 'dispatch-started')];
  for (const entry of written) await history.append(entry);
  await history.append(record(ARTIFACT_B, 'p1', 'signed', OPERATION, OTHER_LANE));
  let fenceInside;
  const records = await withCheckedOperationHistory({ journal, lane: LANE, operationId: OPERATION }, ({ records: seen, laneOwner }) => {
    assert.equal(typeof laneOwner, 'object');
    fenceInside = journal.inspectLocks().find((lock) => lock.key === LANE).fence;
    return seen;
  });
  assert.deepEqual(records, written.filter((entry) => entry.operationId === OPERATION));
  assert.deepEqual(records.map(({ artifactHash, passId, state }) => `${artifactHash[0]}/${passId}/${state}`),
    ['a/p1/signed', 'a/p1/dispatch-started', 'f/p2/signed', 'a/p2/dispatch-withheld', 'f/p2/dispatch-started']);
  assert.ok(Object.isFrozen(records) && records.every(Object.isFrozen), 'the records are deep-frozen');
  const fenceAfter = await journal.withWalletLock(LANE, async () => journal.inspectLocks().find((lock) => lock.key === LANE).fence);
  assert.equal(fenceAfter - fenceInside, 1, 'the callback acquired the lane exactly once');
  assert.deepEqual(journal.inspectLocks(), []);
});

test('a same-lane append waits through the callback and its final check while another lane proceeds', async (t) => {
  const { journal, reopen } = journalFile(t);
  const other = createEffectHistory({ journal: reopen() });
  await createEffectHistory({ journal }).append(record(ARTIFACT_A, 'p1', 'signed'));
  let sameLane, sameSettled = false;
  const value = await withCheckedOperationHistory({ journal, lane: LANE, operationId: OPERATION }, async ({ records }) => {
    sameLane = other.append(record(ARTIFACT_A, 'p1', 'dispatch-started')).finally(() => { sameSettled = true; });
    assert.deepEqual(await other.append(record(ARTIFACT_B, 'p1', 'signed', OPERATION, OTHER_LANE)), { status: 'appended' });
    assert.equal(sameSettled, false, 'the same-lane append waits while the callback holds the lane');
    return records.length;
  });
  // The final re-read found the history unchanged, so the waiting append had not landed before it.
  assert.equal(value, 1);
  assert.deepEqual(await sameLane, { status: 'appended' });
  const after = await withCheckedOperationHistory({ journal, lane: LANE, operationId: OPERATION }, returnRecords);
  assert.deepEqual(after.map((entry) => entry.state), ['signed', 'dispatch-started']);
});

test('unreadable, malformed and foreign history refuses instead of becoming empty', async (t) => {
  const plantedKey = `${lanePrefix(LANE)}TEST-not-a-history-key`;
  assert.ok(plantedKey.startsWith(lanePrefix(LANE)), 'the planted key is under the prefix the helper scans');
  const cases = [
    ['a key that is not a history key', async ({ journal }) => journal.put(plantedKey, { lane: LANE }), undefined],
    ['a record whose body names another lane', async ({ journal }) => journal.put(historyKey(record(ARTIFACT_A, 'p1', 'signed')), record(ARTIFACT_A, 'p1', 'signed', OPERATION, OTHER_LANE)), undefined],
    ['a record with no operation', async ({ journal }) => {
      const { operationId, ...bare } = record(ARTIFACT_A, 'p1', 'signed');
      assert.equal(operationId, OPERATION);
      await createEffectHistory({ journal }).append(bare);
      assert.deepEqual(await createEffectHistory({ journal }).readOperation({ lane: LANE, operationId: OPERATION }), [], 'the plain reader drops it');
    }, undefined],
    ['a row changed outside the journal', async ({ journal, raw }) => {
      const key = historyKey(record(ARTIFACT_A, 'p1', 'signed'));
      await createEffectHistory({ journal }).append(record(ARTIFACT_A, 'p1', 'signed'));
      assert.equal(raw('UPDATE records SET value = ? WHERE key = ?', JSON.stringify(record(ARTIFACT_A, 'p1', 'signed', OTHER_OPERATION)), key).changes, 1);
    }, 'journal-integrity'],
  ];
  for (const [label, plant, causeCode] of cases) {
    const file = journalFile(t);
    await plant(file);
    await assert.rejects(withCheckedOperationHistory({ journal: file.journal, lane: LANE, operationId: OPERATION }, notRun), unavailable(causeCode), label);
  }
  const { journal, reopen } = journalFile(t);
  const impatient = reopen({ lockTimeoutMs: 50 });
  let release;
  const holding = journal.withWalletLock(LANE, () => new Promise((resolve) => { release = resolve; }));
  await assert.rejects(withCheckedOperationHistory({ journal: impatient, lane: LANE, operationId: OPERATION }, notRun), unavailable('journal-busy'), 'a lane another handle holds');
  release();
  await holding;
});

test('readChecked and the final check reject a changed or released lane before the callback completes', async (t) => {
  const request = (journal) => ({ journal, lane: LANE, operationId: OPERATION });
  const dropLock = (raw) => assert.equal(raw('DELETE FROM locks WHERE key = ?', LANE).changes, 1);

  const changed = journalFile(t);
  await assert.rejects(withCheckedOperationHistory(request(changed.journal), async ({ laneOwner }) => {
    await createEffectHistory({ journal: changed.journal }).append(record(ARTIFACT_A, 'p1', 'signed'), { owner: laneOwner });
  }), (error) => unavailable()(error) && error.cause === undefined && /changed/.test(error.message), 'a record added under the lane');

  const released = journalFile(t);
  let inside;
  await assert.rejects(withCheckedOperationHistory(request(released.journal), async ({ readChecked }) => {
    dropLock(released.raw);
    inside = await readChecked().then(() => 'resolved', (error) => error);
  }), unavailable('journal-fenced'), 'the final liveness call after the lock row is gone');
  assert.ok(unavailable('journal-fenced')(inside), 'readChecked surfaces the lost lane as eb_history_unavailable');

  const thrown = journalFile(t), failure = new Error('TEST-work-failure');
  await assert.rejects(withCheckedOperationHistory(request(thrown.journal), () => { throw failure; }), (error) => error === failure, 'an error of work passes through unchanged');

  const lostThenThrown = journalFile(t);
  await assert.rejects(withCheckedOperationHistory(request(lostThenThrown.journal), () => { dropLock(lostThenThrown.raw); throw failure; }),
    (error) => unavailable('journal-fenced')(error) && error.cause.cause === failure, 'a lane lost while work throws');

  const committed = journalFile(t);
  await assert.rejects(withCheckedOperationHistory(request(committed.journal), async () => {
    await committed.journal.put('TEST-marker', { committed: true });
    dropLock(committed.raw);
    return 'TEST-value';
  }), unavailable('journal-fenced'), 'work committed and returned while the lane was lost');
  assert.deepEqual(await committed.journal.get('TEST-marker'), { committed: true }, 'what work committed stands');
});

test('a process killed inside the callback leaves its lane to be reclaimed with the history unchanged', async (t) => {
  const { journal, path } = journalFile(t);
  await createEffectHistory({ journal }).append(record(ARTIFACT_A, 'p1', 'signed'));
  const before = await withCheckedOperationHistory({ journal, lane: LANE, operationId: OPERATION }, returnRecords);
  const source = (file) => JSON.stringify(pathToFileURL(join(packageDir, file)).href);
  const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { openDurableWalletJournal } = await import(${source('src/wallet/durable-journal.mjs')});
    const { withCheckedOperationHistory } = await import(${source('src/wallet/effect-history.mjs')});
    const journal = openDurableWalletJournal({ path: process.argv[1], mode: 'open' });
    await withCheckedOperationHistory({ journal, lane: process.argv[2], operationId: process.argv[3] }, async () => {
      console.log('held');
      process.kill(process.pid, 'SIGKILL');
      await new Promise(() => {});
    });
  `, path, LANE, OPERATION], { encoding: 'utf8' });
  assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
  assert.match(crashed.stdout, /held/);
  assert.deepEqual(journal.inspectLocks().map((lock) => [lock.key, lock.holder]), [[LANE, 'exited']], 'the killed holder left its lane lock');
  assert.deepEqual(await withCheckedOperationHistory({ journal, lane: LANE, operationId: OPERATION }, returnRecords), before, 'the lane is reclaimed and its history unchanged');
  assert.deepEqual(journal.inspectLocks(), []);
});

test('the installed classifier keeps signed-held and unpaired dispatch as possible liability', () => {
  const histories = [
    [{ state: 'signed', passId: 'p1' }, { state: 'signed-held', passId: 'p1' }],
    [{ state: 'signed', passId: 'p1' }, { state: 'dispatch-started', passId: 'p1' }],
    [{ state: 'signed', passId: 'p1' }, { state: 'dispatch-started', passId: 'p1' }, { state: 'dispatch-withheld', passId: 'p1' }],
    [{ state: 'signed', passId: 'p1' }, { state: 'dispatch-withheld', passId: 'p1' }],
  ];
  const answer = packedChild('classify.mjs', `
    import { classifyDispatchHistory } from '@kynesyslabs/dacs-client/wallet/effect-history';
    console.log(JSON.stringify(JSON.parse(process.argv[2]).map((records) => classifyDispatchHistory(records).status)));
  `, [JSON.stringify(histories)]);
  assert.deepEqual(answer, ['earlier-possible', 'earlier-possible', 'never-transmitted', 'unavailable']);
});

test('checked history reads the lane the wallet transport appends to and refuses other lane names', async (t) => {
  const w = nativeWorld(t, { bound: await bindFixture() });
  w.open({});
  const { tx } = await w.send(1);
  const expected = await w.records(tx), operationId = expected[0].operationId;
  assert.ok(expected.length > 0);
  for (const chainIdentity of [WORLD_IDENTITY, '0x' + WORLD_IDENTITY]) {
    const lane = nativeWalletLaneKey({ ...PINS, chainIdentity }, w.address);
    assert.deepEqual(await withCheckedOperationHistory({ journal: w.journal(), lane, operationId }, returnRecords), expected, chainIdentity);
  }
  const sourceJournal = pathToFileURL(join(packageDir, 'src/wallet/durable-journal.mjs')).href;
  const answer = packedChild('checked.mjs', `
    import { openDurableWalletJournal } from '@kynesyslabs/dacs-client/wallet/durable-journal';
    import { withCheckedOperationHistory, nativeWalletLaneKey } from '@kynesyslabs/dacs-client/wallet/effect-history';
    const { openDurableWalletJournal: openSourceJournal } = await import(${JSON.stringify(sourceJournal)});
    const [path, pins, address, operationId] = process.argv.slice(2);
    const lane = nativeWalletLaneKey(JSON.parse(pins), address);
    const journal = openDurableWalletJournal({ path, mode: 'open' });
    const records = await withCheckedOperationHistory({ journal, lane, operationId }, ({ records }) => records);
    const source = openSourceJournal({ path, mode: 'open' });
    let ran = false;
    const foreign = await withCheckedOperationHistory({ journal: source, lane, operationId }, () => { ran = true; }).then(() => 'resolved', (error) => error.constructor.name + ':' + error.message);
    journal.close(); source.close();
    console.log(JSON.stringify({ records, foreign, ran }));
  `, [w.journal().path, JSON.stringify(PINS), w.address, operationId]);
  assert.deepEqual(answer, { records: expected, foreign: 'TypeError:checked_history_journal_invalid', ran: false });

  const network = 'testnet', address = w.address;
  const members = (list) => `devnet/native-wallet/${JSON.stringify(list)}`;
  const refused = [walletLaneKey(walletLane({ network, chainIdentity: WORLD_IDENTITY, address })), operationId, 'rpc-authentication', '', 42,
    members([network, WORLD_IDENTITY]), members([network, WORLD_IDENTITY, address, 'TEST-extra']),
    `devnet/native-wallet/["${network}", "${WORLD_IDENTITY}", "${address}"]`, members([network, '0x' + WORLD_IDENTITY, address])];
  for (const lane of refused) {
    await assert.rejects(withCheckedOperationHistory({ journal: w.journal(), lane, operationId }, notRun), typeError('checked_history_lane_invalid'), String(lane));
  }
});

test('checked history refuses a substitute, a tampered and a closed journal before the work runs', async (t) => {
  const { journal } = journalFile(t);
  await createEffectHistory({ journal }).append(record(ARTIFACT_A, 'p1', 'signed'));
  assert.equal((await withCheckedOperationHistory({ journal, lane: LANE, operationId: OPERATION }, returnRecords)).length, 1, 'a real handle succeeds');
  const calls = { entries: 0, lock: 0 };
  const substitute = { entries: async () => { calls.entries++; return []; }, withOwnedOrAcquiredLane: async (_lane, work) => { calls.lock++; return work({}); } };
  const tampered = journalFile(t).journal;
  tampered.entries = substitute.entries;
  for (const [label, candidate] of [['a substitute', substitute], ['a handle with a replaced method', tampered], ['a spread copy', { ...journal }], ['null', null], ['a string', 'TEST-journal']]) {
    await assert.rejects(withCheckedOperationHistory({ journal: candidate, lane: LANE, operationId: OPERATION }, notRun), typeError('checked_history_journal_invalid'), label);
  }
  assert.deepEqual(calls, { entries: 0, lock: 0 });
  for (const request of [undefined, null, [journal], 'TEST-request']) {
    await assert.rejects(withCheckedOperationHistory(request, notRun), typeError('checked_history_request_invalid'), String(request));
  }
  await assert.rejects(withCheckedOperationHistory({ journal, lane: LANE, operationId: '' }, notRun), typeError('checked_history_request_invalid'), 'an empty operation id');
  await assert.rejects(withCheckedOperationHistory({ journal, lane: LANE, operationId: OPERATION }, 'TEST-work'), typeError('checked_history_request_invalid'), 'work that is not a function');
  const closed = journalFile(t).journal;
  closed.close();
  await assert.rejects(withCheckedOperationHistory({ journal: closed, lane: LANE, operationId: OPERATION }, notRun), unavailable('journal-closed'), 'a closed handle');
});

test('an oversized lane is refused as a lane error and never reaches the journal key check', async (t) => {
  const laneFor = (address) => nativeWalletLaneKey({ network: 'testnet', chainIdentity: IDENTITY }, address);
  const historyKeyBytes = (lane) => Buffer.byteLength(lanePrefix(lane)) + 64 + 1 + 64;
  // The address that makes the lane's full history key exactly `limit` bytes.
  const largestAddress = (limit) => 'b'.repeat(limit - historyKeyBytes(laneFor('')));
  for (const limit of [512, 300]) {
    const { journal } = journalFile(t, limit === 512 ? {} : { maxKeyBytes: limit });
    const largest = laneFor(largestAddress(limit));
    assert.equal(historyKeyBytes(largest), limit);
    assert.deepEqual(await withCheckedOperationHistory({ journal, lane: largest, operationId: OPERATION }, returnRecords), [], `the largest lane at ${limit} is accepted`);
    const suffix = { passId: 'p1', state: 's'.repeat(61) };
    assert.equal(Buffer.byteLength(`${suffix.passId}/${suffix.state}`), 64);
    const written = { lane: largest, artifactHash: ARTIFACT_A, ...suffix, operationId: OPERATION };
    assert.equal(Buffer.byteLength(historyKey(written)), limit);
    assert.deepEqual(await createEffectHistory({ journal }).append(written), { status: 'appended' });
    assert.deepEqual(await withCheckedOperationHistory({ journal, lane: largest, operationId: OPERATION }, returnRecords), [written], 'an appender can write every accepted lane');
    const oversized = [laneFor(largestAddress(limit) + 'b')];
    if (limit === 512) oversized.push(laneFor('b'.repeat(511 - laneFor('').length)));
    for (const lane of oversized) {
      await assert.rejects(withCheckedOperationHistory({ journal, lane, operationId: OPERATION }, notRun), typeError('checked_history_lane_invalid'), `${Buffer.byteLength(lane)}-byte lane at ${limit}`);
      assert.deepEqual(journal.inspectLocks(), []);
    }
  }
});

// The passive result evidence recorder over the supplied durable wallet journal.
// The journal is the real one on a temporary file, wrapped by a call counter.
// No network, no keys, no wall clock.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCanonicalJobId } from '@kynesyslabs/dacs';
import { installPurchaseAdmissionHook, loadAdmissionDouble } from './helpers/purchase-admission-hook.mjs';

installPurchaseAdmissionHook();
const { setPurchaseAdmission } = await loadAdmissionDouble();
const { createPurchaseEvidenceRecorder } = await import('../src/passive-evidence-recorder.mjs');
const { openDurableWalletJournal, DurableWalletJournalError } = await import('../src/wallet/durable-journal.mjs');
const { readIssuedArtifacts, readIssuedWallet } = await import('../src/devnet-demo/issued-readback.mjs');

const CHILD = new URL('./helpers/evidence-recorder-child.mjs', import.meta.url).pathname;
const JOURNAL_MEMBERS = ['get', 'put', 'entries', 'withWalletLock', 'appendUnderLock', 'withOwnedOrAcquiredLane', 'inspectLocks', 'releaseAbandonedLock'];
const UNTRUSTED_OPTIONS = ['profile', 'record', 'identityRecord', 'actionsAdmitted'];
const hashOf = (n) => n.toString(16).padStart(64, '0');
const laneOf = (deliveryId) => `purchase-evidence/${deliveryId}`;
const reportOf = (deliveryId, n, state = 'submitted') => ({ deliveryId, hash: hashOf(n), nonce: n, state });

function openWorld(t) {
  const dir = mkdtempSync(join(tmpdir(), 'passive-evidence-recorder-'));
  const path = join(dir, 'journal.sqlite');
  const journal = openDurableWalletJournal({ path, mode: 'create', lockTimeoutMs: 200 });
  const second = [];
  t.after(() => { journal.close(); second.forEach((other) => other.close()); rmSync(dir, { recursive: true, force: true }); });
  const openSecond = () => { const other = openDurableWalletJournal({ path, mode: 'open', lockTimeoutMs: 200 }); second.push(other); return other; };
  return { dir, path, journal, openSecond };
}

// The same members, each counted and forwarded to `journal`.
function counting(journal) {
  const calls = Object.fromEntries(JOURNAL_MEMBERS.map((name) => [name, 0]));
  const wrapped = Object.fromEntries(JOURNAL_MEMBERS.map((name) => [name, (...args) => { calls[name] += 1; return journal[name](...args); }]));
  return { journal: wrapped, calls };
}
const totalCalls = (calls) => Object.values(calls).reduce((sum, n) => sum + n, 0);

// An admission whose every member throws when used: the recorder must never touch it.
function untouchedAdmission() {
  const used = [];
  const binding = new Proxy({}, { get(_target, name) { used.push(String(name)); throw new Error('TEST binding was read'); } });
  return { admission: { binding, currentLocal: () => { used.push('currentLocal'); throw new Error('TEST binding check fails'); } }, used };
}
const recorderOver = (journal, extra = {}) => {
  const { admission, used } = untouchedAdmission();
  return { recorder: createPurchaseEvidenceRecorder({ admission, journal, ...extra }), used };
};

const createFor = (deliveryId, hash, { viaMetadata = false } = {}) => ({
  hash,
  stage: 'issued',
  signedTransaction: { content: { from: '0xabc', type: 'storageProgram', data: viaMetadata
    ? ['storageProgram', { data: {}, metadata: { artifactBinding: { jobId: deliveryId } } }]
    : ['storageProgram', { data: { jobId: deliveryId }, metadata: {} }] } },
});

function runChild(path, mode, report) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, path, mode, report.deliveryId, report.hash, String(report.nonce), report.state], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, out, err }));
  });
}

test('construction without admission throws admission_required, and with an untrusted option throws admission_input_untrusted, each with zero journal reads, appends and lock calls; with admission, recording still runs while the binding check fails', async (t) => {
  const { journal } = openWorld(t);
  const { journal: watched, calls } = counting(journal);
  const { admission } = untouchedAdmission();
  assert.throws(() => createPurchaseEvidenceRecorder({ journal: watched }), { name: 'TypeError', message: 'admission_required' });
  assert.throws(() => createPurchaseEvidenceRecorder({ admission: { binding: {} }, journal: watched }), { name: 'TypeError', message: 'admission_required' });
  assert.throws(() => createPurchaseEvidenceRecorder({ admission: { ...admission, extra: 1 }, journal: watched }), { name: 'TypeError', message: 'admission_required' });
  for (const name of UNTRUSTED_OPTIONS) {
    assert.throws(() => createPurchaseEvidenceRecorder({ admission, journal: watched, [name]: {} }), { name: 'TypeError', message: 'admission_input_untrusted' }, name);
  }
  assert.throws(() => createPurchaseEvidenceRecorder({ admission, journal: { get: watched.get } }), { name: 'TypeError', message: 'journal_required' });
  const original = Object.getOwnPropertyDescriptor(process, 'version');
  try {
    Object.defineProperty(process, 'version', { value: 'v20.19.0', configurable: true });
    assert.throws(() => createPurchaseEvidenceRecorder({ admission, journal: watched }), { code: 'runtime_unsupported' });
  } finally { Object.defineProperty(process, 'version', original); }
  assert.equal(totalCalls(calls), 0, 'no refused construction touched the journal');

  const deliveryId = generateCanonicalJobId();
  const { recorder, used } = recorderOver(watched);
  assert.deepEqual(await recorder.recordWalletResult(reportOf(deliveryId, 1)), { status: 'recorded', count: 1 });
  assert.deepEqual(used, [], 'the failing binding check was never consulted');
});

test('openRetainedCreateJournal and resultHistory call only get and entries on the supplied journal, with zero put, appendUnderLock, withWalletLock and releaseAbandonedLock calls, and the returned snapshot has no write, lock or resume member', async (t) => {
  const { journal } = openWorld(t);
  const deliveryId = generateCanonicalJobId();
  const otherId = generateCanonicalJobId();
  const lane = 'devnet/native-wallet/TEST-lane';
  const { recorder: writer } = recorderOver(journal);
  await writer.recordWalletResult(reportOf(deliveryId, 1));
  await journal.put('devnet/native-wallet/TEST-create-a', createFor(deliveryId, hashOf(11)));
  await journal.put('devnet/native-wallet/TEST-create-b', createFor(deliveryId, hashOf(12), { viaMetadata: true }));
  await journal.put('devnet/native-wallet/TEST-create-other', createFor(otherId, hashOf(13)));
  await journal.put(lane, { stage: 'issued' });
  await journal.put(`${lane}/child`, { stage: 'observed' });
  await journal.put(`${lane}-sibling`, { stage: 'issued' });

  const { journal: watched, calls } = counting(journal);
  const { recorder } = recorderOver(watched);
  const before = await journal.entries();
  const history = await recorder.resultHistory(deliveryId);
  const snapshot = await recorder.openRetainedCreateJournal({ deliveryId, laneKey: lane });
  const readerCalls = { ...calls };
  assert.equal(readerCalls.entries, 1, 'the snapshot scans the journal once');
  for (const name of ['put', 'appendUnderLock', 'withWalletLock', 'releaseAbandonedLock', 'withOwnedOrAcquiredLane', 'inspectLocks']) assert.equal(readerCalls[name], 0, name);
  assert.deepEqual(await journal.entries(), before, 'reading changed nothing');

  assert.equal(history.length, 1);
  assert.deepEqual(Object.keys(snapshot), ['deliveryId', 'laneKey', 'records']);
  assert.deepEqual(snapshot.records.map(([key]) => key).sort(), ['devnet/native-wallet/TEST-create-a', 'devnet/native-wallet/TEST-create-b', lane, `${lane}/child`]);
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.records));
  assert.ok(snapshot.records.every((pair) => Object.isFrozen(pair) && Object.isFrozen(pair[1])));
  assert.ok(Object.isFrozen(snapshot.records[0][1].signedTransaction ?? {}));
  for (const member of Object.values(snapshot)) assert.notEqual(typeof member, 'function');
  for (const name of ['put', 'append', 'appendUnderLock', 'withWalletLock', 'lock', 'resume', 'write']) assert.equal(name in snapshot, false, name);
});

test('result recording and retained CREATE journal reads run while stopped, held and with a failing binding', async (t) => {
  const { journal } = openWorld(t);
  const deliveryId = generateCanonicalJobId();
  const { admission, used } = untouchedAdmission();
  const stopCalls = [];
  const stopped = () => { stopCalls.push('stopped'); return true; };
  await journal.put('devnet/native-wallet/TEST-create-a', createFor(deliveryId, hashOf(11)));
  const recorder = createPurchaseEvidenceRecorder({ admission, journal, stopped });
  for (const [index, hold] of ['held', 'testnet-tp1'].entries()) {
    setPurchaseAdmission(hold);
    try {
      assert.deepEqual(await recorder.recordWalletResult(reportOf(deliveryId, index + 1)), { status: 'recorded', count: index + 1 }, hold);
      assert.equal((await recorder.resultHistory(deliveryId)).length, index + 1, hold);
      const snapshot = await recorder.openRetainedCreateJournal({ deliveryId, laneKey: 'devnet/native-wallet/TEST-lane' });
      assert.equal(snapshot.records.length, 1, hold);
    } finally { setPurchaseAdmission('held'); }
  }
  assert.deepEqual(stopCalls, [], 'the stop check was never consulted');
  assert.deepEqual(used, [], 'the binding check was never consulted');
});

test('recordWalletResult and openRetainedCreateJournal never continue, resend, sign, post to seller or request a wallet action', async (t) => {
  const { journal } = openWorld(t);
  const deliveryId = generateCanonicalJobId();
  const network = mock.method(globalThis, 'fetch', () => { throw new Error('TEST no network call is allowed'); });
  t.after(() => network.mock.restore());
  const { journal: watched, calls } = counting(journal);
  const { recorder, used } = recorderOver(watched);
  assert.deepEqual(Object.keys(recorder).sort(), ['openRetainedCreateJournal', 'recordWalletResult', 'resultHistory']);
  assert.ok(Object.isFrozen(recorder));

  for (let n = 1; n <= 3; n += 1) await recorder.recordWalletResult(reportOf(deliveryId, n));
  await recorder.openRetainedCreateJournal({ deliveryId, laneKey: laneOf(deliveryId) });

  assert.equal(network.mock.callCount(), 0);
  assert.deepEqual(used, []);
  for (const name of ['put', 'withOwnedOrAcquiredLane', 'releaseAbandonedLock']) assert.equal(calls[name], 0, name);
  const keys = (await journal.entries()).map(([key]) => key);
  assert.equal(keys.length, 3);
  for (const [key, value] of await journal.entries()) {
    assert.match(key, new RegExp(`^purchase-evidence/${deliveryId}/result/[1-3]$`));
    assert.equal(key.startsWith('devnet/') || key.startsWith('sr2/wallet/'), false);
    assert.equal('signedTransaction' in value, false);
    assert.equal('stage' in value, false);
  }
  assert.deepEqual(journal.inspectLocks(), [], 'no lane stays locked');
});

test('invalid report members, wrong delivery or lane, journal failure and a repeated report never grant effect authority or erase retained evidence', async (t) => {
  const { journal, openSecond } = openWorld(t);
  const deliveryId = generateCanonicalJobId();
  const { journal: watched, calls } = counting(journal);
  const { recorder } = recorderOver(watched);
  const good = reportOf(deliveryId, 1);
  const invalid = [
    undefined, null, [], 'report', { ...good, extra: 1 },
    { deliveryId: good.deliveryId, hash: good.hash, nonce: good.nonce },
    { ...good, deliveryId: 'job-1' }, { ...good, deliveryId: 7 },
    { ...good, hash: good.hash.toUpperCase().replace(/^0+/, 'A') }, { ...good, hash: good.hash.slice(1) }, { ...good, hash: `0x${good.hash}` }, { ...good, hash: 7 },
    { ...good, nonce: -1 }, { ...good, nonce: 1.5 }, { ...good, nonce: 2 ** 53 }, { ...good, nonce: '1' },
    { ...good, state: 'settled' }, { ...good, state: 'verified' }, { ...good, state: undefined },
  ];
  for (const report of invalid) assert.deepEqual(await recorder.recordWalletResult(report), { status: 'invalid_report' }, JSON.stringify(report));
  assert.equal(totalCalls(calls), 0, 'a refused report touches no journal member');
  assert.deepEqual(await journal.entries(), []);

  await assert.rejects(recorder.resultHistory('job-1'), { name: 'TypeError' });
  for (const laneKey of [undefined, '', 7]) {
    await assert.rejects(recorder.openRetainedCreateJournal({ deliveryId, laneKey }), { name: 'TypeError' }, String(laneKey));
  }
  await assert.rejects(recorder.openRetainedCreateJournal({ deliveryId: 'job-1', laneKey: laneOf(deliveryId) }), { name: 'TypeError' });

  assert.deepEqual(await recorder.recordWalletResult(good), { status: 'recorded', count: 1 });
  const retained = await journal.entries();
  assert.deepEqual(await recorder.recordWalletResult(good), { status: 'repeat', count: 1 });
  assert.deepEqual(await journal.entries(), retained, 'a repeat writes nothing');

  const failure = new DurableWalletJournalError('journal-capacity', 'TEST journal full');
  const failing = { ...watched, appendUnderLock: async () => { throw failure; } };
  const { recorder: failingRecorder } = recorderOver(failing);
  await assert.rejects(failingRecorder.recordWalletResult(reportOf(deliveryId, 2)), (error) => error === failure);
  assert.deepEqual(await journal.entries(), retained, 'a failed append erases nothing');

  const readFailure = new DurableWalletJournalError('journal-integrity', 'TEST journal read failed');
  const unreadable = { ...watched, get: async () => { throw readFailure; }, entries: async () => { throw readFailure; } };
  const { recorder: unreadableRecorder } = recorderOver(unreadable);
  await assert.rejects(unreadableRecorder.recordWalletResult(reportOf(deliveryId, 2)), (error) => error === readFailure);
  await assert.rejects(unreadableRecorder.resultHistory(deliveryId), (error) => error === readFailure);
  await assert.rejects(unreadableRecorder.openRetainedCreateJournal({ deliveryId, laneKey: laneOf(deliveryId) }), (error) => error === readFailure);
  assert.deepEqual(await journal.entries(), retained, 'a failed read writes nothing');

  const holder = openSecond();
  await holder.withWalletLock(laneOf(deliveryId), async () => {
    await assert.rejects(recorder.recordWalletResult(reportOf(deliveryId, 2)), { code: 'journal-busy' });
  });
  assert.deepEqual(await journal.entries(), retained, 'a busy lane writes nothing');
  assert.deepEqual(await recorder.recordWalletResult(reportOf(deliveryId, 2)), { status: 'recorded', count: 2 });
  assert.deepEqual((await recorder.resultHistory(deliveryId)).map((entry) => entry.nonce), [1, 2]);
});

test('a stored result record that is not a well-formed report makes recording and history fail instead of counting as absent', async (t) => {
  const { journal } = openWorld(t);
  const deliveryId = generateCanonicalJobId();
  await journal.put(`${laneOf(deliveryId)}/result/1`, { kind: 'unverified-wallet-result', deliveryId, hash: 'not-a-hash', nonce: 1, state: 'submitted', seq: 1 });
  const { recorder } = recorderOver(journal);
  await assert.rejects(recorder.resultHistory(deliveryId), { code: 'evidence_record_invalid' });
  await assert.rejects(recorder.recordWalletResult(reportOf(deliveryId, 2)), { code: 'evidence_record_invalid' });
  assert.equal((await journal.entries()).length, 1);
});

test('a ninth result report returns evidence_limit and preserves all eight earlier unverified pointers in order, also when two processes report the eighth and ninth at once', async (t) => {
  const { journal, path } = openWorld(t);
  const deliveryId = generateCanonicalJobId();
  const { recorder } = recorderOver(journal);
  for (let n = 1; n <= 7; n += 1) assert.deepEqual(await recorder.recordWalletResult(reportOf(deliveryId, n)), { status: 'recorded', count: n });

  const [first, second] = await Promise.all([runChild(path, 'record', reportOf(deliveryId, 8)), runChild(path, 'record', reportOf(deliveryId, 9))]);
  assert.deepEqual([first.code, second.code], [0, 0], first.err + second.err);
  const answers = [JSON.parse(first.out), JSON.parse(second.out)];
  assert.deepEqual(answers.map(({ status }) => status).sort(), ['evidence_limit', 'recorded']);
  assert.deepEqual(answers.find(({ status }) => status === 'evidence_limit'), { status: 'evidence_limit', count: 8 });

  const history = await recorder.resultHistory(deliveryId);
  assert.equal(history.length, 8);
  assert.deepEqual(history.slice(0, 7).map(({ nonce }) => nonce), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(history.map(({ seq }) => seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(history.every((entry) => entry.verified === false && Object.isFrozen(entry)));
  const kept = await journal.entries();

  assert.deepEqual(await recorder.recordWalletResult(reportOf(deliveryId, 20)), { status: 'evidence_limit', count: 8 });
  assert.deepEqual(await journal.entries(), kept, 'the ninth report changed nothing');
  assert.deepEqual(await recorder.recordWalletResult(reportOf(deliveryId, 4)), { status: 'repeat', count: 8 }, 'an identical repeat uses no slot and is not a limit refusal');
});

test('the recorder uses the supplied durable wallet journal and writes no second store', async (t) => {
  const { dir, journal } = openWorld(t);
  const deliveryId = generateCanonicalJobId();
  const filesBefore = readdirSync(dir).sort();
  const { recorder } = recorderOver(journal);
  await recorder.recordWalletResult(reportOf(deliveryId, 1));
  assert.deepEqual(readdirSync(dir).sort(), filesBefore, 'no file or directory was added beside the journal');
  assert.deepEqual((await journal.entries()).map(([key]) => key), [`${laneOf(deliveryId)}/result/1`]);

  const stored = new Map();
  const supplied = {
    get: async (key) => stored.get(key),
    entries: async () => [...stored],
    withWalletLock: async (_key, work) => work(),
    appendUnderLock: async (_lane, key, value) => { stored.set(key, value); },
  };
  const { recorder: overSupplied } = recorderOver(supplied);
  const otherId = generateCanonicalJobId();
  assert.deepEqual(await overSupplied.recordWalletResult(reportOf(otherId, 1)), { status: 'recorded', count: 1 });
  assert.deepEqual([...stored.keys()], [`${laneOf(otherId)}/result/1`], 'the report landed in the supplied journal');
  assert.equal((await journal.entries()).length, 1, 'the durable journal did not see it');
});

test('a report is never returned by the issued-transfer readers: after eight reports for a delivery, readIssued and readIssuedPayment answer as before', async (t) => {
  const { journal } = openWorld(t);
  const deliveryId = generateCanonicalJobId();
  const address = `0x${'ab'.repeat(32)}`;
  const writer = `did:demos:agent:${address.slice(2)}`;
  const sourceCapability = { journal };
  const answers = async (hash) => [
    await readIssuedWallet({ sourceCapability, address, hash, nativeOnly: true }),
    await readIssuedArtifacts({ sourceCapability, writer, jobId: deliveryId, unknownOnly: true }),
  ];
  const before = await answers(hashOf(1));
  const { recorder } = recorderOver(journal);
  for (let n = 1; n <= 8; n += 1) await recorder.recordWalletResult(reportOf(deliveryId, n));
  assert.deepEqual(await answers(hashOf(1)), before);
  assert.deepEqual(before, [null, null]);
});

test('a process killed between the lane lock and the append leaves no report; killed after the append, the repeat answers repeat', async (t) => {
  const { journal, path } = openWorld(t);
  const { recorder } = recorderOver(journal);

  const beforeAppend = generateCanonicalJobId();
  const killed = await runChild(path, 'killBeforeAppend', reportOf(beforeAppend, 1));
  assert.equal(killed.signal, 'SIGKILL');
  assert.deepEqual(await recorder.resultHistory(beforeAppend), [], 'nothing was written');
  assert.deepEqual(await recorder.recordWalletResult(reportOf(beforeAppend, 1)), { status: 'recorded', count: 1 }, 'the dead holder\'s lane is reclaimed and the report is recorded once');

  const afterAppend = generateCanonicalJobId();
  const diedLate = await runChild(path, 'killAfterAppend', reportOf(afterAppend, 1));
  assert.equal(diedLate.signal, 'SIGKILL');
  assert.equal((await recorder.resultHistory(afterAppend)).length, 1, 'the report was retained');
  assert.deepEqual(await recorder.recordWalletResult(reportOf(afterAppend, 1)), { status: 'repeat', count: 1 });
  assert.equal((await recorder.resultHistory(afterAppend)).length, 1);
});

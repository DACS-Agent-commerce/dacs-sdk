import './helpers/transport-boundary.mjs'; // first: it installs the purchase-admission hook before any source module loads
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
// Loaded after the admission hook, so the effect boundary under test sees the admission double.
const { DEVNET_NODE2_BLOCK_LAYOUT, DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE } = await import('../src/wallet/devnet-native-transport.mjs');
const { createWorld, JOB_IDS } = await import('./helpers/native-create-world.mjs');
const { deferred, jsonResponse, MIB, ok, sizedReply, sourceReadTransport, sourceReadWorld } = await import('./helpers/source-read-world.mjs');
const { openDurableWalletJournal } = await import('../src/wallet/durable-journal.mjs');

const CHAIN = TP1_APPROVED_IDENTITY_RECORD.chainIdentity;
const CRASH_CHILD = fileURLToPath(new URL('./helpers/source-read-crash-child.mjs', import.meta.url));
const TEST_TIMEOUT_MS = 60_000;
const DEFAULT_TRANSPORT_TIMEOUT_MS = 10_000;
const NODE_INFO = { method: 'nodeCall', params: [{ message: 'getNetworkInfo', data: {} }] };
const messageOf = row => row.body.params[0].message;
const heightOf = row => row.body.params[0].data.blockNumber;
const blockZero = { number: 0, status: 'confirmed', hash: CHAIN, content: {} };
// An identity answer that lacks the envelope's require_reply and extra members.
const twoMemberEnvelope = hash => ({ result: 200, response: { ...blockZero, hash } });
const callers = {
  readRpc: (w, options) => w.transport.readRpc('/', NODE_INFO, options),
  observeBinding: (w, options) => w.transport.observeBinding(options),
};
const cancellation = reason => { const controller = new AbortController(); return { signal: controller.signal, abort: () => controller.abort(reason) }; };
const flushLateWork = () => new Promise(resolve => setImmediate(resolve));
// Block reads for the reviewed Node2 layout: numeric block zero refused, the string "0" read answered with the genesis projection, then block one and block two.
const observations = new URL('../../../conformance/', import.meta.url);
const reviewedBlocks = ['tp1-node-observations/block0-2026-10-20.json', 'tp1-node-observations/block1-2026-10-20.json',
  'tp1-node-observations-2026-11-08/block2-2026-11-08.json'].map(file => JSON.parse(readFileSync(new URL(file, observations))).body);
function answerReviewedLayout(row) {
  const height = heightOf(row);
  if (height === '0') return jsonResponse(JSON.stringify({ result: 200, response: { number: 0, hash: CHAIN }, require_reply: false, extra: '' }));
  return jsonResponse(reviewedBlocks[height]);
}
const reviewedLayoutOptions = { blockZeroErrorEnvelope: DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE, blockOneLayout: DEVNET_NODE2_BLOCK_LAYOUT,
  reviewedBlockTwoHash: JSON.parse(reviewedBlocks[2]).response.hash };

test('through the real source readRpc, a requested 1 MiB limit admits 1 MiB and refuses 1 MiB plus one before decoding, with and without content-length; a limit above 4 MiB or not an integer is refused', { timeout: TEST_TIMEOUT_MS }, async t => {
  const w = sourceReadWorld(t);
  const reply = (bytes, declared) => { w.node.intercept = row => (messageOf(row) === 'getNetworkInfo' ? sizedReply(bytes, { declared }) : undefined); };
  for (const declared of [true, false]) {
    reply(MIB, declared);
    assert.ok((await callers.readRpc(w, { maxBytes: MIB })).response.pad.length > MIB - 100, 'a reply of exactly the limit is admitted');
    reply(MIB + 1, declared);
    await assert.rejects(callers.readRpc(w, { maxBytes: MIB }), error => error.kind === 'invalid' && /exceeds byte limit/.test(error.message));
    assert.ok(await callers.readRpc(w), 'without a caller limit the 4 MiB policy still applies');
  }
  w.node.intercept = null;
  for (const maxBytes of [0, -1, 1.5, '1024', Number.NaN, null, 4 * MIB + 1]) {
    const before = w.node.calls.length;
    await assert.rejects(callers.readRpc(w, { maxBytes }), { code: 'invalid_params' }, String(maxBytes));
    assert.equal(w.node.calls.length, before, 'a refused limit starts no request');
  }
  assert.ok(await callers.readRpc(w, { maxBytes: 4 * MIB }));
});

test('the proof read allowlist rejects every other node method', { timeout: TEST_TIMEOUT_MS }, async t => {
  const w = sourceReadWorld(t), storageAddresses = [`stor-${'7'.repeat(40)}`];
  const sent = message => w.node.calls.filter(row => row.body?.params?.[0]?.message === message).length;
  w.node.intercept = row => (['getStorageProof', 'getFinalizedHead'].includes(row.body?.params?.[0]?.message) ? jsonResponse(JSON.stringify(ok({ TEST: messageOf(row) }))) : undefined);
  const proof = { method: 'nodeCall', params: [{ message: 'getStorageProof', data: { storageAddresses } }] }, head = { method: 'nodeCall', params: [{ message: 'getFinalizedHead' }] };
  assert.deepEqual((await w.transport.readRpc('/', proof, { maxBytes: 64 * 1024 })).response, { TEST: 'getStorageProof' });
  assert.deepEqual((await w.transport.readRpc('/', head, { maxBytes: 64 * 1024 })).response, { TEST: 'getFinalizedHead' });
  assert.deepEqual([sent('getStorageProof'), sent('getFinalizedHead')], [1, 1], 'each permitted proof read reaches the node once');
  const refused = [['/', { method: 'nodeCall', params: [{ message: 'getStorageProofs', data: { storageAddresses } }] }], ['/', { method: 'nodeCall', params: [{ message: 'getFinalizedHeads' }] }],
    ['/', { method: 'nodeCall', params: [{ message: 'getPeerlist' }] }], ['/', { method: 'nodeCall', params: [{ message: 'setStorageProof', data: { storageAddresses } }] }],
    ['/', { method: 'execute', params: [{ message: 'getStorageProof', data: { storageAddresses } }] }], [`/storage-program/${storageAddresses[0]}`, proof]];
  for (const [path, body] of refused) {
    await assert.rejects(w.transport.readRpc(path, body), error => error.code === 'readonly_only' && /bounded proof\/finality reads/.test(error.message), JSON.stringify(body));
    assert.equal(sent(body.params[0].message), ['getStorageProof'].includes(body.params[0].message) ? 1 : 0, `${body.params[0].message} was never sent`);
  }
});

test('observeBinding refuses a deadline that is not an integer from 1 to the transport timeout and runs with a smaller one', { timeout: TEST_TIMEOUT_MS }, async t => {
  const w = sourceReadWorld(t);
  for (const timeoutMs of [0, -1, 1.5, '5000', Number.NaN, null, DEFAULT_TRANSPORT_TIMEOUT_MS + 1]) {
    const before = w.node.calls.length;
    await assert.rejects(w.transport.observeBinding({ timeoutMs }), { code: 'invalid_params' }, String(timeoutMs));
    assert.equal(w.node.calls.length, before, 'a refused deadline starts no request');
  }
  assert.equal((await w.transport.observeBinding({ timeoutMs: DEFAULT_TRANSPORT_TIMEOUT_MS / 2 })).chainIdentity, CHAIN);
});

test('readRpc and observeBinding cancelled while queued for the journal lock or the fence, inside identity acquisition, or between block one and the fallback read start no later request', { timeout: TEST_TIMEOUT_MS }, async t => {
  for (const [name, call] of Object.entries(callers)) {
    const reason = new Error(`TEST-cancelled-${name}`);
    const lockWorld = sourceReadWorld(t), lockHeld = deferred(), stopAtLock = cancellation(reason);
    const holder = lockWorld.journal.withWalletLock(lockWorld.lockKey, () => lockHeld.promise);
    const waitingForLock = call(lockWorld, { signal: stopAtLock.signal });
    stopAtLock.abort();
    await assert.rejects(waitingForLock, error => error === reason, `${name} released while queued for the journal lock`);
    lockHeld.resolve(); await holder; await lockWorld.transport.close();
    assert.equal(lockWorld.node.calls.length, 0, `${name} started a request after its lock wait was cancelled`);
    assert.equal(lockWorld.owner.acquisitions(), 0, `${name} took the fence after its lock wait was cancelled`);

    const fenceWorld = sourceReadWorld(t), heldFence = await fenceWorld.owner.acquireConnectionFence(), stopAtFence = cancellation(reason);
    const waitingForFence = call(fenceWorld, { signal: stopAtFence.signal });
    await fenceWorld.owner.queued();
    stopAtFence.abort();
    await assert.rejects(waitingForFence, error => error === reason, `${name} released while queued for the fence`);
    heldFence.release(); await fenceWorld.transport.close();
    assert.equal(fenceWorld.node.calls.length, 0, `${name} started a request after its fence wait was cancelled`);
    assert.equal(fenceWorld.owner.held(), false, `${name} left the fence held`);

    const identityWorld = sourceReadWorld(t), identityStalled = deferred(), identityStarted = deferred(), stopInIdentity = cancellation(reason);
    identityWorld.node.intercept = () => { identityStarted.resolve(); return identityStalled.promise; };
    const readingIdentity = call(identityWorld, { signal: stopInIdentity.signal });
    await identityStarted.promise;
    stopInIdentity.abort();
    await assert.rejects(readingIdentity, error => error === reason, `${name} released inside identity acquisition`);
    identityStalled.resolve(jsonResponse(JSON.stringify(ok(blockZero))));
    await identityWorld.transport.close(); await flushLateWork();
    assert.deepEqual(identityWorld.node.calls.map(heightOf), [0], `${name} read on after its identity read was cancelled`);

    const fallbackWorld = sourceReadWorld(t), stopAtFallback = cancellation(reason);
    fallbackWorld.node.intercept = () => { stopAtFallback.abort(); return jsonResponse(JSON.stringify({ result: 400, response: 'error' })); };
    await assert.rejects(call(fallbackWorld, { signal: stopAtFallback.signal }), error => error === reason, `${name} released between block zero and the fallback read`);
    await fallbackWorld.transport.close();
    assert.deepEqual(fallbackWorld.node.calls.map(heightOf), [0], `${name} started the fallback read after cancellation`);
  }
});

test('after the extraction, the same malformed identity envelope is refused in strict recovery mode and treated as before in normal mode, for the transport binder and the recovery binder', { timeout: TEST_TIMEOUT_MS }, async t => {
  const normal = sourceReadWorld(t);
  normal.node.intercept = row => (messageOf(row) === 'getBlockByNumber' ? jsonResponse(JSON.stringify(twoMemberEnvelope(CHAIN))) : undefined);
  assert.equal((await normal.transport.observeBinding()).chainIdentity, CHAIN, 'the normal binder accepts the two-member envelope as before');

  async function recoverWith(identityAnswer) {
    const messages = [], world = createWorld({ journal: sourceReadWorld(t).journal, identityAnswer, onNode: async message => { messages.push(message); } });
    t.after(() => world.capability.close());
    const create = await world.makeCreate(JOB_IDS[0], 1);
    await world.retain(create, 'broadcast-accepted', { signed: true });
    messages.length = 0;
    const result = await world.recover(create);
    return { result, messages, sent: world.sent };
  }
  const control = await recoverWith(null);
  assert.ok(control.sent.confirms.length > 0, 'a well-formed envelope lets recovery continue past identity');
  const strict = await recoverWith(twoMemberEnvelope);
  assert.equal(strict.result.disposition, 'pending');
  assert.deepEqual(strict.messages.filter(message => message !== 'getBlockByNumber'), [], 'the strict recovery binder refused the envelope before any later read or send');
  assert.deepEqual(strict.sent, { confirms: [], broadcasts: [] });
});

test('cancellation between the block-one and block-two reads of the reviewed layout stops the block-two read', { timeout: TEST_TIMEOUT_MS }, async t => {
  const reason = new Error('TEST-cancelled-between-blocks');
  const control = sourceReadWorld(t, reviewedLayoutOptions);
  control.node.intercept = answerReviewedLayout;
  await control.transport.observeBinding();
  assert.deepEqual(control.node.calls.map(heightOf), [0, '0', 1, 2], 'the reviewed layout cross-checks string-zero genesis');

  const w = sourceReadWorld(t, reviewedLayoutOptions), stop = cancellation(reason), getContext = w.owner.getContext;
  let blockOneAnswered = false;
  // The first connection read after block one's answer is the block-two read's own.
  w.owner.getContext = () => { if (blockOneAnswered) { blockOneAnswered = false; stop.abort(); } return getContext(); };
  w.node.intercept = row => { if (heightOf(row) === 1) blockOneAnswered = true; return answerReviewedLayout(row); };
  await assert.rejects(w.transport.observeBinding({ signal: stop.signal }), error => error === reason);
  assert.deepEqual(w.node.calls.map(heightOf), [0, '0', 1], 'block two was never requested');
});

test('with a fetch that ignores abort, readRpc and observeBinding aborted mid-flight reject the caller, then release the journal lock and the fence (close() settles, held() is false) and discard the late reply', { timeout: TEST_TIMEOUT_MS }, async t => {
  for (const [name, call] of Object.entries(callers)) {
    const w = sourceReadWorld(t), stalled = deferred(), started = deferred(), reason = new Error(`TEST-abort-ignored-${name}`), stop = cancellation(reason);
    w.node.intercept = () => { started.resolve(); return stalled.promise; };
    const pending = call(w, { signal: stop.signal });
    await started.promise;
    stop.abort();
    await assert.rejects(pending, error => error === reason, `${name} rejects at the abort`);
    await w.transport.close();
    assert.equal(w.owner.held(), false, `${name} still holds the fence`);
    assert.deepEqual(w.journal.inspectLocks(), [], `${name} still holds the journal lock`);
    let lateBodyCancelled = false;
    stalled.resolve(new Response(new ReadableStream({ cancel() { lateBodyCancelled = true; } }), { headers: { 'content-type': 'application/json' } }));
    await flushLateWork();
    assert.equal(lateBodyCancelled, true, `${name} kept the late reply`);
    assert.equal(w.node.calls.length, 1, `${name} started a request after the abort`);
  }
});

test('kill source read while holding its lock and recover without changing a transaction reservation', { timeout: TEST_TIMEOUT_MS }, async t => {
  const w = sourceReadWorld(t);
  const reservationKey = `devnet/native-wallet/${JSON.stringify([TP1_APPROVED_IDENTITY_RECORD.network, CHAIN, `0x${'1'.repeat(64)}`])}`;
  const reservation = { hash: 'a'.repeat(64), nonce: 7, stage: 'broadcast-started' };
  await w.journal.put(reservationKey, reservation);
  const env = { ...process.env, SOURCE_READ_JOURNAL_PATH: w.path };
  delete env.NODE_TEST_CONTEXT;
  const child = fork(CRASH_CHILD, [], { env, execArgv: [] });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve(signal ?? code)));
  t.after(async () => { child.kill('SIGKILL'); await exited; });
  await new Promise(resolve => child.once('message', resolve));
  child.kill('SIGKILL');
  assert.equal(await exited, 'SIGKILL');

  const restarted = openDurableWalletJournal({ path: w.path, mode: 'open' });
  t.after(() => restarted.close());
  const [abandoned, ...others] = restarted.inspectLocks().filter(row => row.key === w.lockKey);
  assert.equal(others.length, 0);
  assert.equal(abandoned.holder, 'exited', 'the killed read left its lock row behind');
  assert.deepEqual(restarted.releaseAbandonedLock({ key: abandoned.key, instance: abandoned.instance, fence: abandoned.fence }), { released: true, recordsChanged: 0 });
  assert.deepEqual(restarted.inspectLocks(), []);
  assert.deepEqual(await restarted.get(reservationKey), reservation, 'the retained transaction record is untouched');
  const afterRestart = sourceReadTransport({ journal: restarted, owner: w.owner });
  t.after(() => afterRestart.close());
  assert.equal((await afterRestart.observeBinding()).chainIdentity, CHAIN, 'later source reads run');
  assert.deepEqual(await restarted.get(reservationKey), reservation);
});

// The wallet nonce lane of the seller's transport: `withWalletNonceLock` holds the
// wallet's native lane lock, the one every native write of that wallet takes on the
// same journal file, while the caller's work runs. Real transports, compositions and
// durable journals over scripted TEST nodes; one test kills a real child. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { bindTp1Profile, TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { agreementRequest, api, finalization, mnemonicBytes, T0, world } from './helpers/tp1-node-fixture.mjs';
import { gateWorld, inPass, sellerPublications } from './helpers/effect-gate-world.mjs';
import { createWorld, JOB_IDS, queuingFenceOwner } from './helpers/native-create-world.mjs';
import { BOUND_PIN_VERSION, writingBoundary } from './helpers/transport-boundary.mjs';
import { installNoEgress } from './helpers/no-egress.mjs';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';
import { buildNativeTransferPayload } from '../src/dacs/wallet-transactions.mjs';
import { nativePayloadDigest } from '../src/wallet/payload-helpers.mjs';
import { createDevnetAgreementTransport, createDevnetDeliveryTransport, createDevnetNativeTransport, createDevnetSettlementTransport,
  DEVNET_DELIVERY_POLICY, DEVNET_SETTLEMENT_POLICY, nativeWalletLaneKey } from '../src/wallet/devnet-native-transport.mjs';

const trap = installNoEgress();
test.after(() => trap.restore());

const CHILD = fileURLToPath(new URL('./helpers/native-lock-order-child.mjs', import.meta.url));
// The lock wait of every transport-level journal here; the compositions open theirs with the journal's default.
const LOCK_TIMEOUT_MS = 300;
const DEFAULT_LOCK_TIMEOUT_MS = 2000;
const PAYEE = `0x${'2'.repeat(64)}`;
const STAGE = (call) => call.extra ?? call.message;

function deferred() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}
const settledTurns = async (count = 5) => { for (let i = 0; i < count; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

function journalFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'wallet-nonce-lane-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'journal.sqlite');
}

/**
 * A demo transport over a durable journal at `path` (opened with `mode`), with every node call's message listed in `calls`.
 * `wrap(journal)` is the journal the transport sees; `answer` and `owner` go to the world.
 */
function transportWorld(t, { path, mode = 'open', lockTimeoutMs = LOCK_TIMEOUT_MS, wrap = (journal) => journal, owner = queuingFenceOwner(), answer }) {
  const journal = openDurableWalletJournal({ path, mode, lockTimeoutMs });
  t.after(() => journal.close());
  const calls = [];
  const seen = wrap(journal);
  const w = createWorld({ journal: seen, owner, answer, boundary: writingBoundary({ owner, journal: seen }), onNode: async (message) => { calls.push(message); } });
  const scope = { owner: w.wallet.address, network: w.capability.pins.network, chainIdentity: w.capability.pins.chainIdentity };
  return { path, journal, calls, world: w, scope, lockRows: () => journal.inspectLocks().filter((lock) => lock.key === w.laneKey) };
}
const newTransportWorld = (t, options = {}) => transportWorld(t, { ...options, path: journalFile(t), mode: 'create' });

// Counts what reached the scripted TP-1 node of a composition.
function nodeCounts(w) {
  const stages = w.node.calls.map((row) => row.body?.params?.[0]).filter(Boolean).map(STAGE);
  return { confirmTx: stages.filter((s) => s === 'confirmTx').length, broadcastTx: stages.filter((s) => s === 'broadcastTx').length,
    getAddressNonce: stages.filter((s) => s === 'getAddressNonce').length };
}

// A buyer composition of the seller world's wallet over a second journal instance on the same file.
async function buyerComposition(t, w) {
  const journal = openDurableWalletJournal({ path: w.path, mode: 'open', lockTimeoutMs: LOCK_TIMEOUT_MS });
  const owner = api.createNodeTransportOwner({ endpoint: 'https://rpc.example.invalid/', transportAuthority: 'vector-authority', fetchImpl: w.node.fetch });
  const binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: owner.currentLocal(), readAuthority: w.authority.read });
  const session = await api.createNodeWalletSession({ admission: { binding, currentLocal: owner.currentLocal }, owner, journal, key: mnemonicBytes(),
    approve: async () => true, clock: w.clock, ...finalization });
  t.after(async () => { await session.close(); await owner.close(); journal.close(); });
  return { session, journal };
}
const sellerWorld = (t) => world(t, { createSession: api.createNodeSellerComposition, sessionOptions: { approveConfirmedWrite: null, publications: sellerPublications() } });
const sellerScope = (w) => ({ owner: w.session.wallet.getPublicAccount().address, network: w.session.transport.pins.network, chainIdentity: w.session.transport.pins.chainIdentity });
const transferRequest = (from, nonce) => ({ method: 'sendTransaction', params: [buildNativeTransferPayload({ from, to: PAYEE, amountOs: '2500000000', nonce, timestamp: T0, encoding: 'os-string' })] });

test("two seller writes of one wallet are serialized on the wallet nonce lane: on one transport the second write's nonce read starts only after the first write's work settles, and a writer on a second journal instance of the same file refuses journal-busy without running while the first holds the lane and is granted after it is released", async (t) => {
  // The first transport waits as long as the composition journals do, so the second write outlasts the other instance's refusal.
  const first = newTransportWorld(t, { lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS });
  const events = [];
  const readNonce = () => first.world.capability.readRpc('/', { method: 'nodeCall', params: [{ message: 'getAddressNonce', data: { address: first.scope.owner } }] });
  const write = (n, gate, reached) => first.world.capability.withWalletNonceLock(first.scope, async () => {
    await readNonce();
    events.push(`${n}:nonce`); reached.open();
    await gate;
    events.push(`${n}:end`);
    return n;
  });
  const gate = deferred(), reached = deferred();
  const one = write(1, gate.promise, reached);
  await reached.promise;
  const two = write(2, Promise.resolve(), deferred());

  const second = transportWorld(t, { path: first.path });
  let secondRan = 0;
  await assert.rejects(second.world.capability.withWalletNonceLock(second.scope, () => { secondRan += 1; }), { code: 'journal-busy' });
  assert.equal(secondRan, 0);
  assert.deepEqual(second.calls, [], 'the refused writer made no node call');
  assert.deepEqual(events, ['1:nonce']);
  assert.equal(first.calls.filter((message) => message === 'getAddressNonce').length, 1, 'one nonce read while the first write was held');

  gate.open();
  assert.deepEqual([await one, await two], [1, 2]);
  assert.deepEqual(events, ['1:nonce', '1:end', '2:nonce', '2:end']);
  assert.equal(await second.world.capability.withWalletNonceLock(second.scope, () => 'granted'), 'granted');
  assert.deepEqual(first.journal.inspectLocks(), []);
});

test("a buyer composition and a seller composition of one wallet on one journal file share one wallet nonce lane: while the seller holds it the buyer's native transfer refuses journal-busy with no confirmation or broadcast and goes out once after release, and while the buyer's broadcast holds it the seller's nonce lane refuses journal-busy and its work never runs", async (t) => {
  const w = await sellerWorld(t), buyer = await buyerComposition(t, w);
  const address = buyer.session.wallet.getPublicAccount().address, scope = sellerScope(w);
  assert.equal(address, scope.owner);

  const gate = deferred(), entered = deferred();
  const held = w.session.transport.withWalletNonceLock(scope, async () => { entered.open(); await gate.promise; return 'seller'; });
  await entered.promise;
  const refused = await buyer.session.wallet.request(transferRequest(address, 1));
  assert.deepEqual({ success: refused.success, code: refused.error?.code }, { success: false, code: 'journal-busy' });
  const { confirmTx, broadcastTx } = nodeCounts(w);
  assert.deepEqual({ confirmTx, broadcastTx }, { confirmTx: 0, broadcastTx: 0 });
  assert.equal(await w.lane(), undefined, 'no lane record was written');
  gate.open();
  assert.equal(await held, 'seller');

  const sent = await buyer.session.wallet.request(transferRequest(address, 1));
  assert.equal(sent.success, true, JSON.stringify(sent));
  assert.equal(w.node.broadcasts.length, 1, 'the transfer went out once after release');
  const laneRecord = (await buyer.journal.entries()).find(([key]) => key.startsWith('devnet/native-wallet/'));
  assert.equal(laneRecord[0], nativeWalletLaneKey(w.session.transport.pins, address));

  assert.equal((await buyer.session.transport.binding({ phase: 'readback', address, hash: sent.data.hash })).disposition, 'included');
  const atBroadcast = deferred(), resume = deferred();
  w.node.intercept = async (row) => {
    if (row.body?.params?.[0]?.extra !== 'broadcastTx') return undefined;
    atBroadcast.open(); await resume.promise;
    return undefined;
  };
  const second = buyer.session.wallet.request(transferRequest(address, 2));
  await atBroadcast.promise;
  let sellerRan = 0;
  await assert.rejects(w.session.transport.withWalletNonceLock(scope, () => { sellerRan += 1; }), { code: 'journal-busy' });
  assert.equal(sellerRan, 0);
  resume.open();
  assert.equal((await second).success, true);
  assert.equal(w.node.broadcasts.length, 2);
});

test("the wallet nonce lane refuses before its work runs and before anything is signed: journal-busy while another holder keeps the lane, runtime_unsupported on an unsupported Node version, profile_not_admitted with the reader's error as cause when the connection-authority read fails, transport_closed after close, invalid_params for another network, chain identity or address and for a malformed scope including an extra string or symbol key, nonce_lane_unavailable over a journal without owned lanes, nonce_lane_order inside an effect pass and journal-reentrant when nested; with the lane free the same work confirms and broadcasts a seller CREATE once with one transaction signature", async (t) => {
  const w = await gateWorld(t), facade = w.session.transport, scope = sellerScope(w);
  const laneKey = nativeWalletLaneKey(facade.pins, scope.owner);
  let ran = 0;
  const create = () => { ran += 1; return inPass(w, async () => w.session.wallet.request(await agreementRequest(w))); };
  const snapshot = async () => ({ signs: w.signsInsideSign, node: nodeCounts(w), entries: await w.journal().entries() });
  const laneRows = () => w.journal().inspectLocks().filter((lock) => lock.key === laneKey);
  async function refusedBeforeWork(call, expected, rows = []) {
    const before = await snapshot();
    ran = 0;
    await assert.rejects(call(), expected);
    assert.equal(ran, 0, 'the work never ran');
    assert.deepEqual(await snapshot(), before, 'nothing signed, read or sent, and no journal entry');
    assert.deepEqual(laneRows().map((lock) => lock.instance), rows);
  }

  const other = openDurableWalletJournal({ path: w.path, mode: 'open' });
  const release = deferred(), entered = deferred();
  const otherHold = other.withWalletLock(laneKey, () => { entered.open(); return release.promise; });
  await entered.promise;
  await refusedBeforeWork(() => facade.withWalletNonceLock(scope, create), { code: 'journal-busy' }, [other.instance]);
  release.open(); await otherHold; other.close();

  const original = Object.getOwnPropertyDescriptor(process, 'version');
  const authorityCalls = w.authority.state.calls;
  try {
    Object.defineProperty(process, 'version', { value: 'v22.12.0', configurable: true });
    await refusedBeforeWork(() => facade.withWalletNonceLock(scope, create), { code: 'runtime_unsupported' });
  } finally { Object.defineProperty(process, 'version', original); }
  assert.equal(w.authority.state.calls, authorityCalls, 'the runtime check comes before the authority read');

  const failure = Object.assign(new Error('TEST-authority-down'), { code: 'TEST-authority-down' });
  w.authority.state.failure = failure;
  try {
    await refusedBeforeWork(() => facade.withWalletNonceLock(scope, create), (error) => error.code === 'profile_not_admitted' && error.cause === failure);
  } finally { w.authority.state.failure = null; }
  assert.equal(w.authority.state.calls, authorityCalls + 1, 'exactly one connection-authority read');

  const closedWorld = await sellerWorld(t), closedScope = sellerScope(closedWorld);
  await closedWorld.session.close();
  ran = 0;
  await assert.rejects(closedWorld.session.transport.withWalletNonceLock(closedScope, create), { code: 'transport_closed' });
  assert.equal(ran, 0);

  const symbolKey = Symbol('TEST');
  const hidden = Object.defineProperty({ ...scope }, 'TEST', { value: 1, enumerable: false });
  for (const [label, badScope, work] of [['another network', { ...scope, network: 'TEST-other' }, create], ['another chain identity', { ...scope, chainIdentity: 'd'.repeat(64) }, create],
    ['not a native address', { ...scope, owner: 'TEST-not-an-address' }, create], ['a missing key', { owner: scope.owner, network: scope.network }, create],
    ['an extra string key', { ...scope, TEST: 1 }, create], ['an extra symbol key', { ...scope, [symbolKey]: 1 }, create], ['an extra non-enumerable key', hidden, create],
    ['null', null, create], ['work that is not a function', scope, 'TEST']]) {
    await refusedBeforeWork(() => facade.withWalletNonceLock(badScope, work), (error) => error.code === 'invalid_params' || assert.fail(`${label}: ${error.code}`));
  }

  const fourMethods = newTransportWorld(t, { wrap: (journal) => ({ get: (key) => journal.get(key), put: (key, value) => journal.put(key, value), entries: () => journal.entries(),
    withWalletLock: (key, work) => journal.withWalletLock(key, work) }) });
  ran = 0;
  await assert.rejects(fourMethods.world.capability.withWalletNonceLock(fourMethods.scope, create), { code: 'nonce_lane_unavailable' });
  assert.equal(ran, 0);
  assert.deepEqual(fourMethods.calls, []);
  assert.deepEqual(fourMethods.lockRows(), []);

  await refusedBeforeWork(() => inPass(w, () => facade.withWalletNonceLock(scope, create)), { code: 'nonce_lane_order' });

  const outer = await facade.withWalletNonceLock(scope, async () => {
    await refusedBeforeWork(() => facade.withWalletNonceLock(scope, create), { code: 'journal-reentrant' }, laneRows().map((lock) => lock.instance));
    return 'outer';
  });
  assert.equal(outer, 'outer');
  assert.deepEqual(laneRows(), []);

  const before = await snapshot();
  ran = 0;
  const answer = await facade.withWalletNonceLock(scope, create);
  assert.equal(answer.success, true, JSON.stringify(answer));
  assert.equal(ran, 1);
  const after = await snapshot();
  assert.deepEqual({ confirmTx: after.node.confirmTx - before.node.confirmTx, broadcastTx: after.node.broadcastTx - before.node.broadcastTx, signs: after.signs - before.signs },
    { confirmTx: 1, broadcastTx: 1, signs: 1 });
  assert.deepEqual(laneRows(), []);
});

test("the wallet nonce lane is released on every outcome: after work that throws, rejects mid-write, meets a refused broadcast or meets a transport close, the lane has no lock row and a new holder is granted at once, each caller seeing the work's own error; a hold removed while the work runs refuses journal-fenced and nothing is broadcast after the loss", async (t) => {
  const grantedAtOnce = async (lane) => {
    assert.deepEqual(lane.lockRows(), []);
    assert.equal(await lane.world.capability.withWalletNonceLock(lane.scope, () => 'next'), 'next');
  };
  const thrown = Object.assign(new Error('TEST-work-threw'), { code: 'TEST-work-threw' });
  const sync = newTransportWorld(t);
  await assert.rejects(sync.world.capability.withWalletNonceLock(sync.scope, () => { throw thrown; }), (error) => error === thrown);
  await grantedAtOnce(sync);

  const midWrite = newTransportWorld(t), rejected = Object.assign(new Error('TEST-work-rejected'), { code: 'TEST-work-rejected' });
  const create = await midWrite.world.makeCreate(JOB_IDS[0], 1);
  let lease;
  await assert.rejects(midWrite.world.capability.withWalletNonceLock(midWrite.scope, async () => {
    lease = await midWrite.world.lease();
    await midWrite.world.confirm(create);
    throw rejected;
  }), (error) => error === rejected);
  await midWrite.world.release(lease);
  assert.deepEqual(midWrite.world.sent, { confirms: [create.hash], broadcasts: [] });
  await grantedAtOnce(midWrite);

  const refusing = newTransportWorld(t, { answer: (message) => (message === 'broadcastTx' ? { result: 400, response: 'TEST-refused', require_reply: false, extra: null } : undefined) });
  const refusedCreate = await refusing.world.makeCreate(JOB_IDS[0], 1);
  const refusal = Object.assign(new Error('TEST-broadcast-refused'), { code: 'TEST-broadcast-refused' });
  await assert.rejects(refusing.world.capability.withWalletNonceLock(refusing.scope, async () => {
    const leased = await refusing.world.lease();
    try {
      const answer = await refusing.world.broadcast(leased, await refusing.world.confirm(refusedCreate), refusedCreate.hash);
      assert.equal(answer.result, 400, 'the node refused the broadcast');
      throw refusal;
    } finally { await refusing.world.release(leased).catch(() => {}); }
  }), (error) => error === refusal);
  assert.deepEqual(refusing.world.sent.confirms, [refusedCreate.hash]);
  await grantedAtOnce(refusing);

  const closing = newTransportWorld(t), gate = deferred(), entered = deferred();
  let closeResolved = false;
  const held = closing.world.capability.withWalletNonceLock(closing.scope, async () => { entered.open(); await gate.promise; return closing.world.readback('a'.repeat(64)); });
  await entered.promise;
  const closed = closing.world.capability.close().then(() => { closeResolved = true; assert.deepEqual(closing.lockRows(), [], 'the lane row was gone when close() resolved'); });
  await settledTurns();
  assert.equal(closeResolved, false, 'close() waits for the lane holder');
  gate.open();
  await assert.rejects(held, { code: 'transport_closed' });
  await closed;
  const reopened = transportWorld(t, { path: closing.path });
  await grantedAtOnce(reopened);

  const removed = newTransportWorld(t), removedCreate = await removed.world.makeCreate(JOB_IDS[0], 1);
  const remover = openDurableWalletJournal({ path: removed.path, mode: 'open' });
  t.after(() => remover.close());
  let leaseOfRemoved;
  await assert.rejects(removed.world.capability.withWalletNonceLock(removed.scope, async () => {
    leaseOfRemoved = await removed.world.lease();
    const confirmation = await removed.world.confirm(removedCreate);
    const [row] = removed.lockRows();
    remover.releaseAbandonedLock({ key: row.key, instance: row.instance, fence: row.fence });
    return removed.world.broadcast(leaseOfRemoved, confirmation, removedCreate.hash);
  }), { code: 'journal-fenced' });
  await removed.world.release(leaseOfRemoved).catch(() => {});
  assert.deepEqual(removed.world.sent, { confirms: [removedCreate.hash], broadcasts: [] }, 'the confirmation made before the loss stands; nothing was broadcast after it');
});

// The journal with each real acquisition of `laneKey` counted: a take inside a frame that already holds it continues there.
function countingLaneTakes(journal, laneKey) {
  const holding = new AsyncLocalStorage();
  const counted = { acquisitions: 0 };
  const take = (method) => (key, work) => {
    if (key !== laneKey) return journal[method](key, work);
    if (method === 'withOwnedOrAcquiredLane' && holding.getStore()) return journal.withOwnedOrAcquiredLane(key, work);
    counted.acquisitions += 1;
    return journal[method](key, () => holding.run(true, work));
  };
  return { counted, get: (key) => journal.get(key), put: (key, value) => journal.put(key, value), entries: () => journal.entries(),
    appendUnderLock: (...args) => journal.appendUnderLock(...args), withWalletLock: take('withWalletLock'), withOwnedOrAcquiredLane: take('withOwnedOrAcquiredLane') };
}

test("inside the wallet nonce lane the transport's own confirmation, broadcast, readback and CREATE recovery of that wallet continue in the held lane: the same CREATE sequence makes one lane acquisition and no journal-reentrant inside it, and the same confirmations, broadcasts and lane records as outside any nonce lane", async (t) => {
  const run = async (insideLane) => {
    let counting;
    const lane = newTransportWorld(t, { wrap: (journal) => (counting = countingLaneTakes(journal, createWorld({ journal }).laneKey)) });
    const create = await lane.world.makeCreate(JOB_IDS[0], 1);
    const sequence = async () => {
      const lease = await lane.world.lease();
      await lane.world.broadcast(lease, await lane.world.confirm(create), create.hash);
      const readback = await lane.world.readback(create.hash);
      await lane.world.release(lease).catch(() => {});
      const recovered = await lane.world.recover(create);
      return { readback, recovered };
    };
    const outcome = insideLane ? await lane.world.capability.withWalletNonceLock(lane.scope, sequence) : await sequence();
    return { outcome, acquisitions: counting.counted.acquisitions, sent: lane.world.sent, stage: (await lane.journal.get(lane.world.laneKey)).stage, locks: lane.journal.inspectLocks() };
  };
  const inside = await run(true), outside = await run(false);
  assert.equal(inside.acquisitions, 1, 'only the nonce lane itself acquired the lane');
  assert.ok(outside.acquisitions >= 3, `outside a nonce lane each step acquires it (${outside.acquisitions})`);
  assert.deepEqual(inside.outcome, outside.outcome);
  assert.deepEqual({ confirms: inside.sent.confirms.length, broadcasts: inside.sent.broadcasts.length }, { confirms: 2, broadcasts: 2 });
  assert.deepEqual(inside.sent, outside.sent);
  assert.equal(inside.stage, outside.stage);
  assert.deepEqual([inside.locks, outside.locks], [[], []]);
});

test('the wallet nonce lane refuses journal-closed over a closed journal and journal-integrity over a lane record changed outside the journal, before its work runs, and a call that waited for the lane while the transport closed refuses transport_closed once it acquires, releasing the lane before close resolves', async (t) => {
  let ran = 0;
  const work = () => { ran += 1; };

  const closedJournal = newTransportWorld(t);
  closedJournal.journal.close();
  await assert.rejects(closedJournal.world.capability.withWalletNonceLock(closedJournal.scope, work), { code: 'journal-closed' });
  assert.equal(ran, 0);
  assert.deepEqual(closedJournal.calls, []);

  const tampered = newTransportWorld(t);
  await tampered.world.retain(await tampered.world.makeCreate(JOB_IDS[0], 1), 'broadcast-accepted');
  const callsBefore = tampered.calls.length;
  const db = new DatabaseSync(tampered.path);
  db.prepare('UPDATE records SET value = ? WHERE key = ?').run(JSON.stringify({ stage: 'TEST-rewritten' }), tampered.world.laneKey);
  db.close();
  await assert.rejects(tampered.world.capability.withWalletNonceLock(tampered.scope, work), { code: 'journal-integrity' });
  assert.equal(ran, 0);
  assert.equal(tampered.calls.length, callsBefore);
  assert.deepEqual(tampered.lockRows(), []);

  const waiting = newTransportWorld(t), other = openDurableWalletJournal({ path: waiting.path, mode: 'open' });
  t.after(() => other.close());
  const release = deferred(), entered = deferred();
  const otherHold = other.withWalletLock(waiting.world.laneKey, () => { entered.open(); return release.promise; });
  await entered.promise;
  const call = waiting.world.capability.withWalletNonceLock(waiting.scope, work);
  await settledTurns();
  let callSettled = false;
  void call.then(() => { callSettled = true; }, () => { callSettled = true; });
  const closed = waiting.world.capability.close().then(() => { assert.equal(callSettled, true, 'close() waited for the call'); });
  release.open();
  await otherHold;
  await assert.rejects(call, { code: 'transport_closed' });
  await closed;
  assert.equal(ran, 0);
  assert.deepEqual(waiting.calls, []);
  assert.deepEqual(waiting.lockRows(), []);
});

// The world's wallet signs a native transfer at `nonce`, as a buyer's wallet completes one.
function signedTransfer(w, payload, nonce) {
  const address = w.wallet.address, content = structuredClone(payload.content);
  const edit = (type, operation, account, amount) => ({ type, operation, isRollback: false, account, txhash: '', amount });
  Object.assign(content, { from: address, from_ed25519_address: address, nonce, transaction_fee: { network_fee: '1000000000', rpc_fee: '1000000000', additional_fee: '0', rpc_address: null },
    gcr_edits: [edit('balance', 'remove', address, content.amount), edit('balance', 'add', content.to, content.amount), edit('balance', 'remove', address, '1000000000'), edit('nonce', 'add', address, 1)] });
  const hash = createHash('sha256').update(JSON.stringify(content)).digest('hex');
  return { content, signature: { type: 'ed25519', data: w.wallet.signText(hash) }, hash, status: '', blockNumber: null };
}

test("inside the wallet nonce lane, a native-transfer lease that names its transfer, a native transfer's confirmation claim and a cancellation of that wallet's transfer each refuse journal-reentrant before anything is sent, and the outer hold continues", async (t) => {
  const lane = newTransportWorld(t), { capability, wallet } = lane.world, address = wallet.address;
  const payload = buildNativeTransferPayload({ from: address, to: PAYEE, amountOs: '2500000000', nonce: 1, timestamp: T0, encoding: 'os-string' });
  const transfer = { nonce: 1, to: PAYEE, amountOs: '2500000000', payloadDigest: await nativePayloadDigest(payload.content) };
  const { binding } = await capability.binding({ phase: 'bind', address });

  const leased = await capability.withWalletNonceLock(lane.scope, async () => {
    await assert.rejects(capability.binding({ phase: 'signature', address, binding, transfer }), { code: 'journal-reentrant' });
    return 'outer';
  });
  assert.equal(leased, 'outer');
  assert.equal(lane.world.owner.isHeld(), false, 'the refused lease released the owner\'s fence');

  const lease = await capability.binding({ phase: 'signature', address, binding });
  const confirmed = await capability.withWalletNonceLock(lane.scope, async () => {
    await assert.rejects(lane.world.confirm(signedTransfer(lane.world, payload, 1)), { code: 'journal-reentrant' });
    return 'outer';
  });
  assert.equal(confirmed, 'outer');
  await lane.world.release(lease);

  let unissued = 0;
  const cancelled = await capability.withWalletNonceLock(lane.scope, async () => {
    await assert.rejects(capability.cancelNativeTransfer({ address, operationId: 'TEST-op', payload, unissued: async () => { unissued += 1; return true; } }), { code: 'journal-reentrant' });
    return 'outer';
  });
  assert.equal(cancelled, 'outer');
  assert.equal(unissued, 0);
  assert.equal(await capability.nativeTransferCancelled(address, payload), false, 'no cancellation record');
  assert.deepEqual(lane.world.sent, { confirms: [], broadcasts: [] });
  assert.deepEqual(lane.journal.inspectLocks(), []);
});

test("while one context holds the wallet nonce lane, a readback, a CREATE recovery and a leased broadcast of that wallet in another context each refuse journal-busy within the journal's lock timeout, release the connection fence and send nothing, and each is granted after the lane is released", async (t) => {
  const outsideLane = AsyncLocalStorage.snapshot();
  // Context A: the nonce lane held with its work waiting; the returned function lets it end.
  const holdLane = async (lane) => {
    const gate = deferred(), entered = deferred();
    const held = lane.world.capability.withWalletNonceLock(lane.scope, () => { entered.open(); return gate.promise; });
    await entered.promise;
    return async () => { gate.open(); await held; };
  };
  // Context B: `call` refuses journal-busy after the lock wait, writes no record and sends nothing.
  async function refusedBusy(lane, label, call) {
    const entries = await lane.journal.entries(), fencesBefore = lane.events.length, started = performance.now();
    await assert.rejects(outsideLane(call), { code: 'journal-busy' }, label);
    const waited = performance.now() - started;
    assert.ok(waited >= LOCK_TIMEOUT_MS && waited < DEFAULT_LOCK_TIMEOUT_MS, `${label} waited ${waited} ms`);
    assert.deepEqual(await lane.journal.entries(), entries, `${label} wrote no lane or intent record`);
    assert.deepEqual(lane.world.sent.broadcasts, [], `${label} sent nothing`);
    return lane.events.length - fencesBefore;
  }
  const fencedWorld = () => { const events = []; return { ...newTransportWorld(t, { owner: queuingFenceOwner(events) }), events }; };

  const reads = fencedWorld(), retained = await reads.world.makeCreate(JOB_IDS[0], 1);
  await reads.world.retain(retained, 'broadcast-accepted', { signed: true });
  let releaseLane = await holdLane(reads);
  for (const [label, call] of [['readback', () => reads.world.readback(retained.hash)], ['recovery', () => reads.world.recover(retained)]]) {
    assert.equal(await refusedBusy(reads, label, call), 1, `${label} took the connection fence once`);
    assert.equal(reads.world.owner.isHeld(), false, `${label} released the connection fence`);
  }
  await releaseLane();
  assert.equal((await reads.world.readback(retained.hash)).hash, retained.hash, 'the readback is granted once the lane is free');
  assert.equal((await reads.world.recover(retained)).hash, retained.hash, 'the recovery is granted once the lane is free');

  const leased = fencedWorld(), pending = await leased.world.makeCreate(JOB_IDS[1], 2);
  const lease = await leased.world.lease(), confirmation = await leased.world.confirm(pending);
  releaseLane = await holdLane(leased);
  assert.equal(await refusedBusy(leased, 'leased broadcast', () => leased.world.broadcast(lease, confirmation, pending.hash)), 0, 'the broadcast runs on its lease\'s fence');
  assert.equal(leased.world.owner.isHeld(), false, 'the refused broadcast ended its lease and released the connection fence');
  await releaseLane();
  const again = await leased.world.lease();
  const answer = await leased.world.broadcast(again, await leased.world.confirm(pending), pending.hash);
  assert.equal(answer.result, 200, 'a new lease\'s broadcast of the same bytes is granted once the lane is free');
  assert.deepEqual(leased.world.sent.broadcasts, [pending.hash]);
  await leased.world.release(again).catch(() => {});
  assert.deepEqual([reads.journal.inspectLocks(), leased.journal.inspectLocks()], [[], []]);
});

test("only the demo transport and its held facade carry withWalletNonceLock: the native, agreement, settlement and delivery transports and the buyer composition's facade have no such member, with no node call", async (t) => {
  const journal = openDurableWalletJournal({ path: journalFile(t), mode: 'create' });
  t.after(() => journal.close());
  let nodeCalls = 0;
  const owner = queuingFenceOwner(), pins = { network: 'testnet', chainIdentity: 'c'.repeat(64), pinVersion: BOUND_PIN_VERSION, endpoint: 'https://rpc.invalid/', transportAuthority: 'TEST-lock-order-owner' };
  const base = { expected: pins, transportOwner: owner, boundary: writingBoundary({ owner, journal }), journal, fetchImpl: async () => { nodeCalls += 1; throw new Error('TEST-no-node'); } };
  const settlementPublication = { artifactKind: 'SettlementEvidence', authority: 'TEST-lane-settlement', phase: 'pay-dem', phaseIndex: 2, policy: DEVNET_SETTLEMENT_POLICY, railId: 'demos-native:DEM' };
  const deliveryPublication = { artifactKind: 'Deliverable', authority: 'TEST-lane-delivery', phase: 'deliver-storage-program', phaseIndex: 3, policy: DEVNET_DELIVERY_POLICY };
  const w = await sellerWorld(t), buyer = await buyerComposition(t, w);
  for (const [name, capability] of [['native', createDevnetNativeTransport(base)], ['agreement', createDevnetAgreementTransport(base)],
    ['settlement', createDevnetSettlementTransport({ ...base, settlementPublication })], ['delivery', createDevnetDeliveryTransport({ ...base, settlementPublication, deliveryPublication })],
    ['buyer facade', buyer.session.transport]]) {
    assert.equal('withWalletNonceLock' in capability, false, name);
  }
  assert.equal(typeof createWorld({ journal }).capability.withWalletNonceLock, 'function');
  assert.equal(typeof w.session.transport.withWalletNonceLock, 'function');
  assert.equal(nodeCalls, 0);
  assert.equal(w.node.calls.length, 0);
});

test('a process killed while it holds only the wallet nonce lane leaves its lock row as exited; the next withWalletNonceLock reclaims it and is granted, with no lane record written and nothing sent', async (t) => {
  const lane = newTransportWorld(t);
  const env = { ...process.env, DACS_LOCK_ORDER_JOURNAL: lane.path, DACS_LOCK_ORDER_SCENARIO: 'nonce-lane' };
  delete env.NODE_TEST_CONTEXT;
  const child = fork(CHILD, [], { env, execArgv: [] });
  t.after(() => child.kill('SIGKILL'));
  const reports = [];
  child.on('message', (message) => reports.push(message));
  const signal = await new Promise((resolve) => child.once('exit', (code, sig) => resolve(sig ?? code)));
  assert.equal(signal, 'SIGKILL');
  assert.deepEqual(reports, [{ event: 'in-nonce-lane' }]);
  assert.deepEqual(lane.journal.inspectLocks().map((lock) => [lock.key, lock.holder]), [[lane.world.laneKey, 'exited']]);
  assert.equal(await lane.journal.get(lane.world.laneKey), undefined);
  assert.equal(await lane.world.capability.withWalletNonceLock(lane.scope, () => 'next'), 'next');
  assert.deepEqual(lane.journal.inspectLocks(), []);
  assert.deepEqual(lane.world.sent, { confirms: [], broadcasts: [] });
});

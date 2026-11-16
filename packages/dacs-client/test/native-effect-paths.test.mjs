// The native transport keys and compares its lane on one canonical chain identity, a lane
// stamped by another pin version stays readback-only, and with an effect boundary the
// signature lease holds the boundary's fence while confirmation runs as its own recorded
// stage. Broadcast, recovery confirmation and the recovery resend are stages of the same
// history, and each effectful request makes its last checks inside the transport's
// transmit step. The real transport, effect boundary and durable journal run in this process
// against a scripted TEST node; a TEST key signs the transactions. No network, chain or funds.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setPurchaseAdmission, flush, cutAppend } from './helpers/effect-boundary-fixture.mjs';
import { JOB_IDS, queuingFenceOwner } from './helpers/native-create-world.mjs';
import { guardedCreateWorld } from './helpers/native-guarded-create-world.mjs';
import { CHAIN, LANE_PREFIX, pinsFor, nativeWorld as world, walletKey } from './helpers/native-effect-world.mjs';
import { underPass } from './helpers/pass-context-fixture.mjs';
import { createDevnetNativeTransport, nativeWalletLaneKey } from '../src/wallet/devnet-native-transport.mjs';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';
import { currentPassContext, passContext, runInPassContext } from '../src/wallet/pass-context.mjs';

test('lower-case chain identities, with or without 0x, canonicalise once; upper-case or padded identities refuse at the observation boundary, with their cause; stored signed bytes are never normalized and retired lanes are never re-keyed', async (t) => {
  const keys = [];
  for (const spelling of [CHAIN, '0x' + CHAIN]) {
    const w = world(t);
    w.open(pinsFor(spelling));
    const signed = await w.send(1);
    const lanes = await w.lanes();
    assert.deepEqual(lanes.map(([key]) => key), [nativeWalletLaneKey(pinsFor(CHAIN), w.address)], `lane key for ${spelling.slice(0, 4)}`);
    keys.push(lanes[0][0].replace(w.address, ''));
    assert.equal(lanes[0][1].networkBinding.chainIdentity, CHAIN);
    assert.equal(JSON.stringify(lanes[0][1].signedTransaction), JSON.stringify(signed), 'signed bytes are stored as signed');
    const read = await w.transport().binding({ phase:'readback', address:w.address, hash:signed.hash });
    assert.equal(read.disposition, 'included', `readback of ${spelling.slice(0, 4)} pins`);
    assert.equal(nativeWalletLaneKey(pinsFor('0x' + CHAIN), w.address), nativeWalletLaneKey(pinsFor(CHAIN), w.address));
  }
  assert.equal(keys[0], keys[1], 'both spellings key one lane');
  for (const bad of [CHAIN.toUpperCase(), ` ${CHAIN}`, `${CHAIN} `, '0X' + CHAIN, '0x0x' + CHAIN, CHAIN.slice(1)]) {
    const w = world(t);
    assert.throws(() => w.open(pinsFor(bad)), { name:'NetworkBindingError', code:'unpinned_network' }, JSON.stringify(bad));
    assert.equal(w.node.confirms + w.node.broadcasts.length, 0);
  }
  // A lane an earlier spelling stored under its own key is neither read nor rewritten.
  const w = world(t), earlierKey = `${LANE_PREFIX}${JSON.stringify(['testnet', '0x' + CHAIN, w.address])}`;
  const earlier = { stage:'broadcast-accepted', hash:'e'.repeat(64), nonce:1, signedTransaction:{ content:{ from:w.address } }, networkBinding:{ network:'testnet', chainIdentity:'0x' + CHAIN } };
  await w.journal().put(earlierKey, earlier);
  w.open(pinsFor('0x' + CHAIN));
  await w.send(1);
  assert.deepEqual(await w.journal().get(earlierKey), earlier);
  assert.deepEqual((await w.lanes()).map(([key]) => key).sort(), [earlierKey, nativeWalletLaneKey(pinsFor(CHAIN), w.address)].sort());
});

test('a native lane stamped with the revision-1 pin version after restart is readback-only, never resent or re-keyed', async (t) => {
  const w = world(t), revision1 = pinsFor(CHAIN, 'TEST-native-pins-r1'), revision2 = pinsFor(CHAIN, 'TEST-native-pins-r2');
  const laneKey = nativeWalletLaneKey(revision1, w.address);
  w.open(revision1);
  const first = await w.send(1);
  const retained = await w.journal().get(laneKey);
  assert.equal(retained.networkBinding.pinVersion, 'TEST-native-pins-r1');

  await w.restart(revision2);
  await assert.rejects(w.lease(), { code:'pin_version_retired' });
  assert.deepEqual(await w.journal().get(laneKey), retained, 'the lane keeps its key and bytes');
  assert.deepEqual([w.node.confirms, w.node.broadcasts], [1, [first.hash]], 'nothing is resent');

  // The binder refuses the saved binding of another version, so a read-back changes nothing either.
  await assert.rejects(w.transport().binding({ phase:'readback', address:w.address, hash:first.hash }), { code:'binding_mismatch' });
  assert.deepEqual(await w.journal().get(laneKey), retained);
  assert.deepEqual((await w.lanes()).map(([key]) => key), [laneKey]);

  // A retained transfer that is already read back holds nothing unread, so a stamp of another version does not refuse.
  await w.journal().put(laneKey, { ...retained, stage:'observed' });
  const { leaseId } = await w.lease();

  // An intent or lane that appears stamped with the retired version while the lease is held refuses confirmation and broadcast.
  const second = w.sign(2);
  await w.journal().put(`devnet/native-transfer/${second.hash}`, { ...retained, hash:second.hash, nonce:2, stage:'broadcast-started' });
  await assert.rejects(w.confirm(second), { code:'pin_version_retired' });
  const third = w.sign(3), confirmed = await w.confirm(third);
  await w.transport().binding({ phase:'broadcast', address:w.address, leaseId, hash:third.hash });
  await w.journal().put(laneKey, { ...retained, hash:'d'.repeat(64), nonce:2, stage:'broadcast-started' });
  await assert.rejects(w.broadcast(confirmed), { code:'pin_version_retired' });
  assert.deepEqual([w.node.confirms, w.node.broadcasts], [2, [first.hash]], 'no confirmation of the retired intent and no second broadcast');
});

test('a malformed boundary is a TypeError at construction', (t) => {
  const w = world(t);
  const build = (boundary) => () => createDevnetNativeTransport({ expected:pinsFor(CHAIN), journal:w.journal(), transportOwner:w.owner, fetchImpl:w.node.fetch, boundary });
  for (const boundary of [null, {}, 'boundary', { holdFence() {}, signPass() {} }]) assert.throws(build(boundary), TypeError, JSON.stringify(boundary));
});

test("the transport owner's connection fence is the effect boundary's fence: one acquisition per lease within 10,000 ms, released on every exception", async (t) => {
  const w = world(t), g = await w.openGuarded(), binding = await w.bind();
  assert.deepEqual([w.owner.acquired, w.owner.released], [1, 1], 'the bind read takes and frees its own fence');
  const { leaseId } = await w.lease(binding), signed = w.sign(1), confirmed = await w.confirm(signed);
  assert.deepEqual([w.owner.acquired, w.owner.released], [2, 1], 'the lease and its confirmation share one acquisition');
  await w.transport().binding({ phase:'broadcast', address:w.address, leaseId, hash:signed.hash });
  await w.broadcast(confirmed);
  assert.deepEqual([w.owner.acquired, w.owner.released], [2, 2], 'the end of the broadcast releases it');

  // A fence that is not granted within 10,000 ms refuses with its own cause, and a late grant is released.
  const slow = world(t), slowGuard = await slow.openGuarded(), slowBinding = await slow.bind();
  let admit, settled = false;
  slow.owner.gate = () => new Promise((resolve) => { admit = resolve; });
  const refused = assert.rejects(slow.lease(slowBinding), { code:'tp1_fence_timeout' }).then(() => { settled = true; });
  while (slow.owner.acquired < 2) await flush();
  slowGuard.clock.advance(9_999);
  await flush();
  assert.equal(settled, false, 'still waiting at 9,999 ms');
  slowGuard.clock.advance(1);
  await refused;
  await assert.rejects(slow.transport().binding({ phase:'broadcast', address:slow.address, leaseId:'0'.repeat(32), hash:signed.hash }), { code:'network_binding_required' });
  admit();
  await flush();
  assert.equal(slow.owner.released, slow.owner.acquired, 'the late acquisition is released');

  // A refusal after the fence is held releases it.
  const failing = world(t), failingGuard = await failing.openGuarded(), failingBinding = await failing.bind();
  failing.owner.gate = async () => {
    failing.owner.gate = null;
    await failing.journal().put(nativeWalletLaneKey(pinsFor(CHAIN), failing.address), { stage:'broadcast-started', hash:'a'.repeat(64), nonce:1, signedTransaction:{ content:{ from:failing.address } }, networkBinding:{ pinVersion:failingGuard.pinVersion } });
  };
  await assert.rejects(failing.lease(failingBinding), { code:'outcome_unknown' });
  assert.equal(failing.owner.released, failing.owner.acquired, 'an exception after acquisition releases the fence');

  // A stop or a closed admission refuses before the fence is taken.
  const refusing = world(t), refusingGuard = await refusing.openGuarded(), refusingBinding = await refusing.bind(), taken = refusing.owner.acquired;
  refusingGuard.state.stopped = true;
  await assert.rejects(refusing.lease(refusingBinding), { code:'writes_stopped' });
  refusingGuard.state.stopped = false;
  setPurchaseAdmission('held');
  await assert.rejects(refusing.lease(refusingBinding), { code:'profile_not_admitted' });
  assert.equal(refusing.owner.acquired, taken, 'no fence was taken');
  assert.equal(g.fence.connectionGeneration, 0);
});

test('a reconnect that goes around the fence while the signer is awaited leaves signed-held; a fenced replacement waits', async (t) => {
  const w = world(t, { exclusive:true }), g = await w.openGuarded(), { leaseId } = await w.lease(), replaced = [];
  const replacement = g.boundary.replaceConnection(() => { replaced.push('replaced'); });
  await flush();
  assert.deepEqual(replaced, [], 'the replacement waits for the lease that holds the fence');

  // The connection changes without taking the fence while the retained signature is being written.
  cutAppend({ history:g.history }, 'signed', { mutate:() => { g.bound.liveLocal().connectionId = 'TEST-unfenced-connection'; } });
  const signed = w.sign(1);
  await assert.rejects(w.confirm(signed), { code:'tp1_local_binding_changed' });
  assert.deepEqual(await w.historyStates(), ['p1/signed', 'p1/signed-held']);
  assert.equal((await w.historyRecords())[1].cause.code, 'tp1_local_binding_changed');
  assert.equal(w.node.confirms, 0, 'nothing reached the node');
  assert.deepEqual(replaced, [], 'the refused confirmation does not release the fence');

  await w.transport().binding({ phase:'release', address:w.address, leaseId });
  await replacement;
  assert.deepEqual(replaced, ['replaced'], 'the replacement runs once the lease releases the fence');
  assert.equal(g.fence.connectionGeneration, 1);
});

test('two purchases on one buyer connection when its fence changes: neither signs under the old generation', async (t) => {
  const w = world(t, { exclusive:true }), g = await w.openGuarded(), second = walletKey();
  const firstBinding = await w.bind(), secondBinding = (await w.transport().binding({ phase:'bind', address:second.address })).binding;
  const first = await w.lease(firstBinding);
  const replacement = g.boundary.replaceConnection(() => { g.bound.liveLocal().connectionId = 'TEST-replaced-connection'; });
  while (w.owner.waiters.length < 1) await flush();
  const secondLease = w.transport().binding({ phase:'signature', address:second.address, binding:secondBinding });
  while (w.owner.waiters.length < 2) await flush();

  await w.transport().binding({ phase:'release', address:w.address, leaseId:first.leaseId });
  await replacement;
  const { leaseId } = await secondLease;
  assert.equal(g.fence.connectionGeneration, 1);
  assert.ok(leaseId);

  const signedByFirst = w.sign(1), signedBySecond = second.sign(1);
  await assert.rejects(w.confirm(signedByFirst), { code:'network_binding_required' });
  await assert.rejects(w.transport().rpc({ method:'execute', params:[{ extra:'confirmTx', data:signedBySecond }] }, second.sdkAuth()), { code:'tp1_local_binding_changed' });
  assert.equal(w.node.confirms, 0);
  assert.deepEqual(await w.historyStates(), [], 'neither purchase retained a signature');
});

test('a confirmation retains its signed transaction and records confirm-started and a confirm-acknowledged holding the answer and gas', async (t) => {
  const w = world(t);
  w.node.gas = { fees:{ network_fee:'1000000000', rpc_fee:'1000000000', additional_fee:'0' } };
  await w.openGuarded();
  const { leaseId } = await w.lease(), signed = w.sign(1), answer = await w.confirm(signed);
  assert.deepEqual(await w.historyStates(), ['p1/signed', 'p1/confirm-started', 'p1/confirm-acknowledged']);
  const [retained, , acknowledged] = await w.historyRecords();
  assert.equal(Buffer.from(retained.bytes, 'base64').toString('utf8'), JSON.stringify(signed), 'the retained bytes are the signed transaction');
  assert.deepEqual(acknowledged.confirmation, answer);
  assert.deepEqual(acknowledged.gasOperation, w.node.gas);
  assert.deepEqual(await w.lanes(), [], 'confirming creates no broadcast lane record');
  assert.ok(!(await w.journal().get(`devnet/native-transfer/${signed.hash}`)), 'confirming creates no broadcast intent');

  await w.transport().binding({ phase:'broadcast', address:w.address, leaseId, hash:signed.hash });
  await w.broadcast(answer);
  assert.deepEqual(w.node.broadcasts, [signed.hash]);
});

test('a confirmation the node refuses is returned to the wallet as confirm-unknown, and the same bytes confirm again in a new pass', async (t) => {
  const w = world(t);
  await w.openGuarded();
  const { leaseId } = await w.lease(), signed = w.sign(1);
  w.node.invalid = true;
  const refused = await w.confirm(signed);
  assert.equal(refused.response.data.valid, false);
  assert.deepEqual(await w.historyStates(), ['p1/signed', 'p1/confirm-started', 'p1/confirm-unknown']);
  assert.equal((await w.historyRecords())[2].cause.code, 'stage_answer_not_accepted');
  await assert.rejects(w.transport().binding({ phase:'broadcast', address:w.address, leaseId, hash:signed.hash }), { code:'native_confirmation_required' });

  w.node.invalid = false;
  const answer = await w.confirm(signed);
  assert.deepEqual((await w.historyStates()).slice(3), ['p2/signed', 'p2/confirm-started', 'p2/confirm-acknowledged']);
  await w.transport().binding({ phase:'broadcast', address:w.address, leaseId, hash:signed.hash });
  await w.broadcast(answer);
  assert.deepEqual(w.node.broadcasts, [signed.hash]);
});

test('different bytes under a lease that already retained a transaction are refused before the node sees them', async (t) => {
  const w = world(t);
  await w.openGuarded();
  await w.lease();
  await w.confirm(w.sign(1));
  await assert.rejects(w.confirm(w.sign(2)), { code:'eb_operation_signed' });
  assert.equal(w.node.confirms, 1);
});

test('a confirmation answer with changed bytes or without the seller approval records confirm-unknown with its cause and is not confirmed', async (t) => {
  for (const [cause, node, transport] of [['signed_bytes_changed', { changed:true }, {}], ['approval_required', {}, { approveConfirmedWrite:async () => false }]]) {
    const w = world(t);
    Object.assign(w.node, node);
    await w.openGuarded({ transport });
    const { leaseId } = await w.lease(), signed = w.sign(1);
    await assert.rejects(w.confirm(signed), { code:cause });
    assert.deepEqual(await w.historyStates(), ['p1/signed', 'p1/confirm-started', 'p1/confirm-unknown'], cause);
    assert.equal((await w.historyRecords())[2].cause.code, cause);
    await assert.rejects(w.transport().binding({ phase:'broadcast', address:w.address, leaseId, hash:signed.hash }), { code:'native_confirmation_required' });
  }
});

test('a signature lease without a boundary refuses an owner fence for another connection and releases it', async (t) => {
  const w = world(t);
  w.open(pinsFor(CHAIN));
  const binding = await w.bind();
  w.owner.fenceConnectionId = 'TEST-other-connection';
  await assert.rejects(w.lease(binding), { code:'invalid_transport_owner' });
  assert.equal(w.owner.released, w.owner.acquired);
});

test('a lease holding the boundary fence refuses confirmation and broadcast once the connection changes', async (t) => {
  const w = world(t);
  await w.openGuarded();
  const { leaseId } = await w.lease(), signed = w.sign(1);
  w.owner.connectionId = 'TEST-moved-connection';
  await assert.rejects(w.confirm(signed), { code:'network_binding_required' });
  await assert.rejects(w.transport().binding({ phase:'broadcast', address:w.address, leaseId, hash:signed.hash }), { code:'network_binding_required' });
  assert.deepEqual([w.node.confirms, w.node.broadcasts], [0, []]);
});

test('an expired signature lease frees the connection fence without another request', async (t) => {
  const w = world(t, { exclusive:true }), g = await w.openGuarded({ transport:{ leaseMs:1000 } }), binding = await w.bind();
  t.mock.timers.enable({ apis:['setTimeout'] });
  await w.lease(binding);
  assert.deepEqual([w.owner.acquired, w.owner.released], [2, 1]);
  t.mock.timers.tick(1000);
  for (let turn = 0; turn < 20 && w.owner.released < 2; turn++) await flush();
  assert.equal(w.owner.released, 2, 'the fence is free at the lease expiry');
  assert.equal(g.fence.connectionGeneration, 0);
  await assert.rejects(w.confirm(w.sign(1)), { code:'network_binding_required' });
});

// A TEST payee, and the single-field changes of the connection record the boundary compares.
const PAYEE = '0x' + '7'.repeat(64), FIFTY_DEM_OS = '50000000000';
const RECORD_CHANGES = [['endpoint', 'https://other.invalid/'], ['transportAuthority', 'TEST-other-authority'], ['connectionId', 'TEST-other-connection']];
const bindingRefusal = (error) => /^tp1_/.test(error?.code ?? '');
const pendingRead = (hash) => ({ disposition:'pending', hash, noResend:true });
const moveConnection = (guard) => { guard.bound.liveLocal().connectionId = 'TEST-moved-connection'; };
const readyToBroadcast = (w, leaseId, signed) => w.transport().binding({ phase:'broadcast', address:w.address, leaseId, hash:signed.hash });

// A payment world with its lease and a signed first transfer.
async function leasedPayment(t, options) {
  const w = world(t), g = await w.openGuarded(options), { leaseId } = await w.lease();
  return { w, g, leaseId, signed:w.sign(1) };
}

// The same, confirmed and ready for the broadcast request.
async function confirmedPayment(t, options) {
  const w = world(t);
  return { w, ...(await w.confirmedPayment(options)) };
}

// The CREATE-capable world over its own durable journal and a real effect boundary.
async function guarded(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'native-effect-paths-')), path = join(dir, 'journal.sqlite');
  const journal = openDurableWalletJournal({ path, mode:'create' });
  t.after(() => { journal.close(); rmSync(dir, { recursive:true, force:true }); });
  return { ...(await guardedCreateWorld(t, { journal, ...options })), journal, path };
}

// The same journal reopened under a new transport, as after a restart.
async function restarted(t, c, options = {}) {
  c.journal.close();
  const journal = openDurableWalletJournal({ path:c.path, mode:'open' });
  t.after(() => journal.close());
  return { ...(await guardedCreateWorld(t, { journal, ...options })), journal, path:c.path };
}

// A CREATE with its lease, confirmed and ready for the broadcast request.
async function confirmedCreate(c, jobId = JOB_IDS[0]) {
  const tx = await c.makeCreate(jobId, 1), lease = await c.lease();
  return { tx, lease, confirmation:await c.confirm(tx) };
}

test('a record that no longer matches the approved binding makes every native path sign and transmit nothing', async (t) => {
  for (const [field, value] of RECORD_CHANGES) {
    const change = (guard) => { guard.bound.liveLocal()[field] = value; };
    const lease = world(t), leaseGuard = await lease.openGuarded(), binding = await lease.bind(), fences = lease.owner.acquired;
    change(leaseGuard);
    await assert.rejects(lease.lease(binding), bindingRefusal, `${field}: lease`);
    assert.equal(lease.owner.acquired, fences, `${field}: the lease took no fence`);

    const confirming = await leasedPayment(t);
    change(confirming.g);
    await assert.rejects(confirming.w.confirm(confirming.signed), bindingRefusal, `${field}: confirmation`);
    assert.deepEqual([confirming.w.node.confirms, await confirming.w.historyStates()], [0, []], `${field}: nothing sent or retained`);

    const broadcasting = await confirmedPayment(t);
    change(broadcasting.g);
    await assert.rejects(broadcasting.w.broadcast(broadcasting.confirmed), bindingRefusal, `${field}: broadcast`);
    assert.deepEqual(broadcasting.w.node.broadcasts, []);
    assert.equal((await broadcasting.w.historyStates()).at(-1), 'p2/dispatch-withheld');

    const createConfirm = await guarded(t), unconfirmed = await createConfirm.makeCreate(JOB_IDS[0], 1);
    await createConfirm.lease();
    change(createConfirm);
    await assert.rejects(createConfirm.confirm(unconfirmed), bindingRefusal, `${field}: CREATE confirmation`);
    assert.deepEqual(createConfirm.sent, { confirms:[], broadcasts:[] });

    const createBroadcast = await guarded(t), { tx, lease:held, confirmation } = await confirmedCreate(createBroadcast);
    change(createBroadcast);
    await assert.rejects(createBroadcast.broadcast(held, confirmation, tx.hash), bindingRefusal, `${field}: CREATE broadcast`);
    assert.deepEqual(createBroadcast.sent.broadcasts, []);

    const recovery = await guarded(t), retained = await recovery.makeCreate(JOB_IDS[1], 1);
    await recovery.retain(retained, 'broadcast-accepted');
    change(recovery);
    assert.deepEqual(await recovery.recover(retained), pendingRead(retained.hash), `${field}: recovery`);
    assert.deepEqual([recovery.sent, await recovery.states()], [{ confirms:[], broadcasts:[] }, []]);
  }
});

test('the approved record signs and transmits once on each native path', async (t) => {
  const w = world(t);
  await w.openGuarded();
  const signed = await w.send(1);
  assert.deepEqual([w.node.confirms, w.node.broadcasts], [1, [signed.hash]]);
  assert.deepEqual(await w.historyStates(), ['p1/signed', 'p1/confirm-started', 'p1/confirm-acknowledged', 'p2/signed', 'p2/dispatch-started', 'p2/dispatch-acknowledged']);
  assert.equal((await w.lanes())[0][1].stage, 'broadcast-accepted');

  const c = await guarded(t), { tx, lease, confirmation } = await confirmedCreate(c);
  await c.broadcast(lease, confirmation, tx.hash);
  assert.deepEqual(c.sent, { confirms:[tx.hash], broadcasts:[tx.hash] });
  assert.deepEqual(await c.states(), ['p1/signed', 'p1/confirm-started', 'p1/confirm-acknowledged', 'p2/signed', 'p2/dispatch-started', 'p2/dispatch-acknowledged']);

  const r = await guarded(t), retained = await r.makeCreate(JOB_IDS[1], 1);
  await r.retain(retained, 'broadcast-accepted');
  assert.deepEqual(await r.recover(retained), pendingRead(retained.hash));
  assert.deepEqual(r.sent, { confirms:[retained.hash], broadcasts:[retained.hash] });
  assert.deepEqual(await r.states(), ['p1/signed', 'p1/recovery-confirm-started', 'p1/recovery-confirm-acknowledged', 'p2/signed', 'p2/recovery-dispatch-started', 'p2/recovery-dispatch-acknowledged']);
  assert.equal((await r.journal.get(r.laneKey)).storageWriteResends, 1, 'the sole resend is reserved');
});

test('a swap between transmit and recovery leaves recovery readback-only', async (t) => {
  for (const swap of ['the boundary\'s connection record', 'the connection while recovery confirms']) {
    let swapAtConfirmation = () => {};
    const c = await guarded(t, { onNode:async (message) => { if (message === 'confirmTx') swapAtConfirmation(); } });
    const { tx, lease, confirmation } = await confirmedCreate(c);
    await c.broadcast(lease, confirmation, tx.hash);
    await c.retain(tx, 'broadcast-accepted');
    const lane = await c.journal.get(c.laneKey);
    if (swap.startsWith('the boundary')) moveConnection(c);
    else swapAtConfirmation = () => { c.owner.connectionId = 'TEST-swapped-connection'; };
    assert.deepEqual(await c.recover(tx), pendingRead(tx.hash), swap);
    assert.deepEqual(c.sent.broadcasts, [tx.hash], `${swap}: no second broadcast`);
    assert.deepEqual(await c.journal.get(c.laneKey), lane, `${swap}: the lane keeps its key and bytes`);
  }
});

test('the connection changing at fence acquisition, the final stop await and intent persistence signs nothing where signing had not begun and transmits nothing', async (t) => {
  const atAcquisition = world(t), acquisitionGuard = await atAcquisition.openGuarded(), binding = await atAcquisition.bind();
  atAcquisition.owner.gate = async () => { atAcquisition.owner.gate = null; moveConnection(acquisitionGuard); };
  const refused = await atAcquisition.lease(binding).then(() => atAcquisition.confirm(atAcquisition.sign(1))).then(() => null, (error) => error);
  assert.ok(bindingRefusal(refused), `refused with ${refused?.code}`);
  assert.deepEqual([atAcquisition.node.confirms, await atAcquisition.historyStates()], [0, []]);

  const atStop = await leasedPayment(t);
  let reads = 0;
  Object.defineProperty(atStop.g.state, 'stopped', { get() { if (++reads === 2) moveConnection(atStop.g); return false; } });
  await assert.rejects(atStop.w.confirm(atStop.signed), { code:'tp1_local_binding_changed' });
  assert.deepEqual([atStop.w.node.confirms, await atStop.w.historyStates()], [0, []], 'the final stop await was the second stop read, and nothing was signed');

  const atConfirmRecord = await leasedPayment(t);
  cutAppend({ history:atConfirmRecord.g.history }, 'confirm-started', { mutate:() => moveConnection(atConfirmRecord.g) });
  await assert.rejects(atConfirmRecord.w.confirm(atConfirmRecord.signed), { code:'tp1_local_binding_changed' });
  assert.deepEqual([atConfirmRecord.w.node.confirms, await atConfirmRecord.w.historyStates()], [0, ['p1/signed', 'p1/confirm-started', 'p1/confirm-withheld']]);

  const atDispatchRecord = await confirmedPayment(t);
  cutAppend({ history:atDispatchRecord.g.history }, 'dispatch-started', { mutate:() => moveConnection(atDispatchRecord.g) });
  await assert.rejects(atDispatchRecord.w.broadcast(atDispatchRecord.confirmed), { code:'tp1_local_binding_changed' });
  assert.deepEqual(atDispatchRecord.w.node.broadcasts, []);
  assert.deepEqual((await atDispatchRecord.w.historyStates()).slice(-2), ['p2/dispatch-started', 'p2/dispatch-withheld']);
});

test('no host ceiling refuses fee_ceiling_required; a 50 DEM debit passes; 50 DEM plus 1 OS refuses before signing; a confirmed debit above the ceiling refuses before broadcast', async (t) => {
  const none = world(t), noneGuard = await none.openGuarded({ feeCeilingOs:null }), noneBinding = await none.bind(), noneFences = none.owner.acquired;
  await assert.rejects(none.lease(noneBinding), { code:'fee_ceiling_required' });
  assert.equal(none.owner.acquired, noneFences);
  assert.equal(noneGuard.state.stopped, false);

  const events = [], c = await guarded(t, { owner:queuingFenceOwner(events) }), transfer = (amountOs) => ({ nonce:1, to:PAYEE, amountOs, payloadDigest:'d'.repeat(64) });
  await c.release(await c.lease(transfer(FIFTY_DEM_OS)));
  const fences = events.length;
  await assert.rejects(c.lease(transfer('50000000001')), { code:'write-fee-cap' });
  assert.deepEqual([events.length, c.sent, await c.states()], [fences, { confirms:[], broadcasts:[] }, []], 'refused before the fence and before any record');

  // The confirmed fees are what the broadcast is held to: exactly the ceiling passes, one OS more or a member that is not a decimal OS string does not.
  const fees = (network_fee, rpc_fee = '0', additional_fee = '0') => ({ fees:{ network_fee, rpc_fee, additional_fee } });
  for (const [gas, outcome] of [[fees('25000000000', '25000000000'), 'sent'], [fees('50000000000', '1'), 'write-fee-cap'], [fees('1.5'), 'write-fee-cap'], [fees(1), 'write-fee-cap'], [fees('1', '-1'), 'write-fee-cap']]) {
    const w = world(t);
    w.node.gas = gas;
    await w.openGuarded();
    const { leaseId } = await w.lease(), signed = w.sign(1), confirmed = await w.confirm(signed);
    await readyToBroadcast(w, leaseId, signed);
    const result = await w.broadcast(confirmed).then(() => 'sent', (error) => error.code);
    assert.equal(result, outcome, JSON.stringify(gas));
    assert.deepEqual(w.node.broadcasts, outcome === 'sent' ? [signed.hash] : [], JSON.stringify(gas));
    if (outcome !== 'sent') assert.deepEqual([(await w.historyStates()).at(-1), await w.lanes()], ['p2/dispatch-withheld', []], 'refused before the lane row');
  }
});

test('a native send is broadcast once and stays readback-only across restart; a recovery resend happens at most once and never under a stop or a re-hold', async (t) => {
  const w = world(t);
  await w.openGuarded();
  const signed = await w.send(1), history = await w.historyStates();
  await w.restartGuarded();
  await assert.rejects(w.lease(), { code:'outcome_unknown' });
  assert.equal((await w.transport().binding({ phase:'readback', address:w.address, hash:signed.hash })).disposition, 'included');
  assert.deepEqual([w.node.broadcasts, await w.historyStates()], [[signed.hash], history], 'nothing was sent or recorded after the restart');

  let c = await guarded(t);
  const retained = await c.makeCreate(JOB_IDS[0], 1);
  await c.retain(retained, 'broadcast-accepted');
  assert.deepEqual(await c.recover(retained), pendingRead(retained.hash));
  assert.deepEqual(await c.recover(retained), pendingRead(retained.hash));
  c = await restarted(t, c);
  assert.deepEqual(await c.recover(retained), pendingRead(retained.hash));
  assert.deepEqual(c.sent.broadcasts, [], 'the restarted transport sent nothing');
  assert.equal((await c.journal.get(c.laneKey)).storageWriteResends, 1);

  for (const [event, apply] of [['a stop', (g) => { g.state.stopped = true; }], ['a re-hold', () => setPurchaseAdmission('held')]]) {
    const held = await guarded(t), unsent = await held.makeCreate(JOB_IDS[1], 1);
    await held.retain(unsent, 'broadcast-accepted');
    apply(held);
    assert.deepEqual(await held.recover(unsent), pendingRead(unsent.hash), event);
    assert.deepEqual([held.sent, (await held.journal.get(held.laneKey)).storageWriteResends], [{ confirms:[], broadcasts:[] }, undefined], `${event}: nothing sent and no resend reserved`);
  }
});

test('while held, every native path refuses profile_not_admitted with zero signer, fence and transport calls', async (t) => {
  const lease = world(t), leaseGuard = await lease.openGuarded(), binding = await lease.bind(), fences = lease.owner.acquired;
  setPurchaseAdmission('held');
  await assert.rejects(lease.lease(binding), { code:'profile_not_admitted' });
  assert.deepEqual([lease.owner.acquired, lease.node.confirms, await lease.historyStates()], [fences, 0, []]);
  assert.equal(leaseGuard.state.stopped, false);

  const confirming = await leasedPayment(t), confirmFences = confirming.w.owner.acquired;
  setPurchaseAdmission('held');
  await assert.rejects(confirming.w.confirm(confirming.signed), { code:'profile_not_admitted' });
  assert.deepEqual([confirming.w.owner.acquired, confirming.w.node.confirms, await confirming.w.historyStates()], [confirmFences, 0, []]);

  const broadcasting = await confirmedPayment(t);
  setPurchaseAdmission('held');
  await assert.rejects(broadcasting.w.broadcast(broadcasting.confirmed), { code:'profile_not_admitted' });
  assert.deepEqual(broadcasting.w.node.broadcasts, []);

  const events = [], recovery = await guarded(t, { owner:queuingFenceOwner(events) }), retained = await recovery.makeCreate(JOB_IDS[0], 1);
  await recovery.retain(retained, 'broadcast-accepted');
  const taken = events.length;
  setPurchaseAdmission('held');
  assert.deepEqual(await recovery.recover(retained), pendingRead(retained.hash));
  assert.deepEqual([events.length, recovery.sent, await recovery.states()], [taken, { confirms:[], broadcasts:[] }, []]);
});

// The four effectful requests of the transport. Each builder returns the world's `history`, `state`
// and `bound` (for the changes a test makes), its `owner`, the `stage` the request records, how
// many node calls that stage has made, its records, and `run(wrap)`, which makes the request inside
// `wrap` (the composition's pass context, or none). A recovery answers `pending` where a payment rejects.
const CALLERS = {
  confirmation: async (t) => {
    const { w, g, signed } = await leasedPayment(t);
    return { history:g.history, state:g.state, bound:g.bound, owner:w.owner, stage:'confirm', calls:() => w.node.confirms, records:() => w.historyRecords(), run:(wrap) => wrap(() => w.confirm(signed)) };
  },
  broadcast: async (t) => {
    const { w, g, confirmed } = await confirmedPayment(t);
    return { history:g.history, state:g.state, bound:g.bound, owner:w.owner, stage:'dispatch', calls:() => w.node.broadcasts.length, records:() => w.historyRecords(),
      readbackOnly:async () => (await w.lanes())[0][1].stage === 'broadcast-started', run:(wrap) => wrap(() => w.broadcast(confirmed)) };
  },
  'recovery confirmation': (t) => recoveryCaller(t, 'recovery-confirm', (c) => c.sent.confirms.length),
  'recovery resend': async (t) => { const caller = await recoveryCaller(t, 'recovery-dispatch', (c) => c.sent.broadcasts.length); return { ...caller, readbackOnly:caller.reserved }; },
};

async function recoveryCaller(t, stage, calls) {
  const c = await guarded(t), tx = await c.makeCreate(JOB_IDS[0], 1);
  await c.retain(tx, 'broadcast-accepted');
  return { history:c.history, state:c.state, bound:c.bound, owner:c.owner, stage, calls:() => calls(c), records:c.records, recovers:tx.hash,
    reserved:async () => (await c.journal.get(c.laneKey)).storageWriteResends === 1, run:(wrap) => wrap(() => c.recover(tx)) };
}

// What a refused request looks like to its caller: a payment rejects with the code; a recovery answers readback-only.
function refusalOf(caller, outcome) {
  if (caller.recovers === undefined) return outcome.code;
  assert.deepEqual(outcome, pendingRead(caller.recovers));
  return 'pending';
}
const expectedRefusal = (caller, code) => (caller.recovers === undefined ? code : 'pending');
const settled = (promise) => promise.then((value) => value, (error) => error);

// Runs the request with the first context read after its `<stage>-started` record held pending: the read the
// transmit step makes last. `during` runs while it is held, then the read is let through.
async function runWithFinalContextHeld(caller, during, wrap = (work) => work()) {
  let reached, letThrough;
  const arrived = new Promise((resolve) => { reached = resolve; }), released = new Promise((resolve) => { letThrough = resolve; });
  cutAppend({ history:caller.history }, `${caller.stage}-started`, { mutate:() => { caller.owner.contextGate = async () => { caller.owner.contextGate = null; reached(); await released; }; } });
  const outcome = caller.run(wrap).then((value) => value, (error) => error);
  await arrived;
  await during();
  letThrough();
  return outcome;
}

const CHANGES_DURING_THE_HOLD = [
  ['a stop', (caller) => { caller.state.stopped = true; }, 'writes_stopped'],
  ['a re-hold', () => setPurchaseAdmission('held'), 'profile_not_admitted'],
  ['a reconnect around the fence', moveConnection, 'tp1_local_binding_changed'],
];

test('with the final getContext() held pending, a stop, a re-hold or a reconnect around the fence, then release: zero fetchImpl calls and the withheld state on initial confirmation, initial broadcast, recovery confirmation and recovery resend; the unchanged control transmits once each', async (t) => {
  for (const [name, build] of Object.entries(CALLERS)) {
    for (const [change, apply, code] of CHANGES_DURING_THE_HOLD) {
      const caller = await build(t), before = caller.calls();
      const outcome = await runWithFinalContextHeld(caller, () => apply(caller));
      const records = await caller.records();
      assert.equal(refusalOf(caller, outcome), expectedRefusal(caller, code), `${name} after ${change}`);
      assert.equal(caller.calls(), before, `${name} after ${change}: no request reached the node`);
      assert.deepEqual([records.at(-1).state, records.at(-1).cause.code], [`${caller.stage}-withheld`, code], `${name} after ${change}`);
      if (caller.readbackOnly) assert.ok(await caller.readbackOnly(), `${name}: the lane stays readback-only`);
    }
    const control = await build(t), before = control.calls();
    const outcome = await runWithFinalContextHeld(control, async () => {});
    assert.equal(outcome instanceof Error, false, `${name} control`);
    assert.equal(control.calls(), before + 1, `${name} control transmits once`);
    assert.ok((await control.records()).some((record) => record.state === `${control.stage}-acknowledged`), `${name} control is acknowledged`);
  }
});

const JOB_CLASSES = ['job-create', 'payment-evidence', 'job-resume'];
const SETTLEMENT_RELEASED = Object.assign(new Error('TEST settlement credit released'), { code:'settlement_credit_released' });

test('a job pass runs its private current-authorization check after the final stop await and before the request, and the authorized control transmits once', async (t) => {
  for (const [name, build] of Object.entries(CALLERS)) {
    for (const operationClass of name === 'confirmation' ? JOB_CLASSES : ['job-create']) {
      // The refusal arrives during the final stop await: the stop read made inside the transmit step.
      const refused = await build(t);
      let revoked = false, armed = false;
      Object.defineProperty(refused.state, 'stopped', { get() { if (armed) revoked = true; return false; } });
      const checked = (work) => underPass({ operationClass, currentAuthorization:() => { if (revoked) throw SETTLEMENT_RELEASED; return true; } }, work);
      const outcome = await runWithFinalContextHeld(refused, async () => { armed = true; }, checked);
      const records = await refused.records();
      assert.equal(refusalOf(refused, outcome), expectedRefusal(refused, 'settlement_credit_released'), `${name} ${operationClass}`);
      assert.equal(refused.calls(), 0, `${name} ${operationClass}: zero requests`);
      assert.deepEqual([records.at(-1).state, records.at(-1).cause.code], [`${refused.stage}-withheld`, 'settlement_credit_released']);

      const control = await build(t);
      let calls = 0;
      const outcomeOfControl = await runWithFinalContextHeld(control, async () => {}, (work) => underPass({ operationClass, currentAuthorization:() => { calls++; return true; } }, work));
      assert.equal(outcomeOfControl instanceof Error, false, `${name} ${operationClass} control`);
      assert.deepEqual([calls, control.calls()], [control.recovers === undefined ? 1 : 2, 1], `${name} ${operationClass}: a check before each of its requests, one request of its own stage`);
    }
  }
});

test('a job pass without a usable check is withheld before any request, whatever its class and whatever else the caller supplies', async (t) => {
  const late = () => Promise.reject(new Error('TEST late answer'));
  const cases = [['no check', undefined, 'context_authorization_required'], ['a check that answers false', () => false, 'context_authorization_refused'],
    ['a check that answers asynchronously', late, 'context_authorization_refused'], ['a check that throws', () => { throw SETTLEMENT_RELEASED; }, 'settlement_credit_released']];
  for (const operationClass of JOB_CLASSES) {
    for (const [name, currentAuthorization, code] of cases) {
      const caller = await CALLERS.confirmation(t);
      const outcome = await settled(caller.run((work) => underPass({ operationClass, currentAuthorization }, work)));
      assert.equal(outcome.code, code, `${operationClass}: ${name}`);
      assert.equal(caller.calls(), 0);
      assert.equal((await caller.records()).at(-1).state, 'confirm-withheld');
    }
  }
  for (const name of ['broadcast', 'recovery confirmation']) {
    const caller = await CALLERS[name](t);
    const outcome = await settled(caller.run((work) => underPass({ operationClass:'job-resume' }, work)));
    assert.equal(refusalOf(caller, outcome), expectedRefusal(caller, 'context_authorization_required'), name);
    assert.equal((await caller.records()).at(-1).state, `${caller.stage}-withheld`);
    assert.equal(caller.calls(), 0, name);
  }
});

test('a pass context needs the module\'s own factory and a known class; its operation id names the lease\'s history and is not the lease id', async (t) => {
  assert.deepEqual(currentPassContext(), { operationClass:null });
  assert.throws(() => passContext({ operationClass:'job-unknown' }), TypeError);
  assert.throws(() => runInPassContext({ operationClass:null, currentAuthorization:() => true }, () => {}), TypeError);

  const w = world(t), spec = { operationClass:'job-create', operationId:'TEST-job-1', currentAuthorization:() => true };
  await w.openGuarded();
  const { leaseId } = await underPass(spec, () => w.lease()), signed = w.sign(1);
  await underPass(spec, () => w.confirm(signed));
  assert.notEqual(leaseId, 'TEST-job-1');
  assert.deepEqual([...new Set((await w.historyRecords()).map((record) => record.operationId))], ['TEST-job-1']);
});

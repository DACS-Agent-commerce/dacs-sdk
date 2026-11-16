// The native transport keys and compares its lane on one canonical chain identity, a lane
// stamped by another pin version stays readback-only, and with an effect boundary the
// signature lease holds the boundary's fence while confirmation runs as its own recorded
// stage. The real transport, effect boundary and durable journal run in this process
// against a scripted TEST node; a TEST key signs the transactions. No network, chain or funds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setPurchaseAdmission, flush, cutAppend } from './helpers/effect-boundary-fixture.mjs';
import { CHAIN, LANE_PREFIX, pinsFor, nativeWorld as world, walletKey } from './helpers/native-effect-world.mjs';
import { createDevnetNativeTransport, nativeWalletLaneKey } from '../src/wallet/devnet-native-transport.mjs';

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
  w.node.gas = { fees:{ network:'1000000000', rpc:'1000000000', additional:'0' } };
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

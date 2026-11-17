// The native transport's pinned chain identity and pin version, and its
// effect boundary: the signature lease holds the boundary's connection fence,
// and confirmation is retained as its own stage in the dispatch history.
// A lower-case chain identity written with or without 0x is the same pin: it is
// canonicalised once to its bare form, and every lane key and stored binding
// uses that form. Upper-case or padded identities are refused with the
// binder's own cause. A retained transfer stamped by another pin version stays
// readback-only: it is never reconfirmed, resent or re-keyed.
// The real transport and durable journal run in this process against a
// scripted TEST node. No network, chain or funds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NetworkBindingError } from '../src/dacs/network-binding.mjs';
import { nativeWalletLaneKey } from '../src/wallet/devnet-native-transport.mjs';
import { bindFixture } from './fixtures/tp1-authority-reader.mjs';
import { cutAppend, flush, setPurchaseAdmission } from './helpers/effect-boundary-fixture.mjs';
import { CURRENT_PIN, IDENTITY, LANE_PREFIX, PINS, RETIRED_PIN, nativeWorld as world } from './helpers/native-effect-world.mjs';

const LEASE_MS = 1000;
const OTHER_PURCHASE = '0x' + '9'.repeat(64);
const settleUntil = async condition => { for (let tries = 0; tries < 50 && !condition(); tries++) await flush(); assert.ok(condition(), 'the expected state was not reached'); };
const states = records => records.map(record => record.state);

test('a 0x-prefixed lower-case chain identity binds and keys its lane the same as the bare form', async t => {
  const w = world(t), prefixed = '0x' + IDENTITY;
  assert.equal(nativeWalletLaneKey({ ...PINS, chainIdentity: prefixed }, w.address), nativeWalletLaneKey(PINS, w.address));
  w.open({ chainIdentity: prefixed });
  const { binding } = await w.transport().binding({ phase: 'bind', address: w.address });
  assert.equal(binding.chainIdentity, IDENTITY);
  const { tx, answer } = await w.send(1);
  assert.equal(answer.result, 200);
  const lanes = (await w.journalEntries()).filter(([key]) => key.startsWith(LANE_PREFIX));
  assert.deepEqual(lanes.map(([key]) => key), [nativeWalletLaneKey(PINS, w.address)]);
  assert.equal(lanes[0][1].networkBinding.chainIdentity, IDENTITY);
  assert.equal(JSON.stringify(lanes[0][1].signedTransaction), JSON.stringify(tx), 'the stored signed bytes are the signed bytes');
  // A transport pinned with the bare form finds the same lane and refuses to resend it.
  w.open({});
  await assert.rejects(w.lease(), { code: 'outcome_unknown' });
  // Readback under the prefixed pin reports the bare identity and accepts the stored binding.
  w.open({ chainIdentity: prefixed });
  const read = await w.transport().binding({ phase: 'readback', address: w.address, hash: tx.hash });
  assert.equal(read.disposition, 'included');
  assert.equal(read.receipt.chainIdentity, IDENTITY);
});

test('an upper-case or padded chain identity is refused with its cause and never normalised', async t => {
  const w = world(t);
  for (const chainIdentity of [IDENTITY.toUpperCase(), '0X' + IDENTITY, `0x${IDENTITY.toUpperCase().slice(0, 2)}${IDENTITY.slice(2)}`, ` ${IDENTITY}`, `${IDENTITY}\n`, `0x ${IDENTITY}`, IDENTITY.slice(1)]) {
    assert.throws(() => w.open({ chainIdentity }), error => error instanceof NetworkBindingError && error.code === 'unpinned_network' && /canonical lowercase 64-hex/.test(error.message), JSON.stringify(chainIdentity));
  }
  // An upper-case identity observed from the node is refused as well, with its own cause.
  w.node.genesisHash = IDENTITY.toUpperCase();
  w.open({});
  await assert.rejects(w.transport().binding({ phase: 'bind', address: w.address }), error => error instanceof NetworkBindingError && error.code === 'malformed_observation');
  assert.deepEqual((await w.journalEntries()).filter(([key]) => key.startsWith(LANE_PREFIX)), []);
});

test('a lane stamped with a retired pin version is readback-only: no lease, no resend, no re-key', async t => {
  const w = world(t);
  w.open({ pinVersion: RETIRED_PIN });
  const { tx } = await w.send(1);
  const retained = JSON.stringify(await w.journalEntries());
  assert.equal(w.node.confirms, 1);
  assert.deepEqual(w.node.broadcasts, [tx.hash]);
  for (const restart of [false, true]) {
    if (restart) await w.restart({ pinVersion: CURRENT_PIN });
    else w.open({ pinVersion: CURRENT_PIN });
    const acquired = w.fence.acquired;
    await assert.rejects(w.lease(), { code: 'pin_version_retired' });
    assert.equal(w.fence.released, w.fence.acquired, 'the connection fence is released after the refusal');
    assert.ok(w.fence.acquired >= acquired);
    assert.equal(JSON.stringify(await w.journalEntries()), retained, 'the retained lane keeps its key and bytes');
  }
  assert.equal(w.node.confirms, 1);
  assert.deepEqual(w.node.broadcasts, [tx.hash]);
  // The same lane under its own pin version keeps the unfinished-transfer refusal.
  await w.restart({ pinVersion: RETIRED_PIN });
  await assert.rejects(w.lease(), { code: 'outcome_unknown' });
});

test('confirm refuses a retained transfer stamped with a retired pin version and sends nothing', async t => {
  const w = world(t);
  w.open({});
  const lease = await w.lease(), tx = w.signedTransfer(1);
  await w.plant(`devnet/native-transfer/${tx.hash}`, { stage: 'broadcast-accepted', hash: tx.hash, nonce: 1, signedTransaction: tx, networkBinding: { ...lease.binding, pinVersion: RETIRED_PIN } });
  await assert.rejects(w.confirm(tx), { code: 'pin_version_retired' });
  assert.equal(w.node.confirms, 0);
  assert.deepEqual(w.node.broadcasts, []);
});

test('broadcast refuses a lane stamped with a retired pin version and sends nothing', async t => {
  const w = world(t);
  w.open({});
  const lease = await w.lease(), tx = w.signedTransfer(1), other = w.signedTransfer(2);
  const confirmation = await w.confirm(tx);
  await w.prepareBroadcast(lease.leaseId, tx.hash);
  const laneKey = nativeWalletLaneKey(PINS, w.address);
  await w.plant(laneKey, { stage: 'broadcast-accepted', hash: other.hash, nonce: 2, signedTransaction: other, networkBinding: { ...lease.binding, pinVersion: RETIRED_PIN } });
  const retained = JSON.stringify(await w.journalEntries());
  await assert.rejects(w.broadcast(confirmation), { code: 'pin_version_retired' });
  assert.deepEqual(w.node.broadcasts, []);
  assert.equal(JSON.stringify(await w.journalEntries()), retained, 'the retired lane is neither rewritten nor re-keyed');
});

test('a transport refuses a malformed boundary with a TypeError and works as before without one', async t => {
  const w = world(t);
  for (const boundary of [null, 'boundary', {}, { holdFence() {}, signPass() {} }, { holdFence() {}, signPass() {}, dispatchPass: 1 }]) {
    assert.throws(() => w.open({}, { boundary }), TypeError, JSON.stringify(boundary));
  }
  w.open({});
  const { answer } = await w.send(1);
  assert.equal(answer.result, 200);
});

test('a reconnect made behind the fence while the signer is awaited leaves signed-held; a fenced replacement waits', async t => {
  const bound = await bindFixture(), w = world(t, { bound });
  w.open({});
  const lease = await w.lease(), tx = w.signedTransfer(1);
  // The connection is replaced behind the fence after the signed bytes are retained.
  let reconnecting = true;
  cutAppend(w, 'signed', { mutate: () => { if (reconnecting) bound.current.connectionId = 'TEST-reconnected'; } });
  await assert.rejects(w.confirm(tx), { code: 'tp1_local_binding_changed' });
  assert.equal(w.node.confirms, 0);
  const records = await w.records(tx);
  assert.deepEqual(states(records), ['signed', 'signed-held']);
  assert.equal(records[1].cause.code, 'tp1_local_binding_changed');
  await w.release(lease.leaseId);
  assert.equal(w.fence.released, w.fence.acquired);

  reconnecting = false;
  // A replacement requested through the fence waits for the lease; the lease confirms and broadcasts once on its own connection.
  bound.current.connectionId = 'vector-conn-1';
  const next = await w.lease(), other = w.signedTransfer(2);
  let replaced = false;
  const replacement = w.boundary.replaceConnection(() => { replaced = true; bound.current.connectionId = 'TEST-replaced'; });
  await flush();
  assert.equal(replaced, false, 'the replacement waits while the lease holds the fence');
  const confirmation = await w.confirm(other);
  await w.prepareBroadcast(next.leaseId, other.hash);
  assert.equal(replaced, false, 'the replacement still waits before the broadcast');
  const answer = await w.broadcast(confirmation);
  await replacement;
  assert.equal(answer.result, 200);
  assert.equal(replaced, true, 'the replacement ran once the broadcast ended the lease');
  assert.equal(w.node.confirms, 1);
  assert.deepEqual(w.node.broadcasts, [other.hash]);
});

test('the signature lease is one acquisition of the owner connection fence, held through confirm and broadcast and released at the end', async t => {
  const w = world(t, { bound: await bindFixture() });
  w.open({});
  const binding = await w.bind(), before = { acquired: w.fence.acquired, released: w.fence.released };
  const lease = await w.signature(binding), tx = w.signedTransfer(1);
  assert.equal(w.fence.acquired - before.acquired, 1);
  assert.equal(w.fence.released - before.released, 0, 'the fence is held after the signature phase');
  const confirmation = await w.confirm(tx);
  await w.prepareBroadcast(lease.leaseId, tx.hash);
  assert.equal(w.fence.acquired - before.acquired, 1, 'confirm and the broadcast preparation acquire nothing');
  assert.equal(w.fence.released - before.released, 0);
  assert.deepEqual(states(await w.records(tx)), ['signed', 'confirm-started', 'confirm-acknowledged'], 'the confirmation passes ran inside the lease');
  await w.broadcast(confirmation);
  assert.equal(w.fence.acquired - before.acquired, 1);
  assert.equal(w.fence.released - before.released, 1, 'the end of the broadcast releases the fence');
  assert.equal(w.node.confirms, 1);
  assert.deepEqual(w.node.broadcasts, [tx.hash]);
});

test('a signature lease waiting more than 10,000 ms for the fence refuses tp1_fence_timeout and its late grant is released', async t => {
  const w = world(t, { bound: await bindFixture() });
  w.open({});
  const binding = await w.bind();
  let release;
  const holder = w.effectFence.withFence('TEST-holder', () => new Promise(resolve => { release = resolve; }));
  await flush();
  let settled = false;
  const waiting = w.signature(binding).finally(() => { settled = true; });
  const refused = assert.rejects(waiting, { code: 'tp1_fence_timeout' });
  await flush();
  w.clock.advance(9999);
  await flush();
  assert.equal(settled, false, 'the wait is still open before 10,000 ms');
  w.clock.advance(1);
  await refused;
  release();
  await holder;
  await flush();
  assert.equal(w.fence.released, w.fence.acquired, 'every acquisition is released, the late one too');
});

test('a stop or a held profile refuses the signature phase before the fence is acquired', async t => {
  const w = world(t, { bound: await bindFixture() });
  w.open({});
  const binding = await w.bind(), acquired = w.fence.acquired;
  w.stopped = true;
  await assert.rejects(w.signature(binding), { code: 'writes_stopped' });
  w.stopped = false;
  setPurchaseAdmission('held');
  await assert.rejects(w.signature(binding), { code: 'profile_not_admitted' });
  assert.equal(w.fence.acquired, acquired, 'nothing was acquired for a refused lease');
});

test('a signature phase that fails after the fence is held releases it', async t => {
  const w = world(t, { bound: await bindFixture() });
  w.open({});
  const binding = await w.bind();
  await assert.rejects(w.signature({ ...binding, chainIdentity: 'd'.repeat(64) }));
  assert.equal(w.fence.released, w.fence.acquired);
  assert.ok((await w.lease()).leaseId, 'the next signature phase gets its lease');
});

test('closing the transport releases the fence of a lease that is still held', async t => {
  const w = world(t, { bound: await bindFixture() });
  w.open({});
  await w.lease();
  assert.notEqual(w.fence.released, w.fence.acquired);
  await w.transport().close();
  assert.equal(w.fence.released, w.fence.acquired);
});

test('a lease nobody uses frees the owner fence when it expires', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let at = Date.now();
  const w = world(t, { bound: await bindFixture() });
  w.open({}, { now: () => at, leaseMs: LEASE_MS });
  await w.lease();
  assert.notEqual(w.fence.released, w.fence.acquired);
  at += LEASE_MS;
  t.mock.timers.tick(LEASE_MS + 1);
  await settleUntil(() => w.fence.released === w.fence.acquired);
});

test('a lease that expires during a confirmation keeps its fence until the confirmation ends', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let at = Date.now(), open;
  const w = world(t, { bound: await bindFixture() });
  w.open({}, { now: () => at, leaseMs: LEASE_MS });
  await w.lease();
  w.node.confirmGate = new Promise(resolve => { open = resolve; });
  const confirming = w.confirm(w.signedTransfer(1));
  await settleUntil(() => w.node.confirms === 1);
  at += LEASE_MS;
  t.mock.timers.tick(LEASE_MS + 1);
  await flush();
  assert.notEqual(w.fence.released, w.fence.acquired, 'a running confirmation keeps the lease');
  open();
  await confirming;
  await settleUntil(() => w.fence.released === w.fence.acquired);
});

test('two purchases on one buyer connection when its fence changes: neither signs under the old generation', async t => {
  const bound = await bindFixture(), w = world(t, { bound });
  w.open({});
  const firstBinding = await w.bind(), secondBinding = await w.bind(OTHER_PURCHASE);
  const first = await w.signature(firstBinding), tx = w.signedTransfer(1);
  // A fenced replacement is queued before the second purchase asks for its lease.
  const replacement = w.boundary.replaceConnection(() => { bound.current.connectionId = 'TEST-replaced'; });
  const secondRefused = assert.rejects(w.signature(secondBinding, OTHER_PURCHASE), { code: 'tp1_local_binding_changed' });
  await flush();
  assert.ok(await w.confirm(tx), 'the first purchase still confirms on the generation it holds');
  await w.release(first.leaseId);
  await replacement;
  await secondRefused;
  await assert.rejects(w.transport().binding({ phase: 'broadcast', address: OTHER_PURCHASE, leaseId: 'none', hash: tx.hash }), { code: 'network_binding_required' });
  assert.equal(w.node.confirms, 1);
  assert.equal(w.fence.released, w.fence.acquired);
});

test('a confirmation is retained as the signed bytes, a started record and an acknowledged record with the node answer and gas', async t => {
  const w = world(t, { bound: await bindFixture() });
  w.open({});
  w.node.gas = { fees: { network: '1000000000', rpc: '1000000000', additional: '0' } };
  const lease = await w.lease(), tx = w.signedTransfer(1);
  const answer = await w.confirm(tx);
  const records = await w.records(tx);
  assert.deepEqual(states(records), ['signed', 'confirm-started', 'confirm-acknowledged']);
  assert.equal(Buffer.from(records[0].bytes, 'base64').toString(), JSON.stringify(tx), 'the exact signed bytes are retained');
  assert.deepEqual(records[2].confirmation, answer);
  assert.deepEqual(records[2].gasOperation, w.node.gas);
  assert.ok(records.every(record => record.operationId === lease.leaseId));
  const keys = (await w.journalEntries()).map(([key]) => key);
  assert.deepEqual(keys.filter(key => key.startsWith(LANE_PREFIX) || key.startsWith('devnet/native-transfer/')), [], 'confirmation writes no lane record and no broadcast intent');
});

test('a repeated confirmation of the same bytes after a lost answer runs a new pass and can be broadcast', async t => {
  const w = world(t, { bound: await bindFixture() });
  w.open({});
  const lease = await w.lease(), tx = w.signedTransfer(1);
  w.node.failConfirm = new Error('TEST-lost-answer');
  await assert.rejects(w.confirm(tx));
  w.node.failConfirm = null;
  const confirmation = await w.confirm(tx);
  assert.deepEqual(states(await w.records(tx)), ['signed', 'confirm-started', 'confirm-unknown', 'signed', 'confirm-started', 'confirm-acknowledged']);
  await w.prepareBroadcast(lease.leaseId, tx.hash);
  assert.equal((await w.broadcast(confirmation)).result, 200);
  assert.deepEqual(w.node.broadcasts, [tx.hash]);
});

test('an answer that is not a valid confirmation is returned to the wallet, recorded unknown and never broadcast', async t => {
  const w = world(t, { bound: await bindFixture() });
  w.open({});
  w.node.invalid = true;
  const lease = await w.lease(), tx = w.signedTransfer(1);
  const answer = await w.confirm(tx);
  assert.equal(answer.response.data.valid, false);
  const records = await w.records(tx);
  assert.deepEqual(states(records), ['signed', 'confirm-started', 'confirm-unknown']);
  assert.equal(records[2].cause.code, 'stage_answer_not_accepted');
  await assert.rejects(w.prepareBroadcast(lease.leaseId, tx.hash), { code: 'native_confirmation_required' });
  assert.deepEqual(w.node.broadcasts, []);
});

test('a confirmation answered with a changed transaction is refused, recorded unknown and never broadcast', async t => {
  const w = world(t, { bound: await bindFixture() });
  w.open({});
  w.node.altered = true;
  const lease = await w.lease(), tx = w.signedTransfer(1);
  await assert.rejects(w.confirm(tx), { code: 'signed_bytes_changed' });
  const records = await w.records(tx);
  assert.deepEqual(states(records), ['signed', 'confirm-started', 'confirm-unknown']);
  assert.equal(records[2].cause.code, 'signed_bytes_changed');
  await assert.rejects(w.prepareBroadcast(lease.leaseId, tx.hash), { code: 'native_confirmation_required' });
  assert.deepEqual(w.node.broadcasts, []);
});

test('a confirmation the seller policy refuses is refused, recorded unknown and never broadcast', async t => {
  const w = world(t, { bound: await bindFixture() });
  w.open({}, { approveConfirmedWrite: async () => false });
  const lease = await w.lease(), tx = w.signedTransfer(1);
  await assert.rejects(w.confirm(tx), { code: 'approval_required' });
  const records = await w.records(tx);
  assert.deepEqual(states(records), ['signed', 'confirm-started', 'confirm-unknown']);
  assert.equal(records[2].cause.code, 'approval_required');
  await assert.rejects(w.prepareBroadcast(lease.leaseId, tx.hash), { code: 'native_confirmation_required' });
  assert.deepEqual(w.node.broadcasts, []);
});

test('a transfer above the fee ceiling is refused at confirmation before the node sees it, and one at the ceiling is confirmed', async t => {
  const w = world(t, { bound: await bindFixture() });
  w.open({});
  await w.lease();
  const over = w.signedTransfer(1, '50000000001');
  await assert.rejects(w.confirm(over), { code: 'write-fee-cap' });
  assert.equal(w.node.confirms, 0);
  assert.deepEqual(await w.records(over), []);
  assert.equal((await w.confirm(w.signedTransfer(1, '50000000000'))).response.data.valid, true);
  assert.equal(w.node.confirms, 1);
});

test('a second transaction signed in a lease that already retained one is refused', async t => {
  const w = world(t, { bound: await bindFixture() });
  w.open({});
  await w.lease();
  await w.confirm(w.signedTransfer(1));
  await assert.rejects(w.confirm(w.signedTransfer(2)), { code: 'eb_operation_signed' });
  assert.equal(w.node.confirms, 1);
});

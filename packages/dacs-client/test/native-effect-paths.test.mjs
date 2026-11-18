// The native transport's pinned chain identity and pin version, and its
// effect boundary: the signature lease holds the boundary's connection fence,
// confirmation is retained as its own stage in the dispatch history, and the
// broadcast and CREATE recovery run as boundary passes whose last check sits
// right before the request.
// A lower-case chain identity written with or without 0x is the same pin: it is
// canonicalised once to its bare form, and every lane key and stored binding
// uses that form. Upper-case or padded identities are refused with the
// binder's own cause. A retained transfer stamped by another pin version stays
// readback-only: it is never reconfirmed, resent or re-keyed.
// The real transport and durable journal run in this process against a
// scripted TEST node. No network, chain or funds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TP1_APPROVED_IDENTITY_RECORD, TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES } from '@kynesyslabs/dacs/wire';
import { NetworkBindingError } from '../src/dacs/network-binding.mjs';
import { nativeWalletLaneKey } from '../src/wallet/devnet-native-transport.mjs';
import { bindFixture } from './fixtures/tp1-authority-reader.mjs';
import { createEffectBoundary, cutAppend, flush, setPurchaseAdmission } from './helpers/effect-boundary-fixture.mjs';
import { boundedCreateWorld } from './helpers/native-create-boundary.mjs';
import { JOB_IDS } from './helpers/native-create-world.mjs';
import { CURRENT_PIN, IDENTITY, LANE_PREFIX, PINS, RETIRED_PIN, nativeWorld as world } from './helpers/native-effect-world.mjs';
import { inPass } from './helpers/pass-context-fixture.mjs';

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
  w.open({});
  const { tx } = await w.send(1);
  for (const [key, row] of await w.journalEntries()) {
    if (row.networkBinding) await w.plant(key, { ...row, networkBinding: { ...row.networkBinding, pinVersion: RETIRED_PIN } });
  }
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

test('a transport refuses a missing or malformed boundary with a TypeError and sends with a real one', async t => {
  const w = world(t);
  for (const boundary of [undefined, null, 'boundary', {}, { holdFence() {}, signPass() {} }, { holdFence() {}, signPass() {}, dispatchPass: 1 }]) {
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

test('a confirmation the seller policy refuses is refused after the node acknowledgement is recorded, and never broadcast', async t => {
  const w = world(t, { bound: await bindFixture() });
  w.open({}, { approveConfirmedWrite: async () => false });
  const lease = await w.lease(), tx = w.signedTransfer(1);
  await assert.rejects(w.confirm(tx), { code: 'approval_required' });
  const records = await w.records(tx);
  assert.deepEqual(states(records), ['signed', 'confirm-started', 'confirm-acknowledged']);
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

// Broadcast and recovery through the boundary.
const RECORD_REFUSALS = [[{ ...TP1_APPROVED_IDENTITY_RECORD, recordId: 'self-made/2026-01-01' }, 'tp1_identity_unapproved'],
  [{ ...TP1_APPROVED_IDENTITY_RECORD, network: 'demos-mainnet' }, 'tp1_identity_record_invalid'],
  [{ ...TP1_APPROVED_IDENTITY_RECORD, chainIdentity: TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES[0] }, 'tp1_identity_fixture']];
const CHANGES = [['a stop', 'writes_stopped', w => { w.stopped = true; }],
  ['a re-hold', 'profile_not_admitted', () => setPurchaseAdmission('held')],
  ['a reconnect behind the fence', 'tp1_local_binding_changed', w => { w.bound.current.connectionId = 'TEST-reconnected'; }]];
const NOTHING_SENT = { confirmTx: 1, broadcastTx: 1 };

test('native payment, storage CREATE, confirmation, broadcast and recovery sign and transmit zero times for a mainnet-labelled, self-approved or refused record', async t => {
  const w = world(t), c = await boundedCreateWorld(t);
  for (const [record, code] of RECORD_REFUSALS) {
    await assert.rejects(bindFixture({ record }), { code });
    assert.throws(() => createEffectBoundary({ currentLocal: () => ({}), stopped: async () => false, history: w.history, fence: {}, binding: undefined }), TypeError, 'no binding, no boundary');
  }
  assert.equal(w.node.confirms + w.node.broadcasts.length, 0);
  assert.equal(w.fence.acquired, 0);
  assert.deepEqual(c.calls, { confirmTx: 0, broadcastTx: 0 });
  assert.equal(c.owner.events.length, 0);
});

test('the approved record signs and transmits once on each native path', async t => {
  const w = world(t, { bound: await bindFixture() });
  w.open({});
  const { tx } = await w.send(1);
  assert.equal(w.node.confirms, 1);
  assert.deepEqual(w.node.broadcasts, [tx.hash]);
  assert.deepEqual(states(await w.records(tx)), ['signed', 'confirm-started', 'confirm-acknowledged', 'signed', 'dispatch-started', 'dispatch-acknowledged']);
  const c = await boundedCreateWorld(t), { tx: create } = await c.send(JOB_IDS[0], 1);
  assert.deepEqual(c.calls, NOTHING_SENT);
  assert.deepEqual(await c.world.recover(create), { disposition: 'pending', hash: create.hash, noResend: true });
  assert.deepEqual(c.calls, { confirmTx: 2, broadcastTx: 2 }, 'recovery confirms once and resends once');
  assert.deepEqual((await c.states(create)).slice(6), ['signed', 'recovery-confirm-started', 'recovery-confirm-acknowledged', 'signed', 'recovery-dispatch-started', 'recovery-dispatch-acknowledged']);
});

test('a swap between transmit and recovery leaves recovery readback-only', async t => {
  const c = await boundedCreateWorld(t), { tx } = await c.send(JOB_IDS[0], 1);
  const retained = JSON.stringify(await c.journal.entries());
  c.bound.current.connectionId = 'TEST-swapped';
  assert.deepEqual(await c.world.recover(tx), { disposition: 'pending', hash: tx.hash, noResend: true });
  assert.deepEqual(c.calls, NOTHING_SENT);
  assert.equal(JSON.stringify(await c.journal.entries()), retained, 'recovery keeps the lane key, the bytes and the history');
});

test('the connection changing at fence acquisition, the final authority read and intent persistence signs nothing where signing had not begun and transmits nothing', async t => {
  const bound = await bindFixture(), w = world(t, { bound });
  w.open({});
  // At fence acquisition: no lease is granted, so nothing is signed, and the fence is released.
  const binding = await w.bind();
  w.fence.onAcquire = () => { bound.current.connectionId = 'TEST-moved'; };
  await assert.rejects(w.signature(binding), { code: 'tp1_local_binding_changed' });
  w.fence.onAcquire = null;
  assert.equal(w.fence.released, w.fence.acquired);
  assert.equal(w.node.confirms, 0);
  // At the authority read that starts the signed record, and at the final one of the confirmation pass (its third).
  bound.current.connectionId = 'vector-conn-1';
  const lease = await w.lease(), tx = w.signedTransfer(1), early = w.signedTransfer(9);
  for (const [read, target, expected] of [[1, early, []], [3, tx, ['signed', 'confirm-started', 'confirm-withheld']]]) {
    let reads = 0;
    bound.authority.state.gate = async () => { if (++reads === read) bound.current.connectionId = 'TEST-moved'; };
    await assert.rejects(w.confirm(target), { code: 'tp1_local_binding_changed' });
    bound.authority.state.gate = null;
    bound.current.connectionId = 'vector-conn-1';
    assert.deepEqual(states(await w.records(target)).slice(0, 3), expected);
  }
  // At the persistence of the broadcast intent.
  bound.current.connectionId = 'vector-conn-1';
  await w.release(lease.leaseId);
  const next = await w.lease(), other = w.signedTransfer(2), confirmation = await w.confirm(other);
  await w.prepareBroadcast(next.leaseId, other.hash);
  cutAppend(w, 'dispatch-started', { mutate: () => { bound.current.connectionId = 'TEST-moved'; } });
  await assert.rejects(w.broadcast(confirmation), { code: 'tp1_local_binding_changed' });
  assert.deepEqual(w.node.broadcasts, []);
  assert.deepEqual(states(await w.records(other)).slice(-2), ['dispatch-started', 'dispatch-withheld']);
  assert.equal(w.node.confirms, 1);
});

test('no host ceiling refuses fee_ceiling_required; a 50 DEM debit passes; 50 DEM plus 1 OS refuses before signing; a confirmed debit above the ceiling refuses before broadcast', async t => {
  const none = world(t, { bound: await bindFixture() });
  none.feeCeilingOs = undefined;
  none.open({});
  await assert.rejects(none.lease(), { code: 'fee_ceiling_required' });
  assert.equal(none.fence.released, none.fence.acquired);

  // The signed transfer's edits also remove a 1 DEM gas charge, so the 50 DEM of amount and fees below is a 51 DEM whole debit.
  const w = world(t, { bound: await bindFixture() });
  w.feeCeilingOs = '51000000000';
  w.open({});
  const fees = (network, rpc, additional) => ({ fees: { network_fee: network, rpc_fee: rpc, additional_fee: additional } });
  w.node.gas = fees('1000000000', '1000000000', '0');
  const lease = await w.lease(), edge = w.signedTransfer(1, '48000000000');
  const confirmation = await w.confirm(edge);
  await w.prepareBroadcast(lease.leaseId, edge.hash);
  assert.equal((await w.broadcast(confirmation)).result, 200, 'a confirmed debit of exactly 50 DEM passes');

  for (const [gas, label] of [[fees('1000000000', '1000000000', '1'), 'one OS above'], [fees('1000000000', 1000000000, '0'), 'a fee that is not a decimal string'], [fees('1000000000', '1000000000', undefined), 'a missing fee']]) {
    const retry = world(t, { bound: await bindFixture() });
    retry.feeCeilingOs = '51000000000';
    retry.open({});
    retry.node.gas = gas;
    const own = await retry.lease(), tx = retry.signedTransfer(1, '48000000000'), answer = await retry.confirm(tx);
    await retry.prepareBroadcast(own.leaseId, tx.hash);
    await assert.rejects(retry.broadcast(answer), { code: 'write-fee-cap' }, label);
    assert.deepEqual(retry.node.broadcasts, [], label);
    assert.deepEqual(states(await retry.records(tx)).slice(-2), ['dispatch-started', 'dispatch-withheld'], label);
    assert.equal((await retry.journalEntries()).some(([key]) => key.startsWith(LANE_PREFIX)), false, `${label}: no lane row is written`);
  }
});

test('a native send is broadcast once and stays readback-only across restart; a recovery resend happens at most once and never under a stop or a re-hold', async t => {
  const w = world(t, { bound: await bindFixture() });
  w.open({});
  const { tx } = await w.send(1);
  await w.restart({});
  await assert.rejects(w.lease(), { code: 'outcome_unknown' });
  assert.deepEqual(w.node.broadcasts, [tx.hash]);

  const c = await boundedCreateWorld(t), { tx: create } = await c.send(JOB_IDS[0], 1), pending = { disposition: 'pending', hash: create.hash, noResend: true };
  c.stopped = true;
  assert.deepEqual(await c.world.recover(create), pending);
  c.stopped = false;
  setPurchaseAdmission('held');
  assert.deepEqual(await c.world.recover(create), pending);
  assert.deepEqual(c.calls, NOTHING_SENT, 'a stop or a re-hold sends nothing');
  setPurchaseAdmission('testnet-tp1');
  assert.deepEqual(await c.world.recover(create), pending);
  assert.deepEqual(c.calls, { confirmTx: 2, broadcastTx: 2 }, 'once admitted, recovery resends once');
  assert.deepEqual(await c.world.recover(create), pending);
  c.restart();
  assert.deepEqual(await c.world.recover(create), pending);
  assert.deepEqual(c.calls, { confirmTx: 2, broadcastTx: 2 }, 'neither a repeat nor a restart resends');
});

test('while held, every native path refuses profile_not_admitted with zero signer, fence and transport calls', async t => {
  const w = world(t, { bound: await bindFixture() });
  w.open({});
  const binding = await w.bind(), tx = w.signedTransfer(1), lease = await w.signature(binding), acquired = w.fence.acquired;
  setPurchaseAdmission('held');
  await assert.rejects(w.confirm(tx), { code: 'profile_not_admitted' });
  setPurchaseAdmission('testnet-tp1');
  const confirmation = await w.confirm(tx);
  await w.prepareBroadcast(lease.leaseId, tx.hash);
  setPurchaseAdmission('held');
  await assert.rejects(w.broadcast(confirmation), { code: 'profile_not_admitted' });
  await assert.rejects(w.signature(binding), { code: 'profile_not_admitted' });
  assert.equal(w.fence.acquired, acquired, 'no fence is taken');
  assert.equal(w.node.confirms, 1, 'the one confirmation is the one made while admitted');
  assert.deepEqual(w.node.broadcasts, []);

  setPurchaseAdmission('testnet-tp1');
  const c = await boundedCreateWorld(t), { tx: create } = await c.send(JOB_IDS[0], 1), fences = c.owner.events.length;
  setPurchaseAdmission('held');
  assert.deepEqual(await c.world.recover(create), { disposition: 'pending', hash: create.hash, noResend: true });
  assert.equal(c.owner.events.length, fences, 'recovery takes no fence');
  assert.deepEqual(c.calls, NOTHING_SENT);
});

// Runs `run()` with the transport's next getContext call after `arm`'s trigger held (once), applies `change`, releases it, and returns the outcome.
async function refusedAfterContext(world, arm, run, change) {
  let held;
  arm(() => { held ??= world.gate.hold(); });
  const outcome = run().then(value => ({ value }), error => ({ error }));
  await settleUntil(() => held?.reached === true);
  change();
  held.release();
  return outcome;
}

test("with the real transport's final getContext() held pending, a stop, a re-hold or a reconnect behind the fence, then release: zero fetchImpl calls and the withheld state on initial confirmation, initial broadcast, recovery confirmation and recovery resend", async t => {
  for (const [label, code, change] of CHANGES) {
    const bound = await bindFixture(), w = world(t, { bound });
    w.open({});
    const lease = await w.lease(), tx = w.signedTransfer(1);
    let outcome = await refusedAfterContext(w, mutate => cutAppend(w, 'confirm-started', { mutate }), () => w.confirm(tx), () => change(w));
    assert.equal(outcome.error?.code, code, `initial confirmation after ${label}`);
    assert.equal(w.node.confirms, 0);
    assert.equal(states(await w.records(tx)).at(-1), 'confirm-withheld');
    assert.equal((await w.records(tx)).at(-1).cause.code, code);

    setPurchaseAdmission('testnet-tp1'); w.stopped = false; bound.current.connectionId = 'vector-conn-1';
    await w.release(lease.leaseId);
    const next = await w.lease(), other = w.signedTransfer(2), confirmation = await w.confirm(other);
    await w.prepareBroadcast(next.leaseId, other.hash);
    outcome = await refusedAfterContext(w, mutate => cutAppend(w, 'dispatch-started', { mutate }), () => w.broadcast(confirmation), () => change(w));
    assert.equal(outcome.error?.code, code, `initial broadcast after ${label}`);
    assert.deepEqual(w.node.broadcasts, []);
    assert.equal(states(await w.records(other)).at(-1), 'dispatch-withheld');

    setPurchaseAdmission('testnet-tp1');
    const c = await boundedCreateWorld(t), { tx: create } = await c.send(JOB_IDS[0], 1);
    outcome = await refusedAfterContext(c, mutate => cutAppend(c, 'recovery-confirm-started', { mutate }), () => c.world.recover(create), () => change(c));
    assert.equal(outcome.value?.disposition, 'pending');
    assert.deepEqual(c.calls, NOTHING_SENT, `recovery confirmation after ${label}`);
    assert.equal((await c.states(create)).at(-1), 'recovery-confirm-withheld');
    assert.equal((await c.records(create)).at(-1).cause.code, code);
  }
  for (const [label, code, change] of CHANGES) {
    setPurchaseAdmission('testnet-tp1');
    const c = await boundedCreateWorld(t), { tx: create } = await c.send(JOB_IDS[0], 1);
    const outcome = await refusedAfterContext(c, rearm => c.world.capability.onStorageWriteResend(rearm), () => c.world.recover(create), () => change(c));
    assert.equal(outcome.value?.disposition, 'pending');
    assert.deepEqual(c.calls, { confirmTx: 2, broadcastTx: 1 }, `recovery resend after ${label}`);
    assert.equal((await c.states(create)).at(-1), 'recovery-dispatch-withheld');
    assert.equal((await c.records(create)).at(-1).cause.code, code);
  }
});

test('a job pass is withheld when its current-authorization check refuses, is missing, answers false or answers asynchronously, and transmits once when it answers true', async t => {
  const refused = Object.assign(new Error('TEST-settlement-credit-gone'), { code: 'TEST_credit_gone' });
  for (const operationClass of ['job-create', 'payment-evidence', 'job-resume']) {
    const w = world(t, { bound: await bindFixture() });
    w.open({});
    await w.lease();
    const tx = w.signedTransfer(1), body = { method: 'execute', params: [{ extra: 'confirmTx', data: tx, operationClass: 'job-create', currentAuthorization: () => true }] };
    for (const [check, code] of [[undefined, 'context_authorization_required'], [() => false, 'context_authorization_refused'], [async () => true, 'context_authorization_refused'], [() => { throw refused; }, 'TEST_credit_gone']]) {
      await assert.rejects(inPass({ operationClass, currentAuthorization: check }, () => w.transport().rpc(body, w.authHeaders())), error => error.code === code && (code !== 'TEST_credit_gone' || error === refused), `${operationClass} with ${String(check)}`);
      assert.equal(w.node.confirms, 0);
      assert.equal((await w.records(tx)).at(-1).cause.code, code);
    }
    assert.equal((await inPass({ operationClass, currentAuthorization: () => true }, () => w.confirm(tx))).response.data.valid, true);
    assert.equal(w.node.confirms, 1);
  }
});

test('a check that starts refusing during the final context wait makes zero requests and keeps its cause', async t => {
  const w = world(t, { bound: await bindFixture() });
  w.open({});
  await w.lease();
  const tx = w.signedTransfer(1), refused = Object.assign(new Error('TEST-ownership-lost'), { code: 'TEST_ownership_lost' });
  let owned = true;
  const outcome = await refusedAfterContext(w, mutate => cutAppend(w, 'confirm-started', { mutate }),
    () => inPass({ operationClass: 'job-create', currentAuthorization: () => { if (!owned) throw refused; return true; } }, () => w.confirm(tx)), () => { owned = false; });
  assert.equal(outcome.error, refused);
  assert.equal(w.node.confirms, 0);
  assert.equal((await w.records(tx)).at(-1).state, 'confirm-withheld');
});

test("a pass that names an operation id gives the lease's records that id", async t => {
  const w = world(t, { bound: await bindFixture() });
  w.open({});
  const binding = await w.bind(), lease = await inPass({ operationId: 'TEST-job-operation' }, () => w.signature(binding)), tx = w.signedTransfer(1);
  const confirmation = await w.confirm(tx);
  await w.prepareBroadcast(lease.leaseId, tx.hash);
  await w.broadcast(confirmation);
  assert.ok((await w.records(tx)).length > 0 && (await w.records(tx)).every(record => record.operationId === 'TEST-job-operation'));
});

test('a broadcast that is not the retained confirmation, byte for byte with its gas, is refused and sends nothing', async t => {
  const w = world(t, { bound: await bindFixture() });
  w.open({});
  w.node.gas = { fees: { network_fee: '1000000000', rpc_fee: '1000000000', additional_fee: '0' } };
  const lease = await w.lease(), tx = w.signedTransfer(1), confirmation = await w.confirm(tx);
  await w.prepareBroadcast(lease.leaseId, tx.hash);
  const cheaper = structuredClone(confirmation);
  cheaper.response.data.gas_operation.fees.network_fee = '1';
  await assert.rejects(w.broadcast(cheaper), { code: 'native_confirmation_required' });
  assert.deepEqual(w.node.broadcasts, []);
  assert.equal((await w.broadcast(confirmation)).result, 200);
  assert.deepEqual(w.node.broadcasts, [tx.hash]);
});

// The tests below run the real Node wallet session over the real transport, effect boundary and SQLite journal, with only the node scripted.
const { fork } = await import('node:child_process');
const { once } = await import('node:events');
const { fileURLToPath } = await import('node:url');
const { finalizedWorld, cutHistory } = await import('./helpers/finalized-node-world.mjs');
const { agreementRequest } = await import('./helpers/tp1-node-fixture.mjs');
const { createDemosSr2WalletBridge } = await import('../src/dacs/demos-sr2-wallet-bridge.mjs');
const { gateWorld, openPass } = await import('./helpers/effect-gate-world.mjs');
const { passContext } = await import('../src/wallet/pass-context.mjs');
const { OS_IDENTITY } = await import('../src/wallet/holder-incarnation.mjs');
const { resumeRetainedConfirmation } = await import('./helpers/resume-retained-confirmation.mjs');
const CHILD = fileURLToPath(new URL('./helpers/finalized-node-child.mjs', import.meta.url));

test('through the Node wallet session a send survives a restart at each history cut, refuses at each barrier, never resends a lost answer and honours the host fee ceiling', async t => {
  for (const cut of ['before-signed', 'signed', 'signed-held', 'dispatch-started', 'dispatch-acknowledged']) await t.test('restart after ' + cut, async t => {
    let armed = true;
    const w = await finalizedWorld(t, { journalWrap: journal => ({ ...journal, appendUnderLock: async (lane, key, record) => {
      if (armed && cut === 'before-signed' && record.state === 'signed') { armed = false; throw Object.assign(new Error('TEST-write-failed'), { code: 'EIO' }); }
      await journal.appendUnderLock(lane, key, record);
      if (cut === 'signed-held' && record.state === 'signed') w.state.stopped = true;
      if (armed && record.state === cut) { armed = false; throw new Error('TEST-crash-after-' + cut); }
    } }) });
    await w.build();
    const request = w.request();
    await w.send(request);
    const before = w.node.broadcasts.length, retained = await w.records();
    assert.ok(cut === 'before-signed' || retained.some(record => record.state === cut), cut);
    const next = await w.restart();
    next.state.stopped = false;
    await next.send(request);
    // Signed bytes the node never saw (no record past `signed`) go out once when the same request comes again.
    assert.equal(next.node.broadcasts.length, cut === 'before-signed' || cut === 'signed' ? 1 : before, cut);
    if (retained[0]?.bytes && next.node.broadcasts[0]) assert.equal(JSON.stringify(next.node.broadcasts[0]), Buffer.from(retained[0].bytes, 'base64').toString());
  });
  for (const phase of ['signed', 'confirm-started', 'dispatch-started']) {
    for (const change of ['stop', 'hold', 'connection']) await t.test(`a ${change} right after ${phase} withholds the send`, async t => {
      const w = await finalizedWorld(t, { journalWrap: cutHistory(record => {
        if (record.state !== phase) return;
        if (change === 'stop') w.state.stopped = true;
        if (change === 'hold') setPurchaseAdmission('held');
        if (change === 'connection') w.owner.replaceConnection();
      }) });
      await w.build(); await w.send();
      assert.equal(w.node.broadcasts.length, 0);
      assert.ok((await w.records()).some(record => /held|withheld/.test(record.state)), phase + '/' + change);
      if (phase === 'dispatch-started') {
        const next = await w.restart(); next.state.stopped = false;
        await next.send(); assert.equal(next.node.broadcasts.length, 0, 'a withheld broadcast stays readback-only after restart');
      }
    });
  }
  await t.test('a lost broadcast answer is never resent', async t => {
    const w = await finalizedWorld(t); await w.build(); w.node.mode = 'drop';
    await w.send();
    assert.equal(w.node.broadcasts.length, 1);
    const next = await w.restart(); await next.send();
    assert.equal(next.node.broadcasts.length, 1);
    assert.ok((await next.records()).some(record => record.state === 'dispatch-unknown'));
  });
  await t.test('the host fee ceiling includes the fee and has no default', async t => {
    const w = await finalizedWorld(t, { input: { feeCeilingOs: '1' } }); await w.build();
    assert.equal((await w.send()).success, false); assert.equal(w.node.broadcasts.length, 0);
  });
});

test('a job pass transmits only while its current-authorization check answers true, and a seller pass without a job context is refused', async t => {
  for (const operationClass of ['job-create', 'payment-evidence', 'job-resume']) {
    for (const check of ['missing', 'false', 'thenable', 'withdrawn before the boundary check', 'withdrawn while the pass awaits', 'allowed']) await t.test(`${operationClass} pass, check ${check}`, async t => {
      let current = true;
      const cause = Object.assign(new Error('TEST-current-authorization'), { code: 'context_admission_closed' });
      const w = await gateWorld(t, { seller: false, journalWrap: cutHistory(record => { if (check === 'withdrawn before the boundary check' && record.state === 'dispatch-started') current = false; }) });
      const currentAuthorization = check === 'missing' ? undefined : () => {
        if (check === 'false') return false;
        if (check === 'thenable') return Promise.resolve(true);
        if (!current) throw cause;
        return true;
      };
      const context = passContext({ operationClass, currentAuthorization });
      const finalStop = ({ phase }) => { if (check === 'withdrawn while the pass awaits' && phase === 'broadcastTx') current = false; };
      const result = await (await openPass(w, { pass: { context, finalStop } })).run(() => w.send());
      assert.equal(w.node.broadcasts.length, check === 'allowed' ? 1 : 0);
      if (check === 'withdrawn before the boundary check') assert.ok((await w.journal().entries()).some(([, record]) => record.state === 'dispatch-withheld'));
      if (check.startsWith('withdrawn')) {
        let error = w.session.internalCauseOf(result);
        while (error && error !== cause) error = error.cause;
        assert.equal(error, cause, 'the check\'s own error is kept');
      }
    });
  }
  await t.test('a seller composition takes only a job pass: a pass with no context, a plain context or a context passContext did not make is refused and signs, confirms and sends nothing', async t => {
    const w = await gateWorld(t);
    const lease = await w.currentOwner().acquireConnectionFence();
    const base = { fence: lease, deadline: w.clock.now() + 1000, refreshAuthority: async () => {}, finalStop: async () => {}, synchronousChecks: [], feeCeilingOs: '50000000000' };
    for (const context of [undefined, passContext(), {}, { operationClass: 'job-create', currentAuthorization: () => true }]) {
      assert.throws(() => w.session.effectPass({ ...base, ...(context === undefined ? {} : { context }) }), { code: 'effect_pass_invalid' });
    }
    assert.equal(typeof w.session.effectPass({ ...base, context: passContext({ operationClass: 'job-create', currentAuthorization: () => true }) }), 'object');
    // A host's pass made without a context, then a send in it.
    let outcome;
    try { outcome = await w.session.runInEffectPass(w.session.effectPass(base), () => w.send()); } catch (error) { outcome = error; } finally { lease.release(); }
    assert.equal(outcome?.code, 'effect_pass_invalid');
    assert.deepEqual({ signs: w.innerSigns.length, confirms: w.node.confirms.length, broadcasts: w.node.broadcasts.length }, { signs: 0, confirms: 0, broadcasts: 0 });
  });
});

test('the Node wallet session refuses construction without a stop check and asks it at each effect boundary stage', async t => {
  const absent = await finalizedWorld(t, { input: { stopped: undefined } });
  await assert.rejects(absent.build(), TypeError);
  for (const at of [1, 3, 4, 5]) {
    let calls = 0;
    const w = await finalizedWorld(t, { input: { stopped: async () => ++calls === at } });
    await w.build(); await w.send();
    assert.equal(w.node.broadcasts.length, 0, 'stop read ' + at);
    assert.ok(calls >= at);
  }
});

test('a session built without a positive fee ceiling, or whose build fails, is refused with its key zeroed and no connection fence held', async t => {
  for (const feeCeilingOs of [undefined, null, '', 0, '0', '01', '-1']) {
    const w = await finalizedWorld(t, { input: { feeCeilingOs } });
    await assert.rejects(w.build(), TypeError);
    assert.ok(w.key.every(byte => byte === 0));
    assert.deepEqual(w.effects(), []);
    assert.equal(w.session, undefined);
  }
  const withoutHistoryMethods = { get: async () => null, put: async () => {}, entries: async () => [], withWalletLock: async (key, work) => work() };
  for (const input of [{ journal: {} }, { journal: withoutHistoryMethods }, { key: Uint8Array.of(255) }]) {
    const w = await finalizedWorld(t, { input });
    await assert.rejects(w.build(), input.journal ? TypeError : () => true);
    assert.ok((input.key ?? w.key).every(byte => byte === 0));
    assert.equal(w.session, undefined);
    (await w.owner.acquireConnectionFence()).release();
  }
});

test('through the Node wallet session a crash after confirmation is resumed once from the original bytes, a lost confirmation sends nothing, and a killed holder is recovered only when provably dead', async t => {
  await t.test('a confirmation acknowledged before the crash is broadcast once from the retained bytes after restart, with no lane record before the broadcast', async t => {
    let cut = true;
    const w = await finalizedWorld(t, { journalWrap: cutHistory(record => { if (cut && record.state === 'confirm-acknowledged') { cut = false; throw new Error('TEST-after-confirm'); } }) });
    await w.build(); const request = w.request(); await w.send(request);
    assert.equal(w.node.broadcasts.length, 0);
    assert.ok((await w.records()).some(record => record.state === 'confirm-acknowledged'));
    assert.ok(!(await w.journal.entries()).some(([key]) => key.startsWith('devnet/native-wallet/') || key.startsWith('devnet/native-transfer/')));
    const next = await w.restart();
    await resumeRetainedConfirmation(next);
    assert.equal(next.node.broadcasts.length, 1);
    assert.deepEqual(next.node.broadcasts[0], next.node.confirms[next.node.confirms.length - 1]);
    assert.equal(JSON.stringify(next.node.broadcasts[0]), Buffer.from((await next.records()).find(record => record.bytes).bytes, 'base64').toString());
  });
  await t.test('a lost confirmation answer is recorded unknown across a restart and nothing is broadcast', async t => {
    const w = await finalizedWorld(t); await w.build(); w.node.mode = 'confirm-lost'; await w.send();
    assert.ok((await w.records()).some(record => record.state === 'confirm-unknown'));
    const next = await w.restart(); assert.equal(w.node.broadcasts.length, 0);
    assert.ok((await next.records()).some(record => record.state === 'confirm-unknown'));
  });
  await t.test('a confirmation whose gas changed before the broadcast is refused and nothing is broadcast', async t => {
    const w = await finalizedWorld(t); await w.build();
    const boundary = w.session.effectBoundary, dispatch = boundary.dispatchPass;
    t.mock.method(boundary, 'dispatchPass', async (operation, send, options) => {
      const answer = await dispatch(operation, send, options);
      if (options?.stage === 'confirm') answer.response.data.gas_operation = { fees: { network_fee: '1', rpc_fee: '0', additional_fee: '0' } };
      return answer;
    });
    await w.send(); assert.equal(w.node.broadcasts.length, 0);
  });
  await t.test('an uncrashed send confirms and then broadcasts', async t => {
    const w = await finalizedWorld(t); await w.build(); assert.equal((await w.send()).success, true);
    assert.deepEqual(w.effects(), ['confirmTx', 'broadcastTx']);
  });
  for (const cut of ['confirm-acknowledged', 'signed-held', 'dispatch-started']) await t.test('a real child killed at ' + cut + ' leaves a lock that only proof of death recovers', async t => {
    const w = await finalizedWorld(t); const path = w.path; await w.close();
    const child = fork(CHILD, [path, cut], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = once(child, 'exit');
    t.after(() => child.kill('SIGKILL'));
    const [message] = await Promise.race([once(child, 'message'), exited.then(([exit]) => { throw new Error('TEST-child-exited:' + exit); })]);
    assert.equal(message.record.state, cut);
    const paused = await finalizedWorld(t, { path, journalOptions: { lockTimeoutMs: 1 } }); await paused.build();
    assert.equal((await paused.send()).success, false, 'a live paused owner stays busy');
    await paused.close();
    child.kill('SIGKILL'); assert.equal((await exited)[1], 'SIGKILL');
    if (cut === 'confirm-acknowledged') {
      const unproven = await finalizedWorld(t, { path, journalOptions: { lockTimeoutMs: 0, identity: { ...OS_IDENTITY, self: null } } });
      await unproven.build();
      for (let repeat = 0; repeat < 3; repeat++) assert.equal((await unproven.send()).success, false, 'no identity and repeated timeout never prove death');
      await unproven.close();
      const originalLive = await finalizedWorld(t, { path, journalOptions: { lockTimeoutMs: 0, identity: { ...OS_IDENTITY, runningStart: () => message.namespace.start } } });
      await originalLive.build(); assert.equal((await originalLive.send()).success, false, 'the original start still appears live'); await originalLive.close();
      const racers = Array.from({ length: 2 }, () => {
        const racer = fork(CHILD, [path, 'recover-race'], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        const exit = once(racer, 'exit');
        t.after(() => racer.kill('SIGKILL'));
        return { racer, exit, reply: once(racer, 'message') };
      });
      const replies = await Promise.all(racers.map(async ({ reply, exit }) => (await Promise.race([reply, exit.then(() => { throw new Error('TEST-racer-exited'); })]))[0]));
      assert.equal(replies.filter(reply => reply.event === 'cut').length, 1, 'one new owner reaches confirmation');
      assert.equal(replies.filter(reply => reply.event === 'done' && reply.success === false).length, 1, 'the other remains busy');
      for (const { racer, exit } of racers) { racer.kill('SIGKILL'); await exit; }
    }
    const next = await finalizedWorld(t, { path, journalOptions: { identity: { ...OS_IDENTITY, runningStart: () => 'TEST-different-start' } } }); await next.build();
    assert.ok((await next.records()).some(record => record.state === cut), 'recovery preserves the committed history');
    if (cut === 'confirm-acknowledged') await resumeRetainedConfirmation(next);
    if (cut === 'dispatch-started') { await next.send(); await next.send(); }
    assert.equal(next.node.broadcasts.length, cut === 'confirm-acknowledged' ? 1 : 0);
    if (cut === 'confirm-acknowledged') assert.equal(JSON.stringify(next.node.broadcasts[0]), Buffer.from((await next.records()).find(record => record.bytes).bytes, 'base64').toString());
  });
});

test('a wallet request whose answer is lost after the node took the CREATE is reconciled by readback after a restart without a second CREATE', async t => {
  let w = await finalizedWorld(t); await w.build();
  const request = await agreementRequest(w, { complete: true }), raw = request.params[0];
  w.node.intercept = row => row.body.params[0].message === 'searchStoragePrograms'
    ? new Response(JSON.stringify({ result: 200, response: [], require_reply: false, extra: null }), { headers: { 'content-type': 'application/json' } }) : undefined;
  const bridge = () => createDemosSr2WalletBridge({ rpcUrl: w.owner.local.endpoint, network: w.session.wallet.getWriteProfile().network, journal: w.journal,
    sourceCapability: w.session.transport, walletFactory: options => {
      const wallet = w.session.walletFactory(options);
      return { ...wallet, request: async input => { const answer = await wallet.request(input); return answer.success ? { success: false, error: { code: 'outcome_unknown' } } : answer; } };
    }, fetchImpl: w.node.fetch, now: w.clock.now });
  const input = { writer: raw.owner, artifactKind: 'Agreement', logicalAddress: raw.logicalAddress, artifact: raw.transaction.content.data[1].data };
  const first = await bridge().anchor(input);
  assert.equal(first.status, 'indeterminate');
  assert.equal(w.node.broadcasts.length, 1);
  assert.ok((await w.records()).some(record => record.state === 'dispatch-acknowledged'));
  w = await w.restart();
  await bridge().anchor(input);
  assert.equal(w.node.broadcasts.length, 1, 'the issued plan reconciles without another CREATE');
});

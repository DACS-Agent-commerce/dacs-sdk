// The held transport facade's `rpc` takes an optional relay check as a third argument. The native
// transport runs it as its last synchronous check before each node send of that call.
// The real transport and durable journal run in this process against a scripted TEST node.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeWalletLaneKey } from '../src/wallet/devnet-native-transport.mjs';
import { passContext, runInPassContext } from '../src/wallet/pass-context.mjs';
import { bindFixture } from './fixtures/tp1-authority-reader.mjs';
import { cutAppend, flush, refusedAfterContext, setPurchaseAdmission } from './helpers/effect-boundary-fixture.mjs';
import { LANE_PREFIX, PINS, nativeWorld as world } from './helpers/native-effect-world.mjs';

// Loaded after the admission hook, so the transport under test sees the admission double.
const { createHeldTransportFacade, ...nodeWalletEntry } = await import('../src/wallet/node-wallet-session.mjs');

const states = records => records.map(record => record.state);
const closed = Object.assign(new Error('TEST-relay-authority-closed'), { code: 'TEST_relay_authority_closed' });
const live = () => true;
const authorityUntil = state => () => { if (state.closed) throw closed; return true; };

// A facade over the world's real transport. `events` lists the node requests in order, with each call
// of the relay's check among them, so a test can see that the check came last before each send.
async function relayWorld(t) {
  const bound = await bindFixture(), w = world(t, { bound }), events = [];
  w.open({}, { fetchImpl: (url, init) => { const call = JSON.parse(init.body).params[0]; events.push(call.extra ?? call.message); return w.node.fetch(url, init); } });
  const facade = createHeldTransportFacade({ admission: { binding: bound.binding, currentLocal: bound.currentLocal }, transport: w.transport() });
  const relayed = check => (check === undefined ? undefined : { currentAuthorization: () => { events.push('check'); return check(); } });
  const send = (extra, data, check) => facade.rpc({ method: 'execute', params: [{ extra, data }] }, w.authHeaders(), relayed(check));
  return { w, facade, events, relayed, confirm: (tx, check) => send('confirmTx', tx, check), broadcast: (confirmation, check) => send('broadcastTx', confirmation, check) };
}

// A signed transfer under a live lease, confirmed through the transport directly and ready to broadcast.
async function readyToBroadcast(r) {
  const lease = await r.w.lease(), tx = r.w.signedTransfer(1), confirmation = await r.w.confirm(tx);
  await r.w.prepareBroadcast(lease.leaseId, tx.hash);
  return { tx, confirmation };
}

const lanes = async w => (await w.journalEntries()).filter(([key]) => key.startsWith(LANE_PREFIX));
const checkCount = r => r.events.filter(event => event === 'check').length;
const withheldCause = async (w, tx) => (await w.records(tx)).at(-1).cause.code;

test("a relayed confirmTx and broadcastTx run the relay's check last before each node request, send once each when it answers true, and run no check for a preparation read or for a confirmation the retained record answers", async t => {
  const r = await relayWorld(t), lease = await r.w.lease(), tx = r.w.signedTransfer(1);
  const read = await r.facade.rpc({ method: 'nodeCall', params: [{ message: 'getAddressNonce', data: { address: r.w.address } }] }, r.w.authHeaders(), r.relayed(live));
  assert.equal(read.result, 200);
  assert.equal(checkCount(r), 0, 'a preparation read runs no check');

  const confirmation = await r.confirm(tx, live);
  assert.equal(confirmation.response.data.valid, true);
  assert.equal(r.w.node.confirms, 1);
  assert.equal(checkCount(r), 1);
  assert.equal(r.events[r.events.lastIndexOf('confirmTx') - 1], 'check', 'the check runs right before the confirmation request');

  const seen = r.events.length;
  assert.deepEqual(await r.confirm(tx, live), confirmation);
  assert.equal(r.events.length, seen, 'the retained record answers a repeated confirmation with no check and no node request');

  await r.w.prepareBroadcast(lease.leaseId, tx.hash);
  assert.equal((await r.broadcast(confirmation, live)).result, 200);
  assert.deepEqual(r.w.node.broadcasts, [tx.hash]);
  assert.equal(checkCount(r), 3, 'a broadcast runs the check at the dispatch and again at the last check');
  const at = r.events.lastIndexOf('broadcastTx');
  assert.deepEqual(r.events.slice(at - 1, at + 1), ['check', 'broadcastTx'], 'the check runs right before the broadcast request');
});

test('a relayed send whose check throws, answers false or answers asynchronously sends nothing, keeps the thrown object or answers context_authorization_refused, and records the stage withheld', async t => {
  const refusals = [['throws', () => { throw closed; }, error => error === closed, closed.code],
    ['answers false', () => false, error => error.code === 'context_authorization_refused', 'context_authorization_refused'],
    ['answers asynchronously', async () => true, error => error.code === 'context_authorization_refused', 'context_authorization_refused']];
  for (const [label, check, answersWith, cause] of refusals) {
    const confirming = await relayWorld(t), tx = confirming.w.signedTransfer(1);
    await confirming.w.lease();
    await assert.rejects(confirming.confirm(tx, check), answersWith, `confirmTx check ${label}`);
    assert.equal(confirming.w.node.confirms, 0);
    assert.equal(states(await confirming.w.records(tx)).at(-1), 'confirm-withheld');
    assert.equal(await withheldCause(confirming.w, tx), cause);

    const broadcasting = await relayWorld(t), ready = await readyToBroadcast(broadcasting);
    await assert.rejects(broadcasting.broadcast(ready.confirmation, check), answersWith, `broadcastTx check ${label}`);
    assert.deepEqual(broadcasting.w.node.broadcasts, []);
    assert.deepEqual(await lanes(broadcasting.w), [], 'a refusal at the dispatch retains no lane or intent record');
    assert.equal(states(await broadcasting.w.records(ready.tx)).at(-1), 'dispatch-withheld');
  }

  // A lease granted through walletBinding sends nothing once the authority has closed: the next relayed send refuses.
  const r = await relayWorld(t), tx = r.w.signedTransfer(1), state = { closed: false };
  const { binding } = await r.facade.walletBinding({ phase: 'bind', address: r.w.address }, r.w.authHeaders());
  await r.facade.walletBinding({ phase: 'signature', address: r.w.address, binding }, r.w.authHeaders());
  state.closed = true;
  await assert.rejects(r.confirm(tx, authorityUntil(state)), error => error === closed);
  assert.equal(r.w.node.confirms, 0);
});

test('relay authority closing while the wallet lane is held by a second holder sends nothing and leaves the lane free', async t => {
  const r = await relayWorld(t), { tx, confirmation } = await readyToBroadcast(r), state = { closed: false };
  const laneKey = nativeWalletLaneKey(PINS, r.w.address);
  let release, taken;
  const holding = new Promise(resolve => { release = resolve; }), took = new Promise(resolve => { taken = resolve; });
  const holder = r.w.journal().withWalletLock(laneKey, async () => { taken(); await holding; });
  await took;
  const outcome = r.broadcast(confirmation, authorityUntil(state)).then(value => ({ value }), error => ({ error }));
  for (let waits = 0; waits < 5; waits++) await flush();
  assert.equal(checkCount(r), 0, 'the broadcast is still waiting for the lane');
  state.closed = true;
  release();
  await holder;
  assert.equal((await outcome).error, closed);
  assert.deepEqual(r.w.node.broadcasts, []);
  assert.deepEqual(await lanes(r.w), []);

  const next = await r.w.lease(), again = await r.confirm(tx, live);
  await r.w.prepareBroadcast(next.leaseId, tx.hash);
  assert.equal((await r.broadcast(again, live)).result, 200);
  assert.deepEqual(r.w.node.broadcasts, [tx.hash]);
});

test('relay authority closing during the final transport-context wait sends nothing', async t => {
  const r = await relayWorld(t), tx = r.w.signedTransfer(1), state = { closed: false };
  await r.w.lease();
  const outcome = await refusedAfterContext(r.w, mutate => cutAppend(r.w, 'confirm-started', { mutate }), () => r.confirm(tx, authorityUntil(state)), () => { state.closed = true; });
  assert.equal(outcome.error, closed);
  assert.equal(r.w.node.confirms, 0);
  assert.equal(states(await r.w.records(tx)).at(-1), 'confirm-withheld');
  assert.equal(await withheldCause(r.w, tx), closed.code);
});

test('a broadcast whose relay check passes at dispatch and refuses at the last check sends nothing and finishes its lane withheld', async t => {
  const r = await relayWorld(t), { tx, confirmation } = await readyToBroadcast(r);
  let calls = 0;
  await assert.rejects(r.broadcast(confirmation, () => { if (++calls > 1) throw closed; return true; }), error => error === closed);
  assert.equal(calls, 2);
  assert.deepEqual(r.w.node.broadcasts, []);
  assert.equal(states(await r.w.records(tx)).at(-1), 'dispatch-withheld');
  const [[, lane]] = await lanes(r.w);
  assert.equal(lane.stage, 'failed');
  assert.equal(lane.failure.withheld, true);
});

test('the relay option is refused when malformed or inside a job pass, before the hold and before any transport call, a held profile refuses before the check is called, and no host can make a relay context', async t => {
  const r = await relayWorld(t), tx = r.w.signedTransfer(1), body = { method: 'execute', params: [{ extra: 'confirmTx', data: tx }] };
  await r.w.lease();
  const seen = r.events.length;
  setPurchaseAdmission('held');
  const malformed = [['null', null], ['empty', {}], ['array', []], ['a check that is not a function', { currentAuthorization: 'yes' }], ['an extra member', { currentAuthorization: live, extra: live }]];
  for (const [label, option] of malformed) {
    await assert.rejects(r.facade.rpc(body, r.w.authHeaders(), option), error => error instanceof TypeError && error.message === 'relay_authorization_invalid', label);
  }
  await assert.rejects(runInPassContext(passContext({ operationClass: 'job-create', currentAuthorization: live }), () => r.facade.rpc(body, r.w.authHeaders(), { currentAuthorization: live })),
    error => error.code === 'relay_authorization_nested');
  assert.equal(r.events.length, seen, 'no refusal reaches the transport');

  await assert.rejects(r.facade.rpc(body, r.w.authHeaders(), r.relayed(live)), { code: 'profile_not_admitted' });
  assert.equal(checkCount(r), 0, 'a held profile refuses before the check is called');

  assert.throws(() => passContext({ operationClass: 'wallet-relay' }), TypeError);
  const root = await import('../src/index.mjs');
  for (const entry of [root, nodeWalletEntry]) for (const name of ['relayPassContext', 'runInPassContext', 'currentPassContext', 'isPassContext']) assert.equal(name in entry, false, name);
});

test("without the option the facade's rpc is unchanged: a plain relayed confirmTx sends once with no check, and the same call with the option and a refusing check sends nothing", async t => {
  const plain = await relayWorld(t), plainTx = plain.w.signedTransfer(1);
  await plain.w.lease();
  assert.equal((await plain.confirm(plainTx)).response.data.valid, true);
  assert.equal(plain.w.node.confirms, 1);
  assert.equal(checkCount(plain), 0);

  const refused = await relayWorld(t), refusedTx = refused.w.signedTransfer(1);
  await refused.w.lease();
  await assert.rejects(refused.confirm(refusedTx, () => false), { code: 'context_authorization_refused' });
  assert.equal(refused.w.node.confirms, 0);
  assert.equal(checkCount(refused), 1);
});

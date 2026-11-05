// P15a: the effect boundary's await-point barriers (K0-F1 to K0-F19). A barrier parks the
// pass at one await; the test changes the connection, KILL, the guard, the K1 revision
// or the private current authorization there, and the pass must sign or transmit nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTp1Binding } from '@kynesyslabs/dacs/wire';
import { jobPassContext } from '../src/dacs/effect-boundary.mjs';
import { SIGNED_BYTES, ebWorld, flush, gate, stillPending } from './helpers/effect-boundary-fixture.mjs';

const FENCE_WAIT = 'the fence wait';
const FINAL_AUTHORITY_READ = 'the final authority read';
const FINAL_STOP_READ = 'the final stop read';
const ALL_BARRIERS = [FENCE_WAIT, FINAL_AUTHORITY_READ, FINAL_STOP_READ];
const DEADLINE_MS = 10000;
const BYPASS = (w) => { w.control.local = { ...w.control.local, connectionId: 'bypassing-connection' }; };
const states = async (history, lane = 'lane-1') => (await history.read(lane)).map((record) => record.state);

// The three reads of a standalone signPass: EB4's pre-check, EB5r's refresh (the final authority read) and EB7's. Stops: EB2, the refresh, the final one.
async function parkSignPass(t, barrier, change) {
  const w = await ebWorld(t);
  const { boundary } = w.build();
  const state = change.setup?.() ?? {};
  const op = w.op(change.operation?.(state));
  const park = gate();
  let pass;
  const background = [];
  if (barrier === FENCE_WAIT) {
    background.push(boundary.withFence(w.op({ operationId: 'holder', lane: 'lane-h' }), async () => { await park.arrive(); }));
    await park.reached;
    if (change.replace) background.push(boundary.replaceConnection(async () => change.replace(w)));
    pass = boundary.signPass(op, w.sign(), { context: state.context });
    await flush();
  } else {
    if (barrier === FINAL_AUTHORITY_READ) w.control.readHook = async (n, scope, base) => { if (n === 2) await park.arrive(); return base(scope); };
    else w.control.stopHook = async (n) => { if (n === 3) await park.arrive(); return w.control.stopped; };
    pass = boundary.signPass(op, w.sign(), { context: state.context });
    await park.reached;
  }
  change.apply?.(w, state);
  park.release();
  const outcome = await pass.then(() => 'signed', (error) => error);
  await Promise.all(background);
  return { w, state, outcome };
}

const authorizationChange = (name, cause) => ({
  name, barriers: ALL_BARRIERS,
  setup: () => { const state = { cause, ok: true }; state.context = jobPassContext('job-resume', () => { if (!state.ok) throw cause; return true; }); return state; },
  apply: (w, state) => { state.ok = false; },
  matches: (error, state) => error === state.cause,
});
const CHANGES = [
  { name: 'a fenced replacement queued before the pass', barriers: [FENCE_WAIT], code: 'tp1_local_binding_changed', replace: BYPASS },
  { name: 'a bypassing reconnect', barriers: ALL_BARRIERS, code: 'tp1_local_binding_changed', apply: BYPASS },
  { name: 'KILL', barriers: [FENCE_WAIT, FINAL_AUTHORITY_READ], code: 'seller_stopped', apply: (w) => { w.control.stopped = true; } },
  { name: 'a guard flip', barriers: ALL_BARRIERS, code: 'kit_operation_guard_off', apply: (w) => w.guard.setKitOperationGuardForTest('off') },
  { name: 'a K1 rev change', barriers: ALL_BARRIERS, code: 'context_admission_closed', setup: () => ({ rev: { value: 1 } }),
    operation: (state) => ({ k1Rev: { expected: 1, current: () => state.rev.value } }), apply: (w, state) => { state.rev.value = 2; } },
  { name: 'a consumed approval', barriers: ALL_BARRIERS, code: 'write-fee-cap', setup: () => ({ approval: { value: 'revision-1' } }),
    operation: (state) => ({ approvalRef: { revision: () => state.approval.value } }), apply: (w, state) => { state.approval.value = null; } },
  authorizationChange('a settlement collision', new Error('TEST settlement collision')),
  authorizationChange('lost or replaced job ownership', new Error('TEST job ownership lost')),
  authorizationChange('a changed or expired validated fence', new Error('TEST validated fence expired')),
];

test('at the fence wait, the final authority read and the final stop read, a fenced replacement, a bypassing reconnect, KILL, a guard flip or a K1 rev change signs nothing; (round 6) a private current-authorization callback detecting settlement collision, lost/replaced job ownership or a changed/expired validated fence also signs nothing, preserving its cause, and a missing job-resume callback, false result or thenable refuses', async (t) => {
  for (const change of CHANGES) {
    for (const barrier of change.barriers) {
      const { w, state, outcome } = await parkSignPass(t, barrier, change);
      const label = `${change.name} at ${barrier}`;
      if (change.matches) assert.ok(change.matches(outcome, state), `${label}: the callback's own error is kept (${outcome?.code ?? outcome})`);
      else assert.equal(outcome.code, change.code, label);
      assert.deepEqual([w.counts.signer, w.counts.transport], [0, 0], `${label}: nothing signed`);
    }
  }
  const unusable = [
    ['a missing job-resume callback', undefined, 'context_authorization_required'],
    ['a false result', () => false, 'context_authorization_refused'],
    ['a thenable', () => Promise.resolve(true), 'context_authorization_refused'],
    ['a truthy non-true result', () => 'yes', 'context_authorization_refused'],
  ];
  for (const [name, callback, code] of unusable) {
    const w = await ebWorld(t);
    const { boundary } = w.build();
    await assert.rejects(boundary.signPass(w.op(), w.sign(), { context: jobPassContext('job-resume', callback) }), { code }, name);
    assert.equal(w.counts.signer, 0, name);
  }
  const w = await ebWorld(t);
  const { boundary } = w.build();
  await assert.rejects(boundary.signPass(w.op(), w.sign(), { context: { operationClass: 'job-resume', currentAuthorization: () => true } }), { code: 'eb_context_invalid' });
  assert.throws(() => jobPassContext('request-supplied', () => true), TypeError);
  let microtaskRan = true;
  const context = jobPassContext('job-create', () => { w.trace.push('authorization'); microtaskRan = false; queueMicrotask(() => { microtaskRan = true; }); return true; });
  await boundary.signPass(w.op(), () => { assert.equal(microtaskRan, false, 'no await between the final check and the signer call'); return w.sign()(); }, { context });
  assert.deepEqual(w.trace.slice(w.trace.indexOf('sign') - 2, w.trace.indexOf('sign') + 1), ['stop', 'authorization', 'sign']);
});

test('inside EB7\'s read and EB8\'s intent persistence, the same changes hold or withhold the signed bytes and transmit nothing; (round 6) current authorization is checked again after the final stop await, with no await before transmission', async (t) => {
  const eb7 = [
    ['a bypassing reconnect', (w) => BYPASS(w), 'signed-held', 'tp1_local_binding_changed', ['signed', 'signed-held']],
    ['KILL after EB7\'s stop check passed', (w) => { w.control.stopped = true; }, 'dispatch-withheld', 'seller_stopped', ['signed', 'dispatch-started', 'dispatch-withheld']],
  ];
  for (const [name, change, state, cause, expected] of eb7) {
    const w = await ebWorld(t);
    const { boundary, history } = w.build();
    const park = gate();
    w.control.readHook = async (n, scope, base) => { if (n === 3) await park.arrive(); return base(scope); };
    const outcome = assert.rejects(boundary.pass(w.op(), w.sign(), w.send()), { code: cause }, name);
    await park.reached;
    change(w);
    park.release();
    await outcome;
    const last = (await history.read('lane-1')).at(-1);
    assert.deepEqual([last.state, last.cause.code], [state, cause], name);
    assert.deepEqual(await states(history), expected, name);
    assert.deepEqual([w.counts.signer, w.counts.transport], [1, 0], name);
  }
  const stalled = await ebWorld(t);
  const stalledRun = stalled.build();
  const late = gate();
  stalled.control.readHook = async (n, scope, base) => { if (n === 3) await late.arrive(); return base(scope); };
  const timeout = assert.rejects(stalledRun.boundary.pass(stalled.op(), stalled.sign(), stalled.send()), { code: 'tp1_authority_timeout' });
  await late.reached;
  await stalled.clock.advance(DEADLINE_MS);
  await timeout;
  late.release();
  await flush();
  assert.deepEqual(await states(stalledRun.history), ['signed', 'signed-held'], 'a read that answers after the deadline holds the bytes and sends nothing');
  assert.equal(stalled.counts.transport, 0);

  const eb8 = [
    ['KILL', () => ({}), (w) => { w.control.stopped = true; }, 'seller_stopped'],
    ['a bypassing reconnect', () => ({}), BYPASS, 'tp1_local_binding_changed'],
    ['a guard flip', () => ({}), (w) => w.guard.setKitOperationGuardForTest('off'), 'kit_operation_guard_off'],
    ['compensation advancing the K1 rev', () => ({ rev: { value: 1 } }), (w, state) => { state.rev.value = 2; }, 'context_admission_closed'],
  ];
  for (const [name, setup, change, cause] of eb8) {
    const w = await ebWorld(t);
    const { boundary, history } = w.build();
    const state = setup();
    const park = gate();
    w.control.appendHook = async (record) => { if (record.state === 'dispatch-started') await park.arrive(); };
    const operation = w.op(state.rev ? { k1Rev: { expected: 1, current: () => state.rev.value } } : {});
    const outcome = assert.rejects(boundary.pass(operation, w.sign(), w.send()), { code: cause }, name);
    await park.reached;
    change(w, state);
    park.release();
    await outcome;
    const last = (await history.read('lane-1')).at(-1);
    assert.deepEqual([last.state, last.cause.code], ['dispatch-withheld', cause], name);
    assert.deepEqual(await states(history), ['signed', 'dispatch-started', 'dispatch-withheld'], name);
    assert.equal(w.counts.transport, 0, name);
  }
  // K0-F9: the process dies after EB8f refuses and before dispatch-withheld is written.
  const crash = await ebWorld(t);
  const park = gate();
  const died = gate();
  crash.control.appendHook = async (record) => { if (record.state === 'dispatch-started') await park.arrive(); if (record.state === 'dispatch-withheld') await died.arrive(); };
  const abandoned = crash.build().boundary.pass(crash.op(), crash.sign(), crash.send());
  await park.reached;
  crash.control.stopped = true;
  park.release();
  await died.reached;
  assert.ok(await stillPending(abandoned));
  crash.control.appendHook = null;
  crash.control.stopped = false;
  const restarted = crash.build();
  assert.deepEqual(await states(restarted.history), ['signed', 'dispatch-started']);
  await assert.rejects(restarted.boundary.pass(crash.op(), crash.sign(), crash.send()), { code: 'lane_readback_only' });
  assert.equal(crash.counts.transport, 0);

  const gapped = await ebWorld(t);
  let microtaskRan = true;
  const context = jobPassContext('job-create', () => { gapped.trace.push('authorization'); microtaskRan = false; queueMicrotask(() => { microtaskRan = true; }); return true; });
  await gapped.build().boundary.pass(gapped.op(), gapped.sign(), (bytes) => { assert.equal(microtaskRan, false, 'no await between the last check and the transmission'); return gapped.send()(bytes); }, { context });
  const at = gapped.trace.indexOf('send');
  assert.deepEqual(gapped.trace.slice(at - 2, at + 1), ['stop', 'authorization', 'send'], 'the final stop await comes right before the last authorization check');
});

test('a withheld artifact is not transmitted after restart and KILL removal; a new explicit pass transmits the retained bytes once', async (t) => {
  const withhold = async () => {
    const w = await ebWorld(t);
    const park = gate();
    w.control.appendHook = async (record) => { if (record.state === 'dispatch-started') await park.arrive(); };
    const outcome = assert.rejects(w.build().boundary.pass(w.op(), w.sign(), w.send()), { code: 'seller_stopped' });
    await park.reached;
    w.control.stopped = true;
    park.release();
    await outcome;
    w.control.appendHook = null;
    w.control.stopped = false;
    return w;
  };
  const w = await withhold();
  const restarted = w.build();
  await flush();
  assert.equal(w.counts.transport, 0, 'nothing transmits by itself after restart and KILL removal');
  assert.deepEqual(await states(restarted.history), ['signed', 'dispatch-started', 'dispatch-withheld']);
  await restarted.boundary.pass(w.op(), w.sign(), w.send('explicit'));
  assert.deepEqual([w.counts.signer, w.counts.transport], [1, 1]);
  const retained = (await restarted.history.read('lane-1'))[0];
  assert.deepEqual(w.sent, [Uint8Array.from(Buffer.from(retained.bytes, 'base64'))], 'the retained bytes were sent');
  await assert.rejects(restarted.boundary.pass(w.op(), w.sign(), w.send()), { code: 'lane_readback_only' });
  assert.equal(w.counts.transport, 1, 'once');
  // K0-F19: compensation advanced the K1 revision; the admission is never revived.
  const compensated = await withhold();
  const rejected = compensated.build();
  await assert.rejects(rejected.boundary.pass(compensated.op({ k1Rev: { expected: 1, current: () => 2 } }), compensated.sign(), compensated.send()), { code: 'context_admission_closed' });
  assert.equal(compensated.counts.transport, 0);
  assert.deepEqual(await states(rejected.history), ['signed', 'dispatch-started', 'dispatch-withheld']);
});

test('a fenced replacement during a pass waits; the pass completes on the bound connection and the next pass binds again', async (t) => {
  const w = await ebWorld(t);
  const { boundary } = w.build();
  const park = gate();
  let replaced = 0;
  const pass = boundary.pass(w.op(), w.sign(), async () => { await park.arrive(); return 'bound'; });
  await park.reached;
  const replacement = boundary.replaceConnection(async () => { replaced += 1; });
  await flush();
  assert.deepEqual([replaced, boundary.connectionGeneration()], [0, 0], 'the replacement waits for the pass');
  park.release();
  assert.equal((await pass).answer, 'bound');
  await replacement;
  assert.deepEqual([replaced, boundary.connectionGeneration()], [1, 1]);
  await boundary.pass(w.op({ operationId: 'next', lane: 'lane-2' }), w.sign(), w.send());
  assert.equal(w.counts.transport, 1, 'the next pass binds to the new generation and completes');
  // A replacement made inside a pass by its own owner moves the generation, and the pass refuses at its tail.
  const signed = w.counts.signer;
  await assert.rejects(boundary.withFence(w.op({ operationId: 'self', lane: 'lane-3' }), async (held) => {
    await boundary.replaceConnection(async () => {}, held.capability);
    await boundary.signPass(held, w.sign());
  }), { code: 'tp1_local_binding_changed' });
  assert.equal(w.counts.signer, signed);
  await boundary.withFence(w.op({ operationId: 'failed-replace', lane: 'lane-4' }), async () => {});
  await assert.rejects(boundary.replaceConnection(async () => { throw new Error('TEST replace failed'); }), /TEST replace failed/);
  assert.equal(boundary.connectionGeneration(), 3, 'a failed replacement also invalidates passes bound to the old generation');
});

test('the EB signer given to signWireEnvelope runs the final stop check and synchronous rechecks, including the private current-authorization callback, inside sign', async (t) => {
  // The wire's order in signWireEnvelope (364top envelope.ts:132-157): an authority read, signer.sign, an authority read.
  const libraryEnvelope = async (w, signer) => {
    await assertTp1Binding(w.binding, w.control.local);
    const signature = await signer.sign(SIGNED_BYTES);
    await assertTp1Binding(w.binding, w.control.local);
    return signature;
  };
  const innerFor = (w) => ({ claim: 'did:demos:agent:test-claim', sign: () => { w.counts.signer += 1; w.trace.push('sign'); return Uint8Array.from([9]); } });
  const runWith = async (t2, change, context) => {
    const w = await ebWorld(t2);
    const { boundary } = w.build();
    const park = gate();
    w.control.readHook = async (n, scope, base) => { if (n === 2) await park.arrive(); return base(scope); };
    const outcome = boundary.withFence(w.op({ kind: 'wire-request' }), (held) => libraryEnvelope(w, boundary.signerFor(held, innerFor(w))), { context })
      .catch((error) => error);
    await park.reached;
    change(w);
    park.release();
    return { w, result: await outcome };
  };
  // The gap the EB signer closes: the library's own signer signs with KILL present.
  const ungated = await ebWorld(t);
  const park = gate();
  ungated.control.readHook = async (n, scope, base) => { if (n === 1) await park.arrive(); return base(scope); };
  const bare = libraryEnvelope(ungated, innerFor(ungated));
  await park.reached;
  ungated.control.stopped = true;
  park.release();
  await bare;
  assert.equal(ungated.counts.signer, 1, 'K0-X1: an ungated signer signs with KILL present');

  const killed = await runWith(t, (w) => { w.control.stopped = true; });
  assert.equal(killed.result.code, 'seller_stopped');
  assert.equal(killed.w.counts.signer, 0);
  const flipped = await runWith(t, (w) => w.guard.setKitOperationGuardForTest('off'));
  assert.equal(flipped.result.code, 'kit_operation_guard_off');
  assert.equal(flipped.w.counts.signer, 0);
  const collision = new Error('TEST settlement collision');
  const refused = await runWith(t, () => {}, jobPassContext('job-create', () => { throw collision; }));
  assert.equal(refused.result, collision);
  assert.equal(refused.w.counts.signer, 0);
  const clean = await runWith(t, () => {});
  assert.equal(clean.result instanceof Uint8Array, true, 'with no change the library gets the inner signature');
  assert.equal(clean.w.counts.signer, 1);
  const signAt = clean.w.trace.indexOf('sign');
  assert.equal(clean.w.trace[signAt - 1], 'stop', 'the final stop check comes right before the inner signer');
});

// P15a: the kit's effect boundary (K0). Instrumented signer, transport, stop check and
// authority reader, a controllable monotonic clock and real history files; no path of
// the kit calls the boundary yet. The ordering, barrier and library-signer cases are in
// effect-boundary-barriers.test.mjs; the history adapter's own cases in effect-history.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assertTp1Binding } from '@kynesyslabs/dacs/wire';
import { createEffectBoundary } from '../src/dacs/effect-boundary.mjs';
import { DEFAULT_HISTORY_IO } from '../src/dacs/effect-history.mjs';
import { FEE_CEILING_OS, NEVER, SIGNED_BYTES, ebWorld, flush, gate, stillPending } from './helpers/effect-boundary-fixture.mjs';

const DEADLINE_MS = 10000;
// A pass over already-retained bytes asks the stop check at EB2, the refresh, the final await and then EB7.
const STOPS_UP_TO_EB7_OF_A_RETAINED_PASS = 4;
const states = async (history, lane = 'lane-1') => (await history.read(lane)).map((record) => record.state);
const lastRecord = async (history, lane = 'lane-1') => (await history.read(lane)).at(-1);
const failure = (code) => Object.assign(new Error(`TEST ${code}`), { code });

test('an EB pass runs EB1 to EB9 in order and refuses with each step\'s code in K0\'s refusal order', async (t) => {
  const w = await ebWorld(t);
  const { boundary, history } = w.build();
  const answer = await boundary.pass(w.op(), w.sign(), w.send('accepted'));
  assert.deepEqual(answer, { bytes: SIGNED_BYTES, answer: 'accepted' });
  assert.deepEqual(w.trace, ['stop', 'authority', 'stop', 'authority', 'stop', 'sign', 'append:signed', 'stop', 'authority',
    'append:dispatch-started', 'stop', 'send', 'append:dispatch-acknowledged']);
  assert.deepEqual(await states(history), ['signed', 'dispatch-started', 'dispatch-acknowledged']);
  // Every refusal is violated at once; each fix exposes the next step's code.
  const denied = async (code) => {
    await assert.rejects(boundary.pass(w.op({ operationId: 'op-2', lane: 'lane-2', debitOs: debit.value }), w.sign(), w.send()), { code });
    assert.equal(w.counts.signer, 1, `${code}: no further signer call`);
  };
  const debit = { value: String(BigInt(FEE_CEILING_OS) + 1n) };
  w.guard.setKitOperationGuardForTest('off');
  w.control.stopped = true;
  w.control.local = { ...w.control.local, connectionId: 'other-connection' };
  await denied('kit_operation_guard_off');
  w.guard.setKitOperationGuardForTest('testnet-tp1');
  await denied('seller_stopped');
  w.control.stopped = false;
  await denied('write-fee-cap');
  debit.value = '1';
  await denied('tp1_local_binding_changed');
  w.control.local = { ...w.control.local, connectionId: 'vector-conn-1' };
  await boundary.pass(w.op({ operationId: 'op-2', lane: 'lane-2', debitOs: debit.value }), w.sign(), w.send());
  assert.equal(w.counts.signer, 2);
});

test('crash cuts before persistence, after persistence, after dispatch intent and after transmission leave K0\'s states and restart actions', async (t) => {
  const cuts = [
    { name: 'K0-P1 signer returned, nothing persisted', park: (w, died) => { w.control.appendHook = (record) => (record.state === 'signed' ? died.arrive() : undefined); },
      left: [], restartSigns: 1, restartSends: 1 },
    { name: 'K0-P3 persisted, before EB8', park: (w, died) => { w.control.appendHook = (record) => (record.state === 'dispatch-started' ? died.arrive() : undefined); },
      left: ['signed'], restartSigns: 0, restartSends: 1 },
    { name: 'K0-P5 intent persisted, before the transport call', park: (w, died) => { w.control.stopHook = () => (w.trace.includes('append:dispatch-started') ? died.arrive() : false); },
      left: ['signed', 'dispatch-started'], restartSigns: 0, restartSends: 0 },
    { name: 'K0-P7 transmitted, before EB9', park: (w, died) => { w.control.appendHook = (record) => (record.state === 'dispatch-acknowledged' ? died.arrive() : undefined); },
      left: ['signed', 'dispatch-started'], restartSigns: 0, restartSends: 0, sentBefore: 1 },
  ];
  for (const cut of cuts) {
    const w = await ebWorld(t);
    const first = w.build();
    const died = gate();
    cut.park(w, died);
    const abandoned = first.boundary.pass(w.op(), w.sign(), w.send());
    await died.reached;
    assert.ok(await stillPending(abandoned), `${cut.name}: the process died inside the pass`);
    const signedBefore = w.counts.signer;
    const sentBefore = w.counts.transport;
    assert.equal(sentBefore, cut.sentBefore ?? 0, cut.name);
    w.control.appendHook = null;
    w.control.stopHook = null;
    const restarted = w.build();
    assert.deepEqual(await states(restarted.history), cut.left, `${cut.name}: durable state`);
    const retained = (await restarted.history.read('lane-1')).find((record) => record.state === 'signed');
    const again = restarted.boundary.pass(w.op(), w.sign(), w.send());
    if (cut.restartSends === 0) await assert.rejects(again, { code: 'lane_readback_only' }, cut.name);
    else await again;
    assert.equal(w.counts.signer - signedBefore, cut.restartSigns, `${cut.name}: signer calls after restart`);
    assert.equal(w.counts.transport - sentBefore, cut.restartSends, `${cut.name}: transport calls after restart`);
    if (retained && cut.restartSends === 1) assert.deepEqual(w.sent.at(-1), Uint8Array.from(Buffer.from(retained.bytes, 'base64')), `${cut.name}: the retained bytes were sent`);
  }
});

test('a failed persistence write transmits nothing and refuses eb_persist_failed with EIO as its cause', async (t) => {
  const eio = failure('EIO');
  const w = await ebWorld(t, { historyIo: { ...DEFAULT_HISTORY_IO, publish: async () => { throw eio; } } });
  const { boundary, history } = w.build();
  await assert.rejects(boundary.pass(w.op(), w.sign(), w.send()), (error) => error.code === 'eb_persist_failed' && error.cause === eio);
  assert.equal(w.counts.transport, 0);
  assert.equal(w.counts.signer, 1);
  assert.deepEqual(await states(history), []);
});

test('a stop observed between persistence and EB7 keeps the signature signed-held, also after restart', async (t) => {
  const w = await ebWorld(t);
  const first = w.build();
  w.control.stopHook = () => w.trace.includes('append:signed');
  await assert.rejects(first.boundary.pass(w.op(), w.sign(), w.send()), { code: 'seller_stopped' });
  assert.equal(w.counts.transport, 0);
  const held = await lastRecord(first.history);
  assert.deepEqual([held.state, held.cause.code], ['signed-held', 'seller_stopped']);
  const restarted = w.build();
  assert.deepEqual(await states(restarted.history), ['signed', 'signed-held']);
  await assert.rejects(restarted.boundary.pass(w.op(), w.sign(), w.send()), { code: 'seller_stopped' });
  assert.deepEqual([w.counts.transport, w.counts.signer], [0, 1]);
  assert.deepEqual(await states(restarted.history), ['signed', 'signed-held']);
  // A hold that cannot be written still refuses, names the refusal it was recording, and leaves only `signed`.
  const unwritable = await ebWorld(t);
  const eio = failure('EIO');
  unwritable.control.appendHook = (record) => { if (record.state === 'signed-held') throw eio; };
  const run = unwritable.build();
  unwritable.control.stopHook = () => unwritable.trace.includes('append:signed');
  await assert.rejects(run.boundary.pass(unwritable.op(), unwritable.sign(), unwritable.send()), (error) => error.code === 'eb_persist_failed' && error.cause === eio && /seller_stopped/.test(error.message));
  assert.deepEqual([await states(run.history), unwritable.counts.transport], [['signed'], 0]);
});

test('a transport that throws after the receiver recorded the bytes is dispatch-unknown, and readback moves it to observed', async (t) => {
  const w = await ebWorld(t);
  const { boundary, history } = w.build();
  const receiver = [];
  const lost = failure('ECONNRESET');
  const send = (bytes) => { w.counts.transport += 1; receiver.push(bytes); throw lost; };
  await assert.rejects(boundary.pass(w.op(), w.sign(), send), (error) => error === lost);
  const unknown = await lastRecord(history);
  assert.deepEqual([unknown.state, unknown.cause.code], ['dispatch-unknown', 'ECONNRESET']);
  await assert.rejects(boundary.pass(w.op(), w.sign(), w.send()), { code: 'lane_readback_only' });
  assert.equal(w.counts.transport, 1);
  await boundary.recordObserved(w.op(), 'dispatch', { found: receiver.length });
  const observed = await lastRecord(history);
  assert.deepEqual([observed.state, observed.of, observed.result], ['observed', unknown.of, { found: 1 }]);
  assert.deepEqual(await states(history), ['signed', 'dispatch-started', 'dispatch-unknown', 'observed']);
});

test('an acknowledged confirmation then a crash broadcasts once on restart; a lost confirmation answer is confirm-unknown and never advances', async (t) => {
  const w = await ebWorld(t);
  const first = w.build();
  await first.boundary.pass(w.op(), w.sign(), w.send('confirmed'), { stage: 'confirm' });
  const restarted = w.build();
  await restarted.boundary.pass(w.op(), w.sign(), w.send('broadcast'), { stage: 'broadcast' });
  assert.equal(w.counts.signer, 1);
  assert.deepEqual(w.sent, [SIGNED_BYTES, SIGNED_BYTES]);
  assert.deepEqual(await states(restarted.history), ['signed', 'confirm-started', 'confirm-acknowledged', 'broadcast-started', 'broadcast-acknowledged']);
  await assert.rejects(restarted.boundary.pass(w.op(), w.sign(), w.send(), { stage: 'broadcast' }), { code: 'lane_readback_only' });
  const lost = w.op({ operationId: 'op-2', lane: 'lane-2' });
  const timeout = failure('ETIMEDOUT');
  await assert.rejects(restarted.boundary.pass(lost, w.sign(), () => { throw timeout; }, { stage: 'confirm' }), (error) => error === timeout);
  assert.equal((await lastRecord(restarted.history, 'lane-2')).state, 'confirm-unknown');
  const sentBefore = w.counts.transport;
  await assert.rejects(restarted.boundary.pass(lost, w.sign(), w.send(), { stage: 'broadcast' }), { code: 'confirm_not_acknowledged' });
  await assert.rejects(restarted.boundary.pass(lost, w.sign(), w.send(), { stage: 'confirm' }), { code: 'lane_readback_only' });
  assert.equal(w.counts.transport, sentBefore);
});

test('authority reads that reject, stall, resolve late or exceed their byte or list bound sign nothing and keep their cause', async (t) => {
  const refused = failure('authority_unreachable');
  const oversized = failure('authority_reply_over_byte_bound');
  const cases = [
    ['rejects', () => { throw refused; }, (error) => error === refused],
    ['over its byte bound', () => { throw oversized; }, (error) => error === oversized],
    ['over its list bound', (n, scope, base) => ({ ...base(scope), participants: [{ claim: 'x' }, { claim: 'y' }, { claim: 'z' }] }), (error) => /^tp1_/.test(error.code)],
  ];
  for (const [name, hook, matches] of cases) {
    const w = await ebWorld(t);
    const { boundary } = w.build();
    w.control.readHook = hook;
    await assert.rejects(boundary.pass(w.op(), w.sign(), w.send()), matches, name);
    assert.deepEqual([w.counts.signer, w.counts.transport], [0, 0], name);
  }
  for (const [name, resolveAt] of [['stalls', null], ['resolves late', DEADLINE_MS + 1]]) {
    const w = await ebWorld(t);
    const { boundary } = w.build();
    const late = gate();
    w.control.readHook = async (n, scope, base) => { await (resolveAt === null ? NEVER : late.arrive()); return base(scope); };
    const outcome = assert.rejects(boundary.pass(w.op(), w.sign(), w.send()), { code: 'tp1_authority_timeout' }, name);
    await flush();
    await w.clock.advance(resolveAt ?? DEADLINE_MS);
    await outcome;
    late.release();
    await flush();
    assert.deepEqual([w.counts.signer, w.counts.transport], [0, 0], `${name}: a late answer authorizes nothing`);
  }
});

for (const check of ['stop', 'binding']) {
  const code = check === 'stop' ? 'stop_check_timeout' : 'tp1_authority_timeout';
  const install = (w, answer) => {
    if (check === 'stop') w.control.stopHook = (n) => (n === 3 ? answer() : false);
    else w.control.readHook = async (n, scope, base) => { if (n === 2) await answer(); return base(scope); };
  };

  for (const [timing, elapsed] of [['at the deadline', DEADLINE_MS], ['after the deadline', DEADLINE_MS + 1]]) {
    for (const rejects of [false, true]) {
      test(`a ${check} check that ${rejects ? 'rejects' : 'answers'} ${timing} before its timer runs refuses without signing or dispatching`, async (t) => {
        const w = await ebWorld(t);
        const { boundary, history } = w.build();
        let now = 0;
        w.clock.now = () => now;
        install(w, async () => {
          now = elapsed;
          if (rejects) throw failure('check_unreachable');
          return false;
        });
        await assert.rejects(boundary.pass(w.op(), w.sign(), w.send()), { code });
        assert.deepEqual([w.counts.signer, w.counts.transport], [0, 0]);
        assert.deepEqual(await states(history), []);
      });
    }
  }

  test(`a ${check} check that answers just before the deadline still permits the pass`, async (t) => {
    const w = await ebWorld(t);
    const { boundary, history } = w.build();
    let now = 0;
    w.clock.now = () => now;
    install(w, async () => { now = DEADLINE_MS - 1; return false; });
    assert.deepEqual(await boundary.pass(w.op(), w.sign(), w.send()), { bytes: SIGNED_BYTES, answer: 'accepted' });
    assert.deepEqual([w.counts.signer, w.counts.transport], [1, 1]);
    assert.deepEqual(await states(history), ['signed', 'dispatch-started', 'dispatch-acknowledged']);
  });

  test(`a ${check} check that rejects after its timer wins stays handled`, async (t) => {
    const w = await ebWorld(t);
    const { boundary, history } = w.build();
    const pending = gate();
    install(w, async () => { await pending.arrive(); throw failure('check_unreachable'); });
    const outcome = assert.rejects(boundary.pass(w.op(), w.sign(), w.send()), { code });
    await pending.reached;
    await w.clock.advance(DEADLINE_MS);
    await outcome;
    pending.release();
    await flush();
    assert.deepEqual([w.counts.signer, w.counts.transport], [0, 0]);
    assert.deepEqual(await states(history), []);
  });
}

test('a final stop answer after the deadline before its timer runs withholds transport', async (t) => {
  const w = await ebWorld(t);
  const { boundary, history } = w.build();
  let now = 0;
  w.clock.now = () => now;
  w.control.stopHook = async (n) => { if (n === 5) now = DEADLINE_MS + 1; return false; };
  await assert.rejects(boundary.pass(w.op(), w.sign(), w.send()), { code: 'stop_check_timeout' });
  assert.deepEqual([w.counts.signer, w.counts.transport], [1, 0]);
  assert.deepEqual(await states(history), ['signed', 'dispatch-started', 'dispatch-withheld']);
});

test('an expired fence waiter is refused before its timer runs and the next waiter can proceed', async (t) => {
  const w = await ebWorld(t);
  const { boundary, history } = w.build();
  let now = 0;
  w.clock.now = () => now;
  const park = gate();
  const holder = boundary.withFence(w.op(), () => park.arrive());
  await park.reached;
  const outcome = assert.rejects(boundary.pass(w.op(), w.sign(), w.send()), { code: 'tp1_fence_timeout' });
  await flush();
  now = DEADLINE_MS + 1;
  park.release();
  await holder;
  await outcome;
  assert.deepEqual([w.counts.signer, w.counts.transport], [0, 0]);
  assert.deepEqual(await states(history), []);
  await boundary.pass(w.op(), w.sign(), w.send());
  assert.deepEqual([w.counts.signer, w.counts.transport], [1, 1]);
});

test('a very long queue of expired fence waiters is refused one by one without overflowing the stack', async (t) => {
  const w = await ebWorld(t);
  const { boundary } = w.build();
  let now = 0;
  w.clock.now = () => now;
  const park = gate();
  const holder = boundary.withFence(w.op(), () => park.arrive());
  await park.reached;
  const WAITERS = 12000;
  const outcomes = Array.from({ length: WAITERS }, (_, index) => boundary.withFence(w.op({ operationId: `queued-${index}`, lane: `lane-${index}` }), async () => {}).then(
    () => 'ran',
    (error) => error.code,
  ));
  await flush();
  now = DEADLINE_MS + 1;
  park.release();
  await holder;
  const results = await Promise.all(outcomes);
  assert.deepEqual([...new Set(results)], ['tp1_fence_timeout']);
  assert.equal(results.length, WAITERS);
  await boundary.withFence(w.op(), async () => {});
});

test('a stop check that rejects, stalls or answers a non-boolean counts as stopped with its cause', async (t) => {
  const broken = failure('stop_source_down');
  const cases = [
    ['rejects', () => { throw broken; }, 'stop_check_failed', (error) => error.cause === broken],
    ['answers a string', () => 'false', 'stop_check_invalid', () => true],
    ['stalls', () => NEVER, 'stop_check_timeout', () => true],
    ['answers true', () => true, 'seller_stopped', (error) => error.status === 503],
  ];
  for (const [name, hook, code, matchesCause] of cases) {
    const w = await ebWorld(t);
    const { boundary } = w.build();
    w.control.stopHook = hook;
    const outcome = assert.rejects(boundary.pass(w.op(), w.sign(), w.send()), (error) => error.code === code && matchesCause(error), name);
    await flush();
    await w.clock.advance(DEADLINE_MS);
    await outcome;
    assert.deepEqual([w.counts.signer, w.counts.transport], [0, 0], name);
  }
  // One window per pass under the fence: EB7's slow read leaves EB8f's stop check only the rest of the 10,000 ms.
  const w = await ebWorld(t);
  const { boundary, history } = w.build();
  const atDispatchStop = gate();
  w.control.readHook = async (n, scope, base) => { if (n === 3) await w.clock.advance(6000); return base(scope); };
  w.control.stopHook = (n) => (n === 5 ? atDispatchStop.arrive() : false);
  const outcome = assert.rejects(boundary.pass(w.op(), w.sign(), w.send()), { code: 'stop_check_timeout' });
  await atDispatchStop.reached;
  await w.clock.advance(DEADLINE_MS - 6000);
  await outcome;
  assert.deepEqual([await states(history), w.counts.transport], [['signed', 'dispatch-started', 'dispatch-withheld'], 0]);
});

test('fence ownership: a late acquisition is released, nested work reuses the capability, and a foreign capability or a non-owner release is refused', async (t) => {
  const w = await ebWorld(t);
  const { boundary } = w.build();
  const park = gate();
  const holder = boundary.withFence(w.op({ operationId: 'holder', lane: 'lane-h' }), async () => { await park.arrive(); return 'held'; });
  await park.reached;
  const late = assert.rejects(boundary.signPass(w.op({ operationId: 'late', lane: 'lane-l' }), w.sign()), { code: 'tp1_fence_timeout' });
  await flush();
  await w.clock.advance(DEADLINE_MS + 1);
  await late;
  park.release();
  assert.equal(await holder, 'held');
  await boundary.pass(w.op({ operationId: 'next', lane: 'lane-n' }), w.sign(), w.send());
  assert.equal(w.counts.signer, 1, 'the late waiter signed nothing; the next one acquired the released fence');
  // Nested work of one operation reuses its capability: a second acquisition would deadlock.
  let stale;
  await boundary.withFence(w.op({ operationId: 'nest', lane: 'lane-m' }), async (held) => {
    stale = held.capability;
    await boundary.signPass(held, w.sign());
    await boundary.dispatchPass(held, w.send());
    await assert.rejects(boundary.signPass({ ...w.op({ operationId: 'intruder', lane: 'lane-i' }), capability: held.capability }, w.sign()), { code: 'tp1_fence_not_owned' });
    await assert.rejects(boundary.signPass({ ...held, capability: {} }, w.sign()), { code: 'tp1_fence_not_owned' });
  });
  assert.equal(w.counts.signer, 2, 'a foreign or forged capability signs nothing');
  // A capability whose owner already released does not release or take anything from the next owner.
  const second = gate();
  const owner = boundary.withFence(w.op({ operationId: 'owner', lane: 'lane-o' }), async () => { await second.arrive(); });
  await second.reached;
  await assert.rejects(boundary.signPass({ ...w.op({ operationId: 'nest', lane: 'lane-m' }), capability: stale }, w.sign()), { code: 'tp1_fence_not_owned' });
  let replaced = 0;
  for (const capability of [stale, {}]) await assert.rejects(boundary.replaceConnection(async () => { replaced += 1; }, capability), { code: 'tp1_fence_not_owned' });
  assert.equal(replaced, 0, 'a non-owner cannot act on the fence it does not hold');
  const waiter = assert.rejects(boundary.withFence(w.op({ operationId: 'waiter', lane: 'lane-w' }), async () => {}), { code: 'tp1_fence_timeout' });
  await flush();
  await w.clock.advance(DEADLINE_MS + 1);
  await waiter;
  second.release();
  await owner;
  // The owner releases on a throw too.
  const boom = new Error('TEST work failed');
  await assert.rejects(boundary.withFence(w.op({ operationId: 'thrower', lane: 'lane-t' }), async () => { throw boom; }), (error) => error === boom);
  await boundary.withFence(w.op({ operationId: 'after-throw', lane: 'lane-a' }), async () => {});
});

test('two overlapping passes on one actor never interleave sign-to-dispatch, and a wait over 10,000 ms refuses tp1_fence_timeout', async (t) => {
  const w = await ebWorld(t);
  const { boundary } = w.build();
  const inSend = gate();
  const first = boundary.pass(w.op({ operationId: 'a', lane: 'lane-a' }), w.sign(), async () => { await inSend.arrive(); return 'a'; });
  await inSend.reached;
  const second = boundary.pass(w.op({ operationId: 'b', lane: 'lane-b' }), w.sign(), w.send());
  await flush();
  assert.equal(w.counts.signer, 1, 'the second pass has not signed while the first is dispatching');
  inSend.release();
  await first;
  await second;
  assert.ok(w.trace.indexOf('append:dispatch-acknowledged') < w.trace.lastIndexOf('sign'), 'b signed only after a was acknowledged');
  assert.equal(w.counts.signer, 2);
  const parked = gate();
  const holder = boundary.pass(w.op({ operationId: 'd', lane: 'lane-d' }), w.sign(), async () => { await parked.arrive(); });
  await parked.reached;
  const waiter = assert.rejects(boundary.pass(w.op({ operationId: 'e', lane: 'lane-e' }), w.sign(), w.send()), { code: 'tp1_fence_timeout' });
  await flush();
  await w.clock.advance(DEADLINE_MS + 1);
  await waiter;
  assert.equal(w.counts.signer, 3, 'the timed-out waiter signed nothing');
  parked.release();
  await holder;
});

test('authority reads take no fence and call no signer', async (t) => {
  const w = await ebWorld(t);
  const { boundary } = w.build();
  const park = gate();
  const holder = boundary.withFence(w.op({ operationId: 'holder', lane: 'lane-h' }), async () => { await park.arrive(); });
  await park.reached;
  const readsBefore = w.control.reads;
  await assertTp1Binding(w.binding, w.control.local);
  assert.equal(w.control.reads, readsBefore + 1, 'a read completes while another operation holds the fence');
  const waiting = boundary.signPass(w.op({ operationId: 'waiter', lane: 'lane-w' }), w.sign());
  await flush();
  assert.equal(w.control.reads, readsBefore + 2, 'the waiter\'s EB4 read ran before the fence wait');
  assert.equal(w.counts.signer, 0);
  park.release();
  await holder;
  await waiting;
});

test('EB3 admits a debit equal to 50 DEM and refuses 50 DEM plus 1 OS before any signer call', async (t) => {
  const w = await ebWorld(t);
  const { boundary } = w.build();
  await boundary.pass(w.op({ debitOs: FEE_CEILING_OS }), w.sign(), w.send());
  assert.equal(w.counts.signer, 1);
  for (const debitOs of [String(BigInt(FEE_CEILING_OS) + 1n), '-1', '1.5', 'many', 50]) {
    await assert.rejects(boundary.pass(w.op({ operationId: 'over', lane: 'lane-2', debitOs }), w.sign(), w.send()), { code: 'write-fee-cap' }, String(debitOs));
  }
  const unset = w.build({ feeCeilingOs: null });
  await assert.rejects(unset.boundary.pass(w.op({ operationId: 'free', lane: 'lane-3' }), w.sign(), w.send()), { code: 'fee_ceiling_required' });
  await boundary.pass(w.op({ operationId: 'unpaid', lane: 'lane-4', paidWrite: false, debitOs: '0' }), w.sign(), w.send());
  assert.equal(w.counts.signer, 2, 'only the in-ceiling paid write and the unpaid write signed');
});

test('a lane stamped with another pin version is readback-only: pin_version_retired', async (t) => {
  const w = await ebWorld(t);
  const first = w.build();
  const oldBytes = Uint8Array.from([1, 2, 3]);
  await first.history.append('lane-1', { state: 'signed', operationId: 'old', pinVersion: 'dacs-demos-testnet-identity/2026-10-15', artifactHash: createHash('sha256').update(oldBytes).digest('hex'), bytes: Buffer.from(oldBytes).toString('base64') });
  const restarted = w.build();
  await assert.rejects(restarted.boundary.pass(w.op({ operationId: 'new' }), w.sign(), w.send()), { code: 'pin_version_retired' });
  await assert.rejects(restarted.boundary.pass(w.op({ operationId: 'stamped', lane: 'lane-2', pinVersion: 'dacs-demos-testnet-identity/2026-10-15' }), w.sign(), w.send()), { code: 'pin_version_retired' });
  assert.deepEqual([w.counts.signer, w.counts.transport], [0, 0]);
  assert.deepEqual(await states(restarted.history), ['signed'], 'readback still works');
});

test('the dispatch history is append-only: a held or withheld record never erases an earlier possible dispatch', async (t) => {
  const w = await ebWorld(t);
  const first = w.build();
  const op = w.op({ kind: 'seller-create' });
  await first.boundary.pass(op, w.sign(), w.send());
  const files = async () => Promise.all((await first.history.read('lane-1')).map((record) => JSON.stringify(record)));
  const before = await files();
  const restarted = w.build();
  const eb7Stop = w.control.stops + STOPS_UP_TO_EB7_OF_A_RETAINED_PASS;
  w.control.stopHook = (n) => n === eb7Stop;
  await assert.rejects(restarted.boundary.pass(op, w.sign(), w.send()), { code: 'seller_stopped' });
  const records = await restarted.history.read('lane-1');
  assert.deepEqual(records.map((record) => record.state), ['signed', 'dispatch-started', 'dispatch-acknowledged', 'signed-held']);
  assert.deepEqual((await files()).slice(0, before.length), before, 'earlier records are byte-identical');
  // On a native lane the earlier possible dispatch stays binding: the held record does not make the bytes "never dispatched".
  const native = w.op({ operationId: 'op-n', lane: 'lane-n' });
  await first.boundary.pass(native, w.sign(), w.send());
  const nativeEb7Stop = w.control.stops + STOPS_UP_TO_EB7_OF_A_RETAINED_PASS;
  w.control.stopHook = (n) => n === nativeEb7Stop;
  await assert.rejects(w.build().boundary.pass(native, w.sign(), w.send()), { code: 'seller_stopped' });
  w.control.stopHook = null;
  assert.deepEqual(await states(first.history, 'lane-n'), ['signed', 'dispatch-started', 'dispatch-acknowledged', 'signed-held']);
  await assert.rejects(w.build().boundary.pass(native, w.sign(), w.send()), { code: 'lane_readback_only' });
  assert.equal(w.counts.transport, 2, 'one send per lane; the held record erased nothing');
  // Only a started record with its own withheld record never reached transport: a later explicit pass is the lane's only send.
  const withheldLane = w.op({ operationId: 'op-w', lane: 'lane-w' });
  const intent = gate();
  w.control.appendHook = (record) => (record.state === 'dispatch-started' ? intent.arrive() : undefined);
  const withheld = assert.rejects(w.build().boundary.pass(withheldLane, w.sign(), w.send()), { code: 'seller_stopped' });
  await intent.reached;
  w.control.stopped = true;
  intent.release();
  await withheld;
  w.control.appendHook = null;
  w.control.stopped = false;
  await w.build().boundary.pass(withheldLane, w.sign(), w.send());
  assert.equal(w.counts.transport, 3, 'a withheld start never reached transport');
  await assert.rejects(w.build().boundary.pass(withheldLane, w.sign(), w.send()), { code: 'lane_readback_only' });
});

test('with the guard off, every pass refuses kit_operation_guard_off before any read', async (t) => {
  const w = await ebWorld(t);
  const { boundary } = w.build();
  w.guard.setKitOperationGuardForTest('off');
  const attempts = [
    () => boundary.pass(w.op(), w.sign(), w.send()),
    () => boundary.signPass(w.op(), w.sign()),
    () => boundary.withFence(w.op(), async () => {}),
    () => boundary.signerFor(w.op(), { claim: 'x', sign: w.sign() }).sign(SIGNED_BYTES),
  ];
  for (const attempt of attempts) await assert.rejects(Promise.resolve().then(attempt), { code: 'kit_operation_guard_off' });
  assert.deepEqual([w.control.reads, w.control.stops, w.counts.signer, w.counts.transport], [0, 0, 0, 0]);
});

test('the boundary refuses to be built without a stop check, a binding, a history or a clock, and refuses an unknown kind', async (t) => {
  const w = await ebWorld(t);
  const { boundary, history } = w.build();
  const parts = { stopped: () => false, binding: w.binding, currentLocal: () => w.control.local, feeCeilingOs: FEE_CEILING_OS, history, clock: w.clock };
  for (const missing of ['stopped', 'binding', 'currentLocal', 'history', 'clock']) {
    assert.throws(() => createEffectBoundary({ ...parts, [missing]: undefined }), { name: 'TypeError', message: new RegExp(missing) });
  }
  await assert.rejects(boundary.pass(w.op({ kind: 'anything' }), w.sign(), w.send()), { code: 'eb_operation_invalid' });
  await assert.rejects(boundary.pass(w.op({ lane: '' }), w.sign(), w.send()), { code: 'eb_operation_invalid' });
  await assert.rejects(boundary.pass(w.op({ lane: '../escape' }), w.sign(), w.send()), { code: 'eb_history_unavailable' });
  await assert.rejects(boundary.recordObserved({}, 'dispatch', {}), { code: 'eb_operation_invalid' });
  assert.equal(w.counts.signer, 0);
});

test('a signer that changes its returned array while the record is written cannot change what is sent', async (t) => {
  const w = await ebWorld(t);
  const { boundary, history } = w.build();
  const signerArray = Uint8Array.from([1, 2, 3, 4]);
  w.control.appendHook = (record) => { if (record.state === 'signed') signerArray[0] = 9; };
  const { bytes } = await boundary.pass(w.op(), w.sign(signerArray), w.send());
  const durable = Uint8Array.from(Buffer.from((await history.read('lane-1')).find((record) => record.state === 'signed').bytes, 'base64'));
  assert.deepEqual(durable, Uint8Array.from([1, 2, 3, 4]));
  assert.deepEqual(w.sent, [durable]);
  assert.deepEqual(bytes, durable);
});

test('a transport that changes the bytes it was handed cannot change what a later stage sends', async (t) => {
  const w = await ebWorld(t);
  const { boundary } = w.build();
  await boundary.withFence(w.op(), async (fenced) => {
    await boundary.signPass(fenced, w.sign(Uint8Array.from([1, 2, 3, 4])));
    await boundary.dispatchPass(fenced, (bytes) => { bytes[0] = 9; return 'confirmed'; }, { stage: 'confirm' });
    await boundary.dispatchPass(fenced, w.send('broadcast'), { stage: 'broadcast' });
  });
  assert.deepEqual(w.sent, [Uint8Array.from([1, 2, 3, 4])]);
});

test('a confirmation whose reply was lost and is then found by readback lets a restarted pass broadcast, and a dispatch readback does not', async (t) => {
  const w = await ebWorld(t);
  const first = w.build();
  const timeout = failure('ETIMEDOUT');
  await assert.rejects(first.boundary.pass(w.op(), w.sign(), () => { throw timeout; }, { stage: 'confirm' }), (error) => error === timeout);
  const restarted = w.build();
  await assert.rejects(restarted.boundary.pass(w.op(), w.sign(), w.send(), { stage: 'broadcast' }), { code: 'confirm_not_acknowledged' });
  await restarted.boundary.recordObserved(w.op(), 'confirm', { found: 1 });
  await restarted.boundary.pass(w.op(), w.sign(), w.send('broadcast'), { stage: 'broadcast' });
  assert.deepEqual([w.counts.signer, w.counts.transport], [1, 1]);
  assert.deepEqual(await states(restarted.history), ['signed', 'confirm-started', 'confirm-unknown', 'observed', 'broadcast-started', 'broadcast-acknowledged']);
  const other = w.op({ operationId: 'op-2', lane: 'lane-2' });
  await assert.rejects(restarted.boundary.pass(other, w.sign(), () => { throw timeout; }, { stage: 'dispatch' }), (error) => error === timeout);
  await restarted.boundary.recordObserved(other, 'dispatch', { found: 1 });
  await assert.rejects(restarted.boundary.pass(other, w.sign(), w.send(), { stage: 'broadcast' }), { code: 'confirm_not_acknowledged' });
  assert.equal(w.counts.transport, 1);
});

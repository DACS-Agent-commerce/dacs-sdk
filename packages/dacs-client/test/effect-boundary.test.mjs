// The actor fence over an injected acquire, the dispatch history's append-only
// rule beside the native transport's lane records, and, below, the boundary's
// passes over that fence and history. No network, no keys.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';
import { createEffectFence, FENCE_ACQUIRE_TIMEOUT_MS } from '../src/wallet/effect-fence.mjs';
import { createEffectHistory } from '../src/wallet/effect-history.mjs';
import { boundaryWorld, createEffectBoundary, setPurchaseAdmission, flush,
  code, digest, signedBytes, states, cutAppend, noEffects } from './helpers/effect-boundary-fixture.mjs';

// A mutex standing in for the transport owner's connection fence, with timers
// the test fires by hand.
function fakeFence({ digest = 'digest-1' } = {}) {
  const waiters = [], timers = new Map(), released = [];
  let held = false, nextTimer = 0, acquisitions = 0;
  const grantNext = () => { if (!held && waiters.length) { held = true; waiters.shift()(); } };
  return {
    released, timers,
    get acquisitions() { return acquisitions; },
    get held() { return held; },
    options: {
      acquire: () => { acquisitions += 1; const id = acquisitions; return new Promise((resolve) => { waiters.push(() => resolve({ release: () => { held = false; released.push(id); grantNext(); } })); grantNext(); }); },
      currentLocal: () => digest,
      setTimer: (fn, ms) => { nextTimer += 1; timers.set(nextTimer, { fn, ms }); return nextTimer; },
      clearTimer: (id) => { timers.delete(id); },
    },
    fire: (id) => { const timer = timers.get(id); timers.delete(id); timer.fn(); },
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const codeOf = (promise) => promise.then(() => null, (error) => error.code);
const outcomeOf = (promise) => promise.then((value) => ({ resolved: true, value }), (error) => ({ resolved: false, error }));

test('an acquisition that resolves after its timeout is released at once and grants nothing', async () => {
  const world = fakeFence();
  const fence = createEffectFence(world.options);
  let release;
  const holding = fence.withFence('op-holder', () => new Promise((resolve) => { release = resolve; }));
  await settle();
  assert.equal(world.held, true);

  let lateWork = 0, nextWork = 0;
  const late = codeOf(fence.withFence('op-late', async () => { lateWork += 1; }));
  const next = fence.withFence('op-next', async () => { nextWork += 1; return 'ran'; });
  await settle();
  const [lateTimer] = [...world.timers.keys()];
  assert.equal(world.timers.get(lateTimer).ms, FENCE_ACQUIRE_TIMEOUT_MS);
  assert.equal(FENCE_ACQUIRE_TIMEOUT_MS, 10_000);
  world.fire(lateTimer);
  assert.equal(await late, 'tp1_fence_timeout');
  release();
  await holding;
  assert.equal(await next, 'ran', 'the next waiter acquires the fence');
  assert.equal(lateWork, 0);
  assert.equal(nextWork, 1);
  assert.deepEqual(world.released, [1, 2, 3], 'the late acquisition was released before the next waiter ran');
  assert.equal(world.held, false);
});

test('nested work reuses the capability without acquiring or releasing, and the outer operation releases exactly once on success and on rejection', async () => {
  const world = fakeFence({ digest: 'digest-owner' });
  const fence = createEffectFence(world.options);
  await fence.withFence('op-a', async (capability) => {
    assert.deepEqual(capability, { connectionGeneration: 0, localDigest: 'digest-owner' });
    assert.ok(Object.isFrozen(capability));
    assert.equal(await fence.withFence('op-a', async (again) => again, { capability }), capability);
    assert.equal(world.acquisitions, 1, 'nested work never acquires again');
    assert.deepEqual(world.released, [], 'nested work never releases');
  });
  assert.deepEqual(world.released, [1]);

  const failure = new Error('nested step failed');
  const rejected = await fence.withFence('op-b', (capability) => fence.withFence('op-b', async () => { throw failure; }, { capability })).catch((error) => error);
  assert.equal(rejected, failure, 'the work\'s own error is kept');
  assert.equal(world.acquisitions, 2);
  assert.deepEqual(world.released, [1, 2], 'the outer operation released once on the rejection');
  assert.equal(world.held, false);
});

test('a capability another operation acquired, one already released, or a falsy value given as the capability is refused tp1_fence_not_owned without running the work or acquiring', async () => {
  const world = fakeFence();
  const fence = createEffectFence(world.options);
  let work = 0, seen;
  await fence.withFence('op-a', async (capability) => {
    seen = capability;
    assert.equal(await codeOf(fence.withFence('op-b', async () => { work += 1; }, { capability })), 'tp1_fence_not_owned');
    assert.equal(await codeOf(fence.withFence('op-a', async () => { work += 1; }, { capability: { ...capability } })), 'tp1_fence_not_owned', 'a copy is not the capability');
    assert.equal(world.held, true, 'a refused capability has no effect on the holder');
  });
  assert.equal(await codeOf(fence.withFence('op-a', async () => { work += 1; }, { capability: seen })), 'tp1_fence_not_owned');
  for (const falsy of [null, 0, '', false, NaN]) {
    assert.equal(await codeOf(fence.withFence('op-a', async () => { work += 1; }, { capability: falsy })), 'tp1_fence_not_owned', String(falsy));
  }
  assert.equal(work, 0);
  assert.equal(world.acquisitions, 1, 'only an omitted capability acquires');
  assert.equal(fence.release, undefined, 'only the acquiring operation\'s end releases the fence');
});

test('a release that fails after successful work rejects with the release error and leaves no capability to reuse', async () => {
  const releaseFailure = new Error('release failed');
  const fence = createEffectFence({ ...fakeFence().options, acquire: async () => ({ release: () => { throw releaseFailure; } }) });
  let kept;
  assert.equal(await fence.withFence('op-a', async (capability) => { kept = capability; }).catch((error) => error), releaseFailure);
  assert.equal(await codeOf(fence.withFence('op-a', async () => {}, { capability: kept })), 'tp1_fence_not_owned');
});

test('an acquisition without a release function or a local digest is refused tp1_fence_invalid and released, and an acquisition error keeps its identity', async () => {
  const world = fakeFence();
  let work = 0;
  const noDigest = createEffectFence({ ...world.options, currentLocal: () => undefined });
  assert.equal(await codeOf(noDigest.withFence('op-a', async () => { work += 1; })), 'tp1_fence_invalid');
  assert.deepEqual(world.released, [1], 'the unusable acquisition was released');
  const noRelease = createEffectFence({ ...world.options, acquire: async () => ({}) });
  assert.equal(await codeOf(noRelease.withFence('op-a', async () => { work += 1; })), 'tp1_fence_invalid');
  const failure = new Error('connection owner unavailable');
  const failing = createEffectFence({ ...world.options, acquire: async () => { throw failure; } });
  assert.equal(await failing.withFence('op-a', async () => { work += 1; }).catch((error) => error), failure);
  assert.equal(work, 0);
  assert.equal(world.timers.size, 0, 'no timer is left running');
});

test('a local digest read that throws after the acquisition releases the fence and keeps its error', async () => {
  const world = fakeFence();
  const failure = new Error('local binding unreadable');
  const fence = createEffectFence({ ...world.options, currentLocal: () => { throw failure; } });
  assert.equal(await fence.withFence('op-a', async () => 'ran').catch((error) => error), failure);
  assert.deepEqual(world.released, [1]);
  assert.equal(world.held, false);
});

test('a work rejection with a falsy value is still a failure: the fence is released and the caller sees the rejection, also when the release fails and inside replaceConnection', async () => {
  for (const falsy of [undefined, null, 0, '', false, NaN]) {
    const world = fakeFence();
    const fence = createEffectFence(world.options);
    const outcome = await outcomeOf(fence.withFence('op-a', () => Promise.reject(falsy)));
    assert.equal(outcome.resolved, false, `a rejection with ${String(falsy)} does not resolve`);
    assert.ok(Object.is(outcome.error, falsy), `the rejection value ${String(falsy)} is kept`);
    assert.deepEqual(world.released, [1], 'the fence is released');
    assert.equal(world.held, false);

    const failing = createEffectFence({ ...world.options, acquire: async () => ({ release: () => { throw new Error('release failed'); } }) });
    const both = await outcomeOf(failing.withFence('op-b', () => Promise.reject(falsy)));
    assert.equal(both.resolved, false);
    assert.ok(Object.is(both.error, falsy), 'the work\'s falsy rejection wins over the release error');

    const replacing = fakeFence();
    const replaced = createEffectFence(replacing.options);
    const replacement = await outcomeOf(replaced.replaceConnection(() => Promise.reject(falsy)));
    assert.equal(replacement.resolved, false);
    assert.ok(Object.is(replacement.error, falsy));
    assert.equal(replaced.connectionGeneration, 1);
    assert.equal(replacing.held, false);
  }
});

test('replaceConnection acquires the fence like an effect and increments connectionGeneration, also when the replacement throws', async () => {
  const world = fakeFence();
  const fence = createEffectFence(world.options);
  let release;
  const holding = fence.withFence('op-holder', () => new Promise((resolve) => { release = resolve; }));
  await settle();
  const calls = [];
  const replacing = fence.replaceConnection(async () => { calls.push('replace'); });
  await settle();
  assert.deepEqual(calls, [], 'the replacement waits for the holder');
  assert.equal(fence.connectionGeneration, 0);
  release();
  await holding;
  await replacing;
  assert.deepEqual(calls, ['replace']);
  assert.equal(fence.connectionGeneration, 1);
  assert.equal(world.held, false);

  const failure = new Error('replace failed');
  assert.equal(await fence.replaceConnection(async () => { throw failure; }).catch((error) => error), failure);
  assert.equal(fence.connectionGeneration, 2, 'a failed replacement may have changed the connection');
  await fence.withFence('op-after', async (capability) => assert.equal(capability.connectionGeneration, 2));
});

test('the dispatch history is append-only and never rewrites the native transport\'s lane records', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'effect-boundary-'));
  const path = join(dir, 'journal.sqlite');
  const journal = openDurableWalletJournal({ path, mode: 'create' });
  const opened = [journal];
  t.after(() => { for (const j of opened) { try { j.close(); } catch { /* closed by the test */ } } rmSync(dir, { recursive: true, force: true }); });

  const lane = 'devnet/native-wallet/TEST-lane';
  const artifactHash = '2'.repeat(64);
  const nativeRecords = [[lane, { stage: 'broadcast-started', hash: artifactHash }], [`devnet/native-transfer/${artifactHash}`, { stage: 'broadcast-started', hash: artifactHash }]];
  for (const [key, value] of nativeRecords) await journal.put(key, value);
  const puts = [];
  const counted = (target) => ({ ...target, put: (key, value) => { puts.push(key); return target.put(key, value); } });
  const entry = (passId, state) => ({ lane, artifactHash, passId, state });

  await createEffectHistory({ journal: counted(journal) }).append(entry('pass-1', 'dispatch-started'));
  journal.close();
  const restarted = openDurableWalletJournal({ path, mode: 'open' });
  opened.push(restarted);
  const history = createEffectHistory({ journal: counted(restarted) });
  assert.deepEqual(await history.append(entry('pass-1', 'dispatch-started')), { status: 'existing' });
  await history.append(entry('pass-1', 'dispatch-withheld'));
  await history.append(entry('pass-2', 'dispatch-started'));

  const keys = (await restarted.entries()).map(([key]) => key);
  assert.deepEqual(keys.filter((key) => !key.startsWith('eb/')), nativeRecords.map(([key]) => key), 'the native lane and intent keys are the only others');
  assert.equal(keys.filter((key) => key.startsWith('eb/')).length, 3, 'a repeated append added nothing');
  for (const [key, value] of nativeRecords) assert.deepEqual(await restarted.get(key), value, 'a native lane record is never rewritten');
  assert.deepEqual(puts, [], 'the history never used put');
  assert.deepEqual((await history.read({ lane, artifactHash })).map((r) => [r.passId, r.state]), [['pass-1', 'dispatch-started'], ['pass-1', 'dispatch-withheld'], ['pass-2', 'dispatch-started']]);
});

// P16a1b K0 pass vectors. Test-only admission seam; real durable history/fence.
const digestBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');

test("an EB pass runs EB1 to EB9 in order and refuses with profile_not_admitted, writes_stopped, fee_ceiling_required and the tp1 codes in K0's order", async t => {
  const w = await boundaryWorld(t);
  w.authority.state.gate = async () => w.events.push('authority');
  const append = w.history.append;
  w.history.append = async record => { w.events.push(record.state); return append(record); };
  await w.run();
  assert.deepEqual(w.events, ['stop', 'authority', 'stop', 'authority', 'stop', 'sign', 'signed', 'stop', 'authority', 'dispatch-started', 'stop', 'send', 'dispatch-acknowledged']);
  assert.equal(w.acquired, 1); assert.equal(w.released, 1);
  for (const [held, stopped, fee, binding, expected] of [
    [true, true, undefined, {}, 'profile_not_admitted'], [false, true, undefined, {}, 'writes_stopped'],
    [false, false, undefined, {}, 'fee_ceiling_required'], [false, false, '1', {}, 'write-fee-cap'],
    [false, false, '50000000000', {}, 'tp1_binding_required'],
  ]) {
    setPurchaseAdmission(held ? 'held' : 'testnet-tp1'); w.stopped = stopped;
    w.resetBoundary({ feeCeilingOs: fee, binding });
    await assert.rejects(w.sign(), code(expected));
  }
});

test("crash cuts before persistence, after persistence, after dispatch intent and after transmission leave K0's states and restart actions", async t => {
  for (const [state, after, retained] of [['signed', false, []], ['signed', true, ['signed']],
    ['dispatch-started', true, ['signed', 'dispatch-started']], ['dispatch-acknowledged', false, ['signed', 'dispatch-started', 'dispatch-unknown']]]) {
    const w = await boundaryWorld(t);
    cutAppend(w, state, { after });
    const artifact = { ...w.op, artifactHash: digestBytes(signedBytes) };
    await assert.rejects(w.run());
    w.reopen();
    assert.deepEqual(await states(w, artifact), retained);
    if (state === 'signed' && !after) await w.run();
    else if (state === 'signed') await w.send(artifact);
    else await assert.rejects(w.send(artifact), code('eb_readback_required'));
    assert.equal(w.sent.length, state === 'dispatch-started' ? 0 : 1);
    for (const bytes of w.sent) assert.deepEqual(bytes, signedBytes);
  }
});

test("a failed acknowledgement write after a successful send reports eb_ack_not_persisted with the send result and the write failure as its cause", async t => {
  const w = await boundaryWorld(t), failure = Object.assign(new Error('TEST-disk-failed'), { code: 'EIO' });
  const artifact = await w.sign();
  cutAppend(w, 'dispatch-acknowledged', { error: failure });
  cutAppend(w, 'dispatch-unknown', { error: failure });
  await assert.rejects(w.send(artifact), error => error.code === 'eb_ack_not_persisted' && error.details?.result === 'TEST-ack'
    && error.cause.code === 'eb_persist_failed' && error.cause.cause === failure && !/nothing was transmitted/.test(error.message));
  assert.equal(w.sent.length, 1); assert.equal(w.held, false);
  w.reopen();
  assert.deepEqual(await states(w, artifact), ['signed', 'dispatch-started']);
  await assert.rejects(w.send(artifact), code('eb_readback_required'));
  assert.equal(w.sent.length, 1);
});

test("a failed send still refuses with the send's own error and a lost unknown record does not replace it", async t => {
  const w = await boundaryWorld(t), sendFailure = new Error('TEST-send-failed'), writeFailure = new Error('TEST-disk-failed');
  const artifact = await w.sign();
  cutAppend(w, 'dispatch-unknown', { error: writeFailure });
  await assert.rejects(w.boundary.dispatchPass(artifact, () => { throw sendFailure; }), error => error === sendFailure);
  assert.equal(w.held, false);
  assert.deepEqual(await states(w, artifact), ['signed', 'dispatch-started']);
});

test("a failed persistence write transmits nothing and refuses eb_persist_failed with EIO as its cause", async t => {
  const w = await boundaryWorld(t), failure = Object.assign(new Error('TEST-disk-failed'), { code: 'EIO' });
  cutAppend(w, 'signed', { error: failure });
  await assert.rejects(w.run(), error => error.code === 'eb_persist_failed' && error.cause === failure);
  assert.equal(w.sent.length, 0); assert.equal(w.held, false);
});

test("a stop observed between persistence and EB7 keeps the signature signed-held, also after restart", async t => {
  const w = await boundaryWorld(t);
  cutAppend(w, 'signed', { mutate: () => { w.stopped = true; } });
  await assert.rejects(w.run(), code('writes_stopped'));
  const artifact = { ...w.op, artifactHash: digestBytes(signedBytes) };
  w.reopen(); w.stopped = false;
  assert.deepEqual(await states(w, artifact), ['signed', 'signed-held']);
  await assert.rejects(w.send(artifact), code('eb_explicit_resume_required'));
  assert.equal(w.sent.length, 0);
});

test("a transport that throws after the receiver recorded the bytes is dispatch-unknown, and readback moves it to observed", async t => {
  const w = await boundaryWorld(t), artifact = await w.sign(), failure = new Error('TEST-answer-lost');
  await assert.rejects(w.boundary.dispatchPass(artifact, bytes => { w.sent.push(Buffer.from(bytes)); throw failure; }), error => error === failure);
  w.reopen();
  assert.deepEqual(await states(w, artifact), ['signed', 'dispatch-started', 'dispatch-unknown']);
  // A composition's authenticated readback adds observation; a saved ack is never send authority.
  await w.history.append({ ...artifact, passId: 'TEST-readback', state: 'observed', result: 'TEST-source-found' });
  await assert.rejects(w.send(artifact), code('eb_readback_required'));
  assert.equal(w.sent.length, 1); assert.equal((await states(w, artifact)).at(-1), 'observed');
});

test("an acknowledged confirmation then a crash broadcasts once on restart; a lost confirmation answer is confirm-unknown", async t => {
  for (const lost of [false, true]) {
    const w = await boundaryWorld(t), confirmed = await w.sign({ ...w.op, lane: 'TEST-confirm', kind: 'confirm' });
    const dispatch = w.boundary.dispatchPass(confirmed, bytes => { assert.deepEqual(bytes, signedBytes); if (lost) throw new Error('TEST-confirm-answer-lost'); return 'TEST-confirmed'; });
    if (lost) await assert.rejects(dispatch); else await dispatch;
    w.reopen();
    assert.equal((await states(w, confirmed)).at(-1), lost ? 'dispatch-unknown' : 'dispatch-acknowledged');
    // Simulate the lane policy that P16a2ba wires: only an acknowledged confirm advances.
    if ((await states(w, confirmed)).at(-1) === 'dispatch-acknowledged') {
      const broadcast = { ...w.op, lane: 'TEST-broadcast', kind: 'native', artifactHash: confirmed.artifactHash };
      const original = (await w.history.read(confirmed)).find(record => record.state === 'signed');
      await w.history.append({ ...broadcast, passId: 'TEST-broadcast-original', state: 'signed', bytes: original.bytes });
      await w.send(broadcast); w.reopen();
      await assert.rejects(w.send(broadcast), code('eb_readback_required'));
      assert.deepEqual(w.sent, [signedBytes]); assert.equal(w.signatures, 1, 'broadcast retains the original transaction without signing again');
    } else { await assert.rejects(w.send(confirmed), code('eb_readback_required')); assert.equal(w.sent.length, 0); }
  }
});

test("authority reads that reject, stall, resolve late or exceed their byte or list bound sign nothing and keep their cause", async t => {
  for (const variant of ['reject', 'stall', 'late', 'bytes', 'list']) {
    const w = await boundaryWorld(t), failure = new Error('TEST-authority-' + variant);
    let answer;
    w.authority.state.gate = async () => {
      if (variant === 'reject') throw failure;
      if (variant === 'stall' || variant === 'late') await new Promise(resolve => { answer = resolve; });
      if (variant === 'bytes' || variant === 'list') {
        // The composition reader owns byte bounds before decode and list bounds afterward.
        const bytes = Buffer.from(variant === 'bytes' ? 'oversized' : '[1,2]');
        if (bytes.length > 8) throw failure;
        if (JSON.parse(bytes).length > 1) throw failure;
      }
    };
    const result = w.sign().catch(error => error);
    await flush();
    if (answer) { w.clock.advance(10_001); if (variant === 'late') answer(); }
    const error = await result;
    if (answer) assert.equal(error.code, 'tp1_authority_timeout'); else assert.equal(error, failure);
    assert.equal(w.signatures, 0); assert.equal(w.sent.length, 0); assert.equal(w.held, false);
    assert.equal(w.clock.timers.size, 0);
  }
});

test("a stop check that rejects, stalls or answers a non-boolean counts as stopped with its cause", async t => {
  for (const variant of ['reject', 'stall', 'invalid']) {
    const w = await boundaryWorld(t), failure = new Error('TEST-stop-failed');
    w.resetBoundary({ stopped: () => { if (variant === 'reject') throw failure; if (variant === 'stall') return new Promise(() => {}); return 'false'; } });
    const result = w.sign().catch(error => error); await flush();
    if (variant === 'stall') w.clock.advance(10_001);
    const error = await result;
    assert.equal(error.code, 'stop_check_' + (variant === 'reject' ? 'failed' : variant === 'stall' ? 'timeout' : 'invalid'));
    if (variant === 'reject') assert.equal(error.cause, failure);
    assert.equal(w.signatures, 0); assert.equal(w.sent.length, 0);
  }
});

test("two purchases on one connection never interleave sign-to-dispatch, and when its fence changes the second binds to the new generation", async t => {
  const w = await boundaryWorld(t);
  await Promise.all([w.run(), w.run({ ...w.op, operationId: 'TEST-second', lane: 'TEST-second' })]);
  assert.deepEqual(w.events.filter(e => e === 'sign' || e === 'send'), ['sign', 'send', 'sign', 'send']);
  assert.equal(w.acquired, 2); assert.equal(w.released, 2);
  await w.boundary.replaceConnection(() => {});
  await w.run({ ...w.op, operationId: 'TEST-third', lane: 'TEST-third' });
  assert.equal(w.fence.connectionGeneration, 1);
  const late = await boundaryWorld(t);
  let release;
  const holder = late.fence.withFence('TEST-holder', () => new Promise(resolve => { release = resolve; }));
  await flush();
  const waiting = late.sign().catch(error => error);
  await flush(); late.clock.advance(10_001);
  assert.equal((await waiting).code, 'tp1_fence_timeout');
  release(); await holder; await flush();
  assert.equal(late.released, 2, 'the timed-out boundary acquisition is released when it arrives');
  assert.equal(late.signatures, 0); assert.equal(late.sent.length, 0);
});

test("authority reads take no fence and call no signer", async t => {
  const w = await boundaryWorld(t);
  w.authority.state.gate = async () => { const before = [w.acquired, w.signatures]; await Promise.resolve(); assert.deepEqual([w.acquired, w.signatures], before); };
  await w.run();
  assert.equal(w.acquired, 1); assert.equal(w.signatures, 1);
});

test("with no host fee ceiling a pass refuses fee_ceiling_required; a debit equal to a supplied 50 DEM passes and 50 DEM plus 1 OS refuses", async t => {
  const w = await boundaryWorld(t);
  for (const feeCeilingOs of [undefined, null, '', '1.5', '-1', 50_000_000_000, '050']) {
    w.resetBoundary({ feeCeilingOs }); await noEffects(w, w.sign(), 'fee_ceiling_required');
  }
  w.resetBoundary();
  w.approval = { rev: 1, open: false };
  await noEffects(w, w.sign({ ...w.op, approvalRef: { ...w.approval } }), 'write-fee-cap');
  w.approval = { rev: 1, open: true };
  await noEffects(w, w.sign({ ...w.op, debitOs: '50000000001' }), 'write-fee-cap');
  for (const debitOs of [undefined, '-1', '1e9', '00']) await noEffects(w, w.sign({ ...w.op, debitOs }), 'write-fee-cap');
  await w.run(); assert.equal(w.sent.length, 1);
});

test("a lane stamped with another pin version is readback-only: pin_version_retired", async t => {
  const w = await boundaryWorld(t);
  await noEffects(w, w.sign({ ...w.op, pinVersion: 'TEST-retired' }), 'pin_version_retired');
  const artifact = await w.sign(); w.reopen();
  await assert.rejects(w.send({ ...artifact, pinVersion: 'TEST-retired' }), code('pin_version_retired'));
  // A lane the history stamped with an older pin is refused even when the caller names the current one.
  const retired = { ...w.op, lane: 'TEST-retired-lane', pinVersion: 'TEST-retired', artifactHash: digestBytes(signedBytes) };
  await w.history.append({ ...retired, passId: 'TEST-old-pass', state: 'signed', bytes: signedBytes.toString('base64') });
  await assert.rejects(w.send({ ...retired, pinVersion: w.op.pinVersion }), code('pin_version_retired'));
  assert.equal(w.sent.length, 0);
});

test("while held, every pass refuses profile_not_admitted before any read", async t => {
  const w = await boundaryWorld(t); setPurchaseAdmission('held');
  const artifact = { ...w.op, artifactHash: digestBytes(signedBytes) };
  for (const run of [() => w.sign(), () => w.send(artifact), () => w.boundary.signerFor(w.op, { claim: 'TEST-claim', sign: () => signedBytes }).sign(signedBytes)]) {
    await noEffects(w, run(), 'profile_not_admitted');
  }
  assert.deepEqual(w.events, []); assert.equal(w.acquired, 0);
});

test('missing boundary sources throw TypeError and caller admission cannot lift the package hold', async t => {
  const w = await boundaryWorld(t);
  for (const field of ['binding', 'currentLocal', 'history', 'fence', 'stopped']) assert.throws(() => createEffectBoundary({ ...w.options(), [field]: undefined }), TypeError);
  w.resetBoundary({ admitted: () => true }); setPurchaseAdmission('held');
  await noEffects(w, w.sign(), 'profile_not_admitted');
});


test('released async operation contexts cannot sign or send and a foreign nested operation cannot borrow the fence', async t => {
  const w = await boundaryWorld(t);
  let escaped, release;
  const go = new Promise(resolve => { release = resolve; });
  await w.boundary.withOperation(w.op, async () => {
    escaped = go.then(() => w.sign());
    await assert.rejects(w.boundary.signPass({ ...w.op, operationId: 'TEST-foreign' }, () => signedBytes), code('tp1_fence_not_owned'));
  });
  release(); await noEffects(w, escaped, 'tp1_fence_not_owned');
});

test('missing, mismatched or malformed retained history never permits transmission', async t => {
  for (const variant of ['missing', 'metadata', 'bytes', 'state']) {
    const w = await boundaryWorld(t), artifact = await w.sign();
    const read = w.history.read;
    w.history.read = async op => { const records = await read(op); if (variant === 'missing') return []; const last = records.at(-1);
      if (variant === 'metadata') last.operationId = 'TEST-other';
      if (variant === 'bytes') last.bytes = Buffer.from('TEST-wrong-bytes').toString('base64');
      if (variant === 'state') last.state = 'TEST-unknown-state';
      return records;
    };
    await assert.rejects(w.send(artifact), code('eb_history_unavailable'));
    assert.equal(w.sent.length, 0); assert.equal(w.held, false);
  }
});

test('a signer failure and a failed dispatch-intent append release the fence without sending', async t => {
  const w = await boundaryWorld(t), failure = new Error('TEST-sign-failed');
  await assert.rejects(w.boundary.signPass(w.op, () => { throw failure; }), error => error === failure);
  assert.equal(w.held, false);
  const artifact = await w.sign();
  cutAppend(w, 'dispatch-started', { error: failure });
  await assert.rejects(w.send(artifact), error => error.code === 'eb_persist_failed' && error.cause === failure);
  assert.equal(w.held, false); assert.equal(w.sent.length, 0);
  w.reopen(); await w.send(artifact); assert.equal(w.sent.length, 1);
});

test('caller mutations during an authority await cannot change retained operation authorization', async t => {
  const w = await boundaryWorld(t), original = structuredClone(w.op);
  w.authority.state.gate = async () => { w.op.debitOs = '0'; w.op.approvalRef.rev = 2; w.op.k1Rev = 99; };
  const artifact = await w.sign();
  assert.deepEqual({ ...artifact, artifactHash: undefined }, { ...original, artifactHash: undefined });
  const records = await w.history.read(artifact);
  assert.equal(records[0].debitOs, original.debitOs); assert.equal(records[0].approvalRef.rev, 1);
});


test('CREATE and wire replay require their composition policy while a possible native dispatch is never repeated', async t => {
  for (const kind of ['native', 'create', 'wire']) {
    const w = await boundaryWorld(t), artifact = await w.sign({ ...w.op, kind });
    await w.send(artifact);
    for (const replayPolicy of [undefined, () => false, async () => true]) {
      w.resetBoundary({ replayPolicy });
      await assert.rejects(w.send(artifact), code('eb_readback_required'));
    }
    w.resetBoundary({ replayPolicy: (op, records) => { assert.equal(op.kind, kind); assert.equal(records.at(-1).state, 'dispatch-acknowledged'); return true; } });
    if (kind === 'native') await assert.rejects(w.send(artifact), code('eb_readback_required'));
    else await w.send(artifact);
    assert.equal(w.sent.length, kind === 'native' ? 1 : 2);
    for (const bytes of w.sent) assert.deepEqual(bytes, signedBytes);
  }
});

// A held artifact: its first pass saw a stop right after dispatch-started and withheld the bytes.
async function heldArtifact(t) {
  const w = await boundaryWorld(t), artifact = await w.sign();
  cutAppend(w, 'dispatch-started', { mutate: () => { w.stopped = true; } });
  await assert.rejects(w.send(artifact), code('writes_stopped'));
  w.reopen(); w.stopped = false;
  assert.deepEqual(await states(w, artifact), ['signed', 'dispatch-started', 'dispatch-withheld']);
  return { w, artifact };
}

test('an explicit resume of a held artifact sends it once and a later resume is refused eb_readback_required', async t => {
  const { w, artifact } = await heldArtifact(t);
  assert.equal(await w.send(artifact, { explicit: true }), 'TEST-ack');
  await assert.rejects(w.send(artifact, { explicit: true }), code('eb_readback_required'));
  assert.deepEqual(w.sent, [signedBytes]);
});

test('two boundaries with their own fences resuming one held artifact at once send it once; the later pass is withheld eb_readback_required', async t => {
  const { w, artifact } = await heldArtifact(t);
  const fence = createEffectFence({ currentLocal: () => digest(w.currentLocal()), acquire: async () => ({ release: () => {} }),
    setTimer: w.clock.setTimer, clearTimer: w.clock.clearTimer });
  const other = createEffectBoundary({ ...w.options(), fence });
  const send = bytes => { w.sent.push(Buffer.from(bytes)); return 'TEST-ack'; };
  const outcomes = await Promise.all([w.boundary.dispatchPass(artifact, send, { explicit: true }), other.dispatchPass(artifact, send, { explicit: true })].map(outcomeOf));
  assert.deepEqual(w.sent, [signedBytes]);
  assert.deepEqual(outcomes.map(outcome => outcome.resolved ? outcome.value : outcome.error.code).sort(), ['TEST-ack', 'eb_readback_required']);
  const resumed = (await states(w, artifact)).slice(3);
  assert.equal(resumed.filter(state => state === 'dispatch-acknowledged').length, 1);
  assert.equal(resumed.filter(state => state === 'dispatch-withheld').length, 1);
});


test('identical bytes on another lane do not reuse the first lanes post-sign authorization', async t => {
  const w = await boundaryWorld(t);
  const other = await w.sign({ ...w.op, lane: 'TEST-other' });
  await w.boundary.withOperation(w.op, async () => {
    await w.sign();
    let reads = 0;
    w.authority.state.gate = async () => { reads++; w.stopped = true; };
    await assert.rejects(w.send(other), code('writes_stopped'));
    assert.equal(reads, 1, 'the other lane refreshes its authority before dispatch');
  });
  assert.equal(w.sent.length, 0);
});

test('the EB signer returns a string signature exactly as the inner signer gave it and persists its bytes', async t => {
  const w = await boundaryWorld(t), signature = 'TEST-string-signature';
  const signer = w.boundary.signerFor(w.op, { claim: 'TEST-claim', sign: () => signature });
  assert.equal(await signer.sign(signedBytes), signature);
  const [stored] = await w.history.read({ lane: w.op.lane, artifactHash: digestBytes(Buffer.from(signature)) });
  assert.equal(stored.state, 'signed'); assert.equal(Buffer.from(stored.bytes, 'base64').toString(), signature);
});

// The actor fence over an injected acquire, and the dispatch history's
// append-only rule beside the native transport's lane records. No network, no keys.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';
import { createEffectFence, FENCE_ACQUIRE_TIMEOUT_MS } from '../src/wallet/effect-fence.mjs';
import { createEffectHistory } from '../src/wallet/effect-history.mjs';

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

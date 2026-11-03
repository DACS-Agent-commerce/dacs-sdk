// P16a1a: the actor fence (EB5) over an injected acquire, and the dispatch
// history's append-only rule beside the native transport's lane records. The
// boundary's passes are a later PR and extend this file. No network, no keys.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';
import { createEffectFence } from '../src/wallet/effect-fence.mjs';
import { createEffectHistory } from '../src/wallet/effect-history.mjs';

const FENCE_TIMEOUT_MS = 10_000;

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

test('fence ownership: a late acquisition is released, nested work reuses the capability, and a foreign capability or a non-owner release is refused', async () => {
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
  assert.equal(world.timers.get(lateTimer).ms, FENCE_TIMEOUT_MS);
  world.fire(lateTimer);
  assert.equal(await late, 'tp1_fence_timeout');
  release();
  await holding;
  assert.equal(await next, 'ran', 'the next waiter acquires the fence');
  assert.equal(lateWork, 0, 'a late acquisition grants nothing');
  assert.equal(nextWork, 1);
  assert.deepEqual(world.released, [1, 2, 3], 'the late acquisition was released at once, before the next waiter ran');
  assert.equal(world.held, false);

  const owner = fakeFence({ digest: 'digest-owner' });
  const owned = createEffectFence(owner.options);
  let seen;
  await owned.withFence('op-a', async (capability) => {
    seen = capability;
    assert.equal(capability.connectionGeneration, 0);
    assert.equal(capability.localDigest, 'digest-owner');
    const nested = await owned.withFence('op-a', async (again) => again, { capability });
    assert.equal(nested, capability, 'nested work reuses the capability');
    assert.equal(owner.acquisitions, 1, 'nested work never acquires again');
    assert.deepEqual(owner.released, [], 'a nested step never releases');
    let foreignWork = 0;
    assert.equal(await codeOf(owned.withFence('op-b', async () => { foreignWork += 1; }, { capability })), 'tp1_fence_not_owned');
    assert.equal(foreignWork, 0);
    assert.equal(await codeOf(owned.release(capability, 'op-b')), 'tp1_fence_not_owned');
    assert.equal(owner.held, true, 'a non-owner release has no effect');
    assert.deepEqual(owner.released, []);
  });
  assert.deepEqual(owner.released, [1], 'only the owner released it, once');
  assert.equal(await codeOf(owned.withFence('op-a', async () => {}, { capability: seen })), 'tp1_fence_not_owned', 'a released capability grants nothing');
  assert.equal(await codeOf(owned.release(seen, 'op-a')), 'tp1_fence_not_owned');

  const failure = new Error('work failed');
  assert.equal(await owned.withFence('op-c', async () => { throw failure; }).catch((error) => error), failure, 'the work\'s own error is kept');
  assert.equal(owner.held, false, 'the fence is released on an exception');
  assert.equal(owner.released.length, 2);
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
  const counted = { ...journal, put: (key, value) => { puts.push(key); return journal.put(key, value); } };
  const entry = (passId, state) => ({ lane, artifactHash, passId, state });

  await createEffectHistory({ journal: counted }).append(entry('pass-1', 'dispatch-started'));
  journal.close();
  const restarted = openDurableWalletJournal({ path, mode: 'open' });
  opened.push(restarted);
  const history = createEffectHistory({ journal: { ...restarted, put: (key, value) => { puts.push(key); return restarted.put(key, value); } } });
  await history.append(entry('pass-1', 'dispatch-started'));
  await history.append(entry('pass-1', 'dispatch-withheld'));
  await history.append(entry('pass-2', 'dispatch-started'));

  const keys = (await restarted.entries()).map(([key]) => key);
  assert.deepEqual(keys.filter((key) => !key.startsWith('eb/')), nativeRecords.map(([key]) => key), 'the native lane and intent keys are the only others');
  assert.equal(keys.filter((key) => key.startsWith('eb/')).length, 3, 'a repeated append added nothing');
  for (const [key, value] of nativeRecords) assert.deepEqual(await restarted.get(key), value, 'a native lane record is never rewritten');
  assert.deepEqual(puts, [], 'the history never used put');
  assert.deepEqual((await history.read({ lane, artifactHash })).map((r) => [r.seq, r.state]), [[1, 'dispatch-started'], [2, 'dispatch-withheld'], [3, 'dispatch-started']]);
});

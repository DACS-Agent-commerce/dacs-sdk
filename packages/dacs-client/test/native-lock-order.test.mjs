// P16a0: the native transport takes the connection fence before the wallet lane
// everywhere, and a lane lock left by a killed process is reclaimed without
// resending. Uses the real transport and durable journal over a scripted TEST
// node; crash tests kill a real child while it holds the lane. No network.
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';
import { setPurchaseAdmission } from './helpers/effect-boundary-fixture.mjs';
import { boundedCreateWorld } from './helpers/native-create-boundary.mjs';
import { createWorld, JOB_IDS, operation } from './helpers/native-create-world.mjs';

const CHILD = fileURLToPath(new URL('./helpers/native-lock-order-child.mjs', import.meta.url));
const SETTLED = () => {};

function tempJournal(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'native-lock-order-'));
  const path = join(dir, 'journal.sqlite');
  const journal = openDurableWalletJournal({ path, mode: 'create', ...options });
  t.after(() => { journal.close(); rmSync(dir, { recursive: true, force: true }); });
  return { path, journal };
}

// Runs the child to its kill point and returns what it reported.
async function killedChild(t, { path, scenario }) {
  const env = { ...process.env, DACS_LOCK_ORDER_JOURNAL: path, DACS_LOCK_ORDER_SCENARIO: scenario };
  delete env.NODE_TEST_CONTEXT;
  const child = fork(CHILD, [], { env, execArgv: [] });
  t.after(() => child.kill('SIGKILL'));
  const reports = [];
  child.on('message', (message) => reports.push(message));
  const signal = await new Promise((resolve) => child.once('exit', (code, sig) => resolve(sig ?? code)));
  return { signal, reports };
}

test('a real child killed at broadcast-started, and separately after recovery reserves its sole resend, then reopened: the lock is reclaimed, the native lane stays readback-only and recovery never resends twice', async (t) => {
  {
    const { path, journal } = tempJournal(t);
    const world = createWorld({ journal });
    const leased = await world.makeCreate(JOB_IDS[1], 2);
    const crashed = await killedChild(t, { path, scenario: 'leased-broadcast' });
    assert.equal(crashed.signal, 'SIGKILL');
    assert.deepEqual(crashed.reports, [{ event: 'at-broadcast', sentBefore: 0 }]);
    const left = journal.inspectLocks();
    assert.deepEqual(left.map((lock) => [lock.key, lock.holder]), [[world.laneKey, 'exited'], [world.reservationKey, 'exited']]);
    const lane = await journal.get(world.laneKey);
    assert.equal(lane.stage, 'broadcast-started');
    assert.equal(lane.hash, leased.hash);

    assert.deepEqual(await world.readback(leased.hash), { disposition: 'pending', hash: leased.hash, nonce: 2, noResend: true });
    assert.deepEqual(journal.inspectLocks(), [], 'the readback reclaimed the dead holder\'s lock');
    assert.ok(!journal.inspectLocks().some((lock) => lock.key === world.reservationKey), 'the readback cleared the dead holder\'s reservation lock row');
    assert.equal(await journal.get(world.reservationKey), undefined, 'the readback wrote no reservation record');
    await assert.rejects(world.lease(), { code: 'outcome_unknown' });
    assert.deepEqual(await journal.get(world.laneKey), lane, 'the lane record is untouched');
    assert.deepEqual(world.sent, { confirms: [], broadcasts: [] }, 'nothing was sent after the crash');
  }
  {
    const { path, journal } = tempJournal(t);
    const world = createWorld({ journal });
    const retained = await world.makeCreate(JOB_IDS[0], 1);
    await world.retain(retained, 'broadcast-accepted', { signed: true });
    const crashed = await killedChild(t, { path, scenario: 'recovery' });
    assert.equal(crashed.signal, 'SIGKILL');
    assert.deepEqual(crashed.reports, [{ event: 'at-broadcast', sentBefore: 0 }]);
    assert.deepEqual(journal.inspectLocks().map((lock) => [lock.key, lock.holder]), [[world.laneKey, 'exited']]);
    const lane = await journal.get(world.laneKey);
    assert.equal(lane.storageWriteResends, 1, 'the sole resend was reserved before the kill');

    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.deepEqual(await world.recover(retained), { disposition: 'pending', hash: retained.hash, noResend: true });
    }
    assert.deepEqual(journal.inspectLocks(), []);
    assert.deepEqual(await journal.get(world.laneKey), lane, 'the lane record is untouched');
    assert.deepEqual(world.sent, { confirms: [], broadcasts: [] }, 'recovery never resends after the reservation');
  }
});

// The journal with each lane lock counted per operation and key. A lane taken again by an operation that already
// holds it is listed in `reacquired`; a history append inside a frame that holds the lane reuses it and counts nothing.
function countingLanes(journal, events) {
  const held = new Map(), reacquired = [];
  const enter = (key, work) => {
    const id = JSON.stringify([operation.getStore() ?? null, key]);
    if (held.get(id) > 0) reacquired.push(id);
    held.set(id, (held.get(id) ?? 0) + 1);
    events.push({ op: operation.getStore(), kind: 'lane', key });
    return Promise.resolve().then(work).finally(() => held.set(id, held.get(id) - 1));
  };
  return { reacquired, get: (key) => journal.get(key), put: (key, value) => journal.put(key, value), entries: () => journal.entries(),
    appendUnderLock: (...args) => journal.appendUnderLock(...args),
    withWalletLock: (key, work) => enter(key, () => journal.withWalletLock(key, work)),
    withOwnedOrAcquiredLane: (key, work) => (held.get(JSON.stringify([operation.getStore() ?? null, key])) > 0 ? journal.withOwnedOrAcquiredLane(key, work) : enter(key, () => journal.withOwnedOrAcquiredLane(key, work))) };
}

// A leased CREATE through the effect boundary while `name` runs on the same address, as `overlap` does without one.
// `change` runs when the other operation has started, before the leased broadcast. Recovery arriving during the
// leased broadcast finds the retained CREATE with a signed record and no lane row, so the leased broadcast goes out.
async function boundedOverlap(t, { name, arrival, change = () => {} }) {
  const events = [], hooks = {};
  let lanes;
  const c = await boundedCreateWorld(t, { journalOptions: { lockTimeoutMs: 300 }, events, wrap: (journal) => (lanes = countingLanes(journal, events)) });
  c.nodeHook = async (message, call) => { await hooks[message]?.(call); };
  const retained = await c.world.makeCreate(JOB_IDS[0], 1), leased = await c.world.makeCreate(JOB_IDS[1], 2);
  if (name === 'readback') await c.world.retain(retained, 'observed');
  if (name === 'recovery') { const first = await c.world.lease(); await c.world.confirm(retained); await c.world.release(first); }
  const lease = await c.world.lease();
  if (name === 'recovery' && arrival === 'confirmation') await c.world.retain(retained, 'broadcast-accepted');
  let other;
  const outsideLocks = AsyncLocalStorage.snapshot();
  const trigger = arrival === 'confirmation' ? 'confirmTx' : 'broadcastTx';
  hooks[trigger] = async () => {
    delete hooks[trigger];
    other = outsideLocks(() => operation.run(name, () => (name === 'readback' ? c.world.readback(retained.hash) : c.world.recover(retained))));
    await Promise.race([c.owner.queued(), other.then(SETTLED, SETTLED)]);
    change(c);
  };
  const leasedOutcome = await operation.run('leased', async () => c.world.broadcast(lease, await c.world.confirm(leased), leased.hash)).then(() => 'accepted', (error) => error.code);
  await c.world.release(lease);
  return { c, events, lanes, leased, retained, leasedOutcome, other: await other };
}

test('actual broadcast, confirmation and CREATE recovery with the real history adapter and durable journal make zero same-key lane reacquisitions for their history; an effect pass overlapped by barriers with readback and with CREATE recovery on the same actor and lane completes in both arrival orders without a lock-cycle timeout, while a stop, a re-hold and a connection change still refuse the effect; a foreign lane owner refuses', async (t) => {
  // The history of a whole send and of a recovery is appended inside the frames that hold the lane.
  const events = [];
  let lanes;
  const whole = await boundedCreateWorld(t, { events, wrap: (journal) => (lanes = countingLanes(journal, events)) });
  const { tx } = await operation.run('send', () => whole.send(JOB_IDS[0], 1));
  await operation.run('recovery', () => whole.world.recover(tx));
  assert.deepEqual(lanes.reacquired, []);
  assert.equal((await whole.states(tx)).length, 12, 'every history record was appended');
  assert.equal(whole.calls.broadcastTx, 2);

  // The same overlaps as without a boundary: nothing waits on a lock cycle, and the reads send nothing of their own.
  for (const arrival of ['confirmation', 'broadcast']) {
    const read = await boundedOverlap(t, { name: 'readback', arrival });
    assert.equal(read.leasedOutcome, 'accepted', `readback during ${arrival}`);
    assert.deepEqual(read.other, { disposition: 'pending', hash: read.retained.hash, nonce: 1, noResend: true });
    assert.deepEqual(read.lanes.reacquired, []);
    assert.deepEqual(read.c.calls, { confirmTx: 1, broadcastTx: 1 });
  }
  const recovery = await boundedOverlap(t, { name: 'recovery', arrival: 'confirmation' });
  assert.equal(recovery.leasedOutcome, 'outcome_unknown');
  assert.deepEqual(recovery.other, { disposition: 'pending', hash: recovery.retained.hash, noResend: true });
  assert.deepEqual(recovery.lanes.reacquired, []);
  assert.deepEqual(recovery.events.filter((e) => e.op === 'recovery').map((e) => e.kind), ['fence', 'lane']);
  assert.deepEqual(recovery.c.calls, { confirmTx: 3, broadcastTx: 1 }, 'recovery confirmed, and its resend waited for the lease to end');
  const duringBroadcast = await boundedOverlap(t, { name: 'recovery', arrival: 'broadcast' });
  assert.equal(duringBroadcast.leasedOutcome, 'accepted');
  assert.deepEqual(duringBroadcast.other, { disposition: 'pending', hash: duringBroadcast.retained.hash, noResend: true });
  assert.deepEqual(duringBroadcast.lanes.reacquired, []);
  assert.deepEqual(duringBroadcast.events.filter((e) => e.op === 'recovery').map((e) => e.kind).slice(0, 2), ['fence', 'lane']);
  assert.deepEqual(duringBroadcast.c.calls, { confirmTx: 2, broadcastTx: 1 }, 'only the leased CREATE was broadcast');

  // A stop, a re-hold or a connection change that arrives while the other operation waits refuses the leased broadcast.
  for (const [code, change] of [['writes_stopped', (c) => { c.stopped = true; }], ['profile_not_admitted', () => setPurchaseAdmission('held')],
    ['tp1_local_binding_changed', (c) => { c.bound.current.connectionId = 'TEST-reconnected'; }]]) {
    const refused = await boundedOverlap(t, { name: 'readback', arrival: 'confirmation', change });
    assert.equal(refused.leasedOutcome, code);
    assert.equal(refused.c.calls.broadcastTx, 0);
    setPurchaseAdmission('testnet-tp1');
  }

  // A lane held by a foreign owner makes the boundary's history append refuse; nothing reaches the node.
  const foreign = await boundedCreateWorld(t, { journalOptions: { lockTimeoutMs: 300 } });
  const lease = await foreign.world.lease(), pending = await foreign.world.makeCreate(JOB_IDS[0], 1);
  const outsideLock = AsyncLocalStorage.snapshot();
  await foreign.journal.withWalletLock(foreign.world.laneKey, async () => {
    await assert.rejects(outsideLock(() => foreign.world.confirm(pending)), (error) => error.code === 'eb_persist_failed' && error.cause?.code === 'journal-busy');
  });
  assert.deepEqual(foreign.calls, { confirmTx: 0, broadcastTx: 0 });
  await foreign.world.release(lease);
});

for (const jump of [-60_000, 60_000]) test(`wallet lane wait ignores a ${jump} ms wall jump`, async t => {
  const { journal } = tempJournal(t, { lockTimeoutMs: 20, pollMs: 5 });
  let release, ready;
  const entered = new Promise(resolve => { ready = resolve; });
  const held = journal.withWalletLock('clock-lane', () => new Promise(resolve => { release = resolve; ready(); }));
  await entered;
  let elapsed = 0;
  const epoch = Date.now();
  t.mock.method(Date, 'now', () => epoch + elapsed + (elapsed > 0 && elapsed < 60 ? jump : 0));
  t.mock.method(performance, 'now', () => elapsed);
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { elapsed += delay; queueMicrotask(callback); });
  try {
    await assert.rejects(journal.withWalletLock('clock-lane', () => assert.fail('occupied lane entered')), { code: 'journal-busy' });
    assert.equal(elapsed, 20);
  } finally { t.mock.restoreAll(); release(); await held; }
});

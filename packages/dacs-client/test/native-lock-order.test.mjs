// The native transport takes the connection fence before the wallet lane
// everywhere, and a lane lock left by a killed process is reclaimed without
// resending. With an effect boundary its dispatch history is written inside the
// lane frame that already holds the lane. Uses the real transport, history and
// durable journal over a scripted TEST node; crash tests kill a real child while
// it holds the lane. No network.
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
import { countingJournal, createWorld, JOB_IDS, operation, queuingFenceOwner } from './helpers/native-create-world.mjs';
import { guardedCreateWorld } from './helpers/native-guarded-create-world.mjs';
import { underPass } from './helpers/pass-context-fixture.mjs';

const CHILD = fileURLToPath(new URL('./helpers/native-lock-order-child.mjs', import.meta.url));
const SETTLED = () => {};

function tempJournal(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'native-lock-order-'));
  const path = join(dir, 'journal.sqlite');
  const journal = openDurableWalletJournal({ path, mode: 'create', ...options });
  t.after(() => { journal.close(); rmSync(dir, { recursive: true, force: true }); });
  return { path, journal };
}

// One leased CREATE (confirmation, then broadcast) while `name` runs on the same address.
// `arrival` is where in the leased send the other operation starts: during its
// confirmation (the lease holds the fence), or during its broadcast (it also holds the lane).
// `guarded` composes the transport over a real effect boundary and dispatch history.
async function overlap(t, { name, arrival, guarded = false }) {
  const events = [], hooks = {};
  const { journal } = tempJournal(t, { lockTimeoutMs: 300 });
  const owner = queuingFenceOwner(events);
  const options = { journal: countingJournal(journal, events), owner, onNode: async (message, call) => { await hooks[message]?.(call); } };
  const world = guarded ? await guardedCreateWorld(t, options) : createWorld(options);
  const retained = await world.makeCreate(JOB_IDS[0], 1), leased = await world.makeCreate(JOB_IDS[1], 2);
  if (name === 'readback') await world.retain(retained, 'observed');
  const lease = await world.lease();
  if (name === 'recovery') await world.retain(retained, 'broadcast-accepted');
  let other;
  // Started from the node hook, which runs inside the leased send's lane lock;
  // the other operation is its own caller, so it must not inherit that lock.
  const outsideLocks = AsyncLocalStorage.snapshot();
  const start = async () => {
    other = outsideLocks(() => operation.run(name, () => (name === 'readback' ? world.readback(retained.hash) : world.recover(retained))));
    await Promise.race([owner.queued(), other.then(SETTLED, SETTLED)]);
  };
  const trigger = arrival === 'confirmation' ? 'confirmTx' : 'broadcastTx';
  hooks[trigger] = async () => { delete hooks[trigger]; await start(); };
  const sending = operation.run('leased', async () => {
    const confirmation = await world.confirm(leased);
    return world.broadcast(lease, confirmation, leased.hash);
  });
  const leasedOutcome = await sending.then(() => 'accepted', (error) => error.code);
  await world.release(lease);
  return { world, events, leased, retained, leasedOutcome, other: await other };
}

test('readback and CREATE recovery take the connection fence before the lane: each overlapped with a leased confirmation and broadcast on the same address, in both arrival orders, completes without journal-busy or a fence timeout; acquisitions are counted inside transportOwner.acquireConnectionFence and journal.withWalletLock', async (t) => {
  for (const arrival of ['confirmation', 'broadcast']) {
    const read = await overlap(t, { name: 'readback', arrival });
    assert.equal(read.leasedOutcome, 'accepted', `readback during ${arrival}`);
    assert.deepEqual(read.other, { disposition: 'pending', hash: read.retained.hash, nonce: 1, noResend: true });
    assert.deepEqual(read.events.filter((e) => e.op === 'readback').map((e) => e.kind), ['fence', 'lane'], `readback during ${arrival}`);
    assert.deepEqual(read.world.sent.broadcasts, [read.leased.hash], 'readback sends nothing of its own');
  }
  const recovery = await overlap(t, { name: 'recovery', arrival: 'confirmation' });
  assert.equal(recovery.leasedOutcome, 'outcome_unknown', 'the leased broadcast reached the lane and found it issued');
  assert.deepEqual(recovery.other, { disposition: 'pending', hash: recovery.retained.hash, noResend: true });
  assert.deepEqual(recovery.events.filter((e) => e.op === 'recovery').map((e) => e.kind), ['fence', 'lane']);

  const { journal } = tempJournal(t);
  const control = createWorld({ journal });
  await control.retain(recovery.retained, 'broadcast-accepted');
  await control.recover(recovery.retained);
  assert.deepEqual(recovery.world.sent.broadcasts, control.sent.broadcasts, 'recovery sends exactly what it sends alone');
  assert.deepEqual(control.sent.broadcasts, [recovery.retained.hash]);
});

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
    assert.deepEqual(left.map((lock) => [lock.key, lock.holder]), [[world.laneKey, 'exited']]);
    const lane = await journal.get(world.laneKey);
    assert.equal(lane.stage, 'broadcast-started');
    assert.equal(lane.hash, leased.hash);

    assert.deepEqual(await world.readback(leased.hash), { disposition: 'pending', hash: leased.hash, nonce: 2, noResend: true });
    assert.deepEqual(journal.inspectLocks(), [], 'the readback reclaimed the dead holder\'s lock');
    await assert.rejects(world.lease(), { code: 'outcome_unknown' });
    assert.deepEqual(await journal.get(world.laneKey), lane, 'the lane record is untouched');
    assert.deepEqual(world.sent, { confirms: [], broadcasts: [] }, 'nothing was sent after the crash');
  }
  {
    const { path, journal } = tempJournal(t);
    const world = createWorld({ journal });
    const retained = await world.makeCreate(JOB_IDS[0], 1);
    await world.retain(retained, 'broadcast-accepted');
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

const laneEvents = (events, op, laneKey) => events.filter((event) => event.op === op && event.key === laneKey);

test('actual broadcast, confirmation and CREATE recovery with the real history adapter and durable journal make zero same-key lane reacquisitions for their history; an effect pass overlapped by barriers with readback and with CREATE recovery on the same actor and lane completes in both arrival orders without a lock-cycle timeout in the unchanged control, while a stop, a re-hold and a connection change still refuse the effect; a foreign lane owner refuses', async (t) => {
  const events = [], { journal } = tempJournal(t, { lockTimeoutMs: 300 });
  const c = await guardedCreateWorld(t, { journal: countingJournal(journal, events), owner: queuingFenceOwner(events) });
  // The job's lease and its recovery name one operation, so they share one history.
  const job = (work) => underPass({ operationId: 'TEST-job-1' }, work);
  const tx = await c.makeCreate(JOB_IDS[0], 1);
  const lease = await operation.run('lease', () => job(() => c.lease()));
  const confirmation = await operation.run('confirmation', () => c.confirm(tx));
  await operation.run('broadcast', () => c.broadcast(lease, confirmation, tx.hash));
  await c.retain(tx, 'broadcast-accepted');
  await operation.run('recovery', () => job(() => c.recover(tx)));
  const kinds = (op) => laneEvents(events, op, c.laneKey).map((event) => event.kind);
  assert.deepEqual(kinds('confirmation'), ['lane', 'lane', 'lane'], 'each confirmation record acquires the lane once, with no frame holding it');
  assert.deepEqual(kinds('broadcast'), ['lane', 'lane-owned', 'lane-owned', 'lane-owned'], 'the broadcast takes its lane once and its three records reuse it');
  assert.deepEqual(kinds('recovery'), ['lane', ...Array(6).fill('lane-owned')], 'recovery takes its lane once and its six records reuse it');
  assert.deepEqual(journal.inspectLocks(), []);

  const overlapped = [];
  for (const arrival of ['confirmation', 'broadcast']) {
    const read = await overlap(t, { name: 'readback', arrival, guarded: true });
    assert.equal(read.leasedOutcome, 'accepted', `readback during ${arrival}`);
    assert.deepEqual(read.other, { disposition: 'pending', hash: read.retained.hash, nonce: 1, noResend: true });
    overlapped.push(read.events.filter((e) => e.op === 'readback' && e.kind !== 'lane-owned').map((e) => e.kind));
  }
  const recovery = await overlap(t, { name: 'recovery', arrival: 'confirmation', guarded: true });
  assert.equal(recovery.leasedOutcome, 'outcome_unknown');
  assert.deepEqual(recovery.other, { disposition: 'pending', hash: recovery.retained.hash, noResend: true });
  overlapped.push(recovery.events.filter((e) => e.op === 'recovery' && e.kind !== 'lane-owned').map((e) => e.kind));
  assert.deepEqual(overlapped, [['fence', 'lane'], ['fence', 'lane'], ['fence', 'lane']], 'each takes the fence before the lane');
  assert.deepEqual(recovery.world.sent.broadcasts, [recovery.retained.hash], 'recovery sends what it sends alone');

  // A stop, a re-hold and a connection change refuse the effect and leave no lane lock behind.
  for (const [change, apply] of [['a stop', (g) => { g.state.stopped = true; }], ['a re-hold', () => setPurchaseAdmission('held')], ['a connection change', (g) => { g.bound.liveLocal().connectionId = 'TEST-moved-connection'; }]]) {
    const { journal: fresh } = tempJournal(t, { lockTimeoutMs: 300 });
    const g = await guardedCreateWorld(t, { journal: fresh }), created = await g.makeCreate(JOB_IDS[0], 1);
    await g.lease();
    apply(g);
    await assert.rejects(g.confirm(created), (error) => ['writes_stopped', 'profile_not_admitted', 'tp1_local_binding_changed'].includes(error.code), change);
    assert.deepEqual([g.sent, fresh.inspectLocks()], [{ confirms: [], broadcasts: [] }, []], change);
  }

  // The lane held by another holder refuses the first record, and nothing is sent.
  const held = tempJournal(t, { lockTimeoutMs: 300 }), g = await guardedCreateWorld(t, { journal: held.journal }), created = await g.makeCreate(JOB_IDS[0], 1);
  await g.lease();
  const foreignJournal = openDurableWalletJournal({ path: held.path, mode: 'open' });
  t.after(() => foreignJournal.close());
  await foreignJournal.withWalletLock(g.laneKey, () => assert.rejects(g.confirm(created), (error) => error.code === 'eb_persist_failed' && error.cause?.code === 'journal-busy'));
  assert.deepEqual(g.sent, { confirms: [], broadcasts: [] }, 'the refused confirmation sent nothing');
});

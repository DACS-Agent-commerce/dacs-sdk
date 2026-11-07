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
import { countingJournal, createWorld, JOB_IDS, operation, queuingFenceOwner } from './helpers/native-create-world.mjs';

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
async function overlap(t, { name, arrival }) {
  const events = [], hooks = {};
  const { journal } = tempJournal(t, { lockTimeoutMs: 300 });
  const owner = queuingFenceOwner(events);
  const world = createWorld({ journal: countingJournal(journal, events), owner, onNode: async (message, call) => { await hooks[message]?.(call); } });
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

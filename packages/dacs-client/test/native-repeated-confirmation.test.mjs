// The same signed bytes confirmed again through a new lease. While nothing in the bytes' history
// may have sent them, the new lease continues the operation that signed them: a refused or
// unanswered confirmation is asked of the node again, an acknowledged one is answered from its
// retained record, and one confirmation chain goes on to a single send. After a broadcast that
// may have been sent the new lease keeps its own operation, its signed record is refused and the
// node is not asked again. The bytes are never sent a second time, also after a restart.
// The real transport and durable journal run in this process against a scripted TEST node.
// No network, chain or funds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindFixture } from './fixtures/tp1-authority-reader.mjs';
import { cutAppend } from './helpers/effect-boundary-fixture.mjs';
import { nativeWorld as world } from './helpers/native-effect-world.mjs';

const states = records => records.map(record => record.state);
const historyConflict = error => error.code === 'eb_persist_failed' && error.cause?.code === 'eb_history_conflict';
const ACKNOWLEDGED_PASS = ['signed', 'confirm-started', 'confirm-acknowledged'];

// How the first confirmation of the bytes ended: `arm` sets it up before the confirmation,
// `reset` clears it after the restart, and `states` is the history it leaves.
const UNACKNOWLEDGED = {
  'a cut right after the signed record': { arm: w => cutAppend(w, 'signed', { after: true }), reset: () => {}, states: ['signed'] },
  'a cut right after confirm-started': { arm: w => cutAppend(w, 'confirm-started', { after: true }), reset: () => {}, states: ['signed', 'confirm-started'] },
  'a stop right after confirm-started': { arm: w => cutAppend(w, 'confirm-started', { mutate: () => { w.stopped = true; } }), reset: w => { w.stopped = false; },
    states: ['signed', 'confirm-started', 'confirm-withheld'] },
  'a node refusal': { arm: w => { w.node.invalid = true; }, reset: w => { w.node.invalid = false; }, states: ['signed', 'confirm-started', 'confirm-unknown'] },
  'a lost node answer': { arm: w => { w.node.failConfirm = new Error('TEST-lost-answer'); }, reset: w => { w.node.failConfirm = null; },
    states: ['signed', 'confirm-started', 'confirm-unknown'] },
};

for (const [ending, { arm, reset, states: left }] of Object.entries(UNACKNOWLEDGED)) {
  test(`after ${ending}, a new lease continues the signed operation: the node is asked again and one confirmation chain sends once`, async t => {
    const w = world(t, { bound: await bindFixture() });
    w.open({});
    const earlier = await w.lease(), tx = w.signedTransfer(1);
    arm(w);
    await w.confirm(tx).catch(() => {});
    assert.deepEqual(states(await w.records(tx)), left);
    const asked = w.node.confirms;
    await w.restart({});
    reset(w);
    const lease = await w.lease();
    const confirmation = await w.confirm(tx);
    assert.equal(w.node.confirms, asked + 1, 'the node is asked again');
    const records = await w.records(tx);
    // A pass with nothing past its signed record goes on as it is; any other gets a new signed record.
    assert.deepEqual(states(records), left.length === 1 ? ACKNOWLEDGED_PASS : [...left, ...ACKNOWLEDGED_PASS]);
    assert.ok(records.every(record => record.operationId === earlier.leaseId), 'every record names the operation that signed the bytes');
    await w.prepareBroadcast(lease.leaseId, tx.hash);
    await w.broadcast(confirmation);
    assert.deepEqual(w.node.broadcasts, [tx.hash]);
  });
}

// What the first lease did with the bytes before it was released, with the node accepting.
const ACKNOWLEDGED = {
  'an acknowledged confirmation': async (w, tx) => { await w.confirm(tx); },
  'an acknowledged confirmation followed by a refused one in the same lease': async (w, tx) => {
    await w.confirm(tx);
    w.node.invalid = true;
    await w.confirm(tx);
    w.node.invalid = false;
  },
};

for (const [ending, leave] of Object.entries(ACKNOWLEDGED)) {
  test(`after ${ending}, a new lease continues the signed operation: it is answered from the retained confirmation, the node is not asked again and the bytes are sent once`, async t => {
    const w = world(t, { bound: await bindFixture() });
    w.open({});
    const earlier = await w.lease(), tx = w.signedTransfer(1);
    await leave(w, tx);
    const left = await w.records(tx), asked = w.node.confirms;
    await w.release(earlier.leaseId);
    const lease = await w.lease();
    const confirmation = await w.confirm(tx);
    assert.equal(w.node.confirms, asked);
    assert.deepEqual(await w.records(tx), left);
    await w.prepareBroadcast(lease.leaseId, tx.hash);
    await w.broadcast(confirmation);
    assert.deepEqual(w.node.broadcasts, [tx.hash]);
    assert.ok((await w.records(tx)).every(record => record.operationId === earlier.leaseId), 'every record names the operation that signed the bytes');
  });
}

test('after a broadcast withheld right after dispatch-started and a restart, a new lease continues the signed operation, the node is not asked again and the bytes are sent once', async t => {
  const w = world(t, { bound: await bindFixture() });
  w.open({});
  const earlier = await w.lease(), tx = w.signedTransfer(1), confirmation = await w.confirm(tx);
  await w.prepareBroadcast(earlier.leaseId, tx.hash);
  cutAppend(w, 'dispatch-started', { mutate: () => { w.stopped = true; } });
  await assert.rejects(w.broadcast(confirmation), { code: 'writes_stopped' });
  assert.deepEqual(states(await w.records(tx)), [...ACKNOWLEDGED_PASS, 'signed', 'dispatch-started', 'dispatch-withheld']);
  await w.restart({});
  w.stopped = false;
  const lease = await w.lease();
  assert.deepEqual(await w.confirm(tx), confirmation);
  assert.equal(w.node.confirms, 1);
  await w.prepareBroadcast(lease.leaseId, tx.hash);
  await w.broadcast(confirmation);
  assert.deepEqual(w.node.broadcasts, [tx.hash]);
});

test('after a broadcast whose send may have happened, a new lease keeps its own operation: its signed record is refused and the bytes are read back only', async t => {
  const w = world(t, { bound: await bindFixture() });
  w.open({});
  const earlier = await w.lease(), tx = w.signedTransfer(1), confirmation = await w.confirm(tx);
  await w.prepareBroadcast(earlier.leaseId, tx.hash);
  cutAppend(w, 'dispatch-started', { after: true });
  await assert.rejects(w.broadcast(confirmation), { code: 'eb_persist_failed' });
  assert.deepEqual(states(await w.records(tx)), [...ACKNOWLEDGED_PASS, 'signed', 'dispatch-started']);
  await w.restart({});
  await w.lease();
  await assert.rejects(w.confirm(tx), historyConflict);
  assert.equal(w.node.confirms, 1);
  assert.deepEqual(w.node.broadcasts, []);
});

const settle = promise => promise.then(value => ({ value }), error => ({ error }));

// What the first lease did with the acknowledged bytes before the process restarted (`leave`),
// what lets a new lease open after the restart (`reopen`), and how the new lease's confirmation
// of the same bytes is refused (`refused`).
// An acknowledged confirmation that was not broadcast goes on through a new lease after a restart
// (native-confirmed-before-broadcast-cut.test.mjs).
const BEFORE_RESTART = {
  'an acknowledged confirmation broadcast once': {
    leave: async (w, lease, tx, confirmation) => {
      await w.prepareBroadcast(lease.leaseId, tx.hash);
      await w.broadcast(confirmation);
      assert.deepEqual(w.node.broadcasts, [tx.hash]);
    },
    // The broadcast lane row refuses a new lease until the transfer is read back as included.
    reopen: async (w, tx) => {
      await assert.rejects(w.lease(), { code: 'outcome_unknown' });
      assert.equal((await w.transport().binding({ phase: 'readback', address: w.address, hash: tx.hash })).disposition, 'included');
    },
    // An issued hash is read back only, so the transport refuses it before any history record.
    refused: error => error.code === 'outcome_unknown',
  },
};

for (const [ending, { leave, reopen, refused }] of Object.entries(BEFORE_RESTART)) {
  test(`after ${ending} and a restart, a new lease neither asks the node to confirm the bytes again nor sends them a second time`, async t => {
    const w = world(t, { bound: await bindFixture() });
    w.open({});
    const earlier = await w.lease(), tx = w.signedTransfer(1), confirmation = await w.confirm(tx);
    await leave(w, earlier, tx, confirmation);
    const sent = w.node.broadcasts.length;
    await w.restart({});
    await reopen(w, tx);
    const left = await w.records(tx);
    const lease = await w.lease();
    const again = await settle(w.confirm(tx));
    // Every confirmation the test holds, the retained one and any new one, is tried for a broadcast through the new lease.
    for (const held of [confirmation, again.value].filter(Boolean)) await settle(w.prepareBroadcast(lease.leaseId, tx.hash).then(() => w.broadcast(held)));
    assert.equal(w.node.confirms, 1, 'the node is asked to confirm the bytes once');
    assert.ok(w.node.broadcasts.filter(hash => hash === tx.hash).length <= 1, 'the bytes are sent at most once');
    assert.ok(again.error && refused(again.error), 'the second confirmation is refused');
    assert.equal(w.node.broadcasts.length, sent, 'nothing is sent after the restart');
    assert.deepEqual(await w.records(tx), left);
  });
}

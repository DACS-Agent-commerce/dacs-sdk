// Crash and failure cuts around the native confirmation stage: a failed write of
// the started record, a failed write of the acknowledgement, a lost answer and a
// process that dies after the started record. In each, no confirmation result is
// invented, nothing is broadcast, and the retained history is what a restart finds.
// The real transport, boundary and durable journal run in this process against a
// scripted TEST node. No network, chain or funds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindFixture } from './fixtures/tp1-authority-reader.mjs';
import { cutAppend } from './helpers/effect-boundary-fixture.mjs';
import { LANE_PREFIX, nativeWorld as world } from './helpers/native-effect-world.mjs';

const states = records => records.map(record => record.state);
const NO_LANE_OR_INTENT = key => key.startsWith(LANE_PREFIX) || key.startsWith('devnet/native-transfer/');

// A lease and a signed transfer on a world whose boundary history the test can cut.
async function leasedWorld(t) {
  const w = world(t, { bound: await bindFixture() });
  w.open({});
  const lease = await w.lease();
  return { w, lease, tx: w.signedTransfer(1) };
}

// After a restart the history is as the journal kept it, no lane or intent was written and the lease is gone, so nothing can be broadcast.
async function assertRestartKeepsOnly(w, lease, tx, expectedStates) {
  await w.restart();
  assert.deepEqual(states(await w.records(tx)), expectedStates);
  assert.deepEqual((await w.journalEntries()).map(([key]) => key).filter(NO_LANE_OR_INTENT), []);
  await assert.rejects(w.prepareBroadcast(lease.leaseId, tx.hash), { code: 'network_binding_required' });
  assert.deepEqual(w.node.broadcasts, []);
}

test('a failed write of the signed record sends no confirmation and leaves no history', async t => {
  const { w, lease, tx } = await leasedWorld(t);
  cutAppend(w, 'signed');
  await assert.rejects(w.confirm(tx), { code: 'eb_persist_failed' });
  assert.equal(w.node.confirms, 0);
  await assertRestartKeepsOnly(w, lease, tx, []);
});

test('a failed write of confirm-started sends no confirmation and keeps the signed transaction after a restart', async t => {
  const { w, lease, tx } = await leasedWorld(t);
  cutAppend(w, 'confirm-started');
  await assert.rejects(w.confirm(tx), { code: 'eb_persist_failed' });
  assert.equal(w.node.confirms, 0);
  assert.deepEqual(states(await w.records(tx)), ['signed']);
  await assertRestartKeepsOnly(w, lease, tx, ['signed']);
  assert.equal(w.node.confirms, 0);
});

test('a failed write of confirm-acknowledged leaves the confirmation unknown and refuses the broadcast', async t => {
  const { w, lease, tx } = await leasedWorld(t);
  cutAppend(w, 'confirm-acknowledged');
  await assert.rejects(w.confirm(tx), { code: 'eb_ack_not_persisted' });
  assert.equal(w.node.confirms, 1);
  assert.deepEqual(states(await w.records(tx)), ['signed', 'confirm-started', 'confirm-unknown']);
  await assert.rejects(w.prepareBroadcast(lease.leaseId, tx.hash), { code: 'native_confirmation_required' });
  assert.deepEqual(w.node.broadcasts, []);
  await assertRestartKeepsOnly(w, lease, tx, ['signed', 'confirm-started', 'confirm-unknown']);
});

test('a lost confirmation answer leaves the confirmation unknown with its cause and refuses the broadcast', async t => {
  const { w, lease, tx } = await leasedWorld(t);
  w.node.failConfirm = new Error('TEST-lost-answer');
  const failure = await w.confirm(tx).then(() => null, error => error);
  assert.equal(failure?.message, 'request failed');
  const records = await w.records(tx);
  assert.deepEqual(states(records), ['signed', 'confirm-started', 'confirm-unknown']);
  assert.equal(records[2].cause.code, 'effect_failed', 'the unknown record keeps a cause');
  await assert.rejects(w.prepareBroadcast(lease.leaseId, tx.hash), { code: 'native_confirmation_required' });
  assert.deepEqual(w.node.broadcasts, []);
  await assertRestartKeepsOnly(w, lease, tx, ['signed', 'confirm-started', 'confirm-unknown']);
});

test('a crash after confirm-started leaves an unpaired started record that sends nothing after a restart', async t => {
  const { w, lease, tx } = await leasedWorld(t);
  // The process dies after the node answered: neither the acknowledgement nor the unknown record is written.
  cutAppend(w, 'confirm-acknowledged');
  cutAppend(w, 'confirm-unknown');
  await assert.rejects(w.confirm(tx), { code: 'eb_ack_not_persisted' });
  assert.equal(w.node.confirms, 1);
  assert.deepEqual(states(await w.records(tx)), ['signed', 'confirm-started']);
  await assert.rejects(w.prepareBroadcast(lease.leaseId, tx.hash), { code: 'native_confirmation_required' });
  await assertRestartKeepsOnly(w, lease, tx, ['signed', 'confirm-started']);
  assert.equal(w.node.confirms, 1);
});

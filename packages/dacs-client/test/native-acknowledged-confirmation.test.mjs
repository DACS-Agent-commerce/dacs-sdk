// An acknowledged confirmation is final for its signed bytes: the node is never asked to confirm them
// again, in the same lease or after a restart, and the seller policy is applied to the retained answer
// after the acknowledgement is recorded. The real transport and durable journal run in this process
// against a scripted TEST node. No network, chain or funds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindFixture } from './fixtures/tp1-authority-reader.mjs';
import { nativeWorld as world } from './helpers/native-effect-world.mjs';

const states = records => records.map(record => record.state);
const settle = promise => promise.then(value => ({ value }), error => ({ error }));
const ACKNOWLEDGED_PASS = ['signed', 'confirm-started', 'confirm-acknowledged'];

test('a second confirmation of acknowledged bytes in the same lease is answered from the retained record without asking the node', async t => {
  const w = world(t, { bound: await bindFixture() });
  w.open({});
  const lease = await w.lease(), tx = w.signedTransfer(1);
  const first = await w.confirm(tx);
  const second = await w.confirm(tx);
  assert.equal(w.node.confirms, 1, 'the node is asked to confirm the bytes once');
  assert.deepEqual(second, first);
  assert.deepEqual(states(await w.records(tx)), ACKNOWLEDGED_PASS);
  await w.prepareBroadcast(lease.leaseId, tx.hash);
  assert.equal((await w.broadcast(second)).result, 200);
  assert.deepEqual(w.node.broadcasts, [tx.hash]);
});

test('a confirmation the seller policy refuses is recorded acknowledged; after a restart the node is not asked again and nothing is sent without approval', async t => {
  let approves = false;
  const policy = { approveConfirmedWrite: async () => approves };
  const w = world(t, { bound: await bindFixture() });
  w.open({}, policy);
  await w.lease();
  const tx = w.signedTransfer(1);
  await assert.rejects(w.confirm(tx), { code: 'approval_required' });
  await w.restart({}, policy);
  approves = true;
  const lease = await w.lease();
  const again = await settle(w.confirm(tx));
  if (again.value) await settle(w.prepareBroadcast(lease.leaseId, tx.hash).then(() => w.broadcast(again.value)));
  assert.equal(w.node.confirms, 1, 'the node is asked to confirm the bytes once');
  assert.ok(w.node.broadcasts.length <= 1, 'the bytes are sent at most once');
  assert.equal(again.error?.code, 'eb_persist_failed');
  assert.equal(again.error?.cause?.code, 'eb_history_conflict');
  assert.deepEqual(w.node.broadcasts, []);
  assert.deepEqual(states(await w.records(tx)), ACKNOWLEDGED_PASS);
});

test('after the seller policy refused a confirmation, the same lease asks the policy again on the retained answer and sends once only when it approves', async t => {
  let approves = false, asked = 0;
  const w = world(t, { bound: await bindFixture() });
  w.open({}, { approveConfirmedWrite: async () => { asked++; return approves; } });
  const lease = await w.lease(), tx = w.signedTransfer(1);
  await assert.rejects(w.confirm(tx), { code: 'approval_required' });
  await assert.rejects(w.confirm(tx), { code: 'approval_required' });
  await assert.rejects(w.prepareBroadcast(lease.leaseId, tx.hash), { code: 'native_confirmation_required' });
  approves = true;
  const confirmation = await w.confirm(tx);
  assert.equal(w.node.confirms, 1, 'the node is asked to confirm the bytes once');
  assert.equal(asked, 3);
  await w.prepareBroadcast(lease.leaseId, tx.hash);
  assert.equal((await w.broadcast(confirmation)).result, 200);
  assert.deepEqual(w.node.broadcasts, [tx.hash]);
  assert.deepEqual(states(await w.records(tx)).slice(0, 3), ACKNOWLEDGED_PASS);
});

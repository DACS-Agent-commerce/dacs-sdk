// An acknowledged confirmation is final for its signed bytes: the node is never asked to confirm them
// again, in the same lease or after a restart. The real transport and durable journal run in this
// process against a scripted TEST node. No network, chain or funds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindFixture } from './fixtures/tp1-authority-reader.mjs';
import { nativeWorld as world } from './helpers/native-effect-world.mjs';

const states = records => records.map(record => record.state);
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

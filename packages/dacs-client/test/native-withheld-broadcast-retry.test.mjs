// A broadcast refused before anything was sent leaves the wallet and the payment free: the
// lane is finished, readback does not answer pending, and the same signed bytes (as a
// purchase retry re-issues them) go out once through a new lease without asking the node
// to confirm them again. The real transport and durable journal run in this process
// against a scripted TEST node. No network, chain or funds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindFixture } from './fixtures/tp1-authority-reader.mjs';
import { nativeWorld as world } from './helpers/native-effect-world.mjs';

const states = records => records.map(record => record.state);
const nativeRows = async w => (await w.journalEntries()).filter(([key]) => key.startsWith('devnet/native-')).map(([, row]) => [row.stage, row.hash]);

// The same signed bytes through a new lease: confirmed from the retained answer, then broadcast.
async function retry(w, tx) {
  const lease = await w.lease();
  const confirmation = await w.confirm(tx);
  await w.prepareBroadcast(lease.leaseId, tx.hash);
  return w.broadcast(confirmation);
}

test('a stop that turns true after the lane and intent writes and before the last check sends nothing and finishes the lane, also after a restart', async t => {
  const w = world(t, { bound: await bindFixture() });
  // The stop turns true as the intent record is written, inside the broadcast's dispatch and before its last check.
  const stopAtIntent = (key, value) => { if (key.startsWith('devnet/native-transfer/') && value.stage === 'broadcast-started') w.stopped = true; return false; };
  w.open({}, { journal: w.faultyJournal(stopAtIntent) });
  const lease = await w.lease(), tx = w.signedTransfer(1), confirmation = await w.confirm(tx);
  await w.prepareBroadcast(lease.leaseId, tx.hash);
  await assert.rejects(w.broadcast(confirmation), { code: 'writes_stopped' });
  assert.deepEqual(w.node.broadcasts, []);
  assert.deepEqual(states(await w.records(tx)).slice(-3), ['signed', 'dispatch-started', 'dispatch-withheld']);
  assert.deepEqual(await nativeRows(w), [['failed', tx.hash], ['failed', tx.hash]]);
  await w.restart({});
  w.stopped = false;
  const read = await w.transport().binding({ phase: 'readback', address: w.address, hash: tx.hash });
  assert.equal(read.disposition, 'failed');
  assert.equal(read.resolved, true);
  assert.equal((await retry(w, tx)).result, 200);
  assert.equal(w.node.confirms, 1, 'the node is asked to confirm the bytes once');
  assert.deepEqual(w.node.broadcasts, [tx.hash]);
});

test('after an acknowledged confirmation, a broadcast refused because its lease expired leaves the payment payable: the same bytes go out once through a new lease', async t => {
  const w = world(t, { bound: await bindFixture() });
  let skew = 0;
  w.open({}, { now: () => Date.now() + skew });
  const lease = await w.lease(), tx = w.signedTransfer(1);
  await w.confirm(tx);
  skew = 31000;
  await assert.rejects(w.prepareBroadcast(lease.leaseId, tx.hash));
  assert.deepEqual(states(await w.records(tx)), ['signed', 'confirm-started', 'confirm-acknowledged']);
  assert.equal((await retry(w, tx)).result, 200);
  assert.equal(w.node.confirms, 1, 'the node is asked to confirm the bytes once');
  assert.deepEqual(w.node.broadcasts, [tx.hash]);
});

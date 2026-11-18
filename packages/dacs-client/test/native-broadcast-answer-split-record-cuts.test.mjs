// A broadcast whose request was sent and answered, stopping after only some of the records
// of the answer: whichever of them committed, the lane stays readback-only after the restart,
// the transaction is never sent again, and readback still finds it. The real transport and
// durable journal run in this process against a scripted TEST node; a failing write stands for
// the process ending there. No network, chain or funds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindFixture } from './fixtures/tp1-authority-reader.mjs';
import { cutAppend } from './helpers/effect-boundary-fixture.mjs';
import { nativeWorld as world } from './helpers/native-effect-world.mjs';

const answered = prefix => (key, value) => key.startsWith(prefix) && value.stage === 'broadcast-accepted';
const cut = error => error.message === 'TEST-journal-cut';

async function broadcastCutAfterAnswer(t, fails) {
  const w = world(t, { bound: await bindFixture() });
  w.open({}, fails ? { journal: w.faultyJournal(fails) } : {});
  const lease = await w.lease(), tx = w.signedTransfer(1), confirmation = await w.confirm(tx);
  await w.prepareBroadcast(lease.leaseId, tx.hash);
  return { w, tx, confirmation };
}

// After the restart the lane refuses a new lease and a second send, and readback finds the transaction on the node.
async function assertReadbackOnly(w, tx, stages) {
  await w.restart({});
  assert.deepEqual(w.node.broadcasts, [tx.hash], 'the request was sent once');
  const rows = (await w.journalEntries()).filter(([key]) => key.startsWith('devnet/native-'));
  assert.deepEqual(rows.map(([key, row]) => [key.startsWith('devnet/native-wallet/') ? 'lane' : 'intent', row.stage]).sort(), stages);
  await assert.rejects(w.lease(), { code: 'outcome_unknown' });
  const read = await w.transport().binding({ phase: 'readback', address: w.address, hash: tx.hash });
  assert.equal(read.disposition, 'included');
  assert.deepEqual(w.node.broadcasts, [tx.hash], 'neither the restart nor readback sends again');
}

test('a broadcast cut after the answer and before its intent record leaves both rows started and readback-only', async t => {
  const { w, tx, confirmation } = await broadcastCutAfterAnswer(t, answered('devnet/native-transfer/'));
  await assert.rejects(w.broadcast(confirmation), cut);
  await assertReadbackOnly(w, tx, [['intent', 'broadcast-started'], ['lane', 'broadcast-started']]);
});

test('a broadcast cut after its intent record and before its lane record leaves the answered intent and a started lane readback-only', async t => {
  const { w, tx, confirmation } = await broadcastCutAfterAnswer(t, answered('devnet/native-wallet/'));
  await assert.rejects(w.broadcast(confirmation), cut);
  await assertReadbackOnly(w, tx, [['intent', 'broadcast-accepted'], ['lane', 'broadcast-started']]);
});

test('a broadcast cut after both answer records and before its acknowledgement is recorded unknown and readback-only', async t => {
  const { w, tx, confirmation } = await broadcastCutAfterAnswer(t);
  cutAppend(w, 'dispatch-acknowledged');
  await assert.rejects(w.broadcast(confirmation), { code: 'eb_ack_not_persisted' });
  assert.equal((await w.records(tx)).at(-1).state, 'dispatch-unknown');
  await assertReadbackOnly(w, tx, [['intent', 'broadcast-accepted'], ['lane', 'broadcast-accepted']]);
});

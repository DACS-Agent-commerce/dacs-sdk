// A broadcast that stops after only part of what it writes before the request: whatever
// prefix remained keeps the transaction's hash and bytes, nothing was sent, and no second
// ordinary broadcast of it is possible. The real transport and durable journal run in this
// process against a scripted TEST node; a failing write or wait stands for the process ending
// there. No network, chain or funds.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { bindFixture } from './fixtures/tp1-authority-reader.mjs';
import { cutAppend, flush } from './helpers/effect-boundary-fixture.mjs';
import { nativeWorld as world } from './helpers/native-effect-world.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const startsBroadcast = prefix => (key, value) => key.startsWith(prefix) && value.stage === 'broadcast-started';
const cut = error => error.message === 'TEST-journal-cut';

// A confirmed transfer ready to broadcast on a transport whose journal fails the writes `fails` picks.
async function confirmed(t, fails) {
  const w = world(t, { bound: await bindFixture() });
  w.open({}, fails ? { journal: w.faultyJournal(fails) } : {});
  const lease = await w.lease(), tx = w.signedTransfer(1), confirmation = await w.confirm(tx);
  await w.prepareBroadcast(lease.leaseId, tx.hash);
  return { w, tx, confirmation };
}

async function assertRetainedBytes(w, tx) {
  const [signed] = await w.records(tx);
  assert.equal(signed.artifactHash, sha(JSON.stringify(tx)));
  assert.equal(Buffer.from(signed.bytes, 'base64').toString(), JSON.stringify(tx), 'the exact signed bytes are retained');
}

test('a broadcast cut before its lane row is written sends nothing, and a new lease cannot confirm the retained bytes again', async t => {
  const { w, tx, confirmation } = await confirmed(t, startsBroadcast('devnet/native-wallet/'));
  await assert.rejects(w.broadcast(confirmation), cut);
  await w.restart({});
  await assertRetainedBytes(w, tx);
  assert.deepEqual((await w.journalEntries()).filter(([key]) => key.startsWith('devnet/native-')), []);
  await w.lease();
  await assert.rejects(w.confirm(tx), error => error.code === 'eb_persist_failed' && error.cause?.code === 'eb_history_conflict');
  assert.equal(w.node.confirms, 1);
  assert.deepEqual(w.node.broadcasts, []);
});

test('a broadcast cut after its lane row and before its intent sends nothing, and the lane row refuses a new lease', async t => {
  const { w, tx, confirmation } = await confirmed(t, startsBroadcast('devnet/native-transfer/'));
  await assert.rejects(w.broadcast(confirmation), cut);
  await w.restart({});
  await assertRetainedBytes(w, tx);
  const lane = (await w.journalEntries()).filter(([key]) => key.startsWith('devnet/native-wallet/'));
  assert.deepEqual(lane.map(([, row]) => [row.stage, row.hash]), [['broadcast-started', tx.hash]]);
  await assert.rejects(w.lease(), { code: 'outcome_unknown' });
  assert.deepEqual(w.node.broadcasts, []);
});

test('a broadcast cut after its lane row and intent and before its request sends nothing, and both rows refuse a new lease', async t => {
  const { w, tx, confirmation } = await confirmed(t);
  let held;
  cutAppend(w, 'dispatch-started', { mutate: () => { held = w.gate.hold(); } });
  const outcome = w.broadcast(confirmation).then(() => null, error => error);
  for (let tries = 0; tries < 50 && !held?.reached; tries++) await flush();
  held.fail(new Error('TEST-process-ended'));
  assert.equal((await outcome).message, 'TEST-process-ended');
  await w.restart({});
  await assertRetainedBytes(w, tx);
  const rows = (await w.journalEntries()).filter(([key]) => key.startsWith('devnet/native-'));
  assert.deepEqual(rows.map(([, row]) => [row.stage, row.hash]), [['broadcast-started', tx.hash], ['broadcast-started', tx.hash]]);
  await assert.rejects(w.lease(), { code: 'outcome_unknown' });
  assert.deepEqual(w.node.broadcasts, []);
});

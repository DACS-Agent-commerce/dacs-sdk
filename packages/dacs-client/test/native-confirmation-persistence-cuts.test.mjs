// Crash cuts around the native confirmation stage: the exact signed transaction is retained
// and confirm-started is durable before the node is asked, and only a durable
// confirm-acknowledged lets the broadcast follow. The real transport, effect boundary and
// durable journal run in this process; each cut fails one history write or loses the node's
// answer. A TEST key signs the transactions. No network, chain or funds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cutAppend } from './helpers/effect-boundary-fixture.mjs';
import { nativeWorld as world } from './helpers/native-effect-world.mjs';

const broadcastPhase = (w, leaseId, signed) => w.transport().binding({ phase:'broadcast', address:w.address, leaseId, hash:signed.hash });
const retainedTransaction = (record) => Buffer.from(record.bytes, 'base64').toString('utf8');

test('a failed write of the signed record makes zero confirmation calls', async (t) => {
  const w = world(t), g = await w.openGuarded(), { leaseId } = await w.lease(), signed = w.sign(1);
  const crash = cutAppend({ history:g.history }, 'signed');
  await assert.rejects(w.confirm(signed), { code:'eb_persist_failed', cause:crash });
  assert.equal(w.node.confirms, 0);
  assert.deepEqual(await w.historyStates(), []);
  await assert.rejects(broadcastPhase(w, leaseId, signed), { code:'native_confirmation_required' });
});

test('a failed write of confirm-started makes zero confirmation calls, and a restart keeps the signed transaction with no confirmation result', async (t) => {
  const w = world(t), g = await w.openGuarded(), { leaseId } = await w.lease(), signed = w.sign(1);
  const crash = cutAppend({ history:g.history }, 'confirm-started');
  await assert.rejects(w.confirm(signed), { code:'eb_persist_failed', cause:crash });
  assert.equal(w.node.confirms, 0);
  assert.deepEqual(await w.historyStates(), ['p1/signed']);

  await w.restartGuarded();
  const records = await w.historyRecords();
  assert.deepEqual(await w.historyStates(), ['p1/signed'], 'the restart adds no record');
  assert.equal(retainedTransaction(records[0]), JSON.stringify(signed), 'the exact signed bytes are retained');
  assert.ok(records.every((record) => record.confirmation === undefined), 'no confirmation result exists');
  await assert.rejects(broadcastPhase(w, leaseId, signed), { code:'network_binding_required' });
  assert.deepEqual([w.node.confirms, w.node.broadcasts], [0, []]);
});

test('a confirmation answer lost in transit leaves confirm-unknown with its cause and refuses the broadcast', async (t) => {
  const w = world(t);
  await w.openGuarded();
  const { leaseId } = await w.lease(), signed = w.sign(1);
  w.node.lose = true;
  const lost = await w.confirm(signed).then(() => null, (error) => error);
  assert.ok(lost, 'the wallet sees the failure');
  assert.equal(w.node.confirms, 1);
  assert.deepEqual(await w.historyStates(), ['p1/signed', 'p1/confirm-started', 'p1/confirm-unknown']);
  assert.equal((await w.historyRecords())[2].cause.code, lost.code ?? 'effect_failed');
  await assert.rejects(broadcastPhase(w, leaseId, signed), { code:'native_confirmation_required' });
  assert.deepEqual(w.node.broadcasts, []);
});

test('a failed write of confirm-acknowledged leaves confirm-unknown and refuses the broadcast', async (t) => {
  const w = world(t), g = await w.openGuarded(), { leaseId } = await w.lease(), signed = w.sign(1);
  const crash = cutAppend({ history:g.history }, 'confirm-acknowledged');
  await assert.rejects(w.confirm(signed), { code:'eb_persist_failed', cause:crash });
  assert.equal(w.node.confirms, 1);
  assert.deepEqual(await w.historyStates(), ['p1/signed', 'p1/confirm-started', 'p1/confirm-unknown']);
  await assert.rejects(broadcastPhase(w, leaseId, signed), { code:'native_confirmation_required' });
  assert.deepEqual(w.node.broadcasts, []);
});

test('a confirm-acknowledged that is durable while its caller saw a failure still refuses the broadcast', async (t) => {
  const w = world(t), g = await w.openGuarded(), { leaseId } = await w.lease(), signed = w.sign(1);
  cutAppend({ history:g.history }, 'confirm-acknowledged', { after:true });
  await assert.rejects(w.confirm(signed), { code:'eb_persist_failed' });
  assert.deepEqual(await w.historyStates(), ['p1/signed', 'p1/confirm-started', 'p1/confirm-acknowledged', 'p1/confirm-unknown']);
  await assert.rejects(broadcastPhase(w, leaseId, signed), { code:'native_confirmation_required' });
  assert.deepEqual(w.node.broadcasts, []);
});

test('a process that stops between confirm-started and the answer restarts with only confirm-started and never broadcasts', async (t) => {
  const w = world(t), g = await w.openGuarded(), { leaseId } = await w.lease(), signed = w.sign(1);
  w.node.lose = true;
  cutAppend({ history:g.history }, 'confirm-unknown');
  await assert.rejects(w.confirm(signed));
  assert.deepEqual(await w.historyStates(), ['p1/signed', 'p1/confirm-started']);

  await w.restartGuarded();
  assert.deepEqual(await w.historyStates(), ['p1/signed', 'p1/confirm-started'], 'the restart invents no result');
  await assert.rejects(broadcastPhase(w, leaseId, signed), { code:'network_binding_required' });
  await assert.rejects(w.confirm(signed), { code:'network_binding_required' });
  assert.deepEqual([w.node.confirms, w.node.broadcasts], [1, []]);
});

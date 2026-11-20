// The effect boundary's held fence and its confirm stage. A held fence spans calls that
// share no async context; a stage is a set of records of its own. Real history, fence and
// SQLite; no network, no keys.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundaryWorld, code, cutAppend, flush, setPurchaseAdmission, states } from './helpers/effect-boundary-fixture.mjs';

const confirm = (w, artifact, answer = 'TEST-answer', material = (result) => ({ confirmation: result })) =>
  w.boundary.dispatchPass(artifact, () => { w.events.push('confirm'); return answer; }, { stage: 'confirm', material });

test('a held fence stays acquired once until released, and passes run inside it reuse it', async t => {
  const w = await boundaryWorld(t);
  const hold = await w.boundary.holdFence(w.op);
  assert.equal(w.acquired, 1);
  assert.equal(w.held, true);
  const signed = await hold.run(() => w.sign());
  await hold.run(() => w.send(signed));
  assert.equal(w.acquired, 1, 'later passes reuse the held fence');
  assert.equal(w.held, true);
  await hold.release();
  assert.equal(w.held, false);
  assert.equal(w.released, 1);
  await hold.release();
  assert.equal(w.released, 1, 'a second release does nothing');
});

test('a pass for another operation inside a held fence is refused as not owned', async t => {
  const w = await boundaryWorld(t);
  const hold = await w.boundary.holdFence(w.op);
  await assert.rejects(hold.run(() => w.sign({ ...w.op, operationId: 'TEST-other-operation' })), code('tp1_fence_not_owned'));
  assert.equal(w.signatures, 0);
  await hold.release();
});

test('a stop or a held profile refuses holdFence before the fence is acquired', async t => {
  const w = await boundaryWorld(t);
  w.stopped = true;
  await assert.rejects(w.boundary.holdFence(w.op), code('writes_stopped'));
  w.stopped = false;
  setPurchaseAdmission('held');
  await assert.rejects(w.boundary.holdFence(w.op), code('profile_not_admitted'));
  assert.equal(w.acquired, 0);
});

test('a connection change that arrives while holdFence waits for the fence releases the fence and refuses', async t => {
  const w = await boundaryWorld(t);
  let release;
  const holder = w.fence.withFence('TEST-holder', () => new Promise(resolve => { release = resolve; }));
  await flush();
  const waiting = assert.rejects(w.boundary.holdFence(w.op), code('tp1_local_binding_changed'));
  await flush();
  w.current.connectionId = 'TEST-reconnected';
  release();
  await holder;
  await waiting;
  assert.equal(w.held, false);
  assert.equal(w.released, w.acquired);
});

test('a confirm stage records its own started and acknowledged records and is never a possible dispatch', async t => {
  const w = await boundaryWorld(t);
  const signed = await w.sign();
  assert.equal(await confirm(w, signed), 'TEST-answer');
  assert.deepEqual(await states(w, signed), ['signed', 'confirm-started', 'confirm-acknowledged']);
  const [, , acknowledged] = await w.history.read(signed);
  assert.equal(acknowledged.confirmation, 'TEST-answer');
  await w.send(signed);
  assert.equal(w.sent.length, 1, 'the dispatch stage still sends once after a confirmed stage');
  assert.deepEqual(await states(w, signed), ['signed', 'confirm-started', 'confirm-acknowledged', 'signed', 'dispatch-started', 'dispatch-acknowledged']);
});

test('a confirm pass after a possible dispatch is refused for readback', async t => {
  const w = await boundaryWorld(t);
  const signed = await w.sign();
  await w.send(signed);
  await assert.rejects(confirm(w, signed), code('eb_readback_required'));
  assert.equal(w.events.includes('confirm'), false);
});

test('an answer the stage does not accept records an unknown result with its cause and still returns the answer', async t => {
  const w = await boundaryWorld(t);
  const signed = await w.sign();
  assert.equal(await confirm(w, signed, 'TEST-refused-answer', () => undefined), 'TEST-refused-answer');
  const records = await w.history.read(signed);
  assert.deepEqual(records.map(record => record.state), ['signed', 'confirm-started', 'confirm-unknown']);
  assert.equal(records[2].cause.code, 'stage_answer_not_accepted');
});

test('an unpaired confirm-started and a confirm-unknown never block a new confirm pass or the dispatch', async t => {
  const w = await boundaryWorld(t);
  const signed = await w.sign();
  cutAppend(w, 'confirm-acknowledged');
  cutAppend(w, 'confirm-unknown');
  await assert.rejects(confirm(w, signed), code('eb_ack_not_persisted'));
  assert.deepEqual(await states(w, signed), ['signed', 'confirm-started']);
  w.reopen();
  await confirm(w, signed);
  assert.deepEqual(await states(w, signed), ['signed', 'confirm-started', 'signed', 'confirm-started', 'confirm-acknowledged']);
  await w.send(signed);
  assert.equal(w.sent.length, 1);
});

test('a stage the boundary does not know is a TypeError and records nothing', async t => {
  const w = await boundaryWorld(t);
  const signed = await w.sign();
  await assert.rejects(w.boundary.dispatchPass(signed, () => 'TEST-answer', { stage: 'broadcast' }), TypeError);
  assert.deepEqual(await states(w, signed), ['signed']);
});

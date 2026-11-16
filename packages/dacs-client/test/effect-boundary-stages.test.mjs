// The boundary's dispatch stages (broadcast, confirmation and the two recovery stages) and
// its held fence: each stage records its own states, a stage's records decide only what
// that stage may repeat, and a held fence is reused by every pass of its operation. Real
// history, fence and SQLite; no network, no keys.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundaryWorld, code, cutAppend, setPurchaseAdmission, states } from './helpers/effect-boundary-fixture.mjs';

const ANSWER = { valid:true };
const stagePass = (world, artifact, options = {}) => world.boundary.dispatchPass(artifact, () => ANSWER, { stage:'confirm', explicit:true, material:(answer) => ({ confirmation:answer }), ...options });
const failingSend = () => { throw new Error('TEST-send-failed'); };

async function withheldConfirm(t) {
  const world = await boundaryWorld(t), artifact = await world.sign();
  const real = world.history.append;
  cutAppend(world, 'confirm-started', { mutate:() => { world.stopped = true; } });
  await assert.rejects(stagePass(world, artifact), code('writes_stopped'));
  world.history.append = real;
  world.stopped = false;
  return { world, artifact };
}

test('a confirm stage records its own states with its material and leaves the dispatch free', async (t) => {
  const world = await boundaryWorld(t), artifact = await world.sign();
  assert.deepEqual(await stagePass(world, artifact), ANSWER);
  assert.deepEqual(await states(world, artifact), ['signed', 'confirm-started', 'confirm-acknowledged']);
  assert.deepEqual((await world.history.read(artifact)).at(-1).confirmation, ANSWER);
  await world.send(artifact);
  assert.deepEqual((await states(world, artifact)).slice(3), ['signed', 'dispatch-started', 'dispatch-acknowledged']);
  assert.equal(world.sent.length, 1);
});

test('an answer the material hook declines records unknown with stage_answer_not_accepted and is still returned', async (t) => {
  const world = await boundaryWorld(t), artifact = await world.sign();
  assert.deepEqual(await stagePass(world, artifact, { material:() => undefined }), ANSWER);
  assert.deepEqual(await states(world, artifact), ['signed', 'confirm-started', 'confirm-unknown']);
  assert.equal((await world.history.read(artifact)).at(-1).cause.code, 'stage_answer_not_accepted');
});

test('a confirm-started with no later record never blocks a new confirm of the same bytes', async (t) => {
  const world = await boundaryWorld(t), artifact = await world.sign(), real = world.history.append;
  cutAppend(world, 'confirm-acknowledged');
  cutAppend(world, 'confirm-unknown');
  await assert.rejects(stagePass(world, artifact), code('eb_persist_failed'));
  assert.deepEqual(await states(world, artifact), ['signed', 'confirm-started']);
  world.history.append = real;
  assert.deepEqual(await stagePass(world, artifact), ANSWER);
  assert.deepEqual((await states(world, artifact)).slice(2), ['signed', 'confirm-started', 'confirm-acknowledged']);
});

test('a withheld confirm needs an explicit request to confirm again', async (t) => {
  const { world, artifact } = await withheldConfirm(t);
  assert.deepEqual(await states(world, artifact), ['signed', 'confirm-started', 'confirm-withheld']);
  await assert.rejects(stagePass(world, artifact, { explicit:false }), code('eb_explicit_resume_required'));
  assert.deepEqual(await stagePass(world, artifact), ANSWER);
});

test('a withheld confirm does not hold the dispatch', async (t) => {
  const { world, artifact } = await withheldConfirm(t);
  await world.send(artifact);
  assert.equal(world.sent.length, 1);
});

test('a recovery dispatch is never repeated and blocks the dispatch', async (t) => {
  const world = await boundaryWorld(t), artifact = await world.sign();
  await stagePass(world, artifact, { stage:'recovery-dispatch', material:undefined });
  assert.deepEqual((await states(world, artifact)).slice(1), ['recovery-dispatch-started', 'recovery-dispatch-acknowledged']);
  await assert.rejects(stagePass(world, artifact, { stage:'recovery-dispatch', material:undefined }), code('eb_readback_required'));
  await assert.rejects(world.send(artifact), code('eb_readback_required'));
});

test('a recovery dispatch is allowed once after an unknown dispatch, which still blocks the dispatch', async (t) => {
  const world = await boundaryWorld(t), artifact = await world.sign();
  await assert.rejects(world.boundary.dispatchPass(artifact, failingSend), /TEST-send-failed/);
  await assert.rejects(world.send(artifact, { explicit:true }), code('eb_readback_required'));
  assert.deepEqual(await stagePass(world, artifact, { stage:'recovery-dispatch', material:undefined }), ANSWER);
  await assert.rejects(world.send(artifact, { explicit:true }), code('eb_readback_required'));
});

test('a recovery confirm records its own states and blocks nothing', async (t) => {
  const world = await boundaryWorld(t), artifact = await world.sign();
  await stagePass(world, artifact, { stage:'recovery-confirm' });
  assert.deepEqual((await states(world, artifact)).slice(1), ['recovery-confirm-started', 'recovery-confirm-acknowledged']);
  await world.send(artifact);
  assert.equal(world.sent.length, 1);
});

test('an unknown stage or a material that is not a function is a TypeError', async (t) => {
  const world = await boundaryWorld(t), artifact = await world.sign();
  await assert.rejects(stagePass(world, artifact, { stage:'sweep' }), TypeError);
  await assert.rejects(stagePass(world, artifact, { material:'confirmation' }), TypeError);
  assert.deepEqual(await states(world, artifact), ['signed']);
});

test('a held fence is taken once, reused by every pass of its operation inside run, and released once', async (t) => {
  const world = await boundaryWorld(t), hold = await world.boundary.holdFence(world.op);
  assert.deepEqual([world.acquired, world.released], [1, 0]);
  const artifact = await hold.run(() => world.sign());
  await hold.run(() => world.send(artifact));
  assert.deepEqual([world.acquired, world.released], [1, 0], 'passes inside run take no second fence');
  await hold.release();
  await hold.release();
  assert.deepEqual([world.acquired, world.released], [1, 1]);
  assert.equal(world.sent.length, 1);
});

test('a pass inside a held fence for another operation, or after its release, is refused', async (t) => {
  const world = await boundaryWorld(t), hold = await world.boundary.holdFence(world.op);
  await assert.rejects(hold.run(() => world.sign({ ...world.op, operationId:'TEST-other-operation' })), code('tp1_fence_not_owned'));
  await hold.release();
  await assert.rejects(hold.run(() => world.sign()), code('tp1_fence_not_owned'));
  assert.equal(world.signatures, 0);
});

test('a held fence refuses before taking the fence when writes are stopped or the profile is not admitted', async (t) => {
  const world = await boundaryWorld(t);
  world.stopped = true;
  await assert.rejects(world.boundary.holdFence(world.op), code('writes_stopped'));
  world.stopped = false;
  setPurchaseAdmission('held');
  await assert.rejects(world.boundary.holdFence(world.op), code('profile_not_admitted'));
  assert.equal(world.acquired, 0);
});

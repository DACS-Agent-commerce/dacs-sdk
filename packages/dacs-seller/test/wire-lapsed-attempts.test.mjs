// A proposal worker or recovery that is still running when its lease ends: once a successor has recovered the operation, the
// late one is refused at its next job check, so it signs and settles nothing, and the successor's outcome stands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { proposeJob, world } from './helpers/wire-routes-world.mjs';

// The wire bounds the lifetime of the discovery document it is bound to, so a test that lets leases end uses a short one.
const SHORT_LEASE_MS = 1000;

/** Replaces `w.agent[name]` with a copy that waits at `pause` on its first call; resolves once that call is waiting. */
const pauseFirstCall = async (w, name, pause) => {
  const original = w.agent[name];
  let resume;
  w.agent[name] = async (input, settings) => {
    w.agent[name] = original;
    return pause(input, settings, original, () => new Promise((resolve) => { resume = resolve; }));
  };
  return { started: async () => {
    for (let turn = 0; turn < 100 && resume === undefined; turn++) await new Promise(setImmediate);
    assert.notEqual(resume, undefined, 'the first call is waiting');
  }, resume: () => resume() };
};

test('a proposal worker held before its job check while its lease ends is refused at that check once a successor has recovered, and signs nothing', async (t) => {
  const w = await world(t, { leaseMs: SHORT_LEASE_MS }), job = await proposeJob(w, 'lapsed-worker');
  let signed = 0;
  w.agent.answer = () => { signed++; return { disposition: 'complete', contribution: { signed: true } }; };
  const held = await pauseFirstCall(w, 'receiveProposal', async (body, settings, original, wait) => { await wait(); return original(body, settings); });
  const late = job.post();
  await held.started();
  w.state.time += w.leaseMs;
  const successor = await job.post();
  assert.equal(successor.status, 200, 'the successor recovers and completes');
  held.resume();
  const lost = await late;
  assert.deepEqual({ status: lost.status, error: lost.body.error }, { status: 503, error: 'operation_uncertain' });
  assert.equal(signed, 0, 'the late worker never passed its job check');
  assert.equal((await job.post()).text, successor.text, 'the successor\'s outcome stands');
});

test('a recovery held after its claim while its lease ends is refused at its next check once a successor has recovered, and settles nothing', async (t) => {
  const w = await world(t, { leaseMs: SHORT_LEASE_MS }), job = await proposeJob(w, 'lapsed-recovery');
  // A plain failure after unknown work leaves the attempt open, so each later request after the lease is a recovery.
  w.agent.answer = () => { throw new Error('TEST the worker failed after an unknown amount of work'); };
  assert.equal((await job.post()).status, 503);
  w.agent.answer = undefined;
  w.state.time += w.leaseMs;
  let check;
  const held = await pauseFirstCall(w, 'reconcileTransport', async ({ transport }, settings, original, wait) => {
    const claim = transport.claim();
    await wait();
    try { claim.check(); check = 'live'; } catch (error) { check = `${error.code} ${error.status}`; }
  });
  const late = job.post();
  await held.started();
  w.state.time += w.leaseMs;
  const successor = await job.post();
  assert.equal(successor.status, 200, 'the successor recovers and completes');
  held.resume();
  const lost = await late;
  assert.equal(check, 'peer_reconciliation_conflict 503', 'the late claim is refused at its check');
  assert.notEqual(lost.status, 200, 'the late recovery completes nothing');
  assert.equal((await job.post()).text, successor.text, 'the successor\'s outcome stands');
});

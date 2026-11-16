// A proposal worker or recovery that is still running when its lease ends: once a successor has recovered the operation, the
// late worker is refused at its next job check and the late recovery at the agent's claim, so neither signs or settles anything, and the
// successor's outcome stands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { proposeJob, world } from './helpers/wire-routes-world.mjs';
import { proposalWireWorld } from './helpers/proposal-wire-world.mjs';

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

// The real agent holds its job fence while it recovers, so a recovery can only be overtaken before it enters the agent.
for (const end of ['completed', 'released']) {
  test(`a recovery held before the real agent's claim while its lease ends does no work once a successor has ${end} the attempt`, async (t) => {
    const w = await proposalWireWorld(t);
    // A plain failure after unknown work leaves the attempt open, so each later request after the lease is a recovery.
    const received = w.agent.receiveProposal;
    w.agent.receiveProposal = () => { throw new Error('TEST the worker failed after an unknown amount of work'); };
    assert.equal((await w.post()).status, 503);
    w.agent.receiveProposal = received;
    w.state.time += w.leaseMs;
    const held = await pauseFirstCall(w, 'reconcileTransport', async (input, settings, original, wait) => { await wait(); return original(input, settings); });
    const late = w.post();
    await held.started();
    w.state.time += w.leaseMs;
    // A receipt that does not verify makes the successor's recovery reject the proposal and release its effect.
    if (end === 'released') w.f.admission.verifyReceiptWith(() => 'invalid');
    const successor = await w.post();
    assert.equal(successor.status, 200, 'the successor answers');
    assert.equal(successor.body.disposition, end === 'completed' ? 'complete' : 'rejected');
    w.f.admission.verifyReceiptWith(null);
    const signed = w.agreementSignatures(), kept = w.realAgent().durableSessionOf(w.jobId)?.sellerContribution ?? null;
    held.resume();
    const lost = await late;
    assert.deepEqual({ status: lost.status, error: lost.body.error }, { status: 503, error: 'peer_reconciliation_conflict' }, 'the agent\'s claim refuses the late recovery');
    assert.equal(w.agreementSignatures(), signed, 'the late recovery signed nothing');
    assert.deepEqual(w.realAgent().durableSessionOf(w.jobId)?.sellerContribution ?? null, kept, 'the late recovery kept nothing');
    if (end === 'completed') assert.equal((await w.post()).text, successor.text, 'the successor\'s outcome stands');
    else {
      assert.equal((await w.post()).body.disposition, 'complete', 'the corrected request completes');
      assert.equal(w.agreementSignatures(), signed + 1, 'the Agreement is signed once, by the corrected request');
    }
  });
}

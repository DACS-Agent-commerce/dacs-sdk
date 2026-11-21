// The real agent behind the wire proposals route rechecks its context session after each awaited step before it signs, and after it signs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSellerDurableState } from '../src/dacs/seller-durable-state.mjs';
import { PATHS, operationOf } from './helpers/wire-routes-world.mjs';
import { ENDED_SESSIONS, SIGNING_BOUNDARIES, endSessionAfter, proposalWireWorld } from './helpers/proposal-wire-world.mjs';

const refusal = (answer) => ({ status: answer.status, error: answer.body.error });
const UNCERTAIN = { status: 503, error: 'operation_uncertain' };

for (const terminal of ENDED_SESSIONS) for (const boundary of SIGNING_BOUNDARIES) {
  test(`a proposal over the wire is not signed once the session ended as ${terminal} after ${boundary}`, async (t) => {
    const w = await proposalWireWorld(t, { configure: endSessionAfter(boundary, terminal) });
    w.arm();
    assert.deepEqual(refusal(await w.post()), UNCERTAIN);
    assert.equal(w.agreementSignatures(), 0, 'nothing was signed');
    assert.equal(w.realAgent().durableSessionOf(w.jobId)?.sellerContribution, undefined, 'no contribution is kept');
  });
}

test('a proposal over the wire whose session ended after the signature keeps the signature checkpoint and publishes no contribution', async (t) => {
  const w = await proposalWireWorld(t, { configure: endSessionAfter('signature', 'aborted-by-self') });
  w.arm();
  assert.deepEqual(refusal(await w.post()), UNCERTAIN);
  assert.equal(w.agreementSignatures(), 1, 'the Agreement was signed once');
  const agent = w.realAgent(), kept = agent.durableSessionOf(w.jobId);
  assert.equal(kept?.sellerContribution, undefined, 'the contribution is not published');
  agent.close();
  const state = await createSellerDurableState({ dir: w.f.dir, signer: w.f.config.signer, listingPin: agent.listingPin });
  try { assert.equal(state.signature(kept.agreementSignatureKey).disposition, 'present', 'the signature is retained'); } finally { state.close(); }
});

// A plain failure after unknown work leaves the attempt open, so the next request after the lease is a recovery that runs the agent again.
for (const boundary of [...SIGNING_BOUNDARIES, 'signature']) {
  test(`a live proposal recovery over the wire rechecks the claimed context after ${boundary}`, async (t) => {
    const w = await proposalWireWorld(t, { configure: endSessionAfter(boundary, 'aborted-by-other') });
    const received = w.agent.receiveProposal;
    w.agent.receiveProposal = () => { throw new Error('TEST the worker failed after an unknown amount of work'); };
    assert.equal((await w.post()).status, 503);
    w.agent.receiveProposal = received;
    w.state.time += w.leaseMs;
    w.arm();
    assert.deepEqual(refusal(await w.post()), UNCERTAIN);
    assert.equal(w.agreementSignatures(), boundary === 'signature' ? 1 : 0);
    assert.equal(w.realAgent().durableSessionOf(w.jobId)?.sellerContribution, undefined, 'no contribution is kept');
    assert.equal(operationOf(w, w.jobId, PATHS.proposals).state, 'pending', 'the attempt stays open');
  });
}

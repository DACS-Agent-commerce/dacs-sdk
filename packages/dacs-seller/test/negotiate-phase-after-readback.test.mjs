import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '@kynesyslabs/dacs';
import { commitmentFixture } from './helpers/commitment-fixture.mjs';
import { JOB, buyer, fixtureRecord } from './helpers/protocol-fixture.mjs';
import { agreementCreateProjection } from './helpers/agreement-create-projection.mjs';

const phaseCount = (agent) => agent.durableSessionOf(JOB).phaseResults?.length ?? 0;

// The entry earlier releases recorded when the seller's contribution completed.
const earlierNegotiateEntry = (session, listing) => {
  const contextDelta = { 'negotiate-fixed-price': { agreementHash: session.agreementHash,
    agreementRef: { anchor: { kind: 'storage-program', locator: core.fixedPriceAgreementLogicalAddress(JOB) }, contentHash: session.agreementHash } } };
  const invokedAt = session.proposalAdmission.observedAt;
  return { index: 0, step: structuredClone(listing.pipeline[0]), invokedAt, result: { ok: true, contextDelta }, contextDelta };
};

test('receiveProposal records no negotiate phase before the Agreement is anchored', async (t) => {
  const f = await commitmentFixture(t), { agent } = await f.prepare();
  assert.equal(phaseCount(agent), 0);
  assert.equal(agent.durableSessionOf(JOB).agreement ?? null, null);
});

for (const [name, readback, code] of [
  ['absent', { disposition: 'absent' }, 'agreement_not_anchored'],
  ['indeterminate', { disposition: 'indeterminate', reason: 'TEST read timeout' }, 'substrate_unavailable'],
  ['rejected', { disposition: 'rejected', reason: 'TEST not the buyer write' }, 'agreement_anchor_invalid'],
]) {
  test(`commit records no negotiate phase when the Agreement readback is ${name}`, async (t) => {
    const f = await commitmentFixture(t), { agent } = await f.prepare();
    f.controls.read = () => readback;
    await assert.rejects(agent.commit({ jobId: JOB }), (error) => error.code === code);
    assert.equal(phaseCount(agent), 0);
    assert.equal(f.local.writes.length, 0);
  });
}

test('commit records no negotiate phase when the anchored Agreement differs from the contribution', async (t) => {
  const f = await commitmentFixture(t), { agent, agreement } = await f.prepare();
  const substituted = { ...structuredClone(agreement), generatedAt: agreement.generatedAt + 1 };
  f.controls.agreement = fixtureRecord(core.fixedPriceAgreementLogicalAddress(JOB), substituted, buyer);
  await assert.rejects(agent.commit({ jobId: JOB }), (error) => error.code === 'agreement_substituted');
  assert.equal(phaseCount(agent), 0);
});

test('commit records the negotiate phase and then the commitment phase after authenticated readback', async (t) => {
  const f = await commitmentFixture(t), { agent } = await f.prepare();
  assert.equal((await agent.commit({ jobId: JOB })).status, 'committed');
  const session = agent.durableSessionOf(JOB);
  assert.equal(session.phaseResults.length, 2);
  assert.deepEqual(session.phaseResults[0], earlierNegotiateEntry(session, f.listing));
  assert.equal(session.phaseResults[1].index, 1);
});

test('a repeated commit keeps the recorded negotiate phase unchanged', async (t) => {
  const f = await commitmentFixture(t), { agent } = await f.prepare();
  await agent.commit({ jobId: JOB });
  const kept = structuredClone(agent.durableSessionOf(JOB).phaseResults);
  assert.equal((await agent.commit({ jobId: JOB })).status, 'committed');
  assert.deepEqual(agent.durableSessionOf(JOB).phaseResults, kept);
});

test('early commitment on signature holds without recording a negotiate phase', async (t) => {
  const f = await commitmentFixture(t, { early: true }), { agent, agreement } = await f.prepare();
  f.controls.agreement = null;
  const request = { jobId: JOB, agreement, signedProjection: agreementCreateProjection(agreement) };
  assert.equal((await agent.commitOnSignature(request)).status, 'commitment-held');
  assert.equal(phaseCount(agent), 0);
});

test('a session saved with the negotiate phase by earlier code still commits with the same entry', async (t) => {
  const f = await commitmentFixture(t), { agent } = await f.prepare();
  agent.close();
  const { createSellerDurableState } = await import('../src/dacs/seller-durable-state.mjs');
  const { listingPin } = await import('../src/dacs/purchase-protocol.mjs');
  const state = await createSellerDurableState({ dir: f.dir, signer: f.config.signer, listingPin: listingPin(f.listing) });
  let earlier;
  try {
    await state.withJob(JOB, (session) => {
      earlier = earlierNegotiateEntry(session, f.listing);
      session.phaseResults = [structuredClone(earlier)];
      state.saveSession(session);
    });
  } finally { state.close(); }
  const fresh = await f.open();
  assert.equal((await fresh.commit({ jobId: JOB })).status, 'committed');
  const session = fresh.durableSessionOf(JOB);
  assert.deepEqual(session.phaseResults[0], earlier);
  assert.equal(session.phaseResults.length, 2);
});

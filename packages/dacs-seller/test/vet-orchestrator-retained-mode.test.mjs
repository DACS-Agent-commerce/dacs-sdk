// A retained session is continued only by an agent of the Vet mode that made it
// (K3: "a retained context under the other mode is refused, never continued").
// Directly constructed agents over durable directories: the session is made
// through the normal APIs, closed, and reopened under the other (or the same) mode.
// The two stages after the Agreement and the commitment cannot be driven by this
// package's fixtures (a confirmed payment needs a signed nonce they lack), so
// "during payment evidence" and "after delivery-ready" are the committed session
// with that stage's retained marker written into its durable row.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '@kynesyslabs/dacs';
import { ORCHESTRATOR_MODE as W } from './helpers/proposal-admission-fixture.mjs';
import { commitmentFixture } from './helpers/commitment-fixture.mjs';
import { buyer, JOB } from './helpers/protocol-fixture.mjs';
import { createSellerDurableState } from '../src/dacs/seller-durable-state.mjs';
import { contributionVerifier, listingPin } from '../src/dacs/purchase-protocol.mjs';

const COUNTERPARTY = undefined, PAYMENT = { jobId: JOB, txHash: 'a'.repeat(64), payerPayingKey: buyer.claim };
const ROUTES = ['/dacs/v1/agreements/proposals', '/dacs/v1/commitments', '/dacs/v1/payments'];
const STAGES = {
  'after the Agreement signature': { commit: false },
  'after the commitment': { commit: true },
  'during retained payment evidence': { commit: true, plant: session => { session.nativeEvidenceWork = { txHash: PAYMENT.txHash, payerPayingKey: PAYMENT.payerPayingKey }; } },
  'after delivery-ready': { commit: true, plant: session => { session.stage = 'delivery-ready'; } },
};
const DIRECTIONS = [['counterparty to W', COUNTERPARTY, W], ['W to counterparty', W, COUNTERPARTY], ['unstamped to W', COUNTERPARTY, W, session => { delete session.demDeliveryContext.vetMode; }]];

async function rewriteRetained(f, change) {
  const durable = await createSellerDurableState({ dir: f.dir, signer: f.config.signer, listingPin: listingPin(f.listing) });
  try { await durable.withJob(JOB, async session => { change(session); durable.saveSession(session); }); } finally { durable.close(); }
}
// A session made under `from` through the normal APIs, closed, with `stage`'s marker and `legacy`'s edit applied.
async function retainedSession(t, from, { commit, plant }, legacy) {
  const f = await commitmentFixture(t, { vetMode: from }), { agent, request, agreement } = await f.prepare();
  if (commit) assert.equal((await agent.commit({ jobId: JOB })).status, 'committed');
  agent.close();
  for (const change of [plant, legacy]) if (change) await rewriteRetained(f, change);
  return { f, request, agreement };
}
const entriesOf = (agent, { request, agreement }) => ({
  receiveProposal: () => agent.receiveProposal(request),
  agreementState: async () => agent.agreementState(request.transportIdentity),
  commit: () => agent.commit({ jobId: JOB }),
  commitOnSignature: () => agent.commitOnSignature({ jobId: JOB, agreement, signedProjection: {} }),
  submitPayment: () => agent.submitPayment(PAYMENT),
  resume: () => agent.resume({ jobId: JOB }),
  ...Object.fromEntries(ROUTES.map(path => [`reconcileTransport ${path}`, () => agent.reconcileTransport({ request: { path, jobId: JOB } })])),
});
const effects = f => core.canonicalize({ signed: f.signed.length, published: f.local.rows.size });

test('a retained session produced through the normal APIs and reopened under the other mode is refused vet_mode_mismatch at every entry and stage, with no new effect and the record unchanged', async t => {
  for (const [direction, from, to, legacy] of DIRECTIONS) for (const [stage, spec] of Object.entries(STAGES)) {
    const made = await retainedSession(t, from, spec, legacy), agent = await made.f.reopenAs(to);
    const record = core.canonicalize(agent.durableSessionOf(JOB)), before = effects(made.f);
    for (const [name, enter] of Object.entries(entriesOf(agent, made))) {
      const label = `${direction}, ${stage}, ${name}`;
      let answer, thrown;
      try { answer = await enter(); } catch (error) { thrown = error; }
      if (name === 'receiveProposal') assert.match(answer?.reason ?? '', /vet_mode_mismatch/, label);
      else if (name.startsWith('reconcileTransport')) assert.match(answer?.reason ?? '', /vet_mode_mismatch/, label);
      else assert.equal(thrown?.code, 'vet_mode_mismatch', label);
      assert.ok(!['complete', 'committed', 'delivery-ready', 'delivered', 'present'].includes(answer?.disposition ?? answer?.status), `${label}: no usable success`);
    }
    assert.equal(effects(made.f), before, `${direction}, ${stage}: no signature or publication`);
    assert.equal(core.canonicalize(agent.durableSessionOf(JOB)), record, `${direction}, ${stage}: the retained record is unchanged`);
  }
});

test('the same retained sessions reopened under their own mode continue exactly as today at every entry and stage, the state read assembling the retained Agreement', async t => {
  for (const [mode, label] of [[COUNTERPARTY, 'counterparty'], [W, 'W']]) for (const stage of ['after the Agreement signature', 'after the commitment']) {
    const made = await retainedSession(t, mode, STAGES[stage]), agent = await made.f.reopenAs(mode), entries = entriesOf(agent, made);
    const state = agent.agreementState(made.request.transportIdentity);
    assert.ok(state.proposal && state.contribution, `${label}, ${stage}: the state read answers`);
    const assembled = await core.finalizeFixedPriceAgreementContributions(made.request.proposal.plan, [made.request.proposal.buyerContribution, state.contribution], contributionVerifier);
    assert.deepEqual(assembled, made.agreement, `${label}, ${stage}: the seller contribution assembles the retained Agreement`);
    assert.equal((await entries.receiveProposal()).disposition, 'complete', `${label}, ${stage}: replay`);
    assert.equal((await entries.commit()).status, 'committed', `${label}, ${stage}: commit`);
  }
  const legacy = await retainedSession(t, COUNTERPARTY, STAGES['after the Agreement signature'], session => { delete session.demDeliveryContext.vetMode; });
  const agent = await legacy.f.reopenAs(COUNTERPARTY);
  assert.ok(agent.agreementState(legacy.request.transportIdentity).contribution, 'a legacy unstamped session continues under a counterparty agent');
});

test('the read-only snapshots still answer for a session of the other mode', async t => {
  const made = await retainedSession(t, COUNTERPARTY, STAGES['after the commitment']), agent = await made.f.reopenAs(W);
  assert.equal(agent.stageOf(JOB), 'committed');
  assert.ok(agent.durableSessionOf(JOB));
  assert.equal(agent.deliveryStateOf(JOB), null);
  assert.equal(agent.durableSessions().length, 1);
});

// The payments row on the wire journal, with the real fixture-profile agent behind the handler: states, retention, recovery and the sources a
// final answer is read against.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PATHS, operationOf } from './helpers/wire-routes-world.mjs';
import { SellerAgentError } from '../src/dacs/seller-agent.mjs';
import { EVIDENCE_SIGNATURE, OTHER_TX, PAYMENT_TX, WORK_SAVE_SIGNATURE, fixturePaymentWorld, includedTransfer } from './helpers/wire-payment-fixture.mjs';

const stateOf = (w, id = w.jobId) => operationOf(w, id, PATHS.payments).state;
const pending = async () => ({ status: 'pending', reason: 'demos-pending' });
const underpaid = (txHash) => includedTransfer(txHash, { amountOs: '1' });
// The effects of a payment that was delivered once: one evidence CREATE, one Deliverable, one delivery evidence.
const assertDeliveredOnce = (w) => assert.deepEqual([w.evidenceCreates(), w.deliverableWrites(), w.deliveryEvidenceWrites()], [1, 1, 1]);
// A payment that stopped after the work checkpoint: the evidence signer fails once, so the work is kept and nothing is signed or sent.
const cutAtEvidenceSignature = async (w, options) => {
  w.script.signFault = EVIDENCE_SIGNATURE;
  const cut = await w.pay(options);
  assert.deepEqual([cut.status, cut.body.error], [503, 'operation_uncertain']);
  assert.ok(w.work(), 'the payment work is kept');
  assert.deepEqual([w.evidenceCreates(), w.deliverableWrites()], [0, 0]);
  return cut;
};

for (const [title, answeredBefore, unfinished] of [
  ['an indeterminate payment with no saved work ends without an outcome and recovery reruns intake', pending, 'indeterminate'],
  ['a rejected payment with no saved work lets recovery authenticate the original or a corrected claim', underpaid, 'rejected'],
]) {
  test(title, async (t) => {
    for (const restart of [false, true]) for (const corrected of [false, true]) {
      const w = await fixturePaymentWorld(t), label = `restart ${restart}, corrected ${corrected}`;
      w.script.observe = answeredBefore;
      const first = await w.pay();
      assert.deepEqual([first.status, first.body.status], [200, unfinished], label);
      assert.equal(stateOf(w), 'ended', `${label}: no work, so the attempt ends with no outcome`);
      assert.equal(w.work(), undefined, label);
      const submits = w.counts.publicSubmits;
      if (restart) await w.restart();
      w.script.observe = null;
      const final = await w.pay({ txHash: corrected ? OTHER_TX : PAYMENT_TX });
      assert.deepEqual([final.status, final.body.status], [200, 'delivered'], label);
      assert.equal(w.counts.publicSubmits, submits, `${label}: the next request is a recovery, never the public payment call inside the job lock`);
      // Two reads of the transfer reach intake, then one more checks the sources of the first completion.
      assert.equal(w.counts.observations.length, 3, label);
      assert.equal(stateOf(w), 'completed', label);
      assertDeliveredOnce(w);
    }
  });
}

test('retained work for the same claim is continued by recovery, and work for another transaction holds', async (t) => {
  const w = await fixturePaymentWorld(t);
  await cutAtEvidenceSignature(w);
  assert.equal(stateOf(w), 'pending', 'the attempt stays open');
  w.lapse();
  const held = await w.pay({ txHash: OTHER_TX });
  assert.deepEqual([held.status, held.body.error], [503, 'operation_uncertain'], 'another transaction holds');
  assert.equal(stateOf(w), 'pending');
  assert.equal(w.evidenceCreates(), 0);
  w.lapse();
  const final = await w.pay();
  assert.deepEqual([final.status, final.body.status], [200, 'delivered'], 'the same claim continues its retained work');
  assertDeliveredOnce(w);
  assert.equal(w.counts.publicSubmits, 1, 'only the first run entered the public payment call; recoveries run the inner payment');
});

test('a held payment keeps its attempt open until recovery verifies final delivery', async (t) => {
  const w = await fixturePaymentWorld(t);
  await cutAtEvidenceSignature(w);
  w.lapse();
  w.script.observe = pending;
  const held = await w.pay();
  assert.equal(held.signed, true);
  assert.notEqual(held.status, 200, held.text);
  assert.equal(stateOf(w), 'pending', 'a held answer is never stored and never ends the attempt');
  assert.equal(w.counts.observations.length > 0, true);
  w.script.observe = null;
  w.lapse();
  const final = await w.pay();
  assert.equal(final.body.status, 'delivered');
  assert.equal(stateOf(w), 'completed');
  assertDeliveredOnce(w);
});

test('an evidenced payment with unfinished delivery keeps its attempt open', async (t) => {
  const w = await fixturePaymentWorld(t);
  const { deliverableAddress } = await import('../src/dacs/purchase-protocol.mjs');
  w.f.anchors.controls.failAfterWrite = deliverableAddress(w.jobId);
  const cut = await w.pay();
  assert.deepEqual([cut.status, cut.body.error], [503, 'operation_uncertain']);
  assert.deepEqual([w.evidenceCreates(), w.deliverableWrites(), w.deliveryEvidenceWrites()], [1, 1, 0], 'the evidence is anchored and the delivery is not done');
  assert.equal(stateOf(w), 'pending');
  w.lapse();
  const final = await w.pay();
  assert.equal(final.body.status, 'delivered');
  assertDeliveredOnce(w);
});

test('a refusal with unfinished retained payment work keeps the attempt open', async (t) => {
  const w = await fixturePaymentWorld(t);
  // The work is retained by a run that is not on the wire, so the wire's first request for the job is a new attempt that the agent refuses.
  w.script.signFault = EVIDENCE_SIGNATURE;
  await assert.rejects(w.f.agent.submitPayment(w.bodyOf(w.jobId, PAYMENT_TX)));
  assert.ok(w.work());
  w.agent.submitPayment = async () => { throw new SellerAgentError('rail_unavailable', 'TEST refusal', 503); };
  const refused = await w.pay();
  assert.deepEqual([refused.status, refused.body.error], [503, 'rail_unavailable'], 'the listed refusal is answered');
  assert.equal(stateOf(w), 'pending', 'it does not end the attempt, because payment work is retained');
  assert.equal(w.evidenceCreates(), 0);
});

test('an error after payment reservation keeps the attempt open until recovery', async (t) => {
  const w = await fixturePaymentWorld(t);
  await cutAtEvidenceSignature(w);
  assert.equal(stateOf(w), 'pending');
  const inside = await w.pay();
  assert.equal(inside.body.error, 'seller_effect_pending', 'inside the lease the attempt is pending');
  w.lapse();
  const recovered = await w.pay();
  assert.deepEqual([recovered.status, recovered.body.status], [200, 'delivered']);
  assert.equal(stateOf(w), 'completed');
  assertDeliveredOnce(w);
  assert.ok(WORK_SAVE_SIGNATURE.length > 0);
});

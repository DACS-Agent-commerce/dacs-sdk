// The payments row on the wire journal, with the real fixture-profile agent behind the handler: states, retention, recovery and the sources a
// final answer is read against.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paymentEvidenceAddress } from '@kynesyslabs/dacs';
import { seller } from './helpers/protocol-fixture.mjs';
import { PATHS, completions, operationOf } from './helpers/wire-routes-world.mjs';
import { SellerAgentError } from '../src/dacs/seller-agent.mjs';
import { deliverableAddress, deliveryEvidenceAddress } from '../src/dacs/purchase-protocol.mjs';
import { EVIDENCE_SIGNATURE, OTHER_TX, PAYMENT_TX, WORK_SAVE_SIGNATURE, fixturePaymentWorld, includedTransfer } from './helpers/wire-payment-fixture.mjs';

// The deadline of one bounded source read, and how many turns of the event loop a test waits for a read to start.
const SOURCE_READ_TIMEOUT_MS = 10000;
const EVENT_LOOP_TURNS = 100000;
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
});

// ---- Final answers: the sources read again before the first completion ----

const RECEIPTS_FILE = (w) => join(w.f.config.durableDirectory, 'sdk-receipts', 'seller-receipts.json');
const readReceipts = (w) => JSON.parse(readFileSync(RECEIPTS_FILE(w), 'utf8'));
// Rewrites the seller's receipt state, as another writer would.
const editReceipts = (w, change) => {
  const state = readReceipts(w);
  change(state);
  writeFileSync(RECEIPTS_FILE(w), JSON.stringify(state));
};
const permitRecord = (state) => Object.values(state.records)[0];
const paymentCompletions = (w) => completions(w).filter((row) => row.route === PATHS.payments);

// What the first completion's source check reads, in the order of its reads: the commitment, the transfer, the permit, the three records.
// `afterTransfer` runs when the transfer is read for that check (the second read of a first run), so the change lands between the agent's own
// work and the check.
const changedAtCheck = (w, { transfer = (txHash) => includedTransfer(txHash), afterTransfer = () => {} } = {}) => {
  let reads = 0;
  w.script.observe = (txHash) => {
    if (++reads === 1) return includedTransfer(txHash);
    afterTransfer();
    return transfer(txHash);
  };
};
const alteredRecord = (w, address, change) => {
  w.f.anchors.controls.read = (row, at) => (at === address ? change(row) : row);
};
const FIRST_COMPLETION_CELLS = [
  ['the transfer is not found', 'absent', (w) => changedAtCheck(w, { transfer: async () => ({ status: 'not-found' }) })],
  ['the transfer is not yet included', 'unavailable', (w) => changedAtCheck(w, { transfer: pending })],
  ['the transfer read fails', 'unavailable', (w) => changedAtCheck(w, { transfer: async () => { throw new Error('TEST node unreachable'); } })],
  ['the transfer amount is not the price', 'changed', (w) => changedAtCheck(w, { transfer: underpaid })],
  ['the transfer was paid by another key', 'changed', (w) => changedAtCheck(w, { transfer: (txHash) => includedTransfer(txHash, { payer: seller.address }) })],
  ['the receipt state that holds the permit is damaged', 'unavailable', (w) => changedAtCheck(w, { afterTransfer: () => editReceipts(w, (state) => { state.permits = {}; }) })],
  ['the payment evidence record differs', 'changed', (w) => changedAtCheck(w, { afterTransfer: () => alteredRecord(w, paymentEvidenceAddress(w.jobId, 'demos-native:DEM', 2), (row) => ({ ...row, artifact: { ...row.artifact, observedAt: 1 } })) })],
  ['the Deliverable record is gone', 'changed', (w) => changedAtCheck(w, { afterTransfer: () => alteredRecord(w, deliverableAddress(w.jobId), () => ({ status: 'absent' })) })],
  ['the delivery evidence record differs', 'changed', (w) => changedAtCheck(w, { afterTransfer: () => alteredRecord(w, deliveryEvidenceAddress(w.jobId), (row) => ({ ...row, artifact: { ...row.artifact, outcome: 'failure' } })) })],
];

test('a final payment answer completes only after transfer, evidence, permit and delivery revalidate', async (t) => {
  const control = await fixturePaymentWorld(t);
  const valid = await control.pay();
  assert.deepEqual([valid.status, valid.body.status], [200, 'delivered']);
  assert.equal(paymentCompletions(control).length, 1, 'the valid answer is stored once');
  for (const [label, cause, arrange] of FIRST_COMPLETION_CELLS) {
    const w = await fixturePaymentWorld(t);
    arrange(w);
    const answer = await w.pay();
    assert.equal(answer.signed, true, label);
    assert.deepEqual([answer.status, answer.body.error, answer.body.cause], [503, 'seller_source_unavailable', cause], label);
    assert.equal(stateOf(w), 'pending', `${label}: the attempt stays open`);
    assert.deepEqual(paymentCompletions(w), [], `${label}: no outcome is stored`);
    assertDeliveredOnce(w);
    assert.equal(w.counts.publicSubmits, 1, label);
  }
});

test('a first completion source check that times out during recovery leaves the attempt open', async (t) => {
  const w = await fixturePaymentWorld(t);
  await cutAtEvidenceSignature(w);
  w.lapse();
  // The check's timer is the real setTimeout of the bounded read: advancing the world's clock alone would not fire it.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0, hung = false;
  w.script.observe = (txHash) => {
    if (++reads === 1) return includedTransfer(txHash);
    hung = true;
    return new Promise(() => {});
  };
  const answering = w.pay();
  for (let turns = 0; !hung; turns++) {
    assert.ok(turns < EVENT_LOOP_TURNS, 'the source check never read the transfer again');
    await new Promise((resolve) => setImmediate(resolve));
  }
  t.mock.timers.tick(SOURCE_READ_TIMEOUT_MS);
  const answer = await answering;
  assert.deepEqual([answer.status, answer.body.error, answer.body.cause, answer.signed], [503, 'seller_source_unavailable', 'timeout', true]);
  assert.equal(stateOf(w), 'pending');
  assert.deepEqual(paymentCompletions(w), []);
  assertDeliveredOnce(w);
});

// ---- Recovery authenticates the original transfer again before it signs ----

const TRANSFER_CELLS = [
  ['the transfer read fails', async () => { throw new Error('TEST node unreachable'); }],
  ['the transfer is not yet included', pending],
  ['the transfer is not found', async () => ({ status: 'not-found' })],
  ['the transfer amount changed', underpaid],
  ['the transfer payer changed', (txHash) => includedTransfer(txHash, { payer: seller.address })],
];

test('payment recovery authenticates the original transfer again before signing evidence', async (t) => {
  for (const restart of [false, true]) for (const [label, transfer] of TRANSFER_CELLS) {
    const w = await fixturePaymentWorld(t), cell = `${label}, restart ${restart}`;
    await cutAtEvidenceSignature(w);
    const signedAtCut = w.evidenceSignatures(), submits = w.counts.publicSubmits;
    if (restart) await w.restart();
    w.lapse();
    w.script.observe = transfer;
    const held = await w.pay();
    assert.equal(held.signed, true, cell);
    assert.deepEqual([held.status, held.body.error], [503, 'operation_uncertain'], cell);
    assert.equal(stateOf(w), 'pending', `${cell}: no end record`);
    assert.equal(w.evidenceSignatures(), signedAtCut, `${cell}: nothing is signed`);
    assert.deepEqual([w.evidenceCreates(), w.deliverableWrites(), w.deliveryEvidenceWrites()], [0, 0, 0], cell);
    assert.equal(w.counts.publicSubmits, submits, `${cell}: the public payment call is never entered`);
    w.script.observe = null;
    w.lapse();
    const final = await w.pay();
    assert.equal(final.body.status, 'delivered', `${cell}: once the transfer reads as the original, recovery delivers`);
    assertDeliveredOnce(w);
  }
});

test('payment recovery with no saved work authenticates the transfer before it signs anything', async (t) => {
  for (const [label, transfer] of TRANSFER_CELLS) {
    const w = await fixturePaymentWorld(t);
    // The first run fails before the work is kept: the Agreement's commitment cannot be read.
    w.f.anchors.controls.read = (row, address) => { if (address.startsWith('dacs3:commit:')) throw new Error('TEST commitment read down'); return row; };
    const failed = await w.pay();
    assert.equal(failed.body.error, 'operation_uncertain', label);
    assert.equal(w.work(), undefined, `${label}: no work was kept`);
    w.f.anchors.controls.read = (row) => row;
    w.lapse();
    w.script.observe = transfer;
    const recovering = await w.pay();
    assert.notEqual(recovering.body.status, 'delivered', label);
    assert.equal(w.evidenceSignatures(), 0, `${label}: an unavailable transfer reaches no evidence signing`);
    assert.equal(w.evidenceCreates(), 0, label);
    w.script.observe = null;
    w.lapse();
    assert.equal((await w.pay()).body.status, 'delivered', `${label}: then the payment is delivered`);
    assertDeliveredOnce(w);
  }
});

// ---- Retained work and its identity ----

test('a claim saved before the work checkpoint resumes with its original authorization', async (t) => {
  const w = await fixturePaymentWorld(t);
  w.script.signFault = WORK_SAVE_SIGNATURE;
  const cut = await w.pay();
  assert.deepEqual([cut.status, cut.body.error], [503, 'operation_uncertain']);
  assert.equal(w.work(), undefined, 'the work was not saved');
  const granted = readReceipts(w);
  assert.equal(Object.keys(granted.records).length, 1, 'the permit was granted before the cut');
  await w.restart();
  w.lapse();
  const final = await w.pay();
  assert.deepEqual([final.status, final.body.status], [200, 'delivered']);
  const after = readReceipts(w);
  assert.deepEqual(Object.keys(after.records), Object.keys(granted.records), 'no second permit is granted');
  assert.deepEqual(permitRecord(after).selected, permitRecord(granted).selected, 'the original authorization is used');
  assertDeliveredOnce(w);
});

test('another payment claim cannot hide retained or unreadable work for the job', async (t) => {
  const w = await fixturePaymentWorld(t);
  // The work is kept by a run that is not on the wire, so a claim for another transaction is the job's first request.
  w.script.signFault = EVIDENCE_SIGNATURE;
  await assert.rejects(w.f.agent.submitPayment(w.bodyOf(w.jobId, PAYMENT_TX)));
  const kept = JSON.stringify(w.work());
  assert.equal(w.f.agent.retainsPaymentWork(w.jobId), true, 'the job holds work');
  assert.equal(w.f.agent.retainsPaymentClaim(w.jobId, { txHash: OTHER_TX, payerPayingKey: w.work().payerPayingKey }), false, 'the exact-claim predicate keeps its meaning');
  w.script.observe = pending;
  const other = await w.pay({ txHash: OTHER_TX });
  assert.equal(other.signed, true);
  assert.notEqual(other.status, 200, 'the other claim is not answered as a no-effect result');
  assert.equal(stateOf(w), 'pending', 'it does not end the attempt');
  assert.equal(JSON.stringify(w.work()), kept, 'no replacement work is saved');
  // The retained state cannot be read: the handler treats that as work, never as none.
  const unreadable = await fixturePaymentWorld(t);
  unreadable.agent.retainsPaymentWork = () => { throw new Error('TEST retained state unreadable'); };
  unreadable.script.observe = pending;
  assert.equal((await unreadable.pay()).signed, true);
  assert.equal(stateOf(unreadable), 'pending', 'an unreadable snapshot is retained work: no null end');
});

test('a payment whose settlement credit is withdrawn just before its evidence is signed signs and sends nothing', async (t) => {
  const w = await fixturePaymentWorld(t);
  await cutAtEvidenceSignature(w);
  const signedAtCut = w.evidenceSignatures();
  // Another job claims the same transfer: the settlement is contested and this job loses its credit.
  const { settlementId } = w.work().intake;
  await w.f.store.withJob(w.otherJobId, () => w.f.store.bindSettlement(settlementId, w.otherJobId, { jobId: w.otherJobId, phaseIndex: 2 }));
  w.lapse();
  const withheld = await w.pay();
  assert.deepEqual([withheld.status, withheld.body.error], [503, 'operation_uncertain']);
  assert.equal(w.evidenceSignatures(), signedAtCut, 'no evidence is signed');
  assert.deepEqual([w.evidenceCreates(), w.deliverableWrites(), w.deliveryEvidenceWrites()], [0, 0, 0], 'nothing is written');
  assert.equal(stateOf(w), 'pending');
});

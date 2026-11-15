// The payments row on the wire journal, with the real fixture-profile agent behind the handler: states, retention, recovery and the sources a
// final answer is read against. The native profile runs the same controls on the native wire world at the end of the file.
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
import { DELEGATION_MS, T0, nativePaymentWorld } from './helpers/native-payment-wire-fixture.mjs';

// The deadline of one bounded source read, and how many turns of the event loop a test waits for a read to start.
const SOURCE_READ_TIMEOUT_MS = 10000;
const EVENT_LOOP_TURNS = 100000;
// The native world's node stamps its blocks a few seconds apart, so its clock may sit a little past the start time.
const CLOCK_START_SLACK_MS = 60_000;
const CLOCK_STEP_MS = 1000;
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
  ['the permit is gone from the receipt state', 'changed', (w) => changedAtCheck(w, { afterTransfer: () => editReceipts(w, (state) => { state.records = {}; state.permits = {}; }) })],
  ['the permit authorizes a different rail registry version', 'changed', (w) => changedAtCheck(w, { afterTransfer: () => editReceipts(w, (state) => { permitRecord(state).selected.authorization.railRegistryVersion = 2; }) })],
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

// ---- The native profile on the native wire world ----

const nativeStateOf = (w, p) => w.wireState(p).state;
// The seller's own steps of a payment that was delivered once: one payment evidence CREATE, one Deliverable, one delivery evidence, and the two
// evidence signatures that go with the first and the last.
const assertNativeDeliveredOnce = (w, p) => {
  assert.deepEqual([w.evidenceCreates(p), w.deliverableWrites(p), w.deliveryEvidenceWrites(p)], [1, 1, 1]);
  assert.equal(w.counts.walletSignatures, 1, 'the wallet signed the payment evidence once');
};
// The node answers a read of this transfer in place of its record; every other read is the node's own.
const readTransferAs = (w, txHash, answer) => { w.node.script.transferRead = (hash, record, message) => (hash === txHash ? answer(record, message) : record); };
const unreadableTransfer = () => { throw new Error('TEST node unreachable'); };
// A transfer the chain executed and failed: its status and its record both say so, or the status still says included while its record says failed.
const failedTransfer = (record) => ({ ...record, status: 'failed' });
const includedButFailedTransfer = (record, message) => (message === 'getTxByHash' ? { ...record, status: 'failed' } : record);
const changedTransfer = (record) => ({ ...record, content: { ...record.content, amount: '1', data: ['native', { nativeOperation: 'send', args: [record.content.to, '1'] }] } });
const recordReceiptEdit = (w, change) => {
  const state = JSON.parse(readFileSync(w.receiptsFile, 'utf8'));
  change(state);
  writeFileSync(w.receiptsFile, JSON.stringify(state));
};

for (const [title, unfinished, reason, firstRead] of [
  ['a native payment whose transfer cannot be found ends without an outcome and recovery reruns intake', 'indeterminate', 'demos-not-found', () => null],
  ['a native payment with a rejected transfer lets recovery authenticate the original or a corrected claim', 'rejected', 'payment-amount-mismatch', changedTransfer],
]) {
  test(title, async (t) => {
    for (const restart of [false, true]) for (const corrected of [false, true]) {
      const w = await nativePaymentWorld(t), p = await w.purchase(), label = `restart ${restart}, corrected ${corrected}`;
      const original = p.pay();
      readTransferAs(w, original, firstRead);
      const early = await p.claim(original);
      assert.deepEqual([early.status, early.reason], [unfinished, reason], label);
      assert.equal(nativeStateOf(w, p), 'ended', `${label}: no work was kept, so the attempt ends with no outcome`);
      assert.equal(w.grantedReceipts(), 0, `${label}: no receipt is granted while no work is kept`);
      // A restart reopens the host, the wallet journal and the artifact anchor over the same stores; reading the work then stops the host and starts it again.
      if (restart) {
        await w.restart();
        assert.equal(await w.work(p), undefined, `${label}: no work is retained across the restart`);
      }
      w.node.script.transferRead = null;
      const final = await p.claim(corrected ? p.pay() : original);
      assert.equal(final.status, 'payment-evidenced', label);
      assert.equal(nativeStateOf(w, p), 'completed', label);
      assertNativeDeliveredOnce(w, p);
      // Each of the two requests runs intake, and every read of the transfer happens with the job's one durable lock held. The one receipt is granted by the second.
      const reads = w.transferReads();
      assert.equal(reads.length, 2, label);
      assert.ok(reads.every((locksAtRead) => locksAtRead.length > 0 && locksAtRead.every((locks) => locks.length === 1 && locks[0] === p.jobId)), `${label}: one job lock at every read`);
      assert.equal(w.grantedReceipts(), 1, label);
      assert.deepEqual(w.lockedJobs(), [], `${label}: the lock is released`);
    }
  });
}

// A transfer that executed and failed is never paid: nothing is retained, signed, written or delivered, and the same transfer read as the
// executed original afterwards is paid once.
for (const [label, answer] of [['its status and record say failed', failedTransfer], ['its status says included and its record says failed', includedButFailedTransfer]]) {
  test(`a native payment whose transfer failed to execute is not paid: ${label}`, async (t) => {
    for (const restart of [false, true]) {
      const w = await nativePaymentWorld(t), p = await w.purchase(), txHash = p.pay(), cell = `restart ${restart}`;
      readTransferAs(w, txHash, answer);
      const refused = await p.claim(txHash);
      assert.notEqual(refused.status, 'payment-evidenced', cell);
      if (restart) await w.restart();
      assert.equal(await w.work(p), undefined, `${cell}: no work is retained`);
      assert.equal(nativeStateOf(w, p), 'ended', `${cell}: no outcome is recorded`);
      assert.deepEqual([w.grantedReceipts(), w.counts.walletSignatures, w.counts.walletBroadcasts, w.evidenceCreates(p), w.deliverableWrites(p), w.deliveryEvidenceWrites(p)],
        [0, 0, 0, 0, 0, 0], `${cell}: no receipt, signature, broadcast, evidence, Deliverable or delivery`);
      w.node.script.transferRead = null;
      const control = await p.claim(txHash);
      assert.equal(control.status, 'payment-evidenced', `${cell}: the executed original is paid`);
      assertNativeDeliveredOnce(w, p);
    }
  });
}

// A payment cut after its work is saved and before the wallet signs the evidence CREATE: the work is retained and the wallet did nothing.
const cutBeforeWalletSignature = async (w, p, txHash) => {
  w.faults.walletSignature = 1;
  const cut = await p.claim(txHash);
  assert.notEqual(cut.status, 'payment-evidenced', 'the payment is not delivered at the cut');
  assert.equal(nativeStateOf(w, p), 'pending', 'the attempt stays open');
  assert.deepEqual([w.counts.walletSignatures, w.counts.walletBroadcasts, w.evidenceCreates(p)], [0, 0, 0], 'the wallet signed and sent nothing');
  return cut;
};

for (const restart of [false, true]) for (const [label, answer] of [
  ['the transfer read fails', unreadableTransfer], ['the transfer cannot be found', () => null], ['the transfer amount changed', changedTransfer],
  ['the transfer failed to execute', failedTransfer], ['the transfer is included but its record says failed', includedButFailedTransfer],
]) {
  test(`native payment recovery authenticates the original transfer again before the wallet signs or sends: ${label}, restart ${restart}`, async (t) => {
    const w = await nativePaymentWorld(t), p = await w.purchase(), txHash = p.pay();
    await cutBeforeWalletSignature(w, p, txHash);
    if (restart) await w.restart();
    readTransferAs(w, txHash, answer);
    const held = await p.claim(txHash);
    assert.notEqual(held.status, 'payment-evidenced', 'recovery does not deliver while the transfer is unreadable or changed');
    const [, recovery] = w.transferReads();
    assert.deepEqual(recovery?.[0], [p.jobId], 'recovery reads the original transfer again, with the job lock held, before it signs anything');
    assert.equal(w.grantedReceipts(), 1, 'recovery grants no second receipt');
    assert.equal(nativeStateOf(w, p), 'pending', 'no end record');
    assert.deepEqual([w.counts.walletSignatures, w.counts.walletBroadcasts, w.evidenceCreates(p), w.deliverableWrites(p)], [0, 0, 0, 0], 'the wallet signs and sends nothing');
    w.node.script.transferRead = null;
    const final = await p.claim(txHash);
    assert.equal(final.status, 'payment-evidenced', 'once the transfer reads as the original, recovery delivers');
    assertNativeDeliveredOnce(w, p);
  });
}

test('a native payment whose settlement credit is withdrawn before the wallet signs signs and sends nothing', async (t) => {
  const w = await nativePaymentWorld(t), p = await w.purchase(), other = await w.purchase(), txHash = p.pay();
  await cutBeforeWalletSignature(w, p, txHash);
  const signedAtCut = w.counts.evidenceSignatures;
  // Another job takes the transfer's settlement, so this job loses its credit.
  await w.withdrawCredit(p, other.jobId);
  const withheld = await p.claim(txHash);
  assert.notEqual(withheld.status, 'payment-evidenced');
  assert.equal(nativeStateOf(w, p), 'pending');
  assert.equal(w.counts.evidenceSignatures, signedAtCut, 'no evidence is signed');
  assert.deepEqual([w.counts.walletSignatures, w.counts.walletBroadcasts, w.evidenceCreates(p), w.deliverableWrites(p), w.deliveryEvidenceWrites(p)], [0, 0, 0, 0, 0], 'nothing is signed, sent or written');
});

test('native recovery sends the retained evidence CREATE once and delivers without a second grant', async (t) => {
  const w = await nativePaymentWorld(t), p = await w.purchase(), txHash = p.pay();
  w.faults.walletBroadcast = 1;
  const cut = await p.claim(txHash);
  assert.notEqual(cut.status, 'payment-evidenced');
  assert.equal(nativeStateOf(w, p), 'pending', 'the attempt stays open');
  assert.deepEqual([w.counts.walletSignatures, w.counts.walletBroadcasts, w.evidenceCreates(p)], [1, 1, 0], 'the evidence CREATE is signed and kept; the node has not received it');
  const granted = Object.keys(JSON.parse(readFileSync(w.receiptsFile, 'utf8')).records);
  assert.deepEqual(w.lockedJobs(), [], 'the cut attempt holds no job lock');
  await w.restart();
  const before = w.steps.length;
  const final = await p.claim(txHash);
  assert.equal(final.status, 'payment-evidenced');
  assertNativeDeliveredOnce(w, p);
  assert.equal(w.counts.walletSignatures, 1, 'recovery sends the retained bytes and signs nothing new');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(w.receiptsFile, 'utf8')).records), granted, 'no second permit is granted');
  assert.equal(w.grantedReceipts(), granted.length, 'the grant count agrees');
  // The retained CREATE's fate is read from the chain first, then it is sent once, and both happen under the job's one durable lock.
  const walletSteps = w.steps.slice(before).filter((entry) => entry.step.startsWith('wallet'));
  assert.deepEqual(walletSteps.map((entry) => entry.step), ['walletRead', 'walletBroadcast']);
  assert.ok(walletSteps.every((entry) => entry.locks.length === 1 && entry.locks[0] === p.jobId), 'the job lock is held once');
  assert.deepEqual(w.lockedJobs(), [], 'the lock is released');
});

// The sources a completed native answer is read against again: the transfer, the Deliverable and the delivery evidence.
const NATIVE_SOURCE_CELLS = [
  ['the transfer read fails', (w, txHash) => readTransferAs(w, txHash, unreadableTransfer)],
  ['the transfer cannot be found', (w, txHash) => readTransferAs(w, txHash, () => null)],
  ['the Deliverable is gone', (w) => { w.node.script.programRead = (record) => (record?.metadata.artifactKind === 'Deliverable' ? null : record); }],
  ['the delivery evidence cannot be read', (w) => { w.node.script.programRead = (record) => { if (record?.metadata.logicalAddress.startsWith('dacs4:evidence:')) throw new Error('TEST node unreachable'); return record; }; }],
];

test('a completed native payment answers the same request again from its stored outcome after its sources read the same', async (t) => {
  const w = await nativePaymentWorld(t), p = await w.purchase(), txHash = p.pay();
  const delivered = await p.claim(txHash), stored = w.wireState(p);
  assert.equal(delivered.status, 'payment-evidenced');
  const again = await p.claim(txHash);
  assert.deepEqual(again, delivered, 'the stored answer is returned unchanged');
  assert.deepEqual(w.wireState(p), stored, 'the outcome is unchanged');
  assertNativeDeliveredOnce(w, p);
});

test('a completed native payment withholds its stored answer when a source cannot be read and leaves the outcome unchanged', async (t) => {
  for (const [label, arrange] of NATIVE_SOURCE_CELLS) {
    const w = await nativePaymentWorld(t), p = await w.purchase(), txHash = p.pay();
    assert.equal((await p.claim(txHash)).status, 'payment-evidenced', label);
    const stored = w.wireState(p);
    arrange(w, txHash);
    const withheld = await p.send(txHash);
    assert.deepEqual([withheld.status, withheld.body.error], [503, 'seller_source_unavailable'], label);
    assert.deepEqual(w.wireState(p), stored, `${label}: the stored outcome is unchanged`);
    assertNativeDeliveredOnce(w, p);
  }
});

test('a completed native payment reads changed when its permit is gone or its spent permit authorizes a different rail registry version', async (t) => {
  for (const [label, change] of [
    ['the permit is gone from the receipt state', (state) => { state.records = {}; state.permits = {}; }],
    // Delivery spent the permit, so the authorization the seller reads is the one the spent record carries.
    ['the spent permit authorizes a different rail registry version', (state) => { Object.values(state.records)[0].consumed.claim.authorization.railRegistryVersion = 2; }],
  ]) {
    const w = await nativePaymentWorld(t), p = await w.purchase(), txHash = p.pay();
    assert.equal((await p.claim(txHash)).status, 'payment-evidenced', label);
    const stored = w.wireState(p);
    recordReceiptEdit(w, change);
    const withheld = await p.send(txHash);
    assert.deepEqual([withheld.status, withheld.body.error, withheld.body.cause], [503, 'seller_source_unavailable', 'changed'], label);
    assert.deepEqual(w.wireState(p), stored, `${label}: the stored outcome is unchanged`);
  }
});

test('the identical signed native payment request sent twice is refused as a replay the second time and changes nothing', async (t) => {
  const w = await nativePaymentWorld(t), p = await w.purchase(), txHash = p.pay();
  const signed = await p.sign(txHash);
  const first = await p.post(signed);
  assert.deepEqual([first.status, first.body.status], [200, 'payment-evidenced']);
  assertNativeDeliveredOnce(w, p);
  const settled = w.snapshot(p), readsBefore = w.transferReads().flat().length;
  // One receipt, one job hold and no release; each artifact is one transaction the node holds.
  assert.deepEqual([settled.receipts, settled.holds, settled.releases, settled.sources.map((hashes) => hashes.length)], [1, 1, 0, [1, 1, 1]]);
  const again = await p.post(signed);
  assert.deepEqual([again.status, again.body.error], [409, 'peer_request_replayed']);
  assert.deepEqual(w.snapshot(p), settled, 'receipts, journal bytes, sources, accounting rows, holds, releases and allocations are as they were');
  assert.equal(w.transferReads().flat().length, readsBefore, 'the replay reads nothing');
  assertNativeDeliveredOnce(w, p);
});

test('a native response signer held by the test leaves the attempt open, and a second request answers pending until it is released', async (t) => {
  const w = await nativePaymentWorld(t), p = await w.purchase(), txHash = p.pay();
  const held = w.hold('responseSignature'), signedBefore = w.counts.responseSignatures;
  const first = p.claim(txHash);
  await held.reached;
  assert.equal(w.counts.responseSignatures, signedBefore + 1, 'the seller reached its response signature');
  assert.equal(nativeStateOf(w, p), 'pending', 'the attempt is open');
  assert.ok(w.leaseUntil() > w.clock() && w.leaseUntil() - w.clock() <= w.leaseMs, 'the host lease has not ended');
  const wallBefore = w.clock(), monotonicBefore = performance.now();
  w.advance(CLOCK_STEP_MS);
  assert.deepEqual([w.clock() - wallBefore, performance.now() - monotonicBefore >= CLOCK_STEP_MS], [CLOCK_STEP_MS, true], 'the wall and monotonic clocks move together');
  const readsBefore = w.transferReads().flat().length;
  const second = await p.send(txHash, { lapse: false });
  assert.deepEqual([second.status, second.body.error], [503, 'seller_effect_pending']);
  assert.equal(w.transferReads().flat().length, readsBefore, 'the second request reads nothing');
  held.release();
  assert.equal((await first).status, 'payment-evidenced');
  assert.equal(nativeStateOf(w, p), 'completed');
  assertNativeDeliveredOnce(w, p);
});

test('a native response signer that fails after the payment is delivered leaves the attempt open, and the next request answers with no second effect', async (t) => {
  const w = await nativePaymentWorld(t), p = await w.purchase(), txHash = p.pay();
  w.faults.responseSignature = 1;
  const signedBefore = w.counts.responseSignatures;
  const cut = await p.send(txHash);
  assert.deepEqual([cut.status, cut.body.error], [503, 'operation_uncertain']);
  assert.equal(nativeStateOf(w, p), 'pending');
  assertNativeDeliveredOnce(w, p);
  assert.equal(w.counts.responseSignatures, signedBefore + 1, 'only the signature of the answer to the failure counts, not the one that failed');
  const final = await p.send(txHash);
  assert.deepEqual([final.status, final.body.status], [200, 'payment-evidenced']);
  assert.equal(nativeStateOf(w, p), 'completed');
  assertNativeDeliveredOnce(w, p);
  assert.equal(w.grantedReceipts(), 1, 'no second receipt is granted');
});

for (const [point, signatures, broadcasts, creates] of [['walletSignature', 1, 0, 0], ['walletBroadcast', 1, 1, 1]]) {
  test(`a native payment held right after its ${point} holds the job lock once and delivers one evidence CREATE when released`, async (t) => {
    const w = await nativePaymentWorld(t), p = await w.purchase(), txHash = p.pay();
    const held = w.hold(point);
    const inFlight = p.claim(txHash);
    await held.reached;
    assert.deepEqual([w.counts.walletSignatures, w.counts.walletBroadcasts, w.evidenceCreates(p), w.deliverableWrites(p)], [signatures, broadcasts, creates, 0], 'the step is counted and nothing after it has happened');
    assert.deepEqual([w.lockedJobs(), w.grantedReceipts(), nativeStateOf(w, p)], [[p.jobId], 1, 'pending']);
    held.release();
    assert.equal((await inFlight).status, 'payment-evidenced');
    assertNativeDeliveredOnce(w, p);
    assert.deepEqual([w.counts.walletBroadcasts, w.grantedReceipts(), w.lockedJobs()], [1, 1, []]);
  });
}

test('a native payment sent under a six-hour session delegation delivers once, and the delegation ends before the Agreement deadline', async (t) => {
  const w = await nativePaymentWorld(t), p = await w.purchase(), txHash = p.pay();
  assert.ok(w.clock() - T0 < CLOCK_START_SLACK_MS, 'the clock starts at the shared start time');
  const signed = await p.sign(txHash, { delegated: true });
  assert.equal(signed.delegation.payload.expiresAt, T0 + DELEGATION_MS);
  assert.ok(signed.delegation.payload.expiresAt < p.agreement.terms.deadline, 'the Agreement deadline is strictly later');
  const answer = await p.post(signed);
  assert.deepEqual([answer.status, answer.body.status], [200, 'payment-evidenced']);
  assertNativeDeliveredOnce(w, p);
});


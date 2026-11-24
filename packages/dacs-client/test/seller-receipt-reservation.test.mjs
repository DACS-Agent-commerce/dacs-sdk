// The seller receipt gate: an authenticated ordinary commit answer declares the most the buyer reserves for the purchase,
// and the buyer opens Pay only when that declaration equals its own price plus Pay and anchor fee ceilings and stays
// within its mandate cap. Every refusal counts zero native payment payloads, wallet guards and wallet signatures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { receiptWorld, osText, EXACT_SUM_OS, PRICE_OS, PAY_FEE_OS, ANCHOR_FEE_OS } from './helpers/seller-receipt-reservation-world.mjs';
import { FIXTURE_RECEIPT_LIMITS } from './helpers/wire-client-fixture.mjs';
const { OperationError, createProtocolPurchases, createSqlitePurchaseStore } = await import('../src/index.mjs');

const REFUSED = 'seller_receipt_reservation_insufficient';
const refused = (code = REFUSED) => (error) => error instanceof OperationError && error.code === code;
const NO_PAYMENT = { payloads: 0, guards: 0, signatures: 0 };
const paymentEffects = ({ effects: { payloads, guards, signatures } }) => ({ payloads, guards, signatures });
const protocolOf = (world) => world.get().state.protocol;

// The purchase committed, approved and refused at handoff: it stays approved with no coordinates, and no guard can be read.
async function assertHandoffRefused(world, label) {
  const committed = await world.commit();
  assert.equal(committed.status, 'awaiting_approval', label);
  const result = await world.approve();
  assert.equal(result.payload, null, label);
  assert.equal(result.refused, REFUSED, label);
  assert.equal(world.get().status, 'approved', label);
  assert.equal(world.coordinates(), 0, label);
  assert.ok(world.events().some((event) => event.type === 'handoff_refused' && event.data.reason === REFUSED), label);
  await assert.rejects(world.pay(), refused('native_payment_lane_held'), label);
  assert.deepEqual(paymentEffects(world), NO_PAYMENT, label);
}

test('an authenticated seller receipt at price plus Pay and anchor ceilings opens exactly one native payment request', async (t) => {
  const world = await receiptWorld(t);
  assert.equal(Object.hasOwn(protocolOf(world), 'sellerReceipt'), false);
  const committed = await world.commit();
  assert.equal(committed.status, 'awaiting_approval');
  const signed = world.signedResponses.at(-1).sellerReceipt;
  assert.deepEqual(signed, { agreementHash: world.made.agreementHash, reservedMaximumOs: osText(EXACT_SUM_OS) });
  // The receipt is saved by the same write that records the verified commitment, and by no other.
  const saved = world.get(), history = world.events();
  assert.deepEqual(saved.state.protocol.sellerReceipt, signed);
  assert.equal(saved.state.protocol.stage, 'seller-committed');
  assert.equal(saved.state.protocol.attempts.at(-1).step, 'commitment');
  assert.equal(saved.state.protocol.attempts.at(-1).outcome, 'verified');
  const verified = history.findLast((event) => event.type === 'protocol_commitment');
  assert.equal(verified.data.outcome, 'verified');
  assert.equal(history.indexOf(verified), history.findLastIndex((event) => event.type.startsWith('protocol_')));
  const handoff = await world.approve();
  assert.ok(handoff.payload, 'the handoff offers the payment payload');
  assert.equal(world.get().status, 'payment_handoff');
  assert.equal(world.coordinates(), 1);
  assert.deepEqual(await world.pay(), { hash: 'd'.repeat(64), nonce: 7 });
  assert.equal(protocolOf(world).nativePaymentLaneIssued, true);
  await assert.rejects(world.pay(), refused('native_payment_already_issued'));
  assert.deepEqual(paymentEffects(world), { payloads: 1, guards: 1, signatures: 1 });
});

test('an authenticated seller receipt short by one OS in price, Pay ceiling or anchor ceiling refuses before any payment request or signature', async (t) => {
  // Each world raises one addend by one OS and the seller still signs the prior total, so each threshold is one OS higher.
  for (const [label, raised] of [['price', { priceOs: PRICE_OS + 1n }], ['Pay ceiling', { payFeeOs: PAY_FEE_OS + 1n }], ['anchor ceiling', { anchorFeeOs: ANCHOR_FEE_OS + 1n }]]) {
    const world = await receiptWorld(t, raised);
    await assertHandoffRefused(world, label);
    assert.equal(protocolOf(world).sellerReceipt.reservedMaximumOs, osText(EXACT_SUM_OS), label);
    assert.equal(protocolOf(world).sellerReceipt.agreementHash, world.made.agreementHash, label);
  }
  // A seller cannot lower the maximum itself: one OS below the exact sum, correctly signed and bound.
  const lowered = await receiptWorld(t, { receipt: (agreementHash) => ({ agreementHash, reservedMaximumOs: osText(EXACT_SUM_OS - 1n) }) });
  await assertHandoffRefused(lowered, 'below the exact sum');
});

test('a missing, malformed or differently bound seller receipt refuses before any payment request or signature', async (t) => {
  const wrongHash = 'e'.repeat(64);
  for (const [label, receipt, kept] of [
    ['missing', () => undefined, false],
    ['canonical zero', (agreementHash) => ({ agreementHash, reservedMaximumOs: '0' }), true],
    ['leading zero', (agreementHash) => ({ agreementHash, reservedMaximumOs: `0${osText(EXACT_SUM_OS)}` }), false],
    ['plus sign', (agreementHash) => ({ agreementHash, reservedMaximumOs: `+${osText(EXACT_SUM_OS)}` }), false],
    ['minus sign', (agreementHash) => ({ agreementHash, reservedMaximumOs: `-${osText(EXACT_SUM_OS)}` }), false],
    ['not a string', (agreementHash) => ({ agreementHash, reservedMaximumOs: Number(EXACT_SUM_OS) }), false],
    ['79 digits', (agreementHash) => ({ agreementHash, reservedMaximumOs: `1${'0'.repeat(78)}` }), false],
    ['an extra member', (agreementHash) => ({ agreementHash, reservedMaximumOs: osText(EXACT_SUM_OS), note: 'TEST' }), false],
    ['wrong Agreement hash', () => ({ agreementHash: wrongHash, reservedMaximumOs: osText(EXACT_SUM_OS) }), false],
  ]) {
    const world = await receiptWorld(t, { receipt });
    await assertHandoffRefused(world, label);
    // Only a shape-valid receipt bound to this Agreement is kept; canonical zero is kept and then fails equality.
    assert.equal(Object.hasOwn(protocolOf(world), 'sellerReceipt'), kept, label);
  }
  // A replay signed for another job fails the wire check before the receipt is read.
  const otherJob = await receiptWorld(t);
  otherJob.seller.signFor = (payload) => ({ ...payload, jobId: `${payload.jobId.slice(0, -1)}0` });
  const pending = await otherJob.commit();
  assert.equal(pending.status, 'agreement_pending');
  assert.equal(pending.state.protocol.stage, 'agreement-anchored');
  assert.equal(Object.hasOwn(pending.state.protocol, 'sellerReceipt'), false);
  assert.ok(otherJob.effects.commitRequests > 0);
  assert.ok(pending.state.protocol.attempts.some((attempt) => attempt.step === 'commit-request' && attempt.causeCode === 'response-auth'));
  await assert.rejects(otherJob.prepareHandoff(), refused('invalid_state'));
  assert.deepEqual(paymentEffects(otherJob), NO_PAYMENT);
});

test('a lost ordinary commitment answer holds at agreement anchored until the retained request recovers a signed receipt', async (t) => {
  const world = await receiptWorld(t);
  world.seller.drop = true;
  const held = await world.commit();
  assert.equal(world.effects.creates, 1);
  assert.equal(held.status, 'agreement_pending');
  assert.equal(held.state.protocol.stage, 'agreement-anchored');
  assert.equal(held.state.protocol.chainReadback, undefined, 'no signed CREATE pointer was obtained');
  assert.match(held.state.protocol.attempts.at(-1).reason, /signed FinalityCommitment CREATE is not available/);
  assert.equal(Object.hasOwn(held.state.protocol, 'sellerReceipt'), false);
  await assert.rejects(world.prepareHandoff(), refused('invalid_state'));
  // The explicit retry repeats the stored commit request; the seller replays its stored answer and creates nothing new.
  world.seller.drop = false;
  const sentBefore = world.effects.commitRequests;
  const recovered = await world.retry();
  assert.equal(recovered.status, 'awaiting_approval');
  assert.ok(world.effects.commitRequests > sentBefore);
  assert.equal(world.effects.creates, 1);
  assert.deepEqual(recovered.state.protocol.sellerReceipt, world.receiptFor(osText(EXACT_SUM_OS)));
  assert.ok((await world.approve()).payload);
  await world.pay();
  assert.deepEqual(paymentEffects(world), { payloads: 1, guards: 1, signatures: 1 });

  // A verified answer that kept its signed CREATE pointer but carried no receipt: chain readback still verifies from
  // the pointer, and that observation never opens Pay. The buyer cancels and prepares a new purchase.
  const pointerOnly = await receiptWorld(t, { receipt: () => undefined });
  const committed = await pointerOnly.commit();
  assert.equal(committed.status, 'awaiting_approval');
  assert.ok(committed.state.protocol.chainReadback, 'the signed CREATE pointer is kept');
  assert.equal(Object.hasOwn(committed.state.protocol, 'sellerReceipt'), false);
  const refusal = await pointerOnly.approve();
  assert.equal(refusal.refused, REFUSED);
  assert.equal(Object.hasOwn(protocolOf(pointerOnly), 'sellerReceipt'), false, 'the chain observation does not create a receipt');
  assert.equal((await pointerOnly.prepareHandoff()).refused, REFUSED);
  assert.equal(pointerOnly.effects.creates, 1);
  assert.deepEqual(paymentEffects(pointerOnly), NO_PAYMENT);
});

test('a restart rechecks the retained receipt before handoff and before the one time wallet guard', async (t) => {
  const world = await receiptWorld(t);
  await world.commit();
  world.restart();
  assert.ok((await world.approve()).payload, 'the reloaded row hands off');
  const kept = protocolOf(world).sellerReceipt;
  world.change({ sellerReceipt: { ...kept, reservedMaximumOs: osText(EXACT_SUM_OS - 1n) } });
  world.restart();
  await assert.rejects(world.pay(), refused());
  assert.equal(protocolOf(world).nativePaymentLaneIssued ?? false, false, 'the once-only issue bit is unchanged');
  assert.deepEqual(paymentEffects(world), { payloads: 1, guards: 0, signatures: 0 });
  // A valid row issues the guard once and never again.
  world.change({ sellerReceipt: kept });
  await world.pay();
  assert.equal(protocolOf(world).nativePaymentLaneIssued, true);
  world.restart();
  await assert.rejects(world.pay(), refused('native_payment_already_issued'));
  assert.deepEqual(paymentEffects(world), { payloads: 1, guards: 1, signatures: 1 });
});

test('a stale operation cannot open Pay after the winning row changes', async (t) => {
  const world = await receiptWorld(t);
  await world.commit();
  // The handoff's first check passes on the row it loaded; the durable row changes before the coordinate transaction.
  world.hooks.beforeNonce = () => { world.change({ sellerReceipt: world.receiptFor(osText(EXACT_SUM_OS + 1n)) }); };
  await assert.rejects(world.approve(), refused());
  assert.equal(world.get().status, 'approved');
  assert.equal(world.coordinates(), 0);
  await assert.rejects(world.pay(), refused('native_payment_lane_held'));
  assert.deepEqual(paymentEffects(world), NO_PAYMENT);
});

test('missing fee ceilings refuse native payment composition and fixture only composition cannot open native Pay', async (t) => {
  const world = await receiptWorld(t);
  const options = { db: world.p.db, ops: world.p.ops, coordinates: { unresolvedForSender: () => [] }, dacsProtocol: world.p.config, admission: world.w.admission,
    buyerAccess: { assertWallet() {} }, store: createSqlitePurchaseStore() };
  const ceilings = FIXTURE_RECEIPT_LIMITS.receiptFeeCeilings, cap = FIXTURE_RECEIPT_LIMITS.buyerMandateCapOs;
  const build = (limits) => () => createProtocolPurchases({ ...options, ...limits });
  for (const receiptFeeCeilings of [undefined, null, {}, { payFeeCeilingOs: '1' }, { ...ceilings, extra: '1' }, { ...ceilings, payFeeCeilingOs: 1 },
    { ...ceilings, anchorFeeCeilingOs: '01' }, { ...ceilings, payFeeCeilingOs: '-1' }, { ...ceilings, anchorFeeCeilingOs: '9'.repeat(79) }, '1000']) {
    assert.throws(build({ receiptFeeCeilings, buyerMandateCapOs: cap }), refused('receipt_fee_ceilings_invalid'), JSON.stringify(receiptFeeCeilings));
  }
  for (const buyerMandateCapOs of [undefined, null, '', '01', '+1', '1.5', '9'.repeat(79), 100000000000]) {
    assert.throws(build({ receiptFeeCeilings: ceilings, buyerMandateCapOs }), refused('buyer_mandate_cap_invalid'), JSON.stringify(buyerMandateCapOs));
  }
  // With both invalid the ceilings are refused first, and an existing constructor check comes before either.
  assert.throws(build({ receiptFeeCeilings: null, buyerMandateCapOs: null }), refused('receipt_fee_ceilings_invalid'));
  const config = { ...world.p.config, nativePaymentEvidence: { ...world.p.config.nativePaymentEvidence, rpcOrigin: 'https://other.invalid' } };
  assert.throws(() => createProtocolPurchases({ ...options, dacsProtocol: config }), TypeError);
  assert.equal(typeof build(FIXTURE_RECEIPT_LIMITS)().assertSellerReceiptReservation, 'function');

  // A fixture-only composition (no native payment) needs no ceilings and cannot open native Pay for a receipt-bearing row.
  await world.commit();
  const { nativeAgreementPayment: _payment, nativePaymentEvidence: _evidence, sellerTransport: _transport, ...fixtureOnly } = world.p.config;
  const fixture = createProtocolPurchases({ ...options, dacsProtocol: fixtureOnly });
  assert.throws(() => fixture.assertSellerReceiptReservation(world.get()), refused());
  await assert.rejects(fixture.readNativePaymentLane(world.get(), 'TEST-wallet-key'), refused('dacs_protocol_unavailable'));
  assert.deepEqual(paymentEffects(world), NO_PAYMENT);
});

test('an authenticated seller receipt above the buyer exact sum refuses with no native payment effect', async (t) => {
  const world = await receiptWorld(t, { receipt: (agreementHash) => ({ agreementHash, reservedMaximumOs: osText(EXACT_SUM_OS + 1n) }) });
  await assertHandoffRefused(world, 'one OS above the exact sum');
  assert.throws(() => world.protocol.assertSellerReceiptReservation(world.get()), refused());
});

test('an authenticated seller receipt above the buyer mandate cap refuses with no native payment effect', async (t) => {
  const world = await receiptWorld(t, { capOs: EXACT_SUM_OS - 1n });
  await assertHandoffRefused(world, 'the exact sum one OS above the mandate cap');
  assert.deepEqual(protocolOf(world).sellerReceipt, world.receiptFor(osText(EXACT_SUM_OS)));
  assert.throws(() => world.protocol.assertSellerReceiptReservation(world.get()), refused());
});

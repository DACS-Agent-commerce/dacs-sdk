// The seller receipt gate: an authenticated ordinary commit answer declares the most the buyer reserves for the purchase,
// and the buyer opens Pay only when that declaration covers the Pay debit (price plus the chain's network fee) and stays
// within both its own price plus Pay and anchor fee ceilings and its mandate cap. Every refusal counts zero native
// payment payloads, wallet guards and wallet signatures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { receiptWorld, osText, EXACT_SUM_OS, PRICE_OS, PAY_FEE_OS, ANCHOR_FEE_OS, NETWORK_FEE_OS } from './helpers/seller-receipt-reservation-world.mjs';
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

test('an authenticated seller receipt one OS below the Pay debit of price plus network fee refuses before any payment request or signature', async (t) => {
  // The seller signs exactly the debit less one OS.
  const lowered = await receiptWorld(t, { receipt: (agreementHash) => ({ agreementHash, reservedMaximumOs: osText(PRICE_OS + NETWORK_FEE_OS - 1n) }) });
  await assertHandoffRefused(lowered, 'one OS below the debit');
  // The buyer's price is the seller's whole total, so the network fee takes the debit one OS over it.
  const raised = await receiptWorld(t, { priceOs: EXACT_SUM_OS, payFeeOs: 0n, anchorFeeOs: 0n });
  await assertHandoffRefused(raised, 'price equal to the receipt');
  assert.equal(protocolOf(raised).sellerReceipt.reservedMaximumOs, osText(EXACT_SUM_OS));
});

test('a seller receipt with smaller fee ceilings than the buyer opens exactly one native payment request when it covers the Pay debit', async (t) => {
  // The seller's ceilings differ from the buyer's: its total is exactly the price plus the network fee.
  const smaller = await receiptWorld(t, { receipt: (agreementHash) => ({ agreementHash, reservedMaximumOs: osText(PRICE_OS + NETWORK_FEE_OS) }) });
  await smaller.commit();
  assert.ok((await smaller.approve()).payload, 'the handoff offers the payment payload');
  await smaller.pay();
  assert.deepEqual(paymentEffects(smaller), { payloads: 1, guards: 1, signatures: 1 });
  // A buyer whose own ceilings are far above the seller's also pays the seller's exact total.
  const larger = await receiptWorld(t, { payFeeOs: 1000n * PAY_FEE_OS, anchorFeeOs: 1000n * ANCHOR_FEE_OS });
  await larger.commit();
  assert.ok((await larger.approve()).payload, 'the handoff offers the payment payload');
  await larger.pay();
  assert.deepEqual(paymentEffects(larger), { payloads: 1, guards: 1, signatures: 1 });
});

test('a network fee that takes the Pay debit above the seller receipt and mandate cap refuses before any payment request or signature', async (t) => {
  // One DEM price; seller and buyer share the ceilings 0.007000013 and 0.000300007 DEM; the mandate cap is the receipt.
  const oneDem = 1000000000n, payCeiling = 7000013n, anchorCeiling = 300007n, receiptTotal = oneDem + payCeiling + anchorCeiling;
  const limits = { priceOs: oneDem, payFeeOs: payCeiling, anchorFeeOs: anchorCeiling, capOs: receiptTotal,
    receipt: (agreementHash) => ({ agreementHash, reservedMaximumOs: osText(receiptTotal) }) };
  // The chain's fee for a native Pay: the wallet's 1 DEM gas plus 1 DEM network and 1 DEM RPC fee.
  const live = await receiptWorld(t, limits);
  live.hooks.networkFee = async () => 3n * oneDem;
  await assertHandoffRefused(live, 'live network fee');
  // The fee that fills the receipt exactly still opens Pay; one OS more refuses.
  const exact = await receiptWorld(t, limits);
  exact.hooks.networkFee = async () => payCeiling + anchorCeiling;
  await exact.commit();
  assert.ok((await exact.approve()).payload, 'a debit equal to the receipt is handed off');
  const over = await receiptWorld(t, limits);
  over.hooks.networkFee = async () => payCeiling + anchorCeiling + 1n;
  await assertHandoffRefused(over, 'one OS over the receipt');
});

test('a network fee that rises above the seller receipt after handoff refuses the one time wallet guard', async (t) => {
  const world = await receiptWorld(t);
  await world.commit();
  assert.ok((await world.approve()).payload, 'the handoff offers the payment payload');
  world.hooks.networkFee = async () => PAY_FEE_OS + ANCHOR_FEE_OS + 1n;
  await assert.rejects(world.pay(), refused());
  assert.equal(protocolOf(world).nativePaymentLaneIssued ?? false, false, 'the once-only issue bit is unchanged');
  assert.deepEqual(paymentEffects(world), { payloads: 1, guards: 0, signatures: 0 });
  // Once the fee is back within the receipt, the guard is issued once.
  world.hooks.networkFee = async () => NETWORK_FEE_OS;
  await world.pay();
  assert.deepEqual(paymentEffects(world), { payloads: 1, guards: 1, signatures: 1 });
});

test('a network fee read that fails at the wallet guard leaves the guard unissued and keeps the read error', async (t) => {
  const world = await receiptWorld(t);
  await world.commit();
  assert.ok((await world.approve()).payload, 'the handoff offers the payment payload');
  const cause = new Error('TEST fee read timed out');
  world.hooks.networkFee = async () => { throw cause; };
  await assert.rejects(world.pay(), (error) => refused('write-fee-cap')(error) && error.cause === cause);
  assert.equal(protocolOf(world).nativePaymentLaneIssued ?? false, false, 'the once-only issue bit is unchanged');
  assert.deepEqual(paymentEffects(world), { payloads: 1, guards: 0, signatures: 0 });
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
  world.change({ sellerReceipt: { ...kept, reservedMaximumOs: osText(PRICE_OS) } });
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
    buyerAccess: { assertWallet() {} }, store: createSqlitePurchaseStore(), feeCeilingOs: '50000000000', chain: { getTransactionFees: async () => 1n } };
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
  const nativeOnly = new Set(['nativeAgreementPayment', 'nativePaymentEvidence', 'sellerTransport']);
  const fixtureOnly = Object.fromEntries(Object.entries(world.p.config).filter(([name]) => !nativeOnly.has(name)));
  const fixture = createProtocolPurchases({ ...options, dacsProtocol: fixtureOnly });
  assert.throws(() => fixture.assertSellerReceiptReservation(world.get(), NETWORK_FEE_OS), refused());
  await assert.rejects(fixture.readNativePaymentLane(world.get(), 'TEST-wallet-key'), refused('dacs_protocol_unavailable'));
  assert.deepEqual(paymentEffects(world), NO_PAYMENT);
});

test('an authenticated seller receipt above the buyer price plus both fee ceilings refuses with no native payment effect', async (t) => {
  const world = await receiptWorld(t, { receipt: (agreementHash) => ({ agreementHash, reservedMaximumOs: osText(EXACT_SUM_OS + 1n) }) });
  await assertHandoffRefused(world, 'one OS above the exact sum');
  assert.throws(() => world.protocol.assertSellerReceiptReservation(world.get(), NETWORK_FEE_OS), refused());
});

test('an authenticated seller receipt above the buyer mandate cap refuses with no native payment effect', async (t) => {
  const world = await receiptWorld(t, { capOs: EXACT_SUM_OS - 1n });
  await assertHandoffRefused(world, 'the exact sum one OS above the mandate cap');
  assert.deepEqual(protocolOf(world).sellerReceipt, world.receiptFor(osText(EXACT_SUM_OS)));
  assert.throws(() => world.protocol.assertSellerReceiptReservation(world.get(), NETWORK_FEE_OS), refused());
});

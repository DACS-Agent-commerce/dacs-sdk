// Ordinary lifecycle coverage for the native Agreement payment consumer that
// test/native-agreement-payment.test.mjs does not already exercise. Reuses the
// unchanged loopback flow/harness; no seller writer state or authority planted.
// Expectations are derived from src/purchases.mjs (approve/prepareHandoff/
// expireIfNeeded/nativePaymentLane) and src/dacs/protocol-purchases.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { finalityCommitmentAddress } from '@kynesyslabs/dacs';
import { nativePaymentFlow } from './helpers/native-agreement-payment-flow.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';
import { tokenFrom } from './helpers/flows.mjs';
import { nativeRepeatBuyer } from './helpers/review-native-payment-coverage-flow.mjs';
import { DEMOS_SR2_FIXTURE_CHAIN_IDENTITY } from '../src/dacs/demos-sr2-adapter.mjs';
installLoopbackOnlyGuard();

const nativeApprovals = (w) => w.approvals.filter((r) => r.content?.action === 'native DEM transfer').map((r) => r.content);

test('late unavailable commitment after challenge: signed approval is consumed, handoff refused with nothing issued; recovered handoff issues once and pays nonce2', async (t) => {
  const w = await nativePaymentFlow(t);
  assert.equal((await w.agreement()).status, 'awaiting_approval');
  const challenge = await w.api('challenge', { address: w.address }); assert.equal(challenge.httpStatus, 200, JSON.stringify(challenge));
  w.h.anchors.faults.unavailable = true;
  const signature = await w.sign(challenge.message);
  const refused = await w.api('approve', { challengeId: challenge.challengeId, signature });
  assert.equal(refused.httpStatus, 200, JSON.stringify(refused)); assert.equal(refused.status, 'approved'); assert.equal(refused.payload, null);
  assert.equal(w.op().status, 'approved'); assert.equal(w.h.chain.record.broadcasts.length, 0); assert.equal(w.h.chain.record.confirms.length, 0);
  assert.equal((await w.api('approve', { challengeId: challenge.challengeId, signature })).error, 'invalid_state', 'approval is one-time');
  assert.equal((await w.api('handoff')).payload, null, 'still unavailable: nothing issued'); assert.equal(w.op().status, 'approved');
  w.h.anchors.faults.unavailable = false;
  await w.h.restart(); await w.seller.restart();
  const handoff = await w.api('handoff');
  assert.equal(handoff.status, 'payment_handoff', JSON.stringify(handoff)); assert.equal(handoff.payload.content.nonce, 2);
  assert.equal(handoff.payload.content.to, w.seller.wallet.address); assert.equal(String(handoff.payload.content.amount), '2500000000');
  assert.equal((await w.api('handoff')).payload, null, 'one-time delivery');
  const sent = await w.send(handoff.payload); assert.equal(sent.success, true, JSON.stringify(sent));
  const tx = w.h.chain.record.accepted[0];
  const result = await w.api('report', { txHash: tx.hash });
  assert.equal(result.status, 'settled_verified', JSON.stringify(result)); assert.equal(result.evidence.protocol.stage, 'payment-observed');
  assert.equal(result.evidence.receipt.attribution, 'tuple-only'); assert.equal(result.evidence.receipt.finality, 'not-established');
  const approvals = nativeApprovals(w); assert.equal(approvals.length, 1);
  assert.deepEqual([approvals[0].amountOs, approvals[0].nonce, approvals[0].debit.totalOs], ['2500000000', 2, '8500000000']);
  assert.equal(w.h.chain.record.broadcasts.length, 1); assert.equal(w.h.chain.wire.record.accepted.length, 1);
  assert.equal((await w.api('completion/request')).error, 'native_completion_held');
  assert.deepEqual(w.seller.anchorWrites, [finalityCommitmentAddress(w.op().terms.protocol.jobId)]);
});

test('late unavailable commitment at the wallet lane read: guard not consumed, nothing broadcast; wallet error retained conservatively across restart', async (t) => {
  const w = await nativePaymentFlow(t); await w.agreement();
  const { handoff } = await w.approve(); assert.equal(handoff.status, 'payment_handoff', JSON.stringify(handoff));
  w.h.anchors.faults.unavailable = true;
  const sent = await w.send(handoff.payload);
  assert.notEqual(sent.success, true, JSON.stringify(sent));
  assert.equal(w.h.chain.record.broadcasts.length, 0); assert.equal(w.h.chain.record.confirms.length, 0); assert.equal(w.h.chain.record.accepted.length, 0);
  assert.ok(!w.op().state.protocol.nativePaymentLaneIssued, 'guard only consumed after a verified read');
  w.h.anchors.faults.unavailable = false;
  assert.equal((await w.api('report', { walletError: String(sent.error?.message ?? 'wallet error') })).status, 'payment_uncertain');
  await w.h.restart();
  assert.equal(w.op().status, 'payment_uncertain');
  assert.equal((await w.api('handoff')).error, 'invalid_state'); assert.equal((await w.prepare()).error, 'unresolved_payment');
  assert.equal(w.h.chain.record.broadcasts.length, 0);
});

test('approval expiry at waits: elapsed after challenge refuses approve (expired, nothing issued); elapsed after handoff keeps payment_handoff readback-only', async (t) => {
  let elapsed = 0; const now = () => Date.now() + elapsed;
  const waiting = await nativePaymentFlow(t, { now }); await waiting.agreement();
  const challenge = await waiting.api('challenge', { address: waiting.address }); assert.equal(challenge.httpStatus, 200);
  const signature = await waiting.sign(challenge.message);
  elapsed += 31 * 60 * 1000;
  assert.equal((await waiting.api('approve', { challengeId: challenge.challengeId, signature })).error, 'invalid_state');
  assert.equal(waiting.op().status, 'expired'); assert.equal(waiting.h.chain.record.broadcasts.length, 0); assert.equal(nativeApprovals(waiting).length, 0);

  elapsed = 0;
  const issued = await nativePaymentFlow(t, { now }); await issued.agreement();
  const { handoff } = await issued.approve(); assert.equal(handoff.status, 'payment_handoff', JSON.stringify(handoff));
  elapsed += 31 * 60 * 1000;
  assert.equal((await issued.api('handoff')).payload, null); assert.equal(issued.op().status, 'payment_handoff', 'an issued handoff never expires silently');
  await issued.h.restart();
  assert.equal(issued.op().status, 'payment_handoff'); assert.equal((await issued.api('handoff')).payload, null);
  assert.equal(issued.h.chain.record.broadcasts.length, 0);
});

test('separate operation/job/Listing context: a second prepared purchase keeps its own job and is untouched by the first native payment', async (t) => {
  // A second purchase is prepared while the first is unpaid: two unpaid slots.
  const w = await nativePaymentFlow(t, { maxUnpaid: '2' }); await w.agreement();
  const other = await w.prepare(); assert.equal(other.status, 'agreement_pending', JSON.stringify(other));
  assert.notEqual(other.operationId, w.id); assert.notEqual(tokenFrom(other.approvalUrl), w.token);
  const account = w.h.app.services.accounts.walletOwner(w.address), otherOp = () => w.h.app.services.ops.get(account, other.operationId);
  assert.notEqual(otherOp().terms.protocol.jobId, w.op().terms.protocol.jobId);
  assert.equal(otherOp().terms.listing.listingId, w.op().terms.listing.listingId);
  const { handoff } = await w.approve(); assert.equal(handoff.status, 'payment_handoff', JSON.stringify(handoff));
  const sent = await w.send(handoff.payload); assert.equal(sent.success, true, JSON.stringify(sent));
  assert.equal((await w.api('report', { txHash: w.h.chain.record.accepted[0].hash })).status, 'settled_verified');
  await w.h.restart();
  assert.equal(otherOp().status, 'agreement_pending'); assert.equal(otherOp().state.protocol.commitment, undefined);
  assert.ok(!otherOp().state.protocol.nativePaymentLaneIssued);
  assert.deepEqual(w.seller.anchorWrites, [finalityCommitmentAddress(w.op().terms.protocol.jobId)]);
  assert.equal(w.h.chain.record.broadcasts.length, 1); assert.equal(nativeApprovals(w).length, 1);
});

test('missing versus applied ACK: unreported handoff reads not-broadcast; lost ACK after apply needs the hash, then the retained tuple reads back after restart without resend', async (t) => {
  const w = await nativePaymentFlow(t); await w.agreement();
  const { handoff } = await w.approve(); assert.equal(handoff.status, 'payment_handoff', JSON.stringify(handoff));
  assert.equal((await w.verify()).status, 'payment_handoff', 'nonce unchanged: missing ACK, nothing applied');
  w.h.chain.paymentFaults.payment = 'drop-after-apply';
  const sent = await w.send(handoff.payload); assert.equal(sent.error.code, 'outcome_unknown');
  await w.h.restart();
  assert.equal((await w.verify()).status, 'payment_uncertain', 'nonce advanced without a reported hash');
  assert.equal((await w.api('handoff')).error, 'invalid_state'); assert.equal((await w.prepare()).error, 'unresolved_payment');
  const applied = await w.verify(w.h.chain.record.accepted[0].hash);
  assert.equal(applied.status, 'settled_verified', JSON.stringify(applied)); assert.equal(applied.protocol.stage, 'payment-observed');
  await w.seller.restart(); await w.h.restart();
  assert.equal((await w.verify()).status, 'settled_verified'); assert.equal((await w.api('completion/request')).error, 'native_completion_held');
  assert.equal(w.h.chain.record.broadcasts.length, 1); assert.equal(w.h.chain.record.accepted.length, 1); assert.equal(nativeApprovals(w).length, 1);
});

test('native capability restarts: NEW native terms are held while the capability is off, before and after handoff; nothing is issued or broadcast', async (t) => {
  const w = await nativePaymentFlow(t); await w.agreement();
  await w.h.restart({ enabled: false });
  assert.equal((await w.api('challenge', { address: w.address })).error, 'dacs_protocol_unavailable'); assert.equal(w.op().status, 'awaiting_approval');
  await w.h.restart({ enabled: true });
  const { handoff } = await w.approve(); assert.equal(handoff.status, 'payment_handoff', JSON.stringify(handoff)); assert.equal(handoff.payload.content.nonce, 2);
  await w.h.restart({ enabled: false });
  assert.equal((await w.api('handoff')).error, 'dacs_protocol_unavailable');
  const sent = await w.send(handoff.payload); assert.notEqual(sent.success, true, JSON.stringify(sent));
  assert.equal(w.h.chain.record.broadcasts.length, 0); assert.equal(w.h.chain.record.confirms.length, 0);
  assert.ok(!w.op().state.protocol.nativePaymentLaneIssued);
  await w.h.restart({ enabled: true });
  assert.equal(w.op().status, 'payment_handoff'); assert.equal((await w.api('handoff')).payload, null, 'never reissued');
  assert.equal((await w.verify()).status, 'payment_handoff'); assert.equal(w.h.chain.record.broadcasts.length, 0);
});

test('shared CREATE/native lane after resolution: the same buyer\'s next purchase CREATEs at nonce3 and pays at nonce4 after the first native payment settled', async (t) => {
  const b = await nativeRepeatBuyer(t);
  const lane = () => b.h.journal.get(`sr2/wallet/${JSON.stringify([b.h.config.chain.network, DEMOS_SR2_FIXTURE_CHAIN_IDENTITY, b.address])}`);
  const node = async (message, data) => {
    const r = await fetch(b.h.chain.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'nodeCall', params: [{ message, data }] }) });
    assert.equal(r.status, 200); assert.equal(r.headers.get('x-dacs-simulation'), 'fixture');
    const result = await r.json(); assert.equal(result.result, 200); return result.response;
  };
  const first = await b.purchase('first');
  const a1 = await first.agreement(); assert.equal(a1.delivered.state, 'completed'); assert.equal(a1.verified.status, 'awaiting_approval', JSON.stringify(a1.verified));
  const firstAnchor = structuredClone(first.op().state.protocol.agreement.anchorReceipt);
  assert.equal(firstAnchor.transactionRef.value, b.h.chain.wire.record.accepted[0].hash);
  assert.equal((await lane()).nonce, 1);
  const h1 = await first.approve(); assert.equal(h1.status, 'payment_handoff', JSON.stringify(h1)); assert.equal(h1.payload.content.nonce, 2);
  assert.equal((await first.send(h1.payload)).success, true);
  const firstPayment = await first.api('report', { txHash: b.h.chain.record.accepted[0].hash });
  assert.equal(firstPayment.status, 'settled_verified');
  assert.equal(firstPayment.evidence.receipt.txHash, b.h.chain.record.accepted[0].hash);
  assert.equal(firstPayment.evidence.receipt.blockNumber, 2);
  await b.h.restart();
  assert.deepEqual(first.op().state.protocol.agreement.anchorReceipt, firstAnchor);
  const second = await b.purchase('second'); assert.equal(second.prepared.status, 'agreement_pending', JSON.stringify(second.prepared));
  assert.notEqual(second.op().terms.protocol.jobId, first.op().terms.protocol.jobId);
  const a2 = await second.agreement(); assert.equal(a2.delivered.state, 'completed', JSON.stringify(a2.delivered));
  // Independent HTTP readback: the earlier payment cannot shadow CREATE2.
  const create2 = b.h.chain.wire.record.accepted[1], payment = b.h.chain.record.accepted[0];
  const createBlock = (await node('getTxByHash', { hash: create2.hash })).blockNumber, paymentBlock = (await node('getTxByHash', { hash: payment.hash })).blockNumber;
  const servedBlock = (await node('getBlockByNumber', { blockNumber: createBlock })).content.ordered_transactions;
  t.diagnostic(JSON.stringify({ createNonce: (await lane()).nonce, createBlock, paymentBlock, servedBlock, create2: create2.hash, payment: payment.hash, status: a2.verified.status, reason: a2.verified.protocol?.lastAttempt?.reason }));
  assert.equal(a2.verified.status, 'awaiting_approval', JSON.stringify(a2.verified));
  assert.equal(createBlock, 3); assert.equal(paymentBlock, 2); assert.deepEqual(servedBlock, [create2.hash]);
  const secondAnchor = structuredClone(second.op().state.protocol.agreement.anchorReceipt);
  assert.equal(secondAnchor.transactionRef.value, create2.hash);
  assert.equal((await lane()).nonce, 3, 'next CREATE follows the native payment nonce');
  const h2 = await second.approve(); assert.equal(h2.status, 'payment_handoff', JSON.stringify(h2)); assert.equal(h2.payload.content.nonce, 4);
  assert.equal((await second.send(h2.payload)).success, true);
  const secondPayment = await second.api('report', { txHash: b.h.chain.record.accepted[1].hash });
  assert.equal(secondPayment.status, 'settled_verified');
  assert.equal(secondPayment.evidence.receipt.txHash, b.h.chain.record.accepted[1].hash);
  assert.equal(secondPayment.evidence.receipt.blockNumber, 4);
  assert.equal((await first.verify()).status, 'settled_verified'); assert.equal(b.h.chain.record.broadcasts.length, 2);
  assert.deepEqual(b.seller.anchorWrites, [finalityCommitmentAddress(first.op().terms.protocol.jobId), finalityCommitmentAddress(second.op().terms.protocol.jobId)]);
  assert.equal(b.approvals.filter((r) => r.content?.action === 'native DEM transfer').length, 2);
  const transactions = [b.h.chain.wire.record.accepted[0], payment, create2, b.h.chain.record.accepted[1]];
  assert.equal(new Set(transactions.map((tx) => tx.hash)).size, 4);
  const snapshots = [];
  for (const [i, tx] of transactions.entries()) {
    const observed = await node('getTxByHash', { hash: tx.hash });
    assert.equal(observed.hash, tx.hash); assert.equal(observed.blockNumber, i + 1);
    assert.equal(observed.content.nonce, String(i + 1), 'realistic RPC nonce normalization retained');
    const block = await node('getBlockByNumber', { blockNumber: i + 1 });
    assert.equal(block.number, i + 1); assert.equal(block.status, 'confirmed'); assert.match(block.hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(block.content.ordered_transactions, [tx.hash]);
    snapshots.push({ observed, block });
  }
  assert.equal(new Set(snapshots.map((s) => s.block.hash)).size, 4);
  await b.seller.restart(); await b.h.restart();
  assert.equal((await first.verify()).status, 'settled_verified'); assert.equal((await second.verify()).status, 'settled_verified');
  for (const [purchase, reported] of [[first, firstPayment], [second, secondPayment]]) {
    const retained = b.h.app.services.purchases.portalEvidence(purchase.op()).receipt;
    for (const key of ['txHash', 'blockNumber', 'amountOs', 'chainMode', 'attribution', 'finality', 'commitmentOnChain']) assert.deepEqual(retained[key], reported.evidence.receipt[key], `retained payment receipt ${key}`);
    assert.equal((await purchase.api('completion/request')).error, 'native_completion_held');
  }
  assert.deepEqual(first.op().state.protocol.agreement.anchorReceipt, firstAnchor);
  assert.deepEqual(second.op().state.protocol.agreement.anchorReceipt, secondAnchor);
  for (const [i, tx] of transactions.entries()) {
    assert.deepEqual(await node('getTxByHash', { hash: tx.hash }), snapshots[i].observed);
    assert.deepEqual(await node('getBlockByNumber', { blockNumber: i + 1 }), snapshots[i].block);
    if (tx.content.type === 'native') assert.deepEqual(await node('getTransactionStatus', { hash: tx.hash }), { state: 'included', blockNumber: i + 1 });
  }
  assert.equal(b.h.chain.wire.record.accepted.length, 2); assert.equal(b.h.chain.record.broadcasts.length, 2);
  assert.equal(b.approvals.filter((r) => r.content?.action === 'native DEM transfer').length, 2, 'restart readback requests no new wallet approval');
  t.diagnostic(JSON.stringify({ nonces: transactions.map((tx) => tx.content.nonce), blocks: snapshots.map((s) => s.block.number), hashes: transactions.map((tx) => tx.hash), blockHashes: snapshots.map((s) => s.block.hash), appRestarts: b.h.restarts(), sellerRestarts: b.seller.restarts(), nativeBroadcasts: b.h.chain.record.broadcasts.length, receiptReadback: 'stable after app+seller restart; owned chain fixture remains running' }));
});

test('control without native payment: the same buyer\'s second CREATE at nonce2 verifies while the first purchase awaits approval', async (t) => {
  const b = await nativeRepeatBuyer(t);
  const lane = () => b.h.journal.get(`sr2/wallet/${JSON.stringify([b.h.config.chain.network, DEMOS_SR2_FIXTURE_CHAIN_IDENTITY, b.address])}`);
  const first = await b.purchase('first');
  const a1 = await first.agreement(); assert.equal(a1.verified.status, 'awaiting_approval', JSON.stringify(a1.verified));
  const second = await b.purchase('second'); assert.equal(second.prepared.status, 'agreement_pending', JSON.stringify(second.prepared));
  const a2 = await second.agreement(); assert.equal(a2.delivered.state, 'completed', JSON.stringify(a2.delivered));
  assert.equal((await lane()).nonce, 2);
  assert.equal(a2.verified.status, 'awaiting_approval', JSON.stringify(a2.verified));
  assert.equal(b.h.chain.record.broadcasts.length, 0);
});

test('native coverage connects only to owned loopback', () => assert.deepEqual(externalAttempts, []));

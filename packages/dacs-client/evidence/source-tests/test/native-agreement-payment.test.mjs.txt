import test from 'node:test';
import assert from 'node:assert/strict';
import { contentHash, finalityCommitmentAddress } from '@kynesyslabs/dacs';
import { nativePaymentFlow } from './helpers/native-agreement-payment-flow.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';
import { NATIVE_AGREEMENT_PAYMENT } from '../src/dacs/native-agreement-payment-consumer.mjs';
import { approvalBinding } from '../src/purchases.mjs';
import { tool } from './helpers/flows.mjs';
installLoopbackOnlyGuard();

test('native accepting actual MCP/portal: one approved CREATE -> independently read fixture commitment -> normal signed approval -> SDK native send nonce2 -> retained tuple-only receipt/restart, no claims or resend', async (t) => {
  const w = await nativePaymentFlow(t);
  assert.equal(w.op().terms.protocol.nativePayment, NATIVE_AGREEMENT_PAYMENT);
  assert.equal(w.op().termsHash, contentHash(w.op().terms));
  const committed = await w.agreement();
  assert.equal(committed.status, 'awaiting_approval', JSON.stringify(committed)); assert.equal(committed.protocol.stage, 'seller-committed');
  const p = w.op().state.protocol;
  assert.equal(p.commitment.contentHash, contentHash(w.h.anchors.records.get(finalityCommitmentAddress(w.op().terms.protocol.jobId)).artifact));
  assert.equal(p.commitment.signer, w.seller.wallet.claim);
  const { challenge, handoff } = await w.approve();
  for (const [key, value] of Object.entries(approvalBinding(w.op()))) assert.ok(challenge.message.includes(`${key}: ${value}`), `signed approval binds ${key}`);
  assert.equal(handoff.status, 'payment_handoff', JSON.stringify(handoff)); assert.equal(handoff.payload.content.nonce, 2); assert.equal(handoff.payload.content.to, w.seller.wallet.address); assert.equal(String(handoff.payload.content.amount), '2500000000');
  assert.equal((await w.api('handoff')).payload, null, 'delivery cannot be reissued before send');
  await w.h.restart(); assert.equal((await w.api('handoff')).payload, null, 'durable one-time handoff after restart');
  const sent = await w.send(handoff.payload); assert.equal(sent.success, true, JSON.stringify(sent));
  const tx = w.h.chain.record.accepted[0];
  const result = await w.api('report', { txHash: tx.hash });
  assert.equal(result.status, 'settled_verified', JSON.stringify(result)); assert.equal(result.evidence.protocol.stage, 'payment-observed');
  assert.equal(result.evidence.receipt.finality, 'not-established'); assert.equal(result.evidence.receipt.attribution, 'tuple-only'); assert.equal(result.evidence.receipt.commitmentOnChain, false);
  const approval = w.approvals.find((r) => r.content?.action === 'native DEM transfer').content;
  assert.deepEqual([approval.amountOs, approval.nonce, approval.debit.totalOs, approval.debit.sdkGasDem, approval.debit.networkFeeDem, approval.debit.rpcFeeDem], ['2500000000', 2, '8500000000', '1', '2', '3']);
  assert.equal(w.op().state.protocol.nativePaymentLaneIssued, true);
  await w.seller.restart(); await w.h.restart();
  const resumed = await w.verify(); assert.equal(resumed.status, 'settled_verified'); assert.equal(resumed.protocol.stage, 'payment-observed');
  assert.equal((await w.api('completion/request')).error, 'native_completion_held');
  assert.deepEqual(w.seller.anchorWrites, [finalityCommitmentAddress(w.op().terms.protocol.jobId)]);
  assert.equal(w.h.chain.wire.record.accepted.length, 1); assert.equal(w.h.chain.record.accepted.length, 1); assert.equal(w.h.chain.record.broadcasts.length, 1); assert.deepEqual(w.h.chain.record.auth, [true, true]);
  assert.ok(!w.seller.requests.includes('/dacs/v1/payments')); assert.equal(resumed.protocol.layers.dacsPurchase, 'not-evidenced');
  t.diagnostic(JSON.stringify({ createHash: p.agreement.anchorReceipt.transactionRef.value, paymentHash: tx.hash, commitmentHash: p.commitment.contentHash, nonce: 2, totalDebitOs: '8500000000', creates: 1, nativeBroadcasts: 1, appRestarts: w.h.restarts(), sellerRestarts: w.seller.restarts(), stage: resumed.protocol.stage, evidence: 'SIMULATED single-rpc tuple only' }));
});

test('unknown applied native outcome: actual SDK error carries hash; persisted pointer reads back, restart never resends', async (t) => {
  const w = await nativePaymentFlow(t); await w.agreement(); const { handoff } = await w.approve();
  w.h.chain.paymentFaults.payment = 'drop-after-apply';
  const result = await w.send(handoff.payload); assert.equal(result.error.code, 'outcome_unknown');
  const reported = await w.api('report', { walletError: result.error.message, txHash: result.data.hash });
  assert.equal(reported.status, 'settled_verified', JSON.stringify(reported));
  await w.h.restart(); assert.equal((await w.verify()).status, 'settled_verified'); assert.equal(w.h.chain.record.broadcasts.length, 1);
});

test('unknown unapplied native outcome holds shared wallet lane across restart; no repeated handoff/cancel/new CREATE', async (t) => {
  const w = await nativePaymentFlow(t); await w.agreement(); const { handoff } = await w.approve();
  w.h.chain.paymentFaults.payment = 'drop-before-apply'; const sent = await w.send(handoff.payload); assert.equal(sent.error.code, 'outcome_unknown');
  const reported = await w.api('report', { walletError: sent.error.message, txHash: sent.data.hash });
  assert.equal(reported.status, 'broadcast_reported'); assert.equal(reported.verification.outcome, 'awaiting_inclusion');
  await w.h.restart(); assert.equal((await w.verify()).status, 'broadcast_reported');
  assert.equal((await w.api('handoff')).error, 'invalid_state'); assert.equal((await w.prepare()).error, 'unresolved_payment');
  assert.equal(w.h.chain.record.broadcasts.length, 1); assert.equal(w.h.chain.record.accepted.length, 0);
});

test('native transfer wallet rejection sends nothing and one-time issued delivery stays unknown/readback-only', async (t) => {
  const w = await nativePaymentFlow(t); await w.agreement(); const { handoff } = await w.approve(); w.allowPayment(false);
  const result = await w.send(handoff.payload); assert.equal(result.error.code, 'user_rejected');
  assert.equal((await w.api('report', { walletError: result.error.message })).status, 'payment_uncertain');
  await w.h.restart(); assert.equal((await w.api('handoff')).error, 'invalid_state'); assert.equal((await w.prepare()).error, 'unresolved_payment');
  assert.equal(w.h.chain.record.broadcasts.length, 0); assert.equal(w.h.chain.record.confirms.length, 0);
});

test('native wallet guard delivery is durable and once-only even when a cached payload exists and the node has applied nothing', async (t) => {
  const w = await nativePaymentFlow(t); await w.agreement(); const { handoff } = await w.approve(); w.allowPayment(false);
  assert.equal((await w.send(handoff.payload)).error.code, 'user_rejected');
  await w.h.restart();
  assert.equal((await w.api('native-payment/lane', { key: JSON.stringify([w.op().terms.network, '834375ad6381d9eedbaea18bfe841416fe680e00fa74b09ab711fde45d08e8e2', w.address]) })).error, 'native_payment_already_issued');
  assert.equal((await w.api('handoff')).payload, null); assert.equal(w.h.chain.record.broadcasts.length, 0);
});

test('existing queued CREATE fences payment; a preprepared unissued CREATE cannot consume the payment nonce after handoff', async (t) => {
  // Each flow prepares a second purchase while the first is unpaid: two unpaid slots.
  const queued = await nativePaymentFlow(t, { maxUnpaid: '2' }); await queued.agreement(); const other = await queued.otherDraft();
  assert.equal((await other.submit()).httpStatus, 200);
  const held = await queued.approve(); assert.equal(held.handoff.error, 'wallet_fenced'); assert.equal(queued.h.chain.record.broadcasts.length, 0);
  const issued = await nativePaymentFlow(t, { maxUnpaid: '2' }); await issued.agreement(); const draft = await issued.otherDraft();
  assert.equal((await issued.approve()).handoff.status, 'payment_handoff');
  assert.equal((await draft.submit()).error, 'unresolved_payment'); assert.equal(issued.h.chain.wire.record.broadcastAttempts.length, 1);
});

test('normal approval cannot precede verified commitment; consent booleans do not approve; fresh unavailable readback issues nothing', async (t) => {
  const w = await nativePaymentFlow(t);
  assert.equal((await w.api('challenge', { address: w.address })).error, 'invalid_state');
  assert.equal((await w.api('approve', { approved: true })).error, 'invalid_state');
  await w.agreement(); assert.equal((await w.api('approve', { approved: true })).httpStatus, 400);
  const challenge = await w.api('challenge', { address: w.address });
  const changed = challenge.message.replace('amount-os: 2500000000', 'amount-os: 3500000000'); assert.notEqual(changed, challenge.message);
  assert.equal((await w.api('approve', { challengeId: challenge.challengeId, signature: await w.sign(changed) })).httpStatus, 400);
  assert.equal(w.op().status, 'awaiting_approval');
  w.h.anchors.faults.unavailable = true;
  assert.equal((await w.api('challenge', { address: w.address })).error, 'commitment_unverified');
  w.h.anchors.faults.unavailable = false;
  w.h.chain.faults.unavailable = true;
  assert.notEqual((await w.api('challenge', { address: w.address })).httpStatus, 200);
  w.h.chain.faults.unavailable = false;
  const ready = await w.approve(); assert.equal(ready.handoff.status, 'payment_handoff'); assert.equal(w.h.chain.record.broadcasts.length, 0);
});

test('old prepared Agreement-only remains held after opt-in restart; expiry refuses normal payment without a native send', async (t) => {
  const old = await nativePaymentFlow(t, { enabled: false }); await old.agreement(); assert.equal(old.op().terms.protocol.nativePayment, undefined);
  await old.h.restart({ enabled: true }); assert.equal((await old.api('challenge', { address: old.address })).error, 'agreement_payment_held'); assert.equal((await old.api('handoff')).error, 'agreement_payment_held');
  let elapsed = 0; const expiring = await nativePaymentFlow(t, { now: () => Date.now() + elapsed }); await expiring.agreement(); elapsed += 31 * 60 * 1000;
  assert.equal((await expiring.api('challenge', { address: expiring.address })).error, 'invalid_state'); assert.equal(expiring.op().status, 'expired'); assert.equal(expiring.h.chain.record.broadcasts.length, 0);
});

test('native payment tests connect only to owned loopback', () => assert.deepEqual(externalAttempts, []));

for (const resolution of ['nonce-proof cancel', 'advanced nonce', 'late confirmed read']) {
  test(`canonical failed native payment: ${resolution}`, async (t) => {
    const w = await nativePaymentFlow(t, { durableSeller: false });
    await w.agreement(); const { handoff } = await w.approve();
    w.h.chain.paymentFaults.payment = 'fail-execution';
    const sent = await w.send(handoff.payload); assert.equal(sent.success, true, JSON.stringify(sent));
    const hash = w.h.chain.record.accepted[0].hash;
    const failed = await w.verify(hash);
    assert.equal(w.op().state.protocol.nativePaymentLaneIssued, true, 'the once-only wallet guard was delivered');
    assert.equal(failed.status, 'payment_uncertain'); assert.equal(failed.verification.outcome, 'execution_failed');
    assert.equal(failed.verification.txStatus, 'failed'); assert.equal(failed.verification.slotConsumed, false);
    assert.match(failed.verification.rejectedReason, /execution failed/);
    const saved = w.h.app.services.coordinates.get(w.id);
    assert.equal(saved.verifiedAt, null); assert.equal(saved.observation.slotConsumed, false);
    assert.equal((await w.prepare()).error, 'unresolved_payment');
    if (resolution === 'advanced nonce') w.h.chain.wire.setNonce(w.address, saved.expectedNonce);
    await w.h.restart();
    const cancel = () => tool(w.h, w.buyer, 'cancel_wallet_handoff', { operationId: w.id });
    const cancelled = await cancel();
    if (resolution === 'advanced nonce') {
      assert.equal(cancelled.cancelled, false); assert.equal(cancelled.status, 'payment_uncertain');
      assert.match(w.h.app.services.ops.history(w.id).at(-1).data.reason, /nonce advanced/);
      assert.equal((await w.prepare()).error, 'unresolved_payment');
    } else {
      assert.equal(cancelled.cancelled, true); assert.equal(cancelled.status, 'cancelled');
      const draft = await w.otherDraft(), replacement = draft.prepared;
      assert.equal(replacement.status, 'agreement_pending');
      const history = w.h.app.services.ops.history(w.id);
      assert.equal((await w.verify(hash)).status, 'cancelled', 'failed explicit-hash read cannot revive cancellation');
      assert.deepEqual(w.h.app.services.ops.history(w.id), history);
      assert.equal((await draft.submit()).httpStatus, 200);
      assert.equal((await draft.approve()).state, 'completed', 'the replacement can actually CREATE on the shared wallet lane');
      assert.equal(w.h.chain.wire.record.accepted.at(-1).content.nonce, saved.expectedNonce, 'failed execution left the payment nonce available');
      if (resolution === 'late confirmed read') {
        w.h.chain.paymentFaults.failedHashes.delete(hash); // model a later confirmed RPC view of the same hash
        w.h.chain.wire.setNonce(w.address, saved.expectedNonce);
        const confirmed = await w.verify(hash);
        assert.equal(confirmed.status, 'settled_verified', JSON.stringify(confirmed)); assert.equal(confirmed.verification.outcome, 'verified');
        assert.equal(confirmed.protocol.stage, 'payment-observed');
        const settledHistory = w.h.app.services.ops.history(w.id);
        assert.equal((await w.verify(hash)).status, 'settled_verified');
        assert.deepEqual(w.h.app.services.ops.history(w.id), settledHistory);
      }
      assert.equal((await tool(w.h, w.buyer, 'get_purchase_status', { operationId: replacement.operationId })).status, 'agreement_pending');
    }
    assert.equal(w.h.chain.record.broadcasts.length, 1, 'resolution never resends');
  });
}

for (const [transient, fresh] of [
  ['pending', 'failed'], ['unavailable', 'failed'], ['invalid body', 'failed'],
  ['pending', 'pending'], ['unavailable', 'unavailable'], ['invalid body', 'invalid body'],
  ['pending', 'confirmed'], ['unavailable', 'advanced nonce'],
]) {
  test(`fixture-only failed native cancel re-reads after ${transient}: ${fresh}`, async (t) => {
    const w = await nativePaymentFlow(t, { durableSeller: false });
    await w.agreement(); const { handoff } = await w.approve();
    w.h.chain.paymentFaults.payment = 'fail-execution';
    assert.equal((await w.send(handoff.payload)).success, true);
    const hash = w.h.chain.record.accepted[0].hash;
    assert.equal((await w.verify(hash)).verification.outcome, 'execution_failed');
    const chain = w.h.app.services.chain, coordinates = w.h.app.services.coordinates;
    const observeTransfer = chain.observeTransfer, getTransaction = chain.getTransaction;
    const saved = coordinates.get(w.id);
    // The offline broker checks the application nonce only; real source proof is covered in the Node2 readback tests.
    w.h.chain.paymentFaults.nonceObject = true;
    assert.equal(await chain.getAddressNonce(w.address), saved.nonceFence);
    function readView(view) {
      chain.observeTransfer = ['pending', 'unavailable'].includes(view) ? async () => ({ status: view }) : observeTransfer;
      chain.getTransaction = view === 'invalid body' ? async (txHash) => { const body = await getTransaction(txHash); delete body.hash; return body; } : getTransaction;
    }
    try {
      readView(transient);
      const uncertain = await w.verify();
      assert.equal(uncertain.status, 'payment_uncertain');
      assert.equal(uncertain.verification.outcome, { pending: 'awaiting_inclusion', unavailable: 'chain_unavailable', 'invalid body': 'transaction_unconfirmed' }[transient]);
      assert.equal(Object.hasOwn(coordinates.get(w.id).observation, 'txStatus'), false, 'the transient read erases cached execution status');
      assert.equal(coordinates.get(w.id).reportedTxHash, hash);
      readView(fresh);
      if (fresh === 'confirmed') w.h.chain.paymentFaults.failedHashes.delete(hash);
      if (['confirmed', 'advanced nonce'].includes(fresh)) w.h.chain.wire.setNonce(w.address, saved.expectedNonce);
      const freshObserve = chain.observeTransfer;
      let reads = 0;
      chain.observeTransfer = async (txHash) => { reads += 1; assert.equal(txHash, hash); return freshObserve(txHash); };
      const cancelled = await tool(w.h, w.buyer, 'cancel_wallet_handoff', { operationId: w.id });
      assert.equal(reads, 1, 'cancellation freshly verifies its reported hash, regardless of the cached observation');
      assert.equal(cancelled.cancelled, fresh === 'failed');
      assert.equal(cancelled.status, fresh === 'failed' ? 'cancelled' : fresh === 'confirmed' ? 'settled_verified' : 'payment_uncertain');
      assert.equal(w.op().status, cancelled.status);
      if (fresh === 'confirmed') {
        assert.ok(coordinates.get(w.id).verifiedAt); assert.equal(coordinates.get(w.id).observation.txStatus, 'confirmed');
      } else {
        assert.equal(coordinates.get(w.id).verifiedAt, null); assert.equal(coordinates.get(w.id).observation.slotConsumed, false);
      }
      if (fresh === 'failed') {
        assert.equal(coordinates.get(w.id).observation.txStatus, 'failed');
        w.h.chain.paymentFaults.nonceObject = false; // replacement CREATE uses the packaged SDK's bare-number nonce API
        const draft = await w.otherDraft();
        assert.equal((await draft.submit()).httpStatus, 200);
        assert.equal((await draft.approve()).state, 'completed', 'wrapped nonce proof releases the shared purchase lane for replacement CREATE');
      } else if (fresh !== 'confirmed') {
        assert.equal((await w.prepare()).error, 'unresolved_payment');
      }
      assert.equal(w.h.chain.record.broadcasts.length, 1, 'cancellation never resends the failed payment');
    } finally { chain.observeTransfer = observeTransfer; chain.getTransaction = getTransaction; }
  });
}

for (const order of ['cancel first', 'settlement first']) {
  test(`fixture-only failed native cancellation races confirmed verification: ${order}`, async (t) => {
    const w = await nativePaymentFlow(t, { durableSeller: false });
    await w.agreement(); const { handoff } = await w.approve();
    w.h.chain.paymentFaults.payment = 'fail-execution';
    assert.equal((await w.send(handoff.payload)).success, true);
    const hash = w.h.chain.record.accepted[0].hash;
    assert.equal((await w.verify(hash)).verification.outcome, 'execution_failed');
    const chain = w.h.app.services.chain, coordinates = w.h.app.services.coordinates;
    const getAddressNonce = chain.getAddressNonce, getTransaction = chain.getTransaction;
    let nonceRead, releaseNonce, bodyRead, releaseBody;
    const nonceStarted = new Promise((resolve) => { nonceRead = resolve; });
    const nonceHeld = new Promise((resolve) => { releaseNonce = resolve; });
    const bodyStarted = new Promise((resolve) => { bodyRead = resolve; });
    const bodyHeld = new Promise((resolve) => { releaseBody = resolve; });
    chain.getAddressNonce = async (address) => { const nonce = await getAddressNonce(address); nonceRead(); await nonceHeld; return nonce; };
    chain.getTransaction = async (txHash) => {
      const body = await getTransaction(txHash);
      if (body.status === 'confirmed') { bodyRead(); await bodyHeld; }
      return body;
    };
    let cancelling, verifying;
    try {
      cancelling = tool(w.h, w.buyer, 'cancel_wallet_handoff', { operationId: w.id });
      await nonceStarted; // fixture cancel has reverified failure and read the application nonce; no source proof runs
      w.h.chain.paymentFaults.failedHashes.delete(hash);
      w.h.chain.wire.setNonce(w.address, coordinates.get(w.id).expectedNonce);
      verifying = w.verify(); // same stored hash, fresh confirmed view; pause before settlement writes
      await bodyStarted;
      assert.equal(coordinates.get(w.id).verifiedAt, null);
      if (order === 'cancel first') {
        releaseNonce(); const cancelled = await cancelling;
        assert.equal(cancelled.cancelled, true); assert.equal(cancelled.status, 'cancelled');
        assert.equal(coordinates.get(w.id).verifiedAt, null);
        releaseBody();
      } else {
        releaseBody(); const verified = await verifying;
        assert.equal(verified.status, 'settled_verified'); assert.equal(verified.verification.outcome, 'verified');
        assert.ok(coordinates.get(w.id).verifiedAt);
        releaseNonce(); const lost = await cancelling;
        assert.equal(lost.cancelled, false); assert.equal(lost.status, 'settled_verified', 'native refusal returns the current settled state');
      }
      const verified = await verifying;
      assert.equal(verified.status, 'settled_verified'); assert.equal(verified.verification.outcome, 'verified');
      assert.equal(w.op().status, verified.status); assert.ok(coordinates.get(w.id).verifiedAt);
      assert.deepEqual(verified.verification, { outcome: 'verified', ...coordinates.get(w.id).observation, verifiedAt: coordinates.get(w.id).verifiedAt });
      assert.equal(coordinates.get(w.id).observation.txHash, hash);
      assert.equal(w.h.app.services.ops.history(w.id).filter((event) => event.type === 'settled_verified').length, 1);
      assert.equal(w.h.chain.record.broadcasts.length, 1);
    } finally {
      releaseNonce(); releaseBody();
      await Promise.allSettled([cancelling, verifying]);
      chain.getAddressNonce = getAddressNonce; chain.getTransaction = getTransaction;
    }
  });
}

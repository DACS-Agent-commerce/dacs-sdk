// Seller payment recovery repair (docs/SELLER-PAYMENT-RECOVERY-REPAIR.md).
// Owned loopback only: the source-demo flow composes the authenticated seller
// transport, durable seller state, genuine SDK intake, native evidence and
// native delivery. A one-shot generic Error (no code) is injected at the seller
// state signature of the first native work checkpoint: after the SDK permit
// claim, settlement binding and evidence signature, before any seller CREATE.
// Before the repair that throw left the signed payment command `uncertain` with
// no retained work, so every later call reconciled to
// `seller_payment_context_mismatch` and no report was ever returned.
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelReport } from './helpers/model-report.mjs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { contentHash, sha256Hex } from '@kynesyslabs/dacs';
import { sourceDemoFlow } from './helpers/source-demo-flow.mjs';
import { acceptedCreates, kindOf } from './helpers/review-native-delivery-coverage-reader.mjs';
import { NATIVE_PAYMENT_EVIDENCE } from '../src/dacs/native-payment-evidence-consumer.mjs';

// The scoped runner names a private task-local TMPDIR without creating it.
mkdirSync(tmpdir(), { recursive: true, mode: 0o700 });

const STATE_DOMAIN = 'dacs-chatgpt-plugin:offline-seller-state:v1:';
const effects = async (w) => ({ kinds: acceptedCreates(w).map(kindOf).sort(), attempts: w.h.chain.wire.record.broadcastAttempts.length,
  payments: w.h.chain.record.broadcasts.length, approvals: w.seller.sellerApprovals.length, evidence: w.seller.evidenceAttempts.length,
  writes: w.seller.anchorWrites.length, journal: (await w.seller.walletJournal.entries()).length });

// Fail exactly the first durable signature of a session carrying native work.
function failFirstWorkCheckpoint(w) {
  const original = w.seller.wallet.signBytes;
  const fault = { fired: 0 };
  w.seller.wallet.signBytes = (bytes) => {
    const text = Buffer.from(bytes).toString('utf8');
    if (!fault.fired && text.startsWith(STATE_DOMAIN) && text.includes('"nativeEvidenceWork"')) { fault.fired += 1; throw new Error('TEST seller state signer unavailable'); }
    return original(bytes);
  };
  return fault;
}

async function paid(t) {
  const w = await sourceDemoFlow(t);
  assert.equal((await w.agreement()).status, 'awaiting_approval');
  await new Promise((resolve) => setTimeout(resolve, 1050));
  const { handoff } = await w.approve(); assert.equal(handoff.status, 'payment_handoff', JSON.stringify(handoff));
  const sent = await w.send(handoff.payload); assert.equal(sent.success, true, JSON.stringify(sent));
  return { w, sent, jobId: w.op().terms.protocol.jobId };
}

// A signed transport request exactly as the authenticated host passes it on.
function transportInput(w, jobId, body, overrides = {}) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const request = { method: 'POST', path: '/dacs/v1/payments', jobId, seller: w.seller.wallet.claim, buyer: w.buyerActor.signer.claim,
    listingPin: w.seller.agent.listingPin, agreementHash: w.op().state.protocol.agreement.hash, bodyHash: sha256Hex(rawBody), ...overrides };
  return { request, body, rawBody };
}

test('seller payment recovery repair unit: pre-checkpoint seller failure is a definite no-effect answer, then restart delivers the same paid order once', { timeout: 180000 }, async (t) => {
  const { w, sent, jobId } = await paid(t);
  const txHash = sent.data.hash, payer = w.buyerActor.signer.claim;
  const exactBody = { jobId, txHash, payerPayingKey: payer, nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE };
  const fault = failFirstWorkCheckpoint(w);
  const beforeFirst = await effects(w);

  const first = (await w.api('report', { txHash })).evidence;
  assert.equal(fault.fired, 1, 'the injected failure is inside the pre-checkpoint region');
  assert.equal(first?.protocol?.delivery?.report, undefined, JSON.stringify(first?.protocol));
  assert.notEqual(first?.protocol?.stage, 'delivery-ready');
  const firstSummary = w.op().state.protocol.nativeEvidence;
  assert.equal(firstSummary?.sellerStatus, 'rejected', JSON.stringify({ firstSummary, sellerErrors: w.seller.functionalErrors }));
  assert.equal(firstSummary.reason, 'seller_native_evidence_not_started');
  // No retained work, no seller CREATE, no wallet attempt, no second payment.
  assert.notEqual(w.seller.agent.stageOf(jobId), 'native-payment-evidence-held');
  assert.equal(w.seller.agent.deliveryStateOf(jobId), null);
  assert.deepEqual(await effects(w), beforeFirst);
  assert.equal(beforeFirst.payments, 1);
  // The seller transport answered with a signed 200, not an uncertain 503.
  assert.equal(w.seller.responses.filter((r) => r.path === '/dacs/v1/payments').at(-1)?.status, 200, JSON.stringify(w.seller.responses));

  // Absent retained work stays held on the read-only seam (never present).
  const absent = await w.seller.agent.reconcileTransport(transportInput(w, jobId, exactBody));
  assert.deepEqual(absent, { disposition: 'indeterminate', reason: 'seller_payment_context_mismatch' });

  await w.h.restart(); await w.seller.restart();
  const recovered = (await w.api('report', { txHash })).evidence;
  assert.equal(recovered?.protocol?.stage, 'delivery-ready', JSON.stringify({ protocol: recovered?.protocol, sellerErrors: w.seller.functionalErrors, responses: w.seller.responses }));
  const deliveryCreate = acceptedCreates(w).find((tx) => kindOf(tx) === 'Deliverable');
  const signedReport = deliveryCreate.content.data[1].data;
  assert.deepEqual(recovered.protocol.delivery.report, signedReport);
  assert.equal(recovered.protocol.delivery.deliverableRef.contentHash, contentHash(signedReport));
  assert.equal(recovered.protocol.paymentEvidence.txHash, txHash);
  const baseline = await effects(w);
  assert.deepEqual(baseline.kinds, ['Agreement', 'Deliverable', 'SettlementEvidence']);
  assert.equal(baseline.attempts, 3);
  assert.equal(baseline.payments, 1);
  assert.equal(baseline.evidence, 1);
  assert.equal(w.seller.sellerApprovals.filter((r) => r.content?.artifactKind === 'SettlementEvidence').length, 1);
  assert.equal(w.seller.sellerApprovals.filter((r) => r.content?.artifactKind === 'Deliverable').length, 1);

  // Replay and read-only reconciliation return the same delivery with no new effect.
  const replay = await w.verify();
  assert.equal(replay?.protocol?.stage, 'delivery-ready', JSON.stringify(replay?.protocol));
  assert.deepEqual(modelReport(replay.protocol.delivery.report), signedReport);
  const exact = await w.seller.agent.reconcileTransport(transportInput(w, jobId, exactBody));
  assert.equal(exact.disposition, 'present', JSON.stringify(exact));
  assert.equal(exact.value.delivery.status, 'delivery-ready');
  assert.equal(exact.value.delivery.contentHash, contentHash(signedReport));

  // Negative controls on the read-only seam: transaction, payer and job must all match the retained work.
  const otherTx = `0x${'ab'.repeat(32)}`;
  const txMismatch = await w.seller.agent.reconcileTransport(transportInput(w, jobId, { ...exactBody, txHash: otherTx }));
  assert.deepEqual(txMismatch, { disposition: 'indeterminate', reason: 'seller_native_delivery_context_mismatch' });
  const payerMismatch = await w.seller.agent.reconcileTransport(transportInput(w, jobId, { ...exactBody, payerPayingKey: w.seller.wallet.claim }));
  assert.deepEqual(payerMismatch, { disposition: 'indeterminate', reason: 'seller_native_delivery_context_mismatch' });
  const otherJob = `${jobId.slice(0, -1)}${jobId.at(-1) === '0' ? '1' : '0'}`;
  const crossJob = await w.seller.agent.reconcileTransport(transportInput(w, otherJob, { ...exactBody, jobId: otherJob })).catch((error) => ({ thrown: error.code ?? 'error' }));
  assert.notEqual(crossJob.disposition, 'present', JSON.stringify(crossJob));
  assert.ok(crossJob.disposition === 'indeterminate' || crossJob.thrown, JSON.stringify(crossJob));

  // The route itself keeps refusing changed retained work (no resend, no rebinding).
  await assert.rejects(w.seller.agent.submitPayment({ ...exactBody, txHash: otherTx }), (e) => e.code === 'seller_native_evidence_conflict');
  await assert.rejects(w.seller.agent.submitPayment({ ...exactBody, payerPayingKey: w.seller.wallet.claim }), (e) => e.code === 'seller_native_evidence_conflict');
  assert.deepEqual(await effects(w), baseline);
  t.diagnostic(JSON.stringify({ first: { stage: first.protocol.stage, seller: firstSummary.sellerStatus, reason: firstSummary.reason },
    recovered: recovered.protocol.stage, replay: replay.protocol.stage, crossJob: crossJob.reason ?? crossJob.thrown, baseline }));
});

test('seller payment recovery repair unit: absent, transaction-mismatched and payer-mismatched first claims create no work and no effect', { timeout: 180000 }, async (t) => {
  const { w, sent, jobId } = await paid(t);
  const payer = w.buyerActor.signer.claim, before = await effects(w);
  const claim = (body) => w.seller.agent.submitPayment({ jobId, payerPayingKey: payer, nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE, ...body });
  // Absent transaction: never included on the owned chain.
  const absentTx = await claim({ txHash: `0x${'cd'.repeat(32)}` });
  assert.ok(['rejected', 'indeterminate'].includes(absentTx.status), JSON.stringify(absentTx));
  // Payer that is not the Agreement buyer.
  const wrongPayer = await claim({ txHash: sent.data.hash, payerPayingKey: w.seller.wallet.claim });
  assert.equal(wrongPayer.status, 'rejected', JSON.stringify(wrongPayer));
  for (const answer of [absentTx, wrongPayer]) assert.notEqual(answer.reason, 'seller_native_evidence_not_started');
  assert.notEqual(w.seller.agent.stageOf(jobId), 'native-payment-evidence-held');
  assert.equal(w.seller.agent.deliveryStateOf(jobId), null);
  assert.deepEqual(await effects(w), before);
  // The exact claim still completes once afterwards.
  const delivered = (await w.api('report', { txHash: sent.data.hash })).evidence;
  assert.equal(delivered?.protocol?.stage, 'delivery-ready', JSON.stringify(delivered?.protocol));
  const after = await effects(w);
  assert.deepEqual(after.kinds, ['Agreement', 'Deliverable', 'SettlementEvidence']);
  assert.equal(after.payments, 1);
  assert.equal(after.evidence, 1);
});

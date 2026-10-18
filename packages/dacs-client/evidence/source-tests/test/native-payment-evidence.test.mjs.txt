import test from 'node:test';
import assert from 'node:assert/strict';
import { contentHash, finalityCommitmentAddress, paymentEvidenceAddress } from '@kynesyslabs/dacs';
import { nativeEvidenceFlow } from './helpers/native-payment-evidence-flow.mjs';
import { checkNativePaymentEvidence, nativePaymentEvidenceConfig, NATIVE_PAYMENT_EVIDENCE } from '../src/dacs/native-payment-evidence-consumer.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';
installLoopbackOnlyGuard();

async function pay(w, fault = 'ok') {
  assert.equal((await w.agreement()).status, 'awaiting_approval');
  // Fixture native block timestamps have second resolution. Let the node's
  // clock actually advance past the millisecond commitment; never alter the
  // commitment/observation or relax payment-before-commitment intake.
  await new Promise((resolve) => setTimeout(resolve, 1050));
  const { handoff } = await w.approve(); assert.equal(handoff.status, 'payment_handoff', JSON.stringify(handoff));
  w.h.chain.paymentFaults.payment = fault;
  const sent = await w.send(handoff.payload);
  const hash = w.h.chain.record.accepted[0]?.hash ?? sent.data?.hash;
  const reported = await w.api('report', { txHash: hash, ...(sent.error ? { walletError: sent.error.message } : {}) });
  assert.equal(reported.status, 'settled_verified', JSON.stringify(reported));
  return { hash, reported };
}

test('actual MCP/portal native payment -> seller HTTP -> SDK seller signature -> packaged seller CREATE/public projection/fresh readback; no fixture DACS-4/delivery', async (t) => {
  const w = await nativeEvidenceFlow(t); assert.equal(w.op().terms.protocol.nativePaymentEvidence, NATIVE_PAYMENT_EVIDENCE);
  const { hash, reported } = await pay(w);
  assert.equal(reported.evidence.protocol.stage, 'payment-evidenced', JSON.stringify({nativeEvidence:reported.evidence.protocol.nativeEvidence,anchorAnswers:w.seller.evidenceAnswers,errors:w.seller.functionalErrors}));
  assert.equal(w.seller.evidenceAttempts.length, 1, JSON.stringify(reported.evidence.protocol.nativeEvidence));
  const intent = w.seller.evidenceAttempts[0], artifact = intent.artifact, agreement = w.op().state.protocol.agreement.artifact;
  assert.deepEqual(Object.keys(artifact).sort(), ['evidenceVersion','jobId','observedAt','outcome','paymentAmount','paymentTxRefs','phase','settlementFinality','signature']);
  assert.equal(artifact.signature.signer, w.seller.wallet.claim); assert.equal(artifact.jobId, agreement.jobId);
  assert.equal(artifact.paymentTxRefs[0].txHash, hash); assert.equal(artifact.paymentTxRefs[0].blockNumber, 2);
  assert.deepEqual(artifact.paymentAmount, agreement.terms.price); assert.equal(artifact.settlementFinality.model, 'bft-final');
  assert.ok(artifact.observedAt >= w.op().state.protocol.commitment.committedAt);
  assert.equal((await checkNativePaymentEvidence({ artifact, agreement, writer: w.seller.wallet.claim, txHash: hash, blockNumber: 2 })).decision, 'pass');
  assert.equal(intent.logicalAddress, paymentEvidenceAddress(agreement.jobId, 'demos-native:DEM', 2)); assert.equal(intent.artifactKind, 'SettlementEvidence');
  assert.equal(intent.receiptContentHash, contentHash(artifact));
  assert.equal(reported.evidence.protocol.nativeEvidence.nativeReadback, 'present');
  assert.equal(reported.evidence.protocol.nativeEvidence.finality, 'one-node-fixture-view-not-independent');
  assert.equal(reported.evidence.protocol.layers.dacsPurchase, 'payment-evidence-verified'); assert.equal(reported.evidence.protocol.layers.service, 'not-delivered');
  const creates=w.h.chain.wire.record.accepted, sellerCreate=creates.find(x=>x.content.data[1].metadata.artifactKind==='SettlementEvidence');
  assert.equal(creates.length,2);assert.ok(sellerCreate);
  assert.notEqual(sellerCreate.content.from,w.address);assert.equal(sellerCreate.content.from,w.seller.wallet.address);
  assert.equal(JSON.stringify(sellerCreate.content.data[1].data),JSON.stringify(artifact));
  assert.equal(sellerCreate.content.data[1].metadata.logicalAddress,intent.logicalAddress);
  assert.equal(w.seller.sellerApprovals.filter(x=>x.method==='sendTransaction').length,1);
  assert.equal(w.seller.sellerApprovals.find(x=>x.method==='sendTransaction').content.artifactKind,'SettlementEvidence');
  assert.match(w.seller.authority,/ephemeral-fixture-shared-operator/);
  const bytes = JSON.stringify(intent);
  await w.seller.restart(); await w.h.restart();
  for (let i = 0; i < 2; i++) assert.equal((await w.verify()).protocol.stage, 'payment-evidenced');
  assert.equal(w.seller.evidenceAttempts.length, 1); assert.equal(JSON.stringify(w.seller.evidenceAttempts[0]), bytes);
  assert.deepEqual(w.seller.anchorWrites, [finalityCommitmentAddress(agreement.jobId)]);
  assert.equal(w.h.anchors.records.has(intent.logicalAddress), false);
  assert.equal(w.h.chain.wire.record.accepted.length, 2);assert.equal(w.h.chain.wire.record.broadcastAttempts.length,2);
  assert.equal(w.seller.sellerApprovals.filter(x=>x.method==='sendTransaction').length,1);
  assert.equal(w.h.chain.record.accepted.length, 1); assert.equal(w.h.chain.record.broadcasts.length, 1);
  assert.equal((await w.api('completion/request')).error, 'native_completion_held');
});

test('actual unknown-after-apply native payment reaches same SDK evidence intake once; seller and buyer restart never resend payment or evidence CREATE', async (t) => {
  const w = await nativeEvidenceFlow(t); const { reported } = await pay(w, 'drop-after-apply');
  assert.equal(reported.evidence.protocol.stage, 'payment-evidenced', JSON.stringify(reported));
  await w.seller.restart(); await w.h.restart();
  assert.equal((await w.verify()).status, 'settled_verified');
  assert.equal(w.seller.evidenceAttempts.length, 1, JSON.stringify(reported.evidence.protocol.nativeEvidence)); assert.equal(w.h.chain.record.broadcasts.length, 1); assert.equal(w.h.chain.wire.record.broadcastAttempts.length, 2);
});

test('default native terms and old prepared terms remain at payment-observed after later evidence capability enablement', async (t) => {
  const w = await nativeEvidenceFlow(t, { evidenceEnabled: false }); assert.equal(w.op().terms.protocol.nativePaymentEvidence, undefined);
  const { reported } = await pay(w); assert.equal(reported.evidence.protocol.stage, 'payment-observed');
  assert.equal(w.seller.requests.includes('/dacs/v1/payments'), false); assert.equal(w.seller.evidenceAttempts.length, 0);
  await w.h.restart({ evidenceEnabled: true }); assert.equal((await w.verify()).protocol.stage, 'payment-observed');
  assert.equal(w.seller.requests.includes('/dacs/v1/payments'), false); assert.equal(w.seller.evidenceAttempts.length, 0);
});

test('native evidence configuration is a constructed consumed capability, not Boolean consent or an HTTP verified label', () => {
  assert.throws(() => nativePaymentEvidenceConfig(true), /constructed loopback consumer capability/);
  assert.throws(() => nativePaymentEvidenceConfig({ status: 'verified', approved: true }), /constructed loopback consumer capability/);
  assert.deepEqual(externalAttempts, []);
});

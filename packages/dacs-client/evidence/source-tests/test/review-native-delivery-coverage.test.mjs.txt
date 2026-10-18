// Ordinary Node consumer coverage for the source-demo native DEM purchased
// deliverable. Expectations are derived from the chain fixture's accepted wire
// record, SDK contentHash and an independent read-only observer, not from the
// seller's own delivery-ready answer. See the native-delivery coverage notes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelReport } from './helpers/model-report.mjs';
import { createHash } from 'node:crypto';
import { contentHash } from '@kynesyslabs/dacs';
import { sourceDemoFlow } from './helpers/source-demo-flow.mjs';
import { acceptedCreates, buyerProvider, freshReader, kindOf } from './helpers/review-native-delivery-coverage-reader.mjs';
import { readDemDeliveryReady } from '../src/dacs/dem-delivery-consumer.mjs';
import { createFixtureAnchorClient } from '../src/dacs/fixture-anchors.mjs';
import { createNativeDemDeliveryCapability, nativeDemDeliveryConfig, submitNativeDemDelivery, readNativeDemDelivery, provenUnsignedAbsence, isProvenUnsignedAbsence, NATIVE_DEM_DELIVERY_SOURCE } from '../src/dacs/native-dem-delivery-consumer.mjs';

const ops = { submit: async () => ({ status: 'rejected', reason: 'unused' }), reconcile: async () => ({ status: 'absent', reason: 'unused' }),
  read: async () => ({ status: 'absent', reason: 'unused' }), verifyReceipt: async () => 'indeterminate' };
const observer = (read) => createNativeDemDeliveryCapability({ authority: 'TEST-review-coverage-observer', ...ops, read });

test('native delivery capability is default-absent, TEST-scoped and not granted by descriptor/Boolean copies', async () => {
  assert.equal(nativeDemDeliveryConfig(undefined), null);
  assert.equal(nativeDemDeliveryConfig(null), null);
  assert.throws(() => createNativeDemDeliveryCapability({ authority: 'production', ...ops }), TypeError);
  assert.throws(() => createNativeDemDeliveryCapability({ authority: 'TEST-x', ...ops, verifyReceipt: undefined }), TypeError);
  const capability = observer(ops.read);
  assert.equal(Object.isFrozen(capability), true);
  assert.deepEqual({ ...capability }, { source: NATIVE_DEM_DELIVERY_SOURCE, authority: 'TEST-review-coverage-observer' });
  for (const copy of [true, { ...capability }, Object.freeze({ ...capability }), structuredClone(capability)]) {
    assert.throws(() => nativeDemDeliveryConfig(copy), /constructed application capability/);
  }
  let seen;
  const cloning = createNativeDemDeliveryCapability({ authority: 'TEST-clone', ...ops, submit: async (input) => { seen = input; input.report.title = 'mutated'; return { status: 'rejected' }; } });
  const input = { report: { title: 'original' } };
  await submitNativeDemDelivery(cloning, input);
  assert.notEqual(seen, input);
  assert.equal(input.report.title, 'original');
});

// Only this proof lets a held native Deliverable be asked again (a shutdown
// cut its approval before anything was signed). It is the reader's own value:
// a copy, a look-alike with marker fields, or anything read back from storage
// is an ordinary absence.
test('a proven unsigned absence passes through the reader unchanged, and no copy or look-alike carries it', async () => {
  const proven = provenUnsignedAbsence('cut before signing');
  assert.deepEqual({ ...proven }, { status: 'absent', reason: 'cut before signing' });
  assert.equal(isProvenUnsignedAbsence(proven), true);
  assert.equal(isProvenUnsignedAbsence(await readNativeDemDelivery(observer(async () => proven), {})), true);
  for (const copy of [{ ...proven }, structuredClone(proven), JSON.parse(JSON.stringify(proven)), { status: 'absent', reason: proven.reason, askable: true, provenUnsigned: true }]) {
    assert.equal(isProvenUnsignedAbsence(copy), false);
  }
  for (const value of [undefined, null, true, 'absent', { status: 'absent', reason: 'no seller-owned demo CREATE intent' }]) assert.equal(isProvenUnsignedAbsence(value), false);
});

test('source demo native delivery: independent buyer bytes, exact 3 CREATE + 1 DEM, projection identity, unavailable/rejected holds, restart without resend', { timeout: 120000 }, async (t) => {
  const w = await sourceDemoFlow(t);
  assert.equal((await w.agreement()).status, 'awaiting_approval');
  await new Promise((resolve) => setTimeout(resolve, 1050));
  const { handoff } = await w.approve(); assert.equal(handoff.status, 'payment_handoff', JSON.stringify(handoff));
  const sent = await w.send(handoff.payload); assert.equal(sent.success, true, JSON.stringify(sent));
  const reported = await w.api('report', { txHash: sent.data.hash });
  assert.equal(reported.status, 'settled_verified', JSON.stringify(reported));
  assert.equal(reported.evidence.protocol.stage, 'delivery-ready');

  const jobId = w.op().terms.protocol.jobId;
  const agreement = w.op().state.protocol.agreement.artifact, listing = w.op().state.protocol.listing;
  const state = w.seller.agent.deliveryStateOf(jobId);
  const creates = acceptedCreates(w);

  // Row 1: exact effect inventory from the chain fixture, not seller counters.
  assert.equal(creates.length, 3);
  assert.deepEqual(creates.map(kindOf).sort(), ['Agreement', 'Deliverable', 'SettlementEvidence']);
  const agreementCreate = creates.find((tx) => kindOf(tx) === 'Agreement');
  const evidenceCreate = creates.find((tx) => kindOf(tx) === 'SettlementEvidence');
  const deliveryCreate = creates.find((tx) => kindOf(tx) === 'Deliverable');
  assert.equal(agreementCreate.content.from, w.address);
  assert.equal(evidenceCreate.content.from, w.seller.wallet.address);
  assert.equal(deliveryCreate.content.from, w.seller.wallet.address);
  assert.equal(w.h.chain.record.broadcasts.length, 1);
  const sellerKinds = w.seller.sellerApprovals.filter((r) => r.content?.artifactKind).map((r) => r.content.artifactKind).sort();
  assert.deepEqual(sellerKinds, ['Deliverable', 'SettlementEvidence']);

  // Row 3: binding fields checked against independently known values.
  const meta = deliveryCreate.content.data[1].metadata, report = deliveryCreate.content.data[1].data;
  assert.equal(meta.logicalAddress, `dacs4:deliverable:${jobId}`);
  assert.equal(meta.deliveryBinding.jobId, jobId);
  assert.equal(meta.deliveryBinding.agreementHash, contentHash(agreement));
  assert.equal(meta.deliveryBinding.fulfilmentId, state.fulfilmentId);
  assert.equal(meta.deliveryBinding.payloadHash, contentHash(report));
  assert.equal(meta.deliveryBinding.phase, 'deliver-storage-program');
  assert.equal(report.jobId, jobId);
  assert.equal(report.settlementId, `demos:${sent.data.hash}`);
  // Deliverable kind is out-of-band CREATE metadata; the signed report carries no artifact type.
  assert.equal('artifactKind' in report || 'artifactType' in report, false);
  assert.equal(state.paymentPermitId.length > 0, true);
  assert.deepEqual(state.auditSource.session.phaseResults.map((entry) => entry.step.kind), ['negotiate-fixed-price', 'commit-payee-bound-agreement', 'pay-dem']);

  // Row 1/5: buyer returned bytes via an independent projection source and a fresh reader.
  const original = ({ logicalAddress }) => structuredClone(creates.find((tx) => tx.content.data[1].metadata.logicalAddress === logicalAddress));
  const input = { jobId, logicalAddress: meta.logicalAddress, report: null, receiptContentHash: contentHash(report), deliveryBinding: meta.deliveryBinding };
  const first = await buyerProvider(w, original).read(input), second = await buyerProvider(w, original).read(input);
  assert.equal(first.status, 'present', JSON.stringify(first));
  assert.deepEqual(first.artifact, reported.evidence.protocol.delivery.report);
  assert.equal(contentHash(first.artifact), reported.evidence.protocol.delivery.deliverableRef.contentHash);
  for (const record of [first, second]) {
    assert.equal(record.receipt.transactionRef.value, deliveryCreate.hash);
    assert.equal(record.receipt.nativeAddress, deliveryCreate.content.to);
    assert.deepEqual(record.receipt.blockRef, state.anchorReceipt.blockRef);
    assert.equal(record.finality, 'not-established');
  }
  const pointer = { settlementId: `demos:${sent.data.hash}`, delivery: { status: 'delivery-ready', logicalAddress: state.logicalAddress, contentHash: state.contentHash,
    evidenceHash: state.evidenceHash, fulfilmentId: state.fulfilmentId, anchorReceipt: state.anchorReceipt } };
  // w.h.anchors is the fixture server handle; the buyer reads it through the ordinary fixture client.
  const ready = (nativeDemDelivery) => readDemDeliveryReady({ anchors: createFixtureAnchorClient({ url: w.h.anchors.url }), nativeDemDelivery, agreement, listing, seller: w.seller.wallet.claim, answer: pointer });
  const accepted = await ready(observer(buyerProvider(w, original).read));
  assert.equal(accepted.disposition, 'present', JSON.stringify(accepted));
  assert.deepEqual(accepted.delivery.report, first.artifact);

  // Row 5: projection is not interchangeable with the canonical proof serialization.
  const canonicalProjection = JSON.parse(first.demosEvidence.signedTransaction);
  const interchangeable = createHash('sha256').update(JSON.stringify(canonicalProjection.content)).digest('hex') === deliveryCreate.hash;
  const viaCanonical = await buyerProvider(w, () => canonicalProjection).read(input);
  assert.equal(viaCanonical.status === 'present', interchangeable, JSON.stringify(viaCanonical));
  const viaOtherCreate = await buyerProvider(w, () => structuredClone(evidenceCreate)).read(input);
  assert.notEqual(viaOtherCreate.status, 'present');
  assert.equal(await buyerProvider(w, original).verifyReceipt({ ...input, receipt: first.receipt, report: first.artifact }), 'valid');
  assert.equal(await buyerProvider(w, () => undefined).verifyReceipt({ ...input, receipt: first.receipt, report: first.artifact }), 'indeterminate');

  // Kind-binding ordinary control: the actual Deliverable kind is accepted, another kind is not.
  const reader = freshReader(w);
  assert.equal((await reader.read(meta.logicalAddress, { expectedWriter: w.seller.wallet.claim, expectedArtifactKind: 'Deliverable', signedProjection: original(meta) })).status, 'present');
  await assert.rejects(reader.read(meta.logicalAddress, { expectedWriter: w.seller.wallet.claim, expectedArtifactKind: 'SettlementEvidence', signedProjection: original(meta) }), (e) => e.code === 'invalid');

  // Row 6: unavailable projection/storage/receipt is indeterminate or rejected; no fixture fallback.
  const missingProjection = await ready(observer(buyerProvider(w, () => undefined).read));
  assert.equal(missingProjection.disposition, 'indeterminate');
  assert.equal((await ready(null)).disposition, 'indeterminate');
  assert.equal((await ready(observer(async () => { throw new Error('storage unavailable'); }))).disposition, 'indeterminate');
  assert.equal((await ready(observer(async () => ({ status: 'rejected', reason: 'native Deliverable bytes differ' })))).disposition, 'rejected');
  const otherBytes = await ready(observer(async () => ({ status: 'present', artifact: { ...first.artifact, title: 'other' }, receipt: first.receipt })));
  assert.equal(otherBytes.disposition, 'rejected');

  // Row 7: repeat report, reopen and restart are readback-only.
  const before = { creates: creates.length, payments: w.h.chain.record.broadcasts.length, evidence: w.seller.evidenceAttempts.length,
    approvals: w.seller.sellerApprovals.length, writes: w.seller.anchorWrites.length, attempts: w.h.chain.wire.record.broadcastAttempts.length };
  const repeated = await w.api('report', { txHash: sent.data.hash });
  assert.equal(repeated.evidence?.protocol?.stage, 'delivery-ready', JSON.stringify(repeated));
  await w.h.restart(); await w.seller.restart();
  const replay = await w.verify();
  assert.equal(replay.protocol.stage, 'delivery-ready');
  assert.deepEqual(modelReport(replay.protocol.delivery.report), first.artifact);
  assert.deepEqual({ creates: acceptedCreates(w).length, payments: w.h.chain.record.broadcasts.length, evidence: w.seller.evidenceAttempts.length,
    approvals: w.seller.sellerApprovals.length, writes: w.seller.anchorWrites.length, attempts: w.h.chain.wire.record.broadcastAttempts.length }, before);
  // Row 9: delivery-ready is not completion.
  assert.equal(reported.evidence.protocol.delivery.evidencePublication, 'deferred-to-explicit-sdk-finaliser');
  assert.equal((await w.api('completion/request')).error, 'native_completion_held');
  t.diagnostic(JSON.stringify({ jobId, kinds: creates.map(kindOf), deliveryCreate: deliveryCreate.hash, payment: sent.data.hash, canonicalProjectionInterchangeable: interchangeable,
    viaOtherCreate: viaOtherCreate.status, missingProjection: missingProjection.reason, before }));
});

test('source demo native delivery: buyer DEM approval denial sends nothing and creates no seller evidence/Deliverable', { timeout: 120000 }, async (t) => {
  const w = await sourceDemoFlow(t);
  assert.equal((await w.agreement()).status, 'awaiting_approval');
  await new Promise((resolve) => setTimeout(resolve, 1050));
  const { handoff } = await w.approve(); assert.equal(handoff.status, 'payment_handoff', JSON.stringify(handoff));
  w.allowPayment(false);
  // A denial may surface as an unsuccessful answer or a rejection; both are a non-send.
  const denied = await w.send(handoff.payload).catch((error) => ({ success: false, error: String(error?.message ?? error) }));
  assert.notEqual(denied.success, true, JSON.stringify(denied));
  assert.equal(w.h.chain.record.broadcasts.length, 0);
  assert.deepEqual(acceptedCreates(w).map(kindOf), ['Agreement']);
  assert.equal(w.seller.evidenceAttempts.length, 0);
  assert.equal(w.seller.sellerApprovals.filter((r) => r.content?.artifactKind).length, 0);
  const verified = await w.verify();
  assert.notEqual(verified.status, 'settled_verified');
  assert.notEqual(verified.protocol?.stage, 'delivery-ready');
  t.diagnostic(JSON.stringify({ denied: { success: denied.success, error: denied.error ?? denied.message ?? null }, verified: verified.status }));
});

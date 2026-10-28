import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, contentHash, sha256Hex, logicalToStorageProgramName, createFixedPriceAgreementSigningPlan, createFixedPriceAgreementSignatureContribution, signComponentArtifact, ARTIFACT_SEPARATORS } from '@kynesyslabs/dacs';
import { createDevnetPurchasedReportProducer, isDevnetPurchasedReport } from '../src/devnet-demo/deliverable.mjs';
import { createDevnetDemoDeliveryCapability } from '../src/devnet-demo/native-delivery.mjs';
import { submitNativeDemDelivery } from '../src/dacs/native-dem-delivery-consumer.mjs';
import { verifyAgreementCreateAuthorization, verifySignatureAgreement, signatureCommitmentAnchor } from '../src/dacs/commit-on-signature.mjs';
import { contributionVerifier } from '../src/dacs/purchase-protocol.mjs';
import { buildStorageProgramCreatePayload, deriveStorageAddress } from '../src/dacs/wallet-transactions.mjs';
import { createOperatorBuyerAccess, operatorBuyerAccessConfig } from '../src/devnet-demo/buyer-access.mjs';
import { isNativeDeliveryEvidence } from '../src/dacs/delivery-evidence.mjs';
import { buyer, seller, protocolFixture, NOW, JOB } from './helpers/protocol-fixture.mjs';

async function reportFixture(text = 'TEST purchased report') {
  const f = await protocolFixture();
  const produce = createDevnetPurchasedReportProducer({ producer: seller.claim, produce: () => text });
  return { ...f, produce, report: produce({ agreement: f.agreement, listing: f.listing, settlementId: 'TEST-settlement' }) };
}

for (const [label, text] of [['control byte', 'TEST\u0000'], ['lone surrogate', 'TEST\ud800'], ['non-NFC', 'e\u0301'], ['multibyte overflow', '🙂'.repeat(4097)]]) test(`report producer and predicate both refuse ${label}`, async () => {
  const f = await reportFixture();
  assert.equal(isDevnetPurchasedReport({ ...f.report, content: { ...f.report.content, text } }), false);
  assert.throws(() => createDevnetPurchasedReportProducer({ producer: seller.claim, produce: () => text })({ agreement: f.agreement, listing: f.listing, settlementId: 'TEST' }));
});

// The producer checks its own output with the predicate the publish path uses, so a
// conforming Listing or settlement that the predicate refuses never yields a report.
for (const [label, title, settlementId] of [['empty Listing title', '', 'TEST-settlement'], ['513-character Listing title', 'T'.repeat(513), 'TEST-settlement'],
  ['empty settlement ID', 'TEST title', ''], ['numeric settlement ID', 'TEST title', 7]]) test(`report producer refuses a report the predicate refuses: ${label}`, async () => {
  const f = await protocolFixture(), listing = { ...f.listing, offering: { ...f.listing.offering, title } };
  const produce = createDevnetPurchasedReportProducer({ producer: seller.claim, produce: () => 'TEST purchased report' });
  assert.throws(() => produce({ agreement: f.agreement, listing, settlementId }), /report predicate/);
});

// A report is stored whole in one storage CREATE: the largest one admitted is exactly the builder's limit.
test('a report is admitted up to one storage CREATE of complete canonical bytes and rejects malformed Agreement digests', async () => {
  const f = await reportFixture('x'), capacity = 16_384 - (Buffer.byteLength(canonicalize(f.report)) - 1);
  const largest = await reportFixture('🙂'.repeat(Math.floor(capacity / 4)) + 'x'.repeat(capacity % 4));
  assert.equal(Buffer.byteLength(canonicalize(largest.report)), 16_384); assert.equal(isDevnetPurchasedReport(largest.report), true);
  const owner = `0x${'a'.repeat(64)}`, logicalAddress = `dacs4:deliverable:${JOB}`, programName = logicalToStorageProgramName(logicalAddress);
  assert.doesNotThrow(() => buildStorageProgramCreatePayload({ from: owner, storageAddress: deriveStorageAddress(owner, programName, 1), programName, logicalAddress, signedListing: largest.report, nonce: 1, timestamp: NOW }));
  for (const text of [`${largest.report.content.text}x`, '🙂'.repeat(4096)]) {
    assert.equal(isDevnetPurchasedReport({ ...f.report, content: { ...f.report.content, text } }), false, `${Buffer.byteLength(text)} text bytes`);
    assert.throws(() => createDevnetPurchasedReportProducer({ producer: seller.claim, produce: () => text })({ agreement: f.agreement, listing: f.listing, settlementId: 'TEST-settlement' }), /one storage CREATE/);
  }
  assert.equal(isDevnetPurchasedReport({ ...f.report, agreementHash: 'invalid' }), false);
});

function signedCreate(agreement, change = () => {}) {
  const logicalAddress = `dacs3:agreement:${JOB}`, programName = logicalToStorageProgramName(logicalAddress), nonce = 1;
  const storageAddress = deriveStorageAddress(buyer.address, programName, nonce);
  const { content } = buildStorageProgramCreatePayload({ from: buyer.address, storageAddress, programName, logicalAddress, signedListing: agreement, nonce, timestamp: NOW });
  content.from_ed25519_address = buyer.address;
  content.data[1].metadata = { logicalAddress, artifactKind: 'Agreement', contentHash: contentHash(agreement), envelopeHash: sha256Hex(canonicalize(agreement)) };
  change(content);
  const hash = sha256Hex(JSON.stringify(content));
  return { logicalAddress, signed: { content, hash, signature: { type: 'ed25519', data: '0x' + buyer.signBytes(Buffer.from(hash)).toString('hex') } } };
}

test('Agreement CREATE authorization checks hash, signature, exact Agreement and derived destination', async () => {
  const f = await protocolFixture(), valid = signedCreate(f.agreement);
  assert.doesNotThrow(() => verifyAgreementCreateAuthorization(valid.signed, f.agreement, valid.logicalAddress, buyer.claim));
  assert.throws(() => verifyAgreementCreateAuthorization({ ...valid.signed, hash: 'a'.repeat(64) }, f.agreement, valid.logicalAddress, buyer.claim));
  assert.throws(() => verifyAgreementCreateAuthorization({ ...valid.signed, signature: { type: 'ed25519', data: '0x' + '00'.repeat(64) } }, f.agreement, valid.logicalAddress, buyer.claim));
  const changed = structuredClone(f.agreement); changed.terms.price.amount = '7';
  const another = signedCreate(changed);
  assert.throws(() => verifyAgreementCreateAuthorization(another.signed, f.agreement, another.logicalAddress, buyer.claim));
  const misplaced = signedCreate(f.agreement, content => { content.to = 'TEST-wrong'; });
  assert.throws(() => verifyAgreementCreateAuthorization(misplaced.signed, f.agreement, misplaced.logicalAddress, buyer.claim));
});

test('signature commitment verifies retained contributions and only enables the explicit callback path', async () => {
  const f = await protocolFixture(), plan = createFixedPriceAgreementSigningPlan(f.draft);
  const buyerContribution = await createFixedPriceAgreementSignatureContribution(plan, 'buyer', { party: buyer.claim, algorithm: 'ed25519', sign: buyer.signBytes });
  const sellerContribution = await createFixedPriceAgreementSignatureContribution(plan, 'seller', { party: seller.claim, algorithm: 'ed25519', sign: seller.signBytes });
  const session = { proposal: { plan, buyerContribution }, sellerContribution, agreementHash: contentHash(f.agreement) };
  assert.deepEqual(await verifySignatureAgreement(f.agreement, session, contributionVerifier), f.agreement);
  const changed = structuredClone(f.agreement); changed.terms.deadline++;
  await assert.rejects(verifySignatureAgreement(changed, session, contributionVerifier));
  const calls = [], anchor = { onCreateAuthorized(input, callback) { calls.push('registered'); callback(signedCreate(input.artifact).signed); }, async anchorAgreement() { calls.push('anchor'); return 'TEST anchored'; } };
  const consumer = { async commitOnSignature() { calls.push('commit'); } };
  assert.equal(signatureCommitmentAnchor(anchor, consumer, false), anchor);
  assert.equal(await signatureCommitmentAnchor(anchor, consumer, true).anchorAgreement({ artifact: f.agreement }), 'TEST anchored');
  await Promise.resolve(); assert.deepEqual(calls, ['registered', 'anchor', 'commit']);
});

test('native report submission uses the report predicate before reaching its anchor', async () => {
  const f = await reportFixture(); let sent = 0;
  const anchor = { authority: 'TEST-native', writer: seller.claim, publish: async () => { sent++; return { status: 'present', receipt: { transactionRef: { value: 'TEST-write' } } }; }, read: async () => ({ status: 'absent' }), readRetained: async () => ({ status: 'absent' }), verifyReceipt: async () => 'valid' };
  const capability = createDevnetDemoDeliveryCapability({ authority: anchor.authority, anchor });
  const report = { ...f.report, content: { ...f.report.content, text: 'TEST\u0000' } };
  assert.equal((await submitNativeDemDelivery(capability, { jobId: JOB, report, logicalAddress: `dacs4:deliverable:${JOB}`, receiptContentHash: contentHash(report) })).status, 'rejected');
  assert.equal(sent, 0);
});

test('delivery evidence binds the signature and exact canonical job addresses', async () => {
  const unsigned = { evidenceVersion: '1', jobId: JOB, phase: 'deliver-storage-program', outcome: 'success', observedAt: NOW,
    dacsSdkAuditSourceHash: 'a'.repeat(64), deliverableContentHash: 'b'.repeat(64), deliverableAnchor: { kind: 'storage-program', locator: `dacs4:deliverable:${JOB}` } };
  const evidence = await signComponentArtifact(unsigned, ARTIFACT_SEPARATORS.SettlementEvidence, { algorithm: 'ed25519', signer: seller.claim, sign: seller.signBytes });
  assert.equal(isNativeDeliveryEvidence(evidence, seller.claim, `dacs4:evidence:${JOB}`), true);
  assert.equal(isNativeDeliveryEvidence({ ...evidence, deliverableContentHash: 'c'.repeat(64) }, seller.claim, `dacs4:evidence:${JOB}`), false);
});

test('buyer access requires constructed authority and the configured custody identity', () => {
  const access = createOperatorBuyerAccess({ custodyBuyer: buyer.claim, custodySeller: seller.claim, buyerForJob: () => buyer.address });
  assert.equal(access.allowsWallet(buyer.address), true); assert.equal(access.allowsWallet(seller.address), false);
  assert.equal(access.jobAccess(JOB), 'custody'); assert.throws(() => access.assertRelayWallet(seller.address));
  assert.throws(() => operatorBuyerAccessConfig({ ...access }));
});

for (const method of ['assertSellerWallet', 'sellerNotice']) {
  for (const [label, retained, ready, wallet] of [
    ['another buyer', buyer.address, true, seller.address],
    ['no retained buyer', null, true, seller.address],
    ['lookup unavailable', seller.address, false, seller.address],
    ['malformed wallet', 'malformed', true, 'malformed'],
  ]) test(`paid outside ${method} refuses ${label}`, () => {
    const access = createOperatorBuyerAccess({ custodyBuyer: buyer.claim, buyerForJob: () => retained,
      buyerLookupReady: () => ready, paymentObserved: () => true });
    assert.throws(() => access[method](wallet, JOB), { code: 'buyer_access_closed' });
  });
  test(`paid outside ${method} admits only the retained wallet and preserves other access policies`, () => {
    let paid = true;
    const access = createOperatorBuyerAccess({ custodyBuyer: buyer.claim, buyerForJob: () => seller.address,
      paymentObserved: () => paid });
    assert.doesNotThrow(() => access[method](seller.address.toUpperCase(), JOB));
    paid = false;
    assert.throws(() => access[method](seller.address, JOB), { code: 'buyer_access_closed' });
    assert.doesNotThrow(() => access[method](buyer.address, JOB));
    const open = createOperatorBuyerAccess({ openBuyerAccess: true });
    assert.doesNotThrow(() => open[method](seller.address, JOB));
  });
}

for (const deliveryEvidenceEnabled of [false, true]) {
  for (const method of ['publish', 'read', 'readRetained', 'verifyReceipt']) {
    test(`native anchor requires ${method} with evidence ${deliveryEvidenceEnabled}`, () => {
      const anchor = { authority: 'TEST-native', writer: seller.claim, publish() {}, read() {}, readRetained() {}, verifyReceipt() {} };
      delete anchor[method];
      assert.throws(() => createDevnetDemoDeliveryCapability({ authority: anchor.authority, anchor, deliveryEvidenceEnabled }), /native artifact anchor/);
    });
  }
}

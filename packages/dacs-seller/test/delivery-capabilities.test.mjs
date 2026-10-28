import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { canonicalize, contentHash, sha256Hex, logicalToStorageProgramName, createFixedPriceAgreementSigningPlan, createFixedPriceAgreementSignatureContribution, signComponentArtifact, ARTIFACT_SEPARATORS } from '@kynesyslabs/dacs';
import { createDevnetPurchasedReportProducer, isDevnetPurchasedReport } from '../src/devnet-demo/deliverable.mjs';
import { createDevnetDemoDeliveryCapability, readDevnetPurchasedReport } from '../src/devnet-demo/native-delivery.mjs';
import { submitNativeDemDelivery, reconcileNativeDemDelivery, readNativeDemDelivery, verifyNativeDemDeliveryReceipt } from '../src/dacs/native-dem-delivery-consumer.mjs';
import { verifyAgreementCreateAuthorization, verifySignatureAgreement, signatureCommitmentAnchor } from '../src/dacs/commit-on-signature.mjs';
import { contributionVerifier } from '../src/dacs/purchase-protocol.mjs';
import { buildStorageProgramCreatePayload, deriveStorageAddress } from '../src/dacs/wallet-transactions.mjs';
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
for (const [label, settlementId] of [['empty settlement ID', ''], ['numeric settlement ID', 7]]) test(`report producer refuses a report the predicate refuses: ${label}`, async () => {
  const f = await protocolFixture();
  const produce = createDevnetPurchasedReportProducer({ producer: seller.claim, produce: () => 'TEST purchased report' });
  assert.throws(() => produce({ agreement: f.agreement, listing: f.listing, settlementId }), /report predicate/);
});

// The Agreement signs a Listing pin; the producer must not borrow a title (or any
// other field) from a different Listing the caller supplies.
test('report producer refuses a supplied Listing that differs from the Agreement pin before producing', async () => {
  const f = await protocolFixture(); let produced = 0;
  const produce = createDevnetPurchasedReportProducer({ producer: seller.claim, produce: () => { produced++; return 'TEST purchased report'; } });
  for (const change of [
    listing => { listing.offering.title = 'Unpinned title'; },
    listing => { listing.listingId = 'another-listing'; },
    listing => { listing.listingVersion = 2; },
  ]) {
    const changed = structuredClone(f.listing); change(changed);
    assert.throws(() => produce({ agreement: f.agreement, listing: changed, settlementId: 'TEST-settlement' }), /pinned/);
  }
  assert.equal(produced, 0);
  assert.equal(produce({ agreement: f.agreement, listing: f.listing, settlementId: 'TEST-settlement' }).title, f.listing.offering.title);
});

// Refusing a Promise-returning producer synchronously must also own that
// Promise's rejection: an unhandled rejection would terminate the seller even
// though its caller caught the intended TypeError.
test('refusing an asynchronous producer handles its rejection instead of crashing the process', () => {
  const moduleUrl = new URL('../src/devnet-demo/deliverable.mjs', import.meta.url).href;
  const fixtureUrl = new URL('./helpers/protocol-fixture.mjs', import.meta.url).href;
  const script = `
    import { createDevnetPurchasedReportProducer } from ${JSON.stringify(moduleUrl)};
    import { protocolFixture, seller } from ${JSON.stringify(fixtureUrl)};
    const f = await protocolFixture();
    const produce = createDevnetPurchasedReportProducer({ producer: seller.claim, produce: async () => { throw new Error('TEST producer failed'); } });
    let refused = false;
    try { produce({ agreement: f.agreement, listing: f.listing, settlementId: 'TEST-settlement' }); }
    catch (error) { refused = /synchronously/.test(error.message); }
    if (!refused) process.exit(3);
    await new Promise(resolve => setImmediate(resolve));
    console.log('caller recovered');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /caller recovered/);
});

// The SDK Listing validator caps titles at 200 characters. The producer must refuse
// an overlong supplied title even when the caller also pins that Listing.
for (const title of ['', 'T'.repeat(201), 'T'.repeat(513)]) test(`report producer refuses a ${title.length}-character Listing title`, async () => {
  const f = await protocolFixture(), listing = { ...f.listing, offering: { ...f.listing.offering, title } };
  const agreement = { jobId: f.agreement.jobId, listingRef: { listingId: listing.listingId, version: listing.listingVersion, contentHash: contentHash(listing) } };
  assert.throws(() => createDevnetPurchasedReportProducer({ producer: seller.claim, produce: () => 'TEST purchased report' })({ agreement, listing, settlementId: 'TEST-settlement' }), /report predicate/);
});

test('report predicate enforces Listing id, positive version, 200-character title and never throws on lone surrogates', async () => {
  const f = await reportFixture();
  assert.equal(isDevnetPurchasedReport({ ...f.report, listing: { ...f.report.listing, listingId: '' } }), false);
  assert.equal(isDevnetPurchasedReport({ ...f.report, listing: { ...f.report.listing, listingId: 'has space' } }), false);
  assert.equal(isDevnetPurchasedReport({ ...f.report, listing: { ...f.report.listing, version: 0 } }), false);
  assert.equal(isDevnetPurchasedReport({ ...f.report, listing: { ...f.report.listing, version: -1 } }), false);
  assert.equal(isDevnetPurchasedReport({ ...f.report, title: 'T'.repeat(201) }), false);
  assert.equal(isDevnetPurchasedReport({ ...f.report, title: 'T'.repeat(200) }), true);
  for (const edit of [report => { report.title = '\ud800'; }, report => { report.settlementId = '\ud800'; },
    report => { report.listing.listingId = '\ud800'; }, report => { report.producer = '\ud800'; }]) {
    const malformed = structuredClone(f.report); edit(malformed);
    assert.doesNotThrow(() => isDevnetPurchasedReport(malformed));
    assert.equal(isDevnetPurchasedReport(malformed), false);
  }
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

// A report whose metadata holds an escaped lone surrogate can arrive in parsed
// JSON. The predicate and every adapter must answer false/rejected/invalid rather
// than letting canonicalization throw.
test('native delivery adapters reject metadata lone surrogates without throwing or reaching the anchor', async () => {
  const f = await reportFixture(); let calls = 0;
  const anchor = { authority: 'TEST-native', writer: seller.claim, publish: async () => { calls++; }, read: async () => { calls++; }, readRetained: async () => { calls++; }, verifyReceipt: async () => { calls++; } };
  const capability = createDevnetDemoDeliveryCapability({ authority: anchor.authority, anchor });
  for (const edit of [report => { report.title = '\ud800'; }, report => { report.settlementId = '\ud800'; }, report => { report.listing.listingId = '\ud800'; }]) {
    const report = structuredClone(f.report); edit(report);
    const input = { jobId: JOB, report, logicalAddress: `dacs4:deliverable:${JOB}`, receiptContentHash: 'a'.repeat(64), deliveryBinding: { agreementHash: f.report.agreementHash } };
    assert.equal((await submitNativeDemDelivery(capability, input)).status, 'rejected');
    assert.equal((await readNativeDemDelivery(capability, input)).status, 'rejected');
    assert.equal(await verifyNativeDemDeliveryReceipt(capability, input), 'invalid');
  }
  assert.equal(calls, 0);
});

test('native delivery maps successful publish, reconcile and retained readback and rejects changed bindings', async () => {
  const f = await reportFixture(), receiptHash = contentHash(f.report);
  const deliveryBinding = { jobId: JOB, payloadHash: receiptHash, agreementHash: f.report.agreementHash, listing: f.report.listing, fulfilmentId: 'TEST-fulfilment' };
  const scope = { jobId: JOB, seller: seller.claim, logicalAddress: `dacs4:deliverable:${JOB}`, receiptContentHash: receiptHash,
    settlementId: f.report.settlementId, listing: f.report.listing, fulfilmentId: 'TEST-fulfilment', agreementHash: f.report.agreementHash, deliveryBinding };
  let retained = { status: 'present', artifact: f.report, deliveryBinding, receipt: { writer: seller.claim, transactionRef: { value: 'TEST-write' }, blockRef: { timestamp: NOW } } };
  const anchor = { authority: 'TEST-native', writer: seller.claim,
    publish: async () => ({ status: 'present', receipt: { transactionRef: { value: 'TEST-write' } } }),
    read: async () => retained, readRetained: async () => retained, verifyReceipt: async () => 'valid' };
  const capability = createDevnetDemoDeliveryCapability({ authority: anchor.authority, anchor });
  assert.equal((await submitNativeDemDelivery(capability, { ...scope, report: f.report })).status, 'accepted');
  assert.deepEqual(await reconcileNativeDemDelivery(capability, { ...scope, report: f.report }), { status: 'complete', reconciliationId: 'TEST-write', observedAt: NOW });
  const readback = await readDevnetPurchasedReport(capability, scope);
  assert.equal(readback.status, 'present'); assert.equal(readback.artifact.title, f.report.title);
  for (const changed of [{ settlementId: 'changed-settlement' }, { fulfilmentId: 'changed-fulfilment' },
    { seller: buyer.claim }, { receiptContentHash: 'b'.repeat(64) }]) {
    assert.equal((await readDevnetPurchasedReport(capability, { ...scope, ...changed })).status, 'rejected');
  }
  const priorRetained = retained;
  retained = { ...retained, receipt: { ...retained.receipt, writer: buyer.claim } };
  assert.equal((await readDevnetPurchasedReport(capability, scope)).status, 'rejected');
  retained = { ...priorRetained, deliveryBinding: { ...deliveryBinding, payloadHash: 'b'.repeat(64) } };
  assert.equal((await readDevnetPurchasedReport(capability, scope)).status, 'rejected');
  retained = { status: 'absent' };
  assert.equal((await readDevnetPurchasedReport(capability, scope)).status, 'absent');
});

test('purchased-report reader answers an incomplete scope without throwing or reading the anchor', async () => {
  let calls = 0;
  const anchor = { authority: 'TEST-native', writer: seller.claim, publish: async () => { calls++; }, read: async () => { calls++; },
    readRetained: async () => { calls++; return { status: 'absent' }; }, verifyReceipt: async () => { calls++; } };
  const capability = createDevnetDemoDeliveryCapability({ authority: anchor.authority, anchor });
  for (const input of [{ jobId: JOB }, { jobId: JOB, deliveryBinding: {} },
    { jobId: JOB, deliveryBinding: { jobId: JOB } }, { jobId: JOB, listing: {} },
    { jobId: JOB, deliveryBinding: { listing: {} } }]) {
    assert.equal((await readDevnetPurchasedReport(capability, input)).status, 'rejected');
  }
  assert.equal(calls, 0);
});

test('delivery evidence binds the signature and exact canonical job addresses', async () => {
  const unsigned = { evidenceVersion: '1', jobId: JOB, phase: 'deliver-storage-program', outcome: 'success', observedAt: NOW,
    dacsSdkAuditSourceHash: 'a'.repeat(64), deliverableContentHash: 'b'.repeat(64), deliverableAnchor: { kind: 'storage-program', locator: `dacs4:deliverable:${JOB}` } };
  const evidence = await signComponentArtifact(unsigned, ARTIFACT_SEPARATORS.SettlementEvidence, { algorithm: 'ed25519', signer: seller.claim, sign: seller.signBytes });
  assert.equal(isNativeDeliveryEvidence(evidence, seller.claim, `dacs4:evidence:${JOB}`), true);
  assert.equal(isNativeDeliveryEvidence({ ...evidence, deliverableContentHash: 'c'.repeat(64) }, seller.claim, `dacs4:evidence:${JOB}`), false);
});

for (const deliveryEvidenceEnabled of [false, true]) {
  for (const method of ['publish', 'read', 'readRetained', 'verifyReceipt']) {
    test(`native anchor requires ${method} with evidence ${deliveryEvidenceEnabled}`, () => {
      const anchor = { authority: 'TEST-native', writer: seller.claim, publish() {}, read() {}, readRetained() {}, verifyReceipt() {} };
      delete anchor[method];
      assert.throws(() => createDevnetDemoDeliveryCapability({ authority: anchor.authority, anchor, deliveryEvidenceEnabled }), /native artifact anchor/);
    });
  }
}

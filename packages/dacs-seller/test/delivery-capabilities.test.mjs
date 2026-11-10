import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { canonicalize, contentHash, sha256Hex, logicalToStorageProgramName, createFixedPriceAgreementSigningPlan, createFixedPriceAgreementSignatureContribution, signComponentArtifact, ARTIFACT_SEPARATORS } from '@kynesyslabs/dacs';
import { createDevnetPurchasedReportProducer, isDevnetPurchasedReport } from '../src/devnet-demo/deliverable.mjs';
import { createDevnetDemoDeliveryCapability, hasDevnetDeliveryEvidenceReader, readDevnetDeliveryEvidence, readDevnetPurchasedReport } from '../src/devnet-demo/native-delivery.mjs';
import { submitNativeDemDelivery, reconcileNativeDemDelivery, readNativeDemDelivery, verifyNativeDemDeliveryReceipt } from '../src/dacs/native-dem-delivery-consumer.mjs';
import { verifyAgreementCreateAuthorization, verifySignatureAgreement, signatureCommitmentAnchor } from '../src/dacs/commit-on-signature.mjs';
import { contributionVerifier } from '../src/dacs/purchase-protocol.mjs';
import { buildStorageProgramCreatePayload, deriveStorageAddress } from '../src/dacs/wallet-transactions.mjs';
import { isNativeDeliveryEvidence } from '../src/dacs/delivery-evidence.mjs';
import { buyer, seller, protocolFixture, NOW, JOB } from './helpers/protocol-fixture.mjs';

const OTHER_JOB = '01J8N4YV7YVYQ4DB7M8T4C7W0B';
const nextMacrotask = () => new Promise(resolve => setImmediate(resolve));

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

// Every change is signed by the buyer after it is made, so only the check named in
// the label can refuse it: the hash and the signature are valid for the changed bytes.
const NOT_AUTHORIZED = /buyer has not authorized the exact Agreement CREATE/;
const withNonce = nonce => content => {
  const op = content.data[1];
  op.storageAddress = deriveStorageAddress(buyer.address, op.programName, nonce);
  content.nonce = nonce; content.to = op.storageAddress;
};
for (const [label, change] of [
  ['the sender is not the buyer', c => { c.from = seller.address; }],
  ['the ed25519 sender is not the buyer', c => { c.from_ed25519_address = seller.address; }],
  ['the transaction is not a storage program', c => { c.type = 'native'; }],
  ['the nonce is zero', withNonce(0)],
  ['the nonce is not an integer', withNonce(1.5)],
  ['the amount is not zero', c => { c.amount = 1; }],
  ['the transaction has a third data element', c => { c.data.push({}); }],
  ['the first data element is not storageProgram', c => { c.data[0] = 'TEST-other'; }],
  ['the operation is not a storage program CREATE', c => { c.data[1].operation = 'WRITE_STORAGE'; }],
  ['the program name differs', c => { c.data[1].programName = 'TEST-other'; }],
  ['the salt is not empty', c => { c.data[1].salt = 'TEST-salt'; }],
  ['the encoding is not json', c => { c.data[1].encoding = 'binary'; }],
  ['the storage location is not onchain', c => { c.data[1].storageLocation = 'offchain'; }],
  ['the ACL is not public', c => { c.data[1].acl = { mode: 'private' }; }],
  ['the storage address is not the derived one', c => { c.data[1].storageAddress = 'TEST-other'; c.to = 'TEST-other'; }],
  ['the stored data differs from the Agreement', c => { c.data[1].data = { ...c.data[1].data, extra: 'TEST' }; }],
  ['the metadata names another logical address', c => { c.data[1].metadata.logicalAddress = `dacs3:agreement:${OTHER_JOB}`; }],
  ['the metadata names another artifact kind', c => { c.data[1].metadata.artifactKind = 'Listing'; }],
  ['the metadata content hash differs', c => { c.data[1].metadata.contentHash = 'a'.repeat(64); }],
  ['the metadata envelope hash differs', c => { c.data[1].metadata.envelopeHash = 'a'.repeat(64); }],
  ['the metadata is missing', c => { delete c.data[1].metadata; }],
]) test(`Agreement CREATE authorization is refused when ${label}`, async () => {
  const f = await protocolFixture(), changed = signedCreate(f.agreement, change);
  assert.throws(() => verifyAgreementCreateAuthorization(changed.signed, f.agreement, changed.logicalAddress, buyer.claim), NOT_AUTHORIZED);
});

for (const [label, arrange] of [
  ['no signed transaction is given', () => [undefined]],
  ['the signed transaction is empty', () => [{}]],
  ['the hash is not lowercase hex', signed => [{ ...signed, hash: signed.hash.toUpperCase() }]],
  ['the signature is missing', ({ content, hash }) => [{ content, hash }]],
  ['the signature type is not ed25519', signed => [{ ...signed, signature: { ...signed.signature, type: 'secp256k1' } }]],
  ['the expected writer is not the buyer', signed => [signed, seller.claim]],
  ['the expected logical address is another job', signed => [signed, buyer.claim, `dacs3:agreement:${OTHER_JOB}`]],
]) test(`Agreement CREATE authorization is refused when ${label}`, async () => {
  const f = await protocolFixture(), valid = signedCreate(f.agreement);
  const [signed, writer = buyer.claim, logicalAddress = valid.logicalAddress] = arrange(valid.signed);
  assert.throws(() => verifyAgreementCreateAuthorization(signed, f.agreement, logicalAddress, writer), NOT_AUTHORIZED);
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

// An enabled switch is not enough: the anchor must also offer the hook that hands over the signed CREATE.
for (const [label, hook] of [['absent', {}], ['undefined', { onCreateAuthorized: undefined }], ['null', { onCreateAuthorized: null }],
  ['a string', { onCreateAuthorized: 'TEST-hook' }], ['an object', { onCreateAuthorized: {} }]]) test(`signature commitment leaves the anchor unwrapped when the hook is ${label}`, async () => {
  const f = await protocolFixture(), calls = [];
  const anchor = { ...hook, async anchorAgreement() { calls.push('anchor'); return 'TEST anchored'; } };
  const wrapped = signatureCommitmentAnchor(anchor, { async commitOnSignature() { calls.push('commit'); } }, true);
  assert.equal(wrapped, anchor);
  assert.equal(await wrapped.anchorAgreement({ artifact: f.agreement }), 'TEST anchored');
  await nextMacrotask(); assert.deepEqual(calls, ['anchor']);
});

test('signature commitment refuses to anchor when onCreateAuthorized throws', async () => {
  const f = await protocolFixture(), calls = [];
  const anchor = { onCreateAuthorized() { throw new Error('TEST hook failed'); }, async anchorAgreement() { calls.push('anchor'); return 'TEST anchored'; } };
  const wrapped = signatureCommitmentAnchor(anchor, { async commitOnSignature() { calls.push('commit'); } }, true);
  await assert.rejects(wrapped.anchorAgreement({ artifact: f.agreement }), /TEST hook failed/);
  await nextMacrotask(); assert.deepEqual(calls, []);
});

test('signature commitment starts nothing when the hook never hands over a signed CREATE', async () => {
  const f = await protocolFixture(), calls = [];
  const anchor = { onCreateAuthorized() { calls.push('registered'); }, async anchorAgreement() { calls.push('anchor'); return 'TEST anchored'; } };
  const wrapped = signatureCommitmentAnchor(anchor, { async commitOnSignature() { calls.push('commit'); } }, true);
  assert.equal(await wrapped.anchorAgreement({ artifact: f.agreement }), 'TEST anchored');
  await nextMacrotask(); assert.deepEqual(calls, ['registered', 'anchor']);
});

// An unhandled rejection fails the test run, so a commitment failure that escaped the wrapper would show here.
for (const [label, commitOnSignature] of [['rejects', async () => { throw new Error('TEST commit failed'); }],
  ['throws synchronously', () => { throw new Error('TEST commit failed'); }]]) test(`a failing seller commitment does not fail the anchor call: it ${label}`, async () => {
  const f = await protocolFixture(), calls = [];
  const anchor = { onCreateAuthorized(input, callback) { callback(signedCreate(input.artifact).signed); }, async anchorAgreement() { calls.push('anchor'); return 'TEST anchored'; } };
  const wrapped = signatureCommitmentAnchor(anchor, { commitOnSignature(...args) { calls.push('commit'); return commitOnSignature(...args); } }, true);
  assert.equal(await wrapped.anchorAgreement({ artifact: f.agreement }), 'TEST anchored');
  await nextMacrotask(); assert.deepEqual(calls, ['anchor', 'commit']);
});

test('signature commitment wrapper does not expose onCreateAuthorized', async () => {
  const anchor = { onCreateAuthorized() {}, async anchorAgreement() {} };
  const wrapped = signatureCommitmentAnchor(anchor, { async commitOnSignature() {} }, true);
  assert.notEqual(wrapped, anchor);
  assert.equal('onCreateAuthorized' in wrapped, false);
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

test('the purchased-report and delivery-evidence readers read the anchor passively: no resend', async () => {
  const f = await reportFixture(), receiptHash = contentHash(f.report);
  const deliveryBinding = { jobId: JOB, payloadHash: receiptHash, agreementHash: f.report.agreementHash, listing: f.report.listing, fulfilmentId: 'TEST-fulfilment' };
  const scope = { jobId: JOB, seller: seller.claim, logicalAddress: `dacs4:deliverable:${JOB}`, receiptContentHash: receiptHash,
    settlementId: f.report.settlementId, listing: f.report.listing, fulfilmentId: 'TEST-fulfilment', agreementHash: f.report.agreementHash, deliveryBinding };
  const reads = [];
  const anchor = { authority: 'TEST-native', writer: seller.claim, publish: async () => ({ status: 'indeterminate' }), read: async () => ({ status: 'absent' }),
    readRetained: async (input, options) => { reads.push({ artifactKind: input.artifactKind, options }); return { status: 'absent' }; }, verifyReceipt: async () => 'valid' };
  const capability = createDevnetDemoDeliveryCapability({ authority: anchor.authority, anchor, deliveryEvidenceEnabled: true });
  await readDevnetPurchasedReport(capability, scope);
  await readDevnetDeliveryEvidence(capability, { jobId: JOB, seller: seller.claim });
  assert.deepEqual(reads, [{ artifactKind: 'Deliverable', options: { resend: false } }, { artifactKind: 'SettlementEvidence', options: { resend: false } }]);
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

// Publish, read, reconcile and receipt verification share one guard, so a binding
// that contradicts the report (or is missing) is refused before the anchor is
// reached, exactly as the purchased-report reader would refuse it afterwards.
test('native delivery refuses a missing or contradictory fulfilment binding before reaching the anchor', async () => {
  const f = await reportFixture(), receiptHash = contentHash(f.report); let calls = 0;
  const anchor = { authority: 'TEST-native', writer: seller.claim, publish: async () => { calls++; return { status: 'present', receipt: { transactionRef: { value: 'TEST-write' } } }; },
    read: async () => { calls++; return { status: 'absent' }; }, readRetained: async () => { calls++; return { status: 'absent' }; }, verifyReceipt: async () => { calls++; return 'valid'; } };
  const capability = createDevnetDemoDeliveryCapability({ authority: anchor.authority, anchor });
  const binding = { jobId: JOB, payloadHash: receiptHash, agreementHash: f.report.agreementHash, listing: f.report.listing, fulfilmentId: 'TEST-fulfilment' };
  const input = deliveryBinding => ({ jobId: JOB, report: f.report, logicalAddress: `dacs4:deliverable:${JOB}`, receiptContentHash: receiptHash, deliveryBinding });
  assert.equal((await submitNativeDemDelivery(capability, input(binding))).status, 'accepted');
  assert.equal(await verifyNativeDemDeliveryReceipt(capability, input(binding)), 'valid');
  assert.equal((await readNativeDemDelivery(capability, input(binding))).status, 'absent');
  calls = 0;
  for (const [label, change] of [['no binding', undefined], ['null binding', null], ['other job', { ...binding, jobId: '01J8N4YV7YVYQ4DB7M8T4C7W0B' }],
    ['other payload hash', { ...binding, payloadHash: 'b'.repeat(64) }], ['other Listing version', { ...binding, listing: { ...f.report.listing, version: f.report.listing.version + 1 } }],
    ['other Listing hash', { ...binding, listing: { ...f.report.listing, contentHash: 'c'.repeat(64) } }], ['no Listing', { ...binding, listing: undefined }],
    ['other Agreement', { ...binding, agreementHash: 'd'.repeat(64) }], ['no Agreement', { ...binding, agreementHash: undefined }],
    ['no fulfilment id', { ...binding, fulfilmentId: undefined }], ['empty fulfilment id', { ...binding, fulfilmentId: '' }],
    ['lone surrogate Listing', { ...binding, listing: { ...f.report.listing, listingId: '\ud800' } }]]) {
    assert.equal((await submitNativeDemDelivery(capability, input(change))).status, 'rejected', label);
    assert.equal((await readNativeDemDelivery(capability, input(change))).status, 'rejected', label);
    assert.equal((await reconcileNativeDemDelivery(capability, input(change))).status, 'indeterminate', label);
    assert.equal(await verifyNativeDemDeliveryReceipt(capability, input(change)), 'invalid', label);
  }
  assert.equal(calls, 0);
});

test('purchased-report reader refuses a scope that omits the Agreement hash or fulfilment id', async () => {
  const f = await reportFixture(), receiptHash = contentHash(f.report); let calls = 0;
  const deliveryBinding = { jobId: JOB, payloadHash: receiptHash, listing: f.report.listing };
  const anchor = { authority: 'TEST-native', writer: seller.claim, publish: async () => { calls++; }, read: async () => { calls++; },
    readRetained: async () => { calls++; return { status: 'present', artifact: f.report, deliveryBinding, receipt: { writer: seller.claim, transactionRef: { value: 'TEST-write' }, blockRef: { timestamp: NOW } } }; },
    verifyReceipt: async () => { calls++; } };
  const capability = createDevnetDemoDeliveryCapability({ authority: anchor.authority, anchor });
  const scope = { jobId: JOB, seller: seller.claim, logicalAddress: `dacs4:deliverable:${JOB}`, receiptContentHash: receiptHash, settlementId: f.report.settlementId, listing: f.report.listing, deliveryBinding };
  assert.equal((await readDevnetPurchasedReport(capability, scope)).status, 'rejected');
  const complete = { ...scope, agreementHash: f.report.agreementHash, fulfilmentId: 'TEST-fulfilment' };
  complete.deliveryBinding = { ...deliveryBinding, agreementHash: f.report.agreementHash, fulfilmentId: 'TEST-fulfilment' };
  for (const change of [{ agreementHash: undefined, deliveryBinding: { ...complete.deliveryBinding, agreementHash: undefined } },
    { fulfilmentId: undefined, deliveryBinding: { ...complete.deliveryBinding, fulfilmentId: undefined } },
    { fulfilmentId: '', deliveryBinding: { ...complete.deliveryBinding, fulfilmentId: '' } }]) {
    assert.equal((await readDevnetPurchasedReport(capability, { ...complete, ...change })).status, 'rejected');
  }
  assert.equal(calls, 0);
});

const EVIDENCE_ADDRESS = `dacs4:evidence:${JOB}`;
const unsignedEvidence = () => ({ evidenceVersion: '1', jobId: JOB, phase: 'deliver-storage-program', outcome: 'success', observedAt: NOW,
  dacsSdkAuditSourceHash: 'a'.repeat(64), deliverableContentHash: 'b'.repeat(64), deliverableAnchor: { kind: 'storage-program', locator: `dacs4:deliverable:${JOB}` } });
const signEvidence = (unsigned, signer = seller) => signComponentArtifact(unsigned, ARTIFACT_SEPARATORS.SettlementEvidence, { algorithm: 'ed25519', signer: signer.claim, sign: signer.signBytes });

test('delivery evidence binds the signature and exact canonical job addresses', async () => {
  const evidence = await signEvidence(unsignedEvidence());
  assert.equal(isNativeDeliveryEvidence(evidence, seller.claim, EVIDENCE_ADDRESS), true);
  assert.equal(isNativeDeliveryEvidence({ ...evidence, deliverableContentHash: 'c'.repeat(64) }, seller.claim, EVIDENCE_ADDRESS), false);
});

// The changed evidence is signed again by the seller, so only its own check can refuse it.
const withoutKey = key => unsigned => Object.fromEntries(Object.entries(unsigned).filter(([name]) => name !== key));
for (const [label, change, address] of [
  ['an unknown key is added', u => ({ ...u, note: 'TEST' })],
  ['the deliverable anchor is missing', withoutKey('deliverableAnchor')],
  ['the audit hash is missing', withoutKey('dacsSdkAuditSourceHash')],
  ['the evidence version is not 1', u => ({ ...u, evidenceVersion: '2' })],
  ['the job id is not canonical', u => ({ ...u, jobId: JOB.toLowerCase(), deliverableAnchor: { ...u.deliverableAnchor, locator: `dacs4:deliverable:${JOB.toLowerCase()}` } }), `dacs4:evidence:${JOB.toLowerCase()}`],
  ['the phase is not deliver-storage-program', u => ({ ...u, phase: 'deliver' })],
  ['the outcome is not success', u => ({ ...u, outcome: 'failure' })],
  ['the audit hash is too short', u => ({ ...u, dacsSdkAuditSourceHash: 'a'.repeat(63) })],
  ['the audit hash is uppercase', u => ({ ...u, dacsSdkAuditSourceHash: 'A'.repeat(64) })],
  ['the deliverable hash is too short', u => ({ ...u, deliverableContentHash: 'b'.repeat(63) })],
  ['the deliverable hash is uppercase', u => ({ ...u, deliverableContentHash: 'B'.repeat(64) })],
  ['the deliverable anchor is not a storage program', u => ({ ...u, deliverableAnchor: { ...u.deliverableAnchor, kind: 'file' } })],
  ['the deliverable anchor names another job', u => ({ ...u, deliverableAnchor: { ...u.deliverableAnchor, locator: `dacs4:deliverable:${OTHER_JOB}` } })],
  ['the deliverable anchor has an unknown key', u => ({ ...u, deliverableAnchor: { ...u.deliverableAnchor, note: 'TEST' } })],
  ['the observation time is negative', u => ({ ...u, observedAt: -1 })],
  ['the observation time is fractional', u => ({ ...u, observedAt: 1.5 })],
  ['the observation time is a string', u => ({ ...u, observedAt: String(NOW) })],
]) test(`delivery evidence is refused when ${label}`, async () => {
  const evidence = await signEvidence(change(unsignedEvidence()));
  assert.equal(isNativeDeliveryEvidence(evidence, seller.claim, address ?? EVIDENCE_ADDRESS), false);
});

// Each row names what differs from the valid call: the evidence, the expected writer or the logical address.
const withSignature = (evidence, change) => ({ value: { ...evidence, signature: { ...evidence.signature, ...change } } });
for (const [label, differs] of [
  ['it is checked for another writer', () => ({ writer: buyer.claim })],
  ['the logical address is another job', () => ({ address: `dacs4:evidence:${OTHER_JOB}` })],
  ['the logical address is the deliverable address', () => ({ address: `dacs4:deliverable:${JOB}` })],
  ['the logical address is empty', () => ({ address: '' })],
  ['the logical address is missing', () => ({ address: undefined })],
  ['the signature algorithm is not ed25519', evidence => withSignature(evidence, { algorithm: 'secp256k1' })],
  ['the signature has an unknown key', evidence => withSignature(evidence, { note: 'TEST' })],
  ['the signature value is empty', evidence => withSignature(evidence, { value: '' })],
  ['the signature value is not a signature', evidence => withSignature(evidence, { value: 'TEST-not-a-signature' })],
  ['the signer is not the writer', evidence => withSignature(evidence, { signer: buyer.claim })],
  ['the evidence is null', () => ({ value: null })],
  ['the evidence is missing', () => ({ value: undefined })],
  ['the evidence is a string', () => ({ value: 'TEST' })],
  ['the evidence is an array', () => ({ value: [] })],
]) test(`delivery evidence is refused when ${label}`, async () => {
  const evidence = await signEvidence(unsignedEvidence());
  const { value, writer, address } = { value: evidence, writer: seller.claim, address: EVIDENCE_ADDRESS, ...differs(evidence) };
  assert.equal(isNativeDeliveryEvidence(value, writer, address), false);
});

test('delivery evidence is refused when the buyer signed it', async () => {
  const evidence = await signEvidence(unsignedEvidence(), buyer);
  assert.equal(isNativeDeliveryEvidence(evidence, seller.claim, EVIDENCE_ADDRESS), false);
  assert.equal(isNativeDeliveryEvidence({ ...evidence, signature: { ...evidence.signature, signer: seller.claim } }, seller.claim, EVIDENCE_ADDRESS), false);
});

test('delivery evidence is refused when its signature belongs to other evidence', async () => {
  const evidence = await signEvidence(unsignedEvidence()), other = await signEvidence({ ...unsignedEvidence(), deliverableContentHash: 'c'.repeat(64) });
  assert.equal(isNativeDeliveryEvidence({ ...evidence, signature: other.signature }, seller.claim, EVIDENCE_ADDRESS), false);
});

// The evidence reader exists only when deliveryEvidenceEnabled is set, and only for the anchor's own writer.
const readerAnchor = reads => ({ authority: 'TEST-native', writer: seller.claim, publish: async () => { reads.push('publish'); }, read: async () => { reads.push('read'); },
  readRetained: async input => { reads.push(input.logicalAddress); return { status: 'absent' }; }, verifyReceipt: async () => { reads.push('verifyReceipt'); } });
const evidenceCapability = (anchor, deliveryEvidenceEnabled) => createDevnetDemoDeliveryCapability({ authority: anchor.authority, anchor, deliveryEvidenceEnabled });

for (const [label, build] of [
  ['it is left at its default', anchor => evidenceCapability(anchor)],
  ['it is false', anchor => evidenceCapability(anchor, false)],
  ['the capability is a copy of an enabled one', anchor => ({ ...evidenceCapability(anchor, true) })],
  ['the capability is an unrelated object', () => ({})],
]) test(`delivery evidence reader is unavailable unless deliveryEvidenceEnabled is set: ${label}`, async () => {
  const reads = [], capability = build(readerAnchor(reads));
  assert.equal(hasDevnetDeliveryEvidenceReader(capability), false);
  await assert.rejects(readDevnetDeliveryEvidence(capability, { jobId: JOB, seller: seller.claim }), /delivery evidence reader is unavailable/);
  assert.deepEqual(reads, []);
});

for (const [label, writer] of [['the buyer', buyer.claim], ['no seller', undefined], ['an empty seller', ''], ['an object instead of a claim', {}]]) test(`delivery evidence reader refuses a seller other than the anchor writer: ${label}`, async () => {
  const reads = [], capability = evidenceCapability(readerAnchor(reads), true);
  assert.equal(hasDevnetDeliveryEvidenceReader(capability), true);
  assert.deepEqual(await readDevnetDeliveryEvidence(capability, { jobId: JOB, seller: writer }), { status: 'rejected', reason: 'delivery evidence writer differs' });
  assert.deepEqual(reads, []);
  assert.deepEqual(await readDevnetDeliveryEvidence(capability, { jobId: JOB, seller: seller.claim }), { status: 'absent' });
  assert.deepEqual(reads, [EVIDENCE_ADDRESS]);
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

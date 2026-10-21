// DACS-4 §9.6.1 DV-2 (access-mode fidelity). This client writes and reads only
// public storage programs. A Listing that declares any other deliverable access
// model is refused before a purchase or a seller session, and a buyer readback
// of such a deliverable is indeterminate (confidentiality downgrade), never
// delivery-ready or delivered. An absent accessModel is public.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentHash } from '@kynesyslabs/dacs';
import { readDemDeliveryReady } from '../src/dacs/dem-delivery-consumer.mjs';
import { createNativeDemDeliveryCapability } from '../src/dacs/native-dem-delivery-consumer.mjs';
import { deliverableAddress, listingPin, protocolSupport, SUPPORTED_PIPELINE } from '../src/dacs/purchase-protocol.mjs';
import { deliverableAccessModel, purchaseSupport } from '../src/dacs/listing.mjs';
import { DEVNET_PURCHASED_REPORT_KIND } from '../src/devnet-demo/deliverable.mjs';

const jobId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const seller = 'did:demos:agent:' + 'a'.repeat(64), buyer = 'did:demos:agent:' + 'b'.repeat(64);
const ABSENT = Symbol('absent');
const PUBLIC = [['absent', ABSENT], ['public', 'public']];
const NOT_PUBLIC = [['buyer-only', 'buyer-only'], ['encrypt-to-buyer', 'encrypt-to-buyer'], ['unknown', 'TEST-private'], ['non-string', { model: 'public' }], ['null', null]];

function listingWith(accessModel) {
  const deliverable = { kind: 'storage-program', ...(accessModel === ABSENT ? {} : { accessModel }) };
  return { listingId: 'TEST-listing', listingVersion: 1, offering: { deliverable }, pricing: { kind: 'fixed', price: { amount: '2.5', currency: 'DEM' } },
    pipeline: SUPPORTED_PIPELINE.map((kind) => kind === 'pay-dem' ? { kind, parameters: { rail: 'demos-native:DEM' } } : { kind }) };
}

// A verified public readback of the bound Deliverable (the client's only read path).
function deliveryWorld(listing, { tamper = false } = {}) {
  const agreement = { jobId, listingRef: listingPin(listing), parties: [{ role: 'buyer', primaryClaim: buyer }, { role: 'seller', primaryClaim: seller }],
    terms: { price: { amount: '2.5', currency: 'DEM' }, payoutBindings: [{ railId: 'demos-native:DEM', phaseIndex: 2, payeeAddress: '0x' + 'a'.repeat(64) }], deadline: 1 } };
  const report = { reportVersion: '1', kind: DEVNET_PURCHASED_REPORT_KIND, jobId, agreementHash: contentHash(agreement), listing: listingPin(listing), producer: seller,
    settlementId: 'TEST-settlement', title: 'TEST report', content: { mediaType: 'text/plain; charset=utf-8', text: 'TEST' } };
  const receipt = { receiptVersion: '1', substrate: 'demos', finalityProfile: 'TEST', logicalAddress: deliverableAddress(jobId), nativeAddress: 'stor-' + '0'.repeat(40),
    contentHash: contentHash(report), writer: seller, nonce: '1', state: 'finalized', observationDisposition: 'established', transactionRef: { kind: 'demos-storage-program', value: '1'.repeat(64) },
    blockRef: { id: 'c'.repeat(64), height: '1', timestamp: 1 } };
  const answer = { settlementId: 'TEST-settlement', delivery: { status: 'delivery-ready', logicalAddress: deliverableAddress(jobId), contentHash: contentHash(report), evidenceHash: 'e'.repeat(64),
    fulfilmentId: 'TEST-fulfilment', anchorReceipt: receipt } };
  const unused = async () => { throw new Error('not used'); };
  const nativeDemDelivery = createNativeDemDeliveryCapability({ authority: 'TEST-dv2', submit: unused, reconcile: unused, read: unused, verifyReceipt: unused });
  const reads = [];
  const read = { ...structuredClone(report), ...(tamper ? { title: 'TEST other report' } : {}) };
  const chainReadback = {
    readDeliverable: async () => { reads.push('deliverable'); return { status: 'present', artifact: read, receipt: structuredClone(receipt), signedProjection: {} }; },
    readDeliveryEvidence: async () => { reads.push('evidence'); return { status: 'indeterminate', reason: 'TEST evidence later' }; },
  };
  return { reads, check: () => readDemDeliveryReady({ anchors: null, nativeDemDelivery, agreement, listing, seller, answer, chainReadback }) };
}

test('an absent deliverable accessModel is public; any other value is returned as declared', () => {
  assert.equal(deliverableAccessModel(listingWith(ABSENT)), 'public');
  for (const [, model] of [...PUBLIC.slice(1), ...NOT_PUBLIC]) assert.deepEqual(deliverableAccessModel(listingWith(model)), model);
});

for (const [name, model] of PUBLIC) {
  test(`DV-2: ${name} accessModel is admitted and a public readback is delivery-ready`, async () => {
    const listing = listingWith(model);
    assert.deepEqual(protocolSupport(listing).reasons, []);
    assert.equal(protocolSupport(listing).supported, true);
    assert.ok(!purchaseSupport(listing).reasons.some((reason) => /accessModel/.test(reason)));
    const w = deliveryWorld(listing), result = await w.check();
    assert.equal(result.disposition, 'present');
    assert.equal(result.delivery.status, 'delivery-ready');
    assert.equal(result.flag, undefined);
    assert.deepEqual(w.reads, ['deliverable', 'evidence']);
  });
}

for (const [name, model] of NOT_PUBLIC) {
  test(`DV-2: ${name} accessModel is refused before purchase and indeterminate on a public readback`, async () => {
    const listing = listingWith(model);
    const support = protocolSupport(listing);
    assert.equal(support.supported, false);
    assert.equal(support.reasons.length, 1);
    assert.match(support.reasons[0], /accessModel .*is not public; this client reads only public deliverables \(DACS-4 §9\.6\.1 DV-2\)/);
    assert.equal(purchaseSupport(listing).supported, false);
    assert.ok(purchaseSupport(listing).reasons.includes(support.reasons[0]));
    // A purchase bound to such a Listing (or one retained from before) never
    // reaches delivery-ready or delivered from a public readback.
    const w = deliveryWorld(listing), result = await w.check();
    assert.equal(result.disposition, 'indeterminate');
    assert.equal(result.flag, 'confidentiality-downgrade');
    assert.match(result.reason, /deliverable resolved as public \(DACS-4 §9\.6\.1 DV-2 confidentiality downgrade\)$/);
    assert.equal(result.delivery, undefined);
    assert.deepEqual(w.reads, ['deliverable'], 'no delivery evidence is read for a downgraded deliverable');
  });
}

// DACS-1 LRR-3 / LRR-6, in the same admission reasons: a present railVersion
// is the exact version the client implements; an absent one is the latest,
// which is that same version.
for (const [name, rails, refused] of [['version 1', [{ railId: 'demos-native:DEM', railVersion: 1 }], false], ['another version', [{ railId: 'demos-native:DEM', railVersion: 2 }], true],
  ['no version', [{ railId: 'demos-native:DEM' }], false], ['text version', [{ railId: 'demos-native:DEM', railVersion: '1' }], true], ['null version', [{ railId: 'demos-native:DEM', railVersion: null }], true]]) {
  test(`LRR-3: an accepted DEM rail with ${name} is ${refused ? 'refused' : 'admitted'} by rail version`, () => {
    const reasons = purchaseSupport({ ...listingWith('public'), acceptedRails: rails }).reasons;
    assert.equal(reasons.includes('listing does not accept demos-native:DEM version 1'), refused);
  });
}

test('DV-2: an authenticated byte contradiction still rejects a declared non-public deliverable', async () => {
  const result = await deliveryWorld(listingWith('buyer-only'), { tamper: true }).check();
  assert.equal(result.disposition, 'rejected');
  assert.equal(result.authenticated, true);
});

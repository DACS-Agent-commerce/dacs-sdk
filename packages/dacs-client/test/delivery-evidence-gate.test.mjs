// The delivery-evidence gate (DACS-4 §9.6.1 DV-1, consumer side) is the only
// path from delivery-ready to delivered. Delivery evidence is signed by a test
// Ed25519 key generated here and checked by the real SDK
// verifySettlementEvidence; each clause of the gate is broken once and must
// hold the purchase at delivery-ready with the evidence rejected.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { ARTIFACT_SEPARATORS, canonicalize, contentHash, sha256Hex, signComponentArtifact, verifySettlementEvidence } from '@kynesyslabs/dacs';
import { readDemDeliveryReady } from '../src/dacs/dem-delivery-consumer.mjs';
import { createNativeDemDeliveryCapability } from '../src/dacs/native-dem-delivery-consumer.mjs';
import { deliverableAddress, deliveryEvidenceAddress, ed25519Deps, listingPin, SUPPORTED_PIPELINE } from '../src/dacs/purchase-protocol.mjs';
import { DEVNET_PURCHASED_REPORT_KIND } from '../src/devnet-demo/deliverable.mjs';

const jobId = '01ARZ3NDEKTSV4RRFFQ69G5FAV', otherJobId = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const keyPair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { claim: 'did:demos:agent:' + Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex'), privateKey };
};
const sellerKey = keyPair(), otherKey = keyPair();
const seller = sellerKey.claim, buyer = 'did:demos:agent:' + 'b'.repeat(64);
const listing = { listingId: 'TEST-listing', listingVersion: 1, offering: { deliverable: { kind: 'storage-program', accessModel: 'public' } },
  pricing: { kind: 'fixed', price: { amount: '2.5', currency: 'DEM' } },
  pipeline: SUPPORTED_PIPELINE.map((kind) => kind === 'pay-dem' ? { kind, parameters: { rail: 'demos-native:DEM' } } : { kind }) };
const agreement = { jobId, listingRef: listingPin(listing), parties: [{ role: 'buyer', primaryClaim: buyer }, { role: 'seller', primaryClaim: seller }],
  terms: { price: { amount: '2.5', currency: 'DEM' }, payoutBindings: [{ railId: 'demos-native:DEM', phaseIndex: 2, payeeAddress: '0x' + 'a'.repeat(64) }], deadline: 1 } };
const report = { reportVersion: '1', kind: DEVNET_PURCHASED_REPORT_KIND, jobId, agreementHash: contentHash(agreement), listing: listingPin(listing), producer: seller,
  settlementId: 'TEST-settlement', title: 'TEST report', content: { mediaType: 'text/plain; charset=utf-8', text: 'TEST' } };
const receipt = { receiptVersion: '1', substrate: 'demos', finalityProfile: 'TEST', logicalAddress: deliverableAddress(jobId), nativeAddress: 'stor-' + '0'.repeat(40),
  contentHash: contentHash(report), writer: seller, nonce: '1', state: 'finalized', observationDisposition: 'established', transactionRef: { kind: 'demos-storage-program', value: '1'.repeat(64) },
  blockRef: { id: 'c'.repeat(64), height: '1', timestamp: 1 } };

// Seller-signed delivery evidence, built as seller-agent.mjs builds it.
async function signedEvidence({ key = sellerKey, ...change } = {}) {
  const unsigned = { evidenceVersion: '1', jobId, phase: 'deliver-storage-program', outcome: 'success', deliverableContentHash: sha256Hex(canonicalize(report)),
    deliverableAnchor: { kind: 'storage-program', locator: deliverableAddress(jobId) }, observedAt: 2, ...change };
  return signComponentArtifact(unsigned, ARTIFACT_SEPARATORS.SettlementEvidence, { algorithm: 'ed25519', signer: key.claim, sign: (bytes) => new Uint8Array(sign(null, Buffer.from(bytes), key.privateKey)) });
}

function check(evidence, { writer = seller, evidenceHash = contentHash(evidence) } = {}) {
  const answer = { settlementId: 'TEST-settlement', delivery: { status: 'delivery-ready', logicalAddress: deliverableAddress(jobId), contentHash: contentHash(report), evidenceHash,
    fulfilmentId: 'TEST-fulfilment', anchorReceipt: receipt } };
  const unused = async () => { throw new Error('not used'); };
  const nativeDemDelivery = createNativeDemDeliveryCapability({ authority: 'TEST-dv1', submit: unused, reconcile: unused, read: unused, verifyReceipt: unused });
  const chainReadback = {
    readDeliverable: async () => ({ status: 'present', artifact: structuredClone(report), receipt: structuredClone(receipt), signedProjection: {} }),
    readDeliveryEvidence: async () => ({ status: 'present', artifact: structuredClone(evidence), receipt: { ...structuredClone(receipt), logicalAddress: deliveryEvidenceAddress(jobId), contentHash: contentHash(evidence), writer }, signedProjection: {} }),
  };
  return readDemDeliveryReady({ anchors: null, nativeDemDelivery, agreement, listing, seller, answer, chainReadback });
}

test('DV-1 control: seller-signed evidence over the exact Deliverable bytes reaches delivered', async () => {
  const evidence = await signedEvidence();
  const result = await check(evidence);
  assert.equal(result.disposition, 'present');
  assert.equal(result.delivery.status, 'delivered');
  assert.equal(result.delivery.evidencePublication, 'native-read-back');
  assert.equal(result.delivery.evidenceHold, undefined);
  assert.deepEqual(result.delivery.evidenceRef, { anchor: { kind: 'storage-program', locator: deliveryEvidenceAddress(jobId) }, contentHash: contentHash(evidence) });
});

// The SDK verdict on each broken record, given the gate's own context. Where
// it is `pass`, only the client's clause stands between the record and delivered.
const sdkVerdict = async (evidence) => (await verifySettlementEvidence(evidence, { orchestrator: seller, agreement: { amount: '2.5', currency: 'DEM' },
  attestationRef: { anchor: { kind: 'storage-program', locator: deliveryEvidenceAddress(jobId) }, contentHash: contentHash(evidence) }, result: { ok: true },
  expectedAnchorLocator: deliverableAddress(jobId) }, ed25519Deps)).decision;

const broken = [
  ['deliverableContentHash binds other bytes', 'pass', async () => [await signedEvidence({ deliverableContentHash: sha256Hex(canonicalize({ ...report, title: 'TEST other report' })) })]],
  ['evidence receipt writer is not the seller', 'pass', async () => [await signedEvidence(), { writer: buyer }]],
  ['evidence names another jobId', 'pass', async () => [await signedEvidence({ jobId: otherJobId })]],
  ['evidence hash differs from the seller pointer', 'pass', async () => [await signedEvidence(), { evidenceHash: 'e'.repeat(64) }]],
  ['evidence outcome is not success', 'fail', async () => [await signedEvidence({ outcome: 'failure' })]],
  ['evidence phase is not deliver-storage-program', 'error', async () => [await signedEvidence({ phase: 'pay-dem' })]],
  ['evidence is signed by another key (SDK verifier fails)', 'fail', async () => {
    const forged = await signedEvidence({ key: otherKey });
    return [{ ...forged, signature: { ...forged.signature, signer: seller } }];
  }],
];
for (const [name, sdk, build] of broken) {
  test(`DV-1 gate: ${name} holds delivery-ready with the evidence rejected`, async () => {
    const [evidence, options] = await build();
    assert.equal(await sdkVerdict(evidence), sdk);
    const result = await check(evidence, options);
    assert.equal(result.disposition, 'present');
    assert.equal(result.delivery.status, 'delivery-ready');
    assert.equal(result.delivery.evidenceHold.status, 'rejected');
    assert.equal(result.delivery.evidenceHold.reason, 'delivery evidence differs from the verified Deliverable');
    assert.equal(result.delivery.evidencePublication, 'held-evidence-rejected');
    assert.equal(result.delivery.evidenceRef, undefined);
    assert.equal(result.evidenceAuthenticated, true);
  });
}

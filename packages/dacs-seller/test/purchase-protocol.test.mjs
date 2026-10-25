import test from 'node:test';
import assert from 'node:assert/strict';
import { attestationBundleHash, contentHash, sha256Hex, signComponentArtifact, ARTIFACT_SEPARATORS } from '@kynesyslabs/dacs';
import { fixtureListing } from './fixtures/listings.mjs';
import { fixtureRef } from '../src/dacs/fixture-anchors.mjs';
import { protocolSupport, agreementInput, agreementTerms, claimPublicKeyRaw, deliverableAddress, deliveryEvidenceAddress, commitmentReader, verifyPaymentEvidence, verifyDelivery, verifyAnchoredCopy, bundleSession, bundleSigningPlan, assembleBundleCopies, paymentEvidenceAddress, bundleAddress, ed25519Deps } from '../src/dacs/purchase-protocol.mjs';
import { buyer, seller, protocolFixture, fixtureRecord, NOW, JOB } from './helpers/protocol-fixture.mjs';

for (const [label, options, mutate] of [['zero price', { price: '0' }], ['unsafe OS amount', { price: '9007199.254740992' }],
  ['missing accepted rail', { acceptedRails: [] }], ['unimplemented rail version', { acceptedRails: [{ railId: 'demos-native:DEM', railVersion: 2 }] }],
  ['private delivery', {}, value => { value.offering.deliverable.accessModel = 'buyer-only'; }]]) {
  test(`unsupported ${label} refuses admission and Agreement input`, () => {
    const listing = fixtureListing(seller, { now: NOW, ...options }); mutate?.(listing);
    assert.equal(protocolSupport(listing).supported, false);
    assert.throws(() => agreementInput({ jobId: JOB, listing, buyerBundle: listing.seller.identity, generatedAt: NOW }));
  });
}

test('positive canonical DEM at the exact safe OS ceiling is supported', () => {
  for (const price of ['0.000000001', '9007199.254740991']) assert.equal(protocolSupport(fixtureListing(seller, { now: NOW, price })).supported, true);
});

test('DACS-4 address derivation refuses noncanonical job IDs first', () => {
  for (const derive of [deliverableAddress, deliveryEvidenceAddress]) for (const invalid of [undefined, null, 7, 'bad:job', JOB.toLowerCase(), '8' + JOB.slice(1)]) assert.throws(() => derive(invalid));
  assert.equal(deliverableAddress(JOB), `dacs4:deliverable:${JOB}`);
});

test('Demos public key decoding admits canonical advisory parameters but rejects alternate key spelling', () => {
  assert.deepEqual(claimPublicKeyRaw(seller.claim + '?region=GB'), claimPublicKeyRaw(seller.claim));
  for (const bad of [seller.claim.toUpperCase(), seller.claim + 'junk', 7, null]) assert.equal(claimPublicKeyRaw(bad), null);
});

test('both parties derive and sign the exact fixed-price Agreement', async () => {
  const f = await protocolFixture(), terms = agreementTerms(f.agreement);
  assert.equal(terms.jobId, JOB); assert.equal(terms.payee, seller.address); assert.equal(terms.price.amountOs, '2500000000');
  assert.equal(f.agreement.signatures.length, 2); assert.equal(terms.listing.contentHash, contentHash(f.listing));
});

test('commitment reads preserve indeterminate disposition and reason', async () => {
  const result = await commitmentReader({ read: async () => ({ status: 'indeterminate', reason: 'TEST timeout' }) }, seller.claim).resolve('TEST-logical');
  assert.equal(result.disposition, 'indeterminate'); assert.equal(result.reason, 'TEST timeout');
});

for (const method of ['payment', 'delivery', 'bundle']) test(`${method} reads preserve uncertainty instead of claiming absence`, async () => {
  const f = await protocolFixture(), uncertain = { status: 'indeterminate', reason: 'TEST timeout' };
  const result = method === 'payment' ? await verifyPaymentEvidence({ ...f, record: uncertain }) : method === 'delivery'
    ? await verifyDelivery({ ...f, deliverable: uncertain, evidenceRecord: { status: 'absent' } })
    : await verifyAnchoredCopy({ record: uncertain, role: 'buyer', jobId: JOB, writer: buyer.claim, expectedHash: 'a'.repeat(64) });
  assert.equal(result.status, 'indeterminate'); assert.equal(result.reason, 'TEST timeout');
});

test('payment evidence accepts a qualified seller identity and rejects a different key', async () => {
  const f = await protocolFixture(), address = paymentEvidenceAddress(JOB, 'demos-native:DEM', 2);
  const evidence = { evidenceVersion: '1', jobId: JOB, phase: 'pay-dem', outcome: 'success', observedAt: NOW,
    paymentTxRefs: [{ kind: 'demos', ...f.observed }], paymentAmount: { amount: '2.5', currency: 'DEM' }, settlementFinality: { model: 'bft-final', finalityObservedAt: NOW } };
  const signed = await signComponentArtifact(evidence, ARTIFACT_SEPARATORS.SettlementEvidence, { algorithm: 'ed25519', signer: seller.claim + '?region=GB', sign: seller.signBytes });
  assert.equal((await verifyPaymentEvidence({ ...f, record: fixtureRecord(address, signed) })).status, 'verified');
  const changed = await signComponentArtifact(evidence, ARTIFACT_SEPARATORS.SettlementEvidence, { algorithm: 'ed25519', signer: buyer.claim, sign: buyer.signBytes });
  assert.equal((await verifyPaymentEvidence({ ...f, record: fixtureRecord(address, changed) })).status, 'rejected');
});

test('anchored bundle references and receipts use the role-independent bundle signed scope', async () => {
  const f = await protocolFixture(), ref = label => fixtureRef('TEST-' + label, sha256Hex('TEST ' + label));
  const session = bundleSession({ ...f, agreementRef: ref('agreement'), commitmentRef: ref('commitment'), payment: ref('payment'), delivery: ref('delivery'), finalisedAt: NOW });
  const plan = await bundleSigningPlan(session), signatures = { buyer: buyer.signBytes(Buffer.from(plan.message)).toString('base64url'), seller: seller.signBytes(Buffer.from(plan.message)).toString('base64url') };
  const { copies, problems } = await assembleBundleCopies(session, signatures); assert.deepEqual(problems, []);
  const copy = copies.buyerCopy, hash = attestationBundleHash(copy); assert.notEqual(hash, contentHash(copy));
  const record = fixtureRecord(bundleAddress(JOB, 'buyer'), copy, buyer, hash);
  const result = await verifyAnchoredCopy({ record, role: 'buyer', jobId: JOB, writer: buyer.claim, expectedHash: hash, ownCopy: copies.sellerCopy });
  assert.equal(result.status, 'verified', JSON.stringify(result)); assert.equal(result.ref.contentHash, hash);
  const broken = await assembleBundleCopies(session, { ...signatures, buyer: Buffer.alloc(64).toString('base64url') });
  assert.ok(broken.problems.length > 0);
});


test('protocol signature backend refuses small-order keys for arbitrary messages', () => {
  const key = Buffer.from('01' + '00'.repeat(31), 'hex');
  const signature = Buffer.from('01' + '00'.repeat(63), 'hex');
  for (const message of ['TEST first', 'TEST second']) assert.equal(ed25519Deps.verify(Buffer.from(message), signature, key), false);
  const bytes = Buffer.from('TEST genuine');
  assert.equal(ed25519Deps.verify(bytes, buyer.signBytes(bytes), claimPublicKeyRaw(buyer.claim)), true);
});

for (const forgedRole of ['buyer', 'seller']) test(`bundle assembly and anchored copies refuse a small-order ${forgedRole} signature`, async () => {
  const f = await protocolFixture(), ref = label => fixtureRef('TEST-' + label, sha256Hex('TEST ' + label));
  const session = bundleSession({ ...f, agreementRef: ref('agreement'), commitmentRef: ref('commitment'), payment: ref('payment'), delivery: ref('delivery'), finalisedAt: NOW });
  session[forgedRole].primaryClaim = 'did:demos:agent:01' + '00'.repeat(31);
  const plan = await bundleSigningPlan(session);
  const signatures = { buyer: buyer.signBytes(plan.payload).toString('base64url'), seller: seller.signBytes(plan.payload).toString('base64url'),
    [forgedRole]: Buffer.from('01' + '00'.repeat(63), 'hex').toString('base64url') };
  const { copies, problems } = await assembleBundleCopies(session, signatures);
  const role = forgedRole === 'buyer' ? 'seller' : 'buyer', writer = role === 'seller' ? seller : buyer;
  const copy = copies[role + 'Copy'], hash = attestationBundleHash(copy);
  const record = fixtureRecord(bundleAddress(JOB, role), copy, writer, hash);
  const result = await verifyAnchoredCopy({ record, role, jobId: JOB, writer: writer.claim, expectedHash: hash });
  assert.equal(result.status, 'rejected');
  assert.ok(problems.length > 0);
});

test('delivery evidence verifies exact payload bindings and rejects a changed payload', async () => {
  const f = await protocolFixture(), address = deliverableAddress(JOB), evidenceAddress = deliveryEvidenceAddress(JOB);
  const artifact = { jobId: JOB, agreementHash: contentHash(f.agreement), report: 'TEST report' };
  const evidence = await signComponentArtifact({ evidenceVersion: '1', jobId: JOB, phase: 'deliver-storage-program', outcome: 'success', observedAt: NOW,
    deliverableContentHash: sha256Hex(JSON.stringify(artifact, Object.keys(artifact).sort())), deliverableAnchor: { kind: 'storage-program', locator: address } },
    ARTIFACT_SEPARATORS.SettlementEvidence, { algorithm: 'ed25519', signer: seller.claim, sign: seller.signBytes });
  const evidenceRecord = fixtureRecord(evidenceAddress, evidence);
  assert.equal((await verifyDelivery({ ...f, deliverable: fixtureRecord(address, artifact), evidenceRecord })).status, 'verified');
  assert.equal((await verifyDelivery({ ...f, deliverable: fixtureRecord(address, { ...artifact, report: 'TEST changed' }), evidenceRecord })).status, 'rejected');
});

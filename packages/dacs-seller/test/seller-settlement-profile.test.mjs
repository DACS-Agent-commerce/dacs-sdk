// The native seller profile signs an Agreement only with the operator's
// authenticated Vet context, and commits or takes payment only with the whole
// chain to delivery; the standalone host starts only with that chain. No
// module hooks; real Listing, signers and agent. Every capability records the
// call and refuses, so a refused step is shown to have reached nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@kynesyslabs/dacs';
import * as seller from '../src/index.mjs';
import { createDemDeliveryContext } from '../src/dacs/dem-delivery-context-consumer.mjs';
import { createNativeDemDeliveryCapability } from '../src/dacs/native-dem-delivery-consumer.mjs';
import { createNativePaymentEvidenceConsumer, NATIVE_PAYMENT_EVIDENCE } from '../src/dacs/native-payment-evidence-consumer.mjs';

function key() {
  const pair = generateKeyPairSync('ed25519'), raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return { address: `0x${raw.toString('hex')}`, claim: `did:demos:agent:${raw.toString('hex')}`,
    sign: (bytes) => sign(null, Buffer.from(bytes), pair.privateKey),
    signWallet: (message) => `0x${sign(null, Buffer.from(message, 'utf8'), pair.privateKey).toString('hex')}` };
}
const identityFor = (party, presentedAt) => {
  const unsigned = seller.buildUnsignedIdentityBundle({ address: party.address, presentedAt, sessionSeed: 'settlement-profile' });
  return seller.attachIdentityPresentation(unsigned, party.signWallet(unsigned.message));
};

function world(t) {
  const sellerKey = key(), buyerKey = key(), now = Date.now(), reached = [];
  const draft = seller.buildListingDraft({ identityBundle: identityFor(sellerKey, now - 1000), displayName: 'Profile seller', publicEndpoint: 'https://seller.invalid/agent',
    listingId: 'settlement-profile', listingVersion: 1, title: 'Settlement profile report', description: 'Settlement profile vectors.',
    category: 'services.market-report', tags: ['profile'], priceDem: '2.5', notBefore: now - 60000 });
  const listing = seller.attachListingSignature(draft, sellerKey.signWallet(seller.listingSigningMessage(draft)));
  const refuse = (name) => async () => { reached.push(name); throw new Error(`${name} is not reached`); };
  const dir = () => { const path = realpathSync(mkdtempSync(join(tmpdir(), 'seller-settlement-profile-'))); t.after(() => rmSync(path, { recursive: true, force: true })); return path; };
  const jobId = core.generateCanonicalJobId(), buyerBundle = identityFor(buyerKey, now);
  // The operator's Vet context: orchestrator-signed references at the canonical composite addresses.
  const vetRef = (party) => ({ anchor: { kind: 'storage-program', locator: core.compositeVerificationAddress(jobId, party) },
    contentHash: core.sha256Hex(`vet:${jobId}:${party}`), signer: sellerKey.claim });
  const synthetic = seller.agreementInput({ jobId, listing, buyerBundle, generatedAt: now });
  const vetted = { ...synthetic, buyer: { ...synthetic.buyer, vetRecordRef: vetRef(buyerKey.claim) }, seller: { ...synthetic.seller, vetRecordRef: vetRef(sellerKey.claim) } };
  // The not-performed references with the orchestrator named, as a context could return them.
  const signedSynthetic = { ...synthetic, buyer: { ...synthetic.buyer, vetRecordRef: { ...synthetic.buyer.vetRecordRef, signer: sellerKey.claim } },
    seller: { ...synthetic.seller, vetRecordRef: { ...synthetic.seller.vetRecordRef, signer: sellerKey.claim } } };
  const capabilities = {
    signer: { claim: sellerKey.claim, sign: sellerKey.sign }, listing, now: () => now,
    buyerAccess: seller.createOperatorBuyerAccess({ openBuyerAccess: true }),
    agreementAnchor: { source: 'settlement-profile/agreement-readback', readAgreement: refuse('readAgreement') },
    nativeArtifactAnchor: { writer: sellerKey.claim, publish: refuse('publish'), readRetained: refuse('readRetained'), verifyReceipt: refuse('verifyReceipt') },
    deliverableProducer: () => { reached.push('deliverableProducer'); throw new Error('not reached'); },
    observeDemosTransfer: refuse('observeDemosTransfer'),
  };
  const chain = {
    nativePaymentEvidence: () => createNativePaymentEvidenceConsumer({ rpcUrl: 'http://127.0.0.1:9/', anchorEvidence: refuse('anchorEvidence'), fetchImpl: refuse('fetch') }),
    demDeliveryContext: (input = vetted) => createDemDeliveryContext({ authority: 'TEST-settlement-profile', resolveBuyer: refuse('resolveBuyer'),
      resolveSeller: async () => { reached.push('resolveSeller'); return { disposition: 'present', value: { input: structuredClone(input), vetRequirements: [] } }; } }),
    nativeDemDelivery: () => createNativeDemDeliveryCapability({ authority: 'TEST-settlement-profile', submit: refuse('submit'), reconcile: refuse('reconcile'), read: refuse('read'), verifyReceipt: refuse('deliveryVerifyReceipt') }),
  };
  const proposalFor = async (input) => {
    const plan = core.createFixedPriceAgreementSigningPlan(core.deriveFixedPriceAgreement(input));
    const buyerContribution = await core.createFixedPriceAgreementSignatureContribution(plan, 'buyer', { party: buyerKey.claim, algorithm: 'ed25519', sign: buyerKey.sign });
    const material = { proposalVersion: '1', plan, buyerContribution }, proposal = { ...material, proposalHash: core.sha256Hex(core.canonicalize(material)) };
    const transportIdentity = { jobId, planHash: plan.planHash, agreementHash: plan.agreementHash, buyer: buyerKey.claim, seller: sellerKey.claim, proposalHash: proposal.proposalHash };
    return { proposal, transportIdentity, buyerIdentityBundle: buyerBundle };
  };
  const payment = { jobId, txHash: 'a'.repeat(64), payerPayingKey: buyerKey.claim };
  return { capabilities, chain, dir, reached, jobId, synthetic, signedSynthetic, vetted, proposalFor, payment, listing, signer: capabilities.signer };
}
const refused = async (work) => { try { await work(); return null; } catch (error) { return { code: error.code, status: error.status }; } };
const UNAVAILABLE = { code: 'settlement_profile_unavailable', status: 503 };

test('a native agent without the Vet context and delivery chain signs, commits and takes payment for nothing', async (t) => {
  const w = world(t);
  const agent = await seller.createSellerAgent(w.capabilities);
  t.after(() => agent.close());
  assert.deepEqual(await refused(async () => agent.receiveProposal(await w.proposalFor(w.synthetic))), { code: 'vet_context_required', status: 503 });
  assert.equal(agent.stageOf(w.jobId), null, 'no session is opened for the refused proposal');
  assert.deepEqual(await refused(() => agent.commit({ jobId: w.jobId })), UNAVAILABLE);
  assert.deepEqual(await refused(() => agent.submitPayment(w.payment)), UNAVAILABLE);
  assert.deepEqual(await refused(() => agent.submitPayment({ ...w.payment, nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE })), UNAVAILABLE);
  assert.deepEqual(w.reached, []);
});

test('native payment evidence and the Vet context without native delivery sign the vetted Agreement but commit and take payment for nothing', async (t) => {
  const w = world(t);
  const agent = await seller.createSellerAgent({ ...w.capabilities, durableDirectory: w.dir(), nativePaymentEvidence: w.chain.nativePaymentEvidence(), demDeliveryContext: w.chain.demDeliveryContext() });
  t.after(() => agent.close());
  // A proposal over the synthetic not-performed Vet references is not the vetted Agreement.
  const unvetted = await refused(async () => { const answer = await agent.receiveProposal(await w.proposalFor(w.synthetic)); if (answer.disposition === 'complete') throw Object.assign(new Error('signed'), { code: 'signed' }); });
  assert.notEqual(unvetted?.code, 'signed', 'the synthetic Vet references are never signed');
  const vetted = await agent.receiveProposal(await w.proposalFor(w.vetted));
  assert.equal(vetted.disposition, 'complete');
  assert.deepEqual(await refused(() => agent.commit({ jobId: w.jobId })), UNAVAILABLE);
  assert.deepEqual(await refused(() => agent.submitPayment({ ...w.payment, nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE })), UNAVAILABLE);
  assert.deepEqual(w.reached.filter((name) => name !== 'resolveSeller'), [], 'no Agreement read, publication, transfer observation or delivery');
});

test('the complete native profile takes payment only as native payment evidence, before any transfer is observed', async (t) => {
  const w = world(t);
  const agent = await seller.createSellerAgent({ ...w.capabilities, durableDirectory: w.dir(), nativePaymentEvidence: w.chain.nativePaymentEvidence(),
    demDeliveryContext: w.chain.demDeliveryContext(), nativeDemDelivery: w.chain.nativeDemDelivery() });
  t.after(() => agent.close());
  assert.equal((await agent.receiveProposal(await w.proposalFor(w.vetted))).disposition, 'complete');
  assert.deepEqual(await refused(() => agent.submitPayment(w.payment)), { code: 'native_evidence_required', status: 409 });
  assert.deepEqual(w.reached.filter((name) => name !== 'resolveSeller'), []);
});

test('a Vet context that names the not-performed Vet references is not signed', async (t) => {
  const w = world(t);
  for (const input of [w.synthetic, w.signedSynthetic]) {
    const agent = await seller.createSellerAgent({ ...w.capabilities, durableDirectory: w.dir(), nativePaymentEvidence: w.chain.nativePaymentEvidence(),
      demDeliveryContext: w.chain.demDeliveryContext(input), nativeDemDelivery: w.chain.nativeDemDelivery() });
    const answer = await agent.receiveProposal(await w.proposalFor(input));
    agent.close();
    assert.equal(answer.disposition, 'rejected');
    assert.equal(answer.contribution, undefined, 'no seller contribution is issued');
  }
  assert.deepEqual(w.reached.filter((name) => name !== 'resolveSeller'), []);
});

test('the standalone host refuses to start without the whole chain to delivery', async (t) => {
  const w = world(t);
  const { nativeArtifactAnchor: artifactAnchor, ...rest } = w.capabilities;
  const { now: _now, ...required } = rest;
  for (const missing of ['nativePaymentEvidence', 'demDeliveryContext', 'nativeDemDelivery']) {
    const dataDirectory = w.dir();
    const options = { ...required, artifactAnchor, dataDirectory, nativePaymentEvidence: w.chain.nativePaymentEvidence(), demDeliveryContext: w.chain.demDeliveryContext(), nativeDemDelivery: w.chain.nativeDemDelivery() };
    delete options[missing];
    await assert.rejects(seller.startSellerHost(options), { name: 'TypeError', message: new RegExp(`requires ${missing}$`) });
    assert.deepEqual(readdirSync(dataDirectory), [], `nothing is opened without ${missing}`);
  }
  assert.deepEqual(w.reached, []);
});

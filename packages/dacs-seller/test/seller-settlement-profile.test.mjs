// The native seller profile signs an Agreement only with the operator's
// authenticated Vet context and over a rail its steward-signed rail authority
// makes selectable, pinned into the session first, and commits or takes
// payment only with the whole chain to delivery and that pin; the standalone
// host starts only with that chain and the rail authority. No
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
import { railSteward } from './helpers/rail-authority-fixture.mjs';

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
  const sellerKey = key(), buyerKey = key(), now = Date.now(), reached = [], steward = railSteward();
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
    railAuthority: steward.railAuthority(),
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
  return { capabilities, chain, dir, reached, jobId, synthetic, signedSynthetic, vetted, proposalFor, payment, listing, signer: capabilities.signer, steward };
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

const complete = (w, extra = {}) => ({ ...w.capabilities, nativePaymentEvidence: w.chain.nativePaymentEvidence(), demDeliveryContext: w.chain.demDeliveryContext(),
  nativeDemDelivery: w.chain.nativeDemDelivery(), ...extra });

test('without the steward-signed rail authority the native profile is refused before any state is opened', async (t) => {
  const w = world(t), durableDirectory = w.dir();
  for (const railAuthority of [undefined, null]) {
    await assert.rejects(seller.createSellerAgent(complete(w, { durableDirectory, railAuthority })), { name: 'TypeError', message: /native seller profile needs railAuthority/ });
  }
  assert.deepEqual(readdirSync(durableDirectory), [], 'no durable state is created');
  assert.deepEqual(w.reached, []);
});

for (const [name, authority] of [
  ['disabled', { changes: { availability: 'disabled' } }],
  ['failed', { changes: { availability: 'failed' } }],
  ['operator-gated without preflight', { changes: { availability: 'operator_gated' } }],
  ['mocked in production', { changes: { availability: 'mocked' }, authority: { production: true } }],
  ['mocked, which payment intake cannot settle', { changes: { availability: 'mocked' } }],
]) test(`a new session does not select a ${name} rail: no Agreement is signed`, async (t) => {
  const w = world(t);
  const agent = await seller.createSellerAgent(complete(w, { durableDirectory: w.dir(), railAuthority: w.steward.railAuthority(authority) }));
  t.after(() => agent.close());
  assert.deepEqual(await refused(async () => agent.receiveProposal(await w.proposalFor(w.vetted))), { code: 'rail_unavailable', status: 503 });
  assert.equal(agent.stageOf(w.jobId), null, 'no session, pin or contribution is kept');
  assert.deepEqual(w.reached, []);
});

test('a rail authority that is not the steward-signed demos-native:DEM PA-1 definition is refused at construction', async (t) => {
  const w = world(t), other = railSteward();
  const forged = w.steward.railAuthority(); forged.rail.availability = 'live'; forged.rail.parameters = { changed: true };
  const unsigned = w.steward.railAuthority(); delete unsigned.rail.signature;
  for (const [railAuthority, message] of [
    [forged, /not a RailDefinition signed by the steward \(signature-invalid\)/],
    [unsigned, /signed by the steward \(signature-missing\)/],
    [{ ...w.steward.railAuthority(), stewardClaim: other.stewardClaim, stewardPublicKey: other.stewardPublicKey }, /signed by the steward/],
    [w.steward.railAuthority({ changes: { railVersion: 2 } }), /not demos-native:DEM version 1 on pay-dem/],
    [w.steward.railAuthority({ changes: { governance: { proposedBy: w.steward.stewardClaim, acceptedAt: 1, anchoring: 'single-signer' } } }), /PA-1 in-code definition/],
    [{ ...w.steward.railAuthority(), production: 'yes' }, /local operator policy/],
    [{ ...w.steward.railAuthority(), extra: 1 }, /railAuthority must be exactly/],
  ]) await assert.rejects(seller.createSellerAgent(complete(w, { durableDirectory: w.dir(), railAuthority })), { name: 'TypeError', message });
  await assert.rejects(seller.createSellerAgent({ signer: w.signer, listing: w.listing, observeDemosTransfer: async () => null, anchors: { read: async () => null, write: async () => null }, simulatedFixture: true, railAuthority: w.steward.railAuthority() }),
    { name: 'TypeError', message: /simulated fixture profile takes no railAuthority/ });
  assert.deepEqual(w.reached, []);
});

test('an in-flight session keeps its pinned rail across a restart; a pin the steward did not sign is refused before any read', async (t) => {
  const w = world(t), durableDirectory = w.dir();
  const first = await seller.createSellerAgent(complete(w, { durableDirectory }));
  assert.equal((await first.receiveProposal(await w.proposalFor(w.vetted))).disposition, 'complete');
  const pinned = first.durableSessionOf(w.jobId).railPin;
  assert.equal(pinned.basis, 'pa1-in-code');
  assert.equal(pinned.rail.availability, 'live');
  first.close();
  // The steward's later revision disables the rail: new sessions may not select
  // it, the pinned one continues (RAV-R2) and reaches the Agreement readback.
  const disabled = await seller.createSellerAgent(complete(w, { durableDirectory, railAuthority: w.steward.railAuthority({ changes: { availability: 'disabled' } }) }));
  assert.notEqual((await refused(() => disabled.commit({ jobId: w.jobId })))?.code, 'rail_unavailable');
  assert.ok(w.reached.includes('readAgreement'), 'the in-flight session got past the rail gate');
  assert.deepEqual(disabled.durableSessionOf(w.jobId).railPin, pinned, 'the pin is not rewritten');
  disabled.close();
  w.reached.length = 0;
  // Another steward key does not authenticate the retained pin.
  const other = railSteward();
  const foreign = await seller.createSellerAgent(complete(w, { durableDirectory, railAuthority: other.railAuthority() }));
  t.after(() => foreign.close());
  assert.deepEqual(await refused(() => foreign.commit({ jobId: w.jobId })), { code: 'rail_unavailable', status: 503 });
  assert.deepEqual(await refused(() => foreign.submitPayment({ ...w.payment, nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE })), { code: 'rail_unavailable', status: 503 });
  assert.deepEqual(w.reached, [], 'no Agreement read, publication or transfer observation');
});

test('the standalone host refuses to start without the whole chain to delivery', async (t) => {
  const w = world(t);
  const { nativeArtifactAnchor: artifactAnchor, ...rest } = w.capabilities;
  const { now: _now, ...required } = rest;
  for (const missing of ['nativePaymentEvidence', 'demDeliveryContext', 'nativeDemDelivery', 'railAuthority']) {
    const dataDirectory = w.dir();
    const options = { ...required, artifactAnchor, dataDirectory, nativePaymentEvidence: w.chain.nativePaymentEvidence(), demDeliveryContext: w.chain.demDeliveryContext(), nativeDemDelivery: w.chain.nativeDemDelivery() };
    delete options[missing];
    await assert.rejects(seller.startSellerHost(options), { name: 'TypeError', message: new RegExp(`requires ${missing}$`) });
    assert.deepEqual(readdirSync(dataDirectory), [], `nothing is opened without ${missing}`);
  }
  assert.deepEqual(w.reached, []);
});

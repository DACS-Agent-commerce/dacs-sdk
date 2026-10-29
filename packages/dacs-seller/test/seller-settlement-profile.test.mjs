const nativeStage=false; // This part deliberately stages native settlement.
// Native proposal admission and authenticated Vet contexts use real fixed-key
// Listings, exact session challenges and durable contribution recovery.
// Commitment, payment and delivery behavior is introduced separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, sign, verify } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import * as core from '@kynesyslabs/dacs';
import { sellerApi as seller } from './helpers/seller-internal-api.mjs';
import { createDemDeliveryContext } from '../src/dacs/dem-delivery-context-consumer.mjs';
import { createNativeDemDeliveryCapability } from '../src/dacs/native-dem-delivery-consumer.mjs';
import { createNativePaymentEvidenceConsumer, NATIVE_PAYMENT_EVIDENCE } from '../src/dacs/native-payment-evidence-consumer.mjs';
import { SELLER_PRE_EFFECT_REFUSALS } from '../src/dacs/seller-http.mjs';
import { SESSION_CHALLENGE_LIFETIME_MS, vetAnchorReceiptProblem } from '../src/dacs/session-admission.mjs';
import { railAuthorityConfig } from '../src/dacs/rail-authority.mjs';
import { railSteward } from './helpers/rail-authority-fixture.mjs';
import { createSessionAdmissionFixture } from './helpers/session-admission-fixture.mjs';

let nextWallet=90;
function key(){const tag=nextWallet++,privateKey=core.privateKeyFromSeed(new Uint8Array(32).fill(tag)),raw=Buffer.from(core.rawPublicKey(core.publicKeyFromSeed(new Uint8Array(32).fill(tag))));return{privateKey,address:'0x'+raw.toString('hex'),claim:'did:demos:agent:'+raw.toString('hex'),sign:bytes=>Buffer.from(core.ed25519Sign(bytes,privateKey)),signWallet:message=>'0x'+Buffer.from(core.ed25519Sign(Buffer.from(message),privateKey)).toString('hex')};}
const identityFor = (party, presentedAt) => {
  const unsigned = seller.buildUnsignedIdentityBundle({ address: party.address, presentedAt, sessionSeed: 'settlement-profile' });
  return seller.attachIdentityPresentation(unsigned, party.signWallet(unsigned.message));
};
// A presentation carrying a given session nonce, signed by the party.
const presentWith = (party, presentedAt, sessionNonce) => {
  const unsigned = seller.buildUnsignedIdentityBundle({ address: party.address, presentedAt, sessionSeed: 'settlement-profile' });
  const bundle = { ...unsigned.bundle, sessionNonce }, bundleHash = core.sha256Hex(core.canonicalize(bundle));
  return seller.attachIdentityPresentation({ bundle, bundleHash }, party.signWallet(unsigned.message.replace(unsigned.bundleHash, bundleHash)));
};
// A presentation that carries no session nonce at all, signed by the party.
const presentWithout = (party, presentedAt) => {
  const unsigned = seller.buildUnsignedIdentityBundle({ address: party.address, presentedAt, sessionSeed: 'settlement-profile' });
  const { sessionNonce: _nonce, ...bundle } = unsigned.bundle, bundleHash = core.sha256Hex(core.canonicalize(bundle));
  return seller.attachIdentityPresentation({ bundle, bundleHash }, party.signWallet(unsigned.message.replace(unsigned.bundleHash, bundleHash)));
};

async function world(t, { listingChanges = () => {} } = {}) {
  const sellerKey = key(), buyerKey = key(), now = 1780000000000, reached = [], steward = railSteward();
  const admission = createSessionAdmissionFixture({ seller: sellerKey, buyer: buyerKey, now: () => now });
  const draft = seller.buildListingDraft({ identityBundle: identityFor(sellerKey, now - 1000), displayName: 'Profile seller', publicEndpoint: 'https://seller.invalid/agent',
    listingId: 'settlement-profile', listingVersion: 1, title: 'Settlement profile report', description: 'Settlement profile vectors.',
    expectedSizeBytes: 1024, category: 'services.market-report', tags: ['profile'], priceDem: '2.5', notBefore: now - 60000 });
  listingChanges(draft);
  const listing = seller.attachListingSignature(draft, sellerKey.signWallet(seller.listingSigningMessage(draft)));
  const refuse = (name) => async () => { reached.push(name); throw new Error(`${name} is not reached`); };
  let challengeSnapshot = null;
  // Each independent scenario forks the verifier's authenticated, pre-attempt
  // ledger. This snapshot is made by a real issuer before the buyer signs;
  // no fixture writes a caller-selected nonce into seller state.
  const dir = ({ empty = false } = {}) => {
    const path = realpathSync(mkdtempSync(join(tmpdir(), 'seller-settlement-profile-')));
    t.after(() => rmSync(path, { recursive: true, force: true }));
    if (challengeSnapshot && !empty) copyFileSync(challengeSnapshot, join(path, 'seller-state.sqlite'));
    return path;
  };
  const capabilities = {
    signer: { claim: sellerKey.claim, sign: sellerKey.sign }, listing, now: () => now,
    buyerAccess: seller.createOperatorBuyerAccess({ openBuyerAccess: true, buyerForJob: candidate => candidate === jobId ? buyerKey.address : null }),
    agreementAnchor: { source: 'settlement-profile/agreement-readback', readAgreement: refuse('readAgreement') },
    nativeArtifactAnchor: { writer: sellerKey.claim, publish: refuse('publish'), readRetained: refuse('readRetained'), verifyReceipt: refuse('verifyReceipt') },
    deliverySchemaVerifier: { schemaUrl: listing.offering.deliverable.schemaUrl, verify: refuse('verifyDeliverySchema') },
    deliverableProducer: () => { reached.push('deliverableProducer'); throw new Error('not reached'); },
    observeDemosTransfer: refuse('observeDemosTransfer'),
    railAuthority: steward.railAuthority(),
    sessionAdmission: admission.sessionAdmission,
  };
  const jobId = core.generateCanonicalJobId(), issuerDirectory = dir();
  const issuer = await seller.createSellerAgent({ ...capabilities, durableDirectory: issuerDirectory,
    now: () => Math.max(now, listing.validity.notBefore) });
  let challenge;
  try { challenge = await issuer.issueSessionChallenge({ jobId, buyer: buyerKey.claim }); }
  finally { issuer.close(); }
  challengeSnapshot = join(issuerDirectory, 'seller-state.sqlite');
  const buyerBundle = presentWith(buyerKey, now, challenge.sessionNonce);
  // The operator's Vet context: references to counterparty-verified records
  // (DACS-2 §7.7.2) the seller's session admission keeps, at the canonical
  // composite addresses.
  const synthetic = seller.agreementInput({ jobId, listing, buyerBundle, generatedAt: now });
  const vetted = { ...synthetic, buyer: { ...synthetic.buyer, vetRecordRef: await admission.vetRecord(jobId, buyerKey.claim, buyerBundle, { requirement: listing.buyerRequirement }) },
    seller: { ...synthetic.seller, vetRecordRef: await admission.vetRecord(jobId, sellerKey.claim, listing.seller.identity, { requirement: listing.buyerRequirement }) } };
  // The not-performed references with each counterparty verifier named, as a context could return them.
  const signedSynthetic = { ...synthetic, buyer: { ...synthetic.buyer, vetRecordRef: { ...synthetic.buyer.vetRecordRef, signer: sellerKey.claim } },
    seller: { ...synthetic.seller, vetRecordRef: { ...synthetic.seller.vetRecordRef, signer: buyerKey.claim } } };
  // The delivery runner's Vet requirement invocations for a context input: one
  // per party record, evaluating that party, naming its counterparty verifier
  // and the requirement the record hashes (the Listing's buyer requirement).
  const invocationsFor = (input) => [['buyer', buyerKey.claim, sellerKey.claim], ['seller', sellerKey.claim, buyerKey.claim]].map(([role, evaluatedParty, verifier]) => ({
    vetRecordRef: structuredClone(input[role].vetRecordRef), evaluatedParty, requirement: structuredClone(listing.buyerRequirement), verifier, freshness: [], dealSpecific: [] }));
  // The seller wallet's journal over wallet primitives that refuse: the native
  // settlement chain takes the evidence anchor and its reconciliation only from
  // one createPaymentEvidenceWalletJournal (`journal()`), in the agent as in the host.
  let walletJournal = null;
  const journal = () => {
    if (!walletJournal) {
      walletJournal = seller.createPaymentEvidenceWalletJournal({ path: join(dir(), 'wallet-journal.sqlite'), signCreate: refuse('anchorEvidence'), broadcast: refuse('broadcast'),
        readAccountNonce: refuse('readAccountNonce'), readTransactionState: refuse('readTransactionState') });
      t.after(() => walletJournal.close());
    }
    return walletJournal;
  };
  const chain = {
    journal,
    nativePaymentEvidence: ({ anchorEvidence = journal().anchorEvidence, fetchImpl = refuse('fetch') } = {}) => createNativePaymentEvidenceConsumer({ rpcUrl: 'http://127.0.0.1:9/', anchorEvidence, fetchImpl }),
    get reconcilePaymentEvidence() { return journal().reconcilePaymentEvidence; },
    demDeliveryContext: (input = vetted, vetRequirements = invocationsFor(input)) => createDemDeliveryContext({ authority: 'TEST-settlement-profile', resolveBuyer: refuse('resolveBuyer'),
      resolveSeller: async () => { reached.push('resolveSeller'); return { disposition: 'present', value: { input: structuredClone(input), vetRequirements: structuredClone(vetRequirements) } }; } }),
    nativeDemDelivery: () => createNativeDemDeliveryCapability({ authority: 'TEST-settlement-profile', submit: refuse('submit'), reconcile: refuse('reconcile'), read: refuse('read'), verifyReceipt: refuse('deliveryVerifyReceipt') }),
  };
  const proposalFor = async (input, proposalJobId = jobId) => {
    const plan = core.createFixedPriceAgreementSigningPlan(core.deriveFixedPriceAgreement(input));
    const buyerContribution = await core.createFixedPriceAgreementSignatureContribution(plan, 'buyer', { party: buyerKey.claim, algorithm: 'ed25519', sign: buyerKey.sign });
    const material = { proposalVersion: '1', plan, buyerContribution }, proposal = { ...material, proposalHash: core.sha256Hex(core.canonicalize(material)) };
    const transportIdentity = { jobId: proposalJobId, planHash: plan.planHash, agreementHash: plan.agreementHash, buyer: buyerKey.claim, seller: sellerKey.claim, proposalHash: proposal.proposalHash };
    return { proposal, transportIdentity, buyerIdentityBundle: buyerBundle };
  };
  const payment = { jobId, txHash: 'a'.repeat(64), payerPayingKey: buyerKey.claim };
  const agent = (options) => seller.createSellerAgent(options);
  return { capabilities, chain, dir, reached, jobId, synthetic, signedSynthetic, vetted, proposalFor, payment, listing, signer: capabilities.signer, steward, buyerKey, sellerKey, buyerBundle, admission, now, agent };
}
const refused = async (work) => { try { await work(); return null; } catch (error) { return { code: error.code, status: error.status }; } };
const UNAVAILABLE = { code: 'settlement_profile_unavailable', status: 503 };
const notCalled = async () => { throw new Error('TEST not called'); };

test('a native agent without the Vet context and delivery chain signs, commits and takes payment for nothing', async (t) => {
  const w = await world(t);
  const agent = await w.agent(w.capabilities);
  t.after(() => agent.close());
  assert.deepEqual(await refused(async () => agent.receiveProposal(await w.proposalFor(w.synthetic))), { code: 'vet_context_required', status: 503 });
  assert.equal(agent.stageOf(w.jobId), null, 'no session is opened for the refused proposal');
  assert.deepEqual(await refused(() => agent.commit({ jobId: w.jobId })), UNAVAILABLE);
  assert.deepEqual(await refused(() => agent.submitPayment(w.payment)), UNAVAILABLE);
  assert.deepEqual(await refused(() => agent.submitPayment({ ...w.payment, nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE })), UNAVAILABLE);
  assert.deepEqual(w.reached, []);
});

test('native payment evidence and the Vet context without native delivery sign the vetted Agreement but commit and take payment for nothing', async (t) => {
  const w = await world(t);
  const agent = await w.agent({ ...w.capabilities, durableDirectory: w.dir(), nativePaymentEvidence: w.chain.nativePaymentEvidence(), demDeliveryContext: w.chain.demDeliveryContext() });
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
  const w = await world(t);
  const agent = await w.agent({ ...w.capabilities, durableDirectory: w.dir(), nativePaymentEvidence: w.chain.nativePaymentEvidence(), reconcilePaymentEvidence: w.chain.reconcilePaymentEvidence,
    demDeliveryContext: w.chain.demDeliveryContext(), nativeDemDelivery: w.chain.nativeDemDelivery() });
  t.after(() => agent.close());
  assert.equal((await agent.receiveProposal(await w.proposalFor(w.vetted))).disposition, 'complete');
  assert.deepEqual(await refused(() => agent.submitPayment(w.payment)), { code: 'native_evidence_required', status: 409 });
  assert.deepEqual(w.reached.filter((name) => name !== 'resolveSeller'), []);
});

test('a Vet context that names the not-performed Vet references is not signed', async (t) => {
  const w = await world(t);
  for (const input of [w.synthetic, w.signedSynthetic]) {
    const agent = await w.agent({ ...w.capabilities, durableDirectory: w.dir(), nativePaymentEvidence: w.chain.nativePaymentEvidence(), reconcilePaymentEvidence: w.chain.reconcilePaymentEvidence,
      demDeliveryContext: w.chain.demDeliveryContext(input), nativeDemDelivery: w.chain.nativeDemDelivery() });
    const answer = await agent.receiveProposal(await w.proposalFor(input));
    agent.close();
    assert.equal(answer.disposition, 'rejected');
    assert.equal(answer.contribution, undefined, 'no seller contribution is issued');
  }
  assert.deepEqual(w.reached.filter((name) => name !== 'resolveSeller'), []);
});

const complete = (w, extra = {}) => ({ ...w.capabilities, nativePaymentEvidence: w.chain.nativePaymentEvidence(), reconcilePaymentEvidence: w.chain.reconcilePaymentEvidence,
  demDeliveryContext: w.chain.demDeliveryContext(), nativeDemDelivery: w.chain.nativeDemDelivery(), ...extra });
// A RevocationMarker for the world's Listing (DACS-1 RB-1), signed by `signerKey`
// (the Listing signer by default) and kept by the admission's marker reader at
// `locator`, and the revoked catalog surface whose binding names it (RB-2).
const revocationOf = async (w, { signerKey = w.sellerKey, locator } = {}) => {
  const listingContentHash = core.contentHash(w.listing), presentedBy = w.listing.seller.identity.presentedBy;
  const marker = await core.signComponentArtifact({ listingId: w.listing.listingId, listingVersion: w.listing.listingVersion, listingContentHash, revokedAt: w.now - 1, reason: 'TEST withdrawn' },
    'dacs-revocation:v1:', { algorithm: 'ed25519', signer: signerKey.claim, sign: signerKey.sign });
  const logicalAddress = `dacs1-revoked:${core.encodeAddressSegment(presentedBy)}:${w.listing.listingId}:v${w.listing.listingVersion}`;
  const binding = { sellerPrimaryClaim: presentedBy, listingId: w.listing.listingId, listingVersion: w.listing.listingVersion, listingContentHash, logicalAddress,
    markerAnchor: { kind: 'storage-program', locator: locator ?? logicalAddress }, markerContentHash: core.contentHash(marker) };
  w.admission.markers.set(binding.markerAnchor.locator, marker);
  return { marker, binding, surface: { kind: 'catalog', status: 'revoked', readStatus: 'ok', catalogObservedAt: w.now, binding } };
};

test('without the steward-signed rail authority the native profile is refused before any state is opened', async (t) => {
  const w = await world(t), durableDirectory = w.dir({ empty: true });
  for (const railAuthority of [undefined, null]) {
    await assert.rejects(w.agent(complete(w, { durableDirectory, railAuthority })), { name: 'TypeError', message: /native seller profile needs railAuthority/ });
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
  const w = await world(t);
  const agent = await w.agent(complete(w, { durableDirectory: w.dir(), railAuthority: w.steward.railAuthority(authority) }));
  t.after(() => agent.close());
  assert.deepEqual(await refused(async () => agent.receiveProposal(await w.proposalFor(w.vetted))), { code: 'rail_unavailable', status: 503 });
  assert.equal(agent.stageOf(w.jobId), null, 'no session, pin or contribution is kept');
  assert.deepEqual(w.reached, []);
});

test('a rail authority that is not the steward-signed demos-native:DEM PA-1 definition is refused at construction', async (t) => {
  const w = await world(t), other = railSteward();
  const forged = w.steward.railAuthority(); forged.rail.availability = 'live'; forged.rail.parameters = { changed: true };
  const unsigned = w.steward.railAuthority(); delete unsigned.rail.signature;
  for (const [railAuthority, message] of [
    [forged, /not a RailDefinition signed by the steward \(signature-invalid\)/],
    [unsigned, /signed by the steward \(signature-missing\)/],
    [{ ...w.steward.railAuthority(), stewardClaim: other.stewardClaim, stewardPublicKey: other.stewardPublicKey }, /signed by the steward/],
    [w.steward.railAuthority({ changes: { railVersion: 2 } }), /not demos-native:DEM version 1 on pay-dem/],
    // DACS-4 §9.5.9 step 1: a steward-signed definition of another asset,
    // network, rail type or handler is refused before any Agreement is signed
    // (by the SDK's RailDefinition check, or by the package's own DEM guard).
    [w.steward.railAuthority({ changes: { asset: { kind: 'native-dem', symbol: 'DEM', decimals: 18 } } }), /not demos-native:DEM version 1 on pay-dem|is not a RailDefinition/],
    [w.steward.railAuthority({ changes: { asset: { kind: 'native-dem', symbol: 'TEST', decimals: 9 } } }), /not demos-native:DEM version 1 on pay-dem|is not a RailDefinition/],
    [w.steward.railAuthority({ changes: { network: { kind: 'demos', extra: 1 } } }), /not demos-native:DEM version 1 on pay-dem|is not a RailDefinition/],
    [w.steward.railAuthority({ changes: { railType: 'x402' } }), /not demos-native:DEM version 1 on pay-dem|is not a RailDefinition/],
    [w.steward.railAuthority({ changes: { phaseHandler: 'TEST-other' } }), /not demos-native:DEM version 1 on pay-dem|is not a RailDefinition/],
    [w.steward.railAuthority({ changes: { governance: { proposedBy: w.steward.stewardClaim, acceptedAt: 1, anchoring: 'single-signer' } } }), /PA-1 in-code definition/],
    [{ ...w.steward.railAuthority(), production: 'yes' }, /local operator policy/],
    [{ ...w.steward.railAuthority(), extra: 1 }, /railAuthority must be exactly/],
  ]) await assert.rejects(w.agent(complete(w, { durableDirectory: w.dir(), railAuthority })), { name: 'TypeError', message });
  await assert.rejects(seller.createSellerAgent({ signer: w.signer, listing: w.listing, observeDemosTransfer: async () => null, anchors: { read: async () => null, write: async () => null }, simulatedFixture: true, railAuthority: w.steward.railAuthority() }),
    { name: 'TypeError', message: /simulated fixture profile takes no railAuthority/ });
  assert.deepEqual(w.reached, []);
});

test('an in-flight session keeps its pinned rail across a restart; a pin the steward did not sign is refused before any read', async (t) => {
  const w = await world(t), durableDirectory = w.dir();
  const first = await w.agent(complete(w, { durableDirectory }));
  assert.equal((await first.receiveProposal(await w.proposalFor(w.vetted))).disposition, 'complete');
  const pinned = first.durableSessionOf(w.jobId).railPin;
  assert.equal(pinned.basis, 'pa1-in-code');
  assert.equal(pinned.rail.availability, 'live');
  first.close();
  // The steward's later revision disables the rail: new sessions may not select
  // it, the pinned one continues (RAV-R2) and reaches the Agreement readback.
  const disabled = await w.agent(complete(w, { durableDirectory, railAuthority: w.steward.railAuthority({ changes: { availability: 'disabled' } }) }));
  assert.notEqual((await refused(() => disabled.commit({ jobId: w.jobId })))?.code, 'rail_unavailable');
  assert.equal(w.reached.includes('readAgreement'), !nativeStage, 'the in-flight session got past the rail gate');
  assert.deepEqual(disabled.durableSessionOf(w.jobId).railPin, pinned, 'the pin is not rewritten');
  disabled.close();
  w.reached.length = 0;
  // Another steward key does not authenticate the retained pin.
  const other = railSteward();
  const foreign = await w.agent(complete(w, { durableDirectory, railAuthority: other.railAuthority() }));
  t.after(() => foreign.close());
  assert.deepEqual(await refused(() => foreign.commit({ jobId: w.jobId })), { code: 'rail_unavailable', status: 503 });
  assert.deepEqual(await refused(() => foreign.submitPayment({ ...w.payment, nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE })), { code: 'rail_unavailable', status: 503 });
  assert.deepEqual(w.reached, [], 'no Agreement read, publication or transfer observation');
});

test('the standalone host refuses to start without the whole chain to delivery', async (t) => {
  const w = await world(t);
  const { nativeArtifactAnchor: artifactAnchor, ...rest } = w.capabilities;
  const { now: _now, ...required } = rest;
  for (const missing of ['nativePaymentEvidence', 'reconcilePaymentEvidence', 'demDeliveryContext', 'nativeDemDelivery', 'railAuthority', 'sessionAdmission']) {
    const dataDirectory = w.dir({ empty: true });
    const options = { ...required, artifactAnchor, dataDirectory, nativePaymentEvidence: w.chain.nativePaymentEvidence(), reconcilePaymentEvidence: w.chain.reconcilePaymentEvidence, demDeliveryContext: w.chain.demDeliveryContext(), nativeDemDelivery: w.chain.nativeDemDelivery() };
    delete options[missing];
    await assert.rejects(seller.startSellerHost(options), { name: 'TypeError', message: new RegExp(`requires ${missing}$`) });
    assert.deepEqual(readdirSync(dataDirectory), [], `nothing is opened without ${missing}`);
  }
  assert.deepEqual(w.reached, []);
});

// ---- The pinned native rail through payment intake, and the HTTP journal ----
// A scripted native chain: the seller's commitment CREATE is retained as
// finalized, the buyer's Agreement reads back once it is anchored, and the
// transfer observation (native payment evidence) counts each fetch and fails.
const clone = (value) => JSON.parse(JSON.stringify(value));
function nativeChain(w) {
  const TX = 'a1'.repeat(32), BLOCK = 'b2'.repeat(32), seen = { publish: 0, fetch: 0 }, retained = { stored: null, agreement: null };
  const nativeArtifactAnchor = {
    writer: w.signer.claim,
    publish: async ({ logicalAddress, artifact }) => {
      seen.publish++;
      const receipt = { receiptVersion: '1', substrate: 'TEST-offline-demos-sr2', finalityProfile: 'TEST-one-node-not-finality', logicalAddress,
        nativeAddress: `TEST-native-${core.sha256Hex(logicalAddress).slice(0, 16)}`, contentHash: core.contentHash(artifact), transactionRef: { kind: 'demos-tx', value: TX },
        writer: w.signer.claim, nonce: '7', state: 'finalized', observationDisposition: 'established', observedAt: w.now + 1000,
        evidence: { kind: 'demos-tx', value: TX }, blockRef: { id: BLOCK, height: '9', timestamp: w.now + 1000 } };
      retained.stored = { artifact: clone(artifact), receipt, txRef: { kind: 'demos', txHash: TX, blockNumber: 9 }, signedProjection: { TEST: 'projection' } };
      return { status: 'present', ...clone(retained.stored) };
    },
    readRetained: async () => (retained.stored ? { status: 'present', ...clone(retained.stored) } : { status: 'absent', reason: 'TEST nothing retained' }),
    verifyReceipt: async () => 'valid',
  };
  const agreementAnchor = { source: 'TEST-agreement',
    readAgreement: async ({ logicalAddress }) => (retained.agreement
      ? { disposition: 'present', artifact: clone(retained.agreement), ref: { anchor: { kind: 'storage-program', locator: logicalAddress }, contentHash: core.contentHash(retained.agreement) },
        native: { source: 'TEST-agreement', evidenceMode: 'TEST-scripted', nativeAddress: 'TEST-native-agreement', txRef: { kind: 'demos', txHash: 'c3'.repeat(32), blockNumber: 8 } } }
      : { disposition: 'absent', reason: 'TEST not anchored' }) };
  const nativePaymentEvidence = w.chain.nativePaymentEvidence({ fetchImpl: async () => { seen.fetch++; throw new Error('TEST transfer observation is not answered'); } });
  const options = (railAuthority, durableDirectory) => ({ ...w.capabilities, nativeArtifactAnchor, agreementAnchor, durableDirectory, railAuthority, nativePaymentEvidence,
    reconcilePaymentEvidence: w.chain.reconcilePaymentEvidence, demDeliveryContext: w.chain.demDeliveryContext(), nativeDemDelivery: w.chain.nativeDemDelivery() });
  // The buyer finalizes the Agreement from both contributions and anchors it.
  const anchorAgreement = async (session) => {
    retained.agreement = await core.finalizeFixedPriceAgreementContributions(session.proposal.plan, [session.proposal.buyerContribution, session.sellerContribution], seller.contributionVerifier);
  };
  return { seen, options, anchorAgreement };
}

const nativeClaim=w=>({...w.payment,nativePaymentEvidence:NATIVE_PAYMENT_EVIDENCE});
test('a committed native session takes its payment claim to the transfer observation under its pinned rail, also after a restart with a later registry version or a disabled revision', async (t) => {
  for (const later of [{ authority: { railRegistryVersion: 2 } }, { changes: { availability: 'disabled' }, authority: { railRegistryVersion: 2 } }]) {
    const w = await world(t), chain = nativeChain(w), durableDirectory = w.dir();
    const first = await w.agent(chain.options(w.steward.railAuthority(), durableDirectory));
    assert.equal((await first.receiveProposal(await w.proposalFor(w.vetted))).disposition, 'complete');
    await chain.anchorAgreement(first.durableSessionOf(w.jobId));
    assert.equal((await first.commit({ jobId: w.jobId })).status, 'committed');
    const pinned = first.durableSessionOf(w.jobId).railPin;
    first.close();
    // The operator moves to registry version 2. RAV-R2: the session keeps the
    // definition it pinned at session start, registry version 1.
    const agent = await w.agent(chain.options(w.steward.railAuthority(later), durableDirectory));
    t.after(() => agent.close());
    assert.deepEqual(agent.durableSessionOf(w.jobId).railPin, pinned, 'the pin, its registry version included, is not rewritten');
    assert.equal(pinned.railRegistryVersion, 1);
    assert.equal((await agent.commit({ jobId: w.jobId })).status, 'committed', 'commitment readback under the pinned rail');
    assert.notEqual((await refused(() => agent.submitPayment(nativeClaim(w))))?.code, 'rail_unavailable');
    assert.ok(chain.seen.fetch > 0, 'payment intake accepted the pinned rail and reached the transfer observation');
    assert.equal(chain.seen.publish, 1, 'one commitment CREATE');
  }
});

test('a proposal the seller did not sign leaves no in-flight pin: its retry selects again under the current rail authority', async (t) => {
  const w = await world(t), durableDirectory = w.dir();
  // The first proposal is rejected (its Vet context names the not-performed references): nothing is signed.
  const first = await w.agent(complete(w, { durableDirectory, demDeliveryContext: w.chain.demDeliveryContext(w.synthetic) }));
  assert.equal((await first.receiveProposal(await w.proposalFor(w.synthetic))).disposition, 'rejected');
  assert.equal(first.durableSessionOf(w.jobId)?.sellerContribution, undefined);
  first.close();
  // The steward disables the rail and keeps the registry version. The retry is a new session: no Agreement is signed.
  const disabled = await w.agent(complete(w, { durableDirectory, railAuthority: w.steward.railAuthority({ changes: { availability: 'disabled' } }) }));
  assert.deepEqual(await refused(async () => disabled.receiveProposal(await w.proposalFor(w.vetted))), { code: 'rail_unavailable', status: 503 });
  assert.equal(disabled.durableSessionOf(w.jobId)?.sellerContribution, undefined, 'no seller contribution');
  disabled.close();
  // Under a live rail the same retry is signed, and its pin is the current definition.
  const live = w.steward.railAuthority();
  const relive = await w.agent(complete(w, { durableDirectory, railAuthority: live }));
  const signed = await relive.receiveProposal(await w.proposalFor(w.vetted));
  assert.equal(signed.disposition, 'complete');
  const session = relive.durableSessionOf(w.jobId);
  assert.equal(session.railPinSigned, true);
  assert.deepEqual(session.railPin.rail, live.rail);
  relive.close();
  // Once signed, the pin is in flight: the signed proposal again under a disabled revision answers the same contribution.
  const after = await w.agent(complete(w, { durableDirectory, railAuthority: w.steward.railAuthority({ changes: { availability: 'disabled' } }) }));
  t.after(() => after.close());
  const again = await after.receiveProposal(await w.proposalFor(w.vetted));
  assert.equal(again.disposition, 'complete');
  assert.deepEqual(again.contribution, signed.contribution);
  assert.deepEqual(w.reached.filter((name) => name !== 'resolveSeller'), []);
});

// The buyer's authenticated transport, the real journal and handler, in process.
function inProcessFetch(handle, last) {
  return async (url, init) => {
    const req = Readable.from([Buffer.from(init.body)]);
    Object.assign(req, { url: new URL(url).pathname, method: init.method, headers: { ...init.headers }, socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' } });
    const res = { destroyed: false, writableEnded: false, headersSent: false, status: 0, headers: {}, text: '',
      writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
      end(text) { this.text = String(text); this.writableEnded = true; } };
    await handle(req, res);
    last.status = res.status; last.answer = JSON.parse(res.text);
    return new Response(res.text, { status: res.status, headers: res.headers });
  };
}
// `gate` maps an agent method to a refusal code it throws once, before calling the agent.
async function httpSeller(t, w, { gate = {} } = {}) {
  const chain = nativeChain(w), durableDirectory = w.dir(), peerDirectory = w.dir(), last = {};
  const build = (railAuthority) => w.agent(chain.options(railAuthority, durableDirectory));
  let agent = await build(w.steward.railAuthority());
  const store = seller.createSellerTransportStore({ path: join(peerDirectory, 'peer.sqlite') });
  t.after(() => { try { agent.close(); } catch { /* closed by a restart */ } store.close(); });
  const pin = seller.listingPin(w.listing);
  const gated = (name) => (body) => {
    const code = gate[name];
    if (code) { delete gate[name]; throw new seller.SellerAgentError(code, `TEST ${code}`, code === 'native_evidence_required' ? 409 : 503); }
    return agent[name](body);
  };
  const facade = { claim: w.signer.claim, listingPin: pin, reconcileTransport: (input) => agent.reconcileTransport(input), agreementState: (identity) => agent.agreementState(identity),
    receiveProposal: gated('receiveProposal'), commit: gated('commit'), submitPayment: gated('submitPayment') };
  const handle = seller.createSellerHttpHandler(facade, { authentication: seller.createSellerTransportServerAuth({ sellerSigner: w.signer, listingPin: pin, store }) });
  const proposal = await w.proposalFor(w.vetted);
  const client = seller.createSellerAgentClient({ url: 'http://127.0.0.1:1', fetchImpl: inProcessFetch(handle, last),
    authentication: seller.createSellerTransportClientAuth({ buyerSigner: { claim: w.buyerKey.claim, sign: w.buyerKey.sign }, seller: w.signer.claim,
      resolveJob: () => ({ listingPin: pin, agreementHash: proposal.proposal.plan.agreementHash }) }) });
  const restart = async (railAuthority) => { agent.close(); agent = await build(railAuthority); };
  return { chain, client, proposal, last, restart, get agent() { return agent; } };
}
const answered = async (work) => { try { await work(); } catch { /* the answer is read from the wire */ } };

test('over HTTP a rail refusal of a payment claim has no effect: the same claim reaches payment intake once the authority is restored', async (t) => {
  const w = await world(t), h = await httpSeller(t, w);
  assert.equal((await h.client.propose(h.proposal)).disposition, 'complete');
  await h.chain.anchorAgreement(h.agent.durableSessionOf(w.jobId));
  assert.equal((await h.client.commit(w.jobId)).status, 'committed');
  const authority = w.steward.railAuthority();
  // Another steward key does not authenticate the session's pin.
  await h.restart(railSteward().railAuthority());
  await answered(() => h.client.submitPayment(nativeClaim(w)));
  assert.deepEqual([h.last.status, h.last.answer.error], [503, 'rail_unavailable']);
  assert.equal(h.chain.seen.fetch, 0);
  await h.restart(authority);
  await answered(() => h.client.submitPayment(nativeClaim(w)));
  assert.notEqual(h.last.answer.error, 'operation_uncertain', 'the refused claim was not journaled as an uncertain effect');
  assert.ok(h.chain.seen.fetch > 0, 'the same claim reached the transfer observation');
});

test('over HTTP a rail refusal of a proposal has no effect: the same proposal is signed once the rail is live again', async (t) => {
  const w = await world(t), h = await httpSeller(t, w);
  await h.restart(w.steward.railAuthority({ changes: { availability: 'disabled' } }));
  await answered(() => h.client.propose(h.proposal));
  assert.deepEqual([h.last.status, h.last.answer.error], [503, 'rail_unavailable']);
  await h.restart(w.steward.railAuthority());
  assert.equal((await h.client.propose(h.proposal)).disposition, 'complete');
  assert.equal(h.agent.durableSessionOf(w.jobId).railPinSigned, true);
});

// Every gate the agent raises before any read, write, signature or send, and its status.
const PRE_EFFECT_GATES = [['vet_context_required', 503], ['session_admission_required', 503], ['settlement_profile_unavailable', 503], ['rail_unavailable', 503], ['native_evidence_required', 409], ['bundle_finalization_unavailable', 503]];

// ---- Session admission: profile, challenge, revocation and Vet records ----
test('a native agent without the seller\'s session admission opens no session', async (t) => {
  const w = await world(t);
  const { sessionAdmission: _none, ...capabilities } = complete(w, { durableDirectory: w.dir() });
  const agent = await w.agent(capabilities);
  t.after(() => agent.close());
  assert.deepEqual(await refused(async () => agent.receiveProposal(await w.proposalFor(w.vetted))), { code: 'session_admission_required', status: 503 });
  assert.equal(agent.stageOf(w.jobId), null);
  assert.equal(w.admission.calls.some(([method])=>method==='admit'),false,'request preparation may read revocation; the agent never admits');
  assert.deepEqual(w.reached, []);
});

test('a Vet reference is signed only through the passing record of this job, party and bundle it names, signed by the party\'s counterparty verifier', async (t) => {
  const w = await world(t), other = key(), buyer = w.buyerKey.claim, sellerClaim = w.sellerKey.claim, sellerBundle = w.listing.seller.identity;
  const fabricated = { ...w.vetted.buyer.vetRecordRef, contentHash: core.sha256Hex(`installed-vet:${w.jobId}:${buyer}`) };
  const refs = {
    'no record behind the hash': ['buyer', fabricated],
    'a failing decision': ['buyer', await w.admission.vetRecord(w.jobId, buyer, w.buyerBundle, { requirement: w.listing.buyerRequirement, decision: 'fail' })],
    'another signer': ['buyer', await w.admission.vetRecord(w.jobId, buyer, w.buyerBundle, { requirement: w.listing.buyerRequirement, signer: other })],
    'another job': ['buyer', await w.admission.vetRecord(w.jobId, buyer, w.buyerBundle, { requirement: w.listing.buyerRequirement, recordJobId: core.generateCanonicalJobId() })],
    'another bundle': ['buyer', await w.admission.vetRecord(w.jobId, buyer, w.buyerBundle, { requirement: w.listing.buyerRequirement, bundleHash: core.sha256Hex('another bundle') })],
  };
  // DACS-2 §7.7.2: the seller's record is the buyer's to verify and the buyer's
  // the seller's. A party's own signature is refused at the reference, before
  // any record is read; a reference naming the counterparty is refused at the
  // record it names when the party signed that record itself.
  const notCounterparty = /^DEM_DELIVERY_CONTEXT_INPUT_MISMATCH: (buyer|seller) Vet ref is not at its canonical address with its counterparty verifier$/;
  const counterpartyRefs = {
    'a seller record the seller signed as its own verifier': ['seller', await w.admission.vetRecord(w.jobId, sellerClaim, sellerBundle, { requirement: w.listing.buyerRequirement, verifier: w.sellerKey }), notCounterparty],
    'a buyer record the buyer signed as its own verifier': ['buyer', await w.admission.vetRecord(w.jobId, buyer, w.buyerBundle, { requirement: w.listing.buyerRequirement, verifier: w.buyerKey }), notCounterparty],
    'a seller record the seller signed, under a reference naming the buyer': ['seller', await w.admission.vetRecord(w.jobId, sellerClaim, sellerBundle, { requirement: w.listing.buyerRequirement, signer: w.sellerKey }),
      /^VET_RECORD_UNVERIFIED: seller: the Vet record is not signed by its counterparty verifier$/],
  };
  for (const [label, [role, ref, reason]] of Object.entries({ ...refs, ...counterpartyRefs })) {
    const input = { ...w.vetted, [role]: { ...w.vetted[role], vetRecordRef: ref } }, reads = w.admission.calls.filter(([call]) => call === 'resolveVetRecord').length;
    const agent = await w.agent(complete(w, { durableDirectory: w.dir(), demDeliveryContext: w.chain.demDeliveryContext(input) }));
    const answer = await agent.receiveProposal(await w.proposalFor(input));
    agent.close();
    assert.equal(answer.disposition,label==='no record behind the hash'?'indeterminate':'rejected',label);
    assert.equal(answer.contribution, undefined, `${label}: no seller contribution is issued`);
    if (reason) assert.match(answer.reason, reason, label);
    if (reason === notCounterparty) assert.equal(w.admission.calls.filter(([call]) => call === 'resolveVetRecord').length, reads, `${label}: no Vet record is read`);
  }
  assert.deepEqual(w.reached.filter((name) => name !== 'resolveSeller'), []);
});

// DACS-2 VPC-3: a record the counterparty signed is not thereby admitted. The
// seller signs the Agreement only over records whose SR-2 receipt, read by the
// operator's reader, names the reference's canonical address and exact hash at
// `included` or `finalized` for Demos (DEMOS-MAPPING A.2). Each vector keeps the record and its signature valid
// and spoils only the receipt; none reaches the Agreement signature.
test('a Demos Vet record is relied on only with an included or finalized SR-2 receipt', async (t) => {
  const w = await world(t), buyer = w.buyerKey.claim, sellerClaim = w.sellerKey.claim, sellerBundle = w.listing.seller.identity;
  const requirement = w.listing.buyerRequirement, other = core.sha256Hex('another record');
  const preserved = { preservedReceiptHash: core.sha256Hex('preserved receipt') };
  const spoiled = {
    'no receipt (the reader has none)': [null, /^VET_RECORD_UNVERIFIED: the (buyer|seller) Vet record read or authentication is unavailable$/],
    'an accepted Demos receipt': [{ state: 'accepted' }, /Demos.*included or finalized/],
    'a submitted receipt': [{ state: 'submitted' }, /not accepted or later/],
    'a rejected receipt': [{ state: 'rejected' }, /not accepted or later/],
    'a dropped receipt': [{ state: 'dropped' }, /not accepted or later/],
    'a replaced receipt': [{ state: 'replaced' }, /not accepted or later/],
    'an expired receipt': [{ state: 'expired' }, /not accepted or later/],
    'a reorged receipt': [{ state: 'reorged' }, /not accepted or later/],
    'an indeterminate observation': [{ observationDisposition: 'indeterminate', ...preserved }, /not an established observation/],
    'a receipt for another address': [{ logicalAddress: 'dacs2:composite:another' }, /for another address or hash/],
    'a receipt for another hash': [{ contentHash: other }, /for another address or hash/],
    'a malformed receipt': [{ writer: '' }, /not a CORE receipt/],
  };
  const sign = async (input, sessionAdmission) => {
    const agent = await w.agent(complete(w, { durableDirectory: w.dir(), demDeliveryContext: w.chain.demDeliveryContext(input), ...(sessionAdmission ? { sessionAdmission } : {}) }));
    try { return await agent.receiveProposal(await w.proposalFor(input)); } finally { agent.close(); }
  };
  for (const [label, [receipt, reason]] of Object.entries(spoiled)) {
    for (const [role, party, bundle] of [['buyer', buyer, w.buyerBundle], ['seller', sellerClaim, sellerBundle]]) {
      const ref = await w.admission.vetRecord(w.jobId, party, bundle, { requirement, receipt });
      const answer = await sign({ ...w.vetted, [role]: { ...w.vetted[role], vetRecordRef: ref } });
      assert.equal(answer.disposition,receipt===null?'indeterminate':'rejected', `${role}: ${label}`);
      assert.equal(answer.contribution, undefined, `${role}: ${label}: no seller contribution is issued`);
      assert.match(answer.reason, reason, `${role}: ${label}`);
    }
  }
  // A reader that answers nothing at all.
  const noAnswer = { ...w.admission.sessionAdmission, readVetAnchorReceipt: async () => null };
  const none = await sign(w.vetted, noAnswer);
  assert.equal(none.disposition, 'rejected');
  assert.match(none.reason, /^VET_RECORD_UNVERIFIED: buyer: the Vet record has no SR-2 receipt$/);
  assert.deepEqual(w.reached.filter((name) => name !== 'resolveSeller'), []);
  // The receipt states from which a record is relied on pass.
  for (const state of ['included', 'finalized']) {
    const input = { ...w.vetted, buyer: { ...w.vetted.buyer, vetRecordRef: await w.admission.vetRecord(w.jobId, buyer, w.buyerBundle, { requirement, receipt: { state } }) } };
    assert.equal((await sign(input)).disposition, 'complete', state);
  }
});

// DACS-2 VPC-3 and CORE SR2-4: "the receipt fields alone are assertions, not
// proof". A shape-valid receipt at `finalized` that the operator's verifier does
// not authenticate (a fabricated transaction and evidence) is refused before the
// Agreement is signed; only a 'valid' verdict passes.
test('a Vet record whose SR-2 receipt is well formed but not authenticated is not signed over; an authenticated one passes whatever its writer', async (t) => {
  const w = await world(t), buyer = w.buyerKey.claim, sign = async (input = w.vetted) => {
    const agent = await w.agent(complete(w, { durableDirectory: w.dir(), demDeliveryContext: w.chain.demDeliveryContext(input) }));
    try { return await agent.receiveProposal(await w.proposalFor(input)); } finally { agent.close(); }
  };
  const forged = { transactionRef: { kind: 'demos', value: core.sha256Hex('a transaction that never landed') }, evidence: { kind: 'TEST', value: 'invented' } };
  const input = { ...w.vetted, buyer: { ...w.vetted.buyer, vetRecordRef: await w.admission.vetRecord(w.jobId, buyer, w.buyerBundle, { requirement: w.listing.buyerRequirement, receipt: forged }) } };
  for (const [label, verdict] of Object.entries({ 'an invalid verdict': () => 'invalid', 'an indeterminate verdict': () => 'indeterminate', 'no verdict': () => undefined, 'a truthy non-verdict': () => true, 'a verifier that throws': () => { throw new Error('chain read failed'); } })) {
    w.admission.verifyReceiptWith(verdict);
    const answer = await sign(input);
    assert.equal(answer.disposition,label==='an invalid verdict'?'rejected':'indeterminate',label);
    assert.equal(answer.contribution,undefined);assert.match(answer.reason,/^VET_RECORD_UNVERIFIED:/);
  }
  assert.deepEqual(w.reached.filter((name) => name !== 'resolveSeller'), []);
  // The verifier is asked about the exact record and receipt, and an authenticated one passes,
  // whoever the receipt names as writer (SR2-5 binds the writer it names; no rule ties it to the record's signer).
  const asked = [];
  w.admission.verifyReceiptWith(({ ref, record, receipt }) => { asked.push({ ref, record, receipt }); return 'valid'; });
  for (const writer of [buyer, w.sellerKey.claim]) {
    asked.length = 0;
    const ref = await w.admission.vetRecord(w.jobId, buyer, w.buyerBundle, { requirement: w.listing.buyerRequirement, receipt: { writer } });
    assert.equal((await sign({ ...w.vetted, buyer: { ...w.vetted.buyer, vetRecordRef: ref } })).disposition, 'complete', `writer ${writer}`);
    const mine = asked.find((entry) => entry.ref.contentHash === ref.contentHash);
    assert.equal(core.contentHash(mine.record), ref.contentHash);
    assert.equal(mine.receipt.writer, writer);
  }
});

// The reference's own locator must be the job's canonical composite address: a
// retained context relies on this guard (a fresh one is checked by the context
// consumer too), so a receipt that matches a reference elsewhere does not pass.
test('a Vet receipt that matches a reference at another address than the job\'s canonical composite address is refused', async (t) => {
  const w = await world(t), buyer = w.buyerKey.claim;
  const ref = await w.admission.vetRecord(w.jobId, buyer, w.buyerBundle, { requirement: w.listing.buyerRequirement });
  const receipt = (await w.admission.sessionAdmission.readVetAnchorReceipt({ ref }));
  assert.equal(vetAnchorReceiptProblem(receipt, { ref, jobId: w.jobId, party: buyer }), null);
  const moved = { ...ref, anchor: { ...ref.anchor, locator: 'dacs2:composite:elsewhere' } };
  assert.match(vetAnchorReceiptProblem({ ...receipt, logicalAddress: moved.anchor.locator }, { ref: moved, jobId: w.jobId, party: buyer }), /not at the job's canonical composite address/);
});

// The delivery audit source carries the Vet context's requirement invocations.
// The seller runs core's own delivery predicate on them before it signs
// (sellerFulfilmentVetRequirementsViolation): one invocation per party record,
// evaluating that party, naming its counterparty verifier, the Listing's buyer
// requirement for the buyer's record and every required claim covered. A
// context the delivery runner would refuse after payment is refused here.
test('a Vet context whose requirement invocations the delivery runner would refuse is not signed', async (t) => {
  const w = await world(t), buyer = w.buyerKey.claim, sellerClaim = w.sellerKey.claim;
  const invocation = (role, evaluatedParty, verifier, vetRecordRef = w.vetted[role].vetRecordRef, requirement = w.listing.buyerRequirement) => ({ vetRecordRef: structuredClone(vetRecordRef), evaluatedParty,
    requirement: structuredClone(requirement), verifier, freshness: [], dealSpecific: [] });
  const buyerInvocation = invocation('buyer', buyer, sellerClaim), sellerInvocation = invocation('seller', sellerClaim, buyer);
  const otherRequirement = { ...structuredClone(w.listing.buyerRequirement), preferredPresentation: w.listing.buyerRequirement.preferredPresentation === 'any' ? 'per-claim' : 'any' };
  const uncovered = { ...structuredClone(w.listing.buyerRequirement), required: [{ scheme: 'test-claim', verificationRequired: true }] };
  const refused = {
    'no invocation': [],
    'one record without its invocation': [buyerInvocation],
    'the buyer invocation twice': [buyerInvocation, structuredClone(buyerInvocation)],
    'a third invocation': [buyerInvocation, sellerInvocation, structuredClone(sellerInvocation)],
    'the seller as verifier of its own record': [buyerInvocation, invocation('seller', sellerClaim, sellerClaim)],
    'the buyer as verifier of its own record': [invocation('buyer', buyer, buyer), sellerInvocation],
    'another evaluated party': [invocation('buyer', sellerClaim, buyer), sellerInvocation],
    'a record the Agreement does not reference': [buyerInvocation, invocation('seller', sellerClaim, buyer, { ...w.vetted.seller.vetRecordRef, contentHash: core.sha256Hex('TEST another record') })],
    'a buyer requirement other than the Listing\'s': [invocation('buyer', buyer, sellerClaim, undefined, otherRequirement), sellerInvocation],
    'a required claim no result covers': [buyerInvocation, invocation('seller', sellerClaim, buyer, undefined, uncovered)],
    'an invocation that is not the exact shape': [{ ...buyerInvocation, extra: true }, sellerInvocation],
  };
  for (const [label, vetRequirements] of Object.entries({ ...refused, 'each record\'s party and counterparty verifier': [buyerInvocation, sellerInvocation] })) {
    const agent = await w.agent(complete(w, { durableDirectory: w.dir(), demDeliveryContext: w.chain.demDeliveryContext(w.vetted, vetRequirements) }));
    const answer = await agent.receiveProposal(await w.proposalFor(w.vetted));
    agent.close();
    if (!(label in refused)) { assert.equal(answer.disposition, 'complete', label); continue; }
    assert.equal(answer.disposition, 'rejected', label);
    assert.equal(answer.contribution, undefined, `${label}: no seller contribution is issued`);
    assert.match(answer.reason, /^VET_RECORD_UNVERIFIED: (the Vet requirement invocations|a Vet requirement invocation) /, label);
  }
  assert.deepEqual(w.reached.filter((name) => name !== 'resolveSeller'), []);
});

// DACS-2 §7.7.1: a record backs its reference only for the exact requirement
// it hashes, here the Listing's buyer requirement, whoever signed it.
test('a passing, counterparty-signed Vet record over another requirement is not signed', async (t) => {
  const w = await world(t), buyer = w.buyerKey.claim, sellerClaim = w.sellerKey.claim, sellerBundle = w.listing.seller.identity;
  const other = { ...structuredClone(w.listing.buyerRequirement), preferredPresentation: w.listing.buyerRequirement.preferredPresentation === 'any' ? 'per-claim' : 'any' };
  const records = {
    'a buyer record over another requirement': ['buyer', await w.admission.vetRecord(w.jobId, buyer, w.buyerBundle, { requirement: other })],
    'a seller record over another requirement': ['seller', await w.admission.vetRecord(w.jobId, sellerClaim, sellerBundle, { requirement: other })],
    'a buyer record with a made-up requirement hash': ['buyer', await w.admission.vetRecord(w.jobId, buyer, w.buyerBundle, { requirement: w.listing.buyerRequirement,
      requirementHash: core.sha256Hex(`requirement:${w.jobId}:${sellerClaim}`) })],
  };
  for (const [label, [role, ref]] of Object.entries(records)) {
    const input = { ...w.vetted, [role]: { ...w.vetted[role], vetRecordRef: ref } };
    const agent = await w.agent(complete(w, { durableDirectory: w.dir(), demDeliveryContext: w.chain.demDeliveryContext(input) }));
    const answer = await agent.receiveProposal(await w.proposalFor(input));
    agent.close();
    assert.equal(answer.disposition, 'rejected', label);
    assert.equal(answer.contribution, undefined, `${label}: no seller contribution is issued`);
    assert.equal(answer.reason, `VET_RECORD_UNVERIFIED: ${role}: the Vet record does not verify against its requirement (invalid: requirement-hash-mismatch)`, label);
  }
  assert.deepEqual(w.reached.filter((name) => name !== 'resolveSeller'), []);
});

// A retained Vet context may have been kept under an earlier, weaker check, so
// it is verified against the records it names again before any signature: a
// record that no longer resolves, or no longer backs its reference, is not
// signed, also after a restart.
test('a retained Vet context is verified against its records again before the seller signs, also after a restart', async (t) => {
  const w = await world(t), durableDirectory = w.dir();
  let mode = 'ok';
  const resolveVetRecord = async (query) => {
    if (mode === 'down') throw new Error('TEST Vet record store is down');
    const record = await w.admission.sessionAdmission.resolveVetRecord(query);
    return mode === 'other' ? { ...record, generatedAt: record.generatedAt + 1 } : record;
  };
  const options = () => complete(w, { durableDirectory, sessionAdmission: { ...w.admission.sessionAdmission, resolveVetRecord } });
  let agent = await w.agent(options());
  t.after(() => agent.close());
  assert.equal((await agent.receiveProposal(await w.proposalFor(w.vetted))).disposition,'complete');
  assert.equal(typeof agent.durableSessionOf(w.jobId).demDeliveryContext,'object');
  const request = await w.proposalFor(w.vetted);
  for (const [label, reason] of [['down', /buyer Vet record cannot be resolved/], ['other', /Vet record does not hash to its reference/]]) {
    mode = label;
    const held = error => error.code === 'seller_state_unverified' && error.status === 503 && reason.test(error.message);
    await assert.rejects(agent.receiveProposal(request), held, `${label}, running`);
    agent.close();
    await assert.rejects(w.agent(options()), held, `${label}, restarted`);
    mode = 'ok';
    agent = await w.agent(options());
  }
  mode = 'ok';
  assert.equal((await agent.receiveProposal(request)).disposition, 'complete', 'the retained context whose records verify is signed');
  assert.deepEqual(w.reached.filter((name) => name !== 'resolveSeller'), []);
});

// CORE SN-4: a presentation nonce admits one session. The seller's challenge
// ledger binds it to the job it was issued for, whatever the operator's
// admission answers (this fixture admits any presentation), and the ledger is
// kept with the durable seller state, so a restart keeps it too.
test('a buyer presentation that admitted one session is refused for another job, also after a restart, before the admission is asked', async (t) => {
  const w = await world(t), durableDirectory = w.dir(), otherJob = core.generateCanonicalJobId();
  const admits = () => w.admission.calls.filter(([call]) => call === 'admit').length;
  const first = await w.agent(complete(w, { durableDirectory }));
  assert.equal((await first.receiveProposal(await w.proposalFor(w.vetted))).disposition, 'complete');
  const replay = async (agent) => refused(async () => agent.receiveProposal(await w.proposalFor({ ...w.vetted, jobId: otherJob }, otherJob)));
  const asked = admits();
  assert.deepEqual(await replay(first), { code: 'session_not_admitted', status: 409 });
  first.close();
  const restarted = await w.agent(complete(w, { durableDirectory }));
  t.after(() => restarted.close());
  assert.deepEqual(await replay(restarted), { code: 'session_not_admitted', status: 409 }, 'after a restart');
  assert.equal(admits(), asked, 'the operator admission is not asked for the replayed nonce');
  assert.equal(restarted.stageOf(otherJob), null, 'no session is kept for the replay');
  assert.deepEqual(w.reached.filter((name) => name !== 'resolveSeller'), []);
});

test('a missing or different admission or profile is refused before any session is kept; each refused attempt consumes its challenge', async (t) => {
  const w = await world(t);
  const profile = (answer, change) => ({ ...answer, participants: answer.participants.map((entry) => entry.role === 'buyer' ? { ...entry, ...change } : entry) });
  const refusals = {
    'another job': (answer) => ({ ...answer, jobId: core.generateCanonicalJobId() }),
    'another bundle': (answer) => ({ ...answer, buyerBundleHash: core.sha256Hex('another bundle') }),
    'a revocation reading in the answer (the seller reads revocation itself)': (answer) => ({ ...answer, listingStatus: { status: 'active', observedAt: w.now } }),
    'no buyer profile': (answer) => ({ ...answer, participants: answer.participants.filter((entry) => entry.role !== 'buyer') }),
    'a duplicate buyer profile': (answer) => ({ ...answer, participants: [...answer.participants, answer.participants[0]] }),
    'an older Standard revision': (answer) => profile(answer, { standardRevision: '0'.repeat(40) }),
    'a different document tuple': (answer) => profile(answer, { documentVersions: { ...answer.participants[0].documentVersions, 'DACS-4': '0.7' } }),
    'a profile for another identity': (answer) => profile(answer, { claim: key().claim }),
    'a challenge in the answer (the seller\'s own ledger holds it)': (answer) => ({ ...answer, challenge: { nonce: w.buyerBundle.sessionNonce, consumedAt: w.now } }),
    'a refusal': () => ({ disposition: 'refused', reason: 'TEST not admitted' }),
    'nothing': () => undefined,
  };
  const agent = await w.agent(complete(w, { durableDirectory: w.dir() }));
  t.after(() => agent.close());
  const request = await w.proposalFor(w.vetted), admits = () => w.admission.calls.filter(([call]) => call === 'admit').length;
  // CORE SN-4: a challenge is consumed on its first attempt, so each refused
  // attempt presents its own issued challenge.
  let presented = 0;
  const fresh = async () => { const bundle = presentWith(w.buyerKey, w.now - 1 - presented++, (await agent.issueSessionChallenge({ jobId: w.jobId, buyer: w.buyerKey.claim })).sessionNonce); return { ...request, buyerIdentityBundle: bundle }; };
  for (const [label, change] of Object.entries(refusals)) {
    w.admission.answerWith(change);
    const attempt = await fresh();
    assert.deepEqual(await refused(() => agent.receiveProposal(attempt)), {code:label==='nothing'?'session_admission_unavailable':'session_not_admitted',status:label==='nothing'?503:409},label);
    assert.equal(agent.stageOf(w.jobId), null, `${label}: no session is kept`);
    w.admission.answerWith(null);
    const asked = admits();
    assert.deepEqual(await refused(() => agent.receiveProposal(attempt)), { code: 'session_not_admitted', status: 409 }, `${label}: the consumed challenge is refused again`);
    assert.equal(admits(), asked, `${label}: the admission is not asked again`);
  }
  w.admission.answerWith(() => { throw new Error('TEST admission store is down'); });
  assert.deepEqual(await refused(async () => agent.receiveProposal(await fresh())), { code: 'session_admission_unavailable', status: 503 });
  w.admission.answerWith(null);
  assert.equal((await agent.receiveProposal(request)).disposition, 'complete', 'the admitted session is signed');
  assert.deepEqual(w.reached.filter((name) => name !== 'resolveSeller'), []);
});

// CORE SN-1..SN-4: the seller's own challenge ledger decides, before the
// operator's admission is asked (this fixture admits any presentation, as an
// echoing callback would).
test('a presentation nonce the seller did not issue, issued for another job or buyer, expired, or consumed by an earlier attempt is refused before the admission is asked, also after a restart', async (t) => {
  const w = await world(t), durableDirectory = w.dir();
  let clock = w.now;
  const open = () => seller.createSellerAgent(complete(w, { durableDirectory, now: () => clock }));
  let agent = await open();
  t.after(() => agent.close());
  const request = await w.proposalFor(w.vetted), admits = () => w.admission.calls.filter(([call]) => call === 'admit').length;
  const NOT_ADMITTED = { code: 'session_not_admitted', status: 409 };
  let presented = 0;
  const bundle = async (jobId = w.jobId, buyer = w.buyerKey.claim) => presentWith(w.buyerKey, w.now - 1 - presented++, (await agent.issueSessionChallenge({ jobId, buyer })).sessionNonce);
  const attempt = (presentation) => refused(() => agent.receiveProposal({ ...request, buyerIdentityBundle: presentation }));
  assert.deepEqual(await attempt(identityFor(w.buyerKey, w.now - 1 - presented++)), NOT_ADMITTED, 'a nonce the seller never issued');
  const otherJob = await bundle(core.generateCanonicalJobId());
  assert.deepEqual(await attempt(otherJob), NOT_ADMITTED, 'a challenge issued for another job');
  const otherBuyer = await bundle(w.jobId, key().claim);
  assert.deepEqual(await attempt(otherBuyer), NOT_ADMITTED, 'a challenge issued to another buyer');
  const late = await bundle();
  clock += SESSION_CHALLENGE_LIFETIME_MS;
  assert.deepEqual(await attempt(late), NOT_ADMITTED, 'an expired challenge');
  clock = w.now;
  assert.equal(admits(), 0, 'the admission is never asked for these');
  // Consumed on the first attempt, a refused one too: the same presentation
  // and a re-signed one carrying the same nonce are refused after it.
  const first = await bundle();
  w.admission.answerWith(() => ({ disposition: 'refused', reason: 'TEST not admitted' }));
  assert.deepEqual(await attempt(first), NOT_ADMITTED, 'the first attempt is refused by the admission');
  w.admission.answerWith(null);
  const asked = admits();
  assert.deepEqual(await attempt(first), NOT_ADMITTED, 'the same presentation after its refused attempt');
  const resigned = presentWith(w.buyerKey, first.presentedAt + 1, first.sessionNonce);
  assert.notEqual(core.identityBundleHash(resigned), core.identityBundleHash(first));
  assert.deepEqual(await attempt(resigned), NOT_ADMITTED, 'a re-signed presentation carrying the consumed nonce');
  agent.close();
  agent = await open();
  assert.deepEqual(await attempt(first), NOT_ADMITTED, 'the consumed challenge after a restart');
  assert.deepEqual(await attempt(late), NOT_ADMITTED, 'the expired challenge after a restart');
  assert.equal(admits(), asked, 'the admission is not asked for a consumed challenge');
  assert.equal(agent.stageOf(w.jobId), null, 'no session is kept');
  // The issued challenge of this presentation admits it, and its accepted
  // presentation continues after a restart.
  const signed = await agent.receiveProposal(request);
  assert.equal(signed.disposition, 'complete');
  agent.close();
  agent = await open();
  assert.deepEqual((await agent.receiveProposal(request)).contribution, signed.contribution, 'the accepted presentation continues after a restart');
  assert.deepEqual(w.reached.filter((name) => name !== 'resolveSeller'), []);
});

// DACS-1 §6.3.2: a session-context presentation that carries no session nonce
// MUST be rejected. It names no challenge, so the seller refuses it before its
// ledger or the operator's admission is asked, keeps no session, and the
// buyer's issued challenge still admits its real presentation.
test('a presentation that carries no session nonce is refused before the admission is asked and keeps no session, through the agent and over HTTP (DACS-1 §6.3.2)', async (t) => {
  const NO_NONCE = { code: 'session_not_admitted', status: 409 }, message = 'the presentation carries no session nonce (DACS-1 §6.3.2)';
  const w = await world(t), agent = await w.agent(complete(w, { durableDirectory: w.dir() }));
  t.after(() => agent.close());
  const admits = () => w.admission.calls.filter(([call]) => call === 'admit').length;
  const request = await w.proposalFor(w.vetted), bare = presentWithout(w.buyerKey, w.now - 1);
  assert.equal(Object.hasOwn(bare, 'sessionNonce'), false);
  assert.equal(core.isIdentityBundle(bare), true, 'an IdentityBundle: only the session context needs the nonce');
  let error = null;
  try { await agent.receiveProposal({ ...request, buyerIdentityBundle: bare }); } catch (caught) { error = caught; }
  assert.deepEqual({ code: error?.code, status: error?.status }, NO_NONCE);
  assert.equal(error.message, message);
  assert.equal(admits(), 0, 'the admission is not asked');
  assert.equal(agent.stageOf(w.jobId), null, 'no session is kept');
  assert.equal((await agent.receiveProposal(request)).disposition, 'complete', 'the buyer\'s issued challenge is untouched and admits its presentation');
  const v = await world(t), h = await httpSeller(t, v);
  await answered(() => h.client.propose({ ...h.proposal, buyerIdentityBundle: presentWithout(v.buyerKey, v.now - 1) }));
  assert.deepEqual([h.last.status, h.last.answer.error, h.last.answer.message], [409, 'session_not_admitted', message]);
  assert.equal(h.agent.stageOf(v.jobId), null, 'no session is kept over HTTP');
  assert.equal(v.admission.calls.filter(([call]) => call === 'admit').length, 0);
  assert.equal((await h.client.propose(h.proposal)).disposition, 'complete', 'the refusal kept no transport effect: the presentation under its own challenge is signed');
});

test('the seller issues a fresh 256-bit challenge bound to one job and buyer; a nonce is issued once', async (t) => {
  const w = await world(t), agent = await seller.createSellerAgent(complete(w, { durableDirectory: w.dir() }));
  t.after(() => agent.close());
  const issued = await agent.issueSessionChallenge({ jobId: w.jobId, buyer: w.buyerKey.claim }), again = await agent.issueSessionChallenge({ jobId: w.jobId, buyer: w.buyerKey.claim });
  assert.match(issued.sessionNonce, /^[0-9a-f]{64}$/);
  assert.notEqual(issued.sessionNonce, again.sessionNonce, 'every challenge is fresh');
  assert.deepEqual({ ...issued, sessionNonce: null }, { jobId: w.jobId, buyer: w.buyerKey.claim, sessionNonce: null, issuedAt: w.now, expiresAt: w.now + SESSION_CHALLENGE_LIFETIME_MS });
  const failed = async (input) => { try { await agent.issueSessionChallenge(input); return null; } catch (error) { return error.code; } };
  assert.equal(await failed({ jobId: w.jobId, buyer: w.buyerKey.claim, sessionNonce: issued.sessionNonce }), 'challenge_invalid', 'callers cannot reissue a nonce');
  assert.equal(await failed({ jobId: w.jobId, buyer: w.buyerKey.claim, sessionNonce: 'AB'.repeat(32) }), 'challenge_invalid');
  assert.equal(await failed({ jobId: w.jobId, buyer: w.buyerKey.claim, sessionNonce: 'ab'.repeat(15) }), 'challenge_invalid', 'fewer than 128 bits');
  assert.equal(await failed({ jobId: 'not-a-job', buyer: w.buyerKey.claim }), 'job_invalid');
  assert.equal(await failed({ jobId: w.jobId, buyer: w.sellerKey.claim }), 'buyer_invalid', 'the seller is no buyer');
});

test('a session in flight continues after its Listing is revoked; a new session on it is refused', async (t) => {
  const w = await world(t), agent = await w.agent(complete(w, { durableDirectory: w.dir() }));
  t.after(() => agent.close());
  const signed = await agent.receiveProposal(await w.proposalFor(w.vetted));
  assert.equal(signed.disposition, 'complete');
  const revoked = await revocationOf(w);
  w.admission.readRevocationWith(() => [revoked.surface]);
  assert.deepEqual((await agent.receiveProposal(await w.proposalFor(w.vetted))).contribution, signed.contribution, 'the in-flight session is answered again');
  const next = { ...w.vetted, jobId: core.generateCanonicalJobId() }, request = await w.proposalFor(next);
  assert.deepEqual(await refused(() => agent.receiveProposal({ ...request, transportIdentity: { ...request.transportIdentity, jobId: next.jobId } })), { code: 'session_not_admitted', status: 409 });
});

// DACS-1 RB-4..RB-6, LR-3: the seller decides whether its Listing is revoked
// with the core SDK's own check over the operator's readers, never from an
// answer that asserts it: this fixture's admit would admit every session.
test('the seller decides revocation itself: a verified marker refuses a new session that admit would admit, and an incomplete reading refuses as indeterminate, before admit is asked or anything is kept or signed', async (t) => {
  const w = await world(t), agent = await w.agent(complete(w, { durableDirectory: w.dir() }));
  t.after(() => agent.close());
  const request = await w.proposalFor(w.vetted), admits = () => w.admission.calls.filter(([call]) => call === 'admit').length;
  let presented = 0;
  const fresh = async () => { const bundle = presentWith(w.buyerKey, w.now - 1 - presented++, (await agent.issueSessionChallenge({ jobId: w.jobId, buyer: w.buyerKey.claim })).sessionNonce); return { ...request, buyerIdentityBundle: bundle }; };
  const refusal = async (work) => { try { await work(); return null; } catch (error) { return { code: error.code, status: error.status, message: error.message }; } };
  const revoked = await revocationOf(w), forged = await revocationOf(w, { signerKey: w.buyerKey, locator: 'TEST-forged-marker' });
  const active = { kind: 'catalog', status: 'active', readStatus: 'ok', catalogObservedAt: w.now };
  const { catalogObservedAt: _observed, ...revokedIndex } = { ...revoked.surface, kind: 'well-known', integrity: 'verified' };
  const REVOKED = ['session_not_admitted', 409, /the Listing is revoked \(verified-revocation-marker\)/];
  const unknown = (cause) => ['session_admission_unavailable', 503, new RegExp(`revocation check is indeterminate: ${cause}`)];
  const readings = {
    'a verified revocation marker': [() => [revoked.surface], REVOKED],
    'an active catalog entry next to a verified marker on a well-known index': [() => [active, revokedIndex], REVOKED],
    'a revoked entry whose marker does not read back': [() => [{ ...revoked.surface, binding: { ...revoked.binding, markerAnchor: { kind: 'storage-program', locator: 'TEST-no-marker' } } }], unknown('marker-unreadable')],
    'a marker that is not the Listing signer\'s': [() => [forged.surface], unknown('marker-signer-mismatch')],
    'a revoked entry with no binding': [() => [{ ...active, status: 'revoked' }], unknown('required-binding-missing')],
    'an unavailable surface': [() => [{ ...active, readStatus: 'unavailable', readFailureReason: 'TEST catalog down' }], unknown('TEST catalog down')],
    'a catalog reading older than a day': [() => [{ ...active, catalogObservedAt: w.now - 25 * 60 * 60 * 1000 }], unknown('catalog-stale')],
    'a well-known index whose integrity is not verified': [() => [{ kind: 'well-known', status: 'active', readStatus: 'ok', integrity: 'indeterminate' }], unknown('surface-integrity')],
    'no surface': [() => [], unknown('revocation-surfaces-malformed')],
    'more surfaces than one reading may name': [() => Array.from({ length: 17 }, () => active), unknown('revocation-surfaces-malformed')],
    'a reader that throws': [() => { throw new Error('TEST revocation reader down'); }, unknown('TEST revocation reader down')],
  };
  for (const [label, [surfaces, [code, status, message]]] of Object.entries(readings)) {
    w.admission.readRevocationWith(null);
    const attempted = await fresh();
    w.admission.readRevocationWith(surfaces);
    const asked = admits(), answer = await refusal(() => agent.receiveProposal(attempted));
    assert.deepEqual([answer?.code, answer?.status], [code, status], `${label}: ${answer?.message}`);
    assert.match(answer.message, message, `${label}: the refusal keeps its cause`);
    assert.equal(admits(), asked, `${label}: admit is not asked`);
    assert.equal(agent.stageOf(w.jobId), null, `${label}: no session is kept`);
  }
  w.admission.readRevocationWith(null);
  assert.equal((await agent.receiveProposal(request)).disposition, 'complete', 'with a complete reading that finds no revocation, the session is signed');
  // The check reads the seller clock after the surfaces: a reading the reader
  // stamps with the same advancing clock is current, not one from the future.
  let tick = w.now;
  const ticking = await w.agent(complete(w, { durableDirectory: w.dir(), now: () => tick++ }));
  t.after(() => ticking.close());
  w.admission.readRevocationWith(() => [{ ...active, catalogObservedAt: tick }]);
  assert.equal((await ticking.receiveProposal(request)).disposition, 'complete', 'a reading stamped by the advancing seller clock admits');
  assert.deepEqual(w.reached.filter((name) => name !== 'resolveSeller'), []);
});

test('the native settlement profile needs the wallet journal question, so a paid order whose anchor outcome is unknown always has a way on (DACS-4 PC-7(b))', async (t) => {
  const w = await world(t);
  for (const reconcilePaymentEvidence of [undefined, null]) {
    await assert.rejects(w.agent(complete(w, { durableDirectory: w.dir(), reconcilePaymentEvidence })), { name: 'TypeError', message: /needs reconcilePaymentEvidence/ });
  }
});

// DACS-4 PC-7(b): the answers that let the agent sign the same evidence again
// come only from one package wallet journal, for an agent composed directly
// (createSellerAgent is a public export) as for the host: a wallet or a
// wrapper that answered them falsely could authorize a second signed CREATE.
test('createSellerAgent takes the evidence anchor and its reconciliation only from one wallet journal: a scripted, mixed, wrapped or two-journal pair is refused at construction', async (t) => {
  const w = await world(t);
  const journal = w.chain.journal(), other = seller.createPaymentEvidenceWalletJournal({ path: join(w.dir(), 'other-journal.sqlite'), signCreate: notCalled, broadcast: notCalled,
    readAccountNonce: notCalled, readTransactionState: notCalled });
  t.after(() => other.close());
  const refusedAnswer = async () => ({ status: 'refused', reason: 'TEST a wallet that says it sent nothing' });
  const unsignedAnswer = async () => ({ status: 'unsigned', reason: 'TEST a wallet that says nothing can land' });
  for (const [label, anchorEvidence, reconcilePaymentEvidence, extra = {}] of [['a scripted anchor and reconciliation', refusedAnswer, unsignedAnswer],
    ['the journal\'s anchor with a scripted reconciliation', journal.anchorEvidence, unsignedAnswer], ['a scripted anchor with the journal\'s reconciliation', refusedAnswer, journal.reconcilePaymentEvidence],
    ['the anchor and the reconciliation of two journals', journal.anchorEvidence, other.reconcilePaymentEvidence], ['a wrapper around the journal\'s anchor', (input) => journal.anchorEvidence(input), journal.reconcilePaymentEvidence],
    ['the reconciliation as the anchor', journal.reconcilePaymentEvidence, journal.reconcilePaymentEvidence],
    ['a scripted pair without session admission', refusedAnswer, unsignedAnswer, { sessionAdmission: null }]]) {
    await assert.rejects(seller.createSellerAgent(complete(w, { durableDirectory: w.dir(), nativePaymentEvidence: w.chain.nativePaymentEvidence({ anchorEvidence }), reconcilePaymentEvidence, ...extra })),
      { name: 'TypeError', message: /only from one createPaymentEvidenceWalletJournal/ }, label);
  }
  // One journal's own pair is taken.
  const agent = await w.agent(complete(w, { durableDirectory: w.dir() }));
  agent.close();
  assert.deepEqual(w.reached, []);
});

test('over HTTP an admission refusal is definite and keeps no session: the same request runs again and is refused for its consumed challenge, and a presentation under its own challenge is signed', async (t) => {
  const w = await world(t), h = await httpSeller(t, w);
  const fresh = async (presentedAt) => { const bundle = presentWith(w.buyerKey, presentedAt, (await h.agent.issueSessionChallenge({ jobId: w.jobId, buyer: w.buyerKey.claim })).sessionNonce); return { ...h.proposal, buyerIdentityBundle: bundle }; };
  const revoked = await fresh(w.now - 1), revocation = await revocationOf(w);
  w.admission.readRevocationWith(() => [revocation.surface]);
  await answered(() => h.client.propose(revoked));
  assert.deepEqual([h.last.status, h.last.answer.error], [409, 'session_not_admitted']);
  w.admission.readRevocationWith(null);
  const unavailable = await fresh(w.now - 3);
  w.admission.readRevocationWith(() => [{ kind: 'catalog', status: 'active', readStatus: 'unavailable', readFailureReason: 'TEST catalog down' }]);
  await answered(() => h.client.propose(unavailable));
  assert.deepEqual([h.last.status, h.last.answer.error], [503, 'session_admission_unavailable'], 'an indeterminate revocation check is definite and keeps no session');
  w.admission.readRevocationWith(null);
  await answered(() => h.client.propose(revoked));
  assert.deepEqual([h.last.status, h.last.answer.error, h.last.answer.message], [409, 'session_not_admitted', 'the presentation challenge was consumed by an earlier presentation attempt']);
  w.admission.answerWith(() => { throw new Error('TEST admission store is down'); });
  await answered(async () => h.client.propose(await fresh(w.now - 2)));
  assert.deepEqual([h.last.status, h.last.answer.error], [503, 'session_admission_unavailable']);
  w.admission.answerWith(null);
  assert.equal((await h.client.propose(h.proposal)).disposition, 'complete');
});

test('a buyer presentation signature is accepted only in canonical unpadded Base64URL (CORE SIG-6)', async (t) => {
  const w = await world(t), agent = await w.agent(complete(w, { durableDirectory: w.dir() }));
  t.after(() => agent.close());
  const value = w.buyerBundle.presentation.signatures[0].signature, alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  // Each decodes leniently to the same 64 signature bytes.
  const trailingBits = value.slice(0, -1) + alphabet[alphabet.indexOf(value.at(-1)) | 1];
  const variants = [`${value}==`, trailingBits, `${value.slice(0, 40)}.${value.slice(40)}`, ...(/[-_]/.test(value) ? [value.replace(/-/g, '+').replace(/_/g, '/')] : [])];
  for (const variant of variants) {
    assert.deepEqual(Buffer.from(variant, 'base64url'), Buffer.from(value, 'base64url'));
    const bundle = { ...w.buyerBundle, presentation: { ...w.buyerBundle.presentation, signatures: [{ ...w.buyerBundle.presentation.signatures[0], signature: variant }] } };
    const request = await w.proposalFor(w.vetted);
    assert.equal((await refused(() => agent.receiveProposal({ ...request, buyerIdentityBundle: bundle })))?.code, 'buyer_bundle_unauthenticated', variant);
  }
  assert.equal(w.admission.calls.some(([method])=>method==='admit'),false,'refused before any admission');
});

// Cold review regressions: real signer, authenticated state and durable HTTP journal.
test('failed Agreement signing leaves no in-flight rail; live recovery signs once and a signed pin continues under a disabled revision', async (t) => {
  const w = await world(t), durableDirectory = w.dir(), request = await w.proposalFor(w.vetted);
  let fail = true, attempts = 0;
  const signer = { ...w.signer, sign: (bytes) => {
    if (Buffer.from(bytes).toString().startsWith('dacs-payee-bound-agreement:v1:')) {
      attempts++;
      if (fail) throw new Error('TEST signing unavailable');
    }
    return w.signer.sign(bytes);
  } };
  let agent = await w.agent(complete(w, { durableDirectory, signer }));
  assert.equal((await agent.receiveProposal(request)).disposition, 'indeterminate');
  assert.notEqual(agent.durableSessionOf(w.jobId).railPinSigned, true);
  agent.close(); fail = false;
  agent = await w.agent(complete(w, { durableDirectory, signer, railAuthority: w.steward.railAuthority({ changes: { availability: 'disabled' } }) }));
  assert.deepEqual(await refused(() => agent.receiveProposal(request)), { code: 'rail_unavailable', status: 503 });
  assert.equal(attempts, 1, 'disabled retry never reaches the signer');
  agent.close();
  agent = await w.agent(complete(w, { durableDirectory, signer }));
  const signed = await agent.receiveProposal(request);
  assert.equal(signed.disposition, 'complete');
  assert.equal(attempts, 2);
  agent.close();
  agent = await w.agent(complete(w, { durableDirectory, signer, railAuthority: w.steward.railAuthority({ changes: { availability: 'disabled' } }) }));
  t.after(() => agent.close());
  assert.deepEqual((await agent.receiveProposal(request)).contribution, signed.contribution);
  assert.equal(attempts, 2, 'a successfully signed session continues without another signature');
});

test('DEM seller context refuses a foreign payout before signing and accepts its intrinsic seller address', async (t) => {
  const w = await world(t), foreign = structuredClone(w.vetted);
  foreign.payoutBindings[0].payeeAddress = w.buyerKey.address;
  const bad = await w.agent(complete(w, { durableDirectory: w.dir(), demDeliveryContext: w.chain.demDeliveryContext(foreign) }));
  assert.equal((await bad.receiveProposal(await w.proposalFor(foreign))).disposition, 'rejected');
  assert.equal(bad.durableSessionOf(w.jobId)?.sellerContribution, undefined);
  bad.close();
  const good = await w.agent(complete(w, { durableDirectory: w.dir() }));
  t.after(() => good.close());
  assert.equal((await good.receiveProposal(await w.proposalFor(w.vetted))).disposition, 'complete');
});

test('new Listing sessions use the current inclusive validity interval, before and after restart; an already signed session still replays', async (t) => {
  const w = await world(t, { listingChanges: (draft) => { draft.validity.notAfter = draft.validity.notBefore + 60010; } });
  const request = await w.proposalFor(w.vetted), durableDirectory = w.dir();
  let at = w.now;
  const options = complete(w, { durableDirectory, now: () => at });
  let agent = await w.agent(options);
  at = w.now + 11;
  assert.deepEqual(await refused(() => agent.receiveProposal(request)), { code: 'session_not_admitted', status: 409 });
  assert.equal(agent.stageOf(w.jobId), null);
  agent.close();
  agent = await w.agent(options);
  assert.deepEqual(await refused(() => agent.receiveProposal(request)), { code: 'session_not_admitted', status: 409 });
  at = w.now + 10;
  const signed = await agent.receiveProposal(request);
  assert.equal(signed.disposition, 'complete', 'notAfter itself remains allowed');
  agent.close(); at++;
  agent = await w.agent(options);
  t.after(() => agent.close());
  assert.deepEqual((await agent.receiveProposal(request)).contribution, signed.contribution, 'signed session remains available after expiry');
});


// Interrupts the first proposal over HTTP after the seller contribution is saved and
// before the final proposal checkpoint, then restarts the seller. Answers a reader of
// the number of Agreement signatures made so far.
let finalProposalCutSequence = 0;
async function cutBeforeFinalProposalCheckpoint(t, w) {
  let agreementSigns = 0;
  const sign = w.signer.sign;
  w.signer.sign = (bytes) => {
    if (Buffer.from(bytes).toString().startsWith('dacs-payee-bound-agreement:v1:')) agreementSigns++;
    return sign(bytes);
  };
  // Contribution publication now saves its proposal binding atomically. The
  // final snapshot may have identical bytes, so interrupt that save directly
  // instead of relying on a second invocation of the cached snapshot signer.
  const { privateModule } = await import('./helpers/private-module.mjs');
  const api = await privateModule(new URL('../src/dacs/seller-agent.mjs', import.meta.url), [], source => {
    const checkpoint = source.indexOf('    session.sellerContribution = structuredClone(progress.result.sellerContribution);');
    assert.ok(checkpoint >= 0);
    const save = source.indexOf('    persist(session);', checkpoint);
    assert.ok(save > checkpoint);
    return `let TEST_finalSaveCut = true;\n// TEST final proposal ${++finalProposalCutSequence}\n` + source.slice(0, save)
      + "    if (TEST_finalSaveCut) { TEST_finalSaveCut = false; throw new Error('TEST interrupted final session persistence'); }\n" + source.slice(save);
  });
  w.agent = options => api.createSellerAgent(options);
  const h = await httpSeller(t, w);
  await answered(() => h.client.propose(h.proposal));
  assert.equal(h.last.status, 503);
  const retained = h.agent.durableSessionOf(w.jobId);
  assert.ok(retained.sellerContribution, 'contribution was saved');
  assert.equal(retained.proposal.proposalHash, h.proposal.proposal.proposalHash, 'contribution and proposal binding were saved atomically');
  await h.restart(w.steward.railAuthority());
  return { h, agreementSigns: () => agreementSigns };
}

test('HTTP proposal recovery completes a contribution saved before its final proposal checkpoint without signing twice', async (t) => {
  const w = await world(t);
  const { h, agreementSigns } = await cutBeforeFinalProposalCheckpoint(t, w);
  const answer = await h.client.propose(h.proposal);
  assert.equal(answer.disposition, 'complete');
  assert.equal(agreementSigns(), 1, 'the durable signature is reused');
});

test('read-only recovery answers a contribution saved before its final proposal checkpoint without signing', async (t) => {
  const w = await world(t);
  const { h, agreementSigns } = await cutBeforeFinalProposalCheckpoint(t, w);
  const body = h.proposal, rawBody = Buffer.from(JSON.stringify(body));
  const request = { method: 'POST', path: '/dacs/v1/agreements/proposals', jobId: w.jobId, buyer: w.buyerKey.claim, seller: w.signer.claim,
    listingPin: seller.listingPin(w.listing), agreementHash: body.proposal.plan.agreementHash, bodyHash: core.sha256Hex(rawBody) };
  const answer = await h.agent.reconcileTransport({ request, body, rawBody, readOnly: true });
  assert.equal(answer.disposition, 'present');
  assert.equal(answer.value.disposition, 'complete');
  assert.equal(agreementSigns(), 1, 'nothing was signed again');
});

test('a completed durable signature keeps its rail pin when the next session save fails', async (t) => {
  const w = await world(t), durableDirectory = w.dir(), request = await w.proposalFor(w.vetted);
  let cut = true, signed = 0;
  const signer = { ...w.signer, sign: (bytes) => {
    const text = Buffer.from(bytes).toString();
    if (text.startsWith('dacs-payee-bound-agreement:v1:')) signed++;
    if (cut && text.includes('"kind":"session"') && text.includes('"railPinSigned":true')) {
      cut = false; throw new Error('TEST lost post-signature session save');
    }
    return w.signer.sign(bytes);
  } };
  const first = await w.agent(complete(w, { durableDirectory, signer }));
  assert.equal((await first.receiveProposal(request)).disposition, 'indeterminate');
  assert.notEqual(first.durableSessionOf(w.jobId).railPinSigned, true);
  assert.equal(typeof first.durableSessionOf(w.jobId).agreementSignatureKey, 'string');
  first.close();
  const after = await w.agent(complete(w, { durableDirectory, signer, railAuthority: w.steward.railAuthority({ changes: { availability: 'disabled' } }) }));
  t.after(() => after.close());
  assert.equal((await after.receiveProposal(request)).disposition, 'complete');
  assert.equal(signed, 1, 'the completed durable signature continues its original pin');
});

test('a Listing that expires during context resolution signs no new Agreement', async (t) => {
  const w = await world(t, { listingChanges: (draft) => { draft.validity.notAfter = draft.validity.notBefore + 60010; } });
  let at = w.now;
  const context = createDemDeliveryContext({ authority: 'TEST-expiry-during-context', resolveBuyer: notCalled, resolveSeller: async () => {
    at = w.now + 11;
    return { disposition: 'present', value: { input: w.vetted, vetRequirements: [['buyer', w.buyerKey.claim, w.sellerKey.claim], ['seller', w.sellerKey.claim, w.buyerKey.claim]].map(([role, evaluatedParty, verifier]) => ({
      vetRecordRef: w.vetted[role].vetRecordRef, evaluatedParty, verifier, requirement: w.listing.buyerRequirement, freshness: [], dealSpecific: [] })) } };
  } });
  const agent = await w.agent(complete(w, { durableDirectory: w.dir(), demDeliveryContext: context, now: () => at }));
  t.after(() => agent.close());
  const answer = await agent.receiveProposal(await w.proposalFor(w.vetted));
  assert.notEqual(answer.disposition, 'complete');
  assert.equal(agent.durableSessionOf(w.jobId)?.sellerContribution, undefined);
  assert.equal(agent.durableSessionOf(w.jobId)?.agreementSignatureKey, undefined);
});


test('rail key history authenticates only in-flight pins, including legacy pins, and never trusts a saved key or altered definition', () => {
  const previous = railSteward(), current = railSteward(), stranger = railSteward();
  const old = railAuthorityConfig(previous.railAuthority());
  const pin = old.pin();
  const config = { ...current.railAuthority(), historicalStewards: [{ stewardClaim: previous.stewardClaim, stewardPublicKey: previous.stewardPublicKey }] };
  const rotated = railAuthorityConfig(config);
  config.historicalStewards[0].stewardPublicKey = stranger.stewardPublicKey;
  assert.equal(rotated.evaluate(pin, 'in-flight').decision, 'pass');
  const legacy = structuredClone(pin); delete legacy.stewardClaim; delete legacy.stewardPublicKey;
  assert.equal(rotated.evaluate(legacy, 'in-flight').decision, 'pass');
  assert.equal(rotated.evaluate(pin, 'new').decision, 'fail');
  assert.equal(rotated.evaluate(rotated.pin(), 'new').decision, 'pass');
  assert.equal(railAuthorityConfig(current.railAuthority()).evaluate(pin, 'in-flight').decision, 'fail');
  assert.equal(rotated.evaluate(railAuthorityConfig(stranger.railAuthority()).pin(), 'in-flight').decision, 'fail');
  assert.equal(rotated.evaluate({ ...pin, stewardClaim: current.stewardClaim }, 'in-flight').decision, 'fail');
  assert.equal(rotated.evaluate({ ...pin, stewardPublicKey: stranger.stewardPublicKey }, 'in-flight').decision, 'fail');
  const sameClaim = current.railAuthority({ authority: { stewardClaim: previous.stewardClaim } });
  sameClaim.rail.signature.signer = previous.stewardClaim;
  const sameIdentity = railAuthorityConfig({ ...sameClaim, historicalStewards: [{ stewardClaim: previous.stewardClaim, stewardPublicKey: previous.stewardPublicKey }] });
  assert.equal(sameIdentity.evaluate(pin, 'in-flight').decision, 'pass', 'same claim with a new key');
  assert.equal(sameIdentity.evaluate(legacy, 'in-flight').decision, 'pass', 'legacy pin under a rotated stable identity');
  assert.equal(sameIdentity.evaluate(pin, 'new').decision, 'fail');
  assert.equal(sameIdentity.evaluate(sameIdentity.pin(), 'new').decision, 'pass');
  const altered = structuredClone(pin); altered.rail.parameters = { changed: true };
  assert.equal(rotated.evaluate(altered, 'in-flight').decision, 'fail');
  assert.throws(() => railAuthorityConfig({ ...current.railAuthority(), historicalStewards: {} }), /must be an array/);
  const many = Array.from({ length: 65 }, () => railSteward());
  const completeHistory = railAuthorityConfig({ ...current.railAuthority(), historicalStewards: many.map(({ stewardClaim, stewardPublicKey }) => ({ stewardClaim, stewardPublicKey })) });
  for (const identity of [many[0], many[64]]) assert.equal(completeHistory.evaluate(railAuthorityConfig(identity.railAuthority()).pin(), 'in-flight').decision, 'pass', 'every configured historical identity remains authorized');
});


test('a binding with durable accepted admission may still supply an accepted Vet receipt', async (t) => {
  const w = await world(t), party = w.buyerKey.claim;
  const ref = await w.admission.vetRecord(w.jobId, party, w.buyerBundle, { requirement: w.listing.buyerRequirement });
  const receipt = await w.admission.sessionAdmission.readVetAnchorReceipt({ ref });
  assert.equal(vetAnchorReceiptProblem({ ...receipt, substrate: 'test-durable-admission', state: 'accepted' }, { ref, jobId: w.jobId, party }), null);
});


test('a not-yet-valid Listing refuses a fresh session after restart and admits it exactly at notBefore', async (t) => {
  const w = await world(t, { listingChanges: (draft) => { draft.validity.notBefore += 60010; } });
  // Persist a valid initial Listing admission, then restore it while the
  // clock is before notBefore. Startup always validates a fresh Listing.
  let at = w.listing.validity.notBefore;
  const input = { ...w.vetted, generatedAt: at };
  const options = complete(w, { durableDirectory: w.dir(), now: () => at, demDeliveryContext: w.chain.demDeliveryContext(input) });
  let agent = await w.agent(options);
  at--;
  const request = await w.proposalFor(input);
  assert.deepEqual(await refused(() => agent.receiveProposal(request)), { code: 'session_not_admitted', status: 409 });
  assert.equal(agent.stageOf(w.jobId), null);
  agent.close();
  agent = await w.agent(options);
  t.after(() => agent.close());
  assert.deepEqual(await refused(() => agent.receiveProposal(request)), { code: 'session_not_admitted', status: 409 });
  at = w.listing.validity.notBefore;
  assert.equal((await agent.receiveProposal(request)).disposition, 'complete', 'notBefore itself is inclusive');
});

test('malformed attempts consume recognized challenges before shape validation, including across restart', async (t) => {
  const w = await world(t), durableDirectory = w.dir();
  const open = () => seller.createSellerAgent(complete(w, { durableDirectory }));
  let agent = await open();
  t.after(() => agent.close());
  const request = await w.proposalFor(w.vetted);
  const malformed = structuredClone(w.buyerBundle);
  delete malformed.presentation;
  assert.deepEqual(await refused(() => agent.receiveProposal({ ...request, buyerIdentityBundle: malformed })), { code: 'buyer_bundle_invalid', status: 422 });
  agent.close(); agent = await open();
  assert.deepEqual(await refused(() => agent.receiveProposal(request)), { code: 'session_not_admitted', status: 409 });
  assert.equal(w.admission.calls.filter(([call]) => call === 'admit').length, 0);
  // A fresh challenge still permits a valid presentation.
  const nonce = (await agent.issueSessionChallenge({ jobId: w.jobId, buyer: w.buyerKey.claim })).sessionNonce;
  const bundle = presentWith(w.buyerKey, w.now, nonce);
  // The changed bundle needs matching Vet context; this test uses the existing
  // valid request instead to check that the fresh attempt reaches admission.
  await agent.receiveProposal({ ...request, buyerIdentityBundle: bundle });
  assert.equal(w.admission.calls.filter(([call]) => call === 'admit').length, 1);
});

test('accepted presentations retain complete proof bytes across restart; an exact retry continues', async (t) => {
  const w = await world(t), durableDirectory = w.dir();
  const open = () => seller.createSellerAgent(complete(w, { durableDirectory }));
  let agent = await open();
  t.after(() => agent.close());
  const request = await w.proposalFor(w.vetted);
  const accepted = await agent.receiveProposal(request);
  assert.equal(accepted.disposition, 'complete');
  const changed = structuredClone(w.buyerBundle);
  // Ed25519 permits a different signing nonce for the same message. Produce
  // another valid signature so identityBundleHash alone cannot distinguish it.
  const { ed25519 } = await import('@noble/curves/ed25519');
  const order = 2n ** 252n + 27742317777372353535851937790883648493n;
  const little = bytes => BigInt('0x' + Buffer.from(bytes).reverse().toString('hex'));
  const scalarBytes = n => Buffer.from(n.toString(16).padStart(64, '0'), 'hex').reverse();
  const seed = Buffer.from(w.buyerKey.privateKey.export({ format: 'jwk' }).d, 'base64url');
  const expanded = createHash('sha512').update(seed).digest().subarray(0, 32);
  expanded[0] &= 248; expanded[31] &= 63; expanded[31] |= 64;
  const publicKey = Buffer.from(w.buyerKey.claim.slice(16), 'hex');
  const message = Buffer.from(`dacs-bundle-presentation:v1:${core.identityBundleHash(changed)}`);
  const nonce = 7n, point = Buffer.from(ed25519.ExtendedPoint.BASE.multiply(nonce).toRawBytes());
  const challenge = little(createHash('sha512').update(point).update(publicKey).update(message).digest()) % order;
  const signature = Buffer.concat([point, scalarBytes((nonce + challenge * little(expanded)) % order)]);
  assert.equal(verify(null, message, w.buyerKey.privateKey, signature), true);
  changed.presentation.signatures[0].signature = signature.toString('base64url');
  assert.notEqual(changed.presentation.signatures[0].signature, w.buyerBundle.presentation.signatures[0].signature);
  assert.equal(core.identityBundleHash(changed), core.identityBundleHash(w.buyerBundle), 'identity hash excludes presentation proofs');
  for (const restart of [false, true]) {
    if (restart) { agent.close(); agent = await open(); }
    assert.deepEqual(await refused(() => agent.receiveProposal({ ...request, buyerIdentityBundle: changed })), { code: 'session_not_admitted', status: 409 });
    assert.deepEqual((await agent.receiveProposal(request)).contribution, accepted.contribution);
  }
});

test('steward history rejects malformed identities at configuration and retains valid old keys', () => {
  const previous = railSteward(), current = railSteward();
  const entry = { stewardClaim: previous.stewardClaim, stewardPublicKey: previous.stewardPublicKey };
  for (const changed of [{ stewardPublicKey: entry.stewardPublicKey + '=' }, { stewardClaim: 'not a claim' }, { stewardPublicKey: Buffer.alloc(31).toString('base64url') }]) {
    assert.throws(() => railAuthorityConfig({ ...current.railAuthority(), historicalStewards: [{ ...entry, ...changed }, entry] }), /historicalStewards/);
  }
  const retained = railAuthorityConfig(previous.railAuthority()).pin();
  delete retained.stewardClaim; delete retained.stewardPublicKey;
  assert.equal(railAuthorityConfig({ ...current.railAuthority(), historicalStewards: [entry] }).evaluate(retained, 'in-flight').decision, 'pass');
});

test('the default store admits job 1001 and atomically reserves the last configured slot', async (t) => {
  const { createSellerDurableState } = await import('../src/dacs/seller-durable-state.mjs');
  const w = await world(t);
  const store = await createSellerDurableState({ dir: w.dir(), signer: w.signer, listingPin: seller.listingPin(w.listing) });
  try {
    for (let i = 0; i < 1001; i++) {
      const jobId = core.generateCanonicalJobId();
      await store.withJob(jobId, () => store.saveSession({ jobId }));
    }
    assert.equal(store.sessions().length, 1001);
  } finally { store.close(); }
  const limited = await createSellerDurableState({ dir: w.dir(), signer: w.signer, listingPin: seller.listingPin(w.listing), maxJobs: 1 });
  try {
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const pending = new Promise(resolve => { entered = resolve; });
    const first = limited.withJob(core.generateCanonicalJobId(), async () => { entered(); await gate; });
    await pending;
    await assert.rejects(limited.withJob(core.generateCanonicalJobId(), () => assert.fail('capacity must refuse before admission')), { code: 'seller_state_capacity' });
    release(); await first;
    await limited.withJob(core.generateCanonicalJobId(), () => {});
  } finally { limited.close(); }
});


test('an admitted unsigned proposal resumes after challenge expiry, including across restart; an unused expired challenge stays refused', async t => {
 const w = await world(t), durableDirectory = w.dir();
 let clock = w.now;
 const options = complete(w, { durableDirectory, now: () => clock });
 let agent = await w.agent(options);
 t.after(() => agent.close());
 const request = await w.proposalFor(w.vetted);
 w.admission.verifyReceiptWith(() => 'indeterminate');
 assert.notEqual((await agent.receiveProposal(request)).disposition, 'complete');
 assert.equal(agent.stageOf(w.jobId), null);
 clock += SESSION_CHALLENGE_LIFETIME_MS;
 agent.close(); agent = await seller.createSellerAgent(options);
 w.admission.verifyReceiptWith(null);
 const done = await agent.receiveProposal(request);
 assert.equal(done.disposition, 'complete');
 assert.deepEqual((await agent.receiveProposal(request)).contribution, done.contribution);
 const other = await world(t), late = await seller.createSellerAgent(complete(other, { durableDirectory: other.dir(), now: () => clock }));
 t.after(() => late.close());
 const expired = presentWith(other.buyerKey, other.now, (await late.issueSessionChallenge({ jobId: other.jobId, buyer: other.buyerKey.claim })).sessionNonce);
 clock += SESSION_CHALLENGE_LIFETIME_MS;
 assert.deepEqual(await refused(async () => late.receiveProposal({ ...await other.proposalFor(other.vetted), buyerIdentityBundle: expired })), { code: 'session_not_admitted', status: 409 });
});

// A retained signing intent is not a completed signature: an unsigned retry
// signs for the first time, so it is a new signing attempt and must pass the
// seller's clock window on the current clock, not on the first attempt's
// observation time.
test('an unsigned retry outside the seller clock window is refused before any Agreement signature', async (t) => {
  const w = await world(t);
  let clock = w.now, agreementSignings = 0, failOnce = true;
  const sign = bytes => {
    const text = Buffer.from(bytes).toString();
    if (text.startsWith('dacs-payee-bound-agreement:v1:')) {
      agreementSignings += 1;
      if (failOnce) { failOnce = false; throw new Error('TEST signer failed'); }
    }
    return w.sellerKey.sign(bytes);
  };
  const options = complete(w, { durableDirectory: w.dir(), now: () => clock, signer: { claim: w.sellerKey.claim, sign } });
  const request = await w.proposalFor(w.vetted);
  let agent = await w.agent(options);
  const first = await agent.receiveProposal(request);
  assert.equal(first.disposition, 'indeterminate', 'the failed signer leaves the signing outcome unknown');
  assert.equal(agreementSignings, 1, 'the first attempt reached the signer');
  agent.close();
  clock += 600001;
  agent = await w.agent(options);
  t.after(() => agent.close());
  const retry = await agent.receiveProposal(request);
  assert.equal(retry.disposition, 'rejected');
  assert.match(retry.reason, /clock window/);
  assert.equal(agreementSignings, 1, 'the proposal outside the seller clock window is never signed');
  assert.equal(retry.contribution, undefined);
});

// The same rule for the admitted context route: its absolute Agreement
// deadline is rechecked at the signing attempt, including after a restart.
test('an unsigned retry after the admitted Agreement deadline is refused before any Agreement signature', async (t) => {
  const w = await world(t);
  let clock = w.now, agreementSignings = 0, failOnce = true;
  const sign = bytes => {
    const text = Buffer.from(bytes).toString();
    if (text.startsWith('dacs-payee-bound-agreement:v1:')) {
      agreementSignings += 1;
      if (failOnce) { failOnce = false; throw new Error('TEST signer failed'); }
    }
    return w.sellerKey.sign(bytes);
  };
  const options = complete(w, { durableDirectory: w.dir(), now: () => clock, contextRequest: () => true, signer: { claim: w.sellerKey.claim, sign } });
  const request = await w.proposalFor(w.vetted);
  let agent = await w.agent(options);
  const first = await agent.receiveProposal(request);
  assert.equal(first.disposition, 'indeterminate');
  assert.equal(agreementSignings, 1);
  agent.close();
  clock += w.listing.terms.deadlineSecAfterCommit * 1000 + 1;
  agent = await w.agent(options);
  t.after(() => agent.close());
  const retry = await agent.receiveProposal(request);
  assert.equal(retry.disposition, 'rejected');
  assert.match(retry.reason, /Agreement deadline/);
  assert.equal(agreementSignings, 1, 'the Agreement after its absolute deadline is never signed');
  assert.equal(retry.contribution, undefined);
});

// CORE §B.8 SN-1/SN-2: a matching saved nonce is insufficient when the
// presenter selected it before the verifier generated its challenge.
test('the agent refuses a presenter-chosen pre-signed nonce at issuance and admission', async (t) => {
  const w = await world(t), agent = await seller.createSellerAgent(complete(w, { durableDirectory: w.dir() }));
  t.after(() => agent.close());
  const chosen = presentWith(w.buyerKey, w.now, '01'.repeat(16));
  await assert.rejects(agent.issueSessionChallenge({ jobId: w.jobId, buyer: w.buyerKey.claim, sessionNonce: chosen.sessionNonce }), { code: 'challenge_invalid' });
  const request = await w.proposalFor(w.vetted);
  assert.deepEqual(await refused(() => agent.receiveProposal({ ...request, buyerIdentityBundle: chosen })), { code: 'session_not_admitted', status: 409 });
  assert.equal(w.admission.calls.filter(([call]) => call === 'admit').length, 0);
  assert.equal(agent.stageOf(w.jobId), null);
});

test('capacity reclaims only proven-exited unsaved reservations; live holders and saved sessions still count', async (t) => {
  const { fork } = await import('node:child_process');
  const { once } = await import('node:events');
  const { createSellerDurableState } = await import('../src/dacs/seller-durable-state.mjs');
  const signer = key(), listingPin = { listingId: 'reservation-recovery', version: 1, contentHash: 'a'.repeat(64) };
  for (const saved of [false, true]) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'seller-reservation-')));
    const jobA = core.generateCanonicalJobId(), jobB = core.generateCanonicalJobId();
    const initial = await createSellerDurableState({ dir, signer, listingPin, maxJobs: 1 });
    initial.retainContext({ admittedAt: 1, validation: { disposition: 'verified' } });
    initial.close();
    const child = fork(new URL('./helpers/seller-durable-state-lock-holder.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    t.after(() => { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });
    const message = async (input) => { const reply = once(child, 'message'); child.send(input); return (await reply)[0]; };
    await once(child, 'message');
    const held = await message({ type: 'hold', dir, listingPin, jobId: jobA, claim: signer.claim, pkcs8: signer.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') });
    assert.equal(held.code, null, JSON.stringify(held));
    if (saved) assert.equal((await message({ type: 'call', op: 'save' })).code, null);
    let store = await createSellerDurableState({ dir, signer, listingPin, maxJobs: 1 });
    try {
      assert.equal(store.inspectLocks()[0].holderExited, false);
      await assert.rejects(store.withJob(jobB, () => assert.fail('live reservation must count')), { code: 'seller_state_capacity' });
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      store.close(); store = await createSellerDurableState({ dir, signer, listingPin, maxJobs: 1 });
      assert.equal(store.inspectLocks()[0].holderExited, true);
      assert.equal(store.sessions().length, saved ? 1 : 0);
      if (saved) await assert.rejects(store.withJob(jobB, () => assert.fail('a saved session must count')), { code: 'seller_state_capacity' });
      else {
        await store.withJob(jobB, () => store.saveSession({ jobId: jobB }));
        assert.deepEqual(store.sessions().map(s => s.jobId), [jobB]);
        assert.equal(store.inspectLocks().length, 0, 'dead unsaved reservation reclaimed without requesting its job');
      }
    } finally { store.close(); }
  }
});

test('capacity never reclaims an unproven reservation', async (t) => {
  const { default: DatabaseSync } = await import('better-sqlite3');
  const { createSellerDurableState } = await import('../src/dacs/seller-durable-state.mjs');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'seller-unproven-reservation-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = await createSellerDurableState({ dir, signer: key(), listingPin: { listingId: 'unproven', version: 1, contentHash: 'a'.repeat(64) }, maxJobs: 1 });
  try {
    const db = new DatabaseSync(join(dir, 'seller-state.sqlite'));
    try { db.prepare('INSERT INTO seller_locks VALUES (?,?,?)').run(core.generateCanonicalJobId(), '1:TEST-legacy-holder', 1); } finally { db.close(); }
    assert.notEqual(store.inspectLocks()[0].reason, 'exited');
    await assert.rejects(store.withJob(core.generateCanonicalJobId(), () => assert.fail('unproven reservation must count')), { code: 'seller_state_capacity' });
    assert.equal(store.inspectLocks().length, 1);
  } finally { store.close(); }
});

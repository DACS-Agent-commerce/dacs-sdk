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
import { Readable } from 'node:stream';
import * as core from '@kynesyslabs/dacs';
import * as seller from '../src/index.mjs';
import { createDemDeliveryContext } from '../src/dacs/dem-delivery-context-consumer.mjs';
import { createNativeDemDeliveryCapability } from '../src/dacs/native-dem-delivery-consumer.mjs';
import { createNativePaymentEvidenceConsumer, NATIVE_PAYMENT_EVIDENCE } from '../src/dacs/native-payment-evidence-consumer.mjs';
import { SELLER_PRE_EFFECT_REFUSALS } from '../src/dacs/seller-http.mjs';
import { railSteward } from './helpers/rail-authority-fixture.mjs';
import { createSessionAdmissionFixture } from './helpers/session-admission-fixture.mjs';

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

async function world(t) {
  const sellerKey = key(), buyerKey = key(), now = Date.now(), reached = [], steward = railSteward();
  const admission = createSessionAdmissionFixture({ seller: sellerKey, buyer: buyerKey, now: () => now });
  const draft = seller.buildListingDraft({ identityBundle: identityFor(sellerKey, now - 1000), displayName: 'Profile seller', publicEndpoint: 'https://seller.invalid/agent',
    listingId: 'settlement-profile', listingVersion: 1, title: 'Settlement profile report', description: 'Settlement profile vectors.',
    category: 'services.market-report', tags: ['profile'], priceDem: '2.5', notBefore: now - 60000 });
  const listing = seller.attachListingSignature(draft, sellerKey.signWallet(seller.listingSigningMessage(draft)));
  const refuse = (name) => async () => { reached.push(name); throw new Error(`${name} is not reached`); };
  const dir = () => { const path = realpathSync(mkdtempSync(join(tmpdir(), 'seller-settlement-profile-'))); t.after(() => rmSync(path, { recursive: true, force: true })); return path; };
  const jobId = core.generateCanonicalJobId(), buyerBundle = identityFor(buyerKey, now);
  // The operator's Vet context: references to counterparty-verified records
  // (DACS-2 §7.7.2) the seller's session admission keeps, at the canonical
  // composite addresses.
  const synthetic = seller.agreementInput({ jobId, listing, buyerBundle, generatedAt: now });
  const vetted = { ...synthetic, buyer: { ...synthetic.buyer, vetRecordRef: await admission.vetRecord(jobId, buyerKey.claim, buyerBundle) },
    seller: { ...synthetic.seller, vetRecordRef: await admission.vetRecord(jobId, sellerKey.claim, listing.seller.identity) } };
  // The not-performed references with each counterparty verifier named, as a context could return them.
  const signedSynthetic = { ...synthetic, buyer: { ...synthetic.buyer, vetRecordRef: { ...synthetic.buyer.vetRecordRef, signer: sellerKey.claim } },
    seller: { ...synthetic.seller, vetRecordRef: { ...synthetic.seller.vetRecordRef, signer: buyerKey.claim } } };
  const capabilities = {
    signer: { claim: sellerKey.claim, sign: sellerKey.sign }, listing, now: () => now,
    buyerAccess: seller.createOperatorBuyerAccess({ openBuyerAccess: true }),
    agreementAnchor: { source: 'settlement-profile/agreement-readback', readAgreement: refuse('readAgreement') },
    nativeArtifactAnchor: { writer: sellerKey.claim, publish: refuse('publish'), readRetained: refuse('readRetained'), verifyReceipt: refuse('verifyReceipt') },
    deliverableProducer: () => { reached.push('deliverableProducer'); throw new Error('not reached'); },
    observeDemosTransfer: refuse('observeDemosTransfer'),
    railAuthority: steward.railAuthority(),
    sessionAdmission: admission.sessionAdmission,
  };
  const chain = {
    nativePaymentEvidence: () => createNativePaymentEvidenceConsumer({ rpcUrl: 'http://127.0.0.1:9/', anchorEvidence: refuse('anchorEvidence'), fetchImpl: refuse('fetch') }),
    demDeliveryContext: (input = vetted, vetRequirements = []) => createDemDeliveryContext({ authority: 'TEST-settlement-profile', resolveBuyer: refuse('resolveBuyer'),
      resolveSeller: async () => { reached.push('resolveSeller'); return { disposition: 'present', value: { input: structuredClone(input), vetRequirements: structuredClone(vetRequirements) } }; } }),
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
  return { capabilities, chain, dir, reached, jobId, synthetic, signedSynthetic, vetted, proposalFor, payment, listing, signer: capabilities.signer, steward, buyerKey, sellerKey, buyerBundle, admission, now };
}
const refused = async (work) => { try { await work(); return null; } catch (error) { return { code: error.code, status: error.status }; } };
const UNAVAILABLE = { code: 'settlement_profile_unavailable', status: 503 };

test('a native agent without the Vet context and delivery chain signs, commits and takes payment for nothing', async (t) => {
  const w = await world(t);
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
  const w = await world(t);
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
  const w = await world(t);
  const agent = await seller.createSellerAgent({ ...w.capabilities, durableDirectory: w.dir(), nativePaymentEvidence: w.chain.nativePaymentEvidence(),
    demDeliveryContext: w.chain.demDeliveryContext(), nativeDemDelivery: w.chain.nativeDemDelivery() });
  t.after(() => agent.close());
  assert.equal((await agent.receiveProposal(await w.proposalFor(w.vetted))).disposition, 'complete');
  assert.deepEqual(await refused(() => agent.submitPayment(w.payment)), { code: 'native_evidence_required', status: 409 });
  assert.deepEqual(w.reached.filter((name) => name !== 'resolveSeller'), []);
});

test('a Vet context that names the not-performed Vet references is not signed', async (t) => {
  const w = await world(t);
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
  const w = await world(t), durableDirectory = w.dir();
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
  const w = await world(t);
  const agent = await seller.createSellerAgent(complete(w, { durableDirectory: w.dir(), railAuthority: w.steward.railAuthority(authority) }));
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
    [w.steward.railAuthority({ changes: { governance: { proposedBy: w.steward.stewardClaim, acceptedAt: 1, anchoring: 'single-signer' } } }), /PA-1 in-code definition/],
    [{ ...w.steward.railAuthority(), production: 'yes' }, /local operator policy/],
    [{ ...w.steward.railAuthority(), extra: 1 }, /railAuthority must be exactly/],
  ]) await assert.rejects(seller.createSellerAgent(complete(w, { durableDirectory: w.dir(), railAuthority })), { name: 'TypeError', message });
  await assert.rejects(seller.createSellerAgent({ signer: w.signer, listing: w.listing, observeDemosTransfer: async () => null, anchors: { read: async () => null, write: async () => null }, simulatedFixture: true, railAuthority: w.steward.railAuthority() }),
    { name: 'TypeError', message: /simulated fixture profile takes no railAuthority/ });
  assert.deepEqual(w.reached, []);
});

test('an in-flight session keeps its pinned rail across a restart; a pin the steward did not sign is refused before any read', async (t) => {
  const w = await world(t), durableDirectory = w.dir();
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
  const w = await world(t);
  const { nativeArtifactAnchor: artifactAnchor, ...rest } = w.capabilities;
  const { now: _now, ...required } = rest;
  for (const missing of ['nativePaymentEvidence', 'demDeliveryContext', 'nativeDemDelivery', 'railAuthority', 'sessionAdmission']) {
    const dataDirectory = w.dir();
    const options = { ...required, artifactAnchor, dataDirectory, nativePaymentEvidence: w.chain.nativePaymentEvidence(), demDeliveryContext: w.chain.demDeliveryContext(), nativeDemDelivery: w.chain.nativeDemDelivery() };
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
const notReached = (name) => async () => { throw new Error(`${name} is not reached`); };
function nativeChain(w) {
  const TX = 'a1'.repeat(32), BLOCK = 'b2'.repeat(32), seen = { publish: 0, fetch: 0 }, retained = { stored: null, agreement: null };
  const nativeArtifactAnchor = {
    writer: w.signer.claim,
    publish: async ({ logicalAddress, artifact }) => {
      seen.publish++;
      const receipt = { receiptVersion: '1', substrate: 'TEST-offline-demos-sr2', finalityProfile: 'TEST-one-node-not-finality', logicalAddress,
        nativeAddress: `TEST-native-${core.sha256Hex(logicalAddress).slice(0, 16)}`, contentHash: core.contentHash(artifact), transactionRef: { kind: 'demos-tx', value: TX },
        writer: w.signer.claim, nonce: '7', state: 'finalized', observationDisposition: 'established', observedAt: Date.now() + 1000,
        evidence: { kind: 'demos-tx', value: TX }, blockRef: { id: BLOCK, height: '9', timestamp: Date.now() + 1000 } };
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
  const nativePaymentEvidence = createNativePaymentEvidenceConsumer({ rpcUrl: 'http://127.0.0.1:9/', anchorEvidence: notReached('anchorEvidence'),
    fetchImpl: async () => { seen.fetch++; throw new Error('TEST transfer observation is not answered'); } });
  const options = (railAuthority, durableDirectory) => ({ ...w.capabilities, nativeArtifactAnchor, agreementAnchor, durableDirectory, railAuthority, nativePaymentEvidence,
    demDeliveryContext: w.chain.demDeliveryContext(), nativeDemDelivery: w.chain.nativeDemDelivery() });
  // The buyer finalizes the Agreement from both contributions and anchors it.
  const anchorAgreement = async (session) => {
    retained.agreement = await core.finalizeFixedPriceAgreementContributions(session.proposal.plan, [session.proposal.buyerContribution, session.sellerContribution], seller.contributionVerifier);
  };
  return { seen, options, anchorAgreement };
}
const nativeClaim = (w) => ({ ...w.payment, nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE });

test('a committed native session takes its payment claim to the transfer observation under its pinned rail, also after a restart with a later registry version or a disabled revision', async (t) => {
  for (const later of [{ authority: { railRegistryVersion: 2 } }, { changes: { availability: 'disabled' }, authority: { railRegistryVersion: 2 } }]) {
    const w = await world(t), chain = nativeChain(w), durableDirectory = w.dir();
    const first = await seller.createSellerAgent(chain.options(w.steward.railAuthority(), durableDirectory));
    assert.equal((await first.receiveProposal(await w.proposalFor(w.vetted))).disposition, 'complete');
    await chain.anchorAgreement(first.durableSessionOf(w.jobId));
    assert.equal((await first.commit({ jobId: w.jobId })).status, 'committed');
    const pinned = first.durableSessionOf(w.jobId).railPin;
    first.close();
    // The operator moves to registry version 2. RAV-R2: the session keeps the
    // definition it pinned at session start, registry version 1.
    const agent = await seller.createSellerAgent(chain.options(w.steward.railAuthority(later), durableDirectory));
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
  const first = await seller.createSellerAgent(complete(w, { durableDirectory, demDeliveryContext: w.chain.demDeliveryContext(w.synthetic) }));
  assert.equal((await first.receiveProposal(await w.proposalFor(w.synthetic))).disposition, 'rejected');
  assert.equal(first.durableSessionOf(w.jobId)?.sellerContribution, undefined);
  first.close();
  // The steward disables the rail and keeps the registry version. The retry is a new session: no Agreement is signed.
  const disabled = await seller.createSellerAgent(complete(w, { durableDirectory, railAuthority: w.steward.railAuthority({ changes: { availability: 'disabled' } }) }));
  assert.deepEqual(await refused(async () => disabled.receiveProposal(await w.proposalFor(w.vetted))), { code: 'rail_unavailable', status: 503 });
  assert.equal(disabled.durableSessionOf(w.jobId)?.sellerContribution, undefined, 'no seller contribution');
  disabled.close();
  // Under a live rail the same retry is signed, and its pin is the current definition.
  const live = w.steward.railAuthority();
  const relive = await seller.createSellerAgent(complete(w, { durableDirectory, railAuthority: live }));
  const signed = await relive.receiveProposal(await w.proposalFor(w.vetted));
  assert.equal(signed.disposition, 'complete');
  const session = relive.durableSessionOf(w.jobId);
  assert.equal(session.railPinSigned, true);
  assert.deepEqual(session.railPin.rail, live.rail);
  relive.close();
  // Once signed, the pin is in flight: the signed proposal again under a disabled revision answers the same contribution.
  const after = await seller.createSellerAgent(complete(w, { durableDirectory, railAuthority: w.steward.railAuthority({ changes: { availability: 'disabled' } }) }));
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
  const build = (railAuthority) => seller.createSellerAgent(chain.options(railAuthority, durableDirectory));
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
test('the HTTP journal answers every pre-effect gate refusal as definite and keeps no effect, so the same request runs again', async (t) => {
  assert.deepEqual([...SELLER_PRE_EFFECT_REFUSALS].sort(), PRE_EFFECT_GATES.map(([code]) => code).sort());
  for (const [code, status] of PRE_EFFECT_GATES) {
    const w = await world(t), h = await httpSeller(t, w, { gate: { receiveProposal: code } });
    await answered(() => h.client.propose(h.proposal));
    assert.deepEqual([h.last.status, h.last.answer.error], [status, code], code);
    assert.equal((await h.client.propose(h.proposal)).disposition, 'complete', `${code}: the same proposal runs once the gate opens`);
  }
});

// ---- Session admission: profile, challenge, revocation and Vet records ----
test('a native agent without the seller\'s session admission opens no session', async (t) => {
  const w = await world(t);
  const { sessionAdmission: _none, ...capabilities } = complete(w, { durableDirectory: w.dir() });
  const agent = await seller.createSellerAgent(capabilities);
  t.after(() => agent.close());
  assert.deepEqual(await refused(async () => agent.receiveProposal(await w.proposalFor(w.vetted))), { code: 'session_admission_required', status: 503 });
  assert.equal(agent.stageOf(w.jobId), null);
  assert.deepEqual(w.admission.calls, []);
  assert.deepEqual(w.reached, []);
});

test('a Vet reference is signed only through the passing record of this job, party and bundle it names, signed by the party\'s counterparty verifier', async (t) => {
  const w = await world(t), other = key(), buyer = w.buyerKey.claim, sellerClaim = w.sellerKey.claim, sellerBundle = w.listing.seller.identity;
  const fabricated = { ...w.vetted.buyer.vetRecordRef, contentHash: core.sha256Hex(`installed-vet:${w.jobId}:${buyer}`) };
  const refs = {
    'no record behind the hash': ['buyer', fabricated],
    'a failing decision': ['buyer', await w.admission.vetRecord(w.jobId, buyer, w.buyerBundle, { decision: 'fail' })],
    'another signer': ['buyer', await w.admission.vetRecord(w.jobId, buyer, w.buyerBundle, { signer: other })],
    'another job': ['buyer', await w.admission.vetRecord(w.jobId, buyer, w.buyerBundle, { recordJobId: core.generateCanonicalJobId() })],
    'another bundle': ['buyer', await w.admission.vetRecord(w.jobId, buyer, w.buyerBundle, { bundleHash: core.sha256Hex('another bundle') })],
  };
  // DACS-2 §7.7.2: the seller's record is the buyer's to verify and the buyer's
  // the seller's. A party's own signature is refused at the reference, before
  // any record is read; a reference naming the counterparty is refused at the
  // record it names when the party signed that record itself.
  const notCounterparty = /^DEM_DELIVERY_CONTEXT_INPUT_MISMATCH: (buyer|seller) Vet ref is not signed by its counterparty verifier$/;
  const counterpartyRefs = {
    'a seller record the seller signed as its own verifier': ['seller', await w.admission.vetRecord(w.jobId, sellerClaim, sellerBundle, { verifier: w.sellerKey }), notCounterparty],
    'a buyer record the buyer signed as its own verifier': ['buyer', await w.admission.vetRecord(w.jobId, buyer, w.buyerBundle, { verifier: w.buyerKey }), notCounterparty],
    'a seller record the seller signed, under a reference naming the buyer': ['seller', await w.admission.vetRecord(w.jobId, sellerClaim, sellerBundle, { signer: w.sellerKey }),
      /^VET_RECORD_UNVERIFIED: seller: the Vet record is not signed by its counterparty verifier$/],
  };
  for (const [label, [role, ref, reason]] of Object.entries({ ...refs, ...counterpartyRefs })) {
    const input = { ...w.vetted, [role]: { ...w.vetted[role], vetRecordRef: ref } }, reads = w.admission.calls.filter(([call]) => call === 'resolveVetRecord').length;
    const agent = await seller.createSellerAgent(complete(w, { durableDirectory: w.dir(), demDeliveryContext: w.chain.demDeliveryContext(input) }));
    const answer = await agent.receiveProposal(await w.proposalFor(input));
    agent.close();
    assert.equal(answer.disposition, 'rejected', label);
    assert.equal(answer.contribution, undefined, `${label}: no seller contribution is issued`);
    if (reason) assert.match(answer.reason, reason, label);
    if (reason === notCounterparty) assert.equal(w.admission.calls.filter(([call]) => call === 'resolveVetRecord').length, reads, `${label}: no Vet record is read`);
  }
  assert.deepEqual(w.reached.filter((name) => name !== 'resolveSeller'), []);
});

// The delivery audit source carries the Vet context's requirement invocations;
// core's delivery runner takes one only for a party's record, evaluating that
// party and naming its counterparty verifier. Any other is refused before the
// seller signs, never after payment.
test('a Vet context whose requirement invocations do not name the record\'s party and its counterparty verifier is not signed', async (t) => {
  const w = await world(t), buyer = w.buyerKey.claim, sellerClaim = w.sellerKey.claim;
  const invocation = (role, evaluatedParty, verifier, vetRecordRef = w.vetted[role].vetRecordRef) => ({ vetRecordRef: structuredClone(vetRecordRef), evaluatedParty,
    requirement: structuredClone(w.listing.buyerRequirement), verifier, freshness: [], dealSpecific: [] });
  const buyerInvocation = invocation('buyer', buyer, sellerClaim), sellerInvocation = invocation('seller', sellerClaim, buyer);
  const refused = {
    'the seller as verifier of its own record': [buyerInvocation, invocation('seller', sellerClaim, sellerClaim)],
    'the buyer as verifier of its own record': [invocation('buyer', buyer, buyer), sellerInvocation],
    'another evaluated party': [invocation('buyer', sellerClaim, buyer), sellerInvocation],
    'a record the Agreement does not reference': [buyerInvocation, invocation('seller', sellerClaim, buyer, { ...w.vetted.seller.vetRecordRef, contentHash: core.sha256Hex('TEST another record') })],
  };
  for (const [label, vetRequirements] of Object.entries({ ...refused, 'each record\'s party and counterparty verifier': [buyerInvocation, sellerInvocation] })) {
    const agent = await seller.createSellerAgent(complete(w, { durableDirectory: w.dir(), demDeliveryContext: w.chain.demDeliveryContext(w.vetted, vetRequirements) }));
    const answer = await agent.receiveProposal(await w.proposalFor(w.vetted));
    agent.close();
    if (!(label in refused)) { assert.equal(answer.disposition, 'complete', label); continue; }
    assert.equal(answer.disposition, 'rejected', label);
    assert.equal(answer.contribution, undefined, `${label}: no seller contribution is issued`);
    assert.match(answer.reason, /^VET_RECORD_UNVERIFIED: a Vet requirement invocation does not name its party's record, that party and its counterparty verifier$/, label);
  }
  assert.deepEqual(w.reached.filter((name) => name !== 'resolveSeller'), []);
});

test('a presentation the seller did not challenge, a revoked or unread Listing and a missing or different profile are refused before any session is kept', async (t) => {
  const w = await world(t);
  const profile = (answer, change) => ({ ...answer, participants: answer.participants.map((entry) => entry.role === 'buyer' ? { ...entry, ...change } : entry) });
  const stale = w.now - 10 * 60 * 1000;
  const refusals = {
    'a presenter-chosen nonce': (answer) => ({ ...answer, challenge: { ...answer.challenge, nonce: core.sha256Hex('another challenge') } }),
    'an unconsumed challenge': (answer) => ({ ...answer, challenge: { nonce: answer.challenge.nonce } }),
    'a stale challenge': (answer) => ({ ...answer, challenge: { ...answer.challenge, consumedAt: stale } }),
    'another job': (answer) => ({ ...answer, jobId: core.generateCanonicalJobId() }),
    'another bundle': (answer) => ({ ...answer, buyerBundleHash: core.sha256Hex('another bundle') }),
    'a revoked Listing': (answer) => ({ ...answer, listingStatus: { ...answer.listingStatus, status: 'revoked' } }),
    'an unknown revocation state': (answer) => ({ ...answer, listingStatus: { ...answer.listingStatus, status: 'indeterminate' } }),
    'a stale revocation reading': (answer) => ({ ...answer, listingStatus: { ...answer.listingStatus, observedAt: stale } }),
    'no buyer profile': (answer) => ({ ...answer, participants: answer.participants.filter((entry) => entry.role !== 'buyer') }),
    'a duplicate buyer profile': (answer) => ({ ...answer, participants: [...answer.participants, answer.participants[0]] }),
    'an older Standard revision': (answer) => profile(answer, { standardRevision: '0'.repeat(40) }),
    'a different document tuple': (answer) => profile(answer, { documentVersions: { ...answer.participants[0].documentVersions, 'DACS-4': '0.7' } }),
    'a profile for another identity': (answer) => profile(answer, { claim: key().claim }),
    'a refusal': () => ({ disposition: 'refused', reason: 'TEST not admitted' }),
    'nothing': () => undefined,
  };
  const agent = await seller.createSellerAgent(complete(w, { durableDirectory: w.dir() }));
  t.after(() => agent.close());
  for (const [label, change] of Object.entries(refusals)) {
    w.admission.answerWith(change);
    assert.deepEqual(await refused(async () => agent.receiveProposal(await w.proposalFor(w.vetted))), { code: 'session_not_admitted', status: 409 }, label);
    assert.equal(agent.stageOf(w.jobId), null, `${label}: no session is kept`);
  }
  w.admission.answerWith(() => { throw new Error('TEST admission store is down'); });
  assert.deepEqual(await refused(async () => agent.receiveProposal(await w.proposalFor(w.vetted))), { code: 'session_admission_unavailable', status: 503 });
  w.admission.answerWith(null);
  assert.equal((await agent.receiveProposal(await w.proposalFor(w.vetted))).disposition, 'complete', 'the admitted session is signed');
  assert.deepEqual(w.reached.filter((name) => name !== 'resolveSeller'), []);
});

test('a session in flight continues after its Listing is revoked; a new session on it is refused', async (t) => {
  const w = await world(t), agent = await seller.createSellerAgent(complete(w, { durableDirectory: w.dir() }));
  t.after(() => agent.close());
  const signed = await agent.receiveProposal(await w.proposalFor(w.vetted));
  assert.equal(signed.disposition, 'complete');
  w.admission.answerWith((answer) => ({ ...answer, listingStatus: { ...answer.listingStatus, status: 'revoked' } }));
  assert.deepEqual((await agent.receiveProposal(await w.proposalFor(w.vetted))).contribution, signed.contribution, 'the in-flight session is answered again');
  const next = { ...w.vetted, jobId: core.generateCanonicalJobId() }, request = await w.proposalFor(next);
  assert.deepEqual(await refused(() => agent.receiveProposal({ ...request, transportIdentity: { ...request.transportIdentity, jobId: next.jobId } })), { code: 'session_not_admitted', status: 409 });
});

test('over HTTP an admission refusal keeps no effect: the same proposal is signed once it is admitted', async (t) => {
  const w = await world(t), h = await httpSeller(t, w);
  w.admission.answerWith((answer) => ({ ...answer, listingStatus: { ...answer.listingStatus, status: 'revoked' } }));
  await answered(() => h.client.propose(h.proposal));
  assert.deepEqual([h.last.status, h.last.answer.error], [409, 'session_not_admitted']);
  w.admission.answerWith(() => { throw new Error('TEST admission store is down'); });
  await answered(() => h.client.propose(h.proposal));
  assert.deepEqual([h.last.status, h.last.answer.error], [503, 'session_admission_unavailable']);
  w.admission.answerWith(null);
  assert.equal((await h.client.propose(h.proposal)).disposition, 'complete');
});

test('a buyer presentation signature is accepted only in canonical unpadded Base64URL (CORE SIG-6)', async (t) => {
  const w = await world(t), agent = await seller.createSellerAgent(complete(w, { durableDirectory: w.dir() }));
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
  assert.deepEqual(w.admission.calls, [], 'refused before any admission');
});

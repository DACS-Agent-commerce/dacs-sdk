// The TP-1 G3 orchestrator ("W") rule at the kit's DEM context consumer and at
// the seller agent's proposal admission: the seller verifies both Vet records,
// only `finalized` receipts count and only the Listing's seller bundle is used.
// The counterparty mode keeps its rule on the same fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '@kynesyslabs/dacs';
import { proposalAdmissionFixture, proposalForInput, ORCHESTRATOR_MODE as W } from './helpers/proposal-admission-fixture.mjs';
import { seller, buyer, testWallet, JOB, NOW } from './helpers/protocol-fixture.mjs';
import { createDemDeliveryContext, demDeliveryContextVetMode, resolveDemDeliverySellerContext } from '../src/dacs/dem-delivery-context-consumer.mjs';

const AGREEMENT_SIGNATURE = 'dacs-payee-bound-agreement:v1:';
const agreementSignatures = f => f.signed.filter(bytes => bytes.startsWith(AGREEMENT_SIGNATURE)).length;
const party = wallet => ({ claim: wallet.claim, sign: wallet.signBytes });
const buyerParty = party(buyer), otherParty = party(testWallet(7));
const unreachable = () => { throw new Error('TEST not called'); };

async function proposed(t, vetMode, options = {}) {
  const f = await proposalAdmissionFixture(t, { assembled: true, vetMode }), agent = await f.open();
  return { f, agent, request: await f.proposal(agent, JOB, options) };
}
// The context a mode's consumer resolves for this request, with the answer's `input` replaced by `change`.
async function consume(mode, { f, request }, change = () => {}) {
  const value = structuredClone(f.contexts.get(JOB));
  change(value.input);
  const capability = createDemDeliveryContext({ authority: 'TEST-consumer', vetMode: mode, resolveBuyer: unreachable, resolveSeller: async () => ({ disposition: 'present', value }) });
  return resolveDemDeliverySellerContext(capability, { jobId: JOB, listing: f.listing, buyerBundle: request.buyerIdentityBundle, generatedAt: NOW });
}
const resign = (bundle, signer = seller) => {
  const next = structuredClone(bundle);
  next.presentation.signatures[0].signature = signer.signBytes(Buffer.from('dacs-bundle-presentation:v1:' + core.identityBundleHash(next))).toString('base64url');
  return next;
};

test('the W DEM context consumer accepts only the exact Listing seller bundle (K4-B3 to K4-B10)', async t => {
  const w = await proposed(t, W), c = await proposed(t, undefined), L = w.f.listing.seller.identity;
  const { presentation: _presentation, ...withoutPresentation } = L;
  const cases = [
    ['K4-B3 the exact Listing bundle', L, true, true],
    ['K4-B4 a fresh presentation of the Listing bundle', resign({ ...L, presentedAt: L.presentedAt + 5, sessionNonce: 'a'.repeat(64) }), false, true],
    ['K4-B5 without its presentation', withoutPresentation, false, false],
    ['K4-B6 members reordered', Object.fromEntries(Object.entries(L).reverse()), true, true],
    ['K4-B7 presentedAt changed, stale signature', { ...L, presentedAt: L.presentedAt + 1 }, false, false],
    ['K4-B7f presentedAt changed, freshly signed', resign({ ...L, presentedAt: L.presentedAt + 1 }), false, true],
    ['K4-B8 an extra claim, freshly signed', resign({ ...L, claims: [...L.claims, { ref: 'did:demos:TEST-extra' }] }), false, false],
    ['K4-B9 presentation signed by another party', resign(L, testWallet(7)), false, false],
    ['K4-B10 new sessionNonce, freshly signed', resign({ ...L, sessionNonce: 'b'.repeat(64) }), false, true],
  ];
  for (const [name, bundle, accepted, counterpartyAccepted] of cases) {
    const change = input => { input.seller.identityBundle = structuredClone(bundle); };
    assert.equal((await consume(W, w, change)).disposition === 'present', accepted, `W: ${name}`);
    assert.equal((await consume(undefined, c, change)).disposition === 'present', counterpartyAccepted, `counterparty: ${name}`);
  }
});

test('the W DEM context consumer accepts seller-signed seller references and refuses buyer-signed ones; the counterparty consumer does the reverse', async t => {
  const w = await proposed(t, W), c = await proposed(t, undefined);
  assert.equal((await consume(W, w)).disposition, 'present');
  assert.equal((await consume(undefined, c)).disposition, 'present');
  const refusedW = await consume(undefined, w), refusedC = await consume(W, c);
  assert.equal(refusedW.disposition, 'rejected');
  assert.match(refusedW.reason, /seller Vet ref is not signed by its counterparty verifier/);
  assert.equal(refusedC.disposition, 'rejected');
  assert.match(refusedC.reason, /seller Vet ref is not signed by the seller as orchestrator verifier/);
  for (const mode of [W, undefined]) {
    const answer = await consume(mode, mode === W ? w : c, input => { input.buyer.vetRecordRef.signer = buyer.claim; });
    assert.equal(answer.disposition, 'rejected', 'a buyer-signed buyer reference is refused in both modes');
  }
});

test('createDemDeliveryContext refuses an unsupported vetMode and keeps its constructed mode whatever an answer carries', async t => {
  for (const vetMode of ['tp1-g3', null, '', 7, {}]) {
    assert.throws(() => createDemDeliveryContext({ authority: 'TEST-mode', vetMode, resolveBuyer: unreachable, resolveSeller: unreachable }), TypeError);
  }
  const w = await proposed(t, W);
  const capability = createDemDeliveryContext({ authority: 'TEST-mode', vetMode: W, resolveBuyer: unreachable,
    resolveSeller: async () => ({ disposition: 'present', value: { ...structuredClone(w.f.contexts.get(JOB)), vetMode: 'counterparty' } }) });
  assert.equal(demDeliveryContextVetMode(capability), W);
  assert.equal(demDeliveryContextVetMode(createDemDeliveryContext({ authority: 'TEST-mode', resolveBuyer: unreachable, resolveSeller: unreachable })), 'counterparty');
  const answer = await resolveDemDeliverySellerContext(capability, { jobId: JOB, listing: w.f.listing, buyerBundle: w.request.buyerIdentityBundle, generatedAt: NOW });
  assert.equal(answer.disposition, 'present');
  assert.equal(answer.vetMode, W);
});

test('the W agent verifies the seller record with the seller as verifier before it signs the Agreement', async t => {
  const { f, agent, request } = await proposed(t, W), original = f.admission.sessionAdmission.verifyVetAnchorReceipt, signedAtVerification = [];
  f.admission.sessionAdmission.verifyVetAnchorReceipt = async query => { signedAtVerification.push(agreementSignatures(f)); return original(query); };
  const answer = await agent.receiveProposal(request);
  assert.equal(answer.disposition, 'complete');
  assert.deepEqual(signedAtVerification, [0, 0], 'both records and receipts are verified before the signature');
  assert.equal(agreementSignatures(f), 1);
  const calls = f.admission.calls.filter(([name]) => name === 'resolveVetRecord');
  assert.equal(calls.length, 2);
});

test('the W agent refuses a buyer-signed seller record, a seller-role record in the buyer\'s place and a buyer-signed buyer record, with zero Agreement signatures', async t => {
  const buyerSigned = async (name, options) => {
    const { f, agent, request } = await proposed(t, W, options);
    assert.equal((await agent.receiveProposal(request)).disposition, 'rejected', name);
    assert.equal(agreementSignatures(f), 0, name);
  };
  await buyerSigned('a buyer-signed seller record', { sellerRecord: { verifier: buyerParty } });
  await buyerSigned('a buyer-signed buyer record', { buyerRecord: { verifier: buyerParty } });
  const { f, agent } = await proposed(t, W), { input } = f.contexts.get(JOB);
  input.buyer.vetRecordRef = structuredClone(input.seller.vetRecordRef);
  assert.equal((await agent.receiveProposal(await proposalForInput(input))).disposition, 'rejected', 'a seller-role record in the buyer\'s place');
  assert.equal(agreementSignatures(f), 0);
});

// Receipt faults: [name, receipt members, expected disposition]; the reader answers null or throws for the absent ones.
const RECEIPT_FAULTS = [['accepted', { state: 'accepted' }, 'rejected'], ['included', { state: 'included' }, 'rejected'], ['unknown', { state: 'unknown' }, 'rejected'],
  ['dropped', { state: 'dropped' }, 'rejected'], ['replaced', { state: 'replaced' }, 'rejected'], ['reorged', { state: 'reorged' }, 'rejected']];
const readerFaults = { absent: async () => null, throws: async () => { throw new Error('TEST receipt outage'); } };

test('every W continuation re-reads both records and requires verified finalized, established receipts', async t => {
  for (const role of ['buyer', 'seller']) {
    for (const [name, receipt, expected] of RECEIPT_FAULTS) {
      const { f, agent, request } = await proposed(t, W, { [role + 'Record']: { receipt } });
      assert.equal((await agent.receiveProposal(request)).disposition, expected, `${role} ${name}`);
      assert.equal(agreementSignatures(f), 0, `${role} ${name} signs nothing`);
    }
    for (const [name, reader] of Object.entries(readerFaults)) {
      const { f, agent, request } = await proposed(t, W), original = f.admission.sessionAdmission.readVetAnchorReceipt;
      f.admission.sessionAdmission.readVetAnchorReceipt = async (query, options) => query.role === role ? reader() : original(query, options);
      assert.equal((await agent.receiveProposal(request)).disposition, 'indeterminate', `${role} ${name}`);
      assert.equal(agreementSignatures(f), 0);
      f.admission.sessionAdmission.readVetAnchorReceipt = original;
      assert.equal((await agent.receiveProposal(request)).disposition, 'complete', `${role} ${name} retry`);
      assert.equal(agreementSignatures(f), 1, 'the retry signs once');
    }
    const finalized = await proposed(t, W, { [role + 'Record']: { receipt: { state: 'finalized' } } });
    assert.equal((await finalized.agent.receiveProposal(finalized.request)).disposition, 'complete', `${role} finalized control`);
  }
  const included = await proposed(t, undefined, { sellerRecord: { receipt: { state: 'included' } } });
  assert.equal((await included.agent.receiveProposal(included.request)).disposition, 'complete', 'the counterparty agent still accepts included');
  const dropped = await proposed(t, undefined, { sellerRecord: { receipt: { state: 'dropped' } } });
  assert.equal((await dropped.agent.receiveProposal(dropped.request)).disposition, 'rejected');
});

test('W session admission refuses another job, party, bundle, requirement hash, address or signer, and a non-pass or unrecomputable decision, with zero signatures', async t => {
  const refusals = [['job', { recordJobId: '01J8N4YV7YVYQ4DB7M8T4C7W0B' }], ['bundle', { bundleHash: 'f'.repeat(64) }], ['requirement hash', { requirementHash: 'f'.repeat(64) }],
    ['signer', { signer: otherParty }], ['decision', { decision: 'fail' }]];
  for (const role of ['buyer', 'seller']) for (const [name, record] of refusals) {
    const { f, agent, request } = await proposed(t, W, { [role + 'Record']: record });
    assert.equal((await agent.receiveProposal(request)).disposition, 'rejected', `${role} ${name}`);
    assert.equal(agreementSignatures(f), 0, `${role} ${name}`);
  }
  for (const [name, change] of [['address', input => { input.seller.vetRecordRef.anchor.locator = core.compositeVerificationAddress(JOB, buyer.claim); }],
    ['party', input => { [input.buyer.vetRecordRef, input.seller.vetRecordRef] = [input.seller.vetRecordRef, input.buyer.vetRecordRef]; }]]) {
    const { f, agent } = await proposed(t, W), context = f.contexts.get(JOB);
    change(context.input);
    assert.equal((await agent.receiveProposal(await proposalForInput(context.input))).disposition, 'rejected', name);
    assert.equal(agreementSignatures(f), 0, name);
  }
  const { f, agent, request } = await proposed(t, W), complete = await agent.receiveProposal(request);
  assert.equal(complete.disposition, 'complete');
  const changed = structuredClone(f.contexts.get(JOB).input);
  changed.buyer.vetRecordRef.contentHash = 'f'.repeat(64);
  const before = core.canonicalize(agent.durableSessionOf(JOB));
  f.advance(1000);
  assert.equal((await agent.receiveProposal(await proposalForInput(changed))).disposition, 'rejected');
  assert.equal(core.canonicalize(agent.durableSessionOf(JOB)), before, 'a refused proposal B leaves the retained session byte-equal');
  agent.close();
  const replay = await (await f.open()).receiveProposal(request);
  assert.equal(replay.disposition, 'complete');
  assert.deepEqual(replay.contribution, complete.contribution);
});

test('the W agent refuses a fresh seller session presentation and accepts only the Listing bundle', async t => {
  const fresh = bundle => resign({ ...bundle, presentedAt: bundle.presentedAt + 5, sessionNonce: 'c'.repeat(64) });
  const probe = await proposalAdmissionFixture(t, { assembled: true, vetMode: W });
  const presentation = fresh(probe.listing.seller.identity);
  const w = await proposed(t, W, { sellerBundle: presentation });
  const refused = await w.agent.receiveProposal(w.request);
  assert.equal(refused.disposition, 'rejected');
  assert.match(refused.reason, /seller identity differs/);
  assert.equal(agreementSignatures(w.f), 0);
  const exact = await proposed(t, W);
  assert.equal((await exact.agent.receiveProposal(exact.request)).disposition, 'complete');
  const c = await proposed(t, undefined, { sellerBundle: presentation });
  assert.equal((await c.agent.receiveProposal(c.request)).disposition, 'complete', 'the counterparty agent still takes its own presentation');
});

test('a retained context stamped counterparty, or unstamped, is refused vet_mode_mismatch by the W agent with zero signatures and the session kept, and the W stamp survives an agent restart', async t => {
  const c = await proposed(t, undefined), signed = await c.agent.receiveProposal(c.request);
  assert.equal(signed.disposition, 'complete');
  assert.equal(c.agent.durableSessionOf(JOB).demDeliveryContext.vetMode, 'counterparty');
  c.agent.close();
  const before = agreementSignatures(c.f), w = await c.f.reopenAs(W), retained = core.canonicalize(w.durableSessionOf(JOB));
  const refused = await w.receiveProposal(c.request);
  assert.equal(refused.disposition, 'rejected');
  assert.match(refused.reason, /vet_mode_mismatch/);
  assert.equal(agreementSignatures(c.f), before, 'no new signature');
  assert.equal(core.canonicalize(w.durableSessionOf(JOB)), retained, 'the session is kept unchanged');
  w.close();
  assert.equal((await (await c.f.reopenAs(undefined)).receiveProposal(c.request)).disposition, 'complete', 'the counterparty agent still replays it');
  const stamped = await proposed(t, W);
  assert.equal((await stamped.agent.receiveProposal(stamped.request)).disposition, 'complete');
  stamped.agent.close();
  assert.equal((await stamped.f.open()).durableSessionOf(JOB).demDeliveryContext.vetMode, W, 'the W stamp survives a restart');
});

test('createSellerAgent refuses a vetMode that differs from its DEM context capability\'s, and an unsupported one', async t => {
  const f = await proposalAdmissionFixture(t, { assembled: true, vetMode: W });
  await assert.rejects(f.open({ vetMode: undefined }), { name: 'TypeError', code: 'vet_mode_mismatch' });
  await assert.rejects(f.open({ demDeliveryContext: f.capability(undefined) }), { name: 'TypeError', code: 'vet_mode_mismatch' });
  await assert.rejects(f.open({ vetMode: 'tp1-g3' }), TypeError);
  await assert.rejects(f.open({ vetMode: null }), TypeError);
  await f.open();
  const c = await proposalAdmissionFixture(t, { assembled: true });
  await assert.rejects(c.open({ vetMode: W }), { name: 'TypeError', code: 'vet_mode_mismatch' });
});

test('after an agent restart the retained W context is re-read and re-verified before the proposal is signed, including the receipt-fault matrix and finalized control', async t => {
  const faults = [...RECEIPT_FAULTS.map(([name, receipt]) => [name, async (query, options, original) => ({ ...await original(query, options), ...receipt })]),
    ...Object.entries(readerFaults).map(([name, reader]) => [name, async () => reader()])];
  for (const role of ['buyer', 'seller']) for (const [name, fault] of faults) {
    const { f, agent, request } = await proposed(t, W), reader = f.admission.sessionAdmission.readVetAnchorReceipt;
    assert.equal((await agent.receiveProposal(request)).disposition, 'complete');
    agent.close();
    f.admission.sessionAdmission.readVetAnchorReceipt = (query, options) => query.role === role ? fault(query, options, reader) : reader(query, options);
    await assert.rejects(f.open(), { code: 'seller_state_unverified' }, `${role} ${name}`);
    assert.equal(agreementSignatures(f), 1, 'no new signature after the restart fault');
    f.admission.sessionAdmission.readVetAnchorReceipt = reader;
    const resumed = await f.open();
    assert.equal((await resumed.receiveProposal(request)).disposition, 'complete', `${role} ${name} finalized control`);
    assert.equal(agreementSignatures(f), 1);
    const resolved = f.admission.calls.filter(([call]) => call === 'resolveVetRecord').length;
    assert.ok(resolved >= 4, 'both records were read again after the restart');
  }
});

test('a stalled W Vet record or receipt reader aborts at its deadline and the agent signs nothing', async t => {
  for (const method of ['resolveVetRecord', 'readVetAnchorReceipt']) {
    const { f, agent, request } = await proposed(t, W);
    let enter, limits;
    const started = new Promise(resolve => { enter = resolve; }), original = f.admission.sessionAdmission[method];
    f.admission.sessionAdmission[method] = (query, options) => { if (limits) return original(query, options); limits = options; enter(); return new Promise(() => {}); };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = agent.receiveProposal(request);
    await started;
    t.mock.timers.tick(10001);
    const answer = await pending.finally(() => t.mock.timers.reset());
    assert.equal(answer.disposition, 'indeterminate', method);
    assert.equal(answer.cause?.name, 'TimeoutError');
    assert.equal(limits.signal.aborted, true);
    assert.equal(agreementSignatures(f), 0);
  }
});

test('oversized W Vet data is held before cloning and authentication', async t => {
  const { f, agent, request } = await proposed(t, W);
  f.admission.sessionAdmission.resolveVetRecord = async () => ({ extra: 'x'.repeat(65537) });
  const answer = await agent.receiveProposal(request);
  assert.equal(answer.disposition, 'indeterminate');
  assert.ok(answer.cause instanceof RangeError);
  assert.equal(agreementSignatures(f), 0);
});

test('the W agent\'s delivery runner accepts the invocations the agent checked before signing, through delivery-ready', async t => {
  const { f } = await proposed(t, W), { input, vetRequirements } = f.contexts.get(JOB);
  const delivery = vetMode => core.sellerFulfilmentVetRequirementsViolation(vetRequirements, { jobId: JOB, buyerRequirement: f.listing.buyerRequirement,
    buyer: { primaryClaim: buyer.claim, vetRecordRef: input.buyer.vetRecordRef }, seller: { primaryClaim: seller.claim, vetRecordRef: input.seller.vetRecordRef }, vetMode });
  assert.equal(delivery(W), null);
});

test('a counterparty agent\'s delivery refuses seller-verified seller provenance', async t => {
  const { f } = await proposed(t, W), { input, vetRequirements } = f.contexts.get(JOB);
  const violation = core.sellerFulfilmentVetRequirementsViolation(vetRequirements, { jobId: JOB, buyerRequirement: f.listing.buyerRequirement,
    buyer: { primaryClaim: buyer.claim, vetRecordRef: input.buyer.vetRecordRef }, seller: { primaryClaim: seller.claim, vetRecordRef: input.seller.vetRecordRef } });
  assert.equal(typeof violation, 'string');
});

test('the counterparty agent takes its own session presentation to admission and refuses one it did not sign', async t => {
  const probe = await proposalAdmissionFixture(t, { assembled: true }), L = probe.listing.seller.identity;
  const own = await proposed(t, undefined, { sellerBundle: resign({ ...L, presentedAt: L.presentedAt + 5 }) });
  assert.equal((await own.agent.receiveProposal(own.request)).disposition, 'complete');
  const foreign = await proposed(t, undefined, { sellerBundle: resign({ ...L, presentedAt: L.presentedAt + 5 }, testWallet(7)) });
  assert.equal((await foreign.agent.receiveProposal(foreign.request)).disposition, 'rejected');
  assert.equal(agreementSignatures(foreign.f), 0);
});

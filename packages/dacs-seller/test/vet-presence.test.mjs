// DACS-2 v0.6 forbids a synthetic VerifyResult for a presence-only claim. The
// seller counts it by replaying the Vet record over the exact bundle, with the
// bundle's presentation verifier and the registry snapshot the operator pinned
// for the job (PCR-6, CRQ-1). These vectors use real signed records and need no
// durable state.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '@kynesyslabs/dacs';
import { sellerApi as seller } from './helpers/seller-internal-api.mjs';
import { createSessionAdmissionFixture, FIXTURE_REGISTRY_PIN } from './helpers/session-admission-fixture.mjs';
import { hasPresenceOnlyClaim, identityPresentationValid, readRegistryPin, sessionAdmissionConfig, vetRecordProblem } from '../src/dacs/session-admission.mjs';

const NOW = 1780000000000;
function wallet(tag) {
  const privateKey = core.privateKeyFromSeed(new Uint8Array(32).fill(tag)), raw = Buffer.from(core.rawPublicKey(core.publicKeyFromSeed(new Uint8Array(32).fill(tag))));
  return { address: `0x${raw.toString('hex')}`, claim: `did:demos:agent:${raw.toString('hex')}`, sign: (bytes) => Buffer.from(core.ed25519Sign(bytes, privateKey)),
    signWallet: (message) => `0x${Buffer.from(core.ed25519Sign(Buffer.from(message), privateKey)).toString('hex')}` };
}
const presentationOf = (party) => {
  const unsigned = seller.buildUnsignedIdentityBundle({ address: party.address, presentedAt: NOW, sessionSeed: 'vet-presence' });
  return seller.attachIdentityPresentation(unsigned, party.signWallet(unsigned.message));
};
const presence = (scheme, extra = {}) => ({ requirementVersion: '1', required: [{ scheme, verificationRequired: false }], preferredPresentation: 'any', ...extra });

async function fixture(requirement, {expiresAt} = {}) {
  const sellerKey = wallet(41), buyerKey = wallet(42), buyerBundle = presentationOf(buyerKey), jobId = core.generateCanonicalJobId();
  if (expiresAt !== undefined) {
    buyerBundle.claims[0].expiresAt = expiresAt;
    buyerBundle.presentation.signatures[0].signature = buyerKey.sign(Buffer.from('dacs-bundle-presentation:v1:' + core.identityBundleHash(buyerBundle))).toString('base64url');
  }
  const admission = createSessionAdmissionFixture({ seller: sellerKey, buyer: buyerKey, now: () => NOW });
  const ref = await admission.vetRecord(jobId, buyerKey.claim, buyerBundle, { requirement });
  const record = await admission.sessionAdmission.resolveVetRecord({ ref });
  const invocation = { vetRecordRef: ref, evaluatedParty: buyerKey.claim, requirement, verifier: sellerKey.claim, freshness: [], dealSpecific: [] };
  const problem = (change = {}) => {
    const { bundle, registryPin, sessionRegistryPins } = { bundle: buyerBundle, registryPin: FIXTURE_REGISTRY_PIN, ...change };
    return vetRecordProblem(record, { ref, jobId, party: buyerKey.claim, bundleHash: core.identityBundleHash(bundle), verifier: sellerKey.claim, invocation, now: () => NOW, presence: { bundle, registryPin }, sessionRegistryPins });
  };
  return { admission, buyerBundle, problem, record };
}

test('a record over a presence-only claim the bundle carries passes with the exact bundle, its presentation and the pinned registry', async () => {
  assert.equal(await (await fixture(presence('did'))).problem(), null);
});

test('a oneOf group with a presence-only alternative the bundle carries passes', async () => {
  const requirement = { requirementVersion: '1', required: [], oneOf: [[{ scheme: 'domain', verificationRequired: false }, { scheme: 'did', verificationRequired: false }]], preferredPresentation: 'any' };
  assert.equal(await (await fixture(requirement)).problem(), null);
});

test('a record that says pass for a presence-only claim the bundle does not carry is refused', async () => {
  assert.match(await (await fixture(presence('domain'))).problem(), /\(invalid: aggregation-mismatch\)$/);
});

test('a presence-only record is refused without a valid pinned registry authority', async () => {
  const { problem } = await fixture(presence('did'));
  for (const registryPin of [undefined, null, '', 'not-a-hash', FIXTURE_REGISTRY_PIN.toUpperCase(), { hash: FIXTURE_REGISTRY_PIN }]) {
    assert.equal(await problem({ registryPin }), 'the Vet requirement names a presence-only claim and no pinned registry authority was supplied', String(registryPin));
  }
});

test('a presence-only record is refused for a bundle whose presentation does not verify', async () => {
  const { problem, buyerBundle } = await fixture(presence('did'));
  const forged = structuredClone(buyerBundle);
  forged.presentation.signatures[0].signature = Buffer.alloc(64).toString('base64url');
  assert.equal(core.identityBundleHash(forged), core.identityBundleHash(buyerBundle), 'the presentation is outside the bundle hash');
  assert.match(await problem({ bundle: forged }), /\(invalid: identity-presentation\)$/);
});

test('a presence-only record is refused for a bundle that carries no presentation', async () => {
  const { problem, buyerBundle } = await fixture(presence('did'));
  const unsigned = structuredClone(buyerBundle);
  delete unsigned.presentation;
  assert.match(await problem({ bundle: unsigned }), /\(invalid: expectation-shape\)$/);
});

test('a presence-only record is refused for another bundle of the same party', async () => {
  const { problem, buyerBundle } = await fixture(presence('did'));
  const other = structuredClone(buyerBundle);
  other.presentedAt += 1;
  assert.match(await problem({ bundle: other }), /evaluates another job, party or bundle/);
});

test('a record over a verified claim is still replayed with no presence authority and no registry pin', async () => {
  const { problem } = await fixture({ requirementVersion: '1', required: [], preferredPresentation: 'any' });
  assert.equal(await problem({ registryPin: undefined }), null);
});

test('hasPresenceOnlyClaim finds a presence-only claim in required and oneOf and ignores malformed requirements', () => {
  const verified = { scheme: 'did', verificationRequired: true }, unverified = { scheme: 'did', verificationRequired: false };
  assert.equal(hasPresenceOnlyClaim({ required: [verified] }), false);
  assert.equal(hasPresenceOnlyClaim({ required: [verified, unverified] }), true);
  assert.equal(hasPresenceOnlyClaim({ required: [], oneOf: [[verified, unverified]] }), true);
  for (const malformed of [undefined, null, {}, { required: 'did' }, { required: [null] }]) assert.equal(hasPresenceOnlyClaim(malformed), false);
});

test('identityPresentationValid accepts only the presenter\'s signature over the bundle hash', async () => {
  const { buyerBundle } = await fixture(presence('did'));
  assert.equal(identityPresentationValid(buyerBundle, core.identityBundleHash(buyerBundle)), true);
  assert.equal(identityPresentationValid(buyerBundle, core.sha256Hex('another bundle')), false);
  for (const bundle of [undefined, null, {}, { ...buyerBundle, presentation: { kind: 'siwd' } }]) assert.equal(identityPresentationValid(bundle, core.identityBundleHash(buyerBundle)), false);
});

test('the registry pin is read with the job, bounded, and is null when the operator configured no reader', async () => {
  const { admission } = await fixture(presence('did'));
  assert.equal(await readRegistryPin(admission.sessionAdmission, 'job-1'), FIXTURE_REGISTRY_PIN);
  assert.deepEqual(admission.calls.filter(([call]) => call === 'readSessionRecipeRegistryPin'), [['readSessionRecipeRegistryPin', 'job-1']]);
  const { readSessionRecipeRegistryPin: _pin, ...withoutPin } = admission.sessionAdmission;
  assert.equal(await readRegistryPin(withoutPin, 'job-1'), null);
  const failing = { ...admission.sessionAdmission, readSessionRecipeRegistryPin: async () => { throw new Error('TEST registry is down'); } };
  await assert.rejects(readRegistryPin(failing, 'job-1'), /TEST registry is down/);
  const oversized = { ...admission.sessionAdmission, readSessionRecipeRegistryPin: async () => 'a'.repeat(128 * 1024) };
  await assert.rejects(readRegistryPin(oversized, 'job-1'), RangeError);
});

test('the registry pin read honors its deadline and cancels a reader that never settles', { timeout: 30_000 }, async (t) => {
  const { admission } = await fixture(presence('did'));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const stalled = { ...admission.sessionAdmission, readSessionRecipeRegistryPin: (_query, options) => { signal = options.signal; return new Promise(() => {}); } };
  const read = readRegistryPin(stalled, 'job-1');
  const outcome = assert.rejects(read, { name: 'TimeoutError' });
  await Promise.resolve();
  t.mock.timers.tick(10_000);
  await outcome;
  assert.equal(signal.aborted, true);
});

test('session admission takes an optional registry pin reader and refuses one that is not a function', async () => {
  const { admission } = await fixture(presence('did'));
  assert.equal(sessionAdmissionConfig(admission.sessionAdmission), admission.sessionAdmission);
  const { readSessionRecipeRegistryPin: _pin, ...withoutPin } = admission.sessionAdmission;
  assert.equal(sessionAdmissionConfig(withoutPin), withoutPin);
  assert.throws(() => sessionAdmissionConfig({ ...withoutPin, readSessionRecipeRegistryPin: 'pin' }), /readSessionRecipeRegistryPin/);
});

test('presence-only replay keeps one registry snapshot across the job records', async () => {
  const { problem } = await fixture(presence('did')), pins = [];
  assert.equal(await problem({ sessionRegistryPins: pins }), null);
  assert.match(await problem({ sessionRegistryPins: pins, registryPin: 'f'.repeat(64) }), /another session registry snapshot/);
});

test('a negotiated presence-only session replays after restart without another Agreement signature', async t => {
  const { proposalAdmissionFixture } = await import('./helpers/proposal-admission-fixture.mjs');
  const f = await proposalAdmissionFixture(t, { assembled: true, buyerRequirement: presence('did') });
  const agent = await f.open(), request = await f.proposal(agent);
  const first = await agent.receiveProposal(request);
  assert.equal(first.disposition, 'complete');
  const agreementSigns = () => f.signed.filter(bytes => bytes.startsWith('dacs-payee-bound-agreement:v1:')).length;
  assert.equal(agreementSigns(), 1);
  agent.close();
  const reopened = await f.open(), repeat = await reopened.receiveProposal(request);
  assert.equal(repeat.disposition, 'complete');
  assert.deepEqual(repeat.contribution, first.contribution);
  assert.equal(agreementSigns(), 1);
});

for (const placement of ['required', 'oneOf']) {
 const requirement = placement === 'required' ? presence('did') : presence('did', {required: [], oneOf: [[{scheme: 'did', verificationRequired: false}]]});
 test(`strict seller Vet refuses future-expiring ${placement} presence before it can be retained`, async () => {
  const f = await fixture(requirement, {expiresAt: NOW + 60000});
  assert.match(await f.problem(), /expiring claims/);
 });
 test(`refused expiring ${placement} presence leaves no signature and allows restart and another job`, async t => {
  const {proposalAdmissionFixture} = await import('./helpers/proposal-admission-fixture.mjs');
  const f = await proposalAdmissionFixture(t, {assembled: true, buyerRequirement: requirement});
  const agent = await f.open(), request = await f.proposal(agent, undefined, {expiresAt: NOW + 60000});
  const answer = await agent.receiveProposal(request);
  assert.equal(answer.disposition, 'rejected');
  assert.match(answer.reason, /expiring claims/);
  assert.equal(f.signed.filter(bytes => bytes.startsWith('dacs-payee-bound-agreement:v1:')).length, 0);
  agent.close(); f.advance(60001);
  const reopened = await f.open();
  const control = await f.proposal(reopened, '01ARZ3NDEKTSV4RRFFQ69G5FAY');
  assert.equal((await reopened.receiveProposal(control)).disposition, 'complete');
 });
}

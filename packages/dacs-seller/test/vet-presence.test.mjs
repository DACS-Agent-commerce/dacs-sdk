// DACS-2 v0.6 forbids a synthetic VerifyResult for a presence-only claim. The
// seller counts it by replaying the Vet record over the exact bundle, with the
// bundle's presentation verifier and an authenticated job registry snapshot
// (PCR-6, CRQ-1). These vectors use real signed records and need no
// durable state.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '@kynesyslabs/dacs';
import { sellerApi as seller } from './helpers/seller-internal-api.mjs';
import { createSessionAdmissionFixture } from './helpers/session-admission-fixture.mjs';
import { hasPresenceOnlyClaim, identityPresentationValid, sessionAdmissionConfig, vetRecordProblem } from '../src/dacs/session-admission.mjs';
import { sessionRegistrySnapshot } from './helpers/session-registry-fixture.mjs';

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
  const sessionSnapshot = await sessionRegistrySnapshot(jobId);
  const problem = (change = {}) => {
    const { bundle, sessionRegistryPins, ...authority } = { bundle: buyerBundle, sessionSnapshot, ...change };
    return vetRecordProblem(record, { ref, jobId, party: buyerKey.claim, bundleHash: core.identityBundleHash(bundle), verifier: sellerKey.claim, invocation, now: () => NOW, presence: { bundle, ...authority }, sessionRegistryPins });
  };
  return { admission, buyerBundle, problem, record, jobId, sessionSnapshot };
}

test('a record over a presence-only claim the bundle carries passes with the exact bundle, its presentation and an authenticated job registry snapshot', async () => {
  assert.equal(await (await fixture(presence('did'))).problem(), null);
});

test('a oneOf group with a presence-only alternative the bundle carries passes', async () => {
  const requirement = { requirementVersion: '1', required: [], oneOf: [[{ scheme: 'domain', verificationRequired: false }, { scheme: 'did', verificationRequired: false }]], preferredPresentation: 'any' };
  assert.equal(await (await fixture(requirement)).problem(), null);
});

test('a record that says pass for a presence-only claim the bundle does not carry is refused', async () => {
  assert.match(await (await fixture(presence('domain'))).problem(), /\(invalid: aggregation-mismatch\)$/);
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

test('a record over no required claim is replayed with no presence authority and no registry pin', async () => {
  const { problem } = await fixture({ requirementVersion: '1', required: [], preferredPresentation: 'any' });
  assert.equal(await problem({ sessionSnapshot: undefined }), null);
});

test('a presence-only requirement with a primaryClaimSelector is refused, not counted as a presence success', async () => {
  // The SDK's exact selector replay needs a passing verified result for the
  // selected claim; a presence-only claim has none, so the documented refusal
  // is an aggregation mismatch rather than a presence pass.
  const { problem } = await fixture({ ...presence('did'), primaryClaimSelector: 'did' });
  assert.match(await problem(), /\(invalid: aggregation-mismatch\)$/);
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

const missingSnapshot = 'the Vet requirement names a presence-only claim and no runtime-authenticated job registry snapshot was supplied';

for (const placement of ['required', 'oneOf']) {
  const requirement = placement === 'required' ? presence('did') : presence('did', { required: [], oneOf: [[{ scheme: 'did', verificationRequired: false }]] });
  for (const registryPin of ['0'.repeat(64), 'f'.repeat(64), undefined]) test(`${placement} presence refuses a bare pin ${registryPin?.[0] ?? 'absent'}`, async () => {
    const f = await fixture(requirement);
    assert.equal(await f.problem({ sessionSnapshot: undefined, registryPin }), missingSnapshot);
  });
  for (const kind of ['wrong-job', 'clone', 'spread', 'lookalike']) test(`${placement} presence refuses a ${kind} snapshot`, async () => {
    const f = await fixture(requirement);
    const snapshot = kind === 'wrong-job' ? await sessionRegistrySnapshot(core.generateCanonicalJobId())
      : kind === 'clone' ? structuredClone(f.sessionSnapshot) : kind === 'spread' ? { ...f.sessionSnapshot }
      : { jobId: f.jobId, snapshotHash: f.sessionSnapshot.snapshotHash };
    assert.equal(await f.problem({ sessionSnapshot: snapshot }), missingSnapshot);
  });
  test(`strict seller Vet refuses future-expiring ${placement} presence with authenticated authority`, async () => {
    const f = await fixture(requirement, { expiresAt: NOW + 60000 });
    assert.match(await f.problem(), /expiring claims/);
  });
  test(`retained ${placement} presence refuses restore without authenticated job authority`, async t => {
    const { proposalAdmissionFixture } = await import('./helpers/proposal-admission-fixture.mjs');
    const f = await proposalAdmissionFixture(t, { assembled: true, buyerRequirement: requirement });
    const agent = await f.open(), request = await f.proposal(agent);
    const context = f.contexts.get(request.transportIdentity.jobId);
    const session = { jobId: context.input.jobId, buyerBundle: context.input.buyer.identityBundle, demDeliveryContext: { input: context.input } };
    assert.match(await agent.retainedVetEvidenceProblem(session), /no runtime-authenticated job registry snapshot/);
    assert.equal(f.signed.filter(bytes => bytes.startsWith('dacs-payee-bound-agreement:v1:')).length, 0);
  });
}

test('presence-only replay keeps one authenticated registry snapshot across job records', async () => {
  const f = await fixture(presence('did')), pins = [];
  assert.equal(await f.problem({ sessionRegistryPins: pins }), null);
  assert.deepEqual(pins, [f.sessionSnapshot.snapshotHash]);
  const other = await sessionRegistrySnapshot(f.jobId, 'another-snapshot');
  assert.notEqual(other.snapshotHash, f.sessionSnapshot.snapshotHash);
  assert.match(await f.problem({ sessionRegistryPins: pins, sessionSnapshot: other }), /another session registry snapshot/);
});

for (const value of [async () => '0'.repeat(64), 'pin', undefined]) test(`session admission rejects a supplied obsolete pin capability of type ${typeof value}`, async () => {
  const { admission } = await fixture(presence('did'));
  assert.equal(sessionAdmissionConfig(admission.sessionAdmission), admission.sessionAdmission);
  assert.throws(() => sessionAdmissionConfig({ ...admission.sessionAdmission, readSessionRecipeRegistryPin: value }), { name: 'TypeError', message: /readSessionRecipeRegistryPin/ });
});

for (const equivalent of [true, false]) test(`presence presentation checks canonical ${equivalent ? 'equivalent' : 'distinct'} signer identity`, async () => {
  const f = await fixture(presence('did')), bundle = structuredClone(f.buyerBundle);
  bundle.presentation.signatures[0].ref = equivalent ? `${bundle.presentedBy}?label=buyer` : wallet(41).claim;
  const problem = await f.problem({ bundle });
  if (equivalent) assert.equal(problem, null);
  else assert.match(problem, /identity-presentation/);
});

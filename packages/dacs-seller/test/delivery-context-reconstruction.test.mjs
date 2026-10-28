import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ARTIFACT_SEPARATORS, canonicalize, contentHash, identityBundleHash, deriveFixedPriceAgreement, signComponentArtifact, sha256Hex } from '@kynesyslabs/dacs';
import { createDemDeliveryContext, resolveDemDeliverySellerContext, releaseDemDeliveryContext, demDeliveryContextUsage } from '../src/dacs/dem-delivery-context-consumer.mjs';
import { createNativeDemDeliveryCapability, nativeDemDeliveryConfig, submitNativeDemDelivery, reconcileNativeDemDelivery, readNativeDemDelivery, verifyNativeDemDeliveryReceipt, provenUnsignedAbsence, isProvenUnsignedAbsence } from '../src/dacs/native-dem-delivery-consumer.mjs';
import { vetRecordProblem } from '../src/dacs/session-admission.mjs';
import { fixtureIdentityBundle } from './fixtures/listings.mjs';
import { protocolFixture, buyer, seller, testWallet, JOB, NOW } from './helpers/protocol-fixture.mjs';

const capability = resolveSeller => createDemDeliveryContext({ authority: 'TEST-reconstruction', resolveBuyer: () => null, resolveSeller });
const request = f => ({ listing: f.listing, buyerBundle: f.buyerBundle, jobId: JOB, generatedAt: NOW });
const reply = input => ({ disposition: 'present', value: { input, vetRequirements: [] } });
const resolve = (input, f) => resolveDemDeliverySellerContext(capability(() => reply(input)), request(f));

async function signedFixture() {
  const f = await protocolFixture(), input = structuredClone(f.input), requirement = { requirementVersion: '1', required: [] };
  const records = {};
  for (const [role, evaluated, verifier] of [['buyer', buyer, seller], ['seller', seller, buyer]]) {
    const record = await signComponentArtifact({ recordVersion: '1', jobId: JOB, evaluatedParty: evaluated.claim,
      bundleHash: identityBundleHash(input[role].identityBundle), requirementHash: sha256Hex(canonicalize(requirement)),
      freshness: [], supplementary: [], dealSpecific: [], overallDecision: 'pass', generatedAt: NOW },
    ARTIFACT_SEPARATORS.CompositeVerificationRecord, { algorithm: 'ed25519', signer: verifier.claim, sign: verifier.signBytes });
    input[role].vetRecordRef = { ...input[role].vetRecordRef, contentHash: contentHash(record), signer: verifier.claim };
    records[role] = { record, verifier: verifier.claim, party: evaluated.claim, invocation: { requirement, freshness: [], dealSpecific: [] } };
  }
  return { ...f, input, records };
}

for (const role of ['buyer', 'seller']) for (const qualified of [false, true]) for (const bytes of [false, true]) {
  test(`signed ${role} reference qualified=${qualified} bytes=${bytes} preserves signer and derives`, async () => {
    const f = await signedFixture(), ref = f.input[role].vetRecordRef;
    if (qualified) ref.signer += '?jurisdiction=GB';
    assert.equal(await vetRecordProblem(f.records[role].record, { ...f.records[role], ref, jobId: JOB,
      bundleHash: identityBundleHash(f.input[role].identityBundle), now: () => NOW }), null);
    const answer = reply(f.input);
    const result = await resolveDemDeliverySellerContext(capability(() => bytes ? Buffer.from(JSON.stringify(answer)) : answer), request(f));
    assert.equal(result.disposition, 'present', result.reason);
    assert.equal(result.input[role].vetRecordRef.signer, ref.signer);
    const draft = deriveFixedPriceAgreement(result.input);
    assert.equal(draft.parties.find(p => p.role === role).vetRecordRef.signer, ref.signer);
  });
}

const refMutations = {
  self: (ref, role) => { ref.signer = role === 'buyer' ? buyer.claim : seller.claim; },
  foreign: ref => { ref.signer = testWallet(19).claim; },
  missing: ref => { delete ref.signer; },
  malformed: ref => { ref.signer = 'TEST-invalid'; },
  nonstring: ref => { ref.signer = [ref.signer]; },
  address: ref => { ref.anchor.locator += '-other'; },
  kind: ref => { ref.anchor.kind = 'https'; },
  'array hash': ref => { ref.contentHash = [ref.contentHash]; },
  'number hash': ref => { ref.contentHash = 123; },
  'invalid hash': ref => { ref.contentHash = 'z'.repeat(64); },
  extra: ref => { ref.extra = null; },
};
for (const role of ['buyer', 'seller']) for (const [name, mutate] of Object.entries(refMutations)) {
  test(`${role} refuses ${name} reference`, async () => {
    const f = await signedFixture(); mutate(f.input[role].vetRecordRef, role);
    assert.equal((await resolve(f.input, f)).disposition, 'rejected');
  });
}

const substitutions = {
  job: i => { i.jobId = '01J8N4YV7YVYQ4DB7M8T4C7W0B'; },
  listing: i => { i.verifiedListing.listing.offering.title = 'TEST-other'; },
  pin: i => { i.verifiedListing.pin.contentHash = 'a'.repeat(64); },
  buyer: i => { i.buyer.identityBundle = fixtureIdentityBundle(seller, NOW); },
  seller: i => { i.seller.identityBundle = fixtureIdentityBundle(buyer, NOW); },
  'seller proof': i => { i.seller.identityBundle = fixtureIdentityBundle(seller, NOW); i.seller.identityBundle.presentation.signatures[0].signature = Buffer.alloc(64).toString('base64url'); },
  rail: i => { i.selectedRail.railId = 'TEST-other'; },
  version: i => { i.selectedRail.railVersion++; },
  payee: i => { i.payoutBindings[0].payeeAddress = buyer.address; },
  phase: i => { i.payoutBindings[0].phaseIndex++; },
  'extra payout': i => { i.payoutBindings.push({ ...i.payoutBindings[0] }); },
  time: i => { i.generatedAt++; },
  extra: i => { i.extra = null; },
  nested: i => { i.selectedRail.extra = null; },
  missing: i => { delete i.generatedAt; },
};
for (const [name, mutate] of Object.entries(substitutions)) test(`reconstruction refuses ${name} substitution`, async () => {
  const f = await signedFixture(); mutate(f.input);
  assert.equal((await resolve(f.input, f)).disposition, 'rejected');
});

test('valid fresh signed seller presentation is admitted', async () => {
  const f = await signedFixture(); f.input.seller.identityBundle = fixtureIdentityBundle(seller, NOW);
  const result = await resolve(f.input, f);
  assert.equal(result.disposition, 'present', result.reason);
  assert.doesNotThrow(() => deriveFixedPriceAgreement(result.input));
});

test('local and provider requests cannot change captured authority across await', async () => {
  const f = await signedFixture(), original = structuredClone(f.input), local = request(f);
  const result = await resolveDemDeliverySellerContext(capability(async providerRequest => {
    await Promise.resolve();
    local.listing.offering.title = 'TEST-caller-mutation'; local.buyerBundle.presentedAt++;
    providerRequest.listingPin.contentHash = 'b'.repeat(64); providerRequest.buyerIdentityBundle.presentedAt++;
    return reply(original);
  }), local);
  assert.equal(result.disposition, 'present', result.reason);
  assert.deepEqual(result.input, original);
  original.buyer.vetRecordRef.signer = buyer.claim;
  assert.equal(result.input.buyer.vetRecordRef.signer, seller.claim);
});

test('present always requires SDK derivability of the captured local facts', async () => {
  const f = await signedFixture(); f.listing.listingVersion = 0;
  f.input.verifiedListing.listing = structuredClone(f.listing);
  f.input.verifiedListing.pin.version = 0;
  f.input.verifiedListing.pin.contentHash = contentHash(f.listing);
  assert.throws(() => deriveFixedPriceAgreement(f.input));
  assert.notEqual((await resolve(f.input, f)).disposition, 'present');
});

for (const [name, thrown] of [
  ['Error', new Error('TEST-provider-cause')], ['Symbol', Symbol('TEST-symbol')], ['null prototype', Object.create(null)],
  ['message getter', { get message() { throw new Error('TEST-getter'); } }],
  ['message conversion', { message: { toString: null, valueOf: null } }],
  ['conversion getter', { get toString() { throw new Error('TEST-conversion'); } }],
]) test(`provider ${name} failure remains bounded and held`, async () => {
  const f = await signedFixture();
  const result = await resolveDemDeliverySellerContext(capability(() => { throw thrown; }), request(f));
  assert.equal(result.disposition, 'indeterminate'); assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length <= 240);
  if (thrown instanceof Error) assert.match(result.reason, /TEST-provider-cause/);
});

for (const reason of [null, {}, [], 3, false]) test(`malformed held reason ${JSON.stringify(reason)} uses fallback`, async () => {
  const f = await signedFixture();
  const result = await resolveDemDeliverySellerContext(capability(() => ({ disposition: 'absent', reason })), request(f));
  assert.equal(result.disposition, 'absent'); assert.match(result.reason, /malformed/);
});

test('absence invokes no callback and malformed present never becomes a held provider claim', async () => {
  const f = await signedFixture();
  assert.match((await resolveDemDeliverySellerContext(null, request(f))).reason, /absent/);
  const result = await resolveDemDeliverySellerContext(capability(() => ({ disposition: 'present', reason: 'TEST-claimed' })), request(f));
  assert.equal(result.disposition, 'indeterminate'); assert.match(result.reason, /malformed/);
});

test('release and asynchronous usage consume rejected promises', async () => {
  const f = await signedFixture();
  const c = createDemDeliveryContext({ authority: 'TEST-lifecycle', resolveBuyer: () => null, resolveSeller: () => null,
    release: async () => { throw new Error('TEST-release'); }, usage: async () => { throw new Error('TEST-usage'); } });
  releaseDemDeliveryContext(c, request(f));
  assert.deepEqual(demDeliveryContextUsage(c), { status: 'error' });
  await new Promise(resolve => setImmediate(resolve));
});

const nativeOperations = [submitNativeDemDelivery, reconcileNativeDemDelivery, readNativeDemDelivery, verifyNativeDemDeliveryReceipt];
test('all native operations receive isolated clones and absent capability has named refusal', async () => {
  const input = { nested: { value: 1 } }, seen = [];
  const operation = async copy => { copy.nested.value++; seen.push(copy); return copy; };
  const c = createNativeDemDeliveryCapability({ authority: 'TEST-native', submit: operation, reconcile: operation, read: operation, verifyReceipt: operation });
  for (const invoke of nativeOperations) {
    await assert.rejects(invoke(null, input), /native DEM delivery capability is absent/);
    assert.equal((await invoke(c, input)).nested.value, 2);
  }
  assert.equal(input.nested.value, 1); assert.equal(new Set(seen).size, 4);
});

for (const authority of ['TEST-', 'TEST-x\n', 'TEST-' + 'x'.repeat(116), true, 'other']) test(`native rejects authority ${String(authority)}`, () => {
  const operation = () => null;
  assert.throws(() => createNativeDemDeliveryCapability({ authority, submit: operation, reconcile: operation, read: operation, verifyReceipt: operation }));
});

test('serialization and restart convey no context/native capability or absence proof', () => {
  const operation = () => null, c = capability(operation), proof = provenUnsignedAbsence('TEST-unsigned');
  const native = createNativeDemDeliveryCapability({ authority: 'TEST-native', submit: operation, reconcile: operation, read: operation, verifyReceipt: operation });
  for (const copy of [structuredClone(native), JSON.parse(JSON.stringify(native))]) assert.throws(() => nativeDemDeliveryConfig(copy));
  assert.equal(isProvenUnsignedAbsence(JSON.parse(JSON.stringify(proof))), false);
  const script = `import assert from 'node:assert/strict';
    import { demDeliveryContextConfig } from ${JSON.stringify(new URL('../src/dacs/dem-delivery-context-consumer.mjs', import.meta.url).href)};
    import { nativeDemDeliveryConfig, isProvenUnsignedAbsence } from ${JSON.stringify(new URL('../src/dacs/native-dem-delivery-consumer.mjs', import.meta.url).href)};
    const [context, native, proof] = JSON.parse(process.argv[1]);
    assert.throws(() => demDeliveryContextConfig(context)); assert.throws(() => nativeDemDeliveryConfig(native));
    assert.equal(isProvenUnsignedAbsence(proof), false);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify([c, native, proof])], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
});

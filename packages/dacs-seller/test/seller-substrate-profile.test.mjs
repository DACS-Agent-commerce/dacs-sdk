// The seller agent chooses its substrate once and fails closed: a host that
// forgets a native capability is refused at construction, never served by the
// simulated fixture substrate, and the simulated fixture profile is only ever
// an explicit opt-in. No module hooks; real Listing and signer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalize, DACS_STANDARD_PIN } from '@kynesyslabs/dacs';
import * as seller from '../src/index.mjs';
import { SELLER_REQUIREMENT } from '../src/devnet-demo/agreement-context.mjs';
import { railSteward } from './helpers/rail-authority-fixture.mjs';
import { SELLER_PROFILE } from '../src/dacs/session-admission.mjs';

function sellerWorld() {
  const pair = generateKeyPairSync('ed25519'), raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  const party = { address: `0x${raw}`, claim: `did:demos:agent:${raw}` };
  const wallet = (message) => `0x${sign(null, Buffer.from(message, 'utf8'), pair.privateKey).toString('hex')}`;
  const now = Date.now(), unsigned = seller.buildUnsignedIdentityBundle({ address: party.address, presentedAt: now - 1000, sessionSeed: 'profile' });
  const draft = seller.buildListingDraft({ identityBundle: seller.attachIdentityPresentation(unsigned, wallet(unsigned.message)), displayName: 'Profile seller',
    publicEndpoint: 'https://seller.invalid/agent', listingId: 'profile-report', listingVersion: 1, title: 'Profile report', description: 'Substrate profile vectors.',
    expectedSizeBytes: 1024, category: 'services.market-report', tags: ['profile'], priceDem: '1', notBefore: now - 60000 });
  const listing = seller.attachListingSignature(draft, wallet(seller.listingSigningMessage(draft)));
  const unreachable = async () => { throw new Error('not reached at construction'); };
  return {
    base: { signer: { claim: party.claim, sign: (bytes) => sign(null, Buffer.from(bytes), pair.privateKey) }, listing, deliverySchemaVerifier: { schemaUrl: listing.offering.deliverable.schemaUrl, verify: unreachable }, observeDemosTransfer: unreachable },
    agreementAnchor: { source: 'profile/agreement-readback', readAgreement: unreachable },
    artifacts: { nativeArtifactAnchor: { writer: party.claim, publish: unreachable, readRetained: unreachable, verifyReceipt: unreachable }, deliverableProducer: () => null },
    anchors: { read: unreachable, write: unreachable },
    railAuthority: railSteward().railAuthority(),
  };
}

test('without any substrate the agent is refused', async () => {
  const w = sellerWorld();
  await assert.rejects(seller.createSellerAgent(w.base), { name: 'TypeError', message: /needs agreementAnchor and nativeArtifactAnchor, or an explicit fixture substrate/ });
  await assert.rejects(seller.createSellerAgent({ ...w.base, anchors: { read: w.anchors.read } }), { name: 'TypeError', message: /explicit fixture substrate/ });
});

test('a partial native profile is refused instead of reading the fixture substrate', async () => {
  const w = sellerWorld();
  for (const options of [{ agreementAnchor: w.agreementAnchor }, w.artifacts, { agreementAnchor: w.agreementAnchor, anchors: w.anchors }, { ...w.artifacts, anchors: w.anchors }]) {
    await assert.rejects(seller.createSellerAgent({ ...w.base, ...options }), { name: 'TypeError', message: /native seller profile needs both agreementAnchor and nativeArtifactAnchor/ });
  }
});

test('the native profile takes no fixture substrate', async () => {
  const w = sellerWorld();
  await assert.rejects(seller.createSellerAgent({ ...w.base, agreementAnchor: w.agreementAnchor, ...w.artifacts, anchors: w.anchors }), { name: 'TypeError', message: /takes no fixture substrate/ });
});

test('the simulated fixture profile is only an explicit opt-in, and the native profile is never simulated', async () => {
  const w = sellerWorld();
  for (const simulatedFixture of [undefined, false]) {
    await assert.rejects(seller.createSellerAgent({ ...w.base, anchors: w.anchors, simulatedFixture }), { name: 'TypeError', message: /simulated fixture profile.*needs simulatedFixture: true/ });
  }
  await assert.rejects(seller.createSellerAgent({ ...w.base, anchors: w.anchors, simulatedFixture: 'yes' }), { name: 'TypeError', message: /simulatedFixture must be true or false/ });
  await assert.rejects(seller.createSellerAgent({ ...w.base, agreementAnchor: w.agreementAnchor, ...w.artifacts, railAuthority: w.railAuthority, simulatedFixture: true }), { name: 'TypeError', message: /native seller profile is not the simulated fixture profile/ });
  await assert.rejects(seller.createSellerAgent({ ...w.base, agreementAnchor: w.agreementAnchor, ...w.artifacts }), { name: 'TypeError', message: /native seller profile needs railAuthority/ });
  await assert.rejects(seller.validateListing(w.base.listing, { now: () => Date.now(), revocationSurfaces: [], readMarker: async () => null }), { name: 'TypeError', message: /needs an authenticated railAuthority, or simulatedFixture: true/ });
});

test('each complete profile constructs', async () => {
  const w = sellerWorld();
  for (const options of [{ agreementAnchor: w.agreementAnchor, ...w.artifacts, railAuthority: w.railAuthority }, { anchors: w.anchors, simulatedFixture: true }]) {
    const agent = await seller.createSellerAgent({ ...w.base, ...options });
    assert.equal(agent.claim, w.base.signer.claim);
    agent.close();
  }
});

test('PROFILE.json names the Standard pin and the seller requirement the run time uses', () => {
  const profile = JSON.parse(readFileSync(new URL('../PROFILE.json', import.meta.url), 'utf8'));
  assert.equal(profile.standardRevision, DACS_STANDARD_PIN);
  assert.equal(canonicalize(profile.sellerRequirement), canonicalize(SELLER_REQUIREMENT));
  // The session admission requires both parties on exactly this profile.
  assert.equal(canonicalize({ standardRevision: profile.standardRevision, documentVersions: profile.documentVersions }), canonicalize(SELLER_PROFILE));
});

test('a session admission is taken only by the native profile and only with all six of its functions, the Vet receipt and revocation readers included', async () => {
  const w = sellerWorld(), native = { ...w.base, agreementAnchor: w.agreementAnchor, ...w.artifacts, railAuthority: w.railAuthority };
  const complete = { admit: async () => null, resolveVetRecord: async () => null, readVetAnchorReceipt: async () => null, verifyVetAnchorReceipt: async () => 'invalid', readRevocationSurfaces: async () => [], readRevocationMarker: async () => null };
  const without = (name) => { const { [name]: _missing, ...rest } = complete; return rest; };
  for (const sessionAdmission of [without('admit'), without('resolveVetRecord'), without('readVetAnchorReceipt'), without('verifyVetAnchorReceipt'), without('readRevocationSurfaces'), without('readRevocationMarker'), () => null]) {
    await assert.rejects(seller.createSellerAgent({ ...native, sessionAdmission }), { name: 'TypeError', message: /sessionAdmission must expose admit, resolveVetRecord, readVetAnchorReceipt, verifyVetAnchorReceipt, readRevocationSurfaces and readRevocationMarker/ });
  }
  await assert.rejects(seller.createSellerAgent({ ...w.base, anchors: w.anchors, simulatedFixture: true, sessionAdmission: complete }),
    { name: 'TypeError', message: /simulated fixture profile takes no sessionAdmission/ });
});

// Compare with the pinned authority, rather than just two SDK constants.
test('the seller profile matches the pinned Standard JID-1 document tuple', () => {
  const profile = JSON.parse(readFileSync(new URL('../PROFILE.json', import.meta.url), 'utf8'));
  const standard = readFileSync(new URL('../../../vendor/DACS-Standard/spec/PROFILE.md', import.meta.url), 'utf8');
  const candidate = standard.split('## Unreleased JID-1 corrective candidate')[1];
  assert.ok(candidate, 'the pinned Standard declares the claimed candidate');
  const tuple = Object.fromEntries([...candidate.matchAll(/\| \[(CORE|DACS-[1-5])[^\]]*\]\([^)]*\) \| ([0-9.]+) \|/g)].map(([, name, version]) => [name, version]));
  assert.equal(Object.keys(tuple).length, 6);
  assert.deepEqual(profile.documentVersions, tuple);
});

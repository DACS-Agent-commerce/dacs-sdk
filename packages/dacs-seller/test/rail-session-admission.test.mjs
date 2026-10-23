import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, contentHash, sha256Hex, identityBundleHash, compositeVerificationAddress, encodeAddressSegment, signComponentArtifact, ARTIFACT_SEPARATORS } from '@kynesyslabs/dacs';
import { railAuthorityConfig, validateSellerListing, intakeRailDefinition } from '../src/dacs/rail-authority.mjs';
import { proposalTimeProblem } from '../src/dacs/seller-proposal-time.mjs';
import { SELLER_PROFILE, sessionAdmissionConfig, sessionAdmissionProblem, sellerSessionPresentationProblem, vetAnchorReceiptProblem, vetRecordProblem, listingRevocationProblem } from '../src/dacs/session-admission.mjs';
import { railSteward } from './helpers/rail-authority-fixture.mjs';
import { fixtureListing, fixtureIdentityBundle } from './fixtures/listings.mjs';
import { buyer, seller, fixtureRecord, NOW, JOB } from './helpers/protocol-fixture.mjs';

const READ_BYTES = 64 * 1024, READ_MS = 10_000;
const listing = () => fixtureListing(seller, { now: NOW });
const queryFor = value => ({ listing: value, listingPin: { listingId: value.listingId, version: value.listingVersion, contentHash: contentHash(value) }, jobId: JOB, now: () => NOW });
const active = [{ kind: 'well-known', status: 'active', integrity: 'verified' }];

test('new sessions refuse obsolete live pins after disabling the same steward rail', () => {
  const steward = railSteward(101), previous = railAuthorityConfig(steward.railAuthority()), retained = previous.pin();
  const disabled = railAuthorityConfig(steward.railAuthority({ changes: { availability: 'disabled' }, authority: { railRegistryVersion: 2 } }));
  assert.equal(disabled.evaluate(disabled.pin(), 'new').decision, 'fail');
  assert.equal(disabled.evaluate(retained, 'new').decision, 'fail');
  assert.equal(disabled.evaluate(retained, 'in-flight').decision, 'pass');
  const next = railAuthorityConfig(steward.railAuthority({ authority: { railRegistryVersion: 2 } }));
  assert.equal(next.evaluate(retained, 'new').decision, 'fail');
  assert.equal(next.evaluate(next.pin(), 'new').decision, 'pass');
});

test('a retained steward-signed version 2 rail cannot select an unimplemented profile', () => {
  const steward = railSteward(102), config = railAuthorityConfig(steward.railAuthority());
  const rail = steward.signRail(steward.unsignedRail({ railVersion: 2 }));
  const retained = { ...config.pin(), rail, digest: contentHash(rail) };
  assert.notEqual(config.evaluate(retained, 'in-flight').decision, 'pass');
});

test('proposal freshness refuses malformed clocks and unsafe admitted deadline arithmetic', () => {
  for (const observedAt of [undefined, NaN, Infinity, -1, 1.5, 1n, Symbol('TEST clock')]) assert.notEqual(proposalTimeProblem({ generatedAt: NOW, observedAt }), null);
  for (const deadlineSecAfterCommit of [undefined, Infinity, 0, -1, 0.5, 1n, Symbol('TEST interval'), Number.MAX_SAFE_INTEGER]) assert.notEqual(proposalTimeProblem({ generatedAt: NOW, observedAt: NOW, admitted: true, deadlineSecAfterCommit }), null);
  for (const observedAt of [NOW - 600000, NOW + 600000]) assert.equal(proposalTimeProblem({ generatedAt: NOW, observedAt }), null);
  assert.notEqual(proposalTimeProblem({ generatedAt: NOW, observedAt: NOW + 600001 }), null);
  assert.equal(proposalTimeProblem({ generatedAt: NOW, observedAt: NOW + 59999, admitted: true, deadlineSecAfterCommit: 60 }), null);
  assert.notEqual(proposalTimeProblem({ generatedAt: NOW, observedAt: NOW + 60000, admitted: true, deadlineSecAfterCommit: 60 }), null);
});

test('authenticated Listing validation uses the shared CF-3 presentation reader and intake projection', async () => {
  const steward = railSteward(103), config = railAuthorityConfig(steward.railAuthority()), value = listing();
  value.seller.identity.presentation.signatures[0].ref += '?region=GB';
  const { signature, ...draft } = value;
  const signed = await signComponentArtifact(draft, ARTIFACT_SEPARATORS.Listing, { algorithm: 'ed25519', signer: seller.claim, sign: seller.signBytes });
  const result = await validateSellerListing(signed, { now: () => NOW, revocationSurfaces: active, readMarker: async () => null, railAuthority: config });
  assert.equal(result.disposition, 'verified');
  assert.equal(intakeRailDefinition(config.pin()).railVersion, 1);
  assert.equal(intakeRailDefinition(config.pin()).asset.decimals, 9);
});

test('profile admission requires both exact participant tuples and the receipt authenticator', () => {
  const value = listing(), pin = queryFor(value).listingPin, expected = { jobId: JOB, buyer: buyer.claim, seller: seller.claim, buyerBundleHash: 'a'.repeat(64), listingPin: pin };
  const answer = { disposition: 'admitted', jobId: JOB, buyer: buyer.claim, buyerBundleHash: expected.buyerBundleHash, listingPin: pin,
    participants: [['buyer', buyer], ['seller', seller]].map(([role, wallet]) => ({ role, claim: wallet.claim, ...structuredClone(SELLER_PROFILE) })) };
  assert.equal(sessionAdmissionProblem(answer, expected), null);
  const changed = structuredClone(answer); changed.participants[0].documentVersions['DACS-4'] = '0';
  assert.notEqual(sessionAdmissionProblem(changed, expected), null);
  assert.notEqual(sessionAdmissionProblem({ ...answer, listingStatus: 'active' }, expected), null);
  assert.throws(() => sessionAdmissionConfig({ admit() {}, resolveVetRecord() {}, readVetAnchorReceipt() {}, readRevocationSurfaces() {}, readRevocationMarker() {} }));
});

test('seller presentations require the same identity and a real signature on fresh presentation bytes', () => {
  const value = listing(), fresh = fixtureIdentityBundle(seller, NOW);
  assert.equal(sellerSessionPresentationProblem(fresh, value.seller.identity), null);
  fresh.presentation.signatures[0].ref += '?region=GB';
  assert.equal(sellerSessionPresentationProblem(fresh, value.seller.identity), null);
  fresh.presentation.signatures[0].signature = Buffer.alloc(64).toString('base64url');
  assert.notEqual(sellerSessionPresentationProblem(fresh, value.seller.identity), null);
});

async function vetFixture() {
  const requirement = { requirementVersion: '1', required: [] }, bundleHash = identityBundleHash(fixtureIdentityBundle(buyer, NOW));
  const record = await signComponentArtifact({ recordVersion: '1', jobId: JOB, evaluatedParty: buyer.claim, bundleHash,
    requirementHash: sha256Hex(canonicalize(requirement)), freshness: [], supplementary: [], dealSpecific: [], overallDecision: 'pass', generatedAt: NOW },
    ARTIFACT_SEPARATORS.CompositeVerificationRecord, { algorithm: 'ed25519', signer: seller.claim, sign: seller.signBytes });
  const ref = { anchor: { kind: 'storage-program', locator: compositeVerificationAddress(JOB, buyer.claim) }, contentHash: contentHash(record) };
  return { record, ref, jobId: JOB, party: buyer.claim, bundleHash, verifier: seller.claim, invocation: { requirement, freshness: [], dealSpecific: [] }, now: () => NOW };
}

test('a correctly signed Vet record does not require the optional reference signer hint', async () => {
  const f = await vetFixture();
  assert.equal(await vetRecordProblem(f.record, f), null);
  assert.notEqual(await vetRecordProblem(f.record, { ...f, ref: { ...f.ref, signer: buyer.claim } }), null);
  assert.notEqual(await vetRecordProblem({ ...f.record, signature: { ...f.record.signature, value: Buffer.alloc(64).toString('base64url') } }, f), null);
});

test('Vet receipt policy checks the exact record reference, observation and finality state', async () => {
  const f = await vetFixture(), { receipt } = fixtureRecord(f.ref.anchor.locator, f.record);
  assert.equal(vetAnchorReceiptProblem(receipt, f), null);
  for (const change of [{ contentHash: 'b'.repeat(64) }, { logicalAddress: 'TEST-other' }, { observationDisposition: 'indeterminate' }, { substrate: 'demos', state: 'accepted' }]) assert.notEqual(vetAnchorReceiptProblem({ ...receipt, ...change }, f), null);
});

async function revokedFixture(reason = 'TEST revoked') {
  const value = listing(), query = queryFor(value);
  const marker = await signComponentArtifact({ listingId: value.listingId, listingVersion: value.listingVersion, listingContentHash: query.listingPin.contentHash, revokedAt: NOW, reason },
    'dacs-revocation:v1:', { algorithm: 'ed25519', signer: seller.claim, sign: seller.signBytes });
  const binding = { sellerPrimaryClaim: seller.claim, listingId: value.listingId, listingVersion: value.listingVersion, listingContentHash: query.listingPin.contentHash,
    logicalAddress: `dacs1-revoked:${encodeAddressSegment(seller.claim)}:${value.listingId}:v${value.listingVersion}`, markerAnchor: { kind: 'storage-program', locator: 'TEST-marker' }, markerContentHash: contentHash(marker) };
  return { query, marker, surfaces: [{ kind: 'well-known', status: 'revoked', integrity: 'verified', binding }] };
}

test('revocation enforces byte budgets before admitting an oversized signed marker', async () => {
  const f = await revokedFixture('x'.repeat(READ_BYTES + 1));
  const result = await listingRevocationProblem({ readRevocationSurfaces: async () => f.surfaces, readRevocationMarker: async () => f.marker }, f.query);
  assert.equal(result.status, 503);
});

test('decoded surface replies are limited before canonicalization', async () => {
  const result = await listingRevocationProblem({ readRevocationSurfaces: async () => [{ ...active[0], readStatus: 'unavailable', readFailureReason: 'x'.repeat(READ_BYTES + 1) }] }, queryFor(listing()));
  assert.equal(result.status, 503); assert.match(result.message, /byte|size|limit/);
});

test('bounded raw UTF-8 surface and marker replies preserve revocation authentication', async () => {
  const f = await revokedFixture();
  const result = await listingRevocationProblem({ readRevocationSurfaces: async () => Buffer.from(JSON.stringify(f.surfaces)), readRevocationMarker: async () => Buffer.from(JSON.stringify(f.marker)) }, f.query);
  assert.equal(result.status, 409);
});

test('a hanging revocation reader has an overall deadline and abortable wire-byte contract', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let options;
  const pending = listingRevocationProblem({ readRevocationSurfaces: (_query, limits) => { options = limits; return new Promise(() => {}); } }, queryFor(listing()));
  t.mock.timers.tick(READ_MS);
  const result = await pending;
  assert.equal(result.status, 503); assert.match(result.message, /timeout|timed out/);
  assert.equal(options.maxBytes, READ_BYTES); assert.equal(options.signal.aborted, true);
});

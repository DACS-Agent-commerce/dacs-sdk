import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, contentHash, sha256Hex, signedBytes, ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey, storAddress, isListing } from '@kynesyslabs/dacs';
import { verifyComponent, normalizeDemAmount, validateListing, purchaseSupport, buildListingDraft, listingSigningMessage, attachListingSignature, buildUnsignedIdentityBundle, attachIdentityPresentation } from '../src/dacs/listing.mjs';
import { fixtureListing } from './fixtures/listings.mjs';
import { anchorWriteMessage, fixtureWriteHash, verifyFixtureReceipt, FIXTURE_SUBSTRATE, FIXTURE_FINALITY } from '../src/dacs/fixture-anchors.mjs';
import { createDevnetDemoListingPublisher } from '../src/devnet-demo/listing.mjs';
import { requestStop } from '../src/devnet-demo/stop-request.mjs';

const NOW = 1_780_000_000_000, seed = new Uint8Array(32).fill(17), privateKey = privateKeyFromSeed(seed);
const address = `0x${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString('hex')}`;
const wallet = { claim: `did:demos:agent:${address.slice(2)}`, signBytes: bytes => Buffer.from(ed25519Sign(bytes, privateKey)) };
const signListing = value => { const { signature, ...draft } = value; return { ...draft, signature: { algorithm: 'ed25519', signer: draft.seller.identity.presentedBy, value: wallet.signBytes(signedBytes('dacs-listing:v1:', contentHash(draft))).toString('base64url') } }; };
const railAuthority = () => ({ trustPhase: 'PA-1', trustPolicyAcceptsPA1: true, registry: { state: 'not-used', entries: [], definitions: [] },
  inCodeDefinitions: [{ railId: 'demos-native:DEM', railVersion: 1, phaseHandler: 'pay-dem', governanceAnchoring: 'in-code', signatureValid: true }] });
const validation = extra => ({ now: () => NOW, revocationSurfaces: [{ kind: 'well-known', status: 'active', integrity: 'verified' }], readMarker: async () => null, ...extra });
function receiptFor(logicalAddress, artifact) {
  const hash = contentHash(artifact), writerSignature = wallet.signBytes(Buffer.from(anchorWriteMessage(logicalAddress, hash))).toString('base64url');
  return { receiptVersion: '1', substrate: FIXTURE_SUBSTRATE, finalityProfile: FIXTURE_FINALITY, logicalAddress, nativeAddress: storAddress(logicalAddress), contentHash: hash,
    transactionRef: { kind: 'fixture-sr2-write', value: fixtureWriteHash({ logicalAddress, contentHash: hash, writer: wallet.claim, writerSignature }) }, writer: wallet.claim,
    state: 'finalized', observationDisposition: 'established', observedAt: NOW, blockRef: { id: 'TEST-block', height: '1', timestamp: NOW }, evidence: { kind: 'fixture-writer-signature', value: writerSignature } };
}
function publisherWorld({ editReceipt = value => value, read = value => value, sign = bytes => wallet.signBytes(bytes) } = {}) {
  const calls = { sign: 0, publish: 0, read: 0 }; let kept;
  const anchor = {
    async publish(input) { calls.publish++; kept = { status: 'present', artifact: structuredClone(input.artifact), receipt: editReceipt(receiptFor(input.logicalAddress, input.artifact)) }; return structuredClone(kept); },
    async read() { calls.read++; return read(structuredClone(kept)); },
    async verifyReceipt(input) { return verifyFixtureReceipt({ receipt: input.receipt, logicalAddress: input.logicalAddress, hash: contentHash(input.artifact), expectedWriter: wallet.claim }); },
  };
  const publish = createDevnetDemoListingPublisher({ anchor, sign: (...args) => { calls.sign++; return sign(...args); }, scanOwnListings: async () => ({ status: 'ok', anchors: [] }), loadRailResolution: railAuthority });
  const { signature, ...draft } = fixtureListing(wallet, { now: NOW });
  return { publish, draft, calls };
}

test('component verification refuses noncanonical keys and signatures before decoding', () => {
  const bytes = Buffer.from('TEST component'), value = wallet.signBytes(bytes).toString('base64url');
  const signature = { algorithm: 'ed25519', signer: wallet.claim, value };
  assert.equal(verifyComponent({ signedBytes: bytes, signature }), true);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_', residual = value.slice(0, -1) + alphabet[alphabet.indexOf(value.at(-1)) | 1];
  for (const change of [{ signer: `did:demos:agent:${address.slice(2).toUpperCase()}` }, { signer: wallet.claim + 'zz' }, { value: value + '==' }, { value: residual }, { signer: 123 }]) {
    assert.doesNotThrow(() => verifyComponent({ signedBytes: bytes, signature: { ...signature, ...change } }));
    assert.equal(verifyComponent({ signedBytes: bytes, signature: { ...signature, ...change } }), false);
  }
  assert.equal(verifyComponent(null), false);
});

test('malformed component arguments return false without throwing', () => {
  for (const input of [null, undefined, {}, { signedBytes: Buffer.from('TEST'), signature: { algorithm: 'ed25519', signer: 123, value: 'A' } }]) {
    assert.doesNotThrow(() => verifyComponent(input)); assert.equal(verifyComponent(input), false);
  }
});

test('a recoded fixture receipt is invalid even if its public transaction hash is recomputed', () => {
  const artifact = { TEST: 'receipt' }, logicalAddress = 'TEST-logical', receipt = receiptFor(logicalAddress, artifact), hash = contentHash(artifact);
  assert.equal(verifyFixtureReceipt({ receipt, logicalAddress, hash, expectedWriter: wallet.claim }), 'valid');
  receipt.evidence.value += '=='; receipt.transactionRef.value = fixtureWriteHash({ logicalAddress, contentHash: hash, writer: wallet.claim, writerSignature: receipt.evidence.value });
  assert.equal(verifyFixtureReceipt({ receipt, logicalAddress, hash, expectedWriter: wallet.claim }), 'invalid');
});

test('decimal strings preserve exact OS while numeric prices and out-of-range precision are refused', () => {
  assert.equal(normalizeDemAmount('123456789.123456789').amountOs, '123456789123456789');
  assert.throws(() => normalizeDemAmount(Number('123456789.123456789')));
  assert.equal(normalizeDemAmount('0.000000001').amountOs, '1');
  for (const value of ['0', '-1', '0.0000000001', '1' + '0'.repeat(69)]) assert.throws(() => normalizeDemAmount(value));
});

test('a reader requires caller-supplied authenticated rail authority', async () => {
  const listing = fixtureListing(wallet, { now: NOW });
  assert.equal((await validateListing(listing, validation())).disposition, 'indeterminate');
  assert.equal((await validateListing(listing, validation({ loadRailResolution: railAuthority }))).disposition, 'verified');
});

for (const qualify of ['claim', 'presentation']) test(`CF-3 permits qualified ${qualify} identity references without changing control`, async () => {
  let listing = fixtureListing(wallet, { now: NOW });
  const bundle = listing.seller.identity;
  if (qualify === 'claim') {
    delete bundle.presentation; bundle.claims[0].ref += '?jurisdiction=GB';
    const hash = sha256Hex(canonicalize(bundle));
    bundle.presentation = { kind: 'per-claim', signatures: [{ ref: wallet.claim, signature: wallet.signBytes(signedBytes('dacs-bundle-presentation:v1:', hash)).toString('base64url') }] };
  } else bundle.presentation.signatures[0].ref += '?jurisdiction=GB';
  listing = signListing(listing); assert.equal(isListing(listing), true);
  assert.equal((await validateListing(listing, validation({ loadRailResolution: railAuthority }))).disposition, 'verified');
});

test('purchase support requires the implemented delivery, phase order and exact DEM rail version', () => {
  const listing = fixtureListing(wallet, { now: NOW }); assert.equal(purchaseSupport(listing).supported, true);
  for (const mutate of [value => { value.acceptedRails[0].railVersion = 2; }, value => { value.offering.deliverable.accessModel = 'buyer-only'; },
    value => { value.pipeline.splice(1, 1); }, value => { value.offering.deliverable = { kind: 'entitlement', durationSec: 60, renewable: false }; value.pipeline[3].kind = 'deliver-entitlement'; }]) {
    const changed = structuredClone(listing); mutate(changed); assert.equal(purchaseSupport(signListing(changed)).supported, false);
  }
});

test('builder and attachment sign the exact independent identity and Listing domain bytes', () => {
  const unsigned = buildUnsignedIdentityBundle({ address, presentedAt: NOW, sessionNonce: 'a'.repeat(64) });
  const identityBundle = attachIdentityPresentation(unsigned, '0x' + wallet.signBytes(Buffer.from(unsigned.message)).toString('hex'));
  const draft = buildListingDraft({ identityBundle, displayName: 'TEST seller', publicEndpoint: 'https://seller.example/dacs', listingId: 'TEST-listing', listingVersion: 1,
    title: 'TEST report', description: 'TEST description', category: 'data.test', tags: ['test'], priceDem: '1', notBefore: NOW });
  assert.equal(listingSigningMessage(draft), 'dacs-listing:v1:' + contentHash(draft));
  const listing = attachListingSignature(draft, '0x' + wallet.signBytes(Buffer.from(listingSigningMessage(draft))).toString('hex'));
  assert.equal(isListing(listing), true); assert.equal(contentHash(listing), contentHash(draft));
});

for (const [label, change] of [['included receipt', { editReceipt: receipt => ({ ...receipt, state: 'included' }) }],
  ['changed content hash', { editReceipt: receipt => ({ ...receipt, contentHash: '0'.repeat(64) }) }],
  ['changed native address', { editReceipt: receipt => ({ ...receipt, nativeAddress: 'fake-address' }) }],
  ['unavailable readback', { read: () => ({ status: 'indeterminate', reason: 'TEST read timeout' }) }],
  ['different stored bytes', { read: value => ({ ...value, artifact: { ...value.artifact, listingId: 'TEST changed' } }) }]]) {
  test(`publication refuses ${label}`, async () => { const w = publisherWorld(change); await assert.rejects(w.publish(w.draft)); });
}

test('publication authenticates finalized receipt and independently resolves the exact signed Listing', async () => {
  const w = publisherWorld(), result = await w.publish(w.draft);
  assert.equal(result.ref, storAddress(result.logicalAddress)); assert.equal(contentHash(result.listing), result.listingPin.contentHash);
  assert.deepEqual(w.calls, { sign: 1, publish: 1, read: 1 });
});

test('stop reaches a pending signature and prevents any subsequent signature or submission', async () => {
  let entered, release, options;
  const signing = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const w = publisherWorld({ sign: async (bytes, supplied) => { options = supplied; entered(); await gate; return wallet.signBytes(bytes); } });
  const pending = w.publish(w.draft); await signing; requestStop(); release();
  await assert.rejects(pending);
  assert.equal(options.signal.aborted, true); assert.equal(w.calls.publish, 0);
  await assert.rejects(w.publish(w.draft)); assert.equal(w.calls.sign, 1);
});

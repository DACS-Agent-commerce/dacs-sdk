// The Listing validation the purchase verifier uses also loads from a module
// with no purchase policy, and keeps the verdicts it had. The bounded JSON
// transport marks an over-limit body with one code a caller can map.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contentHash, encodeAddressSegment, signedBytes } from '@kynesyslabs/dacs';
import * as readOnly from '../src/dacs/listing-read-only.mjs';
import * as listingModule from '../src/dacs/listing.mjs';
import * as verificationModule from '../src/dacs/verification.mjs';
import { createDirectoryClient } from '../src/dacs/directory.mjs';
import { fetchBoundedJson, RESPONSE_BYTE_LIMIT } from '../src/util/http.mjs';
import { addressForClaim } from '../src/signatures.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { fixtureListing, fixtureLocator, summaryFor } from './fixtures/listings.mjs';

const CHECKED_AT = Date.UTC(2026, 2, 1);
const HOUR_MS = 3_600_000;
const HELD = 'rail availability is not authenticated; purchase actions are held';
const ORIGIN = 'https://directory.invalid';

const wallet = createEphemeralWallet();
const seller = wallet.claim;
const listing = fixtureListing(wallet, { now: CHECKED_AT });
const listingHash = contentHash(listing);
const listingLocator = fixtureLocator('read-only-pure-listing');
const markerLocator = fixtureLocator('read-only-pure-marker');

const signWith = (separator, body) => ({ ...body, signature: { algorithm: 'ed25519', signer: seller, value: wallet.signBytes(signedBytes(separator, contentHash(body))).toString('base64url') } });
const marker = signWith('dacs-revocation:v1:', { listingId: listing.listingId, listingVersion: listing.listingVersion, listingContentHash: listingHash, revokedAt: CHECKED_AT - HOUR_MS, reason: 'withdrawn' });
const activeSurface = [{ kind: 'catalog', status: 'active', readStatus: 'ok', catalogObservedAt: CHECKED_AT - HOUR_MS }];
const revokedSurface = [{ kind: 'catalog', status: 'revoked', readStatus: 'ok', catalogObservedAt: CHECKED_AT - HOUR_MS, binding: {
  sellerPrimaryClaim: seller, listingId: listing.listingId, listingVersion: listing.listingVersion, listingContentHash: listingHash,
  logicalAddress: `dacs1-revoked:${encodeAddressSegment(seller)}:${listing.listingId}:v${listing.listingVersion}`,
  markerAnchor: { kind: 'storage-program', locator: markerLocator }, markerContentHash: contentHash(marker),
} }];
const readMarker = async (anchor) => (anchor?.locator === markerLocator ? marker : null);

async function verdict(candidate, revocationSurfaces = activeSurface, read = readMarker, extra = {}) {
  const result = await readOnly.validateListing(candidate, { now: () => CHECKED_AT, revocationSurfaces, readMarker: read, ...extra });
  return { disposition: result.disposition, step: result.step, reason: result.reason };
}

function withBadIdentitySignature() {
  const draft = structuredClone(listing);
  delete draft.signature;
  draft.seller.identity.presentation.signatures[0].signature = listing.signature.value;
  return signWith('dacs-listing:v1:', draft);
}

const jsonResponse = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

// The purchase verifier over a Directory row and a chain that both serve the fixture Listing.
function purchaseVerifier() {
  const directory = createDirectoryClient({
    origin: ORIGIN,
    fetchImpl: async (input) => jsonResponse(new URL(input).pathname === '/api/dacs/listings'
      ? { listings: [summaryFor(listing, listingLocator, { observedAt: CHECKED_AT - HOUR_MS })] }
      : listing),
  });
  const chain = {
    rpcOrigin: 'https://rpc.invalid', network: 'testnet', evidenceMode: 'TEST',
    readStorageProgram: async (locator) => (locator === listingLocator
      ? { status: 'found', data: listing, owner: addressForClaim(seller) }
      : { status: 'indeterminate', reason: 'not served' }),
  };
  return verificationModule.createListingVerifier({ directory, chain, now: () => CHECKED_AT });
}

test('pure Listing validation retains the existing signature revocation and purchase-verifier verdicts', async () => {
  // The old paths hand out the pure module's own functions, so both callers run one implementation.
  assert.equal(listingModule.validateListing, readOnly.validateListing);
  assert.equal(listingModule.verifyComponent, readOnly.verifyComponent);
  assert.equal(listingModule.DEM_RAIL, readOnly.DEM_RAIL);
  assert.equal(verificationModule.checkCatalogObservation, readOnly.checkCatalogObservation);
  assert.equal(Object.hasOwn(readOnly, 'purchaseSupport'), false);

  // Signature and revocation verdicts. A good Listing passes its signature,
  // identity and revocation steps and stops at the rail step, as before.
  assert.deepEqual(await verdict(listing), { disposition: 'indeterminate', step: 8, reason: 'malformed-rail-authority' });
  const forged = { ...listing, signature: { ...listing.signature, value: withBadIdentitySignature().signature.value } };
  // The display resolution verifies the same Listing and keeps every earlier step's verdict.
  const display = { loadRailResolution: readOnly.displayRailResolution };
  assert.equal((await verdict(listing, activeSurface, readMarker, display)).disposition, 'verified');
  assert.deepEqual(await verdict(forged, activeSurface, readMarker, display), { disposition: 'rejected', step: 4, reason: 'listing-signature-invalid' });
  assert.deepEqual(await verdict(listing, revokedSurface, readMarker, display), { disposition: 'revoked', step: 5, reason: 'verified-revocation-marker' });
  assert.deepEqual(await verdict(forged), { disposition: 'rejected', step: 4, reason: 'listing-signature-invalid' });
  assert.deepEqual(await verdict(withBadIdentitySignature()), { disposition: 'rejected', step: 6, reason: 'identity-presentation-invalid' });
  assert.deepEqual(await verdict(listing, revokedSurface), { disposition: 'revoked', step: 5, reason: 'verified-revocation-marker' });
  assert.deepEqual(await verdict(listing, revokedSurface, async () => null), { disposition: 'indeterminate', step: 5, reason: 'marker-unreadable' });

  // The purchase-support policy keeps its held reason first, its reason order and its result shape.
  assert.deepEqual(listingModule.purchaseSupport(listing), {
    supported: false, reasons: [HELD], price: { amount: '2.5', currency: 'DEM', amountOs: '2500000000' }, payee: addressForClaim(seller),
  });
  const unsupported = { ...listing, pricing: { kind: 'auction', price: { amount: 'x', currency: 'USD' } }, acceptedRails: [], pipeline: [{ kind: 'negotiate-auction' }] };
  assert.deepEqual(listingModule.purchaseSupport(unsupported).reasons, [
    HELD, 'pricing is not fixed-price', 'price currency is not DEM', 'price amount is not a positive DEM decimal',
    'listing does not accept demos-native:DEM version 1', 'pipeline has no pay-dem phase on demos-native:DEM', 'negotiation is not fixed-price',
  ]);

  // The purchase verifier still reports that support check and is never transactable while it holds.
  const result = await purchaseVerifier().verify({ listingId: listing.listingId, version: listing.listingVersion, seller });
  assert.deepEqual(result.checks.filter((check) => !check.ok).map((check) => check.name), ['standard-reader-verified', 'v0.1-purchase-support']);
  assert.equal(result.checks.find((check) => check.name === 'v0.1-purchase-support').detail, HELD);
  assert.equal(result.transactable, false);
  assert.equal(result.eligibility, 'not-transactable');
  assert.equal(result.listing, undefined);
});

test('bounded JSON transport marks declared and streamed oversized responses response_byte_limit', async () => {
  const MAX_BYTES = 64;
  const read = (response) => fetchBoundedJson('https://rpc.invalid/read', { fetchImpl: async () => response, timeoutMs: 1_000, maxBytes: MAX_BYTES });
  const assertTooLarge = (error) => {
    assert.equal(error.kind, 'invalid');
    assert.equal(error.code, RESPONSE_BYTE_LIMIT);
    assert.equal(error.message, 'response exceeds byte limit');
    return true;
  };

  // Declared: the content-length alone is over the limit.
  const declared = new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(MAX_BYTES + 1) } });
  await assert.rejects(read(declared), assertTooLarge);

  // Streamed: the declaration is within the limit, the body that arrives is not.
  const chunk = new TextEncoder().encode(`"${'a'.repeat(MAX_BYTES)}"`);
  const streamed = new Response(new ReadableStream({ start(controller) { controller.enqueue(chunk); controller.close(); } }),
    { headers: { 'content-type': 'application/json', 'content-length': '2' } });
  await assert.rejects(read(streamed), assertTooLarge);
});

// A listing price must be a payment this client can verify on chain. A Demos
// node projects a transfer's content.amount as a JSON number, and CF-5
// admission of every RPC answer refuses one above 2^53 - 1, so 9007199254740991
// OS is the largest price admitted for a listing draft, a buyer purchase
// (purchaseSupport) or a seller session (protocolSupport).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildListingDraft, normalizeDemAmount, purchaseSupport } from '../src/dacs/listing.mjs';
import { OS_VERIFIABLE_MAX } from '../src/dacs/chain.mjs';
import { protocolSupport, SUPPORTED_PIPELINE } from '../src/dacs/purchase-protocol.mjs';
import { fetchBoundedJson } from '../src/util/http.mjs';

const MAX_DEM = '9007199.254740991', OVER_DEM = '9007199.254740992';
const REFUSED = /^price exceeds 9007199254740991 OS, the largest payment a Demos transaction read can verify$/;
const listingAt = (amount) => ({ listingId: 'TEST-listing', listingVersion: 1, offering: { deliverable: { kind: 'storage-program', accessModel: 'public' } },
  pricing: { kind: 'fixed', price: { amount, currency: 'DEM' } }, acceptedRails: [{ railId: 'demos-native:DEM', railVersion: 1 }],
  seller: { identity: { presentedBy: 'did:demos:agent:' + 'a'.repeat(64) } },
  pipeline: SUPPORTED_PIPELINE.map((kind) => kind === 'pay-dem' ? { kind, parameters: { rail: 'demos-native:DEM' } } : { kind }) });

test('the verifiable bound is 2^53 - 1 OS', () => {
  assert.equal(OS_VERIFIABLE_MAX, 9007199254740991n);
});

test('normalizeDemAmount admits 9007199254740991 OS and refuses 9007199254740992 OS', () => {
  assert.deepEqual(normalizeDemAmount(MAX_DEM), { amount: MAX_DEM, amountOs: '9007199254740991' });
  assert.throws(() => normalizeDemAmount(OVER_DEM), { message: REFUSED, code: 'price_unverifiable' });
  assert.throws(() => normalizeDemAmount('10000000'), { message: REFUSED });
  assert.throws(() => normalizeDemAmount('9'.repeat(70)), /longer than any Demos balance/);
});

test('buildListingDraft refuses a price above the verifiable bound before building anything', () => {
  assert.throws(() => buildListingDraft({ priceDem: OVER_DEM }), { message: REFUSED });
});

test('buyer purchaseSupport carries the bound as its price reason', () => {
  const max = purchaseSupport(listingAt(MAX_DEM));
  assert.equal(max.price.amountOs, '9007199254740991');
  assert.ok(!max.reasons.some((reason) => /price/.test(reason)), max.reasons.join('; '));
  const over = purchaseSupport(listingAt(OVER_DEM));
  assert.equal(over.supported, false);
  assert.equal(over.price, null);
  assert.ok(over.reasons.some((reason) => REFUSED.test(reason)), over.reasons.join('; '));
  assert.ok(purchaseSupport(listingAt('-1')).reasons.includes('price amount is not a positive DEM decimal'));
});

test('seller protocolSupport refuses a session it could not verify payment for', () => {
  assert.deepEqual(protocolSupport(listingAt(MAX_DEM)).reasons, []);
  const over = protocolSupport(listingAt(OVER_DEM));
  assert.equal(over.supported, false);
  assert.equal(over.reasons.length, 1);
  assert.match(over.reasons[0], REFUSED);
  assert.deepEqual(protocolSupport(listingAt('0')).reasons, ['price amount is not a positive DEM decimal']);
});

// Why the bound sits there: the node-shaped transaction body with the amount
// as a JSON number is admitted at 2^53 - 1 and refused one above it.
const nodeTx = (amount) => `{"result":200,"response":{"hash":"${'a'.repeat(64)}","content":{"type":"native","nonce":"198","amount":${amount}},"status":"confirmed"}}`;
const read = (body) => fetchBoundedJson('https://rpc.invalid/', { method: 'POST', body: {}, timeoutMs: 1000, maxBytes: 4096, expectedOrigin: 'https://rpc.invalid',
  fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }) });

test('an RPC transaction body is readable at the bound and not above it', async () => {
  assert.equal((await read(nodeTx('9007199254740991'))).response.content.amount, 9007199254740991);
  await assert.rejects(read(nodeTx('9007199254740992')), (error) => error.kind === 'invalid' && error.code === 'NUMBER-OUTSIDE-DACS-MAGNITUDE');
});

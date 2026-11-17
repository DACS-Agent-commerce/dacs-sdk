import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { createSellerTransportClientAuth, sellerSessionDelegationSigningBytes } from '../src/dacs/seller-transport-auth.mjs';
import { assertSellerSessionLifetime, SELLER_SESSION_MAX_LIFETIME_MS } from '../src/public/portal/seller-session-limits.mjs';

// Fixed public test seeds, never operator credentials.
function signer(seed) {
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seed)]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  return { claim: `did:demos:agent:${publicKey}`, publicKey, sign: (bytes) => sign(null, bytes, privateKey) };
}
const buyer = signer(1), seller = signer(2), session = signer(3);
const jobId = '01J8N4YV7YVYQ4DB7M8T4C7W0A';
const pin = { listingId: 'TEST-listing', version: 1, contentHash: 'd'.repeat(64) };
function delegation(overrides = {}) {
  const payload = { version: '1', kind: 'seller-session-delegation', buyer: buyer.claim, sessionPublicKey: session.publicKey,
    seller: seller.claim, listingPin: pin, jobId, notBefore: 900, expiresAt: 1500, ...overrides };
  return { payload, signature: buyer.sign(sellerSessionDelegationSigningBytes(payload)).toString('base64url') };
}

test('session lifetime accepts its boundary and refuses malformed or excessive durations', () => {
  assert.doesNotThrow(() => assertSellerSessionLifetime(SELLER_SESSION_MAX_LIFETIME_MS));
  for (const duration of [0, -1, 1.5, '100', SELLER_SESSION_MAX_LIFETIME_MS + 1]) assert.throws(() => assertSellerSessionLifetime(duration), RangeError);
  assert.throws(() => delegation({ expiresAt: 900 + SELLER_SESSION_MAX_LIFETIME_MS + 1 }), { code: 'peer_delegation_invalid' });
});

test('signer and seller configuration rejects coercible claim values', () => {
  const coerce = { toString() { throw new Error('TEST claim coercion must not run'); } };
  for (const claim of [[buyer.claim], coerce]) {
    assert.throws(() => createSellerTransportClientAuth({ buyerSigner: { ...buyer, claim }, seller: seller.claim, resolveJob() {} }), /signing callback/);
    assert.throws(() => createSellerTransportClientAuth({ buyerSigner: buyer, seller: claim, resolveJob() {} }), /configuration/);
  }
});

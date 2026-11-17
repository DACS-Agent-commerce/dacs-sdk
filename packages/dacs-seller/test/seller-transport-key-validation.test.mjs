import test from 'node:test';
import assert from 'node:assert/strict';
import { sign } from 'node:crypto';
import { privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from '@kynesyslabs/dacs';
import { sellerSessionDelegationSigningBytes, verifySellerSessionDelegation } from '../src/dacs/seller-transport-auth.mjs';
import { BAD_KEYS, IDENTITY_SIGNATURE as identitySignature, raisedS } from './helpers/ed25519-edge-cases.mjs';

// Fixed public test seeds, never operator credentials.
function signer(seed) {
  const privateKey = privateKeyFromSeed(Buffer.alloc(32, seed));
  const publicKey = Buffer.from(rawPublicKey(publicKeyFromSeed(Buffer.alloc(32, seed)))).toString('hex');
  return { claim: `did:demos:agent:${publicKey}`, publicKey, sign: (bytes) => sign(null, bytes, privateKey) };
}
const buyer = signer(1), seller = signer(2), session = signer(3);
const jobId = '01J8N4YV7YVYQ4DB7M8T4C7W0A';
const pin = { listingId: 'TEST-listing', version: 1, contentHash: 'd'.repeat(64) };
const claim = (key) => `did:demos:agent:${key}`;

function delegation(overrides = {}) {
  const payload = { version: '1', kind: 'seller-session-delegation', buyer: buyer.claim, sessionPublicKey: session.publicKey,
    seller: seller.claim, listingPin: pin, jobId, notBefore: 900, expiresAt: 1500, ...overrides };
  return { payload, signature: buyer.sign(sellerSessionDelegationSigningBytes(payload)).toString('base64url') };
}

test('the buyer delegation check accepts a good signature and refuses S at or above the group order', () => {
  const grant = delegation();
  assert.deepEqual(verifySellerSessionDelegation(grant), grant.payload);
  assert.throws(() => verifySellerSessionDelegation({ ...grant, signature: raisedS(grant.signature) }), { code: 'peer_delegation_signature_invalid' });
});

test('the buyer delegation check refuses a small-order buyer key and one with y at or above the field prime', () => {
  for (const [name, key] of Object.entries(BAD_KEYS)) {
    const { payload } = delegation({ buyer: claim(key) });
    assert.throws(() => verifySellerSessionDelegation({ payload, signature: identitySignature }), { code: 'peer_delegation_signature_invalid' }, name);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { sign } from 'node:crypto';
import { canonicalize, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from '@kynesyslabs/dacs';
import { createSellerTransportClientAuth, createSellerTransportServerAuth, sellerSessionDelegationSigningBytes,
  verifySellerSessionDelegation } from '../src/dacs/seller-transport-auth.mjs';

// Fixed public test seeds, never operator credentials.
function signer(seed) {
  const privateKey = privateKeyFromSeed(Buffer.alloc(32, seed));
  const publicKey = Buffer.from(rawPublicKey(publicKeyFromSeed(Buffer.alloc(32, seed)))).toString('hex');
  return { claim: `did:demos:agent:${publicKey}`, publicKey, sign: (bytes) => sign(null, bytes, privateKey) };
}
const buyer = signer(1), seller = signer(2), session = signer(3);
const jobId = '01J8N4YV7YVYQ4DB7M8T4C7W0A';
const pin = { listingId: 'TEST-listing', version: 1, contentHash: 'd'.repeat(64) };
const now = () => 1000;
const claim = (key) => `did:demos:agent:${key}`;
const encoded = (envelope) => Buffer.from(canonicalize(envelope)).toString('base64url');

const GROUP_ORDER = (1n << 252n) + 27742317777372353535851937790883648493n;
// The same signature with S + L in place of S: the same scalar, not below the group order.
function raisedS(signature) {
  const bytes = Buffer.from(signature, 'base64url');
  const s = BigInt(`0x${Buffer.from(bytes.subarray(32)).reverse().toString('hex')}`) + GROUP_ORDER;
  Buffer.from(s.toString(16).padStart(64, '0'), 'hex').reverse().copy(bytes, 32);
  return bytes.toString('base64url');
}
// Raw little-endian public keys. y = p + 3 is not small order once reduced, so
// the seller's small-order check lets it through to the signature verifier.
const BAD_KEYS = {
  'small-order y = 1': '01' + '00'.repeat(31),
  'small-order y = p - 1': 'ec' + 'ff'.repeat(30) + '7f',
  'y = p': 'ed' + 'ff'.repeat(30) + '7f',
  'y = p + 1': 'ee' + 'ff'.repeat(30) + '7f',
  'y = p + 3': 'f0' + 'ff'.repeat(30) + '7f',
};
// R is the identity point and S is zero.
const identitySignature = Buffer.from('01' + '00'.repeat(63), 'hex').toString('base64url');

function server() {
  const store = { journaledOnlyReserve: true, bind() {}, finish() {}, reserve: () => ({ disposition: 'cached' }) };
  return createSellerTransportServerAuth({ sellerSigner: seller, listingPin: pin, store, now });
}
async function signedRequest() {
  const client = createSellerTransportClientAuth({ buyerSigner: buyer, seller: seller.claim, resolveJob: () => ({ listingPin: pin, agreementHash: 'e'.repeat(64) }),
    now, lifetimeMs: 100, nonce: () => Buffer.alloc(24, 4).toString('base64url') });
  const body = { transportIdentity: { jobId } };
  const { header } = await client.request('/dacs/v1/agreements/state', body, JSON.stringify(body));
  return JSON.parse(Buffer.from(header, 'base64url'));
}
function delegation(overrides = {}) {
  const payload = { version: '1', kind: 'seller-session-delegation', buyer: buyer.claim, sessionPublicKey: session.publicKey,
    seller: seller.claim, listingPin: pin, jobId, notBefore: 900, expiresAt: 1500, ...overrides };
  return { payload, signature: buyer.sign(sellerSessionDelegationSigningBytes(payload)).toString('base64url') };
}

test('the peer header check accepts a good signature and refuses S at or above the group order', async () => {
  const envelope = await signedRequest();
  assert.equal(server().readRequest(encoded(envelope)).buyer, buyer.claim);
  assert.throws(() => server().readRequest(encoded({ ...envelope, signature: raisedS(envelope.signature) })), { code: 'peer_signature_invalid' });
});

test('the peer header check refuses a small-order key and a key with y at or above the field prime', async () => {
  const envelope = await signedRequest();
  for (const [name, key] of Object.entries(BAD_KEYS)) {
    const payload = { ...envelope.payload, buyer: claim(key) };
    assert.throws(() => server().readRequest(encoded({ payload, signature: identitySignature })), { code: 'peer_signature_invalid' }, name);
  }
});

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

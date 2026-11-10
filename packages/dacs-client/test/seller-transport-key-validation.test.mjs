import assert from 'node:assert/strict';
import { sign, webcrypto } from 'node:crypto';
import test from 'node:test';
import {
  canonicalize, ed25519Verify, privateKeyFromSeed, publicKeyFromRaw, publicKeyFromSeed,
  rawPublicKey, sha256Hex,
} from '@kynesyslabs/dacs';
import {
  createSellerTransportClientAuth, sellerSessionDelegationSigningBytes,
  verifySellerSessionDelegation,
} from '../src/dacs/seller-transport-auth.mjs';
import { verifyEmbeddedEd25519 } from '../src/public/portal/embedded-wallet/sdk-provider.mjs';

globalThis.crypto ??= webcrypto;

const seed = Buffer.from('9d61b19deffd5a60ba844af492ec2cc4' + '4449c5697b326919703bac031cae7f60', 'hex');
const publicKey = Buffer.from('d75a980182b10ab7d54bfed3c964073a' + '0ee172f3daa62325af021a68f707511a', 'hex');
const signature = Buffer.from('e5564300c360ac729086e2cc806e828a' + '84877f1eb8e5d974d873e06522490155' + '5fb8821590a33bacc61e39701cf9b46b' + 'd25bf5f0595bbe24655141438e7a100b', 'hex');
const smallKey = `01${'00'.repeat(31)}`;
const smallSignature = Buffer.from(`01${'00'.repeat(63)}`, 'hex');
const claim = (key) => `did:demos:agent:${key}`;
const pin = { listingId: 'listing', version: 1, contentHash: 'a'.repeat(64) };
const jobId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

test('RFC 8032 signature verifies through the client transport runtime', () => {
  assert.deepEqual(rawPublicKey(publicKeyFromSeed(seed)), publicKey);
  assert.equal(ed25519Verify(Buffer.alloc(0), signature, publicKeyFromRaw(publicKey)), true);
});

test('embedded wallet verifier accepts RFC 8032 and refuses a small-order key', async () => {
  const message = new Uint8Array();
  assert.equal(await verifyEmbeddedEd25519(publicKey, signature, message), true);
  assert.equal(await verifyEmbeddedEd25519(Buffer.from(smallKey, 'hex'), smallSignature, message), false);
  assert.equal(await verifyEmbeddedEd25519(Buffer.from(`ef${'ff'.repeat(30)}7f`, 'hex'), smallSignature, message), false);
  const noncanonicalS = Buffer.from(signature);
  noncanonicalS.fill(0xff, 32);
  assert.equal(await verifyEmbeddedEd25519(publicKey, noncanonicalS, message), false);
});

test('client transport refuses a delegation under a small-order buyer key', () => {
  const payload = {
    version: '1', kind: 'seller-session-delegation', buyer: claim(smallKey),
    sessionPublicKey: publicKey.toString('hex'), seller: claim('ab'.repeat(32)),
    listingPin: pin, jobId, notBefore: 1000, expiresAt: 31000,
  };
  const delegation = { payload, signature: smallSignature.toString('base64url') };
  assert.throws(() => verifySellerSessionDelegation(delegation), { code: 'peer_delegation_signature_invalid' });
});

function clientFor(seller) {
  const buyerKey = Buffer.from(rawPublicKey(publicKeyFromSeed(Buffer.alloc(32, 7))));
  return createSellerTransportClientAuth({
    buyerSigner: { claim: claim(buyerKey.toString('hex')), sign: (bytes) => sign(null, bytes, privateKeyFromSeed(Buffer.alloc(32, 7))) },
    seller: claim(seller), resolveJob: () => ({ listingPin: pin, agreementHash: 'b'.repeat(64) }),
    now: () => 1000, nonce: () => Buffer.alloc(16).toString('base64url'),
  });
}

async function responseFor(seller, signer) {
  const client = clientFor(seller);
  const request = (await client.request('/dacs/v1/payments', { jobId }, '{}')).payload;
  const text = '{}';
  const payload = {
    ...request, kind: 'response', bodyHash: sha256Hex(text), expiresAt: 31000,
    requestHash: sha256Hex(canonicalize(request)), status: 200,
  };
  const signatureBytes = signer(Buffer.from(`dacs-chatgpt-plugin:loopback-seller-peer:v1:${canonicalize(payload)}`));
  const header = Buffer.from(canonicalize({ payload, signature: signatureBytes.toString('base64url') })).toString('base64url');
  return { client, request, response: { header, status: 200, text } };
}

test('client transport refuses a peer envelope under a small-order seller key', async () => {
  const { client, request, response } = await responseFor(smallKey, () => smallSignature);
  assert.throws(() => client.verifyResponse(request, response), { code: 'peer_signature_invalid' });
});

test('client transport accepts an ordinary signed peer envelope and delegation', async () => {
  const key = publicKey.toString('hex');
  const payload = {
    version: '1', kind: 'seller-session-delegation', buyer: claim(key),
    sessionPublicKey: key, seller: claim('ab'.repeat(32)),
    listingPin: pin, jobId, notBefore: 1000, expiresAt: 31000,
  };
  const delegationSignature = sign(null, sellerSessionDelegationSigningBytes(payload), privateKeyFromSeed(seed));
  assert.deepEqual(verifySellerSessionDelegation({ payload, signature: delegationSignature.toString('base64url') }), payload);
  const { client, request, response } = await responseFor(key, (bytes) => sign(null, bytes, privateKeyFromSeed(seed)));
  assert.equal(client.verifyResponse(request, response).principal, claim(key));
});

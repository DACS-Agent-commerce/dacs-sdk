// K12-H6a / K12-H6b: the signing domain of the seller transport, as the kit's server auth and the client's signer each use it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { canonicalize } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_DOMAINS } from '@kynesyslabs/dacs/wire';
import { BUYER, publicKeyHex, sellerTransportPair } from './fixtures.mjs';

const OLD_DOMAIN = 'dacs-chatgpt-plugin:loopback-seller-peer:v1:';
const ED25519_SPKI_PREFIX = '302a300506032b6570032100';

const buyerPublicKey = () => createPublicKey({ key: Buffer.from(ED25519_SPKI_PREFIX + publicKeyHex(BUYER), 'hex'), format: 'der', type: 'spki' });
const decodeHeader = (header) => JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
const signedUnder = (domain, payload) => Buffer.from(domain + canonicalize(payload), 'utf8');
const verifiesUnder = (domain, { payload, signature }) => verify(null, signedUnder(domain, payload), buyerPublicKey(), Buffer.from(signature, 'base64url'));
/** The header the client would send if BUYER signed the same payload under `domain`. */
const headerSignedUnder = (domain, payload) => Buffer.from(canonicalize({ payload, signature: BUYER.signBytes(signedUnder(domain, payload)).toString('base64url') })).toString('base64url');

test("K12-H6a today: the kit's server-side transport auth accepts an old-domain signed request", async (t) => {
  const { serverAuth, stateRequest } = await sellerTransportPair(t);
  const { payload, header } = await stateRequest();
  assert.equal(verifiesUnder(OLD_DOMAIN, decodeHeader(header)), true, 'the client signed under the old domain');
  assert.deepEqual(serverAuth.readRequest(header), payload);
});

test("K12-H6a control: the kit's server-side transport auth refuses the same request signed under the wire domain", async (t) => {
  const { serverAuth, stateRequest } = await sellerTransportPair(t);
  const { payload } = await stateRequest();
  assert.throws(() => serverAuth.readRequest(headerSignedUnder(DACS_SELLER_HTTP_DOMAINS.request, payload)),
    { code: 'peer_signature_invalid', status: 401 });
});

test("K12-H6b today: the client's request signer emits old-domain signing bytes", async (t) => {
  const { stateRequest } = await sellerTransportPair(t);
  const envelope = decodeHeader((await stateRequest()).header);
  assert.equal(verifiesUnder(OLD_DOMAIN, envelope), true);
  assert.equal(verifiesUnder(DACS_SELLER_HTTP_DOMAINS.request, envelope), false);
});

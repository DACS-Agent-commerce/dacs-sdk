// K12-H6a / K12-H6b: the signing domain of the seller transport, as the kit's server auth and the client's signer each use it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_DOMAINS, DACS_SELLER_HTTP_PATHS } from '@kynesyslabs/dacs/wire';
import { buyer as hostBuyer } from '../../packages/dacs-seller/test/helpers/protocol-fixture.mjs';
import { BUYER, JOB, publicKeyHex, sellerTransportPair } from './fixtures.mjs';
import { composedKitHost, postHeader, wireSignedRequest } from './kit-host.mjs';

const OLD_DOMAIN = 'dacs-chatgpt-plugin:loopback-seller-peer:v1:';
const ED25519_SPKI_PREFIX = '302a300506032b6570032100';

const buyerPublicKey = () => createPublicKey({ key: Buffer.from(ED25519_SPKI_PREFIX + publicKeyHex(BUYER), 'hex'), format: 'der', type: 'spki' });
const decodeHeader = (header) => JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
const signedUnder = (domain, payload) => Buffer.from(domain + canonicalize(payload), 'utf8');
const verifiesUnder = (domain, { payload, signature }) => verify(null, signedUnder(domain, payload), buyerPublicKey(), Buffer.from(signature, 'base64url'));
/** The header the client would send if `wallet` signed the same payload under `domain`. */
const headerSignedUnder = (domain, payload, wallet = BUYER) => Buffer.from(canonicalize({ payload, signature: wallet.signBytes(signedUnder(domain, payload)).toString('base64url') })).toString('base64url');

// Flipped by P11a1a (the signed routes on `./wire`): the kit's composed host takes the wire domain only on the routes the wire opens.
const STATE_PATH = DACS_SELLER_HTTP_PATHS.state;
/** A state request for a job the host holds nothing for, signed by the client under the wire domain. */
const stateRequest = (host) => wireSignedRequest(host, STATE_PATH, { transportIdentity: { jobId: JOB } }, { jobId: JOB, agreementHash: sha256Hex('kit-client-agreement') });

test("K12-H6a today: the composed kit host refuses a request signed under the old domain; only the wire domain is accepted (peer_signature_invalid)", async (t) => {
  const { host } = await composedKitHost(t);
  const { payload, text } = await stateRequest(host);
  const answer = await postHeader(host, STATE_PATH, headerSignedUnder(OLD_DOMAIN, payload, hostBuyer), text);
  assert.deepEqual({ status: answer.status, error: JSON.parse(answer.text).error, signed: answer.signed }, { status: 401, error: 'peer_signature_invalid', signed: false });
});

test('K12-H6a control: the composed kit host authenticates the same request signed under the wire domain', async (t) => {
  const { host } = await composedKitHost(t);
  const { header, text } = await stateRequest(host);
  const answer = await postHeader(host, STATE_PATH, header, text);
  assert.deepEqual({ status: answer.status, error: JSON.parse(answer.text).error, signed: answer.signed }, { status: 404, error: 'peer_unknown_job', signed: true });
});


test("K12-H6b today: the client's request signer emits old-domain signing bytes", async (t) => {
  const { stateRequest } = await sellerTransportPair(t);
  const envelope = decodeHeader((await stateRequest()).header);
  assert.equal(verifiesUnder(OLD_DOMAIN, envelope), true);
  assert.equal(verifiesUnder(DACS_SELLER_HTTP_DOMAINS.request, envelope), false);
});

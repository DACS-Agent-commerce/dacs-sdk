// K12-H6a / K12-H6b: the signing domain of the seller transport, as the kit's server auth and the client's signer each use it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_DOMAINS, DACS_SELLER_HTTP_PATHS } from '@kynesyslabs/dacs/wire';
import { buyer as hostBuyer } from '../../packages/dacs-seller/test/helpers/protocol-fixture.mjs';
import { BUYER, JOB } from './fixtures.mjs';
import { composedKitHost, postHeader, wireSignedRequest } from './kit-host.mjs';

const OLD_DOMAIN = 'dacs-chatgpt-plugin:loopback-seller-peer:v1:';

const signedUnder = (domain, payload) => Buffer.from(domain + canonicalize(payload), 'utf8');
/** The header the client would send if `wallet` signed the same payload under `domain`. */
const headerSignedUnder = (domain, payload, wallet = BUYER) => Buffer.from(canonicalize({ payload, signature: wallet.signBytes(signedUnder(domain, payload)).toString('base64url') })).toString('base64url');

// Flipped by P11a1a (the signed routes on `./wire`): the kit's composed host takes the wire domain only on the routes the wire opens.
const STATE_PATH = DACS_SELLER_HTTP_PATHS.state;
/** A state request for a job the host holds nothing for, signed by the client under the wire domain. */
const stateRequest = (host) => wireSignedRequest(host, STATE_PATH, { transportIdentity: { jobId: JOB } }, { jobId: JOB, agreementHash: sha256Hex('kit-client-agreement') });

test("K12-H6a target: the composed kit host refuses a request signed under the old domain; only the wire domain is accepted (peer_signature_invalid)", async (t) => {
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

test("K12-H6b target: the client's request signer output carries the wire domain only", async (t) => {
  const { world, request } = await import('../../packages/dacs-client/test/helpers/wire-client-fixture.mjs');
  const w = await world(t);
  const signed = await request(w);
  const bytes = w.state.signs[0].toString();
  assert.equal(bytes, DACS_SELLER_HTTP_DOMAINS.request + canonicalize(signed.payload));
  assert.equal(bytes.startsWith(OLD_DOMAIN), false);
});

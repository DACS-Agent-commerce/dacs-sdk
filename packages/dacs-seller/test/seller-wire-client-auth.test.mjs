// The kit's buyer-side wire signer, `createSellerWireClientAuth`: it signs the routes the host answers through `./wire`
// (a TP-1 profile in every request) and verifies their answers, where `createSellerTransportClientAuth` signs under the
// old domain with no profile. The unit cases sign against the fixture binding (helpers/wire-buyer.mjs supplies the
// binding and the verified endpoint proof only); the running-host cases go through `createSellerAgentClient`.
//
// The running-host cases need a runner where `/` is root-owned (K5-J0).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_DOMAINS, DACS_SELLER_HTTP_PATHS, openWireEnvelope } from '@kynesyslabs/dacs/wire';
import { fixtureListing } from './fixtures/listings.mjs';
import { commitmentFixture } from './helpers/commitment-fixture.mjs';
import { NOW, buyer, seller, testWallet } from './helpers/protocol-fixture.mjs';
import { testNetwork } from './helpers/wire-authority-fixture.mjs';
import { FIXTURE_ENDPOINT, wireBuyer } from './helpers/wire-buyer.mjs';
import { startSellerHost } from '../src/host.mjs';
import { listingPin } from '../src/dacs/purchase-protocol.mjs';
import { createSellerAgentClient } from '../src/dacs/seller-http.mjs';
import { SELLER_CONTEXT_PATH } from '../src/dacs/seller-transport-auth.mjs';
import { createSellerWireClientAuth } from '../src/dacs/seller-wire-client-auth.mjs';

const PATHS = DACS_SELLER_HTTP_PATHS;
const BUYER = { claim: buyer.claim, sign: buyer.signBytes };
const SELLER = { claim: seller.claim, sign: seller.signBytes };
const PIN = listingPin(fixtureListing(seller, { now: NOW }));
const JOB = '01M5YKPJG0248H248H248H248H';
const AGREEMENT_HASH = sha256Hex('seller-wire-client-auth:agreement');
const OTHER_HASH = sha256Hex('seller-wire-client-auth:other');
const MOVED_ROUTES = [PATHS.proposals, PATHS.state, PATHS.commitments, PATHS.commitmentSignature];
const CLIENT_TIMEOUT_MS = 60_000;
const SESSION_LEAD_MS = 30_000;
const SESSION_LIFETIME_MS = 3_600_000;

/** A wire client auth for `pin` over the fixture binding, with the signer's calls counted. */
async function wireClient({ pin = PIN, agreementHash = AGREEMENT_HASH, ...overrides } = {}) {
  const { binding, connection, endpointProof } = await wireBuyer({ buyer: BUYER, seller: SELLER, listingPin: pin, clock: () => NOW });
  const signs = { calls: 0 };
  const signer = { claim: BUYER.claim, sign: (bytes) => { signs.calls++; return BUYER.sign(bytes); } };
  const options = { signer, binding, connection, endpointProof, publicEndpoint: FIXTURE_ENDPOINT, seller: seller.claim, resolveJob: () => ({ listingPin: pin, agreementHash }), now: () => NOW, ...overrides };
  return { auth: createSellerWireClientAuth(options), binding, connection, signs, options };
}
const bodyFor = (path) => (path === PATHS.state || path === PATHS.proposals ? { transportIdentity: { jobId: JOB } } : { jobId: JOB });
const openedAs = ({ binding, connection }, header, options = {}) => openWireEnvelope(header, 'request', { binding, local: connection(), purchaseProfile: null, requireDelegation: false, ...options });

test('each moved route is signed under the wire domain with the binding\'s TP-1 profile, and the wire opens it', async () => {
  const client = await wireClient();
  for (const path of MOVED_ROUTES) {
    const text = JSON.stringify(bodyFor(path));
    const { payload, header } = await client.auth.request(path, bodyFor(path), text);
    const opened = await openedAs(client, header);
    assert.deepEqual(opened.payload, payload, path);
    assert.deepEqual({ path: payload.path, profile: payload.profile, bodyHash: payload.bodyHash, buyer: payload.buyer, seller: payload.seller }, { path, profile: client.binding.profile, bodyHash: sha256Hex(text), buyer: buyer.claim, seller: seller.claim }, path);
  }
});

test('the signed body hash is over the exact text given, not a rebuilt copy of the body', async () => {
  const client = await wireClient();
  const text = `  ${JSON.stringify(bodyFor(PATHS.state))}\n`;
  const { payload } = await client.auth.request(PATHS.state, bodyFor(PATHS.state), text);
  assert.equal(payload.bodyHash, sha256Hex(text));
});

test('the Listing pin and Agreement hash are the approved job\'s, never a member of the body', async () => {
  const client = await wireClient();
  const body = { transportIdentity: { jobId: JOB, agreementHash: OTHER_HASH }, agreementHash: OTHER_HASH, listingPin: { ...PIN, version: 'other' } };
  const { payload } = await client.auth.request(PATHS.state, body, JSON.stringify(body));
  assert.deepEqual({ agreementHash: payload.agreementHash, listingPin: payload.listingPin }, { agreementHash: AGREEMENT_HASH, listingPin: PIN });
});

test('what evidenceFor returns can add the purchase evidence members only: it cannot replace the signer or the binding', async () => {
  const stranger = testWallet(4);
  const client = await wireClient({ evidenceFor: async () => ({ signer: { claim: stranger.claim, sign: stranger.signBytes }, binding: null, publicEndpoint: 'https://other.example.invalid' }) });
  const { payload, header } = await client.auth.request(PATHS.state, bodyFor(PATHS.state), JSON.stringify(bodyFor(PATHS.state)));
  assert.equal(payload.buyer, buyer.claim);
  assert.deepEqual((await openedAs(client, header)).payload, payload);
  assert.equal(client.signs.calls, 1);
});

test('a connection changed after binding refuses to sign: the signer is never called', async () => {
  let moved = false;
  const client = await wireClient({ connection: () => ({ endpoint: 'https://rpc.example.invalid/', transportAuthority: 'vector-authority', connectionId: moved ? 'other-conn' : 'vector-conn-1' }) });
  await client.auth.request(PATHS.state, bodyFor(PATHS.state), JSON.stringify(bodyFor(PATHS.state)));
  const signedBefore = client.signs.calls;
  moved = true;
  await assert.rejects(client.auth.request(PATHS.state, bodyFor(PATHS.state), JSON.stringify(bodyFor(PATHS.state))), { code: 'tp1_local_binding_changed' });
  assert.equal(client.signs.calls, signedBefore);
});

test('a session signer with the buyer\'s delegation signs as the buyer and embeds the delegation', async () => {
  const session = testWallet(3);
  const client = await wireClient();
  const delegationPayload = { version: '1', kind: 'seller-session-delegation', buyer: buyer.claim, seller: seller.claim, sessionPublicKey: session.claim.slice('did:demos:agent:'.length), listingPin: PIN, jobId: JOB,
    notBefore: NOW - SESSION_LEAD_MS, expiresAt: NOW + SESSION_LIFETIME_MS, profile: client.binding.profile };
  const delegation = { payload: delegationPayload, signature: BUYER.sign(Buffer.from(DACS_SELLER_HTTP_DOMAINS.delegation + canonicalize(delegationPayload))).toString('base64url') };
  const delegated = createSellerWireClientAuth({ ...client.options, signer: { claim: session.claim, sign: session.signBytes }, delegation });
  const { payload, header } = await delegated.request(PATHS.state, bodyFor(PATHS.state), JSON.stringify(bodyFor(PATHS.state)));
  assert.equal(payload.buyer, buyer.claim);
  assert.deepEqual((await openedAs(client, header, { requireDelegation: true })).payload, payload);
});

test('a route the wire does not carry goes to the fallback auth, and a wire route never does', async () => {
  const calls = [];
  const fallback = { request: async (path) => { calls.push(['request', path]); return { payload: { fallback: true }, header: 'fallback-header' }; }, verifyResponse: (request) => { calls.push(['verify', request.fallback === true]); return { fallback: true }; } };
  const client = await wireClient({ fallback });
  const challenge = await client.auth.request(SELLER_CONTEXT_PATH, { scope: { jobId: JOB } }, '{}');
  assert.deepEqual(calls, [['request', SELLER_CONTEXT_PATH]]);
  assert.deepEqual(await client.auth.verifyResponse(challenge.payload, { header: 'any', status: 200, text: '{}', responseBytes: Buffer.from('{}') }), { fallback: true });
  assert.equal(calls.length, 2);
  const wired = await client.auth.request(PATHS.state, bodyFor(PATHS.state), JSON.stringify(bodyFor(PATHS.state)));
  assert.equal(calls.length, 2, 'the wire request reached no fallback');
  await assert.rejects(client.auth.verifyResponse(wired.payload, { header: 'not-a-wire-header', status: 200, text: '{}', responseBytes: Buffer.from('{}') }));
  assert.equal(calls.length, 2, 'a wire route\'s answer is verified by the wire only');
});

test('a route the wire does not carry, with no fallback, is refused before anything is signed', async () => {
  const client = await wireClient();
  await assert.rejects(client.auth.request(SELLER_CONTEXT_PATH, { scope: { jobId: JOB } }, '{}'), { code: 'wire_client_route_unsupported' });
  assert.equal(client.signs.calls, 0);
});

test('a request for a path outside the kit\'s routes is refused even with a fallback that would sign it', async () => {
  const client = await wireClient({ fallback: { request: async () => assert.fail('the fallback signed it'), verifyResponse: () => assert.fail('the fallback verified it') } });
  await assert.rejects(client.auth.request('/dacs/v1/unknown', { jobId: JOB }, '{}'), { code: 'wire_client_route_unsupported' });
  assert.equal(client.signs.calls, 0);
});

test('a configuration with a missing binding, endpoint proof, seller or job resolver is refused at construction', async () => {
  const { options } = await wireClient();
  for (const [name, value] of [['binding', null], ['endpointProof', undefined], ['seller', undefined], ['resolveJob', undefined], ['connection', undefined], ['publicEndpoint', 'http://seller.example.invalid'], ['signer', { claim: BUYER.claim }]]) {
    assert.throws(() => createSellerWireClientAuth({ ...options, [name]: value }), /configuration is invalid/, name);
  }
});

async function runningHost(t) {
  const f = await commitmentFixture(t);
  const dataDirectory = await mkdtemp(join(tmpdir(), 'TEST-wire-client-auth-'));
  const { durableDirectory, commitOnSignature, nativeArtifactAnchor, ...config } = f.config;
  const host = await startSellerHost({ ...config, artifactAnchor: nativeArtifactAnchor, dataDirectory, tp1Network: testNetwork() });
  t.after(async () => { await host.close(); await rm(dataDirectory, { recursive: true, force: true }); });
  return { f, host };
}

test('a kit client with the shipped wire auth proposes to a running host and reads the state back, each answer verified', async (t) => {
  const { f, host } = await runningHost(t);
  const request = await f.proposal(host);
  const { auth } = await wireClient({ pin: host.listingPin, agreementHash: request.proposal.plan.agreementHash });
  const client = createSellerAgentClient({ url: host.url, authentication: auth, timeoutMs: CLIENT_TIMEOUT_MS });
  assert.equal((await client.propose(request)).disposition, 'complete');
  assert.equal(typeof await client.agreementState(request.transportIdentity), 'object');
});

test('an answer whose body was changed after the seller signed it is refused as a response-auth failure', async (t) => {
  const { f, host } = await runningHost(t);
  const request = await f.proposal(host);
  const { auth } = await wireClient({ pin: host.listingPin, agreementHash: request.proposal.plan.agreementHash });
  const tampering = async (url, init) => {
    const response = await fetch(url, init);
    const text = (await response.text()).replace('"complete"', '"complet3"');
    return new Response(text, { status: response.status, headers: response.headers });
  };
  const client = createSellerAgentClient({ url: host.url, authentication: auth, timeoutMs: CLIENT_TIMEOUT_MS, fetchImpl: tampering });
  await assert.rejects(client.propose(request), { name: 'SellerUnavailableError' });
  assert.equal(client.failureCause, 'response-auth');
});

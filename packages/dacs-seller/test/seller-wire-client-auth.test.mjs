// The kit's buyer-side wire signer, `createSellerWireClientAuth`: it signs the routes the host answers through `./wire`
// (a TP-1 profile in every request) and verifies their answers. The unit cases sign against the fixture binding
// (helpers/wire-buyer.mjs supplies the binding and the verified endpoint proof only); the running-host cases go through
// `createSellerAgentClient`.
//
// The running-host cases need a runner where `/` is root-owned (K5-J0).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize, identityBundleHash, sha256Hex } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_DOMAINS, DACS_SELLER_HTTP_PATHS, openWireEnvelope } from '@kynesyslabs/dacs/wire';
import { fixtureListing } from './fixtures/listings.mjs';
import { commitmentFixture } from './helpers/commitment-fixture.mjs';
import { presentationFor } from './helpers/context-wire-world.mjs';
import { contextHostFixture } from './helpers/host-context-client.mjs';
import { ORCHESTRATOR_MODE } from './helpers/proposal-admission-fixture.mjs';
import { NOW, buyer, seller, testWallet } from './helpers/protocol-fixture.mjs';
import { authorityReader, testNetwork } from './helpers/wire-authority-fixture.mjs';
import { FIXTURE_ENDPOINT, wireBuyer } from './helpers/wire-buyer.mjs';
import { startSellerHost } from '../src/host.mjs';
import { listingPin } from '../src/dacs/purchase-protocol.mjs';
import { createSellerAgentClient } from '../src/dacs/seller-http.mjs';
import { createSellerWireClientAuth } from '../src/dacs/seller-wire-client-auth.mjs';
import { fetchAsHost, proxyListener } from './helpers/listener-host.mjs';

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
async function wireClient({ pin = PIN, agreementHash = AGREEMENT_HASH, readAuthority, ...overrides } = {}) {
  const { binding, connection, endpointProof } = await wireBuyer({ buyer: BUYER, seller: SELLER, listingPin: pin, clock: () => NOW, ...(readAuthority === undefined ? {} : { readAuthority }) });
  const signs = { calls: 0 };
  const signer = { claim: BUYER.claim, sign: (bytes) => { signs.calls++; return BUYER.sign(bytes); } };
  const options = { signer, binding, connection, endpointProof, publicEndpoint: FIXTURE_ENDPOINT, seller: seller.claim, resolveJob: () => ({ listingPin: pin, agreementHash }), now: () => NOW, ...overrides };
  return { auth: createSellerWireClientAuth(options), binding, connection, signs, options };
}
const CONTEXT_ROUTES = [PATHS.contextChallenge, PATHS.context];
function bodyFor(path) {
  if (CONTEXT_ROUTES.includes(path)) return { scope: { jobId: JOB, listingPin: PIN } };
  return path === PATHS.state || path === PATHS.proposals ? { transportIdentity: { jobId: JOB } } : { jobId: JOB };
}
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

test('an answer is verified by the wire, and an answer that is not signed by it is refused', async () => {
  const client = await wireClient();
  const wired = await client.auth.request(PATHS.state, bodyFor(PATHS.state), JSON.stringify(bodyFor(PATHS.state)));
  await assert.rejects(client.auth.verifyResponse(wired.payload, { header: 'not-a-wire-header', status: 200, responseBytes: Buffer.from('{}') }));
});

test('the challenge and context routes are signed under the wire domain with the binding\'s profile and the scope hash, and the wire opens them', async () => {
  const client = await wireClient();
  for (const path of CONTEXT_ROUTES) {
    const body = bodyFor(path);
    const text = JSON.stringify(body);
    const { payload, header } = await client.auth.request(path, body, text);
    const opened = await openedAs(client, header);
    assert.deepEqual(opened.payload, payload, path);
    assert.deepEqual({ path: payload.path, jobId: payload.jobId, profile: payload.profile, bodyHash: payload.bodyHash, agreementHash: payload.agreementHash, listingPin: payload.listingPin },
      { path, jobId: JOB, profile: client.binding.profile, bodyHash: sha256Hex(text), agreementHash: sha256Hex(canonicalize(body.scope)), listingPin: PIN }, path);
  }
});

test('the scope hash of a context request is the body\'s own, not the job lookup\'s Agreement hash', async () => {
  const client = await wireClient({ agreementHash: OTHER_HASH });
  const body = bodyFor(PATHS.context);
  const { payload } = await client.auth.request(PATHS.context, body, JSON.stringify(body));
  assert.equal(payload.agreementHash, sha256Hex(canonicalize(body.scope)));
});

test('an answer to a context route is verified by the wire, and an answer that is not signed by it is refused', async () => {
  const client = await wireClient();
  const body = bodyFor(PATHS.contextChallenge);
  const signed = await client.auth.request(PATHS.contextChallenge, body, JSON.stringify(body));
  await assert.rejects(client.auth.verifyResponse(signed.payload, { header: 'not-a-wire-header', status: 200, text: '{}', responseBytes: Buffer.from('{}') }));
});

test('a context request without a canonical job in its scope is refused before anything is looked up or signed', async () => {
  let lookups = 0;
  const client = await wireClient({ resolveJob: () => { lookups++; return { listingPin: PIN, agreementHash: AGREEMENT_HASH }; } });
  for (const body of [{}, { scope: null }, { scope: { jobId: 'not-a-job' } }, { jobId: JOB }]) {
    await assert.rejects(client.auth.request(PATHS.context, body, JSON.stringify(body)), { code: 'peer_job_invalid' }, JSON.stringify(body));
  }
  assert.equal(lookups, 0);
  assert.equal(client.signs.calls, 0);
});

test('a request for a path outside the kit\'s routes is refused before anything is signed', async () => {
  const client = await wireClient();
  await assert.rejects(client.auth.request('/dacs/v1/unknown', { jobId: JOB }, '{}'), { code: 'wire_client_route_unsupported' });
  assert.equal(client.signs.calls, 0);
});

test('a configuration with a missing binding, endpoint proof, seller or job resolver is refused at construction', async () => {
  const { options } = await wireClient();
  for (const [name, value] of [['binding', null], ['endpointProof', undefined], ['seller', undefined], ['resolveJob', undefined], ['connection', undefined], ['publicEndpoint', 'http://seller.example.invalid'], ['signer', { claim: BUYER.claim }]]) {
    assert.throws(() => createSellerWireClientAuth({ ...options, [name]: value }), /configuration is invalid/, name);
  }
});

const STALLED = () => new Promise(() => {});
const SIGNING_TIMEOUT_MS = 20;

test('a stalled authority read, job lookup or evidence lookup ends as a signing timeout before anything is signed', async () => {
  let authorityStalled = false;
  const readAuthority = (scope) => (authorityStalled ? STALLED() : authorityReader()(scope));
  const cases = [
    ['authority reader', PATHS.state, { readAuthority }, () => { authorityStalled = true; }],
    ['resolveJob', PATHS.state, { resolveJob: STALLED }],
    ['evidenceFor', PATHS.state, { evidenceFor: STALLED }],
    ['resolveJob on a context route', PATHS.context, { resolveJob: STALLED }],
  ];
  for (const [name, path, overrides, stall = () => {}] of cases) {
    const client = await wireClient({ ...overrides, signingTimeoutMs: SIGNING_TIMEOUT_MS });
    stall();
    await assert.rejects(client.auth.request(path, bodyFor(path), JSON.stringify(bodyFor(path))), { name: 'WireError', code: 'wire_client_signing_timeout', status: 500 }, name);
    assert.equal(client.signs.calls, 0, name);
  }
});

test('a client whose signing stalls ends before dispatch as an unavailable seller, with no request sent', async () => {
  const sent = [];
  const client = await wireClient({ resolveJob: STALLED, signingTimeoutMs: SIGNING_TIMEOUT_MS });
  const agent = createSellerAgentClient({ url: 'http://127.0.0.1:9', authentication: client.auth, timeoutMs: CLIENT_TIMEOUT_MS, fetchImpl: async (...args) => { sent.push(args); return new Response('{}'); } });
  await assert.rejects(agent.agreementState({ jobId: JOB }), { name: 'SellerUnavailableError' });
  assert.equal(sent.length, 0);
});

test('a signing deadline that is not a timer-sized integer is refused at construction', async () => {
  const { options } = await wireClient();
  for (const value of [0, -1, 1.5, '20', null, Number.POSITIVE_INFINITY, 2 ** 31]) {
    assert.throws(() => createSellerWireClientAuth({ ...options, signingTimeoutMs: value }), /configuration is invalid/, String(value));
  }
});

async function runningHost(t) {
  const f = await commitmentFixture(t, { vetMode: ORCHESTRATOR_MODE, publicEndpoint: FIXTURE_ENDPOINT });
  const dataDirectory = await mkdtemp(join(tmpdir(), 'TEST-wire-client-auth-'));
  const { nativeArtifactAnchor, ...config } = f.config;
  delete config.challengeLedger; // the host builds its own ledger
  delete config.durableDirectory;
  delete config.commitOnSignature;
  delete config.vetMode;
  const host = await startSellerHost({ ...config, artifactAnchor: nativeArtifactAnchor, dataDirectory, tp1Network: testNetwork(), listener: proxyListener() });
  t.after(async () => { await host.close(); await rm(dataDirectory, { recursive: true, force: true }); });
  return { f, host };
}

test('a kit client with the shipped wire auth proposes to a running host and reads the state back, each answer verified', async (t) => {
  const { f, host } = await runningHost(t);
  const request = await f.proposal(host);
  const { auth } = await wireClient({ pin: host.listingPin, agreementHash: request.proposal.plan.agreementHash });
  const client = createSellerAgentClient({ url: host.url, authentication: auth, timeoutMs: CLIENT_TIMEOUT_MS, fetchImpl: fetchAsHost() });
  assert.equal((await client.propose(request)).disposition, 'complete');
  assert.equal(typeof await client.agreementState(request.transportIdentity), 'object');
});

test('an answer whose body was changed after the seller signed it is refused as a response-auth failure', async (t) => {
  const { f, host } = await runningHost(t);
  const request = await f.proposal(host);
  const { auth } = await wireClient({ pin: host.listingPin, agreementHash: request.proposal.plan.agreementHash });
  const tampering = async (url, init) => {
    const response = await fetchAsHost()(url, init);
    const text = (await response.text()).replace('"complete"', '"complet3"');
    return new Response(text, { status: response.status, headers: response.headers });
  };
  const client = createSellerAgentClient({ url: host.url, authentication: auth, timeoutMs: CLIENT_TIMEOUT_MS, fetchImpl: tampering });
  await assert.rejects(client.propose(request), { name: 'SellerUnavailableError' });
  assert.equal(client.failureCause, 'response-auth');
});

test('a kit client with the shipped wire auth gets a challenge and the context answer from a running host, each answer verified', async (t) => {
  const f = await contextHostFixture(t);
  const host = await f.start();
  const { scopeFor } = await f.buyerFor(host);
  const session = testWallet(99);
  const base = await wireClient({ pin: host.listingPin });
  const delegationPayload = { version: '1', kind: 'seller-session-delegation', buyer: buyer.claim, seller: seller.claim, sessionPublicKey: session.claim.slice('did:demos:agent:'.length), listingPin: host.listingPin, jobId: JOB,
    notBefore: NOW - SESSION_LEAD_MS, expiresAt: NOW + SESSION_LIFETIME_MS, profile: base.binding.profile };
  const delegation = { payload: delegationPayload, signature: BUYER.sign(Buffer.from(DACS_SELLER_HTTP_DOMAINS.delegation + canonicalize(delegationPayload))).toString('base64url') };
  const authentication = createSellerWireClientAuth({ ...base.options, signer: { claim: session.claim, sign: session.signBytes }, delegation });
  const client = createSellerAgentClient({ url: host.url, authentication, timeoutMs: CLIENT_TIMEOUT_MS, fetchImpl: fetchAsHost() });
  const scope = scopeFor(JOB);
  const { sessionNonce } = await client.contextChallenge({ scope });
  const bundle = presentationFor(buyer, sessionNonce, NOW);
  const answer = await client.agreementContext({ scope: { ...scope, buyerBundleHash: identityBundleHash(bundle) }, buyerIdentityBundle: bundle });
  assert.equal(answer.disposition, 'present');
});

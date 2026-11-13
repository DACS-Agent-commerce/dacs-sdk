// The seller serves its signed discovery document and answers state reads through the read-only signing role.
// Each case runs the handler over a real transport store and a bound TP-1 profile (helpers/wire-routes-world.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from '@kynesyslabs/dacs';
import { DACS_SELLER_DISCOVERY_PATH } from '@kynesyslabs/dacs/wire';
import { exchange } from './helpers/d5-http-fixture.mjs';
import { seller } from './helpers/protocol-fixture.mjs';
import { FIXTURE_ENDPOINT } from './helpers/wire-buyer.mjs';
import { CLAIM_PREFIX, MAX_BODY_BYTES, MAX_HEADER_CHARS, PATHS, SELLER, derive, identityBody, proposeJob, world } from './helpers/wire-routes-world.mjs';
import { SELLER_TRANSPORT_HEADER } from '../src/dacs/seller-transport-auth.mjs';

const OLD_PIN_VERSION = 'dacs-demos-testnet-identity/2026-10-15';
const fetchDiscovery = (w, options = {}) => exchange(w.handle.handler, { url: DACS_SELLER_DISCOVERY_PATH, method: 'GET', text: '', ...options });
const refusalOf = (answer) => ({ status: answer.status, error: answer.body.error, signed: answer.signed });

/** A seller signer with the read-only role: the effect `sign` and each minted role are counted. */
const roleSigner = () => {
  const calls = { effect: 0, roles: [] };
  return Object.assign({ calls }, { claim: SELLER.claim,
    sign: (bytes) => { calls.effect++; return SELLER.sign(bytes); },
    readOnlyAnswerSigner: async (request) => { calls.roles.push({ purpose: request.purpose, body: request.body }); return { claim: SELLER.claim, sign: async (bytes) => SELLER.sign(bytes) }; } });
};

test('discovery is served at its well-known path as signed bytes that the buyer\'s endpoint proof accepts, naming the seller, endpoint, Listing and readiness', async (t) => {
  const w = await world(t);
  const answer = await fetchDiscovery(w);
  assert.equal(answer.status, 200);
  assert.equal(answer.headers['content-type'], 'application/json');
  assert.equal(answer.headers[SELLER_TRANSPORT_HEADER], undefined, 'the document carries its own signature, not a response envelope');
  const proof = await w.buyerWire.verifyDiscovery(Buffer.from(answer.text));
  assert.deepEqual({ seller: proof.payload.seller, endpoint: proof.payload.publicEndpoint, ready: proof.ready }, { seller: seller.claim, endpoint: FIXTURE_ENDPOINT, ready: true });
  assert.deepEqual(proof.payload.listings, [w.agent.listingPin]);
  assert.deepEqual(proof.payload.profile, w.buyerWire.binding.profile);
  assert.equal(w.effects() + w.rows().peer_effects, 0, 'discovery reserves nothing and calls no agent');
});

test('discovery says not ready once the seller stops taking purchases', async (t) => {
  const w = await world(t);
  w.state.ready = false;
  const proof = await w.buyerWire.verifyDiscovery(Buffer.from((await fetchDiscovery(w)).text));
  assert.equal(proof.ready, false);
});

test('discovery is signed through the read-only role for discovery and never through the effect signer', async (t) => {
  const w = await world(t);
  const signer = roleSigner();
  await w.withWire({ signer }, async () => {
    const answer = await fetchDiscovery(w);
    assert.equal(answer.status, 200);
    await w.buyerWire.verifyDiscovery(Buffer.from(answer.text));
  });
  assert.deepEqual(signer.calls, { effect: 0, roles: [{ purpose: 'discovery', body: undefined }] });
});

test('discovery refuses another method and a request that carries a body, with nothing signed', async (t) => {
  const w = await world(t);
  const cases = [['POST', {}, 405, 'method_not_allowed'], ['GET', { headers: { 'content-length': '2' } }, 413, 'body_too_large'], ['GET', { headers: { 'transfer-encoding': 'chunked' } }, 413, 'body_too_large']];
  for (const [method, options, status, error] of cases) {
    const answer = await fetchDiscovery(w, { method, ...options });
    assert.deepEqual({ status: answer.status, error: JSON.parse(answer.text).error }, { status, error }, `${method} ${JSON.stringify(options)}`);
  }
  assert.equal(w.signing.calls, 0);
});

test('a discovery document the wire refuses to sign is answered with the wire\'s own code and no document', async (t) => {
  const w = await world(t);
  await w.withWire({ publicEndpoint: 'http://seller.example.invalid' }, async () => {
    const answer = await fetchDiscovery(w);
    assert.deepEqual({ status: answer.status, error: JSON.parse(answer.text).error }, { status: 500, error: 'discovery_invalid' });
  });
  assert.equal(w.signing.calls, 0);
});

test('a connection changed after binding refuses discovery with nothing signed', async (t) => {
  const w = await world(t);
  w.state.connection = { ...w.state.connection, connectionId: 'another-connection' };
  const answer = await fetchDiscovery(w);
  assert.ok(answer.status >= 400, `refused, not ${answer.status}`);
  assert.equal(w.signing.calls, 0);
});

test('a host given no public endpoint serves no discovery document', async (t) => {
  const w = await world(t);
  await w.withWire({ publicEndpoint: null }, async () => {
    const answer = await fetchDiscovery(w);
    assert.deepEqual({ status: answer.status, error: JSON.parse(answer.text).error }, { status: 404, error: 'not_found' });
  });
});

test('a state read is signed through the read-only role for read answers, and the buyer verifies it', async (t) => {
  const w = await world(t);
  const job = await proposeJob(w, 'role-read');
  assert.equal((await job.post()).status, 200);
  const signer = roleSigner();
  await w.withWire({ signer }, async () => {
    const answer = await w.post(PATHS.state, identityBody(job.jobId, job.agreementHash), { jobId: job.jobId, agreementHash: job.agreementHash });
    assert.equal(answer.status, 200);
    await w.verified(answer);
    assert.deepEqual(signer.calls, { effect: 0, roles: [{ purpose: 'read-answer', body: answer.text }] }, 'the role signed the exact answer text');
  });
});

test('an effect route answer is signed with the effect signer, never the read-only role', async (t) => {
  const w = await world(t);
  const job = await proposeJob(w, 'role-effect');
  const signer = roleSigner();
  await w.withWire({ signer }, async () => {
    const answer = await job.post();
    assert.equal(answer.status, 200);
    await w.verified(answer);
  });
  assert.deepEqual({ roles: signer.calls.roles, effectSigned: signer.calls.effect > 0 }, { roles: [], effectSigned: true });
});

test('a read answer the role refuses to sign is answered as a refusal, never as the state', async (t) => {
  const w = await world(t);
  const job = await proposeJob(w, 'role-refused');
  assert.equal((await job.post()).status, 200);
  const signer = roleSigner();
  signer.readOnlyAnswerSigner = async () => ({ claim: SELLER.claim, sign: async () => { throw new Error('TEST role refused'); } });
  await w.withWire({ signer }, async () => {
    const answer = await w.post(PATHS.state, identityBody(job.jobId, job.agreementHash), { jobId: job.jobId, agreementHash: job.agreementHash });
    assert.equal(answer.status, 503);
    assert.notEqual(answer.body.error, undefined, 'the answer is a refusal, not the state');
    assert.equal(answer.body.jobId, undefined);
  });
});

test('on the state route a bad envelope, another binding, another seller and an oversized request are each refused with nothing reserved or written', async (t) => {
  const w = await world(t);
  const job = await proposeJob(w, 'state-refusals');
  const body = identityBody(job.jobId, job.agreementHash);
  const signed = await w.buyerWire.signRequest(PATHS.state, body, { jobId: job.jobId, agreementHash: job.agreementHash });
  const altered = (change) => { const envelope = JSON.parse(Buffer.from(signed.header, 'base64url')); change(envelope.payload); return { text: signed.text, header: Buffer.from(canonicalize(envelope)).toString('base64url') }; };
  const otherSeller = w.payloadFor(PATHS.state, signed.text, { jobId: job.jobId, agreementHash: job.agreementHash, seller: `${CLAIM_PREFIX}${derive('seller-two')}` });
  const cases = [
    ['a header past the limit', { text: signed.text, header: 'A'.repeat(MAX_HEADER_CHARS + 1) }, { status: 401, error: 'peer_envelope_invalid', signed: false }],
    ['another pin version', altered((payload) => { payload.profile.pinVersion = OLD_PIN_VERSION; }), { status: 409, error: 'tp1_profile_mismatch', signed: false }],
    ['another seller', { text: signed.text, header: w.headerFor(otherSeller) }, { status: 401, error: 'peer_audience_wrong', signed: false }],
    ['a body past the limit', { text: 'x'.repeat(MAX_BODY_BYTES + 1), header: signed.header }, { status: 413, error: 'body_too_large', signed: false }],
  ];
  const before = w.rows(), filesBefore = w.journalFiles();
  for (const [name, request, expected] of cases) assert.deepEqual(refusalOf(await w.send(PATHS.state, request)), expected, name);
  assert.deepEqual({ rows: w.rows(), files: w.journalFiles(), effects: w.effects() }, { rows: before, files: filesBefore, effects: 0 });
});

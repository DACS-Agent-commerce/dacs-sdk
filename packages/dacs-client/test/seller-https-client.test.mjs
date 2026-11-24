// The seller HTTPS client against a real loopback TLS seller: Node's own request, TLS and response parsing run
// through the pinned connector, with only the admitted address mapped to loopback and the test CA trusted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { admitRawJson, canonicalize } from '@kynesyslabs/dacs';
import * as wire from '@kynesyslabs/dacs/wire';
import { world, validReceipt, JOB } from './helpers/wire-client-fixture.mjs';
import { committedPurchase } from './helpers/wire-committed-purchase.mjs';
import { bodyFor } from './helpers/stored-request-fixture.mjs';
import { startHttpsSeller, SELLER_HOST, NO_TRANSMIT_GUARDS } from './helpers/seller-https-rig.mjs';
import { createSellerHttpsConnector } from '../src/dacs/seller-https-connector.mjs';
// The fixture installs the admission double, so the modules that read admission state load after it.
const { createSellerHttpsClient, SellerRefusedError, SellerUnavailableError } = await import('../src/dacs/seller-http.mjs');

const PATHS = wire.DACS_SELLER_HTTP_PATHS;
const PEER_HEADER = wire.DACS_SELLER_HTTP_HEADER;
const MAX_BYTES = wire.DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes;
const JSON_TYPE = { 'content-type': 'application/json' };
const TX_HASH = 'a'.repeat(64);
const corpus = JSON.parse(readFileSync(new URL('../../../test/fixtures/standard-next/raw-json-profile-v0.1.json', import.meta.url)));

// A seller that answers from `handler(res, record, answer)`; `answer(status, text)` sends a wire-signed reply.
async function sellerRig(t, handler, clientOptions = {}) {
  let w;
  const answer = async (res, record, status, text) => {
    const { payload } = JSON.parse(Buffer.from(record.headers[PEER_HEADER], 'base64url'));
    const header = await wire.signWireResponse(payload, status, text, { signer: w.seller, binding: w.binding, local: w.local, purchaseProfile: w.binding.profile, now: w.state.time });
    res.writeHead(status, { ...JSON_TYPE, 'content-length': Buffer.byteLength(text), [PEER_HEADER]: header });
    res.end(text);
  };
  const seller = await startHttpsSeller(t, (_req, res, record) => { Promise.resolve(handler(res, record, (status, text) => answer(res, record, status, text), w)).catch(() => res.destroy()); });
  const made = await committedPurchase({ jobId: JOB, publicEndpoint: seller.origin });
  w = await world(t, { pin: made.pin, agreementHash: made.agreementHash, readCommitmentReceipt: validReceipt, publicEndpoint: seller.origin });
  const bytes = (value) => Buffer.from(canonicalize(value));
  const verifications = [];
  const base = w.createSellerWireAuthentication({ ...w.options, evidence: async () => ({ commitment: bytes(made.anchored), agreement: bytes(made.agreement), signedListing: bytes(made.listing) }) });
  const authentication = { request: (...args) => base.request(...args), verifyResponse: (...args) => { verifications.push(args); return base.verifyResponse(...args); },
    resumeProof: (...args) => base.resumeProof(...args) };
  const sends = [];
  // `route(connector)` may swap the connector that a send reaches; every send is recorded first.
  const connectorFor = (route = (real) => real) => ({ send: (options) => { sends.push(options); return route(seller.connector).send(options); } });
  const client = createSellerHttpsClient({ publicEndpoint: seller.origin, authentication, timeoutMs: 5000, ...clientOptions, connector: connectorFor() });
  return { client, seller, w, verifications, sends, connectorFor, authentication };
}
const failure = (promise) => promise.then(() => assert.fail('expected the call to fail'), (error) => error);
const unavailable = (error, causeCode, answerClass = 'unknown') => {
  assert.ok(error instanceof SellerUnavailableError, String(error));
  assert.deepEqual([error.causeCode, error.answerClass], [causeCode, answerClass]);
};

test('a 3xx on every POST route is unavailable with cause redirect and its Location is never contacted', async (t) => {
  const { client, seller, sends } = await sellerRig(t, (res) => { res.writeHead(302, { location: 'https://elsewhere.example.test/landing' }); res.end(); });
  const routes = Object.values(PATHS);
  for (const path of routes) unavailable(await failure(client.request(path, bodyFor(path))), 'redirect');
  assert.equal(seller.seen.requests.length, routes.length);
  assert.deepEqual([...new Set(sends.map((options) => options.origin))], [seller.origin]);
});

test('requests carry exactly the allowlisted headers and never cookies or authorization', async (t) => {
  const { client, seller, sends } = await sellerRig(t, (res, record, answer) => answer(200, '{"disposition":"present"}'));
  await client.propose(bodyFor(PATHS.proposals));
  assert.deepEqual(Object.keys(sends[0].headers).sort(), ['accept', 'content-type', PEER_HEADER]);
  assert.deepEqual(Object.keys(seller.seen.requests[0].headers).sort(), ['accept', 'accept-encoding', 'connection', 'content-length', 'content-type', 'host', 'user-agent', PEER_HEADER]);
});

test('an explicit resume sends its proof header to the seller on the first attempt only: not on an automatic retry, a different route or a later call', async (t) => {
  const resumed = PATHS.proposals;
  let armed = true;
  const explicitResume = (path) => armed && path === resumed && !(armed = false);
  // Stored attempts, so an unknown answer is retried; the clock never moves, so both retries fit the 15 second deadline.
  const requestRecords = { start: (_path, body) => ({ text: JSON.stringify(body), stored: true, check() {}, finish() {} }), failure() {} };
  const { client, seller, sends } = await sellerRig(t, (res, record, answer) => answer(503, '{"error":"seller_effect_pending"}'),
    { explicitResume, requestRecords, timeoutMs: 15000, clock: { now: () => 0, sleep: async () => {} } });
  unavailable(await failure(client.propose(bodyFor(resumed))), 'status-5xx');
  unavailable(await failure(client.request(PATHS.commitments, bodyFor(PATHS.commitments))), 'status-5xx');
  unavailable(await failure(client.propose(bodyFor(resumed))), 'status-5xx');
  const received = seller.seen.requests.map((record) => [record.path, wire.DACS_SELLER_RESUME_HEADER in record.headers]);
  assert.deepEqual(received, [[resumed, true], [resumed, false], [resumed, false],
    [PATHS.commitments, false], [PATHS.commitments, false], [PATHS.commitments, false], [resumed, false], [resumed, false], [resumed, false]]);
  const header = seller.seen.requests[0].headers[wire.DACS_SELLER_RESUME_HEADER];
  assert.equal(header, sends[0].headers[wire.DACS_SELLER_RESUME_HEADER], 'the seller receives the proof the client sent, unchanged');
  assert.ok(header.length > 0 && header.length <= wire.DACS_SELLER_HTTP_LIMITS.maxHeaderLength);
});

test('a 512 KiB response passes and 512 KiB plus one byte is refused before decode, declared and streamed', async (t) => {
  let reply;
  const { client, verifications } = await sellerRig(t, (res, record, answer) => reply(res, record, answer));
  const frame = '{"disposition":"present","pad":""}';
  const text = `{"disposition":"present","pad":"${'x'.repeat(MAX_BYTES - frame.length)}"}`;
  assert.equal(Buffer.byteLength(text), MAX_BYTES);
  reply = (res, record, answer) => answer(200, text);
  assert.equal((await client.propose(bodyFor(PATHS.proposals))).pad.length, MAX_BYTES - frame.length);
  const verifiedBefore = verifications.length;
  reply = (res) => { res.writeHead(200, { ...JSON_TYPE, 'content-length': MAX_BYTES + 1 }); res.end('x'.repeat(MAX_BYTES + 1)); };
  unavailable(await failure(client.propose(bodyFor(PATHS.proposals))), 'oversized');
  reply = (res) => { res.writeHead(200, JSON_TYPE); res.write('x'.repeat(MAX_BYTES)); res.end('x'); };
  unavailable(await failure(client.propose(bodyFor(PATHS.proposals))), 'oversized');
  assert.equal(verifications.length, verifiedBefore);
});

test('every raw-JSON ingress corpus vector on the HTTPS path is refused with its admission code or verified unchanged', async (t) => {
  let current;
  const seller = await startHttpsSeller(t, (_req, res) => { res.writeHead(200, { ...JSON_TYPE, 'content-length': current.length }); res.end(current); });
  const received = [];
  let admitted;
  const authentication = { request: async () => ({ header: 'TEST-header', payload: {}, transmitGuards: NO_TRANSMIT_GUARDS }),
    verifyResponse: async (_payload, { body }) => { received.push(Buffer.from(body)); admitted = { body: admitRawJson(body, { maxBytes: MAX_BYTES }) }; return admitted; } };
  const client = createSellerHttpsClient({ publicEndpoint: seller.origin, authentication, connector: seller.connector, timeoutMs: 5000 });
  for (const vector of corpus.vectors) {
    current = (vector.rawHex ?? vector.rawUtf8Hex) ? Buffer.from(vector.rawHex ?? vector.rawUtf8Hex, 'hex') : Buffer.from(vector.rawUtf8Text, 'utf8');
    admitted = undefined;
    received.length = 0;
    const outcome = await client.propose({ jobId: JOB }).then((value) => ({ value }), (error) => ({ error }));
    assert.equal(received.length, 1, vector.name);
    assert.ok(received[0].equals(current), `${vector.name}: the exact received bytes reach verification`);
    if (vector.expected === 'reject') {
      assert.ok(outcome.error instanceof SellerUnavailableError, `${vector.name}: ${outcome.error}`);
      assert.deepEqual([outcome.error.admissionCode, outcome.error.admissionStage], [vector.expectedErrorCode, vector.expectedStage], vector.name);
    } else assert.equal(Buffer.from(canonicalize(admitted.body)).toString('hex'), vector.canonicalUtf8Hex, vector.name);
  }
});

test('an unsigned 4xx or 5xx never becomes a refusal', async (t) => {
  let status;
  const { client, verifications } = await sellerRig(t, (res) => { res.writeHead(status, JSON_TYPE); res.end('{"error":"peer_operation_mismatch","message":"unsigned"}'); });
  for (status of [400, 404, 409, 429, 500, 503]) {
    const error = await failure(client.submitPayment({ jobId: JOB, txHash: TX_HASH }));
    assert.ok(!(error instanceof SellerRefusedError), `${status}: ${error}`);
    unavailable(error, 'response-auth');
  }
  assert.equal(verifications.length, 6);
});

test('a signed answer that fails authentication is response-auth', async (t) => {
  const { client } = await sellerRig(t, async (res, record, _answer, w) => {
    // A header signed for one body, sent with another body.
    const { payload } = JSON.parse(Buffer.from(record.headers[PEER_HEADER], 'base64url'));
    const header = await wire.signWireResponse(payload, 200, '{"disposition":"present"}', { signer: w.seller, binding: w.binding, local: w.local, purchaseProfile: w.binding.profile, now: w.state.time });
    res.writeHead(200, { ...JSON_TYPE, [PEER_HEADER]: header });
    res.end('{"disposition":"waiting"}');
  });
  unavailable(await failure(client.propose(bodyFor(PATHS.proposals))), 'response-auth');
});

test('failureDispatched is false only when no request byte of any call left', async (t) => {
  const refusing = createSellerHttpsConnector({ resolveHost: async () => ['10.0.0.1'] });
  const mode = { refuse: true };
  const { seller, authentication, connectorFor } = await sellerRig(t, (res) => { res.writeHead(500, JSON_TYPE); res.end('{}'); });
  const client = createSellerHttpsClient({ publicEndpoint: seller.origin, authentication, timeoutMs: 5000, connector: connectorFor((real) => (mode.refuse ? refusing : real)) });
  unavailable(await failure(client.propose(bodyFor(PATHS.proposals))), 'address', 'not-sent');
  assert.equal(client.failureDispatched, false);
  assert.equal(seller.seen.requests.length, 0);
  mode.refuse = false;
  await failure(client.propose(bodyFor(PATHS.proposals)));
  assert.equal(seller.seen.requests.length, 1);
  assert.equal(client.failureDispatched, undefined);
  mode.refuse = true;
  unavailable(await failure(client.propose(bodyFor(PATHS.proposals))), 'address', 'not-sent');
  assert.equal(client.failureDispatched, undefined, 'an earlier call that sent bytes keeps the outcome open');
});

test('a connection lost after the request was written is unknown and keeps failureDispatched open', async (t) => {
  const { client, seller } = await sellerRig(t, (res) => res.socket.destroy());
  unavailable(await failure(client.propose(bodyFor(PATHS.proposals))), 'network');
  assert.equal(seller.seen.requests.length, 1);
  assert.equal(client.failureDispatched, undefined);
});

test('finite signed 409 replayed, 503 pending and 503 seller_stopped answers through the real HTTPS client keep their classifications', async (t) => {
  let next;
  const { client } = await sellerRig(t, (res, record, answer) => answer(next.status, JSON.stringify(next.body)));
  const pay = () => client.submitPayment({ jobId: JOB, txHash: TX_HASH });
  next = { status: 409, body: { error: 'peer_request_replayed' } };
  let error = await failure(pay());
  unavailable(error, 'status-4xx');
  assert.equal(error.answerCode, 'peer_request_replayed');
  next = { status: 503, body: { error: 'seller_effect_pending' } };
  error = await failure(pay());
  unavailable(error, 'status-5xx');
  assert.equal(error.answerCode, 'seller_effect_pending');
  next = { status: 503, body: { error: 'seller_stopped' } };
  error = await failure(pay());
  unavailable(error, 'status-5xx', 'suspended');
  assert.equal(error.answerCode, 'seller_stopped');
  next = { status: 409, body: { error: 'peer_operation_mismatch', message: 'the job is bound elsewhere' } };
  error = await failure(client.commit(JOB));
  assert.ok(error instanceof SellerRefusedError);
  assert.deepEqual([error.answerClass, error.code, error.status], ['definite', 'peer_operation_mismatch', 409]);
});

test('an endless 503 body is refused as oversized or timeout with zero response-verification calls and the outcome unknown', async (t) => {
  let stall = false;
  const { client, verifications, seller, authentication, connectorFor } = await sellerRig(t, (res) => {
    res.writeHead(503, { ...JSON_TYPE, 'transfer-encoding': 'chunked' });
    if (stall) return;
    const chunk = 'x'.repeat(1024);
    const pump = () => { while (!res.destroyed && res.write(chunk)); if (!res.destroyed) res.once('drain', pump); };
    pump();
  });
  unavailable(await failure(client.propose(bodyFor(PATHS.proposals))), 'oversized');
  stall = true;
  const shortDeadline = createSellerHttpsClient({ publicEndpoint: seller.origin, authentication, timeoutMs: 300, connector: connectorFor() });
  unavailable(await failure(shortDeadline.propose(bodyFor(PATHS.proposals))), 'timeout');
  assert.equal(verifications.length, 0);
});

test("each POST runs the caller's prepareTransmit and beforeTransmit after the signature's own checks and no option or public method accepts them", async (t) => {
  const { client, sends, seller } = await sellerRig(t, (res, record, answer) => answer(200, '{"status":"held"}'));
  const calls = [];
  const prepareTransmit = async () => { calls.push('prepare'); };
  const beforeTransmit = () => { calls.push('before'); };
  await client.request(PATHS.state, bodyFor(PATHS.state), { prepareTransmit, beforeTransmit });
  assert.deepEqual(calls, ['prepare', 'before']);
  await client.agreementState(bodyFor(PATHS.state).transportIdentity, { prepareTransmit, beforeTransmit });
  assert.deepEqual(calls, ['prepare', 'before'], 'a named method hands the connector no callback of the caller');
  assert.equal(sends.length, 2);
  assert.equal(seller.seen.requests.length, 2);
  for (const option of ['prepareTransmit', 'beforeTransmit']) {
    assert.throws(() => createSellerHttpsClient({ publicEndpoint: seller.origin, authentication: {}, connector: seller.connector, [option]: () => {} }), TypeError);
  }
});

test('http and loopback endpoints and any fetch, resolver or CA option are refused at construction', async (t) => {
  const seller = await startHttpsSeller(t, () => {});
  const authentication = { request: async () => ({}), verifyResponse: async () => ({}) };
  const build = (options) => () => createSellerHttpsClient({ authentication, connector: seller.connector, ...options });
  assert.doesNotThrow(build({ publicEndpoint: `https://${SELLER_HOST}` }));
  for (const publicEndpoint of [`http://${SELLER_HOST}`, 'http://127.0.0.1:19001', 'https://127.0.0.1:19001', 'https://[::1]', 'https://10.0.0.5', `https://${SELLER_HOST}/dacs`, `https://${SELLER_HOST}?x=1`, undefined]) {
    assert.throws(build({ publicEndpoint }), TypeError, String(publicEndpoint));
  }
  for (const option of ['fetchImpl', 'resolveHost', 'ca', 'lookup', 'url', 'prepareTransmit']) {
    assert.throws(build({ publicEndpoint: `https://${SELLER_HOST}`, [option]: () => {} }), TypeError, option);
  }
  assert.throws(() => createSellerHttpsClient({ publicEndpoint: `https://${SELLER_HOST}`, connector: seller.connector }), TypeError, 'authentication is required');
});

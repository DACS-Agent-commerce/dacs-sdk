import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalize } from '@kynesyslabs/dacs';
import * as wire from '@kynesyslabs/dacs/wire';
import { world, validReceipt, PUBLIC_ENDPOINT, JOB } from './helpers/wire-client-fixture.mjs';
import { committedPurchase } from './helpers/wire-committed-purchase.mjs';
// The fixture installs the admission double, so the modules that read admission state load after it.
const { createSellerAgentClient, SellerRefusedError, SellerTlsUnusableError, SellerUnavailableError } = await import('../src/dacs/seller-http.mjs');
const { classifySellerAnswer, SELLER_ANSWER_CLASS: CLASS } = await import('../src/dacs/seller-response-class.mjs');

const PATHS = wire.DACS_SELLER_HTTP_PATHS;
const ALL_PATHS = Object.values(PATHS);
const BUNDLE_PATHS = [PATHS.bundleRequest, PATHS.bundleCountersignature];
const BOOTSTRAP_CODES = ['context_challenge_failed', 'context_challenge_consumed', 'context_challenge_expired', 'context_challenge_mismatch', 'context_job_closed', 'context_admission_closed'];
const NO_PROVENANCE = { continuation: false, newPurchase: false };
const TX_HASH = 'a'.repeat(64);
const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const ctx = (path, extra = {}) => ({ path, dispatched: true, ...NO_PROVENANCE, ...extra });
const signed = (status, body = {}) => ({ status, signed: true, body });
const classOf = (record, context) => classifySellerAnswer(record, context).answerClass;

// A committed purchase's evidence lets payments and bundle requests sign; the seller answers with the wire's own signWireResponse.
async function sellerWorld(t) {
  const made = await committedPurchase({ jobId: JOB, publicEndpoint: PUBLIC_ENDPOINT });
  const w = await world(t, { pin: made.pin, agreementHash: made.agreementHash, readCommitmentReceipt: Object.assign(async () => 'valid', { chainIdentity: validReceipt.chainIdentity }) });
  const bytes = (value) => Buffer.from(canonicalize(value));
  const evidence = async () => ({ commitment: bytes(made.anchored), agreement: bytes(made.agreement), signedListing: bytes(made.listing) });
  return { ...made, w, auth: w.createSellerWireAuthentication({ ...w.options, evidence }) };
}
async function signedResponse(w, init, status, text, httpStatus = status) {
  const { payload } = JSON.parse(Buffer.from(init.headers[wire.DACS_SELLER_HTTP_HEADER], 'base64url'));
  const header = await wire.signWireResponse(payload, status, text, { signer: w.seller, binding: w.binding, local: w.local, purchaseProfile: w.binding.profile, now: w.state.time });
  return new Response(text, { status: httpStatus, headers: { 'content-type': 'application/json', [wire.DACS_SELLER_HTTP_HEADER]: header } });
}
const answering = (w, status, body, fetches = []) => async (_url, init) => { fetches.push(init); return signedResponse(w, init, status, JSON.stringify(body)); };
const CALLS = {
  [PATHS.state]: (client) => client.agreementState({ jobId: JOB }),
  [PATHS.proposals]: (client) => client.propose({ jobId: JOB }),
  [PATHS.commitments]: (client) => client.commit(JOB),
  [PATHS.payments]: (client) => client.submitPayment({ jobId: JOB, txHash: TX_HASH }),
  [PATHS.bundleRequest]: (client) => client.bundleRequest(JOB),
  [PATHS.bundleCountersignature]: (client) => client.countersign(JOB, 'signature'),
};
// One real call through post(): the value the caller gets, or the error it gets, and how many requests were sent.
async function viaPost(s, path, status, body, options = {}) {
  const fetches = [];
  const client = createSellerAgentClient({ url: PUBLIC_ENDPOINT, authentication: s.auth, fetchImpl: answering(s.w, status, body, fetches), ...options });
  const outcome = await CALLS[path](client).then((value) => ({ value }), (error) => ({ error }));
  return { ...outcome, fetches: fetches.length, client };
}
const refusedAs = (outcome, answerClass, code, status) => {
  assert.ok(outcome.error instanceof SellerRefusedError, String(outcome.error));
  assert.deepEqual([outcome.error.answerClass, outcome.error.code, outcome.error.status], [answerClass, code, status]);
};
const unavailableAs = (outcome, answerClass, causeCode, code) => {
  assert.ok(outcome.error instanceof SellerUnavailableError, String(outcome.error));
  assert.equal(outcome.error.answerClass, answerClass);
  assert.equal(outcome.error.causeCode, causeCode);
  assert.equal(outcome.error.answerCode, code);
};

test('signed 200 results are verified, and held, payment-evidenced with delivery pending, indeterminate and waiting are progress, never final (K5-C11)', async (t) => {
  const results = [[PATHS.commitments, { status: 'committed' }], [PATHS.proposals, { disposition: 'present' }], [PATHS.payments, { status: 'delivered' }], [PATHS.payments, { status: 'payment-evidenced', delivery: { status: 'delivered' } }],
    [PATHS.payments, { status: 'payment-evidenced', delivery: { status: 'delivery-ready', evidencePublication: 'published' } }], [PATHS.payments, { status: 'delivery-ready' }], [PATHS.state, { status: 'held' }], [PATHS.contextChallenge, {}]];
  for (const [path, body] of results) assert.equal(classOf(signed(200, body), ctx(path)), CLASS.RESULT, canonicalize([path, body]));
  const progress = [[PATHS.payments, { status: 'held' }], [PATHS.payments, { status: 'payment-evidenced' }], [PATHS.payments, { status: 'payment-evidenced', delivery: { status: 'pending' } }],
    [PATHS.payments, { status: 'payment-evidenced', delivery: { status: 'delivery-ready', evidencePublication: 'held-readback-only' } }], [PATHS.payments, { status: 'indeterminate' }], [PATHS.proposals, { disposition: 'waiting' }], [PATHS.proposals, { disposition: 'indeterminate' }]];
  for (const [path, body] of progress) assert.equal(classOf(signed(200, body), ctx(path)), CLASS.PROGRESS, canonicalize([path, body]));
  const s = await sellerWorld(t);
  const held = await viaPost(s, PATHS.payments, 200, { status: 'held', reason: 'readback incomplete' });
  assert.deepEqual(held.value, { status: 'held', reason: 'readback incomplete' });
  assert.equal(held.fetches, 1);
  assert.deepEqual((await viaPost(s, PATHS.payments, 200, { status: 'delivered' })).value, { status: 'delivered' });
});

test('408 peer_expired, another signed 5xx, an unsigned answer and a timeout are unknown with their causes kept', async (t) => {
  const s = await sellerWorld(t);
  assert.equal(classOf(signed(408, { error: 'peer_expired' }), ctx(PATHS.payments)), CLASS.UNKNOWN);
  assert.equal(classOf(signed(502, { error: 'bad_gateway' }), ctx(PATHS.payments)), CLASS.UNKNOWN);
  assert.equal(classOf({ status: 408, signed: false, body: { error: 'peer_expired' } }, ctx(PATHS.payments)), CLASS.UNKNOWN);
  assert.equal(classOf(null, ctx(PATHS.payments)), CLASS.UNKNOWN);
  unavailableAs(await viaPost(s, PATHS.payments, 408, { error: 'peer_expired' }), CLASS.UNKNOWN, 'status-4xx', 'peer_expired');
  unavailableAs(await viaPost(s, PATHS.payments, 502, { error: 'bad_gateway' }), CLASS.UNKNOWN, 'status-5xx', 'bad_gateway');
  unavailableAs(await viaPost(s, PATHS.payments, 409, { error: 'peer_request_replayed' }), CLASS.UNKNOWN, 'status-4xx', 'peer_request_replayed');
  unavailableAs(await viaPost(s, PATHS.payments, 503, { error: 'seller_effect_pending' }), CLASS.UNKNOWN, 'status-5xx', 'seller_effect_pending');
  unavailableAs(await viaPost(s, PATHS.payments, 503, { error: 'seller_not_ready' }), CLASS.UNKNOWN, 'status-5xx', 'seller_not_ready');
  const unsignedClient = createSellerAgentClient({ url: PUBLIC_ENDPOINT, authentication: s.auth, fetchImpl: async () => new Response('{"error":"peer_expired"}', { status: 408, headers: { 'content-type': 'application/json' } }) });
  const unsigned = await CALLS[PATHS.payments](unsignedClient).catch((error) => error);
  assert.ok(unsigned instanceof SellerUnavailableError);
  assert.deepEqual([unsigned.answerClass, unsigned.causeCode], [CLASS.UNKNOWN, 'response-auth']);
  const timedOutClient = createSellerAgentClient({ url: PUBLIC_ENDPOINT, authentication: s.auth, fetchImpl: async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); } });
  const timedOut = await CALLS[PATHS.payments](timedOutClient).catch((error) => error);
  assert.ok(timedOut instanceof SellerUnavailableError);
  assert.deepEqual([timedOut.answerClass, timedOut.causeCode], [CLASS.UNKNOWN, 'timeout']);
});

test('signed 409 peer_operation_mismatch is definite and stops the purchase with that cause (K5-C5)', async (t) => {
  const s = await sellerWorld(t);
  assert.equal(classOf(signed(409, { error: 'peer_operation_mismatch' }), ctx(PATHS.payments)), CLASS.DEFINITE);
  const outcome = await viaPost(s, PATHS.commitments, 409, { error: 'peer_operation_mismatch', message: 'the job is bound elsewhere' });
  refusedAs(outcome, CLASS.DEFINITE, 'peer_operation_mismatch', 409);
  assert.equal(outcome.error.message, 'the job is bound elsewhere');
  assert.equal(outcome.fetches, 1);
});

test('signed 500 seller_effect_unresolved shows needs the seller operator and is not retried (K5-C6)', async (t) => {
  const s = await sellerWorld(t);
  assert.equal(classOf(signed(500, { error: 'seller_effect_unresolved' }), ctx(PATHS.payments)), CLASS.HELD);
  const outcome = await viaPost(s, PATHS.payments, 500, { error: 'seller_effect_unresolved' });
  unavailableAs(outcome, CLASS.HELD, 'status-5xx', 'seller_effect_unresolved');
  assert.match(outcome.error.message, /needs the seller operator/);
  assert.equal(outcome.fetches, 1);
});

test('408 peer_delegation_expired allows readback routes only', async (t) => {
  const s = await sellerWorld(t);
  assert.equal(classOf(signed(408, { error: 'peer_delegation_expired' }), ctx(PATHS.state)), CLASS.READBACK_ONLY);
  const outcome = await viaPost(s, PATHS.payments, 408, { error: 'peer_delegation_expired' });
  unavailableAs(outcome, CLASS.READBACK_ONLY, 'status-4xx', 'peer_delegation_expired');
  assert.equal(outcome.fetches, 1);
});

test('503 bundle_finalization_unavailable and 422 not_delivered are held with no retry loop on the bundle routes, and the same signed pairs on other routes follow their own rows (K5-C10)', async (t) => {
  const s = await sellerWorld(t);
  for (const path of ALL_PATHS) {
    const onBundle = BUNDLE_PATHS.includes(path);
    assert.equal(classOf(signed(503, { error: 'bundle_finalization_unavailable' }), ctx(path)), onBundle ? CLASS.HELD : CLASS.UNKNOWN, path);
    assert.equal(classOf(signed(422, { error: 'not_delivered' }), ctx(path)), onBundle ? CLASS.HELD : CLASS.DEFINITE, path);
  }
  const held = await viaPost(s, PATHS.bundleRequest, 503, { error: 'bundle_finalization_unavailable' });
  unavailableAs(held, CLASS.HELD, 'status-5xx', 'bundle_finalization_unavailable');
  assert.equal(held.fetches, 1);
  unavailableAs(await viaPost(s, PATHS.bundleCountersignature, 422, { error: 'not_delivered' }), CLASS.HELD, 'status-4xx', 'not_delivered');
  unavailableAs(await viaPost(s, PATHS.payments, 503, { error: 'bundle_finalization_unavailable' }), CLASS.UNKNOWN, 'status-5xx', 'bundle_finalization_unavailable');
  refusedAs(await viaPost(s, PATHS.payments, 422, { error: 'not_delivered' }), CLASS.DEFINITE, 'not_delivered', 422);
});

test('the bootstrap codes and a 429 on the context route classify as definite failed bootstrap and never as proof that no seller work happened', () => {
  for (const code of BOOTSTRAP_CODES) {
    const verdict = classifySellerAnswer(signed(409, { error: code }), ctx(PATHS.context));
    assert.deepEqual([verdict.answerClass, verdict.code], [CLASS.FAILED_BOOTSTRAP, code]);
  }
  assert.equal(classOf(signed(429, { error: 'peer_buyer_nonce_limit' }), ctx(PATHS.context)), CLASS.FAILED_BOOTSTRAP);
  for (const provenance of [NO_PROVENANCE, { continuation: true, newPurchase: false }, { continuation: false, newPurchase: true }])
    for (const code of BOOTSTRAP_CODES) assert.equal(classOf(signed(409, { error: code }), ctx(PATHS.context, provenance)), CLASS.FAILED_BOOTSTRAP, code);
});

test('the same signed 429 on the challenge route is definite and retried only after the window moves', () => {
  assert.equal(classOf(signed(429, { error: 'peer_buyer_nonce_limit' }), ctx(PATHS.contextChallenge)), CLASS.DEFINITE);
  assert.equal(classOf(signed(429, { error: 'peer_buyer_nonce_limit' }), ctx(PATHS.context)), CLASS.FAILED_BOOTSTRAP);
  assert.equal(classOf(signed(429, {}), ctx(PATHS.payments)), CLASS.UNKNOWN);
});

test('a signed 429 or an unlisted signed 408 on every other route is unknown and keeps its cause, so a rate limit never ends an agreement', async (t) => {
  const s = await sellerWorld(t);
  const retryable = [[429, 'peer_buyer_nonce_limit'], [429, 'seller_rate_limited'], [408, 'explicit_resume_expired'], [408, 'unlisted_code']];
  for (const path of ALL_PATHS.filter((candidate) => candidate !== PATHS.context && candidate !== PATHS.contextChallenge))
    for (const [status, code] of retryable) assert.equal(classOf(signed(status, { error: code }), ctx(path)), CLASS.UNKNOWN, `${status} ${code} ${path}`);
  for (const path of Object.keys(CALLS))
    for (const [status, code] of retryable) {
      const outcome = await viaPost(s, path, status, { error: code });
      unavailableAs(outcome, CLASS.UNKNOWN, 'status-4xx', code);
      assert.equal(outcome.client.failureCause, 'status-4xx');
    }
});

test('other signed 4xx with an error are definite refusals and unsigned 4xx are unknown', async (t) => {
  const s = await sellerWorld(t);
  for (const status of [400, 403, 404, 413, 415, 422]) assert.equal(classOf(signed(status, { error: 'refused' }), ctx(PATHS.proposals)), CLASS.DEFINITE, String(status));
  assert.equal(classOf(signed(404, {}), ctx(PATHS.proposals)), CLASS.UNKNOWN);
  assert.equal(classOf(signed(404, { error: 7 }), ctx(PATHS.proposals)), CLASS.UNKNOWN);
  assert.equal(classOf({ status: 404, signed: false, body: { error: 'not_found' } }, ctx(PATHS.proposals)), CLASS.UNKNOWN);
  assert.equal(classOf({ status: 404, body: { error: 'not_found' } }, ctx(PATHS.proposals)), CLASS.UNKNOWN);
  refusedAs(await viaPost(s, PATHS.proposals, 422, { error: 'agreement_rejected', message: 'x'.repeat(500) }), CLASS.DEFINITE, 'agreement_rejected', 422);
  const unsignedClient = createSellerAgentClient({ url: PUBLIC_ENDPOINT, authentication: s.auth, fetchImpl: async () => new Response('{"error":"not_found"}', { status: 404, headers: { 'content-type': 'application/json' } }) });
  const unsigned = await CALLS[PATHS.proposals](unsignedClient).catch((error) => error);
  assert.ok(unsigned instanceof SellerUnavailableError);
  assert.equal(unsigned.answerClass, CLASS.UNKNOWN);
});

test('a TLS failure before dispatch is not sent (dispatched false) and after dispatch it is unknown', async (t) => {
  const s = await sellerWorld(t);
  assert.equal(classOf(null, ctx(PATHS.payments, { dispatched: false })), CLASS.NOT_SENT);
  assert.equal(classOf(null, ctx(PATHS.payments, { dispatched: true })), CLASS.UNKNOWN);
  const before = createSellerAgentClient({ url: PUBLIC_ENDPOINT, authentication: { request: async () => { throw new SellerTlsUnusableError('the seller certificate expired'); }, verifyResponse: s.auth.verifyResponse }, fetchImpl: async () => assert.fail('nothing is dispatched') });
  const notSent = await CALLS[PATHS.state](before).catch((error) => error);
  assert.deepEqual([notSent.answerClass, notSent.dispatched, notSent.causeCode], [CLASS.NOT_SENT, false, 'tls']);
  assert.equal(before.failureDispatched, false);
  const after = createSellerAgentClient({ url: PUBLIC_ENDPOINT, authentication: s.auth, fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } }); } });
  const dispatched = await CALLS[PATHS.state](after).catch((error) => error);
  assert.deepEqual([dispatched.answerClass, dispatched.dispatched, dispatched.causeCode], [CLASS.UNKNOWN, undefined, 'tls']);
  assert.equal(after.failureDispatched, undefined);
});

test('a real signed 200 result, a signed progress response and a signed refusal pass through post() and the wire adapter into classification as {status, signed: true, body}, with the HTTP status the wire checked and the receipt\'s admitted body', async (t) => {
  const s = await sellerWorld(t), seen = [];
  const classifyAnswer = (record, context) => { seen.push([record, context]); return classifySellerAnswer(record, context); };
  const cases = [[PATHS.commitments, 200, { status: 'committed', jobId: JOB }], [PATHS.payments, 200, { status: 'held', reason: 'readback incomplete' }], [PATHS.commitments, 409, { error: 'peer_operation_mismatch' }]];
  for (const [path, status, body] of cases) {
    const outcome = await viaPost(s, path, status, body, { classifyAnswer });
    const [record, context] = seen.at(-1);
    assert.deepEqual(record, { status, signed: true, body });
    assert.deepEqual(context, { path, dispatched: true, continuation: false, newPurchase: false });
    if (status === 200) assert.deepEqual(outcome.value, body);
    else assert.ok(outcome.error instanceof SellerRefusedError);
  }
  assert.equal(seen.length, 3);
  // The signed status and the HTTP status must agree: the wire refuses a mismatch and nothing reaches classification.
  const mismatched = createSellerAgentClient({ url: PUBLIC_ENDPOINT, authentication: s.auth, classifyAnswer, fetchImpl: async (_url, init) => signedResponse(s.w, init, 200, '{"status":"committed"}', 409) });
  const rejected = await CALLS[PATHS.commitments](mismatched).catch((error) => error);
  assert.deepEqual([rejected.answerClass, rejected.causeCode], [CLASS.UNKNOWN, 'response-auth']);
  assert.equal(seen.length, 3);
});

test('with verification held at a barrier and then rejected, no result reaches the business consumer before verification, and the rejection is unknown with its cause and never signed: true', async (t) => {
  const s = await sellerWorld(t), seen = [];
  let releaseBarrier, reachedBarrier;
  const barrier = new Promise((resolve) => { releaseBarrier = resolve; }), atBarrier = new Promise((resolve) => { reachedBarrier = resolve; });
  const authentication = { request: (...args) => s.auth.request(...args), async verifyResponse(payload, received) {
    reachedBarrier(received);
    await barrier;
    throw new wire.WireError('peer_response_mismatch', 502);
  } };
  const classifyAnswer = (record, context) => { seen.push(record); return classifySellerAnswer(record, context); };
  const client = createSellerAgentClient({ url: PUBLIC_ENDPOINT, authentication, classifyAnswer, fetchImpl: async (_url, init) => signedResponse(s.w, init, 200, '{"status":"committed"}') });
  let consumed = false;
  const consumer = CALLS[PATHS.commitments](client).then((value) => { consumed = true; return value; }, (error) => { consumed = true; throw error; });
  const received = await atBarrier;
  assert.equal(Buffer.from(received.body).toString(), '{"status":"committed"}');
  await Promise.resolve();
  assert.equal(consumed, false, 'the answer was used before verification finished');
  assert.deepEqual(seen, []);
  releaseBarrier();
  const error = await consumer.catch((rejection) => rejection);
  assert.ok(error instanceof SellerUnavailableError);
  assert.deepEqual([error.answerClass, error.causeCode], [CLASS.UNKNOWN, 'response-auth']);
  assert.deepEqual(seen, [], 'a rejected verification produced a classifier record');
  assert.equal(client.failureCause, 'response-auth');
});

test('every status, code, route and provenance cell maps to exactly one class', () => {
  const on = (status, code) => (cell) => cell.status === status && cell.code === code;
  const notStarted = (cell) => cell.newPurchase && !cell.continuation;
  const rows = [
    [on(409, 'peer_request_replayed'), CLASS.UNKNOWN], [on(503, 'seller_effect_pending'), CLASS.UNKNOWN], [on(503, 'context_attempt_pending'), CLASS.UNKNOWN], [on(408, 'peer_expired'), CLASS.UNKNOWN],
    [on(503, 'seller_stopped'), CLASS.SUSPENDED], [on(500, 'seller_effect_unresolved'), CLASS.HELD], [on(408, 'peer_delegation_expired'), CLASS.READBACK_ONLY], [on(409, 'peer_operation_mismatch'), CLASS.DEFINITE],
    [(cell) => BUNDLE_PATHS.includes(cell.path) && (on(503, 'bundle_finalization_unavailable')(cell) || on(422, 'not_delivered')(cell)), CLASS.HELD],
    [(cell) => on(503, 'seller_not_ready')(cell) && notStarted(cell), CLASS.NOT_STARTED], [(cell) => on(503, 'seller_not_ready')(cell) && !notStarted(cell), CLASS.UNKNOWN],
    [(cell) => cell.status === 409 && BOOTSTRAP_CODES.includes(cell.code), CLASS.FAILED_BOOTSTRAP], [(cell) => cell.status === 429 && cell.path === PATHS.context, CLASS.FAILED_BOOTSTRAP],
    [(cell) => cell.status === 429 && cell.path === PATHS.contextChallenge, CLASS.DEFINITE],
  ];
  const unlisted = (cell) => (cell.status === 200 ? CLASS.RESULT : cell.status >= 400 && cell.status < 500 && ![408, 429].includes(cell.status) && cell.code !== undefined ? CLASS.DEFINITE : CLASS.UNKNOWN);
  const codes = [undefined, 'unlisted_code', 'peer_request_replayed', 'seller_effect_pending', 'context_attempt_pending', 'peer_expired', 'seller_stopped', 'seller_effect_unresolved', 'peer_delegation_expired', 'peer_operation_mismatch',
    'bundle_finalization_unavailable', 'not_delivered', 'seller_not_ready', ...BOOTSTRAP_CODES];
  let cells = 0;
  for (const status of [200, 201, 302, 400, 404, 408, 409, 422, 429, 500, 502, 503])
    for (const code of codes) for (const path of ALL_PATHS) for (const provenance of [NO_PROVENANCE, { continuation: true, newPurchase: false }, { continuation: false, newPurchase: true }, { continuation: true, newPurchase: true }]) {
      const cell = { status, code, path, ...provenance };
      const matching = rows.filter(([matches]) => matches(cell));
      assert.ok(matching.length <= 1, `two rows claim ${canonicalize(cell)}`);
      const expected = matching.length === 1 ? matching[0][1] : unlisted(cell);
      const body = code === undefined ? {} : { error: code };
      const actual = classOf(signed(status, body), ctx(path, provenance));
      assert.equal(actual, expected, canonicalize(cell));
      assert.equal(classOf({ status, body }, ctx(path, provenance)), CLASS.UNKNOWN, `unsigned ${canonicalize(cell)}`);
      cells++;
    }
  assert.ok(cells > 5000);
  for (const malformed of [{}, { path: 'https://example/', dispatched: true, ...NO_PROVENANCE }, ctx(PATHS.state, { dispatched: 'yes' }), ctx(PATHS.state, { continuation: undefined }), ctx(PATHS.state, { newPurchase: 1 })])
    assert.throws(() => classifySellerAnswer(signed(200), malformed), TypeError);
  assert.throws(() => classifySellerAnswer(signed(200), ctx(PATHS.state, { dispatched: false })), TypeError);
  for (const record of [signed(200.5), signed(200, []), signed(200, null), { status: 200, signed: 'true', body: {} }, undefined]) assert.equal(classOf(record ?? null, ctx(PATHS.state)), CLASS.UNKNOWN, canonicalize(record ?? null));
});

test('a pre-dispatch TLS failure on a fresh client after restart marks only that attempt and leaves an earlier unknown attempt unresolved', async (t) => {
  const s = await sellerWorld(t);
  const beforeCrash = createSellerAgentClient({ url: PUBLIC_ENDPOINT, authentication: s.auth, fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); } });
  const earlier = await CALLS[PATHS.payments](beforeCrash).catch((error) => error);
  assert.deepEqual([earlier.answerClass, earlier.causeCode], [CLASS.UNKNOWN, 'network']);
  const afterRestart = createSellerAgentClient({ url: PUBLIC_ENDPOINT, authentication: { request: async () => { throw new SellerTlsUnusableError('the seller certificate expired'); }, verifyResponse: s.auth.verifyResponse }, fetchImpl: async () => assert.fail('nothing is dispatched') });
  const latest = await CALLS[PATHS.payments](afterRestart).catch((error) => error);
  assert.deepEqual([latest.answerClass, latest.dispatched], [CLASS.NOT_SENT, false]);
  assert.equal(afterRestart.failureDispatched, false);
  assert.equal(earlier.answerClass, CLASS.UNKNOWN, 'the earlier attempt was marked');
  assert.equal(beforeCrash.failureCause, 'network');
  assert.equal(beforeCrash.failureDispatched, undefined);
  assert.equal(classOf(null, ctx(PATHS.payments, { dispatched: false })), CLASS.NOT_SENT);
  assert.equal(classOf(null, ctx(PATHS.payments)), CLASS.UNKNOWN);
});

test('an unavailable error from signing keeps the client-sign cause and is not taken for a classified answer', async (t) => {
  const s = await sellerWorld(t);
  const signingFailure = new SellerUnavailableError('the signer is not available', 'other');
  const client = createSellerAgentClient({ url: PUBLIC_ENDPOINT, authentication: { request: async () => { throw signingFailure; }, verifyResponse: s.auth.verifyResponse }, fetchImpl: async () => assert.fail('nothing is dispatched') });
  const error = await CALLS[PATHS.state](client).catch((rejection) => rejection);
  assert.ok(error instanceof SellerUnavailableError);
  assert.notEqual(error, signingFailure);
  assert.deepEqual([error.answerClass, error.causeCode], [CLASS.UNKNOWN, 'client-sign']);
  assert.equal(client.failureCause, 'client-sign');
});

test('the README classification table names every class and every coded row of the classifier', () => {
  const section = README.slice(README.indexOf('Seller answer classification'));
  assert.ok(section.length < README.length, 'the README has no classification section');
  for (const name of Object.values(CLASS)) assert.ok(section.includes(`\`${name}\``), name);
  for (const code of ['peer_request_replayed', 'seller_effect_pending', 'context_attempt_pending', 'peer_expired', 'seller_stopped', 'bundle_finalization_unavailable', 'not_delivered', 'seller_not_ready',
    'peer_operation_mismatch', 'seller_effect_unresolved', 'peer_delegation_expired', ...BOOTSTRAP_CODES]) assert.ok(section.includes(`\`${code}\``), code);
});

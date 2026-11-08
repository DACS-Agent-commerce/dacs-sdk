// P12a: the challenge route on the wire, composed directly (the host mounts nothing yet). Each test name is the
// card's title; nonces are random at run time, so tests compare shapes, codes and counts, never values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { identityBundleHash } from '@kynesyslabs/dacs';
import * as guard from '../src/kit-operation-guard.mjs';
import { SellerTransportError, createSellerTransportClientAuth, createSellerTransportServerAuth, sellerContextScopeHash, SELLER_TRANSPORT_HEADER } from '../src/dacs/seller-transport-auth.mjs';
import { createSellerHttpHandler } from '../src/dacs/seller-http.mjs';
import { exchange, bundleFor } from './helpers/d5-http-fixture.mjs';
import { CHALLENGE_LIFETIME_MS, CHALLENGE_PATH, CONTEXT_PATH, JOB, JOB2, T0, challengeWorld, gate, watchSql } from './helpers/challenge-route-fixture.mjs';

const NONCE = /^[0-9a-f]{64}$/;
const HOUR_MS = 3_600_000;
const GENERATED_AT_SKEW_MS = 600_000;
const MAX_REQUEST_BYTES = 64 * 1024;
const STALL_DEADLINE_MS = 10_000;
const REQUEST_LIFETIME_MS = 20_000;
const OVERALL_LIMIT = 12;
const K5_MAX_RECORDS = 100;
const K5_PURCHASE_ALLOTMENT = 68;
const summary = (answer) => [answer.status, answer.body.error];
const sellerTransportRefusal = (code, status = 409) => () => { throw new SellerTransportError(code, status); };
const rejection = async (promise) => { try { await promise; } catch (error) { return error; } return assert.fail('expected a refusal'); };

/** A refusal wrote nothing: no ledger row, no write statement, no wire journal file. */
function assertNothingWritten(w, sql) {
  assert.equal(w.rows().length, 0, 'no ledger row');
  assert.equal(sql.writes(), 0, 'no write statement');
  assert.equal(w.journalFiles(), 0, 'no wire journal file');
}
/** The valid signed positive control for a refusal: the same world now issues exactly one challenge. */
async function assertControlIssues(w, options) {
  const answer = await w.post(await w.sign(options));
  assert.equal(answer.status, 200);
  assert.match(answer.body.sessionNonce, NONCE);
  assert.equal(w.rows().length, 1);
}

test('A22 a delegated challenge request before any Agreement gets a signed nonce from the ledger', async (t) => {
  const w = await challengeWorld(t);
  const signed = await w.sign();
  const answer = await w.post(signed);
  assert.equal(answer.status, 200);
  assert.deepEqual(Object.keys(answer.body).sort(), ['expiresAt', 'sessionNonce']);
  assert.match(answer.body.sessionNonce, NONCE);
  assert.equal(answer.body.expiresAt, T0 + CHALLENGE_LIFETIME_MS);
  assert.equal(w.rows().length, 1);
  assert.equal(w.rows()[0].nonce, answer.body.sessionNonce);
  assert.equal(w.journalFiles(), 0);
  await signed.verify(answer);
});

const scopeCases = [
  ['K1-I2 source', 'context_scope_invalid', (s) => { s.source = 'TEST other source'; }],
  ['K1-I3 wallet of OTHER', 'context_scope_invalid', (s, w) => { s.wallet = w.other.address; }],
  ['K1-I4 seller OTHER', 'context_scope_invalid', (s, w) => { s.seller = w.other.claim; }],
  ['K1-I5 pin version 2', 'context_scope_invalid', (s) => { s.listingPin = { ...s.listingPin, version: 2 }; }],
  ['K1-I6 rail version 2', 'context_scope_invalid', (s) => { s.rail = { ...s.rail, railVersion: 2 }; }],
  ['K1-I7 payee of OTHER', 'context_scope_invalid', (s, w) => { s.payee = w.other.address; }],
  ['K1-I8 price 2 DEM', 'context_scope_invalid', (s) => { s.price = { ...s.price, amount: '2' }; }],
  ['K1-I9 generatedAt T0-600001', 'context_generated_at', (s) => { s.generatedAt = T0 - GENERATED_AT_SKEW_MS - 1; }],
  ['K1-I11 generatedAt T0+600001', 'context_generated_at', (s) => { s.generatedAt = T0 + GENERATED_AT_SKEW_MS + 1; }],
  ['K1-I13 generatedAt as a string', 'context_generated_at', (s) => { s.generatedAt = String(T0); }],
];

test('K1-A32 K1-I1 to K1-I18 through the wire route give the same codes, with I15 split as OP-3', async (t) => {
  await t.test('K1-I1 and K1-I10 each issue one challenge in a fresh fixture', async (t) => {
    for (const generatedAt of [T0, T0 - GENERATED_AT_SKEW_MS]) {
      const w = await challengeWorld(t);
      const sql = watchSql(t);
      const answer = await w.post(await w.sign({ scope: w.scopeFor(JOB, w.buyer, generatedAt) }));
      assert.equal(answer.status, 200);
      assert.equal(w.rows().length, 1);
      assert.equal(sql.writes(), 1, 'exactly one ledger insertion');
      assert.equal(w.journalFiles(), 0);
    }
  });
  for (const [name, code, change] of scopeCases) {
    await t.test(`${name}: only the body scope member changes, and the envelope hash follows it`, async (t) => {
      const w = await challengeWorld(t);
      const scope = w.scopeFor();
      change(scope, w);
      const sql = watchSql(t);
      const answer = await w.post(await w.sign({ scope }));
      assert.deepEqual(summary(answer), [409, code]);
      assert.ok(answer.signature, 'signed: the request was opened');
      assertNothingWritten(w, sql);
      await assertControlIssues(w);
    });
  }
  await t.test('K1-I12 generatedAt 2^53: refused bad_json by CF-5 before K1 sees it (differs from K1-A32: the wire admits the bytes first)', async (t) => {
    const w = await challengeWorld(t);
    const sql = watchSql(t);
    const { header } = await w.sign();
    const answer = await w.post({ header, text: JSON.stringify({ scope: w.scopeFor(JOB, w.buyer, 2 ** 53) }) });
    assert.deepEqual(summary(answer), [400, 'bad_json']);
    assert.equal(answer.signature, undefined);
    assertNothingWritten(w, sql);
    await assertControlIssues(w);
  });
  await t.test('K1-I14 scope job JOB2 under request job JOB', async (t) => {
    const w = await challengeWorld(t);
    const sql = watchSql(t);
    const answer = await w.post(await w.sign({ scope: w.scopeFor(JOB2) }));
    assert.deepEqual(summary(answer), [409, 'peer_job_mismatch']);
    assertNothingWritten(w, sql);
    await assertControlIssues(w);
  });
  await t.test('K1-I15a request job not canonical: peer_envelope_invalid 401, unsigned', async (t) => {
    const w = await challengeWorld(t);
    const signed = await w.sign({ delegated: false });
    const sql = watchSql(t);
    const answer = await w.post({ ...signed, ...w.envelope({ ...signed.payload, jobId: JOB.toLowerCase() }, w.buyer) });
    assert.deepEqual(summary(answer), [401, 'peer_envelope_invalid']);
    assert.equal(answer.signature, undefined);
    assertNothingWritten(w, sql);
    await assertControlIssues(w);
  });
  await t.test('K1-I15b scope job not canonical under a canonical request job: peer_job_invalid 409', async (t) => {
    const w = await challengeWorld(t);
    const sql = watchSql(t);
    const answer = await w.post(await w.sign({ scope: w.scopeFor(JOB.toLowerCase()) }));
    assert.deepEqual(summary(answer), [409, 'peer_job_invalid']);
    assertNothingWritten(w, sql);
    await assertControlIssues(w);
  });
  await t.test('K1-I16 buyer access closed and K1-I17 unknown job', async (t) => {
    const w = await challengeWorld(t);
    const sql = watchSql(t);
    w.policy.access = sellerTransportRefusal('buyer_access_closed');
    assert.deepEqual(summary(await w.post(await w.sign())), [409, 'buyer_access_closed']);
    w.policy.access = async () => {};
    w.policy.known = async () => false;
    assert.deepEqual(summary(await w.post(await w.sign())), [409, 'context_job_unknown']);
    assertNothingWritten(w, sql);
    w.policy.known = async () => true;
    await assertControlIssues(w);
  });
  await t.test('K1-I18 seller clock T0+600001 with generatedAt T0', async (t) => {
    const w = await challengeWorld(t);
    w.advance(GENERATED_AT_SKEW_MS + 1);
    const sql = watchSql(t);
    const answer = await w.post(await w.sign({ scope: w.scopeFor(JOB, w.buyer, T0) }));
    assert.deepEqual(summary(answer), [409, 'context_generated_at']);
    assertNothingWritten(w, sql);
    await assertControlIssues(w);
  });
});

test('C3 a challenge while the seller is not ready is refused seller_not_ready 503 and issues nothing', async (t) => {
  const w = await challengeWorld(t);
  w.state.ready = () => false;
  const signed = await w.sign();
  const sql = watchSql(t);
  const answer = await w.post(signed);
  assert.deepEqual(summary(answer), [503, 'seller_not_ready']);
  await signed.verify(answer);
  assertNothingWritten(w, sql);
  w.state.ready = () => true;
  await assertControlIssues(w);
});

test('A39 a challenge while stopped is refused seller_stopped 503; a throwing predicate gives stop_check_failed and a non-boolean stop_check_invalid', async (t) => {
  const predicates = [['the predicate answers true', () => true, undefined],
    ['the predicate throws', () => { throw new Error('TEST stop predicate failed'); }, 'stop_check_failed'],
    ['the predicate answers a non-boolean', () => 'yes', 'stop_check_invalid'],
    ['the predicate answers a rejected promise (handled, never an unhandled rejection)', () => Promise.reject(new Error('TEST stop predicate rejected')), 'stop_check_invalid']];
  for (const [name, stop, cause] of predicates) await t.test(name, async (t) => {
    const w = await challengeWorld(t);
    w.state.stop = stop;
    const signed = await w.sign();
    const sql = watchSql(t);
    const answer = await w.post(signed);
    assert.deepEqual(summary(answer), [503, 'seller_stopped']);
    assert.equal(answer.body.cause, cause, 'the cause stays visible in the signed answer');
    await signed.verify(answer);
    assertNothingWritten(w, sql);
    w.state.stop = () => false;
    await assertControlIssues(w);
  });
});

test('K1-L37 a stop that appears after step 5 and before the insert refuses at step 16 with no write', async (t) => {
  await t.test('during the buyer-access callback (caught as the ledger opens its transaction)', async (t) => {
    const w = await challengeWorld(t);
    const stall = gate();
    w.policy.access = stall.pass;
    const sql = watchSql(t);
    const pending = w.post(await w.sign());
    await stall.entered;
    w.state.stop = () => true;
    stall.release();
    assert.deepEqual(summary(await pending), [503, 'seller_stopped']);
    assertNothingWritten(w, sql);
  });
  await t.test('inside the ledger transaction itself, after its own first stop check: step 16', async (t) => {
    const w = await challengeWorld(t);
    w.state.sessionState = () => { w.state.stop = () => true; return null; };
    const sql = watchSql(t);
    assert.deepEqual(summary(await w.post(await w.sign())), [503, 'seller_stopped']);
    assertNothingWritten(w, sql);
  });
});

test('A39 a challenge under an expired delegation is refused peer_delegation_expired 408 with no readback and no write', async (t) => {
  const w = await challengeWorld(t);
  const delegation = w.delegationFor({ lifetimeMs: 60_000 });
  w.advance(60_000);
  const signed = await w.sign({ delegation });
  const sql = watchSql(t);
  const answer = await w.post(signed);
  assert.deepEqual(summary(answer), [408, 'peer_delegation_expired']);
  await signed.verify(answer);
  assert.deepEqual([w.calls.access, w.calls.known, w.calls.readCommitmentReceipt], [0, 0, 0], 'no readback and no callback ran');
  assertNothingWritten(w, sql);
  await assertControlIssues(w);
});

test('A38 a missing delegation where one is required, a delegation for another job, for another buyer, or signed under the old domain is refused before any ledger access', async (t) => {
  const OLD_DOMAIN = 'dacs-chatgpt-plugin:seller-session-delegation:v1:';
  const hostile = [
    ['missing', 401, 'peer_delegation_required', async (w) => w.sign({ delegated: false })],
    ['for another job', 409, 'peer_delegation_mismatch', async (w, signed) => ({ ...signed, ...w.envelope(signed.payload, w.session, w.delegationFor({ jobId: JOB2 })) })],
    ['for another buyer', 409, 'peer_delegation_mismatch', async (w, signed) => ({ ...signed, ...w.envelope(signed.payload, w.session, w.delegationFor({ actor: w.other })) })],
    ['signed under the old domain', 401, 'peer_delegation_signature_invalid', async (w, signed) => ({ ...signed, ...w.envelope(signed.payload, w.session, w.delegationFor({ domain: OLD_DOMAIN })) })],
  ];
  for (const [name, status, code, build] of hostile) await t.test(name, async (t) => {
    const w = await challengeWorld(t, { requireDelegation: true });
    const sql = watchSql(t);
    const answer = await w.post(await build(w, await w.sign()));
    assert.deepEqual(summary(answer), [status, code]);
    assert.equal(sql.reads(), 0, 'no ledger access');
    assert.equal(w.calls.access, 0);
    assertNothingWritten(w, sql);
    await assertControlIssues(w);
  });
});

test('A38 the challenge is admitted with no Agreement: checkWireRequest is never called and no artifact is supplied', async (t) => {
  // checkWireRequest refuses both pre-Agreement routes (wire_route_requires_preagreement), so an admitted answer proves it was not
  // called; the hooks that supply an Agreement, artifacts or a commitment receipt are never reached either.
  for (const [name, options] of [['delegated', {}], ['a direct buyer-signed request (delegation not required)', { delegated: false }]]) await t.test(name, async (t) => {
    const w = await challengeWorld(t);
    const answer = await w.post(await w.sign(options));
    assert.equal(answer.status, 200);
    assert.deepEqual([w.calls.continuationEvidenceOf, w.calls.readCommitmentReceipt, w.calls.transportAgreementOf], [0, 0, 0]);
    assert.equal(w.rows().length, 1);
    assert.equal(w.journalFiles(), 0);
  });
});

test('K2-T10 a challenge body carrying buyerBundleHash is peer_context_mismatch 409; a changed body seller or pin under an otherwise valid first-contact envelope is context_scope_invalid; a body buyer other than the envelope buyer is peer_agreement_party_mismatch', async (t) => {
  const cases = [
    ['buyerBundleHash in the scope', 'peer_context_mismatch', (s) => { s.buyerBundleHash = 'a'.repeat(64); }],
    ['a member beside scope', 'peer_context_mismatch', null],
    ['body seller OTHER', 'context_scope_invalid', (s, w) => { s.seller = w.other.claim; }],
    ['body pin version 2', 'context_scope_invalid', (s) => { s.listingPin = { ...s.listingPin, version: 2 }; }],
    ['body buyer OTHER', 'peer_agreement_party_mismatch', (s, w) => { s.buyer = w.other.claim; }],
  ];
  for (const [name, code, change] of cases) await t.test(name, async (t) => {
    const w = await challengeWorld(t);
    const scope = w.scopeFor();
    change?.(scope, w);
    const sql = watchSql(t);
    const answer = await w.post(await w.sign({ scope, ...(change === null ? { body: { scope, extra: true } } : {}) }));
    assert.deepEqual(summary(answer), [409, code]);
    assertNothingWritten(w, sql);
    await assertControlIssues(w);
  });
});

test('OP-1 enabling the wire challenge preserves the directly composed context path until its port', async (t) => {
  const w = await challengeWorld(t);
  const buyerSigner = { claim: w.buyer.claim, sign: w.buyer.signBytes };
  const { agent } = w;
  const authentication = createSellerTransportServerAuth({ sellerSigner: { claim: w.seller.claim, sign: w.seller.signBytes }, listingPin: w.pin, store: w.store, now: () => w.state.time });
  const oldClient = (agreementHash) => createSellerTransportClientAuth({ buyerSigner, seller: w.seller.claim, resolveJob: () => ({ listingPin: w.pin, agreementHash }), now: () => w.state.time });
  await t.test('a wire challenge without the host stop predicate refuses construction (fail closed)', () => {
    assert.throws(() => createSellerHttpHandler(agent, { authentication, context: w.route, wire: w.makeWire({ stopped: undefined }) }),{ name: 'TypeError', message: /stop predicate/ });
  });
  await t.test('the old-auth context step is not rejected by the wire challenge option: it reaches the route and gets its signed K1 refusal', async () => {
    const bundle = bundleFor({ claim: w.buyer.claim, sign: w.buyer.signBytes }, T0);
    const body = { scope: { ...w.scopeFor(JOB), buyerBundleHash: identityBundleHash(bundle) }, buyerIdentityBundle: bundle };
    const text = JSON.stringify(body);
    const client = oldClient(sellerContextScopeHash(body.scope));
    const { payload, header } = await client.request(CONTEXT_PATH, body, text);
    const res = await exchange(w.handler, { url: CONTEXT_PATH, text, header });
    assert.deepEqual([res.status, JSON.parse(res.text).error], [409, 'context_challenge_mismatch']);
    client.verifyResponse(payload, { header: res.headers[SELLER_TRANSPORT_HEADER], status: res.status, text: res.text });
  });
  await t.test('the challenge on the same handler is the wire handler: an old-domain challenge request is refused at the wire', async () => {
    const body = { scope: w.scopeFor(JOB) };
    const text = JSON.stringify(body);
    const { header } = await oldClient(sellerContextScopeHash(body.scope)).request(CHALLENGE_PATH, body, text);
    const answer = await w.post({ header, text });
    assert.deepEqual(summary(answer), [409, 'tp1_profile_missing']);
    assert.equal(answer.signature, undefined);
    assert.equal(w.rows().length, 0);
  });
  await t.test('the old route\'s challenge on the raw store still issues, with the store\'s default no-op final check', async () => {
    const answer = await w.route.challenge({ jobId: JOB2, buyer: w.buyer.claim }, { scope: w.scopeFor(JOB2) }, w.store);
    assert.match(answer.sessionNonce, NONCE);
    assert.equal(w.rows().filter((row) => row.jobId === JOB2).length, 1);
  });
  await t.test('without the wire option the old-auth challenge route is unchanged', async () => {
    const body = { scope: w.scopeFor(JOB) };
    const text = JSON.stringify(body);
    const { header } = await oldClient(sellerContextScopeHash(body.scope)).request(CHALLENGE_PATH, body, text);
    const res = await exchange(createSellerHttpHandler(agent, { authentication, context: w.route }), { url: CHALLENGE_PATH, text, header });
    assert.equal(res.status, 200);
    assert.match(JSON.parse(res.text).sessionNonce, NONCE);
    assert.equal(w.rows().filter((row) => row.jobId === JOB).length, 1);
  });
});

test('a request admitted live but expired when its effect would begin issues nothing, with the stall in {buyer access, known job}', async (t) => {
  for (const stalled of ['access', 'known']) await t.test(`the stall is in the ${stalled} callback`, async (t) => {
    const attempt = async (releasedAt) => {
      const w = await challengeWorld(t);
      const delegation = w.delegationFor({ lifetimeMs: REQUEST_LIFETIME_MS });
      const stall = gate();
      w.policy[stalled] = stalled === 'known' ? async () => { await stall.pass(); return true; } : stall.pass;
      const signed = await w.sign({ delegation, lifetimeMs: REQUEST_LIFETIME_MS });
      assert.equal(signed.payload.expiresAt, T0 + REQUEST_LIFETIME_MS, 'the request and the delegation expire together');
      const sql = watchSql(t);
      const pending = w.post(signed);
      await stall.entered;
      w.advance(releasedAt);
      stall.release();
      return { w, sql, answer: await pending };
    };
    const expired = await attempt(REQUEST_LIFETIME_MS);
    assert.deepEqual(summary(expired.answer), [408, 'peer_expired']);
    assert.equal(expired.w.calls.readCommitmentReceipt, 0, 'no readback');
    assertNothingWritten(expired.w, expired.sql);
    const control = await attempt(REQUEST_LIFETIME_MS - 1);
    assert.equal(control.answer.status, 200);
    assert.equal(control.w.rows().length, 1);
  });
});

test('A18 duplicate members, a lossy number or a lone surrogate in the challenge body is refused bad_json before hashing or ledger access; a body over 64 KiB, declared or streamed, is 413', async (t) => {
  const bad = [
    ['a duplicate member', (inner) => `{"scope":${inner},"scope":${inner}}`],
    ['a lossy number', (inner) => `{"scope":${inner.replace(/"generatedAt":\d+/, '"generatedAt":1e400')}}`],
    ['a lone surrogate', (inner) => `{"scope":${inner.replace(/"source":"[^"]*"/, '"source":"\\ud800"')}}`],
  ];
  for (const [name, build] of bad) await t.test(name, async (t) => {
    const w = await challengeWorld(t);
    const { header } = await w.sign();
    const sql = watchSql(t);
    const answer = await w.post({ header, text: build(JSON.stringify(w.scopeFor())) });
    assert.deepEqual(summary(answer), [400, 'bad_json']);
    assert.equal(answer.signature, undefined);
    assert.equal(sql.reads(), 0, 'no ledger read');
    assert.equal(w.calls.connection, 0, 'no signature check');
    assertNothingWritten(w, sql);
  });
  for (const [name, options] of [['declared over 64 KiB', { headers: { 'content-length': String(MAX_REQUEST_BYTES + 1) } }],
    ['streamed over 64 KiB', { chunks: [Buffer.alloc(MAX_REQUEST_BYTES / 2, 'a'), Buffer.alloc(MAX_REQUEST_BYTES / 2 + 1, 'a')] }]]) await t.test(name, async (t) => {
    const w = await challengeWorld(t);
    const signed = await w.sign();
    const sql = watchSql(t);
    const answer = await w.post({ header: signed.header, text: 'a'.repeat(MAX_REQUEST_BYTES + 1), ...options });
    assert.deepEqual(summary(answer), [413, 'body_too_large']);
    assert.equal(answer.signature, undefined);
    assert.equal(sql.reads(), 0, 'no ledger read');
    assertNothingWritten(w, sql);
  });
});

test('K2-T14 a 4,097-character header is peer_envelope_invalid 401, and a request signed for the context path sent to the challenge path is peer_request_mismatch', async (t) => {
  const w = await challengeWorld(t);
  const sql = watchSql(t);
  const long = await w.post({ header: 'a'.repeat(4097), text: JSON.stringify({ scope: w.scopeFor() }) });
  assert.deepEqual(summary(long), [401, 'peer_envelope_invalid']);
  assert.equal(long.signature, undefined);
  const wrongPath = await w.sign({ path: CONTEXT_PATH });
  const answer = await w.post({ ...wrongPath, url: CHALLENGE_PATH });
  assert.deepEqual(summary(answer), [401, 'peer_request_mismatch']);
  await wrongPath.verify(answer);
  assertNothingWritten(w, sql);
  await assertControlIssues(w);
});

test('K1-A33/A34 a full context-record store gives peer_context_capacity 503 and a seller clock of 2^53 gives peer_clock_invalid 503, with no write', async (t) => {
  await t.test('a full context-record store', async (t) => {
    const w = await challengeWorld(t, { store: { maxContextRecords: 1 } });
    w.seedContextRecord();
    const sql = watchSql(t);
    assert.deepEqual(summary(await w.post(await w.sign())), [503, 'peer_context_capacity']);
    assertNothingWritten(w, sql);
  });
  await t.test('a ledger clock of 2^53', async (t) => {
    const w = await challengeWorld(t);
    w.state.ledgerClock = () => 2 ** 53;
    const sql = watchSql(t);
    assert.deepEqual(summary(await w.post(await w.sign())), [503, 'peer_clock_invalid']);
    assertNothingWritten(w, sql);
    w.state.ledgerClock = null;
    await assertControlIssues(w);
  });
});

test('K5-A11/A18 with less free capacity than one purchase allotment the challenge is refused seller_not_ready with no row and no file', async (t) => {
  // P11b2's coordinator is not in this base: the readiness predicate here is its K5 threshold, free = maxRecords - used >= P.
  const readyAt = (used) => () => K5_MAX_RECORDS - used >= K5_PURCHASE_ALLOTMENT;
  const w = await challengeWorld(t);
  w.state.ready = readyAt(33);
  const sql = watchSql(t);
  assert.deepEqual(summary(await w.post(await w.sign())), [503, 'seller_not_ready']);
  assertNothingWritten(w, sql);
  w.state.ready = readyAt(32);
  await assertControlIssues(w);
});

test('the same job, buyer and scope twice, including the same signed request twice, returns the same nonce with one ledger row', async (t) => {
  const w = await challengeWorld(t);
  const signed = await w.sign();
  const first = await w.post(signed);
  const sameRequest = await w.post(signed);
  const freshRequest = await w.post(await w.sign());
  for (const answer of [sameRequest, freshRequest]) assert.deepEqual([answer.status, answer.body], [200, first.body]);
  assert.equal(w.rows().length, 1);
  assert.equal(w.journalFiles(), 0);
});

test('two concurrent requests for the last overall slot: one issued, one context_challenge_limit 429', async (t) => {
  const w = await challengeWorld(t);
  w.seedRows(OVERALL_LIMIT - 1);
  const stalls = [gate(), gate()];
  w.policy.access = () => stalls.shift().pass();
  const [first, second] = await Promise.all([w.sign({ jobId: JOB }), w.sign({ jobId: JOB2 })]);
  const answers = [w.post(first), w.post(second)];
  const [firstStall, secondStall] = [stalls[0], stalls[1]];
  await Promise.all([firstStall.entered, secondStall.entered]);
  firstStall.release();
  secondStall.release();
  const results = (await Promise.all(answers)).map(summary).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(results, [[200, undefined], [429, 'context_challenge_limit']]);
  assert.equal(w.rows().length, OVERALL_LIMIT);
});

test('a buyer-access callback stalled past 10 s answers 503 with cause timeout and does not delay another job\'s challenge', async (t) => {
  for (const stalled of ['access', 'known']) await t.test(`the stall is in the ${stalled} callback`, async (t) => {
    const w = await challengeWorld(t);
    // Only the first call stalls; every later call answers at once.
    const stallFirstCall = (stall) => { let first = true; return async () => { if (first) { first = false; await stall.pass(); } return stalled === 'known' ? true : undefined; }; };
    const [stalledRequest, otherJob, direct] = [await w.sign({ jobId: JOB }), await w.sign({ jobId: JOB2 }), await w.sign({ jobId: JOB })];
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const stall = gate();
    w.policy[stalled] = stallFirstCall(stall);
    const pending = w.post(stalledRequest);
    await stall.entered;
    assert.equal((await w.post(otherJob)).status, 200, 'the other job issues while the first is stalled');
    t.mock.timers.tick(STALL_DEADLINE_MS);
    assert.deepEqual(summary(await pending), [503, 'session_admission_unavailable']);
    assert.equal(w.rows().length, 1, 'only the other job holds a row');
    const secondStall = gate();
    w.policy[stalled] = stallFirstCall(secondStall);
    const call = w.route.challengeOnWire(w.wire, { header: direct.header, method: 'POST', path: CHALLENGE_PATH, rawBody: Buffer.from(direct.text), body: direct.body, onOpened: () => {} });
    await secondStall.entered;
    t.mock.timers.tick(STALL_DEADLINE_MS);
    const error = await rejection(call);
    assert.deepEqual([error.code, error.status, error.cause?.name], ['session_admission_unavailable', 503, 'TimeoutError']);
  });
});

test('with the guard off the challenge route answers kit_operation_guard_off and issues nothing', async (t) => {
  t.after(() => guard.setKitOperationGuardForTest('testnet-tp1'));
  await t.test('off before the request: refused before admission and before any ledger access', async (t) => {
    const w = await challengeWorld(t);
    const signed = await w.sign();
    const sql = watchSql(t);
    guard.setKitOperationGuardForTest('off');
    const answer = await w.post(signed);
    guard.setKitOperationGuardForTest('testnet-tp1');
    assert.deepEqual(summary(answer), [503, 'kit_operation_guard_off']);
    await signed.verify(answer);
    assert.equal(w.calls.access, 0, 'the guard comes before admission');
    assert.equal(sql.reads(), 0, 'no ledger access');
    assertNothingWritten(w, sql);
  });
  await t.test('turned off inside the ledger transaction: step 16 refuses with the same code', async (t) => {
    const w = await challengeWorld(t);
    w.state.sessionState = () => { guard.setKitOperationGuardForTest('off'); return null; };
    const signed = await w.sign();
    const sql = watchSql(t);
    const answer = await w.post(signed);
    guard.setKitOperationGuardForTest('testnet-tp1');
    assert.deepEqual(summary(answer), [503, 'kit_operation_guard_off']);
    await signed.verify(answer);
    assertNothingWritten(w, sql);
  });
});

test('every refusal after opening is signed over its exact status and body, and refusals before opening carry no seller signature', async (t) => {
  const after = [
    ['context_scope_invalid', async (w) => w.sign({ scope: { ...w.scopeFor(), source: 'TEST other source' } })],
    ['peer_job_mismatch', async (w) => w.sign({ scope: w.scopeFor(JOB2) })],
    ['peer_context_mismatch', async (w) => w.sign({ body: { scope: w.scopeFor(), extra: true } })],
    ['peer_request_mismatch', async (w) => w.sign({ path: CONTEXT_PATH })],
    ['seller_not_ready', async (w) => { w.state.ready = () => false; return w.sign(); }],
    ['seller_stopped', async (w) => { w.state.stop = () => true; return w.sign(); }],
  ];
  for (const [code, build] of after) await t.test(`${code} is signed`, async (t) => {
    const w = await challengeWorld(t);
    const signed = await build(w);
    const answer = await w.post(signed);
    assert.equal(answer.body.error, code);
    await signed.verify(answer);
    await assert.rejects(signed.verify({ ...answer, status: answer.status === 409 ? 503 : 409 }), 'another status does not verify');
    await assert.rejects(signed.verify({ ...answer, text: answer.text.replace('error', 'errer') }), 'another body does not verify');
  });
  await t.test('before opening: bad_json, body_too_large and a malformed envelope carry no signature', async (t) => {
    const w = await challengeWorld(t);
    const signed = await w.sign();
    const answers = [await w.post({ header: signed.header, text: '{"a":1,"a":2}' }), await w.post({ header: signed.header, text: 'a'.repeat(MAX_REQUEST_BYTES + 1) }),
      await w.post({ header: 'not an envelope', text: signed.text })];
    assert.deepEqual(answers.map(summary), [[400, 'bad_json'], [413, 'body_too_large'], [401, 'peer_envelope_invalid']]);
    for (const answer of answers) assert.equal(answer.signature, undefined);
  });
});

test('challenge-issued-before-response-restart-reuses-nonce', async (t) => {
  const w = await challengeWorld(t);
  const signed = await w.sign();
  const first = await w.post(signed);
  assert.equal(first.status, 200);
  w.restart();
  const sql = watchSql(t);
  const again = await w.post(signed);
  assert.deepEqual([again.status, again.body], [200, first.body], 'the same unexpired nonce and expiry');
  assert.equal(sql.writes(), 0, 'no second issuance');
  assert.equal(w.rows().length, 1);
  assert.equal(w.journalFiles(), 0, 'no wire reservation');
  await signed.verify(again);
});

test('challenge-last-slot-winner-restart', async (t) => {
  const w = await challengeWorld(t);
  w.seedRows(OVERALL_LIMIT - 1);
  const [winner, loser] = [await w.sign({ jobId: JOB }), await w.sign({ jobId: JOB2 })];
  const won = await w.post(winner);
  assert.equal(won.status, 200);
  assert.deepEqual(summary(await w.post(loser)), [429, 'context_challenge_limit']);
  w.restart();
  const repeat = await w.post(winner);
  assert.deepEqual([repeat.status, repeat.body], [200, won.body], 'the winner reuses its row after the restart');
  assert.deepEqual(summary(await w.post(loser)), [429, 'context_challenge_limit']);
  assert.equal(w.rows().length, OVERALL_LIMIT);
  assert.ok(w.rows().every((row) => row.issuedAt > T0 - HOUR_MS));
});

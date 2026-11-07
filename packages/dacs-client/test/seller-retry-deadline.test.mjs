import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from '@kynesyslabs/dacs';
import { storedWorld, PATHS, bodyFor } from './helpers/stored-request-fixture.mjs';
import { signatureCommitmentAnchor } from '../src/dacs/commit-on-signature.mjs';
import { SellerTlsUnusableError, sellerFailureAttempt } from '../src/dacs/seller-http.mjs';
const P = PATHS.proposals;
const timeout = e => e.causeCode === 'timeout';

for (const boundary of ['storage', 'evidence', 'authority', 'connection-check', 'host-sign', 'signed', 'check']) {
  test(`one absolute deadline stops a send after ${boundary} consumes the budget`, async t => {
    t.mock.method(AbortSignal, 'timeout', () => new AbortController().signal);
    const s = await storedWorld(t); let authentication = s.auth, requestRecords = s.records(), path = P;
    if (boundary === 'storage') requestRecords = { ...requestRecords, start(...args) { const attempt = s.records().start(...args); s.advance(15000); return attempt; } };
    if (boundary === 'authority') s.w.state.gate = async () => { s.advance(15000); };
    if (boundary === 'evidence') {
      path = PATHS.payments;
      const bytes = value => Buffer.from(canonicalize(value));
      authentication = s.w.createSellerWireAuthentication({ ...s.w.options, evidence: async () => {
        s.advance(15000); return { commitment: bytes(s.made.anchored), agreement: bytes(s.made.agreement), signedListing: bytes(s.made.listing) };
      } });
    }
    if (boundary === 'connection-check') {
      let reads = 0;
      authentication = s.w.createSellerWireAuthentication({ ...s.w.options, admission: { ...s.w.admission, currentLocal() { if (++reads === 2) s.advance(15000); return s.w.local; } } });
    }
    if (boundary === 'host-sign') authentication = s.w.createSellerWireAuthentication({ ...s.w.options, sessionSigner: { claim: s.w.session.claim,
      async sign(bytes) { s.w.state.signs.push(bytes); s.advance(15000); return s.w.session.sign(bytes); } } });
    if (boundary === 'signed') authentication = { ...s.auth, async request(...args) { const signed = await s.auth.request(...args); s.advance(15000); return signed; } };
    if (boundary === 'check') requestRecords = { ...requestRecords, start(...args) { const attempt = s.records().start(...args); return { ...attempt, check() { attempt.check(); s.advance(15000); } }; } };
    const client = s.client({ authentication, requestRecords });
    await assert.rejects(client.request(path, bodyFor(path)), timeout);
    assert.equal(s.fetches.length, 0); assert.deepEqual(s.delays, []); assert.equal(client.failureCause, 'timeout');
    assert.equal(s.w.state.signs.length, ['host-sign', 'signed', 'check'].includes(boundary) ? 1 : 0);
    assert.equal(s.record(path).attempts, 1); assert.equal(s.record(path).clearAttempts, 1);
  });
}

const earlierUnknown = (client) => e => e.answerClass === 'unknown' && e.causeCode === 'status-5xx' && sellerFailureAttempt(e).dispatched === undefined
  && client.failureCause === 'status-5xx' && client.failureDispatched === undefined;

test('a retry storage overrun clears only that unsent attempt and returns the earlier unknown', async t => {
  t.mock.method(AbortSignal, 'timeout', () => new AbortController().signal);
  const s = await storedWorld(t); let starts = 0;
  const records = s.records(), requestRecords = { ...records, start(...args) { const attempt = records.start(...args); if (++starts === 2) s.advance(15000); return attempt; } };
  const client = s.client({ requestRecords, respond: init => s.reply(init, 503, { error: 'seller_effect_pending' }) });
  await assert.rejects(client.propose(bodyFor(P)), earlierUnknown(client));
  assert.equal(s.fetches.length, 1); assert.equal(s.w.state.signs.length, 1);
  assert.equal(s.record(P).attempts, 2); assert.equal(s.record(P).clearAttempts, 1);
});

test('a retry whose signer fails clears only that unsent attempt and returns the earlier unknown', async t => {
  const s = await storedWorld(t); let signs = 0;
  const authentication = s.w.createSellerWireAuthentication({ ...s.w.options, sessionSigner: { claim: s.w.session.claim, sign(bytes) { if (++signs === 2) throw new Error('TEST-sign'); return s.w.session.sign(bytes); } } });
  const client = s.client({ authentication, respond: init => s.reply(init, 503, { error: 'seller_effect_pending' }) });
  await assert.rejects(client.propose(bodyFor(P)), earlierUnknown(client));
  assert.equal(signs, 2); assert.equal(s.fetches.length, 1); assert.deepEqual(s.delays, [5000]);
  assert.equal(s.record(P).attempts, 2); assert.equal(s.record(P).clearAttempts, 1);
});

test('a retry stopped by the local certificate guard returns the earlier unknown', async t => {
  const s = await storedWorld(t); let signs = 0;
  const authentication = { ...s.auth, async request(...args) { if (++signs === 2) throw new SellerTlsUnusableError('TEST-TLS'); return s.auth.request(...args); } };
  const client = s.client({ authentication, respond: init => s.reply(init, 503, { error: 'seller_effect_pending' }) });
  await assert.rejects(client.propose(bodyFor(P)), earlierUnknown(client));
  assert.equal(s.fetches.length, 1); assert.deepEqual(s.delays, [5000]);
  assert.equal(s.record(P).attempts, 2); assert.equal(s.record(P).clearAttempts, 1);
});

test('a failed signer is never retried as an unknown dispatch', async t => {
  const s = await storedWorld(t); let signs = 0;
  const authentication = s.w.createSellerWireAuthentication({ ...s.w.options, sessionSigner: { claim: s.w.session.claim, sign() { signs++; throw new Error('TEST-sign'); } } });
  await assert.rejects(s.client({ authentication }).propose(bodyFor(P)), e => e.causeCode === 'client-sign' && e.answerClass === 'not-sent');
  assert.equal(signs, 1); assert.equal(s.fetches.length, 0); assert.deepEqual(s.delays, []); assert.equal(s.record(P).clearAttempts, 1);
});

test('a swallowed signature-request failure records its bounded class and cause in a neutral event', async t => {
  const s = await storedWorld(t);
  const client = s.client({ respond() { throw Object.assign(new Error('TEST-network'), { code: 'ECONNRESET' }); } });
  let done;
  const seller = { ...client, commitOnSignature(...args) { done = client.commitOnSignature(...args); return done; } };
  const anchor = signatureCommitmentAnchor({ onCreateAuthorized(_input, fn) { fn({ version: 1 }); }, async anchorAgreement() { return {}; } }, seller, true);
  await anchor.anchorAgreement({ artifact: { jobId: s.w.job.jobId } });
  await assert.rejects(done); await new Promise(resolve => setImmediate(resolve));
  const event = s.p.ops.history(s.p.op.id).find(e => e.type === 'seller_request_failed');
  assert.ok(event); assert.deepEqual(event.data, { code: 'seller_unavailable', answerClass: 'unknown', causeCode: 'network' });
});


test('an already exhausted deadline creates no attempt and never calls the signer', async t => {
  const s = await storedWorld(t);
  const client = s.client({ timeoutMs: 0 });
  await assert.rejects(client.propose(bodyFor(P)), timeout);
  assert.equal(s.record(P), undefined); assert.equal(s.w.state.signs.length, 0); assert.equal(s.fetches.length, 0);
  assert.equal(client.failureCause, 'timeout'); assert.equal(client.failureDispatched, false);
});

test('authenticated read calls have no stored attempt and send once', async t => {
  const s = await storedWorld(t);
  await assert.rejects(s.client({ respond: init => s.reply(init, 503, { error: 'seller_effect_pending' }) }).agreementState({ jobId: s.w.job.jobId }));
  assert.equal(s.record(PATHS.state), undefined); assert.equal(s.fetches.length, 1); assert.deepEqual(s.delays, []);
});


test('a late retry wake preserves the prior response cause for the error and transport observer', async t => {
  const s = await storedWorld(t);
  s.clock.sleep = async ms => { s.delays.push(ms); s.advance(15000); };
  const client = s.client({ respond: init => s.reply(init, 503, { error: 'seller_effect_pending' }) });
  await assert.rejects(client.propose(bodyFor(P)), e => e.answerClass === 'unknown' && e.causeCode === 'status-5xx');
  assert.equal(client.failureCause, 'status-5xx'); assert.equal(s.fetches.length, 1);
});

// How a bootstrap that the seller refused or failed ends a purchase, through the client's public protocol factory against the
// kit's real challenge route. The context step answers through a DEM delivery context capability whose resolver each test
// scripts: a returned Vet non-pass, or a thrown signed seller refusal built by the client's own answer table.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as wire from '@kynesyslabs/dacs/wire';
import { CHALLENGE, JOB, JOB2, buyer, bootstrapThroughChallenge, bootstrapWorld, walletSign } from './helpers/kit-bootstrap-world.mjs';

const { createDemDeliveryContext, DEM_DELIVERY_CONTEXT_SOURCE } = await import('../src/dacs/dem-delivery-context-consumer.mjs');
const { SellerRefusedError, SellerUnavailableError } = await import('../src/dacs/seller-http.mjs');
const { classifySellerAnswer, SELLER_ANSWER_CLASS } = await import('../src/dacs/seller-response-class.mjs');
const { purchaseNext } = await import('../src/index.mjs');

const { challengeHostFor } = await import('./helpers/bootstrap-challenge-host.mjs');

const CONTEXT = wire.DACS_SELLER_HTTP_PATHS.context;
const FAILED_BOOTSTRAP_CODES = ['context_challenge_failed', 'context_challenge_consumed', 'context_challenge_expired', 'context_challenge_mismatch', 'context_job_closed', 'context_admission_closed'];
// Further job ids for tables that need one purchase per row.
const MORE_JOBS = ['01J8N4YV7YVYQ4DB7M8T4C7W1B', '01J8N4YV7YVYQ4DB7M8T4C7W1C', '01J8N4YV7YVYQ4DB7M8T4C7W1D', '01J8N4YV7YVYQ4DB7M8T4C7W1E', '01J8N4YV7YVYQ4DB7M8T4C7W1F',
  '01J8N4YV7YVYQ4DB7M8T4C7W1G', '01J8N4YV7YVYQ4DB7M8T4C7W1H', '01J8N4YV7YVYQ4DB7M8T4C7W1J', '01J8N4YV7YVYQ4DB7M8T4C7W1K', '01J8N4YV7YVYQ4DB7M8T4C7W1M'];
const FRESH_START = /start a new purchase/i;
const NO_WORK_CLAIM = /nothing was (?:sent|written)|did no work|wrote nothing/i;
const refusal = (expected) => (error) => { assert.equal(error.code, expected); return true; };
const protocolOf = (purchase) => purchase.get().state.protocol;

/** The client's error for a signed seller answer on the context route, classified by the client's own answer table. */
function signedRefusal(status, body) {
  const { answerClass, code } = classifySellerAnswer({ status, signed: true, body }, { path: CONTEXT, dispatched: true });
  assert.ok([SELLER_ANSWER_CLASS.DEFINITE, SELLER_ANSWER_CLASS.FAILED_BOOTSTRAP].includes(answerClass), `${status} ${code} is a refusal`);
  return Object.assign(new SellerRefusedError(code ?? (status === 429 ? 'seller_rate_limited' : `http_${status}`), body.message, status, answerClass), body.cause ? { cause: body.cause } : {});
}
const failedBootstrap = (code, cause) => signedRefusal(409, { error: code, message: `TEST the seller refused ${code}`, ...(cause ? { cause } : {}) });
const timedOut = () => new SellerUnavailableError('TEST the context answer did not arrive', 'timeout');
const vetNonPass = (errorClass = 'counterparty', extra = {}) => ({ disposition: 'rejected', reason: 'TEST the buyer Vet did not pass', code: 'party_vet_non_pass', errorClass, ...extra });

/** The kit world with a DEM delivery context capability; `answer(...)` queues what the next context reads return or throw. */
async function contextWorld(t) {
  const calls = [], script = [];
  const capability = createDemDeliveryContext({
    authority: 'TEST-bootstrap-failure',
    async resolveBuyer(request) {
      calls.push(request);
      const next = script.length ? script.shift() : timedOut();
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(request) : next;
    },
    async resolveSeller() { throw new TypeError('TEST no seller context in these tests'); },
  });
  const w = await bootstrapWorld(t, { demDeliveryContext: capability, startHost: challengeHostFor(t) });
  return Object.assign(w, { calls, answer: (...answers) => script.push(...answers), contextPurchase: (jobId = JOB) => w.purchase(jobId, { agreementContext: DEM_DELIVERY_CONTEXT_SOURCE }) });
}

/** Runs the bootstrap to the context step and returns the wallet's presentation signature. */
async function toContextStep(w, purchase) {
  const { presentation } = await bootstrapThroughChallenge(w, purchase);
  return walletSign(presentation.message);
}

/** Everything that would show a new seller request, context read or wallet message. */
const activity = (w) => ({ policies: w.policies, requests: w.requests.length, signs: w.signs.length, contextReads: w.calls.length });

/** Each bootstrap step on an ended purchase refuses with the end's code and sends, reads and asks nothing. */
async function assertStaysEnded(w, purchase, code, signature) {
  const before = activity(w);
  await assert.rejects(w.service().identityRequest(purchase.get(), buyer.address), refusal(code));
  await assert.rejects(w.service().agreementDelegation(purchase.get(), null), refusal(code));
  await assert.rejects(w.service().planRequest(purchase.get(), signature), refusal(code));
  assert.deepEqual(activity(w), before, 'nothing is sent, read or asked of the wallet');
}

/** Makes the next terminal write fail as if the process stopped before it. */
function failNextTerminalWrite(w) {
  const ops = w.ops(), transition = ops.transition;
  ops.transition = (id, from, to, options) => {
    if (to !== 'agreement_rejected') return transition.call(ops, id, from, to, options);
    ops.transition = transition;
    throw new Error('TEST the process stopped before the terminal write');
  };
}

const terminalEvents = (w, purchase) => w.ops().history(purchase.id).filter((event) => ['bootstrap-failed', 'agreement-rejected'].includes(event.data.stage));

test("a definite failed bootstrap through the real consumer and public service ends the purchase bootstrap-failed with the seller's code, offers an explicit fresh Start with a new job, challenge and delegation, and prompts the wallet 0 times until the user starts", async (t) => {
  const w = await contextWorld(t), purchase = w.contextPurchase();
  const signature = await toContextStep(w, purchase);
  const ended = protocolOf(purchase);
  w.answer(failedBootstrap('context_job_closed'));
  await assert.rejects(w.service().planRequest(purchase.get(), signature), refusal('context_job_closed'));

  const row = purchase.get();
  assert.equal(row.status, 'agreement_rejected');
  assert.equal(row.state.protocol.stage, 'bootstrap-failed');
  assert.deepEqual(row.state.protocol.bootstrapEnd, { kind: 'failed-bootstrap', code: 'context_job_closed', status: 409 });
  assert.match(purchaseNext(row), FRESH_START);
  await assertStaysEnded(w, purchase, 'context_job_closed', signature);

  // Only the user starts the new purchase: its own job, delegation and seller challenge.
  const fresh = w.contextPurchase(JOB2);
  await bootstrapThroughChallenge(w, fresh);
  const next = protocolOf(fresh);
  assert.notEqual(fresh.get().terms.protocol.jobId, row.terms.protocol.jobId);
  assert.notDeepEqual(next.sessionDelegation.payload, ended.sessionDelegation.payload);
  assert.notEqual(next.challenge.sessionNonce, ended.challenge.sessionNonce);
  assert.equal(w.sent(CHALLENGE).length, 2);
});

test("context_challenge_consumed after the client's own context timeout stops the job and records no claim that the seller did no work", async (t) => {
  const w = await contextWorld(t), purchase = w.contextPurchase();
  const signature = await toContextStep(w, purchase);
  w.answer(timedOut(), failedBootstrap('context_challenge_consumed'));
  await assert.rejects(w.service().planRequest(purchase.get(), signature), refusal('agreement_context_held'));
  assert.equal(purchase.get().status, 'agreement_pending', 'an unknown answer ends nothing');

  const error = await w.service().planRequest(purchase.get(), signature).catch((thrown) => thrown);
  assert.equal(error.code, 'context_challenge_consumed');
  assert.doesNotMatch(error.message, NO_WORK_CLAIM);
  const row = purchase.get(), attempts = row.state.protocol.attempts.filter((attempt) => attempt.step === 'agreement-context');
  assert.equal(row.status, 'agreement_rejected');
  assert.equal(row.state.protocol.stage, 'bootstrap-failed');
  assert.deepEqual(attempts.map((attempt) => attempt.outcome), ['indeterminate', 'rejected'], 'the earlier unknown attempt stays');
  assert.ok(attempts.every((attempt) => !('written' in attempt)), 'no attempt claims nothing was written');
  assert.doesNotMatch(purchaseNext(row), NO_WORK_CLAIM);
});

test('a Vet non-pass keeps party_vet_non_pass and its errorClass through captureAnswer, moves to agreement_rejected, and makes no Agreement signature or anchor and offers no fresh Start', async (t) => {
  const w = await contextWorld(t), purchase = w.contextPurchase();
  const signature = await toContextStep(w, purchase);
  w.answer(vetNonPass('permanent'));
  await assert.rejects(w.service().planRequest(purchase.get(), signature), refusal('party_vet_non_pass'));

  const row = purchase.get(), p = row.state.protocol;
  assert.equal(row.status, 'agreement_rejected');
  assert.equal(p.stage, 'agreement-rejected');
  assert.deepEqual(p.bootstrapEnd, { kind: 'vet-non-pass', code: 'party_vet_non_pass', errorClass: 'permanent', reason: 'TEST the buyer Vet did not pass' });
  assert.equal(p.planned, undefined, 'no Agreement was planned for signing');
  assert.equal(p.agreement, undefined, 'no Agreement was signed or anchored');
  assert.deepEqual(w.requests.map((request) => request.path), [CHALLENGE], 'no request after the challenge');
  assert.doesNotMatch(purchaseNext(row), /new purchase|start again|fresh/i);
});

test('a party_vet_non_pass answer with an errorClass outside counterparty and permanent, or with extra members, stays held indeterminate', async (t) => {
  const w = await contextWorld(t);
  for (const [jobId, answer] of [[JOB, vetNonPass('transient')], [JOB2, vetNonPass('counterparty', { detail: 'TEST extra member' })]]) {
    const purchase = w.contextPurchase(jobId);
    const signature = await toContextStep(w, purchase);
    w.answer(answer);
    await assert.rejects(w.service().planRequest(purchase.get(), signature), refusal('agreement_context_held'));
    const row = purchase.get();
    assert.equal(row.status, 'agreement_pending');
    assert.equal(row.state.protocol.bootstrapEnd, undefined);
    assert.equal(row.state.protocol.attempts.at(-1).outcome, 'indeterminate');
  }
});

test('after a restart and on repeated requests both terminal states stay, nothing is retried, and no wallet prompt appears; the stored code, cause and errorClass equal the originals', async (t) => {
  const w = await contextWorld(t);
  const refused = w.contextPurchase(JOB), failed = w.contextPurchase(JOB2);
  const refusedSignature = await toContextStep(w, refused), failedSignature = await toContextStep(w, failed);
  w.answer(vetNonPass('counterparty'), failedBootstrap('context_challenge_failed', 'TEST-vet-source-unavailable'));
  await assert.rejects(w.service().planRequest(refused.get(), refusedSignature), refusal('party_vet_non_pass'));
  await assert.rejects(w.service().planRequest(failed.get(), failedSignature), refusal('context_challenge_failed'));
  const originals = [protocolOf(refused).bootstrapEnd, protocolOf(failed).bootstrapEnd];
  assert.deepEqual(originals, [
    { kind: 'vet-non-pass', code: 'party_vet_non_pass', errorClass: 'counterparty', reason: 'TEST the buyer Vet did not pass' },
    { kind: 'failed-bootstrap', code: 'context_challenge_failed', status: 409, cause: 'TEST-vet-source-unavailable' },
  ]);

  w.restart();
  for (let repeat = 0; repeat < 2; repeat++) {
    await assertStaysEnded(w, refused, 'party_vet_non_pass', refusedSignature);
    await assertStaysEnded(w, failed, 'context_challenge_failed', failedSignature);
  }
  assert.deepEqual([protocolOf(refused).bootstrapEnd, protocolOf(failed).bootstrapEnd], originals);
  assert.deepEqual([refused.get().status, failed.get().status], ['agreement_rejected', 'agreement_rejected']);
  assert.deepEqual([protocolOf(refused).stage, protocolOf(failed).stage], ['agreement-rejected', 'bootstrap-failed']);
});

test('a classified failure thrown by the resolver keeps its code and cause instead of becoming generic held text', async (t) => {
  const w = await contextWorld(t), purchase = w.contextPurchase();
  const signature = await toContextStep(w, purchase);
  w.answer(failedBootstrap('context_challenge_failed', 'TEST-vet-source-unavailable'));
  await assert.rejects(w.service().planRequest(purchase.get(), signature), refusal('context_challenge_failed'));
  const p = protocolOf(purchase);
  assert.deepEqual(p.bootstrapEnd, { kind: 'failed-bootstrap', code: 'context_challenge_failed', status: 409, cause: 'TEST-vet-source-unavailable' });
  const attempt = p.attempts.at(-1);
  assert.match(attempt.reason, /^context_challenge_failed: /);
  assert.doesNotMatch(attempt.reason, /DEM delivery context failed/);
});

test('an unused challenge that expired before the presentation was accepted ends the bootstrap bootstrap-failed with the fresh-Start guidance', async (t) => {
  const w = await contextWorld(t), purchase = w.contextPurchase();
  const signature = await toContextStep(w, purchase);
  w.clock.time = protocolOf(purchase).challenge.expiresAt;
  await assert.rejects(w.service().planRequest(purchase.get(), signature), refusal('context_challenge_expired'));

  const row = purchase.get();
  assert.equal(row.status, 'agreement_rejected');
  assert.equal(row.state.protocol.stage, 'bootstrap-failed');
  assert.deepEqual(row.state.protocol.bootstrapEnd, { kind: 'failed-bootstrap', code: 'context_challenge_expired', local: true });
  assert.equal(row.state.protocol.buyerBundle, undefined, 'the presentation was never accepted');
  assert.equal(w.calls.length, 0, 'no context was read');
  assert.match(purchaseNext(row), FRESH_START);
  await assertStaysEnded(w, purchase, 'context_challenge_expired', signature);
});

test('a terminal transition that loses its compare-and-set to a concurrent stage change adopts the stored row and makes no second transition', async (t) => {
  const w = await contextWorld(t), purchase = w.contextPurchase();
  const signature = await toContextStep(w, purchase);
  const ops = w.ops(), read = ops.get, rivalEnd = { kind: 'failed-bootstrap', code: 'context_admission_closed', status: 409 };
  // Another process ends the purchase right after this one re-reads the row and before its own terminal write.
  w.answer(() => {
    ops.get = (...args) => {
      ops.get = read;
      const row = read.apply(ops, args), p = row.state.protocol;
      ops.transition(row.id, row.status, 'agreement_rejected', { state: { protocol: { ...p, stage: 'bootstrap-failed', bootstrapEnd: rivalEnd, revision: p.revision + 1 } }, event: 'TEST-rival-end', data: { stage: 'bootstrap-failed' } });
      return row;
    };
    return vetNonPass();
  });
  await assert.rejects(w.service().planRequest(purchase.get(), signature), refusal('context_admission_closed'));
  assert.deepEqual(protocolOf(purchase).bootstrapEnd, rivalEnd, 'the stored end is adopted');
  assert.deepEqual(terminalEvents(w, purchase).map((event) => event.type), ['TEST-rival-end'], 'no second transition');
});

test('no signed refusal on a dispatched context request records "wrote nothing": a table of each failed-bootstrap code, context_challenge_consumed, peer_job_invalid, peer_job_mismatch, another signed 4xx with an error, and a 429; the six context codes and the 429 are a definite failed bootstrap, the others a definite refusal; none sets written: false; earlier dispatches and any compensation or readback decision are preserved', async (t) => {
  const w = await contextWorld(t);
  const rows = [
    ...FAILED_BOOTSTRAP_CODES.map((code) => ({ error: failedBootstrap(code), ends: { kind: 'failed-bootstrap', code, status: 409 } })),
    { error: signedRefusal(429, { message: 'TEST the seller is busy' }), ends: { kind: 'failed-bootstrap', code: 'seller_rate_limited', status: 429 } },
    { error: signedRefusal(400, { error: 'peer_job_invalid', message: 'TEST invalid job' }), ends: null },
    { error: signedRefusal(409, { error: 'peer_job_mismatch', message: 'TEST another job' }), ends: null },
    { error: signedRefusal(403, { error: 'TEST_other_refusal', message: 'TEST refused' }), ends: null },
  ];
  assert.equal(rows.length, MORE_JOBS.length);
  for (const [index, { error, ends }] of rows.entries()) {
    const purchase = w.contextPurchase(MORE_JOBS[index]);
    const signature = await toContextStep(w, purchase);
    w.answer(timedOut(), error);
    await assert.rejects(w.service().planRequest(purchase.get(), signature), refusal('agreement_context_held'));
    const earlier = protocolOf(purchase).attempts;
    await assert.rejects(w.service().planRequest(purchase.get(), signature), refusal(ends ? error.code : 'agreement_context_held'));

    const row = purchase.get(), p = row.state.protocol, last = p.attempts.at(-1);
    assert.equal(error.answerClass, ends ? SELLER_ANSWER_CLASS.FAILED_BOOTSTRAP : SELLER_ANSWER_CLASS.DEFINITE, error.code);
    assert.equal(row.status, ends ? 'agreement_rejected' : 'agreement_pending', error.code);
    assert.deepEqual(p.bootstrapEnd, ends ?? undefined, error.code);
    assert.deepEqual(p.attempts.slice(0, earlier.length), earlier, 'earlier dispatch notes stay');
    assert.equal(last.outcome, 'rejected');
    assert.ok(last.reason.startsWith(`${error.code}: `), 'the attempt names the seller code');
    assert.ok(p.attempts.every((attempt) => !('written' in attempt)), `${error.code} claims nothing about seller writes`);
  }
});

test('a cut between a verified definite answer and the terminal write ends the purchase once on the next explicit call with no wallet prompt', async (t) => {
  const w = await contextWorld(t), purchase = w.contextPurchase();
  const signature = await toContextStep(w, purchase);
  w.answer(timedOut(), failedBootstrap('context_challenge_mismatch'), failedBootstrap('context_challenge_mismatch'));
  await assert.rejects(w.service().planRequest(purchase.get(), signature), refusal('agreement_context_held'));
  const earlier = protocolOf(purchase).attempts;
  failNextTerminalWrite(w);
  await assert.rejects(w.service().planRequest(purchase.get(), signature), /TEST the process stopped/);
  assert.equal(purchase.get().status, 'agreement_pending');

  w.restart();
  const before = activity(w);
  await assert.rejects(w.service().planRequest(purchase.get(), signature), refusal('context_challenge_mismatch'));
  assert.deepEqual(activity(w), { ...before, contextReads: before.contextReads + 1 }, 'the context is read once more and nothing else is asked');
  assert.equal(purchase.get().status, 'agreement_rejected');
  assert.equal(terminalEvents(w, purchase).length, 1, 'the purchase ended once');
  assert.deepEqual(protocolOf(purchase).attempts.slice(0, earlier.length), earlier);
  await assertStaysEnded(w, purchase, 'context_challenge_mismatch', signature);
});

test('status and cause land in one write; a write failure leaves neither', async (t) => {
  const w = await contextWorld(t), purchase = w.contextPurchase();
  const signature = await toContextStep(w, purchase);
  const stage = protocolOf(purchase).stage;
  w.answer(failedBootstrap('context_challenge_failed', 'TEST-vet-source-unavailable'), failedBootstrap('context_challenge_failed', 'TEST-vet-source-unavailable'));
  const ops = w.ops(), transition = ops.transition;
  ops.transition = (id, from, to, options) => {
    if (to !== 'agreement_rejected') return transition.call(ops, id, from, to, options);
    ops.transition = transition;
    assert.equal(options.state.protocol.bootstrapEnd.cause, 'TEST-vet-source-unavailable');
    transition.call(ops, id, from, to, options);
    throw new Error('TEST the process stopped after the status update');
  };
  await assert.rejects(w.service().planRequest(purchase.get(), signature), /TEST the process stopped/);
  assert.equal(terminalEvents(w, purchase).length, 0, 'the status and event writes rolled back');
  const kept = purchase.get();
  assert.equal(kept.status, 'agreement_pending');
  assert.equal(kept.state.protocol.stage, stage);
  assert.equal(kept.state.protocol.bootstrapEnd, undefined);

  await assert.rejects(w.service().planRequest(purchase.get(), signature), refusal('context_challenge_failed'));
  const [end, ...more] = terminalEvents(w, purchase);
  assert.deepEqual(more, []);
  const row = purchase.get();
  assert.equal(row.status, 'agreement_rejected');
  assert.equal(row.state.protocol.bootstrapEnd.cause, 'TEST-vet-source-unavailable');
  assert.equal(end.data.stage, 'bootstrap-failed', 'the status, stage and end were one write');
});

test('challenge expiry after the accepted presentation never ends the bootstrap; the stored bytes are retried', async (t) => {
  const w = await contextWorld(t), purchase = w.contextPurchase();
  const signature = await toContextStep(w, purchase);
  w.answer(timedOut(), timedOut());
  await assert.rejects(w.service().planRequest(purchase.get(), signature), refusal('agreement_context_held'));
  const accepted = protocolOf(purchase).buyerBundle;
  assert.ok(accepted, 'the presentation was accepted');

  w.clock.time = protocolOf(purchase).challenge.expiresAt + 1;
  await assert.rejects(w.service().planRequest(purchase.get(), signature), refusal('agreement_context_held'));
  const row = purchase.get();
  assert.equal(row.status, 'agreement_pending');
  assert.equal(row.state.protocol.bootstrapEnd, undefined);
  assert.deepEqual(w.calls.map((call) => call.buyerIdentityBundle), [accepted, accepted], 'the accepted presentation is sent again unchanged');
});


test('a terminal bootstrap refuses old operation snapshots without sending or returning wallet messages', async (t) => {
  const w = await contextWorld(t), purchase = w.contextPurchase();
  const signature = await toContextStep(w, purchase), stale = purchase.get();
  w.answer(failedBootstrap('context_job_closed'));
  await assert.rejects(w.service().planRequest(stale, signature), refusal('context_job_closed'));
  const before = activity(w);
  await assert.rejects(w.service().identityRequest(stale, buyer.address), refusal('context_job_closed'));
  await assert.rejects(w.service().agreementDelegation(stale, null), refusal('context_job_closed'));
  await assert.rejects(w.service().planRequest(stale, signature), refusal('context_job_closed'));
  assert.deepEqual(activity(w), before);
});

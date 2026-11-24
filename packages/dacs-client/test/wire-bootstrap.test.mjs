// The delegation-first bootstrap through the client's public protocol factory against the kit's real challenge route:
// the wallet delegation is accepted first, the session key asks the seller for its challenge, and the wallet signs a
// presentation carrying the seller's nonce. Every wallet message is saved before it is returned.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import * as wire from '@kynesyslabs/dacs/wire';
import { CHALLENGE, JOB, JOB2, NOW, TEST_CONNECTION, buyer, seller, bootstrapThroughChallenge, bootstrapWorld, walletSign } from './helpers/kit-bootstrap-world.mjs';

const { buildUnsignedIdentityBundle } = await import('../src/dacs/listing.mjs');
const HEX64 = /^[0-9a-f]{64}$/;
const CHALLENGE_LIFETIME_MS = 600_000;
const DELEGATION_MARGIN_MS = 300_000;
// Each restart moves the client clock on, within the wire's clock skew, so a rebuilt time would differ.
const SKIPPED_MS = 5_000;
const protocolOf = (purchase) => purchase.get().state.protocol;
const refusal = (expected) => (error) => { assert.equal(error.code, expected); return true; };
const signedPayload = (init) => JSON.parse(Buffer.from(init.headers[wire.DACS_SELLER_HTTP_HEADER], 'base64url')).payload;
const lostAnswer = () => { throw new TypeError('TEST the connection dropped'); };
const issuedNonces = (w) => new Set(w.answers.map((answer) => JSON.parse(answer.text).sessionNonce));

test("the delegation is accepted first, the session key requests the seller challenge, and the wallet signs a bundle carrying the seller's nonce", async (t) => {
  const w = await bootstrapWorld(t), purchase = w.purchase();
  const first = await w.service().identityRequest(purchase.get(), buyer.address);
  assert.deepEqual(Object.keys(first).sort(), ['delegation', 'operation'], 'the first step returns the delegation message only');
  assert.ok(first.delegation.message.startsWith(wire.DACS_SELLER_HTTP_DOMAINS.delegation));
  assert.equal(w.requests.length, 0, 'nothing is sent before the delegation is signed');

  const second = await w.service().agreementDelegation(purchase.get(), walletSign(first.delegation.message));
  const [request, ...more] = w.requests;
  assert.deepEqual(more, []);
  assert.equal(request.path, CHALLENGE);
  const body = JSON.parse(request.init.body), payload = signedPayload(request.init);
  assert.deepEqual(Object.keys(body), ['scope']);
  assert.equal(Object.keys(body.scope).length, 10, 'the challenge scope has no bundle hash and no local identifiers');
  assert.equal(payload.agreementHash, sha256Hex(canonicalize(body.scope)), 'the challenge is signed under its scope hash');
  assert.equal(payload.buyer, buyer.claim);
  assert.equal(w.signs.length, 1, 'the session key signed the challenge request');

  const issued = JSON.parse(w.answers[0].text), p = protocolOf(purchase);
  assert.match(issued.sessionNonce, HEX64);
  assert.equal(p.identity.bundle.sessionNonce, issued.sessionNonce);
  assert.equal(second.message, p.identity.message);
  await w.service().planRequest(purchase.get(), walletSign(second.message));
  assert.equal(protocolOf(purchase).buyerBundle.sessionNonce, issued.sessionNonce, 'the accepted presentation carries the seller nonce');
  assert.equal(protocolOf(purchase).stage, 'agreement-signing');
});

test('the client derives no session nonce', async (t) => {
  for (const sessionNonce of [undefined, '', 'A'.repeat(64), 'a'.repeat(63), 7]) {
    assert.throws(() => buildUnsignedIdentityBundle({ address: buyer.address, presentedAt: NOW, sessionNonce }), TypeError);
  }
  const w = await bootstrapWorld(t), undeclared = w.purchase(JOB, { declared: false });
  await assert.rejects(w.service().identityRequest(undeclared.get(), buyer.address), refusal('seller_challenge_unavailable'));
  assert.equal(protocolOf(undeclared).identity, undefined);
  assert.equal(w.requests.length, 0);
});

test('a ready:false proof refuses the challenge request seller_not_ready before signing and starts nothing', async (t) => {
  const w = await bootstrapWorld(t, { ready: false }), purchase = w.purchase();
  await assert.rejects(bootstrapThroughChallenge(w, purchase), (error) => {
    assert.equal(error.cause?.code ?? error.code, 'seller_not_ready');
    return true;
  });
  assert.equal(w.signs.length, 0, 'the session key signed nothing');
  assert.equal(w.requests.length, 0, 'nothing was sent');
  assert.equal(protocolOf(purchase).identity, undefined, 'no presentation message exists');
});

test('a challenge reply naming another job, buyer or challenge scope, or a nonce that is not 64 lowercase hex, is refused before the wallet is asked', async (t) => {
  const w = await bootstrapWorld(t), other = w.purchase(JOB2);
  await bootstrapThroughChallenge(w, other);
  const otherAnswer = w.requests.length;
  const [kept] = w.answers;
  const purchase = w.purchase();
  const delegation = await w.service().identityRequest(purchase.get(), buyer.address);
  const answerWith = (text, header) => new Response(text, { status: 200, headers: { 'content-type': 'application/json', [wire.DACS_SELLER_HTTP_HEADER]: header } });
  const signedAnswer = async (init, answer) => {
    const text = JSON.stringify(answer);
    return answerWith(text, await wire.signWireResponse(signedPayload(init), 200, text, { signer: { claim: seller.claim, sign: seller.signBytes }, binding: w.binding,
      local: { ...TEST_CONNECTION }, purchaseProfile: w.binding.profile, now: NOW }));
  };
  const nonce = 'b'.repeat(64);
  const replies = [
    // The other job's own signed answer: it names that job, buyer request and challenge scope, not this one.
    async () => answerWith(kept.text, kept.header),
    (init) => signedAnswer(init, { sessionNonce: nonce.toUpperCase(), expiresAt: NOW + CHALLENGE_LIFETIME_MS }),
    (init) => signedAnswer(init, { sessionNonce: nonce.slice(1), expiresAt: NOW + CHALLENGE_LIFETIME_MS }),
    (init) => signedAnswer(init, { sessionNonce: nonce, expiresAt: NOW }),
    (init) => signedAnswer(init, { sessionNonce: nonce, expiresAt: NOW + CHALLENGE_LIFETIME_MS, jobId: JOB2 }),
    (init) => signedAnswer(init, { sessionNonce: nonce }),
  ];
  for (const reply of replies) {
    w.intercept = (_path, init) => reply(init);
    await assert.rejects(w.service().agreementDelegation(purchase.get(), walletSign(delegation.delegation.message)));
    assert.equal(protocolOf(purchase).identity, undefined, 'no presentation message was built');
    assert.equal(protocolOf(purchase).challenge, undefined);
  }
  assert.equal(w.requests.length, otherAnswer + replies.length);
});

test('a challenge is never reused across jobs, and a new purchase gets a new challenge', async (t) => {
  const w = await bootstrapWorld(t), first = w.purchase(JOB), next = w.purchase(JOB2);
  const a = await bootstrapThroughChallenge(w, first), b = await bootstrapThroughChallenge(w, next);
  const [nonceA, nonceB] = [protocolOf(first), protocolOf(next)].map((p) => p.identity.bundle.sessionNonce);
  assert.notEqual(nonceA, nonceB);
  assert.notEqual(a.presentation.message, b.presentation.message);
  assert.deepEqual(w.sent(CHALLENGE).map((request) => JSON.parse(request.init.body).scope.jobId), [JOB, JOB2]);
  const again = await w.service().agreementDelegation(first.get(), walletSign(a.delegation.delegation.message));
  assert.equal(again.message, a.presentation.message, 'a repeat answers from the stored challenge');
  assert.equal(w.sent(CHALLENGE).length, 2, 'and asks for none');
});

test('an absent, expired or wrong-scope delegation refuses the challenge and context with no new seller work and no extra approval', async (t) => {
  const w = await bootstrapWorld(t), purchase = w.purchase(), other = w.purchase(JOB2);
  await assert.rejects(w.service().agreementDelegation(purchase.get(), walletSign('TEST-no-delegation-requested')), refusal('invalid_state'));
  const delegation = await w.service().identityRequest(purchase.get(), buyer.address);
  await assert.rejects(w.service().planRequest(purchase.get(), walletSign('TEST-no-presentation')), refusal('invalid_state'));
  const otherDelegation = await w.service().identityRequest(other.get(), buyer.address);
  await assert.rejects(w.service().agreementDelegation(purchase.get(), walletSign(otherDelegation.delegation.message)), refusal('peer_delegation_signature_invalid'));
  w.clock.time = protocolOf(purchase).sessionDelegation.payload.expiresAt - DELEGATION_MARGIN_MS + 1;
  await assert.rejects(w.service().agreementDelegation(purchase.get(), walletSign(delegation.delegation.message)), refusal('seller_delegation_expiring'));
  assert.equal(protocolOf(purchase).sessionDelegation.signature, undefined, 'no delegation was accepted');
  assert.equal(w.requests.length, 0, 'no seller request was sent');
  assert.equal(w.signs.length, 0);
  assert.equal(w.policies, 2, 'one delegation payload per purchase, none minted again');
});

test('an expired delegation never requests a new challenge', async (t) => {
  const w = await bootstrapWorld(t), purchase = w.purchase();
  w.intercept = lostAnswer;
  await assert.rejects(bootstrapThroughChallenge(w, purchase));
  assert.equal(typeof protocolOf(purchase).sessionDelegation.signature, 'string', 'the delegation was accepted before the challenge was sent');
  w.intercept = null;
  w.clock.time = protocolOf(purchase).sessionDelegation.payload.expiresAt + 1;
  await assert.rejects(w.service().agreementDelegation(purchase.get(), null), refusal('seller_delegation_expiring'));
  assert.equal(w.sent(CHALLENGE).length, 1, 'only the first, failed attempt was sent');
});

test("two page requests for one purchase's bootstrap share one challenge", async (t) => {
  const w = await bootstrapWorld(t), purchase = w.purchase();
  const delegation = await w.service().identityRequest(purchase.get(), buyer.address);
  const snapshot = purchase.get(), signature = walletSign(delegation.delegation.message);
  const [a, b] = await Promise.all([w.service().agreementDelegation(snapshot, signature), w.service().agreementDelegation(snapshot, signature)]);
  assert.equal(a.message, b.message);
  assert.equal(issuedNonces(w).size, 1, 'the seller issued one challenge');
  assert.equal(new Set(w.sent(CHALLENGE).map((request) => request.init.body)).size, 1, 'every send carried the one stored body');
  assert.equal(protocolOf(purchase).sellerRequests[CHALLENGE].bodyB64, Buffer.from(w.sent(CHALLENGE)[0].init.body).toString('base64url'));
});

test('each wallet message is durable, with its exact bytes, before it is returned, and a repeated call returns the same bytes', async (t) => {
  const w = await bootstrapWorld(t), purchase = w.purchase();
  // What a restarted process reads from the store right after the call returned.
  const stored = () => { w.restart(); return protocolOf(purchase); };
  const first = await w.service().identityRequest(purchase.get(), buyer.address);
  assert.equal(stored().delegationMessage, first.delegation.message);
  assert.equal((await w.service().identityRequest(purchase.get(), buyer.address)).delegation.message, first.delegation.message);
  const second = await w.service().agreementDelegation(purchase.get(), walletSign(first.delegation.message));
  assert.equal(stored().identity.message, second.message);
  assert.equal((await w.service().agreementDelegation(purchase.get(), null)).message, second.message);
  const third = await w.service().planRequest(purchase.get(), walletSign(second.message));
  assert.equal(stored().planned.agreementMessage, third.request.agreementMessage);
  assert.equal((await w.service().planRequest(purchase.get(), walletSign(second.message))).request.agreementMessage, third.request.agreementMessage);
  assert.equal(w.sent(CHALLENGE).length, 1);
  assert.equal(w.policies, 1);
});

test('a cut before and after each checkpoint and each wallet response, then a restart, returns the same pending signing bytes and rebuilds no presentedAt or generatedAt', async (t) => {
  const w = await bootstrapWorld(t), purchase = w.purchase();
  // The delegation message is saved; its answer to the page is lost.
  const delegation = await w.service().identityRequest(purchase.get(), buyer.address);
  w.restart();
  w.clock.time += SKIPPED_MS;
  assert.equal((await w.service().identityRequest(purchase.get(), buyer.address)).delegation.message, delegation.delegation.message);
  // The delegation and the challenge scope are saved; the process stops before anything reaches the seller.
  w.intercept = lostAnswer;
  await assert.rejects(w.service().agreementDelegation(purchase.get(), walletSign(delegation.delegation.message)));
  const scope = protocolOf(purchase).challengeScope;
  assert.equal(scope.generatedAt, NOW + SKIPPED_MS);
  // The seller issues the challenge; its answer is lost before the presentation is saved.
  w.restart();
  w.clock.time += SKIPPED_MS;
  w.intercept = async (_path, _init, forward) => { await forward(); return lostAnswer(); };
  await assert.rejects(w.service().agreementDelegation(purchase.get(), null));
  const lost = JSON.parse(w.answers.at(-1).text).sessionNonce;
  w.restart();
  w.clock.time += SKIPPED_MS;
  w.intercept = null;
  const presentation = await w.service().agreementDelegation(purchase.get(), null);
  const sent = w.sent(CHALLENGE).map((request) => JSON.parse(request.init.body).scope);
  for (const body of sent) assert.deepEqual(body, scope, 'every send carried the stored scope and generatedAt');
  assert.equal(protocolOf(purchase).identity.bundle.sessionNonce, lost, 'the seller answered the challenge it had already issued');
  const presentedAt = protocolOf(purchase).identity.bundle.presentedAt;
  // The presentation message is saved; the wallet's answer is lost.
  w.restart();
  w.clock.time += SKIPPED_MS;
  assert.equal((await w.service().agreementDelegation(purchase.get(), null)).message, presentation.message);
  assert.equal(protocolOf(purchase).identity.bundle.presentedAt, presentedAt);
  // The presentation is accepted; the plan save fails, and the process restarts.
  w.db().exec(`CREATE TRIGGER refuse_plan BEFORE UPDATE ON operations WHEN json_extract(NEW.state,'$.protocol.planned') IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'TEST-plan-save-failure'); END`);
  await assert.rejects(w.service().planRequest(purchase.get(), walletSign(presentation.message)), /TEST-plan-save-failure/);
  const accepted = protocolOf(purchase).buyerBundle;
  assert.equal(accepted.sessionNonce, lost);
  w.db().exec('DROP TRIGGER refuse_plan');
  w.restart();
  await w.service().planRequest(purchase.get(), walletSign(presentation.message));
  assert.deepEqual(protocolOf(purchase).buyerBundle, accepted);
  assert.equal(w.sent(CHALLENGE).length, 3, 'one send per cut, each with the stored bytes');
  assert.equal(w.policies, 1);
});

test('two independently constructed services sharing one store adopt the compare-and-set winner: identical signing bytes and an accepted presentation never replaced', async (t) => {
  const w = await bootstrapWorld(t), purchase = w.purchase(), one = w.service(), two = w.second();
  const prepared = purchase.get();
  const [d1, d2] = await Promise.all([one.identityRequest(prepared, buyer.address), two.identityRequest(prepared, buyer.address)]);
  assert.equal(d1.delegation.message, d2.delegation.message);
  const delegated = purchase.get(), signature = walletSign(d1.delegation.message);
  const [p1, p2] = await Promise.all([one.agreementDelegation(delegated, signature), two.agreementDelegation(delegated, signature)]);
  assert.equal(p1.message, p2.message);
  assert.equal(issuedNonces(w).size, 1);
  // Both accept the presentation while the plan save fails, so the accepted presentation is all that is saved.
  w.db().exec(`CREATE TRIGGER refuse_plan BEFORE UPDATE ON operations WHEN json_extract(NEW.state,'$.protocol.planned') IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'TEST-plan-save-failure'); END`);
  const presented = purchase.get(), presentation = walletSign(p1.message);
  const failed = await Promise.allSettled([one.planRequest(presented, presentation), two.planRequest(presented, presentation)]);
  assert.deepEqual(failed.map((result) => result.status), ['rejected', 'rejected']);
  const accepted = protocolOf(purchase).buyerBundle;
  await assert.rejects(two.planRequest(purchase.get(), `${presentation.slice(0, -4)}AAAA`), refusal('bad_signature'));
  assert.deepEqual(protocolOf(purchase).buyerBundle, accepted, 'the accepted presentation is never replaced');
  w.db().exec('DROP TRIGGER refuse_plan');
  const [r1, r2] = await Promise.all([one.planRequest(purchase.get(), presentation), two.planRequest(purchase.get(), presentation)]);
  assert.equal(r1.request.agreementMessage, r2.request.agreementMessage);
  assert.deepEqual(protocolOf(purchase).buyerBundle, accepted);
});

test('an unused challenge past its expiry before the presentation is accepted is not rebuilt, and the bootstrap stops with no new wallet message', async (t) => {
  const w = await bootstrapWorld(t), purchase = w.purchase();
  const { presentation } = await bootstrapThroughChallenge(w, purchase);
  const kept = protocolOf(purchase).identity;
  w.restart();
  w.clock.time = protocolOf(purchase).challenge.expiresAt;
  await assert.rejects(w.service().agreementDelegation(purchase.get(), null), refusal('context_challenge_expired'));
  await assert.rejects(w.service().planRequest(purchase.get(), walletSign(presentation.message)), refusal('context_challenge_expired'));
  assert.deepEqual(protocolOf(purchase).identity, kept);
  assert.equal(protocolOf(purchase).buyerBundle, undefined);
  assert.equal(w.sent(CHALLENGE).length, 1, 'no new challenge was asked');
});

test('a purchase cancelled while its challenge request is in flight saves no presentation message', async (t) => {
  const w = await bootstrapWorld(t), purchase = w.purchase();
  const delegation = await w.service().identityRequest(purchase.get(), buyer.address);
  w.intercept = async (_path, _init, forward) => {
    const row = purchase.get();
    w.ops().transition(row.id, row.status, 'cancelled', { state: row.state, event: 'TEST-cancelled', data: {} });
    return forward();
  };
  await assert.rejects(w.service().agreementDelegation(purchase.get(), walletSign(delegation.delegation.message)), refusal('invalid_state'));
  assert.equal(protocolOf(purchase).identity, undefined);
  assert.equal(w.sent(CHALLENGE).length, 1);
});

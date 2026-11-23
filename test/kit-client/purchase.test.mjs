// K12-H7 / A37: a purchase through the client's public entries against the composed kit host. The harness loader sets only the
// client's hold constant; the real admission wrapper and the original actions run. The failure and counters it records are in the index.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DACS_SELLER_HTTP_DOMAINS, DACS_SELLER_HTTP_PATHS } from '@kynesyslabs/dacs/wire';
import { NOW, drivePurchase, purchaseWorld } from './client-purchase.mjs';
import { composedKitHost } from './kit-host.mjs';

const PRESENTATION_DOMAIN = 'dacs-bundle-presentation:v1:';
const { current: CURRENT } = JSON.parse(readFileSync(new URL('./harness-index.json', import.meta.url), 'utf8')).find((entry) => entry.id === 'K12-H7');
const REQUEST_COUNTERS = ['contextChallenge', 'context', 'proposals', 'commitments', 'commitmentSignature', 'payments'];

test('K12-H7 / A37 today: a purchase through the public entries on the fixture node stops at its first incompatibility, with no downstream request or effect', async (t) => {
  // One clock for both sides: the client's portal capability also reads the real clock.
  t.mock.method(Date, 'now', () => NOW);
  const { fixture, host } = await composedKitHost(t);
  const world = await purchaseWorld(t, { host, listing: fixture.listing });
  const sellerSignaturesBefore = fixture.signed.length;
  const { operation, identity, presentation, retained, failure } = await drivePurchase(world);

  // Control: the delegation and challenge steps ran for real. The wallet signed the returned delegation, the kit host issued the
  // challenge, and the presentation the wallet signed carries the kit's nonce.
  assert.equal(retained.id, operation.id);
  const kept = retained.state.protocol;
  assert.ok(identity.delegation.message.startsWith(DACS_SELLER_HTTP_DOMAINS.delegation), 'the first message is the delegation request');
  assert.equal(typeof kept.sessionDelegation.signature, 'string', 'the saved delegation is signed');
  assert.deepEqual(kept.sessionDelegation.payload, identity.delegation.payload);
  assert.ok(presentation.message.startsWith(PRESENTATION_DOMAIN), 'the second message is the presentation request');
  assert.equal(kept.identity.message, presentation.message, 'the retained state holds the presentation that was returned');
  const [challengeAnswer, ...laterChallenges] = world.challengeAnswers;
  assert.deepEqual(laterChallenges, [], 'one challenge answer');
  assert.equal(challengeAnswer.status, 200);
  assert.equal(challengeAnswer.signed, true);
  const issued = JSON.parse(challengeAnswer.text).sessionNonce;
  assert.equal(kept.challenge.sessionNonce, issued);
  assert.equal(kept.buyerBundle.sessionNonce, issued, 'the presentation carries the kit-issued nonce');

  // The first failing step, exactly as the index records it, and the host answer that caused it: the operator resolver's
  // older-header context request is refused unsigned, so the client cannot authenticate the answer.
  assert.ok(failure, 'the purchase failed at its plan step');
  const [contextFailure, ...laterFailures] = world.contextFailures;
  assert.ok(contextFailure, 'the seller client reported a failed context exchange');
  assert.deepEqual(laterFailures, [], 'one failed context exchange only');
  assert.deepEqual(world.contextAnswers.map(({ status, signed, text }) => ({ status, signed, error: JSON.parse(text).error })), [{ status: 409, signed: false, error: 'tp1_profile_missing' }]);
  const requests = Object.fromEntries(REQUEST_COUNTERS.map((name) => [name, world.sellerRequests.filter((path) => path === DACS_SELLER_HTTP_PATHS[name]).length]));
  assert.equal(world.sellerRequests.length, Object.values(requests).reduce((sum, count) => sum + count, 0), 'no seller request outside the counted routes');
  assert.deepEqual({ step: failure.step, code: failure.error.code, failureClass: contextFailure.failureClass, layer: contextFailure.layer,
    counters: { ...requests, sellerSignatures: fixture.signed.length - sellerSignaturesBefore, walletEffects: world.native.writes.length + world.native.calls.length + world.chain.broadcasts } },
  { step: CURRENT.step, code: CURRENT.code, failureClass: CURRENT.failureClass, layer: CURRENT.layer, counters: CURRENT.counters });
});

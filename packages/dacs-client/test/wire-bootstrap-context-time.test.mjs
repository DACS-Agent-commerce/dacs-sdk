// The generation time of the plan step's context scope, through the client's public protocol factory against the kit's real
// challenge and context routes. The seller binds its challenge to the challenge scope's hash, and its context route requires
// the context scope, less the bundle hash, to hash the same; so the plan step must carry the time the challenge step fixed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import * as wire from '@kynesyslabs/dacs/wire';
import { CHALLENGE, buyer, seller, bootstrapThroughChallenge, bootstrapWorld, walletSign } from './helpers/kit-bootstrap-world.mjs';

const { createDemDeliveryContext, DEM_DELIVERY_CONTEXT_SOURCE } = await import('../src/dacs/dem-delivery-context-consumer.mjs');
const { wireBuyer } = await import('../../dacs-seller/test/helpers/wire-buyer.mjs');
const { testWallet } = await import('../../dacs-seller/test/helpers/protocol-fixture.mjs');
const { fetchAsHost } = await import('../../dacs-seller/test/helpers/listener-host.mjs');

const CONTEXT = wire.DACS_SELLER_HTTP_PATHS.context;
// The world's session key; the client's saved delegation names it.
const SESSION_KEY_TAG = 99;
// How long the wallet takes to sign the presentation, and to answer again on a retry.
const WALLET_SIGNING_MS = 20_000;
const RETRY_AFTER_MS = 5_000;
const signerOf = (wallet) => ({ claim: wallet.claim, sign: wallet.signBytes });
const refusal = (expected) => (error) => { assert.equal(error.code, expected); return true; };
const protocolOf = (purchase) => purchase.get().state.protocol;

/**
 * The kit world with a DEM delivery context provider that sends each step-3 scope it is given, without the local account and
 * operation ids, to the host's real context route, signed by the session key under the purchase's saved delegation. It answers
 * the client `indeterminate`, so no plan is saved; `scopes` and `answers` keep what was sent and what the host answered.
 */
async function forwardingWorld(t) {
  const scopes = [], answers = [];
  let world, purchase;
  const capability = createDemDeliveryContext({
    authority: 'TEST-context-time',
    async resolveBuyer({ scope, buyerIdentityBundle }) {
      const { account: _account, operation: _operation, ...sellerScope } = scope;
      scopes.push(sellerScope);
      const body = { scope: sellerScope, buyerIdentityBundle };
      const signed = await world.signer.signRequest(CONTEXT, body, { jobId: sellerScope.jobId, agreementHash: sha256Hex(canonicalize(sellerScope)),
        delegation: protocolOf(purchase).sessionDelegation, signer: signerOf(testWallet(SESSION_KEY_TAG)) });
      const response = await (world.host.fetch ?? fetchAsHost())(world.host.url + CONTEXT, { method: 'POST',
        headers: { 'content-type': 'application/json', [wire.DACS_SELLER_HTTP_HEADER]: signed.header }, body: signed.text });
      const text = await response.text();
      answers.push({ status: response.status, error: JSON.parse(text).error });
      return { disposition: 'indeterminate', reason: 'TEST the context answer was forwarded' };
    },
    async resolveSeller() { throw new TypeError('TEST no seller context in these tests'); },
  });
  world = await bootstrapWorld(t, { demDeliveryContext: capability });
  world.signer = await wireBuyer({ buyer: signerOf(buyer), seller: signerOf(seller), listingPin: world.host.listingPin, clock: () => world.clock.time });
  purchase = world.purchase(undefined, { agreementContext: DEM_DELIVERY_CONTEXT_SOURCE });
  return { world, purchase, scopes, answers };
}

test("the plan step's context scope carries the generatedAt the seller challenge bound, so the seller's context route accepts it after the wallet took time to sign", async (t) => {
  const { world, purchase, scopes, answers } = await forwardingWorld(t);
  const { presentation } = await bootstrapThroughChallenge(world, purchase);
  const [challengeRequest] = world.sent(CHALLENGE);
  const challengeScope = JSON.parse(challengeRequest.init.body).scope;
  world.clock.time += WALLET_SIGNING_MS;
  await assert.rejects(world.service().planRequest(purchase.get(), walletSign(presentation.message)), refusal('agreement_context_held'));
  assert.deepEqual(answers, [{ status: 200, error: undefined }], "the seller's context route accepted the request");
  const { buyerBundleHash: _hash, ...bound } = scopes[0];
  assert.deepEqual(bound, challengeScope, 'the context scope, less its bundle hash, is the challenge scope');
  assert.equal(purchase.get().status, 'agreement_pending');
});

test('a retried plan step sends the same context scope as the first, at a later clock', async (t) => {
  const { world, purchase, scopes } = await forwardingWorld(t);
  const { presentation } = await bootstrapThroughChallenge(world, purchase);
  const signature = walletSign(presentation.message);
  world.clock.time += WALLET_SIGNING_MS;
  await assert.rejects(world.service().planRequest(purchase.get(), signature), refusal('agreement_context_held'));
  world.restart();
  world.clock.time += RETRY_AFTER_MS;
  await assert.rejects(world.service().planRequest(purchase.get(), signature), refusal('agreement_context_held'));
  assert.equal(scopes.length, 2);
  assert.deepEqual(scopes[1], scopes[0], 'the retry rebuilt no generatedAt');
});

test('an approved Agreement time that differs from the one the seller challenge bound is refused before any context read, and nothing is planned', async (t) => {
  const { world, purchase, scopes } = await forwardingWorld(t);
  const { presentation } = await bootstrapThroughChallenge(world, purchase);
  world.clock.time += WALLET_SIGNING_MS;
  const bound = protocolOf(purchase).challengeScope.generatedAt;
  await assert.rejects(world.service().planRequest(purchase.get(), walletSign(presentation.message), world.clock.time), refusal('agreement_time_mismatch'));
  assert.deepEqual(scopes, [], 'no context was read');
  assert.equal(protocolOf(purchase).planned, undefined);
  assert.equal(purchase.get().status, 'agreement_pending');
  await assert.rejects(world.service().planRequest(purchase.get(), walletSign(presentation.message), bound), refusal('agreement_context_held'));
  assert.equal(scopes[0].generatedAt, bound, 'the approved time equal to the bound one is used');
});

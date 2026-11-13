import test from 'node:test';
import assert from 'node:assert/strict';
import * as wire from '@kynesyslabs/dacs/wire';
import { world, purchase, JOB, T0, setPurchaseAdmission } from './helpers/wire-client-fixture.mjs';
import { fixtureListing } from './fixtures/listings.mjs';
const { createSellerAgentClient } = await import('../src/dacs/seller-http.mjs');
const { SELLER_ANSWER_CLASS } = await import('../src/dacs/seller-response-class.mjs');

const SELLER_ORIGIN = 'https://seller.example.com';
const failIfCalled = (calls) => async () => { calls.push('fetch'); throw new Error('no request may be sent'); };

test('a signed request goes to the public https endpoint of the seller', async (t) => {
  const w = await world(t, { publicEndpoint: SELLER_ORIGIN });
  const sent = [];
  const client = createSellerAgentClient({
    url: SELLER_ORIGIN, authentication: w.auth, fetchImpl: async (url, init) => { sent.push({ url, init }); throw new Error('seller unreachable'); }
  });
  await assert.rejects(client.agreementState({ jobId: JOB }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, `${SELLER_ORIGIN}${wire.DACS_SELLER_HTTP_PATHS.state}`);
  assert.equal(typeof sent[0].init.headers[wire.DACS_SELLER_HTTP_HEADER], 'string');
  assert.equal(w.state.signs.length, 1);
});

test('a public endpoint written with a trailing slash is reached at the same address', async (t) => {
  const w = await world(t, { publicEndpoint: SELLER_ORIGIN });
  const sent = [];
  const client = createSellerAgentClient({
    url: `${SELLER_ORIGIN}/`, authentication: w.auth, fetchImpl: async (url) => { sent.push(url); throw new Error('seller unreachable'); }
  });
  await assert.rejects(client.agreementState({ jobId: JOB }));
  assert.deepEqual(sent, [`${SELLER_ORIGIN}${wire.DACS_SELLER_HTTP_PATHS.state}`]);
});

test('preparing a purchase keeps the public https origin of a seller whose transport is declared', async (t) => {
  const w = await world(t, { publicEndpoint: SELLER_ORIGIN });
  const p = await purchase(t, w, { paid: true });
  const listing = fixtureListing(w.seller, { now: T0 });
  const { terms } = await p.service.prepareTerms({ verification: { listing }, domain: { mode: 'public-chain-read', network: 'testnet', chainIdentity: w.binding.profile.chainIdentity }, sellerClaim: w.seller.claim });
  assert.equal(terms.sellerAgent, SELLER_ORIGIN);
  assert.deepEqual(terms.sellerTransport, p.transport.declaration);
});

test('a public endpoint without a wire authentication is refused', async () => {
  assert.throws(() => createSellerAgentClient({ url: SELLER_ORIGIN, fetchImpl: failIfCalled([]) }), /seller agent endpoint/);
});

test('a loopback endpoint without a wire authentication is still accepted', () => {
  assert.doesNotThrow(() => createSellerAgentClient({ url: 'http://127.0.0.1:19001', fetchImpl: failIfCalled([]) }));
});

test('a loopback endpoint with a wire authentication is still accepted at its own origin', async (t) => {
  const w = await world(t);
  const client = createSellerAgentClient({ url: 'http://127.0.0.1:19001/', authentication: w.auth, fetchImpl: failIfCalled([]) });
  assert.equal(client.origin, 'http://127.0.0.1:19001');
});

for (const [name, endpoint] of [
  ['plain http', 'http://seller.example.com'],
  ['credentials', 'https://user:secret@seller.example.com'],
  ['a path prefix', 'https://seller.example.com/prefix'],
  ['a query', 'https://seller.example.com?x=1'],
  ['a fragment', 'https://seller.example.com#part'],
  ['a backslash after the scheme', 'https:\\\\seller.example.com'],
  ['an unparsable address', 'seller.example.com']
]) {
  test(`an endpoint with ${name} is refused before anything is signed or sent`, async (t) => {
    const w = await world(t, { publicEndpoint: SELLER_ORIGIN });
    const calls = [];
    assert.throws(() => createSellerAgentClient({ url: endpoint, authentication: w.auth, fetchImpl: failIfCalled(calls) }));
    assert.equal(w.state.signs.length, 0);
    assert.deepEqual(calls, []);
  });
}

test('a public endpoint request is refused while purchase actions are held, before signing or sending', async (t) => {
  const w = await world(t, { publicEndpoint: SELLER_ORIGIN });
  setPurchaseAdmission('held');
  const calls = [];
  const client = createSellerAgentClient({ url: SELLER_ORIGIN, authentication: w.auth, fetchImpl: failIfCalled(calls) });
  await assert.rejects(client.agreementState({ jobId: JOB }), (error) => error.code === 'seller_unavailable' && error.answerClass === SELLER_ANSWER_CLASS.NOT_SENT);
  assert.equal(w.state.signs.length, 0);
  assert.deepEqual(calls, []);
});

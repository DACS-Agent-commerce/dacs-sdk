// The public reader has no retained native source, so it never settles a native purchase.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeNode, TESTNET_IDENTITY } from './helpers/public-demos-reader-node.mjs';
import { HASH, paymentAnswers, paymentBody, purchaseWorld } from './helpers/public-demos-reader-purchase.mjs';

const NO_SOURCE = { status: 'unavailable', reason: 'native source evidence unavailable from public reader' };

test('observePurchaseTransfer turns an included transfer into unavailable with no sourceDisposition', async () => {
  const reader = fakeNode({ answer: paymentAnswers() }).reader();
  const result = await reader.observePurchaseTransfer(HASH);
  assert.deepEqual(result, NO_SOURCE);
  assert.equal(Object.hasOwn(result, 'sourceDisposition'), false);
});

test('observeTransfer returns the same included transfer unchanged', async () => {
  const reader = fakeNode({ answer: paymentAnswers() }).reader();
  const result = await reader.observeTransfer(HASH);
  assert.equal(result.status, 'included');
  assert.equal(result.txHash, HASH);
  assert.equal(Object.hasOwn(result, 'sourceDisposition'), false);
});

// Each node answer and the observation status it gives.
for (const [status, answers] of [
  ['failed', paymentAnswers({ state: 'failed' })],
  ['pending', paymentAnswers({ state: 'pending' })],
  ['not-found', paymentAnswers({ state: 'not-found' })],
  ['invalid', paymentAnswers({ body: { ...paymentBody(), hash: '2'.repeat(64) } })],
  ['unavailable', paymentAnswers({ state: 'TEST-unsupported' })],
]) {
  test(`observePurchaseTransfer passes a ${status} observation through unchanged`, async () => {
    const node = fakeNode({ answer: answers }), reader = node.reader();
    const expected = await reader.observeTransfer(HASH);
    assert.equal(expected.status, status);
    assert.deepEqual(await reader.observePurchaseTransfer(HASH), expected);
  });
}

test('a native purchase read through the public reader stays unresolved and records no payment', async (t) => {
  const node = fakeNode({ answer: paymentAnswers() });
  const world = purchaseWorld(t, { chain: node.reader(), chainIdentity: TESTNET_IDENTITY, native: true,
    protocol: { nativePaymentSuperseded: async () => true, nativeIntentsSupersededBy: async () => [] } });
  const { verification } = await world.verify();
  assert.equal(verification.outcome, 'chain_unavailable');
  assert.deepEqual(verification.observation, NO_SOURCE);
  const state = world.state();
  assert.equal(state.operation.status, 'broadcast_reported');
  assert.equal(state.coordinate.verifiedAt, null);
  assert.equal(state.coordinate.reportedTxHash, HASH, 'the hash stays for a later readback');
  assert.equal(state.consumed, 0, 'no wallet nonce is recorded as consumed');
  assert.equal(node.requests.includes('getTxByHash'), true, 'the transfer itself was observed');
});

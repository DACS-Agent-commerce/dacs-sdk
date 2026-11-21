// The seller's balance through its Node wallet: a bounded read of the node's getAddressInfo answer with its cause kept, and
// a session write the node refuses for balance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactWrite, jsonResponse, ok, outcomes, refuseConfirmation, replyTo, sellerWalletWorld, settlingWorld, spyTransactionSignatures } from './helpers/seller-node-wallet-world.mjs';

const BALANCE_READ_TIMEOUT_MS = 10_000;
const BALANCE_READ_MAX_BYTES = 64 * 1024;

test('readBalance is a bounded read; a stall or malformed answer returns its cause and no balance', async t => {
  const world = await sellerWalletWorld(t);
  replyTo(world.node, 'getAddressInfo', row => jsonResponse(ok({ address: row.body.params[0].data.address, balance: '12500000000', nonce: 0 })));
  assert.deepEqual(await world.wallet.readBalance(), { address: world.wallet.address, balanceOs: '12500000000' });

  for (const [label, response] of Object.entries({ 'a number': ok({ balance: 12.5 }), 'a negative amount': ok({ balance: '-1' }), 'a refusal': { result: 400, response: 'TEST-refused', require_reply: false, extra: null } })) {
    replyTo(world.node, 'getAddressInfo', () => jsonResponse(response));
    await assert.rejects(world.wallet.readBalance(), { code: 'seller_balance_invalid' }, label);
  }

  replyTo(world.node, 'getAddressInfo', () => jsonResponse(ok({ balance: '1', padding: 'x'.repeat(BALANCE_READ_MAX_BYTES) })));
  const oversized = await world.wallet.readBalance().then(() => null, error => error);
  assert.equal(oversized?.code, 'seller_balance_unavailable');
  assert.match(String(oversized.cause?.message), /exceeds byte limit/, 'an oversized answer keeps its cause');

  let stalledRequest;
  replyTo(world.node, 'getAddressInfo', row => { stalledRequest = row; return new Promise(() => {}); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reading = world.wallet.readBalance().then(() => null, error => error);
  while (!stalledRequest) await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(BALANCE_READ_TIMEOUT_MS);
  const stalled = await reading;
  t.mock.timers.reset();
  assert.equal(stalled?.code, 'seller_balance_unavailable');
  assert.equal(stalled.details, 'timeout', 'a stall is a timeout');
  assert.equal(stalled.cause?.message, 'resolver-timeout', 'its cause is the deadline');
  assert.ok(stalledRequest.signal?.aborted, 'the stalled request is aborted');
});

test('a session write the node refuses for balance is a definite refusal; its approval is released and nothing more is signed', async t => {
  const signatures = await spyTransactionSignatures(t.mock);
  const world = await settlingWorld(t);
  refuseConfirmation(world);
  const refused = (await artifactWrite(world)).answer;
  assert.equal(refused.success, false);
  assert.notEqual(refused.error?.code, 'outcome_unknown', 'a refusal the node states is not an unknown outcome');
  assert.equal(world.node.broadcasts.length, 0, 'the refused write was never broadcast');
  assert.deepEqual(outcomes(world), ['released'], 'its approval hold is released');
  assert.equal(signatures.length, 1, 'only the refused write was signed');

  world.node.reply = null;
  const retried = (await artifactWrite(world)).answer;
  assert.equal(retried.success, true, `the lane is free for the next write: ${JSON.stringify(retried)}`);
  assert.equal(signatures.length, 2, 'the next write is the only further signature');
  assert.deepEqual(outcomes(world), ['released', 'spent']);
});
